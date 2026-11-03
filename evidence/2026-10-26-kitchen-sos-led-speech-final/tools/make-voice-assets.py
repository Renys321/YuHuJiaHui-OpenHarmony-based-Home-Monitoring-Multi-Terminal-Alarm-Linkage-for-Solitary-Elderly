#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
LOCAL-ALARM-SPEECH-FINAL / 2026-10-26
Build the five clear Chinese alarm clips for the kitchen / bathroom ESP32-S3 nodes.

Input : audio/tts-raw/<key>.r-1.wav   (SAPI "Microsoft Huihui Desktop", Rate=-1, 22050 Hz mono 16-bit)
Output: audio/final/<key>.adpcm       (IMA ADPCM 4-bit, 16 kHz mono + 4-byte header)
        audio/preview/<key>.wav       (decoded back to 16 kHz 16-bit, exactly what the board plays)
        audio/preview/seq-<type>.wav  (short buzzer pattern + full speech, for PC masking check)
        audio/MANIFEST.json           (bytes / duration / SHA-256 / peak / RMS / SNR)

WHY ADPCM: the factory app partition is 1 MiB and the previous production image was already
948,960 B (99,616 B free). Five full sentences at 16 kHz 16-bit need ~176 KB, which does not fit.
IMA ADPCM 4-bit at 16 kHz keeps the full 8 kHz speech bandwidth (far better than dropping to
8 kHz PCM) at 8,000 B/s and fits with margin. No partition-table change was made.

