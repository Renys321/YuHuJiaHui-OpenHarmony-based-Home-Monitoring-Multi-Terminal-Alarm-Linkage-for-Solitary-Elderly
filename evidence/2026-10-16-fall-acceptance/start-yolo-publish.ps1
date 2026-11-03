$ErrorActionPreference = 'Continue'
$log = 'D:\OpenHarmony\competition\evidence\2026-10-16-fall-acceptance\publish-diag.log'
Set-Location 'D:\OpenHarmony\competition'
Write-Host '==============================================================='
Write-Host ' Real YOLO fall guard (CALIBRATED) + evidence upload'
Write-Host '  model    : vision\yolo11n-pose.pt (CPU)'
Write-Host '  input    : real DAYU frames via 127.0.0.1:9200'
Write-Host '  publish  : home/dayu200-living/cmd (real FALL only)'
Write-Host '  evidence : D:\OpenHarmony\competition\evidence\2026-10-16-fall-acceptance\pc-evidence-r3'
Write-Host '  upload   : https://api.luxunacc.xyz/internal/v1/evidence/<evidenceId>'
Write-Host '  diag     : on (five-condition snapshot)'
Write-Host '==============================================================='
$sec = Read-Host -AsSecureString 'Enter BACKEND_INGEST_KEY (hidden input, not echoed)'
$env:BACKEND_INGEST_KEY = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto([System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
if ($env:BACKEND_INGEST_KEY) { Write-Host '[launcher] ingest key SET (upload enabled)' } else { Write-Host '[launcher] ingest key EMPTY (upload disabled)' }
& '.venv-vision\Scripts\python.exe' '.\vision\yolo_pose_service.py' --model '.\vision\yolo11n-pose.pt' --device cpu --listen-host 127.0.0.1 --listen-port 9200 --publish --broker 127.0.0.1:1883 --target-device dayu200-living --evidence-dir 'D:\OpenHarmony\competition\evidence\2026-10-16-fall-acceptance\pc-evidence-r3' --evidence-max-events 200 --evidence-upload-url 'https://api.luxunacc.xyz' --diag-conditions 2>> 'D:\OpenHarmony\competition\evidence\2026-10-16-fall-acceptance\publish-diag.log'
Write-Host ''
Write-Host '[service exited] press Enter to close'
Read-Host
