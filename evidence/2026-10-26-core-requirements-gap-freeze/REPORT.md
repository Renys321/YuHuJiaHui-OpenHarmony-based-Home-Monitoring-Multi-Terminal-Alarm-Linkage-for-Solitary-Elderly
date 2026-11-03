# CORE-REQUIREMENTS-GAP-FREEZE — 五项原始要求 A–E 需求矩阵与特别核实

- 日期：2026-10-26（Asia/Shanghai）；主要取证时段 01:45–02:05。
- 任务：`task-1` CORE-REQUIREMENTS-GAP-FREEZE（owner: gap-auditor，只读）。
- 性质：**只读审计 / 缺口冻结**，不是新一轮实现或重新验收。
- 写盘范围：仅本目录（`competition/evidence/2026-10-26-core-requirements-gap-freeze/`）新增 `REPORT.md` 与 `SOURCE-REFS.txt`。
- 未修改任何业务代码/配置；未打开串口；未运行 hdc install/flash；未操作设备；未触发告警/ACK/reset；未发布 MQTT；未发 HTTP ingest；未改公网 backend/DNS/WiFi。
- 未读取、未输出任何真实密码 / Token / Authorization / Cookie / INGEST_KEY / 私钥 / 签名口令。凭据类结论只写“已配置/未配置”。

## 0. 快照声明（必读）

本轮审计期间，工作区存在**外部并行会话**的写入（Lead 已确认为独立会话，不是本任务团队成员）。因此本报告一律按“读取时刻的事实”记录，并对受影响项显式标注 **外部并行会话进行中（未验收）**。

涉及外部并行会话的两条主线：

1. **ACK 处置结果 + 安全日志**（`competition/cloud/backend/src/safety-log.js`、schema v6 `safetyLogs`、APP `AlertDetailPage`/`LogPage`、`competition/evidence/2026-10-26-alert-disposition-safety-log/`）：**进行中、未验收**。不得写成“已实现/已验收”。
2. **卫生间本地语音部署**（`competition/evidence/2026-10-26-bathroom-local-voice/`，涉及 COM4）：文件可能仍在变化。卫生间是否已部署**以本报告读取时刻的证据文件为准**；本轮读取时该目录只有 `BACKUP-AND-IDENTITY.md` + `bathroom-voice-volume30.patch`，**没有任何烧录记录 → 记为未部署**（并注明“并行会话进行中 / 可能变化”）。

另：外部并行会话另写了一份类似矩阵到 `competition/evidence/2026-10-26-core-gap-freeze/`（**不同目录**）。本报告**未复用、未覆盖**它；本任务交付只在 `competition/evidence/2026-10-26-core-requirements-gap-freeze/`。

本轮审计实际观察到的并发修改（时间戳为文件 LastWriteTime）：

| 文件 | 观察到的修改时间 | 影响 |
|---|---|---|
| `competition/cloud/backend/src/safety-log.js` | 01:46:09 | 新增处置/安全日志纯逻辑 |
| `competition/cloud/backend/src/store.js` | 01:46:23 | 新增 `createDisposition/listDispositions/listSafetyLogs` |
| `competition/cloud/backend/src/persistent-store.js` | 01:47:15 | schema v6 `safetyLogs` 持久化 |
| `competition/cloud/backend/src/server.js` | 01:47:27 | 新增 `POST/GET /api/v1/alerts/{id}/dispositions`、`GET /api/v1/safety-logs`（`server.js:667-728`） |
| `APP/ElderlyCareGuardian/.../ApiClient.ts` | 01:46:05 | 新增处置/安全日志客户端 |
| `APP/ElderlyCareGuardian/.../GuardianService.ets` | 01:46:28 | 新增 `createDisposition`/`loadSafetyLogs` |
| `APP/ElderlyCareGuardian/.../AlertDetailPage.ets` | 01:47:32 | 新增“处置结果”面板 |
| `APP/ElderlyCareGuardian/.../LogPage.ets` | 01:48:26 | 新增“告警记录 / 安全日志”切换 |
| `APP/ElderlyCareGuardian/.../Contracts.ts` | 01:49:06 | 新增 `DispositionDto` / `SafetyLogDto` |
| `competition/cloud/backend/test/safety-log-persistent.test.js` | 01:49:15 | 新增持久化测试（**本轮未运行**） |
| `competition/cloud/backend/test/safety-log-isolated.integration.js` | 01:49:46 | 新增隔离集成测试（**本轮未运行**） |
| `competition/cloud/backend/test/safety-log-api.test.js` | 01:51:20 | 测试文件继续被写入（**本轮未运行**） |
| `competition/evidence/2026-10-26-alert-disposition-safety-log/isolated-verify.js` | 01:46:53 | 新增隔离验证脚本 19,623 B（**本轮未运行**） |

结论：**D 组的“独立处置结果 + 可持久化安全日志”在审计瞬间属于“外部并行会话进行中（未验收）”**：源码与测试文件在不断新增，但本轮没有构建、没有跑测试、没有装真机、没有公网验收。本报告对该组一律按“已实现但未真实验收 / 并行会话进行中”判定，**不作为冻结基线**。

补充边界：`2026-10-26-bathroom-local-voice/` 在本次读取（约 01:52）时仍只有 2 个文件（备份/身份文档 + volume30 补丁），无部署 JSON、无串口日志、无写后校验记录 → 卫生间仍按“未烧录”记录；若并行会话随后完成烧录，应以**其**新产生的原始证据重新判定，本报告不追认。

## 1. 判定口径

五类状态（每个子项只取一个）：

| 标记 | 含义 |
|---|---|
| ✅ | 已实现且真实验收（有人/设备参与的原始证据） |
| 🟡 | 已实现但未真实验收（含仅本地测试/构建、或代码刚落地未验证） |
| 🟠 | 部分实现（只覆盖部分层级，或存在默认值/边界未处理） |
| ⛔ | 未实现 |
| 🔧 | 需要硬件或用户选择（缺实体器件、缺授权、缺用户决定） |

证据强度标签（五类，结论里必须区分）：

- `[历史真实验收]` 2026-10-26 之前已有原始真机/现场证据；
- `[本轮真实验收]` 本轮（2026-10-26）有原始真机/现场证据（自动启动、厨房音量20等）；
- `[本地测试或构建]` 单测/构建/静态检查，不等于真机；
- `[尚未实现]` 无实现，或仅有文案/占位；
- `[外部并行会话进行中（未验收）]` 代码/证据正在被外部会话写入，本轮读取时未构建、未跑测试、未真机、未公网验收——**不得计为已实现或已验收**。

