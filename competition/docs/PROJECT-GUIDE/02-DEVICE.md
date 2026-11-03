# 02 · 设备端（ESP32-S3 节点固件 + 板端 homemon）

> 覆盖：`firmware/common/components/elder_node/`（三块 ESP32-S3 节点共用的唯一固件源码）、
> `firmware/{kitchen,bathroom,living}/sdkconfig.defaults`（机型差异）、
> `southbound/src/homemon.c`（DAYU200 板端守护进程）。
> 写作口径：每个结论都带 `路径:行号`；区分「已实测 / 已实现未实测 / 未实现」；不贴长代码。
> 逐模块的"教学式"讲解**不再重复**，统一引用 `firmware/docs/CODE-WALKTHROUGH.md`（下称 **WT**）：
> 本文只写**工程视角**——为什么这样设计、用了哪些 ESP-IDF/RTOS/POSIX 能力、资源与时序约束、
> 踩过什么坑、还能怎么改。穿戴固件只做小结（见 §2.4）。

## 1. 本层职责与边界

设备端由三块**异构执行体**组成，职责切得很开（切得开是故意的，见 §5.1）：

| 执行体 | 位置 | 负责 | **明确不负责** |
|---|---|---|---|
| ESP32-S3 房间节点 | `firmware/common/components/elder_node/` | 采集（PIR/门磁/温湿度/MQ-2/MQ-5/水漏）、本地判定、本地声光+离线语音、把状态按 JSON 行推给 PC 网关 | 不实现 MQTT（`node_main.c:7-13`）；不做跌倒检测（视觉层）；不做身份鉴别/TLS（`docs/ARCHITECTURE.md:155`）；不是 NTP 服务端，只是 SNTP 客户端（`node_main.c:613-620`）；不解析 `DATE`/`TIME` 命令（落进 `node_main.c:1366-1368` 的"未知命令"分支） |
| DAYU200 板端 homemon | `southbound/src/homemon.c` | 本机 GPIO/I2C/SARADC 采集、阈值判定与状态机、三色灯/蜂鸣器/语音触发、状态行 stdout+`status.json`+TCP:9000 广播、`route`/`relay` 命令路由、ACK 闭环与 `safety.log` | **不碰摄像头**（`docs/ARCHITECTURE.md:28-29`），只接受视觉侧受限的 `fall <evidenceId>` 命令（`homemon.c:600-634`）；不合成语音、不直接操作音频通路（`homemon.c:287-295` 只 `system(say_cmd)`）；不实现 MQTT/HTTPS（属桥接与云层） |
| ESP32 穿戴求助 | `esp32-node-wearable/` | 单键 SOS + 蜂鸣 + 4G DTU 透传，未确认每 10s 重发同一 alarmId | 不启用 Wi-Fi/蓝牙，网络只走 M100 透传；无 RTC 不伪造墙钟——细节见 `esp32-node-wearable/README.md`（本文不展开） |

三条硬边界，读代码前先记住：

1. **协议边界**：节点的输出不是"给云看的"，而是**给板端 homemon 看的同构 JSON 行**——字段与 homemon 上报逐字段对齐
   （`node_main.c:12-14`、`node_main.c:1877-1898`），所以桥接/APP 零改动即可识别新房间。
2. **安全边界**：局域网设备链路无认证、无加密、无签名（`docs/ARCHITECTURE.md:149-155`）；
   设备端所有"防伪造"都靠**格式白名单 + ID 精确匹配**（如 `notice_logic.h:53-66`、`node_main.c:1209-1216`），
   不是密码学。
3. **证据边界**：厨房/卫生间节点**已上板运行**、三节点固件**构建成功**（`firmware/docs/BUILD-VERIFY.md:9-16`）；
   客厅是候选板**未部署**（`firmware/living/sdkconfig.defaults:3`）；水漏、电池采样、穿戴端到端均**未验收**。

## 2. 代码地图

### 2.1 ESP32-S3 节点（唯一的固件真源）

行数为当前磁盘文件实际行数（`LF` 计数），`node_main.c` 2169 行里约 1/4 是注释。

| 文件 | 行 | 职责 | 关键函数 / 结构体（行号） |
|---|---:|---|---|
| `node_main.c` | 2169 | `app_main` + 采集/判定编排 + 上报 + 命令 + NVS + 电池/门磁 | `app_main :1986`、`sample :1494`、`judge :1745`、`active_danger :1692`、`raise_alarm :1642`、`report :1819`、`gw_send :1054`、`gateway_task :1410`、`gw_poll :1371`、`handle_command :1195`、`battery_sample :378`、`door_state_save :531`、`announce_start :971` |
| `alarm_logic.h` | 460 | **纯逻辑**：MQ/水漏/温湿度连续确认+回差、PIR/SOS/门磁消抖、告警状态机、告警 ID、限频 | `mq_stab_update :34`、`alarm_raise_allowed :84`、`danger_priority :136`、`pir_update :163`、`sos_update :193`、`alarm_id_build :235`、`door_update :307`、`climate_stab_update :353`、`alarm_repeat_due :425` |
| `notice_logic.h` | 113 | **纯逻辑**：跨房间定向播报的"播过/正在播/本地优先"判定 | `notice_begin :70`、`notice_end :90`、`notice_yield :103`、`notice_id_valid :53` |
| `local_voice.c` / `.h` | 237 / 40 | I2S+ES8388 播放任务、IMA-ADPCM 解码、功放使能时序 | `playback_task :124`、`codec_start :102`、`amp_prepare :88`、`request :180`、`local_voice_start :196` |
| `local_led.c` / `.h` | 256 / 35 | 单色 LED 灯效（非阻塞、纯时间函数） | `local_led_tick :203`、`pattern_level :168`、`set_mode :92`、`led_write :71` |
| `battery_logic.c` / `.h` | 229 / 97 | 电池采样纯逻辑（换算/中位数/三重门限/OCV 百分比） | `battery_evaluate :163`、`battery_raw_to_mv :78`、`battery_median :89`、`battery_percent_from_mv :134` |
| `adpcm_ima.h` | 86 | IMA ADPCM(DVI4) 解码器（头 4 字节 + 高半字节优先） | `adpcm_ima_next :44`、`adpcm_ima_begin :74` |
| `voice_pins.h` | 19 | **编译期**拦"传感器引脚与 I2S 抢脚" | `VOICE_PIN_BUSY :4`、`#error` 断言 `:6-17` |
| `Kconfig.projbuild` | 470 | 40+ 个 `NODE_*` 配置项（引脚/阈值/时序/机型开关） | `NODE_VOICE_ENABLED :3`、`NODE_BATTERY_ADC_CHANNEL :292`、`NODE_ALARM_REPEAT_SEC :418` |
| `CMakeLists.txt` | 17 | 组件注册；语音素材按开关条件 embed | `EMBED_FILES :16`、`REQUIRES :17` |
| `voice/*.adpcm` | 6 文件 / 196,324 B | 离线中文语音素材（16 kHz 4bit ADPCM ≈ 8 kB/s） | 见 `local_voice.c:60-70` 的 `s_clips[]`（**下标顺序即协议**） |

