# DEPLOY-RUNBOOK — D/E 组合候选的公网升级与回滚操作单（纠正版）

- 日期：2026-10-26（Asia/Shanghai）
- 定位：**替代** `competition/evidence/2026-10-26-alert-disposition-safety-log/DEPLOY-DIFF-AND-ROLLBACK.md`
  中“现场事实 / 验收判据 / 回滚命令”三部分。旧文件按要求**保持原貌**，不修改。
- 本任务**没有**接触任何现场：没有登录公网主机、没有 `docker` 命令打到生产、没有访问生产 API/数据卷/设备。
- 本文件里所有带 `# 现场执行` 的命令**都未被执行**，只是待授权的操作单。

```text
本文可被引用的结论等级：
  本次运行验证     → 见 ROLLBACK-REHEARSAL.md（文件级/进程级隔离演练，真实结果）
  仅文档推演       → 本文件中的 Docker/容器级步骤（本机 Docker daemon 不可用，未验证）
  现场未知         → 公网主机当前镜像、数据卷内容、设备安装版本、证书状态
  需用户授权       → 全部部署/回滚/安装动作
```

## 0. 必须替换的旧判据与旧表述（逐条纠正）

| # | 旧文档的问题 | 本操作单的处理 |
| --- | --- | --- |
| 1 | 把“当前生产合同 v1.0.0、schema v5、无活动文件、设备仍安装历史包”当成**当前事实** | 一律降级为**历史记录（截至 2026-10-26 交接）**或**部署前待核验项**，见 §1 |
| 2 | 用“匿名访问新接口返回 401、旧版返回 404”判断部署是否成功 | **删除该判据**（原因见 §7.1）。改为：制品身份 + 有效会话下的响应 + 字段合同 |
| 3 | 只记录旧镜像 ID，然后直接 `docker compose up -d` | 改为**镜像打版本标签 + `docker save` 留档 + Compose 覆盖文件固定镜像 + `--no-build`**，见 §4 |
| 4 | 直接 `docker exec … tar czf - -C /data .` 当作一致备份 | 明确“运行态目录 tar 不保证一致”，改为**维护窗口内先停后端再备份**，并区分会中断服务的步骤，见 §5 |
| 5 | `rm -f /data/backend-state.json && tar xzf -` 这种“先删后恢复”的命令链 | 改为**校验 → staging → 移走（不删）→ 落位 → 复核**，任一步失败即中止，见 §8 |
| 6 | 没有说清恢复旧快照会丢什么 | 明确列出失去的**全部主快照变更**（设备状态/告警/ACK/处置/安全日志），并说明留档只用于保留与核查，见 §8.5 |
| 7 | 本地源码回退直接整文件覆盖 | 改为**先核对哈希与并行改动**，再用 `before-after` 逐字节还原，见 §9 |
| 8 | APP 回退只说“重装旧包” | 补**同签名、目标设备、数据保留**前提，并声明未经验证不得保证可回装，见 §10 |

## 1. 现场状态：全部是待核验项，不是已知事实

| 项 | 交接文档的历史记录 | 本任务立场 |
| --- | --- | --- |
| 公网 API 域名 | `https://api.luxunacc.xyz` | 需现场只读确认 DNS/TLS 仍指向同一主机 |
| 生产合同版本 | 截至 2026-10-26 交接记录为 **v1.0.0**，无 dispositions/safety-logs/activity 接口 | **需核验**，不得直接引用为当前事实 |
| 主快照 schema | 记录为 **v5** | **需核验**（读 `/data/backend-state.json` 的 `schemaVersion`） |
| 活动状态文件 | 记录为**不存在** | **需核验**（`ls /data/activity-state.json`） |
| 已部署镜像 | 记录为本地构建的 `eldercare-cloud-backend:local` | **需核验**镜像 Digest 与容器实际使用的 Image ID |
| 手机安装的 APP | 最近真实验收包 `9EEBEE…`（2,086,949 B） | **需核验**设备上的实际版本/哈希 |
| Caddy/证书/卷 | 记录为 `caddy-data`、`caddy-config`、`backend-data` | **需核验**卷名与健康状态 |

**前置只读核验命令（不改变任何状态，现场执行）**：

