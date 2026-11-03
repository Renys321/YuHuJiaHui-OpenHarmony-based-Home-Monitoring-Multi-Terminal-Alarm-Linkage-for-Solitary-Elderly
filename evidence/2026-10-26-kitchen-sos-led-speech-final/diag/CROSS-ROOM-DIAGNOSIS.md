# 跨房间“按卫生间按钮，厨房也响”只读诊断（2026-10-26）

- 任务：shared task `task-1`，只读诊断；**未修改任何源码、未烧录、未打开 COM4/COM5、未向 MQTT/HTTP 发布、未 ACK/reset、未重启 broker(1883)/bridge(9101)/fport(9001)/public-sync**。
- 诊断时间：2026-10-26 20:56–21:08（Asia/Shanghai）。工作区 `<WORKSPACE>`。
- 关键前提（如实）：**两块板当前都没有连到 9101**（21:07:45 `netstat -ano` 中 9101 仅 LISTENING，无任何 `10.127.130.x` ESTABLISHED；只有本机测试脚本的 TIME_WAIT）。因此“现在按了什么导致什么”无法用在线链路复现，本报告只做代码路由 + 历史日志判定。
- 本报告区分：**已证实**（有源码行号或日志行+时间戳）、**已排除**（附理由）、**未定位**（明确写未定位，不写成已修复）。

---

## 0. 一句话结论

1. **一个节点在代码上不可能因为另一个节点的事件而发声**：ESP32 的语音/蜂鸣只由本板状态机（本板传感器判定 / 本板实体按键）驱动；网络下行命令只有 ack/stop/pause/resume/reset 五种，**只会静音，不会拉响**。
2. **bridge/broker/homemon/command-sync/backend 均无“告警或命令广播到所有房间”的路径**；下行路由键是主题里的 `deviceId`，目标不在线即丢弃，不会兜底发错板。
3. **历史日志中确实存在“两板 ≤5 s 内同时播放”的实例，全部发生在 20:26–20:41 的隔离台架窗口**：两套 `bench-serial.py` 分别占用 COM5/COM4、按**同一剧本**同时注入 `inj climate`/`inj sos`，这是**并行台架注入**；台架固件无 WiFi，物理上不可能跨房间。
4. 生产链路窗口 19:49–20:03 两板**同时处于 ALARM 状态**（网络层可证），但**厨房的告警起始早于卫生间 SOS 约 15–20 s**，且该时段**没有任何下行命令被写入厨房**；厨房告警类型与触发源**未定位**（无串口抓取）。
5. APP/DAYU 的 ACK 若错投厨房：**只可能被拒绝或静音，不可能发声**。

---

## 1. 结论分级总表

| # | 假设 | 结论 | 一句话证据 |
|---|---|---|---|
| A | 设计上存在“A 房间告警→B 房间也响”的联动 | **已排除** | 节点发声触发点全部在本板状态机；下行命令无“拉响”类型（`node_main.c` 741–912、1147–1169、1227–1302、1355–1419、1544–1603） |
| B | bridge/broker/homemon/command-sync 广播或扇出告警/命令 | **已排除** | `mqtt_bridge.js` 452–506 按主题 `home/<deviceId>/cmd` 定向、离线即丢弃；`mqtt_broker.js` 79–127 无 retain、只转发给匹配订阅者；`homemon.c` 463–502 route 只广播“route 行”给 relay 通道；`command-sync.js` 21/106–118/348–385 明确“绝不猜测设备，绝不广播” |
| C | 历史日志中有两板 ≤5 s 同时播放 | **已证实（仅台架窗口）** | 21 对跨板 `PLAY` 事件，最大时间差 1.14 s，全部落在 20:26–20:41；两板日志均含 `BENCH INJECT MODE`、均无 `已连接网关` |
| D | 两板同时播放是并行台架注入造成 | **已证实（台架窗口）** | 两套 `bench-serial.py` 头部分别 `com=COM5`/`com=COM4`、`start` 相差 0.02–0.43 s、剧本逐行相同（如 20:35:14.851 与 20:35:14.422，同 900 s 剧本） |
| E | 生产窗口厨房“被卫生间触发” | **已排除（时间序 + 无命令）**；厨房自身告警触发类型 **未定位** | `bridge.out.log` 11605 ACKED→11606 ALARM 早于 11630（卫生间 SOS，alarm id `e-1793015347-1` 内嵌 epoch=19:49:07）约 15–20 s；19:11:12 之后**无** `命令已写入节点 esp32-kitchen` |
| F | APP/DAYU ACK 错投厨房导致发声 | **已排除** | ACK 分支只 `buzzer(0)`+`local_voice_cancel()`；ID 不匹配或无告警时拒绝（`node_main.c` 771–799、1147–1168） |
| G | 当前现场能复现该现象 | **未定位/不可测** | 21:07:45 两块板均不在 9101；bridge 日志自 20:49:40 起无两板状态 |

