#include "sdkconfig.h"
#include "voice_pins.h"
#include "local_voice.h"
#if CONFIG_NODE_VOICE_ENABLED
#include <stdint.h>
#include <string.h>
#include <stdatomic.h>
#include <math.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "driver/i2c.h"
#include "driver/i2s.h"
#include "esp_log.h"

/* 寄存器序列取自本机 ALIENTEK DNESP32S3 30_music 的 ES8388 BSP（广州星翼电子，
 * 2020-2032），只做了最小改动：这里负责播放和板载咪头采集，不存录音文件。
 * ES8388 BSP 写的 0x20 是 8 位地址，IDF 要用 7 位 0x10；XL9555 是另一颗器件，
 * 7 位地址 0x20，SPK_EN = P0_2 低有效。
 * codec 初始化在调用方任务里跑完才起 worker，之后 worker 只在播放前后翻 SPK_EN；
 * node_main 在同一条 I2C0 上读 KEY0、驱动蜂鸣器，legacy i2c_master_* 每次调用只有
 * 一个 command link，两次调用不会把字节插花；KEY0 读失败 node_main 当未知处理。
 *
 * 语音素材是离线合成的中文 TTS（Microsoft Huihui），不是提示音。格式用 IMA ADPCM
 * 4 bit @16 kHz（8 kB/s）：factory 应用分区只有 1 MiB，5 条完整中文句子按 16 kHz/
 * 16 bit 存要 176 kB 左右，放不下；ADPCM 保留了完整 8 kHz 语音带宽，比降到 8 kHz
 * PCM 清晰。解码器是 tools/make-voice-assets.py 参考实现的逐行移植，
 * tools/host_adpcm_test.c 已验证逐采样一致。
 * 播放不做固定的 PCM ÷2 衰减（那会再降 6 dB，配上厨房 -15 dB 的 ES8388 模拟音量，
 * 语音会太轻）；ES8388 音量配置本身（厨房 20 / 卫生间 30）没动。
 * 功放使能后先等 CONFIG_NODE_VOICE_AMP_SETTLE_MS 再送 I2S；素材自带 200 ms 前导
 * 静音和 150 ms 尾部静音，功放上电和 DMA 预充不会截掉开头的字。 */
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
extern const uint8_t prompt_start[] asm("_binary_prompt_adpcm_start");
extern const uint8_t prompt_end[] asm("_binary_prompt_adpcm_end");
extern const uint8_t health_start[] asm("_binary_health_adpcm_start");
extern const uint8_t health_end[] asm("_binary_health_adpcm_end");

typedef struct {
    const uint8_t *data;   /* 4 字节头 + IMA ADPCM nibble，先高 4 位 */
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
    /* 7 = 外部求助（跨房间定向播报）：复用 sos 素材，不新增资源，见 local_voice.h 说明 */
    { sos_start, sos_end, "（随身求助）我需要帮助，请尽快过来。" },
    { prompt_start, prompt_end, "如果您没事，请说没事。" },
    { health_start, health_end, "先坐下休息，已通知家人；胸闷请拨打120。" },
};
#define CLIP_COUNT ((int)(sizeof(s_clips) / sizeof(s_clips[0])))

/* IMA ADPCM（标准 DVI4）解码器本体在 adpcm_ima.h：纯逻辑，主机侧可逐采样比对。 */
#include "adpcm_ima.h"


typedef struct { uint32_t generation; int clip; } voice_request_t;
static QueueHandle_t s_requests;
static _Atomic uint32_t s_generation;
/* 告警语音与 AI 网关流式播报共用 I2S0/功放：用互斥锁串行化，避免两路同时写。 */
static SemaphoreHandle_t s_audio_lock;
static uint32_t s_pcm_generation;
/* 板载咪头采集：I2S0 驱动在 TX/RX 之间切换，s_i2s_ready 记当前有没有装驱动；
 * s_mic_active 标记采集会话防重入；mictest 同时只允许一个后台任务。 */