原始要求 1–5（`DAYU200-完整知识交接.md:204`）：① 南向采集（红外人体/门窗磁/温湿度 + 随身无线求助按钮 + 基础阈值算法）；② 本地声光预警与语音自助求助；③ 北向监护人 APP（状态/在线与电量/活动规律报告/历史预警）；④ 事件闭环（预警确认→处置→居家安全日志）；⑤ 统计（活动时段分布、周月趋势）。

## 2. 总体判定统计

| 判定 | 数量 | 占比 |
|---|---:|---:|
| ✅ 已实现且真实验收 | 6 | 20% |
| 🟡 已实现但未真实验收 | 9 | 30% |
| 🟠 部分实现 | 7 | 23% |
| ⛔ 未实现 | 6 | 20% |
| 🔧 需要硬件或用户选择 | 2 | 7% |
| **合计** | **30 子项** | 100% |

分组判定：

| 组 | 需求 | ✅ | 🟡 | 🟠 | ⛔ | 🔧 | 总体判定 |
|---|---|---:|---:|---:|---:|---:|---|
| A | PIR/门磁/温湿度/便携SOS/基础阈值 | 2 | 1 | 3 | 0 | 0 | 🟠 部分实现（温湿度、卫生间 PIR 真实；门磁/SOS/燃气烟雾阈值缺口） |
| B | 本地灯/蜂鸣/语音与求助 | 0 | 4 | 1 | 1 | 0 | 🟡 实现齐全但实体声光与告警播报未真机验收 |
| C | 手机实时/门窗/在线/电量/按日期报告/历史告警 | 3 | 0 | 1 | 0 | 2 | ✅ 主体达标（在线与实时数据真实；电量、门窗无硬件来源） |
| D | 确认/处置结果/安全日志 | 1 | 4 | 0 | 1 | 0 | 🟡 DAYU 侧历史 ACK 真机通过；独立处置+可查安全日志尚未验收 |
| E | 活动时段/每日趋势/周月报告 | 0 | 0 | 2 | 4 | 0 | ⛔ 时段/7日数据链路已实现，**周/月报告不存在**，云端与手机端无活动聚合 |

一句话结论：**演示主线（房间实时数据 + 卫生间 PIR + 厨房音量20语音 + 手机在线/离线 + DAYU 本地 ACK）是真实的；四类结构性缺口是：门磁与电量没有真实硬件来源、周/月报告完全不存在、手机端 ACK 与独立处置链路从未端到端真实验收、自动启动仍缺 P0 冷启动实测且不是 OS 自启。**

计数口径补充：9 个 🟡 中有 3 个（D3/D4/D6）属于 `[外部并行会话进行中（未验收）]`——它们在磁盘上有代码，但**本轮不可计为“已实现”，更不可计为“已验收”**；对交付/演示应当按“尚不可用”对待，直到并行会话给出构建产物+测试结果+真机/公网原始证据。

## 3. A–E 需求矩阵

### A. PIR、门磁、温湿度、便携 SOS、基础阈值异常识别

| # | 子项 | 判定 | 最直接证据（源码:行 / 证据文件） |
|---|---|---|---|
| A1 | 人体红外（DAYU 客厅 homemon 多路 PIR） | 🟠 部分实现 | 实现：`competition/southbound/src/homemon.c:1021-1037`（含消抖/计数/日统计）、`:972`；但部署未启用：`materials/demo_start.ps1:176-180` 默认只写 `door_gpio=-1`、不写 `motion_gpio`；现场板配置 `evidence/2026-10-24-demo-backup/artifacts/homemon/homemon-conf-board-pre-8871C632.conf:1-3`。默认值风险见 §4.4。 |
| A2 | 人体红外（卫生间 ESP32 `esp32-bath` PIR GPIO36） | ✅ 已实现且真实验收 | 实现：`competition/esp32-node/main/node_main.c:713-721`、`alarm_logic.h`（PIR 连续确认）；配置 `esp32-node/build-voice-bathroom/config/sdkconfig.h:396`(`MOTION_GPIO 36`)；真实验收 `[历史真实验收]`：`evidence/2026-10-24-app-p0-sensors-local/FINAL-2026-10-24.md:78-88`（自然帧 `motion.countToday 126→134`，手机 MonitorPage/DevicePage 如实显示）。 |
| A3 | 门磁（门窗磁） | 🟠 部分实现 | 代码：`homemon.c:1039-1050`（GPIO+消抖+`lastOpenTs`）、`node_main.c:736-738`；但 ESP32 上报把 `lastOpenTs` 硬编码为 0：`node_main.c:904`；三节点部署全部关闭门磁：`kitchen v20 sdkconfig.h:406 DOOR=-1`、`build-bathroom/config/sdkconfig.h:404 DOOR=-1`、DAYU 板 `homemon-conf-board-pre-8871C632.conf:1`。无真实门磁事件证据。 |
| A4 | 温湿度 | ✅ 已实现且真实验收 | DAYU：`homemon.c:1062-1075`（SHT30 + `climate_valid.h`）、上报 `homemon.c:811、823-824`；ESP32：`node_main.c:741-757`（AHT20/DHT11，失败=valid=false，不伪装告警）、`:905`；真实数据 `[本轮真实验收]`：`evidence/2026-10-26-local-speaker-candidate/KITCHEN-V20-NORMAL-DEPLOYMENT.json:32-47`（21 条 valid=true）；手机端真实展示 `[历史真实验收]` `2026-10-24-app-p0-sensors-local/FINAL-2026-10-24.md:74-79`。客厅 DAYU 无 SHT30 实物时仍上报占位（A6/§4.4 边界）。 |
| A5 | 便携 SOS 求助按钮 | 🟡 已实现但未真实验收 | 实现：`node_main.c:936-950`（100 ms 快路径、连续 2 次≈200 ms）、`alarm_logic.h`（SOS 消抖状态机）、`:498-503`（内部上拉低有效）；卫生间已配置 `build-voice-bathroom/config/sdkconfig.h:398`(`SOS_GPIO 15`)；真正按下实体按钮触发并闭环的原始证据缺失（仅有 2026-10-23 COM8 bench 类证据，不能替代现场按钮验收）。`VALIDATION-MATRIX.md:99、113` 仍记 “PIR、门磁、蜂鸣器实物效果 NOT TESTED”。 |
| A6 | 基础阈值异常识别 | 🟠 部分实现 | 已实现：温湿度阈值→WARN（`homemon.c:1071-1075、1106-1107`）、无活动阈值→NO_MOTION（`:1103-1105`，1800 s）、ESP32 MQ 连续确认+回差（`alarm_logic.h:33-57`）、水漏（`node_main.c:722-734`）、跌倒（PC YOLO→`homemon.c:559-575` 附近 FALL 提交路径）。缺口：厨房 MQ-2/MQ-5 阈值 4096=禁用（`KITCHEN-V20-NORMAL-DEPLOYMENT.json:15`）、DAYU MQ ADC 通道默认 -1（`homemon.c:860-864`）、真人跌倒未测（`evidence/2026-10-26-demo-autostart/REPORT.md:113`）。 |

