# 真实门磁接入 —— 交付与验收报告

- 日期：2026-10-26
- 任务：完成真实门磁接入闭环（开关采集 → 记录上报 → APP 展示 → 真实使用验收）
- 工作区：<WORKSPACE>
- 交付目录：competition/evidence/2026-10-26-door-contact-closure/
- 总体状态：**卫生间门磁已烧录并通过真实验收（关门/开门/再关门/保持状态/连续开关）；后端公网部署和 APP 真机安装待用户授权发布范围**

---

## 1. 结论速览

| 环节 | 状态 | 说明 |
|---|---|---|
| 门磁事件后端链路（台账/持久化/API） | ✅ 已本地实现并验证 | schema v7，313/313 测试通过 |
| APP 门磁展示（状态/记录/未知/离线语义） | ✅ 已本地实现并验证 | 300/300 Node 测试通过 |
| 固件门磁采集（去抖/基线/事件缓存/NVS） | ✅ 已本地实现 | host 状态机单测 7/7 通过；**构建结果见第 4 节** |
| 硬件确认 | ✅ 已确认 | 两线无源干簧管干接点；万用表实测=常开型 NO；正点原子 DNESP32S3 |
| 接入 GPIO 选脚 | ✅ 已确认 | 卫生间节点 P1 排针 GPIO14（唯一空闲安全脚） |
| 固件烧录/部署 | ✅ 已烧录 | COM4，MAC 14:c1:9f:42:dd:b4，deviceId esp32-bath，hash verified |
| 真实验收（关门/开门/保持/连续开关） | ✅ 已通过 | seq 1关→2开→3关→4开→5关；保持不重复；无抖动 |
| 后端公网部署 | ⛔ 未部署 | 本地测试通过，生产服务器 https://api.luxunacc.xyz 待发布授权 |
| APP 真机安装 | ⛔ 未安装 | 需现有签名身份，待确认包内容不含未授权候选功能 |

---

## 2. 已核对的现有实现与硬件

### 2.1 现有链路（已核实，全部复用，未从零重建）
- 链路：esp32-node 固件 → 本地 bridge（`mqtt_bridge.js`，TCP 9101）→ onenet（Broker 1883）→ `public-sync-worker.js` 公网同步 → `cloud/backend`（https://api.luxunacc.xyz，持久化 schema v7）→ HarmonyOS APP（`APP/ElderlyCareGuardian` ArkTS）。
- bridge/onenet 对 `sensors.door` 全量透传；"当前状态"链路天然可用，本次补齐的是**事件台账 + APP 展示**两段缺失能力（最小增量，未重设计事件平台）。
- 既有监护功能（SOS、PIR、温湿度、MQ、语音、求助按钮）未改动；后端/APP 中 D/E、CAMERA-A 等未上线候选文件未触碰、未连带部署。

### 2.2 门磁硬件（用户提供的电商客服截图确认）
- 商品：弱电门磁（购于"丰豪电气城"，订单号 3316514738035029784，2026-10-15）。
- 客服确认：**无源干簧管两线干接点、无需电源、只能作信号量接单片机/报警主机、不能接负载**。
- **未确认项（需实物核实，不凭名称推测）**：
  - 常开型/常闭型（决定 `NODE_DOOR_OPEN_LEVEL` 取值，需万用表或开合实测）；
  - 两线极性（干簧管无极性，但接线端子位置需实物核对）；
  - 安装在哪扇门、归属哪个房间（任务/交接文档未定，需用户指定）。

### 2.3 断线检测披露
普通两线干接点在开位（磁铁远离）与线路断开时电平相同，**当前电路无法区分"真实开门"与"线路断开"**，本实现不宣称具有线路故障识别能力；离线/数据过期由网关与后端的心跳超时体现（APP 显示"离线/未知"）。

---

## 3. 变更清单（最小增量）

