# 公网部署手册（第一阶段）

本文件描述"本地测试通过"到"公网 HTTPS 后端 + 家庭网关常驻"的最小上线路径，是
`docs/agent-reports/deepseek-public-cloud-audit.md` 第 9.2 / 9.3 节的落地说明。

**边界声明（先读这一段）**

- 本文件是**部署说明与检查清单**，不是验收结论。任何"公网已上线""TLS 已通过"
  "APP 已联调""真机已闭环"的结论，都必须由 Codex 独立验证后写入
  `docs/VALIDATION-MATRIX.md`。
- **本机 Docker 构建与容器验收已完成（LOCAL READY）**：Windows 开发机上用
  Docker Desktop 4.95.0 + WSL2 后端（Linux containers）构建镜像并跑通容器，
  `/healthz`、`/readyz`、匿名 401 边界、Bearer 会话、APP v1 只读合同、
  命名卷持久化与容器重启恢复均已实测通过；`deploy/verify/verify-app-api.mjs`
  输出 `RESULT PASS`。细节与命令见第 12 节。
- **公网后端已部署（PUBLIC BACKEND READY）**：`https://api.luxunacc.xyz` 已完成
  DNS、Let's Encrypt 公共证书、Caddy 80/443、容器健康、真实监护人登录和 API 合同验收。
  家庭网关公网同步、队友 APP 手机真机及公网实体 ACK 闭环仍为 `NOT TESTED`。
- 本机 Docker 历史验收使用 `PUBLIC_DOMAIN=localhost` 和 Caddy 内部 CA；它是部署前证据，
  不应再被误读为当前公网状态。公网证据见 `docs/evidence/2026-10-15-public-cloud-acceptance.md`。
- 本文件只写变量名，不含任何真实密钥、Token、AppSecret、openid、手机号、
  IMEI、ICCID、SIM 号码或坐标。

---

## 1. 拓扑

### 1.1 方案 A（推荐）：公网主机 + 家庭本地主机分离

```text
公网主机（Linux，1 vCPU / 1 GB 起）
  ├── caddy     :80 :443      入站 HTTPS、自动 ACME 申请与续期
  └── backend   :8080（仅容器网络，不发布主机端口）
        └── 命名卷 backend-data → 持久化快照 /data/backend-state.json
        └── 命名卷 caddy-data / caddy-config → 证书与 ACME 账户

家庭本地主机（Windows / Node，与 DAYU、ESP32 同一局域网）
  ├── bridge/mqtt_broker.js     本地 MQTT Broker（仅回环/局域网）
  ├── bridge/mqtt_bridge.js     接 DAYU（hdc fport）与 ESP32（WiFi TCP）
  └── cloud/onenet/gateway.js   常驻家庭云网关

设备侧
  监护人 APP ──HTTPS──> 公网主机
  DAYU / ESP32 ──局域网──> 家庭本地主机
```

关键点：

1. **公网主机只运行后端与 Caddy 两个服务。** 不在这台机器上跑 Broker、Bridge、
   家庭网关，也不跑 DAYU/ESP32 相关的任何监听进程。
2. **家庭网关是纯出站客户端。** 它主动访问 `https://<域名的>443`（推送设备状态、
   轮询 ACK 命令队列），并出站访问 OneNET 的 8883。它**从不接受**公网主机的入站连接
   （后端没有回连逻辑），所以家庭侧不需要公网 IP、不需要端口映射、不需要 DDNS，
   位于 NAT 之后即可工作。
3. **OneNET 不在手机 ACK 的主链路上。** 手机看到的数据来自
   `cloud/onenet/cloud-sync.js` 直接 `POST /internal/v1/device-status`；
   ACK 命令来自 `cloud/onenet/command-sync.js` 轮询
   `GET /internal/v1/commands?after=` 后向本地 `home/<deviceId>/cmd` 发布。
   两条路径都只经过"网关 ↔ 公网后端"，与 OneNET 无关。
   因此：**真实 OneNET 凭据常驻运行可以独立排期**，不阻塞第一次公网演示；
   YED 直连 OneNET 当前为 `BLOCKED` 状态，同样不影响本手册的链路。

### 1.2 方案 B（降级）：单机演示

只有在一台机器同时承担"接设备"和"对外服务"时才使用。额外必须做到：

- Broker 与 Bridge 只绑定回环或局域网地址；
- 防火墙只放行 80/443（加运维 SSH），**绝不**放行 1883/9000/9001/9002/9100/9101；
- 容器不发布除 80/443 以外的任何端口；
- `hdc fport` 的存活纳入启动脚本（该转发规则会随连接消失）。

方案 B 的失败面明显更大（不安全面与脆弱链路被搬到同一台机器），**不建议作为正式演示方案**。

---

## 2. 端口与防火墙

