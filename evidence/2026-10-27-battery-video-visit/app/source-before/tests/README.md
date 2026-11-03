# 颐养守护监护人 APP · Node 行为测试（tasks/tests）

本目录是 **APP 核心纯逻辑的 Node 单元/行为测试**，由 `node:test` + `assert` 驱动，
编译并导入 `entry/src/main/ets/core/**/*.ts` 的**实际源码**（不复制业务逻辑）。

> ⚠️ 重要边界：本测试的超时/错误/HTTP 响应全部来自 `tests/fake-transport.mjs`
> 的 **SIMULATED（模拟 API 响应）**。它证明 APP 侧逻辑正确，**不等于**真实公网登录、
> 真实后端或实体设备闭环验收。真机/公网项见文末 NOT TESTED。

## 1. 环境

- Windows + Node.js **v24.19.0**（支持 `node:test`；受限沙箱内加 `--test-isolation=none`）
- DevEco Studio 自带 TypeScript **4.9.5**：
  `D:\DevEcoStudio\DevEco Studio\tools\hvigor\hvigor\node_modules\typescript\bin\tsc`
- 无需 npm install；不依赖任何第三方测试库。
- 不运行 hvigor / hvigorw（HAP 构建由 Lead 负责，避免并发构建冲突）。

## 2. 精确命令

```powershell
# 1) 用 DevEco TypeScript 4.9.5 编译实际 core 源码到 tests/build（commonjs/ES2020）
node "D:\DevEcoStudio\DevEco Studio\tools\hvigor\hvigor\node_modules\typescript\bin\tsc" `
  -p "<WORKSPACE>\APP\ElderlyCareGuardian\tests\tsconfig.json"

# 2) 运行全部测试（Windows：先进入 tests 目录再 node --test）
#    受限沙箱内必须加 --test-isolation=none，否则子进程 spawn EPERM
Set-Location "<WORKSPACE>\APP\ElderlyCareGuardian\tests"
node --test --test-isolation=none

