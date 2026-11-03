# D/E 组合候选收拢与本地冻结 — 最终报告（D-E-CANDIDATE-FREEZE）

- 日期：2026-10-26（Asia/Shanghai）
- 工作区：`<WORKSPACE>`（无 Git 元数据，不能依赖 `git checkout/reset` 恢复）
- 任务边界：**只做本地收拢、最小修复、测试/构建复验与候选冻结**。不部署公网、不安装 HAP、
  不连接或重启设备、不打开串口、不烧录、不启动/停止演示服务、不制造生产 SOS/FALL、
  不 ACK/reset 既有告警、不发布生产 MQTT/HTTP ingest。
- 证据目录：`competition/evidence/2026-10-26-d-e-candidate-freeze/`

## 0. 最终分类

```text
LOCAL_CANDIDATE_FROZEN — NOT_DEPLOYED — NOT_INSTALLED — REAL_ACCEPTANCE_NOT_RUN
```

冻结的是**同一份最终源码**对应的后端源码 + APP 源码 + 一个本地构建的未签名 HAP 候选。
“冻结完成”只表示：最终组合源码的本地语法检查、全量测试、D/E 隔离验证、APP 主机侧测试、
Hypium 平台单元测试与 ArkTS/HAP 平台构建**全部真实通过**，且候选与清单完整可复核。
它**不表示**已部署、已安装、已真机验收。

## 1. 基线确认（先读后做）

| 项目 | 结论 |
| --- | --- |
| `competition/docs/evidence/2026-10-26-new-chat-handoff.md` | 已完整阅读（412 行）。复核 39,066 B，SHA-256 `EAF3F827586CFCF841C1AB595884C1E792770A8016DB20701F66204166B93955` |
| 配套回执 `2026-10-26-new-chat-handoff.sha256.txt` | 与实算哈希**一致**（回执值相同），文档字节数 39,066 一致 |
| 交接之后是否还有更新报告 | **没有**。全仓 `competition/evidence`、`competition/docs` 下没有任何文件的 mtime 晚于回执（2026-10-26 02:39:57） |
| 其他会话/构建进程是否仍在写共享文件 | **没有**。接手时相关目录最近一次写入为 02:39:57，距开工约 9.5 小时；进程表只有本会话的 node。共享文件编辑全程没有第二节所述“活动写入”冲突，未发生抢写或强杀 |
| 既有 E 交付物 | `competition/evidence/2026-10-26-activity-reports/` 只有 3 个日志文件 + 一个**空目录** `runtime-smoke/evidence/`，**没有** E 最终报告/清单/候选 HAP/构建日志 —— 与交接判断一致，因此本任务补写 `E-FINAL-REPORT.md`，而不是从零重写功能 |

已按要求阅读 D 类 REPORT/CONTRACT/DEPLOY-DIFF-AND-ROLLBACK/D-E-SCOPE-SPLIT、E 证据目录、
CAMERA-A 加固报告，并核对到 `competition/docs/APP-API-v1.md`、`APP-API-v1.json`、
`competition/cloud/backend` 源码、`APP/ElderlyCareGuardian` 源码与测试。

## 2. 候选实际包含哪些功能（重要）

组合候选 = **D 类 + E 类 + 既有 CAMERA-A 加固**。三者都已编译进同一个 HAP，功能边界不同：

