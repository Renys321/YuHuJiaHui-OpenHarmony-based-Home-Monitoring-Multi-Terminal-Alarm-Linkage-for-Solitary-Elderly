/* host_bathroom_logic_test.c —— 卫生间纯逻辑主机测试（不依赖 ESP-IDF） */
#include <stdio.h>
#include <string.h>
#include "alarm_logic.h"

static int g_pass = 0, g_fail = 0;
#define CHECK(cond, name) do { if (cond) { g_pass++; } else { g_fail++; printf("FAIL: %s (line %d)\n", name, __LINE__); } } while (0)

static void test_pir(void)
{
    pir_debounce_t p;
    pir_reset(&p);
    CHECK(pir_update(&p, 1, 2) == 0, "pir 1 sample not enough");
    CHECK(pir_update(&p, 1, 2) == 1, "pir 2 samples -> confirmed activity edge");
    CHECK(pir_update(&p, 1, 2) == 0, "pir hold -> no repeat");
    CHECK(pir_update(&p, 0, 2) == 0, "pir low resets");
    CHECK(pir_update(&p, 1, 2) == 0, "pir single glitch ignored");
    CHECK(pir_update(&p, 0, 2) == 0, "pir glitch cleared");
    CHECK(pir_update(&p, 1, 2) == 0, "pir 1 sample");
    CHECK(pir_update(&p, 1, 2) == 1, "pir confirmed again -> new activity");
}

static void test_sos(void)
{
    sos_button_t b;
    sos_reset(&b);
    /* 上电后必须先松开一次（HIGH），否则悬空/常闭触点不得误报 */
    CHECK(sos_update(&b, 1, 2) == 0, "sos pressed before release -> ignored");
    CHECK(sos_update(&b, 0, 2) == 0, "sos released once");
    CHECK(sos_update(&b, 1, 2) == 0, "sos 1 sample not enough");
    CHECK(sos_update(&b, 1, 2) == 1, "sos press edge -> one event");
    CHECK(sos_update(&b, 1, 2) == 0, "sos long press no repeat");
    CHECK(sos_update(&b, 1, 2) == 0, "sos long press still none");
    CHECK(sos_update(&b, 0, 2) == 0, "sos release");
    CHECK(sos_update(&b, 0, 2) == 0, "sos released");
    CHECK(sos_update(&b, 1, 2) == 0, "sos press again first sample");
    CHECK(sos_update(&b, 1, 2) == 1, "sos release then press -> new event");
}

static void test_water(void)
{
    water_stab_t w;
    water_reset(&w);
    CHECK(water_update(&w, 1, 1, 3, 3) == 0, "water 1st wet");
    CHECK(water_update(&w, 1, 1, 3, 3) == 0, "water 2nd wet");
    CHECK(water_update(&w, 1, 1, 3, 3) == 1, "water 3rd wet -> danger");
    CHECK(water_update(&w, 1, 1, 3, 3) == 1, "continuous wet keeps danger (latch)");
    CHECK(water_update(&w, 0, 1, 3, 3) == 1, "invalid reading does not clear danger");
    CHECK(water_update(&w, 1, 0, 3, 3) == 1, "1st dry not enough");
    CHECK(water_update(&w, 0, 0, 3, 3) == 1, "invalid dry does not count");
    CHECK(water_update(&w, 1, 0, 3, 3) == 1, "2nd dry not enough");
    CHECK(water_update(&w, 1, 0, 3, 3) == 0, "3rd dry -> rearm");

    water_reset(&w);
    CHECK(water_update(&w, 1, 1, 3, 3) == 0, "glitch wet 1");
    CHECK(water_update(&w, 1, 0, 3, 3) == 0, "glitch dry resets count");
    CHECK(water_update(&w, 1, 1, 3, 3) == 0, "after glitch wet 1");
    CHECK(water_update(&w, 1, 1, 3, 3) == 0, "after glitch wet 2");
    CHECK(water_update(&w, 1, 1, 3, 3) == 1, "3 consecutive wet -> danger");
}

static void test_priority(void)
{
    CHECK(danger_priority("MANUAL_SOS") == 6, "sos priority 6");
    CHECK(danger_priority("WATER_LEAK") == 5, "water priority 5");
    CHECK(danger_priority("CLIMATE") == 2, "climate 2");
    CHECK(danger_priority("NO_MOTION") == 1, "no_motion 1");
    CHECK(danger_priority("MANUAL_SOS") > danger_priority("WATER_LEAK"), "sos > water");
    CHECK(danger_priority("WATER_LEAK") > danger_priority("CLIMATE"), "water > climate");
    CHECK(danger_priority("CLIMATE") > danger_priority("NO_MOTION"), "climate > no_motion");
}

static void test_sos_state_machine(void)
{
    alarm_sm_t sm;
    alarm_sm_init(&sm);
    CHECK(alarm_sm_raise(&sm, "MANUAL_SOS", "e-sos1") == 1, "sos raise");
    CHECK(sm.buzzer == 1, "sos rings");
    CHECK(alarm_sm_ack(&sm, "e-sos1") == 1, "sos ack accepted");
    CHECK(sm.buzzer == 0, "ack silences immediately");
    CHECK(strcmp(sm.id, "e-sos1") == 0 && strcmp(sm.type, "MANUAL_SOS") == 0, "ack keeps id/type");
    CHECK(alarm_sm_raise(&sm, "MANUAL_SOS", "e-sos2") == 0, "hold after ack -> no new id");
    sm.acked_armed = 1;                        /* 固件在按键松开时置位 */
    CHECK(alarm_sm_raise(&sm, "MANUAL_SOS", "e-sos2") == 1, "release then press -> new id");
    CHECK(strcmp(sm.id, "e-sos2") == 0, "new alarm id");
}

static void test_water_state_machine(void)
{
    alarm_sm_t sm;
    alarm_sm_init(&sm);
    CHECK(alarm_sm_raise(&sm, "WATER_LEAK", "e-w1") == 1, "water raise");
    CHECK(alarm_sm_ack(&sm, "e-w1") == 1, "water ack");
    CHECK(sm.buzzer == 0, "water ack silences");
    CHECK(alarm_sm_raise(&sm, "WATER_LEAK", "e-w2") == 0, "wet & acked -> no new id");
    sm.acked_armed = 1;                        /* 连续干燥后重新武装 */
    CHECK(alarm_sm_raise(&sm, "WATER_LEAK", "e-w3") == 1, "after dry -> new alarm");
}

static void test_valid(void)
{
    CHECK(strcmp(json_valid_str(1), "true") == 0, "valid true");
    CHECK(strcmp(json_valid_str(0), "false") == 0, "valid false");
}

int main(void)
{
    test_pir();
    test_sos();
    test_water();
    test_priority();
    test_sos_state_machine();
    test_water_state_machine();
    test_valid();
    printf("PASS=%d FAIL=%d\n", g_pass, g_fail);
    return g_fail ? 1 : 0;
}
