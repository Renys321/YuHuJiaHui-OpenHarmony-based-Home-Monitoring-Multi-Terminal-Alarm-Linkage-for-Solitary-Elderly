/* host_wearable_logic_test.c —— 随身 SOS 纯逻辑主机单测（gcc，不需要 ESP-IDF）
 *
 * 编译/运行（在 competition/esp32-node-wearable 目录）：
 *   gcc -std=c11 -Wall -Wextra -O2 -I main test/host_wearable_logic_test.c main/wearable_logic.c \
 *       -o test/host_wearable_logic_test.exe
 *   .\test\host_wearable_logic_test.exe
 *
 * 覆盖（对应任务验收项）：
 *   1. 20ms 采样 + 60ms 消抖（含抖动、松开边沿）
 *   2. alarmId 格式/正则/计数器，重试永远不换 ID
 *   3. ACK 匹配 / alarm 不匹配 / cmd 不一致 / 重复 ACK / cmd 缺失
 *   4. NVS 快照重启恢复（未确认事件继续、同一 alarmId、计数器单调、损坏快照拒绝）
 *   5. JSON 转义与下行解析（嵌套对象、\u 转义、垃圾行）
 *   6. GPS 解析失败降级（短包/flag=0/零坐标/越界/半球非法 → gps=null）
 *   7. UART 分包/粘包/超长丢弃
 *   8. 蜂鸣节奏（3 短声、30s 后每 30s 单短提示）
 *   9. 心跳/启动帧内容与 512 字节上限
 */
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "wearable_logic.h"

static int g_pass = 0;
static int g_fail = 0;

#define CHECK(cond, name)                                                                          \
    do {                                                                                           \
        if (cond) {                                                                                \
            g_pass++;                                                                              \
        } else {                                                                                   \
            g_fail++;                                                                              \
            printf("FAIL: %s (line %d)\n", name, __LINE__);                                        \
        }                                                                                          \
    } while (0)

#define CHECK_STR_EQ(actual, expected, name)                                                       \
    do {                                                                                           \
        const char *a_ = (actual);                                                                 \
        const char *e_ = (expected);                                                               \
        if (a_ != NULL && strcmp(a_, e_) == 0) {                                                   \
            g_pass++;                                                                              \
        } else {                                                                                   \
            g_fail++;                                                                              \
            printf("FAIL: %s (line %d): got \"%s\" want \"%s\"\n", name, __LINE__,                \
                   a_ ? a_ : "(null)", e_ ? e_ : "(null)");                                       \
        }                                                                                          \
    } while (0)

/* ---------------------------------------------------------------- 1. 消抖 */

static void test_debounce(void)
{
    wb_debounce_t d;

    wb_debounce_init(&d);
    CHECK(wb_debounce_update(&d, 0, 0) == WB_BTN_EVENT_NONE, "first sample only baseline");
    CHECK(d.stable_pressed == 0, "baseline released");

    /* 20ms 采样，60ms 稳定后才确认按下 */
    CHECK(wb_debounce_update(&d, 1, 20) == WB_BTN_EVENT_NONE, "press 20ms: not yet");
    CHECK(wb_debounce_update(&d, 1, 40) == WB_BTN_EVENT_NONE, "press 40ms: not yet");
    CHECK(wb_debounce_update(&d, 1, 60) == WB_BTN_EVENT_NONE, "press 60ms(elapsed 40): not yet");
    CHECK(wb_debounce_update(&d, 1, 80) == WB_BTN_EVENT_PRESS, "press stable 60ms -> PRESS");
    CHECK(wb_debounce_update(&d, 1, 100) == WB_BTN_EVENT_NONE, "PRESS edge only once");
    CHECK(d.stable_pressed == 1, "stable pressed");

    /* 松开同样 60ms 消抖 */
    CHECK(wb_debounce_update(&d, 0, 120) == WB_BTN_EVENT_NONE, "release 0ms: not yet");
    CHECK(wb_debounce_update(&d, 0, 140) == WB_BTN_EVENT_NONE, "release 20ms: not yet");
    CHECK(wb_debounce_update(&d, 0, 160) == WB_BTN_EVENT_NONE, "release 40ms: not yet");
    CHECK(wb_debounce_update(&d, 0, 180) == WB_BTN_EVENT_RELEASE, "release stable 60ms -> RELEASE");
    CHECK(d.stable_pressed == 0, "stable released");

    /* 抖动：任何一次跳变都重新计时，不得提前触发 */
    wb_debounce_init(&d);
    wb_debounce_update(&d, 0, 0);
    CHECK(wb_debounce_update(&d, 1, 20) == WB_BTN_EVENT_NONE, "bounce press 20");
    CHECK(wb_debounce_update(&d, 0, 40) == WB_BTN_EVENT_NONE, "bounce release 40 resets timer");
    CHECK(wb_debounce_update(&d, 1, 60) == WB_BTN_EVENT_NONE, "bounce press 60 resets timer");
    CHECK(wb_debounce_update(&d, 1, 80) == WB_BTN_EVENT_NONE, "bounce stable 20ms");
    CHECK(wb_debounce_update(&d, 1, 100) == WB_BTN_EVENT_NONE, "bounce stable 40ms");
    CHECK(wb_debounce_update(&d, 1, 120) == WB_BTN_EVENT_PRESS, "bounce stable 60ms -> PRESS");

    /* 上电时按键已按住：不能伪造一次按下事件（避免上电自触发 SOS） */
    wb_debounce_init(&d);
    CHECK(wb_debounce_update(&d, 1, 0) == WB_BTN_EVENT_NONE, "held-at-boot no phantom press");
    CHECK(wb_debounce_update(&d, 0, 20) == WB_BTN_EVENT_NONE, "held-at-boot release not yet");
    CHECK(wb_debounce_update(&d, 0, 80) == WB_BTN_EVENT_RELEASE, "held-at-boot release edge");
}

/* ---------------------------------------------------------------- 2. alarmId */

