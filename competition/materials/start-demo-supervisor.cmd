@echo off
title public-sync supervisor demo
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-demo-supervisor.ps1" -AutoDayuEndpoint
echo.
echo [supervisor demo exited]
pause >nul
