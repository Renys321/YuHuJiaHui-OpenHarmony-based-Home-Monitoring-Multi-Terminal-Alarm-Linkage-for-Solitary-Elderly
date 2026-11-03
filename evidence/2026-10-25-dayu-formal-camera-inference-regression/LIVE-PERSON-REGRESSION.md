# LIVE-PERSON-REGRESSION

## 1. 长时服务配置

- 程序：既有 P1-B `dayu_local_fall`（SHA-256 `EF58405E…6BBF0A`）
- 命令参数：`--serve 127.0.0.1:9200 --duration 1200 --threads 4 --size 320 --rotate 0`
- 输入：正式 `com.dsh.eldercare 1.0.2` 的 Surface 帧（`source=dayu-camera-http`）
- PC 不参与推理。
- 服务最终收到 SIGTERM 写出 summary；9200 已停止监听。

## 2. 实际运行统计

```text
elapsedSec=823.8 (约 13.7 分钟)
framesReceived=1798
framesInferred=1288
framesDropped=510
errors=0
inferMsP50=591, p95=672, min=556, max=1281
captureFps=2.18, inferFps=1.56
RSS 63,096 KB；temp 50.0 ℃
postureCounts: UPRIGHT=337, SITTING_OR_CROUCHING=308, UNKNOWN=488,
               NO_PERSON=145, HORIZONTAL=0, TRANSITION=10
fallConfirmedEvents=0
```

- 事件文件：`formal-live-events.jsonl`（1288 条）
- 统计：`formal-live-stats.jsonl`
- 服务日志：`formal-live-server.log`
- P1-B 事件只提供 personCount、bbox、17 点关键点置信度等；**没有 person-class 置信度字段**，因此本报告不伪造“person conf”，只报告 personCount 与关键点置信度统计。

## 3. 四阶段尝试与结果

用户被要求按“无人 15s → 有人全身入镜 15s → 离开 15s → 再次进入 15s”执行。

实际事件中观察到 personCount 的快速抖动，例如：

```text
23:08:17 0  -> 23:08:21 1 -> 23:08:23 0 -> 23:08:24 1
23:09:30 0  -> 23:09:34 1 -> 23:09:35 0 -> 23:09:36 1
23:10:16 0（约 10s）-> 23:10:26 1 -> 23:10:28 0 -> 23:10:29 1
23:10:46 0（约 14s）-> 23:11:00 2
```

- 画面中始终有其他人在镜头内（用户随后明确反馈**无法清空画面**）；
- 因此无法得到干净、连续、每段 ≥10–15s 的“无人→有人→无人→再次有人”；
- 320 模型确实检测到人物（personCount 1/2，UPRIGHT/SITTING/UNKNOWN），但不能把抖动的时间线写成四阶段 PASS；
- 用户也确认当前取景可见全身，但“无人”条件被现场人员占用，属于现场条件阻塞。

## 4. 结论

```text
LIVE_PERSON_SEQUENCE_BLOCKED
```

阻塞条件：**镜头内无法形成无人画面（现场有其他人）**。

若需完成该验收，需用户完成：
- 确保镜头内无其他人（包括画面右侧/后方）；
- 无人静置 15–20s；单人全身入镜静置 15–20s；离开 15–20s；再次进入静置 15–20s。

本轮不做真实 FALL/跌倒动作、不触发 PIR，不把 personCount 抖动写成姿态/跌倒结论。

## 5. 清场重做（23:24–23:29）

用户再次确认清场后，重新启动同一 P1-B 320/rotate=0 服务，实际运行 309.0s：

```text
framesReceived=686, framesInferred=495, framesDropped=190, errors=0
inferMsP50=591, p95=615
NO_PERSON=102, UPRIGHT=140, SITTING_OR_CROUCHING=169,
UNKNOWN=83, TRANSITION=1, HORIZONTAL=0
fallConfirmedEvents=0
```

personCount 1s 分箱：

```text
23:24:46 P（2 人）
23:26:17 0（约 16s）
23:26:33 P（约 52s）
23:27:25 0（仅约 2s，随后反复 0/1）
```

- 23:26:17–23:26:33 确实出现约 16s 无人；
- 但保存帧 `redo-frame_000001..4.jpg` 仍能看到 **2–3 人**（含右侧/后方人员）；
- 23:27:25 之后没有干净的“离开 15–20s → 再次进入 15–20s”，只剩短暂 0 与抖动；
- 因此仍不能形成完整的四段，不能写 PASS。

结论保持：`LIVE_PERSON_SEQUENCE_BLOCKED`，需要其他人全程离开镜头后再做一次。
