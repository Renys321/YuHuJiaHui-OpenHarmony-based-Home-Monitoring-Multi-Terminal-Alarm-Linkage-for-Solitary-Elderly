# 传输层体检 · RAWMEMO（原始证据）

采集人：transport-layer ｜ 采集时间：2026-10-28 01:41–01:53（Asia/Shanghai）
基线：`_CONTEXT.md`（Lead 01:41 采集）。本文件只记录**实际看过的原始输出**，结论见 `FINDINGS.md`。
全程**只读**：只读日志/源码、netstat、TCP connect 探活、MQTT subscribe。未重启/停止任何进程，未 publish，未写 control 文件，未运行 `node --test`。

---

## 0. 环境与路径校正（重要）

`_CONTEXT.md` 写的 `supervisor\broker.out.log` **是陈旧文件**（旧实例日志），不是当前 broker 的活日志：

```
Name                         Length   LastWriteTime
bridge.err.log                 6216   2026/10/28 1:35:07
bridge.lock                       5   2026/10/28 1:01:12
bridge.out.log               282981   2026/10/28 1:36:50
broker.err.log                    0   2026/10/27 22:28:42
broker.out.log                 3518   2026/10/27 22:29:33   ← 冻结（49 行、无时间戳、停在 22:29 启动窗口）
```

当前 broker(PID 27820) 的**活日志**在（由最近 15 分钟被写文件清单定位）：

```
\evidence\2026-10-27-wireless-without-usb\broker-wifi.out.log   622153B  2026/10/28 1:52:13
```

活日志 8561 行、同样**不带时间戳**，只能做计数/顺序分析，不能做绝对时刻分析。`broker.err.log` 恒为 0 字节。

进程核对（`Get-CimInstance Win32_Process`）：
```
PID 27820 D:\Node\node.exe <WORKSPACE>\competition\bridge\mqtt_broker.js 1883
PID 46720 D:\Node\node.exe ...\mqtt_bridge.js --broker 127.0.0.1:1883 --status-tcp 127.0.0.1:9001 --listen 9101 --relay-to 127.0.0.1:9001 --relay-ignore esp32-sos --lock-file ...
PID 61116 D:\Node\node.exe server.js --source api --transport relay --relay-to 127.0.0.1:9001 --listen-port 9002 --runtime-dir ...\cloud\wearable-mirror\runtime --heartbeat-ms 5000 --poll-ms 2000 --api-base https://api.luxunacc.xyz
PID 51804 / 43384 / 68640  均为 mqtt_tool.js sub home/#（lead/其他 teammate 的只读订阅，非常驻订阅端）
```

`hdc`（只读查询，未改任何状态）：
```
$ hdc list targets
127.0.0.1:5555
450100445634303332012847942eca00
$ hdc fport ls
450100445634303332012847942eca00    tcp:9001 tcp:9000    [Forward]
$ hdc -v
Ver: 3.2.0f
```
→ 主机 9001 映射到**板端 9000**（不是 9001）；fport 规则当前有效、方向为 Forward。

---

## 1. bridge.out.log 全量分析（PID 46720）

文件 3184 行，**每一行都以 ISO 时间戳开头**，范围 `2026-10-27T17:01:12.015Z → 17:52:08.550Z`（本地 01:01:12 → 01:52:08，50.9 分钟）。

### 1.1 启动段（原文）
```
[2026-10-27T17:01:12.015Z] [bridge] 接管陈旧实例锁（原 PID=66100 已退出）
[2026-10-27T17:01:12.019Z] [bridge] 单实例锁已获取：<WORKSPACE>\...\supervisor\bridge.lock
[2026-10-27T17:01:12.021Z] === mqtt_bridge 启动 ===
[2026-10-27T17:01:12.022Z]   自动恢复  : MQTT/relay 断线自动重连；恢复后补发最后状态；relay keepalive 10s；日志带 ISO 时间戳
[2026-10-27T17:01:12.024Z]   命令兜底  : ...\supervisor\control
[2026-10-27T17:01:12.024Z]   求助播报  : 关闭（未提供 --sos-source / --sos-targets）
[2026-10-27T17:01:12.033Z] [bridge] 已接入节点 127.0.0.1:9001
[2026-10-27T17:01:12.034Z] [bridge] 已连接转发目标 127.0.0.1:9001
[2026-10-27T17:01:12.036Z] [MQTT] 已连接 127.0.0.1:1883（clientId=bridge-dayu200-living-72020）
[2026-10-27T17:01:12.038Z] [MQTT] 订阅成功: home/+/cmd
[2026-10-27T17:01:13.253Z] [bridge] 无线节点接入并完成身份绑定：esp32-bath（来源 ::ffff:10.127.130.71:61793）
[2026-10-27T17:01:13.309Z] [bridge] 无线节点接入并完成身份绑定：esp32-kitchen（来源 ::ffff:10.127.130.168:62780）
```

