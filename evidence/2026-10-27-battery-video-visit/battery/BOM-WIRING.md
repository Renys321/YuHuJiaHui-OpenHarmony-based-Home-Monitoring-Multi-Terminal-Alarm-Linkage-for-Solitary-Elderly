# 电池电量检测 · BOM 与接线（契约 §1）

- 工作区：`<WORKSPACE>`（Windows / PowerShell / Asia-Shanghai）
- 契约：`competition/evidence/2026-10-27-battery-video-visit/CONTRACTS/BATTERY-CHAIN-CONTRACT.md` §1
- 上位审计：`competition/evidence/2026-10-27-real-capability-app/hardware/BATTERY-AUDIT.md` §3
- 状态：**BOM 与接线是“接线方案”，本期没有采购实物、没有接线、没有测量**（见 `REPORT.md`）。
  任何读数/百分比都不能在本期出现；接线完成后按 `BENCH-CALIBRATION.md` 验收。

## 0. 一句话结论（逐台）

| 设备（deviceId） | 板卡 / 供电 | 是否支持电量 | 本期固件行为 |
|---|---|---|---|
| `esp32-kitchen` | 正点原子 DNESP32S3，USB/固定供电 | **不支持**（无电池、无分压、ADC1 已被 MQ-2/MQ-5 占用） | `NODE_BATTERY_ADC_CHANNEL=-1` → **不输出 `battery` 字段**；APP 显示“固定供电，无电池电量数据” |
| `esp32-bath` | DNESP32S3，USB/固定供电 | **不支持** | 同上（`-1`，不输出 `battery`） |
| `dayu200-living` | DAYU200（RK3588），电源适配器 | **不支持**（`/sys/class/power_supply` 为空；系统 BatteryService 是模拟值） | 不涉及 ESP32 固件；**系统 `capacity: 11` 不是真实电量，禁止展示** |
| `esp32-sos` | 独立 ESP32-S3（COM8，MAC `30:30:f9:08:76:84`），当前 USB 供电 | **可电池化（推荐）**：按钮 GPIO4、蜂鸣器 GPIO5、GPIO6=Flash 禁用 → 用 GPIO2/ADC1_CH1 | `NODE_BATTERY_ADC_CHANNEL=2`（profile 已设）→ 输出 `battery`，但**当前无实物 → valid=false, mv=null, reason=OUT_OF_RANGE/UNSTABLE**，绝不报假电压 |
| `esp32-node-wearable` | ESP32-S3 + YED M100；ESP32 由 USB/充电宝，M100 独立 5~12V | **可电池化**：按钮 GPIO4、蜂鸣器 GPIO5、UART1 17/18、GPIO6/19/20/26-37 禁用 → 用 GPIO2/ADC1_CH1 | Kconfig 默认 `NODE_BATTERY_ADC_CHANNEL=2` → hb 帧带 `battery`，同样**未接实物 → valid=false** |
| `esp32-sos-isolated-test` 等未登记节点 | 无实物台账 | 不适用 | 后端对未登记设备不生成电量来源；不得显示电量 |

> 规则：**只有“接了电池 + 分压 + ADC 采样”的设备才输出 `battery`。** 固定供电设备不输出该字段
> （契约 §2 选定实现：不输出，APP 依据设备台账判定固定供电）。

## 1. BOM（每台“电池设备”一套；esp32-sos / esp32-node-wearable 各一套）

| # | 物料 | 精确型号 / 规格 | 数量 | 采购要点 | 用途 |
|---|---|---|---|---|---|
| 1 | 1S 锂离子电池（带保护板） | 3.7V（满充 4.2V / 放空 3.0V），1000–2000mAh，**JST-PH 2.0** 插头，内置过充/过放/过流保护（DW01+8205A 类） | 1 | 必须有保护板；**不要买无保护裸电芯**；插头型号与 TP4056 板匹配 | 供电 + 被测量对象 |
| 2 | USB-C TP4056 充电+保护模块 | 5V 输入，**1A** 充电电流（Rprog=1.2kΩ），板载 DW01 保护，带 USB-C 座 | 1 | 要“带保护”的版本（6 脚：B+/B-/OUT+/OUT-/IN+/IN-） | 充电与电池保护 |
| 3 | 5V 升压模块 | **MT3608**（2A 版）或等效 3.0–4.2V→5V 升压 | 1 | 输出必须实测 5.0±0.2V；带可调电位器需先调好再接入板子 | 3.0–4.2V → 5V 给 ESP32-S3 板 5V 输入 |
| 4 | 金属膜电阻 100kΩ 1% | 1/4W，色环 1003 | 2 | **R1、R2 同批次同精度**（分压比误差直接影响 mV） | 分压 R1/R2（100k/100k → 2:1） |
| 5 | 陶瓷电容 100nF 50V | X7R 或 C0G，直插/0603 均可 | 1 | 靠 ADC 引脚放置 | 分压点对 GND 滤波 |
| 6 | 电阻 1kΩ 1% | 1/4W | 1 | 建议保留（限流/防探针误碰） | 分压点 → ADC 引脚串联 |
| 7 | 万用表（或 2 位小数电池电压表头） | 直流 20V 档，分辨率 ≤10mV，精度 ≤0.5% | 1 | 校准必须用**同一块**表 | 两点/多点校准 + 放电验收 |
| 8 | 杜邦线 / 焊接耗材 | 24–26AWG 硅胶线、热缩管、焊锡 | 若干 | 电池侧焊点必须做绝缘 | 接线 |
| 9 | （可选）电池盒 / 3D 打印壳 | 1S 18650 或软包电池座 | 1 | 随身设备要防短路 | 机械固定 |

