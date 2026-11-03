@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0demo_recover.ps1" %*
if errorlevel 1 (
  echo.
  echo demo_recover failed. Press any key to close.
  pause >nul
)
