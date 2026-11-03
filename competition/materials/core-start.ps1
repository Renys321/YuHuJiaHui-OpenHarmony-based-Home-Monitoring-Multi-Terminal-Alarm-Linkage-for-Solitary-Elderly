# core-start.ps1 —— 当前演示栈一键启动/自检（幂等）
# 用法：
#   powershell -File materials\core-start.ps1
#   powershell -File materials\core-start.ps1 -CheckOnly
#   powershell -File materials\core-start.ps1 -RestartGateway
#   powershell -File materials\core-start.ps1 -Quiet
[CmdletBinding()]
param(
    [switch]$CheckOnly,
    [switch]$RestartGateway,
    [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path $PSScriptRoot -Parent
$Node = 'D:\Node\node.exe'
$Hdc = 'D:\OpenHarmony\tools\hdc\hdc.exe'
$GatewayDir = Join-Path $Root 'voice-gateway'
$GatewayJs = Join-Path $GatewayDir 'server.js'
$GatewayOut = Join-Path $GatewayDir 'gateway.out.log'
$GatewayErr = Join-Path $GatewayDir 'gateway.err.log'
$Restore = Join-Path $PSScriptRoot 'restore-hdc-mappings.ps1'
$LogDir = Join-Path $Root 'logs'
$CheckLog = Join-Path $LogDir 'core-start.log'

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$script:Ok = 0; $script:Warn = 0; $script:Fail = 0
function Say([string]$m, [string]$c = 'Gray') { if (-not $Quiet) { Write-Host $m -ForegroundColor $c } }
function Pass([string]$m) { $script:Ok++; Say "  [OK]   $m" Green; Add-Content $CheckLog "$(Get-Date -Format o) OK $m" }
function Warn([string]$m) { $script:Warn++; Say "  [WARN] $m" Yellow; Add-Content $CheckLog "$(Get-Date -Format o) WARN $m" }
function Fail([string]$m) { $script:Fail++; Say "  [FAIL] $m" Red; Add-Content $CheckLog "$(Get-Date -Format o) FAIL $m" }
function Step([string]$m) { Say ""; Say "== $m ==" Cyan }

# 纯 TCP 探测：不依赖 WMI/CIM（受限会话里 Get-NetTCPConnection 会“拒绝访问”导致假 FAIL）
function Test-Port([int]$Port) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $task = $client.ConnectAsync('127.0.0.1', $Port)
        if (-not $task.Wait(800)) { return $false }
        return $client.Connected
    } catch { return $false } finally { $client.Close() }
}
function Get-GatewayProcesses {
    # 网关是用 -WorkingDirectory 起的 `node server.js`，命令行里没有绝对路径，
    # 只能按监听端口 9302/9303/9102 反查进程。
    $pids = @()
    foreach ($port in @(9302, 9303, 9102)) {
        $pids += @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty OwningProcess)
    }
    $found = @()
    foreach ($procId in ($pids | Where-Object { $_ -gt 0 } | Sort-Object -Unique)) {
        $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
        if ($proc -and $proc.ProcessName -eq 'node') { $found += $proc }
    }
    if ($found.Count -eq 0) {
        $found = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -and $_.CommandLine -like '*server.js*' } |
            ForEach-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue })
    }
    return $found
}
function Get-HdcTarget {
    $sn = @(& $Hdc list targets 2>$null) | Where-Object { $_ -match '^\d{10,}' } | Select-Object -First 1
    if ($sn) { return $sn.Trim() } else { return $null }
}
function Ensure-HdcMapping([string]$Target) {
    $map = @(& $Hdc -t $Target fport ls 2>$null) -join "`n"
    $missing = @()
    if ($map -notmatch 'tcp:9001\s+tcp:9000') { $missing += '9001->9000' }
    if ($map -notmatch 'tcp:9200\s+tcp:9200[^\n]*Reverse') { $missing += 'rport 9200' }
    if ($map -notmatch 'tcp:9301\s+tcp:9301') { $missing += '9301->9301' }
    if ($map -notmatch 'tcp:9302\s+tcp:9302[^\n]*Reverse') { $missing += 'rport 9302' }
    if ($missing.Count -eq 0) { Pass 'hdc 映射完整'; return }
    Warn "hdc 缺少: $($missing -join ', ')"
    if ($CheckOnly) { return }
    & powershell -NoProfile -ExecutionPolicy Bypass -File $Restore *> $null
    Start-Sleep -Milliseconds 800
    $map = @(& $Hdc -t $Target fport ls 2>$null) -join "`n"
    if ($map -match 'tcp:9001\s+tcp:9000' -and $map -match 'tcp:9302\s+tcp:9302') { Pass 'hdc 映射已恢复' }
    else { Fail 'hdc 映射恢复失败' }
}
function Start-Gateway {
    $procs = Get-GatewayProcesses
    if ($procs.Count -gt 0) {
        $allUp = (Test-Port 9302) -and (Test-Port 9303) -and (Test-Port 9102)
        if ($allUp -and -not $RestartGateway) { Pass "语音网关已在运行 (pid $($procs[0].Id))"; return }
        foreach ($p in $procs) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
        # 等旧进程真正释放端口，否则新进程直接 EADDRINUSE。
        $deadline = (Get-Date).AddSeconds(8)
        while ((Get-Date) -lt $deadline) {
            if (-not ((Test-Port 9302) -or (Test-Port 9303) -or (Test-Port 9102))) { break }
            Start-Sleep -Milliseconds 200
        }
        Start-Sleep -Milliseconds 300
    }
    Say '  启动语音网关…'
    Start-Process -FilePath $Node -ArgumentList 'server.js' -WorkingDirectory $GatewayDir `
        -RedirectStandardOutput $GatewayOut -RedirectStandardError $GatewayErr -WindowStyle Hidden | Out-Null
    $deadline = (Get-Date).AddSeconds(20)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 500
        if ((Test-Port 9302) -and (Test-Port 9303) -and (Test-Port 9102)) { break }
    }
    if ((Test-Port 9302) -and (Test-Port 9303) -and (Test-Port 9102)) { Pass '语音网关已启动 (9302/9303/9102)' }
    else { Fail '语音网关端口未就绪（看 gateway.err.log）' }
}

Step '1/6 环境检查'
if (Test-Path $Node) { Pass "Node: $Node" } else { Fail "缺少 Node: $Node" }
if (Test-Path $Hdc) { Pass "hdc: $Hdc" } else { Fail "缺少 hdc: $Hdc" }
if (Test-Path (Join-Path $Root '.secrets\ingest_key.txt')) { Pass 'INGEST_KEY 文件存在' } else { Warn '缺少 .secrets\ingest_key.txt（云端上报会跳过）' }

Step '2/6 语音网关'
if ($CheckOnly) {
    if ((Test-Port 9302) -and (Test-Port 9303) -and (Test-Port 9102)) { Pass '网关 9302/9303/9102 监听' }
    else { Warn '网关端口不全（体检模式不启动）' }
} else { Start-Gateway }

Step '3/6 DAYU200 连接'
$target = Get-HdcTarget
if ($target) {
    Pass "DAYU 目标: $target"
    Ensure-HdcMapping $target
    $pidText = ((& $Hdc -t $target shell 'pidof com.dsh.eldercare' 2>$null) -join ' ').Trim()
    if (-not $pidText -and -not $CheckOnly) {
        & $Hdc -t $target shell 'aa start -a EntryAbility -b com.dsh.eldercare' | Out-Null
        Start-Sleep -Seconds 4
        $pidText = ((& $Hdc -t $target shell 'pidof com.dsh.eldercare' 2>$null) -join ' ').Trim()
    }
    if ($pidText) { Pass 'DAYU APP 在运行' } else { Warn 'DAYU APP 未运行' }
} else {
    Fail 'hdc 未发现 DAYU（USB/上电/解锁）'
}

Step '4/6 P0 服务'
foreach ($p in @(1883, 9101)) {
    if (Test-Port $p) { Pass "端口 $p 监听" } else { Fail "端口 $p 未监听（broker/bridge）" }
}
$cloudOk = $false
if (Test-Path $Node) {
    try {
        $out = (& $Node -e "fetch('https://api.luxunacc.xyz/healthz').then(r=>r.json()).then(j=>console.log(j&&j.ok?'ok':'notok')).catch(e=>console.log('err'))" 2>$null) -join ''
        $cloudOk = ($out.Trim() -eq 'ok')
    } catch { $cloudOk = $false }
}
if (-not $cloudOk) {
    try {
        $h = Invoke-RestMethod -Uri 'https://api.luxunacc.xyz/healthz' -TimeoutSec 5
        $cloudOk = [bool]$h.ok
    } catch { }
}
if ($cloudOk) { Pass '公网后端 healthz ok' } else { Warn '公网后端不可达（node/.NET 均失败）' }

Step '5/6 音箱节点'
$spk = @(Get-NetTCPConnection -LocalPort 9102 -State Established -ErrorAction SilentlyContinue)
if ($spk.Count -gt 0) { Pass "音箱连接 $($spk.Count) 个" } else { Warn '9102 没有已连接音箱节点' }
if ($spk.Count -gt 2) { Warn "音箱连接数 $($spk.Count) >2，可能有残留（重启网关可清）" }

Step '6/6 汇总'
Say ""
Say "结果: OK=$($script:Ok) WARN=$($script:Warn) FAIL=$($script:Fail)" $(if ($script:Fail -gt 0) { 'Red' } elseif ($script:Warn -gt 0) { 'Yellow' } else { 'Green' })
Add-Content $CheckLog "$(Get-Date -Format o) SUMMARY ok=$($script:Ok) warn=$($script:Warn) fail=$($script:Fail)"
if ($script:Fail -gt 0) { exit 1 } else { exit 0 }
