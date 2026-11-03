/* battery_logic.c —— 电池电压采样纯逻辑实现（主机 gcc 可编译；不依赖 ESP-IDF）
 * 判定口径见 battery_logic.h 头部注释与 BATTERY-CHAIN-CONTRACT.md §1.3/§2。
 */
#include "battery_logic.h"

/* 三重门限之三：至少 BATTERY_MIN_AGREE 个样本要落在中位数 ±BATTERY_AGREE_MV 内。
 * 只有“整体最大最小差”一个门限时，7 个点聚在一起、1 个孤立野值也可能只是把 spread
 * 拉到 300 以内却仍然可信；反过来，悬空引脚的两簇跳变可能 spread 没超限但完全不一致。
 * 因此：样本数、整体极差、中位数邻域一致率，三者必须同时成立。 */
#define BATTERY_MIN_AGREE  5
#define BATTERY_AGREE_MV   150

#define BATTERY_OCV_POINTS 21

typedef struct {
    int mv;
    int pct;
} battery_ocv_point_t;

/* 1S 锂离子（4.2V 满充）静置 OCV 近似曲线，来源为通用 1S Li-ion 放电曲线取整。
 *  这是“近似”：带负载、低温、老化都会让实际 SOC 偏离；
 *    因此只有 calibrated=1（至少两点万用表校准过）才允许输出 percent。 */
static const battery_ocv_point_t BATTERY_OCV[BATTERY_OCV_POINTS] = {
    { 4200, 100 }, { 4150, 95 }, { 4100, 90 }, { 4050, 85 }, { 4000, 80 },
    { 3950, 75 },  { 3900, 70 }, { 3850, 65 }, { 3800, 60 }, { 3750, 55 },
    { 3700, 50 },  { 3650, 40 }, { 3600, 30 }, { 3550, 25 }, { 3500, 20 },
    { 3450, 15 },  { 3400, 10 }, { 3350, 7 },  { 3300, 5 },  { 3250, 3 },
    { 3200, 0 }
};

void battery_config_default(battery_config_t *cfg)
{
    if (!cfg) return;
    cfg->max_raw = 4095;
    cfg->ref_mv = 3100;
    cfg->divider_num = 2;
    cfg->divider_den = 1;
    cfg->gain_permille = 1000;
    cfg->offset_mv = 0;
    cfg->low_mv = 3500;
    cfg->min_mv = 2500;
    cfg->max_mv = 4350;
    cfg->calibrated = 0;
}

/* 将 ADC 满量程线性映射到引脚电压；先钳制输入，再用整数四舍五入。 */
int battery_raw_to_pin_mv(int raw, const battery_config_t *cfg)
{
    int max_raw = cfg ? cfg->max_raw : 4095;
    int ref_mv = cfg ? cfg->ref_mv : 3100;

    if (max_raw <= 0) max_raw = 4095;
    if (ref_mv <= 0) ref_mv = 3100;
    if (raw < 0) raw = 0;
    if (raw > max_raw) raw = max_raw;
    return (raw * ref_mv + max_raw / 2) / max_raw;
}

/* 依据分压比还原电池侧电压；异常分子/分母回退到非零值以避免除零。 */
int battery_pin_to_battery_mv(int pin_mv, const battery_config_t *cfg)
{
    int num = cfg ? cfg->divider_num : 2;
    int den = cfg ? cfg->divider_den : 1;

    if (pin_mv < 0) pin_mv = 0;
    if (num <= 0) num = 1;
    if (den <= 0) den = 1;
    return (pin_mv * num + den / 2) / den;
}

/* 应用千分比增益和毫伏偏移；正负数均按最近整数取整。 */
int battery_apply_calibration(int mv, const battery_config_t *cfg)
{
    int gain = cfg ? cfg->gain_permille : 1000;
    int offset = cfg ? cfg->offset_mv : 0;

    if (gain <= 0) gain = 1000;
    return (mv * gain + (mv >= 0 ? 500 : -500)) / 1000 + offset;
}

/* 汇总 raw 到电池毫伏的换算，并将极端结果限制在可安全表示的范围内。 */
int battery_raw_to_mv(int raw, const battery_config_t *cfg)
{
    int pin_mv = battery_raw_to_pin_mv(raw, cfg);
    int battery_mv = battery_pin_to_battery_mv(pin_mv, cfg);
    int calibrated = battery_apply_calibration(battery_mv, cfg);

    if (calibrated < 0) calibrated = 0;
    if (calibrated > 60000) calibrated = 60000;   /* 契约 §2：mv 上限 60000 */
    return calibrated;
}

/* 对最多 BATTERY_SAMPLE_COUNT 个输入做插入排序，避免动态分配与额外依赖。 */
int battery_median(const int *values, int count)
{
    int sorted[BATTERY_SAMPLE_COUNT];
    int i, j, n;

    if (!values || count <= 0) return 0;
    n = count > BATTERY_SAMPLE_COUNT ? BATTERY_SAMPLE_COUNT : count;
    for (i = 0; i < n; i++) sorted[i] = values[i];
    for (i = 1; i < n; i++) {
        int key = sorted[i];
        j = i - 1;
        while (j >= 0 && sorted[j] > key) {
            sorted[j + 1] = sorted[j];
            j--;
        }
        sorted[j + 1] = key;
    }
    /* 偶数个取中间两个的较小值：宁可低估也不敢把电压抬高 */
    return sorted[(n - 1) / 2];
}

