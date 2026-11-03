# 五项原始要求需求矩阵（只读冻结）

- 任务：CORE-GAP-FREEZE（共享任务 task-1）
- 审计角色：auditor（只读审计员）
- 审计时间：2026-10-26 01:43–01:53（Asia/Shanghai）
- 工作目录：`<WORKSPACE>`
- 产出目录（唯一写入范围）：`competition/evidence/2026-10-26-core-gap-freeze/`

## 0. 只读边界与快照说明

本审计**没有**修改任何业务代码、没有打开/写入任何串口、没有执行 ADB/HDC 设备操作、没有触发或 ACK 任何告警、没有发布 MQTT/HTTP ingest、没有读写任何密钥；只读取了文件系统与只读运行时状态文件。

两条快照口径：

1. **证据快照**：本轮开始前已归档的 evidence（2026-10-26 01:43 前），是矩阵判定的主要依据。
2. **源码快照**：审计开始时 backend 基线为 2026-10-14 版本（`store.js` 12,710 B / `persistent-store.js` 58,781 B / `server.js` 30,140 B），APP 基线为 2026-10-24/25 版本。**审计过程中（01:45–01:48）另一组并行任务正在修改** `competition/cloud/backend/src/*` 与 `APP/ElderlyCareGuardian/.../pages|service|core`（新增"处置结果 + 安全日志"），因此：
   - 本矩阵只把**基线已交付并验收**的能力记为"已实现"；
   - 本轮并行实施中的"处置结果/安全日志"单列为"本轮实施中，未验收"，不计入已实现；
   - 文中 `文件:行号` 以审计快照为准，并行修改后行号可能位移，引用时以符号名（函数/路由/字段）为准。

## 1. 判定标签（每子项只能取一个）

| 标签 | 含义 |
|---|---|
| 已实现且真实验收 | 真实硬件/真实链路/真实 UI 运行态证据，且证据归档可追溯 |
| 已实现但未真实验收 | 代码/接口/页面存在，但只有本地构建、单测、内存回放或源码审计，无真实运行态验收 |
| 部分实现 | 只完成一条路径或一部分字段/一端；缺块在"缺口"列写清 |
| 未实现 | 代码与数据通路均不存在 |
| 需要硬件或用户选择 | 主要缺口是未到货硬件、未接线、未定义的现场参数或需用户授权/选择的现场动作 |

证据等级辅助标记：`REAL`（真实运行态）/ `HISTORICAL-REAL`（历史真实验收，本轮未重测）/ `LOCAL`（本地构建、单测、主机测试、内存回放）/ `NOT TESTED` / `NONE`（未实现）。

## 2. A–E 汇总

