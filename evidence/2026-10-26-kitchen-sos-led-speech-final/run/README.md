# RUN — 厨房/卫生间 SOS·LED·语音·ACK 真实验收取证工具包

证据目录：`competition/evidence/2026-10-26-kitchen-sos-led-speech-final/run/`
适用：两块 ESP32-S3（厨房 COM5 `esp32-kitchen`、卫生间 COM4 `esp32-bath`）的
“实体按键 → 本地语音 + LED → DAYU/APP 告警 → 用户 ACK → 设备 ACKED 回执”验收。

> **何时才能跑真采集**：只有在 Lead 明确通知“两板烧录完成、串口已释放、COM4/COM5 归采集使用”之后。
> 烧录/串口工具占用 COM4/COM5 时，本工具会明确报 **端口占用** 并退出码 2，不会静默丢数据。
> 采集与监测全程**只读**：不发串口字节、不 publish MQTT、不 ACK/reset、不重启任何服务。

当前现场状态（2026-10-26 21:03 只读核对）见 [FIELD-STATE-20261026-2103.md](FIELD-STATE-20261026-2103.md)。

---

## 1. 工具清单

| 文件 | 作用 | 是否只读 |
|---|---|---|
| `dual-serial-capture.ps1` | 同时打开 COM4+COM5（115200 8N1，DTR/RTS 先释放避免误复位），毫秒时间戳写 `bath.log` / `kitchen.log` / `merged.log` | 只接收，不发送 |
| `field-monitor.js` | 只读订阅 `127.0.0.1:1883` 的 `home/+/status`；周期快照 `bridge/status.json`、`supervisor/status.json`、`public-sync-supervisor.log`、DAYU watcher-state；可选跟随串口日志抽关键标记 | 只 CONNECT/SUBSCRIBE/PINGREQ，绝不 publish |
| `run-acceptance.ps1` | 一键：启动上面两个 + `events.csv` 事件时间线（按键记录）+ 结束小结/证据勾选表 | 只启动/停止自己拉起的子进程 |
| `FIELD-STATE-*.md` | 现场只读核对（端口/PID、bridge 连接、最近上报、202、fport、backend） | 只读 |
| `README.md` | 本文件 | — |

所有脚本均为 **Windows PowerShell 5.1** 兼容；`run-acceptance.ps1` / `dual-serial-capture.ps1`
带 UTF-8 BOM（PS 5.1 需要，否则中文乱码）。日志统一 UTF-8。

## 2. 前置只读检查（每次验收前 1 分钟）

```powershell
# 2.1 端口与 PID（不重启任何服务）
netstat -ano | findstr ":1883 :9101 :9001"

# 2.2 bridge 上两板是否在线（当前 bridge 的 status.json 只有最后一条上报）
Get-Content <WORKSPACE>\competition\bridge\status.json -Raw
# 期望：最近 mtime 是刚刚；deviceId/state/ts 新鲜。断开时 mtime 会停在离线时刻。

# 2.3 public-sync 最近 202 / 轮询是否健康
Get-Content <WORKSPACE>\competition\bridge\_test\current-runtime\supervisor\public-sync-supervisor.log -Tail 10
Get-Content <WORKSPACE>\competition\bridge\_test\current-runtime\supervisor\public-sync-supervisor.state.json -Raw
# 期望：出现新的 `[cloud-sync] OK device=esp32-...status=202`；`[command-sync] POLL_OK ... status=200` 每 60s 一条；state=HEALTHY

# 2.4 fport（PC 9001 → DAYU 9000）只读探测
& <WORKSPACE>\tools\hdc\hdc.exe list targets
& <WORKSPACE>\tools\hdc\hdc.exe fport ls
# 期望：target 450100445634303332012847942eca00 存在；`tcp:9001 tcp:9000 [Forward]`

# 2.5 APP/公网 backend 可达（匿名探测，不带密钥）
node -e "fetch('https://api.luxunacc.xyz/').then(r=>console.log('HTTP',r.status)).catch(e=>console.log('ERR',e.message))"
# 期望：HTTP 401（统一鉴权）＝服务可达；不能用 PowerShell 的 Invoke-WebRequest/curl 判断，
# 本机 schannel 会报 SEC_E_NO_CREDENTIALS，那是客户端限制不是后端故障。
```

**只有 2.2 出现新鲜的 `home/esp32-kitchen|bath/status` 上行、2.3 有新 202，才开始按键验收。**
南向断开的典型症状：9101 无 ESTABLISHED、`bridge/status.json` mtime 不更新、202 停止。

## 3. 推荐流程：一键验收（真采集）

