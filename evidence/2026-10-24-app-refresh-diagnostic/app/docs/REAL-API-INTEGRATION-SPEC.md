# 颐养守护监护人 APP · 真实 API 接入内部规范（2026-10-21）

本文件是本次接入的唯一内部接口约定。页面实现必须以此为准；若源码/合同与本文冲突，
以 `competition/docs/APP-API-v1.md` 和现有后端路由为准，并在交付证据中说明。

## 0. 铁律

1. 正式模式（`REAL_API`）不得 import `MockData`，不得回退到演示数据冒充成功。
2. 不得伪造任何成功提示：SOS 推送、声光报警器、联系全部联系人、设备已确认、处置已归档。
3. 密码只在登录请求中使用，不落盘、不进日志、不进入 AppStorage。
4. Token 只放系统安全存储（`@kit.AssetStoreKit` asset）；安全存储不可用时仅内存会话，
   禁止明文 Preferences/relationalStore 落盘。
5. APP 不得出现 `INGEST_KEY`、`/internal/v1/`、设备内部命令。
6. 时间戳统一 13 位 Unix 毫秒；`valid` 当前被云端适配器剥离，APP 不得编造 `valid=true`。
7. 只读接口数据，AGENT 不修改公网后端/固件/Bridge/DAYU HAP。

## 1. 后端事实（2026-10-21 只读核对）

- Base URL：`https://api.luxunacc.xyz`，路径前缀 `/api/v1`。
- 登录：`POST /api/v1/auth/app`，body `{guardianId,password}`；成功 `{sessionToken,tokenType:"Bearer",expiresIn:7200}`。
  - guardianId：`^[A-Za-z0-9._-]{3,64}$`（server `auth.js`）。
  - password：32–256 字符（server `auth.js`）；错误统一 `401 {"error":"invalid credentials"}`，
    失败 5 次后 `429` + `Retry-After` 秒；未配置返回 `503`。
- `GET /api/v1/overview` → `{generatedAt,deviceCount,onlineCount,monitorOfflineCount,activeAlertCount,latestAlert,location}`。
- `GET /api/v1/rooms` → `{rooms:[{id,name,location,state,onlineDeviceCount,deviceCount,devices:[]}]}`。
- `GET /api/v1/devices` → `{devices:[{id,deviceId,name,roomId,roomName,location,online,monitorOnline,state,lastSeenTs,sensors,csq}]}`。
- `GET /api/v1/alerts` → `{alerts:[{id,alarmId,deviceId,roomName,type,message,state,ackPending,createdAt,acknowledgedAt,acknowledgedBy,evidence:{available,evidenceId,bytes,capturedAt}}]}`。
  - `state` 只观察到 `ALARM` / `ACKED`（`store.js listAlerts()` 返回 alert.status）。
  - ACK 等待设备回执期间：`state` 仍为 `ALARM`，`ackPending=true`。
  - 设备真实回执后：`state="ACKED"`，`ackPending=false`，`acknowledgedAt>0`。
- `POST /api/v1/alerts/{alarmId}/ack` body `{note}` → `202 {accepted:true,status:"PENDING",commandId}`。
  - `202` 只表示命令入队，**不是设备确认**。
  - 告警不存在 → `404`；已 ACKED 再提交 → `400`（server `requestAck` 抛 `alarm already acknowledged`）。
  - 重复提交同一 PENDING 命令后端会复用现有命令，但 APP 不依赖该幂等行为，仍按“一次点击一次提交”处理。
- `GET /api/v1/rooms` 与 `devices` 的关联键：`roomId == Room.id`；`Room.devices[].roomId` 也应一致。
  APP 不得用中文房间名做唯一关联依据。
- `monitorOnline`：`1` 正常 / `0` 监测离线 / `-1` 未上报（未知）。`online=true` 不代表视觉监测正常。
- 公开健康检查：`GET https://api.luxunacc.xyz/healthz` → 200（本轮已实测）；无 Bearer 的
  `GET /api/v1/overview` → 401（本轮已实测）。真实登录/真机验收因无合法会话标记 NOT TESTED。

## 2. 能力表（实现初版；由 capability audit 复核）

