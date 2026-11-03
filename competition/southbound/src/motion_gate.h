/*
 * motion_gate.h — 活动监测“能力 / 有效性 / 无观测时间”纯逻辑（无系统依赖，可单测）
 *
 * 背景（2026-10-27 客厅 NO_MOTION 误报根因，见
 * competition/evidence/2026-10-27-reconnect-dayu-sos/homemon-nomotion/）：
 *   homemon 原先无条件用 idle = now - last_motion_ms 判定 NO_MOTION；
 *   客厅没有 PIR（motion_cnt==0，配置里也没有 motion_gpio）时，
 *   last_motion_ms 只在启动时喂一次值，超过 no_motion_sec(1800s) 后
 *   必然产生一条 NO_MOTION(= "长时间未检测到人体活动")。
 *   “没有 PIR 数据”不是“没有活动”：没有任何活动观测能力的设备，
 *   不得声称长时间无活动，也不得因“无数据”进入 WARN。
 *
 * 规则（生产代码与 PC 单测共用）：
 *   1) monitor_enabled = 配置了 PIR 路数 > 0 且启动自检至少一路 GPIO 可读；
 *   2) 判定（NO_MOTION / 活动间隔 WARN）仅在 monitor_enabled 且本 tick
 *      至少一路有有效读数时允许；
 *   3) 无有效读数的时间不计入 idle（暂停计时），恢复后不会因“盲区”立刻告警；
 *   4) 系统时钟跳变（RTC 掉电回退 / PC 网关校时）时整体平移历史时间戳，
 *      避免“9 年 idle”之类的假无活动。
 */
#ifndef MOTION_GATE_H
#define MOTION_GATE_H

#include <stdint.h>

/* 本机是否具备活动监测能力：配置了 PIR 且至少一路 GPIO 已被确认可读。 */
static inline int mg_monitor_enabled(int configured_cnt, int usable_cnt)
{
    return configured_cnt > 0 && usable_cnt > 0;
}

/* 本 tick 是否允许做“长时间无活动 / 活动间隔”判定。
   无能力（无 PIR）或无有效数据（读取失败）时一律不判定：
   缺失数据不能被解释成“无人活动”。 */
static inline int mg_judge_allowed(int monitor_enabled, int readable_now)
{
    return monitor_enabled && readable_now > 0;
}

/* 时钟跳变判定：相对上一 tick 的增量异常。
   正常 tick 约 tick_ms；回退（负增量）或前进超过 tick_ms + 5s 视为跳变。 */
static inline int mg_clock_jumped(int64_t delta_ms, int64_t tick_ms)
{
    if (delta_ms < 0) return 1;
    if (delta_ms > tick_ms + 5000) return 1;
    return 0;
}

/* 跳变时把历史时间戳整体平移 delta，保持“已经过去多久”的语义不变。
   0 表示“从未发生”，保持 0（不能加 delta 变成假时间）。 */
static inline int64_t mg_resync_ms(int64_t stamp_ms, int64_t delta_ms)
{
    return stamp_ms > 0 ? stamp_ms + delta_ms : 0;
}

/* 本 tick 没有有效 PIR 数据：把活动基准前移 delta，等价于暂停 idle 计时。
   只在 monitor_enabled 的设备上使用；无 PIR 设备根本不做判定。 */
static inline int64_t mg_pause_idle_ms(int64_t last_motion_ms, int64_t delta_ms)
{
    return last_motion_ms > 0 ? last_motion_ms + delta_ms : 0;
}

/* 上报用的能力/数据原因词：固定 ASCII 枚举，便于 APP 与排障同时消费。 */
static inline const char *mg_reason(int configured_cnt, int usable_cnt,
                                    int readable_now)
{
    if (configured_cnt <= 0) return "not_configured";
    if (usable_cnt <= 0) return "gpio_unavailable";
    if (readable_now <= 0) return "no_data";
    return "ok";
}

#endif /* MOTION_GATE_H */
