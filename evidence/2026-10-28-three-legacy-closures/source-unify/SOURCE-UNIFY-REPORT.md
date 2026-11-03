# DAYU200 northbound / experiments 源码线统一报告（2026-10-28）

- 任务：task-9「统一 DAYU northbound 与 experiments 源码线」
- 执行：source-unify（teammate），Lead 授权第二阶段后执行
- 结论：**experiments 线为唯一维护主线（canonical）；`competition/northbound` 已同步为 1.0.10 发布快照 + 构建/签名入口；`northbound/signing/**` 未改动；从 northbound 干净构建的 1.0.10 signed HAP 已验签、与 experiments 1.0.10 产物**字节码级等价**（仅 sourceMaps 路径不同）；**安装未执行（Lead 裁决：非必需，HAP 保留为“统一线可构建”证据）**。

---

## 1. 差异分析（第一阶段，只读）

### 1.1 两棵树的客观状态

| 项 | `competition/northbound`（旧线） | `experiments/dayu-eldercare-preview-integration-2026-10-25`（活树） |
|---|---|---|
| AppScope version | 1.0.0 / 1000000 | **1.0.10 / 1000010** |
| bundleName | com.dsh.eldercare | com.dsh.eldercare（相同） |
| 源文件（ets/ts） | 11 ets + 2 ts = 13 | **14 ets + 2 ts = 16** |
| 全树文件（除 `.hvigor/`、`entry/build/`） | 119 | 131 |
| 构建脚手架 / module.json5 / build-profile / 资源 | 与 experiments 相同 | 相同 |
| 最近修改 | 2026-10-22（signing）、2026-10-09（源码） | 2026-10-27 23:42 ~ 10-28 00:18（视频会话最后一版） |

### 1.2 文件级 diff

文件级比对（排除 `.hvigor/`、`entry/build/`）：**northbound 没有任何 experiments 中不存在的文件**，即 experiments 是 northbound 的超集。

- **112 / 119 个共同文件逐字节相同**（含 tests、全部资源、rawfile、module.json5、build-profile、hvigorfile、签名资产 `final-profile.p7b`、`app-chain.pem` 等）。
- **7 个文件不同**：

| 文件 | northbound | experiments | 语义 |
|---|---|---|---|
| `AppScope/app.json5` | 246 B | 247 B | 版本 1.0.0→1.0.10 |
| `entry/src/main/ets/model/CameraModel.ets` | 18,137 B | 17,956 B | **删除 `previewOutput.setPreviewRotation(ROTATION_0, true)`**：旧线该调用在板端实测报 `7400201 Invalid Session Configuration`，是旧线缺陷 |
| `entry/src/main/ets/model/DeviceCapabilities.ts` | 1,927 B | 2,531 B | 2026-10-27 板端核验后的能力契约：客厅只有摄像头（PIR/温湿度/门磁物理未接线，不得当已装）；厨房 PIR(GPIO38)+门磁(GPIO14)；卫生间 PIR(GPIO36)+门磁；新增 `esp32-sos`（仅 SOS） |
| `entry/src/main/ets/model/DeviceModel.ets` | 9,342 B | 10,254 B | 新增告警自身归属字段 `room/source/eventTs/deviceId/gps*/ackSource`；NO_MOTION/GAS/SMOKE 文案改为不夸大（“无活动≠跌倒/昏迷”、“MQ 未标定需现场核实”） |
| `entry/src/main/ets/pages/Index.ets` | 66,383 B / 1,532 行 | 101,908 B / 2,254 行 | 新增 25 个方法（见 1.3）；**旧线全部方法仍然保留**（方法名集合层面 experiments 是严格超集） |
| `signing/app-unsigned-norpc.hap` | 1,299,818 B | 1,368,459 B | 构建产物（1.0.0 / 1.0.10 中间包），非源码 |
| `signing/profile-debug.json` | 旧 uuid/有效期 | 新 uuid/有效期 | profile 生成中间件；实际签名统一使用 `final-profile.p7b`（两树相同） |

