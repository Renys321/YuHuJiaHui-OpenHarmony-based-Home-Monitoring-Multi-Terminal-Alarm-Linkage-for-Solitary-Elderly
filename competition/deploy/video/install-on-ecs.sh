#!/usr/bin/env bash
#
# install-on-ecs.sh — 在 ECS 上安装/升级视频探望中继 video-relay（契约 §2.4）。
#
# 设计边界：
#   - 不新建镜像：复用已有 eldercare-cloud-backend:local（node 运行时），
#     entrypoint 覆盖为 node /opt/video-relay/server.js；ws 已 vendor 在源码里，
#     服务器上不需要 npm install。
#   - 只新增 video-relay 一个服务，**不发布任何主机端口**，不改 backend；
#     公网入口仍只有 Caddy 80/443。
#   - 安装前备份 /opt/eldercare/deploy（compose/.env.deploy/Caddyfile/容器状态），
#     Caddyfile 先 caddy validate 再重启；自检失败自动回滚。
#   - 密钥只写入 /opt/eldercare/deploy/video.env（600），脚本绝不回显 VIDEO_AGENT_KEY。
#
# 用法（用户只需在阿里云 Workbench 执行一条命令，详见 README.md）：
#   sudo bash competition/deploy/video/install-on-ecs.sh
#
# 可选：
#   sudo bash install-on-ecs.sh --agent-key <预生成 key>
#   sudo bash install-on-ecs.sh --deploy-dir /opt/eldercare/deploy --source-dir /opt/eldercare/video-relay
#
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPETITION_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

DEPLOY_DIR="${DEPLOY_DIR:-/opt/eldercare/deploy}"
SOURCE_DIR="${SOURCE_DIR:-/opt/eldercare/video-relay}"
SRC_PACKAGE="${SRC_PACKAGE:-$COMPETITION_ROOT/video/relay}"
PROJECT_NAME="${PROJECT_NAME:-eldercare-public}"
SERVICE_NAME="video-relay"
IMAGE_NAME="${IMAGE_NAME:-eldercare-cloud-backend:local}"
RELAY_PORT="${RELAY_PORT:-9443}"

PUBLIC_NETWORK_IN="${VIDEO_PUBLIC_NETWORK:-}"
PUBLIC_NETWORK=""
PUBLIC_DOMAIN=""
ACME_EMAIL=""
AGENT_KEY_IN="${VIDEO_AGENT_KEY:-}"
AGENT_KEY=""
GENERATED_KEY=0

BACKUP_ROOT=""
BACKUP_DIR=""
ENV_FILE=""
COMPOSE_MAIN=""
COMPOSE_VIDEO=""
CADDYFILE=""
VIDEO_ENV=""
CADDY_CHANGED=0
INSTALL_IN_PROGRESS=0
SUCCESS=0
ROLLING_BACK=0

log()  { printf '[video-relay] %s\n' "$*"; }
warn() { printf '[video-relay] WARN: %s\n' "$*" >&2; }
die()  { printf '[video-relay] ERROR: %s\n' "$*" >&2; rollback_inline; exit 1; }

