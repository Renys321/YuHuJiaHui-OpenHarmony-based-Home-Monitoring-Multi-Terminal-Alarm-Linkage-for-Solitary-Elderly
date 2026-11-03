# 卫生间节点 `esp32-bath`

> 本工程 = 共享固件组件 + 卫生间专用配置。源码不在本目录：`../../common/components/elder_node/`。
> 三节点总览、供电与共因风险、烧录安全步骤见 [`../../docs/NODES.md`](../../docs/NODES.md)。

## 1. 用途

卫生间是**跌倒/长时间滞留/求助**风险最高的房间，也是三节点里**唯一装了实体 SOS 按键**的一块。
节点承担：

| 能力 | 实现 | 告警类型 |
|---|---|---|
| 主动求助 | 实体按键 IO15（内部上拉，按下=低） | `MANUAL_SOS`（最高优先级） |
| 长时间无活动 | PIR（IO36，仅输入脚） | `NO_MOTION` |
| 温湿度异常 | AHT20（I2C1，CRC + 量程校验） | `CLIMATE` |
| 门开/关事件 | 干簧管（IO2） | 事件型，不进告警优先级 |
| 本地提醒 | 蜂鸣器（XL9555 `P0_3`）+ 中文语音（ES8388）+ LED（IO1） | — |

**不承担**：燃气/烟雾（本节点没有 MQ 模块，`ADC_CHANNEL=-1`）、水漏（`WATER_GPIO=-1`，IO37 预留）、摄像头。

卫生间**没有 MQ、没有外接 SOS 按键之外的求助入口**——SOS 按键是该房间最重要的一条物理通道，
它的验收优先级高于任何传感器。

## 2. 身份

| 项 | 值 |
|---|---|
| `deviceId` | `esp32-bath` |
| `room`（上报房间名） | 卫生间 |
| 云端主题 | `home/esp32-bath/status` |
| 板卡 | ALIENTEK DNESP32S3（ESP32-S3，16MB Flash / 8MB PSRAM） |
| 芯片 MAC | `14:c1:9f:42:dd:b4` ← **烧录前按此核对** |
| 串口（当前分配） | COM5（**会变，不能当身份**；2026-10-27 该板曾在 COM4 刷写） |
| 在板状态 | 在板运行（2026-10-27 01:04 起为语音+LED+门磁兼容版） |
| 构建目录 | `build/`（本目录，已在 `.gitignore` 中忽略） |

## 3. 引脚表

| 信号 | ESP32-S3 引脚 | 外设 |
|---|---|---|
| AHT20 数据 | IO4（I2C1 SDA） | AHT20 模块 `SDA`（VCC 接 3V3） |
| AHT20 时钟 | IO5（I2C1 SCL） | AHT20 模块 `SCL` |
| 人体检测 | IO36（**仅输入脚**，高=有人） | PIR 模块 `OUT`（输出必须 ≤3.3 V） |
| 门磁开关量 | IO2（内部上拉，`OPEN_LEVEL=1`） | 干簧管常开 NO，另一端 GND（**原 IO14 已让给咪头**） |
| 实体求助键 | IO15（双向脚，内部上拉） | 瞬动按键：一端 IO15、另一端 GND，按下=低 |
| 蜂鸣器 | 无 GPIO —— XL9555 `P0_3` | 板载蜂鸣器（低电平有效） |
| 本地语音 | I2S：MCLK=IO3 / BCLK=IO46 / LRCK=IO9 / DOUT=IO10 | 板载 ES8388 扬声器 |
| 功放使能 | 无 GPIO —— XL9555 `P0_2` | 板载功放 |
| 告警指示灯 | IO1（低电平点亮） | 板载用户 LED |
| 水漏（**预留，未装**） | IO37（仅输入脚） | 继电器干接点：`COM`→GND、`NO`→IO37；`WATER_GPIO=-1` 当前禁用 |

接线要点：

- **SOS 不要用 IO35**：IO35 是仅输入脚、内部上拉不可靠，实测会误触发长鸣。卫生间用 **IO15**（双向脚）。
- SOS 按键必须是**常开 NO** 触点：一端 IO15、一端 GND。上电后固件必须先观察到一次"松开"才允许触发，
  悬空/常闭/上电即低都不会误报；长按只产生一次求助，松开后重新武装。
- 水漏是**继电器干接点**（无电压），不需要分压，但**当前没有安装、没有验收**；
  启用只需把 `CONFIG_NODE_WATER_GPIO` 从 `-1` 改为 `37`（详见 §4.7）。
