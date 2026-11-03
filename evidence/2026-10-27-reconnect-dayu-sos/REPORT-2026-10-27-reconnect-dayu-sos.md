# 断连恢复 + DAYU 随身 SOS + 客厅无 PIR 交付报告（2026-10-27 晚）

分类标注：**REAL=真机现场，MOCK=本地/模拟测试，BLOCKED=受环境/权限阻塞，PARTIAL=部分完成**。
本报告不包含任何密钥、口令、Token、INGEST_KEY 或 Wi-Fi 密码。

## 1. 任务与结论

| # | 任务 | 结论 | 关键证据 |
|---|---|---|---|
| 1 | 房间 ESP32 断开重启后 APP/DAYU 自动恢复 | **REAL 通过**（无需重启任何服务） | §4.2/§4.3 时间线；`lead/dayu-kitchen-offline.*`、`dayu-kitchen-recovered.*`；后端 online=false→true |
| 2 | DAYU200 显示同一条随身 SOS（同 alarmId/状态/位置/ACK） | **REAL 通过** | 真实 sos-8-fc452df6：APP 与 DAYU 同源；`lead/dayu-sos-tab-final.jpeg`、`lead/app-sos8*`、后端 API 快照 |
| 3 | 客厅无 PIR 不再产生 NO_MOTION | **REAL 通过（源头修复）+ MOCK 单测** | homemon 22:57:36 起 0 条新 NO_MOTION；`sensors.motion.supported=false`；台架 53/53 |
| 4 | APP 陈旧数据语义 / 客厅文案 | **REAL（模拟器安装运行）** | APP 1.0.10 已安装；客厅显示“未配置 PIR，无活动监测”“无活动告警（未配置 PIR，来源需核实）” |
| 5 | 随身 4G 适配器 ACK 自愈修复 | **代码/测试/补丁包完成；部署 BLOCKED** | 49/49 单测；补丁包 SHA-256 §5.4；ECS Workbench 未能登录 |

## 2. 根因

### 2.1 「ESP32 断开重启后 APP 收不到」（任务1）
- 房间节点本身在网络恢复后能自动重连（PC 22:16 切回 `ElderCareLab` 后 kitchen/bath 立即恢复、DAYU 3/3→4/4）。
- **真正断点：`public-sync` supervisor+worker 于 2026-10-27T08:25:04.738Z（本地 16:25:04）被同一控制台事件终止**（`public-sync-supervisor.log` 末行 `WORKER_EXIT code=3221225786`=0xC000013A/STATUS_CONTROL_C_EXIT，之后无任何重启行），MQTT 有数据、公网后端与 APP 停在旧数据。
- **watcher 假健康 + stale lock 双锁死**：`demo-autostart.ps1` 的 `Get-P0Health` 只读 state.json 的 `state=HEALTHY` 字符串，不校验 PID/心跳；`Ensure-P0` 用 `Test-Path lock` 判断，死 PID 29048 的锁文件永久存在 → 16:25→22:23 **0 次**尝试拉起。
- **relay 通道健壮性不足**：无 keepalive/半开检测、断线期间状态静默丢弃；日志无时间戳；裸 TCP 探测被记为“无线节点接入/断开”污染时间线；无单实例锁；command-sync 不按 deviceId 过滤（会抢领 `esp32-sos` 的 ACK）。
- **APP 侧陈旧语义**：请求失败时旧 online/旧读数不重算；无 onPageShow 刷新；lastSeenTs 接受 0/负数并显示“刚刚”。

### 2.2 「DAYU200 没有随身 SOS」（任务2）
- 根因证实：`esp32-sos` 走 **4G→ECS→公网后端→APP**，完全不经过 PC bridge/homemon；DAYU 本地链路只有 `dayu200-living/esp32-kitchen/esp32-bath` 三个 deviceId，从未出现 `esp32-sos`。ECS MQTT broker 另有 clientId 严格白名单（新增 mirror clientId 会被拒，复用设备 ID 会踢掉 M100），因此不能直订。
- 方案：新增 PC 侧 **wearable-mirror**（零依赖），数据源用**现有监护人账号只读轮询公网 APP-API**（与手机 APP 同源同 alarmId/ACKED/位置），经 `relay <json>` 注入 DAYU homemon，再由 homemon 广播给 DAYU APP。

