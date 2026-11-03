/* alarm_logic.h —— 与 ESP 硬件无关的纯逻辑（主机侧可直接编译测试）
 *
 * 收口四类判定，node_main.c 只做 I/O（I2C/ADC/GPIO/MQTT），判定逻辑全部在这里：
 *   1) MQ 连续确认 + 回差（独立计数、失败不参与、阈值>=4096 完全禁用）
 *   2) 告警状态机：何时允许新建告警 / ACK 是否接受 / ACK 后重新武装
 *   3) NTP 首次同步只允许重置"无活动计时"（仅 PIR 启用时）
 *   4) JSON valid 语义（本次读取成功才为 true）
 */
#ifndef ALARM_LOGIC_H
#define ALARM_LOGIC_H

#include <string.h>
#include <stdio.h>

/* ---------------- MQ 连续确认 + 回差 ---------------- */
typedef struct {
    int danger;   /* 1=已确认危险 */
    int streak;   /* 连续满足条件的次数 */
} mq_stab_t;

static inline void mq_stab_reset(mq_stab_t *s)
{
    s->danger = 0;
    s->streak = 0;
}

/* 返回更新后的 danger（1=危险）。
 * 语义：
 *   无效读数(valid=0)：既不判危险，也不判危险消失（直接返回当前状态）
 *   阈值>=4096：告警禁用，danger 恒为 0
 *   未危险：连续 confirm 次 raw>=threshold 才置危险；任一有效安全值清零计数
 *   已危险：连续 confirm 次 raw< threshold-hysteresis 才解除；灰色区维持危险
 */
static inline int mq_stab_update(mq_stab_t *s, int valid, int raw, int threshold, int hysteresis, int confirm)
{
    int clear_level;

    if (!valid) return s->danger;
    if (threshold >= 4096) { s->danger = 0; s->streak = 0; return 0; }
    if (confirm < 1) confirm = 1;
    clear_level = threshold - hysteresis;
    if (clear_level < 0) clear_level = 0;

    if (!s->danger) {
        if (raw >= threshold) {
            if (++s->streak >= confirm) { s->danger = 1; s->streak = 0; }
        } else {
            s->streak = 0;
        }
    } else {
        if (raw < clear_level) {
            if (++s->streak >= confirm) { s->danger = 0; s->streak = 0; }
        } else {
            s->streak = 0;   /* 灰色区：维持原状态 */
        }
    }
    return s->danger;
}

/* ---------------- 告警状态机 ---------------- */
#define ALARM_STATE_NORMAL 0
#define ALARM_STATE_WARN   1
#define ALARM_STATE_ALARM  2
#define ALARM_STATE_ACKED  3

typedef struct {
    int  state;
    char type[24];
    char id[40];
    int  acked_armed;   /* ACKED 后该危险是否已确认消失（重新武装） */
    int  buzzer;        /* 1=响 0=静音（仅反映决定，不操作硬件） */
} alarm_sm_t;

static inline void alarm_sm_init(alarm_sm_t *sm)
{
    sm->state = ALARM_STATE_NORMAL;
    sm->type[0] = '\0';
    sm->id[0] = '\0';
    sm->acked_armed = 0;
    sm->buzzer = 0;
}

/* 是否允许为该类型新建告警（含 1 秒内同类型去重由调用方负责） */
static inline int alarm_raise_allowed(int state, const char *cur_type, int acked_armed, const char *new_type)
{
    if (state == ALARM_STATE_ALARM && cur_type && strcmp(cur_type, new_type) == 0) return 0;
    if (state == ALARM_STATE_ACKED && cur_type && strcmp(cur_type, new_type) == 0 && !acked_armed) return 0;
    return 1;
}

/* 新建告警：返回 1 表示需要生成新 ID、响铃 */
static inline int alarm_sm_raise(alarm_sm_t *sm, const char *type, const char *new_id)
{
    if (!alarm_raise_allowed(sm->state, sm->type, sm->acked_armed, type)) return 0;
    sm->state = ALARM_STATE_ALARM;
    strncpy(sm->type, type, sizeof(sm->type) - 1);
    sm->type[sizeof(sm->type) - 1] = '\0';
    strncpy(sm->id, new_id, sizeof(sm->id) - 1);
    sm->id[sizeof(sm->id) - 1] = '\0';
    sm->acked_armed = 0;
    sm->buzzer = 1;
    return 1;
}

