# 电量（电池电压采样）逐板核验 —— 2026-10-27 只读审计

- 工作区：`<WORKSPACE>`（Windows / PowerShell / Asia-Shanghai）
- 边界：**只读**源码、配置、构建产物、固件二进制、UI 快照与本地日志；未开串口、未烧录、未连设备、未访问生产后端、未改任何源码。未读取 `.secrets` / `.env.deploy`。
- 证据分级：
  - **REAL**：本轮只读可复核的源码/配置/构建产物/日志/UI 快照事实，且相互吻合；不代表设备此刻在线。
  - **SOURCE-ONLY**：代码/配置/文档存在，但没有随可验证构建或部署证据。
  - **NOT TESTED**：本轮未做（现场动作、耗时测试、仪表测量）。
  - **BLOCKED**：需要设备操作/授权（开串口、烧录、访问生产）才能验证。

## 0. 结论速览

**全部受监护板卡均未接入电池电量检测。** 没有电池电压采样电路、没有分压接线、没有电池 ADC 采集代码、固件上报 JSON 没有 `battery` 字段、后端/网关/物模型/APP 契约都没有电量字段。**不得显示电量百分比。**

| 设备（deviceId） | 板卡/供电 | 电池采样电路 | ADC 引脚占用 | 固件电池代码 | 上报 JSON `battery` | 后端字段 | 结论 | 等级 |
|---|---|---|---|---|---|---|---|---|
| esp32-kitchen（厨房） | 正点原子 DNESP32S3，固定/USB 供电 | 未发现 | ADC1 仅 CH5(GPIO6 MQ-2)、CH6(GPIO7 MQ-5) | 无 | 无 | 无 | 未接入电量检测 | REAL |
| esp32-bath（卫生间） | DNESP32S3，固定/USB 供电 | 未发现 | 无 ADC 通道启用（MQ 全 -1） | 无 | 无 | 无 | 未接入电量检测 | REAL |
| esp32-sos（随身求助） | 独立 ESP32-S3 板，当前 USB 供电（独立电源未验收） | 未发现 | 无 ADC 通道启用 | 无 | 无 | 无 | 未接入电量检测 | REAL |
| dayu200-living（客厅） | DAYU200（RK3588），适配器供电 | 未发现；只有 RTC 纽扣电池，不是可监测电池 | 无电量 ADC | 无 | 无 | 无 | 未接入电量检测 | REAL |
| esp32-node-wearable（4G 随身） | ESP32-S3 + YED M100MG-B1；ESP32 由 USB/充电宝，M100 独立 5~12V | 未发现 | 无 ADC 通道启用 | 无 | 无 | 无 | 未接入电量检测 | REAL |
| esp32-sos-isolated-test 等“隔离测试节点” | 后端历史/测试记录，无对应实物台账 | 不适用 | 不适用 | 无 | 无 | 无 | 未核实，按“无真实来源”处理 | SOURCE-ONLY |

## 1. 逐板证据

### 1.1 esp32-kitchen（厨房，MAC `50:78:7d:16:ed:60`）

- ADC 引脚：`main/Kconfig.projbuild:217-231` 只有 `NODE_MQ2_ADC_CHANNEL` / `NODE_MQ5_ADC_CHANNEL` 两个电池/模拟量配置项，没有 battery 项。
- 厨房实测构建配置：`esp32-node/.local/door-v7-20261027/build-kitchen/config/sdkconfig.json`
  - `NODE_MQ2_ADC_CHANNEL = 5`（GPIO6 / ADC1_CH5）
  - `NODE_MQ5_ADC_CHANNEL = 6`（GPIO7 / ADC1_CH6，语音改线后的实物接法）
  - `NODE_AHT20_ENABLED = true`（I2C1 GPIO4/5）
  - `NODE_MOTION_GPIO = 38`、`NODE_DOOR_GPIO = 14`、`NODE_LED_GPIO = 1`、`NODE_SOS_KEY0_ENABLED = true`
  - **没有任何 `NODE_BATTERY*` 键**
- ADC 初始化只注册 MQ-2/MQ-5 两个通道：`esp32-node/main/node_main.c:470-486`（`adc_oneshot_config_channel` 仅两处，均在 MQ 宏内）。
- 上报 JSON 无 `battery`：`esp32-node/main/node_main.c:1526`（`char json[900]`）与 `:1536-1556`（只含 deviceId/room/ts/state/sensors{motion,door,climate,gas,smoke[,water]}/history/slots/alarm）。
- 固件二进制字符串扫描（本轮现算）：`esp32-node/.local/door-v7-20261027/build-kitchen/esp32_elder_node.bin`（1,022,480 B）中 `battery/Battery/BATTERY/voltage/vbat` 命中 **NONE**。
- 结论：未接入电量检测（REAL）。厨房为固定供电节点，没有电池包/电量计。

