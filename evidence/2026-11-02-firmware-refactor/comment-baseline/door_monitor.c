/* 门磁：干簧管 GPIO -> 去抖/上电基线 -> 带序号的事件 FIFO -> NVS 补传缓存。
 *
 * 只读电平，稳定翻转才生成事件；时间没同步时事件 ts 记 0，由服务器按接收时间补。
 * seq 持久化且单调递增，后端按 (deviceId, seq) 幂等去重，所以重启重传不会重复记账。
 * 基线建立前 open 上报 null，不凭空造一条“历史开关门”。
 */
#include <stdio.h>
#include <string.h>

#include "freertos/FreeRTOS.h"
#include "driver/gpio.h"
#include "esp_log.h"
#include "esp_err.h"
#include "nvs.h"

#include "door_monitor.h"
#include "alarm_logic.h"
#include "node_common.h"

#if CONFIG_NODE_DOOR_GPIO >= 0

#define NODE_NVS_DOOR_SEQ    "door_seq"
#define NODE_NVS_DOOR_CACHE  "door_cache"

typedef struct {
    int      seq;
    int      open;          /* 1=开门 0=关门 */
    int64_t  ts;            /* 事件时刻；时钟未同步为 0 */
    int64_t  enqueued_ms;   /* 入队时刻，用来判断缓存是否过期 */
} door_event_t;

static int   s_open = 0;               /* 已确认状态；基线建立前无意义 */
static int64_t s_last_open_ts = 0;
static int64_t s_last_close_ts = 0;
static door_debounce_t s_db;

static door_event_t s_events[CONFIG_NODE_DOOR_CACHE_MAX];
static int s_event_count = 0;
static int s_event_head = 0;
static int s_seq = 0;
static int s_baseline_unknown = 1;

static void door_state_save(void);   /* door_event_expire 定义在前面，先声明 */

static void door_event_enqueue(int seq, int open, int64_t ts)
{
    if (s_event_count < CONFIG_NODE_DOOR_CACHE_MAX) {
        int idx = (s_event_head + s_event_count) % CONFIG_NODE_DOOR_CACHE_MAX;
        s_events[idx].seq = seq;
        s_events[idx].open = open;
        s_events[idx].ts = ts;
        s_events[idx].enqueued_ms = node_now_ms();
        s_event_count++;
    } else {
        /* 缓存满就覆盖最旧一条。后端本身幂等，最旧的 seq 万一没送到，
         * 下一次状态翻转还会带上新的最终状态，不会永久停留在错误状态。 */
        s_events[s_event_head].seq = seq;
        s_events[s_event_head].open = open;
        s_events[s_event_head].ts = ts;
        s_events[s_event_head].enqueued_ms = node_now_ms();
        s_event_head = (s_event_head + 1) % CONFIG_NODE_DOOR_CACHE_MAX;
        ESP_LOGW(TAG, "门磁事件缓存满，覆盖最旧事件（上限 %d 条）", CONFIG_NODE_DOOR_CACHE_MAX);
    }
}

static void door_event_expire(void)
{
    if (s_event_count == 0) return;
    int64_t now = node_now_ms();
    int changed = 0;
    while (s_event_count > 0) {
        door_event_t *e = &s_events[s_event_head];
        if (now - e->enqueued_ms < (int64_t)CONFIG_NODE_DOOR_CACHE_KEEP_SEC * 1000) break;
        s_event_head = (s_event_head + 1) % CONFIG_NODE_DOOR_CACHE_MAX;
        s_event_count--;
        changed = 1;
    }
    if (changed) door_state_save();
}

static void door_state_load(void)
{
    nvs_handle_t h;
    uint32_t seq = 0;
    if (nvs_open(NODE_NVS_NS, NVS_READONLY, &h) != ESP_OK) return;
    if (nvs_get_u32(h, NODE_NVS_DOOR_SEQ, &seq) == ESP_OK && seq > 0) s_seq = (int)seq;
    struct {
        uint32_t magic;
        uint32_t count;
        uint32_t head;
        door_event_t events[CONFIG_NODE_DOOR_CACHE_MAX];
    } doc;
    size_t len = sizeof(doc);
    if (nvs_get_blob(h, NODE_NVS_DOOR_CACHE, &doc, &len) == ESP_OK &&
        len == sizeof(doc) && doc.magic == 0x444F4F52u /* 'DOOR' */ &&
        doc.count <= CONFIG_NODE_DOOR_CACHE_MAX && doc.head < CONFIG_NODE_DOOR_CACHE_MAX) {
        memcpy(s_events, doc.events, sizeof(s_events));
        s_event_count = (int)doc.count;
        s_event_head = (int)doc.head;
    }
    nvs_close(h);
    ESP_LOGI(TAG, "门磁序号恢复 seq=%d 待补传事件=%d", s_seq, s_event_count);
}

