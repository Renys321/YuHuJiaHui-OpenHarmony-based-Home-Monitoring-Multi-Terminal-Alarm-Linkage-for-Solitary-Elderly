# AI 老人健康科普评估 — 交付报告（最终版）

- 日期：2026-10-27（Asia/Shanghai）
- 证据目录：`competition/evidence/2026-10-27-ai-health-assessment/`
- 工作区：`<WORKSPACE>`（无 Git 仓库；改动以文件哈希 + 备份留证）
- 定性：**本功能只提供健康科普与生活方式建议，不诊断、不开药、不给治疗方案、不替代医生。**

---

## 0. 最终结论

| 层级 | 状态 | 依据 |
| --- | --- | --- |
| 本地实现 + 回归测试 | ✅ **PASS** | 后端 `npm run check` 0、`377/377`；APP `tsc` 0、`368/368`、隔离构建副本 `338/338`；`assembleHap` BUILD SUCCESSFUL |
| 后端真实 DeepSeek 调用（本地 / 生产同款镜像 / 生产同款 compose 演练） | ✅ **PASS（真实 HTTPS）** | 200 / 8,240 ms、200 / 6,187 ms、200 / 8,406 ms；真实超时 504；固定 disclaimer；红线 0 命中；Key 无泄漏 |
| **生产发布** | ✅ **已完成** | 生产 `GET /api/v1/health-profile`（登录后）由 404 变为 200；`HEALTH_ADVICE configured=true`；容器 healthy；caddy 未重启；v7 数据未迁移 |
| 生产真实 DeepSeek 调用 | ✅ **PASS** | `POST /api/v1/health-advice` → **200 / 6,716 ms / deepseek-chat**；disclaimer 固定；红线 0 命中 |
| **APP 安装 + 生产真实 AI 结果展示** | ✅ **PASS（HarmonyOS 模拟器）** | APP 1.0.5 已安装并登录生产账号；保存→生成（第三方 AI 同意弹窗）→真实结果四段+固定免责声明；重启后资料仍在；截图与页面文本证据齐全 |
| **`AI_HEALTH_LOCAL_PASS`** | ✅ **达成** | 表单 ✔、后端保存 ✔、DeepSeek 调用 ✔、APP 真实结果展示 ✔、单元/回归 ✔ |
| **`AI_HEALTH_REAL_PASS`** | ✅ **达成（附 2 项限定）** | 真实 DeepSeek API 成功生成过建议 ✔；APP 真机（模拟器）显示过结果 ✔；失败态真实验证 ✔（发布前 404→重试）；**设备端“AI 超时”未强制复现**（见 §8），超时语义由真实网络超时（本地 504）+ 单元测试覆盖 |

**未完成项（如实）**：设备端 AI 超时实测、生产容器重启后的持久化实测、Hypium 平台测试、DAYU200 物理真机安装（无该 bundle 签名材料）、真实双账号切换演练、语音交互、医疗诊断、处方/治疗建议、地图、多用户复杂健康档案。
**未执行项一律未标记为通过。**

---

## 1. 开始前审计（只读）

| 项 | 审计结果 |
| --- | --- |
| APP 页面结构 | 4 Tab（首页/监测/预警/我的）+ 独立页；`main_pages.json` 注册 |
| 登录/Bearer/会话 | `POST /api/v1/auth/app` → HMAC 会话；`GuardianService` 统一持有；`TokenVault`（AssetStore）；`RequestGuard`/`SessionCommit` 防跨会话串数据 |
| 后端 schema/持久化 | 主快照 `PersistentStore` schema **v7**（门磁 v7 已发布）；`ActivityStore`/`EvidenceStore` 独立文件 |
| API 路由组织 | `createApiServer()` 单文件 if 链；统一 Bearer 401/403 位于路由中段 |
| Docker/生产 | `deploy/compose.public.yaml`（backend + caddy）；生产 `https://api.luxunacc.xyz` |
| 测试命令 | 后端 `node --test --test-isolation=none`；APP `tsc -p tests/tsconfig.json` + 同上；HAP `hvigorw assembleHap` |
| 既有健康/AI 代码 | 无（本轮新增） |
| 未提交改动保护 | 无 Git；修改前已备份到 `_work/*-before/`；工作区 GPS 草稿未覆盖、未发布；D/E、门磁 v7、COM4/5/8、M100/GPS、CAMERA-A 未被本轮改动 |

