#!/usr/bin/env bash
#
# rollback-upgrade.sh — 把 wearable-mqtt **升级**回滚到升级前的代码版本。
#
# 与 rollback.sh 的区别：
#   - rollback.sh         = “首次安装”回滚：移除 wearable-mqtt 服务并恢复 compose/env。
#   - rollback-upgrade.sh = “升级”回滚：恢复升级前备份的源码目录，然后强制重建容器，
#                           让服务继续以旧版本运行（不删除服务、不动 backend/caddy、保留数据卷）。
#
# 前提：升级时用的 install-on-ecs.sh 已在同一备份目录写入 wearable-src-before.tar.gz
#       （升级安装日志里会打印“已备份线上源码: .../wearable-src-before.tar.gz”）。
#
# 用法（ECS Workbench）:
#   bash /root/wearable-src/deploy/wearable/rollback-upgrade.sh --backup /opt/eldercare/deploy/backup/wearable-<时间戳>
#   bash /root/wearable-src/deploy/wearable/rollback-upgrade.sh          # 自动选最新备份
#   bash /root/wearable-src/deploy/wearable/rollback-upgrade.sh --backup ... --dry-run
#
# 边界：
#   - 只操作 wearable-mqtt 一个服务；绝不 stop/rm backend 或 caddy；
#   - 不删除数据卷（seq/命令游标保留）；
#   - 恢复失败时保留现场，打印手工恢复命令，绝不静默“假装回滚成功”。
#
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

DEPLOY_DIR="${DEPLOY_DIR:-/opt/eldercare/deploy}"
SOURCE_DIR="${SOURCE_DIR:-/opt/eldercare/wearable}"
PROJECT_NAME="${PROJECT_NAME:-eldercare-public}"
SERVICE_NAME="wearable-mqtt"
BACKUP_DIR=""
DRY_RUN=0

log()  { printf '[rollback-upgrade] %s\n' "$*"; }
warn() { printf '[rollback-upgrade] WARN: %s\n' "$*" >&2; }
die()  { printf '[rollback-upgrade] ERROR: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
用法: bash rollback-upgrade.sh [选项]

选项:
  --backup DIR     升级时 install-on-ecs.sh 生成的备份目录（默认取 backup/ 下最新）
  --deploy-dir DIR 部署目录（默认 /opt/eldercare/deploy）
  --source-dir DIR 容器只读挂载的源码目录（默认 /opt/eldercare/wearable）
  --dry-run        只打印将要执行的动作，不改任何文件
  --help           显示帮助

说明: 只回滚 wearable-mqtt 的代码版本；不会停止/删除 backend、caddy；数据卷保留。
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --backup) BACKUP_DIR="${2:-}"; shift 2 ;;
    --deploy-dir) DEPLOY_DIR="${2:-}"; shift 2 ;;
    --source-dir) SOURCE_DIR="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
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
command -v tar >/dev/null 2>&1 || die "未找到 tar"

if [ -z "$BACKUP_DIR" ]; then
  BACKUP_DIR="$(ls -1dt "$BACKUP_ROOT"/wearable-* 2>/dev/null | head -n 1 || true)"
fi
[ -n "$BACKUP_DIR" ] || die "未找到任何备份目录（$BACKUP_ROOT/wearable-*）；不能安全回滚"
[ -d "$BACKUP_DIR" ] || die "备份目录不存在: $BACKUP_DIR"
SRC_ARCHIVE="$BACKUP_DIR/wearable-src-before.tar.gz"
if [ ! -f "$SRC_ARCHIVE" ]; then
  die "备份里没有源码归档: $SRC_ARCHIVE（该备份不是由带升级备份的 install-on-ecs.sh 生成，无法恢复旧版本代码）"
fi
log "使用备份: $BACKUP_DIR"

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

if [ "$DRY_RUN" = "1" ]; then
  log "[dry-run] 将执行: 停止并移除 $PROJECT_NAME-$SERVICE_NAME-1"
  log "[dry-run] 将执行: 清空并恢复 $SOURCE_DIR（来自 $SRC_ARCHIVE）"
  log "[dry-run] 将执行: compose up -d --no-deps --force-recreate $SERVICE_NAME"
  log "[dry-run] 不会改动 backend/caddy，不会删除数据卷"
  exit 0
fi

