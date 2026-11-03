# 手机监护 APP · 断连恢复 / 陈旧数据语义 / 客厅无 PIR 文案 / 随身 SOS 复验 — 交付报告（APP 1.0.10）

- 日期：2026-10-27（Asia/Shanghai，22:20–22:55）
- 工作区：`<WORKSPACE>`；APP：`APP/ElderlyCareGuardian`，包名 `com.example.program_04`
- 版本：**1.0.10 / 1000010**（`AppScope/app.json5`；LoginPage/ProfilePage 版本文案同步 v1.0.10）
- 模拟器：DevEco Mate 90 Pro，target `127.0.0.1:5555`；安装前为 **1.0.9 / 1000009**，已覆盖安装 1.0.10
- 分级口径：**LOCAL**=实现+Node 测试+本地构建；**DEPLOYED-EMU**=已覆盖安装到模拟器并用真实生产数据运行验收；**REAL（只读）**=生产 API 只读核对；**NOT TESTED/BLOCKED**=受设备/数据现状限制
- 边界：未改后端/DAYU northbound/homemon/固件；未删除/导出生产数据；**未提交任何 ACK/处置/健康资料保存**；未清模拟器数据

## 0. 一句话结论

APP 现在不会再把“后端 online=true 但 lastSeen 已过期”的旧快照显示成实时：超过 90s 无新数据即按离线展示并给“最后在线 X 分钟前”，请求失败时用当前时间重映射缓存；回前台/重进页面按 12s 策略立即刷新，30s 轮询持续重试。客厅 `dayu200-living` 明确显示“**未配置 PIR，无活动监测**”，摄像头判定独立展示（本轮生产 `monitorOnline=-1`，如实显示“暂无有效检测数据（监测状态未知）”），NO_MOTION 历史告警标题改为“**无活动告警（未配置 PIR，来源需核实）**”；厨房/卫生间 PIR、门磁、温湿度、MQ 文案无回归。随身 SOS 复验通过：同一告警（与生产 API 的 `alarmId`/时间对应）、位置“暂无定位”、ACK“设备已确认（设备回执时间 22:07）”，未提交 ACK。

## 1. 审计结论（修复前代码位置）

| # | 风险 | 修复前证据（文件:行） | 结论 |
|---|---|---|---|
| D1 | 设备请求失败时仍显示上次快照的 `online=true`/旧读数，用户会当成实时 | `service/GuardianService.ets` 旧 `doRefreshAll` 失败分支只写 `gv.netStatus='offline'`，不重算 `gv.devices`；`core/view/ViewMapper.ts` 的 `isDeviceFresh` 仅在“成功取数”时执行 | **真实缺陷，已修** |
| D2 | APP 从后台回前台/返回页面不立即刷新，最长等 30s 轮询；轮询被系统挂起时更久 | `pages/Index.ets` 旧只有 `aboutToAppear`（31）+`aboutToDisappear`（59），无 `onPageShow`；`GuardianService.startAutoRefresh` 仅 30s | **真实缺陷，已修** |
| D3 | `lastSeenTs` 解析接受 0/负数；负数/超前时间经 `formatAge` 被钳成“刚刚”，可把无效时间显示成实时 | 旧 `core/api/Contracts.ts` `parseDevice`：`dto.lastSeenTs = asFiniteNumber(...)`；旧 `ViewMapper.mapDevice`：`lastSeenText = dto.lastSeenTs > 0 ? formatAge(...)`（`formatAge` 对负值取 0） | **真实缺陷，已修** |
| D4 | 客厅无 PIR 却渲染 PIR 活动语义：能力表把 dayu 的“摄像头判定”当 `motion` 已装，传感器瓦片固定文案“今日 N 次 · 长时间无活动会触发 NO_MOTION 告警”；NO_MOTION 告警标题对所有设备都是“长时间无活动”；`capabilityWarningFor(dayu,'motion')` 返回空，没有能力核对提示 | `core/capability/DeviceCapabilities.ts` 旧 `makeDayu`: `entry('motion','人体活动（摄像头判定）',true,true,true,...)`；旧 `ViewMapper.buildMotionView` 的 `NO_MOTION` 文案；旧 `alertSensorKindFor` FALL/NO_MOTION 同为 `motion`；旧 `alertTypeLabel('NO_MOTION')='长时间无活动'`；旧 `capabilityWarningFor` 只看 `installed` | **真实缺陷，已修** |
| D5 | homemon 新契约 `sensors.motion.supported/reported/reason` 未解析（旧数据无此字段；且 `competition/cloud/onenet/adapter.js:155` 目前对 `motion` 做 exact-keys 校验，生产快照暂未透传这些字段） | 旧 `Contracts.parseMotion` 只读 `lastActiveTs/countToday` | **已按兼容规则实现并测试；真实字段到达前不影响旧数据** |

