# 05 · 视觉与视频（YOLO Pose 跌倒判定 + 视频探望中继）

> 范围：`competition/vision/`（Python + NCNN）与 `competition/video/relay/`（Node.js WebSocket 中继）。
> 标记约定：`✅实测` / `🟡未实测`（已实现但只有单测/离线验证）/ `⬜未实现` / `↔其他层`。
> 上下游：视觉结果最终由板端 homemon 生成 alarmId｜视频不产生任何状态变更（见 `01-ARCHITECTURE.md` F4/F5）。

---

## 1. 本层职责与边界

### 1.1 一句话职责

- **视觉**：把摄像头画面变成"一条受限的 `fall` 命令"，**不生成告警 ID、不写设备状态、不做闭环**。
- **视频**：把板端 JPEG 帧**鉴权后转发**给手机，**不解码、不转码、不落盘、不录像、不看回放**。

两条链路共用同一台 PC，但**故障域完全独立**：视觉挂了不影响视频，视频挂了不影响监护（`vision/README.md:50-51` 明确"视觉服务失败不会阻塞预览、监护、语音、联网、告警或 ACK"）。

### 1.2 边界表

| 边界 | 属于本层 | 明确不属于本层（↔其他层） |
|---|---|---|
| 关键点提取 / 跌倒时序判定 | `vision/fall_detector.py`、`vision/yolo_pose_service.py` | 板端相机采集与编码（板端 APP / VideoStreamServer） |
| `fall` / `monitor` 命令的 MQTT 发布 | `yolo_pose_service.py` 用 `mqtt_tool.js` 发布 | 命令如何落到设备、`alarmId` 怎么生成：`bridge` + `homemon`（02-DEVICE） |
| 跌倒证据 JPEG 落盘 / 上传 | `vision/evidence_uploader.py` | 证据的鉴权读取与 30 天保留：`cloud/backend`（04-TRANSPORT-CLOUD） |
| 观看票据、WS 帧分发、空闲停流 | `video/relay/src/*` | APP 端解码渲染、像素图释放（APP 文档） |
| 公网部署件 | `deploy/video/`（Caddy `/video/*` + 容器） | backend 主栈（04-TRANSPORT-CLOUD） |

### 1.3 信任与密钥边界（本层最容易被忽略）

| 密钥/凭据 | 谁持有 | 约束 |
|---|---|---|
| `BACKEND_INGEST_KEY`（证据上传） | 只从 `--evidence-ingest-key-env` 指定的**环境变量**读 | 不进命令行/URL/outbox/日志（`vision/README.md:115-116`） |
| APP 会话 token | 手机 APP 持有 | 只走 `Authorization` 头；relay 用它换**一次性 ticket**，日志只留 ticket 前 6 位（`video/relay/src/relay.js:172-176`） |
| `VIDEO_AGENT_KEY`（PC agent ↔ ECS relay） | 部署机 `video.env`（600） | relay 日志与 URL query 都不外泄；`agent-client.js:84-88` 打印前先剥 query |
| 板端视频口 9301 | 只经 `hdc fport` 暴露到 `127.0.0.1` | relay/agent **不直通** 9301，也没有"免鉴权流"入口（`video/relay/README.md:190-198`） |

---

## 2. 代码地图

### 2.1 视觉（`competition/vision/`）

| 文件 | 行数 | 职责 | 关键函数:行号 |
|---|---|---|---|
| `yolo_pose_service.py` | 941 | 服务入口：HTTP 接帧、模型适配、证据落盘/上传、看门狗、发布协调 | `primary_pose:194`、`MqttCommandSink:227`、`FrameWatchdog:276`、`FallPublishCoordinator:387`、`create_frame_handler:593`、`run_http_ingest:664`、`process_result:569` |
| `fall_detector.py` | 551 | **纯规则**状态机（不依赖 YOLO/OpenCV/NumPy），可复用于 RKNN | `PoseFrame.from_coco:39`、`features:176`、`update:218`、`snapshot:361`、`_ground_hit:476`、`find_zone_conflicts:491` |
| `vision_guardian.py` | 472 | 独立守护：子进程崩溃/端口关闭/健康失败 → 只报一次 offline + 有界退避重启 | `VisionGuardian:76`、`tick:169`、`InstanceLock:230`、`_pid_alive:236` |
| `evidence_uploader.py` | 484 | 证据上传：HTTPS 校验、sha256 一致、outbox 原子对账、后台有界队列 | `EvidenceUploader:41`、`EvidenceUploadOutbox:117`、`EvidenceUploadWorker:322` |
| `frame_orientation.py` | 161 | 帧方向合同：推理前旋转、启动期一次性解析、运行期方向看门狗 | `rotate_image:47`、`resolve_startup_rotation:86`、`OrientationWatchdog:127` |
| `start_dayu_usb_vision.cmd` / `start_dayu_usb_guard.cmd` | — | 真机启动器：校验 `hdc rport tcp:9200` 后启动服务（guard 版带 `--publish`） | — |
| `dayu-local/export/export_ncnn.py` | 6 | 一行 Ultralytics 导出 NCNN（`imgsz=640`） | 全文 6 行 |
| `dayu-local/export/ncnn_reference.py` | 121 | PC 侧 ncnn 参考实现：复现板端 C++ 的 letterbox/NMS/17 点解码 | `letterbox_params:12`、`nms:23`、`detect:43` |
| `test_*.py` | — | 43 项单测（合成序列），**不替代真人准确率**（`README.md:151-156`） | — |

