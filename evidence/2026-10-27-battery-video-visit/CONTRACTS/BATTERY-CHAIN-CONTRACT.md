# 真实电量检测链契约（2026-10-27，Lead 冻结）

本文件是电量实现的唯一契约。变更契约必须先通知 Lead。

## 0. 已核实事实（2026-10-27 20:10，Lead 实测/复核）

| 设备 | 供电/板卡 | 电池采样硬件 | 结论 |
|---|---|---|---|
| esp32-kitchen | 正点原子 DNESP32S3，USB/固定供电 | 无（ADC1 仅 GPIO6/ADC1_CH5 MQ-2、GPIO7/ADC1_CH6 MQ-5） | 固定供电，无电池电量数据 |
| esp32-bath | DNESP32S3，USB/固定供电 | 无（ADC 未启用） | 固定供电，无电池电量数据 |
| esp32-sos | 独立 ESP32-S3（COM8），当前 USB 供电；按钮 GPIO4、蜂鸣器 GPIO5；GPIO6 Flash 禁用 | 无（无电池座/充电/采样证据） | 未接入电量检测；是“电池化”第一优先板 |
| dayu200-living | DAYU200 RK3588，电源适配器 | 无 `power_supply` 设备；系统 BatteryService 为模拟值（`present: 0`，`capacity: 11` 可由 `--capacity` 任意设置） | 固定供电，无电池电量数据；**系统 11% 不是真实电量，禁止使用** |
| esp32-node-wearable | ESP32-S3 + YED M100；ESP32 USB/充电宝，M100 独立 5~12V | 无（无 ADC 初始化） | 未接入电量检测；第二优先板 |

全链路（固件 → bridge → 网关/适配器 → cloud-sync → 后端 → 契约 → APP）当前都没有 battery 字段。本期把**链路全部实现并用本地测试/构建验证**；真实测量因无实物电池/分压/ADC 接线，标记为 `BLOCKED-BY-HARDWARE`。**任何情况下不得显示伪造的百分比、USB 5V 电压、Wi-Fi 信号或固定值当电量。**

## 1. 硬件方案（可采购、可接线；本期不接实物）

### 1.1 BOM（每台电池设备一套）

| 物料 | 型号/规格 | 数量 | 用途 |
|---|---|---|---|
| 1S 锂离子电池（带保护板） | 3.7V 1000–2000mAh，JST-PH 2.0 插头，带过充/过放保护 | 1 | 供电与电压测量对象 |
| USB-C TP4056 充电+保护模块 | 5V 输入，1A，带 DW01 保护 | 1 | 充电与电池保护 |
| 5V 升压模块 | MT3608（2A）或等效 | 1 | 3.0–4.2V → 5V 给 ESP32-S3 板 5V 输入 |
| 金属膜电阻 100kΩ 1% | 1/4W | 2 | 分压 R1/R2（100k/100k） |
| 陶瓷电容 100nF 50V | — | 1 | 分压点对 GND 滤波 |
| 电阻 1kΩ 1% | 1/4W | 1 | ADC 输入串联限流（可选但建议） |
| 电池电压表头或万用表 | 2 位小数 | 1 | 两点校准用 |
| 杜邦线/焊接耗材 | — | 若干 | 接线 |

### 1.2 接线表（以 esp32-sos 板为例；GPIO2 = ADC1_CH1，核对无占用）

| 从 | 到 | 说明 |
|---|---|---|
| 电池正极（BAT+，经保护板 OUT+） | R1 一端 | 电池实际电压测量点 |
| R1 另一端 | 分压节点 A | — |
| 分压节点 A | R2 一端 | — |
| R2 另一端 | GND | 与 ESP32-S3 GND 共地 |
| 分压节点 A | 100nF → GND | 滤波 |
| 分压节点 A | 1kΩ → GPIO2（ADC1_CH1） | 串联限流后进 ADC |
| 电池 OUT+ | MT3608 IN+ | 升压输入 |
| 电池 OUT- | MT3608 IN- / GND | 共地 |
| MT3608 OUT+（5V） | 板 5V 输入 | 给板供电 |
| MT3608 OUT- | GND | 共地 |
| TP4056 B+/B- | 电池正/负 | 充电 |
| TP4056 OUT+/OUT- | 系统 5V 升压输入/地 | 充电与放电共用保护 |

分压计算：`Vadc = Vbat × R2/(R1+R2) = Vbat/2`。1S 范围 3.0–4.2V → 1.5–2.1V；ESP32-S3 ADC 12dB 衰减量程约 0–3.1V，余量足够。分压电流 4.2V 时约 21µA（可常开）。**禁止电池正极直接进 ADC；禁止用 ADC2（Wi-Fi 开启时不可用）；禁止复用 MQ 通道。**

### 1.3 校准与换算（固件实现，必须可 host 测试）

- `battery_mv = adc_raw_to_mv(raw, atten, refMv, calGainPermille, calOffsetMv)`，其中分压比 = 2（`R1=R2`），`battery_mv = adcPinMv × 2`。
- 采样：每 30s 一次，连续 8 次取中位数；Wi-Fi 发射窗口内的异常样本剔除（连续样本 max-min > 300mV → `reason=UNSTABLE`）。
- 有效性：`2.5V ≤ battery_mv ≤ 4.35V` 才 `valid=true`，否则 `valid=false` + `reason=OUT_OF_RANGE|UNSTABLE|NO_ADC`。
- 低电量阈值：`NODE_BATTERY_LOW_MV`（默认 3500mV）→ `low=true`。
- 百分比：**只有** `calibrated=true`（至少 2 点万用表校准，Kconfig 填 gain/offset）才给 `percent`，用 1S Li-ion 静置 OCV 近似曲线；否则 `percent=null`，APP 只显示 mV 并注明“未标定”。不得把未标定电压换算成百分比冒充精确电量。
- 多点校准流程见 `evidence/.../battery/BENCH-CALIBRATION.md`（由 battery-chain 产出）。

