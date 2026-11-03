# ESP32-S3 无线传感节点（免布线扩展多房间）

对应赛题创新项：**「可扩展多节点」**——用无线节点把监测覆盖到多个房间，不必在房间之间拉线。

> 当前源码已使用 ESP-IDF v5.1.6 和 xtensa-esp32s3-elf-gcc 12.2.0 构建。
> 最终应用为 754800 字节，app 分区余量 28%；已在 COM9 烧录并通过 Hash 校验。
> 最终 BIN、ELF 和运行证据见 `../docs/ARTIFACTS.md` 与
> `../evidence/2026-10-10-final-esp32-and-bridge-hardening/`。
>
> **上述构建与烧录记录仅指卫生间节点（`sdkconfig.defaults`）。**
> 厨房节点（`profiles/kitchen.sdkconfig.defaults`）本轮只做静态源码复核：
> **NOT COMPILED / NOT FLASHED / NOT TESTED ON HARDWARE。**

## 一、设计取舍：为什么节点不做 MQTT

节点**不实现 MQTT**，而是把与主控 `homemon` **逐字段相同的 JSON 行协议**，通过 TCP 推给 PC 上的网关
（`mqtt_bridge.js --listen`）。这样带来三个好处：

| 好处 | 说明 |
|---|---|
| **零第三方组件** | 只用 ESP-IDF 自带的 WiFi/TCP/GPIO，不引入 MQTT 库，固件小、编译快、现场故障点少 |
| **桥接与 APP 零改动** | 报文格式与 `homemon` 完全一致，APP 自动发现并展示本节点（多出一个"房间"标签） |
| **下行命令自动可用** | 桥接按 `deviceId` 路由，云端/APP 的 `ack`/`reset` 能直达本节点 |

> 架构上这就是标准的"**网关（Gateway）+ 子节点**"模型：子节点说轻量协议，网关负责上云。

## 二、接线（默认 GPIO，可用 menuconfig 修改）

| 功能 | ESP32-S3 引脚 | 说明 |
|---|---|---|
| 红外人体传感器 | **GPIO4** | 高电平=有人；固件已开下拉，避免悬空误触发 |
| 门窗磁 | **GPIO5** | 高电平=开启 |
| 外接有源蜂鸣器 | **GPIO6** | 高电平鸣响（告警时本地声报警）；不是开发板板载蜂鸣器 |
| 供电 | 5V / GND | USB 或外部 5V |

### 厨房节点（`Kitchen` profile）

> **状态：静态源码复核完成；NOT COMPILED / NOT FLASHED / NOT TESTED ON HARDWARE。**
> 本节对应的代码与 profile 只做过源码级检查，**没有编译、没有烧录、没有真机测试**。
> 接线、编译、烧录和真机验收由用户本人执行，结论以实测串口/网关日志为准，
> 不要用"代码具备"代替真机证据。

厨房节点身份固定为 `esp32-kitchen`，房间为“厨房”，不接 PIR 和门磁：

| 器件 | 模块引脚 | ESP32-S3 | 供电与说明 |
|---|---|---|---|
| MQ-2 | `AO` | `GPIO1 / ADC1_CH0` | 模块使用独立 5V；AO 必须经过 20k/10k 分压 |
| MQ-5 | `AO` | `GPIO2 / ADC1_CH1` | 模块使用独立 5V；AO 必须经过 20k/10k 分压 |
| AHT20 | `SDA` | `GPIO11` | AHT20 使用 3.3V |
| AHT20 | `SCL` | `GPIO12` | AHT20 使用 3.3V |
| 有源蜂鸣器模块 | `IN` | `GPIO6` | 仅三针低电流模块可直接用控制输入 |

所有模块与 ESP32 必须共地。MQ-2 和 MQ-5 的加热器建议由独立 `5V / 1A` 电源供电，不能由
ESP32 的 3.3V 引脚供电。每一路 AO 使用以下分压，禁止把可能达到 5V 的 AO 直接接入 ESP32：

```text
MQ AO ---- 20k ohm ----+---- ESP32 ADC
                       |
                     10k ohm
                       |
                      GND
```

