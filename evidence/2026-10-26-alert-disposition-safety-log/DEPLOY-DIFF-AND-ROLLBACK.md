# 公网部署差异与回退方案（告警处置结果 + 安全日志）

- 日期：2026-10-26（Asia/Shanghai）
- 状态：**已准备、未执行**。本轮没有部署公网 backend、没有改 DNS/绑定/Wi-Fi/AP、没有安装/签名 APP、没有操作设备。
- 依据：`competition/docs/PUBLIC-DEPLOY.md`（Docker compose + Caddy TLS + 命名卷 `backend-data`）、`competition/cloud/backend/Dockerfile`（镜像只 COPY `package.json` 与 `src/`，排除 `test/`）、`competition/deploy/compose.public.yaml`。

## 1. 当前生产事实（部署前必须承认）

| 项 | 事实 |
|---|---|
| 公网 API | `https://api.luxunacc.xyz`（APP `GuardianService.ets` 的 `API_BASE_URL`，本轮未改） |
| 公网后端版本 | 合同 v1.0.0；**没有** `/api/v1/alerts/{alarmId}/dispositions`、`/api/v1/safety-logs` |
| 持久化 | Docker 命名卷 `backend-data`，容器内 `/data/backend-state.json`，当前 schema v5 |
| 部署方式 | `docker compose --env-file deploy/.env.deploy -f deploy/compose.public.yaml`；镜像 `eldercare-cloud-backend:local`；Caddy 终止 TLS |
| 本轮验证边界 | 只在本地源码 + 临时数据文件 + 127.0.0.1 隔离端口验证；APP 只在本地构建/单测 |

## 2. 需要部署的差异（D 类：告警处置结果 + 安全日志）

### 2.1 进入镜像的文件

| 变更 | 文件 |
|---|---|
| 新增 | `competition/cloud/backend/src/safety-log.js`（9,350 B，SHA-256 `D34D376A…A7473A3D`） |
| 修改 | `competition/cloud/backend/src/store.js`（12,710→18,385 B） |
| 修改 | `competition/cloud/backend/src/persistent-store.js`（58,781→67,044 B，schema v5→v6） |
| 修改 | `competition/cloud/backend/src/server.js`（30,140→37,008 B，+3 路由） |
| 修改 | `competition/cloud/backend/package.json`（check 脚本加入 safety-log.js） |

> `server.js`、`package.json` 与**并行会话的 E 类（`/api/v1/activity/report`）共享**。若只部署 D，必须把 `server.js` 中 E 的 `activityStore`/路由块摘除或在部署前确认 E 归属方冻结；否则会连同未验收的 E 一起上线。建议在用户确认 E 归属与冻结后，再合入一次共享文件。

### 2.2 新增 HTTP 接口

```text
POST /api/v1/alerts/{alarmId}/dispositions   # 登记处置结果（201/200/409/400/404）
GET  /api/v1/alerts/{alarmId}/dispositions   # 单告警处置记录（200/404）
GET  /api/v1/safety-logs?limit=50[&alarmId=] # 安全日志历史（200/404）
```

- 全部复用既有 Bearer 会话鉴权（401/403）；无新环境变量、无新端口、无新外部依赖、无新卷。
- **不改变** `POST /api/v1/alerts/{alarmId}/ack` 的请求/响应语义；不生成 ACK/reset 命令。

### 2.3 数据迁移（关键风险）

- 新代码加载 v1–v5 快照时 `safetyLogs=[]`；**下一次成功变更**（设备状态 ingest 即会触发）即写入 `schemaVersion=6`。
- **旧代码（v5）无法加载 v6 快照**：回退旧镜像前必须先恢复升级前的 `backend-state.json` 备份；否则 backend 会以 `persistent store unsupported schemaVersion: 6` 拒绝启动。
- 迁移不需要手工脚本、不需要停机迁移；但升级前必须完成第 3.1 节备份。

## 3. 部署步骤（需用户/运维授权后执行，本轮未执行）

### 3.1 升级前备份（强制）

```sh
cd <public-host>/eldercare-deploy   # 放置 compose 与 deploy/.env.deploy 的目录
mkdir -p backup && chmod 700 backup

# 1) 后端快照（含个人数据，落地即限权，不贴聊天/工单/Git）
docker compose --env-file deploy/.env.deploy -f deploy/compose.public.yaml \
  exec -T backend tar czf - -C /data . > "backup/backend-data-$(date +%Y%m%d-%H%M%S).tgz"
chmod 600 backup/*.tgz

# 2) 记录当前镜像 ID（回退用；不要用 latest 漂移）
docker compose --env-file deploy/.env.deploy -f deploy/compose.public.yaml images backend
```

### 3.2 更新与滚动替换

```sh
docker compose --env-file deploy/.env.deploy -f deploy/compose.public.yaml build --no-cache
docker compose --env-file deploy/.env.deploy -f deploy/compose.public.yaml up -d
docker compose --env-file deploy/.env.deploy -f deploy/compose.public.yaml ps
```

- **禁止** `docker compose down -v`（会删除 `backend-data` 与 Caddy 证书卷）。
- 不修改 Caddyfile、不修改 DNS/绑定、不新增端口。