### 1.2 esp32-bath（卫生间，MAC `14:c1:9f:42:dd:b4`）

- 实测构建配置：`esp32-node/.local/door-v7-20261027/build-bath/config/sdkconfig.json`
  - `NODE_MQ2_ADC_CHANNEL = -1`、`NODE_MQ5_ADC_CHANNEL = -1`（未启用任何 ADC 通道）
  - `NODE_MOTION_GPIO = 36`、`NODE_SOS_GPIO = 15`、`NODE_DOOR_GPIO = 14`、`NODE_AHT20_ENABLED = true`（I2C1 GPIO4/5）
  - **无 battery 配置**
- 公开 profile 同样无电量项：`esp32-node/profiles/bathroom.sdkconfig.defaults`（全文 35 行，只有传感器/告警参数）。
- 二进制扫描：`.../build-bath/esp32_elder_node.bin`（1,011,648 B）命中 **NONE**。
- 历史电量结论与之一致：`evidence/2026-10-26-core-gap-freeze/REPORT.md:102-104` 明确“固件 `report()` JSON 无 battery；后端设备模型只有 csq；APP `DeviceDto` 只有 csq”。该结论本次复核仍成立。
- 结论：未接入电量检测（REAL）。

### 1.3 esp32-sos（随身求助，COM8 / MAC `30:30:f9:08:76:84`）

- 接线：按钮 GPIO4（内部上拉，低=按下）、有源蜂鸣器 GPIO5；GPIO6 是 16MB Flash 脚禁用；供电为“待改独立移动电源/电池，当前依赖 USB 数据线”——`evidence/2026-10-26-wireless-sos-button-final/WIRING.md:5-12`。
- 固件 profile：`D:\esp32-sos-build\profiles\sos-node.sdkconfig.defaults:16-34`，`MOTION=-1`、`WATER=-1`、`DOOR=-1`、`AHT20=n`、`MQ2/MQ5=-1`，**无 battery/ADC 项**。
- 该工程源码由 `esp32-node` 派生（`D:\esp32-sos-build\main\node_main.c` 内只有 MQ ADC 相关条件编译，无电池采样）。
- 二进制扫描：`D:\esp32-sos-build\.local\build-sos-gpio5-hl\esp32_elder_node.bin`（762,768 B）命中 **NONE**。
- 结论：未接入电量检测（REAL）。**这是最需要补的一台**，但当前连独立供电都未验收（WIRING.md:12）。

### 1.4 dayu200-living（客厅主控，DAYU200）

- DAYU200 由适配器供电；手持/移动场景不适用。
- 板上有 RTC 纽扣电池（hym8563/rtc1），但它是**时钟保持电池，不是电量监测对象**：`docs/evidence/2026-10-15-dayu-time-recovery.md:27-28`；`docs/KNOWN-RISKS.md:127`。
- 无电量 UI/字段：`evidence/2026-10-26-core-gap-freeze/REPORT.md:195`（“DAYU APP 无电量相关 UI，仅注释命中电量”）。
- 结论：未接入电量检测（REAL）。

### 1.5 esp32-node-wearable（4G 随身设备）

- 接线/供电：`esp32-node-wearable/WIRING.md:30-51`：ESP32-S3 与 M100 共地；按钮 GPIO4、蜂鸣器 GPIO5、UART1 GPIO17/18；M100 独立 5~12V；ESP32 由 USB/充电宝供电；**GPIO6、GPIO19/20、GPIO26-37 禁用/占用**。
- 固件：`esp32-node-wearable/main/wearable_main.c` 无 `adc_*` 初始化（只有 UART/GPIO 配置）；`main/wearable_logic.c` 未见 battery/voltage 字段（全目录 grep `battery|voltage|电量` 仅命中 WIRING.md:50 的“适配器或电池”）。
- 结论：未接入电量检测（REAL）。若后续要做“随身设备电量”，这是第一优先级板卡。

### 1.6 “隔离测试节点”（esp32-sos-isolated-test 等）

- 生产 APP 设备管理页把它单独列为“隔离测试 · esp32-sos-isolated-test / 能力待确认 / 未核实该设备能力；不默认拥有任何传感器”，见 `competition/evidence/2026-10-27-real-capability-app/baseline/layout/devmgmt_02.json`（单行 JSON，文本 `隔离测试 · esp32-sos-isolated-test`、`能力待确认`）。
- 没有实物台账、没有固件身份、没有电量来源；APP 侧按“未登记设备 = 无真实电量来源”处理：`APP/ElderlyCareGuardian/entry/src/main/ets/core/inventory/DeviceInventory.ts:134-147`。
- 结论：不适用/未核实（SOURCE-ONLY），不得为它显示电量。

