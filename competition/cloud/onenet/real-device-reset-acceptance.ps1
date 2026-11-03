# real-device-reset-acceptance.ps1 - 真机下行 RESET 闭环验收（真实 Bridge + 真实 fport）
#
# 目标：验证「网关自身 RESET」在**真实硬件**上闭环，而不是伪设备回执。
#
# 链路（全部真实）：
#   板端 homemon :9000
#     --hdc fport--> PC 127.0.0.1:9000
#     --mqtt_bridge.js（真实 Bridge，--status-tcp 拉状态 + --relay-to 接收 route）-->
#     --本地 Broker :1883--> gateway.js（真实代码）
#     --RESET--> home/dayu200-living/cmd --> Bridge 按 deviceId 路由 --> 板端 homemon 执行 reset
#     --板端回报 state=NORMAL--> Bridge --> Broker --> 网关收到真实回执
#
# 只有 OneNET 传输层是伪的（因为不需要真实密钥）；下行触发用 --reset-trigger 模拟
# OneNET property/set 到达。板端执行与回执都是真的。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File .\real-device-reset-acceptance.ps1 -Evidence <dir>
#
# 退出码：0 = 全部断言通过；2 = 前置不满足；1 = 有断言失败

[CmdletBinding()]
param(
    [string]$Evidence = 'D:\OpenHarmony\competition\evidence\2026-10-10-onenet-gateway-real-device',
    [string]$Hdc = 'D:\OpenHarmony\tools\hdc\hdc.exe',
    [int]$BrokerPort = 1883,
    [int]$FportPort = 9000,
    [int]$Seconds = 150
)

$ErrorActionPreference = 'Stop'

$Root      = 'D:\OpenHarmony\competition'
$OnenetDir = Join-Path $Root 'cloud\onenet'
$BrokerJs  = Join-Path $Root 'bridge\mqtt_broker.js'
$BridgeJs  = Join-Path $Root 'bridge\mqtt_bridge.js'
$ToolJs    = Join-Path $Root 'bridge\mqtt_tool.js'
$HarnessJs = Join-Path $OnenetDir 'real-device-harness.js'
$NodeExe   = (Get-Command node -ErrorAction Stop).Source
$DeviceId  = 'dayu200-living'
$TriggerTopic = 'onenet/test/property-set'

New-Item -ItemType Directory -Force -Path $Evidence | Out-Null
$EventsFile = Join-Path $Evidence 'gateway-reset-events.jsonl'
Remove-Item $EventsFile -ErrorAction SilentlyContinue
$script:msgFile = Join-Path $env:TEMP ("gw-reset-msg-{0}.json" -f $PID)

$script:results = @()
function Check([string]$Name, [bool]$Ok, [string]$Detail = '') {
    $script:results += [pscustomobject]@{ name = $Name; ok = $Ok; detail = $Detail }
    Write-Host ("  {0}  {1}{2}" -f $(if ($Ok) { 'PASS' } else { 'FAIL' }), $Name, $(if ($Detail) { "  -- $Detail" } else { '' }))
}
function Section([string]$T) { Write-Host ''; Write-Host ('-' * 66); Write-Host "---- $T" }

function Sh([string]$Command) {
    $o = & $Hdc shell $Command 2>&1
    return (($o | Out-String).Trim())
}

# JSON 必须走文件：PowerShell 会吞掉 --msg 里的双引号（bridge/README.md 已记录该坑）。
function Publish([string]$Topic, [string]$Json) {
    [System.IO.File]::WriteAllText($script:msgFile, $Json, [System.Text.UTF8Encoding]::new($false))
    & $NodeExe $ToolJs pub --broker "127.0.0.1:$BrokerPort" --topic $Topic --msg-file $script:msgFile | Out-Null
}

function Read-Events([string]$Path) {
    if (-not (Test-Path $Path)) { return @() }
    $raw = Get-Content -LiteralPath $Path -Encoding UTF8 -ErrorAction SilentlyContinue
    $out = @()
    foreach ($line in $raw) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        try { $out += ($line | ConvertFrom-Json) } catch { }
    }
    return $out
}

