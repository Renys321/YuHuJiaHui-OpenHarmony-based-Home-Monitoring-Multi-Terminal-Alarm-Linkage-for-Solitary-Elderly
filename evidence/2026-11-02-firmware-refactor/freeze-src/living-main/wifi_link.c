/* Wi-Fi STA + SNTP。
 *
 * 断线后立刻 esp_wifi_connect() 重连，网络任务只负责看“有没有 IP”这个事件位；
 * 重连节奏交给 ESP-IDF 自己，不在这里叠加退避，避免和驱动内部重试打架。
 */
#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "esp_wifi.h"
#include "esp_event.h"
#include "esp_netif.h"
#include "esp_log.h"
#include "esp_sntp.h"

#include "wifi_link.h"
#include "node_common.h"

#define WIFI_CONNECTED_BIT BIT0

/* 事件组只保存“当前是否已拿到 IP”这一个位：
 * STA_START 后发起连接，断开清位并立刻重连，拿到 IP 置位。
 * 网络任务（gw_link.c / speaker_link.c / mic_link.c）只读这个位，
 * 不直接处理 Wi-Fi 事件，耦合最小。 */
static EventGroupHandle_t s_wifi_events;

/* Wi-Fi / IP 事件的统一回调。
 * 注意 WIFI_EVENT_STA_DISCONNECTED 里调用 esp_wifi_connect() 是 ESP-IDF 推荐做法：
 * 驱动内部会自己控制重试节奏，这里不要再加延时或退避。
 * reason 只用于日志排查（如 201=密码错、15=找不到 AP）。 */
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

/* 初始化并启动 Wi-Fi STA（不阻塞等待连接，连上后由事件组通知）。
 * 几个关键选择：
 *   - WIFI_STORAGE_RAM：SSID/密码只来自编译配置，不写 NVS，换配置重刷即生效；
 *   - WIFI_PS_NONE：关省电，保证上报/语音延迟稳定（代价是功耗更高）；
 *   - 只开 11b/g/n：板载天线和热点场景够用，省掉 11ax 兼容问题；
 *   - 密码为空才允许开放网络，否则强制 WPA2-PSK。 */
void wifi_start(void)
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
    /* 有些手机热点广播可选 PMF，但 S3 主动协商时反而认证失败；本项目只用 WPA2，
     * 直接把 PMF 关掉。 */
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

/* 查询是否连着 Wi-Fi（拿到 IP 才算连上，仅关联 AP 不算）。
 * wifi_start() 之前调用返回 false，不会解引用空事件组。 */
bool wifi_connected(void)
{
    if (s_wifi_events == NULL) return false;
    return (xEventGroupGetBits(s_wifi_events) & WIFI_CONNECTED_BIT) != 0;
}

/* 启动 SNTP 轮询同步，两个服务器互为备份（阿里云优先，国内网络可达性好）。
 * 同步成功与否不在这里判断：node_main.c 在主循环里看 time() 是否大于
 * 2023 年，判定“已同步”，并据此决定告警 ID 用真实时间还是上电随机盐。 */
void wifi_time_sync_start(void)
{
    esp_sntp_setoperatingmode(ESP_SNTP_OPMODE_POLL);
    esp_sntp_setservername(0, "ntp.aliyun.com");
    esp_sntp_setservername(1, "cn.pool.ntp.org");
    esp_sntp_init();
}
