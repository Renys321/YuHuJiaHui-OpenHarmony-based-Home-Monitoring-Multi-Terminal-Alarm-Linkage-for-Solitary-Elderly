# BASELINE-AND-PREREQUISITES — D/E 生产发布基线、制品身份与缺项清单

- 日期 / 采集时间窗：2026-10-26 **23:44–23:52**（Asia/Shanghai）
- 角色：**只读基线分析**。本文不产生任何部署、构建、签名、安装、停止/重启、配置修改动作。
- 工作区：`<WORKSPACE>`。本次实测确认工作区**无 Git 元数据**（`.git` 不存在），任何回退只能靠哈希清单，不能靠 `git`。
- 本文用途：给 D/E 正式发布提供**发布必需的事实、制品身份、操作顺序与缺项清单**；不复述历史报告全文，只给提炼与引用（含路径:行号）。
- 一句话结论：**候选 HAP 与候选源码归档身份可复核、未漂移；但发布仍被“现场访问 + 用户授权 + 下列缺项”阻塞；且绝不能用当前工作区源码构建 D/E 镜像。**

## 0. 读法：三类事实严格分开

| 标记 | 含义 | 本文件处理方式 |
| --- | --- | --- |
| **历史记录** | 既往证据文件中的事实（带日期、路径:行号） | 只作“曾经如此”，**不得当作当前状态**；现场必须重新只读核验 |
| **当前实测** | 本次 23:44–23:52 只读命令直接观测到的结果 | 给出命令与返回值；有时效性 |
| **未知 / 需用户确认** | 本机观测不到，或需授权/现场条件才能取得 | 逐条列入 §3；未关闭前不得宣称“可发布” |

## 1. D/E 范围、合同版本、schema 与制品身份

### 1.1 候选范围（D + E + 既有 CAMERA-A，同一个 HAP）

| 能力 | 内容 | 代码位置 | 证据等级 |
| --- | --- | --- | --- |
| **D：告警处置结果 + 持久安全日志** | 5 种处置结果 + ≤200 字说明；服务端生成操作者/时间；幂等 201/200/409；独立安全日志台账（上限 2000 条，重启可查）；**处置与 ACK 完全分离**（不产生命令、不改告警状态） | backend `src/safety-log.js`、`store.js`、`persistent-store.js`、`server.js`；APP `Contracts/ApiClient/Outcomes/GuardianService/Models/ViewMapper`、`AlertDetailPage.ets`、`LogPage.ets` | LOCAL TEST / ISOLATED PASS；**未部署、未安装** |
| **E：PIR 活动日/周/月报告** | 独立 `version=1` 状态文件（与主快照版本无关）；日=1 天、周=7 天、月=30 天的“所选窗口”，`days[]` 另作趋势序列（7/30 项）；覆盖率按“自然日 00:00 到统计时刻”整段计；文件损坏则后端 fail-closed；写盘失败摄取仍 202 | backend `src/activity.js`、`activity-store.js`、`main.js`、`server.js`；APP `core/activity/*`、`pages/ActivityReportPage.ets` | LOCAL TEST / ISOLATED PASS；**未部署、无真实 PIR 数据积累** |
| CAMERA-A：告警证据 JPEG（内存 LRU 6 条/12 MiB、JPEG ≤2 MiB、Bearer 只走请求头） | 已编入同一 HAP | `core/evidence/EvidenceCore.ts`、`AlertDetailPage.ets` | 仅存在性/静态约束；`CAMERA_A_LOCAL_BUILD_PASS_REAL_ACCEPTANCE_BLOCKED` |

引用：`competition/evidence/2026-10-26-d-e-candidate-freeze/CANDIDATE-SCOPE.md:11-19`（包含矩阵与未验收边界）、`:28-33`（三条硬边界：ACK≠已处置；PIR 次数≠人数；单户固定角色 `household-guardian`）、`:39-43`（组合耦合风险）；E 的窗口/覆盖率修复见 `competition/evidence/2026-10-26-d-e-candidate-freeze/REPORT.md:106-129`。

**D 与 E 不可在镜像层拆开**：二者共用 `server.js` / `main.js` / `package.json`，本候选镜像天然同时包含两者；只上 D 需另行拆分共享文件并重跑全量测试（历史记录：`competition/evidence/2026-10-26-d-e-candidate-freeze/REPORT.md:261-262`、`competition/evidence/2026-10-26-d-e-rollback-hardening/DEPLOY-RUNBOOK.md:58-59`）。**上线范围（D+E 或仅 D）必须由用户显式决定。**

### 1.2 版本标识（版本号不足以标识内容）

| 项 | 值 | 备注 |
| --- | --- | --- |
| API 合同 | **1.2.0**（`1.1.0`=处置结果/安全日志；`1.2.0`=PIR 活动报告） | `competition/docs/APP-API-v1.md:3-5`、`competition/docs/APP-API-v1.json:3-7` |
| 候选后端主快照 schema | **6** | `CANDIDATE-SCOPE.md:13`；本次在归档内源码复核为 `SCHEMA_VERSION = 6`（见 §5.2） |
| 当前工作区后端 schema | **7**（门磁，未发布） | `competition/cloud/backend/src/persistent-store.js:63`；本次实测 |
| APP 包名 / 版本 | `com.example.program_04` / `versionName 1.0.0` / `versionCode 1000000` | 与历史已验收包**版本号完全相同**，不能用版本号区分，**必须用哈希**（`BUILD-MANIFEST.md:16`） |
| backend `package.json` version | `0.1.0`（未随发布递增） | 不能作为发布标识；镜像身份以 **Image ID** 为准（`DEPLOY-RUNBOOK.md v2:66`） |

