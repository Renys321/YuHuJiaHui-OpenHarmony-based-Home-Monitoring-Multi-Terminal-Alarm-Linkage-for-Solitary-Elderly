# 云与应用层体检 · 原始证据（RAWMEMO）

- 体检时间窗：**2026-10-28 01:41:20 ~ 01:49:30（Asia/Shanghai）**，全部为只读操作。
- 时区约定：`public-sync-supervisor.log`、`bridge.*.log`、`video relay` 日志是 **UTC（Z）**，本地 = UTC+8；
  `demo-autostart.log`、`mirror.log`、`watcher-state.json`、`status.json`、板端 `ps/date` 是 **本地 CST**。
- 本机时区核对：`Get-Date` → `2026-10-28 01:41:23`；板端 `date` → `Wed Oct 28 01:46:46 CST 2026`（两侧一致）。
- 只读边界：仅执行了 `Get-Content / Select-String / Get-NetTCPConnection / Get-CimInstance / TCP connect /
  HTTP GET / hdc shell 只读查询(cat/ps/netstat/tail/wc/ls/date) / materials\public-sync-health.ps1`。
  **未** 重启/停止任何进程、**未** publish MQTT、**未** 改配置/重部署、**未** 运行 `node --test`。
- 期间唯一"非本 teammate 新增"的进程：`68640 node mqtt_tool.js sub ...`（01:43:05 出现，属其他只读订阅方，非我启动）。

---

## 0. 进程与 PID 归属（更正 _CONTEXT.md 两处）

`Get-CimInstance Win32_Process` + `Get-NetTCPConnection -OwningProcess`：

| PID | 实际命令行 | 归属 |
|---|---|---|
| 27820 | `node bridge\mqtt_broker.js 1883`（start 10-27 22:29:42） | 本地 broker |
| 46720 | `node bridge\mqtt_bridge.js --broker 127.0.0.1:1883 --status-tcp 127.0.0.1:9001 --listen 9101 --relay-to 127.0.0.1:9001 --relay-ignore esp32-sos --lock-file ...\bridge.lock --status-file ...\status.json` | 主桥接 |
| 32288 | `node cloud\onenet\public-sync-supervisor.js --public-sync-entry ... --worker-script ... --state-file ... --lock-file ... --log-file ...` | 公网同步守护 |
| 60936 | `node cloud\onenet\public-sync-worker.js` | 公网同步执行体 |
| **61116** | `node server.js --source api --transport relay --relay-to 127.0.0.1:9001 --listen-port 9002 --runtime-dir ...cloud\wearable-mirror\runtime --heartbeat-ms 5000 --poll-ms 2000 --api-base https://api.luxunacc.xyz` | **wearable-mirror（不是视频服务）** ← 更正 _CONTEXT §1 |
| **68808** | `D:/Node/node.exe server.js`（listening `0.0.0.0:9443`，start 01:16:28） | **video relay（local 模式）** = `_CONTEXT` 里"待确认"的那个 |
| 34920 | `Emulator.exe -start "Mate 90 Pro" ...` | **APP 跑在 DevEco 模拟器里**（APP 宿主） |
| 52772 | `node collect-timeline.js` | 时间线采集（也连 ECS 443） |
| 38176 | `powershell materials\demo-autostart\demo-autostart.ps1`（start 01:01:01） | watcher |
| 68500 | `powershell materials\start-demo-supervisor.ps1 -AutoDayuEndpoint`（start 01:01:02） | 演示总控 |

关键进程启动时间（`Get-Process ... StartTime`）：
```
27820 node 2026/10/27 22:29:42
32288 node 2026/10/28 1:01:12
46720 node 2026/10/28 1:01:11
60936 node 2026/10/28 1:01:20
61116 node 2026/10/28 1:03:07
68808 node 2026/10/28 1:16:28
38176 powershell 2026/10/28 1:01:01
68500 powershell 2026/10/28 1:01:02
```

---

## 1. 公网同步 supervisor / worker（PID 32288 / 60936）

### 1.1 状态文件原文（01:49:04）
`bridge\_test\current-runtime\supervisor\public-sync-supervisor.state.json`：
```json
{
  "supervisorPid": 32288,
  "workerPid": 60936,
  "state": "HEALTHY",
  "startedAt": 1793120472905,
  "heartbeatAt": 1793123330870,
  "restartCount": 0,
  "lastWorkerStartedAt": 1793120480025,
  "lastWorkerExit": null,
  "lastHealthyAt": 1793120480288
}
```
`heartbeatAt=1793123330870` ≈ 01:48:50（本地），采样时刻 01:49:04 → **心跳龄 ~14s**（写周期 30s）。

