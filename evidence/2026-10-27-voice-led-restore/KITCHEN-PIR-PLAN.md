# 厨房 PIR 加装方案（待用户确认硬件）

日期：2026-10-27；依据：`competition/evidence/2026-10-26-local-speaker-candidate/KITCHEN-REWIRE.md`、
`competition/docs/evidence/2026-10-26-new-chat-handoff.md`（引脚表）、
`competition/esp32-node/main/Kconfig.projbuild`。

## 1. 厨房板现有引脚占用（已核实）

| 功能 | 引脚 | 备注 |
|---|---|---|
| MQ-2 模拟 | GPIO6 / ADC1_CH5 | 保持 |
| MQ-5 模拟 | GPIO7 / ADC1_CH6 | 已从 GPIO9 迁移，勿动 |
| AHT20 I2C1 | GPIO4 / GPIO5 | 保持 |
| 板载音频 I2S | MCLK GPIO3、BCLK GPIO46、LRCK GPIO9、DOUT GPIO10 | 保持 |
| ES8388/XL9555 I2C0 | GPIO41 / GPIO42 | 保持 |
| LED | GPIO1（低有效） | 保持 |
| SOS | XL9555 P1_7（KEY0，经 I2C 扩展） | 非 GPIO |
| 扬声器使能 / 蜂鸣器 | XL9555 P0_2 / P0_3 | 非 GPIO |
| USB / BOOT | GPIO19/20 / GPIO0 | 不可用 |
| Flash/PSRAM | GPIO26–37 | 不可用 |

## 2. PIR 接线建议（HC-SR501 类模块）

| PIR 引脚 | 接到厨房板 | 说明 |
|---|---|---|
| VCC | **5V**（板上若有 5V 排针）；无 5V 时接 3.3V | HC-SR501 在 5V 下最稳定；输出仍为 3.3V TTL |
| GND | GND（与板共地） | 必须共地 |
| OUT | **GPIO38**（首选；备选 GPIO39/40/47/48） | 输入，3.3V 电平；OUT 悬空时可能误触发，务必接好 |

选择 GPIO38 的理由：不在厨房现有占用（1/3/4/5/6/7/9/10/19/20/26–37/41/42/43/44/46）内；
38–48 段为可用的普通 GPIO，且不在音频/I2C/ADC 关键路径上。

**操作前必须断电**，确认板上丝印为 `IO38`（不是排针第 38 脚）；不移动任何既有线。

## 3. 固件配置（构建时）

```ini
CONFIG_NODE_MOTION_GPIO=38
CONFIG_NODE_MOTION_DEBOUNCE_CONFIRM=2
CONFIG_NODE_MOTION_ACTIVE_HIGH=...   # 按 HC-SR501 高有效设置
```

- 保持 `NODE_VOICE_ENABLED=y`、`NODE_VOICE_VOLUME=30`、`NODE_LED_GPIO=1`、LED 低有效、KEY0 SOS 不变。
- **不改**分区表、NVS、Wi-Fi、deviceId、`NODE_ID`/`NODE_ROOM`。
- 需确认厨房固件是否启用“无活动/长无 PIR”告警路径；若启用，需明确是否让厨房 PIR 参与该逻辑（当前默认关闭，仅计数与上报）。

## 4. 验证（构建后、写板后）

1. 写前核对芯片/MAC（COM5 → `50:78:7d:16:ed:60`），备份当前 1 MiB app 分区并记录 SHA-256。
2. 只写 `0x10000` app 分区，`full_erase=false`；写后 esptool `Hash of data verified`。
3. 启动日志：`local-voice: READY`、功放待机静音、无启动蜂鸣/LED 闪烁、已连接网关。
4. PIR 自然触发：MQTT 状态 `motion.countToday` 递增、时间戳前进；APP 设备页/活动报告出现活动计数（不制造告警）。
5. 由用户按 KEY0 做真实按键验收（语音+LED 三短闪），并确认对应 SOS。

## 5. 未决问题（请用户确认）

1. PIR 型号与是否已购买？板上是否有可用 5V 排针？
2. 是否接受 GPIO38（或告知你已接好的引脚号）？
3. 厨房 PIR 是否只用于“活动计数/报告”，还是也要参与“长时间无活动”告警？
