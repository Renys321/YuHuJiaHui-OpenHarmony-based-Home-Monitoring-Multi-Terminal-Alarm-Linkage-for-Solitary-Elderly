#ifndef BOARD_IO_H
#define BOARD_IO_H

/* 板载 IO 驱动接口。
 *
 * 这颗板子（DNESP32S3）的蜂鸣器和 KEY0/KEY1 不在 ESP32 的 GPIO 上，而是挂在
 * I2C0 的 XL9555 扩展芯片上：
 *   P0_2 = 功放使能（由 local_voice.c 使用）
 *   P0_3 = 蜂鸣器，低电平响
 *   P1_6 = KEY1，低电平按下，用于“语音提问”
 *   P1_7 = KEY0，低电平按下，用于“SOS 求助”
 * 其余传感器（PIR、水漏、外接蜂鸣器等）才直接接 ESP32 GPIO。
 *
 * 所有 XL9555 访问都在主任务里串行执行；语音任务只碰 I2S，因此这里不需要加锁。
 * 但 I2C 读写有失败的可能，调用方必须检查返回值，不能把失败当成“未按下”。 */

#include <stdint.h>
#include "sdkconfig.h"
#include "esp_err.h"

/* ---- XL9555 寄存器级接口 ----
 * XL9555 是 16 位 I2C 扩展器，被拆成两个 8 位端口：
 *   寄存器 0 = 输入端口 P0，寄存器 1 = 输入端口 P1
 *   寄存器 2 = 输出锁存 P0，寄存器 3 = 输出锁存 P1
 *   寄存器 6 = 方向配置 P0，寄存器 7 = 方向配置 P1（1=输入，0=输出）
 * 下面三个函数是薄封装，不做重试；超时分别为 100ms/100ms/50ms。
 * 返回 ESP_OK 才表示读到的值有效。 */

/* 读 XL9555 的 1 个寄存器。reg 是寄存器地址，value 用于接收结果。 */
esp_err_t board_xl9555_read(uint8_t reg, uint8_t *value);

/* 写 XL9555 的 1 个寄存器。value 直接写入，不做读改写。 */
esp_err_t board_xl9555_write(uint8_t reg, uint8_t value);

/* 一次读出两个输入端口：out[0]=P0，out[1]=P1。
 * 按键和自检命令都靠它拿原始电平；拆成两次读可能会读到不一致的快照。 */
esp_err_t board_xl9555_read_ports(uint8_t out[2]);

/* 初始化直接接在 ESP32 GPIO 上的几路数字输入/输出：
 *   - PIR 人体感应：输入 + 下拉，悬空时不随机触发
 *   - SOS 外接按键：输入 + 上拉，按下读到 0
 *   - 水漏探头：按 CONFIG_NODE_WATER_ACTIVE_LOW 决定上拉还是下拉
 *   - 外接蜂鸣器：输出，初始关
 * 板载蜂鸣器不在这里配置，它走 board_i2c_start()。
 * 每个分支都由对应 Kconfig 是否启用决定，未启用的外设完全不碰。 */
void board_gpio_start(void);

/* 初始化 I2C0（SDA=GPIO41，SCL=GPIO42，100kHz）以及挂在它上面的：
 *   - 板载蜂鸣器（P0_3 设为输出并静音）
 *   - KEY0（P1_7 设为输入，记录上电基线）
 * 只有蜂鸣器/KEY0/语音任一功能开启时才会真正初始化 I2C。
 * I2C 本身配置失败会触发 ESP_ERROR_CHECK 重启，因为这属于硬件配置错误。 */
void board_i2c_start(void);

/* 控制蜂鸣器开/关。
 *   板载蜂鸣器：改 XL9555 P0_3，低电平响，所以内部会对电平取反；
 *   外接蜂鸣器：直接写 GPIO，高电平响。
 * 读 XL9555 失败时直接返回，保持当前状态，不会误响。 */
void board_buzzer(int on);

/* 轮询 KEY0（SOS 键）。
 * 返回：
 *    1 = 按下（低电平）
 *    0 = 松开（高电平）
 *   -1 = 本次 I2C 读取失败，状态未知
 * -1 很关键：上层既不能把它当“按下”触发 SOS，也不能当“松开”解除告警。
 * 内部只在电平变化时打日志，并对连续读失败做 3 次限流，避免刷屏。 */
int board_key0_poll(void);

#if CONFIG_NODE_VOICE_ENABLED && CONFIG_NODE_BUZZER_XL9555
/* 轮询 KEY1（语音提问键），主循环每隔约 100ms 调一次。
 * 识别逻辑：按下沿记时间，松开沿且按住 >=50ms 才算一次短按；
 * 短按后蜂鸣一声，再触发 mic_link 录 4 秒问题。
 * 长按不会重复触发；上电时如果按键已经按住，要先松开一次才“武装”，
 * 防止上电瞬间误触发。
 * 只有语音构建且蜂鸣器挂在 XL9555 上时才需要这个函数。 */
void board_ai_key_tick(void);
#endif

#endif /* BOARD_IO_H */
