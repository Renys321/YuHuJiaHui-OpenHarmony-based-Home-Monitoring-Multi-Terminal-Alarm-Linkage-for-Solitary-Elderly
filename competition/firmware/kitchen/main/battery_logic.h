/* battery_logic.h —— 电池电压采样纯逻辑（不依赖 ESP-IDF 和硬件，主机侧可直接编译测试）
 *
 * 为什么单独拆一个文件：
 *   电压换算、有效性、百分比这些规则最容易出错，也最需要单测；
 *   把它们和 ADC 读取、JSON 拼装分开后，可以在 PC 上直接跑测试，
 *   不需要接板子，也不会因为改硬件代码而破坏判定逻辑。
 *
 * 字段名和 reason 短码要和 APP、云端保持同一套，详见 BATTERY-CHAIN-CONTRACT.md。
 * 改字段名或短码会导致 APP 解析不到，除非三端一起改。
 *
 * 完整判定链路（node_main.c 只负责读 ADC 和拼 JSON）：
 *   1) raw -> 引脚 mV：
 *        12 bit ADC（0..4095），12 dB 衰减，默认满量程约 3100 mV；
 *   2) 分压还原：
 *        battery_mv = pin_mv * DIVIDER_NUM / DIVIDER_DEN
 *        1S 锂电用 100k/100k 分压 => 2/1（引脚电压是电池电压的一半）；
 *   3) 两点校准：
 *        mv * GAIN_PERMILLE / 1000 + OFFSET_MV
 *        GAIN_PERMILLE=1000、OFFSET_MV=0 表示不校准；
 *   4) 取 8 个样本的中位数：
 *        不用平均值，避免 Wi-Fi 发射瞬间的单个毛刺把电压拉低；
 *        8 个样本的 max-min > 300mV 判 UNSTABLE；
 *   5) 有效性范围：默认 2.5V..4.35V；
 *        0 raw（未接线/悬空拉到地）绝不算有效；
 *   6) 低电量：默认 <= 3500mV 为 low=true，只有有效读数才允许判断；
 *   7) 百分比：只有 calibrated=1 才给 0..100，否则 -1（JSON null）。
 *        未标定时 APP 只显示 mV 并注明“未标定”，不编造电量。
 *
 * 几条必须守住的边界：
 *   - 0 raw 不允许变成 valid=true 或 0%。
 *   - 软浮空引脚的大幅抖动必须落 UNSTABLE，不许取巧成某个电压。
 *   - 未标定时 percent 必须是 null（-1）。
 *   - 不把 USB 5V、csq、Wi-Fi 信号当电量；本模块只接受“分压后的电池电压”。 */
#ifndef BATTERY_LOGIC_H
#define BATTERY_LOGIC_H

#include <stddef.h>

/* 一个采样窗取 8 个点（默认每 30 秒采一次），取中位数。
 * 样本太少时中位数没有意义，见 BATTERY_MIN_SAMPLES。 */
#define BATTERY_SAMPLE_COUNT   8

/* 少于 3 个成功样本时无法做可信的中位数/稳定性判定，按“无有效样本”处理。
 * 这是保守下限：宁可报 UNSTABLE/NO_ADC，也不拿 1 个点猜电量。 */
#define BATTERY_MIN_SAMPLES    3

/* 稳定性门限（毫伏，已经还原到电池侧，不是引脚侧）。
 * 8 个样本 max-min 超过 300mV 就判 UNSTABLE，常见原因是：
 *   - 电池接触不良；
 *   - Wi-Fi 发射瞬间的电源跌落；
 *   - ADC 引脚浮空。 */
#define BATTERY_MAX_SPREAD_MV  300

/* reason 是给 APP/云端看的短码，只允许 [A-Z_]{0,16}；
 * 空串表示本次读数有效。短码不要随意改名，APP 侧按字符串匹配。 */
#define BATTERY_REASON_NONE         ""              /* 有效，无错误 */
#define BATTERY_REASON_NO_ADC       "NO_ADC"        /* 未配置 ADC 通道，或有效样本不足 */
#define BATTERY_REASON_READ_FAIL    "READ_FAIL"     /* 本次 ADC 读取全部失败 */
#define BATTERY_REASON_UNSTABLE     "UNSTABLE"      /* 样本抖动过大（含 Wi-Fi 发射毛刺） */
#define BATTERY_REASON_OUT_OF_RANGE "OUT_OF_RANGE"  /* 换算后不在 2.5V..4.35V（含 0 raw 未接线） */

/* 电池换算与判定参数。全部来自 Kconfig，node_main.c 启动时调用
 * battery_config_default() 填一份，再按需覆盖。
 * 单位统一用 mV / 千分比，避免浮点运算和平台差异。 */
typedef struct {
    int max_raw;        /* ADC 满量程：12 bit = 4095 */
    int ref_mv;         /* 满量程对应的引脚电压：ESP32-S3 12dB 衰减约 3100mV */
    int divider_num;    /* 分压比分子（R1=R2=100k => 2） */
    int divider_den;    /* 分压比分母（R1=R2=100k => 1） */
    int gain_permille;  /* 两点校准增益：1000 = 1.000，即不放大不缩小 */
    int offset_mv;      /* 两点校准偏移（mV，可为负） */
    int low_mv;         /* 低电量阈值（默认 3500，<= 判 low） */
    int min_mv;         /* 有效范围下界（默认 2500） */
    int max_mv;         /* 有效范围上界（默认 4350） */
    int calibrated;     /* 1 = 已经过至少两点万用表校准，才允许给 percent */
} battery_config_t;

