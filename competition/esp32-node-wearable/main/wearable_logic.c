/* wearable_logic.c —— 随身 SOS 纯逻辑实现（无 ESP-IDF 依赖，主机 gcc 可单测）
 *
 * 见 wearable_logic.h 顶部说明与 DESIGN-CONTRACT.md §3/§6。
 */
#include "wearable_logic.h"

#include <stdio.h>
#include <string.h>

/* ================================================================ 基础工具 */

static void wb_str_copy(char *dst, size_t cap, const char *src)
{
    size_t n = 0;
    if (!dst || cap == 0) {
        return;
    }
    if (src) {
        while (src[n] != '\0' && n + 1 < cap) {
            dst[n] = src[n];
            n++;
        }
    }
    dst[n] = '\0';
}

static int wb_is_digit(char c)
{
    return c >= '0' && c <= '9';
}

static char wb_ascii_lower(char c)
{
    if (c >= 'A' && c <= 'Z') {
        return (char)(c - 'A' + 'a');
    }
    return c;
}

/* ================================================================ 按键消抖 */

void wb_debounce_init(wb_debounce_t *deb)
{
    if (!deb) {
        return;
    }
    memset(deb, 0, sizeof(*deb));
}

wb_btn_event_t wb_debounce_update(wb_debounce_t *deb, int raw_pressed, uint32_t now_ms)
{
    if (!deb) {
        return WB_BTN_EVENT_NONE;
    }
    raw_pressed = raw_pressed ? 1 : 0;

    if (!deb->initialized) {
        /* 上电第一次采样只建立基线，不伪造“按下”；按住上电也不会误触发事件。 */
        deb->initialized = 1;
        deb->stable_pressed = raw_pressed;
        deb->candidate_pressed = raw_pressed;
        deb->candidate_since_ms = now_ms;
        return WB_BTN_EVENT_NONE;
    }

    if (raw_pressed != deb->candidate_pressed) {
        /* 采样值变化：重新计时，必须连续稳定 60ms。抖动期间反复重置。 */
        deb->candidate_pressed = raw_pressed;
        deb->candidate_since_ms = now_ms;
        return WB_BTN_EVENT_NONE;
    }

    if (deb->candidate_pressed == deb->stable_pressed) {
        return WB_BTN_EVENT_NONE;
    }

    if (!wb_time_reached(now_ms, deb->candidate_since_ms + WB_BTN_DEBOUNCE_MS)) {
        return WB_BTN_EVENT_NONE;
    }

    deb->stable_pressed = deb->candidate_pressed;
    return deb->stable_pressed ? WB_BTN_EVENT_PRESS : WB_BTN_EVENT_RELEASE;
}

/* ================================================================ alarmId */

int wb_alarm_id_valid(const char *alarm_id)
{
    size_t n;
    size_t i;

    if (!alarm_id) {
        return 0;
    }
    n = strlen(alarm_id);
    if (n < 1 || n > WB_ALARM_ID_MAX_LEN) {
        return 0;
    }
    for (i = 0; i < n; i++) {
        char c = alarm_id[i];
        int ok = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
                 c == '.' || c == '_' || c == ':' || c == '-';
        if (!ok) {
            return 0;
        }
    }
    return 1;
}

int wb_alarm_id_format(char *out, size_t cap, uint32_t counter, const uint8_t rand4[4])
{
    static const char hexd[] = "0123456789abcdef";
    int n;

    if (!out || cap == 0 || !rand4) {
        return -1;
    }
    n = snprintf(out, cap, "sos-%lu-%c%c%c%c%c%c%c%c",
                 (unsigned long)counter,
                 hexd[(rand4[0] >> 4) & 0x0F], hexd[rand4[0] & 0x0F],
                 hexd[(rand4[1] >> 4) & 0x0F], hexd[rand4[1] & 0x0F],
                 hexd[(rand4[2] >> 4) & 0x0F], hexd[rand4[2] & 0x0F],
                 hexd[(rand4[3] >> 4) & 0x0F], hexd[rand4[3] & 0x0F]);
    if (n < 0 || (size_t)n >= cap) {
        return -1;
    }
    if (!wb_alarm_id_valid(out)) {
        return -1;
    }
    return n;
}

int wb_alarm_id_counter(const char *alarm_id, uint32_t *out_counter)
{
    const char *p;
    uint32_t value = 0;
    int digits = 0;

    if (!wb_alarm_id_valid(alarm_id)) {
        return 0;
    }
    if (strncmp(alarm_id, "sos-", 4) != 0) {
        return 0;
    }
    p = alarm_id + 4;
    while (wb_is_digit(*p)) {
        uint32_t d = (uint32_t)(*p - '0');
        if (value > (UINT32_MAX - d) / 10u) {
            return 0;
        }
        value = value * 10u + d;
        p++;
        digits++;
    }
    if (digits == 0 || *p != '-') {
        return 0;
    }
    p++;
    if (strlen(p) != 8) {
        return 0;
    }
    for (int i = 0; i < 8; i++) {
        char c = p[i];
        int ok = wb_is_digit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
        if (!ok) {
            return 0;
        }
    }
    if (out_counter) {
        *out_counter = value;
    }
    return 1;
}

/* ================================================================ 事件状态 */

void wb_event_init(wb_event_t *ev, wb_ack_memo_t *memo)
{
    if (ev) {
        memset(ev, 0, sizeof(*ev));
        ev->state = WB_STATE_IDLE;
    }
    if (memo) {
        memset(memo, 0, sizeof(*memo));
    }
}

int wb_event_active(const wb_event_t *ev)
{
    return ev && ev->state == WB_STATE_ALARM;
}

int wb_event_start(wb_event_t *ev, const char *alarm_id, uint32_t now_ms)
{
    if (!ev || !alarm_id || !wb_alarm_id_valid(alarm_id)) {
        return 0;
    }
    if (ev->state != WB_STATE_IDLE) {
        /* 已有未确认事件：绝不换新 alarmId。 */
        return 0;
    }
    ev->state = WB_STATE_ALARM;
    wb_str_copy(ev->alarm_id, sizeof(ev->alarm_id), alarm_id);
    ev->cmd_id[0] = '\0';
    ev->has_cmd = 0;
    ev->start_uptime_ms = now_ms;
    ev->last_sos_ms = now_ms;
    ev->seq = 0;
    return 1;
}

void wb_event_note_sent(wb_event_t *ev, uint32_t now_ms)
{
    if (ev) {
        ev->last_sos_ms = now_ms;
    }
}