### B. 本地灯 / 蜂鸣器 / 语音与求助

| # | 子项 | 判定 | 最直接证据 |
|---|---|---|---|
| B1 | DAYU 三色灯 + 蜂鸣器状态输出 | 🟠 部分实现 | 代码：`homemon.c:315-325`（NORMAL 绿 / WARN 黄闪 / ALARM 红闪+鸣 / ACKED 蓝）、`:246-264`（`/sys/class/leds` + GPIO）；但部署配置 `buzzer_gpio=-1` 且未设 `led_*`（`homemon-conf-board-pre-8871C632.conf:3`；`demo_start.ps1:181-199` 模板不含 `led_*`）→ 现场无声光原始证据。`VALIDATION-MATRIX.md:113` NOT TESTED。 |
| B2 | DAYU 语音播报（SOS/FALL 预设句） | 🟡 已实现但未真实验收 | 实现：`homemon.c:266-274`（`say_cmd`→`say.sh`）、`:291-295`（任何来源的 SOS/FALL 都播报）；`[历史真实验收]` 仅“耳机重播用药提醒听到” `VALIDATION-MATRIX.md:29、192`；裸板外放 FAIL、五句内容/音量未逐条验收。 |
| B3 | ESP32 厨房板载扬声器（音量 20 正常运行版） | 🟡 已实现但未真实验收（部署真实、告警播报未验收） | 部署事实 `[本轮真实验收]`：`evidence/2026-10-26-local-speaker-candidate/KITCHEN-V20-NORMAL-DEPLOYMENT.json:1-59`（939,936 B、SHA-256 `A76224A4…DBC11`、COM5、MQ-5=GPIO7、volume=20、main 栈 8192、只写 0x10000、写后校验）；试听出声用户确认 `KITCHEN-VOLUME20-TRIAL.md:52-63`；但正常版**从未触发真实告警播放**：`KITCHEN-V20-NORMAL-DEPLOYMENT.json:27-28`（`normalImageLiveAlarmAudioTested=false`、`liveAlarmClosedLoopTested=false`）。实现：`local_voice.c:69-70`（音量寄存器）、`node_main.c:806-808`（新告警播放一次）。 |
| B4 | ESP32 板载蜂鸣器 | 🟡 已实现但未真实验收 | 实现：`node_main.c:113-175`（XL9555 P0_3 板载蜂鸣器）、`:539-546`、`:806-808`（限时鸣响）、`:623-632`（ACK 立即静音）；无真实 ACK/告警下的蜂鸣验收证据。 |
| B5 | 本地求助（按钮/离线自助） | 🟡 已实现但未真实验收 | 代码：`node_main.c:936-950` + `local_voice.c`（SOS 播求助录音）+ 断网目标“网络收发独立任务，主任务继续采样”（`2026-10-26-local-speaker-candidate/REPORT.md:18`）；断网求助、真实 SOS 闭环未验收（同文件 `:7、78`）。 |
| B6 | DAYU FALL 下发厨房/卫生间联动播报（声光告警闭环） | ⛔ 未实现 | 明确边界：`2026-10-26-local-speaker-candidate/REPORT.md:71`“不包含 DAYU FALL 下发厨房/卫生间联动播报、完整声光报警验收”；`local_voice.c` 只在节点本地新告警时播放（`node_main.c:806-808`），无来自 DAYU 的联动通路。 |

### C. 手机实时数据、门窗记录、在线、电量、按日期报告、历史告警

> 手机 APP = `APP/ElderlyCareGuardian`（`com.example.program_04`，127.0.0.1:5555 模拟器，公网 `https://api.luxunacc.xyz`）。

| # | 子项 | 判定 | 最直接证据 |
|---|---|---|---|
| C1 | 实时数据（温湿度/MQ 原始值/PIR 次数） | ✅ 已实现且真实验收 | 链路：网关 `cloud/onenet/gateway.js:810-826` → `cloud-sync.js:75-97` → 后端 `/internal/v1/device-status`（`server.js:381-392`）→ `store.js:52-65`（保留 sensors）→ `GET /api/v1/devices`（`server.js:522-524`）→ 手机 `ViewMapper`/`MonitorPage`；真实验收 `[历史真实验收]`：`evidence/2026-10-24-app-p0-sensors-local/FINAL-2026-10-24.md:70-88`（100 秒无操作自动刷新：厨房 ADC 264→265、烟雾 111→112、PIR 今日 126→134）、`docs/evidence/2026-10-24-p0-final-freeze.md:117-158`（P0-B REAL PASS）。 |
| C2 | 门窗记录 | 🔧 需要硬件（并有对侧默认值风险） | 手机 APP 能力表明确“未安装”：`APP/ElderlyCareGuardian/entry/src/main/ets/core/capability/DeviceCapabilities.ts:132、153、170`（厨房/卫生间 `door` 未安装、客厅“待确认”），`ViewMapper.ts:236-246` 仅在 DTO 非空时展示、`lastOpenTs=0` 显示“暂无开启记录”；无真实门磁硬件/接线证据（A3 同源）。 |
| C3 | 在线状态 | ✅ 已实现且真实验收 | 手机侧：`GET /api/v1/devices` 的 `lastSeenTs` + 12 s 离线判定；真实验收 `[历史真实验收]`：`2026-10-24-app-p0-sensors-local/FINAL-2026-10-24.md:80-84`（自然离线：MonitorPage/HomePage 2/5，卡片“离线·上次读数”，恢复后 3/5，同一 APP PID 未重启）。 |
| C4 | 电量 | 🔧 需要硬件（**无任何真实数据源**） | 全链路无 battery 字段：`homemon.c:807-830` 状态 JSON 无 battery；`node_main.c:901-921` 无 battery；网关 `gateway.js:810-826` 只拷贝 motion/door/gas/smoke/climate；后端 `store.js:52-65` 只保留入站 sensors。手机 APP 刻意不虚构：`DevicePage.ets:5`“不显示虚构的网关性能/电量/信号百分比；csq 0-31 映射信号格，99/缺失显示‘未知’”。详见 §4.4。 |
| C5 | 按日期报告（告警按日期 + 统计） | 🟠 部分实现 | 手机 APP 有两块：① 告警记录按本地日期分组 `LogPage.ets:3`（真实 `gv.alerts`）；② `StatsPage.ets:241`“近 7 天告警趋势”只统计告警；活动类明确缺失 `StatsPage.ets:308`“活动分布、睡眠时长、AI 洞察：后端未提供对应接口，暂无数据”、`:314`“报告导出：本轮未开放”。 |
| C6 | 历史告警 | ✅ 已实现且真实验收 | 后端持久化告警：`store.js:175-192`（`listAlerts`）、`persistent-store.js`（告警落盘）；`GET /api/v1/alerts` `server.js:505-521`；手机 `AlertListPage.ets:10、24-28`（全部/待处理/等待设备确认/设备已确认）。真实数据 `[历史真实验收]`：`2026-10-24-app-p0-sensors-local/FINAL-2026-10-24.md:87`（DAYU 自然 ALARM 如实展示待确认）。边界：**未做多日历史/分页的专项真实验收**。 |

