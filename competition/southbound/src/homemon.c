/*
 * homemon —— DAYU200 板端守护进程。
 *
 * 采集 GPIO/I2C/SARADC，做阈值判定与告警状态机，驱动三色灯、蜂鸣器与语音播报；
 * 状态行同时写 stdout/status.json，并通过 TCP:9000 广播给板载 APP 与 PC 桥接。
 * ACK 需要 alarmId 精确匹配，处置记录写入 safety.log。
 *
 * 引脚与阈值在 homemon.conf；程序不依赖 OpenHarmony 专有头文件，可用 OH NDK 交叉编译。
 */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
#include <time.h>
#include <sys/time.h>
#include <stdint.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <arpa/inet.h>
#include "time_util.h" /* 可信时间判定 + 64 位毫秒/UTC 换算（纯逻辑，可单测） */
#include "climate_valid.h" /* 本次温湿度读取有效性（纯逻辑，可单测） */
#include "motion_gate.h" /* 活动监测能力/有效性/时钟跳变（纯逻辑，可单测） */
#include "judge_logic.h" /* 判定段优先级与无 PIR 门控（纯逻辑，可单测） */

#define I2C_SLAVE 0x0703

/* ------------------------------------------------------------------ 配置 */
typedef struct {
    int   motion_gpio[4];   int motion_cnt;      /* 红外人体，可多个 */
    int   door_gpio;                             /* 门磁，-1 表示禁用 */
    int   button_gpio;                           /* 随身求助按钮，-1 禁用 */
    int   buzzer_gpio;                           /* 有源蜂鸣器，-1 禁用 */
    int   motion_active_high;                    /* 触发电平 */
    int   button_active_high;
    char  i2c_dev[128];     int i2c_addr;        /* 例如 /dev/i2c-3, 0x44 */
    char  led_red[128], led_green[128], led_blue[128];  /* /sys/class/leds/<name> */
    char  say_cmd[256];                          /* 播报命令模板，%s 为文本 */
    int   no_motion_sec;                         /* 无活动告警阈值（秒） */
    int   warn_ratio;                            /* 达到该比例先 WARN，如 60(%) */
    float temp_high, temp_low, rh_high, rh_low;  /* 温湿度阈值 */
    int   tick_sec;                              /* 主循环周期 */
    int   report_every_sec;                      /* 状态上报周期 */
    int   warmup_sec;                            /* 启动宽限期：忽略输入，避免悬空引脚误报 */
    int   debounce_ticks;                        /* 连续 N 个 tick 一致才认账 */
    int   tcp_port;                              /* TCP 状态通道端口，0=关闭（配合 hdc fport） */
    char  device_id[48];                         /* 设备编号：多节点时区分房间（如 dayu200-bedroom） */
    char  room[48];                              /* 房间/位置说明（上报给北向用于展示） */
    int   adc_dev;                               /* IIO 设备序号：fe720000.saradc = 0 */
    int   gas_adc_ch;                            /* 燃气 MQ-2 的 ADC 通道（VIN4=4），-1=未接 */
    int   smoke_adc_ch;                          /* 烟雾 MQ-5 的 ADC 通道（VIN5=5），-1=未接 */
    int   gas_alarm_raw;                         /* 原始值 ≥ 该值判为燃气泄漏（实测后校准） */
    int   smoke_alarm_raw;
    char  dir[160];                              /* 运行目录：日志/控制/状态 */
    char  gpio_root[128];                        /* GPIO sysfs 根目录；仅台架模拟时改，默认 /sys/class/gpio */
} cfg_t;

/* ------------------------------------------------------------------ 状态 */
typedef enum { ST_NORMAL = 0, ST_WARN, ST_ALARM, ST_ACKED } state_t;
static const char *st_name(state_t s)
{
    switch (s) {
    case ST_NORMAL: return "NORMAL";
    case ST_WARN:   return "WARN";
    case ST_ALARM:  return "ALARM";
    default:        return "ACKED";
    }
}

/* 毫秒时间戳必须用 64 位：ARM32 用户态（OH 7.0）与 32 位平台下 long 只有 32 位，
 * ts.tv_sec*1000（约 1.8e12）会溢出，导致定时与"多久以前"计算全部错乱。 */
typedef int64_t ms_t;

typedef struct {
    state_t state;
    ms_t    last_motion_ms;      /* 最近一次检测到活动（64 位毫秒） */
    long    motion_count_today;
    int     door_open;
    ms_t    last_door_ms;
    float   temp_c, rh;
    int     climate_ok;          /* 阈值判断结果；不等于“本次读取成功” */
    int     climate_valid;       /* 本次温湿度读取是否有效 */
    int     gas_raw, smoke_raw;      /* 燃气/烟雾 ADC 原始值 */
    int     gas_ok, smoke_ok;
    char    alarm_id[40];
    char    alarm_type[32];
    char    alarm_evidence_id[96]; /* PC 触发帧关联键；不是设备告警 ID */
    ms_t    alarm_start_ms;
    int     alarm_acked;         /* 该告警是否已处置（防止重复 ACK） */
    long    ack_count;
    long    alarm_count_today;
 /* PC 侧帧失联监视：1=监护链路在线，0=失联，-1=从未收到过（不告警）。
       与告警状态机无关，只由 monitor 命令改写，因此不会被历史 NORMAL 覆盖。 */
    int     monitor_online;
    char    monitor_reason[24];
} rt_t;

static cfg_t g_cfg;
static rt_t  g_rt;
static int   g_door_last = -1;   /* 门磁消抖 */
static int   g_door_cnt = 0;
static int   g_sos_cnt = 0;      /* 求助按钮消抖 */

/* ---------------------------------------- 活动监测能力
 * PIR 是否真的“存在且可读”必须在启动时确认，并用它门控 NO_MOTION
 * 与“活动间隔 WARN”。无 PIR 时（客厅只有摄像头，没有 PIR）：
 * - 不产生新的 NO_MOTION；
 * - 不因“无活动数据”进入 WARN；
 * - JSON 里 sensors.motion.supported=false，UI 显示“未配置 PIR 无活动监测”。
 * 摄像头/监护链路（monitorOnline/monitorReason）是另一套字段，与此无关。 */
static int   g_motion_configured_cnt = 0;  /* 配置中有效（>=0）的 PIR 路数 */
static int   g_motion_usable_cnt     = 0;  /* 启动自检可读的 PIR 路数 */
static int   g_motion_readable_now   = 0;  /* 本 tick 成功读取的 PIR 路数 */
static int   g_motion_read_fail_ticks = 0; /* 连续无有效读数的 tick 数（仅日志去抖） */
static int   g_motion_monitor_enabled = 0; /* = mg_monitor_enabled(configured, usable) */
static ms_t  g_prev_tick_ms = 0;           /* 上一 tick 的墙钟，用于时钟跳变检测 */

