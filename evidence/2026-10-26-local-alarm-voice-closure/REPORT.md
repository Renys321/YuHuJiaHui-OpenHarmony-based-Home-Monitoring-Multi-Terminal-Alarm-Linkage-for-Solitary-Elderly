# LOCAL-ALARM-VOICE-CLOSURE — 厨房 / 卫生间告警声光语音闭环交付报告

日期：2026-10-26（Asia/Shanghai）  
工作区：`<WORKSPACE>`  
任务：把已有语音播放、告警和 ACK 链路接完整；只补闭环缺口，不重做已有 P0/预览/语音播放。  
证据目录：`competition/evidence/2026-10-26-local-alarm-voice-closure/`

标签约定：**LOCAL/BENCH** = 隔离台架或主机侧验证，不是现场验收；**REAL** = 本次真实设备 + 真实串口/真实运行日志；**UNKNOWN** = 未验证。所有历史 PID、在线数、HEALTHY 均未当作当前状态使用。

---

## 1. 结论摘要

| 项 | 结果 |
|---|---|
| 两块扬声器板当前固件 | 均已更新为包含本次告警闭环逻辑的**正式固件**（app 分区 0x10000，未全片擦除，未改 Wi-Fi/deviceId/分区表/NVS 清除） |
| 厨房（COM5 / `esp32-kitchen` / MAC `50:78:7d:16:ed:60`） | 正式固件已烧录并运行；温湿度触发→语音+蜂鸣→限频提醒→停止→恢复→再次触发、ACK、重启不重放，均在**隔离台架固件**上真实通过；正式固件正常状态 40s + 重启 26s 无异常发声，自然上报正常 |
| 卫生间（COM4 / `esp32-bath` / MAC `14:c1:9f:42:dd:b4`） | 同上；另外真实验证 SOS 注入路径、优先级、停止/ACK、无活动提醒、监护暂停与跨重启保持、重启不重放 |
| 真实 SOS 按键 + 手机/DAYU ACK 现场验收 | **尚未由用户执行**（唯一剩余用户动作，见 §9）；当前公网链路已恢复，两块板已自然上报并获 202 |
| 灯（光）告警 | **未实现**：两块 DNESP32S3 板上未确认存在可编程指示 LED；已确认只有 XL9555 P0_3 板载蜂鸣器与 P0_2 功放使能。DAYU200 有 homemon 控制的 sysfs 三色灯，属 DAYU 侧且未在本轮验证，不冒充“房间灯” |
| 燃气/烟雾报警 | 未启用（阈值 4096=禁用），本轮不启用、不声称气体浓度 |

---

## 2. 修改前确认的缺口（先查后改）

1. **温湿度越界无持续时间确认/回差**：单次有效读数越界即报警，阈值附近会反复；读取失败时 `ok=true` 掩盖状态。
2. **没有“停止本轮声音”**：只有 `ack`（转 ACKED）和 `reset`（转 NORMAL），无法只静音而保留告警状态；`stop/silence/pause/resume` 在 bridge/command-sync/homemon/APP 全链路均不存在。
3. **无持续异常限频提醒**：新告警只播一次；较长持续异常期间没有节制的重复提醒。
4. **无活动判定门槛不足**：PIR 断线/常低时可能被当成“老人无活动”；也没有“暂停监护”状态。
5. **环境危险可覆盖 SOS 告警**：`active_danger()` 不含 MANUAL_SOS，SOS 后 1 秒内出现温湿度越界会把 SOS 告警替换成低优先级 CLIMATE。
6. **ACK 后状态上报延迟**：只能等下一个 5s 周期上报；设备“收到命令”与“已停止播放”不可区分（无收到日志）。
7. **断网/重启语义未成文**：无“重启不重放”“断网本地仍告警”的明确规则与验证。

以上均已按最小改动补齐；未新建通用告警框架，未改 DAYU 正式预览/人物检测/统一启动入口，未动 D/E/APP/backend。

---

## 3. 规则与参数（可配置，演示默认，不是医疗/燃气标准）

### 3.1 状态与命令语义

