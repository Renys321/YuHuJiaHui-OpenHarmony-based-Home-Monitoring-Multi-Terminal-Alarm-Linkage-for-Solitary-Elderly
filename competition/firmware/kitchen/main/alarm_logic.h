/* alarm_logic.h —— 与 ESP 硬件无关的纯逻辑（主机侧可直接编译测试）
 *
 * 为什么单独拆出来：
 *   传感器消抖、告警状态机、ACK 规则这些逻辑最容易出现边界错误，
 *   但又完全不需要硬件。拆成纯 C 后，PC 上可以直接编译测试，
 *   不用接板子就能验证：连续确认、回差、ACK 后重新武装、无效读数不误判。
 *
 * node_main.c 只做 I/O（I2C/ADC/GPIO/NVS/TCP），所有“该不该报警”的判断都在这里：
 *   - MQ 连续确认 + 回差（失败读数不参与，阈值 >=4096 表示禁用）；
 *   - 告警状态机：何时允许新建告警 / ACK 是否接受 / ACK 后如何重新武装；
 *   - PIR、SOS、水漏、门磁、温湿度的去抖；
 *   - NTP 首次同步只允许重置“无活动计时”（仅 PIR 启用时）；
 *   - JSON 里 valid 字段的语义（本次读取成功才为 true）。
 *
 * 所有函数都是 static inline，不产生额外编译单元，也不依赖 FreeRTOS。 */
#ifndef ALARM_LOGIC_H
#define ALARM_LOGIC_H

#include <string.h>
#include <stdio.h>

/* ================= MQ-2 / MQ-5 气体传感器：连续确认 + 回差 =================
 *
 * 气体传感器读数会抖动，单次超阈值不能直接报警；同样，刚回到阈值附近也不能
 * 立刻解除。这里用“连续 N 次确认”+“回差带”解决：
 *
 *   未危险时：raw >= threshold 连续 confirm 次 -> danger=1；
 *   已危险时：raw < threshold - hysteresis 连续 confirm 次 -> danger=0；
 *   中间那段（threshold-hysteresis .. threshold）叫灰色区：
 *     已危险就维持危险，未危险就维持未危险，不来回抖。
 *
 * valid=0 表示本次 ADC 读数不可信，此时既不判危险也不判安全，直接保持原状态。
 * threshold >= 4096 是特殊约定：ADC 最大只有 4095，说明该通道被配置为禁用。
 */

typedef struct {
    int danger;   /* 1=已确认危险 */
    int streak;   /* 连续满足“切换条件”的次数；切换发生后清零 */
} mq_stab_t;

/* 把状态恢复到“无危险、无计数”。用于上电初始化或重新配置。 */
static inline void mq_stab_reset(mq_stab_t *s)
{
    s->danger = 0;
    s->streak = 0;
}

/* 喂一次采样，返回更新后的 danger（1=危险）。
 *
 * 参数：
 *   s          - 状态
 *   valid      - 本次 ADC 读取是否成功（1/0）
 *   raw        - ADC 原始值（0..4095）
 *   threshold  - 危险阈值；>=4096 表示禁用该通道
 *   hysteresis - 回差宽度；解除线 = threshold - hysteresis
 *   confirm    - 连续确认次数；小于 1 按 1 处理
 *
 * 返回：
 *   1 = 当前处于危险
 *   0 = 当前安全或该通道被禁用
 *
 * 注意：
 *   - 无效读数不会增加或清零 streak，相当于“这一拍不存在”；
 *   - confirm 次是“连续”的，中间夹一次不满足就重新计数；
 *   - 解除时同样要求连续 confirm 次低于解除线，避免临界值抖动。 */
