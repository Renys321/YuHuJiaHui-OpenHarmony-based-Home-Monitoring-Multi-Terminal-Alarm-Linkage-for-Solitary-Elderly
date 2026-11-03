# public-sync-health.ps1 — 只读 P0/public-sync 健康检查（2026-10-27）
#
# 目的：把"状态文件写着 HEALTHY"和"进程真的活着"区分开。2026-10-27 16:25 事故里
# supervisor+worker 一起退出，但 state.json 停在 16:24 的 HEALTHY、lock 文件还在，
# 只看文件会把 P0 误判为健康（手机端因此一直停在旧数据且无人拉起）。
#
# 本脚本只读：不启动/停止任何服务、不读取 INGEST_KEY、不修改任何文件；退出码
#   0 = 健康；3 = 不健康（JSON 里有 reason，可直接给 Lead/运维判断）。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File materials\public-sync-health.ps1
#   powershell ... -File materials\public-sync-health.ps1 -JsonOnly
param(
    [switch]$JsonOnly,
    [string]$StateFile = 'D:\OpenHarmony\competition\bridge\_test\current-runtime\supervisor\public-sync-supervisor.state.json',
    [string]$LockFile = 'D:\OpenHarmony\competition\bridge\_test\current-runtime\supervisor\public-sync-supervisor.lock',
    [int]$BrokerPort = 1883,
    [int]$BridgePort = 9101
)

$ErrorActionPreference = 'Stop'
$Root = 'D:\OpenHarmony\competition'
$Node = 'D:\Node\node.exe'
$Supervisor = Join-Path $Root 'cloud\onenet\public-sync-supervisor.js'

function Test-TcpPort([string]$HostName, [int]$Port, [int]$TimeoutMs = 500) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $async = $client.BeginConnect($HostName, $Port, $null, $null)
        if (-not $async.AsyncWaitHandle.WaitOne($TimeoutMs)) { return $false }
        $client.EndConnect($async)
        return $true
    } catch { return $false } finally { $client.Dispose() }
}

$result = [ordered]@{
    checkedAt = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
    brokerListening = (Test-TcpPort '127.0.0.1' $BrokerPort)
    bridgeListening = (Test-TcpPort '127.0.0.1' $BridgePort)
    supervisor = $null
}

if (Test-Path $Node) {
    $raw = & $Node $Supervisor --check --state-file $StateFile --lock-file $LockFile 2>&1
    $code = $LASTEXITCODE
    $json = $null
    try { $json = ($raw -join "`n") | ConvertFrom-Json } catch { $json = $null }
    $result.supervisor = $json
    $result.supervisorCheckExit = $code
} else {
    $result.supervisor = [ordered]@{ healthy = $false; reason = 'NODE_MISSING' }
}

$healthy = [bool]$result.brokerListening -and [bool]$result.bridgeListening -and
    $result.supervisor -and [bool]$result.supervisor.healthy
$result.portsOk = [bool]$result.brokerListening -and [bool]$result.bridgeListening
$result.healthy = [bool]$healthy
if (-not $healthy) {
    $reasons = @()
    if (-not $result.brokerListening) { $reasons += 'BROKER_1883_DOWN' }
    if (-not $result.bridgeListening) { $reasons += 'BRIDGE_9101_DOWN' }
    if ($result.supervisor -and -not $result.supervisor.healthy) {
        $reasons += ('SUPERVISOR_' + [string]$result.supervisor.reason)
    }
    $result.reason = ($reasons -join ',')
} else {
    $result.reason = 'HEALTHY'
}

$jsonText = ($result | ConvertTo-Json -Depth 6)
if ($JsonOnly) {
    Write-Output $jsonText
} else {
    Write-Host '=== public-sync / P0 只读健康检查（不启动、不停止、不读取密钥）===' -ForegroundColor Cyan
    Write-Host ("  时间            : {0}" -f $result.checkedAt)
    Write-Host ("  Broker 1883     : {0}" -f $(if ($result.brokerListening) { 'LISTENING' } else { 'DOWN' }))
    Write-Host ("  Bridge 9101     : {0}" -f $(if ($result.bridgeListening) { 'LISTENING' } else { 'DOWN' }))
    if ($result.supervisor) {
        Write-Host ("  supervisor      : healthy={0} reason={1} state={2} supervisorPid={3} workerPid={4} heartbeatAgeMs={5}" -f `
            $result.supervisor.healthy, $result.supervisor.reason, $result.supervisor.state, `
            $result.supervisor.supervisorPid, $result.supervisor.workerPid, $result.supervisor.heartbeatAgeMs)
    }
    if ($healthy) {
        Write-Host ("  结论            : HEALTHY（{0}）" -f $result.reason) -ForegroundColor Green
    } else {
        Write-Host ("  结论            : NOT HEALTHY（{0}）" -f $result.reason) -ForegroundColor Red
        Write-Host '  修复：人工运行 materials\start-demo-supervisor.cmd，并在可见窗口输入 INGEST_KEY。' -ForegroundColor Yellow
        Write-Host '  （key 只允许人工输入；本脚本与任何自动化都不会读取或持久化它。）' -ForegroundColor Yellow
    }
}
exit $(if ($healthy) { 0 } else { 3 })
