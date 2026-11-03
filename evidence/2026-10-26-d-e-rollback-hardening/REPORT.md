# REPORT — D-E-RUNBOOK-ROLLBACK-HARDENING（回滚中途失败恢复缺口修复 + Docker 隔离故障注入）

- 日期：2026-10-26（Asia/Shanghai）
- 工作区：`<WORKSPACE>`（无 Git；不依赖 `git` 恢复）
- 交付目录：`competition/evidence/2026-10-26-d-e-rollback-hardening/`
- 上游（只读、**未修改**）：`2026-10-26-d-e-candidate-freeze/`、`2026-10-26-d-e-release-prep/`

## 0. 结论

```text
FILE-LEVEL HARDENING VERIFIED     文件级 18/18 注入用例真实通过
DOCKER VOLUME SEMANTICS VERIFIED   Docker 卷/容器级 32/32 检查真实通过（沙箱，含 14 类注入）
PRODUCTION RELEASE STILL BLOCKED  未部署；真实历史 v5 镜像不存在；生产主机命令未执行

候选状态不变：LOCAL_CANDIDATE_FROZEN — NOT_DEPLOYED — NOT_INSTALLED — REAL_ACCEPTANCE_NOT_RUN
本任务未部署、未安装、未签名、未连接设备、未访问公网生产主机、未触碰现有演示容器/卷。
```

核心变化：旧操作单“回滚中途失败只能中止 + 靠人工反向 `cp` 放回”的缺口，被**可执行状态机**取代
（copy-aside + 递归合并落位 + 撤销日志 + 主/兜底两级自动恢复 + treeHash 校验），并在
**真实 Docker 命名卷**上跑通正常回滚与 14 类故障注入；每个场景都以“最终卷文件清单 + 树哈希”判定。

## 1. 基线核对（开工时）

| 项 | 结果 |
| --- | --- |
| 交接文档 + `.sha256.txt` | 39,066 B / `EAF3F827…B93955`，一致 |
| 冻结 HAP | 2,621,844 B / `7634A0E25FCE3E19FC9604E4CD94D6D6BAFF36CB5DE67C92DAEE0E50C1452EB5`，**未修改** |
| 源码归档 | 3,954,792 B / `F82DA47444785CFB29C254F435DAB40F1569041763BBEEF10D7F5C235A908526`，**未修改** |
| 冻结交付 `SHA256SUMS.txt` / `SOURCE-HASHES.txt` | 81/81、136/136 匹配 |
| 冻结之后是否有新报告/并行改动 | **没有**：13:35 之后交付目录外无写入；旧交付文件 mtime 全部 ≤ 13:19:02 |
| 本机 Docker | server **29.9.2**，`docker info` exit 0 → 本次可用（上一任务时不可用） |
| 现有演示资源 | `eldercare-public_backend-data`、`eldercare-public_caddy-*` 三卷存在、0 容器；**全程未触碰**（收尾复核仍在、无容器） |

### 1.1 任务期间观察到的**并行写入**（不是本任务动作）

开工核验时（15:29）交付目录外确实没有新写入。但**任务进行中**（16:00–16:07）检测到
**另一个会话/进程**启动了演示链路。以下为只读观察，本任务未干预：

| 证据 | 时间 | 观察到的内容 |
| --- | --- | --- |
| `competition/evidence/2026-10-26-demo-autostart/runtime/demo-autostart.log` | 16:00:39 起 | `Watcher start` → 启动冻结 DAYU homemon → 恢复 `hdc fport tcp:9001 -> tcp:9000` → 启动 DAYU P1-B 推理 |
| `competition/bridge/_test/current-runtime/supervisor/public-sync-supervisor.log` | 16:06 前后 | `[cloud-sync] OK device=… path=/internal/v1/device-status status=202`（持续上报） |
| 只读进程/端口观察 | 16:01–16:03 | 新增 node 进程（broker 1883、bridge 9101）、`hdc`（127.0.0.1:9001）、supervisor lock 文件 |

**本任务立场**：

- 这些写入**不是本任务产生的**：本任务脚本只用 `%TEMP%` 临时目录与 `de-rb-*` 一次性 Docker 资源，
  从不启动 bridge/broker/public-sync/hdc/DAYU；
- **未停止、未重启、未配置、未写入**这些服务（任务禁止操作现有演示服务）；
- 因此“交付目录外无**本任务**写入”成立，但**不能**说“期间目录外没有任何写入”；
- 沙箱验证不受影响：Docker 验证用独立镜像/卷/网络，文件级验证只用临时目录。

## 2. 问题定位（先复现，再修）

