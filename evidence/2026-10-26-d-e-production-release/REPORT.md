# D/E 正式部署 + 同签名身份 APP 更新 + 真实使用验收 — 交付报告

- 日期：2026-10-27（Asia/Shanghai）
- 工作区：`<WORKSPACE>`；生产 API：`https://api.luxunacc.xyz`
- 证据目录：`competition/evidence/2026-10-26-d-e-production-release/`

## 0. 结论摘要（逐项打勾）

| 项 | 状态 | 说明 |
|---|---|---|
| 后端 D/E 正式部署 | ✅ **已部署** | 生产容器运行 `eldercare-cloud-backend:de-2026-10-26`（Image ID `sha256:568b6193…b42f74`），schema v5→**v6**，`healthz/readyz=200`，Caddy 未动 |
| APP 更新（同签名身份） | ✅ **已安装** | `com.example.program_04` 1.0.0→**1.0.1**（versionCode 1000000→1000001）；`firstInstallTime` 未变、`appSignType=none` 未变（该包本身无签名身份，见 §3） |
| D 真实数据验收 | ✅ **通过** | 真实告警 `e-1793032029-1` + 用户真实处置 2 条；前端展示、后端字段、顺序、重启一致全部核对 |
| E 真实数据验收 | ✅ **通过** | 日/周/月三窗口均打开核对；覆盖不足/无数据如实显示，不伪造 0 活动 |
| 回滚 | ✅ **就绪**（未触发） | 旧镜像 tag + 旧镜像 tgz + 升级前整卷备份 + pin 覆盖文件齐备，含事务化回滚步骤 |
| 待用户操作项 | 1 项 | `docker restart` 后 APP「安全日志」页的**刷新截图**未再采集（后端已验证记录不变） |

**范围严格限定 D/E**：未发布门磁（schema v7）、未发布 CAMERA-A（APP 已剥离证据图片链路）、未发布其他候选；
未重启 bridge/broker/public-sync；未由代理创建 SOS/FALL；未 ACK/reset 任何告警。

## 1. 发布范围与边界

- **D**：告警处置结果 + 持久安全日志（后端 schema **v6**，`safetyLogs` 台账，`GET /api/v1/safety-logs`、`POST/GET /api/v1/alerts/{id}/dispositions`）。
- **E**：PIR 活动日/周/月报告（独立 `activity-state.json`，`version=1`，`GET /api/v1/activity/report?scope=day|week|month`）。
- **合同**：`APP-API-v1` **1.2.0**（D 增处置/安全日志、E 增活动报告，均只增不改）。
- **APP**：D/E-only（去 CAMERA-A 证据图片链路），bundle 与签名状态保持原样。

**硬边界（已遵守）**：
- 构建只使用**已校验归档** `d-e-candidate-source-2026-10-26.zip`（SHA-256 `F82DA474…8526`），不覆盖工作区、不用工作区源码（工作区 backend 已漂移为门磁 schema v7）。
- 不含门磁/CAMERA-A 的发布内容；`CAMERA-A` 在 APP 侧被移除，门磁代码未随发布上生产。

## 2. 制品与身份（SHA-256 见 `SHA256SUMS.txt`）

### 2.1 后端

| 项 | 值 |
|---|---|
| 构建输入 | `d-e-candidate-source-2026-10-26.zip` → 解压 `competition/cloud/backend` |
| 输入归档 SHA-256 | `F82DA47444785CFB29C254F435DAB40F1569041763BBEEF10D7F5C235A908526`（主机侧复核一致） |
| 归档内校验 | `MANIFEST.sha256` 187/187 逐项通过；`SCHEMA_VERSION=6` |
| 生产运行镜像 | `eldercare-cloud-backend:de-2026-10-26` = **`sha256:568b6193b1400c188f6d39d8f3be55397106c743f4eec546fe8f4e1d16b42f74`**（主机构建，2026-10-27T00:09:58+08:00） |
| 本机预演镜像 | `eldercare-cloud-backend:de-2026-10-26` = `sha256:ed481503…fdada0`（与主机 Image ID 不同，因基础层 digest 不同；源码哈希一致） |
| 镜像归档 | `build/eldercare-cloud-backend-de-2026-10-26.tar`（61,751,296 B，`A9CBB12F…E86C62`） |
| 本地镜像级验证 | `build/local-image-smoke-phase1.log` **18/18 PASS**、`phase2.log` **4/4 PASS**（D 幂等/冲突、E 三窗口、restart 持久化、schema v6、activity v1） |

