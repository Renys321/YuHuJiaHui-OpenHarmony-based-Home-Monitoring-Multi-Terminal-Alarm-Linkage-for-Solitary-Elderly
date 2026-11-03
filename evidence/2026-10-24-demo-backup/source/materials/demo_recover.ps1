#requires -Version 5.1
<##
  demo_recover.ps1

  当前冻结演示版本的“只恢复链路”启动器。

  这个脚本只负责恢复已经存在的运行组件：
    - 不构建、不安装 HAP，不覆盖 homemon 或 homemon.conf；
    - 只在 DAYU 上原版 homemon 缺失时启动现有文件；
    - 只建立现有的 hdc fport tcp:9001 -> tcp:9000；
    - 只在端口没有被正确组件占用时启动 Broker/Bridge；
    - public-sync 在可见终端启动，由用户输入隐藏 INGEST_KEY；
    - 不操作 COM8、COM14、COM5，不启动模拟节点。

  用法：
    powershell -NoProfile -ExecutionPolicy Bypass -File .\demo_recover.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File .\demo_recover.ps1 -Stop

  “启动完成”只表示本机组件和 DAYU 通道已通过结构检查；自然 202 仍需由现场观察确认。
##>
param(
    [switch]$Stop,
    [string]$Target,
    [ValidateRange(1, 65535)][int]$BrokerPort = 1883,
    [ValidateRange(1, 65535)][int]$BridgePort = 9101,
    [ValidateRange(1, 65535)][int]$FportPort = 9001
)

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$Competition = Join-Path $Root 'competition'
$Hdc = Join-Path $Root 'tools\hdc\hdc.exe'
$NodeCandidates = @(
    'C:\Users\<user>\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe',
    'D:\Node\node.exe'
)
$Node = $NodeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
$BrokerJs = Join-Path $Competition 'bridge\mqtt_broker.js'
$BridgeJs = Join-Path $Competition 'bridge\mqtt_bridge.js'
$PublicRunner = Join-Path $Competition 'cloud\onenet\run-public-sync.js'
$TimeSyncJs = Join-Path $Competition 'southbound\dayu-time-sync.js'
$RuntimeDir = Join-Path $Competition 'bridge\_test\current-runtime'
$StateFile = Join-Path $RuntimeDir 'demo-recover.state.json'
$HomemonSha = '0d243539403de89c547defacf43c86a4980142ef8ec686b277be7133c42881e6'
$DayuDeviceId = 'dayu200-living'

function Fail([string]$Message) {
    Write-Host "[FAIL] $Message" -ForegroundColor Red
    exit 1
}

function Test-TcpPort([string]$HostName, [int]$Port) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $client.Connect($HostName, $Port)
        return $true
    } catch {
        return $false
    } finally {
        $client.Dispose()
    }
}

function Invoke-DayuShell([string]$Command) {
    $output = & $Hdc -t $script:SelectedTarget shell $Command 2>&1
    if ($LASTEXITCODE -ne 0) { Fail "DAYU shell 失败：$($output -join ' ')" }
    return @($output)
}

function Get-NodeProcesses {
    @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine })
}

function Get-ListeningProcess([int]$Port) {
    @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique)
}

function Get-CommandLineForPid([int]$Pid) {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId = $Pid" -ErrorAction SilentlyContinue
    if ($p) { return [string]$p.CommandLine }
    return ''
}

function Start-NodeComponent([string]$Name, [int]$Port, [string]$ScriptPath, [string[]]$Arguments, [string]$LogBase, [string]$ExpectedArgsPattern) {
    $sameScript = @(Get-NodeProcesses | Where-Object {
        $_.CommandLine -match [regex]::Escape($ScriptPath)
    })
    $existing = @($sameScript | Where-Object { $_.CommandLine -match $ExpectedArgsPattern })
    $wrong = @($sameScript | Where-Object { $_.CommandLine -notmatch $ExpectedArgsPattern })
    if ($wrong.Count -gt 0) {
        Fail "$Name 已有同脚本但参数不匹配的 Node 实例，拒绝叠加：$($wrong.ProcessId -join ', ')"
    }
    if ($existing.Count -gt 1) { Fail "$Name 已存在多个 Node 实例，请先人工核对，不自动清理" }
    if ($existing.Count -eq 1) {
        if (-not (Test-TcpPort '127.0.0.1' $Port)) {
            Fail "$Name 已有匹配脚本进程 PID $($existing[0].ProcessId)，但端口 $Port 未监听；拒绝叠加或假定其已恢复"
        }
        Write-Host "[reuse] $Name 已运行 PID $($existing[0].ProcessId)" -ForegroundColor Green
        return [pscustomobject]@{ Pid = [int]$existing[0].ProcessId; Owned = $false }
    }

    $out = "$LogBase.out.log"
    $err = "$LogBase.err.log"
    $process = Start-Process -FilePath $Node -ArgumentList (@($ScriptPath) + $Arguments) `
        -WorkingDirectory (Split-Path -Parent $ScriptPath) -RedirectStandardOutput $out `
        -RedirectStandardError $err -WindowStyle Minimized -PassThru
    Start-Sleep -Milliseconds 500
    if ($process.HasExited) { Fail "$Name 启动失败，exit=$($process.ExitCode)，日志：$out / $err" }
    for ($i = 0; $i -lt 10; $i++) {
        if (Test-TcpPort '127.0.0.1' $Port) {
            Write-Host "[start] $Name PID $($process.Id)，已监听 $Port；日志：$out / $err" -ForegroundColor Green
            return [pscustomobject]@{ Pid = [int]$process.Id; Owned = $true }
        }
        if ($process.HasExited) { Fail "$Name 启动后退出，exit=$($process.ExitCode)，日志：$out / $err" }
        Start-Sleep -Milliseconds 500
    }
    Fail "$Name PID $($process.Id) 未在 5 秒内监听 $Port，日志：$out / $err"
}

