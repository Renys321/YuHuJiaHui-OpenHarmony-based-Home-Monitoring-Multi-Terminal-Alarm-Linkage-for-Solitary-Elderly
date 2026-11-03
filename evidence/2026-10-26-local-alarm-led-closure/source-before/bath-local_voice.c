#include "sdkconfig.h"
#include "voice_pins.h"
#include "local_voice.h"
#if CONFIG_NODE_VOICE_ENABLED
#include <stdint.h>
#include <string.h>
#include <stdatomic.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"
#include "driver/i2c.h"
#include "driver/i2s.h"
#include "esp_log.h"

/* Register setup follows the local ALIENTEK DNESP32S3 30_music ES8388 BSP
 * (2023-12-01, copyright 2020-2032 Guangzhou Xingyi Electronic Technology).
 * This is a minimal playback-only adaptation, not a microphone recorder.
 * ES8388 BSP's 0x20 is an 8-bit address: IDF uses 7-bit 0x10.
 * XL9555 is a different device, 7-bit 0x20, SPK_EN=P0_2 active low.
 * All I2C accesses here finish before the worker starts. Only node_main
 * subsequently writes XL9555 (buzzer), avoiding concurrent read/modify/write.
 */
#define TAG "local-voice"
extern const uint8_t sos_start[] asm("_binary_sos_pcm_start");
extern const uint8_t sos_end[] asm("_binary_sos_pcm_end");
extern const uint8_t warning_start[] asm("_binary_warning_pcm_start");
extern const uint8_t warning_end[] asm("_binary_warning_pcm_end");
#if CONFIG_NODE_VOICE_BOOT_TEST
extern const uint8_t test_start[] asm("_binary_test_pcm_start");
extern const uint8_t test_end[] asm("_binary_test_pcm_end");
#endif
typedef struct { uint32_t generation; int clip; } voice_request_t;
static QueueHandle_t s_requests;
static _Atomic uint32_t s_generation;

static esp_err_t reg_write(uint8_t addr, uint8_t reg, uint8_t val)
{
    uint8_t bytes[] = {reg, val};
    return i2c_master_write_to_device(I2C_NUM_0, addr, bytes, 2, pdMS_TO_TICKS(100));
}

static esp_err_t amp_prepare(int enable)
{
    const uint8_t mask = 4;
    uint8_t reg = 2, out = 0, cfg = 0;
    esp_err_t err = i2c_master_write_read_device(I2C_NUM_0, 0x20, &reg, 1, &out, 1, pdMS_TO_TICKS(100));
    if (err != ESP_OK) return err;
    /* Set output latch before switching direction; preserve buzzer/other pins. */
    err = reg_write(0x20, 2, enable ? (out & ~mask) : (out | mask));
    if (err != ESP_OK) return err;
    reg = 6;
    err = i2c_master_write_read_device(I2C_NUM_0, 0x20, &reg, 1, &cfg, 1, pdMS_TO_TICKS(100));
    return err == ESP_OK ? reg_write(0x20, 6, cfg & ~mask) : err;
}

static esp_err_t codec_start(void)
{
    esp_err_t err = amp_prepare(0);
    if (err != ESP_OK) return err;
    if ((err = reg_write(0x10, 0, 0x80)) != ESP_OK) return err;
    if ((err = reg_write(0x10, 0, 0)) != ESP_OK) return err;
    vTaskDelay(pdMS_TO_TICKS(100));
    /* ADC and mic bias powered off; Philips I2S, 16-bit, MCLK/fs=256. */
    const uint8_t setup[][2] = {
        {0x01,0x58},{0x01,0x50},{0x02,0xf3},{0x02,0xf0},
        {0x03,0xff},{0x00,0x06},{0x04,0x00},{0x08,0x00},
        {0x2b,0x80},{0x17,0x18},{0x18,0x02},{0x19,0x04},
        {0x1a,0x00},{0x1b,0x00},{0x27,0xb8},{0x2a,0xb8},
        {0x2e,0x00},{0x2f,0x00},{0x30,CONFIG_NODE_VOICE_VOLUME},
        {0x31,CONFIG_NODE_VOICE_VOLUME},{0x02,0x0a},{0x04,0x3c}
    };
    for (size_t i = 0; i < sizeof(setup)/sizeof(setup[0]); ++i) {
        if ((err = reg_write(0x10, setup[i][0], setup[i][1])) != ESP_OK) return err;
    }
    return ESP_OK;
}

