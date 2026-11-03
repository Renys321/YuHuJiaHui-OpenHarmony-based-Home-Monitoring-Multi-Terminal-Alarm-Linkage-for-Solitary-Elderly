> ⚠️ **本文件已被 `../2026-10-26-wireless-sos-button-final/REPORT.md`（v4）取代，仅作历史留档。**
> v3 中已过时/不准确的结论（请勿再引用）：
> - 蜂鸣器 I/O 记为 **GPIO6** —— 实际该板 GPIO6 是 Flash 引脚，终版固件改为 **GPIO5（高电平响，off=0 静音）**，GPIO6 禁止复用。
> - “节点接入状态：WiFi 间歇性连接 / 公网链路未通” —— v4 已用串口 + `public-sync` 日志证明 `esp32-sos` 能取到真实 IP、连上真实网关，并被公网后端以 `status=202` 接收。
> - 早期版本的 `A stack overflow in task main` 已修复（当前固件 `D40990F7…920D19` 连续运行无 abort）。

# 独立无线随身求助按钮 — 交付报告（2026-10-26，阶段更新 v3）

**结论（如实标注，分开陈述）**
- **隔离验证：通过**（源码核查 + 最小实现补丁 + 全量构建 953/953 + ELF 符号验证 + 目标板身份确认 + 全片备份 + 两次成功烧录 + **本地桥接链路隔离验证通过**）。
- **真实使用验收：未完成**。节点 WiFi 被 AP 认证拒绝（reason=202，待路由器排查/换网）、公网链路待 INGEST_KEY、真实按压→APP→ACK→回执待用户配合。

---

## 1. 任务基线（已核对）

- 完整读取交接文档 `docs/evidence/2026-10-26-new-chat-handoff.md`（39,066 B，413 行），哈希核对通过：`EAF3F827586CFCF841C1AB595884C1E792770A8016DB20701F66204166B93955`（与配套 `.sha256.txt` 一致）。
- **并发会话保护**：`esp32-node\main\node_main.c` 18:17 被其他会话修改；`demo-autostart` 看护器运行中；`evidence\2026-10-26-local-alarm-voice-closure` 目录活跃。**本任务未修改公共源码、未触碰厨房/卫生间/DAYU 任何固件**，全部工作在外部副本 `D:\esp32-sos-build` 完成。
- 既有约束遵守：未购买硬件、未部署公网后端、未安装 APP、未做 D/E 发布，未占用两块固定传感板。

## 2. 硬件、设备身份与供电（真实状态，经实物识别确认）

| 对象 | 实测状态 |
|---|---|
| 卫生间 ESP32-S3 | COM4，MAC `14:c1:9f:42:dd:b4`，`esp32-bath`，有扬声器 —— **固定节点，不可占用** |
| 厨房 ESP32-S3 | COM5，MAC `50:78:7d:16:ed:60`，`esp32-kitchen`，有扬声器 —— **固定节点，不可占用** |
| **独立按钮主控板（新目标板）** | **COM8，已确认存在并完成实物识别**：ESP32-S3 (QFN56) rev v0.2 / WiFi+BLE / PSRAM 8MB / 40MHz / **Flash 16MB** / **MAC `30:30:f9:08:76:84`**（与 COM4/COM5 完全不同，非固定板；esptool chip_id 两次核对一致） |
| 实体求助按钮 | 用户持有；按 2 脚常开轻触按钮假设：一脚 GPIO4、一脚 GND（内部上拉、低电平按下） |
| 有源蜂鸣器 | **用户确认 3 针 VCC/GND/I/O**：I/O→GPIO6、VCC→3.3V、GND 共地（高电平鸣响） |
| 独立供电 | **未确认**（电池/移动电源）；无电量检测芯片，不显示/不伪造电量百分比 |
| 无线接入方式 | 复用现有链路：2.4GHz Wi-Fi → 本机 Bridge(TCP:9101) → MQTT Broker(:1883) → public-sync → 公网 backend；下行 ack 按 deviceId 路由回节点 |

## 3. 已实现（隔离验证通过）

