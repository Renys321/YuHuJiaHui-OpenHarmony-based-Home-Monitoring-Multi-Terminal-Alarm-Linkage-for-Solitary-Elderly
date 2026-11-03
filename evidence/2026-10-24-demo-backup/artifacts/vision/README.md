# YOLO Pose 跌倒检测

本目录提供 DAYU200D 摄像头跌倒检测的 PC 基线。YOLO Pose 负责提取人体关键点；
`fall_detector.py` 使用可解释的时序规则判定跌倒。模型推理和判定逻辑分离，后续可把
Ultralytics 适配器替换为 RK3568 RKNN 适配器，而不修改告警协议。

Ultralytics 的 letterbox 预处理会保持原图比例；推理入口再显式使用 `rect=True`，让流式单帧
推理只补齐到 stride 对齐的矩形，减少方形补边。该参数是补边效率选项，不是“防拉伸开关”。
检测框和关键点按 `result.orig_shape` 映射回原始画面。人体框宽高比和髋部位移必须基于原图
坐标计算，不能使用 APP 预览控件的屏幕显示尺寸。

## 判定边界

首版不是单帧分类。只有同时观察到以下过程才进入告警：

1. 最近 2.5 秒内出现过直立姿态。
2. 髋部发生快速向下移动。
3. 人体框或躯干转为接近水平。
4. 髋部和人体框处于画面较低位置。
5. 水平低位姿态持续至少 1.2 秒。

已经躺在床上的人、缓慢坐下、弯腰以及关键点丢失不会直接触发。可用 `--exclude-zone`
配置床/沙发区域，格式为归一化的 `x1,y1,x2,y2`。这些阈值是演示基线，必须使用实际摄像头
机位采集的数据校准，不能表述为医学诊断准确率。

## 安装

使用 Python 3.12 创建独立虚拟环境，不要污染 ESP-IDF 或 OpenHarmony 工具链：

```powershell
Set-Location <WORKSPACE>\competition
& '<USER_HOME>\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe' `
  -m venv .venv-vision
& .\.venv-vision\Scripts\python.exe -m pip install -r .\vision\requirements-pc.txt
```

第一次运行默认模型 `yolo11n-pose.pt` 时，Ultralytics 会下载模型权重。现场演示前应预先完成
下载并断网复跑，不能依赖临时网络。

当前本机基线已安装 Ultralytics 8.4.175、PyTorch 2.14.1 CPU、OpenCV 5.0.0 和
`lap` 0.5.13，模型权重已保存在本目录。不同时间重新安装可能得到更新版本，正式提交前应
冻结依赖并核对 Ultralytics 模型/代码许可与竞赛分发要求。

## 运行

### DAYU200 通过 USB 送帧到 PC

当前真机方案是 **USB 有界采样帧 + PC CPU YOLO Pose**，不依赖校园网、热点或路由器，
也不代表模型已经部署到 DAYU 的 RK3568 NPU。APP 在前台且 Camera Surface 可用、用户未显式
暂停时自动启动 Camera 并从现有 4:3 Surface 串行采样 JPEG；同一时间最多一个请求在途，视觉服务失败不会阻塞预览、监护、语音、
联网、告警或 ACK。

每次重新安装 HAP 后，按以下顺序启动；安装会清除已有的 HDC 反向映射：

1. 安装当前 signed HAP。
2. 运行 `vision\start_dayu_usb_guard.cmd`，它会校验
   `hdc rport tcp:9200 tcp:9200`、本地 Broker，并用 `--publish` 启动仅监听 PC 回环地址的服务。
3. 启动 DAYU APP；Surface 就绪后自动进入监护。预览区域只是查看窗口，暂停需明确点击“暂停监护”。

DAYU 上的 `http://127.0.0.1:9200` 通过 USB 映射到 PC 本机服务。可在 PC 上检查：

```powershell
Invoke-RestMethod http://127.0.0.1:9200/healthz
& '<WORKSPACE>\tools\hdc\hdc.exe' fport ls
```

APP 会显示“未检测到人体”“检测到人体”或“疑似跌倒”、累计成功帧数和端到端耗时。
进入后台或显式暂停会先停止送帧，再释放 Camera 资源；未被用户暂停时回前台自动恢复。当前真机观测约 2 FPS；持续性能、温升和真人
跌倒准确率仍需专项验收。HTTP 模式固定使用 ByteTrack 保持跨请求 ID；`FALLEN` 会持续返回，
直到检测器观察到恢复站立，APP 不再只闪一帧“疑似跌倒”。

### 监护失联 watchdog（HTTP 模式）

APP 只能在前台采样，息屏/进入后台会停帧。PC 侧因此承担失联检测，并把它变成可路由事件：

```text
无帧超时 -> MQTT home/<deviceId>/cmd {"cmd":"monitor","state":"offline","reason":"no_frame"}
        -> Bridge 白名单映射 monitor offline no_frame
        -> homemon 独立字段 monitorOnline(1/0/-1) -> 状态广播 -> APP 显示 PC 监护失联
```

- `--frame-timeout-ms`（默认 10000）：online 状态下超过该间隔无帧即报一次 offline。
- `--frame-startup-grace-ms`（默认 15000）：进程启动后一直没有首帧时，报一次
  `no_first_frame`，不会沉默。
- `--monitor-heartbeat-ms`（默认 60000，0=关闭）：按周期重发**当前状态**（不增加 episode），
  用于 homemon 重启后重新同步；同一次中断不会重复告警。
