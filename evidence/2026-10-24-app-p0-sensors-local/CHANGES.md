# APP-P0-Sensors 变更说明（2026-10-24）

## 修改范围

仅修改手机 APP 源码和测试，不改 gateway/backend/ESP32/DAYU/4G/COM8，不覆盖冻结 HAP。

### 1. DevicePage 传感器行

文件：`<WORKSPACE>\APP\ElderlyCareGuardian\entry\src\main\ets\pages\DevicePage.ets`

原 `sensorChips()` 只显示：

```text
s.name + s.stateText
```

单行胶囊，无法展示 ADC 数值/详情，且动态详情不能安全容纳。

修改为 `sensorRow()` + `sensorChips()`：

- 第一行：传感器名称 + 状态；
- 第二行：`s.valueText`（原始 ADC / 最近活动 / 今日暂无活动时间 / --）；
- 第三行：`s.detailText`（报警未启用/未标定/离线语义/PIR 今日次数等）；
- 长文本 `maxLines(2/3)` + `textOverflow`，不固定高度，不嵌套装饰卡；
- 直接消费 `SensorView`，与 MonitorPage 使用同一 ViewMapper 结果，不复制判断规则。

### 2. Motion 字段存在性

文件：`<WORKSPACE>\APP\ElderlyCareGuardian\entry\src\main\ets\core\api\Contracts.ts`

`MotionSensorDto` 新增：

```text
lastActiveTsPresent
countTodayPresent
```

`parseMotion()` 仅在响应中确实存在合法非负数时设置 present；缺失不再由默认 0 冒充真实值。

### 3. PIR 展示语义

文件：`<WORKSPACE>\APP\ElderlyCareGuardian\entry\src\main\ets\core\view\ViewMapper.ts`

`buildMotionView()`：

- 两个字段都缺失：state=`unknown`，value=`--`，说明“未收到 PIR 活动字段”；
- 仅有最近活动：显示最近活动，今日次数显示“今日次数未知”；
- 仅有今日次数：显示今日次数，最近活动显示未知；
- 不使用默认 0 次作为真实活动；
- 既有离线/NO_MOTION 语义保持。

### 4. MonitorPage

本文件未修改：

- `page/MonitorPage.ets` SHA-256 与修改前一致；
- 在线设备摘要仍是 `build()` 内联 `Text(this.onlineRatio())`；
- 未恢复 `devicesVersion`、`liveDevices`、测试快照按钮；
- SensorCard 已有 `valueText`/`detailText` 展示，故不做无意义重写。

### 5. 测试

文件：`test/ValidContract.test.ets`

新增 12 条专项用例，覆盖：

- gas raw=0 valid=true 仍报警未启用、不显示正常；
- smoke raw 显示原始 ADC；
- gas/smoke invalid 不沿用旧值作为当前有效值；
- valid 缺失为 unknown；
- raw 缺失不补 0；
- 厨房离线保留上次 ADC；
- PIR 最近活动/今日次数；
- PIR 缺 count 不伪造 0；
- PIR 两字段缺失为 unknown；
- 厨房无 PIR、卫生间无 MQ；
- `parseDevice()` 对 PIR `countToday` 缺失/非法时 presence=false，避免手工 DTO 测试掩盖解析缺口。

## 未修改

- `DeviceCapabilities.ts`（厨房/卫生间能力已正确）；
- `SensorCard.ets`（MonitorPage 已正确消费 valueText/detailText）；
- gateway/backend/ESP32/DAYU/homemon/4G；
- 冻结 HAP；
- 任何 COM 端口、服务或设备。
