# APP 候选 v3（1.0.4）— 门磁“最近开关记录”多设备修复

```text
状态：BUILT / UNSIGNED / NOT_INSTALLED / NOT_DEPLOYED / 仅隔离目录构建
构建窗口：2026-10-27 02:17 — 02:18 Asia/Shanghai（日志见 _work/app-src/_build/logs/）
任务：1.0.3 安装后“卫生间门磁状态正常但最近开关记录显示暂无记录”的最小修复
```

在**同一隔离树** `_work/app-src`（CAMERA-A 已剥离、D/E+门磁、能力表已改）中做最小修复并重建；未安装、未签名、未碰设备；
工作区 `<WORKSPACE>\APP` 未修改。

---

## 1. 制品身份（v3）

| 项 | 值 |
| --- | --- |
| 文件 | `guardian-d-e-door-2026-10-27-v3-unsigned.hap` |
| 大小 | **2,596,811 字节**（v2 1.0.3 = 2,590,903 B；+5,908 B 为本轮 DevicePage 逻辑/文案） |
| SHA-256 | **`45FDCCD1E73A95CDEEE1CCE0C4F27627BB72A344444BEA4F652386CAD30D9E1A`** |
| bundleName | `com.example.program_04`（不变） |
| versionCode | **1000004**（> 已装 1000003） |
| versionName | **1.0.4**（> 已装 1.0.3） |
| 签名 | **无**（`signingConfigs: []`；hvigor `Will skip sign 'hos_hap'`；20 条目无签名块） |
| buildMode | `debug`（同前几轮） |
| HAP 条目 | 20；`ets/modules.abc` 1,344,780 B；无测试文件、无 CAMERA-A 资源 |

历史对照：v2 1.0.3 = 2,590,903 B，SHA-256 `933B0B4473D85E79646C441E2527200416FBDA562DEEAC746CED6BFDD9785996`；
v1 1.0.2 = 2,590,881 B，SHA-256 `2D1A7268F9F7C6DAA6CD6B286473D6AECD5FF9A64D58328AF1DF36C7D5E8D56D`。

---

## 2. 根因与最小修复（`entry/src/main/ets/pages/DevicePage.ets`，+76/−21 行）

**根因**：
1. `firstDoorDeviceId()` 只返回**第一个**装有门磁的设备；
2. `loadDoorEventsForDevices()` 只对这一个 deviceId 调用 `GuardianService.loadDoorEvents()`，结果写入全局 `gv.doorEvents`；
3. `doorEventsOf(d)` 按 `deviceId` 过滤 → 其他门磁设备（卫生间）永远没有记录，显示“暂无开关记录”。

**修复（DevicePage.ets 内，未改 GuardianService/AppStorage key/`doorEventsOf` 过滤与每设备 5 条截断）**：

| 位置 | 修改 |
| --- | --- |
| `firstDoorDeviceId()` → `doorDeviceIds()` | 遍历**所有** `hasDoorSensor(d)` 的设备，按 deviceId 去重返回数组（保持设备列表顺序） |
| `loadDoorEventsForDevices()` | 逐设备 `await GuardianService.loadDoorEvents(deviceId, 10)`，把每次 `outcome.items` 合并进 `merged`；循环后按 `occurredAt` **倒序**（稳定排序，无效时间排最后）写入 `AppStorage.setOrCreate('gv.doorEvents', merged)` |
| 失败处理 | 某设备失败时：保留该设备**上次已加载**的记录（从循环前的 `this.doorEvents` 按 deviceId 过滤）+ `failedCount`；全部成功 → `gv.doorEventsStatus='ok'`、message 清空；部分失败 → `='partial'`、全部失败 → `='error'`，`gv.doorEventsMessage` 写明“部分门磁设备开关记录未加载（N 台）：<真实原因>”并 toast（不伪造空列表成功、不回退演示数据） |
| 会话切换 | 任一设备返回 `stale`：恢复循环前记录、不继续请求、toast 真实提示后返回 |
| `doorEventSection(d)` | 调整渲染优先级：**有记录先展示记录**（若状态非 ok 追加一行 warning 提示）；无记录时 `ok→暂无开关记录`，非 ok→显示诚实错误文案；`doorEventsOf` 未改（仍按 deviceId 过滤、每设备最多 5 条） |
| `doRefresh()` 注释 | “找到首个装门磁的设备” → “所有门磁设备”，与实现一致 |

> 可复现脚本（带唯一性断言）：`_work/app-src/_build/apply-door-events-all-devices-v3.mjs`；
> 日志 `_work/app-src/_build/logs/14-apply-door-events-all-devices-v3.log`。

---

## 3. 版本号

