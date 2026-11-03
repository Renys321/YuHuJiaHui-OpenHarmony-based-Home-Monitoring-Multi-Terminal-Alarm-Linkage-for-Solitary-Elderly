# 板载 LED 电路证据（ALIENTEK DNESP32S3）

调查时间：2026-10-26 20:00–20:20。调查方式：本地只读检索 + 官方仓库/官方指南公开资料 + 本项目历史板级记录；最终以**本任务在两块真实板上的实际亮灭观察**为准（见 REPORT 的验证章节）。

## 1. 结论

| 项 | 事实 | 依据 | 置信度 |
|---|---|---|---|
| 用户 LED 位号 | 原理图符号 `LED`（厂商 IO 分配表/固件称 LED1） | 官方原理图 V1.2 `DEVICE1.SchDoc`、IO pin allocation table、BSP `led.h` | 高 |
| 网络/引脚 | 网络 `LED` + `IO1`；模组 U1（ESP32-S3-WROOM-1）pin 39 = IO1 | 官方原理图 V1.2 文本层；BSP `led.h` | 高 |
| 类型 | **GPIO 可控单色用户 LED（红色）**，灌电流驱动 | 原理图；指南第 10 章 | 高 |
| 限流电路 | `VCC3.3 → R4 510Ω → LED 阳极 → 阴极 → IO1` | 官方原理图 V1.2 | 高 |
| 有效电平 | **低电平点亮**：IO1 输出低=亮，高=灭 | BSP `led.c` 初始化即置高（灭）；指南“IO1 输出低电平 LED 亮，反之熄灭” | 高 |
| 上电默认 | 厂商 `led_init` 先把 IO1 置高（灭）；本固件启动也主动置灭 | BSP `led.c`；本任务固件 | 高 |
| 第二颗 LED | `PWR` 电源指示灯（蓝色），`VCC3.3 → R5 510Ω → PWR → GND`，**只要通电就亮，不可编程** | 官方原理图 V1.2 | 高 |
| GPIO1 冲突 | 无：ADC 电位器走 IO8/ADC1_CH7；摄像头/触摸/SD/XL9555/USB/LCD 均不占 IO1 | 官方 IO 分配表 + 原理图；本项目现有接线也确认 | 高 |
| 板版本差异 | 公开资料只有 V1.2 原理图；**V1.0↔V1.4 的 LED 差异无公开数据（UNKNOWN）**。本项目 2026-10-20 记录引用的是 `ATK_DNESP32S3_V1.4.pdf`，其原文当前不在本机 `F:\ESP`，公开仓库亦无 V1.4 | 本地检索 + 官方仓库 | 版本差异 UNKNOWN，但 IO1=LED 在两块**实物板**上已由本任务实测确认 |

## 2. 官方来源（公开资料，按只读证据引用）

- 官方仓库 `openedv/ATK-DNESP32S3-Board`：
  - `2_examples/1_ESP_IDF/1_basic_routines/01_led/components/BSP/LED/led.h`
    - `#define LED_GPIO_PIN    GPIO_NUM_1`
    - `enum GPIO_OUTPUT_STATE { PIN_RESET, PIN_SET };`
    - `#define LED(x) do { x ? gpio_set_level(LED_GPIO_PIN, PIN_SET) : gpio_set_level(LED_GPIO_PIN, PIN_RESET); } while(0)`
    - `#define LED_TOGGLE() do { gpio_set_level(LED_GPIO_PIN, !gpio_get_level(LED_GPIO_PIN)); } while(0)`
  - `.../BSP/LED/led.c`：`mode = GPIO_MODE_INPUT_OUTPUT; pull_up_en = GPIO_PULLUP_ENABLE; pin_bit_mask = 1ull << LED_GPIO_PIN;`，初始化后 `LED(1);  /* 关闭LED */` —— 即**高电平=灭**。
  - `1_docs/1_sch/ATK_DNESP32S3 V1.2.pdf`（公开的唯原理图版本）：sheet `DEVICE1.SchDoc` 中 `VCC3.3 → R4 510R → LED(RED) → 网络 LED/IO1`；另 `PWR(BLUE) → R5 510R → GND`；sheet `A4 CORE.SchDoc` 模组 U1 pin 39 = IO1。
  - `1_docs/DNESP32S3 board IO pin allocation table.xlsx`：IO1 行 = `LED1 / LED0 / N / LED`（厂商对同一 LED 的命名）。
- 《DNESP32S3 使用指南-IDF 版》第 10 章（公开镜像）：明确“IO1 被用来连接 LED 的负极”“IO1 输出低电平时 LED 亮起，反之熄灭”。

## 3. 本项目此前的板级记录（与官方资料一致，但当时未实现）

- `competition/docs/evidence/2026-10-20-kitchen-esp32-node-acceptance.md:8,23`：DNESP32S3 官方资料含 `led.h`；`LED = IO1 | led.h：LED_GPIO_PIN GPIO_NUM_1`。
- `competition/docs/evidence/2026-10-20-kitchen-esp32-node-audit.md:45`：IO1 = LED1；当时曾因“MQ-2 计划接 GPIO1”判定冲突，后来 MQ-2 改到 IO6/ADC1_CH5、MQ-5 改到 IO7/ADC1_CH6，**IO1 已空闲**。
- 上一份 `2026-10-26-local-alarm-voice-closure/REPORT.md` 写“未确认可编程 LED”属**当时未查证原理图**的保守结论；本任务依据官方原理图/BSP/指南 + 两块实物板实测，**更新为：存在且可编程，GPIO1、低电平点亮**。

## 4. 不能当作证据的说法

- 电源灯 `PWR`（蓝）不是用户灯：它直接接 3.3V/GND，不受 GPIO 控制；实现前必须先区分用户红灯与电源蓝灯。
- 不能用“某块通用 ESP32-S3 板上有 RGB 灯”（如 COM8 的 S3-N16R8 板）推断 DNESP32S3；两者不是同一板型。
- 未取得 V1.4 原理图原文，因此**不声称** V1.0/V1.2/V1.4 全部版本一致；实际交付以本次两块实物板（均已实测亮灭）为准。
