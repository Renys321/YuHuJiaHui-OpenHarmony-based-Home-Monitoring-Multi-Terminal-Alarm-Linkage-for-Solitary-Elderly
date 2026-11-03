# One-shot authenticated API probe for APP-P0-Sensors runtime gate.
# This script contains no credentials. Credentials are entered interactively.
# It writes only whitelisted fields; it never prints token/password/Authorization.
$ErrorActionPreference = 'Stop'
$outDir = 'D:\OpenHarmony\competition\evidence\2026-10-24-app-p0-sensors-runtime-gate'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$outFile = Join-Path $outDir 'authenticated-devices-whitelist.json'
$resultFile = Join-Path $outDir 'probe-result.txt'

$guardianId = ''
$passwordPlain = ''
$auth = $null
$devices = $null
$statusCode = 0
$authCode = 0
$failure = ''
$stepFile = Join-Path $outDir 'probe-steps.txt'
"started=$(Get-Date).ToString('o')" | Set-Content -Path $stepFile -Encoding UTF8

try {
  $guardianId = (Read-Host 'guardianId').Trim()
  "guardian_entered=$(Get-Date).ToString('o')" | Add-Content -Path $stepFile -Encoding UTF8
  if ($guardianId.Length -eq 0) { throw 'guardianId is empty' }

  $securePassword = Read-Host 'password (hidden)' -AsSecureString
  "password_entered=$(Get-Date).ToString('o')" | Add-Content -Path $stepFile -Encoding UTF8
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
  try {
    $passwordPlain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    Remove-Variable bstr -ErrorAction SilentlyContinue
  }

  $authBody = @{ guardianId = $guardianId; password = $passwordPlain } | ConvertTo-Json -Compress
  try {
    $auth = Invoke-RestMethod -Uri 'https://api.luxunacc.xyz/api/v1/auth/app' -Method Post `
      -ContentType 'application/json' -Body $authBody -TimeoutSec 20
    $authCode = 200
  } catch {
    if ($_.Exception.Response -and $_.Exception.Response.StatusCode) {
      $authCode = [int]$_.Exception.Response.StatusCode
    } else {
      $authCode = -1
    }
    throw "AUTH_HTTP_$authCode"
  }

  $token = [string]$auth.sessionToken
  if ($token.Length -eq 0) { throw 'AUTH_TOKEN_MISSING' }

  try {
    $headers = @{ Authorization = "Bearer $token" }
    $devices = Invoke-RestMethod -Uri 'https://api.luxunacc.xyz/api/v1/devices' -Method Get `
      -Headers $headers -TimeoutSec 20
    $statusCode = 200
  } catch {
    if ($_.Exception.Response -and $_.Exception.Response.StatusCode) {
      $statusCode = [int]$_.Exception.Response.StatusCode
    } else {
      $statusCode = -1
    }
    throw "DEVICES_HTTP_$statusCode"
  }

  $whitelist = [ordered]@{
    capturedAt = (Get-Date).ToString('o')
    devices = @()
  }
  foreach ($d in @($devices.devices)) {
    if ($null -eq $d) { continue }
    $id = [string]$d.deviceId
    if ($id -eq 'esp32-kitchen') {
      $gas = $null
      $smoke = $null
      if ($null -ne $d.sensors -and $null -ne $d.sensors.gas) {
        $gas = [ordered]@{ raw = $d.sensors.gas.raw; valid = $d.sensors.gas.valid }
      }
      if ($null -ne $d.sensors -and $null -ne $d.sensors.smoke) {
        $smoke = [ordered]@{ raw = $d.sensors.smoke.raw; valid = $d.sensors.smoke.valid }
      }
      $whitelist.devices += [ordered]@{
        deviceId = $id
        lastSeenTs = $d.lastSeenTs
        sensors = [ordered]@{ gas = $gas; smoke = $smoke }
      }
    } elseif ($id -eq 'esp32-bath') {
      $motion = $null
      if ($null -ne $d.sensors -and $null -ne $d.sensors.motion) {
        $motion = [ordered]@{
          lastActiveTs = $d.sensors.motion.lastActiveTs
          countToday = $d.sensors.motion.countToday
        }
      }
      $whitelist.devices += [ordered]@{
        deviceId = $id
        lastSeenTs = $d.lastSeenTs
        sensors = [ordered]@{ motion = $motion }
      }
    } elseif ($id -eq 'dayu200-living') {
      $whitelist.devices += [ordered]@{
        deviceId = $id
        lastSeenTs = $d.lastSeenTs
        state = $d.state
      }
    }
  }

  $whitelist | ConvertTo-Json -Depth 8 | Set-Content -Path $outFile -Encoding UTF8
  $failure = 'NONE'
} catch {
  $failure = $_.Exception.Message
  if ($failure -notmatch '^AUTH_HTTP_') { $authCode = 0 }
  if ($failure -notmatch '^DEVICES_HTTP_') { $statusCode = 0 }
} finally {
  if ($failure -eq 'NONE') {
    $result = @(
      'probe=OK',
      "auth_http=$authCode",
      "devices_http=$statusCode",
      "capturedAt=$((Get-Date).ToString('o'))",
      "whitelist=$outFile"
    )
  } else {
    $result = @(
      'probe=FAILED',
      "failure=$failure",
      "auth_http=$authCode",
      "devices_http=$statusCode",
      "capturedAt=$((Get-Date).ToString('o'))"
    )
  }
  $result | Set-Content -Path $resultFile -Encoding UTF8
  $guardianId = ''
  $passwordPlain = ''
  $token = ''
  $auth = $null
  $devices = $null
  $headers = $null
  Remove-Variable guardianId,passwordPlain,token,auth,devices,headers -ErrorAction SilentlyContinue
  Write-Host ''
  Write-Host "probe result: $(if ($failure -eq 'NONE') { 'OK' } else { 'FAILED' })"
  Write-Host "output: $outFile"
  Write-Host 'Credentials were not written or printed. This window can be closed.'
}