- **experiments 独有文件**：`model/PreviewTuning.ets`（预览调参持久化）、`model/VideoStreamServer.ets`（视频 Wi-Fi 直连 0.0.0.0:9301 + 私网白名单 + 帧率配置）、`model/WearableBannerPrefs.ets`（随身求助横幅收起/关闭持久化）；另有 4 个根目录构建日志、3 个 experiments 签名 HAP、`signing/verify-update-*`。
- **northbound 独有内容**：文件层面为 0；语义上只有两处**旧缺陷**（CameraModel 的旋转崩溃调用、旧能力契约），已被 experiments 修复，**不应保留**。1.0.0 的签名 HAP（`eldercare-signed.hap` 1,860,490 B）与历史 signing 资产仍保留在 `northbound/signing/`。

### 1.3 experiments 独有的已验收能力（Index.ets 新增方法）

`VideoStreamServer` 起服（`startVideoStreamServer`）、预览调参（`loadPreviewTuning/savePreviewTuning/resetPreviewTuning/changePreviewWidth/changePreviewScale`）、随身 SOS 展示（`selectWearable/hasSosCapability/wearableGpsText/alarmGpsText/alarmIsWearable`）、横幅可收起/关闭（`refreshWearableBanner/collapseWearableBanner/expandWearableBanner/dismissWearableBanner/viewWearableBanner/bannerUpdateDisplay/bannerHostContext/persistBannerPref/ensureBannerPref`、红点 `wearableTabBadge`）、无 PIR 语义（`motionMonitorConfigured/motionMonitorText`）、告警自身归属（`alarmRoomText/alarmTimeText/alarmStatusText/alarmStatusColor/alarmDetailText`）。

### 1.4 主线决策与风险

**决策：experiments 线为唯一维护主线（canonical）；northbound 变为其发布快照 / 构建入口，保留 `signing/` 与构建脚手架。**

理由：① 功能严格超集且逐字节包含旧线合格文件；② 当前 DAYU 安装版（1.0.10）构建源就是 experiments；③ 旧线两处为已证实缺陷；④ `northbound/signing/` 是签名资产的唯一实际引用点（`materials/demo_start.ps1`、`demo-preflight.js`、`device-preflight.ps1`、`make_voice.ps1` 均引用 northbound 路径），因此 northbound 不能删除，只能作为构建/签名入口。

风险与处置：
1. **experiments 是并行会话活树** → 已由 Lead 确认视频帧率会话结束；本任务先做停写检查 + 全量快照（含逐文件 SHA-256），快照后只读。
2. **无 Git 元数据** → 依赖 evidence 快照/清单；后续任何 experiments 变更必须重跑 `00-snapshot-archive-sync.ps1` 并更新清单。
3. **构建入口从 experiments 改为 northbound** → 产物字节不同（sourceMaps 绝对路径），需以“字节码等价 + 静态标记 + 真机安装”分层验收（本次完成前两项，安装待 Lead）。
4. **`materials/` 安装脚本仍指向 `northbound/signing/eldercare-signed.hap`（1.0.0）** → 见 §6 未解决项。
5. **stale 测试**：`tests/device-capabilities.test.mjs` 仍是旧契约，见 §5。

---

## 2. 统一方案与版本策略

- 同步方向：experiments 快照 → northbound；同步范围：源码 / 资源 / `AppScope/app.json5` / tests / 构建脚手架；**排除** `signing/**`、`.hvigor/`、`entry/build/`、`*.log`、HAP、密钥。
- 版本策略：**保持 1.0.10 / 1000010**（与当前安装一致，用于证明合并后功能等价），不擅自升 1.0.11；bundleName 固定 `com.dsh.eldercare`；下次功能变更再递增 1.0.11/1000011。
- 旧线归档：`northbound-1.0.0-archive/`（不删除历史 HAP/证据）。
- 文档：`northbound/README.md` 顶部新增“源码主线与版本策略”；新增 `northbound/RELEASE.md`（当前版本/制品哈希/回滚/等价性）。

