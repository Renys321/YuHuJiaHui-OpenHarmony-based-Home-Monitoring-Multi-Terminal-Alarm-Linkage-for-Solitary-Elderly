# 随身 SOS（ESP32-S3 + M100MG-B1 4G + APP 地图 + ACK）集成契约 v1

**状态**：执行中的实现契约。任何 teammate 的实现必须符合本文件；改动本文件只能由 Lead 进行，
或由现实现状倒逼修订后在交付报告中明确记录。

## 1. 端到端链路

```
实体按钮 GPIO4
  → ESP32-S3 wearable 固件（蜂鸣器 GPIO5 立即响）
  → UART1（ESP32 GPIO17=TX → M100 RXD；GPIO18=RX ← M100 TXD；GND 共地，115200 8N1）
  → M100MG-B1 DTU MQTT 透传：UART 字节 = MQTT payload（原样）
  → 公网 Broker（阿里云 ECS 47.76.70.118:1883，用户名/密码，MQTT 3.1.1）
      topic 上行：eldercare/wearable/sos-001/up
      topic 下行：eldercare/wearable/sos-001/down
  → ECS 上的 wearable-mqtt 适配服务（同进程内置最小 MQTT Broker + 后端适配器）
  → 现有后端公网 API（容器内 http://backend:8080，x-ingest-key）
      POST /internal/v1/device-status          (deviceId=esp32-sos, state=ALARM, alarm{id,type=MANUAL_SOS})
      POST /api/v1/ingest/wearable/location    (token, deviceId=wearable-sos-001, WGS84)
      GET  /internal/v1/commands?after=N       (领取 ACK 命令)
      POST /internal/v1/commands/<id>/result   (仅设备真实回执后上报)
  → 现有 APP（com.example.program_04）告警详情页内嵌地图 + ACK
  → 监护人点确认 → 后端产生 ack 命令（PENDING）→ 适配器下发 MQTT down
  → M100 → UART → ESP32 收到匹配 ACK → 停止提示 → 上报 ack 回执
  → 适配器 POST command result → 后端告警 ACKED（APP 显示“设备已确认”）
```

## 2. 身份与命名（不可自行更改）

| 项 | 值 | 说明 |
|---|---|---|
| MQTT Client ID | `wearable-sos-001` | M100“登录客户端 ID” |
| 上行主题 | `eldercare/wearable/sos-001/up` | M100“发布消息主题” |
| 下行主题 | `eldercare/wearable/sos-001/down` | M100“订阅消息主题” |
| APP/后端设备 ID | `esp32-sos` | 后端 `getWearableAlertLocation` 只认这个 deviceId（硬编码） |
| 位置记录 deviceId | `wearable-sos-001` | 后端 `WEARABLE_LOCATION_DEVICE_ID` 只接受这个值 |
| 房间/显示名 | `随身求助` | 后端 room 字段 |

## 3. UART 行协议（ESP32 ↔ M100，UTF-8 JSON 单行、`\n` 结尾、≤512 字节）

ESP32 无 Wi-Fi、无 RTC：**不得伪造设备墙钟时间**。时间统一用 `uptimeMs`（开机毫秒）；
后端以接收时间作为事件时间。

### 3.1 上行（ESP32 → M100 → MQTT up）

```json
{"v":1,"t":"sos","dev":"esp32-sos","alarm":"sos-<n>-<rand>","uptimeMs":12345,"seq":1,"gps":{"lat":32.9671,"lon":112.5532,"fix":true,"ageMs":8000}|null}
{"v":1,"t":"hb","dev":"esp32-sos","state":"IDLE|ALARM","alarm":"","uptimeMs":23456,"csq":26}
{"v":1,"t":"ack","dev":"esp32-sos","alarm":"sos-1-ab12cd","cmd":"<commandId>"}
{"v":1,"t":"boot","dev":"esp32-sos","uptimeMs":0,"fw":"wearable-1.0.0"}
```

规则：
- `alarm` 匹配 `/^[A-Za-z0-9._:-]{1,80}$/`（后端 ALARM_ID_RE）。生成规则：
  NVS 计数器 + 4 字节随机 hex，同一事件重试**永远沿用同一 alarmId**。
- `gps` 可为 `null`；无定位不得阻塞 SOS。
- 同一 alarmId 的重试包内容允许 `uptimeMs/seq` 变化，`alarm`/`t` 不变；适配器按 alarm 去重。
- 心跳每 30 s 一条，断网恢复后立即补发当前状态。

### 3.2 下行（MQTT down → M100 → ESP32）

```json
{"v":1,"t":"ack","alarm":"sos-1-ab12cd","cmd":"42"}
```

**真机约束（2026-10-27 实测）**：M100 把 MQTT 下行 payload **原样**写到串口，
**不会追加 `\n`**。而 ESP32 固件按行解析，缺 `\n` 会一直卡在行缓冲。因此：
- 适配器发布的 downlink payload **必须**是 `JSON + "\n"`；
- 固件同时实现“空闲 100ms 成帧”兜底（缓冲区非空且 100ms 无新字节即按整行处理），
  防止任何服务端漏加换行。

- ESP32 **只**在 `alarm` 等于当前未完成事件的 alarmId 时结束提示并置 IDLE；
  `cmd` 存在时必须与当前已下发命令一致（用于回执关联）。
- 其他内容（M100 自身回包、GPS 固定格式、未知行）一律忽略并记日志，不改变告警状态。

## 4. M100 GPS 主动上报

