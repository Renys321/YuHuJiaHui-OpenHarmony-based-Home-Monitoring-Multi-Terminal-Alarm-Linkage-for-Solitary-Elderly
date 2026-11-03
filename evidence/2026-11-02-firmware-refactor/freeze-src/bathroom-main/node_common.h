#ifndef NODE_COMMON_H
#define NODE_COMMON_H

/* 公共小工具头文件。
 * 这里只放“所有模块都会用到、又不依赖具体硬件”的东西：
 *   - 统一日志 TAG
 *   - NVS 命名空间
 *   - 读取 Unix 毫秒的 node_now_ms()
 * 不在这里放全局状态，免得各模块之间产生隐式耦合。 */

#include <stdint.h>
#include <sys/time.h>

/* 串口日志统一用这个 TAG，验收脚本和现场排查都按它过滤。
 * 例如：idf.py monitor | grep elder-node
 * 改动这个字符串会让现场排查脚本失效，所以保持 "elder-node" 不变。 */
#define TAG "elder-node"

/* 节点 NVS 命名空间：监护暂停和门磁序号共用。
 * NVS 里的 key 是“命名空间 + key 名”两级结构，这里定的是命名空间，
 * 具体 key（如 "door_seq"、"monitor_paused"）由各模块自己定义。
 * 改这个名字等于让老设备读不到原有数据，升级时要特别小心。 */
#define NODE_NVS_NS "elder_node"

/* 返回当前 Unix 时间戳，单位毫秒。
 *
 * 注意：
 *   1. 返回值来自系统时钟，只有 SNTP 同步成功后才是真实时间；
 *      同步前通常是 1970 年附近的数，调用方要先看 s_time_synced。
 *   2. tv_sec 先强转成 int64_t 再乘 1000。ESP32-S3 上 long 是 32 位，
 *      如果直接 tv_sec * 1000，2038 年之前就会溢出成负数。
 *   3. 这个函数只读时钟，不做任何阻塞操作，可以在任务和定时逻辑里放心调用。 */
static inline int64_t node_now_ms(void)
{
    struct timeval tv;
    gettimeofday(&tv, NULL);
    return (int64_t)tv.tv_sec * 1000 + tv.tv_usec / 1000;
}

#endif /* NODE_COMMON_H */
