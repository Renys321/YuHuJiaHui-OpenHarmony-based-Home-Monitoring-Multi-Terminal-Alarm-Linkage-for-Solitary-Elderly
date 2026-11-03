# EVIDENCE-INDEX — 跨房间诊断证据索引（2026-10-26）

配套报告：[CROSS-ROOM-DIAGNOSIS.md](./CROSS-ROOM-DIAGNOSIS.md)
诊断时段：2026-10-26 20:56–21:08（Asia/Shanghai）。**只读**：未改源码、未烧录、未开串口、未发 MQTT/HTTP、未 ACK/reset、未重启任何服务。
本文只索引**本次实际读取过**的文件；未读过的历史报告不作为本报告结论依据。

---

## 1. 源码（行号基准）

| 文件 | 大小 / SHA-256 | mtime | 用途 |
|---|---|---|---|
| `competition/evidence/2026-10-26-local-alarm-led-closure/source-after/node_main.c` | 69,807 B / `6d5cc5a149244cccbbc41f83a5e9cc479adb03f957b49bf55421ab62615ff4d0` | 10-26 20:30:38 | **部署固件（20:42/20:43 烧录的 LED 正式固件）源码基准**；§2 全部行号引用此文件 |
| `competition/evidence/2026-10-26-kitchen-sos-led-speech-final/source-before/public/node_main.c` | 69,807 B / 同上（逐字节相同） | 10-26 20:30:38 | 当前最终任务的基线副本，交叉核对用 |
| `competition/esp32-node/main/node_main.c` | **并发修改中**：21:04:18 时 74,973 B / `2d0d65e2293a2579e89242e86a9145c0a5268f16f4cd6c8180a303e4ebe1eecf` | 10-26 21:04:18 | 仅用于核对“函数结构/行号与部署快照一致”，**不作为行号引用基准**（其他会话仍在写） |
| `competition/esp32-node/main/local_voice.c` | 8,458 B（led-closure/source-before 副本同时读到） | — | 播放路径：`:135` `local_voice_alarm`（clip 1=SOS/2=告警）、`:136` cancel、`:167` `no boot alarm`、`:168–170` 仅 `VOICE_BOOT_TEST` 播试听 |
| `competition/evidence/2026-10-26-kitchen-key0-sos/source-after/node_main.c` | 68,415 B / `c0e48bc4…` | 10-26 18:51:37 | 核对 KEY0 版命令/状态机（供 19:09–19:54 厨房 KEY0 固件定位） |
| `competition/esp32-node/.local/key0-20261026/prod/sdkconfig` | — | 10-26 19:15 左右 | 厨房 `esp32-kitchen`、`SOS_GPIO=-1`、`KEY0=y`、`BENCH_INJECT` 未启用 |
| `competition/esp32-node/.local/led-20261026/kitchen-prod/sdkconfig`、`bath-prod/sdkconfig` | 63,683 / 63,653 B | 10-26 20:0x | 最终正式配置：`BENCH_INJECT` 无、`BOOT_BEEP_MS=0`、`VOICE_BOOT_TEST` 无、`GW=10.127.130.179:9101`、`REPEAT=300`、`BEEP=10`；厨房 `KEY0=y/MOTION=-1`，卫生间 `SOS=15/MOTION=36` |
| `competition/bridge/mqtt_bridge.js` | 27,739 B / `c2d2ce1f2e96c7b3436482060ac769882cac243289f0a44aac7a2990eb651eba` | 10-26 15:17:21 | 下行白名单 `:451–506`、主题 `home/+/cmd` `:167,452`、定向 `routeCommand` `:437–445`、离线丢弃 `:494–506`、relay 只注状态 `:342–419`、单属主 `:281–317` |
| `competition/bridge/mqtt_broker.js` | 5,999 B / `0c9b2c1e19fac585de9dab3175240811b24455549ee7b310cc6a5f3af0d06624` | 10-26 15:17:06 | 无 retain；PUBLISH 只按订阅过滤器转发 `:27–36,79–127` |
| `competition/southbound/src/homemon.c` | 48,545 B / `54ba5531c47b3a865dd9ef04aadfc740216e3af5c068a5523a83507fc714b172` | 10-25 22:48:49 | `route` 目标路由 `:460–491`、`relay` 只收 JSON `:492–502`、本机 ack 精确 ID `:503–545` |
| `competition/cloud/onenet/command-sync.js` | 33,316 B / `7ad5b029…` | 10-26 19:54:41 | ACK 严格校验与定向发布：`:18–33,103–137,348–385`；无效命令只记账 `:680–702` |
| `competition/cloud/onenet/gateway.js` | 46,156 B / `64790e7c…` | 10-25 22:55:55 | ACK 本层 deferred `:653–662`；RESET 单目标 `:669–733`；`_publishLocal` 定向 `:741–755` |
| `competition/cloud/backend/src/store.js` | 17,503 B | — | `requestAck`: `command.deviceId = alert.deviceId`（`:374–395`）；回执绑定校验 `:429–455` |
| `competition/cloud/backend/src/persistent-store.js` | 59,323 B | — | 同上（持久层）`:986–1011` |

