#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Concatenate the six 'buzzer pattern + full Chinese speech' preview clips into one WAV
so the user can listen to the exact最终音频 sequence on the PC before any board is flashed.
"""
import os
import wave

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PREV = os.path.join(ROOT, 'audio', 'preview')
ORDER = ['sos', 'climate_temp', 'climate_rh', 'climate_both', 'no_motion', 'climate_generic']
GAP_MS = 900


def read(path):
    with wave.open(path, 'rb') as w:
        assert w.getframerate() == 16000 and w.getnchannels() == 1 and w.getsampwidth() == 2
        return np.frombuffer(w.readframes(w.getnframes()), dtype='<i2')


def main():
    parts = []
    gap = np.zeros(int(16000 * GAP_MS / 1000), dtype='<i2')
    total = 0.0
    for key in ORDER:
        p = os.path.join(PREV, 'seq-' + key + '.wav')
        a = read(p)
        parts.append(a)
        parts.append(gap)
        total += len(a) / 16000.0
        print('%-16s %.2fs (含提示音)' % (key, len(a) / 16000.0))
    out = os.path.join(PREV, 'preview-all-6-clips.wav')
    data = np.concatenate(parts)
    with wave.open(out, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(data.tobytes())
    print('wrote %s  total=%.1fs' % (out, total))


if __name__ == '__main__':
    main()
