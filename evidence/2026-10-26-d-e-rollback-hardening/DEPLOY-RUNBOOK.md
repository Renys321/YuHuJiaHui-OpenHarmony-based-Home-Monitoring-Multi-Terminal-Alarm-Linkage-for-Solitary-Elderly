# DEPLOY-RUNBOOK（修正版 v2）— D/E 候选的公网升级与回滚操作单

- 日期：2026-10-26（Asia/Shanghai）
- 状态：**替代** `competition/evidence/2026-10-26-d-e-release-prep/DEPLOY-RUNBOOK.md`
  （旧文件按要求**保持原貌未改**）。本版修掉了旧版 §8.2.5 的回滚中途失败缺口，并新增可执行事务脚本。
- 本任务**没有**接触生产：没有登录公网主机、没有对生产执行任何 docker 命令、没有访问生产 API/数据卷/设备。
- 本文件所有 `# 现场执行` 命令**均未在生产执行**；执行层级见每节的“证据等级”。

```text
证据等级标记（本文件统一使用）：
  [DOCKER 实测]  本机真实 Docker 容器 + 真实命名卷 + 独立网络跑过（沙箱，非生产主机）
  [文件级]       Node fs 在临时目录模拟，验证状态机逻辑，不含 POSIX 卷语义
  [文档推演]     未执行，需要现场条件
  [现场未知]     必须现场只读核验后填写
```

## 0. 本版相对旧版的修正（逐条）

| # | 旧版问题 | 本版处理 |
| --- | --- | --- |
| 1 | 回滚失败分支只有一句“反方向 `cp -R` 放回”，与已部分落位的内容合并，**无法证明**回到原状态 | 改为**可执行事务**：copy-aside + 逐项原子 rename + 撤销日志 + 自动逆序撤销 + treeHash 校验；失败分类见 §7 |
| 2 | 部分复制/部分移动会留下**新旧混合态** | 落位改**递归合并**（不整目录替换）；任一失败自动恢复到升级后原状态并校验；恢复再失败则 `MANUAL_TAKEOVER_REQUIRED` 并保持停机 [DOCKER 实测] |
| 3 | 旧镜像启动失败与数据回滚失败混为“回滚失败” | 拆成独立维度：数据侧 `ROLLED_BACK_V5_DATA_RESTORED_OLD_IMAGE_NOT_RUNNING`，见 §8 [DOCKER 实测] |
| 4 | 临时目录与清理规则不明 | 事务目录固定在卷内 `.de-rollback/<opId>`；主机临时目录用 `mkdtemp` 绝对路径，清理前校验前缀，**禁止**对工作区/用户目录递归删除 |
| 5 | 无属主/权限验证，只有 `[ -w file ]` 式检查 | 以容器运行用户执行；校验 `0600 / uid:gid 1000`，并用**真实原子写入 + 重新加载**证明可写，而不是 `-w` [DOCKER 实测] |
| 6 | Docker 级与文件级证据混在一起 | 全文标注证据等级，见上表头 |
| 7 | （旧版已纠正过、本版保留）匿名 401 判据、镜像固定、备份一致性、数据丢失声明 | 见 §6/§4/§3/§7.4 |

## 1. 现场状态：全部是待核验项

> 交接文档里的“生产合同 v1.0.0 / schema v5 / 无活动文件 / 设备装历史包”是**历史记录**，
> 不是当前事实。本任务未做现场检查。

```bash
# 现场执行（只读核验，不改任何状态）
docker compose --env-file deploy/.env.deploy -f deploy/compose.public.yaml ps
docker inspect --format '{{.Name}} image={{.Image}}' $(docker compose --env-file deploy/.env.deploy -f deploy/compose.public.yaml ps -q backend)
docker image inspect eldercare-cloud-backend:local --format '{{.Id}}'   # 本地构建镜像以 Image ID 为准
docker volume ls | grep -E 'backend-data|caddy-data|caddy-config'
curl -sS -o /dev/null -w 'healthz=%{http_code} readyz=' https://<域名>/healthz
curl -sS -o /dev/null -w '%{http_code}\n' https://<域名>/readyz
```

**必须记录并回填**：当前 Image ID、`schemaVersion`、`activity-state.json` 是否存在、
设备上 APP 的实际版本/哈希。

## 2. 制品身份

