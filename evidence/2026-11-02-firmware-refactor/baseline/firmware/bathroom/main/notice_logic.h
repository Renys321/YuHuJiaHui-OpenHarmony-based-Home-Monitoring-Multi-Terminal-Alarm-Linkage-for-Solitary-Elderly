/* notice_logic.h —— 跨房间定向播报的纯判定逻辑（与 ESP 硬件无关，主机侧可直接编译测试）
 *
 * 背景
 * ---------------------------------------------------------------------------
 * 随身求助按钮（esp32-sos）按下后，厨房/卫生间两块固定板需要“播报同一个求助事件”。
 * 它们不允许各自伪造本地 MANUAL_SOS、告警 ID 或设备来源，所以本模块只维护
 * “我在替别人播报哪一条事件”，不触碰本板告警状态机（s_state / s_alarm_id / s_alarm_type）：
 *
 *   - 同一 alarmId 只播一次（重试 / 长按 / 抖动 / 断线重连 / 重复上报都不重播）；
 *   - 已经播完（收到 noticeack）的同一 alarmId 再来也不重播；
 *   - 本板本地告警优先：本地 ALARM 期间拒绝外来播报，也不改本地状态；
 *   - 本地告警接管时把外来 id 记为“已结束”，避免它之后被重放。
 *
 * 本模块不含任何 I/O，node_main.c 只负责把结果翻译成 ESP_LOG / 蜂鸣器 / 语音调用。
 */
#ifndef NOTICE_LOGIC_H
#define NOTICE_LOGIC_H

#include <string.h>

#define NOTICE_ID_MAX     40
#define NOTICE_SOURCE_MAX 32

typedef struct {
    char active_id[NOTICE_ID_MAX];    /* 正在播报的外部 alarmId；空 = 没有 */
    char source[NOTICE_SOURCE_MAX];   /* 来源 deviceId，仅用于日志/证据 */
    char last_id[NOTICE_ID_MAX];      /* 最近一次已播完的外部 alarmId，用于阻止重播 */
} notice_state_t;

typedef enum {
    NOTICE_BEGIN_PLAY = 0,        /* 接受：调用方应开始提示音 + 语音 */
    NOTICE_BEGIN_NO_ID,           /* 拒绝：缺少 alarmId */
    NOTICE_BEGIN_BAD_ID,          /* 拒绝：alarmId 或来源非法 */
    NOTICE_BEGIN_LOCAL_ALARM,     /* 拒绝：本板正在本地告警（本地优先） */
    NOTICE_BEGIN_DUP_ACTIVE,      /* 忽略：同一事件正在播报 */
    NOTICE_BEGIN_DUP_DONE         /* 忽略：同一事件此前已播完/已确认 */
} notice_begin_result_t;

typedef enum {
    NOTICE_END_STOPPED = 0,       /* 接受：调用方应停止声音并记为已结束 */
    NOTICE_END_NO_ID,             /* 拒绝：缺少 alarmId */
    NOTICE_END_NO_MATCH           /* 拒绝：没有匹配的在播事件 */
} notice_end_result_t;

static inline void notice_reset(notice_state_t *st)
{
    st->active_id[0] = '\0';
    st->source[0] = '\0';
    st->last_id[0] = '\0';
}

/* 只接受 [A-Za-z0-9._-]{1,32}：这些值会被拼进行协议与日志，不允许空白/控制字符。 */
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

/** 请求开始播报一条外部求助。
 *  local_alarm：本板当前是否处于本地 ALARM（调用方传 s_state == 2）。 */
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

/** 请求停止（监护人已在 APP 确认该外部求助）：只有 ID 精确匹配才生效。 */
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

/** 本地告警接管：把外来 id 记为“已结束”并清空 active，返回 1 表示确实打断了一条外来播报。
 *  不写 last_id 之外的外来状态，也不触碰本板告警状态。 */
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
