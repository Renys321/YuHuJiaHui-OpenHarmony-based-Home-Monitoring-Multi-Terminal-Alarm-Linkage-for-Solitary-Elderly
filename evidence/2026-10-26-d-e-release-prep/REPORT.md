# REPORT — D-E-RELEASE-PREP（完整候选归档、部署说明纠错、本地升级/回滚演练）

- 日期：2026-10-26（Asia/Shanghai）
- 工作区：`<WORKSPACE>`（无 Git 元数据；不依赖 `git` 恢复）
- 交付目录：`competition/evidence/2026-10-26-d-e-release-prep/`
- 上游：`competition/evidence/2026-10-26-d-e-candidate-freeze/`（D/E 本地冻结候选）

## 0. 结论

```text
D-E-RELEASE-PREP：完成
  候选归档        完成并通过解压核验（解压副本可跑后端全量 287/287）
  部署/回滚操作单  已按 8 项要求纠正（旧文档保持原貌，未修改）
  本地升级/回滚演练 真实执行通过（12 步 + 3 个失败保护）
  容器级步骤       未验证（本机 Docker daemon 不可用）
  真实旧版兼容验收  无法进行（工作区无真实 v5 后端制品），未宣称完成

候选状态不变：LOCAL_CANDIDATE_FROZEN — NOT_DEPLOYED — NOT_INSTALLED — REAL_ACCEPTANCE_NOT_RUN
本任务未部署、未安装、未签名、未连接设备、未访问公网生产主机。
```

## 1. 基线核对（先读后做，只报与本任务相关的变化）

| 核对项 | 结果 |
| --- | --- |
| `competition/docs/evidence/2026-10-26-new-chat-handoff.md` | 39,066 B / `EAF3F827586CFCF841C1AB595884C1E792770A8016DB20701F66204166B93955`，与 `.sha256.txt` 回执**一致** |
| 冻结交付 `2026-10-26-d-e-candidate-freeze/SHA256SUMS.txt`（81 条） | **81/81 全部匹配**当前文件 |
| 冻结交付 `SOURCE-HASHES.txt`（136 条源码） | **136/136 全部匹配**当前工作区 |
| 冻结候选 HAP | 2,621,844 B / `7634A0E25FCE3E19FC9604E4CD94D6D6BAFF36CB5DE67C92DAEE0E50C1452EB5`，**未修改**（mtime 仍是 12:43:25） |
| 冻结报告之后是否有更新的报告或并行修改 | **没有**。以冻结 `SHA256SUMS.txt` 的生成时刻（12:48:30）为界，`<WORKSPACE>` 下无更新的产品/证据文件写入；开工前后各复核一次哈希，均未漂移 |
| 本任务开工前的环境事实 | 相关目录静默；进程表只有本会话 node；无并行会话写共享文件 |

**与本任务相关的唯一“变化”是能力/环境层面，不是文件漂移**：
本机 `docker` **client 29.9.2 存在，但 daemon 不可用**（`docker info` 退出码 1，`images/ps/volume ls` 无结果）。
这直接决定了“容器级步骤只能文档推演、不能宣称验证”。

## 2. 交付物

| 文件 | 内容 |
| --- | --- |
| `REPORT.md` | 本文件 |
| `d-e-candidate-source-2026-10-26.zip` | **完整候选源码归档**，3,954,792 B / `F82DA474…A908526`，188 条目 |
| `SOURCE-ARCHIVE-MANIFEST.md` | 归档构成、关键哈希、核验结果、未归档项、已知缺口 |
| `SOURCE-ARCHIVE-HASHES.txt` | 187 个归档文件的逐文件 SHA-256 + 字节数 + 来源（机读） |
| `DEPLOY-RUNBOOK.md` | 纠正后的部署/回滚操作单（8 项纠正 + 前置条件 + 检查清单） |
| `ROLLBACK-REHEARSAL.md` | 本地隔离升级/回滚/失败保护演练结果（真实执行） |
| `rehearsal/rehearse_upgrade_rollback.js` | 可复现的演练脚本 |
| `rehearsal/rehearsal-result.json`、`rehearsal-console.log` | 结构化结果与原始输出 |
| `rehearsal/legacy-v5-emulation/` | **明确标注**的 v5 等价模拟（派生自冻结树，含 diff 与边界说明） |
| `_work/` | 构建/核验/演练辅助脚本与机器可读结果（`archive-build.json`、`archive-verify.json`、`extracted-backend-test.log`） |
| `SHA256SUMS.txt` | 本次交付物校验清单 |

## 3. 完整候选归档

### 3.1 做法

