# 03 · 两个 ArkTS 应用（手机监护人 APP / DAYU200 板端 APP）

> 范围：只讲两个 ArkTS/ArkUI 工程——**代码结构、数据流、技术点、坑**。云端/ESP32/homemon/视觉/视频中继
> 分别见 `02-DEVICE.md`、`04-TRANSPORT-CLOUD.md`、`05-VISION-VIDEO.md`。
> 手机 APP 与后端的协议合同见 `competition/docs/APP-API-v1.md`（v1.3.0，已冻结）。

## 0. 本文约定

**路径缩写**（下文所有 `路径:行号` 按此展开）：

- `APP\` = `<WORKSPACE>\APP\ElderlyCareGuardian\entry\src\main\ets\`
- `NB\` = `competition\northbound\entry\src\main\ets\`

**规模**（物理行数，含注释空行）：手机 APP **74 文件 / 24,039 行**；板端 APP **16 文件 / 5,189 行**。

**证据分级**：`【实测】`有测试或现场记录可复核；`【未实测】`只有编译/静态守卫，无运行时证据；
`【未实现】`明确不提供。

---

## 1. 两个 APP 的职责边界

### 1.1 一张表

| 维度 | 手机 APP（监护人） | 板端 APP（老人现场） |
|---|---|---|
| 工程 / bundle | `<WORKSPACE>\APP\ElderlyCareGuardian` / `com.example.program_04` | `competition\northbound` / `com.dsh.eldercare`（1.0.10） |
| 跑在哪 | DevEco 模拟器 `127.0.0.1:5555` | DAYU200 板（OH 7.0.0.38 / API 26） |
| 数据来源 | 云端 `https://api.luxunacc.xyz/api/v1/*` | 本机 homemon `127.0.0.1:9000`（候选 9000/9001/9002） |
| 连接 | HTTPS + Bearer token（会话 2h） | 本机 TCP，`JSON + \n` 行协议 |
| 读 / 写 | 读 7 个查询接口；写登录、ACK、处置、健康资料 | 读 homemon 广播；只写 `route <deviceId> ack <id> <action>` |
| 账号体系 | 有（安全存储 token） | 无（同板 loopback，靠物理边界） |
| 铁律 | 不直连设备、不拿 `202` 当已确认 | 不伪造在线、不本地假闭环 |

### 1.2 手机 APP 的边界

- **只读云端 API**：`APP\core\api\ApiClient.ts:83-137` 全是 `GET /api/v1/...`，没有一条指向设备；
  `/internal/v1` 与 `INGEST_KEY` 被静态守卫禁止（`APP\tests\README.md:50`，【实测】）。
- **页面不许碰 ApiClient**：唯一入口是 `APP\service\GuardianService.ets`，页面只读 AppStorage 的
  `gv.*`（`APP\core\view\Models.ts:8-38`）。
- **没有的能力就说没有**：一键呼叫/发送消息是"解释为何不可用"的弹窗（`APP\pages\HomePage.ets:416-426`），
  手机端远程 SOS 悬浮按钮被移除（`APP\pages\Index.ets:243-244`）。【未实现】

### 1.3 板端 APP 的边界

读本机 homemon 广播（`NB\pages\Index.ets:682-728`）拿到 4 台设备的状态/告警/定位镜像；写只有一条命令
（`:1483`）：`route <deviceId> ack <alarmId> <处置文字>\n`。另有三个"边缘"职责（见 02/05）：相机预览与监护取帧
（`NB\model\CameraModel.ets`、`VisionFrameStreamer.ets`）、9301 取帧服务（`VideoStreamServer.ets`）、
语音 Ability（`sosvoiceability\SosVoiceAbility.ets`）。共同纪律：**失败不得影响预览/告警/ACK 主链路**
（`NB\pages\Index.ets:12-13`、`NB\model\VideoStreamServer.ets:12`）。

### 1.4 两端不共享任何东西

无共享会话/库/MQTT，"两端一致"只靠云端聚合（属 04）。于是有两个必然结果：① 两端在线数可以不同（§4.5）；
② 板端"设备已确认"与手机端 `ACKED` 是两条不同路径（§3.4/§3.5）。

---

## 2. 代码地图

### 2.1 手机 APP：一条硬分界 —— `core/` 纯逻辑 vs 平台层

```
APP\  core\      纯 TS（无 UI、无 @kit.*），可被 Node 直接 require 测试
      ├ api\        DTO 合同 + 容错解析 + HTTP 抽象 + 错误语义
      ├ view\       DTO→ViewModel 映射（所有"该怎么说"的话术都在这）
      ├ capability\ 能力台账      ├ inventory\ 家庭设备台账（恰好 4 台）
      ├ session\    会话代际/单飞  ├ polling\   轮询与回前台刷新
      └ video\ health\ activity\ location\ evidence\ demo\ util\
  net\       平台适配（全工程只有两个文件用 @kit.NetworkKit）
  auth\      Asset Store 安全存储（不可用则降级内存会话）
  service\   GuardianService —— 唯一 API 入口（.ets，不在 Node 测试范围）
  pages\ @Entry 页面   components\ @Component 组件（@Prop 单向）   view\ 地图 WebView
```