### 2.2 三块节点的差异只在配置里

三个节点是**三个自包含的 IDF 工程**，各自的 `main/` 里放完整源码，VSCode 打开工程目录即可编译、烧录。
公共代码的母本在 `firmware/common/components/elder_node/`，改完用 `firmware/tools/sync-shared.ps1` 同步到三个工程。
所以"加一个房间"= 复制一个工程目录 + 一份 `sdkconfig.defaults`，**不改 C 代码**。

| 项 | 厨房 kitchen | 卫生间 bathroom | 客厅 living（候选，未部署） |
|---|---|---|---|
| 身份 | `esp32-kitchen` / 厨房（`sdkconfig.defaults:10-11`） | `esp32-bath` / 卫生间（`:10-11`） | `esp32-living` / 客厅（`:11-12`） |
| 温湿度 | AHT20 I2C1 4/5（`:26-29`） | 同左（`:25-28`） | **DHT11 单总线 GPIO11**（`:23`） |
| 气体 | MQ-2 CH5 阈值 700 / MQ-5 CH6 阈值 900（`:35-40`） | 全禁用（`:34-38`） | 全禁用（`:40-44`） |
| 求助键 | 板载 KEY0＝XL9555 P1_7（`:24`） | GPIO15（`:18`） | GPIO6（`:34`） |
| 语音/蜂鸣 | 开，音量 30，XL9555 P0_3（`:30-33`） | 同左（`:29-32`） | **全关**（`:36-38`） |
| 告警 LED | GPIO1 低有效（`:62-63`） | 同左（`:60-61`） | 无（`-1`，`:85`） |
| 主任务栈 | 8192（`:49`） | 8192（`:47`） | **3584**（`:83`） |
| Flash/产物 | 2MB / 1,023,504 B | 2MB / 1,012,544 B | 16MB / 770,144 B（`BUILD-VERIFY.md:11-13`） |

构建入口统一是 `firmware/tools/build-node.ps1`：它把 `sdkconfig.defaults` 与**不入库**的
`firmware/.local/wifi.<node>.defaults` 用分号拼成 `SDKCONFIG_DEFAULTS`（`:63-64`、`:80`），
烧录前用 `esptool chip_id` 读 MAC 与节点身份表比对，不一致直接中止（`:99-108`）——**串口号会变，MAC 才是身份**。

### 2.3 板端 homemon（C，交叉编译到 OH NDK）

| 文件 | 行 | 职责 | 关键函数（行号） |
|---|---:|---|---|
| `southbound/src/homemon.c` | 1295 | 守护进程：配置、采集、判定、执行、上报、TCP 多客户端、命令、日志 | `main :1052`、`handle_command :496`、`report_status :861`、`tcp_pump :773`、`tcp_broadcast :731`、`judge_decide`（外部头）、`apply_trusted_time :447`、`alarm_raise :298`、`say :287` |
| `src/judge_logic.h` | 84 | 判定段纯逻辑（优先级 + 无 PIR 门控） | `judge_decide :50` |
| `src/motion_gate.h` | 73 | 活动监测"能力/有效性/时钟跳变" | `mg_monitor_enabled :27`、`mg_judge_allowed :35`、`mg_clock_jumped :42` |
| `src/time_util.h` | 93 | 可信时间窗、秒/毫秒归一、64 位 UTC 换算 | `tu_epoch_ms_trusted :53`、`tu_normalize_epoch_ms :47`、`tu_ms_to_utc :65` |
| `src/climate_valid.h` | 43 | 温湿度"本次读取是否有效" | `climate_apply_sample :28` |
| `homemon.conf` | 65 | 引脚/设备名/阈值/播报命令（真实上板值） | `motion_gpio=117,114 :13`、`say_cmd :46` |
| `say.sh` | 31 | 只有 5 行真逻辑：`aa start SosVoiceAbility` 并**透传真实退出码** | `aa start :23`、`exit "$rc" :31` |
| `build.ps1` | 43 | OH NDK clang 交叉编译（`--target=arm-linux-ohos`） | `:20`、`:33` |
| `build-host-test.ps1` | 42 | PC 上编译 4 个纯逻辑单测并跑 | `:27-39` |

主机单测集中在 `southbound/tests/{time_util,climate_valid,motion_gate,judge_logic}_test.c`，
另有进程级台架 `southbound/tests/hostbench/run_hostbench.ps1`（用假 GPIO 目录 + `gpio_root` 配置项模拟）。

### 2.4 穿戴求助固件（`esp32-node-wearable/`，本文不展开）

