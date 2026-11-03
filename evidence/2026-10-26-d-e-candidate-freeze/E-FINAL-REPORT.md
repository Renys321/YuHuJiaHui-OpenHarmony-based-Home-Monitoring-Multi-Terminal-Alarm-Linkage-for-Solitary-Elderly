# E 类最终报告：PIR 活动日/周/月报告（ACTIVITY-REPORTS）

- 日期：2026-10-26（Asia/Shanghai）
- 状态：**`E_LOCAL_IMPLEMENTED_AND_ISOLATED_VERIFIED — NOT_DEPLOYED — NOT_INSTALLED — REAL_ACCEPTANCE_NOT_RUN`**
- 本文件补上 E 类此前**缺失的最终报告**（接手时 `competition/evidence/2026-10-26-activity-reports/`
  只有 3 个日志文件与一个空目录，没有报告/清单/候选/构建记录）。
- 合同正本：`competition/docs/APP-API-v1.md` **§4.2**（合同版本 1.2.0）
- 实现：`competition/cloud/backend/src/activity.js`、`activity-store.js`、`main.js`、`server.js`；
  `APP/ElderlyCareGuardian/entry/src/main/ets/core/activity/ActivityModels.ts`、`ActivityReport.ts`、
  `pages/ActivityReportPage.ets`，以及 `Contracts.ts`/`ApiClient.ts`/`GuardianService.ets` 的增量。

## 1. 功能范围

手机端“活动报告”页按**日 / 周 / 月**三种范围展示 PIR 活动规律：

- 数据来源**只有一个**：设备状态摄入里的 `sensors.motion.countToday`（当日累计 PIR 触发次数）。
- 展示：选中窗口的活动次数、日均、数据覆盖率、逐日趋势、24 小时分布、分房间/设备计数、
  与上一周期的对比、中性趋势文案、免责声明。
- 不包含：人数统计、步数、精确轨迹、医学诊断、跌倒检测、远程视频。

## 2. 契约（与 §4.2 一致，逐项）

### 2.1 接口

```http
GET /api/v1/activity/report?scope=day|week|month[&date=YYYY-MM-DD]
Authorization: Bearer <sessionToken>
```

| 情形 | 响应 |
| --- | --- |
| 正常 | `200`，字段见 §2.3 |
| `scope` 非 `day|week|month` | `400 {"error":"invalid scope"}` |
| `date` 非 `YYYY-MM-DD` 或非法日历日期（如 `2026-02-30`） | `400 {"error":"invalid date"}` |
| 未带/无效 Bearer | `401`（与 `/api/v1/devices` 同一鉴权段） |
| 身份不在家庭允许名单 | `403` |
| 未注入活动存储 | `503 {"error":"activity report unavailable"}` |

### 2.2 统计窗口（**本任务的实测结论**）

| scope | 实际窗口 | `range` | `days[]`（趋势序列） |
| --- | --- | --- | --- |
| `day` | 选中日在家庭时区的 `00:00–24:00` | `{from=to=selectedDate, days:1}` | 7 项 |
| `week` | **截至选中日、向前滚动 7 天**（不是周一起的自然周） | `{from=selectedDate-6, to=selectedDate, days:7}` | 7 项 |
| `month` | **截至选中日、向前滚动 30 天**（不是自然月，不固定 1 号起） | `{from=selectedDate-29, to=selectedDate, days:30}` | 30 项 |

- 实测（独立隔离脚本）：`week` 选 `2026-10-26` → `2026-10-20 ~ 2026-10-26（7 天）`；
  `month` 选 `2026-10-26` → `2026-09-27 ~ 2026-10-26（30 天）`；`day` → 单日。
- `previous` 是**紧邻所选窗口之前的等长窗口**（day 前一天 / week 前 7 天 / month 前 30 天），
  `previous.date` 是该窗口的**结束日**。
- 家庭时区来自 `HOUSEHOLD_TIMEZONE`（默认 `Asia/Shanghai`），切日/切小时只用它，
  不用服务器本地时区或 UTC；非法时区**拒绝启动**（fail-closed）。

