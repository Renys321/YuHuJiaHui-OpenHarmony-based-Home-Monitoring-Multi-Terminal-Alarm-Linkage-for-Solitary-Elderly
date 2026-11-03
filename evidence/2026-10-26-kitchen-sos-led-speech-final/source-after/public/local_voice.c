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
 * Codec setup runs in the caller's task before the worker starts. Afterwards the
 * worker only toggles SPK_EN (amp_prepare) around playback, while node_main reads
 * KEY0 and drives the buzzer on the same I2C0 bus: the legacy IDF i2c_master_*
 * calls execute one command link per call, so concurrent callers cannot interleave
 * bytes; a failed KEY0 read is treated as unknown (never as a press) by node_main.
 *
 * 2026-10-26 LOCAL-ALARM-SPEECH-FINAL
 * ---------------------------------------------------------------------------
 * 1) 语音内容是真人声中文 TTS（Microsoft Huihui，离线合成），不是提示音。
 *    旧 sos.pcm 实测是 1.25 s 正弦波“滴滴”声，这是用户“只能听到滴滴几声”的直接原因。
 * 2) 播放格式改为 IMA ADPCM 4 bit @16 kHz（8 kB/s），因为 factory 应用分区只有 1 MiB，
 *    5 条完整中文句子用 16 kHz/16 bit 放不下（约 176 kB 超出剩余空间）。ADPCM 保留
 *    完整 8 kHz 语音带宽（比降到 8 kHz PCM 清晰得多）。解码器是 tools/make-voice-assets.py
 *    参考实现的逐行移植，主机测试 tools/host_adpcm_test.c 已证明逐采样一致。
 * 3) 去掉了固定的 PCM ÷2 衰减：旧代码把电平再降 6 dB，配合厨房只有 -15 dB 的
 *    ES8388 模拟音量会让语音过轻。ES8388 音量配置本身（厨房 20 / 卫生间 30）未改。
 * 4) 功放使能后先等 CONFIG_NODE_VOICE_AMP_SETTLE_MS 再送 I2S 数据，语音素材本身带
 *    200 ms 前导静音、150 ms 尾部静音，保证功放上电与 DMA 预充不会截掉开头的字。
 */
#define TAG "local-voice"
extern const uint8_t sos_start[] asm("_binary_sos_adpcm_start");
extern const uint8_t sos_end[] asm("_binary_sos_adpcm_end");
extern const uint8_t climate_temp_start[] asm("_binary_climate_temp_adpcm_start");
extern const uint8_t climate_temp_end[] asm("_binary_climate_temp_adpcm_end");
extern const uint8_t climate_rh_start[] asm("_binary_climate_rh_adpcm_start");
extern const uint8_t climate_rh_end[] asm("_binary_climate_rh_adpcm_end");
extern const uint8_t climate_both_start[] asm("_binary_climate_both_adpcm_start");
extern const uint8_t climate_both_end[] asm("_binary_climate_both_adpcm_end");
extern const uint8_t no_motion_start[] asm("_binary_no_motion_adpcm_start");
extern const uint8_t no_motion_end[] asm("_binary_no_motion_adpcm_end");
extern const uint8_t climate_generic_start[] asm("_binary_climate_generic_adpcm_start");
extern const uint8_t climate_generic_end[] asm("_binary_climate_generic_adpcm_end");

typedef struct {
    const uint8_t *data;   /* 4-byte header + IMA ADPCM nibbles, high nibble first */
    const uint8_t *end;
    const char *text;
} voice_clip_t;

/* 索引 = local_voice.h 的 VOICE_CLIP_*；顺序不得改动。 */
static const voice_clip_t s_clips[] = {
    { NULL, NULL, "无" },
    { sos_start, sos_end, "我需要帮助，请尽快过来。" },
    { climate_temp_start, climate_temp_end, "室内温度异常，请前来查看。" },
    { climate_rh_start, climate_rh_end, "室内湿度异常，请前来查看。" },
    { climate_both_start, climate_both_end, "室内温度和湿度异常，请前来查看。" },
    { no_motion_start, no_motion_end, "长时间未检测到活动，请确认家人情况。" },
    { climate_generic_start, climate_generic_end, "室内温湿度异常，请前来查看。" },
};
#define CLIP_COUNT ((int)(sizeof(s_clips) / sizeof(s_clips[0])))

/* ---------------- IMA ADPCM (standard DVI4) decoder ----------------
 * 解码器本体在 adpcm_ima.h（纯逻辑，主机侧 tools/host_adpcm_test.c 逐采样比对）。 */
