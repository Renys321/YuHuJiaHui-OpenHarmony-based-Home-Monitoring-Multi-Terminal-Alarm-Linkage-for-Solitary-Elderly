#ifndef GW_LINK_H
#define GW_LINK_H

#include <stdint.h>
#include "sdkconfig.h"

/* 命令入口：网关行和串口行最后都交给它，保证只在一个任务里改状态 */
void gw_set_command_handler(void (*handler)(const char *line));

void gw_send(const char *text);
void gw_poll(void);            /* 非语音构建：主循环里直接读 socket */
int  gw_ensure_connected(void);/* 0=已连接；-1=本次连接失败 */
uint32_t gw_sent_count(void);

#if CONFIG_NODE_VOICE_ENABLED
int  gw_queues_create(void);   /* 0=成功 */
int  gw_worker_start(void);    /* 网络任务：连网关、收命令、发状态 */
void gw_drain_commands(void (*handler)(const char *line), int max);
#endif

#if CONFIG_NODE_ALARM_BENCH_INJECT || CONFIG_NODE_VOICE_ENABLED
int  gw_serial_start(const char *task_name);    /* UART0 逐行命令任务 */
#endif

#endif /* GW_LINK_H */
