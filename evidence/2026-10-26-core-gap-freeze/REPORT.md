# CORE-GAP-FREEZE 审计报告（只读冻结）

- 任务：CORE-GAP-FREEZE（共享任务 task-1）
- 日期：2026-10-26（Asia/Shanghai），审计窗口约 01:43–01:53
- 证据目录：`competition/evidence/2026-10-26-core-gap-freeze/`
- 矩阵：`REQUIREMENTS-MATRIX.md`；后续任务：`FOLLOWUP-TASKS.md`
- 结论口径：**不把本地构建/单测/fixture 当真实验收；不把历史 REAL 当本轮 REAL；不把运行时波动当稳定通过。**

## 0. 边界与快照

- 只读核对：仅读文件与只读运行时状态文件；**未**修改业务代码、未操作设备/串口/ADB/HDC、未触发/ACK 告警、未发布 MQTT/HTTP ingest、未读写密钥。
- 必读材料已读：`2026-10-26-demo-autostart/REPORT.md`、`2026-10-26-demo-autostart-followup/REPORT.md` 与 `COLD-START-HANDOFF.md`、`2026-10-26-local-speaker-candidate/REPORT.md`、`KITCHEN-VOLUME20-TRIAL.md`、`KITCHEN-V20-NORMAL-DEPLOYMENT.json`、`2026-10-26-bathroom-local-voice/`（build/logs）、`2026-10-24-app-p0-sensors-local/FINAL-2026-10-24.md`、`2026-10-24-p0-final-demo-backup/.../2026-10-24-p0-final-freeze.md`、`2026-10-23-final-freeze-8a722/SOURCE_HASHES.md`、`2026-10-25-p1b-dayu-local-fall/`、`2026-10-25-dayu-three-node-recovery/REPORT.md`、`2026-10-24-demo-backup/` 与 `docs/HARDWARE-MAP.md`、`docs/APP-API-v1.md`、`docs/VALIDATION-MATRIX.md`（历史参考，已交叉核对）。
- **并行修改说明**：审计期间（01:45–01:48）另一组任务正在修改 `competition/cloud/backend/src/*` 与 APP 的页面/Service/core（本轮新增独立处置结果+安全日志）。本报告把该部分记作"本轮实施中，未验收"，不计入已实现；引用的 `文件:行号` 以审计快照为准，之后可能位移。

## 1. 总体结论（一段话）

五项原始要求中，**南向采集的温湿度、卫生间 PIR、手机实时数据/在线、历史告警、告警确认（ACK）已有真实运行态验收**（2026-10-22、2026-10-24、2026-10-25 历史证据，本轮未重测）；**门磁、电量没有硬件与数据通路**；**本地声光/语音只在节点本地短时验收（厨房蜂鸣器自检+音量20正常版短时观察），告警触发的声光语音闭环、卫生间正常版语音部署、DAYU 外放与实体 LED/蜂鸣器均未通过**；**处置结果与平台侧安全日志只有 ACK 附注/DAYU 本地文件，本轮才刚开始实现独立处置与持久安全日志**；**活动时段/每日趋势只有 DAYU 本地数据、云到端未打通，周/月报告未实现**。最大缺口是 **D2/D3（处置/安全日志平台侧）与 E1–E3（活动趋势/周月报告）**，其次是 **B（声光语音闭环、卫生间语音部署）与 C4/A2（电量/门磁硬件）**。

## 2. 特别核实 1：自动启动已做到哪一步、冷启动状态

**结论：`DEMO_AUTOSTART_REAL_PASS_WITH_LIMITS`。有 P0 的组件级一键启动已 REAL PASS；无 P0 的 PC 冷启动 = NOT TESTED；纯 USB 通信断开 = FAILED。**

已真实通过（证据：`competition/evidence/2026-10-26-demo-autostart/REPORT.md`、`RECOVERY-TESTS.md`）：

