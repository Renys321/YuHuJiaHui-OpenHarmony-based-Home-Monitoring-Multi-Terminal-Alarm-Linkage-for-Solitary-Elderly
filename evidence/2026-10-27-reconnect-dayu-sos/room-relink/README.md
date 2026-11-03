# 2026-10-27 房间链路断连恢复 —— 证据目录

任务：定位并修复"房间 ESP32 断开再启动后 APP 与 DAYU200 无法自动恢复"的代码级根因（task-1）。
结论与完整说明见 `competition/docs/evidence/2026-10-27-room-relink-recovery.md`。

## 采集环境

- 时间窗：2026-10-27 22:17–22:47（Asia/Shanghai）
- 现场：PC WLAN = 10.127.130.179（ElderCareLab）；ESP32 `10.127.130.71`（bath）、`10.127.130.168`（kitchen）；
  板端 homemon 直连 `10.127.130.131:9000`（Bridge PID 61072，22:25:23 启动，旧代码）；
  public-sync supervisor/worker PID 39628/53752（22:29:56 人工重跑，旧代码）。
- 本轮**没有**重启 broker/bridge/homemon/public-sync，**没有**刷写 ESP32，**没有**打开 COM 口，
  **没有**发布伪造 MQTT/HTTP 消息，**没有** ACK 任何告警，**没有**读取/输出任何密钥。

## 真实（REAL）只读取证

| 文件 | 内容 |
|---|---|
| `logs/10-live-chain-snapshot.log` | 22:41 现场快照：node 进程与命令行、netstat 1883/9101/9000、watcher-state、DAYU UI 文案（全屋在线 3/3）、只读健康检查、supervisor 日志中的 `WORKER_EXIT code=3221225786`（16:25:04.738）与 22:26/22:29 的 `STALE_LOCK_TAKEOVER dead_pid=29048` |
| `logs/11-live-mqtt-snapshot.log` | 22:42 只读 MQTT 订阅 `home/+/status` 12s：esp32-kitchen / esp32-bath / dayu200-living 均有新 ts 的完整状态 JSON |
| `logs/12-live-homemon-broadcast.log` | 22:42 只读 relay 探针（`bridge/link_probe.js 10.127.130.131:9000`）：homemon 广播流看到 3 个设备 |
| `logs/13-public-sync-health-stale-synthetic.log` | **合成**陈旧形态（PID 29048/30608、7 小时前心跳）验证只读健康检查返回 `STALE_LOCK` + 退出码 3；不修改任何真实文件 |
| `logs/04-public-sync-health-live.log` | 22:46 现场只读健康检查：healthy=true（supervisor 39628 / worker 53752 存活、心跳 3.5s） |

## 测试（MOCK 回归 + 语法/编码检查）

| 文件 | 内容 |
|---|---|
| `logs/01-bridge-node-test.log` | `bridge` 全目录 `node --test`：**30/30 pass** |
| `logs/02-onenet-node-test.log` | `cloud/onenet` 全目录 `node --test`：**194/194 pass**（含新增 supervisor 6 项、command-sync 作用域 5 项） |
| `logs/03-bridge-recovery-tests.log` | 新增 `bridge_auto_recovery.test.js`：**6/6 pass**（含"不配置 `--relay-ignore` 时旧缺陷复现"） |
| `logs/06-verify-p0-health.log` | `materials/verify-p0-health.ps1`：**6/6 PASS**（AST 抽取 demo-autostart 判定函数，不复制实现） |
| `logs/14-ps1-parse-check.log` | 4 个 PowerShell 脚本 UTF-8 BOM + AST 解析通过 |
| `logs/15-node-check.log` | 8 个 JS 文件 `node --check` 通过 |
| `logs/16-file-hashes.log` | 本轮修改/新增文件 SHA-256 与 `.bak-20261027` 备份清单 |

## MOCK 边界（重要）

`bridge_auto_recovery.test.js`、`public-sync-supervisor.test.js`、`command-sync-scope.test.js` 里的
ESP32 节点、homemon relay、broker 端口、public-sync worker **全部是 mock**：
**只证明传输层协议与恢复逻辑，不能作为真实 ESP32/DAYU/公网链路验收证据。**
真实断连验收（拔电、杀进程、重启用户服务）未在本轮执行，需由 Lead 统一进行，
并另建新的证据目录记录原始日志与 UI/Hilog 证据。

## 目录内非本轮内容

`tmp/` 为本次测试的临时输出（可删除）。
