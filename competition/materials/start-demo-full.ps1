# start-demo-full.ps1 v3 —— 演示一键启动（重写版）
#
# 双击 start-demo-full.cmd 即可；或：
#   powershell -File start-demo-full.ps1 -CheckOnly   只体检，不动手
#
# 设计前提与边界：
#   - DAYU200 的身份是 hdc 序列号（不是 COM 口）：USB 换口不影响，但 hdc 映射会丢，脚本每次都会重建；
#   - ESP32 节点只能检查 9101 连接（上电/AP 由人负责）；
#   - INGEST_KEY 只能人工输入（supervisor 窗口）。
#
# 它会做：基础预检 → 重建 hdc 映射(9001/9200/9301/9302) → P0(broker/bridge/public-sync)
#        → 板端 homemon/APP/客厅监护页 → 视觉(带演示参数，卡帧自动重启)
#        → 视频 relay(帧协议异常自动重启) → 随身 mirror → 验收汇总

[CmdletBinding()]
param(
    [switch]$CheckOnly,
    [switch]$SkipP0
)

$ErrorActionPreference = 'Stop'
$Mats = $PSScriptRoot
$Root = Split-Path $Mats -Parent
$Hdc  = 'D:\OpenHarmony\tools\hdc\hdc.exe'
$Node = 'D:\Node\node.exe'
$Py   = Join-Path $Root '.venv-vision\Scripts\python.exe'
$MirrorStatus = Join-Path $Root 'cloud\wearable-mirror\runtime\mirror-status.json'
$VisionErr = Join-Path $Root 'vision\runtime-vision.err.log'
$RelayDir = Join-Path $Root 'video\relay'
$RelayOut = Join-Path $RelayDir 'runtime-relay.out.log'
$VoiceDir = Join-Path $Root 'voice-gateway'
$VoiceOut = Join-Path $VoiceDir 'gateway.out.log'

$Ok = 0; $Warn = 0; $Fail = 0
function Say([string]$m, [string]$c = 'Gray') { Write-Host $m -ForegroundColor $c }
function Step([string]$m) { Write-Host ''; Write-Host "== $m ==" -ForegroundColor Cyan }
function Pass([string]$m) { $script:Ok++;   Write-Host "  [OK]   $m" -ForegroundColor Green }
function Warn([string]$m) { $script:Warn++; Write-Host "  [WARN] $m" -ForegroundColor Yellow }
function Bad ([string]$m) { $script:Fail++; Write-Host "  [FAIL] $m" -ForegroundColor Red }
function Note([string]$m) { Write-Host "  [i]    $m" -ForegroundColor DarkGray }

