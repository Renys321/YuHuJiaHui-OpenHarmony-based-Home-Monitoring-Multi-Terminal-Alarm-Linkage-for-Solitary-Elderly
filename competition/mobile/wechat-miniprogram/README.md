# 安心居家微信小程序

这是独居老人居家安全监测系统的原生微信小程序客户端。项目只使用 JavaScript、WXML、WXSS 和 JSON，不依赖 npm 包。

## 安全与数据边界

- 默认不启用演示模式，也没有预置后端地址。首次打开明确显示“云端未配置/未连接”，不会生成或伪造实时状态。
- 小程序只接受 `https://` 后端地址；拒绝 HTTP、URL 内嵌用户名密码、查询参数和片段。
- OneNET `access_key`、产品 token、设备密钥、Cookie 和网页登录凭据只能保存在可信服务端，禁止写入本目录。
- 客户端调用 `wx.login` 获取一次性 code，再由可信后端换取短会话 `sessionToken`。短会话仅保存在当前 JavaScript 运行期内存，401 后重新登录，不写入本地存储。
- 本地存储只保存后端基础地址和用户主动选择的演示模式开关。
- 演示模式在每个业务页面显示醒目的“演示数据”标识。演示告警不能提交 ACK，演示号码也明确提示不要实际拨打。

## 页面

| 页面 | 功能 |
|---|---|
| 总览 | 连接状态、房间/设备/告警摘要、最近告警、后端地址和演示开关 |
| 房间 | 房间状态、部署位置、设备数和在线数 |
| 告警 | 告警详情、家庭授权下载/预览跌倒现场图片、处置说明、真实云端 ACK |
| 设备 | 设备编号、房间、安装位置、在线状态和最后上报时间 |
| 联系人 | 联系人列表；仅在用户点击按钮后调用 `wx.makePhoneCall` |
| 远程交流 | 远程留言：选设备与预置语音、发送文字留言、查看播报与老人确认状态；失败可幂等重试 |

所有列表均处理加载、错误、未配置和空数据状态。下拉页面可重新请求云端。
「远程交流」页的近期留言只在用户点击「刷新」或下拉页面时加载，页面里没有任何轮询定时器；发送只在用户点击按钮时发生。

## 微信开发者工具导入

1. 打开微信开发者工具，选择“导入项目”。
2. 项目目录选择本目录 `mobile/wechat-miniprogram/`。
3. 首次本地预览可使用测试号；正式发布前在 `project.config.json` 或工具中填写正式 AppID。
4. 在微信公众平台“开发管理 -> 开发设置 -> 服务器域名”中，把可信后端域名加入 `request` 合法域名。域名必须支持有效 HTTPS 证书。
5. 在总览页输入后端 HTTPS 根地址并保存，例如 `https://eldercare.example.com`。不要带 `/api`、查询参数或任何凭据。
6. 未准备后端时，可由用户主动开启“本地演示数据”。页面上的数据会明确标为演示数据。

开发阶段不建议关闭微信开发者工具的“校验合法域名”来掩盖配置问题。生产环境必须保持域名校验。

## 后端契约

所有响应均使用 `Content-Type: application/json`，时间戳统一为 13 位 Unix 毫秒。除登录接口外，请求携带：

```http
Authorization: Bearer <short-lived-session-token>
```

### 微信登录

```http
POST /api/v1/auth/wechat
Content-Type: application/json

{"code":"wx.login 返回的一次性 code"}
```

成功响应：

```json
{
  "sessionToken": "长度至少为 16 的短会话令牌",
  "expiresIn": 3600
}
```

后端负责使用微信服务端凭据校验 code、绑定已授权用户并签发短会话。微信 AppSecret 和 OneNET 凭据不得返回客户端。

### 总览

```http
GET /api/v1/overview
```

```json
{
  "overview": {
    "generatedAt": 1791609000123,
    "residentName": "住户显示名"
  }
}
```

### 房间

```http
GET /api/v1/rooms
```

```json
{
  "rooms": [
    {
      "id": "living",
      "name": "客厅",
      "location": "一层东侧",
      "state": "NORMAL",
      "onlineDeviceCount": 1,
      "deviceCount": 1
    }
  ]
}
```

### 告警

```http
GET /api/v1/alerts
```

```json
{
  "alerts": [
    {
      "id": "alarm-001",
      "deviceId": "esp32-bath",
      "roomName": "卫生间",
      "type": "NO_MOTION",
      "message": "长时间未检测到活动",
      "state": "ALARM",
      "createdAt": 1791609000123,
      "acknowledgedAt": 0,
      "acknowledgedBy": "",
      "evidence": {
        "available": true,
        "evidenceId": "fall-1791609000123-7",
        "bytes": 123456,
        "capturedAt": 1791609000123
      }
    }
  ]
}
```

