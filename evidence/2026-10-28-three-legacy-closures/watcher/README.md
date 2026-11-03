# task-8 evidence：watcher 修复验证 + 完整启动恢复设计 + DAYU IP 漂移（2026-10-28）

范围：`competition/materials/**`、本 evidence 目录；bridge/onenet/wearable-mirror 只读。
**本任务自身没有启动/停止任何服务**；运行态变更均由用户/Lead 执行（见 §1 时间线）。
本任务只做：只读探测、临时文件测试、脚本与文档改动（均带 `.bak-20261028` 备份）、以及只读验收记录。

## 0. 状态分类（严格区分）

| 项 | 状态 | 说明 |
|---|---|---|
| watcher（demo-autostart）修复代码 | **已部署** | 22:41 修复版；本任务未改该文件（watcher 经 .cmd 自动获得 `-AutoDayuEndpoint`） |
| watcher 修复非破坏性验证 | **本地完成（29/29 PASS）** | AST 抽取真实函数 + mock Start-Process，未启动任何服务；日志 `logs/03-*` |
| watcher 现场运行 | **现场验证（最终 PID 38176）** | 01:01:01 起单实例、互斥存在；`watcher-state.json` 持续前进（01:05:20 p0=healthy / nodes=4/4 / frames=LIVE）；日志 `logs/16-*`、`logs/19-*` |
| P0 五要素判定回归 | **本地完成（6/6 PASS）** | `verify-p0-health.ps1`，日志 `logs/01-*`、`logs/16-*` |
| P0 当前进程级健康 | **现场只读验证（HEALTHY）** | 最终 supervisor 32288 / worker 60936；`public-sync-health.ps1` exit 0，日志 `logs/19-*` |
| 统一入口启动 + 异常自动恢复 | **已完成（Lead 验收 01:05）** | 01:01 正式入口启动单实例；00:55–00:57 三次 STALE_LOCK 拉起（冷却生效）；01:01 一次拉起成功；详见 §8 |
| 受控异常恢复（只 kill worker） | **现场完成（Lead 执行 00:54:30）** | `WORKER_EXIT → RESTART_IN 1000ms → WORKER_START pid=51524 → HEALTHY`，首条 202 于 16:54:34.675Z；详见 §8 |
| DAYU IP 漂移只读解析脚本 | **本地完成 + 现场只读验证** | `materials/resolve-dayu-lan-ip.ps1`，取到 wlan0=10.127.130.131 |
| 启动入口自动端点集成 | **本地完成 + 现场真实路径验证** | `-AutoDayuEndpoint`；01:01 watcher 拉起 P0 时自动选 USB fport（bridge 46720 使用 `127.0.0.1:9001`）；`-Preflight` PASS |
| bridge/mirror 目标 .131 | **Lead 已部署；现场验证为“先通后断”** | 00:27 修复并重启，dayu 202 出现后停止；根因不是 IP，而是 homemon 客户端槽位/EAGAIN，见 §4 |
| mirror relay 稳定连通 | **现场只读验证（fport 拓扑，disc=0）** | 00:48 起改走 USB fport `127.0.0.1:9001`；最终 mirror 61116 `connected=true/connects=1/disconnects=0` |
| DAYU homemon 升级（4→8 + keepalive + EAGAIN 修复） | **Lead 已部署，现场只读验证** | 板端 PID 23655、sha256 A5F355C2…（177,872 B）、启动日志“最多 8 路”；`$HomemonSha` 已同步 |
| materials 安装脚本 HAP 指向修正（1.0.0 → 1.0.10） | **本地完成 + 静态校验** | `demo_start.ps1` / `demo-preflight.js` / `device-preflight.ps1` 指向 `northbound/RELEASE.md` 的 1.0.10 signed HAP，带哈希校验；`logs/15-*` |
| mirror 纳入统一入口 | **缺口（未实现）** | `start-demo-all.cmd`/watcher 目前**不启动 mirror**；最终 mirror 61116 由 Lead 手工启动。建议见 §10 |

## 1. 现场快照（2026-10-28）

### 00:20–00:21（任务开始时）
- **无 demo-autostart watcher 进程**；`evidence/2026-10-26-demo-autostart/runtime/watcher-state.json`
  停在 `2026-10-27 23:04:30`、`watcherPid=58052`（进程已不存在），`p0=healthy / nodes=4/4` 均为陈旧值。
- P0：supervisor 40628、worker 56416、state=HEALTHY、heartbeat 新鲜（判为真健康）。
- broker 27820、bridge 48108（`--status-tcp/--relay-to=10.127.130.250:9000`）、mirror 11932
  （relay 10.127.130.250:9000）、DAYU homemon 23450、APP 1.0.10（27321）、DAYU 推理 2379。
