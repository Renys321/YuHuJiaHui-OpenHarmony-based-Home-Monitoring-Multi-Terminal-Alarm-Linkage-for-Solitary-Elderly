# 同步链路恢复 + 卫生间既有 SOS 可见性与 ACK 验收（短报告）

- 日期：2026-10-26 22:49–23:28（Asia/Shanghai）
- 工作区：`<WORKSPACE>`；证据目录：`competition/evidence/2026-10-26-sync-restore-bath-sos-ack/`
- 边界：只处理“卫生间 SOS 在 APP 不可见 / 同步服务曾停止”。**未按任何实体按钮、未注入 SOS、未下发任何命令、未停止或重启 bridge/broker、未改 APP/后端/DAYU、未烧录。**
- 分级：REAL = 真实链路/真实设备；PASS / PARTIAL / BLOCKED 明确标注。

---

## 1. 结论摘要

| 项 | 结果 |
|---|---|
| public-sync supervisor/worker 状态 | 恢复前**已停止**（state 文件 PID 29940/26264 均不存在、stale lock）；**无重复实例** |
| 恢复操作 | 用正式 P0 入口 `competition/materials/start-demo-supervisor.cmd` 恢复（`STALE_LOCK_TAKEOVER` → `KEY_READ` → `WORKER_START` → `HEALTHY`）；`INGEST_KEY` 仅本机隐藏输入，未进入聊天/日志/报告 |
| 恢复后同步证据 | **PASS**：`command-sync POLL_OK 200` 每分钟；`cloud-sync 202` 对 `esp32-kitchen`、`esp32-bath` 持续（22:53 起） |
| 既有 SOS 在 APP 的可见性 | **PASS**：用户确认 APP 里能看到 **3 条卫生间告警**——`21:45 未处理` + `22:56 已确认` + `22:59 已确认` |
| 用户 ACK 提交 | **PASS（提交成功）**：用户对 21:45 那条点 ACK，APP 显示“已提交，正在回执”；后端生成命令 id=13/14/15/16 |
| 相同 `alarmId` 的设备回执 | **BLOCKED（设备明确拒绝）**：串口 6 次 `CMD 收到: ack e-1793022316-1` → `ACK 被拒绝：当前没有待处理告警（state=ACKED，收到 id=e-1793022316-1）`；云端 `ACK_FAIL code=ACK_TIMEOUT` |
| 该事件告警闭环 | **未通过**（不得写成通过）：后端只能保持“未处理”，APP 会继续显示未处理 |

**一句话**：同步链路已恢复、既有 SOS 在 APP 确实可见、用户 ACK 也已提交到后端并成功下发到设备；**但设备对这条历史 alarmId 明确“拒绝”，因此同一事件的设备 ACKED 回执无法产生，告警闭环未完成**。根因是设备在 22:21 被复位后不保留告警状态（固件设计“重启不重放”），而这条历史告警在复位前没有被 ACK。

---

## 2. 恢复前后实时状态

### 2.1 恢复前（只读，22:49–22:51，详见 `BEFORE-STATE.md`）

```
broker 1883  LISTENING PID 41084        （运行中）
bridge 9101  LISTENING PID 42784        （运行中；命令行无 relay/fport 参数）
9001         LISTENING PID 27128        （无持久连接）
node 进程：无任何 public-sync-supervisor.js / public-sync-worker.js
state 文件：supervisorPid=29940, workerPid=26264  →  两个 PID 均已不存在（stale）
lock 文件：29940（stale）
日志最后一条：2026-10-26T14:23:12Z（22:23:12）cloud-sync 202
```

结论：**public-sync 已停止且不存在重复实例**，可以恢复；恢复前没有按历史 PID 结束任何进程，也没有停止任何仍在运行的服务。

### 2.2 实际采取的操作

