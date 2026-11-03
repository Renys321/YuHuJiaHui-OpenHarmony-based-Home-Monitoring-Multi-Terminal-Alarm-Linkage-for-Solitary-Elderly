@echo off
title public-sync  (DAYU200 + ESP32 -> https://api.luxunacc.xyz)
cd /d D:\OpenHarmony\competition\cloud\onenet
echo ============================================================
echo  public-sync  -^>  https://api.luxunacc.xyz
echo  看到下面提示时，请直接输入 INGEST_KEY 并回车（输入不回显）：
echo    Enter public backend INGEST_KEY (hidden):
echo ============================================================
node run-public-sync.js
echo.
echo [run-public-sync 已退出，退出码 %ERRORLEVEL%]  按任意键关闭此窗口
pause >nul