# 00 · 项目总览：这是什么、用了什么、怎么跑

> 面向：第一次接触本项目的开发者/评委/答辩准备。
> 目标是在 10 分钟内建立"全景地图"，细节看后续各层文档。
>
> 作品名（建议）：**域护家徽：OpenHarmony 驱动的独居老人居家安全监测与多端告警闭环系统**
> 赛题：赛题四 · 独居老人居家安全监测与应急辅助系统

---

## 1. 一句话定位

**面向独居老人的"端—边—云—应用"居家安全监测与应急辅助系统**：
用 ESP32-S3 传感器节点 + DAYU200（OpenHarmony）家庭边缘主控 + PC 桥接/云后端 + 手机 APP，
完成「跌倒/燃气/烟雾/门磁/随身求助」的**本地声光语音报警 → 上云 → 多终端告警 → 处置确认（ACK）闭环**，
并提供视频探望、活动统计、健康建议等辅助能力。

赛题落点（对应 `competition/README.md`）：**基于物联网云平台进行设备管理，以开源鸿蒙 APP 为控制端**；
创新项：预警多终端同步、可扩展多节点、本地优先的应急闭环。

---

## 2. 系统由哪些"真实在跑"的部件组成

| # | 部件 | 跑在哪 | 语言/技术 | 进程/端口（实测） |
|---|---|---|---|---|
| 1 | 房间传感节点 ×2 | ESP32-S3（厨房/卫生间） | C / ESP-IDF 5.1.6 + FreeRTOS | 连 PC `:9101` |
| 2 | 家庭边缘主控 | DAYU200（OpenHarmony 7.0/API26，32 位用户态） | C（homemon）+ ArkTS（板端 APP） | homemon `:9000`（经 hdc fport→PC `:9001`）、推理 `:9200`、视频 `:9301` |
| 3 | PC 桥接 | 演示 PC | Node.js | 监听 `:9101`（无线节点）、MQTT 客户端连 `:1883` |
| 4 | 自包含 MQTT Broker | 演示 PC | Node.js | `:1883` |
| 5 | 云端同步 | 演示 PC（worker）+ 监督器 | Node.js | 出站 `HTTPS 443` → ECS |
| 6 | 可信云后端 | 阿里云 ECS `47.76.70.118`（Caddy+容器） | Node.js | `https://api.luxunacc.xyz` |
| 7 | 手机 APP | DevEco 模拟器（也可真机） | ArkTS / ArkUI | `127.0.0.1:5555` |
| 8 | 视觉（跌倒检测） | DAYU200 板 + PC 基线 | Python + YOLO11n-pose + NCNN/RKNN | 板端 `:9200`，事件写 `demo-events.jsonl` |
| 9 | 视频中继 | 演示 PC（local 模式）/ ECS（agent 模式） | Node.js + WebSocket | `:9443` → 手机 APP |
| 10 | 随身求助节点 | 4G 可穿戴（ESP32-S3） | C / ESP-IDF | 4G → ECS MQTT → 镜像进板端 |

> 实时数据链路有 5 条独立通道：①ESP32→bridge→MQTT；②板端 homemon→bridge→MQTT；
> ③bridge→public-sync→ECS；④vision→fall 命令；⑤视频 relay→APP。它们共享 broker 但故障域不同。

---

## 3. 技术栈总表

