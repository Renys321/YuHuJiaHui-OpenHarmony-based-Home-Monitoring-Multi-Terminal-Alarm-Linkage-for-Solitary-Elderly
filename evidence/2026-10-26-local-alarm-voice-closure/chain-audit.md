# 链路审计：ACK / stop / pause（只读，2026-10-26 16:15–16:30 +08:00）

审计人：chain-audit（Team，read-only）。未修改任何现有源码；未操作串口/设备；未发布 MQTT/HTTP；未重启服务；未做任何验收。

标签：**[observed]** 本次只读实测；**[source]** 只读源码/文档所述；**[in-flight]** 审计期间正被 Lead 改写、未构建未烧录。

基线快照：`evidence/2026-10-26-local-alarm-voice-closure/source-before/`。`node_main.c` SHA-256 `657092E6…93B0`，`local_voice.c` `472C89C2…B2FF`、`Kconfig.projbuild` `F66AE357…860A`，与 `evidence/2026-10-26-bathroom-local-voice/BUILD-MANIFEST.md:14-17` 记载的公共树哈希一致 → 快照可信，可作为“在板旧固件语义”的基线。

## 0. 先读这条：源码正在被改
- [observed] `esp32-node/main/node_main.c` 16:16→16:18 由 44,524 B 涨到 56,346 B（连续写入中，行数 1113→1359）；`alarm_logic.h`(13,226 B)、`Kconfig.projbuild`(9,981 B)、`test/host_alarm_logic_test.c` 同为 16:16–16:17 写入。
- [in-flight] 新增内容：`stop` / `pause` / `resume` 命令、`CMD 收到:` 收到日志、`NODE_ALARM_REPEAT_SEC`、`CONFIG_NODE_ALARM_BENCH_INJECT`、`profiles/alarm-closure.sdkconfig.defaults`、`profiles/alarm-bench.sdkconfig.defaults`（后者 `CONFIG_NODE_GW_PORT=9102` 隔离端口）。现场镜像仍是 `build-voice-*-v20`（10-26 01:21），**这些新增尚未构建/烧录**。
- 因此下文“设备行为”一律指 source-before 基线；[in-flight] 不得当作已实现证据。

## 1. 云端 ACK 链：APP → 后端 → command-sync → MQTT → bridge → 节点 TCP
| 段 | 证据（file:line） | 线上字符串 |
|---|---|---|
| 小程序 | `mobile/wechat-miniprogram/services/eldercare.js:60-66` | `POST /api/v1/alerts/<id>/ack {"note":…}`；仅接受 `accepted/status=PENDING/commandId`，否则要求 `state===ACKED`(:67-72) |
| 守护 APP | `APP/ElderlyCareGuardian/entry/src/main/ets/core/api/ApiClient.ts:228-236`；`service/GuardianService.ets:821-880` | 同一 path；202 只入“等待设备确认”，绝不本地置 ACKED |
| 后端 | `cloud/backend/src/server.js:778-785` → `cloud/backend/src/store.js:374-396` | 入队 `command:'ACK'`、`status:'PENDING'`、`alert.ackPending=true` |
| 边缘同步器 | `cloud/onenet/command-sync.js`（由 `cloud/onenet/gateway.js:902` 在 public-sync worker 内启动） | 只认 `command==='ACK'`(:106)；topic `home/<deviceId>/cmd`(:348-350)，QoS1(:378)；载荷 `{"cmd":"ack","alarmId":"…","action":"…"}`(:131-137) |
| bridge | `competition/bridge/mqtt_bridge.js:452-457`；`routeCommand()`:437-445 | `{"cmd":"ack"}` → **`ack <alarmId> <action>\n`**；`{"cmd":"reset"}` → **`reset\n`**(:458)；仅写该 deviceId 当前绑定的活动 TCP 连接 |
| ESP32 节点 | 基线 `source-before/node_main.c:638-674`（`gw_poll`→`handle_command`） | 同上；ESP32 通过 inbound 连 bridge `--listen 9101` |

