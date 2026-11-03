# LOCAL-ALARM-LED-CLOSURE — 厨房 / 卫生间板载 LED 灯光告警交付报告

日期：2026-10-26（Asia/Shanghai）  
工作区：`<WORKSPACE>`  
证据目录：`competition/evidence/2026-10-26-local-alarm-led-closure/`  
说明：本报告**更新**上一份 `2026-10-26-local-alarm-voice-closure/REPORT.md` 中“未确认可编程 LED”的保守结论。

---

## 1. 结论摘要

| 项 | 结果 |
|---|---|
| LED 是否存在 | **存在两颗**：用户 LED `LED`（红色，可控）+ 电源灯 `PWR`（蓝色，只要 3.3V 通电常亮） |
| 是否可编程 | **可编程**：用户 LED 由 **GPIO1 / IO1** 控制，**低电平点亮**（灌电流） |
| 硬件依据 | 官方 ALIENTEK `ATK-DNESP32S3-Board` 仓库 `led.h/led.c`、官方指南第 10 章、官方原理图 V1.2 `DEVICE1.SchDoc`；本项目 2026-10-20 板级记录 `LED=IO1`；两块实物板本次均实测可亮灭。详见 `LED-SCHEMATIC-EVIDENCE.md` |
| 实现 | 新增 `local_led.c/h`，复用现有告警状态机驱动：ALARM 快闪 / SOS 三短闪 / ACKED 慢脉冲 / 恢复熄灭 / 重启不闪 |
| 厨房板（COM5 `esp32-kitchen`） | 已烧录最终正式固件，正常态 LED 灭、采集/上报/KEY0 正常 |
| 卫生间板（COM4 `esp32-bath`） | 已烧录最终正式固件，正常态 LED 灭、采集/上报正常 |
| 用户目视确认 | ①LED 可控与低电平极性（识别演示）②SOS 三短闪 ③恢复正常后熄灭 ④重启不无故闪 |
| 仅日志验证（用户未单独目视区分） | stop 后灯继续闪（与普通告警同节奏，设计如此，需靠“声音停”区分）；ACK 后 0.8s 常亮 + 慢脉冲 |
| 真实事件链路验收 | **尚未**：需要用户按厨房 KEY0 或卫生间实体 SOS，并在 APP/DAYU 点 ACK（见 §8） |

---

## 2. 原理图依据与引脚

- 官方仓库（`openedv/ATK-DNESP32S3-Board`）BSP：`LED_GPIO_PIN = GPIO_NUM_1`；`led.c` 初始化即把 IO1 置高（灭）。
- 官方指南第 10 章：IO1 接 LED 负极，“IO1 输出低电平时 LED 亮起，反之熄灭” → **低电平有效**。
- 官方原理图 V1.2 `DEVICE1.SchDoc`：`VCC3.3 → R4 510Ω → LED(红) 阳极 → 阴极 → 网络 LED/IO1`；模组 U1 pin 39 = IO1。另一支路 `PWR(蓝) → R5 510Ω → GND` 为不可控电源灯。
- 本项目 2026-10-20 记录：`LED = IO1 | led.h：LED_GPIO_PIN GPIO_NUM_1`；当时因“MQ-2 计划接 GPIO1”判定冲突，后来 MQ-2 改 IO6/ADC1_CH5、MQ-5 改 IO7/ADC1_CH6，**IO1 已空闲**。
- 冲突核对：IO1 不占本项目 PIR(36)、SOS(15)、AHT20(4/5)、音频(3/9/10/46)、MQ(6/7)、XL9555(41/42)；ADC 电位器在 IO8/ADC1_CH7，不冲突。
- 版本边界：公开只有 V1.2 原理图；**V1.0↔V1.4 的灯差异无公开数据（UNKNOWN）**，且本项目原先引用的 V1.4 PDF 已不在本机。本次以两块**实物板实测**补足：两块板均为 ESP32-S3 rev v0.2、16MB Flash，LED 均按 GPIO1 低有效响应。
- 板载第二颗蓝灯 `PWR` 不受 GPIO 控制，**没有**把它当作告警灯；正常态用户红灯不亮。

