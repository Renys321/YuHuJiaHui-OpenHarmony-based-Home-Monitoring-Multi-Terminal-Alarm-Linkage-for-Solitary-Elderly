/* adpcm_ima.h —— IMA ADPCM (DVI4) 4 bit 解码器（纯逻辑，主机侧可测）
 *
 * 为什么语音用 ADPCM：
 *   16 kHz / 16 bit 原始 PCM 是 32 kB/s，8 条中文语音会占用大量 flash；
 *   IMA ADPCM 4 bit @16 kHz 只有 8 kB/s，体积约为 PCM 的四分之一，
 *   同时保留 8 kHz 音频带宽（比直接降到 8 kHz PCM 清晰得多）。
 *   当前 app 分区 4 MiB、镜像约 1.17 MB，空间并不紧张；继续用 ADPCM
 *   是为了少占 flash、缩短素材加载时间，也避免以后调小分区时返工。
 *
 * 文件格式（与 voice/ 目录下的 .adpcm 完全一致）：
 *   byte0..1 : int16 小端，初始预测值 pred（第一个采样点）
 *   byte2    : uint8 初始步长索引 index（0..88）
 *   byte3    : 保留，必须为 0（当前解码器不读它）
 *   byte4..  : 4 bit nibble 流，每个字节先解高 4 位，再解低 4 位
 *
 * 与 tools/make-voice-assets.py 的 ima_decode() 逐行一致；
 * 主机测试 tools/host_adpcm_test.c 用 Python 参考解码结果做逐采样比对。
 * Python 标准库 audioop.adpcm2lin 解出的采样也与本实现完全相同。
 *
 * 解码公式（每个 nibble）：
 *   step = step_table[index]
 *   diff = step/8 + (bit2 ? step : 0) + (bit1 ? step/2 : 0) + (bit0 ? step/4 : 0)
 *   pred = pred ± diff        （bit3=1 表示减，0 表示加）
 *   pred 钳位到 int16 范围
 *   index += index_adj[code & 7]，再钳位到 0..88 */
#ifndef ADPCM_IMA_H
#define ADPCM_IMA_H

#include <stdint.h>
#include <stddef.h>

/* 89 级步长表，来自 IMA ADPCM 标准。
 * index 越大步长越大，编码器据此自适应信号幅度；
 * 解码时必须和编码器使用同一张表，否则声音会失真。 */
static const int16_t adpcm_ima_step_table[89] = {
    7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
    50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230,
    253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963,
    1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327,
    3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442,
    11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794,
    32767,
};

/* 每个 nibble 对 index 的调整量。
 * 下标只取 code 的低 3 位（0..7）：码值小说明信号变化小，步长调小；
 * 码值大说明变化大，步长调大，从而跟踪波形。 */
static const int8_t adpcm_ima_index_adj[8] = { -1, -1, -1, -1, 2, 4, 6, 8 };

/* 解码器状态。一次解码会话对应一个 .adpcm 片段。 */
typedef struct {
    int32_t pred;          /* 当前预测值（采样值）；解码过程中不断更新 */
    int index;             /* 当前步长表下标 0..88 */
    const uint8_t *p;      /* 下一个待读字节 */
    const uint8_t *end;    /* 片段末尾（不含），p >= end 表示解码结束 */
    int high;              /* 1 = 下一个 nibble 取当前字节高 4 位（此时 p 指向该字节） */
} adpcm_ima_state_t;

/* 解出一个 16 bit 采样，写入 *out。
 * 返回 1=成功，0=数据已读完（此时 *out 不被修改）。
 *
 * nibble 读取顺序：
 *   - high=1：取当前字节高 4 位，置 high=0，p 不动；
 *   - high=0：取当前字节低 4 位，置 high=1，p 前进一字节。
 * 因此每字节解出两个采样，先高后低。
 *
 * 解码后 pred 钳位在 int16 范围，index 钳位在 0..88，
 * 防止损坏的文件把状态推出表外导致越界访问。 */
static inline int adpcm_ima_next(adpcm_ima_state_t *s, int16_t *out)
{
    int code, step, diff;

    /* 高半字节需要一个新的字节；低半字节仍在当前字节里（此时 p 尚未前移）。 */
    if (s->high && s->p >= s->end) return 0;
    if (s->high) {
        code = (*s->p >> 4) & 0x0F;
        s->high = 0;              /* 同一字节还有低 4 位，p 不前移 */
    } else {
        code = (*s->p) & 0x0F;
        s->high = 1;
        s->p++;                   /* 两个 nibble 都取完，才前进到下一字节 */
    }
    step = adpcm_ima_step_table[s->index];
    diff = step >> 3;             /* 基础增量 step/8 */
    if (code & 4) diff += step;         /* bit2 权重 1 */
    if (code & 2) diff += step >> 1;    /* bit1 权重 1/2 */
    if (code & 1) diff += step >> 2;    /* bit0 权重 1/4 */
    s->pred += (code & 8) ? -diff : diff;   /* bit3 是符号位 */
    if (s->pred > 32767) s->pred = 32767;   /* 钳位，防溢出 */
    else if (s->pred < -32768) s->pred = -32768;
    s->index += adpcm_ima_index_adj[code & 7];
    if (s->index < 0) s->index = 0;
    else if (s->index > 88) s->index = 88;
    *out = (int16_t)s->pred;
    return 1;
}

/* 用片段头初始化解码状态。
 * 参数：
 *   s    - 输出状态
 *   data - 片段起始（含 4 字节头）
 *   end  - 片段末尾（不含）
 * 返回：
 *   1 = 头有效，可以开始 adpcm_ima_next()
 *   0 = 参数为空、片段太短（少于 5 字节）或头非法
 *
 * 头解析：
 *   pred  = data[0] | data[1]<<8（小端 int16）
 *   index = data[2] & 0x7F，再钳位到 88
 *   p     = data + 4（跳过 4 字节头）
 *   high  = 1（第一个采样在高半字节）
 * 注意：数据区至少要有 1 字节，否则 begin 成功但 next 立即返回 0。 */
static inline int adpcm_ima_begin(adpcm_ima_state_t *s, const uint8_t *data, const uint8_t *end)
{
    if (!s || !data || !end || end < data + 5) return 0;
    s->pred = (int16_t)((uint16_t)data[0] | ((uint16_t)data[1] << 8));
    s->index = (int)(data[2] & 0x7F);
    if (s->index > 88) s->index = 88;
    s->p = data + 4;
    s->end = end;
    s->high = 1;
    return 1;
}

#endif /* ADPCM_IMA_H */