| 项 | 判定 | 证据 |
|---|---|---|
| 一键启动（P0 已健康、应用后台、9200 关闭）自动拉起推理/相机，frames LIVE | REAL PASS | `REPORT.md` §2、`RECOVERY-TESTS.md` §A |
| 重复双击单实例（第二窗口复用退出，仅 1 推理） | REAL PASS | `RECOVERY-TESTS.md` §B |
| HDC 掉线/重连（重启 hdc server 模拟）自动重建 fport | REAL PASS | `RECOVERY-TESTS.md` §C |
| DAYU 正常重启后自动 homemon/fport/应用/推理 | REAL PASS | `RECOVERY-TESTS.md` §D |
| 推理异常（受控 SIGTERM）自动重启、无第二常驻 | REAL PASS | `RECOVERY-TESTS.md` §E |
| 用户暂停 65 s 无反向拉起、恢复后重启推理 | REAL PASS | `RECOVERY-TESTS.md` §F |
| 15 分钟稳定性（00:38:17–00:53:17，守护器未重启） | REAL PASS（性能按实测 inferFps=1.53，**不声称 ≥2**） | `REPORT.md` §3；`CURRENT-STATE.md` |
| 应用关闭重开自动 `aa start` | REAL PASS | `RECOVERY-TESTS.md` 额外项 |
| USB 拔插 + DAYU 断电重启后自动恢复 | REAL PASS | `2026-10-26-demo-autostart-followup/REPORT.md` §3 |

未通过 / 未测（同上证据）：

- **无 P0 / PC 重启冷启动 = NOT TESTED**（`2026-10-26-demo-autostart-followup/ACCEPTANCE.md`；未为造冷启动结束现有 P0，等用户正常重启 PC）；
- **物理 USB 纯通信断开 = FAILED**（拔插实际导致 DAYU 断电重启，uptime 2526 s→41.57 s；`ACCEPTANCE.md`）；
- 三节点最终 **2/3**（`REPORT.md` §2/§4：曾 3/3，最终 2/3，不写 3/3）；followup 阶段为 **1/3–1/1** 且明确"用户另行调试、本轮排除"；
- 公网同步只"复用既有 P0 HEALTHY"，**未构造生产 202**（`REPORT.md` §2/§4）；
- **没有 OS 级开机自启**（无服务/计划任务，入口为用户双击脚本 + P0 窗口隐藏输入一次 INGEST_KEY）。

冷启动当前状态：

- 交接文件已保存：`competition/evidence/2026-10-26-demo-autostart-followup/COLD-START-HANDOFF.md`（约 01:22）——用户重启 PC 后**只双击一次** `competition/materials/start-demo-all.cmd`，P0 窗口出现时隐藏输入一次密钥；判定要求"正式应用新帧 + 推理新事件 + 无第二实例 + 公网自然 202；AI 补命令则该次不算 PASS"。
- 之后 `runtime/demo-autostart.log`（末尾 01:21:46）**没有冷启动尝试记录**；冷启动仍未执行。
- 审计时只读快照（**非归档验收**）：`runtime/watcher-state.json` 时间戳 2026-10-26 01:46:21，`targetConnected=true, p0=healthy, app=present, inference=running, cameraFrames=LIVE, nodes="3/3", eventCount=7431, watcherPid=56904`。该 3/3 与 01:22 交接的 1/1 不一致，属节点波动/卫生间刷机重启重连，**不能当作三节点验收或冷启动证据**。
- 本轮新发现（证据链缺口）：`runtime/demo-autostart.log` 在 01:18:13、01:18:28、01:19:31、01:20:05 四次出现 `Deploying ... dayu_local_fall` 后紧跟 `Hash mismatch after deploy: /data/local/tmp/dayu-demo-autostart-2026-10-26/dayu_local_fall`；REPORT/ACCEPTANCE 未解释该 hash mismatch。后续推理在 01:18:18/01:21:24/01:21:40 成功启动，说明最终可用，但该异常应补核（见 FOLLOWUP-TASKS F-01）。

## 3. 特别核实 2：ACK 是否已有独立处置结果与可持久化安全日志

**结论：ACK 已有真实闭环（历史 REAL），但没有"独立的处置结果"，也没有 APP/后端可查询的持久安全日志。现有 ACK note 只是 ACK 命令的自由文本附注；DAYU 本机 `safety.log` 是唯一真实持久的安全日志，但只在设备本地。本轮正在实现独立处置+安全日志，尚未验收/部署。**

### 3.1 基线实现（审计快照）

