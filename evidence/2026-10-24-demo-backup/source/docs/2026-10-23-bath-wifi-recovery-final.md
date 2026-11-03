# 卫生间 ESP32 Wi-Fi 恢复与三节点在线最终复验（2026-10-23）

分类：**卫生间 Wi-Fi 恢复 PASS（REAL）；三节点同时在线 PASS；DAYU 3/3 与手机 3/5 PASS；串口 JSON 直接取证 NOT TESTED（串口只观察到启动/Wi-Fi 日志）；客厅 climate.valid 合同未修改。**

## 1. 根因

### 1.1 Wi-Fi 阶段

- 卫生间节点 COM5 可识别：ESP32-S3 QFN56 rev0.2、PSRAM 8MB、MAC `14:c1:9f:42:dd:b4`。
- 固件正常启动，AHT20 自检 OK（约 24.7℃ / 48.5%RH）；没有 Brownout、Guru Meditation 或 panic。
- Wi-Fi 反复断开，原始 reason 包括 `201`、`2`、`205`；没有进入 TCP 9101，也没有 JSON/202。
- PC WLAN 为 `10.127.130.179`，2.4GHz channel 6，WPA2-Personal/CCMP；AP 在线。

### 1.2 配置根因

`.local/sdkconfig.bathroom` 中的 SSID 最初**不是当前 2.4GHz AP**。第一次隐藏输入后仍不匹配，节点继续失败；随后将 SSID 对齐到 PC 当前 2.4GHz 网络（同进程核对 `match_same_process=True`），密码由用户在可见窗口隐藏输入。  
最终只改了 Wi-Fi 字段；以下硬件/身份配置保持不变（值均非敏感）：

```text
CONFIG_NODE_ID="esp32-bath"
CONFIG_NODE_ROOM="卫生间"
CONFIG_NODE_AHT20_ENABLED=y
CONFIG_NODE_I2C_SDA_GPIO=4
CONFIG_NODE_I2C_SCL_GPIO=5
CONFIG_NODE_MOTION_GPIO=36
CONFIG_NODE_SOS_GPIO=15
CONFIG_NODE_MQ2_ADC_CHANNEL=-1
CONFIG_NODE_MQ5_ADC_CHANNEL=-1
CONFIG_NODE_WATER_GPIO=-1
CONFIG_NODE_BOOT_BEEP_MS=0
CONFIG_NODE_GW_HOST="10.127.130.179"
CONFIG_NODE_GW_PORT=9101
```

SSID/密码未写入本证据，串口/构建日志中的 SSID 已脱敏；含凭据的临时配置备份已删除。

## 2. 构建与烧录（只 COM5）

### 2.1 第一次：错误 SSID，失败基线

- `build-bathroom` 构建完成；app **775,600 B**，SHA-256 `470E447F…18810`。
- COM5 `write_flash @flash_args`：bootloader / app / partition table 均 `Hash of data verified`，exit=0。
- 烧录后仍无 Bridge/202，串口 `reason=201`；确认是配置 SSID 错误，不是固件损坏。

### 2.2 第二次：最终配置，恢复成功

- 最终 app：`esp32-node/build-bathroom/esp32_elder_node.bin`
  - **775,616 B**
  - SHA-256 **`8D4E9A266950B364F1AC714194D4AD9FAA6BD70B447C72EBCA377AE863E902CE`**
- 只对 COM5 执行生成的 `flash_args`：

```text
0x0     bootloader/bootloader.bin
0x10000 esp32_elder_node.bin
0x8000  partition_table/partition-table.bin
```

- 三块均 `Hash of data verified`，`Hard resetting via RTS pin...`，exit=0。
- **COM14 未打开、未操作。**
- 未修改 APP/DAYU/后端/Bridge 协议/设备绑定。

## 3. 恢复后的真实链路

### 3.1 MQTT 当前状态（只读）

```json
{
  "deviceId": "esp32-bath",
  "room": "卫生间",
  "state": "NORMAL",
  "sensors": {
    "climate": { "tempC": 24.3, "rh": 49.2, "ok": true, "valid": true },
    "gas": { "raw": 0, "ok": true, "valid": false },
    "smoke": { "raw": 0, "ok": true, "valid": false }
  },
  "alarm": { "id": "", "type": "", "countToday": 0 }
}
```

无 `water` 字段；无重复设备/错误房间。

### 3.2 卫生间自然 202 周期（清理重复实例后）

```text
device=esp32-bath deviceTs=1792680009620 status=202 at=2026-10-22T14:40:10.898Z
device=esp32-bath deviceTs=1792680042500 status=202 at=2026-10-22T14:40:42.700Z
device=esp32-bath deviceTs=1792680075380 status=202 at=2026-10-22T14:41:15.217Z
device=esp32-bath deviceTs=1792680108261 status=202 at=2026-10-22T14:41:48.091Z
```

