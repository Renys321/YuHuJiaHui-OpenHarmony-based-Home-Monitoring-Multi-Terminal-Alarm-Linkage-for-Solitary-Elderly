@echo off
rem Bridge relaunch after the 2026-10-15 same-ID takeover fix.
rem Same argv as the original process (PID 49956), same ports/working dir.
rem Original argv:
rem   "D:\Node\node.exe" D:\OpenHarmony\competition\bridge\mqtt_bridge.js --broker 127.0.0.1:1883
rem     --status-tcp 127.0.0.1:9001 --listen 9101 --relay-to 127.0.0.1:9001
rem     --cmd-out D:\OpenHarmony\competition\bridge\_test\control
rem     --status-file D:\OpenHarmony\competition\bridge\_test\status.json
cd /d "D:\OpenHarmony\competition\bridge\_test"
"D:\Node\node.exe" "D:\OpenHarmony\competition\bridge\mqtt_bridge.js" --broker 127.0.0.1:1883 --status-tcp 127.0.0.1:9001 --listen 9101 --relay-to 127.0.0.1:9001 --cmd-out "D:\OpenHarmony\competition\bridge\_test\control" --status-file "D:\OpenHarmony\competition\bridge\_test\status.json" >> "D:\OpenHarmony\competition\evidence\2026-10-15-bridge-multinode-runtime\bridge.out.log" 2>&1