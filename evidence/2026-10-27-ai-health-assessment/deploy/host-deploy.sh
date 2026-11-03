#!/usr/bin/env bash
# 主机侧一键发布脚本（AI 健康科普建议 · 2026-10-27）
# 用法：把两个发布包放到同一目录后执行
#   sudo bash host-deploy.sh /path/to/eldercare-cloud-backend-health-2026-10-27.tar.gz \
#                            /path/to/release-backend-src-health-2026-10-27.tar.gz
# 前置：/opt/eldercare 已存在（含 deploy/ 与 cloud/backend），docker compose v2 可用。
# 安全：DEEPSEEK_API_KEY 用隐藏输入读取，不写入命令行/历史/日志；只重启 backend，不动 caddy。
set -euo pipefail

BASE="${BASE:-/opt/eldercare}"
IMAGE_TAR="${1:-}"
SRC_TAR="${2:-}"
EXPECT_IMAGE_SHA="54f00c116cbcc461da8837eac789aa9d58ea16b0aac9d096cfbaaa1fb8c7423c"
EXPECT_SRC_SHA="b916911bbd71a7db0225ebae6ed7707c2f408ca4257b7d0e0e04015fd6e5e9cc"
COMPOSE=(docker compose --env-file deploy/.env.deploy -f deploy/compose.public.yaml)

cd "$BASE"
[ -f deploy/compose.public.yaml ] || { echo "ERROR: $BASE/deploy/compose.public.yaml not found"; exit 1; }
[ -f cloud/backend/Dockerfile ] || { echo "ERROR: $BASE/cloud/backend/Dockerfile not found"; exit 1; }
if [ -z "$IMAGE_TAR" ] || [ ! -f "$IMAGE_TAR" ]; then echo "ERROR: image tar not found"; exit 1; fi
if [ -z "$SRC_TAR" ] || [ ! -f "$SRC_TAR" ]; then echo "ERROR: source tar not found"; exit 1; fi

echo "== 0) 校验发布包 =="
echo "$EXPECT_IMAGE_SHA  $IMAGE_TAR" | sha256sum -c -
echo "$EXPECT_SRC_SHA  $SRC_TAR" | sha256sum -c -

TS=$(date +%Y%m%d-%H%M%S)
echo "== 1) 备份到 backup/$TS =="
mkdir -p "backup/$TS"; chmod 700 "backup/$TS"
CID=$("${COMPOSE[@]}" ps -q backend)
OLD_IMAGE=$(docker inspect --format '{{.Image}}' "$CID")
echo "$OLD_IMAGE" > "backup/$TS/old-image-id.txt"
docker image inspect "$OLD_IMAGE" --format '{{json .RepoTags}}' > "backup/$TS/old-image-tags.txt"
docker save "$OLD_IMAGE" | gzip > "backup/$TS/image-before-health.tar.gz"
sha256sum "backup/$TS/image-before-health.tar.gz" > "backup/$TS/image-before-health.sha256"
VOL=$(docker inspect "$CID" --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}')
echo "$VOL" > "backup/$TS/data-volume.txt"
docker run --rm -v "$VOL":/data -v "$PWD/backup/$TS":/backup alpine sh -c 'cd /data && tar czf /backup/backend-data.tgz .'
sha256sum "backup/$TS/backend-data.tgz" > "backup/$TS/backend-data.sha256"
"${COMPOSE[@]}" exec -T backend node -e "const s=require('/data/backend-state.json');console.log(JSON.stringify({schemaVersion:s.schemaVersion,devices:(s.devices||[]).length,alerts:(s.alerts||[]).length,safetyLogs:(s.safetyLogs||[]).length}))" > "backup/$TS/schema-before.txt"
cat "backup/$TS/schema-before.txt"
tar czf "backup/$TS/cloud-backend-before.tar.gz" -C cloud backend
sha256sum "backup/$TS/cloud-backend-before.tar.gz" >> "backup/$TS/image-before-health.sha256"

