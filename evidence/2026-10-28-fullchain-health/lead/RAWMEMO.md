# Lead 原始证据（全链路实时体检，2026-10-28 01:41–01:50）

## A. 运行环境与进程

采集时刻 2026-10-28 01:41。

| PID | 进程 | 启动 | 说明 |
|---|---|---|---|
| 27820 | node mqtt_broker.js 1883 | 10-27 22:29:42 | broker 已连续运行 3h12m |
| 46720 | node mqtt_bridge.js | 10-28 01:01:11 | **01:01 重启后的当前实例**，单实例锁正常 |
| 32288 | node public-sync-supervisor.js | 10-28 01:01:12 | 公网同步守护 |
| 60936 | node public-sync-worker.js | 10-28 01:01:20 | 连 ECS 47.76.70.118:443 |
| 61116 | node server.js（wearable-mirror） | 10-28 01:03:07 | 连 homemon 9001 + ECS |
| 68808 | node server.js（监听 9443） | 10-28 01:16:28 | 待云层队友确认 |
| 38176 | powershell demo-autostart.ps1 | 10-28 01:01:01 | watcher，CPU 371s/0.67h |
| 68500 | powershell start-demo-supervisor.ps1 | 10-28 01:01:02 | 总控 |

监听：`::1883`(broker)、`::9101`(bridge 无线节点)、`127.0.0.1:9001`(hdc fport→板端 homemon)、`0.0.0.0:9443`、`127.0.0.1:9002`(video relay)。

资源：无异常增长（bridge WS 55MB、broker 46.5MB、worker 44MB、mirror 72MB；bridge 句柄 211）。
磁盘 D: 余 269.7GB。WLAN MediaTek Wi-Fi6 144.4Mbps Up。

## B. 节点连通性（ICMP，3 包）

| 目标 | 结果 |
|---|---|
| 10.127.130.168（esp32-kitchen） | 3/3 通，平均 13.7ms |
| 10.127.130.71（esp32-bath） | 3/3 通，平均 15.7ms |

`hdc list targets`：`127.0.0.1:5555`（模拟器）、`450100445634303332012847942eca00`（DAYU200）。
`hdc fport ls`：`tcp:9001 tcp:9000 [Forward]` 在。

## C. MQTT 只读观测（150 秒，`home/#`，01:41:28–01:43:58）

`logs/mqtt-observe-150s.log`，共 191 行，收报文 94 条。

| deviceId | 条数 | 相邻 ts 间隔 min/avg/max | 抖动(max-avg) | 最新 state |
|---|---|---|---|---|
| dayu200-living | 50 | 3.00 / 3.01 / 3.03 s | 0.02 s | ALARM（FALL，alarmId a-1793120863-1） |
| esp32-kitchen | 22 | 5.49 / 5.49 / 5.50 s | 0.01 s | ALARM→NORMAL |
| esp32-bath | 22 | 5.48 / 5.48 / 5.50 s | 0.02 s | NORMAL |
| **esp32-sos** | **0** | — | — | **本地 broker 的 `home/*` 上完全没有它** |

结论：MQTT 侧 3 台设备节拍稳定到 ±20ms；esp32-sos 不经本地 broker（设计上 `--relay-ignore`），
它走的是另一条（云端 API / mirror）路径，需由云层队友给结论。

## D. 三小时长窗口稳定性（来自 `evidence\2026-10-27-wireless-without-usb\timeline\wireless-unplug-timeline.jsonl`）

采集器 PID 52772 每约 19 秒写一条，窗口 22:34:37 → 01:45:08（190 分钟，590 条）。
它记录后端 4 台设备 online/ageSec、bridge 入站连接、DAYU ping、hdc targets、fport。

| 设备 | 离线累计 | 离线占比 | 最长单次 | 最长起始 |
|---|---|---|---|---|
| esp32-kitchen | 9.8 min | 5.2% | 2.4 min | 00:14:30 |
| esp32-bath | 39.7 min | 20.8% | **38.4 min** | 00:20:13 |
| dayu200-living | 59.3 min | **31.1%** | **25.0 min** | 00:00:01 |
| esp32-sos | 0.6 min | 0.3% | 0.6 min | 00:40:56 |

**01:01 重启后窗口（01:01:09→01:45:08，133 条）**：
kitchen 与 bath 各 2 条离线样本（即 01:43:48 那次同时重启），最大 age 147s；dayu200-living 0 条离线；
esp32-sos 0 条离线，最大 age 29.4s。

### D.1 正在发生的节点同时重启（01:43:48）