旧 `2026-10-26-d-e-release-prep/DEPLOY-RUNBOOK.md` §8.2.5：先把 `/data` 现有项逐项 `mv` 到
`_rollback-archive-*`，再 `cp -R staging/. /data/`。已确认缺陷：

1. **部分失败留混合状态**：`mv` 与 `cp` 之间、或多文件 `cp` 中途失败时，`/data` 同时缺升级后文件、
   又有部分旧快照落位；
2. **失败分支只是中止 + 口头建议**：反向 `cp -R` 会与已落位内容**合并**，无法证明回到原状态；
3. 旧 Node 演练用**整目录 rename**，不模拟真实卷内逐项移动/复制。

实现过程中又发现两个真实缺陷（都已修并有回归用例）：

4. **整目录替换会丢数据**：`evidence/` 会被连同升级后新增的证据文件一起换掉
   （第一版状态机 `normal-rollback` 首跑即失败）→ 改**递归合并**；
5. **错卷/空卷会“成功回滚”**（独立复核发现）→ S1 增加 **live volume identity** 闸门。

## 3. 修复方案（细节见 `ROLLBACK-STATE-MACHINE.md`）

| 旧做法 | 新做法 |
| --- | --- |
| 原始数据 `mv` 到卷内归档 | **copy-aside**：先复制 `/data` 到 `<tx>/original/` 并校验 treeHash；原件始终在位 |
| `cp -R` 整目录覆盖 | **递归合并 + 逐文件原子 rename**（同文件系统）；目录不整体替换，升级后新增嵌套文件原地保留 |
| 失败即中止 | **主路径**按 journal 逆序撤销；**兜底路径**用校验过的 `original/` 整份重建；两级都失败才 MANUAL |
| 终态只有成功/失败 | 五类终态 + 硬中断 + `--mode recover`；recover 模式自身失败**不得**报“数据未动” |
| 只看退出码 | 每个场景核对最终 treeHash/文件清单/uid-gid/mode，与三个参考态比对 |
| 只有文件级演练 | 文件级 18 例 + **Docker 卷级 32 项**（真实命名卷、真实容器、真实 0600/uid1000） |
| 旧镜像启动失败混入回滚失败 | 独立维度 `ROLLED_BACK_V5_DATA_RESTORED_OLD_IMAGE_NOT_RUNNING`，Docker 级两种方式实测 |
| `--expected-post-tree-hash` 只比归档 | S1 起**强制与运行卷内容比对**；空卷/错卷直接拒绝（Docker 级实测） |

安全约束：事务目录固定 `<data-root>/.de-rollback/<opId>` 并自检不逃逸；**不删除**原始数据
（本次生成对象失败也移入 `quarantine/`）；**不默认移动/删除** `activity-state.json`、`evidence/`、
升级后留档；S1 检查剩余空间；主机临时目录 `mkdtemp` + 前缀校验后清理，不匹配则拒绝；
Docker 沙箱资源按**精确名字**删除并写入 `cleanup` 清单。

## 4. 本次实际改/新增的文件

**未修改**：D/E/CAMERA-A 业务源码、冻结 HAP、源码归档、旧证据与旧交付文档（旧 runbook 保持原貌）。

**新增交付**（全部在新目录）：

| 文件 | 说明 |
| --- | --- |
| `rollback/rollback-transaction.js` | 可执行回滚事务（状态机 + 主/兜底恢复 + resume） |
| `rollback/USAGE.md` | 使用说明（模式、参数、退出码、挂载、清理、常见错误） |
| `ROLLBACK-STATE-MACHINE.md` | 状态机、撤销语义、终态、故障矩阵、语义论证、限制 |
| `rehearsal/file-level-injection.js` + `file-level-results.json` + `file-level-console.log` | 文件级注入台架与结果 |
| `sandbox/docker-validation.js` + `docker-validation-results.json` + `-console.log` + `logs/docker-evidence/*.json` | Docker 卷级验证与逐场景证据 |
| `sandbox/seed-v5.js`、`container-inventory.js`、`compose.pin.example.yaml` | 辅助脚本与 compose 钉住模板 |
| `DEPLOY-RUNBOOK.md` | **修正版 v2**，替代旧操作单（旧文件未改） |
| `REPORT.md`、`SHA256SUMS.txt` | 报告与校验清单 |
| `_work/reviewer.md`、`_work/CHANGES-AFTER-REVIEW.md` | 独立复核报告与整改记录 |

## 5. 验证结果（本次真实运行）

### 5.1 文件级故障注入 —— `FILE_LEVEL_HARDENING_VERIFIED`（18/18）

`node rehearsal/file-level-injection.js` → exit 0（`rehearsal/file-level-results.json`）