## 2. 全链路字段缺失（即使固件加了也会被丢）

本轮复核以下层均无 `battery`（`grep battery|电量|电压`）：

1. **固件上报**：`competition/esp32-node/main/node_main.c:1536-1556`。
2. **网关/适配器**：`cloud/onenet/adapter.js` 只归一化 `motion/door/climate/gas/smoke`（`normalizeStatus` 见 `adapter.js:297-306`；motion `:132-144`、door `:147-170`、climate `:211-217`）。
3. **public-sync payload**：`cloud/onenet/cloud-sync.js:75-97`，把 `device.sensors` 原样 `cloneBoundedObject`，但上游 adapter 已把 sensors 归一化，未列出的键不会进入标准链路。
4. **后端设备状态模型**：`cloud/backend/src/store.js:66-100`（`normalizeStatus`）返回 `deviceId/room/online/monitorOnline/ts/state/alarm/sensors/gps`，无 battery；APP 侧 `DeviceDto` 只有 `csq`（`APP/ElderlyCareGuardian/entry/src/main/ets/core/api/Contracts.ts:94-108`）。
5. **OneNET 物模型**：`cloud/onenet/thing-model.json` / `thing-model.onenet-import.json` 无 battery 属性（全仓库 grep 命中为 0）。
6. **APP**：`BatteryCapability` 现在全部返回 `not-supported`，UI 文案固定“该设备未接入电量检测”（`DeviceInventory.ts:26-44,81-99,134-147`；`ViewMapper.ts:476-480`；`Models.ts:116-121`）。设备管理页还写着“添加设备、一键自检、电池提醒本轮未开放（无对应后端接口）”（`pages/DevicePage.ets:595`；生产基线快照同文，见 `baseline/layout/devmgmt_top.json` 文本第 10 条）。

> 结论：电量不是“UI 没画”，而是**采集-上报-网关-后端-契约-UI 六层都没有数据源**。`csq` 是信号质量，不能当电量。

## 3. 补齐方案（可执行清单；本轮未实施）

### 3.1 硬件：分压 + 滤波

- 1S 锂电（3.0–4.2V）：`100k/100k` 分压 → 1.5–2.1V 进入 ADC（12 dB 衰减量程 ~0–3.1V 内，留余量）。
- 2S（6.0–8.4V）：`200k/100k` 分压 → 2.0–2.8V。
- 加分压点 `100nF` 到 GND 滤波；可选 `1k` 串联限流；ADC 脚不得直接接电池正极。
- 分压电流：100k+100k 在 4.2V 时 ~21µA，常开可接受；纽扣/长期佩戴场景改用 1M 级并加采样使能 MOS，避免常耗。
- 电池座/充电模块（TP4056 等）另行评估；本轮没有任何电池座、充电电路、保护板证据。

### 3.2 ADC 引脚与冲突检查（必须现场复核）

ESP32-S3 只有 **ADC1（GPIO1–GPIO10 = CH0–CH9）** 可与 Wi-Fi 同时使用；ADC2（GPIO11–20）在 Wi-Fi 开启时不可用（ESP-IDF 通用约束，需固件实测确认）。

| 板卡 | 已占用（固件实测配置） | 可候选 ADC1 脚 | 冲突检查结论 |
|---|---|---|---|
| esp32-kitchen | GPIO1 LED、4/5 AHT20、6 MQ-2(CH5)、7 MQ-5(CH6)、3/9/10/46 I2S、41/42 I2C0、38 PIR、14 门磁 | **GPIO2/ADC1_CH1 或 GPIO8/ADC1_CH7** | 不与 MQ/I2S/AHT/PIR/门磁/LED 冲突；GPIO8 需核对排针与 DVP 摄像头排线占用（公开 Kconfig 注释列 DVP=4/5/6/7/16/17/18/45/47/48/38/39，未含 8）。物理是否引出 **NOT TESTED** |
| esp32-bath | 36 PIR、15 SOS、14 门磁、4/5 AHT20、3/9/10/46 I2S、41/42 I2C0、1 LED | **GPIO2/CH1 或 GPIO8/CH7** | 同上；GPIO8 在卫生间曾作为门磁候选但最终用 GPIO14，需确认排针未被占用。**NOT TESTED** |
| esp32-sos | 4 按钮、5 蜂鸣器；6 是 Flash 脚严禁用；19/20 USB；0/3/45/46 strapping | **GPIO2/CH1 或 GPIO8/CH7** | 不冲突；该板无 P1 排针定义证据，需按实际板卡核对。**NOT TESTED** |
| esp32-node-wearable | 4 按钮、5 蜂鸣器、17/18 UART1；26–37 Flash/PSRAM | **GPIO2/CH1 或 GPIO8/CH7** | 不冲突；需核对 16MB Flash 板可用排针。**NOT TESTED** |
| dayu200-living | 无 GPIO 电池采样意义 | 不适用 | 需 I2C 电量计电池包（如 MAX17048）或外接 ADC；并核对与 MIPI-CSI/HDC 供电冲突。**不适用现在** |