int wb_event_should_resend(wb_event_t *ev, uint32_t now_ms, uint32_t interval_ms)
{
    if (!wb_event_active(ev)) {
        return 0;
    }
    if (interval_ms == 0) {
        interval_ms = WB_SOS_RETRY_MS;
    }
    if (!wb_time_reached(now_ms, ev->last_sos_ms + interval_ms)) {
        return 0;
    }
    ev->last_sos_ms = now_ms;
    return 1;
}

wb_ack_result_t wb_event_handle_ack(wb_event_t *ev, wb_ack_memo_t *memo, const char *alarm_id,
                                    const char *cmd_id, int cmd_present, uint32_t now_ms)
{
    if (!ev || !memo || !alarm_id || alarm_id[0] == '\0') {
        return WB_ACK_REJECTED_ALARM;
    }
    if (cmd_present && !cmd_id) {
        cmd_present = 0;
    }

    if (ev->state == WB_STATE_ALARM) {
        if (strcmp(alarm_id, ev->alarm_id) != 0) {
            /* §3.2：alarm 不等于当前事件时一律忽略，不改变告警状态。 */
            return WB_ACK_REJECTED_ALARM;
        }
        if (cmd_present && ev->has_cmd && strcmp(cmd_id, ev->cmd_id) != 0) {
            /* 已收到过命令，再收到不一致的 cmd：拒绝，避免伪造设备回执。 */
            return WB_ACK_REJECTED_CMD;
        }
        if (cmd_present) {
            wb_str_copy(ev->cmd_id, sizeof(ev->cmd_id), cmd_id);
            ev->has_cmd = 1;
        }

        /* 记录“已确认事件”，用于识别适配器重复投递的同一 ACK。 */
        memo->valid = 1;
        memo->acked_uptime_ms = now_ms;
        wb_str_copy(memo->alarm_id, sizeof(memo->alarm_id), alarm_id);
        memo->has_cmd = 0;
        if (cmd_present) {
            wb_str_copy(memo->cmd_id, sizeof(memo->cmd_id), cmd_id);
            memo->has_cmd = 1;
        } else if (ev->has_cmd) {
            wb_str_copy(memo->cmd_id, sizeof(memo->cmd_id), ev->cmd_id);
            memo->has_cmd = 1;
        }

        /* 结束事件：置 IDLE，下次按键会生成新计数器 alarmId。 */
        ev->state = WB_STATE_IDLE;
        ev->alarm_id[0] = '\0';
        ev->cmd_id[0] = '\0';
        ev->has_cmd = 0;
        ev->seq = 0;
        return WB_ACK_ACCEPTED;
    }

    /* 已 IDLE：可能是同一 ACK 的重复投递（适配器至少投递 3 次）。 */
    if (memo->valid && strcmp(alarm_id, memo->alarm_id) == 0) {
        if (cmd_present) {
            if (memo->has_cmd && strcmp(cmd_id, memo->cmd_id) != 0) {
                return WB_ACK_REJECTED_CMD;
            }
            if (!memo->has_cmd) {
                wb_str_copy(memo->cmd_id, sizeof(memo->cmd_id), cmd_id);
                memo->has_cmd = 1;
            }
        }
        return WB_ACK_DUPLICATE;
    }
    return WB_ACK_REJECTED_ALARM;
}

/* ================================================================ NVS 快照 */

static uint32_t wb_fnv1a(const uint8_t *data, size_t len)
{
    uint32_t h = 2166136261u;
    size_t i;
    for (i = 0; i < len; i++) {
        h ^= (uint32_t)data[i];
        h *= 16777619u;
    }
    return h;
}

static uint32_t wb_persist_checksum(const wb_persist_t *p)
{
    return wb_fnv1a((const uint8_t *)p, offsetof(wb_persist_t, checksum));
}

void wb_persist_init(wb_persist_t *p)
{
    if (!p) {
        return;
    }
    memset(p, 0, sizeof(*p));
    p->magic = WB_PERSIST_MAGIC;
    p->version = WB_PERSIST_VERSION;
    p->checksum = wb_persist_checksum(p);
}

void wb_persist_from_event(wb_persist_t *p, const wb_event_t *ev, const wb_ack_memo_t *memo,
                           uint32_t counter)
{
    if (!p) {
        return;
    }
    memset(p, 0, sizeof(*p));
    p->magic = WB_PERSIST_MAGIC;
    p->version = WB_PERSIST_VERSION;
    p->counter = counter;
    if (ev && ev->state == WB_STATE_ALARM) {
        p->flags = 1;
        wb_str_copy(p->alarm_id, sizeof(p->alarm_id), ev->alarm_id);
        if (ev->has_cmd) {
            wb_str_copy(p->cmd_id, sizeof(p->cmd_id), ev->cmd_id);
        }
    }
    if (memo && memo->valid) {
        wb_str_copy(p->memo_alarm, sizeof(p->memo_alarm), memo->alarm_id);
        if (memo->has_cmd) {
            wb_str_copy(p->memo_cmd, sizeof(p->memo_cmd), memo->cmd_id);
        }
    }
    p->checksum = wb_persist_checksum(p);
}

int wb_persist_restore(const wb_persist_t *p, wb_event_t *ev, wb_ack_memo_t *memo,
                       uint32_t *counter, uint32_t now_ms, int *was_active)
{
    uint32_t parsed = 0;
    uint32_t restored_counter = 0;

    if (was_active) {
        *was_active = 0;
    }
    if (!p || !ev || !memo || !counter) {
        return 0;
    }
    if (p->magic != WB_PERSIST_MAGIC || p->version != WB_PERSIST_VERSION) {
        return 0;
    }
    if (p->checksum != wb_persist_checksum(p)) {
        return 0;
    }

    wb_event_init(ev, memo);
    restored_counter = *counter;
    if (restored_counter < p->counter) {
        restored_counter = p->counter;
    }

    if ((p->flags & 0x0001u) != 0) {
        if (!wb_alarm_id_valid(p->alarm_id)) {
            return 0;
        }
        if (!wb_event_start(ev, p->alarm_id, now_ms)) {
            return 0;
        }
        /* 重启后立即重发同一 alarmId（契约 §6：不得静默丢弃）。 */
        ev->last_sos_ms = now_ms - WB_SOS_RETRY_MS;
        if (p->cmd_id[0] != '\0') {
            wb_str_copy(ev->cmd_id, sizeof(ev->cmd_id), p->cmd_id);
            ev->has_cmd = 1;
        }
        if (was_active) {
            *was_active = 1;
        }
    }

    if (p->memo_alarm[0] != '\0' && wb_alarm_id_valid(p->memo_alarm)) {
        wb_str_copy(memo->alarm_id, sizeof(memo->alarm_id), p->memo_alarm);
        memo->valid = 1;
        if (p->memo_cmd[0] != '\0') {
            wb_str_copy(memo->cmd_id, sizeof(memo->cmd_id), p->memo_cmd);
            memo->has_cmd = 1;
        }
    }

    /* 计数器单调：NVS counter 与 alarmId 内嵌计数取较大值，避免回退重用 ID。 */
    if (wb_alarm_id_counter(p->alarm_id, &parsed) && parsed > restored_counter) {
        restored_counter = parsed;
    }
    *counter = restored_counter;
    return 1;
}

