# 告警确认 → 处置结果 → 安全日志（ALERT-DISPOSITION-SAFETY-LOG）报告

- 日期：2026-10-26（Asia/Shanghai）
- 任务：ALERT-DISPOSITION-SAFETY-LOG
- 分类：**`LOCAL_IMPLEMENTED_AND_ISOLATED_VERIFIED_REAL_ACCEPTANCE_BLOCKED`**
  （已实现 + 本地测试/构建 + 隔离集成验证通过；真机/公网真实验收被“公网部署授权 + HAP 安装 + 用户选择既有告警”阻塞）
- 前置读取：`competition/evidence/2026-10-26-core-gap-freeze/` 需求矩阵（D1 已真实验收；D2/D3 仅部分实现）、既有 ACK 合同 `competition/docs/APP-API-v1.md` §4、backend 基线源码。

## 1. 目标与边界

在既有“告警详情 → ACK（202 入队，等待设备回执）”能力之上，补齐**独立于 ACK**的人工处置闭环：

```text
查看告警 → 确认(既有 ACK，保持原语义) → 填写处置结果+说明 → 保存 → 历史安全日志查询
```

- ACK ≠ 已处置：ACK 仍是“命令入队/等待设备 ACKED”；处置结果单独记录。
- 新增处置**绝不**生成 ACK/reset 命令、不改告警状态、不清 `ackPending`。
- 不使用客户端时间/身份；服务端时间、固定操作者角色。
- 本轮不改公网 backend、不部署、不安装 HAP、不操作设备、不触发/ACK 任何既有告警。

## 2. 缺口基线（实施前的事实）

| 能力 | 实施前状态 | 依据 |
|---|---|---|
| ACK | 真实闭环（2026-10-22 实体 SOS→APP ACK→202→设备 ACKED），本轮不改 | `competition/docs/evidence/2026-10-22-live-nodes-and-guardian-ack-acceptance.md` §4 |
| 处置说明 | 只作为 ACK 命令的 `note/action`（≤120，落 `alert.action`/`command.action`，`GET /alerts` 不返回、APP 不显示） | 基线 `backend/src/store.js` `requestAck`；`docs/APP-API-v1.md` §4 |
| 安全日志 | 仅 DAYU 设备本地 `/data/homemon/safety.log`（只记 ACK，设备重置即丢，APP/后端不可查）；APP“安全日志”页实为 alerts 按日期分组 | `southbound/src/homemon.c:503-547`；基线 `LogPage.ets:1-2` |
| 独立处置/持久安全日志 | **不存在**（schema v5 无 safetyLogs；无后端接口） | 基线 `persistent-store.js`（SCHEMA_VERSION=5） |

## 3. 实现（D 类，按 `CONTRACT.md`）

### 3.1 Backend（`competition/cloud/backend`）

| 文件 | 变更 |
|---|---|
| `src/safety-log.js` | **新增**：5 个 outcome 及固定文案、严格请求白名单（仅 `clientDispositionId/outcome/note`）、note 归一化（CRLF→单空格、trim、≤200、拒绝控制字符、`OTHER` 必填）、`publicDisposition` 公开投影、`dsp-N` 正则 |
| `src/store.js` | `MemoryStore` 新增 `safetyLogs` 台账与 `createDisposition/listDispositions/listSafetyLogs/getDisposition`；**不触碰** `alerts/commands/devices` |
| `src/persistent-store.js` | schema **v6**：`READABLE 1..6`、白名单新增 `safetyLogs`、加载严格校验（告警/设备绑定、ID 唯一且严格递增、alarm 内 clientDispositionId 唯一）、`_maxDispositionId` 重启不复用、仅首次创建写盘、容量 2000 淘汰最旧、写盘失败回滚 |
| `src/server.js` | 新增 3 路由（见 3.2）；8 KiB body 上限；401/403 沿用既有 Bearer 鉴权 |
| `package.json` | `check` 加入 `safety-log.js` |
| `README.md` | schema v6、新接口、“处置≠ACK”边界、单户权限 |
| `docs/APP-API-v1.md` | 新增 §4.1，合同版本 1.0.0→**1.1.0**（仅增量，既有语义未改） |
| `test/safety-log.test.js` | 新增 14 条纯模块边界 |
| `test/safety-log-api.test.js` | 新增 14 条真实 HTTP 合同 |
| `test/safety-log-persistent.test.js` | 新增 9 条（v1–v5→v6、重启、回滚、容量、损坏快照） |
| `test/safety-log-isolated.integration.js` | 新增 1 条隔离集成 |
| `test/comms-store.test.js` | v4→当前 schema 迁移断言从硬编码 5 改为 `SCHEMA_VERSION`，未削弱既有断言 |

### 3.2 API（v1 增量）

