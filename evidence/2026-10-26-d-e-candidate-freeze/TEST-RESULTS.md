# TEST-RESULTS — D/E 组合候选最终测试记录

- 日期：2026-10-26（Asia/Shanghai）
- 环境：Windows / Node.js **v24.19.0** / npm **11.17.0** / Python 3.14.8
- DevEco：`D:\DevEcoStudio\DevEco Studio`（hvigor `tools\hvigor\hvigor\bin\hvigor.js`，
  TypeScript `tools\hvigor\hvigor\node_modules\typescript\bin\tsc`，
  `DEVECO_SDK_HOME=D:\DevEcoStudio\DevEco Studio\sdk`，`JAVA_HOME=D:\DevEcoStudio\DevEco Studio\jbr`）
- 隔离纪律：所有测试只用**系统临时目录**、`127.0.0.1` **随机端口**、进程内随机生成的
  tokenSecret/ingestKey/口令和明确标记的 `isolated-fixture-*` fixture；**不连接生产数据文件、
  不访问公网、不发布生产 MQTT/HTTP ingest、不制造 SOS/FALL、不 ACK/reset 任何既有告警**。
- 原始日志目录：`backend/logs/`、`app/logs/`、`app/runtime/`

## 0. 本次运行前 vs 本次运行后（必须一起看）

| 项 | 接手时（本次修复前） | 现在（最终源码） |
| --- | --- | --- |
| 后端全量 `npm test` | **不退出**（挂死 >4 min），用 `--test-force-exit` 强制退出后为 286 tests / 283 pass / **3 fail** | **退出码 0，287 tests / 287 pass / 0 fail**，约 1.7 s 自然退出 |
| `test/activity-api.test.js` | 9 pass / **3 fail** | **12 pass / 0 fail** |
| `test/app-contract.test.js` | pass（但守卫的是旧合同 1.0.0） | pass（守卫合同 **1.2.0** + 4 个新端点 + 3 组枚举） |
| APP 主机侧 / Hypium / HAP | 291 / 39 / BUILD SUCCESSFUL | 291 / 39 / BUILD SUCCESSFUL（APP 源码改动后重跑） |

修复动机与根因见 `REPORT.md` §4.1（测试缺陷）与 §4.3/§4.4（产品缺陷）。

## 1. 后端

### 1.1 语法检查

```powershell
Set-Location '<WORKSPACE>\competition\cloud\backend'
npm run check
```

- **exit code: 0**
- 覆盖 14 个 `node --check`：`auth.js`、`household-auth.js`、`store.js`、`persistent-store.js`、
  `safety-log.js`、`activity.js`、`activity-store.js`、`evidence-store.js`、`server.js`、`main.js`、
  `notify-privacy.js`、`notify-provider.js`、`notify-delivery.js`、`comms-core.js`
- 日志：`backend/logs/npm-check.log`

### 1.2 全量测试

```powershell
Set-Location '<WORKSPACE>\competition\cloud\backend'
npm test          # = node --test（默认按文件隔离）
```

```text
ℹ tests 287
ℹ suites 0
ℹ pass 287
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1720.2523
[npm test exit: 0]
```

- **exit code: 0**，进程**自然退出**（不再需要 `--test-force-exit`）
- 日志：`backend/logs/npm-test.log`（另存 `npm-test-full.log` / `.err`）
- 计数自洽：基线 215 + D 38 + E 34 = **287**

### 1.3 D 类定向测试

```powershell
node --test test/safety-log.test.js test/safety-log-api.test.js `
            test/safety-log-persistent.test.js test/safety-log-isolated.integration.js