### 3.1 公共源码已有能力（只读核查，`esp32-node\main\node_main.c` 18:17 版）
- 独立设备身份：`CONFIG_NODE_ID` / `CONFIG_NODE_ROOM` 可配置（目标 `esp32-sos` / `随身求助`）。
- 按键语义：`sos_update` 内部上拉、低电平按下、边沿触发、消抖确认 2 次；上电先见"松开"防误报；同一持续告警期重复按压抑制；ACK 后再次按压按新告警处理。
- 状态机：`NORMAL → ALARM → ACKED → reset → NORMAL`；ACK 回执：下行 `ack <alarmId> <说明>` 精确匹配才闭环，接受后立即静音；设备"收到监护人已确认"反馈 = 蜂鸣器停止。
- 上报 JSON 含 `deviceId/room/ts/state/alarm{id,type,countToday}`。

### 3.2 最小实现补丁（候选，位于外部副本 `D:\esp32-sos-build\main\node_main.c`，**未写入公共源码**）
针对独立按钮无 ES8388 音频芯片、必然以非语音固件运行的两个真实缺陷：

| # | 缺陷（原始非语音路径） | 补丁 |
|---|---|---|
| a | 主循环在 WiFi 未连接时 `continue`，断网时 SOS 按键不被轮询；上报直接 `send` 失败即丢 | 独立 `gateway_task`（WiFi/连接/RX/补发）+ 单槽上报队列无条件启用；主循环始终响应 SOS |
| b | 上报 `ts` 为发送时刻，重连后把旧求助伪装成新事件 | `s_sos_event_ts`：SOS 告警期 `ts` 固定为原始按压时刻 |
| c | 非语音固件网关命令在主循环上下文直接执行 | 命令统一经 `s_commands` 队列由主任务执行 |

### 3.3 目标板识别与全片备份（已完成）
- 身份核对（三次 esptool chip_id，均一致）：ESP32-S3 QFN56 v0.2 / PSRAM 8MB / Flash 16MB / MAC `30:30:f9:08:76:84`。
- 烧录前 flash 头部探测：非空白（34.6% 有内容，含出厂 bootloader+分区表+程序）→ **全片 16MB 备份**：
  - `D:\esp32-sos-build\.local\com8-full-backup-20261026.bin`（16,777,216 B，394.6 秒读回）
  - SHA-256 `17D0EFAFE6D25C82164DAD621A0F2A39B48F018BB442BC58AC0CA6DF4E5EA8E4`

### 3.4 固件构建与烧录（真实凭据版，已完成）
- 配置（`profiles\sos-node.sdkconfig.defaults` + `.local\sdkconfig.sos.defaults`，后者仅本机、不含进报告）：`esp32-sos` / `随身求助` / `MOTION=-1` / `SOS=GPIO4` / `BUZZER=GPIO6` / `REPORT_SEC=5` / `NO_MOTION_SEC=1800` / WiFi `ElderCareLab` / GW `10.127.130.179:9101`（本机 WLAN IP 实测）。
- **构建坑已排**：idf.py 只在 SDKCONFIG 文件变化时重配 → 每次改 DEFAULTS 必须先删 `sdkconfig.sos` 强制重配，否则产物假阳性（bin 哈希不变）。
- **最终产物（已烧录到 COM8）**：`D:\esp32-sos-build\build-sos-node\esp32_elder_node.bin`
  - **762,768 B，SHA-256 `45C7094C7C20453EFFA1915B6353DB3D139FF7C4932E83413089DEE5F7A10D55`**
  - app 分区 27% free；953/953 编译通过；补丁符号（`gateway_task`/`s_sos_event_ts`/`s_reports`/`s_commands`）已 ELF 验证
- 烧录记录：两次 `idf.py -p COM8 flash`（460800，Hash of data verified）；板子 hard reset 正常；启动日志显示 STA MAC `30:30:f9:08:76:84`、`连接 WiFi: ElderCareLab`。
- 一键脚本：`D:\esp32-sos-build\sos_flash.ps1`（隐藏输密、串口基线比对、chip_id 只读确认）。

## 4. 桥接链路（已启动，节点接入受阻）

