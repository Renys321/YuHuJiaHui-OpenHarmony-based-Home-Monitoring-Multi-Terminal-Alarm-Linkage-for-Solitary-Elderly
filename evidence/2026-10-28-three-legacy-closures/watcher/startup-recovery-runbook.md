# 完整启动恢复验收 Runbook（Lead 说 “go” 后执行）

版本：2026-10-28 00:45（Asia/Shanghai）。适用现场：PC 网关（broker 1883 / bridge 9101 / P0 public-sync）+ DAYU200
（homemon 9000、APP com.dsh.eldercare、推理 9200）+ 随身 SOS mirror + 两块 ESP32 房间节点。
**本文件是设计，不是已执行记录。** 执行时逐项当场记录时间、PID、端口、202、界面文本；不得用历史 PID 推断现状。

---

## 0. 前置条件与边界（缺一不可）

| # | 条件 | 判定/动作 |
|---|---|---|
| P1 | Lead 已部署 DAYU homemon 新二进制（MAX_CLIENTS=8 + TCP keepalive + EAGAIN 修复）并**同步更新** `start-demo-supervisor.ps1` 的 `$HomemonSha` | **已满足（00:41–00:52）**：板端 sha256=A5F355C2…，`$HomemonSha` 已同步。执行前再跑一次两边 sha256 对比 |
| P2 | 用户在场，可在 P0 可见窗口**隐藏输入一次 INGEST_KEY** | 不记录、不复述、不写文件；本 runbook 任何命令不得包含 key |
| P3 | 无并行视频/验收会话占用 DAYU 相机；`Get-NetTCPConnection -LocalPort 9443` 无他人会话 | 有冲突则暂停并报告 Lead |
| P4 | 已备份/记录当前现场：bridge/mirror cmdline、supervisor state、watcher-state、各 PID | 见阶段 A |
| P5 | 明确本轮允许的停止范围：**默认只允许 kill public-sync worker；P0 supervisor/broker/bridge 与 mirror 的停止/重启逐项由 Lead 批准** | 记录批准时间与批准人 |

> 禁止：按历史 PID 杀进程、杀 broker/bridge 来做“恢复”、伪造 202/告警、ACK 用户未要求处置的告警、
> 在用户暂停监护时反向拉起、清空 APP 数据、改 DAYU homemon 二进制以外的源码/配置。

---

## 0.5 本轮已完成的运行态修正（2026-10-28 00:41–00:52，Lead 执行；执行验收前先核对）

| 变更 | 结果 | 证据 |
|---|---|---|
| DAYU homemon 升级：`MAX_CLIENTS 4→8` + TCP keepalive（30s/5s×3）+ `SO_SNDBUF 256KB` + EAGAIN 不再杀连接 | 已部署 PID 23655，板端 sha256 **A5F355C2D5E9F4E7330282F1856411927EB54AD743B5ACB7C599BE7C2D6ED9EA**（177,872 B）；启动日志“最多 8 路客户端” | `logs/10-*`、`logs/12-*`、`logs/13-*` |
| `start-demo-supervisor.ps1` 的 `$HomemonSha` | Lead 已更新为上述 A5F355C2（与本任务脚本改动不冲突） | `logs/11-*` 头部 |
| 拓扑切回 **USB hdc fport**：PC↔DAYU Wi-Fi 直连（10.127.130.131:9000）不稳定（建连 ~830ms/偶发超时、ARP 缺失） | 已 `hdc fport tcp:9001 tcp:9000`；bridge（PID 66100）与 mirror（PID 65784）均改为 `127.0.0.1:9001` 并重启 | `logs/12-*`（fport=OK、bridge/mirror cmdline） |
| 恢复结果（00:48–00:51 只读验证） | `dayu200-living` 202 恢复（16:48:18Z 起持续）；kitchen 202 持续；mirror `relay connected=true`、`connects=1/disconnects=0`；bridge 日志出现 `→ home/dayu200-living/status` 与 `忽略板端连接上的 --relay-ignore 设备回灌：esp32-sos`；DAYU 界面“随身求助 · 已选设备在线 / 数据来源 随身 SOS 镜像（api）/ 最近上报 刚刚 / 位置 暂无定位”“全屋在线 3/3 台设备” | `logs/11-*`、`logs/12-*` |
| `esp32-bath` | 自 16:19:54Z 起无新 202；后续 01:05 前已恢复（bath 202 新值）。记录事实，不改代码 | `logs/12-*`、`logs/19-*` |
| 最终验收（Lead 01:05） | watcher 38176 / bridge 46720 / supervisor 32288 / worker 60936 / mirror 61116；三设备 202 新值；DAYU 4/4；详见 `README.md` §8 | `logs/19-*` |
| BOM 硬规则（事故后新增） | 任何 `.ps1` 必须 UTF-8 BOM + **Windows PowerShell 5.1** AST 全绿才允许落盘；详见 `README.md` §9 | `logs/17-*` |

