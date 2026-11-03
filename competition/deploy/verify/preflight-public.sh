#!/usr/bin/env sh
# deploy/verify/preflight-public.sh
#
# 公网后端 + HTTPS 上线前预检（第一阶段 P0）。
#
# 用法：
#   chmod +x deploy/verify/preflight-public.sh
#   deploy/verify/preflight-public.sh
#   # 指定其它变量文件：
#   ENV_FILE=/secure/path/.env.deploy sh deploy/verify/preflight-public.sh
#   # 可选：额外验证微信登录端点可达（会真实调用一次微信接口）
#   CHECK_WECHAT_LOGIN=1 deploy/verify/preflight-public.sh
#
# 退出码：0 = 全部公网前置断言通过；1 = 存在失败项；2 = 脚本无法运行。
#
# ---------------------------------------------------------------------------
# 安全约定（改动本脚本时必须保持）
# ---------------------------------------------------------------------------
# 1. 本脚本**只输出变量名**，任何情况下都不输出变量值（含失败与错误分支）。
#    唯一例外是 PUBLIC_DOMAIN：它是公网 DNS 名称、不是敏感值，且必须出现在
#    DNS/TLS/HTTP 断言的输出里才能定位问题。其余 7 个变量的值一律不输出。
# 2. 绝不 `source` / `.` 变量文件：那会执行文件内容。只按名解析 `NAME=value`。
# 3. 绝不 `export` 变量文件里的值，避免泄漏进 curl / openssl 等子进程的环境。
# 4. 值只在 shell 变量之间用 `case` / `[ ]` 比较，不进入任何外部命令的参数。
# 5. 未使用 `set -x`；并显式拒绝以 `sh -x` 运行（-x 会打印赋值，从而打印密钥）。
# 6. 值可以含 `=`（base64 填充），因此只用 `${line#*=}` 去掉第一个 `=`。
#
# 本脚本只做静态检查与公网可达性断言。它**不能**证明：微信登录可用、
# 小程序真机可用、实体设备 ACK 闭环成立、OneNET 已接入。这些层级必须由
# Codex 独立验收后写入 docs/VALIDATION-MATRIX.md。
# ---------------------------------------------------------------------------

set -u

case $- in
	*x*)
		printf 'REFUSE: 请勿以 sh -x 运行本脚本（跟踪输出会打印变量值）。\n' >&2
		exit 2
		;;
esac

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
DEPLOY_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
ENV_FILE=${ENV_FILE:-"$DEPLOY_DIR/.env.deploy"}

# 必须存在的变量（只按名检查）。
REQUIRED_VARS='PUBLIC_DOMAIN ACME_EMAIL API_TOKEN_SECRET INGEST_KEY APP_GUARDIAN_ID APP_GUARDIAN_PASSWORD CONTACTS_JSON'

# 公网主机上绝不允许对外可达的端口：家庭链路 + 后端直连端口。
FORBIDDEN_PORTS='1883 9000 9001 9002 9100 9101 8080'

FAILURES=0
WARNINGS=0
VALUE=''
HTTP_STATUS=''
TMP_FILE=''
RESOLVED_IPS=''

pass() { printf 'PASS  %s\n' "$1"; }
fail() {
	printf 'FAIL  %s\n' "$1"
	FAILURES=$((FAILURES + 1))
}
warn() {
	printf 'WARN  %s\n' "$1"
	WARNINGS=$((WARNINGS + 1))
}
skip() { printf 'SKIP  %s\n' "$1"; }
note() { printf '      %s\n' "$1"; }
section() { printf '\n== %s ==\n' "$1"; }

cleanup() {
	if [ -n "$TMP_FILE" ] && [ -f "$TMP_FILE" ]; then
		rm -f "$TMP_FILE"
	fi
}
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------------------
# 变量文件解析（不 source，不 export）
# ---------------------------------------------------------------------------

# 成功时把值写入 $VALUE 并返回 0；失败返回 1。调用方负责绝不打印 $VALUE。
env_value() {
	_env_name=$1
	VALUE=''
	[ -f "$ENV_FILE" ] || return 1
	_env_line=$(grep -E "^[[:space:]]*${_env_name}=" "$ENV_FILE" 2>/dev/null | tail -n 1)
	[ -n "$_env_line" ] || return 1
	# 只去掉第一个 `=`；值里后续的 `=`（base64 填充）必须保留。
	_env_raw=${_env_line#*=}
	_env_cr=$(printf '\r')
	case $_env_raw in
	*"$_env_cr") _env_raw=${_env_raw%?} ;;
	esac
	[ -n "$_env_raw" ] || return 1
	VALUE=$_env_raw
	return 0
}