| 端口 | 所在主机 | 用途 | 公网放行 |
|---|---|---|---|
| 443/tcp | 公网主机 | Caddy 入站 HTTPS | **必须** |
| 443/udp | 公网主机 | HTTP/3（Caddy 默认启用） | 可选 |
| 80/tcp | 公网主机 | ACME HTTP-01 挑战与 HTTP→HTTPS 跳转 | 建议（若被封，Caddy 可回退 TLS-ALPN-01） |
| 22/tcp | 公网主机 | 运维 SSH | 仅限来源 IP |
| 8080/tcp | 公网主机 | backend 容器端口 | **禁止**（只在容器网络内） |
| 1883/tcp | 家庭主机 | 本地 MQTT Broker | **禁止** |
| 9000/tcp | 家庭主机 | DAYU homemon TCP / hdc fport | **禁止** |
| 9001 / 9002 | 家庭主机 | 独立 hdc fport / APP 候选本地端口 | **禁止** |
| 9100 / 9101 | 家庭主机 | Bridge 无线节点监听 | **禁止**（仅局域网） |
| 8883/tcp（出站） | 家庭主机 | 到 OneNET 的 MQTTS | 出站放行 |

为什么这些端口必须禁止：`bridge/mqtt_broker.js` 与 `bridge/mqtt_bridge.js`
**没有身份鉴别、没有 TLS，并且监听 `0.0.0.0`**；局域链路当前使用 MQTT QoS 0。
把它放到公网等于把家庭设备的总线直接交出去。

`deploy/verify/preflight-public.sh` 会对 1883/9000/9001/9002/9100/9101/8080 做"必须不可达"断言，
并确认 443 可达。

### 2.1 云安全组（云厂商控制台侧）

入方向（Ingress）只放行下面这几条，其余一律拒绝：

| 方向 | 端口 | 来源 | 说明 |
|---|---|---|---|
| 入 | 443/tcp | `0.0.0.0/0`、`::/0` | 监护人 APP 与家庭网关的 HTTPS 入口 |
| 入 | 80/tcp | `0.0.0.0/0`、`::/0` | ACME HTTP-01 挑战与 HTTP→HTTPS 跳转 |
| 入 | 22/tcp | **仅运维出口 IP**（不要 `0.0.0.0/0`） | SSH 运维 |
| 入 | 443/udp | `0.0.0.0/0`、`::/0`（可选） | HTTP/3；不放行只影响 h3，不影响 HTTPS |
| 入 | 8080 / 1883 / 9000 / 9001 / 9002 / 9100 / 9101 | **不添加任何规则** | 见第 2 节禁止清单 |

出方向（Egress）保持默认放行：Caddy 需要访问 ACME CA，主机需要访问镜像仓库。
家庭网关出站 443 / 8883 属于家庭主机的事，与公网主机无关。

### 2.2 系统防火墙（主机侧，与安全组**同时**生效）

云安全组与主机防火墙是两层，**两层都要收**。Ubuntu/Debian 的 ufw：

```sh
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 443/udp          # 可选，HTTP/3
sudo ufw allow from <运维出口IP> to any port 22 proto tcp
sudo ufw enable
sudo ufw status verbose
```

RHEL 系（firewalld）：

```sh
sudo firewall-cmd --permanent --add-service=http
sudo firewall-cmd --permanent --add-service=https
sudo firewall-cmd --permanent --add-rich-rule='rule family=ipv4 source address=<运维出口IP> service name=ssh accept'
sudo firewall-cmd --reload
sudo firewall-cmd --list-all
```

**不要**为 8080 添加任何规则：`compose.public.yaml` 里 backend 只写 `expose: "8080"`，
不发布主机端口，公网无法直连，主机防火墙也不需要为它开口。

---

## 3. 变量与 Secret

### 3.1 变量清单（只写变量名）