function Resolve-DayuTarget {
    if ($Target) { return $Target }
    $lines = @(& $Hdc list targets -v 2>&1)
    if ($LASTEXITCODE -ne 0) { Fail "无法读取 HDC targets：$($lines -join ' ')" }
    $ids = @()
    foreach ($line in $lines) {
        if ($line -match '(?i)([0-9a-f]{32}).*USB.*Connected') {
            $ids += $Matches[1]
        }
    }
    $ids = @($ids | Select-Object -Unique)
    if ($ids.Count -eq 0) { Fail '没有找到 USB Connected 的 DAYU200；不要用串口目标代替 HDC 目标' }
    if ($ids.Count -gt 1) { Fail "找到多个 USB DAYU 目标：$($ids -join ', ')；请用 -Target 明确指定" }
    return $ids[0]
}

function Ensure-DayuHomemon {
    $identity = Invoke-DayuShell "echo HOMEMON_SHA; if [ -x /data/homemon/homemon ]; then sha256sum /data/homemon/homemon; else echo MISSING; fi; echo HOMEMON_PS; ps -ef | grep '[h]omemon' || true; echo HOMEMON_NET; netstat -lntp 2>/dev/null | grep ':9000' || true"
    $joined = $identity -join "`n"
    if ($joined -match 'MISSING') { Fail 'DAYU 缺少 /data/homemon/homemon；恢复器不会上传或替换二进制' }
    if ($joined -notmatch "(?i)$HomemonSha") {
        Fail "DAYU homemon 哈希不是冻结原版 $HomemonSha；恢复器拒绝覆盖来源不明的程序"
    }

    $processSection = ($joined -split 'HOMEMON_PS', 2)[-1]
    $processSection = ($processSection -split 'HOMEMON_NET', 2)[0]
    $running = $processSection -match '/data/homemon/homemon'
    if (-not $running) {
        Write-Host '[start] DAYU 原版 homemon 缺失，启动 /data/homemon/homemon.conf' -ForegroundColor Yellow
        [void](Invoke-DayuShell 'cd /data/homemon && (./homemon homemon.conf > homemon.stdout 2>&1 &)')
        Start-Sleep -Seconds 2
        $check = Invoke-DayuShell "ps -ef | grep '[h]omemon' || true; netstat -lntp 2>/dev/null | grep ':9000' || true"
        $checkText = $check -join "`n"
        if ($checkText -notmatch '/data/homemon/homemon' -or $checkText -notmatch ':9000') {
            Fail 'homemon 启动后未确认进程和 9000 LISTEN'
        }
    } else {
        Write-Host '[reuse] DAYU 原版 homemon 已运行，未重启/未覆盖' -ForegroundColor Green
    }
}

function Ensure-Fport {
    $current = @(& $Hdc fport ls 2>&1)
    $mapping = $current -join "`n"
    if ($mapping -match "tcp:$FportPort\s*(?:->\s*)?tcp:9000") {
        Write-Host "[reuse] hdc fport tcp:$FportPort -> tcp:9000 已存在" -ForegroundColor Green
    } else {
        Write-Host "[start] 建立 hdc fport tcp:$FportPort -> tcp:9000" -ForegroundColor Yellow
        $created = @(& $Hdc -t $script:SelectedTarget fport "tcp:$FportPort" 'tcp:9000' 2>&1)
        if ($LASTEXITCODE -ne 0) { Fail "hdc fport 建立失败：$($created -join ' ')" }
    }
    for ($i = 0; $i -lt 10; $i++) {
        if (Test-TcpPort '127.0.0.1' $FportPort) { return }
        Start-Sleep -Milliseconds 500
    }
    Fail "127.0.0.1:$FportPort 未监听；未继续启动 Bridge"
}

