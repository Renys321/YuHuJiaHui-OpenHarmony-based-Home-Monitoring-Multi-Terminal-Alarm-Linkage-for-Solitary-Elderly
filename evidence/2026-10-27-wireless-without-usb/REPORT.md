# 无线化验收（电脑持续运行、设备拔掉电脑 USB 后监护链路）— 报告（2026-10-27 深夜实做）

- 工作区 `<WORKSPACE>`；电脑全程未关机；未重置账号/设备、未删除告警、未烧录固件、未改无关板卡。
- 交付目录：`competition/evidence/2026-10-27-wireless-without-usb/`
- **一句话结论**：厨房、卫生间、随身 SOS 三条链路已在**无 USB 数据线**状态下真实工作，APP 能看到拔线后的新数据并完成 SOS+ACK 全闭环；DAYU200 的非视频数据也已实跑在 **Wi-Fi**（bridge 目标为 10.127.130.250:9000，不是 HDC 127.0.0.1:9001），但最终快照时 **DAYU 的 USB 仍被电脑识别到**（`hdc` 可登录），因此“DAYU 那根 USB 物理拔掉”这一步需用户执行一次；实时视频仍依赖 USB/HDC，属本任务明确保留的例外。

## 1. 逐设备结论

| 设备/链路 | 电脑 USB 角色（实测） | 拔 USB 后实际路径 | 状态 |
|---|---|---|---|
| 厨房 ESP32（`esp32-kitchen`） | 仅 5V 供电 + CH340 调试串口，**不承载上报数据** | Wi-Fi → PC `10.127.130.179:9101` → broker → public-sync → 后端 | **PASS**（COM5/CH340 已从电脑消失；云端持续新鲜） |
| 卫生间 ESP32（`esp32-bath`） | 同上（COM4/CH340） | Wi-Fi → PC → 后端 | **PASS**（COM4 消失，数据新鲜且传感器值在变） |
| 随身 SOS（`esp32-sos` + M100） | 无 USB（全程无 COM8）；M100 仅 DC + 4G | M100 4G → ECS MQTT → 适配器 → 生产后端 → APP | **PASS**（真实按键 + APP ACK 全链路，见 §4） |
| DAYU200（`dayu200-living`） | USB 可被电脑 `hdc` 登录；非视频数据已改走 Wi-Fi | `homemon 10.127.130.250:9000` ← PC bridge（Wi-Fi）→ 后端 | **数据路径 PASS；USB 物理拔线仍待用户做一次**（最终快照 `hdc list targets` 仍含 4501…；bridge 未使用 hdc） |
| 实时视频（手机 APP） | DAYU 视频推流仍走 `hdc fport 9301` | 拔 USB 后不可用 | **例外（如实记录）**：APP 显示“已连接视频中继，但 15 秒内没有收到任何画面 / first_frame_timeout”，不伪造画面 |

## 2. 关键证据（原始文件见同目录）

1. **ESP32 三路同步对齐（决定性）**：同刻采集 串口 JSON `ts` == broker 报文 `ts` 逐毫秒一致，6/6 组，到达延迟 −76…+67ms（`esp32-net/logs/`）；COM4/COM5 消失后 MQTT 仍持续收到两板新状态（`mqtt-nousb-20261027-223814.log`）。
2. **无 USB 状态**：`hdc list targets` 只剩模拟器；设备管理器无 CH340/FTDI 时截图/快照；`fport ls` 为空（`baseline/`、`timeline/`）。
3. **APP 端 4/4 在线**：`baseline/app-final-2316.jpeg`（4/4 在线/设备，厨房/客厅/卫生间“最近上报 刚刚”，随身 SOS 恢复后在线），`baseline/app-home-all-usb-unplugged.jpeg`（3/4 在线、SOS 断电期间如实显示“离线·最后在线 5 分钟前”）。
4. **APP 数据新鲜度轮询**：7 次 ×30s，四台设备 age 均 0–21s（`baseline/final-freshness-samples.txt`、`timeline/wireless-unplug-timeline.jsonl`）。
5. **SOS 实体按键 + ACK**：`sos-7-b941b638`：createdAt 22:52:32.478 → 云端 +0.69s 可见 → acknowledgedAt 22:52:59.268（household-guardian，用户本人在 APP 点确认）→ 设备 state=ACKED、lastSeen 22:52:59.281（设备真实回执）；用户确认“按键三短声、ACK 后停响”。`sos-m100/REPORT.md`、`capture/*`、`snapshots/*`、本目录 `sos-m100/alert-sos-7-b941b638.json`。
6. **DAYU 视频例外**：`baseline/app-video-after-dayu-usb-unplug.jpeg`（15s 无画面 → first_frame_timeout，无假画面）。
7. **Wi-Fi 数据路径证明**：bridge 进程参数 `--status-tcp 10.127.130.250:9000 --relay-to 10.127.130.250:9000`；日志 `已连接转发目标/已接入节点 10.127.130.250:9000`，同刻 `hdc fport` 未被 bridge 使用（`bridge-wifi-250.log`）。DAYU Wi-Fi 为 `ElderCareLab`（WPA2，DAYU 由 DHCP 取得 10.127.130.250）。