- **输入就是当前工作区**：开工时已用冻结清单验证 136/136、81/81 匹配，所以归档 = 冻结候选，不需要从旧证据拼装。
- **镜像工作区布局**（`APP/` + `competition/`）。原因：冻结测试里有 3 个文件依赖相对路径
  （`../../../docs/APP-API-v1.json`、`../../../mobile/wechat-miniprogram/utils/validators`、
  `../../onenet/{cloud-sync,gateway,adapter}`）。第一版用扁平布局，解压后这 3 个测试直接失败
  （275/287，3 fail），据此改为镜像布局 —— 这是“实际解压核验”发现的真实问题，不是纸面设计。
- 归档包含：后端 `src/`（14）+ `test/`（26）+ `Dockerfile`/`package.json`/`.env.example`/`README`；
  APP `AppScope/`、`entry/src/main/**`（ArkTS + `resources/` + `module.json5`）、`entry/src/test/**`、
  `tests/**`、根与模块级构建配置、`oh-package.json5` + `oh-package-lock.json5`、`hvigor/` 配置；
  冻结合同 `APP-API-v1.md`/`.json`；部署模板（compose/Caddyfile/`.env.deploy.example`/`verify/`）；
  候选 HAP **逐字节副本**；以及 `VERSIONS.json`（Node 24.19.0 / DevEco / Hvigor / ohpm 26.0.0.630 / SDK
  26.0.0.105 与实际构建命令）。
- **排除**：`oh_modules`/`node_modules`、`build`/`.hvigor`/`entry/.test`/`tests/build`、`.idea`/`preview`、
  历史本地备份目录、`local.properties`（改为 `local.properties.example` 模板）、真实 `.env`、签名材料、
  运行期数据、私有固件/全片备份。
- **两道自动保护**：敏感信息扫描（183 文件；`*.example` 的明显占位符放行，其余中止）；
  冻结 HAP 哈希校验（不等于 `7634A0E2…` 就中止）。
- **确定性 ZIP**：条目排序 + 固定时间戳。**内容**可复现（逐文件哈希一致），但**归档字节依赖构建工具链**：本归档 = Python 3.14.8 / zlib 1.3.1.zlib-ng；独立复核者用 Python 3.12.14 / zlib 1.3.2 从同内容重建得到不同归档字节（3,937,459 B / `7BC2BBCA…`），但 187/187 逐文件哈希相同。

### 3.2 核验结果（`_work/archive-verify.json`，11/11 PASS）

| 检查 | 结果 |
| --- | --- |
| ZIP 完整性、188 条目、无路径穿越 | PASS |
| 归档内 `MANIFEST.sha256` 逐文件校验（187 条） | PASS（0 缺失 / 0 错配） |
| 无清单外文件 | PASS |
| 候选 HAP 逐字节一致 | PASS |
| 必要构建输入齐全（37 项清单） | PASS |
| 无依赖缓存/构建产物/真实 `.env`/签名材料/固件备份 | PASS |
| 解压副本 14 个后端模块 `node --check` | PASS |
| **从解压副本运行 `npm test`** | **PASS：287 / 287 pass / 0 fail / exit 0** |

### 3.3 缺口（已在 manifest §7 逐条列出）

| 缺口 | 说明 |
| --- | --- |
| 后端无 `package-lock.json` | `package.json` 无第三方依赖，锁文件不存在是事实而非遗漏 |
| APP 无 `hvigorw`/`hvigor-wrapper.js` | 构建必须用 DevEco 自带 `hvigor.js`（版本/路径见 `VERSIONS.json`） |
| APP 依赖未归档 | 恢复时需 `ohpm` 安装 `@ohos/hypium 1.0.25`、`@ohos/hamock 1.0.0`；本任务**未执行安装**以免改写现有工程 |
| 未重建 HAP | 本任务禁止改业务源码；用哈希证明候选副本一致，不需要重建 |
| 归档不含数据卷 | 源码归档 ≠ 数据备份；数据备份见 `DEPLOY-RUNBOOK.md` §5 |

## 4. 部署与回滚操作单纠正（8 项）

旧文档 `2026-10-26-alert-disposition-safety-log/DEPLOY-DIFF-AND-ROLLBACK.md` **保持原貌未改**；
新操作单 `DEPLOY-RUNBOOK.md` 以“替代现场事实/判据/回滚命令三部分”的方式给出替代版本。

