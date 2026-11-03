#ifndef CLIMATE_VALID_H
#define CLIMATE_VALID_H

#include <math.h>

/*
 * 温湿度有效性纯逻辑（生产代码与 PC 测试共用）。
 *
 * valid=true 仅在：本次读取返回成功，且 temp/rh 为有限值并落在 SHT30
 * 可表达范围内。0.0C / 0%RH 本身不是无效判据；只有在读取失败或
 * 数值非法时才置 false。
 */
typedef struct {
    float temp_c;
    float rh;
    int valid;
} climate_sample_t;

static inline int climate_reading_valid(float temp_c, float rh)
{
    if (!isfinite(temp_c) || !isfinite(rh)) return 0;
    /* SHT30 可表达范围；不是业务舒适区阈值。 */
    if (temp_c < -40.0f || temp_c > 125.0f) return 0;
    if (rh < 0.0f || rh > 100.0f) return 0;
    return 1;
}

static inline void climate_apply_sample(climate_sample_t *s, int read_ok,
                                        float temp_c, float rh)
{
    if (s == 0) return;
    /* sht30_read() 约定：0=成功，负值=失败；不能用“非零即成功”。 */
    if (read_ok == 0 && climate_reading_valid(temp_c, rh)) {
        s->temp_c = temp_c;
        s->rh = rh;
        s->valid = 1;
        return;
    }
    /* 失败时保留历史数值（供“上次读数”展示），但绝不沿用 valid=true。 */
    s->valid = 0;
}

#endif
