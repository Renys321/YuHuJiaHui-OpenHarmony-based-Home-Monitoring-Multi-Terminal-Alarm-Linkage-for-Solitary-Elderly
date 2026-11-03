# 工程交接文档

更新时间：2026-10-15（Asia/Shanghai）

## 1. 交接结论

项目局域网主干和 DAYU 真机流程已经收口。北向、南向、Bridge 和模拟节点均有可运行代码；APP 跨设备闭环、跨房间 pending、离线拒绝和同 ID 恢复已有真机证据。2026-10-14 视觉版已完成监护失联 watchdog、PC 触发帧原子保存/有限保留、DAYU 高分辨率自动抓拍和同事件去重；旧 signed HAP `BB994EA9...` 已在真实 DAYU 完成自动取证和 `online -> no_frame -> frames_resumed`。此后完成 PC 图片跨断网/重启持久补传、损坏证据拒绝、索引恢复和 DAYU 私有照片最多 100 张清理；视觉全量测试 56/56、照片策略 4/4、API 26 HAP 构建通过。2026-10-15 当前语音版 signed HAP `9186C504...` 已验签、安装，并在真实 DAYU 完成五种预置语音选择、AVPlayer `completed`、五次 HTTP 200 回执及未知资源失败路径。101 张照片保留边界仍未真机测试。详情见 `docs/evidence/2026-10-14-evidence-outbox-photo-retention.md` 与 `docs/evidence/2026-10-15-dayu-preset-voice-playback.md`。公网 HTTPS 后端、基础 API/真实监护人登录验收以及 DAYU200 家庭网关公网状态同步均已完成；队友 APP 手机真机和公网实体 ACK 闭环仍未完成。系统后台相机、开机自启、被杀恢复、真人数据集和 RKNN/NPU 仍未完成。

公网扩展已经注册 OneNET 产品、完整物模型和首个 DAYU200 设备，并新增 OneJSON/安全 MQTTS 传输层、常驻家庭云网关、可信 API 和原生微信小程序。可信后端已部署到 `https://api.luxunacc.xyz`：ECS、DNS、Let's Encrypt、Caddy、容器健康、匿名鉴权边界、真实 APP 登录和七组 API 合同均通过。`cloud/onenet/public-sync.js` 已以隐藏输入方式连接本地 MQTT 与公网 ACK 队列，且不依赖 OneNET 在线；当前家庭 Broker、Bridge、DAYU200 与公网同步进程均在运行，真实状态上传 202 和命令轮询 200 已由 Caddy 日志确认。尚未形成的是手机 APP 到实体设备的公网 ACK 闭环，ESP32 当前也未连接 Bridge 9101。YED-M100MG-B1 的 SIM、蜂窝注册和信号通过；GPS 已开启但尚未定位。YED 安全直连 OneNET 因 Y100E 服务器证书强制校验能力没有公开证据而暂停，不阻塞 HTTPS 公网主链路。

真实 ESP32-S3 已按当前源码完成重建、历史 COM9 及本轮 COM12 烧录、Wi-Fi/TCP 上行、NTP 同步和 13 位毫秒状态上报。本轮最终固件的错误、正确、重复 ACK 及 DAYU UI 已通过。仍未关闭的是新制品真实断线后的 APP 同 ID 恢复、真实 PIR/门磁/蜂鸣器以及实体声学输出。2026-10-15 现场确认未插耳机时听不到声音；裸板可听外放为 FAIL，耳机/有源音箱听测尚未进行。这些项目不得由模拟节点或播放状态日志外推为 PASS。

任何新的状态判断都应遵循以下优先级：

1. 原始日志和设备输出。
2. `docs/VALIDATION-MATRIX.md`。
3. 本文档。
4. 模块 README。
5. `docs/archive/` 中的历史说明。

历史汇总与原始日志冲突时，以原始日志为准。

## 2. 环境基线

| 项目 | 已核对值 | 说明 |
|---|---|---|
| 开发板 | HH-SCDAYU200 / RK3568 | 2026-10-10 第三轮真机证据 |
| 系统 | OpenHarmony 7.0.0.38 | 2026-10-10 第三轮真机证据 |
| API | 26 | HAP compatibleSdk 为 12，compileSdk 为 26 |
| `uname -m` | `aarch64` | 内核架构 |
| `getconf LONG_BIT` | `32` | 用户态位数；决定真机使用 ARM32 ELF |
| HDC target ID | 不在交接文档固定记录 | 使用 `hdc list targets -v` 动态核对，避免传播完整设备标识 |
| profile provision UDID | 不在交接文档固定记录 | 仅在本机签名流程中通过临时环境变量注入 |
| 当前连接状态 | **2026-10-15 USB Connected** | 唯一 USB 目标；当前真机证据见 `docs/evidence/2026-10-15-dayu-preset-voice-playback.md`；不固定记录 target ID/UDID |