> 硬性要求：接线前用万用表确认分压输出 ≤3.3V、共地；不得用 ADC2；不得复用 MQ 通道；不得把 5V 直接进 ADC。

### 3.3 校准

- 至少两点校准：在电池端子实测电压（万用表）与 ADC raw 成对记录，例如 `3.70V ↔ raw_a`、`4.10V ↔ raw_b`，线性拟合斜率/截距；ESP32-S3 ADC 非线性明显，建议 3 点以上分段或使用 `esp_adc_cal` 曲线校准。
- 采样：每 30–60 s 一次，连续 8 次取中位数/均值；Wi-Fi 发射窗口避开采样或做异常剔除。
- 显示口径：建议先只报 **电压 mV + 有效性**，并给“低电量”阈值（1S 例：3.5V 告警）；**没有电芯 OCV 曲线与负载补偿不得显示百分比**；如必须显示百分比，需注明“估算”并给出误差界限。
- 验收：真实放电曲线（至少从 4.1V 放到 3.4V）逐点记录，静态对比万用表 ±50mV；断线/未接 → `valid=false` + 不显示 0%。

### 3.4 固件改动点（文件:行）

- `competition/esp32-node/main/Kconfig.projbuild`：在 MQ ADC 段（`:217-231`）之后新增
  `NODE_BATTERY_ADC_CHANNEL`（default -1）、`NODE_BATTERY_DIVIDER_NUM/DEN`、`NODE_BATTERY_CAL_*`、`NODE_BATTERY_LOW_MV`。
- `competition/esp32-node/main/node_main.c`：
  - ADC 初始化（`:470-486`）新增电池通道 `adc_oneshot_config_channel`；
  - 采样（`:1300-1336` 附近）新增读取与 `s_batt_mv/s_batt_valid`；滤波/换算函数放 `alarm_logic.h` 便于 host 测试；
  - `report()`（`:1526` 的 `char json[900]`、`:1536-1556`）新增 `"battery":{"mv":%d,"valid":%s}`；`json[900]` 需评估余量，建议同步加大并做长度断言；
  - 注意厨房 v7 固件 app 分区仅余 **26,096 B（2%）**（`evidence/2026-10-27-door-v7-e2e/REPORT.md` §4 表），任何新增必须先算体积。
- 私有副本必须同步（否则只有公共树、上板固件不会变）：`esp32-node/.local/door-v7-20261027/{kitchen-src,bath-src}/main/*`、`esp32-node/.local/kitchen-door-20261027/src/main/*`、`esp32-node/.local/bathroom-voice-20261026/src/main/*`；`D:\esp32-sos-build\main\node_main.c`；`esp32-node-wearable/main/wearable_logic.c`（其上报 JSON 在 `wearable_logic.c` 内构造）。
- 也可只在“有电池的板”启用，固定供电板保持 `-1`（Kconfig 语义）。

### 3.5 网关/后端/APP 改动点

1. `cloud/onenet/adapter.js`：`normalizeStatus`（`:297+`）与 sensors 组装处新增 battery 归一化（`mv` 整数 0..60000、`valid` bool，未知不默认 0）。
2. `cloud/backend/src/store.js:66-100`：`normalizeStatus` 接受并校验 `battery`；`listDevices`/`getDevice` 透出。
3. `cloud/backend/src/persistent-store.js`：schema 升版（v7→v8），旧 v1..v7 快照缺 battery 视为无（参照门磁 v6→v7 做法：`evidence/2026-10-27-door-v7-e2e/REPORT.md` §2.1）。
4. `APP/.../core/api/Contracts.ts:94-108`：`DeviceDto` 增 `batteryMv/batteryValid/batteryPresent`；`ViewMapper.ts:476-480` 改为读 DTO；`Models.ts:116-121` 保留 not-supported 兜底；`DeviceInventory.ts:81-99` 每个设备标注采样来源/校准；`DevicePage.ets:595` 文案改为“设备管理页可显示真实电量（若已接入）”。
5. 测试：`esp32-node/test/`（换算/边界/无效）、backend `test/`、APP `tests/{contracts,view-mapper,capability}.test.mjs`；生产验收另立任务，需真实放电，禁止造数。

## 4. 本轮明确未做

未开串口、未烧录、未接电池/分压、未用万用表、未改源码、未部署后端、未安装 APP、未触发任何告警。所有引脚“可候选”均未在实物上核对 → **NOT TESTED**。