| 项 | 子项 | 判定 | 关键结论 |
|---|---|---|---|
| A1 | PIR 人体活动采集 | 已实现且真实验收 | 卫生间 PIR 真实计数/最近活动，REAL |
| A2 | 门磁采集 | 需要硬件或用户选择 | 部署节点门磁全部禁用；ESP32 `lastOpenTs` 硬编码 0；实物未接 |
| A3 | 温湿度采集 | 已实现且真实验收 | 厨房/卫生间 AHT20 真实读数，REAL |
| A4 | 便携 SOS | 部分实现 | 卫生间固定实体按键 SOS→ACKED 真实；真正便携无线求助未接入；手机远程 SOS 未开放 |
| A5 | 基础阈值异常识别 | 部分实现 | 优先级状态机+主机测试在；真实越界未触发验收；GAS/SMOKE 阈值 4096=禁用 |
| B1 | 厨房本地声光/语音 | 部分实现 | 蜂鸣器自检 REAL；音量20正常版已部署且短时观察 REAL；真实告警触发声光语音未验收 |
| B2 | 卫生间本地声光/语音 | 部分实现 | 蜂鸣器未做声音验收；语音正常版**未部署**（当前为 listening 诊断镜像）；SOS 求助真实 |
| B3 | DAYU 本地声光/语音 | 部分实现 | 语音播放链路 REAL（playing→completed），但无外接音频时可听输出 **FAIL**；LED/蜂鸣器实体效果无验收记录 |
| B4 | 断网本地求助 | 已实现但未真实验收 | 代码目标已实现，未做断网真机验收 |
| C1 | 手机实时数据 | 已实现且真实验收 | 真实设备实时数据到手机模拟器，REAL；实体手机未测 |
| C2 | 门窗记录 | 需要硬件或用户选择 | 同 A2；无开启记录字段/时间线 |
| C3 | 在线状态 | 已实现且真实验收 | online/monitorOnline 分离、90s 新鲜度，REAL |
| C4 | 电量 | 需要硬件或用户选择 | 全链路无 battery 字段；UI 明确不伪造；需电池采样硬件 |
| C5 | 按日期报告 | 部分实现 | 客户端按日期分组/近7天告警计数；无服务端报表、无导出；无运行态页面验收 |
| C6 | 历史告警 | 已实现且真实验收 | 告警列表/详情真实显示历史告警，REAL |
| D1 | 告警确认 ACK | 已实现且真实验收 | 实体 SOS→APP ACK→202→设备 ACKED→APP"设备已确认"，REAL |
| D2 | 处置结果 | 部分实现 | 仅 ACK 附带的自由文本"处置说明"，无独立结构化处置结果；本轮在实现，未验收 |
| D3 | 安全日志 | 部分实现 | DAYU 本机 `safety.log` 真实持久，但只在设备本地、不可查询；APP"安全日志"页实为告警分组；后端无安全日志台账 |
| E1 | 活动时段 | 部分实现 | 仅 DAYU homemon 本地 `slots[4]` 真实统计；ESP32 硬编码 0；云端丢弃；APP 无展示 |
| E2 | 每日趋势 | 部分实现 | 仅 DAYU homemon 本地 7 日真实累计；ESP32 仅今日一次；云端丢弃；APP 未展示活动趋势 |
| E3 | 周/月报告 | 未实现 | 无接口、无数据通路、无导出；页面明示未开放 |

## 3. 逐子项矩阵（A）

### A. PIR、门磁、温湿度、便携 SOS、基础阈值异常识别

