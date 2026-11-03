# 监护人 APP API v1 接入合同

状态：**已冻结供队友接入**。合同版本 `1.3.0`：`1.1.0`（2026-10-26）新增告警处置结果与
安全日志接口，`1.2.0`（2026-10-26）新增 PIR 活动日/周/月报告接口，`1.3.0`（2026-10-27）
新增健康资料读写与 DeepSeek 健康科普建议接口；三次都只新增接口/字段，既有章节语义不变。
机器可读清单见 [`APP-API-v1.json`](./APP-API-v1.json)（已同步至 `1.3.0`）；
增量接口以本文档 4.1、4.2、5 节为准。健康资料的数据模型、校验与提示词以
[`AI-HEALTH-ASSESSMENT-SPEC.md`](./AI-HEALTH-ASSESSMENT-SPEC.md) 为唯一事实来源。

## 1. 基本约定

- 正式地址：`https://<PUBLIC_DOMAIN>`，不得在 APP 中使用 HTTP、内网 IP 或固定测试域名。
- 所有业务接口路径以 `/api/v1` 开头。
- JSON 使用 UTF-8；所有时间戳均为 **13 位 Unix 毫秒**。
- 登录之外的 APP 接口都发送 `Authorization: Bearer <sessionToken>`。
- 会话有效期两小时。收到 `401` 后清除本地会话并返回登录页；`403` 表示账号已被服务端停用。
- APP 必须忽略响应中未来新增的字段。v1 不删除字段、不改变字段含义；破坏性变更只能进入 `/api/v2`。
- `APP_GUARDIAN_PASSWORD` 由监护人输入，只能保存在系统安全存储，禁止写进源码、安装包、日志或截图。

## 2. APP 登录

`POST /api/v1/auth/app`

请求：

```json
{
  "guardianId": "family-guardian",
  "password": "用户输入的登录口令"
}
```

成功 `200`：

```json
{
  "sessionToken": "...",
  "tokenType": "Bearer",
  "expiresIn": 7200
}
```

错误语义：`401` 账号或口令错误；`429` 错误次数过多，并带 `Retry-After` 秒数；`503` APP 登录未配置。
客户端不得根据错误文案判断账号是否存在，也不得自动无限重试。

## 3. 首页和设备

| 方法与路径 | 成功响应 | 用途 |
| --- | --- | --- |
| `GET /api/v1/overview` | `{generatedAt, deviceCount, onlineCount, monitorOfflineCount, activeAlertCount, latestAlert, location}` | 首页统计 |
| `GET /api/v1/rooms` | `{rooms: Room[]}` | 房间分组 |
| `GET /api/v1/devices` | `{devices: Device[]}` | 设备列表 |
| `GET /api/v1/location` | `{locations: Location[]}` | 4G/GPS 定位记录 |
| `GET /api/v1/contacts` | `{contacts: Contact[]}` | 紧急联系人和点击拨号 |

核心公开字段：

```text
Room   = id, name, location, state, onlineDeviceCount, deviceCount, devices[]
Device = id, deviceId, name, roomId, roomName, location,
         online, monitorOnline, state, lastSeenTs, sensors, csq
Location = deviceId, location, latitude, longitude, fixTime
```

`sensors` 会随硬件增加字段，APP 应按已识别字段展示，并忽略未知字段。`monitorOnline=0` 表示监测进程异常，
不能因为 `online=true` 就把它显示为完全正常。

## 4. 告警、图片和确认闭环

`GET /api/v1/alerts` 返回 `{alerts: Alert[]}`。核心字段：

```text
id/alarmId, deviceId, roomName, type, message, state,
ackPending, createdAt, acknowledgedAt, acknowledgedBy,
evidence: {available:false} 或 {available:true,evidenceId,bytes,capturedAt}
```

图片只允许经过 Bearer 会话读取：

- 元数据：`GET /api/v1/alerts/{alarmId}/evidence`
- JPEG：`GET /api/v1/alerts/{alarmId}/evidence/content`