---

## 2. 后端实现（v7 + 健康科普，主 schema 不变）

### 2.1 接口

| 方法 | 路径 | 成功 | 失败 |
| --- | --- | --- | --- |
| GET | `/api/v1/health-profile` | 200 `{profile}` / `{profile:null}` | 401/403/400(query)/503 |
| PUT | `/api/v1/health-profile` | 200 `{profile}`（服务端 `updatedAt`） | 400（字段路径+规则，不回显值）/413/401/403/503 |
| POST | `/api/v1/health-advice` | 200 `{advice,generatedAt,model}` | 409 `HEALTH_PROFILE_EMPTY`、503 `AI_NOT_CONFIGURED`、504 `AI_TIMEOUT`、502 `AI_UPSTREAM_ERROR`；失败不返回建议 |

合同：`API-CONTRACT.md`、`contracts/APP-API-v1.json`（1.3.0）。

### 2.2 存储与权限

- 独立 `/data/health-state.json`（version=1、0600、原子写+fsync+rename、写失败回滚、启动严格校验）；
- 归属键 `h1_` + HMAC(API_TOKEN_SECRET, 会话 sub)，快照无 openid/token/身份字段；
- 主快照 `backend-state.json` **schema 不变（v7）**，无迁移，回滚不需恢复数据。

### 2.3 DeepSeek 调用

- 仅后端 HTTPS 调 `https://api.deepseek.com/chat/completions`；Key 只从 `DEEPSEEK_API_KEY`；启动只打印 `configured=true/false`；
- 超时 12s（≤15s）、最多 1 次重试（网络/超时/429/5xx）、响应 ≤20,000 字节结构校验；
- 固定提示词 `health-advice-prompt-v1`（`PROMPT.md`，SHA-256 `7026fe…`）；16 红线词 + 否定语境感知；disclaimer 服务端强制覆盖；
- 内存短缓存 `ownerRef + profile hash`（TTL 300s、容量 64）；不落盘原始响应；失败只记 `code=… reason=…`。

### 2.4 变更清单

见 `BACKEND-CHANGELOG.md`：4 个新源文件、4 个新测试、5 个增量修改；与已部署 v7 对比，`store.js`/`persistent-store.js`/`activity*`/`comms-core`/`notify-*` 零改动；GPS 草稿符号 0 命中。

---

## 3. APP 实现（1.0.5）

- 新增 `pages/HealthAssessmentPage.ets` 与 `core/health/{HealthModels,HealthAdvice}.ts`；
- `GuardianService` 新增 load/save/generate；登录/登出/401 清理 6 个 `gv.health*` 键与内存缓存；
- 页面常驻三条提示（隐私 / 免责 / **第三方 AI 告知**）；首次生成前弹窗二次同意，拒绝则不发送；
- 急症词命中立即提示就医（不等 AI）；
- 结果四段 + 固定免责声明；失败/超时/空资料/未开放状态明确、可重试、不伪造；
- 页面不直连 ApiClient/HttpTransport（static-guard 通过）。

详见 `APP-CHANGELOG.md`。

---

## 4. 测试结果（真实执行）

| 类别 | 结果 | 日志 |
| --- | --- | --- |
| 后端 check | exit 0 | `logs/backend-check.log` |
| 后端全量（工作区） | **377/377 PASS** | `logs/backend-test-377.log` |
| 后端全量（发布源码） | **377/377 PASS** | `logs/release-src-test-377.log` |
| APP tsc | exit 0 | `logs/app-tsc.log` |
| APP Node 测试（工作区） | **368/368 PASS** | `logs/app-test-368-final.log` |
| APP Node 测试（构建副本） | **338/338 PASS** | `logs/app-build-copy-test-338.log` |
| HAP 构建 | BUILD SUCCESSFUL | `logs/app-assembleHap-1.0.5-final.log` |
| 后端 Docker 构建（本地） | exit 0 | `logs/backend-docker-build.log` |

