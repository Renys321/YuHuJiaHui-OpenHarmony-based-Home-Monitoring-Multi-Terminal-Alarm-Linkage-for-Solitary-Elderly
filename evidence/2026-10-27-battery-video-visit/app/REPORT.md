# 手机监护 APP · 电量展示 + 视频探望 交付报告（1.0.9）

- 日期：2026-10-27（Asia/Shanghai）
- 工作区：`<WORKSPACE>`；APP：`APP/ElderlyCareGuardian`，包名 `com.example.program_04`
- 版本：**1.0.9 / 1000009**（`AppScope/app.json5:6`；LoginPage/ProfilePage 版本文案同步 v1.0.9）
- 唯一契约：`CONTRACTS/BATTERY-CHAIN-CONTRACT.md`（§6 APP）与 `CONTRACTS/VIDEO-VISIT-CONTRACT.md`（§3 APP）
- 分级口径：**LOCAL**=实现+本地测试+构建；**DEPLOYED-EMU**=已覆盖安装到模拟器、可启动并冒烟运行；**REAL(Lead)**=真实 relay+DAYU200 播放的正式验收由 Lead 执行；**BLOCKED**=受硬件/部署限制

## 0. 一句话结论

- **电量**：APP 已按契约逐台显示真实状态（固定供电 / 真实电压+百分比 / 未标定 / 过期 / 未上报 / 离线），全仓库无伪造百分比；esp32-sos 明确“未接入电量检测（无采样模块）”+ 补齐条件。真实电池测量因无实物电池/分压/ADC 接线 **BLOCKED-BY-HARDWARE**（BATTERY-CHAIN-CONTRACT §7）。
- **视频探望**：首页入口改为 **enabled=true「可用」**，新页面用现有会话 token 申请 relay 一次性 ticket、`@ohos.net.webSocket` 收二进制 JPEG、`@ohos.multimedia.image` 解码 PixelMap 渲染，显示帧号/fps/最近帧时间；失败/重连/主动结束/离开页面停止均已实现。**APP 侧已在本机用 Lead 的 relay + DAYU200 真机推流冒烟到真实画面（第 10→188 帧、3.4–4 fps、640×480、画面逐帧变化）**；正式端到端验收由 Lead 执行。
- 测试：`tsc` exit 0；Node 行为测试 **502/502 PASS**；`assembleHap` **BUILD SUCCESSFUL**；模拟器覆盖安装成功，`bm dump` 验到 `versionName 1.0.9 / versionCode 1000009`。

---

## 1. 任务 A：电量展示（BATTERY-CHAIN-CONTRACT §6）

### 1.1 改动清单

