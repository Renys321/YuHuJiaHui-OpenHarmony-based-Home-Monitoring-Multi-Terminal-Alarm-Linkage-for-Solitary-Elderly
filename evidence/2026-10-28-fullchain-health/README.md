# 2026-10-28 全链路体检 · 证据包索引

> 这是 2026-10-28 凌晨（01:41–14:30）对演示系统做的**只读全链路体检 + 三次现场改造**的完整证据包。
> 所有结论都对应原始日志/命令输出；改造均留了回滚点。

---

## 0. 先看结论（3 分钟）

| 文件 | 内容 |
|---|---|
| **`REPORT.md`** | 全链路体检总报告：逐段判定、量化指标、今晚故障时间线、单点排序、演示检查清单、口径陷阱 |
| `RISK-DEEPDIVE.md` | 三个单点的深度拆解（hdc fport / ESP32 共因 / INGEST_KEY）：机制、实证、前兆、止损、根治 |
| `FIX-PLAN-hdc-frame-corruption.md` | 板端长帧 8.2% 字节损坏的根因定案（762=768−6 边界）与 4 档修复方案 |
| `GAS-MQ5-DIAGNOSIS.md` | 厨房燃气 raw 恒 4095 的定位（10-26 语音改造把 MQ-5 从 IO9 迁 IO7）与万用表确诊步骤 |
| `GAS-ALARM-ENABLE-20261028.md` | 燃气/烟雾报警阈值启用（900/700）的三层改动、验证与回滚记录 |

**一句话现状**：当前这一轮链路稳定（PC 侧 50+ 分钟零断链），但整体不具备无人值守稳定性；
风险集中在 hdc fport、ESP32 共因、`INGEST_KEY` 三处。

---

## 1. 目录结构

```
2026-10-28-fullchain-health/
├── README.md                  ← 本索引
├── _CONTEXT.md                ← 体检时的运行时基准（进程/端口/连接/日志路径）
├── REPORT.md                  ← 总报告
├── RISK-DEEPDIVE.md           ← 三单点详解
├── FIX-PLAN-hdc-frame-corruption.md
├── GAS-MQ5-DIAGNOSIS.md
├── GAS-ALARM-ENABLE-20261028.md
├── nodes/                     ← 节点层证据（4 个节点在线性/上报新鲜度）
│   ├── FINDINGS.md / RAWMEMO.md
│   └── mqtt-sub-home.log / mqtt-tsprobe.log / _probe_mqtt_ts.js
├── transport/                 ← 传输层证据（bridge/broker/relay/fport）
│   ├── FINDINGS.md / RAWMEMO.md
│   └── _tcp9001_raw*.bin / _mqtt_capture2.log / _mqtt_latency.log
├── cloud-app/                 ← 云与应用层证据（public-sync/ECS/APP/视频推理）
│   └── FINDINGS.md / RAWMEMO.md
└── lead/                      ← Lead 的交叉验证与改动产物
    ├── RAWMEMO.md             ← Lead 原始证据（MQTT 观测、长窗口时间线、坏帧分析结论）
    ├── tools/                 ← 复现/分析脚本
    ├── logs/                  ← 观测与构建日志
    ├── ui-dumps/              ← APP UI 快照（登录/监测页，用于验证文案）
    └── artifacts/             ← 固件与 APP 构建产物（含签名 HAP）
```

---

## 2. 报告阅读顺序

1. `REPORT.md` §0–§1：结论 + 链路逐段判定
2. `REPORT.md` §2–§3：节点表 + 量化指标
3. `REPORT.md` §4–§5：新缺陷（坏帧）与今晚故障时间线
4. `RISK-DEEPDIVE.md`：三个单点怎么盯、怎么止损
5. 需要排障时：`FIX-PLAN-hdc-frame-corruption.md`、`GAS-MQ5-DIAGNOSIS.md`
6. 改造记录：`GAS-ALARM-ENABLE-20261028.md`

---

## 3. 分层证据怎么用