### D. 告警确认、处置结果、安全日志

> 本组 D3/D4/D6 涉及**外部并行会话进行中（未验收）**，见 §0。下表判定按“读取时刻”记录，不代表这些能力已经可用或通过。

| # | 子项 | 判定 | 最直接证据 |
|---|---|---|---|
| D1 | DAYU APP 告警确认（ACK，自由文本处置） | ✅ 已实现且真实验收（历史） | 实现：`Index.ets:1408-1423`（输入处置结果）→ `DeviceModel.ets:195-214`（`ack()` 下发 `ack <id> <action>`）→ `homemon.c:503-547`（严格校验 ID/状态/重复 ACK，然后 `ACKED` 并写 `safety.log`）；`[历史真实验收]`：`VALIDATION-MATRIX.md:30-33`（DAYU 本机错误/正确/重复 ACK 真机 PASS）、`:97`（真实 ESP32 下行 ACK，错误保持 ALARM、正确转 ACKED、重复被拒）。边界：**处置结果是自由文本，无结构化枚举**。 |
| D2 | 手机 APP ACK（公网→设备回执闭环） | 🟡 已实现但未真实验收 | 实现：`GuardianService.ets:808-870`（`ackAlert` 严格区分 202=PENDING 与 ACKED，绝不本地改写）、`AlertDetailPage.ets:27-311`（idle→submitting→waiting→confirmed/timeout）；后端 `server.js:730-736`、`store.js:374-400`（`requestAck`）；真实验收缺失：`VALIDATION-MATRIX.md:207`（NOT TESTED）、`docs/evidence/2026-10-24-p0-final-freeze.md:130、198`（本轮未发送 ACK）。 |
| D3 | 独立“处置结果”（枚举，与 ACK 分离） | 🟡 已实现但未真实验收 — `[外部并行会话进行中（未验收）]` | 合同：`evidence/2026-10-26-alert-disposition-safety-log/CONTRACT.md:1-145`（5 枚举、独立于 ACK、幂等 409、不落 openid）；后端：`safety-log.js`、`store.js:275-316`、`server.js:667-700`；手机端：`AlertDetailPage.ets:79`+处置面板、`GuardianService.ets:961-1055`、`ApiClient.ts:252-312`。**未构建、未跑测试、未装真机、未公网验收。** |
| D4 | 可持久化安全日志（可查询台账） | 🟡 已实现但未真实验收 — `[外部并行会话进行中（未验收）]` | 服务端台账：`persistent-store.js:752-756`（v1–v5 兼容、v6 落盘）、`:850-889`（严格校验：alarmId 存在、deviceId 绑定、dispositionId 唯一递增）、上限 2000 条 `store.js:370-372`；查询 `GET /api/v1/safety-logs` `server.js:713-728`；设备侧另有一份 `homemon.c:541-547` 写 `/data/homemon/safety.log`。测试文件 `backend/test/safety-log-*.test.js` / `safety-log-isolated.integration.js` 在 01:47–01:51 才创建，**本轮未运行**。 |
| D5 | DAYU APP 侧“安全日志”查询/展示 | ⛔ 未实现 | 设备只写不读：`homemon.c:541-547` 仅 `fopen(...,"a")` 追加，无读取命令；`homemon.c` 全文无“读 safety.log”的接口；北向 `northbound/entry/src/main/ets/**` 无安全日志页（`AlarmView.ets` 只展示内存中的 `action/ackTs`）。APP 重启后处置记录在 DAYU 侧不可见（只能 hdc 取文件）。 |
| D6 | 手机 APP 安全日志页 | 🟡 已实现但未真实验收 — `[外部并行会话进行中（未验收）]` | `LogPage.ets:3-4、185-202`（真实 `GET /api/v1/safety-logs`，失败显真实错误、不回退演示数据）、`:327` 行样式（告警/房间/处理时间/处理人/结果/说明）、`GuardianService.ets:1063-1115`；未构建/未装真机。 |

### E. 活动时段、每日趋势、周/月报告

