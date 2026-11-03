#ifndef BOARD_IO_H
#define BOARD_IO_H

#include <stdint.h>
#include "sdkconfig.h"
#include "esp_err.h"

/* 板载 XL9555（I2C0@0x20）：蜂鸣器 P0_3、KEY0 P1_7、KEY1 P1_6 都挂这颗片子。
 * 寄存器级接口留给同文件外的按键读取和自检命令使用。 */
esp_err_t board_xl9555_read(uint8_t reg, uint8_t *value);
esp_err_t board_xl9555_write(uint8_t reg, uint8_t value);
esp_err_t board_xl9555_read_ports(uint8_t out[2]);

void board_gpio_start(void);   /* PIR / SOS / 水漏 / 外接蜂鸣器的 GPIO 方向与上下拉 */
void board_i2c_start(void);    /* I2C0 + 板载蜂鸣器 + KEY0 初始化 */
void board_buzzer(int on);

/* KEY0 轮询：返回 -1 表示本次 I2C 读取失败（既不算按下也不算松开），
 * 0/1 为松开/按下。内部做了电平变化日志和失败日志限流。 */
int board_key0_poll(void);

#if CONFIG_NODE_VOICE_ENABLED && CONFIG_NODE_BUZZER_XL9555
void board_ai_key_tick(void);  /* KEY1 短按 -> 语音提问 */
#endif

#endif /* BOARD_IO_H */
