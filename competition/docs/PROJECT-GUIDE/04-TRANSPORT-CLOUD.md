# 04 · 传输与云（bridge / broker / OneNET 网关 / 可信后端 / 穿戴链路 / 部署）

> 覆盖：`competition/bridge/`、`competition/cloud/onenet/`、`competition/cloud/backend/src/`、
> `competition/cloud/wearable-mirror/`、`competition/cloud/wearable-mqtt/`、`competition/deploy/`、
> `competition/materials/public-sync-health.ps1`。
> 拓扑与总流程见 `docs/PROJECT-GUIDE/01-ARCHITECTURE.md`；本文只讲**本层怎么实现、坑在哪**。
>
> 标记约定：`✅实测` 有本轮/近期真实进程或真机证据；`🟡未实测` 已实现但只有单测/假对端；
> `⬜未实现` 占位或明确未做；`↔其他层` 不属于本文。

---

## 1. 本层职责与边界

### 1.1 一句话职责

把**局域网里的一条条 JSON 行**（设备/板端 homemon）抬到**公网 HTTPS 服务**，并把公网侧的命令
**精确**送回某一台设备，同时保证“命令只有被设备真实确认才算完成”。

### 1.2 三条边界（先分清，否则后面全看不懂）

| 边界 | 谁在里面 | 协议/端口 | 信任假设 |
|---|---|---|---|
| ① 局域网传输 | `bridge/mqtt_bridge.js` + `bridge/mqtt_broker.js` + 板端/per-worker | TCP 行协议（JSON+`\n`）`9101/9001`；MQTT `1883` | **完全可信、无鉴权无 TLS**。所以只允许跑在 PC 上（`compose.public.yaml:16-21` 明令禁止把这些端口发布到公网） |
| ② 公网同步 | `public-sync.js` + `public-sync-supervisor.js` + `public-sync-worker.js` | 出站 HTTPS 443；只主动出站，不开任何入站端口 | 家庭侧不持有对公网的“监听面”，只持有 `INGEST_KEY`（内部摄取密钥） |
| ③ 云端服务 | `cloud/backend/src/*` + `deploy/Caddyfile` | Caddy 443 终止 TLS，反代到容器内 `backend:8080` | 后端**只在容器网络监听**，不发布主机端口；公网唯一入口是 Caddy（`compose.public.yaml:61-63,84-87`） |

另有一条**并行**的上行通道：`cloud/onenet/*`（OneNET 物模型）。它和 ② 是两条独立的上云路径：
② 是现网演示真正在跑的（手机 APP 读它），① 之外的 OneNET 通道用于满足“基于物联网云平台”的赛题要求，
并在 2026-10-10 用真实设备级 Token 完成过 `property/post` 的 `code=200` 实测（`cloud/onenet/README.md:69-70`）。

### 1.3 谁持有密钥（本层最关键的一张表）

| 密钥 | 存放位置 | 谁读 | 绝不出现的地方 |
|---|---|---|---|
| OneNET 设备密钥 | 部署平台 Secret / 隐藏输入，运行时注入 | `transport.js` 的 `getDeviceKey` 回调（`transport.js:120,438-442`） | 源码、日志、命令行、`.env`（`cloud/onenet/README.md:58`） |
| 后端 `INGEST_KEY` | 公网侧：`/opt/eldercare/deploy/.env.deploy`（600）；家庭侧：**只在 supervisor 进程内存** | supervisor→worker 经 Node IPC 单次传递（`public-sync-supervisor.js:359`） | argv、环境变量、锁文件、状态文件、日志（`public-sync-supervisor.js:3-18,244-251`） |
| 会话令牌密钥 `API_TOKEN_SECRET` | `.env.deploy`（600） | `auth.js` HMAC 签名/校验 | 快照、响应、日志（`main.js:157`） |
| 监护人登录口令 | `.env.deploy`（600） | `auth.js` 常时比较（`auth.js:22-25,39-46`） | APP 包、日志 |
| 微信 AppSecret | `.env.deploy`（600） | `backend` 直接出站调 `jscode2session`（`auth.js:68-86`） | **不经过 Caddy**，入站日志看不到（`Caddyfile:24-30`） |

**结论：本层的安全模型是“入站面收敛到 Caddy 443、出站面收敛到两个密钥”**，而不是“每段链路都加密”。

---

## 2. 代码地图

### 2.1 PC 桥接与自包含 Broker（`competition/bridge/`）

| 文件 | 行数 | 职责 | 关键函数:行号 |
|---|---|---|---|
| `mqtt_bridge.js` | 947 | 南向（TCP 行协议）↔ MQTT 双向桥；多节点/入站节点/relay 注入/求助定向播报/单实例锁 | `parseArgs:41`、`MqttClient:134`、`bindNode:338`、`publishStatus:390`、`relayConnect:444`、`handleRouteLine:484`、`sosFanoutObserve:581`、`acquireInstanceLock:658`、`attachNode:765` |
| `mqtt_broker.js` | 190 | 零依赖 MQTT 3.1.1 broker（CONNECT/SUB/PUB/PING；`+`/`#`；QoS0/1 收） | `encLen:22`、`topicMatch:27`、`CONNECT 防御解析:60-90`、`PUBLISH:116-164`、`PING:165` |
| `mqtt_tool.js` | 91 | 命令行 sub/pub，用于验证上行与“多终端推送” | `main:35-89` |
| `sim_node.js` | 317 | ESP32 节点的**软件替身**（同款行协议 + 告警状态机），不是实体验收 | `SimNodeState:121`、`handleCommand:186`、`startClient:238` |
| `link_probe.js` | 34 | 只读探针：模拟板载 APP 观察 relay 广播 | — |
| `README.md` | 331 | 设计取舍 + 实测记录 + 自动恢复加固（本文大量引用） | — |

### 2.2 OneNET 适配层与公网同步（`competition/cloud/onenet/`）

