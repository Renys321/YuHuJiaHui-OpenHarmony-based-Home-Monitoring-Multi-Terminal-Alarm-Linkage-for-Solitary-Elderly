/* host_adpcm_test.c —— ESP32 播放用的 IMA ADPCM 解码器主机侧逐采样验证
 *
 * 编译（Windows / MSYS2 gcc）：
 *   gcc -O2 -Wall -Wextra -I ..\main host_adpcm_test.c -o host_adpcm_test.exe
 * 运行：
 *   host_adpcm_test.exe <clip.adpcm> <clip.refpcm>
 *
 * refpcm 由 Python 标准库 audioop.adpcm2lin（独立参考实现）解出。
 * 要求：固件解码器 main/adpcm_ima.h 的输出与参考 PCM 逐字节相同。
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "adpcm_ima.h"

static unsigned char *read_file(const char *path, long *size)
{
    FILE *f = fopen(path, "rb");
    unsigned char *buf;
    long n;
    if (!f) { printf("cannot open %s\n", path); return NULL; }
    if (fseek(f, 0, SEEK_END) != 0) { fclose(f); return NULL; }
    n = ftell(f);
    if (n <= 0) { fclose(f); return NULL; }
    rewind(f);
    buf = (unsigned char *)malloc((size_t)n);
    if (!buf) { fclose(f); return NULL; }
    if (fread(buf, 1, (size_t)n, f) != (size_t)n) { free(buf); fclose(f); return NULL; }
    fclose(f);
    *size = n;
    return buf;
}

int main(int argc, char **argv)
{
    long adpcm_len = 0, ref_len = 0;
    unsigned char *adpcm, *ref;
    adpcm_ima_state_t st;
    long i, samples, bad = 0;
    int16_t s = 0;
    FILE *dump = NULL;

    if (argc != 3 && argc != 4) { printf("usage: %s <clip.adpcm> <clip.refpcm> [dump.pcm]\n", argv[0]); return 2; }
    adpcm = read_file(argv[1], &adpcm_len);
    ref = read_file(argv[2], &ref_len);
    if (!adpcm || !ref) return 2;
    if (argc == 4) dump = fopen(argv[3], "wb");
    if (ref_len % 2 != 0) { printf("FAIL: reference PCM has odd size %ld\n", ref_len); return 1; }
    samples = ref_len / 2;
    if (!adpcm_ima_begin(&st, adpcm, adpcm + adpcm_len)) { printf("FAIL: bad clip header\n"); return 1; }

    for (i = 0; i < samples; i++) {
        int16_t want = (int16_t)((uint16_t)ref[2 * i] | ((uint16_t)ref[2 * i + 1] << 8));
        if (!adpcm_ima_next(&st, &s)) { printf("FAIL: decoder ended early at sample %ld\n", i); if (dump) fclose(dump); free(adpcm); free(ref); return 1; }
        if (dump) fwrite(&s, 2, 1, dump);
        if (s != want) { bad++; if (bad <= 3) printf("MISMATCH sample %ld fw=%d ref=%d\n", i, (int)s, (int)want); }
    }
    if (dump) fclose(dump);
    /* 片段末尾不足一个字节的半个 nibble 会多出 1 个采样，不比较；但多出超过 1 个即为格式错误。 */
    {
        int extra = 0;
        while (adpcm_ima_next(&st, &s)) extra++;
        if (extra > 1) { printf("FAIL: clip has %d unexpected trailing samples\n", extra); bad++; }
    }
    printf("%s: samples=%ld mismatches=%ld -> %s\n", argv[1], samples, bad, bad ? "FAIL" : "PASS");
    free(adpcm);
    free(ref);
    return bad ? 1 : 0;
}
