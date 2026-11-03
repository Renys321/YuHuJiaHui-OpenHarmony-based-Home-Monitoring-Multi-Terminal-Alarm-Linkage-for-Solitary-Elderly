# LIVE-PERSON-REDO3（conf 0.7，镜头转向客厅）

## 1. 精度问题与最小候选参数

- 默认 `conf=0.25` 时空墙/瓶状物被误检；`--conf 0.5` 仍有 23/164 帧误检（小框约 60×90）。
- 改用既有二进制参数 `--conf 0.7`（不改正式 HAP）：
  - 空场景测试 142/142 帧 `personCount=0`；
  - 未再出现固定瓶状物误检。
- 这是候选推理阈值配置，不是正式应用变更；正式 HAP 仍为 1.0.2。## 2. 四段真实时间线

事件文件：`formal-redo3-events.jsonl`（最终拉取 646 条可解析事件，1 条文件尾截断；板端 infer p50≈625ms、p95≈662ms）；服务 320/rotate=0，正式应用帧。设备在服务结束/拉取 summary 前再次 HDC 复位，因此未取得最终 summary；不使用缺失的 summary 编造资源统计。

```text
23:48:09–23:49:27   personCount=0   78s   （无人基线）
23:49:27–23:49:50   personCount=1   23s   （单人全身入镜）
23:49:50–23:50:15   personCount=0   25s   （离开，无人）
23:50:15–23:50:39   personCount=1   24s   （再次进入，全身）
23:50:39–23:50:50   personCount=0   11s   （离开）
```

- 四段均 ≥15s（78/23/25/24s），满足“无人→有人→无人→再次有人”。
- 事件 `dataValid=true`，`source=dayu-camera-http`；不是 retained，也不是历史截图。
- 保存帧 `redo3-frame_000001..4.jpg` 为 640×480、无 EXIF；拍摄于 23:46–23:47（镜头调整早期），最终四段由原始 personCount 事件证明。
- 无人段期间 conf0.7 保持 personCount=0；真人段保持 personCount=1；没有把墙/瓶子当作人。

## 3. 结论

```text
LIVE_PERSON_SEQUENCE: PASS（conf 0.7，本轮）
```

限制：
- 未使用 person-class 置信度（P1-B 事件无该字段），以 personCount + 有效关键点/状态为准；
- 四段动作期间只有自然相机帧，无手工注入；
- 正式 HAP 未改；conf0.7 只作用于本轮候选服务，是否正式采用需另行决策；
- 厨房/卫生间三节点仍 1/1，与本四段独立。