### 3.1 后端 `competition/cloud/backend`（已完成并验证）
| 文件 | 变更 |
|---|---|
| `src/store.js` | MemoryStore 新增 `doorEvents` 台账（容量 2000，ID `dr-<n>` 单调）；`_recordDoorEvents` 对比"上次已确认状态"；载荷无 `sensors.door` 不生成/不清理；补传按 `(deviceId, seq)` 幂等去重；无补传时仅"当前≠上次且台账末条不一致"生成兜底状态事件；首次摄入只建基线不生成历史事件；`listDoorEvents` 按 eventId 数值降序 |
| `src/persistent-store.js` | schema **v6→v7**：`doorEvents` 入持久化白名单（ID 唯一严格递增、必须指向已加载设备、`timeSource=device` 时 occurredAt>0）；v1..v6 快照缺键视为空台账 |
| `src/server.js` | 新增 `GET /api/v1/door-events`（Bearer 鉴权区内）：deviceId 可选（非法 400）、limit 1-100 非法回退 20，返回 `{events:[…]}`，空数组不伪造 |
| `test/door-events.test.js`（新增） | 19 用例 |
| `test/door-events-api.test.js`（新增） | 7 用例 |
| `test/safety-log-isolated.integration.js` | schema 断言 6→7 同步 |

时间语义：设备 ts>0 → `timeSource=device`；否则 → `timeSource=server`（**接收时间，不把接收时间冒充设备时间**；离线补传不含 seq 的旧载荷不纳入台账）。

### 3.2 APP `APP/ElderlyCareGuardian`（已完成并验证）
| 文件 | 变更 |
|---|---|
| `core/api/Contracts.ts` | `DoorSensorDto` 加 `openPresent`（open 缺失不得默认关闭）、`lastCloseTs`、`seq`；新增 `DoorEventDto` 与 `parseDoorEvents` |
| `core/view/Models.ts` | AppKeys 加 `gv.doorEvents`/`gv.doorEventsStatus`/`gv.doorEventsMessage`；新增 `DoorEventView` |
| `core/api/ApiClient.ts` | 新增 `doorEvents(token, deviceId='', limit=20)` |
| `core/view/ViewMapper.ts` | `buildDoorView`：`!openPresent` → 状态"未知"、说明"未收到门磁开关状态"，不默认"关闭"；新增 `mapDoorEvents`（occurredAt<=0 → "时间未知"；"设备时间"/"服务器时间"；"打开"/"关闭"/"状态未知"） |
| `core/service/Outcomes.ts` | 新增 `DoorEventsOutcome` |
| `service/GuardianService.ets` | 新增 `loadDoorEvents(deviceId, limit=10)`（demo/unauthorized/stale 检查、失败不回落演示数据、成功写入三个 gv 键） |
| `pages/DevicePage.ets` | 门磁事件区块（"暂无开关记录"/最近 5 条/错误消息）；设备卡在 sensorChips 后显示；`doRefresh` 后自动加载；离线保留上次读数但标明状态 |
| `tests/contracts.test.mjs`、`tests/view-mapper.test.mjs`、`tests/api-client.test.mjs` | 新增 9 个门磁用例（300/300 通过） |

**保护项（未动）**：已有传感器自动刷新、离线保留上次读数、恢复刷新、会话切换、ACK；`ActivityReportPage.ets`、`DevicePage.ets` 12:22 并行会话成果未触碰。

### 3.3 固件 `.local` 私有副本 `competition/esp32-node/.local/door-contact-20261026/src`（已集成，隔离公共树）
公共树 `competition/esp32-node/{main,profiles,test,…}` 只读未动；并行会话（音频验证、COM8 无线求助按钮）不受影响。

