# public-sync supervisor 候选设计（未部署）

## 目标模型

```text
visible terminal
→ public-sync-supervisor.js
→ exactly one public-sync-worker.js
→ public-sync.main({ ingestKey })
→ gateway
```

## 安全设计

- INGEST_KEY 只在 supervisor 启动时由真实 TTY 隐藏输入一次；
- key 只存在 supervisor 进程内存；
- 通过 Node IPC `child.send({type:'ingest-key'})` 传给唯一 worker；
- 不进入 argv、environment、文件、日志、lock 或 runtime state；
- worker 继承的 env 会删除 `INGEST_KEY`/`BACKEND_INGEST_KEY`；
- supervisor 关闭后 key 丢失；
- 不实现 DPAPI/Windows Credential Manager；断电重启后必须再次双击并输入 key。

## 生命周期

- `WAITING_FOR_KEY`：已取得 lock，等待隐藏输入；
- `STARTING`：正在启动 worker；
- `HEALTHY`：worker 已返回 `main()` 并通过 IPC 报告 ready；
- `RESTARTING`：异常退出后退避重启；
- `CIRCUIT_OPEN`：5 分钟内异常退出达到阈值，停止重启并在可见终端报错；
- `STOPPED`：正常退出；
- `NOT_RUNNING`：未启动。

退避：1s、2s、5s、10s，最大 30s；默认 3 次异常 / 5 分钟熔断。  
正常 worker exit 不重启；supervisor SIGINT/SIGTERM 会停止 worker 并清 lock。  
supervisor 被强杀会留下 stale lock；下次启动只在旧 PID 不存在时接管。

## Runtime state

原子写：

```text
supervisorPid, workerPid, state, startedAt, restartCount,
lastWorkerExit, lastHealthyAt, nextRestartMs
```

不含 key。lock 只含 supervisor PID。

## 一键候选

```text
<WORKSPACE>\competition\evidence\2026-10-24-public-sync-supervisor-candidate\
start-demo-supervisor-candidate.cmd
```

候选启动器会检查/启动 Broker、Bridge，检查 DAYU homemon/fport，若已有健康 supervisor 则复用；随后在可见终端运行 supervisor，等待一次隐藏输入。

未执行、未部署。若由自动化工具启动，进程可能仍随其 Windows Job 结束；最终演示必须由用户从 Explorer 双击，或另行做 OS 托管。

## 测试

```text
node --test --test-force-exit test/supervisor.test.js
8/8 PASS
```

覆盖：stale lock 接管、活 lock 拒绝、原子 state、IPC key 不泄漏到 env/argv/state/lock/log、正常退出、异常重启、退避、熔断、信号退出、第二实例拒绝。

现有 onenet 全量测试：

```text
npm test
153/153 PASS
```

## 2026-10-24 离线加固（仍为候选，未真实部署）

本轮只修改 supervisor 候选本身，未连接设备、未启动真实链路、未安装 APP。

1. **持久事件日志**：新增 `--log-file`（默认 `runtime/public-sync-supervisor.log`，一键入口显式传入）。
   supervisor 状态转换、worker 真实 PID、worker stdout/stderr 全部落盘，日志不含 key；
   这样进程树再次消失时至少有“消失前最后一条记录”，不再是无记录退出。
2. **runtime state 心跳**：`heartbeatAt` 默认每 30 秒刷新，配合 lock/state 可判断 supervisor 是“活着”还是“已死但留下 stale lock”。
3. **fork/spawn 失败处理**：`child.on('error')` 与 `exit` 统一 settle，避免只收到 `error` 时永远挂在 STARTING、worker 永不拉起。
4. **worker 优雅退出**：收到 `shutdown`/SIGTERM/SIGINT 先 `gateway.stop()` 再 exit，3 秒兜底；父进程 IPC 断开时 worker 自行退出，避免孤儿 worker 重复上传。
5. **一键入口调整**：先只读预检（文件/端口/lock/DAYU/homemon 哈希/fport），全部通过后才启动 Broker/Bridge/supervisor；
   新增 `-Preflight` 只读模式；Broker/Bridge 输出重定向到 `runtime/*.log`；拒绝第二个 supervisor；
   DAYU homemon 必须哈希匹配冻结原版才允许复用/启动。

## 未验证/限制

- supervisor 自身或整个 Windows Job 被强杀后不能自动恢复；
- 电脑重启后需要再次双击并输入 key；
- 一键候选未真实执行（本轮现场 DAYU HDC = Disconnected、5555 未监听）；
- 真实 public-sync worker 未在本轮启动；
- 部署后还需真实 kill worker、自然 202/API、进程树存活测试；
- 仍无“worker 存活但 MQTT 消费停止”的业务级看门狗；HEALTHY 只代表 worker 已返回 main()。

完整边界见 `AUDIT.md`。

## 本地验证（2026-10-24 加固后）

```text
node --test --test-force-exit test/supervisor.test.js   -> 10/10 PASS
node test/lifecycle-probe.js                            -> 6 项进程级探针 PASS
```

进程级探针使用真实 supervisor + 真实 worker + 本地 stub public-sync 入口：
不联网、不连 Broker、不连 backend、不操作任何设备、不使用生产 key。
