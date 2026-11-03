# PROJECT-GUIDE · 项目全量解析（代码 → 架构 → 知识点 → 改进 → 学习）

这是一套**面向"要读懂它/要讲它/要改它"的人**的项目解析文档。
覆盖约 **5.4 万行业务代码**（11 个模块），按"总览 → 架构 → 五层代码 → 知识点 → 改进 → 学习"组织。

> 生成时间：2026-10-28（Asia/Shanghai）。文中"已实测/未实测/未实现"以当日运行态与 `docs/VALIDATION-MATRIX.md` 为准。

---

## 三种读法（按你的时间选）

### A. 10 分钟 · 只想知道"这是个什么东西"
1. 本文 §"一张图看懂"
2. `00-OVERVIEW.md`（能力清单 + 技术栈表）
3. `01-ARCHITECTURE.md` 的 6 条数据流图

### B. 2 小时 · 新同学要接手
`00-OVERVIEW` → `01-ARCHITECTURE` → 按你负责的层读 `02/03/04/05` → `06-KNOWLEDGE-MAP`
→ 最后用 `06` 末尾的"一分钟自测"检查自己是否读懂主线。

### C. 答辩/改造 · 要讲清楚 + 要动刀
`01-ARCHITECTURE`（设计决策表）→ `07-IMPROVEMENTS`（P0/P1 与落地顺序）→ `08-LEARNING-PATH`
→ 配合 `docs/VALIDATION-MATRIX.md`（哪些已验收）、`docs/KNOWN-RISKS.md`（边界）、
`evidence/2026-10-28-fullchain-health/REPORT.md`（当前实测）。

---

## 一张图看懂

```
设备层           边缘层                  传输/云                  应用层
ESP32×2 ─WiFi/TCP行协议→ PC bridge:9101 ─MQTT→ broker:1883 ─→ public-sync ─HTTPS→ ECS backend ─→ 手机 APP
DAYU200 homemon:9000 ─hdc fport 9001─┘         │                                        └→ 板端 APP(直连 homemon)
  └ 视觉 YOLO(9200) → 受限 fall 事件 ──────────┘
  └ 视频 9301 → video relay:9443 ──WS──────────→ 手机 APP（视频探望）
4G 穿戴 → ECS 1883 → 云端 API → wearable-mirror 轮询 → relay 注入板端
```

**三条最硬的语义**（答辩必讲）：
1. 设备**不实现 MQTT**，只发 JSON 行；桥接负责转 MQTT（多节点扩展零改代码）。
2. 视觉**只提交受限事件**，alarmId/声光/语音/ACK 统一由板端 homemon 管理（误报不污染告警）。
3. **HTTP 成功 ≠ 闭环**，必须设备回报 `ACKED` 且 `alarmId` 精确匹配。

---

## 文档地图

| 文档 | 行数 | 覆盖 | 适合谁 |
|---|---:|---|---|
| `00-OVERVIEW.md` | 144 | 定位、10 个运行部件、技术栈总表、能力清单（真实/部分/未实现）、30 秒启动 | 所有人 |
| `01-ARCHITECTURE.md` | 240 | 分层图、运行时进程/端口、**6 条端到端数据流**、协议表、部署拓扑、10 条设计决策、故障域 | 所有人 |
| `02-DEVICE.md` | 480 | ESP32-S3 节点固件（3.5k 行 C）+ 板端 homemon（1.5k 行 C）：任务/队列、行协议、ADC/I2S/ADPCM、ACK/route/relay、坑与改进 | 嵌入式、系统 |
| `03-APP.md` | 471 | 手机 APP（2.3 万行 ArkTS）+ 板端 APP（5k 行）：分层（API→Mapper→Page）、能力模型、在线判定、ACK 闭环、4/4 口径 | 前端、鸿蒙 |
| `04-TRANSPORT-CLOUD.md` | 536 | bridge/broker（MQTT 3.1.1 自实现）、OneNET 同步、supervisor/worker、TLS+指纹、幂等/TOCTOU、backend、部署 | 后端、云 |
| `05-VISION-VIDEO.md` | 398 | YOLO11n-pose 关键点、5 条件时序跌倒状态机、NCNN/RKNN、JPEG over WS、票据/限流、双 watchdog | 算法、视频 |
| `06-KNOWLEDGE-MAP.md` | 126 | 7 大技术域 → 40+ 知识点 → 项目内实例 → 掌握等级；末尾 8 题自测 | 学习/面试 |
| `07-IMPROVEMENTS.md` | 120 | P0 可靠性 / P1 安全正确性 / P2 体验性能 / P3 工程化，每条含"现状→改法→风险→验证"；两周落地顺序 | 负责人 |
| `08-LEARNING-PATH.md` | 129 | 环境→跑通→按数据流读码→10 个练习→分角色路径→常见误区→资源清单 | 新人 |
| `_CONTEXT.md` | 78 | 撰写者用的共享上下文（拓扑/规模/约定），一般读者可跳过 | — |

