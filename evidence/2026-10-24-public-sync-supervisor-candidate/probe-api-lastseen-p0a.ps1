# P0-A API lastSeen probe (interactive, no credentials embedded).
#
# Reads the authenticated backend device list TWICE with an interval and verifies
# that lastSeenTs advances for esp32-kitchen / esp32-bath / dayu200-living.
# Credentials are entered interactively and never printed, written or logged.
# Only whitelisted fields (deviceId, lastSeenTs, state, gas/smoke raw+valid,
# motion lastActiveTs/countToday) are written to evidence JSON.
#
# Run in your own PowerShell window:
#   powershell -NoProfile -ExecutionPolicy Bypass -File probe-api-lastseen-p0a.ps1
param(
    [int]$IntervalSeconds = 120,
    [string]$OutDir = 'D:\OpenHarmony\competition\evidence\2026-10-24-public-sync-supervisor-candidate\runtime'
)

$ErrorActionPreference = 'Stop'
$Targets = @('esp32-kitchen', 'esp32-bath', 'dayu200-living')
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$outFile = Join-Path $OutDir "api-lastseen-$stamp.json"
$resultFile = Join-Path $OutDir "api-lastseen-$stamp.txt"

$guardianId = ''
$passwordPlain = ''
$token = ''
$headers = $null

function Get-WhitelistRows($devices) {
    $rows = @()
    foreach ($d in @($devices.devices)) {
        if ($null -eq $d) { continue }
        $id = [string]$d.deviceId
        if ($Targets -notcontains $id) { continue }
        $row = [ordered]@{ deviceId = $id; lastSeenTs = $d.lastSeenTs; state = $d.state }
        if ($id -eq 'esp32-kitchen') {
            $gas = $null
            $smoke = $null
            if ($null -ne $d.sensors -and $null -ne $d.sensors.gas) {
                $gas = [ordered]@{ raw = $d.sensors.gas.raw; valid = $d.sensors.gas.valid }
            }
            if ($null -ne $d.sensors -and $null -ne $d.sensors.smoke) {
                $smoke = [ordered]@{ raw = $d.sensors.smoke.raw; valid = $d.sensors.smoke.valid }
            }
            $row['sensors'] = [ordered]@{ gas = $gas; smoke = $smoke }
        } elseif ($id -eq 'esp32-bath') {
            $motion = $null
            if ($null -ne $d.sensors -and $null -ne $d.sensors.motion) {
                $motion = [ordered]@{
                    lastActiveTs = $d.sensors.motion.lastActiveTs
                    countToday = $d.sensors.motion.countToday
                }
            }
            $row['sensors'] = [ordered]@{ motion = $motion }
        }
        $rows += $row
    }
    return $rows
}

try {
    $guardianId = (Read-Host 'guardianId').Trim()
    if ($guardianId.Length -eq 0) { throw 'guardianId is empty' }

    $secure = Read-Host 'password (hidden)' -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { $passwordPlain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }

    $body = @{ guardianId = $guardianId; password = $passwordPlain } | ConvertTo-Json -Compress
    $auth = Invoke-RestMethod -Uri 'https://api.luxunacc.xyz/api/v1/auth/app' -Method Post `
        -ContentType 'application/json' -Body $body -TimeoutSec 20
    $token = [string]$auth.sessionToken
    if ($token.Length -eq 0) { throw 'AUTH_TOKEN_MISSING' }
    $headers = @{ Authorization = "Bearer $token" }

    $devices1 = Invoke-RestMethod -Uri 'https://api.luxunacc.xyz/api/v1/devices' -Method Get -Headers $headers -TimeoutSec 20
    $rows1 = Get-WhitelistRows $devices1
    Write-Host "first read at $((Get-Date).ToString('o')); waiting $IntervalSeconds s for natural updates..."

    Start-Sleep -Seconds $IntervalSeconds

    $devices2 = Invoke-RestMethod -Uri 'https://api.luxunacc.xyz/api/v1/devices' -Method Get -Headers $headers -TimeoutSec 20
    $rows2 = Get-WhitelistRows $devices2

    $advanced = [ordered]@{}
    $missing = @()
    $allAdvanced = $true
    foreach ($id in $Targets) {
        $a = $rows1 | Where-Object { $_.deviceId -eq $id } | Select-Object -First 1
        $b = $rows2 | Where-Object { $_.deviceId -eq $id } | Select-Object -First 1
        if (-not $a -or -not $b) {
            $advanced[$id] = 'MISSING'
            $missing += $id
            $allAdvanced = $false
            continue
        }
        $ok = ([double]$b.lastSeenTs -gt [double]$a.lastSeenTs)
        $advanced[$id] = $ok
        if (-not $ok) { $allAdvanced = $false }
    }

    $payload = [ordered]@{
        capturedAt = (Get-Date).ToString('o')
        intervalSeconds = $IntervalSeconds
        first = $rows1
        second = $rows2
        lastSeenAdvanced = $advanced
        missing = @($missing)
    }
    $payload | ConvertTo-Json -Depth 10 | Set-Content -Path $outFile -Encoding UTF8
    @(
        'probe=OK',
        "capturedAt=$((Get-Date).ToString('o'))",
        "whitelist=$outFile",
        "lastSeenAdvanced=$($advanced | ConvertTo-Json -Compress)"
    ) | Set-Content -Path $resultFile -Encoding UTF8

    Write-Host ''
    Write-Host '=== whitelisted API evidence (no token/password) ==='
    $payload | ConvertTo-Json -Depth 10
    Write-Host ''
    if ($allAdvanced) {
        Write-Host 'RESULT: PASS (all three lastSeenTs advanced)' -ForegroundColor Green
        exit 0
    }
    Write-Host 'RESULT: FAIL (some lastSeenTs did not advance or were missing)' -ForegroundColor Red
    exit 1
} catch {
    $message = $_.Exception.Message
    @(
        'probe=FAILED',
        "failure=$message",
        "capturedAt=$((Get-Date).ToString('o'))"
    ) | Set-Content -Path $resultFile -Encoding UTF8
    Write-Host "RESULT: FAILED: $message" -ForegroundColor Red
    exit 1
} finally {
    $guardianId = ''
    $passwordPlain = ''
    $token = ''
    $auth = $null
    $headers = $null
    Remove-Variable guardianId, passwordPlain, token, auth, headers, body, bstr, secure -ErrorAction SilentlyContinue
    Write-Host 'Credentials were not written or printed. This window can be closed.'
}
