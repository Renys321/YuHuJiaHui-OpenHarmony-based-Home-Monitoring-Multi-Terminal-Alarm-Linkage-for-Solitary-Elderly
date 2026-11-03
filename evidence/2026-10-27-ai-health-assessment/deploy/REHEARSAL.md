# 生产部署演练记录（本地，使用与生产完全相同的 compose 文件）

目的：在用户于主机执行发布前，先用**同一份** `deploy/compose.public.yaml` + `Caddyfile` + 同一镜像/源码在本地跑通，
提前暴露 compose 变量、容器只读、健康检查、Caddy 反代、DeepSeek 环境变量透传等问题。

日期：2026-10-27 15:27–15:30（Asia/Shanghai）

## 配置

- 目录：`<WORKSPACE>\tmp\deploy-rehearsal\`（`deploy/` + `cloud/backend`，与主机 `/opt/eldercare` 同布局）
- compose：`deploy/compose.public.yaml`（发布包内版本，含 `DEEPSEEK_*` 透传）
- `.env.deploy`：`PUBLIC_DOMAIN=localhost`、`ACME_EMAIL=rehearsal@example.com`、临时 `API_TOKEN_SECRET`/`INGEST_KEY`/APP 监护人口令、真实 `DEEPSEEK_API_KEY`（仅本地文件，0600 语义，未写入证据）
- 命令：
  ```bash
  docker compose --env-file deploy/.env.deploy -f deploy/compose.public.yaml -p eldercare-rehearsal up -d --build
  ```
- 结果：`eldercare-rehearsal-backend-1` **healthy**；`eldercare-rehearsal-caddy-1` 监听 80/443（localhost 内部 CA）。
- 清理：`docker compose ... down -v`（容器/网络/卷全部删除，未残留）。

## HTTPS 端到端结果（经 Caddy，`https://localhost`，`NODE_TLS_REJECT_UNAUTHORIZED=0` 仅用于本地自签）

| 检查 | 结果 |
| --- | --- |
| `GET /healthz` | **200** |
| 匿名 `GET /api/v1/health-profile` | **401** |
| `POST /api/v1/auth/app` | **200** |
| 空资料 `GET /api/v1/health-profile` | **200 `{"profile":null}`** |
| `PUT /api/v1/health-profile`（合成资料） | **200** |
| 读取资料 | **200** |
| **`POST /api/v1/health-advice`（真实 DeepSeek）** | **200，8,406 ms，model=deepseek-chat** |
| 免责声明固定 | **true** |
| 后端红线扫描（16 词、否定语境感知） | **0 命中**（真实输出中出现“不构成运动处方或治疗方案”，属否定语境，正确放行） |
| 建议结构 | summary 279 字；diet 8 条；exerciseAndSleep 8 条；warningSigns 7 条 |

真实响应留档：`real-api/rehearsal-advice.json`。

## 结论

- 发布包内的 compose/env/镜像组合**可以正常启动并对外提供健康接口**，`DEEPSEEK_API_KEY` 透传有效，容器只读与健康检查无冲突。
- 生产发布仍需用户在主机的 `/opt/eldercare` 按其既有 `.env.deploy` 执行（本演练未接触生产主机）。