static void test_alarm_id(void)
{
    uint8_t rnd[4] = {0xAB, 0xCD, 0x12, 0x34};
    char id[WB_ALARM_ID_CAP];
    uint32_t counter = 0;
    char big[WB_ALARM_ID_MAX_LEN + 2];

    CHECK(wb_alarm_id_format(id, sizeof(id), 7, rnd) > 0, "format alarm id");
    CHECK_STR_EQ(id, "sos-7-abcd1234", "alarm id exact format");
    CHECK(wb_alarm_id_valid(id), "alarm id matches regex");
    CHECK(wb_alarm_id_counter(id, &counter) == 1 && counter == 7, "parse counter from id");

    CHECK(wb_alarm_id_valid("A.b_c:d-e"), "allowed charset");
    CHECK(wb_alarm_id_valid("sos-1-ABCDEF12"), "uppercase hex allowed by regex");
    CHECK(!wb_alarm_id_valid(""), "empty id rejected");
    CHECK(!wb_alarm_id_valid("has space"), "space rejected");
    CHECK(!wb_alarm_id_valid("bad/id"), "slash rejected");
    CHECK(!wb_alarm_id_valid("\xe4\xb8\xad\xe6\x96\x87"), "non-ascii rejected");

    memset(big, 'a', sizeof(big) - 1);
    big[sizeof(big) - 1] = '\0';
    CHECK(strlen(big) == WB_ALARM_ID_MAX_LEN + 1, "overlong id length");
    CHECK(!wb_alarm_id_valid(big), "81 chars rejected");

    /* 计数器不同 -> 当前事件绝不复用旧 ID（事件层保证，这里验证格式层） */
    CHECK(wb_alarm_id_format(id, sizeof(id), 8, rnd) > 0, "format next id");
    CHECK_STR_EQ(id, "sos-8-abcd1234", "next counter -> different id");
}

/* ---------------------------------------------------------------- 3/4. 事件、ACK、重试 */

static void test_event_retry_same_id(void)
{
    wb_event_t ev;
    wb_ack_memo_t memo;
    int i;

    wb_event_init(&ev, &memo);
    CHECK(!wb_event_active(&ev), "init idle");
    CHECK(wb_event_start(&ev, "sos-1-abcd1234", 1000) == 1, "start event");
    CHECK(wb_event_active(&ev), "event active");
    CHECK(ev.seq == 0, "seq zero at start");

    wb_event_note_sent(&ev, 1000);
    for (i = 1; i <= 10; i++) {
        uint32_t due_at = 1000u + (uint32_t)i * WB_SOS_RETRY_MS;
        CHECK(wb_event_should_resend(&ev, due_at - 1, WB_SOS_RETRY_MS) == 0, "not due before 10s");
        CHECK(wb_event_should_resend(&ev, due_at, WB_SOS_RETRY_MS) == 1, "due at 10s");
        CHECK_STR_EQ(ev.alarm_id, "sos-1-abcd1234", "retry keeps same alarm id");
        CHECK(wb_event_start(&ev, "sos-2-deadbeef", due_at) == 0, "no new id while unacked");
        CHECK_STR_EQ(ev.alarm_id, "sos-1-abcd1234", "still same id");
    }
    CHECK(!wb_event_should_resend(&ev, 11000, WB_SOS_RETRY_MS), "idle event never due");

    /* 只有匹配 ACK 才允许下一次按键产生新 ID */
    CHECK(wb_event_handle_ack(&ev, &memo, "sos-1-abcd1234", NULL, 0, 200000) == WB_ACK_ACCEPTED,
          "matching ack (cmd missing) accepted");
    CHECK(!wb_event_active(&ev), "acked -> idle");
    CHECK(memo.valid && !memo.has_cmd, "memo recorded, no cmd");
    CHECK(wb_event_start(&ev, "sos-2-deadbeef", 200100) == 1, "next press -> new id allowed");
    CHECK_STR_EQ(ev.alarm_id, "sos-2-deadbeef", "new event id");
}

static void test_ack_matching(void)
{
    wb_event_t ev;
    wb_ack_memo_t memo;

    wb_event_init(&ev, &memo);
    wb_event_start(&ev, "sos-5-deadbeef", 1000);

    /* alarm 不匹配：必须忽略且保持 ALARM */
    CHECK(wb_event_handle_ack(&ev, &memo, "sos-6-cafebabe", "42", 1, 2000) ==
              WB_ACK_REJECTED_ALARM,
          "wrong alarm rejected");
    CHECK(wb_event_active(&ev), "wrong alarm keeps event");
    CHECK(wb_event_handle_ack(&ev, &memo, "", "42", 1, 2000) == WB_ACK_REJECTED_ALARM,
          "empty alarm rejected");
    CHECK(wb_event_active(&ev), "empty alarm keeps event");

    /* cmd 与“已收到的命令”不一致：拒绝（模拟设备已记录 cmd=42 后被投递 cmd=99） */
    strcpy(ev.cmd_id, "42");
    ev.has_cmd = 1;
    CHECK(wb_event_handle_ack(&ev, &memo, "sos-5-deadbeef", "99", 1, 3000) ==
              WB_ACK_REJECTED_CMD,
          "cmd mismatch rejected");
    CHECK(wb_event_active(&ev), "cmd mismatch keeps event");

    /* 匹配 -> 停提示由调用方执行；逻辑层置 IDLE 并记录 memo */
    CHECK(wb_event_handle_ack(&ev, &memo, "sos-5-deadbeef", "42", 1, 4000) == WB_ACK_ACCEPTED,
          "matching alarm + cmd accepted");
    CHECK(!wb_event_active(&ev), "accepted -> idle");
    CHECK(memo.valid && memo.has_cmd, "memo has cmd");
    CHECK_STR_EQ(memo.alarm_id, "sos-5-deadbeef", "memo alarm");
    CHECK_STR_EQ(memo.cmd_id, "42", "memo cmd");

    /* 适配器重复投递同一 ACK：识别为 DUPLICATE，可重发回执 */
    CHECK(wb_event_handle_ack(&ev, &memo, "sos-5-deadbeef", "42", 1, 5000) == WB_ACK_DUPLICATE,
          "duplicate ack");
    CHECK(wb_event_handle_ack(&ev, &memo, "sos-5-deadbeef", NULL, 0, 6000) == WB_ACK_DUPLICATE,
          "duplicate ack without cmd");
    CHECK(wb_event_handle_ack(&ev, &memo, "sos-5-deadbeef", "99", 1, 7000) ==
              WB_ACK_REJECTED_CMD,
          "duplicate ack with different cmd rejected");

    /* 旧事件的 ACK 不得影响新事件：事件活跃时只认当前 alarm，
     * 旧 alarm 的（重复）ACK 直接拒绝，不会清除新事件。 */
    CHECK(wb_event_start(&ev, "sos-6-cafebabe", 8000) == 1, "new event");
    CHECK(wb_event_handle_ack(&ev, &memo, "sos-5-deadbeef", "42", 1, 9000) ==
              WB_ACK_REJECTED_ALARM,
          "old ack ignored while new event active");
    CHECK(wb_event_active(&ev), "new event unaffected by old ack");
    CHECK_STR_EQ(ev.alarm_id, "sos-6-cafebabe", "new event id unchanged");

    /* cmd 缺失的 ACK 可接受，但要记录（memo 无 cmd，逻辑层不伪造） */
    CHECK(wb_event_handle_ack(&ev, &memo, "sos-6-cafebabe", NULL, 0, 10000) == WB_ACK_ACCEPTED,
          "ack without cmd accepted");
    CHECK(!memo.has_cmd, "memo without cmd");
}