## 3. 灯效与状态对应（复用现有状态机，不另造状态机）

| 设备状态 | 灯效 | 说明 |
|---|---|---|
| NORMAL / WARN | 灭 | 正常态不显示告警灯效 |
| ALARM（CLIMATE/GAS/SMOKE/WATER/NO_MOTION） | 400ms 亮 / 400ms 灭（约 1.25Hz 快闪） | 与语音+蜂鸣同时；持续异常限频提醒时灯一直按此节奏 |
| ALARM（MANUAL_SOS，厨房 KEY0 / 卫生间 SOS） | 三短闪：120ms 亮 + 120ms 灭 ×3，再长灭，周期约 1.6s | 与普通告警明显不同；重复 SOS 不叠播，灯节奏不叠加 |
| `stop`（仅停止本轮声音） | **保持当前 ALARM 闪烁** | 声音停 ≠ 异常解除；`state` 仍为 ALARM，灯继续提示 |
| ACKED 且仍有危险 | 先常亮 0.8s（ACK 已收到），之后每 3s 一次 120ms 慢脉冲 | 区分“监护人已确认、异常仍在” |
| ACKED 且危险已解除 | 先常亮 0.8s，然后熄灭 | 区分“已确认且异常已解除”；设备 `state` 按既有规则仍为 ACKED 直到 reset/重启，**未改状态机** |
| 异常解除（未 ACK 的可恢复类） | 回 NORMAL → 灭 | 例如无活动/温湿度恢复正常 |
| 重启 | 上电默认灭，无启动闪烁 | 告警状态不持久化，不重放历史告警 |
| 音频/网络失败 | 不影响 LED 逻辑；LED 初始化失败也不会影响声音/采集 | 100ms 主循环 tick 内非阻塞刷新，不新增任务/延时 |

LED 此前在本项目中未承担任何普通联网/状态提示，因此告警灯效独占该灯，不存在被普通提示覆盖的情况。

## 4. 源码改动（最小实现）

- 新增 `esp32-node/main/local_led.c` / `local_led.h`：纯 GPIO 输出 + `esp_timer` 计时，无阻塞、无新任务；模式：OFF / ALARM_BLINK / SOS_TRIPLE / ACKED_CONFIRM_PULSE / ACKED_RESOLVED_OFF；仅台架固件编译 `inj led ...` 调试接口。
- `node_main.c` 仅在 4 处接入：include、`app_main()` 中 `local_led_start()`（上电灭）、主循环 `local_led_tick(s_state, s_alarm_type, active_danger()!=NULL)`、台架命令 `inj led on/off/pol/id/auto`。
- Kconfig 新增 `NODE_LED_GPIO`（默认 -1，本项目=1）与 `NODE_LED_ACTIVE_LOW`（默认 y）；`profiles/alarm-closure` 与 `alarm-bench` 启用 GPIO1/低有效；`CMakeLists.txt` 增加 `local_led.c`。
- 公共树与卫生间私有树同步同一模块；**厨房 KEY0 SOS 任务最新源码与逻辑完整保留**（正式固件 `CONFIG_NODE_SOS_KEY0_ENABLED=y`），卫生间保留满幅 PCM 与音量 30，厨房保留音量 20/PCM ÷2、MQ-5 GPIO7、音频 LRCK GPIO9。
- 详细 before/after SHA-256 见 `CHANGES.md`。

## 5. 固件、身份与写板

| 板 | 最终正式固件 | 大小(B) | SHA-256 |
|---|---|---|---|
| 厨房 `esp32-kitchen` | `kitchen-prod`（KEY0 + 声音闭环 + LED） | 948,960 | `A66B3D7D750296F325A2033B169BE3A19F0FADDDEAEB0AEE72FC3D3E646A8611` |
| 卫生间 `esp32-bath` | `bath-prod`（声音闭环 + LED） | 937,472 | `EF2C62FC8850F72291C015AF7FD9E527422966B7E9DD18AC2B0A16BC94B872B5` |

