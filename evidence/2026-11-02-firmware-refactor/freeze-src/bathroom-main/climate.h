#ifndef CLIMATE_H
#define CLIMATE_H

/* 温湿度读取接口。
 *
 * 两种传感器按 Kconfig 二选一，但上层只用 climate_read()，不关心底层是谁：
 *   - AHT20：走 I2C1，引脚由 CONFIG_NODE_I2C_SDA_GPIO / SCL_GPIO 指定，
 *     地址固定 0x38，精度 0.01°C / 0.024%RH；
 *   - DHT11：单总线，GPIO 由 CONFIG_NODE_DHT11_GPIO 指定，
 *     只能读到整数温度和湿度。
 * 两者都没启用时，climate_read() 永远返回 -1。
 *
 * 注意：这里不判断“温度是否超标”，只负责拿到一次可信读数；
 * 是否告警由 node_main.c 的连续确认/回差逻辑决定。 */

/* 初始化传感器总线。
 * AHT20 启用时配置 I2C1（100kHz）、安装驱动并发送初始化命令；
 * DHT11 不需要总线初始化，此函数为空操作。
 * I2C 配置失败会走 ESP_ERROR_CHECK 直接重启，属于硬件配置错误。 */
void climate_bus_start(void);

/* 读一次温湿度。
 * 参数：
 *   temp_c - 输出，摄氏度
 *   rh     - 输出，相对湿度百分比（0~100）
 * 返回：
 *    0  = 读到有效值，且落在传感器量程内
 *   -1  = 本次读取失败：I2C 无应答、CRC 错、时序超时、校验和错或数值越界
 * 失败时输出参数内容未定义，调用方必须丢弃，不能拿来参与告警判定。
 * 本函数会阻塞：AHT20 约 90ms，DHT11 约 1.2s（含 1.1s 最小采样间隔）。 */
int  climate_read(float *temp_c, float *rh);

#endif /* CLIMATE_H */
