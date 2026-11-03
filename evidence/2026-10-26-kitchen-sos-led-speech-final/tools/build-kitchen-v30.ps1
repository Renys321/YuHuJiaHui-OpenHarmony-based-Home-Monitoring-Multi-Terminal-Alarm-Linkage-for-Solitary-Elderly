# LOCAL-ALARM-SPEECH-FINAL: build the kitchen production image with ES8388 volume 30.
# ASCII-only (Windows PowerShell 5.1 parses BOM-less UTF-8 .ps1 as ANSI).
param(
    [string]$EvidenceDir = 'D:\OpenHarmony\competition\evidence\2026-10-26-kitchen-sos-led-speech-final',
    [string]$OutRoot = 'D:\OpenHarmony\competition\esp32-node\.local\speech-20261026'
)
$ErrorActionPreference = 'Stop'
$tool = Join-Path $EvidenceDir 'tools\build-firmware.ps1'
$pub = 'D:\OpenHarmony\competition\esp32-node'
$defaults = @(
    (Join-Path $pub 'profiles\kitchen.sdkconfig.defaults'),
    (Join-Path $pub '.local\sdkconfig.kitchen.defaults'),
    (Join-Path $pub 'profiles\voice-candidate.sdkconfig.defaults'),
    (Join-Path $pub 'profiles\voice-volume30.sdkconfig.defaults'),
    (Join-Path $pub 'profiles\kitchen-voice-rewire.sdkconfig.defaults'),
    (Join-Path $pub 'profiles\alarm-closure.sdkconfig.defaults')
) -join ';'
& $tool -ProjectDir $pub -BuildDir (Join-Path $OutRoot 'kitchen-prod-v30') -Defaults $defaults -LogPath (Join-Path $EvidenceDir 'build\build-kitchen-speech-prod-v30.log')
Write-Host 'KITCHEN_V30_BUILD_OK'
