# start-mirror-dayu.ps1 — 用自动解析的 DAYU 端点启动随身 SOS mirror（2026-10-28）
#
# 背景：mirror 需要把 esp32-sos 状态注入板端 homemon（relay 模式，`relay <json>`）。
# 它的 --relay-to 如果写死旧 IP，DAYU WLAN IP 漂移后会 ETIMEDOUT（现场 .250 -> .131）。
# 本脚本用 materials\resolve-dayu-lan-ip.ps1（只读）自动取端点，再把端点传给
# cloud\wearable-mirror\scripts\start-mirror.ps1（不改 mirror 源码，只调用其现有参数）。
#
# 默认 dry-run：只解析端点并打印「将执行的命令」，不启动任何进程。
# 真正启动由 Lead/负责人决定并加 -Apply（日志/状态仍写在 mirror 自己的 runtime 目录）。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File materials\start-mirror-dayu.ps1
#   powershell ... -File materials\start-mirror-dayu.ps1 -Apply
#   powershell ... -File materials\start-mirror-dayu.ps1 -Apply -PreferLan
#   powershell ... -File materials\start-mirror-dayu.ps1 -Apply -Transport both
#
# 退出码：0 = 解析成功（dry-run 或 mirror 启动脚本返回 0）；3 = 端点解析失败；
#         4 = mirror 已在运行（拒绝第二实例）；其他 = mirror 启动脚本的退出码。
param(
    [switch]$Apply,
    [switch]$PreferLan,
    [ValidateSet('api', 'mqtt', 'auto')][string]$Source = 'api',
    [ValidateSet('tcp', 'relay', 'both')][string]$Transport = 'relay',
    [int]$Port = 9002,
    [string]$RelayTarget = '',
    [string]$Hdc = 'D:\DevEcoStudio\DevEco Studio\sdk\default\openharmony\toolchains\hdc.exe',
    [string]$Node = 'D:\Node\node.exe'
)

$ErrorActionPreference = 'Stop'
$Root = 'D:\OpenHarmony\competition'
$Resolver = Join-Path $Root 'materials\resolve-dayu-lan-ip.ps1'
$MirrorDir = Join-Path $Root 'cloud\wearable-mirror'
$MirrorStart = Join-Path $MirrorDir 'scripts\start-mirror.ps1'
$MirrorStatus = Join-Path $MirrorDir 'runtime\mirror-status.json'
$MirrorLock = Join-Path $MirrorDir 'runtime\mirror.lock'

function Write-Step([string]$text) { Write-Host "[mirror-dayu] $text" -ForegroundColor Cyan }
function Write-Bad2([string]$text) { Write-Host "[mirror-dayu] $text" -ForegroundColor Red }

Write-Step '解析 DAYU relay 端点（resolve-dayu-lan-ip.ps1，只读）'
if (-not (Test-Path $Resolver)) { Write-Bad2 "缺少 $Resolver"; exit 3 }
$resolveArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $Resolver, '-JsonOnly')
if ($PreferLan) { $resolveArgs += '-PreferLan' }
$raw = @(& 'powershell.exe' @resolveArgs 2>&1)
$code = $LASTEXITCODE
$obj = $null
try { $obj = (($raw -join "`n") | ConvertFrom-Json) } catch { $obj = $null }
if (-not $obj -or -not $obj.ok -or -not $obj.endpoint) {
    $why = '解析脚本无有效 JSON'
    if ($obj -and $obj.reason) { $why = [string]$obj.reason }
    if ($code -ne 0 -and -not $obj) { $why = "解析脚本退出码 $code" }
    Write-Bad2 ("DAYU 端点解析失败（{0}）；请检查 DAYU 电源/HDC/USB 或 WLAN" -f $why)
    exit 3
}
$endpoint = [string]$obj.endpoint
if ($RelayTarget -ne '') { $endpoint = $RelayTarget }
Write-Step ("endpoint={0} method={1} wlan0Ip={2} usbConnected={3}" -f $endpoint, $obj.method, $obj.wlan0Ip, $obj.usbConnected)
if ($obj.method -eq 'usb-fport-pending') {
    Write-Host '[mirror-dayu] 注意：fport 尚未建立（usb-fport-pending）。relay 目标 127.0.0.1:9001 需要先有 hdc fport tcp:9001->tcp:9000；' -ForegroundColor Yellow
    Write-Host '           可先运行 materials\start-demo-supervisor.cmd（会自动建 fport），或手工 hdc -t <target> fport tcp:9001 tcp:9000。' -ForegroundColor Yellow
}

# 已有 mirror 实例则拒绝，避免重复注入
$existingPid = 0
if (Test-Path $MirrorLock) {
    try {
        $lock = Get-Content -LiteralPath $MirrorLock -Raw | ConvertFrom-Json
        $existingPid = [int]$lock.pid
    } catch { $existingPid = 0 }
}
if ($existingPid -gt 0) {
    $alive = Get-Process -Id $existingPid -ErrorAction SilentlyContinue
    if ($alive) {
        Write-Host ("[mirror-dayu] mirror 已在运行 pid={0}；不启动第二实例。" -f $existingPid) -ForegroundColor Yellow
        if (Test-Path $MirrorStatus) {
            try {
                $s = Get-Content -LiteralPath $MirrorStatus -Raw | ConvertFrom-Json
                $t = @($s.transports)[0]
                Write-Host ("             phase={0} online={1} relay={2} connected={3}" -f $s.phase, $s.online, $t.target, $t.connected) -ForegroundColor Yellow
            } catch { }
        }
        exit 4
    }
}

$cmdArgs = @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $MirrorStart,
    '-Source', $Source, '-Transport', $Transport, '-RelayTo', $endpoint,
    '-Port', [string]$Port, '-Hdc', $Hdc, '-Node', $Node
)
$pretty = 'powershell ' + ($cmdArgs -join ' ')
Write-Host ''
Write-Step '将执行的 mirror 启动命令：'
Write-Host ("  " + $pretty) -ForegroundColor DarkGray
Write-Host ''

if (-not $Apply) {
    Write-Host '[mirror-dayu] dry-run：未启动 mirror。确认端点后加 -Apply 执行（Lead/负责人决定启动时点）。' -ForegroundColor Green
    exit 0
}

Write-Step '调用 mirror 自带启动脚本（-Apply）'
& powershell.exe @cmdArgs
$mirrorExit = $LASTEXITCODE
if ($mirrorExit -ne 0) {
    Write-Bad2 ("mirror 启动脚本退出码 {0}" -f $mirrorExit)
    exit $mirrorExit
}
if (Test-Path $MirrorStatus) {
    try {
        $s = Get-Content -LiteralPath $MirrorStatus -Raw | ConvertFrom-Json
        $t = @($s.transports)[0]
        Write-Step ("mirror 运行中：pid={0} phase={1} online={2} relay={3} connected={4}" -f $s.pid, $s.phase, $s.online, $t.target, $t.connected)
    } catch { }
}
exit 0