static void playback_task(void *arg)
{
    (void)arg;
    voice_request_t req;
    int16_t stereo[256 * 2]; /* 16 ms blocks; fixed memory, no heap per alert. */
    for (;;) {
        if (xQueueReceive(s_requests, &req, portMAX_DELAY) != pdTRUE || !req.clip) continue;
        if (req.generation != atomic_load(&s_generation)) continue;
        const uint8_t *pcm = req.clip == 1 ? sos_start : warning_start;
        const uint8_t *end = req.clip == 1 ? sos_end : warning_end;
#if CONFIG_NODE_VOICE_BOOT_TEST
        if (req.clip == 3) { pcm = test_start; end = test_end; }
#endif
        esp_err_t err = i2s_zero_dma_buffer(I2S_NUM_0);
        if (err == ESP_OK) err = i2s_start(I2S_NUM_0);
        ESP_LOGI(TAG, "PLAY clip=%d", req.clip);
        while (err == ESP_OK && pcm + 1 < end && req.generation == atomic_load(&s_generation)) {
            size_t samples = (size_t)(end - pcm) / 2;
            if (samples > 256) samples = 256;
            /* 2026-10-26 bathroom commissioning (private work copy, patch submitted):
             * the fixed /2 attenuation was removed so the PCM plays at its source
             * level. Rationale: measured source peak is -0.79 dBFS (already close to
             * full scale), while /2 cost 6 dB and ES8388 speaker-path register
             * 0x30/0x31=20 is only -15 dB (0x1E=30 is 0 dB, 0x21=33 is +4.5 dB max).
             * Speaker level is now set only by the ES8388 LOUT2/ROUT2 volume, which
             * stays at/below 0 dB in the shipped candidate; no amp gain is added. */
            for (size_t i = 0; i < samples; i++) {
                int16_t value = (int16_t)((uint16_t)pcm[2*i] | ((uint16_t)pcm[2*i+1] << 8));
                stereo[2*i] = stereo[2*i+1] = value;
            }
            size_t total = samples * 4, sent = 0;
            while (sent < total && req.generation == atomic_load(&s_generation)) {
                size_t n = 0;
                err = i2s_write(I2S_NUM_0, (uint8_t *)stereo + sent, total - sent, &n, pdMS_TO_TICKS(50));
                if (err != ESP_OK || !n) { if (err == ESP_OK) err = ESP_ERR_TIMEOUT; break; }
                sent += n;
            }
            pcm += samples * 2;
        }
        /* Allow final DMA samples to drain, but cancellation remains bounded. */
        for (int i = 0; i < 6 && req.generation == atomic_load(&s_generation) && err == ESP_OK; i++)
            vTaskDelay(pdMS_TO_TICKS(16));
        i2s_stop(I2S_NUM_0);
        i2s_zero_dma_buffer(I2S_NUM_0);
        ESP_LOGI(TAG, "STOP result=%s cancelled=%d", esp_err_to_name(err), req.generation != atomic_load(&s_generation));
        ESP_LOGI(TAG, "STACK_FREE task=local-voice bytes=%u", (unsigned)uxTaskGetStackHighWaterMark(NULL));
    }
}

static void request(int clip)
{
    if (!s_requests) return;
    voice_request_t req = { .generation = atomic_fetch_add(&s_generation, 1) + 1, .clip = clip };
    xQueueOverwrite(s_requests, &req); /* latest wins, cannot grow a backlog */
}

void local_voice_alarm(const char *type) { request(type && strcmp(type, "MANUAL_SOS") == 0 ? 1 : 2); }
void local_voice_cancel(void) { request(0); }

void local_voice_start(void)
{
    if (s_requests) return;
    esp_err_t err = codec_start();
    if (err != ESP_OK) { ESP_LOGW(TAG, "codec unavailable; buzzer retained (%s)", esp_err_to_name(err)); return; }
    const i2s_config_t config = {
        .mode = I2S_MODE_MASTER | I2S_MODE_TX,
        .sample_rate = 16000, .bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT,
        .channel_format = I2S_CHANNEL_FMT_RIGHT_LEFT,
        .communication_format = I2S_COMM_FORMAT_STAND_I2S,
        .dma_buf_count = 4, .dma_buf_len = 256, .use_apll = false,
        .tx_desc_auto_clear = true, .fixed_mclk = 4096000,
        .mclk_multiple = I2S_MCLK_MULTIPLE_256
    };
    err = i2s_driver_install(I2S_NUM_0, &config, 0, NULL);
    if (err != ESP_OK) { ESP_LOGW(TAG, "I2S unavailable; buzzer retained (%s)", esp_err_to_name(err)); return; }
    const i2s_pin_config_t pins = { .mck_io_num = 3, .bck_io_num = 46, .ws_io_num = 9,
        .data_out_num = 10, .data_in_num = I2S_PIN_NO_CHANGE };
    err = i2s_set_pin(I2S_NUM_0, &pins);
    if (err == ESP_OK) err = i2s_stop(I2S_NUM_0);
    if (err == ESP_OK) err = reg_write(0x10, 0x19, 0x00); /* DAC unmute */
    if (err == ESP_OK) err = amp_prepare(1);
    if (err != ESP_OK) goto fail;
    s_requests = xQueueCreate(1, sizeof(voice_request_t));
    if (!s_requests) goto fail;
    if (xTaskCreate(playback_task, "local-voice", 4096, NULL, 4, NULL) != pdPASS) {
        vQueueDelete(s_requests); s_requests = NULL; goto fail;
    }
    ESP_LOGI(TAG, "READY playback-only 16000Hz; no boot alarm");
#if CONFIG_NODE_VOICE_BOOT_TEST
    request(3); /* diagnostic speech only: no alarm state/report change */
#endif
    return;
fail:
    amp_prepare(0);
    i2s_driver_uninstall(I2S_NUM_0);
    ESP_LOGW(TAG, "voice disabled after init failure; buzzer retained");
}
#else
void local_voice_start(void) {}
void local_voice_alarm(const char *type) { (void)type; }
void local_voice_cancel(void) {}
#endif
