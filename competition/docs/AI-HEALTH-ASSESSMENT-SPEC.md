# 老人健康科普评估 · 冻结接口规格（Lead 基线）

> 版本：`ai-health-assessment-spec-v1`（2026-10-27）
> 本文件是后端与 APP **并行实现时的唯一接口事实来源**。任何偏离必须先改本文件并由 Lead 批准。
> 定性：本功能**只提供健康科普与生活方式建议**。禁止诊断疾病、禁止开药、禁止给出具体治疗方案，不能替代医生。

## 0. 现状基线（Lead 已实测）

| 项 | 现状 |
| --- | --- |
| 后端 | `competition/cloud/backend`，CommonJS，Node ≥20（本机 v24.19.0），`createApiServer(options)` 单文件路由 if 链 |
| 后端测试 | `npm test`（= `node --test`）；**沙箱内必须用 `node --test --test-isolation=none`**，否则子进程 `spawn EPERM`。基线 **313/313 PASS** |
| 持久化 | `PersistentStore`（主快照 schema v6，告警/命令/通知台账）+ `ActivityStore`（独立 `activity-state.json`，version=1）+ `EvidenceStore` |
| 鉴权 | `POST /api/v1/auth/app` → HMAC 会话 token；`Bearer`；`identity.sub`；统一 401/403 在 `server.js` 路由中段 |
| 单户模型 | `authorizeIdentity(sub)` + `ownerRefForIdentity(sub)`（`comms-core.ownerRefFor`，HMAC 域分离） |
| APP | `APP/ElderlyCareGuardian`，ArkTS `.ets` 页面 + `core/**/*.ts` 纯逻辑被 Node 测试直接编译执行 |
| APP 测试 | `tsc -p tests/tsconfig.json`（DevEco TS 4.9.5）→ `node --test --test-isolation=none`；基线 **300/300 PASS** |
| APP 网络 | 页面不得直连 `ApiClient`，必须经 `GuardianService`；base URL 固定 `https://api.luxunacc.xyz` |
| API 合同 | `competition/docs/APP-API-v1.json` / `.md` 当前 `1.2.0`，由 `test/app-contract.test.js` 校验 |

## 1. 数据模型（白名单，服务端权威）

`HealthProfile` 只允许下列字段；**出现任何其他字段（含任何一层嵌套）一律 400**，且错误信息不回显字段值：

```jsonc
{
  "age": 72,                       // integer 1..130
  "medicalHistory": "高血压",       // string 1..500
  "medications": "氨氯地平",        // string 1..500
  "heightCm": 165,                 // number 50..250，最多 1 位小数
  "weightKg": 62,                  // number 20..300，最多 1 位小数
  "restingBloodPressure": "135/82",// string 收缩压/舒张压：60..260 / 40..160，且收缩压 > 舒张压
  "fastingGlucose": "6.1",         // string 十进制 1.0..40.0，最多 1 位小数
  "sleep": {                       // 对象内至少 1 个字段
    "hours": 7,                    // number 0..24，最多 1 位小数
    "difficulty": false,           // boolean
    "nightAwakenings": 1           // integer 0..20
  },
  "diet": {                        // 对象内至少 1 个字段
    "regular": true,               // boolean
    "taste": "light",              // "light" | "normal" | "salty"
    "restrictions": "少油"          // string 1..200
  },
  "exercise": {                    // 对象内至少 1 个字段
    "timesPerWeek": 4,             // integer 0..21
    "types": "散步、太极"            // string 1..100
  },
  "smoking": "不吸烟",              // string 1..100
  "alcohol": "偶尔",                // string 1..100
  "bowel": "正常",                  // string 1..100
  "mood": "平稳",                   // string 1..200
  "vision": "尚可",                 // string 1..100
  "hearing": "需大声",              // string 1..100
  "updatedAt": 1790000000000       // integer 毫秒，**只能服务端写入**；客户端提供即 400
}
```

规则：

