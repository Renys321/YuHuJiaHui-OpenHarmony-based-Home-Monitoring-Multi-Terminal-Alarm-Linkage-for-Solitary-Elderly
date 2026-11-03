# 备份离线验证记录（2026-10-24 / 2026-10-25 凌晨）

本文件记录对两个归档包的真实解压与离线验证结果。验证过程**没有启动业务服务**，
没有安装 HAP，没有操作串口，没有发送 MQTT/HTTP，没有修改当前运行现场。

## 1. 归档包

```text
OpenHarmony-P0-DEMO-DELIVERY-2026-10-24.zip
  size        2,231,851 B
  sha256      293BE8632566A6C17855E0C35D505ED76F099F0CA4B1D19465D0F4F64A0384F8
  entries     66（64 个归档文件 + MANIFEST.md + SHA256SUMS.txt）
  uncompressed 5,017,701 B

OpenHarmony-P0-SOURCE-EVIDENCE-2026-10-24.zip
  size        2,626,021 B
  sha256      F50F84CD5DC5B03CC7B1907A5C295CA05542774D3DF90BDED8F9412779D52A16
  entries     165（163 个归档文件 + MANIFEST.md + SHA256SUMS.txt）
  uncompressed 3,643,782 B
```

两个 ZIP 均解压到临时验证目录，验证完成后临时目录已删除；备份目录保留未压缩树与 ZIP。

## 2. 逐项验证结果

| 检查项 | demo ZIP | source ZIP | 结果 |
|---|---|---|---|
| 正常解压 | OK | OK | PASS |
| 路径穿越（绝对路径/`..`） | 无 | 无 | PASS |
| `SHA256SUMS.txt` 全部匹配 | 65/65 | 164/164 | PASS |
| `9EEBEE…` 当前 APP 哈希 | `9EEBEE9A5FC9EEC5A5993DC6923F16F0BFCCCD1CD4DE64BAF36FC7197ECAD25A` | 不适用（按设计只在 demo 包） | PASS |
| `8A722…` 回退 APP 哈希 | `8A722EB6FDA7BB73EE58F3BDA3D95B5D238401DA8E3CC9179F1286FD5253A985` | 不适用 | PASS |
| supervisor/worker 齐全 | 是 | 是 | PASS |
| 正式入口 `.cmd/.ps1` 齐全 | 是 | 是 | PASS |
| PowerShell 语法（无副作用解析） | 4 个，0 错误 | 4 个，0 错误 | PASS |
| Node `--check` 语法 | 13 个，0 错误 | 26 个，0 错误 | PASS |
| 文本文件秘密扫描 | 63 个文本，0 命中 | 152 个文本，0 命中 | PASS |

### 2.1 PowerShell 编码解析说明

```text
start-demo-supervisor.ps1        utf8-bom(default)   解析 0 错误
verify-supervisor-acceptance.ps1 utf8-bom(default)   解析 0 错误
probe-api-lastseen-p0a.ps1       default             解析 0 错误
demo_recover.ps1（旧回退）        utf8                解析 0 错误（UTF-8 无 BOM）
```

`demo_recover.ps1` 为旧链路回退参考，不是当前推荐入口；它的中文注释在 Windows PowerShell
5.1 `-File` 下可能因 ANSI 解码产生误判，已记录在 `EXCLUSIONS.md`。

### 2.2 文档相对路径解析

- 两个 ZIP 内均为 23 个 Markdown 相对链接，其中 **17 个**指向更早历史文档
  （COM8、bath Wi-Fi、valid、homemon 等），这些目标**按设计不纳入本 P0 归档**。
- 本轮新增/当前文档（RESTORE-GUIDE、DEMO-START-CHECKLIST、ROLLBACK、
  PORT-MAPPING-CONFLICT、CURRENT-RUNTIME-SNAPSHOT、SOURCE-STATUS、EXCLUSIONS、
  P0 冻结与验收文档、身份诊断结论）的相对链接全部可在归档内解析。
- 历史文档保留原文，不修改其历史链接，符合“不把旧报告改写成本轮结论”的纪律。

### 2.3 秘密扫描口径

只扫描文本文件，只做“值级”匹配，输出仅 `文件路径 | 命中类型 | 是否排除`，不输出匹配值。
扫描前对 `cloud/onenet/adapter.test.js` 与 `cloud/onenet/command-sync.test.js` 的测试夹具
命中已按“命中即排除”删除，因此最终归档为 0 命中。

## 3. 正式入口 `-Preflight` 现场安全验证

从 demo ZIP 解压目录运行 `artifacts/start-demo-supervisor.ps1 -Preflight`：

```text
exit code = 0
输出包含：已有 public-sync supervisor 进程 PID=11872；本入口拒绝启动第二个实例
输出包含：PREFLIGHT PASS（只读模式，未启动任何服务）
```

运行前后现场对比（全部一致）：

| 项 | 运行前 | 运行后 |
|---|---|---|
| supervisor/worker/broker/bridge PID 与父子 | 11872(ppid 51568)、50580(ppid 11872)、43624、47704 | 完全一致 |
| 端口 1883/9001/9101 owner | 43624 / 43868 / 47704 | 完全一致 |
| supervisor lock | 11872 | 11872 |
| state | HEALTHY | HEALTHY |
| APP PID | 26710 | 26710 |

结论：正式入口的预检**不会启动第二实例**、不会改变当前运行现场。

## 4. 当前现场仍在运行

验证结束时（只读复核）：

- supervisor 11872 / worker 50580 / Broker 1883 / Bridge 9101 / fport 9001→9000 均在；
- 模拟器 127.0.0.1:5555 与 APP PID 26710 均在；
- 三设备自然 202 计数持续增长（详见 `CURRENT-RUNTIME-SNAPSHOT.md`）。

## 5. 未执行项（NOT TESTED）

- 未重新验收 MQ/PIR/APP 自动刷新/离线恢复/supervisor 稳定性（属于已 PASS 的 P0-A/P0-B，本任务不重测）。
- 未重新构建 APP、未重新安装 HAP、未启动/切换 supervisor 入口。
- 未操作任何 COM 端口、未烧录 ESP32、未操作 Wi-Fi/AP/backend/DNS。
- 未验证实体手机兼容性、DAYU 本机 YOLO、4G、COM8、门磁（不属于当前 P0）。

## 6. 结论

```text
OFFLINE RESTORE VERIFIED：两个 ZIP 均可解压，哈希清单全部匹配，
APP 当前包/回退包哈希正确，正式入口与 supervisor/worker 齐全，
语法检查通过，秘密扫描 0 命中，正式入口预检未改变运行现场。
```