图片响应是 `image/jpeg` 且 `Cache-Control: private, no-store`。不要把 token 放在 URL 查询参数里；APP 图片组件如果不能加请求头，
应先用带 Bearer 的网络请求下载到应用私有临时文件再显示。

确认告警：

```http
POST /api/v1/alerts/{alarmId}/ack
Authorization: Bearer <sessionToken>
Content-Type: application/json

{"note":"已电话确认，老人安全"}
```

服务器返回 `202` 和 `{accepted:true,status:"PENDING",commandId:"..."}`，只表示命令已入队，**不表示设备已经确认**。
APP 应继续刷新告警，直到状态真正变为 `ACKED`；设备失败或超时时仍保持真实状态，不能在本地先改成 ACKED。

## 4.1 告警处置结果与安全日志（v1 增量，2026-10-26）

> 合同版本 **1.1.0**。本节只**新增**接口，不改变第 4 节既有 ACK 语义。
> 处置结果 ≠ 告警确认：登记处置**不会**生成 ACK 命令、**不会**把告警改成 `ACKED`、
> **不会**清 `ackPending`、**不会**触发设备 ACK/reset。这样家属可以先记录“已联系家属/社区、
> 现场确认正常、误报、其他说明”，设备侧的 ACK 闭环仍独立进行。
> 告警处于 `ALARM`（含 `ackPending=true`）或 `ACKED` 时都允许登记处置结果。

### 4.1.1 登记处置结果

```http
POST /api/v1/alerts/{alarmId}/dispositions
Authorization: Bearer <sessionToken>
Content-Type: application/json

{"clientDispositionId":"disp-1730000000000-a1b2","outcome":"CONTACTED_FAMILY","note":"已联系家属，老人安全"}
```

请求体字段白名单只有 `clientDispositionId`、`outcome`、`note`；
出现其他字段（含 `alarmId`、`deviceId`、`operator`、`serverTime`、`openid`、`ownerRef`、`household`）一律 `400`。
校验规则：

- `alarmId`：URL 解码后匹配 `^[A-Za-z0-9._:-]{1,80}$`，否则 `400`；格式合法但未知返回 `404`。
- `clientDispositionId`：8–64 位 `[A-Za-z0-9._-]` 且不含 `..`（与留言客户端 ID 同规则）。
- `outcome`：只能是下表的五个值之一。
- `note`：可选字符串；去掉首尾空白并把 `\r`/`\n` 归一为**一个**空格后长度 0–200 字符；
  拒绝 C0/DEL/C1 控制字符；`outcome=OTHER` 时 `note` 必须非空。
- 客户端不得提交时间与身份：`serverTime` 一律服务端 `Date.now()`，操作者只保存通用角色。
- 请求体上限 8 KiB；超限按 `400` 处理。

| outcome | 展示文案 |
| --- | --- |
| `CONTACTED_FAMILY` | 已联系家属 |
| `CONTACTED_COMMUNITY` | 已联系社区 |
| `ON_SITE_CONFIRMED_NORMAL` | 现场确认正常 |
| `FALSE_ALARM` | 误报 |
| `OTHER` | 其他说明 |

响应：

- 首次登记 `201`：`{"created":true,"disposition":<PublicDisposition>}`
- 同一 `alarmId + clientDispositionId` 且内容相同（网络重试）：`200`，
  `{"created":false,"duplicate":true,"disposition":<PublicDisposition>}`
- 同一 `alarmId + clientDispositionId` 但 `outcome`/`note` 不同：`409`，
  `{"error":"clientDispositionId payload conflict"}`（不覆盖既有记录）
- 未知告警 `404`：`{"error":"alarm not found"}`
- 校验失败 `400`：`{"error":"invalid disposition"}` 或 `{"error":"invalid alarm id"}`
- `401/403` 沿用既有会话鉴权；`503` 表示存储不可用（`{"error":"storage unavailable"}`）

`PublicDisposition`（只暴露以下字段，APP 必须忽略未来新增字段）：

