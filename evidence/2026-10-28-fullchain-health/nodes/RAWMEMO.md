# 节点层体检 · 原始证据（RAWMEMO）

- 体检窗口：**2026-10-28 01:41:10 – 01:48:00 CST**（对应 UTC `2026-10-27T17:41:10Z – 17:48:00Z`）
- 体检人：teammate `node-layer`（共享任务 `task-1`）
- 时间口径说明：**bridge / broker 日志时间戳为 UTC（带 `Z`），本地 CST = UTC + 8h**；本文两个时间都标，避免混淆。
- 只读声明（严格遵守）：
  - 未重启/停止任何进程；未 publish 任何 MQTT 报文（仅 CONNECT + SUBSCRIBE）；未写任何 control 文件；
  - 未 `hdc shell` 改动板端状态、未烧录、未运行 `node --test`；
  - 对 ESP32 IP 的 TCP 探测为「连即断」，且实测被 RST 拒绝（未建立连接、未发送业务报文）。
- 本目录下的原始采集件：
  - `mqtt-sub-home.log` —— 85s `mqtt_tool.js sub home/#` 原始输出（01:42:08.002 → 01:43:33.135）
  - `mqtt-tsprobe.log` —— 65s 自带到达时刻的只读订阅探针输出（01:46:23.246 → 01:47:28.245）
  - `_probe_mqtt_ts.js` —— 上述探针脚本（仅 CONNECT/SUBSCRIBE，绝不 PUBLISH）

---

## 0. 时间基准（主机 vs 板端）

```
主机：2026-10-28 01:44:47.806
板端：hdc -t 4501... shell date
      Wed Oct 28 01:44:47 CST 2026
```

→ 主机与板端时钟一致（偏差 < 1s），因此 3 个网络节点的报文 `ts` 与主机到达时刻可直接对算。

---

## 1. 核实 supervisor 的 `nodes=4/4` 到底是哪 4 个 deviceId

### 1.1 `nodes` 的代码来源（不是 MQTT、不是 bridge 自检）

`<WORKSPACE>\competition\materials\demo-autostart\demo-autostart.ps1`

```powershell
# 273-275：从 APP 的 uitest dumpLayout 文本里正则抠
$nodes = ''
$m = [regex]::Match($joined, '\u5168\u5c4b\u5728\u7ebf\s*(\d+)/(\d+)\s*\u53f0\u8bbe\u5907')   # 全屋在线 N/M 台设备
if ($m.Success) { $nodes = "$($m.Groups[1].Value)/$($m.Groups[2].Value)" }

# 553-561：每 30s 重新 dump 一次 UI；dump 失败或取不到就沿用上一次（$script:lastUi）
if ($ui -and $ui.Nodes) { $nodes = $ui.Nodes }
if (($now - $script:lastNodesAt).TotalSeconds -ge 30) {
  $script:lastNodesAt = $now
  $uiNow = Get-AppUi
  if ($uiNow -and $uiNow.Nodes) { $nodes = $uiNow.Nodes }
}
```

**结论：`nodes=4/4` 是「从 DAYU200 板端 APP 的 UI 文本里抠出来的显示值」，刷新周期 30s，且失败时沿用旧值。它不是 MQTT 在线统计，也不是 bridge 的连接统计。**

### 1.2 APP UI 原文（`evidence\2026-10-26-demo-autostart\runtime\ui-last.json`）

01:44:25 与 01:46:46 两次 dump 的 `text` 字段：

```
居家安全监护
随身求助 · 已选设备在线 · esp32-sos
随身求助 · 全屋在线 4/4 台设备
客厅
厨房
随身求助
卫生间
设备信息 / 房间 / 编号 / 随身求助 / esp32-sos
在线状态 / 在线（本地 TCP 已连接）
数据来源 / 随身 SOS 镜像（api）
最近上报 / 刚刚
APP 版本 / 1.0.8 · 2026-10-27 随身求助横幅可收起/关闭
```

→ 4 台 = **客厅（dayu200-living）、厨房（esp32-kitchen）、卫生间（esp32-bath）、随身求助（esp32-sos）**。