`bridge.out.log` 原文：
```
[17:43:48.231Z] [bridge] 无线节点 esp32-bath 断开
[17:43:48.945Z] [bridge] 无线节点 esp32-kitchen 断开
[17:44:00.687Z] [bridge] 无线节点接入并完成身份绑定：esp32-kitchen（来源 ::ffff:10.127.130.168:59409）
[17:44:01.893Z] [bridge] 无线节点接入并完成身份绑定：esp32-bath（来源 ::ffff:10.127.130.71:50040）
```
- 两节点在 1.2 秒内同时断开，源端口全部更换（62780/61793 → 59409/50040）。
- 数据空洞：kitchen 最后一条 17:43:28.849Z → 17:44:02.892Z ≈ **34 秒**；bath ≈ 33 秒。
- **bath 的 countToday 由 189 归零到 1**（重连后重新计数）→ 不是单纯 TCP 重连，而是**节点重启**。
- 此后至今（01:45:36）两节点按 5.5s 节拍持续上报，已恢复。

### D.2 更早的断链（同一窗口）

- bridge 入站连接两次清空：22:36:38→22:36:57（19s）、00:14:09→00:16:35（**2 分 26 秒**）。
- 00:20:13 起 bath 消失，直到 00:58:36 才回来（**38 分钟**）；期间 kitchen 也断过一段。
- DAYU 多次长时间离线：22:46–22:57（11 分）、00:00–00:25（25 分）、00:28–00:47（18 分）。
- `dayuPing` 在 590 个样本里只有 111 次为 true（19%）——DAYU 当前靠 **USB hdc fport**，不是 Wi-Fi。
- hdc targets 缺失 DAYU 的样本 71 个，集中在 22:43–22:56（与 autostart 日志“HDC target not connected”连续重试吻合）。

## E. bridge 错误日志：esp32-sos 状态行解析失败（持续小概率）

`bridge.err.log` 51 行，全部同一形态：
```
[2026-10-27T17:44:14.135Z] [bridge] 状态行解析失败: {"deviceId":"esp32-sos","room":"随身求助","ts":1793123044325,"state":"NORMAL","onlin
```
- 时间 17:03:17Z（本地 01:03:17）→ 17:44:14Z（本地 01:44:14），约每 40-50 秒 1 条，偶有停顿。
- 代码位置 `mqtt_bridge.js:809`，日志按 `line.slice(0,80)` 截断，**不代表报文只有 80 字符**。
- 同一时间窗内 `esp32-sos` 大多数行是**正常解析后被 `--relay-ignore` 忽略**（out.log 里 01:03–01:45 有 800+ 条
  “忽略板端连接上的 --relay-ignore 设备回灌：esp32-sos”）。即：约 9 成正常、约 1 成解析失败。
- 发生在 `attachNode()` 的 endpoint 分支（板端 status-tcp 127.0.0.1:9001），即 homemon 广播回来的行。
- 影响待定：本地 broker 本来就不发布 esp32-sos，故不影响 MQTT 主题；但说明**注入链路有分帧/畸形行**。

## F. 进程与栈的重启史（来自 `demo-autostart.log`）

```
[22:43:49] Unknown inference process already exists; not killing: 2379
[22:43:51 ~ 22:56:36] HDC target not connected; restarting hdc server once  （连续 27 次，约 13 分钟）
[22:56:44] Restoring hdc fport tcp:9001 -> tcp:9000.
[00:53:47] Watcher start.
[00:55:12] 检测到 STALE supervisor lock PID=40628（进程已退出）… P0 不健康（STALE_LOCK）
[00:57:44] P0 不健康（WORKER_DEAD）但 supervisor 进程仍存活 PID=67276；等待自身重启
[01:01:01] Watcher start.
[01:01:02] 检测到 STALE supervisor lock PID=67276（进程已退出）… P0 不健康（PORTS_DOWN）
[01:08:10] Bringing formal app to foreground.
```
即：今晚 00:53–01:01 之间，supervisor+worker+bridge 这一整套**死过一次并被重新拉起**；
22:43–22:56 之间 DAYU 的 HDC 通道断了 13 分钟后由 autostart 恢复 fport。

## G. watcher 当前状态（01:39:39 快照，之后持续刷新）

`p0=healthy`、`targetConnected=true`、`app=active`、`inference=running`、`cameraFrames=LIVE`、`nodes=4/4`。
注意 `nodes=4/4` 的口径需要核实（本地 MQTT 只有 3 个 deviceId）。
