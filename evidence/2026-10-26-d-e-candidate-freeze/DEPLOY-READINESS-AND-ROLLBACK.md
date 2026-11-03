# DEPLOY-READINESS-AND-ROLLBACK — D/E 组合候选的部署前置、备份与回滚

- 日期：2026-10-26（Asia/Shanghai）
- **本任务没有执行任何部署、没有改 DNS/证书/绑定/Wi-Fi、没有安装 HAP、没有动生产数据。**
- 本文只说明“下一步若获授权，需要什么前置条件、备份什么、怎么回滚、回滚会丢什么”。
- 依据：`competition/docs/PUBLIC-DEPLOY.md`（Docker compose + Caddy TLS + 命名卷 `backend-data`）、
  `competition/cloud/backend/Dockerfile`（镜像只 `COPY package.json` 与 `src/`，不含 `test/`）、
  `competition/deploy/compose.public.yaml`、以及本目录 `REPORT.md` / `E-FINAL-REPORT.md`。

## 1. 当前生产事实（部署前必须承认）

| 项 | 事实 |
| --- | --- |
| 公网 API | `https://api.luxunacc.xyz`（APP `GuardianService.ets` 的 `API_BASE_URL`，本任务未改） |
| 公网后端合同 | 仍是 **v1.0.0**；**没有** `/api/v1/alerts/{id}/dispositions`、`/api/v1/safety-logs`、`/api/v1/activity/report` |
| 主快照 | 命名卷 `backend-data` → 容器内 `/data/backend-state.json`，当前 **schema v5** |
| 活动文件 | 生产**不存在**（E 从未部署） |
| APP | 手机上是历史验收包（最近真实验收 = `9EEBEE…`，2,086,949 B）；本候选**未签名、未安装** |
| 本任务验证范围 | 只在本地源码 + 临时数据文件 + `127.0.0.1` 隔离端口 + 本地 HAP 构建 |

## 2. 必须备份的对象（升级前，强制）

按此顺序、全部落地后限权（`chmod 600/700`），**不入 Git、不贴聊天/工单**：

1. **主快照数据卷**（含个人数据）
   ```sh
   docker compose --env-file deploy/.env.deploy -f deploy/compose.public.yaml \
     exec -T backend tar czf - -C /data . > "backup/backend-data-$(date +%Y%m%d-%H%M%S).tgz"
   ```
   记录：文件名、字节数、SHA-256、备份时刻、当前 `schemaVersion`（应为 5）。
2. **活动状态文件**：生产当前**没有** `/data/activity-state.json`；升级后第一次有效 PIR 样本才会创建。
   因此“升级前备份”里不存在该文件是正常的 —— 但**必须记录“升级前无此文件”这一事实**，
   否则回滚时无法判断活动数据是“新增”还是“丢失”。
3. **当前镜像 ID**（回滚用，不要依赖 `latest` 漂移）
   ```sh
   docker compose --env-file deploy/.env.deploy -f deploy/compose.public.yaml images backend
   ```
4. **部署配置**：`deploy/.env.deploy`（含 `INGEST_KEY`、`API_TOKEN_SECRET` 等）的**加密/限权副本**；
   **不复制到本证据目录、不打印**。
5. **回退 HAP**：确认手机可回装 `9EEBEE9A5FC9EEC5A5993DC6923F16F0BFCCCD1CD4DE64BAF36FC7197ECAD25A`
   （2,086,949 B，`competition/evidence/2026-10-24-app-p0-sensors-local/`）。
   `8A722…` 是**更早**的回退包，不是默认最新基线。

> 备份完成后再继续；备份失败必须中止升级。

## 3. 部署前置条件（缺一不可）

1. **用户明确授权**维护窗口与公网上线范围（含是否 E 一起上）。D/E 共用 `server.js`/`main.js`/`package.json`，
   本候选镜像天然同时包含二者；若只上 D，需要另行拆分共享文件并重跑全量测试。
