#Requires -Version 5.1
<#
01-build-verify-sign-1.0.10.ps1 — 从 competition/northbound 干净构建、签名、验签、静态核对

前提：00-snapshot-archive-sync.ps1 已把 experiments 1.0.10 源码同步进 northbound，
      northbound/signing/ 保留原签名资产（app-chain.pem / final-profile.p7b）。
版本策略：保持 1.0.10 / 1000010（与当前 DAYU 安装版一致，用于证明合并后功能等价）。

安全纪律：签名口令只从环境变量 $env:HAP_SIGN_PWD 读入，不写入本脚本/日志/证据；
         日志中的签名命令对口令做 ****** 脱敏；不安装到设备（安装/回滚由 Lead 决定）。

用法：
  $env:HAP_SIGN_PWD = '<keystore 口令>'   # 仅内存
  powershell -NoProfile -ExecutionPolicy Bypass -File .\01-build-verify-sign-1.0.10.ps1 -Execute
#>
[CmdletBinding()]
param(
  [switch]$Execute,
  [string]$Root = 'D:\OpenHarmony\competition'
)

$ErrorActionPreference = 'Stop'
$Nb  = Join-Path $Root 'northbound'
$Ev  = Join-Path $Root 'evidence\2026-10-28-three-legacy-closures\source-unify'
$Bld = Join-Path $Ev 'build'
$LogFile = Join-Path $Ev '01-build-verify-sign.log'
$BuildLog = Join-Path $Bld 'build-1.0.10-from-northbound.log'

$DevEco   = 'D:\DevEcoStudio\DevEco Studio'
$Hvigor   = Join-Path $DevEco 'tools\hvigor\bin\hvigorw.bat'
$SdkLib   = Join-Path $DevEco 'sdk\default\openharmony\toolchains\lib'
$SignTool = Join-Path $SdkLib 'hap-sign-tool.jar'
$Keystore = Join-Path $SdkLib 'OpenHarmony.p12'
$Java     = Join-Path $DevEco 'jbr\bin\java.exe'
$AppCert  = Join-Path $Nb 'signing\app-chain.pem'
$Profile  = Join-Path $Nb 'signing\final-profile.p7b'
$Unsigned = Join-Path $Nb 'entry\build\default\outputs\default\entry-default-unsigned.hap'
$SignPwd  = $env:HAP_SIGN_PWD
$KeyAlias = 'openharmony application release'

function Write-Log([string]$msg, [string]$level = 'INFO') {
  $line = ('[{0}] [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $level, $msg)
  Write-Host $line
  Add-Content -LiteralPath $LogFile -Value $line -Encoding utf8
}
function Invoke-Native([string]$exe, [string[]]$argv, [string]$logPath = '', [string]$display = '') {
  $shown = if ($display) { $display } else { ($exe + ' ' + ($argv -join ' ')) }
  Write-Log ("run: " + $shown)
  # 原生命令的 stderr 在 PS5.1 + 2>&1 下会变成 NativeCommandError；临时放行以免误终止
  $oldEa = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $out = & $exe @argv 2>&1 } finally { $ErrorActionPreference = $oldEa }
  $code = $LASTEXITCODE
  if ($logPath) { $out | Set-Content -LiteralPath $logPath -Encoding utf8 }
  return [pscustomobject]@{ Code = $code; Out = $out }
}

New-Item -ItemType Directory -Force -Path $Bld | Out-Null
if (-not $Execute) {
  Write-Log ('[dry-run] 将执行: clean + assembleHap（源 {0}）' -f $Nb)
  Write-Log ('[dry-run] 将输出: {0}' -f $Bld)
  return
}
if (-not $SignPwd) { throw '缺少环境变量 HAP_SIGN_PWD（签名口令仅内存传入，不落盘）' }
foreach ($p in @($Nb, $Hvigor, $SignTool, $Keystore, $AppCert, $Profile)) {
  if (-not (Test-Path $p)) { throw "缺少路径: $p" }
}

# 构建环境（与 dayu-sos BUILD-RECORD-1.0.5.md 一致）
$env:DEVECO_SDK_HOME  = Join-Path $DevEco 'sdk'
$env:JAVA_HOME        = Join-Path $DevEco 'jbr'
$env:HVIGOR_USER_HOME = 'D:\OpenHarmony\.buildcache\hvigor'
$env:OHPM_HOME        = 'D:\OpenHarmony\.buildcache\ohpm'
# hvigor 必须在工程根目录执行（否则 00304004 Not Found）
Set-Location -LiteralPath $Nb

Write-Log '=== STEP 1 clean（干净重建，消除旧 hvigor 缓存影响） ==='
$r = Invoke-Native $Hvigor @('clean', '--no-daemon') (Join-Path $Bld 'clean-1.0.10-from-northbound.log')
Write-Log ("clean exit={0}" -f $r.Code)
if ($r.Code -ne 0) { throw 'hvigor clean 失败' }

