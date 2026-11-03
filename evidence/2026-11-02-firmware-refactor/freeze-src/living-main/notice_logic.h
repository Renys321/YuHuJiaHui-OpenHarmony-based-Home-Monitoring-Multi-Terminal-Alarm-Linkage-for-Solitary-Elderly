/* notice_logic.h —— 跨房间定向播报的纯判定逻辑（与 ESP 硬件无关，主机侧可直接编译测试）
 *
 * 场景：
 *   随身求助按钮（esp32-sos）按下后，厨房/卫生间两块固定板要一起播报这条求助。
 *   但这两块板不能各自伪造本地 MANUAL_SOS、告警 ID 或设备来源，
 *   否则 APP 上会出现多条来源不同的“假告警”。
 *
 * 所以这里只维护“我在替别人播报哪一条”，完全不碰本板告警状态机
 * （s_state / s_alarm_id / s_alarm_type）。规则：
 *   - 同一 alarmId 只播一次：重试、长按、抖动、断线重连、重复上报都不重播；
 *   - 收到 noticeack 的同一 ID 之后再来，也不播（last_id 已记住）；
 *   - 本地告警优先：本地 ALARM 期间拒绝外来播报，也不改本地状态；
 *   - 本地告警接管时，把外来 id 记为“已结束”，避免本地告警结束后它被重放。
 *
 * 本模块没有任何 I/O：不响蜂鸣器、不播语音、不打日志。
 * node_main.c 只负责把返回值翻译成实际的 ESP_LOG / 蜂鸣器 / 语音调用。 */
#ifndef NOTICE_LOGIC_H
#define NOTICE_LOGIC_H

#include <string.h>

/* alarmId 最长 40（含 '\0'）；来源 deviceId 最长 32（含 '\0'）。
 * 这两个长度与上报协议里的字段长度保持一致，改小会截断 ID 导致去重失效。 */
#define NOTICE_ID_MAX     40
#define NOTICE_SOURCE_MAX 32

/* 跨房间播报状态。
 * active_id 非空表示“当前正在替这个 alarmId 播报”；
 * last_id 保存最近一次播完/被确认/被本地告警打断的 id，用来阻止重播。
 * source 只用于日志和证据核对，不参与判定。 */
typedef struct {
    char active_id[NOTICE_ID_MAX];    /* 正在播报的外部 alarmId；空 = 没有 */
    char source[NOTICE_SOURCE_MAX];   /* 来源 deviceId，仅用于日志/证据 */
    char last_id[NOTICE_ID_MAX];      /* 最近一次已播完的外部 alarmId，用于阻止重播 */
} notice_state_t;

/* notice_begin() 的返回码。调用方按返回值决定是否出声。 */
typedef enum {
    NOTICE_BEGIN_PLAY = 0,        /* 接受：调用方应开始提示音 + 语音 */
    NOTICE_BEGIN_NO_ID,           /* 拒绝：缺少 alarmId */
    NOTICE_BEGIN_BAD_ID,          /* 拒绝：alarmId 或来源非法（含非法字符/过长） */
    NOTICE_BEGIN_LOCAL_ALARM,     /* 拒绝：本板正在本地告警（本地优先） */
    NOTICE_BEGIN_DUP_ACTIVE,      /* 忽略：同一事件正在播报 */
    NOTICE_BEGIN_DUP_DONE         /* 忽略：同一事件此前已播完/已确认 */
} notice_begin_result_t;

/* notice_end() 的返回码。 */
typedef enum {
    NOTICE_END_STOPPED = 0,       /* 接受：调用方应停止声音并记为已结束 */
    NOTICE_END_NO_ID,             /* 拒绝：缺少 alarmId */
    NOTICE_END_NO_MATCH           /* 拒绝：没有匹配的在播事件 */
} notice_end_result_t;

/* 清空所有状态，回到“没有外来播报”。用于上电初始化。 */
static inline void notice_reset(notice_state_t *st)
{
    st->active_id[0] = '\0';
    st->source[0] = '\0';
    st->last_id[0] = '\0';
}

/* 校验 alarmId / deviceId 是否合法。
 * 只接受 [A-Za-z0-9._-]{1,32}：
 *   - 这些值会被拼进 JSON 协议、日志和 HTTP 头，不能含空白、引号、控制字符；
 *   - 长度限制防止超长字符串撑爆固定缓冲。
 * 返回 1=合法，0=非法或 NULL。 */
