@echo off
chcp 65001 >nul
title Shouchao Core Supervisor
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0core-supervisor.ps1" %*
