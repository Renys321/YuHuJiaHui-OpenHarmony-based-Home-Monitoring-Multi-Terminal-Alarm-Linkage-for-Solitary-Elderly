# 随身 SOS 链路现状核实与验收准备报告（无 USB / 4G / 公网 ECS / 生产后端 / APP）

- **执行时间**：2026-10-27 22:20–22:55（Asia/Shanghai）；其中 22:52 完成本轮真实验收
- **执行者**：teammate `sos-m100`（只读核实/取证；未注入 SOS、未代替用户 ACK、未烧录、未拔线、未重启任何服务）
- **范围**：ESP32-S3 随身 SOS → YED-M100MG-B1 4G/MQTT → 公网 ECS `47.76.70.118:1883`（wearable-mqtt）→ 生产后端 `https://api.luxunacc.xyz` → 监护人 APP
- **一句话结论**：**本轮"拔 USB + 用户实体按键 SOS + APP ACK"验收已 PASS**：真实新告警 `sos-7-b941b638` 于 **22:52:32.478** 创建，云端 **22:52:33.163** 看到（+0.69s），APP 于 **22:52:59.268** 确认（创建→ACK **26.79s**），state=ACKED、`acknowledgedBy=household-guardian`，随后设备回到 NORMAL 且心跳继续（`PASS_ALARM_AND_ACKED_SEEN`）。核实期间另见 22:06:44 的 `sos-6`（已 ACKED），按"未核实历史按键"处理，不计入本轮。

## 1. 结论速览

| 检查项 | 结果 | 依据 |
|---|---|---|
| **本轮真实验收 `sos-7-b941b638`** | ✅ **PASS**：22:52:32.478 创建 → 22:52:33.163 云端可见（+0.69s）→ 22:52:59.268 APP ACKED（26.79s）→ 设备回 NORMAL | §3.7、`capture/*-acceptance-capture.{md,json,jsonl}` |
| 生产后端 `/healthz`、`/api/v1/devices`、`/api/v1/alerts` | ✅ 200 | `snapshots/*-r1..r8.json` |
| `esp32-sos` 云端在线/新鲜度 | ✅ 心跳 29–30s 周期；除 22:36:05–22:48:46 的独立供电切换窗口外持续前进 | §3.1、§3.7、`logs/alert-watch-*.jsonl` |
| 上行链路 ESP32→M100→ECS MQTT→适配器→后端 | ✅ 在线（`sos-7` 创建后 0.69s 即入库） | §3.7、`src/adapter.js` hb→device-status |
| ECS 公网 MQTT Broker | ✅ 在线（TCP 可达；CONNECT 返回 CONNACK 0x05，用户名/密码通过、唯一 clientId 被白名单拒绝） | §3.2、`logs/*mqtt-1883.json` |
| 下行 ACK 链路 | ✅ 本轮实测 APP ACK → 后端 ACKED（26.79s）；适配器**只在设备真实回执后**才回写 ACKED，绝不代报 | §3.7、`cloud/wearable-mqtt/README.md` §4.2 |
| "拔掉 USB"前提 | ✅ 全程无 COM8（SOS ESP32 不接电脑 USB）；M100 仅 DC 供电；SOS 独立供电切换后恢复 | §3.4、§3.7 |
| 监护人 APP | ✅ 模拟器 `127.0.0.1:5555` 在线；`com.example.program_04` 进程在跑；Lead 在 APP 完成确认 | §3.5、§3.7 |
| 技术阻塞 | **无**（本轮验收已完成；唯一过程事件是独立供电切换导致 ~12.7min 掉线，恢复后一次按键即通过） | §4 |
| 背景事件 `sos-6-49732005` | 🟡 22:06:44 创建、22:07:09 ACKED；**非本会话产生**，按"未核实历史按键"处理，不计入本轮 | §3.6 |

## 2. 方法与只读边界

只读手段（全部在本目录 `tools/` 下，可复跑）：