| 文件 | 行数 | 职责 | 关键函数:行号 |
|---|---|---|---|
| `adapter.js` | 518 | OneJSON 物模型：topic 构造、属性/事件上行、`property/set` 白名单、reply | `buildTopics:106`、`normalizeStatus:365`、`toPropertyPost:396`、`toAlarmEvent:412`、`mapPropertySet:480`、`makePropertySetReply:497` |
| `token.js` | 75 | OneNET 设备级短期 Token（HMAC-SHA256，`2018-10-31` 版） | `createDeviceToken:38` |
| `transport.js` | 452 | MQTTS 8883：CA+指纹固定、订阅、QoS1+业务确认、`property/set` 下发与 reply | `checkOneNetServerIdentity:55`、`_connect:226`、`_onConnected:286`、`_publishWithCloudAck:387`、`_onPropertySet:355` |
| `gateway.js` | 1089 | 常驻家庭云网关：本地 `home/+/status` 聚合、限频上云、告警去重、在线判定、受限下行 + 真实回执 | `ingest:296`、`_applyStatus:360`、`_signature:479`、`_nextMessageId:560`、`_markOffline:614`、`handleCommand:646`、`_handleReset:675`、`_waitFor:765`、`defaultCreateStatusSource:948` |
| `cloud-sync.js` | 251 | 网关→可信后端 `POST /internal/v1/device-status`（旁路，从不抛异常） | `buildIngestPayload:59`、`publish:190` |
| `command-sync.js` | 844 | 轮询后端 ACK 队列 → 精确定向下发 → 等真实 ACKED → 回写结果 | `validateCommand:103`、`observe:465`、`waitForReceipt:422`、`handleCommand:592`、`pollOnce:676` |
| `public-sync.js` | 180 | 公网入口：不连 OneNET，只做 本地 MQTT ⇄ 公网 backend；TTY 隐藏读 key | `readHidden:58`、`main:126` |
| `public-sync-supervisor.js` | 589 | supervisor：读一次 key、IPC 下发、拉起/重启 worker、有界熔断、心跳、只读健康判定 | `acquireLock:66`、`start:218`、`workerEnv:244`、`spawnWorker:253`、`handleAbnormalExit:367`、`evaluateSupervisorHealth:472` |
| `public-sync-worker.js` | 75 | 唯一 worker：只经 IPC 收 key；父进程断连即自杀（防孤儿重复上传） | `onMessage:42`、`disconnect:65` |
| `run-public-sync.js` | 69 | 可见终端启动唯一实例（stdin 继承保证 TTY），双写日志 | `lock:29-39`、`spawn:46` |
| `thing-model.json` / `thing-model.onenet-import.json` | 198 / 1073 | 物模型（属性 `r`/`rw`、事件 `safetyAlarm`）与 OneNET 导入文件 | `control:163-179`、`events:181-197` |

### 2.3 云端后端（`competition/cloud/backend/src/`）

| 文件 | 行数 | 职责 | 关键函数:行号 |
|---|---|---|---|
| `server.js` | 1097 | HTTP 路由全集：鉴权、内部 ingest、命令队列、证据、安全日志、通知登记、远程交流 | `createApiServer:166`、`/internal/v1/*` 门禁 `:440-443`、`device-status:444`、`commands:492`、`ack:1066`、`alerts:789`、`evidence:987` |
| `store.js` | 760 | `MemoryStore`：状态/告警/命令/门磁/处置的内存语义与严格校验 | `normalizeStatus:132`、`ingest:210`、`requestAck:656`、`completeCommand:684` |
| `persistent-store.js` | 1656 | 继承 MemoryStore，每次变更**原子落盘**（临时文件+fsync+rename）、严格加载、ID 单调 | `atomicWriteFile:715`、`_load:822`、`_captureState:1058`、`_commit:1102`、`requestAck:1151`、`completeCommand:1178` |
| `auth.js` | 98 | 监护人账号鉴权、会话令牌 HMAC、微信 code 交换 | `authenticateAppGuardian:39`、`createSessionToken:48`、`exchangeWechatCode:68` |
| `household-auth.js` | 152 | 单户微信 openid 允许名单（内存、冻结、fail-closed） | `createHouseholdAuthorizer:105`、`isAllowed:128` |
| `activity.js` / `activity-store.js` | 914 / 199 | PIR 活动聚合（只认 `countToday` 正增量、家庭时区切日、覆盖率） | 语义见 `activity.js:1-27` |
| `health-store.js` / `health-profile.js` / `health-advice-prompt.js` / `deepseek-client.js` | 203 / 502 / 148 / 408 | 健康资料独立存储 + DeepSeek 科普建议（可选、可关闭） | `main.js:216-244` |
| `notify-delivery.js` | 918 | 微信订阅消息投递：按 (deviceId,alarmId,recipientRef) 幂等、指数退避、永久失败停止 | `buildTemplateData:101`、`backoffDelayMs:114` |
| `notify-privacy.js` | 337 | 脱敏与 `recipientRef`（HMAC+域分离，台账绝不存 openid） | `recipientRefFor:73`、脱敏规则 `:27-41` |
| `notify-provider.js` | 347 | 微信 provider + `TokenManager`（access_token 缓存刷新） | — |
| `comms-core.js` | 324 | 远程交流状态机（QUEUED→DELIVERED→PLAYED→ACKED/FAILED/EXPIRED） | `VOICE_MAP`、`deriveStatus` |
| `evidence-store.js` | 317 | 跌倒证据 JPEG：魔数校验、sha256、绑定告警、保留期清理 | `validateJpeg:50`、`publicMetadata:59` |
| `safety-log.js` | 213 | 告警处置登记（**独立于 ACK**）的纯逻辑与公开形状 | 边界 `:9-16`、枚举 `:27-44` |
| `main.js` | 452 | 组装：环境变量 fail-fast、四个存储、通知恢复、优雅关闭 | `createRuntime:151`、`probeDataPath:117`、`main:384` |

### 2.4 穿戴链路

| 文件 | 行数 | 职责 |
|---|---|---|
| `wearable-mqtt/src/mqtt-broker.js` | 583 | **公网** broker：用户名密码 + ClientID 白名单、QoS0/1、KeepAlive 1.5×（`:358-414`）、同 ID 接管 |
| `wearable-mqtt/src/mqtt-protocol.js` | 350 | MQTT 3.1.1 报文编解码与主题匹配（纯函数） |
| `wearable-mqtt/src/adapter.js` | 1223 | SOS/hb/boot/GPS/ACK：本地去重、parked 重投、离线看门狗（README §4、§8） |
| `wearable-mqtt/src/backend-client.js` | 283 | 后端 HTTP：指数退避、脱敏诊断 |
| `wearable-mqtt/src/state-store.js` | 231 | `DATA_DIR` 原子持久化：seq/游标/当日计数（不含坐标） |
| `wearable-mirror/src/*` | 2029 | PC 侧镜像：`source-api`/`source-mqtt` 取数 → `model` 纯状态机 → `transport`（relay/tcp）注入 → `mirror` 编排 + `lock` 单实例 |
| `wearable-mirror/src/transport.js` | 241 | `RelayTransport:25`（写 `relay <json>`）、`TcpStatusServer:139`（PC 9002） |

### 2.5 部署与运维