### 1.2 只读健康脚本（先读源码确认只读，再执行）

`materials\public-sync-health.ps1` 源码核验：`:44` 执行
`node public-sync-supervisor.js --check --state-file ... --lock-file ...`；
supervisor 源码 `:532-551` 的 `--check` 分支只 `readFileSync(state/lock)` + `evaluateSupervisorHealth()`
+ `process.stdout.write(JSON)` + `process.exit()`，**不启动、不写、不读密钥、不抢锁**。脚本头注释也声明只读。
执行结果（01:42:55）：
```json
{
  "checkedAt": "2026-10-28 01:42:55",
  "brokerListening": true,
  "bridgeListening": true,
  "supervisor": {
    "supervisorPid": 32288, "supervisorAlive": true,
    "workerPid": 60936, "workerAlive": true,
    "heartbeatAgeMs": 5122, "maxHeartbeatAgeMs": 90000,
    "state": "HEALTHY", "lockPid": 32288,
    "healthy": true, "reason": "HEALTHY"
  },
  "supervisorCheckExit": 0, "portsOk": true, "healthy": true, "reason": "HEALTHY"
}
```
`exit=0`。

### 1.3 supervisor 全生命周期日志（83 条 `[supervisor]` 行，10-25 14:27Z → now）

worker 异常退出/重启（历史）：
```
2026-10-26T17:59:36.081Z WORKER_EXIT code=4294967295 durationMs=11176607 → RESTART_IN 1000ms restartCount=1
2026-10-26T18:23:12.943Z WORKER_EXIT code=1073807364 durationMs=1415835  → RESTART_IN 2000ms restartCount=2
2026-10-26T18:23:14.983Z WORKER_EXIT code=3221226091 durationMs=21       → RESTART_IN 5000ms restartCount=3
2026-10-27T08:25:04.738Z WORKER_EXIT code=3221225786 durationMs=15977210
2026-10-27T15:03:11.263Z WORKER_EXIT code=4294967295 durationMs=1986864  → RESTART_IN 1000ms
2026-10-27T15:04:37.107Z WORKER_EXIT code=3221225786 durationMs=84814
2026-10-27T16:54:30.861Z WORKER_EXIT code=4294967295 durationMs=6348150  → RESTART_IN 1000ms
```
supervisor 进程本身的换代（`STALE_LOCK_TAKEOVER`）节选（末 4 次）：
```
2026-10-27T14:26:18.380Z LOCK_ACQUIRED pid=11412  STALE_LOCK_TAKEOVER dead_pid=29048
2026-10-27T14:29:56.851Z LOCK_ACQUIRED pid=39628  STALE_LOCK_TAKEOVER dead_pid=11412
2026-10-27T15:08:20.881Z LOCK_ACQUIRED pid=40628  (无 takeover)
2026-10-27T16:57:38.771Z LOCK_ACQUIRED pid=67276  STALE_LOCK_TAKEOVER dead_pid=40628
2026-10-27T17:01:12.907Z LOCK_ACQUIRED pid=32288  STALE_LOCK_TAKEOVER dead_pid=67276
2026-10-27T17:01:20.025Z WORKER_START pid=60936
2026-10-27T17:01:20.290Z HEALTHY pid=60936          ← 当前会话起点（01:01:20 本地）
```
> **当前会话自 17:01:20Z 起无任何 `WORKER_EXIT` / `RESTART_IN` / `CIRCUIT_OPEN`。**

代码口径（`public-sync-supervisor.js`）：
- 退避 `DEFAULT_BACKOFF_MS = [1000,2000,5000,10000,30000]`，上限 30000ms；
- 熔断 `maxCrashes=3 / circuitWindowMs=5min`，CIRCUIT_OPEN 保持 `circuitHoldMs=60s` 后有界重试（`:372-391`）；
- 心跳 `heartbeatMs=30s`，健康判定 `maxHeartbeatAgeMs=max(3*30s,90s)=90s`（`:472-513`）；
- **`restartCount` 是"本 supervisor 进程内"计数**，每次 supervisor 换代即归零。

### 1.4 消息面统计

全量日志（10-25 14:27Z 起，9905 → 采样时 ~10.0k 行）：
| 指标 | 次数 | 比率 |
|---|---|---|
| `[cloud-sync] OK`（上报 202） | 4491 | — |
| `[cloud-sync] FAIL` | 1100 | 失败率 **19.67%**（全量，含历史中断） |
| `[command-sync] POLL_OK`（200） | 1170 | — |
| `[command-sync] POLL_FAIL` | 1653 | 失败率 **58.55%**（全量，含历史中断） |