> 因此本 runbook 的默认拓扑是 **USB fport（127.0.0.1:9001）**；Wi-Fi 直连只作为 fallback
> （`resolve-dayu-lan-ip.ps1` 默认也是 USB 在线优先 fport）。`-AutoDayuEndpoint` 在 USB 在线时会自动选 fport，
> 与本次恢复一致；若走 fport，请确认 `hdc fport tcp:9001 tcp:9000` 存在或由 P0 入口创建。

---

## 1. 阶段 A：基线只读快照（先做，不改任何状态）

```powershell
$ev='<WORKSPACE>\competition\evidence\2026-10-28-three-legacy-closures\watcher'
$stamp=Get-Date -Format 'yyyyMMdd-HHmmss'
powershell -NoProfile -ExecutionPolicy Bypass -File <WORKSPACE>\competition\materials\public-sync-health.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File <WORKSPACE>\competition\materials\resolve-dayu-lan-ip.ps1
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'mqtt_broker|mqtt_bridge|public-sync|wearable-mirror' } |
  Select-Object ProcessId,CreationDate,CommandLine | Format-List
Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -in 1883,9001,9101,9002,9200,9301 } |
  Select-Object LocalAddress,LocalPort,OwningProcess
& 'D:\DevEcoStudio\DevEco Studio\sdk\default\openharmony\toolchains\hdc.exe' -t 450100445634303332012847942eca00 shell 'pidof homemon; pidof com.dsh.eldercare; pidof dayu_local_fall'
Get-Content <WORKSPACE>\competition\bridge\_test\current-runtime\supervisor\public-sync-supervisor.state.json -Raw
Get-Content <WORKSPACE>\competition\evidence\2026-10-26-demo-autostart\runtime\watcher-state.json -Raw
Get-Content <WORKSPACE>\competition\cloud\wearable-mirror\runtime\mirror-status.json -Raw
```

记录到 `logs/A-baseline-$stamp.log`。基线必须包含：每设备最后一条 202（`device=`、`status=202`、时间）、
bridge/mirror 的 `--status-tcp/--relay-to/--relay` 目标、hdc `fport ls`、DAYU `ifconfig wlan0` IPv4、
watcher 是否有进程/互斥（`Get-Process`、`[System.Threading.Mutex]::OpenExisting('Global\DayuDemoAutostart20261026')`）。

---

## 2. 阶段 B：P0 异常自愈（先做不依赖 INGEST_KEY 的受控 kill worker）

### B1. 只杀 worker（**不杀 broker/bridge/P0 supervisor**）

> **执行结果（2026-10-28 00:54:30，Lead 执行，已 PASS）**：supervisor 日志
> `16:54:30.861Z WORKER_EXIT` → `16:54:30.867Z RESTART_IN 1000ms restartCount=1` →
> `16:54:31.895Z WORKER_START pid=51524` → `16:54:32.136Z HEALTHY pid=51524`；
> 首条 `dayu200-living status=202` 于 `16:54:34.675Z`（kill 后约 4s）。broker/bridge/supervisor 未动。
> 该结果已作为 task-8 B1 证据（`../watcher/README.md` §8.1）。

```powershell
$state = Get-Content <WORKSPACE>\competition\bridge\_test\current-runtime\supervisor\public-sync-supervisor.state.json -Raw | ConvertFrom-Json
$workerPid = [int]$state.workerPid
# 校验确实是 supervisor 的子 worker，再杀
Get-CimInstance Win32_Process -Filter "ProcessId=$workerPid" | Select-Object ProcessId,ParentProcessId,CommandLine
Stop-Process -Id $workerPid
```

**判定（全部满足才算 PASS）**
1. ≤60s 内出现新 worker PID：`state.workerPid` 变化、`restartCount` +1、`state=HEALTHY`、心跳前进；
2. supervisor 日志出现 `WORKER_EXIT` 与重启记录，**没有** `CIRCUIT_OPEN` 长时间挂起；
3. 202 不中断：kill 后 ≤2min 内至少 kitchen/bath/dayu 中在线设备出现新 `status=202`；
4. 记录时间线：kill 时刻 → 新 worker PID/时间 → 首条 202 时刻。

### B2.（可选，Lead 批准）验证 watcher 能拉起整个 P0

前提：watcher 已运行（阶段 C），或先确认它未运行再手工起 watcher 步骤。
受控停止 supervisor+worker（**不动 broker/bridge**）后，watcher 应在下一轮（≤数秒）判定
`SUPERVISOR_DEAD/STALE_LOCK`（lock PID 已死）并按五要素/冷却规则弹出 `start-demo-supervisor.cmd` 窗口：