### 2.2 视频（`competition/video/relay/`）

| 文件 | 行数 | 职责 | 关键入口 |
|---|---|---|---|
| `server.js` | 65 | relay 进程入口：配置 → 日志 → 启动 → 信号处理 | `main:17` |
| `agent.js` | 124 | PC agent 入口：`--relay/--key/--dayu` 参数解析 | `parseArgs:40`、`parseDayu:31`、`main:62` |
| `src/relay.js` | 386 | HTTP/WS 主服务：token 复核、ticket 签发、升级路由、限流 | `handleSessionCreate:154`、`handleSessionEnd:184`、`onUpgrade:258` |
| `src/frame-hub.js` | 264 | viewer 集合、空闲停流、断线宽限、心跳、fps/健康、慢客户端丢帧 | `addViewer:74`、`removeViewer:99`、`_onFrame:141`、`health:54` |
| `src/dayu-link.js` | 307 | local 模式：TCP 连 9301，`hello/start/started/stop` 握手 + 帧解析 | `_connect:124`、`_handleControlLine:193`、`_onLinkFailure:261` |
| `src/agent-channel.js` | 194 | agent 模式 relay 侧：注册、start/stop 指令、帧接收 | `attach:57`、`_onText:109`、`start:167` |
| `src/agent-client.js` | 426 | PC agent：出站 WSS + DAYU TCP 双向转发 + 双端退避 | `normalizeRelayUrl:21`、`_connectRelay:133`、`_connectDayu:217` |
| `src/frames.js` | 70 | 4 字节大端长度 + JPEG 帧协议；增量解析器 | `encodeFrame:13`、`isJpeg:23`、`createFrameParser:33` |
| `src/ticket-store.js` | 84 | 一次性 64 hex ticket，60s TTL，只存 token 的 sha256 | `issue:27`、`consume:45`、`revokeForSession:55` |
| `src/rate-limit.js` | 51 | 滑动窗口限流（按 token 的 sha256） | `check:28` |
| `src/config.js` | 172 | 全部 env 解析 + local/agent 模式推断 + 可打印摘要 | `loadConfig:106`、`publicSummary:157` |
| `src/logger.js` / `src/ws.js` | 82 / 18 | 日志脱敏（注册 secret 后替换） / `ws` 加载器（node_modules 优先，`vendor/ws` 兜底） | — |
| `deploy/video/*` | 739 | ECS 部署件：compose、Caddy 补丁、幂等安装/回滚 | `install-on-ecs.sh`、`rollback.sh` |

---

## 3. 关键流程

### 3.1 视觉：取帧 → 推理 → 关键点 → 规则状态机 → `fall` 命令

```
DAYU APP 前台采样 JPEG（4:3 Surface）
  └─hdc rport tcp:9200─> PC 127.0.0.1:9200  HTTP POST /v1/frames/<sourceId>
        ├─ 类型必须 image/jpeg、Content-Length 必填、≤2MiB、长度必须读满   (yolo_pose_service.py:613-632)
        ├─ 解码失败 → 422；处理异常 → 500，绝不让进程崩                    (:633-641)
        └─ process_jpeg:
             1) 若配了 --frame-rotation auto：只做方向校准，**不判定、不发布**  (:737-790)
             2) 推理前旋转（rotate_image），保证关键点/框与原图同系         (:731-733)
             3) YOLO track 单帧推理（ByteTrack persist + rect=True）        (:542-554)
             4) primary_pose：取“面积×置信度”最大的人 → PoseFrame（归一化）  (:194-224)
             5) FallDetector.update()：时序规则 → 可能返回 FallEvent        (:218-359)
             6) 命中 → 先原子保存触发帧 JPEG + index.json，再入发布队列      (:828-852)
```

