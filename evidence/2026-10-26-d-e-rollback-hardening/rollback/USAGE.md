# rollback-transaction.js — 使用说明

- 实现：`rollback/rollback-transaction.js`（Node ≥ 18，无第三方依赖，`tar` 由系统提供）
- 设计/语义：`../ROLLBACK-STATE-MACHINE.md`
- 状态：本任务**已在文件级与 Docker 卷级真实执行过**（见 `../rehearsal/file-level-results.json`、
  `../sandbox/docker-validation-results.json`）；**未在生产主机执行**。

工具本身**从不启动或停止后端**。它只操作 `--data-root` 指向的数据目录（生产是 `/data` 卷）。
“后端已停止”由调用方验证并用 `--backend-stopped-asserted` 声明，缺少该参数直接拒绝运行。

## 1. 前置条件（缺一不可）

1. 后端**已停止**（容器 stopped，不是 paused）。
2. 已从**停止的容器**解析出真实 `/data` 卷名，并用 `docker volume inspect "$VOL"` 校验通过
   （**不要写死卷名**：`-v`/`--mount` 在卷不存在时会自动创建空卷，会“成功备份空内容”）。
3. 升级前归档与升级后归档都在，且已记录各自 SHA-256 与 treeHash。
4. 数据卷剩余空间 ≥ 现有数据大小 + 64 MiB（copy-aside 需要空间；不足会在 S1 中止）。
5. 事务脚本以**容器运行用户**（`node` / UID 1000）对 `/data` 有写权限；
   归档目录只需只读权限；`/data/**` 里 0600 快照必须能被备份容器以 root 读取。

## 2. 三种模式

```bash
# 2.1 正常回滚（生产用）
docker run --rm --network none --user node \
  --mount type=volume,source="$VOL",target=/data \
  --mount type=bind,source="$PWD/backup",target=/backup,readonly \
  --mount type=bind,source="$PWD/evidence",target=/evidence \
  --mount type=bind,source="$PWD/rollback",target=/opt/rollback,readonly \
  <old-image-tag> node /opt/rollback/rollback-transaction.js \
    --mode rollback \
    --data-root /data \
    --pre-archive /backup/backend-data-<ts>.tgz \
    --post-archive /backup/post-upgrade-data-<ts>.tgz \
    --expected-pre-tree-hash <升级前 treeHash> \
    --expected-post-tree-hash <升级后 treeHash> \
    --evidence-out /evidence/rollback-result.json \
    --volume-name "$VOL" \
    --backend-stopped-asserted

# 2.2 只校验（不改数据）
... --mode preflight（同上参数；**所有模式都要求 --backend-stopped-asserted**，
    脚本在 S0 就会拒绝缺少该声明的调用）

# 2.3 进程被杀 / 掉电后恢复（按卷内 journal）
docker run --rm --network none --user node \
  --mount type=volume,source="$VOL",target=/data \
  --mount type=bind,source="$PWD/evidence",target=/evidence \
  --mount type=bind,source="$PWD/rollback",target=/opt/rollback,readonly \
  <old-image-tag> node /opt/rollback/rollback-transaction.js \
    --mode recover --data-root /data \
    --expected-original-tree-hash <升级后 treeHash> \
    --backend-stopped-asserted \
    --evidence-out /evidence/recover-result.json \
    --op-id <上一次的 op-id>
```

主机上（跑在某个临时目录而不是容器卷）用法相同，把 `--data-root` 指向该目录即可；
此时 `tar` 用主机自带的（Windows 10+ 的 bsdtar 可用）。**注意**：主机文件级运行不含
POSIX uid/gid 语义，只用于逻辑验证。

## 3. 参数

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `--mode rollback\|preflight\|recover` | 否（默认 rollback） | 见 §2 |
| `--data-root <path>` | 是 | 数据目录；生产 `/data`；事务目录固定 `<data-root>/.de-rollback/<opId>` |
| `--pre-archive <tgz>` | rollback/preflight | 升级前归档（**必须含 `backend-state.json`**） |
| `--post-archive <tgz>` | rollback/preflight | 升级后整卷归档（回滚前留档，用于校验与人工兜底） |
| `--expected-pre-tree-hash <hex>` | 强烈建议 | 备份时记录的 treeHash；不符即中止（防“备份被换掉”） |
| `--expected-post-tree-hash <hex>` | 强烈建议 | 升级后留档的 treeHash；会解包比对 |
| `--expected-original-tree-hash <hex>` | recover 必填 | resume 恢复后用于**校验**的升级后 treeHash；缺省时只恢复不判定（报 MANUAL） |
| `--evidence-out <json>` | 建议 | 结果 JSON 落盘路径（容器里要挂一个可写 bind） |
| `--op-id <id>` | 否 | 默认按时间+随机生成；**resume 时必须复用原 op-id** |
| `--volume-name <name>` | 建议 | 仅写入证据，便于审计；不影响数据操作 |
| `--backend-stopped-asserted` | rollback 必填 | 声明调用方已确认后端停止 |
| `--fail-point <name>` | **仅测试** | 可重复；见 §5 |
| `--fail-after <N\|name=N>` | **仅测试** | 可重复；用于在 N 次操作后触发 |