function Wait-For([scriptblock]$Probe, [int]$TimeoutSec) {
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        if (& $Probe) { return $true }
        Start-Sleep -Milliseconds 700
    }
    return $false
}

# ---------------------------------------------------------------- 0. 前置
Write-Host ('=' * 66)
Write-Host '真机下行 RESET 闭环验收（真实 fport + 真实 Bridge + 伪 OneNET 传输层）'
Write-Host ('=' * 66)
Write-Host "PC local time : $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')"
Write-Host "evidence dir  : $Evidence"

$targets = ((& $Hdc list targets 2>&1) | Out-String).Trim()
Write-Host "hdc targets   : $targets"
if ([string]::IsNullOrWhiteSpace($targets) -or $targets -match 'Empty') {
    Write-Host 'BLOCKER: 设备未接入，无法继续'; exit 2
}
$ps = Sh 'ps -ef | grep [h]omemon'
if ([string]::IsNullOrWhiteSpace($ps) -or $ps -match 'grep') {
    Write-Host 'BLOCKER: 板端 homemon 未运行'; exit 2
}
Write-Host "homemon       : $ps"
Write-Host "board date    : $(Sh 'date')"

# 板端必须先处于 NORMAL，才能观察 RESET 的“离开 ALARM”回执
Sh ': > /data/homemon/control' | Out-Null
Sh 'echo reset >> /data/homemon/control' | Out-Null
Start-Sleep -Seconds 3
$state0 = (Sh 'cat /data/homemon/status.json' | ConvertFrom-Json).state
Write-Host "board state   : $state0"
Check 'board is NORMAL before the test' ($state0 -eq 'NORMAL') "state=$state0"

# ---------------------------------------------------------------- 1. fport + Broker + Bridge
Section 'hdc fport + 本地 Broker + 真实 Bridge'
& $Hdc fport rm "tcp:$FportPort" "tcp:$FportPort" | Out-Null
& $Hdc fport "tcp:$FportPort" 'tcp:9000' | Out-Null
Start-Sleep -Milliseconds 700
$fportLs = ((& $Hdc fport ls 2>&1) | Out-String).Trim()
Write-Host "  hdc fport ls: $fportLs"
Check 'hdc fport established' ($fportLs -match 'tcp:9000')

$brokerOut = Join-Path $Evidence 'reset-broker.out.log'
$brokerErr = Join-Path $Evidence 'reset-broker.err.log'
$broker = Start-Process -FilePath $NodeExe -ArgumentList @($BrokerJs, "$BrokerPort") `
    -NoNewWindow -PassThru -RedirectStandardOutput $brokerOut -RedirectStandardError $brokerErr
Start-Sleep -Milliseconds 900
Check 'local MQTT broker started' (-not $broker.HasExited)

$bridgeOut = Join-Path $Evidence 'reset-bridge.out.log'
$bridgeErr = Join-Path $Evidence 'reset-bridge.err.log'
# --status-tcp 经 fport 拉板端真实状态；--relay-to 让 Bridge 接收 homemon 广播的 route 行
$bridge = Start-Process -FilePath $NodeExe `
    -ArgumentList @($BridgeJs, '--broker', "127.0.0.1:$BrokerPort", '--status-tcp', "127.0.0.1:$FportPort", '--relay-to', "127.0.0.1:$FportPort") `
    -NoNewWindow -PassThru -RedirectStandardOutput $bridgeOut -RedirectStandardError $bridgeErr
Start-Sleep -Seconds 3
Check 'real bridge process alive' (-not $bridge.HasExited)

$bridgeLog = Get-Content -LiteralPath $bridgeOut -Encoding UTF8 -ErrorAction SilentlyContinue
$gotNode = @($bridgeLog | Where-Object { $_ -match '已接入节点' }).Count -ge 1
$gotStatus = @($bridgeLog | Where-Object { $_ -match "→ home/$DeviceId/status" }).Count -ge 1
Write-Host '  bridge log (first 8 lines):'
$bridgeLog | Select-Object -First 8 | ForEach-Object { Write-Host "    $_" }
Check 'bridge attached the board node over hdc fport' $gotNode
Check 'bridge published real board status to MQTT' $gotStatus

# ---------------------------------------------------------------- 2. 网关（伪 OneNET 传输层）
Section '启动网关并确认订阅 + 下行触发订阅'
$harnessOut = Join-Path $Evidence 'reset-harness.out.log'
$harnessErr = Join-Path $Evidence 'reset-harness.err.log'
$harness = Start-Process -FilePath $NodeExe `
    -ArgumentList @($HarnessJs, '--events', $EventsFile, '--broker', "mqtt://127.0.0.1:$BrokerPort",
                    '--seconds', "$Seconds", '--device-name', $DeviceId, '--reset-mode', 'self',
                    '--reset-trigger', $TriggerTopic) `
    -WorkingDirectory $OnenetDir -NoNewWindow -PassThru `
    -RedirectStandardOutput $harnessOut -RedirectStandardError $harnessErr
