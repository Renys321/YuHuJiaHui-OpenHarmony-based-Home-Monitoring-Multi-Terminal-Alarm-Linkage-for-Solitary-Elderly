# ROLLBACK-STATE-MACHINE — 卷内回滚状态机、撤销语义与故障注入矩阵

- 日期：2026-10-26（Asia/Shanghai）
- 实现：`rollback/rollback-transaction.js`（Node ≥18，无第三方依赖；主机与容器同一份代码，路径由参数给出）
- 使用说明：`rollback/USAGE.md`
- 证据（**均为本次真实运行**）：
  - 文件级故障注入：`rehearsal/file-level-results.json` → **18/18**，`FILE_LEVEL_HARDENING_VERIFIED`
  - Docker 卷/容器级：`sandbox/docker-validation-results.json` → **32/32**，`DOCKER_VOLUME_VALIDATION_PASS`
  - 原始日志：`rehearsal/file-level-console.log`、`sandbox/docker-validation-console.log`、
    `sandbox/logs/docker-evidence/*.json`（逐场景事务证据）
- 已按独立复核意见修订：见 `_work/reviewer.md` 与 `_work/CHANGES-AFTER-REVIEW.md`

## 0. 要修的缺口（先说清楚）

旧操作单（`2026-10-26-d-e-release-prep/DEPLOY-RUNBOOK.md` §8.2.5）的回滚是
“先把 `/data` 现有项逐项 `mv` 到 `_rollback-archive-*`，再 `cp -R staging/. /data/`”：

1. **部分失败会留下混合状态**：`/data` 可能同时缺升级后文件、又有部分旧快照已落位；
2. 失败分支只有一句“反方向 `cp -R` 放回”，会与已部分落位的内容**合并**，无法证明回到原状态；
3. 旧 Node 演练用整目录 rename，覆盖不到真实卷内的逐项移动/复制语义。

本状态机针对这三点重写，并在实现过程中又发现并修掉两个真实缺陷：

- **目录整体替换会丢数据**：按“整目录替换”落位会把 `evidence/` 里升级后新增的证据文件删掉
  （文件级 `normal-rollback` 第一次运行即失败）→ 改为**递归合并**；
- **在错卷/空卷上会“成功回滚”**（独立复核发现）：`--expected-post-tree-hash` 只和归档比、
  没和**运行卷内容**比 → 现在在 S1 用 `live volume identity` 闸门强制比对，不一致直接拒绝。

## 1. 终态与退出码

| 终态 | 退出码 | 含义 | 数据卷 | 服务 |
| --- | --- | --- | --- | --- |
| `COMPLETED` | 0 | 回滚完成，逐字节/逐权限校验通过 | 升级前内容 + 保留的升级后新增项 | 可启动旧镜像 |
| `PREFLIGHT_OK` | 0 | 只做校验，未改数据 | = 升级后原状态 | 可继续 |
| `PREFLIGHT_ABORT` | 10 | 前置阶段（S0–S4）失败，**数据从未被修改** | = 升级后原状态（事务目录除外） | 可用新镜像启动 |
| `RECOVERED_TO_V6` | 20 | 落位/校验失败，**已自动恢复并校验** | = 升级后原状态（treeHash 完全一致） | 保持停止，排障 |
| `MANUAL_TAKEOVER_REQUIRED` | 30 | 恢复（含兜底）失败，或 `--mode recover` 自身失败 | 混合/未知，**证据已落盘** | **禁止启动** |
| `INTERNAL_ERROR` | 40 | 事务自身异常（已尽量先走恢复） | 视阶段 | 保持停止，按证据处理 |
| （硬中断） | 2 | `hard-exit` 注入：模拟进程被杀 | 可能停在部分落位 | 保持停止；用 `--mode recover` |

`result.serviceMustStayStopped` 只在 `RECOVERED_TO_V6 / MANUAL_TAKEOVER_REQUIRED / INTERNAL_ERROR`
为 `true`；`COMPLETED / PREFLIGHT_OK / PREFLIGHT_ABORT` 为 `false`（数据是可判定的），
避免“连成功也要求停机”的误导。