- **定位**：单键 SOS + 蜂鸣提示，网络只走 YED-M100MG-B1 4G DTU 透传；**不启用 Wi-Fi/蓝牙**。
- **代码位置**：`esp32-node-wearable/main/`（`wearable_main.c` 约 31KB、`wearable_logic.c` 约 44KB、`battery_logic.c`），配置项在 `main/Kconfig.projbuild`。
- **协议**：设备不直接实现 MQTT，而是把 SOS/心跳按固定上行主题交给 DTU；未确认的 SOS 每 10s 重发**同一 alarmId**（幂等）。
- **边界**：无 RTC、不伪造墙钟；真实端到端（4G→ECS→镜像→板端）**未验收**，仅本地/串口验证过。
- 详细接线、烧录与验证记录见 `esp32-node-wearable/README.md`、`WIRING.md`、`FLASH.md`。

## 3. 运行模型

### 3.1 ESP32 节点：1 个主循环 + 2 个从任务，**零中断**

| 任务 | 栈(B) | 优先级 | 创建处 | 职责 |
|---|---:|---:|---|---|
| `main`（`app_main` 本体） | 8192（客厅 3584） | 1 | IDF | 采集/判定/播报编排/上报入队/命令执行/NVS |
| `gateway-net` | 6144 | 3 | `node_main.c:2100` | DNS/connect/send/recv，**独占 socket** |
| `local-voice` | 4096 | 4 | `local_voice.c:222` | 只做 I2S 播放（解码+写 I2S） |
| `bench-uart` | 4096 | 3 | `node_main.c:2089` | 仅台架固件：UART0 注入命令 |

**没有任何 GPIO 中断**：`gpio_start()` 里每个引脚都设 `io.intr_type = GPIO_INTR_DISABLE`
（`node_main.c:868-943` 的五个分支无一例外），全部靠轮询。这样做的收益是"判定逻辑全在主任务、天然无竞态"，
代价是响应颗粒度被节拍锁死（PIR/门磁最坏 2s 才确认，见 `Kconfig.projbuild:178-184` 的默认 2 次确认）。
`local_voice` 也**不操作告警状态**，只做 I2S（`local_voice.c:124-178`）。

两个队列（`node_main.c:2097-2098`）：

| 队列 | 容量×元素 | 生产者 | 消费者 | 语义 |
|---|---|---|---|---|
| `s_reports` | 1 × 1600B | 主任务 `gw_send`（`xQueueOverwrite`，`node_main.c:1060`） | `gateway-net` | **最新状态**，不是事件日志；满即覆盖 |
| `s_commands` | 4 × 1024B | `gateway-net` / `bench-uart` | 主任务，每 tick 最多取 4 条（`:2156`） | 下行命令，满则丢弃并打印（`:1395-1396`） |

`xQueueOverwrite` 只能用于长度=1 的队列——这是"离线不积压"的实现手段（§5.2），
不是随手选型；`local_voice` 的音符队列同样长度 1 + 代际号（`local_voice.c:180-185`）。

**三个节拍**都在主循环里（`node_main.c:2108-2168`）：

- **100 ms**：`sos_handle_fast()`（`:2141`）→ `announce_tick()`（蜂鸣/语音编排，`:1982`）→
  `alarm_reminder_tick()`（`:2150`）→ `local_led_tick()`（`:2152`）→ 取命令（`:2156`）；
- **1 s**（每 10 tick）：`sample()` + `judge()`（`:2144-2148`）——AHT20 单次测量本身约 90 ms；
- **5 s**（每 50 tick，`CONFIG_NODE_REPORT_SEC`）：`report()`（`:2163-2166`），
  且 SOS/ACK/stop/pause/resume/reset 会**额外立即**上报（`:1096`、`:1225`、`:1244`、`:1259`、`:1267`、`:1281`）。

数据流：

```
GPIO/ADC/I2C ──sample()──► 纯判定(header) ──judge()──► s_state/s_alarm_id
                                   ├─► announce_start → 蜂鸣(direct) + local_voice_play(队列)
                                   ├─► local_led_tick → gpio_set_level
                                   └─► report() → JSON 行 → gw_send → [s_reports] → gateway-net → TCP
```

### 3.2 栈与 flash 预算（都是紧出来的）

- `report()` 在**栈上**同时摆 `json[1600]` + `door_json[700]` + `battery_json[240]` + `water_json[80]`
  （`node_main.c:1821-1856`），随后 `gw_send()` 又用栈上 `report_message_t`（1600B）拷一份入队
  （`:1057-1061`）——所以有语音的节点主任务栈必须 8192。无语音构建走直接 `send()`（`:1063-1070`），
  少一次 1600B 拷贝，客厅因此配 3584（`firmware/living/sdkconfig.defaults:83`）。
  这一对应关系是从代码量出来的**推断**，不是实测高水位（日志里有 `STACK_FREE`
  `node_main.c:1916`、`local_voice.c:176`，可用于真机复核）。
- Flash 是最硬的墙：默认分区表 app 只有 **1 MiB**，厨房镜像已 1,023,504 B（**余量 24.5 KB / 2.3%**，
  `firmware/docs/BUILD-VERIFY.md:11`），而 6 条 ADPCM 语音素材合计 196,324 B 就塞在这个 1 MiB 里。
  → 任何"再加一条语音/再加一个功能"的提案先看 `firmware/docs/NODES.md:90-97`。

### 3.3 NVS：只持久化"跨重启必须记得"的三件事

命名空间 `elder_node`（`node_main.c:436`）：

| key | 内容 | 写入时机 | 语义 |
|---|---|---|---|
| `mon_paused` | 监护暂停布尔（`:437`、`:449-460`） | 收到 `pause`/`resume` | 重启**不自动恢复**监护（安全性选择） |
| `door_seq` | 门磁事件单调序号（`:466`、`:512`） | 门磁翻转 | 后端按 `(deviceId, seq)` 幂等去重 |
| `door_cache` | 未送达事件环形 FIFO + magic/count/head（`:467`、`:531-553`） | 翻转/过期清理 | 带 `magic='DOOR'`+长度校验，坏数据直接忽略（`:520-526`） |