/* ================================================================ 蜂鸣器 */

static uint32_t wb_sos_group_gap_ms(int group_index)
{
    int32_t gap = WB_SOS_GROUP_GAP_MS - group_index * WB_SOS_GROUP_GAP_STEP_MS;
    if (gap < WB_SOS_GROUP_GAP_MIN_MS) {
        gap = WB_SOS_GROUP_GAP_MIN_MS;
    }
    return (uint32_t)gap;
}

void wb_buzzer_init(wb_buzzer_t *bz)
{
    if (bz) {
        memset(bz, 0, sizeof(*bz));
    }
}

void wb_buzzer_start(wb_buzzer_t *bz, uint32_t now_ms)
{
    if (!bz) {
        return;
    }
    bz->active = 1;
    bz->start_ms = now_ms;
}

void wb_buzzer_stop(wb_buzzer_t *bz)
{
    if (!bz) {
        return;
    }
    bz->active = 0;
    bz->start_ms = 0;
}

int wb_buzzer_active(const wb_buzzer_t *bz)
{
    return bz && bz->active;
}

uint32_t wb_buzzer_elapsed_ms(const wb_buzzer_t *bz, uint32_t now_ms)
{
    if (!bz || !bz->active) {
        return 0;
    }
    return now_ms - bz->start_ms;
}

int wb_buzzer_level(const wb_buzzer_t *bz, uint32_t now_ms)
{
    uint32_t elapsed;
    uint32_t beeps_span;
    uint32_t cursor;
    int group;

    if (!bz || !bz->active) {
        return 0;
    }
    elapsed = now_ms - bz->start_ms;

    if (elapsed >= WB_SOS_MUTE_MS) {
        /* 30s 后：自动静音，但每 30s 一条 150ms 单短提示，直到 ACK。 */
        uint32_t t = elapsed - WB_SOS_MUTE_MS;
        return (t % WB_REMIND_INTERVAL_MS) < WB_REMIND_BEEP_MS ? 1 : 0;
    }

    beeps_span = (uint32_t)WB_SOS_BEEPS_PER_GROUP * (WB_SOS_BEEP_ON_MS + WB_SOS_BEEP_OFF_MS);
    cursor = 0;
    for (group = 0; group < 64; group++) {
        uint32_t group_len = beeps_span + wb_sos_group_gap_ms(group);
        if (elapsed < cursor + group_len) {
            uint32_t pos = elapsed - cursor;
            uint32_t within;
            if (pos >= beeps_span) {
                return 0; /* 组间静默 */
            }
            within = pos % (WB_SOS_BEEP_ON_MS + WB_SOS_BEEP_OFF_MS);
            return within < WB_SOS_BEEP_ON_MS ? 1 : 0;
        }
        cursor += group_len;
    }
    return 0;
}

/* ================================================================ JSON 输出 */

typedef struct {
    char *out;
    size_t cap;
    size_t len;
    int overflow;
} wb_jw_t;

static void wb_jw_raw(wb_jw_t *w, const char *s, size_t n)
{
    if (!w || w->overflow) {
        return;
    }
    if (w->len + n >= w->cap) {
        w->overflow = 1;
        return;
    }
    memcpy(w->out + w->len, s, n);
    w->len += n;
}

static void wb_jw_cstr(wb_jw_t *w, const char *s)
{
    if (s) {
        wb_jw_raw(w, s, strlen(s));
    }
}

static void wb_jw_char(wb_jw_t *w, char c)
{
    wb_jw_raw(w, &c, 1);
}

static void wb_jw_u64(wb_jw_t *w, uint64_t v)
{
    char tmp[20];
    size_t n = 0;
    size_t i;
    do {
        tmp[n++] = (char)('0' + (int)(v % 10u));
        v /= 10u;
    } while (v != 0 && n < sizeof(tmp));
    for (i = 0; i < n / 2; i++) {
        char t = tmp[i];
        tmp[i] = tmp[n - 1 - i];
        tmp[n - 1 - i] = t;
    }
    wb_jw_raw(w, tmp, n);
}

static void wb_jw_u32(wb_jw_t *w, uint32_t v)
{
    wb_jw_u64(w, (uint64_t)v);
}

static void wb_jw_quoted(wb_jw_t *w, const char *s)
{
    static const char hexd[] = "0123456789abcdef";
    wb_jw_char(w, '"');
    if (s) {
        const unsigned char *p = (const unsigned char *)s;
        while (*p != '\0' && !w->overflow) {
            unsigned char c = *p++;
            switch (c) {
            case '"':
                wb_jw_raw(w, "\\\"", 2);
                break;
            case '\\':
                wb_jw_raw(w, "\\\\", 2);
                break;
            case '\b':
                wb_jw_raw(w, "\\b", 2);
                break;
            case '\f':
                wb_jw_raw(w, "\\f", 2);
                break;
            case '\n':
                wb_jw_raw(w, "\\n", 2);
                break;
            case '\r':
                wb_jw_raw(w, "\\r", 2);
                break;
            case '\t':
                wb_jw_raw(w, "\\t", 2);
                break;
            default:
                if (c < 0x20) {
                    char esc[6];
                    esc[0] = '\\';
                    esc[1] = 'u';
                    esc[2] = '0';
                    esc[3] = '0';
                    esc[4] = hexd[(c >> 4) & 0x0F];
                    esc[5] = hexd[c & 0x0F];
                    wb_jw_raw(w, esc, 6);
                } else {
                    wb_jw_char(w, (char)c);
                }
                break;
            }
        }
    }
    if (!w->overflow) {
        wb_jw_char(w, '"');
    }
}

