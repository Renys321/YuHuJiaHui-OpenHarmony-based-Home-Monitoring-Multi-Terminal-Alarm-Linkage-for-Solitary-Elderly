# 三节点硬件、接线与烧录

适用代码：`firmware/`，公共源码在 `common/components/elder_node/`，三个节点工程各有一份同步副本。

这份文档只写已经确认的东西。凡是没在实物上量过、没在板子上跑过的，都会标成“未实测”。写报告或演示时不要把这些条目当成已验证能力。

## 0. 以哪份配置为准

| 内容 | 位置 |
|---|---|
| 公共源码 | `firmware/common/components/elder_node/` |
| 节点差异 | `firmware/<kitchen\|bathroom\|living>/sdkconfig.defaults` |
| 配置项说明 | 各工程 `main/Kconfig.projbuild` |
| 构建/烧录 | `firmware/tools/build-node.ps1` |
| 旧工程 | `competition/esp32-node/` 只作历史证据，不要拿来重建在板固件 |

旧 `competition/esp32-node/profiles/*` 和新配置已经对不上：旧厨房 profile 里 PIR、门磁还是 -1，MQ-5 还写在 GPIO9（和语音 I2S 冲突），网关 IP 也是旧网段。照着旧 profile 重建会丢功能，或者直接被 `voice_pins.h` 拦住。

## 1. 三块板

| 项 | 厨房 | 卫生间 | 客厅 |
|---|---|---|---|
| 工程目录 | `kitchen` | `bathroom` | `living` |
| deviceId | `esp32-kitchen` | `esp32-bath` | `esp32-living` |
| 房间 | 厨房 | 卫生间 | 客厅 |
| 板卡 | DNESP32S3，16 MB Flash | DNESP32S3，16 MB Flash | Xnv ESP32-S3 N16R8，16 MB Flash |
| MAC | `10:51:db:85:d3:e8` | `14:c1:9f:42:dd:b4` | `30:30:f9:08:76:84` |
| 当前串口 | COM14 | COM5 | COM8 |
| 在板状态 | 在板运行 | 在板运行 | 候选板，未部署 |
| 能做什么 | 温湿度、烟雾、燃气、人体、门磁、KEY0 求助、语音+蜂鸣+LED | 温湿度、人体、SOS 按键、门磁、语音+蜂鸣+LED | 温湿度、人体、门磁、SOS；无语音、无蜂鸣、无灯 |

串口号不是身份。插拔顺序、USB 口和驱动枚举都会改变 COM 号，烧录前按 MAC 核对。

三块板跑同一份代码，差异只在 `sdkconfig.defaults`。构建产物各自落在 `*/build/`，互不覆盖。

## 2. 引脚和外设

### 2.1 厨房

| 外设 | 连接 |
|---|---|
| AHT20 | I2C1，SDA=IO4，SCL=IO5 |
| PIR | IO38，高电平表示有人 |
| 门磁 | 配置为 IO37，`OPEN_LEVEL=1` |
| 实体求助 | 板载 KEY0，XL9555 `P1_7`，低电平按下；`SOS_GPIO=-1` |
| 蜂鸣器 | 板载，XL9555 `P0_3`，低有效；`BUZZER_GPIO=-1` |
| MQ-2 烟雾 | AO 经分压接 IO6 = ADC1_CH5 |
| MQ-5 燃气 | AO 经分压接 IO7 = ADC1_CH6 |
| 本地语音 | MCLK=IO3、BCLK=IO46、LRCK=IO9、DOUT=IO10 |
| 板载咪头 | ES8388 ADC → I2S DIN=IO14，只在录音窗口启用 |
| 功放使能 | XL9555 `P0_2` |
| 告警 LED | IO1，低电平点亮 |
| 水漏 | 当前禁用（`WATER_GPIO=-1`） |

注意：历史接线文档里厨房门磁写的是 IO2，现在 `sdkconfig.defaults` 是 37。在板固件和实物线未必已经跟着改，烧录或改线前必须看现场。

### 2.2 卫生间

| 外设 | 连接 |
|---|---|
| AHT20 | I2C1，SDA=IO4，SCL=IO5 |
| PIR | IO36（只输入脚） |
| 门磁 | 配置为 IO37，`OPEN_LEVEL=1` |
| SOS 按键 | IO15，内部上拉，按下为低 |
| 蜂鸣器 | 板载，XL9555 `P0_3` |
| 本地语音 / 咪头 | 同厨房 |
| 告警 LED | IO1，低电平点亮 |
| 水漏 | 预留 IO37 已被门磁占用，当前禁用 |

