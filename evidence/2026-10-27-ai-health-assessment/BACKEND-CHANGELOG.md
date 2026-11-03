# 后端变更清单

基线：`competition/evidence/2026-10-27-door-v7-e2e/_work/backend-src`（= 已部署的生产 v7 源码）
发布源码：`_work/release-src`（v7 + 健康功能，**不含**未发布的 GPS 草稿）
验证：`npm run check` exit 0；`node --test --test-isolation=none` **377/377 PASS**

## 新增文件（4 源码 + 4 测试）

| 文件 | 大小 | SHA-256 | 职责 |
| --- | --- | --- | --- |
| `src/health-profile.js` | 20,989 | `5F98DAFB441A23FE3F286CE4268412C69D372C1F32503717F6E4DB3A25B08573` | 白名单校验/规范化、`h1_` 域分离 HMAC `healthOwnerRefFor`、profile 稳定哈希 |
| `src/health-store.js` | 9,884 | `5CED73113EAA126198AD784CC2C5C82944603859B8F3C37CD22671754DFFAB8D` | 独立 `health-state.json`（version=1，0600 原子写+fsync+rename，写失败回滚，启动严格校验） |
| `src/health-advice-prompt.js` | 7,896 | `F6BB61C6976FC054CAF970F869A4B4D1FD05F316B00767A26848A2CD1B487025` | 固定系统提示词 `health-advice-prompt-v1`、固定免责声明、16 红线词与否定语境扫描 |
| `src/deepseek-client.js` | 18,919 | `BCAB507721198B1BC6FFD94C163CB39DD89A47AF6DE816B9C0FCCC41C369B402` | 仅后端 HTTPS 调用 DeepSeek：超时/最多 1 次重试、响应结构/长度/红线校验、固定 disclaimer、内存短缓存、零敏感日志 |
| `test/health-profile-api.test.js` | — | `0E91841C…` | 16 项接口测试 |
| `test/health-advice-api.test.js` | — | `15F1CC51…` | 19 项接口测试（含失败语义/不伪造） |
| `test/deepseek-client.test.js` | — | `4A0F9268…` | 15 项客户端测试（含超时/非法 JSON/空内容/红线/缓存/Key 不泄漏） |
| `test/health-store.test.js` | — | `45C1E7EF…` | 10 项存储测试（原子写/回滚/损坏 fail-closed/重启持久） |

## 修改文件（5，均为增量）

| 文件 | v7 SHA-256 | 发布 SHA-256 | 变更 |
| --- | --- | --- | --- |
| `src/server.js` | `23B22406…` | `78B8C6EA…` | 仅在既有 Bearer 拦截之后新增 3 条路由 + 健康存储/客户端注入点；既有分支零改动 |
| `src/main.js` | `D40C4365…` | `A37C6B59…` | 装配 `HealthStore`/`DeepSeekClient`、`h1_` ownerRef 注入、`DEEPSEEK_*`/`HEALTH_*` 环境变量、启动 `configured=` 布尔与安全诊断 `onFailure` |
| `package.json` | `14C83552…` | `E9DA4776…` | `check` 脚本纳入 4 个新文件 |
| `.env.example` | `AC4866D7…` | `180895EF…` | 新增脱敏环境变量示例（不含真实值） |
| `test/app-contract.test.js` | `FA691759…` | `BED48E1B…` | 合同版本 1.3.0 + 3 个新接口断言 |

## 未修改（已核对）

`src/store.js`、`src/persistent-store.js`、`src/activity*.js`、`src/comms-core.js`、`src/notify-*.js`、
`src/evidence-store.js`、`src/auth.js`、`src/household-auth.js`、`Dockerfile`、`README.md`、`.dockerignore`
均与已部署 v7 逐字节一致（主快照 schema 保持 v7，无迁移）。

## 明确不包含（GPS 草稿隔离）

工作区 `src/server.js` / `src/store.js` / `src/persistent-store.js` 中**未发布**的 GPS 草稿
（`/api/v1/ingest/wearable/location`、`ingestWearableLocation`、`wearableLocationToken`、
`getWearableAlertLocation`、`WEARABLE_LOCATION_DEVICE_ID`）**未进入发布源码**：

```text
发布源码 grep 该组合符号 → 0 命中
```

工作区原文件未被覆盖（GPS 草稿保留在原处，仅不随本次发布）。

## 环境变量（服务端）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | 空=功能关闭 | 只读环境变量；空时 `/health-advice` 返回 503 `AI_NOT_CONFIGURED` |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | 必须 https，否则启动 fail-closed |
| `DEEPSEEK_MODEL` | `deepseek-chat` | `^[A-Za-z0-9._-]{1,64}$` |
| `DEEPSEEK_TIMEOUT_MS` | `12000` | 1000–15000 |
| `DEEPSEEK_MAX_RETRIES` | `1` | 0–1，仅网络/超时/429/5xx |
| `HEALTH_DATA_FILE` | `<数据目录>/health-state.json` | 独立文件 |
| `HEALTH_ADVICE_CACHE_TTL_MS` | `300000` | 0–3600000 |
| `HEALTH_ADVICE_CACHE_MAX` | `64` | 1–256 |

镜像构建/验证：`docker build` exit 0 → `eldercare-cloud-backend:health-2026-10-27`（242 MB，
image id `sha256:084ed3c3…`），本地容器 + 真实 DeepSeek 冒烟通过（见 `real-api/docker-advice.json`）。
