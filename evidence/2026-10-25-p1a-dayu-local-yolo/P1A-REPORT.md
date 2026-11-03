# P1-A：DAYU200 本机 YOLO 人体检测迁移与真实性能验证

日期：2026-10-25（Asia/Shanghai）
目录：`<WORKSPACE>\competition\evidence\2026-10-25-p1a-dayu-local-yolo\`

## 0. 结论

```text
DAYU_LOCAL_CAMERA_INFERENCE_PASS
CPU_ONLY
```

- 推理确实在 DAYU200 本机执行（原生 arm32 musl 进程），PC 不参与最终推理。
- 输入确实来自 DAYU 官方 APP 的实际相机预览帧（不是 PC 摄像头上传、不是回放）。
- 阶段 A 单图真实推理通过；阶段 B 进入/离开/再次进入真实通过；阶段 C 相机活跃连续 19.0 分钟（>10 分钟），错误 0。
- 未使用 NPU：当前系统没有 `/dev/rknpu`/NPU 驱动节点，也没有 RKNN 运行库；只有 NN Runtime stub。因此只能如实标记 **CPU_ONLY**，不能标记 `NPU_VERIFIED`。
- 未修改/未安装正式 APP、未动 P0 的 Broker/Bridge/public-sync/supervisor/homemon，未做 4G，未做正式 APP 集成。

## 1. 八个必答问题

| # | 问题 | 结论 |
|---|---|---|
| 1 | 推理是否真的在 DAYU 本机？ | **是**。DAYU 上 `/data/local/tmp/p1a-yolo-2026-10-25/dayu_local_yolo` 加载本机模型文件执行；事件由板端进程写出；板端 CPU 时间与推理耗时可对上（阶段 A 单帧 1.69–1.71 s；连续运行 CPU ~97% 单核）。PC 端 9200 无监听，PC 未参与该进程推理。 |
| 2 | PC 是否仍参与推理？ | **否**。PC 只做模型转换、交叉编译、部署、证据收集；PC 上的 ncnn 参考运行仅用于准备阶段对照（同一图 personCount=1、conf 0.479 vs 板端 0.475），不参与验收结果。 |
| 3 | 输入是否是 DAYU 实际实时相机？ | **是**。DAYU 正式 APP 的相机预览通过既有 `VisionFrameStreamer` 每约 250 ms 向 **设备本机** `http://127.0.0.1:9200/v1/frames/dayu200-living` POST JPEG；候选进程在 DAYU 上收帧并推理。事件 `source=dayu-camera-http`，帧时间戳连续。相机端点为设备 loopback，不是 PC。 |
| 4 | 有人/无人/再次进入是否真实验证？ | **是**。阶段 A：有人图 personCount=1，两张无人图=0；阶段 B：真实操作序列在 00:41:06–00:41:37 产生 0→1→0→1→0→1 的检测跳变（推理约 1.8 s/帧，存在延迟与个别抖动）；阶段 C 分布 0:369、1:213、2:1（另有 24 条 2 人事件因日志缓冲缺陷被截断，缺陷已修复并复验）。 |
| 5 | 连续运行多久，帧率、耗时、内存？ | 相机活跃 **19.0 min**（1141.7 s，>10 min）；服务总运行 21.7 min。相机窗口：采集 2.43 fps、推理 0.51 fps（丢旧帧 78.9%）；推理 p50=1.844 s、p95=1.890 s（max 2.737 s）；RSS 109–122 MB（稳定后约 122 MB）；温度 48.3–60.6 °C；CPU 约 97% 单核；错误 0。 |
| 6 | 当前正式 P0 是否仍可用？ | **是**。supervisor/worker 仍为 11872/50580（HEALTHY），homemon PID 2449 未重启，fport `tcp:9001→tcp:9000` 仍在，手机 APP PID 26710 仍在；测试窗口内三设备 202 持续增长（厨房 225→245、卫生间 195→215、客厅 246→268；测试后继续增至 262/232/286）。 |
| 7 | 是否已接入 APP？默认应为没有。 | **没有接入**。未修改/未安装任何 APP，未改 HAP、未改手机 APP、未改后端。阶段 B 仅利用 DAYU 正式 APP **既有**的取帧上传行为，让帧进入设备本机候选服务；响应虽被 APP 读取，但不构成正式集成。 |
| 8 | 距整套链路脱离电脑还缺什么？ | 见 §10。当前只完成“DAYU 本机相机→本机推理→本机事件文件”；还缺：推理/相机能力正式进入 DAYU APP 或常驻服务、事件接入 homemon/Bridge/MQTT/public-sync、启动/看护/回滚产品化、性能优化（CPU 约 0.53 FPS；NPU 需驱动+运行库）、以及正式 APP/网关侧联调。 |