| 文件 | 行数 | 要点 |
|---|---|---|
| `deploy/compose.public.yaml` | 125 | backend（无主机端口、read_only、healthcheck `/readyz`）+ caddy（80/443 + 证书卷） |
| `deploy/Caddyfile` | 88 | 自动 TLS、HSTS、`request_body 3MB`、**日志过滤 `x-ingest-key`**（`:72-82`） |
| `deploy/wearable/compose.wearable.yaml` | 76 | 只发布 `1883`；复用 backend 镜像 + 只读挂载源码；env_file 600 |
| `deploy/verify/preflight-public.sh` | 492 | 只读上线预检：不 `source` 变量文件、只输出变量名、禁止端口清单（`:19-30,47-50`） |
| `deploy/wearable/install-on-ecs.sh` | 449 | 从 `.env.deploy` 抽 `INGEST_KEY` 生成 600 的 `wearable.env`，从不回显 |
| `materials/public-sync-health.ps1` | 91 | 只读健康检查：端口 + `supervisor --check`，不健康退出码 3 |

---

## 3. 端到端数据流与时序

### 3.1 F1 上行：设备状态 → bridge → broker → worker → backend → APP

```
ESP32/homemon ──JSON+\n──> bridge:9101
   ├─ 解析行 (mqtt_bridge.js:791-811 / 890-911)
   ├─ bindNode(deviceId) 身份绑定 + 抢占仲裁 (:338-375)
   ├─ publishStatus → home/<deviceId>/status (retain=true) (:390-401)
   └─ 入站节点额外 relayLine 注入板端 homemon (:518-528)

broker:1883 转发（重打包为 QoS0、**剥掉 retain**）(mqtt_broker.js:154-163)
   ↓
public-sync worker（mqtt.js 订阅 home/+/status, qos0）(gateway.js:973-986)
   ├─ adapter 严格归一化 → 聚合到 devices Map (gateway.js:296-345,360-477)
   ├─ 变化立即上云 / 稳定态 30s 限频 (426-435)
   └─ cloudSync.publish（不 await，旁路）(461-464, 520-527)
   ↓ POST /internal/v1/device-status  x-ingest-key
backend: 校验 → store.ingest → 原子落盘 → 202 (server.js:440-465, store.js:210)
   ↓ GET /api/v1/devices（Bearer）
手机 APP
```

关键语义：
- **主题里的 deviceId 来自报文自身**，bridge 代码不写死设备表（`mqtt_bridge.js:9-12`）——新增房间零改码。
- 上云时间戳用**网关接收时间**，设备原始 `ts` 只留在本地（`gateway.js:523-526`）。
- 同步是**旁路**：`cloud-sync.publish` 从不抛异常（`cloud-sync.js:185-230`），后端挂了不影响本地告警。

### 3.2 F2 下行：APP 命令 → broker → bridge → 节点

```
APP POST /api/v1/alerts/<id>/ack
  → backend store.requestAck()：入队 PENDING 命令（store.js:656-678；持久化版 :1151-1176）
  → 202 {status:"PENDING", commandId}   ← 只代表“受理”，不是“已确认”(server.js:1066-1073)
        ↓ worker 轮询 GET /internal/v1/commands?after=<cursor> (command-sync.js:676-754)
        ↓ 严格校验（只 ACK、id/deviceId/alarmId/action 全合法、只 PENDING）(:103-128)
        ↓ 只发精确主题 home/<deviceId>/cmd（绝不广播）(:373-410)
broker:1883 → bridge 订阅 home/+/cmd (mqtt_bridge.js:220,697-753)
        ↓ 白名单映射成行协议命令
        ↓ routeCommand(deviceId, cmd)：找不到在线节点就丢弃并告警 (:555-563, 740-752)
ESP32 / homemon
```

另有板载 APP 的“目标路由”通路：APP → homemon `route <deviceId> <cmd>` → bridge 从 relay socket 读到 →
按 deviceId 转发（`mqtt_bridge.js:484-502`），并且**禁止嵌套 route/relay**、拒绝空目标。

### 3.3 F3 ACK 闭环（本层最硬的一条语义）

```
设备执行 ACK 后，下一帧状态 state=ACKED, alarm.id 精确匹配
  → 上行回到 worker 的 command-sync.observe()：递增 observationSeq (:465-512)
  → 只有 seq > baselineSeq（命令发布前取的基线）才算回执 (:422-443, 616-617)
  → POST /internal/v1/commands/<id>/result {status:"ACKED", deviceState}
  → 后端 completeCommand 再校验一遍 deviceId/state/alarm.id/evidenceId 绑定 (store.js:724-740)
  → 告警才转 ACKED（alert.status/ackPending/acknowledgedAt）
```

- **HTTP 202 ≠ 闭环**：`requestAck` 只写 PENDING；真正 ACKED 必须等设备回执（`server.js:1066-1073`、`store.js:691-694`）。
- 回写失败**不推进游标**：结果体留在 `pendingResults`，下一轮只重试 POST，不重发 MQTT（`command-sync.js:564-589, 737-746`）。
- 进程停止/等待被顶替时**绝不回写 FAILED**，否则会错误清掉 `ackPending`（`command-sync.js:656-661`）。

### 3.4 F4 supervisor / worker 生命周期

```
start-demo-supervisor.cmd → start-demo-supervisor.ps1（预检：拒绝第二个实例, :221-248）
  → node public-sync-supervisor.js --state-file … --lock-file … --log-file …
       ├─ acquireLock：'wx' 建锁；死 PID → 接管陈旧锁 (:66-90, 218-226)
       ├─ readHidden()：真实 TTY 隐藏输入 INGEST_KEY（只显示 *）(public-sync.js:58-117)
       ├─ fork worker，env 里**删除** INGEST_KEY/BACKEND_INGEST_KEY (:244-251)
       ├─ child.send({type:'ingest-key', value})  ← 唯一传递通道 (:357-363)
       ├─ worker 收 key → public-sync.main() → 连本地 broker + 连公网 (:42-58)
       ├─ worker 报 {type:'ready'} → supervisor 写 HEALTHY (:308-314)
       ├─ 心跳：每 30s 重写 state.json（PIDs/heartbeatAt/restartCount）(:195-203)
       ├─ 异常退出：1s→2s→5s→10s→30s 退避重启 (:28, 393-401)
       └─ 5min 内崩 3 次 → CIRCUIT_OPEN，保持 60s 后清窗重试（**有界**，不永久停摆）(:367-402)
```

**健康判定不看 `state.json` 一个文件**：`--check` 同时校验 lock PID 存活、supervisor PID 存活、
state 是否为 `HEALTHY`、heartbeat 是否新鲜、worker PID 是否存活，不健康退出码 3（`:472-513, 536-551`）。
2026-10-27 16:25 的事故正是“state.json 停在 HEALTHY、进程全没了”（`materials/public-sync-health.ps1:1-9`）。

### 3.5 F5 穿戴旁路（4G → ECS → 板载 APP）

