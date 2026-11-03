/* wearable_logic.h —— 随身 SOS（ESP32-S3 + M100MG-B1）的“纯逻辑”层
 *
 * 设计原则：本文件与 wearable_logic.c 不包含任何 ESP-IDF / 硬件头文件，
 * 主机 gcc 可以直接编译并单测（见 test/host_wearable_logic_test.c）。
 * 固件 wearable_main.c 只负责 I/O：GPIO、UART、NVS、看门狗与主循环。
 *
 * 对照契约 competition/docs/wearable-4g-map/DESIGN-CONTRACT.md：
 *   §3   UART 行协议：UTF-8 JSON 单行、\n 结尾、≤512 字节；alarmId 正则；
 *        下行 ack 只在 alarm 匹配时结束提示，cmd 有则必须与已收到的命令一致。
 *   §6   按键 20ms 采样 + 60ms 消抖、按下立即蜂鸣；蜂鸣 3 短声循环收紧，
 *        30s 自动静音但事件仍未确认；事件/alarmId 持久化；每 10s 重发；
 *        ACK 后置 IDLE 并允许新 ID；心跳 30s。
 *
 * 本层负责的行为（全部可通过传入 now_ms 做确定性单测）：
 *   1. 按键消抖与按下/松开边沿；
 *   2. alarmId 生成（sos-<n>-<8hex>）与正则校验；
 *   3. 事件状态机 + ACK 匹配/去重/命令一致性 + 重试/心跳到期判定；
 *   4. NVS 持久化快照（纯结构体 + 校验和，重启恢复）；
 *   5. 蜂鸣节奏（3 短声、组间收紧、30s 后每 30s 单短提示）；
 *   6. 最小 JSON 编解码（上行 4 帧构造 + 下行 ack 解析，带转义/嵌套/垃圾行处理）；
 *   7. UART 行分帧（分包/粘包/超长丢弃）；
 *   8. M100 DTU 文本回包解析（config,gps,/config,csq,），GPS 失败一律降级 null。
 */
#ifndef WEARABLE_LOGIC_H
#define WEARABLE_LOGIC_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* ------------------------------------------------------------------ 契约常量 */

#define WB_LINE_MAX_BYTES 512          /* §3：单行 JSON/DTU 回包上限 */
#define WB_UART_IDLE_FLUSH_MS 100      /* 下行不以 \n 结尾时的空闲成帧兜底（M100 实测不追加换行） */
#define WB_ALARM_ID_MAX_LEN 80         /* §3.1：/^[A-Za-z0-9._:-]{1,80}$/ */
#define WB_ALARM_ID_CAP (WB_ALARM_ID_MAX_LEN + 1)
#define WB_CMD_ID_CAP 65               /* 后端 commandId，留足余量 */
#define WB_DEV_ID_CAP 32
#define WB_JSON_T_CAP 16               /* "ack" 等帧类型 */

/* 时间参数（单位 ms），与契约 §6 一一对应 */
#define WB_BTN_SAMPLE_MS 20
#define WB_BTN_DEBOUNCE_MS 60
#define WB_SOS_RETRY_MS 10000          /* 未确认时每 10s 重发 */
#define WB_HB_INTERVAL_MS 30000        /* 心跳每 30s */
#define WB_SOS_MUTE_MS 30000           /* SOS 提示 30s 后自动静音（状态仍 ALARM） */
#define WB_REMIND_INTERVAL_MS 30000    /* 静音后每 30s 单短提示，直到 ACK */
#define WB_REMIND_BEEP_MS 150
#define WB_GPS_QUERY_TIMEOUT_MS 1500   /* config,get,gpsext 等待上限 */
#define WB_GPS_MAX_AGE_MS 60000        /* 超过 60s 的定位不写进 SOS 包（ageMs 会很大） */

/* 蜂鸣节奏：3 短声一组，组间静默逐组收紧 */
#define WB_SOS_BEEP_ON_MS 120
#define WB_SOS_BEEP_OFF_MS 120
#define WB_SOS_BEEPS_PER_GROUP 3
#define WB_SOS_GROUP_GAP_MS 800
#define WB_SOS_GROUP_GAP_STEP_MS 120
#define WB_SOS_GROUP_GAP_MIN_MS 280

/* 32 位毫秒回绕安全的“是否已到达”判断（uptime 会在 49.7 天回绕） */
static inline int wb_time_reached(uint32_t now_ms, uint32_t target_ms)
{
    return (int32_t)(now_ms - target_ms) >= 0;
}

/* ------------------------------------------------------------------ 按键消抖 */