static inline int mq_stab_update(mq_stab_t *s, int valid, int raw, int threshold, int hysteresis, int confirm)
{
    int clear_level;

    if (!valid) return s->danger;          /* 读数不可信：保持原判定 */
    if (threshold >= 4096) { s->danger = 0; s->streak = 0; return 0; }  /* 通道禁用 */
    if (confirm < 1) confirm = 1;
    clear_level = threshold - hysteresis;
    if (clear_level < 0) clear_level = 0;  /* 解除线不能是负数 */

    if (!s->danger) {
        /* 当前安全：只有连续 confirm 次超过阈值才转为危险 */
        if (raw >= threshold) {
            if (++s->streak >= confirm) { s->danger = 1; s->streak = 0; }
        } else {
            s->streak = 0;                 /* 中间有一次没到阈值，重新计数 */
        }
    } else {
        /* 当前危险：只有连续 confirm 次低于“阈值-回差”才解除 */
        if (raw < clear_level) {
            if (++s->streak >= confirm) { s->danger = 0; s->streak = 0; }
        } else {
            s->streak = 0;   /* 灰色区（含刚到阈值附近）：维持危险 */
        }
    }
    return s->danger;
}

/* ===================== 告警状态机 =====================
 *
 * 状态流转：
 *
 *   NORMAL --(任一危险达到条件)--> ALARM --(收到匹配 ack)--> ACKED
 *      ^                              |                        |
 *      |                              | 危险消失                | 危险消失后重新武装
 *      |                              v                        v
 *      +--------(所有危险解除)---- WARN/NORMAL         同种危险再出现 -> 允许新 ALARM
 *
 * 设计要点：
 *   - ALARM 期间同类型危险持续存在，不重复生成新 alarmId，避免告警风暴；
 *   - ACK 只接受“精确匹配当前 alarmId”的确认，避免旧 ACK 误确认新事件；
 *   - ACKED 只屏蔽“已被确认的那一种危险”：它必须先消失（重新武装），
 *     再出现才允许新告警；换成另一种危险则立即报警。
 *   - 状态机只做决定，不操作蜂鸣器/LED；buzzer 字段只是“应该响/静音”的意图，
 *     由 node_main.c 转成实际硬件动作。
 */

#define ALARM_STATE_NORMAL 0   /* 正常 */
#define ALARM_STATE_WARN   1   /* 有异常趋势，尚未达到告警条件 */
#define ALARM_STATE_ALARM  2   /* 正在告警 */
#define ALARM_STATE_ACKED  3   /* 家属已确认，等待危险消失 */

typedef struct {
    int  state;         /* 当前状态：ALARM_STATE_* */
    char type[24];      /* 当前/最近一次告警类型，如 "MANUAL_SOS" */
    char id[40];        /* 当前告警 ID，云端按它去重、ACK 按它匹配 */
    int  acked_armed;   /* ACKED 后该危险是否已确认消失（1=重新武装） */
    int  buzzer;        /* 1=应响 0=应静音（仅意图，不直接操作硬件） */
} alarm_sm_t;

/* 初始化为 NORMAL：清空类型/ID，静音。 */
static inline void alarm_sm_init(alarm_sm_t *sm)
{
    sm->state = ALARM_STATE_NORMAL;
    sm->type[0] = '\0';
    sm->id[0] = '\0';
    sm->acked_armed = 0;
    sm->buzzer = 0;
}

/* 判断“现在是否允许为 new_type 新建一条告警”。
 *
 * 返回 1 允许、0 拒绝。拒绝的两种情况：
 *   1. 已处于 ALARM，且类型与当前相同：同一事件持续，不能重复建 ID；
 *   2. 已处于 ACKED，类型相同且尚未重新武装：家属刚确认过，危险还没消失，
 *      不能因为下一条上报又响一次。
 * 不同类型的危险始终允许新建；1 秒内同类型去重由调用方负责。
 * cur_type 允许为 NULL（表示当前没有类型）。 */
static inline int alarm_raise_allowed(int state, const char *cur_type, int acked_armed, const char *new_type)
{
    if (state == ALARM_STATE_ALARM && cur_type && strcmp(cur_type, new_type) == 0) return 0;
    if (state == ALARM_STATE_ACKED && cur_type && strcmp(cur_type, new_type) == 0 && !acked_armed) return 0;
    return 1;
}