/* ---------------------------------------------------------------- 4. 重启恢复 */

static void test_restart_recovery(void)
{
    wb_event_t ev;
    wb_ack_memo_t memo;
    wb_persist_t snap;
    wb_persist_t nvs_copy;
    wb_event_t ev2;
    wb_ack_memo_t memo2;
    uint32_t counter = 0;
    int active = 0;

    wb_event_init(&ev, &memo);
    wb_event_start(&ev, "sos-9-11223344", 5000);
    strcpy(ev.cmd_id, "77");
    ev.has_cmd = 1;
    wb_persist_from_event(&snap, &ev, &memo, 9);
    CHECK(snap.magic == WB_PERSIST_MAGIC && snap.version == WB_PERSIST_VERSION, "snapshot header");
    CHECK(snap.flags == 1, "snapshot marks unacked event");

    /* 模拟 NVS 断电保存：按字节拷贝到新结构 */
    memcpy(&nvs_copy, &snap, sizeof(nvs_copy));
    CHECK(wb_persist_restore(&nvs_copy, &ev2, &memo2, &counter, 90000, &active) == 1,
          "restore valid snapshot");
    CHECK(active == 1, "restored active event");
    CHECK(wb_event_active(&ev2), "restored event is ALARM");
    CHECK_STR_EQ(ev2.alarm_id, "sos-9-11223344", "restored same alarm id");
    CHECK(counter == 9, "restored counter");
    CHECK(ev2.has_cmd && strcmp(ev2.cmd_id, "77") == 0, "restored pending cmd");
    /* 重启后立即重试：last_sos 被回拨一个重试周期 */
    CHECK(wb_event_should_resend(&ev2, 90000, WB_SOS_RETRY_MS) == 1, "restored event retries immediately");
    CHECK_STR_EQ(ev2.alarm_id, "sos-9-11223344", "restored retry keeps id");

    /* 损坏快照必须拒绝，不能拿半个事件去重试 */
    memcpy(&nvs_copy, &snap, sizeof(nvs_copy));
    nvs_copy.checksum ^= 0x1u;
    CHECK(wb_persist_restore(&nvs_copy, &ev2, &memo2, &counter, 90000, &active) == 0,
          "corrupt checksum rejected");
    memcpy(&nvs_copy, &snap, sizeof(nvs_copy));
    nvs_copy.magic = 0;
    CHECK(wb_persist_restore(&nvs_copy, &ev2, &memo2, &counter, 90000, &active) == 0,
          "bad magic rejected");

    /* 已确认（IDLE）快照：保留计数器与最近 ACK 备忘，重启后不会重复旧事件 */
    wb_event_init(&ev, &memo);
    wb_event_start(&ev, "sos-10-aabbccdd", 1000);
    wb_event_handle_ack(&ev, &memo, "sos-10-aabbccdd", "88", 1, 2000);
    wb_persist_from_event(&snap, &ev, &memo, 10);
    CHECK(snap.flags == 0, "idle snapshot no active flag");
    counter = 0;
    CHECK(wb_persist_restore(&snap, &ev2, &memo2, &counter, 3000, &active) == 1, "restore idle snapshot");
    CHECK(active == 0 && !wb_event_active(&ev2), "no event after idle restore");
    CHECK(counter == 10, "counter preserved after idle restore");
    CHECK(memo2.valid && wb_event_handle_ack(&ev2, &memo2, "sos-10-aabbccdd", "88", 1, 4000) ==
                               WB_ACK_DUPLICATE,
          "duplicate ack recognized after reboot");

    /* 计数器单调：alarmId 内嵌计数大于快照 counter 时取较大值 */
    wb_event_init(&ev, &memo);
    wb_event_start(&ev, "sos-9-11223344", 0);
    wb_persist_from_event(&snap, &ev, &memo, 3);
    counter = 42;
    wb_persist_restore(&snap, &ev2, &memo2, &counter, 100, &active);
    CHECK(counter == 42, "counter never decreases");
    counter = 0;
    wb_persist_restore(&snap, &ev2, &memo2, &counter, 100, &active);
    CHECK(counter == 9, "counter raised to alarm id counter");
}

/* ---------------------------------------------------------------- 5. JSON 转义 */

