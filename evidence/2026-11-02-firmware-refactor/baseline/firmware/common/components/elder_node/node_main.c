/**
 * 独居老人居家安全监护系统 · ESP32-S3 无线传感节点
 * ============================================================================
 * 赛题依据：创新拓展「可扩展多节点」——用无线节点把监测覆盖到多个房间，
 *           免去房间之间拉线（对应赛题原文"星闪自组网"的同一叙事）。
 *
 * 设计要点：
 *   1. 节点**不实现 MQTT**，而是把与主控 homemon **完全相同的 JSON 行协议**
 *      通过 TCP 推给 PC 上的网关（mqtt_bridge.js --listen）。
 *      → 桥接与 APP **零改动**即可自动发现并展示本节点；
 *      → 固件不依赖任何第三方组件，只用 ESP-IDF 自带能力。
 *   2. 按节点配置采集 PIR/门磁、AHT20、MQ-2/MQ-5；执行：蜂鸣器（GPIO）。
 *   3. 判定：长时间无活动、燃气、烟雾或温湿度越界 → 本地声报警 + 状态转 ALARM。
 *   4. 协议报文与 homemon 逐字段一致（见 competition/README.md §3.1）。
 *
 * 配置：idf.py menuconfig → "居家安全监护 · ESP32-S3 无线节点"
 * ============================================================================
 */
#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>  
#include <sys/socket.h>
#include <netdb.h>
#include <arpa/inet.h>
#include <time.h>
#include <math.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/event_groups.h"
#include "freertos/queue.h"
#include "esp_wifi.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_sntp.h"
#include "nvs_flash.h"
#include "nvs.h"
#include "driver/gpio.h"
#include "driver/i2c.h"
#include "esp_timer.h"
#include "esp_rom_sys.h"
#include "esp_random.h"
#include "esp_adc/adc_oneshot.h"
#if CONFIG_NODE_ALARM_BENCH_INJECT || defined(CONFIG_NODE_VOICE_ENABLED) // 台架/现场都需要 UART0 逐行命令
#include "driver/uart.h"
#endif
#if CONFIG_NODE_ALARM_BENCH_INJECT
#include "esp_system.h"
#endif
#include "alarm_logic.h"   /* 与硬件无关的判定逻辑（主机侧可测） */
#include "notice_logic.h"  /* 跨房间定向播报的判定逻辑（主机侧可测） */
#include "battery_logic.h" /* 电池电压换算/有效性/百分比（主机侧可测，契约 §1.3/§2） */

/* Kconfig bool 在 "=n" 时**不会**生成宏（只有 =y 才定义 CONFIG_xxx），
 * 因此不能把 CONFIG_NODE_BATTERY_CALIBRATED 当 0 用；这里统一折叠成本地 0/1 宏。 */
#ifdef CONFIG_NODE_BATTERY_CALIBRATED // 仅在编译时启用电池采样才定义
#define NODE_BATTERY_CALIBRATED 1 // 编译期已启用电池采样
#else
#define NODE_BATTERY_CALIBRATED 0 // 编译期未启用电池采样
#endif

#include "local_voice.h" // 本地语音播报（I2S+ES8388，含 sos/温湿度异常/无人活动提示）
#include "speaker_link.h" // AI 语音网关直连播报（网络音箱）
#include "mic_link.h"    // 板载咪头 PCM 上传（9303，仅告警/命令窗口）
#include "local_led.h"   // 本地告警灯（GPIO，单色，低/高电平可选）
#include "voice_pins.h"  // 语音播报占用的物理 GPIO（编译期冲突检查）

#define WIFI_CONNECTED_BIT BIT0 // Wi-Fi 连接成功标志位
#define TAG "elder-node" // 日志 TAG

#if CONFIG_NODE_ALARM_BENCH_INJECT && !CONFIG_NODE_VOICE_ENABLED  // 仅 bench 注入编译时才需要 uart.h，否则编译报错
#error "NODE_ALARM_BENCH_INJECT 依赖语音构建的命令队列（CONFIG_NODE_VOICE_ENABLED=y）"  
#endif

/* ---------------- 上报 JSON 缓冲区（含 battery 段后的实测余量） ----------------
 * 契约 §2 的 battery 对象最长约 140 字节（reason 短码 <=16）。
 * report_message_t 与 report() 的栈缓冲必须使用同一个上限，否则长报文会在
 * gw_send 的 snprintf 处被静默截断成非法 JSON。 */
#define REPORT_JSON_MAX 1600

/* ---------------- 电池采样编译期约束（契约 §1.2：只能用 ADC1、不得复用 MQ 通道） ----------------
 * Kconfig 的 range 可以被 sdkconfig 直接改写，因此这里再做一次硬校验：宁可编译失败，
 * 也不允许 ADC2/复用通道/倒置的有效范围偷偷上板。 */
#if CONFIG_NODE_BATTERY_ADC_CHANNEL > 9 // ADC1_CH0..CH9 = GPIO36..GPIO39, GPIO32..GPIO35, GPIO4, GPIO0, GPIO2, GPIO15
#error "NODE_BATTERY_ADC_CHANNEL 只允许 ADC1_CH0..CH9（-1=未接电池采样）"
#endif
#if CONFIG_NODE_BATTERY_ADC_CHANNEL >= 0 && \
    (CONFIG_NODE_BATTERY_ADC_CHANNEL == CONFIG_NODE_MQ2_ADC_CHANNEL || \
     CONFIG_NODE_BATTERY_ADC_CHANNEL == CONFIG_NODE_MQ5_ADC_CHANNEL)
#error "NODE_BATTERY_ADC_CHANNEL 不得与 NODE_MQ2_ADC_CHANNEL / NODE_MQ5_ADC_CHANNEL 复用同一 ADC1 通道"
#endif
#if CONFIG_NODE_BATTERY_ADC_CHANNEL >= 0 && CONFIG_NODE_BATTERY_MIN_MV > CONFIG_NODE_BATTERY_MAX_MV
#error "NODE_BATTERY_MIN_MV 必须 <= NODE_BATTERY_MAX_MV"
#endif

/* ---------------- 运行时状态 ---------------- */
static EventGroupHandle_t s_wifi_events;
static int   s_sock = -1;                       /* 到网关的 TCP 连接 */
static char  s_rx[1024];
static size_t s_rxlen = 0;
/* SOS 三阶段可见性（不做任何“假成功”判断）：
 *   ① 正在发送：求助已在本地触发，声/光反馈已给出；
 *   ② 已送达 Bridge：一条包含本次 alarmId 的状态报文经 TCP 完整写出（≠ 云端入库）；
 *   ③ 监护人已确认：只有收到 `ack <alarmId>` 且 ID 精确匹配才算（handle_command）。
 * 平台 202 / APP 确认证据在 PC 与云侧核对，设备不再播放“已受理/已处理”。 */
static volatile uint32_t s_gw_sent_count = 0;   /* gateway_task 完整发出报文的次数 */
static uint32_t s_sos_mark = 0;                 /* 本次求助触发时的发送计数基线 */
static int64_t  s_sos_pending_since = 0;        /* 本次求助进入“正在发送”的时刻 */
static int      s_sos_delivery_logged = 0;      /* 是否已记录“已送达 Bridge” */
static int      s_sos_wait_warned = 0;          /* 是否已记录“尚未送达”一次性警告 */
static unsigned s_boot_salt = 0;                /* 上电随机盐：时钟未同步时保证 alarmId 跨重启唯一 */
#if CONFIG_NODE_VOICE_ENABLED
/* Only the main task owns sensor/alarm state; only gateway_task owns sockets.
 * Mailboxes are bounded. This is latest status delivery, NOT a durable event log.
 * Offline local SOS/sensing must never wait for DNS/connect/send. */
typedef struct { char text[REPORT_JSON_MAX]; } report_message_t;
typedef struct { char text[1024]; } command_message_t;
static QueueHandle_t s_reports, s_commands;
#endif

/* ⚠ 毫秒时间戳用 64 位：ESP32-S3 上 long 为 32 位，tv_sec*1000 会溢出导致定时错乱 */
static int64_t s_last_motion_ms = 0;            /* 最近一次人体活动（本地毫秒） */
static int   s_motion_count   = 0;              /* 今日活动次数 */
static int   s_door_open      = 0;   /* 已确认门磁状态；基线建立前为未知（上报整段不发） */
static int64_t s_door_last_open_ts  = 0;  /* 最近一次开门事件时间（未同步/无记录为 0） */
static int64_t s_door_last_close_ts = 0;  /* 最近一次关门事件时间（未同步/无记录为 0） */


#if CONFIG_NODE_DOOR_GPIO >= 0
static door_debounce_t s_door_db;
/* 未确认送达的开关事件 FIFO（环形）：seq 单调递增（NVS 持久化，重启不复用），
 * 后端按 (deviceId, seq) 幂等去重，重复上传/重启重传不会重复记账。
 * 注：厨房 report() 只发旧合同两键 door.open/door.lastOpenTs；本 FIFO 仅本地补传/诊断，
 * 不下发扩展字段（v7 未发布，避免改变后端合同）。 */
typedef struct {
    int      seq;            /* 事件序号 */
    int      open;           /* 1=开门 0=关门 */
    int64_t  ts;             /* 事件发生时刻（本地毫秒）；时钟未同步为 0 */
    int64_t  enqueued_ms;    /* 入队时刻（本地毫秒），用于 KEEP_SEC 过期清理 */
} door_event_t; // 环形 FIFO 元素
static door_event_t s_door_events[CONFIG_NODE_DOOR_CACHE_MAX]; // 环形 FIFO
static int  s_door_event_count = 0;   /* 环形 FIFO 中的事件数量 */
static int  s_door_event_head  = 0;   /* 环形 FIFO 头（最旧） */
static int  s_door_seq         = 0;   /* 事件序号（NVS 持久化） */
static int  s_door_baseline_unknown = 1;  /* 基线未建立：当前状态为未知 */
#endif


static int   s_state          = 0;              /* 0=NORMAL 1=WARN 2=ALARM 3=ACKED */
/* ACKED 后"已确认的那种危险"是否曾经消失并重新武装：
 * 只有重新武装过，同类型危险再次出现时才允许产生新告警。
 * 目的是避免"ACK 一次 = 永久屏蔽该房间真实危险"。 */
static int   s_acked_armed    = 0;
static int   s_alarm_seq      = 0;
/* 短提示音 → 完整语音的编排状态（2026-10-26 LOCAL-ALARM-SPEECH-FINAL）
 * 旧行为：告警时 buzzer(1) 连续响 CONFIG_NODE_ALARM_BEEP_SEC(10) 秒，同时立刻播放语音，
 * 3 秒左右的人声被 10 秒连续蜂鸣完全遮盖（用户实测“只听到滴滴几声”）。而且 sos.pcm
 * 本身是正弦提示音而非人声。现在：先响 N 声短提示音，蜂鸣停止后再播完整中文语音，
 * 二者不重叠；stop/ACK/异常解除会立即取消提示音与语音。 */
static int     s_chirp_left = 0;        /* 还需要响几声 */
static int     s_chirp_on = 0;          /* 当前处于“响”段 */
static int64_t s_chirp_next_ms = 0;     /* 下一次翻转时刻 */
static int     s_voice_pending = 0;     /* 提示音结束后要播报的片段 */
static int64_t s_voice_due_ms = 0;      /* 语音最早开始时刻 */
static char  s_alarm_id[40]   = "";

/* 供 mic_link.c 上报当前活动告警 ID；无告警时返回空串。 */
const char *node_current_alarm_id(void) { return s_alarm_id; }
static char  s_alarm_type[24] = "";
/* 跨房间定向播报（2026-10-26 WIRELESS-SOS-NOTICE）
 * 其他设备的求助事件由 PC 侧 bridge 用受控路由**逐台**投递到本板；本板只“播报同一事件”，
 * 绝不生成本地告警、不新建告警 ID、不改 s_state/s_alarm_id/s_alarm_type，也不 report()，
 * 因此 APP 上仍然只有原始来源的那一条告警，本板不会伪造 MANUAL_SOS。
 * 判定逻辑全部在 notice_logic.h（主机侧 host_notice_logic_test.c 已单测），
 * 这里只保留状态与 I/O 翻译。 */
static notice_state_t s_notice;
/* 本地告警闭环状态（2026-10-26 LOCAL-ALARM-VOICE-CLOSURE）：
 *  - s_user_stopped：用户明确“停止本轮声音”。保留 ALARM 状态/告警 ID，
 *    但不再重复提醒；同一持续事件的下一条重复数据不得立即重新拉响。
 *  - s_last_remind_ms：限频提醒基准（持续异常期间最多每 NODE_ALARM_REPEAT_SEC 一次）。
 *  - s_pir_armed：本次启动后是否确认过至少一次有效 PIR 活动（防止断线常低误报无活动）。
 *  - s_monitor_paused：用户暂停监护。只抑制“长时间无活动”提醒，不抑制 SOS/环境告警；
 *    状态写入 NVS，重启后保持，不自动反向恢复。 */
static int   s_user_stopped    = 0;
static int64_t s_last_remind_ms = 0;
static int   s_pir_armed       = 0;
static int   s_monitor_paused  = 0;
static climate_stab_t s_climate_stab;   /* 温湿度连续确认+回差（纯逻辑在 alarm_logic.h） */
#if CONFIG_NODE_ALARM_BENCH_INJECT
/* 台架注入（仅 CONFIG_NODE_ALARM_BENCH_INJECT=y 编译；正常现场固件不存在这些状态） */
static int   s_inj_climate       = 0;   /* 1=温湿度使用注入值 */
static int   s_inj_climate_valid = 1;   /* 0=注入“无效读数” */
static float s_inj_temp          = 0.0f;
static float s_inj_rh            = 0.0f;
static int   s_inj_pir           = -1;  /* -1=真实 PIR；0/1=注入电平 */
static int   s_inj_door          = -1;  /* -1=真实门磁；0/1=注入电平 */
#endif
static int   s_time_synced    = 0;
static float s_temp_c         = 0.0f;
static float s_rh             = 0.0f;
static int   s_climate_valid  = 0;
static int   s_climate_ok     = 1;
static int   s_mq2_raw        = 0;              /* MQ-2 -> smoke */
static int   s_mq5_raw        = 0;              /* MQ-5 -> gas */
/* 这两个标志必须无条件声明：report() 的 JSON valid 字段无条件引用它们，
 * 而 MQ 通道在卫生间/未来节点可能是 -1（编译期禁用）。 */
static int   s_mq2_valid      = 0;
static int   s_mq5_valid      = 0;
static int   s_smoke_ok       = 1;
static int   s_gas_ok         = 1;
#if CONFIG_NODE_MQ2_ADC_CHANNEL >= 0
static mq_stab_t s_mq2_stab;          /* MQ-2 连续确认/回差状态（独立计数） */
#endif
#if CONFIG_NODE_MOTION_GPIO >= 0
static pir_debounce_t s_pir_db;              /* PIR 消抖/连续确认（纯逻辑在 alarm_logic.h） */
#endif
#if CONFIG_NODE_SOS_GPIO >= 0 || CONFIG_NODE_SOS_KEY0_ENABLED
static sos_button_t s_sos_btn;               /* SOS 按键消抖（GPIO 入口与板载 KEY0 共用） */
#endif
#if CONFIG_NODE_WATER_GPIO >= 0
static water_stab_t s_water_stab;            /* 水漏连续确认/重新武装 */
static int s_water_valid = 1;                /* 数字量读数有效 */
static int s_water_ok = 1;                   /* 1=无漏水 */
#endif
#if CONFIG_NODE_MQ5_ADC_CHANNEL >= 0
static mq_stab_t s_mq5_stab;          /* MQ-5 连续确认/回差状态（独立计数） */
#endif
#if CONFIG_NODE_BATTERY_ADC_CHANNEL >= 0
/* 电池采样状态（契约 §2）。固定供电节点（CHANNEL=-1）不编译这些状态，
 * report() 也因此完全不输出 battery 字段 —— 绝不给“无电池设备”编造电量。 */