function Test-Port([int]$Port) { return [bool](Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) }
function Get-PortOwner([int]$Port) { return (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess }
function Get-HdcTarget {
    $sn = @(& $Hdc list targets 2>$null) | Where-Object { $_ -match '^\d{10,}' } | Select-Object -First 1
    if ($sn) { return $sn.Trim() } else { return $null }
}
function Get-DayuShell([string]$cmd) { return @(& $Hdc -t $script:Target shell $cmd 2>$null) }
function Get-VisionState {
    try { return (Invoke-WebRequest -Uri 'http://127.0.0.1:9200/v1/state' -TimeoutSec 3 -UseBasicParsing).Content | ConvertFrom-Json } catch { return $null }
}
function Test-PublicSyncHealthy {
    $s = Join-Path $Mats 'public-sync-health.ps1'
    if (-not (Test-Path $s)) { return $false }
    & powershell -NoProfile -ExecutionPolicy Bypass -File $s *> $null
    return ($LASTEXITCODE -eq 0)
}
$UiDir = Join-Path $Root 'vision\_runtime_ui'
function Save-DayuUi([string]$devName, [string]$tmpName) {
    if (-not (Test-Path $UiDir)) { New-Item -ItemType Directory -Force -Path $UiDir | Out-Null }
    & $Hdc -t $script:Target shell "uitest dumpLayout -p /data/local/tmp/$devName.json" 2>$null | Out-Null
    $local = Join-Path $UiDir "$tmpName.json"
    if (Test-Path $local) { Remove-Item $local -Force }
    & $Hdc -t $script:Target file recv "/data/local/tmp/$devName.json" $local 2>$null | Out-Null
    if (Test-Path $local) { return Get-Content $local -Raw -Encoding UTF8 } else { return '' }
}
function Click-DayuText([string]$json, [string]$text) {
    if (-not $json) { return $false }
    $pat = '\{(?=[^}]*"text":"' + [regex]::Escape($text) + '")(?=[^}]*"bounds":"\[(\d+),(\d+)\]\[(\d+),(\d+)\]")[^}]*\}'
    $m = [regex]::Match($json, $pat)
    if (-not $m.Success) { return $false }
    $cx = [int](([int]$m.Groups[1].Value + [int]$m.Groups[3].Value) / 2)
    $cy = [int](([int]$m.Groups[2].Value + [int]$m.Groups[4].Value) / 2)
    & $Hdc -t $script:Target shell "uitest uiInput click $cx $cy" | Out-Null
    return $true
}

# ---------------------------------------------------------------- 1 基础预检
Step '1/8 基础预检'
if (Test-Path $Hdc) { Pass 'hdc 存在' } else { Bad "缺少 hdc: $Hdc" }
if (Test-Path $Node) { Pass 'Node 存在' } else { Bad "缺少 Node: $Node" }
if (Test-Path $Py) { Pass '视觉 Python 环境存在' } else { Warn "缺少视觉环境: $Py（跌倒检测会跳过）" }
$ip = (Get-NetIPConfiguration -InterfaceAlias 'WLAN' -ErrorAction SilentlyContinue).IPv4Address.IPAddress
if ($ip -eq '10.127.130.179') { Pass "PC WLAN IP=$ip" }
elseif ($ip) { Warn "PC WLAN IP=$ip（ESP32 固件写死 10.127.130.179，两块节点可能连不上）" }
else { Warn '没有 WLAN 地址，ESP32 无法接入' }

$script:Target = Get-HdcTarget
if (-not $script:Target -and -not $CheckOnly) {
    Note 'hdc 没看到 DAYU200，尝试重启 hdc 服务…'
    & $Hdc kill 2>$null | Out-Null
    Start-Sleep -Seconds 2
    & $Hdc start 2>$null | Out-Null
    Start-Sleep -Seconds 3
    $script:Target = Get-HdcTarget
}
if ($script:Target) {
    Pass "DAYU200 目标(序列号): $($script:Target)"
    Note '换 USB 口不影响：设备按序列号识别；映射每次重建'
} else {
    Bad 'hdc 看不到 DAYU200（USB 数据线/上电/解锁？）'
}
if ($CheckOnly) { Say ''; Say '仅体检模式：不做启动/修改。' 'DarkGray' }

# ---------------------------------------------------------------- 2 hdc 映射
Step '2/8 hdc 端口映射（板子重启/换口后会丢）'
if ($script:Target) {
    $map = @(& $Hdc fport ls 2>$null) -join "`n"
    $need = @(
        @{ n = '9001->9000'; p = 'tcp:9001\s+tcp:9000'; c = 'fport tcp:9001 tcp:9000' },
        @{ n = 'rport 9200'; p = 'tcp:9200\s+tcp:9200[^\n]*Reverse'; c = 'rport tcp:9200 tcp:9200' },
        @{ n = '9301->9301'; p = 'tcp:9301\s+tcp:9301'; c = 'fport tcp:9301 tcp:9301' },
        @{ n = 'rport 9302'; p = 'tcp:9302\s+tcp:9302[^\n]*Reverse'; c = 'rport tcp:9302 tcp:9302' }
    )
    foreach ($it in $need) {
        if ($map -match $it.p) { Pass "$($it.n) 已存在" }
        elseif ($CheckOnly) { Warn "$($it.n) 缺失（体检模式不创建）" }
        else {
            $parts = $it.c.Split(' ')
            & $Hdc -t $script:Target $parts[0] $parts[1] $parts[2] | Out-Null
            Start-Sleep -Milliseconds 600
            $map = @(& $Hdc fport ls 2>$null) -join "`n"
            if ($map -match $it.p) { Pass "$($it.n) 已创建" } else { Bad "$($it.n) 创建失败" }
        }
    }
} else { Warn '无 hdc 目标，跳过映射' }

# ---------------------------------------------------------------- 3 P0
Step '3/8 P0：broker/bridge/public-sync'
if (Test-PublicSyncHealthy) {
    Pass 'public-sync 已 HEALTHY'
} elseif ($CheckOnly) {
    Warn 'P0 未健康（体检模式不启动）'
} elseif ($SkipP0) {
    Warn 'P0 未健康且要求 -SkipP0'
} else {
    Warn '在新窗口启动 P0：请在该窗口输入一次 INGEST_KEY，窗口不要关'
    Start-Process -FilePath 'cmd.exe' -ArgumentList '/k', (Join-Path $Mats 'start-demo-supervisor.cmd') -WorkingDirectory $Mats | Out-Null
    $deadline = (Get-Date).AddSeconds(150)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 5
        if (Test-PublicSyncHealthy) { break }
    }
    if (Test-PublicSyncHealthy) { Pass 'public-sync 已恢复' } else { Warn '150 秒内未 HEALTHY：去 supervisor 窗口输入 key 后重跑' }
}