**当前会话（17:01:20Z ~ 17:49Z，约 48 min）**：
| 指标 | 次数 | 比率 |
|---|---|---|
| cloud-sync OK | 264 | — |
| cloud-sync FAIL | 1 | **0.377%** |
| POLL_OK | 47 | — |
| POLL_FAIL | 2 | **4.08%** |

当前会话仅 3 条失败（全部秒级自愈）：
```
2026-10-27T17:06:16.024Z [worker:stderr] [cloud-sync] FAIL code=UNKNOWN device=esp32-kitchen
  ← 17:06:20.981Z 同设备 OK 202；17:06:21.042Z 另两台 OK
2026-10-27T17:18:00.335Z [worker:stderr] [command-sync] POLL_FAIL code=SYNC_TIMEOUT
  ← 17:18:18.784Z 恢复 OK
2026-10-27T17:20:51.384Z [worker:stderr] [command-sync] POLL_FAIL code=SYNC_TIMEOUT
  ← 17:20:52.736Z / POLL_OK 17:20:33 之后即恢复
```
失败码历史分布（全量 stderr）：`POLL_FAIL SYNC_HTTP_ERROR 953`、`POLL_FAIL ENOTFOUND 574`、
`cloud-sync FAIL SYNC_HTTP_ERROR 557`、`SYNC_TIMEOUT 344`、`ENOTFOUND 170`、`UNKNOWN 16`、
`ECONNRESET 10/10`、`ACK_TIMEOUT 8`、`ECONNABORTED 3`。

失败按 UTC 小时聚集（>50 条/小时，即历史事故窗）：
```
2026-10-26T10  670      2026-10-26T16  1227(含REJECT)
2026-10-26T11  316      2026-10-26T18  190
2026-10-26T13  744      2026-10-27T07   81
2026-10-26T15  206      2026-10-27T16   85
2026-10-27T17    3      ← 当前小时（3 条，均已自愈）
```
`[gateway] REJECT code=INVALID_STATUS` 1003 条，时间跨度
`2026-10-26T15:41:43Z` → `2026-10-27T15:03:09Z`，**当前会话 0 条**。
`[gateway] LOCAL_ERROR/LOCAL_DISCONNECTED/LOCAL_RECONNECT attempt=1..5` 全部集中在
`2026-10-27T14:26:33Z~14:27:04Z`（那时本地 broker 未就绪，指数退避 1/2/4/8/16s 后恢复），之后无。

### 1.5 worker ↔ ECS 47.76.70.118:443 连通性（实测）

```
netstat(Established):
  10.127.130.179:51104 → 47.76.70.118:443  PID 60936 (public-sync-worker)
  10.127.130.179:60098 → 47.76.70.118:443  PID 60936
  10.127.130.179:51363 → 47.76.70.118:443  PID 61116 (wearable-mirror → api)
  10.127.130.179:60994 → 47.76.70.118:443  PID 34920 (模拟器 APP)
  10.127.130.179:52046 → 47.76.70.118:443  PID 52772 (collect-timeline)
```
DNS：
```
Resolve-DnsName api.luxunacc.xyz → A 47.76.70.118   （单条 A 记录，无 SRV/无备 IP）
```
TCP 三次握手 RTT（3 次抽样，TcpClient.Connect）：
```
sample 1: connected 123 ms
sample 2: connected 133 ms
sample 3: connected 125 ms
```
HTTP（GET，只读）：
```
https://api.luxunacc.xyz/healthz  -> 200 (123ms)  {"ok":true,"service":"eldercare-cloud-backend"}
https://api.luxunacc.xyz/health    -> 401（需鉴权，说明 TLS+HTTP 栈正常）
https://api.luxunacc.xyz/api/health-> 401
http://47.76.70.118/               -> 308 Permanent Redirect（Caddy → https）
```
ECS 端口探测（connect 即断）：
```
47.76.70.118:443  OPEN  120ms
47.76.70.118:1883 OPEN  109ms      ← wearable-mqtt broker 暴露公网
47.76.70.118:80   OPEN  107ms
47.76.70.118:9002 CLOSED/超时 21054ms
47.76.70.118:8443 CLOSED/超时 21036ms
```

