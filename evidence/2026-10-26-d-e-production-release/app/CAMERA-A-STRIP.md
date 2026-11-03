# CAMERA-A 剥离触点清单（D/E-only 变体，2026-10-26）

**结论：无硬冲突，剥离完成。** 相对归档源：**0 新增 / 2 文件删除 / 11 文件修改**（详见
`ISOLATION-DIFF.md` 与 `isolation-diff.patch`）。所有行号均为**归档源**（未改动 baseline：
`_work/app-build/baseline/`，与归档解压源逐文件 SHA-256 相同）中的行号。

生成方式是可复现脚本：`_work/app-build/scripts/strip-camera-a.mjs`（baseline → d-e-only，
每处替换都带唯一性/结构断言，锚点不匹配立即失败）。执行日志：`_work/app-build/logs/04-strip-camera-a.log`。

---

## 1. 删除的文件（2）

| 文件 | 规模 | 原因 |
| --- | --- | --- |
| `entry/src/main/ets/core/evidence/EvidenceCore.ts` | 186 行（整文件） | 证据 JPEG 的资格判定、JPEG 头尾校验、2 MiB 上限、取消句柄、账号隔离内存缓存——全部只服务证据图片链路；删除后 `core/evidence/` 目录为空，一并删除 |
| `tests/evidence.test.mjs` | 357 行（整文件） | 只覆盖字节下载端点、JPEG 校验、缓存、取消与二进制传输；其断言全部针对已删除的生产代码。D/E 测试不受影响（其余 16 个测试文件保留） |

---

## 2. 修改的文件（11）

### 2.1 `entry/src/main/ets/core/api/ApiClient.ts`
| 归档源行 | 移除内容 | 原因 |
| --- | --- | --- |
| 19–22 | `import { EVIDENCE_TIMEOUT_MS, EvidenceImageBytes, ... } from '../evidence/EvidenceCore';` | 只被 `evidence()` 使用 |
| 187–225 | `async evidence()`：`GET /api/v1/alerts/{alarmId}/evidence/content`、binary 响应类型、2 MiB `maxResponseBytes`、`cancellation` 注入、content-type/content-length/JPEG 校验 | CAMERA-A 的网络触点本体（HAP 内已无该路径字符串） |

> 保留：`ack()`/`activityReport()`/处置相关方法与全部导入顺序不动。

### 2.2 `entry/src/main/ets/core/api/HttpTransport.ts`
| 归档源行 | 移除内容 | 原因 |
| --- | --- | --- |
| 4 | `import { EvidenceRequestCancellation } ...` | 取消句柄唯一使用者是证据下载 |
| 15–19 | `responseType`（binary=证据 JPEG）、`maxResponseBytes`（证据固定 2 MiB）、`cancellation` 字段及注释 | 证据二进制下载专用传输参数 |
| 38–42 | `HttpRawResponse.bodyBytes/contentType/contentLength/contentLengthValid` | 二进制响应载荷字段，唯一生产者是证据下载 |
| 63–71 | `HttpRawResponse.binary()` 工厂 | 仅证据下载使用 |

> 保留：`HttpRawResponse.ok/networkFailure/cancelledRequest`、`cancelled/timedOut/networkError`
> 等通用网络语义（`cancelledRequest` 已无生产者，但属于通用错误语义，删除会牵动 ApiClient 分支，超出最小化）。

