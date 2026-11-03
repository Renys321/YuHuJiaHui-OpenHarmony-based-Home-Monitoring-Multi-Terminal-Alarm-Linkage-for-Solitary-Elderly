# Mock 响应测试（注入式，不访问真实网络）

> 说明：后端单元测试中的 DeepSeek 上游全部为**注入 fake fetch**（SIMULATED），用于验证失败语义与结构校验；
> 真实 DeepSeek 调用证据见 `real-api/`（与本节严格区分）。

## 覆盖矩阵（`test/deepseek-client.test.js`，15 项）

| 场景 | 注入响应 | 期望 | 断言结果 |
| --- | --- | --- | --- |
| 正常 JSON（含 ```json 围栏） | `contentResponse(fenced)` | 200 建议 + 固定 disclaimer | PASS |
| 仅 `response.json()` 回退路径 | 自定义对象 | 200 | PASS |
| 空内容 | `content: "   "` | 502 `AI_UPSTREAM_ERROR`，不重试，无 advice | PASS |
| 缺 choices | `{choices:[]}` | 502 | PASS |
| content 非字符串 | `content: 42` | 502 | PASS |
| 上游 payload 非法 JSON | `text()` 返回 `{oops` | 502 | PASS |
| content 非法 JSON | `这不是 JSON` | 502 | PASS |
| content 是数组 | `[]` | 502 | PASS |
| 超长 content | 20,001 字节 | 502（`too_large`） | PASS |
| 缺 summary | `summary: undefined` | 502 | PASS |
| diet 为空数组 | `[]` | 502 | PASS |
| diet 元素超 300 字 | 301 字 | 502 | PASS |
| diet 元素非字符串 | `[1]` | 502 | PASS |
| **超过 8 条** | 10 条 | **截断为 8 条后成功**（真实模型偶发多给 1–2 条） | PASS |
| 16 个红线词 × 4 段 | `前缀${term}后缀` | 每项均 502 | PASS |
| 否定语境安全文案 | “请勿自行停药或调整剂量”等 5 条 | 放行 | PASS |
| 跨分句否定 | “不要担心，建议服用…” | 命中 | PASS |
| 网络错误 | `ECONNREFUSED` | 502，最多重试 1 次，错误不含底层文本 | PASS |
| 超时（fetch 阶段） | `TimeoutError` | `AI_TIMEOUT`，最多重试 1 次 | PASS |
| **超时（读响应体阶段）** | `text()` 抛 `TimeoutError` | `AI_TIMEOUT`（→504） | PASS |
| 429/5xx | 各状态 | 重试恰好 1 次 | PASS |
| 4xx | 400/401/403/404/422 | 不重试，502 | PASS |
| 诊断回调 | 非法 JSON | 只回调 `{code,reason}`，不含上游文本/Key | PASS |
| 缓存 | TTL/容量/ownerRef+profileHash | 命中不重复请求；过期/淘汰正确 | PASS |

## 接口级注入（`test/health-advice-api.test.js`，19 项）

- 未配置 Key → 503 `AI_NOT_CONFIGURED`；
- 超时客户端 → 504 `AI_TIMEOUT`；
- 其他失败 → 502 `AI_UPSTREAM_ERROR`，响应无 `advice`；
- 抛异常的客户端被收敛为 502，且不影响其它路由；
- 内联 profile 失败**不会**回退到已保存 profile；
- 真实客户端（注入 fetch 返回合法 JSON）→ 200 + 强制 disclaimer，第二次命中缓存；
- 任何失败响应都不含上游文本/Key/资料。

## 数据与隐私注入（`test/health-profile-api.test.js` / `health-store.test.js`）

- 24 组非法标量（年龄/身高/体重/血压/血糖/睡眠等）→ 400，`fields` 只含字段路径+规则短句；
- 17 种身份字段变体（idCard/idNumber/phone/mobile/address/name/token/apiKey/password/iccid/wifiPassword/openid 及大写/下划线变体）→ 400，持久化文件字节不变；
- 未知嵌套字段 → 400；空对象/空字符串 → 400；
- >8 KiB → 413（读取前拒绝）；
- 写盘失败 → 503 + 内存回滚；损坏快照 → 启动 fail-closed；
- 快照内无 openid/token/身份字段。

## 与真实调用的分界

- 本节全部为 **SIMULATED**（注入响应），不代表上游真实行为；
- 真实调用（含真实超时、真实 JSON、真实“信息不足”、真实否定语境）见：
  - `real-api/e2e-run.json`（本地后端，真实 HTTPS 到 api.deepseek.com）
  - `real-api/docker-smoke-first.json` / `docker-smoke-restart.json`（生产同款镜像）
  - `real-api/rehearsal-advice.json`（生产同款 compose 经 Caddy HTTPS）
  - `real-api/advice-timeout.json`（真实网络超时 → 504）
