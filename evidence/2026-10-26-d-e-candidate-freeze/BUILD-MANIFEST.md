# BUILD-MANIFEST — D/E 组合候选 HAP

- 日期：2026-10-26（Asia/Shanghai）
- 结论：**本地构建通过 + 内容已核验；未签名、未安装、未真机运行**。

## 1. 候选制品

| 项 | 值 |
| --- | --- |
| 归档路径（交付物） | `competition/evidence/2026-10-26-d-e-candidate-freeze/app/guardian-d-e-candidate-2026-10-26-unsigned.hap` |
| 构建输出路径 | `APP/ElderlyCareGuardian/entry/build/default/outputs/default/entry-default-unsigned.hap` |
| 字节数 | **2,621,844 B** |
| SHA-256 | **`7634A0E25FCE3E19FC9604E4CD94D6D6BAFF36CB5DE67C92DAEE0E50C1452EB5`** |
| 构建时间 | 2026-10-26 12:43:25（+08:00），源码冻结后的最后一次构建 |
| 包名 | `com.example.program_04` |
| versionName / versionCode | `1.0.0` / `1000000`（与最近已验收 P0 包相同，**版本号不能区分内容**） |
| buildMode | `debug` |
| 兼容/目标 API | compatible 16 / target 26；compileSdkVersion `26.0.0.105` |
| 设备形态 | `phone`、`tablet` |
| 签名状态 | **unsigned** —— 工程 `build-profile.json5` 无 `signingConfigs`，hvigor 明确告警 `Will skip sign 'hos_hap'`；HAP 内**没有** `META-INF/`、签名块或证书 |
| 安装状态 | **未安装**（未连接任何设备/模拟器） |
| 归档副本一致性 | 归档文件与构建输出**同哈希**（复制后重算一致） |

Payload 逐条哈希（20 个条目）：`app/HAP-PAYLOAD-HASHES.txt`。

## 2. 构建命令与环境（逐字）

```powershell
$env:DEVECO_SDK_HOME='D:\DevEcoStudio\DevEco Studio\sdk'
$env:JAVA_HOME='D:\DevEcoStudio\DevEco Studio\jbr'
Set-Location '<WORKSPACE>\APP\ElderlyCareGuardian'
node "D:\DevEcoStudio\DevEco Studio\tools\hvigor\hvigor\bin\hvigor.js" `
  assembleHap --mode module -p product=default -p buildMode=debug --no-daemon
# exit code: 0
# BUILD SUCCESSFUL in 10 s 471 ms ; 33 tasks in total: 27 executed, 6 up-to-date
```

日志：`app/logs/hvigor-assembleHap.log`。同级还执行了平台单元测试
（`hvigor test`，39/39，见 `TEST-RESULTS.md` §2.3）。

## 3. 候选实际包含的功能（字节串核验，不是按目录猜）

对 HAP 内 `ets/modules.abc`（1,362,536 B）按 UTF-8 做标识符检索：

| 标识串 | 命中次数 | 归属 |
| --- | ---: | --- |
| `Disposition` | 50 | D |
| `safety-logs` | 3 | D |
| `activity/report` | 1 | E |
| `ActivityReportPage` | 8 | E |
| `EvidenceMemoryCache` | 2 | CAMERA-A |
| `近 30 日活动次数` | 1 | E（**本任务修复后**才有的文案） |
| `未观测到人体传感器` | 1 | E（**本任务修复后**才有的文案） |
| `未配置人体传感器` | **0** | 证明旧文案已不存在 |

`resources/base/profile/main_pages.json` 中也确实注册了
`pages/ActivityReportPage`（与 `LoginPage/Index/AlertDetailPage/LogPage/DevicePage/StatsPage/...` 并列）。
`ets/sourceMaps.map` 中可检索到 `ActivityReportPage.ets`、`ActivityReport.ts`、`AlertDetailPage.ets`、`LogPage.ets`。

因此：**同一个 HAP 同时包含 D + E + CAMERA-A**，且 E 是**修复后**的版本。

## 4. 构建可复现性（如实披露）

- 从**同一份最终源码**连续构建两次，HAP 字节数相同（2,621,844 B），但**SHA-256 不同**：
  `54FF869EBEC00126DE2FF8834658486E71DA1C2C366D05618F316A09DB3662C9`（12:24:14）与
  `7634A0E25FCE3E19FC9604E4CD94D6D6BAFF36CB5DE67C92DAEE0E50C1452EB5`（12:43:25）。
- 解包逐条比对：**20 个 payload 条目全部逐字节相同**，唯一差异是 ZIP 条目内的
  “最后写入时间”字段（打包时间戳）。
- 结论：内容可复现（payload 哈希可核验），**字节级不可复现**（打包时间戳）。
  因此候选身份以归档 HAP 的 SHA-256 为准，内容核验以 `app/HAP-PAYLOAD-HASHES.txt` 为准。
  做第二次构建只是为了这条证据，没有替换候选。

## 5. 与其它 HAP 的关系（避免混淆）

| 包 | 字节 | SHA-256 | 内容 | 签名 |
| --- | --- | --- | --- | --- |
| **本候选** | 2,621,844 | `7634A0E2…452EB5` | D + E + CAMERA-A | unsigned / 未安装 |
| D 旧候选 `entry-default-unsigned-2CFB8908.hap` | 2,613,947 | `2CFB890880274AFD946E9C0E87427E2E60FA099DA7F6AD15A1F5899EDEAF91DF` | D + E(**旧**) + CAMERA-A | unsigned / 未安装，**陈旧** |
| CAMERA-A 候选 | 2,156,555 | `15126D26CD790780F90B88D405286F2038B6A61FD166329576D6EFDDB390BC35` | 仅 CAMERA-A | unsigned / 未安装 |
| 最近**已真实验收** P0 APP（回退目标） | 2,086,949 | `9EEBEE9A5FC9EEC5A5993DC6923F16F0BFCCCD1CD4DE64BAF36FC7197ECAD25A` | 仅 P0 | unsigned（历史验收件） |
| 更早回退包（**不是**最新基线） | 2,077,912 | `8A722EB6FDA7BB73EE58F3BDA3D95B5D238401DA8E3CC9179F1286FD5253A985` | 仅 P0 | unsigned |

**没有任何历史 HAP 与当前工作树完全对应**：D 旧候选构建于 2026-10-26 01:59:34，而
`Contracts.ts` 在 02:01:22 又被并行会话改动（`source-snapshot-D-20261026.zip` 记录的是改动后版本）。
本候选是**唯一**由最终源码构建并核验过的包。

## 6. 这个 HAP 不包含 / 不证明什么

- 不包含：远程视频、低帧率预览、WebRTC、正式跌倒检测落库、门磁/电量、独立随身 SOS。
- 不证明：公网后端已升级（生产仍是旧合同、无 D/E 接口）；CAMERA-A 真实验收；隐私/合规复核；
  实体手机兼容性（历史验收目标是 Mate 90 Pro 模拟器）。
- 安装后若公网后端未升级，D/E 相关页面会显示**真实接口错误**，不会伪造数据或显示“已保存”。