## 2. 日志 / 串口证据

| 文件 | 大小 / 覆盖窗口 | 用途与关键行 |
|---|---|---|
| `competition/bridge/_test/current-runtime/supervisor/bridge.out.log` | 818,813 B，**最后写入 10-26 19:54:09**；起始时间无戳（最早告警 ack `:593` = `e-1793002128-1` → 16:08:48） | P0 生产桥接（`--status-tcp 127.0.0.1:9001` + `--listen 9101` + relay→9001）。**无行内时间戳**，时间靠告警 ID epoch + 5 s 上报节奏反推。引用行：`:8041/8079/8487`（卫生间 SOS 18:43:42/18:43:53/18:49:21）、`:9850/9876`（厨房 SOS 19:10:32/19:11:12）、`:11605→11606`（厨房 ACKED→ALARM）、`:11613/11620/11627`（其间卫生间仍 NORMAL）、`:11630`（卫生间 ALARM；ID `e-1793015347-1`=19:49:07）、`:12044`（卫生间 ACK 引用该 ID）、`:11371–11395`（`esp32-sos-isolated-test` 注入）、`:11898`（`esp32-sos-isolated-test2` ALARM）、`:11906`（非法 ack 载荷被忽略） |
| `D:\esp32-sos-build\.local\bridge2.log` | 127,930 B，10-26 19:54:11 起，至 21:07:45 仍在写 | **当前占用 9101 的桥接**：横幅只有 `broker 127.0.0.1:1883` + `监听端口 9101`，**无 9001 端点、无 relay 目标**（与 `bridge.out.log` 不同）。引用行：`:12–30`（19:54 两板接入）、`:15–509` 厨房 ALARM×107、`:183–526` 卫生间 ALARM、`:519/529` 厨房断线→`.168` 重连报 NORMAL、`:539/548` 卫生间断线→`.71` 重连报 NORMAL、`:550–2087` 两板 NORMAL |
| `competition/bridge/_test/current-runtime/supervisor/public-sync-supervisor.log` | 421,150 B，UTC 时间戳；10-25 14:27Z 起，最后 10-26 12:57Z（=20:57 +08） | 两板 `cloud-sync OK … status=202` 时间线：19:50–20:08 每 ~32 s、20:08:11→20:42:01 空档（台架窗口）、20:42–20:49:40 恢复、**20:49:39/40 后两板再无状态**；`:131/133`（2026-10-25 唯一一条 command-sync ACK_SENT，说明此后未见 APP 触发的 ACK 下发） |
| `competition/evidence/2026-10-26-local-alarm-led-closure/verify/led-states-kitchen*.log`、`led-states-bath*.log`、`led-identify-*-long.log` | 20,600–142,723 B，20:25:27–20:41:28 | **双板并行台架证据**：每行 `[+elapsed] [wall-clock]`；头部 `com=COM5`/`com=COM4`、`start` 相差 0.02–0.43 s、`plan` 剧本逐行相同；均含 `BENCH INJECT MODE`、均无 `已连接网关`。21 对跨板 `PLAY` 差值 ≤1.14 s（明细见报告 §4.1） |
| `competition/evidence/2026-10-26-local-alarm-led-closure/verify/prod-kitchen-boot.log`、`prod-bath-boot.log` | 10,650 / 10,534 B，20:42:43 / 20:43:10 | 正式固件启动：`no boot alarm`、`PLAY clip=0`、`state=NORMAL`（单板逐个抓取，与另一板不重叠） |
| `competition/evidence/2026-10-26-local-alarm-led-closure/build/device-identity-COM5-kitchen.json`、`…-COM4-bath.json` | 875 B ×2，20:04:38 / 20:05:06 | 与 `bridge2.log:519/529/539/548` 的重启重连对应：LED 任务 esptool 身份读取导致两板重启，从而清除 ALARM（非 ACK） |
| `competition/evidence/2026-10-26-kitchen-key0-sos/verify/prod2-COM5-quiet.log` | 10,409 B，19:09:25–19:09:48 | 厨房 19:09 起的固件：`SOS 按键就绪：板载 KEY0 = XL9555 P1_7`、`温湿度自检 OK: 24.2C/64.2%`、`state=NORMAL`；证明 19:10/19:49 厨房具备 KEY0 本地触发能力 |
| `competition/evidence/2026-10-26-local-alarm-voice-closure/verify/*.log` | 18:19–18:41 | 单板顺序台架（kitchen 18:19–18:25、bath 18:26–18:33、prod 18:34–18:41），**时段互不重叠**；`bath-02-sos.log` 等支持“SOS→ACK”语义；未出现跨板同时播放 |
| `competition/evidence/2026-10-26-wireless-sos-button/REPORT.md` | 10,010 B | 说明 `10.127.130.91` 是另一会话的第三块随身 SOS 板（MAC `30:30:f9:08:76:84`），非厨房/卫生间；解释 `bridge2.log` 里的 `.91` 接入 |

