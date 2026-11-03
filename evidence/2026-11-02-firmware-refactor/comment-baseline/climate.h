#ifndef CLIMATE_H
#define CLIMATE_H

void climate_bus_start(void);          /* 外部 AHT20 的 I2C1 总线与初始化命令 */
int  climate_read(float *temp_c, float *rh);   /* 0=有效读数，-1=本次无效 */

#endif /* CLIMATE_H */
