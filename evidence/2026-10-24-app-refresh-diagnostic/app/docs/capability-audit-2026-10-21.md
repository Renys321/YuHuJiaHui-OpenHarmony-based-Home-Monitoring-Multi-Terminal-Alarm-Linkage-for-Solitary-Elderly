# 能力审计：三节点真实能力与公网 API 可表达范围（2026-10-21）

- 审计员：`capability-auditor`（共享任务 `task-1`，只读审计）
- 审计对象：`esp32-kitchen`、`esp32-bath`、`dayu200-living` 及未知 `deviceId`
- 交付用途：复核 [`REAL-API-INTEGRATION-SPEC.md`](./REAL-API-INTEGRATION-SPEC.md) §2 能力表，给 Lead 逐项修正依据
- 路径基准：本机仓库根 `<WORKSPACE>`；本文所有 `文件:行` 均指当前工作区内容
- 证据强度标签：`SOURCE`＝源码可证；`TEST`＝仓库内自动化测试可证；`REAL`＝真机证据文档记录；
  `NOT TESTED`＝未执行；`待确认`＝现有证据不足，禁止猜测定性

## 0. 审计方法与边界

### 0.1 已只读检查（未修改）

| 层面 | 文件 |
|---|---|
| 内部规范 | `APP/ElderlyCareGuardian/docs/REAL-API-INTEGRATION-SPEC.md` |
| 公网合同 | `competition/docs/APP-API-v1.md`、`competition/docs/APP-API-v1.json`、`competition/docs/APP-TEAMMATE-HANDOFF-2026-10-16.md` |
| 云适配/网关/同步 | `competition/cloud/onenet/adapter.js`、`gateway.js`、`public-sync.js`、`cloud-sync.js`、`adapter-valid-field.test.js` |
| 公网后端 | `competition/cloud/backend/src/store.js`、`src/server.js`、`README.md` |
| ESP32 固件 | `competition/esp32-node/profiles/kitchen.sdkconfig.defaults`、`profiles/bathroom.sdkconfig.defaults`、`main/Kconfig.projbuild`、`main/node_main.c`、`main/alarm_logic.h` |
| DAYU 南向 | `competition/southbound/src/homemon.c`、`southbound/homemon.conf`、`southbound/README.md`、`competition/materials/demo_start.ps1` |
| 证据文档 | `competition/docs/evidence/2026-10-20-*.md`、`2026-10-14-monitor-offline-watchdog*.md`、`2026-10-15-vision-guard-audit.md`、`auto-guard-final-homemon.log`、`competition/docs/VALIDATION-MATRIX.md` |
| APP 侧现状 | `APP/ElderlyCareGuardian/entry/src/main/ets/core/capability/DeviceCapabilities.ts`（只读快照） |

### 0.2 硬性未做（NOT TESTED / 不可做）

- 未用任何真实凭据登录公网 `https://api.luxunacc.xyz`，因此**没有**取得带 Bearer 的 `/api/v1/devices` 真实响应；
  本文“公网 sensors 形状”全部由仓库源码+云端合同推导，不是线上实测。
- 未连接、未打开串口、未烧录、未安装 APP、未运行 hvigor；未修改任何生产源码/固件/Bridge/DAYU HAP。
- 未读取/打印任何密码、Token、`INGEST_KEY`、设备密钥。
- **公网正在运行的部署版本未核实**：本文以工作区源码为准；若线上部署早于本仓库提交，
  `valid` 剥离行为/字段白名单可能不同 → 待确认。

## 1. 结论摘要（给 Lead）

1. **`valid` 确实被剥离（SOURCE + TEST 双证）**：`adapter.js` 会校验 `gas/smoke/climate` 的 `valid` 类型，
   但**不透传**；`climate.ok` 同样被丢弃（`adapter.js` 未读取）。公网 `sensors` 中**没有** `valid`、**也没有** `climate.ok`。
   后端 `store.js` 只是把 `sensors` 当普通对象原样透传，不再过滤，所以“剥离发生在边缘适配器”这一层。
2. **公网 API 能表达的 `sensors` 只有**：
   `motion{lastActiveTs,countToday}`、`door{open,lastOpenTs}`、`climate{tempC,rh}`、`gas{ok,raw}`、`smoke{ok,raw}`。
   `water`、`fall`、`SOS`、`camera` 均**不在** `sensors` 中；`monitorOnline` 是设备级字段。
3. **字段存在 ≠ 传感器已安装**：ESP32 固件 `report()` **无条件**输出 motion/door/climate/gas/smoke 五组字段；
   禁用通道输出占位值（卫生间 `gas/smoke raw=0, ok=true`；厨房 `motion=0/0`、`door=false/0`）。
   卫生间本轮 `raw=0` 在公网看起来像“安全”，实际是**未安装**。
4. **三节点一句话**：
   - `esp32-kitchen`：AHT20 温湿度 + MQ-5/MQ-2 原始 ADC（采集启用、**GAS/SMOKE 报警禁用**，阈值 4096）+ 板载蜂鸣器；
     **无** PIR/门磁/水漏/摄像头；唯一可能产生的告警是 **CLIMATE**。
   - `esp32-bath`：AHT20 + PIR（数据）+ SOS 按键 + 板载蜂鸣器；可产生 **CLIMATE / NO_MOTION / MANUAL_SOS** 告警；
     **无**燃气/烟雾/门磁/摄像头，水漏本轮禁用（且当前公网链不支持）。
   - `dayu200-living`：相机 + 跌倒检测（**推理在 PC YOLO，不在板端**）+ 本地语音 + `monitorOnline`；
     **物理传感器（PIR/门磁/SHT30/MQ/求助按钮）无接线证据**，但状态 JSON 仍输出五组占位字段 → APP 必须按“待确认/未安装”。
5. **spec §2 需修正 5 处**（详见 §5）：卫生间 PIR“不产生告警”不对；厨房“报警禁用”范围不对；
   DAYU“跌倒检测（本地）”表述不对；DAYU“其余传感器待确认”需写成“未接线但字段占位”；
   未写 `climate.ok` 也被剥离、以及 `water` 即使启用当前公网链也不支持。