补充事实（只读核对，2026-10-27 22:41 生产 API）：4 台家庭设备 `online=true`，但 `esp32-sos.lastSeenTs` 比探测时刻落后约 295s、`dayu200-living` 的 `monitorOnline=-1`；`/api/v1/location` 中 `esp32-sos` 记录数为 0。即“陈旧 online 标志”“摄像头监测状态未上报”“无定位记录”三种现场都存在，与修复目标一致。

## 2. 修复清单（最终代码位置）

### 2.1 陈旧数据语义 + 断连恢复

| 文件:行 | 改动 |
|---|---|
| `core/view/ViewMapper.ts:34`/`:38` | 保留 90s 新鲜度合同 `DEVICE_OFFLINE_AFTER_MS`/`isDeviceFresh`（原有语义，未放宽）；离线的所有传感器（“未配置 PIR”等 `unsupported` 除外）统一改写为“离线·上次读数/离线·暂无数据”，并说明“不代表当前状态” |
| `core/view/ViewMapper.ts:67` | 新增 `monitorReasonTextFor()`：后端 `monitorReason` 短码 → 中文（offline/stale/no_data/camera down/未知保留原样），不做“无人/跌倒”推断 |
| `core/view/ViewMapper.ts:712` | `lastSeenText` 仅在 `0 < lastSeenTs <= now+5min` 时用相对时间，其余一律“时间未知”（不再把负数/超前时间显示成“刚刚”）；`makeSensor.lastUpdateTs` 同样过滤非法/超前时间 |
| `core/api/Contracts.ts:419` | `lastSeenTs` 只接受 >0，0/负数/非法归一为 0；新增 `monitorReason` 解析（`:152`） |
| `core/polling/RefreshPolicy.ts:19` | 新增纯逻辑 `shouldRefreshOnShow(lastUpdatedAt, netStatus, nowMs, maxAgeMs=12s)`：上次失败/从未成功/超过 12s/时钟异常 → 刷新 |
| `service/GuardianService.ets:538` | 新增 `refreshOnShow()`：登录态下按策略刷新；未登录/12s 内已同步返回 null（不重复请求；刷新本身有会话代际单飞） |
| `service/GuardianService.ets:163` | 缓存最近一次成功的原始 `rooms/devices` DTO（仅内存，登录/登出/401 清空） |
| `service/GuardianService.ets:553` | 新增 `remapCachedDevicesForNow()`：**设备请求失败时按“当前时间”重映射缓存 DTO**，旧 `online` 超过 90s 立刻变离线；`:648` 在 `devicesView===null` 的失败/部分失败分支调用 |
| `pages/Index.ets:70` | 新增 `onPageShow()`：演示模式跳过；未登录回登录页；轮询未运行则恢复；按 12s 策略立即刷新（401 仍回登录） |

### 2.2 客厅无 PIR / 摄像头判定独立

