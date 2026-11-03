# wearable-mqtt — 随身 SOS 公网 MQTT Broker + 后端适配器

零 npm 依赖、单进程的 Node 服务：内置最小 **MQTT 3.1.1 Broker**（0.0.0.0:1883，
用户名/密码 + Client ID 白名单）与**后端适配器**（同进程直接走 broker 内部事件），
用于 M100MG-B1 4G DTU ↔ 公网后端 ↔ 监护人 APP 的随身 SOS 链路。

```
ESP32-S3 按键 → M100MG-B1 (4G/MQTT 透传) ──MQTT 1883──> wearable-mqtt
                                                        │ POST /internal/v1/device-status (SOS/hb/boot + gps)
                                                        │ GET  /internal/v1/commands?after=N
                                                        │ POST /internal/v1/commands/<id>/result (仅设备真实回执后)
                                                        ▼
                                                   backend（同 Docker 网络 backend:8080）
```

## 1. 交付边界（不夸大）

| 项 | 状态 |
|---|---|
| MQTT 3.1.1 Broker | CONNECT/鉴权/CONNACK、SUBSCRIBE/SUBACK、PUBLISH QoS0/1(回 PUBACK)、PING、DISCONNECT、Keep Alive 1.5× 超时、`+`/`#` 通配、retain 可接受不保存 |
| 适配器 | SOS 建告警（本地去重）、hb/boot 在线状态、M100 GPS 固定格式解析、ACK 命令下发 + 真实回执回写 |
| 位置上报 | **只走 `POST /internal/v1/device-status` 的 `gps` 字段**（公网现网后端没有 `/api/v1/ingest/wearable/location` 路由，实测 404；位置随 device-status 已支持） |
| 无回执 | **绝不代报** ACKED/FAILED，后端命令保持 PENDING（APP 显示等待） |
| QoS2 | 不支持 exactly-once（只做 PUBREC/PUBCOMP 握手，按至少一次投递） |
| 会话 | 不持久化（cleanSession 接受，sessionPresent 恒 0），订阅关系在断线后由设备重新 SUBSCRIBE |
| **断连自愈（v1.0.1）** | 链路恢复/业务上行触发 parked ACK 立即重投；业务上行静默超阈值如实上报 `online=false`；boot 不伪造“已解除”；最后已知设备状态持久化（不含坐标） |
| TLS | 不支持（契约要求 1883 用户名/密码明文；公网链路风险见 §7） |
| 依赖 | **无任何 npm 依赖**（仅 Node 内置模块），Node ≥ 20（ECS 复用 node:24-alpine 镜像） |

## 2. 文件结构

```
cloud/wearable-mqtt/
├── server.js              容器 entrypoint（node /opt/wearable/server.js）
├── package.json           无 dependencies；scripts: start / test / status
├── src/
│   ├── main.js            进程入口：加载状态 → 诊断端口 → broker → 适配器；优雅关闭
│   ├── config.js          环境变量解析（fail-fast，错误不含密钥值）
│   ├── logger.js          结构化脱敏日志（单行、固定短码、敏感键 redacted）
│   ├── mqtt-protocol.js   MQTT 3.1.1 报文编解码 + 主题匹配（独立纯函数）
│   ├── mqtt-broker.js     内置 Broker（鉴权、QoS0/1、Keep Alive、通配、连接接管）
│   ├── gps-parser.js      M100 GPS 固定格式解析（WGS84 十进制/度分双兼容 + 范围校验）
│   ├── backend-client.js  后端 HTTP 客户端（指数退避重试、脱敏诊断）
│   ├── state-store.js     DATA_DIR 原子持久化（GPS 帧计数、命令游标、当日 SOS 计数）
│   ├── adapter.js         SOS/hb/boot/GPS/ACK 命令/回执 业务逻辑
│   └── status-server.js   127.0.0.1:8099 /status /healthz /metrics
├── tools/status.js        诊断 CLI（node tools/status.js --health）
└── test/                  node --test（假 HTTP 后端 + 裸 TCP MQTT 客户端）
```

## 3. 环境变量

