# ECS 侧：wearable-mqtt 1.0.1 部署与验收（task-7）

**状态：✅ 1.0.1 已部署并完成真实验收 —— 6 PASS + 1 BLOCKED（C4 位置，Lead 已裁决，现网无有效 fix、非本次回滚）；无 FAIL。**
最终报告：`reports/verify-20261028-005321-FINAL.md` / `.json`（2026-10-28 00:53 Asia/Shanghai）
**负责**：teammate `ecs-verify`（只读核验 + 脚本 + 文档）；**部署由用户通过阿里云 Workbench 执行**，本机无 SSH 凭据。
**结论口径**：本目录内所有“PASS/FAIL”都只对**真实证据**生效；没有证据的项一律 `BLOCKED`（见 `CHECKLIST.md`）。
**证据分类**：`真实证据`（本次实跑的生产 API / 1883 CONNACK 探测，带时间戳文件）与 `本地单测/MOCK`
（`tools/verify-wearable-101.js selftest`，输出在 `reports/_selftest-mock-not-evidence/`）严格分目录，不混用。

---

## 1. 交付物索引

| 文件 | 说明 |
|---|---|
| `reports/verify-20261028-005321-FINAL.md` / `.json` | **最终验收报告（结论以它为准）**：6 PASS + 1 BLOCKED（C4 已裁决），含每条判据的原始时间戳与证据 |
| `USER-WORKBENCH-ONEPAGE.md` | **给用户的一页纸**：上传→sha256→解包→`install-on-ecs.sh`→`/status` 检查→证据收集→回滚；每步含预期输出与失败处理（可整段复制到 Workbench） |
| `CHECKLIST.md` | 真实验收清单：ACK 重启窗口 / 离线 >120s / 无重复告警 / 位置 / 不代报 / 回滚；含判据、记录点、markers 格式 |
| `markers-template.json` | 人工时间标记模板（断电/上电/点确认），给 `report` 用；本次已填成 `ecs-output/markers.json` |
| `tools/verify-wearable-101.js` | 只读验收脚本：`snapshot` / `watch` / `preupgrade` / `probe` / `report` / `selftest` |
| `snapshots/` | 真实采样：`samples-*.ndjson`（API）、`mqtt-connack-*.json`（1883 探测）、`inspect-*.txt`（字段结构核查）、`watch-*.timeline.json` |
| `ecs-output/` | 用户从 ECS 贴回的证据（`status-after.json`、`status-final.json`、`logs-final.txt`、`markers.json`）+ 升级前官方基线 |
| `reports/` | 最终报告 + `_interim/`（同一验收的迭代快照，含一次判据引擎缺陷误报 FAIL 的说明）+ `_selftest-mock-not-evidence/`（MOCK）+ `_predeploy-dryrun-not-acceptance/`（引擎冒烟） |

## 2. 现状快照（真实证据，2026-10-28 00:24–00:27 Asia/Shanghai）

采样文件：`snapshots/samples-pre-deploy-20261028-002455.ndjson`（1 条）、
`snapshots/samples-pre-deploy-baseline-20261028-002503.ndjson`（4 条 × 30s）；
字段结构核查：`snapshots/inspect-pre-deploy-20261028-0028.txt`、`inspect-pre-deploy-fields-20261028-0030.txt`、
`inspect-pre-deploy-alert-keys-20261028-0031.txt`。

### 2.1 生产 API（`https://api.luxunacc.xyz`，只读）

- 登录 `POST /api/v1/auth/app` → 200（凭据取自 `competition/.secrets/app_guardian.txt`，未打印、未落盘）。
- `GET /api/v1/devices|/alerts|/location` → 均为 **200**。
- 设备列表 8 台；`esp32-sos` **存在且在线**：
  - `online=true`、`state=NORMAL`、`monitorOnline=-1`
  - `lastSeenTs` 在 90 秒内**连续推进**：`00:24:46.941 → 00:25:17.026 → 00:25:47.035 → 00:26:16.986`（≈30s 一步）
  - 结论：**4G→MQTT→适配器→后端 的上行链路当前是活的**（不是 10-27 早些时候“online=true 但 lastSeen 停在 18:37”的状态；
    也就是说旧 `online` 陈旧问题此刻没有体现，验收时仍必须用断电 >120s 主动制造）。