### 1.3 制品身份（**发布时必须引用本表；不得凭记忆或版本号**）

| 制品 | 路径 | 字节 | SHA-256 | 状态 |
| --- | --- | ---: | --- | --- |
| 候选 HAP（组合 D+E+CAMERA-A） | `competition/evidence/2026-10-26-d-e-candidate-freeze/app/guardian-d-e-candidate-2026-10-26-unsigned.hap` | 2,621,844 | `7634A0E25FCE3E19FC9604E4CD94D6D6BAFF36CB5DE67C92DAEE0E50C1452EB5` | **unsigned / 未安装**；构建输出同哈希归档 |
| 候选源码归档（**唯一允许的 D/E 构建输入**） | `competition/evidence/2026-10-26-d-e-release-prep/d-e-candidate-source-2026-10-26.zip` | 3,954,792 | `F82DA47444785CFB29C254F435DAB40F1569041763BBEEF10D7F5C235A908526` | 188 条目；归档内 `MANIFEST.sha256` 覆盖 187；镜像构建上下文 = 归档内 `competition/cloud/backend` |
| 合同 md | `competition/docs/APP-API-v1.md`（归档内同路径） | 18,068 | `11BFBBE64F658BFBC69A67E03FFDDECFFDF462B56870094EEF34164B066E1538` | 1.2.0 |
| 合同 json | `competition/docs/APP-API-v1.json`（归档内同路径） | 2,984 | `CE12EBB1D7EA222F44A5CABD347DDBFA212F6D5231AFFF068B4D57EB0DA2920B` | 1.2.0 |
| APP 回退目标（最近**已真实验收**包） | `competition/evidence/2026-10-24-app-p0-sensors-local/` 内 P0 包 | 2,086,949 | `9EEBEE9A5FC9EEC5A5993DC6923F16F0BFCCCD1CD4DE64BAF36FC7197ECAD25A` | **不是** `8A722…`（更早包，非默认基线） |

引用：HAP 身份与构建环境 `competition/evidence/2026-10-26-d-e-candidate-freeze/BUILD-MANIFEST.md:10-22`；HAP 内容字节串核验（D/E/CAMERA-A 均在包内）`:43-60`；回退目标与“无任何历史 HAP 对应当前工作树”`:75-85`；源码归档哈希/条目/内容构成 `competition/evidence/2026-10-26-d-e-release-prep/SOURCE-ARCHIVE-MANIFEST.md:6-9、31-37、44-55`；归档可恢复性（解压副本跑通后端 287/287）`:67-83`。

### 1.4 身份判据（发布前必须遵守）

1. **HAP 未签名**：工程 `build-profile.json5` 的 `signingConfigs` 为 `[]`（本次实测，工作区与归档内候选一致），hvigor 告警 `Will skip sign`（`BUILD-MANIFEST.md:20`）。签名后的 HAP **字节会改变**，因此签名件必须**另记整体哈希**，并用归档内 `app/HAP-PAYLOAD-HASHES.txt`（20 条 payload）对照内容，**不能沿用未签名件哈希**。
2. **构建字节级不可复现**：同一源码两次构建 HAP 字节不同，差异仅在 ZIP 条目时间戳；内容 20/20 payload 相同（`BUILD-MANIFEST.md:64-70`）。所以身份以归档文件哈希为准。
3. **镜像身份**：生产主机上以运行容器的 **Image ID** 为准（本地构建镜像无 RepoDigest）；`eldercare-cloud-backend:local` 这个 tag 会被覆盖，回退必须用版本标签（`:pre-d-e-20261026`）+ `docker save` 归档（`DEPLOY-RUNBOOK.md v2:65-88`）。

## 2. 部署目标与形态 + runbook 的真实操作顺序

### 2.1 目标形态（历史记录 + 本次实测的公网面）