**没有**持久化：告警状态、告警 ID、活动计数、LED 状态。所以重启后不会重放历史告警
（`local_led.c:118` "上电默认灭"、`node_main.c:2009`）——这是刻意的"宁可少报历史，也不假报现场"。
写 NVS 只在低频事件上发生（`node_main.c:462-465` 明示"不在 5 秒心跳里写"），避免 flash 磨损。

### 3.4 看门狗：**未实现主动策略**

`elder_node` 全目录没有任何 `esp_task_wdt` 引用（grep 无命中）。因此：
- 只有 IDF 默认的 Task WDT 在监视 **idle 任务**；只要没有任务长时间不让出 CPU，就不会触发；
- 没有"业务心跳超时就重启"的机制——`gateway-net` 卡在 `connect()` 也不会被复位（`:1421`）；
- 现场恢复靠 WiFi 事件回调里的 `esp_wifi_connect()` 无限重连（`:562-566`）和桥接侧在线判定
  （`docs/ARCHITECTURE.md:117-124`）。这是"可用但不够硬"的一环，改进见 §6-R4。

### 3.5 homemon：单线程 1 秒轮询，**没有 select/poll**

`homemon.c` 里搜不到 `select(` / `poll(` / `epoll`（grep 无命中）。它做的是：
监听 socket 设 `O_NONBLOCK`（`homemon.c:769`），每个 tick 调 `tcp_pump()` 先 `accept()` 排空待接入连接
（`:778-814`），再对 8 个槽位各做一次 `recv()`（`:817-851`），然后 `poll_control()` 读 `<dir>/control` 文件
（`:684-695`），最后 `sleep(tick_sec)`（`:1292`）。**所以命令/ACK 的最大延迟 ≈ 1 个 tick（默认 1s）**。

单线程的直接后果（§5.6 会展开）：`alarm_raise()` 里的语音走 `system()` 同步执行（`:293`），
播报启动期间整个守护进程是停摆的——采集、ACK、TCP 全部等它。

## 4. 关键技术点

每条都按 **概念 → 本项目怎么用 → 代码位置** 写。WT 已讲过的细节只留指针，这里补的是"为什么"。

### 4.1 ESP-IDF 构建系统：一份组件、三份配置、四层叠加

**概念**：ESP-IDF 用 CMake 组件模型 + Kconfig 生成 `sdkconfig`；`sdkconfig.defaults` 只是"首次生成时的默认值"。

**本项目**：
- 三个节点是三个**自包含工程**（各自 `main/` 有完整源码），公共母本在
  `firmware/common/components/elder_node/`，改完用 `firmware/tools/sync-shared.ps1` 同步；工程内
  `main/CMakeLists.txt` 用 `EMBED_FILES` **条件**嵌入语音素材，关语音的客厅连 196 KB 素材都不进镜像。
- **配置四层**：Kconfig 默认值（`Kconfig.projbuild:1-470`）→ 节点 `sdkconfig.defaults` →
  `.local/wifi.<node>.defaults`（口令，不入库，`firmware/tools/build-node.ps1:49-64` 拼进
  `SDKCONFIG_DEFAULTS`）→ 生成的 `sdkconfig`。⚠ 改 defaults 后**必须删 `nodes/<n>/sdkconfig`**
  （`BUILD-VERIFY.md:36-37`，真踩过）。
- **机型差异全靠条件编译**，约定"`-1` = 本机型没有该外设，整段不编译"：电池段
  （`node_main.c:217-224`）、JSON 的 `battery`/`water` 段（`:1822-1826`、`:1870-1872`）、
  语音（`local_voice.c:4` 与 `:232-237` 的空实现）。
- **Kconfig 是软约束，`#error` 才是硬约束**：`sdkconfig` 可被手改，故 ADC 通道合法性在代码里再校验
  （`node_main.c:80-90`），引脚冲突在 `voice_pins.h:6-17` 编译期 `#error`。

### 4.2 FreeRTOS 任务与队列：一句话规则"谁独占什么"

**概念**：FreeRTOS 队列是拷贝语义；`xQueueOverwrite` 要求长度=1，等价于"带锁的最后值槽"。

**本项目**：并发契约写在文件头——**只有主任务改传感器/告警状态，只有 `gateway-net` 碰 socket**
（`node_main.c:109-111`）。为此固件按 `CONFIG_NODE_VOICE_ENABLED` 分叉出两套网络结构：
有语音时主任务只 `xQueueOverwrite`（`:1054-1071`）、`gateway-net` 负责 DNS/connect/recv/send（`:1410-1442`），
网关连不上也不阻塞采集/告警/语音；无语音时主任务自己连收发自（`:2109-2123`、`:2159`），少一个 6144B 栈的任务。
优先级 `local-voice`(4) > `gateway-net`(3) > `main`(1)：I2S 写入是带 50 ms 超时的阻塞调用（`local_voice.c:161`），
低一点就会被采集拖出断音。`xQueueSend(...,0)` 一律非阻塞（`:1395`、`:1481`）——**队列满 = 丢弃并打印**。

### 4.3 Wi-Fi STA：事件组 + 无限重连，退避交给 IDF

- 连接状态只用一个 EventGroup bit（`node_main.c:64`、`:557-572`）：`GOT_IP` 置位，`STA_DISCONNECTED`
  清位并**立刻** `esp_wifi_connect()`——固件没写指数退避，节奏由 IDF 决定，但永不放弃。
- 三个刻意的非默认项：`WIFI_STORAGE_RAM`（口令不写 NVS，`:604`）、`WIFI_PS_NONE`（低延迟，`:606`）、
  **关 PMF**（`:597-601`，热点声明可选 PMF 时 ESP32-S3 认证会失败，注释即现场结论）。
- 首次 NTP 同步：墙钟 1970→2026 后**只重置"最近活动"基准**（`:2126-2138`），否则 idle 变几十年会立刻误报；
  GAS/SMOKE/CLIMATE 一律不动（`alarm_logic.h:448-451` 把规则做成可测函数）。

### 4.4 TCP 行协议：分帧在接收侧，背压在发送侧