1. 字符串先 trim；trim 后为空 → 视为“未填写”，**不写入快照**（绝不写 `""`）。
2. 数值 `0` 是合法值（呼吸 0 次/周等），但 `null`/缺失 = 未填写；二者语义必须区分。
3. 空对象/空请求体 `{}` → 400 `invalid health profile`（至少 1 个字段）。
4. 身份类字段一律 400：`idCard`/`idNumber`/`phone`/`mobile`/`address`/`name`/`token`/`apiKey`/`password`/`iccid`/`wifiPassword`/`openid` 等（大小写与下划线变体都拒绝）。
5. 上限：请求体 ≤ 8 KiB（超限 413）；所有文本总字节 ≤ 4 KiB；嵌套深度固定 1 层。
6. 服务端从不保存身份证号、手机号、精确住址、SIM ICCID、Wi-Fi 密码、token、API Key。
7. 正在发生的急性症状不作为普通档案长期保存：`medicalHistory`/`medications` 等文本若命中急症词（胸痛、呼吸困难、昏迷、大出血、剧烈头痛、意识不清、抽搐、偏瘫、口角歪斜），服务端**照常校验**但 APP 必须前置提示“如为正在发生的急性症状请立即就医/拨打急救电话”，且该文本进入 AI 提示词时按“用户主诉”处理、AI 必须输出就医预警。**不新增急性症状专用存储**。
8. 存储键 = `healthOwnerRefFor(secret, identity.sub)` = `h1_` + base64url(HMAC-SHA256(secret, `eldercare-health-owner:v1\0` + sub))；快照内**绝不出现 sub/openid**。

## 2. 后端路由（全部沿用现有 Bearer 会话）

### 2.1 `GET /api/v1/health-profile`

- 无会话 → `401 {"error":"unauthorized"}`；身份不允许 → `403 {"error":"forbidden"}`。
- 不允许 query 参数（任何 query → `400 {"error":"query parameters are not allowed"}`）。
- 200 有资料：`{"profile": <HealthProfile>}`（仅白名单字段 + 服务端 `updatedAt`）。
- 200 无资料：`{"profile": null}`。

### 2.2 `PUT /api/v1/health-profile`

- 同上鉴权；不允许 query 参数。
- 请求体 = profile 对象（白名单见 §1）。
- 成功 200：`{"profile": <HealthProfile>}`（即落盘后的规范化结果，含 `updatedAt`）。
- 校验失败 400：`{"error":"invalid health profile","fields":["age must be an integer in [1, 130]"]}`（fields 只含字段路径与规则短句，**不含原始值**）。
- 未知字段 400，`fields: ["unknown field: idCard"]`；**未知字段绝不进入持久化文件**。
- 写盘失败 503 `{"error":"storage unavailable"}`。
- 日志：**禁止**打印请求体、profile 内容、身份或 token。失败最多打印 `[backend] HEALTH_PROFILE_SAVE_FAILED code=<CODE>`。

### 2.3 `POST /api/v1/health-advice`

- 同上鉴权；不允许 query 参数。
- 请求体二选一：
  - `{}` 或空体 → 使用**服务端已保存**的 profile；
  - `{"profile": {...}}` → 使用该 profile（同样完整白名单校验，不落盘）。
  - 出现其他顶层字段（尤其身份字段）→ 400。
- 无可用资料 → `409 {"error":"health profile is empty","code":"HEALTH_PROFILE_EMPTY"}`。
- AI 未配置（无 `DEEPSEEK_API_KEY`）→ `503 {"error":"ai service unavailable","code":"AI_NOT_CONFIGURED"}`。
- AI 超时 → `504 {"error":"ai service timeout","code":"AI_TIMEOUT"}`。
- AI 其他失败（网络/非 2xx/空内容/非法 JSON/超长/触发红线词）→ `502 {"error":"ai service failed","code":"AI_UPSTREAM_ERROR"}`。
- **任何失败都绝不返回伪造建议**。
- 成功 200：

```json
{
  "advice": {
    "summary": "……",
    "diet": ["……"],
    "exerciseAndSleep": ["……"],
    "warningSigns": ["……"],
    "disclaimer": "本内容仅健康科普参考，不构成医疗诊断、治疗或用药建议；如有不适请及时就医。"
  },
  "generatedAt": 1790000000000,
  "model": "deepseek-chat"
}
```

- `disclaimer` 由服务端**强制固定**，模型返回的 disclaimer 一律被覆盖。
- 允许内存短期缓存：key = `ownerRef + "\0" + sha256(profile)`，TTL 默认 300000ms、容量 64；**不落盘、不保存 AI 原始响应**；缓存命中仍需重新校验并强制 disclaimer。
- 响应头保持现有 `cache-control: no-store`。

