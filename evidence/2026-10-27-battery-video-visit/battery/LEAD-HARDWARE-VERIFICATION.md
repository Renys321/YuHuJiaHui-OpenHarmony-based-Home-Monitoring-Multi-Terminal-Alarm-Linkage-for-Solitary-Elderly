# 电量硬件核验（Lead 现场只读复核，2026-10-27 20:10–20:47）

边界：本轮只做**只读**命令与构建产物核对；**未打开任何 ESP32 串口（COM4/COM5/COM8 未 open）、未烧录、未接线、未用万用表**。真实电压测量因此不可能在本轮产生。

## 1. DAYU200（dayu200-living）

| 检查 | 命令/证据 | 实测结果 |
|---|---|---|
| 供电 | `hdc shell ifconfig` / 现场 | 电源适配器固定供电；无电池 |
| 电源子系统 | `hdc shell "ls /sys/class/power_supply"` | **目录为空**（无 power_supply 设备/驱动） |
| 系统电池 API | `hdc shell "hidumper -s BatteryService -a '-i'"` | `capacity: 11`、`voltage: 4123456`(µV)、`present: 0`、`chargingStatus: 1`、`technology: Li-ion`、`totalEnergy: 4000000`；`present: 0` 表示无电池 |
| 能否人为改值 | BatteryService 帮助 | `--capacity <0..100>` 可任意设置容量；说明该值是**模拟/可写状态**，不是测量值 |
| 状态栏 11% | 截图 | 系统状态栏电量图标来自上述模拟状态，**不是真实电量**；APP 不使用、未展示 |

结论：**固定供电，无电池电量数据**。APP 显示“固定供电，无电池电量数据 / DAYU200 由电源适配器固定供电，系统无 power_supply 设备；系统 BatteryService 的容量是模拟值，不是真实电量，APP 不使用。”（截图 `battery/app-battery-ui/lead-device-page-1.jpeg`）。

## 2. kitchen / bathroom ESP32-S3（esp32-kitchen / esp32-bath）

- 供电：USB/固定供电（现场与历史接线证据一致）。
- 在板构建配置（只读）：厨房 `NODE_MQ2_ADC_CHANNEL=5`(GPIO6)、`NODE_MQ5_ADC_CHANNEL=6`(GPIO7)，无电池项；卫生间两个 MQ 通道为 -1，无 ADC 通道。
- 固件：`esp32-node/main/node_main.c` 原有上报 JSON 无 `battery`；本轮新增电池逻辑后，**battery 关闭构建的二进制里不含 `battery`/`"source":"battery"`/`percent`/`calibrated` 字符串**（`battery/evidence/binary-scan*.md`）。
- 结论：**固定供电，无电池电量数据**；APP 不显示电量百分比，显示固定供电说明。

## 3. esp32-sos（随身求助，COM8）

- 现有接线（历史证据 + 源码）：按钮 GPIO4（内部上拉，低=按下）、有源蜂鸣器 GPIO5、GPIO6 是 Flash 脚禁用；**当前 USB 供电，无电池座/充电电路/分压/电量计**。
- 本轮：新增 `NODE_BATTERY_ADC_CHANNEL=2`（ADC1_CH1）固件构建（`D:\esp32-sos-build\.local\build-sos-battery-20261027`，774,480 B，SHA256 `33E83E…6004EA`，含 battery 段），**但未烧录、未接线**；无实物电池时该构建只会输出 `valid=false/mv=null/reason`（稳定性+范围+样本数三重门限，浮动引脚不会被判有效）。
- 结论：**未接入电量检测（无采样硬件）**；APP 显示“电量未知（设备未上报电量）/ 未接入电量检测（无采样模块）”+ 补齐条件（截图 `battery/app-battery-ui/lead-device-page-2.jpeg`）。
- 补齐硬件清单与接线表见 `battery/BOM-WIRING.md`：1S 锂电 + TP4056 + MT3608 + 100k/100k 分压 + 100nF + 1k → GPIO2(ADC1_CH1)，共地；分压后 1.5–2.1V 在 12dB 衰减量程内，分压电流 ~21µA。**接线前必须万用表确认 ≤3.3V、共地；禁止电池正极直连 ADC、禁止 ADC2、禁止复用 MQ 通道。**

## 4. esp32-node-wearable（4G 随身）

- 现有：ESP32-S3 + YED M100；按钮 GPIO4、蜂鸣器 GPIO5、UART1 GPIO17/18；无 ADC 初始化、无 battery 字段。
- 本轮：`wearable_logic.c` 新增可选 `wb_battery_t` 心跳字段（`wb_build_hb_ex`，旧 `wb_build_hb` 签名不变），host 测试 35 项通过；**未烧录 M100/ESP32**。
- 结论：**未接入电量检测**（无采样硬件）；APP 归为 battery-capable，未上报时显示“电量未知”。

## 5. 未核实/隔离测试节点

`esp32-sos-isolated-test*` 等为后端历史/测试记录，无实物台账、无固件身份、无电量来源；APP 继续按“未纳入监护的后端记录”处理，不显示电量。

## 6. 结论汇总

| 设备 | 供电 | 电池采样硬件 | 本轮状态 | APP 展示 |
|---|---|---|---|---|
| esp32-kitchen | USB/固定 | 无 | 固件 battery 关闭（无字段） | 固定供电，无电池电量数据 |
| esp32-bath | USB/固定 | 无 | 固件 battery 关闭（无字段） | 固定供电，无电池电量数据 |
| dayu200-living | 电源适配器 | 无（BatteryService 为模拟值，present:0） | 不采集 | 固定供电，无电池电量数据 |
| esp32-sos | 当前 USB | 无（固件与接线方案已就绪，未接） | 构建通过未烧录 | 电量未知（设备未上报电量）+ 未接入说明 |
| esp32-node-wearable | USB/充电宝 | 无 | 构建/测试通过未烧录 | 电量未知（未上报） |

真实电量测量：**BLOCKED-BY-HARDWARE**（缺实物电池/分压/ADC 接线与万用表校准）。真实验收口径：接线后万用表读数 vs APP 显示 mV 误差 ≤±50mV；4.1→3.4V 放电逐点记录；断开分压显示“未知”而非 0%/旧值；低电量阈值触发。见 `battery/BENCH-CALIBRATION.md`。
