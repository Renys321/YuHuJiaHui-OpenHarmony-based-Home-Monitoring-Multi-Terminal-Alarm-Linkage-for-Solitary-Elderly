# 手机 APP（com.example.program_04）签名：复用 dayu-previewtest 现有密钥链与 debug profile 模板
$ErrorActionPreference = 'Stop'
$java   = 'D:\DevEcoStudio\DevEco Studio\jbr\bin\java.exe'
$tool   = 'D:\DevEcoStudio\DevEco Studio\sdk\default\openharmony\toolchains\lib\hap-sign-tool.jar'
$sdkLib = 'D:\DevEcoStudio\DevEco Studio\sdk\default\openharmony\toolchains\lib'
$sign   = 'D:\OpenHarmony\competition\experiments\dayu-previewtest-2026-10-25\signing'
$pwd    = '123456'
$work   = 'D:\OpenHarmony\competition\evidence\2026-10-28-fullchain-health\lead\app-sign'
New-Item -ItemType Directory -Force -Path $work | Out-Null

$unsigned = 'D:\OpenHarmony\APP\ElderlyCareGuardian\entry\build\default\outputs\default\entry-default-unsigned.hap'
$signed   = Join-Path $work 'guardian-gas-alarm-1.0.11-signed.hap'
$udid     = 'DC3ABD0514880C60A274F7442EC3C068F4E3C2EE59F28D1BF2DD35CE49C0D54C'

if (-not (Test-Path $unsigned)) { throw "缺少未签名 HAP: $unsigned" }
foreach ($p in @((Join-Path $sign 'previewtest.p12'), (Join-Path $sign 'previewtest-app.pem'),
                 (Join-Path $sdkLib 'OpenHarmony.p12'), (Join-Path $sdkLib 'OpenHarmonyProfileDebug.pem'),
                 (Join-Path $sdkLib 'UnsgnedDebugProfileTemplate.json'))) {
  if (-not (Test-Path $p)) { throw "缺少签名资产: $p" }
}

# 1) 生成 debug profile JSON（bundle 固定 com.example.program_04）
$template = Get-Content (Join-Path $sdkLib 'UnsgnedDebugProfileTemplate.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$appPem = Get-Content (Join-Path $sign 'previewtest-app.pem') -Raw
$m = [regex]::Match($appPem, '-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----')
if (-not $m.Success) { throw 'app cert not found in previewtest-app.pem' }
$template.'bundle-info'.'bundle-name' = 'com.example.program_04'
$template.'bundle-info'.'development-certificate' = $m.Value + "`n"
$template.'debug-info'.'device-ids' = @($udid)
$template.'debug-info'.'device-id-type' = 'udid'
$now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$template.validity = [pscustomobject]@{ 'not-before' = $now - 3600; 'not-after' = $now + 10 * 365 * 24 * 3600 }
$template.uuid = [guid]::NewGuid().ToString()
$profileJson = Join-Path $work 'guardian-profile.json'
$template | ConvertTo-Json -Depth 12 | Set-Content -Path $profileJson -Encoding UTF8

# 2) sign-profile
$profileOut = Join-Path $work 'guardian-profile.p7b'
$o1 = & $java -jar $tool sign-profile -keyAlias 'openharmony application profile debug' `
  -signAlg 'SHA256withECDSA' -mode 'localSign' `
  -profileCertFile (Join-Path $sdkLib 'OpenHarmonyProfileDebug.pem') `
  -inFile $profileJson -keystoreFile (Join-Path $sdkLib 'OpenHarmony.p12') `
  -outFile $profileOut -keyPwd $pwd -keystorePwd $pwd 2>&1
$o1 | Out-File (Join-Path $work 'sign-profile.log') -Encoding utf8
Write-Host ("sign-profile exit={0} exists={1}" -f $LASTEXITCODE, (Test-Path $profileOut))
if (-not (Test-Path $profileOut)) { throw 'sign-profile failed' }

# 3) sign-app
$o2 = & $java -jar $tool sign-app -keyAlias 'previewtest-key' `
  -signAlg 'SHA256withECDSA' -mode 'localSign' `
  -appCertFile (Join-Path $sign 'previewtest-app.pem') `
  -profileFile $profileOut -inFile $unsigned `
  -keystoreFile (Join-Path $sign 'previewtest.p12') `
  -outFile $signed -keyPwd $pwd -keystorePwd $pwd 2>&1
$o2 | Out-File (Join-Path $work 'sign-app.log') -Encoding utf8
Write-Host ("sign-app exit={0} exists={1}" -f $LASTEXITCODE, (Test-Path $signed))
if (-not (Test-Path $signed)) { throw 'sign-app failed' }

# 4) verify
$o3 = & $java -jar $tool verify-app -inFile $signed `
  -outCertChain (Join-Path $work 'verify-chain.cer') `
  -outProfile (Join-Path $work 'verify-profile.p7b') 2>&1
$o3 | Out-File (Join-Path $work 'verify-app.log') -Encoding utf8
Write-Host ("verify-app exit={0}" -f $LASTEXITCODE)

[ordered]@{
  unsignedHap    = $unsigned
  unsignedBytes  = (Get-Item $unsigned).Length
  unsignedSha256 = (Get-FileHash $unsigned -Algorithm SHA256).Hash
  signedHap      = $signed
  signedBytes    = (Get-Item $signed).Length
  signedSha256   = (Get-FileHash $signed -Algorithm SHA256).Hash
  bundleName     = 'com.example.program_04'
  versionName    = '1.0.11'
} | ConvertTo-Json -Depth 3 | Tee-Object -FilePath (Join-Path $work 'signing-record.json')
