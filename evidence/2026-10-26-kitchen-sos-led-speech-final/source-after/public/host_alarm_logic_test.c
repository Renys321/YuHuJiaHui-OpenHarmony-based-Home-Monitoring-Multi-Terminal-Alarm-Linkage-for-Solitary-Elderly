/* 主机侧单测：只编译 alarm_logic.h（不依赖 ESP-IDF / 硬件） */
#include <stdio.h>
#include <string.h>
#include "alarm_logic.h"

static int g_fail = 0;
static int g_pass = 0;
#define CHECK(cond, name) do { \
    if (cond) { g_pass++; } \
    else { g_fail++; printf("FAIL: %s (line %d)\n", name, __LINE__); } \
} while (0)

static void test_ack(void)
{
    alarm_sm_t sm;
    alarm_sm_init(&sm);
    CHECK(alarm_sm_raise(&sm, "GAS", "e-1") == 1, "raise gas");
    CHECK(sm.state == ALARM_STATE_ALARM, "state alarm");
    CHECK(sm.buzzer == 1, "buzzer on at alarm");
    CHECK(alarm_sm_ack(&sm, "e-wrong") == 0, "wrong ack rejected");
    CHECK(sm.state == ALARM_STATE_ALARM, "wrong ack keeps state");
    CHECK(sm.buzzer == 1, "wrong ack keeps buzzer");
    CHECK(alarm_sm_ack(&sm, "e-1") == 1, "correct ack accepted");
    CHECK(sm.state == ALARM_STATE_ACKED, "state acked");
    CHECK(sm.buzzer == 0, "ack silences immediately");
    CHECK(strcmp(sm.id, "e-1") == 0 && strcmp(sm.type, "GAS") == 0, "ack keeps id/type");
    CHECK(alarm_sm_ack(&sm, "e-1") == 0, "second ack rejected (not ALARM)");
    CHECK(alarm_sm_raise(&sm, "GAS", "e-2") == 0, "same danger while acked -> no new id");
    CHECK(sm.state == ALARM_STATE_ACKED && sm.buzzer == 0, "acked stays silent");
    CHECK(alarm_sm_raise(&sm, "SMOKE", "e-3") == 1, "other danger while acked -> raise");
    CHECK(sm.state == ALARM_STATE_ALARM && sm.buzzer == 1, "other danger rings");
    CHECK(strcmp(sm.id, "e-3") == 0, "new id for other danger");
}

static void test_reset_and_rearm(void)
{
    alarm_sm_t sm;
    alarm_sm_init(&sm);
    alarm_sm_raise(&sm, "SMOKE", "e-10");
    CHECK(alarm_sm_reset(&sm) == 1, "reset");
    CHECK(sm.state == ALARM_STATE_NORMAL && sm.buzzer == 0, "reset -> normal + silent");

    alarm_sm_init(&sm);
    alarm_sm_raise(&sm, "SMOKE", "e-11");
    alarm_sm_ack(&sm, "e-11");
    CHECK(alarm_sm_rearm(&sm, 1) == 0, "danger present -> no rearm");
    CHECK(sm.acked_armed == 0, "not armed yet");
    CHECK(alarm_sm_rearm(&sm, 0) == 1, "danger gone -> rearm");
    CHECK(sm.acked_armed == 1, "armed");
    CHECK(alarm_sm_raise(&sm, "SMOKE", "e-12") == 1, "after real recovery -> new alarm again");
    CHECK(strcmp(sm.id, "e-12") == 0, "new id after recovery");
}

