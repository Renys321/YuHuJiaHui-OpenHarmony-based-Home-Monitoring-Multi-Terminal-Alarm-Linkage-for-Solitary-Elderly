/*
 * 仅台架构建使用：
 * mingw-w64 没有 <sys/ioctl.h>，homemon 只用到 ioctl() 原型（I2C 选地址）；
 * 台架实现在 hostbench_compat.c 里恒失败（没有 I2C → 温湿度 valid=false）。
 */
#ifndef HOSTBENCH_SYS_IOCTL_H
#define HOSTBENCH_SYS_IOCTL_H

#ifdef __cplusplus
extern "C" {
#endif

int ioctl(int fd, unsigned long request, ...);

#ifdef __cplusplus
}
#endif

#endif
