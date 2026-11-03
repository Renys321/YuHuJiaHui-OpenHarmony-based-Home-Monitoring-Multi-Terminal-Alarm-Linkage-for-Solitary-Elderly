# hostbench 运行脚本：在 Windows 本机用“真实进程”验证 homemon 无 PIR / 时钟跳变 / 监护字段独立性。
#
# 说明：
#   - homemon 本体是 Linux/POSIX 守护进程，无法直接跑在 Windows 上；本脚本用
#     tests/hostbench/ 的兼容层（prelude.h + hostbench_compat.c）把同一份 src/homemon.c
#     编译成 Windows 台架进程。**这不是 DAYU200 真机证据**。
#   - 台架的“校时”只改进程内时钟偏移（hostbench_compat.c），绝不修改本机系统时钟。
#   - 台架没有 I2C/ADC，因此温湿度 valid=false、燃气/烟雾保持 ok=true（与“没接传感器”一致）。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File run_hostbench.ps1            # 完整跑（约 3.5 分钟）
#   powershell -ExecutionPolicy Bypass -File run_hostbench.ps1 -SkipBuild # 复用已构建 exe
#   powershell -ExecutionPolicy Bypass -File run_hostbench.ps1 -NoPirSeconds 30   # 缩短 A 场景
param(
    [switch]$SkipBuild,
    [int]$NoPirSeconds = 90
)

$ErrorActionPreference = 'Stop'
$root  = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$bench = 'D:\OpenHarmony\competition\evidence\2026-10-27-reconnect-dayu-sos\homemon-nomotion\bench'
$exe   = Join-Path $root 'out\homemon-host.exe'
$gcc   = 'D:\MSYS2\ucrt64\bin\gcc.exe'

$pass = 0; $fail = 0
$results = New-Object System.Collections.Generic.List[string]

function Check([bool]$cond, [string]$name) {
    if ($cond) { $script:pass++; $results.Add("  PASS  $name"); Write-Host "  PASS  $name" }
    else       { $script:fail++; $results.Add("  FAIL  $name"); Write-Host "  FAIL  $name" }
}

function Get-Status([string]$dir) {
    $p = Join-Path $dir 'status.json'
    for ($i = 0; $i -lt 5; $i++) {
        try {
            if (Test-Path $p) {
                $raw = [System.IO.File]::ReadAllText($p, [System.Text.Encoding]::UTF8)
                if ($raw.Trim().Length -gt 0) { return ($raw | ConvertFrom-Json) }
            }
        } catch { }
        Start-Sleep -Milliseconds 300
    }
    return $null
}

function Get-Log([string]$dir) {
    $p = Join-Path $dir 'homemon.log'
    if (Test-Path $p) { return [System.IO.File]::ReadAllText($p, [System.Text.Encoding]::UTF8) }
    return ''
}

function Get-StdoutLines([string]$dir) {
    $p = Join-Path $dir 'stdout.log'
    if (-not (Test-Path $p)) { return @() }
    $all = [System.IO.File]::ReadAllLines($p, [System.Text.Encoding]::UTF8)
    return @($all | Where-Object { $_.TrimStart().StartsWith('{') })
}

function Clean-Run([string]$dir) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    foreach ($f in 'homemon.log', 'status.json', 'stdout.log', 'stderr.log') {
        Remove-Item (Join-Path $dir $f) -Force -ErrorAction SilentlyContinue
    }
}