Mock/注入矩阵见 `MOCK-TESTS.md`（与真实调用严格区分）。

---

## 5. 真实 DeepSeek 验收（真实 HTTPS，合成资料）

| 场景 | 结果 | 证据 |
| --- | --- | --- |
| 本地后端：匿名 GET/PUT | 401 | `real-api/e2e-run.json` |
| 保存合成资料（72 岁/高血压/氨氯地平/165cm/62kg/135/82/6.1…） | 200，17 字段+`updatedAt` | 同上 |
| 本地真实生成 | **200 / 8,240 ms / deepseek-chat** | `real-api/advice-complete.json` |
| 资料不足 | **200 / 5,120 ms，“信息不足”，无诊断词** | `real-api/advice-incomplete.json` |
| 未知身份字段 | 400，快照无身份/token | `real-api/e2e-run.json` |
| 本地重启读取 | 200，资料保留 | 同上 |
| 真实超时（不可达 https + 1s） | **504 AI_TIMEOUT** | `real-api/advice-timeout.json` |
| 生产同款镜像容器 | **200 / 6,187 ms**；重启后资料在；`/data/health-state.json` 0600；日志无 Key/资料 | `docker-smoke-first.json`、`docker-smoke-restart.json`、`docker-advice.json` |
| 生产同款 compose+Caddy 演练 | **200 / 8,406 ms**；401/登录/保存/读取全过；红线 0 | `deploy/REHEARSAL.md`、`real-api/rehearsal-advice.json` |
| **生产环境（发布后）** | **200 / 6,716 ms；内联 profile 6,986 ms；匿名 401；非法输入 400；既有 overview/door-events/safety-logs 200** | `real-api/prod-acceptance.json`、`prod-advice-complete.json` |

---

## 6. 生产发布（已完成）

- 发布方式：主机 `/opt/eldercare` 用源码包 `docker compose build backend`（Windows 导出的镜像为 OCI 格式，主机 `docker load` 不兼容，改用源码构建）；
- 新镜像 `eldercare-cloud-backend:local` = `cdc38bf7298e`；旧 v7 镜像 `5a02edcfaa42` 保留；
- 只重建 backend，caddy 未重启；启动日志 `HEALTH_ADVICE configured=true`；容器 healthy；
- 发布前 schema：`{"schemaVersion":7,"devices":8,"alerts":75,"safetyLogs":6}`；本发布不改 `backend-state.json`；
- 备份：`/opt/eldercare/backup/20261027-155004/`、`20261027-155417/`（旧镜像、/data 卷、schema 计数、旧源码、旧 compose）；
- 详细记录与回滚：`acceptance/PRODUCTION-RELEASE.txt`、`deploy/DEPLOY-COMMANDS.md`、`deploy/host-rollback.sh`。

---

## 7. APP 安装与真机验收（HarmonyOS 模拟器，真实生产后端）

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 安装 | `hdc -t 127.0.0.1:5555 install -r guardian-health-1.0.5-unsigned.hap` → **成功**；`1.0.5 / 1000005 / appSignType=none` | `acceptance/INSTALL-RECORD.txt`、`app-bm-dump-1.0.5.txt` |
| 登录 | 生产监护人账号登录成功（真实 8 设备 / 45 告警） | `screenshots/09-login-result.jpeg` |
| 健康评估页 | 三条固定提示常驻 | `screenshots/11-health-page-top.jpeg` |
| 两页表单 | 第 1/2 页实际填写并保存 | `screenshots/20–36`、`42` |
| 保存→读取闭环 | 页面显示 `已保存的健康资料`，字段全部回填 | `screenshots/42-health-reload.jpeg` |
| 第三方 AI 同意 | 生成前弹窗（含“通过 HTTPS 发送给第三方 AI（DeepSeek）…不会发送身份证号、手机号或详细住址”） | `screenshots/52-consent-dialog.jpeg` |
| **真实 AI 结果** | 四段结果 + 固定免责声明 + 重新生成/修改资料 | `screenshots/54–56`、`acceptance/APP-ADVICE-RESULT.json` |
| 红线检查（页面全文） | **0 命中** | 同上 |
| 重启持久化 | force-stop → 重启 → 再次显示已保存资料 | `screenshots/57/58` |
| 失败态（发布前真实 404） | `对象不存在或已失效` + 重试，不伪造成功 | `screenshots/30-save-result.jpeg` |

