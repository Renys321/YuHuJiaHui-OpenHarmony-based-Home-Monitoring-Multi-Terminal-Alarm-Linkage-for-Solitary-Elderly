@echo off
title YOLO fall guard (real DAYU frames) + evidence upload
cd /d D:\OpenHarmony\competition
echo ================================================================
echo  Real YOLO fall guard on real DAYU camera frames
echo   - model  : vision\yolo11n-pose.pt (CPU)
echo   - input  : HTTP frames from DAYU via 127.0.0.1:9200 (USB reverse)
echo   - publish: home/dayu200-living/cmd (real FALL only)
echo   - evidence: D:\OpenHarmony\competition\evidence\2026-10-16-fall-acceptance\pc-evidence
echo   - upload : https://api.luxunacc.xyz/internal/v1/evidence/<evidenceId>
echo.
echo  Enter BACKEND_INGEST_KEY below (hidden input, not echoed,
echo  never stored in argv / logs / files). Leave empty to disable upload.
echo ================================================================
powershell -NoProfile -ExecutionPolicy Bypass -Command "$s = Read-Host -AsSecureString 'Enter BACKEND_INGEST_KEY (hidden)'; $env:BACKEND_INGEST_KEY = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto([System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)); Write-Host ('[launcher] ingest key ' + $(if ($env:BACKEND_INGEST_KEY) {'SET'} else {'EMPTY'})); & '.venv-vision\Scripts\python.exe' '.\vision\yolo_pose_service.py' --model '.\vision\yolo11n-pose.pt' --device cpu --listen-host 127.0.0.1 --listen-port 9200 --publish --broker 127.0.0.1:1883 --target-device dayu200-living --evidence-dir 'D:\OpenHarmony\competition\evidence\2026-10-16-fall-acceptance\pc-evidence' --evidence-max-events 200 --evidence-upload-url 'https://api.luxunacc.xyz' 2>&1 | Tee-Object -FilePath 'D:\OpenHarmony\competition\evidence\2026-10-16-fall-acceptance\yolo-live.log'"
echo.
echo [service exited: %ERRORLEVEL%]  press any key to close
pause >nul