| 变量名 | 归属主机 | 敏感 | 说明 |
|---|---|---|---|
| `PUBLIC_DOMAIN` | 公网主机 | 否 | APP 使用的 HTTPS API 裸主机名 |
| `ACME_EMAIL` | 公网主机 | 否 | ACME 账户邮箱，用于证书到期通知 |
| `API_TOKEN_SECRET` | 公网主机 | **是** | 会话 HMAC 密钥，长度 ≥ 32 |
| `INGEST_KEY` | 公网主机 | **是** | 内部摄取通道密钥，必须与 `API_TOKEN_SECRET` 不同 |
| `APP_GUARDIAN_ID` | 公网主机 | 否 | 单户监护人登录账号，3-64 位安全字符 |
| `APP_GUARDIAN_PASSWORD` | 公网主机 | **是** | 8-256 字符，只由用户输入，禁止硬编码进 APP |
| `CONTACTS_JSON` | 公网主机 | **是（个人数据）** | 联系人姓名与电话，仅首次建库时写入快照 |
| `WECHAT_APP_ID` / `WECHAT_APP_SECRET` / `WECHAT_ALLOWED_OPENIDS` | 公网主机 | 可选/敏感 | 仅在以后恢复微信小程序通道时三项同时填写 |
| `WECHAT_SUBSCRIBE_TEMPLATE_ID` / `WECHAT_SUBSCRIBE_PAGE` | 公网主机 | 可选 | 微信订阅消息配置；APP-only 模式留空 |
| `ONENET_PRODUCT_ID` / `ONENET_DEVICE_NAME` | 家庭主机 | 否 | OneNET 非敏感元数据 |
| `ONENET_DEVICE_KEY` | 家庭主机 | **是** | 只允许系统 Secret 或隐藏输入注入 |
| `BACKEND_URL` | 家庭主机 | 否 | 必须是 `https://<域名>`，不得带 query/fragment |
| `BACKEND_INGEST_KEY` | 家庭主机 | **是** | 必须与公网主机的 `INGEST_KEY` **完全相同** |
| `BACKEND_TIMEOUT_MS` | 家庭主机 | 否 | 后端请求超时 |
| `GATEWAY_BROKER_URL` / `GATEWAY_STATUS_TOPIC` / `GATEWAY_RESET_MODE` / `GATEWAY_DEBUG` | 家庭主机 | 否 | 网关本地行为配置 |

### 3.2 注入方式

```sh
cp deploy/.env.deploy.example deploy/.env.deploy
chmod 600 deploy/.env.deploy
$EDITOR deploy/.env.deploy
docker compose --env-file deploy/.env.deploy -f deploy/compose.public.yaml up -d
```

`--env-file` 是**必须的**：`compose.public.yaml` 用 `${VAR:?...}` 显式声明每个服务需要的
变量，缺任何一个都会以**变量名**报错并拒绝启动。这同时带来两个好处：
后端密钥只注入 backend 容器，Caddy 容器里只有 `PUBLIC_DOMAIN` 与 `ACME_EMAIL`。

### 3.3 生成与轮换的注意事项

- 随机密钥请用不含 `$` 的字母表（`openssl rand -base64 48` 或 `openssl rand -hex 32`）。
  **值里不要出现 `$`**：Compose 会把它当变量引用并把 `$xxx` 吃成空串；确需字面量时写 `$$`。
  值里也不要出现 `#`（会被当行内注释）或空格；不要给值加引号。
- 建议轮换周期：`API_TOKEN_SECRET` 与 `INGEST_KEY` 至少每次演示前重置一次，
  或在任何一次日志/工单可能泄露后立即重置。轮换 `INGEST_KEY` 时必须**同时**更新
  公网主机与家庭主机的值，否则网关的状态同步与命令同步会静默失效。
- `APP_GUARDIAN_PASSWORD` 轮换后，旧口令不能再登录；轮换 `API_TOKEN_SECRET` 会立即使所有旧会话失效。
- 微信三项变量必须同时为空或同时填写；APP-only 模式留空不会阻塞后端启动。

### 3.4 绝不能出现的位置

| 位置 | 禁止内容 |
|---|---|
| 镜像 | 上述全部敏感值，以及 TLS 站点私钥（`Dockerfile` 只写 `NODE_ENV`/`HOST`/`PORT`/`BACKEND_DATA_FILE`，`.dockerignore` 已排除 `.env*`） |
| APP / 安装包 | `API_TOKEN_SECRET`、`INGEST_KEY`、`BACKEND_INGEST_KEY`、`APP_GUARDIAN_PASSWORD`、`WECHAT_APP_SECRET`、`WECHAT_ALLOWED_OPENIDS`、`ONENET_DEVICE_KEY`、`CONTACTS_JSON`、任何 OneNET access_key |
| 日志 / 聊天 / 报告 / 工单 | 上述全部值 |
| 命令行参数 | 不要把密钥写成 `-e KEY=值`；用 `--env-file` 或 `-e KEY`（只给名字） |
| `docker compose config` 输出 | 它会打印**解析后**的真实值，不要重定向到日志或 CI |

---

## 4. 上线步骤

