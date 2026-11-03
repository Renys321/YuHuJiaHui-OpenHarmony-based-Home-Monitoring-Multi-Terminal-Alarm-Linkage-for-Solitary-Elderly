# CHECKLIST — wearable-mqtt 1.0.1 真实验收（只读、不注入）

> **状态：待部署 / 未验收**（2026-10-28 00:40 Asia/Shanghai）。部署动作由用户按 `USER-WORKBENCH-ONEPAGE.md` 执行；
> 部署完成后由 Lead 通知 teammate `ecs-verify` 开跑。**本清单里的任何数据都必须来自真实设备与真实 API/日志，禁止造数据、禁止代报 ACK。**

## 0. 前置门槛（缺一不可，未满足则全场 BLOCKED）

- [ ] **C0 部署证据**：用户贴回的 ECS `/status`（JSON 文件）满足 `version=1.0.1`、`adapter.link.aliveTimeoutMs=120000`、
      `adapter.link.watchdogArmed=true`、`broker.clients` 含 `clientId=wearable-sos-001`。
      证据文件：`ecs-output/status-after.json`
- [ ] **容器 healthy 且只映射 1883/tcp**：用户贴回 `docker ps` 行或 `docker port`。
- [ ] **回归自检 PASS**：用户贴回安装日志里 `容器内回归自检结果: PASS`。
- [ ] 设备已上电（M100 NET 灯 1000ms 慢闪 + RDY 常亮；ESP32 已供电），APP 已登录（监护人账号/口令由用户本人输入，脚本与文档不记录）。
- [ ] 有人负责记录时间（手机/手表/电脑时间均可，**记录时区**为 Asia/Shanghai）。

## 1. 工具（只读）

| 工具 | 作用 | 边界 |
|---|---|---|
| `tools/verify-wearable-101.js snapshot` | 登录生产 API，把 esp32-sos 的 online/state/lastSeenTs 与随身 SOS 告警写成 ndjson | 只 POST `/auth/app` + GET `/devices|/alerts|/location` |
| `tools/verify-wearable-101.js watch` | 连续采样，记录 online 翻转/新 alarmId/ackPending→ACKED/lastSeen 推进 | 同上 |
| `tools/verify-wearable-101.js probe` | 用非白名单 clientId 探测 1883 的 CONNACK（预期 rc=5） | 只 CONNECT/CONNACK/DISCONNECT；**不 publish、不 subscribe、不用 wearable-sos-001** |
| `tools/verify-wearable-101.js report` | 采样 + `/status` + `docker logs` + 人工标记 → PASS/FAIL/BLOCKED | 只读本地文件 |
| `tools/verify-wearable-101.js selftest` | 用 MOCK 数据自检判据逻辑 | 输出目录 `reports/_selftest-mock-not-evidence/`，**不是验收证据** |

> **MQTT 只读订阅为什么不做**：broker 的 Client ID 白名单只允许 `wearable-sos-001`；用该 ID 连接会**顶掉**在线的 M100
> （broker 会踢掉旧连接），等于人为制造断连。因此本套验收**不订阅 up 主题**，上行链路死活用生产 API 的
> `lastSeenTs` 推进 + ECS `/status` 的 `adapter.lastUplinkAt`/`link` 字段 + 容器日志来证明。这是设计约束，不是遗漏。

### 1.1 生产 API 侦察（部署前后都必须留档）

```powershell
cd <WORKSPACE>\competition\evidence\2026-10-28-three-legacy-closures\ecs\tools
# 升级前官方基线（Lead 指示，已执行一次：ecs-output/before-upgrade-20261028-003201.json）
node verify-wearable-101.js preupgrade
# 单次快照
node verify-wearable-101.js snapshot --label <pre-deploy|post-deploy> --count 1
# 连续采样（例：15 分钟，每 15s 一次）
node verify-wearable-101.js watch --label <label> --duration 900 --interval 15
# 1883 CONNACK 探测（证明 broker 可达 + 凭据可用 + 白名单生效）
node verify-wearable-101.js probe
```

输出：`../snapshots/samples-<label>-<时间戳>.ndjson`、`../snapshots/mqtt-connack-<时间戳>.json`。
凭据从 `competition/.secrets/` 读取，**不打印、不落盘、不进日志**。

## 2. 验收项与判据

### A. ACK 重启窗口（本次修复核心，必须真实）

**场景**：真实 PENDING ACK 存在时，设备断电重启；1.0.1 应在链路恢复后**事件驱动立即重投**，无需 `docker restart`。

