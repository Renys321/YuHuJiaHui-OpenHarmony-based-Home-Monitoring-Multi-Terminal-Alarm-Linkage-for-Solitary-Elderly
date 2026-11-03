#include "sdkconfig.h"
#include "mic_link.h"

extern const char *node_current_alarm_id(void);
#if CONFIG_NODE_VOICE_ENABLED

#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include <errno.h>
#include <unistd.h>
#include <fcntl.h>
#include <math.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <sys/select.h>
#include <netdb.h>
#include <netinet/tcp.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"
#include "esp_log.h"
#include "local_voice.h"

#ifndef CONFIG_NODE_MIC_PORT
#define CONFIG_NODE_MIC_PORT 9303
#endif
#ifndef CONFIG_NODE_MIC_RECORD_SEC
#define CONFIG_NODE_MIC_RECORD_SEC 4
#endif

#define TAG "mic-net"
#define CONNECT_TIMEOUT_MS 4000
#define SEND_TIMEOUT_MS    5000
#define RESPONSE_TIMEOUT_MS 30000
#define CHUNK_SAMPLES      320   /* 20 ms @16 kHz，边录边传，不整段缓存 */
#define TRIGGER_MAX        48

typedef struct { char reason[TRIGGER_MAX]; } mic_request_t;

static QueueHandle_t s_requests;
static uint32_t s_seq;   /* 会话序号，只用于日志区分 */

static int64_t now_ms(void)
{
    return (int64_t)xTaskGetTickCount() * portTICK_PERIOD_MS;
}

/* 带超时的连接：PC 网关不可达时不能无限阻塞录音任务。 */
static int connect_gateway(void)
{
    struct addrinfo hints = { 0 };
    hints.ai_family = AF_INET;
    hints.ai_socktype = SOCK_STREAM;
    char port[8];
    snprintf(port, sizeof(port), "%d", CONFIG_NODE_MIC_PORT);
    struct addrinfo *res = NULL;
    if (getaddrinfo(CONFIG_NODE_GW_HOST, port, &hints, &res) != 0 || !res) return -1;
    int s = socket(res->ai_family, res->ai_socktype, res->ai_protocol);
    if (s < 0) { freeaddrinfo(res); return -1; }
    int flags = fcntl(s, F_GETFL, 0);
    fcntl(s, F_SETFL, flags | O_NONBLOCK);
    int rc = connect(s, res->ai_addr, res->ai_addrlen);
    if (rc != 0 && errno != EINPROGRESS) { freeaddrinfo(res); close(s); return -1; }
    if (rc != 0) {
        fd_set wf;
        FD_ZERO(&wf);
        FD_SET(s, &wf);
        struct timeval tv = { CONNECT_TIMEOUT_MS / 1000, (CONNECT_TIMEOUT_MS % 1000) * 1000 };
        rc = select(s + 1, NULL, &wf, NULL, &tv);
        int soerr = 0;
        socklen_t slen = sizeof(soerr);
        if (rc <= 0 || getsockopt(s, SOL_SOCKET, SO_ERROR, &soerr, &slen) != 0 || soerr != 0) {
            freeaddrinfo(res);
            close(s);
            return -1;
        }
    }
    fcntl(s, F_SETFL, flags);
    freeaddrinfo(res);
    struct timeval stv = { SEND_TIMEOUT_MS / 1000, (SEND_TIMEOUT_MS % 1000) * 1000 };
    struct timeval rtv = { 1, 0 };
    setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, &stv, sizeof(stv));
    setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, &rtv, sizeof(rtv));
    int one = 1;
    setsockopt(s, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));
    return s;
}

static bool send_all(int s, const void *data, size_t len)
{
    const uint8_t *p = (const uint8_t *)data;
    while (len > 0) {
        int n = send(s, p, len, 0);
        if (n <= 0) return false;
        p += n;
        len -= (size_t)n;
    }
    return true;
}

static bool send_line(int s, const char *line)
{
    return send_all(s, line, strlen(line));
}

/* 与 9302 相同的分片格式：4 字节大端长度 + PCM 负载。 */
static bool send_pcm(int s, const int16_t *pcm, size_t samples)
{
    size_t bytes = samples * sizeof(int16_t);
    uint8_t header[4] = {
        (uint8_t)(bytes >> 24), (uint8_t)(bytes >> 16),
        (uint8_t)(bytes >> 8),  (uint8_t)bytes
    };
    return send_all(s, header, sizeof(header)) && send_all(s, pcm, bytes);
}

/* 读取网关回执（asr / elder_safe / answer / error），逐个串口打印。 */
static void read_responses(int s)
{
    char line[512];
    size_t len = 0;
    int64_t deadline = now_ms() + RESPONSE_TIMEOUT_MS;
    while (now_ms() < deadline) {
        char c;
        int n = recv(s, &c, 1, 0);
        if (n == 0) {
            ESP_LOGW(TAG, "网关关闭了采音连接");
            return;
        }
        if (n < 0) {
            if (errno == EAGAIN || errno == EWOULDBLOCK) continue;
            ESP_LOGW(TAG, "采音回执读取失败: %s", strerror(errno));
            return;
        }
        if (c == '\r') continue;
        if (c != '\n') {
            if (len < sizeof(line) - 1) line[len++] = c;
            continue;
        }
        line[len] = '\0';
        len = 0;
        if (line[0] == '\0') continue;
        ESP_LOGI(TAG, "网关回执: %.200s", line);
        if (strstr(line, "\"elder_safe\"") || strstr(line, "\"answer\"") ||
            strstr(line, "\"error\"")) {
            return;
        }
    }
    ESP_LOGW(TAG, "等待网关回执超时（%d ms）", RESPONSE_TIMEOUT_MS);
}