- DAYU `wlan0` IPv4 = **10.127.130.131**；`.250:9000` 不可达 → bridge 无 dayu 状态、mirror relay ETIMEDOUT。
- hdc `fport ls` = `[Empty]`（bridge 走 LAN 直连拓扑，不依赖 fport）。

### 00:24–00:28（并行视频会话与 Lead 的修正）
- 00:24:39 上一会话强杀旧 bridge 并以 `.131` 重启（PID 60896）；00:27:19 Lead 再次重启 bridge（PID 46292），
  00:27:32 重启 mirror（PID 59300，relay=10.127.130.131:9000）。
- 00:27:39、00:28:11 supervisor 收到 `dayu200-living ... 202`；mirror 00:27:32 `relay connected`。
- 00:28:11 之后 **dayu200-living 的 202 停止**；kitchen 的 202 持续正常。
- 00:28 起 mirror relay 反复连接/断开（`connected` 在 true/false 间抖动）。

### 00:35–00:39（诊断）
- supervisor 最后一条 dayu200-living 202：`2026-10-27T16:28:11.425Z`（= 00:28:11 Asia/Shanghai）。
- mirror relay：connects=23 / disconnects=30，lastError `ECONNRESET`/`ETIMEDOUT`。
- 板端 homemon netstat：3 条来自 PC 的 **ESTABLISHED 僵尸连接**，板端 Send-Q 持续增长
  （.179:55852=116623、:55853=94881、:57067=90214），而 PC 侧这些本地端口已不存在（对应进程已退出）。
- `southbound/src/homemon.c`：`#define MAX_CLIENTS 4`；bridge 占 2 路（status+relay）、APP 占 1 路、mirror 需 1 路，
  3 条僵尸连接占满后新连接被立刻断开 → dayu 状态中断 + mirror relay 抖动。
- 证据：`logs/08-dayu-homemon-client-slot-diagnosis-003825.log`。

### 00:39–00:42（纵向采样 + 源码态核对）
- 10 次采样（每 3s）确认：板端 3 条僵尸连接 Send-Q 持续增长（55852 130949→140335、55853 109207→118593、
  57067 104540→113926，约 +988B/3s/条），PC 侧始终 0 个对应本地端口；mirror relay `connected=false` 占满窗口，
  `connects 24→25 / disconnects 33→36`；bridge 日志 `转发目标断开…连续失败 16 次`。
- 部署态 homemon（PID 23450，sha256 `f6f4497c…`）启动日志明确打印“最多 4 路客户端”= 旧二进制；
  源码 `southbound/src/homemon.c` 已由 Lead 改为 `MAX_CLIENTS 8` + keepalive（mtime 00:39:59），**待重建替换**。
- 证据：`logs/09-homemon-slot-longitudinal-003952.log`、`logs/10-homemon-deployed-vs-source-004143.log`。

### 00:41–00:52（Lead 部署源头修复 + 拓扑切回 USB fport → 恢复）
- 00:41–00:45 Lead 重建/替换 homemon：`MAX_CLIENTS 4→8` + TCP keepalive（30s/5s×3）+ `SO_SNDBUF 256KB`
  + **EAGAIN 不再杀连接**；最终 00:44:46 启动新二进制（PID 23655，177,872 B，sha256 `a5f355c2…`），
  `start-demo-supervisor.ps1` 的 `$HomemonSha` 已同步。
- 00:44 前后 PC↔DAYU Wi-Fi 直连明显劣化（TCP 建连 ~830ms/偶发超时、ARP 缺失），DAYU 本机 APP 正常。
- 00:48:15 / 00:48:29 Lead 切回 **USB hdc fport**：`hdc fport tcp:9001 tcp:9000`，
  bridge（PID 66100）与 mirror（PID 65784）改为 `--status-tcp/--relay-to/--relay-to = 127.0.0.1:9001` 并重启。
- 恢复只读验证（00:48:18Z 起）：`dayu200-living` 202 持续、kitchen 202 持续；mirror `relay connected=true`、
  `connects=1/disconnects=0`、`linesSent` 持续增长；bridge 日志 `→ home/dayu200-living/status` 正常、
  `忽略板端连接上的 --relay-ignore 设备回灌：esp32-sos`（mirror 注入生效）；DAYU 界面
  `随身求助 · 已选设备在线 · esp32-sos`、`全屋在线 3/3 台设备`、`数据来源 随身 SOS 镜像（api）`、
  `最近上报 刚刚`、`位置 暂无定位`。
- 证据：`logs/11-post-homemon-recovery-watch-004755.log`、`logs/12-recovered-state-005021.log`、
  `logs/13-keepalive-zombie-reclaim-005152.log`、`logs/14-fport-stability-watch-*.log`。
