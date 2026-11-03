#ifndef LOCAL_LED_H
#define LOCAL_LED_H

#include "sdkconfig.h"

/* 板载单色告警灯（ALIENTEK DNESP32S3 用户 LED）。
 *
 * 依据 DNESP32S3 官方资料核对记录：
 *   docs/evidence/-kitchen-esp32-node-acceptance.md:23  "LED = IO1 | led.h：LED_GPIO_PIN GPIO_NUM_1"
 *   docs/evidence/-kitchen-esp32-node-audit.md:45       "IO1 = LED1"
 * 有效电平由 CONFIG_NODE_LED_ACTIVE_LOW 配置，上板后按实际观察确认。
 *
 * 只做告警指示，不承担普通联网/状态提示；非阻塞：只有 gpio_set_level 和 esp_timer
 * 读时，逻辑都在 100ms 主循环 tick 里跑完，无延时、无额外任务。 */

void local_led_start(void);                 /* 初始化 GPIO，上电默认灭（不重放历史告警） */
/* 按告警状态刷新灯效（非阻塞）。
 * state: 0=NORMAL 1=WARN 2=ALARM 3=ACKED
 * danger_present: 当前是否还有活跃危险（由 active_danger() 给）。
 *   ACKED 且仍有危险 -> 慢脉冲（已确认，异常还在）
 *   ACKED 且危险已解除 -> 先 0.8s 确认常亮，然后熄灭
 *   NORMAL -> 灭；ALARM -> 快闪；ALARM+SOS -> 三短闪 */
void local_led_tick(int state, const char *alarm_type, int danger_present);

#if CONFIG_NODE_ALARM_BENCH_INJECT
/* 仅隔离台架固件：原始电平 / 极性 / 识别演示，用于真实观察和极性确认 */
void local_led_bench_raw(int on); /* 强制亮/灭，忽略状态机 */
void local_led_bench_auto(void);  /* 交回状态机自动控制 */
void local_led_bench_polarity(int active_low); /* 设置极性（0=高电平亮，1=低电平亮） */
void local_led_bench_identify(int duration_ms); /* 识别演示（短亮长灭）持续 duration_ms 毫秒，之后恢复状态机 */
#endif

#endif /* LOCAL_LED_H */