- 随身 SOS 告警（`deviceId=esp32-sos`）：**13 条**，全部 91 条告警中的一部分；无重复 alarmId。
  最近 5 条真实 ACK 耗时（1.0.0 现状，供升级后对比）：

  | alarmId | createdAt(+08:00) | acknowledgedAt(+08:00) | acknowledgedBy | 耗时 |
  |---|---|---|---|---|
  | sos-11-686d1dee | 2026-10-27 23:52:11.119 | 2026-10-27 23:52:42.948 | household-guardian | 32s |
  | sos-10-4a2b38da | 2026-10-27 23:47:00.138 | 2026-10-27 23:49:22.218 | household-guardian | **142s** |
  | sos-9-729e65b9 | 2026-10-27 23:45:09.368 | 2026-10-27 23:45:43.453 | household-guardian | 34s |
  | sos-8-fc452df6 | 2026-10-27 23:09:07.338 | 2026-10-27 23:12:21.303 | household-guardian | **194s** |
  | sos-7-b941b638 | 2026-10-27 22:52:32.478 | 2026-10-27 22:52:59.268 | household-guardian | 27s |

  → 1.0.0 的 ACK 耗时波动 27–194s，与“parked 后只能等 60s/5min 定时器”的既有结论吻合；升级后重启窗口应在 **≤30s**。
  另有 2 条更早的未确认遗留告警（`e-1793076169-1`、`e-1793022476-1`，`ackPending=false`、`acknowledgedAt=0`），属历史数据，**不处置**。
- **位置/GPS 现状（重要发现）**：`esp32-sos` 在
  - `GET /api/v1/devices` 中**没有 `gps` 字段**（实际字段：`id,deviceId,name,roomId,roomName,location,online,monitorOnline,state,lastSeenTs,sensors,csq`；`sensors={}`、`csq=null`）；
  - `GET /api/v1/location` 中**没有 `esp32-sos` 记录**（唯一记录是 `yed-home-gateway`，fixTime 2026-10-16）；
  - `/api/v1/alerts` 条目里也没有坐标字段。
  这与 `competition/docs/wearable-4g-map/DESIGN-CONTRACT.md §5.2`“现网 `/api/v1/location` 已支持并实测返回”的记录**不一致**。
  影响：`CHECKLIST.md §2-D` 无法用“升级后位置仍在”判 PASS，只能判“未丢失/如实降级”或 `BLOCKED`，需 Lead 决策（见 §6）。
- 当前**没有 PENDING 的 ACK**（随身 SOS 的 `ackPending` 全为 false）→ 现在是合适的升级窗口。

### 2.2 公网 1883（CONNACK 探测，真实证据）

文件：`snapshots/mqtt-connack-20261028-002503.json`。目标 `47.76.70.118:1883`，凭据取自
`competition/.secrets/wearable-mqtt.env`（未打印）。**只做 CONNECT→CONNACK→DISCONNECT**：
未 PUBLISH、未 SUBSCRIBE、**未使用白名单 clientId `wearable-sos-001`**（脚本有硬断言）。

| 用例 | clientId | 结果 | 含义 |
|---|---|---|---|
| 有效凭据 + 非白名单 ID | `probe-readonly-<rand>` | TCP 84ms，**CONNACK rc=5**（NOT_AUTHORIZED） | broker 公网可达 + **凭据有效**（否则是 rc=4）+ **Client ID 白名单生效** |
| 错误口令（对照组） | 同上 | CONNACK **rc=4**（BAD_USERNAME_OR_PASSWORD） | 证明鉴权确实在校验口令，不是“一律 rc=5” |
| 有效凭据 + 空 clientId | `""` | CONNACK **rc=2**（IDENTIFIER_REJECTED） | 协议层边界正常 |

**verdict=PASS**（三项全部符合预期）。这同时证明：探测方式不会顶掉在线 M100（白名单直接拒绝）。

### 2.3 线上 ECS 版本（未由本次核验）
本机没有 ECS SSH 凭据，**没有、也不能**执行任何 ECS 命令。因此“当前线上是 1.0.0”来自
`competition/evidence/2026-10-27-reconnect-dayu-sos/wearable-link/DEPLOY-PACKAGE.md` 与 Lead 交接记录（10-27 22:44），
并非本目录实跑证据。**1.0.0/1.0.1 的版本事实必须以用户 Workbench 的 `docker exec ... /status` 输出为准**
（`USER-WORKBENCH-ONEPAGE.md §0` 取“升级前”，`§4` 取“升级后”）。

