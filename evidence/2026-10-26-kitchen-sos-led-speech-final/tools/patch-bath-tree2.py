#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Apply the LOCAL-ALARM-SPEECH-FINAL patch set to the bathroom private source tree
(competition/esp32-node/.local/bathroom-voice-20261026/src/main/{node_main.c,alarm_logic.h}).

The public kitchen tree was edited by hand first. The bathroom copy is an older baseline
(no KEY0, no alarm_id_build, no SOS delivery tracking), so the anchors below are the
bathroom-specific ones. Every anchor must match exactly once or the script aborts without
writing, so the two trees cannot silently diverge. Bath-specific logic (GPIO15 SOS, PIR,
water sensor, volume 30) is untouched.
"""
import sys

BASE = r'D:\OpenHarmony\competition\esp32-node\.local\bathroom-voice-20261026\src\main'
NODE = BASE + r'\node_main.c'
LOGIC = BASE + r'\alarm_logic.h'

PATCHES = []

# --- 1) global announce state replaces the old continuous-buzzer deadline -------------
PATCHES.append((
"""static int64_t s_buzzer_until_ms = 0;   /* 告警限时鸣响截止时刻；0=无限（旧行为） */""",
"""/* 短提示音 → 完整语音的编排状态（2026-10-26 LOCAL-ALARM-SPEECH-FINAL）
 * 旧行为：告警时 buzzer(1) 连续响 CONFIG_NODE_ALARM_BEEP_SEC(10) 秒，同时立刻播放语音，
 * 3 秒左右的人声被 10 秒连续蜂鸣完全遮盖（用户实测“只听到滴滴几声”）。而且 sos.pcm
 * 本身是正弦提示音而非人声。现在：先响 N 声短提示音，蜂鸣停止后再播完整中文语音，
 * 二者不重叠；stop/ACK/异常解除会立即取消提示音与语音。 */
static int     s_chirp_left = 0;        /* 还需要响几声 */
static int     s_chirp_on = 0;          /* 当前处于“响”段 */
static int64_t s_chirp_next_ms = 0;     /* 下一次翻转时刻 */
static int     s_voice_pending = 0;     /* 提示音结束后要播报的片段 */
static int64_t s_voice_due_ms = 0;      /* 语音最早开始时刻 */"""))

# --- 2) announce engine right after buzzer() -----------------------------------------
PATCHES.append((
"""static void buzzer(int on)
{
#if CONFIG_NODE_BUZZER_XL9555
    xl9555_beep(on);
#elif CONFIG_NODE_BUZZER_GPIO >= 0
    gpio_set_level(CONFIG_NODE_BUZZER_GPIO, on ? 1 : 0);
#else
    (void)on;
#endif
}""",
"""static void buzzer(int on)
{
#if CONFIG_NODE_BUZZER_XL9555
    xl9555_beep(on);
#elif CONFIG_NODE_BUZZER_GPIO >= 0
    gpio_set_level(CONFIG_NODE_BUZZER_GPIO, on ? 1 : 0);
#else
    (void)on;
#endif
}

/* ---------------- 短提示音 → 完整语音（蜂鸣与语音不重叠） ----------------
 * SOS 响 CONFIG_NODE_ALARM_CHIRP_COUNT_SOS 声、其它告警响 CONFIG_NODE_ALARM_CHIRP_COUNT 声，
 * 每声 ON_MS，声间 GAP_MS；最后一声结束后等 VOICE_GAP_MS 才播报完整语音。
 * 全部非阻塞：只切换蜂鸣器电平 + 投递一次语音请求，不影响采集/上报。 */
static void announce_cancel(void)
{
    buzzer(0);
    s_chirp_left = 0;
    s_chirp_on = 0;
    s_chirp_next_ms = 0;
    s_voice_pending = VOICE_CLIP_NONE;
    s_voice_due_ms = 0;
    local_voice_cancel();
}

static void announce_start(int clip)
{
    int beeps = (clip == VOICE_CLIP_SOS) ? CONFIG_NODE_ALARM_CHIRP_COUNT_SOS
                                         : CONFIG_NODE_ALARM_CHIRP_COUNT;
    int64_t now;
    if (beeps < 1) beeps = 1;
    announce_cancel();          /* 新提醒先清掉上一轮残留，避免提示音/语音叠播 */
    now = now_ms();
    s_voice_pending = clip;
    s_chirp_left = beeps;
    s_chirp_on = 1;
    buzzer(1);
    s_chirp_next_ms = now + CONFIG_NODE_ALARM_CHIRP_ON_MS;
    s_voice_due_ms = now + (int64_t)beeps * CONFIG_NODE_ALARM_CHIRP_ON_MS
                   + (int64_t)(beeps - 1) * CONFIG_NODE_ALARM_CHIRP_GAP_MS
                   + CONFIG_NODE_ALARM_VOICE_GAP_MS;
    ESP_LOGW(TAG, "告警提示音开始：%d 声，间隔 %d ms；随后播报 clip=%d（%s）",
             beeps, (int)CONFIG_NODE_ALARM_CHIRP_GAP_MS, clip, local_voice_text(clip));
}