```bash
# 现场执行（只读）
docker compose --env-file deploy/.env.deploy -f deploy/compose.public.yaml ps
docker inspect --format '{{.Name}} image={{.Image}}' $(docker compose --env-file deploy/.env.deploy -f deploy/compose.public.yaml ps -q backend)
docker images --digests --format '{{.Repository}}:{{.Tag}} {{.ID}} {{.Digest}} {{.CreatedAt}}'   # 本地构建镜像 Digest 为 <none>，以 Image ID 为准
docker volume ls | grep -E 'backend-data|caddy-data|caddy-config'
curl -sS -o /dev/null -w 'healthz=%{http_code} ' https://<域名>/healthz
curl -sS -o /dev/null -w 'readyz=%{http_code}\n' https://<域名>/readyz
```

> 只有**带有效会话**才能确认接口存在性（§7）。匿名请求一律 401，见 §7.1。

## 2. 制品身份（先确认部署的是哪一个）

| 制品 | 身份 | 说明 |
| --- | --- | --- |
| 后端源码/镜像 | `competition/evidence/2026-10-26-d-e-release-prep/d-e-candidate-source-2026-10-26.zip` 内的 `competition/cloud/backend`（构建上下文 = `competition/cloud/backend`） | 归档逐文件哈希见 `SOURCE-ARCHIVE-MANIFEST.md` |
| 手机 APP 候选 | `guardian-d-e-candidate-2026-10-26-unsigned.hap`，2,621,844 B，`7634A0E25FCE3E19FC9604E4CD94D6D6BAFF36CB5DE67C92DAEE0E50C1452EB5`，**unsigned** | 未签名、未安装；不能作为回退目标 |
| 手机 APP 回退目标 | `9EEBEE9A5FC9EEC5A5993DC6923F16F0BFCCCD1CD4DE64BAF36FC7197ECAD25A`（2,086,949 B） | **最近已真实验收**；`8A722…` 是更早包，不作默认基线 |
| 合同 | `APP-API-v1.md` / `.json` 版本 **1.2.0** | 部署后必须与镜像内源码一致 |

部署前必须用**镜像 Image ID**（不是 tag）记录“这次跑的是哪份代码”；镜像若来自 registry，再补记 RepoDigest：

```bash
# 现场执行（构建前记录一次，部署后再记录一次）
docker image inspect eldercare-cloud-backend:local --format '{{.Id}}'   # 本地构建的镜像 <none> 没有 RepoDigest；若镜像来自 registry，另记录 docker inspect --format '{{index .RepoDigests 0}}'
```

## 3. 部署前决策项（必须先答，不能默认）

1. **D 与 E 是否一起上线**：本候选镜像天然同时包含两者（`server.js`/`main.js`/`package.json` 共享）。
   只上 D 需要另做共享文件拆分并重跑全量测试，**本操作单不提供该拆分**。
2. **维护窗口**：本次升级会**中断**后端服务（§5 备份阶段起）。
3. **数据兼容已确认**：新镜像加载 v1–v5 快照可读，**第一次成功写入即写 schemaVersion 6**；
   这是不可逆的格式升级（在回滚恢复快照之前）。
4. **家庭时区**：部署环境需确认 `HOUSEHOLD_TIMEZONE`（默认 `Asia/Shanghai`）。
   **非法值会让后端拒绝启动**；该变量在当前 `compose.public.yaml` 未注入，将走默认值——
   若现场需要非默认时区，必须在 `compose` 中显式注入并与 `deploy/.env.deploy` 同步。
5. **活动文件路径**：默认 `/data/activity-state.json`（与主快照同卷）。不要指向容器临时层。

## 4. 镜像保留与固定（纠正“只记 ID 就 `up -d`”）

问题：`compose.public.yaml` 里 backend 同时有 `build:`（context `../cloud/backend`）和
`image: eldercare-cloud-backend:local`。直接 `docker compose up -d` 在镜像缺失时会**重新构建**，
在新代码已经落盘的情况下可能把你不想上的版本拉起来；而 `:local` 这个 tag 会被覆盖，
“旧 ID”在 `docker image prune` 或主机重建后就没了。

正确做法（三步，先做旧的、再做新的）：