| 子项 | 判定 | 直接证据（路径+时间） | 最直接源码 | 缺口 / 边界 |
|---|---|---|---|---|
| A1 PIR 人体活动采集（南向） | **已实现且真实验收** | `competition/evidence/2026-10-24-app-p0-sensors-local/FINAL-2026-10-24.md`（2026-10-24，PIR 今日次数 126→134 真实走动自动更新，同一 APP PID）；`competition/docs/evidence/2026-10-22-live-nodes-and-guardian-ack-acceptance.md`（esp32-bath 真实 LAN 入站） | `competition/esp32-node/main/node_main.c:713-720`（PIR 消抖确认上升沿更新 `lastActiveTs/countToday`）；`competition/esp32-node/profiles/bathroom.sdkconfig.defaults:8-9`（MOTION=36，确认 2 次） | 仅卫生间节点有 PIR；厨房 `MOTION_GPIO=-1`、DAYU 客厅 PIR 实物未接线（能力表"待确认"）。**REAL** |
| A2 门磁采集 | **需要硬件或用户选择** | `competition/docs/evidence/2026-10-24-new-chat-handoff.md:547`（"门磁实物/接线/GPIO 尚未完成"）；`competition/docs/HARDWARE-MAP.md:27`（COM8 门磁禁用、类型/电平未实测） | `competition/esp32-node/main/node_main.c:736-738`（仅 `CONFIG_NODE_DOOR_GPIO>=0` 才读 GPIO）；`:904`（上报 JSON **固定** `"lastOpenTs":0`）；`competition/esp32-node/profiles/kitchen.sdkconfig.defaults:6`、`bathroom.sdkconfig.defaults:16`（均 `DOOR_GPIO=-1`）；`competition/esp32-node/profiles/living.sdkconfig.defaults:14`（唯一启用 DOOR=5，但未部署/未验证） | 无已部署门磁硬件；固件无开启记录（`lastOpenTs` 硬编码）；`s_door_open` 默认 0 但门磁禁用=**未知，不是真实"关闭"**。 |
| A3 温湿度采集 | **已实现且真实验收** | `competition/docs/evidence/2026-10-22-valid-contract-deployment-acceptance.md`（2026-10-22，厨房 24.6℃/50%RH、卫生间 25.1℃/49%RH 真实显示）；`competition/evidence/2026-10-26-local-speaker-candidate/KITCHEN-V20-NORMAL-DEPLOYMENT.json`（2026-10-26 01:29:36–01:31:33，厨房 21 条采样 climate valid=true、设备时间严格递增） | `competition/esp32-node/main/node_main.c:740-757`（AHT20 读取/有效性与 `CONFIG_NODE_TEMP_*` 阈值）；`:904`（climate 字段） | 客厅 DAYU SHT30 能力"待确认"；气体/烟雾未经标定（见 A5）。**REAL（厨房/卫生间）** |
| A4 便携 SOS | **部分实现** | 真实闭环：`competition/docs/evidence/2026-10-22-live-nodes-and-guardian-ack-acceptance.md` §4（2026-10-22 14:42 用户按卫生间实体 SOS → `MANUAL_SOS e-1792651351-2` → 14:48 APP ACK → 设备 ACKED）；`competition/evidence/2026-10-26-local-speaker-candidate/REPORT.md:9`（"不是随身求助新节点"） | 卫生间实体按键：`competition/esp32-node/main/node_main.c:938-957`（SOS 快路径，确认 2 次≈200 ms 触发）；`:943`（`MANUAL_SOS`）；`competition/esp32-node/profiles/bathroom.sdkconfig.defaults:10-11`（SOS=15） | 真正**便携/随身无线**求助未接入：DAYU homemon 仅有 433M 接收脚配置（`competition/southbound/homemon.conf:19-21`，`button_gpio=106`），无实体按压验收；手机端悬浮远程 SOS 明确"未开放"（`APP/ElderlyCareGuardian/entry/src/main/ets/components/SosFloatingButton.ets`；`competition/docs/evidence/2026-10-23-mq2-mq5-app-gap-4g-audit.md:113`）。 |
| A5 基础阈值异常识别 | **部分实现** | 主机测试：`competition/evidence/2026-10-26-local-speaker-candidate/HOST-TEST-RESULTS.txt`（告警逻辑 54/54、卫生间逻辑 54/54、房间配置 3/3、引脚保护 6/6，LOCAL）；真实告警触发：无（历史只有 `control` 注入式 GAS/NO_MOTION，见 `competition/evidence/2026-10-10-third-device-validation/17-dayu-ack-line-count.txt`） | `competition/esp32-node/main/alarm_logic.h`（优先级/确认/回差/重新武装纯逻辑）；`competition/esp32-node/main/node_main.c:816-834`（GAS>SMOKE>WATER>CLIMATE>NO_MOTION 优先级）；`:857-886`（状态机，ACKED 重新武装）；`profiles/kitchen.sdkconfig.defaults:14-15`（GAS/SMOKE 阈值 4096=禁用）；`bathroom.sdkconfig.defaults:35`（NO_MOTION 1800s） | 温湿度/无人活动阈值逻辑已实现且有主机测试，但**真实传感器越界触发未验收**；GAS/SMOKE 阈值 4096 高于 12-bit 上限=永不告警（未标定，禁止声称"燃气正常"）；视觉跌倒属另一工作包且真机姿态验收 BLOCKED（`competition/evidence/2026-10-25-p1b-dayu-local-fall/LIVE-SAFETY-ACCEPTANCE.md`）。 |

## 4. 逐子项矩阵（B）

### B. 本地灯/蜂鸣器/语音与求助（厨房/卫生间/DAYU 各自到哪一步）