static void test_mq_confirm(void)
{
    mq_stab_t s;
    mq_stab_reset(&s);
    /* 阈值 4096 = 完全禁用 */
    CHECK(mq_stab_update(&s, 1, 4095, 4096, 20, 3) == 0, "threshold 4096 never alarms");
    CHECK(mq_stab_update(&s, 1, 4095, 4096, 20, 3) == 0, "threshold 4096 never alarms (2)");

    mq_stab_reset(&s);
    CHECK(mq_stab_update(&s, 1, 100, 90, 20, 3) == 0, "1st hit not enough");
    CHECK(mq_stab_update(&s, 1, 100, 90, 20, 3) == 0, "2nd hit not enough");
    CHECK(mq_stab_update(&s, 1, 100, 90, 20, 3) == 1, "3rd hit triggers");

    /* 回差区：阈值 90、回差 20 -> 解除需 <70 */
    CHECK(mq_stab_update(&s, 1, 75, 90, 20, 3) == 1, "grey zone keeps danger");
    CHECK(mq_stab_update(&s, 1, 65, 90, 20, 3) == 1, "1 safe read not enough");
    CHECK(mq_stab_update(&s, 1, 65, 90, 20, 3) == 1, "2 safe reads not enough");
    CHECK(mq_stab_update(&s, 1, 65, 90, 20, 3) == 0, "3 safe reads clear danger");

    /* 无效读数不参与 */
    mq_stab_reset(&s);
    CHECK(mq_stab_update(&s, 0, 500, 90, 20, 3) == 0, "invalid read no danger");
    CHECK(mq_stab_update(&s, 1, 100, 90, 20, 3) == 0, "before confirm");
    CHECK(mq_stab_update(&s, 0, 0, 90, 20, 3) == 0, "invalid read keeps current danger state (not danger)");
    /* 上面第 3 次有效触发：invalid 不重置 streak */
    mq_stab_reset(&s);
    mq_stab_update(&s, 1, 100, 90, 20, 3);
    mq_stab_update(&s, 1, 100, 90, 20, 3);
    CHECK(mq_stab_update(&s, 0, 100, 90, 20, 3) == 0, "invalid between hits: still not dangerous");
    CHECK(mq_stab_update(&s, 1, 100, 90, 20, 3) == 1, "streak continues across invalid (3rd valid hit)");
}

static void test_priority_and_ntp_and_valid(void)
{
    CHECK(danger_priority("GAS") == 4, "gas priority");
    CHECK(danger_priority("SMOKE") == 3, "smoke priority");
    CHECK(danger_priority("CLIMATE") == 2, "climate priority");
    CHECK(danger_priority("NO_MOTION") == 1, "no_motion priority");
    CHECK(danger_priority(NULL) == 0, "null priority");
    CHECK(danger_priority("GAS") > danger_priority("SMOKE"), "gas > smoke");
    CHECK(danger_priority("SMOKE") > danger_priority("CLIMATE"), "smoke > climate");
    CHECK(danger_priority("CLIMATE") > danger_priority("NO_MOTION"), "climate > no_motion");

    /* 厨房 PIR=-1：NTP 不得重置活动基准 */
    CHECK(ntp_reset_motion_baseline(0) == 0, "kitchen (PIR=-1) ntp does not reset motion");
    CHECK(ntp_reset_motion_baseline(1) == 1, "PIR enabled ntp resets motion");

    /* valid 语义 */
    CHECK(strcmp(json_valid_str(1), "true") == 0, "valid true");
    CHECK(strcmp(json_valid_str(0), "false") == 0, "valid false");
}