判定状态机（`fall_detector.py:316-359`）：

```
NORMAL ──(近 6s 内直立 且 近 1.2s 髋部快速下坠 且 水平 且 低位 且 不在排除区)──> SUSPECTED
SUSPECTED ──(水平+低位持续 ≥1.2s 且未超时 3.5s 且未恢复直立/未进排除区)──> FALLEN（只发一次事件）
FALLEN ──(直立持续 2s)──> NORMAL（允许下一次跌倒再报）
```

输出到 MQTT 的命令（两种，都由 `yolo_pose_service.MqttCommandSink` 经 `mqtt_tool.js` 发布）：

```json
{"cmd":"fall","score":0.62,"source":"yolo-pose","evidenceId":"fall-1791..."}
{"cmd":"monitor","state":"offline","reason":"no_frame","source":"yolo-pose"}
```

- 发布是**定时重试**、不依赖下一帧：`FallPublishCoordinator` 每 2s 试一次，30s 仍未成功则
  丢弃陈旧事件（`yolo_pose_service.py:387-428`，主循环 `:870-874`）。原因很直接：帧停了也得能补发。
- bridge 侧对 `{"cmd":"fall"}` 有严格 `evidenceId` 正则白名单（`bridge/mqtt_bridge.js:709-723`），
  `monitor` 的 state/reason 也走白名单（`:724-735`）——视觉侧即使被构造成"随便传字符串"也过不去。

### 3.2 PC 侧双 watchdog（视觉独有的"失联"语义）

```
FrameWatchdog（进程内，yolo_pose_service.py:276-352）
  starting ──首帧──> online ──>10s 无帧──> offline(no_frame)
  starting ──15s 仍无首帧──> offline(no_first_frame)
  offline ──来帧──> online(frames_resumed)
  另：每 60s **重发当前状态**（不增加 episode），用于 homemon 重启后重新同步

vision_guardian.py（进程外，守护 yolo 子进程）
  子进程退出 / 9200 端口关 / /healthz 连失败 3 次 ──> 只发一次 monitor offline
  然后 2s→5s→10s→30s 退避重启；稳定 60s 后重置退避 (vision_guardian.py:39-41,138-166)
  **绝不发布 online**——online 只能由 YOLO 自己"收到第一帧"后发出 (:11-13)
```

两层的分工是刻意的：进程内 watchdog 只能证明"我还在、但没帧"；一旦进程死了它自己也不存在，
所以必须有**进程外**守护（`vision_guardian.py:3-21` 写了这起事故的推理链）。

### 3.3 视频：票据 → WS → relay → 9301 帧流 → 空闲断开

```
手机 APP
  │ POST /video/session  Authorization: Bearer <APP token>
  ▼
relay: 无 token → 401；按 sha256(token) 限流(10 次/60s) → 429          (relay.js:154-165)
       → fetch ${BACKEND_BASE}/api/v1/overview 复核（唯一鉴权来源）     (relay.js:133-152)
       → 200 {ticket(64hex), expiresInMs:60000, wsPath}               (relay.js:171-181)
  │ WS GET /video/stream?ticket=…
  ▼
relay: consume(ticket) —— 一次性、60s TTL、重放返回 null               (ticket-store.js:27-52)
       → hub.addViewer：超并发(2) → BUSY + 1013                      (frame-hub.js:74-82)
       → 先发文本 {"type":"ready","proto":1,"camera":"640x480"}       (frame-hub.js:90)
       → source.start(viewerId)   ← **有观众才开始取帧**
  ▼
local 模式：DayuLink TCP → 127.0.0.1:9301
   服务端 hello → relay 发 start → 服务端 started → 之后 4B BE 长度 + JPEG (dayu-link.js:193-240)
agent 模式：relay 发 {"type":"start"} → PC agent 连 DAYU → 帧经出站 WSS 回传 (agent-channel.js:163-176)
  ▼
hub 广播：每条 WS **二进制消息 = 一帧 JPEG**；手机缓冲 >2MiB 时丢帧        (frame-hub.js:141-172)
  │ 手机退出 / 断线
  ▼
removeViewer → 空闲 3s 无新 viewer → source.stop() → 向 DAYU 发 stop 并断开 (:99-123)
```