| 功能 | 源码 | 已进入最终 HAP | 证据等级（本任务） |
| --- | --- | --- | --- |
| D：告警处置结果 + 持久安全日志（schema v6） | backend `src/safety-log.js`、`store.js`、`persistent-store.js`、`server.js`；APP `Contracts/ApiClient/Outcomes/GuardianService/Models/ViewMapper`、`AlertDetailPage.ets`、`LogPage.ets` | 是（`safety-logs`、`Disposition` 字节串可在 `modules.abc` 中检索到） | LOCAL TEST / ISOLATED PASS；**未部署、未安装、未真机** |
| E：PIR 活动日/周/月报告（独立 `version=1` 文件） | backend `src/activity.js`、`activity-store.js`、`main.js`、`server.js`；APP `core/activity/ActivityModels.ts`、`core/activity/ActivityReport.ts`、`pages/ActivityReportPage.ets`、`Contracts/ApiClient/GuardianService` 增量 | 是（`ActivityReportPage` 已注册进 `main_pages.json`，`activity/report` 在 `modules.abc` 中） | LOCAL TEST / ISOLATED PASS；**未部署、未安装、未真机** |
| CAMERA-A：告警证据 JPEG（内存 LRU 6 条 / 12 MiB、JPEG 2 MiB、Bearer 仅走请求头） | APP `core/evidence/EvidenceCore.ts`、`AlertDetailPage.ets` 证据面板；backend 既有 `/api/v1/alerts/{alarmId}/evidence/content` | 是（`EvidenceMemoryCache` 可在 `modules.abc` 中检索到） | **既有候选未验收**；本任务只做回归存在性验证，未升级其证据等级 |
| P0 基线（自动刷新、离线保留读数、既有 ACK、会话切换） | APP `MonitorPage/DevicePage` 等 | 是 | 本任务回归通过；**不是**重新真机验收 |

**CAMERA-A 的未验收边界（必须与候选一起声明）**：`CAMERA_A_LOCAL_BUILD_PASS_REAL_ACCEPTANCE_BLOCKED`。
缺真实监护人会话、公网鉴权后路由部署证明、真实 FALL 告警及其精确绑定 JPEG、候选真机安装与手机显示。
本轮只验证了代码存在性与静态约束（证据 UI 门槛、Bearer 只在 `Authorization` 头、2 MiB/SOI-EOI 校验、
LRU 上限、copy-in/out、登出/换账号/401/403 清理、不写文件/相册），**没有**升级为真实验收。

候选版本身份：`com.example.program_04`，`versionName 1.0.0` / `versionCode 1000000`。
与最近已验收 P0 包（9EEBEE）、CAMERA-A 包、D 旧候选**版本号完全相同**，因此**版本号不能区分内容，必须用哈希**。

## 3. 本任务实际改动的文件（最小修复）

改动前已对全部相关文件做本地哈希快照（`_work/PRE-EDIT-SNAPSHOT.txt`，137 个文件）；
下表 6 个 APP/文档文件与本报告 §4.3–§4.4 涉及的 4 个后端文件，共 **10 个**文件的“改前内容”
都用**反向替换 + SHA-256 校验**重建，**10/10 与改前快照逐字节一致**
（`_work/before-after/reconstruction-report.json`、`reconstruction-report-backend.json` 全部 `EXACT`），
因此差异可信、可精确回退。

| # | 文件 | 改前 → 改后 | 修改原因（对应缺陷） |
| --- | --- | --- | --- |
| 1 | `APP/.../core/activity/ActivityReport.ts` | 22,845 → 23,033 B | KPI 文案把滚动 7/30 天窗口写成“本周/本月”，与后端真实窗口不一致（E2） |
| 2 | `APP/.../tests/activity-report.test.mjs` | 33,132 → 33,252 B | 同步修正锁定该错误文案的断言（断言数量不变，未删减） |
| 3 | `APP/.../pages/ActivityReportPage.ets` | 30,839 → 32,025 B | (a) “未配置人体传感器”超出后端证据；(b) 加载中切换范围/日期被丢弃并被旧响应回退 |
| 4 | `competition/docs/APP-API-v1.md` | 10,318 → 16,925 B | 冻结 API 合同**完全没有**记录 E 的活动报告接口；补 §4.2 并修正日窗口/覆盖率口径 |
| 5 | `competition/docs/APP-API-v1.json` | 1,963 → 2,984 B | 机读合同仍停在 1.0.0，缺 D 的 3 个接口与 E 的 1 个接口 |
| 6 | `competition/cloud/backend/README.md` | 20,201 → 23,152 B | 后端运维文档没有 E 的接口/独立文件/失败边界，部署评审无法据此操作 |

后端代码另修 1 个产品缺陷（见 4.3、4.4，`src/activity.js`），并修 2 个测试缺陷
（`test/activity-api.test.js`、`test/app-contract.test.js`）与新增 1 条覆盖率诚实性测试
（`test/activity.test.js`）。全部改动都是局部替换，没有整文件覆盖、没有删除既有断言。