# 1) 先停容器，避免“源码已换、进程还在跑新代码”的混合状态。
log "停止并移除 $SERVICE_NAME 容器（保留 backend/caddy 与数据卷）..."
compose stop "$SERVICE_NAME" >/dev/null 2>&1 || true
compose rm -f "$SERVICE_NAME" >/dev/null 2>&1 || true

# 2) 恢复源码目录（保留目录权限；先解到临时目录再原子替换）。
RESTORE_TMP="$(mktemp -d)"
trap 'rm -rf "$RESTORE_TMP"' EXIT
tar -xzf "$SRC_ARCHIVE" -C "$RESTORE_TMP"
RESTORED_DIR="$RESTORE_TMP/$(basename "$SOURCE_DIR")"
[ -d "$RESTORED_DIR" ] || die "源码归档结构不符合预期（缺少 $(basename "$SOURCE_DIR")/）: $SRC_ARCHIVE"
OLD_DIR="${SOURCE_DIR}.rollback-old-$(date -u +%Y%m%dT%H%M%SZ)"
mv "$SOURCE_DIR" "$OLD_DIR" 2>/dev/null || true
mv "$RESTORED_DIR" "$SOURCE_DIR"
chmod -R a+rX "$SOURCE_DIR"
log "已恢复旧源码: $SOURCE_DIR（升级版暂时保存在 $OLD_DIR，确认无误后可删除）"

# 3) compose override / wearable.env 如与备份不同也一并恢复（升级通常不改这两个文件）。
for name in compose.wearable.yaml wearable.env; do
  if [ -f "$BACKUP_DIR/$name" ]; then
    case "$name" in
      compose.wearable.yaml) target="$COMPOSE_WEARABLE" ;;
      wearable.env) target="$WEARABLE_ENV" ;;
    esac
    cp -a "$BACKUP_DIR/$name" "$target.tmp"
    mv -f "$target.tmp" "$target"
    log "已恢复 $target"
  fi
done

# 4) 强制重建容器（源码是 bind mount，不重建就还是旧进程里的新代码）。
log "以旧版本源码重建 $SERVICE_NAME ..."
compose up -d --no-deps --force-recreate "$SERVICE_NAME"

# 5) 校验：等待 healthy + /healthz + 1883 + 版本号。
CID=""
for _ in $(seq 1 60); do
  CID="$(compose ps -q "$SERVICE_NAME" 2>/dev/null | head -n 1 || true)"
  [ -n "$CID" ] || { sleep 1; continue; }
  status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$CID" 2>/dev/null || echo unknown)"
  [ "$status" = "healthy" ] && break
  sleep 1
done
[ -n "$CID" ] || die "回滚后容器未启动；请查 compose logs（现场保留在 $OLD_DIR）"
status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$CID" 2>/dev/null || echo unknown)"
log "容器状态: $status"
if docker exec "$CID" node -e "fetch('http://127.0.0.1:8099/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
  log "自检通过: /healthz 200"
else
  die "回滚后 /healthz 不可用；请查 compose logs（现场保留在 $OLD_DIR）"
fi
docker exec "$CID" node -e "
  fetch('http://127.0.0.1:8099/status').then(r=>r.json()).then(j=>{
    console.log('回滚后服务版本: '+(j.service||'?')+' version='+(j.version||'?'));
  }).catch(()=>process.exit(1))
" || warn "版本号读取失败（不影响回滚结果）"
if timeout 2 bash -c 'exec 3<>/dev/tcp/127.0.0.1/1883' >/dev/null 2>&1; then
  log "自检通过: 0.0.0.0:1883 可连接"
else
  warn "1883 暂不可连接；请稍后复查: docker port $SERVICE_NAME"
fi
for name in "${PROJECT_NAME}-backend-1" "${PROJECT_NAME}-caddy-1"; do
  log "主栈容器 $name: $(docker inspect -f '{{.State.Status}}' "$name" 2>/dev/null || echo missing)（本脚本未改动）"
done
log "升级回滚完成。数据卷 $(printf '%s' "${PROJECT_NAME}_wearable-data") 保留（seq/命令游标）。"
log "手工兜底（若需要）: rm -rf $SOURCE_DIR && mv $OLD_DIR $SOURCE_DIR && docker restart \$(docker ps -qf name=$SERVICE_NAME)"