static void test_climate_confirm_hysteresis(void)
{
    climate_stab_t s;
    climate_stab_reset(&s);
    /* 常温常湿不误报 */
    CHECK(climate_stab_update(&s, 1, 24.0f, 50.0f, 5, 45, 10, 90, 1, 3, 3, 5) == 0, "normal no alarm");
    /* 短暂越界（2 次 < confirm 3）不触发 */
    CHECK(climate_stab_update(&s, 1, 46.0f, 50.0f, 5, 45, 10, 90, 1, 3, 3, 5) == 0, "1st out no alarm");
    CHECK(climate_stab_update(&s, 1, 46.5f, 50.0f, 5, 45, 10, 90, 1, 3, 3, 5) == 0, "2nd out still no alarm");
    /* 无效读数不参与触发，也不清零连续计数 */
    CHECK(climate_stab_update(&s, 0, 0.0f, 0.0f, 5, 45, 10, 90, 1, 3, 3, 5) == 0, "invalid no alarm");
    /* 第 3 次有效越界 -> 触发 */
    CHECK(climate_stab_update(&s, 1, 47.0f, 50.0f, 5, 45, 10, 90, 1, 3, 3, 5) == 1, "3rd out triggers");
    /* 无效读数不能解除已确认告警 */
    CHECK(climate_stab_update(&s, 0, 24.0f, 50.0f, 5, 45, 10, 90, 1, 3, 3, 5) == 1, "invalid keeps danger");
    /* 回差带内但不满足解除次数：维持危险 */
    CHECK(climate_stab_update(&s, 1, 44.5f, 50.0f, 5, 45, 10, 90, 1, 3, 3, 5) == 1, "grey band keeps danger");
    /* 连续 5 次回到回差带内才解除 */
    CHECK(climate_stab_update(&s, 1, 40.0f, 50.0f, 5, 45, 10, 90, 1, 3, 3, 5) == 1, "clear 1/5");
    CHECK(climate_stab_update(&s, 1, 40.0f, 50.0f, 5, 45, 10, 90, 1, 3, 3, 5) == 1, "clear 2/5");
    CHECK(climate_stab_update(&s, 1, 40.0f, 50.0f, 5, 45, 10, 90, 1, 3, 3, 5) == 1, "clear 3/5");
    CHECK(climate_stab_update(&s, 1, 40.0f, 50.0f, 5, 45, 10, 90, 1, 3, 3, 5) == 1, "clear 4/5");
    CHECK(climate_stab_update(&s, 1, 40.0f, 50.0f, 5, 45, 10, 90, 1, 3, 3, 5) == 0, "5 clears");

    /* 湿度越界（高湿）+ 恢复抖动：阈值附近不反复 */
    climate_stab_reset(&s);
    CHECK(climate_stab_update(&s, 1, 24.0f, 92.0f, 5, 45, 10, 90, 1, 3, 3, 5) == 0, "rh out 1");
    CHECK(climate_stab_update(&s, 1, 24.0f, 92.0f, 5, 45, 10, 90, 1, 3, 3, 5) == 0, "rh out 2");
    CHECK(climate_stab_update(&s, 1, 24.0f, 92.0f, 5, 45, 10, 90, 1, 3, 3, 5) == 1, "rh out 3 triggers");
    CHECK(climate_stab_update(&s, 1, 24.0f, 88.0f, 5, 45, 10, 90, 1, 3, 3, 5) == 1, "rh 88 (within hyst) keeps danger");
    CHECK(climate_stab_update(&s, 1, 24.0f, 50.0f, 5, 45, 10, 90, 1, 3, 3, 5) == 1, "rh clear 1/5");
    /* 再次越过 90 -> 清零解除计数，维持危险（避免阈值附近反复） */
    CHECK(climate_stab_update(&s, 1, 24.0f, 91.0f, 5, 45, 10, 90, 1, 3, 3, 5) == 1, "rh back out keeps danger");
    /* 低温侧 + 低湿侧 */
    climate_stab_reset(&s);
    CHECK(climate_stab_update(&s, 1, 3.0f, 5.0f, 5, 45, 10, 90, 1, 3, 3, 5) == 0, "low out 1");
    CHECK(climate_stab_update(&s, 1, 3.0f, 5.0f, 5, 45, 10, 90, 1, 3, 3, 5) == 0, "low out 2");
    CHECK(climate_stab_update(&s, 1, 3.0f, 5.0f, 5, 45, 10, 90, 1, 3, 3, 5) == 1, "low triggers");
}

static void test_repeat_and_no_motion_gate(void)
{
    /* 限频提醒：只在 active 且未抑制时按间隔到期 */
    CHECK(alarm_repeat_due(0, 0, 100000, 0, 120) == 0, "inactive never reminds");
    CHECK(alarm_repeat_due(1, 1, 100000, 0, 120) == 0, "stopped/acked never reminds");
    CHECK(alarm_repeat_due(1, 0, 100000, 0, 120) == 1, "first remind when no base");
    CHECK(alarm_repeat_due(1, 0, 100000, 99999, 120) == 0, "not due yet");
    CHECK(alarm_repeat_due(1, 0, 100000, 0, 0) == 0, "interval 0 = single reminder only");
    CHECK(alarm_repeat_due(1, 0, 220001, 100000, 120) == 1, "due after interval");

    /* 无活动提醒门槛：无 PIR / 未武装 / 暂停都不启用 */
    CHECK(no_motion_enabled(0, 1, 0) == 0, "no PIR never enables no-motion");
    CHECK(no_motion_enabled(1, 0, 0) == 0, "not armed never enables no-motion");
    CHECK(no_motion_enabled(1, 1, 1) == 0, "paused never enables no-motion");
    CHECK(no_motion_enabled(1, 1, 0) == 1, "armed + not paused enables no-motion");
}

