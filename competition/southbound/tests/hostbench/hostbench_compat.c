/*
 * hostbench_compat.c — 仅用于“本地台架进程级验证”的 Windows(POSIX 模拟)兼容层。
 *
 * 生产代码（src/homemon.c）不做任何条件编译；台架构建只是额外链接本文件，
 * 用它补上 mingw-w64 缺失的 POSIX 接口。语义上刻意保持“失败要显式失败”：
 *   - 没有 I2C：ioctl 恒失败 → 温湿度 valid=false（等价于没接传感器）；
 *   - 没有校时权限：settimeofday 恒失败 → 日志明确写“TIME 设置失败”；
 *   - 套接字：winsock2 + FIONBIO 模拟非阻塞 accept/recv。
 *
 * 这不是真机证据：只用于验证进程级状态机/JSON 输出。
 */
#ifndef _WIN32
#error "hostbench_compat.c 只用于 Windows 台架构建"
#endif

#include <winsock2.h>
#include <ws2tcpip.h>
#include <io.h>
#include <fcntl.h>
#include <errno.h>
#include <time.h>
#include <windows.h>
#include <direct.h>
#include <stdarg.h>

/* -include prelude.h 也作用于本文件；实现层必须用 winsock/CRT 的原生名字，
   否则 hb_socket() 里的 socket() 会被宏换成自己 → 无限递归（栈溢出）。 */
#undef socket
#undef setsockopt
#undef bind
#undef listen
#undef accept
#undef send
#undef recv
#undef close
#undef mkdir
#undef fcntl
#undef localtime_r
#undef clock_gettime

/* fd 抽象：winsock SOCKET 放进 [HB_FD_BASE, HB_FD_BASE+HB_MAX_SOCK) 的槽位，
   与 CRT 文件 fd 完全隔离；close() 由 prelude 的 hb_close 分流。 */
#define HB_FD_BASE 1024
#define HB_MAX_SOCK 64

static SOCKET g_sock[HB_MAX_SOCK];

static void hb_wsastartup(void) __attribute__((constructor));
static void hb_wsastartup(void)
{
    WSADATA d;
    WSAStartup(MAKEWORD(2, 2), &d);
}

static int hb_fd_to_slot(int fd)
{
    if (fd < HB_FD_BASE || fd >= HB_FD_BASE + HB_MAX_SOCK) return -1;
    int slot = fd - HB_FD_BASE;
    if (g_sock[slot] == INVALID_SOCKET || g_sock[slot] == 0) return -1;
    return slot;
}

static int hb_reg(SOCKET s)
{
    for (int i = 0; i < HB_MAX_SOCK; i++) {
        if (g_sock[i] == INVALID_SOCKET || g_sock[i] == 0) {
            g_sock[i] = s;
            return HB_FD_BASE + i;
        }
    }
    return -1;
}

static void hb_set_errno(void)
{
    switch (WSAGetLastError()) {
    case WSAEWOULDBLOCK: errno = EAGAIN; break;
    case WSAEINTR:       errno = EINTR;  break;
    case WSAECONNRESET:  errno = ECONNRESET; break;
    case WSAENOTSOCK:    errno = EBADF;  break;
    default:             errno = EIO;    break;
    }
}

int hb_socket(int domain, int type, int protocol)
{
    SOCKET s = socket(domain, type, protocol);
    if (s == INVALID_SOCKET) { hb_set_errno(); return -1; }
    int fd = hb_reg(s);
    if (fd < 0) { closesocket(s); errno = EMFILE; return -1; }
    return fd;
}

int hb_setsockopt(int fd, int level, int optname, const void *optval, int optlen)
{
    int slot = hb_fd_to_slot(fd);
    if (slot < 0) { errno = EBADF; return -1; }
    if (setsockopt(g_sock[slot], level, optname, (const char *)optval, optlen) != 0) {
        hb_set_errno();
        return -1;
    }
    return 0;
}

int hb_bind(int fd, const struct sockaddr *addr, int addrlen)
{
    int slot = hb_fd_to_slot(fd);
    if (slot < 0) { errno = EBADF; return -1; }
    if (bind(g_sock[slot], addr, addrlen) != 0) { hb_set_errno(); return -1; }
    return 0;
}

