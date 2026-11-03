# 三个单点风险 · 详解与现场手册

- 关联报告：`REPORT.md`（2026-10-28 全链路实时体检）
- 适用：演示前 / 演示中排障
- 一切结论基于今晚 22:34–01:57 的实测日志与源码，**只读核实，未改现场**

---

## 0. 总览（先看这张表）

| # | 单点 | 爆掉的一瞬间 | 爆炸半径 | 自愈能力 | 今晚实证 | 前兆（3 秒可判） |
|---|---|---|---|---|---|---|
| R1 | **hdc fport**（PC↔USB↔板端 homemon） | 板端 `9001` 隧道断，bridge 两路 + 视频一路同时掉 | **APP 里全屋一起停更**；云端仍有厨房/卫生间（它们不经过这条） | 规则丢 ≈2–4s 自动修；**USB/设备掉线则修不了**（今晚 13 分钟） | 22:43:51–22:56:36 连续 27 次重试；DAYU 190 分钟里离线 59.3 分钟 | `hdc fport ls` 变空 / `list targets` 少一个 |
| R2 | **两路 ESP32 共用 AP** | 厨房+卫生间**同时**停更 12–34s，节点重启 | 只有这两房间；客厅/随身求助不受影响 | 固件自动重连 ≈12s，数据 ≤34s 恢复 | 01:43:48（相隔 714ms 同断，12.5s 恢复）；00:14 双断 2.5 分钟 | bridge 日志成对出现"无线节点 esp32-* 断开" |
| R3 | **public-sync 的 INGEST_KEY** | 云端同步停，本地一切正常 | 只毁"云大屏/多终端"叙事 | **无**：必须人工在弹出窗口敲 key | 00:53–01:01 断流 ≈6 分钟；4 次拉起都要 key | 弹出窗口问 key；`watcher-state.p0 != healthy` |

判定顺序：**先看 R1（影响面最大）→ 再看 R2（发生频率最高）→ R3（影响面小但无法自愈）**。

---

## R1. hdc fport：PC↔USB↔板端隧道

### R1.1 它到底是什么

```
板端 homemon  ─监听 tcp:9000（板内）─┐
                                     ├─ hdc fport 把 PC 的 127.0.0.1:9001 映射到板端 9000
PC 侧 bridge  ─连 127.0.0.1:9001 ────┘   （两路：--status-tcp 状态 + --relay-to 注入）
PC 侧 video relay ─也连 127.0.0.1:9001（取视频帧通道）
```

- 链路里串了 4 段：**USB 线 → Windows USB 栈 → hdc 服务(PID 31928) → 板端 homemon**。
  任意一段断，`9001` 就废，而且 `9001` 上挂着 3 条常连接（bridge 两路 + video 一路）。
- 它是**唯一**能拿到 `dayu200-living`（客厅）状态的通道，也是 bridge 把厨房/卫生间状态**注入板载 APP** 的通道。

### R1.2 为什么是"最大风险"

1. **影响面最大**：断了以后，APP 的 4 个房间会**一起不动**——因为厨房/卫生间在 APP 里的显示，靠的正是
   bridge 经这条隧道 `relay` 注入 homemon 再广播给 APP。也就是说**物理上只坏了一个客厅，APP 上是全屋黑**。
2. **不是纯软件问题**：人是会碰到 USB 线的，板子会重启，hdc 服务会重开。
3. **通道本身已经不干净**：今晚实测这条通道上 804B 长帧有 **8.2% 字节插入损坏**（详见 `transport\FINDINGS.md` §2），
   虽然只影响随身求助的板载显示（≤5s 自愈），但说明这条隧道在"长帧 + 共享转发"路径上并不 100% 可靠。

### R1.3 今晚实证

| 时间 | 事实 | 证据 |
|---|---|---|
| 22:43:51 – 22:56:36 | **连续 27 次** `HDC target not connected; restarting hdc server once`，约 13 分钟 | `demo-autostart.log` |
| 22:43:53 – 22:56:39 | `hdc fport ls` 采样为空，期间 `hdc targets` 缺 DAYU 的样本 71 个 | `wireless-unplug-timeline.jsonl` |
| 22:56:44 | `Restoring hdc fport tcp:9001 -> tcp:9000.` 恢复 | 同上 |
| 00:00–00:25 / 00:28–00:47 | `dayu200-living` 后端离线两段（25 分 + 18 分） | 同上 |
| 全程 | `dayu200-living` 离线累计 **59.3 分钟 / 31.1%**（190 分钟窗口） | Lead 统计 |

