$ErrorActionPreference = 'Continue'
$log = 'D:\OpenHarmony\competition\evidence\2026-10-16-fall-acceptance\yolo-live.log'
Set-Location 'D:\OpenHarmony\competition'
Write-Host '==============================================================='
Write-Host ' Real YOLO fall guard on real DAYU camera frames'
Write-Host '  model   : vision\yolo11n-pose.pt (CPU)'
Write-Host '  input   : HTTP frames from DAYU via 127.0.0.1:9200 (USB reverse)'
Write-Host '  publish : home/dayu200-living/cmd (real FALL only)'
Write-Host '  evidence: D:\OpenHarmony\competition\evidence\2026-10-16-fall-acceptance\pc-evidence'
Write-Host '  upload  : https://api.luxunacc.xyz/internal/v1/evidence/<evidenceId>'
Write-Host '==============================================================='
$sec = Read-Host -AsSecureString 'Enter BACKEND_INGEST_KEY (hidden input, not echoed)'
$env:BACKEND_INGEST_KEY = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto([System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
if ($env:BACKEND_INGEST_KEY) { Write-Host '[launcher] ingest key SET (upload enabled)' } else { Write-Host '[launcher] ingest key EMPTY (upload disabled)' }
& '.venv-vision\Scripts\python.exe' '.\vision\yolo_pose_service.py' --model '.\vision\yolo11n-pose.pt' --device cpu --listen-host 127.0.0.1 --listen-port 9200 --publish --broker 127.0.0.1:1883 --target-device dayu200-living --evidence-dir 'D:\OpenHarmony\competition\evidence\2026-10-16-fall-acceptance\pc-evidence' --evidence-max-events 200 --evidence-upload-url 'https://api.luxunacc.xyz' 2>&1 | Tee-Object -FilePath $log
Write-Host ''
Write-Host '[service exited] press Enter to close this window'
Read-Host
