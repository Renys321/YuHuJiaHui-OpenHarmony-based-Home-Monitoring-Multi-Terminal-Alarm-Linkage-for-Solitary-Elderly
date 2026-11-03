#ifndef MIC_LINK_H
#define MIC_LINK_H
#include <stdbool.h>

/* 板载咪头 -> PC 语音网关（默认端口 9303）的一次性 PCM 上传。
 *
 * 触发场景只有两种：
 *   1. 告警窗口：本地播完提示后，录几秒环境音/求助语音；
 *   2. 串口/网关命令 mictest、micupload，或 KEY1 语音提问。
 * 不做常开麦克风，每次录音结束就关闭 ES8388 ADC。
 *
 * 协议（全部是单行 JSON + '\n'）：
 *   节点 -> hello{role:"mic", node, room, alarmId, reason}
 *   节点 -> audio_start{rate:16000, channels:1, codec:"pcm_s16le"}
 *   节点 -> 原始 PCM 数据（边录边发，每块 20ms）
 *   节点 -> audio_end{}
 *   网关 -> 可选响应；其中 clip=9 表示“这是健康问题，本板直接播健康建议”，
 *           不再依赖网络 PCM 返回。本板收到后播放 VOICE_CLIP_HEALTH。
 *
 * 上传失败只影响本次录音，必须在串口日志里给出 MIC_UPLOAD FAIL 原因；
 * 不改变告警状态，也不阻塞主循环。 */
void mic_link_start(void);

/* 非阻塞请求一次录音上传。
 * reason 会原样写进 hello 的 reason 字段（最长 47 字符），用于日志区分
 * 是告警、按键提问还是自检命令；传 NULL 或空串时用 "cmd"。
 * 返回：
 *   true  = 请求已投递（队列是单槽覆盖，来不及处理时最新的会覆盖旧的）
 *   false = 录音任务未就绪（创建失败或语音功能关闭）
 * 同一时刻最多排一次录音，不会因告警密集而堆积多次上传。 */
bool mic_link_trigger(const char *reason);

#endif
