# 旧 northbound 1.0.0 源码归档（2026-10-28）

本目录是合并前 `competition/northbound`（1.0.0 / 1000000，构建源为 2026-10-09~10-25 旧线）
的归档。`signing/` 未在合并中改动，因此其中的 1.0.0 签名资产（`eldercare-signed.hap` 1,860,490 B
等）为原件；`entry/build/` 为 2026-10-25 20:59 的旧构建产物（含 1.0.0 unsigned HAP 1,823,686 B）。

## 必须如实记录的事故与恢复

合并操作脚本 `00-snapshot-archive-sync.ps1` 第一次 dry-run（2026-10-28 00:34）时，`/L` 被误加到
PowerShell 自动变量 `$args`，导致 robocopy 实际执行覆盖：旧 northbound 的源码被 experiments
1.0.10 覆盖（119 个文件中的 7 个差异文件受影响）。发现后立即用以下方式恢复：

| 文件 | 覆盖前大小 | 恢复方式 | 恢复后 SHA-256 |
|---|---|---|---|
| `Index.ets` | 66,383 | ArkTS 编译缓存 msgpack 逐字节提取 | `773c7e98a5e23f7fa21faeb44688a12b01e644f12abe56beac6063c517eee62d` |
| `CameraModel.ets` | 18,137 | 同上 | `71f5dae41b9b7bf00261a556950541c14e94d40a0bc5ad05c400f31146160c59` |
| `DeviceModel.ets` | 9,342 | 同上（与 docs/ARTIFACTS.md 历史哈希 50C7BCC1…E30D 一致） | `50c7bcc17fe8a0e84bc8f17874492f68291eeed7744918af9d2109610773e30d` |
| `DeviceCapabilities.ts` | 1,927 | 同上 | `149fccc7580ac70080981a6a3a4026c8aa761b0d51c091b3d6ee8aaaca29ab51` |
| `AppScope/app.json5` | 246 | 按覆盖前 diff 重建（仅 versionName/versionCode 两行） | 见清单 |

其余 112 个文件在覆盖前后逐字节相同（合并前已做 SHA-256 全量比对），直接取自当前树。
`PreviewTuning.ets` / `VideoStreamServer.ets` / `WearableBannerPrefs.ets` 为 experiments 新增，
旧线不存在，未收录。

恢复方法与验证脚本：`../recovery/recover_v2.py`、`../recovery/recovery-report.json`。
方法校验：同批 msgpack 中 5 个"两棵树逐字节相同"的文件，提取内容 SHA-256 与当前文件一致。

## 回滚含义

- 回滚到 1.0.0 版本 APP：直接安装 `signing/eldercare-signed.hap`（1.0.0/1000000，覆盖安装保留数据）。
- 回滚源码：本目录内源码即 1.0.0 旧线；但注意它**不含** 1.0.1~1.0.10 的所有已验收功能
  （视频 Wi-Fi、预览调参、随身 SOS 横幅、无 PIR 语义、告警归属修复、相机旋转修复），
  不应作为后续构建源。