static void test_sos_key0_button(void)
{
    sos_button_t b;
    sos_reset(&b);

    /* 上电即按住（或悬空常低）：没有见过“松开”之前绝不触发 */
    CHECK(sos_update(&b, 1, 2) == 0, "boot while held: no trigger (1)");
    CHECK(sos_update(&b, 1, 2) == 0, "boot while held: no trigger (2)");
    CHECK(sos_update(&b, 1, 2) == 0, "boot while held: no trigger (3)");
    CHECK(sos_update(&b, 0, 2) == 0, "release arms the button");

    /* 短按：连续 2 次（约 200 ms）确认才触发一次 */
    CHECK(sos_update(&b, 1, 2) == 0, "short press 1st sample: no trigger");
    CHECK(sos_update(&b, 1, 2) == 1, "short press confirmed -> one SOS");
    /* 长按：继续按住不再触发（不刷屏） */
    for (int i = 0; i < 10; i++) CHECK(sos_update(&b, 1, 2) == 0, "long press never repeats");

    /* 松开后可再次发起新的求助（ACK 后仍能重新求助） */
    CHECK(sos_update(&b, 0, 2) == 0, "release after long press");
    CHECK(sos_update(&b, 1, 2) == 0, "2nd press 1st sample");
    CHECK(sos_update(&b, 1, 2) == 1, "2nd press -> new SOS");

    /* 抖动：单次采样后立即松开，不应算一次求助 */
    CHECK(sos_update(&b, 0, 2) == 0, "release before bounce");
    CHECK(sos_update(&b, 1, 2) == 0, "bounce sample not enough");
    CHECK(sos_update(&b, 0, 2) == 0, "bounce released");
    CHECK(sos_update(&b, 1, 2) == 0, "bounce sample again not enough");
    CHECK(sos_update(&b, 0, 2) == 0, "released again");

    /* confirm=3 语义 */
    sos_reset(&b);
    CHECK(sos_update(&b, 0, 3) == 0, "confirm3 release");
    CHECK(sos_update(&b, 1, 3) == 0, "confirm3 1/3");
    CHECK(sos_update(&b, 1, 3) == 0, "confirm3 2/3");
    CHECK(sos_update(&b, 1, 3) == 1, "confirm3 3/3 triggers");
    CHECK(sos_update(&b, 1, 3) == 0, "confirm3 held: no repeat");
}

static void test_sos_key0_expander_decode(void)
{
    /* KEY0 = XL9555 P1_7，低电平按下；I2C 读失败必须返回“未知”(-1) 而不是按下 */
    CHECK(sos_key0_pressed(0, 0xFF) == -1, "i2c failure -> unknown (never a press)");
    CHECK(sos_key0_pressed(0, 0x00) == -1, "i2c failure with low byte -> unknown");
    CHECK(sos_key0_pressed(1, 0xFF) == 0, "P1=0xFF -> released");
    CHECK(sos_key0_pressed(1, 0x7F) == 1, "P1_7 low -> pressed");
    CHECK(sos_key0_pressed(1, 0x00) == 1, "all low -> pressed");
    CHECK(sos_key0_pressed(1, 0x7E) == 1, "other bits do not mask P1_7 low");
    CHECK(sos_key0_pressed(1, 0x80) == 0, "only P1_7 high -> released");
}