| 制品 | 身份 |
| --- | --- |
| 后端源码/镜像 | 源码归档 `d-e-candidate-source-2026-10-26.zip`（3,954,792 B / `F82DA474…A908526`）内的 `competition/cloud/backend` |
| 手机候选 HAP | `7634A0E25FCE3E19FC9604E4CD94D6D6BAFF36CB5DE67C92DAEE0E50C1452EB5`（2,621,844 B，**unsigned，未安装**） |
| APP 回退目标 | `9EEBEE9A5FC9EEC5A5993DC6923F16F0BFCCCD1CD4DE64BAF36FC7197ECAD25A`（2,086,949 B）——**不是** `8A722…` |
| 合同 | `APP-API-v1.md/.json` 版本 **1.2.0** |

## 3. 部署前决策项

1. **D 与 E 是否一起上**：本候选镜像天然同含二者（`server.js`/`main.js`/`package.json` 共享）。
   只上 D 需另做共享文件拆分并重跑全量测试，本操作单不提供。
2. **维护窗口**：§4 备份阶段起会中断服务。
3. **数据不可逆点**：候选加载 v1–v5 后，**第一次成功写入即写 schemaVersion 6**；旧代码从此读不了该卷。
4. **家庭时区**：`HOUSEHOLD_TIMEZONE`（默认 `Asia/Shanghai`）；**非法值会拒绝启动**。
5. **活动文件**：默认 `/data/activity-state.json`（同卷），不要指向容器临时层。

## 4. 镜像保留与固定（旧镜像必须先钉住）

```bash
# 现场执行（进入维护窗口之前先做，失败即中止）
set -euo pipefail
mkdir -p backup evidence-of-deploy && chmod 700 backup evidence-of-deploy
OLD_IMAGE=$(docker inspect --format '{{.Image}}' $(docker compose --env-file deploy/.env.deploy -f deploy/compose.public.yaml ps -q backend))
[ -n "$OLD_IMAGE" ] || { echo 'NO RUNNING BACKEND -> ABORT'; exit 1; }
docker tag "$OLD_IMAGE" eldercare-cloud-backend:pre-d-e-20261026
docker image inspect eldercare-cloud-backend:pre-d-e-20261026 --format '{{.Id}}' | tee evidence-of-deploy/old-image-id.txt
docker save eldercare-cloud-backend:pre-d-e-20261026 | gzip -9 > backup/image-pre-d-e-20261026.tar.gz.partial
gzip -t backup/image-pre-d-e-20261026.tar.gz.partial
mv backup/image-pre-d-e-20261026.tar.gz.partial backup/image-pre-d-e-20261026.tar.gz
sha256sum backup/image-pre-d-e-20261026.tar.gz | tee backup/image-pre-d-e-20261026.sha256
chmod 600 backup/image-pre-d-e-20261026.tar.gz
gunzip -c backup/image-pre-d-e-20261026.tar.gz | docker load --quiet   # 回读校验
```

- 回滚启动必须：`docker compose -f compose.public.yaml -f deploy/compose.pin.example.yaml … up -d --no-build backend`
  （`sandbox/compose.pin.example.yaml` 是覆盖模板；`--no-build` 防止因上下文变化偷偷重建）。
- `docker save` / `docker load` / `--no-build` 固定镜像这条链路 **[DOCKER 实测]**：
  保存 61,751,296 B、sha256 记录、删除 tag 后 load 回同一 Image ID、
  compose `up -d --no-build` 启动的容器 Image ID == 钉住的旧镜像 ID。
- **禁止**把 `:pre-d-e-20261026` 重新打给新镜像。

## 5. 数据备份（一致性 + 卷名校验）

> 读权限前提：主快照/活动文件由后端以 `fs.openSync(tmp,'wx',0o600)` 写出，属主是容器用户
> `node`(UID 1000)。因此备份容器用 `--user 0` 只读挂载读取，**用主机重定向落盘**，
> 避免主机上出现 root 拥有的归档。 **[DOCKER 实测]**：root 可读、UID 1001 读取失败。

