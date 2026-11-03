# STABILITY-AND-P0-IMPACT

## 1. 并行运行统计（正式预览 + 本机推理 + P0 服务）

- 推理服务运行 823.8s（>10 分钟），同时正式应用相机预览保持前台。
- 帧/推理：received 1798、inferred 1288、dropped 510、errors 0。
- 延迟：p50 591ms、p95 672ms、min 556ms、max 1281ms。
- FPS：capture 2.18、infer 1.56。
- 资源：RSS 63,096 KB；温度 50.0 ℃；累计 CPU 782s；无错误/超时。
- P0：supervisor pid 11632 `HEALTHY`，worker pid 9908，restartCount 0；Broker 1883、Bridge 9101 仍运行；fport `tcp:9001→tcp:9000` 存在。
- 未观察到正式预览失效、推理崩溃、端口抢占或错误堆积。

## 2. P0/三节点现场变化

本轮开始前现场发生了 **DAYU 重启/HDC USB Offline**：

- 重启 uptime 约 162s；HDC 服务重启后 DAYU 才恢复 Connected；
- `fport` 丢失后已用既有映射恢复；
- 冻结 homemon 已重新启动（当前 PID 3182，9000 LISTEN）；
- 但 Bridge 9101 目前已无厨房/卫生间的无线对等连接，页面当前 **1/1，仅 `dayu200-living`**；
- 因此三节点基线在本轮期间**降级**，不能写成“三节点保持正常”。

这是现场/无线节点重连问题，不是本轮推理候选造成；本任务没有修改 Wi-Fi/AP、设备绑定、homemon/Bridge 或 backend；不手工重启/烧录 ESP32。用户需确认厨房/卫生间节点供电与 Wi-Fi 连接，待其自然重连后再核对三节点。

## 3. 显示调节隔离

- 原始正式参数：`widthPct=60, scalePct=130`；已记录。
- 运行期间一次宽度调节被触发（preference 从 60 变为 90），推理服务事件仍继续（425→448 之后持续增长）；随后已恢复 60/130。
- **未完成高度调节**：DAYU 重启后正式相机卡的调节控件在当前布局/UI 树中不可见（虽然 HAP 包含 `画面宽度/比例/重置` 字符串），无法可靠点击。
- 因而：
  - 已观察：宽度显示状态变化期间推理未停止、无相机异常；
  - 未验证：高度调节、调节后新保存的正式 JPEG（尺寸/方向）；
  - 未把“显示调节隔离”写成完全通过。
- 已恢复 `preferences` 为 60/130；正式页预览可用。

## 4. 结束状态

| 项目 | 状态 |
|---|---|
| P1-B `dayu_local_fall` | **STOPPED**（SIGTERM，已写 summary） |
| DAYU 9200 | **NO-LISTEN**（仅 TIME_WAIT 残留） |
| 正式应用 | 运行，PID 10285，版本 1.0.2/1000002 |
| 正式 HAP SHA-256 | `A696698A…324DAFFE`（未变） |
| 正式 preview 参数 | 60% / 130% |
| previewtest | 已 force-stop，无进程 |
| homemon | 运行 PID 3182，9000 LISTEN |
| fport | `tcp:9001→tcp:9000` |
| Broker/Bridge/supervisor/worker | 保持运行；supervisor HEALTHY |
| 三节点 | **1/1（仅客厅）**，厨房/卫生间未重连 |

## 5. 未发生

- 未改正式 HAP、签名、系统、homemon/Bridge/Broker、backend、Wi-Fi/AP/绑定；
- 未手工 MQTT/HTTP ingest；
- 未触发 SOS/FALL/ACK/reset；
- 未写生产告警/状态；P1-B 本地事件只保留在候选目录。