static void wb_jw_deg(wb_jw_t *w, int64_t u6)
{
    int neg = u6 < 0;
    uint64_t absv = neg ? (uint64_t)(-(u6 + 1)) + 1u : (uint64_t)u6;
    uint64_t ip = absv / 1000000u;
    uint32_t fp = (uint32_t)(absv % 1000000u);

    if (neg) {
        wb_jw_char(w, '-');
    }
    wb_jw_u64(w, ip);
    if (fp != 0) {
        char frac[6];
        int n = 6;
        int i;
        for (i = 5; i >= 0; i--) {
            frac[i] = (char)('0' + (int)(fp % 10u));
            fp /= 10u;
        }
        while (n > 0 && frac[n - 1] == '0') {
            n--;
        }
        wb_jw_char(w, '.');
        wb_jw_raw(w, frac, (size_t)n);
    }
}

static int wb_jw_finish(wb_jw_t *w)
{
    if (!w || w->overflow || !w->out) {
        return -1;
    }
    if (w->len >= w->cap) {
        return -1;
    }
    w->out[w->len] = '\0';
    if (w->len > WB_LINE_MAX_BYTES) {
        return -1;
    }
    return (int)w->len;
}

static void wb_jw_header(wb_jw_t *w, const char *dev)
{
    if (!dev || dev[0] == '\0') {
        dev = "esp32-sos";
    }
    wb_jw_cstr(w, "{\"v\":1,");
    wb_jw_cstr(w, "\"dev\":");
    wb_jw_quoted(w, dev);
}

int wb_build_boot(char *out, size_t cap, const char *dev, const char *fw, uint32_t uptime_ms)
{
    wb_jw_t w = {out, cap, 0, 0};
    wb_jw_header(&w, dev);
    wb_jw_cstr(&w, ",\"t\":\"boot\"");
    wb_jw_cstr(&w, ",\"uptimeMs\":");
    wb_jw_u32(&w, uptime_ms);
    wb_jw_cstr(&w, ",\"fw\":");
    wb_jw_quoted(&w, fw ? fw : "wearable-1.0.0");
    wb_jw_char(&w, '}');
    return wb_jw_finish(&w);
}

int wb_build_sos(char *out, size_t cap, const char *dev, const char *alarm_id,
                 uint32_t uptime_ms, uint32_t seq, const wb_gps_fix_t *fix)
{
    wb_jw_t w = {out, cap, 0, 0};

    if (!wb_alarm_id_valid(alarm_id)) {
        return -1;
    }
    wb_jw_header(&w, dev);
    wb_jw_cstr(&w, ",\"t\":\"sos\",\"alarm\":");
    wb_jw_quoted(&w, alarm_id);
    wb_jw_cstr(&w, ",\"uptimeMs\":");
    wb_jw_u32(&w, uptime_ms);
    wb_jw_cstr(&w, ",\"seq\":");
    wb_jw_u32(&w, seq);
    wb_jw_cstr(&w, ",\"gps\":");
    if (fix && fix->valid) {
        uint32_t age = uptime_ms - fix->fix_uptime_ms;
        wb_jw_cstr(&w, "{\"lat\":");
        wb_jw_deg(&w, fix->lat_u6);
        wb_jw_cstr(&w, ",\"lon\":");
        wb_jw_deg(&w, fix->lon_u6);
        wb_jw_cstr(&w, ",\"fix\":true,\"ageMs\":");
        wb_jw_u32(&w, age);
        wb_jw_char(&w, '}');
    } else {
        wb_jw_cstr(&w, "null");
    }
    wb_jw_char(&w, '}');
    return wb_jw_finish(&w);
}

/* 电量（契约 §2）：字段顺序与居家节点一致，便于同一个 adapter/后端解析。
 * 只在 batt 非空时输出；无效读数一律 null（绝不写 0/猜测值）。 */
static void wb_jw_battery(wb_jw_t *w, const wb_battery_t *batt)
{
    if (!batt) return;
    wb_jw_cstr(w, ",\"battery\":{\"source\":\"battery\",\"present\":");
    wb_jw_cstr(w, batt->present ? "true" : "false");
    wb_jw_cstr(w, ",\"valid\":");
    wb_jw_cstr(w, batt->valid ? "true" : "false");
    wb_jw_cstr(w, ",\"mv\":");
    if (batt->valid && batt->mv > 0) {
        wb_jw_u32(w, (uint32_t)batt->mv);
    } else {
        wb_jw_cstr(w, "null");
    }
    wb_jw_cstr(w, ",\"percent\":");
    if (batt->valid && batt->calibrated && batt->percent >= 0 && batt->percent <= 100) {
        wb_jw_u32(w, (uint32_t)batt->percent);
    } else {
        wb_jw_cstr(w, "null");
    }
    wb_jw_cstr(w, ",\"low\":");
    wb_jw_cstr(w, (batt->valid && batt->low) ? "true" : "false");
    wb_jw_cstr(w, ",\"calibrated\":");
    wb_jw_cstr(w, batt->calibrated ? "true" : "false");
    wb_jw_cstr(w, ",\"reason\":");
    wb_jw_quoted(w, batt->reason ? batt->reason : "");
    wb_jw_char(w, '}');
}

int wb_build_hb_ex(char *out, size_t cap, const char *dev, wb_state_t state,
                   const char *alarm_id, uint32_t uptime_ms, int csq,
                   const wb_battery_t *batt)
{
    wb_jw_t w = {out, cap, 0, 0};

    wb_jw_header(&w, dev);
    wb_jw_cstr(&w, ",\"t\":\"hb\",\"state\":");
    wb_jw_quoted(&w, state == WB_STATE_ALARM ? "ALARM" : "IDLE");
    wb_jw_cstr(&w, ",\"alarm\":");
    wb_jw_quoted(&w, (state == WB_STATE_ALARM && alarm_id) ? alarm_id : "");
    wb_jw_cstr(&w, ",\"uptimeMs\":");
    wb_jw_u32(&w, uptime_ms);
    if (csq >= 0) {
        wb_jw_cstr(&w, ",\"csq\":");
        wb_jw_u32(&w, (uint32_t)csq);
    }
    /* 电量：未接电池/未启用时 batt==NULL -> 帧里没有 battery 字段（旧协议不变） */
    wb_jw_battery(&w, batt);
    wb_jw_char(&w, '}');
    return wb_jw_finish(&w);
}