---

## 2. (a) 节点发声的全部触发点（枚举 + 条件）

以**实际部署固件的源码快照**为行号基准：`competition/evidence/2026-10-26-local-alarm-led-closure/source-after/node_main.c`
（69,807 B，SHA-256 `6d5cc5a1…5ff4d0`，20:30:38；与 `2026-10-26-kitchen-sos-led-speech-final/source-before/public/node_main.c` 逐字节相同，即 20:42/20:43 烧录的 LED 正式固件源码。`esp32-node/main/node_main.c` 正在被其他会话并发修改（21:04:18 仍在新写，当前 74,973 B / SHA-256 `2d0d65e2…e1eecf`），故本报告不引用其行号。）

### 2.1 发声函数只有 3 个调用入口

| 调用点（file:line） | 触发条件 | 输入来源 |
|---|---|---|
| `node_main.c:1164` `buzzer(1)` + `:1165` `local_voice_alarm(type)` | 仅当 `alarm_raise_allowed()` 通过、真的新建一个告警（`s_state=2`，新 `alarmId`） | 只经由 `raise_alarm()`，而 `raise_alarm()` 只有两个调用者：`sos_event()`:`761`、`judge()`:`1236`/`1248` |
| `node_main.c:747` `buzzer(1)` + `:750` `local_voice_alarm("MANUAL_SOS")` | 仅当 `s_state==2 && s_alarm_type=="MANUAL_SOS" && s_user_stopped`（用户 stop 后**本板**再按一次） | `sos_event()` 的唯一调用者是 `sos_handle_fast()`:`1389`/`1391`（本板 KEY0 或本板 SOS GPIO）与台架注入 `:875` |
| `node_main.c:1295` `buzzer(1)` + `:1298` `local_voice_alarm(s_alarm_type)` | `alarm_reminder_tick()`：`state==2` 且未被 stop/ACK、且到 300 s 限频点；`NO_MOTION` 只提醒一次（`:1288`） | 依赖本板已经处于 ALARM（本板状态机），无外部输入 |

`raise_alarm()` 判定链：
- `judge()`:`1227` → `active_danger()`:`1174–1204`：GAS/SMOKE（本板 MQ-5/MQ-2 ADC）、WATER_LEAK（本板 GPIO）、CLIMATE（本板 AHT20）、NO_MOTION（本板 PIR 计时）。全部是**本板本地传感器**。
- `sos_event()`:`741` → `sos_handle_fast()`:`1355–1419`：`gpio_get_level(CONFIG_NODE_SOS_GPIO)`（`:1361`）、`xl9555_read_ports()` 读本板 KEY0 P1_7（`:1363–1384`）。台架注入 `inj sos` 仅在 `CONFIG_NODE_ALARM_BENCH_INJECT=y` 时编译（`:848`）。
- 主循环每 100 ms：`sos_handle_fast()`:`1577`、`sample(); judge();`:`1580–1584`、`alarm_reminder_tick()`:`1586`、命令执行 `:1592–1593`。

### 2.2 网络下行**不会**发声