- 事实记录：`esp32-bath` 自 16:19:54Z 起无新 202、bridge 在线列表无该节点（疑似环境断电/离线，不改代码）。

### 00:53–00:59（watcher 启动 + P0 停摆/恢复；**外部事件**，非本任务启动）
- 00:53:47 用户双击 `start-demo-all.cmd` → watcher PID 63720 启动（单实例互斥生效）。
- 00:54:35–00:57:38 P0 停摆（supervisor/worker 进程退出；最后 202 = 16:54:34Z）。原因：一次 `start-demo-supervisor.ps1`
  落盘丢 UTF-8 BOM，导致 Windows PowerShell 5.1 解析中文报错、watcher 拉起的 P0 窗口直接退出（Lead 00:56 通报并恢复 BOM）。
- watcher 行为正确：00:55:12 判 `STALE_LOCK` 并拉起；00:56:18、00:57:25 按 60s 冷却再试（共 3 次，未到 6 次上限）；
  00:57:44 判 `WORKER_DEAD` 但 supervisor 活锁存在 → **不重复拉起**。
- 00:57:38 用户在新窗口输入 INGEST_KEY，supervisor 67276/worker 61132 恢复；00:58:17–00:58:20 三设备 202 恢复
  （dayu200-living、esp32-bath、esp32-kitchen；bath 亦恢复）；`watcher-state.json` 00:58:42 `p0=healthy`、`nodes=4/4`。
- 00:59:02 再次双击产生的第二个 watcher 进程被互斥识别为复用（单实例现场验证），正常退出。
- 证据：`logs/16-*`、`logs/16b-*`、`logs/17-bom-ps51-audit-and-recovery-005902.log`。
- **00:59:30–00:59:47：watcher(63720)/P0(67276/61132)/bridge(66100)/mirror(65784) 全部退出**，仅剩 broker 1883 与
  `hdc fport`；`public-sync-health.ps1` = NOT HEALTHY（BRIDGE_9101_DOWN, SUPERVISOR_STALE_LOCK）；
  外部停止（Lead 协调中），**本任务未做任何启停**；证据：`logs/18-external-stop-observation-010014.log`。
- **01:01–01:05 重新启动（正式入口 + watcher 自动拉起 P0，真实发生）**：用户 01:01:01 启动 watcher（PID 38176）；
  watcher 01:01:02 判 `STALE_LOCK`（旧 67276 已死）+ `PORTS_DOWN`，自动拉起 `start-demo-supervisor.cmd`
  （**带 `-AutoDayuEndpoint`，USB 在线自动选 fport**）；01:01:12 supervisor 32288 / 01:01:20 worker 60936 起来；
  bridge 46720（`--status-tcp/--relay-to 127.0.0.1:9001`）、mirror 61116（`--relay-to 127.0.0.1:9001`，01:03:07）。
  01:04–01:05 只读验证：`public-sync-health.ps1` HEALTHY（heartbeat 5.4s）；三设备 202 新鲜
  （dayu 17:04:58Z / kitchen 17:05:15Z / bath 17:05:15Z）；mirror `connected=true/connects=1/disconnects=0`；
  `watcher-state.json` 01:05:20 `p0=healthy / nodes=4/4 / frames=LIVE`；DAYU 界面“全屋在线 4/4 台设备”；
  bridge 单实例锁 PID=46720 一致。证据：`logs/19-post-restart-verification-010404.log`。

## 2. watcher 修复 vs 运行态差异

修复版 `materials/demo-autostart/demo-autostart.ps1`（22:41，SHA-256 `740d20bd…`）相对 `.bak-20261027` 新增
（完整 diff：`logs/05-watcher-script-diff-vs-bak-20261027.log`）：

1. `Get-P0Health` 由“只看 state.json 字符串”改为 **五要素**：1883/9101 端口 +
   supervisor PID 存活 + worker PID 存活 + `state=HEALTHY` + `heartbeatAge<=90s`，并带 `Reason`
   （`PORTS_DOWN/STALE_LOCK/SUPERVISOR_DEAD/WORKER_DEAD/CIRCUIT_OPEN/STATE_*/STALE_HEARTBEAT`）。
2. `Ensure-P0` 只把 **活锁** 当阻止条件；死 PID 的陈旧锁允许重新拉起并记 `STALE supervisor lock`。
3. 新增拉起限流：30 分钟窗口最多 6 次、两次拉起间隔 ≥60s，避免弹窗风暴。
4. 单实例互斥 `Global\DayuDemoAutostart20261026`（已有实例时打印 reuse 并退出）。
5. `watcher-state.json` 增加 `p0Reason`。