- **分帧**：`recv(..., MSG_DONTWAIT)` 收 256B 追加进 `s_rx[1024]`，`memchr('\n')` 切行，剩余 `memmove`
  （`node_main.c:1371-1407`）。命令必须单行——这正是 `notice_logic.h:53-66` 只接受
  `[A-Za-z0-9._-]{1,32}` 的原因（防换行注入破坏分帧）。
- **半包**：`offset` 走完整条才 `s_gw_sent_count++`，中途失败即 `close()` 并**重排队**，
  绝不把半条 JSON 接到新连接（`:1427-1437`、注释 `:1425-1426`）；SOS"已送达 Bridge"判定靠这个计数（`:1969-1978`）。
- **背压**：不靠流控，靠 ① 队列长度 1（最新覆盖）② `SO_SNDTIMEO=1s`（仅语音构建，`:1039-1042`）
  ③ 接收溢出丢字节不阻塞（`:1383-1386`，已知降级：作废半行、后续行仍解析）。
- **自保护**：`snprintf` 返回值断言，超长丢弃整条而非发截断 JSON（`:1900-1905`）。

### 4.5 模拟/数字输入：ADC oneshot、消抖、两条 I2C、单总线、XL9555、LED

- **ADC oneshot**：`adc_oneshot_new_unit(ADC_UNIT_1)` + `ADC_ATTEN_DB_12` + 12 bit
  （`node_main.c:709-717`）。选 oneshot 而不是 continuous 是因为 MQ/电池都是秒级采样，
  不需要 DMA 环形缓冲。**ADC2 在 Wi-Fi 开启时不可用**，所以通道被编译期限制在 0..9（`:80-82`）。
- **阈值不等于 ADC**：`mq_stab_update()` 做"连续 3 次越界才触发、连续 3 次 < 阈值−20 才解除"，
  且 `threshold>=4096` 是**禁用哨兵**而不是超大阈值（`alarm_logic.h:34-42`）——
  卫生间 `MQ*_ALARM_RAW=4096` 就是这么"关闭"的（`firmware/bathroom/sdkconfig.defaults:37-38`）。
- **GPIO 消抖全部抽成纯函数**：`pir_update`（连续确认后只在上升沿记一次活动，`alarm_logic.h:163-175`）、
  `sos_update`（必须先见到"松开"才允许触发，防上电常低误报，`:193-209`）、
  `door_update`（连续确认 + 上电基线，`:307-329`）。上拉/下拉按模块类型配
  （PIR 下拉防悬空、门磁/SOS 上拉、水漏按有效电平二选一，`node_main.c:870-930`）。
- **两条 I2C 总线分开**：`I2C0` 固定板上 `IO41/42`（XL9555 + ES8388，未对排针引出），
  外接 AHT20 走 `I2C1 IO4/IO5`（`node_main.c:229-238`）。混用会把板载器件和外设互相拖死。
- **AHT20**：`0xBE 0x08 0x00` 初始化 → `0xAC 0x33 0x00` 触发 → 等 90 ms → 读 7 字节 →
  **CRC8 校验 + 物理范围双重判定**，任一不过就 `valid=false`（`:732-758`）。
- **DHT11**：单总线 bit-bang，起始要 `vTaskDelay(1100ms)`，逐位测高电平宽度 `>45us` 判 1
  （`:776-851`）。它只能在**主任务里同步执行**，代价见 §5.4。
- **XL9555（I2C IO 扩展）**：板载蜂鸣器 `P0_3`（低有效，`:276-301`）、
  板载 KEY0 `P1_7`（输入，`:321-347`）、功放使能 `P0_2`（低有效，`local_voice.c:88-100`）。
  三个使用者都遵守同一条纪律：**先写输出锁存再改方向寄存器**，否则会把同端口其他位瞬时拉错。
  KEY0 的特殊性在于"它不是 GPIO"——没有内部上拉、没有中断，读失败返回 -1 时调用方
  **既不触发也不解除**（`:1936-1942`）。
- **LED 不用 PWM/LEDC**：纯 `gpio_set_level` + `esp_timer_get_time()` 算相位
  （`local_led.c:71-78`、`:168-201`），5 种灯效（快闪/三短闪/ACK 常亮+慢脉冲/确认后灭/台架识别）
  全是无状态时间函数，不新增任务、不阻塞、重启不闪烁（`:118`）。

### 4.6 I2S + ES8388 + IMA-ADPCM：为什么是 ADPCM，以及播放的"两段等待"

**为什么 ADPCM**（`adpcm_ima.h:1-17`、`local_voice.h:20-26`）：app 分区只有 1 MiB，要放 6 条完整中文句子；
16 kHz/16 bit 是 32 kB/s，放不下；降到 8 kHz PCM 会明显糊。4 bit ADPCM @16 kHz 是 8 kB/s，
保住完整 8 kHz 语音带宽，实测 6 个文件合计 196 KB 仍塞得进 1 MiB。

**素材怎么进固件**：`EMBED_FILES` 把 `.adpcm` 编进 rodata，C 侧用链接符号
`_binary_sos_adpcm_start/end` 取地址（`local_voice.c:40-51`）——没有文件系统、没有运行时解析，
`local_voice.c:60-70` 的 `s_clips[]` **下标就是协议**（与 `local_voice.h:13-27` 一一对应）。
解码器是纯头文件（`adpcm_ima.h:44-84`），与 Python 参考实现逐采样一致（主机测试 `esp32-node/test/host_adpcm_test.c`）。

**播放时序**（`local_voice.c:124-178`）：

```c
amp_prepare(1);                       /* P0_2 使能功放（上电才开，待机静音） */
vTaskDelay(AMP_SETTLE_MS);            /* 等功放稳定，否则吞掉开头第一个字 */
i2s_zero_dma_buffer(); i2s_start();   /* 清旧 DMA 再启动 */
/* 每 256 个立体声样本(16ms) 解码一块 → i2s_write(50ms 超时) */
for (6) vTaskDelay(16ms);             /* 排空最后几个 DMA 块 */
i2s_stop(); i2s_zero_dma_buffer(); amp_prepare(0);
```