---

## 关键事实速查

| 项 | 值 |
|---|---|
| PC WLAN IP（ESP32 固件写死网关） | `10.127.130.179` |
| AP | `ElderCareLab`（2.4G，Channel 1） |
| 端口 | bridge `9101` · broker `1883` · homemon `9000`（hdc fport→PC `9001`）· mirror `9002` · video relay `9443` · 推理 `9200` · 板端视频 `9301` |
| MQTT 主题 | 上行 `home/<deviceId>/status`，下行 `home/<deviceId>/cmd` |
| 幂等键 | 告警 `(deviceId, alarmId)`；门磁 `(deviceId, seq)`；状态按 deviceId 覆盖 |
| 在线判定 | 12s 无新状态 → offline（APP 每 3s 扫描） |
| 三个单点 | hdc fport（USB）· 两路 ESP32 共用 AP/供电 · public-sync 的 INGEST_KEY |
| 启动入口 | `materials/start-demo-supervisor.cmd` + `materials/start-demo-all.cmd`（开机流程见 `materials/BOOT-RUNBOOK.md`） |

---

## 与已有文档的关系（不重复造轮子）

| 已有文档 | 本文档怎么用它 |
|---|---|
| `competition/docs/ARCHITECTURE.md` | 协议/端口权威摘要；`01` 在其上补"运行时视角" |
| `firmware/docs/CODE-WALKTHROUGH.md` | ESP32 固件逐模块逐行讲解；`02` 侧重工程视角，引用不重复 |
| `firmware/docs/NODES.md` / `BUILD-VERIFY.md` | 硬件接线与三节点构建验证 |
| `competition/docs/APP-API-v1.md` | APP↔后端 API 合同；`03`/`04` 按它对照 |
| `competition/docs/VALIDATION-MATRIX.md` | 能力验收状态（唯一权威） |
| `competition/docs/KNOWN-RISKS.md` | 风险边界；`07` 在其上给改进方案 |
| `evidence/2026-10-28-fullchain-health/` | 当日全链路体检、三单点、坏帧/燃气问题的原始证据 |
| `evidence/2026-10-28-fullchain-health/README.md` | 该证据包的索引（报告/分层证据/产物怎么查） |
| `materials/BOOT-RUNBOOK.md` | 从开机到演示就绪的流程；配合 `01`/`07` 的可靠性章节 |

---

## 未深入覆盖的模块（诚实边界）

本套文档覆盖当前演示主路径的全部代码；下面这些"不在主路径/属历史"的模块只做提及，避免读者误以为漏读：

| 模块 | 规模 | 为什么没深挖 | 去哪看 |
|---|---|---|---|
| `mobile/wechat-miniprogram/` | 约 3.6k 行 / 43 文件 | 当前演示主路径是 ArkTS 手机 APP；小程序未配正式 AppID/合法域名 | 该目录 `README.md` |
| `hardware/yed-m100mg-b1/` | 4G/GNSS 探测与验证工具 | 安全直连 OneNET 未打通（固件证书校验无公开证据），不能降级明文 | 该目录 `README.md` |
| `competition/esp32-node/`（旧工程） | 历史分链构建 | 已被 `firmware/` 取代；旧 profile 与在板固件不一致 | `firmware/README.md`、该目录 `README.md` |
| `competition/experiments/` | 历史实验快照 | 不是真源，仅用于追溯 | 各目录内说明 |
| `cloud/backend` 的 AI 健康建议实现细节 | `deepseek-client.js`、`health-*.js` | `04` 只讲到模块边界与调用链；该功能属"健康建议"而非安全主链路 | `docs/AI-HEALTH-ASSESSMENT-SPEC.md`、`cloud/backend/README.md` |

---

## 维护约定

- 代码改了 → 先改对应层文档（`02/03/04/05`），再同步 `01` 的数据流与 `06` 的知识点实例。
- 新能力上线 → 更新 `00` 能力清单（标 `✅/🟡/⬜` 与日期），并补 `VALIDATION-MATRIX`。
- 文档里的行号会随代码变化漂移；引用时以"函数名 + 行号"成对出现，行号失配时按函数名搜索。
- 不写任何密钥/口令/内部凭据。