未改动：D 类后端逻辑（`safety-log.js`/`store.js`/`persistent-store.js` 的处置语义）、
`server.js` 的 D/E 路由、APP 的 D 类页面与服务、CAMERA-A 代码、`northbound`（DAYU）工程。
硬性遵守：没有为回退 D 删除 E，也没有为收拢 E 覆盖 D。

## 4. 修复内容与验证（逐条可复核）

### 4.1 E 类测试套件在最终树上原本是**红的**（本任务最重要的发现）

接手复跑发现 `test/activity-api.test.js` **12 条里 3 条失败**，且整个后端测试进程**跑完不退出**。
旧报告没有覆盖到这一点（E 没有最终报告，D 的报告早于 E 的测试文件定稿）。逐条定位：

| 缺陷 | 根因 | 修复 |
| --- | --- | --- |
| `activity persistence ... survives restarts` 失败（after-hook `ERR_SERVER_NOT_RUNNING`） | 该用例先手动 `server.close()` 模拟重启，而 `t.after()` 又关一次；重复关闭抛错后**后续清理钩子不再执行**，第二个 server 的监听句柄泄漏 | `startServer()` 改为返回**幂等** `close()`，`t.after` 与用例都调它；用例改用 `serverOne.close()` |
| 测试进程**永不退出**（`npm test` 挂死 >4 分钟） | 就是上面泄漏的 `Server listening=true` 句柄（用 `process._getActiveHandles()` 直接定位到） | 同上；修复后 `npm test` **2 秒内自然退出** |
| `week and month scopes expose the exact explicit range` 失败（`2 !== 0`） | 断言写错：该用例预置了 2026-10-24/25 两天数据，两天都在滚动 30 天窗口内，`daysWithData` 必然是 2 | 改为 `2`，并补 `summary.total === 6` 断言（**加强**而非削弱） |
| `HTTP ingest ... full response contract` 失败（`'partial' !== 'insufficient'`） | 用例没有固定时钟，覆盖率取决于运行时刻与毫秒级观测间隔，本身不确定；同时暴露 4.4 的覆盖率口径缺陷 | 注入固定时钟 `now: () => FIXED_NOW`，改写为确定性的强断言（日期/窗口/汇总/设备行） |

修复后：`test/activity-api.test.js` **12/12 通过**，`npm test` **287/287 通过并自然退出**。

### 4.2 冻结 API 合同缺 E 接口、版本自称 1.0.0

- `docs/APP-API-v1.md` 原先只有 1.0.0 内容 + D 的 §4.1，**全文 grep `activity` 为 0 命中**；
  `docs/APP-API-v1.json` 仍是 `version: 1.0.0`、无 D/E 任何新接口。
- 修复：md 补 §4.2（接口、参数、日/周/月真实窗口、字段类型、`days[]` 与 `range` 的区别、
  null 语义、覆盖率口径、持久化与失败边界），合同版本升到 **1.2.0** 并写明
  `1.1.0 = 处置结果/安全日志`、`1.2.0 = PIR 活动报告`；json 同步到 `1.2.0` 并补齐 4 个端点与
  `dispositionOutcome/activityScope/activityStatus` 枚举。
- 同步更新 `test/app-contract.test.js`：版本断言 1.0.0 → 1.2.0，并把 4 个新端点与 3 组枚举
  加入“必须存在”清单（**该守卫因此变强**）。

### 4.3 day 范围把 7 天趋势序列当成“查询窗口”（E2 违反）

- 现象（读码确认 + 实测）：`scope=day` 时 `range` 返回 `from=selectedDate-6, days=7`，
  `summary.days=7`、`summary.total` 是 7 天合计，而 `selected` 只有当天 —— 页面“查询范围”会显示
  “7 天”，与“当日活动次数”自相矛盾；`previous`/`comparison` 却按 1 天比较。
- 修复（`src/activity.js`）：把“趋势序列窗口”和“所选统计窗口”显式分开。
  `range`/`summary`/`hourly` 描述**所选窗口**（day=1、week=7、month=30 天）；
  `days[]` 仍是**趋势序列**（day/week 7 项、month 30 项），页面“近 7 日趋势”不受影响。