/* 主循环每 100 ms 调用一次（在 sos_handle_fast 末尾）。到点才翻转蜂鸣器/开始语音。 */
static void announce_tick(void)
{
    int64_t now = now_ms();
    if (s_chirp_left > 0 && now >= s_chirp_next_ms) {
        if (s_chirp_on) {
            buzzer(0);
            s_chirp_on = 0;
            s_chirp_left--;
            s_chirp_next_ms = now + CONFIG_NODE_ALARM_CHIRP_GAP_MS;
        } else {
            buzzer(1);
            s_chirp_on = 1;
            s_chirp_next_ms = now + CONFIG_NODE_ALARM_CHIRP_ON_MS;
        }
    }
    if (s_voice_pending != VOICE_CLIP_NONE && s_chirp_left == 0 && !s_chirp_on &&
        now >= s_voice_due_ms) {
        int clip = s_voice_pending;
        s_voice_pending = VOICE_CLIP_NONE;
        local_voice_play(clip);   /* 此时蜂鸣器已停，人声不会被遮盖 */
        ESP_LOGW(TAG, "语音播报开始：clip=%d（%s）", clip, local_voice_text(clip));
    }
}"""))

# --- 3) SOS "press again after stop" branch ------------------------------------------
PATCHES.append((
"""            buzzer(1);
            s_buzzer_until_ms = (CONFIG_NODE_ALARM_BEEP_SEC > 0)
                ? (now_ms() + (int64_t)CONFIG_NODE_ALARM_BEEP_SEC * 1000) : 0;
            local_voice_alarm("MANUAL_SOS");""",
"""            announce_start(VOICE_CLIP_SOS);"""))

# --- 4) ACK (bath baseline has no s_sos_pending_since) -------------------------------
PATCHES.append((
"""            s_state = 3;
            s_acked_armed = 0;   /* 危险仍在：先不武装，避免 ACK 后立刻重复告警 */
            s_buzzer_until_ms = 0;
            s_user_stopped = 0;
            buzzer(0);           /* ACK 立即静音；保留 alarmId / alarm.type */
            local_voice_cancel();""",
"""            s_state = 3;
            s_acked_armed = 0;   /* 危险仍在：先不武装，避免 ACK 后立刻重复告警 */
            s_user_stopped = 0;
            announce_cancel();   /* ACK 立即静音：提示音+语音都停；保留 alarmId / alarm.type */"""))

# --- 5) stop --------------------------------------------------------------------------
PATCHES.append((
"""            s_user_stopped = 1;
            s_buzzer_until_ms = 0;
            buzzer(0);
            local_voice_cancel();""",
"""            s_user_stopped = 1;
            announce_cancel();"""))

# --- 6) pause (NO_MOTION) -------------------------------------------------------------
PATCHES.append((
"""                s_user_stopped = 0;
                buzzer(0);
                local_voice_cancel();""",
"""                s_user_stopped = 0;
                announce_cancel();"""))

# --- 7) reset -------------------------------------------------------------------------
PATCHES.append((
"""        s_state = 0;
        s_acked_armed = 0;
        s_buzzer_until_ms = 0;
        s_user_stopped = 0;
        s_alarm_id[0] = '\\0';
        s_alarm_type[0] = '\\0';
        buzzer(0);
        local_voice_cancel();""",
"""        s_state = 0;
        s_acked_armed = 0;
        s_user_stopped = 0;
        s_alarm_id[0] = '\\0';
        s_alarm_type[0] = '\\0';
        announce_cancel();"""))

# --- 8) forward declaration -----------------------------------------------------------
PATCHES.append((
""" * 再次出现时，必须照常报警，否则 ACK 会变成永久屏蔽真实危险的开关。 */
static void raise_alarm(const char *type, const char *detail)""",
""" * 再次出现时，必须照常报警，否则 ACK 会变成永久屏蔽真实危险的开关。 */
static int voice_clip_for_alarm(const char *type);   /* 定义见下 */

