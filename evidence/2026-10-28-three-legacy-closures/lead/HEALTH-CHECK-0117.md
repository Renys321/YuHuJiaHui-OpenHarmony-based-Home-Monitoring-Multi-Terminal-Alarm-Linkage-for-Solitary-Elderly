# 全节点健康检查（2026-10-28 01:17，Asia/Shanghai）

结论：**核心节点全部正常，1 个需要人工处置的告警，1 个刚修复的视频链路**。所有检查为只读（未 ACK、未改数据）。

## A. 服务/节点状态

| # | 节点 | 状态 | 证据 |
|---|---|---|---|
| 1 | MQTT Broker 1883 | ✅ 正常 | PID 27820，LISTEN；bridge/P0/mirror 均连接 |
| 2 | Bridge 9101 | ✅ 正常 | PID 46720；fport `127.0.0.1:9001`；`--relay-ignore esp32-sos`；三房间状态持续发布 |
| 3 | P0 supervisor/worker | ✅ 正常 | 32288/60936，state=HEALTHY；202 三设备持续（dayu200-living/esp32-kitchen/esp32-bath） |
| 4 | watcher（demo-autostart） | ✅ 正常 | PID 38176；`p0=healthy target=OK app=active inference=running frames=LIVE nodes=4/4`（01:14:12） |
| 5 | wearable-mirror | ✅ 正常 | PID 61116；relay connected、disc=0；phase NORMAL、online true |
| 6 | **视频 relay 9443** | ✅ 已修复并验证 | 原进程 57556 仍指向 `10.127.130.250`（DAYU IP 已变），`/video/healthz dayuLink=down` → **重启为 `DAYU_HOST=10.127.130.132` + `BACKEND_BASE=https://api.luxunacc.xyz`**（PID 68808）；实测 WS 收到 **40 帧/13.4s、640×480、全唯一、首帧 404ms**；idle 时 `dayuLink=down` 为设计行为（最后 viewer 离开 3s 停流） |
| 7 | hdc / fport | ✅ 正常 | target 4501… 在线；`tcp:9001→tcp:9000` OK |
| 8 | 残留进程 | ⚠️ 注意 | PID 52772 `collect-timeline.js`（10-27 22:34 起的旧采集器，非当前链路必需；未擅自 kill） |

## B. 设备节点

| 设备 | 状态 | 数据 |
|---|---|---|
| DAYU200 客厅 | ✅ 在线（4/4） | APP 1.0.10 pid 27321；homemon 23655 `A5F3…`；wlan0=10.127.130.132；9000/9301 LISTEN；相机 `检测到人体 · 1190 帧 · 272ms`；“远程探望：就绪（无观看者）” |
| 厨房 ESP32 | ✅ 在线 NORMAL | ts 01:14:23；PIR 今日 1 次；门磁 open（seq 29）；24.9℃/53%RH valid；MQ ADC 4095/171 valid（报警未启用） |
| 卫生间 ESP32 | ✅ 在线 NORMAL | ts 01:14:23；PIR 最近 01:14:16、今日 63 次；门磁 open（seq 42）；26.2℃/50.8%RH valid；无 gas/smoke 传感器（valid=false，预期） |
| 随身 SOS（4G） | ✅ 在线 NORMAL | lastSeen 01:14:02（<30s）；后端 14 条 SOS 告警稳定；ECS adapter 1.0.1、client wearable-sos-001 在线 |
| 后端 API | ✅ 正常 | 4 台受监护设备 online=true；4 条历史/隔离记录仍离线（不纳入监护）；告警总数 93（esp32-sos 14） |

## C. 需要处置 / 风险

1. **DAYU 当前有 1 条未确认 FALL 告警**：`a-1793120863-1`，device=dayu200-living，type=FALL，state=ALARM，createdAt=01:07:45，`evidence.available=false`（无证据图）。来自 DAYU 本机视觉推理（`fall-1793120863100-na`），**未 ACK、未删除**。请确认是真实跌倒还是误检；如为误检按现有流程 ACK/处置，如为真实请立即处理。
2. **DAYU Wi-Fi IP 漂移**（.250 → .131 → .132）会同时打断 bridge/mirror（已改 fport 规避）与视频 relay（本次已重指 .132）。**建议给 DAYU 设静态 IP**，或给视频 relay 加“IP 变化自动重启”看护；否则下次 IP 变化 APP 视频会再次黑屏。
3. DAYU USB/HDC 偶发掉线（需重插），影响 fport/安装/截图，不影响 Wi-Fi 视频。
4. 视频帧率上限约 3–4.7 fps 是板端取帧 API（createPixelMapFromSurface 130–240ms/帧）瓶颈，不是 relay/节点故障；8fps 需改取帧路径（下一阶段）。
5. 残留 `collect-timeline.js` 进程可按需清理。

## D. 本次为“APP 摄像头看不到”做的修复
- 根因：视频 relay 在 00:24 启动时 DAYU_HOST 固定为 10.127.130.250；DAYU 锁屏/重连后 IP 变为 .132，relay 连接 DAYU:9301 超时 → `dayuLink=down`、APP 无画面。
- 修复：以 `DAYU_HOST=10.127.130.132`、`DAYU_PORT=9301`、`BACKEND_BASE=https://api.luxunacc.xyz` 重启 relay；端到端验证 40 帧/13.4s（约 3fps，640×480）。
- 若 APP 仍显示黑屏：请在手机 APP 退出“视频探望”再重进（清掉上次失败会话），应恢复。
