/* local_led.c —— 板载单色 LED 告警灯效（非阻塞）
 *
 * 硬件：ALIENTEK DNESP32S3 板载用户 LED，官方 BSP led.h: LED_GPIO_PIN = GPIO_NUM_1；
 *       官方 IO 分配表记 IO1 = LED1。当前项目 IO1 无其它用途（MQ-2 已改 IO6/ADC1_CH5，
 *       MQ-5 已改 IO7/ADC1_CH6；音频 3/9/10/46；AHT20 4/5；PIR 36；SOS 15）。
 *       有效电平由 CONFIG_NODE_LED_ACTIVE_LOW 决定，原理图/实测证据见交付报告。
 *
 * 灯效（与现有告警状态机共用，不另造状态机）：
 *   NORMAL/WARN      ：灭（正常状态不显示告警灯效）
 *   ALARM 普通告警    ：1.25 Hz 快闪（400ms 亮 / 400ms 灭）
 *   ALARM MANUAL_SOS ：三短闪（3 x 120ms）+ 长灭（约 1.2s），节奏明显区别于普通告警
 *   ACKED（已确认）   ：先 0.8s 常亮表示“ACK 已收到”；
 *                        若异常仍在 → 每 3s 一次 120ms 慢脉冲；
 *                        若异常已解除 → 常亮后熄灭（区分“已确认”和“已解除”）
 *   stop 仅静音，不清 ALARM：灯保持该告警的闪烁（声音停 ≠ 异常解除）
 *
 * 非阻塞：只在主循环 100ms tick 中读 esp_timer 并写 GPIO；无延时、无新任务，
 * 不影响采集/无线/音频/命令处理。重启后状态 NORMAL → 灯灭，不重放历史告警。
 */
#include "sdkconfig.h"
#include "local_led.h"
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include "esp_timer.h"

#if CONFIG_NODE_LED_GPIO >= 0
#include "driver/gpio.h"
#include "esp_log.h"

#define TAG "local-led"
#define LED_GPIO CONFIG_NODE_LED_GPIO

#define LED_MODE_OFF      0
#define LED_MODE_ALARM    1
#define LED_MODE_SOS      2
#define LED_MODE_ACKED    3
#define LED_MODE_ACKED_RESOLVED 4
#define LED_MODE_IDENTIFY 5

/* 节拍（微秒） */
#define ALARM_PERIOD_US   800000LL
#define ALARM_ON_US       400000LL
#define SOS_PERIOD_US    1600000LL
#define SOS_PULSE_ON_US   120000LL
#define SOS_PULSE_GAP_US  120000LL
#define ACK_CONFIRM_US    800000LL   /* 收到 ACK 后先常亮 0.8s，确认“已收到” */
#define ACKED_PERIOD_US  3000000LL
#define ACKED_ON_US       120000LL
#define IDENTIFY_PERIOD_US 2000000LL
#define IDENTIFY_ON_US      250000LL   /* 12.5% 占空比：用于区分有效电平（大部分灭/短亮） */

static int s_inited;
static int s_level = -1;
#if CONFIG_NODE_LED_ACTIVE_LOW
static int s_polarity_low = 1;
#else
static int s_polarity_low = 0;
#endif
static int s_mode = LED_MODE_OFF;
static int64_t s_epoch_us;
static char s_type[24] = "";

#if CONFIG_NODE_ALARM_BENCH_INJECT
static int s_bench_override;          /* 0=auto；1=强制亮；2=强制灭 */
static int64_t s_identify_until_us;
#endif

static int64_t now_us(void) { return esp_timer_get_time(); }

static void led_write(int on)
{
    int level = on ? (s_polarity_low ? 0 : 1) : (s_polarity_low ? 1 : 0);
    if (level != s_level) {
        gpio_set_level(LED_GPIO, level);
        s_level = level;
    }
}