- 验证：合同用例新增 `range = {from:today,to:today,days:1}`、`summary.days === 1`、
  `summary.total === 3`、`days.length === 7`、`days[6].date === today` 的强断言；
  独立隔离脚本实测 `day range` 为单日、`week` 为 `2026-10-20~2026-10-26`、
  `month` 为 `2026-09-27~2026-10-26`。

### 4.4 覆盖率在“刚启用”时被夸大（E5 违反）

- 现象：`coverageRatio` 的可观测窗口原先从 `dataSince`（首个有效样本时刻）起算。
  功能刚启用时，几十毫秒的观测就能算出接近 100% 的覆盖率，把“当天几乎没有观测”
  显示成“数据充分”，进而让趋势/对比在证据不足时下结论（审计实测到 `0.793` 且 `status='ok'`）。
- 修复：`dayWindowMs()` 改为**该自然日 00:00 到统计时刻**的完整窗口，不再按 `dataSince` 裁剪。
  历史起点仍由 `dataSince` / `historyNote` 单独如实表达，不用覆盖率代替。
- 验证：新增单元测试“first-day coverage is measured over the whole elapsed day”，
  断言 6 小时窗口里只有 2 秒观测 → `coverageRatio ≈ 0.00001`（**小于 0.01**）且
  `status = insufficient`；同时 `dataSince` 仍等于首个样本时刻、`historyNote` 仍带日期。
  原覆盖率阈值测试（12h/24h → ok、3h/24h → partial、单样本 → insufficient）全部保持不变并通过。

### 4.5 E 页面文案与状态回退（E2/E4 与可用性）

- KPI 标签 `本周活动次数 / 本月活动次数` → `近 7 日活动次数 / 近 30 日活动次数`
  （后端是滚动窗口，不是自然周/月；测试断言同步修正，未删断言）。
- 设备行徽标 `未配置人体传感器` → `未观测到人体传感器`：后端 `hasMotionSensor` 只表示
  “是否观测到过 `motion` 字段”，无法区分“房间没有 PIR / 设备未接入 / 窗口内无样本”，
  原文案超出证据。
- 加载竞态：原先加载中切换范围/日期会被 `if (this.loading) return` 直接丢弃，旧响应回来后又把
  `scope/selectedDate` 覆盖回旧值（用户选择被静默回退且不重发请求）。改为：加载中记
  `pendingReload` 并在本次返回后按最新选择重载；服务端回显只在本请求参数未被改动时用于纠偏。

### 4.6 旧文档错误：按“保留历史报告原貌”只在**本目录**纠正

以下错误**没有**改写旧文件（遵守“不覆盖旧证据”），在新交付说明中纠正并给出正确值：

| 旧文档位置 | 错误 | 正确 |
| --- | --- | --- |
| `2026-10-26-alert-disposition-safety-log/REPORT.md` §7、`DEPLOY-DIFF-AND-ROLLBACK.md` §4/§5.3 | 把较早回退包 `8A722…` 当作“正式/冻结正式 HAP”回退基线；`9EEBEE` 在该目录**一次都没出现** | 最近**已真实验收**的手机 APP 是 2,086,949 B / `9EEBEE9A5FC9EEC5A5993DC6923F16F0BFCCCD1CD4DE64BAF36FC7197ECAD25A`；`8A722…` 只是**更早**的回退包，不能继续当默认最新基线 |
| `DEPLOY-DIFF-AND-ROLLBACK.md` 第 93 行 | 哈希转写错误：`…E3CC9179F1266FD5253A985` | 实为 `…E3CC9179F1286FD5253A985`（`9F12**86**FD`，非 `9F12**66**FD`），与交接 §6.1 一致；已在本目录用实算哈希复核 |
| E 证据 `app-test.log` §6（追加段） | 声称后端 `buildActivityReport()` “新增 `dataSinceText` 家庭时区文本” | **不成立**：后端只返回 number 型 `dataSince`，**没有** `dataSinceMs`/`dataSinceText`；APP 的两个字段是**客户端派生**。APP 解析数字 `dataSince` 的路径本身正确（实测显示“数据自 … 起”，无 1970、无“未知”），所以这是**证据描述错误，不是产品缺陷** |
| D 候选 HAP `2CFB8908…` | 被当作 D 的候选包 | 实测含 **D + E + CAMERA-A**（`ActivityReportPage` 已注册、`/api/v1/activity/report`、`EvidenceMemoryCache` 均在包内），且其源码快照 `Contracts.ts` 与构建时源码不同 → **陈旧、无任何 HAP 对应当前工作树** |
| `backend/D-E-SCOPE-SPLIT.md` | 称“E 后端零测试”“`dataSince` 与 APP 不兼容” | 已过时：现树有 `activity.test.js`（22 条）与 `activity-api.test.js`（12 条），APP 同时接受 number/string |
| `backend-audit` 本轮审计结论（`_work/backend-audit.md`） | 记录 3 条 E 测试失败、`npm test` 不退出、day 窗口与文档不符 | 均已在 4.1/4.3/4.4 修复；该报告保留为**修复前**快照，不是最终状态 |