### R1.4 自愈机制（重要，决定了止损方式）

- watcher 主循环**每 2 秒**跑一次 `Ensure-Fport`（`demo-autostart.ps1:246-253, 543-546`）：
  - 若 `hdc fport ls` 里没有 `tcp:9001 -> tcp:9000` → **立刻重加规则**（2–4 秒内恢复）；
  - 若 `hdc list targets` 里看不到 DAYU → `Ensure-Hdc` 每 **30 秒** `hdc kill` + `hdc start`（`:95-108`）。
- bridge 侧断线后按 `3s→6s→12s→24s→30s` 封顶退避**永久重连**；恢复后补发 relay 缓存。
- 所以：
  - **规则丢失（fport 被清）**：几秒内自愈，几乎无感；
  - **target 丢失（USB/板端掉）**：30s 一次的 hdc 重启救不回来——今晚那 13 分钟就是这种，只能等人查线。
  - 恢复后 bridge 还要退避重连，**端到端可见空档约 5–35 秒**。

### R1.5 现场怎么做

| 现象 | 判断 | 动作（零改动） |
|---|---|---|
| 跑 `hdc fport ls` 无输出 | 规则丢了 | 等 2–4s（watcher 会重加）；急就手动 `hdc -t <target> fport tcp:9001 tcp:9000` |
| `hdc list targets` 没有 `4501004456...` | USB/板端掉 | 查 USB 线/供电，**重插板子**；必要时 `hdc kill` + `hdc start` |
| bridge 日志 `节点 127.0.0.1:9001 3000 毫秒后重连` | 隧道断，bridge 在自愈 | 别重复启动第二个 bridge（会抢锁） |
| 板端 homemon 挂了（fport 在但 9001 连不上） | 进程死 | watcher 的 `Ensure-Homemon` 会在 ≥15s 后拉起 |

### R1.6 根治方向（演示后做）