### 1.2 全量分类计数（key 词命中）
```
无线节点断开        2        ← 见 1.4，唯一一次
无线节点接入绑定    4        (2 启动 + 2 重连)
重连               1        ← 仅启动 banner 文案，无真实事件
恢复               1        ← 同上
补发               1        ← 同上
重放               0
单实例锁/陈旧       各 1      ← 仅启动
探测连接           46        ← 被忽略的裸探测
relay 回灌         549        ← 设计内去重（bath/kitchen）
--relay-ignore     442        ← 设计内去重（esp32-sos）
MQTT 重连/重放事件  0
错误/失败/异常/堆栈 0
ECONN/ETIMEDOUT    0
```

发布计数（`→ home/<dev>/status` 行）：总 **2121** 行
- `home/dayu200-living/status` 1013
- `home/esp32-kitchen/status` 554
- `home/esp32-bath/status` 554

### 1.3 每分钟事件总数（UTC HH:MM，本地 +8）—— 无任何分钟级缺口
```
17:01 64   17:02 54   17:03 60   17:04 62   17:05 61   17:06 63
17:07 64   17:08 61   17:09 59   17:10 65   17:11 62   17:12 63
17:13 64   17:14 63   17:15 65   17:16 62   17:17 61   17:18 63
17:19 63   17:20 62   17:21 64   17:22 65   17:23 62   17:24 63
17:25 61   17:26 61   17:27 62   17:28 62   17:29 63   17:30 63
17:31 61   17:32 64   17:33 63   17:34 62   17:35 62   17:36 63
17:37 62   17:38 63   17:39 63   17:40 63   17:41 61   (17:42 起为后续增量)
```
最近 10 分钟分类（UTC 17:32–17:41）：dayu 204 / kitchen 112 / bath 112 / relay回灌 112 / relay-ignore(sos) 93 / 裸探测 9。
→ 41 个完整分钟里事件总数稳定在 **54–65/min**，标准差极小，无突发、无静默。

### 1.4 唯一的无线节点断连（原文，本轮最关键链路事件）
```
[2026-10-27T17:43:48.231Z] [bridge] 无线节点 esp32-bath 断开
[2026-10-27T17:43:48.945Z] [bridge] 无线节点 esp32-kitchen 断开
[2026-10-27T17:44:00.687Z] [bridge] 无线节点接入并完成身份绑定：esp32-kitchen（来源 ::ffff:10.127.130.168:59409）
[2026-10-27T17:44:01.893Z] [bridge] 无线节点接入并完成身份绑定：esp32-bath（来源 ::ffff:10.127.130.71:50040）
```
两侧 IP 不变、**源端口全变**（61793→50040，62780→59409）→ 真实 TCP 重连。两节点断开相隔 **714ms**、中断 **12.5 秒**，恢复后状态流继续（17:44 起 kitchen/bath 每 ~5.5s 一行，无缺行）。

### 1.5 被忽略的裸探测（36–46 次，节奏 ~67–68s，来源全是 127.0.0.1）
```
[17:01:12.836] 忽略未识别的探测连接（::ffff:127.0.0.1:61808，未发送状态行；不计为节点接入）
[17:02:14.040] ... ::ffff:127.0.0.1:53793
[17:03:19.841] ... ::ffff:127.0.0.1:60794
 ...（每 ~67s 一条，直到）
[17:49:48.825] ... ::ffff:127.0.0.1:54540
```
代码依据（`mqtt_bridge.js:876-926`）：日志节流 60s、只看是否收到合法状态行；该日志**不是**故障。
同期 netstat 里 1883/9101/9001 三端口成对出现的 TIME_WAIT 三元组即该健康探针：
```
127.0.0.1:49821→1883 TIME_WAIT、49822→9101 TIME_WAIT、49834→9001 TIME_WAIT   （同一轮）
127.0.0.1:50457→1883、50458→9101、50464→9001 ... 每 ~68s 一轮
```

