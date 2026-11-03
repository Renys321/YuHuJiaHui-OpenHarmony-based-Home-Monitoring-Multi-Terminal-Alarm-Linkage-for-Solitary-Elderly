# 厨房 / 卫生间 ESP32：USB 用途核实 + Wi-Fi 上报链路验收证据

- 任务：核实两块 ESP32 的 USB 用途与 Wi‑Fi 上报路径，确认状态能经现有 Wi‑Fi 送达 PC 上的 bridge/broker，并准备「拔 USB 数据线」验收所需的身份与回滚证据。
- 执行人：Teammate `esp32-net`（Lead 协调）。时间窗：2026‑10‑27 22:20–22:40（+08:00）。
- 边界：**未烧录、未改固件、未改接线、未重启 broker/bridge**；串口只读采集（打开时置 DTR/RTS=false，未触发复位）；22:33 起按 Lead 指令**冻结一切串口主动操作**，仅保留 MQTT 只读订阅。

---

## 0. 结论摘要（TL;DR）

1. **厨房/卫生间经 Wi‑Fi 上报到 PC 的链路是通的，且是真实到达 broker 的数据**。
   - PC 10.127.130.179 上的 bridge `:9101` 有两条 **Wi‑Fi 入站 TCP**：`10.127.130.168` = **esp32‑kitchen**、`10.127.130.71` = **esp32‑bath**（启动日志 + 烧录记录 + bridge 日志三方互证）。
   - **决定性证据**：同一时刻，两板串口自报 JSON 的 `ts` 与 broker 上 MQTT 报文的 `ts` **逐毫秒完全一致**（§3 表，6/6 对齐，到达延迟 −76…+67 ms）。
2. **USB 仅承担「供电 + 串口调试日志」，不承载任何上报数据**。
   - 数据走 Wi‑Fi：设备 `connect(10.127.130.179:9101)` → bridge 按报文 `deviceId` 发布 `home/<deviceId>/status` → 本机 broker `:1883`。
   - 串口里反复出现的 `→ {...}` 只是日志副本；本次以「串口 ts == MQTT ts」而非“串口能看到 JSON”来判定通过。
3. **「拔 USB 数据线」状态在当前现场已经呈现，且两板仍在上报**（22:37:39 起复核）：
   - `COM4/COM5` 已从系统消失，`Win32_PnPEntity` 查不到任何 CH340/USB‑SERIAL，打开端口报“端口不存在”；
   - 同时 bridge 入站 TCP 仍在，两板状态持续到达 broker，`tsAge` 仅 −76…+11 ms（§5）。
4. 之前 brief 里“厨房/卫生间尚未到达 broker”是**过期观察**：旧 bridge（PID 27460）日志在 22:19:39/40 已打印两板 Wi‑Fi 入站与 `home/esp32-*/status` 发布；22:25 与 22:31 的两次采集也都真实到达。
5. 本次唯一基础设施事件是 **broker 崩溃**（22:26:16，`mqtt_broker.js:62` `readUInt16BE` 越界，收到畸形/截断 CONNECT），由 Lead 修复并重启；bridge 亦由 Lead 重启为 `--status-tcp 10.127.130.131:9000`（DAYU 改走 Wi‑Fi）。**未发现需要改固件才能连上的问题——不需要烧录任何板子。**

---

## 1. 环境与链路拓扑（2026‑10‑27 22:20–22:40）

| 项 | 值 |
|---|---|
| PC WLAN | `10.127.130.179/24`，SSID `ElderCareLab`（2.4 GHz WPA2，手机热点，AP MAC/BSSID `5a:fe:a0:a6:a3:d7`，默认网关 `10.127.130.217`） |
| 设备→PC 通道 | ESP32 STA 直连热点，TCP 到 `10.127.130.179:9101`（bridge 的 `--listen` 入站口，Wi‑Fi 数据**不经 USB**） |
| bridge | `mqtt_bridge.js --broker 127.0.0.1:1883 --listen 9101`（22:25:23 起为 Lead 重启版 PID 61072，`--status-tcp/--relay-to 10.127.130.131:9000`） |
| broker | `mqtt_broker.js 1883`（Lead 修复重启版 PID 27820，22:29:42） |
| 上行主题 | `home/esp32-kitchen/status`、`home/esp32-bath/status`（另有 `home/dayu200-living/status`） |
| 设备固件 | `esp32_elder_node`，App version 1，ESP‑IDF v5.1.6‑dirty，ESP32‑S3 (QFN56) v0.2 |
| USB | 两板各一根 CH340 USB 线：`COM5`(kitchen) / `COM4`(bath)，115200 8N1，VID:PID = `1A86:7523` |