1. **准备公网主机**：推荐 **Ubuntu Server 24.04 LTS（x86_64）** 或 **Debian 12**；
   最低 1 vCPU / 1 GB 内存 / 20 GB 磁盘（2 vCPU / 2 GB 更稳）。只放行 80/443
   （+ 仅限来源 IP 的运维 SSH），云安全组与主机防火墙**都要收**（见第 2.1 / 2.2 节）。
   本机验收使用的后端镜像为 `linux/amd64`。

   安装 Docker Engine 与 Compose Plugin（**官方源，不要装 Docker Desktop**）：

   ```sh
   # Ubuntu；Debian 把两处 linux/ubuntu 换成 linux/debian
   sudo apt-get update
   sudo apt-get install -y ca-certificates curl gnupg
   sudo install -m 0755 -d /etc/apt/keyrings
   curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
     | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
   sudo chmod a+r /etc/apt/keyrings/docker.gpg
   echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
     https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
     | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
   sudo apt-get update
   sudo apt-get install -y docker-ce docker-ce-cli containerd.io \
     docker-buildx-plugin docker-compose-plugin
   sudo systemctl enable --now docker
   docker version && docker compose version
   ```

   非 root 用户按需加入 docker 组：`sudo usermod -aG docker $USER`（重新登录生效）。
   若主机在中国大陆且无法访问 Docker Hub，按你的合规要求配置镜像加速或私有仓库，
   **不要**把加速器地址或凭据写进本仓库。

   建议的目录布局（`compose.public.yaml` 的构建上下文是 `../cloud/backend`）：

   ```text
   /opt/eldercare/
     ├── compose.public.yaml     # 来自本仓库 deploy/
     ├── Caddyfile               # 来自本仓库 deploy/
     ├── verify/                 # 来自本仓库 deploy/verify/
     ├── cloud/backend/          # 与 compose 的相对路径保持一致
     └── .env.deploy             # 0600，只在本机编辑
   ```

   持久化数据与证书**不在**这个目录，而在命名卷 `backend-data` / `caddy-data` /
   `caddy-config` 里（见第 6 节）。

2. **准备域名**：在 DNS 服务商添加 **A 记录**（IPv4）指向公网 IP；若主机有 IPv6，
   再添加 **AAAA 记录**。解析必须已经生效（`dig +short A <域名>` 能返回公网 IP）
   再启动 Caddy，否则 ACME 申请会失败。如服务器在中国大陆，按实际监管要求完成备案。
   `PUBLIC_DOMAIN` 只写裸主机名，不带 `https://`、端口、路径或尾部斜杠。
3. **写入变量**：按第 3.2 节创建 `deploy/.env.deploy`（0600），替换全部 `REPLACE_` 占位符。
4. **启动服务**：
   ```sh
   docker compose --env-file deploy/.env.deploy -f deploy/compose.public.yaml up -d
   ```
   首次启动时 Caddy 会自动申请证书；证书与 ACME 账户落在 `caddy-data` / `caddy-config`
   命名卷里。**不要**随手 `down -v`，那会清空证书并重新申请，可能触发 CA 限流。
5. **跑预检**：
   ```sh
   chmod +x deploy/verify/preflight-public.sh
   deploy/verify/preflight-public.sh
   ```
   退出码 0 才继续；否则按输出逐项修复（脚本只报告变量名，不报告值）。
   后端启动后再用纯 Node.js 工具验证 APP 合同（不要把环境变量值贴进终端历史或聊天）：
   ```sh
   API_BASE_URL=https://api.example.com \
   APP_GUARDIAN_ID=... APP_GUARDIAN_PASSWORD=... \
   node deploy/verify/verify-app-api.mjs
   ```
   工具不会输出账号、口令、会话 Token、联系人或坐标；`RESULT PASS` 才表示公开入口的基础合同通过。
   本机验收时该工具在 HTTPS 下 13 项全部 PASS（见第 12 节）；公网入口上仍需重跑一次。
6. **验证 APP 登录**：用错误口令访问 `/api/v1/auth/app` 应返回 401；再由监护人本人在 APP 输入正确口令，取得两小时 Bearer 会话。口令不得进入日志或截图。
7. **启动家庭侧**：在本地主机启动 Broker、Bridge、常驻网关，设置
   `BACKEND_URL=https://<域名>` 与 `BACKEND_INGEST_KEY`（与 `INGEST_KEY` 相同）。
   确认网关日志出现 `START`、`LOCAL_SUBSCRIBED`，且没有 `CLOUD_TRANSPORT_ERROR`。
8. **监护人 APP**：按 `docs/APP-API-v1.md` 接入，把 API 根地址设置为 HTTPS 根地址
   （不带 `/api`、query 或凭据）。登录口令**只能由监护人本人输入**，并且只能保存在
   平台安全存储里：Android 用 **Android Keystore**（配合 EncryptedSharedPreferences /
   加密 DataStore），HarmonyOS 用 **HUKS**（配合加密首选项）。
   **禁止**把口令硬编码进 APK/HAP、写进 `resources`、写进构建配置、日志或截图。
9. **取证**：分别保存 公网层（预检输出、证书颁发记录）、后端层（容器日志）、
   家庭层（网关日志）、设备层（板端/节点日志）的证据。**分层保存，不得互相替代。**
