/* wearable_main.c —— 随身 SOS 固件（ESP32-S3 + YED M100MG-B1 4G DTU）
 *
 * 本文件只做硬件 I/O 与主循环；判定逻辑全部在 wearable_logic.c（主机可单测）。
 *
 * 链路：实体按钮 GPIO4 --(低电平)--> ESP32-S3
 *         ESP32 GPIO5 --> 3 针有源蜂鸣器（高电平触发）
 *         ESP32 UART1 TX=GPIO17 -> M100 RXD，RX=GPIO18 <- M100 TXD，115200 8N1，共地
 *         M100 MQTT 透传：UART 行 = MQTT payload（契约 DESIGN-CONTRACT.md §3）
 *
 * 硬约束：
 *   - 不初始化 Wi-Fi / 蓝牙 / esp_netif；网络只经 M100 4G 透传。
 *   - 无 RTC：不伪造墙钟，所有时间只用 uptimeMs。
 *   - 事件/alarmId 先写 NVS 再发送；未确认事件重启后继续同一 alarmId 重试并恢复提示。
 *   - 只有 alarm 匹配当前事件的 ACK 才能结束提示；cmd 有则必须与已收到的命令一致。
 *   - 正式固件不向 M100 发任何 config,get/... 命令，SOS 的 gps 固定 null：
 *     M100 自己主动上报固定格式 "经度_纬度" 到 MQTT 上行主题，由适配器解析。
 *   - 任何非 JSON 行（M100 回包 / GPS 固定格式 / 乱码）只记日志，绝不当作 ACK、绝不回显。
 *   - M100 下行不追加 '\n'（原样字节）：UART 成帧 = '\n' 立即成帧 + 100ms 空闲超时兜底。
 */
#include <stdio.h>
#include <string.h>

#include "driver/gpio.h"
#include "driver/uart.h"
#include "esp_adc/adc_oneshot.h"
#include "esp_err.h"
#include "esp_log.h"
#include "esp_random.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "nvs.h"
#include "nvs_flash.h"
#include "sdkconfig.h"

#include "wearable_logic.h"
#include "battery_logic.h"   /* 电池电压换算/有效性/百分比（与 esp32-node 同一套纯逻辑） */

/* Kconfig bool 在 "=n" 时**不会**生成宏（只有 =y 才定义 CONFIG_xxx），
 * 因此不能把 CONFIG_NODE_BATTERY_CALIBRATED 当 0 用；这里统一折叠成本地 0/1 宏。 */
#ifdef CONFIG_NODE_BATTERY_CALIBRATED
#define NODE_BATTERY_CALIBRATED 1
#else
#define NODE_BATTERY_CALIBRATED 0
#endif

static const char *TAG = "wearable";

/* 电池采样只能用 ADC1（GPIO1..10 = CH0..CH9）；ADC2 在 Wi-Fi/4G 场景不可用。
 * 引脚合法性（GPIO6/19/20/26-37 禁用）在下面 WB_PIN_FORBIDDEN 定义之后校验。 */
#if CONFIG_NODE_BATTERY_ADC_CHANNEL > 9
#error "NODE_BATTERY_ADC_CHANNEL 只允许 ADC1_CH0..CH9（-1=未接电池采样）"
#endif
#if CONFIG_NODE_BATTERY_ADC_CHANNEL >= 0 && CONFIG_NODE_BATTERY_MIN_MV > CONFIG_NODE_BATTERY_MAX_MV
#error "NODE_BATTERY_MIN_MV 必须 <= NODE_BATTERY_MAX_MV"
#endif

/* ------------------------------------------------------------------ 引脚安全检查 */
/* GPIO6 在 16MB Flash 板上是 SPI flash 脚（电平被底层驱动覆盖，会导致蜂鸣器长鸣）；
 * 19/20 是 USB；26-37 是 Flash/PSRAM。这里编译期直接拒绝，避免误配。 */
#define WB_PIN_FORBIDDEN(p) \
    (((p) == 6) || ((p) == 19) || ((p) == 20) || (((p) >= 26) && ((p) <= 37)))

#if WB_PIN_FORBIDDEN(CONFIG_WEARABLE_BUTTON_GPIO) || \
    WB_PIN_FORBIDDEN(CONFIG_WEARABLE_BUZZER_GPIO) || \
    WB_PIN_FORBIDDEN(CONFIG_WEARABLE_UART_TX_GPIO) || \
    WB_PIN_FORBIDDEN(CONFIG_WEARABLE_UART_RX_GPIO)
#error "按键/蜂鸣器/UART 不能使用 GPIO6、19、20 或 26-37（Flash/PSRAM/USB 专用脚）"
#endif
#if CONFIG_NODE_BATTERY_ADC_CHANNEL >= 0 && WB_PIN_FORBIDDEN(CONFIG_NODE_BATTERY_ADC_CHANNEL)
#error "电池采样引脚不能使用 GPIO6、19、20 或 26-37（Flash/PSRAM/USB 专用脚）"
#endif

