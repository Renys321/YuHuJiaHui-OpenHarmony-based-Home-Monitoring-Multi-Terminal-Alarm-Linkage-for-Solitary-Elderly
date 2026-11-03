#Requires -Version 5.1
<#
02-archive-old-northbound.ps1 — 生成旧 northbound 1.0.0 归档（含事故恢复）

背景（必须如实记录）：
  2026-10-28 00:34，00-snapshot-archive-sync.ps1 首次 dry-run 时，/L 参数被误加到
  PowerShell 自动变量 $args 而不是 robocopy 参数数组，导致"dry-run"实际把 experiments
  1.0.10 源码覆盖进 northbound。旧 northbound 的 5 个差异源码文件因此被覆盖为本会话
  之前已记录的大小/差异：
    AppScope/app.json5 246B、CameraModel.ets 18,137B、DeviceModel.ets 9,342B、
    DeviceCapabilities.ts 1,927B、Index.ets 66,383B。
  覆盖发生时本任务尚未执行"归档"步骤（脚本 STEP 2 在 dry-run 分支只打印不复制）。

恢复方式（逐字节可验证）：
  - 旧 northbound 在 2026-10-25 20:59 有一次完整构建，构建目录仍保留：
    northbound/entry/build/default/cache/.../compiler.cache/modules/*.msgpack
    其中保存了每个源文件的原始文本；recovery/recover_v2.py 用"两棵树逐字节相同的 5 个
    文件"验证了该提取方法逐字节精确（提取内容 SHA-256 == 当前文件 SHA-256）。
  - 4 个差异源码文件已由 recovery/recover_v2.py 恢复，字节数与覆盖前登记值完全一致；
    其中 DeviceModel.ets 的 SHA-256 50C7BCC1...E30D 与 docs/ARTIFACTS.md 第 83 行记录的
    历史哈希一致（独立交叉验证）。
  - AppScope/app.json5（1.0.0）按覆盖前 diff（仅 versionName/versionCode 两行不同）重建，
    字节数 246 与覆盖前一致。
  - northbound/signing/ 未被覆盖（同步脚本排除 signing/），旧签名资产仍是 1.0.0 原件。

本脚本：把当前 northbound 全树（不含 .hvigor）复制为归档，再用上述恢复件覆盖回旧版本、
删除旧线不存在的 3 个 experiments 独有文件，写说明与 SHA-256 清单。

用法：pwsh -File .\02-archive-old-northbound.ps1 -Execute
#>
[CmdletBinding()]
param(
  [switch]$Execute,
  [string]$Root = 'D:\OpenHarmony\competition'
)

$ErrorActionPreference = 'Stop'
$Nb  = Join-Path $Root 'northbound'
$Ev  = Join-Path $Root 'evidence\2026-10-28-three-legacy-closures\source-unify'
$Arch = Join-Path $Ev 'northbound-1.0.0-archive'
$Rec = Join-Path $Ev 'recovery\old-northbound-src'
$LogFile = Join-Path $Ev '02-archive-old-northbound.log'
$Mode = if ($Execute) { 'EXECUTE' } else { 'DRY-RUN' }

function Write-Log([string]$msg, [string]$level = 'INFO') {
  $line = ('[{0}] [{1}] [{2}] {3}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Mode, $level, $msg)
  Write-Host $line
  Add-Content -LiteralPath $LogFile -Value $line -Encoding utf8
}

New-Item -ItemType Directory -Force -Path $Ev | Out-Null
if (-not (Test-Path (Join-Path $Rec 'entry'))) { throw "缺少恢复件目录: $Rec（先运行 recovery/recover_v2.py）" }

# 旧线不存在的 experiments 独有文件（归档中必须删除）
$experimentsOnly = @(
  'entry\src\main\ets\model\PreviewTuning.ets',
  'entry\src\main\ets\model\VideoStreamServer.ets',
  'entry\src\main\ets\model\WearableBannerPrefs.ets'
)
# 4 个由编译缓存逐字节恢复的差异源码
$recovered = @(
  'entry\src\main\ets\pages\Index.ets',
  'entry\src\main\ets\model\CameraModel.ets',
  'entry\src\main\ets\model\DeviceModel.ets',
  'entry\src\main\ets\model\DeviceCapabilities.ts'
)

if (-not $Execute) {
  Write-Log "[dry-run] 将 robocopy $Nb -> $Arch /E /XD $Nb\.hvigor"
  Write-Log "[dry-run] 将覆盖 4 个恢复件: $($recovered -join ', ')"
  Write-Log "[dry-run] 将重建 AppScope\app.json5 为 1.0.0/1000000"
  Write-Log "[dry-run] 将删除 3 个旧线不存在文件: $($experimentsOnly -join ', ')"
  Write-Log "[dry-run] 将写 RECOVERY-NOTES.md 与 northbound-1.0.0-archive.SHA256SUMS.txt"
  return
}

if (Test-Path $Arch) { throw "归档目录已存在: $Arch（保留首次归档，不覆盖）" }
New-Item -ItemType Directory -Force -Path $Arch | Out-Null

# 1) 复制当前 northbound（不含 .hvigor）
$roboArgs = @($Nb, $Arch, '/E', '/R:1', '/W:1', '/NP', '/NJH', '/NJS', '/XD', (Join-Path $Nb '.hvigor'))
& robocopy @roboArgs 2>&1 | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy 失败: $LASTEXITCODE" }
Write-Log "已复制 northbound -> $Arch（不含 .hvigor）"

# 2) 覆盖恢复件
foreach ($rel in $recovered) {
  $src = Join-Path $Rec $rel
  $dst = Join-Path $Arch $rel
  if (-not (Test-Path $src)) { throw "缺少恢复件: $src" }
  New-Item -ItemType Directory -Force -Path (Split-Path $dst) | Out-Null
  Copy-Item -LiteralPath $src -Destination $dst -Force
  $h = (Get-FileHash -LiteralPath $dst -Algorithm SHA256).Hash
  Write-Log ("恢复 {0}  bytes={1}  sha256={2}" -f $rel, (Get-Item $dst).Length, $h)
}

# 3) 重建旧 app.json5（1.0.0 / 1000000）
$appPath = Join-Path $Arch 'AppScope\app.json5'
$app = Get-Content -LiteralPath $appPath -Raw -Encoding UTF8
$appOld = $app.Replace('"versionCode": 1000010', '"versionCode": 1000000').Replace('"versionName": "1.0.10"', '"versionName": "1.0.0"')
if ($appOld -eq $app) { throw 'app.json5 未发生预期替换，拒绝写归档' }
[System.IO.File]::WriteAllText($appPath, $appOld, (New-Object System.Text.UTF8Encoding($true)))
$appBytes = (Get-Item $appPath).Length
if ($appBytes -ne 246) { throw "重建 app.json5 字节数应为 246，实际 $appBytes" }
Write-Log ("重建 AppScope/app.json5 1.0.0/1000000 bytes={0} sha256={1}" -f $appBytes, (Get-FileHash -LiteralPath $appPath -Algorithm SHA256).Hash)

# 4) 删除旧线不存在的 3 个文件
foreach ($rel in $experimentsOnly) {
  $p = Join-Path $Arch $rel
  if (Test-Path $p) { Remove-Item -LiteralPath $p -Force; Write-Log "删除旧线不存在文件: $rel" }
}

# 5) 恢复说明
$notes = @'
# 旧 northbound 1.0.0 源码归档（2026-10-28）

本目录是合并前 `competition/northbound`（1.0.0 / 1000000，构建源为 2026-10-09~10-25 旧线）
的归档。`signing/` 未在合并中改动，因此其中的 1.0.0 签名资产（`eldercare-signed.hap` 1,860,490 B
等）为原件；`entry/build/` 为 2026-10-25 20:59 的旧构建产物（含 1.0.0 unsigned HAP 1,823,686 B）。

## 必须如实记录的事故与恢复

合并操作脚本 `00-snapshot-archive-sync.ps1` 第一次 dry-run（2026-10-28 00:34）时，`/L` 被误加到
PowerShell 自动变量 `$args`，导致 robocopy 实际执行覆盖：旧 northbound 的源码被 experiments
1.0.10 覆盖（119 个文件中的 7 个差异文件受影响）。发现后立即用以下方式恢复：

| 文件 | 覆盖前大小 | 恢复方式 | 恢复后 SHA-256 |
|---|---|---|---|
| `Index.ets` | 66,383 | ArkTS 编译缓存 msgpack 逐字节提取 | `773c7e98a5e23f7fa21faeb44688a12b01e644f12abe56beac6063c517eee62d` |
| `CameraModel.ets` | 18,137 | 同上 | `71f5dae41b9b7bf00261a556950541c14e94d40a0bc5ad05c400f31146160c59` |
| `DeviceModel.ets` | 9,342 | 同上（与 docs/ARTIFACTS.md 历史哈希 50C7BCC1…E30D 一致） | `50c7bcc17fe8a0e84bc8f17874492f68291eeed7744918af9d2109610773e30d` |
| `DeviceCapabilities.ts` | 1,927 | 同上 | `149fccc7580ac70080981a6a3a4026c8aa761b0d51c091b3d6ee8aaaca29ab51` |
| `AppScope/app.json5` | 246 | 按覆盖前 diff 重建（仅 versionName/versionCode 两行） | 见清单 |

其余 112 个文件在覆盖前后逐字节相同（合并前已做 SHA-256 全量比对），直接取自当前树。
`PreviewTuning.ets` / `VideoStreamServer.ets` / `WearableBannerPrefs.ets` 为 experiments 新增，
旧线不存在，未收录。

恢复方法与验证脚本：`../recovery/recover_v2.py`、`../recovery/recovery-report.json`。
方法校验：同批 msgpack 中 5 个"两棵树逐字节相同"的文件，提取内容 SHA-256 与当前文件一致。

## 回滚含义

- 回滚到 1.0.0 版本 APP：直接安装 `signing/eldercare-signed.hap`（1.0.0/1000000，覆盖安装保留数据）。
- 回滚源码：本目录内源码即 1.0.0 旧线；但注意它**不含** 1.0.1~1.0.10 的所有已验收功能
  （视频 Wi-Fi、预览调参、随身 SOS 横幅、无 PIR 语义、告警归属修复、相机旋转修复），
  不应作为后续构建源。
'@
Set-Content -LiteralPath (Join-Path $Arch 'RECOVERY-NOTES.md') -Value $notes -Encoding utf8
Write-Log '已写 RECOVERY-NOTES.md'

# 6) SHA-256 清单 + 统计
$sums = Get-ChildItem -LiteralPath $Arch -Recurse -File -Force | Sort-Object FullName | ForEach-Object {
  $rel = $_.FullName.Substring($Arch.Length + 1).Replace('\', '/')
  '{0}  {1}' -f (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash, $rel
}
Set-Content -LiteralPath (Join-Path $Ev 'northbound-1.0.0-archive.SHA256SUMS.txt') -Value $sums -Encoding utf8
Write-Log ("归档清单: {0} 个文件" -f $sums.Count)

# 7) 归档 vs 当前 northbound 差异（应只剩恢复件/删除件/文档）
Write-Log '--- 归档 vs 当前 northbound（同步作用域）差异 ---'
$excl = @('.hvigor', 'entry/build', 'signing')
function Map([string]$b) {
  $m = @{}
  Get-ChildItem -LiteralPath $b -Recurse -File -Force | ForEach-Object {
    $rel = $_.FullName.Substring($b.Length + 1).Replace('\', '/')
    if ($rel -like '.hvigor/*' -or $rel -like 'entry/build/*' -or $rel -like 'signing/*') { return }
    $m[$rel] = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
  }
  return $m
}
$a = Map $Arch
$n = Map $Nb
"仅归档: " + (($a.Keys | Where-Object { -not $n.ContainsKey($_) } | Sort-Object) -join ', ')
"仅当前: " + (($n.Keys | Where-Object { -not $a.ContainsKey($_) } | Sort-Object) -join ', ')
"内容不同: " + (($a.Keys | Where-Object { $n.ContainsKey($_) -and $a[$_] -ne $n[$_] } | Sort-Object) -join ', ')
Write-Log '=== 完成 ==='
