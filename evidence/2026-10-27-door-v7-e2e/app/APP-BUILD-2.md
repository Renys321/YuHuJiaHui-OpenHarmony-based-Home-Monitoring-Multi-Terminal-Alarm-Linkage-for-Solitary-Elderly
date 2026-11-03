# APP 候选 v2（1.0.3）— 门磁区块不显示的最小修正与重建

```text
状态：BUILT / UNSIGNED / NOT_INSTALLED / NOT_DEPLOYED / 仅隔离目录构建
构建窗口：2026-10-27 02:0x — 02:2x Asia/Shanghai（日志见 _work/app-src/_build/logs/）
任务：APP 1.0.2 安装后“门磁区块不显示”的最小修正（v2，versionCode 1000003 / versionName 1.0.3）
```

在**同一隔离树** `_work/app-src`（CAMERA-A 已剥离、D/E+门磁不变）中修正能力表并重建；未安装、未签名、未碰设备；
工作区 `<WORKSPACE>\APP` 未修改。

---

## 1. 制品身份（v2）

| 项 | 值 |
| --- | --- |
| 文件 | `guardian-d-e-door-2026-10-27-v2-unsigned.hap` |
| 大小 | **2,590,903 字节**（v1 1.0.2 = 2,590,881 B；+22 B 为能力表文案差异） |
| SHA-256 | **`933B0B4473D85E79646C441E2527200416FBDA562DEEAC746CED6BFDD9785996`** |
| bundleName | `com.example.program_04`（不变） |
| versionCode | **1000003**（> 已装 1000002） |
| versionName | **1.0.3**（> 已装 1.0.2） |
| 签名 | **无**（`signingConfigs: []`；hvigor `Will skip sign 'hos_hap'`；HAP 20 条目无签名块） |
| buildMode | `debug`（同前两轮） |
| HAP 条目 | 20；`ets/modules.abc` 1,341,284 B；无测试文件、无 CAMERA-A 资源 |

对照：v1（1.0.2）= `guardian-d-e-door-2026-10-27-unsigned.hap`，2,590,881 B，
SHA-256 `2D1A7268F9F7C6DAA6CD6B286473D6AECD5FF9A64D58328AF1DF36C7D5E8D56D`。

---

## 2. 根因与最小修正（`core/capability/DeviceCapabilities.ts`）

**根因**：`ViewMapper.buildDoorView()` 在 `!cap.installed || !cap.enabled` 时 `return null`；而能力表中
`esp32-kitchen` / `esp32-bath` 的 `door` 仍为 `installed=false` → 门磁传感器卡片与“最近开关记录”被隐藏。

修正（能力表 `entry(kind, name, installed, enabled, alarmEnabled, note)`；`installed/enabled/alarmEnabled` 三个布尔均置 true）：

| 位置 | 修正前 | 修正后 |
| --- | --- | --- |
| kitchen `door` entry | `false, false, false, '未安装（CONFIG_NODE_DOOR_GPIO=-1）'` | **`true, true, true, '已接入（GPIO14 门磁，v7 事件台账）'`** |
| kitchen profile note | `…CLIMATE 告警启用；无 PIR/门磁/水漏/摄像头。` | `…CLIMATE 告警启用；PIR 已接入、门磁已接入；无水漏/摄像头。` |
| bath `door` entry | `false, false, false, '未安装（门磁禁用）'` | **`true, true, true, '已接入（GPIO14 门磁，v7 事件台账）'`** |
| bath profile note | `…水漏本轮禁用；无燃气/烟雾/门磁/摄像头。` | `…水漏本轮禁用；门磁已接入（GPIO14）；无燃气/烟雾/摄像头。` |

未改任何其他设备/能力条目（dayu200-living、unknown、kitchen 的 motion/water/camera/sos、bath 的 gas/smoke 等）。
完整能力表 diff 见 `app/isolation-diff-v2.patch`（该文件 hunk 为 `+4/−4` 行）。

> 修正方式为可复现脚本：`_work/app-src/_build/apply-door-capability-v2.mjs`（带唯一性断言），
> 日志 `_work/app-src/_build/logs/08-apply-door-capability-v2.log`。

---

## 3. 版本号

- `versionCode` 1000002 → **1000003**、`versionName` 1.0.2 → **1.0.3**（均 > 已装 1.0.2/1000002，支持覆盖升级并区分内容）。
- bundle/包名、`build-profile.json5`（`signingConfigs: []`）均未改。

---

## 4. 测试（含因能力修正而更新的期望）

| 项 | 结果 | 日志 |
| --- | --- | --- |
| 主机侧 tsc | **exit 0** | `_build/logs/09-host-tests-tsc-v2.log` |
| 主机侧 `node --test` | **270 tests / 270 pass / 0 fail / 0 skip**（与 v1 数量一致） | `_build/logs/10-host-tests-node-v2.log` |
| Hypium | **BUILD SUCCESSFUL / exit 0；Tests run: 39, Failure: 0, Error: 0, Pass: 39, Ignore: 0** | `_build/logs/11-hypium-test-v2.log`；原始结果 `app/UNIT-TEST-RESULT-hypium-v2.txt` |
| `hvigorw assembleHap` | **BUILD SUCCESSFUL in 14 s 306 ms，exit 0；`skip sign 'hos_hap'`** | `_build/logs/12-build-v2-unsigned.log` |