| 步 | 动作（真实物理动作，由用户执行） | 记录 |
|---|---|---|
| A1 | ESP32 上电在线，确认 APP 显示设备正常 | `t0` |
| A2 | **按一次实体 SOS 键**（不代按，用户自己按） | 按键时间 `t_sos`、蜂鸣是否立即响 |
| A3 | APP 中出现新告警，记录 `alarmId`（形如 `sos-<n>-<8hex>`）与创建时间 | `alarmId`、`t_created`、APP 截图 |
| A4 | 确认 APP 显示“**等待设备确认**”（`ackPending=true`），**先不要在 APP 点确认** | 截图 |
| A5 | **给 ESP32 断电 30–60 秒**（M100 保持供电），记录断电/上电时刻 | `t_off`、`t_on` |
| A6 | 在断电窗口内或上电后立刻在 APP 点“确认” | `t_ack_click`、APP 截图 |
| A7 | 观察 APP 是否变为“设备已确认”（ACKED），记录**首次看到 ACKED** 的时间；同时记录设备蜂鸣是否停止 | `t_acked_seen`、截图 |
| A8 | 全程**没有执行** `docker restart wearable-mqtt` | 在 markers 里写 `no_docker_restart: true` |
| A9 | 用户从 ECS 取 `/status` 与日志（见 §3） | `status-ack.json`、`logs-ack.txt` |

**判据（脚本自动判）**
- `PASS`：新 alarmId 出现 ACKED 且 `acknowledgedAt>0`；ECS `/status` 的 `counters.commandResultOk≥1`；
  存在 `device_restart`（或 `device_power_off`+`device_power_on`）标记；**自恢复点（点击/上电的较晚者）到 ACKED 观测 ≤30s**。
- `FAIL`：ACKED 距恢复点 >30s；或有 ACKED 但 `commandResultOk` 未增长（代报嫌疑，立即停手）。
- `BLOCKED`：没有新 alarmId / 没有 ACKED / 缺 `/status` / 缺时间标记。

### B. 离线 > 2 分钟（120s 阈值）

| 步 | 动作 | 记录 |
|---|---|---|
| B1 | ESP32 在线（`lastSeenTs` 每 ~30s 推进） | `t_online` |
| B2 | **ESP32 断电 > 2 分钟**（M100 保持供电） | `t_off` |
| B3 | 断电后持续 `watch`，等 API `online` 变 `false` | `t_offline`（脚本自动抓） |
| B4 | ESP32 重新上电 | `t_on` |
| B5 | 观察 `online=true` 恢复且 `lastSeenTs` 重新推进 | `t_recovered` |

**判据**
- `PASS`：出现 `online=false`，且距断电时刻 ≈120s（脚本允许 ±90s，即 ≥30s 且 ≤210s）；
  恢复后出现 `online=true` 且 `lastSeenTs` 比离线时更新。
- `FAIL`：`online` 一直 true（1.0.0 行为，说明没升级/没生效）；或恢复后 lastSeen 不前进。
- `BLOCKED`：采样未覆盖断电/上电窗口，或没有 `device_power_off` 标记且旧 lastSeen 无法定位。

### C. 无重复告警

- 同一 `alarmId` 在 `GET /api/v1/alerts` 只有 1 条；
- esp32-sos 告警总数只在出现**新 alarmId** 时增加，不因设备重启/MQTT 重连增加；
- 参考 `/status` counters：`sosReceived` 增加、`sosDuplicates` 只反映重复包（设备重试属正常），后端不应多出告警。

**判据**：`PASS`（每 alarmId 唯一 + 数量单调）/ `FAIL`（出现重复 alarmId 或数量跳变）/ `BLOCKED`（没有新告警可测）。

### D. 位置 / GPS 不因升级丢失

- 现网事实（2026-10-28 00:30 基线）：
  - `GET /api/v1/devices` 中 `esp32-sos` **没有 `gps` 字段**（字段为 id/deviceId/name/roomId/roomName/location/online/monitorOnline/state/lastSeenTs/sensors/csq，sensors 为空、csq=null）；
  - `GET /api/v1/location` 只有 `yed-home-gateway` 一条旧记录（fixTime 2026-10-16），**没有 esp32-sos**；
  - 告警条目录里没有坐标字段。
- 因此本项**不能**用“升级后位置还在”来 PASS：升级前基线就没有可比较的定位。判据改为：
  - `FAIL`：出现 `(0,0)` 冒充坐标，或升级前有 esp32-sos 位置记录、升级后消失且没有 `gps.valid=false` 的如实降级；
  - `PASS`：升级窗口内仍能读到有效位置/GPS，或明确 `gps.valid=false`（无 fix 的如实表达）；
  - `BLOCKED`：升级前后都没有数据 → **Lead 已于 2026-10-28 00:31 裁决按此记录**：即“现网无有效 fix（非本次回滚造成）”，
    同时记录“升级前后均无坐标 / 无写入不实坐标 / 非 (0,0) 假坐标”；**不因此阻塞升级，不改后端/APP**。
    （背景：现网 `/devices` 无 `gps`、`/location` 只有 `yed-home-gateway` 旧记录，与 `DESIGN-CONTRACT.md §5.2` 记录不一致，
    属文档/实现对账问题，单列不阻塞。）

### E. 不伪造确认 / 安全红线（全程）

