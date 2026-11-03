@echo off
chcp 65001 >nul
title Shouchao Voice Chain Test
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0voice-chain-test.ps1" %*
echo.
pause
