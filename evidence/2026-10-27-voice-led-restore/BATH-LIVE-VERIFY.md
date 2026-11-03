# 卫生间实机验证记录（刷写后真实按键/门磁）2026-10-27 01:07–01:09

串口采集：`run/bath-live-verify-20261027.log`（COM4，115200，DTR/RTS released，5 分钟）
镜像：`F56A5A64B336E0CB3AE669908CF41B462BC17E6CFECB863E8850B506258BEFCF`（三合一 + 旧协议兼容）

## 1. 语音 / LED（用户两次真实按键）

### 第一次按键（01:07:25）

```
W (142153) elder-node: SOS 按键被按下 -> ALARM（e-1793034445-1，type=MANUAL_SOS）语音+蜂鸣已请求
I (142213) local-led: LED 模式=SOS_TRIPLE type=MANUAL_SOS（低电平有效；告警期间不被普通联网提示覆盖）
I (143193) local-voice: PLAY clip=1 bytes=27791 text=我需要帮助，请尽快过来。
I (146733) local-voice: STOP clip=1 result=ESP_OK cancelled=0
```

- 语音素材：`clip=1 bytes=27791` 与 `audio/final/sos.adpcm`（27,791 B）一致；`cancelled=0` 表示**完整播放未被中断**。
- LED：`SOS_TRIPLE`（三短闪）模式生效。
- 用户 ACK（01:07:54）：`ACK 回执已接受并生效 … -> state=ACKED，蜂鸣器已停，语音已取消`，随后 `LED 模式=ACKED_RESOLVED_OFF`。

### 第二次按键（01:08:02）

```
W (178923) elder-node: SOS 本地已触发：SOS 按键被按下（来源设备=esp32-bath / 房间=卫生间）
W (178933) elder-node: 告警提示音开始：3 声，间隔 100 ms；随后播报 clip=1（我需要帮助，请尽快过来。）
W (178933) elder-node: SOS 按键被按下 -> ALARM（e-1793034481-2，type=MANUAL_SOS）语音+蜂鸣已请求
I (178993) local-led: LED 模式=SOS_TRIPLE type=MANUAL_SOS
I (179963) local-voice: PLAY clip=1 bytes=27791 text=我需要帮助，请尽快过来。
I (183453) local-voice: STOP clip=1 result=ESP_OK cancelled=0
```

- 第二次同样：3 声提示音 → 完整中文语音 → 三短闪；语音完整播放（cancelled=0）。

## 2. 门磁本地功能（用户开门/关门）

```
I (191573) elder-node: 门磁状态变化：开启（seq=20）
I (197063) elder-node: 门磁状态变化：关闭（seq=21）
```

- seq 从开机恢复的 10 递增到 20/21，说明 NVS 序号 + 事件缓存仍在工作；
- 状态 JSON 中 `door:{open,lastOpenTs}` 随开合变化（`lastOpenTs=1793034494615`），**旧协议两键格式**；
- 用户操作期间的多次上报均 `status=202`（PC 侧 `cloud-sync OK device=esp32-bath` 持续）。

## 3. 云端上报

- 刷写前：`REJECT code=INVALID_STATUS device=esp32-bath` 每 ≈5 s（最后 01:03:42）
- 刷写后：`cloud-sync OK device=esp32-bath … status=202`（首条 01:04:47，之后持续；门磁开合期间亦然）
- ACK：`ACK_SENT id=20 → ACKED`（01:07:54，e-1793034445-1）

## 4. 结论

| 项 | 结论 |
|---|---|
| 卫生间中文语音 | ✅ 恢复（两次真实按键均完整播放 SOS 语音 27,791 B / cancelled=0） |
| 卫生间 LED | ✅ 恢复（SOS_TRIPLE 三短闪模式日志；ACK 后 ACKED_RESOLVED_OFF） |
| 门磁本地功能 | ✅ 保留（GPIO14、去抖 2、NVS seq 恢复、开合事件 seq 20/21） |
| 门磁公网（扩展字段） | ⏳ 仍待 schema v7：当前只上报旧合同 `open/lastOpenTs`（202 正常）；`seq/events/lastCloseTs` 等 v7 字段未下发 |
| 上报 | ✅ 202 恢复，`INVALID_STATUS` 已消失 |
| 启动 | ✅ 无 boot 蜂鸣/语音、功放待机静音、LED 启动不闪（见 `run/bath-boot-compat-20261027.log`） |

## 5. 待用户确认/闭环

1. 两次按键是否**实际听到**中文语音、看到 LED 三短闪（主观确认）。
2. 第二次告警 `e-1793034481-2` 目前仍为 `ALARM`，需在 APP 中确认/ACK（第一次已 ACK）。