```
M100 4G ──MQTT 1883──> wearable-mqtt（公网 broker+adapter）
   ├─ SOS → 本地按 alarmId 去重 → POST /internal/v1/device-status
   ├─ ACK 命令 ← GET /internal/v1/commands → 下发（**payload 必须以 \n 结尾**，M100 不补换行）
   └─ 只有收到设备真实 t:"ack" 且 alarm+cmd 完全匹配才回写 ACKED（绝不代报）

PC wearable-mirror ──轮询公网 API 或直订 broker──> 状态机
   └─ relay <json> 注入板端 homemon:9001（**绝不写 bridge 的 9101**，否则形成环路）
        → homemon 广播 → 板载 APP 显示
```

`wearable-mirror/README.md:22-23` 明确写出这条“不得回灌 bridge”的红线；bridge 侧用
`--relay-ignore esp32-sos` 兜住 homemon 的回灌（`mqtt_bridge.js:87-104,805`）。

---

## 4. 关键技术点（逐条：概念 → 本项目用法 → 代码行）

### 4.1 MQTT 3.1.1 帧解析与自包含 broker

**为什么自建**：本机到 `broker.emqx.io:1883` 实测 TCP 不通，现场 WiFi 也可能封 1883
（`mqtt_broker.js:5-10`、`bridge/README.md:22-30`）。自包含 broker 让“板子→桥接→多台手机”在局域网内闭环。

| 概念 | 本项目实现 | 代码 |
|---|---|---|
| 固定头 + Remaining Length 变长整数 | 手写 varint 解码，逐包切分，跨 TCP 分片用累积 `Buffer` | `mqtt_broker.js:43-58`；客户端 `mqtt_bridge.js:183-203` |
| CONNECT | 只做协议名/ClientId 长度**边界检查**后回 CONNACK；畸形包只 kill 这条连接 | `mqtt_broker.js:60-90` |
| SUBSCRIBE/SUBACK | 解析多组 filter+QoS，回授 QoS | `mqtt_broker.js:91-115` |
| PUBLISH | **先解析 Topic，再解析 QoS>0 的 Packet ID**（历史 bug 就在这）；QoS0/1 收，QoS1 回 PUBACK | `mqtt_broker.js:116-164`；客户端同序 `mqtt_bridge.js:228-264` |
| 通配符 | `+` 单层、`#` 多层；`#` 命中剩余全部（含父级） | `mqtt_broker.js:27-36` |
| QoS 上限 | **只支持 0/1**，收到 QoS2 直接拒绝并记码 | `mqtt_broker.js:121-125`；`mqtt_bridge.js:232-236` |
| PING | 客户端每 20s 发 `PINGREQ`，broker 回 `PINGRESP` | `mqtt_bridge.js:937` / `mqtt_broker.js:165-167` |
| 单包容错 | 逐包 `try/catch`，坏包只断开一个连接，绝不拖垮进程 | `mqtt_broker.js:168-173` |
| retain | bridge 用 retain=true 发布，**broker 转发时把 flags 置 0（撤掉 retain）** | `mqtt_bridge.js:394` / `mqtt_broker.js:158` |

⚠️ 这段“retain 被剥掉”是理解全链路的钥匙：默认链路**不会**“订阅即回放”（`gateway.js:25-28`），
所以 gateway 的去重做成“只按 alarmId 记忆”，对“有 retain/无 retain”两种行为都安全。

✅实测：2026-10-09 上行/下行/多订阅者/状态回传（`bridge/README.md:60-69`）。
🟡未实测：QoS1 链路（代码支持，现网 `QoS0`）。

### 4.2 行协议分帧、背压、TCP keepalive

- **分帧**：每行 JSON + `\n`；`acc` 字符串累积 → `indexOf('\n')` 循环切行（`mqtt_bridge.js:791-811, 890-911`）。
  一行跨多个 TCP 分片、多行粘在一个分片都能处理。
- **背压/防膨胀**：单连接累积超过 `MAX_NODE_BUFFER_CHARS = 65536` 字符即**拒绝并断开**（`:310, 328-336`）；
  relay 通道异常超长无换行时 `acc = acc.slice(-4096)`（`:464`）。
- **半开检测**：所有南向/relay socket 都 `setKeepAlive(true, 10000)`（`:457, 789, 889`）；
  `setNoDelay(true)` 关 Nagle。原因写在 `:453-456`：homemon 重启/hdc 丢 fport 时对端可能不发 FIN。
- **诚实边界**：没有写缓冲上限与 `drain` 回压处理——上限靠“上游上报周期 5s + 64KB 行护栏 + 状态文件覆盖写”兜底。
  真要加，见 §6。

### 4.3 单实例锁（PID 锁 + 陈旧锁接管）

三处实现同一套思路，**都用 `process.kill(pid,0)` 判存活、`EPERM` 视为存活**：

| 位置 | 建锁 | 陈旧锁 | 释放 | 冲突行为 |
|---|---|---|---|---|
| bridge | `openSync(file,'wx')` 写 PID（`mqtt_bridge.js:651-656`） | 读 PID→不在则 `unlink` 后重建，返回 `stalePid`（`:658-675`） | 只删“自己持有”的锁（`:677-681`） | 退出码 **3**（`:685-693`） |
| supervisor | 同（`public-sync-supervisor.js:66-90`） | 同，并记 `STALE_LOCK_TAKEOVER`（`:226`） | 同（`:211-216`） | `BUSY live_pid=…` 后 `process.exit(2)` |
| mirror | JSON 体 `{pid,startedAt,host}`（`lock.js:45-63`） | PID 不存活即可接管（`:52-57`） | 只删自己的（`:65-74`） | `ELOCKED`（退出码 3） |

两个额外细节值得学：
- bridge 的锁**只保护 bridge 自己**，不清理别人的锁；supervisor 在同一目录用**不同锁文件**，互不误杀。
- `start-demo-supervisor.ps1:221-236` 还做“跨入口”保护：即使用不同锁路径，也会扫 Node 进程命令行，
  发现已有 supervisor 或**孤儿 worker** 就拒绝启动/提示先清理。

### 4.4 指数退避、断线补发与重放

| 场景 | 策略 | 代码 |
|---|---|---|
| bridge 配置端点重连 | 3s→6s→12s→24s，封顶 30s，**永不停止重试**（`retired` 只废这一条 socket） | `mqtt_bridge.js:311-319, 773-826` |
| bridge relay 通道 | 同上口径（3s→30s） | `:408-417, 472-479` |
| bridge ↔ broker | 固定 3s 防抖重连（`error`/`close` 双触发也只建一条） | `:173-181` |
| gateway ↔ 本地 broker | `1s * 2^n` 封顶 30s；`reconnectPeriod:0` 自己控制 | `gateway.js:961-971` |
| OneNET transport | `min*2^attempt` 封顶 30s；**每次重连重新取密钥生成新 Token** | `transport.js:232-239, 317-328` |
| supervisor 重启 worker | `[1s,2s,5s,10s,30s]` 列表退避 | `public-sync-supervisor.js:28,393-401` |
| command-sync 重试 | 最多 3 次，间隔 ≥2s；超时 8s 等回执 | `command-sync.js:41-47, 607-670` |
| notification 重试 | `base*2^(n-1)` 封顶 8s，3 次；永久失败立即停 | `notify-delivery.js:114-119` |