Write-Log '=== STEP 2 assembleHap --mode module -p product=default -p buildMode=debug ==='
$r = Invoke-Native $Hvigor @('assembleHap', '--mode', 'module', '-p', 'product=default', '-p', 'buildMode=debug', '--no-daemon') $BuildLog
$text = ($r.Out | Out-String)
if ($r.Code -ne 0 -or $text -notmatch 'BUILD SUCCESSFUL') {
  Write-Log '构建失败，日志尾部：' 'ERROR'
  $r.Out | Select-Object -Last 30 | ForEach-Object { Write-Log $_ 'ERROR' }
  throw 'assembleHap 失败（未见 BUILD SUCCESSFUL）'
}
Write-Log 'BUILD SUCCESSFUL'
if (-not (Test-Path $Unsigned)) { throw "找不到 unsigned HAP: $Unsigned" }
$unsignedDst = Join-Path $Bld 'dayu-eldercare-1.0.10-from-northbound-unsigned.hap'
Copy-Item -LiteralPath $Unsigned -Destination $unsignedDst -Force
Write-Log ("unsigned HAP: {0} bytes sha256={1}" -f (Get-Item $unsignedDst).Length, (Get-FileHash -LiteralPath $unsignedDst -Algorithm SHA256).Hash)

# 3) 剔除 SDK26 rpcid.sc（OH7.0 板端 BOOT 校验会拒绝全量 syscap 表；与 1.0.5/1.0.6 处理一致）
Write-Log '=== STEP 3 剔除 rpcid.sc（可安装变体） ==='
$norpc = Join-Path $Bld 'dayu-eldercare-1.0.10-from-northbound-norpc.hap'
$r = Invoke-Native 'python' @((Join-Path $Nb 'signing\strip_rpcid.py'), $unsignedDst, $norpc) (Join-Path $Bld 'strip-rpcid.log')
if ($r.Code -ne 0 -or -not (Test-Path $norpc)) {
  $r.Out | ForEach-Object { Write-Log $_ 'ERROR' }
  throw '剔除 rpcid.sc 失败'
}
Write-Log ("norpc HAP: {0} bytes sha256={1}" -f (Get-Item $norpc).Length, (Get-FileHash -LiteralPath $norpc -Algorithm SHA256).Hash)

# 4) 签名（同签名身份/profile；口令仅在参数中出现，日志脱敏）
Write-Log '=== STEP 4 sign-app（同签名身份/同 debug profile） ==='
$signed = Join-Path $Bld 'dayu-eldercare-1.0.10-from-northbound-signed.hap'
$argv = @(
  '-jar', $SignTool, 'sign-app',
  '-mode', 'localSign',
  '-keyAlias', $KeyAlias,
  '-keyPwd', $SignPwd,
  '-keystoreFile', $Keystore,
  '-keystorePwd', $SignPwd,
  '-appCertFile', $AppCert,
  '-profileFile', $Profile,
  '-inFile', $norpc,
  '-outFile', $signed,
  '-signAlg', 'SHA256withECDSA',
  '-compatibleVersion', '12',
  '-signCode', '1'
)
$display = ('java -jar {0} sign-app -mode localSign -keyAlias "{1}" -keyPwd ****** -keystoreFile {2} -keystorePwd ****** -appCertFile {3} -profileFile {4} -inFile {5} -outFile {6} -signAlg SHA256withECDSA -compatibleVersion 12 -signCode 1' -f `
  $SignTool, $KeyAlias, $Keystore, $AppCert, $Profile, $norpc, $signed)
$r = Invoke-Native $Java $argv (Join-Path $Bld 'sign-app.log') $display
if ($r.Code -ne 0 -or -not (Test-Path $signed)) {
  $r.Out | ForEach-Object { Write-Log $_ 'ERROR' }
  throw 'sign-app 失败'
}
Write-Log ("signed HAP: {0} bytes sha256={1}" -f (Get-Item $signed).Length, (Get-FileHash -LiteralPath $signed -Algorithm SHA256).Hash)

# 5) 验签
Write-Log '=== STEP 5 verify-app ==='
$chain = Join-Path $Bld 'verify-app-chain.cer'
$profOut = Join-Path $Bld 'verify-app-profile.p7b'
$r = Invoke-Native $Java @('-jar', $SignTool, 'verify-app', '-inFile', $signed, '-outCertChain', $chain, '-outProfile', $profOut) (Join-Path $Bld 'verify-app.log')
$vtext = ($r.Out | Out-String)
$r.Out | ForEach-Object { Write-Log ("verify: " + $_) }
if ($r.Code -ne 0 -or $vtext -notmatch 'Digest verify result:\s*true') { throw 'verify-app 未通过' }
Write-Log 'verify-app success（Digest verify result: true）'

# 6) 静态核对（功能标记 + 与 experiments 1.0.10 构建产物对比）
Write-Log '=== STEP 6 静态核对 ==='
$baseHap = Join-Path $Root 'evidence\2026-10-27-video-fps\dayu-video-fps-1.0.10-signed.hap'
$py = Join-Path $Ev 'scripts\01b-static-checks.py'
$r = Invoke-Native 'python' @($py, $signed, $baseHap, (Join-Path $Bld 'static-checks.txt'), (Join-Path $Bld 'static-checks.json'))
$r.Out | ForEach-Object { Write-Log $_ }
if ($r.Code -ne 0) { throw '静态核对失败' }

# 7) 产物清单
$sums = Get-ChildItem -LiteralPath $Bld -File | Where-Object { $_.Name -match '\.hap$|\.cer$|\.p7b$' } | Sort-Object Name | ForEach-Object {
  '{0}  {1}  {2}' -f (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash, $_.Length, $_.Name
}
Set-Content -LiteralPath (Join-Path $Bld 'SHA256SUMS.txt') -Value $sums -Encoding utf8
Write-Log ("已写产物清单: {0}" -f (Join-Path $Bld 'SHA256SUMS.txt'))
Write-Log '=== 完成（未安装到设备） ==='