static bool s_i2s_ready;
static bool s_mic_active;
static int32_t s_hp_x1 = 0, s_hp_y1 = 0;
static _Atomic int s_mic_test_busy;

#define MIC_RATE_HZ       16000
#define MIC_TEST_MAX_SEC  5
#define MIC_READ_CHUNK    320   /* 20 ms @16 kHz */
#define MIC_LOCK_WAIT_MS  2000

/* 向 ES8388 写一个寄存器；addr 用 IDF 要求的 7 位 I2C 地址。 */
static esp_err_t reg_write(uint8_t addr, uint8_t reg, uint8_t val)
{
    uint8_t bytes[] = {reg, val};
    return i2c_master_write_to_device(I2C_NUM_0, addr, bytes, 2, pdMS_TO_TICKS(100));
}

/* 控制 XL9555 P0_2 功放使能，保留 P0 上其它引脚的锁存状态。
 * 功放低有效；先写输出锁存再切输出方向，减少切换瞬态。 */
static esp_err_t amp_prepare(int enable)
{
    const uint8_t mask = 4;
    uint8_t reg = 2, out = 0, cfg = 0;
    esp_err_t err = i2c_master_write_read_device(I2C_NUM_0, 0x20, &reg, 1, &out, 1, pdMS_TO_TICKS(100));
    if (err != ESP_OK) return err;
    /* 先写锁存再切方向，别碰蜂鸣器和其它引脚。 */
    err = reg_write(0x20, 2, enable ? (out & ~mask) : (out | mask));
    if (err != ESP_OK) return err;
    reg = 6;
    err = i2c_master_write_read_device(I2C_NUM_0, 0x20, &reg, 1, &cfg, 1, pdMS_TO_TICKS(100));
    return err == ESP_OK ? reg_write(0x20, 6, cfg & ~mask) : err;
}

