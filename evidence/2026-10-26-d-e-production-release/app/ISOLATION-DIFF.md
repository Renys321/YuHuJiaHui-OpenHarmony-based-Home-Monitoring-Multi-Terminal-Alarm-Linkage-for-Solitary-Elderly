# 隔离 diff 清单 — 相对归档源（2026-10-26）

**基线**：归档解压源 `_work/src/d-e-candidate-source-2026-10-26/APP/ElderlyCareGuardian`
（与 `_work/app-build/baseline/` 逐文件 SHA-256 相同；123 个源文件，0 差异）。
**变体**：`_work/app-build/d-e-only/`（121 个源文件）。

**统计：0 新增 / 2 删除 / 11 修改。** 完整逐行 patch：`app/isolation-diff.patch`
（739 行，37,310 B，SHA-256 `9D5C1D92833EC8A1E2F626F4680F11E4B752864242F2AFD22C923C47F6B48DC7`）；
文件级清单原始记录：`_work/app-build/logs/05-isolation-filelist.txt`。

> 说明：比较时排除生成物（`oh_modules/`、`entry/build/`、`tests/build/`、`entry/.test/`、`.hvigor/`）。
> 生成变体的脚本为 `_work/app-build/scripts/strip-camera-a.mjs`（可重复执行；每处编辑带唯一性/结构断言）。

---

## 1. 删除（2）

| 文件 | 归档行数 | 原因 |
| --- | --- | --- |
| `entry/src/main/ets/core/evidence/EvidenceCore.ts` | 186 | CAMERA-A 证据核心（JPEG 校验/取消/内存缓存） |
| `tests/evidence.test.mjs` | 357 | 只测已删除的证据链路 |

## 2. 新增（0）

无。

## 3. 修改（11）

| 文件 | 归档 → 变体（字节） | diff 行（+/-） | 改动要点 |
| --- | --- | --- | --- |
| `AppScope/app.json5` | 248 → 248 | +2 / -2 | versionCode 1000001；versionName 1.0.1 |
| `entry/src/main/ets/components/AlertItem.ets` | 4,135 → 3,718 | +0 / -12 | 删除列表相机/“有证据元数据”徽标 |
| `entry/src/main/ets/core/api/ApiClient.ts` | 18,994 → 16,671 | +0 / -43 | 删除 EvidenceCore 导入与 `evidence()` 下载方法 |
| `entry/src/main/ets/core/api/HttpTransport.ts` | 2,867 → 1,886 | +0 / -21 | 删除 cancellation 字段、binary 响应字段与 `binary()` 工厂 |
| `entry/src/main/ets/core/service/Outcomes.ts` | 2,425 → 2,217 | +0 / -8 | 删除 `EvidenceOutcome` |
| `entry/src/main/ets/core/view/Models.ts` | 6,231 → 6,103 | +0 / -4 | 删除 `AlertView.evidence*` 四字段 |
| `entry/src/main/ets/core/view/ViewMapper.ts` | 29,794 → 29,602 | +0 / -4 | `mapAlert` 不再写证据元数据 |
| `entry/src/main/ets/net/HarmonyHttpTransport.ets` | 4,649 → 3,106 | +4 / -36 | 移除取消分支、二进制响应/上限/Accept=image\/jpeg 分支，固定 JSON 文本 |
| `entry/src/main/ets/pages/AlertDetailPage.ets` | 54,927 → 47,482 | +1 / -210 | 移除证据加载/解码/面板/徽标与状态清理；ACK/处置/时间线原样保留 |
| `entry/src/main/ets/service/GuardianService.ets` | 57,039 → 52,798 | +1 / -91 | 移除证据缓存/`loadEvidence()`/证据错误文案/登出清理 |
| `tests/view-mapper.test.mjs` | 16,037 → 15,920 | +0 / -2 | 删除 2 行证据字段断言（ACK 状态断言保留） |

**总变化**：源码 123 → 121 文件；行数约 -464 行（含注释/空行），无新增功能代码
（`+` 行仅为注释改写与导入列表尾逗号调整）。

---

## 4. 验证

1. `node scripts/strip-camera-a.mjs` 全程断言通过（`_work/app-build/logs/04-strip-camera-a.log`）；
2. 变体源码中 `evidence|Evidence` 引用只剩 `Contracts.ts`（合同层，见 `CAMERA-A-STRIP.md` §3）；
3. `tsc -p tests/tsconfig.json` exit 0；主机测试 **261/261 pass**；Hypium **39/39 pass**；
4. `assembleHap` BUILD SUCCESSFUL，HAP 内已无证据链路符号（见 `TEST-RESULTS.md` §5）。
