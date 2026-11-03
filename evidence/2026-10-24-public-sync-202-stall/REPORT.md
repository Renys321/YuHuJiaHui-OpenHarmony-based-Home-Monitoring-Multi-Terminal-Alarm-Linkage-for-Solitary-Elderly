# public-sync 202 停更：只读定位报告

采集时间：

```text
2026-10-24T01:05:57+08:00
2026-10-24T01:07:57+08:00
```

## 判定

```text
FIRST_DIVERGENCE_MQTT_TO_PUBLIC_SYNC
```

Bridge 持续收到并发布三设备非 retained 状态；`public-sync` launcher/child 当前都不存在，lock 仍指向已退出的 PID 45780。  
因此首个中断点在 **MQTT 状态已有新消息 → public-sync 消费端缺失**，不在 Bridge 输入，也不在 normalize/filter/backend。

## 进程/网络快照

| 组件 | PID | 监听/连接 | 启动时间 | 当前状态 | 证据 |
|---|---:|---|---|---|---|
| Broker | 36920 | 1883 LISTEN；Bridge 已连接 | 00:33:51 | 正常 | 端口/进程 |
| Bridge | 56416 | 9101 LISTEN；两个 ESP32 TCP 入站；9001、1883 ESTABLISHED | 00:34:06 | 持续收到状态 | 端口/日志/MQTT |
| public-sync launcher | 45780 | 不存在 | 00:34:31（lock） | **已退出** | 进程/锁 |
| public-sync child | 49732 | 不存在 | 00:34:31 | **已退出** | 进程 |
| DAYU homemon | 324 | 9000 LISTEN；fport 9001→9000 | 00:33:48 | 正常 | HDC |
| 手机模拟器 | 59864 | 5555 LISTEN | — | 目标在线 | HDC |

public-sync lock：

```text
path=...\2026-10-15-public-sync-dual-device\public-sync.lock
mtime=2026-10-24 00:34:31
lock_pid=45780
PID 45780 不存在
```

public-sync 日志：

```text
last_write=2026-10-24 00:57:47
last_202=2026-10-23T16:57:47.346Z
```

## Bridge 自然帧

Bridge 日志仍更新（`bridge.out.log` mtime 01:06:02），三设备均有自然状态：

```text
dayu200-living  state=ALARM
esp32-kitchen   state=NORMAL
esp32-bath      state=ACKED
```

MQTT 70 秒被动观察（只订阅，不发布）：

```text
clientId=diag-observe-1792775191928
connected at 2026-10-23T17:06:32.018Z
50 messages, all retained=false
```

样例白名单：

```text
kitchen:
  deviceTs=1792775192569
  gas.raw=235, gas.valid=true
  smoke.raw=329, smoke.valid=true

bath:
  deviceTs=1792775193445
  motion.lastActiveTs=1792775078224
  motion.countToday=27

dayu200-living:
  deviceTs=1792775192983
  state=ALARM
```

后续 kitchen 持续变化（233–236 / 327–331），bath countToday 由 27 增至 28，均为非 retained 新消息。  
因此 **Bridge → MQTT 正常**，不是 Bridge 输入缺失。

## public-sync 消费/上传

当前没有 public-sync 进程：

- launcher/child 均无；
- 无 public-sync 到 1883 的 ESTABLISHED；
- 无 public-sync 外部 HTTPS 连接；
- 没有第二逻辑实例；
- lock PID 45780 已不存在，lock 为陈旧锁。

因此无法继续观察到：

```text
MQTT 订阅 → normalize → 过滤 → backend HTTP → 202
```

首个差异位置在 **public-sync 进程/订阅入口**，而不是 normalize/filter 或 backend。

## API lastSeen 对照

最后一次 public-sync 202：

```text
2026-10-23T16:57:47.346Z = 2026-10-24 00:57:47 CST
```

诊断 APP 在 01:02 的认证 GET `/api/v1/devices`（HTTP 200）仍返回：

```text
kitchen lastSeenTs=1792774666564  (约 00:57:46)
bath    lastSeenTs=1792774667387  (约 00:57:47)
```

之后 MQTT 有非 retained 新消息，但 API lastSeen 没有前进。  
这证明不是“仅 public-sync 日志丢失”，而是 202/backend 摄入在 00:57:47 后停止。

## 首个差异点

```text
FIRST_DIVERGENCE_MQTT_TO_PUBLIC_SYNC
```

证据链：

```text
设备自然状态
→ Bridge 处理
→ MQTT 非 retained 新消息（三设备）
→ public-sync 进程不存在（launcher 45780/child 49732 均无）
→ 无 normalize/backend/202
→ API lastSeen 停在 00:57:46/47
```

## 最小恢复建议（未执行，等待授权）

1. 确认 lock PID 45780 不存在（已确认）；
2. 用现有可见启动器 `start-public-sync-visible.cmd` 启动 **一个** public-sync 单逻辑实例；
3. 用户隐藏输入 INGEST_KEY；不写凭据；
4. 确认一个 launcher + 一个 child，lock 指向新 launcher；
5. 不重启 Broker/Bridge/homemon；
6. 等待自然 202，确认 API lastSeen 前进；
7. 若启动失败，保留现场并报告错误分类，不盲目反复重启。

## 未执行

- 未启动/重启 public-sync；
- 未 kill 任何进程；
- 未删除/修改 lock；
- 未重启 Broker/Bridge/homemon/模拟器；
- 未发布 MQTT；
- 未安装任何 HAP；
- 未操作 COM5/COM14/COM8；
- 未更新最终交付版本。
