# public-sync supervisor 验收取证（只读）。
#
# 不启动/停止任何服务。只读取 runtime lock/state/log 与 node 进程树，
# 统计真实 [cloud-sync] status=202 证据，并可选做稳定性观察。
#
# 用法：
#   verify-supervisor-acceptance.ps1                          # 单次快照
#   verify-supervisor-acceptance.ps1 -WatchMinutes 15 -MinPerDevice 10
param(
    [int]$WatchMinutes = 0,
    [int]$IntervalSeconds = 30,
    [int]$MinPerDevice = 3
)

$ErrorActionPreference = 'Stop'
$Base = 'D:\OpenHarmony\competition\evidence\2026-10-24-public-sync-supervisor-candidate'
$Lock = Join-Path $Base 'runtime\public-sync-supervisor.lock'
$State = Join-Path $Base 'runtime\public-sync-supervisor.state.json'
$Log = Join-Path $Base 'runtime\public-sync-supervisor.log'
$Devices = @('esp32-kitchen', 'esp32-bath', 'dayu200-living')

function Get-NodeProcesses() {
    return @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine })
}

function Get-Snapshot([int]$sampleIndex) {
    $procs = Get-NodeProcesses
    $supervisors = @($procs | Where-Object { $_.CommandLine -match 'public-sync-supervisor\.js' })
    $workers = @($procs | Where-Object { $_.CommandLine -match 'public-sync-worker\.js' -and $_.CommandLine -notmatch 'public-sync-supervisor\.js' })
    $brokers = @($procs | Where-Object { $_.CommandLine -match 'mqtt_broker\.js' })
    $bridges = @($procs | Where-Object { $_.CommandLine -match 'mqtt_bridge\.js' })

    $lockPid = 0
    if (Test-Path $Lock) {
        try { $lockPid = [int](Get-Content -LiteralPath $Lock -Raw).Trim() } catch { $lockPid = 0 }
    }
    $stateObj = $null
    if (Test-Path $State) {
        try { $stateObj = Get-Content -LiteralPath $State -Raw | ConvertFrom-Json } catch { $stateObj = $null }
    }

    $counts = [ordered]@{}
    foreach ($d in $Devices) { $counts[$d] = 0 }
    $total202 = 0
    $logBytes = 0
    if (Test-Path $Log) {
        $logBytes = (Get-Item $Log).Length
        $text = Get-Content -LiteralPath $Log -Raw
        if ($text) {
            $total202 = ([regex]::Matches($text, 'status=202')).Count
            foreach ($d in $Devices) {
                $counts[$d] = ([regex]::Matches($text, "device=$([regex]::Escape($d))[^\r\n]*status=202")).Count
            }
        }
    }

    $parentOk = $false
    if ($stateObj -and $stateObj.workerPid -gt 0 -and $workers.Count -ge 1) {
        $worker = $workers | Where-Object { $_.ProcessId -eq [int]$stateObj.workerPid } | Select-Object -First 1
        if ($worker -and $supervisors.Count -eq 1) {
            $parentOk = ([int]$worker.ParentProcessId -eq [int]$supervisors[0].ProcessId)
        }
    }

    return [pscustomobject]@{
        sample = $sampleIndex
        at = (Get-Date).ToString('o')
        supervisorCount = $supervisors.Count
        workerCount = $workers.Count
        brokerCount = $brokers.Count
        bridgeCount = $bridges.Count
        supervisorPids = @($supervisors | Select-Object -ExpandProperty ProcessId)
        workerPids = @($workers | Select-Object -ExpandProperty ProcessId)
        lockPid = $lockPid
        state = if ($stateObj) { $stateObj.state } else { 'NO_STATE' }
        stateSupervisorPid = if ($stateObj) { [int]$stateObj.supervisorPid } else { 0 }
        stateWorkerPid = if ($stateObj) { [int]$stateObj.workerPid } else { 0 }
        restartCount = if ($stateObj) { [int]$stateObj.restartCount } else { 0 }
        heartbeatAt = if ($stateObj) { [long]$stateObj.heartbeatAt } else { 0 }
        workerParentIsSupervisor = $parentOk
        status202Total = $total202
        status202ByDevice = $counts
        logBytes = $logBytes
    }
}

function Test-Snapshot([object]$s, [int]$requiredPerDevice, [switch]$RequireAllDevices) {
    $problems = @()
    if ($s.supervisorCount -ne 1) { $problems += "supervisorCount=$($s.supervisorCount) (expected 1)" }
    if ($s.workerCount -ne 1) { $problems += "workerCount=$($s.workerCount) (expected 1)" }
    if ($s.state -ne 'HEALTHY') { $problems += "state=$($s.state) (expected HEALTHY)" }
    if ($s.lockPid -le 0) { $problems += 'lock missing' }
    elseif ($s.stateSupervisorPid -gt 0 -and $s.lockPid -ne $s.stateSupervisorPid) {
        $problems += "lockPid=$($s.lockPid) != stateSupervisorPid=$($s.stateSupervisorPid)"
    }
    if ($s.workerParentIsSupervisor -ne $true) { $problems += 'worker parent is not the supervisor' }
    if ($RequireAllDevices) {
        foreach ($d in $Devices) {
            if ($s.status202ByDevice[$d] -lt $requiredPerDevice) {
                $problems += "$d status202=$($s.status202ByDevice[$d]) < $requiredPerDevice"
            }
        }
    }
    return $problems
}