```bash
# 现场执行 —— 0) 全程 fail-fast：任何一条失败都停，不允许带着“没留存旧镜像”继续升级
set -euo pipefail
mkdir -p backup evidence-of-deploy && chmod 700 backup evidence-of-deploy

# 现场执行 —— 1) 给当前在跑的旧镜像打版本标签（先固定“回退目标”）
OLD_IMAGE=$(docker inspect --format '{{.Image}}' $(docker compose --env-file deploy/.env.deploy -f deploy/compose.public.yaml ps -q backend))
[ -n "$OLD_IMAGE" ] || { echo 'NO RUNNING BACKEND CONTAINER -> ABORT'; exit 1; }
docker tag "$OLD_IMAGE" eldercare-cloud-backend:pre-d-e-20261026
docker image inspect eldercare-cloud-backend:pre-d-e-20261026 --format '{{.Id}}' | tee evidence-of-deploy/old-image-id.txt

# 现场执行 —— 2) 把旧镜像导出成文件，保证 prune/主机重建后仍可回退
#   先写临时文件、校验通过后再改名，避免半截文件被当成有效归档
docker save eldercare-cloud-backend:pre-d-e-20261026 | gzip -9 > backup/image-pre-d-e-20261026.tar.gz.partial
gzip -t backup/image-pre-d-e-20261026.tar.gz.partial
mv backup/image-pre-d-e-20261026.tar.gz.partial backup/image-pre-d-e-20261026.tar.gz
sha256sum backup/image-pre-d-e-20261026.tar.gz | tee backup/image-pre-d-e-20261026.sha256
chmod 600 backup/image-pre-d-e-20261026.tar.gz
# 回读校验：必须能与 tag 对上，否则回滚时可能 load 到坏归档
gunzip -c backup/image-pre-d-e-20261026.tar.gz | docker load --quiet

# 现场执行 —— 3) 用覆盖文件把镜像“钉死”，安装时不构建
cat > deploy/compose.pin-pre-d-e.yaml <<'YAML'
name: eldercare-public
services:
  backend:
    image: eldercare-cloud-backend:pre-d-e-20261026
YAML
[ -s deploy/compose.pin-pre-d-e.yaml ] || { echo 'PIN OVERRIDE NOT WRITTEN -> ABORT'; exit 1; }
```

- **升级**：`docker compose … build --no-cache` → `docker compose … up -d`（会重新打 `:local`）。
- **回滚启动**：`docker compose -f compose.public.yaml -f compose.pin-pre-d-e.yaml … up -d --no-build backend`
  —— `--no-build` 保证不会因为上下文变化而偷偷重建；覆盖文件保证用的是版本标签。
- 若旧镜像已被清理：先 `docker load < backup/image-pre-d-e-20261026.tar.gz`，校验 sha256 后再启动。
- 禁止把 `:pre-d-e-20261026` 这个标签重新打给新镜像（会毁掉回退目标）。

## 5. 数据备份（纠正“运行态 tar 即一致快照”）

> **读权限前提（重要，别凭直觉）**：后端写主快照与活动文件时使用
> `fs.openSync(tempPath, 'wx', 0o600)`（`persistent-store.js:644`、`activity-store.js:74`），
> 文件是 **0600**，属主是镜像里的 `node`（Dockerfile `USER node`，UID 1000）。
> 因此**只有 root 或 UID 1000 能读**。备份容器若用任意主机 UID 跑，在多数主机上会 EACCES，
> 强制备份直接失败——所以下面备份/导出一律用 `--user 0` 读、**用主机重定向写文件**，
> 避免在主机上留下 root 拥有的归档（否则后续 `chmod 600` 会失败）。

**结论：容器运行时的目录级 `tar /data` 不保证是一致快照。** 原因：后端每次变更都会原子替换
主快照文件，但目录里还有其他文件（`evidence/` 与 `activity-state.json`），
跨文件的时点无法靠一次目录 tar 保证；而且升级后主快照会从 v5 变 v6，备份文件必须严格对应
“升级前那一刻”。

因此采用**维护窗口内停后备份**：

