# 厨房/卫生间两板语音+LED 恢复、厨房 PIR 加装、现存告警与门磁保护 — 交付报告

- 日期：2026-10-27（Asia/Shanghai）
- 工作区：`<WORKSPACE>`；证据目录：`competition/evidence/2026-10-27-voice-led-restore/`
- 边界：只写两块固定板的 **app 分区**；未改 bridge/broker/public-sync、未改 APP、未部署后端/门磁 schema v7、未触发 COM8、未由代理制造 SOS。

## 0. 结论速览

| 项 | 结果 |
|---|---|
| 厨房中文语音 | ✅ **正常**（本次未改语音逻辑；KEY0 实测 `local-voice: PLAY clip=1 bytes=27791 … cancelled=0`，用户确认听到） |
| 厨房 LED | ✅ **正常**（`local-led: LED 模式=SOS_TRIPLE` 三短闪；ACK 后 `ACKED_RESOLVED_OFF`；用户确认看到） |
| 厨房 PIR | ✅ **已加装并工作**（SR312/3.3V/GPIO38：`检测到活动（今日第 1 次）`、`motion.countToday/lastActiveTs` 上报 202） |
| 厨房无活动告警 | ⚠️ **已配置启用**（30 分钟 + 需先武装）；**未现场等待 30 分钟自然触发，不写成已通过** |
| 卫生间中文语音 | ✅ **已恢复**（三合一+兼容镜像；两次按键 `PLAY clip=1 … cancelled=0`，用户确认听到） |
| 卫生间 LED | ✅ **已恢复**（`SOS_TRIPLE` 三短闪，ACK 后 `ACKED_RESOLVED_OFF`，用户确认看到） |
| 卫生间门磁本地 | ✅ **保留**（GPIO14、去抖 2、NVS seq 恢复、开合事件 seq 20/21、状态 `door:{open,lastOpenTs}`） |
| 卫生间门磁公网 | ⏳ **仍待 schema v7**：当前只上报旧合同 `open/lastOpenTs`（202 正常）；`seq/events/lastCloseTs` 等 v7 字段未下发 |
| 卫生间上报 `INVALID_STATUS` | ✅ **已消除**（REJECT 最后 01:03:42；01:04:47 起 `cloud-sync OK … status=202` 持续） |
| 现存告警保护 | ✅ 已核对并记录（详见 §1）；无代理创建的告警 |

## 1. 现存告警保护（烧录前核对）

只读核对（bridge `status.json` + PC 侧 public-sync 日志 + 云端只读 dump）后确认：

| 告警 | 状态 | 处置 |
|---|---|---|
| `e-1793032029-1`（厨房 00:27:09，用户按键） | ACKED | 用户 APP 确认 |
| `e-1793032428-2`（厨房 00:33:48，用户按键） | **ALARM（陈旧）** | 用户 00:47 复位厨房板前未 ACK；复位后设备无该告警状态，**已无法完成设备回执**。用户确认接受记录为“复位导致无法设备回执的陈旧告警”，未伪造闭环 |
| `e-uf849b8b9-1`（厨房 00:47:53，用户复位后立即按键） | ACKED | 用户 APP 确认 |
| `e-1793034445-1`（卫生间 01:07:25，用户按键） | ACKED | 用户 APP 确认 |
| `e-1793034481-2`（卫生间 01:08:02，用户按键） | ACKED | 用户 APP 确认 |
| `e-1793034982-1`（厨房 01:16:22，用户按键） | ACKED | 用户 APP 确认（`ACK_SENT id=23 → ACKED`） |

- 保护规则执行：确认告警已妥善处理（或用户明确接受陈旧状态）**之前**，未重启/重刷/复位任何板；确认后才开始写板。
- 更早的 3 条历史 `ALARM`（`e-1793022345-1`、`e-ue0f6b3b8-1`、`e-1793015331-3`）为本任务前遗留，与本任务无关，未处理。

## 2. 厨房板（COM5）

| 项 | 值 |
|---|---|
| 身份 | ESP32-S3 v0.2；MAC **50:78:7d:16:ed:60**；`esp32-kitchen` / 厨房 |
| 写前固件 | 定向播报候选 `43C1183A…F8443DD`（1,019,728 B，用户确认语音/LED 正常） |
| 写前备份 | `COM5-app-before-pir-20261027.bin`，1,048,576 B，整段 `0F1D752D…B5EB`；**前缀哈希 = `43C1183A…`**（与在板逐位一致） |
| 新固件 | **`F67AC3CE…A670F0`**，1,020,192 B（余 28,384 B / 2.7%） |
| 唯一改动 | 配置层 `CONFIG_NODE_MOTION_GPIO=38` + 去抖 2（源码未改，新增 overlay defaults） |
| 写入 | 只写 `0x10000`，`Hash of data verified`；`fullErase=false`；未改 NVS/Wi-Fi/分区表/接线 |
| 启动 | 无 boot 蜂鸣/语音、功放待机静音、LED 启动不闪、已连接网关、202 正常 |
| 实机验收 | KEY0：3 声提示音 → 中文语音完整播放 → SOS 三短闪 → 用户 APP ACK → LED 熄灭；PIR：`检测到活动（今日第 1 次）` |
| 公网 | `motion` 走既有字段，`status=202`；无需 v7 |

细节：[KITCHEN-PIR-FLASH-RECORD.md](./KITCHEN-PIR-FLASH-RECORD.md)、[KITCHEN-PIR-PLAN.md](./KITCHEN-PIR-PLAN.md)、审计 [audit/kitchen-audit.md](./audit/kitchen-audit.md)。