typedef struct {
    int stable_pressed;          /* 消抖后的稳定状态：1=按下 */
    int candidate_pressed;       /* 当前采样候选值 */
    uint32_t candidate_since_ms; /* 候选值首次出现的时间 */
    int initialized;
} wb_debounce_t;

typedef enum {
    WB_BTN_EVENT_NONE = 0,
    WB_BTN_EVENT_PRESS = 1,      /* 消抖后确认“按下”边沿（只报一次） */
    WB_BTN_EVENT_RELEASE = 2     /* 消抖后确认“松开”边沿 */
} wb_btn_event_t;

void wb_debounce_init(wb_debounce_t *deb);
/* raw_pressed：1 表示采样到“按下”（固件里 gpio_get_level(button)==0）。
 * 采样周期应为 WB_BTN_SAMPLE_MS；必须连续稳定 WB_BTN_DEBOUNCE_MS 才翻转。 */
wb_btn_event_t wb_debounce_update(wb_debounce_t *deb, int raw_pressed, uint32_t now_ms);

/* ------------------------------------------------------------------ alarmId */

/* §3.1 正则校验：1..80 个 [A-Za-z0-9._:-] 字符。 */
int wb_alarm_id_valid(const char *alarm_id);
/* 生成 "sos-<counter>-<8 位小写 hex>"。返回长度；失败/超缓冲返回 -1。 */
int wb_alarm_id_format(char *out, size_t cap, uint32_t counter, const uint8_t rand4[4]);
/* 从 alarmId 中解析计数器（用于 NVS 损坏时取较大值保证单调）。1=成功。 */
int wb_alarm_id_counter(const char *alarm_id, uint32_t *out_counter);

/* ------------------------------------------------------------------ 事件状态 */

typedef enum {
    WB_STATE_IDLE = 0,
    WB_STATE_ALARM = 1
} wb_state_t;

typedef struct {
    wb_state_t state;
    char alarm_id[WB_ALARM_ID_CAP];
    char cmd_id[WB_CMD_ID_CAP];  /* 本事件已收到的命令（正常路径确认后立即清空） */
    int has_cmd;
    uint32_t start_uptime_ms;    /* 本次提示周期起点（重启恢复时重置为启动时刻） */
    uint32_t last_sos_ms;        /* 最近一次成功发出 SOS 的时间 */
    uint32_t seq;                /* 同一个 alarmId 的重试序号，仅 uptime/seq 允许变化 */
} wb_event_t;

/* 最近一次已确认事件备忘：适配器会重复投递同一 ACK（至少 3 次），
 * 设备据此把重复 ACK 识别为“已确认过”，重发回执而不是误判成新事件。 */
typedef struct {
    int valid;
    char alarm_id[WB_ALARM_ID_CAP];
    char cmd_id[WB_CMD_ID_CAP];
    int has_cmd;
    uint32_t acked_uptime_ms;
} wb_ack_memo_t;

typedef enum {
    WB_ACK_REJECTED_ALARM = 0,   /* alarm 不匹配当前事件（或没有事件） */
    WB_ACK_ACCEPTED = 1,         /* 匹配：清事件、置 IDLE、允许新 alarmId */
    WB_ACK_DUPLICATE = 2,        /* 同一 alarm 的重复 ACK：只重发回执，不改状态 */
    WB_ACK_REJECTED_CMD = 3      /* cmd 与已收到的命令不一致：拒绝，不伪造回执 */
} wb_ack_result_t;

void wb_event_init(wb_event_t *ev, wb_ack_memo_t *memo);
int wb_event_active(const wb_event_t *ev);
/* 仅在 IDLE 且 alarm_id 合法时可开始新事件。1=成功。 */
int wb_event_start(wb_event_t *ev, const char *alarm_id, uint32_t now_ms);
void wb_event_note_sent(wb_event_t *ev, uint32_t now_ms);
/* 到期判断：未确认事件距离上次发送 >= interval_ms 时返回 1，并记录本次发送时刻。 */
int wb_event_should_resend(wb_event_t *ev, uint32_t now_ms, uint32_t interval_ms);
/* 处理下行 t:"ack"。cmd_present=0 表示下行缺 cmd：可接受但只记录日志（由调用方打印）。 */
wb_ack_result_t wb_event_handle_ack(wb_event_t *ev, wb_ack_memo_t *memo,
                                    const char *alarm_id, const char *cmd_id, int cmd_present,
                                    uint32_t now_ms);

/* ------------------------------------------------------------------ NVS 快照 */

#define WB_PERSIST_MAGIC 0x534F5331u /* "SOS1" */
#define WB_PERSIST_VERSION 1u

/* 固件只把这个结构体整体写进 NVS 的一个 blob；
 * 纯逻辑层负责序列化/校验，便于主机上模拟“断电重启”。 */
