@echo off
chcp 65001 >nul
title Shouchao Core Start
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0core-start.ps1" %*
echo.
pause
