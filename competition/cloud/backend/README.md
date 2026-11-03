# 独居老人监护端可信 API

这个服务是 OneNET/家庭边缘网关与监护人 APP（兼容微信小程序）之间的安全边界。它不包含任何真实账号、产品密钥、设备 Token 或微信 AppSecret。

## 已实现

- `POST /api/v1/auth/app`：监护人 APP 用账号和用户输入的口令换取两小时 HMAC 会话令牌；连续失败会返回 `429 + Retry-After`。
- `POST /api/v1/auth/wechat`：可选兼容入口。配置完整微信账号时接收 `wx.login` code；未配置时返回 `503`，不阻塞 APP-only 部署。
- APP v1 固定接口合同：`docs/APP-API-v1.md` 与机器可读的 `docs/APP-API-v1.json`。
- `POST /internal/v1/device-status`：边缘同步程序用独立 `x-ingest-key` 写入设备快照。
- `PUT /internal/v1/evidence/{evidenceId}`：用内部密钥上传不超过 2 MiB 的 JPEG；服务端校验 JPEG、SHA-256、设备 ID 和证据 ID，相同内容可幂等重传，冲突内容拒绝覆盖。
- `GET /internal/v1/commands?after=<id>`：边缘同步程序轮询待下发 ACK。
- 小程序查询：`overview`、`rooms`、`alerts`、`devices`、`location`、`contacts`。
- 家庭证据查询：`GET /api/v1/alerts/{alarmId}/evidence` 返回元数据，`.../content` 返回 `private, no-store` JPEG；两者都要求当前仍在家庭允许名单内的 Bearer 会话，不生成永久公开 URL。
- `POST /api/v1/alerts/{alarmId}/ack`：校验告警后创建定向 ACK 命令，并以 HTTP 202 返回 `PENDING`；设备未回执前绝不伪造 `ACKED`。
- `POST /api/v1/alerts/{alarmId}/dispositions`、`GET /api/v1/alerts/{alarmId}/dispositions`、`GET /api/v1/safety-logs`：告警处置结果与安全日志（v1 增量，schema v6）。**独立于 ACK**：绝不生成 ACK 命令、绝不改变告警状态或 `ackPending`、不触发设备 reset。
- `GET /api/v1/activity/report?scope=day|week|month[&date=YYYY-MM-DD]`：PIR 活动日/周/月报告（v1 增量，**独立 `version=1` 状态文件**，不进入主快照 schema v6）。`week`/`month` 是“截至所选日的**滚动** 7/30 天”，不是自然周/自然月；无数据一律 `null`，不补 0。
- 设备 ID、告警 ID、状态、请求体大小、会话签名和密钥比较均有限制。
- `PersistentStore` 使用版本化 JSON 快照持久化设备、告警、命令、联系人、通知/订阅台账、交流消息与安全日志；同步原子写入失败会回滚内存并返回脱敏 `503`。
- `EvidenceStore` 将 JPEG 与原子 `index.json` 分离保存，按 `deviceId + alarmId + evidenceId` 精确绑定；支持“图片先到”和“状态先到”，默认最多 200 条、保留 30 天。
- 正式 `npm start` 入口默认启用持久化存储；重启后恢复 PENDING/ACKED 命令，命令 ID 单调不复用。
- ACK 审计只保存通用角色 `household-guardian`，不把微信 `openid` 或完整允许名单写入持久化快照和告警响应。
- 告警订阅消息（可选）：`POST /internal/v1/device-status` 摄入 `ALARM` 后**异步**推送微信订阅消息；
  未配置模板时整个通知链路关闭。详见下文「告警订阅消息」。

当前持久化实现适合**单进程、小规模演示部署**，不实现跨进程锁或集群并发。公网生产仍需增加审计日志、速率限制和自动备份；多实例部署时应迁移到带事务和唯一约束的数据库。

## 远程交流（第一阶段）

监护人可从小程序给 DAYU200 留一条**短文字 + 一个预置语音**，DAYU 播报后回报状态，老人确认后闭环。

### 能力边界

本阶段只有：**文字 + 预置语音 ID + 老人确认**。
**不含**任意音频录制、实时通话、WebRTC、VoLTE 或自动电话；不得这样宣称。

### 接口

