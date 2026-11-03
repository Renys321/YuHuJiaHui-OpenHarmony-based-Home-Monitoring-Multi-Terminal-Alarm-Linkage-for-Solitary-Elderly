# DAYU WLAN IP 漂移：机制、自动解析、修正与当前阻塞（2026-10-28）

## 1. 现象与机制

DAYU200 的 `wlan0` 走 DHCP，IPv4 会漂移（现场 10-27 为 `10.127.130.250`，10-28 00:20 已变为 `10.127.130.131`）。
板端 homemon 监听 `0.0.0.0:9000`（可 LAN 直连）；PC 侧两个消费方把目标 IP 写进启动参数：

| 组件 | 参数 | 写死旧 IP 的后果 |
|---|---|---|
| bridge | `--status-tcp <DAYU:9000>` | 读不到 homemon 广播 → `dayu200-living` 状态不入 MQTT → P0 无该设备 202 → APP/DAYU 客厅数据停在旧值 |
| bridge | `--relay-to <DAYU:9000>` | 无线节点状态注入板端 homemon 的通道断开（relay keepalive/退避会重试，但目标错就一直失败） |
| mirror | `--relay-to <DAYU:9000>`（relay 注入模式） | mirror 日志 `[relay] disconnected ... ETIMEDOUT`、`connected=false` → DAYU 收不到随身 SOS 镜像 |

`kitchen/bath` 的 202 不受影响（ESP32→bridge→MQTT→公网），所以只看到“客厅缺失”而误以为 P0 整体坏了。

## 2. 只读自动解析：`materials/resolve-dayu-lan-ip.ps1`

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File <WORKSPACE>\competition\materials\resolve-dayu-lan-ip.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File <WORKSPACE>\competition\materials\resolve-dayu-lan-ip.ps1 -JsonOnly
powershell ... -File materials\resolve-dayu-lan-ip.ps1 -PreferLan      # 优先 LAN 直连
powershell ... -File materials\resolve-dayu-lan-ip.ps1 -Target <id>    # 显式 target
```

实现要点：
1. `hdc list targets -v` 找 `USB Connected` 的 DAYU target（多 target 时要求 `-Target`）；
2. `hdc shell ifconfig wlan0` 取 IPv4（兼容 `inet addr:` / `inet ` 两种输出，排除 127/169.254/0.0.0.0）；
3. 测 `<ip>:9000` 可达。**DAYU 相机+推理并行时实测建连可 >700ms**，默认 2500ms × 2 次重试；
4. fport 回退：检查 `hdc fport ls` 的 `tcp:9001 -> tcp:9000`；
5. 选择顺序（默认）：USB 在线 → `127.0.0.1:9001`（`usb-fport` / `usb-fport-pending`，**不依赖板端 IP**）；
   USB 不在线 → `wlan0Ip:9000`（`lan`）；否则 `127.0.0.1:9001`（`fport`）；都没有 → `ok=false`/exit 3。
6. 只读：不启动/停止服务、不创建 fport、不写运行时文件、不读任何凭据。

JSON 字段：`ok / target / usbConnected / wlan0Ip / lanReachable / fportPresent / fportListening /
endpoint / method / requiresFportCreate / reason / checkedAt`。2026-10-28 现场实测输出：
`endpoint=127.0.0.1:9001, method=usb-fport-pending, wlan0Ip=10.127.130.131, requiresFportCreate=true`。

**边界**：若 DAYU 既无 USB 又没有可用的 `hdc` 目标（纯无线拓扑），本脚本取不到 `wlan0` IPv4，
需人工传 `-StatusTcp/-RelayTo`；`hdc` 通过 TCP 连接 DAYU 的场景未验证。

## 3. 启动入口集成（已改，带 `.bak-20261028`）

- `materials/start-demo-supervisor.ps1`：新增 `-AutoDayuEndpoint` / `-PreferLanEndpoint`；
  在只读预检前调用解析脚本（只读），把 `endpoint` 同时用于 `--status-tcp` 与 `--relay-to`；
  显式 `-StatusTcp/-RelayTo` 优先；解析失败只 `warn` 并回退 `127.0.0.1:9001`，让预检继续暴露真实问题。
  `$HomemonSha` 保持 `f6f4497c…`（未回退，等 Lead 替换新 homemon 后由 Lead 更新）。
- `materials/start-demo-supervisor.cmd`：默认追加 `-AutoDayuEndpoint`。watcher 的 `$P0Cmd` 指向该 .cmd，
  因此 P0 被 watcher 拉起时也会自动解析；**没有改 demo-autostart.ps1**。
- 预检只读验证（`logs/06-supervisor-preflight-auto-endpoint.log`）：
```
[ok] 自动端点 endpoint=127.0.0.1:9001 method=usb-fport-pending wlan0Ip=10.127.130.131
[warn] hdc fport tcp:9001 -> tcp:9000 未建立，启动阶段会创建
=== PREFLIGHT PASS（只读模式，未启动任何服务）===   exit 0
```
（预检不创建 fport、不启动服务。）
- `materials/start-mirror-dayu.ps1`：解析端点后把 `-RelayTo` 传给 mirror 自带
  `cloud\wearable-mirror\scripts\start-mirror.ps1`；**默认 dry-run**（只打印命令），`-Apply` 才启动；
  mirror 已在运行时拒绝第二实例（exit 4）并打印当前 relay 状态。未改 mirror 源码/脚本。
- 文档：`materials/README.md` 新增“DAYU WLAN IP 漂移与自动端点”。

## 4. 手工修正 bridge 的顺序（Lead 批准后在时间窗内执行）

**只重启 bridge，不动 broker / P0 supervisor / worker。** 先记录现网 bridge PID 与完整命令行（回滚依据）：

```powershell
$sup='<WORKSPACE>\competition\bridge\_test\current-runtime\supervisor'
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'mqtt_bridge' } |
  Select-Object ProcessId,CreationDate,CommandLine | Format-List