| # | 子项 | 判定 | 最直接证据 |
|---|---|---|---|
| E1 | 活动时段分布（4 时段） | 🟠 部分实现 | 数据真实链路：`homemon.c:386-402`（`hist_bump` 6-9/9-12/12-18/18-22 四时段）→ `:815、827-828` 上报 `slots[4]` → `Index.ets:760-784` 解析 → `:1467-1501` 真实渲染 `liveSlots`；`[历史真实验收]` DAYU 统计报告页曾在 2026-10-20 真机渲染（`evidence/2026-10-20-dayu-relink/ui.json` 含“早晨 06-09/上午 09-12/下午 12-18/晚间 18-22”）。缺口：现场未启用 PIR（A1）→ slots 实际无自然来源；ESP32 节点恒为 0（`node_main.c:908`）；另有死代码 `view/ReportView.ets:75-78` 硬编码 32/46/38/12（该组件未被 `Index.ets` import，属未接线遗留）。 |
| E2 | 每日活动频次趋势（近 7 日） | 🟠 部分实现 | 设备侧真实持久化：`homemon.c:327-402`（`daily.txt` 7 日+4 时段、跨天左移、开机载入 `:996`）→ `:814` 上报 `history[7]` → `Index.ets:1448-1465` 真实柱状图；`[历史真实验收]` 仅 UI 渲染过（上条同证据），**未见连续多日真实数据验收**。缺口：ESP32 节点历史恒 0（`node_main.c:908`）；`DeviceModel.ets:79` `weekly` 仍为演示值 `[142,156…]` 且从不被 `applyStatus` 更新（`:123-128` 只写 `history`），死代码 `ReportView.ets:54-57` 用该假数组；`yesterdayCount` 恒 160（`DeviceModel.ets:80`）导致 `trendText()`（`:231-240`）的“较昨日”比较基准是假值。 |
| E3 | 周报告 | ⛔ 未实现 | 全仓无周报生成/接口/页面：`grep 周报/月报` 仅命中 `ReportView.ets:4、94` 的文案（“周/月报告由设备端与云端汇总”），且该组件未被页面引用；后端无 weekly/report 路由（`server.js` 路由清单 309-739，无 report/activity）。 |
| E4 | 月报告 | ⛔ 未实现 | 同上；手机端 `StatsPage.ets:314`“报告导出：本轮未开放”。 |
| E5 | 云端/手机端活动聚合与趋势接口 | ⛔ 未实现 | 网关丢弃 history/slots：`gateway.js:536-540`（status 只带 sensors/alarm）、`:810-826`（只归一 motion/door/gas/smoke/climate）；`cloud-sync.js:75-97` payload 无 history/slots；后端无活动存储/接口；手机端明确“后端未提供对应接口”（`StatsPage.ets:308`）。注：team task2/task3 正在实现该能力，不属于本冻结基线。 |
| E6 | 手机端日报（按日期活动报告） | ⛔ 未实现 | 同 E5；手机 StatsPage 只有告警趋势（`StatsPage.ets:241-285`），无活动日报。 |

## 4. 特别核实（5 项，单列结论）

### 4.1 自动启动已做到哪一步

**结论：🟡 已实现但未全部真实验收；入口是“用户双击脚本”，不是 OS 开机自启；P0 冷启动未实测。**

- 入口与看护器：`competition/materials/start-demo-all.cmd:1-10` → `competition/materials/demo-autostart/demo-autostart.ps1`（19,510 B）。`[本轮真实验收]`：`evidence/2026-10-26-demo-autostart/REPORT.md:58-77`（一键启动、相机自启、人物检测自启、单实例、HDC 掉线重连、DAYU 重启、应用关闭重开、推理异常恢复、用户暂停 65 s 不拉起均 REAL PASS；15 分钟稳定性 inferFps=1.53，未声称 ≥2 FPS）。
- P0 冷启动：**NOT TESTED**（`REPORT.md:110`；`2026-10-26-demo-autostart-followup/REPORT.md:33-39`）。交接步骤在 `COLD-START-HANDOFF.md:27-53`，判定要求“必须有新帧/新事件/单实例/自然 202”，并明确“若 AI 需补命令则该次不算一键 PASS”。
- OS 自启边界：**未创建 Windows 服务/计划任务/RunOnce**（`demo-autostart.ps1` 中无 `ScheduledTask/New-Service/schtasks/RunOnce` 命中）；`COLD-START-HANDOFF.md:66`“本入口没有 OS 级开机自启；重启后必须由用户双击一次”；`REPORT.md:115` 同。
- 其他限制：公网同步本轮只验证 P0 HEALTHY，未构造生产 202（`REPORT.md:111`）；三节点最终 2/3（`:116`）；页面 `ms` 是上传往返不是推理耗时（followup `REPORT.md:14-21`）。

### 4.2 ACK 是否已有独立处置结果与可持久化安全日志

**结论：①DAYU 侧“处置结果”仍是自由文本、安全日志可写不可查；②手机侧独立处置结果+持久化台账属于 `[外部并行会话进行中（未验收）]`；③后端 `alert.action` 保存但不对外可查；④命令 `action` 只在内部 ingest 鉴权接口可见。**

- DAYU APP ACK：`Index.ets:1408-1423` 文本输入 → `DeviceModel.ets:213` 下发 `ack <id> <action>`；`homemon.c:503-547` 校验后写 `ACKED` + `/data/homemon/safety.log`（`:%lld,alarmId,处置文本`）。**没有**结构化处置枚举；**没有** APP 内安全日志列表（D5）。
- 手机 APP：ACK 与处置已**分离**：ACK `GuardianService.ets:808-870`（202 只代表入队，只有服务端 ACKED 才算闭环）；处置 `GuardianService.ets:961-1055`（5 枚举 + note≤200 + `clientDispositionId` 幂等）、`ApiClient.ts:225-331`、`AlertDetailPage.ets:79`、`LogPage.ets:185-202`。这些代码是 01:46–01:49 由**外部并行会话**写入的，**未构建/未装真机/未公网验收** → `[外部并行会话进行中（未验收）]`，不能计入“已实现”。
- 后端可查询性：`store.js:175-191` 的 `listAlerts()` 公开映射**不含** `action`（虽然 `store.js:389-394` 把 ACK 文本存进 `alert.action`）→ **`alert.action` 对外不可查**；`acknowledgedAt/acknowledgedBy` 对外可见。命令侧只有 `GET /internal/v1/commands`（`server.js:419-422`，需 INGEST_KEY），监护人 API 不可查 `command.action`。
- 独立审计台账：`safetyLogs`（schema v6）是**独立于 ACK**的新台账（`persistent-store.js:752-756、850-889`），并新增 `GET /api/v1/safety-logs`（`server.js:713-728`）；本轮未运行任何测试，故只能记“已实现但未真实验收”。

### 4.3 日报/周报/月报是否真实查询历史数据

**结论：①DAYU“统计报告”页的 7 日与 4 时段确实来自 homemon 真实累计（`daily.txt`），不是模拟；②手机 APP 只有“近 7 天告警趋势”，活动/日报无后端接口；③周报/月报不存在（设备、后端、手机端都没有）。**