板端有 Wi-Fi（视频已直连 `10.127.130.132:9301`），所以**把 status/relay 通道也改走板端 IP:9000**
就可以绕开 USB——今晚 `evidence\2026-10-27-wireless-without-usb\` 就是在验证这件事。改动只需 bridge 的
`--status-tcp/--relay-to` 指向 `10.127.130.132:9000`，但要先确认板端防火墙/端口可达。

---

## R2. 两路 ESP32 共用 AP / 供电：共因故障

### R2.1 现状拓扑（已实测）

| 项 | 值 |
|---|---|
| SSID | `ElderCareLab` |
| BSSID | `5a:fe:a0:a6:a3:d7`（本地管理地址，**像软 AP/热点/随身路由**，不是普通路由器 BSSID） |
| 频段/信道 | 2.4GHz / **Channel 1** |
| 信号 | 87% |
| PC | `10.127.130.179`（是 AP 的客户端，不是 AP 本身） |
| ESP32 厨房 | `10.127.130.168` / `50:78:7D:16:ED:60` |
| ESP32 卫生间 | `10.127.130.71` / `14:C1:9F:42:DD:B4` |
| 同网段还有 | DAYU200 的 Wi-Fi `10.127.130.132`（视频 9301 在用） |

**两块 ESP32 都挂在同一个 AP、同一个 2.4G 信道上，而同一个信道上还跑着板端的视频流。**
所以"AP 抖一下""信道被挤""两块板共用一路供电"都会让它们**一起**掉——今晚已经发生过。

### R2.2 今晚实证（这是"共因"最硬的证据）

```
[17:43:48.231Z] [bridge] 无线节点 esp32-bath 断开
[17:43:48.945Z] [bridge] 无线节点 esp32-kitchen 断开      ← 相隔 714ms
[17:44:00.687Z] [bridge] 无线节点接入并完成身份绑定：esp32-kitchen（来源 ...:59409）
[17:44:01.893Z] [bridge] 无线节点接入并完成身份绑定：esp32-bath（来源 ...:50040）
```

- 两节点相隔 **714ms** 断开 → 不可能是两块板各自随机故障，指向**共同原因**。
- 重连后**源端口全变**（62780/61793 → 59409/50040）。
- **卫生间 `countToday` 从 189 归零到 1** → 不是单纯 TCP 重连，是**节点重启**（RAM 计数清零）。
  这强烈提示**供电掉了**（共用一个 USB 电源/HUB/插排），而不是 Wi-Fi 单独抖动。
- 数据面空档：厨房 31.8s、卫生间 33.8s。
- 更早同类事件：`22:36:38` 双断 19s；`00:14:09 → 00:16:35` 双断 **2 分 26 秒**；190 分钟里厨房 16 段离线、卫生间 5 段。

### R2.3 失效时的表现

- APP 上厨房/卫生间两块数据**同时**停更，客厅和随身求助不受影响；
- 若演示正在做"跌倒/燃气报警"，**这个窗口内的事件会丢**（节点重启后计数清零，也不会补报）；
- `nodes=4/4` 可能掉到 `2/4`，但要等 APP UI 刷新（最慢 30s）才反映出来。

### R2.4 现场怎么做

| 现象 | 判断 | 动作 |
|---|---|---|
| bridge 日志成对出现两个 `无线节点 esp32-* 断开` | 共因（AP/供电） | **等 15–30 秒**，固件会自动重连（今晚 12.5s 就回来了），别去重启节点 |
| 超过 60s 不回来 | AP 挂了或供电断了 | 查 AP 电源、查两块板的供电（是不是同一个 HUB/插排） |
| 只有一个掉 | 单节点/单板问题 | 查那块板的供电与串口 |

### R2.5 根治方向

1. **供电分离**：两块 ESP32 不要接同一个 USB HUB/插排；用独立电源适配器。
2. **信道固定**：如果是软 AP，关掉自动信道，固定 Channel 1/6/11 里最干净的一个；避免演示时 AP 自动换信道。
3. **降同信道占用**：板端摄像头视频流（9301）和两块 ESP32 在同一 AP，演示视频时注意别同时跑大流量。
4. 固件侧已有断线重连；可再加"掉线后不重置计数"（把 countToday 落盘），避免重启丢当日统计。

---

## R3. public-sync 的 INGEST_KEY：唯一"不可自愈"的人工步骤

### R3.1 机制（源码级）

`cloud\onenet\public-sync-supervisor.js`：
- 启动即写 `WAITING_FOR_KEY`（`:227`），然后 `readKey()` **从真实 TTY 隐藏读取**（`:136`）；
- key **只存在进程内存**，不进 argv/env/文件/日志（文件头 `:6-17` 明说）；worker 也**刻意不继承**（`:244-251`）；
- 读不到 key（没有可见 TTY / 输入失败）→ `KEY_INPUT_FAILED` → 释放锁并退出（`:230-236`）。

所以：**supervisor 每次换代，都必须有人在一个可见控制台窗口里把 key 敲进去**，否则云端同步不会起来。
这是刻意的安全设计（key 不落盘），代价就是"没有自动恢复"。

### R3.2 今晚实证

`demo-autostart.log`：
```
[00:55:12] 检测到 STALE supervisor lock PID=40628（进程已退出）… 拉起既有正式 P0 入口（key 需由用户在该可见窗口输入）
[00:56:18] … reason=STALE_LOCK heartbeatAgeSec=95
[00:57:25] … reason=STALE_LOCK heartbeatAgeSec=161
[00:57:44] P0 不健康（WORKER_DEAD）但 supervisor 进程仍存活 PID=67276；不重复拉起，等待其自身重启/熔断恢复
[01:01:02] … reason=PORTS_DOWN … 拉起既有正式 P0 入口
```
- 00:53–01:01 之间 supervisor 换代，云端**断流约 6 分钟**，直到有人把 key 输进去。
- 老版本还有个坑：进程死了但 `state.json` 仍停在 `HEALTHY`，监视器永远判健康（源码注释 `demo-autostart.ps1:137-140` 记录了 10-27 那次事故）。
  **这个坑已经修了**：现在 `Get-P0Health` 要求「端口在监听 + supervisor PID 活 + worker PID 活 + state=HEALTHY + heartbeat ≤90s」五条同时成立（`:141-179`），
  所以断流最迟 90 秒会被判 `STALE_HEARTBEAT` 并触发重新拉起。

### R3.3 失效时的表现

- 云端同步停 → 云大屏/手机端数据变旧（`/internal/v1/device-status` 不再 202）；
- **本地全链路完全不受影响**：bridge、broker、APP、视频、随身求助照常；
- 屏幕上可能出现一个新的控制台窗口，提示 `Enter public backend INGEST_KEY for supervisor (hidden):`。

### R3.4 现场怎么做

1. **不要关闭、不要最小化** 01:01 启动的那个 supervisor 窗口（关掉 = 杀进程 = 云端断流）。
2. 看到弹窗问 key：**立刻输入**（输入不回显是正常的）。
3. 判健康：`watcher-state.json` 里 `p0=healthy` 且 `p0Reason=HEALTHY`；或看 state 的 `heartbeatAt` 是否在 90s 内。
4. 若窗口被关且 key 不在手边：**宁可放弃云端叙事，也不要现场找 key**——本地演示不受影响，直接改讲"本地闭环优先，云端同步为增强"。

### R3.5 根治方向

- 用 Windows 凭据管理器 / 启动引导服务在进程启动时注入 key（不吃 TTY）；
- 或把 INGEST_KEY 换成可自动续期的短期 token（比如 ECS 侧发一个 24h 的 ingest token），把"人工环节"变成"一次性准备"。

---

## 4. 次级风险（不影响判定，但别在演示里踩）

| 风险 | 事实 | 演示影响 |
|---|---|---|
| 板端长帧 8.2% 字节损坏 | 804B 帧被插入 52–102 字节；只感染 esp32-sos | 板载 APP 显示随身求助最坏晚 ≤5s |
| 厨房燃气 `raw` 恒 4095 | 15/15 帧满量程且 `valid=true` | **不要演示燃气数值变化** |
| 板端 homemon 客户端槽位 8 个（当前占 4） | `homemon.c:700` 注释记录过占满事故 | 演示前别叠加探活/多终端订阅 |
| MQTT QoS0 / 无 retain | 订阅端瞬断丢当前一条 | 别宣称"消息绝不丢" |
| 公网 ECS 单 IP（443+1883+80） | DNS 单 A 记录 | 只影响云端/多终端，不影响本地闭环 |

---

## 5. 现场三分钟巡检（只读，可直接粘贴）

```powershell
# R1：fport 与 USB 目标（第一失效点）
& <WORKSPACE>\tools\hdc\hdc.exe fport ls
& <WORKSPACE>\tools\hdc\hdc.exe list targets