- **公网主机**：独立 Linux 服务器（历史推荐 Ubuntu Server 24.04 LTS / Debian 12，最低 1 vCPU / 1 GB / 20 GB），安装 Docker Engine + compose plugin（**不能**用 Docker Desktop）；只放行 80/443（+ 限来源 IP 的 22），云安全组与主机防火墙**两层都收**（`competition/docs/PUBLIC-DEPLOY.md:78-96、203-244`）。
- **公网域名与证书**：`https://api.luxunacc.xyz`；Caddy 自动 ACME 申请/续期 Let's Encrypt 证书；证书/ACME 账户在命名卷里，**禁止 `docker compose down -v`**（`PUBLIC-DEPLOY.md:246-249、292-298`；`competition/deploy/Caddyfile:12-19、34-43`）。
- **compose 单元**（`competition/deploy/compose.public.yaml`）：project `name: eldercare-public`（:36）；`backend` 由 `../cloud/backend` 构建、`image: eldercare-cloud-backend:local`、**只 `expose: "8080"` 不发布主机端口**、挂 `backend-data:/data`、`restart: unless-stopped`、`read_only: true`、healthcheck 走容器内 `/readyz`、`stop_grace_period: 15s`（:39-85）；`caddy` 用 `caddy:2-alpine`、发布 80/443/443-udp、挂 `./Caddyfile:ro` + `caddy-data` + `caddy-config`、`depends_on backend: service_healthy`、`admin off`（:87-115）；卷 `backend-data`/`caddy-data`/`caddy-config`（:121-125）。
- **数据形态**：主快照 `backend-data` 卷内 `/data/backend-state.json`；E 的第二份状态 `/data/activity-state.json`（同卷，默认路径，可用 `BACKEND_ACTIVITY_FILE` 覆盖）；证据文件在 `/data/evidence/`。主快照与活动文件均为 **0600 / 属主 UID 1000（容器内 `node`）**，备份必须 `--user 0` 只读挂载读取（`DEPLOY-RUNBOOK.md v2:90-94`）。
- **变量**：`deploy/.env.deploy`（0600，**本机不存在**，见 §3）注入 7 个必填变量 `PUBLIC_DOMAIN`、`ACME_EMAIL`、`API_TOKEN_SECRET`、`INGEST_KEY`、`APP_GUARDIAN_ID`、`APP_GUARDIAN_PASSWORD`、`CONTACTS_JSON` + 5 个可选微信变量；`compose` 用 `${VAR:?}` fail-closed，缺任何一个都以**变量名**报错拒绝启动（`competition/deploy/.env.deploy.example:29-57`；`PUBLIC-DEPLOY.md:168-172`）。`HOUSEHOLD_TIMEZONE` 默认 `Asia/Shanghai`，**非法值会让后端拒绝启动**，且当前 compose 未显式注入（`DEPLOY-RUNBOOK.md v2:62`）。
- **主机目录布局**（历史建议）：`/opt/eldercare/{compose.public.yaml, Caddyfile, verify/, cloud/backend/, .env.deploy}`（`PUBLIC-DEPLOY.md:232-244`）。D/E 发布**额外需要**：`backup/`、`evidence-of-deploy/`（0700/0600）以及从本仓库取得的回滚工具 `rollback/rollback-transaction.js`（证据目录 `competition/evidence/2026-10-26-d-e-rollback-hardening/rollback/`）。
- **本机无法直达生产**：本机（当前实测）只有本地 Docker Desktop 上下文；`~/.ssh/config` 只有 `dayu200-vm`；`competition/deploy/.env.deploy` 不存在 → **生产主机访问方式（SSH 主机/用户/认证）从未在本机建立**。

### 2.2 操作顺序（权威版本＝`2026-10-26-d-e-rollback-hardening/DEPLOY-RUNBOOK.md`（v2，`:4-5` 明确取代 release-prep 的 v1）；v1 只作历史）

以下为**顺序与判据提炼**，逐字命令见 v2 对应小节；本文不重复粘贴命令。

| # | 阶段 | 关键动作与前提 | 是否中断服务 | 留档产物 |
| --- | --- | --- | --- | --- |
| 0 | 现场只读核验 | 记录当前运行镜像 Image ID、`schemaVersion`、活动文件存在性、设备安装版本（v2:29-45） | 否 | 现场状态记录（更新历史记录） |
| 1 | **先钉住旧镜像**（升级前） | 给正在跑的旧镜像打版本标签 `eldercare-cloud-backend:pre-d-e-20261026` → `docker image inspect` 记 ID → `docker save \| gzip -9`（`.partial` → `gzip -t` → 改名 → `sha256` → 回读 `docker load`）→ compose 覆盖文件钉住 tag；`--no-build` 启动（v2:65-88） | 否 | `evidence-of-deploy/old-image-id.txt`、`backup/image-pre-d-e-20261026.tar.gz(.sha256)` |
| 2 | **维护窗口 + 停后端** | `docker compose … stop backend`（不删卷）；**从这里开始摄取/APP 查询/ACK 轮询全部中断**（v2:96-99） | **是** | — |
| 3 | 备份（停后备份，非运行态 tar） | 从**已停容器**解析 `/data` 真实卷名（必须 `ps -aq`）→ `docker volume inspect` 校验 → `--user 0` 只读挂载整卷 `tar`、**主机重定向**落盘 → `tar tzf` 可读/非空 → `sha256` → preflight 记录 **PRE_TREE_HASH**（v2:96-143） | 否（已停） | `backup/backend-data-<TS>.tgz(.sha256)`、`evidence-of-deploy/data-volume.txt`、`preflight-before-upgrade.json`、`pre-tree-hash.txt` |
| 4 | **备份判定**（全满足才继续，任一失败即中止并按旧镜像启回） | 卷名来自容器且 `volume inspect` 通过；归档可读/非空/哈希已记；`schemaVersion` 与活动文件存在性已留档；备份已限权、未进版本控制/日志/聊天 | — | 判定记录 |
| 5 | 升级 | `docker compose … build --no-cache backend`（构建上下文**必须是 §1.3 归档解出的 `competition/cloud/backend`**）→ 记录 **new-image-id** → `up -d` → `ps`（v2:145-159）。**禁止** `down -v`；不改 Caddy/DNS/端口；**首次成功写入后主快照变 v6，不可逆** | 是 | `evidence-of-deploy/new-image-id.txt` |
| 6 | 部署后验收（**不能用匿名 401 当判据**） | ①运行容器 Image ID == new-image-id ②`/healthz`、`/readyz` 200 ③容器内 `schemaVersion == 6`（首次写入后）④有效会话下 `/api/v1/overview|devices|alerts` 合同一致 ⑤D：`/api/v1/safety-logs?limit=5` → 200 `{logs:[]}`、`/alerts/{id}/dispositions` → 200 ⑥E：`/api/v1/activity/report?scope=day` → 200 且含 `dataSince`(number)/`range`/`summary`/`days[]`/`disclaimer` ⑦有效会话访问不存在路径 → **404**（证路由表正常）（v2:161-183） | 否 | 截图/状态码/字段记录；**Token 不得进命令行/日志/报告** |
| 7 | 回滚（如需要，事务化） | 停后端 → **先留档升级后整卷**（post-upgrade tar + sha256）→ 校验升级前归档 `sha256 -c` → 运行 `rollback/rollback-transaction.js --mode rollback`（必须传 `--expected-pre-tree-hash`/`--expected-post-tree-hash`/`--volume-name`/`--backend-stopped-asserted`）→ 按退出码分支处理（下表） | 是（已停） | `backup/post-upgrade-data-<TS>.tgz(.sha256)`、`evidence-of-deploy/rollback-result.json`、卷内 `.de-rollback/<opId>/` 需导出留档后再清理 |