## 2. 现场与读取范围

- DAYU HDC target：`450100445634303332012847942eca00`（USB），shell 为 root；所有 HDC 命令均显式指定该 target。
- DAYU 事实：OpenHarmony 7.0.0.38（`const.product.software.version`），API 26，内核 `Linux 6.6.101 aarch64 Toybox`；用户态为 **32-bit ARM musl**（`/lib/ld-musl-arm.so.1`、`/lib/libc++_shared.so`）；4×Cortex-A55（0xd05）最高 1.992 GHz，governor=performance；MemTotal 2,001,872 kB；`/data` 约 19 GB 可用。
- 实际读取的 P0 文件：`competition/docs/evidence/2026-10-24-p0-final-freeze.md`、`competition/docs/evidence/2026-10-24-p0a-supervisor-real-acceptance.md`、`competition/evidence/2026-10-24-p0-final-demo-backup/MANIFEST.md`。
- 实际读取/核对的关键代码：
  - `competition/vision/README.md`、`yolo_pose_service.py`（`do_POST`/`do_GET`/`_send_json`/`process_jpeg`，L602–729）、`fall_detector.py`、`vision_guardian.py`、`frame_orientation.py`。
  - `competition/northbound/entry/src/main/ets/model/VisionFrameStreamer.ets`（端点 `http://127.0.0.1:9200/v1/frames/dayu200-living`、250 ms 间隔、2500 ms 超时、响应字段）。
  - `competition/northbound/entry/src/main/ets/model/CameraModel.ets`（`startPreview`/`createCameraInput`/`createPreviewOutput`/`release`，L90–165）。
  - `competition/northbound/entry/src/main/ets/pages/Index.ets`（相机页 `cameraPageActive=true`、`visionStreamer.start(...)` L379–386、`XComponent` L1296）。
- 检索到 108 处 RKNN/NPU/本机推理相关文档命中；实际用于路线判断的是上述文件加本机只读探测，未把历史“可行性报告”当作验收。

## 3. 兼容性矩阵（摘要）

| 层 | 实测 | 证据 | 结论 |
|---|---|---|---|
| 系统 | OpenHarmony 7.0.0.38 / API 26 / kernel 6.6.101 aarch64 | `param get`、`uname -a` | 可用 |
| 用户态 ABI | 32-bit ARM musl（ELF32） | `/lib/ld-musl-arm.so.1`、`/lib/libc++_shared.so`、板端二进制 `llvm-readelf` | 必须交叉编译 arm32；arm64 不可用 |
| CPU | 4×Cortex-A55，1.992 GHz，performance | `/proc/cpuinfo`、cpufreq | 可用（CPU_ONLY） |
| 内存/存储 | 2 GB RAM；`/data` 约 19 GB 空闲 | `/proc/meminfo`、`df` | 足够 |
| NPU | **无** `/dev/rknpu`/`/dev/npu`；devfreq 无 npu；无 RKNN 库 | `/dev`、`/sys/class/devfreq`、`find *rknn*`、`dmesg` | NPU 不可用 |
| NN 运行时 | 无 rknn/mnn/onnxruntime/tflite 运行库；仅 `libnnrt_stub_*.z.so` | `/system/lib`、`/vendor/lib` 列表 | 不能直接跑 NPU/通用 RT |
| MindSpore Lite | SDK 有 `libmindspore_lite_ndk.so`（34,812 B），但设备无运行时/转换器，SDK 无 `converter_lite` | SDK 与设备只读检查 | 不作为本轮路线 |
| 相机设备 | `/dev/video0/1` 为 rkisp_mainpath/selfpath，owner `camera_host:camera_host` mode 660；camera_host/camera_service 常驻 | `/sys/class/video4linux`、`ls -l /dev/video*`、`ps` | 不能安全地由 shell 直接抢占；走 APP 取帧 |
| 相机帧通道 | 正式 APP 每 250 ms POST JPEG 到设备 loopback 9200 | `VisionFrameStreamer.ets`、候选服务收帧 | 可在设备本机接收 |
| 工具链 | OHOS native SDK clang 15.0.4 / cmake 3.28.2；`ohos.toolchain.cmake` 支持 armeabi-v7a | SDK 文件与编译输出 | 可用 |
| NEON | OHOS 三元组下 `-march=armv7a -mfpu=neon` **不生效**；必须 `-mcpu=cortex-a7 -mfloat-abi=softfp` | 编译探针 + 性能对比（155 s → 1.7 s） | 已修正 |
| 板端二进制 | ELF32 ARM PIE；依赖 `libc++_shared.so`、`libc.so`（设备均存在） | `llvm-readelf -h/-d` | 可运行 |
| P0 端口 | `tcp:9001→tcp:9000` 未被改动 | `hdc fport ls` | P0 未受影响 |

