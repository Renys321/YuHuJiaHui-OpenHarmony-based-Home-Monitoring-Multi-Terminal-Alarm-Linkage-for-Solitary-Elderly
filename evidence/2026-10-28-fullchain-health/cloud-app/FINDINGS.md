# 云与应用层体检 · 结论（FINDINGS）

> 体检窗：**2026-10-28 01:41~01:49（Asia/Shanghai）**，只读。原始证据见同目录 `RAWMEMO.md`。
> 判定口径：PASS=有直接证据且当前稳定；DEGRADED=能用但存在明确短板/证据不足/有过往故障；
> FAIL=当前不可用。
> 一句话结论：**云侧与应用侧"当下都稳"（48 分钟内云同步失败率 0.38%、无进程重启），
> 但"稳"依赖 3 个单点 + 1 个人工步骤；公网 ECS 挂掉不会毁掉本地演示，只会毁掉"云端大屏/多终端"叙事。**

---

## 1. 公网同步（public-sync-supervisor 32288 / worker 60936）

| # | 项 | 判定 | 证据 | 影响演示 |
|---|---|---|---|---|
|1.1|当前会话进程存活、心跳新鲜|**PASS**|`state.json`：`state=HEALTHY`、`heartbeatAt=1793123330870`（01:48:50，采样 01:49:04 → 心跳龄 14s，阈值 90s）；`public-sync-health.ps1` 输出 `healthy:true reason:HEALTHY`，`exit=0`；PID 32288/60936 自 01:01:12/01:01:20 起未变|无|
|1.2|当前会话 worker 重启次数|**PASS**|`restartCount=0`、`lastWorkerExit=null`；48min 内日志 0 条 `WORKER_EXIT/RESTART_IN/CIRCUIT_OPEN`|无|
|1.3|公网同步成功率（当前会话）|**PASS**|17:01:20Z→17:49Z 约 48min：`cloud-sync OK 264 / FAIL 1` = **失败率 0.377%**；`POLL_OK 47 / POLL_FAIL 2` = 4.08%；3 条失败全部秒级自愈（17:06:16 FAIL→17:06:20 OK；17:18:00→17:18:18；17:20:51→17:20:52）|无|
|1.4|worker↔ECS 47.76.70.118:443 持续性|**PASS**|worker(PID 60936) 两条常连接 `51104→47.76.70.118:443`、`60098→47.76.70.118:443`；TCP 握手 123/133/125ms；`GET https://api.luxunacc.xyz/healthz → 200` 123ms|无|
|1.5|数据新鲜度|**PASS**|最近成功：`17:48:57.997Z OK dayu200-living status=202`（采样前 7s）；三设备呈 30s 轮转上报（`gateway.js:44 DEFAULT_STABLE_INTERVAL_MS=30000`）；当前会话内无 >90s 同步空档|无|
|1.6|失败率历史全量|**DEGRADED**|全量 10-25→now：cloud-sync **OK 4491 / FAIL 1100（19.67%）**、POLL **OK 1170 / FAIL 1653（58.55%）**；集中在 10-26 10/11/13/15/16/18Z 与 10-27 07Z/16Z 的事故窗；失败码以 `SYNC_HTTP_ERROR`(953+557)、`ENOTFOUND`(574+170，DNS)、`SYNC_TIMEOUT`(344+114)、`ECONNRESET`(10+10) 为主|已恢复；但说明 4G/网络抖动会成片打断云同步|
|1.7|重启退避与熔断|**PASS（有界）**|历史 7 次 `WORKER_EXIT`（code=-1/0x40010004/0xC000013A 等），退避 1000/2000/5000ms；3 次/5min 触发 `CIRCUIT_OPEN`，仅保持 60s 后重试（`public-sync-supervisor.js:372-391`），非永久停摆|无|
|1.8|**"restartCount=0 就不曾重启"是假象**|**点名（口径陷阱）**|`restartCount` 是**单个 supervisor 进程内**计数，每次 supervisor 换代即归零。日志证明 supervisor 最近在 `2026-10-27T16:57:38Z`(pid 67276)、`17:01:12Z`(pid 32288) 连续换代（`STALE_LOCK_TAKEOVER dead_pid=...`），worker 也换过 7 次。当前"0 次"只代表 01:01:20 之后|看板/汇报禁止用 restartCount=0 表述"从未重启"|
|1.9|public-sync 无自愈闭环（关键运营风险）|**DEGRADED**|supervisor 启动必须人工在可见窗口输入 `INGEST_KEY`（`public-sync-supervisor.js:133-137,230-236`；`state=WAITING_FOR_KEY`）。历史已发生：`demo-autostart.log` 00:55:12~01:01:02 连续 4 次 "P0 不健康（STALE_LOCK/PORTS_DOWN）…拉起既有正式 P0 入口（key 需由用户输入）"，cloud 断流约 6 分钟|**演示中 supervisor 一死，云端同步就停到有人敲 key 为止**|
|1.10|broker 层转发日志|**FAIL（证据缺口）**|`broker.out.log` 最后写入 **10-27 22:29:33**（PID 27820 却是 22:29:42 启动），内容还是上一次实例的；当前 broker 无逐条发布日志，且历史内容全是"转发给 0 个订阅者"|告警"broker→订阅端"这一跳无法用日志自证（见 §5）|