| 文件 | 变更 |
|---|---|
| `main/Kconfig.projbuild` | 门磁段：`NODE_DOOR_OPEN_LEVEL`（默认 0，须实物实测）、`NODE_DOOR_CONFIRM_COUNT`（默认 2）、`NODE_DOOR_CACHE_MAX`（默认 8）、`NODE_DOOR_CACHE_KEEP_SEC`（默认 300） |
| `main/alarm_logic.h` | `door_debounce_t` + `door_reset` + `door_update`：连续 confirm 次电平一致才翻转；上电首次稳定读数只建基线（`baseline_set`）不产生历史事件；返回 1=已翻转 |
| `main/node_main.c` | 门磁全局（`s_door_open`/`s_door_last_open_ts`/`s_door_last_close_ts`/事件 FIFO/`s_door_seq`/`s_door_baseline_unknown`）；NVS 持久化（`door_seq` u32 + `door_cache` blob magic，仅翻转/清理时写，不在心跳写）；`gpio_start()` 门磁段改**内部上拉**（干簧管一端 GPIO 一端 GND）+ 基线初始化；`sample()` 门磁段重写（bench 注入支持 + 去抖翻转 → seq/事件入缓存 + lastOpen/lastClose + NVS 保存 + 基线建立）；`door_event_expire()` 每次采样清理过期未送达事件；`report()` json 缓冲 900→1600、door 段独立构造（基线未知 `open:null`，绝不默认关闭；events 按 FIFO ≤CACHE_MAX；未启用门磁保持旧合同 `"door":{"open":false,"lastOpenTs":0}` 兼容 HAP）；bench 命令新增 `inj door 0/1` |
| `profiles/bathroom.sdkconfig.defaults` | 门磁启用（GPIO8 为**编译验证候选脚**，见第 5 节，须现场核对） |
| `test/host_door_logic_test.c`（新增） | 门磁状态机 host 单测：上电基线/稳定翻转/去抖/保持不重复/极性可配/confirm=1 边界，**7 组断言全部通过**（`gcc -std=c11 -Wall -Wextra -Werror` 零警告） |

**固件行为要点（对应任务判据）**：
- 稳定状态变化才生成新事件（连续 confirm 次一致电平）；保持开关状态不重复刷记录。
- 上电首次读数建立基线，**不生成"刚开门/刚关门"历史事件**；基线前上报 `open:null`（状态未知）。
- 事件带单调 `seq`（NVS 持久化，重启不复用），后端按 `(deviceId, seq)` 幂等去重——重连/重复上传/重启重传不重复记账。
- 未送达事件 FIFO 缓存（≤8 条 / 300s 过期），随心跳补传；记录数量有上限，避免无限增长。
- 时钟未同步时事件 `ts=0` → 后端标 `timeSource=server`（接收时间），不伪造设备时间。
- 本次只做门状态与开关记录；**未**增加"老人离家/异常闯入/长时间开门声光告警"等推断或新告警策略。

---

## 4. 构建与验证证据

### 4.1 host 状态机单测（本机，无需硬件）
```
gcc -std=c11 -Wall -Wextra -Werror -I...\src\main ...\test\host_door_logic_test.c -o host_door.exe
host_door_logic: ALL PASS        （7 组断言：基线/翻转/去抖/保持/极性/边界）
```

### 4.2 固件构建（ESP-IDF v5.1.6，隔离 build 目录）
```
python ...\idf.py -B build-door-bathroom -DSDKCONFIG_DEFAULTS=profiles/bathroom.sdkconfig.defaults build
→ BUILD_EXIT=0  （-Wall -Werror 零警告）
esp32_elder_node.bin 0xbf2c0 B（app 分区 0x100000，余 25%）
配置：DOOR_GPIO=14, OPEN_LEVEL=1（常开型 NO 实测）, CONFIRM=2, CACHE=8/300s, MAIN_TASK_STACK=6144
SHA-256: 16B63A310E10D41A860C6892AFD516F125E6EE90290EAD5B57C39B4E3A0B17C1
构建日志：build-door-bathroom-build.log（已复制到本目录）
```
> 构建 profile 为副本 bathroom（门磁 GPIO8 + 常开型 NO 实测开启电平）。

### 4.3 后端测试（backend 目录）
```
node --test            → 313/313 通过（含 door-events 19 用例、door-events-api 7 用例）
node --test test/door-events.test.js test/door-events-api.test.js   → 本轮复跑 26/26 通过
```

### 4.4 APP 逻辑测试（APP/ElderlyCareGuardian/tests）
```
tsc -p tests/tsconfig.json  （编译 core/**/*.ts 到 tests/build）
node --test             → 300/300 通过（新增 9 个门磁用例；本轮复跑 TSC_EXIT=0、300/300）
```
> `.ets` 平台适配层（GuardianService/DevicePage）不在 Node 编译范围；HAP 构建由 hvigor 负责，本交付不执行构建。

### 4.5 产物 SHA-256
见 `sha256-changes.txt`（18 个改动文件）。固件 .bin 哈希在构建完成后补入。

---

## 5. 硬件接线与 GPIO 选脚（现场待核对）

