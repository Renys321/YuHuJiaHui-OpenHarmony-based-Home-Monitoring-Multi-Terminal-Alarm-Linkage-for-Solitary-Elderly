# wearable-mirror — 随身 SOS 的 PC 侧镜像服务（DAYU200 北向显示）

**状态**：已实现并通过单测；数据源与注入通道均可切换。当前批准的主路径是
`--source api`（现有监护人账号只读轮询公网 APP-API），`--source mqtt` 待 ECS Broker
把镜像 clientId 加入白名单后启用。**relay 注入**在 bridge 新版本（`--relay-ignore esp32-sos`）
与 homemon `MAX_CLIENTS>=8` 部署前只做本地假环境验证，不对现网注入。

## 1. 为什么需要它

随身 SOS（`esp32-sos`，ESP32-S3 + M100 4G）走 **4G → 公网 ECS → 后端 → 手机 APP**，
完全不经过 PC bridge / DAYU homemon，所以 DAYU200 本地链路永远收不到它。
本服务在 PC 上把这条已存在的事件镜像成 homemon/TCP 能广播的状态行：

```
                 ┌─(MQTT 直订，待 ECS 白名单)──┐
公网 ECS/后端 ───┤                              ├─► 状态机(同 alarmId 一条/ACK 严格/GPS 不造假)
   │             └─(APP-API 只读轮询，当前主路径)─┘            │
   │                                                          ├─► relay 注入 homemon 9001 ─► DAYU APP
   └─ 手机 APP 本来就是同一 alarmId/ACKED/位置                  └─► PC 监听 9002 + hdc rport ─► DAYU APP
```

**绝不连接 bridge 的 9101 端口**：那会把镜像状态重新发布到 MQTT，public-sync 再回灌后端，
形成环路。注入只写 homemon 的 9001（`relay <单行JSON>`）。

## 2. 目录

| 路径 | 说明 |
|---|---|
| `server.js` | 入口（参数/环境变量解析、信号处理） |
| `src/config.js` | 配置解析（凭据只从 env/凭据文件读取，日志/状态文件不出现密钥） |
| `src/mqtt-client.js` | 零依赖 MQTT 3.1.1 客户端（CONNECT/SUBSCRIBE/PUBLISH/PING/重连；鉴权拒绝不重连） |
| `src/gps.js` | 复用 `competition/cloud/wearable-mqtt/src/gps-parser.js`（只读 require），M100 固定格式 GPS |
| `src/model.js` | 纯状态机（可单测）：sos/hb/ack/boot + 固定格式 GPS + API 快照 |
| `src/source-mqtt.js` | 数据源：订阅 `UP_TOPIC` |
| `src/source-api.js` | 数据源：现有监护人账号登录并轮询 `/devices`、`/alerts`、`/location` |
| `src/transport.js` | 注入通道：relay（homemon 9001）、tcp（PC 监听，配 hdc rport） |
| `src/mirror.js` | 编排：变化去抖推送 + 10s 心跳 + 状态文件 + 单实例锁 + 优雅退出 |
| `src/lock.js` | 单实例锁（pid 存活检测，崩溃残留可接管） |
| `scripts/start-mirror.ps1` | 启动（默认 api + tcp；可准备 hdc rport；单实例检查） |
| `scripts/stop-mirror.ps1` | 停止（只按 pid 停本服务；可选 `-RemoveRport`） |
| `tools/observe-up.js` | 只读诊断：直连 Broker 观察 UP_TOPIC（不发布、不落原始 payload） |
| `test/` | `node --test`：37 项单测/集成测试（fake broker / fake homemon / fake API） |

## 3. 运行

```powershell
# 当前主路径（默认参数就是这套）
.\scripts\start-mirror.ps1

# 只启动数据源、不注入（排查用；PC 监听 19002）
node server.js --source api --transport tcp --listen-port 19002 --runtime-dir .\runtime

# MQTT 白名单就绪后（source=mqtt）
node server.js --source mqtt --transport both

# 只打印脱敏配置
node server.js --print-config

# 停止
.\scripts\stop-mirror.ps1
# 同时清理 hdc rport
.\scripts\stop-mirror.ps1 -RemoveRport
```

常用参数：`--source auto|mqtt|api`、`--transport relay|tcp|both`、`--relay-to 127.0.0.1:9001`、
`--listen-port 9002`、`--heartbeat-ms 10000`、`--offline-after-ms 45000`、`--poll-ms 3000`、
`--env-file`、`--guardian-file`、`--runtime-dir`、`--client-id`。
`start-mirror.ps1` 会在 relay 模式下检查 9001 可达，在 tcp 模式下按需执行
`hdc -t <target> rport tcp:9002 tcp:9002`。

### 运行文件

| 文件 | 内容 |
|---|---|
| `runtime/mirror.log` / `mirror.err.log` | 运行日志（不含任何密钥） |
| `runtime/mirror-status.json` | 脱敏状态快照：source、phase、online、event、gps、计数器、通道状态 |
| `runtime/mirror.pid` | 由启动脚本写入，停止脚本据此精确停进程 |
| `runtime/mirror.lock` | 单实例锁（node 进程持有；重复启动会以退出码 3 拒绝） |

## 4. 语义（与 DESIGN-CONTRACT.md 对齐）