| 子项 | 判定 | 直接证据（路径+时间） | 最直接源码 | 缺口 / 边界 |
|---|---|---|---|---|
| B1 厨房本地声光/语音 | **部分实现** | 蜂鸣器自检 300 ms REAL：`competition/docs/evidence/2026-10-20-kitchen-esp32-node-hardening.md`（0.3 s 短鸣→自动静音，随后恢复生产配置）；语音音量20正常版已部署+短时观察：`competition/evidence/2026-10-26-local-speaker-candidate/KITCHEN-V20-NORMAL-DEPLOYMENT.json`、`KITCHEN-VOLUME20-TRIAL.md`（2026-10-26 01:29:36 起 120 s 21 条采样、无栈溢出；用户对同参数试听版确认"比之前大了，没有杂音"；MQTT 70 s 厨房 12 条自然上报 retain=0） | `competition/esp32-node/main/local_voice.c:127-128`（`MANUAL_SOS`→求助录音，其它异常→警示录音）、`:130-167`（playback-only ES8388 初始化）；`competition/esp32-node/main/node_main.c:806-807`（新告警响铃+语音）；`profiles/kitchen.sdkconfig.defaults`（`BUZZER_XL9555=y`） | 无真实告警触发过声光/语音（`KITCHEN-VOLUME20-TRIAL.md:78` 明示）；厨房无"灯"；蜂鸣器与语音同时工作表现未验收；正常版未做长时/断网/手机回归。 |
| B2 卫生间本地声光/语音与求助 | **部分实现** | SOS 求助真实：`competition/docs/evidence/2026-10-22-live-nodes-and-guardian-ack-acceptance.md` §4（ACKED 真实）；语音镜像仅构建：`competition/evidence/2026-10-26-local-speaker-candidate/REPORT.md:42-49`（LOCAL BUILD）；**本轮实际刷机**：`competition/evidence/2026-10-26-bathroom-local-voice/logs/flash-listening.txt`（2026-10-26 01:36:38，COM4 写 0x10000，1,040,096 B，Hash verified）、`logs/listening-boot-and-runtime.txt`（编译时间 2026-10-26 01:30:38；`local-voice: READY playback-only`，`PLAY clip=3` 启动诊断语音） | `competition/esp32-node/profiles/bathroom.sdkconfig.defaults`（无 `VOICE_ENABLED`，语音需 overlay）；`competition/esp32-node/main/local_voice.c:159-161`（`CONFIG_NODE_VOICE_BOOT_TEST` 才播诊断句）；`main/node_main.c:797-811`（告警→语音） | 蜂鸣器仅有 XL9555 配置，**无声音验收记录**；语音正常版**未烧录**；COM4 当前运行的是 listening 诊断镜像（每次启动播"语音播放测试"），无 REPORT、无用户试听确认归档；只有约 56 s 串口日志，无 MQTT 被动证据。 |
| B3 DAYU 本地声光/语音与求助 | **部分实现** | 语音播放链路 REAL：`competition/docs/evidence/2026-10-15-dayu-preset-voice-playback.md`（5/5 `playing→completed`+回执 HTTP 200）；同一文件 §6：**无耳机/无外接音箱可听输出 FAIL**；SOS 播报软件链路 REAL：`competition/evidence/2026-10-10-OH7.0-验证记录.md` §3（`say.sh` 被调用、SosVoiceAbility `playing→completed`，但明确"不能证明实体扬声器出声"） | `competition/southbound/src/homemon.c:266-270`（`say()` 调 `say_cmd`）、`:287-296`（告警→语音文本）、`:320-323`（NORMAL 绿/WARN 黄闪/ALARM 红闪+鸣/ACKED 蓝灯）；`competition/southbound/homemon.conf:23-24,40-46`（`buzzer_gpio=105`、三色 LED、`say_cmd`） | LED/蜂鸣器**实体效果无任何验收记录**（本轮也未在 evidence 找到实测）；语音需外接 Speaker/耳机才可听（板载无喇叭）；随身体 SOS 按钮（433M）无实体按压验收。 |
| B4 断网本地求助 | **已实现但未真实验收** | `competition/evidence/2026-10-26-local-speaker-candidate/REPORT.md:18`（"断网本地求助为代码实现目标，尚未真机验收"）、`:68`（"断网/恢复测试不能通过擅改 Wi-Fi/AP 完成"） | `competition/esp32-node/main/node_main.c:55-62`（语音启用时网络收发迁独立任务、邮箱只保最新状态，非可靠离线日志）、`:938-957`（SOS 快路径不等网络） | 未做真实断网/AP 关闭验收；上报队列非可靠离线告警日志。**LOCAL/NOT TESTED** |

## 5. 逐子项矩阵（C）

### C. 手机实时数据、门窗记录、在线、电量、按日期报告、历史告警

