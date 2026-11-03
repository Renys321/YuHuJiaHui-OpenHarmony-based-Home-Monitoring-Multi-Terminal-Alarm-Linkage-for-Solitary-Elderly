# SOURCE-MANIFEST — D/E 组合候选最终源码清单与差异

- 日期：2026-10-26（Asia/Shanghai）
- 机读清单：`SOURCE-HASHES.txt`（136 个文件，SHA-256 + 字节数 + 分组）
- 改前哈希快照：`_work/PRE-EDIT-SNAPSHOT.txt`（137 个文件，本任务开工时生成，含 mtime）
- 改前/改后内容与 unified diff：`_work/before-after/`（10 个改动文件，均经 SHA-256 校验证明改前内容逐字节还原）
- 校验汇总：`_work/before-after/reconstruction-report.json`、`reconstruction-report-backend.json`（全部 `EXACT`）

## 1. 清单范围与排除项

| 分组 | 内容 | 文件数 | 字节数 |
| --- | --- | --- | --- |
| `backend-src` | `competition/cloud/backend/src/*.js`（14 个模块） | 14 | 301,848 |
| `backend-test` | `competition/cloud/backend/test/*.js`（含 D 4 个、E 2 个、基线 20 个） | 26 | 372,466 |
| `backend-manifest` | backend 根目录 `package.json` / `README.md` / `.env.example` | 3 | 25,974 |
| `contract` | `competition/docs/APP-API-v1.md`、`APP-API-v1.json` | 2 | 21,052 |
| `app-core` | `APP/.../entry/src/main/ets/**`（`.ts` / `.ets` / `.json`） | 58 | 551,420 |
| `app-hypium` | `APP/.../entry/src/test/**`（4 个 `.ets`） | 4 | 29,929 |
| `app-host-tests` | `APP/.../tests/**`（19 个 `.test.mjs` + 支撑文件） | 22 | 229,121 |
| `app-project` | `AppScope/app.json5`、`build-profile.json5`、`oh-package.json5`、`hvigorfile.ts`、`local.properties` | 5 | 1,830 |
| `referenced-dayu` | `competition/northbound/AppScope/app.json5`、`oh-package.json5`（**只读引用，未修改**） | 2 | 405 |
| **合计** | | **136** | **1,534,045** |

排除：`node_modules`、`oh_modules`、`build`、`.test`、`.hvigor`、`.idea`、`.cxx`、`ohpm`
（构建产物/缓存/IDE 状态不属于源码）。候选 HAP 本身见 `BUILD-MANIFEST.md`。

`referenced-dayu` 只用于记录版本事实：`competition/northbound` 仍声明 **1.0.0 / 1000000**，
而已验收的 DAYU 正式包是 **1.0.2 / 1000002**，来自
`competition/experiments/dayu-eldercare-preview-integration-2026-10-25`。本任务**未修改**该工程。

## 2. 本任务改动的 10 个文件（改前 → 改后，全部哈希校验）

| # | 文件 | 改前（B / SHA-256） | 改后（B / SHA-256） | diff |
| --- | --- | --- | --- | --- |
| 1 | `competition/cloud/backend/src/activity.js` | 36,831 / `9DFABFCDB294A88E…` | 37,941 / `AB555AD8B80857AB…` | +38 / −18 |
| 2 | `competition/cloud/backend/test/activity.test.js` | 29,645 / `C653569429983899…` | 30,899 / `130682A049DF5C28…` | +20 / −0 |
| 3 | `competition/cloud/backend/test/activity-api.test.js` | 22,225 / `290C8C27551E8A4B…` | 23,356 / `9D79E269DD334879…` | +29 / −6 |
| 4 | `competition/cloud/backend/test/app-contract.test.js` | 1,330 / `8F070BAA202D56C0…` | 2,115 / `FA69175921DDE49F…` | +13 / −2 |
| 5 | `competition/cloud/backend/README.md` | 20,201 / `89940399A56AD4ED…` | 23,152 / `984F93744AC4008B…` | +40 / −0 |
| 6 | `competition/docs/APP-API-v1.md` | 10,318 / `1E8D94ADF2B953B5…` | 18,068 / `11BFBBE64F658BFB…` | +115 / −3 |
| 7 | `competition/docs/APP-API-v1.json` | 1,963 / `37244A59ABE6EF13…` | 2,984 / `CE12EBB1D7EA222F…` | +14 / −2 |
| 8 | `APP/.../core/activity/ActivityReport.ts` | 22,845 / `E31D35016C37B865…` | 23,033 / `EB1DF0064A6695C3…` | +4 / −2 |
| 9 | `APP/.../pages/ActivityReportPage.ets` | 30,839 / `C0D651B3B3DB35FA…` | 32,025 / `D71F3C24AB33F68A…` | +28 / −8 |
| 10 | `APP/.../tests/activity-report.test.mjs` | 33,132 / `4B5D9652321CA39A…` | 33,252 / `25A8F007F86B0C04…` | +3 / −2 |