static void test_alarm_id_unique_across_boot(void)
{
    char a[40], b[40], c[40];
    /* 时钟已同步：沿用 e-<unix>-<seq> */
    alarm_id_build(a, sizeof(a), 1793011719LL, 0xA1B2C3D4u, 3);
    CHECK(strcmp(a, "e-1793011719-3") == 0, "synced id format");
    /* 未同步：改用上电随机盐，同一秒/同一 seq 在不同上电周期也必须不同 */
    alarm_id_build(b, sizeof(b), 0, 0xA1B2C3D4u, 1);
    alarm_id_build(c, sizeof(c), 0, 0x0BADF00Du, 1);
    CHECK(strcmp(b, c) != 0, "unsynced ids differ across boots (no collision)");
    CHECK(strncmp(b, "e-u", 3) == 0, "unsynced id carries boot salt");
    CHECK(strlen(b) < sizeof(b) && strlen(c) < sizeof(c), "id fits buffer");
    /* 后端 ALARM_ID_RE = /^[A-Za-z0-9._:-]{1,80}$/ */
    const char *ids[2] = { b, c };
    for (int k = 0; k < 2; k++) {
        int ok = 1;
        for (const char *p = ids[k]; *p; p++) {
            char ch = *p;
            int legal = (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') ||
                        (ch >= '0' && ch <= '9') || ch == '.' || ch == '_' ||
                        ch == ':' || ch == '-';
            if (!legal) ok = 0;
        }
        CHECK(ok, "id charset accepted by backend ALARM_ID_RE");
    }
}

static void test_stale_ack_not_accepted(void)
{
    /* 上一轮（甚至上一个上电周期）的回执不能确认为本次求助 */
    alarm_sm_t sm;
    alarm_sm_init(&sm);
    CHECK(alarm_sm_raise(&sm, "MANUAL_SOS", "e-u0badf00d-1") == 1, "sos raise");
    CHECK(alarm_sm_ack(&sm, "e-u0badf00d-2") == 0, "old/other id ack rejected");
    CHECK(sm.state == ALARM_STATE_ALARM && sm.buzzer == 1, "stays alarming after stale ack");
    CHECK(alarm_sm_ack(&sm, "e-u0badf00d-1") == 1, "matching ack accepted");
    CHECK(sm.state == ALARM_STATE_ACKED && sm.buzzer == 0, "acked + silenced");

    /* 重启后状态回到 NORMAL：任何旧回执都不应成功 */
    alarm_sm_init(&sm);
    CHECK(alarm_sm_ack(&sm, "e-u0badf00d-1") == 0, "after reboot no pending alarm -> ack rejected");
}

static void test_acked_smoke_then_gas(void)
{
    alarm_sm_t sm;
    alarm_sm_init(&sm);
    alarm_sm_raise(&sm, "SMOKE", "e-20");
    alarm_sm_ack(&sm, "e-20");
    CHECK(sm.state == ALARM_STATE_ACKED, "acked smoke");
    CHECK(alarm_sm_raise(&sm, "SMOKE", "e-21") == 0, "acked smoke: same smoke no new id");
    CHECK(alarm_sm_raise(&sm, "GAS", "e-22") == 1, "acked smoke: gas raises new alarm");
    CHECK(strcmp(sm.id, "e-22") == 0 && sm.buzzer == 1, "gas new id + rings");
}

/* 语音文案必须对应真实触发原因：温度/湿度/两者分别判定；无效读数不得猜原因。 */
static void test_climate_reason_code(void)
{
    /* 阈值与现场一致：5..45 ℃、10..90 % */
    const int TL = 5, TH = 45, RL = 10, RH = 90;
    CHECK(climate_reason_code(1, 20.0f, 60.0f, TL, TH, RL, RH) == CLIMATE_REASON_UNKNOWN,
          "reason: normal reading -> unknown");
    CHECK(climate_reason_code(1, 50.0f, 60.0f, TL, TH, RL, RH) == CLIMATE_REASON_TEMP,
          "reason: only temp high -> TEMP");
    CHECK(climate_reason_code(1, 2.0f, 60.0f, TL, TH, RL, RH) == CLIMATE_REASON_TEMP,
          "reason: only temp low -> TEMP");
    CHECK(climate_reason_code(1, 20.0f, 95.0f, TL, TH, RL, RH) == CLIMATE_REASON_RH,
          "reason: only rh high -> RH");
    CHECK(climate_reason_code(1, 20.0f, 5.0f, TL, TH, RL, RH) == CLIMATE_REASON_RH,
          "reason: only rh low -> RH");
    CHECK(climate_reason_code(1, 50.0f, 95.0f, TL, TH, RL, RH) == CLIMATE_REASON_BOTH,
          "reason: temp+rh -> BOTH");
    CHECK(climate_reason_code(1, 2.0f, 5.0f, TL, TH, RL, RH) == CLIMATE_REASON_BOTH,
          "reason: temp low + rh low -> BOTH");
    /* 无效读数（读失败/CRC 错）：不能猜成温度或湿度，只能退通用文案 */
    CHECK(climate_reason_code(0, 50.0f, 95.0f, TL, TH, RL, RH) == CLIMATE_REASON_UNKNOWN,
          "reason: invalid reading -> unknown (no guessing)");
}

int main(void)
{
    test_ack();
    test_reset_and_rearm();
    test_mq_confirm();
    test_priority_and_ntp_and_valid();
    test_climate_confirm_hysteresis();
    test_repeat_and_no_motion_gate();
    test_sos_key0_button();
    test_sos_key0_expander_decode();
    test_alarm_id_unique_across_boot();
    test_stale_ack_not_accepted();
    test_acked_smoke_then_gas();
    test_climate_reason_code();
    printf("PASS=%d FAIL=%d\n", g_pass, g_fail);
    return g_fail ? 1 : 0;
}