```bash
# 现场执行 —— 5.1 停后端（中断服务）
docker compose --env-file deploy/.env.deploy -f deploy/compose.public.yaml stop backend

# 现场执行 —— 5.2 从“已停止的容器”解析真实卷名并校验（必须 ps -aq）
set -euo pipefail
TS=$(date +%Y%m%d-%H%M%S)
VOL=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' \
  $(docker compose --env-file deploy/.env.deploy -f deploy/compose.public.yaml ps -aq backend))
[ -n "$VOL" ] || { echo 'CANNOT RESOLVE /data VOLUME -> ABORT'; docker volume ls; exit 1; }
docker volume inspect "$VOL" > /dev/null || { echo "VOLUME $VOL NOT FOUND -> ABORT"; exit 1; }
echo "$VOL" | tee evidence-of-deploy/data-volume.txt

# 现场执行 —— 5.3 整卷备份（root 读 0600 → 主机重定向写文件）
docker run --rm --network none --user 0 --entrypoint sh \
  --mount "type=volume,source=$VOL,target=/data,readonly" \
  eldercare-cloud-backend:pre-d-e-20261026 \
  -c "tar czf - -C /data ." > "backup/backend-data-$TS.tgz.partial"
tar tzf "backup/backend-data-$TS.tgz.partial" > /dev/null || { rm -f "backup/backend-data-$TS.tgz.partial"; echo 'BACKUP UNREADABLE -> ABORT'; exit 1; }
[ -s "backup/backend-data-$TS.tgz.partial" ] || { rm -f "backup/backend-data-$TS.tgz.partial"; echo 'BACKUP EMPTY -> ABORT'; exit 1; }
mv "backup/backend-data-$TS.tgz.partial" "backup/backend-data-$TS.tgz"
chmod 600 "backup/backend-data-$TS.tgz"
sha256sum "backup/backend-data-$TS.tgz" | tee "backup/backend-data-$TS.sha256"
tar tzf "backup/backend-data-$TS.tgz" | head -20   # 人工确认条目合理

# 现场执行 —— 5.4 用 preflight 模式算 treeHash（不改数据）
#   - evidence 里的 original.treeHash = 当前卷（升级前）树哈希 → 以后当 PRE_TREE_HASH
#   - evidence 里的 staging.treeHash  = 升级前归档内容树哈希（应与 original 相同；不同说明备份不含全部内容）
docker run --rm --network none --user node \
  --mount "type=volume,source=$VOL,target=/data" \
  --mount "type=bind,source=$PWD/backup,target=/backup,readonly" \
  --mount "type=bind,source=$PWD/evidence-of-deploy,target=/evidence" \
  --mount "type=bind,source=$PWD/rollback,target=/opt/rollback,readonly" \
  eldercare-cloud-backend:pre-d-e-20261026 \
  node /opt/rollback/rollback-transaction.js --mode preflight --data-root /data \
    --pre-archive "/backup/backend-data-$TS.tgz" \
    --post-archive "/backup/backend-data-$TS.tgz" \
    --evidence-out /evidence/preflight-before-upgrade.json \
    --volume-name "$VOL" --backend-stopped-asserted
# 从 JSON 取 .original.treeHash 写入 evidence-of-deploy/pre-tree-hash.txt
```

**判定（全部满足才继续）**：卷名来自容器且 `volume inspect` 通过；归档可读、非空、sha256 已记录；
`schemaVersion` 与活动文件存在性已记录；备份已限权且未进版本控制/日志/聊天。
任何一条失败 → 停止升级，按钉住的旧镜像 `up -d --no-build` 启回。

> `--mount` 与 `-v` 在卷名不存在时**都会自动创建空卷**（本机实测 `--mount` 也会 create）。
> 所以“不误建空卷”靠的是 §5.2 的 `docker volume inspect` 前置闸门，而不是挂载语法。 **[DOCKER 实测]**

## 6. 升级执行

```bash
# 现场执行（前置：§4、§5 全部通过）
set -euo pipefail
docker compose --env-file deploy/.env.deploy -f deploy/compose.public.yaml build --no-cache backend
docker image inspect eldercare-cloud-backend:local --format '{{.Id}}' | tee evidence-of-deploy/new-image-id.txt
docker compose --env-file deploy/.env.deploy -f deploy/compose.public.yaml up -d
docker compose --env-file deploy/.env.deploy -f deploy/compose.public.yaml ps
```

- **禁止** `docker compose down -v`（会删 `backend-data` 与 Caddy 证书卷）。
- 不改 `Caddyfile`/DNS/端口/绑定。
- 首次写入后主快照变 v6：从此刻起旧镜像不能直接读该卷（**Docker 实测**：
  v5 边界代码读 v6 快照报 `persistent store unsupported schemaVersion: 6`）。