2026-10-09 历史轮次中，PC 文件时间与设备日志曾相差 8 小时；第三轮预检已同时记录 PC 和设备时间并基本同步。阅读旧证据时仍需区分两套时钟。

## 3. 模块职责

| 模块 | 关键文件 | 职责 |
|---|---|---|
| 北向 APP | `northbound/entry/src/main/ets/pages/Index.ets` | 多设备状态、房间切换、ACK、离线判定 |
| 语音 Ability | `northbound/entry/src/main/ets/sosvoiceability/SosVoiceAbility.ets` | 从 rawfile 落盘后用 `fd://` 播放告警语音 |
| 南向服务 | `southbound/src/homemon.c` | 采集、状态机、日志、TCP、route/relay、语音触发 |
| 语音入口 | `southbound/say.sh` | 启动 `SosVoiceAbility` 并记录结果 |
| Bridge | `bridge/mqtt_bridge.js` | MQTT 上下行、无线节点接入、relay 注入和 route 定向转发 |
| Broker | `bridge/mqtt_broker.js` | 本地 MQTT 3.1.1 Broker |
| 模拟节点 | `bridge/sim_node.js` | 复现无线节点状态机和 ACK 行为 |
| ESP32 节点 | `esp32-node/main/node_main.c` | 经原始 TCP 上报到 Bridge 的无线节点真实固件源码；MQTT 由 Bridge 发布 |
| 视觉基线 | `vision/yolo_pose_service.py`、`vision/fall_detector.py` | YOLO Pose 推理适配、时序跌倒判定和受控 FALL 发布 |
| OneNET 接入 | `cloud/onenet/adapter.js`、`token.js`、`transport.js` | OneJSON、短期 Token、安全 MQTTS、云端确认和受限下行；不保存凭据 |
| 家庭云网关 | `cloud/onenet/gateway.js`、`cloud-sync.js`、`command-sync.js` | 常驻进程：状态聚合上云、同步可信后端、轮询小程序 ACK 队列、精确定向设备并等真实回执 |
| 可信 API | `cloud/backend/` | APP 短会话（可选兼容微信）、家庭授权、持久设备状态、远程查询和 ACK 待回执队列 |
| 手机小程序 | `mobile/wechat-miniprogram/` | 总览、房间、告警、设备/位置、联系人和点击拨号 |
| 4G/GNSS | `hardware/yed-m100mg-b1/` | 资料边界、接线与脱敏串口探测 |
| 启动脚本 | `materials/demo_start.ps1` | 部署、fport、Broker、Bridge、HAP 安装与启动 |

## 4. 已完成的实现

### 4.1 北向 APP

- `pendingDeviceId + pendingAckId` 双重绑定，避免切换房间后错误结算。
- Socket 发送成功后才进入等待态；发送失败立即反馈。
- 发送未落定或已有 pending 时拒绝新的 ACK。
- 告警行的确认中状态同时匹配设备 ID 和告警 ID。
- `deviceId` 白名单和处置文本 CR/LF 清洗。
- 按设备记录回程 Link；Link 断开时标记该连接见过的全部设备。
- `lastSeenMs` 使用本地接收时间，每 3 秒检查，12 秒超时离线，新状态自动恢复。
- 离线设备拒绝 ACK。

### 4.2 南向与目标路由

- `route <deviceId> <原命令>` 已实现。
- 目标为 DAYU 本机时由 homemon 本地执行；远端目标只广播完整 route 行。
- Bridge 按设备 ID 定向转发，并处理 TCP 分包、粘包。
- 普通状态 JSON 不会被误当成 route。
- homemon、Bridge、模拟节点和 ESP32 均限制嵌套 route/relay。
- ACK 要求当前状态为 `ALARM` 且 alarmId 精确匹配。

### 4.3 语音链路

- SOS 触发已下沉到 `alarm_raise()`，不再只覆盖实体按钮分支。
- `say.sh` 启动独立 Ability。
- rawfile 写入沙箱前会截断旧文件。
- AVPlayer 使用告警流、音量 1.0，并捕获 `release()` 异常。
- 真机日志已出现 `onCreate -> initialized -> prepared -> SPEAKER -> playing -> completed`。

