/* 独居老人居家安全监护系统 · ESP32-S3 无线传感节点
 *
 * 厨房、卫生间、客厅三块板子烧的是同一套代码，房间差异全部来自 sdkconfig。
 * 节点不做 MQTT：把和主控 homemon 相同的 JSON 行用 TCP 推给 PC 上的 bridge
 * （mqtt_bridge.js --listen），APP 和云端不用为节点改协议。
 *
 * 这个文件只留三件事：告警状态机、采样调度、命令执行。
 * 具体硬件和链路拆在同目录的几个模块里：
 *   board_io.c     XL9555 / 蜂鸣器 / KEY0 / KEY1
 *   wifi_link.c    Wi-Fi + SNTP
 *   climate.c      AHT20 / DHT11
 *   door_monitor.c 门磁去抖、事件序号、NVS 补传
 *   announce.c     提示音 -> 语音
 *   gw_link.c      网关 TCP 收发与命令入口
 *
 * 配置：idf.py menuconfig → "居家安全监护 · ESP32-S3 无线节点"
 */
#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
#include <math.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "nvs_flash.h"
#include "nvs.h"
#include "driver/gpio.h"
#include "esp_random.h"
#include "esp_adc/adc_oneshot.h"
#if CONFIG_NODE_ALARM_BENCH_INJECT
#include "esp_system.h"
#endif
#include "alarm_logic.h"    /* 与硬件无关的判定逻辑，主机侧可测 */
#include "notice_logic.h"   /* 跨房间定向播报判定 */
#include "battery_logic.h"  /* 电压换算 / 有效性 / 百分比 */

/* Kconfig 的 bool 在 =n 时根本不生成宏。这里折成 0/1，后面才能直接当数值用 */
#ifdef CONFIG_NODE_BATTERY_CALIBRATED
#define NODE_BATTERY_CALIBRATED 1
#else
#define NODE_BATTERY_CALIBRATED 0
#endif

#include "local_voice.h"  /* 本地 I2S 语音 */
#include "speaker_link.h" /* 网络音箱 */
#include "mic_link.h"     /* 咪头 PCM 上传 */
#include "local_led.h"    /* 告警灯 */
#include "voice_pins.h"   /* 语音引脚冲突的编译期检查 */
#include "node_common.h"
#include "board_io.h"
#include "wifi_link.h"
#include "climate.h"
#include "door_monitor.h"
#include "announce.h"
#include "gw_link.h"

#if CONFIG_NODE_ALARM_BENCH_INJECT && !CONFIG_NODE_VOICE_ENABLED
#error "台架注入要靠语音构建里的命令队列，请同时打开 CONFIG_NODE_VOICE_ENABLED"
#endif

/* report() 的栈上 JSON 缓冲。实测带 battery 段最长 1.4 KB 左右，留 1600 字节；
 * 和 gw_link.c 的 mailbox 上限保持一致，否则长报文会在发送前被截断。 */
#define REPORT_JSON_MAX 1600

/* 电池只能接 ADC1，且不能和 MQ-2/MQ-5 共用一个通道；分压上小下大的参数写反了
 * 也算配置错误。宁可编译不过，也别把错参数烧到板子上。 */
#if CONFIG_NODE_BATTERY_ADC_CHANNEL > 9 || \
    (CONFIG_NODE_BATTERY_ADC_CHANNEL >= 0 && \
     (CONFIG_NODE_BATTERY_ADC_CHANNEL == CONFIG_NODE_MQ2_ADC_CHANNEL || \
      CONFIG_NODE_BATTERY_ADC_CHANNEL == CONFIG_NODE_MQ5_ADC_CHANNEL || \
      CONFIG_NODE_BATTERY_MIN_MV > CONFIG_NODE_BATTERY_MAX_MV))
#error "电池采样配置非法：仅 ADC1_CH0..CH9、不得与 MQ 共用通道、MIN_MV 必须 <= MAX_MV"
#endif

/* ---- 运行时状态 ---- */
/* SOS 分三阶段，设备只说自己知道的那部分：
 *   正在发送：本地已触发，声光反馈已给出；
 *   已送达 Bridge：一条带本次 alarmId 的状态报文经 TCP 完整写出（不等于云端入库）；
 *   监护人已确认：只有收到 `ack <alarmId>` 且 ID 精确匹配才算（见 handle_command）。
 * 平台 202 / APP 确认在 PC 与云侧核对，设备不再播“已受理/已处理”。 */
static uint32_t s_sos_mark = 0;                 /* 本次求助触发时的发送计数基线 */
static int64_t  s_sos_pending_since = 0;        /* 本次求助进入“正在发送”的时刻 */
static int      s_sos_delivery_logged = 0;      /* 是否已记录“已送达 Bridge” */
static int      s_sos_wait_warned = 0;          /* 是否已记录“尚未送达”一次性警告 */
static unsigned s_boot_salt = 0;                /* 上电随机盐：时钟未同步时保证 alarmId 跨重启唯一 */

/* 传感器状态只由主任务写；网络任务只碰 socket 和邮箱，不碰这里 */
static int64_t s_last_motion_ms = 0;            /* 最近一次人体活动（本地毫秒） */
static int   s_motion_count   = 0;              /* 今日活动次数 */


static int   s_state          = 0;              /* 0=NORMAL 1=WARN 2=ALARM 3=ACKED */
/* ACKED 后只有“被确认的那种危险”消失过（重新武装），同种危险再出现才允许新告警，
 * 免得 ACK 一次就永久屏蔽该房间的真实危险。 */
static int   s_acked_armed    = 0;
static int   s_alarm_seq      = 0;
static char  s_alarm_id[40]   = "";

/* mic_link.c 取当前活动告警 ID；无告警返回空串。 */
const char *node_current_alarm_id(void) { return s_alarm_id; }
static char  s_alarm_type[24] = "";
/* 跨房间定向播报：其他设备的求助由 PC 侧 bridge 用受控路由逐台投递到本板，本板只
 * 播报同一事件，不生成告警、不新建 ID、不改 s_state/s_alarm_id/s_alarm_type，也不
 * report()，所以 APP 上仍只有原始来源那一条，不会伪造 MANUAL_SOS。
 * 判定都在 notice_logic.h（host_notice_logic_test.c 已单测），这里只留状态与 I/O。 */
