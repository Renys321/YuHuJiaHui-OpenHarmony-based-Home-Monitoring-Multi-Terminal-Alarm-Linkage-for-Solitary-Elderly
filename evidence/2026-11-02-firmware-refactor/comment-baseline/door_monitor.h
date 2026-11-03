#ifndef DOOR_MONITOR_H
#define DOOR_MONITOR_H

#include <stddef.h>

void door_monitor_start(void);
/* bench_raw: 台架注入电平（0/1），-1 表示读真实 GPIO */
void door_monitor_poll(int time_synced, int bench_raw);
/* 输出 report() 里的 "door":{...}, 片段；门磁未启用时输出旧的兼容字段 */
void door_report_json(char *out, size_t out_sz);

#endif /* DOOR_MONITOR_H */
