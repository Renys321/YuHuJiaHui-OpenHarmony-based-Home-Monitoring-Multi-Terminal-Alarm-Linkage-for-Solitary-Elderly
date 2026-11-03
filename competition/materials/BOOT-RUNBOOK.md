# 从开机到演示就绪 · 完整启动流程

- 适用：比赛/演示现场，PC 冷启动后的标准恢复流程
- 依据：`materials/start-demo-full.ps1`（v3 一站式入口）、`materials/start-demo-supervisor.ps1`、`materials/demo-autostart/demo-autostart.ps1`、`video/relay/README.md`、`cloud/wearable-mirror/scripts/start-mirror.ps1` 实际代码
- 目标状态：`p0=healthy`、`nodes=4/4`、`inference=running`、`cameraFrames=LIVE`、手机 APP 4 房间在线

> **2026-10-29 更新（现场必看）**
> - 推荐入口改为双击 **`start-demo-full.cmd`**：自动做预检、重建 hdc 映射（9001/rport 9200/9301）、P0、板端页面、视觉（带 `--ground-zone 0,0.55,1,1`）、视频 relay、随身 mirror，并做验收；
> - 板子重启/换 USB 口后 **hdc 映射必丢**，入口会自动重建；DAYU200 按序列号识别，与 COM 口号无关；
> - 视频 relay 已把帧下限从 4096 降到 **1024**（暗场景 JPEG 只有 ~2.4KB）；若 9443 被旧进程占用，重启 relay 才生效；
> - supervisor 窗口每次重启都要重新输 `INGEST_KEY`；输错会"看健康但云端 401"，用验收里的"最近 90 秒有 202"识别；
> - 厨房 ESP32 串口改为 **COM14**；该板近期疑似硬件故障（无 UART 响应），演示前用备用板烧 `firmware/kitchen` 顶替；
> - DAYU200 PIR 已启用（`motion_gpio=117,114`，NO_MOTION 可用）。

---

## 0. 架构与启动依赖（先理解，再操作）

```
[DAYU200 板]  homemon(9000) ──USB/hdc fport──> PC bridge(9101) ──MQTT──> broker(1883)
             板载 APP ← homemon                          │
             推理 dayu_local_fall(9200) → events.jsonl   ├─→ public-sync worker ─HTTPS→ ECS(api.luxunacc.xyz)
             视频流 9301                                 └─→ 手机 APP（经云）
[ESP32 厨房/卫生间] ──WiFi/TCP──> PC bridge:9101（固件里写死网关，见 §1.3）
[PC]  wearable-mirror → 板端 9001（随身求助注入）
      video relay(9443) → 板端 9301（可选）
      手机模拟器 APP（com.example.program_04）
```

**依赖顺序（违反就会先失败）**：
1. 网络/供电 → 2. DAYU USB 在线 → 3. homemon + hdc fport → 4. broker → 5. bridge → 6. public-sync（要 key）
→ 7. 板载 APP/推理（watcher 自动）→ 8. mirror / 视频 relay（手动，可选）→ 9. 手机 APP（模拟器 + 登录）

`start-demo-supervisor.cmd` 会把 2–6 自动按序做完；watcher 负责 7 并守护 3/4/5/6。

---

## 1. 开机前/上电（Phase 0）

| # | 动作 | 检查 |
|---|---|---|
| 1 | 开启 WiFi AP `ElderCareLab`（2.4G） | 手机/PC 能连；SSID 不能改名（ESP32 固件写死） |
| 2 | 给两块 ESP32 上电 | 厨房 `10.127.130.168`、卫生间 `10.127.130.71` 能 ping 通 |
| 3 | DAYU200 上电 + **USB 数据线**接 PC | `hdc list targets` 出现 `4501004456...` |
| 4 | PC 开机联网 | **WLAN IPv4 必须是 `10.127.130.179`**（见 §1.3） |
| 5 | （可选）启动 DevEco 模拟器 | `127.0.0.1:5555` 在线；模拟器名 `Mate 90 Pro` |

### 1.3 最容易踩的坑：PC IP 漂移
ESP32 固件里写死 `CONFIG_NODE_GW_HOST="10.127.130.179"`、端口 9101（`sdkconfig.h` 实测）。
**PC 的 WLAN IP 一旦被 DHCP 换成别的地址，两块 ESP32 会全部连不上，且不会自动恢复。**
开机先查：

```powershell
(Get-NetIPConfiguration -InterfaceAlias 'WLAN').IPv4Address.IPAddress
```

不是 `10.127.130.179` → 先给路由器做 DHCP 保留，或把该网卡配静态 IP（否则需要重新烧固件，见 §5）。

---