**运行态差异**：修复代码已落盘但**没有运行中的 watcher**（无进程、无互斥、`watcher-state.json` 23:04:30 陈旧），
因此当前不存在“假 HEALTHY 自动拉起”能力；watcher 缺失本身不会让 P0 进程变坏，但 P0 若退出就无人拉起。
详见 `watcher-runtime-diff.md`。

## 3. 非破坏性测试（可复现，均未启停服务）

| # | 测试 | 结果 | 日志 |
|---|---|---|---|
| 1 | `verify-p0-health.ps1`（官方回归，AST 抽取真实判定函数） | **6/6 PASS** | `logs/01-verify-p0-health.log` |
| 2 | `public-sync-health.ps1`（只读 P0 健康） | exit 0，HEALTHY；supervisor 40628 worker 56416 | `logs/02-public-sync-health.log` |
| 3 | `tests/verify-watcher-recovery.ps1`（本任务新增，29 项） | **29/29 PASS** | `logs/03-verify-watcher-recovery.log` |
| 4 | 4 个 materials PS1 AST/语法解析 + BOM + SHA-256 | 全部 PARSE_OK、BOM=True | `logs/04-ps1-ast-parse.log` |
| 5 | watcher 修复 diff（vs `.bak-20261027`） | 184 行差异，见日志 | `logs/05-watcher-script-diff-vs-bak-20261027.log` |
| 6 | `start-demo-supervisor.ps1 -Preflight -AutoDayuEndpoint` | PASS（自动端点=127.0.0.1:9001 usb-fport-pending；fport 未建为 warning；未启动任何服务） | `logs/06-supervisor-preflight-auto-endpoint.log` |
| 7 | `start-mirror-dayu.ps1` dry-run | 解析端点成功；因 mirror 已在运行 exit 4 并打印 relay 状态（不启动第二实例） | `logs/07-start-mirror-dayu-dry-run.log` |
| 8 | DAYU homemon 客户端槽位只读诊断 | 见 §4；3 条僵尸连接 + MAX_CLIENTS=4 | `logs/08-dayu-homemon-client-slot-diagnosis-003825.log` |
| 9 | mirror/bridge fport 拓扑 5 分钟稳定性观察（只读） | 21/21 采样 `connected=True`、`connects=1/disconnects=0`、fport 全程 OK；窗口跨 P0 停摆（外部事件），恢复后 202 正常 | `logs/14-fport-stability-watch-005214.log` |
| 10 | 恢复后只读回归（PS5.1） | `verify-p0-health.ps1` 6/6 PASS；`public-sync-health.ps1` exit 0（新 supervisor 67276/worker 61132） | `logs/16-*`、`logs/16b-*` |
| 11 | materials 全部 `*.ps1` BOM + **Windows PowerShell 5.1** AST 审计 | 11 个 materials ps1 全部 BOM=True、PARSE_OK；evidence 测试 ps1 同样通过；`demo-preflight.js` node --check exit 0 | `logs/17-bom-ps51-audit-and-recovery-005902.log` |

`verify-watcher-recovery.ps1` 覆盖点：P0 五要素公式/90s 心跳阈值/30min 6 次/60s 冷却/单实例名
（静态）；陈旧 state+死 PID 不得 healthy、reason=STALE_LOCK（现场形态）；活 PID+新鲜心跳为真；
worker 死→WORKER_DEAD；心跳陈旧→STALE_HEARTBEAT；Ensure-P0 的 stale lock 允许拉起 1 次、真健康不拉起、
活锁+worker 死不重复拉起、60s 冷却、61s 后可再拉起、30min 最多 6 次、`-NoP0Launch` 不拉起；
单实例用**真实子进程持有同名 Mutex** 验证复用/可用两条路径。前序用例均用 AST 从 `demo-autostart.ps1`
抽取实现（不复制），`Start-Process` 被 mock，**不会真的启动 P0 入口**。

## 4. DAYU WLAN IP 漂移：脚本、集成、现状

### 4.1 新增只读解析器 `materials/resolve-dayu-lan-ip.ps1`
- `hdc list targets -v` 找 USB Connected 的 DAYU target；
- `hdc shell ifconfig wlan0` 取 IPv4（正则兼容 `inet addr:` 与 `inet ` 两种输出）；
- 测 `<ip>:9000` 可达（DAYU 高负载时建连可能 >700ms，默认 2500ms×2 次重试）；
- 失败回退 `hdc fport tcp:9001->tcp:9000` / `127.0.0.1:9001`；
- 默认 USB 在线优先 fport（**不依赖板端 IP**），`-PreferLan` 优先 LAN；输出 JSON，exit 0/3；
- 不启动/停止服务、不创建 fport、不写文件、不读密钥。