### 5.0 用户已确认（2026-10-26 二次确认）
- **安装位置**：卫生间门 + 厨房门，两扇门都要装门磁。
- **现有硬件**：1 个两线无源干簧管门磁（丰豪电气城，订单号 3316514738035029784）；**需再备 1 个**用于厨房门。
- **接入节点**：卫生间节点 GPIO8（候选，编译验证通过）。
- **烧录策略**：先准备齐，用户现场接线后再烧录。
- **常开/常闭**：未实测，按下方测量步骤执行后确定 `NODE_DOOR_OPEN_LEVEL`。

### 5.1 万用表测量结果（2026-10-26 实测）
- **实测结果**：磁铁靠近时导通（蜂鸣响）= **常开型（NO）**。
- **接线与电平对应**：
  - 门磁两线 → GPIO8（内部上拉）+ GND。
  - 磁铁靠近（门关）→ 触点闭合 → GPIO 拉低（电平=0）。
  - 磁铁远离（门开）→ 触点断开 → GPIO 上拉高（电平=1）。
- **固件配置**：`NODE_DOOR_OPEN_LEVEL=1`（GPIO 高电平 = 门开）。已写入 `.local/door-contact-20261026/src/profiles/bathroom.sdkconfig.defaults`。

### 5.2 接线与 GPIO（现场已确认）
```
门磁一端 ── P1 排针 GPIO14（内部上拉）
门磁另一端 ── P1 排针 GND
```
- 板型：正点原子 DNESP32S3（P1 排针 2×12）。
- GPIO14 为 P1 排针上唯一不与 AHT20(4/5)、PIR(36)、SOS(15)、I2S 语音(3/9/10/46)、摄像头 DVP(6/7/16/17/18/45/47/48/38/39)、板载 I2C(41/42)、ADC_IN(8) 冲突的空闲输入脚。
- 磁铁靠近（门关）= 触点闭合 = GPIO 拉低（电平=0）；磁铁远离（门开）= 触点断开 = GPIO 上拉高（电平=1）。
- 固件配置：`CONFIG_NODE_DOOR_GPIO=14`，`CONFIG_NODE_DOOR_OPEN_LEVEL=1`。

### 5.3 现有节点 GPIO 占用与候选脚
| 节点 | 占用 | 门磁候选 |
|---|---|---|
| 卫生间 ESP32 | PIR=36、SOS=15、AHT20 SDA=4/SCL=5、水漏预留 IO37、BUZZER XL9555、I2S 3/9/10/46（并行语音工程） | **GPIO8**（编译验证通过；须现场核对排针空闲且不与并行语音板冲突） |
| 厨房 ESP32 | I2C SDA=4/SCL=5、MQ2 ADC_CH=5/GPIO6、MQ5 voice-rewire CH=6/GPIO7、SOS/KEY0 XL9555 P1_7、BUZZER XL9555、I2S 3/9/10/46（语音工程） | **GPIO8**（候选，无占用记录；本轮不烧录，等卫生间门磁验收通过、厨房语音定型后叠加配置，避免覆盖并行会话语音成果） |

**结论**：两节点候选脚均为 GPIO8（统一配置，便于固件复用）。卫生间 GPIO8 须现场核对排针空闲；厨房门磁本轮只做方案准备，不烧录。**不凭"GPIO 没写在配置里"判断可用。**

### 5.4 未决事项（需现场完成）
1. 万用表实测门磁常开/常闭 → 确定 `NODE_DOOR_OPEN_LEVEL`。
2. 现场核对卫生间 GPIO8 排针空闲（无跳线、不与并行语音板冲突）。
3. 购买第二个门磁（厨房门用）。
4. 厨房门磁烧录时机：卫生间门磁验收通过后、厨房语音工程定型后。

---

## 6. 真实验收步骤（功能已就绪，集中请用户执行）

> 前置：完成第 5 节硬件确认 → 烧录启用门磁的节点固件（备份现有固件、核对 MAC/设备身份、不全片擦除、不改私有网络配置）→ APP 安装（现有签名身份，不卸载清数据）。