- **broker 1883**（PID 41084）与 **bridge 9101**（PID 26376，`--listen 9101 --broker 127.0.0.1:1883`）已启动并监听，日志无错误。
- **本地隔离链路验证：通过**（2026-10-26）——模拟节点 `esp32-sos-isolated-test`（`--room 隔离测试`）经 TCP:9101→bridge→broker，订阅 `home/esp32-sos-isolated-test/status` 收到 **8 条完整 JSON**（deviceId/room/ts/state/sensors/alarm 字段齐全，每 3 秒心跳）；数据未出本机（public-sync 未启动），未污染生产家庭与真实告警列表。
- **节点接入状态：WiFi 间歇性连接**（实测更新）：
  - **间歇性成功**：10 分钟窗口内 2 次成功获取 IP（`10.127.130.91`）并上报 status（state=NORMAL，ts 递增、RTC 时间连续）；板端 TCP 曾与 bridge 保持 Established（10.127.130.91:56365）。
  - **间歇性失败**：大部分时间 `reason=202 (AUTH_FAIL)` 循环（`wifi:connected` 关联成功、aid=3/4/6/7 变化，但 4-way 握手失败、无 IP）；成功窗口仅数秒，TCP 上报常在发送前被 WiFi 断开打断。
  - 环境变化：AP 信道由 1 切至 **11**（BSSID 5a:fe:a0:a6:a3:d7 不变）；厨房/卫生间两块旧板（密码相同 12345678）此刻**稳定连接**并持续上报。
  - 固件侧逐字节验证无问题（SSID+密码字符串存在、PMF 已禁、WPA3 兼容已开）。
  - **结论：非固定 MAC 拒绝、非固件问题，指向 AP 对新 MAC（30:30:f9:08:76:84）的瞬态限制或板子位置信号临界**。用户已选择"挪板子位置重试"，监测中。

## 5. 未完成（真实交付四判据）

| 判据 | 状态 |
|---|---|
| 独立实体按钮（可随身携带） | 🟡 主控板已确认+烧录；按钮/蜂鸣器接线与独立供电待用户实装 |
| 独立供电脱离 USB | ❌ 未确认电池/移动电源 |
| 无线求助上报（真实按压 → 系统生成 SOS） | 🟡 本地链路已启动；WiFi 接入被 AP 认证拒绝，公网同步未启动（待 INGEST_KEY） |
| APP 收到真实告警 → 用户确认 → 按钮收到对应回执 | ❌ 无公网会话/真实 ACK 链路运行 |

历史参考（交接文档 §9.1）：2026-10-22 曾有实体 SOS→APP ACK→202→设备 ACKED 证据，但那是既有节点链路，不是本次独立按钮的交付证据。

## 6. 尚缺条件与最短下一步

| # | 缺口 | 用途 | 备注 |
|---|---|---|---|
| 1 | AP 侧放行新设备（MAC `30:30:f9:08:76:84`）或换可用 2.4G 网络 | 节点无线接入 | 认证失败 202 的唯一阻断（固件/凭据已逐字节验证无误） |
| 2 | OneNET/INGEST_KEY（仅本机隐藏输入） | 公网同步 public-sync 启动 | 用户已确认"现在提供"，待粘贴 |
| 3 | 实体接线：按钮 GPIO4↔GND、蜂鸣器 I/O→GPIO6/VCC→3.3V/GND | 真实按压交付 | 蜂鸣器 3 针已确认；按钮按 2 脚常开假设 |
| 4 | 独立供电（电池/移动电源） | 脱离 USB | 无电量伪造 |
| 5 | 监护 APP 上对指定真实告警确认 | ACK 回执闭环 | 用户配合 |

**最短下一步**：① 用户侧确认/放行 AP（或提供备用网络凭据）；② 提供 INGEST_KEY 后启动 public-sync；③ 接线+独立供电；④ 用户按压真实按钮 → 观察 APP 告警 → 确认 ACK → 按钮静音回执；⑤ 取证（时间戳/告警ID/无重复）后更新本报告为"真实使用验收完成"。

## 7. 证据文件索引

- 交接文档（基线）：`docs/evidence/2026-10-26-new-chat-handoff.md`
- 补丁候选源码：`D:\esp32-sos-build\main\node_main.c`（外部副本，公共源码未动）
- 构建产物：`D:\esp32-sos-build\build-sos-node\esp32_elder_node.bin`（SHA-256 `45C7094C…A10D55`）
- 备份：`D:\esp32-sos-build\.local\com8-full-backup-20261026.bin`（SHA-256 `17D0EFAF…E5EA8E4`）
- 日志：`D:\esp32-sos-build\.local\`（build-real2/3.log、flash-com8*.log、com8-boot*.log、broker/bridge.log、sim-iso.log、sub-iso.log）
- 交付验收方案（图文）：`D:\esp32-sos-build\ESP32-S3-随身求助按钮-交付验收方案.html`（v3，shot.py 自检 error=0）
- 一键烧录：`D:\esp32-sos-build\sos_flash.ps1`
- 本报告 SHA-256 随目录内 `REPORT.md.sha256.txt`（本版本）。
