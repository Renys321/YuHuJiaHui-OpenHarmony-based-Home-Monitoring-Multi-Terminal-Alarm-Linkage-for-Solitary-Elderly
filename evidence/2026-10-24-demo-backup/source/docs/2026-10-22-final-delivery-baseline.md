# 最终演示版本清单与验收矩阵（2026-10-22）

本轮只做只读归档与文档更新；未改业务代码、未重建、未安装、未重启服务。  
本文覆盖当前实际运行版本，并明确区分“已部署/已安装”“回退基线”“仅候选”“部署 BLOCKED”。

> **冻结状态（2026-10-23）**：手机端唯一推荐 `8A722EB6…3A985`；运行目标是 **HarmonyOS 手机模拟器** `127.0.0.1:5555`，不是实体手机兼容性验收。
> `8F8925…` 是**含“恢复后监测页可能不更新”已知缺陷的回退版本**，不是等价交付。
> `94361A…`、`7A78C68C…`、`6B7CD42C…` 为失败试验包，禁止作为演示安装包。
> 冻结收尾记录：[8A722 最终版本冻结](2026-10-23-final-freeze-8a722.md)。

## 1. 当前实际运行版本

### 1.1 ESP32 节点固件

| 设备 | 绝对路径 | 大小 | 完整 SHA-256 | 状态 |
|---|---|---:|---|---|
| 厨房 `esp32-kitchen` | `<WORKSPACE>\competition\esp32-node\build-kitchen\esp32_elder_node.bin` | 782,496 B | `330D9CA6EF858B0A4043607CA2EB7E92125A9030F2D06B05DA1218B8CCE62938` | **已部署/在线** |
| 卫生间 `esp32-bath` | `<WORKSPACE>\competition\esp32-node\build-bathroom\esp32_elder_node.bin` | 775,616 B | `8D4E9A266950B364F1AC714194D4AD9FAA6BD70B447C72EBCA377AE863E902CE` | **已部署/在线**（最终 Wi-Fi 配置；SSID/密码不输出） |

卫生间固件对应最终 Wi-Fi 配置；配置内容不写入归档。

### 1.2 DAYU 与手机 HAP

| 用途 | 绝对路径 | 大小 | 完整 SHA-256 | 状态 |
|---|---|---:|---|---|
| DAYU signed HAP | `<WORKSPACE>\competition\northbound\signing\eldercare-signed.hap` | 1,860,490 B | `1F2529C1164662B64257E7F1ABA833B3232025DE06146A058F72AD4B4A9D1073` | **已部署**（此前验收） |
| 手机最终安装候选（摘要内联，真实 PASS） | `<WORKSPACE>\competition\evidence\2026-10-22-monitor-inline-summary-local\guardian-inline-summary-formal.hap` | 2,077,912 B | `8A722EB6FDA7BB73EE58F3BDA3D95B5D238401DA8E3CC9179F1286FD5253A985` | **已安装**（`127.0.0.1:5555`，保留数据/会话）；真实同进程 3/5→2/5→自动 3/5，bath 24.2/51 |
| 手机回退版本（8F，含已知缺陷） | `<WORKSPACE>\competition\evidence\2026-10-22-offline-expiry-local\guardian-offline-expiry-candidate.hap` | 2,076,372 B | `8F8925BD85B6F28524DC9EDAC3E4BFF00C0658A736770CEEFC062C72680F769F` | 保留回退；含“恢复后监测页可能不更新”已知缺陷 |
| 手机回退（上一版） | `<WORKSPACE>\competition\evidence\2026-10-23-valid-contract-local\guardian-valid-candidate.hap` | 2,075,527 B | `86805DC2EBAA3D39DE58F5255CFBCF924EF178EA64820BAECF8C65325DDF9504` | **回退上一版** |
| 手机原始基线 | `<WORKSPACE>\competition\evidence\2026-10-23-valid-contract-local\guardian-baseline.hap` | 2,075,388 B | `94F90E2148042C875B259464A331C72101979E77471225F64F9B09B14812CBFD` | **仅回退** |
| 手机监测刷新候选（失败，未安装） | `<WORKSPACE>\competition\evidence\2026-10-22-monitor-refresh-local\guardian-monitor-refresh-candidate.hap` | 2,078,514 B | `94361A6603A3ABCFC33EF2F965D92B55B301E087695B4931A63CFF843F2212A7` | **未安装**：同进程断电时监测页仍 3/5，已回退 |
| 手机 live-snapshot 候选（失败，未安装） | `<WORKSPACE>\competition\evidence\2026-10-22-monitor-refresh-local\guardian-live-snapshot-candidate.hap` | 2,078,501 B | `7A78C68C928A0FF2C6B688DED34BD70FD3A0E52E3B073E25ADC1A1FD5C21A7EE` | **未安装**：同进程恢复后监测页仍 2/5，已回退 |
| 手机平台绑定测试候选（失败，未安装） | `<WORKSPACE>\competition\evidence\2026-10-22-monitor-refresh-local\guardian-platform-test-candidate.hap` | 2,085,848 B | `6B7CD42C0B41E417579DE298DA0A18EC1F5BCC96701FCBAF858F31FDC9D9F816` | **未安装**：A→B 平台测试摘要仍 3/5，已回退 |
| 默认构建输出（摘要内联候选） | `<WORKSPACE>\APP\ElderlyCareGuardian\entry\build\default\outputs\default\entry-default-unsigned.hap` | 2,077,912 B | `8A722EB6FDA7BB73EE58F3BDA3D95B5D238401DA8E3CC9179F1286FD5253A985` | 与当前安装候选一致 |