**回滚退出码分支**（`competition/evidence/2026-10-26-d-e-rollback-hardening/DEPLOY-RUNBOOK.md:262-288`、`ROLLBACK-STATE-MACHINE.md:29-49`、`rollback/USAGE.md:80-99`）：

| RC | 终态 | 数据状态 | 必须做什么 |
| ---: | --- | --- | --- |
| 0 | `COMPLETED` / `PREFLIGHT_OK` | 回滚完成（升级前内容 + 保留的升级后新增项）；preflight 则未改数据 | 仅 COMPLETED 用**钉住的旧镜像** `up -d --no-build` 启动 |
| 10 | `PREFLIGHT_ABORT` | **数据从未被修改**（仍是 v6） | 修前置条件后重试；可先用新镜像启回 |
| 20 | `RECOVERED_TO_V6` | 已自动恢复到升级后原状态并校验 | **保持停止**，排障后重试回滚 |
| 30 | `MANUAL_TAKEOVER_REQUIRED` | 混合/未知，证据已落盘 | **禁止启动后端**；按 `evidence.instructions` 人工接管 |
| 2 | 硬中断 | 可能停在部分落位 | `--mode recover --op-id <id> --expected-original-tree-hash <POST_TREE_HASH> --backend-stopped-asserted` |
| 40 | `INTERNAL_ERROR` | 视阶段 | 不启动；看 `result.error`/`journalWriteFailed` 与卷内 `journal.jsonl`，按 30 流程处理 |

**旧镜像启动失败是独立状态**：`ROLLED_BACK_V5_DATA_RESTORED_OLD_IMAGE_NOT_RUNNING`（数据已回 v5 并校验、旧镜像没起来）→ 不动数据，检查 tag、必要时 `docker load` 归档后重启（v2:279-288）。

**回滚＝回到备份那一刻**：恢复升级前主快照会失去备份之后的**全部主快照变更**——设备状态、新告警、ACK 结果、**D 的处置记录与安全日志**、通知/订阅/交流台账；升级后留档只用于保留与核查；**旧代码读不了 v6，仓库没有 v6→v5 自动合并能力**（v2:290-294；`DEPLOY-READINESS-AND-ROLLBACK.md:92-98`）。E 的活动文件默认**不删除**、移入留档，旧代码忽略它（`ROLLBACK-STATE-MACHINE.md:71-82`、`rollback/USAGE.md:129-134`）。

**回滚工具/状态机的实测层级（不是生产验证）**：文件级 18/18 注入通过（`FILE_LEVEL_HARDENING_VERIFIED`）、Docker 卷级 32/32 通过（`DOCKER_VOLUME_VALIDATION_PASS`，沙箱、非生产主机）、旧镜像 tag→save→load→`--no-build` 固定链路实测、空卷/错卷被拒绝（`competition/evidence/2026-10-26-d-e-rollback-hardening/REPORT.md:108-146`）。**限制**：v5 是机械派生的“等价模拟”，不是历史制品，**不构成旧版兼容验收**；沙箱 ≠ 生产主机卷驱动/权限模型（`ROLLBACK-STATE-MACHINE.md:194-205`）。

**明确禁止**（v2:156-159、`PUBLIC-DEPLOY.md:299-310`）：`docker compose down -v`（会删数据卷与证书卷）、改 Caddyfile/DNS/端口/绑定、把 `:pre-d-e-20261026` 标签重打给新镜像、把 Token 写进命令行/日志/报告、把解析后的密钥 `docker compose config` 重定向到文件/日志。

## 3. 生产发布必须先确认的缺项清单（未关闭不得发布）

