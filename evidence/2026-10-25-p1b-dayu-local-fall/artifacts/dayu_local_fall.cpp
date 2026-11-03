// P1-B DAYU200 local pose/fall candidate.
//
// Modes:
//   --image <jpg>                 single image inference + posture evaluation
//   --dir <dir>                   replay a bounded local JPEG frame set (same inputs for 640/416/320)
//   --serve 127.0.0.1:9200        receive the official DAYU APP camera frames on device loopback
//   --selftest                    deterministic keypoint/time fixtures (no model/camera)
//
// All inference and fall evaluation runs on DAYU. Events are local JSONL only; no MQTT,
// backend, homemon or APP integration. The HTTP response keeps fall=false/fallEvaluated=false
// because formal APP alerting is explicitly out of scope for P1-B.

#include "fall_core.h"
#include "net.h"

#define STB_IMAGE_IMPLEMENTATION
#include "stb_image.h"

#include <arpa/inet.h>
#include <ctype.h>
#include <dirent.h>
#include <errno.h>
#include <netinet/in.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <condition_variable>
#include <cstdarg>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

using namespace p1b;

static const char* kSchemaV2 = "p1b.dayu.local.fall.event/2";
static const char* kModelVersion = "p1b-2026-10-25";
static const char* kDeviceId = "dayu200-p1b-candidate";
static const char* kCandidateSource = "dayu-camera-http";
static const float kPadValue = 114.0f;
static const int kNumPoints = 17;

static std::atomic<bool> g_stop(false);
static int g_rotate = 0; // 0/90/180/270, applied BEFORE letterbox/inference

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
    char* p = strrchr(buf, ')');
    if (!p) return -1;
    p += 2;
    long utime = 0, stime = 0;
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

static bool rotate_rgb(const unsigned char* src, int w, int h, int rot,
                       std::vector<unsigned char>& dst, int& ow, int& oh)
{
    if (rot == 0)
    {
        ow = w;
        oh = h;
        dst.assign(src, src + (size_t)w * h * 3);
        return true;
    }
    if (rot != 90 && rot != 180 && rot != 270) return false;
    const bool swap = (rot == 90 || rot == 270);
    ow = swap ? h : w;
    oh = swap ? w : h;
    dst.resize((size_t)ow * oh * 3);
    for (int y = 0; y < h; y++)
    {
        for (int x = 0; x < w; x++)
        {
            int nx = 0, ny = 0;
            if (rot == 90) { nx = h - 1 - y; ny = x; }
            else if (rot == 180) { nx = w - 1 - x; ny = h - 1 - y; }
            else { nx = y; ny = w - 1 - x; }
            const unsigned char* sp = src + ((size_t)y * w + x) * 3;
            unsigned char* dp = dst.data() + ((size_t)ny * ow + nx) * 3;
            dp[0] = sp[0]; dp[1] = sp[1]; dp[2] = sp[2];
        }
    }
    return true;
}