| 文件:行 | 改动 |
|---|---|
| `core/capability/DeviceCapabilities.ts:45`/`:52` | 新增 `MotionSource`（pir/camera/none）与固定文案常量 `PIR_UNCONFIGURED_TEXT='未配置 PIR，无活动监测'`、`PIR_NO_DATA_TEXT='暂无有效 PIR 数据'`、`CAMERA_NO_VALID_DATA_TEXT='暂无有效检测数据'` |
| `core/capability/DeviceCapabilities.ts:118`/`:192`/`:200` | `CapabilityProfile.motionSource`；客厅=`camera`、厨房/卫生间=`pir`、SOS/未知=`none`；客厅能力表改为 `camera=摄像头人体检测（已装，非 PIR）` + `motion=PIR 活动监测（未配置）`，能力核对文案明确“未配置 PIR，人员检测来自摄像头判定” |
| `core/view/ViewMapper.ts:178` | `motionSemanticsFor()`：状态显式 `supported=false` 优先（→ unsupported），否则回退已核实能力表；旧数据无该字段保持原行为 |
| `core/view/ViewMapper.ts:187` | `buildPirUnconfiguredView()`：无 PIR 独立瓦片，值文本逐字“未配置 PIR，无活动监测”，离线时不改写 |
| `core/view/ViewMapper.ts:214` | `buildCameraMotionView()`：只有“视觉监测正常(monitorOnline=1)+收到检测字段”才描述“最近检测到人体/今日未检测到人体”；监测异常/未知/无结果 → “暂无有效检测数据”+真实原因；离线由统一离线展示覆盖；**绝不出现 PIR/NO_MOTION/长时间无活动** |
| `core/view/ViewMapper.ts:272` | PIR 瓦片：`reported=false` → “暂无有效 PIR 数据”；`lastActiveTs=0` → “从未检测到活动”（若同日 count>0 自相矛盾则只显示次数并标注最近活动时间未知，不冒充实时） |
| `core/view/ViewMapper.ts:777` | `hasReading` 不计入 `unsupported` 能力（避免“未配置 PIR”被当成历史读数） |
| `core/view/ViewMapper.ts:929` | `alertTitleFor()`：客厅 NO_MOTION → “无活动告警（未配置 PIR，来源需核实）”；厨房/卫生间仍为“长时间无活动” |
| `core/view/ViewMapper.ts:946` | `alertSensorKindFor()`：FALL→fall（客厅已核实能力，不误报）、NO_MOTION→motion；配合 `capabilityWarningFor` 客厅 PIR 专项提示 |
| `pages/MonitorPage.ets:67` | 筛选标签 `camera` → “摄像头检测” |
| `pages/DevicePage.ets:545` | 设备页展示 `monitorReasonText`（视觉监测原因）；客厅能力核对含“未配置 PIR/未安装·未启用：PIR 活动监测（未配置）” |

### 2.3 版本与文档

- `AppScope/app.json5` 1.0.9→**1.0.10 / 1000010**；LoginPage/ProfilePage 文案同步。
- `docs/REAL-API-INTEGRATION-SPEC.md`：能力表客厅“无 PIR”口径；新增活动检测来源/陈旧数据/恢复刷新规则；记录 homemon `supported/reported/reason` 兼容契约与 `refreshOnShow`。
- `tests/README.md`：新增 `reconnect-stale.test.mjs` 覆盖说明与 528 项结果。

## 3. 测试（LOCAL，SIMULATED 数据）

```powershell
node "D:\DevEcoStudio\DevEco Studio\tools\hvigor\hvigor\node_modules\typescript\bin\tsc" -p "<WORKSPACE>\APP\ElderlyCareGuardian\tests\tsconfig.json"
# tsc exit 0（logs/app-tsc.log）
Set-Location <WORKSPACE>\APP\ElderlyCareGuardian\tests; node --test --test-isolation=none
# tests 528 / pass 528 / fail 0（logs/app-node-test.log）
```

- 新增 `tests/reconnect-stale.test.mjs`（26 项）：90s 新鲜度边界、陈旧 `online=true`→离线+上次读数、`lastSeenTs` 0/负数/超前解析、3 小时快照重映射后离线、12s onPageShow 策略、`supported/reported/reason` 兼容（缺失/非法保持旧行为）、`monitorReason` 映射、客厅 PIR/摄像头分离、离线不改写“未配置 PIR”、静态守卫（Index.onPageShow、GuardianService 缓存 DTO+失败重映射、设备页 monitorReasonText）。
- 更新 `view-mapper.test.mjs`/`capability.test.mjs`：客厅“未配置 PIR，无活动监测”与摄像头独立瓦片；NO_MOTION 在客厅/厨房/卫生间/未知设备的能力核对差异；PIR `reported=false`、`lastActiveTs=0`、矛盾数据计数；FALL 告警不误报；厨房/卫生间 PIR/门磁/温湿度/MQ 文案回归断言保留。
- 既有 502 项全部保持通过；未放宽“不得伪造”类约束。

## 4. 构建与安装（DEPLOYED-EMU）

