#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Read-only watcher: sample bridge/status.json and count deviceIds; also record
whether esp32-bath ever appears. No writes, no commands sent."""
import json
import time
import sys
from collections import Counter

STATUS = r'D:\OpenHarmony\competition\bridge\status.json'
secs = int(sys.argv[1]) if len(sys.argv) > 1 else 30
c = Counter()
samples = 0
end = time.time() + secs
while time.time() < end:
    try:
        with open(STATUS, 'r', encoding='utf-8') as f:
            obj = json.load(f)
        c[obj.get('deviceId', '?')] += 1
    except Exception as e:
        c['<read-error>'] += 1
    samples += 1
    time.sleep(0.7)
print('samples=%d window=%ss' % (samples, secs))
for k, v in c.most_common():
    print('  %-16s %d' % (k, v))
print('esp32-bath seen:', 'YES' if c.get('esp32-bath', 0) else 'NO')