#include "adpcm_ima.h"


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
        if (xQueueReceive(s_requests, &req, portMAX_DELAY) != pdTRUE) continue;
        if (req.clip <= VOICE_CLIP_NONE || req.clip >= CLIP_COUNT) {
            amp_prepare(0);            /* 取消播放：功放立即回到待机静音 */
            continue;
        }
        if (req.generation != atomic_load(&s_generation)) continue;
        const voice_clip_t *c = &s_clips[req.clip];
        /* 功放只在真正播放时开启：待机常开会把模拟底噪一直送到扬声器。 */
        esp_err_t err = amp_prepare(1);
        if (err != ESP_OK) ESP_LOGW(TAG, "功放使能失败(%s)，本次可能无声", esp_err_to_name(err));
        /* 等功放上电稳定 + 前级静音建立，再送数据，避免截掉语音开头。 */
        if (err == ESP_OK) vTaskDelay(pdMS_TO_TICKS(CONFIG_NODE_VOICE_AMP_SETTLE_MS));
        if (err == ESP_OK) err = i2s_zero_dma_buffer(I2S_NUM_0);
        if (err == ESP_OK) err = i2s_start(I2S_NUM_0);
        ESP_LOGI(TAG, "PLAY clip=%d bytes=%u text=%s", req.clip,
                 (unsigned)(c->end > c->data ? (size_t)(c->end - c->data) : 0), c->text);
        if (err == ESP_OK && c->data && c->end > c->data + 4) {
            adpcm_ima_state_t st;
            int16_t sample = 0;
            int have = 0;
            if (adpcm_ima_begin(&st, c->data, c->end)) have = adpcm_ima_next(&st, &sample);
            while (have && req.generation == atomic_load(&s_generation)) {
                size_t n = 0;
                while (n < 256 && have) {
                    stereo[2 * n] = stereo[2 * n + 1] = sample;
                    n++;
                    have = adpcm_ima_next(&st, &sample);
                }
                size_t total = n * 4, sent = 0;
                while (sent < total && req.generation == atomic_load(&s_generation)) {
                    size_t w = 0;
                    err = i2s_write(I2S_NUM_0, (uint8_t *)stereo + sent, total - sent, &w, pdMS_TO_TICKS(50));
                    if (err != ESP_OK || !w) { if (err == ESP_OK) err = ESP_ERR_TIMEOUT; break; }
                    sent += w;
                }
                if (err != ESP_OK) break;
            }
        }
        /* Allow final DMA samples to drain, but cancellation remains bounded. */
        for (int i = 0; i < 6 && req.generation == atomic_load(&s_generation) && err == ESP_OK; i++)
            vTaskDelay(pdMS_TO_TICKS(16));
        i2s_stop(I2S_NUM_0);
        i2s_zero_dma_buffer(I2S_NUM_0);
        amp_prepare(0);   /* 播放结束即关闭功放：待机无底噪，也不再持续耗电 */
        ESP_LOGI(TAG, "STOP clip=%d result=%s cancelled=%d", req.clip,
                 esp_err_to_name(err), req.generation != atomic_load(&s_generation));
        ESP_LOGI(TAG, "STACK_FREE task=local-voice bytes=%u", (unsigned)uxTaskGetStackHighWaterMark(NULL));
    }
}

static void request(int clip)
{
    if (!s_requests) return;
    voice_request_t req = { .generation = atomic_fetch_add(&s_generation, 1) + 1, .clip = clip };
    xQueueOverwrite(s_requests, &req); /* latest wins, cannot grow a backlog */
}

void local_voice_play(int clip) { request(clip > 0 && clip < CLIP_COUNT ? clip : VOICE_CLIP_NONE); }
void local_voice_cancel(void) { request(VOICE_CLIP_NONE); }

const char *local_voice_text(int clip)
{
    if (clip <= VOICE_CLIP_NONE || clip >= CLIP_COUNT) return "无";
    return s_clips[clip].text;
}

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
    /* 启动即待机静音：功放等到第一次真正播放时才打开（SPK_EN 低有效）。 */
    if (err == ESP_OK) err = amp_prepare(0);
    if (err != ESP_OK) goto fail;
    s_requests = xQueueCreate(1, sizeof(voice_request_t));
    if (!s_requests) goto fail;
    if (xTaskCreate(playback_task, "local-voice", 4096, NULL, 4, NULL) != pdPASS) {
        vQueueDelete(s_requests); s_requests = NULL; goto fail;
    }
    ESP_LOGI(TAG, "READY playback-only 16000Hz IMA-ADPCM; amp standby muted; no boot alarm; clips=%d", CLIP_COUNT - 1);
    return;
fail:
    amp_prepare(0);
    i2s_driver_uninstall(I2S_NUM_0);
    ESP_LOGW(TAG, "voice disabled after init failure; buzzer retained");
}
#else
void local_voice_start(void) {}
void local_voice_play(int clip) { (void)clip; }
void local_voice_cancel(void) {}
const char *local_voice_text(int clip) { (void)clip; return "无"; }
#endif