typedef struct {
    uint32_t magic;
    uint16_t version;
    uint16_t flags;              /* bit0: 有未确认事件 */
    uint32_t counter;            /* 已使用的最大 alarm 计数器（单调） */
    char alarm_id[WB_ALARM_ID_CAP];
    char cmd_id[WB_CMD_ID_CAP];
    char memo_alarm[WB_ALARM_ID_CAP];
    char memo_cmd[WB_CMD_ID_CAP];
    uint32_t checksum;           /* 前面所有字节的 FNV-1a */
} wb_persist_t;

void wb_persist_init(wb_persist_t *p);
void wb_persist_from_event(wb_persist_t *p, const wb_event_t *ev, const wb_ack_memo_t *memo,
                           uint32_t counter);
/* 校验并恢复到 ev/memo/counter。返回 1=快照可用；0=损坏/版本不符（调用方应重新开始）。
 * was_active 输出快照里是否有未确认事件。 */
int wb_persist_restore(const wb_persist_t *p, wb_event_t *ev, wb_ack_memo_t *memo,
                       uint32_t *counter, uint32_t now_ms, int *was_active);

/* ------------------------------------------------------------------ 蜂鸣器 */

typedef struct {
    int active;
    uint32_t start_ms;
} wb_buzzer_t;

void wb_buzzer_init(wb_buzzer_t *bz);
/* 立即起响（start_ms 起第一个采样就输出高电平，满足 <100ms）。 */
void wb_buzzer_start(wb_buzzer_t *bz, uint32_t now_ms);
/* ACK 后立刻停：返回恒 0。 */
void wb_buzzer_stop(wb_buzzer_t *bz);
int wb_buzzer_active(const wb_buzzer_t *bz);
uint32_t wb_buzzer_elapsed_ms(const wb_buzzer_t *bz, uint32_t now_ms);
/* 返回 GPIO 应输出的电平（高电平触发 3 针蜂鸣器模块）。
 * 0..30s：3 短声循环且组间静默逐组收紧；30s 后：每 30s 单短提示 150ms。 */
int wb_buzzer_level(const wb_buzzer_t *bz, uint32_t now_ms);

/* ------------------------------------------------------------------ 最小 JSON */

/* 前置声明：上行 SOS 构造需要 GPS 定位结构（定义在下方 DTU 解析节）。 */
typedef struct wb_gps_fix wb_gps_fix_t;

typedef struct {
    int has_v;
    int v;
    int has_t;
    char t[WB_JSON_T_CAP];
    int has_alarm;
    char alarm[WB_ALARM_ID_CAP];
    int alarm_too_long;
    int has_cmd;
    char cmd[WB_CMD_ID_CAP];
    int cmd_too_long;
    int has_dev;
    char dev[WB_DEV_ID_CAP];
} wb_downlink_t;

/* 解析单行下行 JSON 对象。返回 1=语法上是合法 JSON 对象（字段按需填充），
 * 0=非 JSON / 非法（乱码、截断、尾随垃圾），调用方必须忽略且不改变告警状态。
 * 只收集顶层字段；嵌套对象/数组/数字/布尔/null 会正确跳过。 */
int wb_json_parse_downlink(const char *line, wb_downlink_t *out);

/* JSON 字符串转义（不含两侧引号）。返回写入长度，空间不足返回 -1。 */
int wb_json_escape(const char *in, char *out, size_t cap);

/* 上行 4 帧构造。返回 JSON 字节长度（不含 '\n'）；失败/超过 512 返回 -1。
 * 所有字符串字段都会转义；gps.valid=0 时输出 gps:null。 */
int wb_build_boot(char *out, size_t cap, const char *dev, const char *fw, uint32_t uptime_ms);
int wb_build_sos(char *out, size_t cap, const char *dev, const char *alarm_id,
                 uint32_t uptime_ms, uint32_t seq, const wb_gps_fix_t *fix);

/* ------------------------------------------------------------------ 电量（契约 BATTERY-CHAIN-CONTRACT.md §2）
 *
 * 心跳帧可选带顶层 `battery` 对象，字段与居家节点完全一致：
 *   {"source":"battery","present":bool,"valid":bool,"mv":int|null,
 *    "percent":int|null,"low":bool,"calibrated":bool,"reason":"[A-Z_]{0,16}"}
 *
 * 安全边界（与 esp32-node 的 battery_logic 同一套判定）：
 *   - 未接电池/浮空/样本抖动 -> valid=0、mv=null、percent=null、reason 短码；
 *   - percent 只有 calibrated=1（两点万用表校准过）且 valid=1 时才给；
 *   - 绝不把 USB 供电电压、csq（信号质量）或固定值当电量。
 *
 * 传 NULL 表示“本设备没有电池采样能力/未启用”——此时帧里**不出现** battery 字段，
 * 与加电前的旧帧完全一致（下游据此显示“电量未知”而不是 0%）。
 */