**旧镜像启动失败是独立一维**，不改变数据终态：
`ROLLED_BACK_V5_DATA_RESTORED_OLD_IMAGE_NOT_RUNNING`
（v5 数据已就位并校验、旧镜像没起来、服务保持停止）。Docker 级用两种方式实测：
tag 不存在（`docker run` exit 125）、非法 `HOUSEHOLD_TIMEZONE`（容器 `exited 1`），
两种情况下数据 treeHash 前后不变、均未启动服务。

## 2. 阶段机

```text
S0_PREFLIGHT           事务目录自检（必须在 --data-root 内）+ 要求 --backend-stopped-asserted
S1_PREFLIGHT_CHECKS    归档存在/非空、空间检查、记录原清单+treeHash
                       ★ live volume identity：original.treeHash 必须 == --expected-post-tree-hash
S2_VERIFY_POST_ARCHIVE 升级后留档可解包；有 expected 时解包比对 treeHash（解包比对**排除** .de-rollback）
S3_COPY_ASIDE          把 /data 顶层项**复制**到 <tx>/original/ 并校验 treeHash（preflight 跳过）
S4_VERIFY_PRE_ARCHIVE  升级前归档可解包、含 backend-state.json；解到 staging 并校验 treeHash
                       （若归档里带 .de-rollback，剔除并记 journal）
   └─ preflight 模式在此结束（PREFLIGHT_OK），不改 /data
S5_LANDING             递归合并落位（见 §3），每步写 journal
S6_FINAL_VERIFY        三条断言（见 §4）
S7_DONE                COMPLETED
失败处理 → PREFLIGHT_ABORT（S0–S4）/ 自动恢复（S5–S6）/ MANUAL（恢复模式或恢复失败）
```

**空间要求**：copy-aside 需要与现有数据等量的额外空间；S1 用 `fs.statfsSync` 检查
`free >= dataBytes + 64 MiB`，不足直接 `PREFLIGHT_ABORT`。

## 3. 落位：递归合并（不是整目录替换）

`staging/` 与 `/data` 在**同一文件系统**（staging 位于 `/data/.de-rollback/<opId>/` 内），
每项 `rename` 都是同分区原子操作，不会出现半写文件。规则：

| 情形 | 动作 | journal | 撤销 |
| --- | --- | --- | --- |
| 两边都有的**文件** | 原文件 `rename` 到 `aside/<rel>`；`incoming/<rel>` `rename` 到位 | `aside` + `placed(hadAside=true)` | 当前值 → `quarantine/`；`aside` 移回原位 |
| 只在 staging 里的**文件** | `incoming` `rename` 到位 | `placed(hadAside=false)` | 当前值 → `quarantine/` |
| 只在 `/data` 里的**文件**（含嵌套：升级后新增的证据/活动文件） | **原地保留** | `preserve-extra` | 无需动作 |
| 只在 staging 里的**目录** | `mkdir` | `mkdir` | 空则 `rmdir`；非空整目录移入 `quarantine/` |
| 两边都有的**目录** | 递归合并子项（不删除任何现有文件） | 子项各自记录 | 同上 |

## 4. 最终校验（三条断言，任一失败都会触发恢复）

1. **staging 的每一项**在 `/data` 里 `type/size/mode/uid:gid/sha256` 全部一致；
2. **原快照里、但不属于 staging 的每一项**仍然存在且未变（`type/size/mode/uid:gid/sha256`）；
3. **不允许出现既不在 staging、也不在原快照里的条目**（防混合残留）。

校验是**清单级**的，不是“退出码 0 就算成功”。Docker 级“正常回滚”就是拿容器内
`volumeInventory()` 算出的 treeHash 与 rollback-complete 参考卷比对（含 uid/gid/mode）。

## 5. 自动恢复：主路径 + 兜底路径

触发条件：`S5_LANDING` / `S6_FINAL_VERIFY` 中任何异常（含注入、fsync 失败等）。

### 5.1 主路径：按 journal 逆序撤销

```text
1) 从 journal 重建：aside 路径、是否 placed、是否 hadAside
2) 逆序（后落位先撤）逐项：
     当前 /data/<rel>（若存在）→ quarantine/<n>-<rel>
     hadAside 时：aside/<rel> → /data/<rel>；否则（本次新建）不恢复
3) 处理“在途”项（aside 完成、placed 未完成）：aside → /data/<rel>
4) 本次新建目录：空则 rmdir；非空整目录移入 quarantine
5) incoming 残留、staging → quarantine（**不删除**）
6) 用 S1 的 inventory+treeHash 校验
```

