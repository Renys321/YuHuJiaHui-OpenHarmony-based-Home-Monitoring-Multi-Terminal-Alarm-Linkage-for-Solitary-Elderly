#ifndef LOCAL_VOICE_H
#define LOCAL_VOICE_H
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* 板载 ES8388 音频接口：离线中文语音播报 + 板载咪头采集。
 *
 * 硬件通路（DNESP32S3 30_music BSP）：
 *   I2S TX：GPIO3 / GPIO9 / GPIO10 / GPIO46 -> ES8388 DAC -> 功放 -> 扬声器
 *   I2S RX：GPIO14 <- ES8388 ADC <- 板载咪头
 *   功放使能：XL9555 P0_2（与 board_io.c 共用同一颗扩展芯片）
 *
 * 播放和采集共用 BCLK/WS/MCLK，不能同时进行。切换方式：
 *   local_voice_mic_begin() 取消当前播放、独占 I2S 和功放锁；
 *   local_voice_mic_end()   卸载 RX 驱动、恢复 ES8388 播放配置。
 * 麦克风禁止常开，只在告警窗口、按键提问或自检命令时短暂打开。
 *
 * 语音片段以 IMA ADPCM 形式编译进固件（main/voice 目录下的 .adpcm 文件）。
 * 片段编号必须与 .adpcm 文件、local_voice.c 的 s_clips[] 完全一致；
 * 改编号会导致播错内容。短提示音结束后才播完整语音，由 announce_* 编排。 */

#define VOICE_CLIP_NONE            0   /* 无片段：内部占位，不要拿它去播放 */
#define VOICE_CLIP_SOS             1   /* 我需要帮助，请尽快过来。 */
#define VOICE_CLIP_CLIMATE_TEMP    2   /* 室内温度异常，请前来查看。 */
#define VOICE_CLIP_CLIMATE_RH      3   /* 室内湿度异常，请前来查看。 */
#define VOICE_CLIP_CLIMATE_BOTH    4   /* 室内温度和湿度异常，请前来查看。 */
#define VOICE_CLIP_NO_MOTION       5   /* 长时间未检测到活动，请确认家人情况。 */
#define VOICE_CLIP_CLIMATE_GENERIC 6   /* 室内温湿度异常，请前来查看。（原因未知时兜底） */

/* 跨房间定向播报：本板替其他设备播报同一条求助。
 * 刻意复用已经上板验证过的 sos 素材，不新增音频资源：
 * 当前 kitchen 镜像约 1.17 MB，app 分区 4 MB，余量充足，但少一份素材就少一份
 * 链接/flash 压力。来源区分不靠文案，而靠：
 *   - 提示音次数（本板求助 3 声 / 外部求助 5 声，见 announce_start）；
 *   - APP 上显示的原始来源。
 * 本板播报外部求助时不生成告警、不新建 alarmId、不改本地状态。 */
#define VOICE_CLIP_REMOTE_SOS      7

/* 告警后语音提示：“如果您没事，请说没事。”，提示播完再开麦录音。 */
#define VOICE_CLIP_SAFE_PROMPT     8

/* 健康建议片段：网关在采音连接上回 clip=9 时播放，绕开网络 PCM 返回。 */
#define VOICE_CLIP_HEALTH          9
#define VOICE_CLIP_MAX             VOICE_CLIP_HEALTH

/* 初始化 I2S、ES8388 和播放任务。
 * 必须在 board_i2c_start()（功放使能在 XL9555 上）之后、
 * 传感器/网络任务开始之前调用。
 * 初始化失败只打印日志，不阻止节点继续采集和上报。 */
void local_voice_start(void);

/* 请求播放一个片段（VOICE_CLIP_*）。
 * 非阻塞：只投递请求，最新请求会覆盖还没开始的旧请求，不堆播放队列。
 * 播放过程中收到新请求，会在当前片段结束后播最新的一个。
 * 传入非法编号时内部会忽略并打日志。 */
void local_voice_play(int clip);

/* 取消当前播放：立刻静音、关闭功放、清空待播请求。
 * 用于用户按键停止、ACK、异常解除、暂停监护等场景。
 * 可以重复调用，没有副作用。 */
void local_voice_cancel(void);

/* 返回片段对应的中文文案，仅用于串口日志和证据核对，不参与播放。
 * 编号非法时返回 "?" 之类的占位串，不会返回 NULL。 */
const char *local_voice_text(int clip);

/* ---- 网络 PCM 流式播报（16kHz / 单声道 / s16le） ----
 * 用于 speaker_link 把网关下发的 PCM 直接写进 I2S。
 * begin 会抢占正在播放的本地告警片段；一旦本地告警/SOS 请求到达，
 * write 立刻返回 false，调用方应结束本次流，保证告警声音优先。
 * 三个函数必须成对调用：begin -> write* -> end。 */

/* 开始一次流式播放，成功后返回 true。重复 begin 会失败。 */
bool local_voice_pcm_begin(void);

/* 写入一段单声道 PCM。samples 是采样点个数（不是字节数）。
 * 返回 false 表示被本地告警抢占或 I2S 写失败，调用方应停止本次流。 */
bool local_voice_pcm_write(const int16_t *mono, size_t samples);

/* 结束流式播放并恢复空闲状态。未 begin 时调用也安全。 */
void local_voice_pcm_end(void);

/* ---- 板载咪头采集（16 kHz / 单声道 / s16le） ----
 * 会话式 API：一次只允许一个采集会话。
 *   begin：取消当前播放、独占 I2S 和功放，切换 ES8388 到 ADC 通路；
 *   read ：读 PCM，超时返回 0，出错返回 -1；
 *   end  ：恢复 ES8388 播放配置，释放 I2S。
 * begin/end 之间不要调用 local_voice_play，播放请求会排到 end 之后。
 * 采集失败必须由调用方写串口日志说明原因，不许静默。 */

/* 开始采集会话。返回 false 表示已有会话、I2S 切换失败或硬件不可用。 */
bool local_voice_mic_begin(void);

/* 读取最多 samples 个采样点，最多等待 timeout_ms 毫秒。
 * 返回实际读到的采样数；0=本次超时无数据；-1=会话未开始或驱动错误。 */
int  local_voice_mic_read(int16_t *buf, size_t samples, uint32_t timeout_ms);

/* 结束采集会话并恢复播放通路。未 begin 时调用也安全。 */
void local_voice_mic_end(void);

/* mictest 自检：后台任务采 seconds 秒，计算 RMS/峰值并打印
 * `MIC_TEST rms=... peak=...`，结束后自动恢复播放。
 * 同一时刻只允许一个自检；重复请求会被忽略。 */
void local_voice_mic_test(int seconds);

#endif