| 目录 | 回答什么问题 | 关键文件 |
|---|---|---|
| `nodes/` | 4 个节点是否真在线、4/4 口径、上报节拍与延迟 | `FINDINGS.md` 的逐节点表；`mqtt-tsprobe.log` 的到达时刻 |
| `transport/` | 链路是否稳、坏帧根因、断线时刻 | `FINDINGS.md` 的判定表与 60 分钟时间线；`_tcp9001_raw*.bin` 是坏帧原始字节 |
| `cloud-app/` | 云端/APP/视频/推理是否稳、哪些字段是"好看但证据弱" | `FINDINGS.md` §8 点名清单 |
| `lead/` | 交叉验证（独立观测、长窗口时间线）与本次改造产物 | `RAWMEMO.md`；`tools/` 里的复现脚本 |

---

## 4. `lead/` 内部说明

### tools（可复现的分析脚本）
| 脚本 | 用途 |
|---|---|
| `analyze-badframes3.js` | 按设备基准统计 9001 原始流的坏帧率与插入长度（输入：`transport/_tcp9001_raw*.bin`） |
| `verify-dup-model3.js` | 重建"真值帧"并做 LCP/LCS 对齐，证明重复段终止于偏移 762 |
| `analyze-badframes.js` / `analyze-badframes2.js` | 早期两版（保留过程） |
| `sign-phone-app.ps1` | 手机 APP 的 debug 证书链签名脚本（previewtest 身份；最终安装用未签名包，见下） |

```powershell
# 复现坏帧分析
& D:\Node\node.exe transport\..\lead\tools\analyze-badframes3.js transport\_tcp9001_raw2.bin
```

### logs
- `mqtt-observe-150s.log`：150s `home/#` 观测（3 主题、节拍 3.01s/5.50s、无 sos 主题）
- `gas-check-now.log` / `gas-verify-120s.log` / `gas-baseline-600s.log`：燃气修复前后的 ADC 采样
- `app-phone-build*.log` / `app-board-build.log`：两次 APP 构建
- `mqtt-observe-150s.err.log`：空（无 stderr）

### ui-dumps
手机/板端 APP 的 `uitest dumpLayout` JSON，用于验证：
- 监测页 `燃气（MQ-5） 原始 ADC … 报警已启用`（`phone-monitor-ui.json`）
- 登录页/恢复登录后的首页（`phone-login*.json`、`phone-after-login*.json`）
- 板端 APP `全屋在线 4/4`（`board-ui-after.json`）

### artifacts
| 路径 | 说明 |
|---|---|
| `firmware/esp32_elder_node.bin` | 阈值启用版厨房固件（1,023,504 B，SHA-256 `17852D75…B2`，完整值见 `GAS-ALARM-ENABLE-20261028.md` §2） |
| `firmware/sdkconfig.kitchen-alarm.txt` | 该固件完整 sdkconfig（含 `MQ5_ALARM_RAW=900 / MQ2_ALARM_RAW=700`） |
| `firmware/BACKUP-RECORD.txt` | 写前 app 分区备份的大小与 SHA-256（备份本体在 `esp32-node/.local/gas-alarm-20261028/device-backup/`） |
| `app-board-sign/eldercare-gas-alarm-signed.hap` | **板端 APP**（签名后安装成功），2,063,260 B |
| `app-sign/guardian-gas-alarm-1.0.11-signed.hap` | 手机 APP 的 previewtest 签名包（**安装被拒**：与在装签名身份不一致；实际用未签名 HAP 装到开发镜像） |
| `app-sign-official/` | 用 SDK release 链签手机包的尝试（`Invalid base64`），保留过程证据 |

> ⚠️ 这些 HAP 是**证据/回滚点**，不是当前安装包。当前实际安装：
> 手机 `APP/ElderlyCareGuardian/entry/build/.../entry-default-unsigned.hap`（模拟器开发镜像接受未签名）；
> 板端 `eldercare-gas-alarm-signed.hap`。

---

## 5. 边界与注意事项

- 体检**全程只读**（订阅/读日志/netstat/TCP 探连/hdc 只读），未重启、未发布命令、未改板端。
- 后续三次改造（燃气阈值、APP 能力开关、固件重烧）都有回滚点，记录在 `GAS-ALARM-ENABLE-20261028.md` §7。
- 时间窗口：体检 01:41–01:55；长窗口统计 22:34–01:45（来自既有 timeline 采集器）。
- 未验证项：真实气体触发、跌倒真人样本、ECS 公网故障演练；不要把这些证据外推为"已验收"。
- 不要把 `artifacts/` 里的 HAP 当作最新包；重新构建见 `competition/firmware/README.md` 与 `APP` 工程。
