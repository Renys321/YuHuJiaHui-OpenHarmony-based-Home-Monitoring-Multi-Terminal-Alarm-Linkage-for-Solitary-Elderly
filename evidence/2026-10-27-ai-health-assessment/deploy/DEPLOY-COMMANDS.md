# 生产发布命令清单（AI 健康科普建议 · 2026-10-27）

> 目标主机：`47.76.70.118`（`api.luxunacc.xyz`），当前生产为 **门磁 schema v7** 后端，容器 `backend` + `caddy`。
> 本发布**只替换 backend 镜像/源码并新增 DeepSeek 环境变量**；不重启 caddy、不动 OneNET/网关/设备、不动卷里的既有数据。
> 主快照 schema **不变（仍为 v7）**：健康资料写入独立文件 `/data/health-state.json`，不修改 `backend-state.json`，因此**回滚不需要恢复数据**。

发布包位置（本机）：

```text
competition/evidence/2026-10-27-ai-health-assessment/deploy/
├── image/eldercare-cloud-backend-health-2026-10-27.tar.gz   # 61,469,899 B  sha256 54F00C11…
├── release-backend-src-health-2026-10-27.tar.gz             # 228,272 B    sha256 B916911B…
├── compose.public.yaml                                      # 已加入 DEEPSEEK_* 透传
├── Caddyfile                                                # 未改，仅随包提供
└── .env.deploy.example                                      # 新增变量示例（不含真实值）
```

> 源码包已核对为「已部署 v7 源码 + 健康功能」，**不含未发布的 GPS 草稿**（`/api/v1/ingest/wearable/location`、`ingestWearableLocation` 等符号为 0）。
> 源码包内测试：`npm run check` exit 0；`node --test --test-isolation=none` → **377/377 PASS**。

---

## 0. 最快路径：一键脚本（等价于下面 1–6 步，推荐）

把两个发布包与 `deploy/host-deploy.sh`、`deploy/host-rollback.sh`、`deploy/compose.public.yaml` 一起上传到主机同一目录后：

```bash
cd /opt/eldercare
sudo bash <上传目录>/host-deploy.sh <上传目录>/eldercare-cloud-backend-health-2026-10-27.tar.gz <上传目录>/release-backend-src-health-2026-10-27.tar.gz
# 脚本会：校验 sha256 → 备份旧镜像/数据卷/schema/旧源码 → docker load + tag → 备份并替换 compose
#        → 隐藏输入 DEEPSEEK_API_KEY → 只重启 backend → 等 healthy → 打印 schema 与公网 200/401 检查
# 回滚：sudo bash <上传目录>/host-rollback.sh <脚本输出的 backup 时间戳>
```

> 脚本默认 `BASE=/opt/eldercare`；如主机布局不同，用 `BASE=/your/path` 覆盖。
> 脚本不会打印 Key，也不会写入命令行/历史/日志。
## 0. 前置（在主机 `/opt/eldercare` 执行）

```bash
cd /opt/eldercare
ls deploy/compose.public.yaml cloud/backend/Dockerfile        # 确认目录布局
docker compose --env-file deploy/.env.deploy -f deploy/compose.public.yaml ps
```

## 1. 备份（必须，回滚依据）

