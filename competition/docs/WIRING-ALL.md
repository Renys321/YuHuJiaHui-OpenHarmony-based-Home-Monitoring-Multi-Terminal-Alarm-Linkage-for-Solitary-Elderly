# 全项目接线图（厨房 / 卫生间 / 客厅 / DAYU200 / 随身 SOS）

> 依据：`firmware/docs/NODES.md`（已确认引脚）、`southbound/README.md` §4（DAYU200 J9903 实测）、
> `esp32-node-wearable/WIRING.md`（随身 SOS）。未实测项在表中标注。
>
> 通用规则：
> 1. 所有外设与主控**必须共地**；
> 2. 任何模块输出在进 GPIO 前确认 **≤ 3.3 V**（5V 输出必须分压/电平转换）；
> 3. MQ-2 / MQ-5 用**独立 5 V / ≥1 A** 供电（加热丝约 300 mA），不得由 3.3V 引脚供电；
> 4. 接线/插拔**先断电**。

---

## 1. 厨房 ESP32-S3（DNESP32S3，deviceId=esp32-kitchen）

| 信号 | ESP32-S3 引脚 | 外设侧 |
|---|---|---|
| AHT20 数据 SDA | **IO4**（I2C1） | AHT20 SDA，VCC→3V3 |
| AHT20 时钟 SCL | **IO5**（I2C1） | AHT20 SCL |
| MQ-2 模拟量 | **IO6 = ADC1_CH5** | MQ-2 AO，先经 **2k/1k 分压（÷3）** |
| MQ-5 模拟量 | **IO7 = ADC1_CH6** | MQ-5 AO，先经 **2k/1k 分压（÷3）** |
| PIR 人体 | **IO38**（输入） | PIR OUT（SR312 类，高=有人） |
| 门磁 | **IO37**（仅输入，内部上拉） | 干簧管常开 NO，另一端 GND；水漏取消 |
| 实体求助键 | 无 GPIO（XL9555 **P1_7**） | 板载 KEY0（低=按下） |
| 蜂鸣器 | 无 GPIO（XL9555 **P0_3**） | 板载蜂鸣器（低有效） |
| 本地语音 I2S | MCLK=**IO3** / BCLK=**IO46** / LRCK=**IO9** / DOUT=**IO10** / DIN=**IO14** | 板载 ES8388（DIN 为 ADC 数据） |
| 功放使能 | 无 GPIO（XL9555 **P0_2**） | 板载功放 |
| 告警 LED | **IO1**（低电平点亮） | 板载用户 LED |
| 5V / GND | 板载 5V 排针 | MQ-2、MQ-5 模块 VCC/GND |

```text
MQ-2 AO ──2k(1k+1k)──┬── IO6 (ADC1_CH5)
                     └1k── GND          MQ-5 AO ──2k──┬── IO7 (ADC1_CH6)
                                                       └1k── GND

AHT20 SDA ── IO4        AHT20 SCL ── IO5        PIR OUT ── IO38
AHT20 VCC ── 3V3        AHT20 GND ── GND        PIR VCC ── 3V3/5V(按模块)，GND 共地

门磁：干簧管一端 ── IO37，另一端 ── GND
KEY0/蜂鸣器/功放：板载经 XL9555(I2C0 IO41/42) 控制，不接排针
ES8388 ADC：板载咪头 → ES8388 → DIN=IO14（原门磁脚，必须让出）
```

> 禁止：门磁再使用 IO14（已改板载咪头 DIN）；插 P2 摄像头（OV_D0/D1=IO4/5、OV_D2=IO6 冲突）；
> 把 MQ-5 接回 IO9（I2S LRCK 占用）。

---

## 2. 卫生间 ESP32-S3（DNESP32S3，deviceId=esp32-bath）

