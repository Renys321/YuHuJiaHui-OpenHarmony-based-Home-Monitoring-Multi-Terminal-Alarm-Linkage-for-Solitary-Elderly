# 视频探望中继 ECS 部署件（competition/deploy/video/）

把手机远程视频探望的公网中继 **video-relay** 装到既有 `eldercare-public` 主栈旁边。
只新增 1 个容器服务 + Caddy 的 `/video/*` 路由，**不新开公网端口、不改 backend**。

- 适用契约：`competition/evidence/2026-10-27-battery-video-visit/CONTRACTS/VIDEO-VISIT-CONTRACT.md` §2.4
- relay 源码：`competition/video/relay/`（测试/协议/排障见其 README）
- 本地已验证：Caddyfile 补丁真实跑通 `caddy validate`（Valid configuration）、
  合并后的 compose config 中 `video-relay` **没有主机端口**；见
  `competition/evidence/.../video-relay/deploy-validation.log`
- 公网 ECS 部署状态：**BLOCKED-BY-DEPLOY** —— 需要用户在阿里云 Workbench 执行（本仓库
  无法从开发机 SSH 到 ECS 22 端口）

---

## 0. 拓扑（部署后）

```text
手机 APP（HarmonyOS 模拟器/真机）
  │ https/wss 443
  ▼
Caddy（原有，80/443，自动证书）
  ├─ reverse_proxy backend:8080            ← 原有路由，保持不变
  └─ reverse_proxy /video/* video-relay:9443  ← 本次新增
        │  只在 compose 网络 public-edge 内，无主机端口
        ▼
     video-relay（本部署件；复用 eldercare-cloud-backend:local 镜像的 node 运行时）
        ▲  wss://域名/video/agent?key=<VIDEO_AGENT_KEY>（PC 出站注册）
        │
PC agent（家里那台接 DAYU200 的 Windows 主机，常驻）
  │  127.0.0.1:9301（hdc fport tcp:9301 tcp:9301）
  ▼
DAYU200 板端 VideoStreamServer（真实相机 640x480 JPEG）
```

DAYU200 **当前没有 IP 网络**（只有 USB/HDC），所以公网链路必须由 PC agent 出站注册；
这不是“DAYU 公网直连”，不要把本部署写成板端直连公网。

---

## 1. 前置条件（在 ECS 上已具备）

1. 既有 `eldercare-public` 主栈已部署并运行：`eldercare-public-backend-1`、
   `eldercare-public-caddy-1`，`https://<域名>/readyz` 200。
2. 镜像 `eldercare-cloud-backend:local` 存在（backend 已部署）。
   **不需要**构建新镜像、不需要服务器 `npm install`（`ws` 已 vendor）。
3. `/opt/eldercare/deploy/` 下已有 `compose.public.yaml`、`.env.deploy`、`Caddyfile`。
4. 安全组不变：只需既有 80/443；本部署不新增公网端口。

---

## 2. 用户只需要执行一条命令

### 2.1 先把两个目录上传到 ECS（保持相对结构）

在开发机 `<WORKSPACE>\competition` 下打包（PowerShell）：

```powershell
tar -czf eldercare-video-deploy.tgz video/relay deploy/video
```

在阿里云 Workbench（ECS 终端）上传 `eldercare-video-deploy.tgz` 到 `/root/`，然后：

```bash
sudo mkdir -p /root/eldercare-upload/competition
sudo tar -xzf /root/eldercare-video-deploy.tgz -C /root/eldercare-upload/competition
```

解压后应是：

```text
/root/eldercare-upload/competition/video/relay/        # server.js/agent.js/src/vendor/...
/root/eldercare-upload/competition/deploy/video/       # install-on-ecs.sh 等
```

> 若你已有其他上传位置，只要保持 `video/relay` 与 `deploy/video` 同属一个
> `competition/` 目录即可；脚本用 `deploy/video/../..` 定位源码。

### 2.2 执行（这就是“一条命令”）

```bash
sudo bash /root/eldercare-upload/competition/deploy/video/install-on-ecs.sh
```

脚本是**幂等**的：重复执行会复用 `video.env` 里的 key、跳过已打的 Caddyfile 补丁；
失败会自动回滚（恢复 Caddyfile/compose，移除 video-relay，重启 caddy）。

### 2.3 预期输出（关键行）