/* ------------------------------------------------------------------ 基础 */
static ms_t wall_ms(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    return (ms_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

static void logmsg(const char *fmt, ...)
{
    va_list ap;
    char line[512];
    int n = snprintf(line, sizeof(line), "[%ld] ", (long)time(NULL));
    va_start(ap, fmt);
    vsnprintf(line + n, sizeof(line) - n, fmt, ap);
    va_end(ap);
    printf("%s\n", line);
    fflush(stdout);
    char path[256];
    snprintf(path, sizeof(path), "%s/homemon.log", g_cfg.dir);
    FILE *f = fopen(path, "a");
    if (f) { fprintf(f, "%s\n", line); fclose(f); }
}

/* 可信时间：口径与 PC 侧 southbound/dayu-time-sync.js 保持一致（见 time_util.h）。
   板端 RTC 掉电后系统时间会回退到 2017，此时"13 位毫秒"格式合法但绝对时间错误，
   必须显式判定为不可信并留下日志，不能静默上报。 */
static int wall_time_trusted(void)
{
    return tu_epoch_ms_trusted((int64_t)wall_ms());
}

static void log_utc(int64_t ms, const char *what)
{
    int64_t y;
    int mo, d, h, mi, s;
    tu_ms_to_utc(ms, &y, &mo, &d, &h, &mi, &s);
    logmsg("%s UTC=%04lld-%02d-%02dT%02d:%02d:%02dZ epoch_ms=%lld",
           what, (long long)y, mo, d, h, mi, s, (long long)ms);
}

static int write_file(const char *path, const char *val)
{
    int fd = open(path, O_WRONLY);
    if (fd < 0) return -1;
    ssize_t n = write(fd, val, strlen(val));
    close(fd);
    return n == (ssize_t)strlen(val) ? 0 : -1;
}

static int read_file(const char *path, char *buf, size_t n)
{
    int fd = open(path, O_RDONLY);
    if (fd < 0) return -1;
    ssize_t r = read(fd, buf, n - 1);
    close(fd);
    if (r <= 0) return -1;
    buf[r] = '\0';
    return 0;
}

/* --------------------------------------------------------------- GPIO */
/* 统一走 sysfs：<gpio_root>/gpio<N>/{direction,value}，默认 /sys/class/gpio。
 * 上板后用 `cat /sys/kernel/debug/gpio` 或原理图确认编号。
 * gpio_root 只用于 PC 台架模拟（指向假的 GPIO 目录），正式部署保持默认。 */
static int gpio_prepare(int pin, const char *dir)
{
    char path[256];
    snprintf(path, sizeof(path), "%s/gpio%d", g_cfg.gpio_root, pin);
    if (access(path, F_OK) != 0) {
        char num[16];
        snprintf(num, sizeof(num), "%d", pin);
        char exp[256];
        snprintf(exp, sizeof(exp), "%s/export", g_cfg.gpio_root);
        write_file(exp, num);
        usleep(60000);
    }
    snprintf(path, sizeof(path), "%s/gpio%d/direction", g_cfg.gpio_root, pin);
    return write_file(path, dir);
}

static int gpio_read_pin(int pin)
{
    char path[256], buf[8];
    snprintf(path, sizeof(path), "%s/gpio%d/value", g_cfg.gpio_root, pin);
    if (read_file(path, buf, sizeof(buf)) != 0) return -1;
    return buf[0] == '1' ? 1 : 0;
}

static int gpio_write_pin(int pin, int val)
{
    char path[256];
    snprintf(path, sizeof(path), "%s/gpio%d/value", g_cfg.gpio_root, pin);
    return write_file(path, val ? "1" : "0");
}

/* --------------------------------------------------------- I2C / SHT30 */
static int i2c_read_reg(int fd, uint8_t *buf, size_t len)
{
    return read(fd, buf, len) == (ssize_t)len ? 0 : -1;
}

/* SHT30：命令 0x2C06 = 高重复性、非时钟拉伸测量 */
static int sht30_read(float *temp_c, float *rh)
{
    if (g_cfg.i2c_dev[0] == '\0') return -1;
    int fd = open(g_cfg.i2c_dev, O_RDWR);
    if (fd < 0) return -1;
    if (ioctl(fd, I2C_SLAVE, g_cfg.i2c_addr) < 0) { close(fd); return -1; }
    uint8_t cmd[2] = { 0x2C, 0x06 };
    if (write(fd, cmd, 2) != 2) { close(fd); return -1; }
    usleep(20000);
    uint8_t d[6];
    if (i2c_read_reg(fd, d, 6) != 0) { close(fd); return -1; }
    close(fd);
    uint16_t rawt = (uint16_t)(d[0] << 8 | d[1]);
    uint16_t rawr = (uint16_t)(d[3] << 8 | d[4]);
 *temp_c = -45.0f + 175.0f * rawt / 65535.0f;
 *rh = 100.0f * rawr / 65535.0f;
    return 0;
}

/* --------------------------------------------------------------- SARADC */
/* RK3568 板载 SARADC（fe720000.saradc）暴露为 IIO：
 * /sys/bus/iio/devices/iio:device<N>/in_voltage<M>_raw
 * 扩展口 J9903 的 6/8/10 脚即 VIN4/VIN5/VIN6，用于燃气 MQ-2 / 烟雾 MQ-5。 */
static int adc_read_raw(int dev, int ch, int *out)
{
    if (ch < 0) return -1;
    char path[256], buf[32];
    snprintf(path, sizeof(path),
             "/sys/bus/iio/devices/iio:device%d/in_voltage%d_raw", dev, ch);
    if (read_file(path, buf, sizeof(buf)) != 0) return -1;
 *out = atoi(buf);
    return 0;
}

/* -------------------------------------------------------------- 执行器 */
static void led_set(const char *led, int on)
{
    if (!led || !led[0]) return;
    char path[256];
    snprintf(path, sizeof(path), "%s/brightness", led);
    write_file(path, on ? "255" : "0");
}

static void led_rgb(int r, int g, int b)
{
    led_set(g_cfg.led_red, r);
    led_set(g_cfg.led_green, g);
    led_set(g_cfg.led_blue, b);
}

static void buzzer_set(int on)
{
    if (g_cfg.buzzer_gpio >= 0) gpio_write_pin(g_cfg.buzzer_gpio, on);
}

static void say(const char *text)
{
    if (!g_cfg.say_cmd[0]) { logmsg("SAY: %s（未配置播报命令）", text); return; }
    char cmd[512];
    snprintf(cmd, sizeof(cmd), g_cfg.say_cmd, text);
    logmsg("SAY: %s", text);
    int rc = system(cmd);
    if (rc != 0) logmsg("WARN 播报命令返回 %d", rc);
}

/* ----------------------------------------------------- 报警与状态迁移 */
static void alarm_raise(const char *type, const char *detail)
{
    g_rt.state = ST_ALARM;
    g_rt.alarm_count_today++;
    snprintf(g_rt.alarm_type, sizeof(g_rt.alarm_type), "%s", type);
 /* 每个新告警先清空关联，只有经过严格校验的 FALL 命令才能再写入。 */
    g_rt.alarm_evidence_id[0] = '\0';
    snprintf(g_rt.alarm_id, sizeof(g_rt.alarm_id), "a-%ld-%ld",
             (long)time(NULL), g_rt.alarm_count_today);
    g_rt.alarm_start_ms = wall_ms();
    g_rt.alarm_acked = 0;            /* 新告警：允许再次确认 */
    logmsg("ALARM id=%s type=%s detail=%s", g_rt.alarm_id, type, detail);
 /* 主动求助必须发声：实体按钮与联调/演示命令是两条不同入口，
       把播报放在这里才能保证任何来源的求助都会启动现场语音。 */
    if (strcmp(type, "MANUAL_SOS") == 0) {
        say("我需要帮助，请尽快联系我");
    } else if (strcmp(type, "FALL") == 0) {
        say("检测到疑似跌倒，请确认是否需要帮助");
    }
}

/* YOLO 证据 ID：fall-<毫秒时间>-<trackId|na>。
 * 仅允许 ASCII 数字和固定分隔符，避免命令注入和 JSON 转义问题。 */
static int valid_fall_evidence_id(const char *value)
{
    const char *p;
    int digits = 0;
    if (!value || strncmp(value, "fall-", 5) != 0) return 0;
    p = value + 5;
    while (*p >= '0' && *p <= '9' && digits < 16) { p++; digits++; }
    if (digits < 1 || *p != '-') return 0;
    p++;
    if (strcmp(p, "na") == 0) return 1;
    digits = 0;
    while (*p >= '0' && *p <= '9' && digits < 12) { p++; digits++; }
    return digits >= 1 && *p == '\0';
}

static void state_tick(int tick)
{
 /* 输出：按状态给三色灯与蜂鸣不同节奏（1Hz tick） */
    int phase = tick % 4;
    switch (g_rt.state) {
    case ST_NORMAL: led_rgb(0, 1, 0); buzzer_set(0); break;               /* 绿灯常亮 */
    case ST_WARN:   led_rgb(phase < 2, phase < 2, 0); buzzer_set(0); break;/* 黄灯慢闪 */
    case ST_ALARM:  led_rgb(phase < 2, 0, 0); buzzer_set(phase < 2); break;/* 红闪+鸣 */
    case ST_ACKED:  led_rgb(0, 0, phase < 2); buzzer_set(0); break;        /* 蓝灯 */
    }
}

/* ------------------------------------------------- 日统计（周/月报告数据源）
 * 持久化到 <dir>/daily.txt，一行：
 * <dayIndex> c0 c1 c2 c3 c4 c5 c6 s0 s1 s2 s3
 * c6 = 今日活动次数，c0..c5 = 之前 6 天；s0..s3 = 今日四个时段的活动次数
 * 这样北向"每日活动频次趋势 / 时段分布"展示的是设备真实累计值，而非模拟数据。 */
static long g_days[7]  = {0, 0, 0, 0, 0, 0, 0};
static int  g_slots[4] = {0, 0, 0, 0};
static long g_day_idx  = -1;
static int  g_hist_dirty = 0;

static void hist_path(char *buf, size_t n)
{
    snprintf(buf, n, "%s/daily.txt", g_cfg.dir);
}

static void hist_save(void)
{
    char p[256];
    hist_path(p, sizeof(p));
    FILE *f = fopen(p, "w");
    if (!f) return;
    fprintf(f, "%ld", g_day_idx);
    for (int i = 0; i < 7; i++) fprintf(f, " %ld", g_days[i]);
    for (int i = 0; i < 4; i++) fprintf(f, " %d", g_slots[i]);
    fputc('\n', f);
    fclose(f);
}

static void hist_load(void)
{
    char p[256];
    hist_path(p, sizeof(p));
    FILE *f = fopen(p, "r");
    if (!f) return;
    long d = -1;
    if (fscanf(f, "%ld", &d) == 1) g_day_idx = d;
    for (int i = 0; i < 7; i++) { long v = 0; if (fscanf(f, "%ld", &v) == 1) g_days[i] = v; }
    for (int i = 0; i < 4; i++) { int  v = 0; if (fscanf(f, "%d", &v) == 1) g_slots[i] = v; }
    fclose(f);
    logmsg("日统计已载入：今日 %ld 次，前 6 日 %ld/%ld/%ld/%ld/%ld/%ld",
           g_days[6], g_days[0], g_days[1], g_days[2], g_days[3], g_days[4], g_days[5]);
}

/* 跨天后把历史左移（最多补 7 天） */
static void hist_roll(long today)
{
    if (g_day_idx < 0) { g_day_idx = today; g_hist_dirty = 1; return; }
    long gap = today - g_day_idx;
    if (gap <= 0) return;
    if (gap > 7) gap = 7;
    for (long k = 0; k < gap; k++) {
        for (int i = 0; i < 6; i++) g_days[i] = g_days[i + 1];
        g_days[6] = 0;
    }
    for (int i = 0; i < 4; i++) g_slots[i] = 0;
    g_day_idx = today;
    g_hist_dirty = 1;
}

/* 记一次人体活动（含时段归类） */
static void hist_bump(long now)
{
    hist_roll(now / 86400);
    g_days[6]++;
    time_t tt = (time_t)now;
    struct tm tmv;
    localtime_r(&tt, &tmv);
    int h = tmv.tm_hour;
    int b = -1;
    if (h >= 6 && h < 9) b = 0;
    else if (h >= 9 && h < 12) b = 1;
    else if (h >= 12 && h < 18) b = 2;
    else if (h >= 18 && h < 22) b = 3;
    if (b >= 0) g_slots[b]++;
    g_hist_dirty = 1;
}

/* 前置声明：转发其他节点状态（实现在下面的 TCP 通道一节） */
static void tcp_broadcast(const char *line);
/* 前置声明：monitor 命令需要立即广播一次新状态（实现在下面的状态上报一节） */
static void report_status(int force);

/* monitor 命令的原因词只允许落在已知集合内，不把收到的字节直接写进状态 JSON */
static const char *monitor_reason_name(const char *token)
{
    static const char *known[] = {
        "no_frame", "no_first_frame", "frames_resumed", "first_frame",
        "background", "screen_off", "paused", "surface", "camera", "stopped"
    };
    for (size_t i = 0; i < sizeof(known) / sizeof(known[0]); i++) {
        if (strcmp(token, known[i]) == 0) return known[i];
    }
    return "unknown";
}

/* PC 家庭网关下发的可信时间：形如 "time 1792060628"（秒）或 "time 1792060628021"（毫秒）。
   板端没有默认路由、无法自行访问 NTP，因此这是"时间可信"的唯一外部来源之一
   （另一条是 HDC 直接 date -s，见 southbound/dayu-time-sync.js）。
   只接受可信区间内的值，设置后立即读回校验；失败必须留日志，不假报成功。 */
static void apply_trusted_time(const char *arg)
{
    while (*arg == ' ' || *arg == '\t') arg++;
    char *end = NULL;
    long long raw = strtoll(arg, &end, 10);
    if (end == arg) {
        logmsg("TIME 被拒绝：无法解析 epoch（%s）", arg);
        return;
    }
    int64_t ms = tu_normalize_epoch_ms((int64_t)raw);
    if (!tu_epoch_ms_trusted(ms)) {
        logmsg("TIME 被拒绝：epoch_ms=%lld 不在可信区间 [2025-01-01, 2100-01-01]",
               (long long)ms);
        return;
    }
    ms_t before = wall_ms();
    struct timeval tv;
    tv.tv_sec  = (time_t)(ms / 1000);
    tv.tv_usec = (suseconds_t)((ms % 1000) * 1000);
    if (settimeofday(&tv, NULL) != 0) {
        logmsg("TIME 设置失败：settimeofday errno=%d（权限不足时不冒充成功）", errno);
        return;
    }
    ms_t back = wall_ms();
    if (!tu_epoch_ms_trusted((int64_t)back) ||
        tu_abs_diff_ms((int64_t)back, ms) > 5000) {
        logmsg("TIME 设置后校验失败：期望 epoch_ms=%lld，实际 %lld",
               (long long)ms, (long long)back);
        return;
    }
 /* 校时限时整体跳变墙钟：同步平移历史时间戳，避免“9 年无活动”的假 NO_MOTION；
       同时把主循环的上一 tick 基准刷新到新时钟，防止下一 tick 再按跳变重复平移。 */
    {
        ms_t delta = back - before;
        ms_t tick_ms = (ms_t)(g_cfg.tick_sec > 0 ? g_cfg.tick_sec : 1) * 1000;
        if (mg_clock_jumped(delta, tick_ms)) {
            g_rt.last_motion_ms = mg_resync_ms(g_rt.last_motion_ms, delta);
            g_rt.last_door_ms   = mg_resync_ms(g_rt.last_door_ms, delta);
            g_rt.alarm_start_ms = mg_resync_ms(g_rt.alarm_start_ms, delta);
            logmsg("校时跳变 %+lld ms：历史时间戳已平移（不据此判定无活动）",
                   (long long)delta);
        }
        g_prev_tick_ms = back;
    }
    log_utc((int64_t)back, "TIME 已接受，系统时钟已校准：");
    report_status(1);                 /* 立即用新时间广播一条，避免 APP 继续看到 2017 */
}

/* ------------------------------------------------- 命令处理（文件/TCP 共用） */
static void handle_command(const char *line)
{
    while (*line == ' ' || *line == '\t') line++;
    if (strncmp(line, "route ", 6) == 0) {
 /* 目标路由： route <deviceId> <原命令>
           目标是本机 -> 只在本机执行 <原命令>；否则把整行广播给 TCP 客户端，
           由作为 relay 客户端的桥接转发给对应无线节点（本机不执行）。 */
        char buf[512];
        snprintf(buf, sizeof(buf), "%s", line);
        size_t bl = strlen(buf);
        while (bl > 0 && (buf[bl - 1] == '\n' || buf[bl - 1] == '\r' || buf[bl - 1] == ' ')) buf[--bl] = '\0';
        char *tgt = buf + 6;
        while (*tgt == ' ' || *tgt == '\t') tgt++;
        char *cmd = tgt;
        while (*cmd && *cmd != ' ' && *cmd != '\t') cmd++;
        size_t tlen = (size_t)(cmd - tgt);
        while (*cmd == ' ' || *cmd == '\t') cmd++;
        if (tlen == 0 || *cmd == '\0') {
            logmsg("ROUTE 被拒绝：目标或命令为空（%s）", buf);
            return;
        }
        if (strncmp(cmd, "route", 5) == 0 || strncmp(cmd, "relay", 5) == 0) {
            logmsg("ROUTE 被拒绝：禁止嵌套 route/relay（%s）", buf);
            return;
        }
        if (tlen == strlen(g_cfg.device_id) && strncmp(tgt, g_cfg.device_id, tlen) == 0) {
            logmsg("ROUTE 本机执行：%s", cmd);
            handle_command(cmd);
        } else {
            logmsg("ROUTE 转发远端 %.*s：%s", (int)tlen, tgt, cmd);
            tcp_broadcast(buf);
        }
    } else if (strncmp(line, "relay ", 6) == 0) {
 /* 桥接注入的其他节点状态行 -> 原样广播给所有客户端（含板上 APP），
           这样无线/其他房间节点也能出现在北向应用的房间列表里。
           只接受 JSON 状态行：防止借 relay 伪造出一条 route 命令广播给桥接 */
        const char *pl = line + 6;
        while (*pl == ' ') pl++;
        if (*pl != '{') {
            logmsg("RELAY 被拒绝：非 JSON 状态行");
            return;
        }
        tcp_broadcast(pl);
    } else if (strncmp(line, "ack", 3) == 0) {
 /* 形如： ack <alarmId> <处置说明> */
        const char *rest = line + 3;
        while (*rest == ' ') rest++;
        char aid[40];
        aid[0] = '\0';
        const char *sp = strchr(rest, ' ');
        if (sp) {
            size_t n = (size_t)(sp - rest);
            if (n >= sizeof(aid)) n = sizeof(aid) - 1;
            memcpy(aid, rest, n);
            aid[n] = '\0';
            rest = sp + 1;
            while (*rest == ' ') rest++;
        }
 /* 必须核对告警 ID 且要求处于告警态：否则同一 ID 可被重复确认，
           造成 ack_count 虚增、安全日志重复写入（同一事件多条处置记录）。 */
        if (g_rt.alarm_id[0] == '\0') {
            logmsg("ACK 被拒绝：当前没有待处理告警（收到 id=%s）", aid[0] ? aid : "(none)");
            return;
        }
        if (aid[0] == '\0' || strcmp(aid, g_rt.alarm_id) != 0) {
            logmsg("ACK 被拒绝：告警 ID 不匹配（当前=%s，收到=%s）", g_rt.alarm_id, aid[0] ? aid : "(none)");
            return;
        }
        if (g_rt.state != ST_ALARM) {
            logmsg("ACK 被拒绝：该告警已被确认过（当前状态=%s，id=%s）",
                   st_name(g_rt.state), g_rt.alarm_id);
            return;
        }
        if (g_rt.alarm_acked) {
            logmsg("ACK 被拒绝：该告警已处置过（id=%s）", g_rt.alarm_id);
            return;
        }
        g_rt.alarm_acked = 1;
        g_rt.state = ST_ACKED;
        g_rt.ack_count++;
        logmsg("ACK 已接受：id=%s 处置=%s", aid, rest);
        char lp[256];
        snprintf(lp, sizeof(lp), "%s/safety.log", g_cfg.dir);
        FILE *lf = fopen(lp, "a");
        if (lf) {
            fprintf(lf, "%lld,%s,%s\n", (long long)time(NULL), g_rt.alarm_id, rest);
            fclose(lf);
        }
    } else if (strncmp(line, "sos", 3) == 0) {
 /* 触发一次主动求助（与按钮走同一条判定/执行路径）；
           用于没有实体按钮时的联调与演示 */
        alarm_raise("MANUAL_SOS", "老人主动按下随身求助按钮");
    } else if (strncmp(line, "motion", 6) == 0) {
 /* 模拟一次人体活动：与真实传感器走同一条计数/日统计路径 */
        g_rt.last_motion_ms = wall_ms();
        hist_bump((long)time(NULL));
        g_rt.motion_count_today = g_days[6];
        logmsg("模拟一次人体活动（今日第 %ld 次）", g_rt.motion_count_today);
    } else if (strncmp(line, "smoke", 5) == 0) {
        alarm_raise("SMOKE", "检测到烟雾，疑似火情");
    } else if (strncmp(line, "gas", 3) == 0) {
        alarm_raise("GAS", "检测到燃气泄漏，请立即开窗通风并撤离");
    } else if (strncmp(line, "climate", 7) == 0) {
        alarm_raise("CLIMATE", "室内温湿度超出舒适区间");
    } else if (strncmp(line, "fall", 4) == 0 &&
               (line[4] == '\0' || line[4] == '\r' || line[4] == '\n' ||
                line[4] == ' ' || line[4] == '\t')) {
 /* YOLO Pose 服务只提交受限事件；告警 ID、声光语音和 ACK 仍由本机统一管理。
           同一跌倒事件在恢复或复位前只允许创建一次告警。 */
        const char *evidence = line + 4;
        char evidence_id[96];
        size_t en = 0;
        while (*evidence == ' ' || *evidence == '\t') evidence++;
        while (evidence[en] && evidence[en] != '\r' && evidence[en] != '\n' &&
               evidence[en] != ' ' && evidence[en] != '\t' && en < sizeof(evidence_id) - 1) {
            evidence_id[en] = evidence[en];
            en++;
        }
        evidence_id[en] = '\0';
        const char *etail = evidence + en;
        while (*etail == ' ' || *etail == '\t') etail++;
        if (*etail != '\0' && *etail != '\r' && *etail != '\n') {
            logmsg("FALL 被拒绝：存在多余参数");
            return;
        }
        if (evidence_id[0] && !valid_fall_evidence_id(evidence_id)) {
            logmsg("FALL 被拒绝：证据 ID 非法");
            return;
        }
        if (g_rt.state == ST_ALARM && strcmp(g_rt.alarm_type, "FALL") == 0) {
            logmsg("FALL 被忽略：当前已有待处理跌倒告警（id=%s）", g_rt.alarm_id);
        } else {
            alarm_raise("FALL", "视觉检测到疑似跌倒，请尽快查看现场");
            if (evidence_id[0]) {
                snprintf(g_rt.alarm_evidence_id, sizeof(g_rt.alarm_evidence_id), "%s", evidence_id);
                logmsg("FALL 证据已关联：alarm=%s evidence=%s", g_rt.alarm_id,
                       g_rt.alarm_evidence_id);
            }
        }
    } else if (strncmp(line, "monitor", 7) == 0 &&
               (line[7] == '\0' || line[7] == '\r' || line[7] == '\n' ||
                line[7] == ' ' || line[7] == '\t')) {
 /* PC 侧监护链路失联/恢复：形如 monitor offline no_frame。
           只改"监护链路"字段，不碰告警状态机 —— 失联是链路事件，不是跌倒告警，
           也不能被后续 NORMAL 状态覆盖。 */
        const char *arg = line + 7;
        while (*arg == ' ' || *arg == '\t') arg++;
        char tok[24];
        size_t n = 0;
        while (arg[n] && arg[n] != ' ' && arg[n] != '\t' && arg[n] != '\r' && arg[n] != '\n' &&
               n < sizeof(tok) - 1) {
            tok[n] = arg[n];
            n++;
        }
        tok[n] = '\0';
        const char *rest = arg + n;
        while (*rest == ' ' || *rest == '\t') rest++;
        char rtok[24];
        size_t rn = 0;
        while (rest[rn] && rest[rn] != ' ' && rest[rn] != '\t' && rest[rn] != '\r' &&
               rest[rn] != '\n' && rn < sizeof(rtok) - 1) {
            rtok[rn] = rest[rn];
            rn++;
        }
        rtok[rn] = '\0';
        if (strcmp(tok, "online") != 0 && strcmp(tok, "offline") != 0) {
            logmsg("MONITOR 被拒绝：状态非法（%s）", tok);
        } else {
            int online = (strcmp(tok, "online") == 0) ? 1 : 0;
            const char *reason = monitor_reason_name(rtok);
            if (g_rt.monitor_online != online) {
                logmsg("MONITOR %s：%s", online ? "online" : "offline", reason);
            }
            g_rt.monitor_online = online;
            snprintf(g_rt.monitor_reason, sizeof(g_rt.monitor_reason), "%s", reason);
            report_status(1);
        }
    } else if (strncmp(line, "time", 4) == 0 &&
               (line[4] == '\0' || line[4] == ' ' || line[4] == '\t' ||
                line[4] == '\r' || line[4] == '\n')) {
 /* 可信时间注入（PC 网关 / 后续 bridge 命令通道） */
        apply_trusted_time(line + 4);
    } else if (strncmp(line, "reset", 5) == 0) {
        g_rt.state = ST_NORMAL;
        logmsg("状态复位 -> NORMAL");
    }
}

static void poll_control(void)
{
    char path[256];
    snprintf(path, sizeof(path), "%s/control", g_cfg.dir);
    FILE *f = fopen(path, "r+");
    if (!f) return;
    char line[256];
    while (fgets(line, sizeof(line), f)) handle_command(line);
    fclose(f);
    f = fopen(path, "w");            /* 清空已处理命令 */
    if (f) fclose(f);
}

/* ------------------------------------------- TCP 状态通道（支持多客户端）
 * 用途一：PC 上 `hdc fport tcp:9000 tcp:9000` 后，桥接读取真实状态并回传命令；
 * 用途二：板上的北向 APP 同时连进来，收到本机 + 其他房间节点的状态。
 * 其他节点（如 ESP32 无线节点）的状态由桥接用 `relay <json>` 命令注入，
 * homemon 转发给所有客户端 —— 这样 APP 里能看到全部房间。 */
/* ：4->8。PC 侧 bridge(status+relay)、mirror、APP、健康探针最多可占 4-6 路；
 * 4 路会被占满导致新连接被 accept 后立刻关闭（02:46 现场：旧 socket 僵尸占满槽位，
 * DAYU 房间状态/SOS 镜像断链）。同时对新 accept 的 socket 开启 TCP keepalive，
 * 让 peer 被强杀/断电的僵尸连接在 ~45s 内被内核回收，不再永久占槽。 */
#define MAX_CLIENTS 8
typedef struct {
    int    fd;
    char   rx[1024];
    size_t rxlen;
} tcp_client_t;

static int          g_lfd = -1;
static tcp_client_t g_cli[MAX_CLIENTS];

/* 非阻塞发送：0=本条因 EAGAIN 丢弃（连接保留），1=已完整写入，-1=发送错误/写了一半 */
static int tcp_send_best_effort(int fd, const char *p, size_t n)
{
    size_t off = 0;
    while (off < n) {
        ssize_t w = send(fd, p + off, n - off, MSG_NOSIGNAL);
        if (w > 0) { off += (size_t)w; continue; }
        if (w < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
            return off == 0 ? 0 : -1;   /* 一点没写：丢弃本条不杀连接；写了一半：流已坏，关闭 */
        }
        return -1;
    }
    return 1;
}

static void tcp_broadcast(const char *line)
{
    size_t n = strlen(line);
    for (int i = 0; i < MAX_CLIENTS; i++) {
        int fd = g_cli[i].fd;
        if (fd < 0) continue;
 /* ：对端（bridge/mirror）读得慢时，旧逻辑把 EAGAIN 当致命错误直接 close，
           造成 bridge/mirror 每 10–30s 被踢一次、dayu200-living 状态断流。改为：
           EAGAIN 只丢弃本条（连接保留），真实错误/半包才关闭。 */
        int r1 = tcp_send_best_effort(fd, line, n);
        int r2 = (r1 == 1) ? tcp_send_best_effort(fd, "\n", 1) : (r1 == 0 ? 0 : -1);
        if (r1 < 0 || r2 < 0) {
            close(fd);
            g_cli[i].fd = -1;
        }
    }
}

static void tcp_start(void)
{
    for (int i = 0; i < MAX_CLIENTS; i++) {
        g_cli[i].fd = -1;
        g_cli[i].rxlen = 0;
    }
    if (g_cfg.tcp_port <= 0) return;
    g_lfd = socket(AF_INET, SOCK_STREAM, 0);
    if (g_lfd < 0) { logmsg("TCP socket 失败: %s", strerror(errno)); return; }
    int on = 1;
    setsockopt(g_lfd, SOL_SOCKET, SO_REUSEADDR, &on, sizeof(on));
    struct sockaddr_in a;
    memset(&a, 0, sizeof(a));
    a.sin_family = AF_INET;
    a.sin_addr.s_addr = htonl(INADDR_ANY);
    a.sin_port = htons((uint16_t)g_cfg.tcp_port);
    if (bind(g_lfd, (struct sockaddr *)&a, sizeof(a)) < 0 || listen(g_lfd, MAX_CLIENTS) < 0) {
        logmsg("TCP 监听 %d 失败: %s", g_cfg.tcp_port, strerror(errno));
        close(g_lfd); g_lfd = -1; return;
    }
    fcntl(g_lfd, F_SETFL, O_NONBLOCK);
    logmsg("TCP 状态通道已监听 0.0.0.0:%d（最多 %d 路客户端）", g_cfg.tcp_port, MAX_CLIENTS);
}

static void tcp_pump(void)
{
    if (g_lfd < 0) return;

 /* 接受所有待处理连接 */
    for (;;) {
        struct sockaddr_in c;
        socklen_t cl = sizeof(c);
        int fd = accept(g_lfd, (struct sockaddr *)&c, &cl);
        if (fd < 0) break;
        int slot = -1;
        for (int i = 0; i < MAX_CLIENTS; i++) {
            if (g_cli[i].fd < 0) { slot = i; break; }
        }
        if (slot < 0) { close(fd); continue; }          /* 连接数已满 */
        {
 /* 死客户端自动回收：keepalive 30s 空闲 + 5s*3 探测（~45s 判定死连接）。
               旧版本没有 keepalive，PC 上 bridge/mirror 被强杀后 socket 会永久 ESTABLISHED，
               占满 MAX_CLIENTS 导致  00:40 现场 DAYU 链路断链。
               同时把发送缓冲调大，避免 bridge/mirror 偶发慢读直接触发 EAGAIN。 */
            int ka = 1;
            setsockopt(fd, SOL_SOCKET, SO_KEEPALIVE, &ka, sizeof(ka));
            int sndbuf = 262144;
            setsockopt(fd, SOL_SOCKET, SO_SNDBUF, &sndbuf, sizeof(sndbuf));
#ifdef TCP_KEEPIDLE
            int idle = 30;
            setsockopt(fd, IPPROTO_TCP, TCP_KEEPIDLE, &idle, sizeof(idle));
#endif
#ifdef TCP_KEEPINTVL
            int intvl = 5;
            setsockopt(fd, IPPROTO_TCP, TCP_KEEPINTVL, &intvl, sizeof(intvl));
#endif
#ifdef TCP_KEEPCNT
            int cnt = 3;
            setsockopt(fd, IPPROTO_TCP, TCP_KEEPCNT, &cnt, sizeof(cnt));
#endif
        }
        g_cli[slot].fd = fd;
        g_cli[slot].rxlen = 0;
        fcntl(fd, F_SETFL, O_NONBLOCK);
        logmsg("TCP 客户端接入 %s（第 %d 路）", inet_ntoa(c.sin_addr), slot + 1);
    }

 /* 逐路读取命令 */
    for (int i = 0; i < MAX_CLIENTS; i++) {
        int fd = g_cli[i].fd;
        if (fd < 0) continue;
        char b[256];
        ssize_t n = recv(fd, b, sizeof(b), 0);
        if (n == 0) {
            close(fd); g_cli[i].fd = -1;
            logmsg("TCP 客户端断开（第 %d 路）", i + 1);
            continue;
        }
        if (n < 0) {
            if (errno != EAGAIN && errno != EWOULDBLOCK) {
                close(fd); g_cli[i].fd = -1;
                logmsg("TCP 异常断开: %s", strerror(errno));
            }
            continue;
        }
        if (g_cli[i].rxlen + (size_t)n < sizeof(g_cli[i].rx)) {
            memcpy(g_cli[i].rx + g_cli[i].rxlen, b, (size_t)n);
            g_cli[i].rxlen += (size_t)n;
        }
        char *p = g_cli[i].rx;
        for (;;) {
            char *nl = memchr(p, '\n', g_cli[i].rxlen - (size_t)(p - g_cli[i].rx));
            if (!nl) break;
 *nl = '\0';
            handle_command(p);
            p = nl + 1;
        }
        size_t used = (size_t)(p - g_cli[i].rx);
        if (used) {
            memmove(g_cli[i].rx, p, g_cli[i].rxlen - used);
            g_cli[i].rxlen -= used;
        }
    }
}

/* 兼容旧调用点：上报时广播给所有客户端 */
static void tcp_send(const char *line)
{
    tcp_broadcast(line);
}

/* ------------------------------------------------------------- 状态上报 */
static void report_status(int force)
{
    static ms_t last = 0;
    static int  trust_seen = -1;      /* -1 未判定 / 0 不可信 / 1 可信 */
    ms_t t = wall_ms();
 /* 时间戳单位：北向 APP 按毫秒解析（历史实现即 13 位毫秒）。
       用 64 位计算避免 ARM32 溢出，但输出仍是毫秒，保持与 APP 兼容。
       这里直接取 wall_ms() 的 64 位毫秒：历史写法 time(NULL)*1000 + t%1000 在
       两次取时之间发生时钟跳变（PC 网关校时刚到）时会拼出"旧秒 + 新毫秒"的混合值。 */
    ms_t ts_ms = t;
    {
        int trusted_now = tu_epoch_ms_trusted((int64_t)ts_ms);
        if (trust_seen != trusted_now) {
            trust_seen = trusted_now;
            if (trusted_now) {
                log_utc((int64_t)ts_ms, "系统时间已可信（PC 网关校时生效）：");
            } else {
                log_utc((int64_t)ts_ms,
                        "⚠ 系统时间不可信：板端 RTC 掉电回退，等待 PC 网关经 HDC 校时（southbound/dayu-time-sync.js）：");
            }
        }
    }
    if (!force && t - last < (ms_t)g_cfg.report_every_sec * 1000) return;
    last = t;
    char json[1400];
    const char *mreason = g_rt.monitor_reason[0] ? g_rt.monitor_reason : "unknown";
 /* 活动监测能力/数据：
       supported=false 表示本机没有可用的 PIR —— UI 应显示“未配置 PIR 无活动监测”，
       不能据此推导“无人活动”；reported=false 表示最近一次采样无有效读数。
       两者与摄像头监护字段 monitorOnline/monitorReason 完全独立。 */
    const char *motion_reason = mg_reason(g_motion_configured_cnt,
                                          g_motion_usable_cnt,
                                          g_motion_readable_now);
    long long last_active_ts = g_rt.last_motion_ms > 0
                               ? (long long)g_rt.last_motion_ms : 0;
    snprintf(json, sizeof(json),
        "{\"deviceId\":\"%s\",\"room\":\"%s\",\"ts\":%lld,\"state\":\"%s\","
        "\"sensors\":{\"motion\":{\"lastActiveTs\":%lld,\"countToday\":%ld,"
        "\"supported\":%s,\"reported\":%s,\"reason\":\"%s\"},"
        "\"door\":{\"open\":%s,\"lastOpenTs\":%lld},"
        "\"climate\":{\"tempC\":%.1f,\"rh\":%.1f,\"ok\":%s,\"valid\":%s},"
        "\"gas\":{\"raw\":%d,\"ok\":%s},"
        "\"smoke\":{\"raw\":%d,\"ok\":%s}},"
        "\"history\":[%ld,%ld,%ld,%ld,%ld,%ld,%ld],"
        "\"slots\":[%d,%d,%d,%d],"
        "\"monitorOnline\":%d,\"monitorReason\":\"%s\","
        "\"alarm\":{\"id\":\"%s\",\"type\":\"%s\",\"countToday\":%ld,"
        "\"evidenceId\":\"%s\"}}",
        g_cfg.device_id, g_cfg.room, (long long)ts_ms, st_name(g_rt.state),
        last_active_ts, g_rt.motion_count_today,
        g_motion_monitor_enabled ? "true" : "false",
        (g_motion_readable_now > 0) ? "true" : "false",
        motion_reason,
        g_rt.door_open ? "true" : "false",
        (long long)(g_rt.last_door_ms > 0 ? ts_ms - (t - g_rt.last_door_ms) : 0),
        g_rt.temp_c, g_rt.rh, g_rt.climate_ok ? "true" : "false",
        g_rt.climate_valid ? "true" : "false",
        g_rt.gas_raw, g_rt.gas_ok ? "true" : "false",
        g_rt.smoke_raw, g_rt.smoke_ok ? "true" : "false",
        g_days[0], g_days[1], g_days[2], g_days[3], g_days[4], g_days[5], g_days[6],
        g_slots[0], g_slots[1], g_slots[2], g_slots[3],
        g_rt.monitor_online, mreason,
        g_rt.alarm_id, g_rt.alarm_type, g_rt.alarm_count_today, g_rt.alarm_evidence_id);
    printf("%s\n", json);            /* stdout：给桥接进程消费 */
    fflush(stdout);
    char path[256];
    snprintf(path, sizeof(path), "%s/status.json", g_cfg.dir);
    FILE *f = fopen(path, "w");
    if (f) { fprintf(f, "%s\n", json); fclose(f); }
    tcp_send(json);                  /* 同时推给 TCP 通道（hdc fport → PC 桥接） */
}

/* ---------------------------------------------------------------- 配置 */
static void cfg_default(cfg_t *c)
{
    memset(c, 0, sizeof(*c));
    c->door_gpio = c->button_gpio = c->buzzer_gpio = -1;
    c->motion_active_high = c->button_active_high = 1;
    c->i2c_addr = 0x44;
    c->no_motion_sec = 1800;      /* 30 分钟无活动 → ALARM */
    c->warn_ratio = 60;           /* 达到 60% 先 WARN */
    c->temp_high = 30.0f; c->temp_low = 10.0f;
    c->rh_high = 75.0f;   c->rh_low = 25.0f;
    c->tick_sec = 1;
    c->report_every_sec = 10;
    c->warmup_sec = 5;            /* 真机实测：悬空输入会浮高，需宽限期 + 消抖 */
    c->debounce_ticks = 3;
    c->tcp_port = 9000;           /* 配合 `hdc fport tcp:9000 tcp:9000` 供 PC 桥接读取 */
 /* 默认设备身份必须与正式部署一致（dayu200-living）；历史默认 dayu200-01 会让北向出现
 * 两个同名"客厅"节点。 */
    snprintf(c->device_id, sizeof(c->device_id), "dayu200-living");
    snprintf(c->room, sizeof(c->room), "客厅");
    c->adc_dev = 0;               /* fe720000.saradc */
    c->gas_adc_ch = -1;           /* 未接传感器时置 -1，避免悬空值误报 */
    c->smoke_adc_ch = -1;
    c->gas_alarm_raw = 800;       /* 待接上 MQ-2 后按洁净空气基线校准 */
    c->smoke_alarm_raw = 800;
    snprintf(c->dir, sizeof(c->dir), "/data/homemon");
    snprintf(c->gpio_root, sizeof(c->gpio_root), "/sys/class/gpio");
}

static void cfg_load(cfg_t *c, const char *path)
{
    FILE *f = fopen(path, "r");
    if (!f) { logmsg("配置文件 %s 不存在，使用默认值", path); return; }
    char line[256];
    while (fgets(line, sizeof(line), f)) {
        char k[64], v[160];
        if (line[0] == '#' || line[0] == '\n') continue;
        if (sscanf(line, "%63[^=]=%159s", k, v) != 2) continue;
        if (!strcmp(k, "motion_gpio")) {           /* 逗号分隔的多个编号；-1=禁用 */
            char *p = strtok(v, ",;");
            while (p && c->motion_cnt < 4) {
                int pin = atoi(p);
 /* motion_gpio=-1 是“本路禁用”（与 ESP32 节点约定一致），
                   不能当成“第 -1 号引脚”去 export，更不能用它参与能力判定。 */
                if (pin >= 0) c->motion_gpio[c->motion_cnt++] = pin;
                p = strtok(NULL, ",;");
            }
        }
        else if (!strcmp(k, "door_gpio"))    c->door_gpio = atoi(v);
        else if (!strcmp(k, "button_gpio"))  c->button_gpio = atoi(v);
        else if (!strcmp(k, "buzzer_gpio"))  c->buzzer_gpio = atoi(v);
        else if (!strcmp(k, "i2c_dev"))      snprintf(c->i2c_dev, sizeof(c->i2c_dev), "%s", v);
        else if (!strcmp(k, "i2c_addr"))     c->i2c_addr = (int)strtol(v, NULL, 0);
        else if (!strcmp(k, "led_red"))      snprintf(c->led_red, sizeof(c->led_red), "%s", v);
        else if (!strcmp(k, "led_green"))    snprintf(c->led_green, sizeof(c->led_green), "%s", v);
        else if (!strcmp(k, "led_blue"))     snprintf(c->led_blue, sizeof(c->led_blue), "%s", v);
        else if (!strcmp(k, "say_cmd"))      snprintf(c->say_cmd, sizeof(c->say_cmd), "%s", v);
        else if (!strcmp(k, "no_motion_sec")) c->no_motion_sec = atoi(v);
        else if (!strcmp(k, "warn_ratio"))   c->warn_ratio = atoi(v);
        else if (!strcmp(k, "temp_high"))    c->temp_high = (float)atof(v);
        else if (!strcmp(k, "temp_low"))     c->temp_low = (float)atof(v);
        else if (!strcmp(k, "rh_high"))      c->rh_high = (float)atof(v);
        else if (!strcmp(k, "rh_low"))       c->rh_low = (float)atof(v);
        else if (!strcmp(k, "tick_sec"))     c->tick_sec = atoi(v);
        else if (!strcmp(k, "report_every_sec")) c->report_every_sec = atoi(v);
        else if (!strcmp(k, "warmup_sec"))   c->warmup_sec = atoi(v);
        else if (!strcmp(k, "debounce_ticks")) c->debounce_ticks = atoi(v);
        else if (!strcmp(k, "tcp_port"))     c->tcp_port = atoi(v);
        else if (!strcmp(k, "device_id"))    snprintf(c->device_id, sizeof(c->device_id), "%s", v);
        else if (!strcmp(k, "room"))         snprintf(c->room, sizeof(c->room), "%s", v);
        else if (!strcmp(k, "adc_dev"))      c->adc_dev = atoi(v);
        else if (!strcmp(k, "gas_adc_ch"))   c->gas_adc_ch = atoi(v);
        else if (!strcmp(k, "smoke_adc_ch")) c->smoke_adc_ch = atoi(v);
        else if (!strcmp(k, "gas_alarm_raw")) c->gas_alarm_raw = atoi(v);
        else if (!strcmp(k, "smoke_alarm_raw")) c->smoke_alarm_raw = atoi(v);
        else if (!strcmp(k, "dir"))          snprintf(c->dir, sizeof(c->dir), "%s", v);
        else if (!strcmp(k, "gpio_root"))    snprintf(c->gpio_root, sizeof(c->gpio_root), "%s", v);
    }
    fclose(f);
}

/* ---------------------------------------------------------------- 自检 */
/* homemon --selftest：纯逻辑自检，不碰 GPIO/TCP，可在板端(ARM32)与 PC 上运行。
   覆盖：64 位秒->毫秒、2017 判为不可信、2026 判为可信、秒/毫秒不混淆、UTC 不重复 +8 小时。 */
static int time_selftest(void)
{
    int pass = 0, fail = 0;
#define T_CHECK(cond, name) do { \
        if (cond) { pass++; printf("  ok   %s\n", (name)); } \
        else { fail++; printf("  FAIL %s\n", (name)); } \
    } while (0)

    printf("homemon --selftest: sizeof(long)=%u sizeof(int64_t)=%u\n",
           (unsigned)sizeof(long), (unsigned)sizeof(int64_t));
    T_CHECK(sizeof(int64_t) == 8, "int64_t is 8 bytes");
    T_CHECK(tu_sec_to_ms(1792060628LL) == 1792060628000LL, "sec->ms 2026 (no 32-bit overflow)");
    T_CHECK(tu_sec_to_ms(4102444800LL) == 4102444800000LL, "sec->ms 2100 boundary");
    T_CHECK(!tu_epoch_ms_trusted(1501844580000LL), "2017 ms is untrusted");
    T_CHECK(!tu_epoch_ms_trusted(tu_normalize_epoch_ms(1501844580LL)), "2017 seconds are untrusted too");
    T_CHECK(tu_epoch_ms_trusted(1792060628021LL), "2026 ms is trusted");
    T_CHECK(tu_normalize_epoch_ms(1792060628LL) == 1792060628000LL, "seconds normalized to ms");
    T_CHECK(tu_normalize_epoch_ms(1792060628021LL) == 1792060628021LL, "ms kept as ms");
    T_CHECK(!tu_epoch_ms_trusted(0), "epoch 0 is untrusted");
    {
        int64_t y;
        int mo, d, h, mi, s;
        char buf[96];
        tu_ms_to_utc(1792060628021LL, &y, &mo, &d, &h, &mi, &s);
        snprintf(buf, sizeof(buf), "UTC is %04lld-%02d-%02dT%02d:%02d:%02dZ (no +8h)",
                 (long long)y, mo, d, h, mi, s);
        T_CHECK(y == 2026 && mo == 10 && d == 15 && h == 10 && mi == 37 && s == 8, buf);
        T_CHECK(h != 18, "hour is not shifted by +08:00");
    }
    printf("homemon --selftest: PASS=%d FAIL=%d\n", pass, fail);
#undef T_CHECK
    return fail == 0 ? 0 : 1;
}

/* ------------------------------------------------------------------ 主 */
int main(int argc, char **argv)
{
    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--selftest")) return time_selftest();
    }
    cfg_default(&g_cfg);
    cfg_load(&g_cfg, argc > 1 ? argv[1] : "/data/homemon/homemon.conf");

    mkdir(g_cfg.dir, 0755);
    if (argc > 2 && !strcmp(argv[2], "--print-config")) {
        printf("motion_cnt=%d door=%d button=%d buzzer=%d i2c=%s@0x%02X\n",
               g_cfg.motion_cnt, g_cfg.door_gpio, g_cfg.button_gpio,
               g_cfg.buzzer_gpio, g_cfg.i2c_dev, g_cfg.i2c_addr);
        printf("leds=%s,%s,%s no_motion_sec=%d say_cmd=%s\n",
               g_cfg.led_red, g_cfg.led_green, g_cfg.led_blue,
               g_cfg.no_motion_sec, g_cfg.say_cmd);
        printf("gpio_root=%s\n", g_cfg.gpio_root);
        return 0;
    }

 /* 初始化 GPIO 方向；同时确认 PIR 是否真的可用（能力判定，见 motion_gate.h） */
    g_motion_configured_cnt = 0;
    g_motion_usable_cnt = 0;
    for (int i = 0; i < g_cfg.motion_cnt; i++) {
        if (g_cfg.motion_gpio[i] < 0) continue;       /* 防御：-1 已在 cfg_load 过滤 */
        g_motion_configured_cnt++;
        gpio_prepare(g_cfg.motion_gpio[i], "in");
 /* 能读到值才算“这一路 PIR 可用”；导出失败/无权限/引脚不存在都不算。 */
        if (gpio_read_pin(g_cfg.motion_gpio[i]) >= 0) g_motion_usable_cnt++;
    }
    g_motion_monitor_enabled =
        mg_monitor_enabled(g_motion_configured_cnt, g_motion_usable_cnt);
    if (g_cfg.door_gpio   >= 0) gpio_prepare(g_cfg.door_gpio, "in");
    if (g_cfg.button_gpio >= 0) gpio_prepare(g_cfg.button_gpio, "in");
    if (g_cfg.buzzer_gpio >= 0) gpio_prepare(g_cfg.buzzer_gpio, "out");

    g_rt.state = ST_NORMAL;
 /* last_motion 只在“真的有活动监测能力”时用启动时刻喂一次初值，
       给 1800s 宽限；无 PIR（客厅）时保持 0 = 从未活动，
       不能让“启动时刻”被当成“最近一次活动”。 */
    g_rt.last_motion_ms = g_motion_monitor_enabled ? wall_ms() : 0;
    g_rt.climate_ok = 1;
    g_rt.climate_valid = 0;      /* 首帧尚未读到本次有效温湿度 */
    g_rt.gas_ok = 1;
    g_rt.smoke_ok = 1;
    g_rt.temp_c = 0; g_rt.rh = 0;
    g_rt.door_open = 0;
 /* 监护链路状态未知：只有 PC 侧 watchdog 明确上报后才置 0/1，
       避免开机就谎称"监护在线"。 */
    g_rt.monitor_online = -1;
    snprintf(g_rt.monitor_reason, sizeof(g_rt.monitor_reason), "%s", "unknown");

    logmsg("homemon 启动（tick=%ds, 无活动阈值=%ds, 目录=%s）",
           g_cfg.tick_sec, g_cfg.no_motion_sec, g_cfg.dir);
    logmsg("活动监测能力：配置 %d 路 PIR，启动自检可读 %d 路 → NO_MOTION=%s%s",
           g_motion_configured_cnt, g_motion_usable_cnt,
           g_motion_monitor_enabled ? "启用" : "关闭",
           g_motion_monitor_enabled ? "" : "（无有效 PIR：不产生 NO_MOTION，也不因活动间隔进 WARN）");
 /* 开机第一件事就说清时间可信性：RTC 掉电后 ts 会退到 2017，
       必须留痕，不能让"13 位毫秒"被误当成正确时间。 */
    if (wall_time_trusted()) log_utc((int64_t)wall_ms(), "启动时系统时间可信：");
    else log_utc((int64_t)wall_ms(), "⚠ 启动时系统时间不可信（板端 RTC 掉电回退，等待 PC 网关校时）：");
    tcp_start();
    hist_load();
    hist_roll((long)time(NULL) / 86400);
    report_status(1);

    int debounce = g_cfg.debounce_ticks > 0 ? g_cfg.debounce_ticks : 1;
    int motion_prev[4] = {0, 0, 0, 0};
    int tick = 0;
    int tick_sec = g_cfg.tick_sec > 0 ? g_cfg.tick_sec : 1;
    ms_t tick_ms = (ms_t)tick_sec * 1000;
    g_prev_tick_ms = wall_ms();
    for (;;) {
        tick++;
        ms_t t = wall_ms();      /* 64 位，避免 ARM32 溢出 */

 /* --- 时钟跳变检测（RTC 掉电回退到 2017 / PC 网关校时 / 手动 date -s）---
 * 墙钟整体跳变时，若不动历史时间戳，idle 会瞬间变成“9 年无活动”-> 假 NO_MOTION。
 * 这里把历史时间戳按同一 delta 平移，保持“已经过去多久”的语义。 */
        ms_t delta = t - g_prev_tick_ms;
        int clock_jumped = 0;
        if (mg_clock_jumped(delta, tick_ms)) {
            clock_jumped = 1;
            g_rt.last_motion_ms = mg_resync_ms(g_rt.last_motion_ms, delta);
            g_rt.last_door_ms   = mg_resync_ms(g_rt.last_door_ms, delta);
            g_rt.alarm_start_ms = mg_resync_ms(g_rt.alarm_start_ms, delta);
            log_utc((int64_t)t, "检测到系统时钟跳变，已平移历史时间戳（不据此判定无活动）：");
        }
        g_prev_tick_ms = t;

 /* 启动宽限期：真机实测悬空输入会浮高，必须先忽略一段时间再判定 */
        if (g_cfg.warmup_sec > 0 && tick <= g_cfg.warmup_sec / tick_sec) {
            state_tick(tick);
            report_status(0);
            sleep(tick_sec);
            continue;
        }

 /* --- 采集 --- */
        int motion = 0;
        int motion_events = 0;
        int motion_readable = 0;              /* 本 tick 成功读到的 PIR 路数 */
        for (int i = 0; i < g_cfg.motion_cnt; i++) {
            int v = gpio_read_pin(g_cfg.motion_gpio[i]);
            if (v < 0) continue;
            motion_readable++;
            int active = (g_cfg.motion_active_high && v == 1) ||
                         (!g_cfg.motion_active_high && v == 0);
            if (active) motion = 1;
            if (active && !motion_prev[i]) motion_events++;
            motion_prev[i] = active;
        }
        g_motion_readable_now = motion_readable;
        if (motion) {
            g_rt.last_motion_ms = t;
            if (g_rt.state == ST_WARN) { g_rt.state = ST_NORMAL; logmsg("活动恢复 -> NORMAL"); }
        }
 /* 无有效 PIR 数据的 tick：暂停 idle 计时（盲区不计入“无活动时长”），
           恢复后不会因为“刚才没数据”而立刻告警。无 PIR 设备不做任何判定。 */
        if (g_motion_monitor_enabled && motion_readable == 0 && !clock_jumped) {
            g_rt.last_motion_ms = mg_pause_idle_ms(g_rt.last_motion_ms, delta);
            if (g_motion_read_fail_ticks == 0) {
                logmsg("⚠ PIR 本次读取无有效数据：暂停活动判定（无数据不判定“无活动”）");
            }
            g_motion_read_fail_ticks++;
        } else if (g_motion_monitor_enabled && motion_readable > 0 &&
                   g_motion_read_fail_ticks > 0) {
            logmsg("PIR 读数恢复：继续活动判定（此前 %d 个 tick 的盲区未计入无活动时长）",
                   g_motion_read_fail_ticks);
            g_motion_read_fail_ticks = 0;
        }
        for (int i = 0; i < motion_events; i++) {
            hist_bump((long)time(NULL));            /* 每路传感器的激活沿只计一次 */
        }
        if (motion_events > 0) g_rt.motion_count_today = g_days[6];

        if (g_cfg.door_gpio >= 0) {
            int v = gpio_read_pin(g_cfg.door_gpio);
            if (v >= 0) {
                int open_raw = (g_cfg.motion_active_high && v == 1) || (!g_cfg.motion_active_high && v == 0);
                if (open_raw == g_door_last) g_door_cnt++;
                else { g_door_last = open_raw; g_door_cnt = 1; }
                if (g_door_cnt >= debounce) {                 /* 消抖：连续 N 次一致才认账 */
                    if (open_raw && !g_rt.door_open) g_rt.last_door_ms = t;
                    g_rt.door_open = open_raw;
                }
            }
        }

        int sos = 0;
        if (g_cfg.button_gpio >= 0) {
            int v = gpio_read_pin(g_cfg.button_gpio);
            int active = (v >= 0) && ((g_cfg.button_active_high && v == 1) ||
                                      (!g_cfg.button_active_high && v == 0));
            if (active) g_sos_cnt++;
            else g_sos_cnt = 0;
            sos = (g_sos_cnt >= debounce);                    /* 避免瞬时抖动误报求助 */
        }

        float tc, rh;
        int read_ok = sht30_read(&tc, &rh);
        climate_sample_t climate = { g_rt.temp_c, g_rt.rh, g_rt.climate_valid };
        climate_apply_sample(&climate, read_ok, tc, rh);
        g_rt.temp_c = climate.temp_c;
        g_rt.rh = climate.rh;
        g_rt.climate_valid = climate.valid;
        if (climate.valid) {
 /* ok 仍只表达阈值/舒适区，不表达读取成功；保留既有语义。 */
            g_rt.climate_ok = (climate.temp_c >= g_cfg.temp_low &&
                               climate.temp_c <= g_cfg.temp_high &&
                               climate.rh >= g_cfg.rh_low &&
                               climate.rh <= g_cfg.rh_high);
        }

        int av = 0;                                   /* 燃气 / 烟雾（SARADC） */
        if (adc_read_raw(g_cfg.adc_dev, g_cfg.gas_adc_ch, &av) == 0) {
            g_rt.gas_raw = av;
            g_rt.gas_ok = (av < g_cfg.gas_alarm_raw);
        }
        if (adc_read_raw(g_cfg.adc_dev, g_cfg.smoke_adc_ch, &av) == 0) {
            g_rt.smoke_raw = av;
            g_rt.smoke_ok = (av < g_cfg.smoke_alarm_raw);
        }

 /* --- 判定（基础阈值算法；纯逻辑在 judge_logic.h，优先级与门控可单测） --- */
        int judge_allowed = mg_judge_allowed(g_motion_monitor_enabled, motion_readable);
        ms_t idle = 0;
        if (g_rt.last_motion_ms > 0) idle = t - g_rt.last_motion_ms;
        ms_t limit = (ms_t)g_cfg.no_motion_sec * 1000;
        ms_t warn_at = limit * g_cfg.warn_ratio / 100;

        jg_input_t jin;
        memset(&jin, 0, sizeof(jin));
        jin.gas_ok = g_rt.gas_ok;
        jin.smoke_ok = g_rt.smoke_ok;
        jin.sos_pressed = sos;
        jin.motion_judge_allowed = judge_allowed;
        jin.idle_ms = idle;
        jin.no_motion_limit_ms = limit;
        jin.warn_at_ms = warn_at;
        jin.climate_ok = g_rt.climate_ok;
        jin.state_is_alarm = (g_rt.state == ST_ALARM);
        jin.state_is_normal = (g_rt.state == ST_NORMAL);
        jin.alarm_type = g_rt.alarm_type;

        switch (judge_decide(&jin)) {
        case JG_RAISE_GAS:                           /* 燃气优先级最高 */
            alarm_raise("GAS", "检测到燃气泄漏，请立即开窗通风并撤离");
            break;
        case JG_RAISE_SMOKE:
            alarm_raise("SMOKE", "检测到烟雾，疑似火情");
            break;
        case JG_RAISE_SOS:
 /* 播报已在 alarm_raise() 内统一触发，此处不再重复 */
            alarm_raise("MANUAL_SOS", "老人主动按下随身求助按钮");
            break;
        case JG_RAISE_NO_MOTION:
            alarm_raise("NO_MOTION", "长时间未检测到人体活动");
            break;
        case JG_CLIMATE_WARN:
            g_rt.state = ST_WARN;
            logmsg("温湿度越界 -> WARN");
            break;
        case JG_IDLE_WARN:
            g_rt.state = ST_WARN;
            logmsg("活动间隔达阈值 %d%% -> WARN", g_cfg.warn_ratio);
            break;
        case JG_NONE:
        default:
            break;
        }

 /* --- 执行 + 上报 + 闭环 --- */
        state_tick(tick);
        poll_control();
        tcp_pump();
        hist_roll((long)time(NULL) / 86400);     /* 跨天滚动日统计 */
        if (g_hist_dirty) { hist_save(); g_hist_dirty = 0; }
        report_status(0);
        sleep(g_cfg.tick_sec);
    }
    return 0;
}
