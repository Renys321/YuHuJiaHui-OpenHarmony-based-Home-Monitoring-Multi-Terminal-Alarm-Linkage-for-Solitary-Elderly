/* adpcm_ima.h —— IMA ADPCM (DVI4) 4 bit 解码器（纯逻辑，主机侧可测）
 *
 *  LOCAL-ALARM-SPEECH-FINAL。
 * 为什么需要它：factory 应用分区只有 1 MiB，旧正式固件已占 948,960 B（仅剩 99,616 B）。
 * 5 条完整中文句子用 16 kHz/16 bit（32 kB/s）需要约 176 kB，放不下；改用标准 IMA ADPCM
 * 4 bit @16 kHz（8 kB/s）可保留完整 8 kHz 语音带宽（比降到 8 kHz PCM 清晰得多）并留出余量。
 *
 * 文件格式（与 evidence 目录 audio/final 下的 .adpcm 完全一致）：
 *   byte0..1 : int16 LE 初始预测值 pred
 *   byte2    : uint8 初始步长索引 index (0..88)
 *   byte3    : 保留 0
 *   byte4..  : 4 bit nibble 流，先高 4 位（第一个采样在高半字节）
 *
 * 该实现与 tools/make-voice-assets.py 的 ima_decode() 逐行一致；主机测试
 * tools/host_adpcm_test.c 用 Python 参考解码结果做逐采样比对。
 * 另外已验证：编码结果用 Python 标准库 audioop.adpcm2lin 解出的采样与该实现完全相同。
 */
#ifndef ADPCM_IMA_H
#define ADPCM_IMA_H

#include <stdint.h>
#include <stddef.h>

static const int16_t adpcm_ima_step_table[89] = {
    7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
    50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230,
    253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963,
    1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327,
    3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442,
    11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794,
    32767,
};

static const int8_t adpcm_ima_index_adj[8] = { -1, -1, -1, -1, 2, 4, 6, 8 };

typedef struct {
    int32_t pred;
    int index;
    const uint8_t *p;
    const uint8_t *end;
    int high;      /* 1 = 下一个 nibble 取当前字节高 4 位（此时 p 指向该字节） */
} adpcm_ima_state_t;

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
    diff = step >> 3;
    if (code & 4) diff += step;
    if (code & 2) diff += step >> 1;
    if (code & 1) diff += step >> 2;
    s->pred += (code & 8) ? -diff : diff;
    if (s->pred > 32767) s->pred = 32767;
    else if (s->pred < -32768) s->pred = -32768;
    s->index += adpcm_ima_index_adj[code & 7];
    if (s->index < 0) s->index = 0;
    else if (s->index > 88) s->index = 88;
    *out = (int16_t)s->pred;
    return 1;
}

/* 用片段头初始化解码状态；返回 1 = 头有效。data/end 为整个片段（含 4 字节头）。 */
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