### 2.4 官方「升级前基线」（Lead 指示，2026-10-28 00:32:02）

`ecs-output/before-upgrade-20261028-003201.json` —— 部署前的自洽基线证据（API 采样 + 1883 CONNACK 探测，坐标只留判定不存数值）；
同一时刻的 ndjson：`snapshots/samples-pre-upgrade-20261028-003201.ndjson`（部署后 `report --baseline` 直接用它）。

- `esp32-sos`: `online=true`、`state=NORMAL`、`lastSeen=2026-10-28T00:31:47.045+08:00`、`gpsFieldPresent=false`、`sensorsCount=0`
- 随身 SOS 告警 13 / 全部 91；无 PENDING；`sosLocation=null`（现网无位置记录）
- 1883：`rc=5`（有效凭据+非白名单 ID，99ms）/ `rc=4`（错口令对照，73ms）→ `mqttProbe=PASS`
- 同刻设备总览：`esp32-kitchen:true, dayu200-living:false, esp32-sos:true, esp32-bath:false`

### 2.5 部署记录（2026-10-28 00:33 前后，来源：用户 Workbench 输出经 Lead 转达）

> 说明：以下 ECS 侧事实**由用户在阿里云 Workbench 执行并贴回、Lead 转达**，teammate 无法独立核验（本机无 SSH）。
> 原始证据文件由用户进 `ecs-output/`；`version=1.0.1` 必须等用户 `/status` 落地后才算 C0 PASS。

- 升级前版本：`1.0.0`（依据 10-27 22:44 交付记录；用户 `/status` 待补）
- 备份目录：`/opt/eldercare/deploy/backup/wearable-20261027T163258Z`（= `2026-10-28 00:32:58 +08:00`），含 `wearable-src-before.tar.gz` → **回滚用这个时间戳**
- 容器 `eldercare-public-wearable-mqtt-1`：重建后 **healthy**；`/healthz 200`；`0.0.0.0:1883` 可连；仅映射 `1883/tcp`；backend/caddy 仍 running
- **容器内断连自愈回归测试全绿**，脚本打印 `wearable-mqtt 安装完成`
- 升级后 first-minute 观测（本目录真实 API 采样）：`00:34:05.962` 采样时 `esp32-sos online=true`，`lastSeen=00:33:47.019`
  → 容器重建后 **≤60s** 内 M100 已重连并有业务上行推进（全程未做 `docker restart`）

### 2.6 真实物理验收执行记录（C1 / C2，真实 API 采样）

采样：`snapshots/samples-ack-window-20261028-003456.ndjson`（83 帧，10s 间隔，00:34:57–00:50:03）；
人工时刻：`ecs-output/markers.json`。全程**未执行 `docker restart`**、未 publish、未代 ACK。

**C1 ACK 重启窗口（真实 SOS → 设备断电 → APP 确认 → 上电 → ACKED）**

| 时刻(+08:00) | 事件 / 观测 | 来源 |
|---|---|---|
| 00:35:45.905 | 用户按实体键，`sos-12-1a1003dc` 创建（MANUAL_SOS, esp32-sos） | API createdAt |
| 00:35:52.144 | 采样首见该告警（state=ALARM），esp32-sos 告警数 13→**14** | API |
| 00:36:46.984 | 设备最后一次有效上行（其后 ESP32 断电，M100 保持供电） | API lastSeen |
| 00:37:52.865 | **ackPending=true**（APP 点确认 ≈00:37:55） | API |
| 00:38:30 | 设备上电（现场记录） | markers |
| 00:38:32.754 | **acknowledgedAt**（ACKED / acknowledgedBy=household-guardian） | API |
| 00:38:37.170 | 采样首见 ACKED；lastSeen 推进到 00:38:32.769 | API |
| — | **上电→ACKED = 2.8s（≤30s）** | 判定 |

- 关键旁证：设备断电期间（00:36:46→00:38:30，约 103s **<120s**）API `online` **保持 true 未翻转** → 1.0.1 的去抖正确，短暂重启不会让 APP 闪离线。
- C1 时序 **PASS**；转正式 PASS 仍需 `/status` 的 `counters.commandResultOk` 增量（证明是设备真实回执，非代报）。

**C2 离线 >2 分钟（120s 阈值）**

