# P0 演示基准备份总清单（2026-10-24）

生成时间：2026-10-25T00:03:12+08:00（Asia/Shanghai）
备份目录：<WORKSPACE>\competition\evidence\2026-10-24-p0-final-demo-backup
性质：P0-A/P0-B 已 REAL PASS 后的归档；本任务未改功能、未动当前运行现场。

## 1. 归档包

| 包 | 大小(B) | SHA-256 | 条目数 | 解压大小(B) |
|---|---:|---|---:|---:|
| `OpenHarmony-P0-DEMO-DELIVERY-2026-10-24.zip` | 2231851 | `293BE8632566A6C17855E0C35D505ED76F099F0CA4B1D19465D0F4F64A0384F8` | 66 | 5,017,701 |
| `OpenHarmony-P0-SOURCE-EVIDENCE-2026-10-24.zip` | 2626021 | `F50F84CD5DC5B03CC7B1907A5C295CA05542774D3DF90BDED8F9412779D52A16` | 165 | 3,643,782 |

两个 ZIP 均另存为未压缩目录供直接查看：

`	ext
P0-DEMO-DELIVERY\       演示交付内容（artifacts/docs/evidence + MANIFEST + SHA256SUMS）
P0-SOURCE-EVIDENCE\     源码与证据快照（source/docs/evidence + MANIFEST + SHA256SUMS）
`

## 2. APP 包

`	ext
当前正式推荐（本轮 REAL PASS，已安装）：
  artifacts/guardian-app-p0-sensors-autorefreshfix-2026-10-24.hap
  size=2086949 B
  sha256=9EEBEE9A5FC9EEC5A5993DC6923F16F0BFCCCD1CD4DE64BAF36FC7197ECAD25A

回退包（冻结基线，未被使用）：
  artifacts/guardian-inline-summary-formal.hap
  size=2077912 B
  sha256=8A722EB6FDA7BB73EE58F3BDA3D95B5D238401DA8E3CC9179F1286FD5253A985
`

## 3. 恢复资料（备份根目录）

| 文件 | 作用 |
|---|---|
| `RESTORE-GUIDE.md` | 架构、正常启动顺序、凭据区分、USB/fport 恢复、APP 回退、已知边界 |
| `DEMO-START-CHECKLIST.md` | 演示启动逐项检查清单 |
| `CURRENT-RUNTIME-SNAPSHOT.md` | 归档时当前运行现场只读快照（PID/端口/锁/APP） |
| `SOURCE-STATUS.txt` | Git 事实与关键源码哈希（工作区无 Git 仓库） |
| `EXCLUSIONS.md` | 包含/排除规则、秘密扫描方法、已排除项与原因 |
| `PORT-MAPPING-CONFLICT.md` | COM14/COM5 与现场 COM6/COM9/COM11 冲突说明（只记录） |
| `ROLLBACK.md` | APP 回退步骤与报告纪律 |
| `BACKUP-VERIFICATION.md` | 离线解压、哈希、语法、秘密扫描、预检安全验证结果 |
| `verify-backup-offline.ps1` | 可重跑的离线验证脚本 |
| `verification-result.json` | 本次离线验证的机器可读结果 |
| `SHA256SUMS.txt` | 本目录文件校验和（含两个 ZIP 与两份树内 SHA256SUMS） |
| `MANIFEST.md` | 本文件 |

## 4. 内容概要

- 演示交付包：当前 APP HAP、回退 HAP、supervisor/worker、public-sync/gateway/cloud-sync/
  command-sync/transport/adapter/token、Broker/Bridge、DAYU 校时、正式一键入口、只读验收工具、
  DAYU homemon 原版可信本地二进制、启动/恢复/回退文档、必要的 P0-A/P0-B 证据。
- 源码与证据包：APP 受控源码快照（entry/src/main/ets、resources、test、配置与 AppScope）、
  cloud/onenet 与 bridge 源码/测试/package、materials 启动入口、southbound 校时、
  非敏感配置模板说明、P0 冻结与验收文档、历史交付索引/版本清单/启动清单、
  身份诊断结论、P0-A/P0-B 验收证据、可重跑的离线验证脚本。

逐文件清单见各自目录内 `MANIFEST.md`；校验和见各自 `SHA256SUMS.txt`
（demo 65 行；source 164 行）。

## 5. 验证结论

`	ext
OFFLINE RESTORE VERIFIED
两个 ZIP 解压正常、无路径穿越、SHA256SUMS 全匹配、HAP 哈希正确、
正式入口/ supervisor/worker 齐全、PowerShell/Node 语法检查通过、
秘密扫描 0 命中、正式入口 -Preflight 未启动第二实例且运行现场未改变。
`

未重新验收的功能（MQ/PIR/自动刷新/离线恢复/supervisor 稳定性）属于已 PASS 的 P0-A/P0-B，
本任务未重测；详细边界见 `BACKUP-VERIFICATION.md` 与 `EXCLUSIONS.md`。

## 6. 后续任务入口

下一项独立任务为 **P1-A：DAYU200 本机 YOLO 迁移与性能可行性验证**。
它必须与当前 PC 演示链路隔离，不得修改或覆盖本备份；在完成前不要同时迁移 Bridge/MQTT/public-sync。
