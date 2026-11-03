# 监护人 APP — D/E-only unsigned 构建（2026-10-26）

```text
状态：BUILT / UNSIGNED / NOT_INSTALLED / NOT_DEPLOYED / 仅隔离目录构建
构建窗口：2026-10-26 23:46 — 23:58 Asia/Shanghai（日志见 _work/app-build/logs/）
```

本目录是 **CAMERA-A（告警证据 JPEG）已剥离、仅保留 D（处置结果 + 安全日志）与 E（活动报告）**
的监护人 APP 候选制品，**未签名、未安装、未部署**。所有改动只发生在隔离副本
`_work/app-build/d-e-only/` 中，工作区生产基线 `<WORKSPACE>\APP` 未被修改。

---

## 1. 交付制品

| 项 | 值 |
| --- | --- |
| 文件 | `guardian-d-e-only-2026-10-26-unsigned.hap` |
| 大小 | **2,552,182 字节** |
| SHA-256 | **`95A7D01A8013C3747F84D0691B7B8DE726F57EE0971CC28ADD28622AD2CD08A4`** |
| bundleName | `com.example.program_04` |
| versionCode | **1000001**（归档源 1000000，+1 以支持覆盖更新） |
| versionName | **1.0.1**（归档源 1.0.0；选择理由见 §6） |
| buildMode | `debug`（归档 VERSIONS.json 指定命令即 debug；`signingConfigs: []`，hvigor 输出 `Will skip sign 'hos_hap'`） |
| 签名 | **无**（HAP 内无签名块/META-INF；构建日志明确 skip sign） |
| compileSdkVersion | `26.0.0.105`（`buildMode=debug`，`targetAPI 26`，`compatible 5.0.4(16)`） |
| HAP 条目数 | 20（`module.json`、`ets/modules.abc`、`sourceMaps.map`、资源等；无测试文件、无证据资源） |

同目录附带：

| 文件 | 说明 | SHA-256 |
| --- | --- | --- |
| `README.md` | 本文件 | — |
| `CAMERA-A-STRIP.md` | 剥离触点清单（文件:行 + 原因 + 保留判定 + 耦合结论） | — |
| `ISOLATION-DIFF.md` | 相对归档源的文件级增删改清单（0 新增 / 2 删除 / 11 修改） | — |
| `TEST-RESULTS.md` | 构建与测试结果、HAP 内部验证、可复现性对照 | — |
| `isolation-diff.patch` | 11 个修改文件的统一 diff（相对归档源） | `9D5C1D92833EC8A1E2F626F4680F11E4B752864242F2AFD22C923C47F6B48DC7` |
| `UNIT-TEST-RESULT-hypium.txt` | Hypium 单测原始结果（39 pass） | `0BCFDAF2B996D0FD4AFC3890C2DEEBF15D73CEC802F6FE11D15AD170FE15743A` |
| `SHA256SUMS.txt` | 本目录制品与附件哈希 | — |

---

## 2. 输入来源（未重新下载/重新解压）

| 输入 | 路径 | 说明 |
| --- | --- | --- |
| 源码归档（zip） | `competition/evidence/2026-10-26-d-e-release-prep/d-e-candidate-source-2026-10-26.zip` | 3,954,792 B，SHA-256 `F82DA47444785CFB29C254F435DAB40F1569041763BBEEF10D7F5C235A908526`（与任务给定前缀 F82DA474…8526 一致） |
| 已解压隔离源码 | `competition/evidence/2026-10-26-d-e-production-release/_work/src/d-e-candidate-source-2026-10-26/` | 归档自校验 187/187 由前置环节完成；本轮再次验证：其 `APP/ElderlyCareGuardian` 123 个文件与 `_work/app-build/baseline` **逐文件 SHA-256 完全一致** |
| 冻结候选 HAP（对照） | 归档内 `candidate/guardian-d-e-candidate-2026-10-26-unsigned.hap` | 2,621,844 B，SHA-256 `7634A0E25FCE3E19FC9604E4CD94D6D6BAFF36CB5DE67C92DAEE0E50C1452EB5` |
| 未改动 baseline 重建 HAP（对照） | `_work/app-build/baseline/entry/build/default/outputs/default/entry-default-unsigned.hap` | 2,621,844 B，SHA-256 `A052FE1DAE51A10327AF9E0E9DF15338CA7D4084B15FF0F9AC611994553BC488` |

