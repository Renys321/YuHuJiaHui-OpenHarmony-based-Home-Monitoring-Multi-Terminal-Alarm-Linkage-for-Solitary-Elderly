#ifndef MIC_LINK_H
#define MIC_LINK_H
#include <stdbool.h>

/* 板载咪头 → PC 语音网关（9303）的一次性 PCM 上传。
 * 只在告警窗口或 `micupload` 命令触发时录音 3~5 秒，绝不常开麦克风。
 * 上传失败只影响本次录音，必须由串口日志说明原因。 */
void mic_link_start(void);

/* 非阻塞请求一次录音上传；同一时刻只排队一次（最新的原因覆盖旧的）。
 * 返回 false 表示任务未就绪或请求被拒绝（后续日志会说明原因）。 */
bool mic_link_trigger(const char *reason);

#endif