```json
{
  "dispositionId": "dsp-1",
  "alarmId": "alarm-a1",
  "deviceId": "esp32-kitchen",
  "roomName": "厨房",
  "alarmType": "SOS",
  "alarmCreatedAt": 1792949000000,
  "outcome": "CONTACTED_FAMILY",
  "outcomeLabel": "已联系家属",
  "note": "已联系家属，老人安全",
  "operator": "家庭监护人",
  "operatorRole": "household-guardian",
  "serverTime": 1792949100000
}
```

`dispositionId` 形如 `dsp-<正整数>`，由服务端持久化单调分配，重启不复用；
`operator`/`operatorRole` 由服务端给出（单户部署下的通用监护人角色，绝不是 openid）；
`serverTime=0` 或 `alarmCreatedAt=0` 不得显示为有效时间。

### 4.1.2 单条告警的处置记录

```http
GET /api/v1/alerts/{alarmId}/dispositions
Authorization: Bearer <sessionToken>
```

- `200`：`{"alarmId":"...","dispositions":[<PublicDisposition>...]}`
- 排序：`serverTime` 降序；同一时刻按 `dispositionId` 数值降序
- 无记录时返回空数组（不伪造数据）；未知告警返回 `404`

### 4.1.3 安全日志历史

```http
GET /api/v1/safety-logs?limit=50[&alarmId=...]
Authorization: Bearer <sessionToken>
```

- `limit`：1–200，默认 50；非法值回退默认 50
- 可选 `alarmId` 过滤；给了未知 `alarmId` 返回 `404`
- `200`：`{"logs":[<PublicDisposition>...]}`，排序同 4.1.2
- 该列表来自**持久化台账**，后端重启后仍可查询；不是由当前 `alerts` 现场推导

APP 行为要求（详细验收见实施合同 §4）：告警详情页把既有 ACK 面板与“处置结果”面板
**分开展示**；提交中禁止重复提交；失败（网络/超时/5xx）不得显示“已保存”，保留用户输入；
演示模式不提交真实处置；安全日志页加载失败显示真实错误，不回退到演示数据。

## 4.2 PIR 活动日/周/月报告（v1 增量，2026-10-26）

> 合同版本 **1.2.0**。只新增一个只读查询接口，不改变第 3、4 节任何既有响应字段。
> 数据来源只有设备状态摄入里的 `sensors.motion.countToday`（当日累计 PIR 触发次数）。

```http
GET /api/v1/activity/report?scope=day|week|month[&date=YYYY-MM-DD]
Authorization: Bearer <sessionToken>
```

- `scope` 缺省 `day`；除 `day|week|month` 之外的值 → `400 {"error":"invalid scope"}`。
- `date` 缺省为家庭时区的今天；非 `YYYY-MM-DD` 或非法日历日期（如 `2026-02-30`）→
  `400 {"error":"invalid date"}`。
- 家庭时区来自 `HOUSEHOLD_TIMEZONE`（默认 `Asia/Shanghai`），切日/切小时只用该时区，
  不使用服务器本地时区或 UTC；配置非法时后端**拒绝启动**，不会静默退化为本地时区。
- 活动存储未配置时 `503 {"error":"activity report unavailable"}`（绝不返回伪造数据）。
- 鉴权与 `/api/v1/devices` 相同（Bearer；`401/403` 沿用既有语义）。

### 4.2.1 统计窗口（必须与页面、文档一致）

| scope | 实际窗口 | `range` |
| --- | --- | --- |
| `day` | 选中日期在家庭时区的 `00:00–24:00` | `from = to = selectedDate`，`days = 1` |
| `week` | **截至选中日、向前滚动 7 天**（不是周一起的自然周） | `from = selectedDate-6`，`to = selectedDate`，`days = 7` |
| `month` | **截至选中日、向前滚动 30 天**（不是自然月，也不固定为 1 号起） | `from = selectedDate-29`，`to = selectedDate`，`days = 30` |

`previous` 是**紧邻所选窗口之前的一个等长窗口**：`day` 为前一日，`week` 为前 7 天，
`month` 为前 30 天；`previous.date` 是上一窗口的**结束日**。APP 文案必须写
“前一日 / 上一周期 / 截至 X”，不得把滚动窗口写成“本周/本月”。

