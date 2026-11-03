# DAYU 正式 1.0.2 相机帧与本机人物检测回归

日期：2026-10-25
分类：`DAYU_FORMAL_CAMERA_PERSON_REGRESSION_PASS_WITH_CAVEATS`

## 0. 结论

```text
正式帧直接取得：PASS
320 / rotate=0 DAYU 本机推理：PASS
13.7 分钟并行稳定性：PASS（有现场基线降级）
全身 17 点关键点：安全动作后段 17/17 PASS
安全动作跌倒误报：0 次；真实 FALL 正例未测
无人→有人→无人→再次有人：PASS（候选 `--conf 0.7`；默认/0.5 空场有误检）
显示调节隔离：PARTIAL（宽度变化观察，高度调节未完成）
三节点：本轮期间 1/1，仅客厅（DAYU 重启后厨房/卫生间未重连）
```

**不能**写无条件的 `DAYU_FORMAL_CAMERA_PERSON_REGRESSION_PASS`：四段在候选 `--conf 0.7` 下通过，但默认/0.5 阈值空场误检需要显式记录；显示高度调节未完成，三节点基线在本轮为 1/1。

## 1. 本轮真正运行的正式 HAP

| 项目 | 值 |
|---|---|
| 包名 | `com.dsh.eldercare` |
| 版本 | `1.0.2 / 1000002` |
| 安装路径 | `/data/app/el1/bundle/public/com.dsh.eldercare/entry.hap` |
| 大小 | 1,883,399 B |
| SHA-256 | `A696698A627CFEEE1EE90D4F94A3FAF49B4A2F1BB8A2D813CA3AD245324DAFFE` |

未重装、未替换 HAP；本轮重启过正式应用到新 PID（10285）以恢复设置。

## 2. JPEG 是否直接来自正式应用

**是。** 正式应用既有 `VisionFrameStreamer` 向设备本机
`http://127.0.0.1:9200/v1/frames/dayu200-living` POST JPEG；既有 P1-B 候选
`dayu_local_fall` 在 DAYU 本机接收并推理，事件 `source=dayu-camera-http`。
不是独立 previewtest、不是历史 JPEG、不是截图。

## 3. JPEG 尺寸、像素方向、EXIF

| 文件 | 尺寸 | 字节 | SHA-256 | EXIF orientation |
|---|---|---:|---|---|
| frame_000001.jpg | 640×480 | 34,664 | `2A1CD2B6…30DBEA1` | 无 |
| frame_000002.jpg | 640×480 | 49,208 | `BD12A563…60305943` | 无 |
| frame_000003.jpg | 640×480 | 45,435 | `BAA16950…D546FAC2` | 无 |

- 三帧均 RGB，PIL 读取无 orientation 标签。
- 实际像素方向正向：床架/门框竖直、人物正向；不是仅凭宽高推断。
- frame 2/3 可见全身/大部分身体；frame 1 是较近景。
- 只保留 3 张验收帧；不连续录制、不上传。

## 4. rotate=0 与 PC 参与

- 输入 **320**，`--rotate 0`，4 threads。
- 推理进程在 **DAYU 板端**（`dayu_local_fall`，ELF32 ARM）。
- PC 只执行命令、拉取日志和证据，**不参与最终推理**。
- 事件中 `modelInput=[320,320]`、`source=dayu-camera-http`、`inferMs` 为板端耗时。

## 5. 无人→有人→无人→再次有人

### 5.1 精度问题

默认 `conf=0.25` 时，空墙/瓶状物被误检为人（小框约 60×90）。`--conf 0.5` 仍有 23/164 帧误检；`--conf 0.7` 空场测试 **142/142 帧 NO_PERSON**。0.7 仅是本轮候选服务的配置参数，正式 HAP 未改。

### 5.2 四段通过

镜头转向客厅、其他人离开后，`--conf 0.7` 服务记录到干净时间线：

