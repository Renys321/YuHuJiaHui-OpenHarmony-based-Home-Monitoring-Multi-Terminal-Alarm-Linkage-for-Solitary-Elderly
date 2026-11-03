@echo off
title YOLO diag (real DAYU frames)
cd /d D:\OpenHarmony\competition
echo service running with --diag-conditions (logs to files)
echo stderr: D:\OpenHarmony\competition\evidence\2026-10-16-fall-acceptance\diag-stderr.log
.venv-vision\Scripts\python.exe vision\yolo_pose_service.py --model vision\yolo11n-pose.pt --device cpu --listen-host 127.0.0.1 --listen-port 9200 --publish --broker 127.0.0.1:1883 --target-device dayu200-living --evidence-dir "D:\OpenHarmony\competition\evidence\2026-10-16-fall-acceptance\pc-evidence" --evidence-max-events 200 --evidence-upload-url https://api.luxunacc.xyz --diag-conditions >> "D:\OpenHarmony\competition\evidence\2026-10-16-fall-acceptance\diag-stdout.log" 2>> "D:\OpenHarmony\competition\evidence\2026-10-16-fall-acceptance\diag-stderr.log"
echo.
echo [yolo diag exited %ERRORLEVEL%]
pause >nul