/* 新建告警。
 * 参数：
 *   sm     - 状态机
 *   type   - 告警类型（"MANUAL_SOS" / "GAS" / "SMOKE" / "CLIMATE" / ...）
 *   new_id - 调用方已经生成好的新 alarmId
 * 返回：
 *   1 = 真正新建了告警（调用方应响铃/播报/上报）
 *   0 = 被 alarm_raise_allowed 拒绝，状态不变
 * 新建后进入 ALARM，保存 type/id，清除重新武装标志，buzzer=1。
 * 字符串按固定长度拷贝并强制补 '\0'，防止超长类型把结构写坏。 */
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

/* 处理一次 ACK。
 * 只有同时满足以下条件才接受：
 *   1. 当前确实是 ALARM（WARN/NORMAL/ACKED 都不接受重复 ACK）；
 *   2. 本地有 alarmId；
 *   3. 请求里的 req_id 与本地 alarmId 完全一致（逐字符比较）。
 * 接受后：进入 ACKED、立即静音、保留 type/id（APP 还要显示这次事件）。
 * 返回 1=接受，0=拒绝（ID 不匹配或状态不对，调用方应记录但不要改状态）。 */
static inline int alarm_sm_ack(alarm_sm_t *sm, const char *req_id)
{
    if (sm->state != ALARM_STATE_ALARM) return 0;
    if (sm->id[0] == '\0' || !req_id || strcmp(sm->id, req_id) != 0) return 0;
    sm->state = ALARM_STATE_ACKED;
    sm->acked_armed = 0;
    sm->buzzer = 0;   /* ACK 立即静音，保留 alarmId/type */
    return 1;
}

/* 强制回到 NORMAL：清空 type/id、静音、取消武装。
 * 用于所有危险都已解除，或用户停止/退出告警。
 * 始终返回 1，方便调用方串在表达式里。 */
static inline int alarm_sm_reset(alarm_sm_t *sm)
{
    sm->state = ALARM_STATE_NORMAL;
    sm->acked_armed = 0;
    sm->buzzer = 0;
    sm->type[0] = '\0';
    sm->id[0] = '\0';
    return 1;
}

/* ACKED 状态下检查“被确认的危险是否已经真正消失”。
 * 只有 state==ACKED 且 danger_present==0 才重新武装（acked_armed=1）。
 * 返回 1=本次完成了重新武装（调用方可以记日志），0=没变化。
 * 重新武装的含义：同种危险再出现时，alarm_raise_allowed 会重新允许告警。 */
static inline int alarm_sm_rearm(alarm_sm_t *sm, int danger_present)
{
    if (sm->state != ALARM_STATE_ACKED) return 0;
    if (danger_present) return 0;
    sm->acked_armed = 1;
    return 1;
}

/* 危险类型优先级，数字越大越紧急。
 * 多条危险同时存在时，上报/播报选优先级最高的那条：
 *   MANUAL_SOS(6) > WATER_LEAK(5) > GAS(4) > SMOKE(3) > CLIMATE(2) > NO_MOTION(1)
 * 厨房只用 GAS/SMOKE/CLIMATE/NO_MOTION；
 * 卫生间只用 MANUAL_SOS/WATER_LEAK/CLIMATE/NO_MOTION。
 * 未知类型返回 0。 */
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

/* ===================== PIR 人体活动 =====================
 * PIR 输出是“有人移动”的脉冲，可能很短，也可能抖动。
 * 这里要求连续 confirm 次高电平才算一次有效活动；
 * 只在“从无到有”的上升沿返回 1，持续有人不会每秒重复计数。 */

typedef struct {
    int stable;   /* 1=已确认有活动 */
    int streak;   /* 连续有效采样次数 */
} pir_debounce_t;