手机包标识：`com.example.program_04`；安装目标：`127.0.0.1:5555`。DAYU 包标识：`com.dsh.eldercare`。

### 1.3 PC 服务源码与运行实例

| 组件 | 路径 | 大小 | SHA-256 | 状态 |
|---|---|---:|---|---|
| gateway | `<WORKSPACE>\competition\cloud\onenet\gateway.js` | 46,156 B | `64790E7C11DEDCA65EB072FC6FD888F66E3B0F6D1F2E1EB5E83F9AA4A02BC990` | **已部署到本机 public-sync** |
| Broker | `<WORKSPACE>\competition\bridge\mqtt_broker.js` | 5,999 B | `0C9B2C1E19FAC585DE9DAB3175240811B24455549EE7B310CC6A5F3AF0D06624` | 运行中，PID 6540 / 1883 |
| Bridge | `<WORKSPACE>\competition\bridge\mqtt_bridge.js` | 27,739 B | `C2D2CE1F2E96C7B3436482060AC769882CAC243289F0A44AAC7A2990EB651EBA` | 运行中，PID 13508 / 9101 |
| HDC fport | `tcp:9001 → tcp:9000` | — | — | **Forward 存在** |

public-sync：launcher `32584` + child `30216`，lock `32584`；单逻辑实例。  
未部署公网 backend；当前 backend 未改动。

### 1.4 板端 homemon

| 项目 | 绝对路径/设备路径 | 大小 | SHA-256 | 状态 |
|---|---|---:|---|---|
| 当前板端运行程序 | `/data/homemon/homemon`（DAYU200） | 164,276 B | `0D243539403DE89C547DEFACF43C86A4980142EF8EC686B277BE7133C42881E6` | **已部署的旧程序**；无 `climate.valid` |
| 板端配置 | `/data/homemon/homemon.conf` | 303 B | `8871C6326F859C6355180DE2C6E2665247235289F02628DDEA89DE0431E3DFE4` | 运行配置；内容不展示 |
| 新 homemon 候选 | `<WORKSPACE>\competition\evidence\2026-10-23-homemon-valid-baseline\out-candidate\homemon-arm` | 173,604 B | `06ECFBC6BE6A5A879DEAC5E3BE69BF7D6B5B9A221A0A44327F49A7FA982C2EEF` | **仅候选，未部署**；部署 BLOCKED（板端/源码构建来源未核清） |

客厅 `climate.valid` 仍缺失，当前显示“待确认”；建议后续独立维护，不在本轮替换板端程序。

## 2. 设备/能力基线

```text
dayu200-living / 客厅：主控、摄像头；climate 旧合同无 valid
esp32-kitchen / 厨房：AHT20 温湿度；MQ-2/MQ-5 原始 ADC；报警禁用/未标定；无 PIR/门磁/SOS/摄像头/水漏
esp32-bath / 卫生间：AHT20 温湿度；PIR；SOS；蜂鸣器；MQ/水漏禁用；无门磁/摄像头
```

## 3. 最终验收矩阵

### 3.1 本轮真实通过（REAL）

| 项目 | 结果/证据 |
|---|---|
| 三节点自然在线 | DAYU 3/3；手机 3/5；dayu/kitchen/bath 均有新 202 |
| 厨房 `climate.valid=true` 到手机 | 手机显示“读数有效”、24.6℃/50%RH |
| 卫生间 `climate.valid=true` 到手机 | 手机显示“读数有效”、25.1℃/49%RH |
| 厨房 MQ 读取有效但不报报警 | 原始 ADC + “报警未启用”；未把 ADC 写成 ppm/安全 |
| 卫生间无 MQ | 无燃气/烟雾监测卡片 |
| 客厅缺 valid | 继续“待确认/无有效值”，未猜测有效 |
| 手机候选 HAP 安装 | 当前为 `8A722…`（摘要内联，真实 PASS），目标 5555，保留数据/会话；回退 `8F8925…` |
| gateway 本机部署/单实例 | 32584+30216，lock 32584；新 202 持续 |
| DAYU 展示 | 3/3；房间标题/能力正确；摄像头运行 |
| 手机首页/监测统计 | 首页 3/5、监测 3/5；0 异常、20 待确认、10 今日告警 |
| 手机模拟器真实业务自动离线/恢复 | 8A722：3/5→2/5→自动 3/5，同一 APP 进程；bath 24.2/51；首页/切页/手动刷新一致 |