### 4.4 启动与语音工具

- `Test-Port` 和协议探针均在 `finally` 中释放网络对象。
- `-WithWireless` 通过统一的 `Start-Node` 启动模拟节点，纳入精确进程清理和独立日志。
- PowerShell 多行输出使用数组级 `-match` 判断，已修复 HAP 安装成功却被误报失败的问题。
- `make_voice.ps1` 捕获 FFmpeg 的真实退出码，使用临时文件，完成非空和 Duration 验证后才替换目标；真实 M4A 成功转换和 FFmpeg 内部失败清理均已实测。落盘测试还修复了 `$Input` 与自动变量 `$input` 的冲突，并通过别名保持原 `-Input` 参数兼容。

### 4.5 YOLO Pose 跌倒检测

- 使用 `yolo11n-pose.pt` 提取人体框、关键点和 track ID，PC CPU 环境已能加载并执行推理。
- Ultralytics letterbox 保持非方形输入比例；`rect=True` 减少补边，检测结果按 `result.orig_shape` 恢复到原图坐标。规则、HTTP 接帧、watchdog、发布协调、证据存储和持久补传全量回归为 56/56。
- `VisionFrameStreamer.ets` 在 APP 前台且自动监护启用时从现有 Surface 串行采样 JPEG，经 `hdc rport tcp:9200 tcp:9200` 送至仅监听 PC 回环地址的服务，同一时间最多一个请求在途。
- 真实 DAYU 短时观测约 2 FPS；当前空房 UI 为“未检测到人体 · 15 帧 · 174 ms”。另一个真实非方形 DAYU 截图在当前模型路径中返回 `personDetected=true`、`fall=false`、`state=NORMAL`。
- 该实现的准确名称是“USB 有界采样帧 + PC CPU YOLO Pose”；不是“YOLO 已上板”、NPU 推理或公网视频链路。
- 判定要求近期直立、快速髋部下落、低位水平姿态持续 1.2 秒；床/沙发区可排除。
- 不同 track ID 会清空历史，避免把两个人的姿态拼成一次跌倒。
- 同一跌倒只发一次；恢复站立后才允许下一次事件。
- `--publish` 默认关闭；显式开启后发布 `{"cmd":"fall"}`，由 homemon 统一生成 alarmId、声光语音和 ACK 状态。
- 新 FALL episode 保存真正触发判定的原始 JPEG，并以原子 `index.json` 记录 SHA-256；默认最多保留 200 个事件。MQTT 重试沿用同一 evidenceId，不会把一次跌倒拆成多条证据。
- APP 收到新 evidenceId 后只调用一次 DAYU PhotoOutput，并把 DAYU 私有 JPEG 与 PC 触发帧文件名显示在页面；固定事件连续返回 126 次只新增一张照片，新事件可再次拍摄。
- 监护失联（2026-10-14 新增，**本地真机已验收**）：HTTP 接帧模式每 250 ms 轮询 `FrameWatchdog`，超过 `--frame-timeout-ms`（默认 10 s）无帧时经 `{"cmd":"monitor","state":"offline"}` → Bridge（白名单映射 `monitor <state> <reason>`）→ homemon 独立字段 `monitorOnline`（1/0/-1）→ 状态广播 → APP 摄像头卡片显示「PC 监护失联」；恢复来帧只报一次 `online`。当前 signed HAP、`homemon-arm`、页面失联和恢复均在真实 DAYU 通过；通知仍未到公网手机端。

## 5. 已验证、未验证与失败历史

简表如下，详细证据见 `docs/VALIDATION-MATRIX.md`。