10. **健康检查命令**（上线后每次变更都跑一遍）：
    ```sh
    docker compose --env-file deploy/.env.deploy -f deploy/compose.public.yaml ps
    curl -sS -o /dev/null -w 'healthz %{http_code}\n' https://<域名>/healthz   # 期望 200
    curl -sS -o /dev/null -w 'readyz  %{http_code}\n' https://<域名>/readyz    # 期望 200
    curl -sS -o /dev/null -w 'overview %{http_code}\n' https://<域名>/api/v1/overview  # 期望 401
    ```
    `backend` 的 healthcheck 走容器内 `/readyz`；`caddy` 在 compose 里**没有**定义
    healthcheck（Caddy 关闭了 admin API，没有内建探针），它的可用性要用上面这几条
    外部 HTTPS 请求来判断，不要只看 `docker ps` 的 `running`。
11. **Caddy 自动 TLS 的前置条件**（缺一项就会签发失败，且会消耗 CA 重试配额）：
    - `<域名>` 的 **A 记录（必要时 AAAA）已经解析到本机公网 IP**，并且生效；
    - 公网 **80 与 443 都可达**（HTTP-01 用 80，TLS-ALPN-01 用 443）；
    - `ACME_EMAIL` 是真实可收信邮箱；
    - 主机能出站访问 ACME CA（Let's Encrypt），中间不要有做 TLS 卸载的 CDN/反代；
    - 主机系统时间正确（`timedatectl status`；偏差过大会直接导致 ACME 失败）；
    - 证书与 ACME 账户在 `caddy-data` / `caddy-config` 命名卷里，**不要 `down -v`**。
12. **日志查看、更新与回滚**：
    ```sh
    # 日志（走 stdout，由 compose 的 json-file 配额轮转）
    docker compose --env-file deploy/.env.deploy -f deploy/compose.public.yaml logs --tail=100 backend
    docker compose --env-file deploy/.env.deploy -f deploy/compose.public.yaml logs -f caddy

    # 更新：改完代码后重建并滚动替换，不删卷
    docker compose --env-file deploy/.env.deploy -f deploy/compose.public.yaml build --no-cache
    docker compose --env-file deploy/.env.deploy -f deploy/compose.public.yaml up -d
    docker compose --env-file deploy/.env.deploy -f deploy/compose.public.yaml ps
    ```
    回滚见第 7 节；**任何情况下都不要用 `docker compose down -v`**。
13. **备份与恢复**（快照含联系人电话与设备坐标，属敏感数据：落地即限权、加密留存；
    当前仓库**没有**自动化备份脚本，下面是最小手工流程）：
    ```sh
    mkdir -p backup && chmod 700 backup

    # 备份后端快照（流式导出，不需要额外镜像、不需要 root）
    docker compose --env-file deploy/.env.deploy -f deploy/compose.public.yaml \
      exec -T backend tar czf - -C /data . > "backup/backend-data-$(date +%Y%m%d-%H%M%S).tgz"
    chmod 600 backup/*.tgz

    # 备份证书卷（避免恢复后重新申请触发 CA 限流）
    docker run --rm -v eldercare-public_caddy-data:/data -v "$PWD/backup:/backup" \
      caddy:2-alpine tar czf /backup/caddy-data-$(date +%Y%m%d-%H%M%S).tgz -C /data .
    chmod 600 backup/*.tgz

    # 恢复前先校验归档可读，再停后端、回灌、起后端
    tar tzf backup/backend-data-<时间戳>.tgz > /dev/null
    docker compose --env-file deploy/.env.deploy -f deploy/compose.public.yaml stop backend
    docker compose --env-file deploy/.env.deploy -f deploy/compose.public.yaml \
      run --rm --no-deps -T --entrypoint sh backend -c 'tar xzf - -C /data' \
      < backup/backend-data-<时间戳>.tgz
    docker compose --env-file deploy/.env.deploy -f deploy/compose.public.yaml start backend
    ```
    注意：归档里的 `backend-state.json` 含个人数据，**不要**贴进聊天、工单或 Git。
14. **把 `https://<域名>` 交给 APP 队友**：只交付裸的 HTTPS 根地址
    （例：`https://<域名>`，不带 `/api`、不带端口、不带 query、不带凭据），
    并同时告知合同版本 `1.0.0`（`docs/APP-API-v1.json`）。
    **不要**交付任何密钥、Token、口令、AppSecret 或联系人数据——APP 侧只需要这一个
    根地址，加上监护人自己输入的口令。

---

## 5. 预检脚本的判定口径

`deploy/verify/preflight-public.sh` 覆盖：

