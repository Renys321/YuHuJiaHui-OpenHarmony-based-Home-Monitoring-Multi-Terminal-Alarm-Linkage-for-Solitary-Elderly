# 随身求助按钮联网闭环 + 同一事件定向两板播报 —— 交付报告（2026-10-26 / 阶段 v4）

**一句话结论**

| 判据 | 结果 |
|---|---|
| 1. COM8 真实联网（真实 AP 取址 + 真实网关 + 公网 202） | ✅ **通过**（有连续证据，见 §2） |
| 2. 同一 `alarmId` 定向两板播报 | 🟡 **协议/实现/隔离验证通过；厨房板已烧录并在线；卫生间板未烧录**（被并行门磁工程占用，见 §6） |
| 3. APP 展示原始来源与事件身份 | 🟡 代码路径已只读核对（`esp32-sos` / `随身求助` + 同一 `alarmId`）；**未装 APP 实机验证** |
| 4. 用户 ACK 回到三设备 | 🟡 协议层隔离验证通过（`ack`→COM8、`noticeack`→两板）；**真实 ACK 待用户** |
| 5. 三设备回执 | ❌ 未完成（阻塞：bridge 切换审批 + 卫生间固件 + 真实按压） |
| 6. 独立供电（脱离 USB） | ❌ 未确认（用户侧动作） |

**本轮没有伪造任何“已通过”**：凡是需要用户按键、独立电源、APP 实机、以及切换运行中共享 bridge 的环节，全部标为待验收，证据与阻塞写在对应章节。

---

## 1. 继承与基线核对（先核对，再动手）

| 基线项 | 核对结果 |
|---|---|
| COM8 身份 ESP32-S3 / MAC `30:30:f9:08:76:84` | ✅ 串口设备仍在（`USB-Enhanced-SERIAL CH343 (COM8)`）；固件日志 `wifi:mode : sta (30:30:f9:08:76:84)` |
| 16MB 全片备份 `17D0EFAF…E5EA8E4` | ✅ 文件仍在 `D:\esp32-sos-build\.local\com8-full-backup-20261026.bin`，16,777,216 B，SHA-256 与基线**逐位一致**（本轮未重复读全片） |
| 随身按钮固件终版 `D40990F7…920D19` | ✅ 与本轮开始时板上运行版本一致（`build/flash-sos-gpio5-hl-COM8.json`），**本轮未改、未重烧 COM8** |
| 按钮 GPIO4 / 蜂鸣器 GPIO5 / GPIO6 禁用 | ✅ 未改动接线与 GPIO 配置；COM8 固件日志仍为 `GPIO[4]` 输入上拉、`GPIO[5]` 输出 |
| 厨房正式固件 `446A5B87…E29167` | ✅ 烧录前只读读回 app 分区，前 1,016,864 B 与正式镜像 SHA **完全一致**（备份见 §5） |
| 卫生间“正式”状态 | ⚠️ **与历史记录不符**：板上现为门磁候选固件（详见 §6.1） |
| 报告/日志不含密码、Token、`INGEST_KEY` | ✅ 本目录不落任何凭据；串口日志仅含 SSID 名 |

---

## 2. 一、联网阻塞排查结果：**COM8 的联网已经通了**

### 2.1 事实（不是推测）

- 串口实测（`verify/com8-net-verify.log`，2026-10-26 23:52）：
  - 上电连续运行 **734 秒无重启**（uptime `I (734487)` 起，全程 8 条 status，间隔 5 s）
  - `sta ip: 10.127.130.91`，`gw: 10.127.130.217`
  - `elder-node: 已连接网关 10.127.130.179:9101`
  - `STACK_FREE task=gateway-net bytes=2696`（此前 21:25 版本在 `→ {` 后 `A stack overflow in task main`，已由 `build-sos-stack` 修掉，本版本无任何 abort/backtrace）
- 公网（`public-sync-supervisor.log`）：
  - `[cloud-sync] OK device=esp32-sos ts=1793029966544 deviceTs=1793029966676 path=/internal/v1/device-status status=202`
  - 该 `deviceTs` 与同一时刻串口日志里的 `ts=1793029966676` **完全相同** → 同一块板、同一秒的真实报文确实被后端接收。