完整 SHA-256 见 `_work/before-after/reconstruction-report*.json` 与 `SOURCE-HASHES.txt`；
每个文件的改前/改后全文分别在 `_work/before-after/<file>.before` / `.after`，
逐行差异在 `<file>.diff`。

**为什么这些差异可信**：改前内容不是凭记忆写的，而是用“反向替换本任务实际应用的编辑”
重建后与开工时记录的 SHA-256 比对，**10/10 全部 EXACT**。
另外 6 个文件中的 `competition/docs/APP-API-v1.md` 还有第三方佐证：
D 的源码快照 `2026-10-26-alert-disposition-safety-log/source-snapshot-D-20261026.zip`
里保存的 `docs/APP-API-v1.md`（10,318 B）与记录的改前哈希完全一致。

## 3. 未改动但属于候选的关键文件（用于核对“没有覆盖 D、没有删 E”）

| 文件 | 说明 |
| --- | --- |
| `backend/src/safety-log.js`、`src/store.js`、`src/persistent-store.js` | D 类处置/安全日志逻辑与 schema v6，**本任务未改** |
| `backend/src/server.js` | D 的 3 条路由与 E 的 1 条路由共存；**本任务未改** |
| `backend/src/main.js` | ActivityStore 接线与时区 fail-closed；**本任务未改** |
| `APP/.../pages/AlertDetailPage.ets`、`LogPage.ets`、`core/api/*`、`core/service/*`、`core/view/*` | D 类页面与服务；**本任务未改** |
| `APP/.../core/evidence/EvidenceCore.ts` 等 | CAMERA-A 实现；**本任务未改** |
| `competition/northbound/**`、`competition/esp32-node/**`、`competition/materials/**` | DAYU / 固件 / 一键入口；**本任务未触碰** |

## 4. 源码 ↔ 测试 ↔ 构建产物对应关系

| 产物 | 由哪些源码决定 | 对应验证 |
| --- | --- | --- |
| 后端服务（未部署） | `backend/src/*.js` + `package.json` | `npm run check` exit 0；`npm test` 287/287；D 隔离集成；E+D 独立隔离 39/39 |
| APP 候选 HAP（未签名/未安装） | `APP/entry/src/main/ets/**` + `AppScope/app.json5` + `build-profile.json5` + `oh-package.json5` + `hvigorfile.ts` | `tsc` exit 0；`node --test` 291/291；`hvigor test` 39/39；`assembleHap` BUILD SUCCESSFUL |
| 冻结 API 合同 | `docs/APP-API-v1.md` / `.json` | `test/app-contract.test.js` 守卫（版本 1.2.0 + 4 个新端点 + 3 组枚举） |

## 5. 候选身份（必须用哈希，不能用版本号）

| 制品 | 字节 | SHA-256 |
| --- | --- | --- |
| 本候选 HAP（unsigned debug） | 2,621,844 | `7634A0E25FCE3E19FC9604E4CD94D6D6BAFF36CB5DE67C92DAEE0E50C1452EB5` |
| 同源码上一次构建（仅 ZIP 时间戳不同） | 2,621,844 | `54FF869EBEC00126DE2FF8834658486E71DA1C2C366D05618F316A09DB3662C9` |
| 最近**已真实验收**的手机 APP（回退目标） | 2,086,949 | `9EEBEE9A5FC9EEC5A5993DC6923F16F0BFCCCD1CD4DE64BAF36FC7197ECAD25A` |
| 更早的回退包（**不是**最新基线） | 2,077,912 | `8A722EB6FDA7BB73EE58F3BDA3D95B5D238401DA8E3CC9179F1286FD5253A985` |

> 注意 `8A722…` 的正确哈希中间是 `…E3CC9179F1286FD5253A985`（`9F12` **86** `FD`）。
> 旧文档 `2026-10-26-alert-disposition-safety-log/DEPLOY-DIFF-AND-ROLLBACK.md:93` 写成
> `…9F1266FD…` 属转写错误，本任务按“保留历史原貌”不改旧文件，只在此纠正。

候选 HAP 的 `versionName/versionCode` 仍是 `1.0.0 / 1000000`，与 9EEBEE、CAMERA-A 包、
D 旧候选完全相同 —— **版本号无法区分内容**，安装后必须用哈希核对。