static void test_json_escape(void)
{
    char out[256];
    wb_downlink_t dl;

    CHECK(wb_json_escape("plain-42", out, sizeof(out)) == 8, "escape length");
    CHECK_STR_EQ(out, "plain-42", "no escape needed");
    CHECK(wb_json_escape("a\"b\\c\n", out, sizeof(out)) > 0, "escape specials");
    CHECK_STR_EQ(out, "a\\\"b\\\\c\\n", "escaped specials");
    CHECK(wb_json_escape("\x01", out, sizeof(out)) > 0, "escape control");
    CHECK_STR_EQ(out, "\\u0001", "control -> \\u0001");
    CHECK(wb_json_escape("确认", out, sizeof(out)) > 0, "utf8 passthrough");
    CHECK_STR_EQ(out, "确认", "utf8 bytes unchanged");
    CHECK(wb_json_escape("abcdef", out, 4) == -1, "escape buffer too small");

    /* 构造含引号的 cmd，再用下行解析器读回：证明上行 JSON 可被严格解析 */
    {
        char frame[WB_LINE_MAX_BYTES + 1];
        int n = wb_build_ack_frame(frame, sizeof(frame), "esp32-sos", "sos-1-abcd1234",
                                   "cmd\"x\\y");
        CHECK(n > 0 && n <= WB_LINE_MAX_BYTES, "ack frame with quotes built");
        CHECK(wb_json_parse_downlink(frame, &dl) == 1, "escaped frame parses");
        CHECK(dl.has_cmd && strcmp(dl.cmd, "cmd\"x\\y") == 0, "escaped cmd roundtrip");
    }

    /* 下行 \uXXXX 转义 */
    CHECK(wb_json_parse_downlink("{\"t\":\"ack\",\"alarm\":\"a\\u002db\"}", &dl) == 1,
          "parse \\u escape");
    CHECK(dl.has_alarm && strcmp(dl.alarm, "a-b") == 0, "\\u002d decoded");

    /* \uXXXX 的 UTF-8 编码（中 = U+4E2D） */
    CHECK(wb_json_parse_downlink("{\"t\":\"ack\",\"cmd\":\"\\u4e2d\"}", &dl) == 1, "parse utf8 \\u");
    CHECK(dl.has_cmd && strcmp(dl.cmd, "\xe4\xb8\xad") == 0, "\\u4e2d -> UTF-8");
}

/* ---------------------------------------------------------------- 6. GPS 降级 */

static void test_gps_degradation(void)
{
    wb_gps_fix_t fix;
    wb_downlink_t dl;
    char frame[WB_LINE_MAX_BYTES + 1];
    int n;

    /* 不是 config,gps 回包 */
    CHECK(wb_gps_parse_line("hello world", &fix, 100) == WB_GPS_NOT_RESPONSE, "garbage not gps");
    CHECK(wb_gps_parse_line("config,csq,ok,26", &fix, 100) == WB_GPS_NOT_RESPONSE, "csq not gps");
    CHECK(wb_gps_parse_line("config,gps,err", &fix, 100) == WB_GPS_NOT_RESPONSE, "gps err not ok");

    /* 短包（无显式 fix 标志）：只能 NO_FIX */
    CHECK(wb_gps_parse_line("config,gps,ok,E,112.5532,N,32.9671", &fix, 100) == WB_GPS_NO_FIX,
          "short gps packet -> NO_FIX");
    CHECK(!fix.valid, "short packet never valid");

    /* 扩展包 flag=0 -> NO_FIX */
    CHECK(wb_gps_parse_line(
              "config,gps,ok,0,E,112.5532,N,32.9671,12.3,45.6,35.2,2026-10-27 08:00:00", &fix,
              100) == WB_GPS_NO_FIX,
          "flag=0 -> NO_FIX");
    CHECK(!fix.valid, "flag=0 not valid");

    /* 零坐标 -> NO_FIX（契约：绝不伪装） */
    CHECK(wb_gps_parse_line(
              "config,gps,ok,1,E,0,N,0,0,0,0,2026-10-27 08:00:00", &fix, 100) == WB_GPS_NO_FIX,
          "zero coordinates -> NO_FIX");

    /* 越界坐标 -> NO_FIX */
    CHECK(wb_gps_parse_line(
              "config,gps,ok,1,E,200.1,N,32.9,0,0,0,2026-10-27 08:00:00", &fix, 100) ==
              WB_GPS_NO_FIX,
          "out-of-range lon -> NO_FIX");
    CHECK(wb_gps_parse_line(
              "config,gps,ok,1,E,112.5,N,91.0,0,0,0,2026-10-27 08:00:00", &fix, 100) ==
              WB_GPS_NO_FIX,
          "out-of-range lat -> NO_FIX");

    /* 半球非法 / 缺字段 -> NO_FIX */
    CHECK(wb_gps_parse_line("config,gps,ok,1,X,112.5,N,32.9,0,0,0,t", &fix, 100) == WB_GPS_NO_FIX,
          "bad hemisphere -> NO_FIX");
    CHECK(wb_gps_parse_line("config,gps,ok,1,E,112.5,N", &fix, 100) == WB_GPS_NO_FIX,
          "truncated fields -> NO_FIX");

    /* 合法扩展包（南纬/西经取负号） */
    CHECK(wb_gps_parse_line(
              "config,gps,ok,1,W,112.5532,S,32.9671,12.3,45.6,35.2,2026-10-27 08:00:00", &fix,
              5000) == WB_GPS_FIX,
          "valid extended gps -> FIX");
    CHECK(fix.valid, "fix valid");
    CHECK(fix.lon_u6 == -112553200LL, "west longitude negative");
    CHECK(fix.lat_u6 == -32967100LL, "south latitude negative");
    CHECK(fix.fix_uptime_ms == 5000, "fix uptime recorded");
    CHECK(wb_gps_is_fresh(&fix, 5000 + WB_GPS_MAX_AGE_MS, WB_GPS_MAX_AGE_MS), "fix fresh within 60s");
    CHECK(!wb_gps_is_fresh(&fix, 5000 + WB_GPS_MAX_AGE_MS + 1, WB_GPS_MAX_AGE_MS),
          "fix stale after 60s");

    /* 解析失败时 SOS 必须是 gps:null（不阻塞告警） */
    n = wb_build_sos(frame, sizeof(frame), "esp32-sos", "sos-1-abcd1234", 12345, 1, NULL);
    CHECK(n > 0, "build sos without gps");
    CHECK(strstr(frame, "\"gps\":null") != NULL, "gps null on failure");

    /* 有效定位写入 SOS 包（ageMs 来自 uptime 差） */
    n = wb_build_sos(frame, sizeof(frame), "esp32-sos", "sos-1-abcd1234", 10000, 3, &fix);
    CHECK(n > 0, "build sos with gps");
    CHECK(strstr(frame, "\"gps\":{\"lat\":-32.9671,\"lon\":-112.5532,\"fix\":true,\"ageMs\":5000}") !=
              NULL,
          "gps object in sos frame");

    /* csq */
    {
        int csq = -1;
        CHECK(wb_parse_csq_line("config,csq,ok,26", &csq) == 1 && csq == 26, "csq 26");
        CHECK(wb_parse_csq_line("config,csq,ok,99", &csq) == 0, "csq 99 unknown rejected");
        CHECK(wb_parse_csq_line("config,csq,ok,abc", &csq) == 0, "csq garbage rejected");
        CHECK(wb_parse_csq_line("config,csq,err,26", &csq) == 0, "csq err rejected");
    }

    /* config 回包识别（只能本地解析，绝不回显上行） */
    CHECK(wb_dtu_is_config_line("config,gps,ok,1,E,1,N,1,0,0,0,t"), "detect config line");
    CHECK(wb_dtu_is_config_line("CONFIG,CSQ,OK,26"), "detect config line ci");
    CHECK(!wb_dtu_is_config_line("{\"t\":\"ack\"}"), "json is not config line");
    CHECK(!wb_dtu_is_config_line("configx,gps,ok"), "configx is not config line");

    /* M100 真机 GPS 固定格式：WGS84 十进制 "经度_纬度"，无前缀/无时间字段。
     * 它不是 config 行、也不是 JSON，必须被忽略（不当作 ACK、不回显）。
     * 正式固件 SOS 的 gps 固定为 null，由适配器用该固定格式报文出“求助时最近定位”。 */
    CHECK(!wb_dtu_is_config_line("113.9737_22.69271"), "M100 gps fixed format not config line");
    CHECK(wb_json_parse_downlink("113.9737_22.69271", &dl) == 0,
          "M100 gps fixed format not json");
    CHECK(wb_gps_parse_line("113.9737_22.69271", &fix, 100) == WB_GPS_NOT_RESPONSE,
          "M100 gps fixed format not a config,gps response");
    /* 命令回显（如果 DTU 回显我们发的查询）不能当成 gps/csq 数据 */
    CHECK(wb_gps_parse_line("config,get,gpsext", &fix, 100) == WB_GPS_NOT_RESPONSE,
          "config,get echo not gps response");
    {
        int csq_echo = -1;
        CHECK(wb_parse_csq_line("config,get,gpsext", &csq_echo) == 0, "config,get echo not csq");
    }
}