切分理由：`.ets` 页面在 PC 上跑不了单测，所以**把"什么算离线/已确认/未安装"全压进 `core\**\*.ts`**，
页面只渲染。收益是可验证：`APP\tests\` 用 DevEco 自带 tsc 4.9.5 编译 core 真实源码再 `node --test`
跑 **528 项**【实测，`APP\tests\README.md:98-102`】。

### 2.2 手机 APP 重点文件（13 个）

| 文件 | 行数 | 职责 | 关键符号:行号 |
|---|---|---|---|
| `core\api\ApiClient.ts` | 528 | 唯一 HTTP 调用面；统一超时/401/403/429/5xx/非法 JSON | `class`:27、`send`:36、`login`:67、`ack`:254、`evidence`:214 |
| `core\api\Contracts.ts` | 1221 | DTO 合同 + 逐字段容错（最长的防腐层） | `parseSensors`:382、`parseDevice`:402、`parseAlert`:474 |
| `core\view\Models.ts` | 304 | ViewModel + AppStorage 键；不含业务判断 | `AppKeys`:8、`SensorView`:64、`DeviceView`:120、`AlertView`:188 |
| `core\view\ViewMapper.ts` | 1161 | DTO→VM 唯一映射处；全部诚实性文案 | `isDeviceFresh`:38、`mapBattery`:624、`mapDevice`:687、`mapAlert`:980 |
| `core\capability\DeviceCapabilities.ts` | 359 | 能力台账（4 台 + 未知） | `resolveCapability`:260、`stateTextOf`:71、`colorTokenForSensorState`:90、`capabilityWarningFor`:328 |
| `core\inventory\DeviceInventory.ts` | 183 | 家庭设备清单 = 4 台；隔离未登记设备 | `HOUSEHOLD`:98、`isHouseholdDevice`:134、`unrecognizedReasonFor`:170 |
| `service\GuardianService.ets` | 1964 | 登录/会话/刷新/轮询/ACK/证据/处置/健康 | `login`:397、`refreshAll`:525、`doRefreshAll`:573、`startAutoRefresh`:884、`ackAlert`:992 |
| `pages\Index.ets` | 250 | 主框架：4 Tab、401 回登录、演示横幅 | `aboutToAppear`:31、`onPageShow`:70、`Tabs`:211 |
| `pages\LoginPage.ets` | 671 | 登录/会话恢复/演示入口/诚实错误文案 | `aboutToAppear`:33、`submit`:171、`login`:202 |
| `pages\HomePage.ets` | 884 | 首页总状态判定 + 快捷入口 | `dataStatus`:262、`headline`:292、`openVideoVisit`:412 |
| `pages\MonitorPage.ets` | 687 | 房间→设备→传感器两级分组 | `displaySensors`:56、`roomSections`:186、`sensorRow`:380 |
| `pages\AlertDetailPage.ets` | 1804 | 告警详情 + ACK 等待态 + 证据 + 处置 | `AckPhase`:33、`WAIT_POLL_MS`:62、`WAIT_TIMEOUT_MS`:63、`submit`:420 |
| `pages\DevicePage.ets` | 1020 | 设备台账/能力清单/电量/门磁记录/未识别设备 | `sceneGroups`:163、`loadDoorEventsForDevices`:297 |

另外几个只需知道职责的：`net\HarmonyHttpTransport.ets`(101)、`auth\TokenVault.ets`(145)、
`core\polling\Poller.ts`(106)、`pages\StatsPage.ets`(385)、`components\SensorCard.ets`(192)、
`components\AlertItem.ets`(144)；其余 55 个文件按域归类为 `core\session\*`、`core\health\*` +
`pages\HealthAssessmentPage.ets`(1433)、`core\video\*` + `pages\VideoVisitPage.ets`、`core\demo\*`。

### 2.3 板端 APP：16 个文件（全部）

| 文件 | 行数 | 职责 |
|---|---|---|
| `pages\Index.ets` | 2297 | 单页面承载全部：TCP 收发、4 台快照、Tab、相机、视频服务、语音 |
| `model\VideoStreamServer.ets` | 601 | 9301 取帧服务（单客户端、按需取帧、JPEG） |
| `sosvoiceability\SosVoiceAbility.ets` | 536 | 现场语音播报（白名单资源 + 回执） |
| `model\CameraModel.ets` | 495 | 相机预览/拍照、档位选择、资源释放 |
| `model\DeviceModel.ets` | 283 | 另一套数据层 `DeviceStore`：状态解析、告警并入、文案 |
| `model\VisionFrameStreamer.ets` | 254 | 每 250ms 把预览帧 POST 给 PC 视觉服务 |
| `view\ReportView` / `view\AlarmView` / `view\StatusView` | 136 / 124 / 119 | 统计报告 / 预警处置 / 实时状态三个 Tab 组件 |
| `model\DeviceCapabilities.ts` | 70 | 板端能力表（按 deviceId 硬编码） |
| `model\PreviewTuning.ets` / `model\WearableBannerPrefs.ets` / `model\PhotoRetention.ts` | 63 / 56 / 33 | 预览参数持久化 / 横幅偏好 / 照片保留策略 |
| `model\DeviceLink.ets` | 38 | 命令发送口（socket 由页面注入） |
| `entryability\EntryAbility.ets` / `entrybackupability\EntryBackupAbility.ets` | 67 / 17 | Ability 入口 / 备份扩展 |

结构差异本身就是结论：**手机 APP 是分层工程，板端 APP 是"单页面 + 少量 model"**。板端 Index 一个 struct
里上百个 `@State`（`NB\pages\Index.ets:200-320`），改一处可要重编整页。

---

## 3. 关键流程

### 3.1 登录与会话（手机 APP）

```
LoginPage.aboutToAppear ─► GuardianService.init(ctx) ─► restoreSession()
        │                       └─ Asset Store 有未过期 token → replaceUrl(pages/Index)
        └─ 用户登录 ─► login() ─► POST /api/v1/auth/app ─► sessionToken
                                    └─ 落盘 = remember && 安全存储可用 ? secure : memory
