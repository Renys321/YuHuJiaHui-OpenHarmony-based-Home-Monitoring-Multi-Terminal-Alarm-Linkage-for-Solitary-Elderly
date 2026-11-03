# 构建与测试结果 — D/E-only unsigned APP（2026-10-26）

环境：Windows / Node.js v24.19.0 / DevEco Studio `D:\DevEcoStudio\DevEco Studio` /
ohpm 26.0.0.630 / hvigor wrapper 10.28.2 / TypeScript 4.9.5（DevEco 自带）。
构建窗口：2026-10-26 23:46 — 23:58 Asia/Shanghai。所有日志：`_work/app-build/logs/`。

---

## 1. 构建环境确认（含归档 VERSIONS.json 命令的修正）

| 步骤 | 命令 | 结果 |
| --- | --- | --- |
| 依赖安装（隔离副本） | `ohpm install --all` | exit 0；`@ohos/hypium@1.0.25`、`@ohos/hamock@1.0.0`（来自本机 ohpm 缓存） |
| 归档 VERSIONS.json 的构建命令（直接 `node hvigor.js`） | `node "D:\DevEcoStudio\DevEco Studio\tools\hvigor\hvigor\bin\hvigor.js" assembleHap ... --no-daemon` | **FAIL（exit 1）**：`Failed to load or execute hvigorfile.ts: Cannot find module '@ohos/hvigor-ohos-plugin'`。原因：工程无 `hvigorw`、`hvigor/hvigor-config.json5` dependencies 为空，直接入口不能解析/安装插件。日志：`01-attempt-node-hvigorjs-FAILED.log` |
| 实际可用构建入口（DevEco 自带 wrapper） | `& "D:\DevEcoStudio\DevEco Studio\tools\hvigor\bin\hvigorw.bat" assembleHap --mode module -p product=default -p buildMode=debug --no-daemon` | exit 0（wrapper 安装 pnpm 并把 hvigor-ohos-plugin 装到隔离 `HVIGOR_USER_HOME`） |

> 环境变量（两次成功构建均使用）：
> `DEVECO_SDK_HOME=D:\DevEcoStudio\DevEco Studio\sdk`、
> `JAVA_HOME=D:\DevEcoStudio\DevEco Studio\jbr`、
> `HVIGOR_USER_HOME=_work/app-build/.hvigor-user`（隔离，避免污染用户目录/工作区）。
> **发布文档应把 VERSIONS.json 的 build_command 更正为 hvigorw.bat 路线。**

---

## 2. baseline（未改动源码）unsigned 构建 —— 环境确认

- 工程：`_work/app-build/baseline/`（= 归档 APP 源，123 文件逐文件 SHA-256 一致）
- 命令：见 §1 第三行；日志 `02-build-baseline-hvigorw.log`
- 结果：**BUILD SUCCESSFUL in 43 s / 34 tasks，exit 0**；
  `hvigor WARN: Will skip sign 'hos_hap'. No signingConfigs profile is configured in this project.`（即 unsigned）
- 产物：`baseline/entry/build/default/outputs/default/entry-default-unsigned.hap`
  - 大小 **2,621,844 B**，SHA-256 **`A052FE1DAE51A10327AF9E0E9DF15338CA7D4084B15FF0F9AC611994553BC488`**
- 与归档冻结候选 HAP（2,621,844 B / `7634A0E2…1452EB5`）对比：
  - 20 个 HAP 条目中 **19 个逐字节一致**；
  - 仅 `ets/sourceMaps.map` 不同：长度相同（592,958 B）、代码映射内容相同，差异仅为 JSON key 顺序；
  - 结论：本机隔离环境可复现冻结候选的打包结果（时间戳/键序导致包级哈希不同）。

---

## 3. D/E-only 构建（final）

- 工程：`_work/app-build/d-e-only/`（由 `scripts/strip-camera-a.mjs` 从 baseline 生成，0 新增/2 删除/11 修改）
- 命令：同 §1 第三行；日志 `11-build-de-only-unsigned.log`
- 结果：**BUILD SUCCESSFUL in 30 s / 34 tasks，exit 0**；`skip sign 'hos_hap'`（unsigned）
- 产物：`d-e-only/entry/build/default/outputs/default/entry-default-unsigned.hap`
  → 已复制为 **`app/guardian-d-e-only-2026-10-26-unsigned.hap`**
  - 大小 **2,552,182 B**（比 baseline 少 **69,662 B**，-2.66%）
  - SHA-256 **`95A7D01A8013C3747F84D0691B7B8DE726F57EE0971CC28ADD28622AD2CD08A4`**
- ArkTS 编译告警：仅既有 `deprecated/可能抛异常` 类 WARN（与 baseline 同类、无新增 ERROR；见日志）。

---

## 4. 测试结果

### 4.1 主机侧 Node 行为测试（APP core 纯逻辑，`node --test`）

| 对象 | 编译（tsc 4.9.5） | 用例 | 结果 | 日志 |
| --- | --- | --- | --- | --- |
| baseline（对照） | `tsc -p tests/tsconfig.json` exit 0 | **291** | **291 pass / 0 fail / 0 skip** | `08-baseline-host-tests-tsc.log`、`09-baseline-host-tests-node.log` |
| **D/E-only** | exit 0 | **261** | **261 pass / 0 fail / 0 skip** | `06-host-tests-tsc.log`、`07-host-tests-node.log` |

