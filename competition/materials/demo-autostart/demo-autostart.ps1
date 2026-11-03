param(
  [string]$Target = '450100445634303332012847942eca00',
  [switch]$NoP0Launch
)

$ErrorActionPreference = 'Stop'
$Root = 'D:\OpenHarmony\competition'
$Hdc = 'D:\DevEcoStudio\DevEco Studio\sdk\default\openharmony\toolchains\hdc.exe'
$P0Cmd = Join-Path $Root 'materials\start-demo-supervisor.cmd'
$P0Lock = Join-Path $Root 'bridge\_test\current-runtime\supervisor\public-sync-supervisor.lock'
$P0State = Join-Path $Root 'bridge\_test\current-runtime\supervisor\public-sync-supervisor.state.json'
$DemoRoot = $PSScriptRoot
$LocalDayu = Join-Path $DemoRoot 'dayu'
$Runtime = Join-Path $Root 'evidence\2026-10-26-demo-autostart\runtime'
$StateFile = Join-Path $Runtime 'watcher-state.json'
$LogFile = Join-Path $Runtime 'demo-autostart.log'
$StopFlag = Join-Path $Runtime 'user-stop.flag'
$DeviceDir = '/data/local/tmp/dayu-demo-autostart-2026-10-26'
$DeviceEvents = "$DeviceDir/evidence/demo-events.jsonl"

New-Item -ItemType Directory -Path $Runtime -Force | Out-Null
$script:userStop = Test-Path $StopFlag
$script:userPaused = $false
$script:lastHdcRepair = [datetime]::MinValue
$script:lastP0Launch = [datetime]::MinValue
$script:lastP0Reason = ''
$script:lastP0HealthReason = ''
$script:p0LaunchAttempts = 0
$script:p0LaunchWindowStart = [datetime]::MinValue
$script:lastAppStart = [datetime]::MinValue
$script:lastEventCount = -1
$script:lastEventAt = [datetime]::MinValue
$script:lastStatusPrint = [datetime]::MinValue
$script:lastUiAt = [datetime]::MinValue
$script:lastNodesAt = [datetime]::MinValue
$script:lastInferenceStart = [datetime]::MinValue
$script:lastHomemonStart = [datetime]::MinValue
$script:lastUi = $null

$mutex = New-Object System.Threading.Mutex($false, 'Global\DayuDemoAutostart20261026')
if (-not $mutex.WaitOne(0)) {
  Write-Host 'An existing demo-autostart watcher is running. Reusing it; this window will close.' -ForegroundColor Yellow
  Start-Sleep -Seconds 6
  exit 0
}

function Write-Log([string]$Message) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
  Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8
}

function Test-Tcp([int]$Port) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $ar = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
    if (-not $ar.AsyncWaitHandle.WaitOne(350)) { return $false }
    $client.EndConnect($ar)
    return $true
  } catch { return $false } finally { $client.Dispose() }
}

function Invoke-Hdc([string[]]$Arguments) {
  try { return @(& $Hdc @Arguments 2>&1) } catch { return @($_.Exception.Message) }
}

function Invoke-HdcTimed([string[]]$Arguments, [int]$TimeoutMs = 8000) {
  $tag = [guid]::NewGuid().ToString('N')
  $out = Join-Path $Runtime ("hdc-$tag.out")
  $err = Join-Path $Runtime ("hdc-$tag.err")
  try {
    $p = Start-Process -FilePath $Hdc -ArgumentList $Arguments -NoNewWindow -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
    if (-not $p.WaitForExit($TimeoutMs)) {
      try { $p.Kill() } catch { }
      return @('__HDC_TIMEOUT__')
    }
    $res = @()
    if (Test-Path $out) { $res += @(Get-Content -LiteralPath $out) }
    if (Test-Path $err) { $res += @(Get-Content -LiteralPath $err) }
    return $res
  } catch {
    return @("__HDC_ERROR__ " + $_.Exception.Message)
  } finally {
    Remove-Item -LiteralPath $out,$err -Force -ErrorAction SilentlyContinue
  }
}

function Get-TargetConnected {
  $lines = @(Invoke-Hdc @('list','targets','-v'))
  foreach ($line in $lines) {
    if ($line -match [regex]::Escape($Target) -and $line -match 'USB\s+Connected') { return $true }
  }
  return $false
}