/* 复位为“无活动”。 */
static inline void pir_reset(pir_debounce_t *p)
{
    p->stable = 0;
    p->streak = 0;
}

/* 喂一次 PIR 原始电平。
 *   raw_active：1=本次采样为高（有人），0=低
 *   confirm   ：连续多少次高电平才算确认
 * 返回 1 表示“确认到一次新的活动”（上升沿），调用方据此更新 lastActiveTs/countToday；
 * 返回 0 表示没有新的活动（可能一直有人，也可能只是毛刺）。
 * 一次低电平会把 streak 清零，所以“连续”是严格的。 */
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

/* ===================== SOS 按键（GPIO 版） =====================
 * 按键另一端接 GND，内部上拉：松开=1，按下=0。
 * 要求“按下沿”触发，长按不重复；松开后重新武装。
 * 上电后必须先看到一次松开（released_seen=1），
 * 否则如果按键悬空/常闭/上电就被按住，会被误认为一次求助。 */

typedef struct {
    int pressed_stable;
    int streak;
    int released_seen;   /* 上电后必须先观察到“松开”才允许触发，防止悬空/常闭触点误报 */
} sos_button_t;

/* 复位：未按下、未武装。 */
static inline void sos_reset(sos_button_t *b)
{
    b->pressed_stable = 0;
    b->streak = 0;
    b->released_seen = 0;
}

/* 喂一次按键状态。
 *   raw_pressed：1=按下（低电平），0=松开
 *   confirm    ：连续多少次按下才确认
 * 返回 1 表示“需要生成一次 MANUAL_SOS”（只在按下沿返回一次）。
 * 长按期间不会重复返回 1；松开后立即复位并允许下一次触发。 */
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

/* ===================== 板载 KEY0（XL9555 版） =====================
 * 板载 KEY0 挂 XL9555 IO 扩展器，不在 ESP32-S3 的 GPIO 上。
 * 板型事实（ALIENTEK DNESP32S3 BSP：09_iic_exio/components/BSP/XL9555/xl9555.h）：
 *   #define KEY0_IO 0x8000 / #define KEY0 xl9555_pin_read(KEY0_IO)
 *   由 I2C IO 扩展器 XL9555（7 位地址 0x20）的 P1_7 读取；xl9555_key_scan()
 *   以 KEY0==0 判定按下，即低电平有效。
 *   xl9555_ioconfig(0xF003) 把 P1_4..P1_7 配置为输入（1=输入）。
 * 只能经 I2C 输入寄存器读取，配不了内部上拉/中断；读失败时既不触发也不解除，
 * 别把通信错误变成一次求助。 */
#define SOS_KEY0_P1_BIT 0x80   /* 输入寄存器 P1（含 P1_7）的 bit7 */

/* 把一次 XL9555 P1 读数翻译成按键状态。
 * 参数：
 *   read_ok      - 本次 I2C 是否读取成功
 *   input_port1  - XL9555 的 P1 输入寄存器原始值
 * 返回：
 *    1 = 按下（P1_7 == 0）
 *    0 = 松开（P1_7 == 1）
 *   -1 = I2C 失败，状态未知；调用方必须跳过本次消抖，
 *        既不能当按下触发 SOS，也不能当松开解除告警。 */
static inline int sos_key0_pressed(int read_ok, unsigned input_port1)
{
    if (!read_ok) return -1;
    return ((input_port1 & SOS_KEY0_P1_BIT) == 0) ? 1 : 0;   /* 0=按下(低) */
}

