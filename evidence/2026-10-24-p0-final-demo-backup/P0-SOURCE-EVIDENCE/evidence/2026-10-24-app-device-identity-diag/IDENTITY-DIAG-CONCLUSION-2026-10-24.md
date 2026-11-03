# Device Identity Diagnostic 结论（2026-10-24 安装后同 PID）

## 构建与安装事实

```text
HAP   <WORKSPACE>\competition\evidence\2026-10-24-app-device-identity-diag\
      guardian-app-device-identity-diag-unsigned.hap
size  2,127,873 B
sha256 42F8CE61754E06BBFE5B7BA2D1E50202CDF07E975D6CA89B476EDE08C52B646F
target 127.0.0.1:5555（既有 Mate 90 Pro 模拟器，未新建、未清数据）
install  hdc -t 127.0.0.1:5555 install -r <HAP>  -> install bundle successfully.
APP PID 5386（安装后启动，全部诊断层均来自同一 PID）
```

## 同 PID 分层证据（console.info 前缀 DeviceIdentityDiag）

时间 2026-10-24 23:05:14 ~ 23:05:44，APP PID 5386：

```text
A. HTTP raw（5 台设备）
  esp32-kitchen      roomId=厨房   roomName=厨房
                     climate temp=25.2 rh=59.1；gas raw=144 valid=true；smoke raw=219 valid=true
  yed-home-gateway   roomId=家庭网关 无 sensors
  dayu200-living     roomId=客厅    roomName=客厅
  dayu200-01         roomId=客厅    roomName=客厅（历史设备）
  esp32-bath         roomId=卫生间  roomName=卫生间
                     motion last=1792854304636 countToday=25
                     gas raw=0 valid=false；smoke raw=0 valid=false

B. DTO parseDevice/parseSensors
  5/5 设备 deviceId/roomId/roomName 与 raw 一致；
  kitchen gasRaw=144 smokeRaw=219；bath motionCount=25。

C. ViewMapper（map.device / map.sensor）
  map.devices.count=5（两轮刷新）
  esp32-kitchen  sensorsLength=3：climate/gas/smoke，roomName=厨房
  esp32-bath     sensorsLength=2：climate/motion，roomName=卫生间（无 gas/smoke）
  dayu200-living sensorsLength=5（pending 待确认）
  yed-home-gateway sensorsLength=0
  每个 SensorView 的 deviceId/roomId/roomName/kind 均正确。

D. AppStorage gv.devices（storage.audit）
  duplicateIds=none
  sensorDeviceIdMismatches=0

E. MonitorPage（同 PID，点击底部“监测”后）
  pageId=monitor-1792854344684 activeKind=all devicesLength=5
  allSensors=15 filtered=15
  monitor.allSensors / monitor.filtered 逐项 roomName：厨房/客厅/卫生间均正确；
  monitor.foreachKey 为 esp32-kitchen_climate、esp32-kitchen_gas、
  esp32-kitchen_smoke、dayu200-living_*、dayu200-01_*、esp32-bath_climate、
  esp32-bath_motion，无重复、无错配。
  UI 同时显示：3/5 在线设备；厨房卡片“燃气（MQ-5）报警未启用 原始 ADC 142”、
  “烟雾（MQ-2）原始 ADC 219”；客厅待确认卡片；卫生间卡片。

F. 首页
  3/5 在线/设备（与 MonitorPage 的 3/5 一致）。
```

证据文件：

```text
runtime-identity-after-login-2026-10-24.log
runtime-identity-monitorpage-2026-10-24.log
（另存 UI layout dump 与 MonitorPage 文本快照）
```

## 结论

```text
PRIOR_IDENTITY_MISMATCH_NOT_REPRODUCED_AFTER_INSTALL
```

说明：

1. 安装重启清除了原内存现场，因此**不能**写成“身份错配已修复”或“首个差异层已定位”。
2. 本次在同一 APP PID 下，从 HTTP raw → DTO → ViewMapper → AppStorage → MonitorPage
   的 deviceId/roomId/roomName/kind 全部一致；原始的“全部筛选下卡片脚注都显示客厅”
   未再出现。
3. 历史分类 `ALL_FILTER_ONLY_LIVING_ROOM_LABEL` / `SENSOR_DEVICE_IDENTITY_UNKNOWN`
   在本轮现场未复现；只能作为历史现象保留。
4. 本轮没有修改 APP 业务代码；随后安装的 APP-P0-Sensors 候选才是 P0-B 的验收对象。
