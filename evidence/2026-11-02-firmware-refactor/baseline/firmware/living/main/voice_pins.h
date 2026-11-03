#ifndef NODE_VOICE_PINS_H
#define NODE_VOICE_PINS_H
/* DNESP32S3 30_music BSP: I2S TX (GPIO3/9/10/46) + I2S RX DIN=GPIO14 (板载咪头)。
 * GPIO14 只在 mictest/告警录音窗口内作为 ES8388 ADC 数据输入使用，禁止再分配给传感器。 */
/* 判断参数是否为语音播放/录音占用的物理 GPIO；ADC1 通道号需先按 GPIO=通道+1 换算。 */
#define VOICE_PIN_BUSY(pin) ((pin) == 3 || (pin) == 9 || (pin) == 10 || (pin) == 14 || (pin) == 46)
#if CONFIG_NODE_VOICE_ENABLED
/* 语音与模拟传感器共享 ADC/I2S 引脚会造成电气冲突，在编译期直接拒绝配置。 */
#if CONFIG_NODE_MQ2_ADC_CHANNEL >= 0 && VOICE_PIN_BUSY(CONFIG_NODE_MQ2_ADC_CHANNEL + 1)
#error "VOICE_PIN_CONFLICT: MQ2 ADC1 pin overlaps ES8388 I2S; do not flash"
#endif
#if CONFIG_NODE_MQ5_ADC_CHANNEL >= 0 && VOICE_PIN_BUSY(CONFIG_NODE_MQ5_ADC_CHANNEL + 1)
#error "VOICE_PIN_CONFLICT: MQ5 ADC1 pin overlaps ES8388 I2S (kitchen GPIO9); do not flash"
#endif
#if VOICE_PIN_BUSY(CONFIG_NODE_MOTION_GPIO) || VOICE_PIN_BUSY(CONFIG_NODE_SOS_GPIO) || VOICE_PIN_BUSY(CONFIG_NODE_DOOR_GPIO) || VOICE_PIN_BUSY(CONFIG_NODE_WATER_GPIO) || VOICE_PIN_BUSY(CONFIG_NODE_BUZZER_GPIO) || VOICE_PIN_BUSY(CONFIG_NODE_DHT11_GPIO)
#error "VOICE_PIN_CONFLICT: sensor GPIO overlaps ES8388 I2S; do not flash"
#endif
#if CONFIG_NODE_AHT20_ENABLED && (VOICE_PIN_BUSY(CONFIG_NODE_I2C_SDA_GPIO) || VOICE_PIN_BUSY(CONFIG_NODE_I2C_SCL_GPIO))
#error "VOICE_PIN_CONFLICT: AHT20 bus overlaps ES8388 I2S; do not flash"
#endif
#endif
#endif
