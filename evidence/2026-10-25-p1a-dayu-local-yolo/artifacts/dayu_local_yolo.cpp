// DAYU200 local YOLO11n-pose person detection (P1-A candidate).
//
// Modes:
//   --image <jpg>                         one-shot image inference (Stage A)
//   --serve 127.0.0.1:9200 --duration 600 camera-frame HTTP receiver + local inference (Stage B/C)
//
// The camera-frame endpoint mirrors the existing DAYU VisionFrameStreamer contract
// (POST /v1/frames/<deviceId>, image/jpeg body) but inference runs ON THE BOARD.
// No PC inference is involved. Frames are kept in a single latest-frame slot:
// stale frames are dropped instead of queued.
//
// Event output is local-only JSONL; it is not published to MQTT/backend and does not
// use the production deviceId.

#include "net.h"

#define STB_IMAGE_IMPLEMENTATION
#include "stb_image.h"

#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <ctype.h>
#include <time.h>
#include <unistd.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdarg>
#include <cstdlib>
#include <cstring>
#include <map>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

static const char* kSchema = "p1a.dayu.local.vision.event/1";
static const char* kModelId = "yolo11n-pose-ncnn-640-static";
static const int kInput = 640;
static const float kPadValue = 114.0f;
static const int kNumPoints = 17;

static std::atomic<bool> g_stop(false);

static int64_t now_ms_mono()
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

