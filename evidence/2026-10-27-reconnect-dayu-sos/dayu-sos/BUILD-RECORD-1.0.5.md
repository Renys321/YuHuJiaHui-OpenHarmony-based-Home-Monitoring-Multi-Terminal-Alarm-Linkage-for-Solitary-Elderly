# DAYU200 APP 1.0.5 构建记录（随身 SOS 显示 + PIR 能力契约）

- 设备：DAYU200 `450100445634303332012847942eca00`，OpenHarmony 7.0.0.38 / API 26，720×1280
- 包名：`com.dsh.eldercare`，**1.0.4 / 1000004 → 1.0.5 / 1000005**
- 构建时间：2026-10-27 22:40–22:49（Asia/Shanghai）
- 构建源：`competition/experiments/dayu-eldercare-preview-integration-2026-10-25`
  （**与线上 1.0.4 同一工作副本**：其 `AppScope/app.json5` 原为 1.0.4/1000004，且
  `evidence/2026-10-27-battery-video-visit/dayu-1.0.4/REPORT.md` 明确记录 1.0.4 构建源为该副本；
  `competition/northbound` 是 1.0.0 旧线、无视频探望/预览调参代码，从它构建会回退功能）
- 构建命令（与 northbound README 一致）：

```powershell
Set-Location <WORKSPACE>\competition\experiments\dayu-eldercare-preview-integration-2026-10-25
$env:DEVECO_SDK_HOME = 'D:\DevEcoStudio\DevEco Studio\sdk'
$env:JAVA_HOME       = 'D:\DevEcoStudio\DevEco Studio\jbr'
$env:HVIGOR_USER_HOME = '<WORKSPACE>\.buildcache\hvigor'
$env:OHPM_HOME       = '<WORKSPACE>\.buildcache\ohpm'
& 'D:\DevEcoStudio\DevEco Studio\tools\hvigor\bin\hvigorw.bat' `
  assembleHap --mode module -p product=default -p buildMode=debug --no-daemon
```

结果：`BUILD SUCCESSFUL`（完整日志见 `../build/build-1.0.5.log`，主工程无编译错误；
仅 SosVoiceAbility 的既有系统能力告警）。

## 制品与 SHA-256

| 制品 | 大小 | SHA-256 |
|---|---|---|
| `build/dayu-eldercare-1.0.5-unsigned.hap` | 1,981,396 B | `B85093E4770A4698C1F6D53752900F90DB78C373F70CA6C977CC9412FBF66994` |
| `build/dayu-eldercare-1.0.5-norpc.hap`（剔除 SDK26 `rpcid.sc`，可安装变体） | 1,356,123 B | `40A57AF312941D341759F172A557A1FC74A43357AEE8420CFABC7B5E21B95556` |
| **`build/dayu-eldercare-1.0.5-signed.hap`（安装用）** | **1,373,680 B** | **`7EE16A97E9D761A5B6BD74DFDE638B958A522962ECD1E621E3DCE0868849FDFF`** |

包内清单校验（`module.json`）：`versionName=1.0.5`、`versionCode=1000005`、`debug=true`、
`bundleName=com.dsh.eldercare`；`ets/modules.abc` 中确认包含本轮新增字符串
（`随身求助` / `未配置 PIR` / `等待设备确认` / `定位：暂无定位` / `设备已确认`），
且包内无 `.bak` 等临时文件（18 个 entry）。

## 签名与验签

- 工具：`D:\DevEcoStudio\DevEco Studio\sdk\default\openharmony\toolchains\lib\hap-sign-tool.jar`
- keystore：SDK 自带 `OpenHarmony.p12`（开发调试证书，与 1.0.4 相同的签名身份）
- `-keyAlias "openharmony application release"`、`-signAlg SHA256withECDSA`、`-mode localSign`
- `-appCertFile competition/northbound/signing/app-chain.pem`
- `-profileFile competition/northbound/signing/final-profile.p7b`（debug profile，
  bundle=`com.dsh.eldercare`，UDID 已绑定；覆盖安装保留应用数据）
- 签名口令按项目纪律**不写入证据文件/脚本/日志**。
- `verify-app`：**success**（`Digest verify result: true`、`verify permission sign success`）；
  证书链与 profile 输出：`build/verify-app-chain.cer`、`build/verify-app-profile.p7b`。

> 说明：1.0.5 的 `rpcid.sc` 已剔除（SDK26 全量 syscap 名单在 OH 7.0 板端会导致
> `install` 校验失败；与 1.0.3/1.0.4 的既有处理一致，不改变功能）。

## 源码备份与回退

- 改动前源码备份：`../source-backup/`（Index.ets / DeviceModel.ets / DeviceCapabilities.ts / app.json5，
  均来自 1.0.4 工作副本；位于源码树内会被打入 HAP，已移出并在干净重建后确认包内无 `.bak`）。
- 回退包（当前线上 1.0.4）：`competition/evidence/2026-10-27-battery-video-visit/dayu-1.0.4/dayu-eldercare-video-1.0.4-signed.hap`
  （1,353,199 B / SHA-256 `05230657B89B7D8AFE29C7F94AEC57639887F706725C005603E024B3DA68CF60`）。
- 回退历史包：`competition/evidence/2026-10-27-dayu200-real-capability/rollback-1.0.2-signed.hap`。

## 环境注记（构建期间）

- 2026-10-27 22:48 起 DAYU 从 hdc 掉线（`hdc list targets` 只剩手机模拟器 `127.0.0.1:5555`，
  `fport ls` 为空），因此本记录不含 1.0.5 的安装/真机截图；安装与验收由 Lead 在设备恢复后统一执行。