若蜂鸣器只有两根线，或额定电流超过开发板 GPIO 能力，必须增加 NPN 三极管或逻辑级 MOSFET
驱动及限流电阻，GPIO6 只提供控制信号，不能直接为蜂鸣器供电。

> **GPIO6 与摄像头互斥**：在 DNESP32S3 上 GPIO6 同时是 P2 摄像头排线的 `OV_D2`。
> 厨房节点用 GPIO6 驱动外接蜂鸣器时，**不得同时插入 OV2640/OV5640 模组**，
> 否则蜂鸣器输出与摄像头数据线会两端同时驱动，产生电气争用。
> 厨房 profile 因此关闭板载 XL9555 蜂鸣器：
> `CONFIG_NODE_BUZZER_XL9555=n`、`CONFIG_NODE_BUZZER_GPIO=6`。

厨房首次上电按以下顺序进行：

1. 只接 AHT20，确认温湿度读数合理（AHT20 用 **3.3V**）。
2. 断电后接 MQ-2/MQ-5 的 5V、共地和两路分压，再通电预热并记录洁净空气基线。
3. 初始阈值为 `4096`，表示只采集、不触发 MQ 告警；取得稳定基线后再设置真实阈值。
4. 最后接蜂鸣器并测试输出。

**MQ 预热与标定的边界（必须如实说明）：**

- MQ-2 / MQ-5 首次上电需要**预热**；数据手册给出的老化/预热时间远长于几分钟，
  长期存放后的传感器需要更长时间才能稳定。
- **短时间预热只能用于演示基线**，不能据此声称传感器已完成标定。
- 在**没有使用标准测试气体或参考仪器**的情况下，**不得声称完成真实气体浓度标定**。
  本固件只上报 `0..4095` 的 ADC 原始值（`sensors.smoke.raw` / `sensors.gas.raw`），
  **不做 ppm 换算，也不会把原始值伪装成气体浓度**。
- 初始阈值 `4096` 表示 **MQ 告警关闭**（只采集、不报警）。要启用告警必须先做基线测量。
- **禁止**用明火、打火机或故意泄漏天然气/LPG 来测试传感器：既得不到可用的定量结论，
  又存在真实的火灾与中毒风险。
- 接线、编译、烧录和真机测试由**用户本人**负责；本仓库不含任何已完成的厨房真机结论。

### DNESP32S3 开发板的引脚冲突

`F:\ESP` 中的 DNESP32S3 资料确认，板载 P2 摄像头接口使用 DVP 8 位总线，其中：

| 摄像头信号 | GPIO | 与当前固件的冲突 |
|---|---:|---|
| `OV_D0` | 4 | 当前为 PIR 输入 |
| `OV_D1` | 5 | 当前为门磁输入 |
| `OV_D2` | 6 | 当前为外接蜂鸣器输出 |
| `OV_D3..D7` | 7、15、16、17、18 | 当前固件未使用 |
| `OV_VSYNC/HREF/PCLK` | 47、48、45 | 当前固件未使用 |
| `OV_SCL/SDA` | 38、39 | 当前固件未使用 |

因此不能在保持当前 GPIO4/5/6 接线不变的情况下直接插入 OV2640/OV5640。若以后启用 ESP32
摄像头，必须先为 PIR、门磁重新选择并实测可用 GPIO。开发板已有的有源蜂鸣器由 I2C IO 扩展
芯片 XL9555 的 P0_3 控制，不能继续用 `gpio_set_level(6, ...)` 驱动；应另写 XL9555 驱动后再移除
外接蜂鸣器。

> **电气安全：** 当前固件会主动驱动 GPIO6，而摄像头插入 P2 后 GPIO6 是摄像头的 `OV_D2`
> 输出。两端同时驱动可能产生电气争用。必须先把 GPIO4/5/6 迁移或禁用、重新构建并烧录，
> 然后才能插入摄像头模组。

当前项目选择 DAYU200 的 MIPI-CSI2 摄像头作为主视觉入口，ESP32-S3 保持为卫生间传感节点。
完整资源和取舍见 `../docs/HARDWARE-MAP.md`。

## 三、配置

```bash
idf.py menuconfig      # → "居家安全监护 · ESP32-S3 无线节点"
```