### 1.3 bridge 日志里出现过的 deviceId 全集（grep 去重）

```
dayu200-living
esp32-bath
esp32-kitchen
esp32-sos
```

**恰好 4 个，与 APP 的 4 台一一对应。** 也就是说 4/4 的口径里 **确实包含 esp32-sos**。

### 1.4 supervisor / watcher 当前快照

`bridge\_test\current-runtime\supervisor\status.json`（01:46:36，注意这是 bridge 每次 publish 覆盖写的「最后一台设备」原始状态行，不是聚合状态）：

```json
{"deviceId":"esp32-kitchen","room":"厨房","ts":1793123196489,"state":"NORMAL",...}
```

`evidence\2026-10-26-demo-autostart\runtime\watcher-state.json`（01:47:00）：

```json
{"timestamp":"2026-10-28 01:47:00","target":"...eca00","targetConnected":true,
 "p0":"healthy","app":"present","inference":"running","cameraFrames":"LIVE","nodes":"4/4",...}
```

---

## 2. bridge 日志：节点接入 / 断开 / 重连（`bridge.out.log`）

文件：`<WORKSPACE>\competition\bridge\_test\current-runtime\supervisor\bridge.out.log`
（UTF-8；控制台按 GBK 显示会乱码，以下为按 UTF-8 重读的原文）

### 2.1 启动与首次绑定（17:01:12Z = 01:01:12 CST）

```
[2026-10-27T17:01:12.019Z] [bridge] 单实例锁已获取：...\bridge.lock
[2026-10-27T17:01:12.033Z] [bridge] 已接入节点 127.0.0.1:9001
[2026-10-27T17:01:12.034Z] [bridge] 已连接转发目标 127.0.0.1:9001
[2026-10-27T17:01:12.036Z] [MQTT] 已连接 127.0.0.1:1883（clientId=bridge-dayu200-living-72020）
[2026-10-27T17:01:12.836Z] [bridge] 忽略未识别的探测连接（::ffff:127.0.0.1:61808，未发送状态行；不计为节点接入）
[2026-10-27T17:01:13.253Z] [bridge] 无线节点接入并完成身份绑定：esp32-bath（来源 ::ffff:10.127.130.71:61793）
[2026-10-27T17:01:13.309Z] [bridge] 无线节点接入并完成身份绑定：esp32-kitchen（来源 ::ffff:10.127.130.168:62780）
```

### 2.2 唯一的断连事件（17:43:48Z = **01:43:48 CST**）

```
[2026-10-27T17:43:48.231Z] [bridge] 无线节点 esp32-bath 断开
[2026-10-27T17:43:48.945Z] [bridge] 无线节点 esp32-kitchen 断开
[2026-10-27T17:44:00.687Z] [bridge] 无线节点接入并完成身份绑定：esp32-kitchen（来源 ::ffff:10.127.130.168:59409）
[2026-10-27T17:44:01.893Z] [bridge] 无线节点接入并完成身份绑定：esp32-bath（来源 ::ffff:10.127.130.71:50040）
```

注意重连后**源端口变化**：kitchen `62780 → 59409`、bath `61793 → 50040`，证明是两条全新 TCP 连接，不是原连接恢复。

### 2.3 全生命周期计数（`Select-String` 统计，截至 01:47）

| 短语 | 次数 | 含义 |
|---|---|---|
| `已接入节点 127.0.0.1:9001` | 1 | 板端 status-tcp 端点只接入过 1 次 |
| `节点 127.0.0.1:9001 ... 错误` | **0** | 板端端点 46 分钟零错误 |
| `无线节点接入并完成身份绑定` | 4 | 2 次首次 + 2 次重连 |
| `无线节点 ... 断开` | **2** | 仅 01:43:48 那一次（两节点同时） |
| `毫秒后重连` | 0 | 配置端点从未触发退避重连 |
| `MQTT 重连` / `连接已退休` / `拒绝节点` | 0 / 0 / 0 | — |
| `忽略未识别的探测连接` | 42 | 健康探针（2s 一次）被正确排除，**不计为节点** |
| `忽略板端连接上的 relay 回灌` | 500 | 板端把本机注入的 kitchen/bath 回灌，bridge 防重复 |
| `忽略板端连接上的 --relay-ignore` | 398 | esp32-sos 回灌，按设计只丢弃 |