| 信号 | ESP32-S3 引脚 | 外设侧 |
|---|---|---|
| AHT20 SDA / SCL | **IO4 / IO5**（I2C1） | AHT20，VCC→3V3 |
| PIR 人体 | **IO36**（仅输入脚） | PIR OUT，电平 ≤3.3V |
| 门磁 | **IO37**（仅输入，内部上拉） | 干簧管 NO，另一端 GND；水漏取消 |
| 实体求助键 | **IO15**（内部上拉，低=按下） | 按键另一端 GND |
| 蜂鸣器 | 无 GPIO（XL9555 **P0_3**） | 板载蜂鸣器（低有效） |
| 本地语音 I2S | MCLK=IO3 / BCLK=IO46 / LRCK=IO9 / DOUT=IO10 / DIN=IO14 | 板载 ES8388（DIN 为 ADC 数据） |
| 功放使能 | 无 GPIO（XL9555 **P0_2**） | 板载功放 |
| 告警 LED | **IO1**（低有效） | 板载用户 LED |
| 水漏（取消） | — | 不再使用 IO37，IO37 已改门磁 |

```text
SOS 按键：一端 IO15，另一端 GND
PIR OUT ── IO36        AHT20 SDA/SCL ── IO4/IO5        LED ── IO1
门磁：一端 IO37，另一端 GND      ES8388 ADC DIN ── IO14（板载咪头）

水漏取消：IO37 已用于门磁，不要再接水漏
```

> 不要用 IO35 做 SOS（仅输入脚、内部上拉不可靠，会误触发长鸣）；门磁不得再用 IO14。

---

## 3. 客厅候选板（Xnv i ESP32-S3 N16R8，未部署）

| 信号 | 引脚 | 外设侧 |
|---|---|---|
| DHT11 DATA | **IO11**（单总线） | DHT11 I/O，**4.7k–10k 上拉到 3V3** |
| PIR 人体 | **IO4** | PIR OUT（电平未实测） |
| 门磁 | **IO5**（OPEN_LEVEL=1） | 干簧管（NO/NC 类型未实测） |
| 求助键 | **IO6**（内部上拉，低=按下） | 按键另一端 GND |
| 告警 LED | **IO1**（该板是否有灯未实测） | — |
| 蜂鸣器/语音 | 无 | 该板没有 XL9555/ES8388 |

```text
DHT11 DATA ── IO11 ──[4.7k–10k]── 3V3
PIR OUT ── IO4     门磁：一端 3V3、另一端 IO5（NO 接法）     SOS：IO6 ── GND
```

---

## 4. DAYU200（RK3568）扩展口 J9903（P101-2x10SGF01，20Pin）

| J9903 脚 | 信号 | 用途 | sysfs / 设备 |
|---|---|---|---|
| 5 | GPIO3_C5 | 红外人体 #1 | **gpio 117** |
| 12 | GPIO3_C2 | 红外人体 #2 | **gpio 114** |
| 15 | GPIO0_D5 | 门磁 | **gpio 29** |
| 2 | GPIO3_B2 (UART4_TX) | 求助按钮（需 pinmux 为 GPIO） | **gpio 106** |
| 6 | SARADC_VIN4 | 燃气 MQ-2 | `/sys/bus/iio/.../in_voltage4_raw` |
| 8 | SARADC_VIN5 | 烟雾 MQ-5 | `in_voltage5_raw` |
| 11 / 13 | I2C3_SCL / SDA | 温湿度 SHT30 | `/dev/i2c-3`，地址 `0x44` |
| 7 | PWM0_M0 | 蜂鸣器 | pwmchip |
| 16 / 19 / 20 | 3V3 / 5V / 12V | 供电 | — |
| 9 | GPIO0_C0 | ⚠️ 已被 work 灯占用，**勿用** | gpio 16 |

```text
PIR1 OUT ── J9903-5  (GPIO3_C5, gpio117)      PIR2 OUT ── J9903-12 (GPIO3_C2, gpio114)
门磁 ───── J9903-15 (gpio29)                  SOS ───── J9903-2  (gpio106)
MQ-2 AO ── J9903-6  (SARADC_VIN4)             MQ-5 AO ── J9903-8 (SARADC_VIN5)
SHT30 SCL ─ J9903-11, SDA ─ J9903-13          I2C3 地址 0x44
```

当前 `/data/homemon/homemon.conf` 实际配置：

