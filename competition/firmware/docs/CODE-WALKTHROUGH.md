# ESP32-S3 节点固件代码讲解

这份文档面向第一次接手 `elder_node` 的人。说明的是 `firmware/common/components/elder_node/` 下的真实行为；三个节点工程里的 `main/` 只是同步后的副本。

## 0. 先看三件事

1. 节点自己不跑 MQTT。它把状态拼成一行 JSON，经 TCP 发给 PC 上的 `bridge/mqtt_bridge.js`，由桥接程序转 MQTT。
2. 告警判定、门磁消抖、电池换算、定向播报去重都做成了纯函数或独立模块；`node_main.c` 负责 I/O 和状态变量。
3. 只有一个主任务改告警状态，也只有一个任务碰网关 socket。其他任务只做 I2S 播放、录音上传或串口收行。

## 1. 模块分工

| 文件 | 主要函数 | 说明 |
|---|---|---|
| `node_main.c` | `app_main`、`sample`、`judge`、`report`、`handle_command` | 启动、主循环、采样、状态机、上报、命令 |
| `board_io.c` | `board_gpio_start`、`board_i2c_start`、`board_buzzer`、`board_key0_poll` | XL9555、蜂鸣器、KEY0/KEY1、数字输入 |
| `wifi_link.c` | `wifi_start`、`wifi_connected`、`wifi_time_sync_start` | Wi-Fi 连接和 SNTP |
| `gw_link.c` | `gw_send`、`gw_poll`、`gateway_task`、`serial_command_task` | TCP 行协议、网关任务、串口命令 |
| `climate.c` | `climate_bus_start`、`climate_read` | AHT20 或 DHT11 |
| `door_monitor.c` | `door_monitor_start`、`door_monitor_poll`、`door_report_json` | 门磁采样、事件 FIFO、NVS seq、JSON |
| `announce.c` | `announce_start`、`announce_tick`、`announce_cancel` | 短提示音结束后再播语音 |
| `local_voice.c` | `local_voice_start`、`local_voice_play` | ES8388/I2S 播放与录音 |
| `mic_link.c` | `mic_link_start`、`mic_link_trigger` | 板载咪头 PCM 上传到 9303 |
| `speaker_link.c` | `speaker_link_start` | 从 9102 收 PCM 播放 |
| `local_led.c` | `local_led_start`、`local_led_tick` | 告警灯效 |
| `alarm_logic.h` | `alarm_raise_allowed`、`door_update`、`no_motion_enabled` | 告警/门磁纯逻辑 |
| `notice_logic.h` | `notice_begin` | 跨房间播报去重 |
| `battery_logic.c` | `battery_evaluate` | 中位数、极差、一致率、分压和校准 |

`voice_pins.h` 只在语音构建里做引脚冲突检查：只要有传感器或 ADC 落在 I2S 使用的 GPIO3/9/10/14/46 上，就直接编译失败。

## 2. 启动和主循环

`app_main()` 先初始化 NVS，读一次随机盐，恢复“监护暂停”状态，然后按下面的顺序拉起外设：

```c
board_gpio_start();      /* PIR / SOS / 水漏 / 外部蜂鸣器 */
door_monitor_start();    /* 门磁 GPIO、NVS 缓存 */
local_led_start();
board_i2c_start();       /* I2C0: XL9555、蜂鸣器、KEY0 */
climate_bus_start();     /* I2C1: AHT20，或配置 DHT11 */
adc_start();             /* ADC1 oneshot，MQ 和电池共用单元 */
local_voice_start();
gw_set_command_handler(handle_command);
```

之后做可选的蜂鸣器/温湿度自检，再按配置进入台架模式或正常网络模式。

主循环在 `run_loop()` 里，100 ms 一拍：

- 每拍轮询 SOS（`sos_handle_fast`），语音构建还要读 KEY1（`board_ai_key_tick`）。
- 每 10 拍（约 1 秒）执行一次 `sample()` 和 `judge()`。
- 每拍推进 `alarm_reminder_tick()`、`local_led_tick()` 和语音编排。
- 语音构建每拍最多从命令队列取 4 条执行；非语音构建直接 `gw_poll()`。
- 每 `CONFIG_NODE_REPORT_SEC * 10` 拍发一次 `report()`。