## 5. 验证结果（本次真实运行，不拼接旧报告数字）

### 5.1 后端

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 语法检查 | `cd competition/cloud/backend; npm run check` | **exit 0**（14 个 `node --check`，含 `safety-log.js`/`activity.js`/`activity-store.js`） |
| 全量测试 | `npm test`（= `node --test`，默认隔离） | **287 tests / 287 pass / 0 fail / exit 0**，约 1.7 s，**自然退出** |
| D 定向（4 个文件） | `node --test test/safety-log*.test.js test/safety-log-isolated.integration.js` | **38/38 pass, exit 0**（14 + 14 + 9 + 1） |
| D 隔离集成 | `node --test test/safety-log-isolated.integration.js` | **1/1 pass, exit 0**；`[isolated] endpoints=3 dispositions=2 safetyLogs=2 ackCommands=1 schema=6 restart=ok` |
| E 单元/接口 | `node --test test/activity.test.js` / `test/activity-api.test.js` | **22/22** 与 **12/12** pass（合计 34，包含在全量 287 内） |
| E+D 独立隔离验证（Lead 自写脚本） | `node backend/E-ISOLATED-VERIFICATION.js` | **39/39 checks PASS，`ISOLATED_PASS`**（临时目录 + 127.0.0.1 随机端口 + 进程内随机凭据） |

计数关系可自洽：基线 215（`D-E-SCOPE-SPLIT.md` 记录）+ D 38 + E 34 = **287**。

### 5.2 APP

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| core TypeScript 编译 | `node <DevEco tsc> -p APP/ElderlyCareGuardian/tests/tsconfig.json` | **exit 0，无诊断** |
| 主机侧测试 | `cd APP/ElderlyCareGuardian/tests; node --test --test-isolation=none` | **291 tests / 291 pass / 0 fail / 0 skipped / exit 0**（19 个文件；activity-report 50、disposition 22、api-client 23、static-guard 30、evidence 30） |
| Hypium 平台单元测试 | `node <hvigor.js> test --mode module -p product=default -p module=entry@default --no-daemon` | **BUILD SUCCESSFUL，exit 0**；`Tests run: 39, Failure: 0, Error: 0, Pass: 39, Ignore: 0` |
| ArkTS/HAP 平台构建 | `node <hvigor.js> assembleHap --mode module -p product=default -p buildMode=debug --no-daemon` | **BUILD SUCCESSFUL，exit 0**，33 tasks；`WARN: Will skip sign 'hos_hap'. No signingConfigs profile is configured` |

说明：Hypium 的 39 条 = 既有 `localUnitTest` 1 + `validContractViewMapper` 20 + 本轮 D 的
`dispositionDtoParsing` 11 + `dispositionApiClient` 7；E 的功能覆盖在主机侧 `activity-report`
50 条与后端 34 条里，**E 没有 Hypium 用例**（如实记录，未用其它用例冒充）。

### 5.3 组合回归保留项

