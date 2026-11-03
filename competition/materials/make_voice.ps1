# ============================================================================
#  make_voice.ps1 —— 把手机录的"我需要帮助"转成 APP 内置语音
#
#  用法：
#    powershell -ExecutionPolicy Bypass -File make_voice.ps1 -Input "D:\录音.m4a"
#
#  处理：统一转成 单声道 / 48kHz / 16bit PCM WAV，覆盖
#        northbound\entry\src\main\resources\rawfile\sos.wav
#        （APP 会自动识别 wav/m4a/mp3/aac/ogg，但 wav 最稳）
#  之后：重新构建并安装 APP（见 下次继续.md 命令速查）
#
#  改进：转换到临时文件，检查退出码 + 文件大小 + Duration 探测，
#        成功后才原子替换最终文件；失败时保留原有文件不变。
# ============================================================================
param(
    [Parameter(Mandatory = $true)][Alias('Input')][string]$InputPath,
    [string]$OutName = "sos.wav",
    [double]$Start = 0,
    [double]$Duration = 0
)
$ErrorActionPreference = "Stop"
$ff = 'C:\Users\<user>\.dsh-wallpaper-engine\ffmpeg\ffmpeg.exe'
if (-not (Test-Path $ff)) { throw "未找到 ffmpeg: $ff" }
if (-not (Test-Path -LiteralPath $InputPath)) { throw "找不到输入文件: $InputPath" }

# 注意：用 $PSScriptRoot（$MyInvocation.MyCommand.Path 在 -File 调用下可能为空）
$dstDir = Join-Path $PSScriptRoot "..\northbound\entry\src\main\resources\rawfile"
$dstDir = [System.IO.Path]::GetFullPath($dstDir)
$dstFinal = Join-Path $dstDir $OutName
$tmpName = [System.IO.Path]::GetRandomFileName() + ".wav"
$tmpPath = Join-Path $dstDir $tmpName

$trim = @()
if ($Start -gt 0) { $trim += '-ss', "$Start" }
if ($Duration -gt 0) { $trim += '-t', "$Duration" }

# Windows PowerShell 5.1 会把原生程序写入 stderr 的普通日志包装成
# NativeCommandError；在全局 Stop 模式下，FFmpeg 尚未返回退出码就会中断。
function Invoke-FfmpegCapture([string[]]$Arguments) {
    $savedPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = @(& $ff @Arguments 2>&1)
        $exitCode = $LASTEXITCODE
        return [pscustomobject]@{
            Output = $output
            ExitCode = $exitCode
        }
    } finally {
        $ErrorActionPreference = $savedPreference
    }
}

Write-Host "==== 转换求助语音 ====" -ForegroundColor Cyan
Write-Host "  输入: $InputPath"
Write-Host "  输出: $dstFinal"

try {
    # -af 音量归一 + 去首尾静音，保证现场喇叭音量足够
    $convertArgs = @('-y') + $trim + @(
        '-i', $InputPath,
        '-ac', '1',
        '-ar', '48000',
        '-c:a', 'pcm_s16le',
        '-af', 'silenceremove=start_periods=1:start_silence=0.1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_silence=0.2:start_threshold=-45dB,areverse,volume=1.4',
        $tmpPath
    )
    $convert = Invoke-FfmpegCapture $convertArgs
    $convert.Output | Select-String 'Duration|Output|error' | Select-Object -First 4

    if ($convert.ExitCode -ne 0) {
        $tail = ($convert.Output | Select-Object -Last 6) -join "`n"
        throw "FFmpeg 转换失败（退出码 $($convert.ExitCode)）：`n$tail"
    }

    if (-not (Test-Path $tmpPath)) {
        throw "FFmpeg 未生成输出文件"
    }

    $tmpSize = (Get-Item $tmpPath).Length
    if ($tmpSize -eq 0) {
        throw "FFmpeg 生成了空文件（0 字节）"
    }

    # 用 FFmpeg 探测 Duration，确认输出可读取。仅取探测文本；无输出目标时
    # FFmpeg 返回非零是预期行为，不能把该退出码当作文件损坏。
    $probeResult = Invoke-FfmpegCapture @('-i', $tmpPath)
    $probe = $probeResult.Output | Select-String 'Duration' | Select-Object -First 1
    if (-not $probe) {
        throw "无法从输出文件探测 Duration，文件可能损坏"
    }

    # 全部检查通过，执行原子替换（同卷 Move-Item -Force 是原子操作）
    Move-Item -Path $tmpPath -Destination $dstFinal -Force

    $size = $tmpSize / 1KB
    Write-Host ""
    Write-Host "✅ 已生成 $OutName （$([math]::Round($size,1)) KB）" -ForegroundColor Green
    Write-Host "  $probe"
    Write-Host ""
    Write-Host "下一步：重新构建并安装 APP，然后在设备上验证语音播报" -ForegroundColor Yellow
    Write-Host "  cd D:\OpenHarmony\competition\northbound  → hvigorw assembleHap → 签名 → hdc install"

} finally {
    # 清理临时文件（成功时已被 Move-Item 移走，失败时删除残留）
    if (Test-Path $tmpPath) {
        Remove-Item -Path $tmpPath -Force -ErrorAction SilentlyContinue
    }
}
