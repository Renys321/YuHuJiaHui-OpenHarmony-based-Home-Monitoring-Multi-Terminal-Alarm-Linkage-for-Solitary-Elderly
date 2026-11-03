#!/usr/bin/env bash
#
# install-on-ecs.sh — 在 ECS 上安装/升级 wearable-mqtt（随身 SOS 公网适配服务）。
#
# 设计边界（2026-10-27 Lead 决策）：
#   - 不新建镜像：复用已有 eldercare-cloud-backend:local（node 运行时），
#     entrypoint 覆盖为 node /opt/wearable/server.js；源码只读挂载。
#   - 只新增 wearable-mqtt 一个服务；不重建/不修改 backend、caddy。
#   - 只发布 1883/tcp；install 后自检端口表，禁止出现 8080/9000/9001/9100/9101。
#   - 安装前备份 /opt/eldercare/deploy（compose + .env.deploy + 容器状态），
#     失败可一键 rollback.sh 恢复。
#   - 密钥只写入 /opt/eldercare/deploy/wearable.env（600），
#     脚本绝不回显 MQTT_PASS / INGEST_KEY。
#
# 用法（详细步骤见 README.md）：
#   bash install-on-ecs.sh --mqtt-user wearable-sos-001
#   bash install-on-ecs.sh --mqtt-user u --mqtt-pass 'strong-pass'
#   bash install-on-ecs.sh --generate-credentials
#
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPETITION_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

DEPLOY_DIR="${DEPLOY_DIR:-/opt/eldercare/deploy}"
SOURCE_DIR="${SOURCE_DIR:-/opt/eldercare/wearable}"
SRC_PACKAGE="${SRC_PACKAGE:-$COMPETITION_ROOT/cloud/wearable-mqtt}"
PROJECT_NAME="${PROJECT_NAME:-eldercare-public}"
SERVICE_NAME="wearable-mqtt"
IMAGE_NAME="${IMAGE_NAME:-eldercare-cloud-backend:local}"

MQTT_USER_IN="${WEARABLE_MQTT_USER:-}"
MQTT_PASS_IN="${WEARABLE_MQTT_PASS:-}"
MQTT_CLIENT_ID="${WEARABLE_MQTT_CLIENT_ID:-wearable-sos-001}"
UP_TOPIC="${WEARABLE_UP_TOPIC:-eldercare/wearable/sos-001/up}"
DOWN_TOPIC="${WEARABLE_DOWN_TOPIC:-eldercare/wearable/sos-001/down}"
BACKEND_BASE="${WEARABLE_BACKEND_BASE:-http://backend:8080}"
DEVICE_ID="${WEARABLE_DEVICE_ID:-esp32-sos}"
LOCATION_DEVICE_ID="${WEARABLE_LOCATION_DEVICE_ID:-wearable-sos-001}"
GENERATE_CREDENTIALS=0
PUBLIC_NETWORK_IN="${WEARABLE_PUBLIC_NETWORK:-}"
BACKUP_DIR=""
PUBLIC_NETWORK=""

