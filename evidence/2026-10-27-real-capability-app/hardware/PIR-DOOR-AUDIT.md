# PIR / 门磁 / 水漏 / MQ 真实安装与固件配置 —— 2026-10-27 只读审计

- 工作区：`<WORKSPACE>`；边界：只读源码/配置/构建产物/日志/UI 快照；未开串口、未烧录、未连设备、未访问生产后端。
- 分级：**REAL**（本轮可复核事实）/ **SOURCE-ONLY**（代码在、无实物或未随构建部署）/ **NOT TESTED**（未现场验证）/ **BLOCKED**（需设备/授权）。

## 0. 结论速览

| 设备 | PIR | 门磁 | 水漏 | MQ-2 | MQ-5 | 关键依据 |
|---|---|---|---|---|---|---|
| esp32-kitchen | **已装，真实**（SR312 / GPIO38 / 2026-10-27 01:15 刷入） | **已装，真实**（干簧管 NO / GPIO14 / 01:35 刷入 / 真实开关验收） | 未安装（`WATER_GPIO=-1`，IO37 预留） | 已接（GPIO6/ADC1_CH5，原始 ADC，报警禁用） | 已接（GPIO7/ADC1_CH6，原始 ADC 4095 饱和，报警禁用） | `.local/door-v7-20261027/build-kitchen/config/sdkconfig.json`；`evidence/2026-10-27-voice-led-restore/KITCHEN-PIR-FLASH-RECORD.md`；`evidence/2026-10-26-door-contact-closure/report.md` §9 |
| esp32-bath | **已装，真实**（GPIO36；本机状态有活动计数） | **已装，真实**（GPIO14 / 真实开关验收 seq 1–5） | 未安装（`WATER_GPIO=-1`，IO37 预留） | 无 | 无 | `.local/door-v7-20261027/build-bath/config/sdkconfig.json`；`bridge/status.json`；`evidence/2026-10-26-door-contact-closure/report.md` §5、§6 |
| esp32-sos | 无 | 无 | 无 | 无 | 无 | `D:\esp32-sos-build\profiles\sos-node.sdkconfig.defaults:16-34` |
| dayu200-living | **无 PIR**；其 NO_MOTION 由 homemon 30 分钟计时产生，**不是 PIR 能力** | 无（APP 能力表“待确认”） | 无 | 无 | 无 | `southbound/src/homemon.c:1103-1105`；`docs/evidence/2026-10-26-new-chat-handoff.md:88` |
| esp32-node-wearable | 无 | 无 | 无 | 无 | 无 | `esp32-node-wearable/WIRING.md:55-62` |

> 关键点：**“生产告警长时间无活动 · esp32-kitchen”不是能力冲突，而是“静态能力表过期 + 固件已升级”的时间差。** 详见 §2。

## 1. 逐项证据

### 1.1 厨房 PIR（2026-10-27 新增）

- 源码层：`esp32-node/main/node_main.c` 的 PIR/无活动路径全部由 `#if CONFIG_NODE_MOTION_GPIO >= 0` 条件编译（`:152-154` 状态、`:627-638` GPIO 初始化、`:1237-1252` 采样、`:1413-1430` 无活动判定、`:1480-1490` 恢复判定）。**公开 kitchen profile 仍是 `-1`**：`esp32-node/profiles/kitchen.sdkconfig.defaults:5`。
- 实物上板：`evidence/2026-10-27-voice-led-restore/KITCHEN-PIR-FLASH-RECORD.md`
  - 镜像 `1,020,192 B / F67AC3CE…A670F0`，`CONFIG_NODE_MOTION_GPIO=38`、确认 2 次、`NO_MOTION_SEC=1800`、`NO_MOTION_REQUIRE_ARM=y`（`:22-33`）；
  - 首启串口日志出现 `检测到活动（今日第 1 次）`（`:44-57`）→ PIR 实物工作；
  - 该记录明确写“30 分钟无活动告警已配置、未现场观察触发”（`:84-88`）。
- 后续 v7 门磁固件仍保留 PIR：`esp32-node/.local/door-v7-20261027/build-kitchen/config/sdkconfig.json` → `NODE_MOTION_GPIO = 38`、`NODE_NO_MOTION_SEC = 1800`、`NODE_NO_MOTION_REQUIRE_ARM = true`、`NODE_ALARM_BENCH_INJECT = false`（正常现场固件）。
- 结论：**厨房 PIR 能力 REAL（2026-10-27 01:15 起）**；但**公开源码树仍不具备**该配置，重建必须叠加私有 overlay，否则 PIR 消失（回归风险）。

### 1.2 卫生间 PIR