### 4.2 启动入口集成（已改，含备份）
- `start-demo-supervisor.ps1` 新增 `-AutoDayuEndpoint`/`-PreferLanEndpoint`；显式 `-StatusTcp/-RelayTo` 优先；
  解析失败只告警并回退 `127.0.0.1:9001`，由预检继续报真实问题；本任务未回退 `$HomemonSha`
  （Lead 部署新 homemon 后已同步为 `A5F355C2…`，与板端一致）。
- `start-demo-supervisor.cmd` 默认追加 `-AutoDayuEndpoint`（watcher 的 `$P0Cmd` 指向该 .cmd，故自动生效）。
- `start-mirror-dayu.ps1`：解析端点后把 `-RelayTo` 传给 mirror 自带 start 脚本；默认 dry-run，`-Apply` 才启动。
- 文档：`materials/README.md` 新增“DAYU WLAN IP 漂移与自动端点”一节。

### 4.3 结论与恢复
- 该问题**不是** .131 目标错：bridge/mirror 指向 .131 时曾连通（00:27:39/00:28:11 有 202）。
- 根因是三层叠加：① 旧 homemon `MAX_CLIENTS=4` 被 3 条僵尸连接（旧 bridge/mirror 被强杀后残留、无 keepalive 回收）
  占满；② 旧逻辑把 `send()==EAGAIN` 当致命错误直接关连接（慢读/拥塞即被踢）；③ PC↔DAYU Wi-Fi 直连不稳定。
- Lead 已部署 homemon 新二进制（8 路 + keepalive + `SO_SNDBUF 256KB` + EAGAIN 修复，sha256 `a5f355c2…`）
  并把拓扑切回 **USB hdc fport `127.0.0.1:9001`**；bridge/mirror 重启后恢复：
  `dayu200-living` 202 持续、mirror `connected=true/connects=1/disconnects=0`、DAYU 随身求助页在线显示镜像数据。
- Wi-Fi 直连仅作 fallback；`resolve-dayu-lan-ip.ps1` 默认 USB 在线优先 fport，与本次恢复一致。
- 完整根因链、时间线、命令与防复发：`dayu-ip-drift.md` §6/§7。

## 5. 交付文件

| 文件 | 内容 |
|---|---|
| `README.md` | 本报告（状态分类、快照、测试、结论） |
| `watcher-runtime-diff.md` | 修复版代码 vs 当前运行态的逐项差异、缺失进程/互斥/陈旧状态证据 |
| `startup-recovery-runbook.md` | **完整启动恢复验收步骤**（每步命令、PID/端口/202/界面判据、异常恢复、回滚） |
| `dayu-ip-drift.md` | IP 漂移机制、新增脚本用法、bridge/mirror 参数、当前 homemon 槽位阻塞与建议 |
| `rollback.md` | 本轮所有改动的回滚步骤（脚本、备份文件、运行态注意事项） |
| `tests/verify-watcher-recovery.ps1` | 可重复运行的非破坏性判定测试（29 项） |
| `tests/capture-homemon-evidence.ps1` | 只读采集 homemon 部署态 vs 源码态证据（生成 `logs/10-*`） |
| `logs/00-*`、`logs/00b-*` | 00:24 与 00:28 只读现场快照 |
| `logs/01-*` ~ `logs/20-*` | 全部测试/诊断原始输出：01=P0 回归 02=health 03=watcher 29 项 04/04b=AST 05=diff 06=自动端点预检 07=mirror dry-run 08=槽位诊断 09=纵向采样 10=部署态vs源码 11=homemon 恢复观察 12=恢复后状态 13=keepalive/僵尸观察 14=5min fport 稳定性 15=HAP 引用静态校验 16/16b=恢复后只读回归 17=BOM/PS5.1 审计+恢复快照 18=外部停摆观察 19=重启后验证 20=10min 只读稳定性 |

## 6. 改动清单（全部带备份，UTF-8 BOM 保持不变）

| 文件 | 改动 | 备份 |
|---|---|---|
| `materials/resolve-dayu-lan-ip.ps1` | 新增只读端点解析器 | 新文件（无旧版） |
| `materials/start-demo-supervisor.ps1` | 新增 `-AutoDayuEndpoint`/`-PreferLanEndpoint` 与解析块、预检打印端点 | `.bak-20261028` |
| `materials/start-demo-supervisor.cmd` | 默认追加 `-AutoDayuEndpoint` | `.bak-20261028` |
| `materials/start-mirror-dayu.ps1` | 新增 mirror 启动封装（默认 dry-run） | 新文件（无旧版） |
| `materials/README.md` | 新脚本、自动端点、IP 漂移与 homemon 槽位提示 | `.bak-20261028` |
| `materials/demo_start.ps1` | 安装 HAP 由 1.0.0 旧包改为 `northbound/RELEASE.md` 的 1.0.10 signed HAP（B5EC606E…），安装前校验 SHA-256 | `.bak-20261028` |
| `materials/demo-preflight.js` | `signed HAP` 指向 1.0.10 signed HAP 并校验 SHA-256；unsigned HAP 改为非必需（northbound clean 后不存在） | `.bak-20261028` |
| `materials/device-preflight.ps1` | 权威制品 signed HAP 指向 1.0.10 signed HAP 并校验 SHA-256 | `.bak-20261028` |

