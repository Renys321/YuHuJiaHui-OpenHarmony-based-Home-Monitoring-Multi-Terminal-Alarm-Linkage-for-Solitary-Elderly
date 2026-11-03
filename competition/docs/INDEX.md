# 文档地图（INDEX）

> 作品名（建议）：**域护家徽：OpenHarmony 驱动的独居老人居家安全监测与多端告警闭环系统**（赛题四）。
> 这个项目文档很多（架构、验证、证据、各层 README）。**先看这张表，再决定读哪份**。
> 最后更新：2026-10-29。

---

## 1. 想快速了解项目（推荐从这里开始）

| 文档 | 用途 | 适合 |
|---|---|---|
| [`PROJECT-HANDBOOK.md`](PROJECT-HANDBOOK.md) | **一页读懂全项目**：角色、架构、端口、数据流、启动、测试、短板 | 初学者/答辩人 |
| [`PROJECT-GUIDE/README.md`](PROJECT-GUIDE/README.md) | 全量解析总目录（三种读法、文档地图、关键事实速查） | 所有人 |
| [`PROJECT-GUIDE/00-OVERVIEW.md`](PROJECT-GUIDE/00-OVERVIEW.md) | 定位、10 个运行部件、技术栈、能力清单、30 秒启动 | 所有人 |
| [`PROJECT-GUIDE/01-ARCHITECTURE.md`](PROJECT-GUIDE/01-ARCHITECTURE.md) | 分层架构、6 条端到端数据流、协议、部署、设计决策、故障域 | 所有人 |

## 2. 深入某层代码

| 文档 | 内容 |
|---|---|
| [`PROJECT-GUIDE/02-DEVICE.md`](PROJECT-GUIDE/02-DEVICE.md) | ESP32-S3 节点固件 + 板端 homemon（C） |
| [`PROJECT-GUIDE/03-APP.md`](PROJECT-GUIDE/03-APP.md) | 手机 APP + 板端 APP（ArkTS/ArkUI） |
| [`PROJECT-GUIDE/04-TRANSPORT-CLOUD.md`](PROJECT-GUIDE/04-TRANSPORT-CLOUD.md) | bridge/broker、OneNET 同步、backend、部署 |
| [`PROJECT-GUIDE/05-VISION-VIDEO.md`](PROJECT-GUIDE/05-VISION-VIDEO.md) | YOLO Pose 跌倒判定、视频中继 |
| [`PROJECT-GUIDE/06-KNOWLEDGE-MAP.md`](PROJECT-GUIDE/06-KNOWLEDGE-MAP.md) | 知识点地图 + 8 题自测 |
| [`PROJECT-GUIDE/07-IMPROVEMENTS.md`](PROJECT-GUIDE/07-IMPROVEMENTS.md) | 完善路线（P0/P1/P2/P3 + 两周落地） |
| [`PROJECT-GUIDE/08-LEARNING-PATH.md`](PROJECT-GUIDE/08-LEARNING-PATH.md) | 学习路径与 10 个练习 |

## 3. 权威工程文档（状态/协议/风险）

| 文档 | 用途 | 注意 |
|---|---|---|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | 组件、端口、状态机、命令路由、ACK、在线判定、安全边界**权威摘要** | 稳定协议以此为准 |
| [`VALIDATION-MATRIX.md`](VALIDATION-MATRIX.md) | `PASS/PARTIAL/FAIL/NOT TESTED` 与证据映射 | **能力验收的唯一权威** |
| [`KNOWN-RISKS.md`](KNOWN-RISKS.md) | 已知风险、边界、处理顺序 | 汇报前必读 |
| [`ARTIFACTS.md`](ARTIFACTS.md) | 制品与源码指纹/哈希（历史冻结） | 重建后需重新计算 |
| [`HARDWARE-MAP.md`](HARDWARE-MAP.md) | 硬件资源、引脚冲突、扩展路线 | 接线前必读 |
| [`RUNBOOK.md`](RUNBOOK.md) | 构建/部署/启动/诊断命令 | 与 `materials/BOOT-RUNBOOK.md` 互补 |
| [`APP-API-v1.md`](APP-API-v1.md) | 手机 APP ↔ 后端 API 合同（v1.3.0） | 改接口先改它 |
| [`AI-HEALTH-ASSESSMENT-SPEC.md`](AI-HEALTH-ASSESSMENT-SPEC.md) | 健康资料/健康建议功能规格 | 健康模块边界 |

