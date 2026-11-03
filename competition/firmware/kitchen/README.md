# 厨房节点 `esp32-kitchen`

> 本工程 = 共享固件组件 + 厨房专用配置。源码不在本目录：`../../common/components/elder_node/`。
> 三节点总览、供电与共因风险、烧录安全步骤见 [`../../docs/NODES.md`](../../docs/NODES.md)。

## 1. 用途

厨房是**燃气与烟雾风险**的房间，节点承担：

| 能力 | 实现 | 告警类型 |
|---|---|---|
| 燃气（LPG/天然气）风险 | MQ-5 模拟量 → ADC1_CH6 | `GAS`（优先级最高） |
| 烟雾风险 | MQ-2 模拟量 → ADC1_CH5 | `SMOKE` |
| 温湿度异常 | AHT20（I2C1，CRC + 量程校验） | `CLIMATE` |
| 长时间无活动 | PIR（GPIO38） | `NO_MOTION` |
| 门开/关事件 | 干簧管（IO2） | 事件型，不进告警优先级 |
| 主动求助 | 板载 KEY0（XL9555 `P1_7`） | `MANUAL_SOS`（最高） |
| 本地提醒 | 蜂鸣器（XL9555 `P0_3`）+ 中文语音（ES8388）+ LED（IO1） | — |

**不承担**：水漏（`WATER_GPIO=-1`，IO37 预留）、摄像头、跌倒识别。
节点**不实现 MQTT**：它把与主控 `homemon` 同字段的 JSON 行通过 TCP 推给 PC 上的
`mqtt_bridge.js`（`:9101`），由网关负责上云。

## 2. 身份

| 项 | 值 |
|---|---|
| `deviceId` | `esp32-kitchen` |
| `room`（上报房间名） | 厨房 |
| 云端主题 | `home/esp32-kitchen/status` |
| 板卡 | ALIENTEK DNESP32S3（ESP32-S3，16MB Flash / 8MB PSRAM） |
> 2026-10-31：厨房板已更换，新板 MAC `10:51:db:85:d3:e8`（旧板 `50:78:7d:16:ed:60` 已损坏）。
| 芯片 MAC | `10:51:db:85:d3:e8` ← **烧录前按此核对** |
| 串口（当前分配） | COM14（**会变，不能当身份**；2026-10-31 新板） |
| 在板状态 | 在板运行（2026-10-31 换新板，重新烧录并联网） |
| 构建目录 | `build/`（本目录，已在 `.gitignore` 中忽略） |

## 3. 引脚表

| 信号 | ESP32-S3 引脚 | 外设 |
|---|---|---|
| AHT20 数据 | IO4（I2C1 SDA） | AHT20 模块 `SDA`（VCC 接 3V3） |
| AHT20 时钟 | IO5（I2C1 SCL） | AHT20 模块 `SCL` |
| MQ-2 模拟输出 | IO6 = ADC1_CH5 | MQ-2 模块 `AO`（经 2k/1k **÷3** 分压） |
| MQ-5 模拟输出 | IO7 = ADC1_CH6 | MQ-5 模块 `AO`（经 2k/1k **÷3** 分压） |
| 人体检测 | IO38（输入，高=有人） | PIR 模块 `OUT`（SR312 类） |
| 门磁开关量 | IO2（内部上拉，`OPEN_LEVEL=1`） | 干簧管常开 NO，另一端 GND（**原 IO14 已让给咪头**） |
| 实体求助键 | 无 GPIO —— XL9555 `P1_7` | 板载 `KEY0`（低电平按下） |
| 蜂鸣器 | 无 GPIO —— XL9555 `P0_3` | 板载蜂鸣器（低电平有效） |
| 本地语音 | I2S：MCLK=IO3 / BCLK=IO46 / LRCK=IO9 / DOUT=IO10 / DIN=IO14 | 板载 ES8388 扬声器 + 板载咪头 ADC |
| 功放使能 | 无 GPIO —— XL9555 `P0_2` | 板载功放 |
| 告警指示灯 | IO1（低电平点亮） | 板载用户 LED |

