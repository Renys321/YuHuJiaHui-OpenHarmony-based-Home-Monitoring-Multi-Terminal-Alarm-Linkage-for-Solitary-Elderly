# 客厅节点 `esp32-living`（候选板，未部署）

> 本工程 = 共享固件组件 + 客厅专用配置。源码不在本目录：`../../common/components/elder_node/`。
> 三节点总览、供电与共因风险、烧录安全步骤见 [`../../docs/NODES.md`](../../docs/NODES.md)。

## ⚠ 先读这一段

客厅节点目前是**候选硬件**，不是已部署节点：

- 板子是 **Xnv i ESP32-S3 N16R8 Type-C（USB 串口 CH343）**，**不是** DNESP32S3；
  因此没有板载 XL9555 IO 扩展、没有 ES8388、没有板载蜂鸣器、`LED=IO1` 这类 DNESP32S3 专属假设**都不成立**。
- 除 DHT11 做过 bench 五连读外，**PIR、门磁、SOS 全部未实测**；门磁极性、PIR 输出电平都未知。
- **从未联网、从未注册设备、从未计入"全屋在线 N/N"**；当前在板固件也不是 `elder-node`（原为 `RGB Demo`）。
- 烧录前必须备份**整片 16 MB**（原 RGB Demo 有整片备份先例），并且要接受"这块板烧坏/写错没有第二块可替换"的事实。

## 1. 用途（规划，非已验收）

作为客厅的**低成本扩展传感节点**，补齐客厅的人体活动、门/窗状态、温湿度与主动求助：

| 规划能力 | 实现 | 当前状态 |
|---|---|---|
| 温湿度 | DHT11 单总线（IO11） | bench 五连读 **PASS**（2026-10-23），未进生产链路 |
| 长时间无活动 | PIR（IO4） | 初始化过，**功能未实测** |
| 门开/关事件 | 干簧管（IO5） | **未接线、类型未知** |
| 主动求助 | 按键（IO6） | **未接、未按** |

**明确不承担**：燃气/烟雾（无 MQ）、温湿度 I2C（无 AHT20）、本地蜂鸣、本地语音；
告警 LED 虽有 `LED_GPIO=1` 配置，但该板 IO1 是什么**未实测**，不能当作已具备能力。

> 因此客厅节点**没有本地声光报警**：一旦告警，只能靠网络上报到网关/APP，
> 现场不会有蜂鸣或语音。这一点必须写进能力说明，不能与厨房/卫生间混为一谈。

另一个必须先决定的问题：**同房间重复能力**。`dayu200-living`（DAYU200 板端 homemon）已经在客厅上报
`motion`/`door`/`climate`。如果再挂一块客厅 ESP32，就形成同房间两套同类数据与两套告警。
在明确"合并 / 替代 / 分工 / 换房间"之前，**不要注册、不要绑定房间**。

## 2. 身份

| 项 | 值 |
|---|---|
| `deviceId`（规划） | `esp32-living` |
| `room`（规划） | 客厅 |
| 云端主题 | 注册后才会出现 `home/esp32-living/status` |
| 板卡 | Xnv i ESP32-S3 N16R8 Type-C，USB 串口 **CH343**，16 MB Flash / 8 MB PSRAM |
| 芯片 MAC | `30:30:f9:08:76:84`（2026-10-23 只读识别**一次**）← 烧录前**重读确认** |
| 串口（当前分配） | COM8 |
| 在板固件 | 原为 `RGB Demo`（且启动时 SHA-256 校验失败仍继续启动）；DHT11 bench 候选曾烧入过 |
| 部署状态 | **未部署**：未配 Wi-Fi、未注册、未绑定房间 |

## 3. 引脚表

| 信号 | ESP32-S3 引脚 | 外设 |
|---|---|---|
| DHT11 数据 | IO11（单总线） | DHT11 模块 `I/O`（VCC 接 **3V3**，DATA 需 **4.7k–10k 上拉**到 3V3） |
| 人体检测 | IO4（输入，高=有人） | PIR 模块 `OUT`（SR312 类，**电平未实测**，必须 ≤3.3 V） |
| 门磁开关量 | IO5（`OPEN_LEVEL=1`） | 干簧管（**NO/NC 类型未实测**） |
| 求助按键 | IO6（内部上拉，按下=低） | 瞬动无源按键，另一端 GND |
| 蜂鸣器 | — | **无**（`BUZZER_XL9555=n`、`BUZZER_GPIO=-1`） |
| 本地语音 | — | **无**（`VOICE_ENABLED=n`） |
| 告警指示灯 | IO1（配置为低电平点亮） | **该板是否有 IO1 指示灯未实测** |