回执侧 [source]：ESP32 置 `state=3`(ACKED)、`s_acked_armed=0`、`buzzer(0)`、`local_voice_cancel()`（基线 :620-627），**基线此处不立即 `report()`**；ACKED 走 5 s 周期上报（`Kconfig.projbuild:276-278` 默认 5；循环 `source-before/node_main.c:1106-1110`）。command-sync 等待 8 s(`command-sync.js:41`)，要求新观测到 `state=ACKED` 且 `alarm.id` 精确匹配（`store.js:439-443`），再 `POST /internal/v1/commands/<id>/result`（`server.js:437-444`）。

[observed] 唯一可见闭环样本：`bridge/_test/current-runtime/supervisor/public-sync-supervisor.log:131,133` → `ACK_SENT id=8 device=esp32-bath` @2026-10-25T14:45:13.801Z，`ACKED id=8 device=esp32-bath` @14:45:16.207Z（2.4 s）。**今日 16:01 起的运行时内 0 次下行 ACK**（bridge 日志只有 `[MQTT] 订阅成功: home/+/cmd`，无 `[MQTT] ← …/cmd`）。

## 2. DAYU 本地 ACK 链（不经云）
- [source] `northbound/entry/src/main/ets/pages/Index.ets:916-979` `doAck()`：校验 `DEVICE_ID_RE`、目标在线、按 `routes` 选连接后 `sk.send({data: `route <deviceId> ack <alarmId> <action>\n`})`（:956）；`<action>` 先压掉 CR/LF 防拼行（:925-927）；未收到 ACKED 前只显示“等待设备确认”。
- homemon：`southbound/src/homemon.c:463-491` —— `route <dev> <cmd>` 目标为本机则本地执行(:485-487)，否则整行 `tcp_broadcast`(:489-490)；禁止嵌套 route/relay(:481-484)，但**不校验 `<cmd>` 白名单**。
- bridge：`mqtt_bridge.js:346-373` 用 `--relay-to` 连 homemon，`handleRouteLine()`(:376-393) 解析后 `routeCommand(target, cmd+'\n')`；节点连接上的 route 行被忽略(:543)。
- 注：`northbound/.../model/DeviceModel.ets:196-214` 的 `DeviceModel.ack()`（发 `ack <id> <action>\n`）全仓无调用点，**不是现行路径**。

## 3. stop / silence / pause / resume 清单
| 层 | 有无独立“停声/暂停”命令 | 证据 |
|---|---|---|
| bridge | **无** | MQTT 下行白名单仅 ack/reset/motion/sos/gas/smoke/fall/monitor(`mqtt_bridge.js:456-489`)；`{"cmd":"stop"}` 解析后 `cmd` 为 null → **静默丢弃**(:493)，不报错不记日志 |
| command-sync | **无**（只 ACK） | `command-sync.js:106` |
| homemon | **无** stop/pause | 只有 ack/reset/sos/motion/smoke/gas/climate/fall/monitor(`homemon.c:463-645`)；`monitor` 只写 monitorOnline(:599-636) |
| DAYU APP | **无** | 只有 ACK 按钮(`Index.ets:1414`→doAck) |
| 守护 APP / 小程序 | **无** | 只有 ack（§9） |
| ESP32 基线固件 | **无** | `source-before/node_main.c:602-636` 只有 ack/reset |
| ESP32 [in-flight] | `stop`（本轮静音、保留 ALARM 与 alarmId）/`pause`·`resume`（暂停·恢复“无活动”监护，写 NVS）/`reset` | 现树 `handle_command`，未构建未烧录 |

→ 截至审计时刻，**全链路没有任何“停声/暂停”下行命令**。既有能“停下来”的只有 `ack`（会变 ACKED）和 `reset`（回 NORMAL）。