#define WB_BTN_GPIO CONFIG_WEARABLE_BUTTON_GPIO
#define WB_BZ_GPIO CONFIG_WEARABLE_BUZZER_GPIO
#define WB_UART_TX CONFIG_WEARABLE_UART_TX_GPIO
#define WB_UART_RX CONFIG_WEARABLE_UART_RX_GPIO
#define WB_UART_BAUD CONFIG_WEARABLE_UART_BAUD
#define WB_DEV CONFIG_WEARABLE_DEV_ID
#define WB_FW CONFIG_WEARABLE_FW_VERSION

#define WB_UART_NUM UART_NUM_1
#define WB_UART_RX_BUF 4096
#define WB_UART_TX_BUF 1024

/* NVS：一个 blob 保存事件 + 计数器 + 最近 ACK 备忘（见 wearable_logic.h） */
#define WB_NVS_NS "wearable"
#define WB_NVS_KEY_STATE "state"

/* ------------------------------------------------------------------ 全局状态 */

static wb_event_t s_ev;
static wb_ack_memo_t s_memo;
static wb_debounce_t s_btn;
static wb_buzzer_t s_bz;
static wb_line_buf_t s_line;
static uint32_t s_rx_last_byte_ms;  /* 最近一次收到 UART 字节的 uptime（空闲成帧兜底用） */
#if CONFIG_WEARABLE_QUERY_GPS_ON_SOS
static wb_gps_fix_t s_gps;
#endif
static uint32_t s_counter;
static int s_csq = -1;
static uint32_t s_last_hb_ms;
static int s_mute_logged;

#if CONFIG_WEARABLE_QUERY_GPS_ON_SOS
static int s_gps_query_active;
static uint32_t s_gps_query_deadline_ms;
#endif

static uint32_t wb_now_ms(void)
{
    return (uint32_t)(esp_timer_get_time() / 1000);
}

/* ------------------------------------------------------------------ NVS 持久化 */

static esp_err_t wb_nvs_store(const wb_persist_t *snap)
{
    nvs_handle_t handle;
    esp_err_t err;

    err = nvs_open(WB_NVS_NS, NVS_READWRITE, &handle);
    if (err != ESP_OK) {
        return err;
    }
    err = nvs_set_blob(handle, WB_NVS_KEY_STATE, snap, sizeof(*snap));
    if (err == ESP_OK) {
        err = nvs_commit(handle);
    }
    nvs_close(handle);
    return err;
}

static esp_err_t wb_nvs_load(wb_persist_t *snap)
{
    nvs_handle_t handle;
    esp_err_t err;
    size_t len = sizeof(*snap);

    err = nvs_open(WB_NVS_NS, NVS_READONLY, &handle);
    if (err != ESP_OK) {
        return err;
    }
    err = nvs_get_blob(handle, WB_NVS_KEY_STATE, snap, &len);
    nvs_close(handle);
    if (err == ESP_OK && len != sizeof(*snap)) {
        return ESP_ERR_INVALID_SIZE;
    }
    return err;
}

/* 事件开始 / ACK 确认时调用；失败只记日志，不阻塞求助流程。 */
static esp_err_t wb_save_state(void)
{
    wb_persist_t snap;
    esp_err_t err;

    wb_persist_from_event(&snap, &s_ev, &s_memo, s_counter);
    err = wb_nvs_store(&snap);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "NVS 持久化失败: %s（内存中继续，重启可能丢失该事件）",
                 esp_err_to_name(err));
    }
    return err;
}

/* ------------------------------------------------------------------ UART */

static void wb_uart_init(void)
{
    const uart_config_t cfg = {
        .baud_rate = WB_UART_BAUD,
        .data_bits = UART_DATA_8_BITS,
        .parity = UART_PARITY_DISABLE,
        .stop_bits = UART_STOP_BITS_1,
        .flow_ctrl = UART_HW_FLOWCTRL_DISABLE,
        .rx_flow_ctrl_thresh = 0,
        .source_clk = UART_SCLK_DEFAULT,
    };

    ESP_ERROR_CHECK(uart_driver_install(WB_UART_NUM, WB_UART_RX_BUF, WB_UART_TX_BUF, 0, NULL, 0));
    ESP_ERROR_CHECK(uart_param_config(WB_UART_NUM, &cfg));
    ESP_ERROR_CHECK(
        uart_set_pin(WB_UART_NUM, WB_UART_TX, WB_UART_RX, UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE));
    ESP_LOGI(TAG, "UART1 已初始化：TX=GPIO%d -> M100 RXD, RX=GPIO%d <- M100 TXD, %d 8N1 无流控",
             (int)WB_UART_TX, (int)WB_UART_RX, (int)WB_UART_BAUD);
}

/* 发一行 JSON 给 M100（\n 结尾，契约 §3）。 */
static void wb_uart_send_json(const char *json)
{
    if (!json || json[0] == '\0') {
        return;
    }
    uart_write_bytes(WB_UART_NUM, json, strlen(json));
    uart_write_bytes(WB_UART_NUM, "\n", 1);
    ESP_LOGI(TAG, "UART TX -> %s", json);
}

