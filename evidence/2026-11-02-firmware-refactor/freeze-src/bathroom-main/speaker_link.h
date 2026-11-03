#ifndef SPEAKER_LINK_H
#define SPEAKER_LINK_H
/* “网络音箱”链路：节点作为 TCP 客户端连到 PC 语音网关（默认端口 9102）。
 *
 * 用途：APP/云端需要让某块板子说话时，网关把指令或 PCM 推给这块板：
 *   - {"clip":N}：播放固件内置的本地语音片段（不传音频数据）；
 *   - {"pcm":...,"bytes":N,"rate":16000}：随后跟 N 字节
 *     16kHz / 单声道 / 16bit 小端 PCM，用 ES8388 扬声器播放。
 * 播放完回一条 {"type":"done","node":...,"ok":0/1}。
 *
 * 与 9101 传感上报链路完全独立：这里连不上、播放失败，只影响播报，
 * 不影响告警状态和状态上报。任务内部自带重连，断线 3 秒后重试。
 * 只有 CONFIG_NODE_VOICE_ENABLED=y 时才真正创建任务。 */

/* 启动 speaker-net 任务（栈 6144 字节，优先级 3）。
 * 任务会循环：连接网关 -> 发 hello（带 node/room）-> 逐行收指令/PCM ->
 * 断线后延时重连。重复调用不会创建第二个任务。 */
void speaker_link_start(void);
#endif