### 1.6 最近成功/失败时刻（分设备，采样 01:42 前后）
```
dayu200-living -> 2026-10-27T17:41:44.020Z (=01:41:44 本地)
esp32-kitchen  -> 2026-10-27T17:41:56.525Z
esp32-bath     -> 2026-10-27T17:42:00.327Z
last POLL_OK   -> 2026-10-27T17:41:44.857Z
最近 FLUSH 采样（01:49:04）：
  17:48:37.514Z OK esp32-bath status=202
  17:48:49.636Z POLL_OK 200
  17:48:57.997Z OK dayu200-living status=202
```
每设备上报间隔 ≈ 30s（48min 内 3 设备各 ~88 次），与 `gateway.js:44 DEFAULT_STABLE_INTERVAL_MS=30000` 一致。
连续 OK 之间 >90s 的空档（近 5h，仅 6 处，均在进程换代处）：
```
21908s 止于 2026-10-27T14:30:06Z  （worker 停摆窗口）
  259s 止于 2026-10-27T15:08:43Z  （worker 重启）
  142s 止于 2026-10-27T16:16:37Z
  104s 止于 2026-10-27T16:21:42Z
  192s 止于 2026-10-27T16:57:47Z  （supervisor 换代）
  181s 止于 2026-10-27T17:01:21Z  （当前会话起点）
当前会话内：无 >90s 空档。
```
`cloud-sync.js:23 DEFAULT_TIMEOUT_MS=5000`（单次 HTTP 5s 超时）；**无内部重试**，
失败后靠下一条状态 / 下一次 polling 自然恢复（证据：17:06:16 FAIL → 17:06:20 OK）。

---

## 2. 云端组件

### 2.1 云端可观测面
| 组件 | 证据 | 结论 |
|---|---|---|
| `cloud\backend`（ECS 47.76.70.118） | `GET /healthz → 200 {"ok":true,"service":"eldercare-cloud-backend"}` 123ms | 在线 |
| 同上，命令通道 | worker `POLL_OK /internal/v1/commands status=200`，48min 内 47 次 | 在线 |
| 同上，数据通道 | worker `POST /internal/v1/device-status status=202`，48min 内 264 次 | 在线 |
| `cloud\onenet` | 本地代码/thing-model：`thing-model.json`(7748B, 10-10)、`public-sync-*.js`；worker 用 `--public-sync-entry public-sync.js` 跑 | 代码与模型在位，无本地服务进程（服务在 ECS） |
| `cloud\wearable-mirror` | 见 2.2 | 在线且数据新鲜 |
| `cloud\wearable-mqtt` | 仅源码（docker 部署在 ECS）；`47.76.70.118:1883 OPEN 109ms` | **端口在线，但无本地状态/日志可核**（证据不足） |

### 2.2 `cloud\wearable-mirror\runtime\mirror-status.json`（01:49:03 采样，文件 mtime 同步更新）
```json
{ "pid": 61116, "running": true, "online": true, "updatedAt": 1793123343467,
  "lastEmitAt": 1793123343467, "emitCount": 505, "changeEmitCount": 81, "heartbeatEmitCount": 424,
  "sourceSwitches": 0, "fatalError": "",
  "sourceStatus": { "kind":"api", "base":"https://api.luxunacc.xyz",
      "lastSnapshot": {"state":"NORMAL","online":true,"lastSeenTs":1793122952555,...},
      "polls": 1076, "ok": 1076, "errors": 0, "authFailures": 0, "logins": 1, "lastError": "" },
  "model": { "lastDeviceMsgAt": 1793123336917, "lastSeenPcMs": ..., "event": null, "latestGps": null,
             "counters": {"payloads":0,"sos":0,"hb":0,"ack":0,"apiPolls":1076,"apiSnapshots":1076,...} },
  "transports": [ { "kind":"relay","target":"127.0.0.1:9001","connected":true,"linesSent":505,
                    "connects":1,"disconnects":0,"lastError":"" } ] }
```
- `polls=1076 ok=1076 errors=0 authFailures=0` → 对云端 API 轮询 **100% 成功**；
- `connects=1 disconnects=0`（自 01:03:07 起 46 min）→ 到本地 relay 的 TCP **零断线**；
- `updatedAt/lastEmitAt` ≈ 01:49:03（采样时 -0s）；`model.lastDeviceMsgAt` ≈ 01:48:56。

`mirror.err.log` = 2 字节（空）；`mirror.log`(54950B, mtime 01:48)。
mirror.log 尾部（含一次 10 秒的 online=false）：
```
[2026-10-28 01:45:33.022] [mirror] emit(change) state=NORMAL online=true  alarm=- gps=none
[2026-10-28 01:46:17.725] [mirror] emit(change) state=NORMAL online=false alarm=- gps=none
[2026-10-28 01:46:19.911] [mirror] emit(change) state=NORMAL online=false alarm=- gps=none
[2026-10-28 01:46:27.604] [mirror] emit(change) state=NORMAL online=true  alarm=- gps=none
[2026-10-28 01:46:57.630] [mirror] emit(change) state=NORMAL online=true  alarm=- gps=none
[2026-10-28 01:47:28.916] [mirror] emit(change) state=NORMAL online=true  alarm=- gps=none
```
（`online=false` 持续 01:46:17~01:46:19，01:46:27 恢复；`offlineAfterMs=45000`，即云端快照 lastSeen 落后 45s 才判离线。）