- 写前只读核对：两板 ESP32-S3 rev v0.2，MAC 分别为 `50:78:7d:16:ed:60` / `14:c1:9f:42:dd:b4`，与用户标记一致；写前 app 分区哈希分别等于上一版 `CD7D3BA4…`（厨房 KEY0）与 `3DF80786…`（卫生间声音闭环）。
- 仅写 app 分区 `0x10000`，esptool 报 `Hash of data verified`；未全片擦除、未写 bootloader/分区表/NVS、未改 Wi-Fi/deviceId/接线。私有备份与回滚命令见 `build/FIRMWARE-MANIFEST.md`。
- 台架验收固件（仅 LED 调试用）已全部被正式固件覆盖；当前两块板运行的是**不含台架注入**的正式固件。

## 6. 验证记录

### 6.1 用户目视确认（真实板）

| 观察 | 结果 | 对应证据 |
|---|---|---|
| 识别演示：先闪烁，然后“大部分灭+每 2s 短亮”，再“大部分亮+每 2s 短暗” | 用户确认与预期一致 → LED 受 GPIO1 控制，低电平点亮 | `verify/led-identify-kitchen-long.log` 等；用户答复“预期”选项 |
| SOS 时红色 LED 三短闪（与普通快闪明显不同） | 用户确认 | 台架 SOS 阶段；`LED 模式=SOS_TRIPLE` 日志 |
| 环境恢复正常后红灯熄灭 | 用户确认 | `LED 模式=ACKED_RESOLVED_OFF` / `OFF` |
| 重启后红灯不无故闪成告警 | 用户确认 | 启动 `no boot flash`；正式固件启动日志 |

### 6.2 日志与串口验证（真实板，非仅“打印 LED ON”）

- 台架（隔离、无云端事件）两块板各跑多轮完整状态序列，日志记录实际灯效模式切换：
  - `verify/led-states-kitchen-endless.log`、`verify/led-states-bath-endless.log`（12 轮循环）：`ALARM_BLINK → ACKED_CONFIRM_PULSE → ACKED_RESOLVED_OFF → SOS_TRIPLE → ACKED_RESOLVED_OFF → OFF`，每轮一致。
  - stop 后灯模式不变（仍是 `ALARM_BLINK`），证明“只静音、不停灯”：见各轮 `STOP 已接受并生效` 后无 LED 模式切换。
  - `verify/led-acked-resolved-check.log`（厨房，32s）：`ALARM_BLINK(8.5s) → ACKED_CONFIRM_PULSE(14.5s) → ACKED_RESOLVED_OFF(21.6s)`，确认“已确认且异常解除”与“已确认但异常持续”的区分逻辑生效。
  - 声光联动：同一条 `AHT20 温湿度越界 -> ALARM` 之后同时出现 `PLAY clip=2` 与 `LED 模式=ALARM_BLINK`；SOS 同时出现 `PLAY clip=1` 与 `SOS_TRIPLE`。
- 正式固件启动（`verify/prod-kitchen-boot.log`、`prod-bath-boot.log`，RTS 复位后完整启动）：
  - `local-led: 板载 LED 就绪：GPIO1 单色，低电平有效，启动默认灭（no boot flash）`
  - `READY playback-only … no boot alarm`，全程 `PLAY clip=0`；`state=NORMAL`、`alarm` 为空；厨房 `SOS 按键就绪：板载 KEY0 = XL9555 P1_7`。
  - 两板均重新获取 IP（10.127.130.168 / 10.127.130.71），bridge 9101 建立真实连接，`public-sync-supervisor.log` 对两设备自然 `status=202` → 采集/上报恢复，正常态无误响、无误闪。
- 用户未能单独目视区分的两项（stop 后继续闪、ACK 慢脉冲）**只有日志/模式证据**，没有用户目视确认；按实际分级如实标注（§7）。

### 6.3 台架与正式区分

- **台架通过**：所有灯效状态序列、SOS 节奏、stop/ACK/恢复/重启，均在 `CONFIG_NODE_ALARM_BENCH_INJECT=y`、无 WiFi/网关的隔离固件上真实点亮并观察。
- **正式固件已验收**：正常态 LED 灭、启动无闪烁、无声音、采集上报与 202 正常；**真实告警触发**（用户按 KEY0/SOS 产生生产告警）尚未执行，故正式固件的“告警灯效”未被真实事件触发过（台架已覆盖同一代码路径）。

