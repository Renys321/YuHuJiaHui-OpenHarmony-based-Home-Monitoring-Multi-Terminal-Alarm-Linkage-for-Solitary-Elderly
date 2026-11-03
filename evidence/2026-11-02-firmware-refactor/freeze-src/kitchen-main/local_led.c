/* local_led.c —— 板载单色 LED 告警灯效（非阻塞）
 *
 * 硬件：ALIENTEK DNESP32S3 板载用户 LED，BSP led.h 里 LED_GPIO_PIN = GPIO_NUM_1，
 * 官方 IO 分配表记 IO1 = LED1。本项目 IO1 没派别的用途（MQ-2 用 IO6/ADC1_CH5，
 * MQ-5 用 IO7/ADC1_CH6；音频 3/9/10/46；AHT20 4/5；PIR 36；SOS 15）。
 * 有效电平由 CONFIG_NODE_LED_ACTIVE_LOW 决定，上板后按实际观察确认。
 *
 * 灯效跟着现有告警状态机走，不另造状态机：
 *   NORMAL/WARN      灭
 *   ALARM 普通告警    1.25 Hz 快闪（400ms 亮 / 400ms 灭）
 *   ALARM MANUAL_SOS  三短闪（3 x 120ms）+ 长灭约 1.2s，节奏和普通告警明显不同
 *   ACKED 异常仍在    先 0.8s 常亮表示“ACK 已收到”，之后每 3s 一次 120ms 慢脉冲
 *   ACKED 异常已解除  常亮 0.8s 后熄灭，和“仍在”区分开
 *   stop 只静音、不清 ALARM，灯继续按该告警闪（声音停 ≠ 异常解除）
 *
 * 非阻塞：只在主循环 100ms tick 里读 esp_timer、写 GPIO，无延时、无新任务，不影响
 * 采集/无线/音频/命令处理。重启后状态是 NORMAL，灯灭，不重放历史告警。 */
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

/* 运行状态：
 *   s_inited       ：GPIO 配置成功才置 1；失败时所有 tick 直接返回。
 *   s_level        ：上次写出的物理电平（-1=还没写过），用来避免重复写 GPIO。
 *   s_polarity_low ：有效电平极性，编译期由 Kconfig 决定，台架命令可临时改。
 *   s_mode/s_type  ：当前灯效模式和告警类型，用来判断“模式是否真的变了”。
 *   s_epoch_us     ：当前模式开始的时刻，所有闪烁相位都相对它计算。 */
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
/* 台架专用：s_bench_override 0=跟随状态机，1=强制亮，2=强制灭；
 * s_identify_until_us 是“识别演示”的结束时刻，0 表示没有演示。 */
static int s_bench_override;          /* 0=auto；1=强制亮；2=强制灭 */
static int64_t s_identify_until_us;
#endif

static int64_t now_us(void) { return esp_timer_get_time(); }

/* 按“逻辑亮/灭”写 LED，内部处理有效电平。
 * 只有物理电平变化时才真正写 GPIO：主循环每 100ms 调一次，
 * 大部分时间电平没变，省掉无意义的寄存器访问。 */
static void led_write(int on)
{
    int level = on ? (s_polarity_low ? 0 : 1) : (s_polarity_low ? 1 : 0);
    if (level != s_level) {
        gpio_set_level(LED_GPIO, level);
        s_level = level;
    }
}

/* 模式转日志短名，只用于串口可读性，不参与任何判定。 */
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

/* 切换灯效模式。只有模式或告警类型真的变化才重置相位并打日志，
 * 否则每 100ms 都重置相位，闪烁会永远停在第一帧。
 * 类型用 strncmp 比固定长度，避免两边长度不同导致误判“没变化”。 */