- 命令：`node "<DevEco>/tools/hvigor/hvigor/node_modules/typescript/bin/tsc" -p tests/tsconfig.json`，
  然后 `cd tests && node --test --test-isolation=none`。
- 用例数差 30 = 整文件删除的 `tests/evidence.test.mjs` 的 30 个证据用例（**不是放宽/删除既有 D/E 断言**）。
- 覆盖范围：api-client / contracts / capability / view-mapper / ack-state / disposition（D）/ activity-report（E）/
  session / poller / static-guard / defect-* 等；其中 `disposition.test.mjs`、`activity-report.test.mjs`、
  `ack-state.test.mjs` 全部通过 → D/E 未回归。

### 4.2 Hypium 平台单测

- 命令：`& "<DevEco>/tools/hvigor/bin/hvigorw.bat" test --mode module -p product=default -p module=entry@default --no-daemon`
- 结果：**BUILD SUCCESSFUL in 19 s 918 ms，exit 0**
- 用例：**Tests run: 39, Failure: 0, Error: 0, Pass: 39, Ignore: 0**（原始结果 `app/UNIT-TEST-RESULT-hypium.txt`；
  hvigor 内部路径 `entry/.test/default/intermediates/test/coverage_data/test_result.txt`；日志 `12-hypium-test-de-only.log`）
- 注：Hypium 用例为平台层本地单测（Disposition/ValidContract 等），未涉及真机/公网。

### 4.3 边界（important）

- 主机侧测试全部使用 `tests/fake-transport.mjs` 的 **SIMULATED** HTTP 响应，只证明 APP 侧逻辑，
  不等于真实公网后端/真机 UI 验收。
- 未执行 `hdc install`、未签名、未部署；未验证真机安装/启动/页面渲染。

---

## 5. 最终 HAP 内部验证（`app/guardian-d-e-only-2026-10-26-unsigned.hap`）

`pack.info`（HAP 内）：

```json
{"summary":{"app":{"bundleName":"com.example.program_04","bundleType":"app",
 "version":{"code":1000001,"name":"1.0.1","build":"1"}}, ...}}
```

HAP 条目：20 个（`module.json`、`ets/modules.abc` 1,318,548 B、`ets/sourceMaps.map`、
`resources.index`、`resources/base/**`、`pack.info`、`pkgContextInfo.json`），**无测试文件、无签名块**。

`ets/modules.abc`（1,318,548 B）字符串扫描：

| 检查项 | 结果 |
| --- | --- |
| `EvidenceCore` / `loadEvidence` / `EvidenceRequestCancellation` / `EvidenceOutcome` | 不存在 |
| `evidenceAvailable` / `evidenceCapturedAt` / `/evidence/content` | 不存在 |
| `image/jpeg` / `camera_fill` | 不存在 |
| 证据 UI 文案 `证据加载` / `查看证据` / `拍摄时间` | 不存在 |
| D/E 保留：`活动报告` / `处置结果` / `安全日志` / `ActivityReportPage` / `dispositionPanel` / `timelineCard` | 均存在 |
| 合同层保留：`AlertEvidenceDto` / `evidenceId`（Contracts.ts，仅 DTO 解析） | 存在（有意） |
| 能力文案残留：`告警证据`（DeviceCapabilities.ts 文案） | 存在（已知，见 `CAMERA-A-STRIP.md` §6） |

---

## 6. 复现命令汇总

```powershell
# 0) 变体再生成（可选；从 baseline 重建 d-e-only）
node <WORKSPACE>\competition\evidence\2026-10-26-d-e-production-release\_work\app-build\scripts\strip-camera-a.mjs

# 1) 依赖（隔离副本内）
cd <WORKSPACE>\competition\evidence\2026-10-26-d-e-production-release\_work\app-build\d-e-only
& 'D:\DevEcoStudio\DevEco Studio\tools\ohpm\bin\ohpm.bat' install --all

# 2) 主机侧测试
$tsc='D:\DevEcoStudio\DevEco Studio\tools\hvigor\hvigor\node_modules\typescript\bin\tsc'
node $tsc -p tests\tsconfig.json
cd tests; node --test --test-isolation=none

# 3) 平台单测 + 构建（env 见 §1）
$env:DEVECO_SDK_HOME='D:\DevEcoStudio\DevEco Studio\sdk'
$env:JAVA_HOME='D:\DevEcoStudio\DevEco Studio\jbr'
$env:HVIGOR_USER_HOME='<WORKSPACE>\competition\evidence\2026-10-26-d-e-production-release\_work\app-build\.hvigor-user'
cd <WORKSPACE>\competition\evidence\2026-10-26-d-e-production-release\_work\app-build\d-e-only
& 'D:\DevEcoStudio\DevEco Studio\tools\hvigor\bin\hvigorw.bat' test --mode module -p product=default -p module=entry@default --no-daemon
& 'D:\DevEcoStudio\DevEco Studio\tools\hvigor\bin\hvigorw.bat' assembleHap --mode module -p product=default -p buildMode=debug --no-daemon
```