| 方向 | 接口 | 鉴权 |
|---|---|---|
| 监护人创建 | `POST /api/v1/communications/messages` `{clientMessageId, deviceId, text, voiceId, requestAck}` | Bearer 会话；身份只取 token 的 sub，请求体里的 openid/ownerRef 等一律拒绝 |
| 监护人查看 | `GET /api/v1/communications/messages?limit=20`、`GET /api/v1/communications/messages/{messageId}` | Bearer 会话；只能看到自己创建的消息 |
| 设备领取 | `GET /internal/v1/communications/pending?deviceId=&leaseId=&limit=` | `x-ingest-key` |
| 设备回报 | `POST /internal/v1/communications/{messageId}/report` `{deviceId, leaseId, event, failureCode?}` | `x-ingest-key`；播放流程的回报必须绑定当前租约，`event ∈ DELIVERED/PLAYED/ACKED/FAILED` |

状态机：`QUEUED → DELIVERED → PLAYED → ACKED`，旁路 `FAILED` / `EXPIRED`。
终态不可回退；重复回报幂等；未领取不能进入 DELIVERED/PLAYED/ACKED；别台设备不能确认。
`DELIVERED` 保留租约，代理在播放完成前崩溃时可在租约超时后重新领取；新租约产生后，旧代理的迟到回报会被拒绝。

### 输入校验（fail closed）