| 动作 | 效果 | 与其它状态的区别 |
|---|---|---|
| 新告警 | 生成新 `alarmId`，语音+蜂鸣，`state=ALARM` | 同一危险持续期间不重复建 ID、不叠播 |
| `stop` | 停止**本轮**声音，保留 `ALARM`/`alarmId`；同一持续事件不再重复拉响 | 不等于 ACK（不改状态），也不等于异常解除 |
| `ack <id>` | 仅 `ALARM` 且 ID 精确匹配才接受：`state=ACKED`，立即静音并取消语音，**立即上报** | 不代表危险已消失；危险消失后再出现才重新武装 |
| 异常解除 | 可恢复类（NO_MOTION/CLIMATE/WATER_LEAK）自动回 `NORMAL` 并取消声音；GAS/SMOKE 保持锁存需 ACK/reset | 与 `stop`/`ack` 分开记录 |
| `pause` / `resume` | 暂停/恢复“长时间无活动”提醒，状态写 NVS，重启保持 | 只抑制无活动提醒，不抑制 SOS/环境告警；不自动反向恢复 |
| 重启 | 告警状态不持久化：上电 NORMAL，**不重放历史声音** | 采集/上报正常恢复 |

### 3.2 触发与限频参数

| 参数 | 正式值 | 台架值 | 含义 |
|---|---|---|---|
| `NODE_TEMP_LOW/HIGH_C` | 5 / 45 ℃ | 同 | 沿用既有部署阈值（非医疗标准） |
| `NODE_RH_LOW/HIGH` | 10 / 90 % | 同 | 沿用既有部署阈值 |
| `NODE_CLIMATE_CONFIRM_COUNT` | 3（1 秒/次） | 2 | 连续有效越界次数才触发；无效读数不计数 |
| `NODE_CLIMATE_CLEAR_COUNT` | 5 | 2 | 连续回到“回差带内”才解除 |
| `NODE_TEMP_HYST_C` / `NODE_RH_HYST` | 1 ℃ / 3 % | 同 | 恢复回差，避免阈值附近抖动 |
| `NODE_ALARM_REPEAT_SEC` | 300 s | 10 s | 持续异常限频重复提醒；**NO_MOTION 只提醒一次**；stop/ACK 后不再重复 |
| `NODE_NO_MOTION_SEC` | 1800 s | 20 s | “长时间未检测到活动”阈值 |
| `NODE_NO_MOTION_REQUIRE_ARM` | y | y | 本次启动后先确认过一次有效 PIR 活动才启用无活动计时（防断线常低误报） |
| `NODE_ALARM_BEEP_MS/BEEP_SEC` | 10 s | 5 s | 蜂鸣限时，告警状态保留 |
| `NODE_ALARM_BENCH_INJECT` | **n** | y | 台架注入 + UART0 命令通道，正常现场固件不含该功能 |

优先级：`MANUAL_SOS(6) > WATER_LEAK(5) > GAS(4) > SMOKE(3) > CLIMATE(2) > NO_MOTION(1)`；SOS 语音为 `sos.pcm`（clip=1），其它为 `warning.pcm`（clip=2）。SOS 播放会通过单调递增 generation 取消并抢占正在播放的低优先级音频；低优先级环境危险不能覆盖正在进行的 SOS 告警。

### 3.3 代码改动位置

- `esp32-node/main/alarm_logic.h`：新增 `climate_stab_update()`（连续确认+回差，无效读数不参与）、`alarm_repeat_due()`（限频提醒）、`no_motion_enabled()`（无活动启用门槛）。
- `esp32-node/main/node_main.c`：温湿度稳定器；`stop`/`pause`/`resume` 命令与 NVS 持久化；`CMD 收到` 日志；ACK/停止/恢复分别记录；SOS 重复抑制与停止后重新提醒；持续异常限频提醒；NO_MOTION 启用门槛；CLIMATE/NO_MOTION 自动恢复；低优先级不覆盖 SOS；台架 UART 注入通道（仅 `CONFIG_NODE_ALARM_BENCH_INJECT=y`）。
- `esp32-node/main/Kconfig.projbuild` + `profiles/alarm-closure.sdkconfig.defaults` / `profiles/alarm-bench.sdkconfig.defaults`：上述参数与台架开关。
- 卫生间私有源码树 `.local/bathroom-voice-20261026/src/` 同步同一逻辑；保留其既有 ES8388 满幅 PCM 播放改动与音量 30（寄存器值，0 dB），主树厨房保持 PCM /2 与音量 20 不变。
- 未修改：`local_voice.c`（两棵树保持各自既有增益策略）、bridge、command-sync、homemon、DAYU、APP、D/E、backend。
- 文件级 before/after SHA-256 见 `CHANGES.md`；构建/烧录记录见 `build/`。

---

## 4. 每块板实际结果

### 4.1 厨房 `esp32-kitchen`（COM5）