1. 确认 `start-demo-all.cmd` 的 P0 健康检查只读 **state 文件**（`state=HEALTHY && supervisorPid>0`）+ 1883/9101 端口，
   而该 state 文件是 22:23 的陈旧快照、lock 也是 stale → **它会误判 P0 健康并跳过重启**。
   因此改用同一个入口自己委托的正式 P0 入口 `start-demo-supervisor.cmd`（脚本内含进程存在性校验与 stale-lock 接管）。
2. 22:53:04 在可见窗口启动该入口（`cmd.exe /c "…\start-demo-supervisor.cmd"`，未结束/未强杀任何进程）。
3. 22:53:19 用户在窗口中隐藏输入 `INGEST_KEY`（日志仅记 `KEY_READ ok=set`，**不记录内容**）。

### 2.3 恢复后（实时证据，详见 `cloud-command-sync-extract.log`）

```
22:53:09 [supervisor] LOCK_ACQUIRED pid=32356
22:53:09 [supervisor] STALE_LOCK_TAKEOVER dead_pid=29940
22:53:19 [supervisor] KEY_READ ok=set
22:53:19 [supervisor] WORKER_START pid=32788
22:53:19 [public-sync] CONFIG backend=https://api.luxunacc.xyz / ingestKey=set
22:53:19 [gateway] LOCAL_SUBSCRIBED topic=home/+/status
22:53:19 [supervisor] HEALTHY pid=32788
22:53:20 [command-sync] POLL_OK path=/internal/v1/commands status=200   （此后每分钟持续）
22:53:20 [cloud-sync] OK device=esp32-kitchen … status=202
22:55:24 [cloud-sync] OK device=esp32-bath    … status=202   （22:55:24/22:55:55/22:56:28/22:57:01/22:57:33 … 持续）
```

- supervisor/worker 进程确实存在（PID 32356 / 32788），state=HEALTHY，heartbeat 持续更新。
- 恢复瞬间有 9 条 `COMMAND_IGNORED code=COMMAND_NOT_PENDING`：把上一轮已结算命令的结果再回写、被判幂等忽略，不影响新命令。

---

## 3. 既有 SOS（`e-1793022316-1`）在 APP 的可见性

- 用户确认 APP 中卫生间列表为：**21:45（未处理）+ 22:56（已确认）+ 22:59（已确认）** → **既有 SOS 可见，PASS**。
- 即“APP 看不到卫生间告警”这一条在同步恢复后**不再成立**；同步恢复前该告警已上云（最后成功 202 为 22:13:45 state=ALARM）。
- 说明：22:56 / 22:59 两条是**用户自己按实体按钮**产生的新 SOS（用户已确认），不是本次目标事件，也不是我按的。

## 4. 用户 ACK → 后端 → 设备回执（同一 `alarmId`）

| 环节 | 证据 | 结果 |
|---|---|---|
| 用户在 APP 对 21:45 那条点 ACK | 用户反馈 APP 显示“已提交，正在回执” | 提交成功 |
| 后端生成 ACK 命令 | `ACK_SENT id=13/14/15/16 device=esp32-bath`（23:19:03 / 23:22:34 / 23:23:07 / 23:26:17） | 已下发 |
| 设备收到命令 | 串口：`CMD 收到: ack e-1793022316-1 监护人已确认`（23:22:34/44/55、23:23:07/17/28 共 6 次） | 收到 |
| **设备回执** | 串口：`ACK 被拒绝：当前没有待处理告警（state=ACKED，收到 id=e-1793022316-1）` | **拒绝** |
| 云端结算 | `ACK_FAIL code=ACK_TIMEOUT id=13/14/15 device=esp32-bath`（id=16 同型，抓取窗口外） | 失败 |
| 后端告警状态 | 未收到 `ACKED` 回执 → 告警保持 `ALARM`（APP 仍显示“未处理”） | 未闭环 |

原话证据：`device-ack-rejection.log`、`bath-serial-ack-capture.log`、`cloud-command-sync-extract.log`。

## 5. 为什么设备会拒绝（已定位）