## 2. 只读预检（Phase 1，可选但推荐）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File <WORKSPACE>\competition\materials\start-demo-supervisor.ps1 -Preflight
```

- 只读：不启动、不修改任何东西。
- 输出 `PREFLIGHT PASS` 再进下一步；`PREFLIGHT BLOCKED` 会指出缺什么（hdc 目标、homemon、fport、端口占用等）。

---

## 3. 正式入口：一键起 P0（Phase 2）

**双击** `<WORKSPACE>\competition\materials\start-demo-supervisor.cmd`
（等价：`start-demo-supervisor.ps1 -AutoDayuEndpoint`）

它按顺序做：
1. 解析 DAYU 端点（USB 优先走 fport `127.0.0.1:9001`；USB 不在线则自动用板端 WLAN IP:9000）
2. 校准 DAYU 时钟（仅漂移超阈值时写）
3. 校验并启动板端 `homemon`（哈希必须是冻结版）
4. 建立 `hdc fport tcp:9001 → tcp:9000`
5. 启动 **Broker 1883**（若未监听）
6. 启动 **Bridge 9101**（后台隐藏窗口，日志 `bridge\_test\current-runtime\supervisor\`）
7. **提示输入一次隐藏的 `INGEST_KEY`** → 启动 public-sync supervisor + worker

> ⚠️ **这个窗口从头到尾不要关**。关掉 = 杀 supervisor = 云端同步停，且状态文件可能还显示 HEALTHY。
> 若已有 supervisor 在跑，入口会打印 `[reuse]` 并退出 0（拒绝第二实例）。

成功标志（窗口里会打印）：
```
[ok] fport 127.0.0.1:9001 可用
[ok] DAYU homemon 已启动
=== 结构检查通过，启动 supervisor ===
（输入 key 后）state=HEALTHY workerPid=xxxx
```

---

## 4. 守护进程（Phase 3）

**双击** `<WORKSPACE>\competition\materials\start-demo-all.cmd`
（运行 `demo-autostart.ps1`，每 2 秒一轮）

它负责：
- 检查 P0 五要素（端口 1883/9101、supervisor PID、worker PID、state=HEALTHY、heartbeat≤90s）
  → 不健康时**自动新开一个窗口**拉起 `start-demo-supervisor.cmd`（需要你在新窗口输 key）
- `Ensure-Hdc`：hdc 目标丢失时每 30s 重启 hdc 服务
- `Ensure-Homemon`：homemon 挂了自动拉起
- `Ensure-Fport`：fport 规则丢了立刻重建
- `Ensure-App`：板载 APP（com.dsh.eldercare）没跑就拉起
- `Ensure-Inference`：`dayu_local_fall` 没跑就拉起
- 每 30s 抓一次板载 APP UI，写 `evidence\2026-10-26-demo-autostart\runtime\watcher-state.json`

**这个窗口也不要关**（关掉就失去全部自愈能力）。

---

## 5. 随身求助 mirror（Phase 4，必须）

板载 APP 里的「随身求助」状态来自 mirror 注入，**不启动 mirror 就没有这一路**。

```powershell
# 先 dry-run 看解析出的端点与将执行的命令
powershell -NoProfile -ExecutionPolicy Bypass -File <WORKSPACE>\competition\materials\start-mirror-dayu.ps1
# 确认无误后真正启动
powershell -NoProfile -ExecutionPolicy Bypass -File <WORKSPACE>\competition\materials\start-mirror-dayu.ps1 -Apply
```

验证：`cloud\wearable-mirror\runtime\mirror-status.json` 里 `running=true`、`transports[].connected=true`、`linesSent` 递增。

---

## 6. 视频 relay（Phase 5，按需）

只有要演示"视频探望"才需要。当前跑 **local 模式**：relay(9443) 直连 DAYU 的 9301。

```powershell
cd <WORKSPACE>\competition\video\relay
$env:VIDEO_RELAY_PORT='9443'
$env:DAYU_HOST='10.127.130.132'   # DAYU 板 WiFi IP；或用 hdc fport 9301→9301 后填 127.0.0.1
$env:DAYU_PORT='9301'
D:\Node\node.exe server.js
```

健康检查：`GET http://127.0.0.1:9443/video/healthz` → `ok:true`。没人观看时 `dayuLink=down` 是**正常状态**（空闲自动断开）。

---

## 7. 手机 APP（Phase 6）

1. 启动模拟器（若未随 DevEco 启动）：
   ```powershell
   & 'D:\DevEcoStudio\DevEco Studio\tools\emulator\Emulator.exe' -start "Mate 90 Pro" -instancePath "$env:LOCALAPPDATA\Huawei\Emulator\deployed" -imageRoot "$env:LOCALAPPDATA\Huawei\Sdk"
   ```
2. 确认目标：`hdc list targets` 出现 `127.0.0.1:5555`
3. 启动 APP：
   ```powershell
   & <WORKSPACE>\tools\hdc\hdc.exe -t 127.0.0.1:5555 shell "aa start -a EntryAbility -b com.example.program_04"
   ```