| 工具 | 行为 | 副作用 |
|---|---|---|
| `prod-probe.js` | 用监护人凭据登录 → `GET /api/v1/devices`、`GET /api/v1/alerts`，落脱敏快照 | 无（只读 GET；快照不含 token/凭据） |
| `alert-watch.js` | 每 10s 只读轮询设备状态与最新告警，追加 JSONL | 无 |
| `mqtt-probe.js` | TCP 探测 + **一次** MQTT 3.1.1 CONNECT（唯一 clientId 后缀 + 正确账号密码），收 CONNACK 后 DISCONNECT | 不 PUBLISH、不 SUBSCRIBE、不用设备 clientId、不接管设备连接 |
| `serial-passive.js` | 被动读 COM11（dtr/rts 关闭；115200/9600/38400/57600 各 4s） | 不发送任何字节 |
| `acceptance-capture.js` | 验收窗口自动取证：每 5s 只读轮询，自动识别"基线之外的新 alarmId"，记录 告警出现→ACKED 时间线并输出 jsonl/json/md | 无（只读 GET；不发布 MQTT、不 ACK） |

未做的事（边界声明）：未向 `eldercare/wearable/sos-001/up|down` 发布任何消息；未调用 `POST /api/v1/alerts/{id}/ack`；未修改后端数据；未重启 broker/bridge/public-sync/wearable-mqtt；未烧录/插拔设备；未以设备 clientId 连接（会顶掉在线 M100）；证据与日志中不含凭据、Token、SIM 信息。

## 3. 现状实测

### 3.1 生产后端：`esp32-sos` 在线且心跳新鲜

多次独立探针（r1–r8，间隔均 ≥30s，且穿插 10s/5s 连续监视）：

| 序号 | 探测时刻（+08） | `online` / `state` | `lastSeenTs` | 采样时 age | 文件 |
|---|---|---|---|---|---|
| 基线（brief 引用） | 22:01:49 | true / NORMAL | 1793097478795 = **18:37:58** | ≈3.4h（陈旧） | `tmp/prod-devices-2200.json`（只读引用） |
| r1 | 22:22:07 | true / NORMAL | 22:22:05.701 | 2s | `snapshots/…-r1-2221.json` |
| r2 | 22:24:20 | true / NORMAL | 22:24:05.592 | 15s | `snapshots/…-r2-2225.json` |
| r3 | 22:25:19 | true / NORMAL | 22:25:05.713 | 14s | `snapshots/…-r3-2227.json` |
| r4 | 22:26:26 | true / NORMAL | 22:26:05.704 | 21s | `snapshots/…-r4-2228.json` |
| r5 | 22:32:29 | true / NORMAL | 22:32:05.683 | 24s | `snapshots/…-r5-2233.json` |
| r6 | 22:41:43 | true / NORMAL | 22:36:05.583 | **338s（掉线中）** | `snapshots/…-r6-linkcheck.json` |
| r7 | 22:53:09 | true / **ACKED** | 22:52:59.281 | 10s | `snapshots/…-r7-sos7-ack.json` |
| r8 | 22:54:06 | true / **NORMAL** | 22:53:47.047 | 20s | `snapshots/…-r8-sos7-normal.json` |
| 连续监视 | 22:26:47→22:41:46 | true / NORMAL | 22:26:35 → 22:27:05 → 22:27:35 …（每 30s +30s） | 0–30s | `logs/alert-watch-20261027-2226.jsonl` |
| 验收 capture | 22:36:04→22:53:01 | true，期间 22:36–22:48 掉线 | 22:35:35（start）→ 22:36:05 停 → 22:48:46 恢复 → 22:49:47/22:50:17… | — | `capture/…-acceptance-capture.jsonl` |

结论与判据：
1. 设备在 22:01:49（lastSeen=18:37:58，已陈旧 3.4h）之后、22:06:44 之前第一次重新上线；22:22–22:35 心跳 30s 稳定。
2. **22:36:05–22:48:46 存在一次 ~12.7min 的掉线窗口**（r6 实测 age=338s），时间点与"用户把 SOS ESP32 从 USB 供电切到独立供电"吻合；Lead 22:48 确认独立供电恢复，22:48:46 心跳恢复、29–30s 周期稳定，之后才进行本轮按键。掉线窗口内的按键会延迟到恢复后补发（本轮按键发生在恢复后，不受影响）。
3. 适配器逻辑：只有真实上行 `hb` 才更新 `lastSeen` 并 `POST /internal/v1/device-status`（`cloud/wearable-mqtt/src/adapter.js` L436-477），后端再把 `lastSeenTs` 暴露给 `/api/v1/devices`。因此 **lastSeen 前进 ⇔ M100 4G→ECS MQTT→适配器→后端 的完整上行链路在工作**；反过来，`online=true` 不会因断链自动翻 false，判断在线必须看 `lastSeenTs` 的 age。
4. `sensors={}`、`csq=null` 属该设备预期（SOS 节点无传感器；固件心跳未带 `csq` 字段），不是故障。