| # | 缺项 | 现状（历史 / 本次实测） | 为什么阻塞 | 由谁提供 / 如何核验 |
| --- | --- | --- | --- | --- |
| 1 | **生产主机访问方式** | 历史未建立；本次实测：`competition/deploy/.env.deploy` 不存在、`~/.ssh/config` 仅 `dayu200-vm`、docker context 只有本地 Docker Desktop | 所有 `# 现场执行` 命令（v2 §1/§4/§5/§6/§8）都需要它 | 用户提供 SSH 主机/用户/认证方式说明；**私钥不得贴进文档/聊天/工单**（`PUBLIC-DEPLOY.md:469-483`） |
| 2 | **维护窗口 + 上线范围** | 未授权；历史记录无窗口安排 | §2.2 第 2 步起**中断服务**；且 D/E 共用代码，必须决定 D+E 还是仅 D | 用户明确授权窗口与范围；窗口时长需按现场 build/备份/验收实际耗时确定（**历史无主机端耗时数据**） |
| 3 | **`.env.deploy` 是否本机存在** | **本机不存在**（本次实测 `Test-Path` = False；`competition/deploy/` 只有 `.env.deploy.example` 等模板） | 没有它无法用 `--env-file` 启动；本机也**无法核对生产变量是否齐全/有效**（且不得读取或输出值） | 现场确认主机上 `deploy/.env.deploy` 存在、0600、7 个必填变量齐全且非 `REPLACE_` 占位符；**本清单不索取任何口令/密钥** |
| 4 | **卷名解析方法** | 历史推测 compose 项目 `eldercare-public` → `eldercare-public_backend-data`；本机确有这三个卷，但**生产卷名未核验** | 写死卷名/挂载不存在的卷会让 Docker **自动创建空卷** → “备份成功但内容为空” | 必须现场从**已停容器** `ps -aq` 解析 `/data` 挂载名 + `docker volume inspect` 校验；失败即中止（v2:100-107、:142-143） |
| 5 | **旧镜像取回** | 本机 `eldercare-cloud-backend:local`（ID `3c5f0ca5ab3e`，2026-10-15 构建）**不是生产旧镜像**；生产旧镜像 ID/归档未取得；工作区**不存在**真实历史 v5 后端制品 | 没有钉住的旧镜像就没有回退目标；`down -v`/prune/主机重建会永久失去它 | 现场按 v2:65-88 立即 tag + `docker save` + sha256 + 回读；若已丢失需从生产主机/registry 重新取得 |
| 6 | **数据备份留档位置与空间** | 历史只给“主机 `backup/`、`evidence-of-deploy/` 且 0700/0600”；本机无生产数据；数据卷大小未知 | 备份含个人数据（联系人、坐标、告警、处置）；需限权/加密；copy-aside 回滚要求**卷剩余空间 ≥ 现有数据 + 64 MiB** | 用户指定备份落地位置/留存策略/是否加密；现场记录 `df`/数据大小；**不得把归档贴进聊天/工单/报告** |
| 7 | **真实告警选择 + 有效监护人会话** | 未指定；历史要求“用户指定的既有可操作告警”，是否 ACK 由用户决定，**不得制造 SOS/FALL** | D 的真实验收需要真实 `alarmId`；部署后验收（v2 §7）必须有有效会话 Token | 用户指定 alarmId + 由监护人本人输入口令；Token 只放 0600 文件用 `curl --config` 或环境变量注入（v2:180-183） |
| 8 | **APP 签署口令来源 / 签名材料** | 候选 HAP **unsigned**（`signingConfigs: []`，本次实测工作区与归档一致）；本机无签名材料 | 未签名不能安装；签名后 HAP 字节改变，需另记哈希 | 用户/DevEco 配置 `signingConfigs` 并签名；签名口令/私钥由用户持有，**本流程不持有、不索取**（`DEPLOY-READINESS-AND-ROLLBACK.md:56-58`） |
| 9 | **目标设备** | 历史验收目标是模拟器（Mate 90 Pro 型），实体手机兼容性**未验收**；候选未安装 | 装错设备/不同签名会导致无法覆盖安装或需卸载（**禁止**卸载清数据/改信任链/关签名校验） | 用户指定目标设备（模拟器/实体机）并确认签名身份一致；回退目标 `9EEBEE…`（2,086,949 B） |
| 10 | **`HOUSEHOLD_TIMEZONE` 取值** | 默认 `Asia/Shanghai`；当前 compose **未注入** | 非法值会让后端**拒绝启动**（升级后启动失败会落到“旧镜像启动失败”分支） | 现场确认取值；若需非默认必须在 compose 显式注入并与 `.env.deploy` 同步（v2:62） |
| 11 | **回滚工具上机位置** | 事务脚本在证据目录，未在生产主机 | 回滚步骤需要 `rollback/rollback-transaction.js` 挂载进容器 | 决定上机路径（v2 示例用 `${PWD}/rollback`），并核对脚本哈希后再用 |
| 12 | **E 的真实数据期望** | 生产**从未部署 E**，历史记录“无 `activity-state.json`”；无真实 PIR 样本窗口 | 无自然样本时 E 必须显示“无数据/不足”，**不得用测试数据伪造**；活动文件损坏会让后端 fail-closed | 用户确认可接受的观察周期与“无数据”预期；现场核验活动文件是否存在 |
| 13 | **旧版兼容验收（可选但需明示）** | 工作区**无真实 v5 制品**；沙箱用派生等价模拟 | 不能宣称“旧版本可回退到旧代码并读回数据”已完成 | 若需要：升级前从生产 `docker save` 导出当前镜像作为可信历史制品（`competition/evidence/2026-10-26-d-e-rollback-hardening/REPORT.md:204-210`） |