| 层 | 事实 | 源码 |
|---|---|---|
| 后端 ACK | `POST /api/v1/alerts/{alarmId}/ack` 取 `body.note` → `requestAck(alarmId, body.note, HOUSEHOLD_ACTOR)` → 202 `{accepted:true,status:PENDING,commandId}`；命令/告警都会存 `action=cleanAction`（长度≤120，默认"监护人已确认"） | `competition/cloud/backend/src/server.js:656-663`；`store.js:237-259`；`persistent-store.js:175-205,856-894`（基线 v5） |
| 设备 ACK | 只有设备回执后 `completeCommand` 才把告警置 ACKED 并写 `acknowledgedAt/acknowledgedBy`；202 绝不等于 ACKED | `store.js:265-318`；`docs/APP-API-v1.md:84-93` |
| APP 展示 | 告警详情页只显示 `acknowledgedAt`/`acknowledgedBy`/状态；**不显示 ACK note 文本**；时间线只有"本机已提交确认请求/设备已确认（回执）" | `APP/ElderlyCareGuardian/entry/src/main/ets/pages/AlertDetailPage.ets`（ACK 面板与时间线；基线行号约 187-203、671-933）；`core/view/ViewMapper.ts`（acknowledgedAt/acknowledgedBy 映射） |
| 查询接口 | `GET /api/v1/alerts` 返回字段不含 `action`（只到 acknowledgedBy） | `store.js:154-171`；`server.js:494-510` |
| DAYU 安全日志 | 仅在"告警态 + alarmId 精确匹配 + 未处置"时 ACKED，并追加 `时间,alarmId,处置说明` 到 `/data/homemon/safety.log`；重复/错 ID 不写 | `competition/southbound/src/homemon.c:503-547`；`competition/southbound/README.md:9,144` |

### 3.2 ACK note / 处置结果 / 安全日志三者的实际区别

1. **ACK note（现状）= ACK 命令的备注**：APP 输入框占位文案写"处置说明（选填，最多 120 字）"（`AlertDetailPage.ets:852`），容易让人误以为这就是"处置结果"。实际它只是随 ACK 下发的自由文本，写入 `alert.action`/`command.action` 与 DAYU `safety.log`，**没有结构化 outcome、没有独立记录 ID、没有独立时间线、API 不回读**。
2. **处置结果（原始要求）**：基线**不存在**——没有 outcome 枚举（已联系家属/现场确认正常/误报等）、没有独立处置接口、没有"处置人与处置时间"独立台账；不能把 ACK 面板当处置结果。
3. **安全日志（原始要求）**：**DAYU 本地 `safety.log` 是真实且持久的**（2026-10-10 证据：正确 ACK 后 2→3 行，重复 ACK 不增加；`VALIDATION-MATRIX.md:33`），但只存在设备文件系统、无导出/查询接口、只记录 ACK，设备重置即丢；**APP 的"安全日志"页其实是 `gv.alerts` 按日期分组**（`LogPage.ets:1-2,44-74`），**后端没有安全日志台账**（基线持久化 schema v5 顶层白名单无 safetyLogs，`persistent-store.js:48-49,105`）。

### 3.3 本轮并行实施（不可算已实现）

`competition/evidence/2026-10-26-alert-disposition-safety-log/CONTRACT.md`（01:42）定义了独立处置（5 种 outcome、`/dispositions`、`/safety-logs`）与 schema v6 `safetyLogs`。审计时（01:45–01:48）backend/APP 源文件已出现对应改动（`src/safety-log.js` 新增、`store.js`/`persistent-store.js`/`server.js`/`GuardianService.ets`/`AlertDetailPage.ets`/`LogPage.ets` 变更），但**没有测试结果、没有隔离集成、未公网部署、未真机验收**。按本矩阵规则，D2/D3 仍判"部分实现"。

## 4. 特别核实 3：日报/周报/月报是否真实查询历史数据

**结论：不是。没有日报/周报/月报，也没有服务端历史查询接口；现有只是 APP 客户端用 `GET /api/v1/alerts` 全量告警在本地做的"按日期分组"和"近 7 天告警计数"，既不是"报告"，也不等于活动趋势报告。**