/* 关着功放把 ES8388 播放通路初始化好；I2S 驱动在这之后安装。 */
static esp_err_t codec_start(void)
{
    esp_err_t err = amp_prepare(0);
    if (err != ESP_OK) return err;
    if ((err = reg_write(0x10, 0, 0x80)) != ESP_OK) return err;
    if ((err = reg_write(0x10, 0, 0)) != ESP_OK) return err;
    vTaskDelay(pdMS_TO_TICKS(100));
    /* ADC 和 MICBIAS 先关；Philips I2S，16 bit，MCLK/fs=256。 */
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

/* 安装 I2S0（独占）：rx=false 是播放通路，rx=true 是板载咪头采集通路。
 * 两路共用 MCLK/BCLK/WS，S3 始终做 I2S 主机（ES8388 保持 slave，寄存器 0x08=0x00）。
 * 采集时 DIN=GPIO14；播放时不配 data_in。 */
static esp_err_t i2s_begin(bool rx)
{
    const i2s_config_t config = {
        .mode = I2S_MODE_MASTER | (rx ? I2S_MODE_RX : I2S_MODE_TX),
        .sample_rate = MIC_RATE_HZ, .bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT,
        .channel_format = I2S_CHANNEL_FMT_RIGHT_LEFT,
        .communication_format = I2S_COMM_FORMAT_STAND_I2S,
        .dma_buf_count = 4, .dma_buf_len = 256, .use_apll = false,
        .tx_desc_auto_clear = true, .fixed_mclk = 4096000,
        .mclk_multiple = I2S_MCLK_MULTIPLE_256
    };
    esp_err_t err = i2s_driver_install(I2S_NUM_0, &config, 0, NULL);
    if (err != ESP_OK) return err;
    const i2s_pin_config_t pins = { .mck_io_num = 3, .bck_io_num = 46, .ws_io_num = 9,
        .data_out_num = 10, .data_in_num = rx ? 14 : I2S_PIN_NO_CHANGE };
    err = i2s_set_pin(I2S_NUM_0, &pins);
    if (err == ESP_OK) err = i2s_stop(I2S_NUM_0);
    if (err != ESP_OK) i2s_driver_uninstall(I2S_NUM_0);
    return err;
}

/* 板载咪头：打开 ES8388 ADC 和 MIC1 输入（照 ALIENTEK DNESP32S3 录音例程的顺序）。
 * 0x03 先写 0xFF（全关）再写 0x00：ADC、模拟输入、MICBIAS、偏置电流全部上电。
 * 0x02 的 bit3/bit1 会关掉 ADC DLL 和 ADC 参考电压，而播放配置收尾是 0x0A，
 * 所以采集前必须写回 0x00。0x0A=0x00 选 LINPUT1/RINPUT1（板载 MIC1）。
 * 只改 ADC 侧寄存器；DAC 和功放在 mic_end 时由 codec_start 整体恢复。 */
static esp_err_t codec_adc_setup(void)
{
    esp_err_t err = reg_write(0x10, 0x03, 0xFF);
    if (err != ESP_OK) return err;
    vTaskDelay(pdMS_TO_TICKS(20));
    const uint8_t setup[][2] = {
        {0x02, 0x00}, /* ADC DLL/参考电压上电 */
        {0x08, 0x00}, /* ES8388 slave：MCLK/BCLK/WS 由 S3 提供 */
        {0x09, 0x44}, /* MIC PGA 降增益，避免底噪被放大 */
        {0x0A, 0x00}, /* 输入选择 LINPUT1/RINPUT1（板载咪头） */
        {0x0B, 0x02}, /* 差分选择 LINPUT1-RINPUT1，ASDOUT 正常输出 */
        {0x0C, 0x0C}, /* ADC：Philips I2S，16 bit */
        {0x0E, 0x30}, /* ALC 关闭，高通滤波开启 */
        {0x0F, 0x20}, /* ADC 数字输出不静音 */
        {0x10, 0x00}, /* L ADC 数字音量 0 dB */
        {0x11, 0x00}, /* R ADC 数字音量 0 dB */
    };
    for (size_t i = 0; i < sizeof(setup)/sizeof(setup[0]); ++i) {
        if ((err = reg_write(0x10, setup[i][0], setup[i][1])) != ESP_OK) return err;
    }
    vTaskDelay(pdMS_TO_TICKS(20));
    return reg_write(0x10, 0x03, 0x00); /* ADC、MICBIAS 上电 */
}

static void codec_adc_disable(void)
{
    reg_write(0x10, 0x03, 0xFF);
}

/* 采集结束或失败后恢复播放通路：重装 TX 驱动、重跑验证过的 codec_start、DAC 解除
 * 静音、功放保持关闭。失败就明说，不假装恢复成功。 */
static bool restore_playback(void)
{
    esp_err_t err = i2s_begin(false);
    if (err == ESP_OK) err = codec_start();
    if (err == ESP_OK) err = reg_write(0x10, 0x19, 0x00);
    if (err == ESP_OK) err = amp_prepare(0);
    s_i2s_ready = (err == ESP_OK);
    if (err != ESP_OK) {
        amp_prepare(0);
        ESP_LOGE(TAG, "MIC restore failed: %s（播放可能无声，需重启）", esp_err_to_name(err));
    }
    return err == ESP_OK;
}

/* 唯一的音频工作任务：从有界队列取最新请求，分块解码写立体声 I2S。
 * 新请求到达会让 generation 递增，当前播放就在块边界取消或替换。 */
static void playback_task(void *arg)
{
    (void)arg;
    voice_request_t req;
    int16_t stereo[256 * 2]; /* 16 ms 一块；固定内存，每次告警不碰堆 */
    for (;;) {
        if (xQueueReceive(s_requests, &req, portMAX_DELAY) != pdTRUE) continue;
        if (req.clip <= VOICE_CLIP_NONE || req.clip >= CLIP_COUNT) {
            /* 只取消片段，不在这里关功放：PCM begin 会先投递 NONE 取消请求，
             * 若本任务随后关 amp，会把已经开启的 PCM 功放重新关掉，导致 PCM 无声。 */
            continue;
        }
        if (req.generation != atomic_load(&s_generation)) continue;
        if (xSemaphoreTake(s_audio_lock, portMAX_DELAY) != pdTRUE) continue;
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
        /* 等最后一段 DMA 播完，但取消仍有上限 */
        for (int i = 0; i < 6 && req.generation == atomic_load(&s_generation) && err == ESP_OK; i++)
            vTaskDelay(pdMS_TO_TICKS(16));
        i2s_stop(I2S_NUM_0);
        i2s_zero_dma_buffer(I2S_NUM_0);
        amp_prepare(0);   /* 播放结束即关闭功放：待机无底噪，也不再持续耗电 */
        ESP_LOGI(TAG, "STOP clip=%d result=%s cancelled=%d", req.clip,
                 esp_err_to_name(err), req.generation != atomic_load(&s_generation));
        xSemaphoreGive(s_audio_lock);
        ESP_LOGI(TAG, "STACK_FREE task=local-voice bytes=%u", (unsigned)uxTaskGetStackHighWaterMark(NULL));
    }
}

/* 投递最新播放请求：单槽覆盖避免告警积压，generation 用来作废旧请求。 */
static void request(int clip)
{
    if (!s_requests) return;
    voice_request_t req = { .generation = atomic_fetch_add(&s_generation, 1) + 1, .clip = clip };
    xQueueOverwrite(s_requests, &req); /* 最新一条胜出，积压不起来 */
}

/* 非阻塞播放入口；无效片段按取消请求处理。 */
void local_voice_play(int clip) {
    ESP_LOGW(TAG, "PLAY request clip=%d (requests=%p)", clip, (void *)s_requests);
    request(clip > 0 && clip < CLIP_COUNT ? clip : VOICE_CLIP_NONE);
}

/* 通过新一代空请求取消当前及排队中的播放。 */
void local_voice_cancel(void) { request(VOICE_CLIP_NONE); }

/* AI 语音网关流式播报，和告警片段共用 I2S0 和功放：begin 先取消片段并拿锁，
 * end 释放。任何新的告警/取消请求都会让 s_generation 递增，write 在块边界返回 false。 */
bool local_voice_pcm_begin(void)
{
    if (!s_requests || !s_audio_lock) return false;
    request(VOICE_CLIP_NONE);
    if (xSemaphoreTake(s_audio_lock, pdMS_TO_TICKS(1000)) != pdTRUE) return false;
    /* 录音结束后 restore_playback 可能失败，s_i2s_ready 会留在 false，这时直接推
     * PCM 会“写入成功但没声”。这里强制再恢复一次。 */
    if (!s_i2s_ready) {
        if (!restore_playback()) {
            ESP_LOGW(TAG, "PCM begin: playback restore failed");
            xSemaphoreGive(s_audio_lock);
            return false;
        }
    }
    s_pcm_generation = atomic_load(&s_generation);
    esp_err_t err = amp_prepare(1);
    if (err == ESP_OK) vTaskDelay(pdMS_TO_TICKS(CONFIG_NODE_VOICE_AMP_SETTLE_MS));
    if (err == ESP_OK) err = i2s_zero_dma_buffer(I2S_NUM_0);
    if (err == ESP_OK) err = i2s_start(I2S_NUM_0);
    if (err != ESP_OK) {
        amp_prepare(0);
        xSemaphoreGive(s_audio_lock);
        ESP_LOGW(TAG, "PCM begin failed: %s", esp_err_to_name(err));
        return false;
    }
    ESP_LOGI(TAG, "PCM begin 16000Hz mono");
    return true;
}

bool local_voice_pcm_write(const int16_t *mono, size_t samples)
{
    static int16_t stereo[256 * 2];
    if (!s_requests || !s_audio_lock) return false;
    while (samples > 0) {
        if (atomic_load(&s_generation) != s_pcm_generation) return false;
        size_t n = samples > 256 ? 256 : samples;
        for (size_t i = 0; i < n; ++i) stereo[2 * i] = stereo[2 * i + 1] = mono[i];
        size_t total = n * 4, sent = 0;
        while (sent < total) {
            size_t w = 0;
            esp_err_t err = i2s_write(I2S_NUM_0, (uint8_t *)stereo + sent,
                                      total - sent, &w, pdMS_TO_TICKS(50));
            if (err != ESP_OK || !w) return false;
            sent += w;
        }
        static bool pcm_logged = false;
        if (!pcm_logged) { pcm_logged = true; ESP_LOGI(TAG, "PCM write first block n=%u bytes=%u", (unsigned)n, (unsigned)sent); }
        mono += n;
        samples -= n;
    }
    return true;
}

void local_voice_pcm_end(void)
{
    if (!s_requests || !s_audio_lock) return;
    /* 等最后一段 DMA 播完再 stop，否则短 PCM（如本地 1 秒单音）会被直接截掉。 */
    vTaskDelay(pdMS_TO_TICKS(250));
    i2s_stop(I2S_NUM_0);
    i2s_zero_dma_buffer(I2S_NUM_0);
    amp_prepare(0);
    xSemaphoreGive(s_audio_lock);
    ESP_LOGI(TAG, "PCM end");
}

/* ---- 板载咪头采集 ---- */
static int64_t voice_now_ms(void)
{
    return (int64_t)xTaskGetTickCount() * portTICK_PERIOD_MS;
}

bool local_voice_mic_begin(void)
{
    if (!s_requests || !s_audio_lock || !s_i2s_ready) {
        ESP_LOGE(TAG, "MIC begin failed: audio engine not ready");
        return false;
    }
    if (s_mic_active) {
        ESP_LOGW(TAG, "MIC begin rejected: session already active");
        return false;
    }
    /* 先让告警片段在块边界退出，再独占 I2S 和功放。 */
    request(VOICE_CLIP_NONE);
    if (xSemaphoreTake(s_audio_lock, pdMS_TO_TICKS(MIC_LOCK_WAIT_MS)) != pdTRUE) {
        ESP_LOGW(TAG, "MIC begin failed: audio busy");
        return false;
    }
    i2s_stop(I2S_NUM_0);
    i2s_zero_dma_buffer(I2S_NUM_0);
    esp_err_t err = i2s_driver_uninstall(I2S_NUM_0);
    s_i2s_ready = false;
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "MIC begin failed: i2s uninstall %s", esp_err_to_name(err));
        goto fail_lock;
    }
    if ((err = codec_adc_setup()) != ESP_OK) {
        ESP_LOGE(TAG, "MIC begin failed: ES8388 ADC %s", esp_err_to_name(err));
        goto fail_restore;
    }
    if ((err = i2s_begin(true)) != ESP_OK) {
        ESP_LOGE(TAG, "MIC begin failed: i2s rx %s", esp_err_to_name(err));
        goto fail_adc;
    }
    if ((err = i2s_start(I2S_NUM_0)) != ESP_OK) {
        ESP_LOGE(TAG, "MIC begin failed: i2s start %s", esp_err_to_name(err));
        i2s_driver_uninstall(I2S_NUM_0);
        goto fail_adc;
    }
    s_i2s_ready = true;
    s_hp_x1 = 0;
    s_hp_y1 = 0;
    s_mic_active = true;
    ESP_LOGI(TAG, "MIC begin %dHz mono s16 (ES8388 ADC, DIN=GPIO14)", MIC_RATE_HZ);
    return true;