没有单独的“传感器任务”。这么做的好处是状态只在一个任务里变，坏处是任何阻塞调用都会拖慢 SOS 响应，所以网络连接、语音播放都放到别的任务里。

### 台架模式

`CONFIG_NODE_ALARM_BENCH_INJECT` 打开后不连 Wi-Fi，只建命令队列和 UART 任务，用串口注入传感器值。它依赖语音构建里的 `command_message_t`，所以配置层面写了 `#error`，不允许“台架打开、语音关闭”的组合。

`CONFIG_NODE_LOCAL_BENCH` 更简单：只打印 PIR/SOS 原始电平，连命令队列都不建。

## 3. 上报协议

`report()` 拼一行 JSON，末尾带 `\n`。字段顺序固定：

```text
deviceId, room, ts, state,
sensors.motion{lastActiveTs,countToday}, door, climate, gas, smoke, water?,
history[7], slots[4],
alarm{id,type,countToday}, battery?
```

几个容易看错的地方：

- `ts` 是 13 位毫秒。时间没同步时发 0，下游要把它当“未知”，不能当 1970 年。
- `lastActiveTs` 会换算到服务器时间轴：`ts - (now - s_last_motion_ms)`；时间没同步时也是 0。
- `countToday` 实际是“本次上电以来的活动次数”，不按自然日清零。
- `gas` 对应 MQ-5，`smoke` 对应 MQ-2，命名确实有点反直觉。
- `door` 段永远由 `door_report_json()` 生成。装了门磁时带 `open/lastOpenTs/lastCloseTs/seq/events`；没装时仍输出旧的 `{"open":false,"lastOpenTs":0}`。
- `water` 和 `battery` 只有对应外设在编译期启用时才出现，不会为了字段完整而编造读数。
- `history` 前 6 位恒为 0，最后一位复用活动次数；`slots` 全是 0，属于历史占位。
- `alarm.id/type` 只在 ALARM 或 ACKED 时有值，NORMAL 上报时是空串；`alarm.countToday` 也只是 0/1。

`REPORT_JSON_MAX` 是 1600。`snprintf` 返回值超过缓冲区时整条丢弃并打错误日志，不会把半条 JSON 发出去。`gw_link.c` 里的同名常量要跟它保持一致。

SOS、ACK、stop、pause/resume、reset 这些事件会额外立刻调用 `report()`，所以除了 5 秒心跳，还会看到事件触发的即时上报。

## 4. 告警状态机

内部只有三个状态：`NORMAL(0)`、`ALARM(2)`、`ACKED(3)`。`state_name()` 里虽然有 `WARN`，但代码从来没有把状态设成 1，APP 不会收到 WARN。

`active_danger()` 按固定顺序返回当前最高危险：

```text
GAS > SMOKE > WATER_LEAK > CLIMATE > NO_MOTION > NULL
```

`judge()` 的规则：

| 当前状态 | 条件 | 结果 |
|---|---|---|
| NORMAL / ALARM | 有危险 | 新建 alarmId，进入 ALARM，开始提示音和语音 |
| ALARM | 同一危险持续 | 不新建 ID |
| ALARM | 出现更高优先级危险 | 升级成新告警，新 ID |
| ALARM | 危险消失且类型可恢复 | 回 NORMAL，取消声音 |
| ALARM | ACK 且 ID 匹配 | 进 ACKED，静音但保留 id/type |
| ACKED | 同种危险仍在 | 保持 ACKED，不响也不建 ID |
| ACKED | 该危险先消失再出现 | 重新武装后再报 |
| ACKED | 另一种危险 | 直接新告警，不被之前的 ACK 屏蔽 |

可自动恢复的类型是 `NO_MOTION`、`CLIMATE`、`WATER_LEAK`。`GAS` 和 `SMOKE` 必须 ACK 或 reset 才回 NORMAL，这是刻意的锁存语义。

