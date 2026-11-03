# Isolated diagnostic: feed the REAL button status line into a LOCAL backend instance
# and compare field-level acceptance. Does not touch the public backend or shared services.
# ASCII-only (Windows PowerShell 5.1 reads this file as ANSI).
param(
    [string]$CaptureSeconds = 9,
    [int]$Port = 3199,
    [string]$EvidenceDir = 'D:\OpenHarmony\competition\evidence\2026-10-26-wireless-sos-button-final'
)
$ErrorActionPreference = 'Stop'
$node = 'D:\Node\node.exe'
$repo = 'D:\OpenHarmony\competition'
$tmp = Join-Path $env:TEMP ('sosprobe' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
# 1) Capture one real esp32-sos status line from the local broker (read-only).
$capFile = Join-Path $tmp 'capture.txt'
& $node (Join-Path $repo 'bridge\mqtt_tool.js') sub --broker 127.0.0.1:1883 --topic 'home/esp32-sos/status' --seconds $CaptureSeconds 2>&1 |
    Tee-Object -FilePath $capFile | Out-Null
$line = Get-Content $capFile | Where-Object { $_ -match '"deviceId":"esp32-sos"' } | Select-Object -Last 1
if (-not $line) { throw 'no esp32-sos status captured in window (device offline?)' }
$json = [regex]::Match($line, '\{.*\}').Value
$raw = $json | ConvertFrom-Json
Write-Host ("CAPTURED deviceId={0} room={1} state={2} alarmId={3}" -f $raw.deviceId, $raw.room, $raw.state, $raw.alarm.id)
[System.IO.File]::WriteAllText((Join-Path $EvidenceDir 'verify\captured-esp32-sos-status.json'), $json, (New-Object System.Text.UTF8Encoding($false)))
# 2) Local backend with isolated data dir and a throwaway key.
$env:PORT = "$Port"
$env:HOST = '127.0.0.1'
$env:BACKEND_INGEST_KEY = 'localtest-ingest-key-0123456789abcdef0123'
$env:INGEST_KEY = 'localtest-ingest-key-0123456789abcdef0123'
$env:BACKEND_DATA_FILE = (Join-Path $tmp 'state.json')
$env:BACKEND_EVIDENCE_DIR = (Join-Path $tmp 'evidence')
$env:BACKEND_ACTIVITY_FILE = (Join-Path $tmp 'activity.json')
$env:APP_GUARDIAN_ID = 'guardian-test'
$env:APP_GUARDIAN_PASSWORD = 'local-test-password-0123456789abcdef0123'
$env:API_TOKEN_SECRET = 'local-test-api-token-secret-0123456789abcdef'
$proc = Start-Process -FilePath $node -ArgumentList (Join-Path $repo 'cloud\backend\src\main.js') -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $tmp 'backend.out') -RedirectStandardError (Join-Path $tmp 'backend.err')
Start-Sleep -Seconds 3
if ($proc.HasExited) { Get-Content (Join-Path $tmp 'backend.err') -Tail 20; throw 'local backend failed to start' }
function Post-Status([string]$Body, [string]$Label) {
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/internal/v1/device-status" -Method Post `
            -Headers @{ 'x-ingest-key' = 'localtest-ingest-key-0123456789abcdef0123'; 'content-type' = 'application/json' } `
            -Body ([System.Text.Encoding]::UTF8.GetBytes($Body)) -UseBasicParsing -TimeoutSec 10
        Write-Host ("{0}: HTTP {1} {2}" -f $Label, $r.StatusCode, $r.Content)
        return $r.StatusCode
    } catch {
        $resp = $_.Exception.Response
        if ($resp) {
            $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
            Write-Host ("{0}: HTTP {1} {2}" -f $Label, [int]$resp.StatusCode, $reader.ReadToEnd())
            return [int]$resp.StatusCode
        }
        Write-Host ("{0}: request error {1}" -f $Label, $_.Exception.Message)
        return 0
    }
}
try {
    $a = Post-Status $json 'A_original_with_valid'
    $raw.sensors.climate.PSObject.Properties.Remove('valid') | Out-Null
    $raw.sensors.gas.PSObject.Properties.Remove('valid') | Out-Null
    $raw.sensors.smoke.PSObject.Properties.Remove('valid') | Out-Null
    $b = Post-Status ($raw | ConvertTo-Json -Depth 8 -Compress) 'B_without_valid'
    Write-Host ("RESULT A={0} B={1}" -f $a, $b)
} finally {
    if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
