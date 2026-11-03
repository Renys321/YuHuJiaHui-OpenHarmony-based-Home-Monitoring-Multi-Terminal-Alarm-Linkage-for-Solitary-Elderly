# SOURCE-ARCHIVE-MANIFEST — 完整候选源码归档清单

- 日期：2026-10-26（Asia/Shanghai）
- 归档文件：`d-e-candidate-source-2026-10-26.zip`
- 构建工具链：Python **3.14.8** / zlib **1.3.1.zlib-ng**（归档字节与工具链绑定；内容核验请用 `MANIFEST.sha256`）
- **3,954,792 B / SHA-256 `F82DA47444785CFB29C254F435DAB40F1569041763BBEEF10D7F5C235A908526`**
- 条目数：**188**（含 5 个生成文件）；归档内 `MANIFEST.sha256` 覆盖 **187** 个文件（该文件自身除外）
- 根目录：`d-e-candidate-source-2026-10-26/`
- 机读清单：`SOURCE-ARCHIVE-HASHES.txt`（187 行，含每项来源）；构建元数据 `_work/archive-build.json`
- 核验结果：`_work/archive-verify.json`（**11/11 PASS**）

## 1. 生成与核验方式（可复现）

```powershell
# 构建（只读输入 + 生成 5 个说明文件 + 固定 ZIP 时间戳）
python competition\evidence\2026-10-26-d-e-release-prep\_work\build_source_archive.py

# 解压到临时目录并端到端核验（含“从解压副本跑后端全量测试”）
python competition\evidence\2026-10-26-d-e-release-prep\_work\verify_source_archive.py
```

构建脚本内置两道自我保护：
1. **敏感信息扫描**：183 个输入文件按私钥/证书/硬编码密钥/GitHub-Token 等模式扫描；
   `*.example` 里的明显占位符（`replace…`/`REPLACE_WITH…`/`example`）被识别并放行，其余一律中止。
2. **冻结 HAP 哈希校验**：输入 HAP 必须等于 `7634A0E2…452EB5`，否则中止。

## 2. 内容构成（按目录）

| 目录 | 文件数 | 字节数 | 说明 |
| --- | ---: | ---: | --- |
| `APP/ElderlyCareGuardian/` | 123 | 3,238,046 | APP 源码、资源、`module.json5`、构建配置、依赖清单/锁、Hypium 与主机侧测试、README/DESIGN_SYSTEM |
| `candidate/` | 1 | 2,621,844 | 冻结候选 HAP **逐字节副本**（未重建） |
| `competition/cloud/backend/` + `competition/cloud/onenet/` | 51 | 792,499 | 候选后端 14 个模块 + 26 个测试文件 + Dockerfile/package.json/README/.env.example；onenet 侧 5 个模块 + package.json（**仅测试依赖**） |
| `competition/deploy/` | 6 | 39,826 | compose 模板、Caddyfile、local-verify、`.env.deploy.example`、`verify/` 预检脚本 |
| `competition/docs/` | 2 | 21,052 | 冻结 API 合同（1.2.0）`APP-API-v1.md` / `.json` |
| `competition/mobile/` | 1 | 5,340 | `utils/validators.js`（**仅测试依赖**） |
| 归档根 | 4 | 8,391 | `README.md`、`VERSIONS.json`、`MANIFEST.sha256`、`EXCLUSIONS.md` |

根因说明：归档**刻意镜像工作区布局**（`APP/` + `competition/`）。冻结测试里有 3 个文件依赖相对路径
（`../../../docs/APP-API-v1.json`、`../../../mobile/wechat-miniprogram/utils/validators`、
`../../onenet/{cloud-sync,gateway,adapter}`）。扁平化会把它们打断 —— 第一版归档就是这么失败的，
现已改成镜像布局并在**解压副本**上复跑通过。

## 3. 关键制品哈希（便于快速比对）

| 制品 | 字节 | SHA-256 |
| --- | ---: | --- |
| 归档本体 | 3,954,792 | `F82DA47444785CFB29C254F435DAB40F1569041763BBEEF10D7F5C235A908526` |
| 候选 HAP（归档内 `candidate/…hap`） | 2,621,844 | `7634A0E25FCE3E19FC9604E4CD94D6D6BAFF36CB5DE67C92DAEE0E50C1452EB5` |
| `competition/cloud/backend/src/activity.js` | 37,941 | `AB555AD8B80857AB52AD3ACFF7BFFD9BA7434919B4F8BCF1027A054FA9736EE9` |
| `competition/cloud/backend/src/persistent-store.js` | 67,044 | 见 `SOURCE-ARCHIVE-HASHES.txt` |
| `competition/cloud/backend/src/server.js` | 37,008 | 见 `SOURCE-ARCHIVE-HASHES.txt` |
| `competition/docs/APP-API-v1.md` | 18,068 | `11BFBBE64F658BFBC69A67E03FFDDECFFDF462B56870094EEF34164B066E1538` |
| `competition/docs/APP-API-v1.json` | 2,984 | `CE12EBB1D7EA222F44A5CABD347DDBFA212F6D5231AFFF068B4D57EB0DA2920B` |
| 完整逐文件清单 | — | `SOURCE-ARCHIVE-HASHES.txt` / 归档内 `MANIFEST.sha256` |

