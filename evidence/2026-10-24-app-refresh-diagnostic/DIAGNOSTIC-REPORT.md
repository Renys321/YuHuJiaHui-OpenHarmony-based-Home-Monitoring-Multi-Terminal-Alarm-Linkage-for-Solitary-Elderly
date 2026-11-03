# APP Refresh 诊断报告（2026-10-24）

## 判定

```text
PRIOR_STALE_NOT_REPRODUCED_AFTER_INSTALL
```

不是 `FIRST_DIVERGENCE_CONFIRMED`，也不是 `RESTART_RECOVERED` 的“修复”结论。  
安装诊断 HAP 会重启 APP，已明确可能清除旧内存状态；不能把首次恢复写成修复。

## 诊断包

```text
<WORKSPACE>\competition\evidence\2026-10-24-app-refresh-diagnostic\
guardian-app-refresh-diag-unsigned.hap
size=2,102,896 B
sha256=0A2AD6643EB41250E23C718A8E740E239D9227A32A8B38D455CFA1BB73D20F18
```

已覆盖安装；安装后一度出现手机目标丢失，恢复后重新安装一次；最终已用冻结包回退。

## 运行事实

安装后 APP PID：`2037`。

自动 refresh：

```text
01:00:49  r1792774849348-1-auto  NEW
01:01:19  r1792774879393-2-auto  NEW
01:01:49  r1792774909595-3-auto  NEW
01:02:19  r1792774939859-4-auto  NEW
```

手动 refresh：

```text
01:02:31  r1792774951908-5-manual  NEW  inFlight=false inFlightScope=-1
```

## 同 refreshId 时间线（手动）

以 `r1792774951908-5-manual` 为例：

```text
refresh.enter:
  origin=manual
  singleFlight=NEW
  inFlight=false
  sessionGeneration=1
  apiBase=https://api.luxunacc.xyz

http.start:
  GET /api/v1/devices
  cache=false
  origin=https://api.luxunacc.xyz

http.end:
  status=200
  elapsedMs=278

devices.dto:
  count=5
  kitchen lastSeen=1792774666564
  gas.raw=233
  gas.valid=true
  smoke.raw=329
  smoke.valid=true
  bath lastSeen=1792774667387
  motion.lastActiveTs=1792774594673
  motion.countToday=22

devices.mapped:
  kitchen gas=上次读数 原始 ADC 233 / offline / valid
  kitchen smoke=上次读数 原始 ADC 329 / offline / valid
  bath motion=上次读数 最近活动 5 分钟前 / offline

devices.storage.before:
  count=5, kitchen=233/329

devices.storage.after:
  count=5, kitchen=233/329

refresh.aggregate:
  success=4 total=4 stale=0 relogin=false devicesView=5

refresh.lastUpdated:
  before=1792774940015
  after=1792774952204
  devicesInStorage=5

page.manual.outcome:
  page=monitor-1792774943484
  ok=true partial=false stale=false unauthorized=false
  updatedAt=1792774952204

page.afterManualRefresh:
  deviceCount=5
  lastUpdatedAt=1792774952204
  netStatus=ok
  kitchen=233/329

page.toast:
  toast=success
```

页面最终文本：

```text
实时监测
上次更新 01:02 · 数据已同步
厨房 · 4 分钟前
燃气（MQ-5） 上次读数 原始 ADC 233
烟雾（MQ-2） 上次读数 原始 ADC 329
设备离线，展示上次读数
```

## 分层结论

| 层 | 观察 | 结论 |
|---|---|---|
| HTTP 是否发起 | 自动/手动均有 `GET /api/v1/devices` | 有 |
| URL/base | `https://api.luxunacc.xyz/api/v1/devices` | 与探针同 origin |
| 缓存 | `usingCache=false`，status 200，无 304 | 未发现缓存命中 |
| single-flight | 全部 NEW，手动 inFlight=false | 未 REUSED |
| HTTP 响应 | 200，DTO gas 233/smoke 329 | 当前快照 |
| mapDevices | 233/329，offline（lastSeen 已超 90s） | 与 DTO 一致 |
| AppStorage 写入/读回 | 前后均 5 台、233/329 | 一致 |
| MonitorPage 消费 | 页面刷新后 233/329 | 一致 |
| toast | `数据已刷新`，对应 refreshId | 一致 |
| 原 332/527 | 安装后未再出现 | **未复现** |

## 关键限制

诊断期间 public-sync 最后一次 202 为：

```text
2026-10-23T16:57:47.346Z = local 2026-10-24 00:57:47
```

之后没有再产生 202；但 Bridge 仍有自然状态日志。  
因此：

- 诊断 APP 能取到 API 最后一版快照 233/329；
- 不能证明安装后**新的自然快照**继续流到 API；
- 原冻结 APP 的 332/527 旧状态在安装重启后消失，属于 `PRIOR_STALE_NOT_REPRODUCED_AFTER_INSTALL`；
- 不能写成刷新缺陷已修复，也不能写 `FIRST_DIVERGENCE_CONFIRMED`。

## 回退

冻结 HAP：

```text
<WORKSPACE>\competition\evidence\2026-10-22-monitor-inline-summary-local\
guardian-inline-summary-formal.hap
size=2,077,912 B
sha256=8A722EB6FDA7BB73EE58F3BDA3D95B5D238401DA8E3CC9179F1286FD5253A985
```

已重新核对哈希并执行：

```text
hdc -t 127.0.0.1:5555 install -r <frozen HAP>
restore_exit=0
```

未安装 F91852；未执行 PIR/离线验收。

## 本轮未做

- 未安装 F91852；
- 未修改业务代码；
- 未重启 Broker/Bridge/public-sync/homemon/模拟器/设备；
- 未操作 COM5/COM14/COM8；
- 未发送 MQTT、ingest、SOS、ACK、reset；
- 未执行正式页面/PIR/离线验收；
- 未更新最终交付清单。