### 2.2 APP

| 项 | 值 |
|---|---|
| HAP | `app/guardian-d-e-only-2026-10-26-unsigned.hap`（2,552,182 B，`95A7D01A…2CD08A4`） |
| bundle / 版本 | `com.example.program_04` / versionCode **1000001**、versionName **1.0.1** |
| 签名 | 无（与已安装包一致；未新建证书、未更换签名身份） |
| 构建隔离 | 仅 `_work/app-build/` 副本；工作区 `<WORKSPACE>\APP` 未被修改 |
| 测试 | 主机 `node --test` **261/261**；Hypium **39/39**；tsc 通过 |
| CAMERA-A 剥离 | 0 新增 / 2 删除 / 11 修改（`app/CAMERA-A-STRIP.md`、`ISOLATION-DIFF.md`） |

## 3. 关于“同签名身份更新”的事实与处理

经核验（`baseline/SIGNING-IDENTITY.md`、`baseline/signing-audit-2026-10-26/`）：

- 设备上已装的 `com.example.program_04`：`appSignType=none`、`signatureKey=""`、`appIdentifier=""` → **该包从来没有签名身份**；
- 历史“已签名” HAP（含 2026-10-24 那个）`hap-sign-tool verify-app` 均 `signature not found`；全库 97 个 HAP 中 0 个属于该 bundle 的签名件；
- 本机不存在 program_04 专属证书/profile；现存 p12/p7b 全部绑定 `com.dsh.eldercare*` + DAYU UDID。

**处理**：保持“无签名”状态做 unsigned 覆盖更新（与 2026-10-21 起所有历史安装方式一致），不新建证书（新建=更换签名身份，且可能要求卸载）、不卸载、不清数据、不改签名校验配置。用户已确认此路径。结果：`firstInstallTime` 不变、`appSignType=none` 不变、版本前进 → 覆盖更新成功且身份未变。

## 4. 发布前核验（只读，实测）

| 项 | 实测 |
|---|---|
| 主机 | 阿里云 ECS（hostname `iZj6ccp283r5405m9eqiv5Z`），项目目录 **`/opt/eldercare/`**，compose 2.40.3 |
| 旧镜像（生产在跑） | `eldercare-cloud-backend:local` = `sha256:85e940478fec…f9f2b03b03f52260c9f5c` |
| 数据卷 | `eldercare-public_backend-data`（从容器解析） |
| 升级前 schema | **5**（devices=8、alerts=62、无 `safetyLogs`） |
| 活动文件 | `ACTIVITY_FILE_ABSENT`（E 从未部署） |
| 环境文件 | `deploy/.env.deploy` 存在，mode 600；`API_TOKEN_SECRET`/`INGEST_KEY` 长度均 64（满足新代码 32–512） |
| 磁盘 | 31 GB 可用 |
| 公网健康（升级前） | healthz/readyz 200 |

## 5. 维护窗口执行（时间线）