### 1.6 设计内的 relay 去重（不是故障）
```
[17:01:15.019] [bridge] 忽略板端连接上的 relay 回灌：esp32-bath（该 ID 由入站节点持有/刚被本机注入，不在此重复发布）
[17:44:19.211] [bridge] 忽略板端连接上的 --relay-ignore 设备回灌：esp32-sos（由板外链路直接注入 homemon，桥接不接管、不退休板端连接）
```

### 1.7 唯一一次命令下行（演示用 fall 注入，非传输故障）
```
[17:07:43.295] [MQTT] ← home/dayu200-living/cmd: {"cmd":"fall","evidenceId":"fall-1793120863100-na"}
[17:07:43.296] [bridge] 命令已写入节点 dayu200-living 的活动连接: fall fall-1793120863100-na
```

---

## 2. bridge.err.log 全量分析（**Lead 指定优先项**）

```
行数: 57（01:41 时为 49，仍在增长）  首 2026-10-27T17:03:17.578Z → 末 17:52:07.546Z
长度分布: min=125 max=125（全部等长 ⇒ 日志侧 slice(0,80) 截断，不代表报文长度）
deviceId 分布: esp32-sos × 57（100%）
行样例（逐字节原文，末 3 条）:
[17:50:xx] [bridge] 状态行解析失败: {"deviceId":"esp32-sos","room":"随身求助","ts":1793122893807,"state":"NORMAL","onlin
```

### 2.1 失败点定位（源码）
`bridge/mqtt_bridge.js:809`：
```js
s.on('data', (d) => {
  ...
  } catch (e) {
    logErr('[bridge] 状态行解析失败:', line.slice(0, 80));   // ← 809
  }
});
```
该 `data` 处理器属于 `attachNode(endpoint)`（765-826 行），即 **`--status-tcp 127.0.0.1:9001` 板端端点读分支**。
- 不是 `--listen 9101` 无线节点分支（那里的失败文案是 `[bridge] 无线节点报文解析失败:`，909 行）；
- 不是 `--relay-to` 注入通道（写方向，不解析）；
- 即：**板上 homemon 通过 fport 9001 广播给 bridge 的状态行**。

### 2.2 原始报文抓取（自建只读 TCP 观测，等价于 bridge 的第 3 个 fport 客户端）
命令（仅 connect + read，115 行内不写任何数据）：
```powershell
$c=New-Object System.Net.Sockets.TcpClient; $c.Connect('127.0.0.1',9001)
# 循环 $s.Read(...) 落盘 75s / 180s
```
产出：`transport\_tcp9001_raw.bin`（37703B / 76.4s）、`transport\_tcp9001_raw2.bin`（88676B / 180s）。
两段抓包按 LF 切分、逐行 `ConvertFrom-Json`：

```
_tcp9001_raw.bin : sos 帧=15  坏帧=1
_tcp9001_raw2.bin: sos 帧=34  坏帧=3
合计             : 49 帧 / 4 坏帧 = 8.2%（约 0.93 坏帧/分钟）
同期 bridge.err.log 同速率：57 条 / 49 分钟 ≈ 1.16 条/分钟
```

坏帧**只出现在 esp32-sos**（该行正常长度 **804 字节**，是全部广播行里最长的一类；kitchen 410 / bath 405 / dayu200-living 527 字节，0 例损坏）。

### 2.3 坏帧字节结构（决定性证据）
```
正常 esp32-sos 行长度 : 804
坏行长度             : 906（+102）、857（+53）、856（+52）
坏行括号数           : "{"=11, "}"=10  → 结构不平衡
```
把坏行的多余片段删掉后**逐字节恢复为合法 JSON**：
```
$b.Remove($p,102) | ConvertFrom-Json
→ 成功: deviceId=esp32-sos state=NORMAL ts=1793123044325      ← ts 与被 bridge 记录的同帧完全一致
```
坏行原文（节选，`⋯` 为省略）：
```
{"deviceId":"esp32-sos","room":"随身求助","ts":1793123044325,"state":"NORMAL","online":true,
 "lastSeen":1793123013298,...,"history":[0,0,0,0,0,0,0],"slots":[0,0,0,0],"source":"api",
 "firmware":"","csq":0,"mirror":{"source":"api","gpsSource":"n,0,0,0],"slots":[0,0,0,0],
 "source":"api","firmware":"","csq":0,"mirror":{"source":"api","gpsSource":"none",
 "eventGpsSource":"none","lastRejectCode":""}}
       ↑ 此处 "gpsSource":"n 之后直接插入了一段本行前面出现过的片段，然后才接回 "none"
```
另一类（+52/+53B）同样特征：
```
600-780 段: ..."mirror":{"source":"api","gpsSource":"e":"","csq":0,"mirror":{"s ...
```
插入片段在行内更早位置能找到同源窗口（`窗口[754,806) 与更早位置 702 重复`）→ **帧内字节重复/回绕**。

