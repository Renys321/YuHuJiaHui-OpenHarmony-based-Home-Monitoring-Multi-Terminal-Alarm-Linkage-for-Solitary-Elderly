param([string]$Gcc = 'D:\MSYS2\ucrt64\bin\gcc.exe')
$ErrorActionPreference = 'Stop'
$projectDir = Split-Path $PSScriptRoot -Parent
$outDir = Join-Path $projectDir '..\evidence\2026-10-26-local-speaker-candidate\host-tests'
New-Item -ItemType Directory -Path $outDir -Force | Out-Null
foreach ($name in @('alarm_logic', 'bathroom_logic')) {
    $source = Join-Path $projectDir ('test\host_' + $name + '_test.c')
    $exe = Join-Path $outDir ($name + '.exe')
    & $Gcc -std=c11 -Wall -Wextra -Werror "-I$projectDir\main" $source -o $exe
    if ($LASTEXITCODE -ne 0) { throw "Host compile failed: $name" }
    & $exe
    if ($LASTEXITCODE -ne 0) { throw "Host assertions failed: $name" }
}
& node --test (Join-Path $projectDir 'test\bathroom-profile.test.js')
if ($LASTEXITCODE -ne 0) { throw 'Room profile regression failed' }
& node --test (Join-Path $projectDir 'test\kitchen-voice-profile.test.js')
if ($LASTEXITCODE -ne 0) { throw 'Kitchen voice wiring regression failed' }
$cases = @(
    @{Name='bath-voice'; Voice=1; MQ2=-1; MQ5=-1; Sos=15; Pass=$true},
    @{Name='kitchen-baseline'; Voice=0; MQ2=5; MQ5=8; Sos=-1; Pass=$true},
    @{Name='kitchen-voice-rewired'; Voice=1; MQ2=5; MQ5=6; Sos=-1; Pass=$true},
    @{Name='kitchen-voice-conflict'; Voice=1; MQ2=5; MQ5=8; Sos=-1; Pass=$false},
    @{Name='mq2-audio-pin-conflict'; Voice=1; MQ2=9; MQ5=-1; Sos=-1; Pass=$false},
    @{Name='sos-audio-pin-conflict'; Voice=1; MQ2=-1; MQ5=-1; Sos=9; Pass=$false}
)
foreach ($case in $cases) {
    $exe = Join-Path $outDir ($case.Name + '.exe')
    $params = @('-std=c11', "-I$projectDir\main", (Join-Path $projectDir 'test\host_voice_pins_test.c'),
        "-DCONFIG_NODE_VOICE_ENABLED=$($case.Voice)", "-DCONFIG_NODE_MQ2_ADC_CHANNEL=$($case.MQ2)",
        "-DCONFIG_NODE_MQ5_ADC_CHANNEL=$($case.MQ5)", "-DCONFIG_NODE_SOS_GPIO=$($case.Sos)",
        '-DCONFIG_NODE_MOTION_GPIO=36', '-DCONFIG_NODE_DOOR_GPIO=-1', '-DCONFIG_NODE_WATER_GPIO=-1',
        '-DCONFIG_NODE_BUZZER_GPIO=-1', '-DCONFIG_NODE_DHT11_GPIO=-1', '-DCONFIG_NODE_AHT20_ENABLED=1',
        '-DCONFIG_NODE_I2C_SDA_GPIO=4', '-DCONFIG_NODE_I2C_SCL_GPIO=5', '-o', $exe)
    $savedPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $output = @(& $Gcc @params 2>&1)
    $compileExit = $LASTEXITCODE
    $ErrorActionPreference = $savedPreference
    if ($case.Pass) {
        if ($compileExit -ne 0) { throw "Unexpected compile failure: $($case.Name)" }
        & $exe
        if ($LASTEXITCODE -ne 0) { throw "Guard test failed: $($case.Name)" }
    } elseif ($compileExit -eq 0 -or ($output -join "`n") -notmatch 'VOICE_PIN_CONFLICT') {
        throw "Expected pin conflict was not rejected: $($case.Name)"
    }
    Write-Output "PASS $($case.Name)"
}
