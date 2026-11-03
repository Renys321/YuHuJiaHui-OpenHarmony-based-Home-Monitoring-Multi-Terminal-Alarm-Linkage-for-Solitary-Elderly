# 固件相关：是否需要改？风险与可选补丁（不构建、不烧录）

**结论：本次断连自愈修复不需要改固件。** 现有固件行为已经满足服务端自愈所需，且是“正确语义”的关键一环。

## 1. 现有固件行为（读取 `competition/esp32-node-wearable/main/` 源码确认，只读）

| 固件行为 | 位置 | 为什么服务端修复依赖它 |
|---|---|---|
| 未确认事件每 10s 用**同一 alarmId** 重发 SOS | `wearable_main.c` 主循环 5.5 + `wearable_logic.c:wb_event_should_resend` | 适配器按 alarmId 去重 → 不会重复建告警；断网期间的求助在恢复后能补上 |
| 启动先发 `boot`，若 NVS 里有未确认事件立即重发 SOS 并恢复蜂鸣提示 | `wearable_main.c` 4/5 段 + `wb_persist_restore` | 设备重启后服务端立刻知道“在线 + 仍有未确认事件”，不会误判“已解除” |
| 每 30s 一条 `hb`（state=ALARM/IDLE，csq 已知才带） | `wb_build_hb_ex` | 服务端离线看门狗用“业务上行静默 120s”判离线；30s 心跳足够 |
| 收到匹配 ACK 才停提示并回 `t:"ack"` 回执；**重复 ACK 也回执**（WB_ACK_DUPLICATE 分支） | `wearable_logic.c:wb_event_handle_ack` + `wearable_main.c:wb_handle_downlink_json` | 服务端重投/重启后再次下发同一 ACK 时，设备会重发回执，使 `result` 能补报（不依赖容器内存） |
| 下行按 `\n` 或 100ms 空闲成帧（M100 不补换行） | `wb_line_feed` / `wb_line_idle_flush` | 适配器 downlink 末尾加 `\n` 的契约依赖此解析 |
| 不启用 Wi-Fi | 固件配置 | 4G 链路独立于 PC/家庭网络 |

## 2. 可选改进（仅建议，非本次必需，未实施）

| # | 建议 | 收益 | 风险/代价 |
|---|---|---|---|
| F-A | 启动时把 `boot` 帧连发 2–3 次（间隔 1s） | M100 在 ESP32 上电瞬间可能尚未完成 4G/MQTT 连接，单次 boot 可能丢；连发提高“重启后 APP 立刻恢复”的确定性 | 需重烧固件；重复 boot 对服务端无害（适配器每次 boot 只发一次 device-status，不重复建告警） |
| F-B | 若 M100 支持 `config,csq` 查询，启动时查询一次 CSQ 再让 hb 带上 | APP/后端能看到信号质量 | 需 M100 配置与串口时序验证；当前 `csq=null` 不影响主链路 |
| F-C | 心跳里加 `alarm` 的“事件开始服务器无关时间”不可行（无 RTC，契约已禁止伪造设备墙钟） | — | **不做**：保持契约“设备不发墙钟时间” |

## 3. 若将来改固件，必须保持的兼容性红线

1. **BOOT/HB/SOS/ACK 报文格式与字段名不变**（`v/t/dev/alarm/uptimeMs/seq/gps/cmd/state/fw`）。
2. 未确认事件必须继续用**同一 alarmId** 重发；不得每次重发换新 ID（否则会重复告警）。
3. 收到 ACK 后必须继续回 `t:"ack"` 回执；重复 ACK 也要回执（服务端靠它补报 result）。
4. 不得在设备端伪造 `ACKED`/不上报回执（服务端不会代报，APP 会一直等）。
5. 下行行解析必须容忍末尾 `\n` 与无 `\n`（100ms 空闲成帧）。

## 4. 若现场出现“固件 NVS 丢事件”的极端情况

- 现象：设备重启后不再蜂鸣/不再重发 SOS，但后端告警仍是未确认 ALARM；APP 点确认后命令一直 PENDING
  （设备忽略不匹配 ACK，不发回执）。
- 服务端行为（本次修复后）：适配器清本地事件快照并记 `ACTIVE_EVENT_CLEARED_BY_DEVICE`，
  **不代报 ACKED**；告警保留在 APP。
- 现场处置建议：让监护人在 APP 用“登记处置/安全日志”，或等设备侧修复后重按新事件；**不要**反复点确认。