**排除的分帧假设**：行仍以 `\n` 正确结束、下一行解析正常（无级联污染）；无 `relay `/`route ` 前缀未剥离问题（坏帧开头直接是 `{`）；JSON 是纯 ASCII + 中文，无 UTF-8 截断字符；不是"两条 JSON 拼接"（是**同一帧内插入一段**）。

### 2.4 同一坏帧同时到达两个独立通道（定位到共享写出层）
```
我的抓包 : 坏行 ts=1793123044325
bridge   : [2026-10-27T17:44:14.135Z] 状态行解析失败: ..."ts":1793123044325,"state":"NORMAL","onlin
```
→ bridge 的 fport 通道与我新建的 fport 通道**收到完全相同的坏帧**（同一 ts）。损坏发生在"一次性广播给所有客户端"的上游，而不是各自通道的读侧。

### 2.5 上游写入端排查（谁把 esp32-sos 写进 homemon）
`cloud\wearable-mirror\src\transport.js`（relay 传输，PID 61116 实际使用）：
```js
88:  writeLine(line) {
 96:      this.socket.write(`relay ${line}\n`);      // 前缀正确、换行正确、单次写入
```
mirror 运行态 `cloud\wearable-mirror\runtime\mirror-status.json`（01:52 快照）：
```json
"transports":[{"kind":"relay","target":"127.0.0.1:9001","connected":true,
  "linesSent":624,"lastSentAt":1793123544583,"lastConnectedAt":1793120587500,
  "connects":1,"disconnects":0,"lastError":""}]
"emitCount":624,"changeEmitCount":101,"heartbeatEmitCount":523,
"sourceStatus":{"polls":1153,"ok":1153,"errors":0,"authFailures":0}
```
→ mirror 49 分钟内 **1 次连接、0 断开、0 错误、624 行发送**，发送侧帧完整。
`video\...\server.js --transport relay` 用的是另一套 WebSocket relay（帧边界由 WS 保证），本次 9001 连接是视频流通道，不写 esp32-sos 状态行。

板端广播代码 `southbound\src\homemon.c`：
```c
717: static int tcp_send_best_effort(int fd, const char *p, size_t n) {
721:     ssize_t w = send(fd, p + off, n - off, MSG_NOSIGNAL);
722:     if (w > 0) { off += (size_t)w; continue; }
723:     if (w < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
724:         return off == 0 ? 0 : -1;   /* 一点没写：丢弃本条不杀连接；写了一半：流已坏，关闭 */
726:     return -1;
731: static void tcp_broadcast(const char *line) {
733:     size_t n = strlen(line);
734:     for (int i = 0; i < MAX_CLIENTS; i++) {
740:         int r1 = tcp_send_best_effort(fd, line, n);
741:         int r2 = (r1 == 1) ? tcp_send_best_effort(fd, "\n", 1) : ...;
702: /* 2026-10-28：4→8。…4 路会被占满导致新连接被 accept 后立刻关闭 … */
706: #define MAX_CLIENTS 8
```
→ 广播是"整行一次 send + 单独发 `\n`"的**非阻塞尽力发送**；806 字节附近的长帧在 EAGAIN 半包路径上，`return -1` 后连接被 close（不会重发）。**帧内插入重复字节不是这段代码能产生的形态**（它只可能截断/丢弃，不会重复），因此损坏点更可能在 homemon 行组装缓冲或 hdc fport 的共享转发层；源码侧只能确认"长帧 + 非阻塞半包"是敏感路径。

---

## 3. broker 分析（PID 27820，活日志 broker-wifi.out.log）