---

## 3. 每节点上报节奏（按 bridge 发布时刻统计，剔除断连影响）

窗口：17:01:13Z 起至 17:46:20Z（约 45 分钟）。

| deviceId | 发布条数 | 首条 | 最后一条 | 距最后一条 | 间隔均值 | 中位 | p95 | 正常最大 | 标准差 |
|---|---|---|---|---|---|---|---|---|---|
| esp32-kitchen | 491 | 17:01:13Z | 17:46:19Z | 3.3s | 5.52s | 5.50s | 5.73s | 6.4s | 0.28s |
| esp32-bath | 491 | 17:01:13Z | 17:46:20Z | 3.2s | 5.52s | 5.50s | 5.71s | 6.6s | 0.28s |
| dayu200-living | 898 | 17:01:15Z | 17:46:20Z | 2.4s | 3.02s | 3.01s | 3.04s | 4.3s | 0.05s |

前三大间隔（即唯一异常）：

```
esp32-bath    33.8s  17:43:28 -> 17:44:01     （断连造成）
esp32-kitchen 31.8s  17:43:28 -> 17:44:00     （断连造成）
其余最大 6.6s / 6.4s / 4.3s —— 均为正常抖动
```

→ 除 01:43:28–01:44:01 这一次外，三节点的上报节拍非常稳；dayu200-living 尤其稳（σ=0.05s）。

---

## 4. 断连事件时间线（节点层唯一真实抖动）

```
01:43:28 CST  厨房/卫生间最后一次上报成功（数据面中断起点；此时本机只在读日志，无网络探测）
01:43:48.231Z(=01:43:48.231 CST)  bridge 记 esp32-bath 断开
01:43:48.945                     bridge 记 esp32-kitchen 断开
01:43:48.9xx ~ 01:44:00.6xx      两节点均不在线；bridge 里 kitchen/bath 无状态发布
01:44:00.687                     esp32-kitchen 重连并重新完成身份绑定（源 59409）
01:44:01.893                     esp32-bath   重连并重新完成身份绑定（源 50040）
01:44:01 起                      两节点状态恢复流动（首条 17:44:00.687 / 17:44:01.893 之后）
```

量化：

| 指标 | esp32-kitchen | esp32-bath |
|---|---|---|
| TCP 断开 → 重新绑定 | **11.742s** | **13.662s** |
| 数据面空档（最后一条→下一条） | **31.8s** | **33.8s** |
| 是否自愈 | 是，无需人工 | 是，无需人工 |
| 断连前后源端口 | 62780→59409 | 61793→50040 |

**关键判断：两节点在 0.7s 内同时掉、又在 12–14s 内各自重连 → 共同原因（同一 Wi-Fi/AP 或 ESP32 侧射频/复位），不是单节点故障。**

CPU 侧旁证（`netstat -ano`，PID 46720 即 bridge）：

```
TCP  0.0.0.0:9101        0.0.0.0:0            LISTENING    46720
TCP  10.127.130.179:9101 10.127.130.71:50040   ESTABLISHED  46720
TCP  10.127.130.179:9101 10.127.130.168:59409  ESTABLISHED  46720
TCP  127.0.0.1:<多个>    127.0.0.1:9101        TIME_WAIT    0   ← 健康探针，非节点
```

（本机 10.127.130.179 是监听方；两台 ESP32 是客户端。）

### 4.1 关于「本次体检的探测是否诱发了这次断连」

- 数据面中断起点 **01:43:28**，当时本机只在执行 `Get-Content` 读日志（无任何网络动作）；
- 本机对 ESP32 IP 的 TCP connect 探测发生在 **01:44:0x 之后**（晚于断连 20s 以上），且两个探测均返回
  `目标计算机积极拒绝`，即收到 RST、**根本没有建立连接、没有发送业务报文**；
