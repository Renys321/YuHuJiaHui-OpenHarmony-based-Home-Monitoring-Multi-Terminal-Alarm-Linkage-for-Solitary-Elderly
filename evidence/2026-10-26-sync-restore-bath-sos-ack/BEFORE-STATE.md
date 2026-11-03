# 恢复前只读状态（2026-10-26 22:51:24）

## 进程（node.exe 命令行）
```
PID=25148 start=2026/10/26 12:23:18 cmd=node --test
PID=41084 start=2026/10/26 16:01:37 cmd="D:\Node\node.exe" <WORKSPACE>\competition\bridge\mqtt_broker.js 1883 
PID=44584 start=2026/10/26 18:31:46 cmd="<USER_HOME>\AppData\Local\OpenAI\Codex\runtimes\cua_node\1fb7137c46617d50\bin\node.exe" ./server.mjs
PID=42784 start=2026/10/26 19:54:11 cmd="<USER_HOME>\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" mqtt_bridge.js --broker 127.0.0.1:1883 --listen 9101 
PID=45712 start=2026/10/26 21:31:29 cmd="D:\DevEcoStudio\DevEco Studio\tools\node\node.exe" --max-old-space-size=8192 --expose-gc --report-on-fatalerror --report-uncaught-exception --report-dir=<USER_HOME>\AppData\Local\Huawei\DevEcoStudio26.0\log\lsp-server\1792594232709 --report-filename=nodejs_error_1793021489764.txt "D:\DevEcoStudio\DevEco Studio\plugins\openharmony\ace-server\out\index.js" --stdio --logger-path=<USER_HOME>\AppData\Local\Huawei\DevEcoStudio26.0\log\lsp-server\1792594232709 --logger-level=INFO --locale=zh-cn
PID=25020 start=2026/10/26 21:31:36 cmd="D:\DevEcoStudio\DevEco Studio\tools\node\node.exe" --max-old-space-size=8192 --max-semi-space-size=16 --expose-gc "D:\DevEcoStudio\DevEco Studio\tools\hvigor\hvigor\src\base\daemon\process\daemon-process-boot-script.js" INFO 0000005075de1d99338fb6f9b29c57228ffc9014083fc2e98a1b88eb9324be0567b053ce3312443ba298231f0e5c8dfd7a4effeb6b9c8b72e470a2b2043f12b5402099a51aa2e63a3a8c28b7f41654452890e03e5c91292d909d2706c2679258
PID=41312 start=2026/10/26 21:31:37 cmd="D:\DevEcoStudio\DevEco Studio\tools\node\node.exe" --max-old-space-size=8192 --max-semi-space-size=16 --expose-gc "D:\DevEcoStudio\DevEco Studio\tools\hvigor\hvigor\src\base\daemon\process\daemon-process-boot-script.js" INFO 0000005075de1d99338fb6f9b29c57228ffc9014083fc2e98a1b88eb9324be0567b053ce3312443ba298231f0e5c8dfd7a4effeb6b9c8b72e470a2b2043f12b5402099a51aa2e63a3a8c28b7f41654452890e03e5c91292d909d2706c2679258
```

## 监听端口
```
TCP    0.0.0.0:1883           0.0.0.0:0              LISTENING       41084
TCP    0.0.0.0:9101           0.0.0.0:0              LISTENING       42784
TCP    127.0.0.1:9001         0.0.0.0:0              LISTENING       27128
TCP    [::]:1883              [::]:0                 LISTENING       41084
TCP    [::]:9101              [::]:0                 LISTENING       42784
```

## 9101 已建立连接
```
TCP    10.127.130.179:9101    10.127.130.71:53166    ESTABLISHED     42784
TCP    10.127.130.179:9101    10.127.130.168:61919   ESTABLISHED     42784
```

## supervisor 状态文件（stale：PID 已不存在）
```json
{
  "supervisorPid": 29940,
  "workerPid": 26264,
  "state": "HEALTHY",
  "startedAt": 1793022563115,
  "heartbeatAt": 1793024612520,
  "restartCount": 0,
  "lastWorkerStartedAt": 1793022572039,
  "lastWorkerExit": null,
  "lastHealthyAt": 1793022572259
}
```

lock 文件内容: 29940（该 PID 已不存在 → stale lock）

## supervisor 日志最后 3 行（最后一条 22:23:12，之后无新日志）
```
2026-10-26T14:22:44.652Z [worker:stdout] [command-sync] POLL_OK path=/internal/v1/commands status=200 at=2026-10-26T14:22:44.651Z
2026-10-26T14:23:09.431Z [worker:stdout] [cloud-sync] OK device=esp32-sos ts=1793024589316 deviceTs=1793022476015 path=/internal/v1/device-status status=202 at=2026-10-26T14:23:09.431Z
2026-10-26T14:23:12.743Z [worker:stdout] [cloud-sync] OK device=esp32-kitchen ts=1793024592636 deviceTs=1793024592714 path=/internal/v1/device-status status=202 at=2026-10-26T14:23:12.743Z
```

## 结论（只读）
- broker 1883 PID 41084 运行中；bridge 9101 PID 42784 运行中（命令行无 relay/fport 参数）；9001 仅 LISTENING 无持久连接。
- **public-sync supervisor/worker 已停止**：状态文件 supervisorPid=29940、workerPid=26264 均已不存在，lock 为 stale；无任何 node 进程的命令行含 public-sync-supervisor.js/public-sync-worker.js。
- 现场无重复 supervisor/worker 实例 → 可以安全恢复，不需要结束任何进程。
- 两节点在线：bath 10.127.130.71、kitchen 10.127.130.168（MQTT 均 state=NORMAL）。
- 待处理事件：esp32-bath 的既有 SOS alarmId=e-1793022316-1（21:45:16 产生，最后成功上云 22:13:45 state=ALARM；设备在 22:21 被复位后已无该告警锁存）。