- 定位 → GPS 定位：启动、更新时间 30 s、主动上报内容格式 = **固定格式**、通道 = 网络通道1。
- 固定格式报文与业务 JSON 共用 up 主题，适配器必须：
  1. 先尝试 JSON 解析（业务协议）；
  2. 非 JSON 且不含 `{` 的报文交给 GPS 固定格式解析器（度分转十进制、WGS84）；
  3. 解析成功 → 写 `wearable-sos-001` 位置记录；失败 → 仅记诊断计数，不写入假坐标。
- 坐标：GNSS 输出 WGS84。后端存 WGS84；**坐标系转换只在 APP 显示层做一次**（WGS84→GCJ-02）。

## 5. 适配器 ↔ 后端契约

> **部署事实（2026-10-27 实测，Lead 决策）：公网后端不重新部署。**
> 公网 `GET/POST /api/v1/ingest/wearable/location`（带有效 Bearer）返回 **404**，说明现网镜像
> 不含该路由；而现网镜像已包含健康评估/门磁/活动报告等 D/E 既有功能，用本地源码重建会
> 回退这些功能，风险不可接受。因此本次**不使用** `wearable-sos-001` 位置记录与 `sosLocation`
> 字段，位置信息统一走设备状态的 `gps` 字段（现网 `/api/v1/location` 已支持并实测返回）。
> 既有 D/E、门磁 v7、健康评估部署保持不变。

### 5.1 SOS → 创建告警

```
POST /internal/v1/device-status
x-ingest-key: <INGEST_KEY>
{
  "deviceId":"esp32-sos","room":"随身求助","state":"ALARM","online":true,"monitorOnline":-1,
  "ts":<serverNowMs>,
  "alarm":{"id":"sos-...","type":"MANUAL_SOS","countToday":1},
  "gps":{"valid":true,"latitude":...,"longitude":...,"fixTime":<serverNowMs>},
  "csq":26
}
```
返回 202 即成功。同一 alarmId 重复状态不得产生第二条告警（后端按 alarmId 幂等；测试证明）。

### 5.2 GPS → 设备状态 `gps` 字段（**不使用**位置 ingest 端点）

M100 每 30 s 主动上报的固定格式坐标由适配器解析后：
- 维护“最新位置”；收到 SOS 时把**当时最新位置快照为本次事件的 `eventGps`**；
- 本次事件未 ACK 前，所有 `device-status` 都带 `eventGps`（求助时刻位置，不被后续报文覆盖）；
- 收到设备真实 ACK 后恢复携带“最新位置”。
- `gps = {valid:true, latitude, longitude, fixTime: <该定位报文收到时间>}`；无 fix 时
  `valid:false` 且经纬度为 null（**不能**用 0 冒充坐标）。
- 现网 `GET /api/v1/location` 返回 `{locations:[{deviceId,latitude,longitude,fixTime}]}`，
  APP 用它按 `deviceId=esp32-sos` 取点，并用 `fixTime` 与告警 `createdAt` 比较标注
  “求助时刻位置 / 求助后更新”。

### 5.3 ACK 命令（真实字段，已实测）

```
GET /internal/v1/commands?after=<lastId>
  → { commands:[{ id, deviceId, command:'ACK', alarmId, action, status, ... }] }
```
- `after` 是**严格大于**的数值游标；返回 id>after 的**全部**命令（含其他设备、含已完结）。
- 只处理 `deviceId === "esp32-sos" && command === "ACK" && status === "PENDING"`。
- 下发 JSON 到 down 主题，重发 3 次（间隔 5 s）。
- **只有**收到设备 `t:"ack"` 且 alarm 匹配后才
  `POST /internal/v1/commands/<id>/result`，body：
  ```json
  {"status":"ACKED","deviceState":{"deviceId":"esp32-sos","room":"随身求助","online":true,
   "state":"ACKED","ts":<ms>,"alarm":{"id":"<alarmId>","type":"MANUAL_SOS","countToday":1}}}
  ```
- 无回执则保持 PENDING（APP 显示 ackPending=等待/超时），绝不在服务器收到点击时冒充设备确认，
  也不代报 FAILED。

## 6. 固件行为硬约束

- 按键：GPIO4 内部上拉、低电平按下、20 ms 采样 + 60 ms 消抖；按下**立即**蜂鸣（<100 ms）。
- 蜂鸣：GPIO5 高电平触发；模式：SOS 急促（3 短声循环），自动静音 30 s 后仅停止声音，
  **事件仍为未确认状态**（不因静音而清除）。
- 事件持久化：alarmId + 状态写入 NVS；重启后若事件未确认，继续用原 alarmId 重试并恢复提示
  （日志明确 `恢复未确认事件`），不得静默丢弃。
- 重试：未收到匹配 ACK 时每 10 s 重发同一 SOS 包；MQTT/4G 断开期间同样重试。
- 收到 ACK 后置 IDLE 并允许下一次按键生成**新** alarmId（计数器递增）。
- 不启用 Wi-Fi（`CONFIG_ESP_WIFI_ENABLED=n` 或不初始化），不使用云端中转。

## 7. 验收口径

- 实体按键触发、蜂鸣、APP 告警、APP 地图、APP ACK 回设备、设备结束、再次按键新事件、
  无 GPS 仍求助、断网恢复不丢不重、脱离电脑供电——逐项单独取证。
- 软件注入测试（模拟设备 MQTT 报文）必须与实体按键验收分开标注。