断线语义（`frame-hub.js:174-214`）：DAYU 掉线时**保留 viewer**、暂停画面，30s 内恢复则发
`{"type":"resumed"}`；超过宽限发 `{"type":"error","code":"DAYU_DOWN"}` 并用 1011 关闭。
`/video/session/end` 是"隐私优先"设计：后端不可达（status=0 或 5xx）也照样停流，
只在后端明确 4xx 拒绝时才回 401（`relay.js:184-208`）。

---

## 4. 关键技术点

### 4.1 YOLO Pose 关键点（COCO 17 点）

- 只用 17 点中的**肩中心和髋中心**做姿态几何：`midpoint()` 要求左右两点置信度都 ≥ 0.35，
  否则该帧直接判 `valid=false`（`fall_detector.py:179-196`）。
- 躯干角：`atan2(|dx|, |dy|)`，0° = 竖直，90° = 水平（`:198-200`）。用**绝对值**，
  与画面上下翻转无关；方向问题由 §4.9 的独立合同处理。
- 所有坐标在 `PoseFrame.from_coco()` 里用 `image_width/height` **归一化到 [0,1]**（`:55-81`），
  因此后续阈值与分辨率/机位距离无关。这也解释了 README 的强调：**不能用 APP 预览控件的
  屏幕尺寸**（`vision/README.md:9-10`）。
- 多人场景只取一个人：按 `框面积 × 置信度` 选最大（`yolo_pose_service.py:200-208`），
  并用 ByteTrack 的 `trackId` 做**跨帧身份隔离**；track 变化即重置状态机（`fall_detector.py:242-249`）。

### 4.2 时序判定 vs 单帧分类

本层**明确不是**"单帧图像分类跌倒"，而是 5 个条件同时成立的**时序规则**
（`vision/README.md:12-24`、`fall_detector.py:271-325`）：

| 条件 | 阈值 | 代码 |
|---|---|---|
| 近期直立过 | `recent_upright_ms=6000`（原 2500，为覆盖 3–5s 受控下坐而放大） | `:134,317-320` |
| 髋部快速下坠 | `rapid_hip_drop_per_sec=0.15`（由真实安全样本 0.17/s 校准，注释写"不得再降低"） | `:132-133,251-264` |
| 水平 | 躯干角 ≥58° **或** 框宽高比 ≥1.05 | `:128-129,281-284` |
| 低位 | 绝对判据 `hip_y≥0.58 且 框底≥0.76`；配了 ground-zone 则以区域命中为准 | `:130-131,285-298` |
| 持续 | SUSPECTED → FALLEN 至少 `confirm_ms=1200`，期间任一条不成立超 3.5s 就放弃 | `:136-137,341-347` |

为什么这样做：a) 规则**可解释、可现场校准**，不依赖训练集；b) 坐着/弯腰/躺床/缓慢坐下
天然不满足"快速下坠 + 近期直立"；c) 后续换 RKNN 只替换"关键点来源"，判定逻辑不动
（`fall_detector.py:1-6` 的模块注释就是这条契约）。

排除区与地面区：
- `--exclude-zone`（床/沙发）用**框中心**判断，命中直接不进入 SUSPECTED（`:299,433-434`）；
- `--ground-zone` 支持矩形与**多边形**（射线法），主判据是**真实髋点中点**是否在区内，
  次判据是"框中心在区内且重叠面积占比 ≥0.35"（`:476-489`）；
- 两者明显重叠（默认 ≥25% 地面区被排除）→ **拒绝启动**（`yolo_pose_service.py:899-904`）。

🟡 未实测：阈值标定基于**受控安全样本**，不是真人跌倒数据集；README 明确"必须用实际机位
采集的数据校准，不能表述为医学诊断准确率"（`README.md:22-24`）。

### 4.3 NCNN 导出与 RKNN 规划（PC 已通、板端未做）

- 导出脚本只有 6 行：`YOLO(...).export(format="ncnn", imgsz=640, half=False, batch=1, device="cpu")`
  （`vision/dayu-local/export/export_ncnn.py:1-6`）。
- 已产出物：`vision/yolo11n-pose_ncnn_model/{model.ncnn.param, model.ncnn.bin, metadata.yaml}`
  （param 25KB、bin 11.5MB）——`✅` 在仓库里，可直接被 ncnn 加载。
- `ncnn_reference.py` 是**板端 C++ 的 PC 镜像**：letterbox 参数、`from_pixels_resize`、
  `copy_make_border`、`1/255` 归一化、按 anchor 解 4 框 + 17 点、NMS（`:12-90`）。
  它的存在就是为了"在交叉编译前先在 PC 上把解码逻辑对齐 PyTorch"。