## 7. 部署后验收（**不要**用匿名 401/404 判断）

### 7.1 为什么匿名 401 不能证明部署成功

`competition/cloud/backend/src/server.js:513-515` 的统一 Bearer 鉴权在**业务路由之前**
（`:517` 起才是 `/api/v1/overview` 等），所以匿名访问任何 `/api/v1/...`（含不存在的路径）都是 401。

### 7.2 正确的验收顺序

| 顺序 | 检查 | 通过标准 |
| --- | --- | --- |
| 1 | 制品身份 | 运行容器 `Image` ID == `new-image-id.txt` 记录值 |
| 2 | 进程健康 | `/healthz`、`/readyz` 200（无需鉴权） |
| 3 | 主快照 | 容器内 `schemaVersion` == 6（首次写入之后） |
| 4 | 既有接口 | 有效会话下 `/api/v1/overview|devices|alerts` 字段与 1.2.0 合同一致 |
| 5 | D 新接口 | `/api/v1/safety-logs?limit=5` → 200 且 `{logs:[]}`；`/alerts/{id}/dispositions` → 200 |
| 6 | E 新接口 | `/api/v1/activity/report?scope=day` → 200，含 `dataSince`(number)、`range`、`summary`、`days[]`、`disclaimer` |
| 7 | 404 语义仍在 | 有效会话访问不存在路径 → 404（用它证明路由表正常，而不是匿名 401） |

### 7.3 凭据处理

Token **不得**进命令行/日志/报告：放 0600 文件里用 `curl --config`，或用从环境变量读取的脚本；
`docker compose config` 会打印解析后的密钥，禁止重定向到文件/日志。

## 8. 回滚（新事务脚本）

### 8.1 三条规则

1. 先完整保留升级后数据；2. 任一步校验失败即中止；3. **不删除**原文件（移走留档）。

### 8.2 前置：工具自带的“卷身份”闸门

事务脚本在 S1 会把**运行卷内容**的 treeHash 与 `--expected-post-tree-hash` 强制比对；
不一致（空卷、错卷、陈旧卷）会直接 `PREFLIGHT_ABORT` 且不改数据。
因此**必须**传入从升级后卷 preflight 得到的 `POST_TREE_HASH`，不要填归档哈希或凭记忆填。 [DOCKER 实测：空卷被拒绝]

另外：`--mode recover` 同样要求 `--backend-stopped-asserted`；recover 自身失败会以 **RC30 + 证据**
结束（不是 RC10），按 §8.6 C 处理。

### 8.3 步骤