static battery_config_t s_batt_cfg;                    /* Kconfig 换算/校准参数 */
static battery_result_t s_batt;                        /* 最近一次判定结果 */
static int  s_batt_tick = 0;                           /* 采样节拍（sample() 每秒一次） */
static int  s_batt_sample_count = 0;                   /* 已完成的采样窗数量（日志节流） */
#endif
#if CONFIG_NODE_MQ2_ADC_CHANNEL >= 0 || CONFIG_NODE_MQ5_ADC_CHANNEL >= 0 || CONFIG_NODE_BATTERY_ADC_CHANNEL >= 0
static adc_oneshot_unit_handle_t s_adc = NULL;
#endif

#define AHT20_ADDR 0x38
/* 两条独立 I2C 总线（2026-10-20 修正）：
 *  - 板载 IIC0 固定接 IO41/IO42，只挂板载器件（XL9555@0x20 / AP3216C / 触摸 / ES8388），
 *    这些引脚**不对排针引出**，不能外接 AHT20；
 *  - 外部 AHT20 走 I2C1，SDA/SCL 取 Kconfig 指定的 P1 排针 IO4/IO5。 */
#define I2C_XL_PORT   I2C_NUM_0
#define I2C_AHT_PORT  I2C_NUM_1
#define XL9555_SDA_GPIO 41
#define XL9555_SCL_GPIO 42
#define I2C_PORT I2C_AHT_PORT

/* ---- 蜂鸣器两种接法，Kconfig 二选一（下方实现用 #if / #elif 互斥）----
 * 1) CONFIG_NODE_BUZZER_XL9555=y：正点原子 DNESP32S3 **板载**蜂鸣器，
 *    不在 GPIO 上，由 I2C IO 扩展芯片 XL9555(0x20) 的 P0_3 控制
 *    （官方 BSP：14_adc/components/BSP/XL9555/xl9555.h -> BEEP_IO = 0x0008）。
 *    此模式下 CONFIG_NODE_BUZZER_GPIO 必须为 -1。
 * 2) CONFIG_NODE_BUZZER_GPIO >= 0：**外接**有源蜂鸣器模块，GPIO 高电平鸣响。
 *    厨房节点采用这一种：模块 IN -> GPIO6。
 *
 * ⚠ 电气冲突提醒（DNESP32S3 板载 P2 摄像头排线）：
 *    GPIO4/5/6 同时是 OV2640/OV5640 的 OV_D0/OV_D1/OV_D2。
 *    厨房节点用 GPIO6 驱动蜂鸣器时，**不得同时插入该摄像头模组**，
 *    否则蜂鸣器输出与摄像头数据线会两端同时驱动，产生电气争用。
 *    （本项目视觉入口使用 DAYU200 的 MIPI-CSI2，ESP32 节点不插该模组。） */
#define XL9555_ADDR              0x20
#define XL9555_OUTPUT_PORT0_REG  2
#define XL9555_CONFIG_PORT0_REG  6
#define XL9555_CONFIG_PORT1_REG  7
#define XL9555_INPUT_PORTS_REG   0   /* 连续读：P0 后紧跟 P1 */
#define XL9555_BEEP_P0_BIT       0x08

#if CONFIG_NODE_BUZZER_XL9555 || CONFIG_NODE_SOS_KEY0_ENABLED
/* 板载 IO 扩展器 XL9555(0x20)：蜂鸣器 P0_3 为输出、KEY0 为 P1_7 输入，
 * 二者共用 I2C0（GPIO41/42）与同一颗芯片。所有访问都在主任务内串行完成
 * （语音播放任务只操作 I2S，不碰 I2C），因此不需要额外互斥。 */
static esp_err_t xl9555_read_reg(uint8_t reg, uint8_t *value)
{
    return i2c_master_write_read_device(I2C_XL_PORT, XL9555_ADDR, &reg, 1, value, 1, pdMS_TO_TICKS(100));
}

static esp_err_t xl9555_write_reg(uint8_t reg, uint8_t value)
{
    uint8_t buf[2] = { reg, value };
    return i2c_master_write_to_device(I2C_XL_PORT, XL9555_ADDR, buf, 2, pdMS_TO_TICKS(100));
}
#endif

#if CONFIG_NODE_BUZZER_XL9555
static void xl9555_beep_init(void)
{
    uint8_t cfg = 0, out = 0;
    if (xl9555_read_reg(XL9555_CONFIG_PORT0_REG, &cfg) != ESP_OK) {
        ESP_LOGW(TAG, "XL9555 不可用（板载蜂鸣器未启用）");
        return;
    }
    if (xl9555_write_reg(XL9555_CONFIG_PORT0_REG, (uint8_t)(cfg & ~XL9555_BEEP_P0_BIT)) != ESP_OK) {
        ESP_LOGW(TAG, "XL9555 配置 P0_3 为输出失败");
        return;
    }
    if (xl9555_read_reg(XL9555_OUTPUT_PORT0_REG, &out) != ESP_OK) out = 0xFF;
    /* BEEP 为**低电平有效**（实测：P0_3=0 时板载蜂鸣器长响），故上电静音 = 置 1 */
    xl9555_write_reg(XL9555_OUTPUT_PORT0_REG, (uint8_t)(out | XL9555_BEEP_P0_BIT));
    ESP_LOGI(TAG, "板载蜂鸣器就绪（XL9555 P0_3）");
}

static void xl9555_beep(int on)
{
    uint8_t out = 0;
    if (xl9555_read_reg(XL9555_OUTPUT_PORT0_REG, &out) != ESP_OK) return;
    /* 低电平有效：on -> 清 P0_3；off -> 置 P0_3 */
    uint8_t next = on ? (uint8_t)(out & ~XL9555_BEEP_P0_BIT) : (uint8_t)(out | XL9555_BEEP_P0_BIT);
    if (next != out) xl9555_write_reg(XL9555_OUTPUT_PORT0_REG, next);
}
#endif

#if CONFIG_NODE_SOS_KEY0_ENABLED
/* 厨房实体求助按键 = 板载 KEY0。
 * 依据 ALIENTEK DNESP32S3 BSP（09_iic_exio/components/BSP/XL9555/xl9555.h）：
 *   KEY0_IO = 0x8000 -> XL9555 的 P1_7，按下为低电平，方向配置为输入。
 * 即 KEY0 **不是 ESP32 GPIO**：没有内部上拉、没有 GPIO 中断，也不能用
 * gpio_get_level()。板上另一颗按键 BOOT(GPIO0) 是 strapping 脚（上电按住会进
 * 下载模式），不能当求助键。 */
static int s_key0_last_raw = -1;   /* 上一次成功读到的电平（1=按下 0=松开），-1=尚未读到 */
static int s_key0_read_fail = 0;   /* 连续读失败计数（仅用于限制告警日志条数） */
static int s_key0_baseline = -1;   /* 上电基线；-1=未知（扩展器不可用） */

static esp_err_t xl9555_read_ports(uint8_t out[2])
{
    uint8_t reg = XL9555_INPUT_PORTS_REG;
    return i2c_master_write_read_device(I2C_XL_PORT, XL9555_ADDR, &reg, 1, out, 2, pdMS_TO_TICKS(50));
}

static void xl9555_key0_init(void)
{
    uint8_t cfg[2] = { 0, 0 };
    if (xl9555_read_reg(XL9555_CONFIG_PORT0_REG, &cfg[0]) != ESP_OK ||
        xl9555_read_reg(XL9555_CONFIG_PORT1_REG, &cfg[1]) != ESP_OK) {
        ESP_LOGW(TAG, "SOS 按键：XL9555 不可用，KEY0 求助入口本次不可用（采集/蜂鸣/语音不受影响）");
        return;
    }
    if ((cfg[1] & SOS_KEY0_P1_BIT) == 0) {
        /* 只改方向寄存器 P1；不动输出锁存与 P0（蜂鸣器/功放使能）。 */
        if (xl9555_write_reg(XL9555_CONFIG_PORT1_REG, (uint8_t)(cfg[1] | SOS_KEY0_P1_BIT)) == ESP_OK)
            ESP_LOGW(TAG, "SOS 按键：KEY0(P1_7) 原为输出，已改为输入");
        else {
            ESP_LOGW(TAG, "SOS 按键：KEY0(P1_7) 设为输入失败，求助按键不可用");
            return;
        }
    }
    uint8_t in[2] = { 0, 0 };
    if (xl9555_read_ports(in) != ESP_OK) {
        ESP_LOGW(TAG, "SOS 按键：读取 KEY0 基线失败（下次轮询重试，不触发求助）");
        return;
    }
    s_key0_baseline = ((in[1] & SOS_KEY0_P1_BIT) == 0) ? 1 : 0;
    ESP_LOGI(TAG, "SOS 按键就绪：板载 KEY0 = XL9555 P1_7（低电平按下，输入方向），"
                  "上电基线=%s，P1=0x%02X；需先见到松开才允许触发",
             s_key0_baseline ? "按下" : "松开", in[1]);
}
#endif /* CONFIG_NODE_SOS_KEY0_ENABLED */

/* 将内部告警状态映射为上报/日志使用的稳定名称。 */
static const char *state_name(int st)
{
    switch (st) {
        case 1: return "WARN";
        case 2: return "ALARM";
        case 3: return "ACKED";
        default: return "NORMAL";
    }
}

/* 获取 Unix 毫秒时间戳；使用 64 位中间值避免 32 位 long 溢出。 */
static int64_t now_ms(void)
{
    struct timeval tv;
    gettimeofday(&tv, NULL);
    return (int64_t)tv.tv_sec * 1000 + tv.tv_usec / 1000;
}

/* 前向声明：命令处理/SOS 快路径在 raise_alarm、report 定义之前使用 */
static void raise_alarm(const char *type, const char *detail);
#if CONFIG_NODE_BATTERY_ADC_CHANNEL >= 0
/* ---------------- 电池电压采样（契约 §1.3 / §2） ----------------
 * 采样策略：
 *   1) 每 NODE_BATTERY_SAMPLE_SEC（默认 30s）一个采样窗，窗内连续读 8 次 raw；
 *   2) 样本间 2ms 间隔，避免 8 次读数落在同一个瞬时毛刺上；
 *   3) 8 个样本交给 battery_logic：中位数 + 极差 + 中位数邻域一致率 + 物理范围，
 *      任何一个门限不过都输出 valid=false + 短码 reason（UNSTABLE/OUT_OF_RANGE/...）。
 *   4) Wi-Fi 发射窗口内的毛刺按 UNSTABLE 丢弃，绝不“猜”一个看起来合理的电压。
 * 全部在主任务里顺序执行（不新建任务、不在中断里读 ADC）。 */
static void battery_sample(void)
{
    int raws[BATTERY_SAMPLE_COUNT];
    int n = 0;
    int read_ok = 0;

    for (int i = 0; i < BATTERY_SAMPLE_COUNT; i++) {
        int raw = 0;
        esp_err_t err = s_adc
            ? adc_oneshot_read(s_adc, (adc_channel_t)CONFIG_NODE_BATTERY_ADC_CHANNEL, &raw)
            : ESP_ERR_INVALID_STATE;
        if (err == ESP_OK) {
            if (n < BATTERY_SAMPLE_COUNT) raws[n++] = raw;
            read_ok = 1;
        } else {
            static int s_batt_adc_log = 0;
            if (s_batt_adc_log < 3) {
                s_batt_adc_log++;
                ESP_LOGW(TAG, "电池 ADC 读失败: %s (CH%d)", esp_err_to_name(err),
                         (int)CONFIG_NODE_BATTERY_ADC_CHANNEL);
            }
        }
        vTaskDelay(pdMS_TO_TICKS(2));
    }

    battery_evaluate(raws, n, read_ok, &s_batt_cfg, &s_batt);
    s_batt_sample_count++;
    /* 前两次 + 每 20 个采样窗（约 10 分钟）+ 有效性翻转时打印，便于真机验收。 */
    {
        static int s_batt_prev_valid = -1;
        int changed = (s_batt_prev_valid != s_batt.valid);
        s_batt_prev_valid = s_batt.valid;
        if (s_batt_sample_count <= 2 || (s_batt_sample_count % 20) == 0 || changed) {
            ESP_LOGI(TAG, "电池采样: raw_median=%d mv=%d valid=%d percent=%d low=%d calibrated=%d reason=%s",
                     s_batt.raw_median, s_batt.mv, s_batt.valid, s_batt.percent, s_batt.low,
                     (int)NODE_BATTERY_CALIBRATED,
                     s_batt.reason && s_batt.reason[0] ? s_batt.reason : "OK");
        }
    }
}

/* 由 sample() 每秒调用一次，按 NODE_BATTERY_SAMPLE_SEC 节流。 */
static void battery_tick(void)
{
    if (++s_batt_tick < CONFIG_NODE_BATTERY_SAMPLE_SEC) return;
    s_batt_tick = 0;
    battery_sample();
}
#endif

static void report(void);
#if CONFIG_NODE_SOS_GPIO >= 0 || CONFIG_NODE_SOS_KEY0_ENABLED || CONFIG_NODE_ALARM_BENCH_INJECT
static void sos_event(const char *detail);
#endif

/* ---------------- 监护暂停状态持久化 ----------------
 * 用户暂停监护后，重启/断电不得自动恢复无活动提醒。只持久化一个布尔键；
 * 读写失败时保持进程内状态并打印警告，不阻塞启动。 */
#define NODE_NVS_NS      "elder_node"
#define NODE_NVS_PAUSED  "mon_paused"

static void monitor_pause_load(void)
{
    nvs_handle_t h;
    uint8_t v = 0;
    if (nvs_open(NODE_NVS_NS, NVS_READONLY, &h) != ESP_OK) return;   /* 首次启动无命名空间 */
    if (nvs_get_u8(h, NODE_NVS_PAUSED, &v) == ESP_OK) s_monitor_paused = v ? 1 : 0;
    nvs_close(h);
    ESP_LOGI(TAG, "监护暂停状态(持久化)=%s", s_monitor_paused ? "PAUSED" : "ACTIVE");
}

static void monitor_pause_save(void)
{
    nvs_handle_t h;
    if (nvs_open(NODE_NVS_NS, NVS_READWRITE, &h) != ESP_OK) {
        ESP_LOGW(TAG, "监护暂停状态写 NVS 失败（本次仍生效，重启可能丢失）");
        return;
    }
    esp_err_t err = nvs_set_u8(h, NODE_NVS_PAUSED, (uint8_t)(s_monitor_paused ? 1 : 0));
    if (err == ESP_OK) err = nvs_commit(h);
    nvs_close(h);
    if (err != ESP_OK) ESP_LOGW(TAG, "监护暂停状态保存失败: %s", esp_err_to_name(err));
}

/* ---------------- 门磁事件序号与补传缓存持久化 ----------------
 * 重启后：seq 继续单调递增（后端按 (deviceId, seq) 幂等去重，重启重传不重复记账）；
 * 未送达事件随心跳补传。写入频率只发生在门磁翻转/缓存清理时（开关事件低频），
 * 不会在 5 秒心跳里写 NVS。读取/写入失败只告警，不阻塞启动。 */
#define NODE_NVS_DOOR_SEQ    "door_seq"
#define NODE_NVS_DOOR_CACHE  "door_cache"

#if CONFIG_NODE_DOOR_GPIO >= 0
static void door_state_save(void);   /* 前置声明：door_event_expire 在其定义之前引用 */
static void door_event_enqueue(int seq, int open, int64_t ts)
{
    if (s_door_event_count < CONFIG_NODE_DOOR_CACHE_MAX) {
        int idx = (s_door_event_head + s_door_event_count) % CONFIG_NODE_DOOR_CACHE_MAX;
        s_door_events[idx].seq = seq;
        s_door_events[idx].open = open;
        s_door_events[idx].ts = ts;
        s_door_events[idx].enqueued_ms = now_ms();
        s_door_event_count++;
    } else {
        /* 满：覆盖最旧（FIFO）。后端幂等去重，被覆盖的最旧 seq 若未送达，
         * 由状态变化兜底在下次翻转时补记（不会永久丢失最终状态）。 */
        s_door_events[s_door_event_head].seq = seq;
        s_door_events[s_door_event_head].open = open;
        s_door_events[s_door_event_head].ts = ts;
        s_door_events[s_door_event_head].enqueued_ms = now_ms();
        s_door_event_head = (s_door_event_head + 1) % CONFIG_NODE_DOOR_CACHE_MAX;
        ESP_LOGW(TAG, "门磁事件缓存满，覆盖最旧事件（上限 %d 条）", CONFIG_NODE_DOOR_CACHE_MAX);
    }
}