详见 `COMPATIBILITY-MATRIX.md`。

## 4. 路线选择

1. **先查 NPU**：板端无 NPU 设备节点与 RKNN 运行库；`libnnrt_stub` 只是接口桩，不是可执行后端。→ 不能走 NPU。
2. **再查通用运行时**：设备无 Python/OpenCV/ncnn/ONNX Runtime/TFLite；SDK 的 MindSpore Lite 只有 NDK 包装库，无转换器和设备运行时。→ 排除。
3. **选择 ncnn CPU**：从 gitee 获取 ncnn（GitHub 不可达），用 OHOS clang 交叉编译静态库；用 pnnx 在 PC 把 `yolo11n-pose.pt` 转成 ncnn param/bin。板端 C++ 程序完成 JPEG 解码、letterbox、推理、NMS、JSON 事件。
4. **相机不直接抢 V4L2**：复用正式 APP 已存在的相机预览与 JPEG 上传协议，在设备 loopback 9200 起本机接收服务；不改 APP、不装新 HAP、不替换 homemon。代价是验证期间需要用户打开正式 APP 相机页（已集中一次操作），且相机被预览占用（测试后已退出 APP 恢复）。
5. **有界队列**：只保留最新帧，旧帧丢弃；HTTP 先返回上次结果以保证 APP 请求不超时，推理线程异步处理最新帧。

## 5. 模型与构建（摘要）

- 原始模型：`competition/vision/yolo11n-pose.pt`，6,255,593 B，SHA-256 `869E83FCDFFDC7371FA4E34CD8E51C838CC729571D1635E5141E3075E9319DC0`；Ultralytics YOLO11n-pose，COCO-pose，许可证 **AGPL-3.0**（元数据 `license: AGPL-3.0 License`）。
- 输入：1×3×640×640 RGB，letterbox 到 640×640，pad 114，/255 归一化。
- 输出：单 blob `out0`，8400 anchors × 56 features：`[cx,cy,w,h, person_score, 17×(x,y,conf)]`；score 与 kpt conf 已 sigmoid；坐标在 640 padded 像素空间。
- 转换后：`model.ncnn.param` 25,357 B SHA `6214EAE5…F22F7E3`；`model.ncnn.bin` 11,634,260 B SHA `531602E6…28E21FEA`；metadata SHA `ACD1953D…61BF1B`。
- 依赖版本：ultralytics 8.4.175、torch 2.14.1+cpu、pnnx 20260526、ncnn Python 1.0.20261020；ncnn 源码 commit `cb65ca26ba955bf456f3a26e13e9a644769fc4a4`；OHOS clang 15.0.4；cmake 3.28.2。
- 关键构建命令与完整参数见 `MODEL-AND-BUILD.md`。

## 6. 阶段 A：单图真实推理

命令（板端，root）：

```sh
cd /data/local/tmp/p1a-yolo-2026-10-25
./dayu_local_yolo --image testdata/person_camera_preview.jpeg \
  --param model/model.ncnn.param --bin model/model.ncnn.bin \
  --events evidence/events_stageA_neon.jsonl --stats evidence/stats_stageA_neon.jsonl --threads 4
```

结果（真实板端输出，完整 JSON 见 `raw/events_stageA_neon.jsonl`）：

| 图 | personCount | dataValid | inferMs | 备注 |
|---|---:|---|---:|---|
| `person_camera_preview.jpeg`（DAYU 相机预览，2 人） | 1 | true | 1706 | conf 0.47492，bbox [47.37,763.06,612.01,336.47] |
| `no_person_camera_check.jpeg`（空场景） | 0 | true | 1698 | 无检测 |
| `no_person_living_room.jpeg`（空客厅） | 0 | true | 1685 | 无检测 |