fail_adc:
    codec_adc_disable();
fail_restore:
    restore_playback();
fail_lock:
    xSemaphoreGive(s_audio_lock);
    return false;
}

/* ES8388 ADC 以立体声交织输出，这里下混为 16 kHz 单声道：若只取一路，
 * 网关拿到的是 32 kHz 样本流，时长/语速会翻倍。 */
int local_voice_mic_read(int16_t *buf, size_t samples, uint32_t timeout_ms)
{
    if (!s_mic_active || !buf || samples == 0) return -1;
    static int16_t frame[2 * MIC_READ_CHUNK];
    size_t done = 0;
    while (done < samples) {
        size_t want = samples - done;
        if (want > MIC_READ_CHUNK) want = MIC_READ_CHUNK;
        size_t bytes = 0;
        esp_err_t err = i2s_read(I2S_NUM_0, frame, want * 2 * sizeof(int16_t), &bytes,
                                 pdMS_TO_TICKS(timeout_ms));
        if (err != ESP_OK && err != ESP_ERR_TIMEOUT) {
            ESP_LOGW(TAG, "MIC read failed: %s", esp_err_to_name(err));
            return -1;
        }
        size_t frames = bytes / (2 * sizeof(int16_t));
        for (size_t i = 0; i < frames; ++i) {
            int32_t x = ((int32_t)frame[2 * i] + frame[2 * i + 1]) / 2;
            /* 一阶高通（约 75Hz）去直流/低频轰鸣；不影响语音主频段。 */
            int32_t y = x - s_hp_x1 + (s_hp_y1 * 31800) / 32768;
            s_hp_x1 = x;
            s_hp_y1 = y;
            if (y > 32767) y = 32767;
            if (y < -32768) y = -32768;
            buf[done + i] = (int16_t)y;
        }
        if (frames == 0) break;
        done += frames;
    }
    return (int)done;
}