mirror 配置要点：`mqttHost=47.76.70.118:1883`、`apiBase=https://api.luxunacc.xyz`、`relay=127.0.0.1:9001`、
`tcpListen=127.0.0.1:9002`、`deviceId=esp32-sos`、`heartbeatMs=5000`、`offlineAfterMs=45000`。

---

## 3. APP 侧观测（watcher-state / status.json / ui-last.json）

### 3.1 字段来源与刷新节奏（源码 `materials\demo-autostart\demo-autostart.ps1`，590 行）

| 字段 | 来源（行号） | 刷新 |
|---|---|---|
| `timestamp` | `Get-Date`（:460） | 主循环 2s（:583） |
| `targetConnected` | `Ensure-Hdc` → `hdc list targets` 含目标（:543-544） | 2s |
| `p0` / `p0Reason` | `Get-P0Health`：TCP 1883+9101 + supervisor state/lock/PID 存活（:159-176, :532） | 2s |
| `app` | (a) `pidof com.dsh.eldercare`（:256-261）；(b) UI 文本正则：`active` = 含「暂停监护\|监护运行中」（:278/323），`paused`/`foregrounding`/`starting`/`stopped` 各有分支（:283-325） | 2s 判进程；UI 文本最多 ~15~30s 一次（:288, :554-561） |
| `inference` | `pidof dayu_local_fall` 且 `readlink /proc/PID/exe` 命中 demo 目录（:363-374）+ `netstat -lntp \| grep 127.0.0.1:9200` 见 LISTEN（:389-393/:444） | 2s |
| `cameraFrames` | **`wc -l <device>/evidence/demo-events.jsonl` 行数在 8s 内增长** → `LIVE`；否则 `WAIT-FRAMES`（:563-569） | 2s |
| `nodes` | **APP UI 文本正则** `全屋在线\s*(\d+)/(\d+)\s*台设备`（:274-275），从 `uitest dumpLayout` 抓（:263-267） | 最多 30s 一次（:554） |
| `lastEventCount` | 同上 `wc -l`（:563） | 2s |

### 3.2 状态快照（三连采样，证明刷新）
```
01:39:39（_CONTEXT 基准）: app=active  inference=running cameraFrames=LIVE nodes=4/4 lastEventCount=162814
01:45:59               : app=present inference=running cameraFrames=LIVE nodes=4/4 lastEventCount=163387
01:48:12               : app=present inference=running cameraFrames=LIVE nodes=4/4 lastEventCount=163590
01:48:57               : app=present inference=running cameraFrames=LIVE nodes=4/4 lastEventCount=163658
```
`bridge\...\supervisor\status.json` 与 `evidence\...\runtime\watcher-state.json` 内容同源（watcher 写两份），
`status.json` 那份还会被 bridge 的 `--status-file` 覆盖为"最后一台上报设备"的原始状态（见 §5）。

### 3.3 `ui-last.json` 持续更新（4 次 mtime）
```
01:45:36 → 01:46:46 → 01:47:59 → 01:48:33     (size 95339 → 107161 B)
```
内容为 `uitest dumpLayout` 的 UI 树，`bundleName=com.dsh.eldercare` + `com.ohos.systemui`。
解码后可见文本（UTF-8）：
```
居家安全监护 / 客厅 / 厨房 / 随身求助 / 卫生间
随身求助 · 已选设备在线 · esp32-sos
随身求助 · 全屋在线 4/4 台设备          ← nodes 字段就是从这一行抓的
一切正常（出现 2 次） / 告警状态: 正常 / 事件时间: 无进行中事件
随身求助设备 · 在线 / 在线（本地 TCP 已连接）/ 运行状态 / 数据来源: 随身 SOS 镜像（api）
最近上报: 刚刚 · 数据来源: api / 定位：暂无定位（设备未回传有效坐标）
确认状态: 等待设备确认（手机 APP 确认后由设备回执）
客厅摄像头（固定归属 dayu200-living / 客厅）
实时状态 / 预警处置 / 统计报告
APP 版本 1.0.8 · 2026-10-27 随身求助横幅可收起/关闭
没有 SIM 卡 / 11% / 01:46
```
> 说明：`ui-last.json` 不是合法单根 JSON（`ConvertFrom-Json` 报错），只能按 `"text":"..."` 正则提取；
> 与 watcher 同款解析方式（:271）。