- 固件配置：`profiles/bathroom.sdkconfig.defaults:8` `CONFIG_NODE_MOTION_GPIO=36`，确认 2 次（`:9`）；v7 构建同样为 36。
- 实物运行证据（只读快照）：`competition/bridge/status.json`（`esp32-bath`，2026-10-27 约 02:23）
  - `"motion":{"lastActiveTs":1793038953387,"countToday":81}` → 当天 81 次活动，PIR 真实工作；
  - 同帧 `"door":{"open":false,..."seq":37}` → 门磁也在工作。
- 历史阶段：`docs/evidence/2026-10-20-bathroom-esp32-stage1-source.md:1-5` 当时只做源码/主机测试（NOT FLASHED）；后续 2026-10-20 起真实运行并沿用。
- 结论：卫生间 PIR **REAL**（当前在线状态未能复核，见 §4）。

### 1.3 门磁（厨房 + 卫生间）

- 硬件：两线无源干簧管，万用表实测**常开型 NO**；接线 `一端→GPIO14（内部上拉），另一端→GND`；磁铁靠近=闭合=低=关闭，远离=断开=高=开启；`NODE_DOOR_OPEN_LEVEL=1`——`evidence/2026-10-26-door-contact-closure/report.md:142-158,232-240`。
- 固件实现（**只存在于私有副本**）：
  - 公共树 `main/Kconfig.projbuild:163-167` 只有 `NODE_DOOR_GPIO`，**没有** `NODE_DOOR_OPEN_LEVEL/CONFIRM_COUNT/CACHE_MAX/KEEP_SEC`；
  - 公共树 `main/node_main.c:1539` 门磁 JSON 固定 `"lastOpenTs":0`，无 `lastCloseTs/seq/events`；
  - 私有实现（去抖/基线/NVS seq/FIFO 补传）在 `.local/door-contact-20261026/src`、`.local/door-v7-20261027/{kitchen-src,bath-src}`，见 `report.md:75-93` 与 `evidence/2026-10-27-door-v7-e2e/REPORT.md:58-68`。
- 真实验收：
  - 卫生间：开关 seq 1–5、保持不重复、无抖动（`report.md:17-22`），已烧录 v7 镜像 `56D9A805…AA6B`（`door-v7-e2e/REPORT.md:62`）；
  - 厨房：开关 seq 1–13、重启 seq 10→13 持续（`report.md:253-287`），v7 镜像 `0AA8144D…E179B`（`door-v7-e2e/REPORT.md:62`）；
  - 生产后端 v7 部署后 `doorEvents` 26 条、设备时间、按 seq 补传去重（`door-v7-e2e/REPORT.md:12-14,89-115`）。
- 结论：门磁 **REAL**（两节点均已装、已上板验收、生产后端已入库）。但 **APP 能力表仍未标“已接入”**（见 §2.2），且公共源码树重建会退回“无门磁事件”。

### 1.4 水漏

- 公开 profile：`profiles/bathroom.sdkconfig.defaults:12` `CONFIG_NODE_WATER_GPIO=-1`；厨房 v7 固件同样 `NODE_WATER_GPIO=-1`。
- 文档：`docs/evidence/2026-10-20-bathroom-esp32-stage1-source.md:6,37,48,117` —— 硬件（5 线探头，COM→GND、NO→IO37，干接点）已描述，但“本轮不做，明天再启用”，代码与主机测试就绪（SOURCE-ONLY）。
- 现状：没有任何“已接线/已装水漏”的验收记录；APP 能力表标注“水漏本轮禁用/未启用”与之一致（`DeviceCapabilities.ts:150`）。
- 结论：**未安装（SOURCE-ONLY）**。仅代码路径存在，不得声称具备水漏监测。

### 1.5 MQ-2 / MQ-5（厨房）

- 实物接线：MQ-2 AO→GPIO6/ADC1_CH5；MQ-5 AO→**GPIO7/ADC1_CH6**（语音改线后必须叠加 `profiles/kitchen-voice-rewire.sdkconfig.defaults:5`，否则与 I2S LRCK GPIO9 冲突）——`evidence/2026-10-26-wireless-sos-button-final/WIRING.md:29-32`；`docs/evidence/2026-10-26-new-chat-handoff.md:56-66`。
- 固件：`Kconfig.projbuild:217-241` 的 ADC 通道与阈值；v7 构建 `NODE_MQ2_ADC_CHANNEL=5`、`NODE_MQ5_ADC_CHANNEL=6`、`NODE_MQ2_ALARM_RAW=4096`、`NODE_MQ5_ALARM_RAW=4096`（4096=禁用）。
- 生产读数（APP 设备管理页快照）：厨房 `燃气（MQ-5）上次读数 原始 ADC 4095`、`烟雾（MQ-2）上次读数 原始 ADC 115`，文案“报警未启用 · 未标定，原始 ADC 不代表 ppm，也不代表安全”——`baseline/layout/devmgmt_top.json`。
- 风险备注：`4095` 是 12-bit 满量程，**无法区分“烟感未接/浮空/量程顶死”与“高浓度”**；且阈值 4096 永不告警（`Kconfig.projbuild:233-241`；`2026-10-26-core-gap-freeze/REPORT.md` A6）。本轮不得把它当燃气安全能力。
- 结论：MQ 两路**已接、有真实原始 ADC（REAL）**；**标定/报警能力 = 禁用（NOT TESTED + 未启用）**，不得表述为 ppm/燃气安全。

