# DAYU200 实时视频改走家庭 Wi-Fi（拔掉 USB 后 APP 仍可看）— 交付报告（2026-10-27 23:2x）

## 0. 结论

**已完成并真机验收**：DAYU200 视频服务从只监听 `127.0.0.1:9301` 改为家庭局域网可访问（`0.0.0.0:9301`，仅私网/回环来源白名单），PC relay 改为连接 DAYU 的 Wi-Fi 地址 `10.127.130.250:9301`。**实拔 DAYU USB 数据线后**，手机模拟器 APP 内视频继续连续播放（截图中帧号 33→79→481，实测 4.5–5.0 fps，640×480）；点“结束探望”后 relay 3 秒内 idle stop、板端停止取帧。手机 APP/账号鉴权链路未改。

```text
DAYU200 摄像头 → 板端 APP 1.0.6 VideoStreamServer（0.0.0.0:9301，仅私网来源）
  → 家庭 Wi-Fi（ElderCareLab，DAYU 10.127.130.250）
  → 电脑 relay（0.0.0.0:9443，Bearer token → 生产后端复核 → 一次性 ticket）
  → 手机 APP（模拟器经 10.0.2.2:9443）→ 实时画面
```

## 1. 改动

| 组件 | 改动 |
|---|---|
| DAYU APP（构建源 `competition/experiments/dayu-eldercare-preview-integration-2026-10-25`） | `model/VideoStreamServer.ets`：监听地址 `127.0.0.1` → `0.0.0.0`；新增**私网来源白名单**（10/8、172.16/12、192.168/16、127/8，其余拒绝并回 `LAN_ONLY`）；`onClientConnected` 先取对端地址校验再接纳；版本 1.0.6 / 1000006。**未改**相机预览/视觉推理/告警/ACK/语音逻辑；未改手机 APP、未改账号鉴权。 |
| 打包/安装 | 构建 `BUILD SUCCESSFUL`；`package_hap.py` 剔除 `rpcid.sc` + `hap-sign-tool sign-app/verify-app`（与原包同一 debug 身份）；`hdc install -r` 覆盖安装，`bm dump` = 1.0.6 / 1000006 |
| relay | 重启为 `DAYU_HOST=10.127.130.250`、`DAYU_PORT=9301`（local、0.0.0.0:9443、生产后端复核 token）；移除 `hdc fport tcp:9301`（不再有 USB/HDC 视频通道） |
| 边界 | 视频端口只在家中私有 Wi-Fi 上；DAYU 无公网 IP、无端口映射；relay 仍要求 APP 登录 token（无 token/伪造 token → 401，沿用现有契约） |

## 2. 真机验收证据

1. **PC 直连 DAYU Wi-Fi 取流**：`node dayu-frame-client.js --host 10.127.130.250 --port 9301` → `ok:true`，10.8s 收到 **44 帧**，640×480，JPEG 全部合法，`uniqueFrameHashes=44`，4.07 fps（`direct-lan-stream.log`、`direct-lan-frames/`）。
2. **经 relay + 真实 APP token**：`POST /video/session` 200 → WS 收 **44 帧/10.8s（3.97 fps）**，unique hashes=44，`/video/session/end` 200（`relay-ws-test.log`、`relay-frames/`）。
3. **APP 内连续画面（拔 USB 前）**：`app-video-wifi-1.jpeg` 第 33 帧 / 4.7 fps；`app-video-wifi-2.jpeg` 第 79 帧 / 4.6 fps（画面人物位置变化）。
4. **实拔 DAYU USB 后**：`hdc list targets` 只剩模拟器（无 `4501…`）；relay healthz `dayuLink=connected, viewers=1, framesReceived 536→560`（+24 帧/4s）；APP `app-video-wifi-3-after-usb-unplug.jpeg` **第 481 帧 / 5 fps**，画面继续更新（人物已移动）——证明视频不再依赖 USB/HDC。
5. **结束探望**：点“结束探望”（`app-video-wifi-4-ended.jpeg`）→ relay 日志 `viewer left`、`session end 200`、`idle stop`；healthz 变为 `dayuLink=down, viewers=0, fps=0`，frames 停在 654；板端不再取帧。
6. relay 原始日志：`relay-wifi.out.log`（连接 `10.127.130.250:9301`、first frame 691ms、framesSent 582）。

## 3. 限制与后续建议（如实）

1. **DAYU IP 会变**：DAYU 重连 Wi-Fi 时使用随机 MAC，DHCP 曾把 IP 从 .131 变到 .250；relay 目前硬编码 `.250`。建议在 AP 上给 DAYU 做 DHCP 保留/静态 IP，或在 IP 变化时重启 relay 指向新 IP（记录在案，不影响本次验收）。
2. **设备级无单独 token**：9301 目前靠“仅私网来源白名单 + 设备无公网 IP + relay 鉴权”保护；家庭 Wi-Fi 内其他设备理论上可直连 9301（只能看到客厅画面）。若需更强隔离，可再加设备端共享 token（本轮未做，避免再改动）。
3. **APP 内版本行**：`AppScope/app.json5` 已是 1.0.6/1000006，但页面“APP 版本”文案因并行会话改动冲突未能更新（仍显示 1.0.5 文案），属显示层小问题，不影响功能；下一版一并修。
4. **相机/推理**：视频帧持续来自 DAYU 相机预览 Surface，证明拔 USB 后相机与取帧仍在跑；本机 NCNN 推理进程不依赖 USB，拔线前在跑，拔线后无法再用 hdc 抓进程（证据以用户现场目视 + 视频持续帧为准）。
5. 帧率仍为约 4.5–5 fps（JPEG 640×480 低帧率预览），与上一轮一致；若需 15–30fps 需改 H.264 硬编码，不在本任务范围。

## 4. 文件

- `dayu-video-wifi-1.0.6-signed.hap` / `-norpc.hap` / `-unsigned.hap`、`verify-chain.cer`、`verify-profile.p7b`
- `direct-lan-stream.log`、`direct-lan-frames/`
- `relay-ws-test.log`、`relay-frames/`、`relay-wifi.out.log`
- `app-video-wifi-1/2/3/4-*.jpeg`（APP 实拍：Wi-Fi 取流、拔 USB 后继续、结束）
- `SHA256SUMS.txt`

## 5. 复现/回滚

- 回滚 DAYU APP：`hdc -t 4501… install -r <上一轮 1.0.5 signed HAP>`（覆盖安装保留数据）。
- relay 回滚：改为 `DAYU_HOST=127.0.0.1:9301` 并恢复 `hdc fport tcp:9301 tcp:9301`（即上一轮 USB/HDC 模式）。
- 当前 DAYU USB 未连接（用户已拔）。