1. **实际关门**：核对实物触点、节点日志、后端 `GET /api/v1/devices` 的 `sensors.door.open`、APP 状态四者一致。
2. **实际开门**：确认新增 1 条正确开门记录（后端 `/api/v1/door-events` 与 APP 记录区）。
3. **再次关门**：确认新增 1 条正确关门记录，顺序、数量正确。
4. **保持状态不变**：确认不再持续新增记录（心跳不记账）。
5. **连续开关数次**：核对事件顺序、数量、来源（设备/服务器时间），无抖动重复。
6. **节点断开/恢复**：断开门磁节点网络（仅该节点，不动全屋网络与其他监护服务），确认 APP 显示离线/未知（不假报"已关闭"），恢复后重连去重、无重复事件。
7. **持久化**：隔离环境验证记录在服务重启后保留（backend 已测：schema v7 doorEvents 持久化白名单 + 重启重载）；生产实际验证与隔离验证分开记录。

> 若仅完成磁铁靠近/移开台架测试（bench `inj door`）而未安装到真实门：如实标注"实物门磁台架通过，安装使用未验收"。

---

## 7. 校验清单（状态区分）

| 项目 | 状态 |
|---|---|
| 门磁事件后端链路（store/persistent/API）本地实现并测试通过 | ✅ 已本地实现并验证 |
| APP 门磁展示与语义本地实现并测试通过 | ✅ 已本地实现并验证 |
| 固件门磁采集代码集成 + host 状态机单测 | ✅ 已本地实现并验证（构建结果见 4.2） |
| 固件完整构建（ESP-IDF bathroom profile GPIO8） | ✅ BUILD_EXIT=0，bin SHA-256 见 4.2 |
| 安装位置确认（卫生间门 + 厨房门，两扇都装） | ✅ 已确认（2026-10-26 用户答复） |
| 接入节点确认（卫生间节点 GPIO8） | ✅ 已确认（2026-10-26 用户答复） |
| 门磁常开/常闭与开启电平实测 | ✅ 已实测：常开型（NO），OPEN_LEVEL=1，已重编译固件 |
| 卫生间 GPIO8 排针空闲现场核对 | ⛔ 待现场核对 |
| 第二个门磁采购（厨房门用） | ⛔ 待采购 |
| 固件烧录到卫生间节点 | ⛔ 未执行（用户选"现场接线后再烧录"；烧录前备份现有固件、核对 MAC/设备身份、不全片擦除、不改私有网络配置） |
| 厨房门磁固件准备 | ⏸ 只做方案（GPIO8 候选；本轮不烧录，等卫生间验收通过 + 厨房语音定型后叠加配置） |
| 后端生产部署（公网） | ⛔ 未执行（公网接口未新增，复用现有已部署链路；backend 进程加载新代码需用户确认维护窗口） |
| APP 真机安装 | ⛔ 未执行（需现有签名身份；不卸载清数据；若连带 D/E/CAMERA-A 候选需先报告） |
| 真实验收（7 步：关门/开门/再关门/保持/连续开关/断线恢复/持久化） | ⛔ 未执行（待现场接线、烧录后集中进行） |

**未完成项不影响已交付部分**：本报告所有"已本地实现并验证"项不依赖真实硬件即可复核（测试命令见第 4 节）。

---

## 8. 回滚与安全说明
- 固件改动仅在 `.local\door-contact-20261026\src` 副本；公共固件树只读。回滚＝删除副本目录或重新复制公共树快照（`sha256-changes.txt` 提供改动文件哈希核对）。
- 后端 schema v6→v7：v1..v6 旧快照缺 `doorEvents` 键时按空台账兼容，不阻塞旧数据加载；`persistent-store.js` 白名单严格校验防脏数据。
- APP 改动均在既有页面增量；未触碰并行会话成果与未上线候选。
- 未强杀并行会话、未停止共享监护链路、未占用 COM8/COM4/COM5。

---

## 9. 厨房门磁接入（2026-10-27，复用卫生间门磁实现）

### 9.1 选脚依据（板级）