```bash
# 现场执行 —— 8.2.1 停后端，重新解析并校验卷名
set -euo pipefail
docker compose --env-file deploy/.env.deploy -f deploy/compose.public.yaml stop backend
TS=$(date +%Y%m%d-%H%M%S)
VOL=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' \
  $(docker compose --env-file deploy/.env.deploy -f deploy/compose.public.yaml ps -aq backend))
[ -n "$VOL" ] || { echo 'CANNOT RESOLVE /data VOLUME -> ABORT'; exit 1; }
docker volume inspect "$VOL" > /dev/null || { echo "VOLUME $VOL NOT FOUND -> ABORT"; exit 1; }

# 现场执行 —— 8.2.2 升级后整卷留档（回滚前必须先做）
docker run --rm --network none --user 0 --entrypoint sh \
  --mount "type=volume,source=$VOL,target=/data,readonly" \
  eldercare-cloud-backend:local -c "tar czf - -C /data ." > "backup/post-upgrade-data-$TS.tgz.partial"
tar tzf "backup/post-upgrade-data-$TS.tgz.partial" > /dev/null || { rm -f "backup/post-upgrade-data-$TS.tgz.partial"; echo 'POST ARCHIVE UNREADABLE -> ABORT'; exit 1; }
mv "backup/post-upgrade-data-$TS.tgz.partial" "backup/post-upgrade-data-$TS.tgz"
chmod 600 "backup/post-upgrade-data-$TS.tgz"
sha256sum "backup/post-upgrade-data-$TS.tgz" | tee "backup/post-upgrade-data-$TS.sha256"

# 现场执行 —— 8.2.3 校验升级前归档可读且哈希匹配
tar tzf "backup/backend-data-<升级前时间戳>.tgz" > /dev/null || { echo 'PRE ARCHIVE UNREADABLE -> ABORT'; exit 1; }
sha256sum -c "backup/backend-data-<升级前时间戳>.sha256" || { echo 'PRE CHECKSUM MISMATCH -> ABORT'; exit 1; }

# 现场执行 —— 8.2.4 用事务脚本回滚（自动恢复 + 校验；失败分类见 §8.3）
docker run --rm --network none --user node \
  --mount "type=volume,source=$VOL,target=/data" \
  --mount "type=bind,source=$PWD/backup,target=/backup,readonly" \
  --mount "type=bind,source=$PWD/evidence-of-deploy,target=/evidence" \
  --mount "type=bind,source=$PWD/rollback,target=/opt/rollback,readonly" \
  eldercare-cloud-backend:pre-d-e-20261026 \
  node /opt/rollback/rollback-transaction.js \
    --mode rollback --data-root /data \
    --pre-archive /backup/backend-data-<升级前时间戳>.tgz \
    --post-archive /backup/post-upgrade-data-$TS.tgz \
    --expected-pre-tree-hash "$PRE_TREE_HASH" \
    --expected-post-tree-hash "$POST_TREE_HASH" \
    --volume-name "$VOL" --backend-stopped-asserted \
    --evidence-out /evidence/rollback-result.json || RC=$?
RC=${RC:-0}

# 现场执行 —— 8.2.5 用钉住的旧镜像启动（--no-build）
if [ "$RC" -eq 0 ]; then
  docker compose --env-file deploy/.env.deploy \
    -f deploy/compose.public.yaml -f deploy/compose.pin.example.yaml up -d --no-build backend
fi

# 现场执行 —— 8.2.6 复核
docker compose --env-file deploy/.env.deploy -f deploy/compose.public.yaml ps
curl -sS -o /dev/null -w 'healthz=%{http_code}\n' https://<域名>/healthz
docker exec $(docker compose --env-file deploy/.env.deploy -f deploy/compose.public.yaml ps -q backend) \
  node -e "const d=require('/data/backend-state.json');console.log(JSON.stringify({schemaVersion:d.schemaVersion,devices:d.devices.length,alerts:(d.alerts||[]).length}))"
```

> **两个哈希怎么来**（不要凭记忆填）：
> - `PRE_TREE_HASH`：§5.4 的 preflight 输出 `.original.treeHash`（升级前卷状态）；
> - `POST_TREE_HASH`：升级完成后、停后端，对**升级后**的卷再跑一次 `--mode preflight`
>   （`--pre-archive` 用升级后归档、`--post-archive` 也用升级后归档），取 `.original.treeHash`；
>   同时把该次输出写进 `evidence-of-deploy/preflight-after-upgrade.json`。
> 两者都必须在回滚前就落盘留档。

### 8.4 退出码与对应动作（关键：几种情况分开处理）

| RC | 终态 | 动作 |
| --- | --- | --- |
| 0 | `COMPLETED` | 数据已是 v5 + 保留的升级后新增项；执行 8.2.5 用钉住旧镜像启动；启动失败 → §8.5 分类 A |
| 10 | `PREFLIGHT_ABORT` | **数据未被修改**（仍是升级后 v6）；按错误修前置条件后重试；可先用新镜像启回 |
| 20 | `RECOVERED_TO_V6` | **已自动恢复到升级后原状态并校验**；后端必须保持停止，排障后重试回滚 |
| 30 | `MANUAL_TAKEOVER_REQUIRED` | **禁止启动后端**；按 `rollback-result.json` 的 `evidence.instructions` 人工接管（`original/` 与外部升级后归档都在） |
| 2 | 硬中断 | 用 `--mode recover --op-id <opId> --expected-original-tree-hash <POST_TREE_HASH> --backend-stopped-asserted` 恢复 |
| 40 | `INTERNAL_ERROR` | **不要启动**；看 `rollback-result.json` 的 `error`/`journalWriteFailed` 与卷内 `<opId>/journal.jsonl`；按 §8.6 C 人工接管 |

### 8.5 事务目录与清理

卷内 `$VOL` 的 `.de-rollback/<opId>/` 保存 `journal.jsonl / original/ / staging / aside / quarantine`。
**成功回滚后也先整目录导出留档**（`tar czf rollback-tx-<opId>.tgz -C /data/.de-rollback <opId>`），
经确认后再删；不要对 `/data` 或 `.de-rollback` 做宽泛递归删除。

