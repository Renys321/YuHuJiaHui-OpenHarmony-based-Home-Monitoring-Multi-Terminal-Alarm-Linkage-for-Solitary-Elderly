#ifndef LOCAL_VOICE_H
#define LOCAL_VOICE_H
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
/* 板载 ES8388 扬声器：离线中文语音播报（仅播放，无麦克风/URL/网络）。
 * 2026-10-31 BOARD-MIC：新增板载咪头采集（ES8388 ADC + I2S RX，DIN=GPIO14）。
 * 采集与播放共用 BCLK/WS/MCLK，按会话切换：mic_begin 独占 I2S+功放锁，
 * mic_end 卸载 RX 驱动并恢复原播放通路。禁止常开麦克风。
 *
 *  LOCAL-ALARM-SPEECH-FINAL：把原来的两条 PCM 换成 6 条与“真实触发原因”
 * 一一对应的中文语音。原缺陷（用户实测）：sos.pcm 其实是 1.25 秒正弦“滴滴”提示音，
 * 不是人声，所以 SOS 只听到几声鸣叫；且蜂鸣器连续响 10 秒与语音完全重叠、遮盖人声。
 * 现在短提示音结束后才播完整语音，由 node_main.c 的 announce_* 状态机编排，
 * 蜂鸣与语音不重叠。
 *
 * 片段编号必须与 main/voice 目录下的 .adpcm 文件及 main/local_voice.c 的 s_clips[] 完全一致。
 */
#define VOICE_CLIP_NONE            0
#define VOICE_CLIP_SOS             1   /* 我需要帮助，请尽快过来。 */
#define VOICE_CLIP_CLIMATE_TEMP    2   /* 室内温度异常，请前来查看。 */
#define VOICE_CLIP_CLIMATE_RH      3   /* 室内湿度异常，请前来查看。 */
#define VOICE_CLIP_CLIMATE_BOTH    4   /* 室内温度和湿度异常，请前来查看。 */
#define VOICE_CLIP_NO_MOTION       5   /* 长时间未检测到活动，请确认家人情况。 */
#define VOICE_CLIP_CLIMATE_GENERIC 6   /* 室内温湿度异常，请前来查看。（原因未知时兜底） */
/* 跨房间定向播报：本板替**其他设备**播报同一条求助。
 * 刻意复用已上板验证的 sos 素材（"我需要帮助，请尽快过来。"），不新增语音资源：
 *   实测 kitchen 正式镜像 1,016,864 B / 分区 1,048,576 B，余量仅 31,712 B，
 *   一条 3 秒 ADPCM 就是 20~24 KB（会把余量压到 <5 KB，直接挤掉门磁并行工作的空间）。
 * 来源区分不靠文案，靠提示音次数（本板求助 3 声 / 外部求助 5 声，见 node_main.c announce_start）
 * 与 APP 上的原始来源/房间；本板不因此新建本地告警或新 alarmId。 */
#define VOICE_CLIP_REMOTE_SOS      7
/* 告警后语音提示：“检测到告警，请说我没事。”，提示播完再开麦。 */
#define VOICE_CLIP_SAFE_PROMPT     8
#define VOICE_CLIP_MAX             VOICE_CLIP_SAFE_PROMPT

void local_voice_start(void); /* call after I2C0 init, before sensor/network tasks */

/* 请求播放一个片段：非阻塞；最新请求覆盖尚未开始的旧请求（不会堆积播放队列）。 */
void local_voice_play(int clip);

/* 取消当前播放（stop / ACK / 异常解除 / 暂停监护）：立即静音并关闭功放。 */
void local_voice_cancel(void);

/* 片段对应的中文文案，仅用于串口日志与证据核对（不参与播放）。 */
const char *local_voice_text(int clip);/* AI 语音网关的流式播报（16kHz/mono/s16le）。begin 会抢占正在播放的告警片段；
 * 一旦本地告警/SOS 请求到达，write 立即返回 false，由调用方结束本次流。 */
bool local_voice_pcm_begin(void);
bool local_voice_pcm_write(const int16_t *mono, size_t samples);
void local_voice_pcm_end(void);

/* ---- 板载咪头采集（16 kHz / mono / s16le）----
 * 会话式 API：begin 会取消当前播放并独占 I2S/功放，read 读取 PCM，
 * end 恢复 ES8388 播放配置。一次只允许一个采集会话；失败返回 false/负值，
 * 调用方必须把原因写到串口，不得静默。
 * begin/end 之间不得调用 local_voice_play；播放请求会排队到 end 之后。 */
bool local_voice_mic_begin(void);
/* 返回实际读到的采样数；0=本次超时无数据；-1=会话未开始/驱动错误。 */
int  local_voice_mic_read(int16_t *buf, size_t samples, uint32_t timeout_ms);
void local_voice_mic_end(void);

/* mictest 自检：后台任务采集 seconds 秒，计算 RMS/峰值并打印
 * `MIC_TEST rms=... peak=...`，结束后自动恢复播放。同一时刻只允许一个。 */
void local_voice_mic_test(int seconds);

#endif
