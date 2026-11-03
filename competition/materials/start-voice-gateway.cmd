@echo off
setlocal
title Shouchao Voice Gateway
set "HDC=D:\OpenHarmony\tools\hdc\hdc.exe"
set "NODE=D:\Node\node.exe"
set "GATEWAY=D:\OpenHarmony\competition\voice-gateway\server.js"

echo [1/2] Mapping device port 9302 -> PC 9302 (hdc rport)...
"%HDC%" rport tcp:9302 tcp:9302
if errorlevel 1 echo [warn] hdc rport failed. Check device connection; rerun after replug/reboot.

echo [2/2] Starting voice gateway...
"%NODE%" "%GATEWAY%"