### 3.2 ECS 公网 MQTT（47.76.70.118:1883）

| 检查 | 结果 |
|---|---|
| TCP 三次连接 | ✅ 1111.9ms（冷连接）/ 105ms / 94.1ms |
| MQTT CONNECT（唯一 clientId 后缀 + 正确用户名/密码） | CONNACK `0x05 NOT_AUTHORIZED`（≈298ms） |
| 解读 | Broker 有 **Client ID 白名单**（仅设备 ID）。`0x05` 说明：① Broker 在线并正常回 CONNACK；② 用户名/密码**通过**（若凭据错应为 `0x04 BAD_CREDENTIALS`）；③ 唯一 clientId 被白名单拒绝，属预期防护。**未使用设备 clientId，因此没有顶掉在线 M100** |
| 设备在线旁证 | 探测前后心跳仍按 30s 前进（§3.1），无接管/掉线 |
| 适配器 `/status`（8099） | 公网不可达（仅 ECS 回环监听；Lead 侧 22:27 探针 4s timeout 亦确认），故"Broker 活跃 client 列表"无公网外部证据，只能以上行心跳间接证明 |

证据：`logs/2026-10-27T14-24-22-922Z-mqtt-1883.json`。

### 3.3 COM11 被动只读读取

| 波特率 | 打开 | 收到字节 | 内容 |
|---|---|---|---|
| 115200 | ✅ | 1 B | `0xFE`（帧噪声，非可读文本） |
| 9600 / 38400 / 57600 | ✅ | 0 | 空 |

- 未发送任何字节；DTR/RTS 均关闭，避免误触发复位。
- 结论：**无法据此确认 COM11 是 YED M100 配置口**；也没有 M100 的 AT/网络日志。这与"被动口本来就只在收到命令时才回包"一致，不构成故障判断依据。
- 设备当前经 4G 在线，COM11 是否接 M100 对本轮验收不影响（最终形态本就不插 M100 底板 USB）。

证据：`logs/…-serial-passive-COM11.json`。

### 3.4 PC 串口 / USB 现场状态

| 项 | 实测 | 含义 |
|---|---|---|
| COM8 | **始终不存在**（PnP 中 CH343 状态 Unknown=未连接） | SOS ESP32 全程不接电脑 USB 数据线 |
| COM4 / COM5 | 22:23 存在（CH340，按 brief 为浴室/厨房节点）；22:46 复查已不在（其他任务/用户在拔 USB，非本会话操作） | 与随身 SOS 无关，未触碰 |
| M100 底板 CH340 配置口 | 历史为 CH340（当时 COM15）；全程 PnP 无对应在用 CH340 | M100 底板 USB 数据线**未连接**，符合"最终只接 DC"接线要求 |
| COM11（FTDI） | 可打开、被动读为空；22:23 之后仍在 | 见 §3.3 |

结论：**"拔掉 USB 后"的物理前提全程成立**（SOS ESP32 与 M100 都没有接入电脑 USB 数据线）。过程事件：22:36–22:48 为 SOS ESP32 **供电切换窗口**（接入独立供电；切换前供电来源无法远程确认，但全程无 COM8 数据连接），云端心跳中断 ~12.7min，22:48:46 恢复；此后至验收结束始终无 COM8、心跳稳定。

### 3.5 监护人 APP 可用性

| 检查 | 结果 |
|---|---|
| `hdc list targets` | `127.0.0.1:5555` 在线（22:23 实测） |
| `hdc -t 127.0.0.1:5555 shell pidof com.example.program_04` | `29093`（22:23 时 APP 进程在跑；之后 Lead 做过 APP 重启，pid 会变，以实际为准） |

APP 具体版本/界面与"APP 显示/ACK 截图"由 APP owner 的证据为准；本报告只证明 APP 运行环境在线、可用于 ACK 动作。

### 3.6 重要发现：`sos-6-49732005`（已 ACKED，来源待确认）