is_private_ip() {
	case $1 in
	127.*|10.*|192.168.*) return 0 ;;
	172.1[6-9].*|172.2[0-9].*|172.3[01].*) return 0 ;;
	::1|fc*|fd*|fe80:*) return 0 ;;
	*) return 1 ;;
	esac
}

# ---------------------------------------------------------------------------
# 静态制品检查
# ---------------------------------------------------------------------------

check_static_artifacts() {
	section "静态制品"
	_compose="$DEPLOY_DIR/compose.public.yaml"
	_caddyfile="$DEPLOY_DIR/Caddyfile"
	_example="$DEPLOY_DIR/.env.deploy.example"

	if [ -f "$_compose" ]; then
		pass "找到 deploy/compose.public.yaml"
		# 只检查非注释行：注释里允许出现这些端口号用于说明。
		_hits=$(grep -v '^[[:space:]]*#' "$_compose" | grep -E '(^|[^0-9])(1883|9000|9001|9002|9100|9101)([^0-9]|$)' | head -n 3)
		if [ -n "$_hits" ]; then
			fail "compose 的非注释行出现 1883/9000/9001/9002/9100/9101，禁止在公网主机发布这些端口"
		else
			pass "compose 未发布 1883/9000/9001/9002/9100/9101"
		fi
		if grep -qE '^[[:space:]]*privileged:[[:space:]]*true' "$_compose"; then
			fail "compose 使用了 privileged: true"
		else
			pass "compose 未使用 privileged"
		fi
		for _p in 80 443; do
			if grep -qF "\"$_p:$_p\"" "$_compose"; then
				pass "compose 发布了 $_p"
			else
				fail "compose 未发布 $_p（HTTPS 入口必需）"
			fi
		done
	else
		fail "缺少 deploy/compose.public.yaml"
	fi

	if [ -f "$_caddyfile" ]; then
		pass "找到 deploy/Caddyfile"
		if grep -qF 'reverse_proxy' "$_caddyfile"; then
			pass "Caddyfile 含 reverse_proxy"
		else
			fail "Caddyfile 缺少 reverse_proxy"
		fi
		if grep -qF '{$PUBLIC_DOMAIN}' "$_caddyfile"; then
			pass 'Caddyfile 以 {$PUBLIC_DOMAIN} 作为站点地址'
		else
			fail "Caddyfile 未使用 {\$PUBLIC_DOMAIN} 作为站点地址"
		fi
	else
		fail "缺少 deploy/Caddyfile"
	fi

	if [ -f "$_example" ]; then
		pass "找到 deploy/.env.deploy.example"
	else
		warn "缺少 deploy/.env.deploy.example（部署方将没有变量名清单）"
	fi
	return 0
}

# ---------------------------------------------------------------------------
# 变量文件与变量语义
# ---------------------------------------------------------------------------

check_env_file() {
	section "变量文件"
	if [ ! -f "$ENV_FILE" ]; then
		fail "deploy/.env.deploy 不存在，请先 cp deploy/.env.deploy.example deploy/.env.deploy"
		note "期望路径：$ENV_FILE"
		return 1
	fi
	pass "找到变量文件：$ENV_FILE"

	_env_perms=$(stat -c '%a' "$ENV_FILE" 2>/dev/null) || _env_perms=''
	if [ -z "$_env_perms" ]; then
		_env_perms=$(stat -f '%Lp' "$ENV_FILE" 2>/dev/null) || _env_perms=''
	fi
	if [ -z "$_env_perms" ]; then
		warn "无法读取文件权限（stat 不可用），请人工确认该文件为 0600"
	else
		case $_env_perms in
		*00) pass "文件权限为 $_env_perms（组与其他用户无任何权限）" ;;
		*) fail "文件权限为 $_env_perms，应为 0600：chmod 600 deploy/.env.deploy" ;;
		esac
	fi
	return 0
}