```

| 文件 | tests | pass | fail |
| --- | ---: | ---: | ---: |
| `safety-log.test.js` | 14 | 14 | 0 |
| `safety-log-api.test.js` | 14 | 14 | 0 |
| `safety-log-persistent.test.js` | 9 | 9 | 0 |
| `safety-log-isolated.integration.js` | 1 | 1 | 0 |
| **合计** | **38** | **38** | **0** |

- **exit code: 0**；日志：`backend/logs/d-targeted.log`

### 1.4 D 类隔离集成（临时数据文件 + 127.0.0.1 随机端口 + 重启）

```powershell
node --test test/safety-log-isolated.integration.js
```

```text
[isolated] endpoints=3 dispositions=2 safetyLogs=2 ackCommands=1 schema=6 restart=ok
✔ isolated backend: dispositions persist across restart and never produce ACK commands
ℹ tests 1 / pass 1 / fail 0
[isolated exit: 0]
```

- 证明了：3 个新接口真实可用、处置记录跨重启仍在、**处置不产生任何 ACK 命令**（`ackCommands=1`
  只来自既有 ACK 路径）、主快照 `schema=6`
- 日志：`backend/logs/d-isolated.log`

### 1.5 E 类单元/接口测试

```powershell
node --test test/activity.test.js
node --test test/activity-api.test.js
```

| 文件 | tests | pass | fail | 说明 |
| --- | ---: | ---: | ---: | --- |
| `activity.test.js` | 22 | 22 | 0 | 原 21，本任务新增 1 条覆盖率诚实性测试 |
| `activity-api.test.js` | 12 | 12 | 0 | 修复前 9/12 |
| **合计** | **34** | **34** | **0** | |

覆盖点（文件内 `test(...)` 名称可复核）：家庭时区切日切小时、首次样本只建基线、重复累计值不重复计数、
计数回退/设备重启、跨日滚动、hourly 不回填、无 PIR 不补 0、非法样本、长断连只降覆盖率、
覆盖率阈值、400 天保留、趋势/对比不用 0 代替缺失、损坏文件 fail-closed、首次记录 0600 原子写、
写失败回滚、`dataSince` 保持 null；接口层 Bearer/403/400、真实 HTTP 摄入→报告、null 不显示 0、
week/month 显式范围、写失败仍 202、未注入存储 503、活动持久化独立于主快照并可跨重启、
运行时接线与时区 fail-closed、day 范围只汇总当天。

### 1.6 E+D 独立隔离验证（Lead 自写脚本，本任务新增的独立证据）

```powershell
$env:ISOLATED_E_OUT='...\backend\ISOLATED-E-VERIFY.json'
node backend/E-ISOLATED-VERIFICATION.js
```

```text
[isolated-d-e] checks=39 passed=39 failed=0
[isolated-d-e] monthRange={"from":"2026-09-27","to":"2026-10-26","days":30}
[isolated-d-e] weekRange={"from":"2026-10-20","to":"2026-10-26","days":7}
[isolated-d-e] activityFile keys=version,savedAt,activity version=1 mainSchema=6
[isolated-d-e] dataSinceType=number dataSinceMs=false dataSinceText=false
[isolated-d-e] ISOLATED_PASS
```

- **39/39 PASS，exit 0**；结构化结果 `backend/ISOLATED-E-VERIFY.json`，日志 `backend/logs/isolated-e.log`
- 该脚本自己创建 `PersistentStore + ActivityStore + createApiServer`，用真实 `/internal/v1/device-status`
  摄入合成 fixture，然后通过真实 HTTP 查询报告；覆盖：
  E1 字段清单与 `dataSince` 类型、E2 日/周/月窗口与 `previous`、E3 基线/重复/回退、
  E4 无 PIR 设备 `null`、E5 不足历史不给趋势、E6 活动文件 `version=1` 且主快照 v6 无 activity、
  E7 重启恢复 / 写盘失败仍 202 且回滚 / 损坏文件 fail-closed、
  D1 处置不生成命令不变更告警、D2 客户端伪造身份/时间 400、D3 201/200/409、D4 台账查询、D5 重启可查。

## 2. APP

### 2.1 core TypeScript 编译（真实源码）

```powershell
node "D:\DevEcoStudio\DevEco Studio\tools\hvigor\hvigor\node_modules\typescript\bin\tsc" `
  -p "<WORKSPACE>\APP\ElderlyCareGuardian\tests\tsconfig.json"
```

- **exit code: 0**，无诊断输出；日志：`app/logs/tsc-core.log`

### 2.2 主机侧 Node 测试（19 个文件）

```powershell
Set-Location '<WORKSPACE>\APP\ElderlyCareGuardian\tests'
node --test --test-isolation=none          # 整目录一次；也可逐文件 node <file>
```

| 文件 | tests | pass | fail | 归属 |
| --- | ---: | ---: | ---: | --- |
| `ack-state.test.mjs` | 6 | 6 | 0 | P0 既有 ACK |
| `activity-report.test.mjs` | 50 | 50 | 0 | **E** |
| `api-client.test.mjs` | 23 | 23 | 0 | 基线 + D/E 增量 |
| `capability.test.mjs` | 11 | 11 | 0 | 基线 |
| `contracts.test.mjs` | 14 | 14 | 0 | 基线 |
| `defect-poller.test.mjs` | 6 | 6 | 0 | 基线 |
| `defect-restore.test.mjs` | 12 | 12 | 0 | 离线保留读数 |
| `defect-restore-expiry.test.mjs` | 10 | 10 | 0 | 离线过期 |
| `defect-sensor.test.mjs` | 12 | 12 | 0 | 传感器真实值 |
| `defect-session.test.mjs` | 9 | 9 | 0 | 会话切换 |
| `defect-static.test.mjs` | 6 | 6 | 0 | 静态守卫 |
| `demo-mode.test.mjs` | 7 | 7 | 0 | 演示模式拦截 |
| `disposition.test.mjs` | 22 | 22 | 0 | **D** |
| `evidence.test.mjs` | 30 | 30 | 0 | **CAMERA-A** |
| `home-metrics.test.mjs` | 6 | 6 | 0 | 基线 |
| `poller.test.mjs` | 5 | 5 | 0 | P0 自动刷新 |
| `session.test.mjs` | 7 | 7 | 0 | 会话 |
| `static-guard.test.mjs` | 30 | 30 | 0 | 硬约束守卫 |
| `view-mapper.test.mjs` | 25 | 25 | 0 | 视图映射（含 P0 自动刷新键） |
| **合计（19 文件）** | **291** | **291** | **0** | |