接线要点（详细版见 `../../docs/NODES.md` §3.1）：

- MQ 模块用**独立 5 V / 1 A** 供电，与 ESP32 **共地**；AO 必须分压后才能进 ADC。
- MQ-5 的引脚是 2026-10-26 语音改造后从 IO9 迁到 **IO7** 的，**分压中点也要一起搬**。
  只改代码不改线 → gas 恒 4095（已发生过一次）。
- **不得插入 P2 摄像头**：IO4/IO5 是摄像头 `OV_D0/OV_D1`，IO6 是 `OV_D2`。

## 4. `sdkconfig.defaults` 字段含义

文件：[`sdkconfig.defaults`](sdkconfig.defaults)。这里只列本节点实际写出的项；
`Kconfig.projbuild` 里其余项未写出即取默认值（如 `NODE_ALARM_BENCH_INJECT=n`）。

### 4.1 目标与 Flash

| 字段 | 本节点值 | 含义 |
|---|---|---|
| `CONFIG_IDF_TARGET` | `"esp32s3"` | 目标芯片，必须是 ESP32-S3 |
| `CONFIG_ESPTOOLPY_FLASHSIZE_16MB` / `CONFIG_ESPTOOLPY_FLASHSIZE` | `y` / `"16MB"` | 当前 `sdkconfig` 为 16MB；`partitions.csv` 自定义 factory app **4 MiB @0x10000** |
| `CONFIG_ESP_MAIN_TASK_STACK_SIZE` | `8192` | 主任务栈；共享固件含语音/网络/门磁，需大于默认 3584 |

### 4.2 身份与网关

| 字段 | 本节点值 | 含义 |
|---|---|---|
| `CONFIG_NODE_ID` | `"esp32-kitchen"` | 上报 `deviceId`，决定主题 `home/<deviceId>/status`；**系统内必须唯一** |
| `CONFIG_NODE_ROOM` | `"厨房"` | 上报房间名，北向 APP 的房间标签 |
| `CONFIG_NODE_GW_HOST` | `"10.127.130.179"` | PC 上 `mqtt_bridge.js` 所在主机 IP（DHCP 会变，连不上先查这里） |
| `CONFIG_NODE_GW_PORT` | `9101` | 桥接 `--listen` 端口 |

### 4.3 外设