| 范围 | 当前结论 |
|---|---|
| OH 7.0.0.38 / API 26 / 32 位用户态 | PASS（第三轮真机预检） |
| 当前自动取证 signed HAP 安装、APP 启动与失联/恢复 | PASS（当前哈希 `BB994EA9...`） |
| DAYU 软件 SOS 播放链路 | PASS（软件日志层） |
| DAYU ACK 状态、接受/拒绝及重复 ACK 不新增安全日志 | PASS |
| 本地目标路由集成测试 | PASS，8/8；不覆盖当前 Index.ets |
| 当前 `demo_start.ps1`（SHA-256 `BEE0C8...`）完整运行 | PASS；PowerShell 7，返回 0；绑定当时 `89A87F...` HAP，当前 Camera HAP 未重跑整套脚本 |
| 有效 JSON 的真机无线下行 | PASS；旧轮次无效载荷仍保留为历史 FAIL |
| 最新 APP 发起远端 route 并闭环 | PASS；错误、正确、重复 ACK 均覆盖 |
| APP 跨房间 pending 结算 | PASS |
| APP 12 秒离线、离线拒绝 ACK 与同 ID 恢复 | PASS |
| 真实 ESP32 构建、烧录、NTP 和毫秒上行 | PASS；最终证据见 `evidence/2026-10-10-final-esp32-and-bridge-hardening/` |
| 最终 ESP32 固件 APP 下行 ACK | PASS；真实节点错误/正确/重复 ACK 与 DAYU UI 已覆盖，非微信公网链路 |
| 真实 PIR、门磁、蜂鸣器 | NOT TESTED |
| 实体声学输出 | NOT TESTED |
| YOLO 规则/适配器、HTTP 接帧、FALL 重试、证据存储/持久补传与监护失联 watchdog | PASS（PC 自动测试基线，视觉全量 56/56） |
| monitor/FALL evidenceId 的 MQTT/Bridge 定向映射、非法输入拒绝与防状态回灌 | PASS（本地集成测试 18/18；FALL evidenceId 另有隔离 DAYU 真机协议验收） |
| APP 前台自动监护、合成 FALL 待处理与 APP ACKED | PASS（真实 DAYU；合成事件不代表真人准确率） |
| 应用被杀/系统重启/后台持续相机监护 | NOT TESTED |
| DAYU 系统相机枚举、预览与取帧 | PASS；自研 APP 授权、严格 4:3 预览、手动拍照和关闭重开 PASS |
| DAYU USB 有界采样帧 -> PC CPU YOLO -> APP 结果 | PASS；当前短时约 2 FPS，不依赖校园网 |
| 自研 APP 本地告警自动抓拍 | PASS；PC 触发帧 + DAYU 私有 JPEG + 同事件去重已真机验证 |
| 真人跌倒准确率、公网部署/手机图片查看与 RKNN/NPU | NOT TESTED |
| 常驻家庭云网关单元边界（`gateway.test.js`） | PASS，47/47 |
| 网关本地分层链路（真实 Broker + 真实 MQTT 报文 + 伪 OneNET） | PASS，14/14 |
| DAYU200 真机在线、系统基线与制品一致 | PASS（2026-10-13；设备标识已脱敏） |
| 真实 DAYU 状态经 Broker 到网关并上云、限频、告警去重 | PASS，17/17；证据 `evidence/2026-10-10-onenet-gateway-real-device/` |
| 板端系统时钟（当前会话） | FAIL（2026-10-14 历史记录，原样保留） |
| 板端时间回退根因与长期修复 | PASS（热重启后自动恢复）；真正断电保持性 NOT TESTED。根因：内核 `hctosys` 取 rtc0(rk808-rtc)=2017，电池 RTC rtc1(hym8563)=2021 且非启动时间源，板端无默认路由无法 NTP。修复：`southbound/dayu-time-sync.js`（HDC 下发 PC UTC + 写两个 RTC，once/watch，退避且读回校验）+ `southbound/src/time_util.h` 可信判定 + `homemon --selftest`；`materials/demo_start.ps1` 新增 0b 自动校时步。证据 `docs/evidence/2026-10-15-dayu-time-recovery.md` |
| 网关自身 RESET 的真机闭环（真实 DAYU 执行 + 真实回执） | PASS，20/20；证据 `evidence/2026-10-10-onenet-gateway-real-device/` |
| 生产入口 `npm run gateway` 启动健壮性（无密钥不崩溃、订阅本地 Broker） | PASS（2026-10-10 实测，修复 2 个启动期缺陷） |
| 网关聚合状态同步到可信后端（小程序数据来源） | PASS，12/12（`cloud/onenet/cloud-sync-integration.js`） |
| DAYU200 家庭网关真实公网状态同步 | PASS；43 次摄取 202、119 次命令轮询 200，证据见 `docs/evidence/2026-10-15-public-cloud-acceptance.md` |
| Bridge 同 ID 接管/退役缺陷 | PASS（2026-10-15 修复，真机 + 自动化 37/37）根因是 homemon 把桥接 `relay` 注入的状态原样广播回板端连接，板端连接出现第二个 deviceId 被判“改名”并退休（旧代码 retired 即永久不重连）；修复后配置端点永不自愈失效，relay 回灌不再改名/重复发布。证据 `docs/evidence/2026-10-15-bridge-multinode-recovery.md` |
| DAYU200 与 ESP32 同时上报 MQTT | PASS（2026-10-15 真机 62s 同窗口：21 条 + 13 条，均 13 位非 0、严格递增、偏差 <1.3s）；修复前 dayu200-living 在 MQTT 中自 18:4x 起永久停流 |
| 小程序 ACK -> 后端队列 -> 定向设备 -> ACKED 回写 | PASS，13/13（`cloud/onenet/command-sync-integration.js`，模拟设备、非公网/真机） |
| 后端家庭授权、证据存储/过期清理、持久化、写失败回滚和正式入口 | PASS，47/47（单进程 JSON/JPEG，不代表真实微信、公网或集群数据库） |
| PENDING 跨重启 -> 同步器 -> ACKED -> 再重启查询 | PASS，14/14（`persistent-command-restart-integration.js`，模拟设备） |
| 网关用真实 OneNET 凭据常驻运行 | NOT TESTED |
| OneNET 下行驱动真实 DAYU/ESP32 动作 | PARTIAL；本地伪 `property/set` 已驱动真实 DAYU RESET 并取得回执，真实 OneNET 下行与 ESP32 动作仍未验收 |

