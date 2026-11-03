# 演示全链路实时体检报告

- 体检时间：**2026-10-28 01:41–01:55（Asia/Shanghai）**，系统处于线上演示运行态
- 体检方式：**全程只读**（订阅/读日志/netstat/TCP 连即断/hdc 只读查询/HTTP GET）；未重启任何进程、未 publish 任何命令、未写 control、未改板端与配置
- 分工：Lead 做跨层时间线与交叉验证；节点层 / 传输层 / 云与应用层 三组并行取证
- 证据：本目录 `lead\`、`nodes\`、`transport\`、`cloud-app\` 四份 `RAWMEMO.md` + `FINDINGS.md`，原始抓包与日志片段均在位

---

## 0. 一句话结论

**现在这一轮是稳的，但今晚不是一直稳的。**

- **当前（01:01 重启后至今 53 分钟）**：PC 侧四条长连接源端口零漂移，MQTT 零重连/零重放/零协议错误，
  bridge 事件速率 54–65 条/分无缺口，三台网络设备上报节拍 3.01s / 5.50s / 5.50s（抖动 σ 0.5%–4.7%），
  探活 15/15 PASS，RSS/句柄零增长。**判定：稳定，可演示。**
- **今晚历史（22:34–01:45，190 分钟）**：期间多次真实断链——`dayu200-living` 离线累计 59.3 分钟（31.1%，
  最长一次 25 分钟）、`esp32-bath` 离线 39.7 分钟（最长 38.4 分钟）、两路 ESP32 至少 1 次同时断；
  00:53–01:01 整套 P0（supervisor+worker+bridge）死过一次并由 autostart 重建。**判定：不具备"长时间无人值守"的稳定度。**
- **风险不是"链路慢"，而是 3 个单点**：① hdc fport（PC↔USB↔板端）；② 两路 ESP32 共用的 Wi-Fi/AP；
  ③ public-sync 换代后必须人工输入 `INGEST_KEY`。

> 对演示的含义：**只要不在这 3 个单点上出意外，链路本身的表现是稳的**；出意外时的表现是"所有房间一起停更十几秒到几分钟"，而不是数据慢慢变差。

---

## 1. 链路拓扑与逐段判定

```
[ESP32 厨房 10.127.130.168] ─Wi-Fi/TCP─┐
[ESP32 卫生间 10.127.130.71] ─Wi-Fi/TCP─┤→ bridge:9101
[DAYU200 homemon] ─hdc fport 9001→9000 ─┤→ bridge(PID 46720) ─MQTT:1883→ broker(PID 27820)
[随身求助(4G)] → ECS→API → wearable-mirror:61116 ─relay 9001─┘        │
                                                                      ├→ public-sync-worker ─HTTPS 443→ ECS 47.76.70.118
                                                                      └→ 订阅端（板载 APP / 手机 / 多终端）
