# 手机远程视频探望 — 真机/模拟器端到端验收报告（2026-10-27）

- 工作区：`<WORKSPACE>`；时区 Asia/Shanghai
- DAYU200：`hdc` target `450100445634303332012847942eca00`，OpenHarmony 7.0.0.38 / API 26；板端 APP `com.dsh.eldercare` **1.0.4 / 1000004**（本轮安装，见 `../dayu-1.0.4/REPORT.md`）
- 手机 APP：HarmonyOS 模拟器 `127.0.0.1:5555`，`com.example.program_04` **1.0.9 / 1000009**（本轮安装，见 `../app/REPORT.md`）
- relay：`competition/video/relay`（Node，local 模式），PC `0.0.0.0:9443`
- 验收时间：2026-10-27 20:38–20:45
- 结论：**用户从手机 APP 首页主动进入“视频探望”，可连续看到 DAYU200 摄像头实时画面（不是 DAYU 本机预览/推理图/静态图）；退出页面 3 秒内 relay 令 DAYU 停止取帧。** 真实设备验收 PASS（本机网络路径）；公网 ECS 路径 BLOCKED-BY-DEPLOY。

## 1. 实际链路（不是 localhost，也不是 9200）

```text
DAYU200 MIPI 摄像头（640×480 FRONT，真实相机）
  → DAYU200 板端 APP 内 VideoStreamServer（127.0.0.1:9301，按需取预览 Surface + JPEG 编码）
  → USB/HDC 端口映射：hdc -t 4501… fport tcp:9301 tcp:9301
  → PC relay（0.0.0.0:9443，local 模式；Bearer token 调生产后端 /api/v1/overview 复核权限；一次性 ticket；WS 分发；空闲 3s 停流）
  → 模拟器 APP（10.0.2.2:9443，QEMU NAT，非 127.0.0.1）
  → VideoVisitPage 解码 JPEG → PixelMap → 连续渲染
```

- 端口/组件：DAYU 本机回环 `9301/tcp`（仅板内）；PC relay `9443/tcp`；模拟器 → 宿主经 QEMU NAT（`10.0.2.2`）。模拟器侧另实测 `ping 10.0.2.2` 与 `ping 10.127.130.179`（宿主 WLAN）均 1ms 可达，证明 APP 侧走的是 IP 网络而非 DAYU localhost。
- 协议：控制行 JSON（hello/start/started/stop/stopped/waiting/busy）+ 4 字节大端长度 + JPEG；relay 对 APP 用 WS：首条文本 `{"type":"ready","proto":1,"camera":"640x480"}`，之后每条二进制消息 = 一张 JPEG；heartbeat 5s。
- 复用现有登录：APP 用自身会话 token 调 relay `POST /video/session`；relay 再用该 token 调生产后端 `GET /api/v1/overview` 复核，200 才签发 60s 一次性 ticket（64 hex，单次使用）。token 不出现在任何日志。
- 未复用/未改变 `127.0.0.1:9200`（DAYU 本机 NCNN 跌倒推理口）；验收时该推理仍在工作（DAYU UI 显示 `检测到人体 · 2479 帧 · 271 ms`），说明视频推流未破坏既有 AI 健康/跌倒检测链路。

## 2. 验收结果（真实截图/日志）

### 2.1 进入与实时画面（PASS）

| 时间 | 事件 | 证据 |
|---|---|---|
| 20:38:2x | APP 首页点“视频探望”（入口已从“未接入”改为“可用”），进入页面 | `app-video-01-opening.jpeg` |
| 20:38:10 | 首帧到达，页面显示 `第 12 帧 · 3.8 fps · 640×480`、`实时画面 · 已接收 12 帧 · 3.8 fps`、`最近帧 20:38:10` | `app-video-01-opening.jpeg` |
| 20:38:27–39 | 连续截图 5 张：第 12→188 帧，6 张整屏 SHA-256 全部不同（画面逐帧变化，不是静态图/旧帧循环） | `app-video-02..06*.jpeg`、`app-video-sha256.txt` |
| 20:43–20:45 | **连续 65s 不中断**：relay framesReceived 182→438（+256 帧），APP `第 281 帧 · 3.6 fps`，`最近帧 20:44:54` | `app-video-14-long-60s-start.jpeg`、`app-video-15-long-60s-end.jpeg` |
| 20:43:3x | DAYU 板端 UI 同时显示 `远程探望：推流中 · 23 帧 · 3 fps` 与相机预览、`检测到人体 · 2479 帧 · 271 ms` | `dayu-streaming-status.jpeg` |
| 全程 | relay 日志：`session 200 → dayu connected(cameraActive:true) → first frame 331/335/512ms → frames forward`；帧率 3.5–4.0 fps | `relay-owned.log` |

