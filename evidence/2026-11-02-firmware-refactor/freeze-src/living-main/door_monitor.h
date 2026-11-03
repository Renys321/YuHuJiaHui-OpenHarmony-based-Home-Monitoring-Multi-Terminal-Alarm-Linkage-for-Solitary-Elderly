#ifndef DOOR_MONITOR_H
#define DOOR_MONITOR_H

/* 门磁模块对外接口。
 *
 * 功能：读干簧管 GPIO -> 去抖 -> 建立上电基线 -> 生成带 seq 的事件 ->
 *       持久化到 NVS，断网/重启后可以补传。
 *
 * 关键约定：
 *   - 事件用 seq 标识，seq 单调递增并写入 NVS；后端按 (deviceId, seq) 幂等去重。
 *   - 上电后第一次稳定读数只作为基线，不算“开/关门事件”；
 *     基线建立之前 open 字段上报 null，避免凭空造出一条历史事件。
 *   - 时间未同步时事件 ts 记 0，由服务器按接收时间补。
 *   - 门磁未启用（CONFIG_NODE_DOOR_GPIO < 0）时，所有函数都有空实现，
 *     上报里仍保留旧的 "door":{"open":false,"lastOpenTs":0} 兼容字段。 */

#include <stddef.h>

/* 初始化门磁：配置 GPIO 输入（上拉/下拉按有效电平）、从 NVS 恢复 seq 和缓存事件。
 * 上电时不产生事件；第一次 poll 会先建立基线。 */
void door_monitor_start(void);

/* 采样一次门磁，内部做去抖和事件入队。
 * 参数：
 *   time_synced - 系统时间是否已同步；为 0 时新事件 ts 记 0
 *   bench_raw   - 台架注入电平：0=关、1=开，-1=读真实 GPIO
 * 调用频率由主循环决定（约 1 秒一次）；去抖次数由 Kconfig 决定。
 * 有状态变化时可能写 NVS（缓存事件/seq）。 */
void door_monitor_poll(int time_synced, int bench_raw);

/* 生成 report() 里的门磁 JSON 片段，例如：
 *   "door":{"open":false,"lastOpenTs":1710000000000,"lastCloseTs":0,"seq":7,
 *           "events":[{"seq":6,"open":true,"ts":...}]},
 * 注意结尾自带逗号，方便直接拼进 sensors 对象。
 * out_sz 至少 700 字节；内部按剩余空间截断，不会越界。
 * 门磁未启用时输出旧的兼容字段，字段更少但语义相同。 */
void door_report_json(char *out, size_t out_sz);

#endif /* DOOR_MONITOR_H */