```

- 恢复 `APP\pages\LoginPage.ets:52`；登录 `LoginPage.ets:171` → `GuardianService.ets:397`。本地先校验格式
  （账号 `3-64` 位 `[A-Za-z0-9._-]`、口令 `8-256` 位，`GuardianService.ets:78-80`），非法根本不发请求。
- **每次登录开新 epoch**（`beginLoginAttempt`，`:418`）：旧在途响应、旧 restore 全部作废（§4.4）。
- 落盘：`remember && secure 成功` → `secure`，否则只内存会话（`:456-460`、`TokenVault.ets:81-103`）；
  Asset Store 在模拟器/真机的真实可用性【未实测】（`APP\tests\README.md:129`）。
- 主框架：`APP\pages\Index.ets:31` 依次 `init → isLoggedIn → refreshAll → startAutoRefresh(30s)`；
  业务 401 由 `@Watch`（`:28,92`）统一回登录页，`redirected` 一次性闸门防抖动跳转（`:101-111`）。

### 3.2 拉数据：4 请求并发 → DTO → ViewModel → AppStorage

```
doRefreshAll()                                    GuardianService.ets:573
 ├ 取会话 ticket 并校验                              :576-592
 ├ Promise.all[overview, rooms, devices, alerts]     :594-599
 ├ 再次校验会话（期间切换/过期 → 整批丢弃）              :601-604
 ├ devices 失败 → 缓存 DTO 按"当前时间"重映射            :648-650
 ├ rooms 只留含家庭设备的房间                           :657
 ├ overview 的 deviceCount/onlineCount 由 devices 派生  :664-688
 └ 写 gv.*（ok / partial / offline / error + lastUpdatedAt）:689-721
```

**为什么重算 overview**：服务端 `onlineCount` 可能是上一轮聚合的陈旧值，而 devices 是刚拿到的；不覆盖就会
"设备已离线、首页仍显示在线"（`:659-663` 注释即为此）。映射链全在纯逻辑里：

```
DeviceDto ─mapDevice()─► DeviceView{online,stateText,sensors[],battery,capabilityNote}   ViewMapper.ts:687
Devices   ─splitDevices()─► household[] + unrecognized[]                                 :802
Rooms     ─householdRooms()+mapRooms()─► RoomView[]                                     :818/:862
Alerts    ─mapAlerts()─► AlertView[]（createdAt 倒序）                                    :1023
```

### 3.3 实时监测页：房间 → 设备 → 传感器

- 只渲染 `gv.devices`；`state === 'unsupported'` 的瓦片**不进监测页**（`APP\pages\MonitorPage.ets:56-64`），
  "未安装/未启用"统一到设备管理页看能力清单。
- 分组优先 `gv.rooms`；rooms 失败时用 `d.roomName` 兜底合成分组，仍只渲染 `gv.devices`（`:186-252`）。
- 设备内分 `ENV_KINDS=[climate,gas,smoke]` / `SAFETY_KINDS=[motion,camera,fall,door,sos,water]`（`:34-35`）。
- 瓦片只吃 `@Prop sensor`（`APP\components\SensorCard.ets:13`），颜色**只能**由 `sensor.colorToken` 决定，
  缺省才回退 `colorTokenForSensorState(state)`（`:17-22`）——"绿=正常"只有一个源头。

### 3.4 告警详情与 ACK（手机 APP）

```
submit()                                  AlertDetailPage.ets:420
 └ ackAlert(alarmId, note)                 GuardianService.ets:992
    └ POST /alerts/{id}/ack                ApiClient.ts:254
       ├ 202 且 body 解析失败 → 兜底 accepted=true/status=PENDING（绝不视为已确认）:266-277
       └ 成功 → refreshAlerts()，但仍只显示服务端 ackPending/ACKED            :1045-1051
 └ AckPhase.WAITING：每 3s 刷新，60s 未确认 → TIMEOUT                          :395-411 / :62-63
