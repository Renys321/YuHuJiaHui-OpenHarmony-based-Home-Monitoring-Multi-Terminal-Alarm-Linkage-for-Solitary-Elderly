# verify-watcher-recovery.ps1 — 非破坏性验证 demo-autostart watcher 的恢复判定（2026-10-28）
#
# 目的：验证 2026-10-27 修复在「无 watcher 运行」的当前现场是否真的有效，而不是只看代码。
# 方法：用 PowerShell AST **从 demo-autostart.ps1 抽取真实函数/代码块**（不复制实现），
#      在临时文件上构造现场形态并断言。全程：
#        - 不启动/停止任何服务（Start-Process 被 mock，不会真的拉起 P0 入口）
#        - 不修改 runtime 状态文件、不读取 INGEST_KEY
#        - 不杀任何进程
#
# 覆盖：P0 五要素（端口+supervisor PID+worker PID+STATE HEALTHY+heartbeat<=90s）、
#      假 HEALTHY 拒绝、stale lock 允许拉起、活锁阻止重复拉起、30 分钟 6 次上限、
#      60s 拉起冷却、-NoP0Launch、单实例互斥（真实子进程验证）。
#
# 退出码：0 = 全部 PASS；3 = 有 FAIL。
param(
    [string]$WatcherScript = 'D:\OpenHarmony\competition\materials\demo-autostart\demo-autostart.ps1'
)

$ErrorActionPreference = 'Stop'
$script:pass = 0
$script:fail = 0
function Check([string]$Name, [bool]$Ok, [string]$Info = '') {
    if ($Ok) { $script:pass += 1; Write-Host ("[PASS] {0}" -f $Name) -ForegroundColor Green }
    else { $script:fail += 1; Write-Host ("[FAIL] {0} :: {1}" -f $Name, $Info) -ForegroundColor Red }
}

Write-Host '=== 1) AST 解析 demo-autostart.ps1 ===' -ForegroundColor Cyan
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($WatcherScript, [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) {
    Write-Host ("[FAIL] 解析失败：" + $errors[0].Message) -ForegroundColor Red
    exit 3
}
Write-Host '[ok] 语法解析通过（UTF-8 BOM 读取正常）' -ForegroundColor Green

function Get-FnText([string]$name) {
    $node = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name }, $true) | Select-Object -First 1
    if ($node) { return $node.Extent.Text }
    return $null
}
$fnNames = @('Test-Tcp', 'Test-PidAlive', 'Read-P0State', 'Read-P0LockPid', 'Get-P0Health', 'Ensure-P0')
$fnText = @{}
foreach ($n in $fnNames) {
    $t = Get-FnText $n
    if (-not $t) { Write-Host ("[FAIL] 缺少函数 {0}" -f $n) -ForegroundColor Red; exit 3 }
    $fnText[$n] = $t
    . ([scriptblock]::Create($t))
}
Write-Host ("[ok] 已抽取函数：{0}" -f ($fnNames -join ', ')) -ForegroundColor Green

# 抽取单实例互斥代码块（$mutex = New-Object ... 及其后的 if）
$mutexBlock = $null
$top = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.StatementAst] }, $false)
for ($i = 0; $i -lt $top.Count; $i++) {
    $s = $top[$i]
    if ($s.Extent.Text -match 'New-Object\s+System\.Threading\.Mutex') {
        $assignNode = $s
        $ifNode = $ast.FindAll({
                param($n) $n -is [System.Management.Automation.Language.IfStatementAst] -and
                    $n.Extent.Text -match 'existing demo-autostart watcher'
            }, $true) | Select-Object -First 1
        if ($ifNode) { $mutexBlock = $s.Extent.Text + "`n" + $ifNode.Extent.Text }
        break
    }
}
Check '从脚本抽取到单实例互斥代码块（$mutex + if）' ($null -ne $mutexBlock) '未找到 New-Object System.Threading.Mutex'