- `handle_command()`:`766–912` 只识别：`ack`（771）、`stop`（800）、`pause`（814）、`resume`（828）、`reset`（836）、`inj`（849，仅台架固件）。**没有 `sos`/`fall`/`gas`/`smoke`/`motion` 命令处理**；这些字符串只出现在 `inj sos`（873）与 JSON 字段（1319–1323）。未知命令走 `:910` → `未知命令（忽略）`。
- 所有命令分支对声音的作用只有：`buzzer(0)`+`local_voice_cancel()`（794/795、806/807、822/823、844/845），或状态改写（不做 `buzzer(1)`/`local_voice_alarm()`）。
- 上电自检也不发声：`local_voice_start()`:`1447` 内部只在 `CONFIG_NODE_VOICE_BOOT_TEST` 时播试听（`local_voice.c:168–170`，部署固件该配置不存在）；`buzzer(1)` 的 boot beep 包在 `CONFIG_NODE_BOOT_BEEP_MS > 0`（`node_main.c:1449–1454`），正式配置 `=0`。`local_voice.c:167` 启动日志即 `READY playback-only … no boot alarm`。
- 两板正式配置（`.local/led-20261026/kitchen-prod/sdkconfig`、`bath-prod/sdkconfig`）：`NODE_ALARM_BENCH_INJECT` 不存在（=n）、`NODE_BOOT_BEEP_MS=0`、`NODE_VOICE_BOOT_TEST` 不存在；厨房 `SOS_GPIO=-1 / KEY0=y / MOTION=-1`，卫生间 `SOS_GPIO=15 / KEY0 未启用 / MOTION=36`；两板 `GW_HOST=10.127.130.179:9101`、`ALARM_REPEAT_SEC=300`、`ALARM_BEEP_SEC=10`。

> **结论 (a)：节点发声只可能由自身状态机触发。** 从网络侧唯一能改变节点状态的输入是命令，而命令集合中没有“产生告警/播放”的语义。故“卫生间按钮→厨房发声”在固件层面**不存在设计联动**。

---

## 3. (b) bridge / broker / homemon / command-sync 的命令与告警路由审计

| 环节 | 路由键/目标 | 是否广播/扇出 | 证据 |
|---|---|---|---|
| Broker `mqtt_broker.js` | MQTT 主题通配匹配 | 无 retain（PUBLISH 分支只按订阅过滤器转发，未实现 retain 存储）、无 QoS2；每条 publish 只发给匹配订阅者 | `mqtt_broker.js:27–36,79–127` |
| Bridge 上行 | 由报文自身 `deviceId` 决定主题 `home/<deviceId>/status` | 每个节点各发各的 | `mqtt_bridge.js:11,332–340`；`bindNode` 同 ID 接管/拒绝抢占 `:281–317` |
| Bridge 下行 | **订阅 `home/+/cmd`，按主题里的 `deviceId` 精确 `routeCommand()`** | **无广播**；目标不在线→打印拒绝并按配置“丢弃”；只有“纯文件模式（无任何节点）”才写 `control` 文件 | `mqtt_bridge.js:167,437–445,451–506`（`:498–505` 明确“绝不写公共兜底文件……以免发错设备”） |
| Bridge relay（注入板端 APP） | 只把**状态 JSON**用 `relay` 注入 homemon | 只广播状态，不含命令 | `mqtt_bridge.js:342–419` |
| homemon `route` | `route <deviceId> <cmd>`：目标是本机才本地执行，否则把**整条 route 行**广播给 TCP 客户端（由 bridge relay 通道转给目标节点） | 广播的是带目标的 route 行，桥接再按目标二次路由；空目标/嵌套 route 拒绝 | `homemon.c:460–491`（拒绝 `:477–484`） |
| homemon `relay` | 只接受 `{` 开头的状态 JSON，原样广播给板上 APP | 仅状态 | `homemon.c:492–502` |
| gateway `_publishLocal` | `home/<deviceId>/cmd`，deviceId 来自明确目标 | 无广播；RESET 在多台在线时直接拒绝（`online.length !== 1` 返回 null） | `gateway.js:741–755`、`669–733`；ACK 在本层 deferred（`653–662`） |
| command-sync（后端 ACK 下行） | 严格校验后发布 `home/<command.deviceId>/cmd`，载荷 `{cmd:'ack',alarmId,action}` | 无广播；文件头写明“绝不猜测设备，绝不广播”；无效命令只记账 | `command-sync.js:18–33,103–137,348–385,680–702` |
| backend ACK 目标 | `command.deviceId = alert.deviceId`（告警所属设备），完成回执还校验 `deviceState.deviceId/alarm.id` 一致 | 无扇出 | `cloud/backend/src/store.js:374–395`、`persistent-store.js:986–1011,429–455` |

