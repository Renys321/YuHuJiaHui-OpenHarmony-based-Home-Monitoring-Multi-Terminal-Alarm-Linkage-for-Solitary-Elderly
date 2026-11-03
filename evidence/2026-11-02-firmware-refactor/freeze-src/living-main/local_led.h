#ifndef LOCAL_LED_H
#define LOCAL_LED_H

#include "sdkconfig.h"

/* 板载单色告警灯（ALIENTEK DNESP32S3 用户 LED，默认 GPIO1）。
 *
 * 有效电平由 CONFIG_NODE_LED_ACTIVE_LOW 决定：
 *   0 = 高电平亮；1 = 低电平亮。上板后以实际观察为准。
 *
 * 这盏灯只表达“告警状态”，不做普通联网/心跳提示，避免现场把闪灯误认为故障。
 * 灯效全部在 100ms 主循环 tick 里推进：只读写 GPIO 和 esp_timer，
 * 没有延时、没有额外任务，不会拖慢采样和上报。
 *
 * 状态与灯效对应（state 取值与 node_main.c 的 s_state 一致）：
 *   0 NORMAL：灭
 *   1 WARN  ：慢闪（有异常趋势，但还没达到告警条件）
 *   2 ALARM ：快闪；如果是 SOS，改成三短闪
 *   3 ACKED ：慢脉冲（家属已确认，但危险还在）
 *            危险解除后先常亮 0.8 秒表示“确认收到”，再熄灭
 *
 * 上电默认灭：重启后不重放历史告警，避免半夜无故亮灯。 */

/* 初始化 LED GPIO 为输出，并立即输出“灭”的电平。
 * 必须在 board_gpio_start() 之后调用，避免和传感器引脚配置互相覆盖。 */
void local_led_start(void);

/* 按当前告警状态刷新灯效，非阻塞，主循环每 100ms 调一次。
 * 参数：
 *   state          - 0=NORMAL 1=WARN 2=ALARM 3=ACKED
 *   alarm_type     - 告警类型字符串（如 "MANUAL_SOS"），仅 ALARM 时用于区分 SOS；
 *                    可以为 NULL
 *   danger_present - 当前是否仍有活跃危险（active_danger() 的结果）
 * 该函数内部自己记录时间基线，调用频率变化会让闪烁节奏跟着变化。 */
void local_led_tick(int state, const char *alarm_type, int danger_present);

#if CONFIG_NODE_ALARM_BENCH_INJECT
/* 以下四个函数只编进台架固件（CONFIG_NODE_ALARM_BENCH_INJECT=y），
 * 用于现场确认 LED 极性、接线和状态机是否符合预期；正式现场固件里不存在。 */

/* 强制亮/灭，暂时忽略告警状态机。用于确认灯到底怎么才算亮。 */
void local_led_bench_raw(int on);

/* 交回状态机自动控制（退出 bench_raw / bench_identify 的影响）。 */
void local_led_bench_auto(void);

/* 设置有效电平：0=高电平亮，1=低电平亮。
 * 只影响本模块的 GPIO 输出，不写 NVS，重启恢复 Kconfig 配置。 */
void local_led_bench_polarity(int active_low);

/* 识别演示：短亮长灭地闪 duration_ms 毫秒，方便在机柜里找到这块板；
 * 到时自动恢复状态机控制。 */
void local_led_bench_identify(int duration_ms);
#endif

#endif /* LOCAL_LED_H */
