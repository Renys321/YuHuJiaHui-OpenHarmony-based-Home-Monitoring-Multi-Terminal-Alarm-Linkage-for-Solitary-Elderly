# APP 变更清单（HarmonyOS 监护人 APP 1.0.5 / versionCode 1000005）

基线：1.0.4（`com.example.program_04`）源码；构建副本 `_work/app-build/d-e-only`（已剥离未发布 CAMERA-A）。
验证：`tsc` exit 0；`node --test --test-isolation=none` **368/368 PASS**；隔离构建副本 **338/338 PASS**；
`assembleHap` **BUILD SUCCESSFUL**，unsigned HAP **2,980,999 B**，SHA-256 `935A24CCB3FC4F71B30E569E87F1DD7C5BFB31DE1A207D1C09AC7B2B1D8B7C3D`。

## 新增文件（5）

| 文件 | 大小 | SHA-256 | 职责 |
| --- | --- | --- | --- |
| `entry/src/main/ets/core/health/HealthModels.ts` | 39,728 | `46A4618183F1D0C9E128638B827846256D6D1A5FEBD8E92A3E88016C93CFE6B7` | 两页表单状态 `HealthFormState`、与后端完全一致的范围/长度校验、3 条固定文案、急症词检测、只提交已填字段 |
| `entry/src/main/ets/core/health/HealthAdvice.ts` | 13,010 | `5D37250B25615BF171E8DF51A9D3B2471CDA5D5598FC6820A545156CE6F146DA` | 响应防御式解析（缺字段/类型错/缺免责声明/红线词→null）、状态机、中文文案映射、固定四段 |
| `entry/src/main/ets/pages/HealthAssessmentPage.ets` | 51,409 | `64F72CC5BA1149D3993EBCA613BEFF831DB65B5721FE67C9A6C420748FA0CAA9` | 健康评估页：两条固定提示、急症黄条、两步表单、保存/生成/重新生成/修改资料、加载/空/失败/超时/未开放/成功状态、四段结果+免责声明 |
| `tests/health-profile.test.mjs` | — | — | 38 项：表单校验边界/回填/急症词/无诊断措辞 |
| `tests/health-advice.test.mjs` | — | — | 30 项：解析/状态机/文案/ApiClient 200/401/409/504/502/网络/非法 JSON/超时/绝不伪造 |

## 修改文件（8，均增量）

| 文件 | 变更 |
| --- | --- |
| `entry/src/main/ets/core/api/ApiClient.ts` | `getHealthProfile` / `putHealthProfile`（12000ms）、`generateHealthAdvice`（20000ms）；Bearer；不打印资料/token |
| `entry/src/main/ets/core/api/Contracts.ts` | 健康响应信封 DTO 与解析（忽略未知字段、缺字段不崩） |
| `entry/src/main/ets/core/service/Outcomes.ts` | `HealthProfileOutcome` / `HealthAdviceOutcome` |
| `entry/src/main/ets/core/view/Models.ts` | `AppKeys` 新增 6 个 `gv.health*` 键 |
| `entry/src/main/ets/service/GuardianService.ets` | `loadHealthProfile` / `saveHealthProfile` / `generateHealthAdvice`；登录/登出/401 时清理健康状态与内存缓存（`resetHealthState`）；演示模式 fail-closed |
| `entry/src/main/ets/pages/ProfilePage.ets` | 新增“健康评估”入口 → `pushUrl({url:'pages/HealthAssessmentPage'})` |
| `entry/src/main/resources/base/profile/main_pages.json` | 注册 `pages/HealthAssessmentPage` |
| `tests/README.md` | 用例数 368、覆盖表、SIMULATED/NOT TESTED 增补 |

## 关键行为

- **分两页**：第 1 页基础健康信息（年龄/既往病史/长期用药/身高/体重/静息血压/空腹血糖）；第 2 页生活习惯（睡眠/饮食/口味/忌口/运动/烟酒/排便/情绪/视力/听力）。
- **固定提示**（页面常驻，不可关闭）：
  - `请勿填写身份证号、手机号、详细住址或其他不必要的身份信息。`
  - `本功能仅提供健康科普参考，不构成医疗诊断或治疗建议。`
- **急症前置提醒**：文本命中急症词（胸痛/呼吸困难/昏迷/大出血/剧烈头痛/意识不清/抽搐/偏瘫/口角歪斜）时立即显示“请尽快联系家属、社区医护人员或正规医疗机构；如症状严重或突然发生，请立即拨打急救电话”，**不等待 AI 结果**。
- **状态**：加载中 / 空资料 / 生成中 / 网络失败 / AI 超时（`暂时无法生成建议，请稍后重试`）/ 服务未开放 / 成功；失败**绝不展示本地伪造建议**。
- **会话隔离**：登录、登出、业务 401 都清空 `gv.healthProfile/gv.healthStatus/gv.healthMessage/gv.healthAdvice/gv.healthAdviceStatus/gv.healthAdviceMessage` 与内存缓存。
- **页面不直连** `ApiClient`/`HttpTransport`（既有 `static-guard` 断言通过）。

## 发布包

- 构建副本：`_work/app-build/d-e-only`（自当前源码复制 + 复用既有 CAMERA-A 剥离脚本；健康代码完整保留，CAMERA-A 符号 0 命中）
- HAP 内字符串核验：含 `健康评估`/`健康科普`/`不构成医疗诊断`；**不含** `evidence/content`、`image/jpeg`、`loadEvidence`、`检查证据`
- 签名：构建输出 unsigned（`skip sign`）；是否可安装取决于设备签名策略，见 `REPORT.md` 真机验收章节
