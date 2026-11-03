# 视频探望 MVP 契约（2026-10-27，Lead 冻结）

本文件是本次实现的唯一协议契约。任何实现必须按此文件；变更契约必须先通知 Lead。

## 0. 目标链路与实际网络事实

```text
DAYU200 相机（真实 MIPI 摄像头，640x480，FRONT）
  → DAYU200 板端 APP（com.dsh.eldercare）内 VideoStreamServer（只在本机 127.0.0.1:9301 监听，按需取帧 + JPEG 编码）
  → USB/HDC 端口映射（hdc fport tcp:9301 tcp:9301，PC 127.0.0.1:9301）
  → PC / ECS 中继 relay（鉴权 + 帧分发）
  → 手机 APP VideoVisitPage（WebSocket 接收 JPEG 帧，Image 组件连续渲染）
```

已核实事实（2026-10-27 20:10）：

- DAYU200：target `450100445634303332012847942eca00`，OpenHarmony 7.0.0.38 / API 26；**wlan0/eth0 均无 IPv4 地址**（当前只有 USB/HDC 可用），相机预览已在跑（`[CameraModel] 预览已启动 640x480`，进程 `com.dsh.eldercare` 1.0.3）。
- `127.0.0.1:9200` 是 DAYU 本机 JPEG 推理入口，**不是**视频流；本方案不复用它、不改变它。
- PC 可访问 `api.luxunacc.xyz:443`（生产后端/ECS）；ECS 只开 22(不可从本机)/80/443，部署需用户在阿里云 Workbench 执行脚本。
- 手机侧验收环境：HarmonyOS 模拟器 `127.0.0.1:5555`（eth0 = 10.0.2.15，QEMU NAT；宿主别名 10.0.2.2）。实体手机无签名材料，本期不承诺实体手机安装。

## 1. DAYU200 板端 VideoStreamServer 协议（TCP，行分隔控制 + 二进制帧）

- 监听：`127.0.0.1:9301`（只 loopback，禁止 0.0.0.0）。
- 单客户端；已有客户端时，新连接立即收到 `{"type":"busy"}` 后关闭。
- 客户端连接后 2 秒内服务端发送一行 UTF-8 JSON（`\n` 结尾）：

```json
{"type":"hello","proto":1,"device":"dayu200-living","camera":"640x480","cameraActive":true}
```

- 客户端发送一行：`{"type":"start","viewer":"<viewerId>"}\n`
- 服务端回一行：`{"type":"started","proto":1}\n`，随后持续发送二进制帧。
- **帧格式**：4 字节大端无符号整数 N（4096 ≤ N ≤ 1048576）+ N 字节 JPEG（`FF D8 ... FF D9`）。每帧一张 640x480 JPEG，质量 70–80，目标 10 fps（每 100 ms 一次；编码超时可跳帧）。
- 客户端发送 `{"type":"stop"}\n` 或直接断开 TCP → 服务端 500 ms 内停止取帧循环；正常 stop 时回 `{"type":"stopped"}\n`。
- 无客户端时**不取帧、不编码、不发帧**；相机预览本身由 APP 现有监护链路持有（不额外开启摄像头）。
- 服务端不得因为取帧/编码失败而崩溃或停掉相机；失败仅记录状态并在下次重试。
- 与现有 `VisionFrameStreamer`（250ms 一次）并存；如两者并发 `createPixelMapFromSurface` 发生冲突，必须降级为串行（见 §5 验收要求）。

## 2. relay（PC/ECS Node 服务，`competition/video/relay/`）

### 2.1 运行模式

- **local 模式**（本机验收默认）：relay 自己 TCP 连接 `DAYU_HOST:DAYU_PORT`（默认 127.0.0.1:9301，经 hdc fport）。
- **agent 模式**（ECS 部署）：PC 侧 `agent.js` 连接 DAYU TCP，并出站 WSS 连接 relay 的 `/video/agent?key=<VIDEO_AGENT_KEY>`；relay 收到 `agent` 注册后把帧分发给 viewer。
- 两种模式共用同一 FrameHub；relay 启动时若配置 `VIDEO_AGENT_KEY` 则接受 agent，若配置 `DAYU_HOST` 则按需直连；两者不可同时活动（以配置为准）。