| 步骤 | 命令（现场执行） | 是否中断服务 |
| --- | --- | --- |
| 5.1 进入维护窗口，停后端（不删卷） | `docker compose … stop backend` | **是**：摄取、APP 查询、ACK 命令轮询全部中断 |
| 5.2 确认容器已停止 | `docker compose … ps`（backend 应为 exited） | 否 |
| 5.3 用一次性容器把整个卷打成一个 tar（只读挂载） | 见下 | 否 |
| 5.4 校验归档可读 + 记录哈希 + 记录 schema 与活动文件是否存在 | 见下 | 否 |
| 5.5 备份成功后才允许进入 §6 升级 | — | — |

```bash
# 现场执行 —— 5.3/5.4 备份与核验
set -euo pipefail
TS=$(date +%Y%m%d-%H%M%S)
mkdir -p backup evidence-of-deploy && chmod 700 backup evidence-of-deploy

# 5.3.0 先从**已停止的容器**解析真实卷名，再校验它存在。
# 注意必须用 `ps -aq`：backend 在 5.1 已 stop，`ps -q` 只列运行中的容器会返回空。
# 直接写死卷名会在名字不符时让 docker 自动创建一个空卷 => “备份成功但内容是空的”。
VOL=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' \
  $(docker compose --env-file deploy/.env.deploy -f deploy/compose.public.yaml ps -aq backend))
[ -n "$VOL" ] || { echo 'CANNOT RESOLVE /data VOLUME -> ABORT'; docker volume ls; exit 1; }
docker volume inspect "$VOL" > /dev/null || { echo "VOLUME $VOL NOT FOUND -> ABORT"; exit 1; }
echo "$VOL" | tee evidence-of-deploy/data-volume.txt

# 5.3.1 以 root 只读挂载（文件是 0600，属主 UID 1000；非 root 且非 1000 会 EACCES），
#        用**主机重定向**把 tar 写到主机，归档属主是本机操作者，后续 chmod 才有效。
docker run --rm --user 0 --entrypoint sh \
  -v "$VOL":/data:ro eldercare-cloud-backend:local \
  -c "tar czf - -C /data ." > "backup/backend-data-$TS.tgz.partial"
tar tzf "backup/backend-data-$TS.tgz.partial" > /dev/null || { rm -f "backup/backend-data-$TS.tgz.partial"; echo 'BACKUP UNREADABLE -> ABORT'; exit 1; }
[ -s "backup/backend-data-$TS.tgz.partial" ] || { rm -f "backup/backend-data-$TS.tgz.partial"; echo 'BACKUP EMPTY -> ABORT'; exit 1; }
mv "backup/backend-data-$TS.tgz.partial" "backup/backend-data-$TS.tgz"
chmod 600 "backup/backend-data-$TS.tgz"
sha256sum "backup/backend-data-$TS.tgz" | tee "backup/backend-data-$TS.sha256"

# 5.4 记录升级前格式与活动文件是否存在（这是回滚判断依据，必须留档）
docker run --rm --user 0 --entrypoint sh \
  -v "$VOL":/data:ro eldercare-cloud-backend:local \
  -c 'node -e "const d=require(\"/data/backend-state.json\");console.log(JSON.stringify({schemaVersion:d.schemaVersion,devices:d.devices.length,alerts:(d.alerts||[]).length}))" ; ls -l /data/activity-state.json 2>/dev/null || echo ACTIVITY_FILE_ABSENT'
```

**判定规则（全部满足才能继续）**：

- 卷名已从容器解析并 `docker volume inspect` 通过（不是猜的）；
- 归档 `tar tzf` 可读、非空、sha256 已记录；
- 主快照存在且 `schemaVersion` 为预期值（历史记录是 5，以现场读数为准）；
- 明确记录 `ACTIVITY_FILE_ABSENT` 或活动文件大小/哈希；
- 备份文件已限权，未进入版本控制/日志/聊天。

任何一条失败 → **停止升级**，把后端按原镜像启动回去（`up -d --no-build` 用 §4 的 pin 覆盖文件）。

> 注：备份内容是**个人数据**（联系人、设备坐标、告警、处置记录）。归档即敏感数据，必须限权与加密留存，
> 不得贴进聊天/工单/报告。

## 6. 升级执行