**缺项未关闭前**：可以继续本机只读核验、准备构建输入（从 §1.3 归档）、准备签名材料；**不得**部署、不得覆盖生产镜像、不得对生产数据做任何写操作。

## 4. 当前工作区**不能**用于 D/E 发布（必须从候选源码归档构建）

### 4.1 边界（本次实测）

- 工作区 `competition/cloud/backend/src/persistent-store.js:63` 为 **`SCHEMA_VERSION = 7`**；工作区另有门磁测试 `test/door-events.test.js`、`test/door-events-api.test.js`。门磁会话记录：schema **v6→v7**、`doorEvents` 入持久化白名单、新增 `GET /api/v1/door-events`、本地 313/313 测试通过，且**明确“后端生产部署（公网）未执行”、未连带部署 D/E/CAMERA-A**（`competition/evidence/2026-10-26-door-contact-closure/report.md:15、52-56、116、206、216`）。
- 因此：**用工作区源码构建的后端镜像会带 schema v7 + 门磁接口，不是 D/E 候选**；发布 D/E 的状态升级点必须是 v5→**v6**，不是 v7。

### 4.2 逐文件漂移（对候选归档 187 条哈希逐条比对，本次实测）

结果：**169 条一致 / 14 条漂移 / 0 条缺失**；14 条漂移**全部可由门磁会话解释**（D/E 业务代码本身未再漂移）：

| 区域 | 文件 | 候选字节 → 当前字节 |
| --- | --- | --- |
| backend src（3） | `src/persistent-store.js` | 67,044 → 72,797 |
| | `src/store.js` | 18,385 → 24,879 |
| | `src/server.js` | 37,008 → 38,151 |
| backend test（1） | `test/safety-log-isolated.integration.js` | 10,053 → 10,053（**同字节数**，仅 schema 断言 6→7） |
| APP src（7） | `core/api/ApiClient.ts` | 18,994 → 20,523 |
| | `core/api/Contracts.ts` | 33,822 → 35,850 |
| | `core/service/Outcomes.ts` | 2,425 → 2,745 |
| | `core/view/Models.ts` | 6,231 → 7,367 |
| | `core/view/ViewMapper.ts` | 29,794 → 31,599 |
| | `pages/DevicePage.ets` | 18,360 → 22,572 |
| | `service/GuardianService.ets` | 57,039 → 61,407 |
| APP tests（3） | `tests/api-client.test.mjs` | 15,768 → 19,264 |
| | `tests/contracts.test.mjs` | 8,992 → 11,712 |
| | `tests/view-mapper.test.mjs` | 16,037 → 17,606 |

→ 当前工作区 `competition/cloud/backend` 与 `APP/ElderlyCareGuardian` 都已偏离 D/E 候选；**用工作区重建 HAP 也会得到不同的包**。

### 4.3 发布构建边界（必须遵守）

1. **后端镜像**：构建上下文必须来自 `d-e-candidate-source-2026-10-26.zip`（`F82DA474…A908526`）解出的 `competition/cloud/backend`；镜像内身份以 **Image ID** 记录。**不得**直接 `docker compose build` 当前工作区。
2. **APP**：安装用的 HAP 必须是冻结候选件（`7634A0E2…452EB5`）经用户签名后的产物；签名件另记哈希并以 `HAP-PAYLOAD-HASHES.txt` 对照 payload。**不得**从当前工作区重新 `assembleHap` 当作 D/E 发布件。
3. **合同一致**：当前工作区 `APP-API-v1.md/.json` 与候选归档**哈希完全一致**（1.2.0），未受门磁改动影响；但注意门磁 v7 的 `/api/v1/door-events` **未写入合同**，将来发布门磁需单独升合同，不影响本次 D/E。
4. **回退基线**：源码回退用 `competition/evidence/2026-10-26-d-e-candidate-freeze/_work/before-after/*.before`（10 文件、改前哈希已校验），且回退后须重跑 `npm run check`、`npm test`、`hvigor test`、`assembleHap`（`DEPLOY-RUNBOOK.md v2:296-300`）；工作区**无 Git**，不能靠 `git checkout`。

## 5. 只读采集：历史事实 vs 当前实测 vs 未知

### 5.1 历史事实（带出处；**不是当前状态**）

| 事实 | 出处 |
| --- | --- |
| 生产合同 **v1.0.0**、主快照 **schema v5**、**无** dispositions/safety-logs/activity 接口、**无** `activity-state.json` | `competition/evidence/2026-10-26-d-e-candidate-freeze/DEPLOY-READINESS-AND-ROLLBACK.md:14-18`、`REPORT.md:235`（均标注为交接记录） |
| 候选冻结状态：`LOCAL_CANDIDATE_FROZEN — NOT_DEPLOYED — NOT_INSTALLED — REAL_ACCEPTANCE_NOT_RUN` | `CANDIDATE-SCOPE.md:47-49` |
| 验证计数：后端 `npm test` 287/287；APP 主机侧 291/291；Hypium 39/39；HAP 构建成功但 `Will skip sign` | `candidate-freeze/REPORT.md:155-181` |
| 本地升级/回滚演练 12 步 + 3 失败保护通过（文件级/进程级）；容器级步骤当时因 Docker daemon 不可用**未验证** | `competition/evidence/2026-10-26-d-e-release-prep/REPORT.md:116-140` |
| 回滚状态机：文件级 18/18、Docker 卷级 32/32（沙箱）；生产主机命令**未执行**；无真实历史 v5 制品 | `competition/evidence/2026-10-26-d-e-rollback-hardening/REPORT.md:108-146、179-210` |
| 该任务开工时本机 Docker server **29.9.2** 可用；`eldercare-public_backend-data`、`eldercare-public_caddy-*` 三卷存在、**0 容器**、全程未触碰 | 同上 `:32-33` |
| 公网健康端点 200、`/api/v1/meta` 401（历史交接记录） | 本次实测复现（见 5.2） |
| 工作区相关目录静默、无并行写入（截至各任务开工） | `candidate-freeze/REPORT.md:22-30`、`release-prep/REPORT.md:22-31` |