> 旧交接/协作/任务文档（`HANDOFF.md`、`AI-COLLAB.md`、`DEEPSEEK-NEXT-*`、`APP-TEAMMATE-HANDOFF-*`、`deepseek-command-sync-*`、`reviews/`、`agent-prompts/`、`_submission-requirements.txt`）已于 2026-10-30 归档到
> `<WORKSPACE>Backup\archive\docs-legacy-2026-10-30\`，仅用于追溯，不再作为当前状态来源。

## 4. 固件（ESP32-S3 三节点）

| 文档 | 内容 |
|---|---|
| [`../../firmware/README.md`](../firmware/README.md) | 三工程结构、VSCode 打开、构建/烧录、验证结果 |
| [`../../firmware/docs/CODE-WALKTHROUGH.md`](../firmware/docs/CODE-WALKTHROUGH.md) | 固件逐模块逐行讲解（498 行） |
| [`../../firmware/docs/NODES.md`](../firmware/docs/NODES.md) | 三节点接线、供电、烧录步骤、未实测清单 |
| [`../../firmware/docs/BUILD-VERIFY.md`](../firmware/docs/BUILD-VERIFY.md) | 三工程构建验证（产物/哈希/配置抽查） |

## 5. 运行与演示

| 文档 | 内容 |
|---|---|
| [`../../materials/BOOT-RUNBOOK.md`](../materials/BOOT-RUNBOOK.md) | **从开机到演示就绪的完整流程**（两窗口 + INGEST_KEY + 检查清单） |
| [`../../materials/README.md`](../materials/README.md) | 启动器/预检/健康检查脚本说明 |
| `../../materials/start-demo-supervisor.ps1` | 一键起 P0（broker/bridge/public-sync，隐藏输入 INGEST_KEY） |
| `../../materials/demo-autostart/demo-autostart.ps1` | 常驻守护（P0/APP/推理/fport 自愈，写 `watcher-state.json`） |

## 6. 各层 README（实现细节与参数）

| 层 | README |
|---|---|
| 桥接/Broker | [`../../bridge/README.md`](../bridge/README.md) |
| OneNET 同步 | [`../../cloud/onenet/README.md`](../cloud/onenet/README.md) |
| 云后端 | [`../../cloud/backend/README.md`](../cloud/backend/README.md) |
| 穿戴镜像 | [`../../cloud/wearable-mirror/README.md`](../cloud/wearable-mirror/README.md) |
| 穿戴 MQTT | [`../../cloud/wearable-mqtt/README.md`](../cloud/wearable-mqtt/README.md) |
| 视觉 | [`../../vision/README.md`](../vision/README.md) |
| 视频中继 | [`../../video/relay/README.md`](../video/relay/README.md) |
| 板端 homemon | [`../../southbound/README.md`](../southbound/README.md) |
| 板端 APP | [`../../northbound/README.md`](../northbound/README.md) |
| 旧节点工程（历史） | [`../../esp32-node/README.md`](../esp32-node/README.md) |
| 穿戴固件 | [`../../esp32-node-wearable/README.md`](../esp32-node-wearable/README.md) |

## 7. 证据包（可复查的原始证据）

| 证据包 | 内容 |
|---|---|
| [`../../evidence/2026-10-28-fullchain-health/README.md`](../evidence/2026-10-28-fullchain-health/README.md) | 全链路体检 + 三单点 + 坏帧 + 燃气修复 + 阈值启用（索引） |
| 同目录 `REPORT.md` | 全链路体检总报告（逐段判定/量化/故障时间线/演示清单） |
| 同目录 `RISK-DEEPDIVE.md` | 三个单点的机制、实证、止损、根治 |
| 同目录 `GAS-ALARM-ENABLE-20261028.md` | 阈值启用三层改动与回滚 |
| [`../../evidence/2026-10-28-three-legacy-closures/`](../evidence/2026-10-28-three-legacy-closures/) | 三遗留项收口（含 watcher/rollback 文档） |
| [`../../evidence/2026-10-27-wireless-without-usb/`](../evidence/2026-10-27-wireless-without-usb/) | 拔 USB 无线化验收与 3 小时时间线采集器 |

> 历史证据很多（`evidence/` 下按日期），以各目录内 `REPORT.md`/`README.md` 为准，不要用旧汇总替代原始日志。

---

## 8. 按场景选文档

| 你要做什么 | 读这些 |
|---|---|
| 第一次接触项目 | §1 → `PROJECT-GUIDE/06` 自测 |
| 现场开机/演示 | `materials/BOOT-RUNBOOK.md` → `evidence/.../fullchain-health/REPORT.md` §7–§8 |
| 排障（链路断/数据不动） | `fullchain-health/REPORT.md` §5–§6 → `RISK-DEEPDIVE.md` |
| 改固件/接线 | `firmware/README.md` → `firmware/docs/NODES.md` → `firmware/docs/CODE-WALKTHROUGH.md` |
| 改 APP/接口 | `docs/APP-API-v1.md` → `PROJECT-GUIDE/03-APP.md` |
| 答辩/汇报 | `PROJECT-GUIDE/01` 设计决策 → `07` 改进 → `VALIDATION-MATRIX` 边界 |
| 交接给新人 | `PROJECT-GUIDE/README.md` 的"2 小时读法" |
| 准备参赛源码包 | `docs/SOURCE-PACKAGE.md` → `tools/package-source.ps1` |
| 提交前材料自查 | `docs/SOURCE-PACKAGE.md` §5 清单 + `firmware/docs/BUILD-VERIFY.md` |