**`days[]` 与 `range` 是两个不同的概念，不得混用**：

| 字段 | 含义 | day | week | month |
| --- | --- | --- | --- | --- |
| `range` / `summary` / `hourly` | **所选统计窗口** | 1 天 | 7 天 | 30 天 |
| `days[]` | **趋势序列**（页面“近 7 日趋势”用） | 7 项 | 7 项 | 30 项 |

`days[]` 恒为截至 `selectedDate` 的一段连续日期；`day` 范围虽然只要当天汇总，
但仍返回 7 天趋势序列供页面画图，`range.days` 与 `days.length` 因此可以不同。

### 4.2.2 响应字段（`200`）

```text
generatedAt      number   服务端生成时刻（毫秒）
timezone         string   家庭时区，例如 "Asia/Shanghai"
scope            string   day | week | month
today            string   家庭时区的今天（YYYY-MM-DD）
selectedDate     string   本次统计窗口的结束日（day 即选中日）
range            {from, to, days}   所选统计窗口（见 4.2.1）
dataSince        number   首个有效 PIR 样本的到达时刻（毫秒）；0 表示还没有任何活动数据
historyNote      string   历史起始说明；没有数据时说明不会用 0 填充
selected         DayView  选中窗口的聚合（day = 当天，week/month = 整段窗口）
previous         {date, count:number|null, status}
comparison       {state, delta:number|null, pct:number|null, text}
days             DayTrend[]  趋势序列（day/week 7 项、month 30 项；见 4.2.1）
summary          {total:number|null, days, daysWithData, coverageRatio:number|null, coverageText}
                 total/days/daysWithData/coverageRatio 均针对 range（所选统计窗口）
hourly           (number|null)[24]  选中窗口按家庭时区小时聚合，24 项定长
devices          [{deviceId, room, hasMotionSensor:boolean, count:number|null, status}]
trend            {state, text, note}
disclaimer       string

DayView  = {date, count:number|null, status, samples, invalidSamples,
            firstTs, lastTs, maxGapMs, coverageRatio:number|null, hourly:(number|null)[24]}
DayTrend = {date, count:number|null, status, coverageRatio:number|null}
```

`status` 取值：`no_data`（没有任何样本）、`insufficient`（样本 <2 或覆盖率 <10%）、
`partial`（覆盖率 10%–50%）、`ok`（覆盖率 ≥50%）。`coverageRatio` 为 `0..1` 或 `null`
（窗口不可观测时为 `null`，不是 0）。

**`dataSince` 只有一个字段、类型是 number（epoch 毫秒）**；服务端**不返回**
`dataSinceMs` / `dataSinceText`。APP 可以从 `dataSince` 本地派生展示文本，
但不得把派生字段当成服务端字段；也不得对 `dataSince=0` 显示 1970 年或“有效起始时间”。

### 4.2.3 数据语义（不得越界宣传）

- **null ≠ 0**：没有样本的日期/小时/设备一律为 `null`，页面显示“无数据”，不得补成 `0 次`。
  `count = 0` 只表示“在该窗口内有采样，但没有观测到新的 PIR 触发”。
- 计数只来自 `countToday` 的**正增量**：同一累计值重复上报不重复计数；设备重启或计数器回退
  按 reset 处理（`delta` 取本次观测值，不产生负数，并记录 `resets`）；首次观测只建立基线，
  不倒填历史。
- 相邻样本间隔 >120 s 的部分不计入覆盖率：长断连只会让 `coverageRatio` 变低、`status` 降级，
  不会被补成“0 次活动”或“一切正常”。
- **覆盖率口径**：`coverageRatio` = 当天观测到的有效采样间隔之和 ÷ **该自然日 00:00 到统计时刻**
  的时长。**刻意不按 `dataSince` 裁剪窗口**——否则功能刚启用时几十毫秒的观测也能算出接近
  100% 的覆盖率，把“当天几乎没有观测”伪装成“数据充分”。历史起点只由 `dataSince` /
  `historyNote` 表达，不用覆盖率代替。