| 字段 | 值 |
|---|---|
| alarmId | `sos-6-49732005` |
| deviceId / type | `esp32-sos` / `MANUAL_SOS` |
| state | `ACKED`（`ackPending=false`） |
| createdAt | **22:06:44.756** |
| acknowledgedAt | **22:07:09.191**（创建后 ≈24.4s） |
| acknowledgedBy | `household-guardian`（监护人 APP 账号） |
| sosLocation | 无该字段（当时可能无 GPS fix；不影响 SOS/ACK） |
| 是否本会话产生 | **否**。本会话没有发布 MQTT、没有 ACK、没有改后端；22:00 的 `tmp/prod-devices-2200.json` 中还没有这条 |
| 设备状态 | `state=NORMAL`（事件闭环） |

推断：设备在 22:01:49–22:06:44 之间重新上线，随后出现这次 MANUAL_SOS + ACK。它**可能是用户当时的真实实体按键 + APP 确认**，也可能是其他子代理/历史测试注入——云端 API 无法区分消息来源，只能用现场信息确认。
**Lead 决策（22:36）：在用户确认前，`sos-6` 一律按"未核实的历史按键"处理，不作为本轮验收通过证据。** 本报告据此执行：本轮通过证据只用 §3.7 的 `sos-7`。

另：`esp32-sos` 的历史告警中还有 `e-1793022476-1`（21:49:36 创建）、`e-1793076169-1`（12:42:51 创建）两条仍为 `ALARM`、`acknowledgedAt=0` 的旧测试遗留数据，与本次无关，不应计入本轮验收。22:31 前后全库告警总数 80→81 的增量来自其他设备（`esp32-sos` 无新增），与随身 SOS 链路无关。

### 3.7 本轮真实验收实测：`sos-7-b941b638`（PASS）

**现场动作（用户/Lead 执行，AI 只读取证）**：独立供电恢复（22:48:46 心跳恢复）→ 用户短按一次 SOS 实体键 → Lead 在 APP 模拟器上只确认这一条新告警。

| 字段 | 值（后端原文） |
|---|---|
| alarmId | **`sos-7-b941b638`** |
| deviceId / type | `esp32-sos` / `MANUAL_SOS` |
| state | **`ACKED`**（`ackPending=false`） |
| createdAt | **`1793112752478` → 2026-10-27 22:52:32.478 +08** |
| acknowledgedAt | **`1793112779268` → 2026-10-27 22:52:59.268 +08** |
| acknowledgedBy | **`household-guardian`** |
| 设备状态 | 22:53:09 `state=ACKED, lastSeenTs=1793112779281`；22:54:06 回到 `state=NORMAL, lastSeenTs=1793112827047`（心跳继续） |
| 告警总数变化 | 84 → 85（仅 +1，`sos-7` 只有一条，无重复） |

**自动取证时间线（`acceptance-capture.js`，5s 轮询，基线=sos-6）**：

| 时刻（+08） | 事件 | 说明 |
|---|---|---|
| 22:36:04 | capture 启动 | 基线最新=`sos-6`，SOS 告警数 8 |
| 22:36:05–22:48:46 | 掉线窗口 | 独立供电切换；capture 记录 `lastSeenTs` 冻结、最大间隔 760,358ms |
| 22:48:46 | 链路恢复 | 心跳恢复（Lead 来源），此后 29–30s/次 |
| **22:52:32.478** | **新 MANUAL_SOS 创建** | 用户实体按键 |
| **22:52:33.163** | **云端首次可见** | 创建后 **+0.69s** → 上行 ESP32→M100→ECS→适配器→后端 正常 |
| **22:52:59.268** | **APP ACK 回写** | 创建→ACK = **26,790 ms**；`acknowledgedBy=household-guardian` |
| 22:53:01.151 | capture 看到 ACKED | ACK 后 +1.88s（5s 轮询内） |
| 22:53:09 / 22:54:06 | 快照 r7 / r8 | r7 state=ACKED；r8 state=NORMAL，无新增重复告警 |

**判定：`PASS_ALARM_AND_ACKED_SEEN`**。理由：
1. 告警是**新 alarmId**（基线 `sos-6` 之外），且创建时刻在用户按键之后，来源为设备真实上行（适配器只转发真实上行帧，没有我方注入）；
2. 创建→云端可见 **0.69s**，说明 4G/MQTT/适配器/后端全链路在线；
3. APP ACK 后 **26.79s** 变 ACKED；按适配器契约，**ACKED 只能由设备真实 `t:"ack"` 回执触发**（绝不代报），因此这同时证明"APP→后端→MQTT→M100→UART→ESP32"下行链路工作；
4. 全程无 COM8（SOS ESP32 未接电脑 USB），符合"拔 USB 后"条件；
5. 无重复告警（85 = 84+1），设备回 NORMAL 后心跳继续。

