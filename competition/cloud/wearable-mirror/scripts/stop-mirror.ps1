#requires -Version 5.1
<#
.SYNOPSIS
  停止 PC 侧「随身 SOS 镜像服务」。
.DESCRIPTION
  优先按 runtime\mirror.pid 精确停止本服务进程（不动 bridge/homemon/其它 node 进程）；
  进程已死时清理残留 pid/lock。可用 -RemoveRport 一并删除本服务建立的 hdc rport。
.EXAMPLE
  .\stop-mirror.ps1
  .\stop-mirror.ps1 -RemoveRport
#>
[CmdletBinding()]
param(
  [string]$RuntimeDir = '',
  [string]$Hdc = 'D:\OpenHarmony\tools\hdc\hdc.exe',
  [string]$Target = '',
  [int]$Port = 9002,
  [switch]$RemoveRport
)

$ErrorActionPreference = 'Stop'
$mirrorDir = Split-Path -Parent $PSScriptRoot
if ($RuntimeDir -eq '') { $RuntimeDir = Join-Path $mirrorDir 'runtime' }
$pidFile = Join-Path $RuntimeDir 'mirror.pid'
$lockFile = Join-Path $RuntimeDir 'mirror.lock'
$statusFile = Join-Path $RuntimeDir 'mirror-status.json'

function Write-Step([string]$text) { Write-Host "[stop-mirror] $text" -ForegroundColor Cyan }
function Write-Warn2([string]$text) { Write-Host "[stop-mirror] $text" -ForegroundColor Yellow }

$stopped = $false
if (Test-Path $pidFile) {
  $oldPid = 0
  [int]::TryParse((Get-Content -LiteralPath $pidFile -Raw).Trim(), [ref]$oldPid) | Out-Null
  if ($oldPid -gt 0) {
    $proc = Get-Process -Id $oldPid -ErrorAction SilentlyContinue
    if ($proc -ne $null) {
      if ($proc.ProcessName -match '^node') {
        Write-Step "停止镜像进程 pid=$oldPid"
        Stop-Process -Id $oldPid -Force
        $stopped = $true
      } else {
        Write-Warn2 "pid=$oldPid 不是 node（$($proc.ProcessName)），拒绝误杀；请人工确认"
      }
    }
  }
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
} else {
  Write-Warn2 "没有 pid 文件（$pidFile）"
}

if (Test-Path $lockFile) {
  Write-Step '清理单实例锁'
  Remove-Item -LiteralPath $lockFile -Force -ErrorAction SilentlyContinue
}
if (Test-Path $statusFile) {
  try {
    $sf = Get-Content -LiteralPath $statusFile -Raw | ConvertFrom-Json
    $sf | Add-Member -NotePropertyName stoppedAt -NotePropertyValue (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') -Force
    ($sf | ConvertTo-Json -Depth 8) | Set-Content -LiteralPath $statusFile -Encoding UTF8
  } catch { }
}

if ($RemoveRport) {
  if ((Test-Path $Hdc) -and $Target -ne '') {
    Write-Step "删除 hdc rport tcp:$Port tcp:$Port"
    & $Hdc -t $Target fport rm ("tcp:$Port") ("tcp:$Port") 2>$null | Out-Null
  } else {
    Write-Warn2 "缺少 hdc/target，跳过 rport 清理；可手工: hdc -t <target> fport rm tcp:$Port tcp:$Port"
  }
}

if (-not $stopped) { Write-Warn2 '没有按 pid 停到进程（可能已退出）' }
Write-Step '完成'