### 2.3 `entry/src/main/ets/net/HarmonyHttpTransport.ets`
| 归档源行 | 移除内容 | 原因 |
| --- | --- | --- |
| 3 | 头注释“证据接口返回受 2 MiB 上限约束的二进制” → 改为“统一映射为 JSON 文本响应；本变体已剥离证据 JPEG 二进制下载” | 注释与实现一致 |
| 9 | `ContentLengthResult, parseContentLength` 导入（仅保留 `headerValue`） | 仅二进制响应分支使用 |
| 25–32 | 请求前“已取消检查”+ `onCancel` 注册（`client.destroy()`） | 取消机制唯一使用者=证据下载 |
| 34 | `'Accept': responseType === 'binary' ? 'image/jpeg' : 'application/json'` → 固定 `'application/json'` | 移除 JPEG 下载语义（HAP 内已无 `image/jpeg` 字面量） |
| 45–46 | `expectDataType: ... ARRAY_BUFFER : STRING` → 固定 `HttpDataType.STRING` | 不再接收二进制 |
| 49–51 | `options.maxLimit = request.maxResponseBytes` | 证据 2 MiB 上限 |
| 56–58 | 响应返回后的“已取消检查” | 同上 |
| 60–70 | 二进制响应分支（`ArrayBuffer` → `payload`、content-type/content-length 校验、`HttpRawResponse.binary()`） | 证据 JPEG 解码入口 |
| 87–89 | `catch` 中的“已取消检查” | 同上 |
| 90–92 | 二进制超限错误码 2300063 → 413 分支 | 证据下载专用 |

> 保留：`CONNECT_TIMEOUT_MS`、`TIMEOUT_ERROR_CODE`、Retry-After 解析、JSON 文本路径、`client.destroy()` 生命周期清理。
> `core/api/HttpHeaders.ts` **未修改**（`headerValue` 仍被 Retry-After 使用；`parseContentLength` 保留为通用工具）。

### 2.4 `entry/src/main/ets/core/service/Outcomes.ts`
| 归档源行 | 移除内容 | 原因 |
| --- | --- | --- |
| 4 | `import { EvidenceImageBytes }` | 仅证据结果对象使用 |
| 25–30 | `class EvidenceOutcome { ok, kind, message, image }` | 证据下载结果对象 |

### 2.5 `entry/src/main/ets/core/view/Models.ts`
| 归档源行 | 移除内容 | 原因 |
| --- | --- | --- |
| 126–129 | `AlertView.evidenceAvailable / evidenceId / evidenceBytes / evidenceCapturedAt` | 证据元数据视图字段（UI 唯一来源） |

### 2.6 `entry/src/main/ets/core/view/ViewMapper.ts`
| 归档源行 | 移除内容 | 原因 |
| --- | --- | --- |
| 579–582 | `view.evidenceAvailable / evidenceId / evidenceBytes / evidenceCapturedAt = dto.evidence.*` | 不再向视图写入证据元数据（`AlertDto` 解析仍在 Contracts） |

### 2.7 `entry/src/main/ets/components/AlertItem.ets`
| 归档源行 | 移除内容 | 原因 |
| --- | --- | --- |
| 83–94 | `if (this.alert.evidenceAvailable) { SymbolGlyph($r('sys.symbol.camera_fill')) + '有证据元数据' }` | 列表项相机标记（证据元数据入口） |

### 2.8 `entry/src/main/ets/service/GuardianService.ets`
| 归档源行 | 移除内容 | 原因 |
| --- | --- | --- |
| 26 | 导入列表中的 `EvidenceOutcome,` | 证据结果类型 |
| 52–54 | `import { EvidenceImageBytes, EvidenceMemoryCache, EvidenceRequestCancellation, validEvidenceAlarmId } from '../core/evidence/EvidenceCore';` | EvidenceCore 引用 |
| 135–136 | `EvidenceMemoryCache` 字段（进程内 JPEG LRU 缓存，12 MiB/6 条上限） | 证据图片缓存 |
| 214 | `GuardianService.evidenceCache.clearAll();`（`clearBusinessData` 内） | 缓存已删除 |
| 369 | `GuardianService.evidenceCache.clearAll();`（登出流程内） | 缓存已删除 |
| 732–813 | `loadEvidence()`（会话 ticket 校验、缓存读、`api.evidence()`、stale 判定、缓存写、401/403 处理）+ `evidenceMessage()` JSON 错误文案映射 | 证据下载编排本体 |

