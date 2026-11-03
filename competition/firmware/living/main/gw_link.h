#ifndef GW_LINK_H
#define GW_LINK_H

/* 与 PC 网关（mqtt_bridge.js）之间的 TCP JSON 行链路。
 *
 * 协议：节点作为客户端连到 CONFIG_NODE_GW_HOST:CONFIG_NODE_GW_PORT，
 * 一条状态就是一个单行 JSON，以 '\n' 结尾；网关下发的命令也是单行文本。
 * 节点不直接连 MQTT，由 PC 上的 bridge 转发，APP/云端因此不需要区分节点来源。
 *
 * 两种编译形态：
 *   1. 语音构建（CONFIG_NODE_VOICE_ENABLED=y）：
 *      独立任务 gateway-net 持有 socket；上报走深度为 1 的“覆盖式邮箱”，
 *      网络慢时只保留最新状态；命令走深度为 4 的队列，由主任务取出执行。
 *   2. 非语音构建：
 *      不起网络任务，主循环调用 gw_poll() 收发，命令在调用线程里直接执行。
 *
 * 线程约定：
 *   - s_command_handler 由主任务执行，所有状态修改都发生在主任务，避免竞态。
 *   - gw_send() 可在任意任务调用；它只投递，不直接操作 socket（语音构建）。
 *   - 断线时不会把半条 JSON 拼到下一条连接上。 */

#include <stdint.h>
#include "sdkconfig.h"

/* 注册命令处理函数。网关下发的每一行、串口输入的每一行，最终都交给它。
 * 语音构建下它由主任务调用；非语音构建下由 gw_poll() 的调用者执行。
 * 传 NULL 表示暂不处理命令（命令会被直接丢弃）。 */
void gw_set_command_handler(void (*handler)(const char *line));

/* 请求上报一条状态 JSON（通常以 '\n' 结尾）。
 * 语音构建：写入覆盖式邮箱，队列满时覆盖旧的，保证网关拿到的是最新状态。
 * 非语音构建：若已连接则直接 send；发送失败就关闭连接，下次重连。
 * 本函数不保证“云端已入库”，只保证“尝试写出”。 */
void gw_send(const char *text);

/* 非语音构建的主循环收包函数：非阻塞读取 socket，按 '\n' 切分命令并交给
 * s_command_handler；连接被对端关闭时关闭本地 socket。语音构建不使用它，
 * 由 gateway-net 任务内部调用。 */
void gw_poll(void);

/* 确保已连接网关。
 * 返回 0 = 当前已连接；-1 = 本次连接失败（DNS 解析、建 socket 或 connect 失败）。
 * 语音构建下由网络任务调用；非语音构建下由主循环在发送前调用。
 * 失败不会阻塞太久，调用方应自行决定重试间隔。 */
int  gw_ensure_connected(void);

/* 已“整条成功写出”的状态报文数量。
 * 用途：SOS 状态机用它判断本次求助是否已经送达 bridge。
 * 注意：只代表本机 socket 写成功，不代表 bridge 转发成功，更不代表云端入库。 */
uint32_t gw_sent_count(void);

#if CONFIG_NODE_VOICE_ENABLED
/* 创建上报邮箱（深度 1）和命令队列（深度 4）。
 * 返回 0 = 成功；-1 = 内存不足。必须在 gw_worker_start() 之前调用。 */
int  gw_queues_create(void);

/* 启动 gateway-net 网络任务（栈 6144 字节，优先级 3）。
 * 任务职责：等 Wi-Fi、连网关、收命令、把邮箱里的最新状态整条发出去。
 * 返回 0 = 创建成功；-1 = 任务创建失败。 */
int  gw_worker_start(void);

/* 从命令队列取出最多 max 条命令，逐条调用 handler。
 * 由主任务在采样循环里调用，确保命令执行与传感器状态修改在同一线程。
 * 队列为空时立即返回。 */
void gw_drain_commands(void (*handler)(const char *line), int max);
#endif

#if CONFIG_NODE_ALARM_BENCH_INJECT || CONFIG_NODE_VOICE_ENABLED
/* 启动 UART0 命令任务（115200 8N1，按行读取）。
 * 台架构建用它注入传感器值；语音构建用它执行 mictest/micupload 等自检命令。
 * task_name 仅用于调试器里区分任务，FreeRTOS 最多保留 16 个字符。
 * 返回 0 = 成功；-1 = 任务创建失败（或语音构建下队列尚未创建）。 */
int  gw_serial_start(const char *task_name);
#endif

#endif /* GW_LINK_H */