状态只使用 `NORMAL`、`WARN`、`ALARM`、`ACKED`、`OFFLINE`。客户端会把未知状态降级显示为 `OFFLINE`。
客户端不接受后端下发的任意图片 URL。用户点击“查看现场图片”后，客户端通过
`wx.downloadFile` 向固定的 `GET /api/v1/alerts/{alarmId}/evidence/content` 发送 Bearer 会话头，
取得微信临时文件后再调用 `wx.previewImage`；token 不进入 URL，401 最多重新认证并重试一次。

### 设备与位置

```http
GET /api/v1/devices
GET /api/v1/location
```

```json
{
  "devices": [
    {
      "id": "esp32-bath",
      "name": "卫生间节点",
      "roomId": "bath",
      "roomName": "卫生间",
      "online": true,
      "state": "NORMAL",
      "lastSeenTs": 1791609000123,
      "sensors": {}
    }
  ]
}
```

```json
{
  "locations": [
    {
      "deviceId": "esp32-bath",
      "location": "门口上方"
    }
  ]
}
```

客户端按 `deviceId` 合并位置数据。设备响应本身提供的非空 `location` 优先。

### 联系人

```http
GET /api/v1/contacts
```

```json
{
  "contacts": [
    {
      "id": "contact-1",
      "name": "张女士",
      "relation": "女儿",
      "phone": "13800000000",
      "primary": true
    }
  ]
}
```

后端必须按当前授权用户过滤联系人，不得返回其他家庭的数据。

### 远程留言

```http
POST /api/v1/communications/messages
Content-Type: application/json

{"clientMessageId":"cmsg-<base36 时间>-<8 位随机>","deviceId":"dayu200-living","text":"记得按时吃药","voiceId":"MEDICINE_REMINDER","requestAck":true}
```

- `clientMessageId`：客户端生成的幂等键，8-64 位 `[A-Za-z0-9._-]`。用同一个键重试**不得**产生第二条留言；
- `deviceId`：来自既有设备列表的 DAYU 设备编号；
- `text`：展示文字，1-120 字（服务端按 `trim` 后计）；
- `voiceId`：只允许 `CHECK_IN`、`PLEASE_RESPOND`、`MEDICINE_REMINDER`、`FAMILY_MESSAGE`、`EMERGENCY_CONTACTING`，大小写敏感；
- `requestAck`：布尔值，表示是否需要老人确认。
- 客户端**不提交** `openid`、`recipientRef`、令牌、手机号或坐标；身份一律取自 Bearer 会话。

成功返回 201（幂等命中时为 200）：

```json
{
  "message": {
    "messageId": "msg-001",
    "deviceId": "dayu200-living",
    "text": "记得按时吃药",
    "voiceId": "MEDICINE_REMINDER",
    "requestAck": true,
    "status": "QUEUED",
    "createdAt": 1791609000123,
    "updatedAt": 1791609000123,
    "deliveredAt": 0,
    "playedAt": 0,
    "acknowledgedAt": 0,
    "expiresAt": 0,
    "failureCode": ""
  }
}
```

`status` 只使用 `QUEUED`、`DELIVERED`、`PLAYED`、`ACKED`、`FAILED`、`EXPIRED`；
客户端把未知状态显示为「未知」，不猜测后端语义。查询接口：

```http
GET /api/v1/communications/messages?limit=20   -> {"messages":[...]}   # 时间倒序
GET /api/v1/communications/messages/{messageId} -> {"message":{...}}
```

### 确认告警

```http
POST /api/v1/alerts/{alarmId}/ack
Content-Type: application/json

{"note":"已电话确认老人安全"}
```

设备命令已进入可靠队列、但设备尚未回执时返回 HTTP 202：

```json
{"accepted":true,"status":"PENDING","commandId":"123"}
```

客户端此时只显示“已下发，等待设备回执”。设备真正回报 `ACKED` 后，后端可返回已更新告警，可以直接返回告警对象，也可以包装为 `{ "alarm": { ... } }`。后端必须：

- 校验当前用户是否有权处理该告警；
- 精确匹配 `alarmId` 与设备当前待处理告警；
- 对重复 ACK 做幂等处理或返回明确的 409；
- 记录操作者、时间和处置说明；
- 只有设备闭环成功后才返回 `ACKED`，不能只因 HTTP 请求到达就伪造成功。

### 错误

使用标准 HTTP 状态码。推荐返回：

```json
{
  "error": {
    "code": "ALERT_ALREADY_ACKED",
    "message": "该告警已经确认"
  }
}
```

客户端当前向用户显示安全的状态码提示，不直接呈现后端堆栈或敏感信息。401 会触发一次重新登录；第二次失败直接进入错误状态。

## 测试

使用系统 Node.js 直接运行，无需安装依赖：

```powershell
node tests/run-tests.js
node --test tests/subscribe.test.js
node --test tests/communications.test.js
```

`run-tests.js` 覆盖 HTTPS 地址限制、数据规范化、恶意图片 URL 丢弃、演示标识、ACK 输入校验、微信 code 换短会话、受保护 API 请求、授权图片下载、401 单次重认证和各列表端点的数据聚合。当前 **64 项**通过（24 项固定断言 + 每个源/配置文件 1 项凭据扫描，随源文件数量增长）。

