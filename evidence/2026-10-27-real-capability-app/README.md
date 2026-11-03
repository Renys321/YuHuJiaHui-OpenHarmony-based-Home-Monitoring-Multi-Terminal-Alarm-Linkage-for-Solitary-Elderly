# 2026-10-27 老人监护 APP 真实能力补齐与界面整改 — 证据目录

先读 [`REPORT.md`](REPORT.md)。

| 目录/文件 | 内容 |
|---|---|
| `REPORT.md` | 交付报告：逐项结论、改动、证据等级、未完成项、回滚 |
| `baseline/` | 改造前只读取证（APP 1.0.6、8 台设备含隔离测试、我的页“未接入”、UI 缺陷） |
| `hardware/` | 电量/PIR/门磁/摄像头与视频链路硬件核验（REAL/SOURCE-ONLY/NOT TESTED/BLOCKED） |
| `app/` | APP 1.0.7 HAP、SHA-256、构建日志 |
| `acceptance/` | 1.0.7 模拟器 + 生产账号运行验收：截图索引、18 张截图、bm dump |
| `logs/` | APP tsc/456 测试；后端 check/393 测试 |
| `verify/` | 生产 API 匿名边界只读探测 |
| `_work/source-before-20261027-1848/` | 改造前源码快照（回滚用） |
| `SHA256SUMS.txt` | 本目录（不含 `_work/`）文件哈希 |

验收环境：HarmonyOS 模拟器 `127.0.0.1:5555`，APP `com.example.program_04` 1.0.7/1000007，生产后端 `https://api.luxunacc.xyz` 只读数据。