/* 向 M100 发 DTU 文本命令（仅实验开关打开时用于主动查询 GPS；默认不发送任何
 * config,get/... 命令，避免与透传业务/配置回包互相干扰）。 */
#if CONFIG_WEARABLE_QUERY_GPS_ON_SOS
static void wb_uart_send_command(const char *cmd)
{
    if (!cmd || cmd[0] == '\0') {
        return;
    }
    uart_write_bytes(WB_UART_NUM, cmd, strlen(cmd));
    uart_write_bytes(WB_UART_NUM, "\n", 1);
    ESP_LOGI(TAG, "UART TX(DTU) -> %s", cmd);
}
#endif

/* ------------------------------------------------------------------ GPIO */

static void wb_gpio_init(void)
{
    gpio_config_t btn = {0};
    gpio_config_t bz = {0};

    /* 按钮：内部上拉，另一端接 GND，低电平 = 按下。 */
    btn.pin_bit_mask = 1ULL << WB_BTN_GPIO;
    btn.mode = GPIO_MODE_INPUT;
    btn.pull_up_en = GPIO_PULLUP_ENABLE;
    btn.pull_down_en = GPIO_PULLDOWN_DISABLE;
    btn.intr_type = GPIO_INTR_DISABLE;
    ESP_ERROR_CHECK(gpio_config(&btn));

    /* 蜂鸣器：3 针模块高电平触发，上电先输出 0 = 静音（不开机长鸣）。 */
    bz.pin_bit_mask = 1ULL << WB_BZ_GPIO;
    bz.mode = GPIO_MODE_OUTPUT;
    bz.pull_up_en = GPIO_PULLUP_DISABLE;
    bz.pull_down_en = GPIO_PULLDOWN_DISABLE;
    bz.intr_type = GPIO_INTR_DISABLE;
    ESP_ERROR_CHECK(gpio_config(&bz));
    gpio_set_level(WB_BZ_GPIO, 0);

    ESP_LOGI(TAG, "GPIO 已初始化：按键 GPIO%d（上拉，低有效），蜂鸣器 GPIO%d（高电平触发，待机 0）",
             (int)WB_BTN_GPIO, (int)WB_BZ_GPIO);
}

/* ------------------------------------------------------------------ 电量采样（契约 §1.3/§2）
 *
 * 与 esp32-node 使用同一份 battery_logic（raw->mV、分压、两点校准、8 样本中位数、
 * 极差/一致率/范围三重门限、低电量、仅标定后给 percent）。
 * 这里只做 I/O：ADC oneshot 初始化 + 周期采样；帧构造在 wearable_logic.c。
 * ⚠ 当前实物未接电池/分压：采样到的只会是浮空噪声，三重门限会判 valid=false
 *   （UNSTABLE）或 OUT_OF_RANGE，绝不给 APP 报假电压/假百分比。 */
#if CONFIG_NODE_BATTERY_ADC_CHANNEL >= 0
static battery_config_t s_batt_cfg;
static battery_result_t s_batt_result;
static adc_oneshot_unit_handle_t s_batt_adc = NULL;
static uint32_t s_batt_next_ms = 0;

static void wb_battery_init(void)
{
    battery_config_default(&s_batt_cfg);
    s_batt_cfg.divider_num = CONFIG_NODE_BATTERY_DIVIDER_NUM;
    s_batt_cfg.divider_den = CONFIG_NODE_BATTERY_DIVIDER_DEN;
    s_batt_cfg.gain_permille = CONFIG_NODE_BATTERY_CAL_GAIN_PERMILLE;
    s_batt_cfg.offset_mv = CONFIG_NODE_BATTERY_CAL_OFFSET_MV;
    s_batt_cfg.low_mv = CONFIG_NODE_BATTERY_LOW_MV;
    s_batt_cfg.min_mv = CONFIG_NODE_BATTERY_MIN_MV;
    s_batt_cfg.max_mv = CONFIG_NODE_BATTERY_MAX_MV;
    s_batt_cfg.calibrated = NODE_BATTERY_CALIBRATED ? 1 : 0;
    /* 初始状态：还没采样 -> valid=0 + NO_ADC，绝不预置任何电压/百分比 */
    s_batt_result.valid = 0;
    s_batt_result.mv = -1;
    s_batt_result.percent = -1;
    s_batt_result.low = 0;
    s_batt_result.raw_median = -1;
    s_batt_result.reason = BATTERY_REASON_NO_ADC;

    adc_oneshot_unit_init_cfg_t unit_cfg = {
        .unit_id = ADC_UNIT_1,
        .ulp_mode = ADC_ULP_MODE_DISABLE,
    };
    ESP_ERROR_CHECK(adc_oneshot_new_unit(&unit_cfg, &s_batt_adc));
    adc_oneshot_chan_cfg_t chan_cfg = {
        .atten = ADC_ATTEN_DB_12,
        .bitwidth = ADC_BITWIDTH_12,
    };
    ESP_ERROR_CHECK(adc_oneshot_config_channel(s_batt_adc, (adc_channel_t)CONFIG_NODE_BATTERY_ADC_CHANNEL, &chan_cfg));
    s_batt_next_ms = 0;
    ESP_LOGI(TAG, "电池采样启用: ADC1_CH%d 分压 %d:%d 校准=%s 有效=%d..%dmV 低电<=%dmV 周期=%ds",
             (int)CONFIG_NODE_BATTERY_ADC_CHANNEL,
             (int)CONFIG_NODE_BATTERY_DIVIDER_NUM, (int)CONFIG_NODE_BATTERY_DIVIDER_DEN,
             NODE_BATTERY_CALIBRATED ? "是" : "否(percent=null)",
             (int)CONFIG_NODE_BATTERY_MIN_MV, (int)CONFIG_NODE_BATTERY_MAX_MV,
             (int)CONFIG_NODE_BATTERY_LOW_MV, (int)CONFIG_NODE_BATTERY_SAMPLE_SEC);
}