实测画面帧参数：640×480 JPEG，27.8–29 KB/帧，3.2–4.0 fps；首帧 331–512 ms（含 DAYU 取帧+编码+WS 建链）。设备端每次取帧 130–280ms、编码 60–223ms、发送 2–19ms（`dayu-video-long-session-logs.txt`）。

### 2.2 主动结束与停止推流（PASS）

- 20:45:16 点“结束探望” → 页面返回首页（`app-video-16-long-ended-home.jpeg`）。
- relay 日志（`relay-owned.log`）：
  - `12:45:16.956Z viewer left viewers=0 framesSent=356`
  - `12:45:17.506Z session end ... backendStatus=200`
  - `12:45:19.960Z idle stop: no viewers idleStopMs=3000`
- DAYU 板端日志：`20:45:18.536 停止取帧（已发送 368 帧）`、`20:45:18.616 观看者断开：peer closed`。
- 之后 `/video/healthz` = `{"ok":true,"mode":"local","dayuLink":"down",...,"viewers":0,"lastFrameAgeMs":5810}`；**用户离开页面后不再取帧/推流**。

### 2.3 加载 / 连接失败 / 重试 / 断线恢复（PASS）

| 场景 | 操作 | 结果 | 证据 |
|---|---|---|---|
| 加载中 | 正常进入、首帧未到 | 显示“正在申请视频会话…”旋转加载，不显示“直播中” | `app-video-07/08` |
| 连接失败 | 停掉 relay 后打开视频页 | 页面显示 **“连接视频服务超时，请检查网络后重试”**、`未连接`、`错误类型: timeout`，按钮“重新连接/结束探望”，**无假画面** | `app-video-11-connection-failed.jpeg` |
| 手动重试 | 重启 relay 后点“重新连接” | 恢复真实画面：`第 48 帧 · 3.8 fps`，`已接收 48 帧` | `app-video-12-reconnected.jpeg` |
| 断线自动恢复 | 页面播放中重启 relay | 页面自动回到加载/重试状态，relay 恢复后继续播放至 `第 188 帧 · 3.5 fps`（无需重新进入） | `app-video-09-after-relay-restart.jpeg` |

### 2.4 鉴权（PASS，家庭隔离受账号数量限制）

- 无 token：relay `POST /video/session` → **401**（`WARN session rejected: missing bearer token`）。
- 伪造 token：relay 用真实生产后端复核 → **401**（`real-backend-auth-check.log`）。
- APP 无 token：`canRequestVideoSession()` 为 false，直接显示“登录已失效，请重新登录后再试探望”，**不发起网络请求、不显示画面**（APP 单测覆盖）。
- 跨家庭隔离：当前生产只有 1 个监护账号（`luxunxluxunluxun`），**无法构造第二个家庭的真实账号做越权测试** → 该场景标记 NOT TESTED；代码上视频权限完全由后端账号 token 派生，relay 不提供任何无鉴权入口，APP 不把 token 放 URL。

## 3. 边界与未完成（如实）

