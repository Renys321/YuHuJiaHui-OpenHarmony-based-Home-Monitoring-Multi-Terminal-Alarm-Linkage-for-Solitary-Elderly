/*
 * judge_logic_test.c — judge_logic.h 的纯逻辑单测（PC 运行，不碰硬件）
 *
 * 目的：把 homemon 判定段的“优先级 + 无 PIR 门控”固定下来，
 * 证明 2026-10-27 的修改没有改变 GAS>SMOKE>SOS>NO_MOTION>CLIMATE>IDLE 的既有优先级。
 * 构建：southbound/build-host-test.ps1
 */
#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include "judge_logic.h"

static int g_pass = 0;
static int g_fail = 0;

#define CHECK(cond, name) do { \
    if (cond) { g_pass++; printf("  ok   %s\n", (name)); } \
    else { g_fail++; printf("  FAIL %s\n", (name)); } \
} while (0)

#define LIMIT_MS ((int64_t)1800 * 1000)
#define WARN_MS  (LIMIT_MS * 60 / 100)

/* 默认输入：一切正常、NORMAL、有 PIR 能力与数据但刚活动过 */
static jg_input_t base_input(void)
{
    jg_input_t in;
    memset(&in, 0, sizeof(in));
    in.gas_ok = 1;
    in.smoke_ok = 1;
    in.sos_pressed = 0;
    in.motion_judge_allowed = 1;
    in.idle_ms = 0;
    in.no_motion_limit_ms = LIMIT_MS;
    in.warn_at_ms = WARN_MS;
    in.climate_ok = 1;
    in.state_is_alarm = 0;
    in.state_is_normal = 1;
    in.alarm_type = "";
    return in;
}

static jg_action_t decide(jg_input_t *in) { return judge_decide(in); }