| 字段 | 本节点值 | 含义 |
|---|---|---|
| `CONFIG_NODE_MOTION_GPIO` | `38` | PIR 输入脚；`-1` 关闭（关闭后 `NO_MOTION` 代码被条件编译整体排除） |
| `CONFIG_NODE_MOTION_DEBOUNCE_CONFIRM` | `2` | PIR 连续 N 次一致才更新活动时间，防抖 |
| `CONFIG_NODE_DOOR_GPIO` | `2` | 门磁输入脚，内部上拉；**不得再用 IO14（板载咪头 DIN）** |
| `CONFIG_NODE_DOOR_OPEN_LEVEL` | `1` | 高电平=开。常开 NO 接 GND 时：磁铁移开=断开=高=开 |
| `CONFIG_NODE_DOOR_CONFIRM_COUNT` | `2` | 连续 N 次一致才确认翻转（采样 1 s/次） |
| `CONFIG_NODE_DOOR_CACHE_MAX` | `8` | 离线未送达门磁事件 FIFO 上限（超限丢最旧） |
| `CONFIG_NODE_DOOR_CACHE_KEEP_SEC` | `300` | 离线事件保留时长，重连后随心跳补传 |
| `CONFIG_NODE_SOS_GPIO` | `-1` | 厨房没有外接 SOS 按键，禁用 GPIO 求助 |
| `CONFIG_NODE_SOS_KEY0_ENABLED` | `y` | 用**板载 KEY0**（XL9555 `P1_7`）作实体求助键；每 100 ms 经 I2C0 读一次 |
| `CONFIG_NODE_SOS_DEBOUNCE_CONFIRM` | `2` | SOS 连续确认次数 |
| `CONFIG_NODE_AHT20_ENABLED` | `y` | 启用 AHT20 温湿度（I2C1） |
| `CONFIG_NODE_DHT11_GPIO` | `-1` | DHT11 与 AHT20 二选一；厨房用 AHT20 |
| `CONFIG_NODE_I2C_SDA_GPIO` / `CONFIG_NODE_I2C_SCL_GPIO` | `4` / `5` | AHT20 所在 I2C1 引脚（板载 XL9555 在 I2C0 的 41/42，两条总线分开） |
| `CONFIG_NODE_BUZZER_XL9555` | `y` | 蜂鸣器走 XL9555 `P0_3`（低有效），不是 GPIO |
| `CONFIG_NODE_BUZZER_GPIO` | `-1` | 用板载蜂鸣器时此项必须 `-1` |
| `CONFIG_NODE_VOICE_ENABLED` | `y` | 启用 ES8388 播放与板载咪头采集（ADPCM 告警音 + 按需 PCM 上传） |
| `CONFIG_NODE_VOICE_VOLUME` | `30` | 功放寄存器音量（0–33）。`0x1E`=30 为 **0 dB**，33 为 +4.5 dB 上限；超 0 dB 可能削顶 |
| `CONFIG_NODE_LED_GPIO` | `1` | 板载用户 LED（DNESP32S3 官方 BSP 为 IO1）；`-1` 关闭 |
| `CONFIG_NODE_LED_ACTIVE_LOW` | `y` | 低电平点亮；若实测相反改为 `n` 重建 |
| `CONFIG_NODE_VOICE_AMP_SETTLE_MS` | `60` | 打开功放后等待多久再送 I2S，避免截头/爆音 |
| `CONFIG_NODE_MIC_PORT` | `9303` | 板载咪头 PCM 上传的网关端口（与 9302 问答、9102 音箱分离） |
| `CONFIG_NODE_MIC_RECORD_SEC` | `4` | 每次告警/命令录音时长（3–5 s），不做常开麦克风 |
| `CONFIG_NODE_MIC_UPLOAD` | `y` | 告警新建时自动录音上传；串口 `micupload` 可手动触发 |
| `CONFIG_NODE_BOOT_BEEP_MS` | `0` | 上电自检鸣响时长；验收后必须保持 0，否则每次开机都响 |

### 4.4 气体告警（2026-10-28 启用）

| 字段 | 本节点值 | 含义 |
|---|---|---|
| `CONFIG_NODE_MQ2_ADC_CHANNEL` | `5` | MQ-2 的 ADC1 通道；**通道号 = GPIO 号 − 1**，CH5 = IO6 |
| `CONFIG_NODE_MQ5_ADC_CHANNEL` | `6` | MQ-5 的 ADC1 通道，CH6 = IO7（语音改造后的迁移位） |
| `CONFIG_NODE_MQ2_ALARM_RAW` | `700` | 烟雾阈值（12-bit 原始 ADC）。**≥4096 视为禁用** |
| `CONFIG_NODE_MQ5_ALARM_RAW` | `900` | 燃气阈值（原始 ADC）。实测基线约 300–460，留约 2 倍余量 |
| `CONFIG_NODE_MQ_CONFIRM_COUNT` | `3` | 连续 3 帧越界才触发（5.5 s/帧 → 约 15 s） |
| `CONFIG_NODE_MQ_HYSTERESIS_RAW` | `20` | 解除需连续 3 帧 < 阈值−20，防抖在阈值附近反复告警 |

> ⚠ 阈值是**工程值，不是标定值**。固件只上报 `0..4095` 原始 ADC（`sensors.gas.raw` /
> `sensors.smoke.raw`），**不做 ppm 换算**。任何对外表述都不得写"浓度"、"ppm"、"燃气安全"。