| 项 | 值 |
|---|---|
| 构建命令 | `hvigorw.bat assembleHap --mode module -p product=default -p buildMode=debug --no-daemon` |
| 结果 | **BUILD SUCCESSFUL in 16 s 649 ms**（`logs/assembleHap-1.0.10-final.log`；仅既有 ArkTS WARN） |
| versionName / versionCode | **1.0.10 / 1000010**（`AppScope/app.json5`） |
| HAP | `guardian-reconnect-stale-1.0.10-unsigned.hap`，**3,608,373 B** |
| SHA-256 | **`643E323A5327C83C594119CCD9B9B961D1FC79443BC960CA0627124F7AB3F0D7`**（`HAP-SHA256-1.0.10.txt`） |
| 签名方式 | unsigned debug（工程未配置 signingConfigs，与 1.0.9 相同，可装模拟器） |
| 安装 | `hdc -t 127.0.0.1:5555 install -r <hap>` → `install bundle successfully`（`logs/install-1.0.10-final.log`） |
| 安装前后版本 | 1.0.9/1000009 → **1.0.10/1000010**（`logs/bm-dump-before/after-1.0.10*.txt`；覆盖安装未清数据，会话自动恢复） |
| 回退 HAP | `competition/evidence/2026-10-27-battery-video-visit/app/guardian-battery-video-1.0.9-unsigned.hap`，3,579,813 B，SHA-256 `31C5634E0653AFCEC1D2F435AC3A10B6629178A3AAAC23DEF6268B741B9A5A87` |

回退命令：`hdc -t 127.0.0.1:5555 install -r <上述 1.0.9 HAP>`（覆盖安装不清数据）。源码改动快照在 `source-1.0.10/`（17 个文件 + `SHA256SUMS.txt`），用于下轮对比/回滚。

## 5. 模拟器运行验收（DEPLOYED-EMU / REAL 只读）

> 运行期间 public-sync/房间节点在 22:36–22:50 反复上线/掉线（厨房/卫生间/客厅/随身 SOS 均有波动），正好覆盖“旧快照/掉线/恢复”窗口；以下均为 APP 真实界面与生产 API 数据，未触发 ACK/处置。

| 证据 | 内容 |
|---|---|
| `screenshots/18-home-device-health.jpeg` | 首页设备健康：`3/4 在线/设备`、`1 离线设备`、`最后在线 5 分钟前`。**同时后端 `/devices` 对 esp32-sos 仍返回 `online=true`**（只读探针 `verify/devices.json`）——APP 没有把旧 online 当实时 |
| `screenshots/22-monitor-living-final.jpeg` | 实时监测：`在线 1/4`；厨房瓦片“上次读数 开启 / 离线·上次读数 / 设备离线，展示上次读数，不代表当前状态”；客厅 `0/1`；客厅 **“PIR 活动监测 / 未配置 PIR，无活动监测 / 未配置”**；**“摄像头人体检测（非 PIR）/ 上次读数 暂无有效检测数据 / 离线·上次读数”** |
| `screenshots/20-monitor-top-final.jpeg`、`16-device-page.jpeg`、`23-monitor-bath-final.jpeg` | 监测页 `上次更新 22:47 · 数据已同步`；厨房 PIR“最近活动 刚刚 / 今日 1 次 · 长时间无活动会触发 NO_MOTION 告警”（厨房真实能力，无回归）；卫生间 PIR/温湿度/门磁真实数据；设备管理页客厅能力核对“未配置 PIR…未安装/未启用：PIR 活动监测（未配置）” |
| `screenshots/27-living-nomotion-detail.jpeg`、`layout/26/27` | 客厅 NO_MOTION 告警列表/详情标题 **“无活动告警（未配置 PIR，来源需核实）”** + 黄色能力核对提示；**未显示为 PIR“长时间无活动”真告警**，也未提交 ACK（保持“待确认”） |
| `screenshots/10-home-after-relaunch.jpeg`、`25-home-status.jpeg` | 强制停止 APP 后重新启动：会话恢复 + **首页 22:41 / 22:50 更新**、`3/4 在线`、客厅 NO_MOTION 标题正确（`onPageShow` 恢复刷新）；`24-profile-version.jpeg` 显示“最近刷新时间 22:48:57” |
| `logs/hilog-raw-tail.txt` | APP PID 16453 在 22:46:25 连续 4 条 `GET … RespCode 200`（overview/rooms/devices/alerts），30s 轮询持续重试证据 |
| `screenshots/13-sos-detail.jpeg`、`12-alert-acked-list.jpeg`、`verify/alerts.json` | 随身 SOS 复验（见 §6） |