参数：16 kHz、`fixed_mclk=4.096 MHz`、`MCLK_MULTIPLE_256`、DMA 4×256，引脚
MCLK=IO3 / BCLK=IO46 / LRCK=IO9 / DOUT=IO10（`:201-215`）。
**取消有界**：请求带递增"代际号"（`_Atomic uint32_t`，`:78-80`、`:183`），
解码/写入循环每块都检查代际，`stop`/ACK 后最坏延迟 ≤16 ms，不会出现"按了停止还在念"。

与蜂鸣器的编排（`node_main.c:956-1019`）：先响 N 声短提示音，**蜂鸣完全停止后**才播语音。
这不只是好听问题——旧实现连续蜂鸣 10 秒与语音重叠，用户实测"只听到滴滴几声"（`:147-151`）。

### 4.7 电池：分压、两点校准、三重门限、以及"没电池就别报电量"

数值链（`battery_logic.c:46-87`）：`raw →(4095=3100mV)→ pin_mv →(NUM/DEN 分压)→ battery_mv
→(×gain/1000 + offset)→ 校准值`。采样窗 8 次、间隔 2 ms（`node_main.c:384-401`），
三重门限全部通过才算 `valid`（`battery_logic.c:200-222`）：

1. 极差 `> 300 mV` → `UNSTABLE`（Wi-Fi 发射毛刺、接触不良）；
2. 中位数 ±150 mV 内不足 5 个样本 → `UNSTABLE`（防"两簇跳变但极差不大"）；
3. 中位数不在 `2500..4350 mV` → `OUT_OF_RANGE`（**含 0 raw**，`battery_logic.c:219`）。

`percent` **只有 `calibrated=1` 才输出**（`:134-153`），否则 `-1` → JSON `null`；
`low` 只在有效读数时才可能为真（`:155-161`）。
固定供电节点（厨房/卫生间）`NODE_BATTERY_ADC_CHANNEL=-1`，**整段不编译、JSON 无 `battery` 字段**
（`node_main.c:1852-1872`）——"绝不给没有电池的设备编造电量"是代码级约束，不是文案约定。

### 4.8 homemon 的 C 实现：把"教科书网络编程"换成"1 秒轮询"

- **不用 select/poll**：监听 fd 与非阻塞客户端全部 `O_NONBLOCK`，每个 tick `accept()` 排空 + 逐路 `recv()`
  （`homemon.c:769`、`:773-851`）。好处是无 fd_set 上限、代码直白；代价是延迟 = tick（§3.5）。
- **多客户端广播 + 僵尸连接治理**：8 个固定槽位（`:702-714`），新连接设 `SO_KEEPALIVE` +
  `TCP_KEEPIDLE=30/INTVL=5/CNT=3`（约 45 s 回收死连接）+ `SO_SNDBUF=256KB`（`:788-809`）。
  发送用 best-effort：`EAGAIN` 只丢这一条、连接保留；写了一半才判流坏并关闭（`:717-747`）。
- **sysfs GPIO**：`export` → `direction` → `value` 读写（`:194-223`），编号必须上板实测
  （`homemon.conf:3-10` 有 J9903 实测对照）。
- **SARADC 不是 `/dev/saradc`**：RK3568 把 SARADC 暴露成 IIO，读
  `/sys/bus/iio/devices/iio:device<N>/in_voltage<M>_raw`（`:252-264`）。
- **状态机 + 灯语**：`NORMAL/WARN/ALARM/ACKED`（`:70-79`），1Hz tick 里相位取模产生
  绿常亮/黄慢闪/红闪+鸣/蓝（`:336-346`）。
- **ACK 严格匹配（四道拒绝）**：无告警 → 拒绝；ID 不符 → 拒绝；状态不是 ALARM（重复 ACK）→ 拒绝；
  已处置过 → 拒绝；只有全通过才 `ALARM→ACKED` 并追加 `safety.log`（`:556-583`）。
- **route/relay 清洗**：`route <deviceId> <cmd>` 目标是自己则本地执行、否则整行广播给桥接，
  且**显式禁止嵌套** route/relay（`:499-527`）；`relay` 只接受 `{` 开头的 JSON，防止借 relay 伪造命令（`:528-538`）；
  `fall <evidenceId>` 的 evidence id 走字符白名单（`:321-334`）；`monitor` 的 reason 只接受枚举值（`:431-441`）。
- **时间**：板端 RTC 掉电会回到 2017，`tu_epoch_ms_trusted()` 只认 2025–2100
  （`time_util.h:22-56`）；接受 `time` 校时后**把历史时间戳整体平移**，避免"9 年无活动"的假告警（`homemon.c:479-490`）。

### 4.9 可测性：把判定从 I/O 里拔出来

设备端最值得学的工程习惯：**纯逻辑进头文件，I/O 留主文件**。
`alarm_logic.h` / `notice_logic.h` / `battery_logic.c` / `adpcm_ima.h` 全不依赖 ESP-IDF，
主机 gcc 直接编（`esp32-node/test/host_*_logic_test.c`）；homemon 同样抽出 `judge_logic.h` /
`motion_gate.h` / `time_util.h` / `climate_valid.h`，由 `southbound/build-host-test.ps1:27-39` 编译运行。
再加一个**台架注入模式** `CONFIG_NODE_ALARM_BENCH_INJECT`（`Kconfig.projbuild:434-441`）：打开后
`inj climate 40 20` / `inj sos` 等命令可注入输入（`node_main.c:1282-1365`），台架固件不启动 Wi-Fi、
不产生云端事件（`:2081-2092`）——让"告警时序"可被脚本化验收。



## 5. 设计取舍与坑

每条格式：**怎么做的 → 为什么 → 代价/边界**；均来自代码注释与现场证据。

### 5.1 节点不实现 MQTT：用"协议同构"换可替换性