/* ===================== 告警 ID（跨重启唯一） =====================
 * 云端按 deviceId + alarmId 去重，旧 ACK 也按 alarmId 精确匹配。
 * 如果 NTP 尚未同步，time(NULL) 仍是 0，拼出的 “e-0-<seq>” 会让不同上电周期
 * 撞成同一个 ID：新求助被云端当重复告警丢掉，上一轮遗留的 ACK 也可能误确认
 * 本次求助。所以未同步时改用上电随机盐（esp_random）作为 ID 的一部分。
 *
 * ID 形状：
 *   时间已同步：e-<epoch秒>-<seq>，例如 e-1762000000-3
 *   时间未同步：e-u<8位十六进制盐>-<seq>，例如 e-u1a2b3c4d-3
 * 字符集仍在后端 ALARM_ID_RE = /^[A-Za-z0-9._:-]{1,80}$/ 之内。
 *
 * 参数：
 *   buf      - 输出缓冲
 *   len      - 缓冲长度
 *   epoch_s  - 当前 Unix 秒；>=1700000000（2023 年）视为已同步
 *   boot_salt- 上电随机盐，同一启动周期内固定，重启后变化
 *   seq      - 同一启动周期内的告警序号
 * buf 为 NULL 或 len==0 时直接返回；输出总是以 '\0' 结尾。 */
static inline void alarm_id_build(char *buf, size_t len, long long epoch_s,
                                  unsigned boot_salt, int seq)
{
    if (!buf || len == 0) return;
    if (epoch_s >= 1700000000LL)
        snprintf(buf, len, "e-%lld-%d", epoch_s, seq);
    else
        snprintf(buf, len, "e-u%08x-%d", boot_salt, seq);
}

/* ===================== 水漏传感器 =====================
 * 水漏探头可能被水滴短暂打湿，也可能在临界状态来回跳。
 * 规则与 MQ 类似，但没有“回差”，而是用两套连续计数：
 *   - 连续 confirm 次 wet 才确认漏水（滤掉毛刺）；
 *   - 连续 clear 次干爽才解除（避免刚擦干又误报）。
 * 读数为无效时保持原状态，不重新武装。
 * 一旦确认漏水就锁存，即使中途读数无效也不会自己解除。 */

typedef struct {
    int danger;   /* 1=已确认漏水 */
    int streak;   /* 连续满足条件的次数 */
} water_stab_t;

/* 复位为“无漏水”。 */
static inline void water_reset(water_stab_t *w)
{
    w->danger = 0;
    w->streak = 0;
}

/* 喂一次水漏采样，返回更新后的 danger。
 * 参数：
 *   valid   - 本次数字量读取是否有效
 *   wet     - 1=探头湿，0=干
 *   confirm - 连续多少次湿才确认
 *   clear   - 连续多少次干才解除
 * 行为：
 *   - valid=0：保持原状态，既不确认也不解除；
 *   - 未危险：连续 confirm 次 wet -> 危险；
 *   - 已危险：连续 clear 次干 -> 解除；
 *   - 持续湿润：维持危险（ACK 只静音，不产生新 ID）。 */
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
            w->streak = 0;   /* 仍然湿：维持危险 */
        }
    }
    return w->danger;
}

/* ===================== 门磁 =====================
 * 无源干簧管干接点接 GPIO 与 GND，内部上拉；
 * 开启电平由 NODE_DOOR_OPEN_LEVEL 配置，必须按实物开/关门实测确认，
 * 别凭“常开/常闭”名称推测。
 *
 * 去抖规则：
 *   连续 confirm 次采样电平一致，才确认一次状态翻转；
 *   状态没变不产生事件。
 *
 * 上电基线：
 *   第一次连续 confirm 次稳定后的读数只作为基线，不算“刚开门/刚关门”；
 *   基线建立前，调用方把当前状态当“未知”，上报 open=null，
 *   不得凭空造一条历史事件。
 *
 * door_update 返回 1 表示状态已翻转，调用方据此生成带 seq 的事件并入补传缓存。 */

typedef struct {
    int baseline_set;   /* 1=已用连续稳定读数建立基线 */
    int stable_open;    /* 当前已确认状态：1=开启 0=关闭 */
    int streak;         /* 与最近原始电平一致的连续读数次数 */
    int last_raw;       /* 上次原始电平（-1=尚无读数） */
} door_debounce_t;