static notice_state_t s_notice;
/* 本地告警闭环状态：
 *  - s_user_stopped：用户明确停掉本轮声音，保留 ALARM 状态和告警 ID，但不再重复提醒，
 *    同一持续事件的下一条数据也不得立即重新拉响；
 *  - s_last_remind_ms：限频基准，持续异常期间最多每 NODE_ALARM_REPEAT_SEC 一次；
 *  - s_pir_armed：本次启动确认过至少一次有效 PIR 活动，防断线常低误报无活动；
 *  - s_monitor_paused：只抑制“长时间无活动”，不抑制 SOS/环境告警；写 NVS，
 *    重启保持，不自动反向恢复。 */
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
/* 这两个标志必须无条件声明：report() 的 valid 字段无条件引用它们，而 MQ 通道在
 * 卫生间/其它节点可能是 -1（编译期禁用）。 */
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
/* 电池采样状态。固定供电节点（CHANNEL=-1）不编译这些状态，
 * report() 也就不输出 battery 字段，绝不给“无电池设备”编造电量。 */
static battery_config_t s_batt_cfg;                    /* Kconfig 换算/校准参数 */
static battery_result_t s_batt;                        /* 最近一次判定结果 */
static int  s_batt_tick = 0;                           /* 采样节拍（sample() 每秒一次） */
static int  s_batt_sample_count = 0;                   /* 已完成的采样窗数量（日志节流） */
#endif
#if CONFIG_NODE_MQ2_ADC_CHANNEL >= 0 || CONFIG_NODE_MQ5_ADC_CHANNEL >= 0 || CONFIG_NODE_BATTERY_ADC_CHANNEL >= 0
static adc_oneshot_unit_handle_t s_adc = NULL;
#endif

/* 把内部告警状态（0..3）翻成上报 JSON 和日志里用的字符串。
 * 上报协议里的 state 字段只认这四个值，APP 和云端按键值展示，
 * 不要在这里加新状态，否则三端要一起改。 */
static const char *state_name(int st)
{
    switch (st) {
        case 1: return "WARN";
        case 2: return "ALARM";
        case 3: return "ACKED";
        default: return "NORMAL";
    }
}

/* 前向声明：命令处理/SOS 快路径在 raise_alarm、report 定义之前使用 */
static void raise_alarm(const char *type, const char *detail);
#if CONFIG_NODE_BATTERY_ADC_CHANNEL >= 0
/* ---- 电池电压采样 ----
 * 每 NODE_BATTERY_SAMPLE_SEC（默认 30s）一个采样窗，窗内连读 8 次 raw，样本间隔 2ms，
 * 免得 8 次都落在同一个瞬时毛刺上；8 个样本交给 battery_logic 做中位数、极差、
 * 中位数邻域一致率和物理范围判定，任一门限不过就输出 valid=false 加短码 reason
 * （UNSTABLE/OUT_OF_RANGE/...）。Wi-Fi 发射窗口内的毛刺按 UNSTABLE 丢弃，绝不猜一个
 * 看起来合理的电压。全部在主任务里顺序执行，不新建任务、不在中断里读 ADC。 */
