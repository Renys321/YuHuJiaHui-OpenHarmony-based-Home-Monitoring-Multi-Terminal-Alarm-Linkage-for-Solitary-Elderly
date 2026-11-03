#ifndef SPEAKER_LINK_H
#define SPEAKER_LINK_H
/* AI 语音网关“网络音箱”链路：节点作为 TCP 客户端连到 PC 的语音网关，
 * 接收 16kHz/mono/s16le PCM 并用 ES8388 扬声器播放。
 * 与 9101 传感上报链路完全分离，任何失败只影响播报，不影响告警上报。 */
void speaker_link_start(void);
#endif