- [ ] 设备未回执时 APP 只显示“等待设备确认/超时”，**从未**出现凭空 ACKED；
- [ ] 没有人手工 `POST /api/v1/alerts/<id>/ack` 以外的方式改状态；不手工写 device-status；
- [ ] 验收脚本与 teammate 全程未 publish 到 `eldercare/wearable/sos-001/up`、未用 `wearable-sos-001` 连接 broker；
- [ ] ECS 日志无连续 `DEVICE_STATUS_POST_FAILED` / `COMMAND_RESULT_POST_FAILED`。

## 3. 用户从 ECS 需要提供的证据（贴回 Lead，均不含密钥）

```bash
# 3.1 完整 /status（无密钥）
docker exec $(docker ps -qf name=wearable-mqtt) node -e \
  "fetch('http://127.0.0.1:8099/status').then(r=>r.json()).then(j=>console.log(JSON.stringify(j)))" \
  > /root/status-<阶段>.json ; wc -c /root/status-<阶段>.json

# 3.2 容器日志（结构化单行，无密钥）
docker logs --since 60m $(docker ps -qf name=wearable-mqtt) > /root/logs-<阶段>.txt 2>&1
grep -E 'PARKED_RECOVERY_TRIGGERED|COMMAND_RECEIPT_ACCEPTED|COMMAND_RESULT_ACKED|COMMAND_PARKED|DEVICE_UPLINK_TIMEOUT|DEVICE_LINK_UP|DEVICE_BOOT|SERVICE_STARTED' \
     /root/logs-<阶段>.txt | tail -60
```

- `<阶段>` 建议用：`after`（刚升级完）、`ack`（ACK 重启窗口做完）、`offline`（离线 >2min 做完）。
- 日志短码含义：`PARKED_RECOVERY_TRIGGERED`=事件驱动重投被触发；`COMMAND_RECEIPT_ACCEPTED`=收到设备真实回执；
  `COMMAND_RESULT_ACKED`=回写后端成功；`DEVICE_UPLINK_TIMEOUT`=静默超阈值上报离线；`DEVICE_LINK_UP`=M100 重新连上。

## 4. 人工时间标记（markers JSON）

复制 `markers-template.json` → 填真实时间（**必须是实际发生的时刻，不确定就写不确定，不要编**），
放进 `ecs-output/` 后传给 teammate。格式：

```json
{
  "no_docker_restart": true,
  "events": [
    { "t": "2026-10-28T01:10:00+08:00", "kind": "alert_ack_clicked", "alarmId": "sos-12-xxxxxxxx" },
    { "t": "2026-10-28T01:09:00+08:00", "kind": "device_power_off" },
    { "t": "2026-10-28T01:09:45+08:00", "kind": "device_power_on" },
    { "t": "2026-10-28T01:09:45+08:00", "kind": "device_restart" },
    { "t": "2026-10-28T02:00:00+08:00", "kind": "deploy_done" }
  ]
}
```

`kind` 允许值：`device_power_off` / `device_power_on` / `device_restart` / `alert_ack_clicked`（带 `alarmId`）/
`deploy_done` / `note`（自由文本）。

## 5. 生成报告（部署后执行）

```powershell
cd <WORKSPACE>\competition\evidence\2026-10-28-three-legacy-closures\ecs\tools
node verify-wearable-101.js report `
  --samples  ..\snapshots\samples-post-deploy-<时间戳>.ndjson `
  --baseline ..\snapshots\samples-pre-upgrade-20261028-003201.ndjson `
  --markers  ..\ecs-output\markers.json `
  --status   ..\ecs-output\status-after.json `
  --status   ..\ecs-output\status-ack.json `
  --logs     ..\ecs-output\logs-ack.txt
```

输出 `../reports/verify-<时间戳>-<PASS|FAIL|BLOCKED>.md` + `.json`，逐项含原始时间戳。
**任何一项目前没有真实证据就必须是 BLOCKED，不允许手改成 PASS。**

## 6. 回滚（验收失败或不通过时）

按 `USER-WORKBENCH-ONEPAGE.md §6` 回滚到 1.0.0；回滚**不删数据卷、不动 backend/caddy、不删备份目录**。
回滚后本清单全部项回到“未验收”状态，需要在 Lead 决定后重新部署再验收。

## 7. 当前已知限制（不要当成 PASS）

1. 1.0.1 的「4G 长稳 >1 小时」本轮仍未测（README §8.6 第 4 条）。
2. 后端 `lastSeenTs` 语义是“服务器收到最后一次状态上报的时间”，离线报告会刷新它 → **APP 必须看 `online` 字段**才能判断实时性；
   这是 backend/APP 侧语义，本次不改公网后端。
3. `esp32-sos` 位置/GPS 在现网 API 里当前完全不可见（见 §2-D），与 `DESIGN-CONTRACT.md §5.2` 记录不一致，需 Lead 决策。
4. MQTT 只读订阅不可行（白名单约束），up 主题的字节级证据只能来自设备侧串口或 /status 计数。