- DAYU 真实数据源：`homemon.c:327-402`（`daily.txt`：dayIndex + 7 日 + 4 时段；`hist_save/hist_load/hist_roll/hist_bump`），上报 `homemon.c:814-815、827-828`；页面 `Index.ets:1448-1501`，页脚自述“日统计由各房间节点累计并持久化，本页展示所选房间的真实数据”（`:1532`）。
- 但即使有数据也有两处“假值残留”（均为**未被页面引用的死代码**）：`view/ReportView.ets:54-57` 用 `DeviceStore.weekly`（演示数组 `DeviceModel.ets:79`），`:75-78` 硬编码时段 32/46/38/12，`:89` 硬编码“设备在线率 99.2%”；`DeviceModel.ets:80` `yesterdayCount=160` 使趋势文案基准失真。**若后续有人把 ReportView 接回页面，会立刻变成假报告**，因此这是必须清理的冻结项。
- 手机 APP：`StatsPage.ets:241-285` 仅“近 7 天告警趋势”（数据来自真实 `alerts`），`:308` “活动分布、睡眠时长、AI 洞察：后端未提供对应接口，暂无数据”，`:314` 报告导出未开放。**无日报、无周报、无月报**。
- 云端：网关与同步 payload 都不含 `history/slots`（`gateway.js:536-540、810-826`；`cloud-sync.js:75-97`），后端无活动聚合/报表接口（`server.js` 路由无 report/activity）。→ 手机端无法获得活动趋势的根因不在 UI，而在云端断链。

### 4.4 门磁与电量是否来自真实硬件、是否存在默认值风险

**结论：①门磁：代码具备、现场三节点全部关闭，无真实事件；DAYU APP 仍按“已安装”显示“关闭/暂无”，属默认值风险；手机 APP 已正确标“未安装/待确认”。②电量：全链路没有任何数据源，手机 APP 直接不显示（非显示假值），DAYU 侧也无电量 UI。**

门磁：

- 真实配置全部关闭：`esp32-node/build-voice-kitchenvoice-private-v20/config/sdkconfig.h:406`（`DOOR_GPIO -1`）、`build-bathroom/config/sdkconfig.h:404`（`-1`）、DAYU 板 `homemon-conf-board-pre-8871C632.conf:1`（`door_gpio=-1`，且 `demo_start.ps1:176-180` 默认只写 `-1`）。
- 代码里 `lastOpenTs` 从不产生：ESP32 状态 JSON 硬编码 `"door":{"open":%s,"lastOpenTs":0}`（`node_main.c:904`）；homemon 在 `door_gpio<0` 时永不更新 `last_door_ms`（`homemon.c:1039-1050`），上报恒 `lastOpenTs=0`（`:822`）。
- **默认值风险（DAYU）**：`northbound/entry/src/main/ets/model/DeviceCapabilities.ts:25-33` 把 `dayu200-living` 的 `door`/`motion`/`climate` 一律标 `true`，于是 `Index.ets` 会展示门磁卡片“当前：关闭 / 最近开启 暂无”（状态来源 `homemon.c:810、821-822` 默认 `open=false`）。即“没有门磁”被呈现为“门磁正常且关闭”。
- 手机 APP 已规避：`APP/.../core/capability/DeviceCapabilities.ts:132、153、170`（未安装/未安装/待确认），`ViewMapper.ts:229-246`。

电量：

- 没有任何字段：`homemon.c:807-830`、`node_main.c:901-921`、`gateway.js:810-826`、`cloud-sync.js:75-97`、`store.js:52-65` 均无 battery。
- 手机 APP 明确选择“不显示”而不是“显示默认 100%”：`DevicePage.ets:5`；`SensorCard`/`ViewMapper` 无 battery 渲染。
- DAYU APP 无电量相关 UI（`grep 电量` 仅命中该注释）。
- 结论：电量目前是**需求缺口（需要硬件或用户选择）**，不存在“默认值伪造”，但也没有实现。历史旧 APP（`APP/Program_04`）曾用 `battery:100` 演示值，该目录不是当前基线，不得引用。

### 4.5 厨房音量20已部署 / 卫生间未部署（最新事实）

**结论：以 2026-10-26 证据为准。厨房 COM5 = 音量20 正常运行版已真实刷入并短时观察通过（本轮真实验收）；卫生间 COM4 = 只完成身份核实与备份，未烧录；DAYU COM11 未写入；旧端口表作废。**

> 卫生间状态附加说明：`2026-10-26-bathroom-local-voice/` 是**外部并行会话进行中**的目录。本报告读取时刻（约 01:52）该目录仅 `BACKUP-AND-IDENTITY.md`（01:43:44）与 `bathroom-voice-volume30.patch`（01:43:24），**无部署 JSON、无串口日志、无写后校验记录** → 记为“未烧录”。若并行会话之后完成部署，应以它新产生的原始证据为准，本报告不追认、不据此推断现场结论。

- 厨房（COM5）：`[本轮真实验收]` 部署记录 `evidence/2026-10-26-local-speaker-candidate/KITCHEN-V20-NORMAL-DEPLOYMENT.json:2-31`：
  - 镜像 939,936 B，SHA-256 `A76224A46CC9E6FD737195988B40BE32B861C4AB1E75A9CD26F10F26477DBC11`；
  - `volumeSetting=20`、`pcmAttenuationDivisor=2`、`mainStackBytes=8192`、`mq5Gpio=7`、`mq2Gpio=6`、`gasAndSmokeAlarmThresholdRaw=4096`（未标定→禁用）；
  - `flashOffset=0x10000`、只写应用分区、`esptoolPostWriteHashVerified=true`、未写 bootloader/分区表/NVS、未整片擦除；
  - 关闭开机诊断语音（`bootDiagnosticSpeechEnabled=false`），120 s 观察 21 条采样、无栈溢出/重复重启、main 最低栈 4060 B；70 s 只读 MQTT 12 条自然非 retained、时间严格递增；
  - 分类 `KITCHEN_VOLUME20_NORMAL_DEPLOYED_SHORT_RUN_PASS`，**不代表**声光告警闭环通过。