**断线补发/重放**（本层的“不丢消息”全部来自这三处内存缓存，不是 MQTT 保证）：
1. MQTT 重连后按 `lastStatusByDevice` 重放每台设备最后状态（`mqtt_bridge.js:389, 754-763`）；
2. relay 恢复后按 `relayLatestLines` 补发每台**仍在线**入站设备的最后一条（`:410, 434-442`）；
   设备真断开时清掉缓存，避免补发“假在线”（`:913-926`）；
3. mirror relay 断线时保存 `lastLine`，重连后补发一次（`wearable-mirror/src/transport.js:54, 107-110`）。

### 4.5 OneJSON 物模型与上下行白名单

**上行**（`adapter.js`）：
- topic：`$sys/{productId}/{deviceName}/thing/property/post|event/post`（`:106-118`）；segment 正则
  `[A-Za-z0-9][A-Za-z0-9._-]{0,63}` 防止用输入改变 topic 层级。
- 信封：`{id, version:'1.0', params, time}`，`id` 必须 **≤13 位纯数字**，`time` 必须是 **13 位毫秒**
  （`adapter.js:386-394, 87-104`）。
- 属性：`deviceId/room/online/state` 必有，其余（motion/door/temperature/humidity/gas/smoke/fall/alarm/gps/
  battery/csq）**有则带、无则不带**（`:396-410`）。
- 事件：只有 `state=ALARM` + 非空 alarmId + 白名单类型才发 `safetyAlarm`（`:412-431`）。
- `evidenceId` 只做**关联校验**，刻意不进 OneJSON（`:268-273`）：证据二进制走可信家庭 API。

**下行**（`property/set`）：
- 只接受唯一属性 `control`，可直接值或 `{value:…}` 包装（`:433-439`）；`requireExactKeys` 逐层拒绝未知字段。
- 白名单三条命令：`ACK`（必须 `alarmId`+`action`）、`RESET`（额外字段一律拒）、`SET_CONFIG`
  （`noMotionSec 30-86400` / `reportIntervalSec 1-3600`，至少一个）（`:441-478`）。
- 回包 `{id, code:200|400, msg}`，`id` 必须回显请求的 id（`:497-507`）。

⚠️ 阶段边界（`⬜未实现` 且**刻意不做**）：物模型 `control` 没有 `deviceId`，所以 gateway 无法安全定向 ACK；
第一阶段**只执行网关自身 RESET**，ACK/SET_CONFIG 一律回失败、不猜“当前房间”（`gateway.js:659-668`、
`cloud/onenet/README.md:290-298`）。真正的 APP ACK 闭环走的是 §3.2 的 backend 命令队列，不经 OneNET。

✅实测：OneNET `property/post` 返回 `code=200`、真实下行 `RESET` 回 `code=200`（`cloud/onenet/README.md:69-70`）。
🟡未实测：真实 OneNET 凭据下的常驻运行（README:380 明确写 `NOT TESTED`）。

### 4.6 TLS：CA + 证书指纹固定 + `rejectUnauthorized` + 短期 Token

- 官方 CA 打到仓库 `certs/onenet-mqtt-ca.pem`，启动即读（`transport.js:22`）。
- 证书是**无 SAN 的自签 `CN=OneNET MQTTS`**，标准主机名校验必然失败；因此：
  `rejectUnauthorized:true` **不关**（`:252`），改用 `checkServerIdentity` 同时校验
  ①叶证书 SHA-256 指纹固定 ②`subject.CN === 'OneNET MQTTS'`（`:55-65, 240-260`）。
- 指纹常量在 `transport.js:21`（32 字节公钥指纹，非密钥）；`ca` 与自定义指纹**必须成对提供**（`:152-159`），
  防止“只换 CA 不换指纹”的静默降级。轮换流程写在 `cloud/onenet/README.md:60`（重新取 CA + 同步改指纹，**不许关校验**）。
- 身份：MQTT username = productId，password = 运行时生成的**设备级短期 Token**，TTL 默认 3600s
  （`transport.js:17, 234-239`），`token.js:38-68` 用 HMAC-SHA256 签
  `et\nmethod\nres\nversion`，`res=products/{pid}/devices/{name}`。
- 设备密钥惰性读取（`getDeviceKey` 回调）：缺失只会让 OneNET 侧指数退避重试，**不会让网关退出**，
  本地告警继续可用（`gateway.js:1036-1047`、README:231-238）。

✅实测：真实设备级 Token 完成 CONNECT+SUBSCRIBE+property/post（README:69）。
⬜未实现：其余链路一律明文——bridge/broker 无 TLS、wearable-mqtt 公网 1883 明文（README §7）。

### 4.7 幂等与去重、TOCTOU、命令队列

| 幂等键 | 目的 | 代码 |
|---|---|---|
| `deviceId \0 alarmId`（gateway 内存，每设备最多 200 条） | 同一告警只发一次 `safetyAlarm`，与设备当前状态解耦 | `gateway.js:440-455, 591-605` |
| `alarmId` → alert（后端） | 重复上报只更新，不新建；**同 alarmId 换设备/换证据 = 拒绝** | `store.js:219-231, 235-259` |
| `(deviceId, seq)` 门磁事件 | 设备补传不产生重复事件；首次只建基线 | `store.js:27-29, 412-430` |
| `seq` monotonic 门磁/位置 | 回退视为 stale，冲突报错 | `store.js:270-280` |
| `clientMessageId`（远程交流） | 同 ID 重复提交幂等；内容不同 → 409 | `server.js:926-936` |
| `(alarmId, clientDispositionId)`（处置） | 幂等键唯一，重启不复用 ID | `persistent-store.js:28-29, 1195-1218` |
| `(deviceId, alarmId, recipientRef)`（通知） | 按收件人独立幂等，一人成功不掩盖另一人失败 | `persistent-store.js:1252-1259` |
| 命令 `id`（后端单调整数） | 重启/淘汰不复用 | `persistent-store.js:1111, 1151-1176` |
| OneNET 消息 `id` | 同一毫秒连发也不重复（`max(now, last+1)`） | `gateway.js:560-574` |

