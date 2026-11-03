/*
 * time_util.h — 时间可信度与 64 位毫秒换算的纯逻辑工具（无系统依赖，可单测）
 *
 * 背景（DAYU200 实测根因）：
 *   RK3568 板卡开机时由内核 hctosys 从 rtc0（rk808-rtc）读取时间；
 *   该 RTC 掉电后不保持有效值，板端因此长期运行在 2017-08-04；
 *   板卡没有默认路由（eth0/eth1 down、wlan0 无 IPv4），无法自行访问 NTP。
 *   所以"可信时间"必须由 PC 家庭网关经 HDC 下发，并由本文件给出统一的
 *   可信判定与 64 位换算，避免各处重复实现、口径不一致。
 *
 * 设计约束：
 *   - 一律用 int64_t 做毫秒运算：DAYU200 用户态是 32 位（ILP32），long 只有 32 位，
 *     ts.tv_sec*1000 ≈ 1.8e12 会溢出。
 *   - 只处理 UTC epoch，绝不叠加时区偏移（显示时区交给 APP）。
 *   - 秒 / 毫秒必须严格区分，不能把 2017 年的 10 位秒值当成毫秒。
 */
#ifndef ELDERCARE_TIME_UTIL_H
#define ELDERCARE_TIME_UTIL_H

#include <stdint.h>

/* 早于 2025-01-01T00:00:00Z 一律判为不可信（板端曾回退到 2017-08-04）。 */
#define TU_TRUST_FLOOR_MS 1735689600000LL
/* 晚于 2100-01-01T00:00:00Z 同样判为不可信（防未来时间与异常输入）。 */
#define TU_TRUST_CEIL_MS  4102444800000LL
/* 秒 / 毫秒判定分界：1e11 秒 ≈ 公元 5138 年；1e11 毫秒 ≈ 1973-03。
   当前时间戳只有两种现实形态：约 1.8e9（秒）与约 1.8e12（毫秒）。 */
#define TU_SECONDS_MAX    100000000000LL

/* 32 位目标上 int64_t 必须真的是 64 位，否则后面的算术全部失效。 */
#if defined(__STDC_VERSION__) && __STDC_VERSION__ >= 201112L
_Static_assert(sizeof(int64_t) == 8, "int64_t must be 64-bit");
#endif

/* 秒 -> 毫秒（64 位，宽到 2100 年也不会溢出）。 */
static inline int64_t tu_sec_to_ms(int64_t sec)
{
    return sec * 1000LL;
}

/* 输入可能是 10 位秒或 13 位毫秒；统一归一化到毫秒。 */
static inline int tu_looks_like_seconds(int64_t v)
{
    return v > 0 && v < TU_SECONDS_MAX;
}

static inline int64_t tu_normalize_epoch_ms(int64_t v)
{
    return tu_looks_like_seconds(v) ? tu_sec_to_ms(v) : v;
}

/* 可信判定：只认 [2025-01-01, 2100-01-01] 区间内的毫秒值。 */
static inline int tu_epoch_ms_trusted(int64_t ms)
{
    return ms >= TU_TRUST_FLOOR_MS && ms <= TU_TRUST_CEIL_MS;
}

static inline int64_t tu_abs_diff_ms(int64_t a, int64_t b)
{
    return a > b ? a - b : b - a;
}

/* epoch 毫秒 -> UTC 年/月/日/时/分/秒（Howard Hinnant civil_from_days）。
   输出不包含任何时区偏移：10:37:08Z 就是 10 时，不是 18 时。 */
static inline void tu_ms_to_utc(int64_t ms, int64_t *year, int *mon, int *day,
                                int *hour, int *min, int *sec)
{
    int64_t secs = ms / 1000;
    if (ms < 0 && ms % 1000 != 0) secs -= 1;         /* 向负无穷取整 */
    int64_t days = secs / 86400;
    int64_t rem  = secs % 86400;
    if (rem < 0) { rem += 86400; days -= 1; }

    if (hour) *hour = (int)(rem / 3600);
    if (min)  *min  = (int)((rem % 3600) / 60);
    if (sec)  *sec  = (int)(rem % 60);

    int64_t z = days + 719468;
    int64_t era = (z >= 0 ? z : z - 146096) / 146097;
    uint32_t doe = (uint32_t)(z - era * 146097);
    uint32_t yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    int64_t y = (int64_t)yoe + era * 400;
    uint32_t doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    uint32_t mp = (5 * doy + 2) / 153;
    uint32_t d = doy - (153 * mp + 2) / 5 + 1;
    uint32_t m = mp < 10 ? mp + 3 : mp - 9;

    if (year) *year = y + (m <= 2);
    if (mon)  *mon  = (int)m;
    if (day)  *day  = (int)d;
}

#endif /* ELDERCARE_TIME_UTIL_H */