/* ACK：仅 ALARM 且 ID 精确匹配才接受；接受后立即静音并保留 type/id */
static inline int alarm_sm_ack(alarm_sm_t *sm, const char *req_id)
{
    if (sm->state != ALARM_STATE_ALARM) return 0;
    if (sm->id[0] == '\0' || !req_id || strcmp(sm->id, req_id) != 0) return 0;
    sm->state = ALARM_STATE_ACKED;
    sm->acked_armed = 0;
    sm->buzzer = 0;   /* ACK 立即静音，保留 alarmId/type */
    return 1;
}

/* reset：回 NORMAL 并静音 */
static inline int alarm_sm_reset(alarm_sm_t *sm)
{
    sm->state = ALARM_STATE_NORMAL;
    sm->acked_armed = 0;
    sm->buzzer = 0;
    sm->type[0] = '\0';
    sm->id[0] = '\0';
    return 1;
}

/* ACKED 期间：已确认的危险是否真正消失 -> 重新武装 */
static inline int alarm_sm_rearm(alarm_sm_t *sm, int danger_present)
{
    if (sm->state != ALARM_STATE_ACKED) return 0;
    if (danger_present) return 0;
    sm->acked_armed = 1;
    return 1;
}

/* 危险优先级：MANUAL_SOS(6) > WATER_LEAK(5) > GAS(4) > SMOKE(3) > CLIMATE(2) > NO_MOTION(1)
 * 厨房只用 GAS/SMOKE/CLIMATE/NO_MOTION；卫生间只用 MANUAL_SOS/WATER_LEAK/CLIMATE/NO_MOTION。 */
static inline int danger_priority(const char *type)
{
    if (!type) return 0;
    if (strcmp(type, "MANUAL_SOS") == 0) return 6;
    if (strcmp(type, "WATER_LEAK") == 0) return 5;
    if (strcmp(type, "GAS") == 0)        return 4;
    if (strcmp(type, "SMOKE") == 0)      return 3;
    if (strcmp(type, "CLIMATE") == 0)    return 2;
    if (strcmp(type, "NO_MOTION") == 0)  return 1;
    return 0;
}

/* ---------------- PIR 消抖（连续确认后只在上升沿报告一次活动） ---------------- */
typedef struct {
    int stable;   /* 1=已确认有活动 */
    int streak;   /* 连续有效采样次数 */
} pir_debounce_t;

static inline void pir_reset(pir_debounce_t *p)
{
    p->stable = 0;
    p->streak = 0;
}

/* 返回 1 表示"确认到一次新的活动"（上升沿）；连续 confirm 次高电平才确认。 */
static inline int pir_update(pir_debounce_t *p, int raw_active, int confirm)
{
    int was = p->stable;

    if (confirm < 1) confirm = 1;
    if (raw_active) {
        if (p->streak < confirm) p->streak += 1;
    } else {
        p->streak = 0;
    }
    p->stable = (p->streak >= confirm) ? 1 : 0;
    return (!was && p->stable) ? 1 : 0;
}

/* ---------------- SOS 按键（内部上拉，低电平按下；边沿触发，松开重新武装） ---------------- */
typedef struct {
    int pressed_stable;
    int streak;
    int released_seen;   /* 上电后必须先观察到"松开"才允许触发，防止悬空/常闭触点误报 */
} sos_button_t;

static inline void sos_reset(sos_button_t *b)
{
    b->pressed_stable = 0;
    b->streak = 0;
    b->released_seen = 0;
}

/* 返回 1 表示"需要生成一次 MANUAL_SOS"（按下沿）；长按不会重复；
 * 松开（raw_pressed=0）立即复位计数并允许下一次按下产生新事件。 */
static inline int sos_update(sos_button_t *b, int raw_pressed, int confirm)
{
    if (confirm < 1) confirm = 1;
    if (!raw_pressed) {
        b->streak = 0;             /* 松开 -> 重新武装（含 ACK 后再次触发） */
        b->pressed_stable = 0;
        b->released_seen = 1;
        return 0;
    }
    if (!b->released_seen) return 0;   /* 没松开过（悬空/常闭/上电即低）-> 不触发 */
    if (b->streak < confirm) b->streak += 1;
    if (!b->pressed_stable && b->streak >= confirm) {
        b->pressed_stable = 1;
        return 1;
    }
    return 0;
}

