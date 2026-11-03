# API 合同 — 健康科普评估（APP-API v1.3.0）

- 合同文件：`contracts/APP-API-v1.json`（机器可读，version `1.3.0`）、`contracts/APP-API-v1.md`
- 基础路径：`/api/v1`，时间单位：Unix 毫秒
- 鉴权：沿用既有 `POST /api/v1/auth/app` 登录得到的 **Bearer 会话**；无会话=401，身份不允许=403
- 服务端身份：健康资料归属由会话 `sub` 经独立域分离 HMAC 派生（`h1_` 前缀），**客户端不能指定身份**
- 本功能定位：**仅健康科普与生活方式建议**，不诊断、不开药、不给治疗方案、不替代医生

---

## 1. `GET /api/v1/health-profile`

请求：无 query 参数（任何 query → `400 {"error":"query parameters are not allowed"}`）。

响应 200：

```json
{ "profile": { "age": 72, "medicalHistory": "…", "updatedAt": 1790000000000 } }
```

无资料：`{ "profile": null }`。

字段白名单（只返回实际填写过的字段 + 服务端 `updatedAt`）：
`age, medicalHistory, medications, heightCm, weightKg, restingBloodPressure, fastingGlucose,
sleep{hours,difficulty,nightAwakenings}, diet{regular,taste,restrictions},
exercise{timesPerWeek,types}, smoking, alcohol, bowel, mood, vision, hearing, updatedAt`

## 2. `PUT /api/v1/health-profile`

请求体 = 上述 profile 对象（不含 `updatedAt`；客户端提供 `updatedAt` 视为未知字段 → 400）。

| 情况 | 状态码 | 响应 |
| --- | --- | --- |
| 成功 | 200 | `{"profile": <规范化后的 profile，含 updatedAt>}` |
| 字段校验失败 | 400 | `{"error":"invalid health profile","fields":["age must be an integer in [1, 130]"]}`（只含字段路径+规则短句，**不含原始值**） |
| 未知字段/身份字段 | 400 | `{"error":"invalid health profile","fields":["unknown field: idCard"]}`，且**不写入持久化** |
| 请求体 > 8 KiB | 413 | `{"error":"request body too large"}` |
| 未登录 | 401 | `{"error":"unauthorized"}` |
| 身份不允许 | 403 | `{"error":"forbidden"}` |
| 存储不可用 | 503 | `{"error":"storage unavailable"}` |

数值/长度约束见 `contracts/AI-HEALTH-ASSESSMENT-SPEC.md` §1（年龄 1–130、身高 50–250 cm、体重 20–300 kg、血压收缩 60–260/舒张 40–160 且收缩>舒张、空腹血糖 1.0–40.0 一位小数、文本 100–500 字等）。

## 3. `POST /api/v1/health-advice`

请求体二选一：

- `{}` 或空体 → 使用**服务端已保存**的 profile（推荐，APP 采用此路径）
- `{"profile": {…}}` → 使用该 profile（同一白名单校验，**不落盘**）
- 其它顶层字段（含任何身份字段）→ 400

成功 200：

```json
{
  "advice": {
    "summary": "当前情况科普小结",
    "diet": ["饮食建议"],
    "exerciseAndSleep": ["运动与作息建议"],
    "warningSigns": ["需要留意的预警信号"],
    "disclaimer": "本内容仅健康科普参考，不构成医疗诊断、治疗或用药建议；如有不适请及时就医。"
  },
  "generatedAt": 1790000000000,
  "model": "deepseek-chat"
}
```

失败语义（**任何失败都不返回建议字段，绝不伪造**）：

| 情况 | 状态码 | code |
| --- | --- | --- |
| 无资料（且未内联 profile） | 409 | `HEALTH_PROFILE_EMPTY` |
| 未配置 `DEEPSEEK_API_KEY` | 503 | `AI_NOT_CONFIGURED` |
| 上游超时（连接/响应/读取超时） | 504 | `AI_TIMEOUT` |
| 网络/非 2xx/空内容/非法 JSON/超长/红线词/结构异常 | 502 | `AI_UPSTREAM_ERROR` |
| 请求体非法 | 400 | —（`invalid health advice request`） |

`disclaimer` **由服务端强制覆盖**模型返回值；四段文本过红线词扫描（16 个，见 `PROMPT.md`），否定语境（如“请勿自行停药”）不算越界。

## 4. 兼容性

- 只新增接口/字段，既有 `/api/v1/**` 语义不变；`app-contract.test.js` 断言合同版本 1.3.0 与新接口。
- 主快照 `backend-state.json` **schema 不变（仍 v7）**；健康资料存独立文件 `/data/health-state.json`（version=1，0600，原子写）。
- APP 端忽略未知响应字段；失败按 `kind/status/code` 处理，不依赖服务端中文文案。