只读探针（`_tools/readonly-probe.js`，凭据只从 `.secrets` 读入、**未打印/未落盘**，只登录 + GET）：
`verify/alerts.json`（84 条告警，8 条 esp32-sos）、`verify/devices.json`（4 台家庭设备快照）、`verify/locations.json`（esp32-sos 定位 0 条）。

## 6. 随身 SOS 复验（REAL 只读）

- 告警身份：APP 预警列表“设备已确认”页 → `紧急求助按键 / esp32-sos / 随身求助 / 22:06 / 22:07 设备确认`；详情页事件时间 `2026-10-27 22:06`。
- 只读 API 对应记录：`alarmId=sos-6-49732005`、`type=MANUAL_SOS`、`deviceId=esp32-sos`、`roomName=随身求助`、`state=ACKED`、`createdAt=1793110004756`（=22:06:44）、`acknowledgedAt=1793110029191`（=22:07:09）、`acknowledgedBy=household-guardian`。APP 详情显示的时间（22:06 / 22:07）与该**同一 alarmId** 记录一致（列表→详情内部按 `alarmId` 从 `gv.alerts` 查找，见 `findAlert`）。
- 位置状态：`/api/v1/location` 中 esp32-sos 记录为 0 → APP 显示“**暂无定位 / 定位时间未知 / 未查询到该设备（esp32-sos）的定位记录**”，地图不画推测位置；`求助时刻位置/求助后更新` 本轮因无定位记录无法现场复现（映射与 120s 时效由 `sos-map.test.mjs` 覆盖）。
- ACK 状态：APP 仅在服务端 `state=ACKED`（真实设备回执后）显示“**设备已确认 + 设备回执时间 2026-10-27 22:07 + 回执人 household-guardian**”；本轮**未点击任何 ACK/处置按钮**；PENDING 等待态由 `ack-state.test.mjs` 覆盖。
- 结论：随身求助同一 alarmId、暂无定位、真实回执 ACK 显示正常，无伪造。

## 7. 过程事件（如实记录）

1. **编辑器误操作已恢复**：22:27 用 Windows PowerShell 5.1 的 `Set-Content` 改 LoginPage/ProfilePage 版本文案时，因 ANSI 编码转换造成两文件非 UTF-8 损坏（未被 git 跟踪）。已从 ArkTS 编译器缓存（`entry/build/.../compiler.cache/modules/LoginPage.ets-*.msgpack`、`ProfilePage.ets-*.msgpack` 的 `originalCode` 字段）**逐字节恢复 1.0.9 原文**（`_tools/LoginPage.recovered.ets`、`ProfilePage.recovered.ets`，提取脚本 `_tools/extract-original-code.js`），随后仅对版本号两行做 UTF-8 编辑；恢复后与最终文件逐行 diff 仅 1/2 行（均为版本文案），最终源码重新构建通过。改名后的页面文件改为用 UTF-8 专用编辑方式进行修改。
2. **误触视频探望页一次**：在首页滚动后点击坐标落到“视频探望”入口，自动连接了 relay `http://10.0.2.2:9443`，因 15s 无首帧显示失败态后返回；**未录像、未留存、未改后端数据**，会话已关闭。之后改用 layout dump 精确坐标。
3. **hdc 目标间歇掉线**：22:43–22:52 期间 `127.0.0.1:5555` 多次短暂 `Not match target founded`（与其它 teammate 可能同时使用模拟器有关），均通过 `hdc tconn 127.0.0.1:5555` 恢复；未操作实体设备目标（`4501…` 未触碰）。
4. 全程未 ACK/未处置任何真实告警（列表仍 47 条待确认）；未修改生产告警/设备/健康资料/门磁记录；未清模拟器应用数据。

## 8. 未完成 / 受限 / 未验证（如实）