```
监听 0.0.0.0:1883（自包含 MQTT broker，Ctrl+C 退出）
+ 连接来自 ::ffff:127.0.0.1:64547（当前 1 个）
CONNACK → bridge-dayu200-living-23091
SUBSCRIBE bridge-dayu200-living-23091 → home/+/cmd
PUBLISH home/dayu200-living/status (387B) → 转发给 0 个订阅者     ← 启动时无 status 订阅者
```
全量统计（8561 行）：
```
PUBLISH 行          6649
  转发给 0 个订阅者   110
  转发给 1 个订阅者  4502
  转发给 2+ 个订阅者 2037
+ 连接 / - 断开      904 / 931
CONNACK / SUBSCRIBE  39 / 37        ← 3.5 小时内仅 39 个 MQTT 会话，非连接风暴
协议错误/非法/半包    0
```
按主题：`home/dayu200-living/status` 2854、`esp32-kitchen/status` 2055、`esp32-bath/status` 1735、`home/dayu200-living/cmd` 5。
当前活日志尾部（`转发给 1 个订阅者` 为常态，偶发 `+ 连接（当前 3 个）/- 断开` 来自 teammate 的只读 sub）：
```
[broker] PUBLISH home/dayu200-living/status (527B) → 转发给 1 个订阅者
[broker] + 连接来自 ::ffff:127.0.0.1:56849（当前 3 个）
[broker] - 断开 -（当前 2 个）
```
订阅者清单（37 次 SUBSCRIBE，clientId）显示常驻只有 `bridge-dayu200-living-*`(home/+/cmd) 与 `home-cloud-gateway-*`(home/+/status)，其余 `tool-sub-*`/`lead-*`/`probe-*`/`monitor-*` 均为一次性只读工具。`bridge-dayu200-living-` 出现 ~10 个不同后缀 ⇒ 3.5 小时内 bridge 曾多次重连（本次 50.9 分钟窗口内为 0）。

---

## 4. TCP connect 探活（连即断，每端口 5 次）

```
PASS broker:1883  第1次   21 ms      PASS bridge:9101  第1..5次 均为 1 ms
PASS broker:1883  第2..5次 各 1 ms   PASS fport:9001   第1..5次 均为 1 ms
合计 15/15 PASS，成功率 100%，首连 21ms（DNS/TCP 建链），其余均为环回 1ms 量级。
```
副作用（已在 bridge 日志中体现，非故障）：对 9101 的 5 次探活被记为 5 条"忽略未识别的探测连接"。

---

## 5. netstat 三次采样（01:42 / 01:49:23 / 01:49:49）

```
=== 采样1（01:42）===
TCP 0.0.0.0:1883      LISTENING 27820
TCP 0.0.0.0:9101      LISTENING 46720
TCP 10.127.130.179:9101  10.127.130.71:61793   ESTABLISHED 46720   ← bath
TCP 10.127.130.179:9101  10.127.130.168:62780  ESTABLISHED 46720   ← kitchen
TCP 127.0.0.1:1883   127.0.0.1:61797           ESTABLISHED 27820   ← bridge
TCP 127.0.0.1:1883   127.0.0.1:55269           ESTABLISHED 27820   ← public-sync-worker 60936
TCP 127.0.0.1:9001   127.0.0.1:51362           ESTABLISHED 31928   ← video 61116
TCP 127.0.0.1:9001   127.0.0.1:61798/61799     ESTABLISHED 31928   ← bridge status-tcp + relay-to
=== 采样2（01:49:23）===
TCP 10.127.130.179:9101  10.127.130.71:50040   ESTABLISHED 46720   ← 端口已变（17:43:48 断线重连）
TCP 10.127.130.179:9101  10.127.130.168:59409  ESTABLISHED 46720   ← 端口已变
TCP 127.0.0.1:61797 →1883 / 61798,61799 →9001 / 51362 →9001 / 55269 →1883  全部与采样1一致
=== 采样3（01:49:49）===
与采样2逐行完全一致（零漂移）
```
→ bridge↔broker、bridge↔9001、video↔9001、public-sync↔broker 四条长连接**源端口全程不变**；唯一变化是无线节点在 17:43:48 事件后换端口重连。

---

## 6. 进程资源（无泄漏/无连接风暴线索）

```
采样1（01:42）  27820 broker    RSS 46.6MB  Handles 233  Threads 8   CPU 6.2s
                46720 bridge    RSS 55.0MB  Handles 211  Threads 8   CPU 4.6s
                31928 hdc       RSS 24.8MB  Handles 432  Threads 137
                60936 pub-sync  RSS 44.4MB  Handles 234  Threads 12
采样2（01:49:23）27820 46.4MB/231/8   46720 55.0MB/211/8   31928 25.9MB/435/137   60936 48.6MB/233/12
采样3（01:49:49）27820 46.5MB/231/8   46720 55.0MB/211/8   31928 26.1MB/438/137   60936 48.6MB/233/12
```
→ broker RSS 46.2–46.6MB 抖动 <1%，句柄 231 恒定；bridge RSS/句柄/线程零增长；hdc 句柄 432→438（+6，与探活次数相符）。无内存泄漏、无句柄泄漏、无连接堆积。