4. **登录**：APP 的会话只存在内存（登录页"记住登录状态"默认不勾选），
   模拟器/APP 重启后必须重新登录。账号口令在 `competition\.secrets\app_guardian.txt`（不入镜像、不外发）。
   > 建议演示时手动勾选"记住登录状态（系统安全存储）"，避免中途掉登录。

---

## 8. 就绪验收（Phase 7，30 秒）

```powershell
# 1) 总状态
Get-Content <WORKSPACE>\competition\evidence\2026-10-26-demo-autostart\runtime\watcher-state.json
# 期望: p0=healthy  nodes=4/4  inference=running  cameraFrames=LIVE

# 2) hdc 隧道
& <WORKSPACE>\tools\hdc\hdc.exe fport ls        # 期望 tcp:9001 tcp:9000 [Forward]
& <WORKSPACE>\tools\hdc\hdc.exe list targets    # 期望两个目标都在

# 3) 两个无线节点
Get-NetTCPConnection -State Established | Where-Object LocalPort -eq 9101

# 4) 三路数据在流动（10 秒）
D:\Node\node.exe <WORKSPACE>\competition\bridge\mqtt_tool.js sub --broker 127.0.0.1:1883 --topic "home/#" --seconds 10
# 期望看到 home/dayu200-living/status、home/esp32-kitchen/status、home/esp32-bath/status

# 5) 云端同步
powershell -NoProfile -ExecutionPolicy Bypass -File <WORKSPACE>\competition\materials\public-sync-health.ps1
# 期望 healthy:true
```

手机 APP 侧：首页应显示 `4 个房间 · 4 台受监护设备`，实时监测页有燃气/烟雾原始 ADC。

---

## 9. 常见故障对照（开机阶段）

| 现象 | 原因 | 处理 |
|---|---|---|
| ESP32 两个都不上线（9101 无连接） | **PC IP 不是 10.127.130.179**、AP 改名、或 ESP32 没上电 | 先查 §1.3；再看 9101 是否有半开连接 |
| 只有一个房间在线 | 单块 ESP32 掉电/WiFi 未连 | 重新上电；等 15–30s 自动重连（会重启、计数清零） |
| `PREFLIGHT BLOCKED: fport` | hdc 目标不在 / fport 未建 | 查 USB 线；`hdc kill` + `hdc start`；入口会重建 fport |
| 入口说 `已有 supervisor 在运行` 但 `p0` 不健康 | supervisor 进程在、worker/心跳坏 | 关掉那个旧窗口后重跑入口并输 key（exit 3 会提示） |
| 板载 APP 显示 4/4 但手机 APP 数据旧 | public-sync 断了（ingest key 未输/worker 死） | 看 supervisor 窗口；重新拉起并输 key |
| 手机 APP 打不开/要求登录 | 会话不持久 | 重新登录（§7.4） |
| 随身求助显示离线 | mirror 未启动 / 端点不通 | 跑 `start-mirror-dayu.ps1 -Apply`；查 mirror-status.json |
| 云大屏/多终端无数据 | ECS 单点或 worker 未上报 | 本地闭环不受影响，按 `REPORT.md` 口径讲解 |

---

## 10. 停机/重启策略

- **正常收工**：关 watcher 窗口 → 关 supervisor 窗口（会结束 worker）→ 其余（broker/bridge/mirror/视频）可保留。
- **只重启 P0**：关 supervisor 窗口 → 重新双击 `start-demo-supervisor.cmd` → 输 key。watcher 会自动发现并恢复。
- **不要**：同时开两个 supervisor 入口（会拒绝）、在演示中重装 APP（会掉登录）、在演示前做端口探活/多终端订阅（占板端 homemon 槽位）。

---

## 11. 命令速查（按顺序复制）

```powershell
# 0) IP 校验
(Get-NetIPConfiguration -InterfaceAlias 'WLAN').IPv4Address.IPAddress

# 1) 预检
powershell -NoProfile -ExecutionPolicy Bypass -File <WORKSPACE>\competition\materials\start-demo-supervisor.ps1 -Preflight

# 2) 正式入口（双击亦可）——之后在该窗口输入 INGEST_KEY
<WORKSPACE>\competition\materials\start-demo-supervisor.cmd

# 3) 守护（双击亦可）
<WORKSPACE>\competition\materials\start-demo-all.cmd

# 4) mirror
powershell -NoProfile -ExecutionPolicy Bypass -File <WORKSPACE>\competition\materials\start-mirror-dayu.ps1 -Apply

# 5) 验收
Get-Content <WORKSPACE>\competition\evidence\2026-10-26-demo-autostart\runtime\watcher-state.json
```