/* ---------------- SOS 按键：板载 KEY0（XL9555 IO 扩展器，不是 GPIO） ----------------
 * 板型事实（ALIENTEK DNESP32S3 BSP：09_iic_exio/components/BSP/XL9555/xl9555.h）：
 *   #define KEY0_IO 0x8000 / #define KEY0 xl9555_pin_read(KEY0_IO)
 *   KEY0 不在 ESP32-S3 的 GPIO 上，而由 I2C IO 扩展器 XL9555（7 位地址 0x20）的
 *   P1_7 读取；xl9555_key_scan() 以 KEY0==0 判定按下，即**低电平有效**。
 *   xl9555_ioconfig(0xF003) 把 P1_4..P1_7 配置为输入（1=输入）。
 * 因此本工程只能经 I2C 输入寄存器读取，不能配置内部上拉/中断；读失败时必须
 * “既不触发、也不解除”，绝不允许把通信错误变成一次求助。 */
#define SOS_KEY0_P1_BIT 0x80   /* 输入寄存器 P1（含 P1_7）的 bit7 */

/* read_ok=0 表示本次 I2C 读取失败：返回 -1（未知），调用方必须跳过本次消抖。 */
static inline int sos_key0_pressed(int read_ok, unsigned input_port1)
{
    if (!read_ok) return -1;
    return ((input_port1 & SOS_KEY0_P1_BIT) == 0) ? 1 : 0;   /* 0=按下(低) */
}

/* ---------------- 告警 ID（跨重启唯一） ----------------
 * 云端按 deviceId + alarmId 去重；旧 ACK 也按 alarmId 精确匹配。若 NTP 尚未同步
 * 时 time(NULL) 仍为 0，直接拼 “e-0-<seq>” 会让不同上电周期产生相同 ID：
 *   - 新的真实求助可能被云端当成重复告警而丢弃；
 *   - 上一轮遗留的 ACK 也可能匹配到本次求助，被误当成本次确认。
 * 因此未同步时改用上电随机盐（esp_random）作为 ID 一部分，字符集仍限制在
 * 后端 ALARM_ID_RE = /^[A-Za-z0-9._:-]{1,80}$/ 之内。 */
static inline void alarm_id_build(char *buf, size_t len, long long epoch_s,
                                  unsigned boot_salt, int seq)
{
    if (!buf || len == 0) return;
    if (epoch_s >= 1700000000LL)
        snprintf(buf, len, "e-%lld-%d", epoch_s, seq);
    else
        snprintf(buf, len, "e-u%08x-%d", boot_salt, seq);
}

/* ---------------- 水漏（连续湿润确认 + 锁存 + 连续干燥重新武装） ---------------- */
typedef struct {
    int danger;   /* 1=已确认漏水 */
    int streak;   /* 连续满足条件的次数 */
} water_stab_t;

static inline void water_reset(water_stab_t *w)
{
    w->danger = 0;
    w->streak = 0;
}

/* 返回更新后的 danger。
 * valid=0（读数无效）：既不判危险，也不判"已干燥"，不重新武装；
 * 未危险：连续 confirm 次 wet 才置危险；短毛刺（<confirm）不报警；
 * 已危险：连续 clear 次干爽才解除（重新武装）；
 * 持续湿润：streak 清零并维持危险（ACK 只静音，不产生新 ID）。 */
static inline int water_update(water_stab_t *w, int valid, int wet, int confirm, int clear)
{
    if (!valid) return w->danger;
    if (confirm < 1) confirm = 1;
    if (clear < 1) clear = 1;

    if (!w->danger) {
        if (wet) {
            if (++w->streak >= confirm) { w->danger = 1; w->streak = 0; }
        } else {
            w->streak = 0;
        }
    } else {
        if (!wet) {
            if (++w->streak >= clear) { w->danger = 0; w->streak = 0; }
        } else {
            w->streak = 0;
        }
    }
    return w->danger;
}

/* ---------------- 温湿度：连续确认 + 回差 ----------------
 * 语义（与 MQ/水漏一致，绝不拿缺失/无效读数参与判定）：
 *   valid=0：缺失、I2C 失败、CRC 错、超范围（物理不可能）——既不判危险，
 *            也不判恢复，直接保持上一次有效判定；
 *   触发：连续 confirm 次有效读数越界才置 danger；
 *   解除：连续 clear 次有效读数回到“回差带内”才清 danger；
 *   回差带内但未到解除次数、或仍在原始阈值外：维持当前状态（消抖）。
 * 回差语义：温度需 temp <= high-hyst（低温侧 temp >= low+hyst），
 *           湿度需 rh <= rh_high-hyst（低湿侧 rh >= rh_low+hyst）。
 * 若配置使 high-hyst < low+hyst，则解除条件退化为原始阈值内，避免永久锁死。 */
