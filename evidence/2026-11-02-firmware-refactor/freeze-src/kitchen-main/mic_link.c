#include "sdkconfig.h"
#include "mic_link.h"
#include "local_voice.h"

/* 板载咪头按需上传（默认端口 9303）。
 *
 * 为什么不用常开连接：咪头只在“短按提问/告警后确认”等少数时刻工作，
 * 常开会一直占着 I2S 和网络；这里做成一次会话一条 TCP：
 *   触发 -> 建连 -> hello -> audio_start -> 边录边发 PCM -> audio_end ->
 *   读回执（asr / clip / answer / error）-> 关连接。
 * 这样每次录音都是干净状态，失败也只影响这一次。
 *
 * 健康问题的特殊路径：网关先回 clip=9（健康建议），再回 answer 文本。
 * 本板收到 clip=9 后直接用固件内语音播健康建议，不依赖 PCM/speaker 通路；
 * 回执顺序是云端/网关约定的，不能反过来。 */

extern const char *node_current_alarm_id(void);
static int s_local_clip = 0;   /* 本次会话网关下发的本地片段号（0=无） */
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

/* 一次采音请求只带“原因”字符串（question / cmd / alarm 等），
 * 用于网关日志和 hello 里的 reason 字段，不参与判定。 */
typedef struct { char reason[TRIGGER_MAX]; } mic_request_t;

/* 单槽队列：同一时刻只允许一次采音，新触发直接覆盖旧的未开始请求。 */
static QueueHandle_t s_requests;
static uint32_t s_seq;   /* 会话序号，只用于日志区分 */

/* 本任务自己的单调毫秒，用于连接/录音/回执超时。 */
static int64_t now_ms(void)
{
    return (int64_t)xTaskGetTickCount() * portTICK_PERIOD_MS;
}

/* 带超时的连接：PC 网关不可达时不能无限阻塞录音任务。
 * 先设非阻塞 + select 等可写，再查 SO_ERROR：这样 connect 最长只等 4 秒。
 * 连上后恢复阻塞模式，并设发送超时 5s、接收超时 1s、关闭 Nagle（TCP_NODELAY），
 * 保证 20ms 一块的 PCM 不被合并延迟。 */
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

/* 把整块数据写完（处理 send 短写）。任何一次失败返回 false，
 * 调用方据此中止本次会话，不会把半块数据当成成功。 */
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

/* 读取网关回执（asr / elder_safe / answer / error），逐个串口打印。
 * 遇到 clip 字段只记录，不立即播：等连接读完（answer 也会到达）后再统一处理，
 * 避免和 answer 的播放顺序打架。
 * 收到 elder_safe / answer / error 任一即认为本轮对话结束；30 秒没有任何
 * 结束标记就超时返回，不会永久卡在这个任务里。 */
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
        if (strstr(line, "\"clip\"")) {
            const char *cp = strstr(line, "\"clip\"");
            cp = strchr(cp, ':');
            if (cp) s_local_clip = atoi(cp + 1);
            continue;
        }
        if (strstr(line, "\"elder_safe\"") || strstr(line, "\"answer\"") ||
            strstr(line, "\"error\"")) {
            return;
        }
    }
    ESP_LOGW(TAG, "等待网关回执超时（%d ms）", RESPONSE_TIMEOUT_MS);
}

/* 一次完整的采音会话（在 mic-net 任务里串行执行）：
 *   1. 建连，发 hello（带 node/room/当前 alarmId/reason）；
 *   2. 发 audio_start（16000Hz、单声道、pcm_s16le）；
 *   3. 打开咪头，每 20ms 读一块，边算 RMS/峰值边发（4 字节大端长度 + PCM）；
 *   4. 关咪头，发 audio_end；
 *   5. 读回执；若网关给了 clip=9，用固件内语音播健康建议。
 * 任何一步失败都打 #seq FAIL reason=... 并退出本次会话，不重试：
 * 重试留给下一次按键/触发，避免连续失败时反复占用音频和网络。 */
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
    s_local_clip = 0;
    s = connect_gateway();
    if (s < 0) {
        ESP_LOGE(TAG, "MIC_UPLOAD FAIL #%u reason=connect %s:%d", (unsigned)seq,
                 CONFIG_NODE_GW_HOST, CONFIG_NODE_MIC_PORT);
        return;
    }
    const char *cur_alarm = node_current_alarm_id();
    snprintf(hello, sizeof(hello),
             "{\"type\":\"hello\",\"role\":\"mic\",\"node\":\"%s\",\"room\":\"%s\",\"alarmId\":\"%s\",\"reason\":\"%s\"}\n",
             CONFIG_NODE_ID, CONFIG_NODE_ROOM, cur_alarm ? cur_alarm : "", reason ? reason : "cmd");
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
    /* 网关在采音连接上回 clip=9：录完由本板播健康建议，绕开 PCM/speaker。 */
    if (s_local_clip == VOICE_CLIP_HEALTH) {
        local_voice_play(VOICE_CLIP_HEALTH);
    }
}

/* 采音任务：无限等待单槽队列，每收到一个请求就完整跑一次 upload_session。
 * 一次只处理一个，天然避免两路同时抢占 I2S。 */
static void mic_link_task(void *arg)
{
    (void)arg;
    mic_request_t req;
    for (;;) {
        if (xQueueReceive(s_requests, &req, portMAX_DELAY) != pdTRUE) continue;
        upload_session(req.reason);
    }
}

/* 启动采音链路：建单槽队列 + 任务（栈 6144，优先级 3）。
 * 重复调用直接返回；任一步失败都清掉已分配资源，mic_link_trigger 会返回 false。 */
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

/* 请求一次采音（非阻塞）：短按提问、告警确认等场景调用。
 * 单槽覆盖：上一次还没开始就又被触发时，用新的 reason 顶掉旧的，
 * 不会积压出多次录音。返回 false 表示语音功能未启用或任务没起来。 */
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
/* 未启用语音时保留同名空实现：调用方不用加条件编译，触发总是返回 false。 */
void mic_link_start(void) {}
bool mic_link_trigger(const char *reason) { (void)reason; return false; }
#endif