6. **P0 风险（未来启用前必读）**：卫生间把 `CONFIG_NODE_WATER_GPIO` 改成 37 后，`sensors.water` 会被网关丢弃，
   且 `WATER_LEAK` **不在** `adapter.ALARM_TYPES` 白名单，漏水告警会让**整条状态报文被拒**（`INVALID_STATUS`），
   不只是“水漏不上云”。在改网关/adapter 之前，不得声称水漏能力可用。

## 2. 公网 API 实际能表达的 `sensors`

### 2.1 端到端链路与逐层裁剪

```
设备/DAYU status JSON（含 valid/ok/water/alarm/...）
  → adapter.toPropertyPost()       校验 + 只挑白名单字段（丢弃 valid；climate 拆成 temperature/humidity）
  → gateway.normalizeIncoming()    只提取 motion/door/gas/smoke/climate（丢弃 water/fall 等进 sensors 的可能）
  → cloud-sync.buildIngestPayload() 把 sensors 原样 JSON clone 后 POST /internal/v1/device-status
  → backend store.normalizeStatus() sensors 当普通对象保存（不做字段级过滤）
  → store.toPublicDevice()         sensors 原样返回
  → GET /api/v1/devices            APP 看到的就是本节字段
```

引用：`competition/cloud/onenet/adapter.js:263-307`；`competition/cloud/onenet/gateway.js:783-819`；
`competition/cloud/onenet/cloud-sync.js:59-98`（`sensors` clone 在 :89）；
`competition/cloud/backend/src/store.js:36,45`（保存）与 `:184-199`（`sensors` 在 :196 透传）；
`competition/cloud/backend/src/server.js:511-512`；部署入口 `public-sync.js:14,120-126` 复用同一 `gateway`。

### 2.2 公网 `sensors` 字段表（权威结论）

| 路径 | 类型/范围 | 来源与处理 | 公网是否保留 | 语义要点 |
|---|---|---|---|---|
| `sensors.motion.lastActiveTs` | int，13 位 ms 或 `0` | `adapter.js:130-143`（`0` 允许） | ✅ | `0`＝无活动记录/未接线占位 |
| `sensors.motion.countToday` | int 0..1e9 | 同上 | ✅ | 仅计数，不产生告警 |
| `sensors.door.open` | bool | `adapter.js:145-158` | ✅ | 门磁未接线时恒 `false` |
| `sensors.door.lastOpenTs` | int ms 或 `0` | 同上 | ✅ | 未接线恒 `0` |
| `sensors.climate.tempC` | number −50..100 | `adapter.js:177-198`，由根级 `temperature` 承载，网关再拼回 `climate` | ✅ | **没有** `ok`，**没有** `valid` |
| `sensors.climate.rh` | number 0..100 | 同上（`humidity`） | ✅ | 同上 |
| `sensors.climate.ok` | bool（设备 JSON 有此字段） | `adapter.js:177-198` 未读取/未校验 → 丢弃 | ❌ | 公网不存在；APP 不得依赖 |
| `sensors.climate.valid` | bool（2026-10-20 新增） | `adapter.js:182-183` 校验类型后丢弃 | ❌ | 见 §2.3 |
| `sensors.gas.ok` | bool | `adapter.js:160-175` | ✅ | 非“安全”证明：阈值 4096 时恒 `true` |
| `sensors.gas.raw` | number 0..1e9 | 同上 | ✅ | ADC 原始值，**不是 ppm** |
| `sensors.gas.valid` | bool | `adapter.js:173` 校验后丢弃 | ❌ | 读取失败/禁用不可见 |
| `sensors.smoke.ok` | bool | 同上 | ✅ | 同上 |
| `sensors.smoke.raw` | number | 同上 | ✅ | 同上 |
| `sensors.smoke.valid` | bool | 同上 | ❌ | 同上 |
| `sensors.water.{wet,valid}` | bool | 固件有条件输出（`node_main.c:713-717`），但网关只挑 5 组字段（`gateway.js:795-803`） | ❌ | **即使启用也上不了公网** |
| `fall` / `gps` / `csq` | 根级对象/数字 | `gateway.js:815-817` 有归一化，但**不进** `sensors`；`cloud-sync.js:90-96` 只带 gps/csq（fall 不带） | — | FALL 只以告警形式出现 |
| `monitorOnline` | `-1/0/1` | `gateway.js:789-792`（缺省 `-1`）→ `cloud-sync.js:63-66,79` | ✅（设备级） | 三节点中只有 `dayu200-living` 会真正上报 0/1 |

### 2.3 `valid` 剥离与“读失败不可见”结论

- `adapter.js:166-168` 注释原文：“接受并校验类型，但**不透传**到上云载荷，保持后端合同不变”。
- 单元测试直证：`competition/cloud/onenet/adapter-valid-field.test.js:30-39`
  （“valid 不透传到上云载荷”；`p.params.gas.value` 无 `valid` 属性；另见 `:41-49` 类型错误仍拒绝）。
- 后端只做对象透传、不额外剔除：`competition/cloud/backend/src/store.js:36,45,196`。
- **推论（对 APP 很重要）**：
  - AHT20 单次读取失败 → 设备 JSON `climate.valid=false`、`climate.ok=true`、旧温度保留（`node_main.c:567-580`）；
    公网只剩 `climate{tempC,rh}`，**APP 无法区分“本次有效”与“陈旧值/读失败”**。
  - ADC 读失败 → `gas/smoke.valid=false`、`raw` 保留上次值（`node_main.c:582-614`）；公网同样不可见。
  - 禁用通道 → `gas/smoke{raw:0, ok:true}`（`node_main.c:69-76,727-728`）在公网**看起来像正常**。
  - 因此 spec §2“`valid` 缺失 → 有效性未知，不得当成有效”是正确且必须坚持的规则（spec:54）。