```text
23:48:09–23:49:27   personCount=0   78s
23:49:27–23:49:50   personCount=1   23s
23:49:50–23:50:15   personCount=0   25s
23:50:15–23:50:39   personCount=1   24s
23:50:39–23:50:50   personCount=0   11s
```

- 0→1→0→1 四段均 ≥15s（78/23/25/24s）；
- 无人段 0，单人段 1；没有把墙/瓶子当人；
- 事件 `source=dayu-camera-http`、`dataValid=true`，不是 retained；保存帧 `redo3-frame_000001..4.jpg` 为辅助证据；
- 这是本轮真实通过项，候选阈值需在正式集成前另行决策。

## 6. 显示调节是否影响 JPEG/推理方向

- 原始参数 `60% / 130%` 已记录；一次宽度调节把 preference 从 60 改到 90，推理事件继续增长（425→448 后继续到 1288），相机未停止。
- 已恢复 60/130；原始参数保留。
- **高度调节未完成**：DAYU 重启后正式相机卡调节控件在当前 UI 布局中不可见/不可点击；未获得调节后的新 JPEG。
- 已观察部分通过，但**不能**把“显示调节隔离”写成完全 PASS。

## 7. 并行性能与三节点

长时 320 服务（`--duration 1200`，实际 SIGTERM 结束）：

```text
elapsedSec=823.8 (>10min)
framesReceived=1798, framesInferred=1288, framesDropped=510, errors=0
inferMsP50=591, p95=672, min=556, max=1281
captureFps=2.18, inferFps=1.56
RSS=63,096 KB, temp=50.0 ℃
fallConfirmedEvents=0
```

- P0 supervisor `HEALTHY` pid 11632，worker 9908，restartCount=0；Broker 1883、Bridge 9101 运行；fport `tcp:9001→tcp:9000`。
- 另外，`--conf 0.7` 四段服务在 HDC/设备再次复位前记录 646 条事件，personCount 分布 0=442/1=203/2=1，板端 infer p50≈625ms/p95≈662ms；因设备复位未取得最终 summary，**不把 0.7 版本写成完整 10 分钟统计**；10 分钟以上的资源统计来自前一轮 `--conf 0.25` 服务（823.8s）。
- **三节点本轮降级为 1/1（仅 living）**：本轮开始前 DAYU 重启/HDC USB Offline；HDC 服务重启后恢复 target/fport，但 Bridge 9101 无厨房/卫生间无线对等连接。页面只显示 `dayu200-living`。
- 不是候选推理造成；未改 Wi-Fi/AP/绑定，未重启/烧录 ESP32。需用户确认厨房/卫生间供电与无线重连。

## 7A. 全身姿态与安全动作 / 跌倒误报

用户调整相机后重新运行既有 P1-B 320/rotate=0 服务（272.7s）：

```text
framesReceived=606, framesInferred=436, framesDropped=169, errors=0
inferMsP50=589, p95=613, max=1051
UPRIGHT=126, SITTING_OR_CROUCHING=285, TRANSITION=2, UNKNOWN=23, HORIZONTAL=0
fallConfirmedEvents=0
```

- 23:18:37 之后的全身段达到 **17/17 关键点有效**；肩、髋、膝、踝置信度最高约 0.96–0.99，见 `POSE-AND-FALL-RESULTS.md`。
- 保存帧 `pose-frame_000003/000004.jpg` 可见全身/坐姿全身。
- 用户完成站立、坐下、弯腰、蹲下、恢复等安全动作；posture 实际输出 UPRIGHT/SITTING_OR_CROUCHING/TRANSITION/UNKNOWN，无 HORIZONTAL。
- 没有逐动作人工时间标注，因此**不能**声称四类动作逐项分类全部正确；可确认全身关键点有效、姿态状态有真实变化。
- 安全动作期间 `fall=false`、`fallConfirmedEvents=0`，无 FALL 误报；关键点从 7–11 恢复到 17 未触发 FALL。
- 离线状态机 fixture 13/13 为历史结果，本轮未重跑；**未执行真实危险跌倒**，真实 FALL 正例未验证。
- P1-B 事件无 person-class 置信度字段；只报告 personCount/keypoint confidence，不伪造置信度。