# 可选：只跑某个文件
node --test static-guard.test.mjs
```

`tests/tsconfig.json`：`rootDir=../entry/src/main/ets/core`、`outDir=./build`、
`module=commonjs`、`target=ES2020`、`strict=false` 但 `noEmitOnError=true`。
`lib` 含 `ES2020`+`DOM` 仅为让 core 的 `setTimeout/clearTimeout` 通过类型检查
（运行时是 Node 真实定时器）。测试文件直接 `require` `tests/build/**/*.js`。

## 3. 测试文件与覆盖点

| 文件 | 覆盖 |
| --- | --- |
| `api-client.test.mjs` | 登录成功解析 sessionToken/tokenType/expiresIn；401/429(Retry-After)/503/网络失败/超时/非法 JSON；业务 GET 携带 Bearer；token 为空直接 unauthorized 不发请求；401/403；ACK 202 PENDING、404/400/409/网络失败；alarmId URL 编码 |
| `session.test.mjs` | SessionCore 保存 token/expiresAt、30s 安全余量、expiresIn=0/NaN 立即过期、clear、覆盖会话 |
| `contracts.test.mjs` | DTO 解析：空列表、未知新增字段忽略（含 sensors.unknownKeys）、缺失字段默认值、类型错误不崩、evidence/ackPending、Room.devices roomId |
| `capability.test.mjs` | esp32-kitchen（无 PIR/门磁/水漏，gas/smoke 原始 ADC+报警未启用）、esp32-bath（无 gas/smoke/门磁、水漏未启用）、dayu200-living（APP 无实时视频接口）、未知 deviceId 全部待确认不默认、formatRawAdc 无 ppm |
| `view-mapper.test.mjs` | climate 缺失→等待数据、0/0 占位→无效、valid=false→无效、valid 缺失→未知、online=false→离线、monitorOnline=0→监测异常/-1→未知；MQ valueText 无 ppm 且报警未启用；能力门控（厨房无 PIR/门磁/水漏、卫生间无 gas/smoke）；未知设备字段→待确认；roomId 关联（中文房间名不参与，不同 roomId 不误绑，未分配合成分组）；ACK 状态映射；countNeedsAttention/findAlert |
| `ack-state.test.mjs` | 202 PENDING→首轮轮询仍“等待设备确认”→服务端 ACKED 才“设备已确认”；404→not_found 且 findAlert=null（不存在/已失效）；400/409/网络/超时均不本地 ACKED；Outcomes 默认值 |
| `poller.test.mjs` | immediate 首次执行、interval 后首次执行、tick 未完成不重入（并发≤1）、start 幂等、stop 后不再 tick、可重启 |
| `static-guard.test.mjs` | 正式源码无 MockData/mock-token/INGEST_KEY//internal/v1；无假成功文案（SOS 已推送/本地声光报警器已启动/已联系全部联系人/处置已归档）；“设备已确认”只在含 ACKED 的文件；旧演示/账号文件已删除；仅 `https://api.luxunacc.xyz`；LoginPage 走 GuardianService 且不含 AccountStore/SmsService/Session；页面不直连 ApiClient/传输层；密码不落盘不进日志；TokenVault 用 AssetStoreKit 不用 Preferences/SQLite；仅 net/HarmonyHttpTransport 使用 @kit.NetworkKit；日志不打印凭据；AlertDetailPage 从真实 gv.alerts 查找 |
| `defect-sensor.test.mjs` | 缺陷 1：valid/ok 缺失→有效性未知+中性色；valid=false/ok=false→读数无效+上次读数+warning；离线有/无读数→离线·上次读数/离线·暂无数据；离线不抹告警；0℃ 且湿度非零不判失败；valid=true 仅“读数有效”；MQ 无 ppm；能力门控；colorToken 语义 |
| `defect-session.test.mjs` | 缺陷 2：A 请求→登出→A 返回不提交；A→登录 B→A 返回不覆盖 B；A 的 401/403 不清 B；按会话代际单飞（A 结束不清 B 锁）；Token 安全存储串行队列顺序（慢 save 不越过 clear/新 save） |
| `defect-poller.test.mjs` | 缺陷 3：在途 tick 期间 stop/start 最大并发=1；多次 stop/start 不累积；旧 resolve/reject 后新代继续；旧代完成不破坏新代；immediate/延迟两种模式；stop 后不再 tick |
| `defect-static.test.mjs` | 平台层接线：GuardianService 使用 RequestGuard/SessionCommit/ScopedSingleFlight 与 SessionRecoveryCoordinator；restore 走统一编排器且 TokenVault.loadSecure 只在 adapter；SensorCard 用 colorToken 选色；AlertDetail disposed 后忽略 ACK 回调；Poller.stop 不清 inFlight |
| `defect-restore.test.mjs` | 恢复竞争：401/登出后清除延迟期间 restore blocked 且不读取；旧 restore→B 登录 stale 不覆盖；旧过期清理不与 B save 交错/不删 B 记录；登录中 restore blocked；有效/过期/读取失败/清除失败；提交前生命周期复核 |
| `defect-restore-expiry.test.mjs` | 提交时到期边界：开始有效但读取/排队期间到期；读取完成时有效但提交前到期；剩余 <30s、恰好 30s、>30s；NaN/Infinity/0/负数；服务级 restorer 返回 true 时 SessionCore 实际有效；旧恢复期间 B 登录成功不覆盖 |
| `demo-mode.test.mjs` | 独立演示：快照含示例设备/房间/告警/联系人、无 token/expiresAt；Controller enter/exit 仅进程内；演示模块不依赖 GuardianService/ApiClient/TokenVault/Poller；仅 LoginPage 显式 enter；Index demo 跳过轮询；AlertDetail demo 禁用 ACK；Profile 演示身份明确 |
| `health-profile.test.mjs` | 健康资料（§1）：表单校验边界（年龄 1–130、身高 50–250、体重 20–300、血压 60–260/40–160 且 SYS>DIA、血糖 1.0–40.0 一位小数、睡眠/运动整数与小数、各文本长度、文本总字节 4 KiB、空表单）；`toProfileBody/toProfileJson` 只提交已填写字段且不含 `updatedAt`；三条固定文案逐字比对；急症词检测；`parseHealthProfileResponse` 空资料/缺字段/非法结构/未知字段/类型错误；AppStorage 键名；静态守卫（页面不直连 ApiClient、两条固定提示、入口注册、GuardianService 登出/切换会话清理资料与建议内存/AppStorage） |
| `health-advice.test.mjs` | 健康建议（§2.3/§5）：`parseHealthAdviceResponse` 缺段/超长/元素非法/缺免责声明/红线词→null，服务端 disclaimer 被固定常量覆盖；`healthAdviceMessage`/`healthAdviceFlowForError` 文案映射（超时/空资料/未配置/失败/未授权/演示）；`ApiClient` GET/PUT `/api/v1/health-profile`（12000ms）与 POST `/api/v1/health-advice`（20000ms）的 Bearer、请求体白名单、401/409/502/503/504/网络/超时/非法 JSON，失败时 `value=null` 绝不返回伪造建议；固定 4 段标题与固定免责声明；静态守卫（失败分支不写 `gv.healthAdvice`、演示模式不联网） |
| `sos-map.test.mjs` | 随身求助地图（MANUAL_SOS）：WGS84→GCJ-02 天安门已知向量（容差 1e-4）与“只转换一次”（传给 Web 的 JSON 已是 GCJ-02，`map.html` 无转换代码）；主数据源 `GET /api/v1/location`（deviceId=esp32-sos）解析/选最新点/缺 deviceId/fixTime 为 0；APP 侧 120s 状态边界（120000ms 仍有效、120001ms 过期）、无记录→暂无定位；fixTime 与 alert.createdAt ±5s 的四种“求助时刻位置/求助后更新”情形；sosLocation 兼容解析与缺失不崩；定位年龄/本地时间格式化；`ApiClient.locations` 的 Bearer/200/空列表/401/非法 JSON/网络失败；`map.html` 静态守卫（无远程 JS/CDN/地图 Key、高德瓦片、拖拽/缩放/回到求助位置、瓦片失败占位网格、无定位不显示假位置、`SosMap.update` 接口）；告警详情页接线（仅 MANUAL_SOS 显示、既有 ACK/证据/处置/时间线顺序不变、页面不直连 ApiClient、不重复坐标转换） |
| `inventory.test.mjs` | 家庭设备清单（2026-10-27）：恰好 4 台已核实设备且来源可追溯；厨房/卫生间/客厅/随身求助名称不被后端房间名覆盖；后端隔离测试/历史设备（2×`esp32-sos-isolated-test*`、`yed-home-gateway`、`dayu200-01`）被隔离、不生成传感器、不计入房间/统计；`householdRooms` 只保留含家庭设备的房间；电量全部 `not-supported` 且文案“未接入电量检测”、无百分比；未分配房间不伪造默认房间；离线语义保留 |
| `profile-summary.test.mjs` | 「守护档案」摘要（2026-10-27）：无资料 `present=false`；已保存字段原样展示、缺失字段“未填写”、不补 0；血压只有一半时不得拼成“135/未填写”；不产生接口不存在的姓名/社区字段；饮食口味枚举按中文标签显示 |
| `static-guard.test.mjs`（2026-10-27 新增段） | 真实能力静态守卫：设备页“该设备未接入电量检测”且全仓库无伪造电量百分比；设备页区分“未纳入监护的后端记录”且不删除；我的页“守护档案”读 health-profile 且不再写“未接入/无对应接口”；视频探望明确“未接入”且无“正在直播/可观看”冒充；能力表含 SR312/GPIO38/GPIO14/核验日期且不再写厨房无 PIR/门磁 |