```
esp32-kitchen (10.127.130.168) ──Wi-Fi TCP──┐
                                           ├─ bridge :9101 ── MQTT ── broker :1883 ── home/<id>/status
esp32-bath    (10.127.130.71)  ──Wi-Fi TCP──┘
        │                                          ▲
        └── USB(COM4/COM5) 仅 5V 供电 + 串口日志 ───┘（日志不是数据通道）
```

---

## 2. 逐板：USB 用途与身份（含“拔 USB 是否断电”）

| 项 | esp32-kitchen | esp32-bath |
|---|---|---|
| PC USB 串口（USB 在时） | **COM5** | **COM4** |
| USB 设备 | `USB-SERIAL CH340`，`VID_1A86/PID_7523`，serial `7&25042A44&0&1`，`Port_#0001.Hub_#0004` | 同型号，serial `7&25042A44&0&2`，`Port_#0002.Hub_#0004` |
| USB 用途判定 | **仅供电 + 调试串口日志**（115200 输出 `elder-node` 日志与 `→ {...}` 日志副本） | 同左 |
| 数据通道 | Wi‑Fi STA → PC `10.127.130.179:9101`（与 USB 无关） | 同左 |
| deviceId / room | `esp32-kitchen` / 厨房 | `esp32-bath` / 卫生间 |
| MAC | `50:78:7d:16:ed:60` | `14:c1:9f:42:dd:b4` |
| Wi‑Fi IP（DHCP） | `10.127.130.168/24` | `10.127.130.71/24` |
| 网关 | `10.127.130.217`（通过热点上网） | 同左 |
| 固件版本字符串 | `ESP32-S3 无线节点启动：esp32-kitchen / 厨房`；`Project name: esp32_elder_node`；`App version: 1`；`ESP-IDF: v5.1.6-dirty`；`ESP32-S3 (QFN56) rev v0.2` | `ESP32-S3 无线节点启动：esp32-bath / 卫生间`；其余同左 |
| 拔 USB 后是否断电 | **若直接拔掉且无替代电源 → 断电**（此前 USB 是唯一供电来源，故必须先接独立 5V，见 §5.1）。**当前现场已改为独立供电**：22:36 前后设备重启（bath `countToday` 116→0，TCP 于 22:36:45/47 重建），随后 COM4/COM5 消失但设备仍在线 | 同左 |

**身份互证来源（只读）**
- 串口实时：`logs/serial-COM5-20261027-222508.log`、`logs/serial-COM4-20261027-222536.log`（`deviceId`/`room`/`ts` 自报；打开串口未复位，uptime 1242725 ms / 1472623 ms）。
- 启动日志（Wi‑Fi IP / 版本）：`competition/evidence/2026-10-27-door-v7-e2e/acceptance/kitchen-v7-boot-20261027.log`（`已获取 IP: 10.127.130.168`）、`bath-v7-boot-20261027.log`（`10.127.130.71`）。
- 烧录记录（MAC）：`.../acceptance/flash-kitchen-v7-COM5.json`、`flash-bath-v7-COM4.json`。
- bridge 侧：旧 bridge 日志 `bridge.out.log` 中 `.168` 接入后立即发布 kitchen、`.71` 接入后立即发布 bath；当前 `bridge-wifi.log:16,20` 同样对应。
- 详细见 `identity-build-20261027.txt`、`logs/usb-identity-20261027.txt`。

---

## 3. 决定性证据：串口 `ts` == broker `ts`（同刻三路同步采集）

采集窗口（三路并发，只读）：**2026‑10‑27 14:31:28–14:31:51 UTC**（本地 22:31:28–22:31:51），bridge=新桥 PID 61072、broker=PID 27820。
文件：`logs/serial-COM5-sync-20261027-223128.log`、`logs/serial-COM4-sync-20261027-223128.log`、`logs/mqtt-live2-20261027-223128.log`。