## 6. 当前权威制品

只认 `docs/ARTIFACTS.md` 中标为 CURRENT 的文件。真机南向入口是：

```text
southbound/out/homemon-arm
```

不要因为 `uname -m` 是 `aarch64` 而部署 `homemon-arm64`；当前用户态是 32 位。

ESP32 BIN/ELF 已在最终 `node_main.c` 之后重建，状态为 CURRENT；哈希、工具链、偏移和烧录证据见 `docs/ARTIFACTS.md`。

## 7. 下一步执行顺序

1. 常驻家庭云网关 `cloud/onenet/gateway.js` 已接好状态上行、evidenceId 和后端 ACK 命令同步，`gateway.test.js` 47/47、目录全量 132/132、本地 ACK 端到端 13/13，均通过。公网专用入口为 `cloud/onenet/public-sync.js`，只在交互终端隐藏读取 `INGEST_KEY`，不依赖 OneNET 设备密钥。
2. 可信后端已完成公网部署，状态为 `PUBLIC BACKEND READY`；家庭侧 Broker/Bridge/DAYU200/`public-sync.js` 也已运行并真实上传公网。证据见 `docs/evidence/2026-10-15-public-cloud-acceptance.md`。不要重复购买服务器/域名、安装 Docker、配置 DNS、上传部署包、创建第二套容器或重复启动同步器。下一步恢复 ESP32 当前连接，并由队友 APP 真机验证公网后端 -> 本地设备 -> ACKED；手机真机和实体 ACK 闭环仍为 `NOT TESTED`。
3. Node 串口工具已取代 PowerShell 5.1，YED 当前为 `COM7 @ 115200`，真实返回 `YED_DTU4_2.0.3`、`SSTA=3`、`CSQ=26/30`；蜂窝注册和信号已通过。GPS 已开启但 `NO_FIX`，先将 GPS 天线朝上放到室外 60 秒以上再运行隐私探测。YED 的 OneNET 模板/有证书 SSL 文档都限定 Air780，当前 Y100E 安全直连暂停；不得用明文 1883 或关闭证书校验绕过。
4. 队友 APP 按 `docs/APP-API-v1.md` 接入；登录口令由用户输入并保存到系统安全存储，禁止硬编码进安装包。微信小程序路线保留为可选兼容项，不再作为当前上线前置。
5. 网关状态上行已完成 DAYU200 真实公网验收，ACK 命令空队列轮询也已真实通过；仍需由手机 APP 创建真实命令并完成实体设备 `ACKED` 回写验收。
6. 前台自动 Camera Kit 4:3 监护、监护失联 watchdog、PC 触发帧索引和 DAYU 自动抓拍已在旧 signed HAP 真机通过；可信后端原图接口、30 天/200 条清理、PC 持久补传和微信授权预览代码也已本地通过。当前语音版新 HAP 已签名安装；DAYU 私有照片最多 100 张清理已实现并构建，但仍需做 101 张真机边界测试，并把真实图片从家庭侧上传公网后由队友 APP 手机真机预览。
7. 后台常驻路线已核对为不可行（API 26 `BackgroundMode` 无相机类型、需受限 ACL、未申请 `KEEP_BACKGROUND_RUNNING`），因此"无人值守 24 小时"仍需外部常驻设备（如 PC/网关侧）承担取帧；若用户要求手机级常驻，需另行确认系统能力与权限后再设计，不得用定时器伪装。
8. 固定摄像头机位并采集跌倒、坐下、弯腰、躺床、遮挡和无人视频，校准阈值与排除区；当前约 2 FPS 还需做长时 FPS、CPU、内存和温升验收。
9. 微信小程序告警订阅消息软件链路已修复三个真实设计缺陷并完成本地验证（`cloud/backend/src/notify-*.js`、`mobile/wechat-miniprogram/config/subscribe.js` 与 `services/subscribe.js`）：后端 139/139、小程序 59 checks + 17/17 通过。修复内容：①**允许登录 ≠ 已订阅**——新增经会话鉴权的订阅授权登记接口，收件人 = 允许登录名单 ∩ 已登记且有可用额度，且只能登记当前登录人自己；②**按收件人独立投递**——幂等键改为 deviceId+alarmId+recipientRef，修掉了"a 成功 b 失败时重复发送 a,b,a,b"和"a 永久失败阻断 b"两个缺陷；③**启动自动恢复**——`createRuntime` 启动时扫描未完成收件人任务并在后台补发，SENT 与 PERMANENT_FAILED 永不重发。持久化快照升到 schema v4（`notifications` 带 recipientRef、新增 `subscriptions` 授权额度），原始 openid 一律不落盘：收件人只用服务端 HMAC + 域分离得到的 `recipientRef`（`r1_` 前缀，明确不是裸 SHA-256）。**真实微信订阅消息仍然尚未发送成功**——需要正式 AppID/AppSecret、在公众平台申请到「告警通知」模板 ID（填入 `WECHAT_SUBSCRIBE_TEMPLATE_ID` 与 `config/subscribe.js` 的非敏感配置）、真实监护人 openid，以及用户在真机上点击授权。当前默认模板 ID 为空/占位：功能显示"未配置"且不发起任何授权请求，占位值会直接拒绝后端启动。一次性订阅语义已按实际行为呈现：文案是"已订阅下一次告警通知"，通知发送后额度消耗、需要再次点击订阅。
10. 跑通 `YOLO -> OneNET/本地链路 -> DAYU/ESP32 -> 微信小程序 -> ACK -> 设备回执`，分层保存证据。
10c. Bridge 的"同 ID 接管/退役"缺陷已定位并修复（2026-10-15）：根因是 homemon 会把桥接注入的 `relay` 状态**原样广播回板端连接**，板端连接因此出现第二个 deviceId 被 `bindNode()` 判为改名并 `retired`，而旧代码 retired 即永久停止重连（日志里的"已被同 ID 新连接替换，不再重连"只是通用文案，并无新连接）。修复后：配置端点永远按 3→30s 有界退避自愈、relay 回灌不改名不重复发布、同 ID 优先级确定；真机 62 秒同窗口同时收到 `dayu200-living` 21 条与 `esp32-bath` 13 条。重启 Bridge 的**同参脚本**在 `evidence/2026-10-15-bridge-multinode-runtime/start-bridge.cmd`（参数与旧进程逐字一致，日志追加不覆盖历史）。public-sync 仍离线，属另一工作包。

