# 告警处置结果 / 安全日志 API 扩展合同（v1 增量）

日期：2026-10-26
状态：**本轮实施合同**（新增，向后兼容；不改动既有 ACK 语义）
任务：ALERT-DISPOSITION-SAFETY-LOG

## 0. 强制边界

- 只新增接口与持久化台账；**不改变** `POST /api/v1/alerts/{alarmId}/ack` 的既有行为/响应。
- 新增处置接口**绝不**调用 `store.requestAck()`/`store.completeCommand()`，**绝不**生成 ACK 命令，**绝不**触发设备 ACK/reset。
- 处置记录独立于 ACK：告警处于 `ALARM`（含 `ackPending`）、`ACKED` 时都允许登记处置结果。
- 处置保存**不得**把告警状态改成 ACKED，也不得清 `ackPending`。
- 本部署为单户版（`docs/household-auth.js` 单户语义）。家庭访问权限 = 合法 Bearer 监护人会话（沿用现有 401/403）。
- 不记录任何 token/openid/密码/手机号；操作者只保存通用角色（与既有 ACK 审计约定一致）。
- 不使用客户端时间；`serverTime` 一律服务端 `Date.now()`；客户端伪造时间/身份字段一律 400。

## 1. 处置结果枚举

| outcome | 展示文案 |
|---|---|
| `CONTACTED_FAMILY` | 已联系家属 |
| `CONTACTED_COMMUNITY` | 已联系社区 |
| `ON_SITE_CONFIRMED_NORMAL` | 现场确认正常 |
| `FALSE_ALARM` | 误报 |
| `OTHER` | 其他说明 |

## 2. 接口

### 2.1 登记处置结果

```http
POST /api/v1/alerts/{alarmId}/dispositions
Authorization: Bearer <sessionToken>
Content-Type: application/json

{"clientDispositionId":"disp-1730000000000-a1b2","outcome":"CONTACTED_FAMILY","note":"已联系家属，老人安全"}
```

请求体字段白名单：`clientDispositionId`、`outcome`、`note`（**其他字段一律 400**，含 `alarmId`/`deviceId`/`operator`/`serverTime`/`openid`/`ownerRef`/`household`）。

校验：
- `alarmId`：沿用 `ALARM_ID_RE`（`^[A-Za-z0-9._:-]{1,80}$`），URL 解码后再校验。
- `clientDispositionId`：8–64 位 `[A-Za-z0-9._-]`，且不含 `..`（与留言客户端 ID 同规则）。
- `outcome`：只能取第 1 节枚举值。
- `note`：`string`；去掉首尾空白并把 `\r`/`\n` 归一为单个空格后，长度 0–200 字符；拒绝 C0/DEL/C1 控制字符；`outcome=OTHER` 时 note 必须非空。

响应：
- `201 Created`（首次）：`{"created":true,"disposition":<PublicDisposition>}`
- `200 OK`（同一 `alarmId + clientDispositionId` 且内容相同，幂等重放）：`{"created":false,"duplicate":true,"disposition":<PublicDisposition>}`
- `409`（同一 `alarmId + clientDispositionId` 但 outcome/note 不同）：`{"error":"clientDispositionId payload conflict"}`
- `404`：`{"error":"alarm not found"}`
- `400`：`{"error":"invalid disposition"}` 或 `{"error":"invalid alarm id"}`
- `401/403`：沿用现有会话鉴权。
- `503`：存储失败（沿用 `publicError` 的 storage unavailable）。

`PublicDisposition`（API 只暴露这些字段）：

```json
{
  "dispositionId": "dsp-1",
  "alarmId": "alarm-a1",
  "deviceId": "esp32-kitchen",
  "roomName": "厨房",
  "alarmType": "SOS",
  "alarmCreatedAt": 1792949000000,
  "outcome": "CONTACTED_FAMILY",
  "outcomeLabel": "已联系家属",
  "note": "已联系家属，老人安全",
  "operator": "家庭监护人",
  "operatorRole": "household-guardian",
  "serverTime": 1792949100000
}
```

### 2.2 单条告警的处置记录

```http
GET /api/v1/alerts/{alarmId}/dispositions
Authorization: Bearer <sessionToken>
```

- `200`：`{"alarmId":"...","dispositions":[<PublicDisposition>...]}`；按 `serverTime` 降序，同刻按 dispositionId 数值降序。
- `404`：未知 alarmId。
- 无记录时为 `{"alarmId":"...","dispositions":[]}`（不伪造数据）。

