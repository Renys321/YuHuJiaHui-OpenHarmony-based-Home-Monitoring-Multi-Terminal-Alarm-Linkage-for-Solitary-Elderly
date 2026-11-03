#!/usr/bin/env pwsh
# 无线化（拔 USB）验收时间线采集器：每 5 秒记录一次真实运行状态。
# 只读：登录生产后端 GET /devices、MQTT 不需要、ping DAYU、netstat、hdc list/fport。
# 凭据从 .secrets/app_guardian.txt 读取，不打印/不落盘。
$ErrorActionPreference = 'Continue'
$root = 'D:\OpenHarmony\competition\evidence\2026-10-27-wireless-without-usb'
$outDir = Join-Path $root 'timeline'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$outFile = Join-Path $outDir 'wireless-unplug-timeline.jsonl'
$hdc = 'D:\OpenHarmony\tools\hdc\hdc.exe'

$secretPath = 'D:\OpenHarmony\competition\.secrets\app_guardian.txt'
$lines = (Get-Content $secretPath -Raw) -split "`r?`n" | Where-Object { $_.Trim().Length -gt 0 }
$loginBody = @{ guardianId = $lines[0].Trim(); password = $lines[1].Trim() } | ConvertTo-Json -Compress
$token = $null
function Get-Token {
  try {
    $r = Invoke-RestMethod -Uri 'https://api.luxunacc.xyz/api/v1/auth/app' -Method POST -ContentType 'application/json' -Body $loginBody -TimeoutSec 15
    return $r.sessionToken
  } catch { return $null }
}
$token = Get-Token

function Now-Ms { return [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }

while ($true) {
  $ts = Now-Ms
  $rec = [ordered]@{ ts = $ts; iso = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss') }
  # 后端设备新鲜度
  try {
    if (-not $token) { $token = Get-Token }
    $headers = @{ Authorization = "Bearer $token" }
    $dev = Invoke-RestMethod -Uri 'https://api.luxunacc.xyz/api/v1/devices' -Headers $headers -TimeoutSec 12
    $map = [ordered]@{}
    foreach ($d in $dev.devices) {
      if ($d.deviceId -in @('esp32-kitchen','esp32-bath','dayu200-living','esp32-sos')) {
        $age = if ($d.lastSeenTs) { [math]::Round(($ts - $d.lastSeenTs) / 1000, 1) } else { -1 }
        $map[$d.deviceId] = [ordered]@{ online = $d.online; state = $d.state; lastSeenTs = $d.lastSeenTs; ageSec = $age }
      }
    }
    $rec.backend = $map
  } catch { $rec.backend = @{ error = 'fetch_failed'; token = ($null -ne $token) } }
  # bridge 入站连接
  try {
    $conns = Get-NetTCPConnection -LocalPort 9101 -ErrorAction SilentlyContinue | Where-Object { $_.State -eq 'Established' } | ForEach-Object { $_.RemoteAddress + ':' + $_.RemotePort }
    $rec.bridgeInbound = @($conns)
  } catch { $rec.bridgeInbound = @() }
  # DAYU 网络可达性（Wi-Fi）
  try { $rec.dayuPing = Test-Connection -ComputerName '10.127.130.131' -Count 1 -Quiet -ErrorAction SilentlyContinue } catch { $rec.dayuPing = $false }
  try { $rec.dayuHomemonTcp = (Test-NetConnection -ComputerName '10.127.130.131' -Port 9000 -InformationLevel Quiet -WarningAction SilentlyContinue) } catch { $rec.dayuHomemonTcp = $false }
  # hdc / fport / COM
  try { $rec.hdcTargets = @(& $hdc list targets 2>&1) } catch { $rec.hdcTargets = @() }
  try { $rec.comPorts = @(Get-CimInstance Win32_SerialPort -ErrorAction SilentlyContinue | Where-Object { $_.DeviceID -match '^COM\d+$' } | ForEach-Object { $_.DeviceID + '=' + $_.Description }) } catch { $rec.comPorts = @() }
  try {
    $fp = & $hdc -t 450100445634303332012847942eca00 fport ls 2>&1
    $rec.fports = @($fp | Where-Object { $_ -match 'tcp:' })
  } catch { $rec.fports = @() }
  Add-Content -LiteralPath $outFile -Value ($rec | ConvertTo-Json -Compress -Depth 6) -Encoding UTF8
  Start-Sleep -Seconds 5
}
