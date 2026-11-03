# D/E 发布制品清单（RELEASE-ARTIFACTS）

- 生成时间：2026-10-26 23:52（Asia/Shanghai）
- 本文件只列**已实际构建/校验**的制品；未完成的项明确标 UNKNOWN/BLOCKED。

## 1. 后端 D/E 镜像（已构建并本地镜像级验证）

| 项 | 值 |
|---|---|
| 构建源 | 已校验归档 `d-e-candidate-source-2026-10-26.zip` 解压副本 `_work/src/d-e-candidate-source-2026-10-26/competition/cloud/backend` |
| 归档 SHA-256 | `F82DA47444785CFB29C254F435DAB40F1569041763BBEEF10D7F5C235A908526`（与 release-prep/SHA256SUMS 记录一致） |
| 归档内容校验 | 解压后 188 文件；`MANIFEST.sha256` 的 187 项逐项比对 **187/187 PASS** |
| 后端代码版本事实 | `persistent-store.js` SCHEMA_VERSION=**6**；`activity-store.js` ACTIVITY_FILE_VERSION=**1**；合同 `1.2.0` |
| 镜像 tag | `eldercare-cloud-backend:de-2026-10-26` |
| Image ID | `sha256:ed481503ff4883e83cd7f485d07768f7a29b69282f67d81439c9d79238fdada0`（短 `ed481503ff48`） |
| Created | 2026-10-26T15:46:00Z（UTC）＝23:46 +08:00 |
| Size | 241,939,309 B（约 242 MB） |
| Base image | `node:24-alpine`（使用本地缓存 digest `ebfe2f904627`，未变更 Dockerfile） |
| 归档 tar | `build/eldercare-cloud-backend-de-2026-10-26.tar`（61,751,296 B，SHA-256 `A9CBB12F2C9A9E71A0097123B9BCA7F90B94DDCED6AFF1F9CBB2AD0B06E86C62`） |
| 构建日志 | `build/docker-build-backend-de.log` |
| 本地旧镜像（仅本机参考，非生产事实） | `eldercare-cloud-backend:local` = `sha256:3c5f0ca5ab3eab0fa54803b7d172c35c0a5020075119593c357fc63b9853bfc9`（2026-10-14T16:56Z） |
| 生产主机上的旧镜像 ID | **UNKNOWN（待现场只读 `docker inspect` 记录）** |

### 本地镜像级验证（LOCAL，非生产、非真实数据）

- 容器：临时卷 `de-smoke-data`、回环端口 `127.0.0.1:18080`、**测试专用**环境变量（非生产密钥）。
- 结果：`build/local-image-smoke-phase1.log` **18/18 PASS**、`build/local-image-smoke-phase2.log` **4/4 PASS**。
- 覆盖：`/healthz`；`POST /internal/v1/device-status`（x-ingest-key）202；`/api/v1/auth/app` 登录；
  D `POST/GET .../dispositions`（201 / 幂等 200 / 冲突 409 / 返回 `outcomeLabel`）；D `GET /api/v1/safety-logs`；
  E `GET /api/v1/activity/report?scope=day|week|month`（返回 coverage/trend/insufficient 等字段，数据不足时如实显示“活动数据不足”）；
  `docker restart` 后 D 的处置记录与安全日志**仍在**；`/data/backend-state.json` `schemaVersion=6`、`activity-state.json` `version=1`。
- 数据留档：`build/smoke-data/`（合成测试数据，非生产）。
- 已清理临时容器与卷（不遗留运行时资源）。

> 结论：**镜像本身可用**（D/E 功能与重启持久化在本地容器内通过）。这不等于“已部署”，也不等于“真实数据验收”。

## 2. 监护人 APP（D/E-only，unsigned 已安装）

| 项 | 值 |
|---|---|
| 构建源 | 归档副本 `_work/app-build/d-e-only`（隔离副本，未改工作区） |
| 归档组合内容 | D+E+CAMERA-A；本次已**剥离 CAMERA-A 证据图片链路** |
| bundle | `com.example.program_04`（不变） |
| D/E-only unsigned HAP | `app/guardian-d-e-only-2026-10-26-unsigned.hap`，2,552,182 B，SHA-256 `95A7D01A8013C3747F84D0691B7B8DE726F57EE0971CC28ADD28622AD2CD08A4` |
| 版本 | versionCode **1000001** / versionName **1.0.1**（安装前 1000000/1.0.0） |
| 签名 | **无**（与已安装包一致：该包 `appSignType=none`，从未签名；未新建证书/未更换身份）— 依据 `baseline/SIGNING-IDENTITY.md`、`baseline/APP-SIGNING-DECISION.md` |
| 安装结果 | ✅ **已安装**（`hdc install -r`，unsigned 覆盖）：`firstInstallTime` 不变、`appSignType=none` 不变、uid 不变；见 `acceptance/APP-UPDATE-RECORD.md` |

## 3. 最终状态（2026-10-27 00:45）

| 项 | 状态 | 说明 |
|---|---|---|
| 公网后端 D/E 部署 | ✅ **已部署** | 生产容器 `eldercare-cloud-backend:de-2026-10-26` = `sha256:568b6193…b42f74`；schema v5→**v6**；`HEALTH=healthy`、公网 200；Caddy 未动 |
| 维护窗口 | ✅ 已执行 | 00:12 停服备份 → 00:20 切换 → 00:21 健康；备份 `backend-data-20261027-001232.tgz`（`027d27e6…`） |
| 生产数据备份校验 | ✅ 通过 | tar 可读非空、sha256 记录、mode 600；升级前 pre-schema 与 `ACTIVITY_FILE_ABSENT` 已留档 |
| 生产旧镜像取回 | ✅ 完成 | `eldercare-cloud-backend:pre-d-e-20261026`（`sha256:85e94047…`）+ tgz（`d9cc0d58…`） |
| APP 更新 | ✅ **已安装** | 1.0.1/1000001，覆盖安装、数据保留、身份未变 |
| D 真实告警处置验收 | ✅ **通过** | 真实告警 `e-1793032029-1` + 用户 2 条处置；前端/后端/顺序/重启一致；详见 `acceptance/D-ACCEPTANCE.md` |
| E 真实数据验收 | ✅ **通过** | 日/周/月三窗口（截图 04/05/06）；覆盖不足如实显示“无数据”，不伪造；详见 `acceptance/E-ACCEPTANCE.md` |
| 回滚预案 | ✅ 就绪（未使用） | 旧镜像 tag + tgz + 升级前数据 tgz + pin 覆盖文件；回滚会丢失升级后处置/安全日志（已记录） |
| DAYU/门磁/CAMERA-A | ✅ 不在本次范围 | 未发布；工作区门磁 v7 未被使用/覆盖 |
| 待补（非阻塞） | 1 项 | 重启后 APP 安全日志页的刷新截图未再采集（后端已直接验证记录不变） |

## 4. 证据与校验

- 本目录 `SHA256SUMS.txt`：**46 个文件全部自校验通过**（含 61 MB 镜像 tar、HAP、截图、文档）。
- 生产主机证据留在 `/opt/eldercare/evidence-of-deploy/`（旧镜像 ID、pre/post schema、up 日志、重启前后 dump、persist 判定）；服务器备份（旧镜像 tgz、数据 tgz）含个人数据，未复制进交付包。