usage() {
  cat <<'EOF'
用法: sudo bash install-on-ecs.sh [选项]

选项:
  --agent-key KEY       指定 VIDEO_AGENT_KEY（默认复用 video.env，否则随机生成 48 hex）
  --deploy-dir DIR      ECS 部署目录（默认 /opt/eldercare/deploy）
  --source-dir DIR      relay 源码只读挂载目录（默认 /opt/eldercare/video-relay）
  --src-package DIR     本安装包内 relay 源码目录（默认 competition/video/relay）
  --network NAME        指定 public-edge Docker 网络真实名称（默认自动探测）
  --relay-port PORT     容器内 relay 端口（默认 9443，不映射到主机）
  --help                显示帮助

说明:
  - 脚本不打印 VIDEO_AGENT_KEY；查看方式：sudo sed -n 's/^VIDEO_AGENT_KEY=//p' /opt/eldercare/deploy/video.env
  - 安装前备份到 /opt/eldercare/deploy/backup/video-<UTC时间>/；失败自动回滚。
  - 只改 Caddyfile 的 /video/* 路由与 query 脱敏，保留原有 reverse_proxy backend:8080。
  - 回滚：sudo bash /opt/eldercare/deploy/rollback-video.sh
EOF
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --agent-key) AGENT_KEY_IN="${2:-}"; shift 2 ;;
      --deploy-dir) DEPLOY_DIR="${2:-}"; shift 2 ;;
      --source-dir) SOURCE_DIR="${2:-}"; shift 2 ;;
      --src-package) SRC_PACKAGE="${2:-}"; shift 2 ;;
      --network) PUBLIC_NETWORK_IN="${2:-}"; shift 2 ;;
      --relay-port) RELAY_PORT="${2:-}"; shift 2 ;;
      --help|-h) usage; exit 0 ;;
      *) die "未知参数: $1（--help 查看用法）" ;;
    esac
  done
  BACKUP_ROOT="${BACKUP_ROOT:-$DEPLOY_DIR/backup}"
  ENV_FILE="${ENV_FILE:-$DEPLOY_DIR/.env.deploy}"
  COMPOSE_MAIN="${COMPOSE_MAIN:-$DEPLOY_DIR/compose.public.yaml}"
  COMPOSE_VIDEO="${COMPOSE_VIDEO:-$DEPLOY_DIR/compose.video.yaml}"
  CADDYFILE="${CADDYFILE:-$DEPLOY_DIR/Caddyfile}"
  VIDEO_ENV="${VIDEO_ENV:-$DEPLOY_DIR/video.env}"
}

require_commands() {
  local cmd
  for cmd in docker awk sed grep curl install od cp rm date; do
    command -v "$cmd" >/dev/null 2>&1 || die "未找到命令: $cmd"
  done
  docker compose version >/dev/null 2>&1 || die "未找到 docker compose 插件"
}

preflight() {
  [ -f "$SRC_PACKAGE/server.js" ] || die "安装包缺少 relay 源码: $SRC_PACKAGE/server.js"
  [ -f "$SRC_PACKAGE/src/relay.js" ] || die "安装包缺少 src/relay.js"
  [ -f "$SRC_PACKAGE/vendor/ws/package.json" ] || die "安装包缺少 vendor/ws（离线 ws 依赖）"
  [ -f "$SCRIPT_DIR/compose.video.yaml" ] || die "部署包缺少 compose.video.yaml"
  [ -f "$SCRIPT_DIR/rollback.sh" ] || die "部署包缺少 rollback.sh"
  [ -f "$COMPOSE_MAIN" ] || die "未找到 $COMPOSE_MAIN（请先在 ECS 部署 eldercare-public 主栈）"
  [ -f "$CADDYFILE" ] || die "未找到 $CADDYFILE"
  [ -f "$ENV_FILE" ] || die "未找到 $ENV_FILE（backend 部署变量文件）"
  docker info >/dev/null 2>&1 || die "无法访问 docker daemon（需要 root 或 docker 组权限）"
  docker image inspect "$IMAGE_NAME" >/dev/null 2>&1 \
    || die "缺少镜像 $IMAGE_NAME；请先完成 backend 部署（本脚本不新建镜像）"
  PUBLIC_DOMAIN="$(env_value PUBLIC_DOMAIN "$ENV_FILE" || true)"
  ACME_EMAIL="$(env_value ACME_EMAIL "$ENV_FILE" || true)"
  [ -n "$PUBLIC_DOMAIN" ] || die "$ENV_FILE 缺少 PUBLIC_DOMAIN"
  [ -n "$ACME_EMAIL" ] || die "$ENV_FILE 缺少 ACME_EMAIL"
  case "$PUBLIC_DOMAIN" in
    *://*|*/*|*:*) die "PUBLIC_DOMAIN 必须是裸主机名（不要带 scheme/端口/路径）: $PUBLIC_DOMAIN" ;;
  esac
  # 已有主栈容器必须保持健康；本脚本不会重启/重建 backend。
  if ! docker ps --format '{{.Names}}' | grep -qx "${PROJECT_NAME}-backend-1"; then
    warn "未发现运行中的 ${PROJECT_NAME}-backend-1；请确认 backend 主栈已启动（本脚本不会替你启动）"
  fi
  case "$SOURCE_DIR" in
    /|""|/opt|/opt/eldercare) die "SOURCE_DIR 不安全: $SOURCE_DIR" ;;
  esac
}