/* ---------------------------------------------------------------- 7. UART 分帧 */

static void feed_str(wb_line_buf_t *lb, const char *s, wb_line_event_t *last, int *ready_count,
                     char *last_line, size_t cap)
{
    size_t i;
    for (i = 0; s[i] != '\0'; i++) {
        wb_line_event_t e = wb_line_feed(lb, (uint8_t)s[i]);
        if (e != WB_LINE_EVENT_NONE) {
            *last = e;
            if (e == WB_LINE_EVENT_READY) {
                (*ready_count)++;
                if (last_line && cap) {
                    strncpy(last_line, lb->buf, cap - 1);
                    last_line[cap - 1] = '\0';
                }
            }
        }
    }
}

static void test_line_framing(void)
{
    wb_line_buf_t lb;
    wb_line_event_t last = WB_LINE_EVENT_NONE;
    int ready = 0;
    char line[WB_LINE_MAX_BYTES + 1] = {0};
    char big[WB_LINE_MAX_BYTES + 1];

    /* 分包：一条 JSON 拆成两次 UART 读取 */
    wb_line_init(&lb);
    feed_str(&lb, "{\"v\":1,\"t\":\"ac", &last, &ready, line, sizeof(line));
    CHECK(ready == 0, "split packet: no line yet");
    feed_str(&lb, "k\",\"alarm\":\"sos-1-abcd1234\"}\n", &last, &ready, line, sizeof(line));
    CHECK(ready == 1 && last == WB_LINE_EVENT_READY, "split packet ready once");
    CHECK_STR_EQ(line, "{\"v\":1,\"t\":\"ack\",\"alarm\":\"sos-1-abcd1234\"}", "split packet content");

    /* 粘包：一次读取里两条完整行 */
    wb_line_init(&lb);
    ready = 0;
    feed_str(&lb, "line-one\nline-two\n", &last, &ready, line, sizeof(line));
    CHECK(ready == 2, "sticky packets -> two lines");
    CHECK_STR_EQ(line, "line-two", "last sticky line");

    /* CRLF 与空行 */
    wb_line_init(&lb);
    ready = 0;
    feed_str(&lb, "\r\nabc\r\n\r\n", &last, &ready, line, sizeof(line));
    CHECK(ready == 1, "empty lines ignored");
    CHECK_STR_EQ(line, "abc", "CR stripped");

    /* 超长：第 513 字节起整行丢弃，下一行正常 */
    wb_line_init(&lb);
    ready = 0;
    memset(big, 'x', sizeof(big) - 1);
    big[sizeof(big) - 1] = '\0';
    feed_str(&lb, big, &last, &ready, line, sizeof(line)); /* 512 字节，尚未换行 */
    CHECK(ready == 0 && !lb.discarding, "512 bytes buffered");
    CHECK(wb_line_feed(&lb, (uint8_t)'y') == WB_LINE_EVENT_NONE, "513th byte starts discarding");
    CHECK(lb.discarding, "discarding flag");
    CHECK(wb_line_feed(&lb, (uint8_t)'\n') == WB_LINE_EVENT_OVERFLOW, "overlong line -> overflow");
    ready = 0;
    feed_str(&lb, "ok-after-overflow\n", &last, &ready, line, sizeof(line));
    CHECK(ready == 1 && strcmp(line, "ok-after-overflow") == 0, "recovers after overflow");

    /* 恰好 512 字节行是可接受的 */
    wb_line_init(&lb);
    ready = 0;
    feed_str(&lb, big, &last, &ready, line, sizeof(line));
    CHECK(wb_line_feed(&lb, (uint8_t)'\n') == WB_LINE_EVENT_READY, "exact 512 byte line ready");
    CHECK(lb.len == 0 && strlen(lb.buf) == WB_LINE_MAX_BYTES, "512 byte line preserved");
    CHECK(strncmp(lb.buf, big, WB_LINE_MAX_BYTES) == 0, "512 byte line content");
}