- `⬜未实现`：RK3568 RKNN 模型、32 位 OpenHarmony 板端 runtime、板端推理进程。README 状态
  明确写 `NOT TESTED`（`README.md:169-170`）。**当前真机路径是 USB 送帧 + PC CPU 推理**。

### 4.4 JPEG 帧的分帧与边界校验（两种封装）

| 封装 | 位置 | 边界如何确定 |
|---|---|---|
| TCP：4 字节大端长度 + JPEG | `video/relay/src/frames.js:33-62` | 先读长度（4096..1MiB，越界即报错并**重置缓冲**），凑满再切 |
| WS：一条二进制消息 = 一帧 | `frame-hub.js:159`、`agent-channel.js:73-84` | WS 消息天然有边界，不用再套长度 |

两边都做 JPEG 魔数校验：头 `FF D8`、尾 `FF D9`（`frames.js:23-27`；
`dayu-link.js:251-257` 判不合格只记日志丢弃，绝不把坏帧发给手机）。

`createFrameParser` 的容错细节值得单独学（`frames.js:40-59`）：

```js
const declared = pending.readUInt32BE(0);
if (declared < MIN_FRAME_BYTES || declared > MAX_FRAME_BYTES) { reset(); onError(err); return; }
if (pending.length < 4 + declared) return;      // 还不够，等下一块
```

长度越界时**不是抛异常，而是重置缓冲并继续**——否则一次错位就会让后续所有字节永久错帧。

### 4.5 帧率、带宽与丢帧

- 实测（`video/relay/README.md:167-177`）：真实 DAYU **640×480、单帧 27.8–28.4KB、
  3.27–3.56fps**；`uniqueHashes` 与帧数相等，说明**没有重复帧**。
- 带宽量级：≈28KB × 3.5fps ≈ **100KB/s ≈ 0.8Mbps**（10 分钟探望 ≈ 60MB）；relay **不做任何重采样**，`framesReceived/fps` 与 DAYU 侧一致（`README.md:186`）。
- 丢帧保护：`ws.bufferedAmount > 2MiB` 就跳过该 viewer 并计数 `dropped`
  （`frame-hub.js:154-157`）——宁可让慢手机掉帧，也不让 relay 内存被撑爆。
- 首帧指标：`viewer first frame` 记录 `firstFrameAfterMs`（`frame-hub.js:161-167`），
  实测 WS open → 首帧 341–431ms，满足契约"1s 内出第一帧"。

### 4.6 票据、限流与并发

- ticket：`crypto.randomBytes(32).toString('hex')` = 64 hex，**一次性**（consume 即删），60s TTL，
  重放/过期返回 null（`ticket-store.js:27-52`）；只存 `sha256(token)` 作 sessionKey，被拿到也反推不出 token。
- 限流：按 `sha256(token)` 滑动窗口，默认 10 次/60s，超限 429（`rate-limit.js:28-41`、`relay.js:161-165`）。
- 并发默认 2（`VIDEO_MAX_VIEWERS`），超出先发 `{"type":"error","code":"BUSY"}` 再 1013 关闭
  （`frame-hub.js:74-82`）；`POST /video/session/end` 会作废该 token 未用的 ticket 并关掉其 viewer（`relay.js:199-207`）。

### 4.7 健康端点

`GET /video/healthz`（无鉴权）返回 `{ok, mode, dayuLink, framesReceived, fps, lastFrameAgeMs, viewers}`
（`frame-hub.js:54-68`）：`dayuLink` 三态（local 看 `DayuLink.status`，agent 看 PC agent 上报）；
`fps` 是最近 2 秒滑窗帧数/2，无帧时 `lastFrameAgeMs=-1`——所以"没人看 → down/fps=0"是**正确状态**
（`video/relay/README.md:65-70`）。

### 4.8 Windows 上的进程存活与单实例锁（真实坑）

`vision_guardian.py:236-243` 的注释就是结论：**Windows 上绝不能用 `os.kill(pid,0)` 做存活检查**——
CPython 把它当 `CTRL_C_EVENT`，会给同控制台进程组发 Ctrl+C，既可能打断自己也不是存活语义。
因此 Windows 走 `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)` + `GetExitCodeProcess == 259`，
POSIX 才用 `os.kill(pid,0)`；锁文件只放 PID，陈旧锁自动接管，第二个实例明确拒绝并退出码 2
（`:273-290`）。

### 4.9 帧方向合同（防止"上下颠倒导致髋部判定反转"）