# 从 .env.deploy 读取变量值（不打印）。支持 CRLF 与成对引号。
env_value() {
  local key="$1" file="$2" value
  [ -f "$file" ] || return 1
  value="$(awk -v k="$key" '
    BEGIN { FS = "="; found = "" }
    index($0, k "=") == 1 {
      v = $0; sub("^" k "=", "", v); found = v
    }
    END { printf "%s", found }
  ' "$file" | tr -d '\r')"
  case "$value" in
    \"*\") value="${value#\"}"; value="${value%\"}" ;;
    \'*\') value="${value#\'}"; value="${value%\'}" ;;
  esac
  printf '%s' "$value"
}

assert_env_safe() {
  local name="$1" value="$2"
  case "$value" in
    *'
'*) die "$name 含换行，拒绝写入" ;;
  esac
  if ! printf '%s' "$value" | grep -Eq '^[A-Za-z0-9._~+/=-]{16,256}$'; then
    die "$name 含不安全字符或长度不在 16..256（仅允许 A-Za-z0-9._~+/=-）"
  fi
}

random_token() {
  local want="$1" out=""
  while [ "${#out}" -lt "$want" ]; do
    out="${out}$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
  done
  printf '%s' "${out:0:want}"
}

detect_network() {
  if [ -n "$PUBLIC_NETWORK_IN" ]; then
    printf '%s' "$PUBLIC_NETWORK_IN"
    return 0
  fi
  local detected
  detected="$(docker network ls --format '{{.Name}}' 2>/dev/null | grep -E '(^|_)public-edge$' | head -n 1 || true)"
  if [ -z "$detected" ]; then
    detected="$(docker network ls --format '{{.Name}}' 2>/dev/null | grep -E 'public-edge' | head -n 1 || true)"
  fi
  printf '%s' "$detected"
}

backup_deploy() {
  local stamp backup manifest file
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  backup="$BACKUP_ROOT/video-$stamp"
  install -d -m 700 "$BACKUP_ROOT" "$backup"
  manifest="$backup/manifest.txt"
  : >"$manifest"
  chmod 600 "$manifest"
  for file in compose.public.yaml .env.deploy Caddyfile compose.video.yaml video.env; do
    if [ -f "$DEPLOY_DIR/$file" ]; then
      cp -a "$DEPLOY_DIR/$file" "$backup/$file"
      printf '%s\n' "$file" >>"$manifest"
    fi
  done
  docker compose -p "$PROJECT_NAME" --env-file "$ENV_FILE" -f "$COMPOSE_MAIN" ps \
    >"$backup/compose.ps.txt" 2>/dev/null || true
  docker ps --format '{{.Names}}\t{{.Status}}\t{{.Ports}}' >"$backup/docker.ps.txt" 2>/dev/null || true
  if [ -f "$COMPOSE_MAIN" ]; then
    # 刻意 --no-interpolate：避免把解析后的密钥写进备份文本。
    docker compose -p "$PROJECT_NAME" --env-file "$ENV_FILE" -f "$COMPOSE_MAIN" config --no-interpolate \
      >"$backup/compose-config.no-interpolate.yaml" 2>/dev/null || true
    chmod 600 "$backup/compose-config.no-interpolate.yaml" 2>/dev/null || true
  fi
  printf '%s' "$backup"
}

restore_backup() {
  [ -n "$BACKUP_DIR" ] && [ -d "$BACKUP_DIR" ] || { warn "没有可用备份目录"; return 1; }
  local manifest="$BACKUP_DIR/manifest.txt" file
  [ -f "$manifest" ] || { warn "备份缺少 manifest.txt"; return 1; }
  while IFS= read -r file; do
    [ -n "$file" ] || continue
    if [ -f "$BACKUP_DIR/$file" ]; then
      cp -a "$BACKUP_DIR/$file" "$DEPLOY_DIR/$file"
      log "已恢复 $DEPLOY_DIR/$file"
    fi
  done <"$manifest"
  # 安装前不存在的文件（本次新增）回滚时删除。
  for file in compose.video.yaml video.env; do
    if ! grep -qx "$file" "$manifest"; then
      rm -f "$DEPLOY_DIR/$file"
      log "已移除本次新增的 $DEPLOY_DIR/$file"
    fi
  done
}

resolve_agent_key() {
  local existing=""
  if [ -f "$VIDEO_ENV" ]; then
    existing="$(env_value VIDEO_AGENT_KEY "$VIDEO_ENV" || true)"
  fi
  if [ -n "$AGENT_KEY_IN" ]; then
    AGENT_KEY="$AGENT_KEY_IN"
  elif [ -n "$existing" ]; then
    AGENT_KEY="$existing"
    log "复用已有 video.env 中的 VIDEO_AGENT_KEY"
  else
    AGENT_KEY="$(random_token 48)"
    GENERATED_KEY=1
  fi
  assert_env_safe VIDEO_AGENT_KEY "$AGENT_KEY"
}

write_video_env() {
  local tmp
  tmp="$(mktemp "$DEPLOY_DIR/.video.env.XXXXXX")"
  chmod 600 "$tmp"
  {
    printf '# 由 deploy/video/install-on-ecs.sh 于 %s 生成；含密钥，权限 600，禁止提交/外传。\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf '# ECS 上 relay 运行 agent 模式：PC agent 出站 WSS 注册；不直连 DAYU。\n'
    printf 'VIDEO_MODE=agent\n'
    printf 'VIDEO_RELAY_HOST=0.0.0.0\n'
    printf 'VIDEO_RELAY_PORT=%s\n' "$RELAY_PORT"
    printf 'BACKEND_BASE=http://backend:8080\n'
    printf 'VIDEO_AGENT_KEY=%s\n' "$AGENT_KEY"
    printf 'VIDEO_MAX_VIEWERS=2\n'
    printf 'VIDEO_IDLE_STOP_MS=3000\n'
    printf 'VIDEO_TICKET_TTL_MS=60000\n'
    printf 'VIDEO_DAYU_DOWN_GRACE_MS=30000\n'
    printf 'VIDEO_HEARTBEAT_MS=5000\n'
    printf 'VIDEO_RECONNECT_DELAYS_MS=500,1000,2000,5000,10000\n'
    printf 'VIDEO_SESSION_RATE_LIMIT=10\n'
    printf 'VIDEO_SESSION_RATE_WINDOW_MS=60000\n'
    printf 'VIDEO_BACKEND_TIMEOUT_MS=5000\n'
    printf 'VIDEO_ACCESS_LOG=1\n'
    printf 'VIDEO_LOG_LEVEL=info\n'
  } >"$tmp"
  mv -f "$tmp" "$VIDEO_ENV"
  chmod 600 "$VIDEO_ENV"
}

stage_code() {
  local src="$SRC_PACKAGE"
  install -d -m 755 "$SOURCE_DIR"
  rm -rf "$SOURCE_DIR/src" "$SOURCE_DIR/vendor"
  cp -a "$src/src" "$SOURCE_DIR/src"
  cp -a "$src/vendor" "$SOURCE_DIR/vendor"
  local file
  for file in server.js agent.js package.json README.md .env.example; do
    if [ -f "$src/$file" ]; then cp -a "$src/$file" "$SOURCE_DIR/$file"; fi
  done
  chmod -R a+rX "$SOURCE_DIR"
}

install_compose_file() {
  cp -a "$SCRIPT_DIR/compose.video.yaml" "$COMPOSE_VIDEO.tmp"
  mv -f "$COMPOSE_VIDEO.tmp" "$COMPOSE_VIDEO"
  chmod 644 "$COMPOSE_VIDEO"
  cp -a "$SCRIPT_DIR/rollback.sh" "$DEPLOY_DIR/rollback-video.sh"
  chmod 700 "$DEPLOY_DIR/rollback-video.sh"
}

compose() {
  # 回滚时 compose.video.yaml 可能已被移除：此时只带主 compose，避免 -f 指向不存在文件。
  if [ -f "$COMPOSE_VIDEO" ]; then
    docker compose -p "$PROJECT_NAME" --env-file "$ENV_FILE" \
      -f "$COMPOSE_MAIN" -f "$COMPOSE_VIDEO" "$@"
  else
    docker compose -p "$PROJECT_NAME" --env-file "$ENV_FILE" \
      -f "$COMPOSE_MAIN" "$@"
  fi
}

caddy_container() {
  docker ps --filter "label=com.docker.compose.project=$PROJECT_NAME" \
    --filter 'label=com.docker.compose.service=caddy' --format '{{.Names}}' | head -n 1
}

# 幂等修改 Caddyfile：/video/* 反代 + query 脱敏（ticket/key）。
patch_caddyfile() {
  local tmp="$CADDYFILE.video-tmp" tmp2="$CADDYFILE.video-tmp2" orig="$CADDYFILE.video-orig"
  cp -a "$CADDYFILE" "$tmp"
  cp -a "$CADDYFILE" "$orig"

  if grep -q 'video-relay:9443' "$tmp"; then
    log "Caddyfile 已包含 /video/* 反代，跳过路由插入"
  else
    grep -Eq '^[[:space:]]*reverse_proxy[[:space:]]+backend:8080' "$tmp" \
      || die "Caddyfile 中找不到 'reverse_proxy backend:8080'，拒绝猜测修改"
    if ! awk '
      BEGIN { inserted = 0 }
      /^[[:space:]]*reverse_proxy[[:space:]]+backend:8080/ && !inserted {
        print "\t# 视频探望中继（deploy/video/install-on-ecs.sh 安装；只代理 /video/*）";
        print "\treverse_proxy /video/* video-relay:9443";
        print "";
        inserted = 1;
      }
      { print }
      END { if (!inserted) exit 3 }
    ' "$tmp" >"$tmp2"; then
      rm -f "$tmp" "$tmp2"
      die "插入 /video/* 反代失败"
    fi
    mv -f "$tmp2" "$tmp"
  fi

  if grep -q 'request>uri query' "$tmp"; then
    log "Caddyfile 已包含 query 脱敏，跳过"
  else
    if ! grep -q 'format filter' "$tmp"; then
      rm -f "$tmp"
      die "Caddyfile log 段不是 filter 格式，无法自动脱敏 ticket/key；拒绝上线（请按 Caddyfile.video.snippet 手工加 query 过滤）"
    fi
    if ! awk '
      BEGIN { inserted = 0 }
      /^[[:space:]]*fields[[:space:]]*\{/ && !inserted {
        print;
        print "\t\t\t\trequest>uri query {";
        print "\t\t\t\t\tdelete ticket";
        print "\t\t\t\t\tdelete key";
        print "\t\t\t\t}";
        inserted = 1;
        next;
      }
      { print }
      END { if (!inserted) exit 3 }
    ' "$tmp" >"$tmp2"; then
      rm -f "$tmp" "$tmp2"
      die "插入 query 脱敏失败"
    fi
    mv -f "$tmp2" "$tmp"
  fi

  # 脱敏必须真实存在，否则宁可失败也不把 ticket/key 写进访问日志。
  grep -q 'delete ticket' "$tmp" && grep -q 'delete key' "$tmp" \
    || { rm -f "$tmp" "$tmp2" "$orig"; die "Caddyfile 缺少 ticket/key 脱敏，拒绝上线"; }

  if cmp -s "$orig" "$tmp"; then
    rm -f "$tmp" "$tmp2" "$orig"
    log "Caddyfile 无需修改（已是目标状态）"
    return 0
  fi

  validate_caddyfile "$tmp" || { rm -f "$tmp" "$tmp2" "$orig"; die "caddy validate 失败，未改动线上 Caddyfile"; }
  mv -f "$tmp" "$CADDYFILE"
  rm -f "$tmp2" "$orig"
  CADDY_CHANGED=1
  log "Caddyfile 已更新（备份在 $BACKUP_DIR）"
}

validate_caddyfile() {
  local file="$1" out
  if ! out="$(docker run --rm --network none \
      -e PUBLIC_DOMAIN="$PUBLIC_DOMAIN" -e ACME_EMAIL="$ACME_EMAIL" \
      -v "$file:/etc/caddy/Caddyfile:ro" \
      caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1)"; then
    warn "caddy validate 输出（不含密钥）:"
    printf '%s\n' "$out" | sed 's/^/  /' >&2
    return 1
  fi
  return 0
}

wait_healthy() {
  local cid status i
  for i in $(seq 1 60); do
    cid="$(compose ps -q "$SERVICE_NAME" 2>/dev/null | head -n 1 || true)"
    [ -n "$cid" ] || { sleep 1; continue; }
    status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null || echo unknown)"
    case "$status" in
      healthy) log "容器健康状态: healthy" >&2; printf '%s' "$cid"; return 0 ;;
      unhealthy) log "容器健康状态: unhealthy（继续观察）" >&2 ;;
    esac
    sleep 1
  done
  return 1
}

