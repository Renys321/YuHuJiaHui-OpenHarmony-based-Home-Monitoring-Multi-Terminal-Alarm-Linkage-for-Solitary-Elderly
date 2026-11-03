#ifndef LOCAL_VOICE_H
#define LOCAL_VOICE_H
/* 板载 ES8388 扬声器：离线中文语音播报（仅播放，无麦克风/URL/网络）。
 *
 * 2026-10-26 LOCAL-ALARM-SPEECH-FINAL：把原来的两条 PCM 换成 6 条与“真实触发原因”
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
#define VOICE_CLIP_MAX             VOICE_CLIP_CLIMATE_GENERIC

void local_voice_start(void); /* call after I2C0 init, before sensor/network tasks */

/* 请求播放一个片段：非阻塞；最新请求覆盖尚未开始的旧请求（不会堆积播放队列）。 */
void local_voice_play(int clip);

/* 取消当前播放（stop / ACK / 异常解除 / 暂停监护）：立即静音并关闭功放。 */
void local_voice_cancel(void);

/* 片段对应的中文文案，仅用于串口日志与证据核对（不参与播放）。 */
const char *local_voice_text(int clip);

#endif
