param(
    [ValidateSet('Bathroom', 'BathroomListening', 'KitchenBaseline', 'KitchenConflict', 'KitchenVoice', 'KitchenListening')]
    [string]$Variant = 'Bathroom',
    [switch]$UseExistingBathroomConfig,
    [switch]$UseExistingKitchenConfig,
    [ValidateRange(0, 20)]
    [int]$Volume = 15,
    [string]$IdfRoot = 'D:\Espressif-5.1.6'
)
$ErrorActionPreference = 'Stop'
$projectDir = Split-Path $PSScriptRoot -Parent
$env:IDF_TOOLS_PATH = $IdfRoot
$env:IDF_PYTHON_ENV_PATH = Join-Path $IdfRoot 'python_env\idf5.1_py3.11_env'
$env:PATH = "$env:IDF_PYTHON_ENV_PATH\Scripts;$env:PATH"
. (Join-Path $IdfRoot 'frameworks\esp-idf-v5.1.6\export.ps1')
if ($UseExistingBathroomConfig -and $UseExistingKitchenConfig) { throw 'Select only one room private configuration' }
$suffix = if ($UseExistingBathroomConfig -or $UseExistingKitchenConfig) { '-private' } else { '' }
if ($Volume -ne 15) { $suffix += '-v' + $Volume }
$buildDir = Join-Path $projectDir ('build-voice-' + $Variant.ToLowerInvariant() + $suffix)
$room = if ($Variant.StartsWith('Kitchen')) { 'kitchen' } else { 'bathroom' }
$defaults = Join-Path $projectDir ('profiles\' + $room + '.sdkconfig.defaults')
if ($UseExistingBathroomConfig) {
    if ($room -ne 'bathroom') { throw 'Existing deployment configuration allowed only for bathroom' }
    $privateDefaults = Join-Path $projectDir '.local\sdkconfig.bathroom.defaults'
    if (-not (Test-Path -LiteralPath $privateDefaults)) { throw 'Existing bathroom deployment defaults missing' }
    # Compiler consumes the existing private file. Do not display, copy to
    # evidence, or parse credential values here. No WiFi/AP changes.
    $defaults += ';' + $privateDefaults
}
if ($UseExistingKitchenConfig) {
    if ($room -ne 'kitchen') { throw 'Kitchen deployment configuration allowed only for kitchen' }
    $privateDefaults = Join-Path $projectDir '.local\sdkconfig.kitchen.defaults'
    if (-not (Test-Path -LiteralPath $privateDefaults)) { throw 'Existing kitchen deployment defaults missing' }
    # Let the compiler consume private settings without printing their values.
    $defaults += ';' + $privateDefaults
}
if ($Variant -ne 'KitchenBaseline') {
    $overlay = if ($Variant -in @('BathroomListening', 'KitchenListening')) { 'voice-listening-test' } else { 'voice-candidate' }
    $defaults += ';' + (Join-Path $projectDir ('profiles\' + $overlay + '.sdkconfig.defaults'))
}
if ($Variant -in @('KitchenVoice', 'KitchenListening')) {
    $defaults += ';' + (Join-Path $projectDir 'profiles\kitchen-voice-rewire.sdkconfig.defaults')
}
if ($Volume -ne 15) {
    if ($Volume -ne 20) { throw 'Only the reviewed volume-20 overlay is currently prepared' }
    $defaults += ';' + (Join-Path $projectDir 'profiles\voice-volume20.sdkconfig.defaults')
}
# Isolated configuration. Default builds use placeholders; the explicit private
# option lets the compiler reuse existing local defaults without displaying them.
# Neither option flashes. Private outputs stay outside the evidence directory.
Push-Location $projectDir
try {
    & python (Join-Path $env:IDF_PATH 'tools\idf.py') -B $buildDir '-D' "SDKCONFIG=$buildDir\sdkconfig" '-D' "SDKCONFIG_DEFAULTS=$defaults" build
    $buildExit = $LASTEXITCODE
} finally { Pop-Location }
if ($buildExit -ne 0) { throw "Candidate build failed: $Variant (exit $buildExit)" }
Get-FileHash -LiteralPath (Join-Path $buildDir 'esp32_elder_node.bin') -Algorithm SHA256