/* 计算样本的最大值与最小值之差；输入数超过固定缓存上限时只检查前 N 个。 */
int battery_spread(const int *values, int count)
{
    int i, n, lo, hi;

    if (!values || count <= 0) return 0;
    n = count > BATTERY_SAMPLE_COUNT ? BATTERY_SAMPLE_COUNT : count;
    lo = hi = values[0];
    for (i = 1; i < n; i++) {
        if (values[i] < lo) lo = values[i];
        if (values[i] > hi) hi = values[i];
    }
    return hi - lo;
}

/* 检查电池侧电压是否在配置范围内；倒置上下界时先交换后比较。 */
int battery_mv_in_range(int mv, const battery_config_t *cfg)
{
    int min_mv = cfg ? cfg->min_mv : 2500;
    int max_mv = cfg ? cfg->max_mv : 4350;

    if (min_mv < 0) min_mv = 0;
    if (max_mv < min_mv) { int t = max_mv; max_mv = min_mv; min_mv = t; }
    return (mv >= min_mv && mv <= max_mv) ? 1 : 0;
}

/* 在相邻 OCV 表项间线性插值；标定状态为 false 时不输出推测百分比。 */
int battery_percent_from_mv(int mv, int calibrated)
{
    int i;

    /* 契约 §1.3：未标定不换算百分比（-1 -> JSON null） */
    if (!calibrated) return -1;
    if (mv >= BATTERY_OCV[0].mv) return BATTERY_OCV[0].pct;
    if (mv <= BATTERY_OCV[BATTERY_OCV_POINTS - 1].mv) return BATTERY_OCV[BATTERY_OCV_POINTS - 1].pct;
    for (i = 0; i < BATTERY_OCV_POINTS - 1; i++) {
        const battery_ocv_point_t *hi = &BATTERY_OCV[i];
        const battery_ocv_point_t *lo = &BATTERY_OCV[i + 1];
        if (mv <= hi->mv && mv >= lo->mv) {
            int dmv = hi->mv - lo->mv;          /* > 0 */
            int dpct = hi->pct - lo->pct;       /* > 0 */
            int up = mv - lo->mv;               /* >= 0 */
            return lo->pct + (up * dpct + dmv / 2) / dmv;
        }
    }
    return 0;
}

/* 只有可信有效的非负电压才参与低电量阈值判断。 */
int battery_low_mv(int valid, int mv, int low_mv)
{
    if (!valid) return 0;      /* 无效读数不允许声称“电量低”，也不允许声称“正常” */
    if (mv < 0) return 0;
    if (low_mv <= 0) low_mv = 3500;
    return (mv <= low_mv) ? 1 : 0;
}

/* 初始化结果为“无有效样本”，然后依次执行采样数、读数、稳定性与物理范围门限。
 * 只有全部门限通过才写入有效电压、百分比和低电状态。 */
void battery_evaluate(const int *raws, int count, int read_ok,
                      const battery_config_t *cfg, battery_result_t *out)
{
    int n, i, agree, median_mv, spread_mv;
    int battery_mv[BATTERY_SAMPLE_COUNT];
    int valid_count = 0;

    if (!out) return;
    out->valid = 0;
    out->mv = -1;
    out->percent = -1;
    out->low = 0;
    out->raw_median = -1;
    out->reason = BATTERY_REASON_NO_ADC;

    if (!cfg || !raws || count < BATTERY_MIN_SAMPLES) return;   /* NO_ADC：没有采样能力/样本不足 */
    if (!read_ok) {
        out->reason = BATTERY_REASON_READ_FAIL;
        return;
    }

    n = count > BATTERY_SAMPLE_COUNT ? BATTERY_SAMPLE_COUNT : count;
    out->raw_median = battery_median(raws, n);
    for (i = 0; i < n; i++) {
        /* ADC 读失败单个样本由调用方剔除；这里再兜一层：raw 越界视为不可用样本 */
        int max_raw = cfg->max_raw > 0 ? cfg->max_raw : 4095;
        if (raws[i] < 0 || raws[i] > max_raw) continue;
        battery_mv[valid_count++] = battery_raw_to_mv(raws[i], cfg);
    }
    if (valid_count < BATTERY_MIN_SAMPLES) {
        out->reason = BATTERY_REASON_READ_FAIL;
        return;
    }

    median_mv = battery_median(battery_mv, valid_count);
    spread_mv = battery_spread(battery_mv, valid_count);

    /* 门限一：整体极差（Wi-Fi 发射窗口毛刺、接触不良都会把极差拉大） */
    if (spread_mv > BATTERY_MAX_SPREAD_MV) {
        out->reason = BATTERY_REASON_UNSTABLE;
        return;
    }
    /* 门限二：中位数邻域一致率（防止“两簇跳变但极差不大”的悬空噪声） */
    agree = 0;
    for (i = 0; i < valid_count; i++) {
        int diff = battery_mv[i] - median_mv;
        if (diff < 0) diff = -diff;
        if (diff <= BATTERY_AGREE_MV) agree++;
    }
    if (agree < BATTERY_MIN_AGREE && agree < valid_count) {
        /* 样本本身就只有 3~4 个时，允许“全部一致”（agree == valid_count）通过；
         * 否则必须有 BATTERY_MIN_AGREE 个落在中位数邻域内。 */
        out->reason = BATTERY_REASON_UNSTABLE;
        return;
    }
    /* 门限三：物理范围（含 0 raw = 未接线/悬空拉到地，不 valid） */
    if (median_mv <= 0 || !battery_mv_in_range(median_mv, cfg)) {
        out->reason = BATTERY_REASON_OUT_OF_RANGE;
        return;
    }

    out->valid = 1;
    out->mv = median_mv;
    out->percent = battery_percent_from_mv(median_mv, cfg->calibrated);
    out->low = battery_low_mv(1, median_mv, cfg->low_mv);
    out->reason = BATTERY_REASON_NONE;
}