function Start-Bench([string]$conf, [string]$dir) {
    $env:PATH = 'D:\MSYS2\ucrt64\bin;' + $env:PATH
    $p = Start-Process -FilePath $exe -ArgumentList $conf -PassThru -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $dir 'stdout.log') `
        -RedirectStandardError  (Join-Path $dir 'stderr.log')
    return $p
}

function Stop-Bench($p) {
    if ($null -eq $p) { return }
    try { if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force } } catch { }
    try { $p.WaitForExit(3000) | Out-Null } catch { }
}

function Set-Pir([string]$val) {
    $p = Join-Path $bench 'fake-gpio-pir\gpio5\value'
    [System.IO.File]::WriteAllText($p, $val, (New-Object System.Text.ASCIIEncoding))
}

function Send-Tcp([int]$port, [string]$line) {
    $c = New-Object System.Net.Sockets.TcpClient
    $c.Connect('127.0.0.1', $port)
    $s = $c.GetStream()
    $bytes = [System.Text.Encoding]::ASCII.GetBytes($line + "`n")
    $s.Write($bytes, 0, $bytes.Length); $s.Flush()
    Start-Sleep -Milliseconds 300
    $c.Close()
}

# 运行目录（与 bench-*.conf 里的 dir= 一致）
$runNoPir    = Join-Path $bench 'run-nopir'
$runPir      = Join-Path $bench 'run-pir'
$runPirJump  = Join-Path $bench 'run-pir-jump'
$runMonitor  = Join-Path $bench 'run-monitor'
$runSensors  = Join-Path $bench 'run-sensors'