> baseline 重建 HAP 与冻结候选 **同大小**，且 20 个条目中 19 个逐字节一致；仅 `ets/sourceMaps.map`
> 的 JSON key 顺序不同（长度相同 592,958 B，映射内容相同）。说明本机隔离环境可复现冻结候选的
> 打包结果（除时间戳/键序），见 `TEST-RESULTS.md` §4。

---

## 3. 构建环境（实际使用，全部为归档 VERSIONS.json 所列版本）

| 项 | 值 |
| --- | --- |
| Node.js | v24.19.0（`D:\Node\node.exe`） |
| ohpm | 26.0.0.630（`D:\DevEcoStudio\DevEco Studio\tools\ohpm\bin\ohpm.bat`） |
| DevEco Studio | `D:\DevEcoStudio\DevEco Studio` |
| DEVECO_SDK_HOME | `D:\DevEcoStudio\DevEco Studio\sdk` |
| JAVA_HOME | `D:\DevEcoStudio\DevEco Studio\jbr` |
| hvigor 入口 | **`D:\DevEcoStudio\DevEco Studio\tools\hvigor\bin\hvigorw.bat`**（wrapper，自动安装 pnpm → hvigor 插件） |
| HVIGOR_USER_HOME | `_work/app-build/.hvigor-user`（隔离，插件装到 `project_caches/<hash>/workspace/node_modules`） |
| TypeScript（主机测试用） | `D:\DevEcoStudio\DevEco Studio\tools\hvigor\hvigor\node_modules\typescript`（4.9.5） |

**重要环境事实（与归档 VERSIONS.json 的差异）**：VERSIONS.json 的 `build_command` 只写
`node <hvigor.js> assembleHap ...`。在隔离目录里直接执行该命令会失败：
`Failed to load or execute hvigorfile.ts: Cannot find module '@ohos/hvigor-ohos-plugin'`
（失败日志：`_work/app-build/logs/01-attempt-node-hvigorjs-FAILED.log`，exit 1）。
本项目 `hvigor/hvigor-config.json5` 的 dependencies 为空、工程内无 `hvigorw`/`hvigor-wrapper.js`，
必须用 DevEco 自带 **`hvigorw.bat`** 由 wrapper 解析/安装插件（`HVIGOR_USER_HOME` 指到隔离目录）。
用该入口后 baseline 重建成功且与冻结候选 payload 等价（§2）。建议在发布文档中更正构建命令。

---

## 4. 构建与测试结果（摘要，详见 `TEST-RESULTS.md`）

| 步骤 | 结果 |
| --- | --- |
| 1) 未改动源码 baseline `assembleHap`（unsigned） | **BUILD SUCCESSFUL**（34 tasks，exit 0；`skip sign 'hos_hap'`） |
| 2) 生成 D/E-only 变体（可复现脚本 `_work/app-build/scripts/strip-camera-a.mjs`） | exit 0；断言全部命中（0 新增 / 2 删除 / 11 修改） |
| 3) D/E-only `assembleHap`（unsigned） | **BUILD SUCCESSFUL**（34 tasks，exit 0；`skip sign 'hos_hap'`） |
| 4) 主机侧 Node 测试（baseline，对照） | `tsc` exit 0；**291 tests / 291 pass / 0 fail** |
| 5) 主机侧 Node 测试（D/E-only） | `tsc` exit 0；**261 tests / 261 pass / 0 fail**（差值 30 = 整文件删除的 `tests/evidence.test.mjs`） |
| 6) Hypium 平台单测（D/E-only） | **BUILD SUCCESSFUL / exit 0**；`Tests run: 39, Failure: 0, Error: 0, Pass: 39, Ignore: 0` |
| 7) HAP 内部验证 | `pack.info`：versionCode=1000001 / versionName=1.0.1；abc 中无 `EvidenceCore`/`loadEvidence`/`evidence/content`/`image/jpeg`/`camera_fill`；D/E 文案与页面符号存在 |

> 主机侧测试使用 `tests/fake-transport.mjs` 的 SIMULATED 响应，证明 APP 侧逻辑，不等于真实公网/真机验收。

---

## 5. 剥离与保留边界

