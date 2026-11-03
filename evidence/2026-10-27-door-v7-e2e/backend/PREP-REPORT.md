# PREP-REPORT — 门磁 v7 后端候选构建 + 网关 adapter 兼容补丁（本地，不部署）

- 日期/时间：2026-10-27 01:40–02:05（Asia/Shanghai）
- 任务：`task-9`；工作区 `<WORKSPACE>`（无 Git 元数据）
- 状态结论：**`DOOR_V7_BACKEND_CANDIDATE_BUILT` / `ADAPTER_PATCH_VERIFIED` / `NOT_DEPLOYED` / `NOT_FLASHED` / `NOT_ACCEPTED_ON_REAL_HARDWARE`**
- 边界遵守：只在 `competition/evidence/2026-10-27-door-v7-e2e/_work/` 与 `.../backend/` 写；**未修改工作区源码/配置**；**未部署**、未重启 public-sync/bridge/broker、未访问生产主机/设备、未烧录/签名/安装。
- 交付目录：`competition/evidence/2026-10-27-door-v7-e2e/backend/`

## 0. 一句话结论

后端 v7 候选（含门磁 `doorEvents` 台账 + `GET /api/v1/door-events`）已从**隔离副本**构建成镜像 `eldercare-cloud-backend:door-v7-2026-10-27`，全量测试、`v6→v7` 数据兼容、镜像 smoke、网关 adapter 补丁验证全部通过；**但尚未部署、未在真实公网/真实门磁数据上验收**，且 adapter 补丁与 OneNET 物模型的字段扩张风险需在发布顺序中处理（见 §7）。

## 1. 隔离源码副本（构建输入）

| 项 | 值 |
| --- | --- |
| 来源（只读） | `competition/cloud/backend`（工作区，schema v7） |
| 隔离副本 | `_work/backend-src`（47 个文件，`src/`14 模块 + `test/`26 + Dockerfile/package.json/README/.env.example/.dockerignore） |
| 完整性 | 与工作区逐文件 SHA-256 比对 **47/47 一致、0 diff**（复制后本次实算） |
| 工作区是否被改 | **否**。工作区 backend/onenet 最新 mtime 仍为 2026-10-26 21:25:16；`adapter.js` 哈希仍为 `8F03E56F…21B5AF8`，`src/server.js` 仍为 `23B22406…C6E4C9` |
| 测试执行目录 | `_work/full-suite/competition/cloud/backend`（= `backend-src` 的再副本，逐文件哈希一致 0 diff） |

**为什么还需要 `full-suite/` 镜像布局**：后端 3 个测试文件依赖工作区相对路径（`test/app-contract.test.js:8` → `../../../docs/APP-API-v1.json`；`test/backend.test.js:11` → `../../../mobile/wechat-miniprogram/utils/validators`；`test/evidence-pipeline.test.js:12-14` → `../../onenet/{cloud-sync,gateway,adapter}`）。直接在扁平 `_work/backend-src` 跑会缺这些兄弟目录——**这是历史候选归档已记录过的同类问题**。
- 扁平副本原始结果（留档）：`logs/02a-full-suite-raw-copy-missing-relative-deps.log` → 301 tests / 298 pass / **3 fail**（全部 ENOENT/Cannot find module，**不是产品缺陷**）。
- 按镜像布局补齐**只读**依赖（`competition/docs` 2 文件、`mobile/.../validators.js`、`cloud/onenet` 6 模块）后重跑 → 通过（§2）。

## 2. 测试结果（真实运行，非拼接）

| 检查 | 命令（在 `_work/full-suite/competition/cloud/backend`） | 结果 | 日志 |
| --- | --- | --- | --- |
| 语法检查 | `npm run check` | **exit 0**（14 个模块 `node --check`） | `logs/01`、`logs/05` |
| 全量测试 | `node --test` | **313 tests / 313 pass / 0 fail / exit 0**，4.7 s | `logs/02-npm-test-full.log` |
| 门磁定向 | `node --test test/door-events.test.js test/door-events-api.test.js` | **26/26 pass / exit 0** | `logs/03` |
| D/E 隔离集成（含 schema 断言 6→7） | `node --test test/safety-log-isolated.integration.js` | **1/1 pass / exit 0** | `logs/04` |

