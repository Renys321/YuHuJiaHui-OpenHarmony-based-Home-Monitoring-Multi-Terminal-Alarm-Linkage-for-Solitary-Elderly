# CURRENT-STATE

时间：2026-10-26 00:56（Asia/Shanghai）。

## 入口/进程（最终）

| 项目 | 当前值 |
|---|---|
| 正式入口 | `<WORKSPACE>\competition\materials\start-demo-all.cmd`（可见窗口运行） |
| 看护器 | PowerShell PID 52900，单实例 |
| DAYU target | `450100445634303332012847942eca00` USB Connected |
| 正式应用 | `com.dsh.eldercare` PID 2621，1.0.2/1000002 |
| 正式 HAP | 1,883,399 B，`A696698A627CFEEE1EE90D4F94A3FAF49B4A2F1BB8A2D813CA3AD245324DAFFE`（未修改） |
| 预览参数 | widthPct=60, scalePct=130 |
| DAYU 推理 | 独立目录 PID 19619，9200 LISTEN，`320/rotate=0/conf0.7` |
| homemon | PID 1150（DAYU 重启后由看护器启动） |
| fport | `tcp:9001→tcp:9000` |
| P0 supervisor | PID 11632，HEALTHY，worker 9908，restartCount=0 |
| Broker/Bridge | 1883/9101 监听 |
| 三节点 UI | **2/3**（最终）；曾 3/3 |
| previewtest | 未运行 |
| 用户停止 | 否；演示自动看护运行中 |

## 相机/检测

- 正式页：`监护运行中`，检测辅助文字 `检测到人体 · 2694 帧 · 222 ms`（最终快照）。
- 画面宽度 60%、高度缩放 130%、画面 ±10%、比例 ±5%、重置、暂停/恢复按钮可见可用。
- 看护状态：`app=active detect=running frames=LIVE nodes=2/3`。
- 用户暂停会停止推理；暂停状态 65 秒内不会自动拉起，恢复按钮可恢复。

## 15 分钟稳定性（真实 summary）

```text
elapsedSec=1320.9（22.0 min）
framesReceived=2851
framesInferred=2022
framesDropped=828
errors=0
inferMsP50=605
inferMsP95=655
inferMsMax=1394
captureFps=2.16
inferFps=1.53
rssKb=63136
tempC=52.5
fallConfirmedEvents=0
```

- 15 分钟观察窗口 00:38:17–00:53:17；看护器未重启；frames LIVE。
- 实测 inferFps=1.53，不声称 ≥2 FPS。
- SIGTERM 后看护器自动重启推理（19619），最终运行中。

## 当前限制

- 三节点最终 2/3；验收时曾 3/3 并确认客厅有摄像头、厨房/卫生间未配置摄像头。一个无线节点自然离线，需用户检查供电/重连。
- PC 冷启动（无 P0）未真实执行；P0 健康复用路径已实测。
- 物理拔插 USB 未单独执行；HDC restart + DAYU reboot 已测试。
- 公网同步沿用既有 P0；未人工构造生产 202/MQTT。

## 停止

正式应用点“暂停监护”，或看护窗口按 `S`；恢复按 `R`/“恢复监护”。关闭看护窗口只停看护逻辑，不停 P0/应用/推理。
