/*
 * time_util_test.c — time_util.h 的纯逻辑单测（PC 运行，不碰硬件）
 * 构建：见 southbound/build-host-test.ps1 或 README 中的 gcc 命令行
 */
#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include "time_util.h"

static int g_pass = 0;
static int g_fail = 0;

#define CHECK(cond, name) do { \
    if (cond) { g_pass++; printf("  ok   %s\n", (name)); } \
    else { g_fail++; printf("  FAIL %s\n", (name)); } \
} while (0)

/* 2026-10-15T10:37:08.021Z 与 2017-08-04T11:03:00Z 两组真实采样值 */
#define SAMPLE_2026_MS 1792060628021LL
#define SAMPLE_2017_MS 1501844580000LL

static void check_utc(int64_t ms, int64_t y, int mo, int d, int h, int mi, int s, const char *name)
{
    int64_t gy; int gmo, gd, gh, gmi, gs;
    tu_ms_to_utc(ms, &gy, &gmo, &gd, &gh, &gmi, &gs);
    char buf[128];
    snprintf(buf, sizeof(buf), "%s -> %04lld-%02d-%02dT%02d:%02d:%02dZ",
             name, (long long)gy, gmo, gd, gh, gmi, gs);
    CHECK(gy == y && gmo == mo && gd == d && gh == h && gmi == mi && gs == s, buf);
}

int main(void)
{
    printf("time_util selftest: sizeof(long)=%u sizeof(int64_t)=%u\n",
           (unsigned)sizeof(long), (unsigned)sizeof(int64_t));

    /* 1) 秒 -> 毫秒的 64 位正确性（32 位目标上不得溢出） */
    CHECK(tu_sec_to_ms(1792060628LL) == 1792060628000LL, "sec->ms 2026 不溢出");
    CHECK(tu_sec_to_ms(4102444800LL) == 4102444800000LL, "sec->ms 2100 边界不溢出");
    CHECK(tu_sec_to_ms(1501844580LL) == 1501844580000LL, "sec->ms 2017 换算正确");
    CHECK(tu_abs_diff_ms(SAMPLE_2026_MS, SAMPLE_2017_MS) == 290216048021LL, "64 位差值正确");

    /* 2) 2017 年必须被判为不可信 */
    CHECK(!tu_epoch_ms_trusted(SAMPLE_2017_MS), "2017 毫秒判为不可信");
    CHECK(!tu_epoch_ms_trusted(tu_sec_to_ms(1501844580LL)), "2017 秒归一化后仍不可信");
    CHECK(!tu_epoch_ms_trusted(0), "epoch=0 不可信");
    CHECK(!tu_epoch_ms_trusted(-1), "负 epoch 不可信");

    /* 3) 2026 年有效 epoch 必须被接受 */
    CHECK(tu_epoch_ms_trusted(SAMPLE_2026_MS), "2026 毫秒判为可信");
    CHECK(tu_epoch_ms_trusted(TU_TRUST_FLOOR_MS), "可信下界闭区间");
    CHECK(tu_epoch_ms_trusted(TU_TRUST_CEIL_MS), "可信上界闭区间");
    CHECK(!tu_epoch_ms_trusted(TU_TRUST_FLOOR_MS - 1), "下界之前不可信");
    CHECK(!tu_epoch_ms_trusted(TU_TRUST_CEIL_MS + 1), "上界之后不可信");

    /* 4) 秒 / 毫秒不得混淆 */
    CHECK(tu_looks_like_seconds(1792060628LL), "10 位识别为秒");
    CHECK(!tu_looks_like_seconds(1792060628021LL), "13 位识别为毫秒");
    CHECK(tu_normalize_epoch_ms(1792060628LL) == SAMPLE_2026_MS - 21, "秒归一化到毫秒");
    CHECK(tu_normalize_epoch_ms(SAMPLE_2026_MS) == SAMPLE_2026_MS, "毫秒保持不变");
    CHECK(tu_normalize_epoch_ms(0) == 0, "0 不换算、保持 0");
    CHECK(!tu_epoch_ms_trusted(tu_normalize_epoch_ms(SAMPLE_2017_MS)) &&
          !tu_epoch_ms_trusted(tu_normalize_epoch_ms(1501844580LL)),
          "两种形态的 2017 值都不会被误判为可信");

    /* 5) UTC 不得重复加 8 小时（本地时区 = Asia/Shanghai） */
    check_utc(SAMPLE_2026_MS, 2026, 10, 15, 10, 37, 8, "2026-10-15T10:37:08Z");
    check_utc(SAMPLE_2017_MS, 2017, 8, 4, 11, 3, 0, "2017-08-04T11:03:00Z");
    check_utc(0, 1970, 1, 1, 0, 0, 0, "epoch 0 = 1970-01-01T00:00:00Z");
    check_utc(1735689600000LL, 2025, 1, 1, 0, 0, 0, "可信下界 = 2025-01-01T00:00:00Z");
    {
        int64_t y; int mo, d, h, mi, s;
        tu_ms_to_utc(SAMPLE_2026_MS, &y, &mo, &d, &h, &mi, &s);
        CHECK(h == 10 && h != 18, "小时数未被 +8 污染");
    }

    printf("time_util selftest: PASS=%d FAIL=%d\n", g_pass, g_fail);
    return g_fail == 0 ? 0 : 1;
}
