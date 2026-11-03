# APP 候选构建 — D/E + 门磁（剥离 CAMERA-A，unsigned）

```text
状态：BUILT / UNSIGNED / NOT_INSTALLED / NOT_DEPLOYED / 仅隔离目录构建
构建窗口：2026-10-27 01:42 — 01:45 Asia/Shanghai（日志见 _work/app-src/_build/logs/）
任务：task-10（APP 候选：D/E + 门磁，剥离 CAMERA-A，版本提升，不安装）
```

本制品是**监护人 APP 候选**：保留已验收 D（处置结果 + 安全日志）与 E（活动报告），
并保留工作区新增的**门磁展示/最近开关记录/离线未知语义**；**CAMERA-A（告警证据 JPEG 链路）已剥离**。
**未签名、未安装、未部署**；工作区 `<WORKSPACE>\APP` 未被修改。

---

## 1. 制品身份

| 项 | 值 |
| --- | --- |
| 文件 | `guardian-d-e-door-2026-10-27-unsigned.hap` |
| 大小 | **2,590,881 字节** |
| SHA-256 | **`2D1A7268F9F7C6DAA6CD6B286473D6AECD5FF9A64D58328AF1DF36C7D5E8D56D`** |
| bundleName | `com.example.program_04`（不变） |
| versionCode | **1000002**（工作区源 1000000；已装 1000001，故 +1 覆盖升级） |
| versionName | **1.0.2**（理由见 §5） |
| buildMode | `debug`；`signingConfigs: []` → hvigor 输出 `Will skip sign 'hos_hap'` 即 **unsigned** |
| compileSdkVersion | `26.0.0.105`（targetAPI 26 / compatible 5.0.4(16)，与上轮一致） |
| HAP 条目 | 20 个（`module.json`、`ets/modules.abc` 1,341,264 B、`sourceMaps.map`、资源；**无签名块**） |
| 已装对照 | 上轮 D/E-only unsigned 1.0.1/1000001 = 2,552,182 B；本候选 +38,699 B（门磁功能增量） |

同目录附件：

| 文件 | 说明 | SHA-256 |
| --- | --- | --- |
| `APP-BUILD.md` | 本文件 | — |
| `isolation-diff.patch` | 相对工作区 APP 的 11 个修改文件统一 diff（739 行） | `617CCFD2287E830665CF8671B6B562B8ACD30CAD4735B57882FFDD0844041E9F` |
| `UNIT-TEST-RESULT-hypium.txt` | Hypium 原始结果（39 pass） | `0BCFDAF2B996D0FD4AFC3890C2DEEBF15D73CEC802F6FE11D15AD170FE15743A` |
| `SHA256SUMS.txt` | 本目录哈希清单 | — |

---

## 2. 隔离副本与来源

- 工作区源（**只读**）：`<WORKSPACE>\APP\ElderlyCareGuardian`（当前含 D/E + 门磁 + CAMERA-A）。
- 隔离工作树：`competition/evidence/2026-10-27-door-v7-e2e/_work/app-src/`。
- 复制方式：只复制构建所需（122 个源文件）：
  `AppScope/`、`entry/src/main/`、`entry/src/test/`、`hvigor/`、`tests/`、
  `build-profile.json5`、`oh-package.json5`、`oh-package-lock.json5`、`hvigorfile.ts`、`code-linter.json5`、
  `entry/src/main/module.json5` 等；
  **排除**生成/机器相关/无关项：`.hvigor/`、`oh_modules/`、`entry/build/`、`entry/.preview/`、`entry/.test/`、
  `entry/src/mock/`、`entry/src/ohosTest/`、`.idea/`、`preview/`、`backup-20261022-login-demo-recovery/`、
  `docs/`、`local.properties`（机器专属；构建用 DEVECO_SDK_HOME/JAVA_HOME 环境变量）。
- 剥离后的工作树：120 个源文件（删除 2 个文件，见 §3）。

---

## 3. 剥离清单（相对工作区 APP：**0 新增 / 2 删除 / 11 修改**）