### 3.4 近 40 分钟是否有 app 掉线/重启/黑屏迹象
`evidence\2026-10-26-demo-autostart\runtime\demo-autostart.log` 尾部（全文 24637B，mtime 01:08:10）：
```
[2026-10-27 22:50:30 ~ 22:56:36] HDC target not connected; restarting hdc server once ...（约 20 条，历史）
[2026-10-27 22:56:44] Restoring hdc fport tcp:9001 -> tcp:9000.
[2026-10-27 22:56:50] Bringing formal app to foreground.
[2026-10-28 00:53:47] Watcher start.
[2026-10-28 00:55:12] 检测到 STALE supervisor lock PID=40628（进程已退出）、陈旧 state=HEALTHY；允许重新拉起 P0 入口
[2026-10-28 00:55:12 / 00:56:18 / 00:57:25] P0 不健康（reason=STALE_LOCK ... supervisorAlive=False workerAlive=False）；拉起既有正式 P0 入口
[2026-10-28 00:57:44] P0 不健康（WORKER_DEAD）但 supervisor 进程仍存活 PID=67276；不重复拉起，等待其自身重启/熔断恢复
[2026-10-28 01:01:01] Watcher start.
[2026-10-28 01:01:02] 检测到 STALE supervisor lock PID=67276（进程已退出）、陈旧 state=HEALTHY；允许重新拉起 P0 入口
[2026-10-28 01:01:02] P0 不健康（reason=PORTS_DOWN state=HEALTHY heartbeatAgeSec=167 supervisorAlive=False workerAlive=False）；拉起既有正式 P0 入口
[2026-10-28 01:08:10] Bringing formal app to foreground.
```
→ **01:08:10 之后 40 分钟 watcher 日志零新增**（无 P0 不健康、无 app 拉起、无 hdc 掉线）。

板端进程（`hdc shell ps -ef`，01:49 采样）：
```
root 2377/2378/2379  11:57:41  dayu_local_fall --serve 127.0.0.1:9200 ...   （PID 2379 CPU 95%，累计 CPU 13:11:03）
20010044 27321  203  42  00:00:04  ?  00:45:19  com.dsh.eldercare          （APP start 00:00:04，已跑 ~1h49m）
```
→ 演示窗内（01:01~01:49）**APP 与 inference 均无重启**。

---

## 4. 视频 / 推理真实证据

### 4.1 推理（板端 dayu_local_fall）
```
hdc shell pidof dayu_local_fall                → 2379
hdc shell netstat -lntp | grep 9200            → tcp 0 0 127.0.0.1:9200 0.0.0.0:* LISTEN 2379/dayu_local_fall
                                                 另有 ~100 条 127.0.0.1:* → 127.0.0.1:9200 TIME_WAIT（帧客户端高频短连接）
hdc shell ls -l /data/local/tmp/dayu-demo-autostart-2026-10-26/evidence
  -rw-r--r-- 202636941 2026-10-28 01:46  demo-events.jsonl     ← 202 MB，mtime 随帧前进
  -rw-r--r--       105 2026-10-27 11:57  demo-server.log       ← 仅启动 banner（"[p1b] listening 127.0.0.1:9200 ... duration=86400s"）
  -rw-r--r--      5145 2026-10-26 00:53  demo-stats.jsonl      ← 7 行，10-26 后未再写（不可当实时看板）
hdc shell wc -l .../demo-events.jsonl          → 163475（01:46:57）→ 与我方 lastEventCount 163475 对齐
hdc shell tail -n 2 .../demo-events.jsonl
  {"schema":"p1b.dayu.local.fall.event/2","source":"dayu-camera-http","deviceId":"dayu200-p1b-candidate",
   "modelId":"yolo11n-pose-ncnn-320-static-p1b","modelVersion":"p1b-2026-10-25","modelInput":[320,320],
   "frameTsMs":1793123216673,"eventTsMs":1793123217656,"dataValid":true,"personCount":1,"trackId":"t606",
   "posture":"UNKNOWN","postureConfidence":0.000,"fallState":"UNKNOWN","fall":false,...}
hdc shell tail -n 2 .../demo-stats.jsonl（历史段）
  {"...","mode":"camera-http","threads":4,"confThreshold":0.70,"elapsedSec":1320.9,
   "framesReceived":2851,"framesInferred":2022,"framesDropped":828,"errors":0,
   "inferMsP50":605.00,"inferMsP95":655.00,"inferMsAvg":610.76,...}
hdc shell tail -n 3000 events | grep -c '"fall":true'  → 0   （近 3000 事件无 fall=true）
```
事件增速（用 watcher 的 lastEventCount 三点差）：
`162814@01:39:39 → 163387@01:45:59 → 163590@01:48:12 → 163658@01:48:57`
= +203 / 133s = **1.53 事件/s**，与 stats 里 `framesInferred/elapsedSec = 2022/1320.9 = 1.53/s` 完全一致。

