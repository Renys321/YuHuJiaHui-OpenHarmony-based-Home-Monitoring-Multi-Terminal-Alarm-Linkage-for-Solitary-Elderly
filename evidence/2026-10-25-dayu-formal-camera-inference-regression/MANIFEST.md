# MANIFEST

任务：DAYU 正式 1.0.2 相机帧与本机人物检测回归
状态：`DAYU_FORMAL_CAMERA_PERSON_REGRESSION_PASS_WITH_CAVEATS`

## 正式应用（未重装）

- 包名：`com.dsh.eldercare`
- 版本：`1.0.2/1000002`
- HAP 路径：`/data/app/el1/bundle/public/com.dsh.eldercare/entry.hap`
- 大小：1,883,399 B
- SHA-256：`A696698A627CFEEE1EE90D4F94A3FAF49B4A2F1BB8A2D813CA3AD245324DAFFE`

## 正式 Surface JPEG（直接来自正式应用）

目录：`formal-surface-frames/`

- `frame_000001.jpg` — 640×480，34,664 B，`2A1CD2B6867C09505BA08A56026EE8517519EF543FA1B9540BA6B988F30DBEA1`
- `frame_000002.jpg` — 640×480，49,208 B，`BD12A563E8E8F11DA64A4997519B9120AFF9BAA8CE8DFC36C1D7D11960305943`
- `frame_000003.jpg` — 640×480，45,435 B，`BAA1695017ED2A2D597BC59AA5FF8EAB993FBA16797F1B4F02CA57D4D546FAC2`

EXIF orientation：三帧均无；实际像素方向正向。

## 推理事件/统计

- 短时取证：`formal-capture-events.jsonl`、`formal-capture-stats.jsonl`、`formal-capture-server.log`
- 10+ 分钟并行：`formal-live-events.jsonl`、`formal-live-stats.jsonl`、`formal-live-server.log`
- 保存帧：`live-frame_000001.jpg` … `live-frame_000004.jpg`
- 服务：DAYU `/data/local/tmp/p1b-fall-2026-10-25/dayu_local_fall`
- 参数：320 / `--rotate 0` / loopback 9200 / PC 不参与最终推理

## 前次清场重做（历史，未通过）

- `formal-redo-events.jsonl`、`formal-redo-stats.jsonl`、`formal-redo-server.log`
- `redo-frame_000001.jpg` … `redo-frame_000004.jpg`
- 309.0s / 686 received / 495 inferred / errors 0；NO_PERSON=102；
- 仅 23:26:17–23:26:33 约 16s 无人；保存帧仍有 2–3 人，四段仍阻塞。

## 最终清场四段（conf 0.7，PASS）

- `formal-redo3-events.jsonl`（646 条可解析事件）
- `formal-redo3-server.log`
- `redo3-frame_000001.jpg` … `redo3-frame_000004.jpg`
- `LIVE-PERSON-REDO3.md`
- 23:48:09–23:49:27 无人 78s；23:49:27–23:49:50 有人 23s；
  23:49:50–23:50:15 无人 25s；23:50:15–23:50:39 有人 24s。
- 默认/0.5 空场误检已在精度测试中记录；0.7 空场 142/142 NO_PERSON。

## 全身姿态/跌倒安全动作

- `formal-pose-events.jsonl`、`formal-pose-stats.jsonl`、`formal-pose-server.log`
- `pose-frame_000001.jpg` … `pose-frame_000004.jpg`
- `POSE-AND-FALL-RESULTS.md`
- 272.7s / 606 received / 436 inferred / errors 0；后段 17/17 关键点有效；
  posture UPRIGHT/SITTING_OR_CROUCHING/UNKNOWN；fallConfirmedEvents=0。
- 未做真实危险跌倒，真实 FALL 正例未验证；fixture 13/13 为历史结果。

## P0 与现场状态

- `p0-supervisor-state.json`：supervisor 11632，worker 9908，HEALTHY，restartCount 0
- `p0-bridge.log`
- `preflight-nodes*.json`、`final-reg-state.json`
- 三节点本轮 1/1（仅客厅）；厨房/卫生间在 DAYU 重启后未重连

## 报告

- `REPORT.md`
- `FORMAL-FRAME-RESULTS.md`
- `LIVE-PERSON-REGRESSION.md`
- `LIVE-PERSON-REDO3.md`
- `POSE-AND-FALL-RESULTS.md`
- `STABILITY-AND-P0-IMPACT.md`
- `final-state.txt`

## 结束清理

- P1-B 候选已 STOPPED；9200 无 LISTEN（仅 TIME_WAIT）
- previewtest 已 STOPPED
- 正式预览参数恢复 `60%/130%`
- 正式 HAP/版本未变；homemon、Broker、Bridge、supervisor、worker 保留运行
- 无生产告警/ACK/SOS/FALL、无 MQTT/HTTP ingest 生产写入

## 未完成/阻塞

- 四段真人序列：现场无法清空画面，BLOCKED。
- 高度调节/调节后 JPEG：控件在当前布局不可见，未完成。
- 三节点：1/1，厨房/卫生间未重连，需现场无线设备重连。