接线规则（严格按此执行，不要"先接上再说"）：

- **DHT11**：VCC 3.3 V（不要接 5 V）、GND 共地、DATA→IO11 且**必须有 4.7k–10k 上拉**、线尽量短。
  已实测：VCC≈3.3 V、DATA 空闲 3.3 V、外部上拉已接。
- **PIR（SR312）**：优先 3.3 V 供电；上电前必须实测 `OUT` 高电平 ≤3.3 V。
  若模块只能 5 V 供电且 OUT 为 5 V → **不得直连 IO4**，需电平转换/分压。
- **门磁**：两线无源触点，不接 VCC。先用万用表通断档测"磁铁靠近/移开"的导通情况：

  | 实测类型 | 接法 | 现行 `OPEN_LEVEL=1` 能否直接用 |
  |---|---|---|
  | 常开 NO（分开导通、靠近断开） | 线1→3V3、线2→IO5 | 可用（门开=高=open） |
  | 常闭 NC（靠近导通、分开断开） | 线1→GND、线2→IO5 + 4.7k–10k 上拉 | **不可直接用**，须改极性或改线 |

- **SOS 按键**：一端 IO6、另一端 GND；必须是常开瞬动按键；不要带电短接 GPIO 模拟按键。
- 12 V 有线水浸探头**不能直连** GPIO（需独立 12 V + 继电器/光耦隔离）；`WATER_GPIO=-1`。

## 4. `sdkconfig.defaults` 字段含义

文件：[`sdkconfig.defaults`](sdkconfig.defaults)。

### 4.1 目标与系统

| 字段 | 本节点值 | 含义 |
|---|---|---|
| `CONFIG_IDF_TARGET` | `"esp32s3"` | 目标芯片 |
| `CONFIG_ESPTOOLPY_FLASHSIZE_16MB` / `CONFIG_ESPTOOLPY_FLASHSIZE` | `y` / `"16MB"` | N16R8 的 16 MB Flash；**但分区表仍是默认单 app 1 MiB**，app 大小上限不变 |
| `CONFIG_ESP_MAIN_TASK_STACK_SIZE` | `3584` 后又被 `8192` 覆盖 | 实际生效 **8192**（本文件写了两次，见 §6 L1） |

### 4.2 身份与网关

| 字段 | 本节点值 | 含义 |
|---|---|---|
| `CONFIG_NODE_ID` | `"esp32-living"` | 注册后才决定主题 `home/esp32-living/status` |
| `CONFIG_NODE_ROOM` | `"客厅"` | 上报房间名 |
| `CONFIG_NODE_GW_HOST` | `"10.127.130.179"` | 当前 PC 上 bridge 所在主机（旧 profile 里的 `10.1.189.200` 是历史网段，已过期） |
| `CONFIG_NODE_GW_PORT` | `9101` | 桥接 `--listen` 端口 |

### 4.3 外设

