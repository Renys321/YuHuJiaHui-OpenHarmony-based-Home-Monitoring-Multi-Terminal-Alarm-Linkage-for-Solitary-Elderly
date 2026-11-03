# northbound 发布记录（DAYU200 监护人 APP）

> 本文件记录本目录作为**发布快照/构建入口**的当前版本与制品。源码主线是
> `competition/experiments/dayu-eldercare-preview-integration-2026-10-25`（canonical），
> 同步/构建/验证脚本与证据见
> `competition/evidence/2026-10-28-three-legacy-closures/source-unify/`。

## 本轮边界（Lead 裁决，2026-10-28）

- **安装：未执行（非必需）**。重建 HAP 与已安装 1.0.10 功能/包内 17/18 entries 字节等价，
  安装只会覆盖线上版本、无功能收益；因此“源码合并 + 构建验收”与“安装验收”分开报告。
  本 HAP 仅作为**“统一线可构建”证据**保留在 `evidence/2026-10-28-three-legacy-closures/source-unify/build/`，
  安装/回滚仍以 video-fps 1.0.10（`B5EC606E…F2B714`）为准。
- **安装脚本历史指向（已识别的风险）**：`materials/demo_start.ps1`、`materials/demo-preflight.js`、
  `materials/device-preflight.ps1` 仍指向 `northbound/signing/eldercare-signed.hap`（**1.0.0**），
  直接使用会把 APP 装回旧版。**修正由 watcher-recover 在 materials 写域执行**（Lead 已授权）；
  在那之前，安装请显式使用上表 1.0.10 signed HAP，不要使用旧脚本默认路径。
- **stale 测试**：`tests/device-capabilities.test.mjs` 仍是 1.0.0 旧能力契约（在 canonical
  experiments 树同样失败），本轮不改，记录为已知 stale；建议下轮按 1.0.10 契约更新断言。
- **版本策略**：保持 1.0.10 / 1000010；后续功能变更使用 **1.0.11 / 1000011**。
- 旧 northbound 1.0.0 归档（含合并事故恢复说明）：
  `evidence/2026-10-28-three-legacy-closures/source-unify/northbound-1.0.0-archive/`（本轮不再改动）。

## 当前版本（2026-10-28 合并后首次构建）

| 项 | 值 |
|---|---|
| bundleName | `com.dsh.eldercare` |
| versionName / versionCode | **1.0.10 / 1000010**（与 DAYU200 已安装版本一致，用于证明合并后功能等价） |
| buildMode / debug | debug=true |
| minAPIVersion / targetAPIVersion | 12 / 26（OpenHarmony 7.0.0.38、API26 板端） |
| 构建源 | `competition/northbound`（= experiments 1.0.10 当前快照，逐文件 SHA-256 校验） |
| 构建时间 | 2026-10-28 00:44（Asia/Shanghai），`clean` 后干净重建 |
| 构建结果 | `BUILD SUCCESSFUL` |
| 签名身份 | SDK 自带 debug keystore `OpenHarmony.p12`，alias `openharmony application release`；`signing/app-chain.pem` + `signing/final-profile.p7b`（同 1.0.5~1.0.10 身份/profile；口令不落盘、不写入本文件/日志） |
| 验签 | `verify-app success`：Digest verify result: true、verify permission sign success、profile type=debug |

## 制品（2026-10-28 构建；本次不安装，保留为“统一线可构建”证据）

| 制品 | 大小 (B) | SHA-256 |
|---|---|---|
| `dayu-eldercare-1.0.10-from-northbound-unsigned.hap` | 2,024,688 | `CCEA9DB22239701F6DA291B12074ED106DFC0BC003EE0E4CF5BFC947CEFD8677` |
| `dayu-eldercare-1.0.10-from-northbound-norpc.hap`（剔除 `rpcid.sc`，可安装变体） | 1,368,270 | `407F8BE7A963F9EAE955CCF47829675D5806D279F736F205E3857F6DEC9D9F1B` |
| **`dayu-eldercare-1.0.10-from-northbound-signed.hap`（统一线可构建证据；本次不安装）** | **1,385,966** | **`7C38C95D1296DB8B14ED1DC83C8D0F72036C5E57ED15951131D9EC168FAD5372`** |
| `verify-app-chain.cer` | 2,829 | `C8786C2F7995832244532BE868B61ABF3911DC3072E928E82530F6B4F713CE4D` |
| `verify-app-profile.p7b` | 3,533 | `8D281C12382270E990CD1FE663842327E66063167BB2F9D05386BF251BAA181B` |

产物与日志目录：
`competition/evidence/2026-10-28-three-legacy-closures/source-unify/build/`
（`build-1.0.10-from-northbound.log`、`clean-1.0.10-from-northbound.log`、`sign-app.log`、`verify-app.log`、`static-checks.txt|json`、`northbound-tests.log`、`SHA256SUMS.txt`）

## 与 experiments 1.0.10 构建产物的功能等价性（构建级静态对比）

- 包内 **18 entries**，与 `evidence/2026-10-27-video-fps/dayu-video-fps-1.0.10-signed.hap`
  （当前安装版构建产物）entry 清单完全一致；包内无 `.bak`/临时文件。
- 逐 entry 对比：**只有 `ets/sourceMaps.map` 不同**（其中记录的是两个工程的绝对路径）；
  `ets/modules.abc`、`module.json`、`resources.index`、`pack.info`、6 个 rawfile 语音等 17 个 entry
  逐字节相同 → ArkTS 字节码级功能等价。