## 3. DeepSeek 客户端（`src/deepseek-client.js`）

环境变量（全部服务端读取，**绝不进入源码/APP/响应/日志/快照**）：

| 变量 | 默认 | 约束 |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | 空=功能关闭 | 非空时 ≥ 20 字符；启动只打印布尔 `configured=true/false` |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | **必须 https**，否则启动 fail-closed |
| `DEEPSEEK_MODEL` | `deepseek-chat` | `^[A-Za-z0-9._-]{1,64}$` |
| `DEEPSEEK_TIMEOUT_MS` | `12000` | 1000..15000（单次尝试） |
| `DEEPSEEK_MAX_RETRIES` | `1` | 0..1；仅对网络错误/超时/5xx/429 重试 |
| `HEALTH_DATA_FILE` | `<BACKEND_DATA_FILE 同目录>/health-state.json` | 独立文件 |
| `HEALTH_ADVICE_CACHE_TTL_MS` | `300000` | 0..3600000 |
| `HEALTH_ADVICE_CACHE_MAX` | `64` | 1..256 |

请求：`POST {base}/chat/completions`，`content-type: application/json`，`authorization: Bearer <key>`，
body `{model, messages:[system,user], temperature:0.3, max_tokens:1200, stream:false, response_format:{type:"json_object"}}`，
`user` 消息 = `JSON.stringify(profile)`（只含白名单字段，无身份）。
`AbortSignal.timeout(timeoutMs)`；总预算 ≤ 2 次尝试 × timeout。
**只允许后端调用**；禁止把健康资料发往任何其他服务；endpoint 不可由客户端覆盖。

响应校验：