Write-Host "== hostbench: build =="
if (-not (Test-Path $gcc)) { throw "gcc not found: $gcc" }
if (-not $SkipBuild) {
    Get-Process -Name 'homemon-host' -ErrorAction SilentlyContinue | Stop-Process -Force
    $out = & $gcc -std=c11 -O2 -Wall -Wextra -Wno-format-truncation -I (Join-Path $root 'src') `
        -I (Join-Path $PSScriptRoot 'include') -include (Join-Path $PSScriptRoot 'prelude.h') `
        (Join-Path $root 'src\homemon.c') (Join-Path $PSScriptRoot 'hostbench_compat.c') `
        -o $exe -lws2_32 -lwinpthread 2>&1
    if ($LASTEXITCODE -ne 0) { $out | Select-Object -Last 20; throw "hostbench build failed" }
}
$exeHash = (Get-FileHash $exe -Algorithm SHA256).Hash
$exeSize = (Get-Item $exe).Length
Write-Host ("   exe = {0}  size={1}  sha256={2}" -f $exe, $exeSize, $exeHash)

$results.Add("hostbench (本地 Windows 台架，非 DAYU 真机)  $(Get-Date -Format 'yyyy-MM-ddTHH:mm:ssK')")
$results.Add("exe=$exe size=$exeSize sha256=$exeHash")
$results.Add("")

# 清理上一轮遗留进程
Get-Process -Name 'homemon-host' -ErrorAction SilentlyContinue | Stop-Process -Force

# ---------------------------------------------------------------------------
# A. motion_cnt=0（无 PIR）：no_motion_sec=60，运行 90s（>阈值），不应出现 NO_MOTION
# ---------------------------------------------------------------------------
Write-Host "== A: no PIR, ${NoPirSeconds}s > no_motion_sec=60 =="
$results.Add("[A] 无 PIR：motion_gpio 未配置，no_motion_sec=60，运行 ${NoPirSeconds}s")
Clean-Run $runNoPir
Set-Pir '0'
$p = Start-Bench (Join-Path $bench 'bench-nopir.conf') $runNoPir
Start-Sleep -Seconds 3
$allNormal = $true; $allNoPir = $true; $alarmSeen = $false; $last = $null
$deadline = (Get-Date).AddSeconds($NoPirSeconds)
while ((Get-Date) -lt $deadline -and -not $p.HasExited) {
    Start-Sleep -Seconds 5
    $st = Get-Status $runNoPir
    if ($null -eq $st) { continue }
    if ($st.state -ne 'NORMAL') { $allNormal = $false }
    if ($st.alarm.type -eq 'NO_MOTION') { $alarmSeen = $true }
    if (-not ($st.sensors.motion.supported -eq $false -and $st.sensors.motion.reported -eq $false -and
              $st.sensors.motion.reason -eq 'not_configured' -and $st.sensors.motion.lastActiveTs -eq 0)) {
        $allNoPir = $false
    }
    $last = $st
}
$alive = -not $p.HasExited
Stop-Bench $p
$logA = Get-Log $runNoPir
$stdoutA = Get-StdoutLines $runNoPir
$badStdout = @($stdoutA | Where-Object { ($_ | ConvertFrom-Json).alarm.type -eq 'NO_MOTION' }).Count
Check $alive "A1 进程在 ${NoPirSeconds}s 内持续运行（未崩溃）"
Check ($stdoutA.Count -ge [math]::Floor($NoPirSeconds / 5)) "A2 stdout 持续上报状态行（$($stdoutA.Count) 行）"
Check $allNormal "A3 全程 state=NORMAL（超过 no_motion_sec 也不进入 WARN/ALARM）"
Check (-not $alarmSeen) "A4 全程 alarm.type 从未出现 NO_MOTION"
Check ($badStdout -eq 0) "A5 所有 stdout JSON 行均非 NO_MOTION"
Check ($logA -notmatch 'type=NO_MOTION') "A6 homemon.log 无 NO_MOTION 告警记录"
Check ($logA -match 'NO_MOTION=关闭') "A7 启动日志明确记录 NO_MOTION=关闭（无有效 PIR）"
if ($null -ne $last) {
    Check ($last.sensors.motion.supported -eq $false) "A8 JSON motion.supported=false"
    Check ($last.sensors.motion.reported -eq $false) "A9 JSON motion.reported=false"
    Check ($last.sensors.motion.reason -eq 'not_configured') "A10 JSON motion.reason=not_configured"
    Check ($last.sensors.motion.lastActiveTs -eq 0) "A11 JSON motion.lastActiveTs=0（不伪造启动时刻）"
    Check ($last.monitorOnline -eq -1) "A12 monitorOnline=-1（监护链路从未上报，不冒充在线）"
}
Check ($allNoPir) "A13 每个采样点 motion 能力字段都保持 supported=false/reported=false"
$logSize = (Get-Item (Join-Path $runNoPir 'homemon.log')).Length
$results.Add("  info: homemon.log=$logSize B；stdout 状态行 $($stdoutA.Count) 条")
$results.Add("")

# ---------------------------------------------------------------------------
# A2. 重启：同一目录再启动，仍不产生 NO_MOTION（内存状态不跨重启）
# ---------------------------------------------------------------------------
Write-Host "== A2: restart (same dir) =="
$p = Start-Bench (Join-Path $bench 'bench-nopir.conf') $runNoPir
Start-Sleep -Seconds 12
$st = Get-Status $runNoPir
$alive = -not $p.HasExited
Stop-Bench $p
Check ($alive -and $null -ne $st) "A14 重启后进程正常运行"
if ($null -ne $st) {
    Check ($st.state -eq 'NORMAL' -and $st.alarm.id -eq '') "A15 重启后 state=NORMAL、alarm.id 为空（内存旧告警不存在）"
    Check ($st.sensors.motion.supported -eq $false) "A16 重启后 motion.supported 仍为 false"
}
$logA2 = Get-Log $runNoPir
Check (([regex]::Matches($logA2, 'homemon 启动')).Count -ge 2) "A17 同一目录日志保留两次启动记录（历史不删）"
$results.Add("")

# ---------------------------------------------------------------------------
# B. motion_cnt>0（PIR）：20s 阈值、50% WARN；活动恢复 NORMAL；随后 1800s 规则同样生效
# ---------------------------------------------------------------------------
Write-Host "== B: PIR enabled (WARN -> activity NORMAL -> NO_MOTION) =="
Clean-Run $runPir
Set-Pir '0'
$p = Start-Bench (Join-Path $bench 'bench-pir.conf') $runPir
Start-Sleep -Seconds 12
$stWarn = Get-Status $runPir
Check ($null -ne $stWarn -and $stWarn.state -eq 'WARN') "B1 有 PIR：活动间隔达 50% → WARN"
Check ($null -ne $stWarn -and $stWarn.sensors.motion.supported -eq $true -and $stWarn.sensors.motion.reported -eq $true) "B2 有 PIR：JSON motion.supported=true/reported=true"
Set-Pir '1'
Start-Sleep -Seconds 2
$stNorm = Get-Status $runPir
Set-Pir '0'
Check ($null -ne $stNorm -and $stNorm.state -eq 'NORMAL') "B3 检测到活动 → WARN 恢复 NORMAL"
Check ($null -ne $stNorm -and [int64]$stNorm.sensors.motion.lastActiveTs -gt [int64]($stNorm.ts - 5000)) "B4 活动后 lastActiveTs 更新为当前时刻"
Start-Sleep -Seconds 24
$stAlarm = Get-Status $runPir
Stop-Bench $p
$logB = Get-Log $runPir
Check ($null -ne $stAlarm -and $stAlarm.state -eq 'ALARM' -and $stAlarm.alarm.type -eq 'NO_MOTION') "B5 活动停止后按阈值触发 NO_MOTION（有 PIR 时规则不变）"
Check ($logB -match '活动间隔达阈值 50% -> WARN') "B6 日志记录活动间隔 WARN"
Check ($logB -match '活动恢复 -> NORMAL') "B7 日志记录活动恢复 NORMAL"
Check ($logB -match 'ALARM id=.* type=NO_MOTION') "B8 日志记录真实 ALARM（含 id/type/detail）"
$results.Add("[B] 有 PIR（假 gpio5）：20s 阈值/50% WARN，活动恢复 NORMAL，随后 NO_MOTION；日志与 JSON 一致")
$results.Add("")

# ---------------------------------------------------------------------------
# C. NO_MOTION 告警后重启：内存告警消失（alarm.id 空），历史日志仍在
# ---------------------------------------------------------------------------
Write-Host "== C: restart after NO_MOTION (memory cleared, history kept) =="
$logBefore = Get-Log $runPir
$p = Start-Bench (Join-Path $bench 'bench-pir.conf') $runPir
Start-Sleep -Seconds 4
$st = Get-Status $runPir
Stop-Bench $p
$logAfter = Get-Log $runPir
Check ($null -ne $st -and $st.state -eq 'NORMAL') "C1 重启后 state=NORMAL（内存中的 NO_MOTION 不跨重启）"
Check ($null -ne $st -and $st.alarm.id -eq '') "C2 重启后 alarm.id 为空（没有伪造/恢复旧告警）"
Check (($logAfter.Length -gt $logBefore.Length) -and ($logAfter -match 'ALARM id=.* type=NO_MOTION')) "C3 历史 homemon.log 保留旧 ALARM 记录（未删除/未改写）"
$results.Add("[C] 重启后内存旧 NO_MOTION 消失（日志历史保留）：C1-C3")
$results.Add("")

# ---------------------------------------------------------------------------
# D. 时钟跳变（进程内模拟校时 +1h）：不产生假 NO_MOTION
# ---------------------------------------------------------------------------
Write-Host "== D: simulated clock jump (+1h) with PIR =="
Clean-Run $runPirJump
Set-Pir '0'
$p = Start-Bench (Join-Path $bench 'bench-pir-jump.conf') $runPirJump
Start-Sleep -Seconds 4
$stBefore = Get-Status $runPirJump
Start-Sleep -Milliseconds 200
$target = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + 3600000
Send-Tcp 19094 "time $target"
Start-Sleep -Seconds 3
$stAfter = Get-Status $runPirJump
$logD = Get-Log $runPirJump
Check ($logD -match '校时跳变') "D1 日志记录校时跳变（时钟跳变被检测）"
Check ($logD -match 'TIME 已接受') "D2 校时命令通过（台架进程内偏移生效）"
Check ($null -ne $stAfter -and $stAfter.state -eq 'NORMAL') "D3 跳变后立即仍为 NORMAL（历史时间戳被平移，无假 no_motion）"
Check ($null -ne $stAfter -and [math]::Abs([int64]$stAfter.ts - $target) -lt 5000) "D4 上报 ts 已跳到目标时间（±5s）"
Check ($null -ne $stAfter -and $stAfter.alarm.type -ne 'NO_MOTION') "D5 跳变后 alarm.type 非 NO_MOTION"
Start-Sleep -Seconds 9
$stLater = Get-Status $runPirJump
Stop-Bench $p
Check ($null -ne $stLater -and $stLater.state -eq 'WARN') "D6 跳变后按真实观测到的 idle 继续判定（12s 后 WARN，而非立即 ALARM）"
Check ($stLater.alarm.type -ne 'NO_MOTION') "D7 跳变后仍未误报 NO_MOTION（idle 未满阈值）"
$results.Add("[D] 进程内模拟校时 +1h：跳变平移后 idle 语义保持，不产生假 NO_MOTION")
$results.Add("")

# ---------------------------------------------------------------------------
# E. 无 PIR + 摄像头监护字段独立：monitor offline/online 不改告警、不产生 NO_MOTION
# ---------------------------------------------------------------------------
Write-Host "== E: monitor fields independent from motion =="
Clean-Run $runMonitor
$p = Start-Bench (Join-Path $bench 'bench-monitor.conf') $runMonitor
Start-Sleep -Seconds 3
$st0 = Get-Status $runMonitor
Send-Tcp 19093 'monitor offline no_frame'
Start-Sleep -Seconds 2
$stOff = Get-Status $runMonitor
Send-Tcp 19093 'monitor online frames_resumed'
Start-Sleep -Seconds 2
$stOn = Get-Status $runMonitor
Send-Tcp 19093 'time 999'
Start-Sleep -Seconds 2
$stBad = Get-Status $runMonitor
Stop-Bench $p
$logE = Get-Log $runMonitor
Check ($null -ne $st0 -and $st0.monitorOnline -eq -1) "E1 初始 monitorOnline=-1（从未上报，不冒充在线）"
Check ($null -ne $stOff -and $stOff.monitorOnline -eq 0 -and $stOff.monitorReason -eq 'no_frame') "E2 monitor offline → monitorOnline=0/monitorReason=no_frame"
Check ($null -ne $stOff -and $stOff.state -eq 'NORMAL' -and $stOff.alarm.id -eq '') "E3 摄像头失联不产生告警、不影响 state"
Check ($null -ne $stOn -and $stOn.monitorOnline -eq 1 -and $stOn.monitorReason -eq 'frames_resumed') "E4 monitor online → monitorOnline=1/frames_resumed"
Check ($null -ne $stOn -and $stOn.sensors.motion.supported -eq $false -and $stOn.sensors.motion.reported -eq $false) "E5 摄像头在线不能被推导成 PIR 有活动（motion.supported=false）"
Check ($logE -notmatch 'type=NO_MOTION') "E6 全程无 NO_MOTION 告警"
Check ($logE -match 'TIME 被拒绝') "E7 不可信时间被拒绝（999 不在可信区间）"
Check ($null -ne $stBad -and $stBad.monitorOnline -eq 1) "E8 非法校时未改变状态（monitorOnline 保持 1）"
# E9/E10：无 PIR 不影响主动求助（重新拉起台架进程；不清理日志，保留 E1-E8 的 MONITOR 记录）
$p = Start-Bench (Join-Path $bench 'bench-monitor.conf') $runMonitor
Start-Sleep -Seconds 3
Send-Tcp 19093 'sos'
Start-Sleep -Seconds 2
$stSos = Get-Status $runMonitor
Stop-Bench $p
Check ($null -ne $stSos -and $stSos.state -eq 'ALARM' -and $stSos.alarm.type -eq 'MANUAL_SOS') "E9 无 PIR 不影响主动求助：sos → MANUAL_SOS 告警"
Check ($null -ne $stSos -and $stSos.sensors.motion.supported -eq $false) "E10 SOS 告警时 motion.supported 仍为 false（没有伪造 PIR 活动）"
$results.Add("[E] 无 PIR + 摄像头监护字段独立：offline/online 只改 monitorOnline/Reason，不产生 NO_MOTION；SOS 不受影响")
$results.Add("")

# ---------------------------------------------------------------------------
# F. 门磁 + 求助按钮（假 GPIO），无 PIR：门磁状态/消抖/告警闭环不回归
# ---------------------------------------------------------------------------
Write-Host "== F: door contact + SOS button (no PIR) =="
Clean-Run $runSensors
$doorVal = Join-Path $bench 'fake-gpio-sensors\gpio29\value'
$btnVal  = Join-Path $bench 'fake-gpio-sensors\gpio30\value'
[System.IO.File]::WriteAllText($doorVal, '0', (New-Object System.Text.ASCIIEncoding))
[System.IO.File]::WriteAllText($btnVal,  '0', (New-Object System.Text.ASCIIEncoding))
$p = Start-Bench (Join-Path $bench 'bench-sensors.conf') $runSensors
Start-Sleep -Seconds 3
$stDoor0 = Get-Status $runSensors
[System.IO.File]::WriteAllText($doorVal, '1', (New-Object System.Text.ASCIIEncoding))
Start-Sleep -Seconds 3
$stDoor1 = Get-Status $runSensors
[System.IO.File]::WriteAllText($doorVal, '0', (New-Object System.Text.ASCIIEncoding))
Start-Sleep -Seconds 3
$stDoor2 = Get-Status $runSensors
[System.IO.File]::WriteAllText($btnVal, '1', (New-Object System.Text.ASCIIEncoding))
Start-Sleep -Seconds 3
$stBtn = Get-Status $runSensors
[System.IO.File]::WriteAllText($btnVal, '0', (New-Object System.Text.ASCIIEncoding))
Stop-Bench $p
$logF = Get-Log $runSensors
Check ($null -ne $stDoor0 -and $stDoor0.sensors.door.open -eq $false) "F1 门磁初始闭合（open=false）"
Check ($null -ne $stDoor1 -and $stDoor1.sensors.door.open -eq $true) "F2 门磁打开 → JSON door.open=true"
Check ($null -ne $stDoor1 -and [int64]$stDoor1.sensors.door.lastOpenTs -gt 0) "F3 门磁打开写入 lastOpenTs（真实事件时间）"
Check ($null -ne $stDoor2 -and $stDoor2.sensors.door.open -eq $false) "F4 门磁重新闭合 → open=false"
Check ($null -ne $stBtn -and $stBtn.state -eq 'ALARM' -and $stBtn.alarm.type -eq 'MANUAL_SOS') "F5 求助按钮消抖后 → MANUAL_SOS 告警"
Check ($null -ne $stBtn -and $stBtn.sensors.motion.supported -eq $false -and $stBtn.sensors.motion.reported -eq $false) "F6 无 PIR：门磁/SOS 正常工作时 motion 能力仍为 false"
Check ($logF -match 'ALARM id=.* type=MANUAL_SOS') "F7 日志记录 MANUAL_SOS 告警"
Check ($logF -notmatch 'type=NO_MOTION') "F8 无 PIR + 门磁/SOS 场景全程无 NO_MOTION"
$results.Add("[F] 门磁（假 gpio29）+ SOS（假 gpio30），无 PIR：门磁开合与 MANUAL_SOS 均正常，无 NO_MOTION")
$results.Add("")

# ---------------------------------------------------------------------------
Get-Process -Name 'homemon-host' -ErrorAction SilentlyContinue | Stop-Process -Force

$summary = "hostbench: PASS=$pass FAIL=$fail"
$results.Add($summary)
$outFile = Join-Path $bench 'hostbench-results.txt'
[System.IO.File]::WriteAllLines($outFile, $results, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "== $summary =="
Write-Host "results: $outFile"
if ($fail -gt 0) { exit 1 }
exit 0
