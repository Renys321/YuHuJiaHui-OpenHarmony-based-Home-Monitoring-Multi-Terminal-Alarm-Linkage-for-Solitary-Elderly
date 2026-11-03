# real-device-acceptance.ps1 - DAYU200 真机分层验收（本地链路 + 伪 OneNET 传输层）
#
# 为什么用 PowerShell 编排：受限沙箱下 Node 无法以管道 stdio 调用 hdc（hdc 会常驻 server 并
# 持有管道，导致 Node 的 spawnSync 永不返回）。因此由 PowerShell 负责所有 hdc 操作与进程编排，
# Node 只负责 MQTT 侧（真实 Broker 客户端 + 真实网关代码）。
#
# 链路：
#   板端 homemon :9000
#     -> hdc shell 轮询 status.json（真实板端状态，不做任何伪造）
#     -> 本地 Broker :1883（真实 MQTT）
#     -> gateway.js（真实订阅 home/+/status，OneNET 侧为伪传输层）
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File .\real-device-acceptance.ps1 `
#     -Evidence <dir> [-Hdc <path>] [-BrokerPort 1883] [-Seconds 150]
#
# 退出码：0 = 全部断言通过；2 = 前置不满足；1 = 有断言失败

[CmdletBinding()]
param(
    [string]$Evidence = 'D:\OpenHarmony\competition\evidence\2026-10-10-onenet-gateway-real-device',
    [string]$Hdc = 'D:\OpenHarmony\tools\hdc\hdc.exe',
    [int]$BrokerPort = 1883,
    [int]$Seconds = 150
)

$ErrorActionPreference = 'Stop'

$Root      = 'D:\OpenHarmony\competition'
$OnenetDir = Join-Path $Root 'cloud\onenet'
$BrokerJs  = Join-Path $Root 'bridge\mqtt_broker.js'
$ToolJs    = Join-Path $Root 'bridge\mqtt_tool.js'
$HarnessJs = Join-Path $OnenetDir 'real-device-harness.js'
$NodeExe   = (Get-Command node -ErrorAction Stop).Source

New-Item -ItemType Directory -Force -Path $Evidence | Out-Null
$EventsFile = Join-Path $Evidence 'gateway-events.jsonl'
Remove-Item $EventsFile -ErrorAction SilentlyContinue
$script:msgFile = Join-Path $env:TEMP ("gw-acceptance-msg-{0}.json" -f $PID)

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

function Publish([string]$Topic, [string]$Json) {
    # 重要：绝不能用 --msg 传 JSON。PowerShell 会吞掉内层双引号，把 {"deviceId":...} 变成
    # {deviceId:...}，Broker 与网关都会判为非法 JSON。bridge/README.md:57 已记录该坑，
    # 官方做法是写文件后用 --msg-file。
    [System.IO.File]::WriteAllText($script:msgFile, $Json, [System.Text.UTF8Encoding]::new($false))
    & $NodeExe $ToolJs pub --broker "127.0.0.1:$BrokerPort" --topic $Topic --msg-file $script:msgFile | Out-Null
}

function Read-Events([string]$Path) {
    if (-not (Test-Path $Path)) { return @() }
    # 必须显式 UTF8：事件文件是 Node 以 UTF-8 写出的，PS 5.1 的 Get-Content 默认按 ANSI 读取，
    # 会把 room=客厅 这类中文变成乱码，产生假失败。
    $raw = Get-Content -LiteralPath $Path -Encoding UTF8 -ErrorAction SilentlyContinue
    $out = @()
    foreach ($line in $raw) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        try { $out += ($line | ConvertFrom-Json) } catch { }
    }
    return $out
}

# ---------------------------------------------------------------- 0. 前置
Write-Host ('=' * 66)
Write-Host 'DAYU200 真机分层验收（本地链路 + 伪 OneNET 传输层）'
Write-Host ('=' * 66)
$pcLocal = Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz'
$pcUtc = (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd HH:mm:ss')
Write-Host "PC local time : $pcLocal"
Write-Host "PC UTC        : $pcUtc"
Write-Host "evidence dir  : $Evidence"
Write-Host "node          : $(& $NodeExe --version)"

$targets = ((& $Hdc list targets 2>&1) | Out-String).Trim()
Write-Host "hdc targets   : $targets"
if ([string]::IsNullOrWhiteSpace($targets) -or $targets -match 'Empty') {
    Write-Host 'BLOCKER: 设备未接入，无法继续'
    exit 2
}

Write-Host "device date   : $(Sh 'date')"
Write-Host "device date -u: $(Sh 'date -u')"

Section '制品与板端一致性'
$localSha = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $Root 'southbound\out\homemon-arm')).Hash
$boardSha = (Sh 'sha256sum /data/homemon/homemon').Split(' ')[0]
Write-Host "  local homemon-arm : $localSha"
Write-Host "  board homemon     : $boardSha"
Check 'board homemon matches authoritative artifact' ($localSha.ToLower() -eq $boardSha.ToLower())

$ps = Sh 'ps -ef | grep [h]omemon'
Write-Host "  homemon process   : $ps"
Check 'homemon running on board' (-not [string]::IsNullOrWhiteSpace($ps) -and $ps -notmatch 'grep')

# ---------------------------------------------------------------- 1. 启动链路
Section '启动本地 Broker + 网关(pseudo-OneNET)'
$brokerOut = Join-Path $Evidence 'broker.out.log'
$brokerErr = Join-Path $Evidence 'broker.err.log'
$broker = Start-Process -FilePath $NodeExe -ArgumentList @($BrokerJs, "$BrokerPort") `
    -NoNewWindow -PassThru -RedirectStandardOutput $brokerOut -RedirectStandardError $brokerErr