Start-Sleep -Seconds 2
Check 'gateway harness alive' (-not $harness.HasExited)

$subOk = Wait-For -TimeoutSec 20 -Probe {
    $b = Get-Content -LiteralPath $brokerOut -Encoding UTF8 -ErrorAction SilentlyContinue
    @($b | Where-Object { $_ -match 'SUBSCRIBE .+ home/\+/status' }).Count -ge 1
}
Check 'gateway subscribed to home/+/status' $subOk

$trigOk = Wait-For -TimeoutSec 15 -Probe {
    @(Read-Events $EventsFile | Where-Object { $_.kind -eq 'triggerSubscribed' -and $_.ok }).Count -ge 1
}
Check 'reset trigger subscription established' $trigOk

# 网关必须已经从真实状态里登记了该设备（self 模式靠 deviceName 定位目标）
$regOk = Wait-For -TimeoutSec 25 -Probe {
    @(Read-Events $EventsFile | Where-Object { $_.kind -eq 'status' -and $_.deviceId -eq $DeviceId }).Count -ge 1
}
Check 'gateway registered the real board device' $regOk

# ---------------------------------------------------------------- 3. 真机告警（RESET 的前置条件）
Section '板端注入 sos 产生真实告警'
Sh 'echo sos >> /data/homemon/control' | Out-Null
$alarmOk = Wait-For -TimeoutSec 45 -Probe {
    @(Read-Events $EventsFile | Where-Object { $_.kind -eq 'alarm' }).Count -ge 1
}
$boardNow = Sh 'cat /data/homemon/status.json'
$boardAlarmId = ''
try { $boardAlarmId = ($boardNow | ConvertFrom-Json).alarm.id } catch { }
Write-Host "  board state=$(($boardNow | ConvertFrom-Json).state) alarmId=$boardAlarmId"
Check 'real board alarm reached the gateway' $alarmOk

# 等 Bridge 把 ALARM 状态也同步给网关（RESET 目标判定用网关自己的快照）
$gateAlarm = Wait-For -TimeoutSec 25 -Probe {
    @(Read-Events $EventsFile | Where-Object { $_.kind -eq 'status' -and $_.state -eq 'ALARM' }).Count -ge 1
}
Check 'gateway sees the board as ALARM' $gateAlarm

# 关键：必须确认**板端自己**也已经进入 ALARM 再下发 RESET。
# 否则会在板端仍处于告警前的 NORMAL 时下发，设备随后上报的旧 NORMAL 会被误当成回执。
$boardAlarmReady = Wait-For -TimeoutSec 25 -Probe {
    $s = Sh 'cat /data/homemon/status.json'
    if ([string]::IsNullOrWhiteSpace($s)) { return $false }
    try { return (($s | ConvertFrom-Json).state -eq 'ALARM') } catch { return $false }
}
$boardStateBeforeReset = ''
try { $boardStateBeforeReset = (Sh 'cat /data/homemon/status.json' | ConvertFrom-Json).state } catch { }
Write-Host "  board state before RESET: $boardStateBeforeReset"
Check 'board itself is in ALARM before RESET' $boardAlarmReady