static const char *mode_name(int mode)
{
    switch (mode) {
    case LED_MODE_ALARM: return "ALARM_BLINK";
    case LED_MODE_SOS: return "SOS_TRIPLE";
    case LED_MODE_ACKED: return "ACKED_CONFIRM_PULSE";
    case LED_MODE_ACKED_RESOLVED: return "ACKED_RESOLVED_OFF";
    case LED_MODE_IDENTIFY: return "IDENTIFY_12.5PCT";
    default: return "OFF";
    }
}

static void set_mode(int mode, const char *type)
{
    if (mode == s_mode && type && strncmp(type, s_type, sizeof(s_type)) == 0) return;
    s_mode = mode;
    snprintf(s_type, sizeof(s_type), "%s", type ? type : "");
    s_epoch_us = now_us();
    ESP_LOGI(TAG, "LED 模式=%s type=%s（%s有效；告警期间不被普通联网提示覆盖）",
             mode_name(mode), s_type[0] ? s_type : "-", s_polarity_low ? "低电平" : "高电平");
}

void local_led_start(void)
{
    gpio_config_t io = { 0 };
    io.intr_type = GPIO_INTR_DISABLE;
    io.mode = GPIO_MODE_OUTPUT;
    io.pin_bit_mask = 1ULL << LED_GPIO;
    io.pull_up_en = GPIO_PULLUP_DISABLE;
    io.pull_down_en = GPIO_PULLDOWN_DISABLE;
    esp_err_t err = gpio_config(&io);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "LED 不可用（GPIO%d）：%s；告警声音/蜂鸣不受影响",
                 (int)LED_GPIO, esp_err_to_name(err));
        return;
    }
    s_inited = 1;
    s_level = -1;
    led_write(0);   /* 上电默认灭：重启不重放历史告警，也不做启动闪烁 */
    s_mode = LED_MODE_OFF;
    s_type[0] = '\0';
    s_epoch_us = now_us();
    ESP_LOGI(TAG, "板载 LED 就绪：GPIO%d 单色，%s有效，启动默认灭（no boot flash）",
             (int)LED_GPIO, s_polarity_low ? "低电平" : "高电平");
}

#if CONFIG_NODE_ALARM_BENCH_INJECT
void local_led_bench_raw(int on)
{
    if (!s_inited) return;
    s_bench_override = on ? 1 : 2;
    s_identify_until_us = 0;
    led_write(on ? 1 : 0);
    ESP_LOGW(TAG, "BENCH LED 原始电平=%d（GPIO 输出 %s）", on, on ? "ON" : "OFF");
}

void local_led_bench_auto(void)
{
    s_bench_override = 0;
    s_identify_until_us = 0;
    s_epoch_us = now_us();
    ESP_LOGW(TAG, "BENCH LED 恢复到状态驱动");
}

void local_led_bench_polarity(int active_low)
{
    s_polarity_low = active_low ? 1 : 0;
    s_level = -1;                 /* 强制按新极性重写 */
    if (s_bench_override == 1) led_write(1);
    else if (s_bench_override == 2) led_write(0);
    ESP_LOGW(TAG, "BENCH LED 极性=%s有效（已按新极性重写当前电平）",
             active_low ? "低电平" : "高电平");
}

void local_led_bench_identify(int duration_ms)
{
    if (!s_inited) return;
    if (duration_ms <= 0) duration_ms = 6000;
    s_bench_override = 0;
    s_mode = LED_MODE_IDENTIFY;
    s_epoch_us = now_us();
    s_identify_until_us = s_epoch_us + (int64_t)duration_ms * 1000;
    ESP_LOGW(TAG, "BENCH LED 识别演示 %dms：12.5%% 占空比（大部分灭、每 2s 短亮 250ms）；"
                  "若观察结果相反说明有效电平需切换", duration_ms);
}
#endif /* CONFIG_NODE_ALARM_BENCH_INJECT */