- 试听版历史：`1,046,992 B`、`99672665…4012`，已刷入并被正常版替换（`KITCHEN-VOLUME20-TRIAL.md:37`）；初版 volume15 有真实出声但 main 栈溢出（`:9-11`）。
- 卫生间（COM4）：`evidence/2026-10-26-bathroom-local-voice/BACKUP-AND-IDENTITY.md:1-41` 只记录身份（ESP32-S3、MAC `14:c1:9f:42:dd:b4`、16 MB flash）与备份（全片 `D905C86C…4E9B`、原应用分区 `1FDE4DF9…90A0`），**没有烧录记录**；`2026-10-26-local-speaker-candidate/REPORT.md:7`“卫生间 COM4 未烧录”；`KITCHEN-V20-NORMAL-DEPLOYMENT.json:57`（`bathMessages=0`）。同目录另有 `bathroom-voice-volume30.patch`（4132 字节，审计时被标记为二进制/不可直读，疑为并发写入中的候选补丁）→ 卫生间音量候选**正在准备**，仍未部署。
- DAYU（COM11）未写入（同上 REPORT:7）。
- 厨房 v20 私有构建含真实网络配置，**未进入可分发证据归档**（`KITCHEN-V20-NORMAL-DEPLOYMENT.json:25`、`KITCHEN-VOLUME20-TRIAL.md:40`）。

## 5. 最重要的结构性缺口（Top 6）

1. **周/月报告完全不存在（E3/E4/E6）**，且活动数据在网关就被丢弃（E5），手机端永远拿不到活动趋势——这是原始要求⑤的硬缺口，不是 UI 缺口。
2. **门磁与电量没有真实硬件来源（A3/C2/C4）**：三节点门磁全关、电量无任何字段；且 DAYU APP 把未安装的门磁显示成“关闭/暂无”的默认值（误导性展示）。
3. **手机端 ACK 与独立处置/安全日志从未真实验收（D2/D3/D4/D6）**：后端与 APP 的处置能力是 `[外部并行会话进行中（未验收）]`（01:46–01:51 仍在写代码与测试文件）——**不得计为已实现**；`alert.action` 虽保存却不对外可查；`command.action` 只在内部接口。
4. **DAYU 侧处置记录不可回看（D5）**：`safety.log` 只写不读，APP 重启后历史处置丢失——原始要求④“居家安全日志”在演示端不成立。
5. **自动启动缺 P0 冷启动实测且不是 OS 自启（§4.1）**：需用户重启 PC 才能取得“无 P0 首次启动”证据；当前只能算“双击脚本一键启动”。
6. **真实的“声光告警闭环”未验收（B1/B3/B4/B6）**：厨房只验证了出声与短时运行，正常版未触发真实告警播放；DAYU 板载灯/蜂鸣器现场禁用；无 DAYU→房间节点联动播报通路。

## 6. 后续任务清单（P0 / P1 / P2，优先补原始要求 1–5）

> 原则：先补“赛题必做且当前为空”的项（原始要求①②③④⑤）；不重复已真实验收的链路；任何“真实”结论必须附原始证据，不能以构建成功代替。

### P0（不做就无法在 11-06 交付中成立对应原始要求）

1. **P0-E1 云+端活动聚合与日报/周报接口**（原始要求⑤）：`gateway.js` 透传/聚合 `history[7]`/`slots[4]`（当前 `:536-540` 丢弃）；后端新增持久化活动日统计 + `GET /api/v1/activity/report?range=day|week|month`；手机 StatsPage 接真实接口；DAYU `ReportView.ets` 死代码清理或接线（删除硬编码 32/46/38/12、99.2%、`weekly` 假数组，否则一旦接线立即造假）。验收：真实设备连续 ≥2 天数据 + 周报聚合正确 + 手机端显示。
2. **P0-D1 处置结果+安全日志端到端真实验收**（原始要求④）：先跑 `cloud/backend && npm test`（含新 `safety-log-api.test.js`）与 `hvigorw test/assembleHap`；再在真机 + 公网用测试告警 fixture 验证“ACK 与处置分离、幂等 409、重启后 `GET /api/v1/safety-logs` 仍可查、ACK 状态不被处置接口改变”；**不得 ACK 生产告警**。
3. **P0-C1 手机端 ACK 真实闭环一次**（原始要求④）：用真实账号对一个真实存在的告警执行 ACK → 设备回执 ACKED → 后端结清，保存设备日志与公网证据（`VALIDATION-MATRIX.md:207` 尚未通过）。
4. **P0-A1 自动启动 P0 冷启动实测**（交付演示风险）：按 `COLD-START-HANDOFF.md:27-53` 由用户重启 PC 一次，只双击 `start-demo-all.cmd`，取证“无 P0 → 自动拉起 → 新帧/新事件/单实例/自然 202”；若必须 AI 补命令则该次 FAIL，最小修复后复验。
5. **P0-B1 声光告警闭环最小验收**（原始要求②）：厨房 v20 正常版触发一次**受控真实告警**（或等效本地告警路径）验证播放；DAYU 板载灯/蜂鸣器在 `-UsePhysicalSensors` 或等效配置下完成一次 NORMAL→ALARM→ACKED 的灯/鸣观察并记录。

### P1（补齐必做项的真实性/可解释性）

6. **P1-A1 门磁真实化或明确降级**（原始要求①）：二选一——(a) 任一节点接线门磁并在 `homemon.conf`/sdkconfig 启用，采一次真实开/关 + `lastOpenTs`；或 (b) 把 DAYU `DeviceCapabilities.ts:25-33` 的 `door` 改为 `false`/“待确认”，避免“未安装显示为关闭”。
7. **P1-A2 便携 SOS 实体按钮真机验收**（原始要求①）：卫生间 `SOS_GPIO 15` 实体按下→`MANUAL_SOS`→上报→APP 展示→ACK 闭环（需用户明确授权制造告警）。
8. **P1-E2 ESP32 节点日统计**（原始要求⑤）：`node_main.c:908` 目前恒 `history:[0,0,0,0,0,0,N], slots:[0,0,0,0]`；在节点侧持久化 7 日+4 时段，或由 DAYU/云端按节点聚合，否则厨房/卫生间永远只有“今天”。
9. **P1-E3 DAILY 多日真实数据取证**：`daily.txt` 跨天滚动/落盘在真机上连续 2–3 天取证（当前只有 UI 渲染过、没有多日真实数据）。
10. **P1-C2 电量：需要用户决策**（原始要求③）：要么给出硬件来源（电池电量计/ADC 分压 + 协议字段），要么在交付材料中明确“本作品不提供电量监测”，并保持 APP 现状（不虚构）。
11. **P1-B1 卫生间音量候选部署**（B 组补齐）：`bathroom-voice-volume30.patch` 落地为可验证构建 → 备份/身份已就绪（`BACKUP-AND-IDENTITY.md`）→ 用户授权后只写 0x10000 应用分区、写后校验、120 s 观察、只读 MQTT 观察。
12. **P1-D2 后端 `alert.action` 对外可查**（原始要求④，可选）：若产品需要“处置文本回看”，在 `/api/v1/alerts` 增加只读 `lastAction`（注意隐私：仅角色，不含 openid），或在安全日志 API 统一承载；明确与 `safetyLogs` 的关系避免双写歧义。

