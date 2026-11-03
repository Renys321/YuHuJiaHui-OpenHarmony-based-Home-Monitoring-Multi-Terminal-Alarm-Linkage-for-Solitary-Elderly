# MonitorPage 页面生命周期分流报告（2026-10-24）

## 结论

```text
MONITORPAGE_RECREATED_STILL_STALE
```

更精确地说：

- 首页 overview 路径至少部分更新（3/5、DAYU“刚刚”）；
- 刷新调度至少部分执行（`lastUpdatedAt` 从 01:14/01:18 前进到 01:19）；
- 但 MonitorPage 在切页返回并手动刷新后，仍只显示客厅设备；
- kitchen/bath 卡片没有回来；
- 同期 API 仍有 kitchen 287/366、bath motion 45；
- 因此不能把问题归因于旧 MonitorPage 实例或 ArkUI 单个卡片；共享 `gv.devices` 或 APP 自己收到的 `/devices` 响应仍是未知项；
- 冻结构建没有分层日志（`EXISTING_BUILD_HAS_NO_LAYER_DIAGNOSTICS`），不能据日志缺失推断请求没有发生。

## 现场

APP PID：`3436`（全程未变）  
public-sync：launcher `51880` / child `53708`  
冻结 HAP：`8A722…`  
F91852：未安装

## 三时点对照

### 1. 自动刷新后（01:14–01:18）

```text
首页: 3/5，DAYU“刚刚”
MonitorPage: 上次更新 01:18 · 数据已同步
厨房卡片: 10 分钟前，gas=233，smoke=329（旧）
页面在线数: 3/5
```

### 2. 切回 MonitorPage 后（01:18）

- 从首页切到 MonitorPage；
- 未点击刷新；
- 页面仍只显示客厅相关卡片；
- kitchen/bath 没有出现；
- `lastUpdatedAt=01:18`；
- PID 仍 3436。

### 3. 同一 PID 手动刷新后（01:19）

- 只点击一次现有刷新按钮；
- 等待 toast 完成 + 3 秒；
- 页面 `lastUpdatedAt=01:19`、`netStatus=数据已同步`；
- 仍只显示客厅；
- kitchen/bath 没有回来；
- PID 仍 3436。

### 4. 手动刷新后再重建 MonitorPage（01:20）

- 切到首页，等待 2 秒，再切回 MonitorPage；
- 不点击刷新；
- `lastUpdatedAt=01:20`、`netStatus=数据已同步`；
- 仍只显示客厅，kitchen/bath 没有回来；
- PID 仍 3436。

## API 对照

同窗口脱敏认证探针：

```text
capturedAt=2026-10-24T01:19:51.4462876+08:00
auth_http=200
devices_http=200

esp32-kitchen:
  lastSeenTs=1792775987231
  gas.raw=287, gas.valid=true
  smoke.raw=366, smoke.valid=true

esp32-bath:
  lastSeenTs=1792775988608
  motion.lastActiveTs=1792775891843
  motion.countToday=45

dayu200-living:
  lastSeenTs=1792775988601
  state=ALARM
```

API 仍有 kitchen/bath；页面没有显示它们。

## 判定

```text
MONITORPAGE_RECREATED_STILL_STALE
```

不符合：

- `MANUAL_REFRESH_WORKS_AUTO_REFRESH_STALE`：手动刷新也未恢复；
- `MONITORPAGE_EXISTING_INSTANCE_STALE`：切页返回后仍旧；
- `SENSORCARD_OR_FOREACH_STALE`：整个 kitchen/bath 卡片缺失，不只是单个卡片值旧；
- `MONITOR_SUMMARY_BINDING_STALE`：摘要更新与卡片缺失是不同现象；
- 但 `gv.devices` 是否只含客厅、APP 的 `/devices` 响应是否只含客厅，仍无法从这个冻结 HAP 确认，故不是完整根因结论。

## 下一步

1. 不安装任何 HAP；
2. 保持 PID 3436 和现有服务；
3. 需要带分层诊断的构建，才能确认 APP 自身 `/devices` 响应是否只含客厅、`gv.devices` 是否完整；
4. 在此之前不安装 F91852，不执行 MQ/PIR/离线正式验收；
5. public-sync 人工启动实例仍是独立 P0 可靠性缺口（无错误退出、无守护），不能因当前恢复而移出待办。
