# 01 · 系统架构与端到端数据流

> 本文只讲**稳定架构**（组件、数据流、协议、部署），验证状态看 `docs/VALIDATION-MATRIX.md`。
> 与 `docs/ARCHITECTURE.md` 的关系：那份是协议摘要，本文补全**运行时视角**（进程、端口、时序、故障域）。

---

## 1. 分层视图

```
┌───────────────────────── 应用层 ─────────────────────────┐
│ 手机 APP(ArkTS)            板端 APP(ArkTS, DAYU200)      │
│ 首页/监测/设备/告警/统计    本机看板/四房间在线/处置       │
└───────────▲──────────────────────────▲──────────────────┘
            │ HTTPS(ECS API)          │ TCP 9000(homemon)
┌───────────┴────────── 云与传输层 ─────┴──────────────────┐
│ 可信后端(ECS, Node.js)   Caddy(TLS)                      │
│ public-sync worker/supervisor(PC)  ← MQTT →  broker:1883 │
│ 穿戴镜像(PC)                          bridge:9101(PC)    │
└───────────▲──────────────────────────▲──────────────────┘
            │ MQTT/HTTPS                │ TCP 行协议(JSON+\n)
┌───────────┴────────── 边缘层 ────────┴──────────────────┐
│ DAYU200: homemon(C) + 视觉推理(Python/NCNN) + 视频流 9301  │
│ 本地声光/语音/告警状态机/路由                             │
└───────────▲──────────────────────────────────────────────┘
            │ GPIO/I2C/ADC/单总线/摄像头(MIPI-CSI2)
┌───────────┴────────── 设备层 ────────────────────────────┐
│ ESP32-S3 厨房/卫生间节点      4G 随身求助节点             │
│ PIR/门磁/AHT20/MQ-2/MQ-5/    SOS/电池/GPS                 │
│ KEY0/蜂鸣器/语音/LED                                     │
└──────────────────────────────────────────────────────────┘
```

---

## 2. 运行时视图（实测进程与端口）

| 进程 | 语言 | 监听 | 关键连接 | 日志/状态 |
|---|---|---|---|---|
| `mqtt_broker.js` | Node | `:1883` | 各订阅端 | `broker-wifi.out.log`（活日志） |
| `mqtt_bridge.js` | Node | `:9101` | ↔ 板端 `9001`（状态+relay）、→ broker、← 无线节点 | `bridge.out/err.log` |
| `public-sync-supervisor.js` | Node | — | 拉起/监督 worker | `public-sync-supervisor.log` |
| `public-sync-worker.js` | Node | — | ← broker、→ ECS `443` | 同上（worker 输出） |
| `server.js`(wearable-mirror) | Node | `:9002` | → 板端 `9001`、→ ECS API | `mirror.log` / `mirror-status.json` |
| `server.js`(video relay) | Node | `:9443` | → 板端 `9301`、↔ APP(WS) | `relay-*.log` |
| `homemon` | C | `:9000`（板内） | ← APP、← bridge、← mirror | `/data/homemon/*.log`、`status.json`、`safety.log` |
| `dayu_local_fall` | C++/NCNN | `:9200` | 写 `demo-events.jsonl` | `demo-server.log` |
| `demo-autostart.ps1` | PowerShell | — | 每 2s 巡检 P0/APP/推理/fport | `watcher-state.json` |
| `start-demo-supervisor.ps1` | PowerShell | — | 起 broker/bridge/supervisor | 该窗口输出 |

**宿主机侧关键约束**：
- 板端 `9000` 通过 `hdc fport tcp:9001 tcp:9000` 暴露到 PC 的 `9001`（USB）。
- ESP32 固件里写死网关 `10.127.130.179:9101`（PC WLAN IP 变了就全断）。
- 板端 `homemon` 客户端槽位 8 个，当前占 4（bridge×2、mirror×1、APP×1）。

---

## 3. 六条端到端数据流

### F1 · 传感 → 告警 → 云 → APP（主链路，有实测）

```
ESP32(5s) ──JSON行──> bridge:9101
                         │ ① 绑定 deviceId=esp32-kitchen
                         │ ② 判定/协议不变，直接转发
                         └─MQTT PUBLISH──> home/esp32-kitchen/status
                                              │
                    public-sync worker ───────┘ 订阅 home/+/status
                         │ 聚合/去重/限频（30s 稳定态）
                         └─HTTPS POST /internal/v1/device-status──> ECS 202
                                                                      │
                                                            后端持久化 + REST
                                                                      │
                                                    手机 APP GET /api/v1/devices
```

- 板端 homemon 同理：`status.json` → bridge 经 `--status-tcp` 读 → `home/dayu200-living/status`。
- 关键代码：`bridge/mqtt_bridge.js`（attachNode/publishStatus）、`cloud/onenet/cloud-sync.js`、`cloud/backend/src/server.js`。

