# 构建"PC 测试版本"：南向纯逻辑单测（在 PC 上真实运行）。
# 覆盖：
#   time_util_test      — 64 位秒->毫秒、2017 不可信 / 2026 可信、秒毫秒区分、UTC 不加 8h
#   climate_valid_test  — 温湿度读取有效性（valid 语义）
#   motion_gate_test    — 活动监测能力/无数据不判定/时钟跳变/盲区暂停（2026-10-27 修复）
#   judge_logic_test    — 判定段优先级 + 无 PIR 门控（GAS>SMOKE>SOS>NO_MOTION>CLIMATE>IDLE）
# 说明：homemon 本体是 Linux/POSIX 守护进程，无法在 Windows 上直接运行；
#       能真正跑在 PC 上的是这些纯逻辑测试（真机侧另有 `homemon --selftest`）。
param(
    [string]$Compiler = ''      # 缺省自动探测 MSYS2 gcc / clang
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

if (-not $Compiler) {
    foreach ($c in @('D:\MSYS2\ucrt64\bin\gcc.exe', 'gcc', 'clang')) {
        $cmd = Get-Command $c -ErrorAction SilentlyContinue
        if ($cmd) { $Compiler = $cmd.Source; break }
    }
}
if (-not $Compiler) { throw 'no host C compiler found (expected MSYS2 gcc or clang)' }

$outDir = Join-Path $root 'out'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$inc = Join-Path $root 'src'
$tests = @('time_util_test', 'climate_valid_test', 'motion_gate_test', 'judge_logic_test')

$failed = @()
foreach ($name in $tests) {
    $src = Join-Path $root "tests\$name.c"
    $exe = Join-Path $outDir "$name.exe"
    Write-Host "== Host test build ==  compiler=$Compiler  test=$name"
    & $Compiler -std=c11 -O2 -Wall -Wextra -Werror -pedantic -I $inc $src -o $exe
    if ($LASTEXITCODE -ne 0) { throw "$name host test compilation failed (exit=$LASTEXITCODE)" }
    Write-Host "SUCCESS: $exe"
    & $exe
    if ($LASTEXITCODE -ne 0) { $failed += $name }
}

if ($failed.Count -gt 0) { throw "host tests FAILED: $($failed -join ', ')" }
Write-Host "ALL HOST TESTS PASSED ($($tests.Count) binaries)"
