/*
 * motion_gate_test.c — motion_gate.h 的纯逻辑单测（PC 运行，不碰硬件）
 *
 * 覆盖 2026-10-27 客厅 NO_MOTION 误报修复的核心约定：
 *   motion_cnt=0（无 PIR）时，无论启动、超阈值、时钟跳变、重启，
 *   都**永不**满足 NO_MOTION / 活动间隔 WARN 的判定条件。
 * 构建：southbound/build-host-test.ps1
 */
#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include "motion_gate.h"

static int g_pass = 0;
static int g_fail = 0;

#define CHECK(cond, name) do { \
    if (cond) { g_pass++; printf("  ok   %s\n", (name)); } \
    else { g_fail++; printf("  FAIL %s\n", (name)); } \
} while (0)

#define NO_MOTION_SEC 1800
#define LIMIT_MS      ((int64_t)NO_MOTION_SEC * 1000)
#define WARN_RATIO    60
#define WARN_AT_MS    (LIMIT_MS * WARN_RATIO / 100)

/* 模拟主循环对“是否可判定”的计算，返回是否满足 NO_MOTION 条件 */
static int no_motion_fires(int configured, int usable, int readable_now,
                           int64_t idle_ms)
{
    int enabled = mg_monitor_enabled(configured, usable);
    int allowed = mg_judge_allowed(enabled, readable_now);
    return allowed && idle_ms >= LIMIT_MS;
}

/* 模拟主循环对“是否满足活动间隔 WARN”的计算 */
static int idle_warn_fires(int configured, int usable, int readable_now,
                           int64_t idle_ms)
{
    int enabled = mg_monitor_enabled(configured, usable);
    int allowed = mg_judge_allowed(enabled, readable_now);
    return allowed && idle_ms >= WARN_AT_MS;
}

