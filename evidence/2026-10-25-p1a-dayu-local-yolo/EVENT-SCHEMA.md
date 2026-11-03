# 事件 Schema 与真实样例

## 1. 事件 schema

`p1a.dayu.local.vision.event/1`（每帧一行 JSON，追加写本地文件；不发布到 MQTT/后端）

| 字段 | 类型 | 含义 |
|---|---|---|
| `schema` | string | 固定 `p1a.dayu.local.vision.event/1` |
| `source` | string | `dayu-image-file`（阶段 A）或 `dayu-camera-http`（阶段 B/C） |
| `host` | string | `dayu200` |
| `model.id` | string | `yolo11n-pose-ncnn-640-static` |
| `model.format` | string | `ncnn` |
| `model.input` | [w,h] | `[640,640]` |
| `model.class` | string | `person` |
| `frameTsMs` | int64 | 帧到达/处理时刻的墙上时钟（ms） |
| `eventTsMs` | int64 | 事件写出的墙上时钟（ms） |
| `timeSource` | string | `CLOCK_REALTIME_wall+CLOCK_MONOTONIC_duration` |
| `personCount` | int | 有效时为检出人数（NMS 后）；**无效时为 -1，绝不写 0** |
| `dataValid` | bool | 解码+推理均成功才为 true |
| `stale` | bool | 保留字段；本任务实时处理，写 false |
| `error` | string | 失败原因（`jpeg_decode_failed`/`inference_extract_failed`/`unexpected_output_shape` 等） |
| `inferMs` | float | ncnn 推理耗时（ms） |
| `detections[]` | array | 每个检出：`bbox:[x,y,w,h]`（原图像素）、`conf`、`confSemantics`、`keypoints[17][x,y,conf]` |
| `confSemantics` | string | 明确“person 类别 sigmoid 分数，不是 PIR/跌倒/SOS” |
| `rssKb` | int | 进程 VmRSS |
| `cpuSeconds` | float | 进程累计 CPU 秒（utime+stime） |
| `tempC` | float | thermal_zone 温度（°C） |
| `droppedFrames` | int | 因“最新帧”队列而丢弃的旧帧累计数 |

失败语义：事件 `dataValid=false`、`personCount=-1`、`detections=[]`，消费方必须按“数据无效”处理，不能解释为“无人”。

## 2. 真实样例（阶段 A，完整行）

```json
{"schema":"p1a.dayu.local.vision.event/1","source":"dayu-image-file","host":"dayu200","model":{"id":"yolo11n-pose-ncnn-640-static","format":"ncnn","input":[640,640],"class":"person"},"frameTsMs":1792859524658,"eventTsMs":1792859524658,"timeSource":"CLOCK_REALTIME_wall+CLOCK_MONOTONIC_duration","personCount":1,"dataValid":true,"stale":false,"error":"","inferMs":1706.00,"detections":[{"bbox":[47.37,763.06,612.01,336.47],"conf":0.47492,"confSemantics":"person-class sigmoid score; not PIR, fall or SOS","keypoints":[[269.2,962.9,0.2384],[252.4,930.0,0.1291],[243.5,962.5,0.1084],[264.2,883.2,0.0312],[226.8,956.0,0.0361],[340.6,881.0,0.1876],[339.5,949.5,0.1357],[442.5,879.9,0.4460],[441.4,931.8,0.3530],[359.8,923.3,0.6986],[362.9,929.0,0.7072],[477.8,871.6,0.1551],[472.5,906.4,0.1454],[592.9,883.5,0.0775],[575.2,930.9,0.0849],[621.0,882.1,0.0355],[582.6,962.4,0.0399]]}],"rssKb":109096,"cpuSeconds":1.95,"tempC":47.8,"droppedFrames":0}
```

## 3. 真实样例（阶段 B/C，节选；完整见 `raw/events_cam.jsonl`）

```json
{"schema":"p1a.dayu.local.vision.event/1","source":"dayu-camera-http","host":"dayu200",
 "model":{"id":"yolo11n-pose-ncnn-640-static","format":"ncnn","input":[640,640],"class":"person"},
 "frameTsMs":1792860140000,"eventTsMs":1792860141844,"timeSource":"CLOCK_REALTIME_wall+CLOCK_MONOTONIC_duration",
 "personCount":1,"dataValid":true,"stale":false,"error":"","inferMs":1844.00,
 "detections":[{"bbox":[11.2,6.5,627.3,464.0],"conf":0.637,"confSemantics":"person-class sigmoid score; not PIR, fall or SOS","keypoints":[/* 17 个点，实际文件完整 */]}],
 "rssKb":122060,"cpuSeconds":123.4,"tempC":58.3,"droppedFrames":640}
```

（JSON 注释仅用于文档说明；实际事件行无注释、无省略。）

## 4. 对 DAYU APP 的 HTTP 响应

候选服务对 `POST /v1/frames/<id>` 立即返回上次推理结果（毫秒级），推理在后台对最新帧执行：

```json
{"ok":true,"personDetected":true,"personCount":1,"dataValid":true,
 "source":"dayu-local-yolo","fall":false,"fallEvaluated":false,
 "inferMs":1844.0,"stale":false}
```

- 兼容原 `VisionFrameStreamer` 读取的 `ok/personDetected/fall/source` 字段。
- `fall` 恒为 false，且明确 `fallEvaluated=false`；本任务不做跌倒判定，不冒充。
- 首次尚无结果时返回 `personDetected=false, dataValid=false, stale=true, reason=no_frame_processed_yet`，消费方不应把它当“确认无人”。

## 5. 时序/丢帧语义

- 相机约 250 ms 一帧；本机推理约 1.8 s/帧（约 0.51–0.53 FPS）。
- 只保留最新帧：新帧到达时若上一帧尚未处理，则覆盖并 `droppedFrames++`；事件中可据此区分“采集帧率”与“推理帧率”。
- 没有任何“用旧帧冒充新帧”的逻辑；事件时间戳为实际到达时间。