| 检查 | 判定 |
|---|---|
| 静态制品 | compose 是否存在、非注释行是否出现 1883/9000/9001/9002/9100/9101、是否 `privileged`、是否发布 80/443；Caddyfile 是否有 `reverse_proxy` 与 `{$PUBLIC_DOMAIN}` |
| 变量文件 | 是否存在、权限是否为 `*00`（0600） |
| 必需变量 | 7 个 APP-only 变量是否都存在且非空；是否仍是 `REPLACE_` 占位符；值是否含 `$` |
| 语义 | `PUBLIC_DOMAIN` 是否裸主机名且非样例域名；三个密钥/口令长度；`INGEST_KEY` ≠ `API_TOKEN_SECRET`；微信可选配置是否成组；`CONTACTS_JSON` 是否为 JSON 数组 |
| DNS | 域名是否可解析；解析到内网/回环地址时告警（此时端口断言只反映本机视角） |
| TLS | 证书链是否校验通过、剩余有效期是否 ≥ 14 天 |
| 端点 | `/healthz`=200；`/readyz`=200；未认证 `/api/v1/overview`=401；错误 APP 登录=401；无 key 的 `/internal/v1/commands`=401 |
| 端口 | 1883/9000/9001/9002/9100/9101/8080 必须**不可达**；443 必须可达；80 不可达时告警 |

两点必须强调：

1. **`/readyz` 缺失按硬失败处理。** 该端点已由
   `cloud/backend/src/server.js` 实现；脚本仍会把 404/405 报为
   `PREREQUISITE MISSING` 并返回非 0，**不会**退回用 `/healthz` 冒充就绪。
2. **"无法判定"不等于安全。** 端口探测失败（例如网络异常）会报 FAIL 而不是 PASS。
   脚本刻意不使用 `nc -z`：busybox 的 `nc` 不支持 `-z`，会以用法错误返回非零，
   从而把"开放"误判成"关闭"。

可选开关：`CHECK_WECHAT_LOGIN=1` 会用一个无效 code 真实调用一次
`POST /api/v1/auth/wechat`。它**只能**确认该端点可达且安全失败（4xx），
**不能**证明 `WECHAT_APP_SECRET` 正确——错误密钥与错误 code 都会得到 400。
默认关闭，避免无谓地消耗微信侧配额。

---

## 6. 日志与磁盘

- 后端只写 stdout/stderr；Caddy 访问日志走 stdout（`Caddyfile` 中显式 `output stdout`）。
- **访问日志必须过滤 `x-ingest-key`**：Caddy 默认会原样打印所有请求头，只对
  `Authorization` / `Cookie` 做内置脱敏，家庭网关使用的 `x-ingest-key` 会明文进日志
  （本机已实测复现，见第 12.2 节）。`Caddyfile` 已用 `format filter` 删除该头，
  改动这段配置时必须保留过滤，否则内部凭据会重新落进日志。
- 轮转由容器运行时负责：`compose.public.yaml` 对两个服务都设置了
  `logging.options.max-size=10m`、`max-file=3`，因此不需要额外的 logrotate。
- 持久化数据在命名卷 `backend-data`（容器内 `/data/backend-state.json`）。
  该快照包含房间名、联系人电话，以及设备上报的坐标（若设备有有效定位），
  **属敏感数据**：做任何复制、备份或取证时都必须限权并加密，不得贴进聊天/工单/日志。
- 手工备份与恢复的最小流程见第 4 节步骤 13（含证书卷备份与恢复前校验）。
  后续加固批次仍需补：**自动化**备份/恢复脚本、保留策略与快照加密留存；
  本批次**不含**这两项自动化脚本。

---

## 7. 回滚清单

1. `docker compose --env-file deploy/.env.deploy -f deploy/compose.public.yaml down`
   —— **不要加 `-v`**，否则会删除 `backend-data` 与证书卷。
2. 如需回退到"仅局域网演示"：停掉公网 compose，把小程序切回本地演示数据
   （页面会显示"演示数据"标识），并明确告知"公网已下线"。
3. 如需回退密钥：同时更新公网 `INGEST_KEY` 与家庭 `BACKEND_INGEST_KEY` 后重启两侧；
   只改一侧会导致状态同步与命令同步静默失效。
4. 回滚后重新跑一次 `deploy/verify/preflight-public.sh` 并保存输出。

---

## 8. 应用侧必须遵守的日志边界

**评审项：应用、APM、出站代理都不得记录完整出站 URL（含 query）。**

原因：后端调用微信 `jscode2session` 时，`WECHAT_APP_SECRET` 按微信协议必须放在
**出站请求的 query** 里（`cloud/backend/src/auth.js`）。这个请求是 backend 容器
直接发往微信服务器的，**不经过入站反向代理**，因此 Caddy 的入站访问日志看不到它，
也不能靠"裁剪 Caddy 日志的查询串"来解决。

正确的边界在应用侧：

- 当前 `auth.js` 没有任何日志调用，`server.js` 的错误回显只含状态码与 errcode，
  不含 URL 或密钥 —— **现状没有违规**。
- 未来新增任何 HTTP 客户端日志、错误上报、链路追踪、APM 或出站代理时，
  必须对出站 URL 的 query 做脱敏，并把它纳入代码评审。