- 身份/版本核对（写入前只读）：ESP32-S3 rev v0.2，MAC `50:78:7d:16:ed:60`；当前 app 分区 SHA-256 = `A76224A4…DBC11`，与既有部署记录完全一致 → 确认是厨房语音 v20 板后才写入。私有备份：`.local/local-alarm-20261026/device-backup/COM5-app-before-20261026-162257.bin`（不在公开交付目录）。
- 正式固件 `kitchen-prod`：942,624 B，SHA-256 `063A22C3CFA2DF24C3981AE5F8D4857B237A5D0F65DDF9C8A097C48DE7C27155`；仅写 0x10000，esptool 报 `Hash of data verified`。
- 正式固件运行验证（REAL）：正常状态 40s 串口采样，`state=NORMAL`、`alarm` 为空、温湿度有效（约 23.7℃/64.4%）、MQ2/MQ5 原始 ADC 有效，**无任何 PLAY 发声**；RTS 复位后 26s 内完整启动、不重放历史声音、恢复采集与 WiFi 重连（IP 10.127.130.168），随后公网自然 202。
- 台架固件（BENCH，仅隔离验收）真实通过：温湿度触发（clip=2）、10s 限频重复、stop 后不再重复、异常解除回 NORMAL、再次越界形成新告警（新 ID）、ACK 接受并立即 ACKED、重启不重放。**播放中 1.2s 下发 stop 实测 `cancelled=1`（确认实际中断播放，非仅状态变化）**；该测试后立即刷回正式固件并以 `kitchen-11-final-production-restart` 复核：无 `BENCH INJECT` 标记、无 PLAY、NORMAL、重连 202。详见 §5 与 `verify/SCENARIO-MATRIX.md`。
- 厨房无 PIR、无 SOS 按键（配置 `-1`），因此无活动/SOS 不作为厨房能力声称；台架里的 `inj sos` 只用于验证音频抢占与优先级逻辑。

### 4.2 卫生间 `esp32-bath`（COM4）

- 身份/版本核对（写入前只读）：ESP32-S3 rev v0.2，MAC `14:c1:9f:42:dd:b4`；当前 app 分区 SHA-256 = `93C9A7A2…A11C`，与既有部署记录完全一致。私有备份：`.local/local-alarm-20261026/device-backup/COM4-app-before-20261026-162230.bin`。
- 正式固件 `bath-prod`：936,000 B，SHA-256 `3DF807863F22CE5E93CAC4D8125BBE9998B822F67C37B462D2E25A7DDCC6E24A`；仅写 0x10000，`Hash of data verified`；音量 30（满幅 PCM，维持用户此前确认的听感参数）。
- 正式固件运行验证（REAL）：正常状态 40s 采样，`state=NORMAL`、PIR 实时计数增长、温湿度有效（25.2℃/60.6%）、无发声；RTS 复位 26s 完整启动，日志显示 `监护暂停状态(持久化)=ACTIVE`、`READY … no boot alarm`，**无重放**，恢复采集并重连（IP 10.127.130.71）。
- 台架固件（BENCH）真实通过：SOS 触发/重复抑制/停止/停止后重新提醒/ACK 后再次 SOS 新告警；温湿度闭环；多告警优先级（SOS 抢占并压制环境告警，ACK 后环境告警再升级）；长时间无活动提醒（20s 测试参数）+活动恢复+再次提醒；暂停监护抑制提醒、恢复后补报；暂停状态跨重启保持；重启不重放。
- 现场观察（非注入）：18:28:22 台架空闲期记录到一次 **GPIO15 物理 SOS 电平事件**（`e-127-3`，非本次注入）。无法判断是用户按下还是 SOS 引脚悬空/噪声，**必须在真实 SOS 验收时确认实体按键接线与误触风险**（见 §8/§9）。

---

## 5. 场景验证矩阵（真实设备，详见 `verify/`）

台架固件通过 UART0 注入（明确隔离、无云端事件），每块板的实际声音由 ES8388 扬声器 + XL9555 蜂鸣器真实播放。`clip=1`=SOS 语音，`clip=2`=告警语音。