- 蜂鸣器与功放共用 XL9555（I2C0 = IO41/IO42，未引到排针）：这是本节点与厨房共享的硬件单点。
  本节点**没有** KEY0——求助只走 GPIO15 实体按键。

## 4. `sdkconfig.defaults` 字段含义

文件：[`sdkconfig.defaults`](sdkconfig.defaults)。未写出的项取 `Kconfig.projbuild` 默认值
（例如 `NODE_ALARM_BENCH_INJECT=n`、`NODE_VOICE_BOOT_TEST=n`）。

### 4.1 目标与 Flash

| 字段 | 本节点值 | 含义 |
|---|---|---|
| `CONFIG_IDF_TARGET` | `"esp32s3"` | 目标芯片 |
| `CONFIG_ESPTOOLPY_FLASHSIZE_16MB` / `CONFIG_ESPTOOLPY_FLASHSIZE` | `y` / `"16MB"` | 当前 `sdkconfig` 为 16MB；`partitions.csv` 自定义 factory app **4 MiB @0x10000**（旧文档的 2MB/1MB 已过期） |
| `CONFIG_ESP_MAIN_TASK_STACK_SIZE` | `8192` | 主任务栈（语音/网络/门磁都在主任务里串行跑） |

### 4.2 身份与网关

| 字段 | 本节点值 | 含义 |
|---|---|---|
| `CONFIG_NODE_ID` | `"esp32-bath"` | 上报 `deviceId`，决定主题 `home/esp32-bath/status` |
| `CONFIG_NODE_ROOM` | `"卫生间"` | 上报房间名（APP 房间标签） |
| `CONFIG_NODE_GW_HOST` | `"10.127.130.179"` | PC 上 `mqtt_bridge.js` 所在主机 IP（DHCP 会变） |
| `CONFIG_NODE_GW_PORT` | `9101` | 桥接 `--listen` 端口 |

### 4.3 外设与本地声光

| 字段 | 本节点值 | 含义 |
|---|---|---|
| `CONFIG_NODE_MOTION_GPIO` | `36` | PIR 输入脚（仅输入脚，不能做输出）；`-1` 关闭 |
| `CONFIG_NODE_MOTION_DEBOUNCE_CONFIRM` | `2` | 连续 2 次一致才更新活动时间 |
| `CONFIG_NODE_SOS_GPIO` | `15` | 实体求助键 GPIO，内部上拉、低电平按下；`-1` 禁用 |
| `CONFIG_NODE_SOS_DEBOUNCE_CONFIRM` | `2` | 连续 2 次确认才生成一次 `MANUAL_SOS` |
| `CONFIG_NODE_DOOR_GPIO` | `2` | 门磁输入脚，内部上拉；**不得再用 IO14（板载咪头 DIN）** |
| `CONFIG_NODE_DOOR_OPEN_LEVEL` | `1` | 高电平=开（常开 NO：磁铁靠近=闭合=低=关；移开=断开=高=开） |
| `CONFIG_NODE_DOOR_CONFIRM_COUNT` | `2` | 连续 2 次一致才确认翻转；上电先建立基线，不凭空生成事件 |
| `CONFIG_NODE_DOOR_CACHE_MAX` | `8` | 离线未送达门磁事件 FIFO 上限 |
| `CONFIG_NODE_DOOR_CACHE_KEEP_SEC` | `300` | 离线事件保留时长，重连后随心跳补传（后端按 `(deviceId,seq)` 幂等去重） |
| `CONFIG_NODE_AHT20_ENABLED` | `y` | 启用 AHT20 温湿度 |
| `CONFIG_NODE_DHT11_GPIO` | `-1` | 与 AHT20 二选一；卫生间用 AHT20 |
| `CONFIG_NODE_I2C_SDA_GPIO` / `CONFIG_NODE_I2C_SCL_GPIO` | `4` / `5` | AHT20 的 I2C1 引脚（板载 XL9555 在 I2C0 的 41/42） |
| `CONFIG_NODE_BUZZER_XL9555` | `y` | 蜂鸣器走 XL9555 `P0_3`（低有效），不是 GPIO |
| `CONFIG_NODE_BUZZER_GPIO` | `-1` | 使用板载蜂鸣器时必须 `-1` |
| `CONFIG_NODE_VOICE_ENABLED` | `y` | 启用 ES8388 播放与板载咪头采集（按需 PCM 上传） |
| `CONFIG_NODE_VOICE_VOLUME` | `30` | 功放寄存器音量；`0x1E`=30 = **0 dB**，33 = +4.5 dB 上限 |
| `CONFIG_NODE_LED_GPIO` | `1` | 板载用户 LED（IO1）；`-1` 关闭 |
| `CONFIG_NODE_LED_ACTIVE_LOW` | `y` | 低电平点亮 |
| `CONFIG_NODE_VOICE_AMP_SETTLE_MS` | `60` | 功放使能后等待 60 ms 再送 I2S，避免截头/爆音 |
| `CONFIG_NODE_MIC_PORT` | `9303` | 板载咪头 PCM 上传端口（与 9302 问答、9102 音箱分离） |
| `CONFIG_NODE_MIC_RECORD_SEC` | `4` | 每次告警/命令录音时长，不做常开麦克风 |
| `CONFIG_NODE_MIC_UPLOAD` | `y` | 告警新建时自动录音上传；串口 `micupload` 可手动触发 |
| `CONFIG_NODE_BOOT_BEEP_MS` | `0` | 上电不鸣响（验收后必须保持 0） |

