# CORE-REQUIREMENTS-GAP-FREEZE — Lead 交付汇总与 02:05 状态更新

- 任务：CORE-REQUIREMENTS-GAP-FREEZE（原始要求五项 A–E 局部核对）
- 执行：auditor（只读审计）+ Lead（汇总/复核）
- 审计基准：2026-10-26 01:43–01:53；本文件补充 01:53–02:05 期间的状态变化（不修改审计时点结论）
- 主要交付：
  - `REQUIREMENTS-MATRIX.md`：A–E 共 21 子项矩阵（判定/真实证据/源码行/缺口）
  - `REPORT.md`：特别核实 1–5、历史 vs 本轮 vs 本地 vs 未实现分级、阻塞与风险
  - `FOLLOWUP-TASKS.md`：F-01…F-15（目标/依赖硬件或用户动作/验收口径）
  - 本文件：Lead 汇总 + 新增事实

## 1. 判定统计（审计时点，21 子项）

| 判定 | 数量 | 子项 |
|---|---:|---|
| 已实现且真实验收 | 6 | A1 PIR、A3 温湿度、C1 手机实时数据、C3 在线、C6 历史告警、D1 ACK（均为 HISTORICAL-REAL，本轮未重测） |
| 已实现但未真实验收 | 1 | B4 断网本地求助 |
| 部分实现 | 10 | A4 便携 SOS、A5 阈值识别、B1 厨房声光语音、B2 卫生间声光语音、B3 DAYU 声光语音、C5 按日期报告、D2 处置结果、D3 安全日志、E1 活动时段、E2 每日趋势 |
| 未实现 | 1 | E3 周/月报告 |
| 需要硬件或用户选择 | 3 | A2 门磁、C2 门窗记录、C4 电量 |

## 2. 特别核实结论（摘要，证据见 `REPORT.md`）

1. **自动启动**：`DEMO_AUTOSTART_REAL_PASS_WITH_LIMITS`。P0 健康复用下的推理/相机自动拉起、单实例、HDC 重连、DAYU 重启恢复、推理崩溃恢复、暂停 65s 不反拉、15 min 稳定均 REAL PASS（实测 inferFps=1.53，不写 ≥2）；**无 P0 的 PC 冷启动 = NOT TESTED**（`COLD-START-HANDOFF.md` 已备，等用户重启后只双击一次入口）；纯 USB 通信断开 FAILED（实际断电重启）；最终三节点 2/3。
2. **ACK 与处置/安全日志**：ACK 已有真实验收闭环（2026-10-22 实体 SOS→202→设备 ACKED）；但审计时点**没有独立处置结果、也没有可查询的持久安全日志**——ACK note 只是命令自由文本（`alert.action`，`GET /alerts` 不返回），DAYU 本机 `safety.log` 仅设备本地、只记 ACK；APP“安全日志”页实为 alerts 分组。
3. **日报/周报/月报**：审计时点**不是真实历史查询**——后端无 report/stats/日期区间接口，`GET /alerts` 无分页/日期过滤；APP 只是客户端按日期分组 `gv.alerts` 与近 7 天告警计数；“近 7 天告警统计”≠日报/周报/月报，周/月报告未实现。
4. **门磁/电量**：门磁**无真实硬件**（厨房/卫生间 `DOOR_GPIO=-1`；ESP32 上报 `lastOpenTs` 硬编码 0；仅未部署 living profile 配 DOOR=5）；电量**全链路无 battery 字段**（仅 csq），不存在默认值/占位。必须区分“未知 vs 真实 0”：卫生间日志 `door.open=false`、`gas/smoke raw=0 valid=false`、`ts=0` 均属未知；厨房正常版 `valid=true` 的自然变化才是真实读数。
5. **厨房音量20正常版 / 卫生间**：厨房正常版**已部署**（COM5，939,936 B，SHA-256 `A76224A4…7DBC11`，`KITCHEN_V20_NORMAL_DEPLOYED_SHORT_RUN_PASS`，短时运行，无真实告警触发声光）。**“卫生间尚未部署”只对正常版成立**：COM4 已于 2026-10-26 01:36 刷入 **listening 诊断镜像**（1,040,096 B，写 `0x10000`，hash verified，MAC `14:c1:9f:42:dd:b4`，启动 `PLAY clip=3`），该目录无 REPORT、无用户试听确认、无结构化 MQTT 证据；正常版 933,040 B 已构建但**未刷**。master REPORT “COM4 未烧录”已滞后，现场口径应改为 **“正常版未部署，当前运行 listening 诊断镜像”**。