- 关键能力标记（`ets/modules.abc` 字节搜索，新包/buildline 均存在）：
  `VideoStreamServer` 绑定 `0.0.0.0`、`LAN_ONLY` 私网白名单、`VIDEO_STREAM_PORT`/`VIDEO_STREAM_PROTO`、
  `frameIntervalMs` 帧率控制、`WearableBannerStore`、横幅偏好键 `wb_acked_`/`wb_alarm_`/
  `eldercare_wearable_banner`、`PreviewTuning` 预览调参、`随身求助`/`未配置 PIR`/`暂无定位`/
  `设备已确认` 文案、告警归属字段 `ackSource`/`wearable`。
- 旧线缺陷不得回退：`CameraModel` 的 `setPreviewRotation` 调用在新包中**不存在**（旧 1.0.0 线
  曾因该调用在板端报 7400201 Invalid Session Configuration）。

## 测试（源码守卫）

```bash
node --test tests/camera-lifecycle-guard.test.js      # pass
node --test tests/camera-room-ownership-guard.test.js # 9/9 pass
node --test tests/photo-retention.test.mjs            # 4/4 pass
node --test tests/sosvoiceability-guard.test.js       # 11/11 pass
node --test tests/device-capabilities.test.mjs        # 1/5 pass
```

`device-capabilities.test.mjs` 的 4 条失败断言仍是 **1.0.0 旧能力契约**（客厅有 PIR/门磁/温湿度、
厨房无 PIR/门磁、卫生间无门磁），与 1.0.10 的核验契约（客厅仅摄像头；厨房/卫生间 PIR+门磁已装）
不一致；该测试在 canonical experiments 树同样失败（已实测），属合并前既有 stale 测试，
本次**未修改**（避免掩盖问题），建议下一轮按 1.0.10 契约更新断言。详见 `northbound-tests.log`。

## 回滚（覆盖安装保留应用数据；是否安装由 Lead 决定）

| 目标版本 | 回退包 | 大小 (B) | SHA-256 |
|---|---|---|---|
| 当前安装 1.0.10 | `evidence/2026-10-27-video-fps/dayu-video-fps-1.0.10-signed.hap` | 1,385,966 | `B5EC606E428A40B6005F552276000EE2CDEA79A3E91DB4612DCB874406F2B714` |
| 1.0.8（横幅可关闭） | `evidence/2026-10-27-reconnect-dayu-sos/dayu-sos/banner-1.0.8/dayu-eldercare-1.0.8-signed.hap` | 1,385,967 | 见该目录 SHA256SUMS |
| 1.0.6（视频 Wi-Fi） | `evidence/2026-10-27-video-wifi/dayu-video-wifi-1.0.6-signed.hap` | 1,377,775 | `D1E7D934D00C2D28206E8F5963EA9BB8F5AB2FCCADDED6F32547A40D1D832B04` |
| 1.0.5（随身 SOS 显示） | `evidence/2026-10-27-reconnect-dayu-sos/dayu-sos/build/dayu-eldercare-1.0.5-signed.hap` | 1,373,680 | `7EE16A97E9D761A5B6BD74DFDE638B958A522962ECD1E621E3DCE0868849FDFF` |
| 1.0.0（旧线回退） | `northbound/signing/eldercare-signed.hap` | 1,860,490 | `1F2529C1164662B64257E7F1ABA833B3232025DE06146A058F72AD4B4A9D1073` |

```powershell
$hdc = '<WORKSPACE>\tools\hdc\hdc.exe'
$target = '450100445634303332012847942eca00'
& $hdc -t $target install -r <上表任一 signed.hap>
& $hdc -t $target shell 'bm dump -n com.dsh.eldercare | grep -m1 -E "versionName|versionCode"'
```

## 复现构建

```powershell
$env:DEVECO_SDK_HOME = 'D:\DevEcoStudio\DevEco Studio\sdk'
$env:JAVA_HOME       = 'D:\DevEcoStudio\DevEco Studio\jbr'
$env:HVIGOR_USER_HOME = '<WORKSPACE>\.buildcache\hvigor'
$env:OHPM_HOME       = '<WORKSPACE>\.buildcache\ohpm'
Set-Location <WORKSPACE>\competition\northbound
& 'D:\DevEcoStudio\DevEco Studio\tools\hvigor\bin\hvigorw.bat' clean --no-daemon
& 'D:\DevEcoStudio\DevEco Studio\tools\hvigor\bin\hvigorw.bat' assembleHap --mode module -p product=default -p buildMode=debug --no-daemon
# 然后 python signing/strip_rpcid.py <unsigned> <norpc> + hap-sign-tool sign-app/verify-app
# （完整命令见 scripts/01-build-verify-sign-1.0.10.ps1，口令仅从环境变量注入）
```

## 已知边界

- 本次**未安装**到 DAYU200（Lead 裁决：非必需，见“本轮边界”）；安装、真机功能/截图验收与回滚由 Lead 统一决定。
- `signing/eldercare-signed.hap` 是 1.0.0 历史回退包，不是当前发布版本；
  `materials/` 的 `demo_start.ps1`/`demo-preflight.js`/`device-preflight.ps1` 仍指向它 —— 安装前必须显式指定
  本记录中的 1.0.10 signed HAP，或等 watcher-recover 完成修正（Lead 已授权）。
- 旧 northbound 1.0.0 源码归档（含合并事故恢复说明）：
  `evidence/2026-10-28-three-legacy-closures/source-unify/northbound-1.0.0-archive/`
- 最终校验（2026-10-28 00:51）：`competition/northbound` 无 `entry/build`（已 clean）、无 signing/ 之外的 HAP、
  无 `.bak`/备份目录/`.p12`/`.jks`/私钥；`signing/` 58 文件与合并前归档逐一 SHA-256 一致；
  源码作用域 63 文件与 experiments 快照 0 差异；口令泄漏扫描 none。详见
  `evidence/2026-10-28-three-legacy-closures/source-unify/FINAL-CHECKS.txt`。