| 时间（+08） | 步骤 | 结果 |
|---|---|---|
| 00:07 | Step 1 钉旧镜像：`docker tag … pre-d-e-20261026`；`docker save` 60 MB | `OLD_IMAGE_MATCH_OK`；tgz sha256 `d9cc0d58…db698`，mode 600 |
| 00:09 | Step 2 上传归档（主机侧 sha 一致）→ 主机构建新镜像（`--no-build` 切换前预检 healthz/readyz 200） | 新镜像 `568b6193…` |
| 00:12 | Step 3-A 开窗：`stop backend` → 解析卷 → 记录 pre-schema/activity → **整卷备份** | `backend-data-20261027-001232.tgz`（sha256 `027d27e6…25c48`），`ACTIVITY_FILE_ABSENT` |
| 00:20 | Step 4 切换：`up -d --no-build` + `compose.pin-de.yaml`（钉新镜像） | 容器 Recreated/Started，`HEALTH=healthy`，公网 200 |
| 00:21 | 首次写入后核对 | `schemaVersion=**6**`、`alerts=63→64`、`safetyLogs=0→2`；`activity-state.json` 生成（version=1） |
| 00:27–00:33 | D 验收（用户真实操作：按键、ACK、提交处置） | 2 条真实处置入库 |
| 00:34 | 重启一致性验证：`docker restart eldercare-public-backend-1` | `HEALTH=healthy`、公网 200；`safetyLogs` 逐字段一致 |
| 00:37–00:39 | E 验收（日/周/月三窗口） | 覆盖不足/无数据如实显示 |
| 00:22–00:40 | PC 侧上行观察 | `[cloud-sync] OK … status=202` 持续（kitchen/sos）；`POLL_OK 200` |

> 说明：主机终端是阿里云 Cloud Workbench 会话，期间发生过 2 次会话层掉线（与 docker 无关，无 OOM），因此切换用 `setsid` 脱离会话执行，输出落盘 `evidence-of-deploy/`。

## 6. D 验收结果（通过）

- **真实告警**：`e-1793032029-1`（厨房 `esp32-kitchen` MANUAL_SOS，**用户 00:27:09 按实体 SOS 键**）。另用户 00:33:48 又按一次产生 `e-1793032428-2`（未确认，保持未处理、未 ACK）。
- **处置记录**（用户 APP 操作，服务端生成时间/操作人）：
  - `dsp-1`：00:27:30.080，`CONTACTED_FAMILY`，说明空；
  - `dsp-2`：00:28:17.078，`CONTACTED_FAMILY`，说明“已经电话”。
- **前端**：安全日志页显示 2 条，字段（结果/处理人/房间/设备/时间/说明）与顺序正确（截图 `acceptance/screenshots/02-safety-log-2-records.png`）。
- **后端**：直接读生产 `/data/backend-state.json`：`schemaVersion=6`、`safetyLogs=2`、字段齐全
  （`dispositionId/clientDispositionId/alarmId/deviceId/room/type/outcome/note/actor/serverTime`），`actor=household-guardian`。
- **重启一致**：`docker restart` 后逐字段一致；`PERSIST_DIFF` 仅来自活动文件实时样本增长。
- **独立性**：处置登记不改变告警状态、不生成 ACK 命令；ACK 是用户单独操作（`ACK_SENT id=17`）。

## 7. E 验收结果（通过）

- 后端活动文件：`version=1`、`timezone=Asia/Shanghai`、`dataSince=00:20:51`；kitchen/sos 当日 `samples≈162/173`、`count=0`、`hourly` 多数 `null`。
- APP：日/周/月三窗口均打开（截图 `04/05/06`）：
  - 查询范围随 chip 正确切换；
  - 汇总：今日 0 次、日均 0.0 次/日（与服务端 `count=0` 一致，非伪造）；
  - 覆盖：显示“数据部分覆盖”（仅部署后 1 天有数据）；未覆盖日期/时段显示“无数据”；
  - 趋势：近 7 日中 10/21–10/26 全为“无数据”，10/27 为 0，明确“无数据日不按 0 计算”；
  - 页脚声明“不会用 0 冒充”，隐私：仅计数/覆盖，无影像、无位置轨迹、无个人信息；
  - 三张截图均在 `docker restart` 之后（重启后报告正常、样本继续增长）。

## 8. 回滚预案（就绪，未使用）

- 旧镜像：`eldercare-cloud-backend:pre-d-e-20261026`（`sha256:85e94047…`），归档 `backup/image-pre-d-e-20261026.tar.gz`（`d9cc0d58…`）；
- 升级前数据：`backup/backend-data-20261027-001232.tgz`（`027d27e6…`，含 `backend-state.json` v5 与 `evidence/`）；
- pin 覆盖文件：`deploy/compose.pin-pre-d-e.yaml`；
- 回滚命令：`docker compose --env-file deploy/.env.deploy -f deploy/compose.public.yaml -f deploy/compose.pin-pre-d-e.yaml up -d --no-build backend`；
- **回滚代价（已记录）**：恢复升级前数据会**丢失升级后新增的处置记录与安全日志**（及部署后新增的活动样本）；执行前应先把升级后 `/data` 整卷留档。
- 事务化回滚流程引用：`competition/evidence/2026-10-26-d-e-rollback-hardening/DEPLOY-RUNBOOK.md`（含 RC 状态机）；本次未重做演练。

