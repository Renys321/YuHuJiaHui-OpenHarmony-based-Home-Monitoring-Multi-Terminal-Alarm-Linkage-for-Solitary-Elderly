#include "sdkconfig.h"
#include "speaker_link.h"
#if CONFIG_NODE_VOICE_ENABLED

#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include <errno.h>
#include <unistd.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <netdb.h>
#include <netinet/tcp.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "local_voice.h"

#ifndef CONFIG_NODE_AUDIO_PORT
#define CONFIG_NODE_AUDIO_PORT 9102
#endif

#define TAG "speaker-net"
#define CONNECT_TIMEOUT_MS 5000
#define IO_TIMEOUT_MS      500
#define IDLE_LIMIT_MS      15000
#define RETRY_DELAY_MS     3000
#define RX_BUF             2048
#define PCM_CHUNK          1024   /* bytes per recv/write, 512 mono samples */

static uint8_t s_rx[RX_BUF];
static size_t s_rxlen;

static int64_t now_ms(void)
{
    return (int64_t)xTaskGetTickCount() * portTICK_PERIOD_MS;
}

static int connect_gateway(void)
{
    struct addrinfo hints = { 0 };
    hints.ai_family = AF_INET;
    hints.ai_socktype = SOCK_STREAM;
    char port[8];
    snprintf(port, sizeof(port), "%d", CONFIG_NODE_AUDIO_PORT);
    struct addrinfo *res = NULL;
    if (getaddrinfo(CONFIG_NODE_GW_HOST, port, &hints, &res) != 0 || !res) {
        return -1;
    }
    int s = socket(res->ai_family, res->ai_socktype, res->ai_protocol);
    if (s < 0) { freeaddrinfo(res); return -1; }
    struct timeval rtv = { 0, IO_TIMEOUT_MS * 1000 };
    setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, &rtv, sizeof(rtv));
    struct timeval stv = { CONNECT_TIMEOUT_MS / 1000, (CONNECT_TIMEOUT_MS % 1000) * 1000 };
    setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, &stv, sizeof(stv));
    /* 空闲时网关不发数据；靠 TCP keepalive 探测断链，避免周期性重连产生“断开窗口”。 */
    int ka = 1;
    int ka_idle = 10;
    int ka_intvl = 3;
    int ka_cnt = 3;
    setsockopt(s, SOL_SOCKET, SO_KEEPALIVE, &ka, sizeof(ka));
    setsockopt(s, IPPROTO_TCP, TCP_KEEPIDLE, &ka_idle, sizeof(ka_idle));
    setsockopt(s, IPPROTO_TCP, TCP_KEEPINTVL, &ka_intvl, sizeof(ka_intvl));
    setsockopt(s, IPPROTO_TCP, TCP_KEEPCNT, &ka_cnt, sizeof(ka_cnt));
    if (connect(s, res->ai_addr, res->ai_addrlen) != 0) {
        freeaddrinfo(res);
        close(s);
        return -1;
    }
    freeaddrinfo(res);
    return s;
}

/* 从 socket 读取恰好 n 字节；期间允许短暂超时，但持续 IDLE_LIMIT_MS 无数据即失败。 */
static bool read_exact(int s, uint8_t *dst, size_t n)
{
    int64_t last = now_ms();
    while (n > 0) {
        if (s_rxlen > 0) {
            size_t take = s_rxlen < n ? s_rxlen : n;
            memcpy(dst, s_rx, take);
            memmove(s_rx, s_rx + take, s_rxlen - take);
            s_rxlen -= take;
            dst += take;
            n -= take;
            last = now_ms();
            continue;
        }
        int r = recv(s, dst, n, 0);
        if (r > 0) {
            dst += r;
            n -= (size_t)r;
            last = now_ms();
            continue;
        }
        if (r == 0) return false;
        if (errno == EAGAIN || errno == EWOULDBLOCK) {
            if (now_ms() - last > IDLE_LIMIT_MS) return false;
            continue;
        }
        return false;
    }
    return true;
}

