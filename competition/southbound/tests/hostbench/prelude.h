/*
 * 仅台架构建使用（通过 -include 强制先包含）。
 *
 * homemon.c 是 POSIX/Linux 守护进程；在 Windows 上做“进程级 bench”时，
 * 用本文件 + hostbench_compat.c 补上 mingw-w64 缺失的少数 POSIX 能力：
 *   - POSIX 套接字头（sys/socket.h、netinet/in.h、arpa/inet.h）
 *   - fcntl(F_SETFL, O_NONBLOCK) → winsock FIONBIO
 *   - ioctl()（只用于 I2C，台架返回失败）
 *   - settimeofday()（台架恒失败；绝不改系统时钟）
 *   - localtime_r / suseconds_t（mingw 头文件不在默认 POSIX 宏下暴露）
 *   - close()：socket fd 需 closesocket，普通文件 fd 仍走 CRT _close
 *   - mkdir(path, mode)：mingw 只有单参数 _mkdir
 *
 * ⚠ 这是台架兼容层，不是真机证据；生产源码不做任何条件编译。
 */
#ifndef HOSTBENCH_PRELUDE_H
#define HOSTBENCH_PRELUDE_H

#include <time.h>
#include <sys/time.h>
#include <direct.h>
#include <sys/socket.h>   /* 本目录的 shim：winsock2 + fd 抽象 */

#ifndef CLOCK_REALTIME
#define CLOCK_REALTIME 0
#endif

#ifndef HOSTBENCH_SUSECONDS_T
#define HOSTBENCH_SUSECONDS_T
typedef long suseconds_t;   /* mingw 的 sys/types.h 不提供该 POSIX 别名 */
#endif

/* mingw 的 localtime_r 需要 POSIX 宏才可见；这里用 localtime_s 做等价封装。 */
static __inline struct tm *hb_localtime_r(const time_t *tt, struct tm *out)
{
    if (!tt || !out) return NULL;
    return localtime_s(out, tt) == 0 ? out : NULL;
}
#define localtime_r hb_localtime_r

/*
 * 时钟：台架用“进程内偏移”模拟 hdc date -s / PC 网关校时，绝不改系统时钟。
 *   - settimeofday() 只记录偏移并返回成功（homemon 会走真实的校时+跳变平移路径）；
 *   - clock_gettime(CLOCK_REALTIME) 返回真实时间 + 偏移。
 * 这样可以在真实进程里验证“时钟跳变不会产生假 NO_MOTION”，且不触碰本机时钟。
 */
int hb_clock_gettime(int clk_id, struct timespec *tp);
#define clock_gettime hb_clock_gettime

/* 台架实现：记录进程内时间偏移（不是修改系统时钟）。 */
int settimeofday(const struct timeval *tv, const struct timezone *tz);

/* close 分流：socket fd（1024+槽位）→ closesocket；其它 → CRT _close。 */
int hb_close(int fd);
#define close hb_close

/* mkdir(path, mode)：mingw 只有 _mkdir(path)。 */
int hb_mkdir(const char *path, int mode);
#define mkdir(path, mode) hb_mkdir((path), (mode))

/* fcntl(F_SETFL, O_NONBLOCK)：homemon 只对 socket 用这一种组合 → winsock FIONBIO。 */
#ifndef F_SETFL
#define F_SETFL 4
#endif
#ifndef O_NONBLOCK
#define O_NONBLOCK 0x0004
#endif
int hb_fcntl(int fd, int cmd, ...);
#define fcntl hb_fcntl

#endif
