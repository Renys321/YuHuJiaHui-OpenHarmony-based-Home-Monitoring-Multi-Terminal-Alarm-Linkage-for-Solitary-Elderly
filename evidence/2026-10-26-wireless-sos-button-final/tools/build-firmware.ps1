# LOCAL-ALARM-VOICE-CLOSURE firmware build helper (isolated build dir; prints no secrets).
# Does not flash, does not change Wi-Fi, does not touch production build dirs.
# NOTE: kept ASCII-only for Windows PowerShell 5.1 script parsing.
param(
    [Parameter(Mandatory = $true)][string]$ProjectDir,
    [Parameter(Mandatory = $true)][string]$BuildDir,
    [Parameter(Mandatory = $true)][string]$Defaults,
    [Parameter(Mandatory = $true)][string]$LogPath,
    [string]$IdfRoot = 'D:\Espressif-5.1.6',
    [switch]$AllowExistingBuildDir
)
$ErrorActionPreference = 'Stop'
$idf = Join-Path $IdfRoot 'frameworks\esp-idf-v5.1.6'
$pyenv = Join-Path $IdfRoot 'python_env\idf5.1_py3.11_env'
$python = Join-Path $pyenv 'Scripts\python.exe'
if (-not (Test-Path -LiteralPath $idf)) { throw "missing IDF: $idf" }
if (-not (Test-Path -LiteralPath $python)) { throw "missing python: $python" }
$env:IDF_PATH = $idf
$env:IDF_TOOLS_PATH = $IdfRoot
$env:IDF_PYTHON_ENV_PATH = $pyenv
$env:ESP_ROM_ELF_DIR = Join-Path $IdfRoot 'tools\esp-rom-elfs\20230320'
$toolPaths = @(
    (Join-Path $IdfRoot 'tools\xtensa-esp32s3-elf\esp-12.2.0_20230208\xtensa-esp32s3-elf\bin'),
    (Join-Path $IdfRoot 'tools\xtensa-esp32-elf\esp-12.2.0_20230208\xtensa-esp32-elf\bin'),
    (Join-Path $IdfRoot 'tools\riscv32-esp-elf\esp-12.2.0_20230208\riscv32-esp-elf\bin'),
    (Join-Path $IdfRoot 'tools\cmake\3.30.2\bin'),
    (Join-Path $IdfRoot 'tools\ninja\1.12.1'),
    (Join-Path $IdfRoot 'tools\idf-exe\1.0.3'),
    (Join-Path $IdfRoot 'tools\ccache\4.10.2\ccache-4.10.2-windows-x86_64'),
    (Join-Path $pyenv 'Scripts'),
    (Join-Path $idf 'tools')
)
foreach ($p in $toolPaths) { if (-not (Test-Path -LiteralPath $p)) { throw "missing tool path: $p" } }
$env:PATH = ($toolPaths -join ';') + ';' + $env:PATH

if (-not (Test-Path -LiteralPath $ProjectDir)) { throw "missing project dir: $ProjectDir" }
if ((Test-Path -LiteralPath $BuildDir) -and -not $AllowExistingBuildDir) {
    throw "build dir already exists, refusing to reuse: $BuildDir"
}
New-Item -ItemType Directory -Path $BuildDir -Force | Out-Null
$logDir = Split-Path -Parent $LogPath
if ($logDir -and -not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

Push-Location $ProjectDir
$saved = $ErrorActionPreference
try {
    $ErrorActionPreference = 'Continue'   # idf.py writes progress to stderr
    & $python (Join-Path $idf 'tools\idf.py') -B $BuildDir '-D' "SDKCONFIG=$BuildDir\sdkconfig" '-D' "SDKCONFIG_DEFAULTS=$Defaults" build 2>&1 |
        Tee-Object -FilePath $LogPath
    $code = $LASTEXITCODE
} finally {
    $ErrorActionPreference = $saved
    Pop-Location
}
if ($code -ne 0) { throw "build failed (exit $code): $BuildDir" }
$bin = Join-Path $BuildDir 'esp32_elder_node.bin'
if (-not (Test-Path -LiteralPath $bin)) { throw "missing output bin: $bin" }
$hash = (Get-FileHash -LiteralPath $bin -Algorithm SHA256).Hash
$size = (Get-Item -LiteralPath $bin).Length
Write-Host "BUILD_OK $bin size=$size sha256=$hash"