| 子项 | 判定 | 直接证据（路径+时间） | 最直接源码 | 缺口 / 边界 |
|---|---|---|---|---|
| C1 手机实时数据 | **已实现且真实验收** | `competition/docs/evidence/2026-10-22-live-nodes-and-guardian-ack-acceptance.md`（2026-10-22，真实账号、APP 监测页 2/5 在线、真实温湿度/PIR/离线历史读数，`guardian-live-final-monitor-20261022.jpeg`）；`competition/evidence/2026-10-24-app-p0-sensors-local/FINAL-2026-10-24.md`（2026-10-24，同一 APP PID 自动刷新 100 s 读数前进、PIR 126→134、90 s 自然离线与恢复） | `APP/ElderlyCareGuardian/entry/src/main/ets/service/GuardianService.ets`（`refreshAll()`/`fetchDevices`/`fetchAlerts`）；`core/api/ApiClient.ts`；`pages/MonitorPage.ets`、`pages/DevicePage.ets`；后端 `competition/cloud/backend/src/server.js:488-519`（overview/rooms/alerts/devices/location） | 目标为 **HarmonyOS 手机模拟器 `127.0.0.1:5555`**，实体手机兼容性 NOT TESTED（`2026-10-23-mq2-mq5-app-gap-4g-audit.md:133`）；首页概览计数曾不同步。**REAL（模拟器）** |
| C2 门窗记录 | **需要硬件或用户选择** | 同 A2（无门磁硬件/记录）；`competition/docs/evidence/2026-10-22-three-room-display-and-bath-sos-ack.md:85`（历史 DAYU 页面曾把缺失门磁显示"关闭"，属误导，已被能力表修正） | `APP/ElderlyCareGuardian/entry/src/main/ets/core/view/ViewMapper.ts:228-248`（`buildDoorView`：能力未安装直接返回 null，不伪造）；`core/api/Contracts.ts:30-33,155-161`（`DoorSensorDto` **无 presence 标记**，`open` 默认 false）；`core/capability/DeviceCapabilities.ts:132,153,170`（厨房/卫生间/DAYU 门磁均 installed=false） | 无 true 开启记录数据源；即便 DAYU homemon 有 `door_gpio=29` 的 `lastOpenTs` 计算能力（`southbound/src/homemon.c:1039-1049`），实物未接线、未验收。 |
| C3 在线状态 | **已实现且真实验收** | `competition/evidence/2026-10-24-app-p0-sensors-local/FINAL-2026-10-24.md`（3/5→2/5→3/5 自然离线/恢复，同一 PID）；`competition/docs/evidence/2026-10-22-live-nodes-and-guardian-ack-acceptance.md`（2/5） | `APP/.../core/view/ViewMapper.ts:402-409`（`isDeviceFresh` 90 s 新鲜度、online/monitorOnline 分开）；`competition/cloud/backend/src/store.js:184-199`（`toPublicDevice` 同时返回 online/monitorOnline）；`competition/docs/APP-API-v1.md:61-62`（monitorOnline 语义） | 在线数随现场节点波动（见三节点口径）；overview 旧计数曾与 devices 不同步。 |
| C4 电量 | **需要硬件或用户选择** | 全链路无 battery 字段：固件上报无 battery（`node_main.c:901-921`）、后端设备模型只有 `csq`（`store.js:58,197`）、APP `DeviceDto` 无 battery（`Contracts.ts:64-79`） | `APP/.../pages/DevicePage.ets:5`（"不显示虚构的网关性能/电量/信号百分比；csq 0-31 映射信号格，99/缺失显示未知"）；`core/api/Contracts.ts:77-78`（csq 语义） | **不存在默认值/占位**（字段都不存在）；需增加电池采样硬件+固件字段+后端+APP 展示；且不可用 csq 冒充电量。 |
| C5 按日期报告 | **部分实现** | `competition/docs/evidence/2026-10-21-guardian-app-real-api-integration.md:85-86`（源码级：StatsPage 仅 alerts 推导统计、LogPage 真实 alerts 按日期分组）；无 LogPage/StatsPage 运行态截图/布局证据（本轮检索 `pages/LogPage`/`pages/StatsPage` 无归档运行态 JSON） | `APP/.../pages/LogPage.ets:1-2`（"安全日志页——真实 gv.alerts 按本地日期分组"）、`:44-74`（按 `DateUtil.formatDate` 分组+搜索）；`pages/StatsPage.ets:33-55`（客户端生成近 7 天桶并计数）、`:167`（"报告导出未开放"）、`:294-320`（活动/睡眠/AI/导出明示暂无数据） | 只有**客户端派生**的按日期分组与近 7 天告警计数；无服务端按日期报表/区间查询/导出；StatsPage/LogPage 无真实验收；周/月维度不存在（见 E3）。 |
| C6 历史告警 | **已实现且真实验收** | `competition/docs/evidence/2026-10-22-live-nodes-and-guardian-ack-acceptance.md:76`（14:42 后待确认告警增加到 17 条，含历史记录；只真实 ACK 其中一条，未批量确认）；`competition/docs/evidence/2026-10-22-three-room-display-and-bath-sos-ack.md`（新增 SOS 告警出现在列表） | `competition/cloud/backend/src/server.js:494-510`（`GET /api/v1/alerts` 返回 `store.listAlerts()` 全量，倒序）；`store.js:154-171`（`listAlerts` 字段：id/alarmId/deviceId/roomName/type/message/state/ackPending/createdAt/acknowledgedAt/acknowledgedBy/evidenceId）；`APP/.../pages/AlertListPage.ets`、`pages/AlertDetailPage.ets`、`core/view/ViewMapper.ts:560-590`（状态映射） | 接口无分页/无日期区间参数；「按日期分组」页（LogPage）属 C5 未运行态验收；告警条目历史真实验收来自 2026-10-22，本轮未重测。 |