问题是真实的：DAYU 是类手机设备，未锁显示方向，倾斜/系统旋转会让同一路 USB 帧方向变化，
一旦上下颠倒，`hip_y` 的"向下"就变成"向上"，低位判定全错（`frame_orientation.py:3-5`）。

合同三件事（`:7-16`）：

1. **推理前**旋转到统一坐标系（`rotate_image`），因此 bbox/关键点天然同系，无需坐标映射；
2. 启动期**一次性**解析：只用"连续多帧可靠站立"的 `shoulder_hip_dy` 符号 + 宽高是否被交换
   （`:86-117`）；`auto` 无法可靠判定时**拒绝**并要求显式 `--frame-rotation`（`:771-779`
   → 返回 `rotation:"refused"`、`suspended:true`，**不判定、不发 FALL**）；
3. 锁后运行期看门狗：宽高变化，或可靠站立的垂直符号**连续 5 帧**反转 → 产生一次事件 →
   调用方挂起 FALL 发布（`:127-161`、`yolo_pose_service.py:792-815`）。

**禁止**：按每帧姿态自动切换角度；只允许 0/90/180/270（`:15,32-44`）。

### 4.10 证据链：落盘 → 索引 → outbox → 上传

- 触发帧先落盘再发布：`FallEvidenceStore.save()` 用"临时文件 + fsync + `os.replace`"，`index.json`
  同样原子写（`yolo_pose_service.py:63-139`）；索引损坏会被**隔离**（`index.corrupt-<ms>.json`）而不是静默清空（`:122-130`）。
- `evidenceId` 格式固定 `fall-<13位ts>-<trackId|na>` 且保证不重复（`:52-61`）；三处（本地/后端/bridge 白名单）共用同一正则。
- 上传（`evidence_uploader.py`）：远程**必须 HTTPS**（仅 loopback 允许 http，`:56-57`）；**禁重定向**防
  `x-ingest-key` 外流（`:35-38`）；上传前重算 sha256 与索引比对（`:86-87`）；`3xx/4xx` 且非 408/425/429 =
  永久失败，429/5xx/网络可重试（`:30-32,457-472`）；outbox 与 `index.json` 按
  `{evidenceId, deviceId, fileName, sha256}` 对账，退避状态持久化但**不含凭据**（`:117-161,307-319`）；
  后台单线程有界队列，满了只记"本地 JPEG 已保留"（`:322-400`）。

🟡 未实测：证据上传"已通过本地代码与真实 HTTP 测试，但**尚未部署公网**，也未在手机真机预览"
（`vision/README.md:117-119`）。

---

## 5. 设计取舍与坑

