# watcher 修复版 vs 当前运行态差异（2026-10-28 00:20–00:40 只读）

脚本：`competition/materials/demo-autostart/demo-autostart.ps1`
- 当前版本：24,170 B，mtime 2026-10-27 22:41:04，SHA-256 `740d20bd035ef9c754931fcdb9548b4d1686b74762072d00893544b2f7b65f83`，UTF-8 BOM，AST 解析通过。
- 备份对比版：`demo-autostart.ps1.bak-20261027`（19,510 B，10-26 旧版）。
- 差异全文：`logs/05-watcher-script-diff-vs-bak-20261027.log`（184 行）。

## 1. 代码上修复了什么（22:41 版）

| # | 位置 | 修复 |
|---|---|---|
| 1 | `Get-P0Health` | 由“state.json 字符串=HEALTHY 即健康”改为五要素：1883/9101 listening + supervisor PID 存活 + worker PID 存活 + state=HEALTHY + heartbeatAge≤90s；新增 `Reason`（PORTS_DOWN/STALE_LOCK/SUPERVISOR_DEAD/WORKER_DEAD/CIRCUIT_OPEN/STATE_*/STALE_HEARTBEAT） |
| 2 | `Ensure-P0` | 只有**活锁**（PID 真实存活）才阻止拉起；死 PID 的陈旧 lock 允许入口重新接管，并记 `STALE supervisor lock` 日志（2026-10-27 事故的直接锁死点之一） |
| 3 | `Ensure-P0` | 30 分钟窗口最多 6 次自动拉起、两次拉起间隔 ≥60s，避免 INGEST_KEY 弹窗风暴；状态文件新增 `p0Reason` |
| 4 | 单实例 | `Global\DayuDemoAutostart20261026` 互斥；已有 watcher 时打印 reuse 并退出（`Start-Sleep 6`） |
| 5 | 新增函数 | `Test-PidAlive` / `Read-P0State` / `Read-P0LockPid`（供判定与测试复用） |

## 2. 运行态（00:20–00:40 实测）

| 检查 | 结果 |
|---|---|
| `Get-Process -Id 58052`（state 里的 `watcherPid`） | 不存在 |
| 全局互斥 `Global\DayuDemoAutostart20261026` | 不存在（`Mutex.OpenExisting` 失败） |
| `evidence/2026-10-26-demo-autostart/runtime/watcher-state.json` | mtime **2026-10-27 23:04:30**，内容 `p0=healthy / app=present / inference=running / cameraFrames=LIVE / nodes=4/4 / watcherPid=58052` —— **陈旧快照**，不代表当前状态 |
| `demo-autostart.log` 末行 | `2026-10-27 22:56:50 Bringing formal app to foreground.`；22:43–22:56 期间持续 `HDC target not connected; restarting hdc server once` |
| 结论 | **修复代码已落盘但无运行实例**：watcher 的判定/拉起能力当前不生效；不是“旧缺陷还在运行”，而是“看护器根本没在跑” |

### 若现在双击 `start-demo-all.cmd` 会发生什么（静态推演，未执行）
1. watcher 取得互斥、进入 2s 循环；
2. `Get-P0Health`：1883/9101 在听、supervisor 40628/worker 56416 存活、state=HEALTHY、心跳新鲜 → `healthy`，**不会重复拉起 P0**；
3. `Ensure-Hdc` → USB target 在线；`Ensure-Homemon` → DAYU homemon 23450 在跑；`Ensure-Fport` → 当前 `fport ls` 为空，
   watcher 会创建 `tcp:9001 -> tcp:9000`（**这是运行态变化点**，需 Lead 授权后才执行）；
4. `Ensure-App`/`Ensure-Inference` → APP 27321、推理 2379 已在跑且 9200 监听（当前 inference 归上一会话/用户启动，
   watcher 只在 `pidof dayu_local_fall` 的 exe 指向自身部署目录时接管，不会误杀未知推理进程）；
5. 之后每 2s 写 `watcher-state.json`，每 5s 打印状态行。

即：**watcher 本身能安全复用当前健康 P0**；但它不能修复“dayu200-living 202 中断 / mirror relay 抖动”
这类**进程级健康之外的业务链路问题**（`public-sync-health.ps1` 只看 supervisor/worker/心跳）。

## 3. 与本次事故的关系

| 2026-10-27 16:25 事故链 | 当前（10-28 00:20） |
|---|---|
| supervisor+worker 被杀、state 停在 HEALTHY、lock 死 PID | P0 真进程在、state 真新鲜；**watcher 缺失** |
| 旧 watcher 永远不拉起（假健康 + 一直 Test-Path 锁） | 新 watcher 具备拉起能力，但未运行 → 仍无人拉起 |
| 结论 | 代码缺陷已修复；**运行态缺口是“没启动 watcher”**。是否启动由 Lead 在统一时间窗决定（见 `startup-recovery-runbook.md`） |

## 4. 边界与未验证项

- 本轮没有启动 watcher，因此没有做 15 分钟稳定性/冷启动验证；`verify-watcher-recovery.ps1` 只验证判定与拉起决策（29/29）。
- 拉起 P0 入口需要用户在可见窗口输入 INGEST_KEY（脚本从不读取/持久化），自动化最多只能把窗口弹出来。
- `Get-P0Health` 的端口探测每 2s 连一次 1883/9101；bridge 已对裸探测限频，但仍属正常开销。
- watcher 的 `Ensure-Fport` 与当前 bridge 的 LAN 直连拓扑并存：创建 fport 不影响 LAN 直连，但会改变“下一次 P0 冷启动”
  走哪条拓扑（`-AutoDayuEndpoint` 默认 USB 在线优先 fport）。