check_required_vars() {
	section "必需变量（只输出变量名）"
	_missing=''
	_placeholder=''
	_dollar=''

	for _name in $REQUIRED_VARS; do
		if ! env_value "$_name"; then
			_missing="$_missing $_name"
			continue
		fi
		case $VALUE in
		*REPLACE_*|*replace-with*|*CHANGE_ME*|*change-me*) _placeholder="$_placeholder $_name" ;;
		esac
		# 含 `$` 时 Compose 会把它当变量引用，真实值会被静默改写。
		case $VALUE in
		*'$'*) _dollar="$_dollar $_name" ;;
		esac
	done

	if [ -n "$_missing" ]; then
		fail "缺少必需变量：$_missing"
	else
		pass "7 个必需变量均已存在且非空"
	fi
	if [ -n "$_placeholder" ]; then
		fail "以下变量仍是样例占位符，必须替换为真实值：$_placeholder"
	fi
	if [ -n "$_dollar" ]; then
		fail "以下变量的值含 \$，Compose 会当成变量引用：$_dollar（改用不含 \$ 的随机字母表，或写成 \$\$）"
	fi

	# 语义检查：只报告变量名，不报告值。
	if env_value PUBLIC_DOMAIN; then
		case $VALUE in
		*'://'*) fail "PUBLIC_DOMAIN 不能带协议前缀（只写裸主机名）" ;;
		*/*) fail "PUBLIC_DOMAIN 不能带路径或尾部斜杠" ;;
		esac
		case $VALUE in
		*.*) : ;;
		*) fail "PUBLIC_DOMAIN 看起来不是完整主机名" ;;
		esac
		case $VALUE in
		*example.com*|*example.invalid*|*example.org*) fail "PUBLIC_DOMAIN 仍是样例域名，必须替换为已备案的真实域名" ;;
		esac
	fi

	if env_value API_TOKEN_SECRET; then
		if [ "${#VALUE}" -lt 32 ]; then
			fail "API_TOKEN_SECRET 长度不足 32，后端会拒绝启动"
		else
			pass "API_TOKEN_SECRET 长度满足后端要求（>= 32）"
		fi
	fi
	if env_value INGEST_KEY; then
		if [ "${#VALUE}" -lt 32 ]; then
			fail "INGEST_KEY 长度不足 32，后端会拒绝启动"
		else
			pass "INGEST_KEY 长度满足后端要求（>= 32）"
		fi
	fi
	if env_value APP_GUARDIAN_PASSWORD; then
		if [ "${#VALUE}" -lt 32 ] || [ "${#VALUE}" -gt 256 ]; then
			fail "APP_GUARDIAN_PASSWORD 必须为 32-256 字符"
		else
			pass "APP_GUARDIAN_PASSWORD 长度满足后端要求"
		fi
	fi

	_api_secret=''
	_ingest=''
	if env_value API_TOKEN_SECRET; then _api_secret=$VALUE; fi
	if env_value INGEST_KEY; then _ingest=$VALUE; fi
	if [ -n "$_api_secret" ] && [ -n "$_ingest" ]; then
		if [ "$_api_secret" = "$_ingest" ]; then
			fail "INGEST_KEY 与 API_TOKEN_SECRET 相同，必须使用两个不同的密钥"
		else
			pass "INGEST_KEY 与 API_TOKEN_SECRET 不同"
		fi
	fi
	_api_secret=''
	_ingest=''

	_wechat_count=0
	for _name in WECHAT_APP_ID WECHAT_APP_SECRET WECHAT_ALLOWED_OPENIDS; do
		if env_value "$_name"; then _wechat_count=$((_wechat_count + 1)); fi
	done
	case $_wechat_count in
	0) pass "微信登录配置为空（APP-only 模式）" ;;
	3)
		pass "三项微信登录配置完整（可选兼容模式）"
		if env_value WECHAT_ALLOWED_OPENIDS; then
			case $VALUE in
			'['*) : ;;
			*) note "WECHAT_ALLOWED_OPENIDS 不是 JSON 数组，后端将按逗号分隔列表解析" ;;
			esac
		fi
		;;
	*) fail "WECHAT_APP_ID、WECHAT_APP_SECRET、WECHAT_ALLOWED_OPENIDS 必须同时为空或同时填写" ;;
	esac
	if env_value WECHAT_SUBSCRIBE_TEMPLATE_ID && [ "$_wechat_count" -ne 3 ]; then
		fail "WECHAT_SUBSCRIBE_TEMPLATE_ID 已填写，但三项微信登录配置不完整"
	fi
	if env_value CONTACTS_JSON; then
		case $VALUE in
		'['*) : ;;
		*) fail "CONTACTS_JSON 必须是 JSON 数组（以 [ 开头）" ;;
		esac
	fi
	return 0
}

# ---------------------------------------------------------------------------
# 网络断言
# ---------------------------------------------------------------------------

resolve_domain() {
	RESOLVED_IPS=''
	if command -v getent >/dev/null 2>&1; then
		RESOLVED_IPS=$(getent hosts "$1" 2>/dev/null | awk '{print $1}' | tr '\n' ' ')
	fi
	if [ -z "$RESOLVED_IPS" ] && command -v dig >/dev/null 2>&1; then
		RESOLVED_IPS=$(dig +short A "$1" 2>/dev/null | tr '\n' ' ')
	fi
	if [ -z "$RESOLVED_IPS" ] && command -v nslookup >/dev/null 2>&1; then
		RESOLVED_IPS=$(nslookup "$1" 2>/dev/null | awk '/^Address: /{print $2}' | tr '\n' ' ')
	fi
	case $RESOLVED_IPS in
	'') return 1 ;;
	*[0-9]*) return 0 ;;
	*) return 1 ;;
	esac
}

# 返回 0 = 端口不可达（符合公网期望）；1 = 端口可达（暴露）；2 = 无法判定。
#
# 只用 curl 探测（curl 是本脚本的硬依赖），不用 `nc -z`：
# busybox 的 nc 不支持 -z，会以用法错误返回非零，从而把"开放"误判成"关闭"。
# 用 %{time_connect} 区分「TCP 已连上」与「连接被拒 / 被丢包」：
#   time_connect > 0            -> TCP 握手成功，端口可达
#   curl 退出码 7（拒绝）/28（超时）且 time_connect=0 -> 端口不可达
# 其它情况一律报"无法判定"，绝不猜成安全。
tcp_probe() {
	_tp_meta=$(curl -sS -o /dev/null --connect-timeout 4 --max-time 6 \
		-w '%{time_connect}' "http://$1:$2/" 2>/dev/null)
	_tp_rc=$?
	case $_tp_meta in
	''|0.000000) : ;;
	*) return 1 ;;
	esac
	case $_tp_rc in
	7|28) return 0 ;;
	*) return 2 ;;
	esac
}

check_dns() {
	section "DNS"
	if resolve_domain "$_DOMAIN"; then
		pass "域名可解析：$_DOMAIN -> $RESOLVED_IPS"
		_private=''
		for _ip in $RESOLVED_IPS; do
			if is_private_ip "$_ip"; then _private="$_private $_ip"; fi
		done
		if [ -n "$_private" ]; then
			warn "解析结果是内网/回环地址：$_private"
			note "此时端口断言只反映本机视角，请在外部网络再运行一次本脚本"
		fi
	else
		fail "域名无法解析：$_DOMAIN（请先完成 DNS 记录与备案）"
	fi
	return 0
}

check_tls() {
	section "入站 TLS"
	if ! command -v openssl >/dev/null 2>&1; then
		fail "缺少 openssl，无法验证入站 TLS"
		return 0
	fi
	if [ -z "$TMP_FILE" ]; then
		fail "无法创建临时文件，跳过 TLS 校验"
		return 0
	fi
	# 用 timeout 兜住被丢包的 443，避免预检脚本本身挂死（timeout 不可用时退回直连）。
	if command -v timeout >/dev/null 2>&1; then
		timeout 15 openssl s_client -connect "$_DOMAIN:443" -servername "$_DOMAIN" </dev/null >"$TMP_FILE" 2>&1
	else
		openssl s_client -connect "$_DOMAIN:443" -servername "$_DOMAIN" </dev/null >"$TMP_FILE" 2>&1
	fi
	if grep -qF 'Verify return code: 0 (ok)' "$TMP_FILE"; then
		pass "TLS 握手成功且证书链校验通过（$_DOMAIN:443）"
	else
		fail "TLS 校验未通过；openssl 的验证结论如下："
		grep -m 1 'Verify return code' "$TMP_FILE" | sed 's/^[[:space:]]*/      /'
		if ! grep -q 'Verify return code' "$TMP_FILE"; then
			note "openssl 未输出验证结论行（连接可能被超时或过滤）"
		fi
	fi

	_expiry=$(grep -m 1 '^notAfter=' "$TMP_FILE" | sed 's/^notAfter=//')
	if [ -z "$_expiry" ]; then
		warn "未能从握手结果读取证书到期时间"
		return 0
	fi
	_expiry_epoch=$(date -u -d "$_expiry" +%s 2>/dev/null) || _expiry_epoch=''
	if [ -z "$_expiry_epoch" ]; then
		_expiry_epoch=$(date -u -j -f '%b %d %T %Y %Z' "$_expiry" +%s 2>/dev/null) || _expiry_epoch=''
	fi
	if [ -z "$_expiry_epoch" ]; then
		warn "无法计算剩余天数；证书 notAfter=$_expiry（请人工确认自动续期）"
		return 0
	fi
	_days=$(((_expiry_epoch - $(date -u +%s)) / 86400))
	if [ "$_days" -lt 0 ]; then
		fail "证书已过期（$_expiry）"
	elif [ "$_days" -lt 14 ]; then
		fail "证书剩余有效期仅 $_days 天（< 14），请先确认 ACME 自动续期正常"
	else
		pass "证书剩余有效期 $_days 天（$_expiry）"
	fi
	return 0
}

