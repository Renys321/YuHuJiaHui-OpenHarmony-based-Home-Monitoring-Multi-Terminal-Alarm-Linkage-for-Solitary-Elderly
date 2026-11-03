# 卫生间 ESP32-S3 板载语音播放与基础运行回归（BATHROOM-LOCAL-VOICE）

日期：2026-10-26
范围：只涉及卫生间 COM4；未操作 COM5（厨房）、COM8、COM11（DAYU）。
结论：**BATHROOM_VOICE_PLAYBACK_AND_BASIC_REGRESSION_PASS**
（= 卫生间板载本地语音播放 + 真实试听 + 栈修复验证 + 传感器采样 + 自然上报 +
基础运行稳定性通过。不代表声光联动、真实 SOS/ACK、断网求助闭环已完成。）

## 1. COM4 身份核对

- Windows PnP：`USB\VID_1A86&PID_7523\7&25042a44&0&2`，USB-SERIAL CH340，
  状态 Started；同 hub 下另有 COM5（厨房，本轮从未打开）。
- esptool 4.7.0 只读读取（身份核对阶段未烧录）：
  - Chip: ESP32-S3 (QFN56) revision v0.2，40 MHz 晶振，Embedded PSRAM 8MB。
  - MAC: `14:c1:9f:42:dd:b4`（与其他启动日志中的 `wifi: sta` 一致）。
  - Flash: 16 MB（manufacturer 0x5e / device 0x4018），eFuse flash 类型 quad。
  - 安全状态：Secure Boot Disabled、Flash Encryption Disabled、
    SPI_BOOT_CRYPT_CNT=0。
- 固件自报身份（启动日志）：`elder-node: ESP32-S3 无线节点启动：esp32-bath / 卫生间`。
- 与既有可信记录交叉核对：读取的 factory 应用分区前 775,616 字节与历史记录
  `bathroom-8D4E9A26.bin`（SHA-256 `8D4E9A26…02CE`）逐字节相同，说明本轮 COM4
  上运行的就是历史验收记录中的卫生间应用镜像。仓库无独立 MAC 白名单，身份结论
  由“PnP 端口 + 芯片/MAC + 固件 deviceId/room + 历史镜像内容一致”共同支撑。

## 2. 实机备份（私有，含网络配置，禁止分发）