卫生间原文档也把门磁写成 IO2，同样要以当前配置和实物为准。

SOS 不要用 IO35。IO35 是只输入脚，内部上拉不可靠，实测容易误触发。

### 2.3 客厅（候选板，未部署）

| 外设 | 连接 |
|---|---|
| DHT11 | DATA=IO11，DATA 用 4.7k–10k 上拉到 3V3 |
| PIR | IO4（电平未实测） |
| 门磁 | IO5，`OPEN_LEVEL=1`（NO/NC 类型未实测） |
| SOS | IO6，内部上拉，按下为低 |
| 蜂鸣器 / 语音 / LED | 均未启用 |

这块不是 DNESP32S3，没有 XL9555、ES8388、板载蜂鸣器，也不能照搬厨房/卫生间的板载外设配置。

门磁接法要先量通断：现行 `OPEN_LEVEL=1` 只适配“常开、移开导通”的接法；常闭型直接接会一直显示开门。

12 V 水浸探头不能直接进 GPIO，必须经继电器或光耦隔离。

## 3. 供电和共因风险

所有外设与 ESP32 必须共地。任何模块输出在接 GPIO 前都要确认不超过 3.3 V。

| 项 | 要求 |
|---|---|
| 板子供电 | USB 5 V 或外部 5 V |
| MQ-2 / MQ-5 | 独立 5 V / 1 A，加热丝约 300 mA，不能由 3.3 V 引脚带 |
| 传感器电平 | PIR、门磁、水漏、AHT20、DHT11 都按 3.3 V 设计 |
| 音频 | 板载 ES8388 和功放由板卡供电，功放使能后等 60 ms 再送数据 |

一个原因导致多个节点同时失效的情况：

| 共因 | 影响 |
|---|---|
| 厨房和卫生间共用同一个 Wi-Fi AP | 两个节点会同时断更；此前实测过一次，12–14 秒后自动重连，数据空档 32–34 秒 |
| 只有一台 PC 跑 bridge 9101 | bridge 退出或 PC 休眠，所有网络节点一起失联 |
| XL9555 同时管 KEY0、蜂鸣器和功放 | I2C0 或扩展器故障时，求助键、蜂鸣、语音一起失效 |
| 三个工程共用同一份源码 | 一次错误修改会同时影响三块板，必须分别构建、分别核对 |
| 网关 IP 由 DHCP 分配 | PC 换网后 `NODE_GW_HOST` 失效，先核对当前 WLAN IPv4 |
| MQ 传感器未老化、未标定 | 读数会整体漂移，阈值 900/700 只是工程值 |

### 引脚冲突红线

| 引脚 | 说明 |
|---|---|
| IO3 / IO9 / IO10 / IO46 | 语音 I2S，不能当普通 GPIO |
| IO14 | 板载咪头 I2S DIN，不能给传感器 |
| IO41 / IO42 | 板载 I2C0（XL9555/ES8388），没有引到排针 |
| IO0 | BOOT 绑带脚，上电按住会进下载模式，不能做求助键 |
| IO19 / IO20 | USB |
| IO26–IO37 | Flash/PSRAM 相关段，不要外接 |

MQ 的 AO 必须先分压。常用接法是 2k 串 1k 下地，分压后约为 AO 的三分之一：

```text
MQ AO ── 2k ──┬── ESP32 ADC（IO6 / IO7）
              │
             1k
              │
             GND
```

厨房 MQ-5 必须接 IO7/ADC1_CH6。语音改造后 IO9 被 I2S LRCK 占用，不能再接 MQ-5。编译期检查只能拦住配置冲突，拦不住“代码改了、线没搬”。

厨房不要插 P2 摄像头：OV_D0/D1 是 IO4/IO5（AHT20 在用），OV_D2 是 IO6。

## 4. 网络

| 项 | 值 |
|---|---|
| Wi-Fi | ElderCareLab，2.4 GHz |
| 网关 | `10.127.130.179:9101` |
| 协议 | TCP 上的 JSON 行协议；节点不实现 MQTT |
| 云端主题 | `home/<deviceId>/status` |

`NODE_GW_HOST` 会被 DHCP 改掉。节点连不上网关时，第一步先核对 PC 当前 WLAN IPv4 和三份 `sdkconfig.defaults` 里的地址是否一致。