| 用例 | 退出码 | 终态 | 最终卷状态 | 混合 | 人工接管 |
| --- | --- | --- | --- | --- | --- |
| normal-rollback | 0 | COMPLETED | 升级前 + 保留项 | 否 | 否 |
| preflight-only | 0 | PREFLIGHT_OK | = 升级后原状态 | 否 | 否 |
| corrupt-pre-archive / wrong-pre-hash / post-missing / post-unreadable | 10 | PREFLIGHT_ABORT | = 升级后原状态 | 否 | 否 |
| staging-missing-state / staging-tamper | 10 | PREFLIGHT_ABORT | = 升级后原状态 | 否 | 否 |
| partial-aside-copy / partial-staging-extract | 10 | PREFLIGHT_ABORT | = 升级后原状态 | 否 | 否 |
| partial-landing-copy / partial-landing / final-verify | 20 | RECOVERED_TO_V6 | = 升级后原状态 | 否 | 否 |
| recovery-before-undo-then-fallback | 20 | RECOVERED_TO_V6 | 用 `original/` 兜底恢复 | 否 | 否 |
| recovery-mid-undo-then-fallback | 20 | RECOVERED_TO_V6 | 用 `original/` 兜底恢复 | 否 | 否 |
| **recovery-failure-secondary**（journal + 兜底都失败） | 30 | MANUAL_TAKEOVER_REQUIRED | **真混合态** | **是** | **是** |
| hard-exit-then-resume-recover | 20 | RECOVERED_TO_V6 | resume 校验通过 | 否 | 否 |
| wrong-or-empty-volume-refused | 10 | PREFLIGHT_ABORT | 空卷未被改动、拒绝回滚 | 否 | 否 |

### 5.2 Docker 卷/容器级 —— `DOCKER_VOLUME_VALIDATION_PASS`（32/32）

`node sandbox/docker-validation.js` → exit 0（`sandbox/docker-validation-results.json`，沙箱如 `de-rb-69db87`）

| 组 | 内容 | 结果 |
| --- | --- | --- |
| 环境/隔离 | daemon、本地 `node:24-alpine`、独立镜像 tag/命名卷/bridge 网络、仅 127.0.0.1 随机端口 | PASS |
| 卷名 guard | `docker volume inspect` 拒绝未知卷（实测 `-v`/`--mount` 都会自动建卷，故靠前置闸门 + S1 内容闸门） | PASS |
| 合成 v5 | v5 边界镜像写入 3 设备/2 告警/1 证据；`schemaVersion=5`、无 `safetyLogs`、无活动文件 | PASS |
| 权限 | 主快照 **0600 / 1000:1000**；root 可读；UID 1001 读取失败 | PASS |
| 备份 | 停机整卷导出（≈1 KB 合成数据）、可解包、sha256+treeHash 记录 | PASS |
| 升级 | 候选加载 v5 → 首写升 v6；D 处置 2 条/安全日志 2 条、E 活动文件 `version=1`、v6 证据上传 201 | PASS |
| 参考态 | 容器内算 pre / post / rollback-complete 三个 treeHash（含 uid/gid/mode） | PASS |
| 正常回滚 | 真实卷内事务回滚；最终 treeHash == rollback-complete 参考值 | PASS |
| 旧服务 | 旧镜像读回 2 条告警；**真实原子写入 202**；重新加载 200；快照仍 v5 | PASS |
| 镜像固定 | tag → `docker save` → sha256 → 删 tag → `docker load` 回同一 Image ID → compose `up -d --no-build` 启动的容器 Image ID == 钉住旧镜像 | PASS |
| 启动失败两种 | tag 不存在（run exit 125）、非法时区（容器 `exited 1`）：数据 treeHash 不变、服务保持停止、分类明确 | PASS |
| 数据面注入 14 类 | 见 `ROLLBACK-STATE-MACHINE.md` §6 | PASS |

清理：`cleanup` 字段列明按精确名删除的沙箱卷/网络/镜像；收尾复核 `de-rb*` 残留 = 0，
`eldercare-public_*` 三卷仍在且无容器。

## 6. 独立复核与整改

独立只读复核者（只能写 `_work/reviewer.md`）做了对抗性审计并**独立重跑**两套台架
（14/14→当时版本、29/29→当时版本，均 exit 0；cleanup 与演示资源未触碰）。它指出 **4 个阻断问题**，
我已核实并全部修复（`_work/CHANGES-AFTER-REVIEW.md` 有逐条记录）：