| # | 取舍/坑 | 为什么这样 | 代价与注意事项 |
|---|---|---|---|
| 1 | **USB 送帧 + PC CPU 推理**，而不是板端 NPU 推理 | RKNN Toolkit / 32 位 OH runtime / 板端性能都未实测确认，先保证"能跑通闭环"（`vision/README.md:46-51,169-170`） | 当前真机 **~2 FPS**，一周 MVP 要求"≥5 FPS"这项**尚未达标**（`:158-162`）；PC 必须开着 |
| 2 | 视觉**只提交受限 `fall` 事件**，不生成 alarmId、不写状态 | 误报只污染"一条事件"，不污染设备状态机；告警 ID/声光/语音/ACK 全在 homemon（`fall_detector.py:1-6`、`04-TRANSPORT-CLOUD` §3.2） | 多一跳；视觉停摆时"没人发现跌倒"，但有 watchdog 显式报失联 |
| 3 | 用**时序规则**而不是单帧分类 | 可解释、可现场校准、换 RKNN 不改协议 | 依赖连续帧与关键点：关键点丢失/遮挡时**不触发**（这是保守方向的失败） |
| 4 | 发布失败用**定时重试**，不依赖下一帧 | 跌倒后人可能不动了、帧也可能停了；靠新帧触发等于永远发不出去 | 30s TTL 后丢弃（`yolo_pose_service.py:412-417`）：宁可漏一条迟到跌倒，也不在 5 分钟后补一个"假当时"告警 |
| 5 | 阈值是**演示基线**不是准确率 | 只用受控安全样本校准过 `rapid_hip_drop_per_sec`（`fall_detector.py:132-137`），阈值改动历史写进注释 | **不能**对外宣称"跌倒识别准确率 X%"；合成规则单测 43 项（`README.md:151-156`）不能替代真人验收 |
| 6 | 视频**不转码、不落盘、不录像** | 隐私 + CPU + 无回放需求；relay 只做帧转发（`video/relay/README.md:195`） | 带宽=板端原始码流；无法事后取证（证据走视觉侧 JPEG 链路） |
| 7 | ticket **一次性 + 60s** | 防重放、防 URL 被转发；日志里 ticket 也只留前 6 位 | 手机断线重连必须**重新申请 ticket**（WS 401 的最常见原因，排障见 `README.md:182`） |
| 8 | **没人看就停流**（idle 3s → 发 `stop`） | 隐私红线：用户离开页面就不再采板端相机 | 再次观看有 ~0.3–0.5s 首帧延迟；viewer 抖动（关页又秒回）会触发一轮 stop/start |
| 9 | 帧方向**一次性锁定**，不逐帧自适应 | 逐帧猜方向会让"躺着"被当成"画面旋转"，判定彻底不可信（`frame_orientation.py:7-16`） | 机位变了/方向变了 → **挂起 FALL** 并要求重启重新锁定，不是自动纠正 |
| 10 | Windows PID 存活不能用 `os.kill(pid,0)` | 会把 sig 0 当 `CTRL_C_EVENT` 发给同控制台进程组（`vision_guardian.py:240-243`，实测踩坑） | 必须走 `OpenProcess + GetExitCodeProcess` 分支 |
| 11 | relay 日志**只记 pathname**，不记 query | WS URL 带 `?ticket=`、agent 带 `?key=`，落日志即泄漏（`video/relay/README.md:192-194`） | 任何新加的路由/代理都必须同样处理；Caddy 侧还要额外 delete query（`deploy/video/README.md:131-134`） |
| 12 | DAYU 视频口**只允许单客户端** | 板端实现如此，第二个连接收到 `busy`，被当作链路失败（`dayu-link.js:224-226`） | 探针脚本/旧测试进程没退就会让 relay 反复重连；排障第一句是"先停掉其它直连"（`README.md:181`） |
| 13 | 公网视频**尚未部署** | 无 SSH 到 ECS，必须由人在 Workbench 执行（`deploy/video/README.md:11-12,232-238`） | 状态 `BLOCKED-BY-DEPLOY`；本地只验证了 Caddyfile 补丁 + compose 无主机端口 |
| 14 | 视觉与视频**共用 PC，但互不阻塞** | 视觉是同步 HTTP 处理 + 单帧推理，视频是独立 Node 进程 | 两者抢 CPU/网络时**视频帧率先掉**（丢帧保护在 relay 侧）；别把 9200 和 9443 的稳定性混为一谈 |

---

## 6. 可完善点（ROI 排序）

### A. 可靠性/体验（最高 ROI，改动小）

1. **USB 链路打到 ≥5 FPS**：`--imgsz` 降到 480/416 或隔帧推理，先 `--diag-conditions` 量耗时构成
   （`yolo_pose_service.py:525-529`）；风险：降分辨率会让远距离关键点置信度掉到 0.35 以下。
2. **补视频端到端指标**：`frame-hub` 已有 `viewer first frame`，建议把 `framesSent/dropped/首帧 ms`
   汇总进 `/video/healthz`，让"黑屏但 connected"一眼分清丢帧还是解码（`deploy/video/README.md:228`）。
3. **统一失联语义**：进程内 `FrameWatchdog` 与进程外 guardian 都会发 `monitor offline`，同一次故障
   可能重复。建议 payload 加 `origin:"inproc"|"guardian"`（bridge 白名单需同步放行）。

### B. 精度（第二 ROI，成本中等）

1. **按周 MVP 采集 6 类 ×10 段**（跌倒/坐下/弯腰/躺床/遮挡/无人，`README.md:163-166`），产出混淆矩阵 +
   每类误报次数——这是把"演示基线"变成"可写进报告的结论"的唯一路径。
2. **机位标定脚本化**：`exclude-zone/ground-zone` 目前靠人工试；可复用 `pc_scan.py` 批量跑离线图，
   输出建议 zone 与命中率。`FallDetector` 是无全局状态的纯逻辑，按 `sourceId` 建多实例即支持多机位。

### C. 板端与部署（第三 ROI，成本高）

1. **RKNN 路线**：`export_ncnn.py` → 转 RKNN → `ncnn_reference.py` 对齐 → 板端 C++ runner；任一环节
   未实测前不要写"已部署 NPU"。
