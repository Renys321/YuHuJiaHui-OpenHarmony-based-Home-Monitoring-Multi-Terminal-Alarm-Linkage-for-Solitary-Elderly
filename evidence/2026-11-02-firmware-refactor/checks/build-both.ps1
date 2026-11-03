$ErrorActionPreference = 'Stop'
Remove-Item Env:MSYSTEM -ErrorAction SilentlyContinue
Remove-Item Env:MSYS -ErrorAction SilentlyContinue
Remove-Item Env:MINGW_PREFIX -ErrorAction SilentlyContinue
$env:IDF_TOOLS_PATH = 'D:\Espressif-5.1.6'
$env:PATH = 'D:\Espressif-5.1.6\python_env\idf5.1_py3.11_env\Scripts;' + $env:PATH
& 'D:\OpenHarmony\competition\firmware\tools\build-node.ps1' -Node kitchen -Action build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& 'D:\OpenHarmony\competition\firmware\tools\build-node.ps1' -Node bathroom -Action build
exit $LASTEXITCODE