```bash
# 现场执行（前置：§5 备份与判定全部通过；已记录旧镜像 tag 与 digest）
set -euo pipefail
docker compose --env-file deploy/.env.deploy -f deploy/compose.public.yaml build --no-cache backend
docker image inspect eldercare-cloud-backend:local --format '{{.Id}}' | tee evidence-of-deploy/new-image-id.txt
# 本地镜像没有 RepoDigest；如镜像 push 到 registry，再补记 docker inspect --format '{{index .RepoDigests 0}}'
docker compose --env-file deploy/.env.deploy -f deploy/compose.public.yaml up -d
docker compose --env-file deploy/.env.deploy -f deploy/compose.public.yaml ps
```

- **禁止** `docker compose down -v`（会删除 `backend-data` 与 Caddy 证书卷）。
- 不改 `Caddyfile`、不改 DNS/端口/绑定。
- 首次写入后主快照会变 v6 —— 从这一刻起**旧镜像不能直接读该卷**，回滚必须走 §8。

## 7. 部署后验收（纠正“匿名 401/404”判据）

### 7.1 为什么不能用匿名 401 判断部署成功

源码里 `/api/v1/*` 的鉴权在业务路由**之前**统一执行：

```text
competition/cloud/backend/src/server.js:513  const identity = bearer(request, tokenSecret);
competition/cloud/backend/src/server.js:514  if (!identity) return sendJson(response, 401, ...);
competition/cloud/backend/src/server.js:515  if (!isAuthorized(identity.sub)) return sendJson(response, 403, ...);
competition/cloud/backend/src/server.js:517  if (... path === '/api/v1/overview') ...
```

所以匿名访问**任何** `/api/v1/...`（包括根本不存在的路径）都会先得到 `401`。
“401 而不是 404”既不能证明接口存在，也不能证明镜像已更新。

### 7.2 正确的验收顺序（全部现场执行）

| 顺序 | 检查 | 通过标准 |
| --- | --- | --- |
| 1 | **制品身份** | 运行容器 `Image` 的 ID 等于 §6 记录的 new-image-id（本地构建镜像没有 RepoDigest，以 Image ID 为准；镜像来自 registry 时再核对 digest） |
| 2 | 进程健康 | `/healthz` 200、`/readyz` 200（这两个**不需要**鉴权） |
| 3 | 主快照版本 | 容器内读 `schemaVersion`，应为 **6**（首次写入之后） |
| 4 | 既有接口未回归 | 用有效会话请求 `/api/v1/overview`、`/api/v1/devices`、`/api/v1/alerts`，字段与 1.2.0 合同一致 |
| 5 | D 新接口 | 有效会话 `GET /api/v1/safety-logs?limit=5` → 200 且 `{logs: []}`（不是 404）；`GET /api/v1/alerts/{已知alarmId}/dispositions` → 200 |
| 6 | E 新接口 | 有效会话 `GET /api/v1/activity/report?scope=day` → 200，字段含 `dataSince`（number）、`range.from/to/days`、`summary`、`days[]`、`disclaimer` |
| 7 | 旧接口未被误判 | 有效会话请求一个不存在的路径（如 `/api/v1/does-not-exist`）应得 **404** —— 用它来证明“404 语义仍在”，而不是用匿名 401 |

### 7.3 凭据处理（Token 不得进命令历史/日志/报告）

- 监护人登录口令由用户自己输入；本操作单不索取、不记录。
- 会话 Token **不要**写在命令行（会进 shell history、`ps`、CI 日志）。安全做法二选一：
  - 放在 `0600` 的文件里，用 `curl --config <file>`（文件内容 `header = "Authorization: Bearer …"`）；
  - 或用本地 Node 脚本从**环境变量**读取（`env -i` 方式注入，避免写历史），脚本不打印 Token。
- 任何响应/日志截取前先脱敏；`docker compose config` 会打印解析后的密钥，**禁止**重定向到文件或日志。

## 8. 回滚（纠正“先删后恢复”与“没写清丢什么”）

### 8.1 三条铁律

1. **先完整保留升级后数据**，再做任何恢复动作；
2. 校验、留档、恢复**任一步失败都必须中止**，不得继续；
3. **不删除**原有文件——移走留档，不 `rm`。

### 8.2 步骤（现场执行；本任务未执行，仅文件级等价演练见 ROLLBACK-REHEARSAL.md）