- 且 ESP32:9101 侧无监听（否则不会被拒），探测在 TCP 语义上碰不到它到 bridge 的既有连接。
- 结论：**没有机制与证据支持探测诱发断连**；断连更可能是 Wi-Fi/AP 侧共同原因（Windows 系统日志中该时段无 WLAN/Tcpip 事件可佐证，见 §8）。

---

## 5. MQTT 只读订阅证据

### 5.1 第一次订阅（85s，`mqtt-sub-home.log`）

```
### MQTT sub start local=2026-10-28 01:42:08.002 ###
...  ### MQTT sub end local=2026-10-28 01:43:33.135 ###
```

- 收到的 status 主题**只有 3 个**：`home/dayu200-living/status`(28)、`home/esp32-kitchen/status`(15)、`home/esp32-bath/status`(15)，合计 58 条；
- **`home/esp32-sos/status`：0 条**。

样例（01:42 段，设备侧 `ts`）：

```
home/dayu200-living/status  {"deviceId":"dayu200-living","room":"客厅","ts":1793122930356,"state":"ALARM",...,"alarm":{"id":"a-1793120863-1","type":"FALL","countToday":1}}
home/esp32-bath/status      {"deviceId":"esp32-bath","room":"卫生间","ts":1793122931092,"state":"NORMAL","sensors":{"motion":{"countToday":187},...},"alarm":{"id":"","type":""}}
home/esp32-kitchen/status   {"deviceId":"esp32-kitchen","room":"厨房","ts":1793122932094,"state":"ALARM",...,"gas":{"raw":4095,"ok":true,"valid":true},"alarm":{"id":"e-1793122274-1","type":"NO_MOTION","countToday":1}}
```

### 5.2 第二次订阅（带到达时刻的探针，65s，`mqtt-tsprobe.log`）

窗口 `1793123183246 → 1793123248245`（01:46:23.246 → 01:47:28.245），共 **46 条 status**：

| deviceId | 条数 | 端到端延迟 min/中位/max | 同设备相邻到达间隔（中位） |
|---|---|---|---|
| dayu200-living | 22 | **204 / 211 / 229 ms** | 3012 ms |
| esp32-kitchen | 12 | **-86 / -30 / 312 ms** | 5502 ms |
| esp32-bath | 12 | **-179 / -95 / 330 ms** | 5499 ms |
| esp32-sos | **0** | — | — |

> 负延迟 = ESP32 本地时钟略快于主机（kitchen 约 +15ms、bath 约 +130ms），属正常时钟偏差，不代表乱序。
> dayu200-living 的 204–229ms 稳定延迟主要来自「板端 homemon → hdc fport → bridge → broker」这一段。

---

## 6. esp32-sos / 随身求助（不一致的“第 4 个节点”）

### 6.1 MQTT 侧：**从来不存在 `home/esp32-sos/status`**

- 两次订阅（85s + 65s，合计覆盖 01:42:08–01:43:33 与 01:46:23–01:47:28）共 104 条 status，**sos 主题 0 条**；
- `bridge.out.log` 中 `home/esp32-sos/status` 发布次数 = **0**；
- 原因在设计：bridge 启动参数 `--relay-ignore esp32-sos`，且日志明文：

```
[2026-10-27T17:01:12.024Z]   relay忽略 : esp32-sos（板端连接上该 deviceId 的回灌只忽略：不改名、不发布、不退休）
```

### 6.2 它的真实链路与在线证据（`cloud\wearable-mirror\runtime\mirror-status.json`，01:46:35 快照）