### P2（质量/一致性，不阻塞交付）

13. **P2-1 清理死代码假值**：`view/ReportView.ets`（未被引用）与 `DeviceModel.weekly/yesterdayCount` 的演示值；建议删除或接线，禁止保留“改造后自动造假”的陷阱。
14. **P2-2 NO_MOTION 默认值风险**：`homemon.c:1103` 在 `motion_cnt==0` 时仍按 1800 s 触发 NO_MOTION（启动即计时 `:977`）；未装 PIR 的客厅会在 30 min 后产生假告警/18 min 假 WARN。建议 `motion_cnt==0` 时不判 NO_MOTION/WARN，并记录到配置自检。
15. **P2-3 页面 `ms` 语义**：`VisionFrameStreamer.ets` 的 `lastLatencyMs` 是上传往返，非推理耗时（`demo-autostart-followup/REPORT.md:14-21`）；HAP 更新需用户授权，可先改文案。
16. **P2-4 文档一致性**：`VALIDATION-MATRIX.md`/`ARTIFACTS.md` 最后更新 2026-10-15，未覆盖 10-20~10-26 的新事实（厨房 v20、自动启动、处置台账、bathroom 备份）；建议在交付前生成一份“证据索引增量”，避免评审看到过期 PASS/NOT TESTED。

## 7. 证据索引（本报告引用）

必读基线：

- `competition/evidence/2026-10-26-demo-autostart/REPORT.md`、`CURRENT-STATE.md`
- `competition/evidence/2026-10-26-demo-autostart-followup/REPORT.md`、`COLD-START-HANDOFF.md`
- `competition/evidence/2026-10-26-local-speaker-candidate/REPORT.md`、`KITCHEN-VOLUME20-TRIAL.md`、`KITCHEN-V20-NORMAL-DEPLOYMENT.json`
- `competition/evidence/2026-10-26-alert-disposition-safety-log/CONTRACT.md`
- `competition/evidence/2026-10-26-bathroom-local-voice/BACKUP-AND-IDENTITY.md`
- `competition/docs/VALIDATION-MATRIX.md`、`competition/docs/ARTIFACTS.md`、`competition/README.md`
- `competition/docs/evidence/2026-10-24-p0-final-freeze.md`
- `competition/evidence/2026-10-24-app-p0-sensors-local/FINAL-2026-10-24.md`
- `competition/evidence/2026-10-24-demo-backup/artifacts/homemon/homemon-conf-board-pre-8871C632.conf`
- `DAYU200-完整知识交接.md:204`（五项必做原文）

关键源码：

- `competition/southbound/src/homemon.c`、`climate_valid.h`
- `competition/esp32-node/main/node_main.c`、`alarm_logic.h`、`local_voice.c`、`voice_pins.h`、`Kconfig.projbuild`
- `competition/northbound/entry/src/main/ets/pages/Index.ets`、`model/DeviceModel.ets`、`model/DeviceCapabilities.ts`、`model/VisionFrameStreamer.ets`、`view/*.ets`
- `APP/ElderlyCareGuardian/entry/src/main/ets/pages/{StatsPage,LogPage,AlertDetailPage,DevicePage,MonitorPage,AlertListPage,HomePage}.ets`、`service/GuardianService.ets`、`core/api/{ApiClient.ts,Contracts.ts}`、`core/capability/DeviceCapabilities.ts`、`core/view/ViewMapper.ts`
- `competition/cloud/backend/src/{server.js,store.js,persistent-store.js,safety-log.js}`
- `competition/cloud/onenet/{gateway.js,cloud-sync.js,public-sync.js,adapter.js}`
- `competition/materials/{start-demo-all.cmd,start-demo-supervisor.cmd,demo_start.ps1,demo-autostart/demo-autostart.ps1}`
- `competition/bridge/mqtt_bridge.js`、`competition/mobile/wechat-miniprogram/**`（小程序为早期形态，当前手机基线是 `APP/ElderlyCareGuardian`；本轮未据小程序下结论）

## 8. 未能核实 / 阻塞（如实记录）

1. 后端处置/安全日志能力：属于**外部并行会话进行中（未验收）**。文件在本轮 01:46–01:51 持续被写入（含新增 3 个测试文件），本轮**未运行测试、未构建、未部署**，无法给出 PASS/FAIL，只能记“已实现但未真实验收（并行会话进行中）”。
2. 手机 APP 最新源码（含处置面板/安全日志页）**尚未构建**：`entry/build/default/outputs/default/entry-default-unsigned.hap` 最后时间 2026-10-25 02:22:30（2,156,555 B）；证据绑定的已装 HAP 是 2026-10-24 的 `guardian-app-p0-sensors-autorefreshfix-2026-10-24.hap`（2,086,949 B）。本轮按只读边界**未构建、未安装**。
3. `bathroom-voice-volume30.patch` 被工具判定为二进制/不可直读（疑为外部并行会话正在写入），卫生间的音量值、镜像大小与哈希**无法从该文件核实**；部署结论只依据 `BACKUP-AND-IDENTITY.md`（01:43）与既有 REPORT（未烧录）。该目录为并行会话进行中，**可能变化**；本报告只冻结读取时刻状态。
4. 三节点在线数在现场自然波动（演示期最终 2/3，自动启动随访期 1/3~1/1），无线节点由用户另行调试；本报告不将其作为 A–E 判定依据（`COLD-START-HANDOFF.md:65`）。
5. 未取得“多日真实 daily.txt 数据”“手机端 ACK 端到端”“实体门磁/SOS/蜂鸣”原始证据——这三项目前只能判“未真实验收”，不能用构建/单测替代。
6. 外部并行会话另写了一份矩阵到 `competition/evidence/2026-10-26-core-gap-freeze/`；本报告**未读取其内容、未复用、未覆盖**，两目录互不影响。

---

报告结束（只读审计，未改动任何业务代码/配置/设备）。