1. HTTP 2xx；
2. JSON 可解析，`choices[0].message.content` 为非空字符串；
3. 内容长度 ≤ 20000 字节；允许 ```json 围栏并剥离；
4. 解析为对象，字段固定：`summary`（string 1..2000）、`diet`/`exerciseAndSleep`/`warningSigns`（array 1..8，元素 string 1..300）；
5. 红线词扫描（仅以上四段文本）：`你患有`、`确诊为`、`诊断结果`、`建议服用`、`请服用`、`应服用`、`停止用药`、`停药`、`调整剂量`、`加大剂量`、`减少剂量`、`处方`、`治疗方案`、`病情等级`、`患病概率`、`治愈率` → 命中即 502；
6. 强制 `disclaimer` 为固定常量。

## 4. 固定系统提示词（`health-advice-prompt-v1`，客户端不可覆盖）

必须是**服务端唯一常量**，包含：角色“你是老年健康科普助手”、通俗/保守/可执行、8 条严格禁止（诊断/判断患病/开药或推荐药/改剂量频次停药/治疗方案/确定语气替代医生/编造缺失信息/把 0 空值未填写当正常）、急症只建议“请尽快联系家属、社区医护人员或正规医疗机构；如症状严重或突然发生，请立即拨打急救电话。”、固定 JSON 字段、资料不足必须写“信息不足”不得猜测。
测试必须静态断言该常量同时含：`不诊断`（或等价红线词）、`处方`、`治疗`、`信息不足`、`立即拨打急救电话`、`summary|diet|exerciseAndSleep|warningSigns|disclaimer`。

## 5. APP 变更（`APP/ElderlyCareGuardian`）

### 5.1 纯逻辑（`entry/src/main/ets/core/**/*.ts`，Node 测试可编译执行）

- `core/health/HealthModels.ts`
  - `HealthProfileDto` / `HealthAdviceDto` / `HealthAdviceSection`（纯数据类，字段默认空）。
  - `HealthFormState`：两页表单状态（全部字符串输入 + 布尔/枚举）；`toProfileBody()` 只输出**已填写**字段。
  - `validateHealthForm(state): HealthValidationResult`：与 §1 完全一致的年龄/身高/体重/血压/血糖/数值/长度校验；返回 `{ok, fields: [{field, message}], firstFocus}`；错误文案中文、无诊断措辞。
  - `HEALTH_DISCLAIMER_APP = '本功能仅提供健康科普参考，不构成医疗诊断或治疗建议。'`
  - `HEALTH_PRIVACY_NOTICE = '请勿填写身份证号、手机号、详细住址或其他不必要的身份信息。'`
  - `HEALTH_ADVICE_DISCLAIMER = '本内容仅健康科普参考，不构成医疗诊断、治疗或用药建议；如有不适请及时就医。'`（与后端一致）
  - 急症词检测 `ACUTE_SYMPTOM_PATTERN` + `hasAcuteSymptomText(text)`（仅用于页面提示，不改变提交行为）。
- `core/health/HealthAdvice.ts`
  - `parseHealthProfileResponse(text)` → `{ present, profile } | null`
  - `parseHealthAdviceResponse(text)` → `{ advice, generatedAt, model } | null`（缺字段/类型错/无免责声明 → null）
  - `healthAdviceMessage(kind/status)` → 中文 UI 文案：
    - 超时 `AI_TIMEOUT` → `暂时无法生成建议，请稍后重试`（必须出现“超时”语义可选）；
    - 空资料 409 → `还没有健康资料，请先填写并保存`;
    - 未配置 503 → `健康建议服务暂未开放`；
    - 其他失败 502/网络 → `暂时无法生成建议，请稍后重试`。
  - `HealthAdviceFlowState`：`idle | loading | ok | timeout | failed | empty`，禁止伪造建议。

### 5.2 网络与平台层

- `core/api/Contracts.ts`：新增上述解析所需 DTO（或 import `core/health`），保持“忽略未知字段、缺字段不崩”。
- `core/api/ApiClient.ts`：`getHealthProfile(token)`、`putHealthProfile(token, body)`、`generateHealthAdvice(token, profile|null)`；超时：GET/PUT 12000ms，AI 20000ms（> 后端 15s 上限）；不把 profile 写进任何日志。
- `service/GuardianService.ets`：`loadHealthProfile()`、`saveHealthProfile(body)`、`generateHealthAdvice()`；结果写入 AppStorage：`gv.healthProfile`、`gv.healthStatus`、`gv.healthMessage`、`gv.healthAdvice`、`gv.healthAdviceStatus`、`gv.healthAdviceMessage`；**login/logout/清除会话时必须清理这些键与内存缓存**（上一位老人资料不得残留）。
- 页面不得直连 ApiClient（既有 static-guard 约束）。

### 5.3 页面 `pages/HealthAssessmentPage.ets`（注册进 `main_pages.json`）

- 两步：第 1 页基础健康信息（年龄/既往病史/长期用药/身高/体重/静息血压/空腹血糖）；第 2 页生活习惯（睡眠时长/入睡困难/夜间醒来/饮食规律/口味/忌口/每周运动次数/运动类型/吸烟/饮酒/排便/情绪/视力/听力）。
- 顶部固定提示两条：隐私提示 + 免责声明。急症词命中时额外黄条提示立即就医。
- 按钮：`保存资料`、`生成健康建议`、`重新生成`、`修改资料`、`上一步/下一步`。
- 状态：首次加载中、空资料、生成中（loading 文案“正在生成健康科普建议…”）、网络失败、AI 超时、AI 不可用、成功。
- 结果面板 4 段：当前情况小结 / 饮食建议 / 运动与作息建议 / 需要留意的预警信号 + 固定免责声明。
- 入口：`ProfilePage` 新增“健康评估”入口（沿用现有卡片样式）→ `router.pushUrl({url:'pages/HealthAssessmentPage'})`。
- 禁止出现：`你患有`、`诊断结果`、`建议服用`、`停止用药`、`治疗方案`、`病情等级`、`患病概率`。
- 演示模式：不调用网络（fail-closed，提示需退出演示）。

## 6. 验收口径

- 本地：后端 `npm run check` + `node --test --test-isolation=none` 全绿；APP tsc + `node --test --test-isolation=none` 全绿；`assembleHap` 成功（若工具链可行）。
- 真实：`AI_HEALTH_REAL_PASS` 只在**用户提供有效 `DEEPSEEK_API_KEY`** 且**真机/模拟器显示建议**并**验证超时/失败**后才可标记；否则如实记 `BLOCKED`。
- 证据目录：`competition/evidence/2026-10-27-ai-health-assessment/`。
