#!/usr/bin/env bash
#
# rollback.sh — 一键回滚 wearable-mqtt（只移除本服务，保留 backend/caddy 与数据卷）。
#
# 用法:
#   bash rollback.sh                     # 回滚到最近一次 install 备份
#   bash rollback.sh --backup DIR        # 指定备份目录
#   bash rollback.sh --purge-data        # 额外删除 seq/游标数据卷（默认保留）
#
# 边界:
#   - 只 down/rm wearable-mqtt；绝不 stop/rm backend 或 caddy；
#   - 恢复安装前的 compose.wearable.yaml / wearable.env（备份里没有的就删除本次生成的文件）；
#   - compose.public.yaml 与 .env.deploy 本脚本从不修改，因此也不覆盖它们；
#   - 数据卷默认保留，避免误删 seq/命令游标；--purge-data 才删除。
#
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

DEPLOY_DIR="${DEPLOY_DIR:-/opt/eldercare/deploy}"
SOURCE_DIR="${SOURCE_DIR:-/opt/eldercare/wearable}"
PROJECT_NAME="${PROJECT_NAME:-eldercare-public}"
SERVICE_NAME="wearable-mqtt"
BACKUP_DIR=""
PURGE_DATA=0

log()  { printf '[rollback] %s\n' "$*"; }
warn() { printf '[rollback] WARN: %s\n' "$*" >&2; }
die()  { printf '[rollback] ERROR: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
用法: bash rollback.sh [选项]

选项:
  --backup DIR     指定 install-on-ecs.sh 生成的备份目录（默认取 backup/ 下最新）
  --purge-data     删除 wearable-data 数据卷（默认保留 seq/命令游标）
  --deploy-dir DIR 部署目录（默认 /opt/eldercare/deploy）
  --help           显示帮助

说明: 只回滚 wearable-mqtt，不会停止/删除 backend、caddy。
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --backup) BACKUP_DIR="${2:-}"; shift 2 ;;
    --purge-data) PURGE_DATA=1; shift ;;
    --deploy-dir) DEPLOY_DIR="${2:-}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) die "未知参数: $1（--help 查看用法）" ;;
  esac
done

BACKUP_ROOT="${BACKUP_ROOT:-$DEPLOY_DIR/backup}"
ENV_FILE="${ENV_FILE:-$DEPLOY_DIR/.env.deploy}"
WEARABLE_ENV="${WEARABLE_ENV:-$DEPLOY_DIR/wearable.env}"
COMPOSE_MAIN="${COMPOSE_MAIN:-$DEPLOY_DIR/compose.public.yaml}"
COMPOSE_WEARABLE="${COMPOSE_WEARABLE:-$DEPLOY_DIR/compose.wearable.yaml}"
command -v docker >/dev/null 2>&1 || die "未找到 docker"
docker compose version >/dev/null 2>&1 || die "未找到 docker compose 插件"

if [ -z "$BACKUP_DIR" ]; then
  BACKUP_DIR="$(ls -1dt "$BACKUP_ROOT"/wearable-* 2>/dev/null | head -n 1 || true)"
fi
if [ -n "$BACKUP_DIR" ]; then
  [ -d "$BACKUP_DIR" ] || die "备份目录不存在: $BACKUP_DIR"
  log "使用备份: $BACKUP_DIR"
else
  warn "未找到 install 备份；按“本次安装前不存在 wearable 服务”处理（只移除本次新增文件）"
fi

# 与 install 一致的网络/路径注入，确保 compose 能解析 override。
PUBLIC_NETWORK="${WEARABLE_PUBLIC_NETWORK:-}"
if [ -z "$PUBLIC_NETWORK" ]; then
  tmp="$(mktemp)"
  docker network ls --format '{{.Name}}' >"$tmp" 2>/dev/null || true
  PUBLIC_NETWORK="$(grep -E '(^|_)public-edge$' "$tmp" | head -n 1 || true)"
  [ -n "$PUBLIC_NETWORK" ] || PUBLIC_NETWORK="$(grep -E 'public-edge' "$tmp" | head -n 1 || true)"
  rm -f "$tmp"