- **后端**：路由只有 overview/rooms/alerts/devices/location/contacts/notifications/communications/evidence/ack（`server.js`；新增 dispositions/safety-logs 属本轮实施中）；`GET /api/v1/alerts` 无分页、无日期区间参数，直接返回 `store.listAlerts()` 全量倒序（`server.js:494-510`、`store.js:154-171`）。
- **APP 统计页**：`StatsPage.ets:33-55` 用 `Date.now()` 生成最近 7 天桶，把 `gv.alerts` 按本地日期计数；`:167` 导出按钮只 toast"报告导出未开放（本轮无导出接口）"；`:294-320` 明示"活动分布、睡眠时长、AI 洞察：后端未提供对应接口，暂无数据""报告导出：本轮未开放"。
- **APP 日志页**：`LogPage.ets:1-2,44-74` 把 `gv.alerts` 按 `DateUtil.formatDate` 分组/搜索；是"告警列表的按日期展示"，不是按日/周/月聚合的报表。
- **数据范围限制**：客户端统计受 `GET /alerts` 返回集合限制（当前无分页/日期过滤），跨周/跨月大数据不可控；历史告警持久化在 backend 快照中，但没有日期检索接口。
- **没被验收**：本轮检索归档 evidence，**找不到 LogPage/StatsPage 的运行态截图或 UI 布局 JSON**；只有源码级核对（`2026-10-21-guardian-app-real-api-integration.md:85-86`）。
- **明确不等于**：现有"近 7 天告警统计"是**告警条数**，不是日报/周报/月报，也不是活动/安全报告。

## 5. 特别核实 4：门磁与电量是否来自真实硬件、是否存在默认值/占位

**结论：门磁没有真实硬件与记录（部署节点全部禁用，ESP32 的 `lastOpenTs` 是硬编码 0）；电量在全链路根本不存在字段（没有占位、没有默认值，也没有采集硬件）。必须把"未知"与"真实 0"分开。**

### 5.1 门磁

- 部署节点禁用：厨房 `CONFIG_NODE_DOOR_GPIO=-1`（`profiles/kitchen.sdkconfig.defaults:6`）、卫生间 `-1`（`profiles/bathroom.sdkconfig.defaults:16`）。
- 固件只在编译启用时读取 GPIO（`node_main.c:736-738`），但上报 JSON **无条件**输出 `"door":{"open":%s,"lastOpenTs":0}`（`node_main.c:904`）——`lastOpenTs` **硬编码 0**，不存在开启记录；`s_door_open` 静态初值 0，禁用时永远是 0。
- 因此卫生间启动日志里的 `door.open=false,lastOpenTs=0`（`2026-10-26-bathroom-local-voice/logs/listening-boot-and-runtime.txt`）是**"未知"**，不是"门磁检测到关闭"；`gas/smoke raw=0 valid=false` 同理是"无此传感器/未知"，不是"真实 0 且安全"。`ts=0`（NTP 前）也是"时间未知"。
- 云端原样保存 `sensors`（`store.js:18-60` 白名单内 `sensors` 直接透传），没有门磁有效性标记；APP `DoorSensorDto` 无 presence 标记（`Contracts.ts:30-33,155-161`），只有能力表挡了一层（厨房/卫生间/DAYU 门磁 `installed=false`，不显示；未知设备显示"门磁（待确认）"，`ViewMapper.ts:228-248,299-341`）。
- 硬件现状：门磁实物/接线/GPIO 未完成（`2026-10-24-new-chat-handoff.md:547`）；COM8 客厅板门磁禁用、类型与 SR312 电平未实测（`docs/HARDWARE-MAP.md:27`）；唯一 `living` profile 配了 `DOOR_GPIO=5`（`profiles/living.sdkconfig.defaults:14`）但该板未部署、未绑定、未验收。DAYU homemon 有真实 `lastOpenTs` 计算（`homemon.c:1039-1049`，`homemon.conf:16` `door_gpio=29`），但实物未接线、无验收。
- 历史警示：DAYU 早期页面曾把缺失门磁显示"关闭/正常"，已被判为 UI 误导缺陷（`2026-10-22-three-room-display-and-bath-sos-ack.md:85`、`2026-10-24-new-chat-handoff.md:159`）。

### 5.2 电量

- 固件 `report()` JSON 无 battery 字段（`node_main.c:901-921`）；后端设备模型只有 `csq`（`store.js:58,197`；`persistent-store.js` device 文档含 csq）；APP `DeviceDto` 只有 `csq`（`Contracts.ts:64-79`），无电量字段/展示。
- `DevicePage.ets:5` 明确"不显示虚构的网关性能/电量/信号百分比；csq 0-31 映射信号格，99/缺失显示'未知'"——即**有意不伪造电量**，也不存在默认值。
- 结论：电量 = **需要硬件**（电池 + 采样电路 + 固件字段 + 后端/APP 展示协议），当前 0 实现；不能用 csq/信号格冒充电量。