| 文件:行 | 改动 |
|---|---|
| `entry/src/main/ets/core/api/Contracts.ts:92` | 新增 `BatteryDto`（source/present/valid/mv/percent/low/calibrated/reason/sampledAt，字段缺失保持 null，不做 0/100 默认） |
| `Contracts.ts:119` / `:140` | `SensorsDto.battery`、`DeviceDto.battery: BatteryDto \| null`（兼容旧网关嵌套） |
| `Contracts.ts:243` | 新增 `nullableIntInRange`（整数+范围，越界/非整数→null，不钳位） |
| `Contracts.ts:244` | 新增 `parseBattery`：`battery` 非对象/null/package 未知 source → 整体 null；逐字段严格校验；`reason` 仅 `[A-Z_]{0,16}`；`sampledAt>0` |
| `Contracts.ts:361` | `parseDevice`：顶层 `battery` 优先，缺失回退 `sensors.battery` |
| `entry/src/main/ets/core/inventory/DeviceInventory.ts:35` | `BatterySource`（fixed / battery-capable / unknown）+ `BatteryCapability{source,note,requiredHardware}` |
| `DeviceInventory.ts:86-117` | 台账：kitchen/bath/dayu200-living=`fixed`；esp32-sos=`battery-capable`（含“未接入电量检测（无采样模块）”“补齐条件”） |
| `DeviceInventory.ts:119` | 非家庭清单但契约要求登记：`esp32-node-wearable`=`battery-capable`（不参与房间/在线统计） |
| `DeviceInventory.ts:157` | `batteryCapabilityFor`：家庭台账 → 已声明板卡 → unknown（未登记设备不给数值） |
| `entry/src/main/ets/core/view/Models.ts:104` | 新增 `BatteryView`（status/text/detail/alert/hasPercent/mv/percent/sampledAt/sourceText）与 `BatteryStatus` 五态 |
| `Models.ts:153` | `DeviceView.battery: BatteryView`（替换旧 `batterySupported/State/StateText/Detail`） |
| `entry/src/main/ets/core/view/ViewMapper.ts:443` | `BATTERY_STALE_AFTER_MS=120s`；`formatClockHm`（0/非法→空串，不显示 1970） |
| `ViewMapper.ts:483` | 新增 `mapBattery`：fixed → real/stale/missing/offline 全部规则；percent 仅 `calibrated=true` 才展示；`low=true` 追加“电量偏低”并告警 |
| `ViewMapper.ts:582` | `mapDevice` 每台设备生成 `view.battery` |
| `entry/src/main/ets/pages/DevicePage.ets:648` | `batteryBlock` 改为逐台渲染 `d.battery.text/detail`（低电量橙色；固定供电/未知灰色），删除统一“该设备未接入电量检测”写死文案 |

### 1.2 实际展示文案（模拟器实拍见 `SMOKE-ACCEPTANCE-APP.md`）

| 状态 | 判定 | 主文案 |
|---|---|---|
| fixed | 台账 fixed（厨房/卫生间/DAYU200） | `固定供电，无电池电量数据` |
| real | battery 有效 + `lastSeenTs` 距今 ≤120s | `3.85 V · 约 42% · 更新于 HH:mm`（未校准→`3.85 V · 未标定 · 更新于 HH:mm`；low→追加`电量偏低`） |
| stale | 设备在线但 `lastSeenTs` 距今 >120s | `电量数据过期（最后更新 HH:mm）` |
| missing | battery-capable 但无有效上报 / valid=false / present=false / mv=0 | `电量未知（设备未上报电量）` |
| offline | 设备 `online=false` | `设备离线，电量未知` |

- esp32-sos 详情固定包含：`未接入电量检测（无采样模块）…` + `补齐条件：1S 锂电 + TP4056 + 100k/100k 分压到 ADC1（避开 GPIO4/GPIO5）…`
- DAYU200 详情明确：系统 BatteryService 容量为模拟值，**APP 不使用**。
- 全仓库静态守卫禁止“电量 xx%”“battery=100”类伪造串，并禁止把 `csq` 当电量（`tests/static-guard.test.mjs:427`）。

### 1.3 真实测量边界（如实）

- 本期无实物电池/分压/ADC 接线 → **真实电压/百分比/低电量阈值无法验收（BLOCKED-BY-HARDWARE）**。
- 当前生产设备全部离线且无 battery 字段，APP 显示固定供电/电量未知，符合契约“无数据不得显示伪造值”。
- 硬件接好后的验收项（万用表 ±50mV、放电曲线、断分压→未知、low 阈值）见 BATTERY-CHAIN-CONTRACT §7，由 Lead 执行。

---

## 2. 任务 B：视频探望页（VIDEO-VISIT-CONTRACT §3）

### 2.1 改动清单