### 2.3 「客厅长时间无活动」（任务3）
- 根因证实：`homemon.c` 无条件用 `idle = now - last_motion_ms` 判定 NO_MOTION；客厅 `motion_cnt=0`（无 PIR）时 `last_motion_ms` 只在启动赋一次值，+`no_motion_sec=1800s` 必报。现场 `a-1793075253-1`（12:27:33）与 homemon 启动 11:57:33 **恰好差 1800s**，且 bridge 最近 200 条 dayu200-living 全为 ALARM。
- 摄像机人体判定是独立能力，不得当作 PIR 活动数据。

## 3. 修复清单

| 组件 | 修改 | 版本/哈希 |
|---|---|---|
| bridge | `competition/bridge/mqtt_bridge.js`：ISO 日志；relay keepalive 10s+有界退避+断线缓存补发；MQTT 重连重放；`--relay-ignore esp32-sos`；裸探测降噪；`--lock-file` 单实例 | 新代码运行中（PID 48108，直连 `10.127.130.250:9000`） |
| public-sync supervisor | 有界熔断（60s 后重试）；`evaluateSupervisorHealth`+`--check`；BOM 容忍 | 运行中 supervisor 40628/worker 56416 |
| command-sync | ACK 设备白名单（只承接 dayu200-living/esp32-kitchen/esp32-bath，其他只推进游标） | 已随 P0 重启生效 |
| demo-autostart | P0 五要素存活判定（端口+PID+worker+HEALTHY+心跳≤90s）；陈旧锁可拉起；30min 最多 6 次 | 代码已改，运行实例为旧版（下次启动生效） |
| start-demo-supervisor.ps1 | 陈旧状态诊断；`-StatusTcp/-RelayTo/-RelayIgnore`；homemon 哈希守卫更新为修复版 | 已修 UTF-8 BOM（原先无 BOM 导致 PS5.1 解析失败） |
| homemon | 无 PIR 时源头关闭 NO_MOTION 与活动间隔 WARN；新增 `sensors.motion.{supported,reported,reason}`；`lastActiveTs=0`；MAX_CLIENTS 4→8；时钟跳变平移；拆分 `motion_gate.h`/`judge_logic.h` | arm32 177,704 B `F6F4497C57492CA00F9AC70BF9A00330EBD5C658E2C134EAE006CB5F0DE2899B`（已部署 22:57） |
| DAYU APP | 1.0.5：随身求助全局横幅+设备卡（来源/事件时间/告警状态/GPS 状态+定位时间/ACK 状态，“暂无定位”），告警房间归属取告警自身 deviceId（修“切 tab 房间标签错误”），PIR 未配置文案，不提供本机 ACK | signed HAP 1,373,680 B `7EE16A97E9D761A5B6BD74DFDE638B958A522962ECD1E621E3DCE0868849FDFF`（已安装） |
| wearable-mirror | 新目录 `competition/cloud/wearable-mirror/`：api/mqtt 双源、relay/tcp 双通道、同 alarmId 单条、ACKED 仅真实回执/后端 ACKED、无 fix 不写假坐标、10s 心跳、重连补发、单实例锁 | 运行中 PID 56140，`--source api --transport relay --relay-to 10.127.130.250:9000` |
| 手机 APP | 1.0.10：失败时按当前时间重映射缓存 DTO（>90s 离线/上次读数）；lastSeenTs 0/负/超前拒绝；onPageShow 12s 刷新策略；客厅 PIR/摄像头分离文案 | unsigned debug 3,608,373 B `643E323A5327C83C594119CCD9B9B961D1FC79443BC960CA0627124F7AB3F0D7`（已装模拟器） |
| wearable-mqtt（ECS） | 1.0.1：设备重新上线立即重投 parked ACK；120s 静默看门狗 online=false；boot 保 ALARM；parked 缺项保留；状态持久化；部署 `--force-recreate` | 补丁包 90,027 B `D118A41A8A2ECA8F6317C926DCF6FC70B07A1325F47917ECCC2E69B173A68C8B`（**未部署**） |

