# WIRELESS-SOS-NOTICE: synthesise the cross-room notice clip with SAPI (offline, no network).
# ASCII-only body; the spoken text lives in a UTF-8 sidecar file to avoid PS 5.1 encoding issues.
param(
    [Parameter(Mandatory = $true)][string]$TextFile,
    [Parameter(Mandatory = $true)][string]$OutWav,
    [string]$Voice = 'Microsoft Huihui Desktop',
    [int]$Rate = -1
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech

$text = [System.IO.File]::ReadAllText($TextFile, [System.Text.UTF8Encoding]::new($false)).Trim()
if (-not $text) { throw "empty text file: $TextFile" }

$outDir = Split-Path -Parent $OutWav
if ($outDir -and -not (Test-Path -LiteralPath $outDir)) {
    New-Item -ItemType Directory -Path $outDir -Force | Out-Null
}

$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    $synth.SelectVoice($Voice)
    $synth.Rate = $Rate
    $synth.SetOutputToWaveFile($OutWav)
    $synth.Speak($text)
} finally {
    $synth.Dispose()
}
$len = (Get-Item -LiteralPath $OutWav).Length
Write-Host "TTS_OK voice=$Voice rate=$Rate bytes=$len out=$OutWav"