### 2.1 脚本（均可 dry-run，默认 dry-run）

| 脚本 | 作用 |
|---|---|
| `scripts/00-snapshot-archive-sync.ps1` | 停写检查 → experiments 全量快照 + SHA-256 清单 + 实时树一致性校验 → 旧 northbound 归档 → 快照源码同步进 northbound；全程 signing/ 不变性校验；默认 dry-run，`-Execute` 才写盘 |
| `scripts/02-archive-old-northbound.ps1` | 生成旧 1.0.0 归档（含事故恢复：用编译缓存逐字节恢复 4 个源码 + 重建 app.json5），写 `RECOVERY-NOTES.md` 与清单 |
| `scripts/01-build-verify-sign-1.0.10.ps1` | clean → assembleHap → 剔除 rpcid.sc → sign-app（口令仅环境变量，日志脱敏）→ verify-app → 静态核对 → 产物 SHA-256 |
| `scripts/01b-static-checks.py` | 包内 module.json/entries/逐 entry 哈希/能力标记/负向标记核对 |
| `recovery/recover_v2.py`、`recovery/recover_old_sources.py` | 从 ArkTS 编译缓存 msgpack 恢复旧 northbound 源码并校验 |

---

## 3. 第二阶段执行记录

### 3.1 停写确认

- experiments 树最后一次写入：`signing/profile-debug.json` @ **2026-10-28 00:18:25**；脚本 00:42:21 检查时距今 **23.9 分钟**，通过 `-QuietMinutes 5` 门槛。
- 视频帧率证据目录最后一次写入 00:25:28（`REPORT.md`，仅报告，不再改源码树）。
- Lead 已确认：用户确认视频帧率会话结束。

### 3.2 事故与恢复（必须如实记录）

- **00:34:56**：`00-snapshot-archive-sync.ps1` 第一次 dry-run 时，`/L` 被误加到 PowerShell 自动变量 `$args`（而不是 robocopy 参数数组 `$roboArgs`），robocopy 实际执行了覆盖 —— **旧 northbound 的 5 个差异源码被 experiments 1.0.10 内容覆盖**（app.json5、CameraModel.ets、DeviceCapabilities.ts、DeviceModel.ets、Index.ets）。`signing/` 因排除规则未被改动。
- 发现后立即停止后续写操作并恢复：
  1. 旧 northbound 在 2026-10-25 20:59 有一次完整构建，`entry/build/.../compiler.cache/modules/*.msgpack` 中保存了每个源文件原始文本；`recovery/recover_v2.py` 逐字节提取；
  2. **方法验证**：同批 msgpack 中 5 个“两棵树逐字节相同”的文件，提取内容 SHA-256 与当前文件完全一致 → 证明提取逐字节精确；
  3. 恢复 4 个差异源码，字节数与覆盖前登记值完全一致（Index 66,383 / CameraModel 18,137 / DeviceModel 9,342 / DeviceCapabilities 1,927）；其中 `DeviceModel.ets` 恢复后 SHA-256 `50C7BCC1…E30D` 与 `docs/ARTIFACTS.md` 第 83 行历史哈希一致（独立交叉验证）；
  4. `app.json5` 按覆盖前 diff（仅 versionName/versionCode 两行不同）重建，246 B 与覆盖前一致。
- **影响评估**：旧线源码已完整归档，功能/证据无丢失；该事故只影响了“归档产物由复制改为恢复”，已写入 `northbound-1.0.0-archive/RECOVERY-NOTES.md`。
- **修复**：`/L` 改为拼入 `$roboArgs`；并在 `Invoke-Robocopy` 增加安全网——只要 `$Mode -eq 'DRY-RUN'` 就强制 `/L`；`-Execute` 前校验快照/归档目录并用 SHA-256 复核。

