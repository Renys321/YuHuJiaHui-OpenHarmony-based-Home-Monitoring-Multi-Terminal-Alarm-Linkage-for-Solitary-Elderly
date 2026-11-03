# 摄像头 / 视频链路核验 —— 2026-10-27 只读审计

- 工作区：`<WORKSPACE>`；边界：只读源码/配置/构建产物/文档/UI 快照；未开串口、未连设备、未访问生产后端、未启停任何服务。
- 分级：**REAL**（本轮可复核事实）/ **SOURCE-ONLY**（代码在、未部署或未验收）/ **NOT TESTED** / **BLOCKED**。

## 0. 一句话结论

**手机端“视频探望”不可用，也不存在任何可达的 RTSP/MJPEG/HLS/WebRTC 链路。** DAYU200 相机是**本机** HarmonyOS 相机会话（预览 Surface + 单张拍照），`127.0.0.1:9200` 是**设备本机 loopback 的 JPEG 上传/推理入口**（POST 一张图，返回 JSON），不是视频流；即使历史上经 `hdc rport` 映射到 PC，也只是 USB 隧道内的 loopback，手机/公网都不可达。手机 APP 的“视频探望”按钮是 `enabled=false` 的“未开放”占位。公网 backend 没有视频/流接口，只有告警证据**单张 JPEG**接口。

> 不要把本地 9200、历史相机截图、告警证据 JPEG 当成“手机可看的实时视频”。

## 1. 链路逐段核验

### 1.1 DAYU200 相机（本机采集，不是流媒体服务器）

- DAYU 正式 APP 用 HarmonyOS `@ohos.multimedia.camera` 打开**本机**相机：
  - `northbound/entry/src/main/ets/model/CameraModel.ets:72-73` 取 `camera.getCameraManager` / `getSupportedCameras`；
  - `:118-155` 建 `CameraInput`、`PreviewOutput`（绑定 UI 的 `surfaceId`）、`PhotoOutput`（单张照片，`:149-155`）；
  - `:90-180` 启动 `PhotoSession`；`Index.ets` 里用 `XComponentController` 持有 `cameraSurfaceId`（`Index.ets:201-207`）。
- 这是**本地预览/本地拍照**；代码里没有 RTSP/RTMP/MJPEG/HLS/WebRTC 服务、没有对外监听端口、没有视频编码推送。

### 1.2 `127.0.0.1:9200` 是什么（JPEG 推理输入，不是播放地址）

- 设备端端点写死为 `http://127.0.0.1:9200/v1/frames/dayu200-living`：`northbound/entry/src/main/ets/model/VisionFrameStreamer.ets:5-11`；
- 工作方式：每 ~250 ms 从**已显示的相机 Surface** 抓一帧 → 编码 JPEG（质量 72）→ `POST` 到该地址，单请求在途、2.5 s 超时，返回的是推理 JSON（`personDetected/fall/evidence`），不是图片/视频：`VisionFrameStreamer.ets:76-97,143-166`；
- 接收端：`vision/yolo_pose_service.py`
  - `--listen-host` 默认 `127.0.0.1`，帮助文本“keep loopback when using hdc rport”（`:448-458`）；
  - `GET` **只有** `/healthz`，其余 404；`POST` 只接受 `/v1/frames/<id>` + `Content-Type: image/jpeg`，上限 2 MiB（`:35-36,596-625`）；
  - 服务绑定 `HTTPServer((args.listen_host, args.listen_port))` 并打印 `HTTP JPEG ingest listening on 127.0.0.1:9200`（`:856-859`）。
- 结论：9200 是**只进不出的单帧 JPEG 摄入口**；没有任何“GET 视频/帧流”的接口。它只在 DAYU 本机 loopback（或 USB `hdc rport` 的 PC loopback）可达。

### 1.3 USB/HDC 与 Bridge 的作用（都不是视频通道）

