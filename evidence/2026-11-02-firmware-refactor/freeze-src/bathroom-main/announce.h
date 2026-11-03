#ifndef ANNOUNCE_H
#define ANNOUNCE_H

/* 告警声音编排接口。
 *
 * 一次告警声音分两段，严格先后：
 *   1. 蜂鸣器短提示音（“嘀—嘀—”若干声，次数由 Kconfig 和告警类型决定）；
 *   2. 蜂鸣器完全停下后，再播中文语音片段（local_voice）。
 * 这样人声不会被蜂鸣器盖住，也不会出现两种声音同时响。
 *
 * 所有函数都是非阻塞的：announce_start() 只设置状态，真正的电平翻转和起播
 * 由主循环里的 announce_tick() 完成，因此不会拖慢采样和上报。 */

/* 开始一轮告警声音。
 * clip 是语音片段编号（VOICE_CLIP_*）：
 *   - SOS / REMOTE_SOS：使用 SOS 录音，提示音次数更多；
 *   - 其他（温度、湿度、无活动、通用）：按普通次数提示。
 * 内部会先取消上一轮声音，避免叠加。 */
void announce_start(int clip);

/* 立即停止本轮声音：关蜂鸣器、清空待播语音，并取消正在播放的本地语音。
 * 用于用户按键停止、告警解除或进入新状态。 */
void announce_cancel(void);

/* 声音状态机推进，主循环每 100ms 调一次。
 * 根据当前时间翻转蜂鸣器、递减剩余声数；蜂鸣结束后到点调用
 * local_voice_play() 起播语音。不在这里做阻塞延时。 */
void announce_tick(void);

#endif /* ANNOUNCE_H */