## 6. 逐子项矩阵（D）

### D. 告警确认、处置结果、安全日志

| 子项 | 判定 | 直接证据（路径+时间） | 最直接源码 | 缺口 / 边界 |
|---|---|---|---|---|
| D1 告警确认 ACK | **已实现且真实验收** | `competition/docs/evidence/2026-10-22-live-nodes-and-guardian-ack-acceptance.md` §4（2026-10-22 14:42 实体 SOS `e-1792651351-2` → 14:48 APP ACK→HTTP 202命令入队→Bridge 写实体节点→设备 ACKED→APP"设备已确认"，另见 `guardian-live-ack-confirmed-20261022.jpeg`）；第二例：`competition/docs/evidence/2026-10-22-three-room-display-and-bath-sos-ack.md`（16:46 新 SOS→约 16:46:50 ACKED）；设备侧错误/正确/重复 ACK：`competition/docs/evidence/2026-10-13-esp32-final-ack.md` | `competition/cloud/backend/src/server.js:656-663`（`POST /api/v1/alerts/{alarmId}/ack`：`requestAck(alarmId, body.note, HOUSEHOLD_ACTOR)`→202 `{accepted,status:PENDING,commandId}`）；`store.js:237-259`（`requestAck` 建 ACK 命令、`ackPending=true`）、`:265-318`（`completeCommand` 仅设备回执后 `ACKED`）；`APP/.../service/GuardianService.ets`（`ackAlert()`：202 只当 PENDING，轮询到 ACKED）；`APP/.../pages/AlertDetailPage.ets`（ACK 面板状态机 idle→submitting→waiting→confirmed）；`competition/docs/APP-API-v1.md:84-93` | 当次 ACK 晚于蜂鸣器 10 s 自动静音窗口，"ACK 立即静音"未验证；实体手机未测（模拟器）；本轮未重测。**HISTORICAL-REAL** |
| D2 处置结果 | **部分实现** | 基线仅有 ACK 附注：`competition/docs/APP-API-v1.md:84-93` 的 ack 请求体 `{"note":"..."}`；`competition/evidence/2026-10-10-third-device-validation/17-dayu-ack-line-count.txt`（`safety.log` 每行 `时间,alarmId,处置说明`）；本轮合同：`competition/evidence/2026-10-26-alert-disposition-safety-log/CONTRACT.md`（新增 5 项 outcome 枚举+独立 `/dispositions` 接口，**实施合同，非已验收**） | `competition/cloud/backend/src/server.js:656-663`（note 只作为 ACK 命令 action）；`store.js:237-259`（`boundedText(action,120,'监护人已确认')`→命令 `action` 与 `alert.action`，**不进入任何独立处置记录**）；`APP/.../pages/AlertDetailPage.ets:852`（输入框占位文案"处置说明（选填，最多 120 字）"）；`APP/.../service/GuardianService.ets`（`ackAlert(alarmId, note)`，无 outcome） | **没有结构化的"处置结果"**：无 outcome 枚举、无独立记录、无独立查询/时间线、与 ACK 强耦合；ACK note 后端落 `alert.action`/`command.action`，但 `GET /api/v1/alerts`（`store.js:154-171`）**不返回 `action`**，APP 也不显示，故事后不可查。本轮并行任务正在实现独立处置，未完成/未验收/未部署。 |
| D3 安全日志 | **部分实现** | DAYU 本机安全日志真实存在：`competition/evidence/2026-10-10-third-device-validation/17-dayu-ack-line-count.txt`（正确 ACK 后 `safety.log` 2→3 行；重复 ACK 不增加；错 ID 不写）；`competition/docs/VALIDATION-MATRIX.md:33`（重复 ACK 不增加安全日志 PASS）；APP 侧无独立安全日志：`competition/evidence/2026-10-24-app-p0-sensors-local/FINAL-2026-10-24.md` 的验收页面清单不含 LogPage | `competition/southbound/src/homemon.c:503-547`（仅 `state==ST_ALARM` 且 alarmId 精确匹配时 ACKED 并 `fprintf("%lld,%s,%s\n")` 追加 `%s/safety.log`）；`competition/southbound/README.md:9,144`（"每次 ack 追加一行 → 对应赛题'居家安全日志'"） | ① 仅 **DAYU 设备本地文件**，APP/后端**不可查询/导出**，设备重置/清数据即丢；② 只记录 ACK 事件，不是独立处置台账；③ APP 名为"安全日志"的页面实际是 alerts 按日期分组（`LogPage.ets:1-2`）；④ 后端基线持久化 schema v5 无 safetyLogs（`persistent-store.js:48-49,105`）。本轮合同 schema v6 正在实现，未验收。 |

