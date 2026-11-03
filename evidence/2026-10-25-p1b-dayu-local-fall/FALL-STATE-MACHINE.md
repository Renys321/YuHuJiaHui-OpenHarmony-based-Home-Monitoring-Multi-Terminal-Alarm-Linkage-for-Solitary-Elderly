# 跌倒状态机（P1-B）

## 1. 状态

```text
MONITORING
  -> DESCENT_CANDIDATE        快速下降候选（不是跌倒）
  -> HORIZONTAL_CANDIDATE     下降后首次水平
  -> PERSISTENT_HORIZONTAL    水平持续
  -> FALL_CONFIRMED           唯一 fall=true 的转换
  -> MONITORING (RECOVERED)   恢复站立
  -> UNKNOWN                  输入/关键点不足，不自动判安全
```

## 2. 转换条件（默认阈值，集中定义在 `fall_core.h`）

| 转换 | 条件 | 说明/依据 |
|---|---|---|
| MONITORING → DESCENT_CANDIDATE | 窗口内髋部归一化下落速度 ≥0.45 图像高/s，且下落 ≥0.15 图像高 | 快速下降只是候选；阈值让正常坐下/缓慢躺下不进入候选 |
| DESCENT_CANDIDATE → HORIZONTAL_CANDIDATE | 出现 HORIZONTAL | 单帧水平不够，必须此前有快速下降 |
| DESCENT_CANDIDATE → MONITORING | 持续直立 ≥500 ms 或候选超时 5 s | 快速下降后恢复，不判跌倒 |
| HORIZONTAL_CANDIDATE → PERSISTENT_HORIZONTAL | 水平持续 ≥800 ms | 多帧一致性 |
| PERSISTENT_HORIZONTAL → FALL_CONFIRMED | 距首次水平 ≥2200 ms | 水平持续确认；只在这一次转换触发 fall=true |
| FALL_CONFIRMED → MONITORING | 直立持续 ≥900 ms | 记录 RECOVERED；本轮不发 ACK |
| FALL_CONFIRMED 时无人物 | 主目标丢失 ≥5000 ms | 进入 RECOVERY_UNCONFIRMED，不声称已恢复 |
| 任意 → UNKNOWN | dataValid=false、关键点不足超过 600 ms、非单调时间 | 不自动判安全；不输出 NO_PERSON |
| 关键点短暂丢失 | ≤600 ms | 保留最近姿态/状态，`fallEvaluated=false`，reason `KPT_LOSS_GRACE` |

## 3. 事件唯一性

- `FALL_CONFIRMED` 转换时生成唯一 `fallEventId = p1b-<trackId>-<seq>`；只有该事件 `fall=true`。
- 之后同一事件持续横卧的帧：`fallState=FALL_CONFIRMED`、`fall=false`、`fallAlreadyConfirmed=true`、`fallEventId` 保持不变；不再产生新的 FALL 事件。
- 恢复站立生成 `RECOVERED` 事件（`fall=false`、`recovered=true`），清除活动事件；**下一轮跌倒必须重新从 MONITORING 进入并产生新 eventId**。
- 换主目标（track switch）会重置候选/确认状态；旧事件不迁移。

## 4. `fall` / `fallEvaluated` 语义

- `fall=true`：**仅**在有效的、稳定主目标的“快速下降 + 水平持续 ≥2200 ms”的 `FALL_CONFIRMED` 转换事件上出现。
- `fallEvaluated=true`：仅当 `dataValid=true`、主目标跟踪稳定（hits≥2）、关键点足够且姿态已知，且状态机完成了该帧评估。
- `dataValid=false`、关键点不足/UNKNOWN、`personCount=0`、主目标丢失：`fallEvaluated=false`，`fall=false`；`personCount` 为 -1（无效）或 0（有效无人），绝不把失败写成 0 人。
- 对 DAYU APP 的 HTTP 响应仍固定 `fall=false, fallEvaluated=false`（本轮不接正式告警；本地事件才有跌倒状态）。

## 5. 设计取舍

- 正常坐下、弯腰、蹲下：不会进入 DESCENT_CANDIDATE（速度/下落不足）或不会持续水平，因此不会 FALL；fixture 已验证。
- 缓慢躺下：无快速下降 → `HORIZONTAL_WITHOUT_DESCENT`，不 FALL。
- 快速下降后恢复：候选被取消，不 FALL。
- 快速下降后持续横卧：fixture 验证唯一 FALL；真实人体快速跌落**未做**（安全边界），不得声称真人跌倒验证。
- 真实相机近景关键点不足：真实姿态验证失败；本轮不把 fixture 结果当成真机跌倒 PASS。
