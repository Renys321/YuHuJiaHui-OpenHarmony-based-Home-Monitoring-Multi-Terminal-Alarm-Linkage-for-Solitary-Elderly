# public-sync 二次退出：PUBLIC_SYNC_RUNTIME_EXIT_REPRODUCED

采集时间：2026-10-24 01:35 CST

## 事实

第二次恢复后的 public-sync：

```text
launcher=51880
child=53708
lock=51880
```

已再次退出。当前：

```text
PID 51880 不存在
PID 53708 不存在
lock 仍为 51880
public-sync.out.log 最后写入 2026-10-24 01:34:11
最后日志：
  ... status=202 at 2026-10-23T17:34:10.425Z
  [command-sync] POLL_OK ... at 2026-10-23T17:34:11.014Z
```

没有可取得的 exit code 或 exit 日志；日志没有 `[run-public-sync] public-sync exited`。  
因此只能确认进程在 01:34:11 后消失，不能猜测退出原因。

## 同时

Bridge 仍持续收到自然状态：

```text
esp32-kitchen state=NORMAL
esp32-bath state=ACKED countToday=54
dayu200-living state=ALARM
```

APP 仍为冻结 HAP，PID 3436 未变。

## 判定

```text
PUBLIC_SYNC_RUNTIME_EXIT_REPRODUCED
```

这是既有 public-sync 进程的二次非正常消失，不是设备停止上报，也不是 Bridge 停止。

## 对身份诊断的影响

身份诊断 HAP 已构建且测试通过：

```text
<WORKSPACE>\competition\evidence\2026-10-24-app-device-identity-diag\
guardian-app-device-identity-diag-unsigned.hap
size=2,127,873
sha256=42F8CE61754E06BBFE5B7BA2D1E50202CDF07E975D6CA89B476EDE08C52B646F
```

但安装前门禁要求确认 public-sync 单实例仍健康；该条件已失败。  
**未安装身份诊断 HAP**，因为安装会重启 APP 并销毁 PID 3436 现场，而此时上游 API 再次停止，无法得到可信的当前身份链。

## 本轮未执行

- 未安装身份诊断 HAP；
- 未安装 F91852；
- 未再次启动 public-sync；
- 未 kill 任何进程；
- 未修改/删除 lock；
- 未重启 Broker、Bridge、homemon、模拟器或 APP；
- 未操作 COM5/COM14/COM8；
- 未发布 MQTT/ingest/SOS/ACK/reset；
- 未更新最终交付。

## 下一步

先修复/定位 public-sync 的独立可靠性缺陷（二次退出、无 exit 记录、无守护）。  
在 public-sync 能保持单实例健康并恢复自然 202/API lastSeen 后，再另行授权安装身份诊断 HAP。
