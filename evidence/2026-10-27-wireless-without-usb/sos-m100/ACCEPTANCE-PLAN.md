# 验收执行计划：拔掉 USB 后 · 实体按键 SOS → 4G → 公网后端 → APP ACK

> 范围：ESP32-S3 随身 SOS + YED-M100MG-B1（4G/MQTT）+ 公网 ECS `wearable-mqtt` 适配器 + 生产后端 `https://api.luxunacc.xyz` + 监护人 APP。
> 本文件是**执行清单**，不是结果声明；结果见同目录 `REPORT.md`。
> 硬约束：不注入假 SOS、不代替用户 ACK、不烧录、不拔线、不重启 broker/bridge/public-sync、不打印任何凭据/SIM 信息。
>
> **执行状态（2026-10-27 22:55）：本计划已实际执行并 PASS。** 新告警 `sos-7-b941b638`：22:52:32.478 创建 → 云端 22:52:33.163 可见（+0.69s）→ APP 22:52:59.268 ACKED（+26.79s）→ 设备回 NORMAL、无重复。详见 `REPORT.md` §3.7 与 `capture/2026-10-27T14-36-01-822Z-acceptance-capture.md`。本计划保留作为复跑清单。

## 0. 按键前前置状态（2026-10-27 22:26 实测；本轮按键已在此后完成）

| 项 | 实测 | 证据 |
|---|---|---|
| 生产后端 | `/healthz` 200，`/api/v1/devices`、`/api/v1/alerts` 200 | `snapshots/*-r1..r4.json` |
| `esp32-sos` 云端状态 | `online=true`、`state=NORMAL`、`lastSeenTs` 每 **30s** 前进（22:22:05→22:24:05→22:25:05→22:26:05） | 同上 |
| ECS 公网 MQTT `47.76.70.118:1883` | TCP 可达（1111/105/94 ms）；一次 CONNECT（唯一 clientId 后缀）返回 `CONNACK 0x05 NOT_AUTHORIZED`＝用户名/密码通过、clientId 白名单拒绝非设备 ID → Broker 在线 | `logs/*mqtt-1883.json` |
| PC USB 串口 | **无 COM8**（SOS ESP32 未接电脑 USB 数据线）；COM4/COM5 为浴室/厨房节点 | `Win32_SerialPort` / `Get-PnpDevice` 现场核对 |
| COM11（FTDI） | 只读 115200 仅 1 字节 `0xFE`；9600/38400/57600 全空；无 M100 AT/网络日志 | `logs/*serial-passive-COM11.json` |
| 按键前基线告警 | 最新为 `sos-6-49732005`（22:06:44 创建、22:07:09 ACKED）；按 Lead 决策**不作为本轮证据**（见 `REPORT.md` §3.6） | `snapshots/*-r1..r4.json` |

即：**4G / ECS / 后端 / "PC 无 USB" 这几段都通**；按键前唯一需要人做的是"实体按键 + APP 点确认"（本轮已完成）。

## 1. 角色分工

| 角色 | 动作 |
|---|---|
| **用户（不可替代）** | ① 现场确认 M100 已接 DC 5~12V 且 4G 天线/GPS 天线已接、NET 灯约 1s 慢闪、RDY 常亮；② 确认 SOS ESP32 由充电宝/独立 5V 供电（**电脑 USB 数据线已拔**）且与 M100 共地；③ **短按 SOS 按钮 1 次**（按前告知 Lead/本脚本开始采样）；④ 在 APP 中打开告警详情并点 **确认**；⑤ 口述蜂鸣器是否 3 短声、ACK 后是否停响。 |
| Lead | 把控时序、批准任何"非只读"恢复动作（例如适配器重启），对最终结论签字。 |
| 本脚本（AI，只读） | 轮询后端、记录时间线、固化快照；**不按键、不发布 MQTT、不 ACK、不改数据**。 |
| APP owner（如在场） | 需要时抓 APP 界面截图；不与本脚本的只读 API 采样冲突。 |

## 2. 执行步骤（含证据采集点）

### T0 — 按键前门禁（AI 执行，约 1 分钟）