未改：`demo-autostart.ps1`（22:41 修复版保持原样，watcher 经 .cmd 自动获得新参数）、
`public-sync-health.ps1`、`verify-p0-health.ps1`、bridge/onenet/wearable-mirror 源码、DAYU homemon 二进制
（homemon 由 Lead 部署，本任务只读验证）。

## 7. 未完成 / 阻塞 / 需 Lead 决策

1. **完整启动恢复现场执行**：已由 Lead 于 2026-10-28 01:05 验收并标记 task-8 completed（见 §8）。
   本轮未重复做的事项：未重复受控 kill worker（B1 由 Lead 在 00:54:30 完成一次）、未做 ESP32 物理拔插重连、
   未按键触发真实 SOS、未做 15min 长稳（仅 10min 只读观察，见 §12）。
2. **homemon 新二进制已部署并只读验证**（8 路 + keepalive + `SO_SNDBUF 256KB` + EAGAIN 修复，
   sha256 `a5f355c2…`，PID 23655，`$HomemonSha` 已同步）；僵尸槽位与 relay 抖动已消失
   （恢复后 mirror `connects=1/disconnects=0`）。
3. watcher 冷启动/重启场景已在 01:01 真实发生一次（STALE_LOCK → 拉起 → 用户输入 key → 恢复，见 §8）。
4. 未验证“无 USB 且仅 LAN”的 DAYU 拓扑自动解析：该拓扑下 hdc 取不到 wlan0 IPv4，需人工传
   `-StatusTcp/-RelayTo`；本次实测 Wi-Fi 直连不稳定，仅作 fallback。
5. **mirror 未纳入统一入口**（缺口，见 §10）：当前启动 `start-demo-all` 不会拉起 mirror，需手工/Lead 启动。
6. 执行验收前请先看 `startup-recovery-runbook.md` §0/§0.5 前置条件（homemon 哈希、INGEST_KEY 人工输入、
   无视频会话冲突、fport 可用）。
7. **写盘硬规则**：任何 `.ps1` 必须 UTF-8 BOM + Windows PowerShell 5.1 AST 解析通过才允许落盘（见 §9）。

## 8. 最终验收现场（Lead 验收，2026-10-28 01:05）

| 组件 | 最终值（只读取证） |
|---|---|
| watcher | PID 38176；`watcher-state.json` 01:05:20：`p0=healthy / p0Reason=HEALTHY / targetConnected=true / app=present / inference=running / cameraFrames=LIVE / nodes=4/4 / watcherPid=38176` |
| broker | PID 27820 `mqtt_broker.js 1883`，单实例 |
| bridge | PID 46720；`--broker 127.0.0.1:1883 --status-tcp 127.0.0.1:9001 --relay-to 127.0.0.1:9001 --relay-ignore esp32-sos`；`bridge.lock`=46720；9101 LISTEN |
| P0 supervisor / worker | PID 32288 / 60936，state=HEALTHY；`public-sync-health.ps1` exit 0（heartbeat <30s） |
| mirror | PID 61116；`--relay-to 127.0.0.1:9001`；`connected=true, connects=1, disconnects=0`；phase=NORMAL/ACKED 随事件 |
| homemon | DAYU PID 23655；sha256 `A5F355C2D5E9F4E7330282F1856411927EB54AD743B5ACB7C599BE7C2D6ED9EA`（177,872 B）；启动日志“最多 8 路客户端”；`$HomemonSha` 已同步 |
| hdc fport | `450100445634303332012847942eca00  tcp:9001 tcp:9000 [Forward]` |
| P0 202 | dayu200-living、esp32-kitchen、esp32-bath 均有新 `status=202`（01:04–01:05 窗口内，如 dayu 17:04:58Z、kitchen 17:05:15Z、bath 17:05:15Z） |
| 公网/APP | Lead 记录 API 4 台设备 online；DAYU 界面“全屋在线 4/4 台设备”，随身求助卡“在线 / 正常 / 暂无定位 / 等待设备确认 / 来源 mirror” |

