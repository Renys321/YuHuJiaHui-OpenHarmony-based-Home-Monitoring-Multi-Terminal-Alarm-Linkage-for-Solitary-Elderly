param([switch]$SkipHostTests)
$ErrorActionPreference = 'Stop'
$projectDir = Split-Path $PSScriptRoot -Parent
$competitionDir = Split-Path $projectDir -Parent
$outDir = Join-Path $competitionDir 'evidence\2026-10-26-local-speaker-candidate'
$artifactDir = Join-Path $outDir 'LOCAL-BUILD-ONLY'
New-Item -ItemType Directory -Path $artifactDir -Force | Out-Null
$variants = @('bathroom', 'bathroomlistening', 'kitchenbaseline')
if (Test-Path -LiteralPath (Join-Path $projectDir 'build-voice-kitchenvoice\esp32_elder_node.bin')) {
    $variants += 'kitchenvoice'
}
$artifacts = foreach ($variant in $variants) {
    $source = Join-Path $projectDir ("build-voice-$variant\esp32_elder_node.bin")
    if (-not (Test-Path -LiteralPath $source)) { throw "Missing build: $variant" }
    $target = Join-Path $artifactDir ("$variant-NOT-FOR-PRODUCTION.bin")
    Copy-Item -LiteralPath $source -Destination $target -Force
    $file = Get-Item -LiteralPath $target
    if ($file.Length -gt 1048576) { throw "Image exceeds original app partition: $variant" }
    [pscustomobject]@{ Name=$file.Name; Bytes=$file.Length; SHA256=(Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash }
}
$rollbackChecks = foreach ($entry in @(
    @{Name='bathroom-8D4E9A26.bin'; SHA256='8D4E9A266950B364F1AC714194D4AD9FAA6BD70B447C72EBCA377AE863E902CE'},
    @{Name='kitchen-330D9CA6.bin'; SHA256='330D9CA6EF858B0A4043607CA2EB7E92125A9030F2D06B05DA1218B8CCE62938'}
)) {
    $path = Join-Path $competitionDir ('evidence\2026-10-24-demo-backup\artifacts\firmware\' + $entry.Name)
    $hash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
    if ($hash -ne $entry.SHA256) { throw "Frozen rollback hash mismatch: $($entry.Name)" }
    [pscustomobject]@{Name=$entry.Name; Bytes=(Get-Item -LiteralPath $path).Length; SHA256=$hash; Copied=$false}
}
$utf8 = New-Object System.Text.UTF8Encoding($false)
if (-not $SkipHostTests) {
    $testLog = @(& (Join-Path $PSScriptRoot 'verify-voice-host.ps1'))
    if (-not $?) { throw 'Host verification failed' }
    [IO.File]::WriteAllLines((Join-Path $outDir 'HOST-TEST-RESULTS.txt'), [string[]]$testLog, $utf8)
} elseif (-not (Test-Path -LiteralPath (Join-Path $outDir 'HOST-TEST-RESULTS.txt'))) {
    throw 'No existing host verification log'
}
$privateCandidates = foreach ($variant in @('bathroom', 'bathroomlistening', 'kitchenvoice', 'kitchenlistening')) {
    $path = Join-Path $projectDir ("build-voice-$variant-private\esp32_elder_node.bin")
    if (Test-Path -LiteralPath $path) {
        $file = Get-Item -LiteralPath $path
        if ($file.Length -gt 1048576) { throw "Private image exceeds app partition: $variant" }
        $configSource = if ($variant.StartsWith('kitchen')) { 'existing-private-kitchen-defaults' } else { 'existing-private-bathroom-defaults' }
        [pscustomobject]@{Variant=$variant; RelativePath="esp32-node/build-voice-$variant-private/esp32_elder_node.bin"; Bytes=$file.Length; SHA256=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash; ConfigurationSource=$configSource; CurrentDeviceConfigurationVerified=$false; CopiedToEvidence=$false; Flashed=$false}
    }
}
$result = [ordered]@{
    generatedAt=(Get-Date).ToString('o')
    classification='LOCAL_BUILD_PASS_REAL_PLAYBACK_NOT_TESTED'
    archivedArtifactsUsePlaceholderNetworkConfiguration=$true
    flashed=$false
    realPlaybackVerified=$false
    artifacts=@($artifacts)
    privateCandidates=@($privateCandidates)
    rollbackChecks=@($rollbackChecks)
}
[IO.File]::WriteAllText((Join-Path $outDir 'build-verification.json'), ($result | ConvertTo-Json -Depth 5), $utf8)
# Hash explicit controlled sources; never copy sdkconfig, .local, or credentials.
$sources = @(
    'main\node_main.c', 'main\local_voice.c', 'main\local_voice.h', 'main\voice_pins.h',
    'main\CMakeLists.txt', 'main\Kconfig.projbuild',
    'main\voice\sos.pcm', 'main\voice\warning.pcm', 'main\voice\test.pcm',
    'profiles\bathroom.sdkconfig.defaults', 'profiles\kitchen.sdkconfig.defaults',
    'profiles\voice-candidate.sdkconfig.defaults', 'profiles\voice-listening-test.sdkconfig.defaults',
    'profiles\kitchen-voice-rewire.sdkconfig.defaults',
    'test\bathroom-profile.test.js', 'test\host_voice_pins_test.c', 'test\kitchen-voice-profile.test.js',
    'tools\make-voice-assets.ps1', 'tools\build-voice-candidate.ps1',
    'tools\verify-voice-host.ps1', 'tools\archive-voice-candidate.ps1',
    'tools\inspect-kitchen-flash-backup.js', 'tools\observe-kitchen-serial.py'
)
$sourceLines = foreach ($relative in $sources) {
    $hash = (Get-FileHash -LiteralPath (Join-Path $projectDir $relative) -Algorithm SHA256).Hash
    "$hash  $relative"
}
[IO.File]::WriteAllLines((Join-Path $outDir 'SOURCE-SHA256SUMS.txt'), [string[]]$sourceLines, $utf8)
$manifest = Get-ChildItem -LiteralPath $outDir -File -Recurse |
    Where-Object { $_.Name -ne 'SHA256SUMS.txt' -and $_.FullName -notlike '*\host-tests\*' } |
    Sort-Object FullName | ForEach-Object {
        $relative = $_.FullName.Substring($outDir.Length + 1)
        "$((Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash)  $relative"
    }
[IO.File]::WriteAllLines((Join-Path $outDir 'SHA256SUMS.txt'), [string[]]$manifest, $utf8)
$result | ConvertTo-Json -Depth 5
