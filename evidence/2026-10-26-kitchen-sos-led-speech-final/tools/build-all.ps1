# LOCAL-ALARM-SPEECH-FINAL build driver (2026-10-26)
# Builds the kitchen (public tree) and bathroom (private tree) production + bench images
# with the SAME overlay lists that produced the last accepted production firmwares.
# ASCII-only on purpose: Windows PowerShell 5.1 parses BOM-less UTF-8 .ps1 as ANSI.
param(
    [string]$EvidenceDir = 'D:\OpenHarmony\competition\evidence\2026-10-26-kitchen-sos-led-speech-final',
    [string]$OutRoot = 'D:\OpenHarmony\competition\esp32-node\.local\speech-20261026'
)
$ErrorActionPreference = 'Stop'
$tool = Join-Path $EvidenceDir 'tools\build-firmware.ps1'
$pub = 'D:\OpenHarmony\competition\esp32-node'
$bath = 'D:\OpenHarmony\competition\esp32-node\.local\bathroom-voice-20261026\src'
$logDir = Join-Path $EvidenceDir 'build'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$commonVoice = @(
    (Join-Path $pub 'profiles\voice-candidate.sdkconfig.defaults')
)
$kitchenDefaults = @(
    (Join-Path $pub 'profiles\kitchen.sdkconfig.defaults'),
    (Join-Path $pub '.local\sdkconfig.kitchen.defaults'),
    (Join-Path $pub 'profiles\voice-candidate.sdkconfig.defaults'),
    (Join-Path $pub 'profiles\voice-volume20.sdkconfig.defaults'),
    (Join-Path $pub 'profiles\kitchen-voice-rewire.sdkconfig.defaults'),
    (Join-Path $pub 'profiles\alarm-closure.sdkconfig.defaults')
)
$kitchenBenchDefaults = @(
    (Join-Path $pub 'profiles\kitchen.sdkconfig.defaults'),
    (Join-Path $pub '.local\sdkconfig.kitchen.defaults'),
    (Join-Path $pub 'profiles\voice-candidate.sdkconfig.defaults'),
    (Join-Path $pub 'profiles\voice-volume20.sdkconfig.defaults'),
    (Join-Path $pub 'profiles\kitchen-voice-rewire.sdkconfig.defaults'),
    (Join-Path $pub 'profiles\alarm-bench.sdkconfig.defaults')
)
$bathDefaults = @(
    (Join-Path $bath 'profiles\bathroom.sdkconfig.defaults'),
    (Join-Path $pub '.local\sdkconfig.bathroom.defaults'),
    (Join-Path $bath 'profiles\voice-candidate.sdkconfig.defaults'),
    (Join-Path $bath 'profiles\voice-volume30.sdkconfig.defaults'),
    (Join-Path $bath 'profiles\alarm-closure.sdkconfig.defaults')
)
$bathBenchDefaults = @(
    (Join-Path $bath 'profiles\bathroom.sdkconfig.defaults'),
    (Join-Path $pub '.local\sdkconfig.bathroom.defaults'),
    (Join-Path $bath 'profiles\voice-candidate.sdkconfig.defaults'),
    (Join-Path $bath 'profiles\voice-volume30.sdkconfig.defaults'),
    (Join-Path $bath 'profiles\alarm-bench.sdkconfig.defaults')
)

$jobs = @(
    @{ Name = 'kitchen-prod';  Project = $pub;  Build = (Join-Path $OutRoot 'kitchen-prod');  Defaults = $kitchenDefaults;      Log = (Join-Path $logDir 'build-kitchen-speech-prod.log') },
    @{ Name = 'kitchen-bench'; Project = $pub;  Build = (Join-Path $OutRoot 'kitchen-bench'); Defaults = $kitchenBenchDefaults; Log = (Join-Path $logDir 'build-kitchen-speech-bench.log') },
    @{ Name = 'bath-prod';     Project = $bath; Build = (Join-Path $OutRoot 'bath-prod');     Defaults = $bathDefaults;         Log = (Join-Path $logDir 'build-bath-speech-prod.log') },
    @{ Name = 'bath-bench';    Project = $bath; Build = (Join-Path $OutRoot 'bath-bench');    Defaults = $bathBenchDefaults;    Log = (Join-Path $logDir 'build-bath-speech-bench.log') }
)

foreach ($j in $jobs) {
    $defaults = ($j.Defaults -join ';')
    Write-Host ("=== building {0} ({1}) ===" -f $j.Name, $j.Project)
    & $tool -ProjectDir $j.Project -BuildDir $j.Build -Defaults $defaults -LogPath $j.Log
    if ($LASTEXITCODE -ne 0) { throw ("build failed: {0}" -f $j.Name) }
}
Write-Host 'ALL_BUILDS_OK'