2. **视频公网**：执行 `deploy/video/install-on-ecs.sh` 后按 `deploy/video/README.md` §4 复验
   （`/video/healthz` 200、无 token 401、`/readyz` 仍 200），把 `BLOCKED-BY-DEPLOY` 改成实测。
3. **画质/码率自适应**需板端支持"按需降分辨率/降帧率"（relay 只转发不改，不建议加转码）。

### D. 成本

1. **PC 常驻是硬依赖**：把 `vision_guardian` 与 `video agent` 一并纳入开机自启、复用同一日志目录，
   避免现场"两个窗口谁先关"。2. 证据上传建议加"每日成功率"计数（outbox 已记录 attempts/status）。

---

## 7. 本层最容易被误解的 3 个点

**① "视觉检测到跌倒就直接把设备改成告警状态了"。**
不。视觉只发一条受限命令 `{"cmd":"fall", ...}`（`yolo_pose_service.py:234-243`），
真正的 `alarmId` 生成、状态机迁移、声光/语音、安全日志、APP ACK 全部由板端 `homemon` 负责
（`vision/README.md:139-142`）。所以视觉侧**没有**"告警状态"可查，只有 episode/score/evidenceId。
反过来也成立：视觉进程挂了，设备并不会因此变正常或变告警——只会产生 `monitor offline`。

**② "视频是 DAYU 直连公网 / relay 会存下来，所以能回放"。**
两处都错。DAYU200 **当前没有 IP 网络**（只有 USB/HDC），公网链路必须由 PC agent **出站**注册到
ECS relay（`deploy/video/README.md:36-37`）；relay 只做帧转发，**不解码、不转码、不落盘、不录像**
（`video/relay/README.md:195`），viewer 走后 3s 就向板端发 `stop`。因此没有回放、也没有历史录像，
只有"实时看 + 视觉侧保存的触发帧 JPEG"两条独立证据。

**③ "FALLEN 会一直涨/检测到人就报警"。**
`FALLEN` 是**持续状态**而非单帧闪烁：一旦进入就一直是 `FALLEN`，直到检测器观察到**直立持续 2s**
才回到 NORMAL（`fall_detector.py:306-314`），这也是 APP 能稳定显示"疑似跌倒"的原因
（`README.md:68-70`）。同时它**不是**"检测到人就报"：必须凑齐 §4.2 的五个条件，
坐着、弯腰、躺床、缓慢坐下都不会进入告警；"检测到人体"只是 HTTP 响应里的 `personDetected`
（`yolo_pose_service.py:572-578`）。

---

## 8. 阅读顺序建议

1. **先看契约**：`vision/README.md`（判定边界 + 真机链路 + 已知限制，171 行，一次读完）。
2. **纯规则**：`vision/fall_detector.py` —— 本层最值得逐行读的文件（无框架依赖、注释即设计文档），
   重点 `features()`（176-216）与 `update()`（218-359）。
3. **适配与生命周期**：`yolo_pose_service.py` 的 `process_jpeg`（729-853）、`run_http_ingest`（664-881）、
   `FrameWatchdog`（276-352），再看 `vision_guardian.py` 的 `tick()`（169-204）理解"进程外守护"为何必要。
4. **证据与方向**：`evidence_uploader.py`（上传契约与 outbox）→ `frame_orientation.py`（方向合同）。
5. **视频先读 README**（206 行：接口表 + 实测数据 + 排障）→ `src/frames.js`（70 行，协议最底层）→
   `src/dayu-link.js`（握手状态机）→ `src/frame-hub.js`（viewer 生命周期，本层最核心）→
   `src/relay.js`（鉴权/票据/升级）→ `src/agent-channel.js` → `src/agent-client.js` → `agent.js`。
6. **部署**：`deploy/video/README.md`（一条命令 + 自检项 + 回滚）；注意状态是 `BLOCKED-BY-DEPLOY`。
7. **现场排障顺序**：`/video/healthz`（dayuLink/fps/viewers）→ relay 日志有无 `viewer first frame` →
   `hdc fport ls` 确认 9200/9301 → `Invoke-RestMethod http://127.0.0.1:9200/healthz` →
   `--diag-conditions` 看五项条件真实取值（只看，不改状态）。

> 与本文的分工：`02-DEVICE.md` 讲板端 homemon / VideoStreamServer 的实现；`04-TRANSPORT-CLOUD.md`
> 讲 `fall`/`monitor` 命令如何经 bridge、以及证据在后端如何被鉴权读取。本文只对"视觉判定"与
> "视频中继"两件事负责，跨层结论以 `docs/VALIDATION-MATRIX.md` 为准。