### 2.4 “字段存在 ≠ 传感器已安装”（逐节点占位值）

ESP32 `report()` 的 `snprintf` 无条件包含 motion/door/climate/gas/smoke（`node_main.c:722-742`），
与 `#if` 编译开关无关；被删掉的只是采样逻辑。于是：

| deviceId | 公网会看到的“占位”字段 | 实际含义 | 证据 |
|---|---|---|---|
| `esp32-kitchen` | `motion{0,0}`、`door{false,0}` | PIR/门磁**未安装**（GPIO=-1），固件仍输出字段 | `profiles/kitchen.sdkconfig.defaults:5-6`；`node_main.c:719-725`；`2026-10-20-kitchen-esp32-node-acceptance.md:53-54` |
| `esp32-bath` | `gas{raw:0,ok:true}`、`smoke{raw:0,ok:true}`、`door{false,0}` | MQ/门磁**未安装**；`valid=false` 被剥离后只剩“安全假象” | `profiles/bathroom.sdkconfig.defaults:16,24-25`；`node_main.c:69-76,727-728`；`2026-10-20-bathroom-esp32-stage1-source.md:112` |
| `dayu200-living` | `motion{lastActiveTs≈启动时刻,countToday:0}`、`door{false,0}`、`climate{0,0}`、`gas/smoke{raw≈悬空值,ok:true}` | 物理传感器**无接线证据**；`homemon` 状态格式固定输出五组字段 | `southbound/src/homemon.c:805-827,973-983`；`materials/demo_start.ps1:176-199`；`docs/VALIDATION-MATRIX.md:99`；`docs/evidence/auto-guard-final-homemon.log:4-7` |
| 未知 `deviceId` | 可能出现任意字段 | 一律“待确认”，不得默认拥有 | spec:48；`APP-API-v1.md:61` |

补充：DAYU 的 `climate` 无 `valid` 字段（`homemon.c:809`），所以 `{0,0}` 只能靠 spec §2 的“同时为 0 → 无效/待确认”
规则兜底（spec:51）；`homemon` 无 SHT30 时 `temp_c/rh` 保持 0、`climate_ok` 保持 1（`homemon.c:973-983,1058-1063`），
这正是“0/0 占位”的来源。

### 2.5 MQ `raw` 语义：不是 ppm，且厨房报警被禁用

| 节点 | 通道 | `raw` 性质 | 报警 | 证据 |
|---|---|---|---|---|
| `esp32-kitchen` | MQ-5→`gas`（ADC1_CH8/IO9）、MQ-2→`smoke`（ADC1_CH5/IO6） | 12-bit ADC 原始值（0–4095），AO 经「1k+1k 串接、再 1k 下拉」≈÷3 分压；**未标定、无 ppm 换算** | 阈值 `4096` ≥ ADC 满量程 → `mq_stab_update` 恒 `danger=0`（永不告警） | `kitchen.sdkconfig.defaults:12-15`；`node_main.c:582-614,727-728`；`alarm_logic.h:38`；`2026-10-20-kitchen-esp32-node-acceptance.md:37-39,62-70` |
| `esp32-bath` | 两通道均 `-1` | `raw=0` 常量占位 | 无（通道未编译） | `bathroom.sdkconfig.defaults:24-27`；`node_main.c:582-614`（`#if` 不成立） |
| `dayu200-living` | SARADC VIN4/VIN5（10-bit，0–1023） | 未接线时悬空 ≈1000–1023；默认脚本阈值 1024 以免误报 | 无（无传感器） | `homemon.c:1065-1073`；`demo_start.ps1:191-194`；`auto-guard-final-homemon.log:7` |

结论：APP **永远不能**把 `gas/smoke.raw` 显示为 ppm/浓度；厨房 `gas/smoke.ok=true` 也不能显示“安全/正常”
（它只代表“未超 4096 阈值”，即报警未启用）。现有 APP 能力模块的 `formatRawAdc()` 已按“原始 ADC”处理
（`DeviceCapabilities.ts:240-245`），方向正确。

### 2.6 告警、证据与 `sensors` 的关系（避免混淆）

- `MANUAL_SOS`、`FALL` **没有**对应 `sensors` 字段；只能从 `alerts[].type` 看到
  （卫生间 SOS：`node_main.c:754-767`；DAYU FALL：`homemon.c:562-594`）。
- `alerts[].message` 在公网是通用文案，只有 `NO_MOTION` 被特判（`store.js:163`）：
  `GAS/SMOKE/CLIMATE/FALL/MANUAL_SOS` 都显示“检测到异常”。**APP 必须用 `type` 区分，不能依赖 `message`**。
- `alerts[].evidence` 仅对 `FALL` 可能 `available=true`（后端强制 evidence 必须绑定 FALL：`store.js:30-34`）；
  其他告警恒 `available=false`（`server.js:496-505`）。
- `monitorOnline` 的 `monitorReason`（`no_frame/frames_resumed/...`，`homemon.c:408-418,814`）**不会**进入公网
  （`gateway.js:783-819` 只取 `monitorOnline`），APP 只能看到 0/1/-1。
- `history[7]`/`slots[4]`（homemon/ESP32 根级）不进入公网 API → APP 的“活动曲线/睡眠”类指标无数据源（与 spec §5 一致）。

## 3. 逐 deviceId 能力矩阵（本次审计交付物）

字段状态定义：
- **已安装/已启用**：有 profile/接线/真机证据，当前固件确实采集；
- **未安装/未启用**：profile 明确 `-1`（编译期关闭）或代码路径不存在；
- **待确认**：现有证据不足以确认硬件，或证据只覆盖历史会话。

### 3.1 `esp32-kitchen`（厨房）

