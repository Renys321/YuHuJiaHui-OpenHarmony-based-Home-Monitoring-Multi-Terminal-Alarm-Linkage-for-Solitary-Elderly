# voice-chain-test.ps1 —— 9303 语音上传链路回归（ASR→健康分支→clip/answer）
[CmdletBinding()]
param([int]$Cycles = 2, [string]$Target = 'esp32-bath')
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
$Node = 'D:\Node\node.exe'
$Sim = Join-Path $PSScriptRoot 'voice-chain-sim.js'
$Wav = Join-Path $PSScriptRoot 'fixtures\health-say-bu-shufu.wav'
$LogDir = Join-Path $Root 'logs'; New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$Report = Join-Path $LogDir 'voice-chain-report.log'
$fail = 0
for ($i = 1; $i -le $Cycles; $i++) {
    Write-Host "`n-- 语音链路 第 $i 轮 --" -ForegroundColor Cyan
    if (-not (Test-Path $Wav)) { Write-Host "  [FAIL] 缺少 WAV $Wav" Red; $fail++; continue }
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    # 用 reason=question：固件 KEY1 短按真实发出的就是它（node_main.c:2048），
    # 网关那条 health 分支生产上没有入口。
    # 注意：PowerShell 调原生 node 时会丢弃空字符串参数，导致 argv 错位；这里用 none 占位。
    $out = & $Node $Sim $Wav $Target 卫生间 none question 2>&1 | Out-String
    $sw.Stop()
    $okAsr = $out -match 'asr '
    $okAnswer = $out -match 'answer '
    $okClip = $out -match 'clip'
    $ok = $okAsr -and $okAnswer -and $okClip
    $detail = "asr=$okAsr answer=$okAnswer clip=$okClip"
    Write-Host ("  [{0}] {1} ({2}ms)" -f $(if ($ok) { 'PASS' } else { 'FAIL' }), $detail, $sw.ElapsedMilliseconds) -ForegroundColor $(if ($ok) { 'Green' } else { 'Red' })
    Add-Content $Report ("{0} cycle={1} ok={2} {3} ms={4}" -f (Get-Date -Format o), $i, $ok, $detail, $sw.ElapsedMilliseconds)
    if (-not $ok) { $fail++ }
    Start-Sleep -Seconds 2
}
Write-Host "`nvoice-chain cycles=$Cycles pass=$($Cycles-$fail) fail=$fail" -ForegroundColor $(if ($fail -eq 0) { 'Green' } else { 'Red' })
if ($fail -gt 0) { exit 1 } else { exit 0 }