### 4.4 气体通道（保持禁用）

| 字段 | 本节点值 | 含义 |
|---|---|---|
| `CONFIG_NODE_MQ2_ADC_CHANNEL` / `CONFIG_NODE_MQ5_ADC_CHANNEL` | `-1` / `-1` | 本节点没有 MQ 模块，通道禁用（`-1` = 相关代码整体条件编译排除） |
| `CONFIG_NODE_MQ2_ALARM_RAW` / `CONFIG_NODE_MQ5_ALARM_RAW` | `4096` / `4096` | ≥4096 = **告警关闭**；保持禁用值，避免"没有传感器却报燃气" |
| `CONFIG_NODE_MQ_CONFIRM_COUNT` / `CONFIG_NODE_MQ_HYSTERESIS_RAW` | `3` / `20` | 保留默认，禁用通道下不生效 |

### 4.5 Wi-Fi

| 字段 | 本节点值 | 含义 |
|---|---|---|
| `CONFIG_NODE_WIFI_SSID` | `"YOUR_WIFI"` | 占位符；真实值由 `firmware/.local/wifi.bathroom.defaults` 覆盖注入 |
| `CONFIG_NODE_WIFI_PASS` | `"YOUR_PASSWORD"` | 占位符；**真实口令不得写进任何入库文件** |

> 注意覆盖文件名用的是**工程目录名** `bathroom`（`wifi.bathroom.defaults`），不是 `deviceId` 的 `bath`。

### 4.6 判定与上报

| 字段 | 本节点值 | 含义 |
|---|---|---|
| `CONFIG_NODE_REPORT_SEC` | `5` | 上报周期（实测约 5.5 s 节拍） |
| `CONFIG_NODE_NO_MOTION_SEC` | `1800` | 无活动阈值（30 分钟）；**只表示"长时间未检测到活动"**，不能写"昏迷/跌倒" |
| `CONFIG_NODE_NO_MOTION_REQUIRE_ARM` | `y` | 必须先见到一次有效活动才开始计时（防 PIR 断线常低误报） |
| `CONFIG_NODE_ALARM_REPEAT_SEC` | `300` | 危险持续时的重复提醒限频（stop/ack 后不再重复） |
| `CONFIG_NODE_ALARM_BEEP_SEC` | `10` | **已弃用**（固件不再读取），仅为兼容旧 profile 保留 |
| `CONFIG_NODE_ALARM_CHIRP_ON_MS` / `CONFIG_NODE_ALARM_CHIRP_GAP_MS` / `CONFIG_NODE_ALARM_CHIRP_COUNT` | `200` / `100` / `2` | 告警先响 2 声短提示音，蜂鸣停止后才播完整语音（两者不重叠） |
| `CONFIG_NODE_ALARM_CHIRP_COUNT_SOS` | `3` | SOS 三声短提示音，与 LED 三短闪对应 |
| `CONFIG_NODE_ALARM_VOICE_GAP_MS` | `150` | 最后一声提示音到语音开始的间隔 |
| `CONFIG_NODE_TEMP_LOW_C` / `CONFIG_NODE_TEMP_HIGH_C` | `5` / `45` | 温度阈值（℃） |
| `CONFIG_NODE_RH_LOW` / `CONFIG_NODE_RH_HIGH` | `10` / `90` | 湿度阈值（%RH） |
| `CONFIG_NODE_CLIMATE_CONFIRM_COUNT` / `CONFIG_NODE_CLIMATE_CLEAR_COUNT` | `3` / `5` | 连续 3 次有效读数越界才报警；连续 5 次回到回差带才解除 |
| `CONFIG_NODE_TEMP_HYST_C` / `CONFIG_NODE_RH_HYST` | `1` / `3` | 恢复回差 |