## 2. 固件字段契约（device status JSON，顶层新增 `battery`）

固件（`competition/esp32-node` 及私有副本 / `D:\esp32-sos-build` / `competition/esp32-node-wearable`）：

```json
"battery": {
  "source": "battery" | "fixed",
  "present": true,
  "valid": true,
  "mv": 3850,
  "percent": 42,
  "low": false,
  "calibrated": true,
  "reason": ""
}
```

- 固定供电设备（厨房/卫生间/DAYU200）：**不输出 `battery` 字段**（或 `source:"fixed"`，二选一；实现统一选择“不输出”，APP 依据设备台账判定固定供电）。
- 电池设备（sos/wearable）启用 `NODE_BATTERY_ADC_CHANNEL >= 0` 后必须输出 `battery`；无有效样本时 `valid=false`、`mv=null`、`percent=null`，`reason` 为短码。
- 字段校验：`mv` 整数 0–60000 或 null；`percent` 整数 0–100 或 null；`low/valid/present/calibrated` bool；`reason` `[A-Z_]{0,16}`。

## 3. 网关/适配器（`cloud/onenet/adapter.js`）

- `normalizeStatus` 新增 `battery` 归一化（严格：对象、字段类型/范围；未知字段拒绝），返回 `battery`（缺失为 `undefined`）。
- `toPropertyPost` 可选带 `battery`（OneNET 属性上报保持兼容，不改变既有属性）。
- 不改其它协议语义；原有 125+ 测试不得回归。

## 4. cloud-sync（`cloud/onenet/cloud-sync.js`）

- `buildIngestPayload` 在 `sensors/gps/csq` 旁新增 `if (device.battery !== undefined) payload.battery = cloneBoundedObject(device.battery)`。
- 网关聚合/状态保留 battery（同 device 新状态覆盖旧状态）。

## 5. 后端（`cloud/backend`）

- `store.js normalizeStatus`：接受可选 `battery`，校验后写入 `device.battery`；缺失 → 不写入（不是 0）。设备序列化（`serializeDevice`/`listDevices`/`getDevice`）透出 `battery`（缺失为 null/不出现）。
- `persistent-store.js`：若 schema 校验 sensors 为通用对象则无需升版；如白名单校验则升 v8 并兼容旧快照缺省（不丢旧数据、不重置账号/记录）。
- `/internal/v1/device-status` 输入校验接受 battery；非法 battery 不得导致设备状态整体丢弃（按“无电量”处理并记录 code）。
- 所有既有测试（393+）必须通过；新增 battery 测试覆盖：合法/缺省/非法范围/负值/超上限/非整数/mv=0（不得当 valid）/未知 source。

## 6. APP（`<WORKSPACE>\APP\ElderlyCareGuardian`，仅改 APP 代码，不改服务器）

- `core/api/Contracts.ts`：`SensorsDto`/`DeviceDto` 增 `battery: BatteryDto | null`（字段见 §2；来自后端设备对象顶层 `battery`，兼容 sensrors 内嵌套），严格解析；缺失→null。
- `core/inventory/DeviceInventory.ts`：每台设备声明电量来源：
  - kitchen/bath/dayu200-living：`fixed`（固定供电，无电池电量数据）
  - esp32-sos / esp32-node-wearable：`battery-capable`（未上报时显示未知；不得写死百分比）
- `core/view/ViewMapper.ts`/`Models.ts`：生成 `BatteryView`：
  - `fixed`：`"固定供电，无电池电量数据"`
  - `real + fresh`：`"3.85 V · 约 42% · 更新于 HH:mm"`（percent 为 null 时 `"3.85 V · 未标定 · 更新于 HH:mm"`；low 时加 `"电量偏低"`）
  - `missing`（battery 设备无上报）：`"电量未知（设备未上报电量）"`
  - `stale`（`lastSeenTs` 距今 > 120s）：`"电量数据过期（最后更新 HH:mm）"`
  - `offline`（`online=false`）：`"设备离线，电量未知"`
- `pages/DevicePage.ets`：逐台显示上述文案；`esp32-sos` 卡片显示“未接入电量检测（无采样模块）”与补齐条件；不得出现假的 100%/0%。
- 测试：Contracts 解析、ViewMapper 各状态、inventory 能力、静态守卫（禁止伪造电量字符串、禁止把 csq 当电量）；`tsc` + Node 行为测试全绿。

## 7. 真实测量验收（本期状态）

- 无实物电池/分压/ADC 接线 → **真实电量测量不可能在本期完成**。完成标准只能到：链路代码真实、测试真实、固件可构建、APP 对“无数据”显示准确。
- 硬件接好后（用户按 §1 BOM/接线表操作）的验收：万用表读数 vs APP 显示 `mv` 误差 ≤ ±50mV；放电 4.1→3.4V 逐点记录；断开分压 → APP 显示“电量未知”而非 0%/旧值；低电量阈值触发 `low=true`。
- 交付报告中必须逐台写明“已实现/已部署/真实设备验收”三态；不得把 host 单测或固件构建写成真机测量通过。