Bridge 同步出现：

```text
→ home/esp32-bath/status  state=NORMAL room=卫生间
```

4 条为不同 deviceTs 的连续自然周期；HTTP 202 只作为受理，设备状态本身的 `NORMAL`/`valid` 由 MQTT 报文核对。

### 3.3 重复 202 的处理

发现旧 public-sync 实例（PID 31380/32136）与新实例（28172/33560）并行，导致相同 deviceTs 两次 202。已停止旧实例，保留锁对应的 28172/33560；清理后每个周期只出现一条卫生间 202。

> 串口只观察到启动/Wi-Fi 日志，没有捕捉到完整 JSON 行；因此“串口 JSON 直接验收”为 **NOT TESTED**，但没有用串口假 JSON 替代网络证据。

## 4. 三节点最终状态

最新 202（同一时段）：

```text
dayu200-living deviceTs=1792680105857 at=2026-10-22T14:41:49.010Z
esp32-kitchen deviceTs=1792680112883 at=2026-10-22T14:41:52.722Z
esp32-bath    deviceTs=1792680108261 at=2026-10-22T14:41:48.091Z
```

- **DAYU**：`全屋在线 3/3 台设备`；三房间标题/deviceId 正确；卫生间 `24.9℃ / 47.8%`、活动 33 次；不显示燃气/烟雾/门磁正常；客厅摄像头切走再切回仍显示 `监护运行中 · FRONT · 640×480`。
- **手机 APP**：首页 `3/5` 在线、监测异常 `0`、待确认 `20`、今日告警 `10`；监测页 `3/5`；厨房 MQ 原始 ADC 仍标注“报警未启用”；卫生间已恢复在线；首页/监测页统计一致。
- 第五台/历史离线设备保留，未删除、未改绑定。
- 截图：`2026-10-23-bath-recovery-runtime/dayu-3nodes-online.jpeg`；手机最终状态由 HDC 布局文本记录（截图拉取无响应，未用旧图替代本轮）。

## 5. 客厅 `valid` 缺口（只记录）

- 板端源 `southbound/src/homemon.c:809` 输出 climate 仅含 `tempC/rh/ok`，无 `valid`。
- 当前板端实际 JSON 也无 `valid`；APP 已按“待确认”处理，是正确保守行为。
- 本轮不修改 homemon/APP/云端；建议另立任务统一增加 `climate.valid` 合同（true=读取成功，false=失败，缺失=未知）并做兼容回归。

## 6. PASS / BLOCKED / NOT TESTED

| 项目 | 结果 |
|---|---|
| Wi-Fi 失败阶段/配置核对 | **PASS（reason 201/2/205；配置 SSID 曾不匹配）** |
| 仅更新 Wi-Fi 配置、硬件配置保持 | **PASS** |
| 仅构建/烧录 COM5、三区域 Hash verified | **PASS REAL** |
| 卫生间 Bridge/MQTT 自然上报 | **PASS REAL** |
| `room=卫生间`、`state=NORMAL`、`climate.valid=true` | **PASS REAL** |
| gas/smoke `valid=false`、无 water 字段 | **PASS REAL** |
| 至少两个自然 202 周期 | **PASS REAL（4 个周期）** |
| 重复 202 清理（旧 public-sync 实例） | **PASS** |
| 三节点同时在线 | **PASS REAL** |
| DAYU 3/3 与手机 3/5 一致 | **PASS REAL** |
| 厨房/卫生间能力展示回归 | **PASS（沿用已验收 UI）** |
| 客厅摄像头切回 | **PASS REAL** |
| COM14 未操作 | **PASS（未访问）** |
| 串口 JSON 直接观察 | **NOT TESTED**（仅启动/Wi-Fi 日志） |
| 客厅 climate.valid 合同 | **未修改，后续任务** |
| SOS/ACK/PIR/蜂鸣器/燃气报警 | **NOT TESTED**（本轮未重复触发；历史 SOS→ACKED 证据仍独立有效） |

## 7. 没有修改的内容

- 未修改 DAYU200/手机 APP UI、Bridge 协议、公网后端、设备绑定、告警语义。
- 只修改 `.local/sdkconfig.bathroom` 的 Wi-Fi 字段；用隐藏输入，未记录值。
- 未操作 COM14；未发送 SOS/ACK/reset/手工 MQTT 状态；未清除历史告警。
- 正常 Broker/Bridge/public-sync/homemon 与模拟器保留运行。

## 8. 当前服务

```text
Broker 6540 / 1883
Bridge 13508 / 9101
public-sync 28172 + 33560（单实例锁）
HDC fport tcp:9001 -> tcp:9000
DAYU homemon 4090 / 9000
模拟器 127.0.0.1:5555
```