1. **DAYU200 当前无 IP 网络**（`wlan0/eth0` 无 IPv4），DAYU→relay 必须经 USB/HDC `fport`；PC 关机/拔线即断。这不是“公网直连视频”，也不是“DAYU 本机 localhost 验证”。
2. **公网 ECS 路径未部署**：`competition/deploy/video/` 已产出 compose/Caddy/install/rollback 并本机静态校验（`caddy validate` 通过、Caddyfile patch 幂等），但 ECS 无 SSH 访问，需用户在阿里云 Workbench 执行 `sudo bash /root/eldercare-upload/competition/deploy/video/install-on-ecs.sh`。未执行前公网视频标记 **BLOCKED-BY-DEPLOY**，不得宣称公网可用。
3. **手机为 HarmonyOS 模拟器**（实体手机无 bundle 签名材料，NOT TESTED）；APP 中继地址默认 `http://10.0.2.2:9443`（模拟器验收用），生产需通过 AppStorage `video.relayBase=https://api.luxunacc.xyz` 注入（页面暂无编辑入口）。
4. **帧率**：3.2–4.0 fps，属低帧率实时预览（设备端 Surface 取帧 130–280ms + JPEG 编码 60–220ms 为瓶颈），不是 30fps 视频；未做 AVCodec H.264 硬编码、音频、录像/回放、多观看者并发（relay 上限 2）。
5. **网络隔离验证范围**：模拟器（10.0.2.0/24 NAT）↔ 宿主 relay（0.0.0.0:9443）经 IP 路由，DAYU 侧只有 USB/HDC；未做“手机 4G 经公网访问 DAYU”的真实验收（需 ECS 部署 + 实体手机）。
6. 20:39–20:41 的 relay 中断是验收过程中 Lead 主动重启 relay 所致（用于验证失败/重试），不是产品缺陷；已记录在时间线里。

## 4. 证据文件

| 文件 | 内容 |
|---|---|
| `app-video-01-opening.jpeg` | 首次进入、第 12 帧真实画面（640×480、3.8fps、最近帧时间、中继地址） |
| `app-video-02..06-*.jpeg` | 连续 5 张实时画面（帧号递增、整屏 hash 各异） |
| `app-video-07/08-*.jpeg` | 加载中状态 |
| `app-video-09-after-relay-restart.jpeg` | relay 恢复后自动继续（第 188 帧） |
| `app-video-11-connection-failed.jpeg` | 显式连接失败 + `错误类型: timeout` + 重试按钮（无假画面） |
| `app-video-12-reconnected.jpeg` | 手动重试后恢复真实画面（第 48 帧） |
| `app-video-13/16-*.jpeg` | 结束探望返回首页 |
| `app-video-14/15-long-60s-*.jpeg` | ≥60s 连续播放开始/结束（第 281 帧、3.6fps） |
| `dayu-streaming-status.jpeg` | DAYU 板端同时显示“远程探望：推流中 · 23 帧 · 3 fps”与相机预览、AI 推理在跑 |
| `dayu-video-logs.txt` / `dayu-video-long-session-logs.txt` | DAYU hilog：监听/观看者连接/开始取帧/帧耗时/停止取帧/断开 |
| `relay-owned.log` | relay 完整生命周期日志（session/ticket/连接/首帧/frames/idle stop） |
| `relay-ws-real-token.log` + `relay-frames/` | Lead 独立 WS 客户端用真实 APP token 收到的 44 帧与统计（证据链交叉验证） |
| `app-video-sha256.txt` | 各截图 SHA-256（证明画面不同） |

## 5. 复现命令（本机）

```powershell
# 1) DAYU 板端 APP 1.0.4 已安装；建立 HDC 端口映射
& <WORKSPACE>\tools\hdc\hdc.exe -t 450100445634303332012847942eca00 fport tcp:9301 tcp:9301
# 2) 启动 relay（local 模式）
cd <WORKSPACE>\competition\video\relay
$env:VIDEO_MODE='local'; $env:VIDEO_RELAY_HOST='0.0.0.0'; $env:VIDEO_RELAY_PORT='9443'
$env:BACKEND_BASE='https://api.luxunacc.xyz'; $env:DAYU_HOST='127.0.0.1'; $env:DAYU_PORT='9301'
node server.js
# 3) 模拟器安装 APP 1.0.9 并登录；首页 → 视频探望
& <WORKSPACE>\tools\hdc\hdc.exe -t 127.0.0.1:5555 install -r <guardian-battery-video-1.0.9-unsigned.hap>
```

回滚：APP 用历史 1.0.8 HAP 覆盖安装（`../2026-10-27-real-capability-app/app/guardian-real-capability-1.0.8-unsigned.hap`）；DAYU 用 `../2026-10-27-dayu200-real-capability/rollback-1.0.2-signed.hap` 或 1.0.3；relay 为独立进程，停止即回滚，无持久化数据。