Write-Host ''
Write-Host '=== 2) 静态契约（关键阈值/公式/单实例名） ===' -ForegroundColor Cyan
$p0Text = $fnText['Get-P0Health']
$allText = Get-Content -LiteralPath $WatcherScript -Raw
Check 'P0 五要素公式：ports + supervisorAlive + workerAlive + stateOk' `
    ($p0Text -match '\$healthy\s*=\s*\$ports\s*-and\s*\$supervisorAlive\s*-and\s*\$workerAlive\s*-and\s*\$stateOk')
Check 'heartbeat 新鲜阈值 <=90s' ($p0Text -match '\$heartbeatAgeSec\s*-le\s*90')
Check '心跳陈旧判 STALE_HEARTBEAT' ($p0Text -match 'STALE_HEARTBEAT')
Check 'worker 死亡判 WORKER_DEAD' ($p0Text -match 'WORKER_DEAD')
Check 'stale lock 判 STALE_LOCK' ($p0Text -match 'STALE_LOCK')
Check '30 分钟窗口（-ge 30 分钟）' ($allText -match 'TotalMinutes\s*-ge\s*30')
Check '30 分钟最多 6 次拉起（-ge 6）' ($allText -match '\$script:p0LaunchAttempts\s*-ge\s*6')
Check '60s 拉起冷却（-lt 60）' ($allText -match 'lastP0Launch\)\.TotalSeconds\s*-lt\s*60')
Check '活锁/死锁区分（liveLock 用 Test-PidAlive 判定）' `
    ($fnText['Ensure-P0'] -match '\$liveLock\s*=\s*\(\$h\.LockPid\s*-gt\s*0\)\s*-and\s*\(Test-PidAlive\s+\$h\.LockPid\)')
Check '单实例互斥名 Global\DayuDemoAutostart20261026' ($allText -match 'Global\\DayuDemoAutostart20261026' -or $allText -match 'Global\\DayuDemoAutostart20261026')