> 前提：Lead 已通知串口释放；两板已恢复在线（§2 通过）。

```powershell
cd <WORKSPACE>\competition\evidence\2026-10-26-kitchen-sos-led-speech-final\run
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\run-acceptance.ps1 -Seconds 600
```

脚本会：
1. 只读预检 1883/9101/9001，并打印当前 `bridge/status.json` 与 `supervisor/status.json`（deviceId/state/ts/mtime）；
2. 启动 `dual-serial-capture.ps1`（COM4+COM5，只收不发）→ `out\serial\{bath,kitchen,merged}.log`；
3. 启动 `field-monitor.js` → `out\monitor\{mqtt-status,snapshots,ack-events,markers}.log`；
4. 打开 `events.csv`，等待操作者按键记录时间点；
5. 结束时停掉自己拉起的子进程，生成 `SUMMARY.txt`（含必查字段 `[OK]/[MISSING]` 勾选表）。

输出默认在 `run\logs\accept-<yyyyMMdd-HHmmss>\`，结构：

```
events.csv                 事件时间线（idx,elapsed_ms,wall_local,event,note）
serial\bath.log            卫生间串口（[毫秒本地时间] 原始控制台行）
serial\kitchen.log         厨房串口
serial\merged.log          合并时间线（[时间] [bath|kitchen] 行）
monitor\mqtt-status.log    home/<deviceId>/status 原始 JSON（带时间戳）
monitor\snapshots.log      status.json / public-sync 日志 / DAYU watcher 周期快照
monitor\ack-events.log     ACKED-OBSERVED / ALARM-ID-OBSERVED（含 deviceId、alarm.id、alarm.type）
monitor\markers.log        从串口日志抽出的 ACK/PLAY/LED/ALARM 关键行（若存在）
serial-console.log / monitor-console.log   子进程控制台（排查用）
SUMMARY.txt                结束时的小结 + 字段勾选表
```

### 操作者按键（在运行窗口里）

| 按键 | 记录事件 | 说明 |
|---|---|---|
| `k` | `KEY_KITCHEN_KEY0` | 按厨房实体 KEY0 的时刻（或准备按之前） |
| `b` | `KEY_BATH_SOS` | 按卫生间实体 SOS 的时刻 |
| `a` | `APP_ACK` | 在 DAYU 页面或手机 APP 点“确认/ACK”的时刻 |
| `l` | `OBS_LED` | 目视 LED 模式（如三短闪、常亮 0.8s、慢脉冲、熄灭） |
| `s` | `OBS_SPEECH` | 听到 SOS/告警语音 |
| `n` | `NOTE` | 输入一段备注（回车结束） |
| `Enter` | `EVENT_MARK` | 通用时间点 |
| `q` | 结束 | 立即结束事件窗口并出小结 |

建议顺序：`k`（或 `b`）→ 看三短闪 LED + 听 SOS 语音 → 等 APP/DAYU 出告警 → `a`（点 ACK）→ 看 LED 进入 ACKED → `l`/`s` → `q`。

## 4. 分步运行（需要单独调试时）

```powershell
# 4.1 双串口采集（只收不发）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\dual-serial-capture.ps1 `
  -BathCom COM4 -KitchenCom COM5 -Seconds 300 `
  -OutDir .\logs\dual-manual
# 负向自检：不存在端口 / 被占用（占用时会报“端口占用”并 exit 2）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\dual-serial-capture.ps1 -BathCom COM98 -KitchenCom COM99 -Seconds 2
# 离线自检（不占任何 COM）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\dual-serial-capture.ps1 -SelfTest

# 4.2 只读现场监测（不 publish）
node .\field-monitor.js --seconds 300 --out-dir .\logs\monitor-manual --serial-dir .\logs\dual-manual
node .\field-monitor.js --explain     # 只打印 ACK 链路与所需字段
node .\field-monitor.js --selftest    # 环回 broker 自检：真实 socket + 只读审计（不得出现 PUBLISH）
```

## 5. 每步要核对的证据字段（缺一不可）