---

## 7. 端到端时延与抖动（MQTT 只读订阅）

### 7.1 带到达时间戳的 60s 抓包（`_mqtt_latency.log`，87 行，42 条报文）
到达时刻 - 报文 ts（ts 为板端/ESP32 epoch ms）：
```
esp32-kitchen   n=11  平均  52ms  最小  -94ms  最大 321ms  σ=141ms
esp32-bath      n=11  平均 -47ms  最小 -178ms  最大 157ms  σ=107ms
dayu200-living  n=20  平均 229ms  最小 222ms  最大 255ms  σ=9ms
```
→ kitchen/bath 的均值为负、dayu200 为 +229ms，说明这是**设备时钟偏差**（ESP32 两侧 ±50ms、板端 +229ms 且极稳定 σ=9ms），不是网络时延。扣除钟差后环回内时延在 **几十毫秒内**（单机 TCP+MQTT 环回）。

### 7.2 到达间隔（PC 侧实测，同一 deviceId 相邻报文）
```
esp32-kitchen   n=10  平均 5485ms  最小 5075ms  最大 5839ms  σ=260ms  抖动 4.7%
esp32-bath      n=10  平均 5496ms  最小 5207ms  最大 5825ms  σ=204ms  抖动 3.7%
dayu200-living  n=19  平均 3017ms  最小 2978ms  最大 3043ms  σ=14ms   抖动 0.5%
```
标称值 5s / 3s，60s 内 kitchen/bath 各 11 帧、dayu200 20 帧，**无丢帧、无超长缺口**（最大缺口就是一个正常周期）。

### 7.3 设备端 ts 的坑
`home/esp32-kitchen/status`、`home/esp32-bath/status` 在 **homemon 广播帧里 ts=0**（板端内部状态复述，无设备时间戳），只有 bridge 从无线节点收到后重新发布的那一份带真实 ts；`dayu200-living` 与 `esp32-sos` 带真实 ts。做时延统计时必须按来源区分，否则会出现 `-1793123007882ms` 这类伪值。

---

## 8. 风险面文档核对（`competition\docs\KNOWN-RISKS.md`）

- **P1 #3「HDC fport 会随连接消失」**（121-123 行）："保活 PowerShell 进程仍存在不代表 fport 规则仍有效。板端断开后 `hdc fport ls` 可能为空，Bridge 会持续重连但 APP 收不到无线状态。" → 与本次 17:43:48 双节点同断的失效形态同源（PC↔板端链路单点）。
- **P1 #4「DAYU 重启后系统时间回退」**：板端 epoch 不可信 → 本次实测 dayu200 ts 偏 +229ms 且稳定，当前可用，但该风险仍成立。
- **安全边界**（213-221 行）："MQTT 和设备通道当前没有鉴权、TLS 或消息签名；MQTT 使用 QoS 0，没有离线补偿保证；北向告警主要保存在内存" → QoS0 + 无 retain，订阅端瞬断即丢消息，恢复靠 bridge 的"重连后重放最后状态"（本次 50.9 分钟 0 触发）。
- bridge 源码 `mqtt_bridge.js:754-763` 注释亦明示"本自包含 broker 不实现 retain"。
- homemon `MAX_CLIENTS 8`（源码 702-706 行注释：曾因 4 路被僵尸占满导致新连接 accept 后立即关闭）→ 当前 fport 上稳定 3 连接 + 我的临时抓包 = 4，未接近上限，但探活/多终端增加时是既有风险。

---

## 9. 本目录下我产生的文件

| 文件 | 内容 |
|---|---|
| `_tcp9001_raw.bin` | 9001 原始广播字节流 37703B / 76.4s（含 1 个坏帧） |
| `_tcp9001_raw2.bin` | 9001 原始广播字节流 88676B / 180s（含 3 个坏帧） |
| `_mqtt_capture2.log` | `mqtt_tool sub home/#` 80s 输出（含完整 JSON 报文） |
| `_mqtt_latency.log` | 同一订阅 + 逐行到达时间戳 60s（用于时延/间隔统计） |
| `RAWMEMO.md` / `FINDINGS.md` | 本文件 / 结论 |