# 设置 $HTTP_STATUS（只要状态码，不留响应体）
http_get_status() {
	HTTP_STATUS=$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 5 --max-time 15 "$1" 2>/dev/null)
	[ -n "$HTTP_STATUS" ] || HTTP_STATUS='000'
}

check_api() {
	section "HTTP 端点"
	http_get_status "https://$_DOMAIN/healthz"
	if [ "$HTTP_STATUS" = '200' ]; then
		pass "/healthz 返回 200（存活探针）"
	else
		fail "/healthz 返回 $HTTP_STATUS（期望 200）"
	fi

	# 就绪探针由 Codex 在 cloud/backend/src/server.js 实现；
	# 在它落地前必须显式失败，不得用 /healthz 冒充就绪。
	http_get_status "https://$_DOMAIN/readyz"
	case $HTTP_STATUS in
	200) pass "/readyz 返回 200（就绪探针可用）" ;;
	404|405)
		fail "PREREQUISITE MISSING：/readyz 尚未实现（返回 $HTTP_STATUS）"
		note "该端点属 Codex 所有的 cloud/backend/src/server.js；落地前不得用 /healthz 冒充就绪"
		;;
	*) fail "/readyz 返回 $HTTP_STATUS（期望 200）" ;;
	esac

	# 公网暴露面：未认证访问必须被拒绝。
	http_get_status "https://$_DOMAIN/api/v1/overview"
	if [ "$HTTP_STATUS" = '401' ]; then
		pass "未认证的 /api/v1/overview 返回 401（家庭 API 有鉴权边界）"
	else
		fail "未认证的 /api/v1/overview 返回 $HTTP_STATUS（期望 401，否则数据可能对外泄露）"
	fi

	http_get_status "https://$_DOMAIN/internal/v1/commands?after=0"
	if [ "$HTTP_STATUS" = '401' ]; then
		pass "缺少 x-ingest-key 的 /internal/v1/commands 返回 401（内部通道有鉴权边界）"
	else
		fail "缺少 x-ingest-key 的 /internal/v1/commands 返回 $HTTP_STATUS（期望 401）"
	fi

	HTTP_STATUS=$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 5 --max-time 15 \
		-X POST -H 'content-type: application/json' \
		--data '{"guardianId":"preflight-invalid","password":"preflight-invalid"}' \
		"https://$_DOMAIN/api/v1/auth/app" 2>/dev/null)
	[ -n "$HTTP_STATUS" ] || HTTP_STATUS='000'
	if [ "$HTTP_STATUS" = '401' ]; then
		pass "/api/v1/auth/app 对错误口令返回 401（APP 登录已启用且安全失败）"
	else
		fail "/api/v1/auth/app 对错误口令返回 $HTTP_STATUS（期望 401）"
	fi

	if [ "${CHECK_WECHAT_LOGIN:-0}" = '1' ]; then
		# 必须用 POST：GET 会落到 bearer 分支并返回 401，证明不了任何微信相关行为。
		HTTP_STATUS=$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 5 --max-time 20 \
			-X POST -H 'content-type: application/json' \
			--data '{"code":"preflight-invalid-code-000"}' \
			"https://$_DOMAIN/api/v1/auth/wechat" 2>/dev/null)
		[ -n "$HTTP_STATUS" ] || HTTP_STATUS='000'
		note "CHECK_WECHAT_LOGIN=1 只能确认登录端点可达且安全失败；"
		note "无法证明 WECHAT_APP_SECRET 正确（错误密钥与错误 code 都会得到 400）。"
		case $HTTP_STATUS in
		4*) pass "/api/v1/auth/wechat 对无效 code 返回 $HTTP_STATUS（端点可达且安全失败）" ;;
		5*) fail "/api/v1/auth/wechat 返回 $HTTP_STATUS（服务端配置或上游依赖异常）" ;;
		*) fail "/api/v1/auth/wechat 返回 $HTTP_STATUS（期望 4xx）" ;;
		esac
	else
		skip "微信登录端点未验证（需要时用 CHECK_WECHAT_LOGIN=1 开启）"
	fi
	return 0
}

