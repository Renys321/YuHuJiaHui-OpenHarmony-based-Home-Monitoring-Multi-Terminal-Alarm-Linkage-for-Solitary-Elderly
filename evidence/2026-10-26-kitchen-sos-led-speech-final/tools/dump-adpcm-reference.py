#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Dump reference 16-bit PCM for every final .adpcm clip using Python's stdlib IMA decoder
(audioop.adpcm2lin, an independent implementation). tools/host_adpcm_test.c then decodes
the same files with the firmware decoder (main/adpcm_ima.h) and requires byte equality,
so the ESP32 playback path is proven identical to an independent reference decoder.
"""
import audioop
import hashlib
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
FINAL = os.path.join(ROOT, 'audio', 'final')
VERIFY = os.path.join(ROOT, 'audio', '_verify')


def main():
    os.makedirs(VERIFY, exist_ok=True)
    out = {}
    for name in sorted(os.listdir(FINAL)):
        if not name.endswith('.adpcm'):
            continue
        path = os.path.join(FINAL, name)
        with open(path, 'rb') as f:
            blob = f.read()
        pred = int.from_bytes(blob[0:2], 'little', signed=True)
        index = blob[2]
        pcm, _state = audioop.adpcm2lin(blob[4:], 2, (pred, index))
        ref = os.path.join(VERIFY, name.replace('.adpcm', '.refpcm'))
        with open(ref, 'wb') as f:
            f.write(pcm)
        a = np.frombuffer(pcm, dtype='<i2')
        out[name] = {
            'referenceBytes': len(pcm),
            'referenceSamples': int(len(a)),
            'referenceSha256': hashlib.sha256(pcm).hexdigest().upper(),
            'peakFs': round(float(np.max(np.abs(a.astype(np.float64)))) / 32768.0, 4),
            'referenceTool': 'python audioop.adpcm2lin (stdlib IMA reference)',
            'adpcmSha256': hashlib.sha256(blob).hexdigest().upper(),
            'adpcmBytes': len(blob),
        }
        print('%-24s samples=%6d peak=%.2fFS refSha=%s' % (
            name, len(a), out[name]['peakFs'], out[name]['referenceSha256'][:16]))
    with open(os.path.join(VERIFY, 'REFERENCE.json'), 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print('wrote', os.path.join(VERIFY, 'REFERENCE.json'))


if __name__ == '__main__':
    sys.exit(main())