# ---------------------------------------------------------------- 4 板端
Step '4/8 板端：homemon + 板载 APP + 客厅监护页'
if ($script:Target) {
    $ui = Save-DayuUi 'v3-ui' 'v3-ui'
    if ($ui -match '上滑解锁') {
        if ($CheckOnly) { Warn '板端锁屏（体检模式不操作）' }
        else {
            & $Hdc -t $script:Target shell 'uitest uiInput swipe 360 1100 360 350 300' | Out-Null
            Start-Sleep -Seconds 2
            Pass '已解锁屏幕'
        }
    }

    $hpid = ((Get-DayuShell 'pidof homemon') -join ' ').Trim()
    if ($hpid) { Pass "homemon 在跑（pid $hpid）" }
    elseif ($CheckOnly) { Warn 'homemon 未运行' }
    else {
        & $Hdc -t $script:Target shell "cd /data/homemon && nohup ./homemon homemon.conf >> homemon.log 2>&1 < /dev/null &" | Out-Null
        Start-Sleep -Seconds 4
        $hpid = ((Get-DayuShell 'pidof homemon') -join ' ').Trim()
        if ($hpid) { Pass "homemon 已启动（pid $hpid）" }
        else { Bad 'homemon 启动失败：看 /data/homemon/homemon.log' }
    }

    $apid = ((Get-DayuShell 'pidof com.dsh.eldercare') -join ' ').Trim()
    if (-not $apid -and -not $CheckOnly) {
        & $Hdc -t $script:Target shell 'aa start -a EntryAbility -b com.dsh.eldercare' | Out-Null
        Start-Sleep -Seconds 4
    }
    if (((Get-DayuShell 'pidof com.dsh.eldercare') -join ' ').Trim()) { Pass '板载 APP 在跑' } else { Warn '板载 APP 未运行' }

    if (-not $CheckOnly) {
        $ui = Save-DayuUi 'v3-ui2' 'v3-ui2'
        if ($ui -notmatch '监护运行中') {
            if (Click-DayuText $ui '客厅') {
                Start-Sleep -Seconds 3
                Pass '已点击「客厅」页签'
            } elseif ($ui -match '"text":"客厅"') {
                & $Hdc -t $script:Target shell 'uitest uiInput click 65 212' | Out-Null
                Start-Sleep -Seconds 3
                Pass '已点击「客厅」页签（坐标回退）'
            } else { Warn '未找到「客厅」页签，请人工切页' }
        }
        $ui = Save-DayuUi 'v3-ui3' 'v3-ui3'
    }
    if ($ui -match '监护运行中') { Pass '板载 APP 在客厅监护页（摄像头取帧）' }
    else { Warn '板载 APP 不在监护页：摄像头不取帧，视觉会判 offline' }
} else { Warn '无 hdc 目标，跳过板端' }

# ---------------------------------------------------------------- 5 视觉
Step '5/8 视觉（YOLO 跌倒检测，PC :9200）'
$vState = Get-VisionState
$visionArgs = @('.\vision\yolo_pose_service.py', '--model', '.\vision\yolo11n-pose.pt',
    '--device', 'cpu', '--listen-host', '127.0.0.1', '--listen-port', '9200',
    '--publish', '--broker', '127.0.0.1:1883', '--target-device', 'dayu200-living',
    '--ground-zone', '0,0.55,1,1')