static void door_event_expire(void)
{
    if (s_door_event_count == 0) return;
    int64_t now = now_ms();
    int changed = 0;
    while (s_door_event_count > 0) {
        door_event_t *e = &s_door_events[s_door_event_head];
        if (now - e->enqueued_ms < (int64_t)CONFIG_NODE_DOOR_CACHE_KEEP_SEC * 1000) break;
        s_door_event_head = (s_door_event_head + 1) % CONFIG_NODE_DOOR_CACHE_MAX;
        s_door_event_count--;
        changed = 1;
    }
    if (changed) door_state_save();
}

static void door_state_load(void)
{
    nvs_handle_t h;
    uint32_t seq = 0;
    if (nvs_open(NODE_NVS_NS, NVS_READONLY, &h) != ESP_OK) return;
    if (nvs_get_u32(h, NODE_NVS_DOOR_SEQ, &seq) == ESP_OK && seq > 0) s_door_seq = (int)seq;
    struct {
        uint32_t magic;
        uint32_t count;
        uint32_t head;
        door_event_t events[CONFIG_NODE_DOOR_CACHE_MAX];
    } doc;
    size_t len = sizeof(doc);
    if (nvs_get_blob(h, NODE_NVS_DOOR_CACHE, &doc, &len) == ESP_OK &&
        len == sizeof(doc) && doc.magic == 0x444F4F52u /* 'DOOR' */ &&
        doc.count <= CONFIG_NODE_DOOR_CACHE_MAX && doc.head < CONFIG_NODE_DOOR_CACHE_MAX) {
        memcpy(s_door_events, doc.events, sizeof(s_door_events));
        s_door_event_count = (int)doc.count;
        s_door_event_head = (int)doc.head;
    }
    nvs_close(h);
    ESP_LOGI(TAG, "门磁序号恢复 seq=%d 待补传事件=%d", s_door_seq, s_door_event_count);
}

static void door_state_save(void)
{
    nvs_handle_t h;
    if (nvs_open(NODE_NVS_NS, NVS_READWRITE, &h) != ESP_OK) {
        ESP_LOGW(TAG, "门磁状态写 NVS 失败（本次仍生效，重启可能丢失）");
        return;
    }
    struct {
        uint32_t magic;
        uint32_t count;
        uint32_t head;
        door_event_t events[CONFIG_NODE_DOOR_CACHE_MAX];
    } doc;
    doc.magic = 0x444F4F52u;
    doc.count = (uint32_t)s_door_event_count;
    doc.head = (uint32_t)s_door_event_head;
    memcpy(doc.events, s_door_events, sizeof(s_door_events));
    esp_err_t err = nvs_set_blob(h, NODE_NVS_DOOR_CACHE, &doc, sizeof(doc));
    if (err == ESP_OK) err = nvs_set_u32(h, NODE_NVS_DOOR_SEQ, (uint32_t)s_door_seq);
    if (err == ESP_OK) err = nvs_commit(h);
    nvs_close(h);
    if (err != ESP_OK) ESP_LOGW(TAG, "门磁状态保存失败: %s", esp_err_to_name(err));
}
#endif

/* ---------------- WiFi ---------------- */
/* 处理 STA 启动、断线重连和获取 IP 事件，并维护主循环等待的连接位。 */
static void wifi_event_handler(void *arg, esp_event_base_t base,
                               int32_t id, void *data)
{
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        esp_wifi_connect();
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        wifi_event_sta_disconnected_t *ev = (wifi_event_sta_disconnected_t *)data;
        ESP_LOGW(TAG, "WiFi 断开（reason=%d），重连中…", ev ? ev->reason : -1);
        xEventGroupClearBits(s_wifi_events, WIFI_CONNECTED_BIT);
        esp_wifi_connect();
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *ev = (ip_event_got_ip_t *)data;
        ESP_LOGI(TAG, "已获取 IP: " IPSTR, IP2STR(&ev->ip_info.ip));
        xEventGroupSetBits(s_wifi_events, WIFI_CONNECTED_BIT);
    }
}

/* 创建 station 网络栈、注册事件回调并按 Kconfig 凭据启动 Wi-Fi。 */
static void wifi_start(void)
{
    s_wifi_events = xEventGroupCreate();
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_sta();

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));
    ESP_ERROR_CHECK(esp_event_handler_instance_register(
        WIFI_EVENT, ESP_EVENT_ANY_ID, &wifi_event_handler, NULL, NULL));
    ESP_ERROR_CHECK(esp_event_handler_instance_register(
        IP_EVENT, IP_EVENT_STA_GOT_IP, &wifi_event_handler, NULL, NULL));

    wifi_config_t wc = { 0 };
    strncpy((char *)wc.sta.ssid, CONFIG_NODE_WIFI_SSID, sizeof(wc.sta.ssid) - 1);
    strncpy((char *)wc.sta.password, CONFIG_NODE_WIFI_PASS, sizeof(wc.sta.password) - 1);
    wc.sta.scan_method = WIFI_ALL_CHANNEL_SCAN;
    wc.sta.sort_method = WIFI_CONNECT_AP_BY_SIGNAL;
    wc.sta.threshold.authmode = CONFIG_NODE_WIFI_PASS[0] == '\0'
                                ? WIFI_AUTH_OPEN
                                : WIFI_AUTH_WPA2_PSK;
    wc.sta.threshold.rssi = -127;
    // Some phone hotspots advertise optional PMF but fail the ESP32-S3
    // authentication exchange when the station offers it. This deployment
    // uses WPA2-Personal, so disable PMF negotiation for hotspot compatibility.
    wc.sta.pmf_cfg.capable = false;
    wc.sta.pmf_cfg.required = false;

    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_storage(WIFI_STORAGE_RAM));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wc));
    ESP_ERROR_CHECK(esp_wifi_set_ps(WIFI_PS_NONE));
    ESP_ERROR_CHECK(esp_wifi_start());
    ESP_ERROR_CHECK(esp_wifi_set_protocol(
        WIFI_IF_STA, WIFI_PROTOCOL_11B | WIFI_PROTOCOL_11G | WIFI_PROTOCOL_11N));
    ESP_LOGI(TAG, "连接 WiFi: %s", CONFIG_NODE_WIFI_SSID);
}

/* ---------------- 时间同步（用于报文时间戳）---------------- */
/* 启动轮询式 SNTP；同步是否完成由主循环根据系统时间阈值判断。 */
static void time_sync_start(void)
{
    esp_sntp_setoperatingmode(ESP_SNTP_OPMODE_POLL);
    esp_sntp_setservername(0, "ntp.aliyun.com");
    esp_sntp_setservername(1, "cn.pool.ntp.org");
    esp_sntp_init();
}

/* ---------------- AHT20 / ADC ---------------- */
#if CONFIG_NODE_AHT20_ENABLED
/* 按 AHT20 CRC-8（初值 0xFF、多项式 0x31）校验测量数据。 */
static uint8_t aht20_crc8(const uint8_t *data, size_t len)
{
    uint8_t crc = 0xff;
    for (size_t i = 0; i < len; i++) {
        crc ^= data[i];
        for (int bit = 0; bit < 8; bit++) {
            crc = (crc & 0x80) ? (uint8_t)((crc << 1) ^ 0x31) : (uint8_t)(crc << 1);
        }
    }
    return crc;
}
#endif

static void sensors_start(void)
{
#if CONFIG_NODE_BUZZER_XL9555 || CONFIG_NODE_SOS_KEY0_ENABLED || CONFIG_NODE_VOICE_ENABLED
    {   /* 板载器件总线：固定 IO41/IO42（对排针不引出，仅供板载 XL9555 等） */
        i2c_config_t xl_cfg = {
            .mode = I2C_MODE_MASTER,
            .sda_io_num = XL9555_SDA_GPIO,
            .scl_io_num = XL9555_SCL_GPIO,
            .sda_pullup_en = GPIO_PULLUP_ENABLE,
            .scl_pullup_en = GPIO_PULLUP_ENABLE,
            .master.clk_speed = 100000,
            .clk_flags = 0,
        };
        ESP_ERROR_CHECK(i2c_param_config(I2C_XL_PORT, &xl_cfg));
        ESP_ERROR_CHECK(i2c_driver_install(I2C_XL_PORT, xl_cfg.mode, 0, 0, 0));
        vTaskDelay(pdMS_TO_TICKS(50));
#if CONFIG_NODE_BUZZER_XL9555
        xl9555_beep_init();
#endif
#if CONFIG_NODE_SOS_KEY0_ENABLED
        xl9555_key0_init();
#endif
    }
#endif
#if CONFIG_NODE_AHT20_ENABLED
    {   /* 外部 AHT20：Kconfig 指定的 P1 排针 IO4/IO5 */
        i2c_config_t cfg = {
            .mode = I2C_MODE_MASTER,
            .sda_io_num = CONFIG_NODE_I2C_SDA_GPIO,
            .scl_io_num = CONFIG_NODE_I2C_SCL_GPIO,
            .sda_pullup_en = GPIO_PULLUP_ENABLE,
            .scl_pullup_en = GPIO_PULLUP_ENABLE,
            .master.clk_speed = 100000,
            .clk_flags = 0,
        };
        ESP_ERROR_CHECK(i2c_param_config(I2C_AHT_PORT, &cfg));
        ESP_ERROR_CHECK(i2c_driver_install(I2C_AHT_PORT, cfg.mode, 0, 0, 0));
        vTaskDelay(pdMS_TO_TICKS(100));
        const uint8_t init[] = { 0xbe, 0x08, 0x00 };
        esp_err_t err = i2c_master_write_to_device(I2C_AHT_PORT, AHT20_ADDR, init, sizeof(init), pdMS_TO_TICKS(100));
        if (err != ESP_OK) ESP_LOGW(TAG, "AHT20 初始化命令失败: %s", esp_err_to_name(err));
        vTaskDelay(pdMS_TO_TICKS(20));
    }
#endif

#if CONFIG_NODE_MQ2_ADC_CHANNEL >= 0 || CONFIG_NODE_MQ5_ADC_CHANNEL >= 0 || CONFIG_NODE_BATTERY_ADC_CHANNEL >= 0
#if CONFIG_NODE_BATTERY_ADC_CHANNEL >= 0
    /* 电池换算参数来自 Kconfig（契约 §1.3）：分压比、两点校准、有效范围、低电阈值。 */
    battery_config_default(&s_batt_cfg);
    s_batt_cfg.divider_num = CONFIG_NODE_BATTERY_DIVIDER_NUM;
    s_batt_cfg.divider_den = CONFIG_NODE_BATTERY_DIVIDER_DEN;
    s_batt_cfg.gain_permille = CONFIG_NODE_BATTERY_CAL_GAIN_PERMILLE;
    s_batt_cfg.offset_mv = CONFIG_NODE_BATTERY_CAL_OFFSET_MV;
    s_batt_cfg.low_mv = CONFIG_NODE_BATTERY_LOW_MV;
    s_batt_cfg.min_mv = CONFIG_NODE_BATTERY_MIN_MV;
    s_batt_cfg.max_mv = CONFIG_NODE_BATTERY_MAX_MV;
    s_batt_cfg.calibrated = NODE_BATTERY_CALIBRATED ? 1 : 0;
    /* 初始状态：还没采样 -> valid=false + NO_ADC，绝不预置成任何电压/百分比。 */
    s_batt.valid = 0;
    s_batt.mv = -1;
    s_batt.percent = -1;
    s_batt.low = 0;
    s_batt.raw_median = -1;
    s_batt.reason = BATTERY_REASON_NO_ADC;
    ESP_LOGI(TAG, "电池采样启用: CH%d 分压 %d:%d 校准=%s gain=%dpermille offset=%dmV 有效=%d..%dmV 低电<=%dmV 周期=%ds",
             (int)CONFIG_NODE_BATTERY_ADC_CHANNEL,
             (int)CONFIG_NODE_BATTERY_DIVIDER_NUM, (int)CONFIG_NODE_BATTERY_DIVIDER_DEN,
             NODE_BATTERY_CALIBRATED ? "是" : "否(percent=null)",
             (int)CONFIG_NODE_BATTERY_CAL_GAIN_PERMILLE, (int)CONFIG_NODE_BATTERY_CAL_OFFSET_MV,
             (int)CONFIG_NODE_BATTERY_MIN_MV, (int)CONFIG_NODE_BATTERY_MAX_MV,
             (int)CONFIG_NODE_BATTERY_LOW_MV, (int)CONFIG_NODE_BATTERY_SAMPLE_SEC);
#endif
    adc_oneshot_unit_init_cfg_t unit_cfg = {
        .unit_id = ADC_UNIT_1,
        .ulp_mode = ADC_ULP_MODE_DISABLE,
    };
    ESP_ERROR_CHECK(adc_oneshot_new_unit(&unit_cfg, &s_adc));
    adc_oneshot_chan_cfg_t chan_cfg = {
        .atten = ADC_ATTEN_DB_12,
        .bitwidth = ADC_BITWIDTH_12,
    };
#if CONFIG_NODE_MQ2_ADC_CHANNEL >= 0
    ESP_ERROR_CHECK(adc_oneshot_config_channel(s_adc, (adc_channel_t)CONFIG_NODE_MQ2_ADC_CHANNEL, &chan_cfg));
#endif
#if CONFIG_NODE_MQ5_ADC_CHANNEL >= 0
    ESP_ERROR_CHECK(adc_oneshot_config_channel(s_adc, (adc_channel_t)CONFIG_NODE_MQ5_ADC_CHANNEL, &chan_cfg));
#endif
#if CONFIG_NODE_BATTERY_ADC_CHANNEL >= 0
    /* 电池分压点接 ADC1；与 MQ 共用同一个 oneshot 单元（不同通道），
     * 通道复用已在编译期 #error 拦截，这里只注册通道。 */
    ESP_ERROR_CHECK(adc_oneshot_config_channel(s_adc, (adc_channel_t)CONFIG_NODE_BATTERY_ADC_CHANNEL, &chan_cfg));
#endif
#endif
}

static int aht20_read(float *temp_c, float *rh)
{
#if CONFIG_NODE_AHT20_ENABLED
    const uint8_t trigger[] = { 0xac, 0x33, 0x00 };
    if (i2c_master_write_to_device(I2C_PORT, AHT20_ADDR, trigger, sizeof(trigger), pdMS_TO_TICKS(100)) != ESP_OK) {
        return -1;
    }
    vTaskDelay(pdMS_TO_TICKS(90));
    uint8_t data[7] = { 0 };
    if (i2c_master_read_from_device(I2C_PORT, AHT20_ADDR, data, sizeof(data), pdMS_TO_TICKS(100)) != ESP_OK) {
        return -1;
    }
    if ((data[0] & 0x80) != 0 || aht20_crc8(data, 6) != data[6]) return -1;
    uint32_t raw_h = ((uint32_t)data[1] << 12) | ((uint32_t)data[2] << 4) | (data[3] >> 4);
    uint32_t raw_t = ((uint32_t)(data[3] & 0x0f) << 16) | ((uint32_t)data[4] << 8) | data[5];
    *rh = (float)raw_h * 100.0f / 1048576.0f;
    *temp_c = (float)raw_t * 200.0f / 1048576.0f - 50.0f;
    /* 有限性 + 物理范围双重校验：任何一项不成立都视为本次读数无效，
     * 由调用方把 s_climate_valid 置 0，绝不拿它去触发 CLIMATE 告警。 */
    if (!isfinite(*temp_c) || !isfinite(*rh)) return -1;
    return (*rh >= 0.0f && *rh <= 100.0f && *temp_c >= -40.0f && *temp_c <= 85.0f) ? 0 : -1;
#else
    (void)temp_c;
    (void)rh;
    return -1;
#endif
}

