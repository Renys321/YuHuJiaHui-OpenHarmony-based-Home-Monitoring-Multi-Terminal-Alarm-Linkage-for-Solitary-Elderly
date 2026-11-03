# 域护家徽：OpenHarmony 驱动的独居老人居家传感监测与多端告警联动系统

> 赛题四参赛作品。面向独居老人的居家安全监测：ESP32-S3 房间节点负责采集与本地声光，
> DAYU200 作为室内边缘主控，PC 本地网关负责桥接/视觉/语音，云端与应用端负责远程告警与闭环。
>
> 本仓库包含：可编译源码、测试代码、关键迭代补丁、测试结果证据与提交文档。

## 目录结构

```
app-v2/                监护 APP（手机端，远程查看/告警/ACK）
competition/           主工程
  firmware/            ESP32-S3 房间节点固件（kitchen/bathroom/living）
  vision/              YOLO pose 跌倒检测与视觉服务
  bridge/              TCP/MQTT 协议桥
  cloud/               云端后端与同步
  northbound/          板载 APP（DAYU200 室内端）
  voice-gateway/       语音识别/合成/问答网关
  esp32-node-wearable/ 随身求助设备
  docs/                设计、验证矩阵、风险清单等
  docs/submission/     设计方案.docx、答辩PPT.pptx
esp32-sos-build/       随身 SOS 固件工程
evidence/              测试结果与现场证据（见 evidence/INDEX.md）
patches/               关键修复的 before/after diff
```

### 两个应用端的定位

| 端 | 位置 | 用途 |
|---|---|---|
| 监护 APP（`app-v2/`） | 手机 | 远程查看状态、告警列表/详情、ACK 闭环、自述安全、摄像头与统计 |
| 板载 APP（`competition/northbound/`） | DAYU200 室内 | 本地实时状态、摄像头、预警处置、AI 问答，不依赖手机 |

两者共享同一套告警状态，但界面与权限不同，不能互相替代。

## 快速开始

### 1. 房间节点固件（ESP32-S3，ESP-IDF 5.1.6）

```powershell
cd competition\firmware
powershell -File tools\build-node.ps1 -Node kitchen   # 或 bathroom / living
powershell -File tools\build-node.ps1 -Node kitchen -Action flash -Com COMx
```

WiFi 与节点身份在 `sdkconfig` / `.local\wifi.<node>.defaults` 中配置；
烧录前确认端口与 MAC，避免刷错板。

### 2. 监护 APP（手机端）

```bash
cd app-v2
hvigorw assembleHap --no-daemon
```

### 3. 板载 APP（DAYU200）

```bash
cd competition/northbound
hvigorw assembleHap --no-daemon
# 安装：hdc install -r entry/build/default/outputs/default/entry-default-signed.hap
```

### 4. 本地网关 / 云后端

```bash
cd competition/cloud/backend && npm install && npm test && npm start
cd competition/voice-gateway && node server.js
cd competition/vision && python yolo_pose_service.py --model yolo11n-pose.pt --publish --target-device dayu200-living
```

演示入口：`competition/materials/start-demo-full.cmd`（按提示完成 INGEST_KEY、板子上电/联网等人工步骤）。

## 测试与结果

| 项 | 结果 | 证据 |
|---|---|---|
| 一键体检 core-start | OK=11 / WARN=0 / FAIL=0 | `evidence/2026-11-02-firmware-refactor/` |
| 30 轮稳定性浸泡 | 210/210 通过，问答 663–1321 ms | `evidence/2026-11-01-clip-fix-and-soak/` |
| 主板主机测试 | 告警 141/0、电池 35/0、notice 18/0、ADPCM 6 段 0 失配 | `evidence/2026-11-02-firmware-refactor/outputs/` |
| 跌倒方向鲁棒性（离线） | 3 套机位矩阵 7/7 | `evidence/2026-11-02-fall-orientation/` |
| 跌倒实机（受控动作） | 4/4 检出；交替测试跌倒 3/3、快速深蹲 0/3 | `evidence/2026-11-02-fall-live-verification/` |
| 双板固件一致性 | 冻结版刷写并回读校验（kitchen a3ad5db9… / bathroom 7035e25f…） | `competition/firmware/SHA256SUMS.txt` |

> 以上为受控动作/合成数据与真机受控测试，**不是真实跌倒准确率**；真实跌倒阈值尚未标定。

## 迭代与修复

见 `CHANGELOG.md` 与 `patches/`。近期关键修复：

- 2026-11-01：修复 `speaker_link.c` 中 `"clip"` 键解析错误，本地 clip 恢复播放；
- 2026-11-02：跌倒判据增加方向不敏感“快速塌落”路径，修复竖向/朝镜头跌倒漏检；
- 2026-11-02：视觉服务增加 45s `motion` 心跳，避免设备侧误判“长时间无活动”覆盖 FALL；
- 2026-11-02：板载 APP 告警页自动跳转收窄（仅 FALL/SOS、离开预警页时跳转、30s 节流）。

## 已知边界

- 家庭局域网链路当前无 TLS/身份鉴别，MQTT 为 QoS0，仅适用于受控演示网络；
- 跌倒检测为 PC CPU 基线（短时约 2 FPS），真实跌倒阈值未标定；近景/下肢截断构图不支持；
- 监护 APP 尚未正式签名与真机安装；板载 HAP 已用 OpenHarmony Release 证书签名安装；
- 门磁与卫生间部分传感器尚未接线，读数 `valid=false`；
- 演示视频未包含在本仓库（提交时单独提供）。

## 证据说明

`evidence/` 为精简后的测试证据（已剔除 `build/`、`_work/`、编译中间物与签名材料）。
完整证据目录与说明见 `evidence/INDEX.md`。

## 许可

仅用于竞赛评审与学习交流，未经作者许可不得商用。
