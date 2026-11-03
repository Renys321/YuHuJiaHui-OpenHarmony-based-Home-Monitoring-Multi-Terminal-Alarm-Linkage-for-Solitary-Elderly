# 厨房板 PIR 加装刷写记录（2026-10-27 01:15）

## 1. 身份核对（写前）

| 项 | 实测 |
|---|---|
| 端口 | COM5 |
| 芯片 | ESP32-S3 (QFN56) rev v0.2 |
| MAC（esptool chip_id 重读两次一致） | **50:78:7d:16:ed:60** |
| 固件内身份 | `CONFIG_NODE_ID="esp32-kitchen"`、`ROOM="厨房"` |

## 2. 写前备份（整段 app 分区 1 MiB，只读）

| 项 | 值 |
|---|---|
| 备份文件 | `.local/voice-led-restore-20261027/device-backup/COM5-app-before-pir-20261027.bin` |
| 大小 | 1,048,576 B |
| 整段 SHA-256 | `0F1D752DD7FA581E5CDF3B9F23B4165FC7889ED6684E5B96D3083A4BFC78B5EB` |
| 前缀（前 1,019,728 B）SHA-256 | `43C1183A30688EAA56080BFA9C0CAB363B85839BE3FFD54FCBE19DB33F8443DD` → **与在板定向播报候选逐位一致**，确认备份对象正确 |
| 说明 | 旧固件 = 语音+LED+定向播报候选（用户确认语音/LED 正常） |

## 3. 新镜像（厨房 PIR，SR312 / 3.3V / GPIO38）

| 项 | 值 |
|---|---|
| 源码 | 当前 workspace `competition/esp32-node`（未改动源码，仅新增配置 overlay） |
| overlay | `.local/voice-led-restore-20261027/defaults/kitchen-pir-gpio38.sdkconfig.defaults`：`CONFIG_NODE_MOTION_GPIO=38`、`CONFIG_NODE_MOTION_DEBOUNCE_CONFIRM=2` |
| defaults 链 | `profiles/kitchen` → `.local/sdkconfig.kitchen.defaults`（真实 Wi-Fi） → `voice-candidate` → `voice-volume30` → `kitchen-voice-rewire` → `alarm-closure` → PIR overlay |
| 镜像 | `.local/voice-led-restore-20261027/build-kitchen-pir38/esp32_elder_node.bin` |
| 大小 / SHA-256 | **1,020,192 B / `F67AC3CEADFB224388EF91456CB2BB631D0B45F086A439B02D2F8B64D5A670F0`** |
| 分区余量 | 28,384 B（2.7%，构建器已告警“接近满”） |
| 配置实测 | VOICE=y vol30、LED GPIO1 低有效、MOTION_GPIO=38、去抖 2、SOS_KEY0=y、NO_MOTION_SEC=1800、NO_MOTION_REQUIRE_ARM=y、ALARM_REPEAT=300 |
| 构建日志 | `_work/build-kitchen-pir38.log` |

## 4. 写入（只写 app 分区）

```
Wrote 1020192 bytes (665130 compressed) at 0x00010000 in 15.9 seconds
Hash of data verified.
```
- 记录：`run/flash-kitchen-pir38-COM5.json`（MAC 复核通过、`appFlashOffset=0x10000`、`fullErase=false`、`wrotePartitions=factory app only`）
- 未全片擦除、未改 bootloader/NVS/分区表/Wi-Fi/deviceId。

## 5. 启动日志（`run/kitchen-boot-pir38-20261027b.log`，受控复位后抓取）

```
rst:0x1 (POWERON),boot:0x2b (SPI_FAST_FLASH_BOOT)
I (304) boot: Loaded app from partition at offset 0x10000
I (485) elder-node: ESP32-S3 无线节点启动：esp32-kitchen / 厨房
I (515) local-led: 板载 LED 就绪：GPIO1 单色，低电平有效，启动默认灭（no boot flash）
I (815) local-voice: READY playback-only 16000Hz IMA-ADPCM; amp standby muted; no boot alarm; clips=7
I (3075) elder-node: 检测到活动（今日第 1 次）        ← PIR SR312 已工作
I (10085) elder-node: 已连接网关 10.127.130.179:9101
I (6845) → {"deviceId":"esp32-kitchen",...,"motion":{"lastActiveTs":0,"countToday":1},...}
```

判定：启动无蜂鸣/语音、功放待机静音、LED 启动不闪；PIR 已生效（检测到活动第 1 次）；网关已连接；上报 `status=202`、无 REJECT。

## 6. 真实按键验收（KEY0，01:16:22–01:16:48）

串口原文（`run/kitchen-live-verify-20261027.log`）：

```
W (42325) elder-node: 告警提示音开始：3 声，间隔 100 ms；随后播报 clip=1（我需要帮助，请尽快过来。）
I (42395) local-led: LED 模式=SOS_TRIPLE type=MANUAL_SOS（低电平有效；告警期间不被普通联网提示覆盖）
I (43365) local-voice: PLAY clip=1 bytes=27791 text=我需要帮助，请尽快过来。
I (45385) …（状态 ALARM，alarm.id=e-1793034982-1，type=MANUAL_SOS）
I (68065) elder-node: CMD 收到: ack e-1793034982-1 监护人已确认
I (68065) elder-node: ACK 回执已接受并生效 … -> state=ACKED，蜂鸣器已停，语音已取消
I (68225) local-led: LED 模式=ACKED_RESOLVED_OFF type=MANUAL_SOS
```

- 语音素材 `clip=1 bytes=27791` = `sos.adpcm`（27,791 B），与卫生间一致；
- LED `SOS_TRIPLE`（三短闪）→ ACK 后 `ACKED_RESOLVED_OFF`；
- 用户主观确认：**听到中文语音、看到三短闪**（用户回复“看到了”）；
- 云端：`ACK_SENT id=23 → ACKED`（01:16:48，e-1793034982-1）。

## 7. PIR 公网上报

- 状态上报：`motion.{lastActiveTs,countToday}` 走既有合同字段（非 v7），`cloud-sync OK device=esp32-kitchen status=202`；
- PIR 触发记录：`检测到活动（今日第 1 次）`，`motion.lastActiveTs=1793034975236`（01:16:15）；
- 活动数据会进入后端活动文件（E 活动报告），无需后端/协议变更。

## 8. “长时间无活动”告警（按用户“都要”保持启用）

- 配置：`NO_MOTION_SEC=1800`（30 分钟）+ `NO_MOTION_REQUIRE_ARM=y`（先观测到一次有效活动才武装）；
- 后果：厨房从最后一次活动起 30 分钟无人 → 真实触发无活动告警（按 300s 重复提醒），这是用户明确要求的“都要”；
- 本次未等待 30 分钟做自然触发验证，**如实标注为“已配置、未现场观察”**，不写成已通过。

## 9. 回滚

- 回到刷写前（语音+LED+定向播报候选，无 PIR）：`esptool --port COM5 --chip esp32s3 write_flash 0x10000 <COM5-app-before-pir-20261027.bin>`（整段 1 MiB；或写前缀 1,019,728 B 的 `43C1183A…` 镜像）。
- 回到已验收正式固件（无定向播报）：`446A5B87…`（1,016,864 B）。
- 注意：PIR 硬件线若保留，回滚固件 `MOTION_GPIO=-1` 不读取 PIR，不会误报。