| 层 | 技术/框架 | 项目里用来做什么 |
|---|---|---|
| 设备固件 | **C / ESP-IDF 5.1.6**、FreeRTOS、NVS、ADC oneshot、I2C、GPIO、I2S+ES8388、IMA-ADPCM | 采样、判定、语音/灯/蜂鸣、TCP 上报 |
| 边缘守护 | **C（Linux/POSIX）**：select、非阻塞 socket、sysfs GPIO、`/dev/saradc`、fork/exec | homemon：板端状态机、多客户端 TCP、路由/中继、语音 Ability 拉起 |
| 板端 APP | **ArkTS / ArkUI（OpenHarmony API 26）** | 本机看板、4 房间在线、告警处置、与 homemon TCP |
| PC 桥接 | **Node.js（零依赖）**：net、EventEmitter、自实现 MQTT 3.1.1 | 行协议↔MQTT、无线节点接入、relay 注入、自动重连 |
| 云端同步 | **Node.js**：MQTT over TLS（自实现）、OneJSON 物模型、Token | 聚合/限频/去重、上云、下行白名单 |
| 云后端 | **Node.js（HTTP）**：REST、持久化存储、通知投递、健康建议（LLM） | 账号/设备/告警/证据/统计 API |
| 手机 APP | **ArkTS / ArkUI**：声明式 UI、状态管理、HTTP、WebSocket | 首页/监测/设备/告警/统计/健康/我的 |
| 视觉 | **Python + Ultralytics YOLO11n-pose、NCNN、RKNN（规划）** | 关键点推理 → 时序跌倒判定 → 受限 fall 事件 |
| 视频 | **Node.js + WebSocket + JPEG 帧** | 板端相机 9301 → relay 9443 → APP |
| 部署 | **Docker Compose、Caddy（自动 TLS）** | ECS 上 backend/relay/穿戴 MQTT |
| 工程化 | PowerShell 启动器/预检/守护、Node `node:test`、主机侧 C 单测、证据目录 | 一键起停、健康判定、回归测试、可复查证据 |

---

## 4. 代码规模与目录

| 层 | 路径 | 规模（业务代码） |
|---|---|---|
| ESP32 节点固件 | `firmware/common/components/elder_node/` | ~3.5k 行 C（+3 套 `kitchen|bathroom|living` 配置） |
| ESP32 穿戴固件 | `esp32-node-wearable/main/` | ~3.0k 行 C |
| 板端 homemon | `southbound/src/homemon.c` | ~1.5k 行 C |
| PC 桥接/Broker | `bridge/` | ~1.8k 行 JS |
| 云端同步 | `cloud/onenet/` | ~5.4k 行 JS |
| 云后端 | `cloud/backend/src/` | ~8.7k 行 JS |
| 穿戴镜像 | `cloud/wearable-mirror/` `cloud/wearable-mqtt/` | ~2.1k 行 JS |
| 视频中继 | `video/relay/src/` | ~2.1k 行 JS |
| 视觉 | `vision/*.py` | ~2.5k 行 Python |
| 手机 APP | `APP/ElderlyCareGuardian/entry/src/main/ets/` | **~23.4k 行 ArkTS / 74 文件** |
| 板端 APP | `northbound/entry/src/main/ets/` | ~5.1k 行 ArkTS |
| 合计 | — | **约 5.4 万行业务代码** ¹ |

¹ 已剔除 `node_modules`、构建产物、vendored 依赖（如 `video/relay/vendor/ws`）、`.venv`、测试夹具。

---

## 5. 能力清单：哪些是真的、哪些还没