| 配置项 | 示例 | 说明 |
|---|---|---|
| WiFi 名称 / 密码 | `MyHome` / `********` | 2.4GHz（ESP32-S3 不支持 5GHz）；开放网络使用空密码 |
| 设备编号 deviceId | `esp32-bathroom` | **必须唯一**，决定云端主题 `home/<deviceId>/status` |
| 房间名称 room | `卫生间` | 显示在北向 APP 的房间标签上 |
| 网关地址 | PC 的局域网 IP，如 `192.168.1.100` | 桥接程序所在主机 |
| 网关端口 | `9100` | 与桥接 `--listen` 一致；当前真实硬件配置使用 `9101` |
| 上报周期 | 5 秒 | |
| 无活动阈值 | 1800 秒 | 演示时可调成 30 秒 |

## 四、编译与烧录

```powershell
# 环境（ESP-IDF v5.1.6 已装在该路径）
. 'D:\Espressif-5.1.6\frameworks\esp-idf-v5.1.6\export.ps1'

Set-Location <WORKSPACE>\competition\esp32-node
idf.py build                     # 编译
idf.py -p COM9 flash monitor     # 烧录并看串口日志（COM9 为实测端口）
```

厨房板使用独立 profile 和独立构建目录，不会覆盖已跑通的卫生间配置。
`profiles/kitchen.sdkconfig.defaults` **只含硬件与判定参数，不含任何网络信息或凭据**；
Wi-Fi SSID、密码、网关地址、端口由脚本在烧录时追加到已 gitignore 的
`.local/sdkconfig.kitchen.defaults`：

```powershell
# 仅验证编译（不枚举串口、不烧录）
powershell -ExecutionPolicy Bypass -File .\flash_esp32.ps1 -Profile Kitchen -BuildOnly

# 完整构建 + 烧录（密码用隐藏输入，不进 argv / 日志 / git）
powershell -ExecutionPolicy Bypass -File .\flash_esp32.ps1 `
  -Profile Kitchen -Ssid "你的2.4GHz WiFi" `
  -GwHost "PC当前局域网IP" -GwPort 9101 -Com "确认属于厨房板的COM口"
```

> 脚本**没有** `-Pass` 参数：Wi-Fi 密码一律由 `Read-Host -AsSecureString` 隐藏输入，
> 不得写进命令行、README 或 profile。省略 `-GwHost` 时脚本自动取当前 WLAN 的 IPv4。

烧录前必须通过实时串口枚举和芯片握手确认目标板，不能沿用历史 COM 号猜测。脚本把厨房产物放在
`build-kitchen`，本地含凭据的生成配置放在已忽略的 `.local`，且不会在终端打印密码。
`-BuildOnly` 模式不会访问串口或烧录设备。

> ⚠ 实测：`idf.py` 需要以管道拉起 cmake/ninja 子进程，在受限沙箱里会报 `WinError 5`；
> 直接在本机（非沙箱）终端运行即可。

## 五、与系统联调

```powershell
# 1) PC 上启动网关（同时接收无线节点 + 可选有线节点）
node <WORKSPACE>\competition\bridge\mqtt_bridge.js `
     --broker 127.0.0.1:1883 --listen 9100 --status-tcp 127.0.0.1:9000