- 厨房现用：AHT20 I²C=4/5、MQ-2=6、MQ-5=**7**、音频 MCLK3/BCLK46/LRCK9/DOUT10、I²C0=41/42、LED=1、PIR=**38**、KEY0=XL9555、USB=19/20、Flash/PSRAM=26–37。
- 板级排除（[HARDWARE-MAP.md](../../docs/HARDWARE-MAP.md) §3 + 当前 sdkconfig）：摄像头 DVP 4/5/6/7、15/16/17/18、45/47/48、38/39；35/36/37 标注“勿用”；strapping 0/3/45/46。
- **选 GPIO14**：不在上述任何占用/冲突列表内；卫生间门磁已验证同脚（GPIO14, OPEN_LEVEL=1）；用户现场核对 P1 排针丝印 IO14 引出且空闲。
- 未改动 MQ-5（GPIO7/ch6）、音频 LRCK（GPIO9）、MQ-2（GPIO6/ch5）、AHT20（4/5）、PIR（38）、LED（1）、KEY0、Wi-Fi、deviceId。

### 9.2 接线与极性（实测）

| 项 | 值 |
|---|---|
| 门磁 | 两线无源干簧管（常开型 NO，万用表实测） |
| 接线 | 一线 → **IO14**，另一线 → **GND**（内部上拉，无外部电阻） |
| 判定 | 磁铁靠近（门关）= 触点闭合 = GPIO 低 = `open:false`；远离（门开）= 断开 = GPIO 高 = `open:true` |
| 固件极性 | `CONFIG_NODE_DOOR_OPEN_LEVEL=1`；启动基线实测“当前状态=关闭”与布线一致，无需改配置 |

### 9.3 构建（隔离副本，workspace 未改）

| 项 | 值 |
|---|---|
| 基线源码 | workspace `competition/esp32-node`（与在板 PIR 固件同源） |
| 移植 | 从 `.local/notice-20261026/bath-merged-src` 仅移植门磁：13 hunk、+262/−6（node_main 11、alarm_logic.h 1、Kconfig 1）；**未带 remote_sos**、未改语音/notice/PIR/MQ/KEY0/LED |
| 隔离目录 | `.local/kitchen-door-20261027/`（src/build-door-kitchen/defaults/logs/diffs） |
| 配置 | ID=esp32-kitchen、ROOM=厨房、GW=9101、PIR=38、**DOOR=14/OPEN_LEVEL=1/CONFIRM=2/CACHE=8/KEEP=300**、MQ2=5、**MQ5=6**、stack=8192、LED=1 低有效、voice=30、KEY0=y、bench=n |
| 镜像 | **1,022,160 B**，SHA-256 **`08FD7F2144F526334961852F776996BCFAEC6D19CA3F0D7ACB424C6031162D0D`**（1 MiB 余 26,416 B / 3%） |
| host 测试 | host_alarm_logic 141/0、host_door ALL PASS、host_notice 42/0、host_adpcm 6/6 |
| 移植记录 | `.local/kitchen-door-20261027/PORT-DIFF.md` |

### 9.4 烧录（只写 app 分区）

| 项 | 值 |
|---|---|
| 身份 | COM5、ESP32-S3 v0.2、MAC **50:78:7d:16:ed:60**（写前 chip_id 重读，脚本再校验） |
| 写前备份 | `.local/kitchen-door-20261027/device-backup/COM5-app-before-door-20261027.bin`：1 MiB，整段 `E0563AD7…`，**前缀哈希 = `F67AC3CE…A670F0`**（与在板 PIR 固件逐位一致） |
| 分区表核对 | 现场 flash 0x8000 前 3,072 B = 构建 `partition-table.bin` `7F00B6C0…B7C820` **完全一致** → 不写 bootloader/分区表 |
| 写入 | `write_flash 0x10000`，`Hash of data verified`，`fullErase=false`，未动 NVS |
| 记录 | `run/flash-kitchen-door-COM5.json`；启动日志 `run/kitchen-door-boot-20261027.log` |

### 9.5 启动验证（首启）

```
I (515) 门磁序号恢复 seq=0 待补传事件=0
I (515) 门磁已配置 GPIO14（开启电平=1，去抖确认=2 次，缓存=8 条/300s）
I (3095) 门磁基线建立：当前状态=关闭（不生成历史事件）
wifi:connected with ElderCareLab, WPA2-PSK, rssi=-35
I (5315) 已连接网关 10.127.130.179:9101
→ {..."door":{"open":false,"lastOpenTs":0}...}
STACK_FREE task=main bytes=3972 / gateway-net 2896（无栈溢出）
```