- 用户在弹出窗口隐藏输入 INGEST_KEY（一次性）；
- 新 supervisor 接管 stale lock，`public-sync-health.ps1` 回 exit 0；
- watcher 日志含 “检测到 STALE supervisor lock … 允许重新拉起 P0 入口”，`watcher-state.json` 的
  `p0Reason` 从陈旧原因回到 HEALTHY；
- 30 分钟内最多 6 次拉起、两次间隔 ≥60s 的限制真实生效（若连续失败，观察 `launch-capped` 日志，不强行绕过）。

> 若 Lead 选择“只验证 worker 自愈、不验证 watcher 拉起整个 P0”，B2 记为 NOT TESTED，不得写成 PASS。

---

## 3. 阶段 C：正式统一入口启动（watcher）

执行：**只双击一次** `<WORKSPACE>\competition\materials\start-demo-all.cmd`（由 Lead/用户操作，AI 不代按）。

**验收判据**
| 项 | 判据 |
|---|---|
| 单实例 | 第二次双击输出 “An existing demo-autostart watcher is running. Reusing it…” 后退出；`Get-Process` 中 watcher 只有 1 个 |
| 互斥存在 | `Global\DayuDemoAutostart20261026` 可 OpenExisting |
| 状态文件前进 | `evidence/2026-10-26-demo-autostart/runtime/watcher-state.json` 的 `timestamp` 每 ~2s 更新，`watcherPid` 为当前 |
| P0 复用 | `p0=healthy`、`p0Reason=HEALTHY`；不出现第二个 supervisor；`public-sync-health.ps1` exit 0 |
| DAYU 链 | `target=OK`、`app=present/active`、`detect=running`、`frames=LIVE`（或 `WAIT-FRAMES` 且日志在推进）、`nodes` 按真实在线数 |
| 无假拉起 | `demo-autostart.log` 中没有 30min 内反复拉起、没有 `launch-capped` |
| 用户状态 | `userStop=false`、`userPaused=false`（用户此前暂停则必须尊重，不得强制恢复） |

> fport：watcher 的 `Ensure-Fport` 会创建 `tcp:9001 -> tcp:9000`。若 bridge 已在跑 LAN 直连拓扑，
> 创建 fport 不影响 LAN 直连，但会改变“下一次 P0 冷启动”的默认拓扑（`-AutoDayuEndpoint` USB 在线优先 fport）。
> 记录 `hdc fport ls` 变化与 bridge 是否被重建。

---

## 4. 阶段 D：逐组件记录表（每次验收都填）

| 组件 | 命令/来源 | 必须记录 | 判定 |
|---|---|---|---|
| Broker 1883 | `Get-NetTCPConnection -LocalPort 1883 -State Listen` | PID、启停时间 | LISTEN + 进程存活 |
| Bridge 9101 | `Get-NetTCPConnection -LocalPort 9101 -State Listen`；cmdline | PID、`--status-tcp/--relay-to/--relay-ignore` | LISTEN；目标为自动解析端点或显式端点；单实例锁 PID 一致 |
| P0 supervisor | `public-sync-health.ps1`；state.json | PID、state、heartbeatAgeMs、restartCount | healthy=true，heartbeat<90s |
| P0 worker | state.json `workerPid`；`Get-Process` | PID、存活 | 存活且为 supervisor 子进程 |
| public-sync 202 | `public-sync-supervisor.log` 中 `cloud-sync ... status=202` | 每设备最后一条时间 | 在线设备 ≤2min 内有新 202；离线设备如实记录 |
| DAYU homemon | `hdc shell pidof homemon; netstat -lntp \| grep 9000` | PID、sha256、启动日志“最多 N 路客户端” | 新二进制 8 路 + keepalive；连接不持续堆积僵尸 |
| hdc fport | `hdc fport ls` | 规则与时间 | 存在 `tcp:9001 -> tcp:9000`（USB 拓扑）；或记录 LAN 直连拓扑 |
| APP | `hdc shell pidof com.dsh.eldercare; bm dump -n com.dsh.eldercare \| grep versionName` | PID、版本 | 运行；版本=当前交付版（本轮 1.0.10，后续以 Lead 通知为准） |
| 推理 | `pidof dayu_local_fall; netstat 9200` | PID、9200 监听 | 运行且 9200 LISTEN；`demo-events.jsonl` 行数增长 |
| mirror | `runtime\mirror-status.json` | pid、phase、online、relay.target、transports[0].connected/connects/disconnects | relay `connected=true` 且 **10 分钟不抖**；hasData=true；不伪造 ACK |
| DAYU 界面 | `uitest dumpLayout` 抓文本 | “全屋在线 N/N 台设备”、错误/暂停文案、SOS 卡片 | 与真实设备数一致；无 PIR 客厅显示“未配置”而非“长时间无活动” |

