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

/* 全局连接状态。同一时刻只有一个 socket：网关是本节点唯一的上报通道。
 * s_rx 是“半行缓存”：TCP 不保证一次 recv 就是一条完整 JSON，
 * 必须自己按 '\n' 拼行，跨 recv 的残行留在这里。 */
static int    s_sock = -1;
static char   s_rx[1024];
static size_t s_rxlen = 0;
static volatile uint32_t s_sent_count = 0;   /* 写成功的整条报文数，供 SOS 判断“已送达 Bridge” */
static void (*s_command_handler)(const char *line) = NULL;   /* 非语音构建：主循环直接回调 */

#if CONFIG_NODE_VOICE_ENABLED
/* 语音构建里上报和命令都跨任务，用两个队列传：
 *   s_reports  深度 1 —— 只保留最新状态。网络慢时旧状态直接被子覆盖，
 *              不会积压出一串过期上报；
 *   s_commands 深度 4 —— 网关 / 串口进来的命令，主循环每拍最多取 4 条。 */
typedef struct { char text[REPORT_JSON_MAX]; } report_message_t;
typedef struct { char text[CMD_LINE_MAX]; }    command_message_t;
static QueueHandle_t s_reports;
static QueueHandle_t s_commands;
#endif

/* 注册“收到一行命令后交给谁执行”。node_main.c 启动时把 handle_command 传进来。
 * 非语音构建会在 gw_poll()/串口任务里直接调用它（主循环上下文）；
 * 语音构建则由主循环 gw_drain_commands() 取出来再调用，避免在网关任务里执行耗时操作。 */
void gw_set_command_handler(void (*handler)(const char *line))
{
    s_command_handler = handler;
}

/* 已成功写出到 Bridge 的整条报文计数。
 * 只证明“TCP 写完了”，不证明云端入库、也不证明监护人已确认；
 * node_main.c 用它在日志里区分“SOS 已送出”和“仍在等网络”。 */
uint32_t gw_sent_count(void)
{
    return s_sent_count;
}

/* 建立一次到网关的 TCP 连接，成功返回 fd，失败返回 -1。
 * 用的是 getaddrinfo 而不是写死 IP：Kconfig 里可以填主机名。
 * 语音构建额外设置 1 秒发送超时 —— 发送在网络任务里做，网线/网关卡住时
 * 不能让整个任务无限期阻塞，超时后就关连接重来。
 * 连接成功后清空半行缓存，确保上一条连接残留的半条 JSON 不会拼到新连接上。 */
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

/* 确保连接可用（非语音构建由主循环调用）。
 * 已经连着就直接返回 0；断了才尝试重连，失败返回 -1，
 * 由调用方决定等多久再试，这里不做无限重试。 */
int gw_ensure_connected(void)
{
    if (s_sock >= 0) return 0;
    s_sock = gw_connect();
    return s_sock < 0 ? -1 : 0;
}

/* 上报一条完整 JSON（调用方保证以 '\n' 结尾）。
 * 语音构建：只把最新快照塞进 s_reports，真正的 send 在 gateway_task 里做；
 *   队列深度为 1，覆盖式写入，网络慢时不会堆积历史状态。
 * 非语音构建：主循环自己发；发送失败只关连接并置 -1，下轮会重连。
 * 注意这里不重试半条报文：宁可整条丢了下次重发状态，也不让两条 JSON 粘在一起。 */
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

/* 非阻塞收一次数据：读出所有以 '\n' 结尾的完整命令行，残留半行留在 s_rx。
 * recv 返回 0 表示对端关闭（bridge 退出/网络断），立刻关连接；
 * 返回 -1 且非阻塞模式下通常只是“暂时没数据”，保持连接不动。
 * 语音构建把整行命令放进 s_commands，队列满就丢这一条并告警；
 * 非语音构建直接调用回调（在主循环上下文执行）。 */
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
/* 创建两个任务间队列。必须在启动网络任务前调用；
 * 任一创建失败返回 -1，调用方只让它日志告警，本地采集/语音继续工作。 */
int gw_queues_create(void)
{
    s_reports = xQueueCreate(1, sizeof(report_message_t));
    s_commands = xQueueCreate(4, sizeof(command_message_t));
    return (s_reports && s_commands) ? 0 : -1;
}

/* 语音构建的网络任务（栈 6144，优先级 3），负责：
 *   1. Wi-Fi 断了就关 socket，等重连；
 *   2. 没连接就尝试连接（DNS/connect 只阻塞这个任务，不影响主循环）；
 *   3. 每 100ms 收一次命令；
 *   4. 取一条待发状态并完整写出，写完整条才计数。
 * 发送中途失败：关连接、保留 s_sock=-1，然后把这条报文放回队列重发。
 * 放回时若主循环已经写了更新的状态（覆盖式队列），旧报文自然被丢掉，
 * 这正符合“只发最新状态”的语义。 */
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

/* 启动网络任务。失败返回 -1（通常是内存不足）。 */
int gw_worker_start(void)
{
    return xTaskCreate(gateway_task, "gateway-net", 6144, NULL, 3, NULL) == pdPASS ? 0 : -1;
}

/* 主循环专用：从命令队列取最多 max 条交给 handler 执行。
 * 限制条数是为了让语音播放、传感器采样、SOS 快路径不会被一长串命令饿死。 */
void gw_drain_commands(void (*handler)(const char *line), int max)
{
    command_message_t command;
    for (int i = 0; s_commands && i < max && xQueueReceive(s_commands, &command, 0) == pdTRUE; i++)
        handler(command.text);
}
#endif /* CONFIG_NODE_VOICE_ENABLED */

#if CONFIG_NODE_ALARM_BENCH_INJECT || CONFIG_NODE_VOICE_ENABLED
/* UART0（板载 CH340）逐行读命令，塞进和网关同一个队列，由主任务执行。
 * 台架用来注入传感器；现场用来跑 mictest / micupload 自检。
 *
 * 细节：
 *   - 只用 RX，TX 留给 ESP_LOG 输出，互不干扰；
 *   - 按 '\n' 切行，忽略 '\r'；单行上限 255 字节，超长部分丢弃；
 *   - 语音构建写入 s_commands（和网关命令同队列，队列满则丢弃并告警）；
 *   - 非语音构建直接回调，在主循环上下文执行。
 * 两个板子的 COM 口虽然不同（COM9/COM6），协议完全相同。 */
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

/* 启动串口命令任务（栈 4096，优先级 3）。
 * 语音构建要求命令队列已创建，否则直接返回 -1；
 * task_name 用来区分场景（"bench-uart" / "serial-cmd"），方便看任务栈水位日志。 */
int gw_serial_start(const char *task_name)
{
#if CONFIG_NODE_VOICE_ENABLED
    if (!s_commands) return -1;
#endif
    return xTaskCreate(serial_command_task, task_name, 4096, NULL, 3, NULL) == pdPASS ? 0 : -1;
}
#endif /* CONFIG_NODE_ALARM_BENCH_INJECT || CONFIG_NODE_VOICE_ENABLED */