### 3.3 experiments 全量快照（只读回溯基准）

- 路径：`experiments-snapshot-1.0.10/`；**248 文件 / 33,743,518 B**（含 `.hvigor/`、`entry/build/` 以保证可回溯）。
- 清单：`experiments-snapshot-1.0.10.SHA256SUMS.txt`（248 行，逐文件 SHA-256）。
- 校验：快照与实时树逐文件 SHA-256 一致（0 差异）；快照后 experiments 只读。

### 3.4 旧 northbound 1.0.0 归档

- 路径：`northbound-1.0.0-archive/`（**207 文件 / 22,366,344 B**；含旧 `entry/build` 1.0.0 构建产物与旧 `signing/` 资产；不含 `.hvigor`）。
- 旧源码作用域（除 `.hvigor/`、`entry/build/`、`signing/`）：62 文件 = 61 个旧源码/配置文件 + `RECOVERY-NOTES.md`。
- 清单：`northbound-1.0.0-archive.SHA256SUMS.txt`。
- 与合并后 northbound 的差异核对：仅归档有 `RECOVERY-NOTES.md`；仅当前有 3 个 experiments 独有 ets；内容不同恰为 5 个恢复件（与覆盖前 7 差异文件中除 signing 产物外的预期完全一致）。

### 3.5 同步结果

- 事故恢复后重跑 `-Execute -SkipArchive`：experiments 快照已存在 → 直接作为源；robocopy **0 变更**；northbound 同步作用域 64 文件 vs 快照 64 文件，0 差异、0 遗留文件。
- `northbound/signing/` 同步前后 58 个文件 SHA-256 完全一致（**未被写入**）。
- **同步排除项**：`signing/**`、`.hvigor/`、`entry/build/`、`*.log`，以及发布层文档 `README.md`/`RELEASE.md`
  （由 northbound 自己维护，避免每次同步冲掉主线说明）。
- 最终复验（00:46:36–00:47:09，`-Execute -SkipSnapshot -SkipArchive`）：快照 63 文件（除发布层文档）与
  northbound 63 文件 **0 差异、0 缺失**；`signing/` 58 文件未变；app.json5 = **1.0.10/1000010**。
- 最终 `competition/northbound`：源码/资源/app.json5 = experiments 1.0.10 快照；`signing/` = 原 1.0.0 资产（保留）；文档已更新。

### 3.6 合并前后 diff 摘要

| 类别 | 数量 | 明细 |
|---|---|---|
| 新增（experiments 独有） | 3 源码 + 4 日志 + 3 signing HAP + 2 verify-update | `PreviewTuning.ets`、`VideoStreamServer.ets`、`WearableBannerPrefs.ets`；日志与 HAP 未同步进 northbound |
| 更新（内容覆盖） | 5 | `AppScope/app.json5`、`CameraModel.ets`、`DeviceCapabilities.ts`、`DeviceModel.ets`、`Index.ets` |
| 未变（逐字节相同） | 112（源/配置/资源/tests） | 见 1.2 |
| signing | 0 改动 | 58 文件保持不变 |
| 文档 | 2 | `README.md` 增补、新增 `RELEASE.md` |

---

## 4. 从 northbound 构建与验证（构建验收完成；安装未执行）

> **Lead 裁决（2026-10-28）**：本次**不安装**重建的 1.0.10 HAP —— 它与已安装 1.0.10 功能/包内
> 17/18 entries 字节等价，安装只会覆盖当前线上版本、无功能收益。因此“源码合并 + 构建验收”与
> “安装验收”分开报告：本 HAP 作为“统一线可构建”证据保留在 `build/`；安装/回滚仍以
> video-fps 1.0.10（`B5EC606E…F2B714`）为准。安装脚本指向 1.0.0 的修复由 watcher-recover
> 在 materials 写域执行（Lead 已授权）。