```

- 状态机 `IDLE → SUBMITTING → WAITING → CONFIRMED`，旁路 `FAILED`/`TIMEOUT`（`AlertDetailPage.ets:33`）。
- **本地永不写 ACKED**：`syncAlert()` 只认服务端映射出的 `statusKey`（`:206-230`），`statusKey` 由
  `mapAlert` 算（`ViewMapper.ts:1006-1019`）：`ACKED→'acked'`、`ALARM&&ackPending→'waiting'`、`ALARM→'pending'`。
- 超时文案是"仍未收到设备确认；服务端可能仍为 PENDING"（`:405-408`）——命令确实可能还在路上。
- 详情页并列三块独立能力：FALL 证据（2 MiB 上限、只内存不落盘，`GuardianService.loadEvidence`:906）、
  处置结果（与 ACK 完全独立）、随身求助地图（仅 MANUAL_SOS）。

### 3.5 板端 APP：快照、在线与"先下发后闭环"

```
openLink(9000/9001/9002) ──► 收到 JSON 行           NB\pages\Index.ets:682
   │ 失败 → retryOpen（单闸 15s 后重连）              :730-758
   └ consume() 按 '\n' 切行 → applyLine()            :871-931
        ├ deviceId 白名单（防协议注入）               :892-894
        ├ routes.set(dev, link.port) 记回程连接       :902
        ├ toSnap() 生成 DevSnap（含 lastSeenMs）      :933-998
        ├ settlePending(snap) 每份快照都先尝试结算     :922
        └ 每 3s：8s ACK 超时 + 12s 离线判定            :397-408
