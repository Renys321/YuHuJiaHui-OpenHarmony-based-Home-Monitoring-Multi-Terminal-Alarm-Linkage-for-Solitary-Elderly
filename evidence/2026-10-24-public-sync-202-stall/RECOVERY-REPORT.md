# public-sync 最小恢复与自然链路验收（2026-10-24）

## 恢复结果

```text
PUBLIC_SYNC_RECOVERED
```

但不能宣布整体验收通过，因为冻结 APP 自动刷新仍未恢复。

启动来源：

```text
<WORKSPACE>\competition\evidence\2026-10-15-public-sync-dual-device\
start-public-sync-visible.cmd
size=581 B
sha256=64F9414419B9D78F533DAB018C7514EEBB523A8394662AF274D58AF74E92151B
```

启动前确认：

```text
PID 45780 不存在
PID 49732 不存在
lock=45780（stale）
```

启动后：

```text
launcher PID=51880
child PID=53708
lock=51880
child -> 1883 ESTABLISHED
```

没有第二逻辑实例；启动后进程未再次退出。

## 自然 202

恢复后第一批：

```text
kitchen  202 at 2026-10-23T17:10:55.939Z
bath     202 at 2026-10-23T17:10:56.777Z
living   202 at 2026-10-23T17:10:57.201Z
```

第二轮：

```text
kitchen  202 at 2026-10-23T17:11:28.647Z
bath     202 at 2026-10-23T17:11:29.628Z
living   202 at 2026-10-23T17:11:30.277Z
```

第三轮：

```text
kitchen  202 at 2026-10-23T17:12:01.416Z
bath     202 at 2026-10-23T17:12:02.514Z
living   202 at 2026-10-23T17:12:02.966Z
```

三设备各至少 3 个恢复后自然 202。

## 脱敏 API 复核

```text
probe=OK
auth_http=200
devices_http=200
capturedAt=2026-10-24T01:13:11.9447554+08:00
```

白名单：

```text
esp32-kitchen:
  lastSeenTs=1792775587223
  gas.raw=275, gas.valid=true
  smoke.raw=351, smoke.valid=true

esp32-bath:
  lastSeenTs=1792775588288
  motion.lastActiveTs=1792775587002
  motion.countToday=37

dayu200-living:
  lastSeenTs=1792775589058
  state=ALARM
```

API lastSeen 已从 00:57:46/47 前进到约 01:13。  
DAYU ALARM 按自然状态上传，未隐藏、未 ACK。

## 冻结 APP 自动恢复检查

启动冻结 HAP 后 PID：

```text
3436
```

自然等待两轮（约 65 秒，不重启、不手工刷新）：

```text
首页: 3/5，dayu 显示“刚刚”
监测页: 上次更新 01:14 · 数据已同步
厨房: 10 分钟前，gas.raw=233，smoke.raw=329
```

但同一窗口 API 已是：

```text
gas.raw=275
smoke.raw=351
bath motion.countToday=37
```

因此：

- public-sync/API 恢复成功；
- **冻结 APP 的自动刷新仍未消费当前 API**；
- 不能安装 F91852；
- 不能更新最终版本。

## 当前状态

- 冻结 HAP 仍为 `8A722…`；
- F91852 未安装；
- public-sync 单实例运行中；
- 未执行 PIR/离线正式验收；
- 未发送 ACK/SOS/reset；
- 未操作 COM5/COM14/COM8；
- 未更新最终交付清单。

## 下一步

先单独定位冻结 APP 的自动轮询/刷新为何未消费当前 API。  
在该问题解决前，不安装 P0 候选，不做 PIR/离线验收。