## 4. 现场真实验收记录（Asia/Shanghai）

### 4.1 APP 恢复接收（P0 重启）
- 22:25 前：MQTT 有新状态，后端/APP 停在 16:25/18:37 旧数据。
- 22:29:56 新命令启动 supervisor；22:30:04 worker；**22:30:06 起三设备 `cloud-sync OK ... status=202` 连续出现**。
- 22:30:40 / 22:31:17 两次只读 API 快照：kitchen/bath/dayu200-living/esp32-sos lastSeen 均向前推进。
- 22:31:36 APP 截图：`22:31 更新`、`4/4 在线`、bath 真实未确认 SOS“刚刚”。

### 4.2 厨房节点真实断电→上电（第一次，22:46–22:48）
| 时间 | 事实 |
|---|---|
| 22:46:25 | kitchen 最后一条 MQTT 状态 |
| 22:46:43 | 后端 `esp32-kitchen online=false`、lastSeen 冻结 22:46:40 |
| 22:48:02 | kitchen 新状态恢复（NORMAL，新 ts） |
| 22:48:14 | 后端 `online=true`、lastSeen=22:48:14（APP 数据恢复） |

### 4.3 厨房节点断电→上电（第二次，带 DAYU 离线取证 23:16–23:19）
| 时间 | 事实 |
|---|---|
| 23:16:5x | 用户拔掉 COM5 供电 |
| 23:17:03 | DAYU：`全屋在线 4/4` |
| 23:17:47 | DAYU：`全屋在线 3/4`；厨房页 `已选设备离线：以下为最后一次上报的历史读数，不代表当前状态`（截图 `dayu-kitchen-offline.jpeg`） |
| 23:19:1x | 用户插回；后端 kitchen `online=true`、lastSeen=23:19:13 |
| 23:19:22 | MQTT kitchen 新状态 |
| 23:19:5x | DAYU：`厨房 · 已选设备在线`、`全屋在线 4/4`（截图 `dayu-kitchen-recovered.jpeg`） |

全程**未重启 broker/bridge/homemon/public-sync/mirror**，节点自行恢复。

### 4.4 真实随身 SOS 双端同源（23:09–23:12）
| 项 | 值 |
|---|---|
| 按下按钮 | 23:09:07（蜂鸣器响） |
| 设备 alarmId | `sos-8-fc452df6`（MANUAL_SOS / esp32-sos / 随身求助） |
| mirror 检测 | 23:09:08（`phase=ALARM`，`gpsSource=none`） |
| APP | 出现“随身求助·设备 esp32-sos / 检测到异常”；详情显示“求助位置：暂无定位” |
| DAYU | “随身求助 来源 esp32-sos · 事件 23:09 · 设备已确认 · 定位：暂无定位（设备未回传有效坐标）” |
| 用户在 APP 确认 | 23:12（`acknowledgedBy=household-guardian`，`acknowledgedAt=23:12:21`） |
| 设备真实回执 | 后端 ACKED 只会在适配器收到设备 `t=ack` 后写入；mirror 显示 `ackedBy=device-ack-via-backend` |
| DAYU ACK 展示 | “设备已真实回执（ACK）确认时间：23:12” |

证据：`lead/dayu-final-sos8.jpeg`、`lead/dayu-sos-tab-final.jpeg`、`lead/dayu-sos-tab-final-texts.txt`、`lead/app-sos8.jpeg`、`lead/app-acked.json`、`lead/*final-check.json`。