补充：
- 桥接日志证据：所有下行都带明确目标，例如 `[bridge] 命令已写入节点 esp32-bath 的活动连接: ack e-1793015347-1 …`（`bridge.out.log:12044`）、`… esp32-kitchen …: ack e-1793013032-1`（`:9850`）。**没有任何“写给所有节点”的行。**
- 若有人把 `sos` 命令误发到 `home/esp32-kitchen/cmd`：bridge 会照主题写给厨房，但厨房固件 `handle_command()` 无 `sos` 分支（见 §2.2），只打印 `未知命令（忽略）`，**不会发声**。
- 省略 target：`handleRouteLine()` 对空目标直接拒绝（`mqtt_bridge.js:379–384`）；主题缺 deviceId（如 `home//cmd`）不匹配 `/^home\/([^/]+)\/cmd$/`（`:452`），不会路由。**不存在“省略 target 即群发”。**

> **结论 (b)：路由是“每设备一份”，没有告警/命令广播；不存在同 deviceId 双属主并发（bridge 强制单属主，新连接接管旧连接），也不存在省略目标群发。**

---

## 4. (c) 历史日志：两板 ≤5 s 同时事件

### 4.1 已证实：台架窗口 20:26–20:41 有 21 对“同时播放”

日志：`competition/evidence/2026-10-26-local-alarm-led-closure/verify/led-*-{kitchen,bath}*.log`。
两板日志都由 `bench-serial.py` 采集，每行带 `[+elapsed] [wall-clock]`。统计所有 `local-voice: PLAY clip=N` 事件后，跨板时间差 ≤5 s 的配对：

| 日志对 | 厨房 PLAY 数 | 卫生间 PLAY 数 | ≤5 s 配对数 | 最大差值 |
|---|---|---|---|---|
| `led-states-kitchen.log` / `led-states-bath.log` | 2 | 3 | 3 | 3.85 s |
| `led-states-kitchen2.log` / `led-states-bath2.log` | 6 | 6 | 6 | 1.14 s |
| `led-states-kitchen3.log` / `led-states-bath3.log` | 3 | 3 | 3 | 0.06 s |
| `led-states-kitchen-endless.log` / `led-states-bath-endless.log` | 9 | 10 | 9 | 0.62 s |
| 合计 | 20 | 22 | **21** | **1.14 s** |

关键实例（原文时间戳）：
- `20:26:48.916` 厨房 `… AHT20 温湿度越界 -> ALARM（e-ue330525a-1，type=CLIMATE）语音+蜂鸣已请求`；同毫秒 `20:26:48.916` 卫生间 `local-voice: PLAY clip=2`（`led-states-kitchen.log` / `led-states-bath.log`，差值 **0.00 s**）。
- `20:28:18.415` 厨房 PLAY 与 `20:28:18.322` 卫生间 PLAY（差 **0.09 s**，`led-states-kitchen2/bath2`）。
- `20:35:23.335` 厨房 PLAY 与 `20:35:22.884` 卫生间 PLAY（差 **0.45 s**，`…endless`）。

**原因（已证实）**：不是联动，是**双端口并行台架注入**：
- 两个采集器头部：
  - `# com=COM5 … start 2026-10-26T20:35:14.851+08:00`（厨房）
  - `# com=COM4 … start 2026-10-26T20:35:14.422+08:00`（卫生间）
- 剧本逐行相同（`atSec=6 send=inj climate 47.0 95.0`、`atSec=7 同上`、`atSec=38 send=inj sos` …），因此两板在同一秒被“人为判为越界/人为 SOS”。
- 两板日志均含 `BENCH INJECT MODE`（`node_main.c:1438` 台架启动横幅），**均无 `已连接网关`**；正式配置本就不编译台架注入。台架固件不启动 WiFi/网关（`node_main.c:1517–1528`），**台架期间不存在任何网络跨房间通路**。
- 厨房在台架里的 `clip=1`（SOS 语音）来自 `inj sos`（`:873–875`），不是卫生间的按键。

### 4.2 生产窗口：两板同时“处于 ALARM”，但厨房不是被卫生间触发