| 能力项 | 状态 | 公网可见形式 | 告警 | 证据 |
|---|---|---|---|---|
| AHT20 温湿度 | 已安装/已启用（REAL） | `climate{tempC,rh}` | **CLIMATE 告警启用**（5–45 ℃ / 10–90 %RH 阈值） | `profiles/kitchen.sdkconfig.defaults:9-11,19-22`；`2026-10-20-kitchen-esp32-node-acceptance.md:52,64-65`；`node_main.c:563-580,649-651` |
| MQ-5 燃气原始 ADC（→`gas`） | 已安装/已启用采集（REAL 基线 260–277） | `gas{ok,raw}`，报警禁用 | **GAS 禁用**（阈值 4096，永不触发） | `kitchen.sdkconfig.defaults:13,15`；`acceptance:62-63,68`；`alarm_logic.h:38` |
| MQ-2 烟雾原始 ADC（→`smoke`） | 已安装/已启用采集（REAL 基线 83–100） | `smoke{ok,raw}`，报警禁用 | **SMOKE 禁用**（阈值 4096） | `kitchen.sdkconfig.defaults:12,14`；`acceptance:63,68` |
| 板载蜂鸣器（XL9555 P0_3） | 已安装/已启用（REAL 300 ms 短鸣 PASS） | 不出现（执行器） | 由本地告警触发；APP 不可直接控制 | `kitchen.sdkconfig.defaults:7`；`2026-10-20-kitchen-esp32-node-hardening.md:83-84` |
| PIR 人体活动 | **未安装/未启用** | `motion{0,0}` 占位仍出现 | NO_MOTION 禁用 | `kitchen.sdkconfig.defaults:5`；`node_main.c:80-82,536-544`；`acceptance:53` |
| 门磁 | **未安装/未启用** | `door{false,0}` 占位仍出现 | 无门磁告警逻辑 | `kitchen.sdkconfig.defaults:6`；`node_main.c:559-561,725` |
| 水漏 | **未安装/未启用** | 无 | 无 | 未在 profile/Kconfig 启用（`Kconfig.projbuild:61-65` 默认 -1）；且公网不支持（§2.2） |
| 摄像头 | **未安装** | 无 | 无 | `node_main.c:117-121`（板载排线与摄像头冲突；本项目视觉入口在 DAYU）；`2026-10-20-kitchen-esp32-node-acceptance.md:31-40` 无摄像头接线 |
| SOS 按键 | 未安装/未启用 | 无（SOS 本就没有 sensors 字段） | 无 | `Kconfig.projbuild:50-54` 默认 -1，profile 未设 |

### 3.2 `esp32-bath`（卫生间，本轮阶段1）

| 能力项 | 状态 | 公网可见形式 | 告警 | 证据 |
|---|---|---|---|---|
| AHT20 温湿度 | 已安装/已启用（REAL） | `climate{tempC,rh}` | **CLIMATE 告警启用**（5–45 ℃ / 10–90 %RH） | `profiles/bathroom.sdkconfig.defaults:21-23,30-33`；`2026-10-20-bathroom-esp32-stage1-source.md:109` |
| PIR 人体活动（IO36） | 已安装/已启用（REAL） | `motion{lastActiveTs,countToday}` 真实数据 | **NO_MOTION 告警启用**：`no_motion_sec=1800` 无活动 → ALARM | `bathroom.sdkconfig.defaults:8-9,35`；`node_main.c:652-653,679-707`；`stage1-source:110` |
| SOS 按键（IO15） | 已安装/已启用（真机仅验证“无误报”） | 无 sensors 字段 | **MANUAL_SOS 告警启用** | `bathroom.sdkconfig.defaults:10-11`；`stage1-source:112-113`；`node_main.c:754-767` |
| 板载蜂鸣器（XL9555 P0_3） | 已安装（与厨房同硬件），**告警鸣响未实测** | 不出现 | 本地响铃 | `bathroom.sdkconfig.defaults:17`；`stage1-source:26`；蜂鸣器声音 NOT TESTED |
| 燃气 MQ | **未安装/未启用** | `gas{raw:0,ok:true}` 占位仍出现 | GAS 无 | `bathroom.sdkconfig.defaults:24`；`node_main.c:69-76,727-728`；`stage1-source:112` |
| 烟雾 MQ | **未安装/未启用** | `smoke{raw:0,ok:true}` 占位仍出现 | SMOKE 无 | `bathroom.sdkconfig.defaults:25`；同上 |
| 门磁 | **未安装/未启用** | `door{false,0}` 占位仍出现 | 无 | `bathroom.sdkconfig.defaults:16`；`node_main.c:559-561,725` |
| 水漏 | **本轮未启用**（`-1`，计划改 37） | 无（`water` 段未输出） | WATER_LEAK 代码已就绪但公网链不支持 | `bathroom.sdkconfig.defaults:12`；`stage1-source:5-7,111`；风险见 §1 第 6 条 / §5.2 |
| 摄像头 | **未安装**（ESP32 节点无相机代码） | 无 | 无 | `node_main.c:117-121` |

### 3.3 `dayu200-living`（客厅主控）

先给**状态协议实际字段**（问题 1 的“dayu200-living status 到底有什么”）：

`homemon.report_status()` 每次上报固定输出（`southbound/src/homemon.c:805-827`）：

| 字段 | 内容 | 公网是否保留 |
|---|---|---|
| `deviceId`/`room`/`ts`/`state` | `dayu200-living`/`客厅`/13 位 ms/`NORMAL/WARN/ALARM/ACKED` | ✅ |
| `sensors.motion{lastActiveTs,countToday}` | 无 PIR 时 `lastActiveTs`≈启动时刻、`countToday=0`（占位） | ✅（占位） |
| `sensors.door{open,lastOpenTs}` | `false,0`（未接线占位） | ✅（占位） |
| `sensors.climate{tempC,rh,ok}` | 无 SHT30 时 `0,0,true`（占位）；**无 `valid`** | ✅（`ok` 被剥离 → `{tempC,rh}`） |
| `sensors.gas{raw,ok}` | SARADC 原始值（未接线≈悬空值；`ok=raw<阈值`） | ✅ |
| `sensors.smoke{raw,ok}` | 同上 | ✅ |
| `monitorOnline` + `monitorReason` | `-1/0/1` + 原因词 | 仅 `monitorOnline`；`monitorReason` 被丢弃 |
| `history[7]`/`slots[4]` | 活动统计 | ❌ |
| `alarm{id,type,countToday,evidenceId}` | FALL 等告警 | ✅（alarm→alerts；evidenceId 仅 FALL 可用） |

