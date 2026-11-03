#!/usr/bin/env bash
# 主机侧回滚脚本（AI 健康科普建议 · 2026-10-27）
# 用法：bash host-rollback.sh <备份时间戳，如 20261027-161500>
set -euo pipefail
BASE="${BASE:-/opt/eldercare}"
TS="${1:-}"
[ -n "$TS" ] || { echo "usage: $0 <backup-timestamp>"; exit 1; }
cd "$BASE"
B="backup/$TS"
[ -d "$B" ] || { echo "ERROR: $B not found"; exit 1; }
COMPOSE=(docker compose --env-file deploy/.env.deploy -f deploy/compose.public.yaml)

echo "== 1) 恢复 compose =="
[ -f "$B/compose.public.yaml.before" ] && cp "$B/compose.public.yaml.before" deploy/compose.public.yaml

echo "== 2) 恢复旧镜像并重启 backend =="
OLD_IMAGE=$(cat "$B/old-image-id.txt")
docker tag "$OLD_IMAGE" eldercare-cloud-backend:local
"${COMPOSE[@]}" up -d --no-build backend

echo "== 3) 等待 healthy =="
for i in $(seq 1 40); do
  STATUS=$("${COMPOSE[@]}" ps --format '{{.Status}}' backend 2>/dev/null || true)
  echo "  [$i] $STATUS"
  case "$STATUS" in *healthy*) break;; esac
  sleep 3
done
"${COMPOSE[@]}" ps
"${COMPOSE[@]}" exec -T backend node -e "const s=require('/data/backend-state.json');console.log('schema-rollback',JSON.stringify({schemaVersion:s.schemaVersion,devices:(s.devices||[]).length,alerts:(s.alerts||[]).length,safetyLogs:(s.safetyLogs||[]).length}))"
DOMAIN=$(grep -E '^PUBLIC_DOMAIN=' deploy/.env.deploy | cut -d= -f2-)
curl -fsS "https://$DOMAIN/healthz"; echo
echo
echo "回滚完成（数据卷未改动；health-state.json 可保留或删除：docker compose ... exec -T backend rm -f /data/health-state.json）"