## 4. 归档与实际冻结状态的对应关系

| 检查 | 结果 |
| --- | --- |
| 冻结清单 `SOURCE-HASHES.txt`（136 条）在当前工作区的复核 | **136/136 匹配**（本任务开工时实测，见 `REPORT.md` §1） |
| 冻结交付 `SHA256SUMS.txt`（81 条）复核 | **81/81 匹配** |
| 候选 HAP | 2,621,844 B / `7634A0E2…452EB5`，**未修改**（归档内副本哈希一致） |
| 归档内容与当前工作区 | 归档就是**当前工作区**对应文件（已按冻结清单核对），不是从旧证据拼的新旧混合 |
| 冻结清单未逐文件哈希的部分（APP `resources/`、`module.json5`、模块级配置、`hvigor/`） | 本次归档**首次纳入逐文件哈希**；其 mtime 均早于冻结构建（12:43:25），且 HAP 哈希未变 —— 作为一致性依据已在此说明，不再声称“冻结时已哈希” |

## 5. 解压核验结果（`_work/archive-verify.json`）

| # | 检查 | 结果 |
| --- | --- | --- |
| 1 | ZIP 完整性（`testzip`）+ 188 条目 | PASS |
| 2 | 无绝对路径 / `..` 穿越条目 | PASS |
| 3 | 归档根目录存在 | PASS |
| 4 | 归档内 `MANIFEST.sha256` 逐文件校验（187 条，无缺失/无错配） | PASS |
| 5 | 归档内无清单外文件 | PASS |
| 6 | 候选 HAP 逐字节一致 | PASS |
| 7 | 必要构建输入齐全（37 项检查清单，含 D/E 关键模块与测试） | PASS |
| 8 | 无依赖缓存 / 构建产物 / 真实 `.env` / 签名材料 | PASS |
| 9 | 无私有固件或全片备份（`.bin`） | PASS |
| 10 | 解压副本上 14 个后端模块 `node --check` | PASS |
| 11 | **从解压副本运行 `npm test`** | **PASS：287 tests / 287 pass / 0 fail / exit 0** |

第 11 项是“归档能恢复工程”的最强证据：不是“文件解压成功”，而是解压出来的树**真的能跑完整后端测试**。

## 6. 未归档项（必须与归档一起读）

详见归档内 `EXCLUSIONS.md`，要点：

| 未归档 | 原因 |
| --- | --- |
| `oh_modules/`、`node_modules/` | 依赖缓存；可由 `oh-package.json5` + `oh-package-lock.json5` 重建 |
| `build/`、`.hvigor/`、`entry/.test/`、`tests/build/` | 构建/测试输出，非输入，且含时间戳会造成不可复现 |
| `.idea/`、`preview/`、`.preview/`、`backup-20261022-login-demo-recovery/` | IDE 状态与历史本地备份 |
| `APP/…/local.properties` | 机器专属，替换为 `local.properties.example` 模板 |
| 运行期数据（`backend-state.json`、`activity-state.json`、`evidence/`） | 属部署侧数据卷；归档不得含真实数据 |
| 真实 `.env` / `.env.deploy` / 签名材料 | 含密钥与私钥，禁止交付 |
| `competition/esp32-node/**` 私有固件、全片/分区备份 | 可能含 Wi-Fi 配置，属私有恢复材料 |
| `competition/evidence/**`、`experiments/**`、`northbound/**`、`southbound/**` | 历史证据/DAYU/南向，不属于 D/E 候选构建输入 |
| `competition/cloud/onenet/` 其余文件（含 `status.json`、`gateway.js.bak-*`） | 只有 5 个模块是后端测试传递依赖；其余是设备联调脚本与运行期状态/历史备份 |

## 7. 已知缺口（如实列出，不掩盖）

1. **后端无 `package-lock.json`**：`package.json` 没有任何第三方依赖，锁文件不存在是事实而非遗漏。
   onenet 侧有 `package-lock.json`，但那 5 个模块也只用到 Node 内置模块。
2. **APP 无 `hvigorw` / `hvigor-wrapper.js`**：工程里只有 `hvigor/hvigor-config.json5`；
   构建必须用 DevEco 自带 `hvigor.js`（路径与版本见归档内 `VERSIONS.json`）。
3. **APP 依赖未归档**：恢复时需 `ohpm` 安装 `@ohos/hypium 1.0.25`、`@ohos/hamock 1.0.0`；
   本任务**没有**执行任何安装以改写现有工程。
4. **未做 APP 侧构建复验**：本任务禁止修改业务源码，也不重构建；归档内 HAP 就是冻结候选的副本，
   其一致性用哈希证明，不需要重建。
5. **`candidate/` 的 HAP 是 unsigned debug**，不能安装用于真机验收；它只是“冻结候选字节”的载体。
6. **归档不是备份**：它是源码/构建输入归档，不含数据卷；数据备份见 `DEPLOY-RUNBOOK.md` §5。
