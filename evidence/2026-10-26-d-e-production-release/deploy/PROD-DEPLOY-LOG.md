# 生产部署执行记录（逐步，用户在其终端执行，Lead 核对输出）

## Step 1 — 钉旧镜像 + 导出留档（不中断服务）  2026-10-27 00:07 +08:00

- `OLD_IMAGE_MATCH_OK`：当前 backend 容器 Image = `sha256:85e940478fec966e5e0792b11b68cb9e788adc9ad7bf9f2b03b03f52260c9f5c`（与预检一致）
- 打 tag：`eldercare-cloud-backend:pre-d-e-20261026` → 同一 Image ID
- 导出旧镜像：`backup/image-pre-d-e-20261026.tar.gz`（60 MB，`gzip -t` 通过，mode 600）
- 旧镜像归档 SHA-256：`d9cc0d5819711427927eacddf80b9e75cf36ca0e3ab8bcfb9194ae06e99db698`
- 回滚覆盖文件：`deploy/compose.pin-pre-d-e.yaml`（backend 钉到 `pre-d-e-20261026`）
- 环境变量长度自检：`API_TOKEN_SECRET length=64`、`INGEST_KEY length=64`（满足新代码 32–512）
- 服务未中断（backend 仍 Up 4 days healthy）

## Step 2 — 上传已校验源码 → 主机构建新镜像 → 切换前预检（不中断）  2026-10-27 00:10 +08:00

- 上传文件：`/root/d-e-candidate-source-2026-10-26.zip`，3,954,792 B
- 主机侧 SHA-256：`f82da47444785cfb29c254f435dab40f1569041763bbeef10d7f5c235a908526`
  → 与本机记录 `F82DA47444785CFB29C254F435DAB40F1569041763BBEEF10D7F5C235A908526` **一致**
- 解压：`/root/de-src/d-e-candidate-source-2026-10-26/competition/cloud/backend`（Dockerfile/package.json/src/test 齐全）
- 代码事实：`persistent-store.js:62 const SCHEMA_VERSION = 6;` ✔（D/E v6，不是门磁 v7）
- 主机构建（legacy builder，`FROM node:24-alpine` 用主机已有 `44fce696f38b`，未联网拉新层）：
  - tag：`eldercare-cloud-backend:de-2026-10-26`
  - **主机侧 Image ID：`sha256:568b6193b1400c188f6d39d8f3be55397106c743f4eec546fe8f4e1d16b42f74`**
  - created `2026-10-27T00:09:58+08:00`，size 62,547,246 B
  - 说明：与本机（Windows）构建的 `sha256:ed481503…` 不是同一 Image ID（基础层 digest 不同：本机 node:24-alpine=`ebfe2f904627`，主机=`44fce696f38b`；**源码哈希一致**）。生产以主机侧 Image ID 为准，已记录。
- 切换前回环预检（测试专用 env + 临时卷，不碰生产卷/生产密钥）：
  - `PRECHECK healthz=200 readyz=200`
  - 日志：`eldercare cloud backend listening on 0.0.0.0:8080` / `Persistent state enabled` / `[notify] configured:false`
  - `PRECHECK_CLEANED`
- 生产服务仍未中断（backend 未 stop）

## Step 3 — 维护窗口：停服 + 整卷备份 + 校验（2026-10-27 00:12 执行，成功）

- `docker compose … stop backend` → `eldercare-public-backend-1 Stopped`（Caddy 保持在线）
- 卷名从已停容器解析：`eldercare-public_backend-data`（`docker volume inspect` 通过）
- 升级前 `/data`：`backend-state.json` 32,939 B + `evidence/`；`pre-schema = {schemaVersion:5, devices:8, alerts:62, safetyLogs:undefined}`；`ACTIVITY_FILE_ABSENT`
- 整卷备份：`backup/backend-data-20261027-001232.tgz`（2.9 KB；`tar tzf` 可读、非空），sha256 `027d27e6efcd0db8f706054fce9ceaf12cd5e10271aee8ad65c3bb8924225c48`，mode 600
- 判定：`STEP3A_OK vol=eldercare-public_backend-data ts=20261027-001232`

## Step 4 — 切换到新镜像并健康检查（2026-10-27 00:20 执行，成功）

- 补建 `deploy/compose.pin-de.yaml`（钉 `eldercare-cloud-backend:de-2026-10-26`）
- `up -d --no-build backend` → `Container eldercare-public-backend-1 Recreated / Started`
- 运行镜像：`RUNNING_IMAGE=sha256:568b6193b1400c188f6d39d8f3be55397106c743f4eec546fe8f4e1d16b42f74`、`HEALTH=healthy`、`STATUS=running`
- 公网：`healthz=200`、`readyz=200`；日志 `listening on 0.0.0.0:8080` / `Persistent state enabled` / `[notify] configured:false`
- `/data`：`activity-state.json`（2,239 B，新建）、`backend-state.json`（32,959 B，**schemaVersion=6**，`safetyLogs=0`）、`evidence/`
- PC 侧：部署后 `[cloud-sync] OK … status=202` 持续（esp32-kitchen / esp32-sos），`command-sync POLL_OK 200` 每分钟

## Step 5 — APP 更新（2026-10-27 00:18 执行，成功）

`hdc -t 127.0.0.1:5555 install -r app/guardian-d-e-only-2026-10-26-unsigned.hap` → `install bundle successfully`
版本 1000000/1.0.0 → **1000001/1.0.1**；`firstInstallTime` 不变（未卸载）；`appSignType=none` 未变（未引入签名身份）。详见 `acceptance/APP-UPDATE-RECORD.md`。

## Step 6 — D/E 真实数据验收（2026-10-27 00:27–00:40）

- **D（通过）**：真实告警 `e-1793032029-1`（用户 00:27:09 按厨房实体 SOS 键）上提交 2 条真实处置
  （`dsp-1` serverTime 00:27:30.080 空说明；`dsp-2` 00:28:17.078 说明“已经电话”；`outcome=CONTACTED_FAMILY`，`actor=household-guardian`）；
  APP 安全日志页显示 2 条（字段/顺序正确）；后端 `safetyLogs` 直接读取一致；
  `docker restart` 后 `safetyLogs` 逐字段一致；`PERSIST_DIFF` 仅来自活动文件样本实时增长（kitchen 162→164、sos 173→175）。
  另：用户 00:33:44 又点一次 ACK；00:33:48 用户再次按厨房实体键产生 `e-1793032428-2`（未确认，保留未处理，未 ACK/reset）。
- **E（月范围通过，日/周待补）**：`activity-state.json` `version=1`、`timezone=Asia/Shanghai`、`dataSince=00:20:51`；
  kitchen/sos 当日 `samples≈162/173`、`count=0`、`hourly` 多数 `null`；APP 月范围显示覆盖 1 天、今日 0 次、时段多数“无数据”、
  近 7 日趋势 10/21–10/26“无数据”、10/27 为 0，页脚声明“不会用 0 冒充”。详见 `acceptance/E-ACCEPTANCE.md`。
- **旁注（非本次引入）**：PC 侧 `esp32-bath` 自 23:41（早于部署）持续 `REJECT code=INVALID_STATUS`，与 D/E 无关。
