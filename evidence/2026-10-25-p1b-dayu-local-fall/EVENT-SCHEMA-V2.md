# 事件 Schema V2（本地事件）

schema：`p1b.dayu.local.fall.event/2`
只写 DAYU 本地 JSONL；**不发布到 MQTT/后端/homemon/APP**。

## 1. 字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `schema` | string | 固定 `p1b.dayu.local.fall.event/2` |
| `source` | string | `dayu-camera-http` / `dayu-image-file` / `dayu-frame-replay` |
| `deviceId` | string | `dayu200-p1b-candidate`（候选，不是正式设备 ID） |
| `modelId` | string | `yolo11n-pose-ncnn-320-static-p1b`（随尺寸） |
| `modelVersion` | string | `p1b-2026-10-25` |
| `modelInput` | [w,h] | 320/416/640 |
| `frameTsMs` | int64 | 帧到达墙上时钟（ms） |
| `eventTsMs` | int64 | 事件写出墙上时钟（ms） |
| `dataValid` | bool | 解码+推理成功 |
| `personCount` | int | 有效推理的 NMS 后人数；无效为 **-1**，绝不拿失败当 0 |
| `trackId` | string | `tN` 主目标轨迹 |
| `posture` | string | NO_PERSON/UPRIGHT/SITTING_OR_CROUCHING/HORIZONTAL/TRANSITION/UNKNOWN |
| `postureConfidence` | float | 0–1，姿态置信（不是跌倒概率） |
| `fallState` | string | MONITORING/DESCENT_CANDIDATE/HORIZONTAL_CANDIDATE/PERSISTENT_HORIZONTAL/FALL_CONFIRMED/UNKNOWN |
| `fall` | bool | **仅** `eventType=FALL_CONFIRMED` 的那一条为 true |
| `fallEvaluated` | bool | 只有 dataValid + 稳定主目标 + 关键点足够 + 完成评估才 true |
| `fallEventId` | string | `p1b-<trackId>-<seq>`；同一次跌倒唯一 |
| `reasonCodes` | string[] | 如 RAPID_DESCENT/HORIZONTAL_WITHOUT_DESCENT/KPT_INSUFFICIENT |
| `descentVelocity` | float | 归一化下降速度（图像高/s，正=向下） |
| `torsoAngle` | float | 躯干相对垂直角度（度） |
| `bboxAspectRatio` | float | w/h |
| `horizontalDurationMs` | int | 水平候选持续 |
| `validKptCount` | int | conf≥0.30 的关键点数 |
| `kptConfAvg` / `kptConfMin` | float | 17 点平均/最低置信度 |
| `eventType` | string | STATE/FALL_CONFIRMED/RECOVERED/RECOVERY_UNCONFIRMED |
| `fallAlreadyConfirmed` | bool | 已确认后持续帧为 true |
| `fallEventActive` | bool | 当前是否有活动跌倒事件 |
| `recovered` | bool | RECOVERED 事件为 true |
| `trackSwitched` | bool | 换主目标时 true |
| `selectedReason` | string | 当前主判断原因 |
| `primaryBBox` | [x,y,w,h] | 主目标 bbox（原图像素） |
| `primaryKeypoints` | 17×[x,y,conf] | 主目标关键点（用于审计/基准；事件不含图像） |
| `inferMs` | float | ncnn 推理耗时 |
| `droppedFrames` | int | 最新帧队列丢帧累计 |
| `rssKb` / `cpuSeconds` / `tempC` | number | 进程/设备状态 |
| `error` | string | 失败原因 |

## 2. 真实样例（DAYU 真实相机近景，320；原行见 `raw/perf_events.jsonl`）

```json
{"schema":"p1b.dayu.local.fall.event/2","source":"dayu-camera-http","deviceId":"dayu200-p1b-candidate",
 "modelId":"yolo11n-pose-ncnn-320-static-p1b","modelVersion":"p1b-2026-10-25","modelInput":[320,320],
 "dataValid":true,"personCount":1,"trackId":"t1","posture":"UNKNOWN","postureConfidence":0.000,
 "fallState":"UNKNOWN","fall":false,"fallEvaluated":false,"fallEventId":"",
 "reasonCodes":["KPT_INSUFFICIENT"],"descentVelocity":0.000,"torsoAngle":0.00,"bboxAspectRatio":1.128,
 "horizontalDurationMs":0,"validKptCount":6,"kptConfAvg":0.349,"kptConfMin":0.006,
 "eventType":"STATE","fallAlreadyConfirmed":false,"fallEventActive":false,"recovered":false,"trackSwitched":false,
 "selectedReason":"KPT_INSUFFICIENT","primaryBBox":[232.5,121.2,403.0,357.3],
 "primaryKeypoints":[[288.8,266.9,0.9672],[322.4,228.7,0.9801], "...17 points in raw file..."],
 "inferMs":457.00,"droppedFrames":50,"rssKb":63180,"cpuSeconds":126.61,"tempC":56.1,"error":""}
```

（此处为可读节选；完整无省略行在 `raw/perf_events.jsonl`。）

## 3. FALL 事件

FALL 只在以下**唯一条件**出现：

```text
dataValid=true
+ 主目标稳定（hits≥2）
+ 快速下降候选（≥0.45 图像高/s 且 ≥0.15 图像高）
+ HORIZONTAL 持续 ≥800ms → PERSISTENT_HORIZONTAL
+ 距首次水平 ≥2200ms
→ 唯一 FALL_CONFIRMED 转换事件，fall=true
```

之后持续横卧：`fallState=FALL_CONFIRMED, fall=false, fallAlreadyConfirmed=true`，`fallEventId` 不变，不重复 FALL。

## 4. 对 DAYU APP 的 HTTP 响应

```json
{"ok":true,"personDetected":true,"personCount":1,"dataValid":true,
 "source":"dayu-local-p1b","fall":false,"fallEvaluated":false,
 "inferMs":457.0,"stale":false,
 "p1bPosture":"UNKNOWN","p1bFallState":"UNKNOWN","p1bFallEvaluated":false,"p1bFallEventId":""}
```

- 兼容旧字段；
- **本轮固定 `fall=false, fallEvaluated=false`**：不接正式 APP 告警（用户要求本任务只到本地事件）；
- 本地事件里的真实状态可供下轮 APP/网关迁移使用，但不能把 HTTP 200/进程存活当 FALL。