static void set_mode(int mode, const char *type)
{
    if (mode == s_mode && type && strncmp(type, s_type, sizeof(s_type)) == 0) return;
    s_mode = mode;
    snprintf(s_type, sizeof(s_type), "%s", type ? type : "");
    s_epoch_us = now_us();
    ESP_LOGI(TAG, "LED 模式=%s type=%s（%s有效；告警期间不被普通联网提示覆盖）",
             mode_name(mode), s_type[0] ? s_type : "-", s_polarity_low ? "低电平" : "高电平");
}

/* 配置 LED 为普通输出并立即熄灭。
 * 告警灯不是安全关键路径：配置失败只告警，声音/蜂鸣/上报照常。
 * 上电不做任何闪烁（no boot flash），避免被误认为“有历史告警”。 */
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
/* 台架命令 led raw on|off：绕过状态机直接写灯，用于确认接线和有效电平。 */
void local_led_bench_raw(int on)
{
    if (!s_inited) return;
    s_bench_override = on ? 1 : 2;
    s_identify_until_us = 0;
    led_write(on ? 1 : 0);
    ESP_LOGW(TAG, "BENCH LED 原始电平=%d（GPIO 输出 %s）", on, on ? "ON" : "OFF");
}

/* 台架命令 led auto：取消强制电平/识别演示，交还给真实告警状态驱动。 */
void local_led_bench_auto(void)
{
    s_bench_override = 0;
    s_identify_until_us = 0;
    s_epoch_us = now_us();
    ESP_LOGW(TAG, "BENCH LED 恢复到状态驱动");
}

/* 台架命令 led polarity low|high：现场确认板载 LED 到底是低电平亮还是高电平亮。
 * 改完极性后 s_level 置 -1，强制按新极性重写一次当前电平。 */
void local_led_bench_polarity(int active_low)
{
    s_polarity_low = active_low ? 1 : 0;
    s_level = -1;                 /* 强制按新极性重写 */
    if (s_bench_override == 1) led_write(1);
    else if (s_bench_override == 2) led_write(0);
    ESP_LOGW(TAG, "BENCH LED 极性=%s有效（已按新极性重写当前电平）",
             active_low ? "低电平" : "高电平");
}

/* 台架命令 led identify：用 12.5% 占空比闪一段时间。
 * 大部分时间灭、每 2 秒短亮 250ms，肉眼容易看出“亮的是短脉冲还是长脉冲”，
 * 从而判断有效电平和代码逻辑是否一致。 */
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

/* 返回 1=亮；period_us 带出当前模式周期，调用方无需记状态。
 * phase_us 是“相对当前模式开始的微秒数”，所有模式都用取模/区间判断，
 * 因此不依赖固定 100ms 节拍，主循环偶尔忙也不会累积漂移。
 * period_us=0 表示该模式没有周期（常亮/常灭），仅供日志使用。 */
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
         * 表示监护人已确认，但异常还在持续。 */
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

/* 主循环每 100ms 调用：把告警状态翻译成灯效并写 GPIO。
 * 参数：
 *   state         ：告警状态机状态（0 NORMAL / 1 WARN / 2 ALARM / 3 ACKED）；
 *   alarm_type    ：告警类型（MANUAL_SOS 用三短闪，其它用快闪）；
 *   danger_present：ACKED 期间异常是否仍然存在，区分“确认但仍在”/“确认且解除”。
 * 函数本身不做任何延时，只是根据时间算当前应是亮还是灭。 */
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
        /* 现有状态机里 ACKED 会一直保持到 reset；这里用“当前是否还有危险”分开
         * “已确认但异常持续”和“已确认且异常解除”，不动原状态机。 */
        mode = danger_present ? LED_MODE_ACKED : LED_MODE_ACKED_RESOLVED;
    }
    set_mode(mode, (state == 2 || state == 3) ? alarm_type : "");

    int64_t period = 0;
    int on = pattern_level(mode, t - s_epoch_us, &period);
    led_write(on);
}

#else  /* CONFIG_NODE_LED_GPIO < 0：本板/本构建没有可编程告警灯 */

/* 没有 LED 时提供空实现，node_main.c 不用加条件编译。
 * 台架命令同样保留符号，只是什么都不做。 */
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
