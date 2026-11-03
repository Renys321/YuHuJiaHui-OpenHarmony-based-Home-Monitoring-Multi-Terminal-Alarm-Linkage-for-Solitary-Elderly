# PROJECT-GUIDE 共享上下文（给撰写者）

> 目标：把 `<WORKSPACE>\competition` 这个"独居老人居家安全监测与应急辅助系统"从**代码层面**讲透：
> 每层有什么、怎么实现、用了哪些技术、知识点在哪、坑在哪、怎么完善、怎么学。
> 只读代码与文档；**不要修改任何业务代码/配置**；只写自己名下的 md 文件。

## 1. 项目一句话

用 OpenHarmony（DAYU200 板 + 手机/模拟器 APP）+ ESP32-S3 传感器节点 + PC 桥接/云端，
做"跌倒检测、燃气/烟雾、门磁、随身求助 → 本地声光/语音 → 上云 → 多终端告警 + ACK 闭环"。

## 2. 真实运行拓扑（2026-10-28 实测在跑）

```
[ESP32 厨房 10.127.130.168] ─Wi-Fi/TCP 行协议(JSON+\n)─┐
[ESP32 卫生间 10.127.130.71] ──────────────┘           ├→ PC bridge:9101
[DAYU200 板] homemon:9000 ──USB hdc fport 9001─────────┤   （--status-tcp / --relay-to）
             板载 APP(com.dsh.eldercare)                │
             YOLO 推理 dayu_local_fall:9200 → events.jsonl
             视频流 9301                               │
[随身求助 4G] → ECS api.luxunacc.xyz → wearable-mirror ─┘（relay 注入 homemon 9001）
                                                        │
PC bridge ─MQTT→ broker:1883 ─→ public-sync worker ─HTTPS 443→ ECS backend
                                                        └→ 板载 APP / 手机 APP（经云 API）
PC video relay:9443 ─WS→ 手机 APP（视频探望，local 模式直连板端 9301）
```

- PC IP 被 ESP32 固件写死为 `10.127.130.179`（网关），AP = `ElderCareLab`。
- 云端 ECS `47.76.70.118`：Caddy+backend(443)、wearable-mqtt(1883)、ECS video relay（未启用）。
- 手机 APP 跑在 DevEco 模拟器（`127.0.0.1:5555`，bundle `com.example.program_04`）；
  板端 APP 是 `com.dsh.eldercare`（DAYU200）。

## 3. 代码分布与规模（真实业务代码，已剔除依赖/构建/测试）

| 层 | 路径 | 规模 |
|---|---|---|
| ESP32 节点固件（C/ESP-IDF） | `firmware/common/components/elder_node/` | ~3.5k 行（+ `firmware/*` 配置） |
| ESP32 穿戴固件（C/ESP-IDF） | `esp32-node-wearable/main/` | ~3.0k 行 |
| 板端守护进程 homemon（C） | `southbound/src/homemon.c` + `say.sh` 等 | ~1.5k 行 |
| PC 桥接/自包含 Broker（Node.js） | `bridge/mqtt_bridge.js` `mqtt_broker.js` | ~1.8k 行（含模拟节点/工具） |
| 云端同步（Node.js） | `cloud/onenet/*.js`（gateway/cloud-sync/command-sync/public-sync/token/transport/adapter） | ~5.4k 行 |
| 云端后端（Node.js） | `cloud/backend/src/*.js`（server/store/persistent-store/auth/activity/health*/notify*/evidence/safety-log） | ~8.7k 行 |
| 穿戴镜像/MQTT（Node.js） | `cloud/wearable-mirror/src/` `cloud/wearable-mqtt/` | ~2.1k 行 |
| 视频中继（Node.js） | `video/relay/src/` + `server.js` `agent.js`（vendor/ws 是原样 vendored，不算业务代码） | ~2.1k 行 |
| 视觉（Python + NCNN） | `vision/*.py`（yolo_pose_service/fall_detector/vision_guardian/evidence_uploader/frame_orientation）+ `vision/dayu-local/` | ~2.5k 行 |
| 手机 APP（ArkTS/ArkUI） | `<WORKSPACE>\APP\ElderlyCareGuardian\entry\src\main\ets\` | ~23.4k 行 / 74 文件 |
| 板端 APP（ArkTS） | `northbound/entry/src/main/ets/` | ~5.1k 行 / 16 文件 |
| 部署/编排 | `deploy/`（compose、Caddyfile、安装脚本）、`materials/`（启动器、预检、runbook） | — |

## 4. 已有文档（先读，避免重复造轮子）

- `competition/docs/ARCHITECTURE.md`：组件关系、端口、状态机、命令路由、ACK、在线判定（权威）
- `competition/docs/VALIDATION-MATRIX.md`：哪些已验收/未验收（40KB，引用时注意日期）
- `competition/docs/HARDWARE-MAP.md`：硬件与接线
- `competition/docs/RUNBOOK.md`、`materials/BOOT-RUNBOOK.md`（开机流程）
- `competition/docs/KNOWN-RISKS.md`：已知风险
- `firmware/docs/CODE-WALKTHROUGH.md`：ESP32 固件逐模块详解（已有，勿重复写，可引用）
- `firmware/docs/NODES.md`、`firmware/docs/BUILD-VERIFY.md`
- `evidence/2026-10-28-fullchain-health/`：全链路体检、三单点、风险深挖
- `docs/APP-API-v1.md`（手机 APP 与后端 API 合同）、`docs/AI-HEALTH-ASSESSMENT-SPEC.md`

## 5. 写作约定（所有 guide 文档统一）

- 中文；**每个结论尽量带 `路径:行号`**（如 `bridge/mqtt_bridge.js:731`），便于读者跳转核对。
- 不要贴大段代码；关键片段 ≤8 行，其余用"函数名 + 行号 + 一句话说明"。
- 明确区分：**已实现且实测** / **已实现未实测** / **未实现（占位/未开放）** / **属其他层**。
- 不写任何密钥、口令、内网凭据；SSID/IP 可以写。
- 每份文档末尾给"阅读顺序建议"和"本层最容易被误解的 3 个点"。
- 不修改别人的文件；只写分配给自己的路径。

## 6. 分工

| 成员 | 只写这个文件 | 覆盖层 |
|---|---|---|
| `device-deepdive` | `docs/PROJECT-GUIDE/02-DEVICE.md` | ESP32 节点固件 + 穿戴固件 + 板端 homemon（C） |
| `cloud-deepdive` | `docs/PROJECT-GUIDE/04-TRANSPORT-CLOUD.md` | bridge/broker + cloud/onenet + cloud/backend + wearable-mirror/mqtt + deploy |
| `app-guide` | `docs/PROJECT-GUIDE/03-APP.md` | 手机 APP + 板端 APP（ArkTS） |
| `vision-guide` | `docs/PROJECT-GUIDE/05-VISION-VIDEO.md` | vision(Python/NCNN) + video relay |
| Lead | `00-OVERVIEW.md` `01-ARCHITECTURE.md` `06-KNOWLEDGE-MAP.md` `07-IMPROVEMENTS.md` `08-LEARNING-PATH.md` `README.md` | 总览/架构/知识点/完善/学习 |