/* ---------------- DHT11（单总线，最小只读实现） ---------------- */
#if CONFIG_NODE_DHT11_GPIO >= 0
/* 等待输入电平离开指定状态；超时返回 -1，并可选记录实际等待时长。 */
static int dht11_wait_level(int pin, int level, int timeout_us, int64_t *elapsed_us)
{
    int64_t start = esp_timer_get_time();
    while (gpio_get_level(pin) == level) {
        if (esp_timer_get_time() - start > timeout_us) {
            if (elapsed_us != NULL) *elapsed_us = esp_timer_get_time() - start;
            return -1;
        }
        esp_rom_delay_us(1);
    }
    if (elapsed_us != NULL) *elapsed_us = esp_timer_get_time() - start;
    return 0;
}

/* 发起一次 DHT11 单总线读取，按高电平宽度解码 40 位并校验 8 位校验和。 */
static int dht11_read(float *temp_c, float *rh)
{
    const int pin = CONFIG_NODE_DHT11_GPIO;
    uint8_t data[5] = { 0 };
    int highs[40] = { 0 };
    int64_t elapsed = 0;
    static int s_dht_diag_logs = 0;

    gpio_config_t io = { 0 };
    io.intr_type = GPIO_INTR_DISABLE;
    io.mode = GPIO_MODE_INPUT_OUTPUT_OD;
    io.pin_bit_mask = 1ULL << pin;
    io.pull_up_en = GPIO_PULLUP_ENABLE;
    io.pull_down_en = GPIO_PULLDOWN_DISABLE;
    if (gpio_config(&io) != ESP_OK) return -1;

    /* DHT11 上电/两次读取至少间隔 1s；本节点采样也按秒级运行。 */
    gpio_set_level(pin, 1);
    vTaskDelay(pdMS_TO_TICKS(1100));
    gpio_set_level(pin, 0);
    vTaskDelay(pdMS_TO_TICKS(20));
    gpio_set_level(pin, 1);
    esp_rom_delay_us(30);
    gpio_set_direction(pin, GPIO_MODE_INPUT);
    gpio_set_pull_mode(pin, GPIO_PULLUP_ONLY);

    if (dht11_wait_level(pin, 1, 100, &elapsed) != 0) {  /* 等传感器拉低 */
        if (s_dht_diag_logs++ < 8) ESP_LOGW(TAG, "DHT11 diag: no response low, line=%d wait=%lldus", gpio_get_level(pin), elapsed);
        return -1;
    }
    if (dht11_wait_level(pin, 0, 100, &elapsed) != 0) {
        if (s_dht_diag_logs++ < 8) ESP_LOGW(TAG, "DHT11 diag: response low stuck, line=%d wait=%lldus", gpio_get_level(pin), elapsed);
        return -1;
    }
    if (dht11_wait_level(pin, 1, 100, &elapsed) != 0) {
        if (s_dht_diag_logs++ < 8) ESP_LOGW(TAG, "DHT11 diag: response high stuck, line=%d wait=%lldus", gpio_get_level(pin), elapsed);
        return -1;
    }

    for (int i = 0; i < 40; i++) {
        if (dht11_wait_level(pin, 0, 100, &elapsed) != 0) {
            if (s_dht_diag_logs++ < 8) ESP_LOGW(TAG, "DHT11 diag: bit %d low start timeout line=%d wait=%lldus", i, gpio_get_level(pin), elapsed);
            return -1;
        }
        /* 低电平周期结束、线已为高，立即开始测量高电平。 */
        int64_t high_start = esp_timer_get_time();
        if (dht11_wait_level(pin, 1, 100, &elapsed) != 0) {
            if (s_dht_diag_logs++ < 8) ESP_LOGW(TAG, "DHT11 diag: bit %d high end timeout line=%d wait=%lldus", i, gpio_get_level(pin), elapsed);
            return -1;
        }
        int high_us = (int)(esp_timer_get_time() - high_start);
        highs[i] = high_us;
        data[i / 8] <<= 1;
        if (high_us > 45) data[i / 8] |= 1;
    }

    gpio_set_direction(pin, GPIO_MODE_INPUT_OUTPUT_OD);
    gpio_set_level(pin, 1);

    uint8_t sum = (uint8_t)(data[0] + data[1] + data[2] + data[3]);
    if (sum != data[4]) {
        if (s_dht_diag_logs++ < 8) {
            ESP_LOGW(TAG, "DHT11 diag: checksum mismatch d=%02x %02x %02x %02x %02x highs=%d,%d,%d,%d,%d,%d,%d,%d",
                     data[0], data[1], data[2], data[3], data[4],
                     highs[0], highs[1], highs[2], highs[3], highs[4], highs[5], highs[6], highs[7]);
        }
        return -1;
    }
    *rh = (float)data[0];
    *temp_c = (float)data[2];
    if (s_dht_diag_logs++ < 8) {
        ESP_LOGI(TAG, "DHT11 diag: OK rh=%u temp=%u checksum=%02x highs=%d,%d,%d,%d",
                 data[0], data[2], data[4], highs[0], highs[1], highs[2], highs[3]);
    }
    return (*rh >= 0.0f && *rh <= 100.0f && *temp_c >= -20.0f && *temp_c <= 60.0f) ? 0 : -1;
}
#endif

/* 按构建配置选择唯一温湿度传感器；未配置时返回读取失败。 */
static int climate_read(float *temp_c, float *rh)
{
#if CONFIG_NODE_DHT11_GPIO >= 0
    return dht11_read(temp_c, rh);
#elif CONFIG_NODE_AHT20_ENABLED
    return aht20_read(temp_c, rh);
#else
    (void)temp_c;
    (void)rh;
    return -1;
#endif
}

/* ---------------- GPIO ---------------- */
/* 只初始化本构建启用的 GPIO 外设，并为有状态的传感器建立初始逻辑状态。 */
static void gpio_start(void)
{
#if CONFIG_NODE_MOTION_GPIO >= 0
    {
        gpio_config_t io = { 0 };
        io.intr_type = GPIO_INTR_DISABLE;
        io.mode = GPIO_MODE_INPUT;
        io.pin_bit_mask = 1ULL << CONFIG_NODE_MOTION_GPIO;
        io.pull_up_en = GPIO_PULLUP_DISABLE;
        io.pull_down_en = GPIO_PULLDOWN_ENABLE;     /* 防止悬空误触发 */
        gpio_config(&io);
    }
#endif
#if CONFIG_NODE_DOOR_GPIO >= 0
    {
        /* 无源干簧管干接点：一端接 GPIO、另一端接 GND，内部上拉。
         * 磁铁靠近（触点闭合）→ 拉低；远离（断开）→ 上拉高。
         * 开启电平由 NODE_DOOR_OPEN_LEVEL 配置（按实物实测确认），
         * 上电基线在首次稳定读数后建立，基线前状态为未知。 */
        gpio_config_t io = { 0 };
        io.intr_type = GPIO_INTR_DISABLE;
        io.mode = GPIO_MODE_INPUT;
        io.pin_bit_mask = 1ULL << CONFIG_NODE_DOOR_GPIO;
        io.pull_up_en = GPIO_PULLUP_ENABLE;
        io.pull_down_en = GPIO_PULLDOWN_DISABLE;
        gpio_config(&io);
        door_reset(&s_door_db);
        s_door_baseline_unknown = 1;
        s_door_open = 0;
        door_state_load();
        ESP_LOGI(TAG, "门磁已配置 GPIO%d（开启电平=%d，去抖确认=%d 次，缓存=%d 条/%ds）",
                 (int)CONFIG_NODE_DOOR_GPIO, (int)CONFIG_NODE_DOOR_OPEN_LEVEL,
                 (int)CONFIG_NODE_DOOR_CONFIRM_COUNT, (int)CONFIG_NODE_DOOR_CACHE_MAX,
                 (int)CONFIG_NODE_DOOR_CACHE_KEEP_SEC);
    }
#endif
#if CONFIG_NODE_SOS_GPIO >= 0
    {   /* SOS：内部上拉，另一端接 GND，按下=低电平 */
        gpio_config_t io = { 0 };
        io.intr_type = GPIO_INTR_DISABLE;
        io.mode = GPIO_MODE_INPUT;
        io.pin_bit_mask = 1ULL << CONFIG_NODE_SOS_GPIO;
        io.pull_up_en = GPIO_PULLUP_ENABLE;
        io.pull_down_en = GPIO_PULLDOWN_DISABLE;
        gpio_config(&io);
    }
#endif
#if CONFIG_NODE_WATER_GPIO >= 0
    {   /* 水漏 DO：默认低电平=湿润（内部上拉）；若模块为高有效则启用下拉 */
        gpio_config_t io = { 0 };
        io.intr_type = GPIO_INTR_DISABLE;
        io.mode = GPIO_MODE_INPUT;
        io.pin_bit_mask = 1ULL << CONFIG_NODE_WATER_GPIO;
#if CONFIG_NODE_WATER_ACTIVE_LOW
        io.pull_up_en = GPIO_PULLUP_ENABLE;
        io.pull_down_en = GPIO_PULLDOWN_DISABLE;
#else
        io.pull_up_en = GPIO_PULLUP_DISABLE;
        io.pull_down_en = GPIO_PULLDOWN_ENABLE;
#endif
        gpio_config(&io);
    }
#endif
#if CONFIG_NODE_BUZZER_XL9555
    /* 板载蜂鸣器：在 sensors_start() 末尾经 XL9555 初始化，无需 GPIO */
#elif CONFIG_NODE_BUZZER_GPIO >= 0
    {
        gpio_config_t io = { 0 };
        io.intr_type = GPIO_INTR_DISABLE;
        io.mode = GPIO_MODE_OUTPUT;
        io.pin_bit_mask = 1ULL << CONFIG_NODE_BUZZER_GPIO;
        gpio_config(&io);
        gpio_set_level(CONFIG_NODE_BUZZER_GPIO, 0);
    }
#endif
}

/* 将告警声音请求转发到当前配置的蜂鸣器硬件，未配置时为空操作。 */
static void buzzer(int on)
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
    /* 长音次数用来区分“本板自己的求助”和“替其他设备播报的求助”：
     * 本板 SOS = CONFIG_NODE_ALARM_CHIRP_COUNT_SOS 声；外部求助再多 2 声。
     * 两者语音文案相同（复用同一份 ADPCM），但听感上可分辨，且不占额外 flash。 */
    int beeps = (clip == VOICE_CLIP_REMOTE_SOS)
                ? (CONFIG_NODE_ALARM_CHIRP_COUNT_SOS + 2)
                : (clip == VOICE_CLIP_SOS ? CONFIG_NODE_ALARM_CHIRP_COUNT_SOS
                                          : CONFIG_NODE_ALARM_CHIRP_COUNT);
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
}

/* ---------------- 网关 TCP 连接 ---------------- */
static int gw_connect(void)
{
    struct addrinfo hints = { 0 }, *res = NULL;
    char port[8];
    snprintf(port, sizeof(port), "%d", CONFIG_NODE_GW_PORT);
    hints.ai_family = AF_INET;
    hints.ai_socktype = SOCK_STREAM;

    if (getaddrinfo(CONFIG_NODE_GW_HOST, port, &hints, &res) != 0 || res == NULL) {
        ESP_LOGW(TAG, "解析网关地址失败: %s", CONFIG_NODE_GW_HOST);
        return -1;
    }
    int fd = socket(res->ai_family, res->ai_socktype, res->ai_protocol);
    if (fd < 0) {
        freeaddrinfo(res);
        return -1;
    }
#if CONFIG_NODE_VOICE_ENABLED
    const struct timeval send_timeout = { .tv_sec = 1, .tv_usec = 0 };
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &send_timeout, sizeof(send_timeout));
#endif
    if (connect(fd, res->ai_addr, res->ai_addrlen) != 0) {
        close(fd);
        freeaddrinfo(res);
        return -1;
    }
    freeaddrinfo(res);
    ESP_LOGI(TAG, "已连接网关 %s:%d", CONFIG_NODE_GW_HOST, CONFIG_NODE_GW_PORT);
    s_rxlen = 0;
    return fd;
}

static void gw_send(const char *text)
{
#if CONFIG_NODE_VOICE_ENABLED
    if (s_reports) {
        report_message_t message = {0};
        snprintf(message.text, sizeof(message.text), "%s", text);
        xQueueOverwrite(s_reports, &message);
    }
#else
    if (s_sock >= 0) {
        if (send(s_sock, text, strlen(text), 0) < 0) {
            close(s_sock);
            s_sock = -1;
        } else {
            s_gw_sent_count++;   /* 仅表示已写出到 Bridge，不代表云端入库 */
        }
    }
#endif
}

/* ---------------- 命令处理（与 homemon 同名命令）---------------- */
/* SOS 是离散事件：同一持续告警期间不叠播、不新建 ID；用户停止后再次按下
 * 只恢复提醒。ACK 后（或危险类型不同）按下则按普通新告警处理。 */
#if CONFIG_NODE_SOS_GPIO >= 0 || CONFIG_NODE_SOS_KEY0_ENABLED || CONFIG_NODE_ALARM_BENCH_INJECT
static void sos_event(const char *detail)
{
    if (s_state == 2 && strcmp(s_alarm_type, "MANUAL_SOS") == 0) {
        if (s_user_stopped) {
            s_user_stopped = 0;
            s_last_remind_ms = now_ms();
            announce_start(VOICE_CLIP_SOS);
            ESP_LOGW(TAG, "SOS 再次按下（停止后恢复提醒，不新建告警）id=%s", s_alarm_id);
        } else {
            ESP_LOGI(TAG, "重复 SOS 已抑制：同一告警持续中，不叠播、不新建 ID（id=%s）", s_alarm_id);
        }
        return;
    }
    /* 阶段①：本地已触发。设备只声称“正在发送”，不播放“已受理/已处理”之类的
     * 误导语音；只有收到匹配 alarmId 的回执才会转 ACKED。 */
    ESP_LOGW(TAG, "SOS 本地已触发：%s（来源设备=%s / 房间=%s，厨房设备实体按键）；"
                  "状态=正在发送，尚未收到监护人确认", detail, CONFIG_NODE_ID, CONFIG_NODE_ROOM);
    raise_alarm("MANUAL_SOS", detail);
    report();
}
#endif /* CONFIG_NODE_SOS_GPIO >= 0 || CONFIG_NODE_SOS_KEY0_ENABLED || CONFIG_NODE_ALARM_BENCH_INJECT */

/* ---------------- 跨房间定向播报：notice / noticeack ----------------
 * 语义边界（务必保持）：
 *   - 只播报“别人已经产生的那个求助事件”，本板不创建告警、不新建 ID、不产生新的
 *     MANUAL_SOS，也不改变本板上报的 state/alarm 字段 —— 因此不会在 APP 里多出
 *     一条“厨房/卫生间求助”，也不会把环境告警变成跨房间广播。
 *   - 本地告警（s_state==ALARM）优先：本板自己在响的时候拒绝外来播报，不抢占声音。
 *   - 同一 alarmId 只播一次；已确认（noticeack）过的同一 ID 再来也不重播，
 *     重试/长按/抖动/断线重连都不会反复拉响。
 *   - ACK 只代表“求助已被监护人确认”，不代表求助者已安全。 */
static size_t next_token(const char *rest, char *out, size_t out_sz)
{
    while (*rest == ' ' || *rest == '\t') rest++;
    size_t n = strcspn(rest, " \t\r\n");
    if (n >= out_sz) n = out_sz - 1;
    memcpy(out, rest, n);
    out[n] = '\0';
    return n;
}

/* 本地告警接管：停止外来播报，但把它记为“已结束的 ID”，避免之后被重播。
 * 绝不触碰本地告警状态。 */
static void notice_yield_local(void)
{
    char interrupted[NOTICE_ID_MAX];
    snprintf(interrupted, sizeof(interrupted), "%s", s_notice.active_id);
    if (!notice_yield(&s_notice)) return;
    ESP_LOGW(TAG, "本地告警接管：停止外部求助播报（外部 alarmId=%s 仍未确认，仍需人工处理）",
             interrupted);
}