function Ensure-Hdc {
  if (Get-TargetConnected) { return $true }
  $now = Get-Date
  if (($now - $script:lastHdcRepair).TotalSeconds -ge 30) {
    $script:lastHdcRepair = $now
    Write-Log 'HDC target not connected; restarting hdc server once (no unknown process kill).'
    Write-Host '[WAIT] HDC target offline; restarting hdc server once...' -ForegroundColor Yellow
    Invoke-Hdc @('kill') | Out-Null
    Start-Sleep -Seconds 1
    Invoke-Hdc @('start') | Out-Null
    Start-Sleep -Seconds 3
  }
  return (Get-TargetConnected)
}

function Get-DayuShell([string]$Command) {
  return @(Invoke-Hdc @('-t',$Target,'shell',$Command))
}

function Test-PidAlive([int]$ProcessId) {
  if ($ProcessId -le 0) { return $false }
  try {
    $p = Get-Process -Id $ProcessId -ErrorAction Stop
    return -not $p.HasExited
  } catch { return $false }
}

function Read-P0State {
  if (-not (Test-Path $P0State)) { return $null }
  try { return (Get-Content -LiteralPath $P0State -Raw | ConvertFrom-Json) } catch { return $null }
}

function Read-P0LockPid {
  if (-not (Test-Path $P0Lock)) { return 0 }
  try {
    $v = 0
    if ([int]::TryParse((Get-Content -LiteralPath $P0Lock -Raw).Trim(), [ref]$v)) { return $v }
    return 0
  } catch { return 0 }
}

# P0 = Broker + Bridge + public-sync supervisor/worker。
# 2026-10-27 事故：supervisor/worker 在 16:25 一起被杀，但 state.json 一直停在
# 16:24 的 HEALTHY、lock 里也是死 PID。旧实现只看文件里的字符串，于是 P0 被永久
# 判成 healthy，监视器从不拉起，手机端数据停在旧值。现在必须同时满足：
#   端口在监听 + supervisor PID 存活 + worker PID 存活 + 状态 HEALTHY + heartbeat 新鲜。
function Get-P0Health {
  $ports = (Test-Tcp 1883) -and (Test-Tcp 9101)
  $state = Read-P0State
  $lockPid = Read-P0LockPid
  $statePid = 0
  $workerPid = 0
  $stateName = 'MISSING'
  $heartbeatAgeSec = -1
  if ($state) {
    if ($null -ne $state.supervisorPid) { $statePid = [int]$state.supervisorPid }
    if ($null -ne $state.workerPid) { $workerPid = [int]$state.workerPid }
    if ($state.state) { $stateName = [string]$state.state }
    if ($null -ne $state.heartbeatAt -and [long]$state.heartbeatAt -gt 0) {
      $hb = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$state.heartbeatAt)
      $heartbeatAgeSec = [int][math]::Round(((Get-Date).ToUniversalTime() - $hb.UtcDateTime).TotalSeconds)
    }
  }
  $supervisorPid = if ($lockPid -gt 0) { $lockPid } else { $statePid }
  $supervisorAlive = Test-PidAlive $supervisorPid
  $workerAlive = Test-PidAlive $workerPid
  $heartbeatFresh = ($heartbeatAgeSec -ge 0 -and $heartbeatAgeSec -le 90)
  $stateOk = ($stateName -eq 'HEALTHY' -and $heartbeatFresh)
  $healthy = $ports -and $supervisorAlive -and $workerAlive -and $stateOk
  $reason = 'HEALTHY'
  if (-not $healthy) {
    if (-not $ports) { $reason = 'PORTS_DOWN' }
    elseif ($lockPid -gt 0 -and -not $supervisorAlive) { $reason = 'STALE_LOCK' }
    elseif (-not $supervisorAlive) { $reason = 'SUPERVISOR_DEAD' }
    elseif (-not $workerAlive) { $reason = 'WORKER_DEAD' }
    elseif ($stateName -eq 'CIRCUIT_OPEN') { $reason = 'CIRCUIT_OPEN' }
    elseif ($stateName -ne 'HEALTHY') { $reason = "STATE_$stateName" }
    elseif (-not $heartbeatFresh) { $reason = 'STALE_HEARTBEAT' }
  }
  return [pscustomobject]@{
    Healthy = $healthy; Reason = $reason; Ports = $ports; State = $stateOk
    StateName = $stateName; SupervisorPid = $supervisorPid; SupervisorAlive = $supervisorAlive
    WorkerPid = $workerPid; WorkerAlive = $workerAlive; LockPid = $lockPid
    HeartbeatAgeSec = $heartbeatAgeSec
  }
}