`monitorOnline` 语义（问题 1 第二问）：

| 值 | 含义 | 来源 | APP 应显示 |
|---|---|---|---|
| `1` | PC 侧相机帧管线在线（有帧） | PC watchdog → MQTT `monitor` 命令 → Bridge → homemon | “PC 监护在线”类文案；**不等于** APP 能看实时视频 |
| `0` | 监护链路失联（无帧/超时） | 同上（`monitor offline no_frame` 等） | “在线·监测异常” |
| `-1` | 从未上报（ESP32 节点恒为此值） | `gateway.js:789-792` 缺省 | “监测状态未知” |

证据：`homemon.c:597-634,814,982`；`2026-10-14-monitor-offline-watchdog.md:44-58`；
`2026-10-14-monitor-offline-watchdog-device-acceptance.md:43-50`；`APP-API-v1.md:61-62`；`gateway.js:789-792`。

能力矩阵：

| 能力项 | 状态 | 公网可见形式 | 告警/证据 | 证据 |
|---|---|---|---|---|
| 摄像头（本地） | 已安装/可用（REAL） | **无实时视频接口**；只有告警证据 JPEG | 取帧给 PC/YOLO + FALL 高分辨率抓拍 | `VALIDATION-MATRIX.md:34,36`；`2026-10-13-dayu-final-acceptance.md:40-55`；`2026-10-15-vision-guard-audit.md:9-21` |
| 跌倒检测 | 软件管线可用（相机取帧→USB→**PC CPU YOLO**，非板端 NPU） | `alerts[].type=FALL` + `evidence.available` | 真人跌倒全链路 **NOT TESTED** | `vision-guard-audit.md:9-21,129`；`VALIDATION-MATRIX.md:37,133`；`homemon.c:562-594` |
| 语音播报 | 已安装/已启用（预置语音 PLAYED REAL） | `communications` 接口（非 sensors）；APP 可创建留言 | 不是传感器能力；实体听感仅部分验收 | `VALIDATION-MATRIX.md:190`；`backend/README.md:78-83`；`southbound/README.md:126-137,254-276` |
| `monitorOnline` | 可用（REAL，联动实测） | 设备级 `monitorOnline` | 非告警 | 见上表 |
| PIR 人体活动 | **未安装/未接线（待确认）** | `motion` 占位字段仍出现 | 若接线且启用，才可能有 NO_MOTION | `VALIDATION-MATRIX.md:99`；`demo_start.ps1:176-180`；`2026-10-13-dayu-final-acceptance.md:68-77` |
| 门磁 | **未安装/未接线（待确认）** | `door{false,0}` 占位 | 无 | 同上；`homemon.conf:15-17` 仅为规划/台架配置 |
| SHT30 温湿度 | **未安装/未接线（待确认）** | `climate{0,0}` 占位 | 无（气候越界在 DAYU 只是 WARN，不产生告警） | `demo_start.ps1:185-198`（默认无 `i2c_dev`）；`homemon.c:1058-1063,1094-1095`；`auto-guard-final-homemon.log:4-7` |
| 燃气/烟雾（SARADC） | **未安装/未接线（待确认）** | `gas/smoke{raw,ok}` 占位（悬空值） | 无 | `demo_start.ps1:191-194`（阈值 1024 防悬空误报）；`VALIDATION-MATRIX.md:99` |
| SOS/随身按钮 | **未安装/未接线（待确认）** | 无 sensors 字段 | 若接线则为 MANUAL_SOS | `homemon.c:841`（默认 -1）；`demo_start.ps1:176-199` 未设 `button_gpio` |
| 水漏 | 无此能力 | 无 | 无 | `homemon.c` 无 water 实现 |
| 三色灯/蜂鸣器（声光） | 硬件在板，**实体效果 NOT TESTED** | 无 | 本地声光 | `VALIDATION-MATRIX.md:99` |

> **待确认说明**：DAYU 的 `homemon.conf`（仓库版）确实写了 `motion_gpio=117,114`、`door_gpio=29`、`button_gpio=106`、
> SHT30、`gas_adc_ch=4` 等（`southbound/homemon.conf:12-37`），但 2026-10-13 证据表明当时**未接线**且默认脚本
> 不读取实体 GPIO（`2026-10-13-dayu-final-acceptance.md:68-77`、`VALIDATION-MATRIX.md:99`）；
> 2026-10-20 只恢复了 homemon 进程与时间，**没有重新确认接线**（`2026-10-20-dayu-relink-app-two-nodes.md:21-26`）。
> 因此 2026-10-21 的结论是：**未确认安装，按“待确认”处理**；APP 不得因为公网有 `gas.raw` 就显示燃气已接入。

### 3.4 未知 `deviceId`

| 项 | 结论 | 证据 |
|---|---|---|
| 是否默认拥有传感器 | **否**。字段出现也只能逐项“待确认” | spec:48；`DeviceCapabilities.ts:164-182` |
| `sensors` 可能为空对象 | 是（网关对无传感器设备产出 `{}`，`gateway.js:795-803` + `cloud-sync.js:89`） | 同上 |
| `monitorOnline` | 大概率 `-1`（缺省） | `gateway.js:789-792` |

## 4. 为什么这些节点缺这些能力

### 4.1 厨房为什么无 PIR/门磁/水漏/摄像头

- **PIR/门磁**：`kitchen.sdkconfig.defaults:5-6` 明确 `MOTION_GPIO=-1`、`DOOR_GPIO=-1`；
  固件用 `#if CONFIG_NODE_*_GPIO >= 0` 编译期关闭采样（`node_main.c:80-82,354-375,536-544`）。
  厨房阶段只接了 AHT20 与两路 MQ（`acceptance:31-40`）。
