@echo off
title vision guardian (YOLO child + monitor offline watchdog)
cd /d D:\OpenHarmony\competition
echo ============================================================
echo  PC vision guardian: YOLO child + independent offline reporting
echo  log: D:\OpenHarmony\competition\evidence\2026-10-15-dayu-fall-monitor-runtime\guardian.log
echo ============================================================
.venv-vision\Scripts\python.exe vision\vision_guardian.py --publish --log "D:\OpenHarmony\competition\evidence\2026-10-15-dayu-fall-monitor-runtime\guardian.log" --lock "D:\OpenHarmony\competition\evidence\2026-10-15-dayu-fall-monitor-runtime\guardian.lock" --service-log "D:\OpenHarmony\competition\evidence\2026-10-15-dayu-fall-monitor-runtime\yolo-service.log"
echo.
echo [guardian exited: %ERRORLEVEL%]  press any key to close
pause >nul