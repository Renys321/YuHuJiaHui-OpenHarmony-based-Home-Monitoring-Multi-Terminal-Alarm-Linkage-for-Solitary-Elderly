# 颐养守护监护人 APP · Node 行为测试（tasks/tests）

本目录是 **APP 核心纯逻辑的 Node 单元/行为测试**，由 `node:test` + `assert` 驱动，
编译并导入 `entry/src/main/ets/core/**/*.ts` 的**实际源码**（不复制业务逻辑）。

> ⚠️ 重要边界：本测试的超时/错误/HTTP 响应全部来自 `tests/fake-transport.mjs`
> 的 **SIMULATED（模拟 API 响应）**。它证明 APP 侧逻辑正确，**不等于**真实公网登录、
> 真实后端或实体设备闭环验收。真机/公网项见文末 NOT TESTED。

## 1. 环境

- Windows + Node.js **v22.23.2**（支持 `node:test`）
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
Set-Location "<WORKSPACE>\APP\ElderlyCareGuardian\tests"
node --test

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

测试使用明显假的字符串（如 `fake-token-000`、`fake-password-...`），不使用任何真实凭据。

## 4. 当前结果（最终）

环境：Node v22.23.2 / TypeScript 4.9.5（DevEco 自带，实际 core 源码编译）。
2026-10-21 完成真实 API 接入、Codex 三项缺陷修复、会话恢复竞争修复，以及本轮“恢复提交时到期”边界修复后的最终结果：

```
$ node "D:\DevEcoStudio\DevEco Studio\tools\hvigor\hvigor\node_modules\typescript\bin\tsc" `
    -p "<WORKSPACE>\APP\ElderlyCareGuardian\tests\tsconfig.json"
[tsc exit: 0]

$ Set-Location "<WORKSPACE>\APP\ElderlyCareGuardian\tests"; node --test
# tests 166
# pass 166
# fail 0
# duration_ms 836.5176
```

（多次运行 828–837 ms，数量与通过结果稳定。）

拆分：上一轮 156 项全部通过（无回归）；本轮新增 `defect-restore-expiry` 10 项全部通过；合计 166。
用例数增长均为新增缺陷回归覆盖，不是放宽或删除旧断言。

## 5. SIMULATED / NOT TESTED

- **SIMULATED（模拟，不作真实 PASS）**：所有 HTTP 状态码、JSON、timeout、network error
  均由 `tests/fake-transport.mjs` 提供；响应内容按 `REAL-API-INTEGRATION-SPEC.md` 与
  `competition/docs/APP-API-v1.md` 手写，不代表任何真实服务器返回。
- **NOT TESTED（本测试不覆盖，需真机/公网联合验收）**：
  - 真实公网登录 `POST https://api.luxunacc.xyz/api/v1/auth/app`（无合法会话/凭据）；
  - 真实后端 overview/rooms/devices/alerts 数据与实体设备（esp32-kitchen / esp32-bath / dayu200-living）在线行为；
  - HarmonyOS 真机 UI（LoginPage/Index/MonitorPage 等 .ets 页面）与 `@kit.NetworkKit` 实际超时；
  - `@kit.AssetStoreKit` 安全存储真实可用性/降级；
  - 30s 自动轮询在真机生命周期（aboutToDisappear）下的行为；
  - HAP 构建与安装（由 Lead 运行 hvigor，本目录不执行构建）。
- 静态守卫只是源码扫描，不能证明运行时行为；行为测试只覆盖 `core/**/*.ts` 纯逻辑，
  `.ets` 平台适配层（GuardianService/HarmonyHttpTransport/TokenVault/页面）不在 Node 编译范围内。
