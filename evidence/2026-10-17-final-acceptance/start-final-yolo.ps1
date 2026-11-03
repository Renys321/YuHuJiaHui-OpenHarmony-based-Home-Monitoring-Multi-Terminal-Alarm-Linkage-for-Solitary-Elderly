$ErrorActionPreference = 'Continue'
Set-Location 'D:\OpenHarmony\competition'
Write-Host '================================================================='
Write-Host ' FINAL YOLO (calibrated) : publish + evidence + upload + diag'
Write-Host '  rotation : 0 (explicit)'
Write-Host '  ground   : 0,0.55,1,0.80,1,1,0,1'
Write-Host '  evidence : D:\OpenHarmony\competition\evidence\2026-10-17-final-acceptance\pc-evidence'
Write-Host '  upload   : https://api.luxunacc.xyz/internal/v1/evidence/<id>'
Write-Host '================================================================='
$sec = Read-Host -AsSecureString 'Enter BACKEND_INGEST_KEY (hidden)'
$env:BACKEND_INGEST_KEY = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto([System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
if ($env:BACKEND_INGEST_KEY) { Write-Host '[launcher] ingest key SET' } else { Write-Host '[launcher] ingest key EMPTY (upload disabled)' }
& '.venv-vision\Scripts\python.exe' '.\vision\yolo_pose_service.py' --model '.\vision\yolo11n-pose.pt' --device cpu --listen-host 127.0.0.1 --listen-port 9200 --publish --broker 127.0.0.1:1883 --target-device dayu200-living --evidence-dir 'D:\OpenHarmony\competition\evidence\2026-10-17-final-acceptance\pc-evidence' --evidence-max-events 200 --evidence-upload-url 'https://api.luxunacc.xyz' --frame-rotation 0 --ground-zone 0,0.55,1,0.80,1,1,0,1 --diag-conditions 2>> 'D:\OpenHarmony\competition\evidence\2026-10-17-final-acceptance\final-diag.err'
Write-Host ''
Write-Host '[service exited] press Enter to close'
Read-Host