剥离脚本：`_work/app-src/_build/strip-camera-a.mjs`（就地剥离；每处编辑带唯一性/结构断言，沿用
`2026-10-26-d-e-production-release/_work/app-build/scripts/strip-camera-a.mjs` 的逻辑，按本轮
“门磁新增 + DoorEventsOutcome 导入”做了最小适配）。执行日志：`_work/app-src/_build/logs/01-strip-camera-a.log`。

### 3.1 删除（2）
| 文件 | 原因 |
| --- | --- |
| `entry/src/main/ets/core/evidence/EvidenceCore.ts` | CAMERA-A 证据核心（JPEG 校验/取消/内存缓存），唯一服务证据图片链路 |
| `tests/evidence.test.mjs` | 整文件只测已删除的证据链路（30 用例） |

### 3.2 修改（11；行号为工作区 APP 源）
| 文件 | 移除内容 | 原因 |
| --- | --- | --- |
| `AppScope/app.json5`（5–6） | versionCode→1000002，versionName→1.0.2 | 版本提升（§5） |
| `core/api/ApiClient.ts`（20–23, 187–225） | EvidenceCore 导入 + `evidence()`（`/evidence/content`、binary、2 MiB、cancellation、JPEG 校验） | CAMERA-A 网络触点本体 |
| `core/api/HttpTransport.ts`（4, 15–19, 38–42, 63–71） | `EvidenceRequestCancellation`、`responseType/maxResponseBytes/cancellation`、二进制响应字段、`binary()` 工厂 | 证据下载专用传输参数/载荷 |
| `net/HarmonyHttpTransport.ets`（3, 9, 25–32, 34, 45–46, 49–51, 56–58, 60–70, 87–92） | 取消分支、`Accept: image/jpeg`、`ARRAY_BUFFER`、2 MiB 上限、二进制响应/超限分支；固定 JSON 文本 | 证据 JPEG 下载入口 |
| `core/service/Outcomes.ts`（4, 25–30） | `EvidenceOutcome` | 证据结果对象 |
| `core/view/Models.ts`（130–133） | `AlertView.evidenceAvailable/evidenceId/evidenceBytes/evidenceCapturedAt` | 证据元数据视图字段 |
| `core/view/ViewMapper.ts`（618–621） | `mapAlert` 的 4 行证据赋值 | 不再向视图写证据元数据 |
| `components/AlertItem.ets`（83–94） | 列表项相机图标 + “有证据元数据” | 证据元数据入口 |
| `service/GuardianService.ets`（26, 52–54, 135–136, 214, 369, 732–813） | Outcomes 导入中的 `EvidenceOutcome`、EvidenceCore 导入、`evidenceCache` 字段、2 处登出清理、`loadEvidence()`+`evidenceMessage()` | 证据下载编排与缓存本体 |
| `pages/AlertDetailPage.ets`（16, 22–25, 43–48, 76–78, 101–102, 109–114, 131–134, 176–181, 454–524, 695–712, 723–805, 1542–1544） | ImageKit/EvidenceCore 导入、`EvidencePhase`、证据 @State/字段、证据清理块、`canViewEvidence/loadEvidence/...`、hero 证据徽标、`evidencePanel()`、build 挂载点 | 证据解码/展示本体 |
| `tests/view-mapper.test.mjs`（322–323） | 2 行证据字段断言 | `AlertView` 已无证据字段；其余（含门磁）断言保留 |

> 逐行 patch：`app/isolation-diff.patch`；文件级 numstat：`_work/app-src/_build/logs/07-isolation-filelist.txt`。

### 3.3 有意保留（非证据图片链路）
- `core/api/Contracts.ts` 的 `AlertEvidenceDto` 与 `evidence` 元数据解析：API v1 合同容错层（不发请求/不解码/不展示）。
- `core/api/HttpHeaders.ts`：通用 header 工具（`headerValue` 仍服务 Retry-After）。
- `HttpRawResponse.cancelled/cancelledRequest`：通用网络失败语义。

---

## 4. 门磁与 D/E 保留（未改动）