### 2.9 `entry/src/main/ets/pages/AlertDetailPage.ets`
| 归档源行 | 移除内容 | 原因 |
| --- | --- | --- |
| 16 | Outcomes 导入中的 `EvidenceOutcome` | 证据结果类型 |
| 22–25 | `import { image } from '@kit.ImageKit';` 与 `import { EvidenceRequestCancellation, canViewFallEvidence } from '../core/evidence/EvidenceCore';` | 证据解码/资格判定 |
| 43–48 | `class EvidencePhase { IDLE/LOADING/READY/FAILED }` | 证据面板状态机 |
| 76–78 | `@State evidencePhase / evidenceMessage / evidencePixelMap` | 证据 UI 状态 |
| 101–102 | `private evidenceCancellation / evidenceRequestId` | 证据请求句柄 |
| 109–114 | `aboutToAppear` 中告警切换时的证据状态清理块（保留 `this.alarmId = ...`） | 无证据状态可清理 |
| 131–134 | `aboutToDisappear` 中 `cancelEvidenceLoad/releaseEvidencePixelMap/evidencePhase/evidenceMessage` | 同上 |
| 176–181 | `syncAlert` 中 `if (!this.canViewEvidence())` 清理块 | 同上 |
| 454–524 | `canViewEvidence()` / `cancelEvidenceLoad()` / `releaseEvidencePixelMap()` / `loadEvidence()`（含 ImageSource/PixelMap 解码、4:3 展示、失败重试文案） | 证据加载与解码本体 |
| 695–712 | heroCard 内“FALL 证据可用 · N bytes”相机徽标 | 证据 UI 入口 |
| 723–805 | `@Builder evidencePanel()`（“告警证据”、查看/重试按钮、仅内存显示、拍摄时间） | 证据面板本体 |
| 1542–1544 | `build()` 中 `if (this.canViewEvidence()) { this.evidencePanel() }` | 证据面板挂载点 |

> **保留（未触碰）**：`AckPhase`/`ackPanel()`、`DispPhase`/`dispositionPanel()`、`loadDispositionRecords()`、
> `timelineCard()`、`syncAlert` 其余分支、`toast()`、`build()` 中 `ackPanel()/dispositionPanel()/timelineCard()`。

### 2.10 `AppScope/app.json5`
| 归档源行 | 改动 | 原因 |
| --- | --- | --- |
| 5 | `versionCode: 1000000` → **1000001** | 同 bundleName 覆盖安装必须更大 versionCode |
| 6 | `versionName: "1.0.0"` → **"1.0.1"** | 与同日含 CAMERA-A 的 1.0.0 候选包区分；versionName 不参与安装兼容判断 |

### 2.11 `tests/view-mapper.test.mjs`
| 归档源行 | 移除内容 | 原因 |
| --- | --- | --- |
| 322–323 | `assert.equal(byId.get('a-acked').evidenceAvailable, true)` / `evidenceId, 'ev-1'` | `AlertView` 已无证据字段；同一测试的 ACK 状态断言全部保留。fixtures 中 `evidence:{...}` 属于 DTO 输入，保留（`mapAlert` 不再读取） |

---

## 3. 明确保留、且不属于 CAMERA-A 的 content