PC 参考对照（仅准备阶段，不参与验收）：同一有人图 PC ncnn 参考 personCount=1、conf 0.47896；板端 1、0.47492，差异在 float 精度内。

**真实缺陷与修复**：第一版 ncnn 仅用 `-march=armv7a` 编译，NEON 未启用，单帧耗时 **154,879 ms**；改用 `-mcpu=cortex-a7 -mfloat-abi=softfp` 后降至约 1.7 s/帧。该对比是 CPU_ONLY 性能结论的一部分，旧数据保留在 `raw/stats_stageA.jsonl`（旧构建）供审计。

## 7. 阶段 B：真实相机进入/离开/再次进入

- 相机帧来源：DAYU 正式 APP 相机预览 → `POST http://127.0.0.1:9200/v1/frames/dayu200-living`（JPEG）；候选服务在设备本机接收并推理。
- 相机活跃窗口：2026-10-25 00:35:37.8 ～ 00:54:39.5 CST（1141.7 s，19.0 min）。
- 用户按集中说明执行：进入画面约 10 s → 离开约 15 s → 再次进入约 10 s。
- 事件检测跳变（真实板端日志；推理延迟约 1.8 s，存在抖动）：

```text
00:35:39.809  personCount 0 -> 1
00:35:41.656  personCount 1 -> 0
00:41:06.985  personCount 0 -> 1
00:41:14.620  personCount 1 -> 0
00:41:22.108  personCount 0 -> 1
00:41:33.369  personCount 1 -> 0
00:41:37.136  personCount 0 -> 1
... 后续阶段 C 继续出现 0/1（及 1 次 2 人）跳变
```

结论：进入、离开、再次进入均有真实相机帧对应的 personCount 变化，不是预录视频，也不是 PC 推理回传。

**日志缺陷**：主运行 607 条事件中 24 条（多人/长 JSON）因 1024 B 固定缓冲被截断，无法解析；推理、耗时、统计不受影响（stats 由进程内计数器写出）。已修复为无固定缓冲拼接并复验：
- 修复后短时相机复验 149.8 s：80/80 事件可解析，badLines=0；采集 2.46 fps、推理 0.53 fps、p50=1.862 s、p95=1.898 s、错误 0。
- 长事件压力：单条事件 4,153,622 字符、8400 个检测，JSON 完整可解析（`raw/events_stress.jsonl`）。

## 8. 阶段 C：连续稳定性

服务 21.7 min（其中相机活跃 19.0 min）。官方进程内统计 `raw/stats_cam.jsonl`：

```text
framesReceived=2800  framesInferred=607  framesDropped=2192  errors=0
inferMsP50=1844  inferMsP95=1889  inferMsAvg=1850.69
captureFps=2.15  inferFps=0.47  rssKb=122020  cpuSeconds=1113.58  tempC=60.6
```

相机活跃窗口重算（`raw/stageBC_analysis.json`）：

```text
cameraActiveSec=1141.7  received=2775  inferred=583  dropped=2192 (78.9%)
inferMsP50=1844  p95=1890  min=1792  max=2737
captureFps=2.43  inferFps=0.51
rssKbMin=109204  rssKbMax=122132  tempCMin=48.3  tempCMax=60.6
cpuUtilPercent=97.3 (单核)  errors=0
personCount distribution: 0=369, 1=213, 2=1
```

- 内存：启动预热后稳定在约 122 MB，无增长泄漏迹象。
- 温度：48.3–60.6 °C；CPU governor 仍为 performance、频率 1.992 GHz，未观察到降频。
- 线程：1/2/4 线程耗时均约 1.7 s，ncnn 在当前构建下未随线程数扩展（CPU 约 1 核），因此按实测报告，不虚报多核加速。
- 帧率语义：采集约 2.4 FPS（APP 实际 POST 到达率），本机推理约 0.51–0.53 FPS；采用“最新帧”有界队列，未处理帧明确计为 dropped，不把丢帧伪装成低帧率或“无人”。

## 9. 事件本地输出与 APP 响应

事件 schema：`p1a.dayu.local.vision.event/1`（详见 `EVENT-SCHEMA.md`）。真实事件样例（截取）：

