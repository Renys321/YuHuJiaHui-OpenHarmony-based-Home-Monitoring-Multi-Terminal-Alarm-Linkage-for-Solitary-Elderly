# ESP32-S3 三节点固件

厨房、卫生间、客厅各有一个独立的 ESP-IDF 工程，打开对应目录就能编译、烧录。三份代码内容相同，差异只在各自的 `sdkconfig.defaults`。

```
firmware/
├── kitchen/                     # 厨房节点工程
│   ├── .vscode/settings.json    # ESP-IDF 插件配置（IDF 路径、串口）
│   ├── main/                    # 源码副本 + voice/ 语音资源
│   ├── CMakeLists.txt
│   ├── sdkconfig.defaults       # 厨房引脚、身份、阈值
│   ├── partitions.csv           # 4 MB app 分区
│   └── README.md                # 该节点接线与烧录说明
├── bathroom/                    # 卫生间节点工程
├── living/                      # 客厅候选板工程（未部署）
├── common/components/elder_node/  # 源码母本，改完用 tools/sync-shared.ps1 同步
├── docs/                        # 代码讲解、硬件接线、构建记录
└── tools/
    ├── build-node.ps1           # 构建 / 烧录 / 监视
    └── sync-shared.ps1          # common → 三个工程 main/
```

## 源码结构

`node_main.c` 现在只保留流程编排：上电初始化、100 ms 主循环、传感器采样、告警状态机、命令分发和上报拼装。其余部分按职责拆开：

| 文件 | 内容 |
|---|---|
| `node_main.c` | `app_main()`、`sample()`、`judge()`、`report()`、`handle_command()`、定向播报 |
| `board_io.c` | XL9555 读写、蜂鸣器、KEY0/KEY1、PIR/SOS/水漏 GPIO |
| `wifi_link.c` | Wi-Fi 事件处理、SNTP |
| `gw_link.c` | TCP JSON 行收发、网关任务、串口命令任务 |
| `climate.c` | AHT20 / DHT11 |
| `door_monitor.c` | 门磁消抖、事件缓存、NVS seq、door JSON |
| `announce.c` | 短提示音 → 完整语音的时序 |
| `local_voice.c` / `mic_link.c` / `speaker_link.c` | 本地播放、板载咪头上传、AI 音箱通路 |
| `local_led.c` | 告警灯效 |
| `alarm_logic.h` / `notice_logic.h` / `battery_logic.c` | 纯判定逻辑，可脱离硬件做主机测试 |

## 三节点对照

| | 厨房 `esp32-kitchen` | 卫生间 `esp32-bath` | 客厅 `esp32-living` |
|---|---|---|---|
| 工程目录 | `kitchen/` | `bathroom/` | `living/` |
| 板卡 | DNESP32S3 | DNESP32S3 | Xnv ESP32-S3 N16R8 |
| 温湿度 | AHT20 (I2C 4/5) | AHT20 (I2C 4/5) | DHT11 (GPIO11) |
| 人体 / 门磁 / 求助 | PIR38 / GPIO37 / 板载 KEY0 | PIR36 / GPIO37 / SOS15 | PIR4 / GPIO5 / SOS6 |
| 燃气 / 烟雾 | MQ-5(CH6) / MQ-2(CH5) | 无 | 无 |
| 语音 / 咪头 | 有 / 9303 | 有 / 9303 | 无 |
| 告警 LED | GPIO1 | GPIO1 | 无（配置 -1） |
| 状态 | 在板运行 | 在板运行 | 候选板，未烧录 |

串口号会随 USB 口和驱动枚举变化，烧录前应按 MAC 核对，详见 `docs/NODES.md`。

## 构建与烧录

```powershell
# 只构建，不碰串口
powershell -NoProfile -ExecutionPolicy Bypass -File tools\build-node.ps1 -Node kitchen

# 首次构建时写入 Wi-Fi（不带 -Pass 会隐藏输入，写到 .local/，不入库）
powershell ... -File tools\build-node.ps1 -Node kitchen -Ssid ElderCareLab

# 烧录（脚本先读 chip_id 比对 MAC，只写 app 分区）
powershell ... -File tools\build-node.ps1 -Node kitchen -Action flash -Com COM14

# 串口监视
powershell ... -File tools\build-node.ps1 -Node kitchen -Action monitor -Com COM14
```

也可以进入工程目录直接 `idf.py build`。改过 `sdkconfig.defaults` 后要先删该工程的 `sdkconfig` 再编译，否则新默认值不会生效。

如果从 Git Bash 里调用 PowerShell 脚本，先清掉 `MSYSTEM` 环境变量，否则 ESP-IDF 的 `export.ps1` 会把它当成 MSys 环境拒绝初始化：

```powershell
Remove-Item Env:MSYSTEM -ErrorAction SilentlyContinue
```

## 读代码的顺序

1. `docs/CODE-WALKTHROUGH.md`：模块分工、启动流程、协议和状态机。
2. `node_main.c` 的 `app_main()`，再看主循环。
3. 纯判定逻辑在 `alarm_logic.h` / `notice_logic.h` / `battery_logic.c`。
4. 硬件差异只看各节点的 `sdkconfig.defaults`。

## 配置与文档

| 文档 | 内容 |
|---|---|
| `docs/CODE-WALKTHROUGH.md` | 代码结构、启动、上报、告警、门磁、命令、语音、电池 |
| `docs/NODES.md` | 三节点接线、供电、共因风险、烧录与回滚 |
| `docs/BUILD-VERIFY.md` | 最近一次构建的结果和复现命令 |
| `<node>/README.md` | 单节点引脚表、配置项、烧录说明、已知限制 |

## 当前构建（2026-11-01，未烧录）

模块拆分后重新构建了两个语音节点：

| 工程 | 体积 | SHA-256（前 16 位） |
|---|---|---|
| kitchen | 1,168,720 B | `2C0871A52F0496BE` |
| bathroom | 1,157,728 B | `E9DA17FC301A85D7` |

这两个 bin 没有写进板子；在板固件仍是之前的版本。源码与板子上的固件不一致，这一点在演示和验收时要说明。客厅本次没有重新构建。

## 约定与边界

1. 公共代码先改 `common/components/elder_node/`，再执行 `tools\sync-shared.ps1`，否则三份副本会漂移。
2. 不要提交 `build/`、`sdkconfig`、`.local/`。
3. Wi-Fi 口令只放在 `.local/wifi.<node>.defaults`，不要写进仓库或截图。
4. MQ-2/MQ-5 阈值是工程值，没有做 ppm 标定，不能对外说成浓度或“燃气安全”。
5. 客厅是候选板，除 DHT11 外的外设电平都还没实测，接线前先量。
6. 门磁的物理接线历史文档写的是 IO2，而当前 `sdkconfig.defaults` 配的是 GPIO37，烧录前必须实际核对线接在哪。