- MQTT 侧实时快照（`home/+/status` 保留消息）：三块板都是 `state=NORMAL`，`esp32-sos` 的 `ts` 已是有效毫秒时间（不再是 0）。

**结论**：`AUTH_FAIL/reason=202` 是**间歇性**的（历史上 10 分钟窗口里数次成功取址），当前状态下 COM8 可稳定联网并上报到公网后端。**没有改路由器、没有换网络、没有动家庭配置。** 也不需要 `INGEST_KEY` 由用户粘贴到聊天——`public-sync` 守护进程（PID 32356 / worker 32788，`state=HEALTHY`）已在运行并带凭据。

### 2.2 配置来源核对（“NVS 是否覆盖编译配置”）

- 固件启动即打印 `连接 WiFi: ElderCareLab`，与编译期 `CONFIG_NODE_WIFI_SSID` 一致；ESP-IDF 的 `esp_wifi_set_config(STA)` 在 `wifi_start()` 里显式下发，**NVS 只保存 phy 校准与 `mon_paused`，不保存 SSID/密码**，因此不存在“NVS 覆盖编译配置”的情况。
- 认证模式实测为 `WPA2-PSK`、`PMF` 关闭、`rssi -22 ~ -27 dBm`（很强），与“信号临界”解释不符；`reason=202` 的间歇性更符合 AP 对新 MAC 的瞬态限制。**这条只作为观察记录，不作为结论强加给用户。**

---

## 3. 二、同一事件的定向两板播报（设计 + 实现）

### 3.1 设计要点（为什么这样改）

- **唯一原始事件**：只有 `esp32-sos` 进入 `state=ALARM ∧ alarm.type=MANUAL_SOS` 才算“原始求助”。事件身份 = 它自己的 `alarmId`。厨房/卫生间**不产生任何告警**，只是“替这条事件发声”。
- **受控逐台路由**：由 bridge 在收到该状态时，用**既有的 `routeCommand(deviceId, line)`** 显式写给 `esp32-kitchen` 和 `esp32-bath` 两个 socket。**没有 MQTT 通配、没有广播主题、没有公共文件兜底**（离线即记失败）。
- **为什么放在 bridge 而不是 APP/后端**：APP 走 HTTP→后端→command-sync→MQTT，链路长且会多一次“新事件”的语义风险；bridge 是唯一同时看得见“来源事件”和“两个目标 socket”的位置，最少的改动就能保证“同一 `alarmId`、同一次派发”。
- **`notice` 不能被外部注入**：bridge 的 MQTT 命令翻译表**故意不包含 `notice`**（已用回归测试证明 `{"cmd":"notice"}` 打到 `home/esp32-kitchen/cmd` 时设备收不到任何东西）。只有 bridge 自己的编排逻辑能发这条命令。

### 3.2 新增行协议（两条，纯增量）

```
notice    <alarmId> <sourceDeviceId>   # 开始播报别人的求助（仅接受 [A-Za-z0-9._-]{1,32}）
noticeack <alarmId>                    # 该求助已被监护人确认 → 停本板播报
```

设备侧语义（`main/notice_logic.h`，纯逻辑，可主机单测）：

| 情况 | 行为 |
|---|---|
| 首次收到某 `alarmId` | 短提示音（**5 声**，区别于本板求助的 3 声）→ 中文语音；记 `active_id` |
| 同一 `alarmId` 重试/重复上报/抖动 | `NOTICE 重复已抑制`，**不叠播、不重发** |
| 已 `noticeack` 过的同一 `alarmId` 再来 | `NOTICE 已忽略`，**不重播**（断线重连也不补发） |
| 本板正在本地告警（`s_state==2`） | `NOTICE 被忽略…本地告警优先`，不改本地状态、不抢声音 |
| 本地告警接管（本地事件到来） | 先 `notice_yield` 停掉外来播报，并把该 id 记为“已结束”，之后不会重放 |
| 本板 `ack` / `stop` / `reset` | 原有语义**完全不变**（`ack` 仍需 ID 精确匹配 + 处于 ALARM） |
| 环境告警（`CLIMATE`/`NO_MOTION`/`GAS`/`SMOKE`） | **不会**触发跨房间广播（派发条件只认 `MANUAL_SOS`） |
| 通知里带来源 | `source=esp32-sos` 只进日志与证据，**不写进本板上报**，APP 不会多出设备 |