static inline int notice_id_valid(const char *s)
{
    size_t i, n;
    if (!s) return 0;
    n = strlen(s);
    if (n == 0 || n > 32) return 0;
    for (i = 0; i < n; i++) {
        char c = s[i];
        int ok = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
                 (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.';
        if (!ok) return 0;
    }
    return 1;
}

/* 请求开始播报一条外部求助。
 *
 * 参数：
 *   st          - 状态
 *   aid         - 外部求助的 alarmId
 *   src         - 来源 deviceId（如 "esp32-sos"）
 *   local_alarm - 本板当前是否处于本地 ALARM（调用方传 s_state == 2）
 *
 * 返回 NOTICE_BEGIN_*，只有 NOTICE_BEGIN_PLAY 才应该出声。
 * 判定顺序（先拒绝更严重的，再看重复）：
 *   1. alarmId 为空 -> NO_ID；
 *   2. alarmId/来源含非法字符或过长 -> BAD_ID；
 *   3. 本板正在告警 -> LOCAL_ALARM（本地声音优先，且不能改本地状态）；
 *   4. 同一事件正在播 -> DUP_ACTIVE；
 *   5. 同一事件已经播完/被确认 -> DUP_DONE；
 *   6. 否则接受，把 aid/source 写入 active 状态。
 *
 * 注意：接受后只是“允许播”，真正的提示音/语音由调用方执行；
 * 本模块不生成 alarmId，也不改本板告警状态。 */
static inline notice_begin_result_t notice_begin(notice_state_t *st,
                                                 const char *aid,
                                                 const char *src,
                                                 int local_alarm)
{
    if (!aid || aid[0] == '\0') return NOTICE_BEGIN_NO_ID;
    if (!notice_id_valid(aid) || !notice_id_valid(src)) return NOTICE_BEGIN_BAD_ID;
    /* 本地告警优先：本板自己正在响的时候不抢占声音，也不改本地状态 */
    if (local_alarm) return NOTICE_BEGIN_LOCAL_ALARM;
    if (st->active_id[0] != '\0' && strcmp(st->active_id, aid) == 0) return NOTICE_BEGIN_DUP_ACTIVE;
    if (st->last_id[0] != '\0' && strcmp(st->last_id, aid) == 0) return NOTICE_BEGIN_DUP_DONE;

    strncpy(st->active_id, aid, sizeof(st->active_id) - 1);
    st->active_id[sizeof(st->active_id) - 1] = '\0';
    strncpy(st->source, src, sizeof(st->source) - 1);
    st->source[sizeof(st->source) - 1] = '\0';
    return NOTICE_BEGIN_PLAY;
}

/* 请求停止当前外来播报（监护人已在 APP 确认该求助）。
 * 只有 aid 与当前 active_id 完全一致才生效：
 *   - 不匹配的 noticeack 不能误停另一条播报；
 *   - 停止后把 id 存入 last_id，之后同一条再来也不会重播。
 * 返回 NOTICE_END_*。 */
static inline notice_end_result_t notice_end(notice_state_t *st, const char *aid)
{
    if (!aid || aid[0] == '\0') return NOTICE_END_NO_ID;
    if (st->active_id[0] == '\0' || strcmp(st->active_id, aid) != 0) return NOTICE_END_NO_MATCH;
    strncpy(st->last_id, st->active_id, sizeof(st->last_id) - 1);
    st->last_id[sizeof(st->last_id) - 1] = '\0';
    st->active_id[0] = '\0';
    st->source[0] = '\0';
    return NOTICE_END_STOPPED;
}

/* 本地告警接管：本板自己要响了，必须打断正在播的外部求助。
 * 做法：把 active_id 记进 last_id（表示“这条已经结束，别再播”），
 *       再清空 active/source。
 * 返回 1 表示确实打断了一条外来播报；0 表示本来就没有。
 * 只改本模块状态，绝不触碰本板告警状态机。 */
static inline int notice_yield(notice_state_t *st)
{
    if (st->active_id[0] == '\0') return 0;
    strncpy(st->last_id, st->active_id, sizeof(st->last_id) - 1);
    st->last_id[sizeof(st->last_id) - 1] = '\0';
    st->active_id[0] = '\0';
    st->source[0] = '\0';
    return 1;
}

#endif /* NOTICE_LOGIC_H */