wait_public() {
  local path="$1" want="$2" deadline=$((SECONDS + ${3:-60})) code
  while [ "$SECONDS" -lt "$deadline" ]; do
    code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 8 \
      --resolve "$PUBLIC_DOMAIN:443:127.0.0.1" "https://$PUBLIC_DOMAIN$path" 2>/dev/null || true)"
    if [ "$code" = "$want" ]; then return 0; fi
    sleep 2
  done
  return 1
}

verify_container() {
  local cid="$1" ports
  docker exec "$cid" node -e \
    "fetch('http://127.0.0.1:${RELAY_PORT}/video/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
    >/dev/null 2>&1 || die "自检失败: 容器内 /video/healthz 不可用"
  log "自检通过: 容器内 /video/healthz 200"

  ports="$(docker port "$cid" 2>/dev/null || true)"
  if [ -n "$ports" ]; then
    die "端口边界违规: video-relay 不应映射主机端口，实际: $(printf '%s' "$ports" | tr '\n' ' ')"
  fi
  log "自检通过: video-relay 未映射任何主机端口（只在 compose 网络内 9443）"

  local caddy
  caddy="$(caddy_container)"
  [ -n "$caddy" ] || die "找不到 caddy 容器，无法验证代理连通性"
  docker exec "$caddy" wget -qO- "http://video-relay:${RELAY_PORT}/video/healthz" 2>/dev/null | grep -q '"ok":true' \
    || die "自检失败: caddy 容器访问不到 http://video-relay:${RELAY_PORT}/video/healthz"
  log "自检通过: caddy 容器可访问 video-relay:${RELAY_PORT}"
}