| # | 要求 | 新操作单的处理 |
| --- | --- | --- |
| 1 | 生产现状不得写成当前事实 | §1 全部降级为“交接历史记录 / 部署前待核验项”，并给出只读核验命令 |
| 2 | 删除“匿名 401 vs 旧版 404”判据 | §7.1 用源码证明鉴权在业务路由之前（`server.js:513-515` 早于 `:517+` 的 `/api/v1/*` 路由），所以匿名访问任何路径都是 401；改为“制品身份 + 有效会话响应 + 字段合同”，并禁止 Token 进命令行/历史/日志 |
| 3 | 镜像固定不能只记 ID 再 `up -d` | §4 改为：给旧镜像打**版本标签** → `docker image inspect` 记录 ID → `docker save` + sha256 留档 → compose **覆盖文件钉住 tag** + 启动用 `--no-build`；并说明为何 `up -d` 在 `build:` 存在时有重建风险 |
| 4 | 运行态 tar 不等于一致快照 | §5 明确该结论，改为**维护窗口内先 `stop backend`（标注会中断服务）再只读挂载卷打包**，并给出可读性/哈希/`schemaVersion`/活动文件存在性的留档与“任一失败即停止升级”的判定 |
| 5 | 回滚要先完整保留升级后数据；失败即中止；不删活动数据 | §8.2：先导出升级后整卷 → 校验升级前归档 → 解到 staging → **移走（不删）**现有文件到 `_rollback-archive-<TS>/` → `cp -a` 落位 → 复核；§8.3 给出中止后的恢复路径；§8.4 明确活动文件默认保留 |
| 6 | 说清恢复旧快照会丢什么 | §8.5 列出：设备状态、新告警、ACK、**D 的处置/安全日志**、通知/订阅/交流台账全部回到备份时点；升级后留档只用于保留与核查；**旧代码读不了 v6**；**没有自动合并能力** |
| 7 | 本地源码回退不得整文件覆盖 | §9：先核对当前哈希 → 查并行改动 → 用 `before-after/*.before`（10 文件，改前哈希已校验）逐字节还原 → 重跑 check/test/HAP 构建 |
| 8 | APP 回退前提 | §10：同签名、目标设备（历史验收是模拟器，实体机未验收）、数据保留；禁止卸载清数据/改信任链/关签名校验；回退目标 `9EEBEE…` 而非 `8A722…`；版本号相同故必须用哈希区分 |

此外还补了：§11 明确“哪些层级未验证、Docker 可用后怎么补验”、§12 现场检查清单、§2 制品身份（镜像 Digest / HAP 哈希 / 合同版本）。

## 5. 本地隔离升级 / 回滚演练（真实执行）

- 脚本：`rehearsal/rehearse_upgrade_rollback.js`；结果：**`REHEARSAL_PASS`，12 步 + 3 个失败保护全部通过，exit 0**
- 隔离：全程 `%TEMP%` 临时目录 + `127.0.0.1` 随机端口 + 进程内随机凭据；合成数据全部带
  `rehearsal-fixture-*` / `rehearsal-alarm-*` / `合成演练-*` 标记；**不读任何生产/演示数据文件**
- 关键结果：
  - v5 合成数据 → 候选加载成功 → 一次写入后主快照 `schemaVersion = 6`
  - 加 3 条处置（`dsp-1..3`，`actor=household-guardian`）与活动记录（`version=1`，当日计数 5），重新加载一致
  - 升级后整卷留档 → 按操作单回滚 → **恢复后树哈希与升级前完全相同**：
    `A3975FF7…9AB9EE2`（升级前） = `A3975FF7…9AB9EE2`（恢复后）
  - 旧边界代码能在恢复后的数据上**启动 HTTP 服务**并返回 2 条合成告警（200）
  - 旧边界代码**拒绝 v6 快照**：`persistent store unsupported schemaVersion: 6`
  - 3 个失败保护（备份被篡改 / 校验元数据不匹配 / 升级后留档缺失）全部**中止在移动运行数据之前**，
    运行数据树哈希前后不变
- 边界（重要）：演练使用的“旧版”是**从冻结树机械派生的 v5 等价模拟**（只改 `persistent-store.js` 3 处，
  `+3/−4` 行），**不是历史制品**。因此**不构成旧版兼容验收**，也不能用于合同时代差异验收。

## 6. 证据分级（不要混用）

| 等级 | 本任务内容 |
| --- | --- |
| **本次运行验证** | 归档构建与解压核验；解压副本后端 **287/287**；隔离演练 12 步 + 3 失败保护；冻结基线 81/81、136/136；HAP 未变 |
| **仅文档推演** | `DEPLOY-RUNBOOK.md` §4/§5/§8 的 **Docker/容器级**命令（daemon 不可用）；公网主机卷名与命令的具体形态 |
| **现场未知** | 公网主机当前镜像/Digest、数据卷内容与 schema、活动文件是否存在、设备实际安装版本、证书与 DNS 状态、时间窗安排 |
| **后续需用户授权** | 部署、签名、安装、维护窗口、真实告警选择、真实 PIR 数据积累、真实旧版镜像取回 |

## 7. 未验证层级与剩余阻塞

1. **容器级步骤未验证**：`docker` client 有、daemon 不可用。按任务要求**未安装 Docker、未启动现有演示服务**。
   补救路径见 `DEPLOY-RUNBOOK.md` §11（独立项目名 + 临时卷 + 回环端口）。