function Ensure-Component(
    [string]$Name,
    [int]$Port,
    [string]$ScriptPath,
    [string[]]$Arguments,
    [string]$LogBase,
    [string]$ExpectedScriptPattern,
    [string]$ExpectedArgsPattern
) {
    $listeners = @(Get-ListeningProcess $Port)
    if ($listeners.Count -gt 1) { Fail "$Name 端口 $Port 有多个监听 PID，拒绝自动处理" }
    if ($listeners.Count -eq 1) {
        $cmd = Get-CommandLineForPid $listeners[0]
        if ($cmd -notmatch $ExpectedScriptPattern) {
            Fail "$Name 端口 $Port 被非项目进程 PID $($listeners[0]) 占用：$cmd"
        }
        Write-Host "[reuse] $Name 已监听 $Port（PID $($listeners[0])）" -ForegroundColor Green
        if ($cmd -notmatch $ExpectedArgsPattern) {
            Fail "$Name 端口 $Port 的项目进程参数不匹配，拒绝复用：$cmd"
        }
        return [pscustomobject]@{ Pid = [int]$listeners[0]; Owned = $false }
    }
    return Start-NodeComponent $Name $Port $ScriptPath $Arguments $LogBase $ExpectedArgsPattern
}

function Ensure-PublicSync {
    $existing = @(Get-NodeProcesses | Where-Object {
        $_.CommandLine -match 'run-public-sync\.js|cloud[\\/]onenet[\\/]public-sync\.js'
    })
    if ($existing.Count -gt 0) {
        Write-Host "[reuse] public-sync 已运行（$($existing.ProcessId -join ', ')），未启动第二个实例" -ForegroundColor Green
        return [pscustomobject]@{ Pids = @($existing | Select-Object -ExpandProperty ProcessId); Owned = $false; TerminalPid = 0 }
    }

    $pwsh = (Get-Command pwsh.exe -ErrorAction SilentlyContinue).Source
    if (-not $pwsh) { $pwsh = (Get-Command powershell.exe -ErrorAction SilentlyContinue).Source }
    if (-not $pwsh) { Fail '找不到 PowerShell，无法为 public-sync 保留可见隐藏输入终端' }

    $command = "Set-Location -LiteralPath '$($Competition.Replace("'", "''"))'; & '$($Node.Replace("'", "''"))' '$($PublicRunner.Replace("'", "''"))'"
    $terminal = Start-Process -FilePath $pwsh -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-NoExit', '-Command', $command) `
        -WorkingDirectory (Split-Path -Parent $PublicRunner) -WindowStyle Normal -PassThru
    Start-Sleep -Milliseconds 800
    if ($terminal.HasExited) { Fail 'public-sync 可见终端未能启动' }
    $children = @(Get-NodeProcesses | Where-Object {
        $_.CommandLine -match 'run-public-sync\.js|cloud[\\/]onenet[\\/]public-sync\.js'
    } | Select-Object -ExpandProperty ProcessId)
    if ($children.Count -eq 0) { Fail 'public-sync 可见终端已打开，但未发现 runner/child；请检查该窗口输出' }
    Write-Host "[start] public-sync 已在可见终端启动（窗口 PID $($terminal.Id)，Node PID $($children -join ', ')）" -ForegroundColor Green
    Write-Host '       请只在该终端的隐藏提示中输入 INGEST_KEY；不要粘贴到聊天、命令行参数或文件。' -ForegroundColor Yellow
    return [pscustomobject]@{ Pids = $children; Owned = $true; TerminalPid = [int]$terminal.Id }
}

function Stop-RecordedProcess([int]$Pid, [string]$ExpectedText) {
    if (-not $Pid) { return }
    $cmd = Get-CommandLineForPid $Pid
    if (-not $cmd) { return }
    if ($cmd -notmatch $ExpectedText) {
        Write-Host "[skip] PID $Pid 已被复用，命令行不匹配，未停止" -ForegroundColor Yellow
        return
    }
    Stop-Process -Id $Pid -Force -ErrorAction SilentlyContinue
    Write-Host "[stop] 已停止受本启动器记录的 PID $Pid" -ForegroundColor Green
}

if (-not (Test-Path $Hdc)) { Fail "缺少 HDC：$Hdc" }
if (-not (Test-Path $Node)) { Fail "缺少 Node：$Node" }
foreach ($path in @($BrokerJs, $BridgeJs, $PublicRunner, $TimeSyncJs)) {
    if (-not (Test-Path $path)) { Fail "缺少项目文件：$path" }
}

