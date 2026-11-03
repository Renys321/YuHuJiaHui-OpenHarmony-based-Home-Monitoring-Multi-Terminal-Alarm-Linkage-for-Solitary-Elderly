# 已有工作盘点（实际读取与复用结论）

本任务不重写已有工作；以下为实际检查到、并在 P1-A 中复用/未复用的对象。

## 1. PC 视觉基线（`<WORKSPACE>\competition\vision\`）

| 文件/函数 | 实际内容 | P1-A 决策 |
|---|---|---|
| `yolo11n-pose.pt`（6,255,593 B，SHA `869E83FC…19DC0`） | Ultralytics YOLO11n-pose，COCO-pose，640 输入，56×8400 输出 | **复用**为转换源 |
| `yolo_pose_service.py`（`do_POST` L608、`/v1/frames/<id>` L36、`process_jpeg` L729、`process_result` L569） | PC 端 HTTP 收帧/推理/结果；响应 `personDetected` 等 | **复用协议语义**，但改为板端实现 |
| `fall_detector.py`、`vision_guardian.py`、`frame_orientation.py` | PC 端时序跌倒/监护/方向处理 | 本任务不迁移（范围外） |
| `README.md` | 明确写有：PC YOLO Pose 未部署到 RK3568 NPU，RKNN 未测试 | 作为“不能假设 NPU 可用”的既有依据 |
| HTTP 9200 服务 | 帧从 DAYU APP POST 到 PC（HDC rport） | 本任务改为**设备本机** 9200 接收，PC 不参与推理 |

## 2. DAYU 正式 APP 相机链路（`competition/northbound/`，未修改）

| 文件/函数 | 内容 | P1-A 决策 |
|---|---|---|
| `entry/src/main/ets/model/VisionFrameStreamer.ets` | `DEFAULT_VISION_ENDPOINT=http://127.0.0.1:9200/v1/frames/dayu200-living`；250 ms 间隔；2500 ms 超时；POST JPEG；响应字段 `ok/personDetected/fall/source/...` | **复用为相机帧来源**；不改 APP |
| `entry/src/main/ets/model/CameraModel.ets`（`startPreview` L90、`release` L104-165） | Camera Kit：createCameraInput / PreviewOutput / PhotoOutput / session | 不直接调用（避免改 APP） |
| `entry/src/main/ets/pages/Index.ets`（L230、L379-386、L1296） | 相机页前台即启动自动监护；`visionStreamer.start(surfaceId)`；Surface XComponent | 用户打开 APP 即触发 |
| 正式 DAYU APP | 包名 `com.dsh.eldercare`；测试前未运行；测试中由用户打开，测试后 `aa force-stop` 恢复未运行 | 未改包/未改数据 |

## 3. P0 冻结基线（只读）

| 文件 | 作用 |
|---|---|
| `competition/docs/evidence/2026-10-24-p0-final-freeze.md` | P0-A/P0-B REAL PASS、当前版本/哈希、边界 |
| `competition/docs/evidence/2026-10-24-p0a-supervisor-real-acceptance.md` | supervisor 真实验收 |
| `competition/evidence/2026-10-24-p0-final-demo-backup/MANIFEST.md` | P0-C 双 ZIP/哈希/恢复资料 |
| 当前运行现场 | supervisor 11872/worker 50580 HEALTHY；homemon 2449；fport 9001→9000；手机 APP 26710 |

P1-A 未覆盖/未修改：Broker 1883、Bridge 9101、public-sync、homemon、手机 APP、backend、P0 ZIP/冻结产物。

## 4. 已有但不足以直接复用的内容

| 对象 | 缺什么 | 结论 |
|---|---|---|
| RKNN/NPU 方案文档（108 处命中） | 板端无 `/dev/rknpu`、无 `librknnrt`；无转换产物 | 只能作为背景，不能当验收 |
| MindSpore Lite（SDK NDK 库） | 设备无运行时；SDK 无 `converter_lite`；无 `.ms` 模型 | 本轮不采用 |
| 板端 Python/OpenCV | 设备无 Python/OpenCV | 不可用 |
| 直接 V4L2 取相机 | `/dev/video0/1` owner `camera_host`，camera_service 占用；rkisp pipeline 复杂 | 不抢占；走 APP loopback 帧 |
| PC 端 ncnn | 只有 Python wheel（Windows），无 arm 运行库 | 需自行交叉编译（已完成） |

## 5. 本任务新增（未覆盖原文件）

- `competition/vision/dayu-local/src/dayu_local_yolo.cpp`（板端程序，26,867 B）
- `competition/vision/dayu-local/CMakeLists.txt`
- `competition/vision/dayu-local/model/`（ncnn param/bin/metadata）
- `competition/vision/dayu-local/third_party/ncnn`（gitee commit `cb65ca26…`，仅构建用）
- `competition/vision/dayu-local/build-arm-neon2/`、`build-app-neon4/`（交叉编译产物）
- `competition/evidence/2026-10-25-p1a-dayu-local-yolo/`（本证据目录）
- DAYU 候选目录 `/data/local/tmp/p1a-yolo-2026-10-25/`（程序/模型/测试图/证据）

未修改：P0 任何脚本/ZIP/冻结物、正式 APP 源码/安装包、后端、homemon、Broker/Bridge/public-sync。