| # | 设备 | 串口打印时间 (UTC) | 串口 JSON `ts` | MQTT 收到时间 (UTC) | MQTT `ts` | 到达延迟 |
|---|---|---|---|---|---|---|
| 1 | esp32-kitchen | 14:31:31.040 | 1793111491100 | 14:31:31.071 | 1793111491100 | +31 ms |
| 2 | esp32-bath | 14:31:31.429 | 1793111491470 | 14:31:31.496 | 1793111491470 | +67 ms |
| 3 | esp32-kitchen | 14:31:36.531 | 1793111496600 | 14:31:36.576 | 1793111496600 | +45 ms |
| 4 | esp32-bath | 14:31:36.921 | 1793111496970 | 14:31:36.980 | 1793111496970 | +59 ms |
| 5 | esp32-kitchen | 14:31:42.021 | 1793111502090 | 14:31:42.072 | 1793111502090 | +51 ms |
| 6 | esp32-bath | 14:31:42.411 | 1793111502460 | 14:31:42.379 | 1793111502460 | −32 ms |

> 说明：串口行时间是 PC 读到该行的时间，MQTT 收报是 broker 转发到订阅端的时间，两者存在毫秒级抖动（−76…+67 ms 区间）；关键是 **`ts` 数值逐位相同**，即“固件生成的那一份 JSON 原样到达 broker”，排除了“只是串口在打印、数据并未出网”的可能。

补充（旧 runtime，22:25 首轮，bridge PID 27460 / broker PID 29368）：
- `logs/mqtt-live-20261027-222508.log`：kitchen `ts=1793111123110`、`ts=1793111128600`；与 `logs/serial-COM5-20261027-222508.log` 的 22:25:23.110 / 22:25:28.600 完全一致。
- 该轮 MQTT 在 22:25:34 收到 `ECONNRESET` 后 `ECONNREFUSED`，即 §4 的 broker 崩溃，属基础设施事件，与设备侧无关。

**同期 Wi‑Fi 入站连接证据**
- 旧 bridge（PID 27460）：`10.127.130.168:59262`、`10.127.130.71:63489`，`CreationTime 22:19:39/22:19:40`；日志 `bridge.out.log` 出现 `无线节点接入 ::ffff:10.127.130.168` → `home/esp32-kitchen/status`、`.71` → `home/esp32-bath/status`。
- 新 bridge（PID 61072）：`10.127.130.168:59263`、`10.127.130.71:63490`（22:25:24）→ 22:36:45/47 自动重连为 `:64774`/`:62213`，至今 Established。
- 环境快照：`logs/env-snapshot-20261027-2238.txt`；bridge 摘录：`logs/bridge-wifi-excerpt-20261027.log`。

---

## 4. 诊断过程与关键发现

1. **“未到达 broker”是过期结论**。22:20 实测：bridge `:9101` 已有两条 Wi‑Fi 入站连接，且日志在持续发布 `home/esp32-kitchen/status` / `home/esp32-bath/status`。原因应是 brief 形成于 22:19 设备重新连上之前。
2. **串口日志 ≠ 数据到达**。本次坚持用「串口 ts == broker ts」判定；6/6 对齐即证明数据确实出网到达 PC。
3. **设备侧无需任何修复**：固件 `gateway_task` 在 `send()` 失败时关闭 socket 并在 1 s 后重连（`node_main.c:1289-1306`），Wi‑Fi 断开事件也会触发重连（`node_main.c:390`），因此观察到的周期性 TCP 重建（22:19 → 22:25 → 22:36）是正常的自愈行为，期间状态不丢（断线重发同一快照）。
4. **broker 崩溃（基础设施，非设备问题）**：22:26:16 `broker.err.log`：
   `RangeError: The value of "offset" is out of range ... at mqtt_broker.js:62`——收到畸形/截断 CONNECT 后 `readUInt16BE(off)` 越界。Lead 已加边界检查并验证畸形包不再崩溃（新 `broker-wifi.err.log` 仅有 `CONNECT 拒绝 code=INVALID_VARIABLE_HEADER`，无退出）；bridge 已重启为 DAYU 走 Wi‑Fi 的新参数。**按边界本人未重启任何服务。**
5. **附带发现**：有进程持续以每秒级频率对 `127.0.0.1:9101` 发起短连接（bridge 日志大量 `无线节点接入 ::ffff:127.0.0.1:xxxxx` 后立即断开）。若非团队探活脚本，建议排查；这类畸形探包也可能正是打崩 broker 的输入之一。
6. **未执行**：未改固件、未烧录、未拔任何线、未改接线、未 restart broker/bridge、未碰 DAYU / SOS / M100 / APP / 后端。

---

## 5. 「拔 USB 数据线」验收

### 5.1 现场当前状态（22:37:39 起复核，只读）