```json
{"pid":61116,"running":true,"source":"api","online":true,
 "model":{"lastDeviceMsgAt":1793123187053,"lastSeenPcMs":1793123187473},
 "config":{"source":"api","transport":"relay","apiBase":"https://api.luxunacc.xyz",
           "deviceId":"esp32-sos","room":"随身求助","relay":"127.0.0.1:9001",
           "heartbeatMs":5000,"offlineAfterMs":45000},
 "sourceStatus":{"running":true,"lastSnapshot":{"state":"NORMAL","online":true,"lastSeenTs":1793123187053},
                 "polls":1016,"ok":1015,"errors":0,"authFailures":0,"lastOkAt":1793123190481},
 "transports":[{"kind":"relay","target":"127.0.0.1:9001","connected":true,
                "linesSent":551,"lastSentAt":1793123192875,
                "lastConnectedAt":1793120587500,"connects":1,"disconnects":0}]}
```

→ sos 的在线判定 = **公网 API 快照（api.luxunacc.xyz）+ 本机 mirror 的 relay 长连接（127.0.0.1:9001 → 板端 homemon）**。relay 自 01:03:07 起 **connects=1 / disconnects=0**。

### 6.3 bridge 侧对 sos 帧的处理（能收到，但按设计丢弃 / 有时解析失败）

- **成功解析后按设计丢弃**：`忽略板端连接上的 --relay-ignore 设备回灌：esp32-sos` 共 **398 条**，首条 17:03:21.588Z、末条 17:47:07.107Z，节奏约 **9 条/分钟**（每 6~7s 一条），逐分钟 7–11 条，全程无空洞；
- **解析失败**：`bridge.err.log` 共 **54 条，100% 是 esp32-sos**，首条 17:03:17.578Z、末条 17:46:31.903Z，约 **1.2 条/分钟**，间隔中位 32s：

```
[2026-10-27T17:03:17.578Z] [bridge] 状态行解析失败: {"deviceId":"esp32-sos","room":"随身求助","ts":1793120588442,"state":"NORMAL","onlin
[2026-10-27T17:46:31.903Z] [bridge] 状态行解析失败: {"deviceId":"esp32-sos","room":"随身求助","ts":1793123185799,"state":"NORMAL","onlin
```

> 每条都在第 80 字符被 `logErr(... line.slice(0,80))` 截断（bridge 源码第 809 行），所以不是日志本身坏，而是**收到的整行 JSON 解析失败**；0 条非 sos 失败（kitchen/bath/dayu 从未解析失败）。

### 6.4 sos 在线标志的真实抖动（`mirror.log`）

```
[2026-10-28 01:46:17.725] [mirror] emit(change) state=NORMAL online=false alarm=- gps=none ...
[2026-10-28 01:46:19.911] [mirror] emit(change) state=NORMAL online=false alarm=- gps=none ...
[2026-10-28 01:46:27.604] [mirror] emit(change) state=NORMAL online=true  alarm=- gps=none ...
```

→ **sos 的 online 在 01:46:17.7–01:46:27.6 之间掉了约 9.9s 又自愈**（此前 01:32–01:46 一直是 online=true，逐 30s 一条；更早 00:15/00:37/00:39/00:40 也有 online=false 记录，但那时处于 ALARM/ACKED 业务态）。

### 6.5 板端（homemon）侧旁证

- `hdc -t ... shell ps -ef | grep homemon` → `root 23655 1 0 00:44:46 ? 00:00:07 homemon homemon.conf`（板端起 00:44:46，存活）；
- `hdc -t ... shell cat /data/homemon/status.json`（01:46:36）是板端自己的客厅状态，`ts` 每 3s 滚动；
- `hdc -t ... shell tail -n 40 /data/homemon/homemon.log` → 只有健康探针的 TCP 接入/断开（第 2 路，约 10–20s 一次），无 relay/sos 错误；
- `hdc list targets` → `127.0.0.1:5555`、`450100445634303332012847942eca00`；`hdc fport ls` → `4501... tcp:9001 tcp:9000 [Forward]`。

### 6.6 「最近一次成功被系统接受」的 sos 状态