- **水漏**：水漏是 2026-10-20 为卫生间新增的编译期能力（`Kconfig.projbuild:61-79`、`node_main.c:86-90,545-558`），
  厨房 profile 未开启（默认 -1）；且公网链当前不支持（§2.2）。
- **摄像头**：ESP32 节点根本没有相机驱动代码；`node_main.c:117-121` 还特别说明 GPIO4/5/6 与板载摄像头排线存在电气冲突，
  本项目视觉入口固定在 DAYU200 MIPI-CSI，**ESP32 节点不插摄像头模组**（`node_main.c:117-121`）。
- **附带**：厨房唯一可用告警是 CLIMATE；GAS/SMOKE 报警阈值被设为 4096（大于 12-bit ADC 满量程 4095），
  是“校准前只采集”的刻意禁用（`alarm_logic.h:38`、`acceptance:68-70`）。

### 4.2 卫生间为什么无燃气/烟雾/门磁/水漏（本轮）

- profile 注释与证据均写明阶段1 范围＝**PIR + SOS + AHT20 + 板载蜂鸣器**，不接 MQ/门磁：
  `bathroom.sdkconfig.defaults:5-6,24-27`；`2026-10-20-bathroom-esp32-stage1-source.md:5-7,51-53`。
- 因此 MQ2/MQ5 通道 `-1` → 采样代码不编译，但 `report()` 仍输出 `gas/smoke raw=0,ok=true,valid=false`
  （`node_main.c:582-614` 被 `#if` 跳过；`:727-728` 无条件输出；`:71-76` 注释说明了为何标志必须无条件声明）。
  **这正是“字段存在≠已安装”的最强反例**：公网看到 `raw=0, ok=true`，实际是未安装。
- **水漏**：用户 2026-10-20 23:15 决定本轮不做、次日改 IO37 启用（`stage1-source:5-7,51-53`）。
  另有联网兼容缺口：`sensors.water` 会被网关丢弃，且 `WATER_LEAK` 不在 adapter 白名单 → 见 §5.2 风险项。
- **门磁**：同 profile `-1`（`bathroom.sdkconfig.defaults:16`）。

### 4.3 DAYU200 的摄像头/跌倒/语音能力边界

1. **摄像头是本地相机，但不是“APP 可看的视频流”**。APP/云端 API 只有：
   - `GET /api/v1/alerts/{alarmId}/evidence`（元数据）与 `.../evidence/content`（JPEG，Bearer + `private, no-store`）；
   - **没有** RTSP/WebRTC/帧接口（`APP-API-v1.md:64-80`、`APP-API-v1.json:13-25`；全文无 video/stream 端点）。
   - 送 PC 的是 250 ms **受限采样帧**，不是持续视频；公网只上传**告警证据图**（`vision-guard-audit.md:9-21,129`）。
2. **跌倒检测不是板端推理**：DAYU 相机取帧 → USB → PC `yolo_pose_service.py`（CPU YOLO11n-pose）→ 时序判定 →
   FALL episode → MQTT `home/dayu200-living/cmd {"cmd":"fall"}` → Bridge → homemon 生成 FALL alarmId + evidenceId
   （`vision-guard-audit.md:9-21`；`homemon.c:562-594`）。VALIDATION-MATRIX 明确“不是 DAYU NPU”（`VALIDATION-MATRIX.md:37`）。
   - 证据可用性：FALL 告警的 evidence 只有“触发帧 JPEG 上传成功且绑定 alarmId”才 `available=true`；
     **真人跌倒 → 证据 → 公网 → APP 全链路 NOT TESTED**（`vision-guard-audit.md:112-113,129`）。
   - APP 侧能确认的只有：`alerts[].type==='FALL'`、`state`、`evidence.available/bytes/capturedAt`；不能显示“实时画面”。
3. **语音能力**：本机 AVPlayer 播放预置语音（`SosVoiceAbility`），远程留言状态机 `QUEUED→DELIVERED→PLAYED→ACKED`
   已真机验证到 `PLAYED`（`VALIDATION-MATRIX.md:190`；`backend/README.md:78-83`）。
   但：**无实时通话/录音**；实体听感仅耳机单条确认（`southbound/README.md:126-137`）；
   `PLAYED` ≠ 老人 `ACKED`（`backend/README.md:82-83`）。语音不是 sensors 能力，APP 不应把它当传感器瓦片。
4. **物理传感器/按钮/声光**：无接线证据（§3.3），`monitorOnline` 只反映 PC 监护帧链路，不能代替
   “房间有人/安全”的判断（`2026-10-14-monitor-offline-watchdog.md:143-145` 也说明 PC 从未上线时停在 -1）。

## 5. 与 spec §2 的差异与给 Lead 的修正建议

### 5.1 spec §2 能力表逐项差异