/* 复位门磁状态：无基线、无读数。 */
static inline void door_reset(door_debounce_t *d)
{
    d->baseline_set = 0;
    d->stable_open = 0;
    d->streak = 0;
    d->last_raw = -1;
}

/* 喂一次门磁原始电平。
 * 参数：
 *   raw_level  - 本次 GPIO 原始电平（0/1）
 *   open_level - 哪个电平代表“开门”（来自 Kconfig）
 *   confirm    - 连续多少次一致才确认
 * 返回：
 *   1 = 确认状态翻转（调用方生成事件）
 *   0 = 没翻转，或仍处于建立基线阶段
 * 实现细节：
 *   - 原始电平变化时 streak 从 1 重新计数；不变则累加；
 *   - 基线阶段只记录 stable_open，不返回事件；
 *   - 基线之后，稳定且状态不同才返回 1。 */
static inline int door_update(door_debounce_t *d, int raw_level, int open_level, int confirm)
{
    int open = (raw_level == open_level) ? 1 : 0;
    if (confirm < 1) confirm = 1;
    if (raw_level != d->last_raw) {
        d->last_raw = raw_level;
        d->streak = 1;                     /* 电平变化：重新计数 */
    } else {
        d->streak++;
    }
    if (!d->baseline_set) {
        if (d->streak >= confirm) {        /* 上电首次稳定读数 -> 建立基线，不产生事件 */
            d->baseline_set = 1;
            d->stable_open = open;
        }
        return 0;
    }
    if (d->streak >= confirm && open != d->stable_open) {
        d->stable_open = open;             /* 稳定翻转：调用方生成事件 */
        return 1;
    }
    return 0;
}

/* ===================== 温湿度 =====================
 * 与 MQ/水漏一致：连续确认 + 回差，不拿缺失/无效读数参与判定。
 *
 *   valid=0：缺失、I2C 失败、CRC 错、超范围（物理不可能）——
 *            既不判危险，也不判恢复，直接保持上一次有效判定；
 *   触发：连续 confirm 次有效读数越界才置 danger；
 *   解除：连续 clear 次有效读数回到“回差带内”才清 danger；
 *   回差带内但未到解除次数、或仍在原始阈值外：维持当前状态（消抖）。
 *
 * 回差语义：
 *   温度：高于上限时，需 temp <= high-hyst 才算回到安全；
 *         低于下限时，需 temp >= low+hyst 才算回到安全。
 *   湿度同理。
 * 如果配置让 high-hyst < low+hyst（阈值区间比回差还窄），
 * 则把回差置 0，退化为原始阈值，避免永远无法解除。
 *
 * 这四个开关量（temp/rh 的高低）是“或”的关系：
 * 任意一项越界就算 raw_out；四项都回到回差带内才算 safe_in。 */

typedef struct {
    int danger;   /* 1=已确认温湿度越界 */
    int streak;   /* 连续满足条件的有效采样次数 */
} climate_stab_t;

/* 复位为“无越界”。 */
static inline void climate_stab_reset(climate_stab_t *s)
{
    s->danger = 0;
    s->streak = 0;
}

/* 喂一次有效温湿度读数，返回更新后的 danger（1=越界）。
 *
 * 参数：
 *   s                 - 状态
 *   valid             - 本次读数是否有效（无效时直接返回原状态）
 *   temp / rh         - 当前温度（°C）/ 湿度（%）
 *   temp_low/high     - 温度正常区间
 *   rh_low/high       - 湿度正常区间
 *   temp_hyst/rh_hyst - 回差宽度
 *   confirm           - 连续多少次越界才触发
 *   clear             - 连续多少次回到安全区才解除
 *
 * 参数保护：
 *   - confirm/clear 小于 1 按 1；
 *   - 回差为负按 0；
 *   - 上下限写反时自动交换；
 *   - 回差比区间还宽时把回差置 0。
 * 这些保护让 Kconfig 填错时逻辑仍能收敛，不会永久卡在危险状态。 */
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

    /* 原始越界：任意一项超出正常区间（不含回差） */
    raw_out = (temp < (float)temp_low) || (temp > (float)temp_high) ||
              (rh < (float)rh_low) || (rh > (float)rh_high);
    /* 完全回到回差带内：四项都在“上限-回差 .. 下限+回差”之间 */
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

