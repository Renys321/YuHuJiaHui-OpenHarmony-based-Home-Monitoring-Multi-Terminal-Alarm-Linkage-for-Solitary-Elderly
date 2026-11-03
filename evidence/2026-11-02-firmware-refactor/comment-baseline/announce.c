/* 告警发声：短提示音和中文语音分两段，蜂鸣器停了才起人声。
 *
 * SOS 的本板求助响 CONFIG_NODE_ALARM_CHIRP_COUNT_SOS 声，替别的房间播报再多 2 声，
 * 两种场景共用同一段 SOS 录音，听得出来但不额外占 flash。
 * 全部非阻塞：tick 只切电平、投递一次语音请求，不耽误采集和上报。
 */
#include "freertos/FreeRTOS.h"

#include "esp_log.h"

#include "announce.h"
#include "board_io.h"
#include "local_voice.h"
#include "node_common.h"

static int     s_chirp_left = 0;        /* 还剩几声 */
static int     s_chirp_on = 0;          /* 当前在“响”的区间 */
static int64_t s_chirp_next_ms = 0;
static int     s_voice_pending = 0;     /* 提示音结束后要播的片段 */
static int64_t s_voice_due_ms = 0;

void announce_cancel(void)
{
    board_buzzer(0);
    s_chirp_left = 0;
    s_chirp_on = 0;
    s_chirp_next_ms = 0;
    s_voice_pending = VOICE_CLIP_NONE;
    s_voice_due_ms = 0;
    local_voice_cancel();
}

void announce_start(int clip)
{
    int beeps = (clip == VOICE_CLIP_REMOTE_SOS)
                ? (CONFIG_NODE_ALARM_CHIRP_COUNT_SOS + 2)
                : (clip == VOICE_CLIP_SOS ? CONFIG_NODE_ALARM_CHIRP_COUNT_SOS
                                          : CONFIG_NODE_ALARM_CHIRP_COUNT);
    int64_t now;
    if (beeps < 1) beeps = 1;
    announce_cancel();          /* 先清掉上一轮，别让提示音/语音叠在一起 */
    now = node_now_ms();
    s_voice_pending = clip;
    s_chirp_left = beeps;
    s_chirp_on = 1;
    board_buzzer(1);
    s_chirp_next_ms = now + CONFIG_NODE_ALARM_CHIRP_ON_MS;
    s_voice_due_ms = now + (int64_t)beeps * CONFIG_NODE_ALARM_CHIRP_ON_MS
                   + (int64_t)(beeps - 1) * CONFIG_NODE_ALARM_CHIRP_GAP_MS
                   + CONFIG_NODE_ALARM_VOICE_GAP_MS;
    ESP_LOGW(TAG, "告警提示音开始：%d 声，间隔 %d ms；随后播报 clip=%d（%s）",
             beeps, (int)CONFIG_NODE_ALARM_CHIRP_GAP_MS, clip, local_voice_text(clip));
}

void announce_tick(void)
{
    int64_t now = node_now_ms();
    if (s_chirp_left > 0 && now >= s_chirp_next_ms) {
        if (s_chirp_on) {
            board_buzzer(0);
            s_chirp_on = 0;
            s_chirp_left--;
            s_chirp_next_ms = now + CONFIG_NODE_ALARM_CHIRP_GAP_MS;
        } else {
            board_buzzer(1);
            s_chirp_on = 1;
            s_chirp_next_ms = now + CONFIG_NODE_ALARM_CHIRP_ON_MS;
        }
    }
    if (s_voice_pending != VOICE_CLIP_NONE && s_chirp_left == 0 && !s_chirp_on &&
        now >= s_voice_due_ms) {
        int clip = s_voice_pending;
        s_voice_pending = VOICE_CLIP_NONE;
        local_voice_play(clip);   /* 蜂鸣器已经停了，人声不会被盖住 */
        ESP_LOGW(TAG, "语音播报开始：clip=%d（%s）", clip, local_voice_text(clip));
    }
}