static void raise_alarm(const char *type, const char *detail)"""))

# --- 9) raise_alarm body (bath baseline) ---------------------------------------------
PATCHES.append((
"""    s_last_remind_ms = now_ms();     /* 新告警立即播放，并作为限频提醒基准 */
    buzzer(1);
    local_voice_alarm(type); /* once per accepted new alarm; never blocks sensing */
    s_buzzer_until_ms = (CONFIG_NODE_ALARM_BEEP_SEC > 0)
        ? (now_ms() + (int64_t)CONFIG_NODE_ALARM_BEEP_SEC * 1000) : 0;""",
"""    s_last_remind_ms = now_ms();     /* 新告警立即播放，并作为限频提醒基准 */
    /* 先短提示音、蜂鸣停止后再播完整语音（文案由真实触发原因决定） */
    announce_start(voice_clip_for_alarm(type));"""))

# --- 10) voice_clip_for_alarm definition after raise_alarm ----------------------------
PATCHES.append((
"""    ESP_LOGW(TAG, "%s -> ALARM（%s，type=%s）语音+蜂鸣已请求", detail, s_alarm_id, type);
}

/* 当前最高优先级的危险类型""",
"""    ESP_LOGW(TAG, "%s -> ALARM（%s，type=%s）语音+蜂鸣已请求", detail, s_alarm_id, type);
}

/* 文案必须对应真实触发原因：温度/湿度/两者分别播报，读数无效时才用兜底文案。
 * 厨房/卫生间当前启用后可能触发的类型只有 MANUAL_SOS / CLIMATE / NO_MOTION；
 * GAS/SMOKE 阈值 4096（禁用）、WATER GPIO -1（未接），不会产生告警。若将来启用，
 * 必须另加对应文案，不能拿温湿度文案冒充。 */
static int voice_clip_for_alarm(const char *type)
{
    if (!type || type[0] == '\\0') return VOICE_CLIP_CLIMATE_GENERIC;
    if (strcmp(type, "MANUAL_SOS") == 0) return VOICE_CLIP_SOS;
    if (strcmp(type, "NO_MOTION") == 0) return VOICE_CLIP_NO_MOTION;
    if (strcmp(type, "CLIMATE") == 0) {
        int reason = climate_reason_code(s_climate_valid, s_temp_c, s_rh,
                                         CONFIG_NODE_TEMP_LOW_C, CONFIG_NODE_TEMP_HIGH_C,
                                         CONFIG_NODE_RH_LOW, CONFIG_NODE_RH_HIGH);
        ESP_LOGI(TAG, "温湿度告警原因判定：temp=%.1f rh=%.1f valid=%d -> reason=%d",
                 (double)s_temp_c, (double)s_rh, s_climate_valid, reason);
        if (reason == CLIMATE_REASON_TEMP) return VOICE_CLIP_CLIMATE_TEMP;
        if (reason == CLIMATE_REASON_RH) return VOICE_CLIP_CLIMATE_RH;
        if (reason == CLIMATE_REASON_BOTH) return VOICE_CLIP_CLIMATE_BOTH;
        return VOICE_CLIP_CLIMATE_GENERIC;
    }
    ESP_LOGW(TAG, "告警类型 %s 无专用语音文案，使用通用环境提示（不冒充温湿度原因）", type);
    return VOICE_CLIP_CLIMATE_GENERIC;
}