闪存和分区：

| 项 | 厨房 | 卫生间 | 客厅 |
|---|---|---|---|
| Flash | 16 MB | 16 MB | 16 MB |
| app 分区 | 4 MB（`partitions.csv`） | 4 MB（`partitions.csv`） | 默认单 app 分区 |
| 当前构建体积 | 1,168,720 B | 1,157,728 B | 本次未重建 |
| 构建目录 | `kitchen/build` | `bathroom/build` | `living/build` |

厨房和卫生间扩到 4 MB app 后，余量约 72%，不再有之前 1 MB 分区的空间压力。客厅仍用默认分区表，以后加语音前要先确认分区够不够。

## 5. 烧录

### 5.1 准备

1. 确认 ESP-IDF v5.1.6 可用：`D:\Espressif-5.1.6\frameworks\esp-idf-v5.1.6\export.ps1`。
2. 只插一块目标板，避免认错。
3. 核对 `NODE_GW_HOST` 是 PC 当前地址。
4. Wi-Fi 口令只写 `firmware/.local/wifi.<node>.defaults`，不要出现在命令行、文档或截图里。三份 `sdkconfig.defaults` 里只有 `YOUR_WIFI/YOUR_PASSWORD` 占位符。

`build-node.ps1 -Ssid` 不带 `-Pass` 时会隐藏输入，也不会把口令写进 argv。共享机器上优先用 `.local` 文件。

### 5.2 先核对 MAC

```powershell
. 'D:\Espressif-5.1.6\frameworks\esp-idf-v5.1.6\export.ps1'
python -m esptool --chip esp32s3 -p COM14 chip_id
```

| 节点 | 期望 MAC |
|---|---|
| 厨房 | `10:51:db:85:d3:e8` |
| 卫生间 | `14:c1:9f:42:dd:b4` |
| 客厅 | `30:30:f9:08:76:84` |

`build-node.ps1 -Action flash` 会自己读 `chip_id` 并和脚本里的期望 MAC 比对；不一致默认中止。换板或换口确实需要放行时才加 `-AllowMacMismatch`。人工再核对一次丝印不亏。

### 5.3 构建

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File <WORKSPACE>\competition\firmware\tools\build-node.ps1 -Node kitchen
```

卫生间、客厅把 `-Node` 换掉即可。脚本会打印 bin 大小和 SHA-256，记下来，写后核对和回滚都用得上。

注意两点：

- 如果从 Git Bash 里调 PowerShell，先执行 `Remove-Item Env:MSYSTEM -ErrorAction SilentlyContinue`，否则 IDF 的 `export.ps1` 会把它识别成 MSys 环境并拒绝初始化。
- 改过 `sdkconfig.defaults` 后，先删掉该工程的 `sdkconfig` 再构建，否则旧配置不会更新。

### 5.4 烧录

脚本方式：

```powershell
... -Node kitchen -Action flash -Com COM14
```

`idf.py flash` 会写 bootloader、分区表和 app，但不会整片擦除，NVS 里的门磁 seq 和 Wi-Fi 凭据会保留。

只换 app、不想动 bootloader 和分区表时，可以手动写 0x10000：

```powershell
# 先备份当前 app
python -m esptool --chip esp32s3 -p COM14 read_flash 0x10000 0x400000 .\device-backup\COM14-app-before-<日期>.bin
# 再写新 app
python -m esptool --chip esp32s3 -p COM14 write_flash 0x10000 .\kitchen\build\esp32_elder_node.bin
```

成功时会出现 `Hash of data verified.`。绝对不要用 `erase_flash`，也不要把整片镜像写到别的板子上。

### 5.5 回滚

把之前备份的 app 写回 0x10000 即可：

```powershell
python -m esptool --chip esp32s3 -p COM14 write_flash 0x10000 .\device-backup\COM14-app-before-<日期>.bin
```

备份文件名里的 COM 号是当时的端口，不代表现在。回滚前同样要核对 MAC。

## 6. 写后检查

### 串口启动日志

```powershell
... -Node kitchen -Action monitor -Com COM14
```

正常应看到：

```text
I elder-node: ESP32-S3 无线节点启动：esp32-kitchen / 厨房
I elder-node: 门磁已配置 GPIO37（...）
I local-led: 板载 LED 就绪：GPIO1 ...
I local-voice: READY playback+mic ...
I elder-node: 连接 WiFi: ElderCareLab
I elder-node: 已获取 IP: ...
I elder-node: 已连接网关 10.127.130.179:9101
I elder-node: → {"deviceId":"esp32-kitchen", ...}
```

出现以下情况要停下来查：`no boot alarm` 缺失、`local-voice` 不是 READY、反复重连 Wi-Fi、连上网关后立刻断开。

### 网关和 MQTT

```powershell
netstat -ano | Select-String ':9101'
```

厨房和卫生间各应有一条 ESTABLISHED。客厅未部署时没有第三条。

```powershell
D:\Node\node.exe <WORKSPACE>\competition\bridge\mqtt_tool.js `
  sub --broker 127.0.0.1:1883 --topic "home/esp32-kitchen/status" --seconds 30
```