`versionCode` 1000003 → **1000004**、`versionName` 1.0.3 → **1.0.4**（均 > 已装版本，支持覆盖升级并区分内容）；
bundle/包名、`build-profile.json5`（`signingConfigs: []`）未改。

---

## 4. 测试

| 项 | 结果 | 日志 / 说明 |
| --- | --- | --- |
| 主机侧 tsc | **exit 0** | `_build/logs/15-host-tests-tsc-v3.log` |
| 主机侧 `node --test` | **270 tests / 270 pass / 0 fail / 0 skip**（与 v2 相同，未改任何测试） | `_build/logs/16-host-tests-node-v3.log` |
| Hypium | **BUILD SUCCESSFUL / exit 0；Tests run: 39, Failure: 0, Error: 0, Pass: 39, Ignore: 0** | `_build/logs/17-hypium-test-v3.log`；原始结果 `app/UNIT-TEST-RESULT-hypium-v3.txt` |
| `hvigorw assembleHap` | **BUILD SUCCESSFUL in 13 s 400 ms，exit 0；`skip sign 'hos_hap'`** | `_build/logs/18-build-v3-unsigned.log` |

**测试范围说明**：本轮改动的 `pages/DevicePage.ets` 是 ArkTS UI 页面层，**不在** 主机侧 `node --test` 范围
（`tests/tsconfig.json` 只编译 `entry/src/main/ets/core/**/*.ts`），Hypium 现有 39 项也未覆盖 DevicePage 的 UI 行为，
因此两套测试数量与 v2 相同（270 / 39）且全部通过——这证明 core 逻辑与既有功能无回归，但**不直接证明本页面 bug 已修**。
本 bug 已用 HAP 内符号/文案静态验证（§5）+ 需安装后真机确认（§7）。

---

## 5. HAP 验证（v3）

| 检查 | 结果 |
| --- | --- |
| `pack.info` | bundle `com.example.program_04`；`version.code=1000004`、`version.name=1.0.4` |
| 签名 | 无签名块；构建日志 `Will skip sign 'hos_hap'` |
| 本轮修复符号 | `doorDeviceIds` **存在**；`firstDoorDeviceId` **不存在**；`部分门磁设备开关记录未加载` **存在**；`gv.doorEvents` 存在 |
| CAMERA-A 必须不存在：`EvidenceCore`/`loadEvidence`/`EvidenceRequestCancellation`/`EvidenceOutcome`/`evidenceAvailable`/`/evidence/content`/`image/jpeg`/`camera_fill`/`查看证据`/`拍摄时间` | **全部不存在** |
| 门磁功能 | `门磁`/`最近开关记录`/`doorEvents`/`DOOR_EVENTS`/`DoorEventView`/`已接入（GPIO14 门磁，v7 事件台账）` **均存在** |
| D/E | `处置结果`/`安全日志`/`活动报告`/`ActivityReportPage` **均存在** |

预期行为（安装后）：刷新设备页时会对**每台**装门磁的设备（当前为 esp32-kitchen、esp32-bath）各请求一次
`GET /api/v1/door-events?limit=10&deviceId=…`，合并后按时间倒序写入 `gv.doorEvents`；两张设备卡片的“最近开关记录”
都从同一合并数组按自身 deviceId 过滤展示（各最多 5 条）。任一设备接口失败时：该设备保留上次记录、页面/Toast 显示真实失败原因，
不会把失败伪装成“暂无记录”。

---

## 6. 隔离 diff（v3，相对工作区 APP）

**0 新增 / 2 删除 / 15 修改**（122 → 120 个构建所需源文件）：
- 删除（CAMERA-A 剥离，沿用）：`core/evidence/EvidenceCore.ts`、`tests/evidence.test.mjs`；
- 修改：CAMERA-A 剥离 11 文件 + `core/capability/DeviceCapabilities.ts`（v2 门磁能力）+ 3 个测试期望（v2）
  + **本轮 `pages/DevicePage.ets`（+76/−21）**；`AppScope/app.json5` 版本号随轮次更新。
- 完整逐行 patch：`app/isolation-diff-v3.patch`（1,022 行，52,026 B）。

---

## 7. 边界与待真机确认

- 未安装（无 `hdc install`）、未签名、未触碰设备/串口；未部署后端、未重启任何服务；未修改 `<WORKSPACE>\APP`。
- 写入仅 `_work/app-src/` 与本 `app/` 目录。
- **待确认（安装 1.0.4 后）**：设备管理页厨房、卫生间两张门磁卡片“最近开关记录”都应显示记录；
  若后端 `door-events` 对某个 deviceId 无数据，该卡片应显示“暂无开关记录”（真的没有记录）；
  若接口失败，应显示真实错误文案且保留旧记录。v7 后端/网关完全上线前，门磁卡片可能仍显示“等待门磁数据”，记录查询可能返回未实现接口错误——属预期。
