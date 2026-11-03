#include "sdkconfig.h"
#include "speaker_link.h"
#if CONFIG_NODE_VOICE_ENABLED

/* 与语音网关（默认端口 9102）的长连接，只负责“收指令、放声音、回执”。
 *
 * 协议（每行一条 JSON，'\n' 结尾）：
 *   本端连上后先发 hello： {"type":"hello","role":"speaker","node":..,"room":..}
 *   网关下发音箱指令：
 *     {"type":"clip", ... "clip":N}   -> 播本地固件里第 N 段语音（离线，不走网络）
 *     {"type":"pcm", "bytes":N, "rate":16000}
 *                                      -> 紧接着 N 字节 16kHz 单声道 s16le PCM，
 *                                         边收边写 I2S；
 *   播放结束回执： {"type":"done","node":..,"ok":0|1}
 *
 * 为什么不复用 gw_link 的 socket：语音流是二进制、可能有几十秒，
 * 和状态上报的 JSON 行混在一条连接上容易互相阻塞；独立连接也更符合网关的桥接模型。 */

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
#define CONNECT_TIMEOUT_MS 5000   /* connect 最长 5 秒，失败就整轮重连 */
#define IO_TIMEOUT_MS      500    /* recv 超时：正常空闲也要能定期返回检查断链 */
#define IDLE_LIMIT_MS      15000  /* 读二进制块时连续 15 秒没数据算断链 */
#define RETRY_DELAY_MS     3000   /* 断开后 3 秒重连，避免打爆网关 */
#define RX_BUF             2048
#define PCM_CHUNK          1024   /* 每次 recv/写入的字节数，合 512 个单声道样本 */

/* 接收缓冲：JSON 行和 PCM 二进制共用同一条 TCP 流，
 * 可能一次 recv 读到“半行 JSON + 一段 PCM”，所以必须先缓存再按类型消费。 */
static uint8_t s_rx[RX_BUF];
static size_t s_rxlen;

/* 本任务自己的单调毫秒（FreeRTOS tick），用于超时判断。 */
static int64_t now_ms(void)
{
    return (int64_t)xTaskGetTickCount() * portTICK_PERIOD_MS;
}

/* 连接语音网关，成功返回 socket，失败 -1。
 * 设置了收发超时和 TCP keepalive：空闲时网关不发数据，靠 keepalive 发现
 * 对端消失；这样不需要周期性主动重连，避免每次重连都出现“音箱不在线”的窗口。 */
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

/* 从 socket 读取恰好 n 字节；期间允许短暂超时，但持续 IDLE_LIMIT_MS 无数据即失败。
 * 优先消费 s_rx 里已缓存的字节，再 recv 新数据：
 * 因为 read_line 可能一次多读进来一段 PCM，二进制块必须从缓存接着读，不能丢。 */
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

/* 读一行 JSON（保留 recv 多读出来的 PCM 字节到 s_rx，避免与二进制数据错位）。
 * 行太长（超过 cap 或缓冲）直接丢弃并返回 false，由外层重连，
 * 不尝试“猜”一条被截断的指令。 */
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

/* 丢弃接下来 bytes 字节的 PCM。
 * 用于“本地音频引擎忙、这段放不了”时把数据从 socket 读干净，
 * 否则残留的二进制会被当成 JSON 行解析，后面的协议就全乱了。 */
static void drain_pcm(int s, int bytes)
{
    uint8_t tmp[PCM_CHUNK];
    while (bytes > 0) {
        int want = bytes > (int)sizeof(tmp) ? (int)sizeof(tmp) : bytes;
        if (!read_exact(s, tmp, (size_t)want)) return;
        bytes -= want;
    }
}

/* 接收并播放一段 PCM，返回 true 表示完整播完。
 * 流程：begin（最多重试 4 次，每次 250ms）-> 分块 read_exact -> pcm_write -> pcm_end。
 * 读失败或写入被打断都返回 false：外层会回 done ok=0 并断开重连，
 * 不会“没放出声却回执成功”。 */
static bool play_pcm(int s, int bytes)
{
    /* 录音刚结束时 ES8388 还在从 MIC 通路切回播放，立刻 begin 可能失败。
     * 重试几次，仍失败就回 ok=0，不能静默丢弃还报 done ok=1。 */
    bool begun = false;
    for (int attempt = 0; attempt < 4; ++attempt) {
        if (local_voice_pcm_begin()) { begun = true; break; }
        ESP_LOGW(TAG, "PCM begin busy, retry %d/3", attempt + 1);
        vTaskDelay(pdMS_TO_TICKS(250));
    }
    if (!begun) {
        ESP_LOGW(TAG, "PCM begin unavailable, dropping %d bytes", bytes);
        drain_pcm(s, bytes);
        return false;
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

/* 从 JSON 行里取一个整数字段，找不到或格式不对返回 fallback。
 * 只为这个轻量协议服务，不是通用 JSON 解析器：允许 key 后跟空格/制表/冒号，
 * 只接受十进制非负整数。 */
static int parse_int_field(const char *json, const char *key, int fallback)
{
    const char *p = strstr(json, key);
    if (!p) return fallback;
    p += strlen(key);
    while (*p == ' ' || *p == '\t' || *p == ':') ++p;
    if (*p < '0' || *p > '9') return fallback;
    return atoi(p);
}

/* 音箱长连接任务：连上 -> 发 hello -> 循环收指令 ->
 *   clip：播固件内置片段；
 *   pcm ：校验头（bytes 1..4MB、rate=16000、偶数长度）后收二进制并播放；
 *   其它行：只打日志。
 * 任何读失败/坏头/播放失败都关连接，3 秒后重连；重连后重新 hello，
 * 网关据此恢复“该房间有音箱”的在线状态。 */
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
            if (strstr(line, "\"clip\"")) {
                /* 取 "clip": 后面的值；用 "clip" 当键会先命中 type 的值 */
                const char *clipKey = strstr(line, "\"clip\":");
                int clip = clipKey ? atoi(clipKey + 7) : 0; /* strlen("\"clip\":") == 7 */
                ESP_LOGI(TAG, "RX local clip=%d (key-parse)", clip);
                local_voice_play(clip);
                continue;
            }
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

/* 启动音箱任务（栈 6144，优先级 3）。失败只报错，不影响传感器/告警/蜂鸣器。 */
void speaker_link_start(void)
{
    if (xTaskCreate(speaker_task, "speaker-net", 6144, NULL, 3, NULL) != pdPASS) {
        ESP_LOGE(TAG, "speaker task create failed");
    }
}

#else
void speaker_link_start(void) {}
#endif