| 方法/路径 | 语义 |
|---|---|
| `POST /api/v1/alerts/{alarmId}/dispositions` | 首次 201 `{created:true, disposition}`；同 `clientDispositionId` 同内容幂等 200 `{created:false,duplicate:true}`；同 ID 改内容 409；未知告警 404；非法 400 |
| `GET /api/v1/alerts/{alarmId}/dispositions` | `{alarmId, dispositions[]}`，按 `serverTime` 降序 |
| `GET /api/v1/safety-logs?limit=50[&alarmId=]` | `{logs[]}`；limit 1–200 非法回退 50；来自持久化台账（非从 alerts 现场推导） |

`PublicDisposition`：`dispositionId/alarmId/deviceId/roomName/alarmType/alarmCreatedAt/outcome/outcomeLabel/note/operator/operatorRole/serverTime`。操作者按单户部署固定角色 `household-guardian`（展示“家庭监护人”），不落 openid/token。

### 3.3 持久化（schema v6）

```text
dispositionId, clientDispositionId, alarmId, deviceId, room, type,
outcome, note, actor, serverTime
```

- 加载 v1–v5 时 `safetyLogs=[]`，下一次成功变更写 v6；旧 v5 代码不能读 v6（回退必须恢复升级前快照，见 `DEPLOY-DIFF-AND-ROLLBACK.md`）。
- **修改策略**：台账 append-only，不提供无痕覆盖接口；更正 = 新增一条处置记录（历史保留），满足“若允许修改则保留修改历史”的约束。

### 3.4 APP（`APP/ElderlyCareGuardian`）

- `core/api/Contracts.ts`：`DispositionDto/SafetyLogDto/DispositionResultDto` 防御式解析；`serverTime<=0` 不算有效时间；outcome 枚举/文案；note/clientId/alarmId/limit 校验归一化。
- `core/api/ApiClient.ts`：`dispositions`/`createDisposition`/`safetyLogs`；201=首次、200=幂等重放，其他 2xx（含 202）=MALFORMED（不冒充成功）。
- `core/service/Outcomes.ts`、`service/GuardianService.ets`：三个服务方法，沿用会话代际保护；网络/超时/5xx 明确“未保存”；demo 模式拦截。
- `core/view/Models.ts`、`ViewMapper.ts`：`DispositionView`（时间无效态）、结果文案映射、选项列表、列表映射。
- `pages/AlertDetailPage.ets`（1067→1560 行）：**ACK 面板与状态机保持不变**，新增独立“处置结果”面板：5 个结果选项、说明 ≤200 字计数、提交防重、成功展示服务端 `serverTime/operator/outcomeLabel/note`、失败保留输入且不显示已保存、已保存记录三态、演示模式禁用。
- `pages/LogPage.ets`（309→657 行）：“告警记录 / 安全日志”切换；安全日志只来自 `GET /api/v1/safety-logs`，失败真实错误+重试、无演示回退、无效时间归“时间未知”、点击回跳告警详情。
- `entry/src/test/Disposition.test.ets`（Hypium 18 条，已注册 `List.test.ets`）、`tests/disposition.test.mjs`（Node 22 条）。

## 4. 验证结果（本地真实执行）

| 验证 | 命令/方式 | 结果 |
|---|---|---|
| Backend 全量测试 | `NODE_OPTIONS=--test-isolation=none npm test`（沙箱规避 spawn；非沙箱直接 `npm test`） | **274/274 pass, exit 0**（含并行会话测试；D 定向 37/37） |
| Backend 语法检查 | `npm run check` | exit 0 |
| D 定向测试 | `node --test test/safety-log*.test.js` | **37/37 pass** |
| 隔离集成（Lead 独立脚本） | 临时数据文件 + 127.0.0.1 随机端口 + TEST fixture + 重启 | **37/37 断言通过，ISOLATED_PASS**（详见 `ISOLATED-VERIFY.md`/`ISOLATED-VERIFY.json`） |
| ACK 兼容 | 隔离脚本内既有 `POST /ack` | 202 PENDING；处置后 commands 仍 0；ACK 后 commands=1；处置不生成命令、不改状态 |
| 重启持久化 | 同一数据文件重建 store+server | safety-logs 3 条、单告警处置 3 条、ACKED 状态/时间/回执人保留 |
| 快照安全 | 扫描 temp backend-state.json | schema 6、顶层/记录白名单、无 token/口令/openid |
| APP Hypium | `hvigor test`（DevEco 本地单元测试预览器） | **Tests run 39 / Pass 39 / Failure 0**（D 18 条全 Success） |
| APP HAP | `hvigor assembleHap` | **BUILD SUCCESSFUL**；2,613,947 B；SHA-256 `2CFB8908…EAF91DF`（unsigned） |
| APP 主机侧测试 | 逐文件 in-process `node tests/<file>.test.mjs` | 18 文件 241/241 pass（D 新增 22 条全通过；含并行 E 追加 6 条） |

证据：`backend/TEST-RESULTS.txt`、`backend/ISOLATED-INTEGRATION.md`、`app/TEST-RESULTS.txt`、`app/BUILD-RESULTS.txt`、`app/UI-CHANGES.md`、`app/logs/*`、`app/runtime/*`、`ISOLATED-VERIFY.json`、`source-snapshot-D-20261026.zip`。