/* 周期采样（默认 30s）：主循环调用，非阻塞语义，仅在本 tick 内短暂忙等 ~16ms。 */
static void wb_battery_tick(uint32_t now_ms)
{
    int raws[BATTERY_SAMPLE_COUNT];
    int n = 0;
    int read_ok = 0;

    if (s_batt_next_ms != 0 && now_ms < s_batt_next_ms) return;
    s_batt_next_ms = now_ms + (uint32_t)CONFIG_NODE_BATTERY_SAMPLE_SEC * 1000u;

    for (int i = 0; i < BATTERY_SAMPLE_COUNT; i++) {
        int raw = 0;
        esp_err_t err = adc_oneshot_read(s_batt_adc, (adc_channel_t)CONFIG_NODE_BATTERY_ADC_CHANNEL, &raw);
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
    battery_evaluate(raws, n, read_ok, &s_batt_cfg, &s_batt_result);
    ESP_LOGI(TAG, "电池采样: raw_median=%d mv=%d valid=%d percent=%d low=%d reason=%s",
             s_batt_result.raw_median, s_batt_result.mv, s_batt_result.valid,
             s_batt_result.percent, s_batt_result.low,
             (s_batt_result.reason && s_batt_result.reason[0]) ? s_batt_result.reason : "OK");
}

static const wb_battery_t *wb_battery_snapshot(void)
{
    static wb_battery_t snap;
    snap.present = s_batt_result.valid;      /* 只有可信电压才声称“有电池” */
    snap.valid = s_batt_result.valid;
    snap.mv = s_batt_result.mv;
    snap.percent = s_batt_result.percent;
    snap.low = s_batt_result.low;
    snap.calibrated = s_batt_cfg.calibrated;
    snap.reason = s_batt_result.reason ? s_batt_result.reason : "";
    return &snap;
}
#else
static void wb_battery_init(void)
{
    ESP_LOGI(TAG, "电池采样未启用（CONFIG_NODE_BATTERY_ADC_CHANNEL=-1）：hb 帧不含 battery 字段");
}
#endif

/* ------------------------------------------------------------------ 上行帧 */

static void wb_send_boot(void)
{
    char frame[WB_LINE_MAX_BYTES + 1];
    int n = wb_build_boot(frame, sizeof(frame), WB_DEV, WB_FW, wb_now_ms());
    if (n <= 0) {
        ESP_LOGE(TAG, "boot 帧构造失败");
        return;
    }
    wb_uart_send_json(frame);
}

static void wb_send_hb(uint32_t now)
{
    char frame[WB_LINE_MAX_BYTES + 1];
#if CONFIG_NODE_BATTERY_ADC_CHANNEL >= 0
    /* 心跳带电量：未接电池时是 valid=false + mv=null + reason，绝不写 0% */
    int n = wb_build_hb_ex(frame, sizeof(frame), WB_DEV, s_ev.state,
                           wb_event_active(&s_ev) ? s_ev.alarm_id : "", now, s_csq,
                           wb_battery_snapshot());
#else
    int n = wb_build_hb(frame, sizeof(frame), WB_DEV, s_ev.state,
                        wb_event_active(&s_ev) ? s_ev.alarm_id : "", now, s_csq);
#endif
    if (n <= 0) {
        ESP_LOGE(TAG, "心跳帧构造失败");
        return;
    }
    wb_uart_send_json(frame);
}

static void wb_send_sos(int announce)
{
    char frame[WB_LINE_MAX_BYTES + 1];
    const wb_gps_fix_t *fix = NULL;
    uint32_t now = wb_now_ms();
    int n;

#if CONFIG_WEARABLE_QUERY_GPS_ON_SOS
    /* 仅实验开关打开时才可能带定位；过期（>60s）的定位同样不写进 SOS。 */
    if (wb_gps_is_fresh(&s_gps, now, WB_GPS_MAX_AGE_MS)) {
        fix = &s_gps;
    }
#else
    /* 正式固件：gps 固定为 null。M100 自己主动上报固定格式 "经度_纬度" 到上行主题，
     * 由 ECS 适配器解析成“求助时最近定位”，ESP32 不参与、也不伪造定位。 */
    fix = NULL;
#endif
    if (!wb_event_active(&s_ev)) {
        ESP_LOGW(TAG, "没有未确认事件，拒绝发送 SOS");
        return;
    }
    s_ev.seq++;
    n = wb_build_sos(frame, sizeof(frame), WB_DEV, s_ev.alarm_id, now, s_ev.seq, fix);
    if (n <= 0) {
        ESP_LOGE(TAG, "SOS 帧构造失败或超过 %d 字节", WB_LINE_MAX_BYTES);
        return;
    }
    wb_uart_send_json(frame);
    wb_event_note_sent(&s_ev, now);
    if (announce) {
        ESP_LOGI(TAG, "SOS 上行：alarm=%s gps=%s seq=%lu", s_ev.alarm_id,
                 fix ? "有效定位" : "null", (unsigned long)s_ev.seq);
    }
}

/* 设备真实回执：只有收到匹配 ACK 后才发（适配器据此 POST command result）。 */
static void wb_send_ack_receipt(const char *alarm, const char *cmd)
{
    char frame[WB_LINE_MAX_BYTES + 1];
    int n = wb_build_ack_frame(frame, sizeof(frame), WB_DEV, alarm, cmd);
    if (n <= 0) {
        ESP_LOGE(TAG, "ACK 回执帧构造失败（alarm 非法/超长）");
        return;
    }
    wb_uart_send_json(frame);
    ESP_LOGI(TAG, "已回设备真实回执 alarm=%s cmd=%s", alarm, cmd ? cmd : "(下行未带 cmd)");
}

/* ------------------------------------------------------------------ 下行处理 */

/* DTU config 回包：只本地解析，任何情况下都不回显到上行 MQTT，也不当作 ACK。
 *  - config,csq,ok,<0..31> -> 心跳 csq（若 M100 主动给出）
 *  - 其他（config,gps / 命令回显）-> 默认只记调试日志 */
static void wb_handle_config_line(const char *line, uint32_t now)
{
#if CONFIG_WEARABLE_QUERY_GPS_ON_SOS
    wb_gps_fix_t fix;
    wb_gps_result_t gps = wb_gps_parse_line(line, &fix, now);

    if (gps == WB_GPS_FIX) {
        s_gps = fix;
        ESP_LOGI(TAG, "GPS 回包解析成功（仅本地解析，不上上行）：lat_u6=%ld lon_u6=%ld",
                 (long)fix.lat_u6, (long)fix.lon_u6);
        if (s_gps_query_active) {
            s_gps_query_active = 0;
            if (wb_event_active(&s_ev)) {
                ESP_LOGI(TAG, "GPS 在 1500ms 内返回，补发同一 alarmId 的带定位 SOS");
                wb_send_sos(0);
            }
        }
        return;
    }
    if (gps == WB_GPS_NO_FIX) {
        ESP_LOGW(TAG, "config,gps 回包无有效定位（短包/flag=0/坐标非法）：gps=null，不阻塞 SOS");
        s_gps_query_active = 0;
        return;
    }
#else
    (void)now;
    /* 默认关闭 GPS 查询：不解析/不缓存 config,gps，SOS 的 gps 固定 null。
     * M100 主动上报的固定格式 "经度_纬度" 不是 config 行，会在 wb_handle_line 被忽略。 */
#endif

    {
        int csq = -1;
        if (wb_parse_csq_line(line, &csq)) {
            s_csq = csq;
            ESP_LOGI(TAG, "CSQ=%d（仅本地解析，不上上行）", csq);
            return;
        }
    }
    ESP_LOGD(TAG, "忽略 DTU config 回包（本地解析，不回显）: %.96s", line);
}

static void wb_handle_downlink_json(const char *line, uint32_t now)
{
    wb_downlink_t dl;
    const char *cmd;
    wb_ack_result_t result;

    if (!wb_json_parse_downlink(line, &dl)) {
        ESP_LOGW(TAG, "忽略非法 JSON 下行: %.96s", line);
        return;
    }
    if (!dl.has_t) {
        if (dl.alarm_too_long) {
            ESP_LOGW(TAG, "下行 alarm 字段超长（>%d），忽略", WB_ALARM_ID_MAX_LEN);
        } else {
            ESP_LOGW(TAG, "下行 JSON 缺少 t 字段，忽略");
        }
        return;
    }
    if (strcmp(dl.t, "ack") != 0) {
        ESP_LOGW(TAG, "下行 JSON t=\"%s\" 未知，忽略（不改变告警状态）", dl.t);
        return;
    }
    if (dl.has_v && dl.v != 1) {
        ESP_LOGW(TAG, "下行 ack 协议版本 v=%d 不支持，忽略", dl.v);
        return;
    }
    if (!dl.has_alarm) {
        if (dl.alarm_too_long) {
            ESP_LOGW(TAG, "下行 ack alarm 字段超长（>%d），忽略", WB_ALARM_ID_MAX_LEN);
        } else {
            ESP_LOGW(TAG, "下行 ack 缺少 alarm，忽略");
        }
        return;
    }
    if (dl.cmd_too_long) {
        /* 命令 ID 超长则无法可靠关联回执；拒绝结束事件，保持等待。 */
        ESP_LOGW(TAG, "下行 ack cmd 字段超长，忽略该 ACK（事件保持未确认）");
        return;
    }
    cmd = dl.has_cmd ? dl.cmd : NULL;

    result = wb_event_handle_ack(&s_ev, &s_memo, dl.alarm, cmd, dl.has_cmd, now);
    switch (result) {
    case WB_ACK_ACCEPTED:
        /* 立即停提示、置 IDLE（逻辑层已置）、持久化，并马上回真实回执。 */
        wb_buzzer_stop(&s_bz);
        gpio_set_level(WB_BZ_GPIO, 0);
        wb_save_state();
        ESP_LOGI(TAG, "收到匹配 ACK：alarm=%s cmd=%s -> 停止提示，事件置 IDLE（下次按键生成新 alarmId）",
                 dl.alarm, dl.has_cmd ? dl.cmd : "(缺失，已记录)");
        wb_send_ack_receipt(dl.alarm, cmd);
        break;
    case WB_ACK_DUPLICATE:
        ESP_LOGI(TAG, "重复 ACK（该事件已确认过）alarm=%s：只重发回执，不改状态", dl.alarm);
        wb_send_ack_receipt(s_memo.alarm_id, s_memo.has_cmd ? s_memo.cmd_id : NULL);
        break;
    case WB_ACK_REJECTED_CMD:
        ESP_LOGW(TAG, "ACK cmd 与已收到的命令不一致：拒绝并保持未确认 alarm=%s",
                 dl.alarm);
        break;
    case WB_ACK_REJECTED_ALARM:
    default:
        ESP_LOGW(TAG, "ACK alarm 不匹配当前事件：忽略（当前 %s）",
                 wb_event_active(&s_ev) ? s_ev.alarm_id : "无未确认事件");
        break;
    }
}

static void wb_handle_line(const char *line)
{
    uint32_t now = wb_now_ms();

    if (!line || line[0] == '\0') {
        return;
    }
    if (wb_dtu_is_config_line(line)) {
        wb_handle_config_line(line, now);
        return;
    }
    if (line[0] != '{') {
        /* M100 自身回包、M100 主动上报的 GPS 固定格式 "经度_纬度"（如 113.9737_22.69271）、
         * 乱码等一律忽略并记日志：既不当作 ACK，也绝不再回显上行。 */
        ESP_LOGW(TAG, "忽略非 JSON 下行（乱码/M100 自带回包/GPS 固定格式）: %.96s", line);
        return;
    }
    wb_handle_downlink_json(line, now);
}

static void wb_uart_rx_poll(uint32_t now)
{
    uint8_t buf[128];
    int n;

    while ((n = uart_read_bytes(WB_UART_NUM, buf, sizeof(buf), 0)) > 0) {
        int i;
        s_rx_last_byte_ms = now;
        for (i = 0; i < n; i++) {
            wb_line_event_t ev = wb_line_feed(&s_line, buf[i]);
            if (ev == WB_LINE_EVENT_READY) {
                /* 正常 '\n' 成帧：立即处理，缓冲区已清空、空闲计时随之失效。 */
                wb_handle_line(s_line.buf);
            } else if (ev == WB_LINE_EVENT_OVERFLOW) {
                ESP_LOGW(TAG, "UART 接收行超过 %d 字节，整行丢弃", WB_LINE_MAX_BYTES);
            }
        }
    }

    /* 真机实测：M100 把服务器下行数据写到串口时不追加 '\n'（原样字节），
     * 若只认 '\n' 成帧，ACK 会永远卡在缓冲区。这里做空闲超时兜底：
     * 缓冲非空且连续 WB_UART_IDLE_FLUSH_MS(100ms) 无新字节 → 把当前缓冲当一整行处理。
     * 仍走同一个 wb_handle_line（JSON/config/非 JSON 分类与 512B 上限不变）；
     * 收到 '\n' 的主路径完全不变。 */
    {
        wb_line_event_t idle = wb_line_idle_flush(&s_line, s_rx_last_byte_ms, now);
        if (idle == WB_LINE_EVENT_READY) {
            ESP_LOGI(TAG, "UART 空闲 %dms 成帧（服务端下行未带换行）: %.96s",
                     WB_UART_IDLE_FLUSH_MS, s_line.buf);
            wb_handle_line(s_line.buf);
        } else if (idle == WB_LINE_EVENT_OVERFLOW) {
            ESP_LOGW(TAG, "UART 接收行超过 %d 字节（空闲成帧），整行丢弃", WB_LINE_MAX_BYTES);
        }
    }
}

/* ------------------------------------------------------------------ 按键事件 */

static void wb_handle_press(uint32_t now)
{
    uint8_t rnd[4] = {0, 0, 0, 0};
    char alarm[WB_ALARM_ID_CAP];
    uint32_t next;
    esp_err_t err;

    if (wb_event_active(&s_ev)) {
        ESP_LOGW(TAG, "已有未确认事件 alarm=%s，忽略本次按键（绝不换新 alarmId）", s_ev.alarm_id);
        return;
    }

    next = s_counter + 1u;
    if (next == 0) {
        next = 1; /* uint32 回绕保护 */
    }
    esp_fill_random(rnd, sizeof(rnd));
    if (wb_alarm_id_format(alarm, sizeof(alarm), next, rnd) < 0) {
        ESP_LOGE(TAG, "alarmId 生成失败，本次忽略");
        return;
    }

    /* 第一优先级：立即蜂鸣（<100ms），不等 NVS / UART / GPS。 */
    wb_buzzer_start(&s_bz, now);
    gpio_set_level(WB_BZ_GPIO, 1);

    if (!wb_event_start(&s_ev, alarm, now)) {
        ESP_LOGE(TAG, "事件状态机拒绝新事件，静音");
        wb_buzzer_stop(&s_bz);
        gpio_set_level(WB_BZ_GPIO, 0);
        return;
    }
    s_counter = next;

    /* 先持久化再发送：重启后还能用同一个 alarmId 继续重试，绝不静默丢弃。 */
    err = wb_save_state();
    if (err == ESP_OK) {
        ESP_LOGI(TAG, "新事件已写入 NVS：alarm=%s", alarm);
    } else {
        ESP_LOGE(TAG, "新事件 NVS 写入失败(%s)：内存中继续重试，重启后可能无法恢复",
                 esp_err_to_name(err));
    }
    ESP_LOGW(TAG, "SOS 事件开始 alarm=%s（未收到匹配 ACK 前每 10s 重发同一 alarmId）", alarm);
    s_mute_logged = 0;
    wb_send_sos(1);

#if CONFIG_WEARABLE_QUERY_GPS_ON_SOS
    /* 可选 GPS：只查询，不阻塞 SOS（SOS 已在上面发出）。回包只本地解析。 */
    wb_uart_send_command("config,get,gpsext");
    s_gps_query_active = 1;
    s_gps_query_deadline_ms = now + WB_GPS_QUERY_TIMEOUT_MS;
    ESP_LOGI(TAG, "已向 M100 查询 GPS（%d ms 超时；无定位则保持 gps=null）",
             WB_GPS_QUERY_TIMEOUT_MS);
#endif
}

/* ------------------------------------------------------------------ 主流程 */

void app_main(void)
{
    esp_err_t err;
    uint32_t now;
    uint32_t next_sample_ms;

    /* 1. 纯逻辑状态初始化 */
    wb_event_init(&s_ev, &s_memo);
    wb_debounce_init(&s_btn);
    wb_buzzer_init(&s_bz);
    wb_line_init(&s_line);
#if CONFIG_WEARABLE_QUERY_GPS_ON_SOS
    wb_gps_clear(&s_gps);
#endif
    s_counter = 0;
    s_csq = -1;
    s_last_hb_ms = 0;
    s_mute_logged = 0;
    s_rx_last_byte_ms = 0;

    ESP_LOGI(TAG, "随身 SOS 固件启动：dev=%s fw=%s（无 Wi-Fi，M100 4G 透传）", WB_DEV, WB_FW);
    ESP_LOGI(TAG, "契约：UART 单行 JSON ≤%d 字节；未确认每 10s 重试；心跳 30s；ACK 匹配才结束事件",
             WB_LINE_MAX_BYTES);

    /* 2. 硬件初始化（蜂鸣器上电即静音，不做开机长鸣） */
    wb_gpio_init();
    wb_uart_init();
    wb_battery_init();   /* 电池采样（未启用时只打印一行，不影响任何既有链路） */

    /* 3. NVS 初始化 + 未确认事件恢复 */
    err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_LOGW(TAG, "NVS 需要擦除后重新初始化: %s", esp_err_to_name(err));
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }
    if (err == ESP_OK) {
        wb_persist_t snap;
        esp_err_t lerr = wb_nvs_load(&snap);
        if (lerr == ESP_OK) {
            int active = 0;
            if (wb_persist_restore(&snap, &s_ev, &s_memo, &s_counter, wb_now_ms(), &active)) {
                ESP_LOGI(TAG, "NVS 状态已恢复：counter=%lu", (unsigned long)s_counter);
                if (active) {
                    ESP_LOGW(TAG, "恢复未确认事件 alarm=%s cmd=%s：继续原 alarmId 提示与重试",
                             s_ev.alarm_id, s_ev.has_cmd ? s_ev.cmd_id : "(无)");
                } else if (s_memo.valid) {
                    ESP_LOGI(TAG, "已确认事件备忘已恢复：alarm=%s", s_memo.alarm_id);
                }
            } else {
                ESP_LOGW(TAG, "NVS 状态快照校验失败（损坏/版本不符），忽略并重新开始");
            }
        } else if (lerr == ESP_ERR_NVS_NOT_FOUND) {
            ESP_LOGI(TAG, "NVS 无历史状态（首次启动）");
        } else {
            ESP_LOGW(TAG, "NVS 状态读取失败: %s", esp_err_to_name(lerr));
        }
    } else {
        ESP_LOGE(TAG, "NVS 初始化失败: %s（求助仍可用，但重启后事件不可恢复）",
                 esp_err_to_name(err));
    }

    /* 4. 启动帧 + 恢复提示/重试 */
    wb_send_boot();
    s_last_hb_ms = wb_now_ms();

    if (wb_event_active(&s_ev)) {
        /* 重启后事件仍未确认：恢复提示（SOS 3 短声循环）并用原 alarmId 立即重发。 */
        wb_buzzer_start(&s_bz, wb_now_ms());
        gpio_set_level(WB_BZ_GPIO, 1);
        wb_send_sos(1);
        ESP_LOGW(TAG, "恢复提示：蜂鸣器重新起响，事件仍未确认 alarm=%s", s_ev.alarm_id);
    }

    /* 5. 主循环：20ms 采样按键 + 轮询 UART + 驱动蜂鸣节奏 + 到期重发/心跳 */
    next_sample_ms = wb_now_ms();
    for (;;) {
        now = wb_now_ms();

        /* 5.1 按键：固定 20ms 采样，60ms 消抖在逻辑层完成 */
        if (wb_time_reached(now, next_sample_ms)) {
            int raw_pressed;
            wb_btn_event_t ev;
            next_sample_ms = now + WB_BTN_SAMPLE_MS;
            raw_pressed = (gpio_get_level(WB_BTN_GPIO) == 0) ? 1 : 0;
            ev = wb_debounce_update(&s_btn, raw_pressed, now);
            if (ev == WB_BTN_EVENT_PRESS) {
                wb_handle_press(now);
            } else if (ev == WB_BTN_EVENT_RELEASE) {
                ESP_LOGI(TAG, "按键松开（已重新武装，ACK 后可再次触发）");
            }
        }

        /* 5.2 UART 下行：'\n' 成帧 + 100ms 空闲成帧兜底（M100 下行不追加换行） */
        wb_uart_rx_poll(now);

        /* 5.3 GPS 查询超时：不阻塞 SOS，保持 gps=null */
#if CONFIG_WEARABLE_QUERY_GPS_ON_SOS
        if (s_gps_query_active && wb_time_reached(now, s_gps_query_deadline_ms)) {
            s_gps_query_active = 0;
            ESP_LOGW(TAG, "GPS 查询 %d ms 超时：gps=null（SOS 已发出，不受影响）",
                     WB_GPS_QUERY_TIMEOUT_MS);
        }
#endif

        /* 5.4 蜂鸣器：3 短声循环收紧；30s 后自动静音，但事件仍未确认 */
        gpio_set_level(WB_BZ_GPIO, wb_buzzer_level(&s_bz, now));
        if (wb_buzzer_active(&s_bz)) {
            uint32_t bz_elapsed = wb_buzzer_elapsed_ms(&s_bz, now);
            if (bz_elapsed >= WB_SOS_MUTE_MS && !s_mute_logged) {
                s_mute_logged = 1;
                ESP_LOGW(TAG,
                         "SOS 提示已 30s：自动静音（事件仍未确认，每 30s 单短提示直到 ACK）");
            }
        } else {
            s_mute_logged = 0;
        }

        /* 5.5 未确认重试：每 10s 重发同一 alarmId；无链路状态可感知时一直重试 */
        if (wb_event_should_resend(&s_ev, now, WB_SOS_RETRY_MS)) {
            ESP_LOGI(TAG, "未收到匹配 ACK：重发 SOS（沿用同一 alarmId=%s）", s_ev.alarm_id);
            wb_send_sos(0);
        }

        /* 5.6 心跳：每 30s 一条 hb（state/alarm；csq 已知才带；启用电量时带 battery） */
        if (wb_time_reached(now, s_last_hb_ms + WB_HB_INTERVAL_MS)) {
#if CONFIG_NODE_BATTERY_ADC_CHANNEL >= 0
            /* 先采一次再发，保证心跳里的电量是本周期真实采样结果（不是旧值/默认值） */
            wb_battery_tick(now);
#endif
            wb_send_hb(now);
            s_last_hb_ms = now;
        }

        vTaskDelay(pdMS_TO_TICKS(WB_BTN_SAMPLE_MS));
    }
}