2. **数据兼容已确认**：新代码加载 v1–v5 快照时 `safetyLogs=[]`，**下一次成功变更即写 v6**；
   设备状态 ingest 就会触发，所以“升级即不可逆”于主快照版本。
3. **活动文件路径已确定**：默认与 `BACKEND_DATA_FILE` 同目录 `activity-state.json`，
   可用 `BACKEND_ACTIVITY_FILE` 覆盖；必须落在持久卷内，不能落在容器临时层。
4. **家庭时区已确定**：`HOUSEHOLD_TIMEZONE`（默认 `Asia/Shanghai`）。**非法值会让后端拒绝启动**，
   升级前先在部署环境校验该值。
5. **APP 签名材料与目标设备**：由用户/DevEco 配置 `signingConfigs` 后签名安装；
   本任务不持有、不索取签名口令或私钥。
6. **回退演练条件**：至少确认 §5 的恢复命令在预发或本机演练过一遍（本任务未演练）。

## 4. 数据兼容与已知运行风险

| 项 | 说明 |
| --- | --- |
| 主快照 v5 → v6 | 新代码可读 1..6；**v5 旧代码不能读 v6**。回滚旧镜像前必须恢复升级前主快照，否则后端会以 `persistent store unsupported schemaVersion: 6` 拒绝启动 |
| 活动文件 `version=1` | 与主快照**版本完全独立**，不进 v6；旧代码不认识这个文件（会忽略），但**活动历史只存在于该文件** |
| 活动文件损坏 | 后端 **fail-closed 拒绝启动**（不静默清空历史）。运维处置：停后端 → 把 `activity-state.json` 移走留档 → 重启（活动历史从零开始）→ 记录该操作 |
| 活动写盘失败 | 摄取仍返回 **202**（主链路保可用），后端只打印 `[backend] ACTIVITY_RECORD_FAILED code=…`。**自然 202 不能证明统计已落盘**，巡检要么看报告数值、要么看活动文件 mtime/内容 |
| 容量 | 安全日志 2000 条（淘汰最旧，告警本身不淘汰）；活动每设备 400 个日桶 |
| 单进程假设 | 单进程、小规模演示部署；无跨进程文件锁。不得多实例共享同一 `/data` |
| 权限 | 单户语义（合法 Bearer 会话）；固定角色 `household-guardian`，**无多监护人身份审计** |

## 5. 回滚方案

### 5.1 后端回滚（已升级、需要退回旧版本时）

1. **停后端但不删卷**：`docker compose … stop backend`（**禁止** `down -v`，会删数据卷与证书卷）。
2. **恢复升级前主快照（必须）**：
   ```sh
   # 先校验归档可读、再保留旧文件副本
   tar tzf backup/backend-data-<升级前时间戳>.tgz > /dev/null
   docker compose … run --rm --no-deps -T --entrypoint sh backend -c \
     'cp -a /data/backend-state.json /data/backend-state.json.pre-rollback 2>/dev/null; rm -f /data/backend-state.json && tar xzf - -C /data' \
     < backup/backend-data-<升级前时间戳>.tgz
   ```
3. **决定活动文件的去留**（两选一，必须记录选择）：
   - **保留**：把升级后产生的 `/data/activity-state.json` **移到卷外留档**（`activity-state.post-v6.tgz`），
     旧代码不读它；将来若再次升级 v6，可把它放回以延续活动历史（需与主快照时间线自洽）。
   - **删除**：仅当确认活动数据无保留价值；删除后活动历史永久丢失。
4. 用升级前记录的镜像 ID 启动（或源码回退后重新 `build`）：`docker compose … up -d`。
5. 重跑 §6 的冒烟检查，确认回到升级前行为（新接口消失属预期）。

**回滚后新增数据的保留限制（必须说清）**：

- **D 的处置记录/安全日志**存在主快照 v6 里；回滚到 v5 时**必须**用升级前快照覆盖整份
  `backend-state.json`，因此**升级后新增的处置记录会随之丢失**。若必须保留，需要人工从 v6 文件里
  抽取 `safetyLogs` 另存（本任务没有提供迁移脚本，也没有执行）。
