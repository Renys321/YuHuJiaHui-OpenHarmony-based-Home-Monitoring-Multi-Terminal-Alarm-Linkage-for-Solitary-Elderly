#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""WIRELESS-SOS-NOTICE: encode ONE extra Chinese clip for the cross-room SOS notice.

Reuses the already-proven pipeline in
  evidence/2026-10-26-kitchen-sos-led-speech-final/tools/make-voice-assets.py
(ffmpeg 16 kHz mono resample -> peak normalise -> 200/150 ms pad -> IMA ADPCM 4-bit),
so the new clip is byte-format identical to the six clips already on the boards.

Outputs (never overwrites the original evidence directory):
  <out-dir>/final/<key>.adpcm
  <out-dir>/preview/<key>.wav
  <out-dir>/preview/seq-<key>.wav   (short buzzer pattern + speech, for masking check)
  <out-dir>/MANIFEST.json
"""
import argparse
import hashlib
import importlib.util
import json
import os
import sys

REF_SCRIPT = (r'D:\OpenHarmony\competition\evidence'
              r'\2026-10-26-kitchen-sos-led-speech-final\tools\make-voice-assets.py')


def load_reference():
    spec = importlib.util.spec_from_file_location('mva', REF_SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)          # __name__ != '__main__' -> main() not executed
    return mod


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--raw', required=True, help='TTS wav (any rate/channels, 16-bit)')
    ap.add_argument('--key', required=True, help='asset key, e.g. remote_sos')
    ap.add_argument('--text', required=True, help='spoken text, for the manifest/log only')
    ap.add_argument('--out-dir', required=True)
    args = ap.parse_args()

    mva = load_reference()
    np = mva.np

    final_dir = os.path.join(args.out_dir, 'final')
    preview_dir = os.path.join(args.out_dir, 'preview')
    tmp_dir = os.path.join(args.out_dir, '_tmp')
    for d in (final_dir, preview_dir, tmp_dir):
        os.makedirs(d, exist_ok=True)

    if not os.path.isfile(args.raw):
        sys.exit('missing TTS input: ' + args.raw)

    rs_path = os.path.join(tmp_dir, args.key + '.16k.wav')
    mva.ffmpeg_resample(args.raw, rs_path, mva.TARGET_SR)
    sr, x = mva.read_wav(rs_path)
    assert sr == mva.TARGET_SR, sr

    speech_samples = len(x)
    x = mva.trim(x, sr)
    peak = float(np.max(np.abs(x)))
    if peak <= 0:
        sys.exit('silent TTS output')
    x = x * (mva.PEAK_TARGET * 32767.0 / peak)
    lead = np.zeros(int(sr * mva.LEAD_SIL_MS / 1000))
    tail = np.zeros(int(sr * mva.TAIL_SIL_MS / 1000))
    x = np.concatenate([lead, x, tail])
    x = np.clip(np.round(x), -32768, 32767).astype(np.int16)

    nibbles, init_pred, init_index = mva.ima_encode(x)
    payload = mva.pack_nibbles(nibbles)
    header = bytes([init_pred & 0xFF, (init_pred >> 8) & 0xFF, init_index & 0xFF, 0])
    adpcm = header + payload

    out_adpcm = os.path.join(final_dir, args.key + '.adpcm')
    with open(out_adpcm, 'wb') as fh:
        fh.write(adpcm)

    dec = mva.ima_decode(mva.unpack_nibbles(payload)[:len(nibbles)], init_pred, init_index)
    dec_i16 = np.clip(np.round(dec), -32768, 32767).astype(np.int16)
    noise = dec_i16.astype(np.float64) - x.astype(np.float64)
    snr = 10 * np.log10(np.sum(x.astype(np.float64) ** 2) / max(np.sum(noise ** 2), 1e-9))
    mva.write_wav(os.path.join(preview_dir, args.key + '.wav'), dec_i16)

    seq = mva.build_beep_sequence(dec_i16.astype(np.float64), 3)
    mva.write_wav(os.path.join(preview_dir, 'seq-' + args.key + '.wav'),
                  np.clip(np.round(seq), -32768, 32767).astype(np.int16))

    entry = {
        'key': args.key,
        'text': args.text,
        'ttsVoice': 'Microsoft Huihui Desktop (SAPI), Rate=-1',
        'speechSecRaw': round(speech_samples / mva.TARGET_SR, 3),
        'durationSec': round(len(x) / mva.TARGET_SR, 3),
        'adpcmBytes': len(adpcm),
        'adpcmSha256': hashlib.sha256(adpcm).hexdigest().upper(),
        'snrDb': round(float(snr), 2),
        'peakFs': round(float(np.max(np.abs(dec_i16))) / 32768.0, 4),
    }
    with open(os.path.join(args.out_dir, 'MANIFEST.json'), 'w', encoding='utf-8') as fh:
        json.dump(entry, fh, ensure_ascii=False, indent=2)
    print('CLIP_OK key={} text={} dur={}s adpcm={}B snr={}dB sha={}'.format(
        args.key, args.text, entry['durationSec'], entry['adpcmBytes'],
        entry['snrDb'], entry['adpcmSha256']))
    print('OUT ' + out_adpcm)


if __name__ == '__main__':
    main()