### 4.5 Wi-Fi

| 字段 | 本节点值 | 含义 |
|---|---|---|
| `CONFIG_NODE_WIFI_SSID` | `"YOUR_WIFI"` | 占位符；真实值由 `firmware/.local/wifi.kitchen.defaults` 覆盖注入 |
| `CONFIG_NODE_WIFI_PASS` | `"YOUR_PASSWORD"` | 占位符；**真实口令不得出现在任何入库文件里** |

注入方式见 `../../docs/NODES.md` §5.1。本文件里的占位符不要改成真值。

### 4.6 判定与上报

| 字段 | 本节点值 | 含义 |
|---|---|---|
| `CONFIG_NODE_REPORT_SEC` | `5` | 上报周期（实测节拍约 5.5 s） |
| `CONFIG_NODE_NO_MOTION_SEC` | `1800` | 无活动阈值 30 分钟；**只表示"长时间未检测到活动"** |
| `CONFIG_NODE_NO_MOTION_REQUIRE_ARM` | `y` | 上电先见到一次有效活动才开始计时，防 PIR 断线常低误报 |
| `CONFIG_NODE_ALARM_REPEAT_SEC` | `300` | 危险持续时的重复提醒限频（stop/ack 后不再重复） |
| `CONFIG_NODE_ALARM_BEEP_SEC` | `10` | **已弃用**（固件不再读取），仅为兼容旧 profile 保留 |
| `CONFIG_NODE_ALARM_CHIRP_ON_MS` / `CONFIG_NODE_ALARM_CHIRP_GAP_MS` / `CONFIG_NODE_ALARM_CHIRP_COUNT` | `200` / `100` / `2` | 告警先响 2 声短提示音（每声 200 ms、间隔 100 ms），蜂鸣停止后才播完整语音 |
| `CONFIG_NODE_ALARM_CHIRP_COUNT_SOS` | `3` | SOS 短提示音 3 声，与 LED 三短闪对应 |
| `CONFIG_NODE_ALARM_VOICE_GAP_MS` | `150` | 最后一声提示音结束到开始播报完整语音的间隔（两者不重叠） |
| `CONFIG_NODE_TEMP_LOW_C` / `CONFIG_NODE_TEMP_HIGH_C` | `5` / `45` | 温度越界阈值（℃） |
| `CONFIG_NODE_RH_LOW` / `CONFIG_NODE_RH_HIGH` | `10` / `90` | 湿度越界阈值（%RH） |
| `CONFIG_NODE_CLIMATE_CONFIRM_COUNT` / `CONFIG_NODE_CLIMATE_CLEAR_COUNT` | `3` / `5` | 越界需连续 3 次**有效**读数；恢复需连续 5 次回到回差带（无效读数不计数、不触发也不解除） |
| `CONFIG_NODE_TEMP_HYST_C` / `CONFIG_NODE_RH_HYST` | `1` / `3` | 恢复回差（阈值±回差带内才算恢复） |

### 4.7 当前禁用项（保留配置以便现场启用）