### 4.7 水漏（预留，当前禁用）

| 字段 | 本节点值 | 含义 |
|---|---|---|
| `CONFIG_NODE_WATER_GPIO` | `-1` | 水漏 DO 引脚；**当前禁用**。硬件就绪后改 `37` 即可，无需改代码 |
| `CONFIG_NODE_WATER_ACTIVE_LOW` | `y` | 低电平=湿润（与"常开 NO 遇水闭合拉低"一致） |
| `CONFIG_NODE_WATER_CONFIRM_COUNT` | `3` | 连续 3 次湿润才进 `WATER_LEAK`，短毛刺不报 |
| `CONFIG_NODE_WATER_CLEAR_COUNT` | `3` | 连续 3 次干燥才重新武装 |

> 启用后 JSON 会新增 `sensors.water` 段。**下游（板端 HAP / public-sync adapter）对该字段的兼容性未验证**，
> 启用前要先确认不会触发字段校验拒绝。

### 4.8 电池（固定供电，禁用）

| 字段 | 本节点值 | 含义 |
|---|---|---|
| `CONFIG_NODE_BATTERY_ADC_CHANNEL` | `-1` | 无电池采样电路 → 固件**不输出** `battery` 字段 |
| `CONFIG_NODE_BATTERY_DIVIDER_NUM` / `CONFIG_NODE_BATTERY_DIVIDER_DEN` | `2` / `1` | 分压比 `battery_mv = adc_mv × NUM / DEN`（1S 锂电 100k/100k → 2:1） |
| `CONFIG_NODE_BATTERY_CAL_GAIN_PERMILLE` / `CONFIG_NODE_BATTERY_CAL_OFFSET_MV` | `1000` / `0` | 两点校准增益（千分比）/偏移（mV）；未标定时保持 1000/0 |
| `CONFIG_NODE_BATTERY_LOW_MV` | `3500` | 低电量阈值（`≤` 即 `low=true`） |
| `CONFIG_NODE_BATTERY_MIN_MV` / `CONFIG_NODE_BATTERY_MAX_MV` | `2500` / `4350` | 有效范围下界/上界，超界 `valid=false`（OUT_OF_RANGE） |
| `CONFIG_NODE_BATTERY_SAMPLE_SEC` | `30` | 采样周期（秒） |

> 以上电池项在 `ADC_CHANNEL=-1` 时**全部不生效**（不采样、不输出 `battery` 字段）。

## 5. 用 VSCode 打开 / 构建 / 烧录

### 5.1 打开

- **单节点构建**：`File → Open Folder → <WORKSPACE>\competition\firmware\bathroom`
  `.vscode/settings.json` 已配好 `idf.currentSetup`（ESP-IDF v5.1.6）与 `idf.port = COM5`、`flashType = UART`。
- **看全量源码**：`File → Open Folder → <WORKSPACE>\competition\firmware`
  （工程目录叫 `bathroom`，`deviceId` 叫 `bath`，两者不要混）。

### 5.2 命令行（推荐）

```powershell
# 只构建，不碰串口
powershell -NoProfile -ExecutionPolicy Bypass -File <WORKSPACE>\competition\firmware\tools\build-node.ps1 -Node bathroom

# 首次构建前注入 Wi-Fi → firmware\.local\wifi.bathroom.defaults
#   见 ..\..\docs\NODES.md §5.1（口令隐藏输入，不写进 argv / 仓库）

# 烧录（先只读 chip_id；MAC 需人工比对 14:c1:9f:42:dd:b4）
... -Node bathroom -Action flash -Com COM5

# 监视
... -Node bathroom -Action monitor -Com COM5
```

### 5.3 烧录安全（摘要，完整版见 `../../docs/NODES.md` §5）

1. 只插一块板；`esptool.py --chip esp32s3 -p COM5 chip_id` → 核对 MAC `14:c1:9f:42:dd:b4`。
2. 备份 app 分区：`read_flash 0x10000 0x400000 <备份>.bin`（4 MiB，与 `partitions.csv` 一致）。
3. 优先只写 app：`write_flash 0x10000 build\esp32_elder_node.bin`，确认 `Hash of data verified`。
4. **禁止** `erase_flash`：会清掉 NVS 里的门磁 `seq` 基线与 Wi-Fi 凭据。
5. 回滚 = 备份写回 `0x10000`。