**TOCTOU（检查与使用之间状态被改）**——本层最经典一处是 RESET：
1. 目标必须**当前**处于 `ALARM`，否则拒绝（`gateway.js:696-702`）；
2. 记录 `baselineSeq = max(ingestSeq, alarmSeq)`（`:704-707`）；
3. 只接受**晚于 baseline** 的新状态作为回执（`:716-719`）。
这三步一起消除了“设备公告警前旧 NORMAL 被当成 reset 回执”的真机竞态（README:346-350）。回归脚本：
`cloud/onenet/gateway-toctou-check.js`（不依赖 `node --test`）。

**命令队列语义**（`command-sync.js`）：
- 游标 `after=<上次最大 id>`，**只有本轮全部处理完才推进**；被阻塞就停在本条（`:702-753`）。
- 台账 `ledger` = 已结算（进程内）；`pendingResults` = 结果已拿到但 POST 没成功（`:294-307`）。
- 设备作用域白名单：不在白名单的命令**只推进游标、不领取、不下发、不回写**（`:230-244, 719-735`），
  避免把走 4G 的 `esp32-sos` 的 ACK 抢到本机一个没有消费者的主题上。

### 4.8 存储层：内存 vs 持久化（以及“绝不假成功”）

- `MemoryStore`：纯内存语义，方便单测与嵌入（`store.js:182-208`）。
- `PersistentStore extends MemoryStore`：只覆盖**会改状态**的方法（`ingest/requestAck/completeCommand/
  createDisposition/...`），每次成功变更后**同步原子落盘**（`persistent-store.js:3-36`）。
- 原子写：同目录临时文件 `0600` → `fs.writeSync` → `fsync` → `rename` → 尽力 fsync 目录
  （`:715-741`），目标文件要么旧内容要么完整新内容。
- 写失败**先回滚内存再抛错**（`:16-17, 1058-1102`），杜绝“API 报失败但内存已成功”。
- 加载严格：顶层字段必须精确等于白名单，未知字段（如 token/secret）**拒绝启动**；损坏 JSON、
  命令 ID 非递增、alert→device 绑定错误都 fail-fast（`:18-24, 844-849`）。
- schema 版本 v7，v1..v6 均可读并按需补空集合（`:53-64`）。
- **单进程**：不实现跨进程文件锁，调用方必须保证只有一个后端写这个文件（`:31-32`）。

⚠️ 因此 `docker compose` 里 backend 是单副本、`restart: unless-stopped` 而非 `--scale`。

### 4.9 backend：认证、内部 API、通知、证据、安全日志

**认证（两条路，任一即可启动，但至少一条）**：
- 监护人账号：`POST /api/v1/auth/app` → 常时比较账号口令（sha256 后 `timingSafeEqual`，`auth.js:22-25`）
  → 签发 HMAC 会话令牌（`auth.js:48-66`，TTL 2h）。
- 微信小程序：`POST /api/v1/auth/wechat` → `jscode2session` → openid 是否在**单户允许名单**内
  （`household-auth.js:105-147`），不在则 403。
- 失败限流：同 route+IP 15 分钟内 5 次失败后 429 + `retry-after`（`server.js:51-86,392-396`）。
- 每个业务请求都重新 `isAuthorized(identity.sub)`（`server.js:611-613`）——**允许名单删人后旧令牌立即失权**。

**REST / 内部 ingest 分区**：
- `/internal/v1/**` 用 `x-ingest-key` 常时比较，**任何**内部路由先过这道门（`server.js:440-443`）。
- 设备状态 `POST /internal/v1/device-status` → 202（`:444-465`）；命令 `GET/LIST + POST result`（`:492-506`）；
  证据 `PUT /internal/v1/evidence/<id>`（JPEG + sha256 + 绑定告警，`:467-491`）。
- APP 侧全部 Bearer：`/overview` `/rooms` `/devices` `/alerts` `/ack` `/door-events` `/activity/report`
  `/location` `/contacts` `/safety-logs` `/notifications/subscription` `/communications/*`（`server.js:615-1064`）。
- 错误映射：存储类错误 → 503（`publicError:154-164`），不把内部路径/堆栈回显给客户端。

**通知投递（多终端 + 隐私）**：
- 收件人 = 允许名单 ∩ 已登记订阅授权；客户端**只能给自己登记**（`server.js:878-904`，openid 取自 token）。
- 幂等键按人独立；临时失败指数退避、永久失败立即停（`notify-delivery.js:3-21,114-119`）。
- `recipientRef = HMAC(secret, "域分离前缀\0openid")`，台账只存 `r1_…`，**绝不存 openid**
  （`notify-privacy.js:45-82`）；日志走统一脱敏（手机号/坐标/secret/token 正则，`:27-41`）。

**证据与安全日志**：
- 证据：JPEG 魔数 `FFD8FF…FFD9` + ≤2MiB + sha256（`evidence-store.js:10-12,50-57`），
  30 天保留 + 每分钟 `prune()`（`main.js:342-348`）。
- 安全日志/处置：**与 ACK 完全解耦**——登记处置不生成命令、不改 ACKED、不触发 reset
  （`safety-log.js:9-16`、`server.js:1003-1036`）；`actor` 固定 `household-guardian`，不落 openid。

**健康检查**：`/healthz` 恒 200；`/readyz` 会真的 `probeDataPath` 四个存储路径（`main.js:298-304`），
容器 healthcheck 用的就是它（`compose.public.yaml:80-85`）。

### 4.10 部署：Compose、Caddy、只监听容器网络

- `backend`：`read_only: true` + `tmpfs /tmp` + `no-new-privileges` + `init: true`；
  **只 `expose: 8080`，没有 `ports:`**（`compose.public.yaml:39-85`）。
- `caddy`：只拿 `PUBLIC_DOMAIN`/`ACME_EMAIL` 两个变量，**后端密钥不进它的环境**（`:87-96`）；
  80/443 + 证书命名卷持久化（避免重申请触发 CA 限流，`:98-106`）。
- `Caddyfile`：自动 HTTPS、HSTS、`X-Frame-Options DENY`、`request_body max_size 3MB`（=后端 2MiB + 余量）；
  **日志必须删 `X-Ingest-Key`**——Caddy 默认只脱敏 Authorization/Cookie，自定义头会明文进日志，
  而该密钥能写设备状态、读命令队列（`Caddyfile:61-82`，注释里写明已实测复现）。
- `compose.wearable.yaml`：公网只发布 `1883/tcp`；复用 backend 镜像 + 只读挂载源码；
  诊断端口只在容器内 `127.0.0.1:8099`（`:24-66`）。
- 上线预检 `preflight-public.sh`：不 `source` 变量文件、不 `export`、只打印变量名；
  断言公网上 **1883/9000/9001/9002/9100/9101/8080 不可达**（`:19-30,47-50`）。