/* 一次采样窗的判定结果。JSON 里的 battery 对象就是从这里来的：
 *   present = valid（没接电池/读数不可信时不声称“有电池”）
 *   valid / mv / percent / low / reason 一一对应。 */
typedef struct {
    int valid;              /* 1 = 本次读数可用 */
    int mv;                 /* 电池电压；-1 表示 JSON null（无效时不报任何电压） */
    int percent;            /* 0..100；-1 表示 JSON null（未标定/无效一律 null） */
    int low;                /* 1 = 低于/等于 low_mv 阈值；无效时恒为 0 */
    int raw_median;         /* 诊断用：原始 ADC 中位数；-1 表示没有样本 */
    const char *reason;     /* 短码；有效时为空串 BATTERY_REASON_NONE */
} battery_result_t;

/* 填默认参数：2:1 分压、未标定、3.5V 低电、2.5..4.35V 有效、
 * 12 bit / 3100mV 量程。调用方可以在这之后再改字段。
 * cfg 不能为 NULL；函数不检查，因为这是内部固定用法。 */
void battery_config_default(battery_config_t *cfg);

/* 原始 ADC 值 -> 引脚电压（mV）。
 * 公式：pin_mv = raw * ref_mv / max_raw。
 * raw 超出 0..max_raw 时按量程钳位，避免异常值算出离谱电压。
 * 注意这里得到的是“分压后的引脚电压”，还不是电池电压。 */
int battery_raw_to_pin_mv(int raw, const battery_config_t *cfg);

/* 引脚电压 -> 电池电压（mV），即分压还原。
 * 公式：battery_mv = pin_mv * divider_num / divider_den。
 * divider_den <= 0 时按 1 处理，防止配置错误导致除零。 */
int battery_pin_to_battery_mv(int pin_mv, const battery_config_t *cfg);

/* 应用两点校准：mv * gain_permille / 1000 + offset_mv。
 * gain_permille <= 0 视为 1000（防止配置成 0 把电压全算成 0）。 */
int battery_apply_calibration(int mv, const battery_config_t *cfg);

/* 上面三步的合成：raw -> 电池 mV。
 * 等价于 battery_apply_calibration(
 *            battery_pin_to_battery_mv(
 *                battery_raw_to_pin_mv(raw, cfg), cfg), cfg)，
 * 但中间不截断，减少整数误差。 */
int battery_raw_to_mv(int raw, const battery_config_t *cfg);

/* 中位数。
 * 参数 values 指向 count 个值，函数内部会排序（会修改传入数组）。
 * count <= 0 返回 0。
 * 偶数个时取中间两个的较小值：保守，宁可少报电压也不多报。 */
int battery_median(const int *values, int count);

/* 极差 max-min，用于稳定性判断。count <= 0 返回 0。 */
int battery_spread(const int *values, int count);

/* 判断电池电压是否落在 cfg->min_mv..cfg->max_mv 之间（闭区间）。
 * 返回 1 = 在范围内，0 = 越界。 */
int battery_mv_in_range(int mv, const battery_config_t *cfg);

/* 1S 锂离子电池“静置开路电压 -> 电量”近似表。
 * 只有 calibrated=1 才返回 0..100；未标定返回 -1（JSON null）。
 * 表外按端点钳位：<=3200mV -> 0，>=4200mV -> 100。
 * 注意这是近似值，负载下电压会偏低，不能当库仑计使用。 */
int battery_percent_from_mv(int mv, int calibrated);

/* 低电量判断。
 * 只有 valid=1 且 mv <= low_mv 才返回 1；无效读数一律返回 0，
 * 因为“读数不可信”不等于“电量不低”，APP 应看 valid/reason 而不是 low。 */
int battery_low_mv(int valid, int mv, int low_mv);

/* 汇总判定：一个采样窗（最多 BATTERY_SAMPLE_COUNT 个 raw）-> battery_result_t。
 * 参数：
 *   raws    - 原始 ADC 样本数组
 *   count   - 样本个数（0..BATTERY_SAMPLE_COUNT）
 *   read_ok - 0 表示本次 ADC 读取失败，所有样本都不可信
 *   cfg     - 换算参数
 *   out     - 输出；函数总是完整写入，不会留半初始化状态
 * 处理顺序：
 *   1. 样本不足或读取失败 -> 对应的 NO_ADC / READ_FAIL；
 *   2. 每个 raw 换算成电池 mV，取中位数；
 *   3. 极差过大 -> UNSTABLE；
 *   4. 越界 -> OUT_OF_RANGE；
 *   5. 否则 valid=1，再计算 low 和 percent。
 * 这个函数不读硬件、不写日志，方便在 PC 上做单元测试。 */
void battery_evaluate(const int *raws, int count, int read_ok,
                      const battery_config_t *cfg, battery_result_t *out);

#endif /* BATTERY_LOGIC_H */