```text
[video-relay] 部署目录: /opt/eldercare/deploy
[video-relay] 源码目录: .../video/relay -> /opt/eldercare/video-relay (只读挂载 /opt/video-relay)
[video-relay] 已备份现有部署到: /opt/eldercare/deploy/backup/video-20261027T120000Z
[video-relay] 使用 Docker 网络: eldercare-public_public-edge
[video-relay] 已生成 /opt/eldercare/deploy/video.env (600)，已生成新的 VIDEO_AGENT_KEY（不显示，按成功提示查看）
[video-relay] 已同步 relay 源码（含 vendor/ws）到 /opt/eldercare/video-relay
[video-relay] 已安装 /opt/eldercare/deploy/compose.video.yaml 与 rollback-video.sh
[video-relay] Caddyfile 已更新（备份在 /opt/eldercare/deploy/backup/video-...）
[video-relay] 启动/更新 video-relay ...
[video-relay] 容器健康状态: healthy
[video-relay] 自检通过: 容器内 /video/healthz 200
[video-relay] 自检通过: video-relay 未映射任何主机端口（只在 compose 网络内 9443）
[video-relay] 自检通过: caddy 容器可访问 video-relay:9443
[video-relay] 重启 caddy 使 /video/* 路由与 query 脱敏生效 ...
[video-relay] 自检通过: https://<域名>/video/healthz 200 {"ok":true,"mode":"agent",...}
[video-relay] 自检通过: POST /video/session 无 token -> 401（/video/* 已到 relay）
[video-relay] 自检通过: https://<域名>/readyz 仍为 200（backend 路由未受影响）
[video-relay] 主栈状态: backend=running caddy=running
============================================================
video-relay 安装完成（只新增 1 个服务，未改 backend，无新增公网端口）
...（成功块里有 PC agent 命令、取 key 命令、运维命令、备份路径）
============================================================
```

退出码 0 = 全部自检通过。任一步失败：脚本打印原因并**自动回滚**，退出码非 0。

---

## 3. 安装脚本具体做了什么（审计用）

1. **备份** `/opt/eldercare/deploy` 的 `compose.public.yaml`、`.env.deploy`、`Caddyfile`、
   `compose.video.yaml`、`video.env` 到 `backup/video-<UTC>/`（目录 700），并记录
   `manifest.txt` 与容器状态；`docker compose config --no-interpolate` 避免密钥进备份文本。
2. **生成 `video.env`（600）**：`VIDEO_MODE=agent`、`BACKEND_BASE=http://backend:8080`、
   `VIDEO_AGENT_KEY`（复用旧值或随机 48 hex；脚本不打印）。重复执行复用旧 key。
3. **同步源码**到 `/opt/eldercare/video-relay`（只读挂载；含 `vendor/ws`，无 npm install）。
4. **安装** `compose.video.yaml` 与 `rollback-video.sh` 到部署目录。
5. **改 Caddyfile（两处，先备份 + 先 validate）**：
   - 在 `reverse_proxy backend:8080` 之前插入：
     `reverse_proxy /video/* video-relay:9443`（**保留原 backend 反代**）；
   - 在既有 `log { format filter { fields { ... } } }` 内插入 query 脱敏：
     `request>uri query { delete ticket; delete key }`
     —— APP 的 WS URL 带 `?ticket=`、PC agent 带 `?key=`，不脱敏就会以明文进 Caddy 访问日志。
   - 用 `caddy:2-alpine` 跑 `caddy validate`，语法不过则**不改线上文件**。
6. **启动** `docker compose -f compose.public.yaml -f compose.video.yaml up -d --no-deps video-relay`
   （不重建 backend/caddy）。
7. **重启 caddy**（仅当 Caddyfile 有变化）。
8. **自检**：容器 healthy、容器内 `/video/healthz` 200、**无主机端口映射**、
   caddy 容器可达 `video-relay:9443`、公网 `https://域名/video/healthz` 200、
   `POST /video/session` 无 token 返回 **401**（证明路由到 relay 而非 backend 404）、
   `https://域名/readyz` 仍 200（原 backend 反代未坏）。
   任一失败 → 自动回滚。

---

## 4. 安装后验证

```bash
# 1) relay 健康（不应需要 token；mode=agent，无人观看时 dayuLink=down 是正确的）
curl -sS https://<域名>/video/healthz
# {"ok":true,"mode":"agent","dayuLink":"down","framesReceived":0,"fps":0,"lastFrameAgeMs":-1,"viewers":0}

# 2) 鉴权必须生效（无 token 401）
curl -sS -o /dev/null -w '%{http_code}\n' -X POST https://<域名>/video/session   # 401

# 3) 主栈不受影响
curl -sS -o /dev/null -w '%{http_code}\n' https://<域名>/readyz                  # 200

# 4) 容器状态/日志
sudo docker compose -p eldercare-public --env-file /opt/eldercare/deploy/.env.deploy \
  -f /opt/eldercare/deploy/compose.public.yaml -f /opt/eldercare/deploy/compose.video.yaml ps
sudo docker logs --tail=100 eldercare-public-video-relay-1
```

然后启动 **PC agent**（家里接 DAYU 的 Windows PC，先确认 `hdc fport ls` 里
`tcp:9301 tcp:9301` 已建立，不要重复 add）：