- 测试通过数与此前门磁会话记录（313/313）**一致**；本次是独立隔离副本上重跑，不是引用旧数字。
- 运行环境：主机 `node v24.19.0` / `npm 11.17.0`；后端无第三方运行时依赖（无 `node_modules` 需求）。

## 3. v6 → v7 主快照兼容验证

- 脚本：`_work/compat/verify-v6-to-v7.js`（只读源码 + `%TEMP%` 之外的交付目录临时副本；**未改任何源码**）
- 输入 v6 快照：`competition/evidence/2026-10-26-d-e-production-release/build/smoke-data/backend-state.json`
  （1,982 B / SHA-256 `70974A3B289A0E13AAC1BB795ADB1D526CC2CC59057EFA5DBEFD42BA249BC4A6`，`schemaVersion=6`、1 设备 / 1 告警 / 1 处置日志 / 无 `doorEvents` 键）
- 结果：**`V6_TO_V7_COMPAT_PASS`，8/8 检查通过，exit 0**（`logs/06`、`evidence/v6-to-v7-compat-result.json`）

| # | 检查 | 结果 |
| --- | --- | --- |
| v0 | v6 源快照结构完整、无 `doorEvents` 键 | PASS |
| v1 | v7 代码可加载 v6 快照（v6 在 `READABLE_SCHEMA_VERSIONS` 内） | PASS（devices=1/alerts=1/safetyLogs=1/doorEvents=0） |
| v2 | 一次成功写入后主快照 `schemaVersion` 6→**7** | PASS（`savedAt` 更新，门磁事件 2 条） |
| v3 | 旧字段逐项保留（设备/告警/处置/联系人逐字节一致） | PASS |
| v4 | 扩展字段落盘为 `doorEvents`（`dr-1`/`dr-2`，seq 101/102，`timeSource=device`，source=`device-cache`） | PASS |
| v5 | 重启（重新构造 `PersistentStore`）后旧数据与 doorEvents 仍在、顺序不变 | PASS |
| v6 | 同一 `door.events` 重传幂等（不重复记账） | PASS（before=2 after=2） |
| v7 | fail-closed：`schemaVersion=8` 被拒绝 | PASS（`persistent store unsupported schemaVersion: 8`） |

- 升级后快照：`evidence/backend-state.from-v6-upgraded-to-v7.json`（SHA-256 `AAE9504E34B652CA689FC521DEB97C69B6B2F7CB84CBF30F813DDCC93DA481B8`）。
- **降级保护（旧代码读 v7 必失败）**：用本机现有 v6 镜像 `eldercare-cloud-backend:de-2026-10-26`（Image ID `sha256:ed481503ff4883e83cd7f485d07768f7a29b69282f67d81439c9d79238fdada0`，镜像内 `SCHEMA_VERSION=6`）只读挂载验证：
  - 对照：v6 旧镜像加载**原始 v6 快照** → 正常（devices=1 alerts=1）；
  - 保护：v6 旧镜像加载**升级后的 v7 快照** → 拒绝：`persistent store corrupt: unknown top-level field doorEvents`。
  - 日志：`logs/07-v6-image-downgrade-guard.log`。
  - ⚠️ **身份不一致风险见 §7.1**：任务描述称生产镜像为 `sha256:568b6193…`，本机 `de-2026-10-26` 实际是 `sha256:ed481503…`。本验证只证明“本地这份 v6 代码拒收 v7 快照”，**不等于**已核对生产镜像身份。

## 4. 镜像构建与制品身份