### 3.3 语音文案的取舍（重要，含实测数据）

- 原本新合成了一条专属文案「随身求助，请尽快查看。」，实测 **19,902 B（rate=2）/ 23,981 B（rate=0）/ 26,483 B（rate=-1）**。
- 厨房正式镜像 `1,016,864 B`，factory 分区 `1,048,576 B`，**余量只有 31,712 B**。加上专属片段后镜像 `1,043,712 B`，**只剩 4,864 B**，IDF 直接告警 `0% free space left`，会挤掉门磁并行工作所需的改动空间。
- **决策：不新增语音资源**，第 7 号片段复用已上板验证的 `sos.adpcm`（"我需要帮助，请尽快过来。"），来源区分改用**提示音次数**（本板 3 声 / 外部求助 5 声）+ APP 上的来源/房间 + 串口日志。
- 生成与测量脚本、三种语速的产物都留在 `voice/`，将来若要让固定板说「随身求助按钮触发」，可直接启用（代价：厨房余量降到 <5 KB）。

---

## 4. 三、代码变更清单（最小增量）

| 文件 | 变更 | 影响面 |
|---|---|---|
| `competition/bridge/mqtt_bridge.js` | 新增 `--sos-source` / `--sos-targets` / `--sos-log`；新增 `sosFanoutObserve()`（派发 + ACK 收口 + 逐目标 delivered/failed + JSONL 记录）；`publishStatus()` 末尾加一行调用；启动横幅打印开关状态 | **不给参数时功能完全关闭，旧行为逐字节不变**（§5.3 回归测试） |
| `competition/esp32-node/main/notice_logic.h`（新增） | 定向播报纯判定：ID 白名单、本地告警优先、单次播放、已确认不重播、yield | 与硬件无关，可主机编译 |
| `competition/esp32-node/main/node_main.c` | 加 `notice`/`noticeack` 命令分支；`announce_start` 对外部求助用 N+2 声；`raise_alarm` 先 `notice_yield_local()`；`reset` 清 active | 只新增分支，原有 `ack/stop/pause/resume/reset/inj` 一字未改 |
| `competition/esp32-node/main/local_voice.{h,c}` | 新增 `VOICE_CLIP_REMOTE_SOS=7`，复用 `sos.adpcm` | 不增加 flash 占用 |
| `competition/esp32-node/main/CMakeLists.txt` | 未新增资源（改动已回退） | — |
| `competition/esp32-node/test/host_notice_logic_test.c`（新增） | 42 条断言 | 主机侧，不需硬件 |
| `.local/notice-20261026/bath-merged-src/**`（新增副本） | 门磁分支源码 + notice 逻辑 + 语音素材，**独立目录**；顺带把该副本 Kconfig 的音量上限 20→33（原值会把 30 静默截成 15） | 不修改门磁原目录 |
| 未改动 | 门磁 `.local/door-contact-20261026/**`、D/E、CAMERA-A、APP、后端、public-sync | — |

**明确未做**：未重启/替换运行中的 broker(1883)、bridge(9101)、public-sync；未改 APP、后端、public-sync 任何一行；未部署 D/E、CAMERA-A、门磁任何功能。

---

## 5. 四、验证证据（分层，可复现）

### 5.1 设备侧纯逻辑主机单测

```
gcc -std=c11 -Wall -Wextra -Werror -I..\main host_notice_logic_test.c -o host_notice.exe
host_notice_logic: ALL PASS (42 passed, 0 failed)
```
覆盖：单次播报、重试去重、ACK 后不重播、本地告警优先、本地接管后不重放、ID 精确匹配、非法输入（空格/换行注入/超长/缺来源/斜杠）、同 id 不同来源不算新事件。

### 5.2 隔离集成测试（bridge + broker + 3 个模拟节点，独立端口 18830/9111）