function Ensure-P0 {
  $h = Get-P0Health
  if ($h.Healthy) { return $true }
  if ($NoP0Launch) { return $false }
  # 只有"活着的"锁才阻止拉起。陈旧锁（PID 已退出）必须允许 P0 入口重新接管；
  # 否则一个死 PID 的锁文件会把自动拉起永久卡死（2026-10-27 事故的直接原因之一）。
  $liveLock = ($h.LockPid -gt 0) -and (Test-PidAlive $h.LockPid)
  if ($liveLock) {
    $tag = 'live-lock:' + $h.Reason
    if ($script:lastP0Reason -ne $tag) {
      $script:lastP0Reason = $tag
      Write-Log ("P0 不健康（{0}）但 supervisor 进程仍存活 PID={1}；不重复拉起，等待其自身重启/熔断恢复" -f $h.Reason, $h.LockPid)
    }
    return $false
  }
  if ($h.LockPid -gt 0 -and -not (Test-PidAlive $h.LockPid)) {
    if ($script:lastP0Reason -ne 'stale-lock') {
      $script:lastP0Reason = 'stale-lock'
      Write-Log ("检测到 STALE supervisor lock PID={0}（进程已退出）、陈旧 state={1}；允许重新拉起 P0 入口（INGEST_KEY 需由用户在该可见窗口输入）" -f $h.LockPid, $h.StateName)
    }
  }
  $now = Get-Date
  if ($script:p0LaunchWindowStart -eq [datetime]::MinValue -or (($now - $script:p0LaunchWindowStart).TotalMinutes -ge 30)) {
    $script:p0LaunchWindowStart = $now
    $script:p0LaunchAttempts = 0
  }
  if ($script:p0LaunchAttempts -ge 6) {
    if ($script:lastP0Reason -ne 'launch-capped') {
      $script:lastP0Reason = 'launch-capped'
      Write-Log 'P0 入口 30 分钟内已尝试拉起 6 次仍未恢复；为避免反复弹窗暂停自动拉起，请人工运行 start-demo-supervisor.cmd'
    }
    return $false
  }
  if (($now - $script:lastP0Launch).TotalSeconds -lt 60) { return $false }
  $script:lastP0Launch = $now
  $script:p0LaunchAttempts += 1
  Write-Log ("P0 不健康（reason={0} state={1} heartbeatAgeSec={2} supervisorAlive={3} workerAlive={4}）；拉起既有正式 P0 入口（key 由用户在该可见窗口输入，本脚本从不读取）" -f $h.Reason, $h.StateName, $h.HeartbeatAgeSec, $h.SupervisorAlive, $h.WorkerAlive)
  Write-Host '[WAIT] P0 entry is opening. Enter INGEST_KEY only in that visible window.' -ForegroundColor Yellow
  try {
    Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', ('"'+$P0Cmd+'"') -WorkingDirectory (Split-Path -Parent $P0Cmd) | Out-Null
  } catch { Write-Log "P0 launch failed: $($_.Exception.Message)" }
  return $false
}

function Get-HomemonRunning {
  $lines = @(Get-DayuShell 'pidof homemon')
  foreach ($token in (($lines -join ' ') -split '\s+')) {
    if ($token -match '^\d+$' -and [int]$token -gt 0) { return $true }
  }
  return $false
}

function Ensure-Homemon {
  if (Get-HomemonRunning) { return $true }
  $now = Get-Date
  if (($now - $script:lastHomemonStart).TotalSeconds -lt 15) { return $false }
  $script:lastHomemonStart = $now
  Write-Host '[WAIT] DAYU homemon not running; starting frozen homemon.' -ForegroundColor Yellow
  Write-Log 'Starting frozen DAYU homemon.'
  Get-DayuShell 'cd /data/homemon && (./homemon homemon.conf > homemon.stdout 2>&1 &)' | Out-Null
  Start-Sleep -Seconds 2
  return (Get-HomemonRunning)
}