| 判据层 | 最近成功时刻 | 证据 |
|---|---|---|
| MQTT 主题 | **从未** | 两次订阅 0 条 `home/esp32-sos/status`；bridge publish 计数 0 |
| bridge 解析（随后按设计忽略） | **01:47:07.107** | out.log 最后一条 relay-ignore |
| 板端注入链路（mirror→9001→homemon） | **01:46:32.875**（lastSentAt） | mirror-status `linesSent=551`、disconnects=0 |
| APP 展示 | **01:46:46 的 UI dump** | “随身求助 · 已选设备在线 · esp32-sos”“在线（本地 TCP 已连接）”“随身求助设备 · 在线” |

---

## 7. 当前节点状态 / 传感器快照

来源：bridge 发布的最新状态（`supervisor\status.json` 01:46:36）+ MQTT 订阅载荷 + 板端 `status.json`。

| deviceId | state | alarm | 传感器关键值 |
|---|---|---|---|
| esp32-kitchen | ALARM | `e-1793122274-1 / NO_MOTION`（countToday=1） | motion countToday=1；door open=true seq=29；climate 25.2°C/58.7%RH valid；**gas raw=4095（恒满量程，15/15 帧全 4095）**；smoke 350–448 |
| esp32-bath | NORMAL | 无（id/type 空） | motion countToday 逐分钟 +1（180→189）；door open=true seq=42；climate 26.7–26.8°C/56.6–58.2%；gas/smoke `valid=false`（未配置） |
| dayu200-living | ALARM | `a-1793120863-1 / FALL`（countToday=1，evidenceId `fall-1793120863100-na`） | motion `supported=false`、climate/gas/smoke 全 0/valid=false（板端本身未接这些传感器）；`monitorOnline=-1` |
| esp32-sos | NORMAL | 无 | 由 mirror 注入：`state=NORMAL, online=true, gps=none` |

> dayu200-living 的 FALL 告警 id 时间戳换算为 **01:07:43**，此后一直是 ALARM/FALL 未清除（持续约 40 分钟）。

---

## 8. 其它旁证与排除项

- **健康探针不计节点**：bridge 源码 878–881 明确「收到 TCP 连接不等于无线节点接入」，日志 42 条 `忽略未识别的探测连接` 全部来自本机 127.0.0.1:9101 的 2s 探针；`netstat` 里对应多条 `TIME_WAIT`。这是正确行为，避免把探针误记成节点。
- **Windows 系统日志**：`Get-WinEvent` 查 `System` 日志 01:40–01:46 的 `WLAN-AutoConfig/Wlansvc/Netwtw/Tcpip/Dhcp/NDIS` **无任何事件返回**（该时段无系统级网络事件记录），因此不能据此判定 Wi-Fi 侧原因，只能按「两节点同时掉」推断共同原因。
- **板端第 2 路 TCP 连接**：homemon.log 里每 10–20s 的「TCP 客户端接入/断开（第 2 路）」是 watcher 的 `Test-Tcp 9001` 健康探针，非节点掉线；9001 上 bridge 的两条长连接（61798/61799）自 01:01:12 起未断。
- **`supervisor\status.json` 是覆盖写的“最后一台设备”**：01:39 是 esp32-kitchen、01:41 是 dayu200-living、01:46 又回到 esp32-kitchen —— 与 _CONTEXT 里“厨房节点最新状态”的差异由此解释，不是设备跳变。

---

## 9. 只读约束遵守复核

| 约束 | 本人体检动作 | 结果 |
|---|---|---|
| 不重启/停止进程 | 未执行任何 stop/kill/restart | ✅ |
| 不 publish MQTT | 只发 CONNECT+SUBSCRIBE（`mqtt_tool.js sub`、`_probe_mqtt_ts.js`） | ✅ |
| 不写 control | 未触碰 `control/`、未写板端 `/data/homemon/control` | ✅ |
| 不改板端状态 | 只 `ps/date/ls/cat/tail/grep`；`hdc fport ls` 只读 | ✅ |
| 不烧录 | 未执行任何烧录/flash | ✅ |
| 不跑 node --test | 未运行 | ✅ |
| TCP 探测连即断 | ESP32:9101 被 RST 拒绝，未建立连接、无业务报文 | ✅ |