10b. 板端时间回退已定位并修复（2026-10-15）：根因是内核 `hctosys` 从 rtc0(rk808-rtc) 取得 2017 年时间，且板端无默认路由、无法访问 NTP。现在由 PC 侧 `node southbound/dayu-time-sync.js --once`（已并入 `materials/demo_start.ps1` 0b 步）或 `--watch` 常驻下发 PC UTC，并写回 rtc0/rtc1；homemon 增加了时间可信度日志、`time <epoch>` 命令和 `--selftest`。实测整板热重启后无需人工输入即恢复正确时间。**仍需用户做一次真正的拔电测试**，并把 `--watch`（或 demo_start）固定为开机后的常规动作；另外 Bridge 存在"板端读取连接被同 ID 连接替换后不再重连"的既有缺陷，会让 DAYU200 状态停在 MQTT 之前，需另行修复/重启。
11. 最终 ESP32 固件正确/错误/重复 ACK 已通过；下一步只复验真实断线后的 APP 同 ID 恢复，并在实体 PIR/门磁/蜂鸣器接线后用 `-UsePhysicalSensors` 验收，厨房/卧室节点到货后分别建证据。
12. DAYU 未接耳机时没有可听声音；插耳机后重播 `medicine_reminder.wav`，现场人员已确认“听到了”，所以耳机通道单条可听输出 PASS。仍需逐条播放五句话并确认文字、音量、清晰度和破音。不要把 `SPEAKER`/`completed` 日志写成裸板物理外放 PASS。确认 RKNN 工具链和许可后再决定是否迁移 NPU。
13. 远程交流第一阶段（监护人留言 → DAYU 播报预置语音 → 老人确认）的**软件实现已完成并通过测试**：后端 `cloud/backend` 208/208、小程序 64 checks + communications/subscribe 44/44、southbound 29/29。Codex 复核后补齐了播放租约闭环：DELIVERED 保留租约、崩溃后可重领、新租约拒绝旧代理回报、代理在 DELIVERED 回报失败时不播放且在 PLAYED 回报失败时不虚报成功；同一幂等 ID 改载荷返回 409，服务端 EXPIRED 迁移可真正落盘。新增 `cloud/backend/src/comms-core.js`、交流 API、PersistentStore schema **v4 → v5**，以及 `southbound/comms-agent.js` + `comms-run.js`（一次性 CLI，**无长期驻留**）。本阶段**不含**录音、实时通话、WebRTC、VoLTE 或自动电话。
14. 远程交流第二阶段——**DAYU200 HAP 五种预置语音选择与真实播放完成回执**的软件部分已完成并验证：
    - **回执机制**：`southbound/comms-agent.js` 在 `127.0.0.1` 起一次性监听器（系统分配端口 + 256-bit 一次性 nonce），通过 `aa start --ps voiceResource/playbackMessageId/callbackPort/callbackNonce` 传给 HAP；`SosVoiceAbility.ets` **只有 AVPlayer 真正进入 `completed`** 才 POST `http://127.0.0.1:<port>/playback-result`；代理用 `crypto.timingSafeEqual` 同时核对 messageId 与 nonce，**只有收到正确回执才向后端回报 `PLAYED`**。
    - **明确排除的假成功**：`aa start` 退出码不算播放完成；非零退出立即 `PLAYER_FAILED`，不再空等 30 秒；不使用 sleep；Ability 启动不等于播完；未知 `voiceResource` 直接 `UNKNOWN_VOICE` 失败且**绝不回退** `sos.wav`；任一远程参数出现但上下文不完整时 fail-closed；旧 `sos.wav` 告警路径（完全无远程参数）行为不变。HAP 还校验 `playbackMessageId` 格式，并忽略旧 AVPlayer 的迟到事件，避免干扰当前重试。
    - **测试**：southbound `comms-agent` **40/40**（含 `aa` 非零立即失败、回执协议、伪 nonce/伪 messageId/非 JSON/重复回执/超时/句柄清理，并用 `fixtures/fake-aa.js` 走真实回环 HTTP 端到端），CLI 4/4 + 6/6，southbound 合计 **50/50**；HAP 源码守卫 **11/11**、WAV 工具 **11/11**、在线 TTS **10/10**、资源事务提交/回滚 **2/2**；后端 **215/215**，无回退。在线用例在端点或解码器不可用时使用 Node 正式 `skip`，不再提前返回造成假绿。
    - **构建**：上述加固 + 五段语音入包后重新执行 hvigor `assembleHap`（debug、unsigned）并得到 **BUILD SUCCESSFUL**；当前产物 `entry-default-unsigned.hap` **1 774 208 字节**，SHA256 `384DD3B8A1196F94BF0F065DD2A6E2D8C850BA64E384CE01692A1EA6E49BB533`，包内 `resources/rawfile/` 共 **6 个**（`sos.wav` + 5 个预置语音）。
    - **五段预置语音已生成并校验（AUDIO ASSETS BLOCKED 已解除）**：本机 SAPI 确认完全不可用（`ISpVoice::Speak` 在 SpFileStream / SpMemoryStream / 默认设备 / System.Speech 四条路径一律 0xC0000005 崩进程；已排除 STA 线程、三种 WAVEFORMATEX 布局、BindToFile/Open 写法；音频端点与 Audiosrv 均存在）。改用**无密钥在线 TTS**路线：`tools/tts/online-tts.js` 记录引擎名称/端点/`requiresKey:false`（Baidu Fanyi web TTS `gettts`，`audio/mpeg`）→ `tools/tts/mp3-to-pcm.exe`（系统自带 Windows Media Foundation Source Reader 解码）→ `tools/tts/wav.js`（既有校验器，无第二套标准）→ 写入 rawfile。实测：16 kHz / 单声道 / 16-bit PCM / 3.711–4.935 s / RMS 0.158–0.170 / 峰值 0.687–0.833 / 有效语音 65–77% / 削波 0.00% / 5 个 SHA-256 互不相同。`make-assets.js` 新增 `--synth-online`、`--force`，保留 `--check`；五个文件先写入同卷临时目录，覆盖前备份旧文件，任一步失败会回滚，避免留下半套资源；不复制 `sos.wav`、不生成占位音频。`.tts-work/` 已加入忽略规则。新增依赖：**无**（只用系统 DLL 与 Node 内置模块）。
    - **DAYU200 真机播放预置语音已 PASS**：2026-10-15 当前语音版 HAP 已签名、验签并安装；五个指定 rawfile 均在真实 DAYU 上进入 `playing -> completed`，五次 `COMPLETED` 回执经 HDC `rport` 到达 PC 一次性监听器并通过 `messageId + nonce` 校验，HTTP 均为 200；未知资源返回 `FAILED/UNKNOWN_VOICE`，没有回退或误报完成。证据见 `docs/evidence/2026-10-15-dayu-preset-voice-playback.md`。
    - **真实本地后端状态闭环也已 PASS**：新增 `southbound/hdc-player.js` 和 `tools/acceptance/dayu-comms-hdc.js`；真实 PersistentStore/API 创建 `QUEUED` 留言，真实代理报告 `DELIVERED`，DAYU 播放 `medicine_reminder.wav` 至 `completed` 并回执后，后端最终为 `PLAYED`；二次领取为 0，临时 HDC 映射清理。首次适配失败时后端正确落为 `FAILED`，证明不会因 HDC 启动成功而假报播放。southbound 全量 **56/56**。证据见 `docs/evidence/2026-10-15-real-backend-dayu-played.md`。该结论仍不包含公网后端或手机。现场确认未插耳机时听不到声音，裸板可听输出为 FAIL；插耳机重播用药提醒后确认“听到了”，耳机单条可听输出 PASS，但文字、音量、清晰度、破音和其余四句仍未确认。老人实体按钮 -> `ACKED` 的本机路径仍未接入、未真机验证，`PLAYED` 不自动等于 `ACKED`。

