# 06 · 知识点地图（技术域 → 项目实例 → 怎么学）

> 用法：每个知识点给三样东西——**是什么/为什么**、**本项目用在哪（可跳转）**、**学到什么程度够用**。
> 等级：★ 了解即可 / ★★ 能读懂并改 / ★★★ 能独立设计。

---

## 1. 嵌入式与设备（C / ESP-IDF / FreeRTOS）

| 知识点 | 是什么 | 本项目实例 | 等级 |
|---|---|---|---|
| ESP-IDF 构建系统 | 组件（component）+ CMake + Kconfig + sdkconfig 分层 | `firmware/common/components/elder_node/CMakeLists.txt`、`Kconfig.projbuild`；三节点靠 `<node>/sdkconfig.defaults` 区分 | ★★★ |
| Kconfig 条件编译 | 一个源码编出多机型 | `node_main.c` 里大量 `#if CONFIG_NODE_XXX >= 0`；`voice_pins.h` 用 `#error` 挡引脚冲突 | ★★★ |
| FreeRTOS 任务/队列 | 抢占式调度、栈、优先级、队列通信 | `gateway_task`（网络独占 socket）、`local-voice`（只播音频）、`s_reports` 用 `xQueueOverwrite` 只留最新 | ★★★ |
| 轮询式主循环 | 用固定 tick 代替"每传感器一个任务" | `app_main` 100ms tick：SOS 扫描 / 1s 采样判定 / 5s 上报 | ★★ |
| ADC oneshot + 衰减 | 12-bit ADC、量程由衰减决定 | MQ-2/MQ-5 原始值；`ADC_ATTEN_DB_12` → 满量程约 3.1–3.3V | ★★ |
| GPIO 消抖 | 机械/电平抖动过滤 | PIR、门磁、SOS 的"连续 N 次确认 + 回差" | ★★ |
| I2C | 总线、地址、寄存器 | AHT20 温湿度（SDA4/SCL5）、XL9555 IO 扩展（蜂鸣器/KEY0） | ★★ |
| 单总线 | 时序敏感协议 | DHT11（客厅节点 GPIO11），需要临界区保护时序 | ★★ |
| I2S + 音频 codec | 数字音频总线、采样率、DMA | ES8388 + 16kHz IMA-ADPCM 离线语音；"为什么不用 MP3/WAV"= flash 容量与解码依赖 | ★★ |
| NVS 持久化 | 掉电保存小数据 | 门磁事件 `seq`（重启不复用）、今日计数 | ★★ |
| 电源/电池 | 分压、校准、低电阈值 | `battery_logic.c`（分压比、增益/偏置、低电/最低/最高） | ★★ |
| TCP 行协议 | 以 `\n` 分帧的应用层协议 | 设备→bridge 的 JSON 行；要处理半包/粘包/背压 | ★★★ |

---

## 2. Linux 系统编程（板端 homemon，C）

| 知识点 | 项目实例 | 等级 |
|---|---|---|
| 非阻塞 socket + select 多路复用 | homemon 单线程同时服务 APP/bridge/mirror 多客户端 | ★★★ |
| 广播与慢客户端处理 | 状态行广播给所有客户端；`EAGAIN` 只丢本条不杀连接 | ★★★ |
| sysfs GPIO / `/dev/saradc` | 板端 GPIO 与 ADC 读取（不用内核驱动/DTS） | ★★ |
| 进程与 exec | `say.sh` → `aa start SosVoiceAbility` 拉起语音 Ability | ★★ |
| 严格状态机与幂等 | ACK 必须 `alarmId` 匹配 + 当前 ALARM + 未确认过 | ★★★ |
| 安全清洗 | `route/relay` 禁嵌套、deviceId 白名单、CR/LF 清洗 | ★★ |
| 日志与审计 | `safety.log`（设备级处置记录）、`status.json` | ★★ |

---

## 3. 网络与协议

| 知识点 | 项目实例 | 等级 |
|---|---|---|
| TCP 粘包/半包与分帧 | 行协议累积缓冲；bridge 按 `\n` 切行 | ★★★ |
| TCP keepalive / 超时 | ESP32↔bridge、bridge↔broker 均设 keepalive；在线判定 12s | ★★ |
| MQTT 3.1.1 | 自包含 broker：CONNECT/SUBSCRIBE/PUBLISH/PING、`+`/`#` 通配、QoS0 语义 | ★★★ |
| 发布/订阅与多终端 | 同一 `home/<id>/status` 多订阅者=多手机 | ★★ |
| WebSocket | 视频帧 WS 传输、二进制分帧 | ★★ |
| TLS | OneNET MQTTS：CA + **证书指纹固定**（无 SAN 的替代方案）、`rejectUnauthorized=true` | ★★★ |
| HTTP REST + 鉴权 | APP↔backend：Bearer 会话、错误码约定（`docs/APP-API-v1.md`） | ★★ |
| 幂等与去重 | 告警 `(deviceId,alarmId)`、门磁 `(deviceId,seq)` | ★★★ |
| 指数退避 | bridge/MQTT/relay 重连阶梯（3→6→12→24→30s） | ★★ |
| 单实例锁 | PID 锁 + 陈旧锁接管，防两个 bridge 重复发布 | ★★ |