## 9. 未完成 / 待办（如实标注）

1. **APP 重启后刷新截图未采集**：`docker restart` 后只在后端直接读取验证 `safetyLogs` 不变；APP 安全日志页在重启后的刷新截图未再采集（重启前截图已显示 2 条）。不影响结论，但如需“前端重启后截图”可补一张。
2. **主机侧证据文件未回传**：`/opt/eldercare/evidence-of-deploy/` 中的原始输出（旧镜像 ID、pre/post schema、up 日志、acc-before/after）留在生产主机上；本报告已逐项转录。服务器备份（旧镜像 tgz、数据 tgz）含个人数据，未复制进交付包。
3. **既有问题（与本次无关）**：PC 侧 `esp32-bath` 自 23:41（早于部署）持续 `REJECT code=INVALID_STATUS`，bath 上行中断；该问题在 D/E 部署前已存在，非本次引入，未在本次范围内修改。
4. **用户新产生的未确认告警**：`e-1793032428-2`（用户 00:33:48 按键）保持 `ALARM` 未处理；按要求未 ACK/reset。
5. **APP 保留项**：`Contracts.ts` 的标据 DTO 容错解析、`DeviceCapabilities.ts` 3 行能力文案仍提到“证据”（非功能链路，已记录在 `app/CAMERA-A-STRIP.md §6`）。

## 10. 安全与合规声明

- 证据包内**不含**任何口令、私钥、Token、`INGEST_KEY`、`.env.deploy` 内容或个人敏感数据；备份归档与密钥只留在生产主机受控路径，未进入交付/聊天。
- 未停止/重启 bridge(9101)、broker(1883)、public-sync；未杀进程；未改 Caddy/DNS/端口。
- 未由代理创建生产 SOS/FALL、未自动 ACK/reset；文中的新告警均为**用户真实按键**。
- 本地/HTTP 200 不作为验收依据：D/E 结论基于**真实告警 + 用户操作 + 后端持久化 + 重启一致 + APP 截图**。

## 11. 证据索引

| 文件 | 内容 |
|---|---|
| `baseline/BASELINE-AND-PREREQUISITES.md` | 发布基线、缺项、工作区 v7 边界 |
| `baseline/SIGNING-IDENTITY.md` + `signing-audit-2026-10-26/` | 签名事实（verify-app 日志、设备元数据、全库扫描） |
| `baseline/APP-SIGNING-DECISION.md` | unsigned 覆盖更新决策 |
| `build/image-identity.json`、`docker-build-backend-de.log`、`local-image-smoke-*.log`、`build/smoke-data/` | 镜像身份与本地镜像级验证 |
| `app/` | D/E-only unsigned HAP、剥离/隔离 diff、测试结果 |
| `deploy/PROD-PREFLIGHT-FACTS.md` | 生产只读实测 |
| `deploy/PROD-DEPLOYED-2026-10-27.md`、`deploy/PROD-DEPLOY-LOG.md` | 部署执行与切换后实测 |
| `deploy/DEPLOY-EXECUTION-SHEET.md`、`compose.pin-de.yaml`、`HOST-PREFLIGHT.sh` | 现场执行单与脚本 |
| `acceptance/APP-UPDATE-RECORD.md` | APP 覆盖更新记录（bm dump 前后） |
| `acceptance/D-ACCEPTANCE.md`、`E-ACCEPTANCE.md` | D/E 真实验收详录 |
| `acceptance/screenshots/01–06` | APP 实拍截图（告警记录、安全日志、数据统计入口、日/周/月报告） |
| `deploy/PROD-DEPLOY-LOG.md` | 分步执行与判定（含 PERSIST 对比） |