测试使用明显假的字符串（如 `fake-token-000`、`fake-password-...`），不使用任何真实凭据。

## 4. 当前结果（最终）

环境：Node v24.19.0 / TypeScript 4.9.5（DevEco 自带，实际 core 源码编译）。
2026-10-21 完成真实 API 接入、Codex 三项缺陷修复、会话恢复竞争修复，以及“恢复提交时到期”边界修复；
2026-10-22 增加独立演示模式与隔离测试；2026-10-27 增加「健康评估」（两页健康资料表单 +
健康科普建议结果面板 + 健康资料/建议 API 层）核心逻辑与静态守卫测试；
2026-10-27 再增加「随身求助地图」（MANUAL_SOS：`/api/v1/location` esp32-sos 最新点、
APP 侧 120s 状态、求助时刻/求助后更新判定、GCJ-02 单次转换、本地自绘瓦片地图静态守卫）；
2026-10-27 再增加「真实能力补齐与界面整改」核心逻辑与静态守卫：家庭设备清单隔离
（`inventory.test.mjs`）、“守护档案”摘要未填写语义（`profile-summary.test.mjs`）、
能力表 2026-10-27 在板固件更新（厨房 PIR/门磁、卫生间门磁、esp32-sos）、电量“未接入”语义、
视频探望未接入、未识别后端记录不计入统计。