### 3.3 部署后验证（按 PUBLIC-DEPLOY §4.10）

```sh
curl -sS -o /dev/null -w 'healthz %{http_code}\n' https://<域名>/healthz          # 期望 200
curl -sS -o /dev/null -w 'readyz  %{http_code}\n' https://<域名>/readyz           # 期望 200
curl -sS -o /dev/null -w 'overview %{http_code}\n' https://<域名>/api/v1/overview # 期望 401
```

- 新接口在未认证时应为 401（`/api/v1/safety-logs` 未带 Bearer）；带监护人会话时应为 200/404，而不是 404 "not found"（旧版本）。
- 监护人登录口令由用户自己在 APP 输入；本方案不索取、不记录任何口令/Token。

## 4. APP 侧部署差异

| 项 | 事实 |
|---|---|
| 源码 | D 类改动已完成（见任务目录 `app/` 证据） |
| 新候选 HAP | `entry-default-unsigned.hap`，2,613,947 B，SHA-256 `2CFB890880274AFD946E9C0E87427E2E60FA099DA7F6AD15A1F5899EDEAF91DF`（**unsigned**；包含并行 E 旧版代码） |
| 正式 HAP | 未改动；冻结包 `competition/evidence/2026-10-24-demo-backup/artifacts/hap/phone-guardian-inline-summary-formal-8A722EB6.hap`（2,077,912 B，SHA-256 `8A722EB6FDA7BB73EE58F3BDA3D95B5D238401DA8E3CC9179F1266FD5253A985`） |
| 安装前置 | 需要 signingConfigs/签名材料（用户/DevEco 操作）与手机连接；本轮未签名、未安装 |

- 公网后端未部署前，安装新 HAP 也能打开旧功能；安全日志页签/处置提交会显示真实接口错误（不会显示“已保存”）。
- 若要“最终 HAP 与工作树完全一致”，需等并行 E 会话冻结后重建一次（D 类不变，重建只刷新 E 代码）。

## 5. 回退方案

### 5.1 公网 backend 回退（已升级后）

1. 停 backend（不删卷）：`docker compose … stop backend`。
2. 恢复升级前快照（**必须**，否则 v5 代码读不了 v6 文件）：
   ```sh
   docker compose … run --rm --no-deps -T --entrypoint sh backend -c 'rm -rf /data/backend-state.json && tar xzf - -C /data' \
     < backup/backend-data-<升级前时间戳>.tgz
   ```
   （恢复前先 `tar tzf` 校验归档可读；保留旧文件副本。）
3. 用升级前记录镜像 ID 启动（或 `git`/源码回退后 `build`）：`docker compose … up -d`。
4. 重跑 3.3 的 healthz/readyz/overview 与既有告警/设备查询，确认回到升级前行为。
5. 回退后新接口消失属于预期；APP 侧新页面会显示“接口未部署”类真实错误。

### 5.2 本地源码回退（未部署时）

- D 类为增量：按 `backend/D-E-SCOPE-SPLIT.md` §回退 D 类 8 步反向操作（删除 `safety-log.js` 与 4 个测试、store.js 方法块、persistent-store.js v6 块、server.js 路由、package/README/docs 段落）。
- 源文件快照：`source-snapshot-D-20261026.zip`（123,201 B，SHA-256 `3E9DE38AF1F3CD2CD45957314C28DE0398D1E50DD79EA07A755C44F26CCFDB94`），含 D 改动文件与 `MANIFEST.txt`。
- 注意：工作区无 git 仓库，改动前的完整源文件未被快照（只有基线哈希/字节数与冻结 10/24 归档）；若需精确回退，使用上面的反向步骤或从冻结归档恢复对应文件（`competition/evidence/2026-10-24-demo-backup/source/app-entry/` 中 `LogPage.ets`、`Models.ts` 与改动前基线逐字节一致；其余文件在 10/25 后另有变更，不能直接替代）。

### 5.3 APP 回退

- 本轮**未安装任何 HAP**，正式应用与正式数据未动，无需回退。
- 若将来安装了候选 HAP，回退步骤 = 重新安装冻结正式 HAP（路径/哈希见第 4 节）并在设备侧确认版本号；不卸载、不清数据（遵守既有边界）。

## 6. 真实验收所需（阻塞项，需要用户明确授权/现场操作）

1. **授权公网 backend 升级**（选择维护窗口、确认 E 类是否一起上线、执行 3.1 备份与 3.2 更新；本方案不自作主张部署）。
2. **签名并安装新 HAP 到手机**（或明确接受只在模拟器验证）；本轮不签名、不安装。
3. **用户明确选择一个既有可操作告警**用于真实处置验收；不得制造新的 SOS/FALL，不得擅自 ACK/reset 既有告警。
4. 在该告警上执行：查看告警 → （可选 ACK 由用户决定）→ 填写处置结果与说明 → 保存 → 在“安全日志”页按日期找到该记录；随后重启手机 APP 或等待 backend 重启后再查，确认记录仍在。
5. 现场条件具备后，把处置时间/处理人/结果/说明、APP 截图路径、后端响应状态码记录到本轮证据目录；未完成以上步骤前，本任务只能写“已实现但未真实验收”。