### 8.6 旧镜像启动失败 = 独立状态（不与数据回滚失败混淆）

| 分类 | 判定 | 动作 |
| --- | --- | --- |
| **A. `ROLLED_BACK_V5_DATA_RESTORED_OLD_IMAGE_NOT_RUNNING`** | §8.2 返回 0（数据 v5 已校验）但旧镜像 `up -d --no-build` 失败 | 数据**不要动**；检查 `docker image inspect eldercare-cloud-backend:pre-d-e-20261026`，缺则 `docker load < backup/image-pre-d-e-20261026.tar.gz` 并校验 sha256；解决镜像问题后再启动 |
| **B. 已自动恢复到升级后 v6 且服务停止** | §8.2 返回 20 | 数据是升级后状态；不要启动旧镜像（会读不了 v6）；排障后重做回滚，或按升级方案用新镜像启回 |
| **C. 数据状态无法确认** | §8.2 返回 30 | 保持停止；按 evidence 人工接管；**不得**以“回滚失败”一句话带过 |

Docker 级已实测 A 的两种触发方式（tag 不存在、非法 `HOUSEHOLD_TIMEZONE` 启动即退出），
两种情况下数据 treeHash 前后不变、服务保持停止。 **[DOCKER 实测]**

### 8.7 恢复升级前快照会失去什么（必须向用户说明）

恢复升级前主快照 = 回到**备份那一刻**。会失去备份之后的**全部主快照变更**：设备状态、新告警、
ACK 结果、**D 的处置记录与安全日志**、通知/订阅/交流台账。升级后留档只用于**保留与核查**：
旧代码读不了 v6，本仓库也**没有**自动 v6→v5 合并能力。

## 9. 本地源码回退（不是部署回退）

1. 先核对当前哈希（`SOURCE-HASHES.txt`，136 条）与并行改动（mtime 对比）；
2. 不得整文件覆盖；用 `2026-10-26-d-e-candidate-freeze/_work/before-after/*.before`（10 文件，改前哈希已校验）逐字节还原；
3. 回退后重跑 `npm run check`、`npm test`（287/287）、`hvigor test`（39）、`assembleHap`。

## 10. APP 回退

前提：同签名、目标设备（历史验收是模拟器）、数据保留。**不得**卸载清数据/改信任链/关签名校验。
回退目标 `9EEBEE…`（不是 `8A722…`）；版本号与候选相同，必须用哈希区分。

## 11. 证据分级与本次已验证/未验证

| 层级 | 状态 |
| --- | --- |
| 卷内回滚状态机（文件级逻辑，14 例） | ✅ 本次真实运行 `FILE_LEVEL_HARDENING_VERIFIED` |
| Docker 卷/容器级（29 项，含 11 类注入 + 镜像固定 + 属主权限 + 旧服务写入） | ✅ 本次真实运行 `DOCKER_VOLUME_VALIDATION_PASS`（**沙箱**，非生产主机） |
| 生产主机上的同名命令 | ❌ 未执行（[文档推演]），卷名/路径/权限需现场核对 |
| 真实历史 v5 镜像 | ❌ 不存在于工作区；Docker 验证用 v5 等价模拟（非历史制品），**不构成旧版兼容验收** |
| 真机 APP 安装/回退 | ❌ 未执行 |

## 12. 现场检查清单

- [ ] §1 只读核验完成并回填当前状态（不要沿用历史记录当事实）
- [ ] 已决定 D/E 上线范围
- [ ] 旧镜像已 tag + `docker save` + 回读校验
- [ ] 已进入维护窗口并停止后端
- [ ] 卷名从容器解析 + `docker volume inspect` 通过
- [ ] 升级前整卷备份可读/非空/sha256 记录/schema 与活动文件存在性留档
- [ ] 已用 preflight 模式记录 `PRE_TREE_HASH` 与 `POST_TREE_HASH`
- [ ] 升级后按 §7.2 用**有效会话**验收（不是匿名 401）
- [ ] 回滚前已做升级后整卷留档
- [ ] 回滚按 RC 分支处理（0/10/20/30/2 各自动作不同）
- [ ] 旧镜像启动失败按 §8.6 的 A/B/C 分类处理，不混为一谈
- [ ] 事务目录已导出留档后再清理
- [ ] 已向用户说明“恢复旧快照会丢失备份后全部主快照变更”