同一危险持续期间不会重复新建 ID。SOS 长按只触发一次；如果用户 stop 了声音，再按一次会恢复提醒，但仍复用原来的 alarmId。

### ACK 和 ID

告警 ID 在时间已同步时是 `e-<epoch_s>-<seq>`，没同步时是 `e-u<boot_salt>-<seq>`。随机盐来自 `esp_random()`，保证重启后不会和上一次撞号。

ACK 只接受 `ack <alarmId>`，而且必须和当前 `s_alarm_id` 完全相同。旧 ID、没有活动告警、重复 ACK 都会被拒绝并打日志。ID 后面的处置说明只用于日志，不参与匹配。

### 重复提醒

危险一直在、没人 ACK 或 stop 时，`alarm_reminder_tick()` 按 `NODE_ALARM_REPEAT_SEC` 再提醒一次。`NO_MOTION` 例外，只提醒一次，避免夜里无人活动时反复吵。

`stop` 只停当前这一轮声音，状态仍是 ALARM；`pause` 只抑制 `NO_MOTION`，不影响 SOS 和环境告警；`reset` 回 NORMAL，但不会清掉“监护暂停”。

### 已知的小毛病

- `active_danger()` 的顺序是 GAS > SMOKE > WATER_LEAK，但 `danger_priority()` 给的是 WATER_LEAK(5) > GAS(4)。同时漏水和燃气时，对外显示 GAS；如果当前已经在报 WATER_LEAK，GAS 又不会升级。改优先级时这两处要一起改。
- `stop` 会检查后面的分隔符，`reset` 只做了 `strncmp(line, "reset", 5)`，所以 `resetXYZ` 也会被当成 reset。改命令解析时记得补上边界检查。

## 5. 门磁

门磁逻辑在 `door_monitor.c`，判定核心仍是 `alarm_logic.h` 的 `door_update()`。

- 连续 `NODE_DOOR_CONFIRM_COUNT` 次电平一致才确认翻转。
- 上电第一次稳定读数只建立基线，不生成“刚开门/刚关门”事件。
- 基线建立前 `open` 上报为 `null`，不能默认成 `false`。
- 时间没同步时事件 `ts` 记 0，由服务器按接收时间补。
- 每次翻转生成单调递增的 `seq`，存 NVS。后端按 `(deviceId, seq)` 幂等去重，所以重启后重传同一批事件不会重复记账。
- 事件放在环形 FIFO 里，默认 8 条，满了覆盖最旧；超过 `KEEP_SEC`（默认 300 秒）后清理。
- 事件送达后不会主动从 FIFO 删除，只靠过期。因此 5 秒心跳会在保留窗口内反复带同一批 `events[]`，后端必须靠 seq 幂等。这是现有设计，不是漏删。

`door_report_json()` 在没启用门磁的构建里也会输出兼容字段，所以 `report()` 不需要再写条件分支。

## 6. 跨房间定向播报

厨房的求助事件由 bridge 逐台投递给 `--sos-targets` 里的设备，命令是 `notice <alarmId> <sourceDeviceId>`。

本板收到后只做三件事：检查 ID 格式和白名单、通过 `notice_begin()` 去重、播放 `VOICE_CLIP_REMOTE_SOS`。它不会改本地 `s_state`、`s_alarm_id`、`s_alarm_type`，也不会 `report()`，所以 APP 上不会凭空多出一条本房间的求助。

本地告警优先级更高：`s_state==2` 时拒绝外部播报；本地告警启动时 `notice_yield_local()` 会记下被打断的外部 ID，之后不重放。`noticeack <alarmId>` 只停止对应播报，不动本地告警。

去重分两层：`active_id` 是正在播的，`last_id` 是播完/被抢占/已确认的。重复投递返回 `DUP_ACTIVE` 或 `DUP_DONE`。

提示音声数用来区分来源：本地 SOS 3 声，外部求助 5 声（`CHIRP_COUNT_SOS + 2`），普通告警 2 声。素材复用同一个 `sos.adpcm`。

## 7. 命令通道

节点只认下面这些命令，入口是 `handle_command()`：