| 检查项 | 结果 | 证据 |
|---|---|---|
| `SerialPort.GetPortNames()` | 仅 `COM11/COM19/COM20`（**无 COM4/COM5**） | `logs/env-snapshot-20261027-2238.txt` |
| `Win32_PnPEntity` CH340/USB‑SERIAL | **NONE**（设备节点已随 USB 拔出消失） | 同上 |
| 打开 COM4 / COM5 | `端口"COM4"/"COM5"不存在` | `logs/usb-identity-20261027.txt` |
| bridge 入站 TCP | `10.127.130.71:64774`(bath)、`10.127.130.168:62213`(kitchen) 仍 Established | 同上 |
| broker 收到新状态 | kitchen `ts=1793111896520`(22:38:16.520)、bath `ts=1793111900197`(22:38:20.197)、bath `ts=1793111911167`(22:38:31.167) | `logs/mqtt-nousb-20261027-223814.log` |
| 新鲜度 | `tsAge` = −76…+11 ms（远小于上报周期 ~5 s） | 同上 |
| 旁证 | bath `countToday` 由 116 归零后重新累计到 3→8，说明 ~22:36 切换供电时重启过，之后连续上报无缺口 | 同上 |

> **即：截至本报告，USB 数据线已不在，两板仍由独立供电运行并经 Wi‑Fi 把状态送到 PC broker —— 这正是验收通过形态。** 我未操作拔线，该状态由现场（Lead/用户）造成；我仅在 22:37 之后做了只读复核。

### 5.2 独立供电方案（三选一，按可行性排序）

1. **USB 充电头/充电宝 + 普通 USB 线**（最稳、零改线）：把原来的 USB 线改插到 5V 充电头或充电宝。充电头无 USB 主机，设备只有 5V、不会出现 COM 口——等价于“拔掉数据线、保留供电”。
2. **USB 数据阻断器（data blocker / 只供电转接头）**：保留原线插 PC，中间串一个只通 5V/GND 的转接头，同样达到“无数据、有电”。
3. **5V 排针供电**（若板上有 5V/GND 排针，需万用表确认丝印与极性）：外部 5V→板 5V，GND→GND；**切勿反接/接 3.3V 排针当输入**。历史证据 `KITCHEN-PIR-PLAN.md` 记录“板上是否有 5V 排针 = 待用户确认”，故此项需现场目视/测量后使用。

> 不要在“仅 USB 供电”状态下直接拔线：两板会掉电（§2 已验证），数据同时中断，不构成有效验收。

### 5.3 验收步骤（供 Lead/用户执行，我提供判据）

1. 先接好独立供电（若用方案 1/2，可热切换：插充电头 → 拔 PC 端 USB 数据线）。
2. **断言 A（无 USB 数据）**：PC 上 `Get-PnpDevice` 无 CH340、`[System.IO.Ports.SerialPort]::GetPortNames()` 无 COM4/COM5；打开报“不存在”。
3. **断言 B（设备仍在线）**：PC `Get-NetTCPConnection -LocalPort 9101 -State Established` 仍有 `10.127.130.168` 与 `10.127.130.71` 两条。
4. **断言 C（数据真实到达）**：只读订阅 `home/+/status`，`home/esp32-kitchen/status` 与 `home/esp32-bath/status` 持续出现，`ts` 递增且 `now-ts < 5 s`；厨房/卫生间状态变化（如开门、PIR 触发）能在 ~1 s 内反映到 broker。
5. **断言 D（无回灌/无假数据）**：报文 `deviceId` 与 room 正确（`esp32-kitchen/厨房`、`esp32-bath/卫生间`），`sensors` 与现场一致（如 kitchen 门磁 open、bath PIR 计数变化）。
6. 记录：连续 ≥60 s 采样，保存 MQTT 原始日志 + 端口/PnP 快照 + bridge 日志摘录。

### 5.4 恢复步骤（回滚到插 USB）

1. 插回原 USB 数据线（可先插 PC 端再断电切回，避免带载热插拔争议）；
2. 确认 `COM4`(bath)/`COM5`(kitchen) 重新出现（同一 USB 端口层级 `Hub_#0004 Port_#0001/0002`，若换了口序号可能变，以 CH340 serial `7&25042A44&0&1/&0&2` 识别）；
3. 只读串口确认 `elder-node` 日志恢复、`已获取 IP` 与之前一致（DHCP 可能变化，属正常）；**不需要重烧固件**。

---

## 6. 回滚证据（只读核对，本次未烧录）

