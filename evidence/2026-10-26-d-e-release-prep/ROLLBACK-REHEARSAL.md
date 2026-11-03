# ROLLBACK-REHEARSAL — 本地隔离的升级 / 回滚 / 失败保护演练结果

- 日期：2026-10-26（Asia/Shanghai）
- 结论：**`REHEARSAL_PASS`** —— 12 个步骤 + 3 个失败保护全部通过（真实执行，非推演）
- 脚本：`rehearsal/rehearse_upgrade_rollback.js`（可复现）
- 结构化结果：`rehearsal/rehearsal-result.json`；原始控制台日志：`rehearsal/rehearsal-console.log`
- 运行命令：

  ```powershell
  Set-Location '<WORKSPACE>\competition\cloud\backend'
  node "<WORKSPACE>\competition\evidence\2026-10-26-d-e-release-prep\rehearsal\rehearse_upgrade_rollback.js"
  # exit 0
  ```

## 0. 隔离与安全边界

| 约束 | 实际做法 |
| --- | --- |
| 数据位置 | 全部在 `%TEMP%\de-release-rehearsal-*`；**不读、不写任何生产/演示数据文件** |
| 网络 | HTTP 只绑 `127.0.0.1` 的**随机端口**；不连公网、不连设备、不部署 |
| 凭据 | `crypto.randomBytes(48)` 进程内生成，不打印、不落盘 |
| 合成数据 | 设备 `rehearsal-fixture-*`、房间 `合成演练-*`、告警 `rehearsal-alarm-*`、处置 `rehearsal-disp-*`，全部显式标记，不进入演示或生产链路 |
| 容器 | 未使用（本机 `docker` daemon 不可用，见 §5） |
| 收尾 | 临时目录在结束时递归删除；结果 JSON 只保留计数与哈希 |

## 1. 旧版代码从哪里来（必须先说清）

工作区**没有**真实的历史 v5 后端制品。以下是**本任务开工时**（尚未生成本任务的派生物之前）的穷举搜索结果：

| 搜索 | 结果 |
| --- | --- |
| `<WORKSPACE>` 全盘 `persistent-store.js` | 开工时只有 1 份：冻结的 **v6** 树（本任务之后另有 1 份派生的 v5 等价模拟副本，属本任务产物，不是历史制品） |
| 开工时所有 `*.zip` 中的 `backend/src/persistent-store.js` | 只有 D 的 `source-snapshot-D-20261026.zip`，内容也是 **v6**（本任务新增的源码归档同样只含 v6 树与派生模拟，不含历史制品） |
| `2026-10-24` P0 归档（`SOURCES`/`DELIVERY`） | 只有 APP 与 onenet 源码，**不含 backend** |
| `SCHEMA_VERSION = 5` 的代码文件 | 0 处（仅 `isolated-verify.js` 里有一个 v5 **fixture 快照**，不是代码） |
| 公网生产镜像 | 在阿里云主机上，本任务禁止访问 |

因此演练使用 **v5 等价模拟**：`rehearsal/legacy-v5-emulation/`，由冻结树**机械派生**，
只改 `persistent-store.js` 的 3 处（`+3/−4` 行，diff 见 `rehearsal/legacy-v5-emulation/persistent-store.v5-emulation.diff`）：

```text
-const SCHEMA_VERSION = 6;                       →  const SCHEMA_VERSION = 5;
-const READABLE_SCHEMA_VERSIONS = new Set([1,2,3,4,5,SCHEMA_VERSION]);
                                                 →  new Set([1, 2, 3, 4, 5])
-_document() 里写 safetyLogs 的两行             →  不写该键
```

**边界（不得夸大）**：
- 可以证明：v6 代码能读 v5 数据并升级；v5 边界代码**读不了 v6**；按操作单恢复 v5 快照后旧边界代码能启动并读回原数据。
- **不能**证明：真实历史 v5 二进制的行为完全一致；`server.js` 路由表仍是当前的（模拟里还有 D/E 路由），
  所以**不构成旧版兼容验收**，也不能用于合同时代差异验收。

## 2. 演练步骤与结果（逐条）

| # | 步骤 | 结果 | 关键读数 |
| --- | --- | --- | --- |
| 1 | 用 v5 边界代码建立旧 schema 合成状态 | PASS | `schemaVersion=5`、`devices=3`、`alerts=2`、**无** `safetyLogs` 键、活动文件不存在 |
| 2 | 制作升级前备份并记录哈希 | PASS | 备份树 `A3975FF7…9AB9EE2`；仅 `backend-state.json`（2,765 B / `CBCB5891…A96674`）；活动文件不在备份中（正确） |
| 3 | 冻结候选加载 v5 并做一次有效写入 | PASS | 读到 2 条既有告警；写入后 `schemaVersion=6`，`safetyLogs` 台账出现 |
| 4 | 加入 D 的处置/安全日志并重新加载 | PASS | 3 条（`dsp-1..3`），重新打开存储仍是 3 条，`actor=household-guardian`（服务端固定角色） |
| 5 | 加入 E 的活动记录并重新加载 | PASS | 活动文件 `version=1`；当日触发计数 `5`；`dataSince` 为 **number** |
| 6 | 完整保留升级后数据 | PASS | 升级后树 `8FF8A748…33B178C`；文件 = `backend-state.json` + `activity-state.json` |
| 7 | 按操作单回滚（校验→staging→移走→落位→复核） | PASS | 5 个守卫全过；升级后数据被**移到旁边保留**（`data.post-upgrade-aside-*`），未删除 |
| 8 | 旧边界代码读取恢复后的数据 | PASS | `schemaVersion=5`、`alerts=2`、只有合成告警 |
| 9 | 真正启动旧版 HTTP 服务（127.0.0.1 随机端口） | PASS | `GET /api/v1/alerts` → **200**，返回 2 条合成告警 |
| 10 | 清点回滚后离开运行数据的记录 | PASS | 运行数据只剩 `backend-state.json`；`activity-state.json` 不在运行数据里，但在留档里；3 条处置只留在 v6 留档 |
| 11 | v5 边界代码拒绝 v6 快照 | PASS | 抛出 `persistent store unsupported schemaVersion: 6` |
| 12 | 恢复后的 v5 数据能被候选版本再次加载 | PASS | 候选读到 2 条告警；`schemaVersion` 仍为 5（尚未写入） |