位置：`esp32-node\.local\bathroom-voice-20261026\backup\`（受控私有目录）

| 备份 | 大小 (B) | SHA-256 |
|---|---:|---|
| 全片 Flash `bathroom-COM4-fullflash-20261026.bin` | 16,777,216 | `D905C86C5B58130A8C65171C55F9C85FF53B632419E3E70158ADE0D7913F4E9B` |
| 原应用分区（0x10000,1 MB）`bathroom-COM4-app-original-0x10000.bin` | 1,048,576 | `1FDE4DF95929C0B8264D227066D3E55D7FBCE5860AAC1DB037CCDEB23F5D90A0` |
| 原分区表二进制 `partition-table-0x8000.bin` | 4,096 | 见 `BACKUP-AND-IDENTITY.md` |

- 实测分区表（0x8000 读出并解码）：`nvs 0x9000 24K`、`phy_init 0xf000 4K`、
  `factory app 0x10000 1M`；与既有单 app 配置一致，无 OTA 分区。
- 恢复方式（仅应用分区，本轮未使用）：`write_flash --verify 0x10000 <原应用备份>`；
  完整说明见 `BACKUP-AND-IDENTITY.md`。
- 历史 `bathroom-8D4E9A26.bin` 只作比对，不代替本轮实机备份。

## 3. 两个候选（详见 BUILD-MANIFEST.md）

| 候选 | 大小 (B) | SHA-256 | 主任务栈 | 音量寄存器 | 启动试听 |
|---|---:|---|---:|---:|---|
| 试听（最终）`listening-v30` | 1,040,080 | `B0CF170E…BD79` | 8192 | 30 (0 dB) | 有，仅一次 |
| 正常（最终）`normal-v30` | 933,024 | `93C9A7A2…A11C` | 8192 | 30 (0 dB) | 无 |
| （过程）试听 `listening-v20` | 1,040,096 | `83E1FE48…8350` | 8192 | 20 (-15 dB) | 有，仅一次 |
| （过程）正常 `normal-v20` | 933,040 | `A6ABAF56…19B6` | 8192 | 20 (-15 dB) | 无 |

- 公共源码未被本任务修改；改动只发生在独立工作副本
  `esp32-node\.local\bathroom-voice-20261026\src\`，差异补丁
  `bathroom-voice-volume30.patch`（local_voice.c 去掉固定 PCM /2；
  Kconfig 音量范围 0..33 并写明 dB 含义；新增 `profiles/voice-volume30.sdkconfig.defaults`）。
- 每型候选均核对：deviceId=`esp32-bath`、room=卫生间、PIR=GPIO36、SOS=GPIO15、
  AHT20 I2C1 GPIO4/5、MQ/门磁/水漏保持禁用、BOOT_TEST 开关、体积 < 1 MB 应用分区、
  `image_info` 校验 valid、源码哈希与构建对应。
- 主机侧回归：告警逻辑 54/54、卫生间逻辑 54/54、房间配置 3/3、厨房接线 1/1、
  引脚冲突用例 6/6（卫生间语音组合通过，音频引脚冲突组合被编译期拒绝）。

## 4. 写入记录

- 只写应用分区：`esptool … write_flash --verify 0x10000 <bin>`；未 `erase_flash`，
  未写 bootloader / partition table / NVS；写入后读回校验 digest 一致。
- 试听候选：写入 1,040,080 B，`verify OK (digest matched)`。
- 正常候选：写入 933,024 B，`verify OK (digest matched)`；随后独立读回
  0x10000 起 1 MB，前 933,024 字节与 normal-v30 逐字节相同
  （整段读回 SHA-256 `6C4C2D0B…B5B1`）。
- 设备物理 Flash 16 MB，而既有 bootloader/镜像头按 2 MB 约定运行（烧录前日志
  已证实 `SPI Flash Size : 2MB` / image header 2MB），本轮保持既有约定，
  未改 Flash 参数、未整片擦除。

## 5. 真实试听反馈（用户确认）

- V20（寄存器 20 = -15 dB，PCM 固定 /2）：能听到完整语句，但**偏小**。
- 定位（非功放/扬声器供电故障；板载功放使能 P0_2 正常且能出声）：
  PCM 源峰值 -0.79 dBFS 已接近满幅，代码固定 /2 再损失 6 dB；ES8388 喇叭输出
  LOUT2/ROUT2 寄存器 0x30/0x31=20 按数据手册仅 -15 dB（0x1E=30 为 0 dB，
  0x21=33 为 +4.5 dB 最大）。合计约 -22 dBFS 峰值。
- 经用户明确授权（临时超过原 Kconfig 上限 20，但停在 0 dB、未到最大、未加功放增益）：
  去掉 PCM /2 + 寄存器 30（0 dB），总 +15 dB。
- V30 试听反馈：**能听清、音量够用、无破音/杂音**；未再继续加大。
  最终正常候选沿用同一音量配置。

## 6. 栈溢出处理与稳定性证据

- 历史构建目录（含 `build-voice-bathroomlistening-private`）sdkconfig 仍为
  `CONFIG_ESP_MAIN_TASK_STACK_SIZE=3584`，证实“只改 defaults 不等于旧构建目录生效”。
- 本轮两类候选都用**全新独立干净构建目录**，并在生成的 `sdkconfig` 和
  `config/sdkconfig.h` 中实际读到 `CONFIG_ESP_MAIN_TASK_STACK_SIZE=8192`。
- 未关闭栈保护/看门狗，未改 panic 行为（均为 ESP-IDF 默认）。
- 板端栈余量实测：
  - `main`：8192 中剩余 4068 B（所有窗口全程恒定）；
  - `local-voice`：4096 中剩余 1088 B（播放结束采样）；
  - `gateway-net`：6144 中剩余 2732–2908 B。
- 稳定性窗口（串口采集，只保存白名单行，SSID/IP/BSSID 脱敏）：
  - V20 试听：356.5 s、66 条上报；无 panic/看门狗/重启；启动语音仅 1 次。
  - V30 试听：372.8 s、69 条上报；`PLAY` 启动后 0 次，无异常。
  - **最终 normal-v30（网络在线窗口）：372.9 s、69 条上报，`ts` 严格递增
    （0 条 `ts=0`），`PLAY` 0 次（启动无诊断语音），0 次 WiFi 断开、0 次重启/
    panic/看门狗，AHT20 全程 valid。**
- 非致命观察（与历史基线一致的启动期行为）：启动时 WiFi 可能先出现
  reason=202/205 断开重连；语音启用后个别启动出现
  `phy: error: pll_cal exceeds 2ms!!!` 警告，未影响功能，无 panic/重启。

## 7. AHT20 / PIR / 自然上报（本轮实际结果）

- AHT20：所有窗口 `valid=true`、`ok=true`；最终窗口 25.5→24.7 °C、58.4→53.5 %RH。
- PIR：串口持续输出“检测到活动”，窗口内 `countToday` 随实际走动增长
  （最终窗口 4→35）；未把计数不变当作 PIR 失效。
- 自然上报（设备串口 + 网关 + MQTT 只读三层证据）：
  - 最终正常候选 372.9 s 窗口：每 5 s 一条 status JSON，`ts` 严格递增
    （1792952… 序列，跨度 372.89 s），期间无断线。
  - 网关：TCP 已连接（启动日志 `已连接网关`），Bridge 9101 同时持有厨房与
    卫生间两条连接（<node-ip> 与 <node-ip>）。
  - **MQTT 只读订阅（<ip>:1883，仅 CONNECT/SUBSCRIBE/PINGREQ，从不发布）**：
    订阅 `home/esp32-bath/status` 45 s 收到 9 条，全部 **retain=0**，
    `ts` 严格递增（1792952687345→1792952731235，跨度 43.89 s），state=NORMAL。
    未使用任何 retained 快照作为持续上报证据。
  - 过程记录：02:00–02:20 曾出现本节点被 AP 持续拒绝关联（reason=2/201/205，
    0 次获取 IP），PC 与另一节点在线；EN 复位与 120 s 复位冷却均未恢复，
    **按用户指示把卫生间板 USB 整口重新插拔后**恢复：获取 IP、连接网关、
    NTP 同步，且与厨房节点同时在网。该现象判定为板端/CH340 侧瞬时关联状态
    问题（非候选固件：同一固件栈此前已正常联网 372 s，且复位无法恢复、
    重新上电即恢复）；App 侧期间短暂离线，不影响本地语音/采样。
- 未改 Wi-Fi/AP/backend/绑定/DNS；未重启 Broker/Bridge；未手工发布 MQTT、
  未发 HTTP ingest。

## 8. 最终留在卫生间板上的固件

- `normal-v30`：933,024 B，
  SHA-256 `93C9A7A2786210EB312D53261D5653C0212536DB8952CC5B99C5629D03C5A11C`，
  写入偏移 0x10000，写入校验通过，独立读回逐字节一致。
- 配置：语音启用、启动诊断语音关闭、音量寄存器 30（0 dB）、主任务栈 8192、
  deviceId/room/传感器引脚与既有部署一致；当前设备已自然上报（MQTT retain=0）。
- 试听镜像与备份仅在 `.local` 私有目录，未进入可分发证据。

## 9. 失败与回退

- 本任务**未触发关键失败，未执行固件回退**；原应用分区/全片备份与恢复命令已就绪。
- 现场问题一：开始时 COM4 无法打开（Windows error 31，CH340 端点挂起），
  请用户重新插拔后恢复；未强杀进程、未操作其他串口。
- 现场问题二：02:00–02:20 AP 持续拒绝本节点关联（详见第 7 节），
  经 USB 整口重新插拔后恢复，非固件问题，因此未回退。

## 10. 未测项目（不得当作已通过）

- 真实 SOS / FALL 触发、ACK/reset 命令、告警语音与蜂鸣器同时工作、声光联动。
- DAYU 告警下发为卫生间广播、断网求助与恢复闭环、公网/OneNET 链路。
- 告警语音（sos/warning PCM）的真实响度与清晰度：本轮只试听了诊断语句。
- 麦克风/录音/网络 TTS（明确未开启）、任意 URL 播放（未实现）。
- 长于约 6 分钟的持续稳定性、断电/复电、长期老化、批量节点。
- 真实环境告警下的音频与采样并发压测。

## 11. 厨房、DAYU 与证据隔离

- 全程只操作 COM4；未打开/复位/烧录 COM5、COM8、COM11。
- 未停止厨房串口观察器或构建进程；未修改厨房接线/固件/构建目录。
- 构建使用卫生间独立构建目录，未覆盖 `2026-10-26-local-speaker-candidate` 的证据与清单；
  未运行会覆盖厨房证据的公共归档脚本。
- 未修改公共 `main/local_voice.c`、`node_main.c`、`voice_pins.h` 或公共构建脚本
  （公共树哈希见 `build/PUBLIC-TREE-HASHES-AFTER.txt`）；改动全部在私有副本并以补丁交付。
- 未改 Wi-Fi/AP/backend/绑定/DNS；未手工发布 MQTT、未发 HTTP ingest；
  未触发 SOS/FALL/ACK/reset；未改 DAYU ALARM；未重启 Broker/Bridge。
  （注：只读订阅时短暂连接 MQTT broker 读取消息，未发布任何内容。）

## 附：证据文件

- `BACKUP-AND-IDENTITY.md`、`BUILD-MANIFEST.md`、`bathroom-voice-volume30.patch`
- `build/`：构建日志、源码哈希、公共树哈希、实际分区表
- `logs/`：脱敏后的启动/稳定性/复检/烧录日志，以及 MQTT 只读订阅记录
- `host-tests/`：告警逻辑 54/54、卫生间逻辑 54/54、房间配置与引脚冲突用例结果