static void battery_sample(void)
{
    int raws[BATTERY_SAMPLE_COUNT];
    int n = 0;
    int read_ok = 0;

    /* 连续读 8 次，每次间隔 2ms：
     *   - 8 个点交给 battery_logic 取中位数，单个 Wi-Fi 毛刺不会把电压拉低；
     *   - 读失败的点直接跳过，但 read_ok 保持 0 表示“整窗没有可信样本”，
     *     最终会输出 READ_FAIL，而不是拿残留的 1、2 个点猜电量。 */
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
    /* 前两次、每 20 个采样窗（约 10 分钟）以及有效性翻转时打印，便于真机验收 */
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

/* 电池采样节拍器。
 * sample() 每秒调用一次，这里只累加计数；攒够 CONFIG_NODE_BATTERY_SAMPLE_SEC
 * （默认 30 秒）才真正读一次 ADC。这样不会因为主循环 100ms 的节奏把 ADC 读爆，
 * 也不会让电池采样和 MQ 采样在同一毫秒抢 ADC 单元。
 * 注意：真正的 8 连读在 battery_sample() 里同步完成，约 16ms，可接受。 */
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

/* 监护暂停状态持久化：用户暂停后，重启/断电都不得自动恢复无活动提醒。只存一个
 * 布尔键，读写失败时保持进程内状态并打印警告，不阻塞启动。 */
#define NODE_NVS_PAUSED  "mon_paused"

/* 从 NVS 读回“监护是否暂停”。
 * 用只读方式打开命名空间：首次上电还没有这个命名空间属于正常情况，
 * 读不到就保持默认的 ACTIVE，不报错、不阻塞启动。
 * 暂停只影响“长时间无活动”提醒，不影响 SOS 和环境告警。 */
static void monitor_pause_load(void)
{
    nvs_handle_t h;
    uint8_t v = 0;
    if (nvs_open(NODE_NVS_NS, NVS_READONLY, &h) != ESP_OK) return;   /* 首次启动无命名空间 */
    if (nvs_get_u8(h, NODE_NVS_PAUSED, &v) == ESP_OK) s_monitor_paused = v ? 1 : 0;
    nvs_close(h);
    ESP_LOGI(TAG, "监护暂停状态(持久化)=%s", s_monitor_paused ? "PAUSED" : "ACTIVE");
}

/* 把“监护暂停”写进 NVS，保证重启/断电后仍保持暂停。
 * nvs_set_u8 之后必须 nvs_commit，否则掉电可能丢写入。
 * 写失败只打警告：本次运行仍按内存里的状态生效，只是重启后可能恢复监护。 */
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

/* 初始化 ADC1 单次采样单元，并按启用情况注册通道。
 *
 * 为什么统一用 ADC1：
 *   ESP32-S3 的 ADC2 和 Wi-Fi 共用硬件，联网后读数会失败或漂移；
 *   MQ-2、MQ-5、电池分压都只能接 ADC1。
 *   MQ 与电池可以共用一个 oneshot 单元的不同通道；
 *   通道冲突（例如把电池配成和 MQ 同一个通道）在文件开头用 #error 拦掉。
 *
 * 衰减固定 12 dB、位宽 12 bit：
 *   引脚可测到约 3.1V，0..4095 对应 0..3100mV 左右。
 *   电池经过 2:1 分压后才接进来，所以 4.2V 电池在引脚上约 2.1V，仍在量程内。
 *
 * 本函数只在启动时调用一次；采样在主任务里同步读，不建任务、不进中断。 */
static void adc_start(void)
{
#if CONFIG_NODE_MQ2_ADC_CHANNEL >= 0 || CONFIG_NODE_MQ5_ADC_CHANNEL >= 0 || CONFIG_NODE_BATTERY_ADC_CHANNEL >= 0
#if CONFIG_NODE_BATTERY_ADC_CHANNEL >= 0
    /* 电池换算参数来自 Kconfig */
    battery_config_default(&s_batt_cfg);
    s_batt_cfg.divider_num = CONFIG_NODE_BATTERY_DIVIDER_NUM;
    s_batt_cfg.divider_den = CONFIG_NODE_BATTERY_DIVIDER_DEN;
    s_batt_cfg.gain_permille = CONFIG_NODE_BATTERY_CAL_GAIN_PERMILLE;
    s_batt_cfg.offset_mv = CONFIG_NODE_BATTERY_CAL_OFFSET_MV;
    s_batt_cfg.low_mv = CONFIG_NODE_BATTERY_LOW_MV;
    s_batt_cfg.min_mv = CONFIG_NODE_BATTERY_MIN_MV;
    s_batt_cfg.max_mv = CONFIG_NODE_BATTERY_MAX_MV;
    s_batt_cfg.calibrated = NODE_BATTERY_CALIBRATED ? 1 : 0;
    /* 初始状态：还没采样 -> valid=false + NO_ADC，不预置任何电压/百分比 */
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

/* SOS 是离散事件：同一持续告警期间不叠播、不新建 ID；用户停声后再按只恢复提醒。
 * ACK 之后（或危险类型不同）按下才按普通新告警处理。 */
#if CONFIG_NODE_SOS_GPIO >= 0 || CONFIG_NODE_SOS_KEY0_ENABLED || CONFIG_NODE_ALARM_BENCH_INJECT
static void sos_event(const char *detail)
{
    if (s_state == 2 && strcmp(s_alarm_type, "MANUAL_SOS") == 0) {
        if (s_user_stopped) {
            s_user_stopped = 0;
            s_last_remind_ms = node_now_ms();
            announce_start(VOICE_CLIP_SOS);
            ESP_LOGW(TAG, "SOS 再次按下（停止后恢复提醒，不新建告警）id=%s", s_alarm_id);
        } else {
            ESP_LOGI(TAG, "重复 SOS 已抑制：同一告警持续中，不叠播、不新建 ID（id=%s）", s_alarm_id);
        }
        return;
    }
    /* 阶段①：本地已触发。设备只声称“正在发送”，不播“已受理/已处理”之类会误导
     * 的语音；只有收到匹配 alarmId 的回执才转 ACKED。 */
    ESP_LOGW(TAG, "SOS 本地已触发：%s（来源设备=%s / 房间=%s，厨房设备实体按键）；"
                  "状态=正在发送，尚未收到监护人确认", detail, CONFIG_NODE_ID, CONFIG_NODE_ROOM);
    raise_alarm("MANUAL_SOS", detail);
    report();
}
#endif /* CONFIG_NODE_SOS_GPIO >= 0 || CONFIG_NODE_SOS_KEY0_ENABLED || CONFIG_NODE_ALARM_BENCH_INJECT */

/* ---- 跨房间定向播报：notice / noticeack ----
 * 只播报别人已经产生的那个求助事件，本板不建告警、不新建 ID、不产生新的 MANUAL_SOS，
 * 也不改本板上报的 state/alarm 字段，所以 APP 里不会多出一条。
 * 本地告警（s_state==ALARM）优先：本板自己在响时拒绝外来播报，不抢声音。
 * 同一 alarmId 只播一次；noticeack 过的同一 ID 再来也不重播，重试/长按/抖动/断线
 * 重连都不会反复拉响。ACK 只代表监护人已确认，不代表求助者已安全。 */
/* 从字符串里取下一个以空白分隔的 token。
 *
 * 用法：网关命令都是 “notice <alarmId> <source>” 这种空格分隔格式。
 * 参数：
 *   rest   - 当前读取位置，函数会跳过前导空格/制表符
 *   out    - 输出缓冲
 *   out_sz - 缓冲大小
 * 返回实际写入的字符数（不含 '\0'）；没取到内容时返回 0。
 * 超长 token 会被截断到 out_sz-1，保证不会越界；截断后 ID 校验会失败，
 * 调用方会拒绝该命令，而不是拿半截 ID 去播报。
 * 注意：这里只按空格/制表符/回车/换行切分，不处理引号。 */
static size_t next_token(const char *rest, char *out, size_t out_sz)
{
    while (*rest == ' ' || *rest == '\t') rest++;
    size_t n = strcspn(rest, " \t\r\n");
    if (n >= out_sz) n = out_sz - 1;
    memcpy(out, rest, n);
    out[n] = '\0';
    return n;
}

/* 本地告警接管：停掉外来播报，但把它记成“已结束的 ID”，免得之后被重播。
 * 不碰本地告警状态。 */
static void notice_yield_local(void)
{
    char interrupted[NOTICE_ID_MAX];
    snprintf(interrupted, sizeof(interrupted), "%s", s_notice.active_id);
    if (!notice_yield(&s_notice)) return;
    ESP_LOGW(TAG, "本地告警接管：停止外部求助播报（外部 alarmId=%s 仍未确认，仍需人工处理）",
             interrupted);
}

/* 处理 “notice <alarmId> <sourceDeviceId>” 命令：替别的房间播报求助。
 *
 * 流程：
 *   1. 解析两个 token，缺一个就拒绝（不猜来源）；
 *   2. 交给 notice_begin() 做去重/本地优先判定；
 *   3. 只有 NOTICE_BEGIN_PLAY 才真正出声。
 *
 * 约束：
 *   - 不改 s_state / s_alarm_id / s_alarm_type，也不调用 report()；
 *   - 不生成新 alarmId，APP 上仍只有原始来源那一条；
 *   - 本板本地告警期间直接拒绝，本地声音优先；
 *   - 同一 alarmId 只播一次，重试/重连/抖动都不会反复拉响。 */
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

/* 处理 “noticeack <alarmId>” 命令：监护人已在 APP 确认某条外部求助。
 *
 * 与本地 ack 的区别：
 *   - 只停止本板对这条外部求助的播报；
 *   - 不改本板 state，不改本板 alarmId，不写 NVS；
 *   - 必须 alarmId 精确匹配正在播的那条，否则拒绝，避免误停别的播报。
 *
 * 停止后 notice_end() 会把 ID 记进 last_id，同一条再来也不会重播。
 * 日志里特意说明“确认不等于求助者已安全”，避免现场误解。 */
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

/* 所有命令的唯一入口：网关下发的行、串口输入的行，最终都到这里。
 *
 * 为什么集中在一个函数：
 *   命令会改告警状态、NVS、声音；如果让网络任务直接改，多线程同时动 s_state
 *   会出竞态。所以网络任务只把命令行投进队列，由主任务在这里顺序执行。
 *
 * 支持的命令（区分大小写，参数用空格分隔）：
 *   ack <alarmId> [说明]     监护人确认本地告警；仅 ALARM 且 ID 精确匹配才生效
 *   notice <alarmId> <src>   替其他设备播报求助；去重、本地告警优先
 *   noticeack <alarmId>      确认外部求助，停止本板播报
 *   stop                     停止本轮声音，保留 ALARM 和 alarmId
 *   pause / resume           暂停/恢复监护（仅影响无活动提醒，写 NVS）
 *   mictest [1..5]           板载咪头自检，打印 RMS/峰值
 *   beep on|off              蜂鸣器自检，不改告警状态
 *   healthtest               本地播健康建议 clip=9
 *   speaktest                本地播放提示语音，绕过网络
 *   pcmtest                  本地生成 1 秒方波，测 PCM 播放通路
 *   micupload                手动触发一次录音上传
 *   reset                    强制回 NORMAL（不解除监护暂停）
 *   inj ...                  仅台架固件：注入传感器值/SOS/LED 演示
 *
 * 未知命令只记日志、不执行，避免拼错一个字母就悄悄改了状态。 */
static void handle_command(const char *line)
{
    while (*line == ' ') line++;
    /* 收到什么先照原样记一条，再看接不接受/生不生效 */
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
        /* noticeack <alarmId>：监护人已在 APP 确认这条外部求助，停掉本板播报。
         * 和 ack 不同：它不接受本地告警、不改 state、不写告警 ID。 */
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
        /* pause：持久化暂停，只抑制“长时间无活动”。
         * 如果当前正因为 NO_MOTION 告警，立即解除该告警并停声；
         * SOS、燃气、烟雾、温湿度、水漏都不受 pause 影响。 */
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
        /* 板载咪头自检（现场固件也可用）：串口输 mictest [1..5]，采完打印
         * MIC_TEST rms/peak，结束后自动恢复播放通路。 */
        int sec = line[7] == ' ' ? atoi(line + 8) : 3;
        ESP_LOGW(TAG, "MIC_TEST 开始：%d 秒（安静/说话各测一次，比较 RMS 与峰值）", sec);
        local_voice_mic_test(sec);
    } else if (strncmp(line, "beep", 4) == 0 &&
               (line[4] == '\0' || line[4] == ' ' || line[4] == '\r')) {
        /* 仅自检：在咪头旁造一个近场声源，不改告警状态 */
        const char *arg = line + 4;
        while (*arg == ' ') arg++;
        bool on = (strncmp(arg, "on", 2) == 0);
        board_buzzer(on ? 1 : 0);
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
        /* 本地造 1 秒 400Hz 方波，走和网络 PCM 同一个播放函数，不经过网关 */
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
#if CONFIG_NODE_VOICE_ENABLED
        /* 手动触发一次“录音→上传 9303→ASR”，用于端到端验收，不改告警状态 */
        if (mic_link_trigger("cmd")) {
            ESP_LOGW(TAG, "MIC_UPLOAD 已排队：录音 %d 秒后上传 %s:%d",
                     (int)CONFIG_NODE_MIC_RECORD_SEC, CONFIG_NODE_GW_HOST,
                     (int)CONFIG_NODE_MIC_PORT);
        } else {
            ESP_LOGE(TAG, "MIC_UPLOAD 未启动：采音链路不可用（语音未启用或任务创建失败）");
        }
#else
        /* 语音关闭的构建（如 living）没有 MIC_* 配置项，直接提示，避免引用未定义宏 */
        ESP_LOGW(TAG, "MIC_UPLOAD 未启用：本节点语音关闭（CONFIG_NODE_VOICE_ENABLED=n）");
#endif
    } else if (strncmp(line, "reset", 5) == 0) {
        /* 强制复位：清告警状态、ID、声音和外部播报的 active。
         * 不动 last_id：如果那条外部求助还在持续，reset 之后允许再播一次。
         * 也不动 s_monitor_paused：暂停监护必须由 resume 显式恢复。 */
        s_state = 0;
        s_acked_armed = 0;
        s_user_stopped = 0;
        s_sos_pending_since = 0;
        s_alarm_id[0] = '\0';
        s_alarm_type[0] = '\0';
        /* reset 只清 active，不动 last_id：同一外部事件若还在持续，重置后允许再播一次 */
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
            s_last_motion_ms = node_now_ms();
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
            /* 台架试听：直接播某个片段，不产生云端事件、不改告警状态。
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

/* ---- 采集与判定 ---- */

/* 读一轮所有传感器，更新全局状态；本身不判断“要不要告警”（那是 judge() 的事）。
 *
 * 执行顺序（重要）：
 *   1. PIR：连续确认后更新 lastActiveTs / countToday；
 *   2. 水漏：数字量，连续确认后更新 s_water_ok；
 *   3. 门磁：交给 door_monitor_poll() 做去抖/事件缓存；
 *   4. 温湿度：读 AHT20/DHT11，失败时 valid=false 并保持上次有效判定；
 *   5. MQ-2 / MQ-5：读 ADC，交给 mq_stab_update() 做连续确认+回差；
 *   6. 电池：按 30 秒节流采样（放在最后，避开其它 ADC 通道）。
 *
 * 所有 #if 都是按 Kconfig 编译期裁剪：没接的传感器完全不编译对应代码，
 * 也不会读对应 GPIO/ADC。
 *
 * 采样周期约 1 秒，由 app_main 的主循环控制；AHT20 单次读取约 90ms，
 * DHT11 约 1.2s，所以这函数会阻塞主循环，但不会阻塞网络任务。 */
static void sample(void)
{
#if CONFIG_NODE_MOTION_GPIO >= 0
        /* 连续确认后才算活动；只在确认上升沿更新 lastActiveTs/countToday，不产生告警 */
    {
        int pir_raw;
#if CONFIG_NODE_ALARM_BENCH_INJECT
        pir_raw = (s_inj_pir >= 0) ? s_inj_pir : (gpio_get_level(CONFIG_NODE_MOTION_GPIO) ? 1 : 0);
#else
        pir_raw = gpio_get_level(CONFIG_NODE_MOTION_GPIO) ? 1 : 0;
#endif
        if (pir_update(&s_pir_db, pir_raw, CONFIG_NODE_MOTION_DEBOUNCE_CONFIRM)) {
            s_last_motion_ms = node_now_ms();
            s_motion_count++;
            s_pir_armed = 1;   /* 本次启动已确认到有效 PIR 活动，此后才允许“无活动”判定 */
            ESP_LOGI(TAG, "检测到活动（今日第 %d 次）", s_motion_count);
        }
    }
#endif
#if CONFIG_NODE_WATER_GPIO >= 0
    {
        /* 水漏模块输出的是数字量：
         *   ACTIVE_LOW 时湿=0，否则湿=1；
         *   连续 N 次确认由 water_update 负责，单次打湿不报警。 */
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
#if CONFIG_NODE_ALARM_BENCH_INJECT
    door_monitor_poll(s_time_synced, s_inj_door);
#else
    door_monitor_poll(s_time_synced, -1);
#endif
#endif

    /* 温湿度：先拿到一次读数，再做“物理范围”检查。
     * 检查通过才算 valid=1，并交给 climate_stab_update 做连续确认+回差；
     * 失败时 valid=0，不参与触发也不参与解除，保持上一次有效判定。 */
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
    /* MQ-2 对应烟雾/可燃气体（上报字段 smoke）。
     * 每次先假定无效，只有 ADC 读成功才置 valid=1；
     * 读失败时 mq_stab_update 会保持上一次判定，不会误报也不会误解除。 */
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
    /* MQ-5 对应燃气（上报字段 gas），逻辑与 MQ-2 相同，但状态完全独立：
     * 两个通道各自计数、各自回差，互不影响。 */
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
    /* 电池采样按 NODE_BATTERY_SAMPLE_SEC（默认 30s）节流，和 MQ 共用同一个 ADC1
     * 单元；放在 sample() 末尾，避开 Wi-Fi 初始化/网关收发的时刻。 */
    battery_tick();
#endif
}

/* 同一危险持续存在时不重复生成新 ID（避免告警风暴、每秒刷新 alarmId）。
 * ACKED 只屏蔽“已被确认的那一种危险”：出现另一种危险、或同种危险消失后再出现，
 * 都照常报警，否则 ACK 就成了永久屏蔽真实危险的开关。 */
static int voice_clip_for_alarm(const char *type);   /* 定义见下 */

#if CONFIG_NODE_MIC_UPLOAD
/* 告警语音播完后，先播“如果您没事，请说没事”，再开 4 秒麦。
 * 固定延时只针对本机喇叭，不依赖网络；失败照样尝试上传并在串口报错。 */
/* 告警后的“如果您没事，请说没事”任务。
 *
 * 为什么要单独建任务：
 *   这段流程要等 4.5 秒 + 3.3 秒，不能放在主循环里阻塞采样和上报。
 * 时间点：
 *   - 4.5s：等本地告警语音（SOS/温湿度/无活动）播完；
 *   - 3.3s：等“请说没事”提示本身播完，再开麦，避免录到提示词。
 * 这些是固定延时，只针对本机喇叭，不依赖网络。
 * 即使 mic_link_trigger() 失败，也只打日志，不影响告警状态。
 * 任务跑完自己删除，不会常驻。 */
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

/* 新建一条本地告警并立即出声。
 *
 * 参数：
 *   type   - 告警类型，必须是 danger_priority() 认识的字符串之一
 *   detail - 只用于日志的中文描述
 *
 * 副作用：
 *   - 停掉正在播的外部求助（本地优先）；
 *   - 生成新的 alarmId；
 *   - 状态置 ALARM，清“用户已停声”，重置送达基线和提醒计时；
 *   - 启动“短提示音 -> 语音”，必要时再起提示录音任务。
 *
 * 是否会真正新建由 alarm_raise_allowed() 决定：
 *   同一 ALARM/未重新武装的 ACKED 同类型危险不会重复建 ID。
 * 调用方（judge/sos_event）已经做过优先级判断。 */
static void raise_alarm(const char *type, const char *detail)
{
    /* 判定逻辑都在 alarm_logic.h（主机侧已单测） */
    if (!alarm_raise_allowed(s_state, s_alarm_type, s_acked_armed, type)) return;
    notice_yield_local();   /* 本板告警优先：先停外来播报，再拉响本地告警 */
    s_alarm_seq++;          /* 同一启动周期内递增，配合时间/盐保证 ID 唯一 */
    /* 跨重启唯一：NTP 未同步时掺上电随机盐，免得 “e-0-N” 撞号被云端去重吞掉新求助，
     * 或上一轮的旧 ACK 被当成本次确认（见 alarm_logic.h）。 */
    alarm_id_build(s_alarm_id, sizeof(s_alarm_id), (long long)time(NULL), s_boot_salt, s_alarm_seq);
    snprintf(s_alarm_type, sizeof(s_alarm_type), "%s", type);
    s_state = 2;
    s_acked_armed = 0;
    s_user_stopped = 0;              /* 新告警：清除上一轮的“停止”标记 */
    s_last_remind_ms = node_now_ms();     /* 新告警立即播放，并作为限频提醒基准 */
    s_sos_mark = gw_sent_count();    /* 本次事件的“已送达”基线 */
    s_sos_pending_since = (strcmp(type, "MANUAL_SOS") == 0) ? node_now_ms() : 0;
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

/* 文案必须对上真实触发原因：温度、湿度、两者分别播，读数无效时才用兜底文案。
 * 厨房/卫生间当前能触发的只有 MANUAL_SOS / CLIMATE / NO_MOTION；GAS/SMOKE 阈值
 * 4096（禁用）、WATER GPIO -1（未接），不会告警。将来启用要另加文案，不能拿
 * 温湿度文案冒充。 */
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

/* 当前最高优先级的危险：SOS 走事件路径，这里按 GAS > SMOKE > WATER > CLIMATE >
 * NO_MOTION 排，无危险返回 NULL。只留这一个优先级函数，保证同一时刻只对外呈现
 * 一个告警，ACK 过低优先级告警也盖不住随后出现的更高优先级危险。 */
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
    /* 用“上一次有效判定”的持久结果：读取失效既不清除已确认的环境告警，
     * 也不新造告警，JSON 里 valid=false 如实告诉下游。 */
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
            node_now_ms() - s_last_motion_ms >= (int64_t)CONFIG_NODE_NO_MOTION_SEC * 1000) {
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

/* 状态机：
 *   NORMAL/ALARM + 出现最高优先级危险 -> ALARM，新建 alarmId 并响铃；
 *   同一危险持续 -> 不产生新 ID；出现更高优先级危险 -> 升级成新告警（新 ID）；
 *   NO_MOTION 且活动恢复 -> 自动回 NORMAL（保持既有行为）；
 *   ACK 且 ID 精确匹配 -> ACKED，之后同种危险持续保持 ACKED、不响铃不新建 ID，
 *   该危险先消失再出现则重新武装后再次报警，出现另一种危险则立即新告警；
 *   reset -> NORMAL。
 * GAS / SMOKE / CLIMATE 必须 ACK 或 reset 才回 NORMAL，不自动清除。 */
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
        /* 优先级保护：低优先级的环境危险不能盖掉正在进行的更高优先级告警
         * （典型是 SOS 触发后 1 秒内又出现温湿度越界）。被压下的危险仍然有效，
         * SOS 被 ACK 后会在 ACKED 分支立刻升级成新的环境告警。 */
        if (s_state == 2 && danger_priority(danger) < danger_priority(s_alarm_type)) {
            return;
        }
        raise_alarm(danger, danger_detail(danger));
        return;
    }

    /* 没有危险：可恢复类告警（无活动/温湿度/水漏）自动回 NORMAL，这样“异常解除后
     * 恢复、再次异常再提醒”才成立；GAS / SMOKE 保持“必须 ACK/reset”的锁存语义，
     * 不自动清除。 */
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

/* 持续异常限频提醒：主循环每 100 ms 调一次，到点才真播。
 * 用户 stop/ACK 后不再提醒；危险解除后状态已回 NORMAL；再次异常会新建告警并立即播。 */
static void alarm_reminder_tick(void)
{
#if CONFIG_NODE_ALARM_REPEAT_SEC > 0
    /* “长时间未检测到活动”只提醒一次：房间无人/夜间睡眠时不应无限重复打扰；
     * SOS 与环境类告警才按限频间隔持续提醒。 */
    if (s_alarm_type[0] && strcmp(s_alarm_type, "NO_MOTION") == 0) return;
    int64_t now = node_now_ms();
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

/* 拼一条状态 JSON 并发给网关。
 *
 * 报文结构（单行、以 '\n' 结尾）：
 * {
 *   "deviceId": "...", "room": "...", "ts": <毫秒>,
 *   "state": "NORMAL|WARN|ALARM|ACKED",
 *   "sensors": {
 *     "motion":  {"lastActiveTs": ms, "countToday": n},
 *     "door":    {...},                       // door_monitor.c 生成，可为 null
 *     "climate": {"tempC": f, "rh": f, "ok": bool, "valid": bool},
 *     "gas":     {"raw": n, "ok": bool, "valid": bool},
 *     "smoke":   {"raw": n, "ok": bool, "valid": bool},
 *     "water":   {"wet": bool, "valid": bool} // 仅启用节点
 *   },
 *   "history": [0,0,0,0,0,0,n],
 *   "slots":   [0,0,0,0],
 *   "alarm":   {"id": "...", "type": "...", "countToday": n},
 *   "battery": {...}                          // 仅启用电池采样的节点
 * }
 *
 * 语义约定：
 *   - ts 在时间未同步时为 0，由服务器按接收时间补；
 *   - valid=false 表示本次读取失败，ok 不应被当作“正常”；
 *   - 没有接的传感器，对应段要么不输出，要么保持旧字段兼容；
 *   - alarm.id 只在 ALARM/ACKED 时非空，NORMAL 时为空串；
 *   - 报文超长时宁可丢弃整条，也不发截断的半条 JSON。
 *
 * 调用频率：主循环每 CONFIG_NODE_REPORT_SEC 秒一次；告警/ACK/STOP/PAUSE
 * 等状态变化也会立即调用，让 APP 尽快看到变化。
 * 缓冲区 1600 字节，实测带 battery 段最长约 1.4KB；和 gw_link 的邮箱上限一致。 */
static void report(void)
{
    char json[REPORT_JSON_MAX];
    char water_json[80] = "";      /* 仅卫生间等启用节点输出 water 段；厨房 JSON 保持不变 */
#if CONFIG_NODE_WATER_GPIO >= 0
    /* wet 与内部 s_water_ok 相反：s_water_ok=1 表示“没有漏水”，
     * JSON 的 wet 表示“探头是否湿”，所以这里要取反。 */
    snprintf(water_json, sizeof(water_json), ",\"water\":{\"wet\":%s,\"valid\":%s}",
             s_water_ok ? "false" : "true", json_valid_str(s_water_valid));
#endif
    /* door 段由 door_monitor.c 生成：门磁启用时带 lastOpenTs/lastCloseTs/seq/events，
     * 基线未建立 open=null；没装门磁的节点仍输出旧的 open/lastOpenTs 两个字段。 */
    char door_json[700] = "";
    door_report_json(door_json, sizeof(door_json));
#if CONFIG_NODE_BATTERY_ADC_CHANNEL >= 0
    /* battery 段只在真的接了电池采样电路时输出；固定供电的节点编译期就没这段，
     * 不会出现“凭空电量”。读数不可信时 mv/percent 一律 null，并带 reason 短码。 */
    /* battery 段只在真的接了电池采样电路时输出（CHANNEL>=0）。
     * mv/percent 不可信时保持字符串 "null"，而不是填 0：
     *   - mv=null 表示“没读到可信电压”；
     *   - percent=null 表示“未标定”或“无效”；
     * APP 看到 null 只显示占位符，不会显示 0%。
     * reason 是给 APP/云端定位原因用的短码，valid=true 时为空串。 */
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
    long long ts = s_time_synced ? node_now_ms() : 0;
    long long last = (s_time_synced && s_last_motion_ms > 0)
                     ? ts - (node_now_ms() - s_last_motion_ms) : 0;

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

    /* 长度断言：宁可不发，也不把截断的半条 JSON 发给网关（下游会判成非法报文） */
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


/* SOS 快路径：主循环每 100 ms 调一次。短按要连续 NODE_SOS_DEBOUNCE_CONFIRM 次
 *（默认 2 次≈200 ms）确认；长按只产生一次求助；松开后重新武装，可再次发起。
 * 传感器采样仍是 1 秒一次（AHT20 单次测量本身约 90 ms）。 */
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
        int key0 = board_key0_poll();
        if (key0 < 0) {
            /* I2C 失败不等于“按下”，也不等于“松开”（否则会解除武装或伪造求助） */
            raw_known = (CONFIG_NODE_SOS_GPIO >= 0);
        } else if (key0) {
            raw_pressed = 1;
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
        if (gw_sent_count() != s_sos_mark) {
            s_sos_delivery_logged = 1;
            ESP_LOGI(TAG, "SOS 上报已送达 Bridge（alarmId=%s）；平台 202/监护人确认另见云端与 APP，"
                          "设备此时仍视作“未确认”并继续本地提示", s_alarm_id);
        } else if (!s_sos_wait_warned && s_sos_pending_since > 0 &&
                   node_now_ms() - s_sos_pending_since > 15000) {
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

/* ---- 启动辅助 ---- */

/* 开机自检：蜂鸣器、温湿度、可选 DHT11。全部只打日志，失败不拦启动。 */
static void boot_self_check(void)
{
#if CONFIG_NODE_BOOT_BEEP_MS > 0
    board_buzzer(1);
    vTaskDelay(pdMS_TO_TICKS(CONFIG_NODE_BOOT_BEEP_MS));
    board_buzzer(0);
    ESP_LOGI(TAG, "蜂鸣器自检：%d ms 短鸣完成，已静音", (int)CONFIG_NODE_BOOT_BEEP_MS);
#endif

    float t0 = 0.0f, r0 = 0.0f;
    if (climate_read(&t0, &r0) == 0) {
        ESP_LOGI(TAG, "温湿度自检 OK: temp=%.1fC rh=%.1f%%", t0, r0);
    } else {
        ESP_LOGW(TAG, "温湿度自检失败：未接/接线错误/校验失败");
    }

#if CONFIG_NODE_DHT11_BENCH && CONFIG_NODE_DHT11_GPIO >= 0
    for (int i = 1; i <= 5; i++) {
        float tb = 0.0f, hb = 0.0f;
        int ok = climate_read(&tb, &hb);
        ESP_LOGI(TAG, "DHT11 bench %d/5: %s temp=%.1fC rh=%.1f%%", i,
                 ok == 0 ? "PASS" : "FAIL", tb, hb);
    }
#endif
}

#if CONFIG_NODE_LOCAL_BENCH
/* 本地台架：只打印 GPIO 变化，不联网，死循环。 */
static void local_bench_run(void)
{
    ESP_LOGI(TAG, "LOCAL BENCH: WiFi/网关禁用；PIR GPIO%d SOS GPIO%d",
             CONFIG_NODE_MOTION_GPIO, CONFIG_NODE_SOS_GPIO);
#if CONFIG_NODE_MOTION_GPIO >= 0
    int last_pir = gpio_get_level(CONFIG_NODE_MOTION_GPIO) ? 1 : 0;
    ESP_LOGI(TAG, "LOCAL BENCH: PIR initial raw=%d", last_pir);
#endif
#if CONFIG_NODE_SOS_GPIO >= 0
    int last_sos = gpio_get_level(CONFIG_NODE_SOS_GPIO) ? 1 : 0;
    ESP_LOGI(TAG, "LOCAL BENCH: SOS initial raw=%d", last_sos);
#endif

    int bench_tick = 0;
    for (;;) {
#if CONFIG_NODE_SOS_GPIO >= 0
        int sos = gpio_get_level(CONFIG_NODE_SOS_GPIO) ? 1 : 0;
        if (sos != last_sos) {
            ESP_LOGI(TAG, "LOCAL BENCH: SOS raw=%d", sos);
            last_sos = sos;
        }
        sos_handle_fast();
#endif

        if (++bench_tick >= 10) {
            bench_tick = 0;
#if CONFIG_NODE_MOTION_GPIO >= 0
            int pir = gpio_get_level(CONFIG_NODE_MOTION_GPIO) ? 1 : 0;
            if (pir != last_pir) {
                ESP_LOGI(TAG, "LOCAL BENCH: PIR raw=%d", pir);
                last_pir = pir;
            }
            if (pir_update(&s_pir_db, pir, CONFIG_NODE_MOTION_DEBOUNCE_CONFIRM)) {
                s_last_motion_ms = node_now_ms();
                s_motion_count++;
                ESP_LOGI(TAG, "LOCAL BENCH: PIR event（今日第 %d 次）", s_motion_count);
            }
#endif
        }
        vTaskDelay(pdMS_TO_TICKS(100));
    }
}
#endif

/* 台架只开 UART 命令队列；现场先起 Wi-Fi，语音构建再起网关/音箱/咪头/串口命令。 */
static void network_start(void)
{
#if CONFIG_NODE_ALARM_BENCH_INJECT
#if CONFIG_NODE_VOICE_ENABLED
    if (gw_queues_create() != 0) {
        ESP_LOGE(TAG, "BENCH: 队列创建失败，台架命令不可用");
    } else if (gw_serial_start("bench-uart") != 0) {
        ESP_LOGE(TAG, "BENCH: UART 命令任务创建失败");
    }
#endif
#else
    wifi_start();
    wifi_time_sync_start();
#if CONFIG_NODE_VOICE_ENABLED
    if (gw_queues_create() != 0 || gw_worker_start() != 0) {
        ESP_LOGE(TAG, "network worker unavailable; local sensing/voice remain active");
    }
    speaker_link_start();
    mic_link_start();
    if (gw_serial_start("serial-cmd") != 0) {
        ESP_LOGE(TAG, "串口命令任务不可用（mictest 需重启后检查内存）");
    }
#endif
#endif /* CONFIG_NODE_ALARM_BENCH_INJECT */
}

/* 主循环：SOS 快路径 -> 每 1s 采样判定 -> 提醒 -> LED -> 命令 -> 定时上报。 */
static void run_loop(void)
{
    int counter = 0;
    int sensor_tick = 0;
    for (;;) {
#if !CONFIG_NODE_VOICE_ENABLED
        if (!wifi_connected()) {
            vTaskDelay(pdMS_TO_TICKS(500));
            continue;
        }
        if (gw_ensure_connected() != 0) {
            vTaskDelay(pdMS_TO_TICKS(3000));
            continue;
        }
#endif
        /* 同步后钟表会跳变，不重置基准会把 idle 算成几十年 */
        if (!s_time_synced) {
            time_t now = 0;
            time(&now);
            if (now > 1700000000) {
                s_time_synced = 1;
                if (ntp_reset_motion_baseline(CONFIG_NODE_MOTION_GPIO >= 0)) {
                    s_last_motion_ms = node_now_ms();
                }
                ESP_LOGI(TAG, "时间已同步（不改动环境告警状态）");
            }
        }

        sos_handle_fast();
#if CONFIG_NODE_VOICE_ENABLED && CONFIG_NODE_BUZZER_XL9555
        board_ai_key_tick();
#endif
        if (++sensor_tick >= 10) {
            sensor_tick = 0;
            sample();
            judge();
        }
        alarm_reminder_tick();
        local_led_tick(s_state, s_alarm_type, active_danger() != NULL);
#if CONFIG_NODE_VOICE_ENABLED
        gw_drain_commands(handle_command, 4);
#else
        gw_poll();
#endif

        if (++counter >= CONFIG_NODE_REPORT_SEC * 10) {
            counter = 0;
            report();
        }
        vTaskDelay(pdMS_TO_TICKS(100));
    }
}

/* ---- 主流程 ---- */

/* 节点主任务：NVS -> 外设 -> 自检 -> 网络 -> 主循环。
 * 顺序有依赖：门磁读 NVS 恢复 seq，语音要在 I2C0/ADC 之后，网络最后起。 */
void app_main(void)
{
    /* NVS 版本或分区布局变化时会要求擦除；代价是丢门磁 seq 和暂停状态 */
    esp_err_t ret = nvs_flash_init();
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES ||
        ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ret = nvs_flash_init();
    }
    ESP_ERROR_CHECK(ret);

    /* NTP 未同步时用上电随机盐参与 alarmId，避免不同上电周期撞同一个 ID */
    s_boot_salt = (unsigned)esp_random();

    ESP_LOGI(TAG, "ESP32-S3 无线节点启动：%s / %s", CONFIG_NODE_ID, CONFIG_NODE_ROOM);
    monitor_pause_load(); /* 暂停状态跨重启保持 */

    #if CONFIG_NODE_ALARM_BENCH_INJECT
    /* 台架模式：只走 UART，不起网络 */
        ESP_LOGW(TAG,
                 "BENCH INJECT MODE：仅隔离台架验收（gw_port=%d 无活动=%ds "
                 "重复提醒=%ds 温湿度确认=%d/%d）",
                 (int)CONFIG_NODE_GW_PORT, (int)CONFIG_NODE_NO_MOTION_SEC,
                 (int)CONFIG_NODE_ALARM_REPEAT_SEC,
                 (int)CONFIG_NODE_CLIMATE_CONFIRM_COUNT,
                 (int)CONFIG_NODE_CLIMATE_CLEAR_COUNT);
    #endif

    /* GPIO -> 门磁 -> LED -> I2C0(XL9555/蜂鸣器/KEY0) -> I2C1(AHT20) -> ADC -> 语音 */
    board_gpio_start();
    door_monitor_start();
    local_led_start();
    board_i2c_start();
    climate_bus_start();
    adc_start();
    local_voice_start(); /* 语音起不来不影响传感器和蜂鸣器 */
    gw_set_command_handler(handle_command);

    boot_self_check();

    #if CONFIG_NODE_MOTION_GPIO >= 0
        s_last_motion_ms = node_now_ms();   /* PIR 以启动时刻作为无活动基准 */
    #else
        s_last_motion_ms = 0;
    #endif

    #if CONFIG_NODE_LOCAL_BENCH
        local_bench_run();
    #endif

    network_start();

    run_loop();
}