### F2 · APP 下发命令 → 目标节点（目标路由）

```
APP ──"route esp32-bath ack alarm-1 已电话确认"──> homemon(9000)
     homemon 判断：目标不是本机 → 不执行，只把整行广播给所有 TCP 客户端
                                   │
                            bridge 从 relay socket 读到 "route ..."
                                   │ 白名单校验 deviceId / 禁止嵌套 route|relay / 清洗 CR-LF
                                   └──按 deviceId 找到该节点连接──> 原命令
```

- 板端本机命令：`deviceId` 等于本机 → homemon 直接执行（ACK 走严格匹配）。
- 安全边界：`deviceId` 正则 `[A-Za-z0-9._-]{1,64}`；未知/断开设备拒绝；同 ID 新连接原子替换旧连接。

### F3 · ACK 闭环（只有设备确认才算完成）

```
APP 点"确认闭环" → POST cmd(route ack ...) → ... → 节点执行
                                              │
                              节点状态转 ACKED，5s 内上报
                                              │
                       状态回流 MQTT/云 → APP 收到 ACKED → 显示闭环完成
```

- APP 侧记录 `pendingDeviceId + pendingAckId`，**8 秒未匹配则提示超时**。
- 节点侧要求「状态=ALARM + alarmId 精确匹配 + 未确认过」，否则拒绝并写日志。
- 因此"HTTP 202/请求成功"≠"已闭环"，这是本项目的一条硬语义。

### F4 · 视频会话（按需，空闲即断）

```
APP 点"视频探望" → 后端签票据 → WS 连 relay:9443
   relay(local) ──TCP hello/start──> DAYU VideoStreamServer:9301
                 <──JPEG 帧流──────
                 ──WS 帧──> APP 解码渲染
   无人观看 3s → 主动断开（省电/省带宽）
```

### F5 · 视觉跌倒（受限事件，不直接改状态）

```
DAYU 摄像头帧 → dayu_local_fall(9200)：YOLO11n-pose 关键点
                    │
                    └─ 规则状态机（直立→髋部骤降→低位水平持续 + track 隔离）
                              │ 满足才发"受限 fall 命令"
                              └─> homemon 统一生成 alarmId/声光/语音/ACK
```

- 设计原则：**视觉只提交事件，不生成告警 ID、不直接改状态**；误报只影响一条受限事件。

### F6 · 随身求助（4G 公网旁路）

```
4G 穿戴节点 → ECS(1883 wearable-mqtt) → 云端 API(api.luxunacc.xyz)
                                          │
                     PC wearable-mirror 轮询 API（2s/次）
                                          │ 转成 homemon 状态行
                                          └─relay 注入 9001 → 板载 APP 显示
```

- 注意：该设备**不走**本地 `home/*` MQTT（bridge 用 `--relay-ignore esp32-sos` 防止误接管）。
- 边界：依赖公网 API；实测出现过 10s `online=false` 抖动。

---

## 4. 状态机与在线判定

```
节点侧：NORMAL ──(阈值/事件)──> ALARM ──(ACK 精确匹配)──> ACKED
             ↑                                            │
             └────────────── reset/恢复 ──────────────────┘
```
- 本项目节点**没有 WARN 状态、没有 FALL 告警类型**（`fall` 是命令通道，生成的是受限事件）。
- 优先级（节点判定）：GAS > SMOKE > WATER_LEAK > CLIMATE > NO_MOTION（注意 `alarm_logic.h` 两处优先级函数需同改）。
- **在线判定**：APP/网关按"最近一次合法状态时间"计；**12 秒无新状态 → offline**（APP 每 3s 扫描快照）。
  板载 APP 的 `4/4` 数字是 UI 文本正则，不是链路探针。

---

## 5. 协议与数据格式

| 协议 | 位置 | 格式要点 |
|---|---|---|
| 设备行协议 | ESP32→bridge、homemon→bridge | 每行一个 JSON，`\n` 分帧；`deviceId` 是路由主键 |
| MQTT | bridge↔broker↔订阅端 | `home/<deviceId>/status`（上）/`cmd`（下）；QoS 0；无 retain |
| relay/route | bridge↔homemon | `relay <json>` 注入广播；`route <deviceId> <cmd>` 目标路由 |
| OneJSON | gateway→OneNET | `$sys/{pid}/{dev}/thing/property/post`、`/event/post`；下行 `property/set` |
| 内部 ingest | worker→backend | `POST /internal/v1/device-status` → `202`；`GET /internal/v1/commands` 拉命令 |
| APP API | APP→backend | `/api/v1/auth/app`、`/devices`、`/alerts`、`/ack`、`/stats`、`/health*` 等（见 `docs/APP-API-v1.md`） |
| 视频 | relay↔APP | WebSocket 二进制帧（JPEG），鉴权票据 + 限流 |
| 视觉事件 | 板端 jsonl → 后端 | `demo-events.jsonl` 逐行事件（frameTs/eventTs/personCount/trackId/fall） |