static std::string json_escape(const char* s)
{
    if (!s) return std::string();
    std::string out;
    for (const char* p = s; *p; p++)
    {
        char c = *p;
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
        else out.push_back(c);
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
    int person_count = -1;
    double infer_ms = 0;
    std::vector<Detection> dets;
};

static float iou_det(const Detection& a, const Detection& b)
{
    float ix1 = std::max(a.x, b.x), iy1 = std::max(a.y, b.y);
    float ix2 = std::min(a.x + a.w, b.x + b.w), iy2 = std::min(a.y + a.h, b.y + b.h);
    float iw = std::max(0.f, ix2 - ix1), ih = std::max(0.f, iy2 - iy1);
    float inter = iw * ih;
    float uni = a.w * a.h + b.w * b.h - inter;
    return uni > 0 ? inter / uni : 0.f;
}

class PoseModel
{
public:
    PoseModel(int input_size, int threads) : input_size_(input_size), threads_(threads) {}

    bool load(const char* param, const char* bin)
    {
        net_.opt.use_vulkan_compute = false;
        net_.opt.num_threads = threads_;
        if (net_.load_param(param) != 0) return false;
        if (net_.load_model(bin) != 0) return false;
        return true;
    }

    int input_size() const { return input_size_; }

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
        std::vector<unsigned char> rotated;
        const unsigned char* pixels = rgb;
        int rw = w, rh = h;
        if (g_rotate != 0)
        {
            if (!rotate_rgb(rgb, w, h, g_rotate, rotated, rw, rh))
            {
                stbi_image_free(rgb);
                r.error = "rotation_failed";
                return r;
            }
            stbi_image_free(rgb);
            pixels = rotated.data();
        }
        r.img_w = rw;
        r.img_h = rh;
        const int target = input_size_;
        float scale = std::min((float)target / (float)rw, (float)target / (float)rh);
        int nw = (int)std::round(rw * scale);
        int nh = (int)std::round(rh * scale);
        int dw = target - nw;
        int dh = target - nh;
        int left = dw / 2;
        int top = dh / 2;

        ncnn::Mat in = ncnn::Mat::from_pixels_resize(pixels, ncnn::Mat::PIXEL_RGB, rw, rh, nw, nh);
        if (g_rotate == 0) stbi_image_free(rgb);
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
            float score = out.row(4)[a];
            if (!(score >= conf_thr)) continue;
            Detection d;
            float cx = out.row(0)[a], cy = out.row(1)[a], bw = out.row(2)[a], bh = out.row(3)[a];
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
                if (!removed[j] && iou_det(proposals[i], proposals[j]) > nms_thr) removed[j] = true;
            }
        }
        r.infer_ms = (double)(now_ms_mono() - t0);
        r.dets = kept;
        r.person_count = (int)kept.size();
        r.valid = true;
        return r;
    }

private:
    int input_size_;
    int threads_;
    ncnn::Net net_;
};

// ------------------------- event JSON -------------------------

static std::string reasons_json(const std::vector<std::string>& codes)
{
    std::string s = "[";
    for (size_t i = 0; i < codes.size(); i++)
    {
        if (i) s += ",";
        s += "\"" + json_escape(codes[i].c_str()) + "\"";
    }
    s += "]";
    return s;
}

static std::string event_json_v2(const char* source, const char* model_id, int input_size,
                                 int64_t frame_ts_ms, int64_t event_ts_ms, const InferResult& r,
                                 const FallDecision& d, int64_t dropped, long rss_kb, double cpu_s, double temp_c)
{
    std::string j;
    char buf[2048];
    j += "{";
    snprintf(buf, sizeof(buf),
             "\"schema\":\"%s\",\"source\":\"%s\",\"deviceId\":\"%s\","
             "\"modelId\":\"%s\",\"modelVersion\":\"%s\",\"modelInput\":[%d,%d],"
             "\"frameTsMs\":%lld,\"eventTsMs\":%lld,",
             kSchemaV2, source, kDeviceId, model_id, kModelVersion, input_size, input_size,
             (long long)frame_ts_ms, (long long)event_ts_ms);
    j += buf;
    snprintf(buf, sizeof(buf),
             "\"dataValid\":%s,\"personCount\":%d,\"trackId\":\"%s\","
             "\"posture\":\"%s\",\"postureConfidence\":%.3f,"
             "\"fallState\":\"%s\",\"fall\":%s,\"fallEvaluated\":%s,\"fallEventId\":\"%s\",",
             r.valid ? "true" : "false", d.person_count, json_escape(d.track_id.c_str()).c_str(),
             posture_name(d.posture), d.posture_conf,
             fall_state_name(d.state), d.fall ? "true" : "false", d.fall_evaluated ? "true" : "false",
             json_escape(d.fall_event_id.c_str()).c_str());
    j += buf;
    j += "\"reasonCodes\":";
    j += reasons_json(d.reason_codes);
    snprintf(buf, sizeof(buf),
             ",\"descentVelocity\":%.3f,\"torsoAngle\":%.2f,\"bboxAspectRatio\":%.3f,"
             "\"horizontalDurationMs\":%lld,\"validKptCount\":%d,\"kptConfAvg\":%.3f,\"kptConfMin\":%.3f,",
             d.descent_velocity, d.torso_angle, d.bbox_aspect,
             (long long)d.horizontal_duration_ms, d.valid_kpts, d.kpt_conf_avg, d.kpt_conf_min);
    j += buf;
    snprintf(buf, sizeof(buf),
             "\"eventType\":\"%s\",\"fallAlreadyConfirmed\":%s,\"fallEventActive\":%s,"
             "\"recovered\":%s,\"trackSwitched\":%s,\"selectedReason\":\"%s\","
             "\"primaryBBox\":[%.1f,%.1f,%.1f,%.1f],",
             json_escape(d.event_type.c_str()).c_str(), d.fall_already_confirmed ? "true" : "false",
             d.fall_event_active ? "true" : "false", d.recovered ? "true" : "false",
             d.track_switched ? "true" : "false", json_escape(d.selected_reason.c_str()).c_str(),
             d.primary_bbox[0], d.primary_bbox[1], d.primary_bbox[2], d.primary_bbox[3]);
    j += buf;
    j += "\"primaryKeypoints\":[";
    for (int q = 0; q < kNumPoints; q++)
    {
        char kb[64];
        snprintf(kb, sizeof(kb), "%s[%.1f,%.1f,%.4f]", q ? "," : "",
                 d.primary_keypoints[q * 3 + 0], d.primary_keypoints[q * 3 + 1], d.primary_keypoints[q * 3 + 2]);
        j += kb;
    }
    j += "],";
    snprintf(buf, sizeof(buf),
             "\"inferMs\":%.2f,\"droppedFrames\":%lld,\"rssKb\":%ld,\"cpuSeconds\":%.2f,\"tempC\":%.1f,"
             "\"error\":\"%s\"}\n",
             r.infer_ms, (long long)dropped, rss_kb, cpu_s, temp_c,
             json_escape(r.error.c_str()).c_str());
    j += buf;
    return j;
}

