@echo off
chcp 65001 >nul
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-demo-full.ps1" %*
if errorlevel 2 pause
exit /b %errorlevel%