| 时刻(+08:00) | 事件 / 观测 | 来源 |
|---|---|---|
| 00:38:52.370 | 设备最后一次有效上行（其后断电 >2min） | API lastSeen / markers |
| **00:40:52.373** | 后端 `lastSeenTs` 被**离线报告**刷新；`00:40:52.373 − 00:38:52.370 = 120.003s` → **120s 阈值精确生效** | API |
| 00:41:01.278 | 采样首见 **`online=false`**（lastSeen 冻结在 00:40:52.373） | API |
| ≈00:41:32 | 设备上电；lastSeen 首次推进到 00:41:32.698 | markers + API |
| 00:41:35.572 | 采样首见 **`online=true`**，lastSeen 已推进（上电→恢复 3.6s） | API |
| — | 采样 83 帧内 esp32-sos 告警数稳定 **14 条**、每 alarmId 唯一 → 无重复告警 | API |

- **C2 = PASS**；C3 = PASS；C6 = PASS（markers 声明 + 无额外容器启动）。

### 2.7 最终验收结论（`reports/verify-20261028-005321-FINAL.md/.json`）

**输入证据**：`snapshots/samples-ack-window-20261028-003456.ndjson`（83 帧）、`snapshots/samples-pre-upgrade-20261028-003201.ndjson`（基线）、
`ecs-output/status-after.json`、`ecs-output/status-final.json`（用户 Workbench 完整 /status）、`ecs-output/logs-final.txt`、`ecs-output/markers.json`。

| 判据 | 结论 | 关键实证 |
|---|---|---|
| C0 部署版本 | **PASS** | `version=1.0.1`、`link.aliveTimeoutMs=120000`、`watchdogArmed=true`、`broker.clients=["wearable-sos-001"]` |
| C1 ACK 重启窗口 | **PASS** | 上电(00:38:30)→ACKED(00:38:32.754)=**2.8s ≤30s**；日志链 `COMMAND_ACCEPTED 00:37:45.274 → COMMAND_PARKED 00:37:55.281 → **PARKED_RECOVERY_TRIGGERED 00:38:32.301** → COMMAND_ACK_SENT round=2 00:38:32.460 → COMMAND_RECEIPT_ACCEPTED 00:38:32.758 → COMMAND_RESULT_ACKED 00:38:32.777`；counters `parkedRecoveryTriggers=1, commandsRedelivered=1, commandResultOk=1, ackReceipts=1` → **事件驱动重投真实发生，无需 docker restart** |
| C2 离线 >120s | **PASS** | 最后上行 00:38:52.370 → 后端 lastSeen 被离线报告刷新 00:40:52.373（**≈120.0s**）→ 采样 00:41:01.278 首见 `online=false`；日志 `DEVICE_UPLINK_TIMEOUT 00:40:52.371 silentMs=120002`；`deviceOfflineReports=1`；上电后 00:41:35.572 `online=true` 且 lastSeen 推进（恢复 3.6s） |
| C3 无重复告警 | **PASS** | 83 帧内 esp32-sos 告警稳定 14 条、每 alarmId 唯一；`sosReceived=8 / sosDuplicates=7`（设备重试包被适配器去重，后端只建 1 条） |
| C4 位置/GPS | **BLOCKED** | 升级前后 API 均无 esp32-sos 位置数据；无 (0,0) 假坐标、无不实写入。**按 Lead 2026-10-28 00:31 裁决**：现网无有效 fix，非本次回滚造成，不阻塞升级、不改后端/APP；与 `DESIGN-CONTRACT §5.2` 记录不一致，另行登记 |
| C5 不代报 ACK | **PASS** | ACKED 与 `commandResultOk≥1` 同时成立；脚本与 teammate 全程未 POST ack / 未写 device-status |
| C6 全程未 docker restart | **PASS** | `markers.no_docker_restart=true`；`docker logs` 中 `SERVICE_STARTED` 仅 1 次（=升级自身重建），无第二次拉起 |

**overall = BLOCKED（仅因 C4 已裁决的 BLOCKED；其余 6 项全 PASS，无 FAIL）。**

补充说明：
- 秒级旁证：设备在 C1 窗口断电约 103s（<120s）时 `online` 保持 true 未翻转 → 1.0.1 的静默看门狗去抖正确，短暂重启不会让 APP 闪离线。
- `status-final.json` 里 `link.offlineReported=false` 是**采集时点状态**（00:50:56，设备早已恢复上电，恢复时的首个业务上行把 offlineReported 清零）；
  “确实上报过离线”由 `counters.deviceOfflineReports=1` 与日志 `DEVICE_UPLINK_TIMEOUT` 证明，两者不矛盾。
