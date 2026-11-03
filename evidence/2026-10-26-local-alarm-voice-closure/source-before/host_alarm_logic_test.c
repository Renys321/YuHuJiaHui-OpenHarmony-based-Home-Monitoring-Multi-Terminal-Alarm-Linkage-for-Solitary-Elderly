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

int main(void)
{
    test_ack();
    test_reset_and_rearm();
    test_mq_confirm();
    test_priority_and_ntp_and_valid();
    test_acked_smoke_then_gas();
    printf("PASS=%d FAIL=%d\n", g_pass, g_fail);
    return g_fail ? 1 : 0;
}
