@echo off
title public-sync supervisor candidate
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-demo-supervisor-candidate.ps1"
echo.
echo [supervisor candidate exited]
pause >nul