log()  { printf '[wearable-mqtt] %s\n' "$*"; }
warn() { printf '[wearable-mqtt] WARN: %s\n' "$*" >&2; }
die()  { printf '[wearable-mqtt] ERROR: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
用法: bash install-on-ecs.sh [选项]

选项:
  --mqtt-user USER        M100 登录用户名（也可用环境变量 WEARABLE_MQTT_USER）
  --mqtt-pass PASS        M100 登录密码（也可用 WEARABLE_MQTT_PASS；交互执行时建议留空由脚本提示）
  --generate-credentials  未提供凭据时生成 32 位随机用户名/密码并打印一次
  --mqtt-client-id ID     M100 Client ID（默认 wearable-sos-001，必须是白名单）
  --up-topic TOPIC        上行主题（默认 eldercare/wearable/sos-001/up）
  --down-topic TOPIC      下行主题（默认 eldercare/wearable/sos-001/down）
  --network NAME          指定 public-edge 网络真实名称（默认自动探测）
  --src-package DIR       本地 wearable-mqtt 源码目录（默认 competition/cloud/wearable-mqtt）
  --deploy-dir DIR        ECS 部署目录（默认 /opt/eldercare/deploy）
  --source-dir DIR        容器只读挂载目录（默认 /opt/eldercare/wearable）
  --help                  显示帮助

说明:
  - 脚本不会打印密码/INGEST_KEY；凭据写入 /opt/eldercare/deploy/wearable.env (600)。
  - 安装前备份 compose、.env.deploy 与容器状态到 /opt/eldercare/deploy/backup/。
  - 失败时执行: bash <本脚本同目录>/rollback.sh
EOF
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --mqtt-user) MQTT_USER_IN="${2:-}"; shift 2 ;;
      --mqtt-pass) MQTT_PASS_IN="${2:-}"; shift 2 ;;
      --generate-credentials) GENERATE_CREDENTIALS=1; shift ;;
      --mqtt-client-id) MQTT_CLIENT_ID="${2:-}"; shift 2 ;;
      --up-topic) UP_TOPIC="${2:-}"; shift 2 ;;
      --down-topic) DOWN_TOPIC="${2:-}"; shift 2 ;;
      --network) PUBLIC_NETWORK_IN="${2:-}"; shift 2 ;;
      --src-package) SRC_PACKAGE="${2:-}"; shift 2 ;;
      --deploy-dir) DEPLOY_DIR="${2:-}"; shift 2 ;;
      --source-dir) SOURCE_DIR="${2:-}"; shift 2 ;;
      --help|-h) usage; exit 0 ;;
      *) die "未知参数: $1（--help 查看用法）" ;;
    esac
  done
  # 允许 --deploy-dir/--source-dir 覆盖后再推导默认路径（注意：必须先解析参数）。
  BACKUP_ROOT="${BACKUP_ROOT:-$DEPLOY_DIR/backup}"
  ENV_FILE="${ENV_FILE:-$DEPLOY_DIR/.env.deploy}"
  WEARABLE_ENV="${WEARABLE_ENV:-$DEPLOY_DIR/wearable.env}"
  COMPOSE_MAIN="${COMPOSE_MAIN:-$DEPLOY_DIR/compose.public.yaml}"
  COMPOSE_WEARABLE="${COMPOSE_WEARABLE:-$DEPLOY_DIR/compose.wearable.yaml}"
}

require_commands() {
  command -v docker >/dev/null 2>&1 || die "未找到 docker"
  docker compose version >/dev/null 2>&1 || die "未找到 docker compose 插件"
  command -v awk >/dev/null 2>&1 || die "未找到 awk"
  command -v od >/dev/null 2>&1 || die "未找到 od"
}