30 秒内应有 5–6 条，`ts` 单调递增，字段完整。不要用 `pub` 做现场测试。

### 端到端新鲜度

报文 `ts` 是 13 位毫秒。和主机时间对比，差值应在百毫秒级。ESP32 时钟可能比主机快几十到上百毫秒，看到 -100 ms 左右的“负延迟”是时钟差，不是乱序。

## 7. 未实测清单

| 条目 | 现状 | 影响 |
|---|---|---|
| 厨房 GAS/SMOKE 真实气体触发 | 未实测，安全规则禁止明火/放气 | 只能说“低于阈值不误报”，不能说“能检测到燃气” |
| MQ-2/MQ-5 浓度标定 | 未标定，只报 0–4095 原始值 | 不能出现 ppm、浓度或“燃气安全”字样 |
| 厨房 NO_MOTION 现场触发 | 配置已开，未现场观察 | 可以说具备能力，不能说已验证会报 |
| 客厅 IO1 指示灯 | `LED_GPIO=-1`，该板是否有灯未实测 | 不要声称客厅有告警灯 |
| 客厅 PIR / 门磁 / SOS | 全部未实测 | 不能写“客厅已具备人体/门磁/求助能力” |
| 客厅门磁极性 | 只适配常开接法 | 接错会长期显示开门或关门 |
| 客厅 MAC | 来自一次只读识别 | 烧录前重读 |
| 客厅联网/注册 | 从未配置 | 不能计入全屋在线 |
| 卫生间水漏 | 硬件未装 | 不能说具备漏水监测 |
| 门磁扩展字段上云 | 固件已上报 `lastCloseTs/seq/events`；公网链路是否接受未验证 | 云端门磁事件是否可用要看 bridge/后端，不是固件单方面能保证 |
| 语音音量 30 | 寄存器 30 约为 0 dB，上限 33 | 再大可能削顶，不要盲目加 |
| 三节点时钟偏差 | 厨房约 +15 ms，卫生间约 +130 ms | 跨节点对账要扣掉 |

## 8. 证据索引

| 内容 | 文档 |
|---|---|
| 厨房接线和验收 | `competition/docs/evidence/2026-10-20-kitchen-esp32-node-acceptance.md` |
| 卫生间阶段 1 引脚 | `competition/docs/evidence/2026-10-20-bathroom-esp32-stage1-source.md` |
| 厨房 PIR 加装 | `competition/evidence/2026-10-27-voice-led-restore/KITCHEN-PIR-PLAN.md` |
| 厨房 PIR 刷写 | `competition/evidence/2026-10-27-voice-led-restore/KITCHEN-PIR-FLASH-RECORD.md` |
| PIR/门磁/水漏/MQ 审计 | `competition/evidence/2026-10-27-real-capability-app/hardware/PIR-DOOR-AUDIT.md` |
| MQ-5 从 GPIO9 迁到 GPIO7 | `competition/evidence/2026-10-28-fullchain-health/GAS-MQ5-DIAGNOSIS.md` |
| 阈值 900/700 启用 | `competition/evidence/2026-10-28-fullchain-health/GAS-ALARM-ENABLE-20261028.md` |
| 两节点同时断连和自愈 | `competition/evidence/2026-10-28-fullchain-health/nodes/FINDINGS.md` |
| 卫生间语音+LED+门磁刷写 | `competition/evidence/2026-10-27-voice-led-restore/BATH-FLASH-RECORD.md` |
| 客厅识别、接线、DHT11 bench | `competition/docs/evidence/2026-10-23-com8-identification.md`、`...-living-wiring-and-firmware-prep.md`、`...-dht11-bench-pass.md` |