### 5.2 当前实测（采集窗：2026-10-26 23:44–23:52 +08:00；命令均为只读）

**A. 本机 Docker 状态**

| 项 | 实测结果 |
| --- | --- |
| `docker info` | `29.9.2 linux overlayfs`（client/server 均 29.9.2；daemon **可用**，exit 0） |
| `docker ps` | **无任何运行中容器**（输出为空） |
| `docker images` | `eldercare-cloud-backend:de-2026-10-26` → `ed481503ff48` 242MB 2026-10-26 23:46:00；`eldercare-cloud-backend:local` → `3c5f0ca5ab3e` 242MB **2026-10-15 00:56:35**；`caddy:2-alpine` / `docker.1ms.run/library/caddy:2-alpine` → `d8542f48d34a`；`node:24-alpine` / `docker.1ms.run/library/node:24-alpine` → `ebfe2f904627`；`hello-world:latest` / `docker.1ms.run/library/hello-world:latest` → `11a3eb1597e8` |
| `docker volume ls` | `eldercare-public_backend-data`、`eldercare-public_caddy-config`、`eldercare-public_caddy-data`（**内容未核对**：核对需运行容器，本次禁止） |
| `docker context ls` | 仅 `default`（npipe）与 `desktop-linux`；**无远程/SSH context** |
| 说明 | `:de-2026-10-26` 是**并行构建会话**在 23:46 产出的镜像（另见 `build/` 与 `_work/app-build/` 的 23:46–23:47 产物）；本基线**未构建、未运行、未验证**它，也不引用其结论。`:local` 为 2026-10-15 本机 P0 期镜像，**不能代表生产旧镜像**，其内部 schema 未知（本任务禁止 `docker run`，无法只读展开） |

**B. 公网 API 可达性（只读 GET，无凭据）**

| 请求 | 结果 |
| --- | --- |
| `GET https://api.luxunacc.xyz/healthz` | **200**（≈0.46 s） |
| `GET https://api.luxunacc.xyz/readyz` | **200**（≈0.36 s） |
| `GET https://api.luxunacc.xyz/api/v1/meta` | **401**（≈0.36 s，需鉴权；无法据此判断版本） |
| DNS | `api.luxunacc.xyz A 47.76.70.118` |
| TLS | Subject `CN=api.luxunacc.xyz`，Issuer `CN=YE1, O=Let's Encrypt, C=US`，NotAfter **2027-01-13 14:41:16**（当前有效） |

**C. 制品身份复核（本次实算，与既有记录一致）**

| 制品 | 实测 | 与记录 |
| --- | --- | --- |
| 候选源码归档 `d-e-candidate-source-2026-10-26.zip` | 3,954,792 B / `F82DA47444785CFB29C254F435DAB40F1569041763BBEEF10D7F5C235A908526` / `tar -tf` **188 条目** | **一致** |
| 候选 HAP `guardian-d-e-candidate-2026-10-26-unsigned.hap` | 2,621,844 B / `7634A0E25FCE3E19FC9604E4CD94D6D6BAFF36CB5DE67C92DAEE0E50C1452EB5` | **一致** |
| 归档内 `candidate/…hap`（经并行会话解压树核读） | 同 `7634A0E2…452EB5` | **一致** |
| 归档内 `competition/cloud/backend/src/persistent-store.js`（解压树） | `11C7E46250F3D96F942F040D8E6BD52DD5BFE9C7D2698DFDF786D8149C467057`（67,044 B，`SCHEMA_VERSION = 6`） | 与 `SOURCE-ARCHIVE-HASHES.txt` 记录**一致** |
| 归档内 `competition/cloud/backend/src/server.js`（解压树） | `A7FAD1E52979A045F844BE390EF6F9892B228AA5D4E4B34A0E8C724A53E65443`（37,008 B）；`:513-515` 为统一 Bearer 鉴权，`:516+` 才是业务路由 | 与记录一致，且**支持 v2 §7.1 的“匿名 401 不是判据”结论** |
| 交接文档 `competition/docs/evidence/2026-10-26-new-chat-handoff.md` | 39,066 B / `EAF3F827586CFCF841C1AB595884C1E792770A8016DB20701F66204166B93955` | **一致** |
| 工作区漂移 | 169 一致 / 14 漂移 / 0 缺失（清单见 §4.2） | — |

**D. 其他本机状态**