# R2：两路无线节点是否都在（9101 上应为 2 条 ESTABLISHED）
Get-NetTCPConnection -State Established | Where-Object LocalPort -eq 9101 |
  Select-Object RemoteAddress, RemotePort

# R3：P0 与云端同步状态
Get-Content <WORKSPACE>\competition\evidence\2026-10-26-demo-autostart\runtime\watcher-state.json

# 归一化一眼看：bridge 最近 5 条
Get-Content <WORKSPACE>\competition\bridge\_test\current-runtime\supervisor\bridge.out.log -Tail 5
```

正常态基线（01:55 实测）：fport 有 `tcp:9001 tcp:9000 [Forward]`；targets 有 `127.0.0.1:5555` 与
`4501004456...`；9101 两条（`10.127.130.168` / `10.127.130.71`）；`p0=healthy`、`nodes=4/4`、`inference=running`。

---

## 6. 一页话术（如果演示中真出事）

| 出事的点 | 一句话圆场 | 后台同时做什么 |
|---|---|---|
| R1 hdc | "这块走的是 USB 调试隧道，正在自动重连（5–35 秒）" | 看 fport/targets；必要时重插板子 |
| R2 Wi-Fi | "两个房间节点在同一个 AP 上，刚才 AP 抖了一下，节点正在自动回连（约 12 秒）" | 等 15–30s；不要重启节点 |
| R3 key | "云端同步是增强项，需要一次性密钥，本地闭环不受影响" | 有 key 就输入；没有就继续讲本地 |