$ep = (powershell -NoProfile -ExecutionPolicy Bypass -File <WORKSPACE>\competition\materials\resolve-dayu-lan-ip.ps1 -JsonOnly | ConvertFrom-Json).endpoint
# USB/fport 拓扑（$ep=127.0.0.1:9001 时先确认 hdc fport 已建立或由 P0 入口创建）
# LAN 拓扑（$ep=<LAN IP>:9000）：
Stop-Process -Id <仅 bridge PID>          # 不要按历史 PID 杀
D:\Node\node.exe <WORKSPACE>\competition\bridge\mqtt_bridge.js `
  --broker 127.0.0.1:1883 --status-tcp $ep --relay-to $ep --listen 9101 `
  --relay-ignore esp32-sos --lock-file "$sup\bridge.lock" `
  --cmd-out "$sup\control" --status-file "$sup\status.json"
```

判定：9101 LISTEN；bridge 日志出现 `已连接转发目标 <ep>` / `→ home/dayu200-living/status`；
≤2min 内 supervisor 出现 `device=dayu200-living ... status=202`；mirror 的 relay 目标若也指向板端，按第 5 节处理。

## 5. 手工修正/重启 mirror（由 Lead/负责人决定，用封装脚本）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File <WORKSPACE>\competition\materials\start-mirror-dayu.ps1            # dry-run
powershell -NoProfile -ExecutionPolicy Bypass -File <WORKSPACE>\competition\materials\start-mirror-dayu.ps1 -Apply     # 真正启动
```

顺序要求（历史结论，仍有效）：**先确保 bridge 带 `--relay-ignore esp32-sos` 在运行，再启动/重启 mirror relay 注入**，
否则 bridge 会把 `esp32-sos` 回灌当成“板端连接改名”并退休板端连接（bridge 旧缺陷；新 bridge 已带 `--relay-ignore`）。
mirror 已有实例时须先按其自带 `stop-mirror.ps1` 停止，再 `-Apply`；不要并发起两个 mirror。

## 6. 2026-10-28 现场时间线（本任务可负责的证据）

| 时间（Asia/Shanghai） | 事实 |
|---|---|
| 00:20–00:21 | DAYU wlan0=`10.127.130.131`；bridge 48108 仍连 `10.127.130.250:9000`；mirror 11932 relay 同旧地址 → `P0 无 dayu200-living 202`、mirror `connected=false(ETIMEDOUT)` |
| 00:24:39 | 并行视频会话强杀旧 bridge，以 `.131` 重启（PID 60896）；00:27:19 Lead 再次重启 bridge（PID 46292） |
| 00:27:32 | Lead 重启 mirror（PID 59300，`--relay-to 10.127.130.131:9000`），日志 `[relay] connected 10.127.130.131:9000` |
| 00:27:39 / 00:28:11 | supervisor 收到 `dayu200-living ... status=202`（.131 修正确实一度生效） |
| 00:28:11 之后 | dayu200-living 202 **停止**；kitchen 202 持续正常；mirror relay 开始反复 connect/disconnect |
| 00:35–00:42 | 只读诊断：3 条僵尸连接占满 4 槽 + Send-Q 增长；部署态 homemon 仍为 MAX_CLIENTS=4；mirror relay 反复断连（见第 7 节） |
| 00:41–00:45 | Lead 部署 homemon 源头修复（4→8 + keepalive + SO_SNDBUF 256KB + EAGAIN 不杀连接），多次重建/替换，最终 00:44:46 启动新二进制（PID 23655，sha256 A5F355C2…），`$HomemonSha` 已同步 |
| 00:48:15 / 00:48:29 | Lead 将拓扑切回 **USB hdc fport**（`hdc fport tcp:9001 tcp:9000`），bridge（66100）/mirror（65784）改 `127.0.0.1:9001` 并重启 |
| 00:48–00:51 | 恢复验证：dayu200-living 202 恢复并持续；mirror relay `connected=true`（connects=1/disconnects=0）；bridge 出现 `→ home/dayu200-living/status` 与 `--relay-ignore esp32-sos`；DAYU 随身求助页在线（镜像 api/刚刚/暂无定位）、“全屋在线 3/3” |

结论：**.131 修正本身是对的，但被 homemon 客户端槽位问题打断**；不能把当时那一刻的 connected/202 当作长期稳定证据。

## 7. 根因链：4 槽僵尸 + EAGAIN 杀连接 + Wi-Fi 直连不稳 → 改用 fport

2026-10-28 00:28–00:51 的断链不是单点，而是三层叠加（证据 `logs/08-*`~`logs/13-*`）：

### 7.1 旧 homemon（部署态 MAX_CLIENTS=4，PID 23450 / f6f4497c…）
1. 启动日志明确打印 `最多 4 路客户端`；bridge 占 2 路、DAYU APP 1 路、mirror 需 1 路 → 恰好/超过上限。
2. 板端 netstat 有 3 条来自 PC 的 ESTABLISHED，但 PC 侧对应本地端口（.179:55852/55853/57067）已无进程
   （老 bridge/mirror 被强杀后残留）——死连接没有 keepalive 回收，成为僵尸槽位。
3. 僵尸连接 Send-Q 持续增长（00:39–00:41 每 3s 各约 +988B，合计 130–150KB），homemon 仍在向死 socket 广播；
   新连接（bridge status/relay、mirror relay）只能排队（SYN_RECV）或被 accept 后关闭
   → `dayu200-living` 202 中断、mirror `connects=25/disconnects=36`、bridge `转发目标断开…连续失败 16 次`。

### 7.2 旧 homemon 的第二个缺陷：EAGAIN 被当致命错误
旧逻辑把 `send()==EAGAIN`（慢读/缓冲区满）当成致命错误直接 `close(fd)`，所以即使槽位没满，
bridge/mirror 也会在 10–30s 被踢掉。这解释了旧代码下“偶发断连”而非只有槽位耗尽时断连。

### 7.3 Wi-Fi 直连不稳定（拓扑层）
PC↔DAYU 的 LAN 直连在 00:44 前后明显劣化：TCP 建连 ~830ms、偶发 `ETIMEDOUT`、PC 侧 ARP 缺失；
DAYU 本机 APP/相机一直正常（板端 `wlan0` 仍是 10.127.130.131、可 ping 网关/厨房节点，但 PC↔DAYU 丢包）。
无线直连不适合作为 DAYU 状态/relay 的**唯一**通道。

### 7.4 修复（Lead 执行，已完成）
| 修复 | 部署结果 |
|---|---|
| `MAX_CLIENTS 4→8` | 新二进制启动日志“最多 8 路客户端” |
| 对 accept 的 socket 开 TCP keepalive（30s 空闲 + 5s×3 探测，约 45s 回收死连接） | 死连接不再永久占槽 |
| `SO_SNDBUF 256KB` + **EAGAIN 不再 close** | 慢读/拥塞不再被当成致命错误踢连接 |
| 二进制 | 177,872 B，sha256 `A5F355C2D5E9F4E7330282F1856411927EB54AD743B5ACB7C599BE7C2D6ED9EA`，PID 23655 |
| 回滚备份 | 板端 `/data/homemon/homemon.rollback-20261028-0045`（f6f4497c…）与 `…-2257`（0d2435…） |
| `$HomemonSha` | 已同步为 A5F355C2（否则 P0 入口预检会拒绝） |
| 拓扑 | 切回 **USB hdc fport**（`hdc fport tcp:9001 tcp:9000`）；bridge/mirror 均改 `127.0.0.1:9001` |

### 7.5 恢复后只读验证（00:48–00:51，详见 `logs/11-*`、`logs/12-*`、`logs/13-*`）
- `dayu200-living` 202 恢复并持续（00:48:18Z、00:48:48Z、00:49:21Z、00:49:51Z、00:50:21Z…）；kitchen 202 持续；
- mirror：`relay=127.0.0.1:9001`、`connected=true`、`connects=1/disconnects=0`、`linesSent` 持续增长；
- bridge：`→ home/dayu200-living/status` 正常、`忽略板端连接上的 --relay-ignore 设备回灌：esp32-sos`（mirror 注入生效且被正确忽略）；
- DAYU 界面：`随身求助 · 已选设备在线 · esp32-sos`、`全屋在线 3/3 台设备`、`数据来源 随身 SOS 镜像（api）`、
  `最近上报 刚刚`、`位置 暂无定位`；
- `esp32-bath` 自 16:19:54Z 起无新 202、bridge 在线列表无该节点（疑似环境断电/离线，**记录事实，不改代码**）。
- 遗留观察项：`hdc fport` 单路转发容量有限，bridge 的 status 与 relay 共用 9001 时若 fport 掉线，
  两条通道会一起断；runbook 已把 fport 可用性列为验收前检查项。

## 8. 防复发

- 正式入口已自动解析端点（**USB 在线优先 fport**），**不要**再把某个 DAYU IP 写进脚本/文档命令；
  Wi-Fi 直连仅作 fallback（本次实测不稳定）。
- bridge/mirror 重启尽量“正常停止后启动”，避免 `Stop-Process -Force` 造成板端僵尸连接；
  若必须强杀，之后关注板端 `netstat -lntp | grep 9000` 是否有长期 `ESTABLISHED + Send-Q 增长`；
- homemon 新二进制（8 路 + keepalive + EAGAIN 修复）应作为启动前置校验项：P0 入口 `$HomemonSha` 必须与板端一致；
- 安装/回滚 DAYU APP 一律用 `northbound/RELEASE.md` 记录的 1.0.10 signed HAP（B5EC606E…）；
  materials 的 `demo_start.ps1`/`demo-preflight.js`/`device-preflight.ps1` 已于 2026-10-28 修正（见 `logs/15-*`）；
- 若 DAYU DHCP 地址频繁变化，可考虑为 DAYU 做 DHCP 保留（需用户/网络管理决定，本任务不执行）。