## 7. 逐子项矩阵（E）

### E. 活动时段、每日趋势、周/月报告

| 子项 | 判定 | 直接证据（路径+时间） | 最直接源码 | 缺口 / 边界 |
|---|---|---|---|---|
| E1 活动时段 | **部分实现** | 设备侧仅 DAYU 有真实时段统计代码：`competition/southbound/src/homemon.c:387-401`（4 时段：6–9/9–12/12–18/18–22，逐次活动归类）、`:328-330`（持久化到 `/data/homemon/daily.txt`）；ESP32 节点时段为硬编码 0：`competition/esp32-node/main/node_main.c:908`（`"slots":[0,0,0,0]`）；APP 明示无数据：`APP/.../pages/StatsPage.ets:308`（"活动分布、睡眠时长、AI 洞察：后端未提供对应接口，暂无数据"） | `competition/southbound/src/homemon.c:386-402`；`competition/esp32-node/main/node_main.c:908`；`competition/cloud/backend/src/store.js:18-60`（`normalizeStatus` 白名单**不含 history/slots**，云端丢弃）；`competition/cloud/backend/src/server.js:381-386`（内部 ingest 走 `normalizeStatus`） | DAYU 本地有真实时段累计，但**未打通到云端/APP**；ESP32 侧无；无跨天真实数据证据；APP 无时段热力图。 |
| E2 每日趋势 | **部分实现** | 同上：`homemon.c:328-384`（`g_days[7]` 真实 6 日历史+今日，跨天左移，持久化 `daily.txt`），`:805-829`（状态 JSON 携带 `history`/`slots`）；ESP32：`node_main.c:908`（`"history":[0,0,0,0,0,0,countToday]` 只有今日）；APP 只有**告警** 7 天统计（`StatsPage.ets:33-55`），非活动趋势 | `competition/southbound/src/homemon.c:328-401,805-829`；`competition/esp32-node/main/node_main.c:908`；`competition/cloud/backend/src/store.js:18-60`；`APP/.../pages/StatsPage.ets:33-55` | 云端 `normalizeStatus` 丢弃 `history/slots`（设备 JSON 顶层字段不进 `sensors`），APP 无映射；现有"近 7 天告警统计"是告警条数，**不是每日活动趋势**；无真实多日样本验收。 |
| E3 周/月报告 | **未实现** | `APP/.../pages/StatsPage.ets:167`（导出按钮只提示"报告导出未开放（本轮无导出接口）"）、`:314`（"报告导出：本轮未开放"）；`competition/cloud/backend/src/server.js` 路由清单无任何 report/stats/date-range 接口（仅有 overview/rooms/alerts/devices/location/contacts/notifications/communications/evidence/ack）；设计稿仅规划：`competition/evidence/2026-10-24-app-refresh-diagnostic/app/DESIGN_SYSTEM.md:113`（"数据统计 StatsPage ── 活动时段热力图 · 周月报告"） | 无实现源码 | 无周/月周期定义、无聚合、无导出、无报告模板；活动/安全数据通路也未到云端（见 E1/E2）。**NONE** |