```ini
motion_gpio=117,114
motion_active_high=1
door_gpio=-1
button_gpio=-1
buzzer_gpio=-1
gas_adc_ch=4
smoke_adc_ch=5
```

> 说明：门磁/按钮/蜂鸣器当前为 `-1`（未接）；PIR 两路已启用并自检通过。

---

## 5. 随身 SOS（ESP32-S3-DevKitC-1 + YED M100MG-B1 4G DTU）

| 信号 | ESP32-S3 | 外设侧 |
|---|---|---|
| 求助按钮 | **GPIO4**（内部上拉） | 按钮另一端 **GND**，按下=低 |
| 蜂鸣器 I/O | **GPIO5**（高=响） | 蜂鸣器模块 I/O；VCC→3.3V；GND→GND |
| UART1 TX | **GPIO17** | → M100 **RXD** |
| UART1 RX | **GPIO18** | ← M100 **TXD** |
| GND | GND | **与 M100 GND 共地**（必须） |
| M100 供电 | 独立 **5–12 V** | 禁止用 ESP32 的 3.3V/5V 排针给 M100 供电 |

```text
按钮：GPIO4 ── 按钮 ── GND
蜂鸣器：GPIO5 ── I/O；VCC ── 3V3；GND ── GND
ESP32 GPIO17(TX) ──→ M100 RXD
ESP32 GPIO18(RX) ←── M100 TXD
ESP32 GND ──────── M100 GND ──── M100 电源负极
```

> 禁用：GPIO6（Flash）、GPIO19/20（USB）、GPIO26–32（Flash）；本工程未开 PSRAM，GPIO33–37 可用（IO37 现为门磁）。
> 固件对误配有编译期检查。

---

## 6. MQ-2 / MQ-5 分压（两种板子通用）

```text
MQ AO ── 2k(可用 1k+1k 串联) ──┬── ADC 引脚（厨房 IO6/IO7；DAYU J9903-6/8）
                               │
                              1k
                               │
                              GND
```

- 分压中点 = AO × 1k/(2k+1k) = **AO ÷ 3**；
- ADC 衰减 `ADC_ATTEN_DB_12`（满量程≈3.1–3.3V）；
- 标定未做，只上报 0–4095 原始值，**不得写 ppm/浓度**。

---

## 7. 冲突与禁用清单（改线前必看）

| 引脚 | 冲突 |
|---|---|
| IO4 / IO5 | 厨房/卫生间 AHT20；同时是 P2 摄像头 OV_D0/D1 → **不能插摄像头** |
| IO6 | 厨房 MQ-2；同时是摄像头 OV_D2 → 不能插摄像头 |
| IO9 | 语音 I2S LRCK；曾是 MQ-5（ADC1_CH8）→ MQ-5 必须走 IO7 |
| IO14 | 板载咪头 ES8388 ADC DIN；门磁已改 IO37，不得再占用 |
| IO3 / IO10 / IO46 | 语音 I2S，不得复用普通 GPIO |
| IO35 | 仅输入、上拉不可靠 → 禁作 SOS |
| IO37 | 仅输入，现用于门磁（水漏取消） |
| DAYU J9903-9 | gpio16 已被 work 灯占用 |

## 8. 上电后快速核对

1. 厨房/卫生间：AHT20 温湿度读数有效、PIR 挥动手有活动计数、门磁开合翻转；
2. 厨房：KEY0 按一次应产生 SOS（不要带电短接）；
3. DAYU200：`status.json` 的 `sensors.motion.supported=true`、挥动 PIR 后 `countToday` 增加；
4. 随身：按按钮蜂鸣器响、板端/云端出现 `MANUAL_SOS`；
5. 板载咪头：串口 `beep on` → `mictest 5` → `beep off`，对比安静/蜂鸣 RMS；再 `micupload`
   验证 4 s 上传与网关回执。蜂鸣只证明近场通路，不等于语音识别率。

## 板载 KEY1：AI 语音提问

- KEY1 = XL9555 P1_6（0x40，低电平按下），短按触发 4 秒提问录音；
- 不产生 SOS、不新建告警；回答只播当前房间音箱。