// ------------------------- stats -------------------------

struct Stats
{
    std::vector<double> infer_ms;
    int64_t frames_received = 0;
    int64_t frames_inferred = 0;
    int64_t frames_dropped = 0;
    int64_t errors = 0;
    int64_t fall_confirmed_events = 0;
    int64_t recovered_events = 0;
    int posture_counts[6] = {0, 0, 0, 0, 0, 0};
    int64_t started_ms = 0;
};

static void count_posture(Stats& st, Posture p)
{
    int idx = (int)p;
    if (idx >= 0 && idx < 6) st.posture_counts[idx]++;
}

static void write_summary(const Stats& st, const char* stats_path, const char* events_path,
                          const char* model_id, int input_size, int threads, float conf_thr, float nms_thr,
                          bool served)
{
    std::vector<double> v = st.infer_ms;
    std::sort(v.begin(), v.end());
    double p50 = v.empty() ? -1 : v[v.size() / 2];
    double p95 = v.empty() ? -1 : v[(size_t)(v.size() * 0.95)];
    double pmin = v.empty() ? -1 : v.front();
    double pmax = v.empty() ? -1 : v.back();
    double avg = 0;
    for (size_t i = 0; i < v.size(); i++) avg += v[i];
    if (!v.empty()) avg /= v.size();
    double elapsed_s = (now_ms_mono() - st.started_ms) / 1000.0;
    std::string j;
    char buf[2048];
    j += "{";
    snprintf(buf, sizeof(buf),
             "\"schema\":\"p1b.dayu.local.fall.summary/2\",\"host\":\"dayu200\",\"modelId\":\"%s\","
             "\"modelVersion\":\"%s\",\"modelInput\":[%d,%d],\"mode\":\"%s\",\"threads\":%d,"
             "\"confThreshold\":%.2f,\"nmsThreshold\":%.2f,\"elapsedSec\":%.1f,"
             "\"framesReceived\":%lld,\"framesInferred\":%lld,\"framesDropped\":%lld,\"errors\":%lld,",
             model_id, kModelVersion, input_size, input_size, served ? "camera-http" : "replay-or-image",
             threads, conf_thr, nms_thr, elapsed_s, (long long)st.frames_received,
             (long long)st.frames_inferred, (long long)st.frames_dropped, (long long)st.errors);
    j += buf;
    snprintf(buf, sizeof(buf),
             "\"inferMsP50\":%.2f,\"inferMsP95\":%.2f,\"inferMsAvg\":%.2f,\"inferMsMin\":%.2f,"
             "\"inferMsMax\":%.2f,\"captureFps\":%.2f,\"inferFps\":%.2f,",
             p50, p95, avg, pmin, pmax,
             elapsed_s > 0 ? st.frames_received / elapsed_s : 0,
             elapsed_s > 0 ? st.frames_inferred / elapsed_s : 0);
    j += buf;
    snprintf(buf, sizeof(buf),
             "\"postureCounts\":{\"NO_PERSON\":%d,\"UPRIGHT\":%d,\"SITTING_OR_CROUCHING\":%d,"
             "\"HORIZONTAL\":%d,\"TRANSITION\":%d,\"UNKNOWN\":%d},"
             "\"fallConfirmedEvents\":%lld,\"recoveredEvents\":%lld,",
             st.posture_counts[(int)Posture::NO_PERSON], st.posture_counts[(int)Posture::UPRIGHT],
             st.posture_counts[(int)Posture::SITTING_OR_CROUCHING], st.posture_counts[(int)Posture::HORIZONTAL],
             st.posture_counts[(int)Posture::TRANSITION], st.posture_counts[(int)Posture::UNKNOWN],
             (long long)st.fall_confirmed_events, (long long)st.recovered_events);
    j += buf;
    snprintf(buf, sizeof(buf),
             "\"rssKb\":%ld,\"cpuSeconds\":%.2f,\"tempC\":%.1f,\"events\":\"%s\",\"finishedAt\":\"%s\"}\n",
             read_rss_kb(), read_cpu_seconds(), read_temp_c(),
             json_escape(events_path ? events_path : "").c_str(), iso8601_now().c_str());
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

static void append_event(const std::string& ev, const char* events_path)
{
    FILE* fp = fopen(events_path, "ab");
    if (fp)
    {
        fwrite(ev.data(), 1, ev.size(), fp);
        fclose(fp);
    }
}

// ------------------------- HTTP -------------------------

struct FrameSlot
{
    std::mutex m;
    std::condition_variable cv;
    std::vector<unsigned char> data;
    int64_t frame_mono_ms = 0;
    int64_t frame_wall_ms = 0;
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
            content_length = (size_t)strtoul(line.c_str() + strlen("content-length:"), NULL, 10);
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
             "Content-Length: %zu\r\nConnection: close\r\n\r\n", body.size());
    send(fd, header, strlen(header), 0);
    send(fd, body.data(), body.size(), 0);
}

