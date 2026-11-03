# 卫生间板刷写记录（三合一 + 最小向后兼容）2026-10-27 01:04

## 1. 身份核对（写前）

| 项 | 实测 |
|---|---|
| 端口 | COM4 |
| MAC（esptool chip_id 重读） | **14:c1:9f:42:dd:b4**（与历史身份一致） |
| chip | ESP32-S3 (QFN56) v0.2，flash 2MB 配置，factory app 1MiB @0x10000 |
| 固件内身份 | `CONFIG_NODE_ID="esp32-bath"`、`ROOM="卫生间"` |

## 2. 写前备份（整段 app 分区 1 MiB，只读）

| 项 | 值 |
|---|---|
| 备份文件 | `.local/voice-led-restore-20261027/device-backup/COM4-app-before-compat-20261027.bin` |
| 文件大小 | 1,048,576 B |
| 整段 SHA-256 | `4712A70289DDABD001164C5EB30D95CE65AD233C70E08DEF89548227A6D27D58` |
| 前缀（前 783,056 B）SHA-256 | `16B63A310E10D41A860C6892AFD516F125E6EE90290EAD5B57C39B4E3A0B17C1` → **与在板的门磁候选镜像逐位一致**，确认备份的是当前真实固件 |
| 说明 | 旧固件 = 门磁候选（无语音/LED，上报被 INVALID_STATUS 拒绝） |

## 3. 写前镜像（本次新构建）

| 项 | 值 |
|---|---|
| 源码 | `bath-merged-src` 副本 → `.local/voice-led-restore-20261027/bath-compat-src`（隔离，未改原始候选源） |
| 基线 | 三合一候选 `42F24D5F…93715`（1,011,648 B，含 GPIO14 门磁 + 6 clips 中文语音 + GPIO1 低有效 LED） |
| 唯一改动 | `main/node_main.c report()` 门磁段：v7 未上线前只发旧合同两键 `door:{open,lastOpenTs}`；`lastCloseTs/seq/events` 仅本地保留；基线未知时整段不发（不谎报关闭）。其余（语音/LED/ACK/STOP/300s/GPIO/音量）未动 |
| 新镜像 | `.local/voice-led-restore-20261027/build-bath-compat/esp32_elder_node.bin` |
| 大小 / SHA-256 | **1,011,312 B / `F56A5A64B336E0CB3AE669908CF41B462BC17E6CFECB863E8850B506258BEFCF`** |
| 分区余量 | 37,264 B（3.5%） |
| 构建日志 | `_work/build-bath-compat.log` |
| 静态核对 | 二进制内不含 `lastCloseTs` / `"events":[`；含 `"door":{"open":%s,"lastOpenTs":%lld}`；sdkconfig：VOICE=y vol30、LED GPIO1 low、DOOR GPIO14 level1 confirm2、MOTION=36、SOS=15、BUZZER=XL9555、ALARM_REPEAT=300 |
| 隔离测试 | `host_door_logic: ALL PASS`、`host_bathroom: PASS=54 FAIL=0`、`.map` 中 6 个 ADPCM 素材符号齐全 |

## 4. 写入（只写 app 分区）

```
FLASH_EXIT=0 HASH_VERIFIED=True BIN_SHA256=F56A5A64…258BEFCF
Wrote 1011312 bytes (660759 compressed) at 0x00010000 in 15.5 seconds
Hash of data verified.
```
- 记录：`run/flash-bath-compat-COM4.json`（com/mac/expectedMac/binPath/binSize/binSha256/appFlashOffset=0x10000/esptoolExit=0/esptoolReportedHashVerified=true/fullErase=false/wrotePartitions=factory app only）
- 未全片擦除、未改 bootloader/NVS/partition table/Wi-Fi/deviceId/接线。

## 5. 启动日志（`run/bath-boot-compat-20261027.log`，225 行，受控 RST 复位后抓取）

关键行原文：

```
I (302) boot: Loaded app from partition at offset 0x10000
I (493) elder-node: ESP32-S3 无线节点启动：esp32-bath / 卫生间
I (513) elder-node: 门磁序号恢复 seq=10 待补传事件=0
I (523) elder-node: 门磁已配置 GPIO14（开启电平=1，去抖确认=2 次，缓存=8 条/300s）
I (553) local-led: 板载 LED 就绪：GPIO1 单色，低电平有效，启动默认灭（no boot flash）
I (843) local-voice: READY playback-only 16000Hz IMA-ADPCM; amp standby muted; no boot alarm; clips=7
I (1133) elder-node: 连接 WiFi: ElderCareLab
I (3123) elder-node: 门磁基线建立：当前状态=开启（不生成历史事件）
I (6903) elder-node: → {"deviceId":"esp32-bath",...,"door":{"open":true,"lastOpenTs":0},...}
```

判定：
- ✅ 启动无蜂鸣/无语音（no boot alarm）、功放待机静音（amp standby muted）
- ✅ LED 启动默认灭（no boot flash），GPIO1 低有效配置正确
- ✅ 门磁本地采集保留：GPIO14、去抖 2、缓存 8/300s、seq 从 NVS 恢复为 10
- ✅ 状态 JSON 只含旧合同门磁两键（`open`,`lastOpenTs`），无 `lastCloseTs/seq/events` → 上报被接受

## 6. 上报恢复（PC 侧实测）

- 刷写前：`REJECT code=INVALID_STATUS device=esp32-bath` 每 ≈5 s，最后一条 01:03:42
- 刷写后 **01:04:47**：`[cloud-sync] OK device=esp32-bath … status=202`（自 23:31 以来首条成功）
- 结论：**门磁公网字段兼容问题已解决**（本地保留门磁，v7 前不下发扩展字段），但门磁“扩展字段（seq/events/lastCloseTs）公网上报”仍待 schema v7 发布后才会启用。

## 7. 回滚

- 回到刷写前（门磁候选，无语音/LED）：`esptool --port COM4 --chip esp32s3 write_flash 0x10000 <COM4-app-before-compat-20261027.bin>`（整段 1MiB；或写前缀 783,056 B 的镜像）。
- 回到已验证语音+LED 正式版：`46C7968D…CEA63`（1,005,536 B，无门磁）。
- 三合一原候选：`42F24D5F…93715`（1,011,648 B，会重新触发 INVALID_STATUS，勿单独使用）。