生产链路日志（旧 P0 bridge，含 9001 端点与 relay）：`competition/bridge/_test/current-runtime/supervisor/bridge.out.log`（**该日志没有时间戳**，时间由告警 ID 内嵌 epoch 反推，方法见 §9）。

- 18:43:42、18:43:53、18:49:21 卫生间三次 SOS（ack 内含 ID `e-1793011422-1`/`e-1793011433-2`/`e-1793011761-3`，`bridge.out.log:8041/8079/8487`）期间，厨房状态一直是 **NORMAL**（`:24–9812` 全为 NORMAL）——生产窗口的“卫生间按了、厨房没响”反例。
- 19:10:32、19:11:12 厨房自身 SOS（`e-1793013032-1`、`e-1793013072-2`，`:9850/9876` 的 ack）——厨房当时已烧 KEY0 版本（`key0-20261026/prod/sdkconfig`：`NODE_SOS_KEY0_ENABLED=y`；19:09:26 串口日志 `SOS 按键就绪：板载 KEY0 = XL9555 P1_7`，`verify/prod2-COM5-quiet.log`）。
- **19:49 前后**（关键窗口）：
  - 厨房 `state=ACKED`（`:11605`）→ `state=ALARM`（`:11606`）；
  - 其后的三条卫生间上报仍是 NORMAL（`:11613/11620/11627`，即 3×5 s≈15 s）；
  - 卫生间才在 `:11630` 变 ALARM，其 alarm id `e-1793015347-1` 内嵌 epoch = **19:49:07**（`:12044` 的 ack 引用同一 ID）。
  - 即：**厨房先告警，卫生间 SOS 后发生（厨房约早 15–20 s）**；因此厨房告警不可能是由这次卫生间按键触发。
  - 该时段 `bridge.out.log` 中最后一条写向厨房的命令是 `:9876`（19:11:12 的 ack）；`:9877–12045` 再**没有** `命令已写入节点 esp32-kitchen`。→ **厨房这次告警只能来自本板触发（KEY0 或 CLIMATE），具体类型日志未记录，未定位。**
  - 19:49–20:03 两板**同时为 ALARM**：`bridge.out.log:11630–12043`（厨房 ALARM 59 条、卫生间 ALARM 56 条）延续到 `bridge2.log` 前段（厨房 ALARM 107 条、卫生间 19:57 后 ALARM 79 条）。
  - 两板恢复 NORMAL 不是 ACK，而是**重启**：`bridge2.log:519` 厨房断线、`:529` 以 `10.127.130.168` 重连并报 NORMAL；`:539` 卫生间断线、`:548` 以 `10.127.130.71` 重连报 NORMAL（≈20:03:30–20:04:30）。同期证据：LED 任务在读设备身份，`build/device-identity-COM5-kitchen.json` 写于 20:04:38、`device-identity-COM4-bath.json` 写于 20:05:06（esptool 打开/复位串口会重启板子）；重启后告警状态不持久化、不重放（`node_main.c` 设计 + 该报告 §3）。
- 生产固件串口抓取（`verify/kitchen-09/10/11-*.log`、`bath-09/10-*.log`、`prod-kitchen-boot.log`、`prod-bath-boot.log`）均为**单板逐个抓取**，时段互不重叠（如 kitchen 20:42:43 与 bath 20:43:10 两段 boot 日志串行），且全程 `no boot alarm` / 无 `PLAY clip=1`；**没有任何生产固件日志显示两板 ≤5 s 同时播放**。

### 4.3 20:49:40 之后

`public-sync-supervisor.log` 最后两条两板状态为 `2026-10-26T12:49:40Z`（=20:49:40 +08，本地）厨房、`20:49:39/40` 卫生间；`bridge2.log` 之后只有本机端口探测，无两板状态。即 **20:49:40 起两板同时离开链路，至 21:07 未回来**。此后的任何“按了某按钮”都**不可能**经过 PC 侧链路影响另一块板。

