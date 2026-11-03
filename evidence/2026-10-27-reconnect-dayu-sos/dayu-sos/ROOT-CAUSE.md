# 根因证据：DAYU200 为什么从未显示随身 SOS

## 1. 设计事实（DESIGN-CONTRACT.md）

随身 SOS 的链路是：实体按键 → ESP32-S3 → M100 4G → 公网 Broker(47.76.70.118:1883)
→ ECS `wearable-mqtt` 适配器 → 公网后端 → 手机 APP。
**ESP32-S3 不启用 Wi-Fi、不经 PC bridge、不经 DAYU homemon。** 2026-10-27 的真机验收
（`evidence/2026-10-27-wearable-4g-gps-map/`）只覆盖了“APP 能看到”，DAYU 本地链路从未参与。

## 2. 现场证据（2026-10-27 22:20–22:50，DAYU200）

### 2.1 DAYU 本地 homemon 只有 3 个 deviceId

- homemon（pid 2327，`/data/homemon/homemon.log`）广播的是 `dayu200-living`（客厅）以及由
  PC bridge 用 `relay` 注入的 `esp32-kitchen`（厨房）/`esp32-bath`（卫生间）。
- 运行中的 DAYU APP 界面与布局 dump 只有 **客厅 / 厨房 / 卫生间** 三个房间
  （`baseline/dayu-layout-before-1.0.4.json`、`baseline/dayu-screen-before-1.0.4.jpeg`），
  没有任何“随身求助”条目。
- 抓取时刻（22:49，DAYU 已掉线但 bridge/broker 仍在跑）本地 bridge broker `home/#` 的
  retain 状态只有 `home/esp32-kitchen/status`、`home/esp32-bath/status`，**没有 esp32-sos**
  （`root-cause/local-broker-home-status-snapshot.json`）。

### 2.2 同一时刻公网后端里 esp32-sos 是真实存在的

用**现有监护人账号**只读登录公网 APP-API 并拉取（不写任何数据、不打印凭据）：

- `GET /api/v1/devices` 返回 `esp32-sos`（`state=NORMAL`、`online=true`、`lastSeenTs` 随心跳刷新）；
- `GET /api/v1/location` 当时没有该设备记录（= 当前无有效 GPS fix，这与“无定位不造假”一致）；
- 快照见 `root-cause/backend-api-readonly-mirror-status.json`
  （mirror 以 `--transport tcp --listen-port 19002` 只读运行 15s，未向 homemon 注入任何行）。

结论：**事件/状态真实存在于公网侧，但不在 DAYU 本地链路** —— 这正是“DAYU 从未显示”
的根因；修复方式必须是 PC 侧把公网侧状态镜像进 homemon/或直连 APP 的 TCP 通道，
而不能指望 homemon 自己收到 4G 数据。

### 2.3 为什么不能“让 DAYU 直连公网”

- DAYU 的 `wlan0` 在 22:20 前只有 IPv6/无 IPv4（20:26 证据亦记录 wlan0/eth0 无 IPv4），
  现场演示不能依赖 DEVICE 主动访问公网 ECS/后端。
- 因此由 PC（与 DAYU 同 USB/HDC）做镜像：PC 访问公网，再把状态写回 DAYU。

### 2.4 为什么 PC 不能直接用 MQTT 订阅（本任务实测的限制）

ECS 的 `wearable-mqtt` Broker 按 env `MQTT_CLIENT_ID` 做**严格 clientId 白名单**
（`competition/cloud/wearable-mqtt/src/mqtt-broker.js`），且同 clientId 新连接会踢掉设备。
`competition/.secrets/wearable-mqtt.env` 只有 `wearable-sos-001` 一个 id：
- 用新 id 订阅 → CONNACK rc=5（未授权）；
- 复用 `wearable-sos-001` → 会把 M100/esp32-sos 踢下线。
因此当前主路径改为**现有监护人账号轮询公网 APP-API**（与手机 APP 完全同源，只读，
不新造账号），`--source mqtt` 待 ECS 白名单加入 `wearable-mirror-001` 后启用。

## 3. 修复前基线里顺带复现的缺陷

`baseline/dayu-screen-before-1.0.4.jpeg` / `baseline/dayu-layout-before-1.0.4.json`：
选中“厨房”tab 时，预警卡片显示 `厨房 · 20:23`，而该 `NO_MOTION` 事件的房间归属并未按
告警自身 deviceId 取——标签跟随了当前选中 tab。1.0.5 已改为按告警自身 `room/deviceId`
显示（见 `CHANGES.md`）。