详见 `acceptance/APP-ACCEPTANCE.md`。

---

## 8. 未完成 / 未验证（如实披露）

1. **设备端 AI 超时态未强制复现**：需在生产临时改 `DEEPSEEK_TIMEOUT_MS` 并重启；本轮未做。超时语义已由「真实网络超时→504」+ 单元测试覆盖。
2. **生产容器重启后的持久化未实测**：本地后端与本地同款 Docker 容器已实测跨重启持久；生产侧未主动重启（避免不必要中断）。
3. **Hypium 平台测试未运行**；真机为 HarmonyOS 模拟器（项目历史验收环境），非 DAYU200 物理机。
4. DAYU200 真机：unsigned 安装被拒（`9568320 no signature file`），SDK 开发签名被拒（`9568393 verify code signature failed`），本机无 `com.example.program_04` 签名材料；**未换签名、未卸载清数据**。
5. 真实双账号切换清理未演练（生产只有一个 APP 监护人账号），由代码/静态断言覆盖。
6. **DeepSeek Key 轮换待办**：部署过程中 Key 曾在交互终端/聊天中出现（已提示用户），当前生产使用该 Key；建议在 DeepSeek 控制台吊销并轮换，更新 `/opt/eldercare/deploy/.env.deploy` 后 `up -d --force-recreate backend`。
7. 本功能不含：语音交互、医疗诊断、处方/治疗建议、地图、多用户复杂健康档案、影像/舌苔/皮肤上传。

---

## 9. 隐私与医疗红线

见 `PRIVACY-REDLINE-CHECKLIST.md`：鉴权/归属/白名单/脱敏/Key 不落盘/日志无资料/第三方 AI 告知/固定 disclaimer/失败不伪造等 18 项；真实生产与真机均有对应证据；未验证项已单列。

---

## 10. 回滚

- 后端：`acceptance/PRODUCTION-RELEASE.txt` §回滚 / `deploy/host-rollback.sh`；主快照未改，回滚无需恢复数据；旧镜像保留。
- APP：覆盖安装方式升级，未卸载、未清数据；可用历史 HAP 覆盖回退。
- 本发布不改固件/串口/COM4/5/8/门磁 v7/D-E/SOS-ACK/OneNET/DNS/Caddy/TLS。

---

## 11. 证据索引

| 文件/目录 | 内容 |
| --- | --- |
| `BACKEND-CHANGELOG.md` / `APP-CHANGELOG.md` | 变更清单与哈希 |
| `API-CONTRACT.md` / `contracts/` | API 合同 v1.3.0、冻结规格 |
| `PROMPT.md` | 提示词 v1、SHA-256、红线词、校验规则 |
| `TEST-RESULTS.md` / `MOCK-TESTS.md` | 测试结果与注入矩阵 |
| `PRIVACY-REDLINE-CHECKLIST.md` | 隐私/红线清单 |
| `VERSIONS.md` | 工具链与版本 |
| `logs/` | 测试/构建日志 |
| `real-api/` | 真实 DeepSeek 证据（本地/容器/演练/超时/生产） |
| `deploy/` | 发布包、命令、演练、回滚脚本、镜像包 |
| `acceptance/` | 安装记录、生产发布记录、APP 验收记录、页面截图、结果页文本 |
| `app/` | HAP 1.0.5 + 签名/安装说明 |
| `SHA256SUMS.txt` | 本目录文件哈希 |
