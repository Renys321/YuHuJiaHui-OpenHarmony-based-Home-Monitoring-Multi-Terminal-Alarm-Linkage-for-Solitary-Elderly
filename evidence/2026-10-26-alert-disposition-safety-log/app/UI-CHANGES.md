# APP UI 变更说明（task-3：告警独立处置结果 + 安全日志历史页）

日期：2026-10-26
合同：`competition/evidence/2026-10-26-alert-disposition-safety-log/CONTRACT.md`
APP：`APP/ElderlyCareGuardian`

## 1. 变更页面总览

| 页面/文件 | 变更 | 数据来源 |
|---|---|---|
| `pages/AlertDetailPage.ets` | 在既有 ACK 面板**之外**新增独立“处置结果”面板（1067 → 1560 行） | `GuardianService.loadDispositions / submitDisposition`（真实 `GET/POST /api/v1/alerts/{alarmId}/dispositions`） |
| `pages/LogPage.ets` | 新增“告警记录 / 安全日志”切换（309 → 657 行）；告警记录 tab 保持原行为 | 告警记录=`gv.alerts`；安全日志=`GuardianService.loadSafetyLogs`（真实 `GET /api/v1/safety-logs?limit=50`） |
| `pages/ProfilePage.ets` | 无净改动（按 Lead 要求收敛，未改菜单文案/入口） | — |
| `core/**`、`service/GuardianService.ets`、`entry/src/test/*`、`tests/disposition.test.mjs` | DTO/解析、ApiClient 三个方法、服务方法与测试 | 见 `TEST-RESULTS.txt` / `SOURCE-HASHES.txt` |

## 2. 告警详情页（AlertDetailPage）

### 2.1 ACK 面板（保持不变）

- 既有 `ackPanel()` 与 ACK 状态机（idle → submitting → waiting → confirmed/failed/timeout）逻辑**未改**：仍只有服务端返回 `state=ACKED` 才显示“设备已确认”，202 只表示命令入队。
- 仅两处**文案**调整以与处置区分：备注输入框 placeholder 由“处置说明（选填，最多 120 字）”改为“确认备注（选填，最多 120 字）”；底部说明改为“ACK 与处置结果相互独立：下方处置登记不改变告警状态、不触发设备确认，也不会伪造‘已归档’”。
- 处置成功/失败**不会**改变 ACK 面板的状态显示（两者状态变量完全独立：`phase`/`ackMessage` vs `dispPhase`/`dispMessage`；处置提交不调用 `refreshAlerts`，不会触发 ACK 状态机分支）。

### 2.2 新增独立“处置结果”面板（`dispositionPanel()`）

标题：“处置结果”，副标题“独立于 ACK · 不改告警状态”。

**输入（真实模式）**
- 5 个结果单选项（合同枚举，顺序固定）：已联系家属 / 已联系社区 / 现场确认正常 / 误报 / 其他说明。
- 说明输入：`TextArea.maxLength(200)`，实时计数 `n/200`，选填；选择“其他说明”时必填（前端校验，后端同样校验）。
- 提交按钮：提交中显示 loading 且禁用（`dispSubmitDisabled` 同时覆盖未找到告警/演示模式），不重复提交；失败后按钮文案变“重新提交处置结果”。
- 幂等键：首次提交生成 `disp-<base36 时间>-<随机>`（8–64 位 `[A-Za-z0-9._-]`、无 `..`）；同内容失败重试沿用同一键（避免重复记录），修改结果或说明后重新生成（避免 409）。

**状态**
- `idle → submitting → saved | failed`
- 成功：展示**服务端返回记录**的处置结果、处理时间（`serverTime`）、处理人（`operator`）、说明（`note`）；随后重新拉取该告警处置记录。成功提示只来自服务端 201/200 响应。
- 失败：显示真实失败原因（网络不可用/超时/5xx/404/409/400/会话失效等，文案明确“处置结果未保存”），**保留用户输入**与幂等键，不显示“已保存”。
- 时间语义：`serverTime` 缺失或 ≤0 时只显示“服务端时间未知”，绝不按 1970/客户端时间展示。

**已保存处置记录列表（面板内）**
- 来源：`GET /api/v1/alerts/{alarmId}/dispositions`（真实接口，按服务端顺序）。
- 行内容：处置结果 chip、处理时间（服务端 `serverTime`）、处理人（`operator`）、说明（`note`）。
- 三态：加载中（LoadingProgress+“正在加载处置记录…”）；失败（黄色告警框显示真实错误 + “重试查询”）；空（“该告警暂无已保存的处置记录”，不伪造记录）。