| 字段 | 本节点值 | 含义 |
|---|---|---|
| `CONFIG_NODE_WATER_GPIO` | `-1` | 水漏 DO；厨房未装。IO37 预留 |
| `CONFIG_NODE_WATER_ACTIVE_LOW` / `CONFIG_NODE_WATER_CONFIRM_COUNT` / `CONFIG_NODE_WATER_CLEAR_COUNT` | `y` / `3` / `3` | 低电平=湿润；连续 3 次湿润才报警；连续 3 次干燥才重新武装 |
| `CONFIG_NODE_BATTERY_ADC_CHANNEL` | `-1` | **固定供电，无电池采样**：固件不输出 `battery` 字段 |
| `CONFIG_NODE_BATTERY_DIVIDER_NUM` / `CONFIG_NODE_BATTERY_DIVIDER_DEN` | `2` / `1` | 分压比 `battery_mv = adc_mv × NUM / DEN`；1S 锂电 100k/100k → 2:1 |
| `CONFIG_NODE_BATTERY_CAL_GAIN_PERMILLE` | `1000` | 两点校准增益（千分比，1000=不修正；`mv = mv × GAIN/1000 + OFFSET`） |
| `CONFIG_NODE_BATTERY_CAL_OFFSET_MV` | `0` | 两点校准偏移（mV，可负） |
| `CONFIG_NODE_BATTERY_LOW_MV` | `3500` | 低电量阈值：`≤` 即 `low=true` |
| `CONFIG_NODE_BATTERY_MIN_MV` / `CONFIG_NODE_BATTERY_MAX_MV` | `2500` / `4350` | 有效范围下界/上界，超界 `valid=false`（OUT_OF_RANGE） |
| `CONFIG_NODE_BATTERY_SAMPLE_SEC` | `30` | 采样周期（秒），主任务内 8 次中位数、样本间 2 ms |

## 5. 用 VSCode 打开 / 构建 / 烧录

### 5.1 打开

- **单节点构建**：`File → Open Folder → <WORKSPACE>\competition\firmware\kitchen`
  `.vscode/settings.json` 已配好 `idf.currentSetup`（ESP-IDF v5.1.6）与 `idf.port = COM4`、`flashType = UART`。
- **看全量源码**：`File → Open Folder → <WORKSPACE>\competition\firmware`
  （在 `common/components/elder_node/` 下改代码，三个节点共享）。

### 5.2 命令行（推荐）

```powershell
# 只构建，不碰串口
powershell -NoProfile -ExecutionPolicy Bypass -File <WORKSPACE>\competition\firmware\tools\build-node.ps1 -Node kitchen

# 首次构建前注入 Wi-Fi（写入 firmware\.local\wifi.kitchen.defaults，自动叠加、不入库）
#   见 ..\..\docs\NODES.md §5.1 的隐藏输入写法

# 烧录（会先只读 chip_id；仍需人工比对 MAC）
... -Node kitchen -Action flash -Com COM4

# 串口监视（Ctrl+] 退出）
... -Node kitchen -Action monitor -Com COM4

# 改配置 / 清理
... -Node kitchen -Action menuconfig
... -Node kitchen -Action fullclean
```

### 5.3 在 IDE 里直接 `idf.py build` 的注意事项

在 `kitchen` 目录里 `idf.py build` 会自动读取本目录的 `sdkconfig.defaults`，
但**不会**叠加 `.local/wifi.kitchen.defaults`，于是编出来的是占位符 Wi-Fi 固件。
需要真 Wi-Fi 时用 `build-node.ps1`，或显式传：

```powershell
idf.py -B build -D "SDKCONFIG_DEFAULTS=sdkconfig.defaults;..\..\.local\wifi.kitchen.defaults" build
```

### 5.4 烧录安全（摘要，完整版见 `../../docs/NODES.md` §5）

1. 只插一块板；`esptool.py --chip esp32s3 -p COM14 chip_id` → 核对 **MAC `10:51:db:85:d3:e8`**。
2. 备份当前 app 分区：`read_flash 0x10000 0x400000 <备份>.bin`（4 MiB，与 `partitions.csv` 的 factory 分区一致）。
3. 优先**只写 app**：`write_flash 0x10000 build\esp32_elder_node.bin`，看到 `Hash of data verified`。
4. **禁止** `erase_flash`（会清 NVS：门磁 `seq` 基线、Wi-Fi 凭据全丢）。
5. 回滚 = 把备份写回 `0x10000`。

### 5.5 板载咪头自检（串口）

正常现场固件即可执行，不需要另刷台架固件。串口命令（115200）：

```text
mictest 5      # 录 5 s，打印 MIC_TEST rms/peak/samples，并恢复播放
beep on        # 打开板载蜂鸣器作为近场声源（不改变告警状态）
mictest 5      # 与安静基线对比 RMS
beep off
micupload      # 录 4 s 上传 PC 网关 9303，串口打印 ASR/answer/error 回执
```

