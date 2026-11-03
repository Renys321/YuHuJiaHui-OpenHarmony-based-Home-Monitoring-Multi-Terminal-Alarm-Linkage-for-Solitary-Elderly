#Requires -Version 5.1
<#
00-snapshot-archive-sync.ps1 — DAYU northbound / experiments 源码线统一（阶段 0~2）

背景：DAYU200 APP 有两棵源码树
  - competition/northbound                              = 1.0.0/1000000 旧线（含 signing/ 签名资产）
  - competition/experiments/dayu-eldercare-preview-integration-2026-10-25
                                                        = 1.0.10/1000010 当前安装版构建源
决策（2026-10-28，Lead）：experiments 线为唯一维护主线（canonical）；northbound 变为
其发布快照/构建指针，保留 signing/ 与构建脚手架。

本脚本只做三件事，默认 dry-run（-Execute 才真正写盘）：
  1) 全量快照 experiments 当前树 -> evidence/.../experiments-snapshot-1.0.10/
     并生成逐文件 SHA-256 清单，再用实时树复算校验（防并发写入）。
  2) 归档旧 northbound 源码（保留 signing/ 原地）-> evidence/.../northbound-1.0.0-archive/
  3) 把快照中的源码/资源/app.json5/构建文件同步进 northbound；
     排除 build/、.hvigor/、signing/、*.log（日志）与任何 HAP/密钥由排除规则天然覆盖。
     signing/ 全程不写：同步前后各算一次 SHA-256 清单做不变性校验。

不做：不删除 northbound 中任何历史文件（脚本只报告"快照中不存在"的旧文件，不删除）；
      不构建、不签名、不安装（见 01-build-verify-sign-1.0.10.ps1）。

用法：
  pwsh -File .\00-snapshot-archive-sync.ps1                  # dry-run，只打印计划
  pwsh -File .\00-snapshot-archive-sync.ps1 -Execute         # 真正执行
  pwsh -File .\00-snapshot-archive-sync.ps1 -Execute -ForceSnapshot
#>
[CmdletBinding()]
param(
  [switch]$Execute,
  [switch]$ForceSnapshot,
  [switch]$SkipSnapshot,
  [switch]$SkipArchive,
  [int]$QuietMinutes = 5,
  [string]$Root = 'D:\OpenHarmony\competition'
)

$ErrorActionPreference = 'Stop'
$Exp  = Join-Path $Root 'experiments\dayu-eldercare-preview-integration-2026-10-25'
$Nb   = Join-Path $Root 'northbound'
$Ev   = Join-Path $Root 'evidence\2026-10-28-three-legacy-closures\source-unify'
$Snap = Join-Path $Ev 'experiments-snapshot-1.0.10'
$Arch = Join-Path $Ev 'northbound-1.0.0-archive'
$LogFile = Join-Path $Ev '00-snapshot-archive-sync.log'
$Mode = if ($Execute) { 'EXECUTE' } else { 'DRY-RUN' }

New-Item -ItemType Directory -Force -Path $Ev | Out-Null