| deviceId | 已核实能力 | 明确未安装/未启用 | 备注 |
|---|---|---|---|
| `esp32-kitchen` | AHT20 温湿度；MQ-5 燃气原始 ADC；MQ-2 烟雾原始 ADC；板载蜂鸣器；CLIMATE 告警启用 | PIR、门磁、水漏、摄像头 | GAS/SMOKE 阈值 4096（永不告警），报警未启用，未标定 ppm；`gas/smoke` 只有 `raw/ok` |
| `esp32-bath` | AHT20 温湿度；PIR 活动（1800s 无活动触发 NO_MOTION）；SOS 按键；板载蜂鸣器 | 燃气、烟雾、门磁、水漏（本轮禁用）、摄像头 | CLIMATE/NO_MOTION/MANUAL_SOS 可告警；PIR 只输出 `lastActiveTs/countToday` |
| `dayu200-living` | 客厅主控；相机本地取帧；跌倒判定（PC CPU YOLO，非板端 NPU）；语音（本地）；`monitorOnline` | APP 无实时视频接口；物理传感器未接线，公网仍可能出现占位字段 | APP 只能看在线/监测状态与 FALL 告警证据可用性，不得显示实时视频画面；占位字段按“待确认” |
| 未知 deviceId | 待确认 | 不得默认拥有任何传感器 | 出现未核实传感器字段时显示“待确认”，不显示正常 |

有效性与显示规则（2026-10-21 审计后修正）：
- 公网 `sensors` 实际只保留 `motion{lastActiveTs,countToday}`、`door{open,lastOpenTs}`、`climate{tempC,rh}`、`gas{ok,raw}`、`smoke{ok,raw}`；
  `valid` 与 `climate.ok` 均被云端适配器剥离（adapter.js 校验但不透传），`water` 当前公网链不可表达。
- 字段存在 ≠ 传感器已安装：ESP32 report() 无条件输出 5 组 sensors，禁用通道为 `raw=0/ok=true` 占位。
- `sensors.climate.tempC/rh` 缺失 → 等待数据；两者同时为 0 → “无效/待确认”，不得显示正常。
- `sensors.gas/smoke` 只显示“原始 ADC xxx（报警未启用，未标定）”，**永不显示 ppm**；
  不得用绿色“安全/正常”表示。
- `valid=false`（若未来透传）→ 无效；`valid` 缺失 → 有效性未知，不得当成有效。
- `online=false` → 离线/历史值；`monitorOnline=0` → “在线·监测异常”；`monitorOnline=-1` → “监测状态未知”。
- 未知设备/未知字段 → “待确认”；不得默认开启全部传感器。

## 3. 目录与模块（Lead 负责，页面只读引用）

纯逻辑 TS（`entry/src/main/ets/core/**/*.ts`，可被 Node 测试编译）：
- `api/HttpTransport.ts`：`HttpRequestSpec` / `HttpRawResponse` / `HttpTransport` 接口。
- `api/Errors.ts`：`ApiErrorKind` 常量、`ApiError`、`ApiResult<T>`。
- `api/Contracts.ts`：DTO 类 + `parseLogin/parseOverview/parseRooms/parseDevices/parseAlerts/parseError`（忽略未知字段，字段缺失给默认值，类型错误不抛崩）。
- `api/ApiClient.ts`：`ApiClient`（构造 `baseUrl, HttpTransport`），方法 `login/overview/rooms/devices/alerts/ack/evidenceMeta`。
- `session/SessionCore.ts`：`SessionCore`（token、expiresAt、guardianId、`isExpired(now)`、`clear()`）。
- `capability/DeviceCapabilities.ts`：`SensorKind`、`SensorTileState`、`CapabilityProfile`、`resolveCapability(deviceId)`、`capabilitySummary`、`formatRawAdc`。
- `view/Models.ts`：`SensorView`、`DeviceView`、`RoomView`、`AlertView`、`OverviewView`、`ContactView`、`NetworkState`。
- `view/ViewMapper.ts`：`mapDevices`、`mapRooms`（按 roomId 关联）、`mapAlerts`、`mapOverview`、`mapContacts`。
- `polling/Poller.ts`：非重叠轮询器 `Poller(intervalMs, tick)`：`start/stop/isRunning`；上一次 tick 未完成不重入；stop 后不再 tick。
- `util/Json.ts`：安全解析/取值工具。

平台适配（`.ets`）：
- `net/HarmonyHttpTransport.ets`：`@kit.NetworkKit` 实现 `HttpTransport`；连接/读超时；返回 status/bodyText/retryAfter。
- `auth/TokenVault.ets`：`@kit.AssetStoreKit` 安全存储 token；不可用则仅内存；返回模式 `'secure'|'memory'`。
- `service/GuardianService.ets`：唯一页面入口（见 §4）。

