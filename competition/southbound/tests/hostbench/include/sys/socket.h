/*
 * 仅台架构建使用：mingw-w64 不提供 POSIX <sys/socket.h>。
 * 这里把 homemon 用到的最小套接字子集映射到 winsock2，并统一 fd 抽象
 * （socket fd = 1024+槽位；close() 由 prelude 的 hb_close 分流）。
 */
#ifndef HOSTBENCH_SYS_SOCKET_H
#define HOSTBENCH_SYS_SOCKET_H

#include <winsock2.h>
#include <ws2tcpip.h>
#include <sys/types.h>
#include <stddef.h>

#ifndef MSG_NOSIGNAL
#define MSG_NOSIGNAL 0
#endif

int hb_socket(int domain, int type, int protocol);
int hb_setsockopt(int fd, int level, int optname, const void *optval, int optlen);
int hb_bind(int fd, const struct sockaddr *addr, int addrlen);
int hb_listen(int fd, int backlog);
int hb_accept(int fd, struct sockaddr *addr, int *addrlen);
long hb_send(int fd, const void *buf, size_t len, int flags);
long hb_recv(int fd, void *buf, size_t len, int flags);
int hb_close(int fd);

#define socket     hb_socket
#define setsockopt hb_setsockopt
#define bind       hb_bind
#define listen     hb_listen
#define accept     hb_accept
#define send       hb_send
#define recv       hb_recv

#endif