> 成本量级：约 ¥25–45/台（电池 ¥10–20、TP4056 ¥3–5、MT3608 ¥2–4、电阻电容 ¥2、线材 ¥3）。
> **不采购**：任何“电量显示模块/库仑计”（如 MAX17048）本期不需要；不要用 USB 电压表冒充电量。

## 2. 接线表（以 `esp32-sos` 为例；`esp32-node-wearable` 完全相同，仅 ADC 引脚按板核对）

ADC 引脚选择：**GPIO2 = ADC1_CH1**（首选）；备选 **GPIO8 = ADC1_CH7**。
esp32-sos 上 GPIO4=按钮、GPIO5=蜂鸣器、**GPIO6=16MB Flash 的 SPI flash 脚（严禁使用）**、19/20=USB、
0/3/45/46=strapping；GPIO2/GPIO8 均空闲。**接线前必须用万用表/原理图复核排针确实引出。**

| 从 | 到 | 线/器件 | 说明 |
|---|---|---|---|
| 电池保护板 **OUT+** | R1 一端 | 导线（红） | 电池“实际可测电压”点（保护板之后） |
| R1 另一端 | 分压节点 **A** | 焊接 | — |
| 节点 A | R2 一端 | 焊接 | — |
| R2 另一端 | **GND** | 导线（黑） | **必须与 ESP32-S3 GND 共地** |
| 节点 A | 100nF 一端 | 陶瓷电容 | 另一端接 GND（就近滤波） |
| 节点 A | 1kΩ 一端 | 电阻 | 1kΩ 另一端 → **GPIO2（ADC1_CH1）** |
| 电池 OUT+ | MT3608 **IN+** | 导线 | 升压输入 |
| 电池 OUT− | MT3608 **IN−** | 导线 | 共地 |
| MT3608 **OUT+（5V）** | 板 **5V** 输入脚 | 导线 | 给 ESP32-S3 板供电（不要接 3V3！） |
| MT3608 **OUT−** | 板 **GND** | 导线 | 共地 |
| TP4056 **B+** | 电池 **+** | 导线 | 充电 |
| TP4056 **B−** | 电池 **−** | 导线 | 充电 |
| TP4056 **OUT+** | MT3608 **IN+**（与电池 OUT+ 同点） | 导线 | 充放电共用保护 |
| TP4056 **OUT−** | GND | 导线 | 共地 |
| USB-C | TP4056 USB-C | — | 仅充电时插入 |

带 100nF + 1k 的示意（单位 Ω/F）：

```
  BAT+ ──[R1 100k]──┬──[R2 100k]── GND
                    │
                    ├──[100nF]── GND
                    │
                    └──[1k]────── GPIO2 (ADC1_CH1)
```

## 3. 分压与 ADC 计算（必读）

ESP32-S3 的 ADC **只有 ADC1（GPIO1–GPIO10 = CH0–CH9）可与 Wi-Fi/4G 同时使用**；ADC2（GPIO11–GPIO20）
在 Wi-Fi 开启时不可用，**禁止使用 ADC2**。ADC1 在 `ADC_ATTEN_DB_12`（12 dB 衰减）下满量程约 **0–3.1V**
（v5.1 实测约 0–3100mV；固件以 `ref_mv=3100` 线性近似 + 两点校准修正）。

分压公式（R1 接电池、R2 接 GND，节点 A 进 ADC）：

```
Vadc = Vbat × R2 / (R1 + R2)
R1 = R2 = 100kΩ  ⇒  Vadc = Vbat / 2
```