| 命令 | 行为 | 注意 |
|---|---|---|
| `ack <alarmId> [说明]` | ID 匹配时进 ACKED、静音、立即上报 | 旧 ID 或无告警一律拒绝 |
| `noticeack <alarmId>` | 停止对应的外部播报 | 不改本地告警 |
| `notice <alarmId> <srcId>` | 播放外部求助 | ID/来源限 `[A-Za-z0-9._-]{1,32}` |
| `stop` | 停本轮声音，保持 ALARM | 不等于 ACK |
| `pause` / `resume` | 暂停/恢复监护，写 NVS | 只影响 NO_MOTION |
| `reset` | 回 NORMAL，清告警和播报状态 | 不清监护暂停 |
| `inj ...` | 台架注入 | 只有 BENCH_INJECT 构建才有 |
| 其它 | 打“未知命令”并忽略 | 默认拒绝 |

命令来源有两个：网关 TCP 和 UART0。两边都只是把整行交给 `handle_command()`，避免在两个任务里同时改状态。语音构建通过队列交给主任务；非语音构建在 `gw_poll()` 里直接调用注册的处理函数。

收行的限制：命令按 `\n` 切分，接收缓冲 1024 B，超长时不追加；命令队列 4 条，满了丢弃并打日志；主循环每拍最多取 4 条，防止下行洪泛饿死采集。

`route`、`relay`、`DATE`、`TIME` 都不在节点固件里。节点收到只会当未知命令忽略。校时靠 SNTP（`ntp.aliyun.com` / `cn.pool.ntp.org`），不靠命令。

## 8. 语音与提示音

### 片段

| clip | 用途 |
|---|---|
| 1 | 本地 SOS |
| 2 / 3 / 4 | 温度 / 湿度 / 两者都异常 |
| 5 | 长时间无活动 |
| 6 | 温湿度异常但原因不明时的兜底 |
| 7 | 外部求助，复用 clip 1 的素材 |

音频格式是 IMA ADPCM 4 bit、16 kHz，解码在 `adpcm_ima.h`。素材编译进固件，不占文件系统。

### 提示音和语音的时序

`announce_start()` 先算声数和时间，立刻响第一声；之后 `announce_tick()` 在 100 ms 主循环里推进。只有提示音全部结束、且到了 `VOICE_GAP_MS` 之后才调用 `local_voice_play()`。这样人声不会被蜂鸣器盖住。

`announce_cancel()` 在 stop、ACK、危险解除时同时停蜂鸣、清播报状态、取消本地语音。

### ES8388 功放

功放使能是 XL9555 的 P0_2，低有效。打开后要等 `NODE_VOICE_AMP_SETTLE_MS`（默认 60 ms）再送 I2S 数据，否则开头会被截掉或出现爆音。播放结束先排空 DMA，再关 I2S 和功放，待机时不放底噪。

### 板载咪头

只有告警窗口或串口 `mictest` / `micupload` 时才启用录音，不做常开监听。录音结束后重装 I2S TX，恢复扬声器通路。上传目标是网关 9303；AI 问答走 9302，音箱播放走 9102，三条链路互不阻塞。

## 9. 网络

### Wi-Fi

`wifi_link.c` 用事件组记录连接状态。断开后立即 `esp_wifi_connect()`，没有自己写指数退避，节奏交给 IDF。PMF 显式关闭，兼容手机热点。`wifi_connected()` 对事件组为空做了保护，任务启动早期调用不会崩。

### 网关 TCP

- 语音构建：`gateway_task` 独占 socket，负责 DNS、连接、收命令、发上报。上报队列长度 1，用 `xQueueOverwrite`，只保留最新状态；断网期间本地采集和告警不受影响，恢复后补最新一条，不是补事件日志。
- 非语音构建：主循环自己等 Wi-Fi、`gw_ensure_connected()`，然后 `gw_poll()` 收命令，`gw_send()` 直接写 socket。
- 发送失败只关连接，不把半条报文拼到下一条连接上。整条写完才增加 `gw_sent_count()`，这个计数只表示“写到了 bridge”，不代表云端入库。
- 网关断开后，语音任务等 1 秒重连；非语音主循环等 3 秒。Wi-Fi 没连上时先关 socket 再等 200 ms。