| 字段 | 本节点值 | 含义 |
|---|---|---|
| `CONFIG_NODE_DHT11_GPIO` | `11` | DHT11 单总线 DATA 脚；`-1` 禁用。启用时不要同时开 AHT20 |
| `CONFIG_NODE_DHT11_BENCH` | `n` | 仅 bench 用（启动后在 WiFi 之前连读 5 次并打印）；生产保持 `n` |
| `CONFIG_NODE_LOCAL_BENCH` | `n` | 仅 bench 用（跳过 WiFi/网关，只轮询 PIR/SOS 打印）；生产保持 `n` |
| `CONFIG_NODE_AHT20_ENABLED` | `n` | 本板用 DHT11，不开 AHT20 |
| `CONFIG_NODE_MOTION_GPIO` | `4` | PIR 输入脚；`-1` 关闭 |
| `CONFIG_NODE_MOTION_DEBOUNCE_CONFIRM` | `2` | PIR 连续确认次数 |
| `CONFIG_NODE_DOOR_GPIO` | `5` | 门磁输入脚 |
| `CONFIG_NODE_DOOR_OPEN_LEVEL` | `1` | 高电平=开；**只适配常开 NO 接法**，接前必须实测类型 |
| `CONFIG_NODE_DOOR_CONFIRM_COUNT` | `2` | 连续 2 次一致才确认翻转 |
| `CONFIG_NODE_DOOR_CACHE_MAX` | `8` | 离线未送达门磁事件 FIFO 上限 |
| `CONFIG_NODE_DOOR_CACHE_KEEP_SEC` | `300` | 离线事件保留时长 |
| `CONFIG_NODE_SOS_GPIO` | `6` | 求助按键 GPIO，内部上拉、低电平按下 |
| `CONFIG_NODE_SOS_DEBOUNCE_CONFIRM` | `2` | SOS 连续确认次数 |
| `CONFIG_NODE_BUZZER_XL9555` | `n` | 本板没有 XL9555，必须为 `n` |
| `CONFIG_NODE_BUZZER_GPIO` | `-1` | **无蜂鸣器** → 无本地声音告警 |
| `CONFIG_NODE_VOICE_ENABLED` | `n` | **无语音**（本板没有 ES8388/I2S 通路） |
| `CONFIG_NODE_LED_GPIO` | `-1` 后又被 `1` 覆盖 | 实际生效 **1**；该板是否有 IO1 指示灯**未实测** |
| `CONFIG_NODE_LED_ACTIVE_LOW` | `y` | 低电平点亮（沿用 DNESP32S3 假设，本板未验证） |

### 4.4 气体通道（禁用）

| 字段 | 本节点值 | 含义 |
|---|---|---|
| `CONFIG_NODE_MQ2_ADC_CHANNEL` / `CONFIG_NODE_MQ5_ADC_CHANNEL` | `-1` / `-1` | 无 MQ 模块 |
| `CONFIG_NODE_MQ2_ALARM_RAW` / `CONFIG_NODE_MQ5_ALARM_RAW` | `4096` / `4096` | ≥4096 = 告警关闭，保持禁用值 |
| `CONFIG_NODE_MQ_CONFIRM_COUNT` / `CONFIG_NODE_MQ_HYSTERESIS_RAW` | `3` / `20` | 保留默认，禁用通道下不生效 |

### 4.5 温湿度阈值

| 字段 | 本节点值 | 含义 |
|---|---|---|
| `CONFIG_NODE_TEMP_LOW_C` / `CONFIG_NODE_TEMP_HIGH_C` | `10` / `40` 后又被 `5` / `45` 覆盖 | 实际生效 **5 / 45 ℃**（注释里"放宽"没有生效，见 §6 L1） |
| `CONFIG_NODE_RH_LOW` / `CONFIG_NODE_RH_HIGH` | `20` / `85` 后又被 `10` / `90` 覆盖 | 实际生效 **10 / 90 %RH** |
| `CONFIG_NODE_CLIMATE_CONFIRM_COUNT` / `CONFIG_NODE_CLIMATE_CLEAR_COUNT` | `3` / `5` | 连续 3 次有效读数越界才报；连续 5 次回带才解除 |
| `CONFIG_NODE_TEMP_HYST_C` / `CONFIG_NODE_RH_HYST` | `1` / `3` | 恢复回差 |

> DHT11 的分辨率是 1 ℃ / 1 %RH、精度较差，阈值过窄会频繁抖动；若要让"放宽阈值"真正生效，
> 需删掉文件后段的重复行——**这属于改配置，需负责人确认**，本 README 不擅自改。

### 4.6 Wi-Fi

| 字段 | 本节点值 | 含义 |
|---|---|---|
| `CONFIG_NODE_WIFI_SSID` | `"YOUR_WIFI"` | 占位符；真实值应写入 `firmware/.local/wifi.living.defaults` |
| `CONFIG_NODE_WIFI_PASS` | `"YOUR_PASSWORD"` | 占位符；**真实口令不得写进任何入库文件** |

### 4.7 判定与上报

