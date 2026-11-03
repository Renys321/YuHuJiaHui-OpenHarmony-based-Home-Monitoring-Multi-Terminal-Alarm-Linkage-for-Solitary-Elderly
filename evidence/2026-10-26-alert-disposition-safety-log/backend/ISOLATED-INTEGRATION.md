# 隔离集成说明（backend：告警处置结果 / 安全日志）

日期：2026-10-26
任务：ALERT-DISPOSITION-SAFETY-LOG / backend
脚本：`competition/cloud/backend/test/safety-log-isolated.integration.js`

## 怎么跑（可重复）

```powershell
cd <WORKSPACE>\competition\cloud\backend
node test/safety-log-isolated.integration.js
```

该脚本也会被 `npm test` 自动发现并执行（它位于 `test/` 下，命名满足 Node 测试发现规则）。
在禁止子进程管道 spawn 的沙箱里，请用：

```powershell
$env:NODE_OPTIONS='--test-isolation=none'; npm test
```

## 隔离措施（不碰生产）

| 项 | 做法 |
| --- | --- |
| 数据文件 | `os.tmpdir()` 下新建临时目录里的 `state.json`；测试结束递归删除；不读写 `competition/cloud/backend/data/` |
| 监听地址 | `127.0.0.1` + 随机端口（`server.listen(0, '127.0.0.1')`） |
| 测试告警 | 仅测试进程内的 fixture（`isolated-fixture-node` / `isolated-alarm-1`），通过内部 ingest 路由写入临时文件 |
| 测试会话 | 进程内 `crypto.randomBytes` 生成 tokenSecret / ingestKey / APP 口令 + `parseAppGuardianConfig`，真实走 `POST /api/v1/auth/app` 登录 |
| 网络 | 不连接公网、不发布 MQTT/HTTP ingest、不访问 OneNET/微信 |
| 设备 | 不操作设备、串口、HAP，不触发真实 SOS/FALL |
| 密钥输出 | 输出只含计数与布尔结论；断言快照文件不包含 tokenSecret/ingestKey/口令/openid/access_token |

## 输出摘要（本次实际运行）

```text
[isolated] endpoints=3 dispositions=2 safetyLogs=2 ackCommands=1 schema=6 restart=ok
ℹ tests 1
ℹ pass 1
ℹ fail 0
exit code 0
```

## 重启前后对照（同一数据文件）

| 观察项 | 重启前（第一次启动） | 重启后（同一 `state.json`） |
| --- | --- | --- |
| `GET /api/v1/safety-logs` | `logs=[]`（初始）→ 登记后 2 条 | **2 条仍在**（来自持久化台账，非由 alerts 推导） |
| `GET /api/v1/alerts/{alarmId}/dispositions` | 2 条（`dsp-1` CONTACTED_FAMILY、`dsp-2` ON_SITE_CONFIRMED_NORMAL） | **2 条**，排序 `dsp-2, dsp-1` |
| 内部命令队列 `GET /internal/v1/commands` | 处置前 0 条；处置后仍 0 条；既有 `POST /ack` 后 1 条 PENDING | **仍只有 1 条 PENDING ACK**（处置没有生成任何命令） |
| 告警状态 | `ALARM`（既有 ACK 后 `ackPending=true`） | **仍 `ALARM` / `ackPending=true`**（处置不清 ackPending、不改 ACKED） |
| 快照 | 首次处置后写 `schemaVersion=6`，`safetyLogs=2` | 解析同一文件：`schemaVersion=6`，`safetyLogs=2` |
| 密钥 | — | 快照中无 tokenSecret / ingestKey / 口令 / openid / access_token |

## 断言要点（脚本内全部通过）

1. fixture 告警经 `/internal/v1/device-status`（随机 `x-ingest-key`）写入，首次 `GET /api/v1/safety-logs` 为空。
2. `POST /api/v1/alerts/isolated-alarm-1/dispositions` 首次 `201`，`dispositionId=dsp-1`，
   `outcomeLabel=已联系家属`、`operatorRole=household-guardian`、`serverTime>0`。
3. 同 payload 重放 `200` 且 `duplicate=true`，台账仍 1 条。
4. 处置前后内部命令数始终为 0（**处置绝不生成 ACK 命令**）；告警仍 `ALARM`/`ackPending=false`。
5. 既有 `POST /api/v1/alerts/{alarmId}/ack` 仍返回 `202` + `PENDING`（回归不破坏），
   此后内部命令 1 条；ACK 挂起期间再登记第二条处置仍 `201`，命令数保持 1。
6. 关闭服务、用同一 `state.json` 重启、重新登录：`GET /api/v1/safety-logs` 返回 2 条，
   `GET .../dispositions` 返回 2 条，命令仍 1 条 PENDING，告警仍 `ALARM`/`ackPending=true`。
7. 快照不含任何测试密钥或身份字段。

## 未覆盖 / 边界

- 本脚本只验证后端本地隔离链路；**未部署公网、未连真实 APP、未做真机验收**。
- 真实微信登录、真实订阅消息、真实设备 ACK 回执均不在本脚本范围（沿用既有链路与既有测试）。
- 服务进程模型仍为单进程（既有约束），不验证多进程并发写同一数据文件。