- **exit code: 0**，`cancelled 0`、`skipped 0`，无测试被跳过或注释掉
- 日志：`app/logs/node-tests-full.log`

### 2.3 Hypium 平台单元测试（DevEco 本地单元测试）

```powershell
$env:DEVECO_SDK_HOME='D:\DevEcoStudio\DevEco Studio\sdk'
$env:JAVA_HOME='D:\DevEcoStudio\DevEco Studio\jbr'
Set-Location '<WORKSPACE>\APP\ElderlyCareGuardian'
node "<hvigor.js>" test --mode module -p product=default -p module=entry@default --no-daemon
```

```text
BUILD SUCCESSFUL in 9 s 172 ms
[exit: 0]
Tests run: 39, Failure: 0, Error: 0, Pass: 39, Ignore: 0
```

- 39 条 = `localUnitTest` 1 + `validContractViewMapper` 20 + `dispositionDtoParsing` 11 + `dispositionApiClient` 7
- 逐条 Success 列表：`app/runtime/UNIT-TEST-RESULT.txt`；日志：`app/logs/hvigor-test.log`
- **E 没有 Hypium 用例**（如实记录；E 的覆盖在 2.2 的 `activity-report` 50 条与后端 34 条里）

### 2.4 ArkTS / HAP 平台构建

```powershell
node "<hvigor.js>" assembleHap --mode module -p product=default -p buildMode=debug --no-daemon
```

```text
BUILD SUCCESSFUL in 10 s 471 ms
33 tasks in total: 27 executed, 6 up-to-date
WARN: Will skip sign 'hos_hap'. No signingConfigs profile is configured in current project.
[exit: 0]
```

- 产物：`APP/ElderlyCareGuardian/entry/build/default/outputs/default/entry-default-unsigned.hap`
- 2,621,844 B，SHA-256 `7634A0E25FCE3E19FC9604E4CD94D6D6BAFF36CB5DE67C92DAEE0E50C1452EB5`
- 签名状态：**unsigned**（工程未配置 `signingConfigs`）；**未安装**
- 日志：`app/logs/hvigor-assembleHap.log`

## 3. 与旧报告计数的对账（不拼接、不混用）

| 旧声明 | 本次实算 | 结论 |
| --- | --- | --- |
| D 报告：backend 274/274 | 287/287 | 旧数字是当时的树；E 的测试文件之后又定稿过，故不相等。**只采用 287** |
| D 报告：D 定向 37/37 | **38/38** | 不矛盾：旧报告的 `node --test test/safety-log*.test.js` 匹配 3 个 `*.test.js`（14+14+9=37），**不含** `*.integration.js`；本次把隔离集成一起跑，故为 38 |
| D 报告：APP Node 241/241 | **291/291** | 241 = 291 − 50（`activity-report.test.mjs`）；两个数字都真，含义不同 |
| D 报告：Hypium 39/39 | **39/39** | 一致 |
| E 证据：activity-report 50/50、APP 全量 291/291 | **50/50、291/291** | 一致（E 的全量数字恰好就是当前全量） |
| `D-E-SCOPE-SPLIT.md`：E 后端零测试 | 22 + 12 条 | 该文件是早期快照，已过时 |
| `backend-audit`（本轮修复前）：286/283 pass/3 fail、`npm test` 不退出 | 287/287 pass、exit 0 | 3 条失败与挂死均已修复（`REPORT.md` §4.1） |

## 4. 测试完整性说明（防“删断言造通过”）

- 后端：本次只改了 3 个测试文件，**没有删除任何断言**；`activity-api.test.js` 的
  `daysWithData` 由 0 改为 2 是**纠正错误期望**，同处新增了 `summary.total` 断言；
  合同用例的断言数量与强度都增加了（固定时钟、显式范围、汇总一致性）；
  `app-contract.test.js` 的端点清单从 10 个扩到 14 个、枚举从 2 组扩到 5 组。
- APP：只改 1 个测试文件 `activity-report.test.mjs`，改的是 3 处被错误文案锁定的期望值，
  **测试条数仍是 50，断言未删减**。
- 运行输出 `skipped 0 / cancelled 0`，源码中无 `test.skip`/`xit`/`todo`。
- 已核对（见 `_work/app-audit.md` §6）：D/E 新增测试确实执行被测代码并断言行为，
  没有吞错或恒真断言；2 处静态守卫偏脆/偏弱已作为 NOTE 记录（未造成假通过）。

## 5. 未能执行的检查（如实记录）

| 检查 | 状态 | 原因 |
| --- | --- | --- |
| 真机/模拟器安装与运行态 | **NOT RUN** | 未签名、无设备操作授权；本任务禁止安装/连接设备 |
| 公网 backend 联调 | **NOT RUN** | 本任务禁止部署；生产仍是旧版本 |
| 真实 PIR 数据日/周/月累积 | **NOT RUN** | 需现场自然数据，不能用测试数据伪造 |
| CAMERA-A 真实告警 JPEG 验收 | **NOT RUN** | 缺会话/公网路由部署/真实 FALL 与绑定图 |
| 冷启动一键链路 | **NOT RUN** | 属另一任务（PC 冷启动真实验收） |