- **E 的活动统计**在独立文件里，回滚**不会**被主快照覆盖；但旧代码不读它，只能留档。
- 回滚期间的新设备状态/告警同样以升级前快照为准，属于“回到备份时刻”。

### 5.2 APP 回滚

- 本任务**未安装**任何 HAP，因此当前没有回滚动作。
- 将来若安装了本候选：回退 = 重新安装最近已真实验收包
  **`9EEBEE9A…ECAD25A`（2,086,949 B）**，在设备侧核对版本/哈希；**不卸载、不清数据**。
- 旧 D 文档把 `8A722…` 当作“正式回退基线”，已在本目录纠正（见 `REPORT.md` §4.6）；
  旧文件按要求保留原貌。

### 5.3 本地源码回滚（本任务改动的 10 个文件）

工作区**没有 Git**。用本目录 `_work/before-after/<file>.before` 覆盖回改前版本即可，
改前 SHA-256 记录在 `_work/PRE-EDIT-SNAPSHOT.txt` 与 `reconstruction-report*.json`（10/10 已校验）。
回退后必须重跑：`npm run check`、`npm test`、`hvigor test`、`assembleHap`。

## 6. 部署后冒烟检查（未认证接口只应 401，不应 404）

```sh
curl -sS -o /dev/null -w 'healthz  %{http_code}\n' https://<域名>/healthz           # 期望 200
curl -sS -o /dev/null -w 'readyz   %{http_code}\n' https://<域名>/readyz            # 期望 200
curl -sS -o /dev/null -w 'overview %{http_code}\n' https://<域名>/api/v1/overview   # 期望 401
curl -sS -o /dev/null -w 'safety   %{http_code}\n' https://<域名>/api/v1/safety-logs        # 期望 401（旧版是 404）
curl -sS -o /dev/null -w 'activity %{http_code}\n' https://<域名>/api/v1/activity/report     # 期望 401（旧版是 404）
```

再带**用户自己输入**的监护人会话验证 `200`（不是 404“not found”）。**不索取、不记录口令/Token。**

## 7. 真实部署验收仍需的现场步骤（本任务未执行）

1. 用户授权 → 备份（§2）→ 选择上线范围（D only / D+E）→ 部署（§3）→ 冒烟（§6）。
2. 签名并安装候选 HAP 到指定手机/模拟器（或明确只要模拟器验证）。
3. **D 验收**：用户指定一个**既有可操作告警** → 查看 → （是否 ACK 由用户决定）→ 填处置结果+说明 →
   保存 → 在“安全日志”页找到该记录 → 重启 APP 或等后端重启后再查，确认仍在 →
   确认处置**没有**产生 ACK 命令、没有把告警改成 ACKED。
4. **E 验收**：自然 PIR 数据累积后看日/周/月：窗口/覆盖率/缺失/上一周期是否如实；
   不足历史必须显示“无数据/不足”；`dataSince` 显示正确、不出现 1970。
5. 记录：时间、版本/哈希、动作、观察窗口、HTTP 状态码、截图路径、重启后结果、回滚是否可用。
   完成前只能写“已部署但未真实验收”。

## 8. 本任务明确**没有**做（避免误解）

- 没有部署、没有 `docker build/up`、没有改 `Caddyfile`/DNS/证书/端口/绑定。
- 没有安装/签名 HAP、没有连接手机/模拟器/设备、没有打开串口、没有烧录。
- 没有启动/停止当前演示服务（仅本地隔离测试进程）。
- 没有 ACK/reset 任何既有告警、没有制造 SOS/FALL、没有发布生产 ingest。
- 没有恢复 `LOCAL-ALARM-VOICE-CLOSURE`，没有开展远程视频/跌倒检测/脱离 PC 等扩展。
- 没有卸载清数据、没有改信任链、没有关闭签名校验。
- 没有输出任何密钥/Token/Wi-Fi 口令/签名口令/私钥。