## 3. 当前现场只读快照（2026-10-26 21:07:45）

| 项 | 观测 |
|---|---|
| 端口 | `0.0.0.0:1883` LISTENING pid 41084；`0.0.0.0:9101` LISTENING pid 42784；`127.0.0.1:9001` LISTENING pid 37352 |
| 9101 连接 | **无任何 ESTABLISHED**（仅本机脚本的 TIME_WAIT）：两板当前不在链路 |
| 9101 归属 | 证据链指向 `D:\esp32-sos-build` 的测试桥接（横幅无 relay/无 9001 端点，19:54:11 建、仍在写）；进程命令行读取被系统拒绝（Access denied），故标为“证据链一致、未读到命令行” |
| public-sync | supervisor pid 28920 / worker pid 29888，state.json `HEALTHY`；日志 21:07 仍在写 |
| 两板最后状态 | `public-sync-supervisor.log` 20:49:39/40 厨房/卫生间各最后一条 202；`status.json`（19:54:09）为 `esp32-bath ACKED`，`alarm.id=e-1793015347-1`（**历史快照，非现状**） |
| 并发活动 | 21:04:18 `esp32-node/main/node_main.c` 仍被修改；`bridge2.log`/`broker.out.log`/`public-sync-supervisor.log` 持续增长；`competition/evidence/2026-10-26-wireless-sos-button-final/build/build-sos-live.log` 20:58:18 创建（其他会话在构建） |

## 4. 取证方法与环境

- Python 3（`D:\Users\LENOVO\.dsh\dsh-runtimes\…\python.exe`）只读脚本解析日志；PowerShell 只读查询（`netstat -ano`、`Get-Item`）。
- 时间基准：日志墙钟 `+08:00`（Asia/Shanghai）；`public-sync-supervisor.log` 为 UTC，已换算；告警 ID `e-<epoch>-<seq>` 的 epoch 由 `alarm_id_build(time(NULL), …)` 生成（`node_main.c:1147–1154`），可换算成按键/触发时刻。
- **未做**：串口打开/写入、MQTT publish、HTTP 请求、ACK/reset、烧录、服务重启、文件修改（本目录两份 md 除外）。

## 5. 已知取证缺口（建议最终验收补齐）

1. `bridge.out.log` / `bridge2.log` **无行内时间戳** → 验收时应以带时间戳方式重定向 bridge 输出（或用 supervisor 包装），否则无法做毫秒级跨板比对。
2. 19:49 窗口厨房 ALARM 的 `alarm.type` 未留证 → 桥接日志应记录 `alarm.type`，或验收时保留两板串口全量日志。
3. `status.json` 单文件会被覆盖 → 验收时应按设备/时间落盘（如 `home/<deviceId>/status` 订阅落盘），避免再次出现“只能看到最后一条”。
4. 当前 9101 是测试桥接（无 relay/无 9001），APP/DAYU 的 `route` ACK 通道在现进程下不可达；真实验收前需由有权会话恢复生产 bridge/supervisor（本任务未重启）。