## 5. 需求逐条对照（任务 2）

| 要求 | 实现 | 验证 |
|---|---|---|
| 1. ACK 与处置分别记录 | ACK 命令与 safetyLogs 台账完全分离；处置不改告警状态 | 隔离脚本断言 16/17/20/21/23 项 |
| 2. 用户填写处置说明（家属/社区/现场/误报/其他） | 5 个 outcome + note（≤200）；APP 选项化 | backend 枚举测试 + Hypium DTO/ApiClient 测试 |
| 3. 保存 alarmId/家庭设备关联/操作者/服务端时间/内容 | 记录含 alarmId/deviceId/room/type/actor/serverTime/outcome/note；家庭关联由单户 Bearer 会话+告警绑定体现 | 公开字段断言 + 快照白名单断言 |
| 4. 与既有 ACK 合同兼容，不触发设备 ACK/reset | 处置路由不调用 requestAck/completeCommand；ACK 接口未改 | 隔离脚本 ACK 回归 + commands 断言 |
| 5. 持久化，backend 重启可查 | schema v6 落盘；重启后查询 | 隔离脚本重启断言 + backend 持久化测试 |
| 6. 校验家庭访问权限/文本长度/重复提交 | 401/403 沿用 Bearer；note≤200；幂等 200/409 | API 测试 + 隔离脚本 6/7/9/10/13 项 |
| 7. 修改保留历史 | append-only，不提供无痕覆盖；更正=新增记录 | 合同与实现说明；幂等/冲突测试 |
| 8. APP 详情显示处理时间/处理人/结果；历史列表可查 | AlertDetailPage 处置面板 + LogPage“安全日志”页签 | Hypium + HAP 编译；**未真机运行态验收** |
| 9. 离线提交失败不显示已保存、保留输入 | GuardianService 失败语义 + 页面失败分支保留输入 | Node 测试（ApiClient/Outcomes）+ 静态守卫；**未真机验收** |

## 6. 真实验收状态（重要，不得混淆）

- **历史真实验收**：ACK 闭环（2026-10-22 实体 SOS→设备 ACKED）属于实施前既有能力，本轮未重测、未修改。
- **本轮真实验收**：**无**。本轮没有部署公网、没有在真实手机/模拟器上连真实后端跑处置流程、没有使用任何既有告警做处置。
- **本轮本地测试/构建**：backend 全量 274/274、D 定向 37/37、隔离集成 37/37、APP Hypium 39/39、assembleHap BUILD SUCCESSFUL。
- **未实现/未验证**：公网部署、APP 联网运行态闭环、真机离线失败表现、多监护人权限区分（单户部署）。

### 阻塞与所需一步操作（恢复条件）

1. **公网 backend 未部署新接口** → 需要用户授权维护窗口并执行 `DEPLOY-DIFF-AND-ROLLBACK.md` §3（备份→build→up→验证）；在此之前 APP 只能显示“接口未部署/失败”，不能显示已保存。
2. **新 HAP 未签名/未安装** → 用户在 DevEco 完成签名并安装到手机（或明确同意在模拟器验证）；正式 HAP/数据不动。
3. **真实验收告警未选** → 请用户明确指定一个既有、可操作的告警用于处置验收（不制造 SOS/FALL；是否 ACK 由用户决定）。
4. 三步完成后按 §5 要求 8 的流程现场操作一次，并把截图/后端状态码补进本目录，即可把 §5 第 8/9 条从“本地验证”升级为“真实验收”。

## 7. 回退

- 未部署 → 生产无需回退；本地源码按 `backend/D-E-SCOPE-SPLIT.md` §回退 D 类反向操作。
- 源码快照：`source-snapshot-D-20261026.zip`（123,201 B，SHA-256 `3E9DE38AF1F3CD2CD45957314C28DE0398D1E50DD79EA07A755C44F26CCFDB94`）。
- 已部署后的回退见 `DEPLOY-DIFF-AND-ROLLBACK.md` §5（必须恢复升级前快照，旧代码不能读 v6）。
- APP：未安装新 HAP；若将来安装，回退=重装冻结正式 HAP（2,077,912 B，`8A722EB6…5253A985`）。

## 8. 并行会话说明（必须记录）

本轮工作区存在**另一个并行会话**，它在同一目录实现了 E 类活动报告（`backend/src/activity*.js`、`GET /api/v1/activity/report`、APP `core/activity/*`、`ActivityReportPage.ets` 等），并继续修改共享文件（01:48–02:01）。本 Team（Lead/auditor/backend-dev/app-dev）**只对 D 类负责**；`server.js/main.js/package.json/Contracts.ts/ApiClient.ts/Models.ts/Outcomes.ts/GuardianService.ets` 为 D/E 共享最终内容。E 类未纳入本报告验收，其部署需与 E 归属方另行确认。