```
$ node "D:\DevEcoStudio\DevEco Studio\tools\hvigor\hvigor\node_modules\typescript\bin\tsc" `
    -p "<WORKSPACE>\APP\ElderlyCareGuardian\tests\tsconfig.json"
[tsc exit: 0]

$ Set-Location "<WORKSPACE>\APP\ElderlyCareGuardian\tests"; node --test --test-isolation=none
# tests 457
# pass 457
# fail 0
```

（本轮新增 `inventory`、`profile-summary`、5 项真实能力静态守卫、能力表/视图映射更新断言；
434 + 23 = 457 项全部通过，既有断言按 2026-10-27 在板硬件事实更新，未放宽“不得伪造”类断言。
日志：`competition/evidence/2026-10-27-real-capability-app/logs/app-node-test.log`。）

## 5. SIMULATED / NOT TESTED

- **SIMULATED（模拟，不作真实 PASS）**：所有 HTTP 状态码、JSON、timeout、network error
  均由 `tests/fake-transport.mjs` 提供；响应内容按 `REAL-API-INTEGRATION-SPEC.md`、
  `competition/docs/APP-API-v1.md` 与 `competition/docs/AI-HEALTH-ASSESSMENT-SPEC.md` 手写，
  不代表任何真实服务器返回。
- **NOT TESTED（本测试不覆盖，需真机/公网联合验收）**：
  - 真实公网登录 `POST https://api.luxunacc.xyz/api/v1/auth/app`（无合法会话/凭据）；
  - 真实后端 overview/rooms/devices/alerts 数据与实体设备（esp32-kitchen / esp32-bath / dayu200-living）在线行为；
  - 真实公网 `GET /api/v1/location` 与 `esp32-sos` 定位记录的 120s 状态时效（本目录只有 SIMULATED 响应）；
  - 真实高德栅格瓦片 `webrd0{1..4}.is.autonavi.com` 在目标网络下可达、`rawfile/map.html` 在真机
    WebView（ArkWeb）内的拖拽/缩放/marker/瓦片失败占位与 GCJ-02 叠加精度；
  - 真实健康资料接口 `GET/PUT /api/v1/health-profile` 与 AI 建议 `POST /api/v1/health-advice`
    （需要有效 `DEEPSEEK_API_KEY` 与真实后端；本目录全部为 SIMULATED 响应）；
  - HarmonyOS 真机 UI（LoginPage/Index/MonitorPage/HealthAssessmentPage/AlertDetailPage 地图卡等 .ets 页面）与
    `@kit.NetworkKit` 实际超时、两步表单输入与滚动交互；
  - `@kit.AssetStoreKit` 安全存储真实可用性/降级；
  - 30s 自动轮询在真机生命周期（aboutToDisappear）下的行为；
  - HAP 构建与安装（由 Lead 运行 hvigor/覆盖安装，本目录只做纯逻辑与源码静态测试）。
- 静态守卫只是源码扫描，不能证明运行时行为；行为测试只覆盖 `core/**/*.ts` 纯逻辑，
  `.ets` 平台适配层（GuardianService/HarmonyHttpTransport/TokenVault/页面）不在 Node 编译范围内。