### 5.3 本轮可引用的"真实 0 是真实值"对照

- 厨房部署的正常版：`gas/smoke raw` 有真实 ADC 且 `valid=true`（`KITCHEN-V20-NORMAL-DEPLOYMENT.json`：21 条采样 `allClimateGasSmokeValid=true`；70 s 被动 MQTT 厨房 12 条 natural、retained=0、时间严格递增）——这才是"真实读数"；
- 卫生间部署节点：`MQ*=-1` 且 `door=-1`，上报里的 0/false 一律不是测量值。

## 6. 特别核实 5：厨房音量20正常版已部署、卫生间尚未部署（精确事实）

**结论：用户口径"厨房音量20正常版已部署、卫生间尚未部署"基本成立，但"卫生间尚未部署"必须精确化为：卫生间的"正常版"确实未部署，但 COM4 已经在 2026-10-26 01:36 被刷入 listening 诊断镜像并重启运行；没有 REPORT、没有用户试听确认、没有完成验收。归档的 master REPORT 说"卫生间 COM4 未烧录"已过时（滞后于 01:36 的刷机日志）。**

### 6.1 厨房（已部署正常版）

| 项 | 值 | 证据 |
|---|---|---|
| 镜像 | `esp32-node/build-voice-kitchenvoice-private-v20/esp32_elder_node.bin`，939,936 B，SHA-256 `A76224A46CC9E6FD737195988B40BE32B861C4AB1E75A9CD26F10F26477DBC11`（本轮复核一致） | `KITCHEN-V20-NORMAL-DEPLOYMENT.json`；`KITCHEN-VOLUME20-TRIAL.md` §切换 |
| 参数 | volume=20、PCM /2 衰减、main stack 8192、MQ-5=GPIO7、MQ-2=GPIO6、GAS/SMOKE 阈值 4096、boot 诊断语音 off | 同上 |
| 烧录 | 仅写应用分区 `0x10000`，esptool exit 0、写后 hash verified，未写 bootloader/分区表/NVS | `KITCHEN-VOLUME20-TRIAL.md`；`KITCHEN-V20-DEPLOYMENT.json`（试听版历史） |
| 运行 | 2026-10-26 01:29:36.982 起 120 s：21 条采样 valid=true、设备时间严格递增、单次 POWERON、无栈溢出、main 最低栈 4060 B；并行 70 s 只读 MQTT：厨房 12 条 natural、retained=0、时间严格递增 | `KITCHEN-SERIAL-NORMAL-V20.json`、`KITCHEN-V20-NORMAL-MQTT-PASSIVE.log`、`KITCHEN-V20-NORMAL-DEPLOYMENT.json` |
| 分类 | `KITCHEN_VOLUME20_NORMAL_DEPLOYED_SHORT_RUN_PASS`（短时运行，非告警闭环） | `KITCHEN-VOLUME20-TRIAL.md` 末尾 |
| 边界 | 用户听感确认来自**已被替换的同参数试听版**（"比之前大了，没有杂音"）；正常版未触发真实告警播放、未做 SOS/FALL/ACK、蜂鸣器联动、断网、长时稳定性 | 同上 |

### 6.2 卫生间（正常版未部署；COM4 曾刷 listening 诊断镜像）