| # | spec §2 原文（行） | 审计事实 | 建议修改 | 证据 |
|---|---|---|---|---|
| D1 | 卫生间“PIR 只输出 `lastActiveTs/countToday`，不产生告警”（:46） | PIR 本身不直接报警，**但 PIR 启用使 NO_MOTION 在 `no_motion_sec=1800` 无活动后进入 ALARM** | 改为：“PIR 只上报活动数据、不因‘有活动’报警；但无活动 30 分钟会触发 `NO_MOTION` 告警（MANUAL_SOS/CLIMATE 优先级更高）” | `node_main.c:635-656,679-707`；`bathroom.sdkconfig.defaults:35` |
| D2 | 厨房“MQ 阈值 4096（永不告警），报警禁用”（:45） | 仅 **GAS/SMOKE** 禁用；**CLIMATE 告警仍启用**（5–45 ℃/10–90 %RH） | 改为：“GAS/SMOKE 报警禁用（阈值 4096）；CLIMATE 告警启用，是厨房唯一可能告警” | `kitchen.sdkconfig.defaults:15,19-22`；`node_main.c:649-651`；`alarm_logic.h:38` |
| D3 | DAYU“摄像头（本地）；跌倒检测/语音（本地）”（:47） | 相机在 DAYU，**跌倒推理在 PC（YOLO CPU）**，不是板端；语音播放在本机 | 改为：“相机（DAYU 本地取帧）→ USB → PC YOLO 跌倒判定（非板端 NPU）；语音本机播放；无实时视频/通话 API” | `vision-guard-audit.md:9-21`；`VALIDATION-MATRIX.md:37` |
| D4 | DAYU“其余传感器能力待确认”（:47），未写字段占位 | `homemon` 固定输出 motion/door/climate/gas/smoke（含占位值），公网会出现这些字段 | 增加：“DAYU 物理传感器未接线（证据截至 2026-10-14，2026-10-21 待复核）；公网仍会出现 motion/door/climate{0,0}/gas/smoke 占位字段，APP 必须按‘待确认’展示，且 `monitorOnline` 只反映 PC 帧链路” | `homemon.c:805-827,973-983`；`VALIDATION-MATRIX.md:99`；`demo_start.ps1:176-199` |
| D5 | spec 只写 `valid` 被剥离（:14,:54），未写 `climate.ok`/`water` | `climate.ok` 也被 adapter 丢弃；`sensors.water` 被网关丢弃且 `WATER_LEAK` 不在白名单 | 增加两条硬规则：“公网无 `climate.ok`，不得依赖”；“水漏当前公网链不支持，启用前先改网关/adapter” | `adapter.js:177-198`；`gateway.js:795-803`；`adapter.js:6-8`；`bathroom.sdkconfig.defaults:12` |

### 5.2 补充建议（spec §2 未覆盖但影响页面实现）

1. **告警类型映射**（`type` 是唯一可靠语义）：`NO_MOTION/MANUAL_SOS/CLIMATE/GAS/SMOKE/FALL`
   （`adapter.js:6-8`）；`message` 是通用文案（`store.js:163`），不能用于区分告警种类。
2. **每设备“可产生告警”清单**（spec 未列）：
   - 厨房：`CLIMATE`（GAS/SMOKE 禁用、NO_MOTION 禁用）。
   - 卫生间：`CLIMATE`、`NO_MOTION`、`MANUAL_SOS`。
   - DAYU：`FALL`（真实可用性 NOT TESTED）；若将来接线：`GAS/SMOKE/NO_MOTION/MANUAL_SOS`（当前未接线）。
3. **水漏未来启用前必须同时改云端**（否则相关状态会被丢弃/拒收）：`WATER_LEAK` 加入 `adapter.ALARM_TYPES`
   （否则漏水告警会让整条状态 `INVALID_STATUS`）；`adapter.normalizeStatus/toPropertyPost` 增加 `water` 归一化与输出；
   `gateway.normalizeIncoming` 增加 `sensors.water` 拷贝（当前三处都没有）。
4. **APP 显示规则补充**：
   - `gas/smoke.ok=true` 不得显示“安全”；只能说“原始 ADC / 报警未启用”（bath 更是未安装）。
   - `climate{0,0}` → “无效/待确认”（DAYU、以及 AHT20 首读失败时）。
   - 厨房 `motion{0,0}`、厨房/卫生间 `door{false,0}`、卫生间 `gas/smoke{0,true}` 一律按“未安装/未启用”展示，
     不要按数值显示“无人/门已关/安全”。
   - `monitorOnline=-1`（两个 ESP32 节点）→ “监测状态未知”，不得显示“监测离线”（0 才是离线）。
5. **能力表与告警能力解耦**：`SensorKind` 里没有 buzzer；蜂鸣器是本地执行器，APP 不能远程直接控制，
   也不应从公网字段推断其状态；只能通过“ACK 后设备回执 ACKED”间接闭环。

### 5.3 对当前 APP `DeviceCapabilities.ts` 快照的修正建议

> 读取快照时间：2026-10-21 19:5x（本审计期间只读）。若该文件随后被 Lead 更新，以最新为准。

| 位置 | 当前内容 | 建议 |
|---|---|---|
| `DeviceCapabilities.ts:113`（厨房 climate） | `alarmEnabled=false` | 改为 `true`：CLIMATE 告警确实启用（`node_main.c:649-651`） |
| `DeviceCapabilities.ts:132`（卫生间 climate） | `alarmEnabled=false` | 改为 `true`（同上，`bathroom.sdkconfig.defaults:30-33`） |
| `DeviceCapabilities.ts:133`（卫生间 motion） | “PIR 只上报活动时间/次数，不直接产生告警”，`alarmEnabled=false` | 补“无活动 30 分钟触发 NO_MOTION 告警”，`alarmEnabled` 建议 `true`（或新增 `noMotionAlarm` 字段区分） |
| `DeviceCapabilities.ts:149,152`（DAYU fall） | “跌倒检测/语音（本地）” | 改为“相机取帧本地 + PC YOLO 推理（非板端）”；FALL 保留 `alarmEnabled=true`，note 加“真人跌倒全链路 NOT TESTED” |
| `DeviceCapabilities.ts:151`（DAYU camera） | “仅本地录像/证据” | 改为“无连续录像、无实时视频 API；仅本地采样帧送 PC 推理 + FALL 证据 JPEG” |
| `DeviceCapabilities.ts:153-159`（DAYU 物理传感器） | 全部 `installed=false`，note 仅“待确认” | 方向正确；建议 note 补“公网仍会出现占位字段（climate 0/0、gas/smoke 悬空 raw、door false），UI 以 installed=false 为准” |
| 全表 | 无 `water` 公网兼容警告 | 在 bath `water` 项 note 增加“即使改 GPIO=37 启用，当前公网链也会丢弃 water 并可能整条拒收（§5.2.3）” |

## 6. NOT TESTED 清单（本轮审计不冒充完成）