### 1.6 其它板卡

- esp32-sos：PIR/门磁/水漏/温湿度/MQ 全部 `-1`（`D:\esp32-sos-build\profiles\sos-node.sdkconfig.defaults:15-34`）。
- dayu200-living：**没有物理 PIR**；它出现的 `NO_MOTION` 来源是 `southbound/src/homemon.c:1103-1105`（`idle >= no_motion_sec`，30 分钟默认 `:847`），而 homemon 的 `last_motion_ms` 仅在配置了 `motion_gpio` 且读到活动时更新（`:1021-1033`），**没有“先武装”门槛**（对比 ESP32 固件 `NODE_NO_MOTION_REQUIRE_ARM=y`）。即：按源码，`motion_gpio` 未配置的 homemon 也会在启动 30 分钟后超时报 NO_MOTION。只读桥接日志中 `dayu200-living` 长期出现 `state=ALARM countToday=0`（`bridge/_test/current-runtime/supervisor/bridge.out.log:18852-18914`），形态与该超时告警一致，但日志未打印 `alarm.type`，**不能仅凭日志确认类型**（旁证，NOT TESTED 类型）。结论：不能由“出现 NO_MOTION”反推该房间有 PIR。
- esp32-node-wearable：按钮 GPIO4、蜂鸣器 GPIO5、UART1 17/18，无 PIR/门磁/水漏/MQ（`WIRING.md:55-62`）。

## 2. “长时间无活动 · esp32-kitchen”与“厨房无 PIR”为什么不矛盾

### 2.1 三层时间线

| 时间 | 事实 | 依据 |
|---|---|---|
| 2026-10-21 之前 | APP 能力表依据“只读核对”写死：厨房 `无 PIR、门磁、水漏、摄像头`，motion 条目 `未安装（CONFIG_NODE_MOTION_GPIO=-1）` | `APP/.../core/capability/DeviceCapabilities.ts:4-7,121-138`（尤其 `:126`、`:131-135`） |
| 2026-10-27 01:15 | 厨房板刷入 PIR 固件（SR312/GPIO38），首启即检测到活动 | `KITCHEN-PIR-FLASH-RECORD.md:22-57` |
| 2026-10-27 01:35 / 02:0x | 厨房再刷门磁+门磁 v7 固件，**PIR 保留** | `door-contact-closure/report.md:241-302`；`.local/door-v7-20261027/build-kitchen/config/sdkconfig.json` |
| 2026-10-27 14:41 | DAYU 正式 APP 显示“长时间无活动 / 厨房 · 14:41 / 待处理”，详情“长时间未检测到人体活动，疑似跌倒或昏迷” | `evidence/2026-10-26-demo-autostart/runtime/ui-last.json`（mtime 18:56 前今日 16:24；bundle `com.dsh.eldercare`；文本可检索） |
| 2026-10-27 18:45 | 当前安装的 APP（1.0.6 / 1000006，模拟器 `deviceId=PHONE-001`；实体手机版本本轮未核实）设备管理页仍显示厨房“无 PIR/门磁/水漏/摄像头” | `baseline/layout/devmgmt_top.json`；版本证据 `baseline/raw/bm_dump.txt:161-162,173,528` |

### 2.2 结论（必须区分“能力 / 告警数据 / 文案”）