- `hasMotionSensor = true` 只表示**观测到过** `motion` 字段；`false` 只表示**未观测到**，
  可能是该房间没有 PIR、设备未接入或统计窗口内无样本。UI 不得据此断言“未配置传感器”。
- 活动历史最多保留每设备 400 个日桶；**不足 3 个有数据日或覆盖率不足时不给趋势**，
  不足历史不伪造。
- PIR 计数只表示**传感器触发次数**，不表示人数、步数、精确轨迹或医学诊断；无数据不等于无人、
  不等于没有活动。`disclaimer` 必须随响应原样展示。

### 4.2.4 持久化与失败边界（部署须知）

- 活动统计写在**独立状态文件**（默认与 `BACKEND_DATA_FILE` 同目录的 `activity-state.json`，
  可用 `BACKEND_ACTIVITY_FILE` 覆盖），自带 `version = 1`，**不进入**主快照 `schemaVersion`
  （D 类为 v6）。两者互不绑定，回滚/备份必须**分别处理**。
- 活动文件损坏或结构非法时后端 **fail-closed 拒绝启动**，不会静默清空历史；运维需先把该文件
  移走并留档，再重启（此时活动历史从零开始）。
- 活动写入失败**不会改变设备状态摄入的既有 `202` 语义**（主链路保持可用），后端只打印
  `[backend] ACTIVITY_RECORD_FAILED code=...`；因此**自然的 202 不能证明活动统计已成功落盘**。
- 家庭账号权限沿用单户部署语义（合法 Bearer 会话）；不提供多家庭/多监护人身份区分。

## 5. 健康资料与健康科普建议（v1 增量，2026-10-27）

> 合同版本 **1.3.0**。只**新增**三个接口，不改变第 3、4、6 节任何既有响应字段。
> **定性**：本功能只提供健康科普与生活方式建议，**禁止诊断疾病、禁止开药、禁止给出具体治疗方案**，
> 不能替代医生。任何 AI 失败都明确失败（`502/503/504`），**绝不返回伪造建议**。
> 数据模型/校验规则/提示词以 [`AI-HEALTH-ASSESSMENT-SPEC.md`](./AI-HEALTH-ASSESSMENT-SPEC.md) 为准。

鉴权与其它 `/api/v1` 接口相同（Bearer 会话，`401/403` 沿用既有语义）。
三个接口都**不接受任何 query 参数**：出现 query → `400 {"error":"query parameters are not allowed"}`；
请求体上限 8 KiB（超限 `413`）。

### 5.1 读取健康资料

```http
GET /api/v1/health-profile
Authorization: Bearer <sessionToken>
```

- 有资料 `200`：`{"profile": <HealthProfile>}`
- 无资料 `200`：`{"profile": null}`（不是空对象，也不是演示数据）
- 健康存储未配置 `503`：`{"error":"storage unavailable"}`

`HealthProfile` 字段（服务端权威白名单）：

```jsonc
{
  "age": 72,                        // integer 1..130
  "medicalHistory": "高血压",        // string 1..500
  "medications": "氨氯地平",         // string 1..500
  "heightCm": 165,                  // number 50..250，最多 1 位小数
  "weightKg": 62,                   // number 20..300，最多 1 位小数
  "restingBloodPressure": "135/82", // 收缩压 60..260 / 舒张压 40..160，且收缩压 > 舒张压
  "fastingGlucose": "6.1",          // 十进制字符串 1.0..40.0，最多 1 位小数
  "sleep": { "hours": 7, "difficulty": false, "nightAwakenings": 1 },
  "diet": { "regular": true, "taste": "light", "restrictions": "少油" },
  "exercise": { "timesPerWeek": 4, "types": "散步、太极" },
  "smoking": "不吸烟", "alcohol": "偶尔", "bowel": "正常", "mood": "平稳",
  "vision": "尚可", "hearing": "需大声",
  "updatedAt": 1790000000000       // 服务端写入，客户端提供即 400
}
```