- **同一 alarmId 只一条**：设备每 10s 重发同一 SOS 时只更新心跳，不新建事件；`eventTs`
  固定为第一次收到的时间。不同 alarmId 才是新事件（旧 id 迟到报文被忽略）。
- **ACKED 只认真实回执**：
  - `source=mqtt`：仅当收到设备 `t:"ack"` 且 `alarm` 与当前事件一致才置 ACKED；
    `hb` 的 IDLE、超时、静音都**不能**推断 ACKED（只计 `hbIdleWhileAlarm`，保持待处理）。
  - `source=api`：原样镜像后端告警状态；后端只在收到设备真实回执后才置 ACKED
    （DESIGN-CONTRACT §5.3），镜像不自造、不代报。
- **位置不造假**：有 fix 才 `valid:true`；无 fix 时 `valid:false` 且经纬度 `null`
  （绝不用 0 冒充）。事件未 ACK 前 `gps` 冻结为求助时刻快照，ACK 后跟随最新位置。
  M100 固定格式解析与 ECS 适配器共用同一个 `gps-parser.js`。
- **不伪造房间传感器**：随身设备没有 PIR/门磁/温湿度，状态行固定
  `sensors.motion={lastActiveTs:0,countToday:0,supported:false,reported:false,reason:"not_configured"}`，
  其余传感器 `supported:false`。DAYU 侧据此显示“未配置 PIR，无活动监测”，
  不会把“没有 PIR”当成“长时间无活动”。
- **推送节奏**：状态变化去抖后立即推送；无变化每 10s 心跳一次；relay 重连/新 TCP 客户端
  接入时补发**当前**状态一次（不重放历史，不产生重复告警）。
- **时间字段**：`ts` = PC 生成该行的毫秒时间；`lastSeen` = PC 最近一次收到该设备新数据的
  毫秒时间；`eventTs` = 事件时间（设备/后端给出，mqtt 源为 PC 首次收到 SOS 的时间）。

### 状态行示例

```json
{"deviceId":"esp32-sos","room":"随身求助","ts":1793112000000,"state":"ALARM","online":true,
 "lastSeen":1793111995000,"alarm":{"id":"sos-2-124737aa","type":"MANUAL_SOS","countToday":1},
 "eventTs":1793111900000,"acked":false,"ackTs":0,"ackSource":"",
 "gps":{"valid":true,"latitude":32.9668274,"longitude":112.5532608,"fixTime":1793111990000},
 "sensors":{"motion":{"lastActiveTs":0,"countToday":0,"supported":false,"reported":false,"reason":"not_configured"}, ...},
 "history":[0,0,0,0,0,0,0],"slots":[0,0,0,0],"source":"api","mirror":{...}}
```

## 5. 跨组件依赖（上线前必须满足）

1. **relay 模式**：bridge 新版本必须支持 `--relay-ignore esp32-sos`（板端 status 连接收到该
   deviceId 直接忽略，不 bind/不改名/不 retire/不写 status 文件）。否则 homemon 广播回灌会让
   bridge 每 10s 判定“节点改名”并重建客厅连接（2026-10-15 事故机制）。
2. **homemon `MAX_CLIENTS` 由 4 提到 8**：当前 bridge 占 2 路、板端 APP 占 1 路，镜像再占 1 路；
   第 4 路还被 `demo-autostart.ps1` 的 9001 探针每 10s 占用。
3. **MQTT 模式**：ECS `wearable-mqtt` 的 env `MQTT_CLIENT_ID` 需追加镜像 clientId
   （逗号分隔，如 `wearable-sos-001,wearable-mirror-001`）并重启容器。**绝不复用
   `wearable-sos-001`**（同 id 会把 M100 设备踢下线）。未加入白名单时 CONNACK rc=5，
   `--source auto` 会明确记录并 fallback 到 api（若配置了监护人凭据）。

tcp 模式（PC 9002 + `hdc rport`）不需要 bridge/homemon 改动，可作为 relay 就绪前的可用通道；
DAYU APP 的候选端口本来就含 9002。

## 6. 测试

```powershell
cd competition/cloud/wearable-mirror
node --test
```

覆盖：同 alarmId 去重、ACK 严格匹配（不匹配/重复/IDLE 不推断）、M100 GPS 真机样例/坏报文/
(0,0)/无 fix 不写假坐标、事件位置冻结与 ACK 后跟随、boot 不清未完成事件、API 快照
ALARM→ACKED 只随后端 ACKED、401 重新登录、登录失败不伪造数据、relay 行格式、断线重连补发、
TCP 通道忽略入站 ACK、单实例锁、无真实数据前不推“一切正常”、状态文件不含口令。

## 7. 已知限制

- `source=api` 是轮询（默认 3s）而非推送；后端 `online` 标志若与 `lastSeenTs` 矛盾，
  镜像以“在线且 lastSeen 在阈值内”为准，避免把陈旧数据当实时。
- `source=mqtt` 依赖 ECS 白名单改动（当前未做）。
- 明文 MQTT 无 TLS（竞赛演示配置，与现网适配器一致）。
- 本服务只读数据源、只写 homemon relay 行或只读 TCP 广播；不写后端、不发 MQTT、不 ACK。