echo "== 2) 安装新镜像 =="
case "$IMAGE_TAR" in
  *.gz|*.tgz) gunzip -c "$IMAGE_TAR" | docker load ;;
  *) docker load -i "$IMAGE_TAR" ;;
esac
docker tag eldercare-cloud-backend:health-2026-10-27 eldercare-cloud-backend:local

echo "== 3) 安装新 compose（保留旧文件） =="
cp deploy/compose.public.yaml "backup/$TS/compose.public.yaml.before"
# 从发布包内替换（发布包目录与本脚本同目录时）
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
if [ -f "$HERE/compose.public.yaml" ]; then cp "$HERE/compose.public.yaml" deploy/compose.public.yaml; else echo "WARN: compose.public.yaml 未随脚本提供，沿用现有文件（需已包含 DEEPSEEK_* 透传）"; fi

echo "== 4) 配置 DeepSeek Key（隐藏输入） =="
if grep -q '^DEEPSEEK_API_KEY=' deploy/.env.deploy; then
  echo "deploy/.env.deploy 已含 DEEPSEEK_API_KEY（保持原值，不覆盖）"
else
  read -rsp 'DEEPSEEK_API_KEY: ' DK; echo
  if [ -z "$DK" ]; then echo "ERROR: 空 key，中止"; exit 1; fi
  if grep -q '^DEEPSEEK_MODEL=' deploy/.env.deploy; then KEYLINE_ONLY=1; else KEYLINE_ONLY=0; fi
  printf '\n# AI 健康科普（DeepSeek）；仅本文件持有，绝不写进镜像/源码/日志\nDEEPSEEK_API_KEY=%s\n' "$DK" >> deploy/.env.deploy
  if [ "$KEYLINE_ONLY" = "0" ]; then
    printf 'DEEPSEEK_BASE_URL=https://api.deepseek.com\nDEEPSEEK_MODEL=deepseek-chat\nDEEPSEEK_TIMEOUT_MS=12000\nDEEPSEEK_MAX_RETRIES=1\nHEALTH_ADVICE_CACHE_TTL_MS=300000\nHEALTH_ADVICE_CACHE_MAX=64\n' >> deploy/.env.deploy
  fi
  unset DK
  chmod 600 deploy/.env.deploy
fi

echo "== 5) 只重启 backend（caddy 不动） =="
"${COMPOSE[@]}" up -d --no-build backend

echo "== 6) 等待 healthy 并验证 =="
for i in $(seq 1 40); do
  STATUS=$("${COMPOSE[@]}" ps --format '{{.Status}}' backend 2>/dev/null || true)
  echo "  [$i] $STATUS"
  case "$STATUS" in *healthy*) break;; esac
  sleep 3
done
"${COMPOSE[@]}" ps
"${COMPOSE[@]}" logs --tail=30 backend | sed -e 's/\(DEEPSEEK_API_KEY=\).*/\1***/g' || true
"${COMPOSE[@]}" exec -T backend node -e "const s=require('/data/backend-state.json');console.log('schema-after',JSON.stringify({schemaVersion:s.schemaVersion,devices:(s.devices||[]).length,alerts:(s.alerts||[]).length,safetyLogs:(s.safetyLogs||[]).length}))"
DOMAIN=$(grep -E '^PUBLIC_DOMAIN=' deploy/.env.deploy | cut -d= -f2-)
echo "== 7) 公网检查 =="
curl -fsS "https://$DOMAIN/healthz"; echo
curl -fsS "https://$DOMAIN/readyz"; echo
CODE=$(curl -s -o /dev/null -w '%{http_code}' "https://$DOMAIN/api/v1/health-profile")
echo "anonymous /api/v1/health-profile = $CODE (expect 401)"

echo
echo "发布完成。回滚："
echo "  cd $BASE && bash host-rollback.sh $TS"