## 4. AppStorage 键与 GuardianService API（冻结）

页面通过 `@StorageLink` 读取：

| Key | 类型 | 含义 |
|---|---|---|
| `gv.devices` | `DeviceView[]` | 真实设备（含能力映射后的 SensorView） |
| `gv.rooms` | `RoomView[]` | 真实房间 |
| `gv.alerts` | `AlertView[]` | 真实告警 |
| `gv.overview` | `OverviewView` | 真实首页统计 |
| `gv.contacts` | `ContactView[]` | 真实联系人（可选） |
| `gv.netStatus` | `string` | `'unknown'/'loading'/'ok'/'partial'/'offline'/'error'/'unauthorized'` |
| `gv.netMessage` | `string` | 安全用户文案（如“网络不可用，显示上次数据”） |
| `gv.lastUpdatedAt` | `number` | 最近一次成功刷新的时间（13 位 ms） |
| `gv.dataSource` | `string` | `'api'` 或 `'none'`（正式模式永不为 mock） |
| `gv.guardianId` | `string` | 当前登录 guardianId（非敏感） |
| `gv.tokenStorage` | `string` | `'secure'/'memory'` |

`GuardianService`（`service/GuardianService.ets`，静态方法）：

```ts
static init(ctx: common.Context): void;                    // 幂等，初始化会话/传输/AppStorage 默认值
static async restoreSession(): Promise<boolean>;           // 安全存储读 token + 过期检查
static async login(guardianId: string, password: string, remember: boolean): Promise<LoginOutcome>;
static async logout(): Promise<void>;                      // 清 token、停轮询、清数据状态
static isLoggedIn(): boolean;
static guardianId(): string;
static tokenStorageMode(): string;
static async refreshAll(): Promise<RefreshOutcome>;        // overview+rooms+devices+alerts 并发，单飞不重叠
static async refreshAlerts(): Promise<RefreshOutcome>;     // ACK 后轮询用
static startAutoRefresh(): void;                           // 30s，单例，不重叠
static stopAutoRefresh(): void;
static async ackAlert(alarmId: string, note: string): Promise<AckOutcome>;
static async loadContacts(): Promise<boolean>;
```

```ts
class LoginOutcome { ok=false; kind=''; message=''; retryAfterSeconds=0; }
class RefreshOutcome { ok=false; partial=false; message=''; updatedAt=0; unauthorized=false; }
class AckOutcome { accepted=false; kind=''; message=''; serverStatus=''; }
```

错误文案要求（中文、面向监护人、不暴露账号是否存在/不打印 token）：
- 401 登录：`账号或口令错误`（不区分账号/口令）；429：`尝试过多，请 N 秒后再试`；
  503：`服务端登录未配置`；超时：`请求超时，请检查网络后重试`；网络失败：`网络不可用，请检查连接`。
- 业务 401：清会话 → `gv.netStatus='unauthorized'`，页面跳登录页。
- 403：`账号已被服务端停用`。
- 404 ACK：`告警不存在或已失效`。
- 202：`命令已提交，等待设备确认`（不能显示“已确认/已静音”）。
- 轮询到 `state==='ACKED'` 才显示 `设备已确认`。

## 5. 页面改造要求

- **LoginPage**：guardianId + password。进入时 `GuardianService.init/restoreSession`，已有有效会话直接 Index。
  删除验证码登录、注册、忘记密码、评审演示一键登录；无接口的入口移除或明确标“未开放”。
  本地校验 guardianId 3–64 `[A-Za-z0-9._-]`、password 32–256（提示由项目负责人提供）；密码输入可显隐；
  成功后清空密码变量；记住登录=安全存储，否则仅内存。保留原有视觉风格。
- **Index**：初始化、检查会话、`refreshAll` + `startAutoRefresh`；`aboutToDisappear` `stopAutoRefresh`；
  监听 `gv.netStatus==='unauthorized'` 跳登录页。SOS 浮钮：本轮无远程 SOS 接口 → 禁用/隐藏/明确标“未开放”，
  不得提示“已推送/报警器已启动”。Tab 徽标 = 真实待确认告警数。
- **HomePage**：overview/rooms/devices/alerts 真实数据；显示真实更新时间；网络失败显示离线/上次数据；
  删除假的老人姓名年龄病史、46 次活动、7.5h 睡眠、98% 信号；无来源指标显示暂无数据；
  快捷入口无后端能力的一律标“未开放”。