| 文件/位置 | 为什么保留 |
| --- | --- |
| `core/api/Contracts.ts` 94–113（`AlertEvidenceDto`）、269–274（`parseAlerts` 解析 `evidence` 元数据） | API v1 合同容错层：服务端仍可能下发 `evidence` 字段；保留解析=未知/新增字段不崩，不发起请求、不解码、不展示。删除会改动合同层并影响 `contracts.test.mjs` 的合同断言，不属于“证据图片链路” |
| `core/capability/DeviceCapabilities.ts` 164/166/167 | 设备能力矩阵文案（摄像头/跌倒判定能力说明），非证据图片功能；其中 3 处提到“证据”的文案属于**已知文案残留**（见 §6） |
| `core/api/HttpHeaders.ts`、`HttpRawResponse.cancelled/cancelledRequest` | 通用 HTTP 工具/错误语义；`headerValue` 仍服务 Retry-After |
| `net/HarmonyHttpTransport.ets` 的 `client.destroy()`/超时/Retry-After/JSON 文本路径 | 登录/刷新/ACK/处置/活动报告全部依赖，不得改动 |
| `ActivityReport*`、`ActivityReportPage.ets`、`LogPage.ets`、`AlertDetailPage` 的处置/ACK/时间线 | D/E 功能本体，未触碰 |

---

## 4. 耦合分析（是否存在无法安全剥离的耦合）

- **唯一强耦合**：`AlertView.evidence*` 被 3 处消费（`ViewMapper.mapAlert` 赋值、`AlertItem` 列表徽标、
  `AlertDetailPage` 面板/hero 徽标）。全部同步删除后，`tsc`、`hvigor assembleHap`、两套测试均通过 →
  **可安全剥离**。
- **弱耦合（有意保留）**：`AlertDto.evidence`（Contracts）与 `AlertView` 的证据字段之间只靠 `ViewMapper`
  2 行赋值连接；删除赋值即可断开，DTO 保留不影响任何 D/E 行为（`contracts.test.mjs` 仍全绿）。
- **无硬冲突**：不存在“删证据字段即破坏处置/安全日志/活动报告”的引用；`disposition.test.mjs`、
  `activity-report.test.mjs`、`ack-state.test.mjs` 等 D/E 测试 261 项全部通过。

---

## 5. 剥离后的静态验证（对最终 HAP 的 `ets/modules.abc` 与 `pack.info`）

| 检查 | 结果 |
| --- | --- |
| `pack.info` | `versionCode=1000001`, `versionName=1.0.1`, bundle `com.example.program_04` |
| `EvidenceCore` / `loadEvidence` / `EvidenceRequestCancellation` / `EvidenceOutcome` | **均不存在** |
| `evidenceAvailable` / `evidenceCapturedAt` / `/evidence/content` | **均不存在** |
| `image/jpeg` / `sys.symbol.camera_fill`（`camera_fill`） | **均不存在** |
| 证据 UI 文案 `证据加载` / `查看证据` / `拍摄时间` | **均不存在** |
| D/E 文案与符号 `活动报告` / `处置结果` / `安全日志` / `ActivityReportPage` / `dispositionPanel` / `timelineCard` | **均存在** |
| 合同层残留 `AlertEvidenceDto` / `evidenceId` | 存在（§3 有意保留，仅 DTO 解析） |
| `告警证据` 字面量 | 残留于 `DeviceCapabilities` 能力文案（§3/§6 文案残留，非功能链路） |

---

## 6. 已知文案残留（未修改，待 Lead 决策）

`entry/src/main/ets/core/capability/DeviceCapabilities.ts`（归档源行）用户可见文案：

- 164：`...APP 无实时视频接口，只能查看在线、监测状态与 FALL 告警证据可用性；...`
- 166：`entry('camera', '摄像头（本地取帧）', ..., '仅本地取帧/证据；APP 无实时视频接口，不显示实时画面')`
- 167：`entry('fall', '跌倒判定（PC YOLO）', ..., '由 PC CPU YOLO 判定，非板端 NPU；FALL 告警与证据元数据可上报')`

判定：属于**设备能力矩阵文案**，不是证据图片功能链路；本轮按“最小化、只针对 CAMERA-A 证据图片链路”
未改动。若发布要求文案与功能完全一致，建议只改 164 行“FALL 告警证据可用性”→“FALL 告警状态”
（不影响 `capability.test.mjs` 现有匹配：`APP 无实时视频接口`、`NO_MOTION`、`原始 ADC` 等断言均不涉及“证据”）。