check_ports() {
	section "公网端口"
	for _port in $FORBIDDEN_PORTS; do
		tcp_probe "$_DOMAIN" "$_port"
		_rc=$?
		case $_rc in
		0) pass "$_port 未对外可达" ;;
		1) fail "$_port 对外可达——必须关闭公网访问（家庭链路或后端直连端口）" ;;
		*) fail "$_port 无法判定（探测失败），不能据此认为安全" ;;
		esac
	done

	tcp_probe "$_DOMAIN" 443
	_rc=$?
	case $_rc in
	1) pass "443 对外可达（HTTPS 入口必需）" ;;
	0) fail "443 不可达，自动 HTTPS 与小程序请求都会失败" ;;
	*) fail "443 无法判定（探测失败），无法确认 HTTPS 入口可用" ;;
	esac

	tcp_probe "$_DOMAIN" 80
	_rc=$?
	case $_rc in
	1) pass "80 对外可达（ACME HTTP-01 与跳转必需）" ;;
	0) warn "80 不可达；若 443 可用，Caddy 仍可回退 TLS-ALPN-01，请确认证书能正常签发" ;;
	*) warn "80 无法判定（探测失败）" ;;
	esac
	return 0
}

# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------

printf '公网后端预检（第一阶段 P0）\n'
printf '本脚本只输出变量名，不输出变量值。\n'