> **结论 (c)：**
> - **≤5 s 同时播放：已证实存在，但只出现在 20:26–20:41 的隔离台架窗口，原因是双板并行注入（剧本相同、差 0.02–0.43 s 启动），台架固件无网络，物理上不可能跨房间。**
> - **生产窗口只有“同时处于 ALARM 状态”**（19:49–20:03），且厨房告警早于卫生间 SOS；**厨房触发类型未定位**（无串口抓取，桥接日志不写 alarm.type）。
> - 生产窗口“厨房 300 s 限频提醒”理论上会周期性发声（`node_main.c:1283–1302`），但这段厨房没有串口日志，**无法证明/否证当时确有声音**——列为未定位。

---

## 5. (d) 是否存在并行台架注入导致两板同时被触发

**已证实存在并行台架活动，且能解释 4.1 的同时播放**：

1. 两套 `bench-serial.py` 同时抓 COM5/COM4 并注入同一剧本（见 4.1 头部原文）。驱动这些剧本的会话是 LED 告警闭环任务（其 `REPORT.md` §6 写明两块台架板各自跑同序列）。
2. 同一运行期还有**第三方节点/模拟节点注入生产 bridge**：
   - `bridge.out.log:11371–11395` 出现 `home/esp32-sos-isolated-test/status`（8 条，deviceId `esp32-sos-isolated-test`）；
   - `:11898` 出现 `esp32-sos-isolated-test2` ALARM；
   - `10.127.130.91` 反复接入 9101（如 `bridge2.log:20,495,11616…`），对应另一会话的第三块“随身 SOS 板”（`evidence/2026-10-26-wireless-sos-button/REPORT.md`：MAC `30:30:f9:08:76:84`，IP `10.127.130.91`）。
3. 这些注入都是**独立 deviceId 的状态上报**，不携带面向 `esp32-kitchen`/`esp32-bath` 的命令；台架固件本身无网络。**它们会造成“设备列表/告警列表里出现额外设备”，但不会触发厨房或卫生间发声。**

**未定位**：是否有某次“两板同时响”的现场观察正好落在 20:26–20:41 台架窗口内（用户按压卫生间实体 SOS 的同时，厨房正被台架注入 CLIMATE）。日志能证明“此时厨房确实在按剧本播报”，但无法证明用户当时按了按键。

---

## 6. (e) APP/DAYU 的 ACK 若错投厨房，会不会发声

**已排除（不会发声，最坏是静音/被拒绝）**，依据：
1. 后端 ACK 目标 = 告警所属 `deviceId`（`store.js:374–395`；`persistent-store.js:986–1011`），command-sync 发布到 `home/<deviceId>/cmd` 且只接受 `command==='ACK'` 且 id/deviceId/alarmId/action 全部合法（`command-sync.js:103–137`）；无效即 `COMMAND_IGNORED`，不猜设备、不广播（`:18–33`）。
2. 即使被人为误发到厨房，厨房 `handle_command()` 的 ack 分支（`node_main.c:771–799`）：
   - `s_state != 2` 或 `s_alarm_id` 为空 → `ACK 被拒绝：当前没有待处理告警`；
   - `aid != s_alarm_id` → `ACK 被拒绝：告警 ID 不匹配`（旧回执不能确认本次求助）；
   - 仅精确匹配时执行 `buzzer(0)`、`local_voice_cancel()`、`state=ACKED` → **只会静音**。
3. 厨房若正处于自身 ALARM 而被误 ACK，效果是**厨房被静音并进入 ACKED**，不是发声；且这是“错误地停止告警”，属于链路安全问题而不是“厨房响”的原因。
4. 观测证据：`bridge.out.log` 中所有 ack 均写明目标（esp32-bath / esp32-kitchen），且厨房的两次 ack 使用的 ID 正是厨房自己的 `e-1793013032-1`/`e-1793013072-2`，说明 ID 精确匹配才生效。

---

## 7. 未定位 / 剩余不确定性（不得写成已修复）

