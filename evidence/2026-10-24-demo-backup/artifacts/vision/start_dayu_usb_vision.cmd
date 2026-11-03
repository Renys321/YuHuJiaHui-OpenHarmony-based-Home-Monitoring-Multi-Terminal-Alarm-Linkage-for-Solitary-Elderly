@echo off
setlocal
set "PROJECT=D:\OpenHarmony\competition"
set "HDC=D:\OpenHarmony\tools\hdc\hdc.exe"
set "PYTHON=%PROJECT%\.venv-vision\Scripts\python.exe"

if not exist "%HDC%" (
  echo [vision] HDC not found: %HDC%
  exit /b 2
)
if not exist "%PYTHON%" (
  echo [vision] Python environment not found: %PYTHON%
  exit /b 2
)

"%HDC%" fport ls | findstr /C:"tcp:9200 tcp:9200" | findstr /C:"[Reverse]" >nul
if errorlevel 1 "%HDC%" rport tcp:9200 tcp:9200 >nul
"%HDC%" fport ls | findstr /C:"tcp:9200 tcp:9200" | findstr /C:"[Reverse]" >nul
if errorlevel 1 (
  echo [vision] Failed to verify USB reverse port tcp:9200
  exit /b 3
)

echo [vision] DAYU 127.0.0.1:9200 -USB-^> PC 127.0.0.1:9200
echo [vision] Press Ctrl+C to stop the PC inference service.
cd /d "%PROJECT%"
"%PYTHON%" ".\vision\yolo_pose_service.py" --model ".\vision\yolo11n-pose.pt" --device cpu --listen-host 127.0.0.1 --listen-port 9200
exit /b %errorlevel%