function Ensure-Fport {
  $text = (Invoke-Hdc @('fport','ls')) -join "`n"
  if ($text -match 'tcp:9001\s+(?:->\s+)?tcp:9000') { return (Test-Tcp 9001) }
  Write-Host '[WAIT] restoring hdc fport tcp:9001 -> tcp:9000.' -ForegroundColor Yellow
  Write-Log 'Restoring hdc fport tcp:9001 -> tcp:9000.'
  Invoke-Hdc @('-t',$Target,'fport','tcp:9001','tcp:9000') | Out-Null
  return (Test-Tcp 9001)
}

function Get-AppPid {
  $lines = @(Get-DayuShell 'pidof com.dsh.eldercare')
  foreach ($token in (($lines -join ' ') -split '\s+')) {
    if ($token -match '^\d+$' -and [int]$token -gt 0) { return [int]$token }
  }
  return 0
}

function Get-AppUi {
  $local = Join-Path $Runtime 'ui-last.json'
  $remote = '/data/local/tmp/demo-autostart-ui.json'
  Invoke-HdcTimed @('-t',$Target,'shell','uitest','dumpLayout','-p',$remote) 12000 | Out-Null
  Invoke-HdcTimed @('-t',$Target,'file','recv',$remote,$local) 12000 | Out-Null
  if (-not (Test-Path $local)) { return $null }
  try {
    $raw = Get-Content -LiteralPath $local -Raw -Encoding UTF8
    $texts = @([regex]::Matches($raw, '"text":"([^"]*)"') | ForEach-Object { $_.Groups[1].Value })
    $joined = $texts -join ' | '
    $nodes = ''
    $m = [regex]::Match($joined, '\u5168\u5c4b\u5728\u7ebf\s*(\d+)/(\d+)\s*\u53f0\u8bbe\u5907')
    if ($m.Success) { $nodes = "$($m.Groups[1].Value)/$($m.Groups[2].Value)" }
    $foreground = ($joined -match '\u5c45\u5bb6\u5b89\u5168\u76d1\u62a4|\u5ba2\u5385\u6444\u50cf\u5934|\u9884\u8b66\u5904\u7f6e|\u7edf\u8ba1\u62a5\u544a')
    $paused = ($joined -match '\u6062\u590d\u76d1\u62a4|\u81ea\u52a8\u76d1\u62a4\u5df2\u6682\u505c')
    $active = ($joined -match '\u6682\u505c\u76d1\u62a4|\u76d1\u62a4\u8fd0\u884c\u4e2d')
    return [pscustomobject]@{ Foreground = $foreground; Paused = $paused; Active = $active; Nodes = $nodes; Text = $joined }
  } catch { return $null }
}

function Ensure-App {
  if ($script:userStop) { return 'stopped' }
  $ui = $script:lastUi
  $now = Get-Date
  $framesFresh = (($now - $script:lastEventAt).TotalSeconds -le 8)
  if (-not $framesFresh -and (($now - $script:lastUiAt).TotalSeconds -ge 15)) {
    $ui = Get-AppUi
    if ($ui) { $script:lastUi = $ui; $script:lastUiAt = $now }
  }

  if ($script:userPaused) {
    if ($ui -and $ui.Paused) { return 'paused' }
    if ($ui -and $ui.Active) { $script:userPaused = $false }
    else { return 'paused' }
  }
  if ($ui -and $ui.Paused) {
    $script:userPaused = $true
    return 'paused'
  }
  $script:userPaused = $false

  $appPid = Get-AppPid
  if ($appPid -eq 0) {
    if (($now - $script:lastAppStart).TotalSeconds -ge 15) {
      Write-Host '[WAIT] formal app not running; starting EntryAbility.' -ForegroundColor Yellow
      Write-Log 'Starting formal app EntryAbility.'
      Get-DayuShell 'aa start -a EntryAbility -b com.dsh.eldercare' | Out-Null
      $script:lastAppStart = $now
    }
    return 'starting'
  }
  if ($ui -and -not $ui.Foreground -and -not $framesFresh) {
    if (($now - $script:lastAppStart).TotalSeconds -ge 20) {
      Write-Host '[WAIT] formal app is backgrounded; bringing it to foreground.' -ForegroundColor Yellow
      Write-Log 'Bringing formal app to foreground.'
      Get-DayuShell 'aa start -a EntryAbility -b com.dsh.eldercare' | Out-Null
      $script:lastAppStart = $now
    }
    return 'foregrounding'
  }
  if ($ui -and $ui.Active) { return 'active' }
  return 'present'
}