2. **真实旧版兼容无法验证**：工作区无真实 v5 后端制品（已穷举：全盘只有 1 份 `persistent-store.js`=v6；
   所有 zip 里只有 D 的 v6 快照；P0 归档不含 backend）。恢复该能力需要从生产主机取回旧镜像或历史源码。
3. **现场一切未知**：本任务未做任何现场只读检查，因此生产状态只能按“待核验”处理。
4. **真机/签名/安装未做**：无签名材料、未连接设备。
5. **回滚后的数据回填不存在**：从 v6 留档人工抽取 `safetyLogs` 等属另行开发，本次未实现，未宣称具备。

## 8. 本任务明确未做（对照禁止项）

- 未连接公网生产主机/生产 API/生产数据卷/设备；未 `docker` 打到生产；未访问 `api.luxunacc.xyz`。
- 未部署、未安装、未签名、未烧录、未重启或停止现有演示服务。
- 未修改 D/E/CAMERA-A 业务源码、冻结制品或旧证据文件（旧部署文档保持原貌）。
- 未制造生产 SOS/FALL、未操作既有告警、未发生产 ingest/ACK/reset。
- 未恢复 `LOCAL-ALARM-VOICE-CLOSURE`。
- 未输出密钥/Token/Wi-Fi 口令/签名口令/私钥；未把真实家庭数据放进交付。
- 未假定工作区有 Git；未覆盖并行会话改动（开工时已确认无并行写入）。
- 未安装依赖改写工程（归档排除 `oh_modules`，APP 依赖由恢复方自行安装）。

## 9. 下一步需要的明确授权/条件

1. **授权维护窗口**并确认 D/E 上线范围（本候选镜像天然同含 D+E）。
2. **现场只读核验**：按 `DEPLOY-RUNBOOK.md` §1 采集当前镜像 Digest、数据卷 schema、活动文件是否存在、设备版本。
3. **备份**：按 §5 停后端后整卷备份，记录 sha256 + schema + 活动文件存在性；失败即中止。
4. **Docker 环境可用时补验容器级步骤**（独立项目名/临时卷/回环端口），再考虑真实升级。
5. **签名+安装**候选 HAP 才能做 APP 运行态验收；回退目标是 `9EEBEE…`。
6. **真实旧版镜像/源码**：若要完成“旧版兼容验收”，需先从生产主机导出旧镜像（`docker save`）作为可信历史制品。

## 10. 独立复核与整改

交付前由一个**独立只读复核者**（另一个 AI 会话，只被允许写 `_work/reviewer.md`）做了对抗性复核。
报告：`_work/reviewer.md`；逐项整改：`_work/CHANGES-AFTER-REVIEW.md`。

复核判定：A1/A2/A5/A6/A7/A8/A9 **PASS**，A3/A4 **PARTIAL**（已修），归档 PASS、演练 PASS、基线 PASS。
它找出 **4 个阻断级问题**，我逐条核实后确认全部为真并已修复（都在文档层，**归档与演练产物未改**）：

| # | 阻断问题 | 修复 |
| --- | --- | --- |
| 1 | 备份命令用主机 UID，前提“文件 644 任意用户可读”是错的——快照实际 **0600 / 属主 UID 1000**（`persistent-store.js:644`、`activity-store.js:74`、`Dockerfile:21 USER node`），多数主机会 EACCES 让强制备份失败 | 改为 `--user 0` 只读挂载 + **主机重定向**落盘（避免主机出现 root 拥有的归档）；staging 增加 `chmod -R a+rX`；§5 补“读权限前提” |
| 2 | §4 在 `backup/` 创建之前写归档，且无 `set -e` → 可能静默失败却继续升级、**没有留存旧镜像** | §4 加 `set -euo pipefail` + `mkdir -p`；导出改 `.partial`→`gzip -t`→改名→sha256→`docker load` 回读 |
| 3 | 卷名写死；名字不符时 docker 会自动建**空卷**并“成功备份空内容” | 改为从容器解析 `/data` 卷名 + `docker volume inspect` 校验，失败即中止；并修正“容器已 stop 时须用 `ps -aq`” |
| 4 | 声称有 `SHA256SUMS.txt` 但文件不存在 | 在全部修改后生成并逐条复算校验 |

复核者还**独立复现**了关键证据：归档 `F82DA474…`（188 条目 / 187/187 MANIFEST / 解压副本 **287/287**）、
演练 `restoredLive == preUpgrade`（3/3 失败保护中止且未动数据）、冻结 HAP 未变、上游 81/81 与 136/136、
交付目录之外无写入。它同时指出“归档哈希只由内容决定”属过度声明（不同 Python/zlib 版本压缩字节不同），
本报告与 manifest 已改为“内容可复现、归档字节依赖构建工具链”。

## 11. 交付物索引

见 §2。校验清单：`SHA256SUMS.txt`（覆盖本目录全部交付物）。