void local_voice_mic_end(void)
{
    if (!s_mic_active) return;
    s_mic_active = false;
    i2s_stop(I2S_NUM_0);
    i2s_zero_dma_buffer(I2S_NUM_0);
    esp_err_t err = i2s_driver_uninstall(I2S_NUM_0);
    if (err != ESP_OK) ESP_LOGW(TAG, "MIC end: i2s uninstall %s", esp_err_to_name(err));
    s_i2s_ready = false;
    codec_adc_disable();
    bool ok = restore_playback();
    ESP_LOGI(TAG, "MIC end playback_restored=%d", ok ? 1 : 0);
    xSemaphoreGive(s_audio_lock);
}

/* mictest：采集固定秒数，输出 RMS/峰值供现场区分“安静/有人说话”。 */
static void mic_test_task(void *arg)
{
    const int seconds = (int)(intptr_t)arg;
    static int16_t buf[MIC_READ_CHUNK];
    int64_t sumsq = 0;
    uint32_t n = 0;
    int32_t vmin = 0, vmax = 0;
    int first = 1;
    bool read_ok = true;
    const int64_t deadline = voice_now_ms() + (int64_t)seconds * 1000;

    if (!local_voice_mic_begin()) {
        ESP_LOGE(TAG, "MIC_TEST FAIL reason=mic_begin_unavailable");
        goto done;
    }
    while (voice_now_ms() < deadline) {
        int got = local_voice_mic_read(buf, MIC_READ_CHUNK, 200);
        if (got < 0) { read_ok = false; break; }
        for (int i = 0; i < got; ++i) {
            int32_t v = buf[i];
            sumsq += (int64_t)v * v;
            if (first || v < vmin) vmin = v;
            if (first || v > vmax) vmax = v;
            first = 0;
        }
        n += (uint32_t)got;
    }
    local_voice_mic_end();
    if (n == 0) {
        ESP_LOGE(TAG, "MIC_TEST FAIL reason=no_samples%s", read_ok ? "" : " (i2s read error)");
    } else {
        uint32_t rms = (uint32_t)(sqrt((double)sumsq / (double)n) + 0.5);
        uint32_t peak = (uint32_t)(vmax > -vmin ? vmax : -vmin);
        ESP_LOGI(TAG, "MIC_TEST rms=%u peak=%u samples=%u seconds=%d min=%d max=%d%s",
                 (unsigned)rms, (unsigned)peak, (unsigned)n, seconds, (int)vmin, (int)vmax,
                 read_ok ? "" : " read_error=1");
    }
done:
    atomic_store(&s_mic_test_busy, 0);
    vTaskDelete(NULL);
}