只把与 homemon 逐字段一致的 JSON 行推到 PC 桥接（`node_main.c:7-14`），固件零第三方组件
（`CMakeLists.txt:17`）。**收益**：桥接与两个 APP 零改动即可发现新房间，体积/依赖可控。
**代价**：强依赖 PC 桥接在线、无云侧兜底；节点订阅不到云端主题，只能收桥接按行投递的
`notice`/`ack`（`node_main.c:1195-1235`）。

### 5.2 节点"不许重发积压"：状态是快照，不是事件流

`gw_send()` 用长度=1 队列 + `xQueueOverwrite`（`node_main.c:1054-1061`），断网只保留**最新**状态——
5 s 心跳的语义是"我现在怎么样"，补发 20 条过期状态只会让 APP 看到时间倒流、恢复瞬间触发一堆过期告警。
需要保序的只有门磁事件：独立环形 FIFO + NVS 单调 `seq`（`:471-553`），后端按 `(deviceId, seq)` 幂等去重。
SOS 也不靠重发队列：处于 ALARM 时每次上报都带同一个 `alarm.id`（`:1895-1897`）。
**代价**：断网期间的中间状态永久丢失。

### 5.3 为什么 ACK 必须 alarmId 精确匹配（还要 boot salt）

回执可能来自上一轮（云端重投、APP 超时重试、设备刚重启），若只判"有告警就 ACK"会误确认新求助。
设备端四道闸（`node_main.c:1209-1216`）、homemon 端同样四道（`homemon.c:556-572`）。
**更隐蔽**：NTP 未同步时 `time(NULL)=0`，ID 拼成 `e-0-<seq>` 会跨上电周期撞号，云端去重会吞掉新求助
——故 `alarm_id_build()` 未同步时掺 `esp_random()` 上电盐（`alarm_logic.h:228-243`、`node_main.c:1997`）。
**代价**：ACK 晚于异常自动解除就永不被接受（已回 NORMAL），APP 只能靠超时提示兜底
（`docs/ARCHITECTURE.md:115`）；这也是 `stop`（只静音）与 `ack`（转 ACKED）必须分开的原因（`node_main.c:1236-1247`）。

### 5.4 DHT11 阻塞主任务，把 20 ms 采样拉长到秒级

`dht11_read()` 有 `vTaskDelay(1100ms)` + 40 位忙等（`node_main.c:794-830`），且跑在**唯一主任务**里；
客厅用 DHT11（`firmware/living/sdkconfig.defaults:23`）、求助键是 GPIO6（`:34`），
本应 200 ms 响应的 SOS 会被整体推迟 ≥1.1 s。**代码事实成立、真机时延未实测**；
厨房/卫生间用 AHT20（90 ms 阻塞）无此问题。改进见 §6-R1。

### 5.5 GPIO9 与 I2S LRCK 冲突：编译期拦一半，实物线拦不住

语音占用 MCLK=IO3 / BCLK=IO46 / **LRCK=IO9** / DOUT=IO10（`local_voice.c:212-213`），而 IO9 是 `ADC1_CH8`
（厨房原 MQ-5）。迁移方案是 MQ-5 → **IO7/ADC1_CH6**（`Kconfig.projbuild:258-265`），`voice_pins.h:4`
用 `VOICE_PIN_BUSY(channel+1)` 在编译期 `#error`（`:9-11`），代码里配不出冲突组合。
**但拦不住"代码改了、线没搬"**：2026-10-28 现场 gas 恒 4095（`NODES.md:147-151`）。
引脚迁移是**代码/配置/实物线/分压中点四件事**，编译器只管前两件。

### 5.6 MQ-5 的分压中点必须随信号线一起迁移

MQ 的 AO 可能到 5 V，必须先 2k/1k 分压（÷3）再进 ADC（`NODES.md:136-146`）。只改配置不改分压位置，
读到的就是悬空电平——看起来像"阈值没调好"，实际是模拟链路没接上。附带一层：÷3 + 12 dB 衰减
（满量程约 3.1 V）下，厨房 700/900 是**工程值不是 ppm 标定值**（`NODES.md:76-77`），不能说"燃气浓度安全"。

### 5.7 8 个客户端槽位与僵尸连接：没有 select 的固定上限

`MAX_CLIENTS` 4→8（`homemon.c:702-714`，因为 bridge/mirror/APP/探针最多占 6 路），新连接开
`SO_KEEPALIVE`（30 s+3×5 s，约 45 s 回收死连接）与 256 KB `SO_SNDBUF`（`:788-809`）；发送改 best-effort：
`EAGAIN` 只丢这一条、写一半才判流坏（`:717-747`）——旧实现把 `EAGAIN` 当致命错误，bridge/mirror
每 10–30 s 被踢一次（注释 `:737-739`）。**代价**：第 9 个连接 accept 后立即 close（`:787`），客户端自连。

### 5.8 单线程 + `system()` 播报 = 播报期间守护进程停摆

`say()` 用 `system(say_cmd)`（`homemon.c:287-295`）→ `say.sh` → `aa start -a SosVoiceAbility`（`say.sh:23`），
拉起 Ability 的耗时不可控，期间采集/ACK/TCP 广播全部停住（单线程，§3.5）。
**代码路径确定、停摆时长未实测**。同类问题：`control` 的"读→处理→截断"非原子（`homemon.c:684-695`），
写入方写到一半可能被执行半行。改进见 §6-R3。

## 6. 可完善点（按 ROI 排序）

排序依据"收益/成本"；每条给**改哪里 / 风险 / 怎么验证**。

**R1 · DHT11 移出主循环（收益最大、成本最低）**
改 `climate_read()` 调用点：主循环只读"最近一次成功快照"，DHT11 采样挪到独立低优先级任务
（或客厅直接换 AHT20，只改 `sdkconfig.defaults` + 接线）。风险：共享 `s_temp_c/s_rh/s_climate_valid`
需加锁或双缓冲，别把纯逻辑接口改脏。验证：台架 `inj` 打"按键→蜂鸣"时间戳差（现 ≥1.1 s，目标 <300 ms）。

