# 后续正式集成建议（仅建议，本任务未实现）

本文件只给接口/架构建议，便于后续把“DAYU 本机推理”接入正式链路；P1-A 没有修改 APP/网关/Broker/public-sync。

## 1. 相机与推理的放置

优先级从改动小到大：

1. **DAYU APP 内嵌 NAPI**：在现有 HAP 的 `CameraModel`/`VisionFrameStreamer` 旁增加 native 推理模块；相机 Surface/帧直接给 ncnn，事件交 ArkTS。优点是无需额外进程；缺点是要改 APP（本任务边界内未做）。
2. **常驻原生服务 + APP 取帧**：保留现有 `POST http://127.0.0.1:9200/v1/frames/<id>` 协议，服务常驻并输出事件。改动最小，适合下一阶段先打通事件链路；缺点仍依赖 APP 打开相机页。
3. **独立相机客户端**：需要 camera NDK/权限与独占管理，工作量和风险最大；不建议在 P1 阶段先做。

## 2. 帧接口建议（沿用现有契约）

- `POST /v1/frames/<deviceId>`，`Content-Type: image/jpeg`，有界 body，超时 ≤2.5 s。
- 响应在现有 `ok/personDetected/fall/source` 上增加：
  ```json
  {"ok":true,"personDetected":true,"personCount":1,"dataValid":true,
   "inferMs":1844,"modelId":"yolo11n-pose-ncnn-640-static","stale":false,
   "fall":false,"fallEvaluated":false}
  ```
- `personCount` 与 `personDetected` 必须受 `dataValid` 约束；失败时 `personDetected` 不可当“无人”。
- 保留 `fall` 字段兼容旧消费方，但明确 `fallEvaluated=false` 直到真正接入跌倒判定。

## 3. 事件与状态

建议正式事件字段：

```text
schema/source/deviceId/frameTsMs/eventTsMs/personCount/dataValid/error/inferMs/
captureFps/inferFps/droppedFrames/modelId/modelVersion/rssKb/tempC
```

- `personCount` 为 NMS 后人数；`dataValid=false` 时用 null/-1，禁止 0。
- 独立区分：person 检测、PIR 触发、跌倒判定、SOS/ACK；不得互相替代。
- 事件先写本地可靠队列（本任务为 JSONL），再由正式发布器接 homemon/Bridge/MQTT/public-sync；发布器与推理器解耦，避免网络故障拖垮推理。

## 4. 生命周期与看护

- 常驻服务的 start/stop/healthz、看门狗、崩溃重启、模型版本校验、失败隔离。
- 模型/二进制哈希启动自检；事件目录容量上限/轮转。
- 相机占用与 APP 前台冲突策略（谁持有相机、如何提示）。
- 回滚：保留上一版模型/二进制，失败自动回退；不触碰 homemon/P0。

## 5. 性能路线（当前实测 0.51–0.53 FPS，CPU 1 核）

- 输入尺寸：640 → 416/320（需重新导出与精度验收）。
- 量化/更小模型、ncnn 线程/亲和性调优；先做基准再改架构。
- NPU：只有在确认板端有 RKNN 驱动 + `librknnrt` 运行库 + 转换工具链后，才做 ONNX→RKNN 和精度/性能验收；当前系统不具备，禁止把“SoC 有 NPU”写成已使用 NPU。
- 性能验收应同时报告 captureFps、inferFps、p50/p95、RSS、温度、丢帧率，而不是只报模型理论 FPS。

## 6. 正式验收建议（脱离 PC）

1. DAYU 上电后无需 PC 即可：相机取帧 → 本机推理 → 本地事件/状态；PC 仅做旁观记录。
2. 进入/离开/再次进入 ×N 次，事件时间线可核对；失败注入（相机断/模型坏/内存压力）不得输出“无人”。
3. 连续 ≥10 min，记录 p50/p95、RSS、温度、丢帧、错误。
4. P0 链路（homemon/Bridge/public-sync/手机 APP）同时可用，202 不中断。
5. 断网/恢复、重启/回滚、模型更新各跑一遍。

## 7. 已知限制

- 本任务阶段 B/C 依赖正式 APP 的既有相机预览与 loopback POST；不是 APP 正式集成。
- 候选进程是 root 原生程序，仅用于验证；正式产品应走 HAP/系统服务权限模型。
- 日志/事件未接入正式存储与告警；未做 4G/公网。
- 模型许可证 AGPL-3.0，正式分发前需评估。