| 文件:行 | 改动 |
|---|---|
| `entry/src/main/ets/core/video/VideoConfig.ts:9` | relay 默认 `http://10.0.2.2:9443` + AppStorage `video.relayBase` 覆盖；`normalizeRelayBase/relayBaseOrDefault/relayHttpUrl/wsUrlFor`（http→ws、https→wss，非法基址返回空串）；隐私文案常量；帧大小/超时/重连上限常量 |
| `entry/src/main/ets/core/video/FrameDecodeCore.ts:101` | `inspectJpegFrame`：长度 4096–1048576、SOI `FFD8`、EOI `FFD9`、SOF 宽高解析；`FrameRateTracker`（滑动窗口 fps）、`FrameSequenceTracker`、拒绝原因→文案 |
| `core/video/VideoRelay.ts:43` | ticket 响应严格解析（16–256 安全字符、缺 wsPath 按 ticket 兜底）；`ticketOutcomeForResponse`（401/403/429/5xx/超时/网络/非法 JSON 文案）；`endOutcomeForResponse`；`parseControlMessage`（ready/error/resumed/heartbeat）；`shouldRequestVideoSession`（无 token 不发请求） |
| `core/video/VideoSessionCore.ts:47` | 纯状态机 idle→requesting→connecting→waiting-first-frame→playing→reconnecting→failed/ended；重连退避 1/2/4s、最多 3 次；首帧 15s 超时；播放主文案 `实时画面 · 已接收 N 帧 · M fps` |
| `core/video/VideoVisitController.ts:81` | 编排器（端口注入 relay/socket/scheduler；代际过滤迟到回调）；断线自动重连、非法帧丢弃、错误码失败、主动 stop 关 WS + end |
| `entry/src/main/ets/net/HarmonyVideoSocket.ets:11` | 唯一 WS 适配层：`@kit.NetworkKit` webSocket（等价 `@ohos.net.webSocket`），on open/message(string\|ArrayBuffer)/close/error；close 时解绑 listener |
| `entry/src/main/ets/service/GuardianService.ets:304` | `requestVideoTicket(relayBase)`：现有内存会话 token → `POST /video/session`（Bearer；token 不返回/不打印）；无 token 直接 `no_token` 不发请求 |
| `GuardianService.ets:329` | `endVideoSession(relayBase)`：`POST /video/session/end` |
| `entry/src/main/ets/service/VideoVisitService.ets:49` | 平台装配：解析 relay 基址、组装 controller、`start/retry/stop/snapshot` |
| `entry/src/main/ets/pages/VideoVisitPage.ets:27` | 新页面：加载/播放/失败+重试/重连/主动结束；`Image(this.pixelMap)` 渲染真实解码帧；帧号/fps/帧尺寸/最近帧时间；固定隐私文案；`onPageHide`+`aboutToDisappear` 关流 |
| `VideoVisitPage.ets:132` | `ImageSource.createPixelMap → PixelMap`，上一帧 release；解码忙时只保留最新帧；解码失败不显示伪画面 |
| `entry/src/main/resources/base/profile/main_pages.json:8` | 注册 `pages/VideoVisitPage` |
| `entry/src/main/ets/pages/HomePage.ets:412` | 删除旧“视频探望 · 未接入”弹窗，改为 `pushUrl({url:'pages/VideoVisitPage'})` |
| `HomePage.ets:659` | 入口 `quickAction(..., '视频探望', '可用', true, ...)`；底部说明改为“本次会话实时预览（不录像、不留存）” |
| `AppScope/app.json5:6` | 1.0.8/1000008 → **1.0.9/1000009** |

### 2.2 页面状态（契约 §3 对齐）

| 状态 | 展示 |
|---|---|
| 加载/等待 | `正在申请视频会话…` → `正在连接视频中继…` → `已连接，等待第一帧画面…`（LoadingProgress，无假画面） |
| 播放 | `实时画面 · 已接收 N 帧 · M fps` + 左上帧号/fps/`640×480` + `最近帧 HH:mm:ss`；只有校验通过的帧才进入 |
| 失败 | 错误文案（401/超时/网络/DAYU_DOWN/NO_AGENT/BUSY/首帧超时/配置）+ 错误类型 + `重新连接` 按钮；不出现“正在直播” |
| 重连 | `连接中断，正在重连…（第 n/3 次）`，退避 1/2/4s；每次重连前先关闭旧 WS、重新申请一次性 ticket |
| 主动结束 | `结束探望` → 关 WS → `POST /video/session/end` → 返回首页 |
| 隐私 | 固定文案 `仅本次会话实时查看，不录像、不留存、不录音` |