### 5.2 兜底路径：用 S3 校验过的 `original/` 整份副本重建

主路径失败（journal 记录缺失、aside 被误删/损坏、撤销中途再次失败）时：

```text
1) 校验 <tx>/original/ 的 treeHash == S1 记录的 original.treeHash（不一致则拒绝兜底）
2) 当前 /data 顶层项整体移入 quarantine（保留，不删除）
3) 用 original/ 逐项复制回 /data
4) 再次用 S1 的 inventory+treeHash 校验
```

**这就是“恢复依赖 S3 校验过的 original/ 副本”的实际实现依据**。早前文档在该代码尚未接兜底时
就写了这句话（属**声明超前于实现**），现已在代码中落地，并用两个注入用例验证：
`recovery-before-undo-then-fallback`、`recovery-mid-undo-then-fallback` → 均 `RECOVERED_TO_V6`。

### 5.3 两条路径都失败 → MANUAL

- **不启动后端**（`serviceMustStayStopped=true`；脚本本身从不启动服务）；
- `mixedState` 记 `UNKNOWN`（实际是混合/未知，由调用方按 treeHash 判定）；
- `evidence` 输出：当前 treeHash、原 treeHash、`original/` 是否完整、journal 路径、当前文件清单、
  外部升级后归档路径、5 步人工处置建议。
- 文件级与 Docker 级都用 `partial-landing + recovery-before-undo + corrupt-original-copy`
  实际构造并断言了这种“真混合态”：`afterTreeHashKind=mixed`、`manualTakeover=true`、未启动。

### 5.4 `--mode recover`（硬杀后恢复）的失败必须单独归类

独立复核指出的阻断问题：早前 `handleFailure()` 只把 S5/S6/S7 当作“改过数据”，
导致 **recover 模式自身失败被报成 `PREFLIGHT_ABORT`（“数据未被触碰”）**——
而实际数据可能已是混合态，运维会按 RC10 去启动新镜像。

现在：`R1/R2/R3` 归入“会改数据”，失败 → **`MANUAL_TAKEOVER_REQUIRED`（30）+ 证据**，
绝不报 10。同时 recover 模式也要求 `--backend-stopped-asserted`。

## 6. 故障注入矩阵（两个层级都真实执行）

| # | 注入点 | 文件级 | Docker 级 | 预期阶段 | 实测终态 | 混合 | 人工接管 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 升级前归档损坏 | ✅ | ✅ | `PREFLIGHT_ABORT` | 数据=升级后原状态 | 否 | 否 |
| 2 | 校验元数据错误 | ✅ | ✅ | `PREFLIGHT_ABORT` | 同上 | 否 | 否 |
| 3 | 升级后留档缺失 | ✅ | ✅ | `PREFLIGHT_ABORT` | 同上 | 否 | 否 |
| 3b | 升级后留档**不可解包** | ✅ | ✅ | `PREFLIGHT_ABORT` | 同上 | 否 | 否 |
| 4 | staging 缺 `backend-state.json` | ✅ | ✅ | `PREFLIGHT_ABORT` | 同上 | 否 | 否 |
| 5 | staging 内容校验失败 | ✅ | ✅ | `PREFLIGHT_ABORT` | 同上 | 否 | 否 |
| 6 | copy-aside 只做了一部分就失败 | ✅ | ✅ | `PREFLIGHT_ABORT` | 同上（原件未动） | 否 | 否 |
| 7 | staging 只解包一部分就失败 | ✅ | ✅ | `PREFLIGHT_ABORT` | 同上 | 否 | 否 |
| 8 | 落位只复制了一部分就失败 | ✅ | ✅ | `RECOVERED_TO_V6` | 自动恢复并校验 | 否 | 否 |
| 9 | 落位只移动/替换了一部分就失败 | ✅ | ✅ | `RECOVERED_TO_V6` | 自动恢复并校验 | 否 | 否 |
| 10 | 落位完成后最终校验失败 | ✅ | ✅ | `RECOVERED_TO_V6` | 自动恢复并校验 | 否 | 否 |
| 11 | journal 撤销在动手前失败 → 走兜底 | ✅ | ✅ | `RECOVERED_TO_V6` | 用 `original/` 兜底恢复 | 否 | 否 |
| 12 | journal 撤销中途失败 → 走兜底 | ✅ | ✅ | `RECOVERED_TO_V6` | 用 `original/` 兜底恢复 | 否 | 否 |
| 13 | journal 与兜底都失败（`original/` 损坏） | ✅ | ✅ | `MANUAL_TAKEOVER_REQUIRED` | **真混合态**、未启动、证据落盘 | **是** | **是** |
| 14 | 进程被硬杀后 `--mode recover` | ✅ | — | `RECOVERED_TO_V6` | 按 journal 恢复并校验 | 否 | 否 |
| 15 | 旧镜像/tag 不存在 | —（需 Docker） | ✅ | 独立维度 | v5 数据不变 + `OLD_IMAGE_NOT_RUNNING` | 否 | 否 |
| 16 | 旧镜像启动失败 | —（需 Docker） | ✅ | 独立维度 | v5 数据不变 + `OLD_IMAGE_NOT_RUNNING` | 否 | 否 |
| 17 | 错卷/空卷（与 expected-post 不符） | ✅ | ✅ | `PREFLIGHT_ABORT` | 卷未被改动、拒绝回滚 | 否 | 否 |