| 字段 | 本节点值 | 含义 |
|---|---|---|
| `CONFIG_NODE_REPORT_SEC` | `5` | 上报周期 |
| `CONFIG_NODE_NO_MOTION_SEC` | `1800` | 无活动阈值（30 分钟） |
| `CONFIG_NODE_NO_MOTION_REQUIRE_ARM` | `y` | 先见到一次有效活动才计时（防 PIR 断线常低误报） |
| `CONFIG_NODE_ALARM_REPEAT_SEC` | `300` | 危险持续时重复提醒的限频 |
| `CONFIG_NODE_ALARM_BEEP_SEC` | `10` | **已弃用**（固件不再读取） |
| `CONFIG_NODE_ALARM_CHIRP_ON_MS` / `CONFIG_NODE_ALARM_CHIRP_GAP_MS` / `CONFIG_NODE_ALARM_CHIRP_COUNT` | `200` / `100` / `2` | 提示音编排；本板无蜂鸣器 → **实际不会响** |
| `CONFIG_NODE_ALARM_CHIRP_COUNT_SOS` | `3` | SOS 短提示音声数（与 LED 三短闪对应；本板无蜂鸣器/LED 未验证） |
| `CONFIG_NODE_ALARM_VOICE_GAP_MS` | `150` | 最后一声提示音到语音开始的间隔（无语音，不生效） |
| `CONFIG_NODE_VOICE_AMP_SETTLE_MS` | `60` | 无语音，不生效 |
| `CONFIG_NODE_BOOT_BEEP_MS` | `0` | 上电不鸣 |

### 4.8 水漏 / 电池（禁用）

| 字段 | 本节点值 | 含义 |
|---|---|---|
| `CONFIG_NODE_WATER_GPIO` | `-1` | 无 12 V 水浸探头接入条件（需隔离） |
| `CONFIG_NODE_WATER_ACTIVE_LOW` | `y` | 低电平=湿润（预留参数，禁用时不生效） |
| `CONFIG_NODE_WATER_CONFIRM_COUNT` / `CONFIG_NODE_WATER_CLEAR_COUNT` | `3` / `3` | 湿润/干燥连续确认次数（预留参数） |
| `CONFIG_NODE_BATTERY_ADC_CHANNEL` | `-1` | 固定供电（USB），不输出 `battery` 字段 |
| `CONFIG_NODE_BATTERY_DIVIDER_NUM` / `CONFIG_NODE_BATTERY_DIVIDER_DEN` | `2` / `1` | 分压比（`battery_mv = adc_mv × NUM / DEN`） |
| `CONFIG_NODE_BATTERY_CAL_GAIN_PERMILLE` / `CONFIG_NODE_BATTERY_CAL_OFFSET_MV` | `1000` / `0` | 两点校准增益（千分比）/偏移（mV）；未标定 |
| `CONFIG_NODE_BATTERY_LOW_MV` | `3500` | 低电量阈值（`≤` 即 `low=true`） |
| `CONFIG_NODE_BATTERY_MIN_MV` / `CONFIG_NODE_BATTERY_MAX_MV` | `2500` / `4350` | 有效范围下界/上界 |
| `CONFIG_NODE_BATTERY_SAMPLE_SEC` | `30` | 采样周期（秒） |

## 5. 用 VSCode 打开 / 构建 / 烧录

### 5.1 打开

- **单节点构建**：`File → Open Folder → <WORKSPACE>\competition\firmware\living`
  `.vscode/settings.json` 已配好 `idf.currentSetup`（ESP-IDF v5.1.6）与 `idf.port = COM8`、`flashType = UART`。
- **看全量源码**：`File → Open Folder → <WORKSPACE>\competition\firmware`

### 5.2 构建（**当前只应做到这一步**）

```powershell
# 只构建，不碰串口
powershell -NoProfile -ExecutionPolicy Bypass -File <WORKSPACE>\competition\firmware\tools\build-node.ps1 -Node living
```

构建可用来验证配置与引脚合法性（`voice_pins.h` 的冲突检查在 `VOICE_ENABLED=n` 时不启用，
但 ADC/I2C 组合仍会被 Kconfig 与代码约束）。**构建通过 ≠ 可以烧录**。

### 5.3 烧录前置条件（全部满足前不要烧）