- 无 token：页面进入即失败提示“登录已失效，请重新登录后再试探望”，**不发任何视频请求**（GuardianService 在请求前判断）。
- `onPageHide` 与 `aboutToDisappear` 均调用 `stopVisit()`（幂等），关 WS + end，之后迟到回调/帧全部丢弃。
- 未使用静态图/占位帧/“正在直播”文案；静态守卫检查 `Image(this.pixelMap)`、无 `app.media.video/live` 静态帧。

---

## 3. 测试

### 3.1 命令与结果（LOCAL）

```powershell
node "D:\DevEcoStudio\DevEco Studio\tools\hvigor\hvigor\node_modules\typescript\bin\tsc" -p "<WORKSPACE>\APP\ElderlyCareGuardian\tests\tsconfig.json"
# exit 0（logs/app-tsc.log）

Set-Location <WORKSPACE>\APP\ElderlyCareGuardian\tests
node --test --test-isolation=none
# tests 502 / pass 502 / fail 0（logs/app-node-test.log）
```

| 测试文件 | 覆盖 | 结果 |
|---|---|---|
| `tests/battery.test.mjs`（新增 22） | BatteryDto 严格解析（缺失/null/未知 source/范围/非整数/mv=0/嵌套兼容/顶层优先）；BatteryView 五态与 120s 边界、校准门控、low 告警、无伪造 0%/100% | PASS |
| `tests/video-frame.test.mjs`（新增 10） | JPEG 头尾/尺寸/大小校验、异常帧拒绝、fps/序号、relay 基址与 ws/wss、ticket 解析、401/429/5xx/超时/网络文案、控制消息、隐私文案 | PASS |
| `tests/video-session.test.mjs`（新增 14） | fake relay+WS+scheduler：成功链路、401、超时、无 token 不建 WS、非法 relay 地址、断线重连 1/2/4s×3 次、主动结束/离开停止、迟到回调丢弃、非法帧丢弃、控制错误、首帧 15s 超时、手动重试、resumed | PASS |
| `tests/inventory.test.mjs`（更新） | 4 台家庭设备台账；电量能力 fixed vs battery-capable（含 wearable 声明）；sos 视图“未上报/无采样模块/补齐条件” | PASS |
| `tests/static-guard.test.mjs`（更新 2 项 + 网络栈/URL 规则） | 逐台电量真实状态且无伪造百分比/不把 csq 当电量；首页视频入口 `enabled=可用`、无旧“未接入”弹窗；页面 `Image(pixelMap)`/onPageHide/aboutToDisappear/隐私文案；GuardianService 无 token 先拒绝；main_pages 注册；网络栈仅 net/ 两个适配器；relay 默认地址只在 VideoConfig 声明 | PASS |

> 既有测试未放宽：`fake-transport.mjs` 的 SIMULATED 响应不当作真实 PASS；真实 relay/相机不在 Node 测试范围内。

### 3.2 构建（LOCAL）

```powershell
Set-Location <WORKSPACE>\APP\ElderlyCareGuardian
$env:DEVECO_SDK_HOME='D:\DevEcoStudio\DevEco Studio\sdk'; $env:JAVA_HOME='D:\DevEcoStudio\DevEco Studio\jbr'
$env:HVIGOR_USER_HOME='<WORKSPACE>\.buildcache\hvigor'; $env:OHPM_HOME='<WORKSPACE>\.buildcache\ohpm'
& 'D:\DevEcoStudio\DevEco Studio\tools\hvigor\bin\hvigorw.bat' assembleHap --mode module -p product=default -p buildMode=debug --no-daemon
# BUILD SUCCESSFUL in 13 s 677 ms（完整日志 app/assembleHap-1.0.9.log）
```