| 事实 | 精确内容 | 证据 |
|---|---|---|
| 刷了什么 | **listening 诊断镜像**（private 构建）：`.local\bathroom-voice-20261026\build\listening-v20\esp32_elder_node.bin`，1,040,096 B（SHA-256 `83E1FE48D61B52A8C777C40638FA291A6F804FC22E2B14C86C29BD585A8A8350`，该哈希为审计时对本地构建文件只读计算、未写入任何文件），写 `0x10000`，esptool v4.7.0 写后 `Hash of data verified`，硬复位 | `competition/evidence/2026-10-26-bathroom-local-voice/logs/flash-listening.txt`（文件时间戳 2026-10-26 01:36:38） |
| 是否正常版 | **不是**。listening 变体来自 `voice-listening-test.sdkconfig.defaults`（`CONFIG_NODE_VOICE_BOOT_TEST=y`，volume 由 `voice-volume20` 覆盖为 20）；启动日志出现 `local-voice: READY playback-only 16000Hz` + `PLAY clip=3`（诊断句，非告警） | `build/build-listening-v20.log` 第 3 行（默认配置链）；`logs/listening-boot-and-runtime.txt`（编译时间 2026-10-26 01:30:38；POWERON 单次；STOP result=ESP_OK cancelled=0） |
| 正常版构建了吗 | 构建了：`.local\bathroom-voice-20261026\build\normal-v20\esp32_elder_node.bin`，933,040 B（SHA-256 `A6ABAF56D7D1EEA873EBDD5B9B5C7DB202449F32E29E6265A4FF7F20066619B6`，审计时只读计算），2026-10-26 01:33:04 构建完成、通过 1 MiB 应用分区校验（0xe3cb0 B，余 0x1c350） | `build/build-normal-v20.log` 末尾 |
| 正常版刷了吗 | **没有刷机证据**。全仓检索 `normal-v20` 只命中构建日志、观察脚本与厨房证据，无 COM4 写 normal-v20 的 esptool 日志 | 本轮 grep（`competition` 全树） |
| 有无 REPORT | **无**。该 evidence 目录只有 `build/`、`host-tests/`、`logs/`，没有 REPORT/MANIFEST/SHA256SUMS | `2026-10-26-bathroom-local-voice/` 文件清单 |
| 是否完成验收 | **没有**。无结构化串口 JSON、无 MQTT 被动日志、无用户听感确认、无长时间观察；只有约 56 s 串口运行日志（末尾 56237 ms）和一份 **0 字节**的 `logs/steady-before-flash.txt` | `logs/`（`steady-before-flash.txt` 0 B） |
| 刷机前基线 | `logs/baseline-before-flash.txt`（01:36:12）显示 COM4 板（MAC `14:c1:9f:42:dd:b4`，deviceId `esp32-bath`）原本正常运行：AHT20 25.2℃，PIR 活动计数、已联网、已连网关 | 同文件 |
| 现有功能影响 | 诊断镜像保留真实告警语音（`local_voice_alarm()` 未变，仅增加启动诊断播放），但板端当前不是"无启动诊断语音"的正常版，每次上电会播"语音播放测试"，且没有针对该板的验收 | `esp32-node/main/local_voice.c:127-128,159-161` |
| 证据链不一致 | master `2026-10-26-local-speaker-candidate/REPORT.md`（更新于 01:33:40）仍写"卫生间 COM4 未烧录，DAYU COM11 未写入"——该句**早于** 01:36:38 的 COM4 刷机日志，属文档滞后 | `REPORT.md:7`；`flash-listening.txt` 时间戳 |

### 6.3 建议的现场口径（不操作设备，仅口径）

- 对用户/评委应表述为："厨房已部署音量20正常运行版（短时观察 PASS）；卫生间正常版尚未部署，当前该板运行的是语音 listening 诊断镜像（曾在 01:36 刷入并重启），尚未完成试听与验收。"
- 若要闭环：先确认 COM4 板身份与当前固件，再按已构建的 `normal-v20`（933,040 B / `A6ABAF56…`）安全烧录应用分区并做启动/采样/告警语音/长时观察；`steady-before-flash.txt` 等空证据需补采（见 `FOLLOWUP-TASKS.md` F-03）。

## 7. 历史 vs 本轮 vs 本地测试 vs 未实现（证据分级）

