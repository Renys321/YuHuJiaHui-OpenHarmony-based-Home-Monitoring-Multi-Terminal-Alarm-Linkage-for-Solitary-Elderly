# 真实 4G 断连自愈验收 — 物理动作清单（Lead 执行）

**前置条件**（缺一不可）：
- [ ] §部署完成：ECS `/status` 显示 `version=1.0.1`、`link.deviceAliveTimeoutMs=120000`，容器 healthy。
- [ ] 现场设备：M100 已上电（DC 5–12V，**底板 USB 数据线拔掉**、4G/GPS 天线接好、NET 灯 1000ms 慢闪 + RDY 常亮），
      ESP32 已上电（充电宝/USB）。
- [ ] APP 已打开（账号 `luxunluxunluxun`），可下拉/自动刷新；DAYU mirror 就绪（由 Lead 决定是否同时验收）。
- [ ] 有人能拍照/截图并记录 `alarmId`、时间。

> 纪律：只做用户/Lead 指令下的真实按键；**不伪造告警、不替用户点确认、不 ACK 历史告警**。
> 计数/时间以 APP 与生产 API（GET /api/v1/devices、/api/v1/alerts）为准；适配器内部计数用 ECS `docker exec` 查 `/status`。

## A. 上电与在线基线

- [ ] A1 M100 上电 → NET 灯 1000ms 慢闪、RDY 常亮。
- [ ] A2 ESP32 上电 → 记录时间。
- [ ] A3 生产 API：`esp32-sos.online=true`，`lastSeenTs` 每 ~30s 推进（连续观察 ≥60s 至少 2 次推进）。
- [ ] A4 ECS `/status`：`broker.clients` 含 `wearable-sos-001`；`adapter.device.online=true`。
- 证据：API 快照 JSON + `/status` 片段 + 拍照（NET 灯）。

## B. 按键 → 告警（不重复）

- [ ] B1 按实体键 1 次，蜂鸣器**立即**响（<100ms）。
- [ ] B2 记录 APP 新告警 `alarmId`（格式 `sos-<n>-<8hex>`）与创建时间。
- [ ] B3 等待 3 分钟：APP/后端**不得出现第二条同 alarmId 告警**（新 alarmId 才算新事件）。
- [ ] B4 若 DAYU mirror 就绪：DAYU 显示同一 `alarmId`、“随身求助”、事件时间。
- 证据：APP 截图（列表 + 详情）、后端 alerts JSON、`/status` 的 `counters.sosReceived/sosDuplicates`。

## C. ACK 正常链路（基线）

- [ ] C1 APP 点“确认” → 记录时间。
- [ ] C2 设备蜂鸣停止（≤10s，正常应 1–3s），设备显示/日志有回执（如有串口观察则记录，但 USB 不能与 ESP32 同时占用 M100 UART）。
- [ ] C3 APP 显示“设备已确认”（ACKED）；后端 command `status=ACKED`。
- [ ] C4 ECS `/status`：`counters.commandResultOk` +1。
- 证据：APP 截图（ACK 区域）、`/status` 片段、后端命令 JSON。

## D. 断连重启恢复（本次修复核心，必须做）

- [ ] D1 再按一次键产生新告警，等 APP 显示“等待设备确认”。
- [ ] D2 **ESP32 断电 30–60s 再上电**（M100 保持供电；条件允许再补一轮 ESP32+M100 同时断电）。
- [ ] D3 上电后观察：boot → 生产 API `lastSeenTs` 恢复推进、`online=true`，**应 ≤60s**。
- [ ] D4 在 D2 断电窗口内（或上电后立刻）在 APP 点“确认”：
      **命令应在秒级~10s 级送达**（旧版本会等分钟级或需要 `docker restart`），设备停止蜂鸣、APP 变 ACKED。
- [ ] D5 全程**没有执行任何 `docker restart`**。
- [ ] D6 若出现“等待设备确认”超过 30s：查 ECS `/status` 的
      `adapter.commands.parked/inflight`、`counters.parkedRecoveryTriggers/commandsRedelivered/commandResultOk`，
      记录 JSON 并告诉 Lead（不要再重启容器）。
- 证据：操作时间线、APP 截图、`/status` JSON、后端命令/告警 JSON。

## E. 离线语义（不再把旧数据当实时）

- [ ] E1 ESP32 断电，**M100 保持供电**，等待 **>2 分钟**（默认 120s 阈值）。
- [ ] E2 生产 API：`esp32-sos.online=false`（重点看 `online`，不要只看 `lastSeenTs`）。
- [ ] E3 ECS `/status`：`adapter.device.online=false`、`counters.deviceOfflineReports` ≥1、`link.offlineReported=true`。
- [ ] E4 ESP32 重新上电 → ≤30s 内生产 API `online=true`（恢复时首个 hb/boot 立即置 true）。
- [ ] E5 期间 APP 不得把旧 `lastSeen` 显示成“刚刚/实时”（若 APP 仍显示实时，记录截图交 task-5/Lead，属 APP 侧语义）。
- 证据：三次 API 快照（断电前/断电 2min/恢复后）+ `/status` 片段 + APP 截图。

## F. 不伪造确认（安全红线，全程检查）

- [ ] F1 设备未回执时 APP 只能显示“等待设备确认/超时”，**绝不出现 ACKED**。
- [ ] F2 不替用户点确认；不手动 POST 任何 device-status / command result。
- [ ] F3 ECS 日志无 `DEVICE_STATUS_POST_FAILED`/`COMMAND_*` 连续错误（短码即可判断）。

## G. 收尾

- [ ] G1 保持在线 ≥30 分钟，`hb` 30s 节奏稳定、无重复告警、无 `MALFORMED_JSON` 激增（可选长稳）。
- [ ] G2 记录最终 `/status`（version/link/device/counters）与 APP 截图，交 Lead 归档。
- [ ] G3 如升级后出现异常：按 `DEPLOY-PACKAGE.md` §4-A 回滚（不要手删数据卷）。