/* ===================== 温湿度告警原因 =====================
 * 告警状态机只保存 "CLIMATE" 一个类型，但播报必须说清到底是温度、湿度还是
 * 两者异常，不能张冠李戴。
 *
 * 在触发那一刻，用同一条有效读数与同一组阈值判定原因：
 *   valid=0（本次读数无效）-> 无法判断 -> UNKNOWN，只能播通用文案；
 *   温度越界、湿度未越界 -> TEMP；
 *   湿度越界、温度未越界 -> RH；
 *   两者都越界 -> BOTH。
 *
 * 注意：这里只决定播报措辞，不改变“是否告警”的判定；
 * 是否告警仍由 climate_stab_update 决定。 */

#define CLIMATE_REASON_UNKNOWN 0   /* 原因未知（读数无效或未越界） */
#define CLIMATE_REASON_TEMP    1   /* 仅温度越界 */
#define CLIMATE_REASON_RH      2   /* 仅湿度越界 */
#define CLIMATE_REASON_BOTH    3   /* 温度和湿度都越界 */

/* 根据一次有效读数判断告警文案原因。
 * 参数与 climate_stab_update 的前几个参数一致（不带回差）。
 * 返回 CLIMATE_REASON_*。 */
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

/* ===================== 持续告警限频提醒 =====================
 * 告警一直不解除时，隔一段时间再提醒一次（响铃/播报），
 * 但不能每个上报周期都响。判断依据：
 *   active=1        必须处于未 ACK/未停止的 ALARM；
 *   suppressed=1    用户已手动静音/停止，本次不再提醒；
 *   interval_sec<=0 只在触发时提醒一次；
 *   last_remind_ms<=0 表示还没提醒过，立即到期。
 * 返回 1=现在应再提醒一次，0=还没到时间或不应提醒。 */
static inline int alarm_repeat_due(int active, int suppressed,
                                   long long now_ms, long long last_remind_ms,
                                   int interval_sec)
{
    if (!active || suppressed) return 0;
    if (interval_sec <= 0) return 0;
    if (last_remind_ms <= 0) return 1;
    return (now_ms - last_remind_ms) >= (long long)interval_sec * 1000;
}

/* ===================== 无活动提醒的启用条件 =====================
 * 三个条件都满足才允许“长时间无活动”提醒：
 *   pir_enabled=1：该房间编译期接有 PIR；
 *   pir_armed=1  ：本次启动后至少确认过一次有效活动
 *                  （避免断线常低被当成“无人活动”）；
 *   paused=0     ：用户未暂停监护
 *                  （暂停状态写 NVS、跨重启保持，不得自动反向恢复）。
 * 传感器缺失或没有有效数据时，宁可不提醒，也不误报。 */
static inline int no_motion_enabled(int pir_enabled, int pir_armed, int paused)
{
    return pir_enabled && pir_armed && !paused;
}

/* NTP 首次同步后是否允许重置“最近活动”基准。
 * 只有 PIR 启用时才需要重置：同步前 now_ms 可能是小数值，
 * 直接和 last_motion 比较会误判“很久没活动”。
 * 厨房 PIR=-1，因此这里返回 0，不会动它的运动计时。 */
static inline int ntp_reset_motion_baseline(int pir_enabled)
{
    return pir_enabled ? 1 : 0;
}

/* 把内部的 0/1 有效标志翻译成 JSON 里的 true/false 字符串。
 * 只允许本次读取成功才算 true；失败时不能沿用上一次的值。 */
static inline const char *json_valid_str(int sensor_valid)
{
    return sensor_valid ? "true" : "false";
}

#endif /* ALARM_LOGIC_H */