static void upload_session(const char *reason)
{
    char hello[256];
    char header[160];
    static int16_t pcm[CHUNK_SAMPLES];
    const int seconds = CONFIG_NODE_MIC_RECORD_SEC;
    int64_t sumsq = 0;
    uint32_t total = 0;
    int32_t vmin = 0, vmax = 0;
    int first = 1;
    int s = -1;
    uint32_t seq = ++s_seq;

    ESP_LOGW(TAG, "MIC_UPLOAD #%u start reason=%s seconds=%d", (unsigned)seq, reason, seconds);
    s = connect_gateway();
    if (s < 0) {
        ESP_LOGE(TAG, "MIC_UPLOAD FAIL #%u reason=connect %s:%d", (unsigned)seq,
                 CONFIG_NODE_GW_HOST, CONFIG_NODE_MIC_PORT);
        return;
    }
    snprintf(hello, sizeof(hello),
             "{\"type\":\"hello\",\"role\":\"mic\",\"node\":\"%s\",\"room\":\"%s\"}\n",
             CONFIG_NODE_ID, CONFIG_NODE_ROOM);
    if (!send_line(s, hello)) {
        ESP_LOGE(TAG, "MIC_UPLOAD FAIL #%u reason=hello_send", (unsigned)seq);
        close(s);
        return;
    }
    snprintf(header, sizeof(header),
             "{\"type\":\"audio_start\",\"rate\":16000,\"channels\":1,\"codec\":\"pcm_s16le\"}\n");
    if (!send_line(s, header)) {
        ESP_LOGE(TAG, "MIC_UPLOAD FAIL #%u reason=audio_start_send", (unsigned)seq);
        close(s);
        return;
    }

    if (!local_voice_mic_begin()) {
        ESP_LOGE(TAG, "MIC_UPLOAD FAIL #%u reason=mic_begin_unavailable", (unsigned)seq);
        close(s);
        return;
    }
    const int64_t deadline = now_ms() + (int64_t)seconds * 1000;
    bool stream_ok = true;
    while (now_ms() < deadline) {
        int got = local_voice_mic_read(pcm, CHUNK_SAMPLES, 200);
        if (got < 0) { stream_ok = false; break; }
        if (got == 0) continue;
        for (int i = 0; i < got; ++i) {
            int32_t v = pcm[i];
            sumsq += (int64_t)v * v;
            if (first || v < vmin) vmin = v;
            if (first || v > vmax) vmax = v;
            first = 0;
        }
        total += (uint32_t)got;
        if (!send_pcm(s, pcm, (size_t)got)) { stream_ok = false; break; }
    }
    local_voice_mic_end();

    if (!stream_ok) {
        ESP_LOGE(TAG, "MIC_UPLOAD FAIL #%u reason=stream (sent=%u samples)", (unsigned)seq, (unsigned)total);
        close(s);
        return;
    }
    if (total == 0) {
        ESP_LOGE(TAG, "MIC_UPLOAD FAIL #%u reason=no_samples", (unsigned)seq);
        close(s);
        return;
    }
    if (!send_line(s, "{\"type\":\"audio_end\"}\n")) {
        ESP_LOGE(TAG, "MIC_UPLOAD FAIL #%u reason=audio_end_send", (unsigned)seq);
        close(s);
        return;
    }
    uint32_t rms = (uint32_t)(sqrt((double)sumsq / (double)total) + 0.5);
    uint32_t peak = (uint32_t)(vmax > -vmin ? vmax : -vmin);
    ESP_LOGI(TAG, "MIC_UPLOAD #%u sent rms=%u peak=%u samples=%u bytes=%u",
             (unsigned)seq, (unsigned)rms, (unsigned)peak, (unsigned)total,
             (unsigned)(total * 2));
    read_responses(s);
    close(s);
}

static void mic_link_task(void *arg)
{
    (void)arg;
    mic_request_t req;
    for (;;) {
        if (xQueueReceive(s_requests, &req, portMAX_DELAY) != pdTRUE) continue;
        upload_session(req.reason);
    }
}

void mic_link_start(void)
{
    if (s_requests) return;
    s_requests = xQueueCreate(1, sizeof(mic_request_t));
    if (!s_requests) {
        ESP_LOGE(TAG, "MIC 上传队列创建失败，采音上传不可用");
        return;
    }
    if (xTaskCreate(mic_link_task, "mic-net", 6144, NULL, 3, NULL) != pdPASS) {
        vQueueDelete(s_requests);
        s_requests = NULL;
        ESP_LOGE(TAG, "MIC 上传任务创建失败，采音上传不可用");
    }
}

bool mic_link_trigger(const char *reason)
{
    if (!s_requests) return false;
    mic_request_t req = { 0 };
    snprintf(req.reason, sizeof(req.reason), "%s", reason && reason[0] ? reason : "cmd");
    /* 单槽覆盖：告警密集时不堆积多次录音。 */
    xQueueOverwrite(s_requests, &req);
    return true;
}

#else
void mic_link_start(void) {}
bool mic_link_trigger(const char *reason) { (void)reason; return false; }
#endif