static void notice_start(const char *rest)
{
    char aid[NOTICE_ID_MAX], src[NOTICE_SOURCE_MAX];
    const char *after = rest;
    if (next_token(rest, aid, sizeof(aid)) == 0) {
        ESP_LOGW(TAG, "NOTICE 被拒绝：缺少 alarmId");
        return;
    }
    while (*after == ' ' || *after == '\t') after++;
    after += strlen(aid);
    if (next_token(after, src, sizeof(src)) == 0) {
        ESP_LOGW(TAG, "NOTICE 被拒绝：缺少来源 deviceId（不猜测来源）");
        return;
    }
    switch (notice_begin(&s_notice, aid, src, s_state == 2)) {
    case NOTICE_BEGIN_PLAY:
        ESP_LOGW(TAG, "NOTICE 收到：来源=%s alarmId=%s → 开始短提示音 + 中文语音播报；"
                      "本板不生成告警、不新建 ID、上报状态保持不变", src, aid);
        announce_start(VOICE_CLIP_REMOTE_SOS);
        break;
    case NOTICE_BEGIN_LOCAL_ALARM:
        ESP_LOGW(TAG, "NOTICE 被忽略：本板本地告警中（state=ALARM, id=%s type=%s），本地告警优先；"
                      "外部 alarmId=%s 未在本板播报", s_alarm_id, s_alarm_type, aid);
        break;
    case NOTICE_BEGIN_DUP_ACTIVE:
        ESP_LOGI(TAG, "NOTICE 重复已抑制：同一外部求助正在播报（alarmId=%s），不叠播、不重发", aid);
        break;
    case NOTICE_BEGIN_DUP_DONE:
        ESP_LOGI(TAG, "NOTICE 已忽略：该外部求助此前已播报/已确认（alarmId=%s），重连或重试不重复拉响", aid);
        break;
    case NOTICE_BEGIN_BAD_ID:
        ESP_LOGW(TAG, "NOTICE 被拒绝：alarmId/来源非法（只接受 [A-Za-z0-9._-]{1,32}）: id=%s src=%s", aid, src);
        break;
    case NOTICE_BEGIN_NO_ID:
    default:
        ESP_LOGW(TAG, "NOTICE 被拒绝：缺少 alarmId");
        break;
    }
}

static void notice_ack(const char *rest)
{
    char aid[NOTICE_ID_MAX];
    char src[NOTICE_SOURCE_MAX];
    if (next_token(rest, aid, sizeof(aid)) == 0) {
        ESP_LOGW(TAG, "NOTICE ACK 被拒绝：缺少 alarmId");
        return;
    }
    snprintf(src, sizeof(src), "%s", s_notice.source);
    switch (notice_end(&s_notice, aid)) {
    case NOTICE_END_STOPPED:
        announce_cancel();
        ESP_LOGI(TAG, "NOTICE ACK 已接受：外部求助播报已停止（alarmId=%s，来源=%s）。"
                      "注意：这只代表求助已被监护人确认，不代表求助者已安全", aid, src);
        break;
    case NOTICE_END_NO_MATCH:
        ESP_LOGW(TAG, "NOTICE ACK 被拒绝：没有匹配的在播外部求助（收到=%s）", aid);
        break;
    case NOTICE_END_NO_ID:
    default:
        ESP_LOGW(TAG, "NOTICE ACK 被拒绝：缺少 alarmId");
        break;
    }
}

static void handle_command(const char *line)
{
    while (*line == ' ') line++;
    /* 设备实际收到命令与命令效果分开记录：先记录“收到”，再记录是否接受/生效 */
    ESP_LOGI(TAG, "CMD 收到: %s", line);
    if (strncmp(line, "ack", 3) == 0 && (line[3] == ' ' || line[3] == '\0')) {
        /* ack <alarmId> <处置说明>：仅当处于 ALARM 且 ID 精确匹配才闭环，否则拒绝且状态不变 */
        const char *rest = line + 3;
        while (*rest == ' ') rest++;
        char aid[40];
        size_t n = strcspn(rest, " \t\r\n");
        if (n >= sizeof(aid)) n = sizeof(aid) - 1;
        memcpy(aid, rest, n);
        aid[n] = '\0';
        if (s_state != 2 || s_alarm_id[0] == '\0') {
            ESP_LOGW(TAG, "ACK 被拒绝：当前没有待处理告警（state=%s，收到 id=%s）"
                          "——可能来自上一轮/重启前的旧回执，设备不视为本次确认",
                     state_name(s_state), aid[0] ? aid : "(none)");
        } else if (strcmp(aid, s_alarm_id) != 0) {
            ESP_LOGW(TAG, "ACK 被拒绝：告警 ID 不匹配（当前=%s，收到=%s），"
                          "旧求助的回执不能确认本次求助",
                     s_alarm_id, aid[0] ? aid : "(none)");
        } else {
            s_state = 3;
            s_acked_armed = 0;   /* 危险仍在：先不武装，避免 ACK 后立刻重复告警 */
            s_user_stopped = 0;
            s_sos_pending_since = 0;
            announce_cancel();   /* ACK 立即静音：提示音+语音都停；保留 alarmId / alarm.type */
            ESP_LOGI(TAG, "ACK 回执已接受并生效（阶段③：监护人已确认）：id=%s type=%s "
                          "-> state=ACKED，蜂鸣器已停，语音已取消", aid, s_alarm_type);
            report();
        }
    } else if (strncmp(line, "noticeack", 9) == 0 &&
               (line[9] == '\0' || line[9] == ' ' || line[9] == '\t')) {
        /* noticeack <alarmId>：监护人已在 APP 确认该外部求助 → 停止本板播报。
         * 与 ack 不同：它不接受本地告警、不改 state、不写告警 ID。 */
        notice_ack(line + 9);
    } else if (strncmp(line, "notice", 6) == 0 &&
               (line[6] == ' ' || line[6] == '\t')) {
        /* notice <alarmId> <sourceDeviceId>：定向播报其他设备的同一求助事件 */
        notice_start(line + 6);
    } else if (strncmp(line, "stop", 4) == 0 &&
               (line[4] == '\0' || line[4] == ' ' || line[4] == '\r')) {
        /* stop：只停止本轮声音，保留 ALARM 状态与告警 ID（不等于 ACK，也不等于异常解除） */
        if (s_state == 2) {
            s_user_stopped = 1;
            announce_cancel();
            ESP_LOGI(TAG, "STOP 已接受并生效：本轮声音停止，state 保持 ALARM id=%s type=%s；"
                          "同一持续事件不再重复拉响", s_alarm_id, s_alarm_type);
            report();
        } else {
            ESP_LOGW(TAG, "STOP 被忽略：当前没有正在告警的事件（state=%s）", state_name(s_state));
        }
    } else if (strncmp(line, "pause", 5) == 0 &&
               (line[5] == '\0' || line[5] == ' ' || line[5] == '\r')) {
        if (!s_monitor_paused) {
            s_monitor_paused = 1;
            monitor_pause_save();
            if (s_state == 2 && strcmp(s_alarm_type, "NO_MOTION") == 0) {
                s_state = 0;          /* 暂停即解除“无活动”提醒状态，不等待下一条数据 */
                s_user_stopped = 0;
                announce_cancel();
            }
            ESP_LOGI(TAG, "PAUSE 已接受并持久化：暂停监护（仅抑制无活动提醒；SOS/环境告警不受影响）");
            report();
        }
    } else if (strncmp(line, "resume", 6) == 0 &&
               (line[6] == '\0' || line[6] == ' ' || line[6] == '\r')) {
        if (s_monitor_paused) {
            s_monitor_paused = 0;
            monitor_pause_save();
            ESP_LOGI(TAG, "RESUME 已接受并持久化：恢复监护");
            report();
        }
    } else if (strncmp(line, "mictest", 7) == 0 &&
               (line[7] == '\0' || line[7] == ' ' || line[7] == '\r')) {
        /* 板载咪头自检（正常现场固件可用）：串口输入 mictest [1..5]。
         * 采集指定秒数后打印 MIC_TEST rms/peak，结束后自动恢复播放通路。 */
        int sec = line[7] == ' ' ? atoi(line + 8) : 3;
        ESP_LOGW(TAG, "MIC_TEST 开始：%d 秒（安静/说话各测一次，比较 RMS 与峰值）", sec);
        local_voice_mic_test(sec);
    } else if (strncmp(line, "beep", 4) == 0 &&
               (line[4] == '\0' || line[4] == ' ' || line[4] == '\r')) {
        /* 仅自检：在咪头旁提供近场声源，不改变告警状态。 */
        const char *arg = line + 4;
        while (*arg == ' ') arg++;
        bool on = (strncmp(arg, "on", 2) == 0);
        buzzer(on ? 1 : 0);
        ESP_LOGW(TAG, "BEEP %s（自检声源，不改变告警状态）", on ? "ON" : "OFF");
    } else if (strncmp(line, "healthtest", 10) == 0 &&
               (line[10] == '\0' || line[10] == ' ' || line[10] == '\r')) {
        /* 直接本地播放健康建议 clip 9，绕过网关/音箱 socket。 */
        ESP_LOGW(TAG, "HEALTHTEST 本地播放健康建议 clip=9");
        local_voice_play(VOICE_CLIP_HEALTH);
    } else if (strncmp(line, "speaktest", 9) == 0 &&
               (line[9] == '\0' || line[9] == ' ' || line[9] == '\r')) {
        /* 本地 ES8388/功放/喇叭自检：不经过网络 PCM。 */
        ESP_LOGW(TAG, "SPEAKTEST 本地播放自检（绕过网络）");
        local_voice_play(VOICE_CLIP_SAFE_PROMPT);
    } else if (strncmp(line, "pcmtest", 7) == 0 &&
               (line[7] == '\0' || line[7] == ' ' || line[7] == '\r')) {
        /* 本地生成 1 秒 400Hz 方波，直接走网络 PCM 同一播放函数，不经过网关。 */
        static int16_t tone[16000];
        for (int i = 0; i < 16000; ++i) tone[i] = ((i / 20) & 1) ? 9000 : -9000;
        ESP_LOGW(TAG, "PCMTEST 本地 PCM 通路自检（不经过网关）");
        if (local_voice_pcm_begin()) {
            local_voice_pcm_write(tone, 16000);
            local_voice_pcm_end();
            ESP_LOGI(TAG, "PCMTEST done");
        } else {
            ESP_LOGW(TAG, "PCMTEST begin failed");
        }
    } else if (strncmp(line, "micupload", 9) == 0 &&
               (line[9] == '\0' || line[9] == ' ' || line[9] == '\r')) {
        /* 手动触发一次“录音→上传 9303→ASR”，用于端到端验收；不改变告警状态。 */
        if (mic_link_trigger("cmd")) {
            ESP_LOGW(TAG, "MIC_UPLOAD 已排队：录音 %d 秒后上传 %s:%d",
                     (int)CONFIG_NODE_MIC_RECORD_SEC, CONFIG_NODE_GW_HOST,
                     (int)CONFIG_NODE_MIC_PORT);
        } else {
            ESP_LOGE(TAG, "MIC_UPLOAD 未启动：采音链路不可用（语音未启用或任务创建失败）");
        }
    } else if (strncmp(line, "reset", 5) == 0) {
        s_state = 0;
        s_acked_armed = 0;
        s_user_stopped = 0;
        s_sos_pending_since = 0;
        s_alarm_id[0] = '\0';
        s_alarm_type[0] = '\0';
        /* reset 只清 active，不动 last_id：同一外部事件若仍在持续，重置后允许重新播报一次 */
        s_notice.active_id[0] = '\0';
        s_notice.source[0] = '\0';
        announce_cancel();
        ESP_LOGI(TAG, "状态复位 -> NORMAL（warning: reset 不会解除监护暂停）");
        report();
#if CONFIG_NODE_ALARM_BENCH_INJECT
    } else if (strncmp(line, "inj ", 4) == 0) {
        const char *rest = line + 4;
        if (strncmp(rest, "climate ", 8) == 0) {
            rest += 8;
            if (strncmp(rest, "invalid", 7) == 0) {
                s_inj_climate = 1;
                s_inj_climate_valid = 0;
                ESP_LOGW(TAG, "INJ 温湿度=无效读数（valid=0，不参与判定）");
            } else {
                float t = 0.0f, h = 0.0f;
                if (sscanf(rest, "%f %f", &t, &h) == 2) {
                    s_inj_climate = 1;
                    s_inj_climate_valid = 1;
                    s_inj_temp = t;
                    s_inj_rh = h;
                    ESP_LOGW(TAG, "INJ 温湿度=%.1fC/%.1f%%", (double)t, (double)h);
                } else {
                    ESP_LOGW(TAG, "INJ 温湿度参数非法: %s", rest);
                }
            }
        } else if (strncmp(rest, "pir ", 4) == 0) {
            int v = atoi(rest + 4);
            s_inj_pir = v ? 1 : 0;
            ESP_LOGW(TAG, "INJ PIR raw=%d（%s）", s_inj_pir, s_pir_armed ? "已武装" : "未武装");
        } else if (strncmp(rest, "door ", 5) == 0) {
            int v = atoi(rest + 5);
            s_inj_door = v ? 1 : 0;
            ESP_LOGW(TAG, "INJ 门磁 raw=%d", s_inj_door);
        } else if (strcmp(rest, "sos") == 0 || strncmp(rest, "sos ", 4) == 0) {
            ESP_LOGW(TAG, "INJ SOS（台架注入事件）");
            sos_event("台架注入 SOS");
        } else if (strcmp(rest, "motion") == 0) {
            s_last_motion_ms = now_ms();
            s_pir_armed = 1;
            ESP_LOGW(TAG, "INJ 活动基准已重置（武装无活动计时）");
        } else if (strncmp(rest, "led", 3) == 0) {
            const char *arg = rest + 3;
            while (*arg == ' ') arg++;
            if (strcmp(arg, "on") == 0) {
                local_led_bench_raw(1);
            } else if (strcmp(arg, "off") == 0) {
                local_led_bench_raw(0);
            } else if (strcmp(arg, "auto") == 0) {
                local_led_bench_auto();
            } else if (strncmp(arg, "pol ", 4) == 0) {
                const char *p = arg + 4;
                if (strncmp(p, "low", 3) == 0 || strcmp(p, "1") == 0) local_led_bench_polarity(1);
                else if (strncmp(p, "high", 4) == 0 || strcmp(p, "0") == 0) local_led_bench_polarity(0);
                else ESP_LOGW(TAG, "INJ led pol 参数非法: %s", p);
            } else if (strncmp(arg, "id", 2) == 0) {
                int ms = atoi(arg + 2);
                local_led_bench_identify(ms > 0 ? ms : 6000);
            } else {
                ESP_LOGW(TAG, "INJ led 未知子命令: %s", arg);
            }
        } else if (strncmp(rest, "voice", 5) == 0) {
            /* 台架试听：直接播报某个片段（不产生云端事件、不改告警状态）。
             * inj voice 1..6 = SOS/温度/湿度/两者/无活动/通用；inj voice seq = 提示音+语音。 */
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
        } else if (strcmp(rest, "reboot") == 0) {
            /* 台架重启验证：重启后不得重放历史告警、基本采集需恢复、暂停状态保持 */
            ESP_LOGW(TAG, "INJ 重启：验证重启后不重放历史声音（NVS 暂停状态应保持）");
            vTaskDelay(pdMS_TO_TICKS(200));
            esp_restart();
        } else {
            ESP_LOGW(TAG, "INJ 未知子命令: %s", rest);
        }
#endif
    } else {
        ESP_LOGW(TAG, "未知命令（忽略）: %s", line);
    }
}

static void gw_poll(void)
{
    if (s_sock < 0) return;
    char b[256];
    int n = recv(s_sock, b, sizeof(b), MSG_DONTWAIT);
    if (n == 0) {
        ESP_LOGW(TAG, "网关断开");
        close(s_sock);
        s_sock = -1;
        return;
    }
    if (n < 0) return;
    if (s_rxlen + (size_t)n < sizeof(s_rx)) {
        memcpy(s_rx + s_rxlen, b, (size_t)n);
        s_rxlen += (size_t)n;
    }
    char *p = s_rx;
    for (;;) {
        char *nl = memchr(p, '\n', s_rxlen - (size_t)(p - s_rx));
        if (!nl) break;
        *nl = '\0';
#if CONFIG_NODE_VOICE_ENABLED
        command_message_t command = {0};
        snprintf(command.text, sizeof(command.text), "%s", p);
        if (xQueueSend(s_commands, &command, 0) != pdTRUE)
            ESP_LOGW(TAG, "command mailbox full; command rejected");
#else
        handle_command(p);
#endif
        p = nl + 1;
    }
    size_t used = (size_t)(p - s_rx);
    if (used) {
        memmove(s_rx, p, s_rxlen - used);
        s_rxlen -= used;
    }
}

