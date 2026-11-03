# DAYU200 视频帧率优化 — 实测结果（2026-10-27 深夜）

## 结论（先说结果）

- **8 fps 未达到**。在 DAYU200 实机上，限制项是板端取帧 API（`createPixelMapFromSurface`）本身约 **130–240 ms/帧**，JPEG 编码不是主因；因此无论分辨率如何，端到端持续帧率上限约 **4–5 fps**。
- 已实现并安装 **1.0.10**：取帧分辨率/质量/间隔可配置（运行时 config 控制消息），默认 **320×240、JPEG q60、单帧在途、复用 ImagePacker**；APP 实测约 **4.0 fps 稳定**（320×240，完整视野），比原 640×480 约 3.5 fps 有提升。
- 实测最高是 **320×240 中心裁剪 5.2 fps**，但画面被中心放大（人物/全屋视野变差），**不推荐**作为默认。
- 原有相机预览、视觉推理、告警/ACK 代码路径未改动；视频仍按需开启、退出停止取帧。

## 1. 分段耗时（板端 hilog 实测，320×240 默认配置）

| 阶段 | 典型耗时 | 说明 |
|---|---|---|
| 取帧 `createPixelMapFromSurface` | **130–240 ms** | 主要瓶颈；即使裁剪 region 也仍接近全幅读回成本 |
| 缩放到目标分辨率（320×240） | 30–60 ms | 仅当目标≠源（640×480）时 |
| JPEG 编码（复用 ImagePacker） | 10–30 ms（320×240），60–124 ms（640×480） | 分辨率下降后明显下降 |
| TCP 发送 | 2–12 ms | 局域网，可忽略 |
| **单帧合计** | **约 215–330 ms** | 对应理论上限 3–4.7 fps；裁剪省掉缩放可到 ~5 fps |

## 2. 配置对比（PC 直连 DAYU Wi-Fi，每档 20s 实测，唯一帧=帧数）

| 配置 | 客户端收到帧率 | 平均帧大小 | 首帧延迟 | 备注 |
|---|---|---|---|---|
| 640×480 q60 全幅 | 3.46–3.55 fps | 22.6 KB | 454 ms | 最清晰，原默认 |
| 640×480 q50 全幅 | 3.46 fps | 19.2 KB | — | 质量下降但帧率几乎不变 |
| 480×360 q60 全幅 | 2.9–4.2 fps | 12 KB | 416 ms | 中间档 |
| 480×360 q60 中心裁剪 | 4.2–5 fps | 12 KB | — | 视野变窄 |
| **320×240 q60 全幅（最终默认）** | **3.9–4.7 fps** | 6.8–8.2 KB | 219–278 ms | 视野完整，帧率最高档之一 |
| 320×240 q50 全幅 | 4.3–4.6 fps | 6.9 KB | — | 与 q60 接近 |
| **320×240 q60 中心裁剪** | **5.2 fps** | 4.1 KB | 219 ms | 帧率最高，但画面为中心放大（拒绝） |

> APP 端 1 分 42 秒连续采样：帧号 142→211→276→354→420→486→554，APP 自报 3.9–4.1 fps（320×240 默认）；同期独立 WS 客户端 180 s 收到 553 帧、**553 个唯一 hash（无重复帧）**、平均 3.05 fps。之后因 Wi-Fi/relay 链路抖动，APP 返回首页（详见 §4）。没有用重复帧/缓存帧充数。

## 3. 实现改动（仅视频路径）

- `VideoStreamServer.ets`：默认 320×240 / q60 / interval 0；`config` 控制消息可切换 width/height/quality/intervalMs/crop；单帧在途（`captureInFlight`）防积压；**复用 ImagePacker**；裁剪模式直接向 Surface 取 region（不缩放）；每 20 帧打印 cap/scale/pack/send 分段耗时；hello 携带实际分辨率/质量。
- 未改相机预览、VisionFrameStreamer/AI 推理、告警、ACK、homemon、bridge、手机 APP、账号鉴权。
- 构建：1.0.9（测量用，含 1.0.8 全部上一任务改动）→ **1.0.10 最终默认 320×240**；已签名/覆盖安装并运行（PID 27321 时）。

## 4. 未达成项与现场限制（如实）

1. **3 分钟连续 APP 实测只完成约 1 分 42 秒**：随后 DAYU Wi-Fi 在屏幕锁屏后掉线、IP 从 .250/131 变化，relay 报 `dayu link not established`，APP 回首页。已用 `power-shell timeout` 覆盖息屏、并把 DAYU 静态 IP 固定为 10.127.130.131 恢复；最后重开视频已恢复（healthz `dayuLink=connected, viewers=1, fps=3.5` 起播），但本轮未再凑满完整 3 分钟。
2. **拔 USB 最终验收本轮未重做**：1.0.6 已证明“拔 USB 后视频经 Wi-Fi 继续”，本次只改分辨率/质量/发送逻辑，未改传输路径；严格起见仍需现场拔一次 USB 复验。
3. **8 fps 结论**：若必须达到 8 fps，需要更换取帧路径（如相机 ImageReceiver/YUV 回调直取或降低相机预览输出分辨率），这会改动相机/预览/AI 输入，属于下一阶段工作，不能靠调定时器或 relay 实现。

## 5. 回滚

- 1.0.6（视频 Wi-Fi 基线，已验证拔 USB 可用）：`competition/evidence/2026-10-27-video-wifi/dayu-video-wifi-1.0.6-signed.hap`
- 1.0.8（上一任务横幅版）：`competition/evidence/2026-10-27-reconnect-dayu-sos/dayu-sos/build/dayu-eldercare-1.0.5-signed.hap`（1.0.5）及 1.0.8 安装包见该目录构建产物
- 安装：`hdc -t <target> install -r <signed.hap>`（保留数据）

## 6. 证据文件

`client-*.log`（各配置原始客户端统计）、`device-*.log`（板端 cap/scale/pack/send 原始日志）、`app-frame-counter-3min.txt`（APP 帧号采样）、`ws-3min.log`（唯一帧 553/553）、`app-video-final-*.jpeg` / `app-3min-t*.jpeg`（APP 实拍）、`relay-final*.log`、`fps-client.js`（测量工具）。
