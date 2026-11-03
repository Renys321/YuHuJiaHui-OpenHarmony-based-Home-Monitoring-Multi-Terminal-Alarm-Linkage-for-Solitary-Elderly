#!/usr/bin/env bash
#
# rollback.sh — 撤销 video-relay 安装，恢复 Caddyfile / compose / video.env 备份。
#
# 由 install-on-ecs.sh 复制为 /opt/eldercare/deploy/rollback-video.sh。
#
# 用法：
#   sudo bash rollback.sh                              # 自动选最新的 video-* 备份
#   sudo bash rollback.sh --backup /opt/eldercare/deploy/backup/video-20261027T120000Z
#   sudo bash rollback.sh --list                       # 只列出可用备份
#
# 行为：
#   1) 恢复备份中的 Caddyfile、compose.public.yaml、compose.video.yaml、.env.deploy、video.env；
#   2) 删除本次新增而备份中不存在的文件（compose.video.yaml / video.env）；
#   3) 移除 video-relay 容器（compose rm -sf），不影响 backend；
#   4) 重启 caddy 使旧 Caddyfile 生效；
#   5) 自检 https://域名/readyz 恢复 200；失败只告警不删除备份，便于人工介入。
#
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

DEPLOY_DIR="${DEPLOY_DIR:-/opt/eldercare/deploy}"
PROJECT_NAME="${PROJECT_NAME:-eldercare-public}"
SERVICE_NAME="video-relay"
BACKUP_ROOT="${BACKUP_ROOT:-$DEPLOY_DIR/backup}"
ENV_FILE="${ENV_FILE:-$DEPLOY_DIR/.env.deploy}"
COMPOSE_MAIN="${COMPOSE_MAIN:-$DEPLOY_DIR/compose.public.yaml}"
COMPOSE_VIDEO="${COMPOSE_VIDEO:-$DEPLOY_DIR/compose.video.yaml}"
CADDYFILE="${CADDYFILE:-$DEPLOY_DIR/Caddyfile}"
BACKUP_DIR=""
PUBLIC_DOMAIN=""

log()  { printf '[rollback-video] %s\n' "$*"; }
warn() { printf '[rollback-video] WARN: %s\n' "$*" >&2; }
die()  { printf '[rollback-video] ERROR: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
用法: sudo bash rollback.sh [选项]

选项:
  --backup DIR   指定备份目录（默认 $DEPLOY_DIR/backup 下最新的 video-* 目录）
  --list         只列出可用备份，不做修改
  --help         显示帮助
EOF
}

env_value() {
  local key="$1" file="$2" value
  [ -f "$file" ] || return 1
  value="$(awk -v k="$key" '
    BEGIN { FS = "="; found = "" }
    index($0, k "=") == 1 { v = $0; sub("^" k "=", "", v); found = v }
    END { printf "%s", found }
  ' "$file" | tr -d '\r')"
  case "$value" in
    \"*\") value="${value#\"}"; value="${value%\"}" ;;
    \'*\') value="${value#\'}"; value="${value%\'}" ;;
  esac
  printf '%s' "$value"
}

compose() {
  # 回滚可能删除了本次新增的 compose.video.yaml：不存在时只带主 compose，
  # 否则 `docker compose restart caddy` 会因 -f 指向不存在文件而失败。
  if [ -f "$COMPOSE_VIDEO" ]; then
    docker compose -p "$PROJECT_NAME" --env-file "$ENV_FILE" \
      -f "$COMPOSE_MAIN" -f "$COMPOSE_VIDEO" "$@"
  else
    docker compose -p "$PROJECT_NAME" --env-file "$ENV_FILE" \
      -f "$COMPOSE_MAIN" "$@"
  fi
}

latest_backup() {
  [ -d "$BACKUP_ROOT" ] || return 1
  ls -1dt "$BACKUP_ROOT"/video-* 2>/dev/null | head -n 1
}

wait_public() {
  local path="$1" want="$2" deadline=$((SECONDS + ${3:-60})) code
  while [ "$SECONDS" -lt "$deadline" ]; do
    code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 8 \
      --resolve "$PUBLIC_DOMAIN:443:127.0.0.1" "https://$PUBLIC_DOMAIN$path" 2>/dev/null || true)"
    [ "$code" = "$want" ] && return 0
    sleep 2
  done
  return 1
}