### 5.4 板载咪头自检（串口）

现场固件直接可用（COM6，115200）：

```text
mictest 5      # 打印 MIC_TEST rms/peak/samples，结束后恢复播放
beep on        # 板载蜂鸣器近场声源（不改变告警状态）
mictest 5
beep off
micupload      # 录 4 s 上传 PC 网关 9303，打印 ASR/answer/error 回执
```

验收要点：`MIC end playback_restored=1`；蜂鸣 RMS 明显高于安静值；`micupload` 出现
`MIC_UPLOAD #n sent rms=... samples=...`，失败会打印 `MIC_UPLOAD FAIL reason=...`。
蜂鸣只证明近场通路，不代表真人语音识别率。

> 历史记录里这块板与厨房曾在 COM4/COM5 之间互换过（2026-10-27 卫生间在 COM4 刷写）。
> **端口号不可作为身份判断依据**，每次都要读 MAC。

## 6. 已知限制 / 未验收项

| # | 限制 | 说明 / 边界 |
|---|---|---|
| L1 | **水漏未安装** | `WATER_GPIO=-1`；IO37 仅预留。代码与主机测试就绪，但无任何"已接线/已验收"记录 → 不得宣称具备漏水监测 |
| L2 | **门磁扩展字段未公网上报** | 本地保留 `lastCloseTs`/`seq`/`events`，公网只发旧合同两键（否则 `INVALID_STATUS`，2026-10-27 实测过）；等 schema v7 发布后才启用 |
| L3 | app 分区为 4 MiB（`partitions.csv`） | 当前镜像 1,039,008 B / 4,194,304 B（约 25%）；旧文档的 1 MiB 说法已过期 |
| L4 | SOS 按键**建议做一次真实按键验收** | 固件逻辑已实现（先见松开才允许触发、长按只一次）；现场按键是唯一可信证据，不要带电短接 IO 模拟 |
| L5 | 无燃气/烟雾能力 | `ADC_CHANNEL=-1`，阈值 4096（禁用）。不得在 APP/PPT 里给卫生间画燃气风险 |
| L6 | 无电池采样 | `BATTERY_ADC_CHANNEL=-1`，报文无 `battery` 字段 |
| L7 | AHT20 读失败语义 | `climate.ok` 的语义是"没有越界告警"，**不是**"本次读数新鲜"；读失败保留上次值但绝不据此告警 |
| L8 | 语音音量 30 = 0 dB | 上限 33（+4.5 dB）；再增加会削顶失真 |
| L9 | 与厨房共用同一 Wi-Fi AP | 两节点会同时断连（2026-10-28 01:43:48 实测 12–14 s，自愈）；断连期间 SOS 上报会丢 |
| L10 | 蜂鸣器/功放共用 XL9555（板载 I2C0） | 该 I2C0 或 XL9555 故障时本地蜂鸣与语音同时失效（SOS 按键走 GPIO15，不受影响）；这也是与厨房共享的硬件单点 |
| L11 | 门磁**实物线仍接 IO14** | 固件已改 GPIO2；未改线前上报 `door.open=true`，不能作为门磁验收证据 |
| L12 | 温湿度偶发 `valid=false` | 2026-10-31 回归日志出现 `tempC=0/rh=0/valid=false`；本路径本轮未改动，需单独排查接线/上电时序 |
| L13 | 真人说“我没事”未验收 | 蜂鸣近场 RMS 与 9303 模拟已通过；必须现场由真人对着板载咪头复测 |

## 7. 相关证据

- 阶段 1 引脚/接线与行为：`competition/docs/evidence/2026-10-20-bathroom-esp32-stage1-source.md`
- 语音+LED+门磁兼容刷写与启动日志：`competition/evidence/2026-10-27-voice-led-restore/BATH-FLASH-RECORD.md`
- 只读硬件审计（PIR/门磁/水漏）：`competition/evidence/2026-10-27-real-capability-app/hardware/PIR-DOOR-AUDIT.md`
- 两节点同时断连/自愈：`competition/evidence/2026-10-28-fullchain-health/nodes/FINDINGS.md`
- 门磁 v7 端到端：`competition/evidence/2026-10-27-door-v7-e2e/REPORT.md`
- 板载咪头自检与新固件：`competition/evidence/2026-10-31-mic-selftest/`（含 NEW/ROLLBACK BIN 哈希、mictest 日志）
