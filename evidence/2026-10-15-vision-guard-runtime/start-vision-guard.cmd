@echo off
rem PC-side YOLO Pose guard service (USB frame ingest <-)  — 2026-10-15 P1 audit run.
rem Same args as vision\start_dayu_usb_guard.cmd: --publish --broker 127.0.0.1:1883 --target-device dayu200-living
cd /d D:\OpenHarmony\competition
D:\OpenHarmony\competition\.venv-vision\Scripts\python.exe .\vision\yolo_pose_service.py --model .\vision\yolo11n-pose.pt --device cpu --listen-host 127.0.0.1 --listen-port 9200 --publish --broker 127.0.0.1:1883 --target-device dayu200-living >> "D:\OpenHarmony\competition\evidence\2026-10-15-vision-guard-runtime\service.log" 2>&1