typedef struct {
    int danger;   /* 1=已确认温湿度越界 */
    int streak;   /* 连续满足条件的有效采样次数 */
} climate_stab_t;

static inline void climate_stab_reset(climate_stab_t *s)
{
    s->danger = 0;
    s->streak = 0;
}

/* 返回更新后的 danger（1=越界）。参数为“当前有效读数 + 阈值/回差/确认次数”。 */
static inline int climate_stab_update(climate_stab_t *s, int valid,
                                      float temp, float rh,
                                      int temp_low, int temp_high,
                                      int rh_low, int rh_high,
                                      int temp_hyst, int rh_hyst,
                                      int confirm, int clear)
{
    int raw_out, safe_in;

    if (!valid) return s->danger;          /* 无效/缺失：保持原判定，不计数 */
    if (confirm < 1) confirm = 1;
    if (clear < 1) clear = 1;
    if (temp_hyst < 0) temp_hyst = 0;
    if (rh_hyst < 0) rh_hyst = 0;
    if (rh_high < rh_low) { int t = rh_high; rh_high = rh_low; rh_low = t; }
    if (temp_high < temp_low) { int t = temp_high; temp_high = temp_low; temp_low = t; }
    if (temp_high - temp_hyst < temp_low + temp_hyst) temp_hyst = 0;
    if (rh_high - rh_hyst < rh_low + rh_hyst) rh_hyst = 0;

    raw_out = (temp < (float)temp_low) || (temp > (float)temp_high) ||
              (rh < (float)rh_low) || (rh > (float)rh_high);
    safe_in = (temp >= (float)(temp_low + temp_hyst)) &&
              (temp <= (float)(temp_high - temp_hyst)) &&
              (rh >= (float)(rh_low + rh_hyst)) &&
              (rh <= (float)(rh_high - rh_hyst));

    if (!s->danger) {
        if (raw_out) {
            if (++s->streak >= confirm) { s->danger = 1; s->streak = 0; }
        } else {
            s->streak = 0;
        }
    } else {
        if (safe_in) {
            if (++s->streak >= clear) { s->danger = 0; s->streak = 0; }
        } else {
            s->streak = 0;   /* 回差带/阈值外：维持危险 */
        }
    }
    return s->danger;
}

/* ---------------- 持续告警限频提醒 ----------------
 * 返回 1 表示“现在应再提醒一次”。调用方负责真正响铃/播放。
 *   active=1 必须处于未 ACK/未停止的 ALARM；
 *   interval_sec<=0 表示只在触发时提醒一次；
 *   同一告警持续期间按 interval_sec 限频，不会因每个上报周期重复。 */
static inline int alarm_repeat_due(int active, int suppressed,
                                   long long now_ms, long long last_remind_ms,
                                   int interval_sec)
{
    if (!active || suppressed) return 0;
    if (interval_sec <= 0) return 0;
    if (last_remind_ms <= 0) return 1;
    return (now_ms - last_remind_ms) >= (long long)interval_sec * 1000;
}

/* ---------------- 无活动提醒启用条件 ----------------
 * 只有同时满足以下条件才允许“长时间无活动”提醒：
 *   pir_enabled=1：该房间编译期接有 PIR；
 *   pir_armed=1  ：本次启动后至少确认过一次有效活动（避免断线常低被当成“无人活动”）；
 *   paused=0     ：用户未暂停监护（暂停状态跨重启保持，不得自动反向恢复）。
 * 传感器缺失/无有效数据时宁可不提醒，也不误报。 */
static inline int no_motion_enabled(int pir_enabled, int pir_armed, int paused)
{
    return pir_enabled && pir_armed && !paused;
}

/* ---------------- NTP ---------------- */
/* 首次同步后是否允许重置"最近活动"基准：仅 PIR 启用时（厨房 PIR=-1，故不重置） */
static inline int ntp_reset_motion_baseline(int pir_enabled)
{
    return pir_enabled ? 1 : 0;
}

/* ---------------- JSON valid ---------------- */
/* 只有本次读取成功才 valid=true；失败时报告 false，且不把旧值当成本次有效值 */
static inline const char *json_valid_str(int sensor_valid)
{
    return sensor_valid ? "true" : "false";
}

#endif /* ALARM_LOGIC_H */