```
node sos-fanout-isolated-test.js
SOS_FANOUT_ISOLATED_TEST PASS 16/16 checks
```
逐条：`A1/A2/A3` 两板各收到**同一 alarmId**、`A4/A5` 重复上报与 ACK 后重放均**不再派发**、`B1/B2` 一块离线另一块照常播报且记录 `failed_offline`、`C1~C4` ACK 收口只发给“确实送达”的目标、`D1` 重连**不补发**、`E1` 环境告警**不跨房间**、`F1/F2` ACK 后新按键产生**新 alarmId**、`G1` APP 侧 `ack` 仍能路由回来源节点。

### 5.3 旧行为回归（不传新参数）

```
node bridge-regression-smoke.js
BRIDGE_REGRESSION_SMOKE PASS 4/4 checks
```
`H1/H1b` `ack`/`reset` 照旧路由；`H3` `{"cmd":"notice"}` 从 MQTT 注入**设备收不到**；`H2/H4` 未配置 target 时即使来源真的 MANUAL_SOS 也**不外发**。

### 5.4 固件构建与身份

| 目标 | 镜像 SHA-256 | 大小 | 分区余量 | 状态 |
|---|---|---|---|---|
| 厨房（语音+定向播报） | `43C1183A30688EAA56080BFA9C0CAB363B85839BE3FFD54FCBE19DB33F8443DD` | 1,019,728 | 28,848 B (3%) | ✅ **已烧录 COM5，Hash verified，运行正常** |
| 厨房（烧录前正式版） | `446A5B8700EEB721044B7223616B76F65C8BA96EBE2F2991753C3AE986E29167` | 1,016,864 | — | 已备份，可回滚 |
| 卫生间（门磁+语音+定向播报，三合一） | `42F24D5FED61DBD11A768E0ADDB54EDC78C9A36C02F7F58C0603CECE79793715` | 1,011,648 | 36,928 B (3.5%) | ⛔ **仅构建，未烧录**（见 §6.2） |
| 卫生间（仅语音+定向播报，不含门磁） | `2C0C72175636313A2B443FA86E985226557C9E5974813480B4DF63E631CFD6F5` | 1,009,392 | 39,184 B | ⛔ 被三合一版取代，勿用 |
| COM8 随身按钮（**未改**） | `D40990F7F35739216F1138A21759793BFAD6B2CA020C4310C0FC247248920D19` | 762,768 | — | ✅ 保持原样 |

ELF 符号核对（厨房）：`notice_begin / notice_end / notice_yield / notice_yield_local / notice_start / notice_ack / announce_start` 全部存在。
厨房烧录后实测（`verify/kitchen-notice-boot.log`，50 s）：`sta ip: 10.127.130.168`、`已连接网关`、`state=NORMAL` 连续 10 条、无重启；公网 `[cloud-sync] OK device=esp32-kitchen … status=202`（`deviceTs` 与串口 `ts` 一致）。

---

## 6. 五、阻塞项（必须由用户决策，我没有擅自越过）

### 6.1 卫生间板已被并行门磁工程占用，且掉了语音与 LED

只读核对（未占用 COM4）：

- 卫生间当前上报里带 `door: {open, lastOpenTs, lastCloseTs, seq, events:[...]}` —— 这是门磁候选固件，**不是**历史记录里的语音正式固件 `46C7968D…CEA63`。
- 该固件编译配置中 `CONFIG_NODE_VOICE_ENABLED` **未开启**、`CONFIG_NODE_LED_GPIO=-1` → **卫生间现在既不会说话，告警灯也不亮**。这是本轮发现的跨工程回归，我没有单方面修复。
- 同时该板上报被公网网关**整条拒绝**：`[gateway] REJECT code=INVALID_STATUS device=esp32-bath`（每 5 s 一次，持续）。原因是网关 `adapter.js` 对 `sensors.door` 做严格键白名单，新增的 `seq/events/lastCloseTs` 不在白名单里。**这属于门磁工程与公网网关的接口问题，不是本次播报功能的问题，也不影响本地 bridge/定向命令。**

**我已准备好的解法**：上面 `42F24D5F…` 三合一镜像（门磁 GPIO14 + 语音 + LED + 定向播报，符号已核对 `door_update` 与 `notice_*` 同时存在）。烧它不会丢门磁，还会把语音和 LED 恢复回来。**但它是别人在跑的板，需要你点头我才动。**

### 6.2 切换运行中的 bridge（唯一"必须动共享服务"的一步）

