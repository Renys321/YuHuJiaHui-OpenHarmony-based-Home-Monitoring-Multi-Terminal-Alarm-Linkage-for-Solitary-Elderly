# COM5 厨房提高音量与主任务栈修复 — 2026-10-26

状态：音量 20 试听版已真实播放并通过 120 秒短时观察，用户确认“比之前大了，没有杂音”。随后已刷入相同音量参数的无启动语音正常运行版；正常版独立观察结果见文末。不能据此宣称完整本地声光告警闭环通过。

## 初次试听的真实结果

用户授权厨房 COM5 试烧，已断电将 MQ-5 从 GPIO9 移至 GPIO7 后重新供电。COM5 MAC 为 50:78:7d:16:ed:60，ESP32-S3，实际 Flash 16 MiB；备份及单 factory 应用分区核验已完成。未操作卫生间 COM4、DAYU COM11、COM8。

第一次真实烧录只写 0x10000 应用镜像，保留 bootloader、分区表、NVS；esptool 写后校验成功。volume15 启动试听镜像为 1,046,608 B，SHA-256 `E602AFBD14729153108E34A1AEB1126C392F0ED26654324B9F8C4D103038AF77`。用户反馈“可以听到声音，但是声音不是很大”。这是用户确认的出声结果，不等于声音响度或完整告警闭环通过。

后续只读串口捕获到 `A stack overflow in task main has been detected`，并重复出现 RTC_SW_SYS_RST、READY、PLAY clip=3。使用与该镜像匹配的 ELF 解码 backtrace，路径包含 `vApplicationStackOverflowHook`。因此初版判为真实运行失败，不能以听到声音代替稳定性验收。

## 修复内容

- 语音覆盖配置的主任务栈从默认 3584 B 改为 8192 B。语音版本新增的命令缓冲及上报嵌套调用是本次主任务栈预算必须覆盖的路径。
- 在采样上报、网络发送、语音播放完成后输出仅含任务名及栈最低余量的诊断；串口观察器只保存白名单字段，不保存任意 UART 原文。
- ES8388 喇叭音量寄存器从 15 改为 20，保持 PCM /2 衰减；没有把配置数值当成百分比或实测分贝，也不声称实际响度提升比例。
- 厨房仍为 MQ-2 GPIO6、MQ-5 GPIO7、AHT20 GPIO4/5；MQ 原始 ADC 报警阈值保持 4096（禁用），未变更网络、设备身份或绑定。
- 试听仍仅播放诊断语句，不触发真实 SOS、FALL、ACK、告警 reset 或人工 MQTT/HTTP ingest。

## 回退边界

全 Flash 与原应用分区备份在 `esp32-node/.local/speaker-backup-2026-10-26-com5/`，包含私有设备配置，不归档或分发。全 Flash SHA-256 为 `7A0E9077C8C9B64313AF010BB23878F624B5464F841578865E459CC1069F9979`，16,777,216 B；原应用分区 SHA-256 为 `AC6CCE540ED528C8F85F2D2EE22C3C7696F6C9099617FA732059A0F026349FC4`，1,048,576 B。

**当前实物 MQ-5 已接 GPIO7。原 GPIO9 固件不能直接视为完整传感器恢复方案；恢复旧固件必须同时安排断电迁线回 GPIO9，或另建保留 GPIO7 的无语音恢复镜像。**

## 验证边界

本地既有告警逻辑 54/54、卫生间逻辑 54/54、房间配置 3/3、厨房接线 1/1、六项引脚保护检查在本次修复后再次通过。它们不代替真实播放、自然 MQTT 上报或告警闭环验收。

## 已完成的修复版构建

两份构建均 exit 0，通过原 factory 1 MiB 应用分区大小校验。生成的 `sdkconfig.h` 已核对主任务栈 8192、音量 20、MQ-5 ADC1_CH6（GPIO7）、MQ-2 ADC1_CH5（GPIO6），两路原始 ADC 报警阈值仍为 4096。

| 私有构建目录 | 大小 | SHA-256 | 本轮状态 |
|---|---:|---|---|
| `esp32-node/build-voice-kitchenlistening-private-v20/esp32_elder_node.bin` | 1,046,992 B | `99672665E2356CAF54F1B895CEFB3D03FD2FD8B04303AFD4F97E1598CE764012` | 已刷入并试听；随后被正常版替换 |
| `esp32-node/build-voice-kitchenvoice-private-v20/esp32_elder_node.bin` | 939,936 B | `A76224A46CC9E6FD737195988B40BE32B861C4AB1E75A9CD26F10F26477DBC11` | 无启动语音；已刷入，当前运行 |

试听镜像仅余 1,584 B 分区空间，正常镜像余 108,640 B；没有扩大分区。两份均包含既有私有部署配置，仅保留本地构建目录，不进入可分发证据归档。构建脚本自动展示的全量烧录命令不得直接使用；真实烧录仅写 0x10000 应用分区。

## 曾发生的连接阻塞（已解除）

完成构建后的 `Get-PnpDevice -Class Ports -PresentOnly`、`.NET SerialPort.GetPortNames()` 与 `HKLM:\HARDWARE\DEVICEMAP\SERIALCOMM` 均无 COM5；后两者及 PnP 可见 COM4、COM11、蓝牙 COM19/COM20。单独 WMI 串口列表在本机不完整，未将其作为唯一依据。本轮未向其他端口尝试写入。