```powershell
cd <WORKSPACE>\competition\evidence\2026-10-27-wireless-without-usb\sos-m100
node tools\prod-probe.js snapshots t0-precheck
node tools\mqtt-probe.js logs mqtt-precheck
```

通过条件：
- `esp32Sos.online=true` 且 `ageSeconds < 90`（若 ≥120s 且 2 分钟内不前进 → 转到 §4 故障分支）；
- MQTT：`tcp[].ok=true` 且 `mqttConnect.returnCode=5`（0x05 表示 Broker 在线、凭据有效、唯一 clientId 被白名单拒绝——这是**预期值**，不是失败）。

### T1 — 用户短按实体按钮（用户执行）

- 用户按前说一声；AI 立即启动验收自动取证（每 5s 只读轮询，自动识别"基线之外的新 alarmId"并记录 ACK）：

```powershell
node tools\acceptance-capture.js capture 1200 5
```

- 该脚本是**只读**的：只 GET `/api/v1/devices`、`/api/v1/alerts`，不发布 MQTT、不 ACK、不改数据；结束时输出 `capture/<时间戳>-acceptance-capture.{jsonl,json,md}`，其中 `verdict` 为 `PASS_ALARM_AND_ACKED_SEEN` 时表示"新告警 + ACKED 均被云端捕获"。
- 同时可另开一个粗粒度监视（可选，10s）：

```powershell
node tools\alert-watch.js logs\alert-watch-<时间戳>.jsonl 900 10
```

- 用户按住约 0.2~1s 松开，**只按 1 次**（每次按下都会新建一条告警，不要连按）。
- 记录用户口述的按键时刻（秒级即可），与后端 `createdAt` 对齐。

### T2 — 后端出现新 MANUAL_SOS（AI 采集，预期 ≤60s）

只读检查点（任选一，建议两者都做）：

```powershell
node tools\prod-probe.js snapshots t2-after-press
```

判定：
- `/api/v1/alerts` 出现**新的** `alarmId`（形如 `sos-7-xxxxxxxx`），`deviceId=esp32-sos`、`type=MANUAL_SOS`、`ackPending=true`、`acknowledgedAt=0`；
- `/api/v1/devices` 中 `esp32-sos.state` 为 `ALARM`（若 APP 确认很快，可能已变 `ACKED`，以 alerts 状态为准）；
- 时间差：`alarm.createdAt - 用户按键时刻` 应 ≤60s（4G+M100 打包 80ms+MQTT 上行）。
- 同时用户确认：蜂鸣器 3 短声（本地已生成求助）。

**采集点 A**：`snapshots/<时间戳>-t2-after-press.json` 中的 `alerts.esp32SosRecent[0]`（新 alarmId/createdAt）与 `devices.esp32Sos.state=ALARM`；`logs/alert-watch-*.jsonl` 中对应的第一条 `state=ALARM` 行。

### T3 — APP 显示告警（用户执行 + 截图）

- 用户打开 APP 告警列表/详情，应看到「随身求助」新记录；如有地图，注意「求助时刻位置 / 求助后更新 / 暂无定位」三种如实标注之一。
- 可选截图（APP owner）：`app-*.png`，写入本证据目录或 APP 证据目录，并在 `REPORT.md` 引用。

### T4 — 用户在 APP 点「确认」（用户执行；AI 采集 ≤60s）

- 用户点确认后，AI 立即（5s 采样已覆盖）等待并记录：
  - `/api/v1/alerts` 中同一 `alarmId`：`acknowledgedAt>0`、`acknowledgedBy=household-guardian`、`state=ACKED`、`ackPending=false`；
  - `/api/v1/devices` 中 `esp32-sos.state=ACKED`（随后回到 NORMAL）；
  - 用户确认：蜂鸣器停响（下行 ACK 经 MQTT→M100→UART 到达 ESP32 的现场证据）。
- **关键证明**：适配器设计为「只有收到设备真实 `t:"ack"` 回执才回写 ACKED，绝不代报」（见 `competition/cloud/wearable-mqtt/README.md` §4.2）；因此后端出现 ACKED 本身就是"设备已收到下行并回执"的云端证据。