---

## 2. 云端组件

| # | 项 | 判定 | 证据 | 影响演示 |
|---|---|---|---|---|
|2.1|`cloud\backend`（ECS）在线|**PASS**|`GET https://api.luxunacc.xyz/healthz → 200 {"ok":true,"service":"eldercare-cloud-backend"}` 123ms；数据面 `POST /internal/v1/device-status → 202`×264；命令面 `GET /internal/v1/commands → 200`×47|无|
|2.2|`cloud\wearable-mirror` 在线|**PASS**|`mirror-status.json`：`running=true online=true`，`updatedAt=1793123343467`（01:49:03，采样 -0s），`emitCount=505`，`fatalError=""`；`mirror.err.log` 2 字节空|无|
|2.3|mirror→云端 API 数据新鲜度|**PASS**|`sourceStatus.polls=1076 ok=1076 errors=0 authFailures=0 logins=1 lastError=""`（100% 成功）；`model.lastDeviceMsgAt`≈01:48:56|无|
|2.4|mirror→本地 relay 链路|**PASS**|`transports[0]`：`connected=true connects=1 disconnects=0 linesSent=505`（自 01:03:07 起 46 分钟零断线）|无|
|2.5|mirror 的"在线"出现过 10 秒抖动|**DEGRADED**|`mirror.log`：`01:46:17.725 online=false`、`01:46:19.911 online=false`、`01:46:27.604 online=true`（`offlineAfterMs=45000`，即云端快照 lastSeen 落后 45s 判离线）|APP 随身求助可能瞬间显示"离线"，演示话术需准备|
|2.6|`cloud\onenet`（public-sync 代码 + thing-model）|**PASS**|`thing-model.json`(7748B) / `thing-model.onenet-import.json`(25357B) 在位；`public-sync.js`+`cloud-sync.js`+`command-sync.js` 即当前 worker 执行体；`cloud-sync.js:23 DEFAULT_TIMEOUT_MS=5000`、**无内部重试**（靠下一周期）|无|
|2.7|`cloud\wearable-mqtt`（ECS:1883）在线|**DEGRADED（证据不足）**|仅能证端口：`47.76.70.118:1883 TCP connect OPEN 109ms`；本地无该服务进程/状态/日志（它是 docker 部署在 ECS），本次无法读其健康端点|若现场被问"穿戴 MQTT 直连"，只有端口级证据|
|2.8|**公网 ECS 单点**|**DEGRADED（架构性）**|`api.luxunacc.xyz` DNS 只有 **1 条 A 记录 = 47.76.70.118**；同一台机同时承载 `443`(backend/Caddy) + `1883`(wearable-mqtt) + `80`；`9002/8443` 不通；无备用域名/第二可用区|ECS 挂 → 云同步停、mirror 停更、wearable-mqtt 断；**本地 broker/bridge/relay/video 不受影响**（视频实测走 local 模式，不经 ECS）|

---

## 3. APP 侧观测链路

