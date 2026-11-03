"""COM5 read-only observer: only selected sensor fields and voice markers escape.

No serial commands or raw UART capture. Optional --restart pulses EN once.
Never persist arbitrary lines.
"""
import argparse
import datetime
import json
import re
import time
from pathlib import Path

import serial

parser = argparse.ArgumentParser()
parser.add_argument('--seconds', type=int, default=25, choices=range(1, 121))
parser.add_argument('--stage', choices=['before', 'listening', 'normal', 'listening-v20', 'normal-v20'], required=True)
parser.add_argument('--restart', action='store_true', help='One physical EN restart after observer opens; no application command')
args = parser.parse_args()
result = {'stage': args.stage, 'port': 'COM5', 'startedAt': datetime.datetime.now().astimezone().isoformat(),
          'rawUARTSaved': False, 'serialCommandsSent': False, 'hardwareRestart': args.restart,
          'samples': [], 'voice': [], 'network': [], 'diagnostics': []}
port = serial.Serial(port=None, baudrate=115200, timeout=0.25)
port.dtr = False
port.rts = False
port.port = 'COM5'
try:
    port.open()
    if args.restart:
        port.rts = True
        time.sleep(0.1)
        port.rts = False
    deadline = time.monotonic() + args.seconds
    pending = b''
    while time.monotonic() < deadline:
        pending += port.read(min(port.in_waiting or 1, 4096))
        if len(pending) > 16384:
            pending = pending[-8192:]
        while b'\n' in pending:
            line, pending = pending.split(b'\n', 1)
            text = re.sub(r'\x1b\[[0-9;]*m', '', line.decode('utf-8', errors='replace'))
            if 'Guru Meditation Error:' in text:
                marker = re.search(r'Guru Meditation Error: Core\s+\d+ panic\S* \([A-Za-z0-9 _/]+\)', text)
                if marker:
                    result['diagnostics'].append(marker.group(0))
                    print(json.dumps({'diagnostic': marker.group(0)}), flush=True)
            for pattern in [r'Stack canary watchpoint triggered \([A-Za-z0-9_-]+\)',
                            r'A stack overflow in task [A-Za-z0-9_-]+ has been detected',
                            r'Backtrace:(?: 0x[0-9a-fA-F]+:0x[0-9a-fA-F]+)+',
                            r'rst:0x[0-9a-fA-F]+ \([A-Z0-9_]+\)',
                            r'STACK_FREE task=(?:main|gateway-net|local-voice) bytes=[0-9]+']:
                diagnostic = re.search(pattern, text)
                if diagnostic:
                    result['diagnostics'].append(diagnostic.group(0))
                    print(json.dumps({'diagnostic': diagnostic.group(0)}), flush=True)
            if '已连接网关 ' in text:
                result['network'].append('GATEWAY_CONNECTED')
            elif '已获取 IP:' in text:
                result['network'].append('WIFI_GOT_IP')
            elif 'network worker unavailable;' in text:
                result['network'].append('NETWORK_TASK_UNAVAILABLE')
            elif 'WiFi 断开（reason=' in text:
                result['network'].append('WIFI_DISCONNECTED')
            start = text.find('{"deviceId":')
            if start >= 0:
                try:
                    frame = json.JSONDecoder().raw_decode(text[start:])[0]
                    if frame.get('deviceId') != 'esp32-kitchen':
                        continue
                    sensors = frame.get('sensors', {})
                    sample = {'observedAt': datetime.datetime.now().astimezone().isoformat(),
                              'deviceId': 'esp32-kitchen', 'deviceTs': frame.get('ts'),
                              'state': frame.get('state'),
                              'climate': {k: sensors.get('climate', {}).get(k) for k in ['tempC', 'rh', 'valid']},
                              'gas': {k: sensors.get('gas', {}).get(k) for k in ['raw', 'valid']},
                              'smoke': {k: sensors.get('smoke', {}).get(k) for k in ['raw', 'valid']}}
                    result['samples'].append(sample)
                    print(json.dumps(sample, ensure_ascii=False), flush=True)
                except (ValueError, TypeError, AttributeError):
                    pass
            if 'local-voice:' in text:
                body = text.split('local-voice:', 1)[1].strip()
                if body == 'READY playback-only 16000Hz; no boot alarm':
                    marker = 'READY'
                elif re.fullmatch(r'PLAY clip=[123]', body):
                    marker = body
                elif re.fullmatch(r'STOP result=ESP_[A-Z0-9_]+ cancelled=[01]', body):
                    marker = body
                elif body.startswith('codec unavailable;'):
                    marker = 'CODEC_UNAVAILABLE'
                elif body.startswith('I2S unavailable;'):
                    marker = 'I2S_UNAVAILABLE'
                elif body == 'voice disabled after init failure; buzzer retained':
                    marker = 'INIT_FAILED'
                else:
                    continue
                result['voice'].append(marker)
                print(json.dumps({'voice': marker}), flush=True)
finally:
    port.close()
out = Path(__file__).resolve().parents[2] / 'evidence' / '2026-10-26-local-speaker-candidate'
out.mkdir(exist_ok=True)
(out / ('KITCHEN-SERIAL-' + args.stage.upper() + '.json')).write_text(
    json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({'capturedSamples': len(result['samples']), 'stage': args.stage}))