| 字段 | 在哪里看 | 判定 | 说明 |
|---|---|---|---|
| `deviceId` | `monitor\mqtt-status.log` 的 `home/esp32-kitchen/status` / `home/esp32-bath/status`；bridge 日志 `→ home/<deviceId>/status` | 必须是**被按的那块板** | 不能拿厨房事件配卫生间回执 |
| `alarm.id` | 串口 ACK 回执行 `id=<alarmId>`；`monitor\ack-events.log` 的 `ACKED-OBSERVED ... alarm.id=...` | 触发/上行/ACK 回执**三处一致** | 固件只在 alarmId 精确匹配时才转 ACKED |
| `alarm.type` | 串口 `-> ALARM（...type=MANUAL_SOS）`；MQTT JSON `alarm.type` | SOS 必须是 `MANUAL_SOS` | 环境类另算（CLIMATE/GAS/SMOKE/WATER/NO_MOTION） |
| `state` | 串口 `state=ACKED`；MQTT `"state":"ACKED"`；`bridge/status.json` | ACK 前 `ALARM` → ACK 后 `ACKED` | `stop` 不是 ACK：stop 后 state 仍 ALARM |
| `PLAY clip=` | `serial\*.log` 中 `PLAY clip=N` | SOS=clip 1（环境类按固件 clip 2 等） | 只证明“请求播放”，同时要有目视/听到的旁证 |
| ACK 回执 | 串口 `ACK 回执已接受并生效（阶段③…）：id=<alarmId> type=<type> -> state=ACKED…` | 必须出现且 id 匹配 | 另有 `ACK 被拒绝：告警 ID 不匹配` 用于排查 |
| `LED 模式=` | 串口 `LED 模式=ALARM_BLINK / SOS_TRIPLE / ACKED_CONFIRM_PULSE / ACKED_RESOLVED_OFF / OFF` | SOS 三短闪；ACK 后 0.8s 常亮→慢脉冲或熄灭 | `stop` 后仍保持 ALARM_BLINK（只静音不停灯） |
| 云端闭环 | `public-sync-supervisor.log`：`[command-sync] ACK_SENT id=... device=...`、`[command-sync] ACKED id=... device=...` | 两条都要有，时间晚于按键 | 最后一条 `[cloud-sync] OK ... status=202` 证明 ACKED 状态入库 |
| 下行送达 | bridge 日志 `[bridge] 命令已写入节点 <deviceId> 的活动连接: ack <alarmId> …` | 有则更强 | bridge 无落盘日志时，用 `[command-sync] ACK_SENT/ACKED` + 串口回执代替 |

辅助旁证：`monitor\snapshots.log` 中 `SNAP dayu-watcher ... app=active ... cameraFrames=LIVE`（DAYU 应用在跑）、
`SNAP public-sync-last-202 ...`（最近 202 的时间与 deviceId）。
`run-acceptance.ps1` 的 `SUMMARY.txt` 会把以上字段自动勾成 `[OK]/[MISSING]`，但**最终一致性仍需人工核对**。

## 6. APP ACK 实际链路（源码核对结论，2026-10-26）

### 6.1 手机 APP / 小程序（公网）路径

```
APP → POST https://api.luxunacc.xyz/api/v1/alerts/{alarmId}/ack   （需要监护人会话，本工具不登录）
    → backend 命令队列（PENDING）
    → 本机 public-sync worker 轮询 GET /internal/v1/commands?after=<cursor>
        日志: [command-sync] POLL_OK path=/internal/v1/commands status=200
    → 严格校验 id/deviceId/alarmId/action 后 publish
        home/<deviceId>/cmd {"cmd":"ack","alarmId":"...","action":"..."}
        日志: [command-sync] ACK_SENT id=<commandId> device=<deviceId>
    → bridge 已订阅 home/+/cmd → routeCommand → 节点活动连接写入串口行
        ack <alarmId> <action>\n
        日志: [bridge] 命令已写入节点 <deviceId> 的活动连接: ack <alarmId> ...
    → 节点 handle_command：alarmId 精确匹配才 ACKED、静音、取消语音
        串口: ACK 回执已接受并生效（阶段③：监护人已确认）：id=<alarmId> type=<type> -> state=ACKED...
        串口: LED 模式=ACKED_CONFIRM_PULSE / ACKED_RESOLVED_OFF
    → 节点状态上行 home/<deviceId>/status state=ACKED（MQTT）
        日志: [bridge] → home/<deviceId>/status state=ACKED ...
    → worker 观测到同 deviceId、alarm.id 精确匹配、state=ACKED
        → POST /internal/v1/commands/<id>/result {status:"ACKED",deviceState}
        日志: [command-sync] ACKED id=<commandId> device=<deviceId>   ← 云端侧“设备真的 ACK 了”的铁证
    → 公网入库 202
        日志: [cloud-sync] OK device=<deviceId> ts=... status=202
```

### 6.2 DAYU 板载 APP 路径（不经过公网 backend）