```bash
# 现场执行 —— 8.2.1 停止后端（保留卷）并重新解析真实卷名
set -euo pipefail
TS=$(date +%Y%m%d-%H%M%S)
docker compose --env-file deploy/.env.deploy -f deploy/compose.public.yaml stop backend
VOL=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' \
  $(docker compose --env-file deploy/.env.deploy -f deploy/compose.public.yaml ps -aq backend))
[ -n "$VOL" ] || { echo 'CANNOT RESOLVE /data VOLUME -> ABORT'; exit 1; }
docker volume inspect "$VOL" > /dev/null || { echo "VOLUME $VOL NOT FOUND -> ABORT"; exit 1; }

# 现场执行 —— 8.2.2 先把“升级后完整数据”导出留档（关键，不可跳过）
# 以 root 读（文件 0600 / UID 1000），用主机重定向落盘，归档属主是本机操作者。
docker run --rm --user 0 --entrypoint sh \
  -v "$VOL":/data:ro eldercare-cloud-backend:local \
  -c "tar czf - -C /data ." > "backup/post-upgrade-data-$TS.tgz.partial"
tar tzf "backup/post-upgrade-data-$TS.tgz.partial" > /dev/null || { rm -f "backup/post-upgrade-data-$TS.tgz.partial"; echo 'POST-UPGRADE ARCHIVE UNREADABLE -> ABORT'; exit 1; }
[ -s "backup/post-upgrade-data-$TS.tgz.partial" ] || { rm -f "backup/post-upgrade-data-$TS.tgz.partial"; echo 'POST-UPGRADE ARCHIVE EMPTY -> ABORT'; exit 1; }
mv "backup/post-upgrade-data-$TS.tgz.partial" "backup/post-upgrade-data-$TS.tgz"
chmod 600 "backup/post-upgrade-data-$TS.tgz"
sha256sum "backup/post-upgrade-data-$TS.tgz" | tee "backup/post-upgrade-data-$TS.sha256"
# 必须确认升级后数据里确实有 activity 文件留档（有 E 数据时）
tar tzf "backup/post-upgrade-data-$TS.tgz" | grep -q 'activity-state.json' \
  && echo 'ACTIVITY_ARCHIVED' || echo 'ACTIVITY_NOT_PRESENT_IN_ARCHIVE (若升级后确实没有活动数据则属正常，需人工确认)'

# 现场执行 —— 8.2.3 校验“升级前备份”可读且哈希匹配（不匹配就中止）
tar tzf "backup/backend-data-<升级前时间戳>.tgz" > /dev/null || { echo 'PRE ARCHIVE UNREADABLE -> ABORT'; exit 1; }
sha256sum -c "backup/backend-data-<升级前时间戳>.sha256" || { echo 'PRE ARCHIVE CHECKSUM MISMATCH -> ABORT'; exit 1; }

# 现场执行 —— 8.2.4 解到主机 staging（不直接写数据卷），并放开只读位给容器内的 node 读取
rm -rf restore-staging && mkdir -p restore-staging
tar xzf "backup/backend-data-<升级前时间戳>.tgz" -C restore-staging
test -f restore-staging/backend-state.json || { echo 'STAGING MISSING STATE -> ABORT'; exit 1; }
chmod -R a+rX restore-staging    # 备份里是 0600；不放开则 --user node 无法读取 staging

# 现场执行 —— 8.2.5 把卷内现有文件“移走留档”（不删除），再落位 staging
# 以 node 用户（镜像内 UID 1000，/data 的属主）运行，保证恢复后的文件属主与后端运行用户一致；
# 若用 root 落位，/data 里会出现 root 拥有、后端无法改写的文件，属于隐蔽故障源。
docker run --rm --user node --entrypoint sh \
  -v "$VOL":/data -v "$PWD/restore-staging":/staging:ro \
  eldercare-cloud-backend:local -c "
    set -e
    mkdir -p /data/_rollback-archive-$TS
    for f in backend-state.json activity-state.json evidence; do
      if [ -e \"/data/\$f\" ]; then mv \"/data/\$f\" \"/data/_rollback-archive-$TS/\"; fi
    done
    cp -R /staging/. /data/
    test -f /data/backend-state.json
    # 可写性自检：后端运行时以 node 身份原子替换主快照，恢复出的文件必须对 node 可写
    [ -w /data/backend-state.json ] || { echo 'RESTORED STATE NOT WRITABLE BY BACKEND USER -> ABORT'; exit 1; }
  " || { echo 'RESTORE STEP FAILED -> data left in /data/_rollback-archive-'"$TS"' ; ABORT'; exit 1; }

# 现场执行 —— 8.2.6 用钉住的旧镜像启动（--no-build 防止重建新代码）
docker compose --env-file deploy/.env.deploy \
  -f deploy/compose.public.yaml -f deploy/compose.pin-pre-d-e.yaml up -d --no-build backend

# 现场执行 —— 8.2.7 复核
docker compose --env-file deploy/.env.deploy -f deploy/compose.public.yaml ps
curl -sS -o /dev/null -w 'healthz=%{http_code}\n' https://<域名>/healthz
# 容器内确认已回到 v5 且设备/告警仍在（脚本里不要用 -it，非 TTY 会失败）
docker exec $(docker compose --env-file deploy/.env.deploy -f deploy/compose.public.yaml ps -q backend) \
  node -e "const d=require('/data/backend-state.json');console.log(JSON.stringify({schemaVersion:d.schemaVersion,devices:d.devices.length,alerts:(d.alerts||[]).length}))"
```

