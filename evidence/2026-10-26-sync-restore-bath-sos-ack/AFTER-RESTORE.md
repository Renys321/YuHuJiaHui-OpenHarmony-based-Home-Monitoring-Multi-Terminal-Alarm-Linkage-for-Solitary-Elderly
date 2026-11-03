# 恢复后实时状态（2026-10-26 22:53–22:58）

## 实际采取的操作（按顺序）

1. **只读检查**（22:49–22:51）：确认 broker(1883) PID 41084、bridge(9101) PID 42784 仍在运行；**public-sync supervisor/worker 已停止**
   （state 文件里 `supervisorPid=29940 / workerPid=26264` 两个 PID 都已不存在，lock 文件仍是 `29940` → stale；没有任何 node 进程命令行含
   `public-sync-supervisor.js` / `public-sync-worker.js`）。现场**没有重复实例**。详见 `BEFORE-STATE.md`。
2. **未结束/未强杀任何进程**，未停止任何服务。
3. 尝试用 `start-demo-all.cmd` 恢复时发现：它的 P0 健康检查只读 state 文件（`state=HEALTHY && supervisorPid>0`）与 1883/9101 端口，
   而 state 文件是 22:23 的陈旧快照（PID 已死），且 stale lock 存在 → `start-demo-all.cmd` 会**误判 P0 健康并跳过重启**。
   因此改用该入口自己委托的正式 P0 入口 `competition/materials/start-demo-supervisor.cmd`（其脚本内做 stale-lock 接管与进程存在性校验）。
4. 22:53:04 在可见窗口启动该入口；22:53:09 `LOCK_ACQUIRED pid=32356` / `STALE_LOCK_TAKEOVER dead_pid=29940`；
   22:53:19 `KEY_READ ok=set`（**INGEST_KEY 由本机窗口隐藏输入，未进入本聊天/日志/报告**）→ `WORKER_START pid=32788` → `HEALTHY`。

## 恢复后的实时证据

```
[supervisor] LOCK_ACQUIRED pid=32356
[supervisor] STALE_LOCK_TAKEOVER dead_pid=29940
[supervisor] WAITING_FOR_KEY
[supervisor] KEY_READ ok=set
[supervisor] WORKER_START pid=32788
[worker:stdout] [public-sync] CONFIG backend=https://api.luxunacc.xyz
[worker:stdout] [public-sync] CONFIG broker=mqtt://127.0.0.1:1883
[worker:stdout] [public-sync] CONFIG ingestKey=set
[worker:stdout] [gateway] LOCAL_SUBSCRIBED topic=home/+/status
[supervisor] HEALTHY pid=32788
[command-sync] POLL_OK path=/internal/v1/commands status=200
[cloud-sync] OK device=esp32-kitchen … status=202   (22:53:20 起持续)
[cloud-sync] OK device=esp32-bath    … status=202   (22:55:24 / 22:55:55 / 22:56:28 / 22:57:01 / 22:57:33)
```

- supervisor/worker 进程存在且 heartbeat 持续更新：PID 32356 / 32788，state=HEALTHY。
- 两设备状态均已自然上云（202）；bridge 上两节点 TCP 均 ESTABLISHED（10.127.130.71 / 10.127.130.168）。
- 启动瞬间出现 9 条 `[command-sync] COMMAND_IGNORED code=COMMAND_NOT_PENDING`：这是把上一轮已结算命令的结果再次回写被判幂等忽略，
  不影响新命令；随后 `POLL_OK 200` 正常。

## 重要新情况：卫生间出现一条**新的** SOS（不是原来那条）

| 项 | 值 |
|---|---|
| alarmId | **`e-1793026613-1`**（epoch 1793026613 ≈ 22:56:53） |
| 设备/房间 | `esp32-bath` / 卫生间 |
| 类型 | `MANUAL_SOS`，`alarm.countToday=1` |
| 首次上云 | 22:57:01 / 22:57:33 均为 `state=ALARM` 的 202 |
| 与“既有 SOS”关系 | **不同 ID**：既有那条是 `e-1793022316-1`（21:45:16 产生） |

注意：本次任务**没有按任何实体按钮、没有用脚本注入 SOS、没有下发任何命令**；这条新 SOS 的产生时刻（22:56:53）
没有对应的串口抓取，因此**来源未定位**（可能是用户按键，也可能是卫生间 GPIO15 悬空/干扰误触——该板历史上出现过一次
来源不明的 SOS 电平事件）。需要用户确认是否按过按钮，才能按“用户操作”或“误触”分别记录。

## 既有 SOS（`e-1793022316-1`）的设备侧状态

- 最后一次成功上云：22:13:45（state=ALARM）。
- 该板在 22:21 被复位（上一任务为排查 WiFi 所做），而固件**告警状态不持久化**（重启不重放），因此设备 RAM 中已没有这条告警；
  22:49 起 MQTT 一直是 `state=NORMAL` 直到 22:56 新 SOS。
- 推论：即使 APP 里仍能看到并 ACK 这条既有告警，**设备回执不可能是 ACKED**（ID 不匹配 → `ACK 被拒绝`），后端最终会把命令记为 FAILED。
  这一点需在验收时如实记录，不能写成设备已确认。