| 回归 | 是否保留 | 证据 |
| --- | --- | --- |
| P0 自动刷新（`ForEach` key 含 stateText/valueText/detailText） | 是 | `validContractViewMapper` 20 条 + `static-guard` 静态守卫全过 |
| 离线保留上次读数/降级语义 | 是 | `defect-restore*`/`defect-sensor` 等用例全过 |
| 既有 ACK（命令入队 202、不改本地状态） | 是 | APP `ack-state.test.mjs`；后端隔离脚本 `ackCommands=1` 且处置不产生命令 |
| 会话切换/登出清缓存 | 是 | `defect-session.test.mjs`、`session.test.mjs` 全过 |
| CAMERA-A 静态约束 | 是 | `evidence.test.mjs` 30 条全过（2 MiB/SOI-EOI/LRU/copy-in-out/不写文件） |
| 页面不直连 ApiClient、域名唯一、日志不含凭据 | 是 | `static-guard.test.mjs` 30 条全过 |

### 5.4 证据等级划分

| 等级 | 本任务内容 |
| --- | --- |
| SOURCE FACT | 源码/合同/文档现值的逐行核对结论 |
| LOCAL TEST / LOCAL BUILD | 5.1–5.3 的全部命令与计数（真实执行） |
| ISOLATED PASS | D 隔离集成、E+D 独立隔离脚本（临时目录 + 127.0.0.1 + 进程内随机凭据） |
| REAL（历史，非本轮） | 2026-10-22 SOS→ACK→设备 ACKED；2026-10-24 P0 手机验收（9EEBEE）；DAYU 1.0.2 真机预览 |
| NOT RUN | 公网部署、HAP 安装、真机/模拟器运行态、真实公网响应、真实 PIR 数据积累 |
| BLOCKED | 上述 NOT RUN 项需要用户授权与现场条件（见 §7） |

## 6. 源码 / 测试 / 构建产物对应关系

```text
最终源码（本目录 SOURCE-HASHES.txt，136 个文件 / 1,534,045 B）
  ├─ backend: competition/cloud/backend/src/*.js            ← npm test 287/287 覆盖
  │            test/*.js（含 D 4 个 + E 2 个 + 基线 20 个）
  ├─ APP:     APP/ElderlyCareGuardian/entry/src/main/ets/** ← tsc exit 0
  │            entry/src/test/**（Hypium 39）               ← hvigor test 39/39
  │            tests/*.test.mjs（19 文件 291 条）            ← node --test 291/291
  ├─ 合同:    competition/docs/APP-API-v1.md / .json        ← app-contract.test.js 守卫
  └─ 构建:    APP/ElderlyCareGuardian/entry/build/.../entry-default-unsigned.hap
                2,621,844 B / 7634A0E25FCE3E19FC9604E4CD94D6D6BAFF36CB5DE67C92DAEE0E50C1452EB5
                归档为 app/guardian-d-e-candidate-2026-10-26-unsigned.hap（同哈希）
```

HAP 与源码的一致性有**两重**证明：
1. 构建发生在 APP 源码最后一次写入之后，构建后没有任何 APP 源文件再被修改（`SOURCE-HASHES.txt` 可复核）；
2. 对 `ets/modules.abc` 做字节串检索，能查到本轮**修复后**才存在的文案（`近 30 日活动次数`、
   `未观测到人体传感器`），且查不到修复前文案（`未配置人体传感器` 命中 0），同时 D/E/CAMERA-A
   三者的特征串都在（`Disposition` 50、`safety-logs` 3、`activity/report` 1、`EvidenceMemoryCache` 2）。

**构建可复现性（如实披露）**：从同一份源码连续构建两次，HAP **字节不同**（`54FF869E…` 与
`7634A0E2…`），但解包后 **20 个 payload 条目逐字节相同**，差异只在 ZIP 条目时间戳
（12:24:14 vs 12:43:24）。因此候选身份以**归档文件哈希**为准，内容可复现性以
`app/HAP-PAYLOAD-HASHES.txt` 为准。

## 7. 未测项与剩余阻塞（不得省略）

**本任务没有做、也不代表已完成的**：

1. 公网 backend 未部署：生产仍是 schema v5、合同 1.0.0，**没有** dispositions/safety-logs/activity 接口。
2. 候选 HAP **未签名、未安装**：`build-profile.json5` 无 `signingConfigs`；未连接手机/模拟器，
   未在真实运行态验证处置面板、安全日志页签、活动报告页（日期选择/日周月切换/滚动布局）。