- 家庭侧唯一运维动作：`materials/public-sync-health.ps1`（只读，退出码 0/3），
  不健康时提示“人工运行 `materials\start-demo-supervisor.cmd` 并输入 INGEST_KEY”（`:87-88`）。

---

## 5. 设计取舍与坑

| # | 决策/坑 | 为什么这样 | 代价 / 容易踩的点 |
|---|---|---|---|
| 1 | 自建 broker 而不用 EMQX | 实测 1883 被拦，演示不能赌网络（`mqtt_broker.js:5-10`） | 无 retain、无 QoS1 下发、无持久会话、**无鉴权无 TLS**；公网部署必须禁止映射这些端口 |
| 2 | bridge `--relay-ignore` | 板端 status 连接会收到 homemon 广播的 relay 回灌；旧逻辑把回灌当“连接改名”→ retire → DAYU 永久失联 | 每个“板外进程注入 homemon”的 deviceId 都必须登记，漏一个就回到 2026-10-15 事故（`:87-104`） |
| 3 | worker 重启要人工输 INGEST_KEY？ | **只有 supervisor 退出才需要**。key 只存在 supervisor 内存、只经 IPC 下发；worker 崩了由 supervisor 自动重启并**重发 key** | 关掉那个可见窗口 = 只能人工重来；`workerEnv()` 特意删除 env 里的 key（`:244-251`） |
| 4 | QoS0 却不能说“不丢消息” | 只保证 at-most-once；broker 无持久化、retain 被剥、bridge 只缓存“最后一帧” | 能恢复的是“最终一致”（重放最新状态），**不是**“一条都不丢”；网络断开期间的状态变化确实丢了 |
| 5 | 命令必须等设备 ACKED | HTTP 202 只代表入队；`completeCommand` 还要再验一遍 deviceId/state/alarmId 绑定 | 少一步校验就会“假闭环”；等待超时/重试逻辑必须补（8s 回执超时、3 次尝试） |
| 6 | 结果回写失败不推进游标 | 否则下一条命令把上一条“挤掉”，后端永远停在 PENDING | 一条长期 PENDING 会**阻塞**该设备的后续命令（单设备演示可接受） |
| 7 | gateway 13 位毫秒校验写在 gateway 而非 adapter | `adapter` 不读根级 `ts`，而 `bridge/status.json` 里真实存在 10 位秒值历史样本 | 漏校验会让秒级时间戳一路污染到云端；`_reject('INVALID_TIMESTAMP')` 是安全网 |
| 8 | 告警去重与设备状态解耦 | 设备 reset 后同一条 retained 报文可能再来；换真 broker 后“订阅即回放”会真的发生 | 若按“首次见到设备”判重会重复告警；`seenAlarms` 按 `deviceId\0alarmId` 记忆 |
| 9 | OneNET 第一阶段拒绝 ACK | 物模型 `control` 没有 `deviceId`，猜“当前房间”会发错人 | 别把 OneNET 的 `code=400` 当成缺陷；APP ACK 走 backend 命令队列 |
| 10 | mirror 绝不写 9101 | 写 bridge 会被 publish 上 MQTT，再被 public-sync 回灌后端，形成环路 | 只允许 `relay <json>` 注入 homemon 9001 或 PC 9002（`wearable-mirror/README.md:22-23`） |
| 11 | 熔断必须“有界” | 旧实现 CIRCUIT_OPEN 空转 1 小时、永不恢复，现场恢复后也不会拉起 | 现在 60s 后清窗重试（`public-sync-supervisor.js:33-37,367-402`） |
| 12 | 健康不能只看 state.json | 2026-10-27 事故：文件 HEALTHY、锁还在、进程全没了 | 必须 PID+heartbeat 双校验；`--check` 已固化成 CLI |
| 13 | public-sync 有设备白名单 | 旧 command-sync 不校验 deviceId，会把 `esp32-sos` 的 ACK 抢到本机 | 不配白名单时行为与旧版一致（向后兼容是个“坑位”） |
| 14 | backend 不发布主机端口 | 后端本身不做 TLS、不做限流以外的防护，直接暴露等于裸奔 | 任何“临时加个 ports: 8080”的调试都会变成公网漏洞（`compose.public.yaml:16-21`） |
| 15 | MemoryStore 与 PersistentStore 两份 | 单测/嵌入需要无 IO 实现；生产要落盘 | 两份语义必须同步改；`requestAck` 的 ID 分配算法两处不同（内存用长度、持久版用 max+1），改错会 ID 复用 |

---

## 6. 可完善点（ROI 排序）

### A. 安全（最高 ROI，改动小）

| 项 | 改哪里 | 风险 | 验证方式 |
|---|---|---|---|
| broker/bridge 监听面收敛 | `mqtt_broker.js:186-188` 与 bridge `srv.listen(LISTEN_PORT)`（`:932`）改为绑定 `127.0.0.1`（或显式 `--host`，默认回环） | 若真有“另一台 PC 订阅”的需求会被挡；需同步 `--broker` 配置 | 改后 `netstat` 只看到 `127.0.0.1:1883`；`Test-NetConnection <本机LAN IP> 1883` = False |
| 给自包含 broker 加最小鉴权/ACL | `mqtt_broker.js` CONNECT 分支校验 username/password + topic ACL | 需要同时改 bridge/mqtt_tool/sim_node 的连接参数，易把现有演示搞断 | 新增单测：错密码 CONNACK≠0；正确密码可 pub/sub |
| `x-ingest-key` 升级为短期签名 | 后端 `/internal/v1` 门禁（`server.js:440-443`）+ 家庭侧 `cloud-sync.js/command-sync.js` | 双侧必须同时升级，否则直接 401；supervisor 的“只输一次 key”体验会变 | 双跑 24h + 回滚脚本保留旧 key 通道 |
| 公网 1883（wearable-mqtt）加网络层收敛 | `deploy/wearable/compose.wearable.yaml:42-43` + 安全组 | 换 MQTTS 需固件支持（成本高）；先做安全组白名单最划算 | 从非白名单 IP 连 1883 应超时；`/status` 里 `authFailures` 不增长 |

### B. 可观测（第二 ROI）

1. **bridge 结构化指标**：现在只有日志。可在 bridge 内部维护计数器并对 `link_probe.js` 暴露只读 JSON
   （`nodes/activeNodes/relayFailures/replayCount`）。风险低；验证：`--lock-file` 同款开关控制。
2. **把 `command-sync` 的 `stats()` 写进 supervisor 心跳**：`stats()` 已存在（`command-sync.js:311-322,772`），
   但 state.json 只有 PIDs（`public-sync-supervisor.js:178-193`）。加 `cursor/acked/failed` 后，
   排查“ACK 发了没到设备”不用再翻整份日志。
