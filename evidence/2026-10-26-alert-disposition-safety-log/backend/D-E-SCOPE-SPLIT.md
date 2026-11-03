# D / E 范围分离与回退说明（backend）

日期：2026-10-26
任务：ALERT-DISPOSITION-SAFETY-LOG（task-2, backend-dev）

> 重要声明：backend-dev（task-2）**只实现 D 类**（告警处置结果 + 安全日志，合同见
> `competition/evidence/2026-10-26-alert-disposition-safety-log/CONTRACT.md`）。
> E 类（PIR 活动规律报告 `GET /api/v1/activity/report`）是本次会话期间**并发出现的他方变更**，
> 不是 backend-dev 编写、修改或扩展的；本文件仅出于“D/E 分开列清单/测试/回退”的要求做记录。

## D 类（task-2 合同范围，已实现并验证）

### 文件
| 文件 | 变更 |
| --- | --- |
| `competition/cloud/backend/src/safety-log.js` | **新增**：outcome 枚举/文案、校验（白名单/长度/控制字符/clientDispositionId/OTHER 必填）、`publicDisposition`、`DISPOSITION_ID_RE` |
| `competition/cloud/backend/src/store.js` | `MemoryStore.safetyLogs` + `createDisposition`/`listDispositions`/`listSafetyLogs`/`getDisposition`（不触碰 requestAck/commands/alert.ackPending/status） |
| `competition/cloud/backend/src/persistent-store.js` | schema v6（READABLE 1..6）、`SNAPSHOT_KEYS` 加 `safetyLogs`、严格加载校验、`_maxDispositionId`、首次创建落盘/幂等不写盘、2000 容量淘汰 |
| `competition/cloud/backend/src/server.js` | 3 个路由：`POST/GET /api/v1/alerts/{alarmId}/dispositions`、`GET /api/v1/safety-logs`（8 KiB 上限、404/400/409/201/200、limit 1-200 默认 50、Bearer 鉴权） |
| `competition/cloud/backend/package.json` | `check` 脚本加入 `src/safety-log.js` |
| `competition/cloud/backend/README.md` | schema v6 + 新接口 + “处置≠ACK”边界 |
| `competition/docs/APP-API-v1.md` | 新增 4.1 节（合同版本 1.1.0），既有章节语义未改 |
| `competition/cloud/backend/test/safety-log.test.js` | **新增** 14 条（纯模块边界） |
| `competition/cloud/backend/test/safety-log-api.test.js` | **新增** 14 条（真实 HTTP 合同） |
| `competition/cloud/backend/test/safety-log-persistent.test.js` | **新增** 9 条（v1-v5→v6/重启/回滚/容量） |
| `competition/cloud/backend/test/safety-log-isolated.integration.js` | **新增** 1 条（临时数据文件 + 随机端口 + 重启隔离集成） |
| `competition/cloud/backend/test/comms-store.test.js` | v4→当前 schema 迁移断言由硬编码 5 改为 `SCHEMA_VERSION`（6）并新增 `safetyLogs=[]`（既有断言未删除/未弱化） |

### 测试
- 新增 38 条；后端全量 **253/253 pass**（基线 215/215，`node --test` 同发现规则）。
- 复现：`cd competition/cloud/backend; $env:NODE_OPTIONS='--test-isolation=none'; npm test`
  （沙箱禁止测试运行器为每个文件 spawn 子进程；非沙箱环境直接 `npm test` 即可）。
- `npm run check` exit 0；隔离集成 exit 0（`[isolated] endpoints=3 dispositions=2 safetyLogs=2 ackCommands=1 schema=6 restart=ok`）。
- 详见 `TEST-RESULTS.txt`、`ISOLATED-INTEGRATION.md`。

### 回退 D 类（无 git 仓库，按文件反向操作）
1. 删除：`src/safety-log.js`、`test/safety-log.test.js`、`test/safety-log-api.test.js`、
   `test/safety-log-persistent.test.js`、`test/safety-log-isolated.integration.js`。
2. `src/store.js`：删除 `require('./safety-log')`、`compareSafetyLogs`、构造器 `this.safetyLogs`、
   整个“告警处置结果 / 安全日志”方法块。
3. `src/persistent-store.js`：`SCHEMA_VERSION` 回到 5、READABLE 去掉 6、`SNAPSHOT_KEYS` 去掉
   `safetyLogs`、删除 safety-log require/常量/normalizeSafetyLog/safetyLogToDocument/加载循环/
   `_document`/`_captureState`/`_restoreState` 的 safetyLogs 与 `_maxDispositionId`、
   `createDisposition`/`_nextDispositionId`/`_allocateDispositionId`/`_trimSafetyLogs` 覆盖。
4. `src/server.js`：删除 safety-log require、`dispositionsSupported`、两条 disposition 路由与
   safety-logs 路由。
5. `package.json`：check 去掉 `node --check src/safety-log.js`（注意保留 E 类的 activity 检查，
   回退前先确认 E 归属）。
6. `README.md` / `docs/APP-API-v1.md`：移除 D 相关新增段落，`docs/APP-API-v1.md` 版本 1.1.0 回 1.0.0
   （若 E 也使用 1.1.0 增量，需要与 E 归属方协调）。