| 能力 | 状态 | 说明 |
|---|---|---|
| ESP32 ↔ bridge TCP 上报（5s 节拍） | ✅ 已实测 | 厨房/卫生间两块实体板在跑 |
| 板端 homemon ↔ bridge（状态/命令/relay） | ✅ 已实测 | 经 hdc fport `9001→9000` |
| MQTT 上下行 + 多订阅端 | ✅ 已实测 | 自包含 broker，QoS 0 |
| 云端同步（worker→ECS 202） | ✅ 已实测 | 失败率约 0.4%，秒级自愈 |
| 手机 APP 真实数据（4 房间/告警/ACK） | ✅ 已实测 | 走 ECS API |
| 本地告警闭环（声/光/语音 + ACK） | ✅ 已实测 | 板端 `ack` 严格匹配 alarmId |
| 门磁 v7（事件 seq + 幂等补传） | ✅ 已实测 | 后端按 `(deviceId,seq)` 去重 |
| 燃气/烟雾阈值告警（900/700） | ✅ 已启用 | **未标定、未用真实气体触发验证** |
| 跌倒检测（YOLO Pose + 规则） | 🟡 部分 | 板端实时事件在跑；真人跌倒未正式验收 |
| 视频探望（JPEG over WS） | 🟡 部分 | local 模式可用，首帧 0.4–0.6s |
| 随身求助（4G→云→镜像→板端） | 🟡 部分 | 依赖公网 API，本地 MQTT 上不可见 |
| 微信小程序 | 🟡 骨架 | 未配 AppID/域名，非当前演示主路径 |
| 多终端推送（短信/APNs/微信） | 🟡 后端有实现 | 未端到端验收 |
| 本地链路身份鉴别/TLS/签名 | ❌ 未实现 | 明确仅限受控开发环境 |
| 三块 ESP32 同时在线 | ❌ 未部署 | 客厅板为候选（COM8），未接线验收 |

---

## 6. 怎么跑起来（30 秒版）

```powershell
# 0) 网络：AP ElderCareLab、PC WLAN 必须是 10.127.130.179、两块 ESP32 上电、DAYU USB
# 1) 只读预检
powershell -NoProfile -ExecutionPolicy Bypass -File ...\materials\start-demo-supervisor.ps1 -Preflight
# 2) 起 P0（会要求输入一次隐藏 INGEST_KEY；窗口不要关）
...\materials\start-demo-supervisor.cmd
# 3) 起守护（窗口不要关）
...\materials\start-demo-all.cmd
# 4) 随身求助镜像
...\materials\start-mirror-dayu.ps1 -Apply
# 5) 手机 APP：启动模拟器 → aa start -a EntryAbility -b com.example.program_04 → 登录
```

完整开机流程、失败处置、检查清单见 `materials/BOOT-RUNBOOK.md`；健康基线见
`evidence/2026-10-28-fullchain-health/REPORT.md`。

---

## 7. 明确不是目标 / 安全边界

- 局域网 TCP/MQTT **没有 TLS、没有设备身份鉴别、QoS 0**，只适用于受控开发环境；
- 不宣称 AI 跌倒识别已验收、不宣称燃气 ppm/浓度、不宣称"燃气安全"；
- 不实现后台静默摄像，抓拍需用户授权且默认关闭；
- 私有 4G 模块（YED-M100）未打通安全 MQTT，不能降级明文；
- 微信小程序未配置正式身份，不作为当前演示入口。

---

## 8. 文档地图

| 文档 | 内容 |
|---|---|
| `00-OVERVIEW.md`（本文） | 全景、技术栈、能力清单、运行方式 |
| `01-ARCHITECTURE.md` | 分层架构、6 条数据流、协议、部署拓扑、关键决策 |
| `02-DEVICE.md` | ESP32 节点/穿戴固件、homemon（C）逐层解析 |
| `04-TRANSPORT-CLOUD.md` | bridge/broker、OneNET 同步、backend、穿戴镜像、部署 |
| `03-APP.md` | 手机 APP、板端 APP（ArkTS/ArkUI、DTO→ViewModel、ACK 闭环） |
| `05-VISION-VIDEO.md` | YOLO Pose 跌倒判定、视频中继（JPEG over WS） |
| `06-KNOWLEDGE-MAP.md` | 知识点地图（按技术域 → 项目内实例 → 学习顺序） |
| `07-IMPROVEMENTS.md` | 完善路线（可靠性/安全/性能/工程化，按 ROI） |
| `08-LEARNING-PATH.md` | 分角色学习路径与练习 |
| 已有深度文档 | `docs/ARCHITECTURE.md`、`firmware/docs/CODE-WALKTHROUGH.md`、`firmware/docs/NODES.md`、`docs/APP-API-v1.md`、`docs/VALIDATION-MATRIX.md` |
