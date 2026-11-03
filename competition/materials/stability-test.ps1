# stability-test.ps1 —— 多轮链路稳定性测试（当前演示栈）
# 用法：
#   powershell -File materials\stability-test.ps1 -Cycles 3
#   powershell -File materials\stability-test.ps1 -Cycles 3 -SpeakerTarget esp32-kitchen
#   powershell -File materials\stability-test.ps1 -Cycles 1 -Question '我不舒服'
# 每轮：端口/映射 → 9302 文本问答 → 目标音箱推送/回执断言 → 公网 health
#
# 变量名大小写不敏感：$SpeakerTarget 是音箱 deviceId，$dayuSerial 是 DAYU 序列号，别写混。
[CmdletBinding()]
param(
    [int]$Cycles = 3,
    [string]$SpeakerTarget = 'esp32-bath',
    [string]$Question = '今天天气怎么样'
)

$ErrorActionPreference = 'Stop'
# 防误响保险：存在 logs/.demo-quiet-lock 时，拒绝执行会向音箱推送 PCM/本地片段的测试。
# 演示或有人并行跑验收时创建该文件即可静默；需要测试时删除它。
$QuietLock = Join-Path (Split-Path $PSScriptRoot -Parent) 'logs/.demo-quiet-lock'
if (Test-Path -LiteralPath $QuietLock) {
    Write-Host '[QUIET] 检测到 logs/.demo-quiet-lock：已跳过本脚本（不向音箱推送语音）。' -ForegroundColor Yellow
    Write-Host '[QUIET] 需要执行测试时，删除该文件后重试。' -ForegroundColor Yellow
    exit 3
}
$Root = Split-Path $PSScriptRoot -Parent
$Hdc = 'D:\OpenHarmony\tools\hdc\hdc.exe'
$LogDir = Join-Path $Root 'logs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$Report = Join-Path $LogDir 'stability-report.log'
$GatewayLog = Join-Path $Root 'voice-gateway\gateway.out.log'
$Results = New-Object System.Collections.Generic.List[object]

# 纯 TCP 探测：不依赖 WMI/CIM（受限会话里 Get-NetTCPConnection 会“拒绝访问”导致假 FAIL）
function Test-Port([int]$Port) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $task = $client.ConnectAsync('127.0.0.1', $Port)
        if (-not $task.Wait(800)) { return $false }
        return $client.Connected
    } catch { return $false } finally { $client.Close() }
}
function Add-Result([int]$cycle, [string]$name, [bool]$ok, [string]$detail, [int]$ms) {
    $Results.Add([pscustomobject]@{ Cycle = $cycle; Check = $name; Ok = $ok; Detail = $detail; Ms = $ms }) | Out-Null
    $tag = if ($ok) { 'PASS' } else { 'FAIL' }
    Write-Host ("  [{0}] {1} ({2}ms) {3}" -f $tag, $name, $ms, $detail) -ForegroundColor $(if ($ok) { 'Green' } else { 'Red' })
}

function Ask-Gateway([string]$text, [string]$speakerTarget) {
    $client = New-Object System.Net.Sockets.TcpClient
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $client.Connect('127.0.0.1', 9302)
        $stream = $client.GetStream()
        $stream.ReadTimeout = 10000
        $writer = New-Object System.IO.StreamWriter($stream, (New-Object System.Text.UTF8Encoding($false)))
        $writer.AutoFlush = $true
        $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8)
        $writer.WriteLine('{"type":"hello","protocol":1}')
        $writer.WriteLine((@{ type = 'text_query'; text = $text; target = $speakerTarget } | ConvertTo-Json -Compress))
        $answer = $null
        $deadline = (Get-Date).AddSeconds(10)
        while ((Get-Date) -lt $deadline) {
            $line = $reader.ReadLine()
            if ($null -eq $line) { break }
            if ($line -match '"type":"answer"') {
                $obj = $line | ConvertFrom-Json
                $answer = [string]$obj.text
                break
            }
        }
        $sw.Stop()
        return @{ Answer = $answer; Ms = [int]$sw.ElapsedMilliseconds }
    } finally {
        $client.Close()
    }
}

function Test-CloudHealth {
    # 优先 node fetch：受限 shell 的 .NET TLS 不可用，避免把环境问题误判成云端故障
    $nodeExe = 'D:/Node/node.exe'
    if (Test-Path $nodeExe) {
        try {
            $out = (& $nodeExe -e "fetch('https://api.luxunacc.xyz/healthz').then(r=>r.json()).then(j=>console.log(j&&j.ok?'ok':'notok')).catch(e=>console.log('err'))" 2>$null) -join ''
            if ($out.Trim() -eq 'ok') { return @{ Ok = $true; Detail = 'ok(node)' } }
        } catch { }
    }
    try {
        $h = Invoke-RestMethod -Uri 'https://api.luxunacc.xyz/healthz' -TimeoutSec 8
        return @{ Ok = [bool]$h.ok; Detail = $(if ($h.ok) { 'ok' } else { 'not ok' }) }
    } catch { return @{ Ok = $false; Detail = $_.Exception.Message } }
}

function Get-GatewayLineCount {
    if (-not (Test-Path -LiteralPath $GatewayLog)) { return 0 }
    return @(Get-Content -LiteralPath $GatewayLog -Encoding UTF8 -ErrorAction SilentlyContinue).Count
}
function Get-GatewayLogDelta([int]$fromLine) {
    if (-not (Test-Path -LiteralPath $GatewayLog)) { return '' }
    $lines = @(Get-Content -LiteralPath $GatewayLog -Encoding UTF8 -ErrorAction SilentlyContinue | Select-Object -Skip $fromLine)
    return ($lines -join "`n")
}
function Wait-GatewayLog([int]$fromLine, [string]$pattern, [int]$timeoutSec) {
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    while ((Get-Date) -lt $deadline) {
        $delta = Get-GatewayLogDelta $fromLine
        if ($delta -match $pattern) { return $delta }
        Start-Sleep -Milliseconds 500
    }
    return (Get-GatewayLogDelta $fromLine)
}