1. 这条告警是 21:45:16 在卫生间板上产生的（当时已正常上云）。
2. **22:21 该板被复位**（上一任务为排查该板 WiFi 所做），而固件**告警状态不持久化**——重启后回到 NORMAL、不重放历史告警（这是既有设计，本次未改）。
3. 22:49 起该板 MQTT 一直是 `state=NORMAL`（原始证据），说明设备 RAM 中已没有 `e-1793022316-1`。
4. 22:56:53 / 22:59:35 用户又按了两次 SOS，设备产生新告警 `e-1793026613-1` / `e-1793026775-2`，两条都已端到端 ACKED（命令 id=10 / id=12，设备与云端均确认）。
5. 因此当后端把 `ack e-1793022316-1` 下发到设备时，设备当前处于 `ACCEPTED`（对应另一条 alarmId）→ 按既有语义“ID 不精确匹配就拒绝”，返回“当前没有待处理告警”。
6. 后端 `completeCommand` 要求设备回执 `state=ACKED && alarm.id == 命令alarmId` 才结算；设备拒绝 → 只能记 FAILED，告警保持未处理。

> 结论：这不是同步故障，也不是 APP 显示错误；是**设备端该事件的锁存状态在复位时丢失**导致的“历史告警无法被设备确认”。本次任务禁止制造新告警，所以不能用一条新 SOS 顶替。

## 6. 未完成的阻塞与最小建议（未擅自实施）

| # | 阻塞 | 最小原因 | 建议（需明确授权） |
|---|---|---|---|
| 1 | 历史告警 `e-1793022316-1` 永远无法变成 ACKED | 后端要求“设备回执匹配 alarmId”，而设备已无该锁存 | 二选一：**(a)** 后端/运维侧对该条历史告警做管理性关闭（业务代码或数据操作，本次未授权改后端）；**(b)** 接受该事件无法闭环，并在产品上把“设备已重启/已无该告警”的历史告警标记为过期而不是让用户反复 ACK |
| 2 | APP 会一直显示 21:45 那条“未处理”，每次 ACK 都失败 | 同上 | 同上；在此之前不建议继续反复点 ACK（已经 4 次、设备 6 次拒绝） |
| 3 | 未来同类事件 | 固件“重启不重放”与“未 ACK 告警需要回执闭环”存在语义冲突 | 若希望重启后仍能 ACK 历史告警，需要评审“持久化未 ACK 告警 ID”的固件改动（会改变现有“重启不重放”语义），不是本次可顺手改的 |
| 4 | `esp32-sos`（随身求助）的 ACK 超时 | 该板当前不在线；ACK 命令 3 次后 `ACK_FAIL` | 不在本任务范围，仅记录 |

## 7. 边界的如实说明

- **没有制造新告警**：本题内的两条新 SOS（22:56:53、22:59:35）都是**用户自己按键**造成的（用户已确认），我只做只读观察；未注入、未按按钮、未替用户 ACK。
- **没有停止/重启** bridge、broker；没有结束任何在运行的进程；只启动了已停止的 public-sync supervisor。
- 没有修改 APP/后端/DAYU，没有安装 APP，没有烧录。
- 同步恢复后既有 SOS 的“可见性”为 PASS；“用户 ACK 已提交并有设备回执”为 PASS；“同一事件告警闭环”为 **BLOCKED**，不写成通过。

## 8. 证据索引

| 文件 | 内容 |
|---|---|
| `BEFORE-STATE.md` | 恢复前只读状态：进程命令行、端口、stale state/lock、结论 |
| `AFTER-RESTORE.md` | 恢复后实时证据 + 新 SOS 出现的时间线 |
| `cloud-command-sync-extract.log` | supervisor 恢复段 + ACK 命令段原始日志摘录 |
| `bath-serial-ack-capture.log` | COM4 只读串口原始日志（含 6 次 ACK 拒绝） |
| `device-ack-rejection.log` | 设备侧拒绝回执摘录 |
| `monitor-*/` | 只读 MQTT 订阅与状态采样记录（无 publish） |
| `tools/watch-status.py` | 只读采样脚本 |