int hb_listen(int fd, int backlog)
{
    int slot = hb_fd_to_slot(fd);
    if (slot < 0) { errno = EBADF; return -1; }
    if (listen(g_sock[slot], backlog) != 0) { hb_set_errno(); return -1; }
    return 0;
}

int hb_accept(int fd, struct sockaddr *addr, int *addrlen)
{
    int slot = hb_fd_to_slot(fd);
    if (slot < 0) { errno = EBADF; return -1; }
    int len = addrlen ? *addrlen : 0;
    SOCKET s = accept(g_sock[slot], addr, addrlen ? &len : NULL);
    if (s == INVALID_SOCKET) { hb_set_errno(); return -1; }
    int nfd = hb_reg(s);
    if (nfd < 0) { closesocket(s); errno = EMFILE; return -1; }
    return nfd;
}

long hb_send(int fd, const void *buf, size_t len, int flags)
{
    int slot = hb_fd_to_slot(fd);
    if (slot < 0) { errno = EBADF; return -1; }
    int n = send(g_sock[slot], (const char *)buf, (int)len, flags);
    if (n < 0) { hb_set_errno(); return -1; }
    return (long)n;
}

long hb_recv(int fd, void *buf, size_t len, int flags)
{
    int slot = hb_fd_to_slot(fd);
    if (slot < 0) { errno = EBADF; return -1; }
    int n = recv(g_sock[slot], (char *)buf, (int)len, flags);
    if (n < 0) { hb_set_errno(); return -1; }
    return (long)n;
}

int hb_close(int fd)
{
    int slot = hb_fd_to_slot(fd);
    if (slot >= 0) {
        closesocket(g_sock[slot]);
        g_sock[slot] = INVALID_SOCKET;
        return 0;
    }
    return _close(fd);
}

int hb_fcntl(int fd, int cmd, ...)
{
    va_list ap;
    va_start(ap, cmd);
    int arg = va_arg(ap, int);
    va_end(ap);
    int slot = hb_fd_to_slot(fd);
    if (slot < 0) { errno = EBADF; return -1; }
    if (cmd == F_SETFL && (arg & O_NONBLOCK)) {
        u_long on = 1;
        if (ioctlsocket(g_sock[slot], FIONBIO, &on) != 0) { hb_set_errno(); return -1; }
        return 0;
    }
    return 0;
}

int ioctl(int fd, unsigned long request, ...)
{
    (void)fd; (void)request;
    errno = ENOTTY;          /* 台架没有 I2C：SHT30 因此 valid=false */
    return -1;
}

/* ---------------------------------------------------------------- 时钟 */
/* 台架用“进程内偏移”模拟 hdc date -s / PC 网关校时：绝不修改本机系统时钟。
   settimeofday() 只记录偏移；hb_clock_gettime() 返回真实时间+偏移，
   因此 homemon 会走真实的“校时 + 时钟跳变平移”路径。 */
static long long g_clock_offset_ms = 0;

static long long hb_real_epoch_ms(void)
{
    FILETIME ft;
    ULARGE_INTEGER u;
    GetSystemTimeAsFileTime(&ft);
    u.LowPart = ft.dwLowDateTime;
    u.HighPart = ft.dwHighDateTime;
    /* FILETIME = 100ns since 1601-01-01 */
    unsigned long long ms = u.QuadPart / 10000ULL;
    return (long long)(ms - 11644473600000ULL);
}

int settimeofday(const struct timeval *tv, const struct timezone *tz)
{
    (void)tz;
    if (!tv) { errno = EINVAL; return -1; }
    long long want = (long long)tv->tv_sec * 1000LL + (long long)tv->tv_usec / 1000LL;
    g_clock_offset_ms = want - hb_real_epoch_ms();
    return 0;
}

int hb_clock_gettime(int clk_id, struct timespec *tp)
{
    (void)clk_id;            /* homemon 只用 CLOCK_REALTIME */
    if (!tp) { errno = EINVAL; return -1; }
    long long ms = hb_real_epoch_ms() + g_clock_offset_ms;
    tp->tv_sec = (time_t)(ms / 1000LL);
    tp->tv_nsec = (long)((ms % 1000LL) * 1000000LL);
    return 0;
}

int hb_mkdir(const char *path, int mode)
{
    (void)mode;
    return _mkdir(path);
}
