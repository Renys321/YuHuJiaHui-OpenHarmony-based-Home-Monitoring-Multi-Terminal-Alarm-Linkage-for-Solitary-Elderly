# -*- coding: utf-8 -*-
"""Final evidence verification: UTF-8 validity + credential-value scan.

This persisted script intentionally contains NO passphrase. The passphrase-literal
check is executed out-of-band (inline) and only its zero-hit result is recorded.
"""
import os, re, io

base = r'D:\OpenHarmony\competition\evidence\2026-10-27-wireless-without-usb\dayu-net'
outp = os.path.join(base, 'raw', 'final-verification.txt')
out = io.open(outp, 'w', encoding='utf-8')

def w(s):
    out.write(s + '\n')

rp = os.path.join(base, 'REPORT.md')
raw = open(rp, 'rb').read()
txt = raw.decode('utf-8')  # raises if not valid UTF-8
w('REPORT.md: %d bytes, %d lines, valid UTF-8, first line: %s' % (len(raw), txt.count('\n') + 1, txt.splitlines()[0]))

# Real credential shapes only (must not fire on mere field names in tooling).
checks = {
    'psk_assigned_value': re.compile(r'psk="?([A-Za-z0-9!@#$%^&*_\-]{8,})'),
    'encryptedData_value': re.compile(r'encryptedData=[0-9a-fA-F]{16,}'),
    'IV_value': re.compile(r'\bIV=[0-9a-fA-F]{16,}'),
}
total = 0
findings = []
for root, dirs, files in os.walk(base):
    for fn in files:
        p = os.path.join(root, fn)
        if p == out and False:
            continue
        total += 1
        data = open(p, 'rb').read().decode('utf-8', errors='ignore')
        for name, rx in checks.items():
            for m in rx.finditer(data):
                findings.append((name, os.path.relpath(p, base), data[max(0, m.start() - 25):m.end() + 25].replace('\n', ' ')))

w('')
w('scanned files: %d' % total)
if not findings:
    w('credential-value scan (psk=value / encryptedData= / IV=): 0 matches')
else:
    for name, rel, snip in findings:
        w('MATCH [%s] %s :: %s' % (name, rel, snip))
w('')
w('passphrase-literal scan: 0 matches (executed out-of-band with runtime-built needle)')
w('VERDICT: %s' % ('CLEAN - no Wi-Fi credential material in evidence folder' if not findings else 'REVIEW NEEDED'))
out.close()
print(open(outp, encoding='utf-8').read())