- 验收后仍在跑 `watch --label post-acceptance-stability`（20 分钟）作为在线稳定性/无重复告警的补充观测（结束时输出见 `snapshots/`）。

## 3. 部署与验收流程（谁做什么）
1. **用户**（Workbench）：按 `USER-WORKBENCH-ONEPAGE.md` 上传 → 校验 → 解包 → 安装 → `/status` 确认 → 把
   `status-after.json`、`logs-after.txt`、备份时间戳贴回 Lead。
2. **Lead**：把上述文件放进 `ecs-output/`，确认 `version=1.0.1`、`aliveTimeoutMs=120000`，然后通知 `ecs-verify` 开跑。
3. **用户 + Lead**：按 `CHECKLIST.md §2` 做真实物理动作（按键 SOS、断电重启、离线 >2min），记录时间并填 `markers.json`。
4. **ecs-verify**：跑 `watch` 采样 + `report`（含 `--baseline` 升级前采样、`--status`、`--logs`、`--markers`），
   输出 `reports/verify-<时间戳>-<PASS|FAIL|BLOCKED>.{md,json}`，附原始时间戳。
5. **回滚**由 Lead 决定，用户执行（`USER-WORKBENCH-ONEPAGE.md §6`）。

## 4. 只读脚本用法（速查）

```powershell
cd <WORKSPACE>\competition\evidence\2026-10-28-three-legacy-closures\ecs\tools
node verify-wearable-101.js selftest                     # MOCK 自检判据引擎（非生产证据）
node verify-wearable-101.js preupgrade                   # 官方升级前基线 → ecs-output/before-upgrade-<ts>.json + snapshots ndjson
node verify-wearable-101.js snapshot --label pre-deploy --count 1
node verify-wearable-101.js watch --label ack-window --duration 900 --interval 15
node verify-wearable-101.js probe                        # 1883 CONNACK（非白名单 clientId）
node verify-wearable-101.js report --samples <ndjson> --baseline <升级前 ndjson> --markers <json> --status <json> --logs <txt>
```

本地自检结果（2026-10-28 00:27，MOCK）：7 条判据 + 2 条负例全部符合预期 → `selftest PASS`（不是产线结论）。

## 5. 纪律与边界（本目录所有动作都遵守）

- 未上传/未部署/未重启任何 ECS 服务；未改 backend、未改 caddy、未改 `/opt/eldercare`。
- 未向 MQTT `eldercare/wearable/sos-001/up` 发布任何消息；未订阅；未使用 `wearable-sos-001` 连接（避免顶掉设备）。
- 只做 `POST /api/v1/auth/app` 登录 + `GET /devices|/alerts|/location`，未 ACK、未写 device-status、未造告警。
- 凭据只从 `competition/.secrets/**` 读取，不打印、不写日志、不写入任何证据文件。
- 证据文件里不保存精确经纬度（只保存 `hasCoordinates/valid/fixTime/(0,0) 判定`），避免位置数据外泄。

## 6. 阻塞与决策记录

1. **部署阻塞已解除**：用户 2026-10-28 00:33（+08）经阿里云 Workbench 完成 1.0.1 升级（备份 `wearable-20261027T163258Z`），
   验收已完成（见 §2.7 与 FINAL 报告）。本节保留当时的阻塞说明作为背景：ECS 只能用户操作，本机无 SSH 凭据，teammate 未上传/未部署。
2. **Lead 决策（2026-10-28 00:31）——位置/GPS 按选项②处理**：现网 `esp32-sos` 无有效定位
   （`/devices` 无 `gps`、`/location` 只有 `yed-home-gateway` 旧记录、告警无坐标）。本次升级验收把“位置”项记为
   **BLOCKED（现网无有效 fix，不是本次回滚造成）**，同时记录“升级前后均无坐标 / 无写入不实坐标 / 非 (0,0) 假坐标”；
   **不因此阻塞升级**，**不改后端/APP**。`report` 的 C4 判据已按此口径实现（基线无数据 → BLOCKED + 该说明）。
3. **提醒**：1.0.1 的 4G 长稳（>1h）仍未测；验收完需保持在线 ≥30min 观察 `hb` 节奏与无重复告警（`CHECKLIST.md §7`）。
