@echo off
chcp 65001 >nul
title Restore DAYU200 hdc mappings
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0restore-hdc-mappings.ps1"
if errorlevel 1 pause
pause >nul