- `sleep`/`diet`/`exercise` 是**固定一层**嵌套，对象内至少 1 个字段；`diet.taste` 取值见合同 JSON `enums.healthTaste`。
- 字符串先 trim；trim 后为空视为"未填写"，**不会**写成 `""`；`null`/缺失 = 未填写，
  而数值 `0`/布尔 `false` 是真实值，二者语义必须区分。
- 服务端**从不保存**身份证号、手机号、精确住址、SIM ICCID、Wi-Fi 密码、token、API Key；
  出现任何白名单外字段（含身份类字段，如 `idCard`/`phone`）返回 `400`，且**绝不落盘**。

### 5.2 保存健康资料

```http
PUT /api/v1/health-profile
Authorization: Bearer <sessionToken>
Content-Type: application/json

{"age":72,"medicalHistory":"高血压","restingBloodPressure":"135/82"}
```

- 成功 `200`：`{"profile": <HealthProfile>}`（落盘后的规范化结果，含服务端 `updatedAt`）
- 校验失败 `400`：`{"error":"invalid health profile","fields":["age must be an integer in [1, 130]"]}`
  （`fields` 只含字段路径与规则短句，**不含原始值**）
- 请求体超限 `413`：`{"error":"request body too large"}`
- 写盘失败 `503`：`{"error":"storage unavailable"}`（本次保存不生效，不会出现"假成功"）

### 5.3 生成健康科普建议

```http
POST /api/v1/health-advice
Authorization: Bearer <sessionToken>
Content-Type: application/json
```

请求体二选一：

- `{}` 或空体：使用服务端**已保存**的资料；
- `{"profile": {...}}`：使用该资料（同样完整白名单校验，但**不落盘**）。

出现 `profile` 之外的任何顶层字段 → `400 {"error":"invalid health advice request","fields":["unknown field: ..."]}`。

成功 `200`：

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

`disclaimer` 由**服务端强制固定**，APP 必须原样展示，不得替换为模型返回值。

| 状态 | 响应 | 含义 |
| --- | --- | --- |
| `200` | 见上 | 生成成功（四段建议 + 固定免责声明） |
| `400` | `{"error":"invalid health profile","fields":[...]}` / `{"error":"invalid health advice request",...}` | 内联资料非法或请求体出现未知顶层字段 |
| `409` | `{"error":"health profile is empty","code":"HEALTH_PROFILE_EMPTY"}` | `{}` 请求但服务端没有已保存资料 |
| `413` | `{"error":"request body too large"}` | 请求体 > 8 KiB |
| `502` | `{"error":"ai service failed","code":"AI_UPSTREAM_ERROR"}` | AI 网络/非 2xx/空内容/非法 JSON/超长/红线词 |
| `503` | `{"error":"ai service unavailable","code":"AI_NOT_CONFIGURED"}` | 服务端未配置 `DEEPSEEK_API_KEY`（功能关闭） |
| `503` | `{"error":"storage unavailable"}` | 健康存储未配置或读取失败 |
| `504` | `{"error":"ai service timeout","code":"AI_TIMEOUT"}` | AI 超时（已按配置最多重试 1 次） |

**任何失败都不得在 APP 端伪造建议**：`502/504` 显示"暂时无法生成建议，请稍后重试"，
`409` 显示"还没有健康资料，请先填写并保存"，`503 AI_NOT_CONFIGURED` 显示"健康建议服务暂未开放"。

失败边界与运维须知：

- 健康资料写入**独立状态文件**（默认与 `BACKEND_DATA_FILE` 同目录的 `health-state.json`，
  可用 `HEALTH_DATA_FILE` 覆盖），自带 `version = 1`，**不进入**主快照 `schemaVersion`；
  文件损坏或结构非法时后端 **fail-closed 拒绝启动**，不会静默清空资料，备份/回滚必须与主快照分开。
- 健康资料用**独立域分离的 `h1_` HMAC ownerRef** 分键（与交流台账的 `r1_` 不同域），
  快照里绝不出现 openid/sub；不同身份的资料互相隔离。