- **已剥离（CAMERA-A 告警证据 JPEG 链路）**：证据下载 API 调用与路径、JPEG 校验/大小上限/取消、
  内存缓存、AlertView 证据字段、列表相机标记、详情页证据面板与解码展示、相关测试。
  触点与行号见 `CAMERA-A-STRIP.md`。
- **未改动（必须保留）**：D 的处置结果面板（`dispositionPanel`）、安全日志/时间线（`timelineCard` 与
  LogPage/D 安全日志页签）、ACK 流程；E 的活动报告（`ActivityReport.*`、`ActivityReportPage`）。
  `AlertDetailPage` 仅删除证据相关段落，处置/ACK/时间线代码原样保留。
- **有意保留（非功能链路）**：
  1. `core/api/Contracts.ts` 的 `AlertEvidenceDto` 与 evidence 元数据解析（合同 v1 容错层，不发请求/
     不解码/不展示；删除会改动 API 合同层且无收益）；
  2. `core/api/HttpHeaders.ts`（通用 header 工具；`headerValue` 仍用于 Retry-After）；
  3. `HttpRawResponse.cancelled/cancelledRequest`（通用网络失败语义；已无生产者）。
- **已知文案残留（未改，待 Lead 决策）**：`entry/src/main/ets/core/capability/DeviceCapabilities.ts`
  第 164/166/167 行（归档源行号）的能力说明仍提到“FALL 告警证据可用性 / 仅本地取帧/证据 / 证据元数据
  可上报”。这是**设备能力矩阵文案**，不是证据图片功能链路；若需彻底一致，可把 164 行
  “FALL 告警证据可用性”改为“FALL 告警状态”（1 行文案改动，不影响 D/E 与测试断言的其余匹配项）。

**耦合结论：不存在无法安全剥离的硬冲突。** 唯一强引用关系（`AlertView.evidence*` ←
`ViewMapper`/`AlertItem`/`AlertDetailPage`）已同步清理并通过编译与两套测试；契约层 evidence 元数据与
证据图片链路解耦，保留不影响 D/E。

---

## 6. 版本号选择理由

- `versionCode` 1000000 → **1000001**：设备端覆盖更新的硬性要求（同 bundleName 覆盖安装需更大 versionCode）。
- `versionName` 1.0.0 → **1.0.1**：同日存在“含 CAMERA-A 的 1.0.0 候选包”，本制品内容不同（剥离证据链路），
  用 1.0.1 可在设备/日志中明确区分两者；versionName 不参与安装兼容判断，风险为零。

---

## 7. 明确未做 / 边界

- 未签名、未 `hdc install/uninstall`、未部署后端、未停止/重启 bridge/broker/public-sync。
- 未修改 `<WORKSPACE>\APP`（并行会话生产基线）；所有写操作限于
  `_work/app-build/`、`_work/app-build/.hvigor-user/` 与本 `app/` 目录。
- 未验证真机安装/启动与真实公网后端；未做 UI 截图验收。
- HAP 为 `buildMode=debug` 的 unsigned 包，供后续签名/验收环节使用；签名身份与覆盖更新可行性由并行
  任务 `baseline/SIGNING-IDENTITY.md` 结论决定。

---

## 8. 复现方式（最小步骤）

```powershell
$env:DEVECO_SDK_HOME='D:\DevEcoStudio\DevEco Studio\sdk'
$env:JAVA_HOME='D:\DevEcoStudio\DevEco Studio\jbr'
$env:HVIGOR_USER_HOME='<WORKSPACE>\competition\evidence\2026-10-26-d-e-production-release\_work\app-build\.hvigor-user'
cd '<WORKSPACE>\competition\evidence\2026-10-26-d-e-production-release\_work\app-build\d-e-only'
& 'D:\DevEcoStudio\DevEco Studio\tools\ohpm\bin\ohpm.bat' install --all
& 'D:\DevEcoStudio\DevEco Studio\tools\hvigor\bin\hvigorw.bat' assembleHap --mode module -p product=default -p buildMode=debug --no-daemon
# 变体本身的再生成：node ..\scripts\strip-camera-a.mjs（从 baseline 重建 d-e-only）
```

完整决策记录与日志索引见 `_work/app-build/VARIANT-NOTES.md`。
