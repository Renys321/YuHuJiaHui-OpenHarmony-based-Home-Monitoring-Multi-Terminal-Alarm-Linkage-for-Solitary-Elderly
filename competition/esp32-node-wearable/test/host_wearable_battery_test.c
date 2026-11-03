/* 主机侧单测：wearable 心跳帧的 battery 段（契约 BATTERY-CHAIN-CONTRACT.md §2）
 *
 * 只编译纯逻辑（wearable_logic.c + battery_logic.c），不依赖 ESP-IDF / 硬件：
 *   gcc -std=c99 -Wall -Wextra -I main -o test/host_wearable_battery.exe \
 *       test/host_wearable_battery_test.c main/wearable_logic.c main/battery_logic.c
 *
 * 覆盖：
 *   1) 旧签名 wb_build_hb（无电量）→ 帧里没有 battery 字段（旧协议完全不变）；
 *   2) wb_build_hb_ex 传 NULL → 与旧帧逐字节一致；
 *   3) 有效读数 → source/present/valid/mv/percent/low/calibrated/reason 全字段正确；
 *   4) 无效读数（未接电池/浮空）→ valid=false、mv=null、percent=null，绝不 0%；
 *   5) 未标定（calibrated=0）即使 percent>=0 也必须输出 null；
 *   6) 帧长不超过 WB_LINE_MAX_BYTES(512)，不会把下游 M100 透传打爆。
 */
#include <stdio.h>
#include <string.h>
#include "wearable_logic.h"
#include "battery_logic.h"

static int g_fail = 0;
static int g_pass = 0;
#define CHECK(cond, name) do { \
    if (cond) { g_pass++; } \
    else { g_fail++; printf("FAIL: %s (line %d)\n", name, __LINE__); } \
} while (0)

static int contains(const char *hay, const char *needle)
{
    return strstr(hay, needle) != NULL;
}

/* 与真实串口帧一致的构造参数 */
static int build_hb(char *out, size_t cap, const wb_battery_t *batt)
{
    return wb_build_hb_ex(out, cap, "esp32-sos", WB_STATE_IDLE, "", 12345, 23, batt);
}