/* 当前最高优先级的危险类型"""))

# --- 11) recoverable auto-clear (bath baseline) --------------------------------------
PATCHES.append((
"""            s_state = 0;
            s_user_stopped = 0;
            s_buzzer_until_ms = 0;
            s_alarm_id[0] = '\\0';
            s_alarm_type[0] = '\\0';
            buzzer(0);
            local_voice_cancel();""",
"""            s_state = 0;
            s_user_stopped = 0;
            s_alarm_id[0] = '\\0';
            s_alarm_type[0] = '\\0';
            announce_cancel();"""))

# --- 12) rate-limited reminder -------------------------------------------------------
PATCHES.append((
"""    s_last_remind_ms = now;
    buzzer(1);
    s_buzzer_until_ms = (CONFIG_NODE_ALARM_BEEP_SEC > 0)
        ? (now + (int64_t)CONFIG_NODE_ALARM_BEEP_SEC * 1000) : 0;
    local_voice_alarm(s_alarm_type);""",
"""    s_last_remind_ms = now;
    /* 限频提醒同样遵循“短提示音 -> 完整语音”，原因文案与本次告警类型一致 */
    announce_start(voice_clip_for_alarm(s_alarm_type));"""))

# --- 13) 100 ms tick: buzzer timeout -> announce engine ------------------------------
PATCHES.append((
"""    /* 告警限时鸣响：到时自动静音，但告警状态保留（仍需 ACK/reset） */
    if (s_buzzer_until_ms != 0 && now_ms() >= s_buzzer_until_ms) {
        s_buzzer_until_ms = 0;
        buzzer(0);
        ESP_LOGI(TAG, "告警鸣响到时，自动静音（告警状态保留）");
    }
}""",
"""    /* 短提示音 -> 完整语音编排：只在到点切换蜂鸣器电平/开始语音，非阻塞 */
    announce_tick();
}"""))

# --- 14) bench-only listening command ------------------------------------------------
PATCHES.append((
"""        } else if (strcmp(rest, "reboot") == 0) {""",
"""        } else if (strncmp(rest, "voice", 5) == 0) {
            /* 台架试听：直接播报某个片段（不产生云端事件、不改告警状态）。
             * inj voice 1..6 = SOS/温度/湿度/两者/无活动/通用；inj voice seq 3 = 提示音+语音。 */
            const char *arg = rest + 5;
            while (*arg == ' ') arg++;
            if (strncmp(arg, "seq", 3) == 0) {
                int clip = atoi(arg + 3);
                if (clip > 0 && clip <= VOICE_CLIP_MAX) announce_start(clip);
                else ESP_LOGW(TAG, "INJ voice seq 参数非法: %s", arg);
            } else {
                int clip = atoi(arg);
                if (clip > 0 && clip <= VOICE_CLIP_MAX) {
                    ESP_LOGW(TAG, "INJ 试听 clip=%d（%s）", clip, local_voice_text(clip));
                    announce_cancel();
                    local_voice_play(clip);
                } else {
                    ESP_LOGW(TAG, "INJ voice 参数非法: %s", arg);
                }
            }
        } else if (strcmp(rest, "reboot") == 0) {"""))

LOGIC_OLD = """/* ---------------- 持续告警限频提醒 ----------------"""
LOGIC_NEW = """/* ---------------- 温湿度告警原因（决定语音文案，禁止张冠李戴） ----------------
 * 告警状态机只保存 "CLIMATE" 一个类型，但播报必须说清到底是温度、湿度还是两者异常。
 * 在“触发那一刻”用同一条有效读数与同一组阈值判定原因：
 *   valid=0（本次读数无效）→ 无法判断原因 → UNKNOWN，只能播通用文案；
 *   温度越界、湿度未越界 → TEMP；反之 RH；两者都越界 → BOTH。
 * 注意：这是“播报措辞”，不改变告警判定（判定仍由 climate_stab_update 决定）。 */
#define CLIMATE_REASON_UNKNOWN 0
#define CLIMATE_REASON_TEMP    1
#define CLIMATE_REASON_RH      2
#define CLIMATE_REASON_BOTH    3

static inline int climate_reason_code(int valid, float temp, float rh,
                                      int temp_low, int temp_high,
                                      int rh_low, int rh_high)
{
    int t_bad, r_bad;
    if (!valid) return CLIMATE_REASON_UNKNOWN;
    t_bad = (temp < (float)temp_low) || (temp > (float)temp_high);
    r_bad = (rh < (float)rh_low) || (rh > (float)rh_high);
    if (t_bad && r_bad) return CLIMATE_REASON_BOTH;
    if (t_bad) return CLIMATE_REASON_TEMP;
    if (r_bad) return CLIMATE_REASON_RH;
    return CLIMATE_REASON_UNKNOWN;
}

/* ---------------- 持续告警限频提醒 ----------------"""


def main():
    with open(NODE, 'r', encoding='utf-8') as f:
        text = f.read()
    failed = False
    for i, (old, new) in enumerate(PATCHES, 1):
        n = text.count(old)
        if n != 1:
            print('PATCH %d: anchor count = %d (expected 1) -> ABORT' % (i, n))
            failed = True
            continue
        text = text.replace(old, new)
    if failed:
        sys.exit('node_main.c patch aborted; file NOT written')
    if 's_buzzer_until_ms' in text:
        sys.exit('node_main.c still references s_buzzer_until_ms; patch incomplete')
    if 'local_voice_alarm' in text:
        sys.exit('node_main.c still calls removed local_voice_alarm(); patch incomplete')
    with open(NODE, 'w', encoding='utf-8', newline='\n') as f:
        f.write(text)
    print('node_main.c patched: %d hunks' % len(PATCHES))

    with open(LOGIC, 'r', encoding='utf-8') as f:
        lt = f.read()
    if lt.count(LOGIC_OLD) != 1:
        sys.exit('alarm_logic.h anchor count != 1: %d' % lt.count(LOGIC_OLD))
    lt = lt.replace(LOGIC_OLD, LOGIC_NEW)
    with open(LOGIC, 'w', encoding='utf-8', newline='\n') as f:
        f.write(lt)
    print('alarm_logic.h patched: climate_reason_code added')
    print('BATH_PATCH_OK')


if __name__ == '__main__':
    main()