| 功能 | 保留位置（工作区 APP 源） | 本候选状态 |
| --- | --- | --- |
| 门磁状态（开/关/未知/离线） | `Contracts.ts` `DoorSensorDto`（33–42）+ `parseDoor`（180）；`ViewMapper.ts` `buildDoorView`（228–258）；`DevicePage`/`MonitorPage` 传感器卡片渲染 | 保留（`门磁` 文案与 `lastOpenTs/lastCloseTs` 语义在 HAP 内可见） |
| 最近开关记录 | `Contracts.ts` `DoorEventDto`/`parseDoorEvents`（48, 194）；`ApiClient.doorEvents()`（379）；`Outcomes.DoorEventsOutcome`（75）；`Models.AppKeys.DOOR_EVENTS*`（25–28）/`DoorEventView`（204）；`ViewMapper.mapDoorEvents`（265）；`GuardianService.loadDoorEvents`（1140）| 保留（HAP 内 `doorEvents`/`DOOR_EVENTS`/`DoorEventView`/`最近开关记录` 均存在） |
| 记录离线/失败语义 | `GuardianService.doorEventsQueryMessage`（1204）；`DevicePage.doorEventSection`（338）失败/未加载文案 | 保留（不伪造成功、不回退演示数据） |
| D 处置结果面板 | `AlertDetailPage.dispositionPanel()` / `DispPhase` / `GuardianService.submitDisposition` | **未改** |
| D 安全日志/时间线 | `AlertDetailPage.timelineCard()`、`LogPage`、`safetyLogs` | **未改** |
| E 活动报告 | `ActivityReport.*`、`ActivityReportPage`、`activityReport()` | **未改** |

> 未引入任何非工作区 APP 的源码或第三方运行时依赖（`ohpm` 仅 devDependencies hypium/hamock，且不进入 HAP）。

---

## 5. 版本号选择理由

- `versionCode` 1000000（工作区源）→ **1000002**：已装 APP 为 1.0.1/1000001，覆盖升级需要更大 versionCode。
- `versionName` 1.0.0 → **1.0.2**：本候选内容为“D/E + 门磁”，与已装 1.0.1（D/E-only）不同，用 1.0.2 可在设备/日志中区分；
  versionName 不参与安装兼容判断，风险为零。
- bundleName/包名不变；`build-profile.json5` 的 `signingConfigs: []` 未改（仍 unsigned）。

---

## 6. 测试结果

| 项 | 结果 | 日志/来源 |
| --- | --- | --- |
| 主机侧 tsc（core 编译） | **exit 0** | `_build/logs/03-host-tests-tsc.log` |
| 主机侧 `node --test`（候选，D/E+门磁，CAMERA-A 剥离） | **270 tests / 270 pass / 0 fail / 0 skip** | `_build/logs/04-host-tests-node.log` |
| 主机侧 `node --test`（对照：同一工作区源码未剥离） | **300 tests / 300 pass / 0 fail** | `_build/baseline-check/`（隔离副本，未写工作区） |
| 差值说明 | 30 = 整文件删除的 `tests/evidence.test.mjs`；**D/E/门磁/ACK/处置/活动报告断言全部保留并通过** | — |
| Hypium 平台单测 | **BUILD SUCCESSFUL / exit 0；Tests run: 39, Failure: 0, Error: 0, Pass: 39, Ignore: 0** | `_build/logs/05-hypium-test.log`；原始结果 `app/UNIT-TEST-RESULT-hypium.txt` |
| `hvigorw assembleHap`（unsigned） | **BUILD SUCCESSFUL in 27 s 919 ms，exit 0；`skip sign 'hos_hap'`** | `_build/logs/06-build-de-door-unsigned.log` |

> 主机测试使用 `tests/fake-transport.mjs` 的 SIMULATED HTTP 响应，证明 APP 侧逻辑，不等于真实公网/真机验收；
> 未安装、未跑真机 UI。

---

## 7. HAP 内部验证（`ets/modules.abc` + `pack.info`）