verify_public() {
  local body code
  body="$(mktemp)"
  code="$(curl -sS -o "$body" -w '%{http_code}' --max-time 10 \
    --resolve "$PUBLIC_DOMAIN:443:127.0.0.1" "https://$PUBLIC_DOMAIN/video/healthz" 2>/dev/null || true)"
  [ "$code" = "200" ] || { rm -f "$body"; die "自检失败: 公网 /video/healthz HTTP $code"; }
  grep -q '"ok":true' "$body" || { rm -f "$body"; die "自检失败: 公网 /video/healthz 响应不是 {\"ok\":true...}"; }
  log "自检通过: https://$PUBLIC_DOMAIN/video/healthz 200 $(tr -d '\n' <"$body")"
  rm -f "$body"

  # /video/session 无 token 必须 401：证明 /video/* 已路由到 relay（backend 只有 404）。
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 \
    --resolve "$PUBLIC_DOMAIN:443:127.0.0.1" -X POST "https://$PUBLIC_DOMAIN/video/session" 2>/dev/null || true)"
  [ "$code" = "401" ] || die "自检失败: POST /video/session 期望 401，实际 $code（路由可能未生效）"
  log "自检通过: POST /video/session 无 token -> 401（/video/* 已到 relay）"

  # 既有 backend 路由必须仍然可用。
  if ! wait_public "/readyz" "200" 60; then
    die "自检失败: https://$PUBLIC_DOMAIN/readyz 未恢复 200（backend 反代可能被破坏）"
  fi
  log "自检通过: https://$PUBLIC_DOMAIN/readyz 仍为 200（backend 路由未受影响）"

  local backend_status caddy_status
  backend_status="$(docker inspect -f '{{.State.Status}}' "${PROJECT_NAME}-backend-1" 2>/dev/null || echo missing)"
  caddy_status="$(docker inspect -f '{{.State.Status}}' "$(caddy_container)" 2>/dev/null || echo missing)"
  log "主栈状态: backend=$backend_status caddy=$caddy_status"
  [ "$backend_status" = "running" ] || warn "backend 当前状态=$backend_status"
}

