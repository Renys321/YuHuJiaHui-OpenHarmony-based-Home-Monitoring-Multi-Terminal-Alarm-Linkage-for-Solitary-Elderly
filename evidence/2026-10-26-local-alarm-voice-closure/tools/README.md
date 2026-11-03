# Bench tooling — LOCAL-ALARM-VOICE-CLOSURE

Evidence-only tools. Nothing here touches production ports 1883 / 9101 / 9001, and
nothing here modifies `competition/esp32-node` sources.

Environment facts on this bench host (verified 2026-10-26):

* Node: `D:\Node\node.exe` -> v24.19.0 (`node` on PATH is the same build).
* `pwsh` (PowerShell 7) is **not installed**; the harness is **Windows PowerShell 5.1**
  with `RemoteSigned` policy. Run every `.ps1` with
  `powershell -NoProfile -ExecutionPolicy Bypass -File <script>` (or
  `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force` first).
  All `.ps1` here are pure ASCII so Windows PowerShell 5.1 parses them regardless of BOM.
* pyserial 3.5 lives at
  `D:\Espressif-5.1.6\python_env\idf5.1_py3.11_env\Scripts\python.exe`
  (the env-root `...\idf5.1_py3.11_env\python.exe` does not exist).

## 1. bench-server.js — isolated TCP bench (newline JSON)

Use only if the bench firmware can actually reach the PC over WiFi (the demo AP is
currently absent, so the serial harness below is the primary path).

```powershell
# boards connect to <PC LAN IP>:9102 -> bind 0.0.0.0
D:\Node\node.exe tools\bench-server.js --host 0.0.0.0 --port 9102

# self-test on the isolated port 19102 (+ fake node, logs, serial/hash checks)
D:\Node\node.exe tools\selftest-bench-server.js
```

Command injection (exact lines forwarded to the node's TCP socket, never interpreted):

```powershell
# control file, polled every 200 ms
Add-Content tools\bench-control.jsonl '{"send":"esp32-bath","cmd":"inj climate 35.0 80"}'
Add-Content tools\bench-control.jsonl '{"send":"esp32-bath","cmd":"ack <alarmId>"}'

# or a JSON line on the server's stdin
'{"send":"esp32-kitchen","cmd":"stop"}' | D:\Node\node.exe tools\bench-server.js --host 0.0.0.0 --port 9102

# status / graceful stop
'{"status":true}'   | ...   # prints connected devices
'{"shutdown":true}' | ...   # clean stop (SIGINT also works)
```

Evidence written: `verify/bench-status.jsonl` (one row per received line, receive
wall-clock + parsed `deviceId`/`state`/`ts`/`alarm` + raw) and
`verify/bench-commands.jsonl` (`sent` / `delivered` / `queued` / `node_connected` /
`node_disconnected` / `server_start` / `server_stop`, all timestamped).
Offline commands are queued per device (default 64) and delivered on reconnect.

## 2. bench-serial.py — PRIMARY harness for serial-driven bench firmware

The bench firmware is driven over USB serial because the demo AP is missing.
`DTR`/`RTS` are released before `open()`; the only reset is the normal open pulse,
after which the firmware boots. It writes **only** the scenario command lines.

```powershell
$py = 'D:\Espressif-5.1.6\python_env\idf5.1_py3.11_env\Scripts\python.exe'

& $py tools\bench-serial.py --list-ports
& $py tools\bench-serial.py --selftest          # offline: ANSI/UTF-8/parser/command-write checks
& $py tools\bench-serial.py --com COM4 --scenario tools\bench-scenario.example.json
& $py tools\bench-serial.py --com COM4 --send-line "inj climate 35.0 80" --seconds 20
```

Scenario JSON:

```json
{"durationSec": 60,
 "steps": [{"atSec": 2, "send": "inj climate 35.0 80"},
           {"atSec": 5, "send": "stop"},
           {"atSec": 8, "send": "ack <alarmId>"}]}
```

Commands: `inj climate <temp> <rh>`, `inj climate invalid`, `inj pir 0|1`,
`inj sos`, `inj motion`, `stop`, `ack <alarmId>`, `reset`, `pause`, `resume`.
One command per line, sent at its `atSec` offset (late steps are caught up).
Default log: `verify/serial-<COM>-<ts>.log`, format
`[+00012.345s] [2026-10-26T16:30:00.123+08:00] <ANSI-stripped line>`.
Summary prints lines/bytes captured and every command with send time + exact text,
plus hit counts for markers (`BENCH INJECT MODE`, `PLAY clip=`, `STOP result=`,
`ACK 已接受并生效`, `STOP 已接受并生效`, `重复提醒`, `异常解除 -> NORMAL`, `INJ `, `→ {`).
Exit codes: 0 OK, 2 usage/scenario/open error, 1 runtime error.

`serial-capture.ps1` / `serial-capture.py` are simpler passive capture variants
(`-Com COM4 -Seconds 120`, same DTR/RTS handling) if only raw console logging is needed.

## 3. hash-evidence.ps1 — integrity manifest

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\hash-evidence.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File tools\hash-evidence.ps1 -Verify
```

Writes `<evidence>/SHA256SUMS.txt`, sorted by relative path (Ordinal), format
`<sha256>  <relative/path>`, UTF-8 without BOM, LF endings. Locked files (a build/flash
job still writing) are retried; if still unreadable no manifest is written and it exits 3
so the snapshot cannot silently miss files. Re-run when build/flash jobs are quiet.

## 4. Safety

* Production services on 1883 / 9101 / 9001 are LIVE: never bind/stop/restart them.
  `bench-server.js` refuses to bind those ports and only listens (no outbound connects).
* COM4 / COM5 belong to the Lead's boards; do not open them from this tooling while the
  Lead is capturing.
