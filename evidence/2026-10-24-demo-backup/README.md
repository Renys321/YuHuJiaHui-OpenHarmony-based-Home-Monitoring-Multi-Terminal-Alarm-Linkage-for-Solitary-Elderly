# 当前可演示版本详细备份

归档时间：2026-10-24（Asia/Shanghai）

本目录是当前冻结演示版本的离线备份。它保存可恢复的固件、HAP、PC 服务源码、视觉基线、APP 源码快照和验收文档；不表示归档时所有服务仍在运行。

## 推荐演示组合

| 组件 | 归档文件 | 状态 |
|---|---|---|
| 厨房 ESP32 固件 | `artifacts/firmware/kitchen-330D9CA6.bin` | 当前已部署版本 |
| 卫生间 ESP32 固件 | `artifacts/firmware/bathroom-8D4E9A26.bin` | 当前已部署版本，Wi-Fi 配置未复制 |
| DAYU signed HAP | `artifacts/hap/dayu-eldercare-signed-1F2529C1.hap` | 当前已部署版本 |
| 手机 HAP | `artifacts/hap/phone-guardian-inline-summary-formal-8A722EB6.hap` | 唯一推荐演示包，bundle `com.example.program_04` |
| gateway | `artifacts/services/gateway-64790E7C.js` | 当前冻结 public-sync 逻辑 |
| Broker | `artifacts/services/mqtt_broker-0C9B2C1E.js` | 当前冻结源码 |
| Bridge | `artifacts/services/mqtt_bridge-C2D2CE1F.js` | 当前冻结源码 |
| 板端 homemon | `artifacts/homemon/homemon-board-pre-0D243539` | 当前旧版运行程序备份 |
| PC 视觉基线 | `artifacts/vision/` | 当前旧演示链路，非 DAYU 本机 YOLO |

手机推荐包对应原路径：

`<WORKSPACE>\competition\evidence\2026-10-22-monitor-inline-summary-local\guardian-inline-summary-formal.hap`

## 归档内容

- `artifacts/`：固件、HAP、服务源码、homemon 备份和 PC 视觉基线。
- `source/app-entry/`：手机 APP 的入口源码和构建配置，不含生成的 `build`、`.preview`、`.test` 缓存。
- `source/docs/`：最终交付清单、冻结记录、启动清单、验收矩阵和硬件交接资料。
- `source/materials/`：当前 PC 侧恢复器和启动材料，仅作为旧链路回退工具。
- `evidence/`：最终冻结源码哈希、安装记录和相关回退包。
- `runtime/RUNTIME-STATUS.txt`：归档时的只读本机端口/进程快照。
- `MANIFEST-SHA256.tsv`：本归档内每个文件的大小和 SHA-256。

目录内文件数为 122（不含 ZIP）；清单校验覆盖 120 个内容文件。便携压缩包为：

`<WORKSPACE>\competition\evidence\2026-10-24-demo-backup.zip`

ZIP 的最终大小和 SHA-256 写在同目录的 `2026-10-24-demo-backup.zip.sha256`，避免把 ZIP 自身哈希写进压缩内容造成循环变化。

## 重要边界

1. 当前冻结手机版本是 `8A722...`；`8F8925...` 只是回退包，含已知的恢复后监测页缺陷。
2. `94361A...`、`7A78C68C...`、`6B7CD42C...` 等失败试验包没有作为推荐演示件复制。
3. homemon 新候选没有作为运行版本纳入；当前仍是旧程序 `0D2435...`。
4. COM8 暂停，不属于三节点演示，不在本备份中作为设备接入；COM14/COM5 没有被本轮操作。
5. `PC 视觉基线` 使用电脑端 Python/Ultralytics/PyTorch。它不是 DAYU200 本机 YOLO 部署；DAYU 本机 RKNN/native 迁移仍是后续任务。
6. 本备份没有复制 Wi-Fi 密码、Token、Cookie、Authorization、INGEST_KEY、AppSecret、签名私钥或运行时环境秘密。homemon 配置只保留已核对不含上述秘密的板端参数备份；配置内容不在本文展示。
7. 文档中的历史 PASS 与 `runtime/RUNTIME-STATUS.txt` 的当前快照分开处理，不能用历史 PID 证明服务仍存活。

归档时实际只读快照显示 `1883/6540/9000/9001/9101/9200` 未监听，`127.0.0.1:5555` 仍监听；这不改变冻结包的身份，只说明本次备份没有替用户启动演示服务。

## 恢复顺序

恢复演示时，先阅读归档内 `source/docs/2026-10-22-demo-startup-checklist.md` 和最终交付清单；按清单显式确认单实例、HDC target、homemon、端口和三个 deviceId 的新 202。不要直接运行旧脚本而跳过核对，也不要把失败候选包安装到手机。

本目录只完成备份，没有在归档过程中启动、停止、重启、安装、烧录或发送设备命令。