fi
export WEARABLE_PUBLIC_NETWORK="${PUBLIC_NETWORK:-eldercare-public_public-edge}"
export WEARABLE_ENV_FILE="$WEARABLE_ENV"
export WEARABLE_SOURCE_DIR="$SOURCE_DIR"

compose() {
  docker compose -p "$PROJECT_NAME" --env-file "$ENV_FILE" \
    -f "$COMPOSE_MAIN" -f "$COMPOSE_WEARABLE" "$@"
}

container_id() {
  local cid
  cid="$(docker ps -aq -f "name=${PROJECT_NAME}-${SERVICE_NAME}-1" | head -n 1 || true)"
  printf '%s' "$cid"
}

log "停止并移除 $SERVICE_NAME 容器（保留 backend/caddy）..."
CID="$(container_id)"
if [ -n "$CID" ]; then
  if [ -f "$COMPOSE_WEARABLE" ] && [ -f "$COMPOSE_MAIN" ]; then
    compose stop "$SERVICE_NAME" >/dev/null 2>&1 || true
    compose rm -f "$SERVICE_NAME" >/dev/null 2>&1 || true
  fi
  CID="$(container_id)"
  if [ -n "$CID" ]; then
    docker rm -f "$CID" >/dev/null 2>&1 || true
  fi
  log "容器已移除"
else
  log "未发现运行中的 $SERVICE_NAME 容器"
fi

# 恢复本次安装新增的两个文件；备份 manifest 未列出的说明安装前不存在 -> 删除。
restore_file() {
  local name="$1" target="$2"
  if [ -n "$BACKUP_DIR" ] && [ -f "$BACKUP_DIR/$name" ]; then
    cp -a "$BACKUP_DIR/$name" "$target.tmp"
    mv -f "$target.tmp" "$target"
    log "已恢复 $target"
  else
    rm -f "$target"
    log "已移除本次新增的 $target"
  fi
}

if [ -f "$COMPOSE_WEARABLE" ]; then
  restore_file "compose.wearable.yaml" "$COMPOSE_WEARABLE"
fi
if [ -f "$WEARABLE_ENV" ]; then
  restore_file "wearable.env" "$WEARABLE_ENV"
fi
# 安装时复制到部署目录的回滚脚本副本也一并清理（上传源里的保留）。
rm -f "$DEPLOY_DIR/rollback-wearable.sh"

if [ "$PURGE_DATA" = "1" ]; then
  VOLUME_NAME="${PROJECT_NAME}_wearable-data"
  if docker volume inspect "$VOLUME_NAME" >/dev/null 2>&1; then
    docker volume rm "$VOLUME_NAME" >/dev/null
    log "已删除数据卷 $VOLUME_NAME"
  else
    log "数据卷 $VOLUME_NAME 不存在，跳过"
  fi
else
  log "保留数据卷 ${PROJECT_NAME}_wearable-data（seq/命令游标）；需要清除请加 --purge-data"
fi

# 验证 1883 已释放（若仍被占用，只提示，可能是其它进程）。
if timeout 2 bash -c 'exec 3<>/dev/tcp/127.0.0.1/1883' >/dev/null 2>&1; then
  warn "1883 仍有进程监听；请确认不是残留容器: docker ps | grep 1883"
else
  log "1883 已释放"
fi

# 确认主栈未被影响。
for name in "${PROJECT_NAME}-backend-1" "${PROJECT_NAME}-caddy-1"; do
  status="$(docker inspect -f '{{.State.Status}}' "$name" 2>/dev/null || echo missing)"
  log "主栈容器 $name: $status（本脚本未改动）"
done

log "回滚完成。APP/后端未受影响；如本次是升级回滚，原 wearable 版本不会自动拉起（安装前它本就不存在/已由备份 compose 定义）。"