| # | 项 | 判定 | 证据 | 影响演示 |
|---|---|---|---|---|
|3.1|watcher 状态文件在刷新|**PASS**|四连采样 `01:39:39 / 01:45:59 / 01:48:12 / 01:48:57`，`watcherPid=38176` 稳定；写盘周期 2s（`demo-autostart.ps1:583`）|无|
|3.2|`targetConnected` 来源|**PASS**|`Ensure-Hdc`→`hdc list targets` 含 `450100445634303332012847942eca00`（实测这两行目标都在）；2s 刷新|无|
|3.3|`app` 字段|**DEGRADED（语义漂移）**|来源=`pidof com.dsh.eldercare` + UI 文本正则（`active` 需文本含「暂停监护\|监护运行中」，`:278/:323`）。01:39:39 是 `active`，01:45:59 起是 `present`——**原因是 APP 停在随身求助详情页，那行文本不在**，非掉线；板端 `ps` 证 APP PID 27321 自 00:00:04 连续运行|看板会从 active 掉到 present，容易被误读成"APP 挂了"|
|3.4|`inference` 字段|**PASS**|`pidof dayu_local_fall`+`readlink /proc/PID/exe` 命中 demo 目录 + `netstat 127.0.0.1:9200 LISTEN`（`:389-393/:444`）；实测 PID 2379 LISTEN 中，start 10-27 11:57:41（已 14h，CPU 95%）|无|
|3.5|`cameraFrames=LIVE` 的**真实含义**|**DEGRADED（口径陷阱）**|LIVE = "`demo-events.jsonl` 行数在 8s 内增长"（`:563-569`），**不等于 APP 画面在播**。实测事件 1.53 条/s、文件 202MB/mtime 01:46；而视频 relay 当前 `viewers=0`、`dayuLink=down`|"cameraFrames=LIVE"≠"摄像头画面已在 APP 上显示"|
|3.6|`nodes=4/4` 的**算法口径**|**DEGRADED（点名，证据最弱）**|`nodes` 是**从 APP 自己的 UI 文本里正则抓的字符串** `全屋在线 (\d+)/(\d+) 台设备`（`:274-275`），当前 dump 原文 `"随身求助 · 全屋在线 4/4 台设备"`。分母是 APP 认知的 4 台（客厅/厨房/卫生间/随身求助），**没有任何逐链路探测**；刷新最慢 30s（`:554`），且随 APP 换页/滚动而缺值|ESP32 真断线时最多 30s 才可能变，且 APP 若不在该页/文本变体不同就抓不到|
|3.7|`ui-last.json` 持续更新|**PASS**|mtime 四连：`01:45:36 → 01:46:46 → 01:47:59 → 01:48:33`（size 95→107KB），`uitest dumpLayout` 每次全量重写|无|
|3.8|近 10 分钟 app 掉线/重启/黑屏|**PASS**|`demo-autostart.log` 最后一条 `[2026-10-28 01:08:10] Bringing formal app to foreground`，此后 40 分钟零日志（无 P0 不健康/无拉起/无 hdc 掉线）；板端 APP PID 27321 start `00:00:04`（1h49m 未重启）；UI 树正常渲染（`bundleName=com.dsh.eldercare`，状态栏 `01:46`、电量 `11%`）|无|
|3.9|APP 宿主|**DEGRADED（单点）**|APP 跑在 DevEco 模拟器 `Emulator.exe`（PID 34920，Mate 90 Pro，start 昨天）里；模拟器/PDevEco 一挂，APP 全没|演示 PC 上再加一个单点|
|3.10|APP 电量 11%|观察项|UI 状态栏 `11%`（模拟器电量模拟）|若现场大屏截到"11%"格不太好，但不影响链路|

---

## 4. 视频 / 推理