## 4. `{cmd:'monitor'}` 谁发、能否到 ESP32
- [source] 发布者只有 PC 侧视觉：`vision/yolo_pose_service.py:245-252`、`vision/vision_guardian.py:294-300`；目标设备默认 `dayu200-living`（`yolo_pose_service.py:532`、`vision_guardian.py:403`），topic 恒为 `home/dayu200-living/cmd`。
- bridge 映射为 `monitor <online|offline> <reason>\n`(`mqtt_bridge.js:478-489`)，只写 dayu200-living 的连接；homemon 只更新 `monitorOnline/monitorReason`(`homemon.c:599-636`)。
- ESP32 固件对 `monitor` 无分支（基线只有 ack/reset；[in-flight] 也未加）→ 即使到达也会被忽略。**monitor 不会到达也不会影响 ESP32 节点。**

## 5. “设备收到” vs “设备已停”能否区分
- [source] 基线串口只有“已生效”一侧：`ACK 已接受并静音：id=…`(基线 :626)、`ACK 被拒绝：…`(:615/618)、`状态复位 -> NORMAL`(:634)；**没有“收到命令”日志**。语音侧仅有 `STOP result=… cancelled=…`(`local_voice.c:115`)。
- [source] 上报 JSON 只有 `state`/`alarm.id`/`alarm.type`(基线 :901-921)，**无音频/静音字段**；[in-flight] 的 `report()` 同样没有。
- → 云端侧（bridge→status→cloud-sync→backend→APP）只能看到 NORMAL/ALARM/ACKED，**无法区分“设备收到 stop”与“设备已停止播放”**。要做成可验收，需新增上报字段（例如 `voice:"stopped"`），或明确“串口日志是唯一证据、证据等级=单板日志”。[in-flight] 加的 `CMD 收到: %s`（先记收到、再记生效）方向正确，但仍在改。

## 6. 实时只读状态 [observed]（16:16–16:22）
- `bridge/_test/current-runtime/supervisor/status.json`(16:17:12)：`esp32-bath state=ACKED, alarm.id=e-1793002333-3, alarm.type=MANUAL_SOS, tempC=26.2 rh=62.4, countToday=102`。
- `.../bridge.out.log` 尾部：`dayu200-living state=ALARM`、`esp32-kitchen state=NORMAL countToday=0`、`esp32-bath state=ACKED`。
- 服务：broker 1883(PID 41084)、bridge(PID 26376：`--broker 127.0.0.1:1883 --status-tcp 127.0.0.1:9001 --listen 9101 --relay-to 127.0.0.1:9001`)、public-sync supervisor 28920/worker 29888，`state=HEALTHY restartCount=0`。PC 端 9001 监听属 `hdc.exe`（板端 homemon 经 hdc 端口转发）；本机 **8080 后端未监听**（ACK 链走公网后端）。
- command-sync 统计：`POLL_OK` 216、`COMMAND_IGNORED(COMMAND_NOT_PENDING)` 15、`POLL_FAIL` 15。08:18:24Z `SYNC_TIMEOUT` → 08:18:32–08:19:12Z **`ENOTFOUND`（公网后端 DNS 失败，cloud-sync 同时 FAIL）** → 08:19:13Z 恢复。
- `evidence/2026-10-26-demo-autostart/runtime/watcher-state.json`(16:21:34)：`p0=healthy, app=present, inference=running, cameraFrames=LIVE, nodes="1/3", userStop=false, userPaused=false` → watcher 视角仅 1/3 节点。

## 7. 并行会话边界（不得覆盖）
12:00 之后被另一会话（D/E）改过、本任务必须只读：
- 后端：`cloud/backend/src/activity.js`(12:40)、`test/{activity.test.js,activity-api.test.js,app-contract.test.js}`(12:40–12:41)、`cloud/backend/README.md`(12:23)。
- 文档：`docs/APP-API-v1.md`(12:42)、`docs/APP-API-v1.json`(12:23)。
- APP：`APP/ElderlyCareGuardian/entry/src/main/ets/core/activity/ActivityReport.ts`、`.../pages/ActivityReportPage.ets`、`APP/ElderlyCareGuardian/tests/activity-report.test.mjs`(12:22)。
- 证据目录：`evidence/2026-10-26-d-e-candidate-freeze/`、`2026-10-26-d-e-release-prep/`、`2026-10-26-d-e-rollback-hardening/`（最后写入 16:07:51，之后无新写入）。
- **由在跑服务持续写入的运行时目录（不是静态证据，勿当冻结证据、勿覆盖）**：`bridge/_test/current-runtime/supervisor/*`、`evidence/2026-10-26-demo-autostart/runtime/*`（watcher 每 ~30 s 重写 `ui-last.json`/`watcher-state.json`）。
- 同一 evidence 目录内另一 teammate 正在写 `tools/ verify/ host-tests/`（16:17–16:20 出现 `bench-server.js`、`serial-capture.py`、`*.exe` 等）。**我的写入范围只有本文件 `chain-audit.md`。**