> 本任务修正：原实现 `scope=day` 时把 7 天趋势序列同时当作 `range`/`summary`，导致
> “查询范围显示 7 天”与“当日 KPI”矛盾。现 `range`/`summary`/`hourly` 描述**所选窗口**，
> `days[]` 单独作为趋势序列供页面画图（`range.days` 与 `days.length` 可以不同，已在 §4.2 写明）。

### 2.3 响应字段与类型（服务端真实返回值）

```text
generatedAt   number    服务端生成时刻（毫秒）
timezone      string    家庭时区
scope         string    day | week | month
today         string    家庭时区今天
selectedDate  string    所选窗口结束日
range         {from,to,days}
dataSince     number    首个有效 PIR 样本到达时刻（毫秒）；0 = 还没有任何活动数据
historyNote   string    历史起始说明
selected      DayView   所选窗口聚合
previous      {date, count:number|null, status}
comparison    {state, delta:number|null, pct:number|null, text}
days          DayTrend[]
summary       {total:number|null, days, daysWithData, coverageRatio:number|null, coverageText}
hourly        (number|null)[24]
devices       [{deviceId, room, hasMotionSensor, count:number|null, status}]
trend         {state, text, note}
disclaimer    string

DayView  = {date, count:number|null, status, samples, invalidSamples,
            firstTs, lastTs, maxGapMs, coverageRatio:number|null, hourly:(number|null)[24]}
DayTrend = {date, count:number|null, status, coverageRatio:number|null}
```

**`dataSince` / `dataSinceMs` / `dataSinceText` 的真实关系（重要更正）**：

- 后端**只返回** `dataSince`，类型是 **number（epoch 毫秒，0 表示无数据）**。
- 后端**不返回** `dataSinceMs`，也**不返回** `dataSinceText`。
- APP `ActivityReportDto` 里的 `dataSinceMs`（number）与 `dataSinceText`（string）是**客户端派生字段**：
  `parseActivityReport` 把数字 `dataSince` 读入 `dataSinceMs`（仍兼容旧 string 形态），
  `mapActivityReport` 再按优先级 `dataSinceText > dataSinceMs > 旧 string` 生成展示文本。
- 实测：真实后端响应 → APP 解析后显示“数据自 `2026-09-27 10:00` 起”，`dataSince=0` 时显示
  “数据起始时间未知”，**不出现 1970 年**。
- 已知限制（NOTE）：APP 用**设备本地时区**格式化 `dataSinceMs`，页面不展示服务端 `timezone`；
  手机时区与家庭时区不同时，“数据起始”文本可能差几小时（日期可能跨日）。当前同区场景正确。
- 历史证据 `app-test.log` §6 把 `dataSinceText` 写成“后端新增字段”，是**证据描述错误**，
  不改产品代码；本文件为准确结论。

### 2.4 状态与覆盖率口径

- `status`：`no_data`（没有任何样本）/ `insufficient`（样本 <2 或覆盖率 <10%）/
  `partial`（覆盖率 10%–50%）/ `ok`（覆盖率 ≥50%）。
- `coverageRatio` = 当天观测到的有效采样间隔之和 ÷ **该自然日 00:00 到统计时刻**的时长；
  为 `0..1` 或 `null`（窗口不可观测时是 `null`，不是 0）。
- 相邻样本间隔 **> 120 s** 的部分不计入覆盖率：长断连只会让覆盖率变低、`status` 降级，
  **不会**被补成“0 次活动”或“一切正常”。
- 本任务修正：原实现从 `dataSince` 起算窗口，功能刚启用时几十毫秒观测即可得到接近 100%
  的覆盖率（实测 `0.793` / `status=ok`）。现改为完整自然日窗口，历史起点只由 `dataSince` /
  `historyNote` 表达。新增单元测试固定该语义（6 小时窗口里 2 秒观测 → 覆盖率 <0.01、insufficient）。

## 3. 数据语义（逐条对照任务要求）

