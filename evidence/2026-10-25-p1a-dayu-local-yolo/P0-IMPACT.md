# P0 影响检查

检查时间：2026-10-25 01:05 CST（P1-A 测试结束后，只读核对）。

## 1. 结论

**当前正式 P0 保持可用，未被 P1-A 修改或重启。**

- supervisor/worker：PID **11872 / 50580**，state `HEALTHY`，lock=11872，heartbeat 01:04:51。
- Broker 1883：PID 43624；Bridge 9101：PID 47704；hdc 9001：PID 43868；模拟器 5555：PID 52588。
- fport：`tcp:9001 → tcp:9000` 仍在。
- DAYU homemon：PID 2449，未重启。
- 手机 APP：`com.example.program_04` PID 26710，未重启。
- PC 9200：**NO-LISTEN**（本任务没有启用 PC 视觉服务；相机帧只进设备本机 9200）。
- DAYU 候选进程：已停止；测试时打开的正式 APP `com.dsh.eldercare` 已 `aa force-stop`，DAYU 侧恢复到“APP 未运行、相机空闲”。

## 2. 三设备 202（公开链路）持续增长

| 时点 | 厨房 `esp32-kitchen` | 卫生间 `esp32-bath` | 客厅 `dayu200-living` |
|---|---:|---:|---:|
| P1-A 开始前（2026-10-25 00:03 只读快照） | 154 | 133 | 171 |
| 阶段 C 监控开始 00:42:24 | 225 | 195 | 246 |
| 阶段 C 监控结束 00:53:31 | 245 | 215 | 268 |
| 测试后最终检查 01:05 | 267 | 236 | 291 |

增长未中断；日志最后条目 01:05:09（kitchen）仍为 `status=202`。P1-A 未写入 MQTT、未调用 API、未改后端。

## 3. 测试动作对现场的影响（如实记录）

| 动作 | 影响 | 恢复 |
|---|---|---|
| 用户在 DAYU 打开正式 APP 相机页（阶段 B/C 取帧） | 相机预览/CPU/温度占用约 19 分钟；homemon 一直运行 | 测试后 `aa force-stop com.dsh.eldercare`；相机服务空闲、`/dev/video0/1` 仍在 |
| 板端候选服务监听 `127.0.0.1:9200` | 仅设备 loopback；PC 9200 未监听；不占 P0 端口 | 已 SIGTERM 停止；无监听残留 |
| 候选推理占 CPU（约 1 核，97%） | 测试期间 DAYU CPU 负载上升、温度到 60.6 °C | 候选停止后恢复；未观察到降频 |
| 读取 P0/设备状态 | 只读 | — |

## 4. 明确未做

- 未启动/停止/重启 Broker、Bridge、public-sync supervisor/worker、homemon、手机 APP、模拟器。
- 未安装/卸载/修改 HAP，未改手机 APP/后端。
- 未做 COM/烧录、未改系统/驱动/相机服务/镜像。
- 未发送生产 MQTT/HTTP ingest、未触发 SOS/ACK、未读写密钥。
- 未覆盖 P0 ZIP/冻结产物。

## 5. 备注

- supervisor state 中 `restartCount=1`、`lastWorkerExit` 为 2026-10-24 22:35:49，属于 P1-A 之前的 P0-A 受控验证记录，不是本任务触发。
- 本任务结束时，P0 一键入口、手机 APP、DAYU homemon、fport 均按原样可用。
