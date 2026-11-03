# legacy-v5-emulation — v5 等价模拟（**不是历史制品**）

```text
类型：DERIVED_EMULATION  (NOT_A_HISTORICAL_ARTIFACT)
用途：仅用于本地隔离的回滚演练，验证「旧代码读不了 v6 快照」和「恢复 v5 数据后旧版能启动」
```

## 为什么需要它

工作区里**没有**升级前（schema v5）的后端制品。穷举搜索结论：

- `<WORKSPACE>` 下所有 `*.js`/`*.json` 里只有一份 `persistent-store.js`（= 冻结的 v6 树）；
- 所有 `*.zip` 中只有 D 的 `source-snapshot-D-20261026.zip` 含该文件，也是 **v6**；
- `2026-10-24` 的 P0 归档只含 APP 与 onenet 源码，**不含 backend**；
- 公网生产镜像在阿里云主机上，本任务禁止访问。

因此不能声称“用真实旧版完成了兼容验收”。本目录是**机械派生**的等价模拟，
差异已在下表逐条列出。

## 派生方式（相对冻结树只有 3 处机械修改，仅 `src/persistent-store.js`）

| # | 冻结树（v6） | 本模拟（v5 等价） | 作用 |
| --- | --- | --- | --- |
| 1 | `const SCHEMA_VERSION = 6;` | `const SCHEMA_VERSION = 5;` | 写入快照标 v5 |
| 2 | `READABLE_SCHEMA_VERSIONS = new Set([1,2,3,4,5,SCHEMA_VERSION])` | `new Set([1,2,3,4,5])` | 读不了 v6（回滚必须换快照的根因） |
| 3 | `_document()` 写 `safetyLogs` 键 | 不写该键 | 产出 v5 形状 |

其余 13 个 src 模块与冻结树**逐字节相同**（哈希见 `EMULATION-MANIFEST.json`）。

## 与实际旧版的差别（不得省略）

1. `server.js` 保留当前路由表，因此它还暴露 dispositions / safety-logs / activity 路由；
   实际 v5 时代没有这些接口。→ 演练中**不**对“旧版”调用这些接口。
2. 除 schema 版本边界外的其它模块行为都是当前树的，不是 2026-10-24 时的行为。
3. 因此本模拟**不能**用于旧版兼容验收、合同时代差异验收或性能/依赖对比。

## 结论边界

- 可以证明：v6 代码能读 v5 数据并按需升级为 v6；v5 边界代码**读不了 v6**；
  按操作单恢复 v5 快照后，v5 边界代码能启动并读到原有设备/告警。
- 不能证明：真实历史 v5 二进制的行为完全一致；容器级（Docker）步骤（本机 Docker daemon 不可用）。