if ! command -v curl >/dev/null 2>&1; then
	printf 'REFUSE: 缺少 curl，无法完成公网断言。\n' >&2
	exit 2
fi

TMP_FILE=$(mktemp 2>/dev/null) || TMP_FILE=''
if [ -n "$TMP_FILE" ] && [ ! -f "$TMP_FILE" ]; then
	TMP_FILE=''
fi
if [ -z "$TMP_FILE" ]; then
	TMP_FILE=${TMPDIR:-/tmp}/eldercare-preflight.$$
	: >"$TMP_FILE" 2>/dev/null || TMP_FILE=''
fi

_DOMAIN=''

check_static_artifacts

if check_env_file; then
	check_required_vars
	if env_value PUBLIC_DOMAIN; then
		_DOMAIN=$VALUE
	fi
	VALUE=''
fi

if [ -z "$_DOMAIN" ]; then
	section "结果汇总"
	fail "无法从变量文件取得 PUBLIC_DOMAIN，网络断言全部跳过"
	printf '\nFAIL=%s WARN=%s\n' "$FAILURES" "$WARNINGS"
	printf 'RESULT: NOT READY\n'
	exit 1
fi

check_dns
check_tls
check_api
check_ports

section "结果汇总"
printf 'FAIL=%s WARN=%s\n' "$FAILURES" "$WARNINGS"
if [ "$FAILURES" -gt 0 ]; then
	printf 'RESULT: NOT READY（存在 %s 项失败）\n' "$FAILURES"
	exit 1
fi
printf 'RESULT: 公网前置断言通过（%s 项警告）\n' "$WARNINGS"
printf '边界：以上仅覆盖静态制品 / DNS / TLS / 端点鉴权 / 端口暴露。\n'
printf '它不代表微信登录、小程序真机或实体设备 ACK 闭环已验收。\n'
exit 0