- 产物（仓库内）：`entry/build/default/outputs/default/entry-default-unsigned.hap`
- 交付副本：`app/guardian-battery-video-1.0.9-unsigned.hap`，**3,579,813 B**
- **SHA-256：`31C5634E0653AFCEC1D2F435AC3A10B6629178A3AAAC23DEF6268B741B9A5A87`**（`app/HAP-SHA256-1.0.9.txt`）
- 构建仅有既有 ArkTS WARN（`Function may throw exceptions`，均为此前已存在的页面/router 调用），未新增视频相关错误/WARN；未配置签名 → 输出 unsigned（模拟器可装）。

### 3.3 安装（DEPLOYED-EMU）

```powershell
<WORKSPACE>\tools\hdc\hdc.exe -t 127.0.0.1:5555 install -r app/guardian-battery-video-1.0.9-unsigned.hap
# [Info] ... msg:install bundle successfully. / AppMod finish（app/install-1.0.9.log）
```

- `bm dump -n com.example.program_04`：`"versionName": "1.0.9"`、`"versionCode": 1000009`（`app/bm-dump-1.0.9.txt`）；覆盖安装未清数据（`firstInstallTime` 保留，`updateTime` 刷新），会话恢复可用。
- 冷启动截图 `app/app-launch-1.0.9.jpeg`：首页正常，视频探望显示“可用”。

---

## 4. 真实链路冒烟（APP 侧，Lead relay + DAYU200 1.0.4）

> 这是 **APP 侧冒烟证据**；契约 §4 的正式端到端验收（≥60s、退出 ≤5s 停止、401、断网恢复计时）由 **Lead** 执行并出结论。

- relay：`http://10.0.2.2:9443`（Lead local 模式，DAYU200 1.0.4 真实相机推流）。
- 进入视频页后真实收到 DAYU200 画面：
  - `video-page-smoke-1.jpeg`：`第 10 帧 / 4 fps / 640×480`，真实房间+人物画面；
  - `video-page-smoke-3.jpeg`：同一会话 `第 127 帧 / 3.4 fps / 最近帧 20:38:44`，人物姿态变化（连续帧，非静态图）；
  - `video-page-layout.json`：`pagePath=pages/VideoVisitPage`、`第 188 帧 / 3.5 fps`；
  - `hilog-app-pid.log`：`NETSTACK websocket` 收帧 + `ImageSource: CreatePixelMap success ... srcSize:(640,480)`。
- 断线/恢复（真实）：relay 短暂中断后，页面进入“正在申请视频会话…”加载态（`video-page-reconnecting-after-relay-restart.jpeg`），恢复后画面继续（布局 dump 时 `第 188 帧 / 3.5 fps`）。**说明**：自动化点击同时可能触发了失败态的“重新连接”按钮，因此本轮无法严格区分“自动重连”与“手动重试”在真实环境的第一次触发；自动重连本身由 `video-session.test.mjs`（1/2/4s×3 次）覆盖，正式计时验收由 Lead 执行。
- 主动结束（真实）：点“结束探望”返回首页（`video-page-ended-return-home.jpeg`）；立即查 relay `/video/healthz` 得
  `{"ok":true,"mode":"local","dayuLink":"down","framesReceived":79,"fps":0,"lastFrameAgeMs":2562,"viewers":0}`
  → viewer=0、DAYU 链路 down、最后帧 2.5s 前：APP 关闭 WS + session/end 后 relay 已停止推流。
- 电量实拍：`device-page-1.0.9-2.jpeg`（卫生间“固定供电，无电池电量数据”）、`device-page-1.0.9-3.jpeg`（DAYU200 fixed + esp32-sos“电量未知/未接入电量检测（无采样模块）/补齐条件”）。

---

## 5. 未完成 / 风险 / 边界（如实）