1. **设备能力层（当前在板固件）**：厨房自 2026-10-27 01:15 起**具备 PIR 与 NO_MOTION 能力**，`NO_MOTION_SEC=1800`、`REQUIRE_ARM=y`、`BENCH_INJECT=false`。因此 14:41 的厨房 NO_MOTION **在能力上可以真实发生**，不构成“厨房无 PIR 却报无活动”的硬件矛盾。
2. **APP 文案层**：当前安装版 APP（1.0.6，模拟器）的能力表是 **2026-10-21 的静态快照，已过期**（实体手机安装版本本轮未核实；能力表在源码中与安装版一致）。它会在告警详情触发“能力核对”提示，把真实告警写成“可能来自测试/历史/错配数据，请核实后再处置”（`DeviceCapabilities.ts:294-308`；`ViewMapper.ts:712-713`；`AlertDetailPage.ets:887-922`）。这是**文案/证据过期**，需要改能力表，不是设备矛盾。
3. **告警数据层**：无论能力如何，`alerts` 是后端长期保留的台账（生产 v7 迁移后 `alerts=69→75`，见 `door-v7-e2e/REPORT.md:12,47` 与 `ai-health-assessment/acceptance/PRODUCTION-RELEASE.txt:19`）。一条厨房 NO_MOTION 究竟是：
   - 2026-10-27 01:15 之后的**真实触发**（例如 14:41 这条）→ 设备能力支持，可当真实活动数据；或
   - 更早的**历史/测试/注入/错配**记录 → 当时公共厨房固件 `MOTION_GPIO=-1`，`node_main.c` 的 PIR/无活动代码被条件编译剔除（`:152,627,1237,1413`），**不可能由厨房设备产生**，只能是历史/测试/手工注入/错误绑定。
   
   本轮只读只能确认“UI 上存在这条待处理告警”，**没有拿到该告警的 alarmId、createdAt、当时的 PIR lastActiveTs** → **触发来源与时间 NOT TESTED**。不能用这条告警去反推“厨房一直在采集 PIR”，也不能把它当作跌倒/昏迷证据。
4. **同现象还有另一来源**：DAYU homemon 自身也会生成 NO_MOTION，且**没有“先武装/必须先见到活动”的门槛**（`homemon.c:1103-1105`，`last_motion_ms` 初始化于 `:977`，无 PIR 时 30 分钟后即超时）。因此“生产出现 NO_MOTION”**不能反推该房间有 PIR**（客厅日志形态为旁证，类型未打印）。
5. **用词问题（会影响 APP/DAYU 文案）**：DAYU 详情写“疑似跌倒或昏迷”，而 `NO_MOTION` 只表示“长时间未检测到活动”（`esp32-node/main/node_main.c:1436`；交接文档 `:38` 明确禁止写成昏迷/跌倒/无人）。应在 UI 改为“长时间无活动/请确认家人情况”。

### 2.3 对 APP 的具体影响（供文案/UI 修复）

- 厨房卡片必须从“无 PIR/门磁”改为“PIR 已装（GPIO38，2026-10-27 起）、门磁已装（GPIO14，2026-10-27 起）”，并保留“水漏/摄像头未装”。
- 卫生间卡片门磁应从“未安装”改为“已装（GPIO14）”。
- 在能力表修复前，厨房 NO_MOTION 告警页不应显示“该告警可能来自测试/历史数据”的能力核对横幅（否则真实告警会被自相矛盾地降级）。
- “隔离测试节点”继续保持“未核实能力、不默认拥有任何传感器”。
- 无 PIR 的厨房旧数据/旧告警不得标成“真实活动”；无门磁的旧读数不得默认“关闭”。

## 3. 交付/重建风险（必须写进交接）

- 公共源码树 **不等于** 在板固件：PIR(38)、门磁(14)、门磁事件/seq、语音/定向播报等都只在 `.local` 私有副本与私有 build 中；公开 `profiles/{kitchen,bathroom}` 仍为 `MOTION=-1`（kitchen）/`DOOR=-1`（两者）。重建会丢能力（`profiles/kitchen.sdkconfig.defaults:5-6`；`profiles/bathroom.sdkconfig.defaults:12,16`）。
- 厨房 MQ-5 公开 profile 写 `ADC1_CH8`（GPIO9，与 I2S LRCK 冲突，`profiles/kitchen.sdkconfig.defaults:18`），真实构建靠 `kitchen-voice-rewire` 改 CH6（GPIO7）。用错 overlay 会编译失败或采错脚。
- 厨房 app 分区余量极小：v7 固件余 26,096 B（2%），PIR+门磁版余 26,416 B（`door-v7-e2e/REPORT.md` §4；`report.md:249`）——继续加功能前先算体积。

## 4. 本轮未做 / 阻塞

- 未开串口、未烧录、未按键、未触发告警、未访问生产后端；无法确认此刻两板是否在线/在板版本（`bridge/_test/current-runtime/supervisor/bridge.out.log` 末尾显示转发目标 9001 持续重连，链路当前不通）。
- 生产告警的 alarmId/时间/PIR 触发瞬间：需要登录生产 API 只读取证 → **BLOCKED（未授权访问生产）**。
- 水漏硬件：未采购/未接线 → NOT TESTED。
- MQ 标定与报警：未标定、阈值为禁用值 4096 → 未启用（NOT TESTED）。