7. `test/comms-store.test.js`：可保留 `SCHEMA_VERSION` 写法（回退到 v5 时自动成立），
   或恢复硬编码 5 并删掉 `safetyLogs=[]` 断言。
8. 回退后必须重跑 `npm run check` 与全量 `npm test`；既有测试（215 条基线）应恢复全绿。

## E 类（并发他方变更，**非** backend-dev 产出）

### 文件（仅记录当前状态，不属于 task-2 交付）
| 文件 | 说明 |
| --- | --- |
| `competition/cloud/backend/src/activity.js` | PIR 活动聚合纯模块（家庭时区日桶 / countToday 增量 / coverage / 趋势 / 报告） |
| `competition/cloud/backend/src/activity-store.js` | 独立活动存储（独立文件 version=1，不进入主快照 schema v6） |
| `competition/cloud/backend/src/main.js` | 接线 ActivityStore |
| `competition/cloud/backend/src/server.js` | `activityStore` 注入、ingest 后 `recordStatus`、`GET /api/v1/activity/report` 路由（与 D 的 3 个路由共存） |
| `competition/cloud/backend/package.json` | check 增加 activity 文件 |
| APP 侧 | `entry/src/main/ets/core/activity/*`、`pages/ActivityReportPage.ets`、`service/GuardianService.ets`、`tests/activity-report.test.mjs` 等（app-dev 所有） |

### 测试
- 后端 E 类：**当前没有任何后端测试文件**（`test/` 下无 activity*）；`npm test` 的 253 条不覆盖 E 路由。
- APP E 类：存在 `APP/ElderlyCareGuardian/tests/activity-report.test.mjs`（0 字节占位）与
  `tests/build/activity/*`，是否真正执行由 APP 构建/测试链决定（不在 backend 验证范围）。

### E 与 APP 的字段对齐结论（backend-dev 只读交叉核对，非验收）
- 路径/参数对齐：APP `ApiClient.activityReport()` 请求
  `GET /api/v1/activity/report?scope=day|week|month[&date=YYYY-MM-DD]`，与后端路由及
  `normalizeActivityQuery`（scope=day|week|month，date=YYYY-MM-DD）一致。
- 响应字段对齐：APP `ActivityReportDto`/`parseActivityReport` 期望
  `generatedAt, timezone, scope, today, selectedDate, range{from,to,days}, dataSince, historyNote,
  selected{date,count,status,samples,invalidSamples,firstTs,lastTs,maxGapMs,coverageRatio,hourly},
  previous{date,count,status}, comparison{state,delta,pct,text}, days[], summary{total,days,daysWithData,coverageRatio,coverageText},
  hourly[], devices[{deviceId,room,hasMotionSensor,count,status}], trend{state,text,note}, disclaimer`；
  后端 `buildActivityReport` 返回的字段名/嵌套结构与之一致，`hourly` 均为 24 项数字/null 数组。
- **发现一处类型不一致（不会崩溃，但会降级显示）**：后端 `dataSince` 是**数字**（毫秒时间戳，无数据为 0），
  而 APP `parseActivityReport` 只接受**字符串** `dataSince`（`typeof dataSince === 'string'`），
  因此 APP 会得到 `dataSincePresent=false`，显示“数据起始时间未知”；
  `historyNote`（后端已含日期文案）仍正常展示，所以不影响主体功能，但“数据自 X 起”文案会缺失。
  建议 E 归属方二选一：后端输出 `YYYY-MM-DD` 字符串，或 APP 兼容数字时间戳。**此项不由 task-2 修改。**
- 未核对项：真实 HTTP 响应示例、E 路由 401/403/400/503 的实际契约、APP `hvigorw test` 是否通过
  （E 后端无测试、本轮未构建 APP，均需 E 归属方验收）。

### 回退 E 类（供 Lead 参考，backend-dev 未执行）
1. 删除 `src/activity.js`、`src/activity-store.js`。
2. `src/main.js`、`src/server.js` 移除 activity 接线/路由/`activityStore` 参数。
3. `package.json` check 移除 activity 两项。
4. APP 侧移除 activity 页面/模型/服务与测试。
5. 重跑后端 `npm run check` + 全量 `npm test`（D 应保持 253/253）与 APP 测试/构建。

## 风险提示

1. **D 的高风险点**：无（合同全覆盖，253/253 全绿，隔离集成通过）。唯一“合同外”备注：
   `docs/APP-API-v1.json` 未同步 1.1.0 增量（任务范围只授权改 `.md`），需 Lead 决定是否补。
2. **E 的高风险点**：后端 E **零测试**、`dataSince` 类型不一致、E 路由未做隔离集成；
   且 E 与 D 共用 `server.js`/`main.js`/`package.json`，任何一方回退都要保留另一方的块。
3. **并发编辑**：D 的收尾测试（253/253）运行于 2026-10-26 01:55:19，已包含 server.js 中的 E 路由；
   此后若 E 继续改动共享文件，请以 Lead 冻结时的最终 diff + 重跑测试为准。