function Write-Log([string]$msg, [string]$level = 'INFO') {
  $line = ('[{0}] [{1}] [{2}] {3}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Mode, $level, $msg)
  Write-Host $line
  Add-Content -LiteralPath $LogFile -Value $line -Encoding utf8
}

function Invoke-Robocopy([string]$src, [string]$dst, [string[]]$xd = @(), [string[]]$xf = @(), [switch]$Listing) {
  $roboArgs = @($src, $dst, '/E', '/R:1', '/W:1', '/NP', '/NJH', '/NJS')
  foreach ($d in $xd) { $roboArgs += @('/XD', $d) }
  foreach ($f in $xf) { $roboArgs += @('/XF', $f) }
  # 安全网：dry-run 或显式 -Listing 时强制 /L，绝不写盘（2026-10-28 事故：/L 曾拼进自动变量 $args 导致 dry-run 实际覆盖）
  if ($Listing -or $Mode -eq 'DRY-RUN') { $roboArgs += '/L' }
  Write-Log ("robocopy {0} -> {1} {2}" -f $src, $dst, (($xd + $xf) -join ' '))
  $out = & robocopy @roboArgs 2>&1
  $code = $LASTEXITCODE
  if ($code -ge 8) {
    $out | Select-Object -Last 20 | ForEach-Object { Write-Log ("robocopy: {0}" -f $_) 'ERROR' }
    throw "robocopy failed with exit code $code"
  }
  $files = @($out | Where-Object { $_ -match '^\s+(新建|Newer|新|更|相同|Same|较旧|Older|已修改|Modified|额外|Extra|复制|Copied)' })
  Write-Log ("robocopy exit={0}; 变更/列举行数={1}" -f $code, $files.Count)
  if ($files.Count -gt 0 -and $Listing) { $files | Select-Object -First 40 | ForEach-Object { Write-Log ("  {0}" -f $_.Trim()) } }
  return $code
}

# 计算目录内文件的 SHA-256 映射：key = 相对路径（小写分隔符统一为 /）
function Get-HashMap([string]$base, [string[]]$excludeRelDirs = @(), [string[]]$excludeNamePatterns = @()) {
  $map = @{}
  if (-not (Test-Path $base)) { return $map }
  Get-ChildItem -LiteralPath $base -Recurse -File -Force | ForEach-Object {
    $rel = $_.FullName.Substring($base.Length + 1).Replace('\', '/')
    foreach ($d in $excludeRelDirs) {
      if ($rel -like ($d.TrimEnd('/') + '/*')) { return }
    }
    foreach ($p in $excludeNamePatterns) {
      if ($_.Name -like $p) { return }
    }
    $map[$rel] = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
  }
  return $map
}

function Compare-HashMaps($left, $right, [string]$leftName, [string]$rightName) {
  $onlyLeft  = @($left.Keys  | Where-Object { -not $right.ContainsKey($_) } | Sort-Object)
  $onlyRight = @($right.Keys | Where-Object { -not $left.ContainsKey($_) }  | Sort-Object)
  $changed   = @($left.Keys  | Where-Object { $right.ContainsKey($_) -and $left[$_] -ne $right[$_] } | Sort-Object)
  Write-Log ("{0}: {1} files; {2}: {3} files; 仅{0}={4}; 仅{2}={5}; 内容不同={6}" -f `
    $leftName, $left.Count, $rightName, $right.Count, $onlyLeft.Count, $onlyRight.Count, $changed.Count)
  if ($onlyLeft.Count  -gt 0) { Write-Log ("  仅 {0}: {1}" -f $leftName,  ($onlyLeft  -join ', ')) }
  if ($onlyRight.Count -gt 0) { Write-Log ("  仅 {0}: {1}" -f $rightName, ($onlyRight -join ', ')) }
  if ($changed.Count   -gt 0) { Write-Log ("  不同: {0}" -f ($changed -join ', ')) }
  return [pscustomobject]@{ OnlyLeft = $onlyLeft; OnlyRight = $onlyRight; Changed = $changed }
}

function Write-Sha256Sums([string]$base, [string]$outFile) {
  $lines = Get-ChildItem -LiteralPath $base -Recurse -File -Force | Sort-Object FullName | ForEach-Object {
    $rel = $_.FullName.Substring($base.Length + 1).Replace('\', '/')
    '{0}  {1}' -f (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash, $rel
  }
  Set-Content -LiteralPath $outFile -Value $lines -Encoding utf8
  Write-Log ("已写清单 {0}（{1} 行）" -f $outFile, $lines.Count)
}

# ---------------------------------------------------------------- 0) 前置检查
Write-Log '=== STEP 0 前置检查 ==='
foreach ($p in @($Exp, $Nb)) { if (-not (Test-Path $p)) { throw "缺少目录: $p" } }
$latest = Get-ChildItem -LiteralPath $Exp -Recurse -File -Force | Sort-Object LastWriteTime -Descending | Select-Object -First 1
$ageMin = [math]::Round(((Get-Date) - $latest.LastWriteTime).TotalMinutes, 1)
Write-Log ("experiments 最近写入: {0} {1}（距今 {2} 分钟）" -f $latest.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss'), $latest.FullName.Substring($Exp.Length + 1), $ageMin)
if ($ageMin -lt $QuietMinutes -and -not $ForceSnapshot) {
  throw ("experiments 树在最近 {0} 分钟内有写入（{1}），疑似仍有会话在写；确认停手后再执行，或显式 -ForceSnapshot" -f $QuietMinutes, $latest.Name)
}
Write-Log '停写检查通过'
if ($Execute -and -not $SkipSnapshot) {
  if (Test-Path $Snap) {
    if (-not $ForceSnapshot) { throw "快照目录已存在: $Snap（保留首次快照；如需重做请先人工移走或加 -ForceSnapshot）" }
    Write-Log '强制重做快照：旧快照将被覆盖' 'WARN'
  }
}

# ---------------------------------------------------------------- 1) experiments 全量快照
Write-Log '=== STEP 1 experiments 全量快照 ==='
if ($SkipSnapshot) {
  Write-Log '已跳过 STEP 1（-SkipSnapshot）'
} elseif ($Execute) {
  if (-not (Test-Path $Snap)) { New-Item -ItemType Directory -Force -Path $Snap | Out-Null }
  Invoke-Robocopy $Exp $Snap | Out-Null
  Write-Sha256Sums $Snap (Join-Path $Ev 'experiments-snapshot-1.0.10.SHA256SUMS.txt')
  $snapMap = Get-HashMap $Snap
  $liveMap = Get-HashMap $Exp
  $cmp = Compare-HashMaps $liveMap $snapMap 'live-experiments' 'snapshot'
  if ($cmp.OnlyLeft.Count -gt 0 -or $cmp.OnlyRight.Count -gt 0 -or $cmp.Changed.Count -gt 0) {
    throw '快照与实时树不一致（可能发生并发写入），停止'
  }
  Write-Log '快照校验通过：与实时树逐文件 SHA-256 一致'
} else {
  Write-Log ("[dry-run] robocopy {0} -> {1} /E（含 .hvigor/build，完整快照）" -f $Exp, $Snap)
  $liveMap = Get-HashMap $Exp
  Write-Log ("[dry-run] 将复制 {0} 个文件、{1:N0} 字节" -f $liveMap.Count, ((Get-ChildItem -LiteralPath $Exp -Recurse -File -Force | Measure-Object Length -Sum).Sum))
}

# ---------------------------------------------------------------- 2) 归档旧 northbound 源码
Write-Log '=== STEP 2 归档旧 northbound 源码（signing/ 保持原地） ==='
$archXd = @((Join-Path $Nb '.hvigor'))
if ($SkipArchive) {
  Write-Log '已跳过 STEP 2（-SkipArchive：旧 northbound 归档由 02-archive-old-northbound.ps1 生成，含事故恢复记录）'
} elseif ($Execute) {
  if (Test-Path $Arch) { throw "归档目录已存在: $Arch（保留首次归档，不覆盖）" }
  New-Item -ItemType Directory -Force -Path $Arch | Out-Null
  Invoke-Robocopy $Nb $Arch -xd $archXd | Out-Null
  Write-Sha256Sums $Arch (Join-Path $Ev 'northbound-1.0.0-archive.SHA256SUMS.txt')
} else {
  Write-Log ("[dry-run] robocopy {0} -> {1} /E /XD {2}（排除 .hvigor，包含 signing/ 之外的源码/构建产物）" -f $Nb, $Arch, ($archXd -join ' '))
}

# ---------------------------------------------------------------- 3) 同步快照 -> northbound
Write-Log '=== STEP 3 快照源码同步进 northbound ==='
$syncSrc = if (Test-Path $Snap) { $Snap } else { $Exp }
if ($syncSrc -eq $Exp) { Write-Log ("快照尚不存在，dry-run 用实时树做列表演示: {0}" -f $Exp) }
$syncXd = @((Join-Path $syncSrc '.hvigor'), (Join-Path $syncSrc 'entry\build'), (Join-Path $syncSrc 'signing'))
$syncXf = @('*.log', 'README.md', 'RELEASE.md')   # 发布层文档由 northbound 自己维护，不被 experiments 覆盖
$signingBefore = Get-HashMap (Join-Path $Nb 'signing')

if ($Execute) {
  Invoke-Robocopy $syncSrc $Nb -xd $syncXd -xf $syncXf | Out-Null
} else {
  Invoke-Robocopy $syncSrc $Nb -xd $syncXd -xf $syncXf -Listing | Out-Null
}

# 同步后校验：同步作用域内 northbound 应与快照逐文件一致
$scopeXd = @('.hvigor', 'entry/build', 'signing')
$snapScope = Get-HashMap $syncSrc -excludeRelDirs $scopeXd -excludeNamePatterns $syncXf
$nbScope   = Get-HashMap $Nb   -excludeRelDirs $scopeXd -excludeNamePatterns $syncXf
Write-Log '--- 同步作用域校验（northbound vs 快照） ---'
$cmp2 = Compare-HashMaps $snapScope $nbScope 'snapshot' 'northbound'
if ($Execute -and ($cmp2.Changed.Count -gt 0 -or $cmp2.OnlyRight.Count -gt 0)) {
  throw '同步后 northbound 与快照不一致'
}
if (-not $Execute) {
  Write-Log '[dry-run] 上述差异即 -Execute 将要写入 northbound 的变更'
}

# signing/ 不变性
$signingAfter = Get-HashMap (Join-Path $Nb 'signing')
Write-Log '--- signing/ 不变性校验 ---'
$cmp3 = Compare-HashMaps $signingBefore $signingAfter 'signing-before' 'signing-after'
if ($Execute -and ($cmp3.Changed.Count -gt 0 -or $cmp3.OnlyLeft.Count -gt 0 -or $cmp3.OnlyRight.Count -gt 0)) {
  throw 'signing/ 在同步过程中被改动，停止'
}
Write-Log 'signing/ 未改动'

# 旧 northbound 独有文件（不删除，只报告）
$nbOnly = @($nbScope.Keys | Where-Object { -not $snapScope.ContainsKey($_) } | Sort-Object)
if ($nbOnly.Count -gt 0) { Write-Log ("注意：northbound 有 {0} 个文件不在快照中（脚本不删除）: {1}" -f $nbOnly.Count, ($nbOnly -join ', ')) 'WARN' }
else { Write-Log 'northbound 同步作用域内没有快照之外的遗留源码文件' }

Write-Log '=== 完成 ==='
Write-Log ("模式={0}；日志={1}" -f $Mode, $LogFile)