#if CONFIG_NODE_VOICE_ENABLED
static void gateway_task(void *arg)
{
    (void)arg;
    report_message_t message;
    for (;;) {
        if (!(xEventGroupGetBits(s_wifi_events) & WIFI_CONNECTED_BIT)) {
            if (s_sock >= 0) { close(s_sock); s_sock = -1; s_rxlen = 0; }
            vTaskDelay(pdMS_TO_TICKS(200));
            continue;
        }
        if (s_sock < 0) {
            s_sock = gw_connect(); /* DNS/connect may block only this task. */
            if (s_sock < 0) { vTaskDelay(pdMS_TO_TICKS(1000)); continue; }
        }
        gw_poll();
        /* Keep queued status until connected. Never concatenate partial JSON
         * onto another connection: close on partial send failure. */
        if (s_sock >= 0 && xQueueReceive(s_reports, &message, 0) == pdTRUE) {
            size_t offset = 0, length = strlen(message.text);
            while (offset < length) {
                int n = send(s_sock, message.text + offset, length - offset, 0);
                if (n <= 0) { close(s_sock); s_sock = -1; break; }
                offset += (size_t)n;
            }
            /* 整条报文写出后计数（半条失败不算送达，避免把断线当成已发送）。 */
            if (s_sock >= 0 && offset == length) s_gw_sent_count++;
            /* Retry a failed snapshot only if no newer status is queued. */
            if (s_sock < 0) xQueueSend(s_reports, &message, 0);
            ESP_LOGI(TAG, "STACK_FREE task=gateway-net bytes=%u", (unsigned)uxTaskGetStackHighWaterMark(NULL));
        }
        vTaskDelay(pdMS_TO_TICKS(100));
    }
}
#endif

#if CONFIG_NODE_ALARM_BENCH_INJECT || defined(CONFIG_NODE_VOICE_ENABLED)
/* 串口命令通道：UART0（板载 CH340 串口）逐行读取命令，投入与网关相同的
 * 命令队列，由主任务统一执行（避免跨任务改状态）。
 * 台架固件用它注入传感器；现场固件用它执行 mictest / micupload 自检。 */
static void serial_command_task(void *arg)
{
    (void)arg;
    const uart_config_t cfg = {
        .baud_rate = 115200,
        .data_bits = UART_DATA_8_BITS,
        .parity = UART_PARITY_DISABLE,
        .stop_bits = UART_STOP_BITS_1,
        .flow_ctrl = UART_HW_FLOWCTRL_DISABLE,
        .source_clk = UART_SCLK_DEFAULT,
    };
    esp_err_t err = uart_driver_install(UART_NUM_0, 1024, 0, 0, NULL, 0);
    if (err == ESP_OK) err = uart_param_config(UART_NUM_0, &cfg);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "串口命令通道初始化失败: %s", esp_err_to_name(err));
        vTaskDelete(NULL);
        return;
    }
    ESP_LOGW(TAG, "串口命令通道就绪（UART0 115200 8N1，逐行命令）");
    uint8_t buf[128];
    char line[256];
    size_t len = 0;
    for (;;) {
        int n = uart_read_bytes(UART_NUM_0, buf, sizeof(buf), pdMS_TO_TICKS(100));
        for (int i = 0; i < n; i++) {
            char c = (char)buf[i];
            if (c == '\r') continue;
            if (c == '\n') {
                if (len > 0) {
                    line[len] = '\0';
                    command_message_t command = {0};
                    snprintf(command.text, sizeof(command.text), "%s", line);
                    if (xQueueSend(s_commands, &command, 0) != pdTRUE)
                        ESP_LOGW(TAG, "命令队列满，已丢弃: %s", line);
                    len = 0;
                }
            } else if (len < sizeof(line) - 1) {
                line[len++] = c;
            }
        }
    }
}
#endif /* CONFIG_NODE_ALARM_BENCH_INJECT || defined(CONFIG_NODE_VOICE_ENABLED) */

/* ---------------- 采集与判定 ---------------- */
static void sample(void)
{
#if CONFIG_NODE_MOTION_GPIO >= 0
    /* 连续确认后才认定活动；只在确认上升沿更新 lastActiveTs/countToday，不产生告警 */
    {
        int pir_raw;
#if CONFIG_NODE_ALARM_BENCH_INJECT
        pir_raw = (s_inj_pir >= 0) ? s_inj_pir : (gpio_get_level(CONFIG_NODE_MOTION_GPIO) ? 1 : 0);
#else
        pir_raw = gpio_get_level(CONFIG_NODE_MOTION_GPIO) ? 1 : 0;
#endif
        if (pir_update(&s_pir_db, pir_raw, CONFIG_NODE_MOTION_DEBOUNCE_CONFIRM)) {
            s_last_motion_ms = now_ms();
            s_motion_count++;
            s_pir_armed = 1;   /* 本次启动已确认到有效 PIR 活动，此后才允许“无活动”判定 */
            ESP_LOGI(TAG, "检测到活动（今日第 %d 次）", s_motion_count);
        }
    }
#endif
#if CONFIG_NODE_WATER_GPIO >= 0
    {
        int level = gpio_get_level(CONFIG_NODE_WATER_GPIO) ? 1 : 0;
#if CONFIG_NODE_WATER_ACTIVE_LOW
        int wet = (level == 0) ? 1 : 0;
#else
        int wet = (level == 1) ? 1 : 0;
#endif
        s_water_valid = 1;                       /* 数字量读取本身有效 */
        s_water_ok = !water_update(&s_water_stab, s_water_valid, wet,
                                   CONFIG_NODE_WATER_CONFIRM_COUNT,
                                   CONFIG_NODE_WATER_CLEAR_COUNT);
    }
#endif
#if CONFIG_NODE_DOOR_GPIO >= 0
    {
        /* 连续确认 + 上电基线：只读电平，稳定翻转才生成带 seq 的事件（入补传缓存）；
         * 基线建立前 s_door_open 保持未知（report 整段不发），不凭空生成历史事件；
         * 保持状态不变不产生事件；时间未同步时事件 ts=0。 */
        int door_raw;
#if CONFIG_NODE_ALARM_BENCH_INJECT
        door_raw = (s_inj_door >= 0) ? s_inj_door : (gpio_get_level(CONFIG_NODE_DOOR_GPIO) ? 1 : 0);
#else
        door_raw = gpio_get_level(CONFIG_NODE_DOOR_GPIO) ? 1 : 0;
#endif
        if (door_update(&s_door_db, door_raw, CONFIG_NODE_DOOR_OPEN_LEVEL,
                        CONFIG_NODE_DOOR_CONFIRM_COUNT)) {
            s_door_open = s_door_db.stable_open;
            int64_t ev_ts = s_time_synced ? now_ms() : 0;
            int seq = ++s_door_seq;
            door_event_enqueue(seq, s_door_open, ev_ts);
            if (s_door_open) s_door_last_open_ts = ev_ts;
            else s_door_last_close_ts = ev_ts;
            ESP_LOGI(TAG, "门磁状态变化：%s（seq=%d%s）", s_door_open ? "开启" : "关闭",
                     seq, ev_ts > 0 ? "" : "，时间未同步按服务器时间记录");
            door_state_save();
        }
        if (s_door_db.baseline_set) {
            s_door_open = s_door_db.stable_open;
            if (s_door_baseline_unknown) {
                s_door_baseline_unknown = 0;
                ESP_LOGI(TAG, "门磁基线建立：当前状态=%s（不生成历史事件）",
                         s_door_open ? "开启" : "关闭");
            }
        }
        door_event_expire();
    }
#endif

    float temp_c = 0.0f, rh = 0.0f;
    int climate_read_ok;
#if CONFIG_NODE_ALARM_BENCH_INJECT
    if (s_inj_climate) {
        temp_c = s_inj_temp;
        rh = s_inj_rh;
        climate_read_ok = s_inj_climate_valid &&
                          isfinite(temp_c) && isfinite(rh) &&
                          temp_c > -40.0f && temp_c < 85.0f && rh >= 0.0f && rh <= 100.0f;
    } else
#endif
    {
        climate_read_ok = (climate_read(&temp_c, &rh) == 0) &&
                          isfinite(temp_c) && isfinite(rh) &&
                          temp_c > -40.0f && temp_c < 85.0f && rh >= 0.0f && rh <= 100.0f;
    }
    if (climate_read_ok) {
        s_temp_c = temp_c;
        s_rh = rh;
        s_climate_valid = 1;
        /* 连续确认 + 回差；只有有效读数参与触发/解除，无效读数保持上一次判定 */
        s_climate_ok = !climate_stab_update(&s_climate_stab, 1, temp_c, rh,
                                            CONFIG_NODE_TEMP_LOW_C, CONFIG_NODE_TEMP_HIGH_C,
                                            CONFIG_NODE_RH_LOW, CONFIG_NODE_RH_HIGH,
                                            CONFIG_NODE_TEMP_HYST_C, CONFIG_NODE_RH_HYST,
                                            CONFIG_NODE_CLIMATE_CONFIRM_COUNT,
                                            CONFIG_NODE_CLIMATE_CLEAR_COUNT);
    } else {
#if CONFIG_NODE_AHT20_ENABLED || CONFIG_NODE_DHT11_GPIO >= 0
        static int s_aht_fail_log = 0;
        s_climate_valid = 0;      /* 本次读取失败：valid=false；既不当正常，也不当异常数值使用 */
        if (s_aht_fail_log < 3) { s_aht_fail_log++; ESP_LOGW(TAG, "温湿度本次读取无效（valid=false，保持上次有效判定）"); }
#endif
    }

#if CONFIG_NODE_MQ2_ADC_CHANNEL >= 0
    s_mq2_valid = 0;
    esp_err_t adc_e2 = s_adc ? adc_oneshot_read(s_adc, (adc_channel_t)CONFIG_NODE_MQ2_ADC_CHANNEL, &s_mq2_raw)
                             : ESP_ERR_INVALID_STATE;
    if (adc_e2 != ESP_OK) {
        static int s_adc_log2 = 0;
        if (s_adc_log2 < 3) { s_adc_log2++; ESP_LOGW(TAG, "MQ2 ADC 读失败: %s (ch=%d)", esp_err_to_name(adc_e2), CONFIG_NODE_MQ2_ADC_CHANNEL); }
    }
    if (adc_e2 == ESP_OK) {
        s_mq2_valid = 1;
    }
    /* 连续确认 + 回差：只有有效读数参与；失败既不判危险也不判消失 */
    s_smoke_ok = !mq_stab_update(&s_mq2_stab, s_mq2_valid, s_mq2_raw,
                                 CONFIG_NODE_MQ2_ALARM_RAW,
                                 CONFIG_NODE_MQ_HYSTERESIS_RAW,
                                 CONFIG_NODE_MQ_CONFIRM_COUNT);
#endif
#if CONFIG_NODE_MQ5_ADC_CHANNEL >= 0
    s_mq5_valid = 0;
    esp_err_t adc_e5 = s_adc ? adc_oneshot_read(s_adc, (adc_channel_t)CONFIG_NODE_MQ5_ADC_CHANNEL, &s_mq5_raw)
                             : ESP_ERR_INVALID_STATE;
    if (adc_e5 != ESP_OK) {
        static int s_adc_log5 = 0;
        if (s_adc_log5 < 3) { s_adc_log5++; ESP_LOGW(TAG, "MQ5 ADC 读失败: %s (ch=%d)", esp_err_to_name(adc_e5), CONFIG_NODE_MQ5_ADC_CHANNEL); }
    }
    if (adc_e5 == ESP_OK) {
        s_mq5_valid = 1;
    }
    s_gas_ok = !mq_stab_update(&s_mq5_stab, s_mq5_valid, s_mq5_raw,
                               CONFIG_NODE_MQ5_ALARM_RAW,
                               CONFIG_NODE_MQ_HYSTERESIS_RAW,
                               CONFIG_NODE_MQ_CONFIRM_COUNT);
#endif
#if CONFIG_NODE_BATTERY_ADC_CHANNEL >= 0
    /* 电池采样按 NODE_BATTERY_SAMPLE_SEC（默认 30s）节流，与 MQ 共用同一个 ADC1 单元；
     * 放在主任务 sample() 末尾，避免与 Wi-Fi 初始化/网关收发抢占同一时刻。 */
    battery_tick();
#endif
}

/* 同一危险持续存在时不重复生成新 ID（避免告警风暴 / 每秒刷新 alarmId）。
 * ACKED 只屏蔽"已被确认的那一种危险"：出现另一种危险、或同种危险在消失后
 * 再次出现时，必须照常报警，否则 ACK 会变成永久屏蔽真实危险的开关。 */
static int voice_clip_for_alarm(const char *type);   /* 定义见下 */

#if CONFIG_NODE_MIC_UPLOAD
/* 告警语音播完后，先播“如果您没事，请说没事”，再开 4 秒麦。
 * 固定延时只用于本机喇叭，不依赖网络；失败会继续尝试上传并在串口报错。 */
static void safe_prompt_task(void *arg)
{
    (void)arg;
    vTaskDelay(pdMS_TO_TICKS(4500));      /* 等告警语音（SOS/温湿度/无活动）播完 */
    local_voice_play(VOICE_CLIP_SAFE_PROMPT);
    vTaskDelay(pdMS_TO_TICKS(3300));      /* 提示音约 3.0s，播完再开麦，避免录到提示词 */
    if (!mic_link_trigger("prompt")) {
        ESP_LOGW(TAG, "采音上传未启动：提示后触发失败");
    }
    vTaskDelete(NULL);
}
#endif

static void raise_alarm(const char *type, const char *detail)
{
    /* 判定逻辑收口到 alarm_logic.h（主机侧已单测） */
    if (!alarm_raise_allowed(s_state, s_alarm_type, s_acked_armed, type)) return;
    notice_yield_local();   /* 本板自己的告警优先：先停掉外来播报，再拉响本地告警 */
    s_alarm_seq++;
    /* 跨重启唯一：NTP 未同步时改用上电随机盐，避免“e-0-N”撞号导致云端去重吞掉
     * 新求助、或上一轮旧 ACK 被误当成本次确认（见 alarm_logic.h）。 */
    alarm_id_build(s_alarm_id, sizeof(s_alarm_id), (long long)time(NULL), s_boot_salt, s_alarm_seq);
    snprintf(s_alarm_type, sizeof(s_alarm_type), "%s", type);
    s_state = 2;
    s_acked_armed = 0;
    s_user_stopped = 0;              /* 新告警：清除上一轮的“停止”标记 */
    s_last_remind_ms = now_ms();     /* 新告警立即播放，并作为限频提醒基准 */
    s_sos_mark = s_gw_sent_count;    /* 本次事件的“已送达”基线 */
    s_sos_pending_since = (strcmp(type, "MANUAL_SOS") == 0) ? now_ms() : 0;
    s_sos_delivery_logged = 0;
    s_sos_wait_warned = 0;
    /* 先短提示音、蜂鸣停止后再播完整语音（文案由真实触发原因决定） */
    announce_start(voice_clip_for_alarm(type));
#if CONFIG_NODE_MIC_UPLOAD
    /* 先播“请说我没事”，提示后再开麦；不常开麦克风。 */
    if (xTaskCreate(safe_prompt_task, "safe-prompt", 4096, NULL, 3, NULL) != pdPASS) {
        ESP_LOGW(TAG, "提示任务创建失败，直接开麦");
        if (!mic_link_trigger(type)) ESP_LOGW(TAG, "采音上传未启动：链路不可用");
    }
#endif
    ESP_LOGW(TAG, "%s -> ALARM（%s，type=%s）语音+蜂鸣已请求", detail, s_alarm_id, type);
}

/* 文案必须对应真实触发原因：温度/湿度/两者分别播报，读数无效时才用兜底文案。
 * 厨房/卫生间当前启用后可能触发的类型只有 MANUAL_SOS / CLIMATE / NO_MOTION；
 * GAS/SMOKE 阈值 4096（禁用）、WATER GPIO -1（未接），不会产生告警。若将来启用，
 * 必须另加对应文案，不能拿温湿度文案冒充。 */