Write-Host ''
Write-Host '=== 3) Get-P0Health 现场形态断言（临时文件，不碰 runtime） ===' -ForegroundColor Cyan
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('watcher-verify-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
try {
    $P0State = Join-Path $tmp 'supervisor.state.json'
    $P0Lock = Join-Path $tmp 'supervisor.lock'
    $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $portsUp = (Test-Tcp 1883) -and (Test-Tcp 9101)
    Write-Host ("[info] 当前 1883/9101 端口状态 portsUp={0}（判定原因会受其影响）" -f $portsUp) -ForegroundColor DarkGray

    # 现场形态：state 停在旧 HEALTHY，lock/pid 都已退出（2026-10-27 16:25 事故 + 当前 watcher 缺失）
    Set-Content -LiteralPath $P0Lock -Value '58052' -Encoding ASCII
    Set-Content -LiteralPath $P0State -Value ([ordered]@{
            supervisorPid = 58052; workerPid = 999998; state = 'HEALTHY'
            heartbeatAt = ($nowMs - 90 * 60 * 1000)
        } | ConvertTo-Json) -Encoding UTF8
    $h = Get-P0Health
    Check '陈旧 HEALTHY + 死 PID 不得判 healthy' (-not $h.Healthy) ($h | ConvertTo-Json -Compress)
    Check '死 PID 的 lock 不得算活锁（否则永不拉起）' (-not (($h.LockPid -gt 0) -and (Test-PidAlive $h.LockPid))) ("LockPid=" + $h.LockPid)
    $reasonOk = ($h.Reason -eq 'STALE_LOCK') -or ((-not $portsUp) -and $h.Reason -eq 'PORTS_DOWN')
    Check '原因指向 STALE_LOCK（端口异常时允许 PORTS_DOWN）' $reasonOk $h.Reason

    # 真健康形态：supervisor/worker 都是活 PID + 新鲜心跳
    Set-Content -LiteralPath $P0Lock -Value ([string]$PID) -Encoding ASCII
    Set-Content -LiteralPath $P0State -Value ([ordered]@{
            supervisorPid = $PID; workerPid = $PID; state = 'HEALTHY'; heartbeatAt = $nowMs
        } | ConvertTo-Json) -Encoding UTF8
    $h2 = Get-P0Health
    Check '活 PID + 新鲜心跳 => supervisor/worker/state 三要素为真' `
        ($h2.SupervisorAlive -and $h2.WorkerAlive -and $h2.State -and $h2.HeartbeatAgeSec -le 90) ($h2 | ConvertTo-Json -Compress)

    # 假 HEALTHY 之二：supervisor 活、worker 死
    Set-Content -LiteralPath $P0State -Value ([ordered]@{
            supervisorPid = $PID; workerPid = 999999; state = 'HEALTHY'; heartbeatAt = $nowMs
        } | ConvertTo-Json) -Encoding UTF8
    $h3 = Get-P0Health
    Check 'worker 死亡 => WORKER_DEAD（不得 healthy）' (($h3.Reason -eq 'WORKER_DEAD' -or $h3.Reason -eq 'PORTS_DOWN') -and -not $h3.Healthy) $h3.Reason

    # 假 HEALTHY 之三：PID 都活但 heartbeat 超过 90s
    Set-Content -LiteralPath $P0State -Value ([ordered]@{
            supervisorPid = $PID; workerPid = $PID; state = 'HEALTHY'; heartbeatAt = ($nowMs - 10 * 60 * 1000)
        } | ConvertTo-Json) -Encoding UTF8
    $h4 = Get-P0Health
    Check 'heartbeat 陈旧 => STALE_HEARTBEAT（不得 healthy）' (($h4.Reason -eq 'STALE_HEARTBEAT' -or $h4.Reason -eq 'PORTS_DOWN') -and -not $h4.Healthy) $h4.Reason

    Write-Host ''
    Write-Host '=== 4) Ensure-P0 拉起/不拉起断言（Start-Process 已 mock，不会真的启动） ===' -ForegroundColor Cyan
    # 准备 Ensure-P0 依赖的脚本作用域变量
    $script:mockLaunches = 0
    $script:mockLaunchCmds = @()
    $script:testLog = @()
    $P0Cmd = 'D:\OpenHarmony\competition\materials\start-demo-supervisor.cmd'
    $script:lastP0Reason = ''
    $script:p0LaunchAttempts = 0
    $script:p0LaunchWindowStart = [datetime]::MinValue
    $script:lastP0Launch = [datetime]::MinValue
    Set-Variable -Name NoP0Launch -Value $false -Scope Script
    function global:Write-Log([string]$Message) { $script:testLog += $Message }
    function global:Start-Process {
        param($FilePath, $ArgumentList, $WorkingDirectory, [switch]$WindowStyle, [switch]$PassThru, [switch]$NoNewWindow)
        $script:mockLaunches += 1
        $script:mockLaunchCmds += ($FilePath + ' ' + ($ArgumentList -join ' '))
    }
    function Reset-LaunchState {
        $script:p0LaunchAttempts = 0
        $script:p0LaunchWindowStart = [datetime]::MinValue
        $script:lastP0Launch = [datetime]::MinValue
        $script:lastP0Reason = ''
    }

    # F1 stale lock（死 PID）=> 必须允许拉起一次，但 Ensure-P0 返回 false（等下一轮健康检查）
    Reset-LaunchState
    Set-Content -LiteralPath $P0Lock -Value '58052' -Encoding ASCII
    Set-Content -LiteralPath $P0State -Value ([ordered]@{
            supervisorPid = 58052; workerPid = 999998; state = 'HEALTHY'; heartbeatAt = ($nowMs - 90 * 60 * 1000)
        } | ConvertTo-Json) -Encoding UTF8
    $script:mockLaunches = 0
    $r = Ensure-P0
    Check 'stale lock（死 PID）允许拉起 P0 入口 1 次' ($script:mockLaunches -eq 1) ("launches=" + $script:mockLaunches)
    Check 'stale lock 拉起后 Ensure-P0 返回 false（不假装健康）' ($r -eq $false) ([string]$r)
    Check 'stale lock 拉起有明确日志' (($script:testLog -join "`n") -match 'STALE supervisor lock') ''

    # F2 真健康 => 不拉起、返回 true
    Set-Content -LiteralPath $P0Lock -Value ([string]$PID) -Encoding ASCII
    Set-Content -LiteralPath $P0State -Value ([ordered]@{
            supervisorPid = $PID; workerPid = $PID; state = 'HEALTHY'; heartbeatAt = ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
        } | ConvertTo-Json) -Encoding UTF8
    $script:mockLaunches = 0
    $r2 = Ensure-P0
    Check '真健康时不重复拉起、直接返回 true' (($script:mockLaunches -eq 0) -and ($r2 -eq $true)) ("launches=" + $script:mockLaunches)

    # F3 活锁但 worker 死 => 不能再拉起第二个实例
    Set-Content -LiteralPath $P0Lock -Value ([string]$PID) -Encoding ASCII
    Set-Content -LiteralPath $P0State -Value ([ordered]@{
            supervisorPid = $PID; workerPid = 999999; state = 'HEALTHY'; heartbeatAt = ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
        } | ConvertTo-Json) -Encoding UTF8
    $script:mockLaunches = 0
    $r3 = Ensure-P0
    Check '活锁 + worker 死 => 不重复拉起（避免第二个 supervisor）' (($script:mockLaunches -eq 0) -and ($r3 -eq $false)) ("launches=" + $script:mockLaunches)

    # F4 60s 冷却
    Reset-LaunchState
    Set-Content -LiteralPath $P0Lock -Value '58052' -Encoding ASCII
    Set-Content -LiteralPath $P0State -Value ([ordered]@{
            supervisorPid = 58052; workerPid = 999998; state = 'HEALTHY'; heartbeatAt = ($nowMs - 90 * 60 * 1000)
        } | ConvertTo-Json) -Encoding UTF8
    $script:mockLaunches = 0
    Ensure-P0 | Out-Null
    $afterFirst = $script:mockLaunches
    Ensure-P0 | Out-Null   # 立即第二次：应被 60s 冷却挡住
    Check '60s 冷却内不重复拉起' (($afterFirst -eq 1) -and ($script:mockLaunches -eq 1)) ("afterFirst=" + $afterFirst + " now=" + $script:mockLaunches)
    $script:lastP0Launch = (Get-Date).AddSeconds(-61)
    Ensure-P0 | Out-Null
    Check '冷却 61s 后可再次拉起' ($script:mockLaunches -eq 2) ("launches=" + $script:mockLaunches)

    # F5 30 分钟最多 6 次
    Reset-LaunchState
    $script:mockLaunches = 0
    for ($i = 0; $i -lt 8; $i++) {
        $script:lastP0Launch = [datetime]::MinValue   # 绕过 60s 冷却，只测 6 次上限
        Ensure-P0 | Out-Null
    }
    Check '30 分钟窗口内最多拉起 6 次（第 7/8 次被上限挡住）' ($script:mockLaunches -eq 6) ("launches=" + $script:mockLaunches)
    Check '达到上限后进入 launch-capped 并在日志中说明' `
        (($script:lastP0Reason -eq 'launch-capped') -and (($script:testLog -join "`n") -match '30 分钟内已尝试拉起 6 次')) `
        ("lastP0Reason=" + $script:lastP0Reason)

    # F6 -NoP0Launch
    Reset-LaunchState
    Set-Variable -Name NoP0Launch -Value $true -Scope Script
    Set-Content -LiteralPath $P0State -Value ([ordered]@{
            supervisorPid = 58052; workerPid = 999998; state = 'HEALTHY'; heartbeatAt = ($nowMs - 90 * 60 * 1000)
        } | ConvertTo-Json) -Encoding UTF8
    $script:mockLaunches = 0
    $r6 = Ensure-P0
    Check '-NoP0Launch 时不拉起' (($script:mockLaunches -eq 0) -and ($r6 -eq $false)) ("launches=" + $script:mockLaunches)
    Set-Variable -Name NoP0Launch -Value $false -Scope Script

    Remove-Item Function:\Start-Process -ErrorAction SilentlyContinue
    Remove-Item Function:\Write-Log -ErrorAction SilentlyContinue

    Write-Host ''
    Write-Host '=== 5) 单实例互斥真实验证（子进程持有同名 Mutex） ===' -ForegroundColor Cyan
    if ($mutexBlock) {
        # 注意：.NET Mutex 对同一线程可重入，所以"已持有"必须由另一个进程制造。
        $holderScript = Join-Path $tmp 'holder.ps1'
        $readyFile = Join-Path $tmp 'holder-ready.txt'
        $holderLines = @(
            '$mutex = New-Object System.Threading.Mutex($false, ''Global\DayuDemoAutostart20261026'')'
            '$got = $mutex.WaitOne(0)'
            ("Set-Content -LiteralPath '" + $readyFile + "' -Value 'ready' -Encoding ASCII")
            'Start-Sleep -Seconds 30'
            'try { $mutex.ReleaseMutex() } catch { }'
            '$mutex.Dispose()'
        )
        Set-Content -LiteralPath $holderScript -Value $holderLines -Encoding UTF8
        $holderProc = Start-Process -FilePath 'powershell.exe' `
            -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $holderScript) `
            -WindowStyle Hidden -PassThru
        for ($w = 0; $w -lt 50 -and -not (Test-Path $readyFile); $w++) { Start-Sleep -Milliseconds 100 }
        $holderReady = Test-Path $readyFile

        $childHeld = Join-Path $tmp 'child-held.ps1'
        Set-Content -LiteralPath $childHeld -Value @($mutexBlock -split "`r?`n") -Encoding UTF8
        $outHeld = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $childHeld 2>&1
        $codeHeld = $LASTEXITCODE
        $heldText = ($outHeld -join "`n")
        try { Stop-Process -Id $holderProc.Id -Force -ErrorAction SilentlyContinue } catch { }
        Check '已有 watcher 持锁时，新实例识别为复用并正常退出（单实例生效）' `
            ($holderReady -and ($heldText -match 'existing demo-autostart watcher') -and ($codeHeld -eq 0)) `
            ("holderReady=" + $holderReady + " exit=" + $codeHeld + " out=" + $heldText)

        $childFree = Join-Path $tmp 'child-free.ps1'
        $freeLines = @($mutexBlock -split "`r?`n") + @(
            "Write-Output 'FREE_ACQUIRED'"
            'try { $mutex.ReleaseMutex() } catch { }'
            '$mutex.Dispose()'
        )
        Set-Content -LiteralPath $childFree -Value $freeLines -Encoding UTF8
        $outFree = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $childFree 2>&1
        $codeFree = $LASTEXITCODE
        $freeText = ($outFree -join "`n")
        Check '无 watcher 持锁时，新实例可正常取得单实例锁（不会被死锁阻止）' `
            (($freeText -match 'FREE_ACQUIRED') -and ($freeText -notmatch 'existing demo-autostart watcher') -and ($codeFree -eq 0)) `
            ("exit=" + $codeFree + " out=" + $freeText)
    }
}
finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ''
if ($script:fail -eq 0) {
    Write-Host ("=== watcher 恢复判定 PASS（{0}/{0}）===" -f $script:pass) -ForegroundColor Green
    exit 0
}
Write-Host ("=== watcher 恢复判定 FAIL：pass={0} fail={1} ===" -f $script:pass, $script:fail) -ForegroundColor Red
exit 3
