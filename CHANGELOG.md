# 迭代记录（CHANGELOG）

## 2026-11-02

### 固件冻结与刷写
- 四份 `node_main.c`（common/kitchen/bathroom/living）统一到同一哈希，`app_main` 拆分为 4 个静态函数；
- 修复 living（语音关闭配置）编译失败：`micupload` 分支加 `CONFIG_NODE_VOICE_ENABLED` 保护；
- 三工程均可构建（kitchen `a3ad5db9…`、bathroom `7035e25f…`、living `1923fc6d…`）；
- 两板刷写冻结版并回读校验；旧固件完整备份在 `evidence/2026-11-02-firmware-refactor/ab/`；
- 证据：`evidence/2026-11-02-firmware-refactor/`。

### 跌倒检测方向鲁棒性
- 原判据要求身体在图像平面内旋转到水平（torso≥45° 或 bbox 宽高比≥0.95），竖向/朝镜头跌倒漏检；
- 新增方向不敏感“快速塌落”路径（下沉/峰值/末端证据/进入帧触底瞬时速度），180° 判据不变；
- 离线：3 套机位矩阵 7/7；真实安全动作回放 0 事件；
- 证据：`evidence/2026-11-02-fall-orientation/`；补丁：`patches/2026-11-02-fall-direction.diff`。

### 实机验证与告警链路
- 受控跌倒 4/4 检出；交替测试“跌倒→快速深蹲”3 轮 = 跌倒 3/3、深蹲 0/3；
- 发现视觉服务从未发送活动心跳，导致设备侧反复误判“长时间无活动”并覆盖 FALL；
- 视觉服务新增 `--motion-heartbeat-sec`（默认 45 s），验证后 `lastActiveTs` 持续更新、NO_MOTION 停止新增；
- 板载 APP 告警页自动跳转修复：仅 FALL/MANUAL_SOS、且不在预警页时跳转，30 s 节流；重签安装到 DAYU200；
- 证据：`evidence/2026-11-02-fall-live-verification/`。

### 提交材料
- 设计方案 DOCX / 答辩 PPT 更新：补入竖向跌倒修复、motion 心跳、APP 跳转修复、双 APP 定位区分；
- 证据：`competition/docs/submission/`。

## 2026-11-01

- 修复 `speaker_link.c` 本地 clip 解析：`parse_int_field` 先命中 `"type":"clip"` 导致返回 0，改为按 `"clip":` 键取值；
- 两板串口验证 `RX local clip=9 (key-parse)` → `PLAY clip=9 bytes=93488` → 11.75 s → `STOP OK`；
- 稳定性 30 轮 210 项全过，问答时延 663–1321 ms；
- 证据：`evidence/2026-11-01-clip-fix-and-soak/`；补丁：`patches/2026-11-01-speaker-clip-parse.diff`。

## 2026-10-28

- 现场联调与演示：跌倒告警闭环、语音问答、摄像头证据链；
- 证据：`evidence/2026-10-28-*`。

## 2026-10-26 / 10-27

- 云端生产发布、门磁 v7 端到端、语音灯效恢复、AI 健康评估、随身 SOS 与重连；
- 证据：`evidence/2026-10-26-*`、`evidence/2026-10-27-*`。

## 2026-10-24 / 10-25

- P0 演示基线、板载 APP、DAYU 本地 YOLO 与视觉链路；
- 证据：`evidence/2026-10-24-*`、`evidence/2026-10-25-*`。