### 4.5 客厅无 PIR（homemon 22:57:36 部署后）
- 状态：`state=NORMAL`、`alarm.id=""`、`sensors.motion={lastActiveTs:0,countToday:0,supported:false,reported:false,reason:"not_configured"}`（`lead/…` 与 MQTT 快照）。
- homemon 日志：`活动监测能力：配置 0 路 PIR，启动自检可读 0 路 → NO_MOTION=关闭`。
- 后端：22:57:36 部署后观察至 **23:30:01（33 分钟，超过 1800s 阈值）**，`dayu200-living` 新增 NO_MOTION = **0 条**，状态保持 NORMAL；历史 21 条全部保留（最新一条 22:39:29，修复前）。
- DAYU 客厅页：`未配置 PIR，无活动监测`、`未配置 PIR，无活动监测（不判定“长时间无活动”）`、`该房间的人员活动来自摄像头视觉`；摄像头卡显示 `监护运行中 · FRONT · 640×480`（独立能力）。
- APP：客厅告警标题 `无活动告警（未配置 PIR，来源需核实）` + 能力核对说明；瓦片“未配置 PIR，无活动监测”。

## 5. 构建/安装/回滚

### 5.1 DAYU 200
- 版本 1.0.5/1000005（构建源为线上 1.0.4 同一工作副本 `competition/experiments/dayu-eldercare-preview-integration-2026-10-25`，未改 `northbound` 旧线）。
- 已 `hdc install -r` 覆盖安装，数据保留；APP pid 22626。
- 回滚包：`competition/evidence/2026-10-27-battery-video-visit/dayu-1.0.4/dayu-eldercare-video-1.0.4-signed.hap`（1,353,199 B / `05230657B89B7D8AFE29C7F94AEC57639887F706725C005603E024B3DA68CF60`），命令 `hdc -t 4501… install -r <回滚包>`。

### 5.2 homemon
- 板端备份：`/data/homemon/homemon.rollback-20261027-2257`、`/data/homemon/homemon.conf.rollback-20261027-2257`；本地副本在 `homemon-nomotion/board-backup/`。
- 回滚：kill 新 PID → `cp -p` 回滚文件覆盖 → 启动 `/data/homemon/homemon /data/homemon/homemon.conf`（回滚后旧 bug 30min 复报）。
- `start-demo-supervisor.ps1` 的 `$HomemonSha` 已更新为新哈希，避免后续启动被守卫拒绝。

### 5.3 手机 APP
- 1.0.10 已覆盖安装模拟器（安装前 1.0.9 已记录）。回滚：`competition/evidence/2026-10-27-battery-video-visit/app/guardian-battery-video-1.0.9-unsigned.hap`。

### 5.4 ECS wearable-mqtt（**未部署**）
- 补丁包：`competition/deploy/wearable/release/wearable-reconnect-fix-v1.0.1.tar.gz`，90,027 B，`D118A41A8A2ECA8F6317C926DCF6FC70B07A1325F47917ECCC2E69B173A68C8B`。
- 部署/回滚命令：`competition/evidence/2026-10-27-reconnect-dayu-sos/lead/USER-ACTIONS-ECS-AND-P0.md`（Workbench 上传 → sha256 → `install-on-ecs.sh`；回滚 `rollback-upgrade.sh --backup …`）。
- 阻塞原因：本机无 ECS SSH 凭据，用户未能登录阿里云 Workbench。

## 6. 测试（本地，非真机）

| 组件 | 结果 | 证据目录 |
|---|---|---|
| bridge | 30/30（含 relay 恢复补发、`--relay-ignore`、MQTT 重连重放、单实例锁） | `room-relink/logs/` |
| public-sync/command-sync | 194/194（含 supervisor 6 + 命令作用域 5） | `room-relink/logs/` |
| homemon host 单测+台架 | 单测 24/48/31/climate + windows 台架 53/53 | `homemon-nomotion/` |
| wearable-mqtt | 49/49（新增 8 项断连自愈） | `wearable-link/logs/` |
| wearable-mirror | 37/37（fake broker/api/homemon） | `dayu-sos/mirror/` |
| 手机 APP | tsc 0 error；Node 528/528 | `app-ui/logs/` |

## 7. 未解决 / 阻塞 / 风险