| 检查 | 结果 |
| --- | --- |
| `pack.info` | `bundleName=com.example.program_04`，`version.code=1000002`，`version.name=1.0.2` |
| **CAMERA-A 必须不存在**：`EvidenceCore`/`loadEvidence`/`EvidenceRequestCancellation`/`EvidenceOutcome`/`evidenceAvailable`/`evidenceCapturedAt`/`/evidence/content`/`image/jpeg`/`camera_fill`/`查看证据`/`拍摄时间` | **全部不存在** |
| **D 必须存在**：`处置结果`/`安全日志`/`dispositionPanel`/`timelineCard` | **全部存在** |
| **E 必须存在**：`活动报告`/`ActivityReportPage` | **全部存在** |
| **门磁必须存在**：`门磁`/`最近开关记录`/`doorEvents`/`DOOR_EVENTS`/`DoorEventView`/`lastOpenTs`/`lastCloseTs` | **全部存在** |
| 合同层残留（有意）：`AlertEvidenceDto`/`evidenceId` | 存在（仅 DTO 解析，见 §3.3） |
| 签名 | 无签名块；构建日志 `Will skip sign 'hos_hap'` |
| HAP 条目 | 20（无测试文件、无 CAMERA-A 资源） |

---

## 8. 构建环境与命令（可复现）

```powershell
$env:DEVECO_SDK_HOME='D:\DevEcoStudio\DevEco Studio\sdk'
$env:JAVA_HOME='D:\DevEcoStudio\DevEco Studio\jbr'
$env:HVIGOR_USER_HOME='<WORKSPACE>\competition\evidence\2026-10-27-door-v7-e2e\_work\app-src\_build\.hvigor-user'
$ohpm='D:\DevEcoStudio\DevEco Studio\tools\ohpm\bin\ohpm.bat'
$hvigorw='D:\DevEcoStudio\DevEco Studio\tools\hvigor\bin\hvigorw.bat'
$tsc='D:\DevEcoStudio\DevEco Studio\tools\hvigor\hvigor\node_modules\typescript\bin\tsc'

cd <WORKSPACE>\competition\evidence\2026-10-27-door-v7-e2e\_work\app-src
# （app-src 由工作区 APP 的构建所需文件复制而来，见 §2；剥离脚本见 §3）
& $ohpm install --all
node $tsc -p tests\tsconfig.json
cd tests; node --test --test-isolation=none; cd ..
& $hvigorw test --mode module -p product=default -p module=entry@default --no-daemon
& $hvigorw assembleHap --mode module -p product=default -p buildMode=debug --no-daemon
```

- Node v24.19.0 / ohpm 26.0.0.630 / DevEco hvigor wrapper 10.28.2 / TypeScript 4.9.5。
- 注意：归档类工程的 `hvigor/hvigor-config.json5` dependencies 为空、无 `hvigorw`；必须用 DevEco 自带
  `tools\hvigor\bin\hvigorw.bat`（wrapper 安装插件到隔离 `HVIGOR_USER_HOME`），直接 `node hvigor.js` 会报
  `Cannot find module '@ohos/hvigor-ohos-plugin'`（与 2026-10-26 结论一致）。

---

## 9. 已知残留与注意

1. **Contracts.ts 保留 evidence DTO 解析**（合同容错；不发起证据请求）。HAP 内仅残留 `AlertEvidenceDto`/`evidenceId` 字符串。
2. **能力文案残留**：`core/capability/DeviceCapabilities.ts` 仍有 3 处能力说明提到“证据”（设备能力矩阵文案，
   与证据图片功能无关，未改；若要求文案零提及可改 164 行一处）。
3. 主机测试为 SIMULATED；真机安装/UI/真实公网未验证（本任务禁止安装/签名/碰设备）。
4. HAP 为 `buildMode=debug` 的 unsigned 包，供后续签名/安装环节使用；是否可同身份覆盖已装 1.0.1 由签名环节判断。
5. `tests/README.md` 是历史文档（用例数/说明未随本轮更新），以本文件 §6 的实际结果为准。

---

## 10. 边界（明确未做）

- 未修改 `<WORKSPACE>\APP`；未安装（无 `hdc install`）、未签名、未触碰任何设备/串口。
- 未部署后端、未停止/重启 bridge/broker/public-sync、未改生产主机。
- 写入范围仅：`competition/evidence/2026-10-27-door-v7-e2e/_work/app-src/` 与本 `app/` 目录。