| 项 | 值 |
| --- | --- |
| 构建上下文 | `_work/backend-src`（= 工作区 backend 的隔离副本；Dockerfile 只 `COPY package.json` 与 `src`，**不含 test/**） |
| 基础镜像 | `node:24-alpine`（本机已有，镜像内 Node **v24.21.0**） |
| 构建命令 | `docker build -t eldercare-cloud-backend:door-v7-2026-10-27 ./backend-src` → **exit 0，2.4 s**（`logs/08-docker-build.log`） |
| 镜像 tag | `eldercare-cloud-backend:door-v7-2026-10-27`（本地，**未 push**） |
| **Image ID** | **`sha256:5a02edcfaa42db6360068ceb6b09b9c0fa53a9128caa698a0e73521a3813ccb9`** |
| RepoDigest | `eldercare-cloud-backend@sha256:5a02edcfaa42db6360068ceb6b09b9c0fa53a9128caa698a0e73521a3813ccb9`（本地镜像无 registry digest，以 Image ID 为准） |
| 大小 | **241,955,096 B**（约 242 MB） |
| 创建时间 | 2026-10-26T17:44:52Z（= 2026-10-27 01:44:52 +08） |
| 镜像内 schemaVersion | **7**（容器内 `require('/app/src/persistent-store.js').SCHEMA_VERSION` 实测） |
| `docker save` tar | `backend/image/eldercare-cloud-backend-door-v7-2026-10-27.tar`（`_work/build/` 同名副本） |
| tar 字节数 | **61,754,880 B** |
| tar SHA-256 | **`79F6586F58428779CB090060F8762F5BFBF18D7F683DB276F6163601D55578CE`** |
| 日志 | `logs/09-image-identity-and-save.log` |

> 可复现性：镜像内容由 `backend-src` 源码决定，但 Docker 构建 digest 会因构建时间/层缓存而不同；**部署身份必须记录 Image ID，不能只记 tag**。

## 5. 本地临时卷 smoke（镜像可用性）

- 脚本：`_work/smoke/smoke-door-v7.ps1`（Windows PowerShell；ASCII-only；临时容器 + 临时命名卷，**只用 127.0.0.1:18087**，结束时删除）
- 结果：**`SMOKE_PASS`，21/21 通过，exit 0**（`logs/10-smoke.log`、`evidence/smoke-result.json`）

| # | 检查 | 结果 |
| --- | --- | --- |
| 1 | 镜像身份解析 | PASS（Image ID 同 §4） |
| 2 | 临时命名卷创建 | PASS（`de-door-v7-smoke-*`） |
| 3 | 容器启动 | PASS（一次性 `--env-file`，随机合成凭据） |
| 4-5 | `/healthz` 200、`/readyz` 200 | PASS |
| 6 | 匿名 `/api/v1/overview` → 401 | PASS |
| 7 | 匿名 `/api/v1/door-events` → **401**（门磁 API 需鉴权） | PASS |
| 8 | 匿名 `/internal/v1/device-status`（无 `x-ingest-key`）→ 401 | PASS |
| 9 | 错误监护人口令 → 401 | PASS |
| 10 | 正确会话登录 → 200 `Bearer`（合成账号，Token 只写临时 curl config 文件、不打印） | PASS |
| 11 | 有效会话 `GET /api/v1/door-events` → 200 `{events:[]}` | PASS |
| 12 | 扩展格式摄取（v7 门磁字段、**合成设备、无告警**）→ **202** | PASS |
| 13 | `GET /api/v1/door-events?deviceId=…` → 2 条（最新在前：seq **102,101**；`timeSource=device`；`dr-2,dr-1`） | PASS |
| 14 | **旧格式** v6 两键门磁摄取 → **202**（旧格式仍被接受） | PASS |
| 15 | 旧格式触发的服务端兜底事件（`seq=0`、`source=state-change`）被记账 | PASS（3 条） |
| 16 | 容器内快照 → `schemaVersion=7` | PASS |
| 17 | `/data` 含 `backend-state.json` | PASS（另有 `evidence/`） |
| 18 | 容器日志无本次随机密钥/口令/Token | PASS（0 命中） |
| 19-21 | 临时容器/卷删除、无残留、`eldercare-public_*` 三卷仍在 | PASS |

> smoke 数据全部为合成设备（`esp32-smoke` / `smoke-room`）与合成凭据，**未制造真实 SOS/FALL、未使用真实家庭数据**；测试结束临时资源全部删除。

## 6. 网关 adapter 兼容补丁（`adapter-door-v7.patch`）

- 补丁文件：`backend/adapter-door-v7.patch`（2,881 B / SHA-256 `162467457680C0B260FA7F1667498DC495B9A4A1121D774416B0397978B55A45`，unified diff，2 hunk，`-p1`，路径 `a/competition/cloud/onenet/adapter.js` → `b/...`）
- 目标文件：`competition/cloud/onenet/adapter.js`（工作区原文件 SHA-256 `8F03E56F7AA02BAC8A9B43C29A8873296AC2C1958C44E76BDE2CB69AC21B5AF8`；**未修改**，仅交付补丁）
- 修改点（**最小**，2 个 hunk，仅 `normalizeDoor` 与 1 个常量）：
  1. 新增常量 `MAX_DOOR_EVENTS = 16`（固件 FIFO 默认 8，留一倍余量并防无界数组）；
  2. `normalizeDoor` 白名单从 `['open','lastOpenTs']` 扩为 `['open','lastOpenTs','lastCloseTs','seq','events']`，**required 仍为 `open,lastOpenTs`**（旧格式行为完全不变）；
     - `open`：boolean 或 **null**（null = 基线未知，不得默认成关闭）；
     - `lastOpenTs` / `lastCloseTs`：0 或 13 位毫秒整数；
     - `seq`：正整数（`1..Number.MAX_SAFE_INTEGER`）；
     - `events`：数组（≤16 项），元素必须**精确** `{seq,open,ts}`，`seq` 正整数、`open` boolean、`ts` 0 或 13 位毫秒；
     - 未知字段、类型不符、10 位秒时间戳、`events` 元素缺键/多键**全部继续拒绝**。
- 应用到工作区的推荐方式（补丁产物已验证）：
  ```powershell
  # 在 <WORKSPACE> 根目录；本机 git core.autocrlf 为 true，必须显式关闭以保留 LF
  git -c core.autocrlf=false apply --check competition\evidence\2026-10-27-door-v7-e2e\backend\adapter-door-v7.patch
  git -c core.autocrlf=false apply       competition\evidence\2026-10-27-door-v7-e2e\backend\adapter-door-v7.patch
  ```
  （若不用 git：`patch -p1 < adapter-door-v7.patch`，或用 `git apply -R` 反向回滚。）
- **补丁有效性实测**：在原始文件副本上 `git -c core.autocrlf=false apply --check` → exit 0；应用后文件 SHA-256 = **`9453A47DBEBA0E096F625AEAD134550E4EA08997FE1F117269499E0DE5CA64E5`**，与补丁目标产物**逐字节一致**（`logs/13-patch-apply-verify.log`）。

### 6.1 adapter 补丁验证（25/25 PASS，exit 0）

- 脚本：`_work/onenet-adapter/verify-adapter-door-v7.js`；日志 `logs/11-adapter-door-v7-verify.log`；结果 `evidence/adapter-verification-result.json`
- 关键用例：
  - **旧格式仍通过且输出键不变**：`{open,lastOpenTs}` → `door` 输出仍恰好 `open,lastOpenTs` 两键（A1/A2）；
  - **扩展格式通过且字段逐项透传**（不默认、不强制转换）：B1–B4；
  - **链路串联**：adapter `toPropertyPost` 输出 → gateway 重建 `sensors.door`（§gateway.js `normalizeIncoming` 做法）→ `cloud-sync.buildIngestPayload`，扩展字段仍保留；旧格式串联结果不变（C1/C2）；
  - **非法仍拒**（E1–E15）：未知字段、`open` 字符串、缺 `open`、10 位秒时间戳、`seq=0/-1/1.5`、`events` 非数组、元素未知键/缺键/`seq` 非法/`open:null`/`ts` 10 位、events 超 16；
  - **原文件确实拒收扩展格式**（F1/F2）：`door contains unknown field: lastCloseTs`、`door.open must be a boolean` → 证明补丁必要。
- **既有测试回归**：把工作区 onenet 的现有单测（adapter / gateway / transport / token / cloud-sync / command-sync / success-log / device-ts-chain）与**补丁后 adapter** 一起在隔离目录跑：**141/141 pass / 0 fail / exit 0**（`logs/12-adapter-regression-tests.log`）。

## 7. 风险与未完成项（发布前必须处理）

### 7.1 生产镜像身份与任务描述不一致（需现场核实）

- 任务描述：生产后端为 `eldercare-cloud-backend:de-2026-10-26`，Image ID `sha256:568b6193…`。
- 本机实测：同 tag 的 Image ID 为 **`sha256:ed481503ff48…fdada0`**（创建于 2026-10-26T15:46Z）。
- 结论：本机这份 v6 镜像**可能**不是生产正在跑的那一份（可能被重建/不同构建机）。**部署前必须以生产容器实际 `.Image` 为准**，不能把本机 ID 当生产身份；本报告的 v6 降级验证只代表本地该镜像。

### 7.2 adapter 补丁会扩大 **OneNET 物模型**收到的 `door` 结构（重点）

- 现状：`competition/cloud/onenet/thing-model.json:59-69` 的 `door` struct **只定义 `open`、`lastOpenTs`**。
- 补丁后：`toPropertyPost` 会把 `lastCloseTs/seq/events/open:null` 一并放进 property params，`transport.js` 用它发布到 OneNET。**若 OneNET 侧严格按物模型校验，扩展 struct 子字段可能被拒/忽略**。
- 建议（未执行，需另行决定）：在 OneNET 侧同步扩展 `door` struct（`lastCloseTs` long、`seq` int、`events` array/struct），或把“上 OneNET 的 door”与“给可信后端的 door”分离（需要 gateway/transport 改动，超出本任务最小补丁范围）。
- 缓解现状：固件当前默认 **关闭** 扩展字段上报（`CONFIG_NODE_DOOR_UPLINK_EXTENDED=n`，见 `competition/evidence/2026-10-27-voice-led-restore/BATH-FLASH-RECORD.md:28`），所以补丁上线但固件不打开时，OneNET 载荷仍为旧两键。

### 7.3 发布顺序（三件事必须同批协调）

依据现场证据（`competition/evidence/2026-10-27-voice-led-restore/audit/bath-audit.md:66`）与本次结果：
1. **PC 侧**：应用 adapter 补丁 + 重启常驻网关/public-sync（**本任务未重启**，需维护窗口）；
2. **后端**：部署 v7 镜像（v6→v7 快照不可逆；回滚须恢复升级前快照）；
3. **固件**：打开扩展字段开关并重建/烧录（**本任务未烧录**）。
- 若先开固件扩展而后端仍 v6：旧后端会拒收/忽略 `door.events`（无门磁事件台账），扩展数据白报；若后端 v7 已上但 adapter 未打补丁：网关会 `INVALID_STATUS` 整条拒收。**顺序建议 1→2→3**。

### 7.4 其他未验证/限制

- smoke 为**合成数据**单机容器验证，不等于公网真实链路；未验证真实 OneNET 通道、真实 `public-sync` 进程加载补丁后的行为（未重启）。
- 未做多实例/并发、未做长时运行、未做镜像安全扫描；镜像基于本机已有 `node:24-alpine`（本地镜像源，生产应从可信来源复核 digest）。
- 未签名/未安装 APP、未改固件、未访问生产设备；本任务不涉及。
- 补丁只改 `adapter.js` 的 `normalizeDoor`，**未改**后端源码、未改合同文档（v7 的 `/api/v1/door-events` 尚未写入 `docs/APP-API-v1.*`，属门磁会话遗留，另行处理）。

## 8. 交付物索引

| 文件 | 说明 |
| --- | --- |
| `PREP-REPORT.md` | 本报告 |
| `adapter-door-v7.patch` | 网关 adapter 最小扩容补丁（2 hunk，SHA-256 见 `SHA256SUMS.txt`） |
| `image/eldercare-cloud-backend-door-v7-2026-10-27.tar` | `docker save` 镜像归档（61,754,880 B / `79F6586F…78CE`） |
| `logs/01..12` | 上述全部命令的原始日志（含一份扁平副本预期失败日志 `02a`） |
| `evidence/v6-to-v7-compat-result.json`、`v6-source-profile.json` | v6→v7 兼容验证结构化结果 |
| `evidence/backend-state.from-v6-upgraded-to-v7.json` | 升级后快照样例（合成写入；含真实验收快照的旧字段） |
| `evidence/backend-state.future-v8-rejected.json` | fail-closed 用例（不加载） |
| `evidence/smoke-result.json` | 21 项 smoke 结构化结果 |
| `evidence/adapter-verification-result.json` | adapter 25 项验证结构化结果 |
| `SHA256SUMS.txt` | 本目录交付物逐文件 SHA-256 |

**可复现脚本（在 `_work/`，不随本目录复制）**：`compat/verify-v6-to-v7.js`、`smoke/smoke-door-v7.ps1`、`onenet-adapter/verify-adapter-door-v7.js`、`onenet-adapter/regression/`。

## 9. 明确没有做的事（边界声明）

- 未部署、未 `docker push`、未 `docker compose up`、未改生产/演示容器与卷；
- 未重启 public-sync / bridge / broker / hdc，未触碰现有演示链路；
- 未修改工作区任何源码/配置（补丁只作为文件交付）；
- 未烧录固件、未连接设备、未签名/安装 HAP、未产生真实告警/SOS/FALL；
- 未读取或输出任何生产口令、密钥、Token、`INGEST_KEY`；smoke 凭据为进程内随机生成并随后删除。
