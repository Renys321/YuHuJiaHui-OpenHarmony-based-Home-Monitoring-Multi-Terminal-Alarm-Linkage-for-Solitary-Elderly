# 独立隔离集成验证（Lead 执行）

- 日期：2026-10-26（Asia/Shanghai）
- 结论：**ISOLATED_PASS** —— 37/37 项断言通过
- 性质：**本地隔离验证**（不是真实验收；不代表公网/手机运行态闭环）
- 脚本：`isolated-verify.js`（Lead 独立编写，不复用 backend-dev 的脚本）
- 结果 JSON：`ISOLATED-VERIFY.json`
- 运行命令：`node competition/evidence/2026-10-26-alert-disposition-safety-log/isolated-verify.js`

## 1. 隔离边界（先声明后执行）

| 项 | 事实 |
|---|---|
| 数据文件 | 操作系统临时目录 `mkdtemp` 下的独立 `backend-state.json`（运行结束删除） |
| 网络 | 仅 `127.0.0.1` 临时端口（`listen(0)`），无公网请求 |
| 告警数据 | 脚本用 `store.ingest()` 写入的 **TEST fixture**（`esp32-test-disp` / `alarm-test-disp-1`、`alarm-test-disp-2`），明确非生产记录 |
| MQTT / HTTP ingest | 未发布、未调用生产 ingest |
| 设备 | 未打开串口、未 hdc、未操作任何设备 |
| 既有告警 | 未 ACK/reset/清除任何既有或生产告警 |
| 生产部署 | 未部署、未改公网 backend/DNS/绑定/Wi-Fi/AP |
| 凭据 | `tokenSecret`/`appAuth` 在进程内随机生成，不打印、不落盘；快照扫描确认不含 token/口令/openid |

## 2. 覆盖的 37 项断言

1. 未认证 `GET /api/v1/safety-logs` → 401
2. 初始安全日志为空（不伪造）→ 200 `{logs:[]}`
3. 首次登记处置 → 201 `{created:true}`，公开字段（dispositionId/alarmId/deviceId/roomName/alarmType/outcome/outcomeLabel/operator/operatorRole/serverTime）齐全
4. `dispositionId` 形如 `dsp-N`
5. 公开响应不含 token/openid/口令字段
6. 同 `clientDispositionId` 同内容重放 → 200 `{created:false,duplicate:true}` 且返回原记录
7. 同 `clientDispositionId` 改内容 → 409
8. 非法 outcome → 400
9. note 201 字符 → 400
10. `OTHER` 且空说明 → 400
11. note 含控制字符 → 400
12. 请求体伪造 `operator` 字段 → 400
13. `clientDispositionId` 过短 → 400
14. 未知告警登记处置 → 404
15. `GET /alerts/{alarmId}/dispositions` → 1 条
16. 登记处置后告警仍为 `ALARM` 且 `ackPending=false`
17. 登记处置未生成任何 ACK 命令（commands=0）
18. 既有 ACK 接口回归 → 202 `{status:'PENDING'}`
19. ACK 生成 1 条 PENDING 命令
20. ACK 提交后告警仍非 ACKED（202 不冒充已确认）
21. ACK 等待设备回执期间仍可登记处置 → 201
22. 设备真实回执后告警 ACKED
23. ACKED 后仍可登记处置 → 201（处置独立于 ACK）
24. `GET /safety-logs` → 3 条
25. 排序：`serverTime` 降序、同刻按 dispositionId 数值降序
26. 按 `alarmId` 过滤
27. `limit=1` 生效
28. **重启后**（同一数据文件、新 PersistentStore + 新 server）安全日志仍可查 3 条
29. 重启后单告警处置记录 3 条
30. 重启后 ACK 命令仍只有 1 条（处置未新增命令）
31. 重启后 ACKED 状态与 acknowledgedAt/acknowledgedBy 保留
32. 快照 `schemaVersion=6` 且 `safetyLogs` 3 条
33. 快照不含 token/口令/openid 字段或会话 token 值
34. 快照顶层只含白名单键
35. 安全日志记录只含白名单字段
36. v5 旧快照可加载且 `safetyLogs` 视为空账本
37. 全流程无生产副作用（见第 1 节）

## 3. 与 backend-dev 独立结果的交叉印证

| 验证 | 执行者 | 结果 |
|---|---|---|
| backend 全量 `npm test` | backend-dev | 253/253（其运行时段）；Lead 复跑最终树 274/274（含并行会话新增测试） |
| D 类定向测试（safety-log 三文件） | Lead | 37/37 pass，exit 0 |
| 隔离集成（同数据文件重启） | backend-dev | 3 端点 / 2 处置 / 2 安全日志 / 1 ACK 命令 / schema 6 / restart ok |
| 隔离集成（37 断言，独立脚本） | Lead | 37/37 pass，ISOLATED_PASS |

## 4. 明确未覆盖（不得据此宣称真实验收）

- 公网 backend 未部署新接口（当前公网仍是 v1.0.0 合同，无 `/dispositions`、`/safety-logs`）。
- APP 未在真实手机/模拟器上对真实后端完成"确认→处置→历史查询"运行态闭环；Hypium 39/39 与 HAP 构建只是本地编译/单测证据。
- 未使用用户指定的既有可操作告警做真实验收；未制造 SOS/FALL；未 ACK 既有告警。
- 未做并发/多实例部署验证（后端持久化仍是单进程设计，沿用既有边界）。