| 电池电压 | 分压后入 ADC | 是否在 0–3.1V 内 | 备注 |
|---|---|---|---|
| 3.00V（放空） | 1.500V | ✅ | 有效范围下界 2500mV 对应 1.25V |
| 3.50V（低电阈值） | 1.750V | ✅ | `NODE_BATTERY_LOW_MV=3500` |
| 3.70V（标称） | 1.850V | ✅ | — |
| 4.20V（满充） | 2.100V | ✅ | 余量 1.0V |
| 4.35V（有效上界） | 2.175V | ✅ | `NODE_BATTERY_MAX_MV=4350` |
| 误接 5V USB | 2.500V | ✅ 但**禁止** | 不能把 USB 5V 当电量；分压点只接电池 |

- 分压电流：4.2V / 200kΩ ≈ **21µA**，可常开；长期佩戴场景可换 1MΩ 级并加采样使能 MOS（本期不需要）。
- 2S 方案（6.0–8.4V）：`R1=200kΩ / R2=100kΩ`（3:1）→ 8.4V→2.8V；并改
  `NODE_BATTERY_DIVIDER_NUM=3 NODE_BATTERY_DIVIDER_DEN=1`。
- 两点校准公式（固件实现于 `battery_logic.c`）：`battery_mv = adc_pin_mv × (R1+R2)/R2 × GAIN/1000 + OFFSET`。

## 4. 禁止项（硬性）

1. **禁止电池正极直接接 ADC 引脚**（4.2V > 3.1V 量程，且会损伤引脚）。
2. **禁止使用 ADC2（GPIO11–GPIO20）**：Wi-Fi/4G 开启时不可用。
3. **禁止复用 MQ-2/MQ-5 通道**（厨房 CH5/CH6）；固件已在编译期 `#error` 拦截。
4. **禁止使用 GPIO6**（esp32-sos/16MB Flash 板的 SPI flash 脚）、GPIO19/20（USB）、GPIO26–37（Flash/PSRAM）。
5. **禁止把 USB 5V、充电宝输出电压、`csq`（信号质量）、Wi-Fi RSSI 当电量**；`battery.source` 只能是 `"battery"`。
6. **禁止不接分压就打开 `NODE_BATTERY_ADC_CHANNEL` 上线**：会读到浮空噪声；固件会判 `valid=false`，
   但不应把“未接硬件”的设备当成电池设备部署。
7. **禁止未标定就显示百分比**：`NODE_BATTERY_CALIBRATED=n` 时固件 `percent=null`，
   APP 必须显示“未标定”，不得换算/四舍五入成百分比。
8. **禁止 3.3V 直供 5V 引脚**：MT3608 输出必须实测 5.0V 再接入（3.7V 电池板子的 5V 脚不能直接接电池）。

## 5. 接线后自检（上电前/后各一次）

上电前（万用表，电池接着但不接板）：
1. 节点 A 对 GND 电压 = 电池电压 ÷ 2（±1%），例如 4.00V → 2.00V。
2. 节点 A 对 GND 无短路（电阻 >100kΩ）。
3. 电池 OUT+ 对 GND 电压 = 电池实测电压。
4. MT3608 输出（先空载调好）= 5.0±0.2V。

上电后（串口日志，无需烧录也算“接线自检”）：
5. 启动日志出现 `电池采样启用: CH2 分压 2:1 校准=否(percent=null) ...`。
6. 上报 JSON 出现 `"battery":{"source":"battery","present":true,"valid":true,"mv":<接近万用表读数>,...}`；
   万用表与 `mv` 误差 ≤ ±50mV。
7. 断开分压（拔 R1 或拔电池）→ JSON 变成 `"valid":false,"mv":null,"percent":null,"reason":"..."`，
   **不是 0%**，也不是上一个旧值。

## 6. 接入前必须核对的现场事实（NOT TESTED）

本轮**没有**接线、没有开串口、没有烧录，以下都是待现场核对项：

- [ ] esp32-sos 板 GPIO2 是否真的引出到可用排针（板型存在多种变体）。
- [ ] esp32-node-wearable 板 GPIO2 是否被 M100 的 UART/电源线占位；GPIO8 作为备选是否引出。
- [ ] 电池保护板 OUT+/OUT− 与 TP4056 B+/B− 的极性与插头定义（不同厂家红黑顺序可能相反）。
- [ ] MT3608 空载输出电压（必须 5.0V）与纹波是否会让 ESP32-S3 复位。
- [ ] 分压节点 A 在 Wi-Fi/4G 发射瞬间的抖动幅度（应 <300mV，超了会被判 `UNSTABLE`）。