function Get-LocalHash([string]$Path) {
  if (-not (Test-Path $Path)) { return '' }
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-DeviceHash([string]$Path) {
  $lines = @(Get-DayuShell "sha256sum $Path 2>/dev/null")
  foreach ($line in $lines) { if ($line -match '^([0-9a-fA-F]{64})\s') { return $Matches[1].ToLowerInvariant() } }
  return ''
}

function Ensure-Deploy {
  $localFiles = @(
    @{ L = (Join-Path $LocalDayu 'dayu_local_fall'); R = "$DeviceDir/dayu_local_fall" },
    @{ L = (Join-Path $LocalDayu 'models\320\model.ncnn.param'); R = "$DeviceDir/models/320/model.ncnn.param" },
    @{ L = (Join-Path $LocalDayu 'models\320\model.ncnn.bin'); R = "$DeviceDir/models/320/model.ncnn.bin" }
  )
  Get-DayuShell "mkdir -p $DeviceDir/models/320 $DeviceDir/evidence" | Out-Null
  $changed = $false
  foreach ($f in $localFiles) {
    if (-not (Test-Path $f.L)) { Write-Log "Local payload missing: $($f.L)"; return $false }
    $lh = Get-LocalHash $f.L
    $rh = Get-DeviceHash $f.R
    if ($lh -ne $rh) {
      Write-Host "[WAIT] deploying $(Split-Path $f.L -Leaf) to DAYU demo dir." -ForegroundColor Yellow
      Write-Log "Deploying $($f.L) -> $($f.R)"
      Invoke-Hdc @('-t',$Target,'file','send',$f.L,$f.R) | Out-Null
      $rh = Get-DeviceHash $f.R
      if ($lh -ne $rh) { Write-Log "Hash mismatch after deploy: $($f.R)"; return $false }
      $changed = $true
    }
  }
  if ($changed) { Get-DayuShell "chmod 755 $DeviceDir/dayu_local_fall" | Out-Null }
  return $true
}

function Get-OwnedProcesses {
  $rows = @()
  $lines = @(Get-DayuShell 'pidof dayu_local_fall')
  foreach ($token in (($lines -join ' ') -split '\s+')) {
    if ($token -notmatch '^\d+$') { continue }
    $procId = [int]$token
    if ($procId -le 0) { continue }
    $exe = (Get-DayuShell "readlink /proc/$procId/exe 2>/dev/null") -join ' '
    if ($exe -match [regex]::Escape("$DeviceDir/dayu_local_fall")) { $rows += $procId }
  }
  return @($rows | Select-Object -Unique)
}

function Get-OtherInferenceProcesses {
  $rows = @()
  $lines = @(Get-DayuShell 'pidof dayu_local_fall')
  foreach ($token in (($lines -join ' ') -split '\s+')) {
    if ($token -notmatch '^\d+$') { continue }
    $procId = [int]$token
    if ($procId -le 0) { continue }
    $exe = (Get-DayuShell "readlink /proc/$procId/exe 2>/dev/null") -join ' '
    if ($exe -and $exe -notmatch [regex]::Escape("$DeviceDir/dayu_local_fall")) { $rows += $procId }
  }
  return @($rows | Select-Object -Unique)
}

function Test-9200Listening {
  $lines = @(Get-DayuShell 'netstat -lntp 2>/dev/null | grep "127.0.0.1:9200"')
  foreach ($line in $lines) { if ($line -match 'LISTEN') { return $true } }
  return $false
}

function Get-EventCount {
  $lines = @(Get-DayuShell "wc -l $DeviceEvents 2>/dev/null")
  foreach ($line in $lines) {
    if ($line -match '^\s*(\d+)') { return [int]$Matches[1] }
  }
  return 0
}

function Stop-OwnedInference {
  $pids = @(Get-OwnedProcesses)
  if ($pids.Count -eq 0) { return }
  $killCmd = 'kill -TERM ' + ($pids -join ' ')
  Invoke-Hdc @('-t',$Target,'shell',$killCmd) | Out-Null
  Write-Log ("Stopped owned inference PIDs: " + ($pids -join ','))
  Start-Sleep -Seconds 2
}

function Start-Inference {
  Write-Host '[WAIT] starting DAYU local P1-B 320 inference (conf=0.7, rotate=0).' -ForegroundColor Yellow
  Write-Log 'Starting DAYU P1-B inference (320, rotate=0, conf=0.7).'
  $script:lastInferenceStart = Get-Date
  $inner = "./dayu_local_fall --serve 127.0.0.1:9200 --duration 86400 --threads 4 --size 320 --rotate 0 --conf 0.7 --param models/320/model.ncnn.param --bin models/320/model.ncnn.bin --events evidence/demo-events.jsonl --stats evidence/demo-stats.jsonl > evidence/demo-server.log 2>&1 < /dev/null"
  $outer = "cd $DeviceDir && setsid sh -c '$inner' < /dev/null > /dev/null 2>&1 & echo SPAWNED"
  $argLine = "-t $Target shell `"$outer`""
  $launcher = Start-Process -FilePath $Hdc -ArgumentList $argLine -WindowStyle Hidden -PassThru
  Start-Sleep -Seconds 2
  if (-not $launcher.HasExited) {
    try { Stop-Process -Id $launcher.Id -Force } catch { }
    Write-Log 'Killed detached hdc launch process after spawn; service runs under setsid.'
  }
  Start-Sleep -Milliseconds 700
  if (Test-9200Listening) { return $true }
  Write-Log 'Inference spawn sent; listener not confirmed yet.'
  return $false
}

function Ensure-Inference {
  if ($script:userStop -or $script:userPaused) {
    Stop-OwnedInference
    return 'stopped'
  }
  if (-not (Ensure-Deploy)) { return 'deploy-wait' }
  $owned = @(Get-OwnedProcesses)
  $other = @(Get-OtherInferenceProcesses)
  if ($other.Count -gt 0) {
    Write-Log ("Unknown inference process already exists; not killing: " + ($other -join ','))
    return 'conflict'
  }
  $listen = Test-9200Listening
  if ($listen -and $owned.Count -gt 0) { return 'running' }
  if ($listen -and $owned.Count -eq 0) {
    Write-Log '9200 is occupied but owner is unknown; not killing.'
    return 'conflict'
  }
  if ($owned.Count -gt 0 -and -not $listen) {
    if (((Get-Date) - $script:lastInferenceStart).TotalSeconds -gt 15) { Stop-OwnedInference }
    else { return 'starting' }
  }
  if (((Get-Date) - $script:lastInferenceStart).TotalSeconds -lt 12) { return 'starting' }
  if (Start-Inference) { return 'running' }
  return 'starting'
}

function Get-StatusObject([string]$P0, [string]$App, [string]$Inf, [string]$Camera, [bool]$TargetOk, [string]$Nodes) {
  return [ordered]@{
    timestamp = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
    target = $Target
    targetConnected = $TargetOk
    p0 = $P0
    p0Reason = $script:lastP0HealthReason
    app = $App
    inference = $Inf
    cameraFrames = $Camera
    nodes = $Nodes
    userStop = $script:userStop
    userPaused = $script:userPaused
    lastEventCount = $script:lastEventCount
    watcherPid = $PID
  }
}

function Print-Status($S) {
  $color = 'Gray'
  if ($S.p0 -ne 'healthy') { $color = 'Yellow' }
  $tgt = 'WAIT'
  if ($S.targetConnected) { $tgt = 'OK' }
  $nodes = '?'
  if ($S.nodes) { $nodes = $S.nodes }
  Write-Host ("[{0}] P0={1} target={2} app={3} detect={4} frames={5} nodes={6} stop={7} paused={8}" -f $S.timestamp,$S.p0,$tgt,$S.app,$S.inference,$S.cameraFrames,$nodes,$S.userStop,$S.userPaused) -ForegroundColor $color
  if ($S.p0 -ne 'healthy' -and $S.p0Reason) {
    Write-Host ("        P0 detail: reason={0}" -f $S.p0Reason) -ForegroundColor Yellow
  }
}

Write-Host '============================================================' -ForegroundColor Cyan
Write-Host ' DAYU demo autostart: P0 + formal camera + DAYU local inference' -ForegroundColor Cyan
Write-Host ' Keep this window open. P0 may open a second visible window for INGEST_KEY.' -ForegroundColor Cyan
Write-Host ' Keys: [S] stop auto care  [R] resume  [Q] quit watcher (leave services)' -ForegroundColor Cyan
Write-Host '============================================================' -ForegroundColor Cyan
Write-Log 'Watcher start.'

try {
  while ($true) {
    $now = Get-Date
    if (Test-Path $StopFlag) {
      if (-not $script:userStop) {
        $script:userStop = $true
        Write-Host '[STOP] stop flag detected; auto start/restart is disabled.' -ForegroundColor Red
        Write-Log 'Stop flag detected.'
      }
    }
    if (-not [Console]::IsInputRedirected -and [Console]::KeyAvailable) {
      $key = [Console]::ReadKey($true).KeyChar.ToString().ToUpperInvariant()
      if ($key -eq 'S') {
        $script:userStop = $true
        Set-Content -LiteralPath $StopFlag -Value (Get-Date -Format o) -Encoding ASCII
        Write-Host '[STOP] user stop flag set; auto start/restart is disabled until R.' -ForegroundColor Red
        Write-Log 'User stop via console.'
      } elseif ($key -eq 'R') {
        $script:userStop = $false
        if (Test-Path $StopFlag) { Remove-Item -LiteralPath $StopFlag -Force }
        Write-Host '[RESUME] stop flag cleared; auto care resumes.' -ForegroundColor Green
        Write-Log 'User resume via console.'
      } elseif ($key -eq 'Q') {
        Write-Host '[QUIT] watcher exits; P0/app/inference are left as-is.' -ForegroundColor Yellow
        Write-Log 'Watcher quit by user; services left running.'
        break
      }
    }

    $p0 = 'waiting'
    $app = 'waiting'
    $inf = 'waiting'
    $camera = 'WAIT'
    $nodes = ''
    $targetOk = $false

    $p0Health = Get-P0Health
    $script:lastP0HealthReason = $p0Health.Reason
    if ($p0Health.Healthy) { $p0 = 'healthy' }
    else {
      $p0 = 'starting'
      Ensure-P0 | Out-Null
      $p0Health = Get-P0Health
      $script:lastP0HealthReason = $p0Health.Reason
      if ($p0Health.Healthy) { $p0 = 'healthy' }
    }

    if (Ensure-Hdc) {
      $targetOk = $true
      $homemon = Ensure-Homemon
      $fport = Ensure-Fport
      if ($homemon -and $fport) {
        $app = Ensure-App
        if ($script:userStop) { $app = 'stopped' }
        if ($script:userPaused) { $app = 'paused' }
        $inf = Ensure-Inference
        $ui = $script:lastUi
        if ($ui -and $ui.Nodes) { $nodes = $ui.Nodes }
        if (($now - $script:lastNodesAt).TotalSeconds -ge 30) {
          $script:lastNodesAt = $now
          $uiNow = Get-AppUi
          if ($uiNow) {
            $script:lastUi = $uiNow
            $script:lastUiAt = $now
            if ($uiNow.Nodes) { $nodes = $uiNow.Nodes }
          }
        }
        $count = Get-EventCount
        if ($count -gt $script:lastEventCount -and $count -ge 0) {
          $script:lastEventCount = $count
          $script:lastEventAt = Get-Date
        }
        if ($inf -eq 'running' -and ((Get-Date) - $script:lastEventAt).TotalSeconds -le 8) { $camera = 'LIVE' }
        elseif ($inf -eq 'running') { $camera = 'WAIT-FRAMES' }
        elseif ($inf -eq 'conflict') { $camera = 'CONFLICT' }
        elseif ($inf -eq 'failed') { $camera = 'ERROR' }
        elseif ($script:userStop -or $script:userPaused) { $camera = 'STOPPED' }
      }
    }

    $status = Get-StatusObject $p0 $app $inf $camera $targetOk $nodes
    $status | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $StateFile -Encoding UTF8
    $now = Get-Date
    if (($now - $script:lastStatusPrint).TotalSeconds -ge 5) {
      Print-Status $status
      $script:lastStatusPrint = $now
    }
    Start-Sleep -Seconds 2
  }
}
finally {
  Write-Log 'Watcher exiting; P0/app/inference left running where possible.'
  try { $mutex.ReleaseMutex() } catch { }
  $mutex.Dispose()
}