/* 真机 M100 下行不带 '\n'（原样字节）→ 100ms 空闲超时成帧兜底。
 * 这里用可控的 last_byte_ms/now_ms 精确验证 100ms 边界与既有 '\n' 行为不变。 */
static void test_line_idle_framing(void)
{
    wb_line_buf_t lb;
    wb_line_event_t last = WB_LINE_EVENT_NONE;
    int ready = 0;
    char line[WB_LINE_MAX_BYTES + 1] = {0};
    char big[WB_LINE_MAX_BYTES + 1];

    /* 无换行整包：99ms 不成帧，满 100ms 成帧并清空缓冲 */
    wb_line_init(&lb);
    ready = 0;
    feed_str(&lb, "{\"v\":1,\"t\":\"ack\",\"alarm\":\"sos-1-abcd1234\",\"cmd\":\"42\"}", &last,
             &ready, line, sizeof(line));
    CHECK(ready == 0 && lb.len > 0, "no-newline payload buffered, no immediate event");
    CHECK(wb_line_idle_flush(&lb, 1000, 1099) == WB_LINE_EVENT_NONE, "99ms idle: not framed yet");
    CHECK(wb_line_idle_flush(&lb, 1000, 1100) == WB_LINE_EVENT_READY, "100ms idle: framed");
    CHECK_STR_EQ(lb.buf, "{\"v\":1,\"t\":\"ack\",\"alarm\":\"sos-1-abcd1234\",\"cmd\":\"42\"}",
                 "idle framed content");
    CHECK(lb.len == 0, "idle framing clears buffer");
    CHECK(wb_line_idle_flush(&lb, 1000, 5000) == WB_LINE_EVENT_NONE, "empty buffer never frames");

    /* 分片间隔 <100ms：不得提前成帧；最后一片后满 100ms 才成帧 */
    wb_line_init(&lb);
    ready = 0;
    feed_str(&lb, "{\"v\":1,", &last, &ready, line, sizeof(line));
    CHECK(wb_line_idle_flush(&lb, 2000, 2099) == WB_LINE_EVENT_NONE, "fragment1 + 99ms: wait");
    feed_str(&lb, "\"t\":\"ack\"}", &last, &ready, line, sizeof(line));
    CHECK(wb_line_idle_flush(&lb, 2100, 2199) == WB_LINE_EVENT_NONE, "fragment2 + 99ms: wait");
    CHECK(wb_line_idle_flush(&lb, 2100, 2200) == WB_LINE_EVENT_READY, "fragment2 + 100ms: framed");
    CHECK_STR_EQ(lb.buf, "{\"v\":1,\"t\":\"ack\"}", "concatenated fragments framed");

    /* 正常 '\n' 成帧立即生效，且空闲成帧不会重复处理 */
    wb_line_init(&lb);
    ready = 0;
    feed_str(&lb, "with-newline\n", &last, &ready, line, sizeof(line));
    CHECK(ready == 1 && strcmp(line, "with-newline") == 0, "newline framing still immediate");
    CHECK(wb_line_idle_flush(&lb, 3000, 90000) == WB_LINE_EVENT_NONE,
          "no duplicate frame after newline");

    /* 空闲成帧同样去掉行尾 '\r' */
    wb_line_init(&lb);
    feed_str(&lb, "abc\r", &last, &ready, line, sizeof(line));
    CHECK(wb_line_idle_flush(&lb, 4000, 4099) == WB_LINE_EVENT_NONE, "CR fragment 99ms: wait");
    CHECK(wb_line_idle_flush(&lb, 4000, 4100) == WB_LINE_EVENT_READY, "CR fragment 100ms: ready");
    CHECK_STR_EQ(lb.buf, "abc", "idle framing strips CR");

    /* 恰好 512 字节无换行：空闲成帧可接受 */
    wb_line_init(&lb);
    memset(big, 'x', sizeof(big) - 1);
    big[sizeof(big) - 1] = '\0';
    ready = 0;
    feed_str(&lb, big, &last, &ready, line, sizeof(line));
    CHECK(lb.len == WB_LINE_MAX_BYTES && !lb.discarding, "512 bytes buffered");
    CHECK(wb_line_idle_flush(&lb, 5000, 5099) == WB_LINE_EVENT_NONE, "512 bytes 99ms: wait");
    CHECK(wb_line_idle_flush(&lb, 5000, 5100) == WB_LINE_EVENT_READY, "512 bytes idle framed");
    CHECK(strlen(lb.buf) == WB_LINE_MAX_BYTES, "512 byte idle line preserved");

    /* 超长行（>512）即使没有 '\n'，空闲超时也必须整行丢弃并恢复 */
    wb_line_init(&lb);
    feed_str(&lb, big, &last, &ready, line, sizeof(line));
    CHECK(wb_line_feed(&lb, (uint8_t)'y') == WB_LINE_EVENT_NONE && lb.discarding,
          "overlong starts discard");
    CHECK(wb_line_idle_flush(&lb, 6000, 6099) == WB_LINE_EVENT_NONE, "overlong 99ms: still waiting");
    CHECK(wb_line_idle_flush(&lb, 6000, 6100) == WB_LINE_EVENT_OVERFLOW, "overlong idle -> overflow");
    CHECK(!lb.discarding && lb.len == 0, "overflow state cleared");
    ready = 0;
    feed_str(&lb, "ok-after-idle-overflow", &last, &ready, line, sizeof(line));
    CHECK(wb_line_idle_flush(&lb, 7000, 7100) == WB_LINE_EVENT_READY, "recovers after idle overflow");
    CHECK_STR_EQ(lb.buf, "ok-after-idle-overflow", "recovered idle content");
}