function Start-Vision {
    Start-Process -FilePath $Py -ArgumentList $visionArgs -WorkingDirectory $Root `
        -RedirectStandardOutput (Join-Path $Root 'vision\runtime-vision.out.log') `
        -RedirectStandardError $VisionErr -WindowStyle Hidden | Out-Null
    Start-Sleep -Seconds 10
}
if (Test-Port 9200) {
    Pass '9200 在监听'
    if ($vState -and $vState.ageMs -lt 2000) { Pass "取帧新鲜（ageMs=$($vState.ageMs)）" }
    elseif ($CheckOnly) { Warn "取帧过期（ageMs=$($vState.ageMs)）" }
    else {
        Warn "视觉无新鲜帧（ageMs=$($vState.ageMs)），重启视觉"
        $owner = Get-PortOwner 9200
        if ($owner) { Stop-Process -Id $owner -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 2 }
        Start-Vision
        $vState = Get-VisionState
        if ($vState -and $vState.ageMs -lt 5000) { Pass "视觉已恢复（ageMs=$($vState.ageMs)）" } else { Warn '视觉仍无新鲜帧（检查板载 APP 是否在监护页）' }
    }
} elseif ($CheckOnly) { Warn '视觉未启动（体检模式不启动）' }
elseif (-not (Test-Path $Py)) { Bad "缺少视觉环境: $Py" }
else { Start-Vision; if (Test-Port 9200) { Pass '视觉已启动（ground-zone 0,0.55,1,1）' } else { Bad '视觉启动失败' } }

# ---------------------------------------------------------------- 6 视频 relay
Step '6/8 视频 relay（:9443）'
function Start-Relay {
    $env:VIDEO_RELAY_HOST = '0.0.0.0'; $env:VIDEO_RELAY_PORT = '9443'
    $env:DAYU_HOST = '127.0.0.1'; $env:DAYU_PORT = '9301'
    $env:BACKEND_BASE = 'https://api.luxunacc.xyz'
    Start-Process -FilePath $Node -ArgumentList 'server.js' -WorkingDirectory $RelayDir `
        -RedirectStandardOutput $RelayOut -RedirectStandardError (Join-Path $RelayDir 'runtime-relay.err.log') -WindowStyle Hidden | Out-Null
    Start-Sleep -Seconds 4
}
if (Test-Port 9443) {
    $h = ''
    try { $h = (Invoke-WebRequest -Uri 'http://127.0.0.1:9443/video/healthz' -TimeoutSec 4 -UseBasicParsing).Content } catch {}
    if ($h -match '"ok":true') {
        $bad = @()
        if (Test-Path $RelayOut) { $bad = @(Select-String -Path $RelayOut -Pattern 'invalid frame length' -ErrorAction SilentlyContinue | Select-Object -Last 5) }
        if ($bad.Count -gt 0 -and -not $CheckOnly) {
            Warn 'relay 日志有 "invalid frame length"，重启 relay'
            $owner = Get-PortOwner 9443
            if ($owner) { Stop-Process -Id $owner -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 2 }
            Start-Relay
            if (Test-Port 9443) { Pass 'relay 已重启' } else { Bad 'relay 重启失败' }
        } else { Pass 'relay /video/healthz ok' }
    } else { Warn '9443 在，但 healthz 异常' }
} elseif ($CheckOnly) { Warn 'relay 未启动（体检模式不启动）' }
else { Start-Relay; if (Test-Port 9443) { Pass 'relay 已启动' } else { Bad 'relay 启动失败' } }


# ---------------------------------------------------------------- 6.5 语音网关
Step '6.5/8 语音网关（:9302 ASR/DeepSeek/TTS + :9102 音箱）'
function Start-VoiceGateway {
    Start-Process -FilePath $Node -ArgumentList 'server.js' -WorkingDirectory $VoiceDir `
        -RedirectStandardOutput $VoiceOut -RedirectStandardError (Join-Path $VoiceDir 'gateway.err.log') -WindowStyle Hidden | Out-Null
    Start-Sleep -Seconds 3
}
if (Test-Port 9302) { Pass '语音网关已运行（9302）' }
elseif ($CheckOnly) { Warn '语音网关未启动（体检模式不启动）' }
else {
    Start-VoiceGateway
    if (Test-Port 9302) { Pass '语音网关已启动（9302）' } else { Bad '语音网关启动失败' }
}
if (Test-Port 9102) { Pass '音箱服务在听（9102）' } else { Warn '9102 未监听（网关未起或端口被占）' }

# ---------------------------------------------------------------- 7 mirror
Step '7/8 随身求助 mirror（4G/GPS）'
$mirrorOk = $false
if (Test-Path $MirrorStatus) {
    try { $m = Get-Content $MirrorStatus -Raw -Encoding UTF8 | ConvertFrom-Json; $mirrorOk = ($m.running -eq $true -and (Get-Process -Id $m.pid -ErrorAction SilentlyContinue)) } catch {}
}
if ($mirrorOk) { Pass 'mirror 在跑' }
elseif ($CheckOnly) { Warn 'mirror 未启动（体检模式不启动）' }
else {
    Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $Mats 'start-mirror-dayu.ps1'), '-Apply' -WindowStyle Hidden | Out-Null
    Start-Sleep -Seconds 8
    if ((Test-Path $MirrorStatus) -and ((Get-Content $MirrorStatus -Raw -Encoding UTF8 | ConvertFrom-Json).running -eq $true)) { Pass 'mirror 已启动' } else { Warn 'mirror 启动未确认' }
}