### 2.3 安全日志历史

```http
GET /api/v1/safety-logs?limit=50[&alarmId=...]
Authorization: Bearer <sessionToken>
```

- `limit`：1–200，默认 50；非法值回退默认。
- 可选 `alarmId` 过滤；给了未知 alarmId 返回 404。
- `200`：`{"logs":[<PublicDisposition>...]}`，排序同上。
- 该列表来自持久化台账，backend 重启后仍可查询；不是由当前 `alerts` 现场推导。

## 3. 持久化（schema v6）

顶层白名单新增 `safetyLogs` 数组。快照版本 `schemaVersion=6`；`1..6` 均可加载，加载 v1–v5 时 `safetyLogs=[]`，下一次成功变更写 v6。

单条持久化字段（严格白名单，加载时校验）：

```text
dispositionId, clientDispositionId, alarmId, deviceId, room, type,
outcome, note, actor, serverTime
```

存储规则：
- `dispositionId` = `dsp-<n>`，`n` 为持久化单调递增正整数（重启不复用、不重复），正则 `^dsp-[1-9][0-9]{0,15}$`。
- `actor` 固定 `household-guardian`（既有 ACK 审计通用角色；单户部署下即当前监护人账号角色；不落 openid/token）。
- 台账容量上限 2000 条，超出按写入顺序淘汰最旧（安全日志可保留最近 2000 条处置记录；API 仅展示仍有告警关联的记录；告警本身不淘汰）。
- 加载校验：`alarmId` 必须指向已加载告警且 `log.deviceId === alert.deviceId`；`dispositionId` 唯一且严格递增；`clientDispositionId` 在 `(alarmId,clientDispositionId)` 内唯一；非法/重复/越界 fail-fast 拒绝启动（沿用现有 persistent store 风格）。
- 写入失败回滚内存（沿用 `_captureState`/`_commit`）。

内存态接口（`MemoryStore` 与 `PersistentStore` 均实现）：

```js
createDisposition({ alarmId, clientDispositionId, outcome, note }) -> { created, disposition }
listDispositions(alarmId) -> [record]
listSafetyLogs({ limit, alarmId }) -> [record]
getDisposition(dispositionId) -> record|null
```

`PersistentStore` 覆盖 `createDisposition` 并在成功后同步落盘；仅首次创建写盘，幂等重放不写盘。

## 4. APP 行为要求

- 告警详情页：
  - 既有 ACK 面板保持不变；ACK 与处置结果**分开展示**；
  - 新增“处置结果”面板：5 个结果选项 + 说明输入（≤200）+ 提交；
  - 提交中禁止重复提交；成功后展示服务端返回的 `serverTime`、`operator`、`outcomeLabel`、`note`，并刷新该告警处置记录；
  - 失败（网络/超时/5xx）**不得**显示“已保存”，保留用户输入并给出真实失败提示；
  - 展示该告警既有处置记录列表（时间/处理人/结果/说明）；
  - 演示模式不提交真实处置（与 ACK 一致）。
- 安全日志页：提供“告警记录 / 安全日志”切换；安全日志列表来自 `GET /api/v1/safety-logs`，展示告警、房间、处理时间、处理人、结果、说明；加载失败显示真实错误，不回退到演示数据；点击可回到对应告警详情。
- 解析必须防御式：缺字段不崩溃，未知字段忽略；`serverTime=0` 不得显示为有效时间。

## 5. 验收口径（本轮）

1. 本地 `npm test`（backend 全量）通过，包含新增合同/持久化/重启测试。
2. 隔离集成：临时数据文件 + 本地端口启动 backend，用既有 `createSessionToken` 签发测试会话，验证全部接口；**只使用测试告警 fixture**，不向生产 ingest 发任何数据。
3. 重启验证：同一数据文件重启后 `GET /api/v1/safety-logs` 仍能查到处置记录；ACK 命令/告警状态未被处置接口改变。
4. APP：`hvigorw test` 通过 + `assembleHap` BUILD SUCCESSFUL；记录产物大小/SHA-256。
5. 真机/公网验收需用户明确授权（部署公网 backend + 安装新 HAP）；本轮不擅自部署生产、不 ACK 既有告警、不制造 SOS/FALL。
