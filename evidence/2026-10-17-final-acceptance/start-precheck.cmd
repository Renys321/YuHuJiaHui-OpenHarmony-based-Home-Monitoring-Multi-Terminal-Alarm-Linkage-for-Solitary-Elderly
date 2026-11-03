@echo off
title YOLO PRE-CHECK (ground-zone calibrated, no publish)
cd /d D:\OpenHarmony\competition
.venv-vision\Scripts\python.exe vision\yolo_pose_service.py --model vision\yolo11n-pose.pt --device cpu --listen-host 127.0.0.1 --listen-port 9200 --broker 127.0.0.1:1883 --target-device dayu200-living --frame-rotation 0 --ground-zone 0,0.55,1,0.80,1,1,0,1 --diag-conditions >> "D:\OpenHarmony\competition\evidence\2026-10-17-final-acceptance\precheck.out" 2>> "D:\OpenHarmony\competition\evidence\2026-10-17-final-acceptance\precheck.err"
echo [precheck exited %ERRORLEVEL%]
pause >nul