static int64_t now_ms_wall()
{
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    return (int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

static std::string iso8601_now()
{
    char buf[32];
    time_t t = time(NULL);
    struct tm tmv;
    gmtime_r(&t, &tmv);
    strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%SZ", &tmv);
    return std::string(buf);
}

static long read_long_file(const char* path, long fallback = -1)
{
    FILE* fp = fopen(path, "rb");
    if (!fp) return fallback;
    long v = fallback;
    if (fscanf(fp, "%ld", &v) != 1) v = fallback;
    fclose(fp);
    return v;
}

static long read_rss_kb()
{
    FILE* fp = fopen("/proc/self/status", "rb");
    if (!fp) return -1;
    char line[256];
    long kb = -1;
    while (fgets(line, sizeof(line), fp))
    {
        if (strncmp(line, "VmRSS:", 6) == 0)
        {
            sscanf(line + 6, "%ld", &kb);
            break;
        }
    }
    fclose(fp);
    return kb;
}

static double read_cpu_seconds()
{
    FILE* fp = fopen("/proc/self/stat", "rb");
    if (!fp) return -1;
    char buf[4096];
    size_t n = fread(buf, 1, sizeof(buf) - 1, fp);
    fclose(fp);
    buf[n] = 0;
    // fields after the comm field; find last ')'
    char* p = strrchr(buf, ')');
    if (!p) return -1;
    p += 2; // skip ") "
    long utime = 0, stime = 0;
    // fields starting at field 3 (state) -> utime is field 14, stime 15
    int field = 3;
    char* save = NULL;
    for (char* tok = strtok_r(p, " ", &save); tok; tok = strtok_r(NULL, " ", &save), field++)
    {
        if (field == 14) utime = atol(tok);
        if (field == 15) stime = atol(tok);
        if (field > 15) break;
    }
    long hz = sysconf(_SC_CLK_TCK);
    if (hz <= 0) hz = 100;
    return (double)(utime + stime) / (double)hz;
}

static double read_temp_c()
{
    for (int i = 0; i < 8; i++)
    {
        char path[128];
        snprintf(path, sizeof(path), "/sys/class/thermal/thermal_zone%d/temp", i);
        long v = read_long_file(path);
        if (v > 0) return (double)v / 1000.0;
    }
    return -1;
}

static std::string json_escape(const std::string& s)
{
    std::string out;
    out.reserve(s.size() + 8);
    for (size_t i = 0; i < s.size(); i++)
    {
        char c = s[i];
        if (c == '"' || c == '\\')
        {
            out.push_back('\\');
            out.push_back(c);
        }
        else if ((unsigned char)c < 0x20)
        {
            char b[8];
            snprintf(b, sizeof(b), "\\u%04x", (unsigned char)c);
            out += b;
        }
        else
        {
            out.push_back(c);
        }
    }
    return out;
}

struct Detection
{
    float x, y, w, h;
    float conf;
    float kpts[51];
};

struct InferResult
{
    bool valid = false;
    std::string error;
    int img_w = 0, img_h = 0;
    int person_count = -1; // -1 = not evaluated (must not be reported as "no person")
    double infer_ms = 0;
    std::vector<Detection> dets;
};

static float iou(const Detection& a, const Detection& b)
{
    float ax1 = a.x, ay1 = a.y, ax2 = a.x + a.w, ay2 = a.y + a.h;
    float bx1 = b.x, by1 = b.y, bx2 = b.x + b.w, by2 = b.y + b.h;
    float ix1 = std::max(ax1, bx1), iy1 = std::max(ay1, by1);
    float ix2 = std::min(ax2, bx2), iy2 = std::min(ay2, by2);
    float iw = std::max(0.f, ix2 - ix1), ih = std::max(0.f, iy2 - iy1);
    float inter = iw * ih;
    float uni = a.w * a.h + b.w * b.h - inter;
    return uni > 0 ? inter / uni : 0.f;
}

class YoloPose
{
public:
    bool load(const char* param, const char* bin, int threads)
    {
        net_.opt.use_vulkan_compute = false;
        net_.opt.num_threads = threads;
        if (net_.load_param(param) != 0) return false;
        if (net_.load_model(bin) != 0) return false;
        return true;
    }

    InferResult infer_jpeg(const unsigned char* data, size_t len, float conf_thr, float nms_thr)
    {
        InferResult r;
        int w = 0, h = 0, c = 0;
        unsigned char* rgb = stbi_load_from_memory(data, (int)len, &w, &h, &c, 3);
        if (!rgb)
        {
            r.error = "jpeg_decode_failed";
            return r;
        }
        r.img_w = w;
        r.img_h = h;

        float scale = std::min((float)kInput / (float)w, (float)kInput / (float)h);
        int nw = (int)std::round(w * scale);
        int nh = (int)std::round(h * scale);
        int dw = kInput - nw;
        int dh = kInput - nh;
        int left = dw / 2;
        int top = dh / 2;

        ncnn::Mat in = ncnn::Mat::from_pixels_resize(rgb, ncnn::Mat::PIXEL_RGB, w, h, nw, nh);
        stbi_image_free(rgb);
        if (in.empty())
        {
            r.error = "preprocess_failed";
            return r;
        }
        ncnn::Mat padded;
        ncnn::copy_make_border(in, padded, top, dh - top, left, dw - left, ncnn::BORDER_CONSTANT, kPadValue);
        static const float kNorm[3] = {1.f / 255.f, 1.f / 255.f, 1.f / 255.f};
        padded.substract_mean_normalize(NULL, kNorm);

        int64_t t0 = now_ms_mono();
        ncnn::Extractor ex = net_.create_extractor();
        ex.input("in0", padded);
        ncnn::Mat out;
        int rc = ex.extract("out0", out);
        if (rc != 0 || out.empty())
        {
            r.error = "inference_extract_failed";
            return r;
        }
        // out layout: w = anchors (8400), h = features (56: cx,cy,w,h,score + 17*3 kpts)
        const int features = out.h;
        const int anchors = out.w;
        if (features < 5 + kNumPoints * 3)
        {
            r.error = "unexpected_output_shape";
            return r;
        }
        std::vector<Detection> proposals;
        for (int a = 0; a < anchors; a++)
        {
            const float score = out.row(4)[a];
            if (!(score >= conf_thr)) continue;
            const float cx = out.row(0)[a];
            const float cy = out.row(1)[a];
            const float bw = out.row(2)[a];
            const float bh = out.row(3)[a];
            Detection d;
            d.x = (cx - bw * 0.5f - left) / scale;
            d.y = (cy - bh * 0.5f - top) / scale;
            d.w = bw / scale;
            d.h = bh / scale;
            d.conf = score;
            for (int k = 0; k < kNumPoints; k++)
            {
                d.kpts[k * 3 + 0] = (out.row(5 + k * 3)[a] - left) / scale;
                d.kpts[k * 3 + 1] = (out.row(6 + k * 3)[a] - top) / scale;
                d.kpts[k * 3 + 2] = out.row(7 + k * 3)[a];
            }
            proposals.push_back(d);
        }
        std::sort(proposals.begin(), proposals.end(), [](const Detection& a, const Detection& b) {
            return a.conf > b.conf;
        });
        std::vector<Detection> kept;
        std::vector<bool> removed(proposals.size(), false);
        for (size_t i = 0; i < proposals.size(); i++)
        {
            if (removed[i]) continue;
            kept.push_back(proposals[i]);
            for (size_t j = i + 1; j < proposals.size(); j++)
            {
                if (!removed[j] && iou(proposals[i], proposals[j]) > nms_thr) removed[j] = true;
            }
        }
        r.infer_ms = (double)(now_ms_mono() - t0);
        r.dets = kept;
        r.person_count = (int)kept.size();
        r.valid = true;
        return r;
    }

private:
    ncnn::Net net_;
};

static std::string detections_json(const std::vector<Detection>& dets)
{
    std::string s = "[";
    for (size_t i = 0; i < dets.size(); i++)
    {
        const Detection& d = dets[i];
        if (i) s += ",";
        char buf[512];
        snprintf(buf, sizeof(buf),
                 "{\"bbox\":[%.2f,%.2f,%.2f,%.2f],\"conf\":%.5f,"
                 "\"confSemantics\":\"person-class sigmoid score; not PIR, fall or SOS\","
                 "\"keypoints\":[",
                 d.x, d.y, d.w, d.h, d.conf);
        s += buf;
        for (int k = 0; k < kNumPoints; k++)
        {
            if (k) s += ",";
            snprintf(buf, sizeof(buf), "[%.1f,%.1f,%.4f]", d.kpts[k * 3], d.kpts[k * 3 + 1], d.kpts[k * 3 + 2]);
            s += buf;
        }
        s += "]}";
    }
    s += "]";
    return s;
}

struct Stats
{
    std::vector<double> infer_ms;
    int64_t frames_received = 0;
    int64_t frames_inferred = 0;
    int64_t frames_dropped = 0;
    int64_t errors = 0;
    int64_t started_ms = 0;
};

static void write_summary(const Stats& st, const char* stats_path, const char* event_path, int threads,
                          float conf_thr, float nms_thr, bool served)
{
    std::vector<double> v = st.infer_ms;
    std::sort(v.begin(), v.end());
    double p50 = v.empty() ? -1 : v[v.size() / 2];
    double p95 = v.empty() ? -1 : v[(size_t)(v.size() * 0.95)];
    double elapsed_s = (now_ms_mono() - st.started_ms) / 1000.0;
    double avg = 0;
    for (size_t i = 0; i < v.size(); i++) avg += v[i];
    if (!v.empty()) avg /= v.size();
    std::string j;
    char buf[1024];
    j += "{";
    snprintf(buf, sizeof(buf),
             "\"schema\":\"p1a.dayu.local.vision.summary/1\",\"model\":\"%s\",\"host\":\"dayu200\","
             "\"mode\":\"%s\",\"threads\":%d,\"confThreshold\":%.2f,\"nmsThreshold\":%.2f,"
             "\"elapsedSec\":%.1f,\"framesReceived\":%lld,\"framesInferred\":%lld,\"framesDropped\":%lld,"
             "\"errors\":%lld,\"inferMsP50\":%.2f,\"inferMsP95\":%.2f,\"inferMsAvg\":%.2f,"
             "\"captureFps\":%.2f,\"inferFps\":%.2f,\"rssKb\":%ld,\"cpuSeconds\":%.2f,\"tempC\":%.1f,",
             kModelId, served ? "camera-http" : "image", threads, conf_thr, nms_thr, elapsed_s,
             (long long)st.frames_received, (long long)st.frames_inferred, (long long)st.frames_dropped,
             (long long)st.errors, p50, p95, avg,
             elapsed_s > 0 ? st.frames_received / elapsed_s : 0,
             elapsed_s > 0 ? st.frames_inferred / elapsed_s : 0,
             read_rss_kb(), read_cpu_seconds(), read_temp_c());
    j += buf;
    snprintf(buf, sizeof(buf), "\"events\":\"%s\",\"finishedAt\":\"%s\"}\n",
             json_escape(event_path ? event_path : "").c_str(), iso8601_now().c_str());
    j += buf;
    FILE* fp = fopen(stats_path, "ab");
    if (fp)
    {
        fwrite(j.data(), 1, j.size(), fp);
        fclose(fp);
    }
    printf("%s", j.c_str());
    fflush(stdout);
}

static std::string event_json(const char* source, int64_t frame_ms, int64_t event_ms, const InferResult& r,
                              long rss_kb, double cpu_s, double temp_c, int64_t dropped, const char* error)
{
    std::string j;
    char buf[1024];
    j += "{";
    snprintf(buf, sizeof(buf),
             "\"schema\":\"%s\",\"source\":\"%s\",\"host\":\"dayu200\",\"model\":{\"id\":\"%s\",\"format\":\"ncnn\","
             "\"input\":[%d,%d],\"class\":\"person\"},",
             kSchema, source, kModelId, kInput, kInput);
    j += buf;
    int count = r.valid ? r.person_count : -1;
    snprintf(buf, sizeof(buf),
             "\"frameTsMs\":%lld,\"eventTsMs\":%lld,\"timeSource\":\"CLOCK_REALTIME_wall+CLOCK_MONOTONIC_duration\","
             "\"personCount\":%d,\"dataValid\":%s,\"stale\":false,\"error\":\"%s\",\"inferMs\":%.2f,",
             (long long)frame_ms, (long long)event_ms, count, r.valid ? "true" : "false",
             error ? json_escape(error).c_str() : "", r.infer_ms);
    j += buf;
    std::string dets = r.valid ? detections_json(r.dets) : std::string("[]");
    j += "\"detections\":";
    j += dets;
    j += ",";
    snprintf(buf, sizeof(buf), "\"rssKb\":%ld,\"cpuSeconds\":%.2f,\"tempC\":%.1f,\"droppedFrames\":%lld}",
             rss_kb, cpu_s, temp_c, (long long)dropped);
    j += buf;
    return j;
}

// ------------------------- HTTP camera receiver -------------------------

struct FrameSlot
{
    std::mutex m;
    std::condition_variable cv;
    std::vector<unsigned char> data;
    int64_t frame_ms = 0;
    uint64_t seq = 0;
    bool has = false;
    bool running = true;
};

static bool http_read_request(int fd, std::string& method, std::string& path, size_t& content_length,
                              std::vector<unsigned char>& body)
{
    std::string header;
    char buf[4096];
    while (header.find("\r\n\r\n") == std::string::npos)
    {
        ssize_t n = recv(fd, buf, sizeof(buf), 0);
        if (n <= 0) return false;
        header.append(buf, (size_t)n);
        if (header.size() > 64 * 1024) return false;
    }
    size_t sep = header.find("\r\n\r\n");
    std::string head = header.substr(0, sep + 4);
    std::string rest = header.substr(sep + 4);
    size_t line_end = head.find("\r\n");
    std::string first = head.substr(0, line_end);
    char m[16] = {0}, p[512] = {0};
    if (sscanf(first.c_str(), "%15s %511s", m, p) != 2) return false;
    method = m;
    path = p;
    content_length = 0;
    size_t pos = 0;
    while (pos < head.size())
    {
        size_t e = head.find("\r\n", pos);
        if (e == std::string::npos) break;
        std::string line = head.substr(pos, e - pos);
        pos = e + 2;
        std::string lower = line;
        for (size_t i = 0; i < lower.size(); i++) lower[i] = (char)tolower((unsigned char)lower[i]);
        if (lower.find("content-length:") == 0)
        {
            content_length = (size_t)strtoul(line.c_str() + strlen("content-length:"), NULL, 10);
        }
    }
    body.assign(rest.begin(), rest.end());
    while (body.size() < content_length)
    {
        ssize_t n = recv(fd, buf, sizeof(buf), 0);
        if (n <= 0) return false;
        body.insert(body.end(), buf, buf + n);
        if (body.size() > 8 * 1024 * 1024) return false;
    }
    if (body.size() > content_length) body.resize(content_length);
    return true;
}

static void http_respond(int fd, const std::string& body)
{
    char header[256];
    snprintf(header, sizeof(header),
             "HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=utf-8\r\n"
             "Content-Length: %zu\r\nConnection: close\r\n\r\n",
             body.size());
    send(fd, header, strlen(header), 0);
    send(fd, body.data(), body.size(), 0);
}

static void http_bad_request(int fd, const char* msg)
{
    std::string body = std::string("{\"ok\":false,\"error\":\"") + msg + "\"}";
    char header[256];
    snprintf(header, sizeof(header),
             "HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: %zu\r\n"
             "Connection: close\r\n\r\n",
             body.size());
    send(fd, header, strlen(header), 0);
    send(fd, body.data(), body.size(), 0);
}

int serve_camera(const char* param, const char* bin, const char* listen_addr, int duration_s, int threads,
                 float conf_thr, float nms_thr, const char* events_path, const char* stats_path)
{
    std::string addr = listen_addr ? listen_addr : "127.0.0.1:9200";
    size_t colon = addr.rfind(':');
    std::string host = colon == std::string::npos ? "127.0.0.1" : addr.substr(0, colon);
    int port = colon == std::string::npos ? 9200 : atoi(addr.c_str() + colon + 1);

    int sfd = socket(AF_INET, SOCK_STREAM, 0);
    if (sfd < 0)
    {
        fprintf(stderr, "socket failed: %s\n", strerror(errno));
        return 2;
    }
    int one = 1;
    setsockopt(sfd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
    struct sockaddr_in sa;
    memset(&sa, 0, sizeof(sa));
    sa.sin_family = AF_INET;
    sa.sin_port = htons((uint16_t)port);
    if (inet_pton(AF_INET, host.c_str(), &sa.sin_addr) != 1)
    {
        fprintf(stderr, "bad listen address\n");
        close(sfd);
        return 2;
    }
    if (bind(sfd, (struct sockaddr*)&sa, sizeof(sa)) != 0)
    {
        fprintf(stderr, "bind %s failed: %s\n", addr.c_str(), strerror(errno));
        close(sfd);
        return 3;
    }
    if (listen(sfd, 8) != 0)
    {
        fprintf(stderr, "listen failed: %s\n", strerror(errno));
        close(sfd);
        return 3;
    }
    fprintf(stderr, "[dayu-yolo] listening %s model=%s threads=%d duration=%ds\n", addr.c_str(), kModelId, threads, duration_s);

    YoloPose model;
    if (!model.load(param, bin, threads))
    {
        fprintf(stderr, "model load failed\n");
        close(sfd);
        return 4;
    }

    Stats st;
    st.started_ms = now_ms_mono();

    FrameSlot slot;
    std::mutex result_m;
    std::string last_result = "{\"ok\":true,\"personDetected\":false,\"dataValid\":false,\"stale\":true,"
                              "\"source\":\"dayu-local-yolo\",\"fall\":false,\"fallEvaluated\":false,"
                              "\"reason\":\"no_frame_processed_yet\"}";
    std::atomic<bool> last_person(false);

    std::thread worker([&]() {
        while (true)
        {
            std::vector<unsigned char> data;
            int64_t frame_ms = 0;
            {
                std::unique_lock<std::mutex> lk(slot.m);
                slot.cv.wait(lk, [&]() { return slot.has || !slot.running; });
                if (!slot.running) break;
                data.swap(slot.data);
                frame_ms = slot.frame_ms;
                slot.has = false;
            }
            InferResult r = model.infer_jpeg(data.data(), data.size(), conf_thr, nms_thr);
            int64_t ev_ms = now_ms_wall();
            st.frames_inferred++;
            if (r.valid)
            {
                last_person.store(r.person_count > 0);
                st.infer_ms.push_back(r.infer_ms);
            }
            else
            {
                st.errors++;
            }
            std::string ev = event_json("dayu-camera-http", frame_ms, ev_ms, r, read_rss_kb(), read_cpu_seconds(),
                                        read_temp_c(), st.frames_dropped, r.error.empty() ? NULL : r.error.c_str());
            FILE* fp = fopen(events_path, "ab");
            if (fp)
            {
                fwrite(ev.data(), 1, ev.size(), fp);
                fwrite("\n", 1, 1, fp);
                fclose(fp);
            }
            {
                std::lock_guard<std::mutex> lk(result_m);
                char rb[256];
                snprintf(rb, sizeof(rb),
                         "{\"ok\":true,\"personDetected\":%s,\"personCount\":%d,\"dataValid\":%s,"
                         "\"source\":\"dayu-local-yolo\",\"fall\":false,\"fallEvaluated\":false,"
                         "\"inferMs\":%.1f,\"stale\":false}",
                         (r.valid && r.person_count > 0) ? "true" : "false",
                         r.valid ? r.person_count : -1, r.valid ? "true" : "false", r.infer_ms);
                last_result = rb;
            }
        }
    });

    int64_t deadline = duration_s > 0 ? st.started_ms + (int64_t)duration_s * 1000 : 0;
    while (!g_stop.load())
    {
        if (deadline > 0 && now_ms_mono() >= deadline) break;
        struct timeval tv;
        tv.tv_sec = 0;
        tv.tv_usec = 200000;
        setsockopt(sfd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
        struct sockaddr_in ca;
        socklen_t cl = sizeof(ca);
        int cfd = accept(sfd, (struct sockaddr*)&ca, &cl);
        if (cfd < 0)
        {
            if (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR) continue;
            break;
        }
        std::string method, path;
        size_t clen = 0;
        std::vector<unsigned char> body;
        bool ok = http_read_request(cfd, method, path, clen, body);
        if (!ok)
        {
            http_bad_request(cfd, "bad_request");
            close(cfd);
            continue;
        }
        if (method == "GET" && path.find("/healthz") == 0)
        {
            char hb[256];
            snprintf(hb, sizeof(hb),
                     "{\"ok\":true,\"service\":\"dayu-local-yolo\",\"framesReceived\":%lld,\"inferred\":%lld,"
                     "\"dropped\":%lld,\"errors\":%lld,\"rssKb\":%ld,\"tempC\":%.1f}",
                     (long long)st.frames_received, (long long)st.frames_inferred, (long long)st.frames_dropped,
                     (long long)st.errors, read_rss_kb(), read_temp_c());
            http_respond(cfd, hb);
            close(cfd);
            continue;
        }
        if (method != "POST" || path.find("/v1/frames/") != 0)
        {
            http_bad_request(cfd, "not_found");
            close(cfd);
            continue;
        }
        st.frames_received++;
        {
            std::lock_guard<std::mutex> lk(slot.m);
            if (slot.has) st.frames_dropped++;
            slot.data.swap(body);
            slot.frame_ms = now_ms_wall();
            slot.seq++;
            slot.has = true;
        }
        slot.cv.notify_one();
        std::string resp;
        {
            std::lock_guard<std::mutex> lk(result_m);
            resp = last_result;
        }
        http_respond(cfd, resp);
        close(cfd);
    }
    close(sfd);
    {
        std::lock_guard<std::mutex> lk(slot.m);
        slot.running = false;
    }
    slot.cv.notify_all();
    worker.join();
    write_summary(st, stats_path, events_path, threads, conf_thr, nms_thr, true);
    return 0;
}

int infer_image(const char* param, const char* bin, const char* image, int threads, float conf_thr,
                float nms_thr, const char* events_path, const char* stats_path, int repeat, bool quiet)
{
    FILE* fp = fopen(image, "rb");
    if (!fp)
    {
        fprintf(stderr, "cannot open image %s\n", image);
        return 2;
    }
    fseek(fp, 0, SEEK_END);
    long sz = ftell(fp);
    fseek(fp, 0, SEEK_SET);
    std::vector<unsigned char> data((size_t)sz);
    if (fread(data.data(), 1, data.size(), fp) != data.size())
    {
        fclose(fp);
        fprintf(stderr, "read image failed\n");
        return 2;
    }
    fclose(fp);

    YoloPose model;
    if (!model.load(param, bin, threads))
    {
        fprintf(stderr, "model load failed\n");
        return 4;
    }
    Stats st;
    st.started_ms = now_ms_mono();
    InferResult r;
    int n = repeat > 0 ? repeat : 1;
    for (int i = 0; i < n; i++)
    {
        r = model.infer_jpeg(data.data(), data.size(), conf_thr, nms_thr);
        st.frames_received++;
        if (r.valid)
        {
            st.frames_inferred++;
            st.infer_ms.push_back(r.infer_ms);
        }
        else
        {
            st.errors++;
        }
    }
    std::string ev = event_json("dayu-image-file", now_ms_wall(), now_ms_wall(), r, read_rss_kb(),
                                read_cpu_seconds(), read_temp_c(), 0, r.error.empty() ? NULL : r.error.c_str());
    FILE* ef = fopen(events_path, "ab");
    if (ef)
    {
        fwrite(ev.data(), 1, ev.size(), ef);
        fwrite("\n", 1, 1, ef);
        fclose(ef);
    }
    if (!quiet) printf("%s\n", ev.c_str());
    write_summary(st, stats_path, events_path, threads, conf_thr, nms_thr, false);
    return r.valid ? 0 : 5;
}

static void on_signal(int)
{
    g_stop.store(true);
}

static void usage(const char* argv0)
{
    fprintf(stderr,
            "usage:\n"
            "  %s --image <jpg> [--param p] [--bin b] [--json-out f] [--conf 0.25] [--nms 0.45] [--threads 4]\n"
            "  %s --serve <ip:port> [--duration 600] [--events f] [--stats f] [--param p] [--bin b]\n",
            argv0, argv0);
}

int main(int argc, char** argv)
{
    const char* param = "model.ncnn.param";
    const char* bin = "model.ncnn.bin";
    const char* image = NULL;
    const char* serve = NULL;
    const char* events = "events.jsonl";
    const char* stats = "stats.jsonl";
    const char* json_out = NULL;
    int threads = 4;
    int duration = 0;
    int repeat = 0;
    float conf_thr = 0.25f;
    float nms_thr = 0.45f;

    for (int i = 1; i < argc; i++)
    {
        if (strcmp(argv[i], "--param") == 0 && i + 1 < argc) param = argv[++i];
        else if (strcmp(argv[i], "--bin") == 0 && i + 1 < argc) bin = argv[++i];
        else if (strcmp(argv[i], "--image") == 0 && i + 1 < argc) image = argv[++i];
        else if (strcmp(argv[i], "--serve") == 0 && i + 1 < argc) serve = argv[++i];
        else if (strcmp(argv[i], "--events") == 0 && i + 1 < argc) events = argv[++i];
        else if (strcmp(argv[i], "--stats") == 0 && i + 1 < argc) stats = argv[++i];
        else if (strcmp(argv[i], "--json-out") == 0 && i + 1 < argc) json_out = argv[++i];
        else if (strcmp(argv[i], "--threads") == 0 && i + 1 < argc) threads = atoi(argv[++i]);
        else if (strcmp(argv[i], "--duration") == 0 && i + 1 < argc) duration = atoi(argv[++i]);
        else if (strcmp(argv[i], "--repeat") == 0 && i + 1 < argc) repeat = atoi(argv[++i]);
        else if (strcmp(argv[i], "--conf") == 0 && i + 1 < argc) conf_thr = (float)atof(argv[++i]);
        else if (strcmp(argv[i], "--nms") == 0 && i + 1 < argc) nms_thr = (float)atof(argv[++i]);
        else if (strcmp(argv[i], "--help") == 0) { usage(argv[0]); return 0; }
    }
    if (serve && image)
    {
        fprintf(stderr, "--serve and --image are mutually exclusive\n");
        return 1;
    }
    if (!serve && !image)
    {
        usage(argv[0]);
        return 1;
    }
    signal(SIGINT, on_signal);
    signal(SIGTERM, on_signal);
    if (serve) return serve_camera(param, bin, serve, duration, threads, conf_thr, nms_thr, events, stats);
    return infer_image(param, bin, image, threads, conf_thr, nms_thr, events, stats, repeat, json_out != NULL);
}