- `clientMessageId`：8-64 位 `[A-Za-z0-9._-]`，且不含 `..`
- `deviceId`：1-64 位 `[A-Za-z0-9._-]`，且必须是本户已知设备（否则 404）
- `text`：1-120 字符；拒绝 URL、路径（`/`、`\`、`C:\`、`..`）、shell 元字符、引号、控制字符、
  身份/密钥关键字、手机号、精确坐标
- `voiceId`：只能是 `CHECK_IN` / `PLEASE_RESPOND` / `MEDICINE_REMINDER` / `FAMILY_MESSAGE` / `EMERGENCY_CONTACTING`
- 客户端提交 `openid`、`ownerRef`、`household`、`token`、`phone`、`latitude` 等字段 -> 400

### 身份与隐私

会话 openid 经服务端 HMAC + 域分离派生成 `ownerRef`（`r1_` 前缀，不可反查），
因此交流台账里**没有 openid**。台账字段是严格白名单，出现 `openid` 等未知字段会拒绝加载。

### 预置语音

客户端只提交 voiceId；服务端把它解析成**固定资源文件名**（`VOICE_MAP`），设备端再用**自己那份白名单**复核。
客户端永远不能提供路径、文件名、URL 或命令。播放由 `southbound/comms-run.js` 用
`spawn('aa', args, {shell:false})` 执行，不存在字符串拼接与命令注入面。

### 持久化（v5 起，当前 v6）

新增顶层 `communications`。幂等键 = `ownerRef + deviceId + clientMessageId`
（同一个 clientMessageId 发给**不同设备**是两条独立消息——否则留言会发错房间）。
同一幂等键若改了正文、voiceId 或 requestAck，返回 409，不会把旧消息伪装成新请求成功。
容量上限 300，按 `updatedAt` 淘汰最旧；沿用既有原子写入与失败回滚。
v1/v2/v3/v4 快照都能加载，v4 升级后 `notifications` / `subscriptions` 逐字段不变。

### 已知边界

**DAYU200 真机播放已验证**：五种预置资源均已在真实 DAYU 上达到 AVPlayer
`completed` 并返回匹配回执；另有一条真实本地后端留言完成
`QUEUED -> DELIVERED -> PLAYED`。证据见
`docs/evidence/2026-10-15-dayu-preset-voice-playback.md` 与
`docs/evidence/2026-10-15-real-backend-dayu-played.md`。公网手机链路和实体按钮
`ACKED` 仍未验证，`PLAYED` 不等于 `ACKED`。

## 告警处置结果与安全日志（v1 增量，schema v6）

告警详情除了既有 ACK 面板外，还允许监护人登记**处置结果**（已联系家属/社区、现场确认正常、
误报、其他说明）并持久化为安全日志。合同见
`evidence/2026-10-26-alert-disposition-safety-log/CONTRACT.md`，APP 接入见
`docs/APP-API-v1.md` 4.1 节。

### 接口

| 方法与路径 | 鉴权 | 说明 |
| --- | --- | --- |
| `POST /api/v1/alerts/{alarmId}/dispositions` | Bearer 会话 | 登记处置结果；首次 `201`，同内容重放 `200 duplicate`，同 `clientDispositionId` 改内容 `409` |
| `GET /api/v1/alerts/{alarmId}/dispositions` | Bearer 会话 | 单条告警的处置记录；`serverTime` 降序，同刻按 `dispositionId` 数值降序 |
| `GET /api/v1/safety-logs?limit=50[&alarmId=...]` | Bearer 会话 | 跨告警安全日志；`limit` 1-200 默认 50，来自持久化台账，重启后仍可查 |

### 边界：处置 ≠ ACK

- 处置接口**绝不**调用 `store.requestAck()` / `store.completeCommand()`，**绝不**生成 ACK 命令，
  **绝不**触发设备 ACK/reset；设备侧 ACK 闭环仍由既有 `POST /api/v1/alerts/{alarmId}/ack` 独立完成。
- 登记处置**不改变** `alert.status`、不清 `ackPending`、不写 `commands`；告警处于 `ALARM`
  （含 `ackPending=true`）或 `ACKED` 时都可以登记。
- 单户部署下家庭权限 = 合法 Bearer 监护人会话（沿用既有 `401/403`）。
- 不记录 openid/token/密码/手机号：操作者只保存通用角色 `household-guardian`
  （展示名 `家庭监护人`）；`serverTime` 一律服务端时钟，客户端提交时间/身份字段直接 `400`。

### 校验（fail closed）

- `alarmId`：`^[A-Za-z0-9._:-]{1,80}$`（URL 解码后校验）；未知告警 `404`。
- `clientDispositionId`：8-64 位 `[A-Za-z0-9._-]`，且不含 `..`。
- `outcome`：`CONTACTED_FAMILY` / `CONTACTED_COMMUNITY` / `ON_SITE_CONFIRMED_NORMAL` /
  `FALSE_ALARM` / `OTHER` 五者之一。
- `note`：0-200 字符；`\r`/`\n` 归一为单个空格后去掉首尾空白；拒绝 C0/DEL/C1 控制字符；
  `OTHER` 必须非空说明。
- 请求体字段白名单只有 `clientDispositionId`/`outcome`/`note`，其他字段一律 `400`；请求体上限 8 KiB。

### 持久化（schema v6）

顶层新增 `safetyLogs` 数组；`schemaVersion=6`，`1..6` 均可加载，加载 v1-v5 时 `safetyLogs=[]`，
下一次成功变更写 v6。单条记录严格白名单：

```text
dispositionId, clientDispositionId, alarmId, deviceId, room, type,
outcome, note, actor, serverTime
```

- `dispositionId = dsp-<n>`，`n` 为已持久化最大 ID + 1（重启/淘汰后都不复用、不重复）。
- 首次创建写盘；**幂等重放与冲突都不写盘**（写盘失败回滚内存，含 ID 分配）。
- 容量上限 2000，超出按写入顺序淘汰最旧（告警本身不淘汰）。
- 加载校验 fail-fast：`dispositionId` 唯一且严格递增、`alarmId` 必须指向已加载告警且
  `deviceId` 一致、`(alarmId, clientDispositionId)` 唯一、`note` 必须是已归一化文本、
  `actor` 固定 `household-guardian`；未知字段（含 openid/token）直接拒绝启动。

### 验证

- `test/safety-log.test.js`：纯模块校验全边界。
- `test/safety-log-api.test.js`：真实 HTTP（`createApiServer` + `MemoryStore` + 进程内随机测试凭据）
  覆盖 401/403/404/400/409/201/200、排序、过滤、ACK 行为不变、处置不改变告警/命令。
- `test/safety-log-persistent.test.js`：v1-v5 迁移、跨重启、ID 单调、幂等不写盘、损坏快照拒绝、写失败回滚、2000 容量。
- `test/safety-log-isolated.integration.js`：临时数据文件 + `127.0.0.1` 随机端口的隔离集成，
  重启后安全日志仍可查，且只存在既有 ACK 命令、无任何处置产生的命令。

## PIR 活动日/周/月报告（v1 增量，独立 `version=1` 存储）

### 接口

```http
GET /api/v1/activity/report?scope=day|week|month[&date=YYYY-MM-DD]
Authorization: Bearer <sessionToken>
```

- `scope` 缺省 `day`，非法 → `400`；`date` 非法/非真实日历日期 → `400`；未注入活动存储 → `503`。
- 家庭时区 = `HOUSEHOLD_TIMEZONE`（默认 `Asia/Shanghai`，非法值**拒绝启动**）。
- 窗口：`day` = 选中日 `00:00–24:00`；`week` = 截至选中日的**滚动 7 天**；
  `month` = 截至选中日的**滚动 30 天**（都不是自然周/自然月）。`previous` = 紧邻所选窗口的等长窗口。
- 响应字段与语义以 `docs/APP-API-v1.md` §4.2 为准；`dataSince` 是 **number（epoch 毫秒，0=无数据）**，
  服务端不返回 `dataSinceMs`/`dataSinceText`。

### 文件与持久化

| 文件 | 作用 |
| --- | --- |
| `src/activity.js` | 纯逻辑：家庭时区切日切小时、`countToday` 正增量、reset/跨日、覆盖率、趋势、对比、报告 |
| `src/activity-store.js` | 独立状态文件（`version = 1`，临时文件 + fsync + rename，失败回滚内存并抛出） |
| `src/main.js` | 接线 `ActivityStore`（`BACKEND_ACTIVITY_FILE`，默认与主快照同目录 `activity-state.json`） |
| `src/server.js` | 摄入后 `recordStatus`；`GET /api/v1/activity/report` |

- 活动文件与主快照 `backend-state.json`（schema v6）**完全独立**，各自版本化；备份/回滚必须分别处理。
- 活动文件损坏或结构非法 → **fail-closed 拒绝启动**，不静默清空历史；运维需先移走该文件留档再重启。
- 活动写入失败**不改变** `/internal/v1/device-status` 的既有 `202` 语义，只打印
  `[backend] ACTIVITY_RECORD_FAILED code=...`：**自然的 202 不能证明活动统计已落盘**。
- 保留：每设备最多 400 个日桶；没有 PIR 的载荷不产生样本、更不写 0 次活动。

### 验证

- `test/activity.test.js`：时区切日、首次样本只建基线、重复累计值不重复计数、计数回退/设备重启、
  跨日滚动、无 PIR 设备不补 0、非法样本、长断连只降覆盖率、覆盖率阈值、400 天保留、趋势与对比
  不用 0 代替缺失、损坏文件 fail-closed、首次记录 0600 原子写、写失败回滚、`dataSince` 保持 null。
- `test/activity-api.test.js`：Bearer/403/400 契约、真实 HTTP 摄入→报告、`null` 不显示 0、`week`/`month`
  显式范围、写失败仍是 202、未注入存储 503、活动持久化独立于主快照并可跨重启、运行时接线与时区 fail-closed。

## 告警订阅消息

### 组成

| 文件 | 作用 |
| --- | --- |
| `src/notify-provider.js` | 微信订阅消息**提供者接口** + 生产实现 + `TokenManager`（access_token 缓存 / 提前刷新 / 失效刷新 / 单飞）与错误分类 |
| `src/notify-delivery.js` | 投递编排：模板字段、**按收件人独立**的幂等与重试、授权额度消耗、启动恢复、fire-and-forget 入口 |
| `src/notify-privacy.js` | 该链路统一的日志/错误脱敏（openid、access_token、AppSecret、手机号、精确坐标）与 `recipientRef` 派生 |
| `src/persistent-store.js` | 投递台账（`notifications`）与订阅授权额度（`subscriptions`）落到既有快照（schema v4） |

### 关键概念：允许登录 ≠ 已订阅

`WECHAT_ALLOWED_OPENIDS` 只决定**谁能登录**。用户是否真的接受过一次性订阅，
只能由小程序 `wx.requestSubscribeMessage` 的结果回答。因此：

```
可投递收件人 = 允许登录名单 ∩ 已登记订阅授权（且仍有可用额度）
```

小程序在 `accept` / `acceptWithAudio` 之后必须调用
`POST /api/v1/notifications/subscription` 登记；`reject` / `ban` / `cancel` / `failed` 一律不登记。
该接口复用现有 Bearer 会话鉴权，收件人取自 token 的 `sub`——
**请求体里的任何 openid 字段都会被忽略**，因此客户端无法替别人登记。

### 隐私：只用 recipientRef，不落原始 openid

持久化里出现的是 `recipientRef = r1_ + HMAC-SHA256(RECIPIENT_REF_SECRET, 域分离前缀 + openid)`。

- 用**带密钥的 HMAC**，不是裸 SHA-256：openid 空间可枚举，裸哈希等于可反查的匿名标识；
- 显式域分离字符串避免同一密钥在其他用途下产生可关联标识；
- `RECIPIENT_REF_SECRET` 至少 32 字符，未配置时从 `API_TOKEN_SECRET` 做域分离派生；
- 密钥只在内存里，**绝不**进入日志、响应或快照。

### 按收件人独立的投递语义

幂等键是 `deviceId + alarmId + recipientRef`（不是一个告警一条全局记录）：

- 已 `SENT` 的收件人在后续重试中**不再被发送**（修掉了"a 成功 b 失败时重复发 a,b,a,b"）；
- 一个收件人永久失败（如 43101）**只终止该收件人**，不影响其他收件人；
- 只有微信确认发送成功后才消耗该收件人的一次性额度；临时网络错误不消耗；
- 43101 会把该收件人的本地可用额度用独立的 `revoked` 计数校正为 0；
- 聚合结果表达为 `ALL_SENT` / `PARTIAL` / `FAILED` / `NO_RECIPIENTS`。

### 启动自动恢复

后端启动时会扫描台账里状态为 `FAILED`（临时失败耗尽）的**收件人任务**并在后台补发：

- `SENT` 与 `PERMANENT_FAILED` 是终态，**永不重发**；
- 收件人 openid 由允许名单 + 同一 HMAC 重新派生 ref 后匹配，openid 只存在于内存；
- 告警上下文（room/type/createdAt）从既有 `alerts`/`devices` 安全重建，不需要持久化位置或身份；
- 恢复在后台运行，**不阻塞** `/healthz`、`/readyz`、设备摄入与 ACK；
- 关闭时先 `beginShutdown()`（不再发起新重试）再 `drain()`（有界等待在途投递）。

### 配置

| 变量 | 说明 |
| --- | --- |
| `WECHAT_SUBSCRIBE_TEMPLATE_ID` | 订阅消息模板 ID。**未设置/空串 = 通知功能关闭**。占位串（含 `replace`、`example`、`xxx` 等）会**直接拒绝启动**，避免带着假模板运行 |
| `WECHAT_SUBSCRIBE_PAGE` | 点击通知跳转的小程序页，默认 `pages/alarms/index` |
| `RECIPIENT_REF_SECRET` | 可选。recipientRef 的 HMAC 密钥（≥32 字符）；未配置时从 `API_TOKEN_SECRET` 域分离派生 |
| `NOTIFY_MAX_ATTEMPTS` | **单个收件人**的最大尝试次数，默认 3（1-10） |
| `NOTIFY_BASE_DELAY_MS` | 退避基数，默认 500 |
| `NOTIFY_MAX_DELAY_MS` | 退避上限，默认 8000 |

收件人 = 允许登录名单 ∩ 已登记授权；没有任何可投递收件人时不会发送，也不会消耗投递记录。

### 行为保证

- **幂等**：同一 `deviceId + alarmId + recipientRef` 只发送一次；已 `SENT` 的收件人重启后也不会重发。
- **重试**：超时、网络错误、`429`、`5xx`、`40001/42001`（token 失效）按指数退避重试；
  `43101`（用户拒收）、`40003`（非法 openid）、`40037`（模板无效）、`41030`（页面不存在）等
  永久失败立即停止，不再消耗配额。
- **不阻塞主链路**：投递是 fire-and-forget；通知失败、provider 抛异常、台账写盘失败、
  允许名单回调抛异常，都不会影响设备状态摄入（仍返回 202）、ACK 或后端主服务。
- **隐私**：台账只保存 `deviceId/alarmId/recipientRef/templateId/status/attempts/attemptCount/sentAt/updatedAt/errorCode`；
  订阅额度只保存 `recipientRef/templateId/totalGranted/consumed/revoked/grantEventIds/grantedAt/updatedAt`。
  未知字段一律拒绝（含 `openid`）。日志与错误经 `notify-privacy` 脱敏。
  `getStatus()` 也不回显模板 ID 与 token。
- **未配置即显式未配置**：没有模板 ID 时不发送、不探测，返回 `NOT_CONFIGURED`，绝不假装成功。
- **授权登记**：`POST /api/v1/notifications/subscription` 需要 Bearer 会话；无 token 401、
  非允许名单 403、模板不一致 409、未配置 503、同一 `grantEventId` 幂等。

### 已知边界

真实微信订阅消息**尚未发送成功过**：本地测试全部使用注入的 fake provider 与内存/临时目录台账，
不访问微信 API、不使用真实 AppID/AppSecret/openid。用户每接受一次授权，后端只能推送一条对应消息；
"用户是否已授权" 由微信侧决定，本地无法完全模拟，因此真实投递与用户实际收到通知均未验证。

## 本地测试

```powershell
cd <WORKSPACE>\competition\cloud\backend
npm run check
npm test
npm run test:restart
```

在禁止子进程管道的受限沙箱里，`npm test` 默认会为每个测试文件 spawn 子进程而失败（Windows `EPERM`），
可用 `npm test -- --test-isolation=none` 在同一进程内按同一发现规则跑完整套测试。

当前验收：后端全套 **252/252**（`node --test --test-isolation=none`），包含既有告警/证据/交流/通知回归，
以及本轮新增的告警处置结果与安全日志：纯模块合同边界、真实 HTTP 接口（401/403/404/400/409/201/200、
排序/过滤、既有 ACK 行为不变、处置不改变告警状态与命令）、schema v1-v5→v6 迁移与跨重启查询、
`dispositionId` 单调不复用、幂等重放不写盘、损坏快照拒绝、写盘失败回滚、2000 条容量淘汰，
以及临时数据文件 + 本机随机端口 + 重启的隔离集成。另有 `cloud/onenet/persistent-command-restart-integration.js`
**14/14**，证明 PENDING 命令跨重启后仍可被边缘同步器处理，ACKED 结果再次重启后仍可查询。

## 运行约束

复制 `deploy/.env.deploy.example` 的变量名到部署平台的 Secret 管理中，不要把真实值写回工程。APP-only 模式必须设置 `APP_GUARDIAN_ID` 与 `APP_GUARDIAN_PASSWORD`；后者为 8-256 字符，只允许用户输入，禁止硬编码进 APK。微信三项配置可以全部留空；若启用，则 `WECHAT_APP_ID`、`WECHAT_APP_SECRET`、`WECHAT_ALLOWED_OPENIDS` 必须同时填写。`main.js` 不自动读取 `.env` 文件，防止开发机明文配置被误带入制品。`BACKEND_DATA_FILE` 和 `BACKEND_EVIDENCE_DIR` 必须指向可写、可备份的持久卷；证据默认最多 200 条、30 天，可用 `EVIDENCE_MAX_EVENTS` 和 `EVIDENCE_RETENTION_DAYS` 收紧。

服务默认只监听 `127.0.0.1`；容器中通过 `HOST=0.0.0.0` 监听容器网络。公网部署时必须使用可信反向代理或云负载均衡提供 HTTPS、有效域名和证书。不要把 `INGEST_KEY`、`API_TOKEN_SECRET`、`APP_GUARDIAN_PASSWORD`、`WECHAT_APP_SECRET` 或任何 OneNET 密钥放进客户端。

## OCI / Docker 制品

`Dockerfile` 以非 root 的 `node` 用户运行，状态文件固定在 `/data/backend-state.json`，镜像内不包含 `.env`、测试和本地数据。构建与运行示例中的真实密钥必须由部署平台 Secret 注入：

```sh
docker build -t eldercare-cloud-backend .
docker run --rm -p 127.0.0.1:8080:8080 -v eldercare-backend-data:/data \
  -e API_TOKEN_SECRET -e INGEST_KEY -e APP_GUARDIAN_ID -e APP_GUARDIAN_PASSWORD \
  -e CONTACTS_JSON \
  eldercare-cloud-backend
```

当前开发机未安装 Docker，因此只完成了 Dockerfile 静态安全检查，尚未实际构建镜像。

## 尚未完成

- 尚未使用真实微信 AppID/AppSecret 调用微信登录。
- ~~尚未把 OneNET 消息同步到 `/internal/v1/device-status`。~~ **已完成（2026-10-10）**：`cloud/onenet/cloud-sync.js` 在网关侧把聚合状态同步到该接口，端到端验收 `cloud/onenet/cloud-sync-integration.js` 12/12（真实后端 + 真实同步客户端 + 小程序视角的查询接口），仍待真实公网部署。
- ~~尚未将命令队列的 ACK 发布到设备下行主题。~~ **本地代码与模拟设备闭环已完成（2026-10-11）**：精确定向 `home/<deviceId>/cmd`、等待真实新回执、结果回写和跨后端重启恢复均通过；实体设备仍待验收。
- 尚未部署到公网 HTTPS，也没有做真实手机和微信审核测试。
- 图片上传、授权读取和微信临时文件预览只完成了本地真实 HTTP/自动化测试；尚未经过公网 HTTPS、正式微信 AppID、开发者工具和手机真机。

