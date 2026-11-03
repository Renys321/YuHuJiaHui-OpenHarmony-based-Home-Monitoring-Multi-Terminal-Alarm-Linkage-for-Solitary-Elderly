# 把 common 母本同步到三个节点工程的 main/（只覆盖源码，不动 sdkconfig.defaults/README/.vscode）
[CmdletBinding()] param([ValidateSet('all','kitchen','bathroom','living')][string]$Target='all')
$ErrorActionPreference='Stop'
$root = Split-Path -Parent $PSScriptRoot
$src  = Join-Path $root 'common\components\elder_node'
$nodes = if ($Target -eq 'all') { @('kitchen','bathroom','living') } else { @($Target) }
$files = Get-ChildItem -Path "$src\*" -File -Include *.c,*.h,Kconfig.projbuild
foreach ($n in $nodes) {
  $dst = Join-Path $root "$n\main"
  if (-not (Test-Path $dst)) { throw "缺少工程: $dst" }
  foreach ($f in $files) { Copy-Item $f.FullName $dst -Force }
  New-Item -ItemType Directory -Force -Path "$dst\voice" | Out-Null
  Copy-Item "$src\voice\*.adpcm" "$dst\voice" -Force
  Write-Host ("[sync] {0}/main  <- common ({1} 个源文件 + voice)" -f $n, $files.Count) -ForegroundColor Green
}