1. **真实电量测量 BLOCKED-BY-HARDWARE**：无实物电池、分压、ADC 接线；本期只实现全链字段/解析/展示与“无数据如实未知”。真实 mV/%/low 需按 BATTERY-CHAIN-CONTRACT §1/§7 接硬件后验收。
2. **视频正式验收归 Lead**：本报告 §4 是 APP 侧冒烟；≥60s 连续播放、fps 稳定性、退出停止计时、401 越权、断网恢复计时由 Lead 按契约 §4 执行。
3. **生产 relay 地址**：APP 默认 `http://10.0.2.2:9443`（模拟器验收）。生产需在运行环境写入 AppStorage `video.relayBase=https://api.luxunacc.xyz`（自动 wss）；未写入时页面会显示连接失败，不会伪造画面。当前未提供页面内可编辑入口（避免误配置）。
4. **实体手机安装 NOT TESTED**：HAP 为 unsigned debug，本机无实体机签名材料；仅模拟器覆盖安装验证。
5. **并发 viewer**：relay 上限 2（Lead 已告知）。APP 每次进入只建 1 条 WS，重连前先关闭旧连接；但若同账号多终端同时观看，第 3 个会被 close 1013，APP 显示重连耗尽/失败（不冒充播放）。
6. **模拟器 ws:// 明文**：本次实测可连接（ws://10.0.2.2:9443 成功），未触发系统拦截；若后续被拦截，会显示连接失败 + 错误文案，需改用 wss/生产域名（不改假数据）。
7. **解码性能**：模拟器 3.4–4 fps（DAYU 推流 3.2–3.5 fps，与 Lead 实测一致），满足 MVP；解码忙时丢旧帧保最新帧，避免积压。未在实体手机评估。
8. **PixelMap/PixelMap.release**：上一帧 release、离开页面 release；未做长时（>10min）内存曲线测试（NOT TESTED）。
9. **生产后端/relay/DAYU 未改**：本轮只改 APP；relay 与板端由 Lead/队友负责。未改其它 APP 工程、未动模拟器其他应用。

---

## 6. 回滚

- 改造前关键源码快照：`app/source-before/`（12 个关键文件 + `SHA256SUMS.txt`），覆盖回 `APP/ElderlyCareGuardian` 即可回退到 1.0.8 源码后重建。
- 安装回滚：重装历史 1.0.8 HAP（`competition/evidence/2026-10-27-real-capability-app/app/guardian-real-capability-1.0.8-unsigned.hap`，SHA 见该目录）可覆盖安装；覆盖安装不清数据。
- 数据：本轮未改生产后端、未执行 ACK/处置/保存；仅只读页面刷新与视频会话（一次性 ticket，已 end）。

---

## 7. 证据索引（本目录）

| 路径 | 内容 |
|---|---|
| `REPORT.md` | 本报告 |
| `SMOKE-ACCEPTANCE-APP.md` | 模拟器冒烟取证说明（电量/视频/退出停止/hilog/截图索引） |
| `guardian-battery-video-1.0.9-unsigned.hap` | 交付 HAP（3,579,813 B） |
| `HAP-SHA256-1.0.9.txt` | HAP SHA-256 |
| `assembleHap-1.0.9.log` | 完整构建日志（BUILD SUCCESSFUL） |
| `logs/app-tsc.log` / `logs/app-node-test.log` | tsc exit 0 / Node 502 PASS |
| `install-1.0.9.log` / `bm-dump-1.0.9.txt` | 安装成功 / versionName 1.0.9 + versionCode 1000009 |
| `app-launch-1.0.9.jpeg`、`device-page-1.0.9-*.jpeg` | 1.0.9 运行截图：首页入口、设备页电量实拍 |
| `video-page-smoke-1.jpeg`、`video-page-smoke-3.jpeg`、`video-page-layout.json`、`hilog-app-pid.log` | 真实 DAYU200 画面/帧数/fps/640×480 解码证据 |
| `video-page-reconnecting-after-relay-restart.jpeg`、`video-page-ended-return-home.jpeg` | 断线重连加载态 / 结束探望返回首页 |
| `source-before/` | 改造前源码快照 + SHA256SUMS |