- `tcp:9200 tcp:9200 [Reverse]` 是 HDC 的 USB 反向端口映射，用于把 DAYU 的 loopback 请求转到 PC 的 loopback：`vision/start_dayu_usb_vision.cmd:16-24`；历史记录见 `docs/evidence/2026-10-16-p1-5-p1-6-dayu-esp32-relink.md:21`。
- 当前正式形态改为**在 DAYU 本机**跑推理进程，监听 `127.0.0.1:9200`（`materials/demo-autostart/demo-autostart.ps1:303,329`；交接文档 `docs/evidence/2026-10-26-new-chat-handoff.md:74,82,218`）。
- `tcp:9001 → tcp:9000` 是 HDC 正向端口（PC 9001 → DAYU 9000 homemon），传的是**状态 JSON 行协议**（ESP32/homemon 的 `{deviceId,room,state,sensors,alarm}`），不是视频：交接文档 `:72,79-80`；协议见 `southbound/src/homemon.c:806-830`。
- 公网状态链路：PC Broker(1883) → `public-sync` → `https://api.luxunacc.xyz` → APP；payload 只含状态/alarm/sensors（`cloud/onenet/cloud-sync.js:59-97`），**不含媒体**。

### 1.4 公网 backend：没有视频接口

- 路由清单（`cloud/backend/src/server.js`）只有：`/api/v1/auth/*`、`/api/v1/overview`、`/api/v1/health-profile`、`/health-advice`、`/api/v1/rooms`、`/alerts`、`/devices`、`/door-events`、`/activity/report`、`/location`、`/contacts`、`/notifications/subscription`、`/communications/messages`、`/safety-logs`、`/internal/v1/*` ingest 等（`:388-1049` 区段）；**没有** `/video`、`/stream`、`/rtsp`、`/frames` 之类的播放端点。
- 只有“告警证据 JPEG”是媒体：`PUT /internal/v1/evidence/<id>` 上传、`GET /api/v1/alerts/<alarmId>/evidence` 元数据、`GET /api/v1/alerts/<alarmId>/evidence/content` 单张 JPEG（`server.js:467-485,987-1000`；合同 `docs/APP-API-v1.md:75-81`）。
- 手机 APP 侧对应实现：`core/api/ApiClient.ts:221`、`pages/AlertDetailPage.ets:633-...`。这是**单张告警证据图片**，不是实时视频；且当前安装包是否包含该能力未在本轮核实（见 §3）。

### 1.5 手机端：入口明确“未开放”

- `APP/ElderlyCareGuardian/entry/src/main/ets/pages/HomePage.ets:455-460`：
  ```
  this.quickAction($r('sys.symbol.video_fill'), '视频探望', false, () => {})
  ```
  第三个参数 `enabled=false`；`quickAction` 会渲染“未开放”，点击仅 toast“视频探望未开放”（`HomePage.ets:266-289`）。
- 手机 APP 没有视频播放页、没有播放器组件、没有 camera/stream 相关调用（APP 全目录 grep `9200|rtsp|mjpeg|hls|webrtc|视频` 仅命中能力表注释与“视频探望”占位，见 `core/capability/DeviceCapabilities.ts:9,164-166`）。
- 能力表也明确：“APP 无实时视频接口，不显示实时画面”（`DeviceCapabilities.ts:164-166`）。

### 1.6 全仓库没有流媒体实现

- `grep -i 'rtsp|mjpeg|hls|webrtc|gstreamer'` 的结果全部是“未实现/不包含”的声明，没有实现代码：
  - `evidence/2026-10-25-camera-a-hardening/CAMERA-A-HARDENING-REPORT.md:47`：“没有实现低帧率预览、MJPEG、RTSP、HLS、WebRTC 或 CAMERA-B”；
  - `evidence/2026-10-25-camera-a-fall-evidence-app/CAMERA-A-REPORT.md:25`：不包含实时视频/预览/WebRTC/HLS/RTSP/MJPEG；
  - `docs/evidence/2026-10-26-new-chat-handoff.md:247`：低帧率预览/WebRTC 仍属后续任务，且“不得公开无认证 RTSP/MJPEG”；
  - `cloud/backend/src/comms-core.js:10`：不含实时通话/WebRTC（语音通信也不是视频）。
- 结论：**当前不存在任何可达 RTSP/MJPEG/HLS/WebRTC 服务**（REAL：代码与文档证据；无实现即不可达）。

