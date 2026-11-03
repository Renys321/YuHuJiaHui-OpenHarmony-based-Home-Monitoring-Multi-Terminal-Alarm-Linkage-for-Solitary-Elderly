# FORMAL-FRAME-RESULTS

## 1. 正式应用身份

- 包名：`com.dsh.eldercare`
- 版本：`1.0.2 / 1000002`
- HAP：`/data/app/el1/bundle/public/com.dsh.eldercare/entry.hap`
- 大小：1,883,399 B
- SHA-256：`A696698A627CFEEE1EE90D4F94A3FAF49B4A2F1BB8A2D813CA3AD245324DAFFE`
- 本轮未重新安装、未替换 HAP。

## 2. 取帧路径

- 正式应用既有 `VisionFrameStreamer` 每约 250ms POST 到设备本机：
  `http://127.0.0.1:9200/v1/frames/dayu200-living`
- 接收端使用既有 P1-B 候选 `/data/local/tmp/p1b-fall-2026-10-25/dayu_local_fall`
  （ELF32 ARM，SHA-256 `EF58405E2C930C476B80E520FE2BC61E86929D301CC65879023A1FBA556BBF0A`）。
- 监听严格限定 `127.0.0.1:9200`；PC 不参与最终推理。
- 短时取证命令包含：
  `--serve 127.0.0.1:9200 --size 320 --rotate 0 --save-frames evidence/formal-frames-capture --save-limit 3 --save-every 20`
- 服务日志：`framesReceived=197, framesInferred=142, errors=0`；
  事件 `source=dayu-camera-http`，证明帧来自正式应用，不是测试包/历史图/截图。

## 3. 直接取得的 Surface JPEG

| 文件 | 尺寸 | 字节 | SHA-256 | EXIF orientation |
|---|---|---:|---|---|
| `formal-surface-frames/frame_000001.jpg` | 640×480 | 34,664 | `2A1CD2B6867C09505BA08A56026EE8517519EF543FA1B9540BA6B988F30DBEA1` | 无 |
| `formal-surface-frames/frame_000002.jpg` | 640×480 | 49,208 | `BD12A563E8E8F11DA64A4997519B9120AFF9BAA8CE8DFC36C1D7D11960305943` | 无 |
| `formal-surface-frames/frame_000003.jpg` | 640×480 | 45,435 | `BAA1695017ED2A2D597BC59AA5FF8EAB993FBA16797F1B4F02CA57D4D546FAC2` | 无 |

- 三帧均为 RGB，`PIL getexif()[274]` 为空（无 orientation 标签）。
- 实际像素方向：画面正向；床架/门框竖直，人物正向，不是仅凭宽高或 EXIF 推断。
- frame 2/3 可看到全身/大部分身体；frame 1 为较近景（头肩/躯干），没有用截图代替。
- 仅保留这 3 张验收帧，不上传公网、不写系统相册、不连续录制。

## 4. 取帧时推理

- 输入尺寸 320，`--rotate 0`，4 threads；模型：
  `models/320/model.ncnn.param` / `.bin`（P1-B 已验收哈希）。
- 90.3s 统计：
  - received 197，inferred 142，dropped 54，errors 0
  - infer p50 589 ms / p95 664 ms
  - capture 2.18 FPS，infer 1.57 FPS
  - RSS 63,100 KB，temp 47.8 ℃
  - posture counts：UPRIGHT 66、SITTING_OR_CROUCHING 24、UNKNOWN 52、NO_PERSON 0（此窗口画面里始终有人）
  - fallConfirmedEvents=0

## 5. 结论

正式 Surface JPEG 直接取得，尺寸/像素方向/EXIF 均已核对；`rotate=0` 的 320 本机推理真实消费了这些正式帧。该子项通过。