### 2.2 HTTP/WS 接口（relay）

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/video/healthz` | 无 | `{"ok":true,"mode":"local|agent","dayuLink":"connected|connecting|down","framesReceived":n,"fps":x,"lastFrameAgeMs":n,"viewers":n}` |
| POST | `/video/session` | `Authorization: Bearer <APP token>` | 调 `${BACKEND_BASE}/api/v1/overview` 校验 token；2xx → `{"ticket":"<64hex>","expiresInMs":60000,"wsPath":"/video/stream?ticket=<ticket>"}`；无/非法 token → 401；超频 → 429 |
| GET | `/video/stream?ticket=<ticket>` | ticket（一次性、60s TTL） | WebSocket 升级。成功后先发文本 `{"type":"ready","proto":1,"camera":"640x480"}`，随后每条 WS **二进制消息 = 一帧 JPEG**。 |
| POST | `/video/session/end` | Bearer token | 结束该 token 的观看（关闭其 WS），200 |

- WebSocket 控制文本：`{"type":"error","code":"DAYU_DOWN|NO_AGENT|BUSY"}`、`{"type":"resumed"}`、`{"type":"heartbeat","ts":<ms>,"fps":x}`。
- 断线：DAYU 链路断开时保留 viewer，自动重连（退避 0.5s/1s/2s/5s，上限 10s）；重连成功后发 `resumed`；画面暂停但连接保持；超过 30s 未恢复 → 发 `error DAYU_DOWN` 并关闭 1011。
- 空闲停止：最后一个 viewer 关闭后 `VIDEO_IDLE_STOP_MS`（默认 3000）内无新 viewer → 向 DAYU 发送 stop 并断开 DAYU 链路（满足“用户离开页面后停止采集/推流”）。
- 并发：`VIDEO_MAX_VIEWERS` 默认 2；超出 close 1013。
- 安全：日志不得出现 APP token / agent key（只允许 ticket 前 6 位或 sha256 前 8 位）；ticket 不得写入访问日志明文；relay 不提供 dayu 端口直通。

### 2.3 鉴权复核

- relay 调后端 `GET /api/v1/overview`，`Authorization: Bearer <token>`；200 视为有监护权限；401/403/其它 → 拒绝。
- 家庭隔离沿用后端账号体系（当前生产只有 1 个监护账号；越权用无效 token/无 token 验证 401）。

### 2.4 部署组件（ECS，需用户执行一次）

- 新增 compose 服务 `video-relay`（不暴露主机端口，仅 `public-edge` 网络内 `9443`）；Caddy 增加 `/video/*` 反向代理到 `video-relay:9443`（需支持 WebSocket，Caddy 默认支持）。
- 不改 backend/caddy 的既有路由与环境；安装脚本先备份再改 Caddyfile，失败可回滚。
- 安全组：只需既有 443；不新增公网端口。
- PC agent 常驻命令形如：
  `node competition/video/relay/agent.js --relay wss://api.luxunacc.xyz/video/agent --key <KEY> --dayu 127.0.0.1:9301`

## 3. 手机 APP（`<WORKSPACE>\APP\ElderlyCareGuardian`）

- 新增页面 `pages/VideoVisitPage.ets`（注册到 `resources/base/profile/main_pages.json`），首页“视频探望”快捷入口改为 `enabled=true`、状态“可用”，点击 `getUIContext().getRouter().pushUrl({url:'pages/VideoVisitPage'})`。
- 配置：`core/video/VideoConfig.ts`：
  - `VIDEO_RELAY_BASE` 默认 `http://10.0.2.2:9443`（模拟器验收，宿主 relay）；
  - 允许 AppStorage key `video.relayBase` 覆盖（生产可设为 `https://api.luxunacc.xyz`）。
- 页面行为：
  - 进入：取当前会话 token（复用 `SessionCore`/`GuardianService` 的现有 token 获取方式，不新造登录态）→ `POST /video/session` → `@ohos.net.webSocket` 连接 `ws://.../video/stream?ticket=...`（http→ws / https→wss）。
  - 收到二进制 JPEG：`image.createImageSource(ArrayBuffer)` → `createPixelMap` → 渲染到 `Image(pixelMap)`；帧序号/时间/实时 fps 显示；上一帧 PixelMap 必须 release。
  - 状态：连接中/等待首帧（加载）→ 播放中（“实时画面 · 已接收 N 帧 · M fps”）→ 连接失败（错误码 + 重试按钮）→ 断线重连（显示“连接中断，正在重连…”，最多 3 次退避 1/2/4s）→ 主动结束（“结束探望”按钮 → 关 WS → POST session/end → 返回）。
  - 页面 `onPageHide`/`aboutToDisappear`：必须关闭 WS 并调用 end；不得后台继续收流。
  - 隐私提示固定文案：“仅本次会话实时查看，不录像、不留存、不录音”；无权限/失败不得显示“正在直播”。
- module.json5 需 `ohos.permission.INTERNET`（已有）+ `ohos.permission.GET_NETWORK_INFO`（已有），无需相机权限。

## 4. 验收（Lead 执行，队友自测）

1. DAYU 侧：`hdc fport tcp:9301 tcp:9301` 后，PC 测试客户端收到 ≥30 帧、每帧 JPEG（FFD8/FFD9）、帧内容逐帧变化（unique hash 数=帧数）、连续 10s 无中断；关闭客户端后服务端日志显示停止取帧。
   - **实测基线（2026-10-27 20:22–20:26，DAYU 1.0.4）**：640×480 JPEG q60，12.8s 收到 37–46 帧，2.9–3.6 fps，帧均 ~29–38KB，全部 JPEG 合法且 hash 各异。瓶颈在 DAYU 端 `createPixelMapFromSurface` 150–250ms + JPEG 编码 ~85ms（与既有 VisionFrameStreamer 250ms 取帧并存）；这是本硬件/系统路径的实测上限，**以 ≥2.5 fps 作为本机验收下限**，并如实记录“低帧率实时预览”。
2. relay：单元/集成测试全绿；`/video/healthz` 真实返回 connected。
3. APP：模拟器安装后从首页进入视频探望，屏幕出现 DAYU 实时画面；连续帧变化（不是同一张静态图）；停留 ≥60s 后退出，relay 日志确认 last viewer 关闭后 ≤5s 内 DAYU 停止取帧。
4. 失败/重连：关闭 relay 或拔 hdc → APP 显示连接中断并重连；恢复后自动继续（或手动重试成功）。
5. 越权：无 token / 伪造 token 打开视频 → 401，不出现画面。
6. 网络：模拟器（10.0.2.15）→ 宿主 LAN IP（10.127.130.179）或 10.0.2.2 经 IP 可达；另准备 ECS 公网部署，待用户执行后验证 `wss://api.luxunacc.xyz/video/...`。

## 5. 关键风险

- DAYU 无 IP 网络：本期 DAYU→relay 必须经 USB/HDC；这是硬件/网络现状，必须如实记录，不得写成“公网直连”。
- `image.createPixelMapFromSurface` 并发/性能：需实测；若与 VisionFrameStreamer 冲突，改为串行捕获且保持 250ms 视觉推理不丢。
- 模拟器 WS/图像解码能力需真实验证；不能用“正在连接”冒充完成。
- ECS 部署需用户执行；未执行前公网路径标记 BLOCKED-BY-DEPLOY，本机 IP 路径可验收。