## 3. 卫生间板（COM4）

| 项 | 值 |
|---|---|
| 身份 | ESP32-S3 v0.2；MAC **14:c1:9f:42:dd:b4**；`esp32-bath` / 卫生间 |
| 写前固件 | 门磁候选 `16B63A31…17C1`（783,056 B，无语音/LED，上报被拒） |
| 写前备份 | `COM4-app-before-compat-20261027.bin`，1,048,576 B，整段 `4712A702…27D58`；**前缀哈希 = `16B63A31…`**（与在板逐位一致） |
| 新固件 | **`F56A5A64…258BEFC`**，1,011,312 B |
| 基线 | 三合一候选 `42F24D5F…93715`（门磁 GPIO14 + 6 clips 语音 + GPIO1 低有效 LED） |
| 唯一改动 | `report()` 门磁段：v7 前只发旧合同 `{open,lastOpenTs}`；扩展字段仅本地；基线未知时整段不发（不谎报关闭） |
| 写入 | 只写 `0x10000`，`Hash of data verified`；`fullErase=false` |
| 启动 | 无 boot 蜂鸣/语音、功放待机静音、LED 启动不闪、门磁 GPIO14 就绪、seq 从 NVS 恢复 10、已连接网关 |
| 实机验收 | 两次按键：3 声提示音 → 中文语音完整播放（`cancelled=0`）→ SOS 三短闪 → ACK 熄灭；开门/关门 `seq=20/21` 正常 |
| 上报 | REJECT 停止；`cloud-sync OK device=esp32-bath status=202` 持续（含门磁开合期间） |
| 门磁公网 | ⏳ 仍待 v7（见 §4） |

细节：[BATH-FLASH-RECORD.md](./BATH-FLASH-RECORD.md)、[BATH-LIVE-VERIFY.md](./BATH-LIVE-VERIFY.md)、审计 [audit/bath-audit.md](./audit/bath-audit.md)。

## 4. 门磁兼容方案与 v7 边界

- 根因（审计实算）：PC 侧 public-sync 的 `cloud/onenet/adapter.js:145-158 normalizeDoor()` 用 `requireExactKeys(door, ['open','lastOpenTs'])`（L153）严格白名单；
  三合一候选上报 `lastCloseTs/seq/events`（基线未知时 `open:null`）→ `gateway.js:325-334` 判 `INVALID_STATUS`。**非 bridge、非后端**。
- 处理：固件侧最小向后兼容——v7 前只发旧合同两键，本地门磁采集/去抖/NVS/FIFO 全部保留；未改共享 bridge/后端。
- **v7 上线顺序（待后续任务）**：①PC 侧 adapter 白名单扩容（允许 `lastCloseTs/seq/events` 与 `open:null`）→ ②后端 v7 部署 → ③固件改回扩展字段后重建/烧录。
- 因此：**“门磁本地功能保留”已通过；“门磁公网（扩展字段）仍待 schema v7”如实标注，不写成已完成。**

## 5. 未完成 / 限制（如实）

1. **厨房“长时间无活动”告警未现场自然验证**：配置为 1800s + 需先武装；本次未等待 30 分钟观察自然触发，仅确认配置生效。
2. **厨房 app 分区余量仅 28,384 B（2.7%）**：后续再加功能/语音素材可能超 1 MiB；升级前需评估。
3. **门磁公网扩展字段仍待 v7**（见 §4）。
4. **陈旧告警 `e-1793032428-2`**：因复位无法设备回执，云端会保持 ALARM；需产品侧到期标记或授权后端处置，超出本任务范围。
5. 卫生间三合一基线相对已验证正式版改动较大（node_main.c +457/−31），审计建议上板逐项验收 ACK/STOP/300s/语音/LED；本次已验证 ACK、语音、LED、上报，**300s 重复提醒与 STOP 未逐项单独观测**。

## 6. 证据索引

| 文件 | 内容 |
|---|---|
| `KITCHEN-PIR-PLAN.md` | PIR 选脚/接线/配置方案 |
| `KITCHEN-PIR-FLASH-RECORD.md` | 厨房身份/备份/镜像/写入/启动/KEY0/PIR 记录 |
| `BATH-FLASH-RECORD.md` | 卫生间身份/备份/镜像/写入/启动/上报恢复 |
| `BATH-LIVE-VERIFY.md` | 卫生间两次按键、门磁开合、ACK 串口实证 |
| `ALARM-PROTECTION-STATUS.md` | 现存告警只读核对与云端状态 |
| `run/flash-*.json` | 两次写入的 esptool 记录（含 MAC 复核、hash verified、分区范围） |
| `run/bath-boot-compat-20261027.log`、`run/kitchen-boot-pir38-20261027b.log` | 两板启动日志 |
| `run/bath-live-verify-20261027.log`、`run/kitchen-live-verify-20261027.log` | 实机按键/门磁串口采集 |
| `audit/kitchen-audit.md`、`audit/bath-audit.md` | 只读审计（镜像哈希、源码/配置证据、根因、STOP 条件） |
| `sha256sums.txt` | 本目录文件哈希 |

## 7. 安全声明

- 未读取/输出任何 Wi-Fi 口令、Token 或私钥；固件二进制与私密 defaults 只留在 `.local/`。
- 未重启/替换 bridge(9101)、broker(1883)、public-sync；未改 APP/后端/共享协议。
- 未触发 COM8；未由代理制造 SOS；文中的告警均为用户真实按键。
- 写板仅 app 分区（0x10000 起），未全片擦除、未改 NVS/Wi-Fi/deviceId/分区表/接线。