## 7. 分类结论

### 已本地实现并验证
- GPIO1 单色 LED 告警灯效模块（快闪/三短闪/ACK 确认+慢脉冲/恢复熄灭/重启不闪），非阻塞，复用现有告警状态机；Kconfig/构建/两棵源码树同步。
- 台架串口日志完整记录两块板各状态灯效切换；正式固件启动/正常态/上报验证通过。

### 已更新到哪块真实板并验收
- 两块板均烧录最终正式固件（厨房 `A66B3D7D…`、卫生间 `EF2C62FC…`，esptool 校验通过）。
- 两块板正常态：LED 灭、无发声、采集正常、自然 202。
- 用户目视：识别/极性、SOS 三短闪、恢复熄灭、重启不闪（真实板）。

### 仅隔离模拟/台架通过
- stop 后继续闪、ACK 确认与慢脉冲：代码与日志验证，用户未单独目视区分（stop 阶段与普通告警同为快闪，需靠“声音停”区分）。
- 温湿度/SOS 触发使用台架注入（未制造生产告警）。

### 尚未完成的真实链路
1. **真实 KEY0（厨房）/实体 SOS（卫生间）→ 声+光 → APP/DAYU → 用户 ACK → 设备 ACKED 回执**：需用户主动操作（§8）。
2. **APP `stop/pause` 入口**：仍与上一份报告相同，bridge 白名单/APP 无对应按钮，节点已支持但云端/APP 不可达；本轮未改 bridge/APP/DAYU。
3. 真实环境越界（高低温/高湿）与 30 分钟无活动档未做危险/耗时测试。
4. 真实断网下正式固件的灯光行为：本轮正式固件上线时网络已恢复；断网本地灯效由“无网络台架”与代码路径支撑，未做正式固件真断网长测。

### 现场当前未知
- 用户看完最终演示后对 stop/ACK 灯效的目视确认（本次未确认）。
- 两块板长期运行稳定性与 LED 长期寿命（未做长时观察）。
- 卫生间实体 SOS 按键接线是否可靠（上一轮曾出现一次来源不明的 SOS 事件）。
- V1.0/V1.4 板版本与 V1.2 原理图是否存在差异（公开资料无数据；两块实物板已实测 GPIO1 有效）。
- 手机 APP/DAYU 当前会话与公网后端稳定性（本轮自然 202 正常，未做 APP 操作）。

## 8. 需要用户完成的最少验收（约 1 分钟）

当前两块板已在线（自然 202），只需一步真实按键链路：

1. 按一下**厨房板实体 KEY0**（或**卫生间实体 SOS**，任选一块即可）。预期：该板红色 LED 进入对应节奏（KEY0/SOS 为**三短闪**，不是普通快闪），同时扬声器播报 SOS 语音、蜂鸣器响；APP/DAYU 出现 `MANUAL_SOS` 告警。
2. 在 **DAYU 页面或手机 APP 点“确认/ACK”**。预期：该板 LED 先常亮约 0.8s → 因 SOS 无持续危险，随后熄灭；串口出现 `ACK 已接受并生效 … state=ACKED，语音已取消`；5 秒内云端/APP 显示 ACKED 且 alarmId 一致。
3. 若想再看 stop 灯效：告警期间在 DAYU/APP 发送/触发 `stop`（当前 APP 入口未接通，只能由隔离串口或后续 APP 按钮触发），预期声音停、红灯继续按原节奏闪。

若按键或 ACK 未达预期，请告知大致时间与板子，我按记录继续定位；无需重刷。

## 9. 回滚

见 `build/FIRMWARE-MANIFEST.md` 的回滚命令：用写前私有备份恢复 app 分区即可回到“厨房 KEY0 版 / 卫生间声音闭环版”（均不含 LED 代码）。NVS 中的监护暂停状态不会被这些写操作清除。