rollback_inline() {
  [ "$ROLLING_BACK" = 1 ] && return 0
  ROLLING_BACK=1
  [ "$INSTALL_IN_PROGRESS" = 1 ] || return 0
  warn "安装未完成，开始自动回滚..."
  restore_backup || warn "恢复备份不完整，请人工检查 $DEPLOY_DIR"
  compose rm -sf "$SERVICE_NAME" >/dev/null 2>&1 || true
  local relay_cid
  relay_cid="$(docker ps -aq \
    --filter "label=com.docker.compose.project=$PROJECT_NAME" \
    --filter "label=com.docker.compose.service=$SERVICE_NAME" | head -n 1 || true)"
  if [ -n "$relay_cid" ]; then
    docker rm -f "$relay_cid" >/dev/null 2>&1 || true
  fi
  compose restart caddy >/dev/null 2>&1 || true
  if wait_public "/readyz" "200" 60; then
    warn "回滚完成: Caddyfile/compose 已还原，video-relay 已移除，/readyz 200"
  else
    warn "回滚后 /readyz 仍未恢复 200；请立刻检查: docker logs ${PROJECT_NAME}-caddy-1"
  fi
  warn "备份目录: $BACKUP_DIR"
}

print_success() {
  local view_key_hint="sudo sed -n 's/^VIDEO_AGENT_KEY=//p' $VIDEO_ENV"
  cat <<EOF

============================================================
video-relay 安装完成（只新增 1 个服务，未改 backend，无新增公网端口）

公网入口（仅 443）:
  https://$PUBLIC_DOMAIN/video/healthz    健康检查（无鉴权）
  https://$PUBLIC_DOMAIN/video/session    APP 申请一次性 ticket（Bearer token）
  wss://$PUBLIC_DOMAIN/video/stream?ticket=...   WS 观看（一次性 60s ticket）
  wss://$PUBLIC_DOMAIN/video/agent?key=...      PC agent 注册（仅服务端知道 key）

PC agent 启动命令（PC 上先确认 hdc fport tcp:9301 tcp:9301 已建立）:
  node competition/video/relay/agent.js \\
    --relay wss://$PUBLIC_DOMAIN/video/agent \\
    --key <VIDEO_AGENT_KEY> \\
    --dayu 127.0.0.1:9301

取 VIDEO_AGENT_KEY（脚本不显示；只在本机终端执行）:
  $view_key_hint

常用运维:
  状态: docker compose -p $PROJECT_NAME --env-file $ENV_FILE -f $COMPOSE_MAIN -f $COMPOSE_VIDEO ps
  日志: docker compose -p $PROJECT_NAME --env-file $ENV_FILE -f $COMPOSE_MAIN -f $COMPOSE_VIDEO logs --tail=200 -f $SERVICE_NAME
  公网自检: curl -sS https://$PUBLIC_DOMAIN/video/healthz
  回滚: sudo bash $DEPLOY_DIR/rollback-video.sh

成功标志:
  1) 本脚本全部 "自检通过"
  2) 公网 /video/healthz 返回 {"ok":true,...}
  3) PC agent 启动后 healthz 的 dayuLink 由 down 变 connected（需手机正在观看时才连 DAYU）
  4) 手机退出观看 -> 3s 后 relay 日志出现 "idle stop: no viewers"

