# Cross-compile the homemon southbound daemon.
# Usage:
#   powershell -ExecutionPolicy Bypass -File build.ps1
#   powershell -ExecutionPolicy Bypass -File build.ps1 -Arch arm64
param(
    [ValidateSet('arm', 'arm64')] [string]$Arch = 'arm',
    [string]$Out = '',
    # -Strict：把警告当错误（-Werror）。用于确认新代码在 32 位目标上零告警，
    # 尤其避免 int64 毫秒运算退回 32 位溢出的老问题。
    [switch]$Strict
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
if (-not $Out) { $Out = Join-Path $root 'out' }

$rt      = 'D:\DevEcoStudio\DevEco Studio\sdk\default\openharmony\native'
$clang   = Join-Path $rt 'llvm\bin\clang.exe'
$sysroot = Join-Path $rt 'sysroot'
$target  = if ($Arch -eq 'arm64') { 'aarch64-linux-ohos' } else { 'arm-linux-ohos' }

if (-not (Test-Path -LiteralPath $clang))   { throw "OH NDK clang not found: $clang" }
New-Item -ItemType Directory -Force -Path $Out | Out-Null

$src = Join-Path $root 'src\homemon.c'
$dst = Join-Path $Out "homemon-$Arch"

Write-Host "== Build ==  target=$target"
Write-Host "   src = $src"
Write-Host "   out = $dst"
$warn = @('-O2', '-Wall', '-Wextra')
if ($Strict) { $warn += '-Werror' }
& $clang --target=$target --sysroot=$sysroot @warn -o $dst $src
if ($LASTEXITCODE -ne 0) { throw "Compilation failed (exit=$LASTEXITCODE)" }

$fi = Get-Item -LiteralPath $dst
Write-Host ("SUCCESS: {0}  ({1:N0} bytes)" -f $fi.Name, $fi.Length)

# Show the ELF architecture and required interpreter.
$readelf = Join-Path $rt 'llvm\bin\llvm-readelf.exe'
if (Test-Path -LiteralPath $readelf) {
    & $readelf -h -l $dst 2>&1 | Select-String -Pattern 'Class:|Machine:|interpreter'
}