| 要求 | 实现与验证 |
| --- | --- |
| 首次样本只建基线 | `recordActivitySample`：`baseline` 为空时 `delta=0`、记录 `dataSince`，不倒填历史。单测“first observation only establishes a baseline” |
| 重复累计值不重复计数 | 同 `countToday` 重复上报 `delta=0`。单测“only positive countToday increments count” |
| 计数回退/设备重启 | 新值 < 基线 → `reset`，`delta = 本次观测值`（≥0），`resets += 1`，绝不产生负数。单测“counter rollback is a reset…”“device counter reset at 08:00 mid-day is a reset” |
| 跨日 | 自然日滚动：`dayKey > baseline.date` 时 `delta = countToday`（假设设备“当日累计”在新的一天已归零），并把基线切到新日。单测“crossing household midnight rolls the day over”。**边界假设**：若某固件的 `countToday` 跨日不归零，会被多计 —— 现有硬件（ESP32 PIR 计数）按当日累计上报；此假设已在合同 §4.2 隐含，需在真机验收时复核 |
| 长断连 | 断连段不计入 `observedMs`，只降低覆盖率/降级 status，不补 0。单测“offline gaps only reduce coverage” |
| 无数据/无效数据/无 PIR 房间 | `count` 一律 `null`（不是 0）；无 `motion` 字段的载荷直接返回 `no_motion`，不建样本、不写 0；`valid=false`/`countToday` 缺失/非安全整数/负数 → `invalidSamples`，不计入 `count`。单测 2 条 + 接口测试“no data is reported as null everywhere” |
| 覆盖率/缺失小时/历史起始/上一周期对比 | 逐小时未观测为 `null`（不是 0）；`summary.daysWithData`/`coverageText` 如实表达；`previous` 不足时 `count=null` 且 `comparison.state=previous_missing`，`pct` 为 `null`（0 不做分母）。单测 3 条 + 接口测试 2 条 |
| 不足历史不伪造 | 连续有数据日不足 3 天或最近 3 天覆盖率不足 50% → `trend.state='insufficient'`，不给结论 |
| PIR 只表示触发计数 | `disclaimer` = “PIR 活动计数是传感器触发次数，不等于人数或唯一动作次数；无数据不等于没有活动；历史仅从功能启用后开始积累。”趋势文案不含疾病/诊断词（测试用正则扫描） |
| 页面不显示 0 次/正常 | APP DTO `nullableActivityCount` 非法/负数/缺失 → `null`；视图与页面 null → “无数据”；测试扫描整页文案无伪 0 |

## 4. 持久化

| 项 | 事实 |
| --- | --- |
| 存储文件 | **独立** `activity-state.json`（默认与 `BACKEND_DATA_FILE` 同目录，可用 `BACKEND_ACTIVITY_FILE` 覆盖） |
| 文件版本 | 自带 `version = 1`，与主快照 `schemaVersion` **完全无关**；主快照现为 **v6**，**不含** `activity` 字段 |
| 顶层白名单 | 仅 `version` / `savedAt` / `activity`；`activity` 内部严格白名单，未知字段/日桶越界/hourly≠24/时区不一致 → fail-closed |
| 写入 | 同目录临时文件（0600）→ `fsync` → `rename`；失败回滚内存并抛出 |
| 重启恢复 | 同一数据文件 + 活动文件重启后，报告数值一致；继续上报沿用已持久化基线而不是重建基线（接口测试“survives restarts”，独立脚本亦验证） |
| 容量 | 每设备最多 400 个日桶，按日期淘汰最旧；未知输入不会造成无界增长 |
| 损坏文件 | **fail-closed 拒绝启动**，不静默清空历史（单测 + 独立脚本各验证一次） |
| 写盘失败 | 回滚内存，活动报告保持旧值；**主摄取仍返回 202**，后端只打印 `[backend] ACTIVITY_RECORD_FAILED code=…` |

**必须明确的失败边界**：活动写入失败被收敛为独立失败域（`server.js` 捕获后只记日志），
所以**自然的 202 不能证明活动统计已落盘**。验证方式只能是查活动文件/报告数值，
不能只看摄取 202。此外，损坏的活动文件会让**整个后端**拒绝启动 —— 这是“宁可拒绝服务也不静默丢数据”
的取舍，部署说明中必须写明运维恢复步骤。