```json
{"schema":"p1a.dayu.local.vision.event/1","source":"dayu-camera-http","host":"dayu200",
 "model":{"id":"yolo11n-pose-ncnn-640-static","format":"ncnn","input":[640,640],"class":"person"},
 "personCount":1,"dataValid":true,"stale":false,"error":"","inferMs":1844.0,
 "detections":[{"bbox":[...],"conf":0.637,"confSemantics":"person-class sigmoid score; not PIR, fall or SOS","keypoints":[...]}],
 "droppedFrames":640,"rssKb":122060,"tempC":58.3}
```

- `dataValid=false` 时 `personCount=-1`，`error` 给出原因；摄像头/解码/推理失败绝不写成“0 人”。
- `confSemantics` 明确：这是 person 类别分数，不是 PIR、跌倒或 SOS。
- 对 APP 的 HTTP 响应为最小兼容 JSON（`ok/personDetected/personCount/dataValid/source/fall=false/fallEvaluated=false/inferMs/stale`），`fall` 恒为 false 且 `fallEvaluated=false`，不冒充跌倒检测。
- 本任务**没有**把事件发布到 MQTT/后端，没有写正式 `deviceId` 链路；仅本机文件。

## 10. 正式 P0 影响与回滚

- 未改/未重启：Broker、Bridge、public-sync supervisor/worker、homemon、手机 APP、后端、HDC fport。
- 测试前后：supervisor 11872 + worker 50580 状态 HEALTHY；homemon PID 2449 未重启；fport 9001→9000 存在；手机 APP 26710 在；三设备 202 持续增加（见 `P0-IMPACT.md`）。
- 相机影响：阶段 B/C 期间由用户在 DAYU 上打开正式 APP 相机预览（这是唯一需要现场配合的动作）；测试结束后已用 `aa force-stop com.dsh.eldercare` 关闭该测试打开的 APP，恢复到测试前“APP 未运行”的状态；未卸载/未改包/未清数据。
- 候选进程：`dayu_local_yolo` 已停止（SIGTERM 后写出 summary，当前 `ps` 无该进程）；候选目录 `/data/local/tmp/p1a-yolo-2026-10-25` 及其日志保留。回滚只需删除该目录，不影响 P0。
- 未发生：COM 操作、烧录、系统/驱动/相机服务修改、HAP 安装、APP/后端修改、MQTT/HTTP ingest、SOS/ACK、密钥读取或落盘。

## 11. 距离“整套链路脱离电脑”还缺什么

1. **把推理正式放进 DAYU 产品路径**：当前是独立候选原生进程 + 正式 APP 既有取帧行为；下一步需要 NAPI/HAP 内嵌或常驻服务，把相机帧直接交给推理，避免依赖用户打开相机页。
2. **事件进入正式链路**：当前只有本机 JSONL；需要按最终架构接入 homemon/Bridge/MQTT/public-sync/后端（本任务按边界未做）。
3. **产品化**：启动/停止、健康检查、看门狗、失败隔离、配置/模型版本、回滚。
4. **性能**：CPU_ONLY 约 0.51 FPS 可作为“本机真实推理”证据，但不足以实时；需要更小输入/量化/算子优化或多核调优。NPU 需要先有 RKNN 驱动与运行库，再谈模型转换；当前不成立。
5. **正式 APP/网关联调**与现场验收：本任务只给接口建议，不实现。

## 12. 证据索引

- 汇总与兼容性：`P1A-REPORT.md`、`COMPATIBILITY-MATRIX.md`
- 复用盘点：`EXISTING-WORK-INVENTORY.md`
- 模型与构建：`MODEL-AND-BUILD.md`
- 阶段 A：`STAGE-A-RESULTS.md`、`raw/events_stageA_neon.jsonl`、`raw/stats_stageA_neon.jsonl`
- 阶段 B/C：`STAGE-B-C-RESULTS.md`、`raw/events_cam.jsonl`、`raw/stats_cam.jsonl`、`raw/stageBC_analysis.json`
- 修复复验：`raw/events_cam2.jsonl`、`raw/stats_cam2.jsonl`、`raw/stageBC_analysis_fixed.json`、`raw/events_stress.jsonl`
- 事件/启停/影响/后续：`EVENT-SCHEMA.md`、`START-STOP-ROLLBACK.md`、`P0-IMPACT.md`、`NEXT-INTEGRATION-NOTES.md`
- 文件清单与哈希：`MANIFEST.md`、`SHA256SUMS.txt`