验收要点：`MIC end playback_restored=1`；蜂鸣时 RMS 应明显高于安静值；`micupload`
必须出现 `MIC_UPLOAD #n sent rms=... samples=...`，失败会打印 `MIC_UPLOAD FAIL reason=...`。
蜂鸣器只证明近场拾音通路，不代表真人语音识别率。

## 6. 已知限制 / 未验收项

| # | 限制 | 说明 / 边界 |
|---|---|---|
| L1 | **GAS/SMOKE 从未用真实气体触发验证** | 只验证了"低于阈值不误报"。安全规则禁止明火/放气测试 → 只能宣称"阈值已启用"，不能宣称"能检测到燃气" |
| L2 | MQ-2/MQ-5 **未标定** | 只上报原始 ADC 0–4095；需 24–48 h 老化后复测基线；不得出现 ppm/浓度表述 |
| L3 | app 分区为 4 MiB（`partitions.csv`） | 当前镜像 1,050,016 B / 4,194,304 B（约 25%）；不能沿用旧文档的 1 MiB 说法 |
| L4 | PIR 的 `NO_MOTION` **未现场观察触发（自然超时）** | 配置已开（1800 s + 先武装）；2026-10-31 曾用 30 s 测试配置验证采音触发，验后已恢复 |
| L5 | 门磁扩展字段（`lastCloseTs`/`seq`/`events`）**未公网上报** | 本地已实现并保留；公网只发旧合同两键，否则后端 `INVALID_STATUS`（等 schema v7） |
| L6 | KEY0 与声光（蜂鸣+语音+LED 三短闪）**需一次真实按键确认** | 请人工按键，不要带电短接 IO 模拟；I2C0 读失败时固件不触发也不解除 |
| L7 | 水漏**未安装** | `WATER_GPIO=-1`；IO37 仅预留 |
| L8 | 无电池采样 | `BATTERY_ADC_CHANNEL=-1`，报文无 `battery` 字段（固定供电） |
| L9 | AHT20 读失败时 `climate.ok` 语义 | 报文合同里 `climate` 只有 `tempC/rh/ok`，`ok` 的真实含义是"没有越界告警"，**不是**"本次读数新鲜"；读失败会保留上次值但绝不据此告警 |
| L10 | 不得插 P2 摄像头 | IO4/IO5/IO6 与 `OV_D0/D1/D2` 冲突 |
| L11 | 语音音量 30 = 0 dB | 现场若嫌小，上限只到 33（+4.5 dB），再加会失真；改动即需重新构建烧录 |
| L12 | 门磁**实物线仍接 IO14** | 固件已改 GPIO2；未改线前上报 `door.open=true`，不能作为门磁验收证据 |
| L13 | 真人说“我没事”未验收 | 蜂鸣近场 RMS 与 9303 模拟已通过；必须现场由真人对着板载咪头复测 |

## 7. 相关证据

- 接线与阶段验收：`competition/docs/evidence/2026-10-20-kitchen-esp32-node-acceptance.md`
- PIR 加装方案：`competition/evidence/2026-10-27-voice-led-restore/KITCHEN-PIR-PLAN.md`
- 板载咪头自检与新固件：`competition/evidence/2026-10-31-mic-selftest/`（含 NEW/ROLLBACK BIN 哈希、mictest/micupload 串口日志）
- PIR 刷写记录：`.../KITCHEN-PIR-FLASH-RECORD.md`
- MQ-5 迁移与分压故障诊断：`competition/evidence/2026-10-28-fullchain-health/GAS-MQ5-DIAGNOSIS.md`
- 阈值启用（900/700）：`.../GAS-ALARM-ENABLE-20261028.md`
- 只读硬件审计：`competition/evidence/2026-10-27-real-capability-app/hardware/PIR-DOOR-AUDIT.md`