if ($Stop) {
    if (-not (Test-Path $StateFile)) {
        Write-Host '[stop] 没有本启动器的状态文件，不泛杀现有服务。' -ForegroundColor Yellow
        exit 0
    }
    $state = Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json
    if ($state.BridgeOwned) { Stop-RecordedProcess ([int]$state.BridgePid) 'mqtt_bridge\.js' }
    if ($state.BrokerOwned) { Stop-RecordedProcess ([int]$state.BrokerPid) 'mqtt_broker\.js' }
    if ($state.PublicOwned) {
        foreach ($pid in @($state.PublicPids)) { Stop-RecordedProcess ([int]$pid) 'run-public-sync\.js|public-sync\.js' }
        Stop-RecordedProcess ([int]$state.PublicTerminalPid) 'powershell|pwsh'
    }
    if ($state.FportCreatedByUs) {
        & $Hdc -t $state.Target fport rm "tcp:$FportPort" 'tcp:9000' 2>&1 | Out-Null
        Write-Host "[stop] 已移除本次建立的 fport tcp:$FportPort -> tcp:9000" -ForegroundColor Green
    }
    Remove-Item -LiteralPath $StateFile -Force -ErrorAction SilentlyContinue
    exit 0
}

$script:SelectedTarget = Resolve-DayuTarget
Write-Host "=== 当前冻结版本链路恢复：DAYU $script:SelectedTarget ===" -ForegroundColor Cyan
if ($BridgePort -eq $FportPort) { Fail 'BridgePort 与 FportPort 不能相同' }

Write-Host '[check] 校准 DAYU 时钟（仅在漂移超出阈值时写入，避免错误 deviceTs）' -ForegroundColor Yellow
$timeSync = & $Node $TimeSyncJs --once --hdc $Hdc 2>&1
if ($LASTEXITCODE -ne 0) { Fail "DAYU 时钟校准失败：$($timeSync -join ' ')" }
Write-Host ("       " + ($timeSync -join ' ')) -ForegroundColor Green

Ensure-DayuHomemon
$beforeFport = (@(& $Hdc fport ls 2>&1) -join "`n")
$fportHadMapping = $beforeFport -match "tcp:$FportPort\s*(?:->\s*)?tcp:9000"
Ensure-Fport

if (-not (Test-Path $RuntimeDir)) { New-Item -ItemType Directory -Path $RuntimeDir -Force | Out-Null }
$broker = Ensure-Component 'Broker' $BrokerPort $BrokerJs @($BrokerPort.ToString()) `
    (Join-Path $RuntimeDir 'broker') 'mqtt_broker\.js' ("(?<!\d)" + $BrokerPort + "(?!\d)")
$bridgeArgs = @('--broker', "127.0.0.1:$BrokerPort", '--status-tcp', "127.0.0.1:$FportPort",
    '--listen', $BridgePort.ToString(), '--relay-to', "127.0.0.1:$FportPort",
    '--cmd-out', (Join-Path $RuntimeDir 'control'), '--status-file', (Join-Path $RuntimeDir 'status.json'))
$bridge = Ensure-Component 'Bridge' $BridgePort $BridgeJs $bridgeArgs `
    (Join-Path $RuntimeDir 'bridge') 'mqtt_bridge\.js' `
    ('--broker\s+127\.0\.0\.1:' + $BrokerPort + '.*--status-tcp\s+127\.0\.0\.1:' + $FportPort + '.*--listen\s+' + $BridgePort + '.*--relay-to\s+127\.0\.0\.1:' + $FportPort)
$public = Ensure-PublicSync

$state = [ordered]@{
    startedAt = (Get-Date).ToUniversalTime().ToString('o')
    target = $script:SelectedTarget
    brokerPid = $broker.Pid
    brokerOwned = $broker.Owned
    bridgePid = $bridge.Pid
    bridgeOwned = $bridge.Owned
    publicPids = @($public.Pids)
    publicOwned = $public.Owned
    publicTerminalPid = $public.TerminalPid
    fportCreatedByUs = (-not $fportHadMapping)
    bridgePort = $BridgePort
    fportPort = $FportPort
}
$state | ConvertTo-Json | Set-Content -LiteralPath $StateFile -Encoding UTF8

Write-Host ''
Write-Host '=== 链路恢复完成（结构检查） ===' -ForegroundColor Green
Write-Host "DAYU homemon : 原版 /data/homemon/homemon，9000"
Write-Host "HDC fport    : tcp:$FportPort -> tcp:9000"
Write-Host "Bridge       : 127.0.0.1:$BridgePort"
Write-Host "Broker       : 127.0.0.1:$BrokerPort"
Write-Host 'public-sync  : 可见终端；等待隐藏 INGEST_KEY 输入或复用现有实例'
Write-Host '手机 HAP     : 未安装、未覆盖；当前冻结包保持不变'
Write-Host '下一步       : 等待三个 deviceId 的自然新 202，不能把旧 retained/status.json 当在线证据'
Write-Host "停止本次启动器进程：powershell -NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Stop"