[板端 VideoStreamServer 9301] → video relay 9443 ─WS→ APP
[板端 YOLO 推理 9200] → demo-events.jsonl（1.53 事件/s）
```

| # | 链路段 | 判定 | 关键依据（详见各层 FINDINGS） |
|---|---|---|---|
| 1 | ESP32 ×2 → bridge:9101 | **PASS** | 两节点 ESTABLISHED；ICMP 3/3，13.7/15.7ms；绑定后 5.50s 节拍、σ 0.28s |
| 2 | DAYU homemon → bridge:9001（hdc fport） | **DEGRADED** | 53 分钟 0 断连；但该通道承载的 804B 长帧有 **8.2% 字节插入损坏**，且 fport 是单点 |
| 3 | bridge → broker:1883 | **PASS** | 50.9 分钟 0 重连/0 重放；探活 15/15；broker 协议错误 0；PUBLISH 6649 |
| 4 | broker → public-sync-worker | **PASS** | 当前会话 cloud-sync **OK 264 / FAIL 1 = 0.377%**，失败秒级自愈；POLL 4.08% |
| 5 | worker → ECS:443 | **PASS** | 2 条常连接，RTT 123–133ms，`/healthz 200` |
| 6 | ECS/云 → APP 与 mirror | **DEGRADED** | mirror 轮询 1153/1153 全成功、relay 0 断；但 ECS 单 IP 单机（443+1883+80），今日实测过 10s `online=false` |
| 7 | 视频 relay → APP | **PASS** | local 模式 9443 直连板端 9301；实测首帧 402/643ms、dropped=0；无人观看时主动断开是设计 |
| 8 | 板端推理 → 事件 | **PASS** | 1.53 事件/s、202MB/163.8k 行、p50 605ms、errors=0；丢帧 29% 属算力余量不足但不中断 |
| 9 | 随身求助（4G→ECS→API→mirror→homemon） | **DEGRADED** | 旁路可用（mirror 100% 轮询、APP 显示在线），但**本地 MQTT 上无 `home/esp32-sos/status`**（`--relay-ignore` 有意设计），且依赖公网 API |

---

## 2. 节点表（含 `nodes=4/4` 口径核实）

**`nodes=4/4` 的 4 台 = `dayu200-living`(客厅) / `esp32-kitchen`(厨房) / `esp32-bath`(卫生间) / `esp32-sos`(随身求助)。**
但注意：这个数字**不是链路探针**，而是 watcher 每 30s 从板端 APP 的 `uitest dumpLayout` 文本里
正则抓 `全屋在线 N/M 台设备`（`demo-autostart.ps1:273-275,554-561`），取不到就沿用旧值 → **最坏可陈旧 ≥30s**。

| 节点 | 物理通道 | 在线 | 最近上报距采集 | 上报间隔 | 当前状态 | 判定 |
|---|---|---|---|---|---|---|
| `esp32-kitchen` 厨房 | Wi-Fi TCP → 9101 | 是 | 3.3s | 5.50s（σ0.28） | **ALARM / NO_MOTION**，countToday=1 | PASS（含一次已自愈同断） |
| `esp32-bath` 卫生间 | Wi-Fi TCP → 9101 | 是 | 3.2s | 5.50s（σ0.28） | NORMAL | PASS |
| `dayu200-living` 客厅 | hdc fport 9001 | 是 | 1.5–2.4s | 3.01s（σ0.05，最稳） | **ALARM / FALL——人工演示态**：01:07:43 经 `home/dayu200-living/cmd` 下发 `{"cmd":"fall",...}` 触发并 latched（无 PIR、人体检测不可用，非自动识别） | PASS |
| `esp32-sos` 随身求助 | 4G→ECS→API→mirror→homemon | 是（旁路） | ≈2.5s | 心跳 5s | NORMAL，gps=none | **DEGRADED**（MQTT 不可见；01:46:17 实测 9.9s 掉线） |

端到端延迟：板端段 **204–229ms**；无线段扣除设备钟差后 **<50ms**（ESP32 本地钟比主机快 15–130ms，非乱序）。

---

## 3. 量化指标（当前 53 分钟窗口）

| 指标 | 数值 | 判读 |
|---|---|---|
| bridge 运行时长 / 重启 | 53 min / 0 | 进程稳定 |
| bridge 事件速率 | 54–65 条/分，41 个完整分钟无缺口 | 均匀 |
| status 发布量 | 2121 条（dayu 1013 / kitchen 554 / bath 554） | 与节拍吻合 |
| MQTT 重连 / 重放 / 协议错误 | 0 / 0 / 0 | 无 |
| TCP 探活 1883/9101/9001 | 15/15 PASS，环回 1ms | 无 |
| 连接漂移 | 61797/61798/61799/51362 三次采样不变 | 无 |
| 资源 | broker 46.5MB、bridge 55MB、句柄 211–231 恒定 | 无泄漏 |
| bridge 错误日志 | 60 条，**100% 是 esp32-sos 坏帧**，其他节点 0 条 | 见 §4 |
| cloud-sync 失败率 | 0.377%（264/1） | 秒级自愈 |
| mirror 轮询 | 1153/1153 成功，relay 0 断 | 好 |
| APP / 推理 进程 | APP PID 27321 连续 1h54m；推理 PID 2379 连续 14h | 无重启 |

---

## 4. 本次体检新发现的真实缺陷：板端长帧广播字节损坏（DEGRADED，不影响主链路）

- 现象：`bridge.err.log` 持续出现 `状态行解析失败`，**60 条 100% 是 `esp32-sos`**，约 1.16 条/分。
- 定位：`mqtt_bridge.js:809`，属 `--status-tcp 127.0.0.1:9001` 板端读分支；**不是** 9101 无线节点、**不是** relay 注入。
- 排除上游：mirror 发送端帧完整（`relay <json>\n`，connects:1/disconnects:0/linesSent:624/err 0）。
- 真因（字节级抓包）：板端广播的 **804B 长帧被插入 52–102 字节的重复片段**（坏帧 906/857/856B，`{`=11 vs `}`=10）；
  删掉插入段即恢复合法 JSON 且 `ts` 一致。独立抓包坏帧率 **8.2%（4/49）**，只感染最长的那类 sos 帧，
  kitchen/bath/dayu 均 0 例。两个独立通道收到同一坏帧 → 损坏在"一次组装、广播给所有客户端"的上游。
- 影响面：**不会让"随身求助按了没反应"**。sos 本来就被 `--relay-ignore` 忽略、从不走 bridge→MQTT；
  云端/手机走 4G→ECS→API（0 错误）；**只有板载 APP 的显示最坏晚 ≤5 秒**（被 5s 心跳覆盖）。
- 结论：**日志里看着吓人、演示影响可忽略**；但如果后续把长帧用在 kitchen/bath 的板端回灌上，会真的丢状态。
- 根因已定案到字节级（重复段恒终止于偏移 762 = 768−6，即 hdc fport 的 768B 分块边界）并给出修改方案：
  见 **`FIX-PLAN-hdc-frame-corruption.md`**。

---

## 5. 今晚的稳定性时间线（为什么说"历史不稳"）

| 时刻 | 事件 | 时长 |
|---|---|---|
| 22:43–22:56 | DAYU 的 `HDC target not connected` 连续重试，fport 丢失后由 autostart 恢复 | ~13 min |
| 00:00–00:25 | `dayu200-living` 后端离线 | 25 min |
| 00:20–00:58 | `esp32-bath` 后端离线（bridge 入站连接消失） | **38 min** |
| 00:28–00:47 | `dayu200-living` 再次离线 | 18 min |
| 00:53–01:01 | **整套 P0 死亡**（`STALE_LOCK`→`WORKER_DEAD`→`PORTS_DOWN`），autostart 反复拉起 | ~8 min |
| 01:01:11 | bridge/supervisor/worker/mirror 全部重建，进入当前稳定期 | — |
| **01:43:48** | **两路 ESP32 相隔 714ms 同时断开**（共因：Wi-Fi/AP 侧），12.5s 后自动重连；数据空档 32–34s；bath `countToday` 189→1，**说明是节点重启而非仅 TCP 重连** | 12.5s |
| 01:46:17–01:46:27 | `esp32-sos` 经公网 API 判离线 | 9.9s |

190 分钟统计：`dayu200-living` 离线 59.3 min（31.1%）、`esp32-bath` 39.7 min（20.8%）、
`esp32-kitchen` 9.8 min（5.2%）、`esp32-sos` 0.6 min（0.3%）。
**01:01 之后**：三台网络设备仅 kitchen/bath 各 2 个离线采样（即 01:43:48 那次），已自愈。

---

## 6. 必须先盯的单点（按"概率×影响"排序）

| 排序 | 单点 | 一旦出问题的现象 | 现在如何盯（零改动） |
|---|---|---|---|
| 1 | **hdc fport（PC↔USB↔板端）** | APP 里**所有房间**一起不动；`dayu200-living` 断流；连随身求助注入也断 | 每 30s 看 `<WORKSPACE>\tools\hdc\hdc.exe fport ls` 是否仍为 `tcp:9001 tcp:9000 [Forward]` |
| 2 | **两路 ESP32 共用的 Wi-Fi/AP（+ 本机网卡）** | 厨房/卫生间**同时**停更十几秒；`nodes` 可能从 4/4 掉到 2/4 | 看 bridge 日志是否出现成对的"无线节点 esp32-* 断开" |
| 3 | **public-sync 换代需人工 `INGEST_KEY`** | 云端同步停摆，但 `state.json` 可能仍写 HEALTHY（今晚 00:55–01:01 已断流 6 分钟） | **不要关掉/最小化 01:01 那个 supervisor 可见窗口** |
| 4 | 公网 ECS 47.76.70.118（单 IP、单机 443+1883+80） | 云端/多终端叙事中断；**本地闭环不受影响** | 话术上把"本地优先、云端同步"讲清楚 |
| 5 | 单 broker / 单 bridge 进程 | 全链路断（无冗余切换） | 本次 53 分钟零异常，短期概率低 |
| 6 | 板端 homemon 客户端槽位（8 个，当前占 4） | 新连接连上即被踢 | 演示前别叠加端口探活/多终端订阅 |

> 三处单点的机制、今晚实证、自愈能力、前兆与现场止损动作，见配套手册 **`RISK-DEEPDIVE.md`**（含可直接粘贴的三分钟巡检命令与出事时的话术）。

---

## 7. 口径陷阱（汇报/看板别踩）

| 字段 | 看起来 | 实际 |
|---|---|---|
| `nodes = 4/4` | 全链路 4 台在线 | APP UI 文本正则，无逐链路探测，最坏陈旧 30s |
| `cameraFrames = LIVE` | 摄像头画面正常 | 只等于 `demo-events.jsonl` 在增长（推理在写事件），≠ APP 在播 |
| `app = active/present` | active 才是正常 | 两者只差 UI 里有没有"暂停监护\|监护运行中"这行文本；换页即变，不是掉线 |
| `restartCount = 0` | 从未重启 | 单进程内计数；历史实有 7 次 `WORKER_EXIT` 和多次 supervisor 换代 |
| `p0 = healthy` | 全链路健康 | 只覆盖本地 1883/9101 + supervisor 心跳，不含公网/云端/APP |
| `demo-stats.jsonl` | 推理实时统计 | mtime 停在 10-26，是历史文件 |
| `broker.out.log`（supervisor 目录） | broker 日志 | **冻结在 22:29:33 的旧实例残留**；活日志在 `evidence\2026-10-27-wireless-without-usb\broker-wifi.out.log` |

---

## 8. 演示前 5 分钟检查清单（只读动作，零风险）

1. `hdc fport ls` → 必须是 `tcp:9001 tcp:9000 [Forward]`（第一失效点）。
2. 确认 01:01 那个 supervisor 可见窗口没被关、`INGEST_KEY` 输入框在前台。
3. 人工点开一次"客厅摄像头"预热 relay（首帧 0.4–0.6s，避免评委看到第一秒黑屏）。
4. 讲解口径：客厅 `ALARM/FALL` 是 **01:07:43 人工下发 `fall` 命令触发的演示态**（本案无 PIR，人体检测不可用，**不是自动跌倒识别**，与 `docs\HARDWARE-MAP.md §5`「当前不宣称 AI 跌倒识别」一致）；
   若演示脚本需要"处置→恢复"闭环，先确认点「预警处置」后状态能否转 `ACKED`，否则该 latched 告警会一直挂在客厅。
   注意 APP 侧当前显示「一切正常 / 无进行中事件」，与板端 latched `ALARM` 是两套呈现，讲解时别让评委对不上。
5. 厨房燃气：**2026-10-28 02:12 复测已恢复真实读数**（gas 279–398，改线前恒 4095）；
   **02:27 起阈值已启用**（GAS=900 / SMOKE=700，连续 3 帧、回差 20），板端与手机 APP 能力开关同步打开。
   仍未标定、未用真实气体触发验证，**不得宣称 ppm 或"燃气安全"**；详见 `GAS-ALARM-ENABLE-20261028.md`。
6. 若演示"随身求助"，按下后给它 5 秒（板载显示最坏晚 ≤5s），不要 1–2 秒内判失败。
7. 云侧话术：**"本地闭环优先，云端/多终端为同步"**，不要把单 IP 的 ECS 当卖点。

---

## 9. 判定汇总

| 层 | 判定 | 一句话 |
|---|---|---|
| 节点层 | **PASS with DEGRADED** | 3 台网络节点在线且节拍极稳；第 4 台走旁路，MQTT 上不可见 |
| 传输层 | **PASS（含 1 个 DEGRADED 缺陷 + 1 次已自愈抖动）** | PC 侧零断链；坏帧与双节点同断都不在 PC 软件里 |
| 云与应用层 | **PASS（当前 48min），依赖 3 单点 + 1 人工步骤** | 当前失败率 0.38%，历史全量 19.67% |
| **整体** | **当前稳定、可演示；不具备"无人值守长时间稳定"** | 风险集中在 hdc fport、Wi-Fi 共因、INGEST_KEY |

---

## 10. 证据索引

| 层 | 文件 |
|---|---|
| 共享基准 | `_CONTEXT.md` |
| Lead | `lead\RAWMEMO.md`、`lead\logs\mqtt-observe-150s.log` |
| 节点层 | `nodes\FINDINGS.md`、`nodes\RAWMEMO.md`、`nodes\mqtt-sub-home.log`、`nodes\mqtt-tsprobe.log` |
| 传输层 | `transport\FINDINGS.md`、`transport\RAWMEMO.md`、`transport\_tcp9001_raw*.bin`、`transport\_mqtt_latency.log` |
| 云与应用层 | `cloud-app\FINDINGS.md`、`cloud-app\RAWMEMO.md` |
| 长窗口时间线 | `competition\evidence\2026-10-27-wireless-without-usb\timeline\wireless-unplug-timeline.jsonl`（590 条） |

---

## 11. 更正记录

### 2026-10-28 01:57 · 用户确认：客厅 `ALARM/FALL` 是人工演示态，不是检测结果

- 原报告把它列为"待人工确认的口径矛盾"。**更正：这是已知/预期状态，不是链路或系统矛盾。**
- 用户说明：本项目没有 PIR，人体活动检测这条路不成立（`motion.reason=not_configured`、`monitorOnline=-1`），
  人体会"总是报告"，因此客厅告警由人工触发，用于演示处置闭环。
- Lead 侧独立核实的路径证据（`bridge\..\bridge.out.log`）：
  ```
  [2026-10-27T17:07:43.295Z] [MQTT] ← home/dayu200-living/cmd: {"cmd":"fall","evidenceId":"fall-1793120863100-na"}
  [2026-10-27T17:07:43.296Z] [bridge] 命令已写入节点 dayu200-living 的活动连接: fall fall-1793120863100-na
  [2026-10-27T17:07:45.069Z] [bridge] → home/dayu200-living/status  state=ALARM room=客厅
  ```
  即：**该 ALARM 由 MQTT 下行 `fall` 命令触发**（`evidenceId` 后缀 `-na` = 无 trackId，符合人工/演练触发特征），
  而下行链路（APP/云端 → broker → bridge → 板端）本身工作正常，末条转发成功。
- 对判定无影响：链路与节点判定不变；**唯一影响是演示口径**——
  1. 不要把该告警讲成"AI 跌倒识别已验收"（与 `docs\HARDWARE-MAP.md §5` 的边界冲突）；
  2. 该状态自 01:07:43 起未清除，若演示流程需要"处置后恢复"，需先确认「预警处置」能把它转 `ACKED`；
  3. APP 仍显示「一切正常 / 无进行中事件」与板端 latched `ALARM` 并存，属两套呈现，讲解时主动说明。