---

## 4. 云与分布式（Node.js）

| 知识点 | 项目实例 | 等级 |
|---|---|---|
| supervisor/worker 进程模型 | public-sync：supervisor 管 worker、心跳、熔断、重启退避 | ★★★ |
| 心跳与健康判定 | `state.json`（state/heartbeatAt/workerPid）→ watcher 五要素判健康 | ★★★ |
| 熔断 | 3 次/5min 失败 → CIRCUIT_OPEN 60s 后重试 | ★★ |
| 密钥不落盘 | INGEST_KEY 从 TTY 读、只在内存、worker 不继承 | ★★★ |
| 存储抽象 | `store.js`（内存）vs `persistent-store.js`（原子写/加载/迁移） | ★★★ |
| 限频与节流 | 稳定状态 30s 限频、事件按 alarmId 去重 | ★★ |
| 通知投递 | `notify-provider/delivery/privacy`：多渠道、隐私脱敏 | ★★ |
| 部署 | Docker Compose、Caddy 自动 TLS、仅容器网络监听 | ★★ |

---

## 5. OpenHarmony 应用（ArkTS / ArkUI）

| 知识点 | 项目实例 | 等级 |
|---|---|---|
| 声明式 UI + 状态管理 | `@State/@Prop/@Link/AppStorage`；页面随 Model 变化重绘 | ★★★ |
| 组件化 | `SensorCard`、`AlertItem`、悬浮 SOS 按钮 | ★★ |
| 页面路由 | 首页/监测/设备/告警详情/统计/我的 | ★★ |
| 网络 | `@ohos.net.http`（API）+ `@ohos.net.webSocket`（视频） | ★★ |
| 分层 | API(DTO) → Mapper(ViewModel) → Page/Component；页面不直接读原始 JSON | ★★★ |
| 能力模型（capability） | 设备是否安装/启用/报警启用；决定卡片是否显示与文案 | ★★★ |
| 板端 TCP 客户端 | 板端 APP 直连 homemon 9000，行协议 + 在线判定 + 命令路由 | ★★★ |
| HAP 构建/签名/安装 | hvigor、debug 签名、`hdc install`、开发镜像接受未签名包 | ★★ |
| UI 自动化取证 | `uitest dumpLayout`/`uiInput` 做页面断言与登录自动化 | ★★ |

---

## 6. 视觉与算法

| 知识点 | 项目实例 | 等级 |
|---|---|---|
| 人体关键点检测（Pose） | YOLO11n-pose：17 点、置信度、trackID | ★★★ |
| 单帧分类 vs 时序判定 | 跌倒用"直立→髋部骤降→低位水平持续"状态机，抗单帧误判 | ★★★ |
| 阈值与防误报 | 规则阈值 + 持续时间 + track 隔离（不同人/不同 track 不拼接） | ★★★ |
| 模型导出/部署 | Ultralytics→NCNN（板端 CPU）→RKNN（规划，NPU） | ★★ |
| 帧率/分辨率/带宽 | 320 输入、推理 p50 约 605ms、丢帧约 29% | ★★ |
| 视频编码 | 当前 JPEG 序列帧（简单、带宽高）；替代 H.264/WebRTC | ★★ |

---

## 7. 工程化与协作

| 知识点 | 项目实例 | 等级 |
|---|---|---|
| 证据驱动开发 | `evidence/<日期-主题>/` 存命令输出、原始日志、SHA256 | ★★★ |
| 三层测试 | 主机侧 C 单测（纯逻辑 header）、Node `node:test`、APP 行为测试 | ★★★ |
| 脚本健壮性 | PowerShell 5.1 编码/BOM、`$ErrorActionPreference`、交互确认、MAC 核对 | ★★ |
| 版本与制品 | HAP/固件哈希、`docs/ARTIFACTS.md`、冻结包 | ★★ |
| 可观测性 | watcher 状态文件、进程健康端点、日志轮转 | ★★ |
| 安全边界意识 | 明确写"局域网无 TLS、仅受控环境"，不把未验收说成已验收 | ★★★ |

---

## 8. 一分钟自测（能答上来就算读懂主线）

1. 为什么 ESP32 不实现 MQTT？bridge 在链路里承担了什么？
2. `home/<deviceId>/status` 的 `deviceId` 为什么是路由主键，而不是房间名？
3. 为什么"HTTP 202 成功"不等于"告警已处置"？闭环的判据是什么？
4. 门磁事件为什么需要单调 `seq`？后端拿它做什么？
5. 为什么视觉只发"受限 fall 命令"而不是直接改告警状态？
6. `hdc fport` / 两路 ESP32 共因 / `INGEST_KEY` 为什么是三个单点？
7. 板载 APP 的 `4/4` 是怎么算出来的？为什么不能当链路探针？
8. 为什么改 `sdkconfig.defaults` 后要先删 `sdkconfig`？

> 答案分别在 `01-ARCHITECTURE.md`、`02-DEVICE.md`、`03-APP.md`、`04-TRANSPORT-CLOUD.md`、`05-VISION-VIDEO.md` 里。