| 项 | 实测 |
| --- | --- |
| `competition/deploy/.env.deploy` | **不存在**（仅 `.env.deploy.example`、`compose.public.yaml`、`compose.local-verify.yaml`、`Caddyfile`、`verify/`） |
| `~/.ssh/config` 主机别名 | 仅 `Host dayu200-vm`（无生产主机条目；未读取任何密钥文件） |
| 工作区 `.git` | **不存在** |
| 本机演示链路（**全程只读，未触碰**） | node 进程 9 个；监听：`1883`（broker，PID 41084）、`9101`（bridge，PID 42784）、`127.0.0.1:9001`（PID 27128）。**任何发布动作都不得停止/重启它们** |
| 构建工具链存在性 | `D:\DevEcoStudio\DevEco Studio\tools\hvigor\hvigor\bin\hvigor.js`、`sdk`、`jbr` 均存在；`node v24.19.0` / `npm 11.17.0` |

### 5.3 未知 / 现在无法验证（发布前必须现场关闭）

| 未知项 | 为什么现在无法知道 |
| --- | --- |
| 生产当前镜像 Image ID/Digest、容器与卷名 | 本机无生产访问方式；匿名 HTTP 探测不暴露版本 |
| 生产当前 `schemaVersion` 是否仍为 5、是否已有 `activity-state.json` | 同上；历史记录只是交接时点 |
| 生产当前实际合同版本（是否仍 1.0.0） | `/api/v1/*` 匿名一律 401；不能当判据 |
| 手机/模拟器上实际安装的 APP 版本与哈希 | 未连接设备 |
| 维护窗口、上线范围、签名材料、目标设备、真实告警 | 需用户决定/授权 |
| 备份落地位置、加密与留存策略、主机磁盘/数据量 | 需现场检查 |
| `eldercare-cloud-backend:local`（本机 2026-10-15 镜像）内部 schema | 展开需运行容器，本任务禁止；且它也不是生产旧镜像 |
| 主机端 build/备份/回滚**实际耗时** | 历史无主机端计时数据 |

## 附录 A 引用索引（本文所有引用的路径:行号）

- 候选范围/边界：`competition/evidence/2026-10-26-d-e-candidate-freeze/CANDIDATE-SCOPE.md:11-19、28-33、39-43、47-49`
- 候选验证与剩余阻塞：`competition/evidence/2026-10-26-d-e-candidate-freeze/REPORT.md:37-52、106-129、155-181、235、257-269`
- HAP/构建身份：`competition/evidence/2026-10-26-d-e-candidate-freeze/BUILD-MANIFEST.md:10-22、43-60、64-70、75-85`
- 部署前置/备份/回滚/冒烟（历史）：`competition/evidence/2026-10-26-d-e-candidate-freeze/DEPLOY-READINESS-AND-ROLLBACK.md:14-20、25-44、48-58、62-70、74-98、114-122`
- 源码归档：`competition/evidence/2026-10-26-d-e-release-prep/SOURCE-ARCHIVE-MANIFEST.md:6-10、31-37、44-55、67-83、101-111`；`REPORT.md:42-43、75-86、116-140`
- 权威操作单（v2）：`competition/evidence/2026-10-26-d-e-rollback-hardening/DEPLOY-RUNBOOK.md:4-5、29-45、65-143、145-183、185-294、296-300、317-331`
- 回滚状态机：`competition/evidence/2026-10-26-d-e-rollback-hardening/ROLLBACK-STATE-MACHINE.md:29-49、51-66、71-82、84-91、93-124、143-168、194-205`；工具用法 `rollback/USAGE.md:8-19、21-56、80-99、100-134`
- 回滚实测与限制：`competition/evidence/2026-10-26-d-e-rollback-hardening/REPORT.md:32-33、108-146、179-210`
- 门磁 v7 与“未发布”边界：`competition/evidence/2026-10-26-door-contact-closure/report.md:15、52-56、116、206、216`
- 公网部署形态：`competition/docs/PUBLIC-DEPLOY.md:30-45、78-96、143-172、203-256、282-310、311-334、392-401`
- 部署制品模板：`competition/deploy/compose.public.yaml:36-125`、`competition/deploy/.env.deploy.example:29-57`、`competition/deploy/Caddyfile:12-43、72-87`
- 合同版本：`competition/docs/APP-API-v1.md:3-5`、`competition/docs/APP-API-v1.json:3-7`
- 候选 schema 与鉴权顺序（归档内源码，经解压树只读核对）：`competition/cloud/backend/src/persistent-store.js:62`、`competition/cloud/backend/src/server.js:513-517`

## 附录 B 本文未做（边界声明）

- 未修改任何源码/配置/证据文件；未部署、未 `docker build`/`run`/`stop`、未停止或重启 bridge/broker/public-sync/hdc。
- 未签名、未安装、未卸载、未连接设备或模拟器、未烧录。
- 未访问生产主机、未执行任何生产 docker 命令、未对生产数据卷做任何操作。
- 未读取或输出任何口令、密钥、Token、`INGEST_KEY`、私钥或联系人/坐标等个人数据。
- 未重算大文件内容做二次审计：仅对 2.6 MB HAP 与 3.9 MB 源码归档做了哈希复核（与既有记录比对一致），其余引用既有校验记录。
- 未引用并行构建会话在 `build/`、`_work/app-build/` 下的产物结论（仅记录其存在与时间戳，不视为本基线证据）。