**R2 · 给节点加真正的看门狗**
现状只有 IDF 默认 Task WDT 看 idle（§3.4）。建议主循环注册 `esp_task_wdt_reset()`，
`gateway-net` 用"最近成功收/发时刻"做业务心跳，超时 `esp_restart()`。
风险：Wi-Fi 长时间断线是**正常**工况，阈值必须大于现场最长断网时间，否则变重启风暴。
验证：拔 AP 10 分钟不应重启；`connect()` 打桩卡死应在阈值内自愈。

**R3 · homemon 播报异步 + control 原子投递**
`say()` 改 `fork()`+`execl()`（父进程立即返回、SIGCHLD 回收）而非 `system()`（`homemon.c:287-295`）；
`control` 改"临时文件 + `rename()`"或加 `flock`（`:684-695`）。风险：并发告警会拉起两个 Ability（需去重），
僵尸进程要处理。验证：`tests/hostbench/` 用假 `aa` 测"告警→播报返回"时延与同 tick 内 ACK 是否仍被处理。

**R4 · 扩容 app 分区（解除 flash 硬墙）**
厨房只剩 24.5 KB（`BUILD-VERIFY.md:11`）；2MB flash 板可给 factory 分区 1.5MB（新增 `partitions_node.csv`
+ `CONFIG_PARTITION_TABLE_CUSTOM`）。风险：**动板布局**，必须整片备份、`nvs` 保持 0x9000 不动；
客厅 16MB 板需单独验证。验证：只读备份 → 写新分区表 → 重启 → 读回 `door_seq`/`mon_paused` → 再烧 app。

**R5 · 气体阈值从"工程值"改为"相对基线 + raw 曲线"**
厨房是 MQ-2 700 / MQ-5 900，都是按洁净空气基线拍的（`NODES.md:76-77`）。建议上报连续 raw、判定改相对增量。
风险：温湿度剧变时基线漂移，回差/确认次数要一起调（`alarm_logic.h:34-58`）。
验证：远离明火用打火机气体做阶梯试验回放曲线；**不可**宣称 ppm。

**R6 · homemon 换事件驱动（select/poll）**
1 s 轮询改 `poll()`（listen fd + 客户端 fd + timerfd），ACK 延迟从 ~1 s 降到 ms 级。
风险：网络核心路径要重写（`tcp_pump` 的 accept/recv/半包重组），回归成本高。
验证：hostbench 全绿 + 新增半包/粘包/慢客户端用例。**建议在 R3 之后动**。

**R7 · 门磁"送达即清"（暂缓）**
事件只在 300 s 后过期、期间每条心跳重带（WT §5.2）。要"送达即清"必须后端加送达回执，
否则会丢事件。**结论：不做**；现阶段 `(deviceId, seq)` 幂等是正解。

## 7. 本层最容易被误解的 3 个点

1. **"homemon 用 select/poll 做多路复用"** —— 没有。它用 `O_NONBLOCK` + 每 tick 轮询
   （`homemon.c:769`、`:773-851`），命令/ACK 的最大延迟约等于 `tick_sec`（默认 1 s）。
   所以"APP 点了确认但状态没马上变"是正常的，判定在线/超时的阈值必须按秒级来配。
2. **"ACK 了就等于这件事结束了/人安全了"** —— ACK 只表示"监护人看到了"：它静音、置 `ACKED`，
   但**保留** `alarmId`/`alarmType`，且如果危险仍在，LED 会转成"确认后慢脉冲"继续提示
   （`local_led.c:181-189`、`node_main.c:1218-1225`）。`stop` 更弱：只停声音、状态仍是 ALARM
   （`node_main.c:1236-1247`）。真正"解除"只有异常消失自动回落（仅可恢复类型，`:1770-1794`）
   或 `reset`。
3. **"节点 JSON 里没有 `battery`/`water` 段 = 漏报/电量为 0"** —— 是**编译期就没有这个外设**：
   `-1` 的机型整段不编译（`node_main.c:1852-1872`、`:217-224`），所以字段**不存在**；
   有字段但 `valid=false` 才表示"这次读不到"。同理 `door.open` 可能是 `null`（基线未建立，
   `:1835`），而不是"门关着"。

## 8. 阅读顺序建议

**第一遍只看 3 个函数，不要打开整文件：**

1. `node_main.c:1986 app_main()` —— 尤其 `:2106-2168`：100 ms / 1 s / 5 s 三个节拍、任务创建、
   命令与上报的分工全在这 60 行。
2. `node_main.c:1494 sample()` → `:1745 judge()` → `:1692 active_danger()` —— "采集 → 当前最高危险 →
   状态迁移"这条链；配套读纯逻辑 `alarm_logic.h:84 alarm_raise_allowed()` 与 `:307 door_update()`。
3. `node_main.c:1819 report()` → `:1054 gw_send()` → `:1410 gateway_task()` —— 状态怎么变成 JSON、
   怎么进队列、断网时为什么只保留最新值（§5.2）。字段对照看 WT §3 的表，比报文格式串好读。

**第二遍换板端（homemon）：** `homemon.c:1052 main()` 只看循环体 `:1125-1293`（时钟跳变 → 宽限 → 采集 →
判定 → 执行/上报次序）→ `:496 handle_command()`（route/relay/ack/fall 清洗）→ `:773 tcp_pump()`
（8 槽位 + 半包重组）；优先级逻辑先看 `src/judge_logic.h:50`。

**第三遍按需：** `local_voice.c:124 playback_task()`（I2S 时序 + ADPCM + 代际取消）；
`Kconfig.projbuild` 当字典；`firmware/docs/NODES.md:60-97` 机型差异表常驻第二个屏幕。

**一句话记住本层**：ESP32 节点 = "一个主循环 + 一组纯逻辑头 + 一个网络从任务"；homemon =
"一个 1 秒轮询的 POSIX 守护进程 + 四个可单测纯逻辑头"。真正难的不是 C，而是 §5 那些代码之外的东西：
flash 余量、模拟前端（分压/电平/总线）、以及"什么时候该说话、什么时候该闭嘴"的安全语义。