## 3. 为跑通无线化做的必要整改（均已在证据中）

1. **broker 崩溃修复**：22:26 `mqtt_broker.js` 因收到畸形/截断 CONNECT 抛出 `RangeError` 崩溃（导致全链路中断）。已加边界检查 + 单报文异常只断开该连接，畸形包回归验证 `INVALID_VARIABLE_HEADER` 且 broker 存活（备份 `mqtt_broker.js.bak-20261027-wireless`）。
2. **adapter 兼容修复**：DAYU 冻结 `homemon` 重启后 `sensors.motion` 增加 `supported/reported/reason`，严格校验把 `dayu200-living` 判为 `INVALID_STATUS` 丢弃。已在 `cloud/onet/adapter.js` 对这些字段做类型校验但不透传（与 `climate.valid` 一致），全量 onenet 测试 17 个文件全部通过；重启 public-sync worker 后 DAYU 云端恢复 `202`。
3. **网络切换**：电脑加入 `ElderCareLab`（10.127.130.179）；bridge 由 HDC 端点改为 `10.127.130.250:9000`；DAYU 重新入网时随机化 MAC 导致 IP 由 .131→.250，已重新对齐（风险：再次重连可能再变，建议 AP 按设备静态 IP/DHCP 保留）。
4. **public-sync**：原进程 22:26 前已死；用户输入生产 INGEST_KEY 重新拉起 supervisor/worker（窗口标题 `elder-care public-sync supervisor`），期间因窗口被关闭 23:04–23:09 中断一次，已再次拉起；当前 `HEALTHY`。
5. **停止干扰**：停掉旧 `demo-autostart` 观察器（其每 30s 执行 `hdc kill`/反复恢复 fport，会干扰拔线判定）；broker/bridge/public-sync/APP 保持运行，无重复实例（broker 27820、bridge 48108、supervisor 40628/worker 56416）。

## 4. 未完成 / 限制（如实）

1. **DAYU USB 物理拔线尚未完成**：最终快照 `hdc list targets` 仍含 `450100445634303332012847942eca00`，`hdc shell` 可执行 → 电脑仍通过 USB 连到 DAYU。**需要用户拔掉 DAYU 身上那根数据 USB（保留圆形电源适配器）**；拔掉后 `hdc list targets` 只剩模拟器、`hdc fport ls` 为空，而 APP 四台设备仍应保持“最近上报 刚刚”（bridge 走 Wi-Fi 不依赖 USB）。另：设备管理器仍有 FTDI `USB Serial Converter / COM11`，若它是 M100/SOS 的 USB-TTL 配置线，也应一并拔掉。
2. **DAYU Wi-Fi 曾在 22:46 掉线过一次**：重新入网后随机化 MAC 并换 IP（.131→.250），导致 bridge 短时找不到；现已在 .250 稳定。若晚些再次重连换 IP，需把 bridge 重新指向新 IP（或给 DAYU 配静态 IP）。
3. **public-sync 窗口不能关**：关闭后“电脑→生产后端”停止（设备→电脑仍正常），APP 会变旧；窗口标题 `elder-care public-sync supervisor` 请保持开启。
4. **视频仍依赖 USB/HDC**（本任务允许的例外）：拔 USB 后视频页如实报错，不伪造。
5. 实体手机 NOT TESTED（使用模拟器）；DAYU 相机/推理“仍在运行”由用户现场目视确认 + DAYU 数据持续上报间接佐证（拔 USB 后无法再用 hdc 抓进程）。

## 5. 用户只剩 2 个动作

1. 拔掉 **DAYU200 的数据 USB 线**（保留电源适配器；屏幕黑了就点一下屏幕唤醒），以及（若在）**FTDI USB-TTL（COM11）**；随后看 DAYU 屏幕相机预览/人体检测是否仍在。
2. 完成后再看 APP：应仍是 **4/4 在线、厨房/客厅/卫生间“最近上报 刚刚”**；若 DAYU 屏幕休眠导致 Wi-Fi 掉线，点屏唤醒并告知，我会把 bridge 指到新 IP。

## 6. 证据索引（本目录）

`REPORT.md`（本文）、`baseline/`（APP 截图、后端快照、最终新鲜度采样、拔线前基线）、`timeline/`（5s 时间线 JSONL、PnP/端口快照）、`bridge-wifi-250.log`、`broker-wifi.*`、`tools/`（时间线采集、public-sync 启动）、以及队友证据：`esp32-net/`（Wi-Fi 上报与 ts 对齐）、`dayu-net/`（DAYU Wi-Fi/IP/相机推理基线）、`sos-m100/`（SOS+ACK 捕获与快照）。