3. **backend 加 `/metrics`**（wearable-mqtt 已有 `/metrics`，`cloud/wearable-mqtt/README.md:159`）：
   统一 `/healthz` `/readyz` `/metrics` 三件套，接监控成本最低。
4. **告警通知失败的可观测**：`notify-delivery` 结构化结果已很完整，但没有对外查询端点；
   加一个只读 `GET /api/v1/notifications/status`（只回计数与状态分布，不含 openid）。

### C. 可靠性

1. **bridge 行缓冲超限改为“丢坏行、保连接”**（`mqtt_bridge.js:328-336`）：现在是直接断开。
   改法：超限时清空 `acc` 并从下一个 `\n` 重新同步，只记一次错误码。风险：可能出现半行误解 → 需要
   “丢弃直到下一个换行”的实现 + 单测。
2. **`command-sync` 游标持久化**：文档已承认“台账只在内存”（`command-sync.js:31-32`）。
   保存 `{cursor, settledCommands[]}` 到 supervisor 的 runtime 目录（**不含密钥**），重启后不必重拉全部 PENDING。
   风险：文件损坏要 fail-safe（回退 0）。验证：`persistent-command-restart-integration.js` 加一轮。
3. **wearable-mqtt 长稳**：README 已列“4G/MQTT 长稳（>1 小时）仍需真机长测”（`:238`），
   建议加一个 8h soak + `parked` 计数采集脚本。
4. **supervisor 增加“worker 存活但不健康”判据**：现在 HEALTHY 只来自 `ready` 一次（`:308-314`），
   之后心跳只写文件。可让 worker 定期 `send({type:'heartbeat'})`，supervisor 侧超时即重启。

### D. 成本/体验

1. **INGEST_KEY 的人工输入窗口**：可用 Windows DPAPI / `cmdkey` / 系统 Secret 存“加密后的 key”，
   由 supervisor 启动时解密——但这**违背“key 不落盘”**的现有原则，属于权衡项，必须评审后再做。
   折中：保持人工输入，但把 `--check` 与 health.ps1 打包成一键“体检 + 提示”脚本（现已有雏形）。
2. **ECS 单点**：Caddy+backend+wearable-mqtt 同机。最低成本兜底是**外部** uptime 探针（每分钟打
   `/healthz` + `/readyz`），失败告警走独立通道，不依赖本机微信链路。

---

## 7. 本层最容易被误解的 3 个点

**① “state.json 写着 HEALTHY，所以同步是好的”。**
错。2026-10-27 16:25 的事故里，supervisor+worker 都已退出，但 state.json 停在旧的 `HEALTHY`、
lock 文件也还在，监视器因此**永久误报健康、从不拉起**（`materials/public-sync-health.ps1:1-9`）。
判据必须是：lock PID 存活 + worker PID 存活 + heartbeat 新鲜 + state==HEALTHY 四者同时成立
（`public-sync-supervisor.js:472-513`），日常用 `materials\public-sync-health.ps1`（只读、退出码 0/3）。

**② “MQTT QoS0 + retain 意味着消息不会丢”。**
错。本项目的 broker **不实现 retain**（转发时把 flags 置 0，`mqtt_broker.js:158`），也不持久化会话；
QoS0 是 at-most-once。真正提供“最终一致”的是 bridge 的三处内存缓存：
MQTT 重连重放最后状态（`mqtt_bridge.js:754-763`）、relay 恢复补发（`:434-442`）、
mirror 重连补发 `lastLine`（`wearable-mirror/src/transport.js:107-110`）。
**断网期间的状态变化就是丢了**——所以不要对外宣称“MQTT 保证不丢消息”，只能说“恢复后能追上最新状态”。

**③ “改完配置重启 worker 又要重新输 INGEST_KEY”。**
错。key 只在 **supervisor** 内存里，worker 崩溃由 supervisor 自动重启并**重新 IPC 下发**
（`public-sync-supervisor.js:253-365`）；`workerEnv()` 还刻意把 `INGEST_KEY`/`BACKEND_INGEST_KEY`
从子进程环境里删掉（`:244-251`）。**只有 supervisor 自己退出**（窗口被关、被控制台事件杀掉）
才需要人工重输。同理：worker 的 key 不会写进 argv/env/文件/日志，所以“在日志里找 key”永远找不到——
这正是设计目标，不是缺陷。

---

## 8. 阅读顺序建议

1. **先立拓扑**：`docs/PROJECT-GUIDE/01-ARCHITECTURE.md` §2/§3（进程、端口、六条数据流）→ 本文 §1、§3。
2. **再读协议层（最短闭环）**：`bridge/mqtt_broker.js`（190 行，一次读完）→ `bridge/mqtt_bridge.js`
   的 `MqttClient`(134-290) 与 `publishStatus`(390-401)。
3. **OneJSON 与 TLS**：`cloud/onenet/adapter.js` → `token.js` → `transport.js`（三份都不长，且注释即文档）。
4. **网关聚合**：`gateway.js` 的 `ingest/_applyStatus/_markOffline`（296-639），再读 `cloud-sync.js`。
5. **命令反向链路**：`cloud/backend/src/store.js` 的 `requestAck/completeCommand`（656-740）→
   `command-sync.js` 的 `handleCommand/pollOnce`（592-754）。**先看后端再看同步器**，否则不知道游标在等什么。
6. **进程模型**：`public-sync.js`（看 TTY 读 key）→ `public-sync-supervisor.js` → `public-sync-worker.js`
   → `materials/start-demo-supervisor.ps1`（看一键入口与跨入口保护）。
7. **后端全貌**：`server.js` 路由表（按 §2.3 行号跳读）→ `persistent-store.js` 的原子写与加载（715-849）。
8. **穿戴旁路**：`cloud/wearable-mqtt/README.md`（读完就够）→ `wearable-mirror/README.md` → 代码按需。
9. **部署**：`deploy/compose.public.yaml` → `deploy/Caddyfile`（重点看日志过滤那段注释）→
   `deploy/verify/preflight-public.sh` 顶部安全约定。
10. **排障顺序**（现场最实用）：端口（1883/9101）→ `mqtt_tool.js sub` 看有无上行 →
   `bridge.out.log` 有无 `→ home/<dev>/status` → worker 日志有无 `[cloud-sync] OK` →
   后端 `/healthz` `/readyz` → 最后 `public-sync-health.ps1`。

> 与其他文档的分工：设备固件/板端 homemon 见 `02-DEVICE.md`；手机 APP/板端 APP 见 `03-APP.md`，视觉/视频见
> `05-VISION-VIDEO.md`。本文只对“传输与云”负责，跨层结论以 `docs/ARCHITECTURE.md` 与
> `docs/VALIDATION-MATRIX.md` 为准。