### 串口

`serial_command_task` 用 UART0 115200 8N1 逐行读。正式固件里任务名是 `serial-cmd`，台架模式是 `bench-uart`，方便看任务列表时区分。

## 10. 电池

只有 `NODE_BATTERY_ADC_CHANNEL >= 0` 才编译电池逻辑。固定供电的节点保持 -1，上报里没有 `battery` 段。

采样链路：raw → 引脚电压 → 乘分压比 → 加校准增益/偏移 → 电池电压。主任务里每 `NODE_BATTERY_SAMPLE_SEC` 采 8 次，间隔 2 ms，取中位数。下面三条任一不满足就判无效：

- 极差超过 300 mV；
- 中位数 ±150 mV 内的样本不足 5 个；
- 中位数不在 `MIN_MV..MAX_MV`。

无效时 `valid=false`，`mv/percent` 输出 null，并带 `reason`（`NO_ADC`、`UNSTABLE`、`OUT_OF_RANGE` 等）。0 raw 不会变成有效读数。

`percent` 只在 `NODE_BATTERY_CALIBRATED=y` 时计算；没做过两点校准就保持 null，避免把估算值当成精确电量。

编译期检查有两条：ADC 通道只能 0..9（ADC2 开 Wi-Fi 后不可用），并且不能和 MQ-2/MQ-5 共用通道，`MIN_MV` 不能大于 `MAX_MV`。Kconfig 的 bool 在 `=n` 时不生成宏，所以 `NODE_BATTERY_CALIBRATED` 在代码里被折成 0/1 使用。

## 11. 改代码时容易漏的地方

### 加一个传感器

以水漏为模板：

1. Kconfig 加 `NODE_XXX_GPIO`，默认 -1。
2. `alarm_logic.h` 加消抖结构和更新函数。
3. `board_gpio_start()` 配引脚；需要 ADC/I2C 就在对应模块初始化。
4. `sample()` 读值并更新状态。
5. `active_danger()` 加分支，同时在 `danger_priority()` 和 `judge()` 的 `recoverable` 列表登记。
6. `report()` 加 JSON 段，注意 1600 B 上限。
7. `voice_clip_for_alarm()` 给新告警类型配文案，不要拿温湿度文案冒充。
8. 补主机测试，覆盖无效读数、回差和重复触发。

### 改阈值

只改 Kconfig 和节点 `sdkconfig.defaults`。温湿度阈值同时被 `sample()` 和 `voice_clip_for_alarm()` 使用；MQ 的 4096 是“禁用”哨兵，不是普通阈值。

### 改引脚

先过 `voice_pins.h`。最典型的冲突是 MQ-5 原来在 GPIO9/ADC1_CH8，而 GPIO9 是 I2S LRCK；语音版必须把线改到 GPIO7/ADC1_CH6。编译期的 `#error` 只能拦配置，拦不住“代码改了、实物线没动”。

另外两个没有编译期检查的冲突：

- 电池 ADC 的 CH0 是 GPIO1，而告警 LED 默认也用 GPIO1。
- 门磁当前配置是 GPIO37，历史接线文档写的是 IO2，烧录前要按实物核对。

## 12. 读代码路线

1. `app_main()` → `run_loop()`：启动顺序、自检、台架/网络分支和 100 ms 主循环骨架。
2. `sample()` → `judge()` → `active_danger()`：采集怎么变成状态。
3. `alarm_logic.h`：`alarm_raise_allowed()`、`door_update()`、`no_motion_enabled()`。
4. `report()` 和 `door_report_json()`：状态怎么变成 JSON。
5. `gw_send()`、`gateway_task()`、`gw_poll()`：报文怎么出去、命令怎么进来。
6. `announce_start()` / `announce_tick()` / `local_voice.c`：声音怎么响。
7. `handle_command()` 和 `notice_logic.h`：命令和跨房间播报。

`node_main.c` 里没有复杂算法：要不要报警、门磁怎么消抖、电池怎么判有效，都在独立模块里；`node_main.c` 负责把状态变量和 I/O 串起来。