# ---------------------------------------------------------------- 8 验收
Step '8/8 验收汇总'
$vState = Get-VisionState
if ($vState -and $vState.ageMs -lt 2000) { Pass "视觉取帧 ageMs=$($vState.ageMs) state=$($vState.state)" } else { Warn '视觉没有新鲜帧' }

if ($script:Target) {
    $st = (Get-DayuShell 'cat /data/homemon/status.json') -join ''
    if ($st) {
        try {
            $j = $st | ConvertFrom-Json
            if ($j.monitorOnline -eq 1) { Pass '板端 monitorOnline=1（视觉链路通）' } else { Warn "板端 monitorOnline=$($j.monitorOnline)" }
            if ($j.sensors.motion.supported) { Pass '板端 PIR 已启用' } else { Warn '板端 PIR 未启用（motion.supported=false）' }
            Pass "板端状态 state=$($j.state)"
        } catch { Warn '板端 status.json 解析失败' }
    }
}

$mqOut = Join-Path $env:TEMP 'v3-mqtt.log'
if (Test-Path $mqOut) { Remove-Item $mqOut -Force }
Start-Process -FilePath $Node -ArgumentList @((Join-Path $Root 'bridge\mqtt_tool.js'), 'sub', '--broker', '127.0.0.1:1883', '--topic', 'home/#', '--seconds', '8') -RedirectStandardOutput $mqOut -RedirectStandardError "$mqOut.err" -WindowStyle Hidden | Out-Null
Start-Sleep -Seconds 10
if (Test-Path $mqOut) {
    $topics = @(Select-String -Path $mqOut -Pattern '← home/' | ForEach-Object { $_.Line.Trim() } | Select-Object -Unique)
    if ($topics.Count -gt 0) { Pass "MQTT 有数据（$($topics.Count) 个主题）" } else { Warn 'MQTT 无 home/# 数据' }
}

if (Test-PublicSyncHealthy) {
    Pass '进程级 public-sync HEALTHY'
    # 进程活着 ≠ 上行成功：supervisor 重启后 key 输错时 worker 仍显示 HEALTHY，但每次 POST 都是 401。
    $supLog = Join-Path $Root 'bridge\_test\current-runtime\supervisor\public-sync-supervisor.log'
    $ingestOk = $false
    if (Test-Path $supLog) {
        $lastOk = @(Select-String -Path $supLog -Pattern '\[cloud-sync\] OK' -Encoding UTF8 | Select-Object -Last 1)
        if ($lastOk.Count -gt 0) {
            $m = [regex]::Match($lastOk[0].Line, '^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})')
            if ($m.Success) {
                $ts = [datetime]::Parse($m.Groups[1].Value, [Globalization.CultureInfo]::InvariantCulture)
                if (((Get-Date).ToUniversalTime() - $ts).TotalSeconds -le 90) { $ingestOk = $true }
            }
        }
    }
    if ($ingestOk) { Pass '云端上行正常（最近 90 秒有 202）' }
    else { Bad '云端上行失败/已过期：多半是 supervisor 窗口里的 INGEST_KEY 输错，请重启窗口重新输入' }
} else { Warn '云端同步不 HEALTHY' }

if (Test-Port 9101) {
    $esp = @(Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -eq 9101 -and $_.RemoteAddress -ne '127.0.0.1' })
    if ($esp.Count -ge 2) { Pass "ESP32-S3 连接数=$($esp.Count)" } elseif ($esp.Count -eq 1) { Warn '只有 1 块 ESP32 在线' } else { Warn '没有 ESP32 连上 9101' }
} else { Warn '9101 未监听' }

Say ''
Say ("结果：OK=$Ok  WARN=$Warn  FAIL=$Fail") ($(if ($Fail -gt 0) { 'Red' } elseif ($Warn -gt 0) { 'Yellow' } else { 'Green' }))
Say '人工事项：① supervisor 窗口输 INGEST_KEY；② ESP32 上电/接 AP；③ 板载 APP 保持客厅监护页、不锁屏。' 'DarkGray'
if ($Fail -gt 0) { exit 2 } elseif ($Warn -gt 0) { exit 1 } else { exit 0 }