static void door_state_save(void)
{
    nvs_handle_t h;
    if (nvs_open(NODE_NVS_NS, NVS_READWRITE, &h) != ESP_OK) {
        ESP_LOGW(TAG, "门磁状态写 NVS 失败（本次仍生效，重启可能丢失）");
        return;
    }
    struct {
        uint32_t magic;
        uint32_t count;
        uint32_t head;
        door_event_t events[CONFIG_NODE_DOOR_CACHE_MAX];
    } doc;
    doc.magic = 0x444F4F52u;
    doc.count = (uint32_t)s_event_count;
    doc.head = (uint32_t)s_event_head;
    memcpy(doc.events, s_events, sizeof(s_events));
    esp_err_t err = nvs_set_blob(h, NODE_NVS_DOOR_CACHE, &doc, sizeof(doc));
    if (err == ESP_OK) err = nvs_set_u32(h, NODE_NVS_DOOR_SEQ, (uint32_t)s_seq);
    if (err == ESP_OK) err = nvs_commit(h);
    nvs_close(h);
    if (err != ESP_OK) ESP_LOGW(TAG, "门磁状态保存失败: %s", esp_err_to_name(err));
}

void door_monitor_start(void)
{
    /* 无源干簧管：一端接 GPIO，另一端接 GND，内部上拉。磁铁靠近触点闭合拉低，
     * 离开则被上拉回高。开启电平按实物实测配置，别照抄别的节点。 */
    gpio_config_t io = { 0 };
    io.intr_type = GPIO_INTR_DISABLE;
    io.mode = GPIO_MODE_INPUT;
    io.pin_bit_mask = 1ULL << CONFIG_NODE_DOOR_GPIO;
    io.pull_up_en = GPIO_PULLUP_ENABLE;
    io.pull_down_en = GPIO_PULLDOWN_DISABLE;
    gpio_config(&io);
    door_reset(&s_db);
    s_baseline_unknown = 1;
    s_open = 0;
    door_state_load();
    ESP_LOGI(TAG, "门磁已配置 GPIO%d（开启电平=%d，去抖确认=%d 次，缓存=%d 条/%ds）",
             (int)CONFIG_NODE_DOOR_GPIO, (int)CONFIG_NODE_DOOR_OPEN_LEVEL,
             (int)CONFIG_NODE_DOOR_CONFIRM_COUNT, (int)CONFIG_NODE_DOOR_CACHE_MAX,
             (int)CONFIG_NODE_DOOR_CACHE_KEEP_SEC);
}

void door_monitor_poll(int time_synced, int bench_raw)
{
    int door_raw = (bench_raw >= 0) ? bench_raw
                                    : (gpio_get_level(CONFIG_NODE_DOOR_GPIO) ? 1 : 0);
    if (door_update(&s_db, door_raw, CONFIG_NODE_DOOR_OPEN_LEVEL,
                    CONFIG_NODE_DOOR_CONFIRM_COUNT)) {
        s_open = s_db.stable_open;
        int64_t ev_ts = time_synced ? node_now_ms() : 0;
        int seq = ++s_seq;
        door_event_enqueue(seq, s_open, ev_ts);
        if (s_open) s_last_open_ts = ev_ts;
        else s_last_close_ts = ev_ts;
        ESP_LOGI(TAG, "门磁状态变化：%s（seq=%d%s）", s_open ? "开启" : "关闭",
                 seq, ev_ts > 0 ? "" : "，时间未同步按服务器时间记录");
        door_state_save();
    }
    if (s_db.baseline_set) {
        s_open = s_db.stable_open;
        if (s_baseline_unknown) {
            s_baseline_unknown = 0;
            ESP_LOGI(TAG, "门磁基线建立：当前状态=%s（不生成历史事件）",
                     s_open ? "开启" : "关闭");
        }
    }
    door_event_expire();
}

void door_report_json(char *out, size_t out_sz)
{
    int n = 0;
    n += snprintf(out + n, out_sz - (size_t)n,
        "\"door\":{\"open\":%s,\"lastOpenTs\":%lld,\"lastCloseTs\":%lld,\"seq\":%d",
        s_baseline_unknown ? "null" : (s_open ? "true" : "false"),
        (long long)s_last_open_ts, (long long)s_last_close_ts, s_seq);
    if (s_event_count > 0) {
        n += snprintf(out + n, out_sz - (size_t)n, ",\"events\":[");
        for (int i = 0; i < s_event_count && n < (int)out_sz - 8; i++) {
            door_event_t *e = &s_events[(s_event_head + i) % CONFIG_NODE_DOOR_CACHE_MAX];
            n += snprintf(out + n, out_sz - (size_t)n,
                "%s{\"seq\":%d,\"open\":%s,\"ts\":%lld}",
                i > 0 ? "," : "", e->seq, e->open ? "true" : "false", (long long)e->ts);
        }
        n += snprintf(out + n, out_sz - (size_t)n, "]");
    }
    snprintf(out + n, out_sz - (size_t)n, "},");
}

#else  /* 门磁未启用：保持旧字段，APP 侧不用改 */

void door_monitor_start(void) {}
void door_monitor_poll(int time_synced, int bench_raw)
{
    (void)time_synced;
    (void)bench_raw;
}
void door_report_json(char *out, size_t out_sz)
{
    snprintf(out, out_sz, "\"door\":{\"open\":false,\"lastOpenTs\":0},");
}

#endif