`tests/subscribe.test.js` 覆盖告警订阅消息授权：用户接受 / 拒绝 / 禁用、未配置模板、微信能力不可用、请求失败与取消、结果求值、**接受后必须调用后端登记接口且不提交 openid**、**授权成功但登记失败不算完全成功**，以及「唯一的 `wx.requestSubscribeMessage` 调用点在告警页按钮处理函数」这条源码守卫。当前 **17 项**通过。

`tests/communications.test.js` 覆盖远程留言：语音白名单与状态中文映射、幂等键格式、输入校验（含路径穿越与命令拼接的 `voiceId`）、**请求体精确等于契约且不含 openid/recipientRef**、**失败重试复用同一个 `clientMessageId`**、列表与单条查询路径、以及「只在点击处理函数里发送、`onLoad`/`onShow` 不发送也不自动刷新、没有轮询定时器、不出现本阶段禁用话术」源码守卫；并用 `wx` 打桩真实驱动页面按钮。当前 **27 项**通过。

以上全部是本地打桩测试；**不代表已在微信开发者工具或手机真机运行，也不代表真实订阅消息已发送成功。**

## 告警订阅消息（订阅消息）

告警页顶部有「告警通知」面板。用户**点击按钮**后才会调用 `wx.requestSubscribeMessage`；
`onLoad` / `onShow` / 定时器与后台都不会请求授权。

### 配置

模板 ID 是非敏感标识，放在 `config/subscribe.js`：

```js
const SUBSCRIBE_TEMPLATE_ID = 'REPLACE_WITH_WECHAT_SUBSCRIBE_TEMPLATE_ID'
```

- 仓库内默认是**占位值**，会被识别为「未配置」：界面显示「告警通知未配置」，
  并且**不会**发起任何授权请求，也不会使用假的默认模板。
- 发布前请在微信公众平台申请「告警通知」类订阅消息模板，把这里替换为真实模板 ID。
- **AppSecret、access_token、openid、手机号绝不能出现在小程序任何文件中**，
  它们只存在于服务端 Secret（见 `../../cloud/backend/README.md`）。

### 一次性订阅语义与授权登记

订阅消息是**一次性授权**：用户每接受一次，后端通常只能推送一条对应告警。
因此本页文案是 **「已订阅下一次告警通知」**，不是「已开启」——通知发送后额度即消耗，
用户需要**再次点击**订阅。

用户接受后，小程序会立刻调用后端登记接口
`POST /api/v1/notifications/subscription`（`services/subscribe.js` 的 `registerGrant`）：

- 客户端**不提交 openid**；后端从会话 token 判断身份，因此无法替别人登记；
- `reject` / `ban` / `cancel` / `failed` **绝不登记**；
- 后端只登记**当前登录人自己**，并且只有登记过的人才可能成为告警收件人
  （允许登录 ≠ 已订阅）；
- 如果微信授权成功但后端登记失败，界面会显示「已授权，但登记未成功；请检查网络后再次点击订阅」，
  **不会**显示成完全成功。

服务端发送侧（模板字段、按收件人幂等、重试、启动恢复、access_token 刷新与隐私边界）见
`../../cloud/backend/README.md` 的「告警订阅消息」一节。

## 远程留言（远程交流）

页面：`pages/communications/index`（已在 `app.json` 的 `pages` 中登记；小程序 tabBar 最多 5 项且已被占用，
因此该页通过 `wx.navigateTo` 进入）。

**入口**：总览页（`pages/home/index`）的「远程留言」面板有「打开远程留言」按钮
（`goCommunications()` → `wx.navigateTo({ url: '/pages/communications/index' })`）。

本阶段能力边界是**单向**的：家属写文字 → 后端排队 → DAYU200 用**预置语音**播报 → 老人在设备上确认。
页面**不采集手机麦克风**，也不采集手机音频；文案统一使用「远程留言 / 预置语音播报 / 老人确认」。

安全与交互约束（`tests/communications.test.js` 全部有守卫）：

- 发送**只在**用户点击「发送远程留言 / 重试发送」时发生，`onLoad` / `onShow` 绝不发送；
- 近期留言**只在**用户点击「刷新」或下拉页面时加载，页面里没有 `setInterval` / `setTimeout` 轮询；
- 失败时页面保留同一个 `clientMessageId`，并提供显式「重试发送（不会重复留言）」按钮，
  后端按该键幂等去重；用户一改动草稿（设备 / 语音 / 文字 / 确认开关）就换新的键；
- `voiceId` 走服务端白名单精确匹配，`deviceId` 走 `[A-Za-z0-9._-]{1,64}`，
  因此路径穿越（`../../etc/passwd`）和命令拼接（`CHECK_IN; rm -rf /`）都会被拒；
- 请求体只含 `{ clientMessageId, deviceId, text, voiceId, requestAck }`，
  **不含** `openid`、`recipientRef`、令牌、手机号或坐标；
- 演示模式或云端未连接时，发送与刷新都会明确提示，绝不伪造成功状态。

接口契约与 `<message>` 形状见上文「后端契约 → 远程留言」。