环境：`DEVECO_SDK_HOME=D:\DevEcoStudio\DevEco Studio\sdk`、`JAVA_HOME=D:\DevEcoStudio\DevEco Studio\jbr`、
`HVIGOR_USER_HOME=<WORKSPACE>\.buildcache\hvigor`、`OHPM_HOME=<WORKSPACE>\.buildcache\ohpm`；
命令：`hvigorw clean --no-daemon` → `hvigorw assembleHap --mode module -p product=default -p buildMode=debug --no-daemon`。

- **构建**：2026-10-28 00:44，`BUILD SUCCESSFUL`（日志 `build/build-1.0.10-from-northbound.log`）。
- **签名**：同身份/同 profile（SDK `OpenHarmony.p12` + `signing/app-chain.pem` + `signing/final-profile.p7b`，
  profile type=debug），口令仅内存注入、日志脱敏（已核查无口令泄漏）。
- **验签**：`verify-app` success（Digest verify result: true；verify permission sign success），
  证书链 `OpenHarmony Application Release ← Application CA ← Application Root CA`；
  输出 `build/verify-app-chain.cer`、`build/verify-app-profile.p7b`。

| 制品 | 大小 (B) | SHA-256 |
|---|---|---|
| unsigned | 2,024,688 | `CCEA9DB22239701F6DA291B12074ED106DFC0BC003EE0E4CF5BFC947CEFD8677` |
| norpc（剔除 rpcid.sc） | 1,368,270 | `407F8BE7A963F9EAE955CCF47829675D5806D279F736F205E3857F6DEC9D9F1B` |
| **signed（“统一线可构建”证据；本次不安装）** | **1,385,966** | **`7C38C95D1296DB8B14ED1DC83C8D0F72036C5E57ED15951131D9EC168FAD5372`** |

- **包内清单**：`module.json` → `bundleName=com.dsh.eldercare`、`versionName=1.0.10`、
  `versionCode=1000010`、`debug=true`、minAPI 12 / targetAPI 26；**18 entries**；无 `.bak`/临时文件。
- **与 experiments 1.0.10 构建产物（当前安装版构建源 `evidence/2026-10-27-video-fps/dayu-video-fps-1.0.10-signed.hap`，1,385,966 B，`B5EC606E…F2B714`）对比**：
  - entry 清单一致（18/18）；逐 entry 只有 **`ets/sourceMaps.map`** 不同（记录的是两个工程的绝对路径）；
  - **`ets/modules.abc`、`module.json`、`resources.index`、`pack.info`、6 个 rawfile 语音等 17 个 entry 逐字节相同** → 字节码级功能等价；
  - 关键能力标记全部存在（新包与 baseline 同为 True）：`0.0.0.0`、`LAN_ONLY`、`VIDEO_STREAM_PORT`、
    `VIDEO_STREAM_PROTO`、`frameIntervalMs`、`WearableBannerStore`、`wb_acked_`、`wb_alarm_`、
    `eldercare_wearable_banner`、`PreviewTuning`、`随身求助`、`未配置 PIR`、`暂无定位`、`设备已确认`、
    `ackSource`、`wearable`；
  - 负向标记：`setPreviewRotation` **不存在**（旧线缺陷未回退）。
- 证据：`build/static-checks.txt`、`build/static-checks.json`、`build/SHA256SUMS.txt`。

### 4.1 源码守卫测试

- 通过：`camera-lifecycle-guard`（pass）、`camera-room-ownership-guard` 9/9、`photo-retention` 4/4、`sosvoiceability-guard` 11/11。
- **失败**：`device-capabilities.test.mjs` 1/5 —— 4 条断言仍是 **1.0.0 旧能力契约**（客厅有 PIR/门磁/温湿度、厨房无 PIR/门磁、卫生间无门磁），与 1.0.10 板端核验契约冲突；在 canonical experiments 树**同样失败**（已实测），属合并前既有 stale 测试，本次未修改（避免掩盖），见 `build/northbound-tests.log`。**建议下一轮按 1.0.10 契约更新断言。**