3. 未做任何真机或公网运行态验收；未使用真实既有告警做“填写处置 → 保存 → 查询 → 重启后仍在”。
4. 未验证真实 PIR 数据积累（日/周/月需要自然样本）；`dataSince`/覆盖率/趋势在真实数据下的表现未验收。
5. **多家庭/多监护人身份审计不支持**（单户固定角色 `household-guardian`），不得对外宣称已支持。
6. CAMERA-A 真实验收仍阻塞（会话、公网路由部署、真实 FALL+绑定 JPEG、安装与显示）。
7. DAYU（`northbound`）工程本次未修改；它仍声明 1.0.0，已验收 1.0.2 来自
   `competition/experiments/dayu-eldercare-preview-integration-2026-10-25`。**不能用 northbound 的
   1.0.0 推翻已验收 1.0.2，也不能直接把 northbound 重建当正式包。**
8. 活动文件损坏会让**整个后端**拒绝启动（fail-closed 的设计取舍）；运维恢复步骤见
   `DEPLOY-READINESS-AND-ROLLBACK.md`，这属于已记录的运行风险，不是本任务可消除的缺陷。
9. 旧 D 证据目录里的回退引用/哈希错误**没有修改旧文件**（按要求保留原貌），只在本目录纠正。

## 8. 并行改动保护的实际执行

- 编辑前核实：无其他会话/构建进程写入相关目录（见 §1）；没有抢写、没有强杀、没有阻塞。
- 编辑前对 137 个相关文件做了哈希快照（`_work/PRE-EDIT-SNAPSHOT.txt`）。
- 没有用旧清单/旧快照整文件覆盖现文件；全部改动是局部替换。
- 没有假定有 Git 可恢复；6 个改动文件都可用 `_work/before-after/*.before` 逐字节还原。
- 没有覆盖旧证据/旧候选/已验收制品：本轮新增目录，旧目录只读。

## 9. 下一步真实部署验收需要的明确条件

1. **用户授权维护窗口**，允许升级公网 backend（当前 schema v5 → v6，并新增独立活动文件）。
   升级前必须按 `DEPLOY-READINESS-AND-ROLLBACK.md` §2 备份命名卷 `backend-data`。
2. **E 是否随 D 一起上线要显式决定**：两者共用 `server.js`/`main.js`/`package.json`，
   本候选的镜像天然同时包含二者；若只上 D，需要另行拆分共享文件。
3. **签名材料与设备**：用户/DevEco 配置 `signingConfigs` 后签名，并安装到指定手机或模拟器；
   回退目标是**最近已验收包 9EEBEE**（不是 8A722）。
4. **指定一个既有可操作告警**用于 D 的真实处置验收（是否 ACK 由用户决定，不制造 SOS/FALL）。
5. **自然样本时间窗**：E 的日/周/月需要真实 PIR 数据累积；不足历史时应显示“无数据/不足”，
   不得用测试数据伪造。
6. 验收时需记录：时间、版本/哈希、动作、观察窗口、HTTP 状态码、截图路径、重启后结果、
   以及回滚是否可用。

## 10. 交付物索引

| 文件 | 内容 |
| --- | --- |
| `REPORT.md` | 本文件 |
| `E-FINAL-REPORT.md` | E 独立功能/契约/持久化/窗口/数据语义说明（补 E 缺失的最终报告） |
| `SOURCE-MANIFEST.md` | 源码清单、改前/改后差异、快照对应关系 |
| `SOURCE-HASHES.txt` | 136 个最终源文件的 SHA-256 / 字节数（机读） |
| `TEST-RESULTS.md` | 全部命令、退出码、测试数量、日志位置 |
| `BUILD-MANIFEST.md` | 候选 HAP 路径/字节/哈希/版本/签名状态/包含功能 |
| `CANDIDATE-SCOPE.md` | D/E/CAMERA-A 功能包含矩阵与未验收边界 |
| `DEPLOY-READINESS-AND-ROLLBACK.md` | 部署前置、备份对象、数据兼容、回滚方案（本任务不执行） |
| `SHA256SUMS.txt` | 本次交付物校验清单 |
| `app/`、`backend/` | 候选 HAP、payload 哈希、原始日志、独立隔离脚本与结果 |
| `_work/` | 三份并行审计报告（修复前快照）、改前快照、改前/改后文件与 diff、构建脚本 |