int wb_build_hb(char *out, size_t cap, const char *dev, wb_state_t state,
                const char *alarm_id, uint32_t uptime_ms, int csq)
{
    /* 旧签名保持不变：调用方没有电量数据时不会多出任何字段 */
    return wb_build_hb_ex(out, cap, dev, state, alarm_id, uptime_ms, csq, NULL);
}

int wb_build_ack_frame(char *out, size_t cap, const char *dev, const char *alarm_id,
                       const char *cmd_id)
{
    wb_jw_t w = {out, cap, 0, 0};

    if (!wb_alarm_id_valid(alarm_id)) {
        return -1;
    }
    wb_jw_header(&w, dev);
    wb_jw_cstr(&w, ",\"t\":\"ack\",\"alarm\":");
    wb_jw_quoted(&w, alarm_id);
    if (cmd_id && cmd_id[0] != '\0') {
        wb_jw_cstr(&w, ",\"cmd\":");
        wb_jw_quoted(&w, cmd_id);
    }
    wb_jw_char(&w, '}');
    return wb_jw_finish(&w);
}

int wb_json_escape(const char *in, char *out, size_t cap)
{
    static const char hexd[] = "0123456789abcdef";
    size_t len = 0;
    const unsigned char *p;

    if (!in || !out || cap == 0) {
        return -1;
    }
    for (p = (const unsigned char *)in; *p != '\0'; p++) {
        char tmp[6];
        size_t n = 0;
        unsigned char c = *p;
        switch (c) {
        case '"':
            tmp[0] = '\\';
            tmp[1] = '"';
            n = 2;
            break;
        case '\\':
            tmp[0] = '\\';
            tmp[1] = '\\';
            n = 2;
            break;
        case '\b':
            tmp[0] = '\\';
            tmp[1] = 'b';
            n = 2;
            break;
        case '\f':
            tmp[0] = '\\';
            tmp[1] = 'f';
            n = 2;
            break;
        case '\n':
            tmp[0] = '\\';
            tmp[1] = 'n';
            n = 2;
            break;
        case '\r':
            tmp[0] = '\\';
            tmp[1] = 'r';
            n = 2;
            break;
        case '\t':
            tmp[0] = '\\';
            tmp[1] = 't';
            n = 2;
            break;
        default:
            if (c < 0x20) {
                tmp[0] = '\\';
                tmp[1] = 'u';
                tmp[2] = '0';
                tmp[3] = '0';
                tmp[4] = hexd[(c >> 4) & 0x0F];
                tmp[5] = hexd[c & 0x0F];
                n = 6;
            } else {
                tmp[0] = (char)c;
                n = 1;
            }
            break;
        }
        if (len + n + 1 > cap) {
            return -1;
        }
        memcpy(out + len, tmp, n);
        len += n;
    }
    out[len] = '\0';
    return (int)len;
}

/* ================================================================ JSON 下行解析 */

static void wb_json_ws(const char **pp, const char *end)
{
    while (*pp < end) {
        char c = **pp;
        if (c == ' ' || c == '\t' || c == '\r' || c == '\n') {
            (*pp)++;
        } else {
            break;
        }
    }
}

static int wb_json_hexval(char c)
{
    if (c >= '0' && c <= '9') {
        return c - '0';
    }
    if (c >= 'a' && c <= 'f') {
        return c - 'a' + 10;
    }
    if (c >= 'A' && c <= 'F') {
        return c - 'A' + 10;
    }
    return -1;
}

static void wb_json_put(char *out, size_t cap, size_t *len, int *truncated, char c)
{
    if (!out) {
        return;
    }
    if (*len + 1 < cap) {
        out[(*len)++] = c;
    } else if (truncated) {
        *truncated = 1;
    }
}

static void wb_json_emit_cp(char *out, size_t cap, size_t *len, int *truncated, uint32_t cp)
{
    if (cp < 0x80u) {
        wb_json_put(out, cap, len, truncated, (char)cp);
    } else if (cp < 0x800u) {
        wb_json_put(out, cap, len, truncated, (char)(0xC0u | (cp >> 6)));
        wb_json_put(out, cap, len, truncated, (char)(0x80u | (cp & 0x3Fu)));
    } else if (cp < 0x10000u) {
        wb_json_put(out, cap, len, truncated, (char)(0xE0u | (cp >> 12)));
        wb_json_put(out, cap, len, truncated, (char)(0x80u | ((cp >> 6) & 0x3Fu)));
        wb_json_put(out, cap, len, truncated, (char)(0x80u | (cp & 0x3Fu)));
    } else {
        wb_json_put(out, cap, len, truncated, (char)(0xF0u | (cp >> 18)));
        wb_json_put(out, cap, len, truncated, (char)(0x80u | ((cp >> 12) & 0x3Fu)));
        wb_json_put(out, cap, len, truncated, (char)(0x80u | ((cp >> 6) & 0x3Fu)));
        wb_json_put(out, cap, len, truncated, (char)(0x80u | (cp & 0x3Fu)));
    }
}