| # | 项目 | 原因 | 归属/下一步 |
|---|---|---|---|
| N1 | **真实公网登录** `/api/v1/auth/app`（合法 guardianId/password） | 无合法凭据，且禁止读取/打印凭据 | 由项目负责人提供会话后由 Lead/APP 真机验收 |
| N2 | 公网 **带 Bearer** 的 `/api/v1/devices` 实际响应（三节点 sensors 现值） | 同上 | 登录后抓一次只读响应，逐字段对照 §2.2 |
| N3 | 公网部署实际运行的代码版本是否含 `valid` 剥离逻辑 | 未查询服务器制品/版本 | 待确认（部署侧责任） |
| N4 | **真机 APP UI**（ElderlyCareGuardian HAP 构建、安装、页面能力展示） | 本轮禁止构建/安装；Lead 负责 | Lead 构建 + 真机截图验收 |
| N5 | **实体告警 ACK 回执闭环**（手机 APP → 公网 → DAYU/ESP32 → `ACKED`） | 需手机+公网+设备联合 | `VALIDATION-MATRIX.md:207` 已标 NOT TESTED |
| N6 | 真实 **GAS/SMOKE** 触发（厨房阈值 4096、卫生间禁用） | 安全规则禁止真实气体 | 不宣称灵敏度/报警功能 |
| N7 | 卫生间 **SOS 真实按下** → MANUAL_SOS → ACK | 仅验证了误报修复（重烧 35 s 内 0 次），未做真实按键 | `2026-10-20-bathroom-esp32-stage1-source.md:112-113` |
| N8 | 卫生间 **蜂鸣器告警鸣响** | 与厨房同硬件但未单独验收 | 待实测 |
| N9 | **水漏**任何端到端（传感器/固件/公网/APP） | 本轮未启用；公网链不支持 | 等云端兼容改造后再启用 |
| N10 | DAYU **物理传感器接线**（PIR 117/114、门磁 29、SHT30、MQ、求助按钮 106） | 最新证据（2026-10-13/14）显示未接线，2026-10-21 未复核 | 待确认；`-UsePhysicalSensors` 接线后再验收 |
| N11 | DAYU **真人跌倒 → 证据 → 公网 → APP** | 无真人跌倒事件，禁止伪造 | `vision-guard-audit.md:129` |
| N12 | DAYU `monitorOnline=0/1` 当前值在公网 APP 的展示 | 未登录公网，未实测 | 登录后随 N2 一起验 |
| N13 | 厨房 MQ 引脚/ADC 在 2026-10-21 的当前运行状态 | 只读源码+2026-10-20 证据；未连设备 | 待确认（是否仍在运行 2026-10-20 生产固件 DEDD2611…） |
| N14 | 2026-10-21 三节点在线/告警实时状态 | 本轮不连接设备/Broker | 待确认（APP 页面上线后看真实数据） |
| N15 | APP 对 `valid` 缺失、`monitorOnline=-1`、未知设备的真实页面表现 | 依赖 N4 | Lead 真机验收 |

## 7. 证据矛盾/疑点（明确待确认，不猜）

| # | 疑点 | 说明 | 处理建议 |
|---|---|---|---|
| Q1 | `2026-10-20-dayu-relink-app-two-nodes.md:56-57` 引用的状态行只有 `deviceId/room/ts/state` 四个字段，而 `homemon.c:805-827` 必然输出 `sensors/monitorOnline/alarm` | 证据文档疑似**截断引用**，不能据此认为 DAYU 无 sensors 字段 | 待确认：下次采集 `/data/homemon/status.json` 原样行 |
| Q2 | 2026-10-20 relink 记录以 `/data/homemon/homemon.conf` 启动，但仓库版 `homemon.conf:30-37` 配了 MQ 阈值 800；若板端真是该配置，悬空 ADC（≈1023）应触发 GAS，与“state=NORMAL”矛盾 | 板端实际配置文件内容未核实（可能仍是 `demo.conf` 的 1024 阈值/无实体 GPIO） | 待确认：只读 `cat /data/homemon/homemon.conf`（不读出密码，本文件不含密钥）后更新能力表 |
| Q3 | `2026-10-20-kitchen-esp32-node-audit.md` 结论 BLOCKED/引脚冲突，与同日 acceptance/hardening 的 PASS 并存 | 前者是**重映射前**的审计，被后续 acceptance/hardening 取代 | 引用最新（acceptance/hardening）；不要再用 audit 里的 GPIO6/CH0/CH1 方案 |
| Q4 | `hardening`/`stage1-source` 文档内的 `node_main.c:NNN` 行号与当前文件不一致（如 ACK 处文档写 452，当前为 480-491） | 文档写作时文件更早行号；当前源码已增长 | 本文一律引用**当前文件行号**，不改历史文档 |
| Q5 | spec §1 说“`state` 只观察到 `ALARM/ACKED`” | 这是 `alerts.state`；设备 `state` 还可能是 `WARN`（DAYU 温湿度越界/活动间隔达 50% 时，`homemon.c:1094-1098`；后端 `SYNC_STATES` 含 WARN） | 建议 spec 明确“alerts.state vs devices.state”区别，APP 不要用 alerts 规则套 devices.state |
| Q6 | 厨房 2026-10-20 两轮证据对 `gas/smoke` 的描述不同（阶段1 raw=0 vs 阶段2 真实 raw） | 阶段1 尚未接线、阶段2 已接 MQ，时间顺序一致 | 引用以 §6 阶段2 为准；不是矛盾 |

## 8. 一句话交付

> 三节点的真实能力 = 厨房“温湿度 + MQ 原始值（报警禁用）+ 蜂鸣器”、卫生间“温湿度 + PIR + SOS + 蜂鸣器”、
> DAYU“相机 + PC 端跌倒判定 + 语音 + monitorOnline”；公网 `sensors` 只有 motion/door/climate{tempC,rh}/gas/smoke 五组，
> `valid` 与 `climate.ok` 均被剥离，`water` 不可表达；所有“未安装”的通道仍会以 `raw=0/ok=true/false` 占位出现，
> APP 必须以能力表（而非字段是否存在）决定显示“已安装/未启用/待确认”，并且不得把 MQ 原始值当 ppm。