```bash
cd /opt/eldercare
TS=$(date +%Y%m%d-%H%M%S)
mkdir -p backup/$TS && chmod 700 backup
# 1.1 当前运行镜像 digest + 镜像归档
docker inspect --format '{{.Image}}' $(docker compose --env-file deploy/.env.deploy -f deploy/compose.public.yaml ps -q backend) | tee backup/$TS/old-image-id.txt
docker image inspect $(cat backup/$TS/old-image-id.txt) --format '{{.RepoTags}}' | tee backup/$TS/old-image-tags.txt
docker save $(cat backup/$TS/old-image-id.txt) | gzip > backup/$TS/image-before-health.tar.gz
sha256sum backup/$TS/image-before-health.tar.gz | tee backup/$TS/image-before-health.sha256
# 1.2 /data 卷整卷备份（含 backend-state.json；健康文件此时还不存在）
VOL=$(docker inspect $(docker compose --env-file deploy/.env.deploy -f deploy/compose.public.yaml ps -q backend) \
  --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}')
echo "VOL=$VOL" | tee backup/$TS/data-volume.txt
docker run --rm -v "$VOL":/data -v "$PWD/backup/$TS":/backup alpine sh -c 'cd /data && tar czf /backup/backend-data.tgz .'
sha256sum backup/$TS/backend-data.tgz | tee backup/$TS/backend-data.sha256
# 1.3 发布前 schema 与计数（期望 schemaVersion=7 devices=8 alerts=69）
docker compose --env-file deploy/.env.deploy -f deploy/compose.public.yaml exec -T backend \
  node -e "const s=require('/data/backend-state.json');console.log(JSON.stringify({schemaVersion:s.schemaVersion,devices:(s.devices||[]).length,alerts:(s.alerts||[]).length,safetyLogs:(s.safetyLogs||[]).length}))" \
  | tee backup/$TS/schema-before.txt
# 1.4 旧源码备份
tar czf backup/$TS/cloud-backend-before.tar.gz -C cloud backend
sha256sum backup/$TS/cloud-backend-before.tar.gz | tee -a backup/$TS/checksums.txt
```

## 2. 上传发布包到主机

在 **本机**（Windows）执行（把 `<user>` 换成主机登录用户）：

```powershell
scp "<WORKSPACE>\competition\evidence\2026-10-27-ai-health-assessment\deploy\image\eldercare-cloud-backend-health-2026-10-27.tar.gz" <user>@47.76.70.118:/opt/eldercare/
scp "<WORKSPACE>\competition\evidence\2026-10-27-ai-health-assessment\deploy\release-backend-src-health-2026-10-27.tar.gz" <user>@47.76.70.118:/opt/eldercare/
scp "<WORKSPACE>\competition\evidence\2026-10-27-ai-health-assessment\deploy\compose.public.yaml" <user>@47.76.70.118:/opt/eldercare/deploy/compose.public.yaml.new
```

主机侧校验：

```bash
cd /opt/eldercare
sha256sum eldercare-cloud-backend-health-2026-10-27.tar.gz   # 期望 54F00C116CBCC461DA8837EAC789AA9D58EA16B0AAC9D096CFBAAA1FB8C7423C
sha256sum release-backend-src-health-2026-10-27.tar.gz       # 期望 B916911BBD71A7DB0225EBAE6ED7707C2F408CA4257B7D0E0E04015FD6E5E9CC
```

## 3. 配置 DeepSeek Key（隐藏输入，不写日志/不留 shell 历史/不回显）

```bash
cd /opt/eldercare
chmod 600 deploy/.env.deploy
read -rsp 'DEEPSEEK_API_KEY: ' DK; echo
if grep -q '^DEEPSEEK_API_KEY=' deploy/.env.deploy; then
  sed -i.bak "s|^DEEPSEEK_API_KEY=.*|DEEPSEEK_API_KEY=$DK|" deploy/.env.deploy
else
  printf '\n# AI 健康科普（DeepSeek）；仅本文件持有，绝不写进镜像/源码/日志\nDEEPSEEK_API_KEY=%s\nDEEPSEEK_BASE_URL=https://api.deepseek.com\nDEEPSEEK_MODEL=deepseek-chat\nDEEPSEEK_TIMEOUT_MS=12000\nDEEPSEEK_MAX_RETRIES=1\nHEALTH_ADVICE_CACHE_TTL_MS=300000\nHEALTH_ADVICE_CACHE_MAX=64\n' "$DK" >> deploy/.env.deploy
fi
unset DK
# 建议：开启历史记录隔离后重新登录 shell，避免命令历史残留（sed 命令本身不含 key）
grep -c '^DEEPSEEK_API_KEY=' deploy/.env.deploy   # 期望输出 1，且不要 cat 该文件
```

## 4. 发布（二选一，推荐 A）

### A. 用已构建好的镜像（不依赖主机构建/网络）

```bash
cd /opt/eldercare
docker load -i eldercare-cloud-backend-health-2026-10-27.tar.gz
docker tag eldercare-cloud-backend:health-2026-10-27 eldercare-cloud-backend:local
cp deploy/compose.public.yaml deploy/compose.public.yaml.bak
mv deploy/compose.public.yaml.new deploy/compose.public.yaml
docker compose --env-file deploy/.env.deploy -f deploy/compose.public.yaml up -d --no-build backend
```