**因“门磁已接入”而同步更新的测试期望（3 个文件，均只改门磁能力相关断言）**：
- `tests/capability.test.mjs`：kitchen/bath 的 `door.installed` 期望 `false → true`（并断言 `enabled/alarmEnabled=true`）；
  kitchen 摘要期望由“不含门磁”改为“含门磁”；测试标题同步。
- `tests/defect-sensor.test.mjs`：厨房 `door` 传感器由“不展示（null）”改为“展示（开启/attention）”；PIR/水漏仍为 null。
- `tests/view-mapper.test.mjs`：厨房 `door` 瓦片由“null”改为“展示（开启）”；PIR/水漏仍不展示。
- 其余 267 项断言未改；D/E/ACK/处置/活动报告/门磁事件等断言全部保持并通过。

---

## 5. HAP 验证（v2）

| 检查 | 结果 |
| --- | --- |
| `pack.info` | bundle `com.example.program_04`；`version.code=1000003`、`version.name=1.0.3` |
| 签名 | 无签名块；构建日志 `Will skip sign 'hos_hap'` |
| CAMERA-A 必须不存在：`EvidenceCore`/`loadEvidence`/`EvidenceRequestCancellation`/`EvidenceOutcome`/`evidenceAvailable`/`/evidence/content`/`image/jpeg`/`camera_fill`/`查看证据`/`拍摄时间` | **全部不存在** |
| 门磁能力文案（新增） | `已接入（GPIO14 门磁，v7 事件台账）`、`PIR 已接入、门磁已接入`、`门磁已接入（GPIO14）` **均存在** |
| 门磁功能符号 | `门磁`/`最近开关记录`/`doorEvents`/`DOOR_EVENTS`/`DoorEventView` **均存在** |
| D/E | `处置结果`/`安全日志`/`活动报告`/`ActivityReportPage` **均存在** |
| 合同层残留（有意，同前） | `AlertEvidenceDto`/`evidenceId` 仍存在（仅 DTO 解析，不发请求/不展示） |

> 现在 `buildDoorView()` 对 kitchen/bath 不再返回 null：即便设备尚未上报 `door` 字段，也会显示“门磁 / 等待门磁数据”
> 卡片（诚实等待态）；收到 `door` 数据后显示 开启/关闭 + 最近开启/关闭时间。主机测试已覆盖“有 door 数据时展示”。

---

## 6. 已知不一致（需 Lead 决策，未擅自扩大改动）

按指令把 kitchen profile note 改为“**PIR 已接入**、门磁已接入”，但 kitchen 的 `motion` 能力项**未改**（仍 `installed=false`），
因此设备页能力注记会出现：正文“PIR 已接入…” + 未安装清单仍含“人体红外”，且 **PIR 瓦片仍不会显示**。
如需让厨房 PIR 卡片也显示，需要把 `motion` 能力项同样置 `true,true,true`（固件侧 PIR 已接入，如 GPIO38/14，
请确认告警语义后我可按同一流程重建 1.0.4）。本轮严格遵循“不要动其他设备/能力”，未改 motion。

---

## 7. 构建命令（与 v1 相同）

```powershell
$env:DEVECO_SDK_HOME='D:\DevEcoStudio\DevEco Studio\sdk'
$env:JAVA_HOME='D:\DevEcoStudio\DevEco Studio\jbr'
$env:HVIGOR_USER_HOME='<WORKSPACE>\competition\evidence\2026-10-27-door-v7-e2e\_work\app-src\_build\.hvigor-user'
cd <WORKSPACE>\competition\evidence\2026-10-27-door-v7-e2e\_work\app-src
node _build\apply-door-capability-v2.mjs
node "D:\DevEcoStudio\DevEco Studio\tools\hvigor\hvigor\node_modules\typescript\bin\tsc" -p tests\tsconfig.json
cd tests; node --test --test-isolation=none; cd ..
& 'D:\DevEcoStudio\DevEco Studio\tools\hvigor\bin\hvigorw.bat' test --mode module -p product=default -p module=entry@default --no-daemon
& 'D:\DevEcoStudio\DevEco Studio\tools\hvigor\bin\hvigorw.bat' assembleHap --mode module -p product=default -p buildMode=debug --no-daemon
```

（设备/构建环境：Node v24.19.0、ohpm 26.0.0.630、DevEco hvigor wrapper 10.28.2、TypeScript 4.9.5；须用
`hvigorw.bat`，直接 `node hvigor.js` 会缺 `@ohos/hvigor-ohos-plugin`。）

---

## 8. 隔离 diff（v2，相对工作区 APP）

**0 新增 / 2 删除 / 14 修改**（122 → 120 个构建所需源文件）：
- 删除：`core/evidence/EvidenceCore.ts`、`tests/evidence.test.mjs`（CAMERA-A 剥离，沿用 v1）。
- 修改：CAMERA-A 剥离的 11 个文件（同 v1）+ 本轮 `core/capability/DeviceCapabilities.ts`（+4/−4）
  + 测试期望 `tests/capability.test.mjs`、`tests/defect-sensor.test.mjs`、`tests/view-mapper.test.mjs`
  （view-mapper 与 v1 为同一文件，均计入）。
- 完整逐行 patch：`app/isolation-diff-v2.patch`（880 行，45,270 B）。

---

## 9. 边界（明确未做）

- 未安装（无 `hdc install`）、未签名、未触碰设备/串口；未部署后端、未重启任何服务。
- 未修改 `<WORKSPACE>\APP`（只读）；写入仅 `_work/app-src/` 与本 `app/` 目录。
- 真机 UI 效果需安装后确认（本轮只做了逻辑单测 + HAP 内部静态验证）。