1. **homemon 新字段真实运行验证（BLOCKED-BY-UPSTREAM）**：APP 已实现 `sensors.motion.supported/reported/reason` 兼容解析与测试（含缺失/非法回退），但 22:41/22:52 生产 `/api/v1/devices` 的 `motion` 仍只有 `lastActiveTs/countToday`（`competition/cloud/onenet/adapter.js:155` 目前对 motion 做 exact-keys 校验），需 homemon 修复 + adapter/后端透传后，才能在 App 内看到“supported=false / reported=false”的真实分支。届时应重跑本报告 §5 的客厅/厨房卡片复验。
2. **摄像头“检测到/未检测到人体”真实分支**：当前生产 4 台设备 `monitorOnline` 全为 `-1`（DAYU 视觉监测状态未上报），因此摄像头瓦片如实显示“暂无有效检测数据（监测状态未知）”；`monitorOnline=1 + 检测字段` 的“检测有效”分支仅有单元测试覆盖（NOT TESTED 真机）。
3. **SOS 定位“求助时刻位置/求助后更新”**：`/api/v1/location` 当前 esp32-sos 记录为 0，本轮只现场验收“暂无定位”；两种有效定位状态由 `sos-map.test.mjs` 覆盖，真实 GPS 定点需设备重新上报后由 Lead 复验。
4. **断网/网络恢复计时**：未主动断模拟器网络（避免影响其它 teammate）。恢复能力由 `RefreshPolicy`/Poller/失败重映射单测 + “强制停止重启后 22:41/22:50 更新”与 30s `GET 200` hilog 证据支撑；严格断网计时验收归 Lead。
5. **实体手机**：仍为 unsigned debug HAP，仅模拟器安装（NOT TESTED 实体手机，与 1.0.9 相同）。
6. 首页 47 条待确认告警均为生产真实记录（含厨房/卫生间 MANUAL_SOS 等），未处置、未清理；客厅 NO_MOTION 历史记录的服务端原始 message 仍按后端原文展示（标题与能力提示已标注“未配置 PIR，来源需核实”，未篡改后端数据）。

## 9. 证据索引（本目录）

| 路径 | 内容 |
|---|---|
| `REPORT-app-ui.md` | 本报告 |
| `guardian-reconnect-stale-1.0.10-unsigned.hap` / `HAP-SHA256-1.0.10.txt` | 1.0.10 HAP（3,608,373 B）+ SHA-256 |
| `logs/assembleHap-1.0.10-final.log` | 构建完整日志（BUILD SUCCESSFUL） |
| `logs/app-tsc.log` / `logs/app-node-test.log` | tsc exit 0 / Node 528 PASS |
| `logs/install-1.0.10-final.log`、`logs/bm-dump-*-1.0.10*.txt` | 安装成功 / 安装前后 versionName+versionCode |
| `logs/hilog-raw-tail.txt` | 22:46 自动轮询 4×GET 200 证据 |
| `screenshots/10,11,12,13,16,17,18,20,22,23,24,25,27-*.jpeg` | 模拟器真实运行截图（首页/监测/客厅/卫生间/设备管理/预警/ACKED 列表/SOS 详情/客厅 NO_MOTION 详情/我的） |
| `layout/*.json` | 与截图对应的 uitest dumpLayout（含文本/bounds 可检索） |
| `verify/alerts.json`、`devices.json`、`locations.json` | 22:41 生产 API 只读快照（用于核对同一 alarmId/陈旧 online/无定位） |
| `source-1.0.10/` + `SHA256SUMS.txt` | 本轮改动源码快照（17 文件） |
| `_tools/` | 只读探针、UI 文本提取、源文件恢复脚本与恢复出的 1.0.9 页面原文 |
| 回退 HAP | `competition/evidence/2026-10-27-battery-video-visit/app/guardian-battery-video-1.0.9-unsigned.hap` |

## 10. 回滚方式

1. 安装回退：`hdc -t 127.0.0.1:5555 install -r competition\evidence\2026-10-27-battery-video-visit\app\guardian-battery-video-1.0.9-unsigned.hap`（覆盖安装不清数据；已验证安装前后会话可恢复）。
2. 源码回退：用 `source-1.0.10/` 中的改动文件对照回退（或从 `_tools/*.recovered.ets` 恢复 1.0.9 的 LoginPage/ProfilePage 后重建）；其余文件为增量新增/修改，均可在本报告 §2 定位。
3. 后端/数据：本轮零改动，无需回滚；未执行 ACK/处置/健康资料保存。
