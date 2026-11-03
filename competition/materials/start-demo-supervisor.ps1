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
#   start-demo-supervisor.ps1 -AutoDayuEndpoint
#        -> 先用 materials\resolve-dayu-lan-ip.ps1（只读）自动解析 DAYU 状态/relay 端点，
#           解决板端 WLAN IP 漂移后 bridge 仍连旧 IP 的问题；USB 在线优先 fport（无 IP 依赖），
#           否则回退 LAN IPv4:9000。显式 -StatusTcp/-RelayTo 优先于本开关。
#
# Safety:
#   - Never reads, prints, stores or logs INGEST_KEY (the supervisor owns it).
#   - Never flashes or writes ESP32 boards, never touches COM5/COM14/COM8.
#   - Never overwrites DAYU homemon: hash must match the frozen original.
#   - Never starts a second supervisor while a live lock exists.
param(
    [switch]$Preflight,
    [string]$Target,
    # 南向状态端点。默认走 USB + hdc fport（127.0.0.1:9001 -> 板端 9000）；
    # 无线/直连模式（板端 homemon 监听在局域网 IP）可传例如 10.127.130.131:9000，
    # 此时本入口不再建立/检查 hdc fport。
    [string]$StatusTcp = '127.0.0.1:9001',
    [string]$RelayTo = '127.0.0.1:9001',
    # 板外直接注入 homemon 的 deviceId（随身求助 mirror 写 esp32-sos）。
    # 桥接收到这些 ID 经 homemon 广播回来的 relay 回灌时只忽略，不改名、不退休板端连接。
    [string]$RelayIgnore = 'esp32-sos',
    # 2026-10-28: 自动解析 DAYU 状态/relay 端点（materials\resolve-dayu-lan-ip.ps1，只读）。
    # DAYU WLAN IP 会漂移（现场 .250 -> .131），写死 IP 会让 P0 收不到 dayu200-living 202、
    # mirror relay ETIMEDOUT。USB target 在线时优先 hdc fport（127.0.0.1:9001，无 IP 依赖），
    # 否则用板端 wlan0 的 IPv4:9000；解析不到时回退 127.0.0.1:9001，由预检继续报真实问题。
    [switch]$AutoDayuEndpoint,
    # 自动解析时优先局域网直连（默认优先 USB+fport）。
    [switch]$PreferLanEndpoint
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
$Resolver = Join-Path $Root 'materials\resolve-dayu-lan-ip.ps1'
# 2026-10-27: DAYU homemon 升级为「无 PIR 时禁止 NO_MOTION」修复版。
# 2026-10-28: 再升级为「MAX_CLIENTS 4→8 + TCP keepalive + EAGAIN 不杀连接」（177,872 B，arm32 -Strict），
# 修复 PC 侧 bridge/mirror 被强杀后僵尸 socket 占满 4 槽导致 DAYU 状态/SOS 镜像断链。
# 旧版本仍保留可回滚：/data/homemon/homemon.rollback-20261028-0045（f6f44…）与 20261027-2257（0d2435…）。
$HomemonSha = 'a5f355c2d5e9f4e7330282f1856411927eb54ad743b5acb7c599be7c2d6ed9ea'

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
# 2026-10-28: 自动解析 DAYU 状态/relay 端点（只读，解决板端 WLAN IP 漂移）
# ---------------------------------------------------------------------------
if ($StatusTcp -eq 'auto' -or $RelayTo -eq 'auto') { $AutoDayuEndpoint = $true }
if ($AutoDayuEndpoint) {
    if ($PSBoundParameters.ContainsKey('StatusTcp') -or $PSBoundParameters.ContainsKey('RelayTo')) {
        Write-Warn '显式传入 -StatusTcp/-RelayTo，优先使用显式值（忽略 -AutoDayuEndpoint）'
    } elseif (-not (Test-Path $Resolver)) {
        Write-Bad "缺少自动解析脚本 $Resolver；回退 127.0.0.1:9001 fport"
        $StatusTcp = '127.0.0.1:9001'
        $RelayTo = '127.0.0.1:9001'
    } else {
        Write-Step '自动解析 DAYU 状态/relay 端点（resolve-dayu-lan-ip.ps1，只读）'
        $resolveArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $Resolver, '-JsonOnly')
        if ($PreferLanEndpoint) { $resolveArgs += '-PreferLan' }
        $resolveRaw = @(& 'powershell.exe' @resolveArgs 2>&1)
        $resolveCode = $LASTEXITCODE
        $resolveObj = $null
        try { $resolveObj = (($resolveRaw -join "`n") | ConvertFrom-Json) } catch { $resolveObj = $null }
        if ($resolveObj -and $resolveObj.ok -and $resolveObj.endpoint) {
            $StatusTcp = [string]$resolveObj.endpoint
            $RelayTo = [string]$resolveObj.endpoint
            Write-Ok ("自动端点 endpoint={0} method={1} wlan0Ip={2}" -f $resolveObj.endpoint, $resolveObj.method, $resolveObj.wlan0Ip)
            if ($resolveObj.requiresFportCreate) {
                Write-Host '        (fport 尚未建立，启动阶段会创建 tcp:9001 -> tcp:9000)' -ForegroundColor DarkGray
            }
            if ($resolveObj.method -eq 'lan') {
                Write-Host '        (局域网直连拓扑；板端 WLAN IP 再变需重新解析并重启 bridge/mirror)' -ForegroundColor Yellow
            }
        } else {
            $why = '解析脚本无有效 JSON'
            if ($resolveObj -and $resolveObj.reason) { $why = [string]$resolveObj.reason }
            if ($resolveCode -ne 0 -and -not $resolveObj) { $why = "解析脚本退出码 $resolveCode" }
            Write-Warn ("自动解析失败（{0}）；回退 127.0.0.1:9001 fport，预检阶段会继续报真实问题" -f $why)
            $StatusTcp = '127.0.0.1:9001'
            $RelayTo = '127.0.0.1:9001'
        }
    }
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
Write-Host "[info]  状态/relay 端点: StatusTcp=$StatusTcp RelayTo=$RelayTo"

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

# 陈旧状态提示（2026-10-27）：state.json 可能停在很久以前的 HEALTHY，不能当现状。
# 这里只告警、不修改任何文件；真正的接管由 supervisor 启动时的 stale-lock 逻辑完成。
if (-not $supervisorLive -and (Test-Path $State)) {
    $oldState = Read-SupervisorState
    if ($oldState -and $oldState.state -eq 'HEALTHY') {
        $hbAge = -1
        try {
            $hb = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$oldState.heartbeatAt)
            $hbAge = [int][math]::Round(((Get-Date).ToUniversalTime() - $hb.UtcDateTime).TotalSeconds)
        } catch { $hbAge = -1 }
        Write-Warn "state.json 仍写着 HEALTHY（supervisorPid=$($oldState.supervisorPid) workerPid=$($oldState.workerPid) heartbeat=${hbAge}s 前），但 supervisor 进程已不在：这是陈旧快照，不代表当前健康；启动阶段会接管 stale lock"
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

        if ($StatusTcp -match '^127\.0\.0\.1:') {
            $fportText = (@(& $Hdc fport ls 2>&1) -join "`n")
            if ($fportText -match 'tcp:9001\s+(?:->\s+)?tcp:9000') {
                $fportPresent = $true
                Write-Ok 'hdc fport tcp:9001 -> tcp:9000 已存在'
            } else {
                Write-Warn 'hdc fport tcp:9001 -> tcp:9000 未建立，启动阶段会创建'
            }
        } else {
            Write-Ok "直连模式：状态端点 $StatusTcp（不检查/不建立 hdc fport）"
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
    $workerAlive = $false
    $hbAge = -1
    if ($stateObj) {
        if ($stateObj.workerPid -gt 0) {
            $workerAlive = [bool](Get-Process -Id ([int]$stateObj.workerPid) -ErrorAction SilentlyContinue)
        }
        try {
            $hb = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$stateObj.heartbeatAt)
            $hbAge = [int][math]::Round(((Get-Date).ToUniversalTime() - $hb.UtcDateTime).TotalSeconds)
        } catch { $hbAge = -1 }
        Write-Host "        state=$($stateObj.state) supervisorPid=$($stateObj.supervisorPid) workerPid=$($stateObj.workerPid) workerAlive=$workerAlive heartbeatAgeSec=$hbAge"
    } else {
        Write-Host '        supervisor 进程存活，但状态文件缺失或不可解析。'
    }
    if (-not $stateObj -or $stateObj.state -ne 'HEALTHY' -or -not $workerAlive -or $hbAge -lt 0 -or $hbAge -gt 180) {
        Write-Host ''
        Write-Host '[BAD] supervisor 进程在，但 worker/心跳不健康：不会再启动第二个同步器。' -ForegroundColor Red
        Write-Host '      处理：关闭启动它的可见窗口（结束后重跑本入口并输入 INGEST_KEY），或等待它自动重启/熔断恢复；' -ForegroundColor Yellow
        Write-Host '      先看状态文件与事件日志里的 WORKER_EXIT / RESTART_IN / CIRCUIT_OPEN。' -ForegroundColor Yellow
        exit 3
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

if ($StatusTcp -match '^127\.0\.0\.1:') {
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
} else {
    $statusParts = $StatusTcp.Split(':')
    $statusHost = $statusParts[0]
    $statusPort = [int]$statusParts[1]
    for ($i = 0; $i -lt 20; $i++) {
        if (Test-TcpPort $statusHost $statusPort) { break }
        Start-Sleep -Milliseconds 500
    }
    if (-not (Test-TcpPort $statusHost $statusPort)) { throw "状态端点 $StatusTcp 不可达，拒绝启动 Bridge" }
    Write-Ok "直连状态端点 $StatusTcp 可用（未使用 hdc fport）"
}

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
        $BridgeJs, '--broker', '127.0.0.1:1883', '--status-tcp', $StatusTcp,
        '--listen', '9101', '--relay-to', $RelayTo,
        '--cmd-out', (Join-Path $RuntimeDir 'control'),
        '--status-file', (Join-Path $RuntimeDir 'status.json'),
        '--lock-file', (Join-Path $RuntimeDir 'bridge.lock')
    )
    if ($RelayIgnore) { $bridgeArguments += @('--relay-ignore', $RelayIgnore) }
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