**演示模式（DemoMode）**
- 面板只显示“演示模式：处置结果不可提交 / 示例告警不会向服务端登记真实处置结果，也不会显示‘已保存’。”
- 不渲染输入表单与记录查询；`submitDisposition()` 入口直接 toast 拒绝；`GuardianService.submitDisposition/loadDispositions` 在 `gv.mode=demo` 时直接返回失败（双保险）。

## 3. 记录页（LogPage）

顶部 `NavBar` 标题改为“记录与日志”；`DemoModeBar` 保留；新增分段切换：

- **告警记录**（默认）：完全保留原有行为——搜索框、数量/更新时间、网络异常提示、`gv.alerts` 按本地日期分组、点击进入 `AlertDetailPage`。数据与失败表现未改。
- **安全日志**：
  - 数据来源：`GuardianService.loadSafetyLogs(50)` → `ApiClient.safetyLogs` → `GET /api/v1/safety-logs?limit=50`（持久化台账，**不是**由 `gv.alerts` 推导，也不用演示数据）。
  - 展示：按服务端 `serverTime` 的本地日期分组；`serverTime` 无效（缺失/0）的条目统一进入“时间未知”分组，不按 1970 展示。
  - 每条：告警类型、房间、设备、处理时间、处理人、处置结果、说明（说明最多 3 行省略）。
  - 点击条目：`pushUrl('pages/AlertDetailPage', { alertId: item.alarmId })` 回到对应告警详情。
  - 刷新：右上“刷新”重新请求；首次切换到安全日志 tab 才加载（切回不重复请求）。
  - 空态：加载中 loading；无数据“暂无安全日志（处置结果保存后会出现在这里）”；失败：顶部黄色错误条显示真实错误（网络不可用/超时/401/5xx 等）+“重试”，列表为空或保留上次真实数据，**绝不回退演示数据**。
  - 演示模式：不发起任何真实请求，显示“演示模式不查询真实安全日志”。

## 4. 失败/离线表现（真实错误，不伪造成功）

| 场景 | 处置提交 | 处置记录查询 | 安全日志查询 |
|---|---|---|---|
| 网络不可用 | 失败，“网络不可用，处置结果未保存”，保留输入 | 失败，“网络不可用，无法获取处置记录” | 失败，错误条+重试 |
| 超时 | 失败，“提交超时，处置结果未确认保存；请保持输入后重试” | 失败，“查询超时…” | 失败，错误条+重试 |
| 5xx / 503 | 失败，“服务端错误/服务暂不可用，处置结果未保存” | 失败，真实错误 | 失败，错误条+重试 |
| 400 | 失败，“处置内容不符合服务端要求，处置结果未保存” | — | — |
| 404 | “告警不存在或已失效，处置结果未保存” | “告警不存在或已失效，无法查询处置记录” | 真实错误 |
| 409 | “同一提交编号已存在不同内容，处置结果未保存；请修改后重新提交” | — | — |
| 401/403 | 失败 + 清会话回登录（沿用既有 setUnauthorized 语义） | 同左 | 同左 |
| serverTime 缺失/0 | 不当作有效时间，显示“服务端时间未知” | 同左 | 分组为“时间未知” |
| 未知 outcome | 不猜测语义：优先服务端 `outcomeLabel`，否则显示“未知结果” | 同左 | 同左 |

## 5. 无假数据回退（硬性）

- 处置“已保存”只可能由服务端 201/200 响应触发；网络/超时/5xx/202/结构非法一律失败。
- 不调用任何本地 ACK/告警状态写入；处置接口不改变告警状态、不生成 ACK 命令。
- 处理时间只使用服务端 `serverTime`（客户端时间仅用于生成幂等键，不参与展示语义）。
- 安全日志只来自 `GET /api/v1/safety-logs`；失败/空数据时不回退 `gv.alerts`、演示数据或本地缓存。
- 演示模式：处置不可提交、安全日志不查询真实接口。

## 6. 未覆盖 / 需真机确认

- 真机/模拟器 UI 渲染（处置面板滚动高度、200 字输入、LogPage 双 tab 布局、点击跳转）未在本会话验证；
- 真实后端联网闭环由 Lead/task-4 隔离集成验证（本 APP 侧仅用 SIMULATED 响应做逻辑测试）；
- HAP 构建与产物哈希见 `BUILD-RESULTS.txt`（由 Lead 构建写入）。
