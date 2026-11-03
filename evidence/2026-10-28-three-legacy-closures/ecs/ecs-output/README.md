# ecs-output — 用户从 ECS 贴回的证据（验收已完成，见 ../reports/verify-*-FINAL.*）

把用户从阿里云 Workbench 拿到的输出**原样**放这里，文件名固定如下（方便 `report` 直接引用）。
**任何凭据/口令都不应出现在这些文件里**；若发现疑似密钥，立即删除并告知 Lead。

| 文件 | 来源命令（见 `USER-WORKBENCH-ONEPAGE.md` / `CHECKLIST.md §3`） | 状态 / 内容 |
|---|---|---|
| `before-upgrade-20261028-003201.json` | `tools/verify-wearable-101.js preupgrade`（本机实跑） | ✅ 升级前官方基线：API 采样 + 1883 CONNACK 探测 |
| `install-log.txt` | `USER-WORKBENCH-ONEPAGE.md §3`（用户贴回） | ⬜ 未单独落盘；关键行（备份时间戳 `wearable-20261027T163258Z`、容器 healthy、回归自检 PASS）已记录在 `../README.md §2.5` |
| `status-before.json` | §0 | ⬜ 未提供（升级前版本 1.0.0 依据 10-27 交付记录；升级后 1.0.1 已由 status-final 证实） |
| `status-after.json` | §5.1（Lead 2026-10-28 00:34 转达的 /status 摘录） | ✅ 已有：`version=1.0.1`、`link(aliveTimeoutMs=120000, watchdogArmed=true)`、`device(online=true,state=NORMAL,source=hb)`；**摘录不含 counters** |
| `status-final.json` | `CHECKLIST.md §3`（用户 2026-10-28 00:51 贴回） | ✅ 完整 `/status`：含 `adapter.counters`、`link`、`commands`、`broker.clients=[wearable-sos-001]` |
| `logs-final.txt` | `CHECKLIST.md §3`（用户 2026-10-28 00:51 贴回） | ✅ 日志短码链：`SERVICE_STARTED/DEVICE_LINK_UP/COMMAND_ACCEPTED/COMMAND_PARKED/PARKED_RECOVERY_TRIGGERED/COMMAND_RECEIPT_ACCEPTED/COMMAND_RESULT_ACKED/DEVICE_UPLINK_TIMEOUT` |
| `markers.json` | 复制 `../markers-template.json` 填真实时刻 | ✅ C1/C2 人工时刻（sos_pressed / power_off / ack_click / power_on / restart，含 phase 标注与 ECS 佐证 note） |

规则：
- 不覆盖旧阶段文件；每个文件在 `../README.md` 的验收记录里都有对应时间与用途。
- **不要手工编辑 `/status` JSON 内容**（尤其不要把 `online`/计数改成期望值）——那会构成伪造证据。
- 无法提供某个文件就在汇报里写“缺”，`report` 会把对应判据判为 `BLOCKED`，这是正确的行为（本次 C1/C5 就曾经因此 BLOCKED，直到收到 `status-final.json`）。