> 仍需现场口述佐证的两点（AI 无法从云端观测）：按键后蜂鸣器是否 3 短声、ACK 后蜂鸣是否停响。建议 Lead 向用户确认一句即可闭环。

## 4. 阻塞与最小用户操作（交付物 2）

### 4.1 当前阻塞判断（22:55）

- **本轮验收已 PASS，无阻塞**（§3.7）。
- 过程上唯一异常是独立供电切换造成的 22:36:05–22:48:46 掉线窗口：这段**不支持按键验收**（按键会延迟到恢复后补发），恢复后 29–30s 心跳稳定才按键，本轮未受影响。

### 4.2 本轮实际最小用户操作（已执行）

| # | 用户动作 | 实际结果 |
|---|---|---|
| 1 | 把 SOS ESP32 切到独立供电（充电宝），保持电脑无 USB 数据连接 | 22:36:05–22:48:46 掉线；22:48:46 心跳恢复（Lead 确认） |
| 2 | 确认 M100 DC 供电与 4G 天线 | M100 侧正常（恢复后 29–30s 心跳） |
| 3 | **短按实体 SOS 按钮 1 次** | 22:52:32.478 生成 `sos-7-b941b638`（新 alarmId） |
| 4 | **APP 点确认（只确认这一条）** | 22:52:59.268 ACKED，`acknowledgedBy=household-guardian` |
| 5 | 口述蜂鸣器（3 短声 / ACK 后停响） | ⏳ 待 Lead 向用户确认一句（云端无法观测） |

不需要：重启任何服务、烧录、重新配网、插任何数据线。注意**不要连按**：本轮只新增 1 条告警（84→85），若连按会出现多条不同 alarmId。

### 4.3 若需重做或出现异常

- 掉线（`lastSeen` >90s 不动）：先恢复供电/4G 天线，等 30–60s 心跳恢复后再按键；**不要在掉线窗口内按键**（会延迟补发，时间线不干净）。
- 按了按钮但 120s 无告警：检查按钮接线（GPIO4↔GND）、ESP32 供电/UART 接线；不要狂按。
- APP 见到告警但 ACK 后 >60s 仍"等待设备确认"：属下行未达（适配器会 5min 慢速重投）；**不要伪造 ACKED**，需 Lead 批准后由人在 ECS 重启 `wearable-mqtt`（本脚本边界外）。

## 5. 验收执行计划与执行结果

见同目录 **`ACCEPTANCE-PLAN.md`**：T0 门禁 → T1 用户按键 → T2 后端出现 MANUAL_SOS → T3 APP 显示 → T4 APP ACK → T5 固化的检查点、只读命令、PASS 判定条件与故障分支。

实际执行路径：
1. **T0（22:36–22:48）**：capture 启动时门禁通过（online=true/NORMAL，心跳 30s）；随后遇到独立供电切换的掉线窗口（22:36:05–22:48:46），按预案**先不按键**，确认恢复后（22:48:46 心跳恢复、29–30s 连续前进）再进入按键环节。
2. **T1–T2（22:52:32）**：用户短按一次 → 新告警 `sos-7-b941b638` 创建；capture 22:52:33.163 首次看到（+0.69s）。
3. **T3–T4（22:52:59）**：Lead 在 APP 只确认这一条 → `acknowledgedAt=1793112779268`（创建→ACK 26.79s），`acknowledgedBy=household-guardian`。
4. **T5（22:53–22:54）**：capture 按设计在 ACKED 后结束（171 次采样，verdict=`PASS_ALARM_AND_ACKED_SEEN`）；快照 r7/r8 复核 ACKED→NORMAL、无重复告警。

如需重做：在按键前重新启动 `node tools\acceptance-capture.js capture 1200 5` 即可（只读）。

## 6. 证据文件索引

