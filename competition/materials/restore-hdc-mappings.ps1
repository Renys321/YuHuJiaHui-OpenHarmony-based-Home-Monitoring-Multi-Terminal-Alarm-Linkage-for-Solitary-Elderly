# restore-hdc-mappings.ps1 — 一键恢复 DAYU200 到 PC 的 hdc 映射
# 触发场景：板子重插/重启、hdc 服务重启、`hdc fport ls` 为空时，板端显示“全掉线”。
# 用法：双击 restore-hdc-mappings.cmd，或 powershell -File restore-hdc-mappings.ps1

$ErrorActionPreference = 'Stop'
$Hdc = 'D:\OpenHarmony\tools\hdc\hdc.exe'

if (-not (Test-Path $Hdc)) {
    Write-Host "[FAIL] 找不到 hdc: $Hdc" -ForegroundColor Red
    exit 1
}

$targets = @(& $Hdc list targets 2>$null | Where-Object { $_ -match '^\d{10,}' })
if ($targets.Count -eq 0) {
    Write-Host '[FAIL] hdc 看不到 DAYU200：检查 USB 数据线/上电/解锁' -ForegroundColor Red
    exit 1
}
$target = $targets[0].Trim()
Write-Host "[OK] DAYU200 目标: $target" -ForegroundColor Green

# 板端 127.0.0.1:9001/9302/9200 依赖这些映射
$mappings = @(
    @{ kind = 'fport'; remote = 'tcp:9001'; local = 'tcp:9000'; desc = '板端 9001 -> PC 9000（设备状态 relay）' },
    @{ kind = 'rport'; remote = 'tcp:9200'; local = 'tcp:9200'; desc = '板端 9200 -> PC 9200（视觉取帧）' },
    @{ kind = 'fport'; remote = 'tcp:9301'; local = 'tcp:9301'; desc = '板端 9301 -> PC 9301（摄像头流）' },
    @{ kind = 'rport'; remote = 'tcp:9302'; local = 'tcp:9302'; desc = '板端 9302 -> PC 9302（AI 语音网关）' }
)

foreach ($m in $mappings) {
    & $Hdc -t $target $m.kind $m.remote $m.local 2>$null | Out-Null
    Write-Host "[SET] $($m.desc)" -ForegroundColor Cyan
}

Write-Host ''
Write-Host '当前映射：' -ForegroundColor Gray
& $Hdc -t $target fport ls
Write-Host ''
Write-Host '提示：若仍显示空，请重插 DAYU200 USB 后再运行本脚本。' -ForegroundColor Yellow
