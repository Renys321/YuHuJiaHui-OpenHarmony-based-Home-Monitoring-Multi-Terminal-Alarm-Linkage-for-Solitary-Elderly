# D/E 生产部署执行单（现场执行；本机尚未执行）

> 权威依据：`competition/evidence/2026-10-26-d-e-rollback-hardening/DEPLOY-RUNBOOK.md`（v2）。
> 本文件只补充**本次制品**的具体取值与命令，不替代那份 runbook 的判定规则。
> 前置：维护窗口已确认、主机可访问、`deploy/.env.deploy` 已存在且权限 600。

## 0. 本次要部署的制品

| 项 | 值 |
|---|---|
| 镜像 tag | `eldercare-cloud-backend:de-2026-10-26` |
| Image ID | `sha256:ed481503ff4883e83cd7f485d07768f7a29b69282f67d81439c9d79238fdada0` |
| 镜像归档 | `build/eldercare-cloud-backend-de-2026-10-26.tar`（61,751,296 B，SHA-256 `A9CBB12F2C9A9E71A0097123B9BCA7F90B94DDCED6AFF1F9CBB2AD0B06E86C62`） |
| 覆盖文件 | `deploy/compose.pin-de.yaml`（把 backend 钉到上面的 tag） |
| 预期 schema | 主快照 v5→**v6**；活动文件从无到有 `version=1` |

## 1. 上传镜像（从本机到主机；只传制品，不传源码/密钥）

```bash
# 本机执行（scp 目标由用户提供；不要在命令历史里放口令）
scp build/eldercare-cloud-backend-de-2026-10-26.tar <user>@<host>:~/backup/
sha256sum build/eldercare-cloud-backend-de-2026-10-26.tar   # 必须等于 A9CBB12F…86C62
```

```bash
# 主机执行
set -euo pipefail
sha256sum ~/backup/eldercare-cloud-backend-de-2026-10-26.tar   # 核对一致
docker load -i ~/backup/eldercare-cloud-backend-de-2026-10-26.tar
docker image inspect eldercare-cloud-backend:de-2026-10-26 --format '{{.Id}}'   # 必须 ed481503…
```

## 2. 钉住旧镜像（回退目标；不改生产数据）

在主机 `competition/`（含 `deploy/` 的目录）执行，复制 rollback-hardening runbook §4 的命令：

```bash
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
gunzip -c backup/image-pre-d-e-20261026.tar.gz | docker load --quiet
cat > deploy/compose.pin-pre-d-e.yaml <<'YAML'
name: eldercare-public
services:
  backend:
    image: eldercare-cloud-backend:pre-d-e-20261026
YAML
```

## 3. 维护窗口：停后端 + 整卷备份 + 校验（任一步失败即中止）

```bash
set -euo pipefail
docker compose --env-file deploy/.env.deploy -f deploy/compose.public.yaml stop backend
VOL=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' \
  $(docker compose --env-file deploy/.env.deploy -f deploy/compose.public.yaml ps -aq backend))
[ -n "$VOL" ] || { echo 'CANNOT RESOLVE /data VOLUME -> ABORT'; docker volume ls; exit 1; }
docker volume inspect "$VOL" > /dev/null
save_vol() { echo "$VOL" | tee evidence-of-deploy/data-volume.txt; }
save_vol
TS=$(date +%Y%m%d-%H%M%S)
docker run --rm --user 0 --entrypoint sh -v "$VOL":/data:ro eldercare-cloud-backend:pre-d-e-20261026 \
  -c "tar czf - -C /data ." > "backup/backend-data-$TS.tgz.partial"
tar tzf "backup/backend-data-$TS.tgz.partial" > /dev/null
[ -s "backup/backend-data-$TS.tgz.partial" ]
mv "backup/backend-data-$TS.tgz.partial" "backup/backend-data-$TS.tgz"
chmod 600 "backup/backend-data-$TS.tgz"
sha256sum "backup/backend-data-$TS.tgz" | tee "backup/backend-data-$TS.sha256"
# 记录升级前 schema 与活动文件是否存在（回滚判断依据）
docker run --rm --user 0 --entrypoint sh -v "$VOL":/data:ro eldercare-cloud-backend:pre-d-e-20261026 \
  -c 'cat /data/backend-state.json | node -e "let s=\"\";process.stdin.on(\"data\",d=>s+=d).on(\"end\",()=>{const j=JSON.parse(s);console.log(JSON.stringify({schemaVersion:j.schemaVersion,devices:(j.devices||[]).length,alerts:(j.alerts||[]).length}))})" ; ls -l /data/activity-state.json 2>/dev/null || echo ACTIVITY_FILE_ABSENT'
```

判定：卷名已解析且存在；tar 可读非空、sha256 已记录；升级前 `schemaVersion` 与预期的历史值（文档记录为 5，**以现场读数为准**）记录在案；明确记录 `ACTIVITY_FILE_ABSENT` 或活动文件大小/哈希。
**任一失败 → 不升级**，用 §5 的 pin 覆盖文件把后端按旧镜像 `up -d --no-build` 起回去。

## 4. 切换镜像并启动

```bash
set -euo pipefail
docker compose --env-file deploy/.env.deploy -f deploy/compose.public.yaml -f deploy/compose.pin-de.yaml \
  up -d --no-build backend
docker compose --env-file deploy/.env.deploy -f deploy/compose.public.yaml ps
docker inspect --format '{{.Image}}' $(docker compose --env-file deploy/.env.deploy -f deploy/compose.public.yaml ps -q backend) | tee evidence-of-deploy/new-image-id.txt
# 期望 = sha256:ed481503…
```

- 禁止 `docker compose down -v`；不改 Caddyfile/DNS/端口。
- 首次写入后主快照变为 v6：旧镜像不能再读该卷，回滚必须走 runbook §8（恢复备份）。

## 5. 部署后验收（有效会话，不用匿名 401 判断）

1. `GET https://api.luxunacc.xyz/healthz`、`/readyz` → 200（仅证明进程/存储 ready）。
2. 用真实监护人账号登录（口令本机隐藏输入，不记录）→ `POST /api/v1/auth/app` 200 得 token。
3. 用 token 验证 D/E：
   - `GET /api/v1/alerts` → 200（能看到既有告警，**不 ACK**）
   - `GET /api/v1/activity/report?scope=day|week|month` → 200，且**如实**显示数据不足/覆盖率
   - 选一条**真实可操作**告警做 D 处置记录：`POST /api/v1/alerts/{alarmId}/dispositions`（201/幂等 200/冲突 409），再 `GET` 同接口与 `GET /api/v1/safety-logs` 核对
4. APP 安装更新后，在设备上打开 D/E 页面核对与后端一致；重启后端/容器后再查一次，确认持久化。
5. 记录：部署前后 Image ID、schema、备份哈希、活动文件状态、APP 包名/版本/签名与安装结果、验收时间线。

## 6. 回滚（事务化；只在验收失败时执行）

按 rollback-hardening runbook §8 的 RC 状态机：先恢复 pin 覆盖文件启动旧镜像；**升级后新增的处置记录与安全日志会因恢复旧数据而丢失**，执行前必须先把升级后数据 `tar` 留档（`backup/backend-data-after-<TS>.tgz`）并在报告中写明。

## 7. 本机未执行声明

以上 §1–§6 全部为**现场执行**命令；本机（`<WORKSPACE>`）没有生产主机访问方式，未执行任何一条。本机实际完成的是：镜像构建与本地镜像级验证、D/E-only APP 构建、制品与回滚材料准备。