用户随后确认“现在好了”。PnP 和 .NET 列表恢复 COM5；esptool 读取到 MAC `50:78:7d:16:ed:60`，与已备份厨房板一致，因此继续既有试烧授权。未将其他端口替代为厨房。

## 音量 20 真实部署与短时观察

esptool 对应用地址 `0x10000` 写入 1,046,992 B，exit 0，`Hash of data verified`。未写 bootloader、分区表或 NVS，未擦整片 Flash。试听镜像和参数见 `KITCHEN-V20-DEPLOYMENT.json`，后续正常版部署另见文末。

串口观察器打开后仅执行一次 EN 受控重启（不是告警 reset 命令），观察 120 秒：2026-10-26 01:24:46 起（Asia/Shanghai）。

- 仅一次启动标记 `rst:0x1 (POWERON)`；`READY → PLAY clip=3 → STOP result=ESP_OK cancelled=0` 各一次。
- 无 stack overflow、canary、Guru Meditation 或 backtrace 标记，没有重复启动/播放。
- 21 条厨房采样，温湿度、MQ-5 和 MQ-2 原始 ADC 的 valid 均为 true，状态均为 NORMAL；这是实际观察到的设备状态，不代表原始 ADC 已获气体安全标定。
- 最低可用栈：main 4060 B、gateway-net 2732 B、local-voice 1100 B。
- 启动联网阶段有两条 WIFI_DISCONNECTED，随后 WIFI_GOT_IP、GATEWAY_CONNECTED；连接后本观察窗无再次断线标记。
- 初始 5 条采样未校时，deviceTs=0，不用作有效设备时间证据；之后 16 条为已校时且严格递增。

独立只读 MQTT 订阅 70 秒，共 48 条消息：厨房 12、卫生间 13、客厅 23，retained 全部 false。厨房前 5 条时间戳为 0，之后 7 条从 `1792949120559` 增至 `1792949153459`，严格递增；两路 ADC valid=true 且读数自然变化。只读订阅无 publish，未发送 HTTP ingest。客厅本轮自然消息为 NORMAL；本任务未对客厅发送 ACK、reset 或其他状态命令，不把历史 ALARM 当本轮状态。

证据：`KITCHEN-SERIAL-LISTENING-V20.json` 与 `KITCHEN-V20-MQTT-PASSIVE.log`。以上仅证明一次启动诊断播放和两分钟短时运行，未测真实 SOS/FALL、声光告警闭环、断网求助、长时稳定性或手机 APP 回归。用户随后确认“比之前大了，没有杂音”；这证明相对听感改善，不代表测得分贝、跨房间可听性或告警语音逐段验收。旧 `build-verification.json` 仅为早期本地构建清单，其 `flashed=false` 不是当前 COM5 事实。

## 切换无启动语音的正常运行版

用户试听确认后，厨房 COM5 切为 `KitchenVoice` 音量 20 正常运行版，仅关闭启动诊断语音；正常告警播放能力保留。应用地址 `0x10000` 写入 939,936 B，esptool exit 0、写后 hash verified，MAC 仍为 `50:78:7d:16:ed:60`；同样未写 bootloader/分区表/NVS。当前 SHA-256 为 `A76224A46CC9E6FD737195988B40BE32B861C4AB1E75A9CD26F10F26477DBC11`。详情见 `KITCHEN-V20-NORMAL-DEPLOYMENT.json`。

正常版独立观察 120 秒，自 2026-10-26 01:29:36.982963+08:00 起：

- 21 条采样的 climate/gas/smoke valid 均为 true，设备时间全部为正且严格递增，状态均为 NORMAL；该状态不等于气体安全标定。
- 单次受控 EN 重启后只有一个 POWERON 标记；语音 READY，无 PLAY，符合关闭开机诊断语音的配置。
- 无 stack overflow、canary、Guru Meditation、backtrace 或重复重启；main 最低栈余量 4060 B、gateway-net 2908 B。
- 观察到 WIFI_GOT_IP 和 GATEWAY_CONNECTED，采样持续至 01:31:33.658。

并行 70 秒只读 MQTT 观察中，厨房 12 条自然上报、retained=0，gas/smoke valid 均为 true，deviceTs 从 `1792949384049` 严格递增至 `1792949444379`。客厅 23 条，卫生间 0 条；末次 9101 连接检查只见厨房对端。本任务未诊断或修改卫生间，不能将此窗写成三节点全部在线。

证据为 `KITCHEN-SERIAL-NORMAL-V20.json`、`KITCHEN-V20-NORMAL-MQTT-PASSIVE.log`。最终分类：`KITCHEN_VOLUME20_NORMAL_DEPLOYED_SHORT_RUN_PASS`。用户相对听感确认来自已替换的同参数试听版；正常版未触发真实告警播放，未完成 SOS/FALL/ACK、蜂鸣器联动、断网求助或长时稳定性验收。所有烧录和观察已结束，COM5 已释放；未操作卫生间 COM4、DAYU COM11 或 COM8。