restore_backup() {
  local manifest="$BACKUP_DIR/manifest.txt" file
  [ -f "$manifest" ] || die "备份目录缺少 manifest.txt: $BACKUP_DIR"
  log "恢复备份: $BACKUP_DIR"
  while IFS= read -r file; do
    [ -n "$file" ] || continue
    if [ -f "$BACKUP_DIR/$file" ]; then
      cp -a "$BACKUP_DIR/$file" "$DEPLOY_DIR/$file"
      log "已恢复 $DEPLOY_DIR/$file"
    fi
  done <"$manifest"
  for file in compose.video.yaml video.env; do
    if ! grep -qx "$file" "$manifest"; then
      rm -f "$DEPLOY_DIR/$file"
      log "已移除本次新增的 $DEPLOY_DIR/$file"
    fi
  done
}

main() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --backup) BACKUP_DIR="${2:-}"; shift 2 ;;
      --list)
        if [ -d "$BACKUP_ROOT" ]; then
          ls -1dt "$BACKUP_ROOT"/video-* 2>/dev/null || true
        else
          log "没有备份目录: $BACKUP_ROOT"
        fi
        exit 0 ;;
      --help|-h) usage; exit 0 ;;
      *) die "未知参数: $1（--help 查看用法）" ;;
    esac
  done

  command -v docker >/dev/null 2>&1 || die "未找到 docker"
  docker info >/dev/null 2>&1 || die "无法访问 docker daemon（需要 root）"
  [ -n "$BACKUP_DIR" ] || BACKUP_DIR="$(latest_backup)" || true
  [ -n "$BACKUP_DIR" ] && [ -d "$BACKUP_DIR" ] || die "找不到 video-* 备份；请用 --backup 指定"
  [ -f "$COMPOSE_MAIN" ] || die "缺少 $COMPOSE_MAIN"
  PUBLIC_DOMAIN="$(env_value PUBLIC_DOMAIN "$ENV_FILE" || true)"

  restore_backup

  # 移除 relay 容器；compose.video.yaml 可能已删除，用 label 兜底清理残留容器。
  compose rm -sf "$SERVICE_NAME" >/dev/null 2>&1 || true
  local relay_cid
  relay_cid="$(docker ps -aq \
    --filter "label=com.docker.compose.project=$PROJECT_NAME" \
    --filter "label=com.docker.compose.service=$SERVICE_NAME" | head -n 1 || true)"
  if [ -n "$relay_cid" ]; then
    docker rm -f "$relay_cid" >/dev/null 2>&1 || true
  fi
  log "已移除 $SERVICE_NAME 容器"

  # 若本次安装新增了 compose.video.yaml 且已删除，重启 caddy 仍需主 compose。
  compose restart caddy
  log "已重启 caddy（恢复旧 Caddyfile 路由）"

  if [ -n "$PUBLIC_DOMAIN" ]; then
    if wait_public "/readyz" "200" 60; then
      log "自检通过: https://$PUBLIC_DOMAIN/readyz 200（backend 反代恢复正常）"
    else
      warn "回滚后 /readyz 未在 60s 内恢复 200；请检查: docker logs ${PROJECT_NAME}-caddy-1"
    fi
    if wait_public "/video/healthz" "404" 20; then
      log "自检通过: https://$PUBLIC_DOMAIN/video/healthz 已回到 404（旧 Caddyfile 不再代理 /video/*）"
    else
      warn "/video/healthz 未回到 404（可能回滚前就不是旧配置）；请人工确认 Caddyfile"
    fi
  fi

  log "回滚完成。备份未删除: $BACKUP_DIR"
}

main "$@"