static int wb_parse_json_string(const char **pp, const char *end, char *out, size_t cap,
                                int *truncated)
{
    const char *p = *pp;
    size_t len = 0;

    if (truncated) {
        *truncated = 0;
    }
    if (out && cap > 0) {
        out[0] = '\0';
    }
    if (p >= end || *p != '"') {
        return 0;
    }
    p++;
    while (p < end) {
        unsigned char c = (unsigned char)*p;
        if (c == '"') {
            p++;
            if (out && cap > 0) {
                out[len < cap ? len : cap - 1] = '\0';
            }
            *pp = p;
            return 1;
        }
        if (c == '\\') {
            char esc;
            p++;
            if (p >= end) {
                return 0;
            }
            esc = *p++;
            switch (esc) {
            case '"':
                wb_json_put(out, cap, &len, truncated, '"');
                break;
            case '\\':
                wb_json_put(out, cap, &len, truncated, '\\');
                break;
            case '/':
                wb_json_put(out, cap, &len, truncated, '/');
                break;
            case 'b':
                wb_json_put(out, cap, &len, truncated, '\b');
                break;
            case 'f':
                wb_json_put(out, cap, &len, truncated, '\f');
                break;
            case 'n':
                wb_json_put(out, cap, &len, truncated, '\n');
                break;
            case 'r':
                wb_json_put(out, cap, &len, truncated, '\r');
                break;
            case 't':
                wb_json_put(out, cap, &len, truncated, '\t');
                break;
            case 'u': {
                int h0;
                int h1;
                int h2;
                int h3;
                uint32_t cp;
                if (p + 4 > end) {
                    return 0;
                }
                h0 = wb_json_hexval(p[0]);
                h1 = wb_json_hexval(p[1]);
                h2 = wb_json_hexval(p[2]);
                h3 = wb_json_hexval(p[3]);
                if (h0 < 0 || h1 < 0 || h2 < 0 || h3 < 0) {
                    return 0;
                }
                cp = ((uint32_t)h0 << 12) | ((uint32_t)h1 << 8) | ((uint32_t)h2 << 4) |
                     (uint32_t)h3;
                p += 4;
                if (cp >= 0xD800u && cp <= 0xDBFFu) {
                    if (p + 6 <= end && p[0] == '\\' && p[1] == 'u') {
                        int l0 = wb_json_hexval(p[2]);
                        int l1 = wb_json_hexval(p[3]);
                        int l2 = wb_json_hexval(p[4]);
                        int l3 = wb_json_hexval(p[5]);
                        if (l0 >= 0 && l1 >= 0 && l2 >= 0 && l3 >= 0) {
                            uint32_t lo = ((uint32_t)l0 << 12) | ((uint32_t)l1 << 8) |
                                          ((uint32_t)l2 << 4) | (uint32_t)l3;
                            if (lo >= 0xDC00u && lo <= 0xDFFFu) {
                                cp = 0x10000u + ((cp - 0xD800u) << 10) + (lo - 0xDC00u);
                                p += 6;
                            } else {
                                cp = 0xFFFDu;
                            }
                        } else {
                            cp = 0xFFFDu;
                        }
                    } else {
                        cp = 0xFFFDu;
                    }
                } else if (cp >= 0xDC00u && cp <= 0xDFFFu) {
                    cp = 0xFFFDu;
                }
                wb_json_emit_cp(out, cap, &len, truncated, cp);
                break;
            }
            default:
                return 0;
            }
        } else if (c < 0x20u) {
            /* JSON 不允许未转义的控制字符 */
            return 0;
        } else {
            wb_json_put(out, cap, &len, truncated, (char)c);
            p++;
        }
    }
    return 0;
}

static int wb_skip_json_number(const char **pp, const char *end)
{
    const char *p = *pp;

    if (p < end && *p == '-') {
        p++;
    }
    if (p >= end) {
        return 0;
    }
    if (*p == '0') {
        p++;
    } else if (*p >= '1' && *p <= '9') {
        while (p < end && wb_is_digit(*p)) {
            p++;
        }
    } else {
        return 0;
    }
    if (p < end && *p == '.') {
        p++;
        if (p >= end || !wb_is_digit(*p)) {
            return 0;
        }
        while (p < end && wb_is_digit(*p)) {
            p++;
        }
    }
    if (p < end && (*p == 'e' || *p == 'E')) {
        p++;
        if (p < end && (*p == '+' || *p == '-')) {
            p++;
        }
        if (p >= end || !wb_is_digit(*p)) {
            return 0;
        }
        while (p < end && wb_is_digit(*p)) {
            p++;
        }
    }
    *pp = p;
    return 1;
}

static int wb_skip_json_value(const char **pp, const char *end, int depth)
{
    const char *p;

    if (depth > 8) {
        return 0;
    }
    wb_json_ws(pp, end);
    p = *pp;
    if (p >= end) {
        return 0;
    }
    if (*p == '"') {
        return wb_parse_json_string(pp, end, NULL, 0, NULL);
    }
    if (*p == '{') {
        p++;
        wb_json_ws(&p, end);
        if (p < end && *p == '}') {
            *pp = p + 1;
            return 1;
        }
        while (p < end) {
            wb_json_ws(&p, end);
            if (p >= end || *p != '"') {
                return 0;
            }
            if (!wb_parse_json_string(&p, end, NULL, 0, NULL)) {
                return 0;
            }
            wb_json_ws(&p, end);
            if (p >= end || *p != ':') {
                return 0;
            }
            p++;
            if (!wb_skip_json_value(&p, end, depth + 1)) {
                return 0;
            }
            wb_json_ws(&p, end);
            if (p < end && *p == ',') {
                p++;
                continue;
            }
            if (p < end && *p == '}') {
                *pp = p + 1;
                return 1;
            }
            return 0;
        }
        return 0;
    }
    if (*p == '[') {
        p++;
        wb_json_ws(&p, end);
        if (p < end && *p == ']') {
            *pp = p + 1;
            return 1;
        }
        while (p < end) {
            if (!wb_skip_json_value(&p, end, depth + 1)) {
                return 0;
            }
            wb_json_ws(&p, end);
            if (p < end && *p == ',') {
                p++;
                continue;
            }
            if (p < end && *p == ']') {
                *pp = p + 1;
                return 1;
            }
            return 0;
        }
        return 0;
    }
    if (p + 4 <= end && strncmp(p, "true", 4) == 0) {
        *pp = p + 4;
        return 1;
    }
    if (p + 5 <= end && strncmp(p, "false", 5) == 0) {
        *pp = p + 5;
        return 1;
    }
    if (p + 4 <= end && strncmp(p, "null", 4) == 0) {
        *pp = p + 4;
        return 1;
    }
    if (*p == '-' || wb_is_digit(*p)) {
        return wb_skip_json_number(pp, end);
    }
    return 0;
}

static int wb_parse_json_int(const char **pp, const char *end, int *out)
{
    const char *p = *pp;
    int neg = 0;
    long long value = 0;
    int digits = 0;

    if (p < end && *p == '-') {
        neg = 1;
        p++;
    }
    while (p < end && wb_is_digit(*p)) {
        if (value < 100000000LL) {
            value = value * 10 + (*p - '0');
        }
        p++;
        digits++;
    }
    if (digits == 0) {
        return 0;
    }
    if (p < end && (*p == '.' || *p == 'e' || *p == 'E')) {
        return 0; /* 只接受整型 v */
    }
    *pp = p;
    *out = (int)(neg ? -value : value);
    return 1;
}