1. **ECS 适配器 1.0.1 未部署**（BLOCKED：Workbench 登录/上传未完成）。因此「ACK 在设备重启窗口自动重投、离线>2min 自动 online=false」只有本地 49/49 单测，**真机未复验**。
2. **公开后端不透传新 motion 字段**：`GET /api/v1/devices` 的 `sensors.motion` 仍只有 lastActiveTs/countToday（backend 未改，**刻意不重新部署公网 backend**）；APP 侧用固定能力表判断客厅无 PIR，显示正确；DAYU 侧由 homemon 直连字段驱动。
3. **DAYU 的 USB/HDC 反复掉线**（22:46、23:09 两次），期间靠局域网仍工作；重插后恢复。属现场线缆/接口环境问题，未定位到单一硬件根因。
4. **bridge 直连拓扑依赖 DAYU 当前局域网 IP** `10.127.130.250`；IP 变化需改启动参数（`-StatusTcp/-RelayTo`）。本次已把该风险写入脚本注释。
5. **watcher 修复尚未在运行实例生效**（demo-autostart 进程是修复前启动的，下次重启生效）；P0 无法在无人值守下自动输入 INGEST_KEY，这是既有安全设计（key 只内存、不落盘）。
6. **northbound 与 experiments 双源码线**：DAYU 1.0.5 从 experiments 副本构建（与线上 1.0.4 一致），`competition/northbound` 是 1.0.0 旧线未回填；后续需统一。
7. 历史告警未删除/未 ACK/未改写；本次未清除任何历史记录。`esp32-sos` 的 SOS 历史（sos-2..sos-8）全部保留。

## 8. 证据目录

`competition/evidence/2026-10-27-reconnect-dayu-sos/`
- `lead/`：现场截图（DAYU 4/4、离线、恢复、随身 SOS 横幅/卡片；APP SOS 列表）、MQTT/API 连续快照（`live-monitor.ndjson`、`prod-snapshot.js`）、验收计划与用户操作单、API 最终快照。
- `room-relink/`：根因报告、bridge/supervisor 测试日志。
- `wearable-link/`：适配器根因、49/49 测试、补丁包与部署/回滚、4G 真机验收清单。
- `homemon-nomotion/`：根因、diff、单测/台架日志、二进制哈希、部署/回滚、板端备份。
- `dayu-sos/`：根因、mirror 源码/单测、1.0.5 HAP/签名/构建记录、安装回滚、修复前基线布局与截图。
- `app-ui/`：APP 审计/修复/测试/构建/截图。

## 9. 运行态交接（2026-10-27 23:33 最终状态）

| 进程/组件 | PID/版本 | 说明 |
|---|---|---|
| mqtt_broker | 27820 | 127.0.0.1:1883 |
| mqtt_bridge | 48108 | 新代码；`--status-tcp 10.127.130.250:9000 --relay-to 10.127.130.250:9000 --relay-ignore esp32-sos`（直连 DAYU 局域网） |
| public-sync supervisor / worker | 40628 / 56416 | 新代码（有界熔断、ACK 设备白名单）；INGEST_KEY 由用户在窗口内输入，内存中 |
| DAYU homemon | 23450 | 修复版 `F6F44…`；`supported=false`、MAX_CLIENTS=8 |
| DAYU APP | 1.0.5 / 1000005 | 已安装；APP pid 22626 |
| wearable-mirror | 58932（WMI 分离进程，非本 AI 会话子进程） | `--source api --transport relay --relay-to 10.127.130.250:9000`；`mirror.log`/`mirror.err.log` 在 `cloud/wearable-mirror/runtime/` |
| 手机 APP | 1.0.10（模拟器） | 已覆盖安装，回滚包见 §5.3 |

**现场重启顺序（用户操作）**
1. 双击 `<WORKSPACE>\competition\materials\start-demo-supervisor.cmd`，在隐藏提示输入一次 INGEST_KEY；等待 `HEALTHY` 与三设备 202（该脚本会按需拉起 broker/bridge/homemon/fport 并复用健康实例）。
2. 启动 mirror（独立进程，勿放在会被关闭的终端里跑）：
   `powershell -ExecutionPolicy Bypass -File <WORKSPACE>\competition\cloud\wearable-mirror\scripts\start-mirror.ps1 -Transport relay -RelayTo <DAYU局域网IP>:9000`
   若 hdc fport 正常可省略 `-RelayTo`（默认 127.0.0.1:9001）。