---

## 5. 回滚

- **源码回滚基准**：`experiments-snapshot-1.0.10/`（合并前 experiments 原样）；旧线：`northbound-1.0.0-archive/`（含 RECOVERY-NOTES）。
- **安装回滚包**（覆盖安装保留数据）：

| 目标 | 文件 | 大小 (B) | SHA-256 |
|---|---|---|---|
| 当前安装 1.0.10 | `evidence/2026-10-27-video-fps/dayu-video-fps-1.0.10-signed.hap` | 1,385,966 | `B5EC606E428A40B6005F552276000EE2CDEA79A3E91DB4612DCB874406F2B714` |
| 1.0.8 横幅 | `evidence/2026-10-27-reconnect-dayu-sos/dayu-sos/banner-1.0.8/dayu-eldercare-1.0.8-signed.hap` | 1,385,967 | 见该目录 |
| 1.0.6 视频 Wi-Fi | `evidence/2026-10-27-video-wifi/dayu-video-wifi-1.0.6-signed.hap` | 1,377,775 | `D1E7D934D00C2D28206E8F5963EA9BB8F5AB2FCCADDED6F32547A40D1D832B04` |
| 1.0.5 随身 SOS | `evidence/2026-10-27-reconnect-dayu-sos/dayu-sos/build/dayu-eldercare-1.0.5-signed.hap` | 1,373,680 | `7EE16A97E9D761A5B6BD74DFDE638B958A522962ECD1E621E3DCE0868849FDFF` |
| 1.0.0 旧线 | `northbound/signing/eldercare-signed.hap` | 1,860,490 | `1F2529C1164662B64257E7F1ABA833B3232025DE06146A058F72AD4B4A9D1073` |

- 安装命令（**未执行**，由 Lead 决定）：`hdc -t 450100445634303332012847942eca00 install -r <signed.hap>`，
  校验 `bm dump -n com.dsh.eldercare | grep versionName`。
- 源码回滚：若需重新构建旧线，用 `northbound-1.0.0-archive/` 覆盖 northbound 后按 README 构建（注意该线缺 1.0.1~1.0.10 能力）。

---

## 6. 未解决项 / 边界（含 Lead 裁决后的状态）

1. **安装：未执行（非必需，Lead 裁决）**。重建 HAP 与已安装 1.0.10 功能/17/18 entries 字节等价，
   安装无功能收益且会覆盖线上版本；HAP 保留为构建证据。真机安装验收与回滚由 Lead 决定，
   回滚包仍用 video-fps 1.0.10（`B5EC606E…F2B714`）。
2. **`materials/` 安装脚本历史指向 1.0.0（已授权修复）**：`demo_start.ps1`、`demo-preflight.js`、
   `device-preflight.ps1` 仍引用 `northbound/signing/eldercare-signed.hap`（1.0.0）；Lead 已授权
   **watcher-recover 在 materials 写域修正**。本任务只在 `northbound/README.md` 与 `RELEASE.md`
   写明“旧脚本曾指向 1.0.0”的风险与正确指向（1.0.10 signed HAP），未改 materials。
3. **stale 测试（已知项，本轮不改）**：`device-capabilities.test.mjs` 4 条断言仍按 1.0.0 旧能力契约，
   在 canonical experiments 树同样失败；本轮记录为已知 stale，**建议下轮按 1.0.10 契约更新断言**。
4. **experiments 仍是 canonical 活树**：后续任何 experiments 变更须重跑 `00-snapshot-archive-sync.ps1`
   （快照已存在会拒绝，需先人工移走或加 `-ForceSnapshot`）并同步 northbound，保持“单一维护主线”。