int wb_json_parse_downlink(const char *line, wb_downlink_t *out)
{
    const char *p;
    const char *end;

    if (!line || !out) {
        return 0;
    }
    memset(out, 0, sizeof(*out));
    p = line;
    end = line + strlen(line);
    wb_json_ws(&p, end);
    if (p >= end || *p != '{') {
        return 0;
    }
    p++;
    wb_json_ws(&p, end);
    if (p < end && *p == '}') {
        p++;
        wb_json_ws(&p, end);
        return p == end;
    }
    while (p < end) {
        char key[24];
        int key_truncated = 0;
        int is_t;
        int is_v;
        int is_alarm;
        int is_cmd;
        int is_dev;

        wb_json_ws(&p, end);
        if (p >= end || *p != '"') {
            return 0;
        }
        if (!wb_parse_json_string(&p, end, key, sizeof(key), &key_truncated)) {
            return 0;
        }
        wb_json_ws(&p, end);
        if (p >= end || *p != ':') {
            return 0;
        }
        p++;
        wb_json_ws(&p, end);
        if (p >= end) {
            return 0;
        }

        is_t = !key_truncated && strcmp(key, "t") == 0;
        is_v = !key_truncated && strcmp(key, "v") == 0;
        is_alarm = !key_truncated && strcmp(key, "alarm") == 0;
        is_cmd = !key_truncated && strcmp(key, "cmd") == 0;
        is_dev = !key_truncated && strcmp(key, "dev") == 0;

        if (is_v) {
            const char *save = p;
            int value = 0;
            if (wb_parse_json_int(&p, end, &value)) {
                out->has_v = 1;
                out->v = value;
            } else {
                p = save;
                if (!wb_skip_json_value(&p, end, 1)) {
                    return 0;
                }
            }
        } else if ((is_t || is_alarm || is_cmd || is_dev) && *p == '"') {
            int truncated = 0;
            if (is_t) {
                if (!wb_parse_json_string(&p, end, out->t, sizeof(out->t), &truncated)) {
                    return 0;
                }
                if (!truncated) {
                    out->has_t = 1;
                }
            } else if (is_alarm) {
                if (!wb_parse_json_string(&p, end, out->alarm, sizeof(out->alarm), &truncated)) {
                    return 0;
                }
                if (truncated) {
                    out->alarm_too_long = 1;
                } else {
                    out->has_alarm = 1;
                }
            } else if (is_cmd) {
                if (!wb_parse_json_string(&p, end, out->cmd, sizeof(out->cmd), &truncated)) {
                    return 0;
                }
                if (truncated) {
                    out->cmd_too_long = 1;
                } else {
                    out->has_cmd = 1;
                }
            } else {
                if (!wb_parse_json_string(&p, end, out->dev, sizeof(out->dev), &truncated)) {
                    return 0;
                }
                if (!truncated) {
                    out->has_dev = 1;
                }
            }
        } else {
            if (!wb_skip_json_value(&p, end, 1)) {
                return 0;
            }
        }

        wb_json_ws(&p, end);
        if (p < end && *p == ',') {
            p++;
            continue;
        }
        if (p < end && *p == '}') {
            p++;
            break;
        }
        return 0;
    }
    wb_json_ws(&p, end);
    return p == end;
}

/* ================================================================ UART 分帧 */

void wb_line_init(wb_line_buf_t *lb)
{
    if (lb) {
        memset(lb, 0, sizeof(*lb));
    }
}

wb_line_event_t wb_line_feed(wb_line_buf_t *lb, uint8_t byte)
{
    if (!lb) {
        return WB_LINE_EVENT_NONE;
    }
    if (byte == (uint8_t)'\n') {
        size_t n;
        if (lb->discarding) {
            lb->discarding = 0;
            lb->len = 0;
            return WB_LINE_EVENT_OVERFLOW;
        }
        n = lb->len;
        if (n > 0 && lb->buf[n - 1] == '\r') {
            n--;
        }
        lb->buf[n] = '\0';
        lb->len = 0;
        if (n == 0) {
            return WB_LINE_EVENT_NONE;
        }
        return WB_LINE_EVENT_READY;
    }
    if (lb->discarding) {
        return WB_LINE_EVENT_NONE;
    }
    if (lb->len >= WB_LINE_MAX_BYTES) {
        /* 第 513 个字节：整行作废，丢弃到下一个换行（或空闲超时成帧）。 */
        lb->discarding = 1;
        lb->len = 0;
        return WB_LINE_EVENT_NONE;
    }
    lb->buf[lb->len++] = (char)byte;
    return WB_LINE_EVENT_NONE;
}

wb_line_event_t wb_line_idle_flush(wb_line_buf_t *lb, uint32_t last_byte_ms, uint32_t now_ms)
{
    size_t n;

    if (!lb) {
        return WB_LINE_EVENT_NONE;
    }
    /* 正常 '\n' 成帧后缓冲区为空，此函数恒 NONE（不改变既有行为）。 */
    if (lb->len == 0 && !lb->discarding) {
        return WB_LINE_EVENT_NONE;
    }
    if (!wb_time_reached(now_ms, last_byte_ms + WB_UART_IDLE_FLUSH_MS)) {
        return WB_LINE_EVENT_NONE;
    }
    if (lb->discarding) {
        /* 超长行等不到 '\n'：空闲超时同样整行丢弃，并允许下一行重新开始。 */
        lb->discarding = 0;
        lb->len = 0;
        return WB_LINE_EVENT_OVERFLOW;
    }
    n = lb->len;
    if (n > 0 && lb->buf[n - 1] == '\r') {
        n--;
    }
    lb->buf[n] = '\0';
    lb->len = 0;
    if (n == 0) {
        return WB_LINE_EVENT_NONE;
    }
    return WB_LINE_EVENT_READY;
}

/* ================================================================ DTU 回包 */

#define WB_CSV_MAX_FIELDS 24

typedef struct {
    const char *ptr;
    size_t len;
} wb_csv_field_t;

static int wb_csv_split(const char *line, wb_csv_field_t *fields, int max_fields, int *out_count)
{
    int count = 0;
    const char *p = line;

    for (;;) {
        const char *comma = strchr(p, ',');
        const char *field_end = comma ? comma : p + strlen(p);
        const char *start = p;
        const char *end = field_end;

        while (start < end && (*start == ' ' || *start == '\t')) {
            start++;
        }
        while (end > start && (end[-1] == ' ' || end[-1] == '\t' || end[-1] == '\r')) {
            end--;
        }
        if (count >= max_fields) {
            return 0;
        }
        fields[count].ptr = start;
        fields[count].len = (size_t)(end - start);
        count++;
        if (!comma) {
            break;
        }
        p = comma + 1;
    }
    if (out_count) {
        *out_count = count;
    }
    return 1;
}

static int wb_field_eq(const wb_csv_field_t *f, const char *s)
{
    size_t n = strlen(s);
    return f->len == n && strncmp(f->ptr, s, n) == 0;
}