## 5. 验证结果（本次真实运行）

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| E 单元 | `node --test test/activity.test.js` | **22/22 pass** |
| E 接口 | `node --test test/activity-api.test.js` | **12/12 pass**（修复前 9/12） |
| E 含在全量内 | `npm test` | **287/287 pass, exit 0**（自然退出） |
| E+D 独立隔离 | `node backend/E-ISOLATED-VERIFICATION.js` | **39/39 PASS，`ISOLATED_PASS`**（其中 E 相关 22 条：字段清单/`dataSince` 类型/日周月窗口/`previous`/null/无 PIR/覆盖率/重启/写失败/损坏文件） |
| APP 活动报告 | `node --test --test-isolation=none activity-report.test.mjs` | **50/50 pass** |
| APP 全量 | `node --test --test-isolation=none` | **291/291 pass** |
| ArkTS/HAP | `hvigor assembleHap` | **BUILD SUCCESSFUL**；HAP 内含 `ActivityReportPage`、`activity/report`、修复后文案 |

独立隔离脚本实测响应关键值（`backend/ISOLATED-E-VERIFY.json`）：

```text
monthRange  = {"from":"2026-09-27","to":"2026-10-26","days":30}
weekRange   = {"from":"2026-10-20","to":"2026-10-26","days":7}
activityFile keys = version,savedAt,activity   version=1   mainSchema=6
dataSinceType = number   dataSinceMs=false   dataSinceText=false
```

## 6. 本任务对 E 的修改清单

| 文件 | 修改 |
| --- | --- |
| `backend/src/activity.js` | (a) `scope=day` 的 `range`/`summary` 改为所选窗口（1 天），`days[]` 保留 7 天趋势序列；(b) 覆盖率窗口改为完整自然日，不再按 `dataSince` 裁剪 |
| `backend/test/activity.test.js` | 新增 1 条覆盖率诚实性测试（22 条，原 21 条） |
| `backend/test/activity-api.test.js` | 修复 3 个失败用例：幂等 close、`daysWithData` 期望值、固定时钟与强断言；day 范围断言改为 `range.days=1 && days.length=7`；补 `summary.total` 断言 |
| `backend/test/app-contract.test.js` | 合同版本断言 1.0.0 → 1.2.0，新增 4 个端点与 3 组枚举守卫 |
| `competition/docs/APP-API-v1.md` / `.json` | 新增/同步 §4.2（见 E2 要求），版本 1.1.0 → **1.2.0** |
| `competition/cloud/backend/README.md` | 新增 E 接口/文件/失败边界/验证章节 |
| `APP/.../core/activity/ActivityReport.ts` | KPI 文案改为滚动窗口口径 |
| `APP/.../pages/ActivityReportPage.ets` | 设备徽标文案改为“未观测到人体传感器”；修复加载中切换范围/日期的静默回退 |
| `APP/.../tests/activity-report.test.mjs` | 同步修正被锁定的 KPI 文案断言（未删减断言） |

## 7. 未验证 / 阻塞

1. 公网 backend 未升级：生产没有 `/api/v1/activity/report`；APP 只会得到真实错误，不会伪造数据。
2. 候选 HAP 未签名、未安装：日期选择、日/周/月切换、滚动布局、演示模式文案**未在真机/模拟器验证**。
3. 未用**真实后端/真实公网响应**验证：APP 侧测试用 `tests/fake-transport.mjs` 的 SIMULATED 响应；
   字段对齐结论来自“读取后端 `buildActivityReport()` 真实返回值 + 喂给编译后的 APP 解析器”的只读探针，
   不是公网抓包。
4. 未验证真实 PIR 数据积累（日/周/月需要自然样本）、设备固件的 `countToday` 跨日归零行为。
5. 不提供多家庭/多监护人身份区分。
6. `hasMotionSensor=false` 无法区分“房间没有 PIR / 设备未接入 / 窗口内无样本”，UI 已改为中性表述，
   但语义本身的改进需要设备能力表（后续工作）。