**采集点 B**：`snapshots/<时间戳>-t4-after-ack.json` 中同 `alarmId` 的 `acknowledgedAt/state`；`logs/alert-watch-*.jsonl` 中 `acknowledgedAt` 从 0 变为非 0 的那一行；用户口述"蜂鸣停止"。

### T5 — 固化与判定（AI 执行）

```powershell
node tools\prod-probe.js snapshots t5-final
```

- 汇总：`REPORT.md` 增加本次事件时间线（按键→createdAt→ACK→acknowledgedAt，各段时延）；
- 证据文件索引：快照 JSON、alert-watch JSONL、MQTT 探针 JSON、串口只读 JSON（如启用）、APP 截图（如有）；
- 判定 PASS 条件（全部满足）：
  1. 全程 `COM8` 不存在（无 PC USB 数据线）；
  2. 按键后 ≤60s 后端出现新的 MANUAL_SOS（`createdAt` 与用户按键时刻对齐，仅新增 1 条）；
  3. APP 显示该告警（用户确认，截图最佳）；
  4. 用户 ACK 后 ≤60s 同 `alarmId` 变 ACKED（`acknowledgedAt>0`），且设备蜂鸣停止（用户确认）；
  5. 同一按键不产生重复告警（`alerts` 中仅新增 1 条新 alarmId；适配器按 alarmId 去重）。

## 3. 必须由用户实体完成的步骤（不可用软件替代）

1. 确认/恢复 **M100 独立 DC 5~12V 供电**与 4G 天线、GPS 天线（如断电，先上电等 20~30s，NET 慢闪+RDY 常亮）。
2. 确认 **SOS ESP32 独立 5V 供电**（充电宝）并与 M100 **共地**，且电脑 USB 数据线已拔。
3. **按下实体 SOS 按钮**（本次验收的核心动作）。
4. 在 **APP 中点击确认**（监护人 ACK 的核心动作）。
5. 现场观察蜂鸣器（3 短声 / ACK 后停响）并口述给 Lead。

以上 2、3、4 是"实体/SOS/APP"三段链路的真实触发点；AI 只用只读 API/日志记录，不制造任何事件。

## 4. 故障分支（只记录，不擅自处置）

| 现象 | 可能原因 | 只读确认 | 处置（需 Lead/用户） |
|---|---|---|---|
| `lastSeenTs` 90s 不前进 | M100 掉电/无 4G/天线松/未共地 | 连续 3 次 `prod-probe` | 检查 DC 电源、天线、NET/RDY 灯；断电重上电等 30s |
| 按键后 120s 无新告警 | 按钮接线（GPIO4↔GND）、ESP32 未上电、UART 接线 | 无蜂鸣 3 短声＝本地都没触发 | 检查按钮/供电/接线；不要连续狂按 |
| APP 见到告警，ACK 后 >60s 仍「等待设备确认」 | 下行 ACK 未达（M100 重启窗口/适配器 parked，历史 README §5.1） | `state` 仍 ALARM、`ackPending=true` | 等 1 轮（适配器 5min 慢速重投）；仍不行需 `docker restart wearable-mqtt`，**由 Lead 批准后在 ECS 执行**（本脚本边界外） |
| 出现重复告警 | 用户连按 / 固件重发被后端按 alarmId 幂等 | 对比 alarmId 是否相同 | 相同 alarmId 不算重复；不同 alarmId 说明连按了 |
| 告警无 `sosLocation` | 当时无 GPS fix | 快照字段检查 | 不影响 SOS/ACK 验收；APP 显示"暂无定位/求助后更新"属如实降级 |

## 5. 禁止事项（验收期间）

- 不发布任何 MQTT 消息到 `eldercare/wearable/sos-001/up|down`（会污染设备真实数据/冒充设备）。
- 不调用 `POST /api/v1/alerts/{alarmId}/ack` 代用户确认。
- 不重启 broker/bridge/public-sync/wearable-mqtt（除 Lead 批准的单次恢复）。
- 不烧录固件、不插拔设备数据线、不打印/写入凭据、Token、SIM 信息。
- 不启动旧的 `cloud/onenet/public-sync` / `gateway`（会抢领 `esp32-sos` 的 ACK 命令）。