### 4.2 视频 relay（PID 68808，local 模式）
`evidence\2026-10-27-video-fps\relay-ip-fix.out.log`（2877B, mtime 01:31:14；`.err.log` 为 0 字节）：
```
[2026-10-27T17:16:28.835Z] INFO  video relay ready listen=0.0.0.0:9443 mode=local
[2026-10-27T17:17:14.818Z] INFO  session ticket issued ticketPrefix=77c0b9 ttlMs=60000 backendStatus=200
[2026-10-27T17:17:14.823Z] INFO  viewer joined viewer=v1 viewers=1 mode=local
[2026-10-27T17:17:14.824Z] INFO  dayu connecting host=10.127.130.132 port=9301 attempt=1
[2026-10-27T17:17:14.988Z] INFO  dayu hello proto=1 device=dayu200-living camera=320x240 cameraActive=true
[2026-10-27T17:17:15.021Z] INFO  frame source up viewers=1
[2026-10-27T17:17:15.225Z] INFO  viewer first frame viewer=v1 firstFrameAfterMs=402
[2026-10-27T17:17:26.830Z] INFO  viewer left viewer=v1 viewers=0 framesSent=40 dropped=0
[2026-10-27T17:17:28.254Z] INFO  session end viewersClosed=0 ticketsRevoked=0 verified=true backendStatus=200
[2026-10-27T17:17:29.834Z] INFO  idle stop: no viewers idleStopMs=3000
[2026-10-27T17:31:05.888Z] INFO  session ticket issued ticketPrefix=84e562 ...
[2026-10-27T17:31:06.333Z] INFO  dayu hello proto=1 device=dayu200-living camera=320x240 cameraActive=true
[2026-10-27T17:31:06.774Z] INFO  viewer first frame viewer=v2 firstFrameAfterMs=643
[2026-10-27T17:31:11.380Z] INFO  viewer left viewer=v2 viewers=0 framesSent=15 dropped=0
[2026-10-27T17:31:14.395Z] INFO  idle stop: no viewers idleStopMs=3000
```
实时健康（01:49:04 GET `http://127.0.0.1:9443/video/healthz`）：
```json
{"ok":true,"mode":"local","dayuLink":"down","framesReceived":77,"fps":0,
 "lastFrameAgeMs":1070899,"viewers":0}
```
→ 当前 `viewers=0`、`dayuLink=down` 是"无人观看 + idle stop 3000ms"的设计行为（README 明写），
`lastFrameAgeMs≈17.8min` 对应 01:31:11 最后一次会话结束。`hdc fport ls` 当前**只有** `tcp:9001→tcp:9000`，
relay 走的是板端 Wi-Fi IP `10.127.130.132:9301`，不依赖 9301 的 fport。

链路（README + 实测）：
`DAYU200 VideoStreamServer(127.0.0.1:9301, 板端相机 320x240 JPEG) →(4字节大端长度+JPEG)→ relay 9443（PC）
→ WS `/video/stream?ticket=` → APP Image 渲染`；
`deploy\video\`（compose.video.yaml / Caddyfile.video.snippet / install-on-ecs.sh）是 **ECS agent 模式**部署件，
当前跑的是 **local 模式**，即**演示视频不走公网 ECS**。

---

## 5. 告警推送链（用已发生的真实告警，不注入）

### 5.1 事件本体
板端 `/data/homemon/status.json`（01:48:18，随板端每 ~3s 刷新）：
```json
{"deviceId":"dayu200-living","room":"客厅","ts":1793123298266,"state":"ALARM",
 "sensors":{"motion":{"countToday":0,"supported":false,"reported":false,"reason":"not_configured"},
            "door":{"open":false},"climate":{"tempC":0.0,"rh":0.0,"valid":false},
            "gas":{"raw":0},"smoke":{"raw":0}},
 "monitorOnline":-1,"monitorReason":"unknown",
 "alarm":{"id":"a-1793120863-1","type":"FALL","countToday":1,"evidenceId":"fall-1793120863100-na"}}