### 3.2 历史真实通过（HISTORICAL，本轮未重测）

- 卫生间实体 SOS → APP 提交 → 设备 ACKED（见历史证据；本轮未触发）。
- 卫生间 Wi-Fi 恢复；COM5 最终固件/配置已验证。
- DAYU 房间标题/能力/摄像头切回；厨房 MQ 展示；手机 3/5 统计。
- 历史证据保留，不整批改写为最新结论。

### 3.3 本地测试/构建通过（LOCAL TEST / BUILD）

- `cloud/onenet`：153/153 PASS，adapter valid 专项通过；gateway 49/49 含 true→false→缺失→true。
- backend：215/215 PASS；实际存储往返保留 climate/gas/smoke valid。
- 手机 `ValidContract.test.ets` 行为测试通过（`hvigorw test` exit 0，覆盖 valid/零值/无效/缺失/离线）。
- 手机候选 HAP `assembleHap` 33 tasks BUILD SUCCESSFUL；当前最终候选 `8A722…`，真实自动恢复 PASS。
- homemon 源码合同主机测试 + ARM32 候选构建通过；**未部署**，不写成真机修复。

### 3.4 未测试 / 未部署

- 真实传感器失败/恢复（`valid=false`）未在真机拔线验证；只用本地行为测试，标 SIMULATED/LOCAL TEST。
- SOS/ACK/PIR/蜂鸣器/燃气实体告警本轮未重复触发；历史 ACK 不算本轮。
- 公网 backend 未部署；本轮无需改动，不能写成“后端已部署”。
- 新 homemon 候选未部署；板端旧程序未替换。
- 客厅 climate.valid 未真机修复，仍“待确认”。
- 实体手机兼容性/系统适配：**NOT TESTED**；当前通过的是 HarmonyOS 手机模拟器 APP 接入真实后端/实体节点的端到端验收。
- DAYU 摄像头切换、SOS/ACK 实体闭环：引用历史证据，本轮未重测。
- 卫生间 Wi-Fi 不同位置/线缆/供电的单变量物理根因：**未隔离**，不宣称已确定。

### 3.5 当前禁用/未开放

- 厨房 MQ 报警功能禁用（仅原始 ADC）；未标定。
- 卫生间 MQ/水漏禁用；无燃气/烟雾卡片。
- 厨房/卫生间摄像头未配置。
- 手机“一键呼叫/视频探望/发送消息”仍按现有 UI 为未开放；不属于本轮验收范围。
- 未打开/未烧录 COM14；未触发 reset。

## 4. 当前服务（2026-10-23 01:03 只读检查；PID 仅历史参考）

```text
Broker 6540 / 1883
Bridge 13508 / 9101
public-sync 32584 + 30216（lock 32584，一个逻辑实例）
HDC fport tcp:9001 -> tcp:9000
DAYU homemon 2442 / 9000（原版 0D2435…）
手机模拟器 127.0.0.1:5555
```

最新自然 202（2026-10-23 01:03 CST / 17:03Z）：

```text
dayu200-living  17:03:33Z
esp32-kitchen   17:03:09Z
esp32-bath      17:03:18Z
```

PID 会随重启变化；不要以本节的数字作为长期存活证明，以现场只读检查为准。

## 5. 归档/回退边界

- 回退 HAP：上一版 `guardian-valid-candidate.hap`（`86805D…`）；原始 `guardian-baseline.hap`（`94F90E21…CBFD`）。
- 回退源码：`competition/evidence/2026-10-23-valid-contract-local/source-original/`；其中 gateway/ViewMapper 为**按本轮反向补丁重建**，不是现场原件，差异仅撤销本次 valid 旁路保留。
- 回退板端：`homemon.board-pre`（旧程序）与 `homemon.conf.board-pre`；未执行替换。
- 本清单不包含 Wi-Fi 密码、Token、签名秘密或配置内容；固件二进制不复制到文档。
- 8A722 最终源码快照与哈希：`evidence/2026-10-23-final-freeze-8a722/`；正式冻结记录见 [8A722 最终版本冻结](2026-10-23-final-freeze-8a722.md)。
