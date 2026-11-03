/* battery_logic.h —— 电池电压采样纯逻辑（不依赖 ESP-IDF 和硬件，主机侧可直接编译测试）
 *
 * 字段名和 reason 短码要和 APP、云端保持同一套，详见 BATTERY-CHAIN-CONTRACT.md。
 *
 * 判定都在这里，node_main.c / node_main(sos) / wearable 只做 I/O（ADC 读取、定时、JSON 拼装）：
 *   1) raw -> 引脚 mV（12 bit，12 dB 衰减，参考量程由配置给出）
 *   2) 分压还原：battery_mv = pin_mv * DIVIDER_NUM / DIVIDER_DEN（1S 锂电 100k/100k => 2/1）
 *   3) 两点校准：mv * GAIN_PERMILLE / 1000 + OFFSET_MV
 *   4) 8 样本中位数 + 稳定性（max-min > 300mV -> UNSTABLE）
 *   5) 有效性 2.5V..4.35V（0 raw 不算有效）
 *   6) 低电量阈值（默认 3500mV，<= 即 low=true）
 *   7) 百分比只在 calibrated=true 时给出（1S Li-ion 静置 OCV 近似表），否则 -1（JSON null）
 *
 * 几条必须守住的边界：
 *   - 0 raw（未接线/悬空拉到地）不允许变成 valid=true 或 0%。
 *   - 软浮空引脚的大幅抖动必须落 UNSTABLE，不许取巧成某个电压。
 *   - 未标定时 percent 必须是 null（-1），APP 只显示 mV 并注明“未标定”。
 *   - 不把 USB 5V、csq、Wi-Fi 信号当电量；本模块只接受“分压后的电池电压”这一个输入。
 */
#ifndef BATTERY_LOGIC_H
#define BATTERY_LOGIC_H

#include <stddef.h>

/* 每 30s 一次，连续 8 次取中位数 */
#define BATTERY_SAMPLE_COUNT   8
/* 少于 3 个成功样本时无法做可信中位数/稳定性判定：按“无有效样本”处理 */
#define BATTERY_MIN_SAMPLES    3
/* 稳定性门限（毫伏，电池侧）：8 样本 max-min 超过它 -> UNSTABLE */
#define BATTERY_MAX_SPREAD_MV  300

/* reason 只允许 [A-Z_]{0,16}，空串表示有效 */
#define BATTERY_REASON_NONE         ""
#define BATTERY_REASON_NO_ADC       "NO_ADC"        /* 未配置 ADC 通道 / 样本不足 */
#define BATTERY_REASON_READ_FAIL    "READ_FAIL"     /* 本次 ADC 读取全部失败 */
#define BATTERY_REASON_UNSTABLE     "UNSTABLE"      /* 样本抖动过大（含 Wi-Fi 发射窗口毛刺） */
#define BATTERY_REASON_OUT_OF_RANGE "OUT_OF_RANGE"  /* 换算后不在 2.5V..4.35V（含 0 raw 未接线） */

typedef struct {
    int max_raw;        /* ADC 满量程（12 bit = 4095） */
    int ref_mv;         /* 满量程对应的引脚电压（ESP32-S3 12dB 衰减约 3100mV） */
    int divider_num;    /* 分压比分子（R1=R2=100k => 2） */
    int divider_den;    /* 分压比分母（=> 1） */
    int gain_permille;  /* 两点校准增益（1000 = 1.000，不改） */
    int offset_mv;      /* 两点校准偏移（mV，可为负） */
    int low_mv;         /* 低电量阈值（默认 3500） */
    int min_mv;         /* 有效范围下界（默认 2500） */
    int max_mv;         /* 有效范围上界（默认 4350） */
    int calibrated;     /* 1 = 已经过至少两点万用表校准 -> 才允许给 percent */
} battery_config_t;

typedef struct {
    int valid;              /* 1 = 本次读数可用 */
    int mv;                 /* 电池电压；-1 表示 JSON null（无效时不报任何电压） */
    int percent;            /* 0..100；-1 表示 JSON null（未标定/无效一律 null） */
    int low;                /* 1 = 低于/等于 low_mv 阈值 */
    int raw_median;         /* 诊断用：原始 ADC 中位数；-1 表示没有样本 */
    const char *reason;     /* 短码；有效时为空串 */
} battery_result_t;

/* 默认值：2:1 分压、未标定、3.5V 低电、2.5..4.35V 有效、12bit/3100mV 量程 */
void battery_config_default(battery_config_t *cfg);

/* raw -> 引脚 mV（线性近似；超出量程按量程钳位） */
int battery_raw_to_pin_mv(int raw, const battery_config_t *cfg);

/* 引脚 mV -> 电池 mV（分压还原；非正分母视为 1，防止除零） */
int battery_pin_to_battery_mv(int pin_mv, const battery_config_t *cfg);

/* 两点校准：mv * gain/1000 + offset（gain<=0 视为 1000） */
int battery_apply_calibration(int mv, const battery_config_t *cfg);

/* raw -> 电池 mV（上面三步的合成） */
int battery_raw_to_mv(int raw, const battery_config_t *cfg);

/* 中位数（count<=0 返回 0）。偶数个取中间两个的较小值（保守，不放大电压） */
int battery_median(const int *values, int count);

/* max-min（count<=0 返回 0） */
int battery_spread(const int *values, int count);

/* 有效范围判定 */
int battery_mv_in_range(int mv, const battery_config_t *cfg);

/* 1S Li-ion 静置 OCV 近似表：只有 calibrated=1 才给值，否则返回 -1。
 * 表外按端点钳位（<=3200 -> 0，>=4200 -> 100）。 */
int battery_percent_from_mv(int mv, int calibrated);

/* 低电量：只有有效读数才允许 low=true（无效读数不能声称“电量低/不低”） */
int battery_low_mv(int valid, int mv, int low_mv);

/* 汇总判定：一个采样窗（最多 BATTERY_SAMPLE_COUNT 个 raw）-> battery_result_t。
 * read_ok=0 表示本次 ADC 读取失败（样本全不可信）。out 总是被完整写入。 */
void battery_evaluate(const int *raws, int count, int read_ok,
                      const battery_config_t *cfg, battery_result_t *out);

#endif /* BATTERY_LOGIC_H */
