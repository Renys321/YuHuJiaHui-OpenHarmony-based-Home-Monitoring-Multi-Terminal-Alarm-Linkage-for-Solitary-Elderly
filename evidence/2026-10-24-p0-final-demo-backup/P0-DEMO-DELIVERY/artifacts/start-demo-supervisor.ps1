# public-sync supervisor one-click entry (formal, 2026-10-24 real acceptance).
#
# Visible terminal: validates prerequisites first, then reuses/starts Broker,
# Bridge and DAYU homemon/fport, then runs the public-sync supervisor.
# The supervisor prompts once for the hidden INGEST_KEY.
#
# Modes:
#   start-demo-supervisor.ps1              -> full start
#   start-demo-supervisor.ps1 -Preflight   -> read-only checks, starts nothing
#   start-demo-supervisor.ps1 -Target <id> -> explicit HDC target
#
# Safety:
#   - Never reads, prints, stores or logs INGEST_KEY (the supervisor owns it).
#   - Never flashes or writes ESP32 boards, never touches COM5/COM14/COM8.
#   - Never overwrites DAYU homemon: hash must match the frozen original.
#   - Never starts a second supervisor while a live lock exists.
param(
    [switch]$Preflight,
    [string]$Target
)

$ErrorActionPreference = 'Stop'

$Root = 'D:\OpenHarmony\competition'
$Node = 'D:\Node\node.exe'
$Hdc = 'D:\DevEcoStudio\DevEco Studio\sdk\default\openharmony\toolchains\hdc.exe'
$DefaultDayuTarget = '450100445634303332012847942eca00'
$Supervisor = Join-Path $Root 'cloud\onenet\public-sync-supervisor.js'
$Worker = Join-Path $Root 'cloud\onenet\public-sync-worker.js'
$PublicSync = Join-Path $Root 'cloud\onenet\public-sync.js'
$BrokerJs = Join-Path $Root 'bridge\mqtt_broker.js'
$BridgeJs = Join-Path $Root 'bridge\mqtt_bridge.js'
$TimeSyncJs = Join-Path $Root 'southbound\dayu-time-sync.js'
$RuntimeDir = 'D:\OpenHarmony\competition\bridge\_test\current-runtime\supervisor'
$State = Join-Path $RuntimeDir 'public-sync-supervisor.state.json'
$Lock = Join-Path $RuntimeDir 'public-sync-supervisor.lock'
$Log = Join-Path $RuntimeDir 'public-sync-supervisor.log'
$HomemonSha = '0d243539403de89c547defacf43c86a4980142ef8ec686b277be7133c42881e6'

$script:Problems = New-Object System.Collections.Generic.List[string]
$script:Warnings = New-Object System.Collections.Generic.List[string]

function Write-Step([string]$Message) { Write-Host "[check] $Message" -ForegroundColor Cyan }
function Write-Ok([string]$Message) { Write-Host "[ok]    $Message" -ForegroundColor Green }
function Write-Bad([string]$Message) {
    Write-Host "[BAD]   $Message" -ForegroundColor Red
    $script:Problems.Add($Message) | Out-Null
}
function Write-Warn([string]$Message) {
    Write-Host "[warn]  $Message" -ForegroundColor Yellow
    $script:Warnings.Add($Message) | Out-Null
}

function Test-TcpPort([string]$HostName, [int]$Port, [int]$TimeoutMs = 400) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $async = $client.BeginConnect($HostName, $Port, $null, $null)
        if (-not $async.AsyncWaitHandle.WaitOne($TimeoutMs)) { return $false }
        $client.EndConnect($async)
        return $true
    } catch {
        return $false
    } finally {
        $client.Dispose()
    }
}

function Invoke-DayuShell([string]$DayuTarget, [string]$Command) {
    $output = & $Hdc -t $DayuTarget shell $Command 2>&1
    if ($LASTEXITCODE -ne 0) { throw "DAYU shell 失败: $($output -join ' ')" }
    return @($output)
}

function Resolve-DayuTarget() {
    if ($Target) { return $Target }
    $lines = @(& $Hdc list targets -v 2>&1)
    $ids = @()
    foreach ($line in $lines) {
        if ($line -match '(?i)([0-9a-f]{32}).*USB.*Connected') { $ids += $Matches[1] }
    }
    $ids = @($ids | Select-Object -Unique)
    if ($ids.Count -eq 1) { return $ids[0] }
    if ($ids.Count -gt 1) {
        throw "发现多个 USB DAYU 目标：$($ids -join ', ')；请用 -Target 明确指定"
    }
    $plain = @(& $Hdc list targets 2>&1)
    if ($plain -contains $DefaultDayuTarget) { return $DefaultDayuTarget }
    throw '没有找到 USB Connected 的 DAYU200（hdc list targets 为空）；不能用品口 UART 目标代替。请检查 DAYU 电源/HDC USB 线。'
}

