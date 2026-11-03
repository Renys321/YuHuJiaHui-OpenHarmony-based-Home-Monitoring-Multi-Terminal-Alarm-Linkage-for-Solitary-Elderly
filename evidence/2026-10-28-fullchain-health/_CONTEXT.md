# 全链路体检 · 共享基准（Lead 采集，2026-10-28 01:41 Asia/Shanghai）

> 本次任务是**只读体检**。演示系统正在运行，任何 teammate **不得**：
> 重启/停止 broker、bridge、supervisor、watcher、video、public-sync 进程；
> 不得 publish MQTT 命令（ack/reset/sos/fall/config 等）或写 control 文件；
> 不得 hdc shell 改动板端状态、不得重烧固件、不得改 APP、不得改配置。
> 允许：读取文件/日志、netstat、TCP connect 探测（可连即断）、MQTT **subscribe**、HTTP GET 健康接口、
> `hdc list targets` / `hdc shell` **只读查询**（如 ps、netstat、日期、读日志）。
> 所有产出写到本目录下各自子目录，不要互相覆盖。

## 1. 当前进程（PID / 启动时间）

| PID | 进程 | 启动 | 作用 |
|---|---|---|---|
| 27820 | node `bridge\mqtt_broker.js 1883` | 10-27 22:29:42 | 自包含 MQTT broker（监听 `::1883`） |
| 46720 | node `bridge\mqtt_bridge.js --broker 127.0.0.1:1883 --status-tcp 127.0.0.1:9001 --listen 9101 --relay-to 127.0.0.1:9001 --relay-ignore esp32-sos --lock-file ...` | 10-28 01:01:11 | 主桥接（板端 TCP + 无线节点 9101 + MQTT） |
| 32288 | node `cloud\onenet\public-sync-supervisor.js` | 10-28 01:01:12 | 公网同步守护 |
| 60936 | node `cloud\onenet\public-sync-worker.js` | 10-28 01:01:20 | 公网同步执行体（连 ECS 47.76.70.118:443、本地 1883） |
| 61116 | node `server.js --source api --transport relay --relay-to 127.0.0.1:9001 --listen-port 9002 ...` | 10-28 01:03:07 | 视频/中继服务（占用 9001 一路连接） |
| 68808 | node `server.js`（D:/Node） | 10-28 01:16:28 | 待确认（app 层 teammate 核实） |
| 52772 | node `collect-timeline.js` | 10-27 22:34:37 | 数据采集（时间线） |
| 31928 | hdc.exe（服务） | 10-27 22:56:37 | HDC 服务，持有 `fport tcp:9001` |
| 38176 | powershell `demo-autostart.ps1` | 10-28 01:01:01 | 演示自启动看护（watcher） |
| 68500 | powershell `start-demo-supervisor.ps1 -AutoDayuEndpoint` | 10-28 01:01:02 | 演示总控 |

## 2. 监听 / 已建立连接（2026-10-28 01:41）

监听：
- `::1883` broker（27820）
- `::9101` bridge 无线节点监听（46720）
- `127.0.0.1:9001` hdc fport（31928）→ 板端 homemon TCP

已建立（关键）：
- bridge → broker：`127.0.0.1:61797 → 1883`
- public-sync-worker → broker：`55269 → 1883`
- bridge → 9001（两路）：`61798/61799 → 9001`（status-tcp + relay-to）
- 视频服务 → 9001：`51362 → 9001`
- **无线节点 → 9101**：`10.127.130.168:62780`、`10.127.130.71:61793`（正是 2 个 ESP32）
- public-sync-worker → ECS：`47.76.70.118:443`；视频服务 → `47.76.70.118:443`

## 3. 运行时状态快照

`bridge\_test\current-runtime\supervisor\status.json`（01:39:39 由 watcher 写）：
```json
{"timestamp":"2026-10-28 01:39:39","target":"450100445634303332012847942eca00","targetConnected":true,
 "p0":"healthy","p0Reason":"HEALTHY","app":"active","inference":"running","cameraFrames":"LIVE",
 "nodes":"4/4","userStop":false,"userPaused":false,"lastEventCount":162814,"watcherPid":38176}
```