### 9.6 真实验收（用户操作门磁，串口采集 `run/kitchen-door-acceptance-20261027.log`）

| 步骤 | 实测 |
|---|---|
| 开门 | `门磁状态变化：开启（seq=1）` 01:34:08.756；上报 `open:true, lastOpenTs=1793036048882` |
| 关门 | `关闭（seq=2）` 01:34:14.238；上报 `open:false` |
| 再开/关 | `开启（seq=3）` 01:34:20.813 / `关闭（seq=4）` 01:34:28.518 |
| 保持不动 | seq=4 后 **23 秒无新事件**（01:34:28.5 → 01:34:51.6 才出现 seq=5），无重复刷记录 |
| 连续开关 3 次 | `seq=5..10` 依次 开/关/开/关/开/关，时间 01:34:51–01:35:21，**无抖动、无重复、顺序交替正确** |
| 公网上报 | 期间 `cloud-sync OK device=esp32-kitchen status=202`（01:34:22 / 01:34:55 / 01:35:28 …） |
| 重启持久性 | 受控复位后 `门磁序号恢复 seq=10 待补传事件=8`、基线建立“关闭（不生成历史事件）”；再次开关后复位 → **`seq=13`** 继续递增（未重置为 1） |

**seq 与时间线**：1(01:34:08.756) → 2(01:34:14.238) → 3(01:34:20.813) → 4(01:34:28.518) → 5(01:34:51.576) → 6(01:35:03.633) → 7(01:35:06.946) → 8(01:35:11.320) → 9(01:35:13.545) → 10(01:35:21.221)；重启后 11/12/13 继续。

### 9.7 断网恢复补传（如实披露，未完成）

- 本地门磁事件 FIFO（8 条/300s）与 NVS seq 已保留（重启日志 `待补传事件=8`）；
- 但 v7 未上线，**扩展字段（seq/events/lastCloseTs）不随旧协议上报**，因此“公网断网恢复补传”**当前无通道可供验证**；本次未做断网注入，不写成已通过。

### 9.8 分层状态（严格区分）

| 层级 | 状态 | 说明 |
|---|---|---|
| 本地实现/构建 | ✅ 完成 | 移植+构建+host 测试；镜像 `08FD7F21…2D0D` |
| 真实板验证 | ✅ 通过 | 开/关/再开/关、保持不重复、连续 3 次交替、重启 seq 10→13 持续 |
| 生产后端部署 | ❌ 未做 | 生产仍是 schema **v6**（无 `/api/v1/door-events`、无 `doorEvents` 台账）；未部署、未重启服务 |
| APP 安装 | ❌ 未做 | 已装 1.0.1（D/E-only）无门磁记录页，能力表厨房门磁仍标“未安装”；未安装任何新包 |
| 真实端到端验收 | ❌ 未完成 | 需 v7 部署 + APP 更新后才具备门磁事件公网入库与显示能力；本次只验证到“本地采集 + 基础状态 202” |

### 9.9 风险与回滚

- **分区余量仅 26,416 B（3%）**：后续不可再加语音素材/大字段；任何新增需先评估。
- `lastOpenTs` 不跨重启（重启后 0=无记录），属当前实现语义，非故障。
- 回滚到刷前 PIR 固件：`esptool --port COM5 --chip esp32s3 write_flash 0x10000 <COM5-app-before-door-20261027.bin>`（整段 1 MiB；或写前缀 1,020,192 B 的 `F67AC3CE…` 镜像）。bootloader/分区表未动，无需回滚。
- 未泄露 Wi-Fi/Token；固件与真实 defaults 只留在 `.local/`；`kitchen.sdkconfig.defaults` 交付为**脱敏模板**。

### 9.10 厨房门磁验收证据索引

- `run/flash-kitchen-door-COM5.json`（写录记录）
- `run/kitchen-door-boot-20261027.log`（首启日志）
- `run/kitchen-door-acceptance-20261027.log`（开/关/保持/连续开关串口记录）
- `run/kitchen-door-reboot-20261027.log`、`run/kitchen-door-reboot2-20261027.log`（重启 seq 持久化）
- `kitchen.sdkconfig.defaults`（脱敏配置模板）