| 项 | esp32-kitchen | esp32-bath |
|---|---|---|
| 最近烧录 | 2026‑10‑27T02:02:34.669+08:00，COM5，app‑only @0x10000 | 2026‑10‑27T02:01:02.522+08:00，COM4，app‑only @0x10000 |
| 烧录记录 | `evidence/2026-10-27-door-v7-e2e/acceptance/flash-kitchen-v7-COM5.json` | `.../flash-bath-v7-COM4.json` |
| 在板固件 bin | `evidence/2026-10-27-door-v7-e2e/firmware/kitchen-v7-esp32_elder_node.bin`，1,022,480 B，SHA‑256 `0AA8144D87D76DF3E946FA81A493E67C050CEC8C86DAFC4AA1D8C3A3170E179B` | `.../bath-v7-esp32_elder_node.bin`，1,011,648 B，SHA‑256 `56D9A8054EC6B1AA0FB19E5390D6744E55FD2B572DE722742A799F5C3A8CAA6B` |
| 构建来源 | `.local/door-v7-20261027/build-kitchen/esp32_elder_node.bin`，**SHA‑256 与归档 bin 实算一致** | `.../build-bath/esp32_elder_node.bin`，**一致** |
| bootloader/分区表 | 归档同目录 `kitchen-v7-bootloader.bin` / `kitchen-v7-partition-table.bin`（本次烧录未改动） | `bath-v7-*`（同上） |

- **回滚动作**：把上述 app bin 写回 `0x10000` 即可（app‑partition‑only），不改 bootloader/分区表/NVS。
- **风险**：① 仅回滚 app 不清 NVS 运行态（门磁 seq、累计计数按固件逻辑重算，不影响功能）；② 若历史上动过 bootloader/分区表则需整片重烧——本次记录显示最近一次为 app‑only，风险低；③ 重烧需要重新打开 COM 口并占用 USB，**与本轮“无 USB”验收互斥，只能在验收结束后做**。
- 本次会话**未执行任何烧录/擦除/写 NVS**。

---

## 7. 边界与未做事项

- 未烧录、未改固件源码/配置、未改接线、未拔任何线（USB 数据线由现场处理）、未重启 broker/bridge、未碰 DAYU/APP/后端/relay/public-sync/SOS/M100。
- 串口仅为只读采集；打开时主动置 `DTR=false, RTS=false`，实测未触发复位（uptime 连续）。22:33 后按 Lead 指令冻结串口，不再打开。
- 未写任何 Wi‑Fi 密码/Token；本报告与日志均不含密码。
- 未复核项：板子是否另有 DC 座/5V 排针（需现场目视），本文只给出可选方案与风险。

---

## 8. 证据文件清单（`competition/evidence/2026-10-27-wireless-without-usb/esp32-net/`）

| 文件 | 时间戳（本地） | 内容 |
|---|---|---|
| `REPORT.md` | 2026‑10‑27 22:40 | 本报告 |
| `identity-build-20261027.txt` | 22:39 | 身份/构建来源/回滚 bin |
| `logs/serial-COM5-20261027-222508.log` | 22:25:08–22:25:28 | kitchen 串口只读（身份 + JSON 日志） |
| `logs/serial-COM4-20261027-222536.log` | 22:25:36–22:25:56 | bath 串口只读 |
| `logs/mqtt-live-20261027-222508.log` | 22:25:08–22:26:18 | 旧 broker MQTT 只读（含 kitchen ts 逐毫秒对齐） |
| `logs/serial-COM5-sync-20261027-223128.log` | 22:31:28–22:31:51 | kitchen 串口（同步采集） |
| `logs/serial-COM4-sync-20261027-223128.log` | 22:31:28–22:31:51 | bath 串口（同步采集） |
| `logs/mqtt-live2-20261027-223128.log` | 22:31:28–22:32:19 | 新桥/新 broker MQTT 只读（6 组 ts 对齐） |
| `logs/mqtt-final-20261027-223725.log` | 22:37:25–22:37:38 | 无 USB 状态下的 MQTT 快照 |
| `logs/mqtt-nousb-20261027-223814.log` | 22:38:14–22:38:39 | **无 USB 状态持续上报证据** |
| `logs/env-snapshot-20261027-2238.txt` | 22:37:39 | 端口/PnP/进程/连接快照 |
| `logs/usb-identity-20261027.txt` | 22:38 | CH340 身份 + 拔线后端口消失对照 |
| `logs/bridge-wifi-excerpt-20261027.log` | 22:40 生成 | 当前 bridge 日志中 Wi‑Fi 入站与 status 发布摘录 |
| `tools/mqtt-capture.js` | 22:24 | 只读 MQTT 采集脚本（可复跑） |
| `tools/serial-capture.js` | 22:25 | 只读串口采集脚本（DTR/RTS=false） |
