/*
 * judge_logic.h — homemon 判定段（基础阈值算法）的纯逻辑（无系统依赖，可单测）
 *
 * 与原来写在 main() 循环里的 if/else 链**逐分支等价**，只是抽成纯函数，
 * 让“优先级 + 门控”能被 PC 单测直接覆盖，而不是只能靠读代码。
 *
 * 优先级（沿用既有实现，未改变）：
 *   GAS > SMOKE > MANUAL_SOS > NO_MOTION > 温湿度越界(WARN) > 活动间隔(WARN)
 *
 * 门控（2026-10-27 修复）：
 *   NO_MOTION 与“活动间隔 WARN”只有在 motion_judge_allowed=1 时才可能返回；
 *   无 PIR / 无有效读数时，即使 idle 再大也不产生 NO_MOTION、不进入 WARN。
 */
#ifndef JUDGE_LOGIC_H
#define JUDGE_LOGIC_H

#include <stdint.h>
#include <string.h>

/* 一次判定的结果；枚举顺序即优先级（数值越小越先）。 */
typedef enum {
    JG_NONE = 0,        /* 无动作 */
    JG_RAISE_GAS,       /* 燃气泄漏（最高） */
    JG_RAISE_SMOKE,     /* 烟雾 */
    JG_RAISE_SOS,       /* 主动求助 */
    JG_RAISE_NO_MOTION, /* 长时间无活动；仅 motion_judge_allowed 时可能返回 */
    JG_CLIMATE_WARN,    /* 温湿度越界 → WARN */
    JG_IDLE_WARN        /* 活动间隔达 warn_ratio → WARN；仅 motion_judge_allowed 时 */
} jg_action_t;

typedef struct {
    int gas_ok;                  /* 0 = 燃气超限 */
    int smoke_ok;                /* 0 = 烟雾超限 */
    int sos_pressed;             /* 1 = 求助按钮已消抖确认 */
    int motion_judge_allowed;    /* 见 motion_gate.h: mg_judge_allowed() */
    int64_t idle_ms;             /* now - 最近活动（有 PIR 时才有意义） */
    int64_t no_motion_limit_ms;  /* no_motion_sec * 1000 */
    int64_t warn_at_ms;          /* limit * warn_ratio / 100 */
    int climate_ok;              /* 0 = 温湿度超出舒适区间 */
    int state_is_alarm;          /* state == ALARM */
    int state_is_normal;         /* state == NORMAL */
    const char *alarm_type;      /* 当前告警类型；无告警传 ""（不能传 NULL） */
} jg_input_t;

/*
 * 判定本 tick 该做什么。
 * 与旧实现一致：某个更高优先级的“危险”成立时，不再继续看后面的分支；
 * 同类危险已经处于同一类型告警中时不重复 raise（返回 JG_NONE）。
 */
static inline jg_action_t judge_decide(const jg_input_t *in)
{
    if (in == 0 || in->alarm_type == 0) return JG_NONE;

    if (!in->gas_ok) {
        /* 旧实现：`if (strcmp(g_rt.alarm_type, "GAS")) alarm_raise(...)` */
        return strcmp(in->alarm_type, "GAS") != 0 ? JG_RAISE_GAS : JG_NONE;
    }
    if (!in->smoke_ok) {
        return strcmp(in->alarm_type, "SMOKE") != 0 ? JG_RAISE_SMOKE : JG_NONE;
    }
    if (in->sos_pressed) {
        if (!in->state_is_alarm || strcmp(in->alarm_type, "MANUAL_SOS") != 0) {
            return JG_RAISE_SOS;
        }
        return JG_NONE;
    }
    /* ⚠ 2026-10-27 修复点：无 PIR / 无有效读数时绝不走这两条分支 */
    if (in->motion_judge_allowed && in->idle_ms >= in->no_motion_limit_ms) {
        if (!in->state_is_alarm || strcmp(in->alarm_type, "NO_MOTION") != 0) {
            return JG_RAISE_NO_MOTION;
        }
        return JG_NONE;
    }
    if (!in->climate_ok) {
        return in->state_is_normal ? JG_CLIMATE_WARN : JG_NONE;
    }
    if (in->motion_judge_allowed && in->idle_ms >= in->warn_at_ms &&
        in->state_is_normal) {
        return JG_IDLE_WARN;
    }
    return JG_NONE;
}

#endif /* JUDGE_LOGIC_H */