function Get-HomemonStatus([string]$DayuTarget) {
    # Run short commands separately and parse on the Windows side. A single
    # "ps -ef | grep '[h]omemon'" would match the "sh -c ..." wrapper of the
    # command itself, producing both false "running" and false "MISSING".
    $hashLines = Invoke-DayuShell $DayuTarget 'sha256sum /data/homemon/homemon 2>/dev/null || echo SHA_MISSING'
    $sha = ''
    foreach ($line in $hashLines) {
        if ($line -match '([0-9a-fA-F]{64})') { $sha = $Matches[1].ToLowerInvariant(); break }
    }
    $psLines = Invoke-DayuShell $DayuTarget 'ps -ef'
    $running = @($psLines | Where-Object { $_ -match 'homemon' -and $_ -notmatch 'sh -c' }).Count -gt 0
    $netLines = Invoke-DayuShell $DayuTarget 'netstat -lntp'
    $listening = @($netLines | Where-Object { $_ -match ':9000\b' }).Count -gt 0
    return [pscustomobject]@{ Sha = $sha; Running = $running; Listening = $listening }
}

$script:JsonState = $null
function Read-SupervisorState() {
    if (-not (Test-Path $State)) { return $null }
    try { return (Get-Content -LiteralPath $State -Raw | ConvertFrom-Json) } catch { return $null }
}

# ---------------------------------------------------------------------------
# Phase 1: read-only preflight. Nothing is started or modified here.
# ---------------------------------------------------------------------------
Write-Host '=== public-sync supervisor 一键入口：只读预检 ===' -ForegroundColor Cyan

$requiredFiles = @(
    @{ Name = 'Node';        Path = $Node },
    @{ Name = 'hdc';         Path = $Hdc },
    @{ Name = 'supervisor';  Path = $Supervisor },
    @{ Name = 'worker';      Path = $Worker },
    @{ Name = 'public-sync'; Path = $PublicSync },
    @{ Name = 'broker';      Path = $BrokerJs },
    @{ Name = 'bridge';      Path = $BridgeJs }
)
foreach ($item in $requiredFiles) {
    if (Test-Path $item.Path) { Write-Ok "$($item.Name) 存在" }
    else { Write-Bad "缺少 $($item.Name): $($item.Path)" }
}

$brokerListening = Test-TcpPort '127.0.0.1' 1883
$bridgeListening = Test-TcpPort '127.0.0.1' 9101
Write-Host "[info]  端口 1883 listening=$brokerListening ; 9101 listening=$bridgeListening"

$supervisorLive = $false
if (Test-Path $Lock) {
    $oldPid = 0
    try { $oldPid = [int](Get-Content -LiteralPath $Lock -Raw).Trim() } catch { $oldPid = 0 }
    if ($oldPid -gt 0) {
        $oldProcess = Get-Process -Id $oldPid -ErrorAction SilentlyContinue
        if ($oldProcess) {
            $supervisorLive = $true
            $stateText = 'unknown'
            $stateObj = Read-SupervisorState
            if ($stateObj) { $stateText = $stateObj.state }
            Write-Ok "supervisor 已在运行 PID=$oldPid state=$stateText"
        } else {
            Write-Warn "发现 stale lock PID=$oldPid（进程已不存在），启动阶段会接管"
        }
    }
} else {
    Write-Host '[info]  尚无 supervisor 运行锁'
}

if (-not $supervisorLive) {
    # Cross-entry guard: refuse to add a second public-sync worker even when the
    # other entry (candidate/legacy) uses a different runtime lock path.
    $nodeProcs = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine })
    $externalSupervisors = @($nodeProcs | Where-Object { $_.CommandLine -match 'public-sync-supervisor\.js' })
    $orphanWorkers = @($nodeProcs | Where-Object {
            $_.CommandLine -match 'public-sync-worker\.js' -and
            $_.CommandLine -notmatch 'public-sync-supervisor\.js' })
    if ($externalSupervisors.Count -gt 0) {
        $supervisorLive = $true
        Write-Ok "已有 public-sync supervisor 进程 PID=$($externalSupervisors.ProcessId -join ',')；本入口拒绝启动第二个实例"
    } elseif ($orphanWorkers.Count -gt 0) {
        Write-Bad "发现没有 supervisor 的孤立 worker PID=$($orphanWorkers.ProcessId -join ',')；请先人工清理后再启动"
    }
}