```
DAYU APP 点“确认/ACK” → DAYU homemon（DAYU 9000，经 PC 9001 fport 转发）
    → bridge relay 通道收到 `route <deviceId> <cmd>` 行 → routeCommand()
    → 同一串口行 `ack <alarmId> <action>` 写入节点 → 之后的串口回执/状态上行同 6.1
```

补充事实：`bridge/mqtt_bridge.js` 对下行命令做白名单映射（ack/reset/stop/motion/sos/gas/smoke/fall/monitor），
非法 JSON 会记 `无法解析下行命令`；设备不在线时记 `拒绝下发：设备 <deviceId> 不在线…命令已丢弃`。
`mqtt_broker.js` **不实现 retain**，所以“最后状态”必须靠 `status.json`/日志快照，不能只订阅 MQTT。

## 7. 故障排查（不要用重启/补发数据掩盖问题）

| 现象 | 先核对 | 不要做 |
|---|---|---|
| 脚本报 **端口占用**，exit 2 | 烧录工具/串口助手/上次采集是否还占 COM4/COM5；`Get-Process` 看谁占用 | 不要强杀 Lead 的烧录进程；等 Lead 释放 |
| 9101 无 ESTABLISHED、`bridge/status.json` 不更新 | 板子是否在正常固件、供电、连 PC Wi-Fi；bridge 控制台是否出现“无线节点接入” | 不要改 Wi-Fi/固件、不要重启 broker/bridge |
| 有新串口日志但无新 202 | 设备上行是否到 bridge（bridge 日志 `→ home/.../status`）；public-sync worker 是否 `POLL_OK`；是否 `POLL_FAIL` | 不要手工 publish/ingest 凑 202 |
| `ACK 被拒绝：告警 ID 不匹配` | 下行 alarmId 与设备当前 alarm.id 是否同一事件；是否重复 ACK 旧告警 | 不要为“点绿”而 reset 后重造告警 |
| APP 点了确认但设备无反应 | 先看 `[command-sync] ACK_SENT` 是否出现；再看出现在 bridge“命令已写入节点”；再看 bridge 是否“设备不在线，命令已丢弃” | 不要重复点 ACK 或在 MQTT 手发 ack |
| backend 探测 401 | 401 是统一鉴权，代表**可达**；真正业务证据看 worker 的 `status=200/202` | 不要带 key 探测、不要把 key 写进日志/命令 |
| fport 断（9001 无监听/连接被拒） | `hdc list targets`、`hdc fport ls`；DAYU 是否在线 | 不要自行重建 fport/重启 homemon；交 Lead |

## 8. 工具自检（不占 COM4/COM5，可随时跑）

```powershell
# 双串口：离线自检（12 项）+ 端口不存在/同名端口负向（exit 2）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\dual-serial-capture.ps1 -SelfTest
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\dual-serial-capture.ps1 -BathCom COM98 -KitchenCom COM99 -Seconds 2

# field-monitor：环回 broker 自检（11 项：CONNECT/SUBSCRIBE/PUBLISH 解析、快照、ACKED 观察、只读审计）
node .\field-monitor.js --selftest
node .\field-monitor.js --port 1884 --seconds 2 --out-dir $env:TEMP\fm-neg   # 连接失败应 exit 2 且提示不重启 broker

# 一键验收：离线自检（16 项：CSV/证据提取/cloud since/小结勾选/TCP 预检）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\run-acceptance.ps1 -SelfTest
# 无串口演练（只读监测真实 broker + 事件记录）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\run-acceptance.ps1 -NoSerial -Seconds 30
```

## 9. 已知限制（如实记录）

1. 本会话沙箱下 `Get-Process -Id <pid>`/`tasklist` 对 broker/bridge/fport 进程可能 `Access denied`，
   FIELD-STATE 只记录 `netstat` 的 PID，不声称进程名。需要进程名时由 Lead 在正常窗口执行。
2. `field-monitor.js` 只在 `home/+/status` 上收状态；MQTT broker 无 retain，离线期间的历史状态只能从
   `status.json` 与 public-sync 日志还原。
3. APP 的 `/api/v1/alerts/{id}/ack` 需要监护人会话；本工具**不登录、不带密钥**，所以 APP 侧操作证据
   由操作者按键时间 + `[command-sync] ACK_SENT/ACKED` + 串口回执共同证明，不采集截图。
4. bridge 控制台日志当前未落盘到固定文件；若 Lead 提供 `-BridgeLog <path>`，小结会额外提取
   “命令已写入节点 …” 下行证据。
5. 本次未用 COM4/COM5 做正向测试（按要求不占用）；端口占用分支以单元测试覆盖，真实占用报错在实跑时会明确显示。