/* ---------------------------------------------------------------- 5b. 下行 JSON 解析 */

static void test_downlink_parse(void)
{
    wb_downlink_t dl;

    CHECK(wb_json_parse_downlink("{\"v\":1,\"t\":\"ack\",\"alarm\":\"sos-1-ab12cd\",\"cmd\":\"42\"}",
                                 &dl) == 1,
          "parse real ack");
    CHECK(dl.has_v && dl.v == 1, "v=1");
    CHECK(dl.has_t && strcmp(dl.t, "ack") == 0, "t=ack");
    CHECK(dl.has_alarm && strcmp(dl.alarm, "sos-1-ab12cd") == 0, "alarm parsed");
    CHECK(dl.has_cmd && strcmp(dl.cmd, "42") == 0, "cmd parsed");

    CHECK(wb_json_parse_downlink("config,gps,ok,1,E,1,N,1,0,0,0,t", &dl) == 0,
          "non-json line rejected");
    CHECK(wb_json_parse_downlink("not json at all", &dl) == 0, "garbage rejected");
    CHECK(wb_json_parse_downlink("{oops}", &dl) == 0, "malformed rejected");
    CHECK(wb_json_parse_downlink("{\"t\":\"ack\"} trailing", &dl) == 0, "trailing garbage rejected");
    CHECK(wb_json_parse_downlink("{\"t\":\"ack\"", &dl) == 0, "truncated rejected");
    CHECK(wb_json_parse_downlink("", &dl) == 0, "empty rejected");
    CHECK(wb_json_parse_downlink("{\"t\":\"ack\",\"alarm\":\"a\nb\"}", &dl) == 0,
          "raw control char rejected");

    CHECK(wb_json_parse_downlink("{\"t\":\"ack\",\"alarm\":\"sos-1-a\",\"cmd\":null}", &dl) == 1,
          "cmd null tolerated");
    CHECK(!dl.has_cmd, "cmd null -> missing");

    CHECK(wb_json_parse_downlink("{\"t\":\"ack\",\"alarm\":\"x\",\"extra\":{\"alarm\":\"nested\"}}",
                                 &dl) == 1,
          "nested object skipped");
    CHECK(dl.has_alarm && strcmp(dl.alarm, "x") == 0, "top-level alarm only");

    CHECK(wb_json_parse_downlink("{\"v\":2,\"t\":\"ack\",\"alarm\":\"x\"}", &dl) == 1, "v=2 parses");
    CHECK(dl.has_v && dl.v == 2, "caller sees unsupported version");

    CHECK(wb_json_parse_downlink("{\"t\":\"ack\",\"alarm\":123}", &dl) == 1, "alarm non-string");
    CHECK(!dl.has_alarm, "non-string alarm not accepted");

    CHECK(wb_json_parse_downlink("{\"t\":\"ack\",\"alarm\":\"x\",\"ignored\":[1,2,{\"a\":\"b\"}]}",
                                 &dl) == 1,
          "array skipped");

    /* 超长 alarm：不能截断后误匹配 */
    {
        char frame[512];
        char long_alarm[120];
        memset(long_alarm, 'a', sizeof(long_alarm) - 1);
        long_alarm[sizeof(long_alarm) - 1] = '\0';
        snprintf(frame, sizeof(frame), "{\"t\":\"ack\",\"alarm\":\"%s\"}", long_alarm);
        CHECK(wb_json_parse_downlink(frame, &dl) == 1, "overlong alarm syntax ok");
        CHECK(!dl.has_alarm && dl.alarm_too_long, "overlong alarm flagged, not truncated-match");
    }
}

/* ---------------------------------------------------------------- 8. 蜂鸣节奏 */

