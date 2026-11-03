/* battery_logic.c —— 电池电压采样纯逻辑实现（主机 gcc 可编译；不依赖 ESP-IDF）
 * 判定口径见 battery_logic.h 头部注释与 BATTERY-CHAIN-CONTRACT.md §1.3/§2。
 *
 * 这个文件不碰 ADC、不读时钟、不打日志：输入是若干 raw 值 + 配置，
 * 输出是一个完整的 battery_result_t。这样同一份判定既能上板跑，
 * 也能用 gcc 在 PC 上做单元测试（tools/ 下已有对应用例）。
 */
#include "battery_logic.h"

/* 第三重门限：至少 BATTERY_MIN_AGREE 个样本要落在中位数 ±BATTERY_AGREE_MV 内。
 * 只看整体极差不够：七八个点挤在一起再加一个孤立野值，极差可能刚好不到 300；
 * 悬空引脚的两簇跳变也可能极差不大却完全不一致。样本数、整体极差、邻域一致率
 * 三者必须同时成立。 */
#define BATTERY_MIN_AGREE  5
#define BATTERY_AGREE_MV   150

#define BATTERY_OCV_POINTS 21

typedef struct {
    int mv;
    int pct;
} battery_ocv_point_t;

/* 1S 锂离子（4.2V 满充）静置 OCV 近似曲线，取自通用 1S Li-ion 放电曲线后取整。
 * 这是近似值：带负载、低温、老化都会让实际 SOC 偏离，所以只有 calibrated=1
 *（至少两点万用表校准过）才允许输出 percent。 */
static const battery_ocv_point_t BATTERY_OCV[BATTERY_OCV_POINTS] = {
    { 4200, 100 }, { 4150, 95 }, { 4100, 90 }, { 4050, 85 }, { 4000, 80 },
    { 3950, 75 },  { 3900, 70 }, { 3850, 65 }, { 3800, 60 }, { 3750, 55 },
    { 3700, 50 },  { 3650, 40 }, { 3600, 30 }, { 3550, 25 }, { 3500, 20 },
    { 3450, 15 },  { 3400, 10 }, { 3350, 7 },  { 3300, 5 },  { 3250, 3 },
    { 3200, 0 }
};

/* 填充一套安全默认值：2:1 分压、12bit/3100mV 量程、未标定、3.5V 低电、
 * 2.5..4.35V 有效范围。调用方可以在拿到实际电路参数后再覆盖个别字段。 */
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

/* ADC 满量程线性映射到引脚电压：先钳制输入，再整数四舍五入。
 * 公式：pin_mv = raw / max_raw * ref_mv。
 * 这里的 ref_mv 是“ADC 引脚上”的满量程电压（12dB 衰减约 3100mV），
 * 不是电池电压；分压还原在下一个函数做。
 * raw 越界（负数/超过满量程）按端点钳位，避免换算出一堆无意义的数。 */
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

/* 依分压比还原电池侧电压；分子/分母异常时回退成非零值，避免除零。
 * 例：100k/100k 分压，电池 4.0V -> 引脚 2.0V -> 还原回 4.0V。
 * 分母为 0 或负数属于配置错误，按 1 处理（宁可当没分压，也不要崩）。 */
int battery_pin_to_battery_mv(int pin_mv, const battery_config_t *cfg)
{
    int num = cfg ? cfg->divider_num : 2;
    int den = cfg ? cfg->divider_den : 1;

    if (pin_mv < 0) pin_mv = 0;
    if (num <= 0) num = 1;
    if (den <= 0) den = 1;
    return (pin_mv * num + den / 2) / den;
}

/* 应用千分比增益和毫伏偏移；正负都按最近整数取整。
 * gain_permille=1000 表示不放大；两点校准后通常略大于或小于 1000。
 * 负电压的四舍五入方向单独处理（-500 而不是 +500），避免向零偏。 */