| # | 项 | 判定 | 证据 | 影响演示 |
|---|---|---|---|---|
|4.1|`inference=running` 有真实证据|**PASS**|板端 `ps`：PID 2379 `dayu_local_fall --serve 127.0.0.1:9200 --duration 86400 --threads 4 --size 320 --conf 0.7`（start 10-27 11:57:41，CPU 95%，累计 CPU 13:11:03）；`netstat` LISTEN 127.0.0.1:9200；`demo-server.log` 有 listening banner|无|
|4.2|帧/推理吞吐真实|**PASS**|`demo-stats.jsonl` 某段：`elapsedSec=1320.9 framesReceived=2851 framesInferred=2022 framesDropped=828 errors=0 inferMsP50=605 inferMsP95=655` → 收帧 2.16fps、推理 1.53fps；与事件文件增速 1.53 条/s 完全吻合|无|
|4.3|事件时间戳新鲜|**PASS**|`demo-events.jsonl` 202,636,941B / 163,475 行 / mtime 01:46；末条 `frameTsMs=1793123216673`、`eventTsMs=1793123217656`（01:46:57）；`personCount=1 trackId=t606 fall=false`|无|
|4.4|丢帧率|**DEGRADED**|`framesDropped 828/2851 = 29%`（320 输入、4 线程、p50 605ms 对 2.16fps 输入）|不黑屏，但算力余量小；并发看视频/推理叠加时最先掉帧|
|4.5|`demo-stats.jsonl` / `demo-server.log` 能否当实时看板|**DEGRADED（点名）**|`demo-stats.jsonl` mtime **10-26 00:53**（7 行）、`demo-server.log` mtime **10-27 11:57**（105B 仅 banner）→ 两个文件都是"一次性写入"，**不能用来证明当前推理在跑**；唯一实时证据是 `demo-events.jsonl` 的行数增长|汇报别拿 stats 文件当实时指标|
|4.6|视频 relay 链路（按需观看）|**PASS**|PID 68808 local 模式 `0.0.0.0:9443`，start 01:16:28，`relay-ip-fix.err.log` 0 字节。实测两次真实会话：`01:17:14` `dayu hello device=dayu200-living camera=320x240 cameraActive=true`、`firstFrameAfterMs=402`、`framesSent=40 dropped=0`；`01:31:05` `firstFrameAfterMs=643`、`framesSent=15 dropped=0`|点开摄像头 → 首帧 0.4~0.6s，可用|
|4.7|视频当前"看起来 down"|**PASS（解释清楚即可）**|`GET /video/healthz → {"ok":true,"mode":"local","dayuLink":"down","framesReceived":77,"fps":0,"lastFrameAgeMs":1070899,"viewers":0}`。无人观看 + `idleStopMs=3000` → 主动断开 DAYU，是设计行为（README 明示），不是故障|演示前先点一次摄像头预热，避免评委看到第一秒的黑屏|
|4.8|视频是否走公网 ECS|**事实澄清**|当前跑 **local 模式**：`DAYU200 VideoStreamServer(10.127.130.132:9301, 320x240 JPEG) → PC relay 9443 → WS → APP`；`deploy\video\`（compose.video.yaml/Caddyfile/install-on-ecs.sh）是 ECS **agent 模式**部署件，**本次未启用**。`hdc fport ls` 当前只有 `tcp:9001→tcp:9000`（9301 映射不在，但 relay 直连板端 Wi-Fi IP，不影响）|视频不走 ECS → ECS 单点不影响视频；但也意味着"公网远程看家"叙事要靠 ECS 版部署，本次未验证|
|4.9|板端 9001 连接抖动|**DEGRADED（跨层提请）**|`/data/homemon/homemon.log` 尾部每 ~10s 出现 `TCP 客户端接入/断开（第 6 路）`（1793123198→1793123296 持续）；常连接只有 bridge 2 路 + mirror 1 路|交传输层判定，可能影响长稳观察|

---

## 5. 告警推送链路（用 01:07:43 的真实 FALL 告警复现，未注入）

| # | 跳 | 判定 | 证据 |
|---|---|---|---|
|5.1|板端产生告警|**PASS**|`/data/homemon/status.json`：`state=ALARM`，`alarm={id:"a-1793120863-1", type:"FALL", countToday:1, evidenceId:"fall-1793120863100-na"}`；`say.log` `2026-10-28 01:07:43 say.sh 被调用` + `aa start 结果(rc=0)`（当刻 TTS 播报成功）|
|5.2|板端 → bridge|**PASS**|`bridge.out.log` 首条：`[2026-10-27T17:07:45.069Z] [bridge] → home/dayu200-living/status  state=ALARM room=客厅 countToday=0`（告警后 2.1s 进桥）|
|5.3|bridge → broker（发布）|**PASS**|同上 `→ home/...` 行即 publish；该状态每 ~3s 重发，至 01:47:51 共 **933 条**（40 分钟内）|
|5.4|broker → 订阅端|**FAIL（无法取证）**|`broker.out.log` 停在 10-27 22:29:33，无实时逐条日志。此跳只能靠"worker 侧 `LOCAL_SUBSCRIBED topic=home/+/status` + 当前会话 0 条 REJECT"间接支持|
|5.5|worker → 云端|**PASS**|`[cloud-sync] OK device=dayu200-living ... path=/internal/v1/device-status status=202`（30s 节流；告警状态 40 分钟内被反复 202 接收）|
|5.6|云端 → APP|**DEGRADED（部分证据）**|mirror/APP 均从 `api.luxunacc.xyz` 取数：`polls=1076/ok=1076`；APP UI 明文 `最近上报: 刚刚 · 数据来源: api`、`数据来源: 随身 SOS 镜像（api）`。**但告警卡片本身**未取证（见 5.7）|
|5.7|**告警呈现不一致（必须人工确认）**|**DEGRADED（点名）**|板端与 `supervisor\status.json` 一直是 `state=ALARM / FALL`，且 `monitorOnline=-1`、`motion.reason=not_configured`、`climate.valid=false`、`gas/smoke raw=0`；而 APP UI 实测文本是 **「一切正常」「告警状态: 正常」「无进行中事件」**。即"设备侧 latched ALARM"与"APP 侧一切正常"两套状态并存，本次只读无法点开「预警处置」页核对（点按会改 UI 状态，属禁止动作）|演示前一分钟用人工点一次"预警处置"确认真实呈现；否则评委若对比板端绿灯/云端口径会看到矛盾|
|5.8|多终端推送（短信/APNs/微信）|**未能验证**|推送实现只在 `cloud\backend\src\notify-*.js`，运行在 ECS，本地无实例/无日志|现场若要演示"多终端告警"，先确认该通道另行验收过|

---

## 6. 云侧 / 应用侧稳定性总判断

**云侧：稳定（当前 48 分钟）。**
- 公网同步失败率 0.377%（264 成功 / 1 失败），POLL 4.08%，全部秒级自愈；
- ECS backend `/healthz` 200、`202` 持续、`200` 轮询持续；mirror 1076/1076 轮询全成功、relay 46min 零断；
- 但**历史不干净**（全量失败率 19.67% / 58.55%，全部集中在 10-26、10-27 的 8 个事故小时），且
  **重启需要人工输入 INGEST_KEY**，这是云侧唯一的"不可自愈"环节。

**应用侧：稳定（当前 48 分钟）。**
- watcher 2s 刷新、四连采样字段一致；APP PID 自 00:00:04 未重启；inference 自 10-27 11:57:41 未重启（14h）；
- `ui-last.json` 持续更新；01:08:10 之后 40 分钟零事件日志（无掉线/重启/黑屏迹象）；
- 弱点全在"口径"不在"运行"：`nodes=4/4` 是 APP 文本、`cameraFrames=LIVE` 只等于"事件文件在长"、
  `app=present` 与 `active` 只是 UI 文本差异、`restartCount=0` 是进程内计数。

---

## 7. 公网 ECS 单点 / 4G 抖动对演示的影响（明确回答）

### 7.1 公网 ECS 单点（47.76.70.118，DNS 单 A，一机承载 443+1883+80）
- **不影响**：本地 broker(1883) → bridge → 板端链路；本地视频 relay(9443，local 模式直连板端 9301)；
  APP 的本地实时状态/视频；watcher 的 P0 健康判断（它只看本地 1883/9101 + supervisor 进程）。
- **会影响**：① `public-sync` 的 202 上报停 → 云端设备状态停止刷新（本地看板照常）；
  ② wearable-mirror 的 api 轮询失败 → APP「随身求助」的"最近上报"变旧，45s 后翻成"离线"；
  ③ `47.76.70.118:1883` 的 wearable-mqtt 断 → 穿戴设备的公网直连通道消失；
  ④ 云端页面/多终端演示中断。
- **结论**：ECS 单点**不会毁掉"现场单机演示"**（本地链路闭环），但会**毁掉"公网/多终端/云大屏"叙事**，
  且恢复要靠 ECS 侧运维，演示现场无法自救。

### 7.2 4G / 网络抖动
- 有实证：历史 8 个事故小时出现 `ENOTFOUND`(DNS)+`SYNC_TIMEOUT`(5s 超时)+`SYNC_HTTP_ERROR` 成片失败；
  今天同一小时只剩 3 条（17:06/17:18/17:20），且**秒级自愈**。
- 抖动时的可观察表现：云端状态延迟 30~60s；APP「最近上报」由"刚刚"变旧；mirror 会发 `online=false`
  （今天 01:46:17~01:46:27 已实测出现过一次 10 秒 window）。
- **结论**：4G 抖动只让"云侧数据变旧/短暂离线"，**不中断本地演示**；若演示脚本要求"云端实时性"，
  建议把数据面主链路明确说成"本地优先、云端同步"，并在抖动时用"最近上报 xx 秒前"话术兜住。

### 7.3 演示期间最脆的 3 个点（按风险排序）
1. **supervisor 换代后必须人工输入 INGEST_KEY**（`WAITING_FOR_KEY`）→ 云端同步停摆，且状态文件可能仍写 HEALTHY（历史 00:55~01:01 已发生 6 分钟断流）。
2. **公网 ECS 单点**（单 IP + 单机 443/1883/80）→ 云侧能力全押它，无备用入口。
3. **`state=ALARM`（FALL, latched）与 APP「一切正常/无进行中事件」并存** → 评委现场对比会问"到底有没有告警"，需演示前人工确认呈现口径。

---

## 8. "状态好看但证据不足"字段清单（点名）
| 字段 | 声称 | 实际证据强度 |
|---|---|---|
|`nodes = 4/4`|"全屋 4 台设备全在线"|**最弱**。来源是 APP UI 文本正则 `全屋在线 X/Y 台设备`，无逐链路探测；分母由 APP 决定；最快 30s 刷新；APP 不在该页或文本变体即抓不到|
|`cameraFrames = LIVE`|"摄像头帧正常"|**中**。只证明板端 `demo-events.jsonl` 行数在长（=推理在写事件），**不证明 APP 画面在播**（实测 relay `viewers=0`）|
|`app = present/active`|"APP 正常运行"|**中**。present/active 的差别只是"UI 文本里有没有『暂停监护\|监护运行中』"，换页即变；真正的存活证据是 `pidof` + `ps` 里 PID 27321 的启动时间|
|`restartCount = 0`|"从未重启"|**假象**。单进程内计数，supervisor 换代归零；日志里有 7 次 WORKER_EXIT + 多次 STALE_LOCK_TAKEOVER|
|`p0 = healthy`|"P0 全链路健康"|**中**。只覆盖 本地 1883/9101 + supervisor 进程/心跳；不含公网同步成功率、不含云端、不含 APP|
|`state = ALARM`（板端/桥接）|"客厅在告警"|**矛盾**。`countToday=1`、传感器全部 0/未配置、`monitorOnline=-1`，APP 侧显示"一切正常/无进行中事件"|
|`wearable-mqtt 在线`|"穿戴 MQTT 可用"|**仅端口级**（ECS:1883 OPEN），无健康端点/无本地日志|
|`demo-stats.jsonl`（若被引用）|"推理实时统计"|**不可用**。mtime 停在 10-26 00:53，是历史段文件；实时只能用 events 行数增量|

---

## 9. 建议（只读体检能给出的、不改动现场的动作）
1. **演示前 1 分钟**：人工点开一次「客厅摄像头」让 relay 预热（首帧 0.4~0.6s），并点一次「预警处置」核对 `state=ALARM` 的真实呈现口径。
2. **不要关闭/最小化 01:01 那个 supervisor 可见窗口**；确认 `INGEST_KEY` 输入框就在前台（这是唯一人工环节）。
3. 汇报口径替换：`restartCount=0`→"当前会话 48 分钟 0 重启"；`nodes=4/4`→"APP 汇总显示 4/4，本地链路另有证据"；
   `cameraFrames=LIVE`→"板端推理持续产出 1.53 条事件/s"。
4. 云侧话术兜底：把公网 ECS 定位为"云端同步/多终端"，明确"本地闭环优先"，避免把单点当卖点。