备份（含 .env.deploy/Caddyfile，700 目录，勿外传）:
  $BACKUP_DIR
============================================================
EOF
}

on_error() {
  local code=$?
  trap - ERR
  if [ "$INSTALL_IN_PROGRESS" = 1 ] && [ "$SUCCESS" = 0 ]; then
    rollback_inline
  fi
  exit "$code"
}

main() {
  parse_args "$@"
  require_commands
  preflight

  log "部署目录: $DEPLOY_DIR"
  log "源码目录: $SRC_PACKAGE -> $SOURCE_DIR (只读挂载 /opt/video-relay)"
  BACKUP_DIR="$(backup_deploy)"
  log "已备份现有部署到: $BACKUP_DIR"

  PUBLIC_NETWORK="$(detect_network)"
  [ -n "$PUBLIC_NETWORK" ] || die "未找到 public-edge Docker 网络；请确认 eldercare-public 主栈已启动，或用 --network 指定"
  log "使用 Docker 网络: $PUBLIC_NETWORK"
  export VIDEO_PUBLIC_NETWORK="$PUBLIC_NETWORK"
  export VIDEO_ENV_FILE="$VIDEO_ENV"
  export VIDEO_SOURCE_DIR="$SOURCE_DIR"

  INSTALL_IN_PROGRESS=1
  resolve_agent_key
  write_video_env
  log "已生成 $VIDEO_ENV (600)$([ "$GENERATED_KEY" = 1 ] && printf '，已生成新的 VIDEO_AGENT_KEY（不显示，按成功提示查看）' || true)"
  stage_code
  log "已同步 relay 源码（含 vendor/ws）到 $SOURCE_DIR"
  install_compose_file
  log "已安装 $COMPOSE_VIDEO 与 rollback-video.sh"
  patch_caddyfile

  log "启动/更新 $SERVICE_NAME ..."
  compose up -d --no-deps "$SERVICE_NAME"
  local cid
  cid="$(wait_healthy)" || {
    warn "容器未在 60s 内变为 healthy，输出最近日志："
    compose logs --tail=120 "$SERVICE_NAME" || true
    die "安装失败；已尝试自动回滚"
  }
  verify_container "$cid"

  if [ "$CADDY_CHANGED" = 1 ]; then
    log "重启 caddy 使 /video/* 路由与 query 脱敏生效 ..."
    compose restart caddy
    wait_public "/video/healthz" "200" 60 || die "caddy 重启后公网 /video/healthz 未在 60s 内就绪"
  else
    log "Caddyfile 无变化，未重启 caddy"
  fi

  verify_public
  SUCCESS=1
  print_success
}

# 允许被本地测试脚本 source 后单独调用函数（例如验证 Caddyfile patch 逻辑）。
if [ "${BASH_SOURCE[0]:-}" = "$0" ]; then
  trap on_error ERR
  main "$@"
fi