| 场景 | 厨房（台架） | 卫生间（台架） |
|---|---|---|
| 正常状态不误响、采集正常 | PASS：40s 正式固件无 PLAY，JSON 正常 | PASS：40s 正式固件无 PLAY，PIR/温湿度正常 |
| 温湿度异常持续确认→语音 | PASS：2 次有效越界后 `PLAY clip=2`，`state=ALARM` | PASS（同） |
| 持续异常限频 | PASS：10s 间隔重复 1 次（`持续异常限频提醒`），非每秒 | PASS（同） |
| 用户停止（stop） | PASS：`STOP 已接受`，保留 ALARM，之后无重复；播放中 1.2s 下发 stop 时语音任务记录 `STOP result=ESP_OK cancelled=1`（**确认实际中断播放**） | PASS（同） |
| 停止后同事件不立即拉响 | PASS：停止后持续越界数据未再播放 | PASS（同） |
| 恢复（回差+确认） | PASS：`异常解除 -> NORMAL` 并取消声音 | PASS（同） |
| 解除后再次异常 | PASS：新 `alarmId` + 再次 `PLAY clip=2` | PASS（同） |
| APP ACK（命令精确 ID） | PASS：`ACK 已接受并生效 → ACKED` 立即上报 | PASS（同） |
| SOS 触发/优先播放 | BENCH-ONLY（无 SOS 硬件）：`inj sos` 抢占为 `clip=1` | PASS：SOS → `PLAY clip=1`，重复 SOS 不叠播、不新建 ID |
| 多告警同时出现 | BENCH-ONLY：SOS 覆盖 CLIMATE，且 ACK 后 CLIMATE 升级为新告警 | PASS：同上，单次播放无重叠 |
| 长时间无活动 | 不适用（无 PIR） | PASS：20s 未检测到活动 → 提醒；活动恢复 → NORMAL；再次无活动 → 新告警 |
| 无数据/无效不误判 | PASS：注入 `invalid` 不触发、不清除告警 | PASS（同）；无 PIR 数据不启用无活动 |
| 暂停监护 | 不适用 | PASS：暂停期间不触发；恢复后补报；暂停状态跨重启保持 |
| 重启 | PASS：告警进行中重启 → 启动无声音、NORMAL、采集恢复 | PASS（同） |
| 断网 | 台架固件本身无 WiFi/云端（隔离链路），本地告警与声音独立于网络 | PASS（同上）；正式固件期间观察到旧固件 WiFi `reason=201`（AP 不在）时本地采集/判定继续运行 |

记录文件：`verify/kitchen-0*.log`、`verify/bath-0*.log`；摘要见 `verify/SCENARIO-MATRIX.md`。

---

## 6. 构建 / 固件身份 / 写板记录

| 产物 | 用途 | 大小(B) | SHA-256 | 证据 |
|---|---|---|---|---|
| `kitchen-prod` | 厨房正式固件（已部署） | 942,624 | `063A22C3…C27155` | `build/build-final2-kitchen-prod.log`、`build/flash3-kitchen-prod.json` |
| `kitchen-bench` | 厨房台架固件（测试用，已被正式固件覆盖） | 473,072 | `B587982B…369B250` | `build/build-final2-kitchen-bench.log`、`build/flash2-kitchen-bench.json` |
| `bath-prod` | 卫生间正式固件（已部署） | 936,000 | `3DF80786…CC6E24A` | `build/build-final2-bath-prod.log`、`build/flash3-bath-prod.json` |
| `bath-bench` | 卫生间台架固件（测试用，已被正式固件覆盖） | 464,048 | `5268C90B…39BE7B1` | `build/build-final2-bath-bench.log`、`build/flash2-bath-bench.json` |

- 完整 SHA-256 见各 JSON/日志与 `SHA256SUMS.txt`；私有 bin 与全片/应用备份留在 `competition/esp32-node/.local/`（含网络配置，**不进入公开交付目录**）。
- 配置核对：厨房 `deviceId=esp32-kitchen/room=厨房/MQ2=ADC1_CH5/MQ5=ADC1_CH6(GPIO7)/voice vol=20/PIR=-1/SOS=-1`；卫生间 `esp32-bath/卫生间/PIR=36/SOS=15/AHT20 I2C1 4-5/voice vol=30/MQ=-1`；正式固件 `BENCH_INJECT=n`、`REPEAT=300`、`GW_PORT=9101`。
- 写板均为 app 分区（0x10000）单分区写入：先按 MAC 复核身份，再 `write_flash`，esptool 报 hash verified；未执行 `erase_flash`，未写 bootloader/NVS/分区表，未改 Wi-Fi/deviceId。
- 主机侧测试：`alarm_logic` PASS=85/0、`bathroom_logic` PASS=54/0、房间/语音接线回归 4/4（见 `verify/host-tests.log`）；台架工具自检 47/47（`tools/selftest-output.txt`）。

---

## 7. 分类结论

### 已本地实现并验证
- 温湿度连续确认+回差、停止本轮声音、ACK 精确 ID 闭环与立即上报、持续异常限频提醒、SOS 重复抑制/停止后重提醒/优先级保护、可恢复类自动恢复、无活动启用门槛、暂停监护 NVS 持久化、重启不重放、音频非阻塞。
- 主机侧 85+54 项断言、房间/接线回归、台架工具 47/47 自检。

