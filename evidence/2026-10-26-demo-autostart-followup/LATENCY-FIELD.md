# 耗时字段核对（页面 “248 ms” / 此前 “222 ms”）

结论：**正式页面的 ms 不是单帧推理耗时，也不能与 P1-B summary 的 inferMs 中位数直接比较。**

## 1. 页面显示链路

正式 HAP 源（工作副本）：

- `VisionFrameStreamer.ets`
  - `DEFAULT_VISION_ENDPOINT = http://127.0.0.1:9200/v1/frames/dayu200-living`
  - `FRAME_INTERVAL_MS = 250`
  - `captureAndSend()` 在抓取前记录 `startedAt = Date.now()`（L139）；
  - `createPixelMapFromSurface` → JPEG pack → `http.createHttp().request(POST)`（L143–166）；
  - 成功收到 2xx 后：`lastLatencyMs = Date.now() - startedAt`（L191）；
  - 失败路径也设置 `lastLatencyMs`（L197），页面此时显示“未连接/重试”，不会把它显示成检测成功。
- `Index.ets` L284：
  ```text
  cameraVisionText = `${resultText} · ${status.framesSent} 帧 · ${status.lastLatencyMs} ms`
  ```
- `framesSent` 在收到 HTTP 2xx 后递增，不是服务端推理完成计数。

因此页面数值口径是：

```text
Surface 抓取 + JPEG 编码 + HTTP POST 到 127.0.0.1:9200
+ DAYU 服务端 HTTP 处理/回包 + 客户端 JSON 解析
```

是**客户端请求往返时间**（loopback）；不是纯网络 RTT，也不是模型推理时间。

## 2. 服务端为什么可能小于 605 ms

P1-B 源：

- `HTTP /v1/frames/` 收到 POST 后：
  - `frames_received++`；
  - 把 body 放入 `FrameSlot`，通知 worker；
  - **立即**把 `last_result` 作为响应返回（L780–796）；
  - worker 异步执行 `model.infer_jpeg`，完成后再更新 `last_result`（L684–731）并写事件。
- `inferMs` 来自 worker 的 `r.infer_ms`，写入事件和最终 summary；不在 POST 的同步回包里等待。

所以：

- 页面 `lastLatencyMs` 可以是 **222/248 ms**；
- 同一时段 summary/inferMs 可以是 **605/641 ms**；
- 两者不是同一指标，不构成矛盾。
- 同时，页面 `personDetected` 也来自 `last_result`，可能滞后于当前 POST 帧；`framesSent` 也不是已完成推理帧数。

## 3. 本轮同段证据

- 页面快照：`检测到人体 · 4909 帧 · 248 ms`（`pre-ui.json`，2026-10-26 01:12 左右）。
- 最近一条推理事件：`inferMs=641.00`（`frameTsMs=1792948362224`，`frameTs` 同段）。
- 因此 248 ms 与 641 ms 是**两个不同口径**，不应互相校验或用来改写性能统计。

## 4. 是否要改

现状标签 `... 帧 · 248 ms` 没有说明“ms”是什么，容易被读成检测/推理延迟；建议的最小修正（需要正式 HAP 更新时再评估，本轮不擅自重装）：

1. 仅改文案：`... 帧 · 上传往返 248 ms`；数值不变；需重新构建/签名/安装正式 HAP，保留应用数据。
2. 更完整：服务端响应已含 `inferMs`，若要让页面显示真实推理耗时，`VisionInferenceResponse` 增加 `inferMs` 字段并显示“推理 641 ms / 上传往返 248 ms”；这是 HAP 行为变化，需用户确认，不能在本轮擅自做。
3. 不改 HAP 时：在文档/看护器状态中明确页面 ms 是客户端往返；不把页面数值当推理性能。

本轮未改数字、未改统计口径、未改 HAP。