int main(void)
{
    char frame[WB_LINE_MAX_BYTES + 1];
    char legacy[WB_LINE_MAX_BYTES + 1];
    char legacy_null[WB_LINE_MAX_BYTES + 1];
    int n;
    wb_battery_t batt;

    /* 1) 旧签名：无 battery 字段 */
    n = wb_build_hb(legacy, sizeof(legacy), "esp32-sos", WB_STATE_IDLE, "", 12345, 23);
    CHECK(n > 0, "legacy hb builds");
    CHECK(!contains(legacy, "battery"), "legacy hb has no battery field");
    CHECK(contains(legacy, "\"t\":\"hb\""), "legacy hb keeps frame type");
    CHECK(contains(legacy, "\"csq\":23"), "legacy hb keeps csq");

    /* 2) 新签名传 NULL：与旧帧完全一致（向后兼容） */
    n = build_hb(legacy_null, sizeof(legacy_null), NULL);
    CHECK(n > 0, "hb_ex(NULL) builds");
    CHECK(strcmp(legacy, legacy_null) == 0, "hb_ex(NULL) identical to legacy frame");

    /* 3) 有效读数：全字段正确 */
    memset(&batt, 0, sizeof(batt));
    batt.present = 1;
    batt.valid = 1;
    batt.mv = 3850;
    batt.percent = 65;
    batt.low = 0;
    batt.calibrated = 1;
    batt.reason = "";
    n = build_hb(frame, sizeof(frame), &batt);
    CHECK(n > 0, "valid battery hb builds");
    CHECK(contains(frame, "\"battery\":{\"source\":\"battery\""), "battery source is battery");
    CHECK(contains(frame, "\"present\":true"), "battery present=true");
    CHECK(contains(frame, "\"valid\":true"), "battery valid=true");
    CHECK(contains(frame, "\"mv\":3850"), "battery mv=3850");
    CHECK(contains(frame, "\"percent\":65"), "battery percent=65");
    CHECK(contains(frame, "\"low\":false"), "battery low=false");
    CHECK(contains(frame, "\"calibrated\":true"), "battery calibrated=true");
    CHECK(contains(frame, "\"reason\":\"\""), "battery reason empty");
    CHECK(n <= WB_LINE_MAX_BYTES, "frame within 512 bytes");

    /* 4) 低电量 */
    batt.mv = 3450;
    batt.percent = 15;
    batt.low = 1;
    n = build_hb(frame, sizeof(frame), &batt);
    CHECK(n > 0 && contains(frame, "\"low\":true"), "low battery low=true");
    CHECK(contains(frame, "\"mv\":3450"), "low battery mv=3450");

    /* 5) 无效读数（未接电池/浮空）：mv/percent=null、low=false，绝不 0% */
    memset(&batt, 0, sizeof(batt));
    batt.present = 0;
    batt.valid = 0;
    batt.mv = -1;
    batt.percent = -1;
    batt.low = 0;
    batt.calibrated = 0;
    batt.reason = "OUT_OF_RANGE";
    n = build_hb(frame, sizeof(frame), &batt);
    CHECK(n > 0, "invalid battery hb builds");
    CHECK(contains(frame, "\"present\":false"), "invalid battery present=false");
    CHECK(contains(frame, "\"valid\":false"), "invalid battery valid=false");
    CHECK(contains(frame, "\"mv\":null"), "invalid battery mv=null");
    CHECK(contains(frame, "\"percent\":null"), "invalid battery percent=null (never 0%)");
    CHECK(contains(frame, "\"low\":false"), "invalid battery low=false");
    CHECK(contains(frame, "\"reason\":\"OUT_OF_RANGE\""), "invalid battery reason kept");
    CHECK(!contains(frame, "\"percent\":0"), "invalid battery never 0 percent");
    CHECK(!contains(frame, "\"mv\":0"), "invalid battery never 0 mv");

    /* 6) 未标定：即使上层误传 percent，也必须输出 null（不冒充精确电量） */
    batt.present = 1;
    batt.valid = 1;
    batt.mv = 3850;
    batt.percent = 65;
    batt.calibrated = 0;
    batt.reason = "";
    n = build_hb(frame, sizeof(frame), &batt);
    CHECK(n > 0, "uncalibrated hb builds");
    CHECK(contains(frame, "\"mv\":3850"), "uncalibrated keeps mv");
    CHECK(contains(frame, "\"percent\":null"), "uncalibrated percent forced to null");
    CHECK(contains(frame, "\"calibrated\":false"), "uncalibrated calibrated=false");

    /* 7) 超长设备名/告警 ID 下的长度保护：仍不超过 512 或明确失败（-1） */
    {
        char big_dev[80];
        memset(big_dev, 'd', sizeof(big_dev));
        big_dev[sizeof(big_dev) - 1] = '\0';
        batt.calibrated = 1;
        batt.percent = 50;
        n = wb_build_hb_ex(frame, sizeof(frame), big_dev, WB_STATE_ALARM,
                           "e-u01234567-99", 999999, 99, &batt);
        CHECK(n <= WB_LINE_MAX_BYTES, "long frame still bounded by 512");
    }

    /* 8) 与共享 battery_logic 的联动：8 样本 3850mV 且标定 -> 65%（契约 OCV 表） */
    {
        battery_config_t cfg;
        battery_result_t r;
        int raws[8];
        battery_config_default(&cfg);
        cfg.calibrated = 1;
        for (int i = 0; i < 8; i++) raws[i] = 2543;   /* 1925mV 引脚 -> 3850mV 电池 */
        battery_evaluate(raws, 8, 1, &cfg, &r);
        CHECK(r.valid == 1 && r.mv == 3850, "shared logic: 8x2543 raw -> 3850mV");
        CHECK(r.percent == 65, "shared logic: calibrated 3850mV -> 65%");
        batt.present = r.valid;
        batt.valid = r.valid;
        batt.mv = r.mv;
        batt.percent = r.percent;
        batt.low = r.low;
        batt.calibrated = cfg.calibrated;
        batt.reason = r.reason;
        n = build_hb(frame, sizeof(frame), &batt);
        CHECK(n > 0 && contains(frame, "\"mv\":3850") && contains(frame, "\"percent\":65"),
              "hb reflects shared battery_logic result");
    }

    printf("PASS=%d FAIL=%d\n", g_pass, g_fail);
    return g_fail ? 1 : 0;
}