/* 读一行 JSON（保留 recv 多读出来的 PCM 字节到 s_rx，避免与二进制数据错位）。 */
static bool read_line(int s, char *out, size_t cap)
{
    for (;;) {
        for (size_t i = 0; i < s_rxlen; ++i) {
            if (s_rx[i] == '\n') {
                size_t n = i < cap - 1 ? i : cap - 1;
                memcpy(out, s_rx, n);
                out[n] = 0;
                memmove(s_rx, s_rx + i + 1, s_rxlen - i - 1);
                s_rxlen -= i + 1;
                return true;
            }
        }
        if (s_rxlen >= sizeof(s_rx)) {
            s_rxlen = 0;
            return false;
        }
        int r = recv(s, s_rx + s_rxlen, sizeof(s_rx) - s_rxlen, 0);
        if (r > 0) { s_rxlen += (size_t)r; continue; }
        if (r == 0) return false;
        if (errno == EAGAIN || errno == EWOULDBLOCK) {
            /* 空闲是正常状态：不能因长时间无回答而主动断链，否则每次重连
             * 都会让板端 answer 里的音箱数变成 0。断链由 keepalive 探测。 */
            continue;
        }
        return false;
    }
}

static void drain_pcm(int s, int bytes)
{
    uint8_t tmp[PCM_CHUNK];
    while (bytes > 0) {
        int want = bytes > (int)sizeof(tmp) ? (int)sizeof(tmp) : bytes;
        if (!read_exact(s, tmp, (size_t)want)) return;
        bytes -= want;
    }
}

static bool play_pcm(int s, int bytes)
{
    if (!local_voice_pcm_begin()) {
        ESP_LOGW(TAG, "PCM begin unavailable, dropping %d bytes", bytes);
        drain_pcm(s, bytes);
        return true;   /* 连接保持；等下次回答再试 */
    }
    static int16_t mono[PCM_CHUNK / 2];
    int remaining = bytes;
    bool ok = true;
    while (remaining > 0) {
        int want = remaining > (int)sizeof(mono) ? (int)sizeof(mono) : remaining;
        if (!read_exact(s, (uint8_t *)mono, (size_t)want)) { ok = false; break; }
        size_t samples = (size_t)want / 2;
        if (!local_voice_pcm_write(mono, samples)) { ok = false; break; }
        remaining -= want;
    }
    local_voice_pcm_end();
    if (!ok) {
        ESP_LOGW(TAG, "PCM aborted remaining=%d", remaining);
    } else {
        ESP_LOGI(TAG, "PCM played bytes=%d", bytes);
    }
    return ok;
}

static int parse_int_field(const char *json, const char *key, int fallback)
{
    const char *p = strstr(json, key);
    if (!p) return fallback;
    p += strlen(key);
    while (*p == ' ' || *p == '\t' || *p == ':') ++p;
    if (*p < '0' || *p > '9') return fallback;
    return atoi(p);
}

static void speaker_task(void *arg)
{
    (void)arg;
    char hello[192];
    char line[512];
    char done[128];
    snprintf(hello, sizeof(hello),
             "{\"type\":\"hello\",\"role\":\"speaker\",\"node\":\"%s\",\"room\":\"%s\"}\n",
             CONFIG_NODE_ID, CONFIG_NODE_ROOM);
    for (;;) {
        int s = connect_gateway();
        if (s < 0) {
            vTaskDelay(pdMS_TO_TICKS(RETRY_DELAY_MS));
            continue;
        }
        s_rxlen = 0;
        send(s, hello, strlen(hello), 0);
        ESP_LOGI(TAG, "connected to %s:%d", CONFIG_NODE_GW_HOST, CONFIG_NODE_AUDIO_PORT);
        for (;;) {
            if (!read_line(s, line, sizeof(line))) break;
            if (!strstr(line, "\"pcm\"")) {
                ESP_LOGI(TAG, "rx %s", line);
                continue;
            }
            int bytes = parse_int_field(line, "\"bytes\"", 0);
            int rate = parse_int_field(line, "\"rate\"", 16000);
            if (bytes <= 0 || bytes > 4 * 1024 * 1024 || rate != 16000 || (bytes & 1)) {
                ESP_LOGW(TAG, "bad pcm header: %s", line);
                break;
            }
            ESP_LOGI(TAG, "RX pcm bytes=%d", bytes);
            bool ok = play_pcm(s, bytes);
            int n = snprintf(done, sizeof(done),
                             "{\"type\":\"done\",\"node\":\"%s\",\"ok\":%d}\n",
                             CONFIG_NODE_ID, ok ? 1 : 0);
            send(s, done, (size_t)n, 0);
            if (!ok) break;
        }
        close(s);
        ESP_LOGW(TAG, "disconnected, retry in %d ms", RETRY_DELAY_MS);
        vTaskDelay(pdMS_TO_TICKS(RETRY_DELAY_MS));
    }
}

void speaker_link_start(void)
{
    if (xTaskCreate(speaker_task, "speaker-net", 6144, NULL, 3, NULL) != pdPASS) {
        ESP_LOGE(TAG, "speaker task create failed");
    }
}

#else
void speaker_link_start(void) {}
#endif