### 已更新到哪块真实板并验收
- **两块板均已烧录正式固件**（厨房 `063A22C3…`、卫生间 `3DF80786…`），并完成：正常态无发声、自然上报恢复、真实重启不重放。
- 上述闭环场景在**两块板各自的隔离台架固件**上真实通过（同一份源码，仅配置差异）。

### 仅隔离模拟通过
- 温湿度越界值与恢复值由台架注入（未用真实高低温/高湿，未做危险测试）；SOS 注入为台架事件（厨房无 SOS 硬件，卫生间实体按键未由我们按动）。
- 限频提醒的正式 300s 间隔未实等（台架用 10s 验证机制）。
- 断网/恢复：新固件未在真断网下长时间跑（AP 恢复后才烧正式固件）；台架固件本身无网络，验证的是“无网络仍本地告警/不重放”。

### 尚未完成的真实链路
1. **真实 SOS 按键 → 语音 → 手机 APP/DAYU ACK → 设备 ACKED 回执**：需用户主动按一次实体 SOS 并在 APP/DAYU 点确认（§9）。
2. **`stop`/`pause` 的云端/APP 可达路径**：ESP32 已支持，但 bridge 下行白名单没有 `stop/pause/resume`，DAYU/APP 也没有对应按钮；当前只能通过同板 `route <dev> stop`（DAYU 若发）或隔离串口触发。未改 bridge/APP（会需重启在线 bridge / 重装 APP，超出本轮）。
3. **灯光告警**：未确认两块 ESP32 板有可编程 LED。
4. **真实温湿度越界与真实长时间无活动（30 分钟档）**：未做危险/耗时测试。
5. 公网 backend 偶发 `ENOTFOUND`/超时期间的 ACK 时延（历史观察），本轮未再复现。

### 现场当前未知
- 卫生间 SOS 按键是否物理接线可靠：18:28:22 出现一次**非注入的 SOS 触发**（`e-127-3`），无法区分用户按下与引脚悬空/噪声。
- 用户手机 APP 当前是否在线、是否已安装最新候选、能否实时看到并 ACK 新告警。
- 演示热点/网关的长期稳定性；旧 PID/在线数/HEALTHY 不可作为依据（本次已按实时连接与自然 202 复核）。
- DAYU 三色灯是否在当次部署生效（未核对）。
- 燃气/烟雾报警阈值未启用（设计如此）。

---

## 8. 明确限制

- PIR“长时间未检测到活动”只表示未观测到触发，**不等于**昏迷、跌倒或无人；本轮未启用跌倒判断。
- 温湿度阈值为演示/项目既有配置，**不是医疗、消防或燃气安全标准**；未做真实高温高湿危险测试。
- MQ-2/MQ-5 仍为原始 ADC，报警阈值 4096=禁用，不把原始值当 ppm/浓度。
- 声光中的“光”缺硬件；仅有语音+蜂鸣。
- 台架注入固件不会出现在现场：两块板最终运行的是 `BENCH_INJECT=n` 正式固件。

---

## 9. 需要用户完成的最少验收步骤（约 1 分钟）

当前两块板已在线、自然 202；只需你主动做两步（AI 不能代替）：

1. 按一下**卫生间实体 SOS 按键**。预期：卫生间扬声器播报 SOS 语音、板载蜂鸣器响；DAYU 页/APP 出现新的 `MANUAL_SOS` 告警（`state=ALARM`），串口日志出现 `SOS 按键 -> ALARM（e-…）`。
2. 在 **DAYU 正式页面或手机 APP 点“确认/ACK”**。预期：设备串口出现 `ACK 已接受并生效 … state=ACKED，语音已取消`；5 秒内 bridge/云端看到 `state=ACKED` 且 `alarm.id` 与 APP 上一致；`public-sync-supervisor.log` 出现该设备 202 与 `ACKED` 回执。若 ACK 失败/超时，请把 APP 提示和大致时间告诉我，我按日志继续定位（不需要重刷）。

可选：若想先确认误触风险，请顺便检查卫生间 GPIO15 按键是否确实接好（当前唯一一次非注入 SOS 来源不明）。

回滚（如需）：用私有备份恢复原应用分区，例如
`python -m esptool --port COM4 --baud 460800 write_flash 0x10000 .local\local-alarm-20261026\device-backup\COM4-app-before-20261026-162230.bin`
（厨房用 `COM5-…` 对应文件；均为原部署镜像，已核对哈希）。