```powershell
cd <WORKSPACE>\competition\video\relay
node agent.js --relay wss://<域名>/video/agent --key <VIDEO_AGENT_KEY> --dayu 127.0.0.1:9301
```

取 key（只在本机终端执行，不要把值贴到聊天/文档/仓库）：

```bash
sudo sed -n 's/^VIDEO_AGENT_KEY=//p' /opt/eldercare/deploy/video.env
```

手机 APP 打开视频探望时：relay 日志出现 `agent registered` → `agent dayu status dayuLink=connected`
→ `/video/healthz` 的 `dayuLink` 变 `connected`，`viewers`/`framesReceived` 增长。
手机退出后 3s 日志出现 `idle stop: no viewers`，DAYU 板端停止取帧。

---

## 5. 回滚

```bash
# 自动选最新备份
sudo bash /opt/eldercare/deploy/rollback-video.sh

# 或指定备份
sudo bash /opt/eldercare/deploy/rollback-video.sh --backup /opt/eldercare/deploy/backup/video-20261027T120000Z
```

回滚会：恢复备份文件、删除本次新增的 `compose.video.yaml`/`video.env`、移除
`video-relay` 容器、重启 caddy、自检 `/readyz` 200 且 `/video/healthz` 回到 404（旧配置）。
备份目录保留不删，便于人工核对。安装失败时脚本也会自动调用同样的回滚逻辑。

---

## 6. 安全边界（不要为了“方便”放宽）

- **无公网端口新增**：video-relay 只 `expose 9443`，不映射主机端口；公网只有 80/443。
- **不能有免鉴权流**：`/video/stream` 必须一次性 ticket（60s，来自 Bearer token 的后端复核）；
  `/video/agent` 只认 `VIDEO_AGENT_KEY`；relay 不提供 DAYU 端口直通。
- **token 不进 URL/日志**：APP token 只在 `Authorization` 头；relay 日志只记 pathname（不记 query）；
  Caddy 访问日志对 `ticket`、`key` query 做 delete 过滤。
- **不改 backend**：不新增 backend 路由/环境变量；backend 镜像不重建。
- **只读 + 最小权限**：容器 `read_only: true`、`no-new-privileges`、`init: true`、
  tmpfs `/tmp`、日志 `json-file` 限额 10m×3、`stop_grace_period` 沿用默认。
- **隐私**：viewer 离开 → 3s 空闲停止 → 向 DAYU 发 stop 并断开；不录像、不落盘、
  不提供回放；relay 只做帧转发（不解码/不转码/不缓存）。

---

## 7. 排障

| 现象 | 检查 |
|---|---|
| 安装脚本 `缺少镜像 eldercare-cloud-backend:local` | 先完成 backend 主栈部署；本脚本不建镜像 |
| `未找到 public-edge Docker 网络` | 主栈是否启动；或用 `--network <真实网络名>` |
| `caddy validate 失败` | 脚本已保留原 Caddyfile 并回滚；按提示看 validate 输出；确认现有 Caddyfile 仍是 `reverse_proxy backend:8080` + `format filter` log |
| `POST /video/session` 返回 404 | Caddy 路由未生效：确认 caddy 已重启、Caddyfile 有 `/video/*`；`docker logs caddy` |
| 公网 `/video/healthz` 502 | caddy 到 relay 不通：`docker exec <caddy> wget -qO- http://video-relay:9443/video/healthz`；看 relay 容器状态 |
| healthz 一直 `dayuLink: down` 且没有 viewer | 正常：没人看就不连 DAYU；需 PC agent 在线且手机正在观看 |
| 手机 401 | APP token 过期/无效；relay 调 `backend/api/v1/overview` 复核 401；重新登录 |
| 手机 WS 1013/BUSY | 并发超 `VIDEO_MAX_VIEWERS=2`；确认上一会话 WS 已关（APP 退出要关 WS） |
| 手机黑屏但 healthz connected | 看 relay 日志 `viewer first frame` 与 `framesReceived`；检查 APP 端 JPEG 解码与 PixelMap release |

---

## 8. 本期未验证 / 限制（如实记录）

- **ECS 公网部署未在本机执行**：无 SSH 到 ECS，必须由用户在 Workbench 执行本部署件；
  因此“公网 `wss://域名/video/...` 全链路”状态为 **BLOCKED-BY-DEPLOY**。
- 本部署件已做的本地验证：bash 语法、Caddyfile 补丁逻辑（真实 `caddy validate`
  输出 `Valid configuration`）、合并 compose config（`video-relay` 无 `ports`）。
  不代表 ECS 实际运行结果，执行后需按 §4 复验。
- DAYU 无 IP 网络、实体手机无签名材料等硬件/环境限制见契约 §5，不在部署件范围内。
