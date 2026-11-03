#Requires -Version 5.1
<#
.SYNOPSIS
  一键验收：同时启动双串口采集 + 只读现场监测（MQTT/status.json/public-sync 日志），
  操作者用快捷键/回车记录“按键时刻、ACK 时刻、LED/语音观察”，结束时输出证据小结。

.DESCRIPTION
  背景：厨房(COM5)/卫生间(COM4) 两板“实体按键 -> 本地语音+LED -> APP/DAYU 告警
  -> 用户 ACK -> 设备 ACKED 回执”的真实验收。采集与监测均只读：
    - dual-serial-capture.ps1 只接收串口，不发送任何字节；
    - field-monitor.js 只 CONNECT/SUBSCRIBE/PINGREQ，不 publish、不 ACK、不重启服务。
  本脚本不修改固件、不烧录、不打开 1883/9101/9001 之外的任何服务端口。

  操作者按键：
    Enter 通用事件标记       k 厨房实体 KEY0 按下      b 卫生间实体 SOS 按下
    a     APP/DAYU 点“确认/ACK”    l  目视 LED        s  听到语音
    n     输入备注（回车结束）      q  结束验收
  也可直接输入文本行（以 > 开头可省略），写入 events.csv 的 note 列。

.PARAMETER BathCom / KitchenCom
  两块板的串口，默认 COM4 / COM5（卫生间 / 厨房）。

.PARAMETER Seconds
  事件观察窗口（秒），默认 600。串口/监测进程会比它多活 20 秒以便收尾。

.PARAMETER OutDir
  输出目录。默认 <脚本目录>\logs\accept-<yyyyMMdd-HHmmss>\。
  结构：serial\(bath.log kitchen.log merged.log) monitor\(mqtt-status.log snapshots.log ack-events.log markers.log)
        serial-console.log monitor-console.log events.csv SUMMARY.txt

.PARAMETER NoSerial
  跳过双串口采集（仅监测 + 事件记录）。用于没有空闲 COM4/COM5 时的演练/自检。

.PARAMETER NoMonitor
  跳过 field-monitor.js（仅串口 + 事件记录）。

.PARAMETER SerialDir
  指定已有串口日志目录（配合 -NoSerial 做离线小结）。

.PARAMETER PublicSyncLog
  public-sync supervisor 日志路径。默认 competition\bridge\_test\current-runtime\supervisor\public-sync-supervisor.log。

.PARAMETER BridgeLog
  可选：bridge 控制台日志文件（如已有）。用于提取“命令已写入节点 ...”下行证据。

.PARAMETER SelfTest
  离线自检：参数解析/事件 CSV/证据提取/小结逻辑；不打开串口、不启动监测、不占 COM4/COM5。

.NOTES
  退出码：0=完成；2=预检/端口/参数错误；1=运行错误。
  真实验收前请确认两板已经恢复在线（bridge 9101 有连接、public-sync 有新 202）。