/* 返回 1=亮；period_us 为当前模式周期，便于调用方无状态计算 */
static int pattern_level(int mode, int64_t phase_us, int64_t *period_us)
{
    switch (mode) {
    case LED_MODE_ALARM:
        *period_us = ALARM_PERIOD_US;
        return (phase_us < ALARM_ON_US) ? 1 : 0;
    case LED_MODE_SOS: {
        *period_us = SOS_PERIOD_US;
        int64_t win = SOS_PULSE_ON_US + SOS_PULSE_GAP_US;      /* 240ms */
        int idx = (int)(phase_us / win);                       /* 0..2 为三短闪窗口 */
        int64_t in_win = phase_us - (int64_t)idx * win;
        return (idx < 3 && in_win < SOS_PULSE_ON_US) ? 1 : 0;
    }
    case LED_MODE_ACKED:
        /* 先 0.8s 常亮（ACK 已收到），之后每 3s 一次 120ms 慢脉冲：
         * 表示“监护人已确认，但该异常仍在持续”。 */
        if (phase_us < ACK_CONFIRM_US) {
            *period_us = 0;
            return 1;
        }
        *period_us = ACKED_PERIOD_US;
        return ((phase_us - ACK_CONFIRM_US) % ACKED_PERIOD_US) < ACKED_ON_US;
    case LED_MODE_ACKED_RESOLVED:
        /* 先 0.8s 常亮（ACK 已收到），随后熄灭：表示“已确认且异常已解除”。 */
        *period_us = 0;
        return (phase_us < ACK_CONFIRM_US) ? 1 : 0;
    case LED_MODE_IDENTIFY:
        *period_us = IDENTIFY_PERIOD_US;
        return (phase_us < IDENTIFY_ON_US) ? 1 : 0;
    default:
        *period_us = 0;
        return 0;
    }
}

void local_led_tick(int state, const char *alarm_type, int danger_present)
{
    if (!s_inited) return;
    int64_t t = now_us();

#if CONFIG_NODE_ALARM_BENCH_INJECT
    if (s_bench_override == 1) { led_write(1); return; }
    if (s_bench_override == 2) { led_write(0); return; }
    if (s_identify_until_us > 0) {
        if (t >= s_identify_until_us) {
            s_identify_until_us = 0;
            s_mode = LED_MODE_OFF;      /* 下一段按真实状态刷新 */
            s_epoch_us = t;
            ESP_LOGW(TAG, "BENCH LED 识别演示结束，恢复状态驱动");
        } else {
            int64_t period = 0;
            int on = pattern_level(LED_MODE_IDENTIFY, t - s_epoch_us, &period);
            led_write(on);
            return;
        }
    }
#endif

    int mode = LED_MODE_OFF;
    if (state == 2) {
        mode = (alarm_type && strcmp(alarm_type, "MANUAL_SOS") == 0) ? LED_MODE_SOS : LED_MODE_ALARM;
    } else if (state == 3) {
        /* 现有状态机 ACKED 会保持到 reset；这里用“当前是否仍有危险”区分
         * “已确认但异常持续”与“已确认且异常解除”，不改动原状态机。 */
        mode = danger_present ? LED_MODE_ACKED : LED_MODE_ACKED_RESOLVED;
    }
    set_mode(mode, (state == 2 || state == 3) ? alarm_type : "");

    int64_t period = 0;
    int on = pattern_level(mode, t - s_epoch_us, &period);
    led_write(on);
}

#else  /* CONFIG_NODE_LED_GPIO < 0：本板/本构建没有可编程告警灯 */

void local_led_start(void) {}
void local_led_tick(int state, const char *alarm_type, int danger_present)
{
    (void)state; (void)alarm_type; (void)danger_present;
}

#if CONFIG_NODE_ALARM_BENCH_INJECT
void local_led_bench_raw(int on) { (void)on; }
void local_led_bench_auto(void) {}
void local_led_bench_polarity(int active_low) { (void)active_low; }
void local_led_bench_identify(int duration_ms) { (void)duration_ms; }
#endif

#endif /* CONFIG_NODE_LED_GPIO >= 0 */
