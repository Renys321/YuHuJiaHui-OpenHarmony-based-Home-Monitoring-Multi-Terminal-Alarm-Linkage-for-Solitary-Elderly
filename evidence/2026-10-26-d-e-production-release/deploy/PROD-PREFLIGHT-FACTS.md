# 生产主机只读核验结果（2026-10-27 00:00–00:05 +08:00，用户在其终端执行，Lead 只读核对输出）

> 数据来源：用户回传的 `DEEPCHECK` 输出。只读命令，未停止/未修改任何容器、未写 `/data`、未打印 `.env.deploy` 内容与个人数据。

## 1. 主机与环境事实（实测）

| 项 | 实测值 |
|---|---|
| 主机 | 阿里云 ECS，hostname `iZj6ccp283r5405m9eqiv5Z`，root 登录 |
| 项目目录 | **`/opt/eldercare/`**（含 `cloud/`、`deploy/`；不是 `/root/OpenHarmony`） |
| compose | `deploy/compose.public.yaml`（5078 B，mode 640）、`deploy/Caddyfile`、`deploy/verify/` |
| 环境文件 | `deploy/.env.deploy` **存在**（4480 B，mode 600，root:root）；另有 `.env.deploy.bak.20261022` |
| compose 版本 | Docker Compose **2.40.3**（compose v2，容器名带项目前缀） |
| backend 容器 | `eldercare-public-backend-1`，CID `77122aba8f3a…cfc88`，`Up 4 days (healthy)`，只暴露 8080/tcp（容器网络内） |
| caddy 容器 | `eldercare-public-caddy-1`，`caddy:2-alpine`，80/443 已发布，Up 11 days |
| **旧镜像（生产实际使用）** | tag `eldercare-cloud-backend:local`，**Image ID `sha256:85e940478fec966e5e0792b11b68cb9e788adc9ad7bf9f2b03b03f52260c9f5c`**（created 2026-10-15T15:39:35+08:00） |
| `/data` 卷（从容器解析，未写死） | `eldercare-public_backend-data` → `/var/lib/docker/volumes/eldercare-public_backend-data/_data` |
| `/data` 内容 | `backend-state.json` 32,939 B（0600，node）+ `evidence/` 目录；**无 `activity-state.json`** |
| **升级前 schemaVersion** | **5**；devices=8、alerts=62、`safetyLogs` 字段不存在（v5 没有安全日志台账，符合 D 未部署的事实） |
| 活动文件（E） | **`ACTIVITY_FILE_ABSENT`**（E 从未部署） |
| 磁盘 | `/` 40G，已用 6.2G，**可用 32G**（足够旧镜像 tgz + 数据 tgz + 新镜像） |
| 已有镜像 | `eldercare-cloud-backend:local 85e940478fec`、`node:24-alpine 44fce696f38b`、`caddy:2-alpine d8542f48d34a` |
| 公网健康 | `https://api.luxunacc.xyz/healthz` → **200**、`/readyz` → **200** |
| 构建上下文 | `/opt/eldercare/cloud/backend` 存在（Dockerfile/package.json/src；v5 旧源码），**本次不重建它**，改为从已校验归档构建新镜像 |

## 2. 与历史记录的差异/确认

- 历史记录“生产 schema v5、无活动文件、旧镜像为本地构建的 `:local`” —— 本次实测**一致**（schema=5、ACTIVITY_FILE_ABSENT、`:local` 在跑）。
- 历史记录里的本地旧镜像 `sha256:3c5f0ca5…`（D:\ 本机 2026-10-15 构建）**不是**生产在跑的这个 `sha256:85e94047…`；回退目标以**现场** `85e94047…` 为准，已在主机侧打标签留档（见执行记录）。
- 生产 `.env.deploy` 存在且 600，属于敏感文件；本报告与后续步骤都不读取/不打印其内容。

## 3. 对发布方案的直接影响

1. **回滚目标确定**：`eldercare-cloud-backend:pre-d-e-20261026` → `sha256:85e94047…`，并导出 tgz 留档。
2. **备份范围确定**：`eldercare-public_backend-data` 整卷（含 `backend-state.json` 与 `evidence/`）；活动文件当前不存在，备份判定按 `ACTIVITY_FILE_ABSENT` 记录。
3. **升级后 schema 变化**：首次写入主快照 v5→**v6**（新增处置/安全日志字段）；从该刻起旧镜像不能直接读该卷，回滚必须恢复升级前数据（会丢失升级后新增的处置记录与安全日志，需先留档）。
4. **镜像来源**：不从 `/opt/eldercare/cloud/backend`（v5 旧源码）重建，改为上传已校验归档 `d-e-candidate-source-2026-10-26.zip`（SHA-256 `F82DA474…8526`），在主机上从归档内 `competition/cloud/backend` 构建并打 tag `eldercare-cloud-backend:de-2026-10-26`，记录主机侧 Image ID。