| 项 | 状态 | 说明 |
|---|---|---|
| 19:49 窗口厨房自身 ALARM 的 `alarm.type` 与触发源（KEY0 按键？噪声误触？AHT20 CLIMATE？） | **未定位** | 桥接日志只打印 `state/room/countToday`；`status.json` 已被后续状态覆盖；该时段无 COM5 串口抓取。已知约束：厨房无 PIR/水漏，GAS/SMOKE 阈值 4096=禁用；生产固件候选源只有“KEY0 实体键（板载 XL9555 P1_7）”与“AHT20 温湿度越界”，二者均可能。 |
| 19:49–20:03 期间厨房是否真的发声、发声时刻 | **未定位** | 只能证明 `state=ALARM`；`PLAY` 仅出现在串口。按设计 ALARM 期间会立即播报并在 300 s 后限频提醒（`node_main.c:1283–1302`），但无日志证明具体时刻。 |
| 用户实际“按卫生间按钮”的时刻 | **未定位** | 与任何日志中的 bath SOS 事件（18:43:42 / 18:43:53 / 18:49:21 / 19:49:07 / 19:57 附近 / 20:2x–20:4x 台架注入）的对应关系无法确定；20:49:40 之后两板不在线，如有按压则完全本地。 |
| 20:49:40 两板同时离线的原因 | **未定位** | 同一秒级消失（public-sync 最后 20:49:39/40），之后未重连；可能是断电/换线/另一会话操作，本次只读无法判定。 |
| 台架窗口内是否同时有真实按键 | **未定位** | 日志无法区分“用户按了实体键”与“剧本 `inj sos`”。 |
| 厨房 KEY0 是否存在误触/噪声风险 | **未定位（既有风险）** | 历史 18:28:22 曾有来源不明的卫生间 SOS（`e-127-3`，见 voice-closure 报告 §4.2）；厨房 KEY0 同样可能受 I2C/按键噪声影响。 |
| 当前 9101 是“测试桥接”而非 P0 生产桥接 | **证据链一致，命令行未读到** | `bridge2.log` 横幅：仅 `broker 127.0.0.1:1883` + `监听端口 9101`，**无 `转发目标 9001`、无 `节点数 … 127.0.0.1:9001`**；其创建时间 19:54:11 正是生产 bridge 日志停写（19:54:09）之刻。`tasklist`/`Get-CimInstance` 读 PID 命令行被系统拒绝（Access denied），故不能 100% 断言进程归属。 |

---

## 8. 真实验收：双板串口并行监听应比对的字段与判定

> 目标：证明“只按卫生间实体 SOS 时，厨房没有任何本地触发”。建议同时抓 COM4+COM5（`bench-serial.py` 方式：每行 `[+elapsed] [wall-clock]`），窗口 = 按键前 30 s + 按键后 ≥180 s（覆盖 300 s 限频需要延长到 330 s 更好），并在 PC 侧同时记录带时间戳的 bridge 输出（当前 bridge 日志**无时间戳**，这是取证缺口，需用 `tee`/包装脚本加时间戳）。

### 8.1 必须逐行比对的字段

| 字段/日志模式 | 卫生间 COM4 期望 | 厨房 COM5 隔离通过条件 |
|---|---|---|
| 启动身份 | `ESP32-S3 无线节点启动：esp32-bath / 卫生间` | `… esp32-kitchen / 厨房` |
| 输入来源 | `SOS 按键被按下`（GPIO15，实体键） | **不出现** `厨房设备板载 KEY0 被按下`、`KEY0 原始电平变化：按下(低)` |
| `state`（JSON） | `NORMAL → ALARM`（单次） | 全程 `NORMAL`（不得出现 ALARM/ACKED 跃变） |
| `alarm.id` | 新 `e-<epoch>-N`，epoch≈按键时刻 | 保持空/不变；不得出现新 ID |
| `alarm.type` | `MANUAL_SOS` | 空（或保持验收前类型，不得新增） |
| `alarm.countToday` | 只 +1 | 不变 |
| 播放 | `local-voice: PLAY clip=1` **恰好 1 次**（SOS 语音） | **无任何 `PLAY clip=*`**（`clip=0` 也不得出现） |
| 停止 | `local-voice: STOP result=… cancelled=` 与 ACK 对应 | 无 |
| 蜂鸣器 | 无逐声日志；以 `PLAY`/告警行同时刻的人工听感 + 可选逻辑分析仪抓 XL9555 P0_3 为上；日志侧只能引用 `告警鸣响到时，自动静音`（`:1417`） | 不应出现任何蜂鸣相关行；建议同法抓 P0_3 证 0 次 |
| LED | `local-led: LED 模式=SOS_TRIPLE …` | `LED 模式=OFF`（不得出现任何闪烁模式） |
| 下行命令 | 若做 ACK：`CMD 收到: ack <bathId> …` → `ACK 回执已接受并生效` | **不得出现** `CMD 收到: …`（或只出现被拒的 ack：`ACK 被拒绝…`），且拒绝后仍 NORMAL |
| 限频提醒 | ACK 前若持续 >300 s 可能有 `持续异常限频提醒` | **不得出现** `持续异常限频提醒`（若出现，说明厨房有自己的 ALARM） |
| 温湿度 | 与本板真实读数一致 | 若出现 `AHT20 温湿度越界 -> ALARM` → 厨房自身触发，单独定位，不算跨房间 |
| 桥接侧 | `命令已写入节点 esp32-bath …`；`→ home/esp32-bath/status state=ALARM` | **不得出现** `命令已写入节点 esp32-kitchen`；厨房状态行不跃变 |
| 云端侧 | `cloud-sync OK device=esp32-bath … status=202` | 厨房仅 NORMAL 心跳；无新告警 ID |