static int voice_clip_for_alarm(const char *type)
{
    if (!type || type[0] == '\0') return VOICE_CLIP_CLIMATE_GENERIC;
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

/* 当前最高优先级的危险类型：SOS 走事件路径，这里按 GAS > SMOKE > WATER > CLIMATE > NO_MOTION；
 * 无危险返回 NULL。单一优先级函数保证同一时刻只对外呈现一个告警，且 ACK 的低优先级
 * 告警不会掩盖随后出现的更高优先级危险。 */
static const char *active_danger(void)
{
#if CONFIG_NODE_MQ5_ADC_CHANNEL >= 0
    if (s_mq5_valid && !s_gas_ok) return "GAS";
#endif
#if CONFIG_NODE_MQ2_ADC_CHANNEL >= 0
    if (s_mq2_valid && !s_smoke_ok) return "SMOKE";
#endif
#if CONFIG_NODE_WATER_GPIO >= 0
    if (s_water_valid && !s_water_ok) return "WATER_LEAK";
#endif
#if CONFIG_NODE_AHT20_ENABLED || CONFIG_NODE_DHT11_GPIO >= 0
    /* 用“上一次有效判定”的持久结果：读取失效既不能清除已确认的环境告警，
     * 也不能新造告警；JSON 里 valid=false 如实告知下游。 */
    if (!s_climate_ok) return "CLIMATE";
#endif
#if CONFIG_NODE_MOTION_GPIO >= 0
    {
#if CONFIG_NODE_NO_MOTION_REQUIRE_ARM
        const int motion_armed = s_pir_armed;
#else
        const int motion_armed = 1;
#endif
        if (no_motion_enabled(1, motion_armed, s_monitor_paused) &&
            now_ms() - s_last_motion_ms >= (int64_t)CONFIG_NODE_NO_MOTION_SEC * 1000) {
            return "NO_MOTION";
        }
    }
#endif
    return NULL;
}

static const char *danger_detail(const char *type)
{
    if (strcmp(type, "MANUAL_SOS") == 0) return "SOS 按键被按下";
    if (strcmp(type, "WATER_LEAK") == 0) return "水漏传感器检测到漏水";
    if (strcmp(type, "GAS") == 0)     return "MQ-5 检测到燃气超阈值";
    if (strcmp(type, "SMOKE") == 0)   return "MQ-2 检测到烟雾/可燃气体超阈值";
    if (strcmp(type, "CLIMATE") == 0) return "AHT20 温湿度越界";
    return "长时间无活动";
}

/* 状态机（显式语义）：
 *   NORMAL/ALARM --检测到最高优先级危险--> ALARM（新建唯一 alarmId，蜂鸣器响）
 *   ALARM --同一危险持续--> 不产生新 ID（无告警风暴）
 *   ALARM --出现更高优先级危险--> 升级为新告警（新 ID）
 *   ALARM --NO_MOTION 且活动恢复--> 自动回 NORMAL（保持既有行为）
 *   ALARM --ACK 且 ID 精确匹配--> ACKED（蜂鸣器保持响，等 reset）
 *   ACKED --同种危险持续--> 保持 ACKED，不再响铃、不新建 ID
 *   ACKED --该危险先消失再出现--> 重新武装后再次报警（不再是永久屏蔽）
 *   ACKED --出现另一种危险--> 立即新告警（绝不被 ACK 屏蔽）
 *   ACKED --reset--> NORMAL
 * GAS / SMOKE / CLIMATE 都必须 ACK 或 reset 才回到 NORMAL（不自动清除）。 */
static void judge(void)
{
    const char *danger = active_danger();

    if (s_state == 3) {
        if (danger == NULL) {
            /* 已确认的危险消失：重新武装，之后再次出现才允许重新报警 */
            s_acked_armed = 1;
        } else if (strcmp(danger, s_alarm_type) != 0 || s_acked_armed) {
            raise_alarm(danger, danger_detail(danger));
        }
        return;
    }

    if (danger != NULL) {
        /* 优先级保护：较低优先级的环境危险不得覆盖正在进行的更高优先级告警
         * （典型：SOS 触发后 1 秒内出现温湿度越界）。被压下的危险仍然有效，
         * SOS 被 ACK 后会在 ACKED 分支立即升级为新的环境告警。 */
        if (s_state == 2 && danger_priority(danger) < danger_priority(s_alarm_type)) {
            return;
        }
        raise_alarm(danger, danger_detail(danger));
        return;
    }

    /* 没有危险：可恢复类告警（无活动/温湿度/水漏）自动回 NORMAL，
     * 使“异常解除后恢复 → 再次异常重新提醒”成立；
     * GAS / SMOKE 保持“必须 ACK/reset”的安全锁存语义，不自动清除。 */
    if (s_state == 2) {
        int recoverable = 0;
#if CONFIG_NODE_MOTION_GPIO >= 0
        if (strcmp(s_alarm_type, "NO_MOTION") == 0) recoverable = 1;
#endif
#if CONFIG_NODE_AHT20_ENABLED || CONFIG_NODE_DHT11_GPIO >= 0
        if (strcmp(s_alarm_type, "CLIMATE") == 0) recoverable = 1;
#endif
#if CONFIG_NODE_WATER_GPIO >= 0
        if (strcmp(s_alarm_type, "WATER_LEAK") == 0) recoverable = 1;
#endif
        if (recoverable) {
            ESP_LOGI(TAG, "异常解除 -> NORMAL（type=%s id=%s），已取消声音并重新武装",
                     s_alarm_type, s_alarm_id);
            s_state = 0;
            s_user_stopped = 0;
            s_sos_pending_since = 0;
            s_alarm_id[0] = '\0';
            s_alarm_type[0] = '\0';
            announce_cancel();
        }
    }
}

/* 持续异常限频提醒：每 100 ms 主循环调用一次，只有到间隔点才真正播放。
 * 用户 stop/ACK 后不再提醒；危险解除后状态已回 NORMAL；再次异常会产生新告警并立即播放。 */
static void alarm_reminder_tick(void)
{
#if CONFIG_NODE_ALARM_REPEAT_SEC > 0
    /* “长时间未检测到活动”只提醒一次：房间无人/夜间睡眠时不应无限重复打扰；
     * SOS 与环境类告警才按限频间隔持续提醒。 */
    if (s_alarm_type[0] && strcmp(s_alarm_type, "NO_MOTION") == 0) return;
    int64_t now = now_ms();
    if (!alarm_repeat_due(s_state == 2, s_user_stopped,
                          now, s_last_remind_ms, CONFIG_NODE_ALARM_REPEAT_SEC)) {
        return;
    }
    s_last_remind_ms = now;
    /* 限频提醒同样遵循“短提示音 -> 完整语音”，原因文案与本次告警类型一致 */
    announce_start(voice_clip_for_alarm(s_alarm_type));
    ESP_LOGW(TAG, "持续异常限频提醒（间隔 %d 秒）：type=%s id=%s（state=ALARM）",
             (int)CONFIG_NODE_ALARM_REPEAT_SEC, s_alarm_type, s_alarm_id);
#endif
}

/* ---------------- 上报 ---------------- */
static void report(void)
{
    char json[REPORT_JSON_MAX];
    char water_json[80] = "";      /* 仅卫生间等启用节点输出 water 段；厨房 JSON 保持不变 */
#if CONFIG_NODE_WATER_GPIO >= 0
    snprintf(water_json, sizeof(water_json), ",\"water\":{\"wet\":%s,\"valid\":%s}",
             s_water_ok ? "false" : "true", json_valid_str(s_water_valid));
#endif
    /* door 段：门磁启用时带 lastOpenTs/lastCloseTs/seq/events（补传缓存，后端按 seq 幂等）；
     * 基线未建立时 open=null（状态未知，绝不默认"关闭"）；未启用门磁保持旧合同字段兼容 HAP。 */
    char door_json[700] = "";
#if CONFIG_NODE_DOOR_GPIO >= 0
    {
        int n = 0;
        n += snprintf(door_json + n, sizeof(door_json) - (size_t)n,
            "\"door\":{\"open\":%s,\"lastOpenTs\":%lld,\"lastCloseTs\":%lld,\"seq\":%d",
            s_door_baseline_unknown ? "null" : (s_door_open ? "true" : "false"),
            (long long)s_door_last_open_ts, (long long)s_door_last_close_ts, s_door_seq);
        if (s_door_event_count > 0) {
            n += snprintf(door_json + n, sizeof(door_json) - (size_t)n, ",\"events\":[");
            for (int i = 0; i < s_door_event_count && n < (int)sizeof(door_json) - 8; i++) {
                door_event_t *e = &s_door_events[(s_door_event_head + i) % CONFIG_NODE_DOOR_CACHE_MAX];
                n += snprintf(door_json + n, sizeof(door_json) - (size_t)n,
                    "%s{\"seq\":%d,\"open\":%s,\"ts\":%lld}",
                    i > 0 ? "," : "", e->seq, e->open ? "true" : "false", (long long)e->ts);
            }
            n += snprintf(door_json + n, sizeof(door_json) - (size_t)n, "]");
        }
        snprintf(door_json + n, sizeof(door_json) - (size_t)n, "},");
    }
#else
    snprintf(door_json, sizeof(door_json), "\"door\":{\"open\":false,\"lastOpenTs\":0},");
#endif
#if CONFIG_NODE_BATTERY_ADC_CHANNEL >= 0
    /* 契约 §2：battery 对象只在“本设备真的接了电池采样电路”（CHANNEL>=0）时输出。
     * 固定供电设备（厨房/卫生间/DAYU200）编译期就没有这段 —— 绝不给它们编造电量。
     * 无效读数一律 mv/percent=null + 短码 reason；present 也只在拿到可信电压时为 true。 */
    char battery_json[240];
    char battery_mv[16] = "null";   /* int 最长 11 字符 + NUL */
    char battery_percent[16] = "null";
    if (s_batt.mv >= 0) snprintf(battery_mv, sizeof(battery_mv), "%d", s_batt.mv);
    if (s_batt.percent >= 0) snprintf(battery_percent, sizeof(battery_percent), "%d", s_batt.percent);
    snprintf(battery_json, sizeof(battery_json),
             ",\"battery\":{\"source\":\"battery\",\"present\":%s,\"valid\":%s,\"mv\":%s,"
             "\"percent\":%s,\"low\":%s,\"calibrated\":%s,\"reason\":\"%s\"}",
             s_batt.valid ? "true" : "false",
             s_batt.valid ? "true" : "false",
             battery_mv, battery_percent,
             s_batt.low ? "true" : "false",
             NODE_BATTERY_CALIBRATED ? "true" : "false",
             (s_batt.reason && s_batt.reason[0]) ? s_batt.reason : "");
#else
    const char *battery_json = "";
#endif
    long long ts = s_time_synced ? now_ms() : 0;
    long long last = (s_time_synced && s_last_motion_ms > 0)
                     ? ts - (now_ms() - s_last_motion_ms) : 0;

    int written = snprintf(json, sizeof(json),
        "{\"deviceId\":\"%s\",\"room\":\"%s\",\"ts\":%lld,\"state\":\"%s\","
        "\"sensors\":{\"motion\":{\"lastActiveTs\":%lld,\"countToday\":%d},"
        "%s"
        "\"climate\":{\"tempC\":%.1f,\"rh\":%.1f,\"ok\":%s,\"valid\":%s},"
        "\"gas\":{\"raw\":%d,\"ok\":%s,\"valid\":%s},"
        "\"smoke\":{\"raw\":%d,\"ok\":%s,\"valid\":%s}%s},"
        "\"history\":[0,0,0,0,0,0,%d],\"slots\":[0,0,0,0],"
        "\"alarm\":{\"id\":\"%s\",\"type\":\"%s\",\"countToday\":%d}%s}\n",
        CONFIG_NODE_ID, CONFIG_NODE_ROOM, ts, state_name(s_state),
        last, s_motion_count,
        door_json,
        (double)s_temp_c, (double)s_rh,
        s_climate_ok ? "true" : "false", json_valid_str(s_climate_valid),
        s_mq5_raw, s_gas_ok ? "true" : "false", json_valid_str(s_mq5_valid),
        s_mq2_raw, s_smoke_ok ? "true" : "false", json_valid_str(s_mq2_valid),
        water_json,
        s_motion_count,
        (s_state == 2 || s_state == 3) ? s_alarm_id : "",
        (s_state == 2 || s_state == 3) ? s_alarm_type : "",
        (s_state == 2 || s_state == 3) ? 1 : 0,
        battery_json);

    /* 长度断言：宁可不发，也绝不把截断的半条 JSON 发给网关（会被下游判成非法报文）。 */
    if (written < 0 || (size_t)written >= sizeof(json)) {
        ESP_LOGE(TAG, "上报 JSON 溢出（%d >= %u），本条丢弃（不发截断报文）",
                 written, (unsigned)sizeof(json));
        return;
    }

    static int s_report_n = 0;
    if ((s_report_n++ % 4) == 0) {
        ESP_LOGI(TAG, "ADC raw: MQ2(CH%d)=%d valid=%d danger=%d | MQ5(CH%d)=%d valid=%d danger=%d",
                 (int)CONFIG_NODE_MQ2_ADC_CHANNEL, s_mq2_raw, s_mq2_valid, !s_smoke_ok,
                 (int)CONFIG_NODE_MQ5_ADC_CHANNEL, s_mq5_raw, s_mq5_valid, !s_gas_ok);
    }
    gw_send(json);
    ESP_LOGI(TAG, "→ %s", json);
#if CONFIG_NODE_VOICE_ENABLED
    ESP_LOGI(TAG, "STACK_FREE task=main bytes=%u", (unsigned)uxTaskGetStackHighWaterMark(NULL));
#endif
}


/* ---------------- 板载 KEY1：AI 语音提问 ----------------
 * ALIENTEK DNESP32S3 XL9555: KEY1 = P1_6（0x40），低电平按下。
 * 短按只触发一次 4 秒提问录音，不产生 SOS、不改告警状态。 */
#if CONFIG_NODE_VOICE_ENABLED && CONFIG_NODE_BUZZER_XL9555
#define AI_KEY1_P1_BIT 0x40
static int s_ai_key_last_raw = -1;
static int s_ai_key_armed = 0;
static int s_ai_key_press_active = 0;
static int64_t s_ai_key_press_at = 0;

/* KEY1 一键提问：短按松开后开 4 秒麦；识别为健康问题时网关回 clip=9，
 * 由本板直接播健康建议；其他问题正常走 ASR/DeepSeek，DAYU 显示文字。 */
static void ai_key_handle(void)
{
    uint8_t p1 = 0;
    if (xl9555_read_reg(XL9555_INPUT_PORTS_REG + 1, &p1) != ESP_OK) return;
    int raw = ((p1 & AI_KEY1_P1_BIT) == 0) ? 1 : 0;
    if (s_ai_key_last_raw < 0) {
        s_ai_key_last_raw = raw;
        if (!raw) s_ai_key_armed = 1;
        return;
    }
    int64_t now = now_ms();
    if (raw && s_ai_key_last_raw == 0 && s_ai_key_armed) {
        s_ai_key_press_at = now;
        s_ai_key_press_active = 1;
    }
    if (!raw && s_ai_key_last_raw == 1) {
        if (s_ai_key_press_active && now - s_ai_key_press_at >= 50) {
            ESP_LOGI(TAG, "AI_KEY1 短按：开始 4 秒语音提问");
            xl9555_beep(1);
            vTaskDelay(pdMS_TO_TICKS(80));
            xl9555_beep(0);
            mic_link_trigger("question");
        }
        s_ai_key_press_active = 0;
        s_ai_key_armed = 1;
    }
    s_ai_key_last_raw = raw;
}
#endif

/* SOS 快路径：主循环每 100 ms 调用一次。短按需连续 NODE_SOS_DEBOUNCE_CONFIRM
 * 次（默认 2 次≈200 ms）确认；长按只产生一次求助；松开后重新武装，可再次发起。
 * 传感器采样仍为 1 秒一次（AHT20 单次测量本身约 90 ms）。 */
static void sos_handle_fast(void)
{
#if CONFIG_NODE_SOS_GPIO >= 0 || CONFIG_NODE_SOS_KEY0_ENABLED
    int raw_pressed = 0;
    int raw_known = 1;    /* 0 = 本次读数不可信，跳过消抖（既不触发也不解除） */
#if CONFIG_NODE_SOS_GPIO >= 0
    if (gpio_get_level(CONFIG_NODE_SOS_GPIO) == 0) raw_pressed = 1;
#endif
#if CONFIG_NODE_SOS_KEY0_ENABLED
    {
        uint8_t in[2] = { 0, 0 };
        int read_ok = (xl9555_read_ports(in) == ESP_OK);
        int key0 = sos_key0_pressed(read_ok, in[1]);
        if (key0 < 0) {
            /* I2C 失败绝不等于“按下”，也不等于“松开”（否则会解除武装/伪造求助）。 */
            raw_known = (CONFIG_NODE_SOS_GPIO >= 0);
            if (s_key0_read_fail < 3) {
                s_key0_read_fail++;
                ESP_LOGW(TAG, "KEY0 读取失败：本次不触发也不解除（求助按键暂不可用）");
            }
        } else {
            s_key0_read_fail = 0;
            if (key0 != s_key0_last_raw) {
                s_key0_last_raw = key0;
                ESP_LOGI(TAG, "KEY0 原始电平变化：%s（XL9555 P1=0x%02X）",
                         key0 ? "按下(低)" : "松开(高)", in[1]);
            }
            if (key0) raw_pressed = 1;
        }
    }
#endif
    if (raw_known) {
        if (sos_update(&s_sos_btn, raw_pressed, CONFIG_NODE_SOS_DEBOUNCE_CONFIRM)) {
#if CONFIG_NODE_SOS_KEY0_ENABLED
            sos_event("厨房设备板载 KEY0 被按下");
#else
            sos_event("SOS 按键被按下");
#endif
        }
        /* 松开 -> 重新武装：ACK 后再次按下仍能发起新的求助；长按期间不会重复触发。 */
        if (!raw_pressed && s_state == 3 && strcmp(s_alarm_type, "MANUAL_SOS") == 0) {
            s_acked_armed = 1;
        }
    }
#endif
    /* 阶段②可见性：只声称“已送出到 Bridge”，不声称云端入库或已处理。 */
    if (s_state == 2 && strcmp(s_alarm_type, "MANUAL_SOS") == 0 && !s_sos_delivery_logged) {
        if (s_gw_sent_count != s_sos_mark) {
            s_sos_delivery_logged = 1;
            ESP_LOGI(TAG, "SOS 上报已送达 Bridge（alarmId=%s）；平台 202/监护人确认另见云端与 APP，"
                          "设备此时仍视作“未确认”并继续本地提示", s_alarm_id);
        } else if (!s_sos_wait_warned && s_sos_pending_since > 0 &&
                   now_ms() - s_sos_pending_since > 15000) {
            s_sos_wait_warned = 1;
            ESP_LOGW(
                TAG,
                "SOS 尚未送达 Bridge（网络/网关不可用）：本地求助已触发并保留，"
                "alarmId=%s 不变，重连后重发同一 ID",
                s_alarm_id);
        }
    }
    /* 短提示音 -> 完整语音编排：只在到点切换蜂鸣器电平/开始语音，非阻塞 */
    announce_tick();
}

/* ---------------- 主流程 ---------------- */
void app_main(void)
{
    // 初始化 NVS（非易失性存储）分区，用于保存配置和状态
    esp_err_t ret = nvs_flash_init();
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES ||
        ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ret = nvs_flash_init();
    }
    ESP_ERROR_CHECK(ret);

    /* 上电随机盐：只在 NTP 未同步时参与告警 ID，保证 ID 跨重启唯一
     * （防止云端按 alarmId 去重吞掉新求助、或旧 ACK 误配本次求助）。 */
    s_boot_salt = (unsigned)esp_random(); // 生成本次启动的随机盐值

    ESP_LOGI(TAG, "ESP32-S3 无线节点启动：%s / %s", CONFIG_NODE_ID, CONFIG_NODE_ROOM);
    monitor_pause_load(); /* 暂停状态跨重启保持 */

    //接线是否正确、PIR/SOS 电平是否变化
    #if CONFIG_NODE_ALARM_BENCH_INJECT
    /* 台架模式通过 UART 注入传感器输入，不启动网络，也不产生云端事件。 */
        ESP_LOGW(TAG,
                 "BENCH INJECT MODE：仅隔离台架验收（gw_port=%d 无活动=%ds "
                 "重复提醒=%ds 温湿度确认=%d/%d）",
                 (int)CONFIG_NODE_GW_PORT, (int)CONFIG_NODE_NO_MOTION_SEC,
                 (int)CONFIG_NODE_ALARM_REPEAT_SEC,
                 (int)CONFIG_NODE_CLIMATE_CONFIRM_COUNT,
                 (int)CONFIG_NODE_CLIMATE_CLEAR_COUNT);
    #endif

    gpio_start(); // 初始化已启用的 GPIO
    local_led_start();   /* 板载 LED 告警指示：上电默认灭，不重放历史告警 */
    sensors_start();     /* 初始化传感器及通信总线 */
    local_voice_start(); /* 语音初始化失败不影响传感器和蜂鸣器 */
    /* 阶段1 自检：AHT20 是否真的读到数（不依赖 WiFi/网关，串口即可验收） */

    //自检
    #if CONFIG_NODE_BOOT_BEEP_MS > 0
    /* 一次性蜂鸣器自检（默认 0，验收后保持 0） */
        buzzer(1);
        vTaskDelay(pdMS_TO_TICKS(CONFIG_NODE_BOOT_BEEP_MS));
        buzzer(0);
        ESP_LOGI(TAG, "蜂鸣器自检：%d ms 短鸣完成，已静音", (int)CONFIG_NODE_BOOT_BEEP_MS);
    #endif
    /* 读取一次温湿度，仅用于启动自检和日志提示。 */
    {
        float t0 = 0.0f, r0 = 0.0f;
        if (climate_read(&t0, &r0) == 0) {
            ESP_LOGI(TAG, "温湿度自检 OK: temp=%.1fC rh=%.1f%%", t0, r0);
        } else {
            ESP_LOGW(TAG, "温湿度自检失败：未接/接线错误/校验失败");
        }
    }

    // 自检
    #if CONFIG_NODE_DHT11_BENCH && CONFIG_NODE_DHT11_GPIO >= 0
    /* DHT11 自检：连续读取五次并记录每次结果。 */
        for (int i = 1; i <= 5; i++) {
            float tb = 0.0f, hb = 0.0f;
            int ok = climate_read(&tb, &hb);
            ESP_LOGI(TAG, "DHT11 bench %d/5: %s temp=%.1fC rh=%.1f%%", i,
                     ok == 0 ? "PASS" : "FAIL", tb, hb);
        }
    #endif
    
    // 初始化无活动计时的起点
    #if CONFIG_NODE_MOTION_GPIO >= 0 // PIR 已启用
        /* PIR 已启用时，以启动时刻作为无活动计时基准。 */
        s_last_motion_ms = now_ms();
    #else
        s_last_motion_ms = 0;
    #endif

    // 本地 GPIO 检查模式 : 本地检测会通过串口日志输出数据，但不会通过 Wi-Fi/网关向外发送状态
    #if CONFIG_NODE_LOCAL_BENCH  // 台架模式：不启动 Wi-Fi 或网关，直接在本地检查 GPIO 输入
        {
            /* 本地 bench 检查实际 GPIO 输入，不启动 Wi-Fi 或网关。 */
            ESP_LOGI(TAG, "LOCAL BENCH: WiFi/网关禁用；PIR GPIO%d SOS GPIO%d",
                     CONFIG_NODE_MOTION_GPIO, CONFIG_NODE_SOS_GPIO);
            #if CONFIG_NODE_MOTION_GPIO >= 0  // PIR GPIO 已配置
                int last_pir = gpio_get_level(CONFIG_NODE_MOTION_GPIO) ? 1 : 0;
                ESP_LOGI(TAG, "LOCAL BENCH: PIR initial raw=%d", last_pir);
            #endif
            #if CONFIG_NODE_SOS_GPIO >= 0 // SOS GPIO 已配置
                int last_sos = gpio_get_level(CONFIG_NODE_SOS_GPIO) ? 1 : 0;
                ESP_LOGI(TAG, "LOCAL BENCH: SOS initial raw=%d", last_sos);
            #endif

            int bench_tick = 0; // 每 100 ms 累计一次，10 次后约 1 秒检查一次 PIR
            for (;;) {
                #if CONFIG_NODE_SOS_GPIO >= 0 // SOS GPIO 已配置
                    int sos = gpio_get_level(CONFIG_NODE_SOS_GPIO) ? 1 : 0;
                    if (sos != last_sos) {
                        ESP_LOGI(TAG, "LOCAL BENCH: SOS raw=%d", sos);
                        last_sos = sos;
                    }
                    sos_handle_fast(); // 处理 SOS 按键消抖和事件
                #endif

                if (++bench_tick >= 10) { // 每秒检查一次 PIR
                    bench_tick = 0; // 重置计数
                    #if CONFIG_NODE_MOTION_GPIO >= 0 // PIR GPIO 已配置
                        int pir = gpio_get_level(CONFIG_NODE_MOTION_GPIO) ? 1 : 0;
                        if (pir != last_pir) {
                            ESP_LOGI(TAG, "LOCAL BENCH: PIR raw=%d", pir);
                            last_pir = pir;
                        }
                        if (pir_update(&s_pir_db, pir, CONFIG_NODE_MOTION_DEBOUNCE_CONFIRM)) { // 消抖确认到活动
                            s_last_motion_ms = now_ms(); // 更新最近活动时间
                            s_motion_count++; // 累计活动次数
                            ESP_LOGI(TAG, "LOCAL BENCH: PIR event（今日第 %d 次）", s_motion_count);
                        }
                    #endif
                }
                vTaskDelay(pdMS_TO_TICKS(100));
            }
        }
    #endif

    // 串口注入告警流程的台架模式：通过 UART0（115200、8N1）输入命令，模拟传感器变化或 SOS，检查告警判定及本地蜂鸣、语音、LED 等反馈，不是单纯检查真实 GPIO 电平
    // 它不会启动 Wi-Fi、网关或 NTP，因此不会向外发送状态；日志仍可从串口查看。默认传感器仍读真实输入，只有发送对应 inj 命令后，相关输入才会被模拟
    #if CONFIG_NODE_ALARM_BENCH_INJECT 
        #if CONFIG_NODE_VOICE_ENABLED  // UART 任务负责收命令，命令队列把命令交给主循环执行；上报队列保留了正式流程的上报入口，但台架没有网络任务消费它。
        // CONFIG_NODE_VOICE_ENABLED 是“启用本地语音播报”的构建选项。开启后，设备可以通过 ES8388 和扬声器播放预录的中文提示音/语音；这里只播放，不录音，也不依赖网络播放。
        //不只是“检测硬件是否反馈”：它会继续采集已启用的真实传感器，也允许用 inj 命令模拟部分输入，再观察告警逻辑和本地蜂鸣、语音、LED 是否按预期响应。
            s_reports = xQueueCreate(1, sizeof(report_message_t)); // 创建上报队列，长度为 1
            s_commands = xQueueCreate(4, sizeof(command_message_t)); // 创建命令队列，长度为 4
            if (!s_reports || !s_commands) { // 队列创建失败
                ESP_LOGE(TAG, "BENCH: 队列创建失败，台架命令不可用");
            } else if (xTaskCreate(serial_command_task, "bench-uart", 4096, NULL, 3,
                                   NULL) != pdPASS) { // 创建 UART 命令任务失败
                ESP_LOGE(TAG, "BENCH: UART 命令任务创建失败"); 
            }
        #endif
    #else
        wifi_start(); // 初始化 Wi-Fi 并连接网关
        time_sync_start(); // 启动 NTP 时间同步
        #if CONFIG_NODE_VOICE_ENABLED // 语音构建才有命令队列，非语音构建直接在主循环里处理网关命令。
            s_reports = xQueueCreate(1, sizeof(report_message_t)); // 创建上报队列，长度为 1
            s_commands = xQueueCreate(4, sizeof(command_message_t)); // 创建命令队列，长度为 4
            if (!s_reports || !s_commands ||
                xTaskCreate(gateway_task, "gateway-net", 6144, NULL, 3, NULL) != pdPASS) { // 创建网关任务失败
                ESP_LOGE(TAG, "network worker unavailable; local sensing/voice remain active");
            }
            speaker_link_start(); // AI 回答音箱：独立连接语音网关 9102
            mic_link_start();     // 板载咪头：按需连接语音网关 9303（不常开）
            /* 现场固件的串口命令通道：mictest / micupload，供 COM9/COM6 直接验收。 */
            if (!s_commands ||
                xTaskCreate(serial_command_task, "serial-cmd", 4096, NULL, 3, NULL) != pdPASS) {
                ESP_LOGE(TAG, "串口命令任务不可用（mictest 需重启后检查内存）");
            }
        #endif
    #endif /* CONFIG_NODE_ALARM_BENCH_INJECT */

    int counter = 0; // 上报计数器，每 100 ms 累计一次，到达 CONFIG_NODE_REPORT_SEC 秒时触发上报
    int sensor_tick = 0; // 传感器采样计数器，每 100 ms 累计一次，到达 1 秒时触发采样和判定
    for (;;) {
        #if !CONFIG_NODE_VOICE_ENABLED
        /* 非语音构建由主循环负责等待 Wi-Fi 并连接网关。 */
            if ((xEventGroupGetBits(s_wifi_events) & WIFI_CONNECTED_BIT) == 0) {
                vTaskDelay(pdMS_TO_TICKS(500));
                continue;
            }
            /* 维持到网关的连接 */
            if (s_sock < 0) {
                s_sock = gw_connect();
                if (s_sock < 0) {
                    vTaskDelay(pdMS_TO_TICKS(3000));
                    continue;
                }
            }
        #endif
        /* NTP 同步完成标记 —— 同步后钟表会跳变，必须重置"最近活动"基准，
           否则 idle 会被算成几十年，立刻误报"长时间无活动" */
        if (!s_time_synced) {
            time_t now = 0;
            time(&now);
            if (now > 1700000000) { /* 2023 年之后说明已同步 */
                s_time_synced = 1;
                /* 只重置无活动计时，不影响其它告警状态。 */
                if (ntp_reset_motion_baseline(CONFIG_NODE_MOTION_GPIO >= 0)) {
                    s_last_motion_ms = now_ms();
                }
                ESP_LOGI(TAG, "时间已同步（不改动环境告警状态）");
            }
        }

        /* SOS 快路径：100 ms 轮询，按键响应约 200 ms */
        sos_handle_fast();
#if CONFIG_NODE_VOICE_ENABLED && CONFIG_NODE_BUZZER_XL9555
        ai_key_handle();
#endif

        /* 传感器采样与判定：1 秒一次 */
        if (++sensor_tick >= 10) {
            sensor_tick = 0;
            sample(); // 采样传感器数据
            judge(); // 判定当前状态（NORMAL/ALARM/ACKED）
        }
        /* 持续异常按配置限频提醒；用户停止或 ACK 后不重复。 */
        alarm_reminder_tick();
        /* LED 与告警状态机联动；停止声音不会清除告警灯效。 */
        local_led_tick(s_state, s_alarm_type, active_danger() != NULL);
        #if CONFIG_NODE_VOICE_ENABLED
            command_message_t command;
            /* 每轮最多处理四条命令，避免命令队列长期占用主循环。 */
            for (int i = 0; s_commands && i < 4 && xQueueReceive(s_commands, &command, 0) == pdTRUE; i++)
                handle_command(command.text);
        #else
            gw_poll();
        #endif

        /* 上报：CONFIG_NODE_REPORT_SEC 秒（按 100 ms tick 计） */
        if (++counter >= CONFIG_NODE_REPORT_SEC * 10) {
            counter = 0;
            report();
        }
        vTaskDelay(pdMS_TO_TICKS(100));
    }
}