- 入站侧保持默认访问日志即可；本站路径（如 `/api/v1/alerts/<alarmId>/ack`）
  不含清单内的敏感值。

---

## 9. 小程序侧检查项

1. **HTTPS 强制**：客户端只接受 `https://` 后端地址，拒绝 HTTP、URL 内嵌凭据、
   查询参数与片段（`mobile/wechat-miniprogram/utils/settings.js`）。
2. **合法域名**：`PUBLIC_DOMAIN` 必须登记进微信后台的 `request` 合法域名；
   生产环境保持域名校验开启，不要用"关闭合法域名校验"掩盖配置问题。
3. **生产地址锁定**：`services/api.js` 现在优先采用
   `config/environment.js` 的 `API_BASE_URL`；只要正式构建设置了该值，本地历史设置
   不会覆盖它，总览页也会隐藏地址输入并显示“生产地址已锁定”。开发构建把该值留空时，
   才允许使用本地设置。
4. **密钥零容忍**：小程序目录不得出现任何密钥、Token、AppSecret、openid、手机号。

---

## 10. 第一阶段 P0 与后续加固的边界

**第一阶段 P0（本批次覆盖）**

| ID | 内容 | 状态 |
|---|---|---|
| S-P0-1 | 公网后端可就绪运行（持久卷 + 启动前写权限确认） | **公网实测通过**：ECS 上 backend `healthy`、caddy running；本机持久化与重启恢复证据仍保留在第 12 节 |
| S-P0-2 | 入站 HTTPS / 域名 / 证书 | **公网实测通过**：`api.luxunacc.xyz`、Let's Encrypt 公共证书、HTTP 308 跳转和 HTTPS 200 |
| S-P0-3 | 最小 compose；不发布 1883/9000/9001/9002/9100/9101/8080；后端只经 Caddy | **本机实测**：backend 无任何主机端口映射，caddy 只发布 80/443 |
| S-P0-4 | readiness 信号 | **本机实测**：`/readyz` 200，compose 就绪健康检查使 backend 进入 `healthy` |
| S-P0-5 | Secret 运行时注入（含 `CONTACTS_JSON`） | **本机实测**：缺变量时 compose 以变量名 fail closed；随机临时凭据注入成功 |
| S-P0-6 | 微信前置：正式 AppID、合法域名、体验成员 | 待用户 |

**移出第一阶段（后续加固批次，不阻塞第一次演示）**

家庭侧 systemd 守护；备份与恢复脚本；`deploy/logrotate/`；镜像 digest 固定与 `npm ci`；
排水期健康状态与 `closeIdleConnections()`；API 限流与访问日志；Broker/Bridge 的鉴权与 TLS；
多实例与数据库迁移；告警主动推送（当前小程序只有下拉刷新，没有订阅消息）；
真实 OneNET 凭据常驻运行；YED 直连 OneNET。

---

## 11. 待 Codex / 用户处理的前置

1. **域名、备案、AppID、体验成员（用户）**：属账号与合规前置，需要提前准备。
2. **正式构建地址（用户 / Codex）**：拿到真实域名后，把 HTTPS 根地址写入
   `mobile/wechat-miniprogram/config/environment.js` 再生成体验版；该值不是密钥。
3. **现场网络前置（用户）**：演示前确认目标 2.4 GHz 热点存在、家庭主机在该网络有 IPv4 地址。
   这是现场核对项，不是当前链路缺陷——最终固件的 Wi-Fi/IP/Bridge TCP 与 13 位毫秒上报
   已有 PASS 记录。

### 11.1 正式上线仍需要用户提供的最小信息

本轮**没有**购买、也没有部署任何云资源。要开始公网部署，只需要下面四项
（本文件不预设任何具体值）：

| # | 需要的信息 | 说明 |
|---|---|---|
| 1 | Linux 服务器公网 IP | 用于 DNS 的 A 记录与外部连通性验证 |
| 2 | SSH 用户与认证方式 | 只需用户名与"密钥/密码"这种方式说明；**不要在文档、聊天或工单里粘贴私钥** |
| 3 | 一个解析到该服务器的域名 | 裸主机名即可，不要带 `https://`、端口或路径 |
| 4 | 是否已开放 80/443 | 云安全组与主机防火墙**两层**都要确认 |

不需要提供的：任何已有密码、密钥、Token、AppSecret、OneNET 凭据或联系人数据。
`API_TOKEN_SECRET` / `INGEST_KEY` / `APP_GUARDIAN_PASSWORD` 应由部署方**本地随机生成**，
并且只写入主机上的 `deploy/.env.deploy`（0600）。

---

## 12. 本机部署前验收记录（历史基线）与当前公网状态

### 12.1 已完成（本机 Windows 开发机）

