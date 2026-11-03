# COLD-START HANDOFF CHECKPOINT

**在 PC 重启前已保存。** 如果聊天/工具因重启断开，按本文件继续取证，不要凭记忆补命令。

## USB 拔插后的当前状态（2026-10-26 01:22 左右）

- target USB Connected；P0 supervisor HEALTHY；
- homemon 1672、应用 2297、推理 2574（单实例；9200 LISTEN）；
- 事件约 5110 条，`frames=LIVE`；
- 三节点当前 1/1（用户另行调试，排除）；
- 看护器 PID 56904；相机卡片需在正式页内滚动查看；
- 拔插实际导致 DAYU 断电重启（uptime 2526→41.57s），不是纯 USB。

## 重启前状态（2026-10-26 01:12 左右）

- 正式入口：`<WORKSPACE>\competition\materials\start-demo-all.cmd`
- 看护器：PID 52900（可见窗口，单实例）
- P0：supervisor 11632 HEALTHY；worker 9908；Broker 1883；Bridge 9101
- DAYU target：`450100445634303332012847942eca00` USB Connected
- homemon：1150；fport `tcp:9001→tcp:9000`
- 正式应用：PID 2621（1.0.2/1000002，HAP 未改）
- 推理：PID 19619，`/data/local/tmp/dayu-demo-autostart-2026-10-26/`，9200 LISTEN
- 相机/检测：页面“监护运行中”；`frames=LIVE`
- 三节点：**1/3 至 2/3 现场波动，离线节点用户另行调试，本轮排除，不检查/不操作**
- 无用户停止标志

## 冷启动操作（仅由用户做）

1. 正常重启 PC；不要创建计划任务/服务。
2. 登录后，在 Explorer **只双击一次**：
   `<WORKSPACE>\competition\materials\start-demo-all.cmd`
3. 如果自动出现 P0 入口窗口，在该窗口**隐藏输入一次 INGEST_KEY**。
4. 不需要用户/AI 再启动相机、推理或执行恢复命令。
5. 保持看护窗口打开。

## 预期自动结果

- 看护器检测 P0 不健康，打开既有 `start-demo-supervisor.cmd`，由用户输入密钥；
- P0 Broker/Bridge/supervisor/worker 起来；
- HDC 识别 DAYU、homemon、fport；
- 正式应用启动/唤起，相机新帧；
- 独立推理启动，9200、新事件；
- 页面/窗口状态显示 P0/target/app/detect/frames；离线节点仍如实显示，不要求 3/3。

## 冷启动判定 / 取证

- 不把“脚本 exit 0/端口监听”单独当通过；必须有：
  - 正式应用新帧（看护状态 `frames=LIVE` 或页面检测帧数增长）；
  - 推理新事件/9200 新 PID；
  - 无第二 Broker/Bridge/supervisor/worker/推理；
  - 公网同步自然 202 证据（不能只看 HEALTHY）。
- 若 AI 需要手动补任何命令才能恢复，该次不算“一键启动 PASS”，记录并最小修复后复验。
- 记录时间：双击时刻、P0 健康、target OK、app active、detect running、第一帧/第一事件。

## 证据位置

- 本轮 followup 目录：`<WORKSPACE>\competition\evidence\2026-10-26-demo-autostart-followup\`
- 主入口看护日志：`<WORKSPACE>\competition\evidence\2026-10-26-demo-autostart\runtime\demo-autostart.log`
- 状态：同目录 `watcher-state.json`
- P0：`<WORKSPACE>\competition\bridge\_test\current-runtime\supervisor\`
- 冷启动成功后，将状态/日志/进程/自然 202 证据复制到 followup 目录。

## 重要限制

- 用户正在调试无线节点，当前 1/3/2/3 均不构成本任务失败；不要恢复/操作该节点。
- 本入口没有 OS 级开机自启；重启后必须由用户双击一次。
- 本文件不含任何密钥或签名秘密。