void local_voice_mic_test(int seconds)
{
    if (!s_requests) {
        ESP_LOGE(TAG, "MIC_TEST FAIL reason=voice_disabled");
        return;
    }
    if (seconds < 1) seconds = 1;
    if (seconds > MIC_TEST_MAX_SEC) seconds = MIC_TEST_MAX_SEC;
    if (atomic_exchange(&s_mic_test_busy, 1) != 0) {
        ESP_LOGW(TAG, "MIC_TEST ignored: previous test still running");
        return;
    }
    if (xTaskCreate(mic_test_task, "mic-test", 4096, (void *)(intptr_t)seconds, 3, NULL) != pdPASS) {
        atomic_store(&s_mic_test_busy, 0);
        ESP_LOGE(TAG, "MIC_TEST FAIL reason=task_create");
    }
}

/* 返回片段对应的日志文案；不访问音频数据，也不触发播放。 */
const char *local_voice_text(int clip)
{
    if (clip <= VOICE_CLIP_NONE || clip >= CLIP_COUNT) return "无";
    return s_clips[clip].text;
}

/* 初始化顺序：编解码器 -> I2S TX -> 静音待机 -> 单槽队列与播放任务。
 * 任一硬件初始化步骤失败都会关闭功放并保留其它告警方式继续运行。 */