$dayuTarget = $null
try {
    $dayuTarget = Resolve-DayuTarget
    Write-Ok "DAYU HDC target=$dayuTarget"
} catch {
    Write-Bad $_.Exception.Message
}

$homemonRunning = $false
$fportPresent = $false
if ($dayuTarget) {
    try {
        $homemonStatus = Get-HomemonStatus $dayuTarget
        if (-not $homemonStatus.Sha) {
            Write-Bad 'DAYU /data/homemon/homemon 缺失或不可读；一键入口不会上传或替换二进制'
        } elseif ($homemonStatus.Sha -ne $HomemonSha) {
            Write-Bad "DAYU homemon 哈希不是冻结原版 $HomemonSha；拒绝继续"
        } else {
            Write-Ok 'DAYU homemon 哈希匹配冻结原版'
        }
        if ($homemonStatus.Running) {
            $homemonRunning = $true
            Write-Ok 'DAYU homemon 正在运行'
        } else {
            Write-Warn 'DAYU homemon 未运行，启动阶段会启动原版'
        }
        if ($homemonStatus.Listening) { Write-Ok 'DAYU 9000 已监听' }
        else { Write-Warn 'DAYU 9000 尚未监听' }

        $fportText = (@(& $Hdc fport ls 2>&1) -join "`n")
        if ($fportText -match 'tcp:9001\s+(?:->\s+)?tcp:9000') {
            $fportPresent = $true
            Write-Ok 'hdc fport tcp:9001 -> tcp:9000 已存在'
        } else {
            Write-Warn 'hdc fport tcp:9001 -> tcp:9000 未建立，启动阶段会创建'
        }
    } catch {
        Write-Bad "DAYU 检查失败: $($_.Exception.Message)"
    }
}

Write-Host ''
if ($script:Problems.Count -gt 0) {
    Write-Host '=== PREFLIGHT BLOCKED：未启动任何服务 ===' -ForegroundColor Red
    foreach ($p in $script:Problems) { Write-Host "  - $p" -ForegroundColor Red }
    foreach ($w in $script:Warnings) { Write-Host "  - (warn) $w" -ForegroundColor Yellow }
    Write-Host ''
    Write-Host '请先修复上述现场条件，再次运行本入口。' -ForegroundColor Yellow
    exit 2
}
if ($Preflight) {
    Write-Host '=== PREFLIGHT PASS（只读模式，未启动任何服务）===' -ForegroundColor Green
    foreach ($w in $script:Warnings) { Write-Host "  - (warn) $w" -ForegroundColor Yellow }
    exit 0
}

# ---------------------------------------------------------------------------
# Phase 2: start / reuse the chain, then run exactly one supervisor.
# ---------------------------------------------------------------------------
if ($supervisorLive) {
    Write-Host '[reuse] 已有 supervisor 在运行，拒绝启动第二个实例。' -ForegroundColor Green
    $stateObj = Read-SupervisorState
    if ($stateObj) {
        Write-Host "        state=$($stateObj.state) supervisorPid=$($stateObj.supervisorPid) workerPid=$($stateObj.workerPid)"
    }
    exit 0
}

Start-Sleep -Milliseconds 300
$dayuTarget = Resolve-DayuTarget

# DAYU clock: write only when drift crosses the threshold (formal demo_recover parity).
if (Test-Path $TimeSyncJs) {
    Write-Step '校准 DAYU 时钟（仅漂移超阈值时写入）'
    $timeSync = & $Node $TimeSyncJs --once --hdc $Hdc 2>&1
    if ($LASTEXITCODE -ne 0) { throw "DAYU 时钟校准失败: $($timeSync -join ' ')" }
    Write-Host "        $($timeSync -join ' ')" -ForegroundColor Green
}

$homemonStatus = Get-HomemonStatus $dayuTarget
if (-not $homemonStatus.Sha) { throw 'DAYU /data/homemon/homemon 缺失或不可读' }
if ($homemonStatus.Sha -ne $HomemonSha) { throw "DAYU homemon 哈希不是冻结原版 $HomemonSha" }
if (-not $homemonStatus.Running) {
    Write-Host '[start] DAYU 原版 homemon 未运行，启动 /data/homemon/homemon.conf' -ForegroundColor Yellow
    & $Hdc -t $dayuTarget shell 'cd /data/homemon && (./homemon homemon.conf > homemon.stdout 2>&1 &)' | Out-Null
    Start-Sleep -Seconds 2
    $homemonStatus = Get-HomemonStatus $dayuTarget
    if (-not $homemonStatus.Running -or -not $homemonStatus.Listening) {
        throw 'homemon 启动后未确认进程和 9000 LISTEN'
    }
    Write-Ok 'DAYU homemon 已启动'
}