- 建议允许**内存短期缓存**（key = ownerRef + 资料哈希，默认 TTL 300000 ms、容量 64），
  **不落盘、不保存 AI 原始响应**；缓存命中仍会重新强制固定 disclaimer。
- `DEEPSEEK_API_KEY` 只存在于服务端环境变量/Secret，绝不进入 APP、响应、日志或快照；
  启动时只打印 `[backend] HEALTH_ADVICE configured=true|false` 布尔。

## 6. 远程留言

创建：`POST /api/v1/communications/messages`

```json
{
  "clientMessageId": "app-1730000000000-a1b2",
  "deviceId": "dayu200-living",
  "text": "我晚一点回家，请注意休息",
  "voiceId": "FAMILY_MESSAGE",
  "requestAck": true
}
```

- `clientMessageId` 由 APP 生成，8-64 位 `[A-Za-z0-9._-]`；网络重试必须复用同一个值。
- 相同 ID 和相同内容重试返回已有消息；相同 ID 改内容返回 `409`。
- `voiceId` 只能取合同 JSON 中的五个值。
- `text` 为 1-120 字符，不得携带 URL、路径、密钥、手机号或精确坐标。

查询：

- `GET /api/v1/communications/messages?limit=20`
- `GET /api/v1/communications/messages/{messageId}`

状态顺序为 `QUEUED -> DELIVERED -> PLAYED -> ACKED`，旁路终态为 `FAILED`、`EXPIRED`。
`DELIVERED` 仅表示 DAYU 已领取；只有 `PLAYED` 才表示设备完成播放；`ACKED` 表示老人已确认。

## 7. 统一错误处理

JSON 错误格式通常为 `{"error":"..."}`。APP 按 HTTP 状态处理，不能依赖中文或英文错误文案：

| 状态 | APP 行为 |
| --- | --- |
| `400` | 输入有误，停止自动重试并提示用户修改 |
| `401` | 会话失效或登录失败；业务接口返回 401 时退出登录 |
| `403` | 账号被服务端停用，停止访问 |
| `404` | 对象不存在或不属于当前监护人 |
| `409` | 幂等内容冲突或设备状态迁移冲突 |
| `413` | 上传体过大（设备侧） |
| `429` | 等待 `Retry-After` 后才允许再次登录 |
| `502` | 上游 AI 失败（仅健康建议接口）；提示"暂时无法生成建议"并允许手动重试，不得伪造建议 |
| `504` | 上游 AI 超时（仅健康建议接口）；提示"暂时无法生成建议"并允许手动重试 |
| `500/503` | 保留用户操作，指数退避重试；不得显示为业务成功 |

## 8. 当前验收边界

本合同对应后端源码和自动化测试已经通过。公网域名 `api.luxunacc.xyz`、公共 TLS、真实云主机、
防火墙、监护人登录及主要查询接口已于 2026-10-15 完成公网验收。队友 APP 真机接入、手机推送、
告警确认到 DAYU200/ESP32 的当前实体闭环仍待联合验收；完成这些步骤前不能称为“公网 APP 实体闭环完成”。

**2026-10-26 增量（4.1 处置结果/安全日志、4.2 PIR 活动报告）的验收边界更窄**：只在本地源码、
本地/隔离测试进程、临时数据文件和 127.0.0.1 端口验证，并只做了本地 HAP 构建；**公网 backend
未升级、候选 HAP 未安装、未做任何真机或公网运行态验收**。因此这两个增量在部署并现场验收前，
只能记为“本地实现与本地验证通过”。

**2026-10-27 增量（5 健康资料与健康科普建议）的验收边界同样更窄**：只在本地源码、
`node --test --test-isolation=none`（注入 fake fetch，**不访问真实 DeepSeek**）、临时数据文件与
127.0.0.1 端口验证；**未配置任何真实 `DEEPSEEK_API_KEY`，未调用真实 DeepSeek，未做真机/公网
运行态验收**。因此 `AI_HEALTH_REAL_PASS` 未标记，只能记为“本地实现与本地验证通过（真实 AI 调用 BLOCKED）”。