int main(void)
{
    printf("motion_gate_test: sizeof(int64_t)=%u\n", (unsigned)sizeof(int64_t));

    /* ---------------- 1) 能力判定：没有 PIR 就没有“活动监测” ---------------- */
    CHECK(mg_monitor_enabled(0, 0) == 0, "motion_cnt=0 → 无活动监测能力");
    CHECK(mg_monitor_enabled(0, 2) == 0, "未配置(0)即使号称可读 2 路也不启用");
    CHECK(mg_monitor_enabled(2, 0) == 0, "配置了 2 路但 0 路可读 → 不启用(NO_MOTION 关闭)");
    CHECK(mg_monitor_enabled(2, 1) == 1, "配置 2 路、1 路可读 → 启用");
    CHECK(mg_monitor_enabled(1, 1) == 1, "配置 1 路、可读 → 启用");

    /* ---------------- 2) 判定门控：无数据 ≠ 无活动 ---------------- */
    CHECK(mg_judge_allowed(0, 0) == 0, "无能力 → 不判定");
    CHECK(mg_judge_allowed(0, 1) == 0, "无能力 → 即使有读数也不判定");
    CHECK(mg_judge_allowed(1, 0) == 0, "有 PIR 但本 tick 无有效读数 → 不判定");
    CHECK(mg_judge_allowed(1, 1) == 1, "有 PIR 且有读数 → 允许判定");
    CHECK(mg_judge_allowed(1, 2) == 1, "两路都有读数 → 允许判定");

    /* ---------------- 3) motion_cnt=0：超阈值也永不 NO_MOTION / WARN ---------------- */
    CHECK(no_motion_fires(0, 0, 0, LIMIT_MS) == 0, "无 PIR：idle 恰达 1800s 不产生 NO_MOTION");
    CHECK(no_motion_fires(0, 0, 0, LIMIT_MS * 10) == 0, "无 PIR：idle=5h 不产生 NO_MOTION");
    CHECK(no_motion_fires(0, 0, 0, (int64_t)9 * 365 * 86400 * 1000) == 0,
          "无 PIR：idle=9 年（时钟跳变量级）不产生 NO_MOTION");
    CHECK(no_motion_fires(0, 0, 0, INT64_MAX) == 0, "无 PIR：idle=INT64_MAX 不产生 NO_MOTION");
    CHECK(idle_warn_fires(0, 0, 0, LIMIT_MS) == 0, "无 PIR：idle 再大也不进活动间隔 WARN");
    CHECK(idle_warn_fires(0, 0, 0, WARN_AT_MS) == 0, "无 PIR：WARN 阈值处也不进 WARN");
    /* 配了 PIR 键但 GPIO 不可用（-1 或导出失败）：同样不判定 */
    CHECK(no_motion_fires(2, 0, 0, LIMIT_MS * 3) == 0,
          "PIR 配置了但 GPIO 全部不可读 → 不产生 NO_MOTION");

    /* ---------------- 4) motion_cnt>0：1800s 仍按既有阈值触发 ---------------- */
    CHECK(no_motion_fires(1, 1, 1, LIMIT_MS - 1) == 0, "有 PIR：1799.999s 不触发");
    CHECK(no_motion_fires(1, 1, 1, LIMIT_MS) == 1, "有 PIR：恰 1800s 触发 NO_MOTION");
    CHECK(no_motion_fires(1, 1, 1, LIMIT_MS + 1) == 1, "有 PIR：1800.001s 触发");
    CHECK(idle_warn_fires(1, 1, 1, WARN_AT_MS - 1) == 0, "有 PIR：WARN 阈值前 1ms 不 WARN");
    CHECK(idle_warn_fires(1, 1, 1, WARN_AT_MS) == 1, "有 PIR：60% 阈值触发 WARN");
    /* 活动恢复：last_motion 被更新后 idle 回到 0 附近 → 不再触发 */
    CHECK(no_motion_fires(1, 1, 1, 0) == 0 && idle_warn_fires(1, 1, 1, 0) == 0,
          "有 PIR：活动恢复后 idle≈0，不触发 NO_MOTION/WARN");

    /* ---------------- 5) 无有效读数的 tick 不判定（即使 idle 超阈值） ---------------- */
    CHECK(no_motion_fires(1, 1, 0, LIMIT_MS * 2) == 0,
          "有 PIR 但本 tick 读取失败 → 不判定（无数据≠无活动）");
    CHECK(idle_warn_fires(1, 1, 0, LIMIT_MS) == 0,
          "有 PIR 但本 tick 读取失败 → 不因活动间隔 WARN");

    /* ---------------- 6) 刚启动 / 重启：首帧无采样前不判定 ---------------- */
    /* 启动时 last_motion 由 main 初始化：有 PIR → now；无 PIR → 0。
       首帧采样完成前 readable_now=0，因此即使初始化异常也不会误报。 */
    CHECK(no_motion_fires(0, 0, 0, 0) == 0, "无 PIR 刚启动：不产生 NO_MOTION");
    CHECK(no_motion_fires(1, 1, 0, 0) == 0, "有 PIR 刚启动未采样：不产生 NO_MOTION");
    /* 重启语义：init 后 last_motion=now → idle=0 */
    CHECK(no_motion_fires(1, 1, 1, 0) == 0, "有 PIR 重启后 idle 从 0 起算，不立即告警");

    /* ---------------- 7) 时钟跳变 ---------------- */
    CHECK(mg_clock_jumped(1000, 1000) == 0, "正常 1s tick 不算跳变");
    CHECK(mg_clock_jumped(3000, 1000) == 0, "慢 tick 3s 不算跳变");
    CHECK(mg_clock_jumped(6000, 1000) == 0, "tick+5s 边界不算跳变");
    CHECK(mg_clock_jumped(6001, 1000) == 1, "超过 tick+5s 判为跳变");
    CHECK(mg_clock_jumped(-1, 1000) == 1, "时间回退 1ms 判为跳变");
    CHECK(mg_clock_jumped((int64_t)9 * 365 * 86400 * 1000, 1000) == 1,
          "2017→2026 校时（9 年）判为跳变");
    CHECK(mg_clock_jumped(8 * 3600 * 1000, 1000) == 1, "8 小时校时判为跳变");

    /* 跳变时整体平移历史时间戳：idle 语义保持不变 */
    {
        int64_t jump = (int64_t)9 * 365 * 86400 * 1000;
        int64_t last = 1501844580000LL;          /* 2017 时间戳 */
        int64_t now0 = last + 120000;            /* 已过去 120s */
        int64_t last2 = mg_resync_ms(last, jump);
        int64_t now2 = now0 + jump;
        CHECK(last2 == last + jump, "跳变后 last_motion 平移到新时钟");
        CHECK(now2 - last2 == 120000, "跳变前后 idle 不变（120s）");
        CHECK(!(mg_clock_jumped(0, 1000)) && mg_resync_ms(0, jump) == 0,
              "“从未活动”(0) 平移后仍是 0");
    }

    /* ---------------- 8) 盲区暂停 idle 计时 ---------------- */
    {
        int64_t last = 1792000000000LL;
        CHECK(mg_pause_idle_ms(last, 1000) == last + 1000, "无数据 tick：idle 基准前移，暂停计时");
        CHECK(mg_pause_idle_ms(0, 1000) == 0, "从未活动：暂停仍保持 0");
        /* 连续 100 个 tick 无数据 → 基准前移 100s，恢复后不会立刻超阈值 */
        int64_t base = last;
        for (int i = 0; i < 100; i++) base = mg_pause_idle_ms(base, 1000);
        CHECK(base - last == 100000, "100 个盲区 tick 不累计为 idle");
        CHECK(no_motion_fires(1, 1, 1, 0) == 0, "盲区恢复后 idle 从 0 继续，不立即告警");
    }

    /* ---------------- 9) 上报原因词 ---------------- */
    CHECK(mg_reason(0, 0, 0) != 0 && !strcmp(mg_reason(0, 0, 0), "not_configured"),
          "reason: 未配置");
    CHECK(!strcmp(mg_reason(2, 0, 0), "gpio_unavailable"), "reason: GPIO 不可用");
    CHECK(!strcmp(mg_reason(2, 1, 0), "no_data"), "reason: 本次无有效数据");
    CHECK(!strcmp(mg_reason(2, 1, 1), "ok"), "reason: 正常");
    CHECK(!strcmp(mg_reason(0, 2, 1), "not_configured"),
          "reason: 未配置优先于其它状态（不虚报能力）");

    /* ---------------- 10) 组合回归：无 PIR 的设备在任意时间条件下都不告警 ---------------- */
    {
        const int64_t samples[] = {
            0, 1, 1000, WARN_AT_MS, LIMIT_MS, LIMIT_MS + 1,
            (int64_t)86400 * 1000, (int64_t)9 * 365 * 86400 * 1000,
            INT64_MAX, -1000, -INT64_MAX
        };
        int all_ok = 1;
        for (size_t i = 0; i < sizeof(samples) / sizeof(samples[0]); i++) {
            if (no_motion_fires(0, 0, 0, samples[i])) all_ok = 0;
            if (idle_warn_fires(0, 0, 0, samples[i])) all_ok = 0;
            /* 即使被伪造成“可读”，无能力也不判定 */
            if (no_motion_fires(0, 3, 3, samples[i])) all_ok = 0;
            if (idle_warn_fires(0, 3, 3, samples[i])) all_ok = 0;
        }
        CHECK(all_ok, "无 PIR：启动/超阈值/时钟跳变/负 idle 全组合均不产生 NO_MOTION/WARN");
    }

    printf("motion_gate_test: PASS=%d FAIL=%d\n", g_pass, g_fail);
    return g_fail == 0 ? 0 : 1;
}