# 2) 起 broker（若不是用公有云）
node <WORKSPACE>\competition\bridge\mqtt_broker.js 1883
```

节点上电后会打印：

```
已连接 WiFi: MyHome
已获取 IP: 192.168.1.123
已连接网关 192.168.1.100:9100
→ {"deviceId":"esp32-bathroom","room":"卫生间","ts":1791608811715,"state":"NORMAL", ...}
```

`ts` 与 `sensors.motion.lastActiveTs` 都是 13 位 Unix 毫秒。NTP 尚未同步时二者按设计上报 `0`。节点通过原始 TCP 行协议连接 Bridge，MQTT 发布由 Bridge 完成。

网关侧打印：

```
[bridge] 无线节点接入 192.168.1.123:52341
[bridge] → home/esp32-bathroom/status  state=NORMAL room=卫生间 countToday=3
```

**北向 APP 会自动多出一个"卫生间"标签**，数据与告警均可切换查看、闭环可下发到该节点。

## 六、与主控 homemon 的差异

| 项 | 主控 homemon（RK3568） | 本节点（ESP32-S3） |
|---|---|---|
| 运行系统 | OpenHarmony | ESP-IDF |
| 接入方式 | USB/hdc fport 或局域网 TCP | **WiFi + TCP，主动连网关** |
| 传感能力 | 红外/门磁/温湿度/ADC 燃气烟雾 | 按 profile 启用：卫生间=红外/门磁；厨房=AHT20 温湿度 + MQ-2/MQ-5 ADC 原始值（无 PIR/门磁） |
| 执行能力 | 三色灯 + 蜂鸣器 + **语音播报** | 蜂鸣器 |
| 角色 | **主控 + 本地闭环 + 语音** | **无线扩展节点（覆盖多房间）** |

---

## 七、节点告警状态机与数据边界

### 7.1 状态机（`node_main.c` 的 `judge()` / `active_danger()`）

告警优先级：`GAS > SMOKE > CLIMATE > NO_MOTION`，同一时刻只对外呈现一个告警。

| 当前状态 | 事件 | 结果 |
|---|---|---|
| NORMAL | 检测到危险 | → ALARM，生成唯一 `alarm.id`，蜂鸣器响 |
| ALARM | 同一危险持续 | 保持 ALARM，**不**生成新 ID（避免告警风暴） |
| ALARM | 出现更高优先级危险 | 升级为新告警（新 ID） |
| ALARM | NO_MOTION 且活动恢复 | 自动回 NORMAL，蜂鸣器停（保持既有行为） |
| ALARM | `ack <alarmId>` 且 ID 精确匹配 | → ACKED；ID 不匹配则拒绝且状态不变 |
| ACKED | 同种危险持续 | 保持 ACKED，不再响铃、不新建 ID |
| ACKED | 该危险**先消失再出现** | 重新武装后再次报警（不是永久屏蔽） |
| ACKED | 出现**另一种**危险 | 立即产生新告警（绝不被 ACK 屏蔽） |
| ACKED | `reset` | → NORMAL，蜂鸣器停 |

结论：**GAS / SMOKE / CLIMATE 必须 `ack` 或 `reset` 才回到 NORMAL，不会自动清除**；
`NO_MOTION` 是唯一会自动复位的告警（活动恢复即复位）。

> 厨房节点没有 PIR，因此 `NO_MOTION` 在厨房上永远不可能产生：`CONFIG_NODE_MOTION_GPIO=-1`
> 时相关代码被条件编译整体排除，**不会执行 `gpio_get_level(-1)`**。

### 7.2 厨房节点的数据边界

- **无 PIR / 无门磁**：`sensors.motion.countToday` 与 `sensors.motion.lastActiveTs` 恒为 `0`，
  `sensors.door.open` 恒为 `false`；这两个 JSON 字段**仍然保留**以兼容北向 HAP。
- **MQ-2 / MQ-5** 只上报 ADC 原始值 `0..4095`；阈值 `4096` = 告警关闭；**不做 ppm 换算**。
- **AHT20 读取失败的已知限制**：报文合同里 `sensors.climate` 只有 `tempC` / `rh` / `ok`
  三个字段，**没有"本次读数是否新鲜"的标志**。读失败时固件把内部有效标志
  `s_climate_valid` 置 0（因此**绝不会**据此触发 CLIMATE 告警），但报文仍会携带
  上一次成功的 `tempC` / `rh`，并把 `ok` 保持为 `true`。
  这样做的原因是：若把 `ok` 置 `false`，北向 HAP 会显示"温湿度超出阈值，已触发预警"，
  反而变成**读失败伪装成环境告警**（明确禁止）。
  因此 `climate.ok` 的真实语义是"**没有越界告警**"，不是"本次读数新鲜"。
  若要区分新鲜度，需要扩展 JSON 合同（本轮按边界**不改合同**）。
- 上电后到第一次成功读数之前，`tempC` / `rh` 上报 `0.0`，应视为"未知"，不是真实的 0℃。
- `ts` 为 13 位 Unix 毫秒；NTP 未同步时按设计上报 `0`，同步后恢复正常（不是故障）。

### 7.3 JSON 字段合同（厨房节点同样适用）

保留字段：`sensors.motion` / `sensors.door` / `sensors.climate` / `sensors.gas` /
`sensors.smoke` / `alarm.id` / `alarm.type` / `alarm.countToday`。

| 数据 | JSON 字段 |
|---|---|
| AHT20 温度 / 湿度 | `sensors.climate.tempC` / `sensors.climate.rh` |
| AHT20 有效且未越界 | `sensors.climate.ok = true` |
| MQ-5 ADC 原始值 | `sensors.gas.raw`（正常时 `sensors.gas.ok = true`） |
| MQ-2 ADC 原始值 | `sensors.smoke.raw`（正常时 `sensors.smoke.ok = true`） |

字段名与语义**未改动**，Bridge 与北向 HAP 不需要任何修改。

---

## 八、卫生间节点（阶段1，2026-10-20，**未编译 / 未烧录 / 未上板**）

> 本轮只交付源码 + profile + 主机测试 + 接线说明；未执行 ESP-IDF 构建、未烧录、未打开串口。
>
> **本轮启用范围：PIR + SOS 按键 + AHT20 温湿度 + 板载蜂鸣器。**
> **水漏本轮不做（用户决定明天做）**：水漏代码与该逻辑的主机测试已就绪，profile 中 `CONFIG_NODE_WATER_GPIO=-1` 禁用，IO37 保留给水漏；明天只需把该行改为 37 即可启用，无需改代码。

### 8.1 身份与复用

- `deviceId=esp32-bath`，`room=卫生间`；复用同一份 `node_main.c` / `alarm_logic.h`（不建第二套状态机）。
- AHT20 复用已验证的 I2C1 实现（SDA=IO4 / SCL=IO5，CRC8 + 量程检查）。
- 蜂鸣器复用板载 XL9555 P0_3（低电平有效，上电静音，`BOOT_BEEP_MS=0`）。
- 不接 MQ-2/MQ-5、不接门磁：`CONFIG_NODE_MQ2_ADC_CHANNEL=-1`、`CONFIG_NODE_MQ5_ADC_CHANNEL=-1`、`CONFIG_NODE_DOOR_GPIO=-1`。

### 8.2 正式引脚（依据：官方 IO 引脚分配表 + DNESP32S3 V1.0 硬件参考手册 + V1.4 原理图 + 板卡 P1 丝印）

| 功能 | ESP32-S3 引脚 | 说明 |
|---|---|---|
| AHT20 SDA | IO4（P1 下排第 1 脚） | I2C1，模块侧需上拉到 3V3 |
| AHT20 SCL | IO5（P1 上排第 1 脚） | I2C1 |
| PIR OUT | IO36（P1 上排，仅输入脚） | 模块输出必须 <= 3.3V |
| 水漏 DO | IO37（P1 下排，仅输入脚） | 模块 DO 必须 <= 3.3V |
| SOS 按键 | **IO15**（P1 下排，双向脚） | 内部上拉可靠；另一端接 GND，低电平按下。**不要用 IO35**（仅输入脚上拉不可靠，实测会误触发长鸣） |
| 板载蜂鸣器 | XL9555 P0_3（I2C0 IO41/IO42） | 无需外接 |

未使用：IO41/IO42（板载 IIC0）、IO19/IO20（USB）、IO0/IO45/IO46（启动绑带）、IO38（触摸/摄像头 SCL）、Flash/PSRAM 引脚。

### 8.3 逐线接线表

| 模块 | 模块端 | 接到 | 供电 | 电平/极性 |
|---|---|---|---|---|
| AHT20 | VCC | 3V3 | 3.3V | — |
| AHT20 | GND | GND | — | — |
| AHT20 | SDA | IO4 | — | 3.3V I2C |
| AHT20 | SCL | IO5 | — | 3.3V I2C |
| PIR | VCC | 3V3（若模块要求 5V，必须先确认 OUT 为 3.3V） | 见左 | OUT 高=有活动 |
| PIR | GND | GND | — | — |
| PIR | OUT | IO36 | — | 必须 <= 3.3V |
| 水浸探头（**本轮不接，明天做**） | 正极(+)/负极(-) | 只接探头自带的电源盒，不接 ESP32 | 模块自带电源 | 继电器线圈供电 |
| 水浸探头（明天） | 公共端（COM，白线） | GND | — | 干接点，无电压 |
| 水浸探头（明天） | 常开（NO，绿线） | **IO37**（内部上拉，profile 里先设 -1） | — | 遇水闭合 → 低电平=湿润 |
| 水浸探头（明天） | 常闭（NC，黄线） | 不接 | — | 与 NO 反相，本方案不用 |
| 水浸探头（明天） | 声光（如配） | 不接（报警由板载蜂鸣器完成） | 可选 | 可选不装 |
| SOS 按键 | 一端 | **IO15** | — | 内部上拉（双向脚） |
| SOS 按键 | 另一端 | GND | — | 按下=低电平（请用**常开 NO** 触点） |

电平红线：
- **水浸探头是继电器干接点**（实测型号：5 线，正/负/公共端/常闭/常开，常开模式遇水报警）：ESP32 只接 COM(白线)与 NO(绿线)，线圈电源由探头自带电源盒供电，**干接点两端没有电压，不需要分压**；默认 NODE_WATER_ACTIVE_LOW=y（闭合=低=湿润）与内部上拉完全吻合。NC(黄线)不接，声光单元可不装。
- **PIR 若为 5V 输出**（型号未确认前），禁止直接接入 GPIO，必须分压/电平转换或改用 3.3V 输出模块。

### 8.4 行为（全部可配置，无魔法数字）

- **PIR**：连续 `CONFIG_NODE_MOTION_DEBOUNCE_CONFIRM`（默认 2）次确认后才更新 `motion.lastActiveTs`/`countToday`；普通移动不告警；PIR 禁用时不产生 NO_MOTION。
- **SOS**：上电后**必须观察到一次松开**才允许触发（悬空/常闭/上电即低都不会误报）；连续 `CONFIG_NODE_SOS_DEBOUNCE_CONFIRM`（默认 2）次确认才生成一次 `MANUAL_SOS`；长按不重复；ACK 立即静音并保留 alarmId/type；松开后重新武装，再次按下产生新事件。
- **水漏（本轮未启用，明天做）**：代码已实现——连续 `CONFIG_NODE_WATER_CONFIRM_COUNT`（默认 3）次湿润才进入 `WATER_LEAK`；短毛刺不报警；锁存；ACK 静音但湿润持续不重复 ID；连续 `CONFIG_NODE_WATER_CLEAR_COUNT`（默认 3）次干燥才重新武装；无效读数不清除危险、不重新武装。
- **AHT20**：复用 I2C1 实现；读失败时 `climate.valid=false` 且不伪装告警。
- **优先级**：`MANUAL_SOS > WATER_LEAK > CLIMATE > NO_MOTION`（GAS/SMOKE 保留给厨房）。

### 8.5 JSON water 合同（新增，仅卫生间节点输出）

```
"sensors":{"water":{"wet":bool,"valid":bool}, ...}
```

- 仅在 `CONFIG_NODE_WATER_GPIO >= 0` 时输出；**本轮卫生间禁用（-1）→ 不输出该段**。
- `wet=true`：已确认漏水；`valid=false`：本次读数无效（不据此清除告警）。
- **厨房节点不输出 water 段**（编译期条件），厨房 JSON 与之前完全一致。
- 兼容性缺口：public-sync 的 adapter 与 DAYU HAP 尚未适配 `sensors.water`（严格校验可能拒收/忽略）；**本轮未修改它们**。在消费者兼容任务完成前，`water` 字段不能声称已在 DAYU/公网展示。

### 8.6 构建与烧录（用户后续执行，本轮未执行）

```powershell
# 仅编译（Bathroom profile 独立输出 build-bathroom 与 .local/sdkconfig.bathroom，不覆盖 kitchen）
powershell -ExecutionPolicy Bypass -File .\flash_esp32.ps1 -Profile Bathroom -BuildOnly

# 完整构建 + 烧录（WiFi 密码隐藏输入；烧录前只读 chip_id 并要求输入 COM 确认）
powershell -ExecutionPolicy Bypass -File .\flash_esp32.ps1 -Profile Bathroom
```

> 明天三块板分别烧 Kitchen / Bathroom / 第三块固件：Bathroom 与 Kitchen 使用不同 build 目录与不同 sdkconfig，互不覆盖。

