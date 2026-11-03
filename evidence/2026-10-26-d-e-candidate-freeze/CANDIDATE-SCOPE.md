# CANDIDATE-SCOPE — 组合候选包含什么、不包含什么、证据到什么等级

- 日期：2026-10-26（Asia/Shanghai）
- 候选：`app/guardian-d-e-candidate-2026-10-26-unsigned.hap`
  2,621,844 B / `7634A0E25FCE3E19FC9604E4CD94D6D6BAFF36CB5DE67C92DAEE0E50C1452EB5` / **unsigned** / **未安装**

## 1. 包含矩阵

| 能力 | 是否在候选内 | 代码位置 | 证据等级 | 未验收边界 |
| --- | --- | --- | --- | --- |
| D：处置结果登记（5 种结果 + ≤200 字说明） | 是 | `backend/src/safety-log.js`、`server.js`；`AlertDetailPage.ets` 处置面板 | LOCAL TEST / ISOLATED PASS | 未在真机保存过、未连过真实后端 |
| D：处置与 ACK 完全分离（不生成命令、不改状态、不清 `ackPending`） | 是 | `store.js` 独立台账；隔离脚本断言 | LOCAL TEST / ISOLATED PASS | 真实告警上的行为未验收 |
| D：安全日志持久台账（schema v6，重启可查，2000 条上限） | 是 | `persistent-store.js`、`GET /api/v1/safety-logs`；`LogPage.ets` 页签 | LOCAL TEST / ISOLATED PASS | 未在真实后端重启验证 |
| D：服务端生成操作者/时间、请求白名单、幂等 201/200/409 | 是 | `safety-log.js`、`server.js` 路由 | LOCAL TEST / ISOLATED PASS | 公网未部署 |
| E：活动日/周/月报告接口 | 是 | `backend/src/activity.js`、`activity-store.js`、`server.js` | LOCAL TEST / ISOLATED PASS | 未部署、未用真实数据积累 |
| E：活动独立 `version=1` 文件、重启恢复、损坏 fail-closed、写失败回滚 | 是 | `activity-store.js`、`main.js` | LOCAL TEST / ISOLATED PASS | 与生产卷的兼容未验证 |
| E：APP 活动报告页（日/周/月切换、日期选择、覆盖率、趋势、分房间、免责声明） | 是（页面已注册） | `core/activity/*`、`ActivityReportPage.ets` | LOCAL TEST + ArkTS 编译/打包 | **未真机运行**：日期选择、切换、滚动布局、演示模式文案 |
| CAMERA-A：告警证据 JPEG 入口与安全约束 | 是 | `core/evidence/EvidenceCore.ts`、`AlertDetailPage.ets` 证据面板 | LOCAL TEST（存在性/静态约束） | `CAMERA_A_LOCAL_BUILD_PASS_REAL_ACCEPTANCE_BLOCKED` |
| P0：自动刷新 / 离线保留读数 / 既有 ACK / 会话切换 | 是 | `MonitorPage.ets`、`DevicePage.ets`、`core/*` | 回归通过（非重新真机验收） | 沿用 2026-10-24 的历史真实验收事实 |
| 远程视频 / 低帧率预览 / WebRTC | **否** | — | — | 未实现 |
| 正式跌倒检测 / FALL 事件与证据上报 | **否** | — | — | 未正式交付（只有本地姿态/跌倒状态机基础） |
| 门磁 / 电量 | **否** | — | — | 未实现 |
| 独立便携 SOS 设备 | **否** | — | — | 未成品 |
| 本地声光告警闭环（`LOCAL-ALARM-VOICE-CLOSURE`） | **否** | — | — | 用户明确暂停，本任务未恢复 |

## 2. 三条硬边界（写进任何对外说明前先读）

1. **ACK ≠ 已处置**：处置记录只是人工记录，不产生 ACK 命令、不改告警状态。反过来，
   ACK 也不自动生成处置记录。两者可以各自独立发生。
2. **PIR 次数 ≠ 人数/步数/轨迹/诊断**：活动报告只统计传感器触发次数；无数据不等于无人、
   不等于没有活动；不足历史不给趋势；长断连只降覆盖率，不补 0。
3. **单户固定角色**：操作者固定 `household-guardian`（展示“家庭监护人”），
   **没有**多家庭/多监护人身份区分与审计，不得对外宣称支持。

## 3. 组合后新增的耦合风险（本任务已记录）

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| E 的活动文件损坏会让**整个后端** fail-closed 拒绝启动 | D 的处置/安全日志、既有 ACK/告警查询一起不可用 | 运维先移走 `activity-state.json` 留档再重启；见 `DEPLOY-READINESS-AND-ROLLBACK.md` §4 |
| 活动写盘失败被收敛为独立失败域，摄取仍 202 | 自然 202 **不能**证明活动统计已落盘 | 只看报告数值/活动文件；后端日志有 `[backend] ACTIVITY_RECORD_FAILED code=…` |
| 主快照升到 schema v6 | v5 旧代码读不了 v6 文件 | 回滚必须恢复升级前主快照，不能只换程序 |
| 活动文件是第二份状态 | 备份/回滚必须同时覆盖两份 | 见 `DEPLOY-READINESS-AND-ROLLBACK.md` §2/§5 |
| `server.js`/`main.js`/`package.json` 为 D/E 共享 | 只上 D 需要另行拆分共享文件 | 本候选天然含 D+E；上线范围需用户显式决定 |

## 4. 一句话状态

```text
LOCAL_CANDIDATE_FROZEN — NOT_DEPLOYED — NOT_INSTALLED — REAL_ACCEPTANCE_NOT_RUN
```