3. DAYU 打开正式 APP，确认“全屋在线 4/4”和“随身求助”tab；按一次真实 SOS 时 APP/DAYU 会显示同一 alarmId。
4. 停止 mirror：`scripts\stop-mirror.ps1`；不要用 Taskkill 直接杀，先走 stop 脚本清锁。

**拓扑注意**
- bridge 与 mirror 都使用 DAYU 局域网 IP（当前 `10.127.130.250`）。DAYU Wi‑Fi 重连后若 IP 变化，需要把 bridge 的 `-StatusTcp/-RelayTo` 与 mirror 的 `-RelayTo` 同步改成新 IP；或改用 hdc fport（`hdc -t <target> fport tcp:9001 tcp:9000`）并让 mirror 用默认 127.0.0.1:9001。
- DAYU 的 USB/HDC 现场偶尔掉线（22:46、23:09、23:30 三次），不影响局域网数据链路；需要安装/截图时重新插紧或换 USB 口。
- 未处理的历史告警保持原状（含 `esp32-bath` 的 `e-1793109878-1` ALARM、`dayu200-living` 的历史 NO_MOTION `a-1793111963-2` 等），未删除、未 ACK、未改写。

## 10. 追加需求：DAYU 随身求助横幅改造（2026-10-27 23:44–23:52，REAL）

用户反馈：“求助放在上面，但是不能关闭很难看的，改掉”。已构建并安装 **1.0.8 / 1000008**（基于活树 1.0.7，保留视频 Wi-Fi 改动）。

| 场景 | 1.0.8 行为（真机实测） | 证据 |
|---|---|---|
| 无事件（NORMAL 且无近期事件） | 顶部**完全不显示横幅**、不占位；页面干净 | `lead/dayu-108-noevent.jpeg`、`dayu-108-noevent-texts.txt` |
| ALARM/待处理 | 44px 细条：`! 随身求助 · 待处理 23:47 [查看] [收起]`；随身求助 tab 显示红点 ● | `lead/dayu-108-alarm3.jpeg`、`dayu-108-alarm3-layout.json` |
| 点“收起” | 折叠为 40px 小胶囊（`! 随身求助 · 待处理 23:47 [展开]`），不整条消失，红点保留 | `lead/dayu-108-collapsed.jpeg` |
| ACKED/已确认 | 44px 浅色细条：`✓ 随身求助 · 已确认 23:49 [×]` | `lead/dayu-108-acked.jpeg` |
| 点 × | 横幅完全隐藏；12 秒后（mirror 持续心跳/重发 ACKED）**同 alarmId 不再弹出** | `dayu-108-dismissed-layout.json`、`dayu-108-dismissed-12s.json` |
| 重启 APP | 关闭状态持久化，仍不显示；新 alarmId 会重新显示 | `lead/dayu-108-restart-persist.json` |

- HAP（signed）1,385,967 B `31261D17F4F43F17F3E188D6A84B907D35DEE71FAE941C9E835D3058A19EE33E`；回退：1.0.6 `D1E7D934…832D04`（video-wifi）或 1.0.5 `7EE16A97…49FDFF`。
- 关键集成修复：mirror 原默认心跳 10s，与 DAYU 对 relay 设备的离线阈值太接近，实测出现 `esp32-sos` 在线/离线抖动、横幅不出现；已把 mirror 默认心跳改为 **5s**（`src/config.js` 默认值 + `scripts/start-mirror.ps1 -HeartbeatMs`），mirror 单测 37/37 通过，真机恢复稳定（`dayu-108-alarm3` 起全程在线）。
- 建议（未改）：DAYU 侧对 `esp32-sos` 这类 relay 设备的离线阈值可提到 20–30s，避免上游偶发停顿导致闪离线；需下次构建合并。