**回滚的字节级证据**：

```text
preUpgrade   = A3975FF7055127BB102EDB6D4DBF5ABEF312F1E9CBAFFCFE6E546B9419AB9EE2
postUpgrade  = 8FF8A7486861815C4470AA5F64C902DF9409E42B3476667DA32BBD8A533B178C
restoredLive = A3975FF7055127BB102EDB6D4DBF5ABEF312F1E9CBAFFCFE6E546B9419AB9EE2   ← 与升级前**逐文件哈希**一致
```

## 3. 失败保护（真实注入失败，验证“中止且不破坏原数据”）

三次都从**升级后数据的一份副本**开始，注入不同故障，然后调用**同一个**回滚函数：

| 注入的故障 | 是否中止 | 运行数据是否未被改动 | 是否已移动数据 | 中止原因 |
| --- | --- | --- | --- | --- |
| 升级前备份归档被篡改（改 1 字节） | 是 | 是（树哈希前后一致） | 否 | `pre-upgrade backup hash mismatch -> abort` |
| 升级前备份校验元数据不匹配 | 是 | 是 | 否 | 同上 |
| 升级后数据留档缺失（快照目录不存在） | 是 | 是 | 否 | `post-upgrade snapshot missing -> abort` |

关键点：**三次中止都发生在“移动运行数据”之前**（`asideCreated=false`），所以不存在
“已经删掉原文件才发现备份坏了”的窗口。这正是纠正版操作单 §8 的设计目标。

## 4. 回滚后“哪些记录消失 / 仍保存在哪”

| 记录 | 回滚后是否出现在运行数据 | 仍保存在 |
| --- | --- | --- |
| 升级前就有的设备/告警（3 设备 / 2 告警） | ✅ 在（逐字节恢复） | 运行数据 `backend-state.json`（v5） |
| D 的 3 条处置记录 / 安全日志 | ❌ 不在（v5 格式无 `safetyLogs`） | 升级后留档的 v6 `backend-state.json`（`_rollback-archive` / `post-upgrade-data-*.tgz`） |
| E 的活动统计 | ❌ 不在运行数据里 | 升级后留档的 `activity-state.json` |
| 备份之后发生的设备状态/告警/ACK 变更 | ❌ 不在（回到备份时点） | 同上留档（但**旧代码读不了 v6**） |

**没有自动合并**：本任务未提供也不主张具备 v6→v5 的人工数据回填工具。

## 5. 未验证的层级（必须一起读）

| 层级 | 状态 | 原因 |
| --- | --- | --- |
| 文件级/进程级升级·回滚·失败保护 | ✅ 本次真实运行 | 见上 |
| **容器级**（Docker 镜像 tag / `docker save` / Compose 覆盖固定 / `--no-build` / 卷内 tar） | ❌ **未验证** | 本机 `docker` **client 29.9.2 存在但 daemon 不可用**：`docker info` 退出码 1，`docker images/ps/volume ls` 均失败或无输出。按任务要求未安装 Docker、未启动现有演示服务 |
| 公网主机实际命令 | ❌ 未验证 | 需现场授权与只读核验；`eldercare-public_backend-data` 卷名需现场 `docker volume ls` 确认 |
| 真实旧版二进制 | ❌ 不可能验证 | 工作区无该制品（已穷举） |
| 真机 APP 回退 | ❌ 未验证 | 需签名材料与设备 |

**补救方式**（本任务不执行）：Docker 可用后，在**独立项目名 + 临时卷 + 回环端口**下重跑
`DEPLOY-RUNBOOK.md` §4/§5/§8 的容器级命令；不得复用现有演示容器/卷，
不得为此改动现有部署。演练脚本的 `rollback()` 函数已把“先校验后动手、移走不删除”的
顺序固化为可执行逻辑，容器级脚本应保持同一顺序。

## 6. 复现方式

```powershell
# 1) 重建 v5 等价模拟（只改 persistent-store.js 的 3 处）
python competition\evidence\2026-10-26-d-e-release-prep\_work\build_legacy_emulation.py

# 2) 运行演练（exit 0 = REHEARSAL_PASS）
Set-Location competition\cloud\backend
node ..\evidence\2026-10-26-d-e-release-prep\rehearsal\rehearse_upgrade_rollback.js

# 3) 查看结构化结果
Get-Content ..\evidence\2026-10-26-d-e-release-prep\rehearsal\rehearsal-result.json -Raw
```

注意：脚本会**重新生成**同样的步骤与守卫；文件树哈希（`preUpgrade` / `restoredLive`）的
**前后相等关系**应稳定复现，但具体哈希值取决于 Node 序列化与时间戳字段，不要求逐字节相同。
