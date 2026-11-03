# 阶段 B/C：真实相机本机推理结果

## 1. 相机帧来源与接收

- DAYU 正式 APP（`com.dsh.eldercare`）相机页在前台时，`VisionFrameStreamer` 每约 250 ms 向 **设备本机**：
  `POST http://127.0.0.1:9200/v1/frames/dayu200-living`（JPEG body）
- 候选进程在设备上监听 `127.0.0.1:9200`，接收 JPEG、在本机解码/letterbox/ncnn 推理、写 JSONL 事件；HTTP 立即返回上次结果（避免 APP 2.5 s 超时），推理线程异步处理最新帧。
- PC 未监听 9200、未参与推理；PC 只做部署与证据收集。

## 2. 阶段 B：进入/离开/再次进入（真实操作）

用户集中操作一次：进入画面约 10 s → 离开约 15 s → 再次进入约 10 s，保持 APP 前台。

检测跳变（板端事件，CST；推理约 1.8 s/帧，存在延迟/抖动）：

```text
00:35:39.809   0 -> 1
00:35:41.656   1 -> 0
00:41:06.985   0 -> 1     # 用户进入
00:41:14.620   1 -> 0     # 用户离开
00:41:22.108   0 -> 1     # 再次进入
00:41:33.369   1 -> 0
00:41:37.136   0 -> 1
... 后续继续 0/1 跳变（用户仍在画面附近）
```

判定：真实相机帧下 **0→1→0→1→0→1** 已出现，进入/离开/再次进入均被本机模型检测到；不是 PC 回传，也不是预录视频。

## 3. 阶段 C：连续稳定性（官方统计）

服务 21.7 min，其中相机活跃 19.0 min（00:35:37.8–00:54:39.5）。`raw/stats_cam.jsonl`：

```text
framesReceived=2800, framesInferred=607, framesDropped=2192, errors=0
inferMsP50=1844, inferMsP95=1889, inferMsAvg=1850.69
captureFps=2.15, inferFps=0.47 (服务总时长口径)
rssKb=122020, cpuSeconds=1113.58, tempC=60.6
```

相机活跃窗口重算（`raw/stageBC_analysis.json`）：

```text
cameraActiveSec=1141.7  received=2775  inferred=583  dropped=2192 (78.9%)
inferMsP50=1844  p95=1890  min=1792  max=2737
captureFps=2.43  inferFps=0.51
rssKb 109,204-122,132; tempC 48.3-60.6; cpuUtil 97.3% (单核); errors=0
personCount: 0=369, 1=213, 2=1
```

- 10 分钟要求：相机活跃 19.0 min，满足。
- 帧率口径：采集 2.43 FPS（APP 实际到达率），推理 0.51 FPS；未处理帧计入 dropped（78.9%），不伪装为低帧率/无人。
- 线程：1/2/4 线程均约 1.7 s，当前 ncnn 构建未随线程数扩展（CPU 约 1 核）；不虚报多核。
- RSS 稳定在约 122 MB；温度峰值 60.6 °C；governor performance、1.992 GHz，未观察到降频。

## 4. 日志缺陷与修复（真实记录）

- 主运行 607 条事件中 **24 条无法解析**：`event_json` 用 1024 B 固定缓冲放 detections，2 人/长 JSON 被截断。推理/耗时/计数不受影响（stats 来自进程内计数器）。
- 修复：detections 字符串不再经固定缓冲拼接。
- 复验 1（相机 149.8 s，`raw/stats_cam2.jsonl`）：80/80 行可解析，badLines=0；received=368、inferred=80、dropped=288；p50=1862 ms、p95=1898 ms；capture 2.46 fps、infer 0.53 fps；errors=0。
- 复验 2（长事件压力）：单条事件 4,153,622 字符、8400 个检测，JSON 完整可解析（`raw/events_stress.jsonl`）。
- 结论：日志缺陷已修复并复验；阶段 C 的推理/性能统计不受该缺陷影响，但“2 人事件”的完整性以修复后复验为准。

## 5. 候选进程状态

- 候选服务在 00:54:39 收到 SIGTERM，写出 summary 后退出；当前 `ps` 无 `dayu_local_yolo`。
- 设备候选目录保留：`/data/local/tmp/p1a-yolo-2026-10-25/`（程序、模型、测试图、全部证据）。
- 正式 APP 已 `aa force-stop`（测试时由用户打开），恢复测试前“未运行”状态；未卸载/未改包/未清数据。

## 6. 判定

- 阶段 B：**PASS**（真实 DAYU 相机、本机推理、进入/离开/再次进入真实出现）。
- 阶段 C：**PASS**（相机活跃 19.0 min > 10 min，错误 0，内存稳定，性能如实记录）。
