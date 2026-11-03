param([Parameter(Mandatory)][string]$Com)
$ErrorActionPreference = 'Stop'
foreach ($name in 'MSYSTEM','MSYSCON','MINGW_PREFIX','MSYSTEM_PREFIX','MSYS2_PATH_TYPE') {
    Remove-Item "Env:$name" -ErrorAction SilentlyContinue
}
$idf  = 'D:\Espressif-5.1.6\frameworks\esp-idf-v5.1.6'
$tools = 'D:\Espressif-5.1.6\tools'
$py   = 'D:\Espressif-5.1.6\python_env\idf5.1_py3.11_env\Scripts\python.exe'
$env:IDF_PATH = $idf
$env:IDF_TOOLS_PATH = 'D:\Espressif-5.1.6'
$env:IDF_PYTHON_ENV_PATH = 'D:\Espressif-5.1.6\python_env\idf5.1_py3.11_env'
$env:PATH = (@(
    "$env:IDF_PYTHON_ENV_PATH\Scripts",
    "$tools\xtensa-esp32s3-elf\esp-12.2.0_20230208\xtensa-esp32s3-elf\bin",
    "$tools\cmake\3.30.2\bin",
    "$tools\ninja\1.12.1",
    "$tools\idf-exe\1.0.3",
    "$tools\ccache\4.10.2\bin"
) -join ';') + ';' + $env:PATH
Push-Location 'D:\OpenHarmony\competition\firmware\bathroom'
try {
    & $py "$idf\tools\idf.py" -p $Com flash
    $code = $LASTEXITCODE
} finally { Pop-Location }
Write-Host "[exit] $code"
exit $code
