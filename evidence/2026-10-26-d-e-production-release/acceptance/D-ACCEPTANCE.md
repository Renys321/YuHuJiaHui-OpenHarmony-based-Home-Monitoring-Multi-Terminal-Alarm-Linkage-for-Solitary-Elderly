# D 类真实验收记录（处置结果 + 持久安全日志）

- 验收时间：2026-10-27 00:27–00:35 +08:00
- 环境：生产后端 `https://api.luxunacc.xyz`（D/E 镜像 `sha256:568b6193…`，schema v6）；APP `com.example.program_04` 1.0.1（D/E-only，unsigned 覆盖安装）
- 设备：模拟器 `127.0.0.1:5555`

## 1. 使用的真实告警（用户操作产生，非系统/代理伪造）

| 项 | 值 |
|---|---|
| 告警 | `e-1793032029-1`（厨房 `esp32-kitchen` MANUAL_SOS，实体按键） |
| 创建时间 | 2026-10-27 00:27:09.411 |
| 产生方式 | **用户按下厨房实体 SOS 键**（用户确认） |
| ACK | 00:27:25 command-sync `ACK_SENT id=17 → esp32-kitchen`，设备回执 `ACKED`；用户 00:33:44 又点了一次 ACK，后端 `acknowledgedAt=00:33:44.914` |
| 另一条 | `e-1793032428-2`（厨房 MANUAL_SOS，00:33:48 用户再次按键），状态 `ALARM`、未确认，**未做 ACK**（保持真实未处理状态） |

## 2. 处置结果登记（APP 真实操作）

用户在 APP「预警 → 详情 → 处置结果」对 `e-1793032029-1` 提交了两次真实处置（均为用户操作）：

| # | dispositionId | clientDispositionId | 时间（serverTime） | 结果 | 说明 |
|---|---|---|---|---|---|
| 1 | `dsp-1` | `disp-mvpgzjxh-k3baac` | 2026-10-27 00:27:30.080 | CONTACTED_FAMILY（已联系家属） | （空） |
| 2 | `dsp-2` | `disp-mvph0k89-qc85bq` | 2026-10-27 00:28:17.078 | CONTACTED_FAMILY（已联系家属） | 已经电话 |

## 3. 前端展示（APP）

- 「我的 → 安全日志 → 安全日志页签」显示 **2 条真实安全日志**（2026-10-27），字段完整：
  - 标题：紧急求助按键；结果：已联系家属；处理人：`household-guardian`（APP 显示“家庭监护人”）；
  - 房间/设备：厨房 / `esp32-kitchen`；时间 00:27 / 00:28；第一条显示说明“已经电话”。
- 截图：`acceptance/screenshots/02-safety-log-2-records.png`
- 告警记录页（另行）：63→64 条真实告警，新告警按日期分组显示；截图 `01-alert-log-63-real-alerts.png`

## 4. 后端持久化（直接读生产 `/data/backend-state.json`，root 只读挂载）

```
schemaVersion: 6
alertCount: 64
safetyLogCount: 2
safetyLogs:
  {dispositionId: dsp-1, clientDispositionId: disp-mvpgzjxh-k3baac, alarmId: e-1793032029-1,
   deviceId: esp32-kitchen, room: 厨房, type: MANUAL_SOS, outcome: CONTACTED_FAMILY,
   note: "", actor: household-guardian, serverTime: 1793032050080}
  {dispositionId: dsp-2, clientDispositionId: disp-mvph0k89-qc85bq, alarmId: e-1793032029-1,
   deviceId: esp32-kitchen, room: 厨房, type: MANUAL_SOS, outcome: CONTACTED_FAMILY,
   note: "已经电话", actor: household-guardian, serverTime: 1793032097078}
```

**字段核对**：`dispositionId / clientDispositionId / alarmId / deviceId / room / type / outcome / note / actor / serverTime` 齐全；
操作人与时间由服务端生成（`actor=household-guardian`、`serverTime` = 服务器时钟），客户端不可伪造。
**顺序核对**：`dsp-1` 在 `dsp-2` 之前（提交顺序），APP 安全日志按时间倒序展示（00:28 在 00:27 之上）。

## 5. 重启一致性（`docker restart eldercare-public-backend-1`）

- 重启后：`HEALTH=healthy`、公网 `healthz=200`、`readyz=200`；
- `safetyLogs` 重启前后**逐字段一致**（2 条、字段、`serverTime`、`actor` 均相同）；
- 主机侧 `acc-before.txt` / `acc-after.txt` 对比：`PERSIST_DIFF` 的唯一差异来自 `activity-state.json` 的样本数实时增长
  （kitchen samples 162→164、sos 173→175，`lastTs` 前进），**处置/安全日志无任何变化**；
- APP 侧：重启前截图已显示同样 2 条（`02-safety-log-2-records.png`）；重启后后端接口数据逐字段不变（上述直接读取证明），
  APP 刷新后应显示同样 2 条 —— **重启后的 APP 刷新截图未再采集**，此项以“后端持久化 + 接口数据不变”作为通过依据，如实标注。

## 6. 结论

**D 类：真实数据验收通过**（真实告警 + 用户真实处置 + 前端展示 + 后端持久化 + 重启一致；字段与顺序符合合同 v1.2.0）。
处置登记**独立于 ACK**：本次 ACK 是用户单独操作，处置提交不改变告警状态、不产生 ACK 命令。

> 说明：验收期间用户又按键产生 `e-1793032428-2`（未确认）——这是用户的真实设备操作，不是代理/脚本制造的数据；已保留其未处理状态，未做任何 ACK/reset。