$fportText = (@(& $Hdc fport ls 2>&1) -join "`n")
if ($fportText -notmatch 'tcp:9001\s+(?:->\s+)?tcp:9000') {
    Write-Host '[start] 建立 hdc fport tcp:9001 -> tcp:9000' -ForegroundColor Yellow
    & $Hdc -t $dayuTarget fport tcp:9001 tcp:9000 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'hdc fport 建立失败' }
}
for ($i = 0; $i -lt 20; $i++) {
    if (Test-TcpPort '127.0.0.1' 9001) { break }
    Start-Sleep -Milliseconds 500
}
if (-not (Test-TcpPort '127.0.0.1' 9001)) { throw '127.0.0.1:9001 未监听，拒绝启动 Bridge' }
Write-Ok 'fport 127.0.0.1:9001 可用'

if (-not (Test-Path $RuntimeDir)) { New-Item -ItemType Directory -Path $RuntimeDir -Force | Out-Null }
if (-not (Test-Path (Join-Path $RuntimeDir 'control'))) {
    New-Item -ItemType Directory -Path (Join-Path $RuntimeDir 'control') -Force | Out-Null
}

if (-not (Test-TcpPort '127.0.0.1' 1883)) {
    Write-Host '[start] 启动 Broker 1883' -ForegroundColor Yellow
    Start-Process -FilePath $Node -ArgumentList @($BrokerJs, '1883') `
        -WorkingDirectory (Split-Path -Parent $BrokerJs) `
        -RedirectStandardOutput (Join-Path $RuntimeDir 'broker.out.log') `
        -RedirectStandardError (Join-Path $RuntimeDir 'broker.err.log') `
        -WindowStyle Hidden | Out-Null
    for ($i = 0; $i -lt 10; $i++) {
        if (Test-TcpPort '127.0.0.1' 1883) { break }
        Start-Sleep -Milliseconds 500
    }
    if (-not (Test-TcpPort '127.0.0.1' 1883)) { throw "Broker 1883 未监听；日志：$RuntimeDir\broker*.log" }
} else {
    Write-Host '[reuse] Broker 1883 已监听' -ForegroundColor Green
}

if (-not (Test-TcpPort '127.0.0.1' 9101)) {
    Write-Host '[start] 启动 Bridge 9101' -ForegroundColor Yellow
    $bridgeArguments = @(
        $BridgeJs, '--broker', '127.0.0.1:1883', '--status-tcp', '127.0.0.1:9001',
        '--listen', '9101', '--relay-to', '127.0.0.1:9001',
        '--cmd-out', (Join-Path $RuntimeDir 'control'),
        '--status-file', (Join-Path $RuntimeDir 'status.json')
    )
    Start-Process -FilePath $Node -ArgumentList $bridgeArguments `
        -WorkingDirectory (Split-Path -Parent $BridgeJs) `
        -RedirectStandardOutput (Join-Path $RuntimeDir 'bridge.out.log') `
        -RedirectStandardError (Join-Path $RuntimeDir 'bridge.err.log') `
        -WindowStyle Hidden | Out-Null
    for ($i = 0; $i -lt 10; $i++) {
        if (Test-TcpPort '127.0.0.1' 9101) { break }
        Start-Sleep -Milliseconds 500
    }
    if (-not (Test-TcpPort '127.0.0.1' 9101)) { throw "Bridge 9101 未监听；日志：$RuntimeDir\bridge*.log" }
} else {
    Write-Host '[reuse] Bridge 9101 已监听' -ForegroundColor Green
}

Write-Host ''
Write-Host '=== 结构检查通过，启动 supervisor ===' -ForegroundColor Cyan
Write-Host '    接下来只输入一次隐藏 INGEST_KEY；运行期间不要关闭本窗口。' -ForegroundColor Yellow
Write-Host "    事件日志: $Log" -ForegroundColor DarkGray
Write-Host ''

& $Node $Supervisor --public-sync-entry $PublicSync --worker-script $Worker `
    --state-file $State --lock-file $Lock --log-file $Log
$exitCode = $LASTEXITCODE

Write-Host ''
$finalState = Read-SupervisorState
if ($finalState) {
    Write-Host "最后状态: state=$($finalState.state) supervisorPid=$($finalState.supervisorPid) workerPid=$($finalState.workerPid) restartCount=$($finalState.restartCount) heartbeatAt=$($finalState.heartbeatAt)" -ForegroundColor Yellow
}
Write-Host "supervisor 退出码=$exitCode；事件日志=$Log" -ForegroundColor Yellow
Write-Host '若状态不是 STOPPED，请保留窗口与日志，并记录首个失败点。' -ForegroundColor Yellow
exit $exitCode
