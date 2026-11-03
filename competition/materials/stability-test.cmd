@echo off
chcp 65001 >nul
title Shouchao Stability Test
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0stability-test.ps1" %*
echo.
pause