## 4. 退出码与终态

| 退出码 | 终态 | 调用方该做什么 |
| --- | --- | --- |
| 0 | `COMPLETED` / `PREFLIGHT_OK` | 若为 COMPLETED：用**钉住的旧镜像** + `--no-build` 启动后端 |
| 10 | `PREFLIGHT_ABORT` | 数据未变；按错误信息修前置条件后重试；可先把后端按原镜像启回去 |
| 20 | `RECOVERED_TO_V6` | 数据已自动回到升级后原状态；**后端保持停止**，排障后重试回滚 |
| 30 | `MANUAL_TAKEOVER_REQUIRED` | **禁止启动后端**；按 `evidence.instructions` 人工接管（`--mode recover` 自身失败也是 30，不是 10） |
| 40 | `INTERNAL_ERROR` | 保持停止；看 `result.error` / `result.journalWriteFailed` 与卷内 `journal.jsonl`，按 30 的人工接管流程处理 |
| 2 | 硬中断（仅注入时出现） | 用 `--mode recover --op-id <id> --expected-original-tree-hash <hash> --backend-stopped-asserted` |

## 5. 故障注入点（仅测试环境使用）

`after-inventory`、`post-archive-unreadable`、`partial-aside-copy`、
`staging-missing-state`、`staging-tamper`、`partial-staging-extract`、
`partial-landing-copy`、`partial-landing`、`final-verify`、
`hard-exit`、`recovery-fail`、`recovery-fail-once`、`recovery-before-undo`

生产调用**不要**传这两个参数（建议在包装脚本里直接不暴露）。

## 6. 事务目录与清理

事务目录：`<data-root>/.de-rollback/<opId>/`

```text
journal.jsonl      append-only，逐条 fsync；恢复的唯一依据
state.json         阶段/状态快照（辅助证据）
original/          操作前 /data 的完整复制（S3 校验过 treeHash）
                   → 主路径（journal 逆序撤销）失败时的**兜底恢复依据**；也用于人工接管比对
staging/           升级前归档解出的内容（S4 校验过）
incoming/          落位前的临时副本（同分区，rename 入位）
aside/             被替换的原文件（rename 而来，撤销用）
quarantine/        失败恢复时被移走的本次生成对象（不删除）
```

**清理规则**（务必遵守）：事务目录是证据。成功回滚后也要先把它整份导出（例如
`tar czf rollback-tx-<opId>.tgz -C /data/.de-rollback <opId>`）并校验，再经人工确认后删除；
**不要**对 `/data` 或 `.de-rollback` 做宽泛递归删除。脚本本身不删除事务目录。

## 7. 自动恢复的两级路径（实现事实）

- **主路径**：按 `journal.jsonl` 逆序撤销（aside → 原位；本次新建 → quarantine）；
- **兜底路径**：主路径失败时，用 S3 校验过的 `original/` 整份副本重建 `/data`（先用 treeHash
  确认副本完好，再重建，最后再校验一次）；
- 两级都失败 → `MANUAL_TAKEOVER_REQUIRED`（exit 30）+ evidence，**不启动服务**。

因此不要把 `original/` 或 `quarantine/` 当作可随意清理的临时目录。

## 8. 需要注意的行为

- `COMPLETED` 之后 `/data` 里仍会保留 `.de-rollback/<opId>/`（被 treeHash 排除），
  因此业务视角的数据 = “升级前内容 + 升级后新增但被保留的顶层/嵌套项”。
- 升级后新增的 `activity-state.json`、`evidence/*.jpg` 等**不会被删除**，会被原地保留并在
  最终校验中确认未变；旧版代码会忽略它们。
- 回滚**不会**做 v6→v5 的数据合并；D 的处置/安全日志只存在于升级后留档。
- 运行结束后请把 `--evidence-out` 的 JSON 与卷内 journal 一起归档。
