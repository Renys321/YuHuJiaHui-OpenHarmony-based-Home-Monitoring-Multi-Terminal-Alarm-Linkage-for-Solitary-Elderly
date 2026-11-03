@echo off
title elder-care public-sync supervisor (do NOT close this window)
cd /d D:\OpenHarmony\competition\cloud\onenet
"D:\Node\node.exe" public-sync-supervisor.js ^
  --state-file "D:\OpenHarmony\competition\bridge\_test\current-runtime\supervisor\public-sync-supervisor.state.json" ^
  --lock-file "D:\OpenHarmony\competition\bridge\_test\current-runtime\supervisor\public-sync-supervisor.lock" ^
  --log-file "D:\OpenHarmony\competition\bridge\_test\current-runtime\supervisor\public-sync-supervisor.log"
echo.
echo [public-sync supervisor exited]
pause