| 变量 | 必需 | 默认 | 说明 |
|---|---|---|---|
| `MQTT_USER` / `MQTT_PASS` | ✅ | — | M100 登录凭据（Broker 只接受这一组） |
| `INGEST_KEY` | ✅ | — | 后端 `/internal/v1/**` 的 `x-ingest-key` |
| `MQTT_PORT` | | `1883` | 监听端口（`0`=随机，仅供测试） |
| `MQTT_CLIENT_ID` | | `wearable-sos-001` | Client ID 白名单，逗号分隔可配多个（测试用） |
| `UP_TOPIC` | | `eldercare/wearable/sos-001/up` | 上行主题 |
| `DOWN_TOPIC` | | `eldercare/wearable/sos-001/down` | 下行主题 |
| `BACKEND_BASE` | | `http://backend:8080` | 后端基址（同 Docker 网络） |
| `DEVICE_ID` | | `esp32-sos` | 后端告警设备 ID（硬契约） |
| `LOCATION_DEVICE_ID` | | `wearable-sos-001` | 身份/诊断保留值；当前无独立位置接口 |
| `DATA_DIR` | | `<cwd>/data` | seq/游标/当日计数/**最后已知设备状态（不含坐标）** 的持久化目录（容器内 `/data` 数据卷） |
| `DEVICE_MQTT_CLIENT_ID` | | `MQTT_CLIENT_ID` 的第一个 | 设备侧（M100）MQTT 身份：用于把 broker `clientConnect/clientDisconnect` 识别为“本设备链路变化” |
| `DEVICE_ALIVE_TIMEOUT_MS` | | `120000` | 业务上行（sos/hb/boot/ack）静默超过该时长才上报 `online=false`；默认 4×心跳周期，容忍 2 次丢帧 |
| `STATUS_HOST`/`STATUS_PORT` | | `127.0.0.1`/`8099` | 诊断 HTTP，只监听回环，不对外发布 |
| `COMMAND_*` / `HTTP_*` / `SOS_DEDUPE_TTL_MS` / `LOG_LEVEL` | | 见 `src/config.js` | 轮询/重试/去重调优 |

> `WEARABLE_LOCATION_TOKEN` 已**不再需要**：公网现网后端没有 wearable location 路由，
> 位置随 `device-status.gps` 上报。

## 4. 契约要点（DESIGN-CONTRACT §3–§5）

### 4.1 上行

| 报文 | 处理 |
|---|---|
| `{"t":"sos","alarm":"sos-...","gps":{...}\|null}` | 本地按 alarmId 短时去重（30 min，可配）；`POST /internal/v1/device-status`：`state=ALARM`、`alarm{id,type:MANUAL_SOS,countToday}`、`gps`。同一 alarmId 重试不重复刷接口，后端按 alarmId 幂等 |
| `{"t":"hb","state":"IDLE\|ALARM",...}` | 更新在线/`lastSeen`；`POST device-status`（IDLE→NORMAL；ALARM 带 alarm.id，可兜底补建告警） |
| `{"t":"boot"}` | 立即恢复在线（NORMAL） |
| `{"t":"ack","alarm":"...","cmd":"<id>"}` | 只有与在投递/已 parked/慢速重投中的命令 **alarm+cmd 完全匹配**才回写结果 |
| M100 GPS 固定格式（非 JSON，真机实测如 `112.55326080300_32.966827393000`） | 解析 WGS84 十进制度 → 维护“最新位置”，**不调用任何 HTTP**；无时间字段，`fixTime` 固定用服务器收到报文的时间；解析失败只记 `gpsParseFailures`，绝不写假坐标 |

事件位置语义（Lead 2026-10-27 决策）：

- SOS 时把“当时最新位置”快照为 `eventGps`；
- 本事件未 ACK 前，所有 `device-status` 的 `gps` 都发 `eventGps`（求助时刻位置），后续 GPS 报文只更新“最新位置”；
- 收到设备真实 `t:"ack"` 后清除事件快照，恢复发最新位置；
- 无 fix 时 `gps:{valid:false,latitude:null,longitude:null,fixTime:0}`，绝不用 `(0,0)`；
- APP 用 `fixTime` 与告警 `createdAt` 比较，标注“求助时刻位置 / 求助后更新”。

### 4.2 下行 ACK 命令

- `GET /internal/v1/commands?after=<cursor>`（`x-ingest-key`），`after` 为严格大于游标；
- 只处理 `deviceId==="esp32-sos" && command==="ACK" && status==="PENDING"`；
  其他设备/非 ACK/已完成命令只推进游标，**绝不下发/广播**；
- 下发 `{"v":1,"t":"ack","alarm":"<alarmId>","cmd":"<commandId>"}\n` 到 `DOWN_TOPIC`；
  **必须带结尾 `\n`**：M100 MQTT 透传下行是“payload 原样写串口、不追加换行”，
  而 ESP32 固件按行解析，缺 `\n` 时 ACK 会卡在行缓冲里不被处理（真机已复现：
  补 `\n` 后立即“收到匹配 ACK → 停止提示 → 回设备回执”）。上行方向设备自带 `\n`，适配器入口统一 `trim`；
- 重发 3 次（默认间隔 5s）；仍无回执 → 本地 parked（后端保持 PENDING），
  默认 60s 后回读后端，若仍 PENDING 再投一轮（默认最多 3 轮）；
  轮次用尽后进入**低频慢速重投**（默认 5min/轮，`COMMAND_SLOW_RETRY_MS`），
  这样用户重新点击（后端仍返回同一条 PENDING 命令）最终也能下发；
  **任何情况下都不 POST FAILED/ACKED 代报**；
- 设备真实回执匹配后：`POST /internal/v1/commands/<id>/result`
  `{"status":"ACKED","deviceState":{deviceId,room,online,state:"ACKED",ts,alarm:{id,type,countToday},gps}}`；
  回写失败按指数退避重试，成功前不推进游标；
- 命令游标只在“本地终态”时推进（其他设备/非 ACK/已完成/已回写/已本地超时）；
  未完成命令不会因重启丢失——重启后 `after` 续读会重新看到它。

## 5. 本地运行 / 自测

> ⚠ 本机可能已有 1883/9101 在跑（现有 broker/bridge）：本地自测请用 **1884/8098** 等临时端口，
> 不要占用 1883/9101，也不要重启现有 broker/bridge。

```bash
# 1) 单元/集成测试（假后端 + 裸 TCP MQTT 客户端；端口全部由系统分配）
npm test            # 等价 node --test "test/*.test.js"

# 2) 最小真实进程自测（需要一个可达后端；没有后端时用测试的 fake-backend）
MQTT_PORT=1884 STATUS_PORT=8098 \
MQTT_USER=wearable-user MQTT_PASS='change-me' \
INGEST_KEY='change-me' BACKEND_BASE='http://127.0.0.1:8080' \
DATA_DIR="$PWD/.local-data" node server.js

# 3) 诊断
node tools/status.js --url http://127.0.0.1:8098/status
node tools/status.js --url http://127.0.0.1:8098/status --health
```

测试覆盖（49 项，`node --test` 全绿）：

- Broker：错误密码拒绝（CONNACK 4）、Client ID 白名单（CONNACK 5）、SUBSCRIBE/SUBACK、
  QoS1 PUBACK、QoS0、`+/#` 通配、PING、retain 不崩、Keep Alive 1.5× 超时、
  畸形报文不影响进程、同 Client ID 接管、内部 `publish()` 下行；
- 适配器：SOS 建告警字段、重复 SOS 去重、无 GPS 时 `valid:false`、hb/boot 在线状态、
  GPS 十进制/度分双兼容、坏报文只计数、事件位置快照不被覆盖、ACK 后恢复最新位置、
  HTTP 500 指数退避重试、GPS 帧计数跨重启单调；
- 命令：3 次重发、无回执不代报、真实回执后 `result` 字段、alarm/cmd 不匹配拒绝、
  其他设备命令不下发、重启 `after` 续读、本地超时慢速重投后迟到回执仍真实上报、
  **downlink payload 以 `\n` 结尾**（M100 下行不补换行）；
- 断连自愈（`test/reconnect-recovery.test.js`，8 项）：链路恢复/boot 后 parked ACK **<10s 重投**且不代报、
  同一 alarmId 跨重连不重复告警、静默超阈值才 `online=false`（含去抖、ts 不用 PC 时间）、
  恢复首个上行立即 `online=true`、容器重启不回退 ACKED/不丢未确认求助（持久化不含坐标）、
  后端响应缺项时不静默丢弃 parked ACK；
- 诊断端口与“真实子进程 `node server.js`”冒烟（启动 → SOS/GPS → /healthz → 退出）。

> M100 重启后约需 **20~30 秒**才完成 MQTT 连接与下行订阅；
> 现场测试请等 **NET 灯 1000ms 慢闪**后再验证下行 ACK，避免把“尚未订阅”误判为链路故障。
> 可用 `config,get,netchaninfo,1` 读取通道配置核对。

## 6. 诊断

- `GET /healthz`：broker 监听中且未在关闭 → `200 {"ok":true}`；否则 503（运维探针用）。
- `GET /status`：配置摘要（无密钥）、broker 连接/订阅、适配器设备状态、`latestGps`、
  `activeAlarm`（含 `eventGps`）、命令游标/inflight/parked（含 slow）、HTTP/错误计数。
- `GET /metrics`：`wearable_mqtt_<layer>_<counter>` 纯文本计数。
- 日志：单行结构化，敏感键 `[redacted]`；错误只输出固定短码（如 `SOS_STATUS_POST_FAILED code=HTTP_ERROR`）。

## 7. 安全与已知风险

- **公网 1883 明文**：用户名/密码会以明文在网络中传输（契约如此）。必须使用强密码，
  并在安全组尽量限定来源；后续若要 TLS，需设备侧支持 MQTTS 且单独评审。
- 端口边界：本服务只发布 **1883/tcp**；绝不允许暴露 8080/9000/9001/9100/9101。
- 诊断端口只绑 `127.0.0.1:8099`，不加入 compose `ports`。
- 数据卷含 GPS 坐标（随 device-status 上报，本服务只持久化 seq/游标/计数，不落盘坐标）。
- **GPS 固定格式（真机已实测）**：`经度_纬度`，WGS84 十进制度，例如
  `112.55326080300_32.966827393000`（无时间字段；`fixTime` 用服务器收到报文的时间）。
  十进制是主路径；代码同时保留度分 `ddmm.mmmm` 与 `GPS_E_.._N_.._END` 兼容分支，
  坏报文只计数、绝不写假坐标。
- 旧家庭网关 `onenet/command-sync` 也会轮询同一命令队列且不校验 deviceId，
  演示期间**不要启动旧 public-sync/gateway**（Lead 已在交付说明中列为演示约束）。
- 命令游标只在本设备命令“本地终态”后推进；一条长期无回执的 PENDING 命令会阻塞
  该设备的后续命令投递（单设备演示可接受）。慢速重投会持续尝试，直到设备回执或
  后端命令被外部结算。
- 部署与回滚见 `competition/deploy/wearable/README.md`。

## 8. v1.0.1 断连自愈（2026-10-27）

现场问题：设备重启窗口内下行 ACK 3 次投递全丢 → 命令 parked → 只能等 60s/5min 定时器，
现场表现是「ACK 未送达，docker restart wearable-mqtt 才恢复」；设备离线后 APP 仍显示旧 `online=true`。
本版本在不改后端、不伪造任何状态的前提下修复：

### 8.1 `parked` ACK 的事件驱动重投（核心）

- broker `clientConnect`（设备 MQTT 链路恢复）或任一**业务上行**（boot/hb/sos/ack）到达时，
  立即把 parked 命令的 `nextCheckAt` 清零、把 `slow` 慢速档位降回正常、重置轮次；
  下一次轮询（默认 ≤1s）即回读后端并重投。
- 效果等价于以前唯一的“偏方” `docker restart wearable-mqtt`（重启只是清内存状态 + 游标续读）。
- 重投**仍然不是确认**：不收到设备真实 `t:"ack"` 就绝不 POST ACKED/FAILED，命令保持 PENDING。

### 8.2 离线语义：静默看门狗（去抖）

- 只看“业务上行”（sos/hb/boot/ack）；M100 自己主动上报的 GPS 固定格式行**不算**设备存活
  （否则 ESP32 断电会被 M100 的 GPS 掩盖）。
- 静默超过 `DEVICE_ALIVE_TIMEOUT_MS`（默认 120s）才上报一次 `online=false`；恢复时首个业务上行立即 `online=true`。
- 离线上报**保留最后已知 state/alarm.id/csq**，`ts` 用最后一次真实业务上行时间（绝不用 PC 当前时间冒充设备时间），
  `gps` 只在有真实定位时携带原始 `fixTime`。
- 注意：后端 `lastSeenTs` 的语义是「服务器最后一次收到该设备状态的时间」（`store.js` 用 `receivedAt`），
  离线上报会把它更新为上报时刻。**APP 应以 `online=false` 作为“不再实时”的判据**；
  `lastSeenTs` 的“陈旧判定”属于 backend/APP 语义，本服务不改公网后端（见 §8.6）。

### 8.3 boot 与未确认事件

- `boot` 不再无条件报 `NORMAL`：本地若存在未确认事件，报 `ALARM + alarm.id`（fail-safe，不伪造“已解除”）；
  设备重启后若事件仍在 NVS，会立即用原 alarmId 重发 SOS，状态自然维持。
- 只有设备**明确 IDLE 心跳**才清除本地事件快照并记 `ACTIVE_EVENT_CLEARED_BY_DEVICE`；
  后端告警**不会**被代报成 ACKED（人仍能在 APP 看到未确认告警，必要时走人工处置）。

### 8.4 不静默丢 ACK / 不丢未确认求助

- `_checkParked` 回读后端时，若响应里**缺少**该命令，不再当作“已外部结算”删除，
  而是保留并继续按节奏重投（`COMMAND_PARKED_LOOKUP_MISSING` 计数）。
- `DATA_DIR` 持久化“最后已知设备状态”（`state/alarmId/csq/lastSeen/lastBusinessUplinkAt`，**不含坐标**）：
  容器重启后若设备不回来，适配器仍能如实上报 `online=false` 且保留未确认告警的 `alarm.id`；
  已 ACKED 不会回退，命令游标继续 `after` 续读。

### 8.5 新增诊断字段（`/status`）

`adapter.link = { deviceClientId, aliveTimeoutMs, watchdogArmed, offlineReported }`；
`adapter.counters` 新增 `deviceLinkUps/deviceLinkDowns/deviceOfflineReports/deviceStateRestored/
parkedRecoveryTriggers/parkedLookupMissing/activeEventClearedByDevice/activeEventReplacedByDevice`；
`state.device` 显示持久化的最后已知设备状态快照。

### 8.6 未解决 / 建议（不改公网 backend）

1. **APP 陈旧判定**：后端 `online` 只由载荷写死，没有服务端陈旧计算；本服务已尽力如实上报
   `online=false`，但若 APP 只看 `lastSeenTs`/不刷新，仍可能显示旧数据。建议 APP 用 `online`
   标志 + 本地“最后刷新时间”，对 `lastSeenTs` 过期显示“数据可能已过期”。
2. **后端 `lastSeenTs` 语义**：它等于服务器收到“最后一次状态上报”的时间，不是设备心跳时间；
   离线报告会刷新它。长期方案建议 backend 增加 `lastDeviceUplinkTs` 或由服务端按阈值推导 online。
3. **设备侧事件丢失（NVS 损坏）**：设备重启后若丢失未确认事件，后端告警会保持未确认；
   此时 APP 再点“确认”会产生 PENDING 命令但设备无匹配事件（固件会忽略不匹配 ACK），
   命令会一直 PENDING。建议现场用“登记处置”而非重复点确认；该场景已计数并写日志
   （`ACTIVE_EVENT_CLEARED_BY_DEVICE`），不会伪造 ACKED。
4. M100 的 4G/MQTT **长稳（>1 小时）**仍需真机长测；本轮已补代码级回归，未做长稳实测。
