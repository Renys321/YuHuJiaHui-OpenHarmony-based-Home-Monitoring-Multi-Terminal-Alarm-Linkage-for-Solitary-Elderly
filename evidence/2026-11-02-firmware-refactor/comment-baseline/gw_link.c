/* 到 PC 网关的 TCP 链路，走和主控 homemon 一样的 JSON 行协议。
 *
 * 节点不做 MQTT，bridge 发现它之后 APP 侧零改动。这个文件只负责连接、
 * 收发和任务调度；命令具体怎么执行、状态怎么生成，留给 node_main.c。
 *
 * 收发分属不同任务：
 *   - 语音构建：gateway-net 独占 socket，上报走 1 条覆盖式邮箱（只要最新状态）；
 *   - 非语音构建：主循环自己连、自己收，不额外起任务。
 * 断线时半条 JSON 不会被拼到下一条连接上：要么整条写出，要么关掉重来。
 */
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <sys/socket.h>
#include <netdb.h>
#include <arpa/inet.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"
#include "esp_log.h"
#if CONFIG_NODE_ALARM_BENCH_INJECT || CONFIG_NODE_VOICE_ENABLED
#include "driver/uart.h"
#endif

#include "gw_link.h"
#include "wifi_link.h"
#include "node_common.h"

#define REPORT_JSON_MAX 1600   /* 和 report() 的栈缓冲用同一个上限，长了会被截断 */
#define CMD_LINE_MAX    1024

static int    s_sock = -1;
static char   s_rx[1024];
static size_t s_rxlen = 0;
static volatile uint32_t s_sent_count = 0;
static void (*s_command_handler)(const char *line) = NULL;

#if CONFIG_NODE_VOICE_ENABLED
typedef struct { char text[REPORT_JSON_MAX]; } report_message_t;
typedef struct { char text[CMD_LINE_MAX]; }    command_message_t;
static QueueHandle_t s_reports;
static QueueHandle_t s_commands;
#endif

void gw_set_command_handler(void (*handler)(const char *line))
{
    s_command_handler = handler;
}

uint32_t gw_sent_count(void)
{
    return s_sent_count;
}

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
    /* 语音构建里发送发生在网络任务，不能无限期卡住 */
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

int gw_ensure_connected(void)
{
    if (s_sock >= 0) return 0;
    s_sock = gw_connect();
    return s_sock < 0 ? -1 : 0;
}

void gw_send(const char *text)
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
            s_sent_count++;   /* 只代表写出到 bridge，不代表云端入库 */
        }
    }
#endif
}

void gw_poll(void)
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
        if (s_command_handler) s_command_handler(p);
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
int gw_queues_create(void)
{
    s_reports = xQueueCreate(1, sizeof(report_message_t));
    s_commands = xQueueCreate(4, sizeof(command_message_t));
    return (s_reports && s_commands) ? 0 : -1;
}

static void gateway_task(void *arg)
{
    (void)arg;
    report_message_t message;
    for (;;) {
        if (!wifi_connected()) {
            if (s_sock >= 0) { close(s_sock); s_sock = -1; s_rxlen = 0; }
            vTaskDelay(pdMS_TO_TICKS(200));
            continue;
        }
        if (s_sock < 0) {
            s_sock = gw_connect();   /* DNS/connect 只阻塞这个任务 */
            if (s_sock < 0) { vTaskDelay(pdMS_TO_TICKS(1000)); continue; }
        }
        gw_poll();
        /* 没连上时状态留在队列里；发送中途失败只关连接，不把半条报文接到下一次 */
        if (s_sock >= 0 && xQueueReceive(s_reports, &message, 0) == pdTRUE) {
            size_t offset = 0, length = strlen(message.text);
            while (offset < length) {
                int n = send(s_sock, message.text + offset, length - offset, 0);
                if (n <= 0) { close(s_sock); s_sock = -1; break; }
                offset += (size_t)n;
            }
            /* 整条写完才计数；半条失败不算送达 */
            if (s_sock >= 0 && offset == length) s_sent_count++;
            /* 队列里没有更新的快照时，才把这条失败的重新放回去 */
            if (s_sock < 0) xQueueSend(s_reports, &message, 0);
            ESP_LOGI(TAG, "STACK_FREE task=gateway-net bytes=%u", (unsigned)uxTaskGetStackHighWaterMark(NULL));
        }
        vTaskDelay(pdMS_TO_TICKS(100));
    }
}

int gw_worker_start(void)
{
    return xTaskCreate(gateway_task, "gateway-net", 6144, NULL, 3, NULL) == pdPASS ? 0 : -1;
}

void gw_drain_commands(void (*handler)(const char *line), int max)
{
    command_message_t command;
    for (int i = 0; s_commands && i < max && xQueueReceive(s_commands, &command, 0) == pdTRUE; i++)
        handler(command.text);
}
#endif /* CONFIG_NODE_VOICE_ENABLED */

#if CONFIG_NODE_ALARM_BENCH_INJECT || CONFIG_NODE_VOICE_ENABLED
/* UART0（板载 CH340）逐行读命令，塞进和网关同一个队列，由主任务执行。
 * 台架用来注入传感器；现场用来跑 mictest / micupload 自检。 */
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
#if CONFIG_NODE_VOICE_ENABLED
                    command_message_t command = {0};
                    snprintf(command.text, sizeof(command.text), "%s", line);
                    if (xQueueSend(s_commands, &command, 0) != pdTRUE)
                        ESP_LOGW(TAG, "命令队列满，已丢弃: %s", line);
#else
                    if (s_command_handler) s_command_handler(line);
#endif
                    len = 0;
                }
            } else if (len < sizeof(line) - 1) {
                line[len++] = c;
            }
        }
    }
}

int gw_serial_start(const char *task_name)
{
#if CONFIG_NODE_VOICE_ENABLED
    if (!s_commands) return -1;
#endif
    return xTaskCreate(serial_command_task, task_name, 4096, NULL, 3, NULL) == pdPASS ? 0 : -1;
}
#endif /* CONFIG_NODE_ALARM_BENCH_INJECT || CONFIG_NODE_VOICE_ENABLED */