static int wb_field_eq_ci(const wb_csv_field_t *f, const char *s)
{
    size_t n = strlen(s);
    size_t i;
    if (f->len != n) {
        return 0;
    }
    for (i = 0; i < n; i++) {
        if (wb_ascii_lower(f->ptr[i]) != wb_ascii_lower(s[i])) {
            return 0;
        }
    }
    return 1;
}

static int wb_parse_abs_u6(const wb_csv_field_t *f, uint32_t max_whole, int64_t *out)
{
    const char *p;
    size_t n;
    size_t i = 0;
    int neg = 0;
    int digits = 0;
    int frac_digits = 0;
    int64_t ip = 0;
    int64_t frac = 0;
    int64_t value;

    if (!f || f->len == 0 || f->len > 20 || !out) {
        return 0;
    }
    p = f->ptr;
    n = f->len;
    if (p[i] == '+' || p[i] == '-') {
        neg = p[i] == '-';
        i++;
    }
    while (i < n && wb_is_digit(p[i])) {
        ip = ip * 10 + (int64_t)(p[i] - '0');
        if (ip > 100000000LL) {
            return 0;
        }
        i++;
        digits++;
    }
    if (digits == 0) {
        return 0;
    }
    if (i < n && p[i] == '.') {
        i++;
        while (i < n && wb_is_digit(p[i])) {
            if (frac_digits < 6) {
                frac = frac * 10 + (int64_t)(p[i] - '0');
                frac_digits++;
            }
            i++;
        }
        if (frac_digits == 0) {
            return 0;
        }
        while (frac_digits < 6) {
            frac *= 10;
            frac_digits++;
        }
    }
    if (i != n) {
        return 0;
    }
    value = ip * 1000000LL + frac;
    if (value > (int64_t)max_whole * 1000000LL) {
        return 0;
    }
    *out = neg ? -value : value;
    return 1;
}

void wb_gps_clear(wb_gps_fix_t *fix)
{
    if (fix) {
        memset(fix, 0, sizeof(*fix));
    }
}

int wb_gps_is_fresh(const wb_gps_fix_t *fix, uint32_t now_ms, uint32_t max_age_ms)
{
    uint32_t age;
    if (!fix || !fix->valid) {
        return 0;
    }
    age = now_ms - fix->fix_uptime_ms;
    return age <= max_age_ms;
}

wb_gps_result_t wb_gps_parse_line(const char *line, wb_gps_fix_t *fix, uint32_t now_ms)
{
    wb_csv_field_t f[WB_CSV_MAX_FIELDS];
    int nf = 0;
    int64_t lon_abs = 0;
    int64_t lat_abs = 0;

    wb_gps_clear(fix);
    if (!line) {
        return WB_GPS_NOT_RESPONSE;
    }
    if (!wb_csv_split(line, f, WB_CSV_MAX_FIELDS, &nf)) {
        return WB_GPS_NOT_RESPONSE;
    }
    if (nf < 3) {
        return WB_GPS_NOT_RESPONSE;
    }
    if (!wb_field_eq_ci(&f[0], "config") || !wb_field_eq_ci(&f[1], "gps") ||
        !wb_field_eq_ci(&f[2], "ok")) {
        return WB_GPS_NOT_RESPONSE;
    }
    /* 扩展包至少需要 flag,EW,lon,NS,lat + 1 个后续字段（speed/time），共 9 段；
     * 少于该长度视为短包：没有显式 fix 标志，只能 NO_FIX，绝不伪造成有效坐标。 */
    if (nf < 9) {
        return WB_GPS_NO_FIX;
    }
    if (wb_field_eq(&f[3], "0")) {
        return WB_GPS_NO_FIX;
    }
    if (!wb_field_eq(&f[3], "1")) {
        return WB_GPS_NO_FIX;
    }
    if (!(wb_field_eq_ci(&f[4], "E") || wb_field_eq_ci(&f[4], "W"))) {
        return WB_GPS_NO_FIX;
    }
    if (!(wb_field_eq_ci(&f[6], "N") || wb_field_eq_ci(&f[6], "S"))) {
        return WB_GPS_NO_FIX;
    }
    if (!wb_parse_abs_u6(&f[5], 180, &lon_abs)) {
        return WB_GPS_NO_FIX;
    }
    if (!wb_parse_abs_u6(&f[7], 90, &lat_abs)) {
        return WB_GPS_NO_FIX;
    }
    if (lon_abs == 0 || lat_abs == 0) {
        /* 零坐标不是有效定位（契约要求绝不伪装）。 */
        return WB_GPS_NO_FIX;
    }
    if (fix) {
        fix->valid = 1;
        fix->lon_u6 = wb_field_eq_ci(&f[4], "W") ? -lon_abs : lon_abs;
        fix->lat_u6 = wb_field_eq_ci(&f[6], "S") ? -lat_abs : lat_abs;
        fix->fix_uptime_ms = now_ms;
    }
    return WB_GPS_FIX;
}

int wb_parse_csq_line(const char *line, int *out_csq)
{
    wb_csv_field_t f[WB_CSV_MAX_FIELDS];
    int nf = 0;
    int value = 0;
    size_t i;

    if (!line) {
        return 0;
    }
    if (!wb_csv_split(line, f, WB_CSV_MAX_FIELDS, &nf)) {
        return 0;
    }
    if (nf < 4) {
        return 0;
    }
    if (!wb_field_eq_ci(&f[0], "config") || !wb_field_eq_ci(&f[1], "csq") ||
        !wb_field_eq_ci(&f[2], "ok")) {
        return 0;
    }
    if (f[3].len < 1 || f[3].len > 2) {
        return 0;
    }
    for (i = 0; i < f[3].len; i++) {
        if (!wb_is_digit(f[3].ptr[i])) {
            return 0;
        }
        value = value * 10 + (f[3].ptr[i] - '0');
    }
    if (value < 0 || value > 31) {
        return 0; /* 99=未知、其余非法：心跳不带 csq */
    }
    if (out_csq) {
        *out_csq = value;
    }
    return 1;
}

int wb_dtu_is_config_line(const char *line)
{
    static const char prefix[] = "config,";
    size_t i;

    if (!line) {
        return 0;
    }
    for (i = 0; i < sizeof(prefix) - 1; i++) {
        if (line[i] == '\0') {
            return 0;
        }
        if (wb_ascii_lower(line[i]) != prefix[i]) {
            return 0;
        }
    }
    return 1;
}