typedef struct {
    int present;         /* 1 只在拿到可信电压时为真（不谎报“有电池”） */
    int valid;
    int mv;              /* -1 => JSON null */
    int percent;         /* -1 => JSON null（未标定必须是 -1） */
    int low;
    int calibrated;
    const char *reason;  /* [A-Z_]{0,16}；NULL 或 "" 表示无异常 */
} wb_battery_t;

int wb_build_hb(char *out, size_t cap, const char *dev, wb_state_t state,
                const char *alarm_id, uint32_t uptime_ms, int csq);
/* 带电量版本；batt==NULL 时行为与 wb_build_hb 完全一致（不输出 battery 字段）。 */
int wb_build_hb_ex(char *out, size_t cap, const char *dev, wb_state_t state,
                   const char *alarm_id, uint32_t uptime_ms, int csq,
                   const wb_battery_t *batt);

int wb_build_ack_frame(char *out, size_t cap, const char *dev, const char *alarm_id,
                       const char *cmd_id);

/* ------------------------------------------------------------------ UART 分帧 */

typedef struct {
    char buf[WB_LINE_MAX_BYTES + 1];
    size_t len;
    int discarding; /* 超长：丢弃到下一个 '\n'（或空闲超时成帧时整行丢弃） */
} wb_line_buf_t;

typedef enum {
    WB_LINE_EVENT_NONE = 0,
    WB_LINE_EVENT_READY = 1,     /* buf/len 为一条 ≤512 字节的完整行（已去掉 \r\n） */
    WB_LINE_EVENT_OVERFLOW = 2   /* 该行超过 512 字节，已整行丢弃 */
} wb_line_event_t;

void wb_line_init(wb_line_buf_t *lb);
/* 逐字节喂入；\n 触发 READY。空行返回 NONE。 */
wb_line_event_t wb_line_feed(wb_line_buf_t *lb, uint8_t byte);

/* 空闲超时成帧兜底：真机 M100 把服务器下行数据写到串口时**不追加 '\n'**，
 * 只在收到 '\n' 才成帧会让 ACK 永远卡在缓冲区。
 * 语义：缓冲区非空（或已进入超长丢弃态）且距最后一个字节 ≥ WB_UART_IDLE_FLUSH_MS 时，
 * 把当前缓冲当作一整行 → READY；超长行 → OVERFLOW 并清空；否则 NONE。
 * 正常 '\n' 成帧路径完全不变（收到 '\n' 立即 READY，缓冲区已空时本函数恒 NONE）。 */
wb_line_event_t wb_line_idle_flush(wb_line_buf_t *lb, uint32_t last_byte_ms, uint32_t now_ms);

/* ------------------------------------------------------------------ M100 DTU 回包 */

struct wb_gps_fix {
    int valid;
    int64_t lat_u6;         /* 微度（1e-6 度），已按 N/S 半球取符号 */
    int64_t lon_u6;         /* 微度（1e-6 度），已按 E/W 半球取符号 */
    uint32_t fix_uptime_ms; /* 本机收到该定位的 uptime，用于 ageMs */
};

typedef enum {
    WB_GPS_NOT_RESPONSE = 0, /* 不是 config,gps 回包（其他 DTU 回包/垃圾行） */
    WB_GPS_NO_FIX = 1,       /* 是 gps 回包但无有效定位：调用方必须降级 gps=null */
    WB_GPS_FIX = 2           /* 有效定位（flag=1 + 半球合法 + 坐标成对非零且在范围内） */
} wb_gps_result_t;

void wb_gps_clear(wb_gps_fix_t *fix);
int wb_gps_is_fresh(const wb_gps_fix_t *fix, uint32_t now_ms, uint32_t max_age_ms);
/* 解析 config,gps,ok,...（短包无显式 fix 标志 → NO_FIX；扩展包 flag=1 才可能 FIX）。 */
wb_gps_result_t wb_gps_parse_line(const char *line, wb_gps_fix_t *fix, uint32_t now_ms);
/* 解析 config,csq,ok,<0..31>；99/非法 → 0（心跳不带 csq）。 */
int wb_parse_csq_line(const char *line, int *out_csq);
/* 是否 DTU config 回包（前缀 config, 不区分大小写）。这些行只能本地解析，绝不能回显上行。 */
int wb_dtu_is_config_line(const char *line);

#ifdef __cplusplus
}
#endif

#endif /* WEARABLE_LOGIC_H */