static void test_buzzer(void)
{
    wb_buzzer_t bz;

    wb_buzzer_init(&bz);
    CHECK(wb_buzzer_level(&bz, 0) == 0, "idle silent");
    wb_buzzer_start(&bz, 1000);
    CHECK(wb_buzzer_active(&bz), "started");
    CHECK(wb_buzzer_level(&bz, 1000) == 1, "beep immediately at start (<100ms)");
    CHECK(wb_buzzer_level(&bz, 1119) == 1, "beep still on at 119ms");
    CHECK(wb_buzzer_level(&bz, 1120) == 0, "beep off at 120ms");
    CHECK(wb_buzzer_level(&bz, 1240) == 1, "second beep on at 240ms");
    CHECK(wb_buzzer_level(&bz, 1480) == 1, "third beep on at 480ms");
    CHECK(wb_buzzer_level(&bz, 1600) == 0, "third beep off at 600ms");
    CHECK(wb_buzzer_level(&bz, 2400) == 0, "group gap silent");
    /* 第二组从 1520ms 开始，组间静默收紧到 680ms */
    CHECK(wb_buzzer_level(&bz, 2520) == 1, "second group first beep at 1520+1000ms");
    CHECK(wb_buzzer_level(&bz, 3000) == 1, "second group third beep at 3000ms (group gap tightened)");
    CHECK(wb_buzzer_level(&bz, 3300) == 0, "second group inter-group silence");

    /* 前 1.52s 内恰好 3 个“响”的上升沿 */
    {
        int edges = 0;
        int prev = 0;
        uint32_t t;
        for (t = 1000; t < 1000 + 1520; t += 5) {
            int lvl = wb_buzzer_level(&bz, t);
            if (lvl && !prev) {
                edges++;
            }
            prev = lvl;
        }
        CHECK(edges == 3, "exactly 3 short beeps per group");
    }

    /* 30s 自动静音，但每 30s 一条 150ms 单短提示 */
    CHECK(wb_buzzer_level(&bz, 1000 + WB_SOS_MUTE_MS) == 1, "reminder beep starts at 30s");
    CHECK(wb_buzzer_level(&bz, 1000 + WB_SOS_MUTE_MS + 150) == 0, "reminder beep 150ms");
    CHECK(wb_buzzer_level(&bz, 1000 + WB_SOS_MUTE_MS + 30000) == 1, "reminder every 30s");
    CHECK(wb_buzzer_level(&bz, 1000 + WB_SOS_MUTE_MS + 30000 + 200) == 0, "reminder off again");

    /* ACK 立即停止 */
    wb_buzzer_stop(&bz);
    CHECK(!wb_buzzer_active(&bz), "stopped");
    CHECK(wb_buzzer_level(&bz, 1000 + WB_SOS_MUTE_MS + 60000) == 0, "stopped -> silent");
}

/* ---------------------------------------------------------------- 9. 上行帧 */

static void test_uplink_frames(void)
{
    char frame[WB_LINE_MAX_BYTES + 1];
    wb_gps_fix_t fix;
    int n;

    n = wb_build_boot(frame, sizeof(frame), "esp32-sos", "wearable-1.0.0", 0);
    CHECK(n > 0, "build boot");
    CHECK_STR_EQ(frame,
                 "{\"v\":1,\"dev\":\"esp32-sos\",\"t\":\"boot\",\"uptimeMs\":0,"
                 "\"fw\":\"wearable-1.0.0\"}",
                 "boot exact frame");

    n = wb_build_hb(frame, sizeof(frame), "esp32-sos", WB_STATE_IDLE, "", 23456, -1);
    CHECK(n > 0, "build idle hb");
    CHECK_STR_EQ(frame,
                 "{\"v\":1,\"dev\":\"esp32-sos\",\"t\":\"hb\",\"state\":\"IDLE\",\"alarm\":\"\","
                 "\"uptimeMs\":23456}",
                 "idle hb exact frame, csq omitted");

    n = wb_build_hb(frame, sizeof(frame), "esp32-sos", WB_STATE_ALARM, "sos-1-ab12cd", 30000, 26);
    CHECK(n > 0, "build alarm hb");
    CHECK_STR_EQ(frame,
                 "{\"v\":1,\"dev\":\"esp32-sos\",\"t\":\"hb\",\"state\":\"ALARM\","
                 "\"alarm\":\"sos-1-ab12cd\",\"uptimeMs\":30000,\"csq\":26}",
                 "alarm hb exact frame");

    n = wb_build_ack_frame(frame, sizeof(frame), "esp32-sos", "sos-1-ab12cd", "42");
    CHECK(n > 0, "build ack receipt");
    CHECK_STR_EQ(frame,
                 "{\"v\":1,\"dev\":\"esp32-sos\",\"t\":\"ack\",\"alarm\":\"sos-1-ab12cd\","
                 "\"cmd\":\"42\"}",
                 "ack receipt exact frame");

    n = wb_build_ack_frame(frame, sizeof(frame), "esp32-sos", "sos-1-ab12cd", NULL);
    CHECK(n > 0, "build ack receipt without cmd");
    CHECK(strstr(frame, "\"cmd\"") == NULL, "cmd omitted when unknown");

    /* 非法 alarmId 不允许构造上行（避免把坏 ID 发到后端） */
    CHECK(wb_build_ack_frame(frame, sizeof(frame), "esp32-sos", "bad/id", "1") == -1,
          "invalid alarm rejected");
    CHECK(wb_build_sos(frame, sizeof(frame), "esp32-sos", "bad/id", 1, 1, NULL) == -1,
          "invalid alarm sos rejected");

    /* 所有帧都必须在 512 字节以内 */
    wb_gps_clear(&fix);
    fix.valid = 1;
    fix.lat_u6 = 32967100;
    fix.lon_u6 = 112553200;
    fix.fix_uptime_ms = 0;
    n = wb_build_sos(frame, sizeof(frame), "esp32-sos", "sos-4294967295-ffffffff",
                     UINT32_MAX, UINT32_MAX, &fix);
    CHECK(n > 0 && n <= WB_LINE_MAX_BYTES, "max-size sos within 512 bytes");
    CHECK(strstr(frame, "\"gps\":{\"lat\":32.9671,\"lon\":112.5532,\"fix\":true,\"ageMs\":4294967295}") !=
              NULL,
          "positive gps object");

    /* 缓冲区不足必须失败而不是截断出非法 JSON */
    CHECK(wb_build_boot(frame, 8, "esp32-sos", "wearable-1.0.0", 0) == -1, "short buffer rejected");
}

/* ---------------------------------------------------------------- main */

int main(void)
{
    printf("== host_wearable_logic_test ==\n");
    test_debounce();
    test_alarm_id();
    test_event_retry_same_id();
    test_ack_matching();
    test_restart_recovery();
    test_json_escape();
    test_gps_degradation();
    test_line_framing();
    test_line_idle_framing();
    test_downlink_parse();
    test_buzzer();
    test_uplink_frames();

    printf("\n%d passed, %d failed\n", g_pass, g_fail);
    if (g_fail != 0) {
        printf("RESULT: FAIL\n");
        return 1;
    }
    printf("RESULT: PASS\n");
    return 0;
}