The decoder in esp32-node/main/local_voice.c is a direct port of `ima_decode()` below; the host
test tools/host_adpcm_test.c proves byte-exact equality against this reference.
"""
import json
import hashlib
import os
import subprocess
import sys
import wave

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)                      # .../2026-10-26-kitchen-sos-led-speech-final
RAW = os.path.join(ROOT, 'audio', 'tts-raw')
FINAL = os.path.join(ROOT, 'audio', 'final')
PREVIEW = os.path.join(ROOT, 'audio', 'preview')
FFMPEG = r'C:\Users\<user>\.dsh-wallpaper-engine\ffmpeg\ffmpeg.exe'

TARGET_SR = 16000
LEAD_SIL_MS = 200      # covers XL9555 amp-enable + DMA priming so the first phoneme is never cut
TAIL_SIL_MS = 150      # keeps the amp on until the last syllable has fully decayed
PEAK_TARGET = 0.95     # -0.45 dBFS; ES8388 LOUT2/ROUT2 volume (kitchen 20 / bath 30) unchanged

CLIPS = [
    ('sos',             'MANUAL_SOS',  '我需要帮助，请尽快过来。'),
    ('climate_temp',    'CLIMATE_TEMP', '室内温度异常，请前来查看。'),
    ('climate_rh',      'CLIMATE_RH',   '室内湿度异常，请前来查看。'),
    ('climate_both',    'CLIMATE_BOTH', '室内温度和湿度异常，请前来查看。'),
    ('no_motion',       'NO_MOTION',    '长时间未检测到活动，请确认家人情况。'),
    ('climate_generic', 'CLIMATE_GENERIC', '室内温湿度异常，请前来查看。'),
]

# ---------------------------------------------------------------- IMA ADPCM (standard DVI4)
STEP_TABLE = [
    7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
    50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230,
    253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963,
    1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327,
    3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442,
    11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794,
    32767,
]
INDEX_TABLE = [-1, -1, -1, -1, 2, 4, 6, 8]


def ima_encode(samples):
    """samples: int16 numpy array -> (nibble list, init_pred, init_index)."""
    pred = int(samples[0])
    index = 0
    nibbles = []
    for s in samples:
        step = STEP_TABLE[index]
        diff = int(s) - pred
        code = 0
        if diff < 0:
            code = 8
            diff = -diff
        if diff >= step:
            code |= 4
            diff -= step
        if diff >= (step >> 1):
            code |= 2
            diff -= (step >> 1)
        if diff >= (step >> 2):
            code |= 1
        nibbles.append(code)
        # reconstruct exactly like the decoder (the decoder only ever sees the code)
        step = STEP_TABLE[index]
        diffq = (step >> 3)
        if code & 4:
            diffq += step
        if code & 2:
            diffq += step >> 1
        if code & 1:
            diffq += step >> 2
        if code & 8:
            pred -= diffq
        else:
            pred += diffq
        pred = max(-32768, min(32767, pred))
        index += INDEX_TABLE[code & 7]
        index = max(0, min(88, index))
    return nibbles, int(samples[0]), 0


def ima_decode(nibbles, init_pred, init_index):
    """Reference decoder: identical logic to the C implementation in local_voice.c."""
    pred = int(init_pred)
    index = int(init_index)
    out = np.empty(len(nibbles), dtype=np.float64)
    for i, code in enumerate(nibbles):
        step = STEP_TABLE[index]
        diffq = (step >> 3)
        if code & 4:
            diffq += step
        if code & 2:
            diffq += step >> 1
        if code & 1:
            diffq += step >> 2
        if code & 8:
            pred -= diffq
        else:
            pred += diffq
        pred = max(-32768, min(32767, pred))
        index += INDEX_TABLE[code & 7]
        index = max(0, min(88, index))
        out[i] = pred
    return out


def pack_nibbles(nibbles):
    """High nibble = first sample (documented in local_voice.c)."""
    b = bytearray()
    for i in range(0, len(nibbles) - 1, 2):
        b.append(((nibbles[i] & 0xF) << 4) | (nibbles[i + 1] & 0xF))
    if len(nibbles) % 2:
        b.append((nibbles[-1] & 0xF) << 4)
    return bytes(b)


def unpack_nibbles(data):
    out = []
    for byte in data:
        out.append((byte >> 4) & 0xF)
        out.append(byte & 0xF)
    return out


def read_wav(path):
    with wave.open(path, 'rb') as w:
        sr, ch, sw, n = w.getframerate(), w.getnchannels(), w.getsampwidth(), w.getnframes()
        raw = w.readframes(n)
    assert sw == 2, 'expect 16-bit wav'
    a = np.frombuffer(raw, dtype='<i2').astype(np.int32)
    if ch > 1:
        a = a.reshape(-1, ch)[:, 0]
    return sr, a.astype(np.float64)


def write_wav(path, samples_int16, sr=TARGET_SR):
    with wave.open(path, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(np.asarray(samples_int16, dtype='<i2').tobytes())


def ffmpeg_resample(src, dst, sr):
    cmd = [FFMPEG, '-hide_banner', '-loglevel', 'error', '-y', '-i', src,
           '-ac', '1', '-ar', str(sr), '-c:a', 'pcm_s16le', dst]
    subprocess.run(cmd, check=True)


def trim(x, sr):
    """Drop leading/trailing near-silence but keep natural attack/decay."""
    peak = float(np.max(np.abs(x))) or 1.0
    thr = max(peak * 0.02, 60.0)
    idx = np.where(np.abs(x) > thr)[0]
    if len(idx) == 0:
        return x
    pad = int(sr * 0.02)
    a = max(0, int(idx[0]) - pad)
    b = min(len(x), int(idx[-1]) + pad)
    return x[a:b]


def build_beep_sequence(samples, beeps, on_ms=200, gap_ms=100, pre_gap_ms=150):
    """Buzzer pattern (1 kHz square, 0.35 FS) followed by the speech: used only for the
    PC side 'does the beep mask the words' check. The real buzzer is XL9555 P0_3."""
    sr = TARGET_SR
    parts = []
    for i in range(beeps):
        n = int(sr * on_ms / 1000)
        t = np.arange(n) / sr
        parts.append(0.35 * 32767 * np.sign(np.sin(2 * np.pi * 1000 * t)))
        if i != beeps - 1:
            parts.append(np.zeros(int(sr * gap_ms / 1000)))
    parts.append(np.zeros(int(sr * pre_gap_ms / 1000)))
    parts.append(samples.astype(np.float64))
    return np.concatenate(parts)


def main():
    for d in (FINAL, PREVIEW):
        os.makedirs(d, exist_ok=True)
    manifest = {'note': 'IMA ADPCM 4-bit @16 kHz mono, 4-byte header = int16 init_pred + uint8 init_index + uint8 rsv',
                'targetSampleRate': TARGET_SR, 'peakTargetFs': PEAK_TARGET,
                'leadSilenceMs': LEAD_SIL_MS, 'tailSilenceMs': TAIL_SIL_MS,
                'ttsVoice': 'Microsoft Huihui Desktop (SAPI), Rate=-1', 'clips': {}}
    tmpdir = os.path.join(ROOT, 'audio', '_tmp')
    os.makedirs(tmpdir, exist_ok=True)

    for key, clip_id, text in CLIPS:
        raw_path = os.path.join(RAW, key + '.r-1.wav')
        if not os.path.isfile(raw_path):
            sys.exit('missing TTS input: ' + raw_path)
        rs_path = os.path.join(tmpdir, key + '.16k.wav')
        ffmpeg_resample(raw_path, rs_path, TARGET_SR)
        sr, x = read_wav(rs_path)
        assert sr == TARGET_SR
        x = trim(x, sr)
        peak = float(np.max(np.abs(x)))
        x = x * (PEAK_TARGET * 32767.0 / peak)
        lead = np.zeros(int(sr * LEAD_SIL_MS / 1000))
        tail = np.zeros(int(sr * TAIL_SIL_MS / 1000))
        x = np.concatenate([lead, x, tail])
        x = np.clip(np.round(x), -32768, 32767).astype(np.int16)

        nibbles, init_pred, init_index = ima_encode(x)
        payload = pack_nibbles(nibbles)
        header = bytes([init_pred & 0xFF, (init_pred >> 8) & 0xFF, init_index & 0xFF, 0])
        adpcm = header + payload
        out_path = os.path.join(FINAL, key + '.adpcm')
        with open(out_path, 'wb') as f:
            f.write(adpcm)

        dec = ima_decode(unpack_nibbles(payload)[:len(nibbles)], init_pred, init_index)
        dec_i16 = np.clip(np.round(dec), -32768, 32767).astype(np.int16)
        noise = dec_i16.astype(np.float64) - x.astype(np.float64)
        snr = 10 * np.log10(np.sum(x.astype(np.float64) ** 2) / max(np.sum(noise ** 2), 1e-9))
        write_wav(os.path.join(PREVIEW, key + '.wav'), dec_i16)

        # Preview of the real announcement: short buzzer pattern, then the words.
        beeps = 3 if clip_id == 'MANUAL_SOS' else 2
        seq = build_beep_sequence(dec_i16.astype(np.float64), beeps)
        write_wav(os.path.join(PREVIEW, 'seq-' + key + '.wav'),
                  np.clip(np.round(seq), -32768, 32767).astype(np.int16))

        rms = float(np.sqrt(np.mean(dec_i16.astype(np.float64) ** 2)))
        entry = {
            'clipId': CLIPS.index((key, clip_id, text)) + 1,
            'trigger': clip_id,
            'text': text,
            'pcm16kSamples': int(len(x)),
            'durationSec': round(len(x) / TARGET_SR, 3),
            'speechSecWithoutPadding': round((len(x) - len(lead) - len(tail)) / TARGET_SR, 3),
            'adpcmBytes': len(adpcm),
            'adpcmSha256': hashlib.sha256(adpcm).hexdigest().upper(),
            'pcm16kSha256': hashlib.sha256(x.tobytes()).hexdigest().upper(),
            'snrDb': round(float(snr), 2),
            'peakFs': round(float(np.max(np.abs(dec_i16))) / 32768.0, 4),
            'rmsDbfs': round(20 * np.log10(max(rms, 1.0) / 32768.0), 2),
            'beepsInPreview': beeps,
        }
        manifest['clips'][key] = entry
        print('{key:<16} {text}\n  dur={d:.2f}s speech={s:.2f}s adpcm={b}B snr={snr:.1f}dB peak={p:.2f}FS rms={r:.1f}dBFS sha={sha}'.format(
            key=key, text=text, d=entry['durationSec'], s=entry['speechSecWithoutPadding'],
            b=entry['adpcmBytes'], snr=entry['snrDb'], p=entry['peakFs'], r=entry['rmsDbfs'],
            sha=entry['adpcmSha256'][:16]))

    total = sum(c['adpcmBytes'] for c in manifest['clips'].values())
    manifest['totalAdpcmBytes'] = total
    manifest['totalDurationSec'] = round(sum(c['durationSec'] for c in manifest['clips'].values()), 3)
    with open(os.path.join(ROOT, 'audio', 'MANIFEST.json'), 'w', encoding='utf-8') as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    print('\nTOTAL adpcm={} B ({:.1f} KB) duration={:.2f}s'.format(total, total / 1024.0, manifest['totalDurationSec']))

    # Independent cross-check of the decoder against audioop (stdlib IMA reference) when available.
    try:
        import audioop  # noqa
        ok = 0
        for key, _, _ in CLIPS:
            with open(os.path.join(FINAL, key + '.adpcm'), 'rb') as f:
                blob = f.read()
            pred = int.from_bytes(blob[0:2], 'little', signed=True)
            idx = blob[2]
            ref, _ = audioop.adpcm2lin(blob[4:], 2, (pred, idx))
            ref_i16 = np.frombuffer(ref, dtype='<i2')
            mine = np.clip(np.round(ima_decode(unpack_nibbles(blob[4:])[:len(ref_i16)], pred, idx)), -32768, 32767).astype(np.int16)
            n = min(len(ref_i16), len(mine))
            same = np.array_equal(ref_i16[:n], mine[:n])
            print('audioop cross-check {:<16} identical={} n={}'.format(key, same, n))
            ok += 1 if same else 0
        manifest['audioopCrossCheck'] = '{}/{} identical'.format(ok, len(CLIPS))
    except ImportError:
        print('audioop not available; cross-check skipped')
        manifest['audioopCrossCheck'] = 'unavailable'
    with open(os.path.join(ROOT, 'audio', 'MANIFEST.json'), 'w', encoding='utf-8') as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)


if __name__ == '__main__':
    main()