**202 判定细则**：`status=202` + 该设备 `ts` 前进 + 时间在观察窗内。`HEALTHY`、端口监听、`/healthz` 都不能单独作为 202 证据。

---

## 5. 阶段 E：ESP32 重连后 APP/DAYU 恢复（需用户/Lead 决定是否物理动设备）

1. 记录重连前：bridge 日志最后 `无线节点接入并完成身份绑定`、MQTT 最后 `home/<id>/status`、APP/DAYU 在线数。
2. 受控重连（拔电/上电或无线调试复位，**不刷固件、不改 Wi-Fi**；时间点由用户执行并告知）。
3. 判定：
   - bridge 日志出现该 `deviceId` 的 `无线节点接入并完成身份绑定`，无重复退休；
   - MQTT `home/esp32-kitchen/status`、`home/esp32-bath/status` 出现新 `ts`（`mqtt_tool.js sub` 只读 15s 观察，不发布）；
   - P0 出现该设备的 `status=202`；
   - DAYU 界面在线数按真实增加；APP 自动刷新（不是旧值标成实时）；
   - 异常退出/失败如实记录，不手工补 202。

## 6. 阶段 F：随身 SOS 镜像（真事件，不伪造）

- 事件由用户真实按键产生；**不代按、不代 ACK、不伪造 GPS**。记录 `alarmId`、事件时间、APP/API 状态。
- 判定：
  1. mirror 日志出现对应 `alarm=<alarmId>` 的 `emit(change)`，`relay connected=true`；
  2. bridge/ homemon 侧不接受伪状态；DAYU APP 出现“随身求助”横幅/卡片（来源、事件时间、状态、GPS 状态、ACK 状态），
     且 `alarmId` 与公网 API/APP 一致；
  3. 用户在实际 APP 执行 ACK 后：设备回执 → mirror 显示 ACKED（只有真实设备回执才显示“已确认”）；
  4. relay 连接持续 ≥10min 无抖动（homemon 新二进制验证点）。
- 若 relay 仍抖动/断连：记录 `connects/disconnects/lastError` 与板端 `netstat`，停止验收并报告 Lead（不重启 homemon 以外的进程）。

## 7. 阶段 G：DAYU IP 漂移复验

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File <WORKSPACE>\competition\materials\resolve-dayu-lan-ip.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File <WORKSPACE>\competition\materials\resolve-dayu-lan-ip.ps1 -JsonOnly
```

- 记录 `wlan0Ip/endpoint/method/requiresFportCreate`；
- 对比 bridge/mirror 实际目标：应等于解析 endpoint，或 fport 拓扑下为 `127.0.0.1:9001`；
- 若 IP 再次漂移：按 `dayu-ip-drift.md` 的“只重启 bridge（不动 broker/P0）”或由 Lead 重启 mirror 的顺序处理；
- 不把 IP 写进任何脚本常量（正式入口已 `-AutoDayuEndpoint`）。

## 8. 阶段 H：收尾与留证

1. 记录所有进程 PID/端口/启动时间、每设备最后 202、DAYU 界面文本/截图路径；
2. 15 分钟稳定性窗口：每 5min 复查一次 health + 202 + mirror connected + watcher-state；
3. 证据写入 `logs/`，并更新本目录 README 的状态分类（本地完成 / 已部署 / 现场验证 / 受阻）；
4. 若临时制造过 stale lock/kill，确认已恢复为健康单实例，删除任何临时文件/锁（不删历史证据）。

## 9. 回滚

见 `rollback.md`：脚本改动回滚 = 复制 `.bak-20261028` 回原文件名（保留 BOM）；运行态回滚 = 停止本轮由正式入口新建的
进程后再按备份 cmdline 启动（broker/bridge/supervisor/worker 分开操作）。**不按历史 PID 杀进程；不删历史告警/证据。**

## 10. 判据汇总（PASS 的最小集合）

- [ ] watcher 单实例 + 状态文件持续前进 + P0 五要素 healthy
- [ ] P0 worker 受控 kill 后自动恢复且 202 不断（B1）
- [ ] dayu200-living / esp32-kitchen / esp32-bath 中在线设备均有新 202（离线如实标注）
- [ ] DAYU 界面在线数与真实一致、无“未配置 PIR 当无活动”回归
- [ ] mirror relay connected 且 ≥10min 稳定；真实 SOS 可显示、ACK 状态正确
- [ ] IP 漂移后端点自动解析且 bridge/mirror 目标正确
- [ ] 全程无 INGEST_KEY 落盘/打印；无伪造 202/告警；未 ACK 用户未要求的告警

**不可宣称**：仅凭 `HEALTHY`/端口监听/单条旧日志宣称端到端 PASS；把 MOCK 测试当真实链路验收；
把历史 PID/历史 202 当本轮结果。