Start-Sleep -Milliseconds 900
Check 'local MQTT broker started' (-not $broker.HasExited) "pid=$($broker.Id)"

$harnessOut = Join-Path $Evidence 'gateway-harness.out.log'
$harnessErr = Join-Path $Evidence 'gateway-harness.err.log'
$harness = Start-Process -FilePath $NodeExe `
    -ArgumentList @($HarnessJs, '--events', $EventsFile, '--broker', "mqtt://127.0.0.1:$BrokerPort", '--seconds', "$Seconds") `
    -WorkingDirectory $OnenetDir -NoNewWindow -PassThru `
    -RedirectStandardOutput $harnessOut -RedirectStandardError $harnessErr
Start-Sleep -Seconds 2
Check 'gateway harness started' (-not $harness.HasExited) "pid=$($harness.Id)"

# 订阅是异步完成的。权威证据是 Broker 自己的日志（它记录了 CONNACK 与 SUBSCRIBE），
# 而不是网关的日志行——后者只走 stdout，不进事件文件。
$subDeadline = (Get-Date).AddSeconds(20)
$subscribed = $false
while ((Get-Date) -lt $subDeadline -and -not $subscribed) {
    if (Test-Path $brokerOut) {
        $blog = Get-Content -LiteralPath $brokerOut -Encoding UTF8 -ErrorAction SilentlyContinue
        $subscribed = @($blog | Where-Object { $_ -match 'SUBSCRIBE .+ home/\+/status' }).Count -ge 1
    }
    if (-not $subscribed) { Start-Sleep -Milliseconds 500 }
}
Check 'gateway subscribed to local broker (broker SUBSCRIBE log)' $subscribed

# ---------------------------------------------------------------- 2. 真实板端状态上云
Section '真实板端状态 -> Broker -> 网关 -> OneNET property/post'
$deadline = (Get-Date).AddSeconds(35)
$pumped = 0
while ((Get-Date) -lt $deadline) {
    $status = Sh 'cat /data/homemon/status.json'
    if (-not [string]::IsNullOrWhiteSpace($status)) {
        try {
            $null = $status | ConvertFrom-Json
            Publish 'home/dayu200-living/status' $status
            $pumped++
        } catch { Write-Host "  (skip unparseable status: $($status.Substring(0,[Math]::Min(60,$status.Length))))" }
    }
    $ev = Read-Events $EventsFile
    if (@($ev | Where-Object { $_.kind -eq 'property' }).Count -ge 2) { break }
    Start-Sleep -Seconds 2
}
Write-Host "  published $pumped real board status lines"
$ev = Read-Events $EventsFile
$props = @($ev | Where-Object { $_.kind -eq 'property' })
Check 'real board status reached OneNET property/post' ($props.Count -ge 1) "count=$($props.Count)"
if ($props.Count -ge 1) {
    $p = $props[0]
    Write-Host "  observed deviceId=$($p.deviceId) room=$($p.room) state=$($p.state)"
    Check 'cloud payload preserved deviceId and room' ($p.deviceId -eq 'dayu200-living' -and $p.room -eq '客厅')
    Check 'cloud timestamp is 13-digit ms from PC clock' ($p.timestampMs -ge 1000000000000 -and $p.timestampMs -le 9999999999999)
}
$rejected = @($ev | Where-Object { $_.kind -eq 'rejected' })
Write-Host "  rejected events: $($rejected.Count)"
foreach ($r in $rejected) { Write-Host "    REJECT code=$($r.code) device=$($r.deviceId)" }

# ---------------------------------------------------------------- 3. 稳定状态限频
Section '稳定状态限频（避免每 3 秒刷云）'
$before = @(Read-Events $EventsFile | Where-Object { $_.kind -eq 'property' }).Count
1..4 | ForEach-Object {
    $s = Sh 'cat /data/homemon/status.json'
    if ($s) { Publish 'home/dayu200-living/status' $s }
    Start-Sleep -Milliseconds 700
}
$after = @(Read-Events $EventsFile | Where-Object { $_.kind -eq 'property' }).Count
Write-Host "  property publishes before=$before after=$after (same state)"
Check 'stable state was rate limited' (($after - $before) -le 1) "delta=$($after - $before)"

# ---------------------------------------------------------------- 4. 板端告警 -> safetyAlarm
Section '板端真实告警 -> safetyAlarm event'
# 演示配置的 no_motion_sec=30 依赖 PIR 连续 30 秒无活动；当前 GPIO29 悬空持续触发活动，
# 这条路径不可靠。因此改用板端 control 通道注入 sos：这是 homemon 的 MANUAL_SOS 真实告警
# 路径（southbound/README.md 明确说明与实体按钮同一判定/执行路径），仍由真实板端产生 alarmId。
# 先清空 control：上一轮追加的 sos 会被重启后的 homemon 重新读取并重复告警，
# 这会让后面的“同 alarmId 不重复”断言失去意义（板端会不断产生新 alarmId）。
Sh ': > /data/homemon/control' | Out-Null
Start-Sleep -Seconds 3

$preStatus = Sh 'cat /data/homemon/status.json'
$preAlarmId = ''
try { $preAlarmId = ($preStatus | ConvertFrom-Json).alarm.id } catch { }
Write-Host "  pre-trigger state : $((($preStatus | ConvertFrom-Json -ErrorAction SilentlyContinue).state)) alarmId='$preAlarmId'"
Write-Host "  injecting sos via board control file"
Sh 'echo sos >> /data/homemon/control' | Out-Null

$alarmDeadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $alarmDeadline) {
    $s = Sh 'cat /data/homemon/status.json'
    if ($s) { try { Publish 'home/dayu200-living/status' $s } catch { } }
    $ev = Read-Events $EventsFile
    if (@($ev | Where-Object { $_.kind -eq 'alarm' }).Count -ge 1) { break }
    Start-Sleep -Seconds 2
}
$ev = Read-Events $EventsFile
$alarms = @($ev | Where-Object { $_.kind -eq 'alarm' })
Check 'board alarm produced a safetyAlarm event' ($alarms.Count -ge 1) "count=$($alarms.Count)"
if ($alarms.Count -ge 1) {
    $pinnedAlarmId = $alarms[0].alarmId
    Write-Host "  observed alarmId=$pinnedAlarmId type=$($alarms[0].type) device=$($alarms[0].deviceId)"
    Check 'alarm event carries a real board alarmId' (-not [string]::IsNullOrWhiteSpace($pinnedAlarmId))
    Check 'alarm type is MANUAL_SOS' ($alarms[0].type -eq 'MANUAL_SOS') "type=$($alarms[0].type)"
    $boardAlarm = Sh 'cat /data/homemon/status.json'
    Check 'gateway alarmId matches the board status.json alarmId' ($boardAlarm -match [regex]::Escape($pinnedAlarmId))

    # 同 alarmId 去重：只在“该 alarmId 的事件数”上断言，避免被板端新告警干扰。
    Section "同一 alarmId 不重复告警（pinned $pinnedAlarmId）"
    $countForIdBefore = @(Read-Events $EventsFile | Where-Object { $_.kind -eq 'alarm' -and $_.alarmId -eq $pinnedAlarmId }).Count
    1..5 | ForEach-Object {
        $s = Sh 'cat /data/homemon/status.json'
        if ($s) { Publish 'home/dayu200-living/status' $s }
        Start-Sleep -Milliseconds 800
    }
    $countForIdAfter = @(Read-Events $EventsFile | Where-Object { $_.kind -eq 'alarm' -and $_.alarmId -eq $pinnedAlarmId }).Count
    Write-Host "  events for $pinnedAlarmId : before=$countForIdBefore after=$countForIdAfter"
    Check 'same alarmId was not re-alarmed' ($countForIdAfter -eq $countForIdBefore) "before=$countForIdBefore after=$countForIdAfter"
}

# ---------------------------------------------------------------- 5. 板端证据
Section '板端原始证据'
$hlog = Sh 'tail -n 30 /data/homemon/homemon.log'
$sjson = Sh 'cat /data/homemon/status.json'
$safety = Sh 'cat /data/homemon/safety.log'
$hlog | Set-Content -LiteralPath (Join-Path $Evidence 'board-homemon.log') -Encoding UTF8
$sjson | Set-Content -LiteralPath (Join-Path $Evidence 'board-status.json') -Encoding UTF8
$safety | Set-Content -LiteralPath (Join-Path $Evidence 'board-safety.log') -Encoding UTF8
Write-Host '  homemon.log tail:'
$hlog.Split("`n") | Where-Object { $_ } | Select-Object -Last 12 | ForEach-Object { Write-Host "    $_" }
Write-Host "  status.json: $($sjson.Substring(0,[Math]::Min(200,$sjson.Length)))"
Check 'board status.json is valid JSON with the expected deviceId' ($sjson -match '"deviceId":"dayu200-living"')

# ---------------------------------------------------------------- 6. 清理
Section '清理'
try { if (-not $harness.HasExited) { Stop-Process -Id $harness.Id -Force } } catch { }
try { if (-not $broker.HasExited) { Stop-Process -Id $broker.Id -Force } } catch { }
Start-Sleep -Milliseconds 600
$still = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -eq $BrokerPort }
Check 'broker port released after cleanup' (-not $still)
Check 'no gateway process left' ($harness.HasExited)

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

$summary = [pscustomobject]@{
    pcLocalTime = $pcLocal
    pcUtc = $pcUtc
    hdcTarget = $targets
    deviceDate = (Sh 'date')
    deviceDateUtc = (Sh 'date -u')
    localHomemonSha256 = $localSha
    boardHomemonSha256 = $boardSha
    results = $script:results
    passed = $passed
    total = $total
}
$summary | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $Evidence 'real-device-results.json') -Encoding UTF8

if ($passed -ne $total) { exit 1 }
exit 0
