#requires -Version 5.1
<#
.SYNOPSIS
  启动 PC 侧「随身 SOS 镜像服务」（competition/cloud/wearable-mirror）。

.DESCRIPTION
  把公网 4G 随身 SOS（esp32-sos / 随身求助）的状态，镜像成 DAYU200 北向 APP 能显示的
  状态行：deviceId=esp32-sos、room=随身求助、state=ALARM/ACKED/NORMAL、alarm.id、
  gps、lastSeen。数据源与注入通道都可选（见 README 的“运行模式”）。

  默认（当前批准的主路径）：
    数据源 = api   （现有监护人账号只读轮询公网 APP-API；不需要 ECS MQTT 白名单）
    注入   = tcp   （PC 监听 127.0.0.1:9002 + hdc rport → DAYU APP 的候选端口 9002）

  relay 注入（向 homemon 9001 写 `relay <json>`）需要：
    1) bridge 新版本已带 --relay-ignore esp32-sos（否则板端连接会被判“改名”而抖动）；
    2) homemon MAX_CLIENTS 已提高（mirror 占 1 路）。
  在 Lead 确认上述两项已部署后，再用 -Transport relay / both。

.PARAMETER Source
  api | mqtt | auto。mqtt 需要 ECS Broker 白名单加入 mirror clientId（当前未加）。

.PARAMETER Transport
  tcp | relay | both。

.PARAMETER Port
  tcp 通道监听端口 / 设备侧 rport 端口，默认 9002（与 APP 的第三个候选端口一致）。

.EXAMPLE
  .\start-mirror.ps1                         # api + tcp（安全默认）
  .\start-mirror.ps1 -Transport relay        # bridge/homemon 就绪后
  .\start-mirror.ps1 -Source mqtt -Transport both
#>
[CmdletBinding()]
param(
  [ValidateSet('api', 'mqtt', 'auto')][string]$Source = 'api',
  [ValidateSet('tcp', 'relay', 'both')][string]$Transport = 'tcp',
  [string]$Target = '',
  # relay 注入目标。默认 127.0.0.1:9001（hdc fport → 板端 homemon）；
  # 板端 homemon 在局域网可达时建议直连（例如 10.127.130.250:9000），
  # 避免 hdc fport 单路转发与健康探测抢占导致 relay 反复断开。
  [string]$RelayTo = '127.0.0.1:9001',
  [int]$Port = 9002,
  [string]$Hdc = 'D:\OpenHarmony\tools\hdc\hdc.exe',
  [string]$RuntimeDir = '',
  [string]$EnvFile = '',
  [string]$GuardianFile = '',
  [string]$Node = 'node',
  [int]$HeartbeatMs = 5000,
  [int]$PollMs = 3000,
  [string]$ApiBase = 'https://api.luxunacc.xyz',
  [switch]$NoRport
)

$ErrorActionPreference = 'Stop'
$mirrorDir = Split-Path -Parent $PSScriptRoot
if ($RuntimeDir -eq '') { $RuntimeDir = Join-Path $mirrorDir 'runtime' }
New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
$logFile = Join-Path $RuntimeDir 'mirror.log'
$errFile = Join-Path $RuntimeDir 'mirror.err.log'
$pidFile = Join-Path $RuntimeDir 'mirror.pid'
$lockFile = Join-Path $RuntimeDir 'mirror.lock'

function Write-Step([string]$text) { Write-Host "[start-mirror] $text" -ForegroundColor Cyan }
function Write-Warn2([string]$text) { Write-Host "[start-mirror] $text" -ForegroundColor Yellow }
function Write-Err2([string]$text) { Write-Host "[start-mirror] $text" -ForegroundColor Red }

# ---- 单实例：现有进程仍活着则拒绝 ----
if ((Test-Path $pidFile)) {
  $oldPid = 0
  [int]::TryParse((Get-Content -LiteralPath $pidFile -Raw).Trim(), [ref]$oldPid) | Out-Null
  if ($oldPid -gt 0) {
    $proc = Get-Process -Id $oldPid -ErrorAction SilentlyContinue
    if ($proc -ne $null -and $proc.ProcessName -match '^node') {
      Write-Err2 "镜像已在运行（pid=$oldPid）。先执行 .\stop-mirror.ps1"
      exit 3
    }
  }
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
}
if ((Test-Path $lockFile)) {
  try {
    $lock = Get-Content -LiteralPath $lockFile -Raw | ConvertFrom-Json
    $alive = Get-Process -Id ([int]$lock.pid) -ErrorAction SilentlyContinue
    if ($alive -ne $null) {
      Write-Err2 "单实例锁被 pid=$($lock.pid) 持有。先执行 .\stop-mirror.ps1"
      exit 3
    }
  } catch { }
  Write-Warn2 '清理崩溃残留的单实例锁'
  Remove-Item -LiteralPath $lockFile -Force -ErrorAction SilentlyContinue
}

# ---- 依赖检查 ----
$nodeCmd = Get-Command $Node -ErrorAction SilentlyContinue
if ($nodeCmd -eq $null) { Write-Err2 "找不到 Node（$Node）"; exit 2 }
Write-Step ("node = " + $nodeCmd.Source)