| 文件 | 内容 |
|---|---|
| `snapshots/2026-10-27T14-22-07-334Z-r1-2221.json` | r1 设备+告警快照（22:22:07） |
| `snapshots/2026-10-27T14-24-20-617Z-r2-2225.json` | r2 快照（22:24:20） |
| `snapshots/2026-10-27T14-25-19-903Z-r3-2227.json` | r3 快照（22:25:19） |
| `snapshots/2026-10-27T14-26-26-676Z-r4-2228.json` | r4 快照（22:26:26） |
| `snapshots/2026-10-27T14-32-29-381Z-r5-2233.json` | r5 快照（22:32:29） |
| `snapshots/2026-10-27T14-41-43-084Z-r6-linkcheck.json` | r6 掉线确认快照（22:41:43，age=338s） |
| `snapshots/2026-10-27T14-53-09-378Z-r7-sos7-ack.json` | r7 ACKED 快照（22:53:09，`sos-7` 原文） |
| `snapshots/2026-10-27T14-54-06-622Z-r8-sos7-normal.json` | r8 复盘快照（22:54:06，state=NORMAL、无重复） |
| `capture/2026-10-27T14-36-01-822Z-acceptance-capture.md` | **本轮验收摘要（PASS_ALARM_AND_ACKED_SEEN，含 sos-7 时间线）** |
| `capture/2026-10-27T14-36-01-822Z-acceptance-capture.json` | 验收取证 start+summary（机器可读） |
| `capture/2026-10-27T14-36-01-822Z-acceptance-capture.jsonl` | 验收窗口 171 次 5s 采样原始时间线（含掉线窗口 760,358ms 最大间隔） |
| `logs/2026-10-27T14-24-22-922Z-mqtt-1883.json` | ECS 1883 TCP+CONNECT 探针结果 |
| `logs/2026-10-27T14-24-46-343Z-serial-passive-COM11.json` | COM11 多波特率只读结果 |
| `logs/alert-watch-20261027-2226.jsonl` | 10s 连续只读监视（设备/最新告警时间线） |
| `tools/prod-probe.js` / `tools/alert-watch.js` / `tools/mqtt-probe.js` / `tools/serial-passive.js` / `tools/acceptance-capture.js` | 可复跑的只读探针/取证脚本（代码中不含凭据值，只含 `.secrets` 路径） |
| `ACCEPTANCE-PLAN.md` / `REPORT.md` | 验收计划 / 本报告 |

> 本目录所有文件经扫描：不含密码/Token/SIM 等凭据值（脚本仅含 `.secrets` 文件路径变量名）。

## 7. 未决问题与风险（如实列出）

1. **蜂鸣器现场现象待用户口述**：云端能证明告警/ACK/设备回执，但"按键后 3 短声、ACK 后停响"只能由现场确认（建议 Lead 补一句）。
2. **独立供电切换稳定性**：本轮 22:36:05–22:48:46 掉线 ~12.7min 是供电切换造成，恢复后 29–30s 心跳稳定；但"充电宝长时间供电 + 4G 长稳（>1h）"仍未做长稳测试。
3. 设备 `csq` 未上报、`sensors` 为空属预期，但意味着**无法从云端读取 4G 信号质量**；4G 健康度只能靠心跳连续性判断。
4. `sos-6-49732005`（22:06:44）仍属"未核实历史按键"，按 Lead 决策**不作为本轮证据**；若日后用户确认是本人操作，可另作背景记录。
5. ECS 适配器 `/status`（127.0.0.1:8099）公网不可达，"Broker 活跃 client 列表"没有外部直读证据，只能用设备心跳/事件时效间接证明。
6. 历史证据 `competition/evidence/2026-10-27-wearable-4g-gps-map/M100-CONFIG.md` 第 77 行含**明文 MQTT 密码**，建议 Lead 安排脱敏（本轮未改动他人证据文件）。

## 8. 建议下一步

- **验收结论可直接采用 §3.7 与 `capture/*-acceptance-capture.md`**（`sos-7-b941b638`：创建 22:52:32.478 → 云端 +0.69s → ACK 22:52:59.268 → ACKED → 设备回 NORMAL）；`sos-6` 不作为本轮证据。
- 请 Lead 向用户补确认"蜂鸣器 3 短声 / ACK 后停响"一句，并说明"按键时电脑 USB 未连接"（当时 `Get-PnpDevice` 无 COM8，`capture` 全程无 USB 依赖），即可闭环全部人工佐证。
- 若后续还要再演示：先确认 `lastSeen` 在 30s 前进、再启动 `acceptance-capture.js`、然后让用户按一次；**不要在掉线窗口内按键**。
- 本会话只读边界已遵守：未注入、未代 ACK、未发布 MQTT、未重启服务、未烧录、未拔线、证据无凭据。