| 类别 | 内容 | 代表证据 |
|---|---|---|
| **历史真实验收（HISTORICAL-REAL，本轮未重测）** | 手机实时数据/在线/离线恢复（2026-10-22、2026-10-24）；真实 ACK 闭环（2026-10-22 两例）；历史告警列表/详情（2026-10-22）；DAYU 三节点 3/3（2026-10-25）；DAYU 预置语音 playing→completed（2026-10-15）；DAYU SOS 播报软件链路（2026-10-10）；ESP32 设备侧 ACK 语义（2026-10-10/13）；DAYU 安全日志追加（2026-10-10）；厨房蜂鸣器自检（2026-10-20）；温湿度真实显示（2026-10-22） | 见矩阵各行的 evidence 路径 |
| **本轮真实（2026-10-26）** | 一键启动/组件恢复/15 min 稳定（有 P0 复用路径）；厨房音量20正常版部署+120 s 短时观察+70 s 被动 MQTT；卫生间 COM4 刷 listening 诊断镜像并启动（仅此）；USB 断电重启后自动恢复；纯 USB 通信 FAILED | `2026-10-26-demo-autostart/*`、`2026-10-26-local-speaker-candidate/*`、`2026-10-26-bathroom-local-voice/*` |
| **本地构建/单测/主机测试/内存回放（LOCAL）** | 告警逻辑 54/54、卫生间 54/54、房间配置 3/3、引脚保护 6/6；厨房正常版/卫生间两镜像构建；APP 历史单测 21/21；backend 历史 47/47 等 | `HOST-TEST-RESULTS.txt`、`PIN-GUARD-RESULTS.txt`、`build-*.log`、`FINAL-2026-10-24.md`、`VALIDATION-MATRIX.md` |
| **未实现** | 电量采集/展示；门磁实物与开启记录；独立处置结果；后端/APP 持久安全日志；活动时段 APP 展示；每日活动趋势端到端；周/月报告与导出；手机实体手机兼容；远程 SOS；OS 级开机自启 | 矩阵 E3/C4/A2/D2/D3、`2026-10-23-mq2-mq5-app-gap-4g-audit.md` 缺口矩阵 |
| **本轮实施中（未验收）** | 独立处置结果 + 持久安全日志（schema v6 + `/dispositions`、`/safety-logs` + APP 面板/日志页） | `competition/evidence/2026-10-26-alert-disposition-safety-log/CONTRACT.md` + 并行源码改动 |

## 8. 已知阻塞与风险

1. **卫生间现场固件不是预期版本**：COM4 当前为 listening 诊断镜像，正常版未部署；且 master REPORT 仍写"未烧录"，存在口径冲突风险。
2. **处置结果/安全日志尚未落地验收**：仅合同+本地实施中；现有 ACK note 不能当处置结果，DAYU 本地 `safety.log` 不能当平台安全日志。
3. **活动趋势/周月报告无数据通路**：ESP32 上报 hardcode `history/slots`；DAYU 本地有真实 `daily.txt`，但 backend `normalizeStatus` 丢弃 `history/slots`、APP 无映射/展示。
4. **门磁/电量需要硬件**：无已部署门磁、无电池采样；且云端会保存 `door.open=false` 这类"未知"值，后续任何新端/报表若直接读取会误读为"关闭"。
5. **三节点不稳定**：历史 3/3 仅 2026-10-25 一段；2026-10-26 归档为 2/3、1/3–1/1；审计时运行时快照为 3/3（非归档）。离线节点用户另行调试。
6. **冷启动未验收**：无 P0 的 PC 重启路径 NOT TESTED；且审批上需要用户配合重启一次 PC + 隐藏输入一次密钥。
7. **实体手机未验**：APP 验收目标是 HarmonyOS 手机模拟器 `127.0.0.1:5555`；实体手机的权限/布局/性能/后台策略均 NOT TESTED。
8. **声光语音闭环未验收**：厨房未用真实告警触发；卫生间未部署正常版；DAYU 无外接音频时可听输出 FAIL、LED/蜂鸣器无实体验收；气体阈值 4096 禁用（不能宣称"燃气安全"）。
9. **自动启动日志异常**：`Hash mismatch after deploy`（01:18–01:19 四次）未解释，需补核。
10. **公共边界**：本轮审计未做任何设备动作，因此上述所有"现场确认"均需用户授权后另行执行；不得用本报告代替现场验收。

## 9. 产出

- `REQUIREMENTS-MATRIX.md`：A–E 逐子项矩阵（21 个子项，含判定/证据/源码/缺口）。
- `REPORT.md`：本文件（特别核实 1–5、证据分级、阻塞与风险）。
- `FOLLOWUP-TASKS.md`：按原始要求优先级的后续任务清单（目标、依赖硬件/用户动作、验收口径、是否本轮已开始）。

## 10. 复核声明

- 所有"真实"判定均指向已归档的 evidence 或可复核的源码/构建日志；标 `NOT TESTED`/`未实现` 的项目没有通过本地构建、单测、fixture 或历史证据"升级"为通过。
- 审计快照与并行修改并存：本轮并行的"处置结果/安全日志"实现未纳入已实现判定；若其后续测试/部署完成，应更新 D2/D3 与本报告 §3。