### 8.1 受控异常恢复证据（B1，Lead 执行 00:54:30；日志时间戳为准）

```
2026-10-27T16:54:30.861Z [supervisor] WORKER_EXIT code=4294967295 signal=null durationMs=6348150
2026-10-27T16:54:30.867Z [supervisor] RESTART_IN 1000ms restartCount=1
2026-10-27T16:54:31.895Z [supervisor] WORKER_START pid=51524
2026-10-27T16:54:32.136Z [supervisor] HEALTHY pid=51524
2026-10-27T16:54:34.675Z [worker:stdout] [cloud-sync] OK device=dayu200-living ... status=202
2026-10-27T16:54:35.947Z [worker:stdout] [cloud-sync] OK device=esp32-kitchen ... status=202
```

即：**只 kill worker，supervisor 在 ~1s 内自动重启新 worker（51524），~4s 内恢复 202**；broker/bridge/supervisor 全程未动。
（Lead 记录“19s 自动重启”为观测口径差异，日志实测为 RESTART_IN 1000ms；以日志为准。）

### 8.2 异常退出自动恢复证据（P0 整体停摆 → watcher 拉起）

- 00:54:35–00:57:38 P0 停摆（外部事件：一次 `start-demo-supervisor.ps1` 落盘丢 BOM，PS5.1 解析失败，见 §9）。
- watcher 日志：`00:55:12` 判 `STALE_LOCK`、`00:56:18`（heartbeatAgeSec=95）、`00:57:25`（161）各再拉一次
  （**60s 冷却生效，30min 内 3 次，远低于 6 次上限**）；`00:57:44` 判 `WORKER_DEAD` 但 supervisor 活锁存在 →
  **不重复拉起**。
- 00:57:38 用户在新窗口输入 INGEST_KEY，新 supervisor `STALE_LOCK_TAKEOVER dead_pid=40628` → HEALTHY；
  00:58:17–00:58:20 三设备 202 恢复。
- 01:01:01 用户经正式入口 `start-demo-all.cmd` 启动 watcher（PID 38176）；`01:01:02` watcher 判
  `STALE_LOCK`（旧 67276 已死）+`PORTS_DOWN`，自动拉起 `start-demo-supervisor.cmd`（带 `-AutoDayuEndpoint`，
  USB 在线自动选 fport）；01:01:12 supervisor 32288、01:01:20 worker 60936 HEALTHY；bridge 46720/mirror 61116 就位。
  **一次拉起成功，单实例。**

### 8.3 本轮明确未做（不得写成已验收）

- 未重复受控 kill worker（B1 已由 Lead 在 00:54:30 做一次，见 8.1）；
- 未做 ESP32 厨房/卫生间物理拔插重连；
- 未按键触发真实 SOS（`sos-12-1a1003dc` 为用户真实按键事件，Lead 确认，本轮未 ACK/未伪造）；
- 未做 15min 长稳；仅 10min 只读观察（§12）。

## 9. BOM 事故与写盘硬规则（**强制**）

### 9.1 已发生的事故
- 00:54:35–00:57:38 P0 停摆：一次 `start-demo-supervisor.ps1` 落盘丢失 UTF-8 BOM，
  Windows PowerShell 5.1 读取中文报解析错误，watcher 弹出的 P0 窗口直接退出。
- Lead 00:56 恢复 BOM 后，00:57:38 新 supervisor 接管 stale lock 恢复；事件未造成数据/设备损坏。
- 教训：**PowerShell 7 能跑 ≠ Windows PowerShell 5.1 能跑**；`node --check`/文本编辑器的“UTF-8”不等于带 BOM。

### 9.2 硬规则（任何脚本落盘前必须全部满足）
1. 所有 `.ps1`/`.psm1`/`.psd1` 必须保存为 **UTF-8 with BOM**（首 3 字节 `EF BB BF`）；
   禁止交付无 BOM 的 PowerShell 脚本。`.cmd/.bat` 保持 ASCII/CRLF，无需 BOM。
2. 落盘前必须用 **Windows PowerShell 5.1**（`powershell.exe`，不是 `pwsh`）做 AST 解析并全绿：
   `[System.Management.Automation.Language.Parser]::ParseFile(path,[ref]$t,[ref]$e)`，`$e.Count -eq 0`。
3. 统一流程：**先备份 `.bak-20261028` → 带 BOM 写入 → 立即重加/确认 BOM → PS5.1 AST 解析 →
   记录 BOM/sha256 → 才允许交付**。编辑工具可能丢 BOM，写后必须复核首 3 字节。
