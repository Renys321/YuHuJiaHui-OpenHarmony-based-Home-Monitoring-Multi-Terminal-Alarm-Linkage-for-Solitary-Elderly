#ifndef WIFI_LINK_H
#define WIFI_LINK_H

/* Wi-Fi STA 与时间同步接口。
 *
 * 连接策略：
 *   - 上电后由 ESP-IDF 事件回调驱动：STA_START 时发起连接，
 *     STA_DISCONNECTED 时清“已连接”标志并立刻重连，
 *     拿到 IP（IP_EVENT_STA_GOT_IP）时置位“已连接”标志。
 *   - 不在应用层叠加退避，重试节奏交给 Wi-Fi 驱动，避免两套重试互相干扰。
 *   - 电源管理关闭（WIFI_PS_NONE），保证 socket 收发不被省电模式拖慢。
 *
 * 时间同步：
 *   - SNTP 服务器依次是 ntp.aliyun.com、cn.pool.ntp.org；
 *   - 采用轮询模式，同步是否成功由 node_main.c 检查系统年份判断，
 *     这里不阻塞等待。时间没同步时，上报 ts 可能为 0 或 1970 年附近。 */

#include <stdbool.h>

/* 初始化 netif、事件循环、Wi-Fi 驱动和 STA 配置，然后启动 Wi-Fi。
 * SSID/密码来自 sdkconfig 的 CONFIG_NODE_WIFI_SSID / CONFIG_NODE_WIFI_PASS；
 * 密码为空时按开放网络处理，否则按 WPA2-PSK。
 * 配置类错误会 ESP_ERROR_CHECK 重启，属于烧录前的配置问题。 */
void wifi_start(void);

/* 查询当前是否已拿到 IP。
 * 返回 true 表示 Wi-Fi 已连接且 DHCP 成功，可以尝试建 TCP；
 * 返回 false 表示未连接、正在重连或尚未初始化。
 * 该函数只读事件组，不阻塞，可在任意任务调用。 */
bool wifi_connected(void);

/* 启动 SNTP 时间同步（轮询模式，不阻塞）。
 * 只要 Wi-Fi 可用就会后台请求时间；调用一次即可，重复调用没有额外效果。
 * 同步结果不被保存成标志，主循环通过系统时间是否晚于 2020 年来判断。 */
void wifi_time_sync_start(void);

#endif /* WIFI_LINK_H */