int battery_apply_calibration(int mv, const battery_config_t *cfg)
{
    int gain = cfg ? cfg->gain_permille : 1000;
    int offset = cfg ? cfg->offset_mv : 0;

    if (gain <= 0) gain = 1000;
    return (mv * gain + (mv >= 0 ? 500 : -500)) / 1000 + offset;
}

/* 把 raw 一路换算到电池毫伏，极端结果钳到能安全表示的范围内。
 * 三步：raw -> 引脚 mV -> 电池 mV（分压还原）-> 校准。
 * 上限 60000mV 只是防溢出，正常 1S 锂电不会接近；下限 0 表示不倒扣。 */
int battery_raw_to_mv(int raw, const battery_config_t *cfg)
{
    int pin_mv = battery_raw_to_pin_mv(raw, cfg);
    int battery_mv = battery_pin_to_battery_mv(pin_mv, cfg);
    int calibrated = battery_apply_calibration(battery_mv, cfg);

    if (calibrated < 0) calibrated = 0;
    if (calibrated > 60000) calibrated = 60000;   /* mv 上限 60000 */
    return calibrated;
}

/* 最多 BATTERY_SAMPLE_COUNT 个输入做插入排序，不用动态分配。
 * 数据量固定很小（8 个），插入排序比 qsort 更省代码也更可控。
 * 注意：偶数个时取索引 (n-1)/2，即中间两个里较小的那个（保守取值）。 */
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

/* max-min；输入超过固定缓存上限时只看前 N 个。
 * 用于稳定性门限：极差越大说明采样越不可信。 */
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

/* 电池侧电压是否在配置范围内；上下界写反了先换回来再比。
 * 这里是“物理可能”的范围，不是低电量阈值：2.5V 以下基本可判定
 * 未接线/采样错，而不是“电量很低”。 */
int battery_mv_in_range(int mv, const battery_config_t *cfg)
{
    int min_mv = cfg ? cfg->min_mv : 2500;
    int max_mv = cfg ? cfg->max_mv : 4350;

    if (min_mv < 0) min_mv = 0;
    if (max_mv < min_mv) { int t = max_mv; max_mv = min_mv; min_mv = t; }
    return (mv >= min_mv && mv <= max_mv) ? 1 : 0;
}

/* 在相邻 OCV 表项间线性插值；没标定就不输出推测的百分比。
 * 表是“电压从高到低、百分比也递减”排列，所以命中区间满足
 * hi->mv >= mv >= lo->mv。两端超出表格时直接取端点值（0 或 100）。
 * 返回值 -1 单独表示“未标定”，调用方据此输出 JSON null 而不是 0%。 */
int battery_percent_from_mv(int mv, int calibrated)
{
    int i;

    /* 未标定不换算百分比（-1 -> JSON null） */
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

/* 只有可信有效的非负电压才参与低电量判断。
 * 无效读数时返回 0：不是“电量正常”，而是“无法判断”，
 * 上报里 valid=false 会让 APP 不显示低电标记。 */
int battery_low_mv(int valid, int mv, int low_mv)
{
    if (!valid) return 0;      /* 无效读数不允许声称“电量低”，也不允许声称“正常” */
    if (mv < 0) return 0;
    if (low_mv <= 0) low_mv = 3500;
    return (mv <= low_mv) ? 1 : 0;
}

/* 先按“无有效样本”初始化，再依次过采样数、读数、稳定性、物理范围四道门限；
 * 全部通过才写有效电压、百分比和低电状态。
 *
 * 输入：
 *   raws       ：一个采样窗的 ADC 原始值（最多 BATTERY_SAMPLE_COUNT 个）；
 *   count      ：实际个数；
 *   read_ok    ：本次 ADC 驱动层是否整体读成功；0 表示样本全不可信；
 *   cfg        ：换算/门限参数。
 * 输出 out 总会写满（无效时 mv/percent 为 -1，reason 说明原因），
 * 调用方不需要自己初始化它。 */
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
