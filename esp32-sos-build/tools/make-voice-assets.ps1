param([string]$Ffmpeg = 'C:\Users\<user>\.dsh-wallpaper-engine\ffmpeg\ffmpeg.exe')
$ErrorActionPreference = 'Stop'
$projectDir = Split-Path $PSScriptRoot -Parent
$assetDir = Join-Path $projectDir 'main\voice'
New-Item -ItemType Directory -Path $assetDir -Force | Out-Null
if (-not (Test-Path -LiteralPath $Ffmpeg)) { throw 'FFmpeg is required for bounded PCM conversion' }
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    $synth.SelectVoice('Microsoft Huihui Desktop')
    $synth.Rate = 0
    $clips = @{
        'warning' = '监测到异常，请前来查看。'
        'test' = '语音播放测试，设备未触发告警。'
    }
    foreach ($name in $clips.Keys) {
        $wav = Join-Path $assetDir ($name + '.wav')
        $synth.SetOutputToWaveFile($wav)
        $synth.Speak($clips[$name])
        $synth.SetOutputToNull()
    }
} finally { $synth.Dispose() }
$inputs = @{
    'sos' = Join-Path $projectDir '..\materials\sos-voice-正式.wav'
    'warning' = Join-Path $assetDir 'warning.wav'
    'test' = Join-Path $assetDir 'test.wav'
}
foreach ($name in $inputs.Keys) {
    $pcm = Join-Path $assetDir ($name + '.pcm')
    & $Ffmpeg -hide_banner -loglevel error -y -i $inputs[$name] -af 'silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse' -ac 1 -ar 16000 -c:a pcm_s16le -f s16le $pcm
    if ($LASTEXITCODE -ne 0) { throw "PCM conversion failed: $name" }
    $bytes = (Get-Item -LiteralPath $pcm).Length
    if ($bytes -le 0 -or $bytes -gt 320000 -or $bytes % 2 -ne 0) { throw "Invalid PCM size: $name" }
    [pscustomobject]@{Clip=$name; Bytes=$bytes; Seconds=$bytes/32000; SHA256=(Get-FileHash -LiteralPath $pcm -Algorithm SHA256).Hash}
}
