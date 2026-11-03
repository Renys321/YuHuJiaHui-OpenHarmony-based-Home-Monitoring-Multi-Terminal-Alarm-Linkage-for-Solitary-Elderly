# core-supervisor.ps1 —— 每 N 秒自检并自愈：网关端口、hdc 映射、DAYU APP。
[CmdletBinding()]
param(
    [int]$IntervalSec = 15,
    [switch]$Once
)
$ErrorActionPreference = 'Continue'
$Root = Split-Path $PSScriptRoot -Parent
$Core = Join-Path $PSScriptRoot 'core-start.ps1'
$LogDir = Join-Path $Root 'logs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$Log = Join-Path $LogDir 'core-supervisor.log'

function Write-Log([string]$m) {
    $line = "$(Get-Date -Format o) $m"
    Add-Content $Log $line
    Write-Host $line
}
Write-Log "supervisor start interval=${IntervalSec}s"
for (;;) {
    $code = 0
    try {
        & powershell -NoProfile -ExecutionPolicy Bypass -File $Core -Quiet *> $null
        $code = $LASTEXITCODE
    } catch { $code = 99 }
    Write-Log "core-start exit=$code"
    if ($Once) { exit $code }
    Start-Sleep -Seconds $IntervalSec
}