Write-Host "=== 稳定性测试 cycles=$Cycles target=$SpeakerTarget question=$Question ===" -ForegroundColor Cyan
$healthKeys = @('不舒服', '难受', '头晕', '胸闷', '恶心', '心慌', '喘不上', '疼')
$isHealthQuestion = $false
foreach ($k in $healthKeys) { if ($Question.Contains($k)) { $isHealthQuestion = $true } }
$escTarget = [regex]::Escape($SpeakerTarget)
$pushPattern = '已推送 \d+B PCM 到 [1-9]\d* 个节点（仅 ' + $escTarget + '）'
$donePattern = '"node"\s*:\s*"' + $escTarget + '"\s*,\s*"ok"\s*:\s*1'
$otherNode = if ($SpeakerTarget -eq 'esp32-kitchen') { 'esp32-bath' } else { 'esp32-kitchen' }
$crossPattern = '"node"\s*:\s*"' + [regex]::Escape($otherNode) + '"'

for ($i = 1; $i -le $Cycles; $i++) {
    Write-Host "`n-- 第 $i 轮 --" -ForegroundColor Cyan

    $portsOk = (Test-Port 9302) -and (Test-Port 9303) -and (Test-Port 9102)
    Add-Result $i 'gateway ports 9302/9303/9102' $portsOk ($(if ($portsOk) { 'listening' } else { 'missing' })) 0

    # 别用 $target：大小写不敏感，会撞上 $SpeakerTarget，把序列号当成音箱。
    $dayuSerial = $null
    for ($try = 0; $try -lt 2 -and -not $dayuSerial; $try++) {
        $dayuSerial = @(& $Hdc list targets 2>$null) | Where-Object { $_ -match '^\d{10,}' } | Select-Object -First 1
        if (-not $dayuSerial) { Start-Sleep -Milliseconds 800 }
    }
    $hdcOk = $false; $hdcDetail = 'no target（检查 USB / 跑 restore-hdc-mappings.ps1）'
    if ($dayuSerial) {
        $map = @(& $Hdc -t $dayuSerial fport ls 2>$null) -join "`n"
        $hdcOk = ($map -match 'tcp:9001\s+tcp:9000') -and ($map -match 'tcp:9302\s+tcp:9302')
        $hdcDetail = if ($hdcOk) { '9001+9302' } else { 'mapping missing' }
    }
    Add-Result $i 'DAYU hdc mapping' $hdcOk $hdcDetail 0

    $logBefore = Get-GatewayLineCount
    try {
        $r = Ask-Gateway $Question $SpeakerTarget
        $ok = ($null -ne $r.Answer) -and ($r.Answer.Length -gt 0) -and ($r.Answer.Length -le 40)
        Add-Result $i 'text query + answer<=40' $ok ("{0} 字: {1}" -f $(if ($r.Answer) { $r.Answer.Length } else { 0 }), $r.Answer) $r.Ms

        $pushDelta = Wait-GatewayLog $logBefore $pushPattern 20
        $pushOk = [bool]($pushDelta -match $pushPattern)
        Add-Result $i 'target speaker push' $pushOk ($(if ($pushOk) { "matched $SpeakerTarget" } else { "gateway log 无定向推送（$SpeakerTarget）" })) 0

        $doneDelta = Wait-GatewayLog $logBefore $donePattern 40
        $doneOk = [bool]($doneDelta -match $donePattern)
        Add-Result $i 'speaker done ok=1' $doneOk ($(if ($doneOk) { "$SpeakerTarget 已回执" } else { "未等到 $SpeakerTarget 的 done ok=1" })) 0

        $crossOk = -not [bool]($doneDelta -match $crossPattern)
        Add-Result $i 'no cross-node playback' $crossOk ($(if ($crossOk) { "仅 $SpeakerTarget" } else { "意外出现 $otherNode 回执" })) 0

        if ($isHealthQuestion) {
            $clipPattern = '本地片段播报：clip=9 推送到 1 个节点（仅 ' + $escTarget + '）'
            $clipDelta = Wait-GatewayLog $logBefore $clipPattern 10
            $clipOk = [bool]($clipDelta -match $clipPattern)
            Add-Result $i 'local clip=9 push' $clipOk ($(if ($clipOk) { 'clip 已定向推送（无节点回执，仅网关侧）' } else { '未见 clip=9 推送' })) 0
        }
    } catch {
        Add-Result $i 'text query + answer<=40' $false $_.Exception.Message 0
    }

    $cloud = Test-CloudHealth
    Add-Result $i 'cloud healthz' $cloud.Ok $cloud.Detail 0

    Start-Sleep -Seconds 2
}

$fail = @($Results | Where-Object { -not $_.Ok }).Count
Write-Host "`n=== 汇总 ===" -ForegroundColor Cyan
$Results | Format-Table -AutoSize
$summary = "cycles=$Cycles target=$SpeakerTarget pass=$($Results.Count - $fail) fail=$fail"
Write-Host $summary -ForegroundColor $(if ($fail -eq 0) { 'Green' } else { 'Red' })
Add-Content $Report "$(Get-Date -Format o) $summary"
$Results | ForEach-Object { Add-Content $Report ("{0} cycle={1} check={2} ok={3} ms={4} detail={5}" -f (Get-Date -Format o), $_.Cycle, $_.Check, $_.Ok, $_.Ms, $_.Detail) }
if ($fail -gt 0) { exit 1 } else { exit 0 }
