@echo off
setlocal
title DAYU demo autostart
cd /d "%~dp0demo-autostart"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0demo-autostart\demo-autostart.ps1"
if errorlevel 1 (
  echo.
  echo demo-autostart exited with an error. See evidence\2026-10-26-demo-autostart\runtime\demo-autostart.log
  pause
)