## 2. 为什么“本地能看”不等于“手机能看”

| 前提 | 现状 | 手机远程播放所需 |
|---|---|---|
| DAYU 相机有画面 | 只有本机 Surface/拍照 | 需要编码器把 Surface 帧编成 H.264/H.265 或 JPEG 序列 |
| 9200 有推理结果 | loopback POST，返回 JSON | 需要独立的流媒体服务器（RTSP/WebRTC/HLS），不能复用推理口 |
| USB/HDC 映射 | 仅 USB 隧道内 loopback，依赖 PC 与线缆 | 需要 DAYU 主动出网（4G/Wi-Fi）或公网中继，且 NAT 穿透 |
| 公网 backend | 只有状态/告警/证据 JPEG | 需要视频会话、鉴权、TURN/中继、播放地址签发、限流与审计 |
| 手机 APP | “视频探望”未开放，无播放器 | 需要播放器组件 + 会话/权限 + 隐私提示 |
| 安全边界 | 仓库规则：不得公开无认证 RTSP/MJPEG、不得把 Token 放 URL、不得让第二进程抢相机（`docs/evidence/2026-10-26-new-chat-handoff.md:247`） | 必须设计鉴权/授权/隐私与并发策略 |

## 3. 手机“视频探望”要真实可用，还缺什么（补齐清单）

任一项缺失都不能宣称可用：

1. **视频源与编码**：DAYU 侧从现有相机 Surface 取帧（不可再开第二个相机消费者），用硬件/软件编码成 H.264 低码率（例如 640×480@10–15fps、<500 kbps）；或先做认证的 1–2 FPS JPEG 预览（也不是当前 9200 口）。
2. **流媒体服务**：优先 WebRTC（含 TURN）；或 RTSP over TLS + 网关；或 HLS（延迟大，不适合探望）。**必须有鉴权**（短期 token、会话有效期、监护人身份、审计），禁止公开无认证流。
3. **网络可达性**：DAYU 需要出网通道（Wi-Fi/4G）与公网中继/TURN；当前 DAYU 只有 USB+HDC，PC 关机/拔线即断（交接文档 `:86`）。
4. **后端/APP 协议**：新增“请求视频会话/获取播放凭证/结束会话”的 API 与状态机；APP 增加播放器页、权限申请、错误/超时/暂停、隐私提示；ACK/告警与视频证据分开。
5. **并发与隐私**：DAYU 相机同一时刻只能被一个进程占用（`CAMERA-A-HARDENING-REPORT.md`、交接 `:354`）；远程查看需明示、可一键停止；不录屏/不写相册/不公开上传。
6. **验收**：真实手机（非模拟器）在真实公网/4G 下的连接成功率、首帧时延、断线重连、长时间稳定性、码率/流量、功耗、与告警/预览并发测试；**本轮全部 NOT TESTED**。

## 4. 现有“证据图片”能力边界（SOURCE-ONLY + NOT TESTED）

- 代码存在：DAYU 相机 `PhotoOutput` 单张拍照、`evidence/` 上传、后端 evidence store、APP 证据加载；但：
  - CAMERA-A 在其加固报告中明确“真实验收 blocked”（`evidence/2026-10-25-camera-a-hardening/CAMERA-A-HARDENING-REPORT.md`）；
  - 生产 APP 在 2026-10-27 door-v7 发布时已剥离 CAMERA-A 字符串（`evidence/2026-10-27-door-v7-e2e/REPORT.md:79`）；当前安装的 1.0.6 是否含证据图片能力**未核实**（NOT TESTED）。
- 即使可用，也只是“告警时刻的一张 JPEG”，**不是视频探望**。

## 5. 本轮明确未做 / 阻塞

- 未开相机、未连接 DAYU（HDC/串口）、未访问 9200、未启停推理/看护服务、未访问生产 backend、未安装 APP、未做任何视频播放测试。
- 手机实机/公网链路：**BLOCKED**（需要设备操作与用户授权）；结论依据为代码、配置、历史证据与“实现缺失”事实，不是现场连通性测试。