void local_voice_start(void)
{
    if (s_requests) return;
    esp_err_t err = codec_start();
    if (err != ESP_OK) { ESP_LOGW(TAG, "codec unavailable; buzzer retained (%s)", esp_err_to_name(err)); return; }
    err = i2s_begin(false);
    if (err != ESP_OK) { ESP_LOGW(TAG, "I2S unavailable; buzzer retained (%s)", esp_err_to_name(err)); return; }
    s_i2s_ready = true;
    if ((err = reg_write(0x10, 0x19, 0x00)) != ESP_OK) goto fail; /* DAC unmute */
    /* 启动即待机静音：功放等到第一次真正播放时才打开（SPK_EN 低有效）。 */
    if ((err = amp_prepare(0)) != ESP_OK) goto fail;
    s_requests = xQueueCreate(1, sizeof(voice_request_t));
    if (!s_requests) goto fail;
    s_audio_lock = xSemaphoreCreateMutex();
    if (!s_audio_lock) { vQueueDelete(s_requests); s_requests = NULL; goto fail; }
    if (xTaskCreate(playback_task, "local-voice", 4096, NULL, 4, NULL) != pdPASS) {
        vQueueDelete(s_requests); s_requests = NULL; goto fail;
    }
    ESP_LOGI(TAG, "READY playback+mic 16000Hz IMA-ADPCM; amp standby muted; no boot alarm; clips=%d", CLIP_COUNT - 1);
    return;
fail:
    amp_prepare(0);
    i2s_driver_uninstall(I2S_NUM_0);
    s_i2s_ready = false;
    ESP_LOGW(TAG, "voice disabled after init failure; buzzer retained");
}
#else
/* 未启用本地语音时提供同一组空实现，调用方无需再增加条件编译分支。 */
void local_voice_start(void) {}
void local_voice_play(int clip) { (void)clip; }
void local_voice_cancel(void) {}
const char *local_voice_text(int clip) { (void)clip; return "无"; }
bool local_voice_pcm_begin(void) { return false; }
bool local_voice_pcm_write(const int16_t *mono, size_t samples) { (void)mono; (void)samples; return false; }
void local_voice_pcm_end(void) {}
bool local_voice_mic_begin(void) { return false; }
int local_voice_mic_read(int16_t *buf, size_t samples, uint32_t timeout_ms)
{
    (void)buf; (void)samples; (void)timeout_ms; return -1;
}
void local_voice_mic_end(void) {}
void local_voice_mic_test(int seconds) { (void)seconds; }
#endif