### 8.2 判定规则

1. **通过（来源隔离成立）**：卫生间 SOS 前 30 s 至后 180 s 内，厨房串口 **0 次 PLAY、0 次 STOP、0 次新 alarm.id、0 次 state≠NORMAL、0 次 KEY0 边沿、0 条 CMD**，且 bridge 无写向 esp32-kitchen 的命令。
2. **失败（需继续定位）**：厨房出现任一上述事件。此时**先看厨房事件前 1–3 行**：若紧邻 `AHT20 温湿度越界`/`持续异常限频提醒`/`KEY0 原始电平变化`，则归因为厨房自身；若前面是 `CMD 收到: sos` 等**不该存在的下行命令**，才是路由/下发问题（当前代码这些命令会被忽略，故更可能是固件版本不一致，需先核对 app 分区 SHA-256）。
3. **对照实验（强烈建议）**：
   - 对照 1：卫生间断电，只按厨房 KEY0 → 应只有厨房 `MANUAL_SOS` + `PLAY clip=1`，卫生间串口无事件（证明按键→房间映射正确）；
   - 对照 2：厨房断电，只按卫生间 SOS → 厨房不可能发声（物理闭环）；
   - 对照 3：保持两板上电、不按任何键 330 s → 两板均无 PLAY（排除 300 s 提醒/重启/底噪误判）。
4. **必记元数据**：两板 app 分区 SHA-256（应与 LED 正式固件 `kitchen A66B3D7D…8611` / `bath EF2C62FC…72B5` 对应；若已再烧新固件则重算并写清）、bridge/9101 进程归属与启动参数、采集起止 wall clock、每板 `ts` 与 `elapsed`、以及 `alarm.id` 内嵌 epoch 与墙钟的偏差（用于证明事件排序）。

---

## 9. 方法学与限制

- `bridge.out.log` / `bridge2.log` **行内无时间戳**。本报告的时间来自：
  1. 告警 ID 内嵌 epoch（`alarm_id_build(time(NULL), …)`，`node_main.c:1147–1154`；如 `e-1793015347-1` → 19:49:07）；
  2. 两板 5 s 上报节奏（相邻状态行的间隔）；
  3. `public-sync-supervisor.log`（UTC `…Z`，已换算 Asia/Shanghai）与串口日志的墙钟。
  因此 4.2 中“厨房约早 15–20 s”为**区间估计**（依据 11606→11630 之间卫生间 3 条 NORMAL 上报≈15 s），不是毫秒级定论；但“厨房先于卫生间 SOS”的方向由“厨房 ACKED→ALARM 发生在卫生间 NORMAL→ALARM 之前”的状态行顺序直接支持。
- 并行会话影响：诊断期间 `esp32-node/main/node_main.c` 在 21:04:18 仍被修改（当前 74,973 B / `2d0d65e2…`），`bridge2.log`、`broker.out.log`、`public-sync-supervisor.log` 持续被写入；本报告一律以**部署固件源码快照 `6d5cc5a1…`（69,807 B）**为行号基准，并以各文件自身路径+行号+原文引用，避免与并发修改混淆。
- 未读取/未操作：串口、网络设备、APP/DAYU、公网 backend；未读取任何密钥；未重启任何服务。