## 8. 错误、遗漏与未验证

1. DAYU 重启/HDC target 离线；通过重启 HDC 服务恢复；fport 重建。
2. 设备重启后 **previewtest 曾自动运行**，已 force-stop，避免抢相机。
3. 正式应用因恢复 preference/HDC 后曾重启（未重装 HAP）。
4. 四段真人序列：初次尝试被多人/误检阻塞；最终在候选 `--conf 0.7` 下形成 0→1→0→1（78/23/25/24s）；0.7 是否正式采用仍需决策。
5. 高度调节与调节后 JPEG 未验证；显示控件在当前布局不可见。
6. 三节点厨房/卫生间未重连，当前 1/1。
7. 全身关键点本轮已验证；但未逐动作标注姿态分类，未做真实 FALL 正例，未做 P0-A/P0-B 全量重验。
8. P1-B 事件无 person-class 置信度字段；只记录 personCount 与关键点置信度，不伪造置信度。

## 9. 结束状态

| 项目 | 状态 |
|---|---|
| 本轮候选 P1-B | **STOPPED**（无进程；9200 NO-LISTEN） |
| DAYU 9200 | **NO-LISTEN**（仅 TIME_WAIT） |
| previewtest | **STOPPED** |
| 正式应用 | 运行 PID 2446，1.0.2/1000002 |
| 正式 HAP | 未变，`A696…DAFFE` |
| 正式预览参数 | 60% / 130% |
| homemon | 运行 PID 2385，9000 LISTEN |
| fport | `tcp:9001→tcp:9000` |
| Broker/Bridge/supervisor/worker | 保留运行；supervisor HEALTHY |
| 三节点 | 1/1，仅客厅 |

## 10. 生产告警/状态写入

**没有。**
- P1-B 候选只写 DAYU 本地 JSONL；
- 未发布 MQTT、未发送 HTTP ingest 到生产；
- 未触发 SOS/FALL/ACK/reset；
- 未自动清除原 ALARM；
- `fall=false, fallEvaluated=false, fallConfirmedEvents=0`。

## 11. 距全身姿态与跌倒验收还缺什么

1. **恢复厨房/卫生间无线节点**，使三节点回到 3/3。
2. **验证高度调节**与调节后 JPEG/推理不变（当前控件不可见）。
3. **全身姿态**：17 点关键点已真机验证，但需要逐动作人工标注，才能断言站立/坐下/弯腰/蹲下四类分类全部正确；当前只验证关键点与状态变化。
4. **跌倒判断**：安全动作下 0 误报、关键点丢失/恢复未触发 FALL；fixture 13/13 为历史；真实危险跌倒正例未验证，不能声称跌倒检测完成。
5. **阈值决策**：0.7 消除空场误检且四段通过，但需确认正式集成后的召回/精度；本轮未改正式 HAP。

## 12. 证据

- `FORMAL-FRAME-RESULTS.md`
- `LIVE-PERSON-REGRESSION.md`
- `LIVE-PERSON-REDO3.md`
- `POSE-AND-FALL-RESULTS.md`
- `STABILITY-AND-P0-IMPACT.md`
- `formal-surface-frames/`（3 张正式 JPEG）
- `formal-redo3-events.jsonl` / `formal-redo3-server.log`、`redo3-frame_000001..4.jpg`
- `formal-capture-events.jsonl` / `formal-capture-stats.jsonl` / `formal-capture-server.log`
- `formal-live-events.jsonl` / `formal-live-stats.jsonl` / `formal-live-server.log`
- `live-frame_000001..4.jpg`
- `p0-supervisor-state.json`
- `final-state.txt`
- `MANIFEST.md`、`SHA256SUMS.txt`
