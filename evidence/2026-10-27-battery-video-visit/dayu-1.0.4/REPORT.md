# DAYU200 板端 APP 1.0.4（视频探望推流）— 真机实施记录（2026-10-27）

- 设备：DAYU200，`hdc` target `450100445634303332012847942eca00`，OpenHarmony 7.0.0.38 / API 26，720×1280
- 包名：`com.dsh.eldercare`，**1.0.3 / 1000003 → 1.0.4 / 1000004**
- 构建源：`competition/experiments/dayu-eldercare-preview-integration-2026-10-25`（1.0.3 的同一工作副本）
- 新包：`dayu-eldercare-video-1.0.4-signed.hap`，1,353,199 B，SHA-256 `05230657B89B7D8AFE29C7F94AEC57639887F706725C005603E024B3DA68CF60`
- 签名：`hap-sign-tool sign-app`，`-keyAlias "openharmony application release"`，`-appCertFile northbound/signing/app-chain.pem`，`-profileFile northbound/signing/final-profile.p7b`（debug profile，bundle=`com.dsh.eldercare`，UDID 已绑定）；`verify-app` success；`appProvisionType=debug` 与原包一致；覆盖安装保留应用数据
- 未签名中间包：`dayu-eldercare-video-1.0.4-unsigned.hap`（1,890,855 B）、`...-norpc.hap`（1,332,977 B，剔除 SDK 26 的 `rpcid.sc`）

## 1. 实现

新增 `entry/src/main/ets/model/VideoStreamServer.ets`（只读相机预览 Surface 按需取帧）：

- `@ohos.net.socket` `TCPSocketServer` 监听 **127.0.0.1:9301**（只回环，不对外）；
- 单客户端；无客户端时**不取帧、不编码、不发帧**；
- 控制行：`hello` → `start` → `started` → 帧流 → `stop` → `stopped`（契约见 `../CONTRACTS/VIDEO-VISIT-CONTRACT.md`）；
- 帧格式：4 字节大端长度 + JPEG；`image.createPixelMapFromSurface(cameraSurfaceId)` 取当前正在显示的那一路相机画面，`ImagePacker` 编码 JPEG（quality 60），目标 8 fps、按实际耗时自适应（上一帧慢则立即下一帧）；
- 相机预览/视觉推理/告警/ACK 主链路不受影响；取帧失败只降级记录，不停相机；
- 服务生命周期跟随页面：`aboutToAppear` 启动监听，`aboutToDisappear` 关闭；相机预览仍由既有自动监护链路持有（不额外开第二个相机）。

`Index.ets` 接入：

- 启动/停止服务，回调 `cameraSurfaceId` 与 `cameraPreviewActive`（只在预览活跃时取帧；相机未就绪时向观看者发 `waiting` 并 500ms 重试）；
- 客厅摄像头卡片新增真实状态行：`远程探望：就绪（无观看者）` / `观看者已连接，等待开始` / `推流中 · N 帧 · M fps` / `未就绪（listen failed: ...）`；
- `AppScope/app.json5` 版本 1.0.4 / 1000004；设备信息卡版本行更新。

## 2. 真机验收（2026-10-27 20:22–20:26）

端口映射：`hdc -t 450100… fport tcp:9301 tcp:9301` → OK（PC 127.0.0.1:9301）。

PC 测试客户端：`competition/video/tools/dayu-frame-client.js`（只统计真实收到的帧，不生成任何帧）：

```
node dayu-frame-client.js --seconds 12 --save-dir .../live-frames
```

结果（原始 JSON 见 `live-frames-test.log` / `live-frames-test2.log` / `live-frames-test3.log`）：

| 项 | 结果 |
|---|---|
| 控制握手 | hello（`cameraActive:true`）→ started → stopped 全部按契约收到 |
| 帧数 | 12.8s / 46 帧（第一次，q72）；12.8s / 37 帧（q60）；10s / 29 帧 |
| fps | 2.68–3.59（实测；瓶颈为设备端 Surface 取帧 150–250ms + JPEG 编码 ~85ms） |
| JPEG 合法性 | 46/46、37/37、29/29 全部 `FFD8…FFD9` |
| 帧唯一性 | `uniqueFrameHashes == frames`（逐帧不同，不是静态图/旧帧循环） |
| 帧大小 | 29,331–38,919 B（640×480） |
| 停止语义 | 发 `stop` 后收到 `stopped`；客户端断开后板端日志“观看者断开（已发送 N 帧）” |
| 无观看者时不取帧 | 板端日志只在收到 start 后出现 `开始取帧`；断开后回到空闲，UI 显示“就绪（无观看者）” |

证据：

- `live-frames/dayu-live-frame-00..04.jpg`：从 DAYU200 相机实时收到的原始帧（640×480，房间真实画面；非截图/推理图/静态图）。
- `dayu-streaming-ui.jpeg`：推流中/就绪时的 DAYU 屏幕（版本 1.0.4）。
- `dayu-camera-card-scrolled.jpeg`：相机卡片滚动后可见 `远程探望：就绪（无观看者）`，同日 `检测到人体 · 188 帧` 说明既有视觉推理仍在工作（未因推流服务停掉）。
- 板端 hilog 原始行（示例）：
  - `[VideoStreamServer] 已监听 127.0.0.1:9301`
  - `[VideoStreamServer] 观看者已连接` → `开始取帧 viewer=lead-acceptance-client`
  - `frame#1 capture=244ms pack=87ms send=4ms bytes=29483`
  - `停止取帧（已发送 37 帧）` → `观看者断开：peer closed`

## 3. 边界与未完成

1. DAYU200 **当前无 IP 网络**（`wlan0/eth0` 均无 IPv4），本机到 PC 的帧通道必须经 USB/HDC `fport`；这是设备网络现状，不是“公网直连视频”。手机端可达性由 relay 负责（见主报告）。
2. 实测 2.9–3.6 fps，属**低帧率实时预览**（非 30fps 视频）；原因是设备端 Surface 读取 + JPEG 编码耗时，未做硬件编码（AVCodec H.264）改造。不得把它描述成高帧率视频。
3. 与既有 `VisionFrameStreamer`（250ms 一次推理取帧）并存；两者都从同一相机预览 Surface 取帧，实测可同时工作，但会互相占用取帧时间（这也是低 fps 的原因之一）。未改变视觉推理链路。
4. 未做：H.264/AVCodec 硬件编码、音频、录像/回放、多人并发（服务端单客户端）；需在后续版本评估。
5. 回滚：`hdc -t 450100… install -r competition/evidence/2026-10-27-dayu200-real-capability/rollback-1.0.2-signed.hap`（历史回滚包），或重装 1.0.3；覆盖安装保留数据。
