#Requires -Version 5.1
<#
用 Windows SAPI 的 Huihui 声音合成 16kHz/16bit/mono WAV。
指定的声音不存在时退到任意已安装的 zh-CN 声音；合成失败不写假音频。

用法:
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File tts.ps1 `
    -Text "请慢一点起身" -OutPath C:\tmp\a.wav

stdout 只有一行 JSON：{"ok":true,"bytes":1234} 或 {"error":"TTS_FAILED",...}
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Text,
  [Parameter(Mandatory = $true)][string]$OutPath,
  [string]$Voice = 'Microsoft Huihui Desktop',
  [int]$Rate = 0
)

$ErrorActionPreference = 'Stop'
try {
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
} catch { }

function Write-Json($obj) {
  [Console]::Out.Write(($obj | ConvertTo-Json -Compress -Depth 4))
  [Console]::Out.Flush()
}

if ([string]::IsNullOrWhiteSpace($Text)) {
  Write-Json @{ error = 'TTS_FAILED'; message = 'empty text' }
  exit 2
}

try {
  Add-Type -AssemblyName System.Speech
} catch {
  Write-Json @{ error = 'TTS_FAILED'; message = 'System.Speech unavailable' }
  exit 2
}

$synth = $null
try {
  $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $installed = $synth.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }
  if ($installed -contains $Voice) {
    $synth.SelectVoice($Voice)
  } else {
    $zh = $synth.GetInstalledVoices() |
      Where-Object { $_.VoiceInfo.Culture.Name -like 'zh-CN*' } |
      Select-Object -First 1
    if ($zh -ne $null) {
      $synth.SelectVoice($zh.VoiceInfo.Name)
    } else {
      Write-Json @{ error = 'TTS_FAILED'; message = 'no zh-CN voice installed' }
      exit 3
    }
  }
  $synth.Rate = $Rate

  $fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(
    16000,
    [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
    [System.Speech.AudioFormat.AudioChannel]::Mono)
  $synth.SetOutputToWaveFile($OutPath, $fmt)
  $synth.Speak($Text)
  $synth.SetOutputToNull()

  if (-not (Test-Path -LiteralPath $OutPath)) {
    Write-Json @{ error = 'TTS_FAILED'; message = 'wav not created' }
    exit 4
  }
  $bytes = (Get-Item -LiteralPath $OutPath).Length
  if ($bytes -le 44) {
    Write-Json @{ error = 'TTS_FAILED'; message = 'wav empty' }
    exit 4
  }
  Write-Json @{ ok = $true; bytes = $bytes }
  exit 0
} catch {
  Write-Json @{ error = 'TTS_FAILED'; message = $_.Exception.Message }
  exit 5
} finally {
  if ($synth -ne $null) {
    try { $synth.Dispose() } catch { }
  }
}