Write-Host '=== public-sync supervisor 验收快照 ===' -ForegroundColor Cyan
$first = Get-Snapshot 0
$first | ConvertTo-Json -Depth 6
$firstProblems = Test-Snapshot $first 0
if ($firstProblems.Count -gt 0) {
    Write-Host '单次快照未通过：' -ForegroundColor Red
    $firstProblems | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
} else {
    Write-Host '单次快照通过：1 supervisor + 1 worker、lock/state 一致、state=HEALTHY、父子关系正确。' -ForegroundColor Green
}

if ($WatchMinutes -le 0) {
    Write-Host ''
    Write-Host "202 证据（累计）：$($first.status202Total) 条；按设备：$($first.status202ByDevice | ConvertTo-Json -Compress)"
    Write-Host 'API lastSeen 需另用 2026-10-24-app-p0-sensors-runtime-gate\probe-authenticated-api.ps1（交互输入账号）核对。'
    Write-Host '注意：202 只在自然上报时出现；retained 只会在订阅瞬间出现一次，不能凑数。'
    if ($firstProblems.Count -gt 0) { exit 1 }
    exit 0
}

$watchProblems = @()
$supervisorPidBaseline = $first.supervisorPids
$maxWorkerCount = $first.workerCount
$samples = @($first)
$previous = $first
$deadline = (Get-Date).AddMinutes($WatchMinutes)
$sampleIndex = 1
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds $IntervalSeconds
    $s = Get-Snapshot $sampleIndex
    $samples += $s
    $sampleIndex += 1
    $maxWorkerCount = [Math]::Max($maxWorkerCount, $s.workerCount)
    $p = Test-Snapshot $s 0
    foreach ($item in $p) { $watchProblems += "sample=$($s.sample) $item" }
    if (($supervisorPidBaseline | Sort-Object) -ne ($s.supervisorPids | Sort-Object)) {
        $watchProblems += "sample=$($s.sample) supervisor PID changed: $($supervisorPidBaseline -join ',') -> $($s.supervisorPids -join ',')"
    }
    if ($s.restartCount -ne $previous.restartCount) {
        Write-Host "[info] sample=$($s.sample) restartCount $($previous.restartCount) -> $($s.restartCount)（预期：受控 kill 一次）" -ForegroundColor Yellow
    }
    Write-Host ("[{0}] sup={1} workers={2} state={3} restart={4} 202_total={5} kitchen={6} bath={7} living={8}" -f `
        $s.at, ($s.supervisorPids -join ','), ($s.workerPids -join ','), $s.state, $s.restartCount, `
        $s.status202Total, $s.status202ByDevice['esp32-kitchen'], $s.status202ByDevice['esp32-bath'], $s.status202ByDevice['dayu200-living'])
    $previous = $s
}

$final = $samples[-1]
$finalProblems = Test-Snapshot $final $MinPerDevice -RequireAllDevices
foreach ($item in $finalProblems) { $watchProblems += "final $item" }

foreach ($d in $Devices) {
    if ($final.status202ByDevice[$d] -le $first.status202ByDevice[$d]) {
        $watchProblems += "$d status202 did not increase during watch ($($first.status202ByDevice[$d]) -> $($final.status202ByDevice[$d]))"
    }
}
if ($final.restartCount -ne $first.restartCount) {
    Write-Host "[info] restartCount changed during watch: $($first.restartCount) -> $($final.restartCount)" -ForegroundColor Yellow
}
if ($maxWorkerCount -ne 1) {
    $watchProblems += "max workerCount=$maxWorkerCount (double instance observed)"
}

Write-Host ''
$watchProblems = @($watchProblems | Select-Object -Unique)
if ($watchProblems.Count -gt 0) {
    Write-Host '=== WATCH FAIL ===' -ForegroundColor Red
    $watchProblems | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
    Write-Host ''
    Write-Host "累计 202：$($final.status202Total)；按设备：$($final.status202ByDevice | ConvertTo-Json -Compress)"
    exit 1
}

Write-Host '=== WATCH PASS ===' -ForegroundColor Green
Write-Host "观察 $WatchMinutes 分钟：supervisor PID 稳定 $($final.supervisorPids -join ',')；worker 始终 1 个（最终 $($final.workerPids -join ',')）。"
Write-Host "累计 202：$($final.status202Total)；按设备：$($final.status202ByDevice | ConvertTo-Json -Compress)"
Write-Host 'API lastSeen 仍需交互探针二次核对（lastSeenTs 必须前进）。'
exit 0