环境：Docker Desktop 4.95.0 + WSL2 后端（**Linux containers**）。
`docker version` 客户端与服务端均为 29.8.2，`docker compose` v5.6.0，
`docker info` 的 `OSType=linux`、`Storage Driver=overlayfs`，
`docker run --rm hello-world` 成功。

> **镜像来源声明**：本机所在网络无法访问 Docker Hub（`registry-1.docker.io`
> 的 DNS 解析被污染，连接被拒），因此基础镜像 `node:24-alpine`、`caddy:2-alpine`、
> `hello-world` 是通过国内公共镜像源临时拉取后**在本地重新打标签**的。
> 没有修改 Docker 全局配置（`daemon.json` 未改），没有登录任何账号。
> 生产主机应从可信来源重新拉取，或改用自有镜像仓库，并复核 digest。

已执行的验证：

| 项目 | 结果 |
|---|---|
| `docker compose ... config`（缺变量） | 退出码 1，只输出变量名 → fail closed |
| `docker compose ... config --quiet`（补全变量） | 退出码 0，配置合法 |
| `caddy validate`（本次修改后的 Caddyfile） | `Valid configuration` |
| `docker compose ... build --no-cache` | 成功；镜像 `eldercare-cloud-backend:local`，242 MB，`linux/amd64`，`User=node` |
| 容器状态 | `backend` running/**healthy**；`caddy` running（compose 未给它定义 healthcheck） |
| HTTP → HTTPS | `:80` 返回 **308**，`Location: https://<host>/...` |
| HTTPS 证书链校验 | `--cacert <Caddy 本地根 CA>`（**未用 `-k`**），`ssl_verify_result=0`，`/healthz` 200 |
| `/healthz` / `/readyz` | 200 / 200 |
| 匿名访问受保护接口 | `/api/v1/*` 全部 401；`/internal/v1/**` 无 `x-ingest-key` 401 |
| 错误口令登录 | 401 |
| 正确口令登录 | 200，`tokenType=Bearer`，`expiresIn=7200` |
| Bearer 只读合同 | `overview`/`rooms`/`devices`/`alerts`/`contacts`/`location`/`communications` 全部 200 |
| `deploy/verify/verify-app-api.mjs` | `RESULT PASS`（13 项全 PASS，走真实 HTTPS） |
| 持久化 | 摄入设备状态 → 房间/告警落盘 → `restart backend` → 房间、告警与 PENDING 命令均仍在 |
| 后端回归 | `npm run check` 通过；`npm test` **215 / 215 pass** |
| 密钥泄漏扫描 | 容器日志与镜像内均无 `API_TOKEN_SECRET` / `APP_GUARDIAN_PASSWORD` / 会话 Token；镜像内无 `.env*`、无 `test/` |

本机验收使用 `deploy/compose.local-verify.yaml`（**仅本机、仅回环**）：把 caddy 的
入口端口从 `0.0.0.0:80/443` 改为 `127.0.0.1:8080/8443`（本机 80/443 已被其它进程占用），
并让 `PUBLIC_DOMAIN=localhost` 走 Caddy 内部本地 CA。正式
`compose.public.yaml` 与 `Caddyfile` 的 HTTPS 语义**没有被修改**，
该 override 也不得用于公网主机。

### 12.2 本次修复的部署缺陷

**Caddy 默认访问日志会把自定义请求头 `x-ingest-key` 的明文值写进 stdout 日志。**
Caddy 只内置脱敏 `Authorization` / `Cookie` / `Proxy-Authorization`；
家庭网关调用 `/internal/v1/**` 使用的 `x-ingest-key` 不在名单内。
该密钥可写入设备状态并读取命令队列，落入日志即等于泄漏内部通道凭据。
已在 `deploy/Caddyfile` 用 `format filter` 编码器显式删除
`X-Ingest-Key` / `Authorization` / `Cookie`，并实测「修复前明文出现、修复后被删除」，
访问日志其余字段（method / uri / status / size / tls）保持完整。
同时把 HTTP 跳转码的注释由 301 更正为实测的 **308**。

### 12.3 公网部署更新（2026-10-15）

公网 Linux 主机、正式 DNS、公共 ACME 证书、80/443、防火墙基线、TLS 握手、健康端点、
匿名鉴权边界以及真实监护人登录/API 合同现已通过。具体证据和仍未完成项见
`docs/evidence/2026-10-15-public-cloud-acceptance.md`。

仍未验证：

- 队友 APP 手机真机联调和推送；
- 家庭网关携真实 `INGEST_KEY` 上传 DAYU200/ESP32 状态；
- APP 公网 ACK 下发实体设备并回传 `ACKED`；
- 微信小程序通道（当前 APP-only，不作为本阶段前置）。

不得重复购买服务器或域名、重配 DNS、重装 Docker、重新上传同一部署包、创建另一份
`.env.deploy` 或启动第二套相同容器。
