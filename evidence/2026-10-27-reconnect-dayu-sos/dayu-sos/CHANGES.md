# 1.0.5 改动清单（相对 1.0.4 工作副本）

构建源：`competition/experiments/dayu-eldercare-preview-integration-2026-10-25/`
（与线上 1.0.4 同一副本；逐字节备份见 `../source-backup/`，diff 见 `../build/changes-*.diff`）。

## 1. `entry/src/main/ets/model/DeviceModel.ets`

`AlarmItem` 增加**可选**归属/展示字段（不改变既有构造点）：

```
room?: string; source?: string; eventTs?: number; deviceId?: string;
gpsValid?: boolean; gpsLat?: number; gpsLon?: number; gpsFixTime?: number; ackSource?: string;
```

用途：告警卡房间标签/事件时间/位置/ACK 来源取**告警自身**数据，不再依赖当前选中 tab；
`ackSource` 只记录真实回执来源（`device-ack` / `device-ack-via-backend`）。

## 2. `entry/src/main/ets/pages/Index.ets`

### 2.1 报文解析（与 mirror 输出的字段契约对齐）

- `RawMotion` 增加 `supported?/reported?/reason?`（homemon task-4 契约）：
  `supported=false ⇒ 未配置 PIR 无活动监测`；`reported=false ⇒ 暂无有效 PIR 数据`（不得据此说无人）。
- 新增 `RawGps`（`valid/latitude/longitude/fixTime`）；`NodeMsg` 增加可选
  `online/lastSeen/eventTs/acked/ackTs/ackSource/source/gps`。
- `DevSnap` 增加 PIR 能力字段、随身 SOS 展示字段与 `deviceId/source` 归属。

### 2.2 告警去重与归属（修复 Lead 指出的房间标签错误）

- `toSnap` 重写告警并入：**同一 alarmId 只保留一条**，`room` 取告警自身房间、
  `eventTs` 取状态行事件时间、`deviceId` 固定为产生设备；更新时**只允许 待处理→已确认**，
  且 `acked=true` 必须来自状态行 `acked:true`（镜像只在设备真实回执/后端 ACKED 后置位）。
- 告警卡房间/时间改为 `alarmRoomText(item)` / `alarmTimeText(item)`：
  `厨房 · 20:23` 这类标签不再跟随当前选中 tab。
- `alarmDetailText(item)`：无 PIR 设备（或 `supported=false`）的 `NO_MOTION` 历史告警
  显示“未配置 PIR，无活动监测；不代表无人/跌倒”，不再渲染“长时间未检测到活动”。

### 2.3 随身 SOS 展示

- 任意房间 tab 顶部新增**全局“随身求助”横幅**（事件进行中才显示）：
  来源 `esp32-sos`、事件时间、告警状态、GPS 状态与定位时间、ACK 状态；点按跳转到随身设备。
- 选中 `esp32-sos` 时（能力表 `sos=true`，本副本已有该条目）：
  - 实时状态页新增“随身求助（esp32-sos）”卡片：来源/在线、告警状态、事件时间、
    GPS 状态与定位时间、确认状态、最近上报、数据来源（api/mqtt）；
  - 预警处置页卡片显示来源、事件时间、定位文本（无 fix 显示“暂无定位”），
    **不提供本机 ACK 输入/按钮**（随身求助确认只能在手机 APP 上完成，避免假闭环）；
  - 统计报告页不再把无 PIR 表述为“长时间无活动”。
- 设备信息卡：新增随身设备的数据来源/最近上报/位置行；APP 版本行更新为 1.0.5。

### 2.4 PIR 能力契约

- 新增 `motionMonitorConfigured()/motionMonitorText()`：静态能力表 + 状态行
  `sensors.motion.supported/reported` 双重判定；旧 homemon（无字段）按静态能力表回退。
- 实时状态页：未配置 PIR 的房间显示“未配置 PIR，无活动监测”卡片，并说明人员检测来自
  摄像头视觉（不是 PIR）。摄像头/监护字段（`monitorOnline`）保持独立、未混用。

### 2.5 回归边界

- 相机预览/自动监护/视觉推理、`VideoStreamServer`（9301 远程探望）、预览比例调参、
  语音 Ability、房间节点 ACK 流程的代码路径未改动；`settlePending` 逻辑保持原样
  （仅通过 `toSnap` 的告警字段扩展兼容）。
- 房间节点（dayu200-living/esp32-kitchen/esp32-bath）状态解析保持向后兼容：
  新字段全部可选，旧 homemon/bridge 报文行为不变。

## 3. `AppScope/app.json5`

`versionCode 1000004 → 1000005`、`versionName 1.0.4 → 1.0.5`（`module.json` 已核验）。

## 4. 新增 PC 侧镜像（不在 HAP 内）

`competition/cloud/wearable-mirror/`：零依赖 Node 服务，详见其 README。
- `--source api`（当前主路径）：现有监护人账号只读轮询公网 APP-API（devices/alerts/location），
  与手机 APP 同源，同一 alarmId/ACKED/位置；ACKED 由后端在设备真实回执后置位。
- `--source mqtt`（待 ECS 白名单）：直订 `UP_TOPIC`，含 hb/ack/boot 与 M100 固定格式 GPS。
- `--transport relay`（向 homemon 9001 写 `relay <json>`）与 `--transport tcp`
  （PC 9002 + hdc rport，APP 候选端口含 9002）双通道；重连补发、10s 心跳、单实例锁。
- 输出契约：`deviceId=esp32-sos`、`room=随身求助`、`state=ALARM/ACKED/NORMAL`、
  `alarm.id` 原样、`type=MANUAL_SOS`、`gps`（无 fix 时 valid=false + null 坐标）、
  `sensors.motion={0,0,supported:false,reported:false,reason:"not_configured"}`。
