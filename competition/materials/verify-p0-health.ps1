# verify-p0-health.ps1 — 验证 demo-autostart 的 P0 存活判定（2026-10-27）
#
# 为什么要单独验证：2026-10-27 16:25 事故的代码级原因之一是 watcher 的
# Get-P0Health 只看 state.json 里的 "HEALTHY" 字符串，不校验 PID 是否存活、
# heartbeat 是否新鲜；加上 Ensure-P0 用 Test-Path(lock) 判断，死 PID 的 stale lock
# 会把自动拉起永久卡死。本脚本用 PowerShell AST 直接从 demo-autostart.ps1 抽取
# Test-PidAlive / Read-P0State / Read-P0LockPid / Get-P0Health 四个函数（不复制实现），
# 用临时文件构造三种现场形态并断言判定结果。
#
# 只读、无副作用：不启动服务、不修改运行时文件、不读取任何密钥。
param(
    [string]$WatcherScript = 'D:\OpenHarmony\competition\materials\demo-autostart\demo-autostart.ps1'
)

$ErrorActionPreference = 'Stop'
$script:pass = 0
$script:fail = 0

function Check([string]$Name, [bool]$Ok, [string]$Info = '') {
    if ($Ok) {
        $script:pass += 1
        Write-Host ("[PASS] {0}" -f $Name) -ForegroundColor Green
    } else {
        $script:fail += 1
        Write-Host ("[FAIL] {0} :: {1}" -f $Name, $Info) -ForegroundColor Red
    }
}

$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($WatcherScript, [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) {
    Write-Host "[FAIL] demo-autostart.ps1 解析失败：$($errors[0].Message)" -ForegroundColor Red
    exit 3
}
Write-Host '[ok] demo-autostart.ps1 解析通过' -ForegroundColor Green

$wanted = @('Test-Tcp', 'Test-PidAlive', 'Read-P0State', 'Read-P0LockPid', 'Get-P0Health')
$functions = @{}
$ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true) |
    ForEach-Object {
        if ($wanted -contains $_.Name) { $functions[$_.Name] = $_.Extent.Text }
    }
foreach ($name in $wanted) {
    if (-not $functions.ContainsKey($name)) {
        Write-Host "[FAIL] 未找到函数 $name" -ForegroundColor Red
        exit 3
    }
}
foreach ($name in $wanted) {
    . ([scriptblock]::Create($functions[$name]))
}

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('p0-health-verify-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
try {
    $P0State = Join-Path $tmp 'supervisor.state.json'
    $P0Lock = Join-Path $tmp 'supervisor.lock'
    $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

    # ---- 场景 1：2026-10-27 现场形态（state=HEALTHY、lock=PID 29048、两进程都已退出）
    Set-Content -LiteralPath $P0Lock -Value '29048' -Encoding ASCII
    $staleState = [ordered]@{
        supervisorPid = 29048; workerPid = 30608; state = 'HEALTHY'
        heartbeatAt = ($nowMs - 7 * 3600 * 1000)   # 7 小时前的陈旧心跳
    } | ConvertTo-Json
    Set-Content -LiteralPath $P0State -Value $staleState -Encoding UTF8
    $h = Get-P0Health
    Check '陈旧 state+死 PID 不得判为 healthy' (-not $h.Healthy) ($h | ConvertTo-Json -Compress)
    Check '陈旧 state+死 PID 的 reason 是 STALE_LOCK' ($h.Reason -eq 'STALE_LOCK') $h.Reason
    $liveLock = ($h.LockPid -gt 0) -and (Test-PidAlive $h.LockPid)
    Check '死 PID 的 lock 不得被视为"活锁"（否则永远不拉起）' (-not $liveLock) ("LockPid=" + $h.LockPid)

    # ---- 场景 2：真健康（用当前进程 PID 充当 supervisor/worker，心跳新鲜）
    Set-Content -LiteralPath $P0Lock -Value ([string]$PID) -Encoding ASCII
    $healthyState = [ordered]@{
        supervisorPid = $PID; workerPid = $PID; state = 'HEALTHY'; heartbeatAt = $nowMs
    } | ConvertTo-Json
    Set-Content -LiteralPath $P0State -Value $healthyState -Encoding UTF8
    $h2 = Get-P0Health
    # 端口在这个测试环境可能没有监听；只验证 supervisor/worker/heartbeat 三要素
    Check '存活 PID + 新鲜 heartbeat 的 supervisor/worker 判定为存活' `
        ($h2.SupervisorAlive -and $h2.WorkerAlive -and $h2.State -and $h2.HeartbeatAgeSec -le 90) `
        ($h2 | ConvertTo-Json -Compress)

    # ---- 场景 3：supervisor 活着但 worker 死了（旧实现也会误报 healthy）
    $deadWorkerState = [ordered]@{
        supervisorPid = $PID; workerPid = 999999; state = 'HEALTHY'; heartbeatAt = $nowMs
    } | ConvertTo-Json
    Set-Content -LiteralPath $P0State -Value $deadWorkerState -Encoding UTF8
    $h3 = Get-P0Health
    Check 'worker 死亡时 reason 必须指出 WORKER_DEAD' ($h3.Reason -eq 'WORKER_DEAD') $h3.Reason

    # ---- 场景 4：heartbeat 陈旧但 PID 都活着（假活）
    $staleHbState = [ordered]@{
        supervisorPid = $PID; workerPid = $PID; state = 'HEALTHY'; heartbeatAt = ($nowMs - 10 * 60 * 1000)
    } | ConvertTo-Json
    Set-Content -LiteralPath $P0State -Value $staleHbState -Encoding UTF8
    $h4 = Get-P0Health
    Check 'heartbeat 超过 90s 时必须判 STALE_HEARTBEAT' ($h4.Reason -eq 'STALE_HEARTBEAT') $h4.Reason
} finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ''
if ($script:fail -eq 0) {
    Write-Host ("=== P0 存活判定 PASS（{0}/{0}）===" -f $script:pass) -ForegroundColor Green
    exit 0
}
Write-Host ("=== P0 存活判定 FAIL：pass={0} fail={1} ===" -f $script:pass, $script:fail) -ForegroundColor Red
exit 3