```

- 在线：`DEVICE_STALE_MS=12000`（`:21`），用**本地接收时间** `lastSeenMs` 判（`:776-788`）；状态行显式带
  `online` 时以报文为准（`:949-951`）。
- ACK 四步（防假闭环样板）：① 发送成功才置 `pendingAckId/pendingDeviceId/pendingSince`（`:1483-1490`）；
  ② 每份快照 `settlePending`，要求 `snap.id===pendingDeviceId && state==='ACKED'` 且告警列表里能找到同一
  `alarmId`（`:1515-1534`）；③ 8s 无匹配清等待态并提示（`:400-405`）；④ 发送失败立即回退不等待（`:1494-1504`）。
- 同时只允许一条 pending（`:1448-1451`），"确认中"须同时匹配设备与告警（`isConfirming`:1509-1512），
  所以切房间不会误结算。

### 3.6 统计页（手机 APP）

`APP\pages\StatsPage.ets:33-55`：7 天桶全部由 `gv.alerts.createdAt` 本地推导，不另取接口；无数据源的模块
明确显示"暂无数据/未开放"（`:1-4`）。真正的活动报告是另一页 `pages\ActivityReportPage.ets`
（`GET /api/v1/activity/report`，`null ≠ 0` 由接口合同保证）。

---

## 4. 关键技术点

### 4.1 ArkTS / ArkUI：声明式 + 状态装饰器 + 单入口多 Tab

**概念**：`struct + build()` 声明 UI，装饰器驱动"数据变→UI 变"；`@Entry` 路由页、`@Component` 组件、
`@State` 私有、`@Prop` 单向入参、`@StorageLink` 全局。

| 用法 | 实例 | 说明 |
|---|---|---|
| `@Entry @Component` | `APP\pages\Index.ets:22-24` | 路由页须注册在 `main_pages.json`（13 个页面） |
| `@StorageLink('gv.*')` | `APP\pages\HomePage.ets:20-30` | 页面间不传参，统一读全局键，只有 Service 写 |
| `@StorageLink + @Watch` | `Index.ets:28`、`AlertDetailPage.ets:68` | 401 跳转、告警变化重算详情 |
| `@State` / `@Prop` | `MonitorPage.ets:49`、`components\SensorCard.ets:13` | 页面私有交互态 / 组件只展示不改源 |
| `@Builder` / `Tabs` | `HomePage.ets:428`、`Index.ets:164,211-227` | 复用小块 UI / 4 Tab + 真实徽标 |
| 路由 | `getRouter().pushUrl/replaceUrl` | `HomePage.ets:413`、`LoginPage.ets:55`、`Index.ets:110` |

**工程手法：把逻辑挤出 UI 层。** 判断一律写成纯函数：`dataStatus()`（`HomePage.ets:262`）、
`roomSections()`（`MonitorPage.ets:186`）、`mapDevice()`（`ViewMapper.ts:687`）。`MonitorPage.ets:12-13`
甚至明令禁止在标题/数值/标签/底栏四处重复"离线"——**同一语义只表达一次**。

**ArkTS 比 TS 严（真实踩坑）**：禁 `any`/`unknown`（`arkts-no-any-unknown`）、`Record<string,Object>` 不能赋给
更窄的 Record、静态方法里不能用 `this`（`NB\model\DeviceModel.ets:9-10` 因此全写 `DeviceStore.xxx`）。
能否编过只能靠真实 hvigor 编译，源码守卫替代不了（`northbound\README.md:144-145`）。【实测】

### 4.2 DTO 容错 + Mapper 分层：为什么页面不能直接读后端 JSON

三层缺一不可：

1. **解析层** `core\api\Contracts.ts`：每字段配 `Present` 标志——`lastActiveTsPresent`:34、
   `countTodayPresent`:35、`supportedPresent`:42、`reportedPresent`:48、`openPresent`:55。
   **"字段缺失"必须与"值为 0/false"区分**，否则"没上报"会显示成"0 次活动"或"门已关"
   （`ViewMapper.ts:303-310`、`:393-399`）。
2. **容错层**：未知 `sensors` 子键收进 `unknownKeys`（`Contracts.ts:396`），设备详情如实列出
   "未识别 sensors 字段："（`ViewMapper.ts:722-724`）——API 合同 §1"必须忽略未来新增字段"的落地。
3. **映射层** `core\view\ViewMapper.ts`：唯一决定"中文怎么写、什么颜色"的地方；不 import 任何 `@kit.*`，
   所以能被 Node 全量测试（`tests\view-mapper.test.mjs` 等，【实测】）。

收益：① 语气可控（`valueText/detailText/stateText` 一次写死，页面无自由发挥空间）；② 可测（528 项里大部分
断言的是 Mapper 输出文本）；③ 可换源（演示模式只换 DTO，`core\demo\DemoData.ts`，不必复制页面）。

### 4.3 capability：三态语义（未安装 / 未启用 / 报警未启用）

**概念**：一个传感器有四件独立事实——硬件装了没、通道开了没、告警使能了没、本次读数有效没。混在一起就会
长出"有读数=环境正常"这种假安全。

- 三字段 `installed`/`enabled`/`alarmEnabled`（`APP\core\capability\DeviceCapabilities.ts:98-106`）。
- 专属文案：`stateTextOf()` 把 `disabled` 译成**"报警未启用"**、`unsupported` 译成**"未安装/未启用"**（`:71-81`）；
  颜色单点定义——只有 `ok` 才 `success`，其余（offline/disabled/unsupported/unknown）一律中性
  （`colorTokenForSensorState`:90-96）。
- 燃气/烟雾：MQ 通道存在但未标定 → 显示 `原始 ADC 900`（`formatRawAdc`:316-321），状态 `disabled`，
  说明"报警未启用 · 未标定，原始 ADC 不代表 ppm"（`ViewMapper.ts:365-368`）。
- 客厅无 PIR：`motionSource = CAMERA`（`:192`），**PIR 瓦片与摄像头瓦片分开渲染**（`motionSemanticsFor`:178、
  `buildPirUnconfiguredView`:187、`buildCameraMotionView`:214），逐字文案"未配置 PIR，无活动监测"（`:52`）。
- 告警与能力不符**必须提示核实**：`capabilityWarningFor()`（`:328-347`）——客厅出现 `NO_MOTION` 会写
  "未配置 PIR，来源需核实"（`ViewMapper.ts:929-937`），而不是说老人长时间无活动。
- 物理边界：只有 `HOUSEHOLD` 的 4 台算受监护（`DeviceInventory.ts:98`），后端残留节点被拆到 `unrecognized`，
  不生成瓦片、不计在线数（`ViewMapper.ts:730-732,802-812`），只在设备页说明原因。

### 4.4 HTTP 封装、超时与"会话代际单飞"

| 层 | 文件 | 做什么 |
|---|---|---|
| 传输 | `APP\net\HarmonyHttpTransport.ets:15` | 连接超时 `10000ms`（`:11`）、读超时用 `spec.timeoutMs`（`:44`）、错误码 `2300028` 判超时（`:13,95`）、二进制有 `maxLimit`（`:49-51`） |
| 语义 | `APP\core\api\ApiClient.ts:36` | 网络/超时/取消/状态码统一折成 `ApiError`（`core\api\Errors.ts:74`，含 429 的 `Retry-After`） |
| 业务 | `APP\service\GuardianService.ets` | 会话代际、单飞、轮询、缓存重映射 |

- **超时分级**：普通读写 `12000ms`、登录 `15000ms`、健康建议 `20000ms`（AI 生成，`ApiClient.ts:434-435`）、
  证据单独常量。"统一 30s"在这里是错的。
- **防并发三件套**：`Poller` 保证同刻最多一个 tick 且跨 stop/start 不重叠
  （`core\polling\Poller.ts:1-11,72-104`）；`ScopedSingleFlight` 按会话代际去重（`refreshAll`:525-530）；
  `RequestGuard/SessionCommit` 请求前后各校验一次会话，**旧会话响应一律丢弃**（`:576-592,601-604,643-645`）。
- **轮询节奏**：`30s`（`GuardianService.ets:77`）+ 回前台必要时立即刷新（`core\polling\RefreshPolicy.ts:16,19`：
  上次非 ok / 从未成功 / 超 12s / 时钟异常 → 刷；调用点 `Index.ets:70-89`）。
- **失败不许把旧数据当实时**：devices 失败时用缓存原始 DTO 按当前时间重映射（`remapCachedDevicesForNow`:553-564）。
- **写操作不自动重试**：登录/ACK 失败交用户重试，只有刷新靠 30s 轮询自然重来；429 用 `Retry-After` 文案
  （`LoginPage.ets:106-110`）。静默重试 ACK 会造成重复命令。

### 4.5 在线判定：两套阈值，各有各的理由

| 端 | 判据 | 常量 | 失败表现 |
|---|---|---|---|
| 手机 APP | 后端 `online` **且** `now-lastSeenTs ≤ 90s`；未来时钟超前 `>5min` 视为不可信 | `ViewMapper.ts:34,36,38-43` | 离线 + 每块瓦片改写成"离线·上次读数/离线·暂无数据"（`:565-581`） |
| 板端 APP | 本地接收时间 `lastSeenMs` 超 `12s` 未更新 | `NB\pages\Index.ets:21,776-788` | 快照 `online=false`，选中设备立即刷 UI（`:781-783`） |

差异不是笔误：板端读"直连广播"（秒级上报），12s 就是漏两拍；手机 APP 读云端聚合快照，链路里还有 30s 级
稳定态限频（属云层），所以留到 90s。**跨层套用必错**。

### 4.6 ACK 闭环：`202` 之后的三种结局都要如实显示

HTTP `202 accepted` 只证明**入队**，设备可能失败、可能超时。两端表达不同、纪律相同：

- 手机 APP：`202` 且响应体解析失败时兜底成 `accepted=true,status='PENDING'`（`ApiClient.ts:266-277`）——
  降级但不越界；之后只认服务端 `state`，60s 后报"等待超时，未本地归档"（`AlertDetailPage.ets:405-408`）。
- 板端 APP：`pendingDeviceId + pendingAckId` 双重绑定 + 8s 超时（`NB\pages\Index.ets:245-246,400-405,1515-1541`）。
  **为什么必须带 deviceId**：同一 `alarmId` 可能出现在不同设备上，只按 alarmId 结算会在切房间后把 A 的回执
  算到 B 头上（源码注释 `Index.ets:246` 明写此坑）。

### 4.7 行协议与命令注入防护

- **粘包/半包**：`consume()` 自维护缓冲、按 `\n` 切行，末段不完整留到下一次（`NB\pages\Index.ets:871-882`）。
- **注入**：`deviceId` 必须过 `^[A-Za-z0-9._-]{1,64}$`（`:96`），因为它会被拼进 `route <deviceId> ack ...`
  （`:1483`）；用户处置文字先把 CR/LF 压成空格（`:1452-1454`），否则一行文本能拼出第二条命令。
- **回程路由**：不用"最后一条报文的连接"，而按设备记 `routes.set(dev, link.port)`（`:902`），因为一条连接可
  承载多设备（relay 注入的无线节点共用网关连接，`:86-93,791`）。

---

## 5. 取舍与坑

### 坑 1 · 只看得到"原始 ADC"，看不到 ppm —— 这是设计

燃气/烟雾永远显示 `原始 ADC 900` 这类字面值（`DeviceCapabilities.ts:316-321`），并附"未标定，原始 ADC 不代表
ppm，也不代表安全"（`ViewMapper.ts:368,372`）。**任何"顺手换算成 ppm/浓度"的改动都是引入假精度**；正确方向是
等硬件标定后改 `alarmEnabled` 并写清阈值（当前台账：GAS=900 / SMOKE=700、连续 3 帧、回差 20）。

### 坑 2 · ACK 的 `202` 是"命令入队"，不是"人已安全"

代码在防（`ApiClient.ts:253,266-277`；板端 `Index.ets:1441-1442`），**最容易出错的不是代码而是话术**：看板写
"已确认"就等于告诉家属"没事了"，而真实状态可能只是 PENDING。

### 坑 3 · 两套在线阈值（90s / 12s）不能互相搬

见 §4.5。另外手机 APP 的"离线"会连带改写所有瓦片文案，板端只是把设备块变灰——同一个"离线"在两界面上信息量
不同，验收报告要分开写。

### 坑 4 · 板端 `4/4` 是 UI 文本，不是在线探针

```ts
this.diag = `${this.selectedLabel()} · 全屋在线 ${this.countOnline()}/${this.deviceIds.length} 台设备`;
```

（`NB\pages\Index.ets:801-803`，显示在 `:1643`。）分子 = `snaps` 里 `online` 的个数（`:790-799`），分母 = **收到过
状态行的 deviceId 个数**（`:906-908`），没有逐链路探测，也不是 MQTT/bridge 连接数。外部 watcher 靠
`uitest dumpLayout` 抓这行文本的正则（`evidence\2026-10-28-fullchain-health\nodes\FINDINGS.md:15`），最坏陈旧 30s
并沿用旧值。正确读法："板端 APP 认为 4 台都在线"，不是"4 条链路此刻都通"。【实测口径已核实】

### 坑 5 · capability 表是**硬编码台账**，改了固件必须同步改它

`DeviceCapabilities.ts:143-256` 四张表全是手写常量，连"2026-10-28 在板固件"这种核验日期都写在注释里。风险直白：
**接线/固件变了而表没变，UI 会安静地撒谎**。运行时唯一兜底 `capabilityWarningFor()`（`:328-347`）只在"告警类型
与能力不符"时提示。

### 坑 6 · 后端有记录 ≠ APP 会显示（4 台台账 vs N 条记录）

`HOUSEHOLD` 只有 4 条（`DeviceInventory.ts:98-112`），其余被 `splitDevices` 拆走（`ViewMapper.ts:802-812`），
不生成瓦片、不计在线数、不进房间分组（`householdRooms`:818-834），只在设备页列出并解释原因（`:170-174`）。
现场很容易误判成"APP 丢设备"，其实隔离策略在生效。

### 坑 7 · `.ets` 平台层没有单测，只能"静态守卫 + 人工/模拟器"

Node 测试只编译 `entry\src\main\ets\core\**\*.ts`（`tests\tsconfig.json`），`GuardianService.ets`、`net\*`、各页面
都在覆盖之外（`APP\tests\README.md:132-133` 自陈）。所以"逻辑下沉到 core"不是洁癖，而是**唯一能自动验证的路径**；
反向推论：改 `.ets` 里一行逻辑，回归测试帮不上忙。

### 坑 8 · 板端：文案双陈旧 + 测试已经红了一半

- 文案：`NB\model\DeviceModel.ets:171-172` 的告警详情仍写"MQ 原始 ADC 未标定、报警阈值未启用"，而
  `NB\model\DeviceCapabilities.ts:37-43` 已在 2026-10-28 把 `mqAlarmEnabled` 置 `true`——**同一 APP 两种说法**。
- 测试：`northbound\tests` 5 个文件 / 33 例，本轮实跑 **28 通过 / 5 失败**（2026-10-28）。5 例全是**过期断言**，
  不是产品回归：`device-capabilities.test.mjs` 4 例仍按旧能力表断言（客厅有 motion/door/climate、厨房无 PIR/门磁、
  `mqAlarmEnabled=false`），与 2026-10-27 在板固件核验冲突；`camera-lifecycle-guard.test.js:34` 断言"预览必须锁定
  直立方向"，当前 `CameraModel.ets` 已无该实现。说明这批守卫没进日常回归，"绿"只是历史状态。

> 另：手机 APP"重启要重登"取决于 Asset Store 是否可用（`TokenVault.ets:81-103` 降级内存会话），模拟器上的真实
> 行为【未实测】——只能说"安全存储不可用时确实只能重登"，不能说"模拟器一定不持久"。

---

## 6. 可完善点（ROI 排序）

| 优先级 | 项 | 动哪里 | 收益 |
|---|---|---|---|
| P0 | 修那 5 个过期断言，把 `northbound\tests` 纳入回归 | `northbound\tests\device-capabilities.test.mjs`、`camera-lifecycle-guard.test.js:34` | 让板端"测试绿"重新有意义（§5 坑 8） |
| P0 | 统一板端燃气/烟雾文案，由 `mqAlarmEnabled` 生成 | `NB\model\DeviceModel.ets:167-175` + `NB\pages\Index.ets:847-861` | 去掉同屏自相矛盾 |
| P0 | 给 `4/4` 加"最后更新时间"或改逐设备列表 | `NB\pages\Index.ets:801-803,1643` | 把"陈旧 30s 的 UI 文本"变成可判断信息 |
| P1 | `4/4` 分母改成台账 4 台（现在少一台显示 `3/3`，看着全在线） | `NB\pages\Index.ets:790-799` | 在线口径可信 |
| P1 | ACK 等待条显示剩余秒数/可取消（已有 1s 定时器 `AlertDetailPage.ets:137-139`） | `pages\AlertDetailPage.ets:395-411` | 60s 等待期用户知道要等多久 |
| P2 | 板端把 TCP/快照逻辑抽成 `model\LinkStore.ets`，Index 只渲染 | `NB\pages\Index.ets` | 可维护性 + 可测性（需回归相机/视频/语音） |
| P2 | 把 `toSnap`/`settlePending`/行解析抽成 `.ts` 并加 node:test | 新增 `northbound\tests\*.test.mjs` | 板端也能有真回归 |
| P3 | capability 表与固件配置同源生成 | `core\capability\DeviceCapabilities.ts:143-256` | 消除"改固件忘改表"（坑 5） |
| P3 | 后台暂停轮询、回前台立即刷新 | `pages\Index.ets:59-63`、`GuardianService.ets:884-901` | 省电省流量（需真机验证生命周期） |

**不建议做**（引入假精度/假能力）：把原始 ADC 换算成 ppm、给未标定 MQ 显示"正常"、把 `202`/`PLAYED` 显示成
"已确认"、加没有下行通道的"远程复位/关机"按钮。

---

## 7. 本层最容易被误解的 3 个点

**误解 1 · "手机 APP 能看到实时画面和实时传感器。"** 传感器是 **30s 轮询到的云端快照**
（`GuardianService.ets:77,884`），刷新后最多还有 90s 新鲜期才判离线（`ViewMapper.ts:34`）。真正的"实时"只有两处：
视频探望页的 JPEG 流（另一条链路）与板端本机看板。"APP 上显示正常"的含义是"最近一次成功拉取的快照里没有异常"，
不是"此刻没事"。

**误解 2 · "两端在线数应该一样。"** 数据源（云端聚合 vs 本机广播）、阈值（90s vs 12s）、分母（家庭清单 4 台 vs
收到过状态的 deviceId 集合）、刷新节奏（30s 轮询 vs 3s tick）全都不同；板端那个 `4/4` 本身还只是界面文本（§5 坑 4）。

**误解 3 · "设备离线 = 传感器坏了 = 没人/可能出事。"** 离线只表示"没在时限内收到状态"，不产生任何推断：摄像头
无结果是"暂无有效检测数据"（`ViewMapper.ts:209-212`）；无 PIR 的设备显示"未配置 PIR，无活动监测"
（`DeviceCapabilities.ts:52`）；门磁 `open` 缺失显示"未知"，绝不默认"门已关"（`ViewMapper.ts:393-399`）。
**不确定就显示不确定，不用"正常"填补空白。**

---

## 8. 阅读顺序建议

### 8.1 手机 APP（2–3 小时）

1. `core\view\Models.ts`(304) —— 先认清视图模型长什么样；
2. `core\capability\DeviceCapabilities.ts`(359) —— 再认清哪些能力是真的；
3. `core\view\ViewMapper.ts`(1161) —— **核心**，重点 `mapDevice`:687、`mapBattery`:624、`applyOfflinePresentation`:565；
4. `core\api\Contracts.ts`(1221) —— 看 `parseDevice`:402 / `parseSensors`:382 与一群 `*Present`；
5. `core\api\ApiClient.ts` + `core\api\Errors.ts` —— 错误语义与 `ack`:254 的 202 处理；
6. `service\GuardianService.ets` —— 按 `login`:397 → `refreshAll`:525 → `doRefreshAll`:573 → `ackAlert`:992 读，
   其余（证据/处置/健康）可跳读；
7. `pages\Index.ets` → `LoginPage.ets` → `HomePage.ets` → `MonitorPage.ets` → `AlertDetailPage.ets`；
8. `components\SensorCard.ets` + `AlertItem.ets` —— 状态只由 `colorToken`/`statusKey` 决定；
9. `APP\tests\README.md` —— **强烈建议读**：一张表写清每个测试文件覆盖的语义，等于 APP 层的需求规格书。

### 8.2 板端 APP（40 分钟）

1. `NB\model\DeviceCapabilities.ts`(70) —— 4 台设备各有什么；
2. `NB\pages\Index.ets` 只看五段：常量区 `:17-96`、`openLink/retryOpen`:682-758、`consume/applyLine`:871-931、
   `toSnap`:933-998、`doAck/settlePending`:1443-1541；
3. `NB\model\DeviceModel.ets`(283) —— 另一套数据层，注意它现在只当工具类用（`:5-7` 注释）；
4. `northbound\README.md` + `RELEASE.md` —— 版本/签名/安装边界（1.0.10，签名资产在 `signing\`）。

### 8.3 自己复跑一遍（两条命令）

```powershell
# 1) 手机 APP 核心逻辑：528 项（先 tsc 编译 core，再 node --test）
node "D:\DevEcoStudio\DevEco Studio\tools\hvigor\hvigor\node_modules\typescript\bin\tsc" `
  -p "<WORKSPACE>\APP\ElderlyCareGuardian\tests\tsconfig.json"
Set-Location "<WORKSPACE>\APP\ElderlyCareGuardian\tests"; node --test --test-isolation=none

# 2) 板端 APP：33 例，目前 28 通过 / 5 失败（见 §5 坑 8，是断言过期不是环境问题）
node --test <WORKSPACE>\competition\northbound\tests
```

### 8.4 本层验证状态（读文档时带着这张表）

| 项 | 状态 | 依据 |
|---|---|---|
| 手机 APP `core/**` 纯逻辑 | 【实测】528 项通过（2026-10-27） | `APP\tests\README.md:98-102` |
| 手机 APP 在模拟器跑真实后端 | 【实测】1.0.11 覆盖安装，生产账号真实数据 | `evidence\2026-10-28-monitor-ia\REPORT.md:47` |
| 板端 APP 真机运行 | 【实测】1.0.10 已安装运行，看板 4/4 | `evidence\2026-10-28-three-legacy-closures\lead\HEALTH-CHECK-0117.md:22` |
| 板端 APP 测试 | 【实测】**28/33**，5 例过期断言（2026-10-28 实跑） | §5 坑 8；`northbound\tests` |
| 手机 APP Asset Store 安全存储 | 【未实测】只验证了降级路径 | `APP\tests\README.md:129` |
| 手机 APP 实体手机安装 | 【未实测】无签名材料 | `VIDEO-VISIT-CONTRACT.md:20` |
| 一键呼叫 / 发送消息 / 手机端远程 SOS | 【未实现】点击只解释不可用 | `pages\HomePage.ets:416-426`、`pages\Index.ets:243-244` |