Docker 级共 **32 项** = 16 项基础能力（daemon/镜像/卷 guard/属主权限/备份/升级/参考态/
正常回滚/旧服务真实写入/镜像 tag-save-load/compose 固定/两种启动失败分类）+ 14 项数据面注入
+ 2 项镜像面故障（tag 不存在、启动即退出）。

## 7. 每个场景记录哪些字段

`file-level-results.json` 的 `cases[]` 与 `docker-validation-results.json` 的 `scenarios[]` 均含：

```text
injectionPoint / expectedState / actualExitCode / actualState
serviceStayedStopped（事实：未启动服务） / serviceMustStayStopped（脚本建议）
finalFileList / beforeTreeHash / afterTreeHash / afterTreeHashKind
postArchiveIntact / mixedState / manualTakeover
```

`afterTreeHashKind` 由**对比三个参考哈希**得出（升级后原状态 / 纯升级前 / 回滚完成态；
Docker 级另有空卷参考），所以“是否混合”是算出来的，不是脚本自报的。

## 8. 文件系统/卷语义为什么成立

| 断言 | 依据 |
| --- | --- |
| 单项 `rename` 原子 | staging 与 `/data` 同文件系统（staging 在 `/data/.de-rollback` 内）→ 同设备 `rename` 原子替换 |
| 不能整目录原子替换 | `/data` 是卷挂载点；跨多项过程非全局原子，因此要求后端已停止 + 撤销日志 + 最终 treeHash 校验 |
| 权限/属主可恢复 | `aside` 是 rename（inode 不变）；`original/` 是 copy，恢复后以校验过的副本为准，校验含 mode/uid/gid |
| 0600 文件可备份 | 快照 0600 / uid 1000；备份容器 `--user 0` 只读挂载读取（Docker 级实测 root 可读、UID 1001 不可读） |
| 空卷不会被误当成功 | S1 的 live volume identity 闸门（需调用方传入升级后 treeHash）；Docker 级用空卷实测被拒绝 |

## 9. 已知限制

1. **旧版是派生等价模拟**：工作区无真实历史 v5 后端制品；`legacy-v5-emulation` 由冻结树机械派生
   （只改 `persistent-store.js` 3 处）。**不构成旧版兼容验收**；v5 边界代码读 v6 会报
   `persistent store unsupported schemaVersion: 6`（Docker 级实测）。
2. **沙箱 ≠ 生产主机**：Docker 级在 Docker Desktop（Linux 容器/overlay 卷）完成，
   不代表目标主机的卷驱动/权限模型一致；需在目标主机复跑。
3. **copy-aside 需要约 2× 数据空间**（S1 检查，不足即中止）。
4. **不自动合并 v6→v5 数据**；D 的处置/安全日志只存在于升级后留档。
5. 事务目录 `.de-rollback/<opId>/` 有意保留为证据；清理前必须先整目录导出留档。
6. 若**升级后归档**里带了 `.de-rollback`（例如在失败回滚后重新归档），解包比对与 staging 都会剔除该目录
   （防御性处理）；正常流程应先导出/移除事务目录再归档。
