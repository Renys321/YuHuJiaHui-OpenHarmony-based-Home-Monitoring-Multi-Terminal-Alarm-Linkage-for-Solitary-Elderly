#ifndef NODE_VOICE_PINS_H
#define NODE_VOICE_PINS_H

/* 语音引脚冲突的编译期检查。
 *
 * 板子：DNESP32S3 30_music BSP
 *   I2S TX（扬声器/功放）：GPIO3、GPIO9、GPIO10、GPIO46
 *   I2S RX（板载咪头 DIN）：GPIO14
 * 这些 GPIO 一旦被语音占用，就不能再分配给 PIR、SOS、门磁、水漏、蜂鸣器、
 * DHT11、I2C（AHT20）或 MQ-2/MQ-5 的 ADC 通道，否则会出现：
 *   - 数字传感器读数乱跳；
 *   - 模拟传感器被 I2S 时钟干扰；
 *   - 语音播放时传感器失效。
 * 这类错误在运行时很难查，所以放在编译期直接拒绝，烧录前就能发现。 */

/* 判断一个 GPIO 编号是不是语音占用的引脚。
 * 参数必须是“GPIO 编号”，不是 ADC 通道号。
 * ESP32-S3 的 ADC1 通道和 GPIO 是固定映射：GPIO = 通道 + 1，
 * 所以检查 MQ-2/MQ-5 时要先写 CONFIG_NODE_MQx_ADC_CHANNEL + 1。 */
#define VOICE_PIN_BUSY(pin) ((pin) == 3 || (pin) == 9 || (pin) == 10 || (pin) == 14 || (pin) == 46)

#if CONFIG_NODE_VOICE_ENABLED
/* 逐个检查所有可能和语音抢引脚的外设：
 *   - MQ-2 / MQ-5：ADC 通道换算成 GPIO 后检查（通道 -1 表示未启用，跳过）
 *   - PIR、SOS、门磁、水漏、外接蜂鸣器、DHT11：直接检查 GPIO
 *   - AHT20：只检查 I2C 的 SDA/SCL，AHT20 没启用时这两根线可能另有用途
 * 任何一项命中，编译直接报错，错误信息里带 VOICE_PIN_CONFLICT 方便搜索。 */
#if (CONFIG_NODE_MQ2_ADC_CHANNEL >= 0 && VOICE_PIN_BUSY(CONFIG_NODE_MQ2_ADC_CHANNEL + 1)) || \
    (CONFIG_NODE_MQ5_ADC_CHANNEL >= 0 && VOICE_PIN_BUSY(CONFIG_NODE_MQ5_ADC_CHANNEL + 1)) || \
    VOICE_PIN_BUSY(CONFIG_NODE_MOTION_GPIO) || VOICE_PIN_BUSY(CONFIG_NODE_SOS_GPIO) || \
    VOICE_PIN_BUSY(CONFIG_NODE_DOOR_GPIO) || VOICE_PIN_BUSY(CONFIG_NODE_WATER_GPIO) || \
    VOICE_PIN_BUSY(CONFIG_NODE_BUZZER_GPIO) || VOICE_PIN_BUSY(CONFIG_NODE_DHT11_GPIO) || \
    (CONFIG_NODE_AHT20_ENABLED && (VOICE_PIN_BUSY(CONFIG_NODE_I2C_SDA_GPIO) || VOICE_PIN_BUSY(CONFIG_NODE_I2C_SCL_GPIO)))
#error "VOICE_PIN_CONFLICT: a sensor/ADC pin collides with the ES8388 I2S pins; do not flash"
#endif
#endif
#endif