- 来帧即报一次 `online`；`--publish` 关闭时只写 stderr，不发 MQTT。
- 该 watchdog 只覆盖 HTTP 接帧模式；`--source` 文件/本机摄像头模式不启用。
- **当前验证层级**：视觉全量测试 46/46、Bridge 18/18、当前 HAP 构建/签名/验签/安装均通过；
  真实 DAYU 的失联/恢复和自动取证见 `docs/evidence/2026-10-14-fall-auto-evidence.md`。

### 跌倒事件本地证据

新的 FALL episode 会先保存真正触发判定的原始 JPEG，再返回同一 `evidenceId` 给 DAYU。默认
目录为 `vision/evidence`，`index.json` 记录事件时间、设备、证据分、track ID、大小和 SHA-256；
JPEG 与索引均采用同目录临时文件后原子替换，默认最多保留 200 个事件：

```powershell
& .\.venv-vision\Scripts\python.exe .\vision\yolo_pose_service.py `
  --listen-host 127.0.0.1 --listen-port 9200 `
  --evidence-dir .\vision\evidence --evidence-max-events 200
```

DAYU 对同一 `evidenceId` 只触发一次高分辨率 PhotoOutput；页面同时显示 DAYU 文件名和 PC
触发帧文件名。配置可信后端后，PC 会先把同一 JPEG 的待上传状态原子写入磁盘 outbox，再由
后台线程上传；断网和进程重启后会从 `index.json + upload-outbox.json + JPEG` 对账补传：

```powershell
$env:BACKEND_INGEST_KEY = '<仅在当前进程环境中注入>'
& .\.venv-vision\Scripts\python.exe .\vision\yolo_pose_service.py `
  --listen-host 127.0.0.1 --listen-port 9200 --publish `
  --evidence-upload-url https://example.invalid
```

远程地址强制 HTTPS；密钥只从 `--evidence-ingest-key-env` 指定的环境变量读取，不进入命令行、
URL、outbox 或日志。JPEG 缺失/SHA 不符不会上传；网络、429 和 5xx 保持 pending，非 429 的
4xx 标记为无效。后端不可达不会阻塞本地 FALL/MQTT。本功能已通过本地代码和真实 HTTP 自动测试，
但尚未部署公网，也未在微信手机真机预览。DAYU 私有目录只清理严格命名的应用照片并最多保留
100 张；由于板端时钟不可信，本地不按“30 天”删除，可信后端仍按接收时间执行 30 天策略。

### PC 摄像头或视频文件

仅检测并在终端输出事件，不触发真实告警：

```powershell
& .\.venv-vision\Scripts\python.exe .\vision\yolo_pose_service.py `
  --source 0 --exclude-zone 0.05,0.45,0.55,0.95
```

完成机位校准和误报测试后，显式增加 `--publish` 才会向
`home/dayu200-living/cmd` 发布 `{"cmd":"fall"}`：

```powershell
& .\.venv-vision\Scripts\python.exe .\vision\yolo_pose_service.py `
  --source 0 --publish --broker 127.0.0.1:1883 `
  --target-device dayu200-living
```

Bridge 将命令写给 DAYU 的 `homemon`。`homemon` 生成 `FALL` alarmId 并继续负责声光、语音、
状态上报和 APP ACK 闭环。发布失败会由 HTTP 服务循环定时重试，不依赖下一帧；30 秒仍无法
发布则丢弃陈旧事件，不会伪造成功状态。MQTT QoS 0 不是端到端 exactly-once，闭环以设备
回报 `ACKED` 为准。

## 测试

```powershell
& '<USER_HOME>\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe' `
  -m unittest discover -s .\vision -p 'test_*.py' -v
```

当前共 43 项测试，覆盖直立、合成跌倒序列、坐下、弯腰、初始躺卧、床区排除、关键点丢失、
恢复后再次跌倒、非方形原图坐标恢复、未确认 track ID、`rect=True` 推理参数契约，以及 HTTP
健康检查、有效 JPEG、错误类型、超限请求、解码失败、请求接收时间单调化、ByteTrack 参数契约
和 `FALLEN` 持续状态，以及 FALL episode 发布失败重试、不依赖新帧的定时重试、30 秒 TTL
与成功后协调器不再重复尝试；还覆盖触发帧原子保存/索引/有限保留、重复事件、非法路径、
evidenceId 重试一致性，以及客户端提前断开响应时的异常降级。合成规则测试不能替代真人场景准确率验证。

## 一周 MVP 验收

1. DAYU 摄像头能输出稳定画面，固定机位和床区。
2. PC CPU 上以 5 FPS 以上运行 `yolo11n-pose`，记录分辨率、延迟和 CPU 占用。当前 USB 真机
   路径约 2 FPS，**该验收项尚未达到**。
3. 每类至少录制 10 段：跌倒、坐下、弯腰、躺床、遮挡、无人。
4. 跌倒测试触发一次 `FALL`，同一事件不重复报警。
5. 坐下、弯腰、躺床和床区动作不报警。
6. APP 显示“疑似跌倒”，可按原有流程确认闭环。
7. 保存视频编号、判定 JSON、Bridge、homemon、APP Hilog 和 UI 证据，不保存无关人员画面。

RK3568 NPU 迁移必须等 RKNN Toolkit、模型转换、32 位 OpenHarmony runtime 和板端性能都被
实测确认后再开始。当前仓库没有这些产物，因此 NPU 状态仍是 `NOT TESTED`。