`evidence\2026-10-26-demo-autostart\runtime\watcher-state.json`（最新）：
```json
{"timestamp":"2026-10-28 01:39:39","target":"450100445634303332012847942eca00","targetConnected":true,
 "p0":"healthy","p0Reason":"HEALTHY","app":"active","inference":"running","cameraFrames":"LIVE",
 "nodes":"4/4","userStop":false,"userPaused":false,"lastEventCount":162814,"watcherPid":38176}
```

bridge 当前状态文件（`supervisor\status.json` 内容为厨房节点最新状态）：
`esp32-kitchen / 厨房`，`ts=1793122789284`，`state=ALARM`，sensors：motion(countToday=1)、door(open=true,seq=29)、
climate(25.1°C / 59.6%RH, valid)、gas(raw=4095, valid)、smoke(raw=357, valid)，alarm `e-1793122274-1 / NO_MOTION`。

## 4. 关键路径（已存在，勿新建）

- 桥接日志：`bridge\_test\current-runtime\supervisor\bridge.out.log`（~283 KB，带 ISO 时间戳）、`bridge.err.log`（~6 KB）
- broker 日志：同目录 `broker.out.log`、`broker.err.log`
- 桥接单实例锁：同目录 `bridge.lock`
- supervisor 日志：同目录 `public-sync-supervisor.*.log`（~1.37 MB）
- watcher/自启：`evidence\2026-10-26-demo-autostart\runtime\`（`demo-autostart.log`、`ui-last.json`、`watcher-state.json`）
- 云端：`cloud\onenet\`（public-sync-*、thing-model.json）、`cloud\wearable-mirror\runtime\mirror-status.json`、
  `cloud\wearable-mqtt\`、`cloud\backend\`
- 视频：`video\relay\`、`deploy\video\`
- 文档：`docs\ARCHITECTURE.md`、`docs\VALIDATION-MATRIX.md`、`docs\KNOWN-RISKS.md`、`bridge\README.md`、`southbound\README.md`、`cloud\*\README.md`

## 5. 工具

- node：`D:\Node\node.exe`
- hdc：`<WORKSPACE>\tools\hdc\hdc.exe`
- MQTT 只读订阅：`D:\Node\node.exe <WORKSPACE>\competition\bridge\mqtt_tool.js sub --broker 127.0.0.1:1883 --topic "home/#" --seconds N`
- 健康检查脚本（**只读模式**，勿传会重启的参数）：`materials\verify-p0-health.ps1`、`materials\public-sync-health.ps1`、`materials\device-preflight.ps1`

## 6. 输出要求（每层）

写到各自子目录，文件名固定：
- `RAWMEMO.md`：你实际看过的原始证据（日志片段、命令输出）、带时间戳
- `FINDINGS.md`：结论。每条必须给 **PASS / DEGRADED / FAIL + 证据行号或日志原文 + 是否影响演示**

必须覆盖“节点/链路是否稳定”的量化项：连接是否在线、最近上报距今多久、断线重连次数与时刻、
错误日志条数与时间分布、端到端延迟或上报间隔抖动、单点故障点、已存在但未触发的风险。

## 7. 演示链路拓扑（抽象）

```
ESP32 厨房(10.127.130.x) ─Wi-Fi/TCP→ bridge:9101 ┐
ESP32 卫生间(10.127.130.y) ─Wi-Fi/TCP→ bridge:9101 ┤
DAYU200 homemon ─hdc fport 9001─→ bridge(status-tcp) ┤─→ bridge ─MQTT→ broker:1883 ─→ public-sync-worker ─HTTPS→ ECS
随身求助 esp32-sos ─(板外注入/relay)─→ homemon ─fport 9001─→ video/relay server ─→ APP
broker ─→ 订阅端(APP/多终端)
```