## 3. 02:05 状态更新（审计之后发生的事实）

| 项 | 更新 | 证据 |
|---|---|---|
| D2/D3（处置结果 + 安全日志） | **本轮已实现并完成本地测试/构建/隔离集成（未真实验收）**：backend schema v6 + 3 接口；APP 处置面板 + 安全日志页签；backend 全量 274/274、D 定向 37/37、隔离集成 37/37、APP Hypium 39/39、assembleHap 成功（HAP 2,613,947 B / `2CFB8908…EAF91DF`，unsigned） | `competition/evidence/2026-10-26-alert-disposition-safety-log/` |
| E1/E2（活动时段/每日趋势） | **并行会话正在实现**（`GET /api/v1/activity/report`、APP `ActivityReportPage`、后端独立 `activity-store.js`），**不属于本 Team 本轮任务**、未验收；审计结论仍按“部分实现”记录 | `competition/evidence/2026-10-26-activity-reports/`（并行会话） |
| 卫生间 | 并行会话在 01:53 后仍继续改动该目录（正常版刷入/观察仍在进行中）；截至本文件时间**正常版部署与试听确认仍无归档证据** | `competition/evidence/2026-10-26-bathroom-local-voice/` |
| 三节点 | 归档仍为 2/3、1/3–1/1 波动；运行时快照 3/3 为非归档状态，不构成验收 | `REPORT.md` §三节点口径 |

> 说明：本轮工作区同时存在另一个会话（并行实现 E 类 + 继续卫生间取证）。因此审计矩阵的 E1/E2/E3 判定以审计时点为准；F-10 的状态按本文件更新为“已实现，待真实验收”。

## 4. 后续任务清单（沿用 `FOLLOWUP-TASKS.md`，按用户口径给出最直接下一步）

**P0（先做）**
1. **F-13 冷启动**：用户正常重启 PC → 登录后**只双击一次** `<WORKSPACE>\competition\materials\start-demo-all.cmd`；若出现 P0 窗口，在其中隐藏输入一次 `INGEST_KEY`；不允许 AI 补命令，否则该次不算一键 PASS。同时复查 `demo-autostart.log` 01:18–01:19 四次 `Hash mismatch after deploy`（新发现，未解释）。
2. **F-04 卫生间正常版**：等并行会话完成当前观察后，用户授权把 COM4 从 listening 诊断镜像切到正常版（无启动诊断语音），现场试听并补 REPORT；不要直接把 GPIO9 旧配置当恢复方案。
3. **F-10 D2/D3 签收**：先授权**公网 backend 升级**（`competition/evidence/2026-10-26-alert-disposition-safety-log/DEPLOY-DIFF-AND-ROLLBACK.md`，含备份/回退），再**签名安装新 HAP**，最后由用户指定**一个既有可操作告警**做“查看→（是否 ACK 由用户定）→处置→保存→安全日志查询”的真实验收。
4. **F-01 门磁 / F-02 便携 SOS**：需要选定硬件、接线/配对与烧录授权。

**P1**：F-03 真实阈值触发、F-05/F-06 告警触发声光语音验收、F-08 电量硬件、F-09 按日期报告运行态验收、F-11 活动趋势打通（与并行 E 会话对齐）、F-14 三节点稳定在线。
**P2**：F-07 断网求助、F-12 周/月报告、F-15 实体手机兼容。

## 5. 阻塞与限制

- 真实验收需要现场动作/授权，不以“本地构建通过”替代。
- 门磁、电量、便携无线 SOS 必须先补硬件与接线，不能用默认值/占位冒充。
- GAS/SMOKE 阈值 4096 = 禁用，MQ-2/MQ-5 只能表述为原始 ADC，不得写 ppm/浓度/“燃气正常”。
- 无活动 ≠ 跌倒/昏迷；未知/离线/未配置不得显示为正常或零。
- 三节点当前不得声称 3/3；历史 3/3 仅限 2026-10-25 短时段。
