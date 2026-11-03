# 测试结果（本地/接口级）

> 所有结果均为本机真实执行，命令与日志见 `logs/`。真机与生产验收单列于 `REPORT.md`。

## 1. 后端（发布源码 `_work/release-src`）

| 命令 | 结果 | 日志 |
| --- | --- | --- |
| `npm run check` | **exit 0**（18 个 src 文件 `node --check`） | `logs/backend-check.log` |
| `node --test --test-isolation=none`（工作区 v7+健康） | **377/377 PASS，exit 0** | `logs/backend-test-377.log` |
| `node --test --test-isolation=none`（发布源码，含 docs/mobile/onenet 同级布局） | **377/377 PASS，exit 0** | `logs/release-src-test-377.log` |

基线对照：v7 为 313/313；本次新增 64 项（健康存储/客户端/资料接口/建议接口 + 合同版本），无既有用例删除或放宽。

覆盖要点（新增 64 项）：

- 健康资料：401/403、query 400、空资料 200 `profile:null`、保存/读取、`updatedAt` 服务端写入、24 组非法标量、17 种身份字段变体（400 且文件字节不变）、>8 KiB→413、双身份隔离与不串户、写盘失败 503+回滚、重启持久。
- 建议接口：409 空资料、503 未配置、504 超时、502 其它失败（均无 advice）、真实客户端接线 200 + 强制 disclaimer + 缓存、内联 profile 失败不回退已保存资料、AI 抛异常被收敛为 502 且不影响其它路由。
- DeepSeek 客户端：固定请求（https、model、temperature、max_tokens、response_format）、超时/网络/429/5xx 最多重试 1 次、非 2xx 不重试、空内容/非法 JSON/超长/结构异常失败、16 红线词逐项命中、否定语境 5 条安全文案、超 8 条截断、响应体读取阶段超时→`AI_TIMEOUT`、失败诊断只含固定短码、缓存键/TTL/容量、Key 不出现在 `describe()/JSON.stringify/日志/响应`。
- 合同：`APP-API-v1.json` 1.3.0 + 3 个新接口断言。
- 回归：健康路由注册后 ingest 202 / devices / alerts / ACK / door-events / comms / safety-logs 语义不变。

## 2. APP（`APP/ElderlyCareGuardian`）

| 命令 | 结果 | 日志 |
| --- | --- | --- |
| `tsc -p tests/tsconfig.json` | **exit 0** | `logs/app-tsc.log` |
| `node --test --test-isolation=none`（工作区源码） | **368/368 PASS，exit 0**（基线 300 + 新增 68） | `logs/app-test-368.log` |
| `node --test --test-isolation=none`（隔离构建副本 d-e-only） | **338/338 PASS，exit 0**（去除 CAMERA-A 专属 30 项后） | 见 `_work/logs/` |
| `hvigorw assembleHap` | **BUILD SUCCESSFUL，exit 0**（`skip sign`，unsigned） | `logs/app-assembleHap-1.0.5.log` |

新增 68 项覆盖：

- 表单校验：年龄/身高/体重/血压（含收缩≤舒张）/血糖边界、文本长度、空表单、只提交已填字段、回填、急症词命中。
- 响应解析：空/缺字段/类型错/缺免责声明/红线词→拒绝；忽略未知字段；不崩。
- ApiClient：200/401/403/404/409/502/503/504/网络/超时/非法 JSON；Bearer 头；不打印资料/token。
- 状态机：idle/loading/ok/timeout/failed/empty；失败文案含“暂时无法生成建议，请稍后重试”；**绝不伪造建议**。
- 固定文案与禁词：两条固定提示、固定免责声明；结果文案不含“你患有/诊断结果/建议服用/停止用药/治疗方案/病情等级/患病概率”。
- 会话清理：登录/登出/401 清 `gv.health*`；页面不直连 `ApiClient`（static-guard）。

## 3. 真实 DeepSeek（本地后端 + 合成资料）

`_work/scripts/real-deepseek-e2e.js` → `real-api/e2e-run.json`（全部真实执行）：

| 步骤 | 结果 |
| --- | --- |
| 匿名 GET/PUT 健康资料 | 401 |
| 登录 | 200 |
| 空资料 | 200 `{"profile":null}` |
| 保存合成资料（72 岁/高血压/氨氯地平/165cm/62kg/135/82/6.1/睡眠 7h…） | 200，17 字段 + `updatedAt` |
| **真实 DeepSeek 生成（完整资料）** | **200，8,240 ms，model `deepseek-chat`，7/8/6 条，disclaimer 固定** |
| **资料不足（仅年龄 78+用药不清楚）** | **200，5,120 ms，summary 含“信息不足”，无诊断词** |
| 身份字段（idCard/phone/address） | 400，`fields` 只回报字段名；持久化文件无身份/token |
| 重启后读取 | 200，age=72，medicalHistory 保留 |
| **真实超时（不可达 https + 1s）** | **504 `AI_TIMEOUT`，2,032 ms，无 advice** |
| 无资料 | 409 `HEALTH_PROFILE_EMPTY` |
| query 参数 | 400 |
| Key 泄漏扫描（日志+响应文件） | **0 个文件命中** |

## 4. 生产同款 Docker 镜像真实冒烟

`docker run` + 真实 DeepSeek（`real-api/docker-smoke-first.json` / `docker-smoke-restart.json`）：

- 匿名 401；登录 200；
- 保存资料 200（`updatedAt` 存在）；
- **真实建议 200，6,187 ms，disclaimer 固定，无诊断词**；身份字段 400；
- 容器重启后读取 200，age=72；
- 容器 `/data/health-state.json` 权限 `-rw-------`（0600），主快照未变；
- 容器日志不含 Key、不含资料内容。

## 5. 模拟（SIMULATED）与未测试（NOT TESTED）

- 后端单元测试中的 DeepSeek 响应均为注入 fake fetch（**SIMULATED**），用于失败语义与结构校验；真实调用证据见 §3/§4。
- `real-api/advice-timeout.json` 是**真实网络超时**（指向不可达 https），不是 mock。
- 空响应/非法 JSON/超长响应的“真实上游”未人为构造（会污染真实调用），由 15 项客户端单测覆盖（SIMULATED）。
- APP UI 自动化/真机状态见 `REPORT.md`；未安装成功时相关项标 `BLOCKED`，不作通过。

## 6. 生产环境验收（发布后，真实账号 + 真实 DeepSeek）

`_work/scripts/prod-acceptance.js` → `real-api/prod-acceptance.json`：

| 检查 | 结果 |
| --- | --- |
| 匿名 GET / PUT `/api/v1/health-profile` | 401 / 401 |
| 登录 | 200 |
| 空资料 | 200 `{"profile":null}` |
| 保存合成资料 | 200（17 字段 + `updatedAt`） |
| 读取 | 200，age=72 |
| **真实 DeepSeek 建议** | **200，6,716 ms，`deepseek-chat`，disclaimer 固定，红线 0 命中** |
| 内联 profile 生成 | 200，6,986 ms |
| 非法年龄 / 血糖 / 身份字段 / query | 400 / 400 / 400 / 400 |
| 既有功能回归 | `/overview` 200、`/door-events` 200（5 条）、`/safety-logs` 200 |
| 生产发布 | 源码构建镜像 `cdc38bf7298e`，`HEALTH_ADVICE configured=true`，caddy 未重启，schema 仍 v7 |

APP 端真机（模拟器）验收见 `acceptance/APP-ACCEPTANCE.md`（保存→生成→第三方 AI 同意→真实结果→重启持久→失败态）。