## 8. 分类统计

| 判定 | 子项数 | 子项 |
|---|---:|---|
| 已实现且真实验收 | 6 | A1、A3、C1、C3、C6、D1 |
| 已实现但未真实验收 | 1 | B4 |
| 部分实现 | 10 | A4、A5、B1、B2、B3、C5、D2、D3、E1、E2 |
| 未实现 | 1 | E3 |
| 需要硬件或用户选择 | 3 | A2、C2、C4 |
| **合计** | **21** | A1–A5（5）+ B1–B4（4）+ C1–C6（6）+ D1–D3（3）+ E1–E3（3） |

## 9. 三节点可用性口径（不要把历史 3/3 或当前波动混写）

- **历史真实 3/3（仅历史）**：`competition/evidence/2026-10-25-dayu-three-node-recovery/REPORT.md`（2026-10-25 22:29:15–22:34:15，10 个 30 s 样本，三节点 Bridge/supervisor 持续增长；页面"全屋在线 3/3"）。
- **2026-10-26 01:29–01:31 被动 MQTT 窗口**：厨房 12 条、客厅 23 条、**卫生间 0 条**（`competition/evidence/2026-10-26-local-speaker-candidate/KITCHEN-V20-NORMAL-MQTT-PASSIVE.log`）；同期厨房串口 21 条采样正常。
- **2026-10-26 01:36 卫生间 COM4 刷 listening 镜像前后**：`baseline-before-flash.txt`（01:36:12）显示卫生间节点原本正常联网上报；刷机重启后 `listening-boot-and-runtime.txt`（至 01:37:46）显示重新联网、POWERON 单次、自然上报。
- **已归档的最新三节点口径**：`competition/evidence/2026-10-26-demo-autostart/REPORT.md` 最终 **2/3**；`competition/evidence/2026-10-26-demo-autostart-followup/REPORT.md` §1 为 **1/3 至 1/1**（用户另行调试，本轮排除）；`COLD-START-HANDOFF.md`（01:22 左右）为 **1/1**。
- **审计时只读运行时快照（非归档验收）**：`competition/evidence/2026-10-26-demo-autostart/runtime/watcher-state.json` 时间戳 2026-10-26 01:46:21 显示 `nodes:"3/3"`、`inference:"running"`、`cameraFrames:"LIVE"`、eventCount 7431。该快照与 01:22 交接（1/1）不一致，最可能是节点波动 + 卫生间刷机重启后重连所致；**不能据此声称三节点 3/3 已验收**。
- **结论口径**：当前**不声称 3/3**；只读窗口可确认"厨房在线、客厅在线、卫生间状态波动且刚经历诊断镜像刷机"；离线节点由用户另行调试，不构成本轮通过/阻塞条件。

## 10. 本轮并行实施中（不计入已实现）

`competition/evidence/2026-10-26-alert-disposition-safety-log/CONTRACT.md`（2026-10-26 01:42）定义了独立"处置结果 + 安全日志"：
- 新增 `POST/GET /api/v1/alerts/{alarmId}/dispositions`、`GET /api/v1/safety-logs`；
- 持久化 schema v6 新增 `safetyLogs`（v1–v5 可加载）；
- APP 告警详情新增独立"处置结果"面板、LogPage 新增"安全日志"切换。

审计时（01:45–01:48）backend/APP 源文件正在被并行修改（`safety-log.js` 新增、`store.js`/`persistent-store.js`/`server.js`/`GuardianService.ets`/`AlertDetailPage.ets`/`LogPage.ets` 均有新改动），尚无测试/隔离集成/部署证据。**按本矩阵规则，D2/D3 仍为"部分实现"，直至真实测试与（部署）验收完成。**