**时间语义**：
- 节点 `ts` 为 13 位毫秒；板端时钟一度回退到 2021 年，现已用 `southbound/dayu-time-sync.js` 校时；
- 上云时间戳优先用**网关接收时间**（避免设备钟不可信），设备采样时间保留在同一 payload 里。

**幂等键**：
- 告警：`(deviceId, alarmId)`；
- 门磁事件：`(deviceId, seq)`（seq 单调、NVS 持久化，重启不复用）；
- 状态：`deviceId` 覆盖式更新（最新覆盖，非事件流）。

---

## 6. 部署拓扑

```
家庭侧（演示 PC，Windows）                     公网（阿里云 ECS 47.76.70.118）
┌──────────────────────────────┐              ┌────────────────────────────┐
│ broker:1883                   │              │ Caddy:443 (TLS)            │
│ bridge:9101                   │──HTTPS 443──>│  └ backend(Node,容器网络)  │
│ public-sync worker/supervisor │              │ wearable-mqtt:1883         │
│ wearable-mirror:9002          │              │ video relay(agent,未启用)  │
│ video relay:9443              │              └────────────────────────────┘
│ hdc fport 9001→板 9000        │
└──────────────────────────────┘
   ▲ USB          ▲ Wi-Fi(AP ElderCareLab)
 DAYU200      ESP32×2 / 4G 穿戴 / 手机模拟器
```

- 家庭侧**只主动出站**访问 443；backend 只在容器网络监听，由 Caddy 反代。
- 单点：ECS 单 IP（443/1883/80 一机）、PC 单 broker/bridge、hdc fport、AP。

---

## 7. 关键设计决策（为什么这样做）

| 决策 | 理由 | 代价 |
|---|---|---|
| ESP32 不实现 MQTT，只发 TCP 行 JSON | 固件体积/复杂度/内存受限；桥接可复用 homemon 协议 | 必须有 PC 桥接 |
| 自建极简 broker 而非公网 EMQX | 现场网络封 1883、避免演示翻车 | 无 retain/QoS1/持久化 |
| 板端状态机统一管 alarmId/ACK | 告警 ID、声光、语音、安全日志都在一处 | homemon 成为单点 |
| 视觉只提交"受限事件" | 误报不污染告警语义；未来换 RKNN 不动上层 | 多一跳 |
| 网关用接收时间上云 | 设备钟不可信（曾回退 5.8 年） | 丢失原始采样时钟（另存字段） |
| ACK 必须设备确认 | HTTP 成功≠处置完成，避免假闭环 | 多一次状态回流与超时处理 |
| relay 注入 + relay-ignore | 板载 APP 能看无线节点，又不让 bridge 误接管 | 需要 deviceId 边界与去重 |
| 上云限频/去重 | 避免刷爆云端与多终端 | 实时性略降（稳定态 30s） |
| 一键启动 + 守护进程 | 现场演示需要"自愈 + 可诊断" | 多窗口、需人工输入 INGEST_KEY |

---

## 8. 故障域（排障时的第一判据）

| 故障域 | 影响面 | 观测点 |
|---|---|---|
| hdc fport（USB/板端） | APP 全屋停更、视频/镜像断 | `hdc fport ls`、bridge 9001 重连日志 |
| AP/ESP32 Wi-Fi（共因） | 厨房+卫生间同时停更 12–34s | 9101 连接、bridge 成对断开日志 |
| PC broker/bridge 进程 | 全部 MQTT 数据停 | `:1883/:9101` 端口 |
| public-sync（INGEST_KEY） | 云端停更，本地闭环不受影响 | supervisor 窗口、`state.json` 心跳 |
| ECS | 云侧/多终端/穿戴镜像不可用，本地闭环不受影响 | `/healthz`、443 连通性 |
| 视觉进程 | 跌倒不判定，其他告警正常 | `:9200`、events.jsonl 增速 |
| 视频 relay | 只影响视频探望 | `:9443/video/healthz` |

---

## 9. 扩展点

- **加房间节点**：复制 `firmware/<node>` 改 `sdkconfig.defaults`（deviceId/room/引脚）→ 桥接零改动（按 deviceId 路由）。
- **换云平台**：`cloud/onenet/adapter.js` 是 OneJSON 适配层，替换它即可（bridge/设备不动）。
- **换视觉后端**：`yolo_pose_service` 与 `fall_detector` 分离，可替换 RKNN 适配器。
- **加告警类型**：`alarm_logic.h` 判定 + 优先级两处 + 语音片段 + APP 映射。
- **多终端推送**：`cloud/backend/src/notify-*.js` 已有多渠道投递骨架。