## 8. 协作与文件锁

规则：

- 同一时间 Codex 与 DeepSeek 不得修改同一文件。
- 双方唯一共享进度入口是 `docs/AI-COLLAB.md`；每轮开工先读，结束后写明实际改动、测试证据和未验证边界。
- DeepSeek 协作使用用户可见的 Harness 桌面会话和 `love` 账号，不使用本地网页账号；双方完成后由 Codex 独立执行测试。
- DeepSeek 的测试轮次默认只写新的证据文件和运行日志。
- 原始证据只增不改；更正结论写入新的索引或验证矩阵。
- 任何 PASS 必须指向具体原始证据和对应源码/制品版本。
- APP UI 无法可靠操作时标记 `NOT TESTED`，不能以 Bridge 日志替代 UI 结论。

## 9. 接手检查清单

```text
[x] 阅读并更新 docs/VALIDATION-MATRIX.md
[x] 核对 docs/ARTIFACTS.md 中 CURRENT 制品哈希
[x] 运行 hdc list targets，确认目标在线
[x] 核对 API、系统版本、LONG_BIT
[x] 修复并复核启动脚本失败路径
[x] 第三轮真机测试使用新的证据目录和文件名
[x] 最终结论逐条绑定原始证据
[x] 以当前源码重建并验收真实 ESP32 上行固件
[x] 实现常驻家庭云网关第一阶段并完成分层验收（32 项单测 + 14 项本地真实链路）
[x] 当前 DAYU Camera 4:3 预览/拍照版 HAP 安装、真机预览、JPEG 保存、关闭重开与资源释放
[x] 当前参数化启动脚本在 DAYU 上完整运行
[ ] 用真实 OneNET 凭据常驻运行网关并验收下行驱动真实设备
[x] 在最终固件上完成 APP 下行 ACK 复验
[ ] 完成真实 PIR、门磁和蜂鸣器验收
[ ] 完成实体声学输出验收
```

## 10. 敏感信息边界

- `northbound/signing/profile-debug.json`、签名脚本和部分历史证据含完整设备标识。
- `northbound/local.properties`、ESP32 脚本和生成树含本机绝对路径或局域网配置。
- ESP32 配置包含真实局域网 SSID、密码、网关 IP 和端口，外发前必须脱敏。
- 对外提供日志或配置前，应脱敏设备标识、主机路径和网络地址。