`notice` 派发逻辑在 `mqtt_bridge.js` 里，必须让 9101 那个进程换成新代码并带上参数：

```
node mqtt_bridge.js --broker 127.0.0.1:1883 --listen 9101 \
     --sos-source esp32-sos --sos-targets esp32-kitchen,esp32-bath \
     --sos-log ...\verify\sos-fanout.jsonl
```

已提供 `tools/enable-sos-fanout.ps1`，**默认 dry-run**（已跑通，能正确识别当前 PID 42784 与其命令行）；加 `-Confirm` 才会停旧进程、起新进程、并校验 9101 重新 Listen。停到起约 2~3 秒，各板自己重连，**不动 1883 broker、不动 public-sync**。

按任务约束"不得重启或替换正在运行的共享 bridge"，我**没有执行**这一步。

### 6.3 需要用户物理配合的部分（不能自动完成）

1. COM8 待机静音确认（当前无告警，蜂鸣器应为静音——需现场听）。
2. 按钮改独立移动电源/电池供电，拔掉 USB 数据线。
3. 按一次实体按钮。
4. APP 上确认该求助。
5. ACK 后再按一次，确认产生新事件。
6. 断网/恢复验证。

---

## 7. 六、最短完成路径（按顺序，一次验收窗口内可做完）

| # | 动作 | 谁做 | 预计 |
|---|---|---|---|
| 1 | 批准切换 bridge（`enable-sos-fanout.ps1 -Confirm`） | 用户点头 → 我执行 | 1 min |
| 2 | 批准烧卫生间三合一镜像（`42F24D5F…`，先备份 app 分区） | 用户点头 → 我执行 | 3 min |
| 3 | COM8 接独立电源、确认静音 | 用户 | — |
| 4 | 按一次按钮 → 观察厨房/卫生间同时播报、APP 一条来自「随身求助」的告警 | 用户 | — |
| 5 | APP 确认 → 三处停止、COM8 收到 ACK | 用户 | — |
| 6 | 再按一次 → 新 `alarmId`，不复用旧 ID | 用户 | — |
| 7 | 只用该板断网/恢复（不动全屋网络） | 用户 | — |

若只想先验证"厨房单板播报"，第 1 步 + 第 3~6 步即可，第 2 步可后置。

---

## 8. 七、文件索引

| 路径 | 内容 |
|---|---|
| `verify/com8-net-verify.log` | COM8 真实联网串口证据（IP/网关/连续 8 条 status/无崩溃） |
| `verify/kitchen-notice-boot.log` | 厨房新固件烧录后 50 s 启动与联网日志 |
| `verify/fanout-isolated/test.log`、`sos-fanout.jsonl`、`bridge.stdout.log`、`broker.log` | 隔离集成测试全过程与逐目标送达记录 |
| `verify/bridge-regression/*` | 旧行为回归冒烟 |
| `build/flash-kitchen-notice-COM5.json` | 厨房烧录记录（MAC 核对、Hash verified、只写 0x10000） |
| `build/identity-backup-COM5.json` | 厨房烧录前身份与 app 分区备份记录 |
| `build/build-kitchen-notice.log`、`build/build-bath-merged2.log` | 构建日志 |
| `tools/` | `build-firmware.ps1`、`flash-app.ps1`、`device-identity-backup.ps1`、`bench-serial.py`、`sos-fanout-isolated-test.js`、`bridge-regression-smoke.js`、`enable-sos-fanout.ps1`、`make-remote-voice.ps1`、`make-remote-clip.py` |
| `voice/` | 专属文案的三档语速产物与测量（本轮未启用） |
| `WIRING.md` / `CHECKLIST.md` / `CHANGELOG.md` | 接线说明 / 校验清单 / 变更清单 |
| 私有（不进仓库） | 厨房 app 分区备份 `esp32-node\.local\notice-20261026\backup\COM5-app-before-20261027-000816.bin`（1,048,576 B，前 1,016,864 B = `446A5B87…`）；COM8 全片备份 `D:\esp32-sos-build\.local\com8-full-backup-20261026.bin` |

> ACK 的语义边界（写在代码注释与日志里，也在本报告里再说一次）：**ACK 只代表"求助已被监护人确认"，不代表求助者已安全。**
