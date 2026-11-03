@echo off
title YOLO PRE-CHECK (no publish)
cd /d D:\OpenHarmony\competition
.venv-vision\Scripts\python.exe vision\yolo_pose_service.py --model vision\yolo11n-pose.pt --device cpu --listen-host 127.0.0.1 --listen-port 9200 --broker 127.0.0.1:1883 --target-device dayu200-living --evidence-dir "D:\OpenHarmony\competition\evidence\2026-10-16-fall-acceptance\pc-evidence" --diag-conditions >> "D:\OpenHarmony\competition\evidence\2026-10-16-fall-acceptance\precheck-stdout.log" 2>> "D:\OpenHarmony\competition\evidence\2026-10-16-fall-acceptance\precheck-stderr.log"
echo [precheck exited %ERRORLEVEL%]
pause >nul