# ---------------------------------------------------------------- 4. 下行 RESET 闭环
Section '触发网关自身 RESET（等价 OneNET property/set）'
$resetCountBefore = @(Read-Events $EventsFile | Where-Object { $_.kind -eq 'resetResult' }).Count
Publish $TriggerTopic '{"trigger":"reset"}'

$resetDone = Wait-For -TimeoutSec 30 -Probe {
    @(Read-Events $EventsFile | Where-Object { $_.kind -eq 'resetResult' }).Count -gt $resetCountBefore
}
Check 'gateway handled the RESET command' $resetDone

$ev = Read-Events $EventsFile
$reset = @($ev | Where-Object { $_.kind -eq 'resetResult' }) | Select-Object -Last 1
if ($reset) { Write-Host "  reset result: ok=$($reset.ok) message=$($reset.message)" }
Check 'gateway RESET succeeded against REAL device receipt' ($reset -and $reset.ok) "ok=$($reset.ok) msg=$($reset.message)"

# 板端必须真的执行了 reset。
# 注意：homemon 每 report_every_sec（演示配置为 3 秒）才刷新一次 status.json，
# 因此必须**有界等待**它反映出复位，不能在下发后立刻读一次就下结论。
$boardLeftAlarm = Wait-For -TimeoutSec 20 -Probe {
    $s = Sh 'cat /data/homemon/status.json'
    if ([string]::IsNullOrWhiteSpace($s)) { return $false }
    try { return (($s | ConvertFrom-Json).state -ne 'ALARM') } catch { return $false }
}
$boardStateAfter = ''
try { $boardStateAfter = (Sh 'cat /data/homemon/status.json' | ConvertFrom-Json).state } catch { }
Write-Host "  board state after RESET: $boardStateAfter"
Check 'board really left ALARM after RESET' $boardLeftAlarm "state=$boardStateAfter"

$hlog = Sh 'tail -n 6 /data/homemon/homemon.log'
Write-Host '  homemon.log tail:'
$hlog.Split("`n") | Where-Object { $_ } | ForEach-Object { Write-Host "    $_" }
Check 'homemon log shows the state reset' ($hlog -match '状态复位')

# 网关也必须观察到设备离开 ALARM
Section '网关是否观察到真实回执'
$ev = Read-Events $EventsFile
$afterReset = @($ev | Where-Object { $_.kind -eq 'status' -and $_.state -ne 'ALARM' })
Check 'gateway observed the post-RESET state' ($afterReset.Count -ge 1)

# ---------------------------------------------------------------- 5. 清理
Section '清理'
try { if (-not $harness.HasExited) { Stop-Process -Id $harness.Id -Force } } catch { }
try { if (-not $bridge.HasExited) { Stop-Process -Id $bridge.Id -Force } } catch { }
try { if (-not $broker.HasExited) { Stop-Process -Id $broker.Id -Force } } catch { }
Start-Sleep -Milliseconds 800
& $Hdc fport rm "tcp:$FportPort" "tcp:$FportPort" | Out-Null
$fportAfter = ((& $Hdc fport ls 2>&1) | Out-String).Trim()
Check 'fport rule removed' (-not ($fportAfter -match "tcp:$FportPort"))
$still = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -eq $BrokerPort }
Check 'broker port released' (-not $still)

# ---------------------------------------------------------------- 汇总
$passed = @($script:results | Where-Object { $_.ok }).Count
$total = $script:results.Count
Write-Host ''
Write-Host ('=' * 66)
Write-Host "RESULT: $passed/$total checks passed"
if ($passed -ne $total) {
    Write-Host ('FAILED: ' + (($script:results | Where-Object { -not $_.ok } | ForEach-Object { $_.name }) -join ' | '))
}
Write-Host ('=' * 66)

[pscustomobject]@{
    pcLocalTime = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')
    hdcTarget = $targets
    deviceDate = (Sh 'date')
    deviceId = $DeviceId
    boardAlarmId = $boardAlarmId
    boardStateAfterReset = $boardStateAfter
    results = $script:results
    passed = $passed
    total = $total
} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $Evidence 'reset-acceptance-results.json') -Encoding UTF8

if ($passed -ne $total) { exit 1 }
exit 0