4. 同一文件不要连续改写；改完一个文件立即校验，不要批量改完再验。
5. 新增/修改的测试脚本（含 `evidence/**`）同样适用。
6. `.js` 用 `node --check`；涉及 PowerShell 5.1 的脚本不得只用 `pwsh` 或 `powershell -Command` 的引号转义来“验证”。
7. 现有审计结果：`logs/17-bom-ps51-audit-and-recovery-005902.log`（11 个 materials ps1 + evidence 2 个 ps1 全 BOM=True/PARSE_OK）。
8. 违反后果已实证：watcher 拉起的 P0 窗口解析失败退出、P0 停摆。**任何“顺手改一下”都必须走上述流程。**

## 10. 统一入口缺口：mirror 未纳入 `start-demo-all`（建议）

- 现状：watcher + P0 entry 覆盖 broker/bridge/homemon/fport/APP/推理/public-sync；
  **mirror 不在统一入口内**，最终 mirror 61116 由 Lead 手工启动；`watcher-state.json` 也不含 mirror 状态。
- 风险：PC/入口重启后若忘记起 mirror，DAYU 随身求助卡长期无数据；mirror 被强杀无人拉起；
  手工重复启动（mirror 自带 lock 会拒绝，但 watcher 不知情）。
- 建议（Lead 决定，本轮未实现；不改 materials）：
  1. 在 `materials/start-mirror-dayu.ps1`（已存在，默认 dry-run、单实例、自动解析端点）基础上，
     由 `start-demo-all.cmd` 在 watcher 启动后再 `-Apply` 起 mirror；或 watcher 增加 `Ensure-Mirror`
     （读 mirror-status.json/pid/lock，5min 冷却，失败告警，不重复启动）。
  2. `watcher-state.json` 增加 mirror 字段（pid / connected / phase）；状态行显示。
  3. 顺序：**bridge 必须已带 `--relay-ignore esp32-sos` 运行，再起 mirror relay 注入**（历史 R6 缺陷）。
  4. 凭据：沿用 mirror 现有 secrets/guardian 文件与隐藏输入，不写入脚本/日志。
  5. 停止语义：watcher 的 S/Q 只影响自身看护；mirror 停止用 mirror 自带 `stop-mirror.ps1`。
- 未纳入前：PC 冷启动验收必须把“手工起 mirror → `relay connected` → DAYU 随身求助在线”列为必查项
  （runbook 阶段 D 已列）。

## 11. 回滚（最终）

| 对象 | 回滚方式 |
|---|---|
| 本轮改动的 materials 脚本 | 复制对应 `.bak-20261028` 回原文件名；恢复后必须重跑 BOM + PS5.1 AST（§9）；详见 `rollback.md` |
| 新增脚本/文档 | `resolve-dayu-lan-ip.ps1`、`start-mirror-dayu.ps1` 可直接删除（先确认无引用）；materials README 用 `.bak-20261028` |
| DAYU homemon | 板端备份 `/data/homemon/homemon.rollback-20261028-0045`（f6f4497c…，4 路）与 `-2257`（0d2435…）；替换后**必须同步 `$HomemonSha`**（否则 P0 预检拒绝） |
| HAP | 当前安装 1.0.10 signed = `evidence/2026-10-27-video-fps/dayu-video-fps-1.0.10-signed.hap`（B5EC606E…）；1.0.8/1.0.6/1.0.5/1.0.0 见 `northbound/RELEASE.md` 回滚表；materials 三脚本已改指 1.0.10，不会再装回 1.0.0 |
| 运行态 | 不按历史 PID 杀；只停本轮对应 PID（bridge/mirror 各自单实例锁），broker/P0 分开处理；拓扑保持 fport（`hdc fport tcp:9001 tcp:9000`） |
| 证据 | 不删除历史 logs/`.bak-*`/告警；回滚后把校验结果追加到本目录 `logs/` |

## 12. 10 分钟只读稳定性观察（Lead 要求）

- 文件：`logs/20-stability-010612.log`（01:06:12–01:16:20，每 2 分钟，共 6 个采样点）。
- 结论：**10 分钟无异常（PASS）**。6/6 采样：
  - `public-sync-health.ps1` 全部 `exit=0`、`HEALTHY`；
  - `watcher-state.json` 全部 `p0=healthy`、`watcherPid=38176` 不变；1 个采样点 `nodes` 字段短暂为空字符串
    （01:08:14，UI dump 读时序，下一次即回 4/4），其余 5 个采样 `nodes=4/4`；
  - 三设备 202 持续前进（dayu/kitchen/bath 每个采样点均有新时间戳，间隔约 2 分钟正常限频）；
  - mirror `connected=True`、`connects=1`、`disconnects=0`、phase=NORMAL 全程不变。
- 未观察到既有异常；观察期间未写 materials、未动任何进程。