5. 构建产物与 experiments 1.0.10 **不是逐字节相同**（sourceMaps 路径差异），但字节码/包内 17/18 entries 相同；
   真机功能等价性本轮按 Lead 裁决不做安装验证。
6. 版本策略：**保持 1.0.10 / 1000010**；后续功能变更使用 **1.0.11 / 1000011**。

---

## 7. 证据索引（`competition/evidence/2026-10-28-three-legacy-closures/source-unify/`）

| 路径 | 内容 |
|---|---|
| `experiments-snapshot-1.0.10/` + `.SHA256SUMS.txt` | experiments 1.0.10 合并前全量快照（248 文件，33,743,518 B） |
| `northbound-1.0.0-archive/` + `.SHA256SUMS.txt` | 旧 northbound 1.0.0 归档（207 文件，含 RECOVERY-NOTES.md） |
| `recovery/` | 旧源码恢复脚本 + `recovery-report.json` + 恢复出的 4 个源码 |
| `scripts/` | 00 快照/归档/同步、02 旧线归档、01 构建/签名/验签、01b 静态核对 |
| `build/` | unsigned/norpc/signed HAP、construction/sign/verify 日志、verify 证书链/profile、static-checks、tests、SHA256SUMS |
| `00-snapshot-archive-sync.log`、`01-build-verify-sign.log`、`02-archive-old-northbound.log` | 执行日志 |
| `FINAL-CHECKS.txt` | Lead 裁决后的最终卫生/一致性校验输出（2026-10-28 00:51） |
| `../../northbound/RELEASE.md`（工作树） | 当前发布记录（版本/哈希/回滚/等价性/本轮边界） |

---

## 8. 最终校验（Lead 裁决后，2026-10-28 00:51）

校验脚本输出原文：`FINAL-CHECKS.txt`。结论：**`competition/northbound` 已恢复为干净源码快照，可安全作为发布/构建入口**。

| 检查项 | 结果 |
|---|---|
| `AppScope/app.json5` | `versionName=1.0.10`、`versionCode=1000010`（保持） |
| 源码作用域（除 `.hvigor/`、`entry/build/`、`signing/`、发布层文档、日志） | northbound 63 文件 vs experiments 快照 63 文件：**0 差异、0 缺失、0 多余** |
| `signing/` 不变性 | 58 文件 / 14,669,110 B；与合并前归档逐一 SHA-256：**0 改动、0 增删** |
| `entry/build/` | **已 `hvigorw clean`，无残留构建产物**（HAP 已另行保存在 evidence `build/`） |
| signing/ 之外的 HAP | **无**（仅 `signing/` 内保留 16 个既有签名资产 HAP，属项目历史资产） |
| `.bak` / 备份目录 / `.p12` / `.jks` / `.key` | **无** |
| signing/ 私钥材料（`PRIVATE KEY` 搜索） | **0 个文件**（只有证书/链/profile 资产，无私钥） |
| 口令泄漏扫描（SDK debug keystore 口令明文、`keystorePwd`/`keyPwd` 明文，覆盖 northbound + 本次 evidence 全部文本） | **none** |
| 证据产物完整性 | unsigned 2,024,688 / norpc 1,368,270 / signed 1,385,966 B + verify 证书链/profile + 构建/签名/验签/静态/测试日志齐全；signed SHA-256 `7C38C95D…AD5372` 与 `RELEASE.md` 一致 |
| 回滚包 | video-fps 1.0.10 `B5EC606E…F2B714`（1,385,966 B）仍在原位 |
| `.hvigor/`（说明） | 保留为工程既有、`.gitignore` 已忽略的 hvigor 缓存/报告目录（23 文件，约 6 MB）；不含源码/HAP/密钥，如需“零缓存”可删除，不影响构建 |

> 本轮未改动旧 northbound 归档（Lead 裁决）与 experiments 活树（快照后只读）。
