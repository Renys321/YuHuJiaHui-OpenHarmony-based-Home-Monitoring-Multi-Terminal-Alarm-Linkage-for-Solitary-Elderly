@echo off
setlocal
set "PROJECT=D:\OpenHarmony\competition"
set "HDC=D:\OpenHarmony\tools\hdc\hdc.exe"
set "PYTHON=%PROJECT%\.venv-vision\Scripts\python.exe"
set "MQTT_TOOL=%PROJECT%\bridge\mqtt_tool.js"

if not exist "%HDC%" (
  echo [guard] HDC not found: %HDC%
  exit /b 2
)
if not exist "%PYTHON%" (
  echo [guard] Python environment not found: %PYTHON%
  exit /b 2
)
if not exist "%MQTT_TOOL%" (
  echo [guard] MQTT tool not found: %MQTT_TOOL%
  exit /b 2
)
where node >nul 2>nul
if errorlevel 1 (
  echo [guard] Node.js is required for MQTT alarm publication.
  exit /b 2
)

"%HDC%" fport ls | findstr /C:"tcp:9200 tcp:9200" | findstr /C:"[Reverse]" >nul
if errorlevel 1 "%HDC%" rport tcp:9200 tcp:9200 >nul
"%HDC%" fport ls | findstr /C:"tcp:9200 tcp:9200" | findstr /C:"[Reverse]" >nul
if errorlevel 1 (
  echo [guard] Failed to verify USB reverse port tcp:9200.
  exit /b 3
)

node "%MQTT_TOOL%" pub --broker 127.0.0.1:1883 --topic home/dayu200-living/vision/status --msg "{\"state\":\"GUARD_STARTING\"}" >nul
if errorlevel 1 (
  echo [guard] MQTT broker 127.0.0.1:1883 is unavailable. Alarm publishing cannot start.
  exit /b 4
)

echo [guard] Automatic monitoring: DAYU -USB-^> PC YOLO -MQTT-^> FALL alarm chain
echo [guard] Keep mqtt_bridge and the DAYU homemon route running for device alarms.
echo [guard] Press Ctrl+C to stop the PC inference service.
cd /d "%PROJECT%"
"%PYTHON%" ".\vision\yolo_pose_service.py" --model ".\vision\yolo11n-pose.pt" --device cpu --listen-host 127.0.0.1 --listen-port 9200 --publish --broker 127.0.0.1:1883 --target-device dayu200-living
exit /b %errorlevel%