1. `esptool.py --chip esp32s3 -p COM8 chip_id` → 核对 MAC `30:30:f9:08:76:84`（**重读，不要用 10-23 的旧结论**）。
2. 备份**整片 16 MB**（`read_flash 0x0 0x1000000 <备份>.bin`）——原 RGB Demo 有整片备份先例可参照。
3. 门磁 NO/NC 已用万用表实测；PIR `OUT` 电平实测 ≤3.3 V；DHT11 上拉已接；SOS 按键未卡住。
4. 决定房间角色（避免与 `dayu200-living` 同房间重复能力），并准备后端/APP 的注册与绑定动作（**烧录本身不注册**）。
5. PC 当前 WLAN IPv4 与 `CONFIG_NODE_GW_HOST` 一致。

```powershell
# 满足条件后：
... -Node living -Action flash -Com COM8
# 注意：build-node.ps1 只验证"是 ESP32-S3"，MAC 必须人工比对
```

### 5.4 回滚

原厂 `RGB Demo` 整片备份（16,777,216 B，SHA-256 `D73B6DD5…B6FB15`，见
`competition/docs/evidence/2026-10-23-com8-dht11-bench-pass.md`）可整片写回。
在板已是 `elder-node` 候选时，回滚只需写 app：`write_flash 0x10000 <旧 app>.bin`。

## 6. 已知限制 / 未验收项

| # | 限制 | 说明 / 边界 |
|---|---|---|
| L1 | **`sdkconfig.defaults` 曾出现 5 个重复键（已修复）** | 2026-10-28 整理时该文件重复写了 `NODE_LED_GPIO`/温湿度阈值，后值覆盖前值导致"放宽阈值/关闭 LED"不生效。**现已重写为同键仅一次**，构建产物确认为 `LED=-1`、`10–40 ℃`、`20–85 %RH`、栈 3584 |
| L2 | **IO1 LED 未实测** | 后段 `LED_GPIO=1` 生效，但 Xnv i N16R8 上 IO1 是什么、是否有灯、有效电平如何，全部未知 → 可能写空脚或行为相反 |
| L3 | **无本地声光** | 没有蜂鸣器、没有语音、LED 未验证：告警只走网络，现场无提示 |
| L4 | **PIR 未功能验收** | SR312 具体型号/输出电平未实测；仅做过初始化 |
| L5 | **门磁未接线、类型未知** | 现行 `OPEN_LEVEL=1` 只适配常开 NO；接错会长期"门开"或"门关" |
| L6 | **SOS 未接、未按** | 有配置无实物验收；不得宣称具备求助能力 |
| L7 | **未联网/未注册** | 无 Wi-Fi 凭据、无 `deviceId` 注册、无房间绑定、未计入在线数 |
| L8 | **DHT11 只到 bench** | 五连读 PASS 仅证明驱动时序修好；Wi-Fi/上报/长稳未测 |
| L9 | **与 DAYU 同房间重复能力** | `dayu200-living` 已上报 motion/door/climate；未决定分工前不得双挂 |
| L10 | **16 MB Flash ≠ 1 MB app** | 分区表仍是默认单 app 1 MiB（`partitions_singleapp.csv`）；要真正用满 16 MB 需改分区表并重算 |
| L11 | **MAC 只读识别过一次** | `30:30:f9:08:76:84` 来自 2026-10-23 单次 `chip_id`，烧录前必须重读 |
| L12 | 板子在 Windows 上曾枚举为 `Unknown` | 说明 USB/接线可能不稳；烧录前先确认 `USB-Enhanced-SERIAL CH343 (COM8)` 正常出现 |

## 7. 相关证据

- 板卡/芯片识别与当前固件：`competition/docs/evidence/2026-10-23-com8-identification.md`
- 接线方案与固件准备：`competition/docs/evidence/2026-10-23-com8-living-wiring-and-firmware-prep.md`
- DHT11 接线排查与 bench PASS：`competition/docs/evidence/2026-10-23-com8-dht11-bench-pass.md`
- 旧客厅 profile（历史，别用于重建）：`competition/esp32-node/profiles/living.sdkconfig.defaults`、`living-bench.sdkconfig.defaults`
- 同房间重复能力与 APP 能力表问题：`competition/evidence/2026-10-27-real-capability-app/hardware/PIR-DOOR-AUDIT.md`