#>
[CmdletBinding()]
param(
    [string]$BathCom = 'COM4',
    [string]$KitchenCom = 'COM5',
    [ValidateRange(1, 7200)]
    [int]$Seconds = 600,
    [string]$OutDir = '',
    [switch]$NoSerial,
    [switch]$NoMonitor,
    [string]$SerialDir = '',
    [string]$Root = 'D:\OpenHarmony',
    [string]$PublicSyncLog = '',
    [string]$BridgeLog = '',
    [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'
$scriptDir = $PSScriptRoot
$script:Utf8 = New-Object System.Text.UTF8Encoding($false)

function Get-LocalStamp { return (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss.fffzzz') }
function Get-IsoZ { return (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fff') + 'Z' }

function New-Utf8Writer([string]$path) {
    $sw = New-Object System.IO.StreamWriter($path, $false, (New-Object System.Text.UTF8Encoding($false)))
    $sw.AutoFlush = $false
    return $sw
}

function Test-TcpReachable([string]$hostName, [int]$port, [int]$timeoutMs) {
    $client = $null
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $iar = $client.BeginConnect($hostName, $port, $null, $null)
        $ok = $iar.AsyncWaitHandle.WaitOne($timeoutMs)
        if ($ok -and $client.Connected) { $client.Close(); return $true }
        return $false
    } catch { return $false }
    finally { if ($client -ne $null) { try { $client.Close() } catch { } } }
}

function Read-JsonIfExists([string]$file) {
    try {
        if (-not (Test-Path -LiteralPath $file)) { return $null }
        return (Get-Content -LiteralPath $file -Raw -Encoding UTF8) | ConvertFrom-Json
    } catch { return $null }
}

function Write-EventRow([string]$csvPath, [int]$idx, [double]$elapsedMs, [string]$event, [string]$note) {
    $esc = { param($s) if ($null -eq $s) { '' } else { '"' + ($s -replace '"', '""') + '"' } }
    $line = '{0},{1:F0},{2},{3},{4}' -f $idx, $elapsedMs, (Get-LocalStamp), (& $esc $event), (& $esc $note)
    Add-Content -LiteralPath $csvPath -Value $line -Encoding UTF8
}

# ---------------------------------------------------------------- 证据提取
function Get-SerialEvidence([string]$dir) {
    $result = @{
        Found = $false; Files = @(); TotalLines = 0;
        AckReceipts = @(); PlayClips = @(); LedModes = @(); AlarmLines = @(); StopLines = @(); AckRejected = @()
    }
    if (-not $dir -or -not (Test-Path -LiteralPath $dir)) { return $result }
    $files = @(Get-ChildItem -LiteralPath $dir -Filter *.log -File -ErrorAction SilentlyContinue)
    if ($files.Count -eq 0) { return $result }
    $result.Found = $true
    $result.Files = @($files | ForEach-Object { $_.FullName })
    $all = @()
    foreach ($f in $files) { $all += @(Get-Content -LiteralPath $f.FullName -Encoding UTF8 -ErrorAction SilentlyContinue) }
    $result.TotalLines = $all.Count
    foreach ($line in $all) {
        if ($line -match '已接受并生效' -and $line -match 'ACK') { $result.AckReceipts += $line }
        if ($line -match 'PLAY clip=') { $result.PlayClips += $line }
        if ($line -match 'LED 模式=') { $result.LedModes += $line }
        if ($line -match '-> ALARM') { $result.AlarmLines += $line }
        if ($line -match 'STOP 已接受并生效') { $result.StopLines += $line }
        if ($line -match 'ACK 被拒绝') { $result.AckRejected += $line }
    }
    return $result
}

function Get-MonitorEvidence([string]$dir) {
    $result = @{ Found = $false; MqttLines = @(); AckEvents = @(); SnapshotLines = @(); Markers = @() }
    if (-not $dir -or -not (Test-Path -LiteralPath $dir)) { return $result }
    $m = Join-Path $dir 'mqtt-status.log'
    $a = Join-Path $dir 'ack-events.log'
    $s = Join-Path $dir 'snapshots.log'
    $k = Join-Path $dir 'markers.log'
    if (Test-Path -LiteralPath $m) { $result.MqttLines = @(Get-Content -LiteralPath $m -Encoding UTF8 -ErrorAction SilentlyContinue) }
    if (Test-Path -LiteralPath $a) { $result.AckEvents = @(Get-Content -LiteralPath $a -Encoding UTF8 -ErrorAction SilentlyContinue) }
    if (Test-Path -LiteralPath $s) { $result.SnapshotLines = @(Get-Content -LiteralPath $s -Encoding UTF8 -ErrorAction SilentlyContinue) }
    if (Test-Path -LiteralPath $k) { $result.Markers = @(Get-Content -LiteralPath $k -Encoding UTF8 -ErrorAction SilentlyContinue) }
    $result.Found = ($result.MqttLines.Count + $result.AckEvents.Count + $result.SnapshotLines.Count) -gt 0
    return $result
}

function Get-CloudEvidence([string]$logPath, [string]$sinceIsoZ) {
    $r = @{ Found = $false; AckSent = @(); Acked = @(); Last202 = @(); LastPoll = ''; Since = $sinceIsoZ }
    if (-not $logPath -or -not (Test-Path -LiteralPath $logPath)) { return $r }
    $r.Found = $true
    $lines = @(Get-Content -LiteralPath $logPath -Encoding UTF8 -ErrorAction SilentlyContinue)
    $since = $sinceIsoZ
    foreach ($l in $lines) {
        $isNew = $true
        if ($since) {
            $m = [regex]::Match($l, '^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3})Z')
            if ($m.Success) { if ([string]::CompareOrdinal($m.Groups[1].Value, $since.Substring(0, 23)) -lt 0) { $isNew = $false } }
        }
        if (-not $isNew) { continue }
        if ($l -match '\[command-sync\] ACK_SENT') { $r.AckSent += $l }
        if ($l -match '\[command-sync\] ACKED') { $r.Acked += $l }
        if ($l -match '\[cloud-sync\] OK .*status=202') { $r.Last202 += $l }
        if ($l -match '\[command-sync\] (POLL_OK|POLL_FAIL)') { $r.LastPoll = $l }
    }
    return $r
}

function Get-BridgeEvidence([string]$logPath, [string]$sinceIsoLocal) {
    $r = @{ Found = $false; CommandWrites = @(); AckedStatus = @() }
    if (-not $logPath -or -not (Test-Path -LiteralPath $logPath)) { return $r }
    $r.Found = $true
    $lines = @(Get-Content -LiteralPath $logPath -Encoding UTF8 -ErrorAction SilentlyContinue -Tail 5000)
    foreach ($l in $lines) {
        if ($l -match '命令已写入节点' -and $l -match 'ack ') { $r.CommandWrites += $l }
        if ($l -match 'state=ACKED') { $r.AckedStatus += $l }
    }
    return $r
}

function New-AcceptanceSummary($cfg, $serial, $monitor, $cloud, $bridge, $eventRows) {
    $lines = New-Object System.Collections.ArrayList
    $add = { param($s) [void]$lines.Add($s) }
    $now = Get-LocalStamp
    & $add ('# 验收小结 ACCEPTANCE SUMMARY — ' + $now)
    & $add ('# 输出目录: ' + $cfg.OutDir)
    & $add ('# 事件窗口: ' + $cfg.Seconds + ' s；串口: ' + $(if ($cfg.NoSerial) { 'SKIPPED' } else { $cfg.BathCom + '+' + $cfg.KitchenCom }))
    & $add ''
    & $add ('## 0) 事件时间线 events.csv: ' + $eventRows + ' 个事件（不含表头）')
    & $add ''
    & $add ('## 1) 双串口证据 serial/ found=' + $serial.Found + ' files=' + $serial.Files.Count + ' lines=' + $serial.TotalLines)
    & $add ('  ACK 回执行: ' + $serial.AckReceipts.Count)
    foreach ($l in @($serial.AckReceipts | Select-Object -First 6)) { & $add ('   ' + $l) }
    & $add ('  ACK 被拒绝行: ' + $serial.AckRejected.Count)
    & $add ('  PLAY clip 行: ' + $serial.PlayClips.Count)
    foreach ($l in @($serial.PlayClips | Select-Object -First 4)) { & $add ('   ' + $l) }
    & $add ('  LED 模式 行: ' + $serial.LedModes.Count)
    foreach ($l in @($serial.LedModes | Select-Object -First 6)) { & $add ('   ' + $l) }
    & $add ('  -> ALARM 行: ' + $serial.AlarmLines.Count)
    foreach ($l in @($serial.AlarmLines | Select-Object -First 4)) { & $add ('   ' + $l) }
    & $add ('  STOP 生效行: ' + $serial.StopLines.Count)
    & $add ''
    & $add ('## 2) 只读监测 monitor/ found=' + $monitor.Found + ' mqttLines=' + $monitor.MqttLines.Count + ' ackEvents=' + $monitor.AckEvents.Count + ' markers=' + $monitor.Markers.Count)
    foreach ($l in @($monitor.AckEvents | Select-Object -First 8)) { & $add ('   ' + $l) }
    $snap202 = @($monitor.SnapshotLines | Where-Object { $_ -match 'public-sync-last-202' } | Select-Object -Last 8)
    foreach ($l in $snap202) { & $add ('   ' + $l) }
    $watcher = @($monitor.SnapshotLines | Where-Object { $_ -match 'dayu-watcher' } | Select-Object -Last 1)
    foreach ($l in $watcher) { & $add ('   ' + $l) }
    & $add ''
    & $add ('## 3) public-sync 云端证据 since=' + $cloud.Since + ' found=' + $cloud.Found)
    & $add ('  [command-sync] ACK_SENT: ' + $cloud.AckSent.Count)
    foreach ($l in @($cloud.AckSent | Select-Object -First 4)) { & $add ('   ' + $l) }
    & $add ('  [command-sync] ACKED : ' + $cloud.Acked.Count + '   <= 云端侧闭环铁证')
    foreach ($l in @($cloud.Acked | Select-Object -First 4)) { & $add ('   ' + $l) }
    & $add ('  status=202 条数: ' + $cloud.Last202.Count)
    foreach ($l in @($cloud.Last202 | Select-Object -Last 6)) { & $add ('   ' + $l) }
    & $add ('  最后轮询: ' + $cloud.LastPoll)
    & $add ''
    & $add ('## 4) bridge 日志（可选） found=' + $bridge.Found + ' 命令已写入=' + $bridge.CommandWrites.Count + ' state=ACKED 上行=' + $bridge.AckedStatus.Count)
    foreach ($l in @($bridge.CommandWrites | Select-Object -Last 4)) { & $add ('   ' + $l) }
    & $add ''
    & $add '## 5) 必查证据字段清单（验收结论按此逐项勾选，不可只看灯亮/听见声音）'
    $fields = @(
        @{ k = 'deviceId'; v = (@($monitor.MqttLines | Select-String -Pattern 'home/(esp32-[a-z0-9-]+)/status' | Select-Object -First 1) -ne $null); d = 'MQTT home/<deviceId>/status 或 serial/bridge 日志' },
        @{ k = 'alarm.id'; v = ($serial.AckReceipts.Count -gt 0 -or $monitor.AckEvents.Count -gt 0); d = '串口 ACK 行 id=... / ACKED-OBSERVED alarm.id=...' },
        @{ k = 'alarm.type'; v = (@($serial.AlarmLines | Select-String -Pattern 'type=').Count -gt 0 -or @($monitor.MqttLines | Select-String -Pattern '"type"').Count -gt 0); d = 'MANUAL_SOS 等' },
        @{ k = 'state=ACKED'; v = (@($serial.AckReceipts | Select-String -Pattern 'state=ACKED').Count -gt 0 -or $monitor.AckEvents.Count -gt 0); d = '设备回执与上行状态' },
        @{ k = 'PLAY clip='; v = ($serial.PlayClips.Count -gt 0); d = '语音播放（SOS clip=1 / 环境 clip 按固件）' },
        @{ k = 'LED 模式='; v = ($serial.LedModes.Count -gt 0); d = 'SOS_TRIPLE / ALARM_BLINK / ACKED_*' },
        @{ k = 'ACK 回执'; v = ($serial.AckReceipts.Count -gt 0); d = '串口 “ACK 回执已接受并生效 ... state=ACKED”' },
        @{ k = '云端 ACKED'; v = ($cloud.Acked.Count -gt 0); d = '[command-sync] ACKED id=... device=...' },
        @{ k = '202 上行'; v = ($cloud.Last202.Count -gt 0); d = '[cloud-sync] OK ... status=202' }
    )
    foreach ($f in $fields) {
        $mark = 'MISSING'
        if ($f.v) { $mark = 'OK' }
        & $add ('  [{0}] {1} :: {2}' -f $mark, $f.k, $f.d)
    }
    $missing = @($fields | Where-Object { -not $_.v })
    & $add ''
    if ($missing.Count -eq 0) {
        & $add 'RESULT: EVIDENCE-COMPLETE（字段齐全；仍需按 README 人工核对 alarmId 一致性与物理顺序）'
    } else {
        & $add ('RESULT: EVIDENCE-INCOMPLETE（缺: ' + (($missing | ForEach-Object { $_.k }) -join ', ') + '）')
        & $add '提示：先确认两板在线（9101 有连接 + 新 202），再重跑；不要用重发 MQTT/手工 ACK 补齐证据。'
    }
    return @{ Text = ($lines -join "`r`n"); Complete = ($missing.Count -eq 0) }
}

# ---------------------------------------------------------------- 自检
function Invoke-SelfTest {
    $checks = New-Object System.Collections.ArrayList
    function Add-C([string]$n, [bool]$ok, [string]$d) {
        [void]$checks.Add(@{ Name = $n; Ok = $ok; Detail = $d })
        Write-Host ("CHECK {0} {1}{2}" -f $(if ($ok) { 'PASS' } else { 'FAIL' }), $n, $(if ($d) { ' :: ' + $d } else { '' }))
    }
    $td = Join-Path $env:TEMP ('accept-selftest-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $td -Force | Out-Null
    try {
        # 1) 事件 CSV
        $csv = Join-Path $td 'events.csv'
        Add-Content -LiteralPath $csv -Value 'idx,elapsed_ms,wall_local,event,note' -Encoding UTF8
        Write-EventRow $csv 1 1234.5 'KEY_KITCHEN_KEY0' '按下厨房 KEY0'
        Write-EventRow $csv 2 2345.0 'APP_ACK' '含"引号"备注'
        $rows = @(Get-Content -LiteralPath $csv -Encoding UTF8)
        Add-C 'csv-header+rows' ($rows.Count -eq 3) ('rows=' + $rows.Count)
        Add-C 'csv-fields' ($rows[1] -match '^1,1235,.+,?"KEY_KITCHEN_KEY0","按下厨房 KEY0"$') $rows[1]
        Add-C 'csv-quote-escape' ($rows[2] -match '""引号""') $rows[2]

        # 2) 证据提取（造一个 merged.log）
        $sd = Join-Path $td 'serial'
        New-Item -ItemType Directory -Path $sd -Force | Out-Null
        $sample = @(
            '[2026-10-26T21:10:00.100+08:00] [kitchen] I (1234) node: AHT20 温湿度越界 -> ALARM（type=CLIMATE）语音+蜂鸣已请求',
            '[2026-10-26T21:10:00.200+08:00] [kitchen] I (1235) voice: PLAY clip=2',
            '[2026-10-26T21:10:00.300+08:00] [kitchen] I (1236) led: LED 模式=ALARM_BLINK type=CLIMATE（低电平有效；告警期间不被普通联网提示覆盖）',
            '[2026-10-26T21:10:05.000+08:00] [kitchen] I (2000) node: ACK 回执已接受并生效（阶段③：监护人已确认）：id=e-1793019999-1 type=MANUAL_SOS -> state=ACKED，蜂鸣器已停，语音已取消',
            '[2026-10-26T21:10:05.050+08:00] [kitchen] I (2001) node: STOP 已接受并生效：本轮声音停止，state 保持 ALARM id=e-1793019999-1 type=MANUAL_SOS；',
            '[2026-10-26T21:10:05.100+08:00] [kitchen] I (2002) voice: STOP result=ESP_OK cancelled=1',
            '[2026-10-26T21:10:05.200+08:00] [kitchen] I (2003) led: LED 模式=ACKED_RESOLVED_OFF type=MANUAL_SOS'
        )
        Set-Content -LiteralPath (Join-Path $sd 'merged.log') -Value $sample -Encoding UTF8
        $ev = Get-SerialEvidence $sd
        Add-C 'serial-found' ($ev.Found -and $ev.TotalLines -eq 7) ('lines=' + $ev.TotalLines)
        Add-C 'serial-ack-receipt' ($ev.AckReceipts.Count -eq 1) ('ack=' + $ev.AckReceipts.Count)
        Add-C 'serial-play' ($ev.PlayClips.Count -eq 1) ('play=' + $ev.PlayClips.Count)
        Add-C 'serial-led' ($ev.LedModes.Count -eq 2) ('led=' + $ev.LedModes.Count)
        Add-C 'serial-alarm' ($ev.AlarmLines.Count -eq 1) ('alarm=' + $ev.AlarmLines.Count)
        Add-C 'serial-stop' ($ev.StopLines.Count -eq 1) ('stop=' + $ev.StopLines.Count)

        # 3) monitor 证据提取
        $md = Join-Path $td 'monitor'
        New-Item -ItemType Directory -Path $md -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $md 'mqtt-status.log') -Value @(
            '[x] home/esp32-kitchen/status {"deviceId":"esp32-kitchen","state":"ACKED","alarm":{"id":"e-1793019999-1","type":"MANUAL_SOS"}}'
        ) -Encoding UTF8
        Set-Content -LiteralPath (Join-Path $md 'ack-events.log') -Value @(
            '[x] ACKED-OBSERVED deviceId=esp32-kitchen alarm.id=e-1793019999-1 alarm.type=MANUAL_SOS state=ACKED ts=1'
        ) -Encoding UTF8
        Set-Content -LiteralPath (Join-Path $md 'snapshots.log') -Value @(
            '[x] SNAP public-sync-last-202 device=esp32-kitchen line=...status=202'
        ) -Encoding UTF8
        $mv = Get-MonitorEvidence $md
        Add-C 'monitor-found' $mv.Found ('mqtt=' + $mv.MqttLines.Count + ' ack=' + $mv.AckEvents.Count)

        # 4) cloud evidence：since 过滤
        $cl = Join-Path $td 'public-sync-supervisor.log'
        Set-Content -LiteralPath $cl -Value @(
            '2026-10-26T12:49:40.509Z [worker:stdout] [cloud-sync] OK device=esp32-kitchen ts=1 path=/internal/v1/device-status status=202 at=2026-10-26T12:49:40.509Z',
            '2026-10-26T13:10:00.000Z [worker:stdout] [command-sync] POLL_OK path=/internal/v1/commands status=200',
            '2026-10-26T13:10:01.000Z [worker:stdout] [command-sync] ACK_SENT id=77 device=esp32-kitchen',
            '2026-10-26T13:10:02.000Z [worker:stdout] [cloud-sync] OK device=esp32-kitchen ts=2 path=/internal/v1/device-status status=202 at=2026-10-26T13:10:02.000Z',
            '2026-10-26T13:10:03.000Z [worker:stdout] [command-sync] ACKED id=77 device=esp32-kitchen'
        ) -Encoding UTF8
        $cv = Get-CloudEvidence $cl '2026-10-26T13:00:00.000Z'
        Add-C 'cloud-since-filter' ($cv.AckSent.Count -eq 1 -and $cv.Acked.Count -eq 1 -and $cv.Last202.Count -eq 1) ('sent=' + $cv.AckSent.Count + ' acked=' + $cv.Acked.Count + ' 202=' + $cv.Last202.Count)
        $cvAll = Get-CloudEvidence $cl ''
        Add-C 'cloud-no-since' ($cvAll.Last202.Count -eq 2) ('202=' + $cvAll.Last202.Count)

        # 5) 小结逻辑：完整 vs 缺项
        $cfg = @{ OutDir = $td; Seconds = 60; NoSerial = $false; BathCom = 'COM4'; KitchenCom = 'COM5' }
        $sum1 = New-AcceptanceSummary $cfg $ev $mv $cv $null 3
        Add-C 'summary-complete' ($sum1.Complete -and $sum1.Text -match 'EVIDENCE-COMPLETE') 'complete path'
        $emptySerial = @{ Found = $false; Files = @(); TotalLines = 0; AckReceipts = @(); PlayClips = @(); LedModes = @(); AlarmLines = @(); StopLines = @(); AckRejected = @() }
        $emptyMon = @{ Found = $false; MqttLines = @(); AckEvents = @(); SnapshotLines = @(); Markers = @() }
        $emptyCloud = @{ Found = $false; AckSent = @(); Acked = @(); Last202 = @(); LastPoll = ''; Since = '' }
        $sum2 = New-AcceptanceSummary $cfg $emptySerial $emptyMon $emptyCloud $null 0
        Add-C 'summary-incomplete' ((-not $sum2.Complete) -and $sum2.Text -match 'EVIDENCE-INCOMPLETE') 'missing path'

        # 6) TCP 预检函数（对不可达端口返回 false 而不是抛异常）
        Add-C 'tcp-preflight-false' ((Test-TcpReachable '127.0.0.1' 1 300) -eq $false) 'port 1 should be closed'
        Add-C 'tcp-preflight-true' ((Test-TcpReachable '127.0.0.1' 1883 500) -eq $true) 'broker 1883 expected listening'
    } finally {
        try { Remove-Item -LiteralPath $td -Recurse -Force -ErrorAction SilentlyContinue } catch { }
    }
    $failed = @($checks | Where-Object { -not $_.Ok })
    Write-Host ("ACCEPTANCE SELFTEST {0} {1}/{2} checks passed" -f $(if ($failed.Count -eq 0) { 'PASS' } else { 'FAIL' }), ($checks.Count - $failed.Count), $checks.Count)
    foreach ($f in $failed) { Write-Host ("  FAILED {0} :: {1}" -f $f.Name, $f.Detail) }
    if ($failed.Count -eq 0) { return 0 } else { return 1 }
}

# ---------------------------------------------------------------- 主流程
if ($SelfTest) { exit (Invoke-SelfTest) }

if (-not $OutDir) { $OutDir = Join-Path (Join-Path $scriptDir 'logs') ('accept-' + (Get-Date -Format 'yyyyMMdd-HHmmss')) }
$outFull = [System.IO.Path]::GetFullPath($OutDir)
foreach ($sub in @('', 'serial', 'monitor')) {
    $p = Join-Path $outFull $sub
    if (-not (Test-Path -LiteralPath $p)) { New-Item -ItemType Directory -Path $p -Force | Out-Null }
}
$serialDir = Join-Path $outFull 'serial'
$monitorDir = Join-Path $outFull 'monitor'
if ($SerialDir) { $serialDir = [System.IO.Path]::GetFullPath($SerialDir) }
$eventsCsv = Join-Path $outFull 'events.csv'
$summaryPath = Join-Path $outFull 'SUMMARY.txt'
Set-Content -LiteralPath $eventsCsv -Value 'idx,elapsed_ms,wall_local,event,note' -Encoding UTF8

$bathName = $BathCom.Trim(); if ($bathName -match '^\d+$') { $bathName = 'COM' + $bathName } else { $bathName = $bathName.ToUpperInvariant() }
$kitchenName = $KitchenCom.Trim(); if ($kitchenName -match '^\d+$') { $kitchenName = 'COM' + $kitchenName } else { $kitchenName = $kitchenName.ToUpperInvariant() }
if (-not $NoSerial -and $bathName -eq $kitchenName) {
    [Console]::Error.WriteLine('ERROR: 卫生间与厨房不能使用同一个串口：' + $bathName)
    exit 2
}
if (-not $PublicSyncLog) { $PublicSyncLog = Join-Path $Root 'competition\bridge\_test\current-runtime\supervisor\public-sync-supervisor.log' }

$startTime = Get-Date
$startIsoZ = Get-IsoZ
$eventIdx = 0
$serialProc = $null
$monitorProc = $null
$exitCode = 0

Write-Host '==================== ACCEPTANCE 一键验收 ===================='
Write-Host ('输出目录: ' + $outFull)
Write-Host ('事件窗口: ' + $Seconds + ' s；串口: ' + $(if ($NoSerial) { 'SKIP' } else { $bathName + '(卫生间) + ' + $kitchenName + '(厨房)' }) + '；监测: ' + $(if ($NoMonitor) { 'SKIP' } else { 'ON' }))
Write-Host ''
Write-Host '--- 只读预检（不重启任何服务）---'
$p1883 = Test-TcpReachable '127.0.0.1' 1883 800
$p9101 = Test-TcpReachable '127.0.0.1' 9101 800
$p9001 = Test-TcpReachable '127.0.0.1' 9001 800
Write-Host ('1883 broker  : ' + $(if ($p1883) { 'LISTEN-OK' } else { 'NOT-REACHABLE' }))
Write-Host ('9101 bridge  : ' + $(if ($p9101) { 'LISTEN-OK' } else { 'NOT-REACHABLE' }))
Write-Host ('9001 fport   : ' + $(if ($p9001) { 'LISTEN-OK' } else { 'NOT-REACHABLE' }))
if (-not $p1883 -or -not $p9101) {
    Write-Warning '1883/9101 不可达：验收将缺少南向/云端证据。不要在本脚本内重启服务；先按 FIELD-STATE 处理。'
}
$bridgeStatus = Join-Path $Root 'competition\bridge\status.json'
$supStatus = Join-Path $Root 'competition\bridge\_test\current-runtime\supervisor\status.json'
$bs = Read-JsonIfExists $bridgeStatus
$ss = Read-JsonIfExists $supStatus
if ($bs) { Write-Host ('bridge/status.json  : deviceId=' + $bs.deviceId + ' state=' + $bs.state + ' ts=' + $bs.ts + ' mtime=' + (Get-Item -LiteralPath $bridgeStatus).LastWriteTime.ToString('HH:mm:ss')) }
if ($ss) { Write-Host ('supervisor/status   : deviceId=' + $ss.deviceId + ' state=' + $ss.state + ' ts=' + $ss.ts + ' mtime=' + (Get-Item -LiteralPath $supStatus).LastWriteTime.ToString('HH:mm:ss')) }
Write-Host ''

try {
    if (-not $NoSerial) {
        $dualScript = Join-Path $scriptDir 'dual-serial-capture.ps1'
        if (-not (Test-Path -LiteralPath $dualScript)) { throw ('缺少 dual-serial-capture.ps1: ' + $dualScript) }
        $psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        $serialArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $dualScript,
            '-BathCom', $bathName, '-KitchenCom', $kitchenName, '-Seconds', ([string]($Seconds + 20)), '-OutDir', $serialDir)
        $serialConsole = Join-Path $outFull 'serial-console.log'
        Write-Host ('启动双串口采集: ' + $bathName + ' + ' + $kitchenName + ' -> ' + $serialDir)
        $serialProc = Start-Process -FilePath $psExe -ArgumentList $serialArgs -PassThru -WindowStyle Hidden `
            -RedirectStandardOutput $serialConsole -RedirectStandardError (Join-Path $outFull 'serial-console.err.log')
        Start-Sleep -Milliseconds 900
        if ($serialProc.HasExited) {
            $errText = ''
            try { $errText = (Get-Content -LiteralPath (Join-Path $outFull 'serial-console.err.log') -Raw -Encoding UTF8) } catch { }
            throw ('双串口采集启动失败（退出码 ' + $serialProc.ExitCode + '）：' + $errText.Trim())
        }
        Write-Host ('  串口采集 PID=' + $serialProc.Id)
    } else {
        Write-Host '跳过双串口采集（-NoSerial）。'
    }

    if (-not $NoMonitor) {
        $monScript = Join-Path $scriptDir 'field-monitor.js'
        $nodeExe = (Get-Command node -ErrorAction SilentlyContinue)
        if ($nodeExe -ne $null -and (Test-Path -LiteralPath $monScript)) {
            $monArgs = @($monScript, '--seconds', ([string]($Seconds + 15)), '--out-dir', $monitorDir, '--root', (Join-Path $Root 'competition'), '--serial-dir', $serialDir)
            Write-Host ('启动只读监测: MQTT 1883 + status.json 快照 + public-sync 日志')
            $monitorProc = Start-Process -FilePath $nodeExe.Source -ArgumentList $monArgs -PassThru -WindowStyle Hidden `
                -RedirectStandardOutput (Join-Path $outFull 'monitor-console.log') -RedirectStandardError (Join-Path $outFull 'monitor-console.err.log')
            Start-Sleep -Milliseconds 800
            if ($monitorProc.HasExited) { Write-Warning ('field-monitor 提前退出（退出码 ' + $monitorProc.ExitCode + '）；见 monitor-console.err.log。验收继续，但缺少 MQTT 证据。') }
            else { Write-Host ('  监测 PID=' + $monitorProc.Id) }
        } else {
            Write-Warning '未找到 node 或 field-monitor.js：跳过只读监测。'
        }
    } else {
        Write-Host '跳过只读监测（-NoMonitor）。'
    }

    Write-Host ''
    Write-Host '--- 操作提示（每个动作后立刻按键记录时间点）---'
    Write-Host '  Enter=通用事件   k=厨房 KEY0 按下   b=卫生间 SOS 按下   a=APP/DAYU 点 ACK'
    Write-Host '  l=目视 LED      s=听到语音        n=备注(回车结束)   q=结束验收'
    $watch = New-Object System.Collections.ArrayList
    [void]$watch.Add(@{ At = $startTime.AddSeconds(5); Text = '按 k 或 b 触发实体按键（观察三短闪 LED + SOS 语音）' })
    [void]$watch.Add(@{ At = $startTime.AddSeconds(20); Text = '告警出现后按 a 记录 APP/DAYU ACK 时刻' })
    [void]$watch.Add(@{ At = $startTime.AddSeconds(35); Text = '观察 LED 是否进入 ACKED 模式、语音是否停止；按 l/s 记录' })
    $nextHint = 0
    $running = $true
    while ($running) {
        $elapsedSec = ((Get-Date) - $startTime).TotalSeconds
        if ($elapsedSec -ge $Seconds) { Write-Host ('事件窗口结束（' + $Seconds + 's）。'); break }
        if ($nextHint -lt $watch.Count -and $elapsedSec -ge (($watch[$nextHint].At - $startTime).TotalSeconds)) {
            Write-Host ('[提示 +{0:F0}s] {1}' -f $elapsedSec, $watch[$nextHint].Text)
            $nextHint++
        }
        $key = ''
        try {
            if ([Console]::IsInputRedirected) {
                $line = [Console]::In.ReadLine()
                if ($null -eq $line) { Write-Host 'stdin 结束：停止事件记录。'; break }
                if ($line.Length -eq 0) { $key = 'ENTER' } else { $key = 'LINE:' + $line }
            } elseif ([Console]::KeyAvailable) {
                $k = [Console]::ReadKey($true)
                if ($k.Key -eq [ConsoleKey]::Enter) { $key = 'ENTER' } else { $key = 'KEY:' + $k.KeyChar }
            }
        } catch { $key = 'ENTER' }
        if ($key -eq '') { Start-Sleep -Milliseconds 60; continue }
        $event = ''; $note = ''
        if ($key -eq 'ENTER') { $event = 'EVENT_MARK' }
        elseif ($key -eq 'KEY:k') { $event = 'KEY_KITCHEN_KEY0'; $note = '厨房实体 KEY0 按下' }
        elseif ($key -eq 'KEY:b') { $event = 'KEY_BATH_SOS'; $note = '卫生间实体 SOS 按下' }
        elseif ($key -eq 'KEY:a') { $event = 'APP_ACK'; $note = 'APP/DAYU 点确认/ACK' }
        elseif ($key -eq 'KEY:l') { $event = 'OBS_LED'; $note = '目视 LED 状态' }
        elseif ($key -eq 'KEY:s') { $event = 'OBS_SPEECH'; $note = '听到语音' }
        elseif ($key -eq 'KEY:n') {
            $event = 'NOTE'
            try {
                if ([Console]::IsInputRedirected) { $note = [Console]::In.ReadLine() } else { Write-Host '备注: ' -NoNewline; $note = [Console]::ReadLine() }
            } catch { $note = '' }
        }
        elseif ($key -eq 'KEY:q') { Write-Host '操作者结束验收。'; break }
        elseif ($key.StartsWith('LINE:')) {
            $rawLine = $key.Substring(5)
            if ($rawLine.Length -eq 1 -and 'kbalsnq'.Contains($rawLine)) {
                # 便于非交互/piped 运行也走快捷键逻辑（单字符行等价于按键）
                if ($rawLine -eq 'k') { $event = 'KEY_KITCHEN_KEY0'; $note = '厨房实体 KEY0 按下' }
                elseif ($rawLine -eq 'b') { $event = 'KEY_BATH_SOS'; $note = '卫生间实体 SOS 按下' }
                elseif ($rawLine -eq 'a') { $event = 'APP_ACK'; $note = 'APP/DAYU 点确认/ACK' }
                elseif ($rawLine -eq 'l') { $event = 'OBS_LED'; $note = '目视 LED 状态' }
                elseif ($rawLine -eq 's') { $event = 'OBS_SPEECH'; $note = '听到语音' }
                elseif ($rawLine -eq 'q') { Write-Host '操作者结束验收。'; break }
                else { $event = 'EVENT_KEY_' + $rawLine; $note = '' }
            } else {
                $event = 'TEXT'; $note = $rawLine
            }
        }
        else { $event = 'EVENT_KEY_' + ($key -replace '^KEY:', ''); $note = '' }
        $eventIdx++
        Write-EventRow $eventsCsv $eventIdx (((Get-Date) - $startTime).TotalMilliseconds) $event $note
        Write-Host ('  [事件 #' + $eventIdx + ' +' + [int](((Get-Date) - $startTime).TotalMilliseconds) + 'ms] ' + $event + $(if ($note) { '：' + $note } else { '' }))
    }
} catch {
    [Console]::Error.WriteLine('ERROR: ' + $_.Exception.Message)
    $exitCode = 2
    if ($_.Exception.Message -match '端口占用') { $exitCode = 2 }
} finally {
    Write-Host ''
    Write-Host '--- 收尾：停止采集/监测进程（只停本脚本启动的子进程）---'
    foreach ($p in @($serialProc, $monitorProc)) {
        if ($p -ne $null) {
            try { if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue; Write-Host ('  已停止 PID=' + $p.Id) } } catch { }
        }
    }
    Start-Sleep -Milliseconds 1200
    $serialEv = Get-SerialEvidence $serialDir
    $monitorEv = Get-MonitorEvidence $monitorDir
    $cloudEv = Get-CloudEvidence $PublicSyncLog $startIsoZ
    $bridgeEv = $null
    if ($BridgeLog) { $bridgeEv = Get-BridgeEvidence $BridgeLog (Get-LocalStamp) }
    if ($bridgeEv -eq $null) { $bridgeEv = @{ Found = $false; CommandWrites = @(); AckedStatus = @() } }
    $cfg = @{ OutDir = $outFull; Seconds = $Seconds; NoSerial = [bool]$NoSerial; BathCom = $bathName; KitchenCom = $kitchenName }
    $summary = New-AcceptanceSummary $cfg $serialEv $monitorEv $cloudEv $bridgeEv $eventIdx
    Set-Content -LiteralPath $summaryPath -Value $summary.Text -Encoding UTF8
    Write-Host ''
    Write-Host $summary.Text
    Write-Host ''
    Write-Host ('SUMMARY 已写: ' + $summaryPath)
    Write-Host ('events.csv : ' + $eventsCsv)
    if ($exitCode -eq 0 -and -not $summary.Complete) { $exitCode = 0 }  # 证据不完整不等于脚本失败，退出码保持 0
}

exit $exitCode