## 8. 灯光/指示
- ESP32 [source]：**当前固件无任何 LED 控制代码**。`esp32-node/main/` 只驱动 XL9555 `P0_3` 板载蜂鸣器（`node_main.c:158-198`、`Kconfig.projbuild:107-112`）与 `P0_2` 功放使能(`local_voice.c:19,42-54`，低有效)。→ **未确认可作为可编程指示**。
- 历史文档称“LED = IO1”（`docs/evidence/2026-10-20-kitchen-esp32-node-acceptance.md:23`），但 `docs/evidence/2026-10-20-kitchen-esp32-node-audit.md:45` 记 IO1=LED1 与 MQ-2 AO 冲突，且无驱动代码。**不要宣称“声光”中的灯光闭环。**
- DAYU200 [source]：有可控三色灯，homemon 按状态写 sysfs `/sys/class/leds/{red,green,blue}`（`southbound/src/homemon.c:246-258`；NORMAL 绿/WARN 黄慢闪/ALARM 红闪/ACKED 蓝 :317-323；配置项 `southbound/homemon.conf` 的 `led_red/green/blue`）。**是否在当次板端部署生效未验证**（需上板只读核对，本次未做）。

## 9. APP 侧能力
- 小程序：仅“确认并闭环”→ POST ack（`services/eldercare.js:60-73`），按 `ackPending` 轮询(`pages/alarms/index.js:52-71`)，文案明确“202 未收到 ACKED 不算闭环”(`pages/alarms/index.wxml:28-38`)；无 reset/stop。
- 守护 APP：`ApiClient.ts:228-236` + `GuardianService.ets:821-880`；ACKED 展示只来自服务端 `state==='ACKED'`→`statusKey='acked'`(`core/view/ViewMapper.ts:583-587`)，详情页“设备已确认（服务端 ACKED）”(`pages/AlertDetailPage.ets:182-191`)；无 reset/stop。
- 两个 APP 都没有 reset/stop/暂停入口 → 若新增 stop，必须同时改 APP 按钮 + bridge 白名单 + command-sync 命令类型；否则只能用 DAYU 本地 `route <dev> stop` 通道（homemon 会透传，但基线固件不识别）。

## 10. 给 Lead 的缺口（事实，不含验收结论）
1. `stop` 三处都缺：bridge 白名单(`mqtt_bridge.js:456-489`)、command-sync(只 ACK)、APP UI。当前**唯一可透传**通道是同板 `route <dev> stop` → homemon 广播(:489-490) → bridge `handleRouteLine` → 节点；但基线固件不识别 `stop`（会被 `handle_command` 忽略）。
2. 状态上报缺“已静音/已停止”字段 → 远程无法证明“已停止播放”；新增字段时 bridge → cloud-sync → backend adapter 白名单需同步，否则可能被判非法。
3. `reset` 语义差异：ESP32 基线只置 NORMAL+静音、**不清 alarmId**（homemon 版同，`homemon.c:642-645`）；[in-flight] 版本已清 id。与后端 `store.js:141-146`（状态摄入把 `state=ACKED` 落到 `status.alarm.id` 对应告警）的交互需回归。
4. 今日运行时内 0 次真实 ACK 下发；08:18–08:19Z 公网后端 `ENOTFOUND` 抖动期间 ACK 链不可用。做 ACK/stop 验收前需先确认公网后端可达。