preflight() {
  [ -f "$SRC_PACKAGE/server.js" ] || die "源码目录无效（缺 server.js）: $SRC_PACKAGE"
  [ -d "$SRC_PACKAGE/src" ] || die "源码目录无效（缺 src/）: $SRC_PACKAGE"
  [ -f "$COMPOSE_MAIN" ] || die "未找到 $COMPOSE_MAIN（请先在 ECS 部署 eldercare-public 主栈）"
  [ -f "$ENV_FILE" ] || die "未找到 $ENV_FILE（backend 部署变量文件）"
  [ -f "$SCRIPT_DIR/compose.wearable.yaml" ] || die "部署包缺少 compose.wearable.yaml"
  docker info >/dev/null 2>&1 || die "无法访问 docker daemon（需要 root 或 docker 组权限）"
  docker image inspect "$IMAGE_NAME" >/dev/null 2>&1 \
    || die "缺少镜像 $IMAGE_NAME；请先在 ECS 完成 backend 部署（不新建镜像）"
  [ -f "$DEPLOY_DIR/compose.public.yaml" ] || die "缺少主 compose: $DEPLOY_DIR/compose.public.yaml"
  # 已运行的主栈容器必须保持健康；本脚本不会重启它们。
  if ! docker ps --format '{{.Names}}' | grep -qx "${PROJECT_NAME}-backend-1"; then
    warn "未发现运行中的 ${PROJECT_NAME}-backend-1；请确认 backend 主栈已启动（本脚本不会替你启动）"
  fi
  # 1883 必须空闲或由本服务自身占用（升级场景）；本脚本绝不停止未知进程。
  if command -v timeout >/dev/null 2>&1 && \
     timeout 1 bash -c 'exec 3<>/dev/tcp/127.0.0.1/1883' >/dev/null 2>&1; then
    if docker ps --format '{{.Names}}' | grep -qx "${PROJECT_NAME}-${SERVICE_NAME}-1"; then
      log "1883 由现有 wearable-mqtt 容器占用，按升级流程继续"
    else
      die "1883 已被其它进程/容器占用；本脚本不会停止未知进程，请先确认并停止后重试"
    fi
  fi
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

# 只允许可安全写入 Compose env 文件的字符，避免密钥里 $/#/空格破坏解析。
assert_env_safe() {
  local name="$1" value="$2"
  case "$value" in
    *'
'*) die "$name 含换行，拒绝写入" ;;
  esac
  if ! printf '%s' "$value" | grep -Eq '^[A-Za-z0-9._~+/=-]{1,200}$'; then
    die "$name 含不安全字符（仅允许 A-Za-z0-9._~+/=- 且长度 1..200）；请换一个值后重试"
  fi
}

random_token() {
  local out="" chunk
  while [ ${#out} -lt 40 ]; do
    chunk="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
    out="${out}${chunk}"
  done
  printf '%s' "${out:0:32}"
}

# 探测 public-edge 网络真实名称（eldercare-public_public-edge 或自定义）。
detect_network() {
  if [ -n "$PUBLIC_NETWORK_IN" ]; then
    printf '%s' "$PUBLIC_NETWORK_IN"
    return 0
  fi
  local tmp detected
  tmp="$(mktemp)"
  docker network ls --format '{{.Name}}' >"$tmp" 2>/dev/null || true
  detected="$(grep -E '(^|_)public-edge$' "$tmp" | head -n 1 || true)"
  if [ -z "$detected" ]; then
    detected="$(grep -E 'public-edge' "$tmp" | head -n 1 || true)"
  fi
  rm -f "$tmp"
  printf '%s' "$detected"
}

backup_deploy() {
  local stamp backup manifest
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  backup="$BACKUP_ROOT/wearable-$stamp"
  install -d -m 700 "$BACKUP_ROOT" "$backup"
  manifest="$backup/manifest.txt"
  : >"$manifest"
  chmod 600 "$manifest"

  local file
  for file in compose.public.yaml compose.wearable.yaml .env.deploy wearable.env; do
    if [ -f "$DEPLOY_DIR/$file" ]; then
      cp -a "$DEPLOY_DIR/$file" "$backup/$file"
      chmod 600 "$backup/$file"
      printf '%s\n' "$file" >>"$manifest"
    fi
  done
  # 升级场景额外备份当前线上源码目录：回滚时用 rollback-upgrade.sh 恢复旧版本代码
  # （compose override 未变化时 docker compose 不会重建容器，源码是只读 bind mount，
  #  必须“恢复源码 + 强制重建/重启”才能真正回到旧版本）。
  if [ -d "$SOURCE_DIR" ]; then
    local src_base src_name
    src_base="$(dirname "$SOURCE_DIR")"
    src_name="$(basename "$SOURCE_DIR")"
    if tar -czf "$backup/wearable-src-before.tar.gz" -C "$src_base" "$src_name" 2>/dev/null; then
      chmod 600 "$backup/wearable-src-before.tar.gz"
      printf '%s\n' "wearable-src-before.tar.gz" >>"$manifest"
      # 注意：backup_deploy 的 stdout 会被 main 捕获为 BACKUP_DIR，日志必须走 stderr。
      printf '[wearable-mqtt] 已备份线上源码: %s/wearable-src-before.tar.gz\n' "$backup" >&2
    else
      warn "线上源码备份失败（继续安装；回滚将无法恢复旧代码版本）: $SOURCE_DIR"
    fi
  fi
  # 记录容器状态方便回滚核对；不保存任何解析后的密钥值。
  docker compose -p "$PROJECT_NAME" --env-file "$ENV_FILE" -f "$COMPOSE_MAIN" ps \
    >"$backup/compose.ps.txt" 2>/dev/null || true
  docker ps --format '{{.Names}}\t{{.Status}}\t{{.Ports}}' >"$backup/docker.ps.txt" 2>/dev/null || true
  if [ -f "$COMPOSE_MAIN" ]; then
    # 刻意使用 --no-interpolate：避免把解析后的密钥写进备份文本。
    docker compose -p "$PROJECT_NAME" --env-file "$ENV_FILE" -f "$COMPOSE_MAIN" config --no-interpolate \
      >"$backup/compose-config.no-interpolate.yaml" 2>/dev/null || true
    chmod 600 "$backup/compose-config.no-interpolate.yaml" 2>/dev/null || true
  fi
  chmod 600 "$backup"/*.txt 2>/dev/null || true
  printf '%s' "$backup"
}

resolve_credentials() {
  local existing_user="" existing_pass=""
  if [ -f "$WEARABLE_ENV" ]; then
    existing_user="$(env_value MQTT_USER "$WEARABLE_ENV" || true)"
    existing_pass="$(env_value MQTT_PASS "$WEARABLE_ENV" || true)"
  fi

  if [ -n "$MQTT_USER_IN" ] && [ -z "$MQTT_PASS_IN" ]; then
    if [ -n "$existing_pass" ] && [ "$MQTT_USER_IN" = "$existing_user" ]; then
      MQTT_PASS_IN="$existing_pass"
    elif [ -t 0 ]; then
      printf 'MQTT_PASS (输入不回显): '
      read -rs MQTT_PASS_IN
      printf '\n'
    else
      die "只提供了 --mqtt-user，缺少 --mqtt-pass（或 WEARABLE_MQTT_PASS）"
    fi
  fi
  if [ -z "$MQTT_USER_IN" ] && [ -n "$MQTT_PASS_IN" ]; then
    die "只提供了 --mqtt-pass，缺少 --mqtt-user（或 WEARABLE_MQTT_USER）"
  fi
  if [ -z "$MQTT_USER_IN" ] || [ -z "$MQTT_PASS_IN" ]; then
    if [ "$GENERATE_CREDENTIALS" = "1" ]; then
      MQTT_USER_IN="wearable-$(random_token | cut -c1-8)"
      MQTT_PASS_IN="$(random_token)$(random_token)"
      log "已生成 MQTT 凭据（只显示一次，请立即配置到 M100）："
      printf '  MQTT_USER=%s\n  MQTT_PASS=%s\n' "$MQTT_USER_IN" "$MQTT_PASS_IN"
    elif [ -n "$existing_user" ] && [ -n "$existing_pass" ]; then
      MQTT_USER_IN="$existing_user"
      MQTT_PASS_IN="$existing_pass"
      log "复用已有 wearable.env 中的 MQTT 凭据"
    elif [ -t 0 ]; then
      printf 'MQTT_USER [wearable-sos-001]: '
      read -r MQTT_USER_IN
      [ -n "$MQTT_USER_IN" ] || MQTT_USER_IN="wearable-sos-001"
      printf 'MQTT_PASS (输入不回显): '
      read -rs MQTT_PASS_IN
      printf '\n'
      [ -n "$MQTT_PASS_IN" ] || die "MQTT_PASS 不能为空"
    else
      die "缺少 MQTT 凭据：请加 --mqtt-user/--mqtt-pass、设置 WEARABLE_MQTT_*，或使用 --generate-credentials"
    fi
  fi

  case "$MQTT_USER_IN" in
    *[!A-Za-z0-9._-]*) die "MQTT_USER 只允许 A-Za-z0-9._-（1..64 字符）" ;;
  esac
  [ "${#MQTT_USER_IN}" -ge 1 ] && [ "${#MQTT_USER_IN}" -le 64 ] || die "MQTT_USER 长度必须 1..64"
  assert_env_safe MQTT_PASS "$MQTT_PASS_IN"
}

write_wearable_env() {
  local ingest_key tmp
  ingest_key="$(env_value INGEST_KEY "$ENV_FILE" || true)"
  [ -n "$ingest_key" ] || die "$ENV_FILE 缺少 INGEST_KEY（backend 必需变量）"
  assert_env_safe INGEST_KEY "$ingest_key"

  case "$MQTT_CLIENT_ID" in
    *[!A-Za-z0-9._:-]*) die "MQTT_CLIENT_ID 只允许 A-Za-z0-9._:-" ;;
  esac

  tmp="$(mktemp "$DEPLOY_DIR/.wearable.env.XXXXXX")"
  chmod 600 "$tmp"
  {
    printf '# 由 install-on-ecs.sh 于 %s 生成；含密钥，权限 600，禁止提交/外传。\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf 'MQTT_USER=%s\n' "$MQTT_USER_IN"
    printf 'MQTT_PASS=%s\n' "$MQTT_PASS_IN"
    printf 'MQTT_CLIENT_ID=%s\n' "$MQTT_CLIENT_ID"
    printf 'UP_TOPIC=%s\n' "$UP_TOPIC"
    printf 'DOWN_TOPIC=%s\n' "$DOWN_TOPIC"
    printf 'BACKEND_BASE=%s\n' "$BACKEND_BASE"
    printf 'DEVICE_ID=%s\n' "$DEVICE_ID"
    printf 'LOCATION_DEVICE_ID=%s\n' "$LOCATION_DEVICE_ID"
    printf 'INGEST_KEY=%s\n' "$ingest_key"
    printf 'DATA_DIR=/data\n'
    printf 'STATUS_HOST=127.0.0.1\n'
    printf 'STATUS_PORT=8099\n'
    printf 'COMMAND_POLL_INTERVAL_MS=1000\n'
    printf 'COMMAND_RETRY_INTERVAL_MS=5000\n'
    printf '# 业务上行（sos/hb/boot/ack）静默超过该时长即如实上报 online=false；\n'
    printf '# 120000 = 4 倍固件心跳周期（30s），容忍 2 次丢帧，避免 M100 短暂重连导致 APP 闪离线。\n'
    printf 'DEVICE_ALIVE_TIMEOUT_MS=120000\n'
    printf 'HTTP_TIMEOUT_MS=5000\n'
    printf 'LOG_LEVEL=info\n'
  } >"$tmp"
  mv -f "$tmp" "$WEARABLE_ENV"
  chmod 600 "$WEARABLE_ENV"
}

stage_code() {
  local src="$SRC_PACKAGE"
  case "$SOURCE_DIR" in
    /|""|/opt|/opt/eldercare) die "SOURCE_DIR 不安全: $SOURCE_DIR" ;;
  esac
  install -d -m 755 "$SOURCE_DIR"
  rm -rf "$SOURCE_DIR/src"
  cp -a "$src/src" "$SOURCE_DIR/src"
  cp -a "$src/server.js" "$SOURCE_DIR/server.js"
  cp -a "$src/package.json" "$SOURCE_DIR/package.json"
  # 回归测试也同步进去（只读挂载 + 容器内 node --test），用于升级后自检；
  # 老版本部署目录可能没有 test/，缺失不算错误。
  rm -rf "$SOURCE_DIR/test"
  if [ -d "$src/test" ]; then
    cp -a "$src/test" "$SOURCE_DIR/test"
  fi
  chmod -R a+rX "$SOURCE_DIR"
}

install_compose_file() {
  cp -a "$SCRIPT_DIR/compose.wearable.yaml" "$COMPOSE_WEARABLE.tmp"
  mv -f "$COMPOSE_WEARABLE.tmp" "$COMPOSE_WEARABLE"
  chmod 644 "$COMPOSE_WEARABLE"
  # 回滚脚本放到部署目录，便于故障时在 ECS 一条命令执行。
  if [ -f "$SCRIPT_DIR/rollback.sh" ]; then
    cp -a "$SCRIPT_DIR/rollback.sh" "$DEPLOY_DIR/rollback-wearable.sh"
    chmod 700 "$DEPLOY_DIR/rollback-wearable.sh"
  fi
}

compose() {
  docker compose -p "$PROJECT_NAME" --env-file "$ENV_FILE" \
    -f "$COMPOSE_MAIN" -f "$COMPOSE_WEARABLE" "$@"
}

wait_healthy() {
  local cid status i
  HEALTHY_CID=""
  for i in $(seq 1 60); do
    cid="$(compose ps -q "$SERVICE_NAME" 2>/dev/null | head -n 1 || true)"
    [ -n "$cid" ] || { sleep 1; continue; }
    status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null || echo unknown)"
    case "$status" in
      healthy)
        log "容器健康状态: healthy" >&2
        HEALTHY_CID="$cid"
        return 0 ;;
      unhealthy)
        log "容器健康状态: unhealthy（继续观察）" >&2 ;;
    esac
    sleep 1
  done
  return 1
}

verify() {
  local cid="$1"

  # 1) /healthz（容器内回环，不对外暴露）
  if docker exec "$cid" node -e "fetch('http://127.0.0.1:8099/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    log "自检通过: /healthz 200"
  else
    die "自检失败: /healthz 不可用"
  fi

  # 2) 1883 主机监听
  if timeout 3 bash -c 'exec 3<>/dev/tcp/127.0.0.1/1883' >/dev/null 2>&1; then
    log "自检通过: 0.0.0.0:1883 可连接"
  else
    die "自检失败: 1883 未监听（docker port $SERVICE_NAME 查看映射）"
  fi

  # 3) 端口边界：只允许 1883/tcp，禁止其它公网端口
  local port_lines
  port_lines="$(docker port "$cid" 2>/dev/null || true)"
  if printf '%s\n' "$port_lines" | grep -qE '(^|[.:])(8080|9000|9001|9100|9101)(/tcp)?$'; then
    die "端口边界违规：检测到禁止端口映射: $(printf '%s' "$port_lines" | tr '\n' ' ')"
  fi
  if printf '%s\n' "$port_lines" | grep -q '1883/tcp'; then
    log "自检通过: 端口映射仅 1883/tcp -> $(printf '%s' "$port_lines" | tr '\n' ' ')"
  else
    die "自检失败: 未发现 1883/tcp 映射: $(printf '%s' "$port_lines" | tr '\n' ' ')"
  fi

  # 4) 主栈容器未被本脚本重启/破坏（只做状态提醒）
  local backend_status caddy_status
  backend_status="$(docker inspect -f '{{.State.Status}}' "${PROJECT_NAME}-backend-1" 2>/dev/null || echo missing)"
  caddy_status="$(docker inspect -f '{{.State.Status}}' "${PROJECT_NAME}-caddy-1" 2>/dev/null || echo missing)"
  log "主栈状态（未改动）: backend=$backend_status caddy=$caddy_status"
  if [ "$backend_status" = "running" ]; then
    log "自检通过: backend 仍在运行（同网络服务名 backend 可解析）"
  else
    warn "backend 当前状态=$backend_status；请在主栈恢复后再验证 SOS 链路"
  fi

  # 5) 诊断摘要（不含密钥）
  docker exec "$cid" node -e "
    fetch('http://127.0.0.1:8099/status').then(r=>r.json()).then(j=>{
      const c=j.config||{}; const a=j.adapter||{}; const ct=a.counters||{};
      console.log('service='+j.service+' version='+j.version+' mqttPort='+c.mqttPort+' deviceId='+c.deviceId+' backend='+c.backendBase);
      console.log('deviceState='+(a.device&&a.device.state)+' online='+(a.device&&a.device.online)+' ons='+(j.broker&&j.broker.counters&&j.broker.counters.connections));
      console.log('reconnectFix: deviceAliveTimeoutMs='+(a.link&&a.link.aliveTimeoutMs)+' offlineReports='+ct.deviceOfflineReports+' parkedRecoveryTriggers='+ct.parkedRecoveryTriggers);
    }).catch(()=>process.exit(1))
  " >/dev/null 2>&1 || warn "诊断摘要读取失败（不影响安装结果，可用 README 的日志命令排查）"

  # 6) 断连自愈回归测试（容器内 node --test，不访问外网/不碰生产后端）
  #    运维口径：测试失败 = 强警告但**不中止安装**（容器已 healthy、/healthz/1883 已通过，
  #    强制中止会把现场留在“新代码已运行却没结论”的状态）。失败输出会打印在安装日志里，
  #    交付文档要求：出现 FAIL 必须人工确认后再演示，必要时按 rollback-upgrade.sh 回滚。
  SELFTEST_RESULT="skipped(no test/)"
  if [ -d "$SOURCE_DIR/test" ]; then
    log "运行断连自愈回归测试（容器内 node --test）..."
    if docker exec "$cid" sh -c 'cd /opt/wearable && node --test "test/*.test.js" >/tmp/wearable-selftest.log 2>&1'; then
      SELFTEST_RESULT="PASS"
      log "自检通过: 回归测试全绿（断连自愈 / 不代报 ACK / 不重复告警 / 离线语义）"
    else
      SELFTEST_RESULT="FAIL(见下方输出)"
      warn "回归测试未全绿（强警告：请勿直接演示；先查下面的输出，或回滚）"
      docker exec "$cid" sh -c 'tail -n 40 /tmp/wearable-selftest.log' >&2 || true
      warn "人工复核命令: docker exec $cid sh -c 'cd /opt/wearable && node --test \"test/*.test.js\"'"
    fi
  else
    warn "部署目录没有 test/，跳过回归测试自检（老包升级场景）"
  fi
}

print_success() {
  cat <<EOF

============================================================
wearable-mqtt 安装完成（只新增 1 个服务，未改动 backend/caddy）

访问入口:
  公网 MQTT:  <ECS_IP>:1883  (MQTT 3.1.1，用户名/密码鉴权)
  Client ID:  $MQTT_CLIENT_ID
  上行 topic: $UP_TOPIC
  下行 topic: $DOWN_TOPIC
  MQTT_USER:  $MQTT_USER_IN
  MQTT_PASS:  已写入 $WEARABLE_ENV (600)，脚本不显示

R1 提醒:
  随身 SOS 演示期间**不要启动**旧家庭网关 public-sync/gateway，
  避免旧 command-sync 抢领 esp32-sos 的 ACK 命令。

M100 联调提醒:
  M100 重启后约需 20~30 秒完成拨号/连接/下行订阅；等 NET 灯 1000ms 慢闪后再测下行，
  避免把"尚未订阅"误判为链路故障。下行 payload 末尾已固定补 '\n'（M100 不补换行）。

常用运维命令:
  查看状态: docker compose -p $PROJECT_NAME --env-file $ENV_FILE -f $COMPOSE_MAIN -f $COMPOSE_WEARABLE ps
  查看日志: docker compose -p $PROJECT_NAME --env-file $ENV_FILE -f $COMPOSE_MAIN -f $COMPOSE_WEARABLE logs --tail=200 -f $SERVICE_NAME
  查看诊断: docker exec \$(docker ps -qf name=$SERVICE_NAME) node -e "fetch('http://127.0.0.1:8099/status').then(r=>r.json()).then(j=>console.log(JSON.stringify(j.adapter.device)))"
  回滚:     bash $DEPLOY_DIR/rollback-wearable.sh --backup $BACKUP_DIR

成功标志:
  1) 本脚本全部 "自检通过"
  2) docker ps 中容器 healthy 且只映射 1883/tcp
  3) 容器内回归自检结果: ${SELFTEST_RESULT:-unknown}（必须 PASS 才能演示）
  4) M100 连上后 /status 的 broker.clients 出现 clientId=$MQTT_CLIENT_ID
  5) 按键后 APP 出现 "随身求助" 告警；APP 确认 -> 设备蜂鸣停止 -> /status commandResultOk 增 1

备份目录（含 .env.deploy 与 compose，600 权限，勿外传）:
  $BACKUP_DIR
============================================================
EOF
}

main() {
  parse_args "$@"
  require_commands
  preflight
  log "部署目录: $DEPLOY_DIR"
  log "源码目录: $SRC_PACKAGE -> $SOURCE_DIR (只读挂载 /opt/wearable)"
  BACKUP_DIR="$(backup_deploy)"
  log "已备份现有部署到: $BACKUP_DIR"

  PUBLIC_NETWORK="$(detect_network)"
  [ -n "$PUBLIC_NETWORK" ] || die "未找到 public-edge 网络；请确认 eldercare-public 主栈已启动，或用 --network 指定"
  log "使用 Docker 网络: $PUBLIC_NETWORK"
  export WEARABLE_PUBLIC_NETWORK="$PUBLIC_NETWORK"
  export WEARABLE_ENV_FILE="$WEARABLE_ENV"
  export WEARABLE_SOURCE_DIR="$SOURCE_DIR"

  resolve_credentials
  write_wearable_env
  log "已生成 $WEARABLE_ENV (600)"
  stage_code
  log "已同步源码到 $SOURCE_DIR"
  install_compose_file
  log "已安装 $COMPOSE_WEARABLE"

  log "启动/更新 $SERVICE_NAME ..."
  # 必须 --force-recreate：源码通过只读 bind mount 注入，compose 配置本身没变时
  # `up -d` 会认为容器“无需变更”而继续跑旧进程里的旧代码（升级不生效）。
  compose up -d --no-deps --force-recreate "$SERVICE_NAME"

  if ! wait_healthy; then
    warn "容器未在 60s 内变为 healthy，输出最近日志："
    compose logs --tail=120 "$SERVICE_NAME" || true
    die "安装失败；请执行回滚: bash $DEPLOY_DIR/rollback-wearable.sh --backup $BACKUP_DIR"
  fi
  verify "$HEALTHY_CID"
  print_success
}

on_error() {
  local code=$?
  trap - ERR
  warn "安装过程中断（exit=$code）。"
  if [ -n "$BACKUP_DIR" ] && [ -d "$BACKUP_DIR" ]; then
    warn "一键回滚: bash $DEPLOY_DIR/rollback-wearable.sh --backup $BACKUP_DIR"
  fi
  exit "$code"
}
trap on_error ERR

main "$@"