int main(void)
{
    jg_input_t in;

    /* ---------------- 1) 无 PIR（motion_judge_allowed=0）：永不 NO_MOTION ---------------- */
    in = base_input();
    in.motion_judge_allowed = 0;
    in.idle_ms = LIMIT_MS;
    CHECK(decide(&in) == JG_NONE, "无 PIR：idle 恰 1800s → 不产生 NO_MOTION");
    in.idle_ms = LIMIT_MS * 100;
    CHECK(decide(&in) == JG_NONE, "无 PIR：idle 100 倍阈值 → 不产生 NO_MOTION");
    in.idle_ms = INT64_MAX;
    CHECK(decide(&in) == JG_NONE, "无 PIR：idle=INT64_MAX → 不产生 NO_MOTION");
    in.idle_ms = LIMIT_MS;
    CHECK(decide(&in) != JG_IDLE_WARN, "无 PIR：不进入活动间隔 WARN");

    /* 无 PIR 但有真实其它症状时，其它分支必须照常工作 */
    in = base_input();
    in.motion_judge_allowed = 0;
    in.idle_ms = LIMIT_MS * 10;
    in.gas_ok = 0;
    CHECK(decide(&in) == JG_RAISE_GAS, "无 PIR 不影响燃气告警");
    in.gas_ok = 1;
    in.smoke_ok = 0;
    CHECK(decide(&in) == JG_RAISE_SMOKE, "无 PIR 不影响烟雾告警");
    in.smoke_ok = 1;
    in.sos_pressed = 1;
    CHECK(decide(&in) == JG_RAISE_SOS, "无 PIR 不影响 SOS 求助");
    in.sos_pressed = 0;
    in.climate_ok = 0;
    CHECK(decide(&in) == JG_CLIMATE_WARN, "无 PIR 时温湿度越界仍照常 WARN（不因无 PIR 被吞）");

    /* ---------------- 2) 有 PIR：1800s 仍触发 ---------------- */
    in = base_input();
    in.idle_ms = LIMIT_MS - 1;
    /* 未到 NO_MOTION，但已过 warn_ratio(60%) → 仍是活动间隔 WARN（旧实现如此） */
    CHECK(decide(&in) == JG_IDLE_WARN, "有 PIR：1799.999s 未触发 NO_MOTION（仍在 WARN 区间）");
    in.idle_ms = LIMIT_MS;
    CHECK(decide(&in) == JG_RAISE_NO_MOTION, "有 PIR：1800s 触发 NO_MOTION");
    in.idle_ms = LIMIT_MS + 1;
    CHECK(decide(&in) == JG_RAISE_NO_MOTION, "有 PIR：1800.001s 触发 NO_MOTION");

    /* 已处于同类 NO_MOTION 告警时不重复 raise（沿用旧实现） */
    in = base_input();
    in.idle_ms = LIMIT_MS * 2;
    in.state_is_alarm = 1;
    in.state_is_normal = 0;
    in.alarm_type = "NO_MOTION";
    CHECK(decide(&in) == JG_NONE, "已处于 NO_MOTION 告警：不重复 raise");
    /* 但当前是别的告警类型时，NO_MOTION 分支仍会被 raise（旧实现如此） */
    in.alarm_type = "CLIMATE";
    CHECK(decide(&in) == JG_RAISE_NO_MOTION, "旧语义保持：其它类型告警中仍会 raise NO_MOTION");

    /* ---------------- 3) 活动间隔 WARN ---------------- */
    in = base_input();
    in.idle_ms = WARN_MS - 1;
    CHECK(decide(&in) == JG_NONE, "有 PIR：WARN 阈值前不 WARN");
    in.idle_ms = WARN_MS;
    CHECK(decide(&in) == JG_IDLE_WARN, "有 PIR：60% 阈值 → 活动间隔 WARN");
    in.idle_ms = LIMIT_MS - 1;
    CHECK(decide(&in) == JG_IDLE_WARN, "有 PIR：未到 1800s 仍在 WARN 区间");
    in.state_is_normal = 0;
    in.state_is_alarm = 1;
    in.alarm_type = "MANUAL_SOS";
    CHECK(decide(&in) == JG_NONE, "非 NORMAL 状态不再进活动间隔 WARN");

    /* ---------------- 4) 温湿度 WARN ---------------- */
    in = base_input();
    in.climate_ok = 0;
    CHECK(decide(&in) == JG_CLIMATE_WARN, "温湿度越界 + NORMAL → CLIMATE WARN");
    in.state_is_normal = 0;
    in.state_is_alarm = 1;
    in.alarm_type = "SMOKE";
    CHECK(decide(&in) == JG_NONE, "告警态下不再因温湿度 WARN");
    in = base_input();
    in.climate_ok = 0;
    in.idle_ms = WARN_MS;
    CHECK(decide(&in) == JG_CLIMATE_WARN, "温湿度越界优先于活动间隔 WARN");

    /* ---------------- 5) 优先级（沿用旧实现，不许回归） ---------------- */
    in = base_input();
    in.gas_ok = 0;
    in.smoke_ok = 0;
    in.sos_pressed = 1;
    in.idle_ms = LIMIT_MS;
    in.climate_ok = 0;
    CHECK(decide(&in) == JG_RAISE_GAS, "优先级：GAS > SMOKE/SOS/NO_MOTION/CLIMATE");
    in.gas_ok = 1;
    CHECK(decide(&in) == JG_RAISE_SMOKE, "优先级：SMOKE > SOS/NO_MOTION/CLIMATE");
    in.smoke_ok = 1;
    CHECK(decide(&in) == JG_RAISE_SOS, "优先级：SOS > NO_MOTION/CLIMATE");
    in.sos_pressed = 0;
    CHECK(decide(&in) == JG_RAISE_NO_MOTION, "优先级：NO_MOTION > CLIMATE WARN");
    in.motion_judge_allowed = 0;
    CHECK(decide(&in) == JG_CLIMATE_WARN, "无 PIR 时 NO_MOTION 退位，CLIMATE WARN 正常");

    /* 同类危险不重复 raise（沿用旧实现：gas 超限且当前已是 GAS → NONE） */
    in = base_input();
    in.gas_ok = 0;
    in.state_is_alarm = 1;
    in.state_is_normal = 0;
    in.alarm_type = "GAS";
    CHECK(decide(&in) == JG_NONE, "已处于 GAS 告警：不重复 raise");
    in.alarm_type = "SMOKE";
    CHECK(decide(&in) == JG_RAISE_GAS, "已有其它告警时 GAS 仍优先 raise");

    /* SOS 已确认后按住不放 → 重新 raise（旧实现如此，恢复需消抖） */
    in = base_input();
    in.sos_pressed = 1;
    in.state_is_alarm = 0;
    in.state_is_normal = 0;       /* ACKED */
    in.alarm_type = "MANUAL_SOS";
    CHECK(decide(&in) == JG_RAISE_SOS, "ACKED 后按钮仍按住 → 重新 raise（旧语义保持）");

    /* 负 idle（时钟回退但未及 resync）不得触发 */
    in = base_input();
    in.idle_ms = -5000;
    CHECK(decide(&in) == JG_NONE, "负 idle 不触发任何活动判定");

    /* 非法/缺省输入安全 */
    CHECK(judge_decide(0) == JG_NONE, "NULL 输入返回 NONE");
    in = base_input();
    in.alarm_type = 0;
    CHECK(judge_decide(&in) == JG_NONE, "缺省 alarm_type 返回 NONE");

    printf("judge_logic_test: PASS=%d FAIL=%d\n", g_pass, g_fail);
    return g_fail == 0 ? 0 : 1;
}