```
`alarm.evidenceId=fall-1793120863100-na` → ts `1793120863100` = **01:07:43（本地）**。
板端 `say.log`：`2026-10-28 01:07:43  say.sh 被调用` + `aa start 结果(rc=0)` —— 告警当刻 TTS 播报成功。
本机 `supervisor\status.json`（bridge 写入，01:48:12）为同一台设备同一条 alarm（`a-1793120863-1 / FALL`）。

### 5.2 链路逐跳证据
| 跳 | 证据 |
|---|---|
| 板端 → bridge | `bridge.out.log` 首条该状态：`[2026-10-27T17:07:45.069Z] [bridge] → home/dayu200-living/status  state=ALARM room=客厅 countToday=0` |
| bridge → broker | 同上 `→ home/...` 即 publish；**该状态每 ~3s 重发**，至 01:47:51 共 **933 条**（bridge.out.log 2358 行中） |
| broker → subscriber | `broker.out.log` **最后写入停在 10-27 22:29:33**（3518B，PID 27820 是 22:29:42 启动）→ **broker 无实时逐条日志**，此跳只能间接证明 |
| worker ← broker | `[gateway] LOCAL_SUBSCRIBED topic=home/+/status`；当前会话无 REJECT |
| worker → ECS | `[cloud-sync] OK device=dayu200-living ... path=/internal/v1/device-status status=202`（30s 节流，`DEFAULT_STABLE_INTERVAL_MS=30000`） |
| ECS → APP | mirror 从 `api.luxunacc.xyz` 轮询 `polls=1076/ok=1076`；APP UI 显示「最近上报：刚刚 · 数据来源：api」 |

### 5.3 附带异常（与告警链相关的两个"看起来对/实际可疑"）
1. `bridge.err.log`（54 行，7548B，mtime 01:44:14）持续报板端 esp32-sos 状态行解析失败，最近几条：
```
[2026-10-27T17:44:14.135Z] [bridge] 状态行解析失败: {"deviceId":"esp32-sos","room":"随身求助","ts":1793123044325,"state":"NORMAL","onlin...
[2026-10-27T17:46:23.878Z] [bridge] 状态行解析失败: {"deviceId":"esp32-sos",...}
[2026-10-27T17:46:31.903Z] [bridge] 状态行解析失败: {"deviceId":"esp32-sos",...}
[2026-10-27T17:47:38.250Z] [bridge] 状态行解析失败: {"deviceId":"esp32-sos",...}
```
（同文件另有大量 `忽略板端连接上的 --relay-ignore 设备回灌：esp32-sos` —— 设计上 bridge 不接管该设备。）
2. `state=ALARM` 一直 latched（countToday=1、`monitorOnline=-1`、传感器全 0/未配置），
   而 APP UI 显示「一切正常 / 告警状态: 正常 / 无进行中事件」→ 两侧呈现不一致（见 FINDINGS 风险项）。

### 5.4 板端 homemon 连接抖动（供传输层参考，非本层结论）
`hdc shell tail -25 /data/homemon/homemon.log`（ms 级 epoch）：
```
[1793123198] TCP 客户端接入 127.0.0.1（第 6 路）
[1793123198] TCP 客户端断开（第 6 路）
[1793123212] TCP 客户端接入 127.0.0.1（第 6 路）
[1793123212] TCP 客户端断开（第 6 路）
[1793123223] TCP 客户端接入 127.0.0.1（第 6 路）
[1793123223] TCP 客户端断开（第 6 路）
... (每 ~10s 一轮，持续)
```
→ 9001 上除 3 条常连接（bridge status-tcp / bridge relay-to / mirror relay）外，还有一路
每 ~10s 建断一次的客户端，来源未定（不在本层范围，交由传输层 teammate 判）。

---

## 6. 命令清单（可复现，全部只读）
```powershell
# 健康脚本（源码已核为只读）
powershell -NoProfile -ExecutionPolicy Bypass -File <WORKSPACE>\competition\materials\public-sync-health.ps1 -JsonOnly
# 公网同步统计
Get-Content ...\public-sync-supervisor.log | Where-Object { $_ -match 'FAIL' } ...
# 云端
Resolve-DnsName api.luxunacc.xyz
(Invoke-WebRequest https://api.luxunacc.xyz/healthz -UseBasicParsing).Content
(Invoke-WebRequest http://127.0.0.1:9443/video/healthz -UseBasicParsing).Content
# 板端只读
<WORKSPACE>\tools\hdc\hdc.exe -t 450100445634303332012847942eca00 shell "pidof dayu_local_fall; netstat -lntp | grep 9200"
<WORKSPACE>\tools\hdc\hdc.exe -t 450100445634303332012847942eca00 shell "ps -ef | grep -E 'com.dsh.eldercare|dayu_local_fall'"
<WORKSPACE>\tools\hdc\hdc.exe -t 450100445634303332012847942eca00 shell "wc -l /data/local/tmp/dayu-demo-autostart-2026-10-26/evidence/demo-events.jsonl"
```