- **MonitorPage**：真实设备/传感器瓦片；30s 自动刷新与手动刷新实际请求 API；显示真实刷新时间；
  轮询不重叠、退出清定时器；空列表空态；能力未安装/未启用/等待数据/无效/离线区分。
- **DevicePage**：真实设备；online 与 monitorOnline 分开；按 roomId 关联房间；不伪造延迟/丢包/运行时长/电量；
  csq 0–31/99 映射；无“添加设备/一键自检”能力则标未开放。
- **AlertListPage**：真实 alerts；Tab 按真实状态（待确认/等待设备确认/已确认/全部）；空态；禁止 Mock 回退。
- **AlertDetailPage**：按 alarmId 从 `gv.alerts` 查找；找不到显示“告警不存在或已失效”，禁止取第一条 Mock。
  处置表单只保留 note + 提交 ACK；删除“电话联系/上门/归档”等无后端能力的成功宣称。
  ACK 状态机：`idle → submitting → submitted(PENDING，等待设备回执) → confirmed(仅服务端 ACKED)`；
  失败/超时/404 不本地归档；按钮防重复；202 后轮询 `refreshAlerts`；超时明确“等待超时，仍未收到设备确认”。
  时间线只显示真实时间点（createdAt / 本机提交时间 / acknowledgedAt），不编造“已推送 N 端”。
- **ProfilePage**：显示真实 guardianId、token 存储模式、真实设备/告警数、真实联系人（若 `contacts` 已加载）；
  删除假老人档案/病史/社区/协同成员成功宣称；通知/推送/修改密码/注销/切换账号等无后端能力的入口标“未开放”；
  退出登录真实清会话并回登录页。
- **StatsPage**：只展示能从真实 alerts 推导的统计（近 7 天告警数）；活动曲线、睡眠、AI 洞察无数据源 → 暂无数据/隐藏；
  导出标“未开放”。
- **LogPage**：真实 alerts 按日期分组；空态；不 import MockData。
- **RegisterPage/ForgotPage/ChangePwdPage/CancelAccountPage**：无对应后端接口 → 页面明确“未开放”，
  不得再调用 `AccountStore`/`SmsService`；入口从 Login/Profile 移除或标注。
- **组件**：`SensorCard` 适配 `SensorView`（状态/值文本/有效性）；`AlertItem` 适配 `AlertView`；
  `StatusCard` 输入由真实状态推导；`SosFloatingButton` 明确未开放。

## 6. 测试（Node，`APP/ElderlyCareGuardian/tests/`）

测试必须编译实际 `core/**/*.ts` 源码（不复制逻辑），使用 `node:test` + `assert`，
用注入的 fake `HttpTransport` 提供“明确标注的模拟 API 响应”，不得写成真实公网/实体设备 PASS。
至少覆盖（详见任务卡）：
登录成功/失败/429/过期/网络失败；空列表/未知字段；roomId 关联；厨房无门磁 PIR、卫生间无燃气烟雾、
未知能力不默认；invalid/missing/offline 不显示正常；MQ raw 不显示 ppm、报警禁用可见；
ACK 202 仍等待、仅 ACKED 才成功；ACK 失败不归档、404 不用 Mock；轮询不重叠/stop 清理；
正式模式无 MockData 回退（行为测试 + 静态守卫）。

运行方式（Lead 统一提供脚本）：
```
node "D:\DevEcoStudio\DevEco Studio\tools\hvigor\hvigor\node_modules\typescript\bin\tsc" -p tests/tsconfig.json
node --test tests/
```

## 7. 构建

```powershell
$env:DEVECO_SDK_HOME='D:\DevEcoStudio\DevEco Studio\sdk'
$env:JAVA_HOME='D:\DevEcoStudio\DevEco Studio\jbr'
$env:HVIGOR_USER_HOME='<WORKSPACE>\.buildcache\hvigor'
$env:OHPM_HOME='<WORKSPACE>\.buildcache\ohpm'
Set-Location <WORKSPACE>\APP\ElderlyCareGuardian
& 'D:\DevEcoStudio\DevEco Studio\tools\hvigor\bin\hvigorw.bat' assembleHap --mode module -p product=default -p buildMode=debug --no-daemon
```
产物：`entry/build/default/outputs/default/entry-default-unsigned.hap`（构建后重算 SHA-256）。