$hdcExe = $Hdc
if (-not (Test-Path $hdcExe)) { Write-Warn2 "hdc 不存在（$hdcExe）；relay/tcp 的端口转发需手工准备" }
if ($Target -eq '' -and (Test-Path $hdcExe)) {
  $targets = & $hdcExe list targets 2>$null
  $Target = ($targets | Where-Object { $_ -match '^\d{8,}$' } | Select-Object -First 1)
}
if ($Target -ne '') { Write-Step "DAYU target = $Target" } else { Write-Warn2 '未指定/未发现 DAYU target，跳过 hdc 端口准备' }

function Test-LocalPort([int]$p) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $iar = $client.BeginConnect('127.0.0.1', $p, $null, $null)
    if (-not $iar.AsyncWaitHandle.WaitOne(500)) { return $false }
    $client.EndConnect($iar)
    return $true
  } catch { return $false } finally { $client.Close() }
}

# ---- 注入通道的端口准备 ----
$usesRelay = ($Transport -eq 'relay' -or $Transport -eq 'both')
$usesTcp = ($Transport -eq 'tcp' -or $Transport -eq 'both')

if ($usesRelay) {
  $relayHost, $relayPort = ($RelayTo -split ':', 2)
  $relayPortNum = 9001
  [void][int]::TryParse([string]$relayPort, [ref]$relayPortNum)
  $relayOk = $false
  try {
    $rc = New-Object System.Net.Sockets.TcpClient
    $iar = $rc.BeginConnect($relayHost, $relayPortNum, $null, $null)
    if ($iar.AsyncWaitHandle.WaitOne(600)) { $rc.EndConnect($iar); $relayOk = $true }
    $rc.Close()
  } catch { $relayOk = $false }
  if (-not $relayOk) {
    Write-Err2 ("relay 目标 $RelayTo 不可达：本机模式需 hdc fport tcp:9001 tcp:9000；直连模式需 DAYU 局域网可达 9000；relay 注入不能启动")
    exit 4
  }
  Write-Step "relay 目标 $RelayTo 可达"
  Write-Warn2 'relay 模式要求 bridge 新版本带 --relay-ignore esp32-sos，且 homemon MAX_CLIENTS>=8；未确认前不要对现网注入'
}

if ($usesTcp -and -not $NoRport) {
  if (-not (Test-Path $hdcExe) -or $Target -eq '') {
    Write-Warn2 '缺少 hdc/target，无法自动建立 rport；请手工执行: hdc -t <target> rport tcp:' + $Port + ' tcp:' + $Port
  } else {
    $fports = (& $hdcExe fport ls 2>$null) -join "`n"
    $pattern = 'tcp:' + $Port + '\s+tcp:' + $Port
    if ($fports -match $pattern -and $fports -match ('(?m)' + $pattern + '.*\[Reverse\]')) {
      Write-Step ("hdc rport tcp:$Port 已存在")
    } else {
      Write-Step ("建立 hdc rport tcp:$Port tcp:$Port（设备侧监听 → PC 镜像）")
      & $hdcExe -t $Target rport ("tcp:$Port") ("tcp:$Port") | Out-Null
    }
    Start-Sleep -Milliseconds 300
    $fports2 = (& $hdcExe fport ls 2>$null) -join "`n"
    if ($fports2 -notmatch ($pattern + '.*\[Reverse\]')) {
      Write-Warn2 "rport 未确认建立；APP 可能连不到镜像。可手工检查: hdc -t $Target fport ls"
    }
  }
}

# ---- 组装参数并启动 ----
$nodeArgs = @(
  (Join-Path $mirrorDir 'server.js'),
  '--source', $Source,
  '--transport', $Transport,
  '--relay-to', $RelayTo,
  '--listen-port', [string]$Port,
  '--runtime-dir', $RuntimeDir,
  '--heartbeat-ms', [string]$HeartbeatMs,
  '--poll-ms', [string]$PollMs,
  '--api-base', $ApiBase
)
if ($EnvFile -ne '') { $nodeArgs += @('--env-file', $EnvFile) }
if ($GuardianFile -ne '') { $nodeArgs += @('--guardian-file', $GuardianFile) }

Add-Content -LiteralPath $logFile -Value ("`n==== start $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') source=$Source transport=$Transport ====") -Encoding UTF8
$proc = Start-Process -FilePath $nodeCmd.Source -ArgumentList $nodeArgs -WorkingDirectory $mirrorDir `
  -RedirectStandardOutput $logFile -RedirectStandardError $errFile -PassThru -WindowStyle Hidden
$proc.Id | Set-Content -LiteralPath $pidFile -Encoding ASCII
Write-Step ("已启动 pid=$($proc.Id)，日志: $logFile")

Start-Sleep -Seconds 2
$alive = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
if ($alive -eq $null) {
  Write-Err2 '进程已退出，查看错误日志：'
  if (Test-Path $errFile) { Get-Content -LiteralPath $errFile -Tail 20 }
  exit 5
}
$statusFile = Join-Path $RuntimeDir 'mirror-status.json'
if (Test-Path $statusFile) {
  try {
    $sf = Get-Content -LiteralPath $statusFile -Raw | ConvertFrom-Json
    Write-Step ("运行中：source=$($sf.source) hasData=$($sf.hasData) phase=$($sf.phase) online=$($sf.online) emitCount=$($sf.emitCount)")
  } catch { }
} else {
  Write-Warn2 "状态文件尚未生成（$statusFile）；稍后重试"
}
Write-Step '完成。停止: .\stop-mirror.ps1    查看: Get-Content ' + $statusFile