### B. 用源码在主机构建（保持与 v7 相同的构建路径）

```bash
cd /opt/eldercare
mv cloud/backend cloud/backend.before-health
mkdir -p cloud/backend
tar xzf release-backend-src-health-2026-10-27.tar.gz -C cloud/backend
cp deploy/compose.public.yaml deploy/compose.public.yaml.bak
mv deploy/compose.public.yaml.new deploy/compose.public.yaml
docker compose --env-file deploy/.env.deploy -f deploy/compose.public.yaml build backend
docker compose --env-file deploy/.env.deploy -f deploy/compose.public.yaml up -d --no-build backend
```

> 只重建/重启 `backend`；**caddy 不动**（`depends_on: service_healthy` 只影响首次创建，不会重启已运行容器）。

## 5. 发布后验证（主机侧）

```bash
cd /opt/eldercare
docker compose --env-file deploy/.env.deploy -f deploy/compose.public.yaml ps      # backend: healthy
docker compose --env-file deploy/.env.deploy -f deploy/compose.public.yaml logs --tail=30 backend
# 期望日志出现：HEALTH_ADVICE configured=true；无 key、无资料内容、无异常栈
docker compose --env-file deploy/.env.deploy -f deploy/compose.public.yaml exec -T backend \
  node -e "const s=require('/data/backend-state.json');console.log(JSON.stringify({schemaVersion:s.schemaVersion,devices:(s.devices||[]).length,alerts:(s.alerts||[]).length,safetyLogs:(s.safetyLogs||[]).length}))"
# 期望 schemaVersion=7，devices/alerts/safetyLogs 与发布前完全一致
curl -fsS https://api.luxunacc.xyz/healthz; echo
curl -fsS https://api.luxunacc.xyz/readyz; echo
curl -s -o /dev/null -w 'health-profile(anon)=%{http_code}\n' https://api.luxunacc.xyz/api/v1/health-profile
# 期望 401（未登录不允许读写健康资料）
```

> APP 侧真实验收由 Lead 用合成资料完成：保存资料 → 生成建议 → 显示四段结果与固定免责声明 → 重启 APP 后资料仍在 → 超时/失败态可重试。

## 6. 回滚（任一验证失败时）

```bash
cd /opt/eldercare
# 6.1 恢复 compose 文件
mv deploy/compose.public.yaml.bak deploy/compose.public.yaml
# 6.2 恢复旧镜像（A 路线）
docker tag $(cat backup/$TS/old-image-id.txt) eldercare-cloud-backend:local
docker compose --env-file deploy/.env.deploy -f deploy/compose.public.yaml up -d --no-build backend
# 6.2' 恢复旧源码（B 路线）
rm -rf cloud/backend && mv cloud/backend.before-health cloud/backend
docker compose --env-file deploy/.env.deploy -f deploy/compose.public.yaml build backend
docker compose --env-file deploy/.env.deploy -f deploy/compose.public.yaml up -d --no-build backend
# 6.3 验证
docker compose --env-file deploy/.env.deploy -f deploy/compose.public.yaml ps
curl -fsS https://api.luxunacc.xyz/healthz; echo
```

- 回滚**不需要**恢复 `/data`：旧镜像不认识 `health-state.json`，会忽略它；`backend-state.json` 未被本发布修改。
- 如需彻底清除健康数据：`docker compose ... exec -T backend rm -f /data/health-state.json` 后再回滚（可选）。
- 不要删除 key 所在行以外的既有变量；如要关闭功能，注释/删除 `DEEPSEEK_API_KEY` 后重启 backend，健康建议接口将返回 `503 AI_NOT_CONFIGURED`（其余功能不受影响）。

## 7. 本发布不包含

- 不新增/变更 GPS、可穿戴位置接口（源码包已核对为 0 命中）。
- 不修改固件、串口、COM4/COM5/COM8、门磁 v7、D/E、SOS/ACK、OneNET/网关。
- 不修改 DNS、Caddy、TLS、防火墙。
- 不发布 APP 之外的任何客户端。
