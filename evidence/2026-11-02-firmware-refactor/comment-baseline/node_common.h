#ifndef NODE_COMMON_H
#define NODE_COMMON_H

#include <stdint.h>
#include <sys/time.h>

/* 串口日志统一用这个 TAG，验收脚本和现场排查都按它过滤 */
#define TAG "elder-node"

/* 节点 NVS 命名空间：监护暂停和门磁序号共用 */
#define NODE_NVS_NS "elder_node"

/* Unix 毫秒。tv_sec 先转 64 位再乘 1000：S3 上 long 只有 32 位，直接乘会溢出 */
static inline int64_t node_now_ms(void)
{
    struct timeval tv;
    gettimeofday(&tv, NULL);
    return (int64_t)tv.tv_sec * 1000 + tv.tv_usec / 1000;
}

#endif /* NODE_COMMON_H */