### 8.3 中止与恢复规则

- 8.2.2 或 8.2.3 失败：**不要**碰数据卷，直接按原镜像把后端起回去（仍在升级后状态），
  排障后再重试回滚。
- 8.2.5 失败：卷内 `/data/_rollback-archive-<TS>/` 保留了原文件；**不要**删它，
  按 `cp -R`（与 8.2.5 落位方式一致，不要用 `cp -a`，否则可能带出 staging 的操作者属主）
  反方向把文件放回即可回到升级后状态。
- 8.2.6 启动失败：先确认镜像标签存在（`docker image inspect eldercare-cloud-backend:pre-d-e-20261026`），
  必要时 `docker load < backup/image-pre-d-e-20261026.tar.gz`；数据卷此时已是 v5，不影响镜像排障。
- 任何情况下都不要执行 `docker compose down -v`。

### 8.4 活动文件（E）的去留

- 升级后新增的 `/data/activity-state.json` **默认不删除**：8.2.5 把它移进 `_rollback-archive-<TS>/`。
- 旧版代码不读它；若要保留活动历史，把该文件另存到卷外留档（上面已随整卷 tar 留档一份）。
- `_rollback-archive-<TS>/` 在确认无需回滚后，**必须整体导出留档**才能删除，不得直接 `rm -rf` 了事。

### 8.5 恢复升级前快照会失去什么（必须向用户明确说明）

恢复升级前主快照 = 回到**备份那一刻**的主快照状态。因此会失去备份之后发生的**全部主快照变更**：

| 失去的内容 | 说明 |
| --- | --- |
| 设备状态更新 | `devices[]` 的 lastSeen、在线状态、传感器读数 |
| 新告警 | 备份后产生/更新过的告警记录 |
| ACK 结果 | 备份后完成的 ACK 状态、回执时间、回执人 |
| **D 的处置记录与安全日志** | `safetyLogs[]` 全部消失（v5 格式没有该字段） |
| 通知/订阅台账、交流消息 | 若备份后有变更同样回到备份时点 |

**升级后数据的留档只用于“保留与核查”**：

- 它保存在 `backup/post-upgrade-data-<TS>.tgz` 与卷内 `_rollback-archive-<TS>/`；
- **旧代码不能读 v6**（在隔离演练中验证：v5 等价模拟读取 v6 快照报 `persistent store unsupported schemaVersion: 6`）；
- 本任务**没有**、本仓库**也没有**自动合并 v6→v5 的工具：
  从 v6 存档里人工抽取 `safetyLogs` 等记录属于**另行开发**，不得视为已具备能力。

## 9. 本地源码回退（纠正“直接整文件覆盖”）

1. **先核对当前哈希**，确认工作树仍是冻结候选：
   ```powershell
   # 与冻结的 SOURCE-HASHES.txt 逐条比对（136 条；可直接复用冻结目录里的校验方式）
   ```
2. **先查并行改动**：比对文件 mtime 与 `PRE-EDIT-SNAPSHOT.txt`；若发现本任务之外的改动，
   不得整文件覆盖，需逐处合并。