| # | 复核发现 | 修复 |
| --- | --- | --- |
| 1 | `--mode recover` 自身失败被报成 `PREFLIGHT_ABORT`（“数据未动”），而数据可能已混合 → 运维会按 RC10 去启动，违反“不得自动启动混合数据” | R1–R3 归入“会改数据”，失败 → `MANUAL_TAKEOVER_REQUIRED` + 证据；recover 也要求停止断言 |
| 2 | `--expected-post-tree-hash` 只与归档比、未与**运行卷**比 → 空卷/错卷也能“成功回滚” | S1 增加 live volume identity 闸门；新增 `wrong-or-empty-volume-refused` 用例（文件级 + Docker 级） |
| 3 | `handleFailure()` 里 journal 写失败会逃逸 → INTERNAL_ERROR 且无人工证据 | journaling 包 `safeJournal`；失败仍输出 MANUAL 证据 |
| 4 | `REPORT.md` 声明 `SHA256SUMS.txt` 但当时未生成 | 本版已生成并逐条校验（见 §8） |

次要项也已修：恢复**兜底路径**真正使用 `original/`（此前文档声明超前于实现）、
保留项的最终校验补 `uid/gid`、`serviceMustStayStopped` 语义（成功/未改为 false）、
新增“升级后留档不可解包”“journal 撤销中途失败→兜底”“错卷/空卷”用例、
staging/post 归档中的 `.de-rollback` 防御性剔除、Docker 旧镜像启动失败要求**非零**退出码、
运行单 §8.2.4 的 RC 捕获在 `set -e` 下写法、compose 钉住模板路径等。

## 7. 证据分级与未验证项

| 等级 | 内容 |
| --- | --- |
| **本次运行验证（文件级）** | 18 例注入；Node fs 临时目录；证明状态机与撤销清单逻辑 |
| **本次运行验证（Docker 卷级）** | 32 项；真实容器 + 真实命名卷 + 独立网络 + 真实 0600/uid1000；证明卷内 rename/合并/恢复语义 |
| **仅文档推演** | 生产主机上的同名命令、卷名/路径/权限、`docker save` 落盘位置 |
| **现场未知** | 生产当前镜像/`schemaVersion`/活动文件/设备版本/证书/DNS |
| **不可验证（本工作区）** | 真实历史 v5 后端镜像——不存在；Docker 验证用的是**派生的 v5 等价模拟**（非历史制品） |

剩余阻塞：

1. **生产主机未执行**（任务禁止部署）；所有 `# 现场执行` 命令均未在生产运行。
2. **无真实历史 v5 镜像** → **不构成旧版兼容验收**。
3. **沙箱 ≠ 生产主机**：卷驱动/权限模型需在目标主机复跑同一套脚本。
4. **copy-aside 需约 2× 数据空间**（S1 检查，不足即中止）。
5. 事务目录需人工导出留档后清理；**不自动合并 v6→v5 数据**。
6. 真机 APP 安装/回退未验证。

### 7.1 本任务未做（对照禁止项）

未连接公网生产主机/生产 API/生产数据卷/设备；未部署、未签名、未安装、未烧录；
未重启或停止现有演示服务；未修改 D/E/CAMERA-A 业务源码、冻结制品或旧证据；
未使用现有演示容器/网络/端口/真实 `.env`；未制造 SOS/FALL、未发生产 ingest/ACK/reset；
未恢复 `LOCAL-ALARM-VOICE-CLOSURE`；未输出密钥/Token/Wi-Fi 口令/签名材料/私钥/真实家庭数据
（沙箱凭据为进程内随机生成、不落盘）；未 `docker compose down -v` 或宽泛清理；
未对工作区/用户目录递归删除。

关于任务期间另一个会话启动的演示链路（见 §1.1）：本任务只做**只读观察并记录**，
没有启动/停止/重启/配置其中任何一项，也没有对其做任何写操作。

## 8. 交付物校验

`SHA256SUMS.txt` 覆盖本目录全部交付物（含 `_work` 证据与复核报告），生成后用独立循环逐条复算通过。
生成规则：交付完成后运行 `_work/gen_sha256sums.py`，再逐条 `Get-FileHash` 比对（见终端输出）。

## 9. 下一步最小动作（需用户授权）

1. 在**目标主机**（Docker 可用、不碰生产数据）复跑 `node sandbox/docker-validation.js`，
   确认卷驱动/权限模型下结论一致。
2. 维护窗口内 `docker save` 导出当前生产镜像，作为可信历史制品 → 才能做“旧版兼容验收”。
3. 按 `DEPLOY-RUNBOOK.md` §4（钉旧镜像）→ §5（停机备份 + 记录两个 treeHash）→ §6（升级）
   → §7（有效会话验收）→ §8（回滚，按 RC 分支）执行。
4. APP 侧：签名并安装候选 HAP 才能做运行态验收；回退目标 `9EEBEE…`。

在此之前保持：
`LOCAL_CANDIDATE_FROZEN — NOT_DEPLOYED — NOT_INSTALLED — REAL_ACCEPTANCE_NOT_RUN`。