static void http_bad_request(int fd, const char* msg)
{
    std::string body = std::string("{\"ok\":false,\"error\":\"") + msg + "\"}";
    char header[256];
    snprintf(header, sizeof(header),
             "HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: %zu\r\n"
             "Connection: close\r\n\r\n", body.size());
    send(fd, header, strlen(header), 0);
    send(fd, body.data(), body.size(), 0);
}

struct SaveFramesOpt
{
    std::string dir;
    int limit = 0;
    int every = 1;
};

static bool save_frame(const SaveFramesOpt& opt, int64_t seq, const std::vector<unsigned char>& data)
{
    if (opt.dir.empty() || opt.limit <= 0) return false;
    if (seq % opt.every != 0) return false;
    int64_t saved = seq / opt.every;
    if (saved > opt.limit) return false;
    char path[512];
    snprintf(path, sizeof(path), "%s/frame_%06lld.jpg", opt.dir.c_str(), (long long)saved);
    FILE* fp = fopen(path, "wb");
    if (!fp) return false;
    fwrite(data.data(), 1, data.size(), fp);
    fclose(fp);
    return true;
}

static int serve_camera(const char* param, const char* bin, const char* listen_addr, int duration_s, int threads,
                        int input_size, const char* model_id, float conf_thr, float nms_thr,
                        const char* events_path, const char* stats_path, const SaveFramesOpt& save)
{
    std::string addr = listen_addr ? listen_addr : "127.0.0.1:9200";
    size_t colon = addr.rfind(':');
    std::string host = colon == std::string::npos ? "127.0.0.1" : addr.substr(0, colon);
    int port = colon == std::string::npos ? 9200 : atoi(addr.c_str() + colon + 1);
    if (host != "127.0.0.1" && host != "localhost")
    {
        fprintf(stderr, "refusing non-loopback bind: %s\n", host.c_str());
        return 2;
    }

    int sfd = socket(AF_INET, SOCK_STREAM, 0);
    if (sfd < 0) { fprintf(stderr, "socket failed: %s\n", strerror(errno)); return 2; }
    int one = 1;
    setsockopt(sfd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
    struct sockaddr_in sa;
    memset(&sa, 0, sizeof(sa));
    sa.sin_family = AF_INET;
    sa.sin_port = htons((uint16_t)port);
    inet_pton(AF_INET, host.c_str(), &sa.sin_addr);
    if (bind(sfd, (struct sockaddr*)&sa, sizeof(sa)) != 0)
    {
        fprintf(stderr, "bind %s failed: %s\n", addr.c_str(), strerror(errno));
        close(sfd);
        return 3;
    }
    if (listen(sfd, 8) != 0) { close(sfd); return 3; }
    fprintf(stderr, "[p1b] listening %s model=%s size=%d threads=%d duration=%ds\n",
            addr.c_str(), model_id, input_size, threads, duration_s);

    PoseModel model(input_size, threads);
    if (!model.load(param, bin))
    {
        fprintf(stderr, "model load failed\n");
        close(sfd);
        return 4;
    }
    FallEngine engine;
    Stats st;
    st.started_ms = now_ms_mono();

    FrameSlot slot;
    std::mutex result_m;
    std::string last_result = "{\"ok\":true,\"personDetected\":false,\"dataValid\":false,\"stale\":true,"
                              "\"source\":\"dayu-local-p1b\",\"fall\":false,\"fallEvaluated\":false,"
                              "\"p1bPosture\":\"UNKNOWN\",\"p1bFallState\":\"UNKNOWN\","
                              "\"p1bFallEvaluated\":false,\"p1bFallEventId\":\"\"}";
    std::atomic<bool> last_person(false);

    std::thread worker([&]() {
        while (true)
        {
            std::vector<unsigned char> data;
            int64_t mono_ms = 0, wall_ms = 0;
            {
                std::unique_lock<std::mutex> lk(slot.m);
                slot.cv.wait(lk, [&]() { return slot.has || !slot.running; });
                if (!slot.running) break;
                data.swap(slot.data);
                mono_ms = slot.frame_mono_ms;
                wall_ms = slot.frame_wall_ms;
                slot.has = false;
            }
            InferResult r = model.infer_jpeg(data.data(), data.size(), conf_thr, nms_thr);
            FrameInput fi;
            fi.mono_ms = mono_ms;
            fi.data_valid = r.valid;
            fi.error = r.error;
            fi.img_w = r.img_w;
            fi.img_h = r.img_h;
            if (r.valid)
            {
                for (size_t i = 0; i < r.dets.size(); i++)
                {
                    PersonObs p;
                    p.x = r.dets[i].x; p.y = r.dets[i].y; p.w = r.dets[i].w; p.h = r.dets[i].h;
                    p.conf = r.dets[i].conf;
                    for (int k = 0; k < kNumPoints; k++)
                    {
                        p.kpts[k].x = r.dets[i].kpts[k * 3 + 0];
                        p.kpts[k].y = r.dets[i].kpts[k * 3 + 1];
                        p.kpts[k].conf = r.dets[i].kpts[k * 3 + 2];
                    }
                    fi.persons.push_back(p);
                }
            }
            FallDecision d = engine.process(fi);
            st.frames_inferred++;
            count_posture(st, d.posture);
            if (d.event_type == "FALL_CONFIRMED") st.fall_confirmed_events++;
            if (d.event_type == "RECOVERED") st.recovered_events++;
            if (r.valid) st.infer_ms.push_back(r.infer_ms);
            else st.errors++;
            std::string ev = event_json_v2(kCandidateSource, model_id, input_size, wall_ms, now_ms_wall(), r, d,
                                           st.frames_dropped, read_rss_kb(), read_cpu_seconds(), read_temp_c());
            append_event(ev, events_path);
            {
                std::lock_guard<std::mutex> lk(result_m);
                char rb[512];
                snprintf(rb, sizeof(rb),
                         "{\"ok\":true,\"personDetected\":%s,\"personCount\":%d,\"dataValid\":%s,"
                         "\"source\":\"dayu-local-p1b\",\"fall\":false,\"fallEvaluated\":false,"
                         "\"inferMs\":%.1f,\"stale\":false,\"p1bPosture\":\"%s\",\"p1bFallState\":\"%s\","
                         "\"p1bFallEvaluated\":%s,\"p1bFallEventId\":\"%s\"}",
                         (r.valid && r.person_count > 0) ? "true" : "false",
                         r.valid ? r.person_count : -1, r.valid ? "true" : "false", r.infer_ms,
                         posture_name(d.posture), fall_state_name(d.state),
                         d.fall_evaluated ? "true" : "false",
                         json_escape(d.fall_event_id.c_str()).c_str());
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
        if (!http_read_request(cfd, method, path, clen, body))
        {
            http_bad_request(cfd, "bad_request");
            close(cfd);
            continue;
        }
        if (method == "GET" && path.find("/healthz") == 0)
        {
            char hb[512];
            snprintf(hb, sizeof(hb),
                     "{\"ok\":true,\"service\":\"dayu-local-p1b\",\"framesReceived\":%lld,"
                     "\"inferred\":%lld,\"dropped\":%lld,\"errors\":%lld,\"fallConfirmedEvents\":%lld,"
                     "\"rssKb\":%ld,\"tempC\":%.1f}",
                     (long long)st.frames_received, (long long)st.frames_inferred,
                     (long long)st.frames_dropped, (long long)st.errors,
                     (long long)st.fall_confirmed_events, read_rss_kb(), read_temp_c());
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
        save_frame(save, st.frames_received, body);
        {
            std::lock_guard<std::mutex> lk(slot.m);
            if (slot.has) st.frames_dropped++;
            slot.data.swap(body);
            slot.frame_mono_ms = now_ms_mono();
            slot.frame_wall_ms = now_ms_wall();
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
    write_summary(st, stats_path, events_path, model_id, input_size, threads, conf_thr, nms_thr, true);
    return 0;
}

// ------------------------- image / dir replay -------------------------

static bool read_file(const char* path, std::vector<unsigned char>& out)
{
    FILE* fp = fopen(path, "rb");
    if (!fp) return false;
    fseek(fp, 0, SEEK_END);
    long sz = ftell(fp);
    fseek(fp, 0, SEEK_SET);
    if (sz <= 0) { fclose(fp); return false; }
    out.resize((size_t)sz);
    bool ok = fread(out.data(), 1, out.size(), fp) == out.size();
    fclose(fp);
    return ok;
}

static int run_frames(const char* param, const char* bin, const std::vector<std::string>& files,
                      int threads, int input_size, const char* model_id, float conf_thr, float nms_thr,
                      const char* source, const char* events_path, const char* stats_path, int repeat)
{
    PoseModel model(input_size, threads);
    if (!model.load(param, bin)) { fprintf(stderr, "model load failed\n"); return 4; }
    FallEngine engine;
    Stats st;
    st.started_ms = now_ms_mono();
    int64_t mono = st.started_ms;
    int n = repeat > 0 ? repeat : 1;
    for (int rep = 0; rep < n; rep++)
    {
        for (size_t i = 0; i < files.size(); i++)
        {
            std::vector<unsigned char> data;
            if (!read_file(files[i].c_str(), data)) { st.errors++; continue; }
            InferResult r = model.infer_jpeg(data.data(), data.size(), conf_thr, nms_thr);
            mono += 500; // deterministic replay cadence; state machine uses monotonic time, not frame index
            FrameInput fi;
            fi.mono_ms = mono;
            fi.data_valid = r.valid;
            fi.error = r.error;
            fi.img_w = r.img_w;
            fi.img_h = r.img_h;
            if (r.valid)
            {
                for (size_t k = 0; k < r.dets.size(); k++)
                {
                    PersonObs p;
                    p.x = r.dets[k].x; p.y = r.dets[k].y; p.w = r.dets[k].w; p.h = r.dets[k].h;
                    p.conf = r.dets[k].conf;
                    for (int q = 0; q < kNumPoints; q++)
                    {
                        p.kpts[q].x = r.dets[k].kpts[q * 3 + 0];
                        p.kpts[q].y = r.dets[k].kpts[q * 3 + 1];
                        p.kpts[q].conf = r.dets[k].kpts[q * 3 + 2];
                    }
                    fi.persons.push_back(p);
                }
            }
            FallDecision d = engine.process(fi);
            st.frames_received++;
            st.frames_inferred++;
            count_posture(st, d.posture);
            if (d.event_type == "FALL_CONFIRMED") st.fall_confirmed_events++;
            if (d.event_type == "RECOVERED") st.recovered_events++;
            if (r.valid) st.infer_ms.push_back(r.infer_ms); else st.errors++;
            std::string ev = event_json_v2(source, model_id, input_size, now_ms_wall(), now_ms_wall(), r, d,
                                           st.frames_dropped, read_rss_kb(), read_cpu_seconds(), read_temp_c());
            append_event(ev, events_path);
            printf("%s", ev.c_str());
        }
    }
    write_summary(st, stats_path, events_path, model_id, input_size, threads, conf_thr, nms_thr, false);
    return st.errors == 0 ? 0 : 5;
}

static int run_one_image(const char* param, const char* bin, const char* image, int threads, int input_size,
                         const char* model_id, float conf_thr, float nms_thr, const char* events_path,
                         const char* stats_path, bool quiet)
{
    std::vector<std::string> files;
    files.push_back(image);
    if (quiet) freopen("/dev/null", "w", stdout);
    int rc = run_frames(param, bin, files, threads, input_size, model_id, conf_thr, nms_thr,
                        "dayu-image-file", events_path, stats_path, 1);
    return rc;
}

static bool ends_with(const std::string& s, const char* suffix)
{
    size_t n = strlen(suffix);
    return s.size() >= n && s.compare(s.size() - n, n, suffix) == 0;
}

static int run_dir(const char* param, const char* bin, const char* dir, int threads, int input_size,
                   const char* model_id, float conf_thr, float nms_thr, const char* events_path,
                   const char* stats_path, int repeat)
{
    DIR* d = opendir(dir);
    if (!d) { fprintf(stderr, "cannot open dir %s\n", dir); return 2; }
    std::vector<std::string> files;
    struct dirent* e;
    while ((e = readdir(d)) != NULL)
    {
        std::string name(e->d_name);
        if (ends_with(name, ".jpg") || ends_with(name, ".jpeg") || ends_with(name, ".JPG"))
        {
            files.push_back(std::string(dir) + "/" + name);
        }
    }
    closedir(d);
    std::sort(files.begin(), files.end());
    if (files.empty()) { fprintf(stderr, "no JPEGs in %s\n", dir); return 2; }
    return run_frames(param, bin, files, threads, input_size, model_id, conf_thr, nms_thr,
                      "dayu-frame-replay", events_path, stats_path, repeat);
}

// ------------------------- main -------------------------

static void on_signal(int) { g_stop.store(true); }

static void usage(const char* argv0)
{
    fprintf(stderr,
            "usage:\n"
            "  %s --image <jpg> --param p --bin b --size 320 [--events f] [--stats f]\n"
            "  %s --dir <framesdir> --param p --bin b --size 320 [--repeat 1]\n"
            "  %s --serve 127.0.0.1:9200 --param p --bin b --size 320 [--duration 1500]\n"
            "  %s --selftest\n",
            argv0, argv0, argv0, argv0);
}

static int model_id_from_size(int size, char* out, size_t out_size)
{
    snprintf(out, out_size, "yolo11n-pose-ncnn-%d-static-p1b", size);
    return 0;
}

extern int run_selftest();

int main(int argc, char** argv)
{
    const char* param = "model.ncnn.param";
    const char* bin = "model.ncnn.bin";
    const char* image = NULL;
    const char* dir = NULL;
    const char* serve = NULL;
    const char* events = "events.jsonl";
    const char* stats = "stats.jsonl";
    const char* save_dir = NULL;
    int save_limit = 0;
    int save_every = 1;
    int threads = 4;
    int input_size = 320;
    int duration = 0;
    int repeat = 0;
    float conf_thr = 0.25f;
    float nms_thr = 0.45f;
    bool selftest = false;

    for (int i = 1; i < argc; i++)
    {
        if (strcmp(argv[i], "--param") == 0 && i + 1 < argc) param = argv[++i];
        else if (strcmp(argv[i], "--bin") == 0 && i + 1 < argc) bin = argv[++i];
        else if (strcmp(argv[i], "--image") == 0 && i + 1 < argc) image = argv[++i];
        else if (strcmp(argv[i], "--dir") == 0 && i + 1 < argc) dir = argv[++i];
        else if (strcmp(argv[i], "--serve") == 0 && i + 1 < argc) serve = argv[++i];
        else if (strcmp(argv[i], "--events") == 0 && i + 1 < argc) events = argv[++i];
        else if (strcmp(argv[i], "--stats") == 0 && i + 1 < argc) stats = argv[++i];
        else if (strcmp(argv[i], "--save-frames") == 0 && i + 1 < argc) save_dir = argv[++i];
        else if (strcmp(argv[i], "--save-limit") == 0 && i + 1 < argc) save_limit = atoi(argv[++i]);
        else if (strcmp(argv[i], "--save-every") == 0 && i + 1 < argc) save_every = atoi(argv[++i]);
        else if (strcmp(argv[i], "--threads") == 0 && i + 1 < argc) threads = atoi(argv[++i]);
        else if (strcmp(argv[i], "--size") == 0 && i + 1 < argc) input_size = atoi(argv[++i]);
        else if (strcmp(argv[i], "--duration") == 0 && i + 1 < argc) duration = atoi(argv[++i]);
        else if (strcmp(argv[i], "--repeat") == 0 && i + 1 < argc) repeat = atoi(argv[++i]);
        else if (strcmp(argv[i], "--rotate") == 0 && i + 1 < argc) g_rotate = atoi(argv[++i]);
        else if (strcmp(argv[i], "--conf") == 0 && i + 1 < argc) conf_thr = (float)atof(argv[++i]);
        else if (strcmp(argv[i], "--nms") == 0 && i + 1 < argc) nms_thr = (float)atof(argv[++i]);
        else if (strcmp(argv[i], "--selftest") == 0) selftest = true;
        else if (strcmp(argv[i], "--help") == 0) { usage(argv[0]); return 0; }
    }
    if (selftest) return run_selftest();
    if ((serve ? 1 : 0) + (image ? 1 : 0) + (dir ? 1 : 0) != 1)
    {
        usage(argv[0]);
        return 1;
    }
    if (g_rotate != 0 && g_rotate != 90 && g_rotate != 180 && g_rotate != 270)
    {
        fprintf(stderr, "unsupported --rotate %d (0/90/180/270)\n", g_rotate);
        return 1;
    }
    if (input_size != 640 && input_size != 416 && input_size != 320)
    {
        fprintf(stderr, "unsupported --size %d (640/416/320)\n", input_size);
        return 1;
    }
    signal(SIGINT, on_signal);
    signal(SIGTERM, on_signal);

    char model_id[96];
    snprintf(model_id, sizeof(model_id), "yolo11n-pose-ncnn-%d-static-p1b", input_size);

    if (serve)
    {
        SaveFramesOpt save;
        if (save_dir) { save.dir = save_dir; save.limit = save_limit; save.every = save_every; }
        return serve_camera(param, bin, serve, duration, threads, input_size, model_id, conf_thr, nms_thr,
                            events, stats, save);
    }
    if (dir) return run_dir(param, bin, dir, threads, input_size, model_id, conf_thr, nms_thr,
                           events, stats, repeat);
    return run_one_image(param, bin, image, threads, input_size, model_id, conf_thr, nms_thr,
                         events, stats, false);
}