3. **用逐字节改前副本还原**：`2026-10-26-d-e-candidate-freeze/_work/before-after/*.before`
   （10 个文件，改前哈希已校验）。不要用旧清单/旧快照覆盖整棵目录。
4. 回退后重跑：`npm run check`、`npm test`（期望 287/287）、`hvigor test`（39）、`assembleHap`。
5. 本地源码回退**不影响**已部署镜像；两者是分开的动作。

## 10. APP 回退（纠正“直接重装旧包”）

前提确认（缺一不可）：

1. **同签名**：回退包必须与原安装包同一签名证书/身份，否则安装会失败或需要卸载（**禁止**卸载清数据）。
2. **目标设备**：历史验收目标是模拟器（Mate 90 Pro 型），**实体手机兼容性未验收**；
   不得假定旧包在任何设备上都可直接回装。
3. **数据保留**：正常覆盖安装保留应用数据；若签名不一致则无法保留，此时**停止**并上报，
   不得通过卸载/清数据或改信任链、关签名校验来绕过。
4. **回退目标**：`9EEBEE9A…ECAD25A`（2,086,949 B）——**不是** `8A722…`。
5. 安装后核对：包名 `com.example.program_04`、版本 `1.0.0/1000000`、以及设备侧实际哈希/版本；
   版本号与候选包相同，**必须用哈希区分**。

## 11. 本任务未验证的层级（如实声明）

| 层级 | 状态 | 原因 / 后续 |
| --- | --- | --- |
| 文件级升级·持久化·回滚·失败保护 | ✅ **本次真实运行验证** | 见 `ROLLBACK-REHEARSAL.md`，12 步 + 3 个失败保护全部通过 |
| 容器级镜像固定（tag/save/override/`--no-build`） | ❌ **未验证（仅文档推演）** | 本机 `docker` client 存在但 **daemon 不可用**（`docker info` 退出 1）；不得为此安装 Docker 或启动现有演示服务 |
| 公网主机备份/恢复命令 | ❌ 未验证 | 需现场授权。脚本已改为**从运行容器解析 `/data` 卷名**并用 `docker volume inspect` 校验（不再写死卷名），该逻辑本身未在真实 Docker 上运行过 |
| 真实旧版二进制兼容 | ❌ 未验证（也不可能） | 工作区不存在真实 v5 后端制品（已穷举搜索）；演练用的是明确标注的 v5 等价模拟 |
| 真机 APP 安装/回退 | ❌ 未验证 | 需签名材料、设备与用户操作 |

**Docker 可用后如何补验容器级步骤**（本任务未执行）：

```bash
# 在隔离的独立项目名下验证镜像固定，不复用现有演示容器/卷/网络
docker compose -p de-runbook-sandbox --env-file <隔离的 env 文件> \
  -f deploy/compose.public.yaml -f deploy/compose.pin-pre-d-e.yaml up -d --no-build backend
docker compose -p de-runbook-sandbox ps
# 结束后仅清理这个独立项目：docker compose -p de-runbook-sandbox down（不加 -v 之前先确认卷是本项目临时卷）
```

## 12. 现场检查清单（逐项打勾才能继续）

- [ ] 已做 §1 只读核验，并**更新**“当前状态”记录（不要沿用历史记录当事实）
- [ ] 已明确 D/E 上线范围
- [ ] 已记录旧镜像 ID/Digest、已打版本标签、已 `docker save` 并校验
- [ ] 已确认 `HOUSEHOLD_TIMEZONE` 取值策略
- [ ] 已进入维护窗口并**停止**后端
- [ ] 备份 tar 可读、sha256 已记录、schemaVersion 与 activity 文件存在性已留档
- [ ] 备份失败则已中止，未继续升级
- [ ] 升级后已按 §7.2 用**有效会话**验证（不是匿名 401）
- [ ] 已确认主快照为 v6
- [ ] 已把“恢复旧快照会丢失备份后全部主快照变更（含处置/安全日志）”告知用户并留痕
- [ ] 回滚前已导出升级后完整数据并校验可读
- [ ] 回滚使用 `--no-build` + 钉住的旧镜像标签
- [ ] 回滚后 `_rollback-archive-*` 已导出留档，未直接删除
