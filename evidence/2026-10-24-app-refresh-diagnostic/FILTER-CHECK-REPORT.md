# MonitorPage 筛选排除结果（2026-10-24）

## 先撤回

此前 `MONITORPAGE_RECREATED_STILL_STALE` 未经证明，现撤回。  
源码 `Index.ets` 使用持久 `Tabs → TabContent → MonitorPage()`，切页不保证重建页面；`MonitorPage.ets` 的 `activeKind` 是 `@State` 持久筛选状态。

## 当前现场

```text
APP PID=3436（全程未变）
冻结 HAP=8A722…
F91852=未安装
public-sync=launcher 51880 / child 53708
```

## 筛选栏与高亮

可见标签（布局 dump/截图）：

```text
全部
温湿度
燃气
烟雾
活动
门窗
```

截图确认：

```text
“全部”是蓝色高亮
```

因此当前**不是**未选“全部”的筛选状态。

线索：layout dump 的 Text 节点 `selected=false`，不能表达视觉高亮；高亮由截图确认。

## 点击“全部”后

只点击一次“全部”，不刷新，等待 2 秒；PID 仍 `3436`：

```text
实时监测
上次更新 01:22 · 数据已同步
在线设备 3/5
监测异常 0
待确认告警 22

卡片区域：
- 客厅：人体活动、门磁、燃气、烟雾、温湿度
- kitchen：未出现
- bath：未出现
```

再次点击“全部”后（01:23）仍相同，PID 仍 3436。

## 关键矛盾

- 摘要 `3/5` 来自同一个 `this.devices`，说明 `devices.length=5`；
- 卡片却只包含客厅 sensors；
- 所以不是 `activeKind` 筛选，而是 `allSensors()` 只拿到了客厅的 `sensors`；
- 即 `gv.devices` 中 kitchen/bath 的 DeviceView.sensors 很可能为空/缺失，或 APP 自己收到的 `/devices` 响应只对客厅有 sensors；
- 冻结 HAP 没有分层日志，无法区分这两者。

## 同期 API

同窗口脱敏认证探针（01:19:51）：

```text
auth_http=200
devices_http=200

kitchen:
  lastSeenTs=1792775987231
  gas.raw=287, valid=true
  smoke.raw=366, valid=true

bath:
  lastSeenTs=1792775988608
  motion.lastActiveTs=1792775891843
  motion.countToday=45

living:
  lastSeenTs=1792775988601
  state=ALARM
```

API 仍有 kitchen/bath sensors；页面没有对应卡片。

## 最终分类

```text
ALL_FILTER_STILL_ONLY_LIVING
```

细分：

```text
- MonitorPage `devices.length=5`（摘要 3/5）
- `allSensors()` 实际只有客厅 sensors
- 因此问题在 sensors 数据进入 allSensors 之前或期间
- 不归因于 activeKind 筛选
- 不归因于旧 MonitorPage 实例
```

不能进一步归因给 ArkUI `ForEach`/`SensorCard`，因为 kitchen/bath 整个设备卡片都没有；下一步需要分层诊断确认：

```text
API /devices → parseSensors → mapDevices → AppStorage gv.devices → MonitorPage allSensors
```

## 未执行

- 未安装任何诊断 HAP；
- 未安装 F91852；
- 未重启 APP/模拟器/Broker/Bridge/public-sync/homemon；
- 未操作 COM5/COM14/COM8；
- 未发布 MQTT/ingest/SOS/ACK/reset；
- 未执行手动刷新（因为设备卡片本身不完整，不是“设备存在但值旧”）；
- 未修改源码或最终交付。
