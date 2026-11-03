# 三项遗留闭环交付报告（2026-10-28 00:20–01:05，Asia/Shanghai）

分类：**已部署 / 本地完成 / 现场验证 / 受阻未完成** 分别标注。本报告不含任何密钥、口令、Token、INGEST_KEY 或精确经纬度。

## 0. 执行前现场核对（与旧报告不同的关键事实）

| 项 | 00:20 实际状态 |
|---|---|
| P0 | supervisor 40628 / worker 56416 HEALTHY；broker 27820、bridge 48108、mirror 11932 在跑 |
| watcher | **没有运行实例**；`watcher-state.json` 停在 10-27 23:04:30（stale） |
| DAYU | 已安装 **1.0.10/1000010**（不是旧报告里的 1.0.8）；APP 27321 / homemon 23450 |
| DAYU Wi-Fi | IP 已从 10.127.130.250 变为 **10.127.130.131**；bridge/mirror 仍指向 .250 → **P0 无 dayu200-living 202、mirror relay=False** |
| 并行会话 | 视频帧率会话仍在写 experiments 树/出 HAP（00:18–00:20）；后经用户确认结束 |
| ECS | wearable-mqtt 仍为 **1.0.0**（未部署 1.0.1） |

---

## 1. 任务①：ECS wearable-mqtt 1.0.1 —— 已部署，6 PASS + 1 BLOCKED（已裁决）

### 1.1 部署（用户 Workbench，真实执行）
- 包：`competition/deploy/wearable/release/wearable-reconnect-fix-v1.0.1.tar.gz`，90,027 B，SHA-256 `D118A41A…A68C8B`（用户端 sha256sum 一致）
- 备份：`/opt/eldercare/deploy/backup/wearable-20261027T163258Z`（含 `wearable-src-before.tar.gz`）
- 结果：容器 healthy、`/healthz 200`、仅 1883/tcp、backend/caddy 未动、容器内断连自愈回归测试全绿、安装完成
- `/status`：`version=1.0.1`、`link.aliveTimeoutMs=120000`、`watchdogArmed=true`、`broker.clients=["wearable-sos-001"]`

### 1.2 真机验收（真实按键/断电，非 mock）
| 判据 | 结论 | 证据（原始时间戳） |
|---|---|---|
| C0 版本 | **PASS** | version 1.0.1 / aliveTimeoutMs 120000 / watchdogArmed true；日志 `SERVICE_STARTED ... version=1.0.1` 16:33:00.988Z |
| C1 ACK 重启窗口 | **PASS** | `sos-12-1a1003dc` 00:35:45.9 创建；设备 00:36:46.98 最后上行后断电；离线期间 00:37:52~55 点确认 → `COMMAND_ACCEPTED 16:37:45.274Z`、3 次 `COMMAND_ACK_SENT`、`COMMAND_PARKED 16:37:55.281Z`；上电 ≈00:38:30 → **`PARKED_RECOVERY_TRIGGERED 16:38:32.301Z(source=sos)` → `COMMAND_ACK_SENT round=2` → `COMMAND_RECEIPT_ACCEPTED 16:38:32.758Z` → `COMMAND_RESULT_ACKED 16:38:32.777Z`**，ACKED 00:38:32.754 = **上电后 ≈2.8s**（基线 1.0.0 为 142s/194s）；全程未 docker restart |
| C2 离线 >120s | **PASS** | 最后上行 00:38:52.370 → 后端 lastSeen 被离线上报刷新 00:40:52.373（**120.003s**）→ 采样首见 `online=false` 00:41:01.278；日志 `DEVICE_UPLINK_TIMEOUT silentMs=120002`；上电 ≈00:41:32 → 00:41:35.572 `online=true`、lastSeen 推进（恢复 3.6s） |
| C3 无重复告警 | **PASS** | 83 帧采样 esp32-sos 告警稳定 14 条、每 alarmId 唯一；`sosReceived=8 / sosDuplicates=7`（设备重试被适配器去重） |
| C4 位置/GPS | **BLOCKED（已裁决）** | 升级前后现网均无 esp32-sos 位置数据（/devices 无 gps、/location 无记录）；无 (0,0) 假坐标、无不实写入；判定“现网无有效 fix、非本次回滚、不阻塞升级、不改后端/APP”；与 DESIGN-CONTRACT §5.2 不一致另行登记 |
| C5 不代报 ACK | **PASS** | ACKED 与 `commandResultOk=1` 同时成立（`COMMAND_RECEIPT_ACCEPTED` 先于 `COMMAND_RESULT_ACKED`）；全程未 POST ack |
| C6 未 docker restart | **PASS** | `SERVICE_STARTED` 仅 1 次（升级自身重建）；markers `no_docker_restart=true` |

**overall = 6 PASS + 1 BLOCKED（C4，已裁决），无 FAIL。**
证据：`competition/evidence/2026-10-28-three-legacy-closures/ecs/`（含 FINAL 报告、83 帧采样、status/log/markers、Workbench 一页纸、验证脚本）。
回滚：`bash /root/wearable-src/deploy/wearable/rollback-upgrade.sh --backup /opt/eldercare/deploy/backup/wearable-20261027T163258Z`（保留数据卷，不动 backend/caddy）。
未完成建议：4G/MQTT >1h 长稳未测；C4 需户外真实 GPS fix 才能闭环。

---

## 2. 任务②：watcher 修复 + 完整启动恢复 —— 现场验证（含 2 个现场缺陷修复）

### 2.1 修复与运行态一致性
- `materials/demo-autostart/demo-autostart.ps1`（22:41 修复版）与运行实例一致：watcher PID 63720（00:53:47 启动，单一实例）。
- 非破坏性验证（只读）：`verify-p0-health.ps1` 6/6、`verify-watcher-recovery.ps1` 29/29（P0 五要素、假 HEALTHY 拒绝、stale lock 可拉起、活锁不重复拉起、30min 6 次上限、60s 冷却、单实例互斥）全部 PASS。

### 2.2 现场真实验收
| 场景 | 结果 | 证据 |
|---|---|---|
| 受控杀 worker（不碰 broker/bridge/supervisor） | **PASS** | 00:54:30 kill 56416 → 00:54:52 新 worker **51524**，state `restartCount=1`，`HEALTHY`，202 立即恢复 |
| P0 整体异常退出 + stale PID/lock | **PASS（两轮）** | 00:55:03 kill supervisor 40628 + worker 51524（锁仍写 40628、state 仍 HEALTHY）→ watcher **00:55:12 检测 `STALE_LOCK` 并拉起正式 P0 入口**；后续 00:56:18/00:57:25 在 60s 冷却内再试（共 3 次，未到 6 次上限）；00:57:38 用户输入 key 后新 supervisor **67276** 日志 `LOCK_ACQUIRED pid=67276` + **`STALE_LOCK_TAKEOVER dead_pid=40628`** + `WORKER_START 61132` + `HEALTHY`；00:57:44 supervisor 存活时 watcher 判“不重复拉起”（正确） |
| 正式入口完整启动 | **PASS（01:01–01:03）** | 用户双击 `start-demo-all.cmd` + 输入 key：broker/bridge/supervisor/worker/mirror **各 1 实例**；P0 HEALTHY（32288/60936）；202 三房间 + esp32-sos 正常；watcher state `p0=healthy target=OK app=present inference=running frames=LIVE` |
| ESP32/后端恢复 | **PASS** | API：kitchen/bath/dayu200-living/esp32-sos 全部 online=true、lastSeen 持续推进；无重复告警（esp32-sos 14 条稳定） |

### 2.3 本次现场修掉的 2 个真实缺陷
1. **homemon 只有 4 个客户端槽 + 无 keepalive + EAGAIN 直接 close**：PC 侧 bridge/mirror 被强杀后留下 3 条僵尸 ESTABLISHED（Send-Q 持续增长）占满槽位，新连接被 accept 后立刻关闭 → DAYU 房间状态/SOS 镜像断链；且慢读触发 EAGAIN 会每 10–30s 踢掉 bridge/mirror。已修：`MAX_CLIENTS 4→8`、TCP keepalive(30s/5s×3)、`SO_SNDBUF 256KB`、**EAGAIN 只丢本条不杀连接**、半包才关闭；arm32 `-Strict` 零告警。新二进制 177,872 B `A5F355C2…6ED9EA`，已部署（pid 23655），`start-demo-supervisor.ps1` 的 `$HomemonSha` 已更新；回滚：`homemon.rollback-20261028-0045`（f6f44…）。
2. **PC↔DAYU Wi-Fi 直连不稳定**：DAYU IP 变更到 10.127.130.131 后，直连 9000 出现 TCP 830ms/偶发超时/ARP 缺失，bridge/mirror 反复 ECONNRESET；DAYU 本机 APP/homemon 一直正常。已切回 **USB hdc fport `tcp:9001→tcp:9000`**（bridge/mirror 均 127.0.0.1:9001），稳定观测：mirror connects=1/disconnects=0，bridge dayu200-living 持续 202，DAYU 4/4、随身求助页“在线/镜像(api)/刚刚/暂无定位”。`resolve-dayu-lan-ip.ps1` 与 `-AutoDayuEndpoint` 已实现（USB 在线优先 fport，Wi-Fi 仅 fallback）。
3. **BOM 事故（自曝）**：teammate 编辑 `start-demo-supervisor.ps1` 丢失 UTF-8 BOM，Windows PowerShell 5.1 把中文读乱导致解析失败、watcher 自动拉起的 P0 窗口直接退出。已恢复 BOM，并对 materials 下 **11 个 .ps1** 全部做 BOM + PS5.1 AST 校验（全部 PARSE_OK）；已要求后续任何 .ps1 改动必须带 BOM + PS5.1 解析通过后再落盘。

### 2.4 未解决 / 缺口
- **mirror 未纳入官方启动入口**：`start-demo-all.cmd` 不启动 wearable-mirror（当前由 Lead 手动启动，pid 61116）。建议把 `materials/start-mirror-dayu.ps1` 接入统一入口（watcher 或 start-demo-supervisor）。
- 00:59:3x 的整栈退出为外部关闭（watcher/P0/bridge/mirror 同时消失、仅 broker 存活），非 watcher 逻辑故障；恢复后单实例/202 正常。
- DAYU hdc USB 现场偶发掉线（需重插）；DAYU Wi-Fi 直连不稳，fport 为主。
- kitchen/bath 节点偶发离线（环境/Wi-Fi），不影响本次代码结论。

---

## 3. 任务③：DAYU 源码线统一 —— 本地完成，未安装（非必需）

- 决策：`experiments/dayu-eldercare-preview-integration-2026-10-25`（1.0.10/1000010）为**唯一维护主线**；`northbound` 同步为该快照的发布/构建入口，保留 `signing/**`（58 文件逐一 SHA-256 未变）。
- 差异：northbound 无独有文件；112/119 文件逐字节相同；7 个差异（app.json5、CameraModel、DeviceCapabilities、DeviceModel、Index、2 个 signing 产物）均有说明。
- 构建：从 `northbound` 干净重建 `BUILD SUCCESSFUL`，version 1.0.10/1000010，bundle `com.dsh.eldercare`，18 entries 无 .bak；signed HAP 1,385,966 B，SHA-256 `7C38C95D1296DB8B14ED1DC83C8D0F72036C5E57ED15951131D9EC168FAD5372`，`verify-app success`。
- 等价性：与 experiments 1.0.10 产物 **17/18 entries 逐字节相同**（仅 `ets/sourceMaps.map` 绝对路径不同）；`0.0.0.0`/`LAN_ONLY`/`VIDEO_STREAM_PORT`/`WearableBannerStore`/`wb_acked_`/`PreviewTuning`/随身求助/未配置 PIR/暂无定位/ackSource 全部存在；旧 `setPreviewRotation` 未回退。
- **未安装**：功能与已安装 1.0.10 等价，安装只覆盖线上版本、无收益；按“源码合并验收 / 安装验收分开”记为未执行（非必需）。HAP 作为“统一线可构建”证据保留。
- 回滚：当前安装版回滚包 `evidence/2026-10-27-video-fps/dayu-video-fps-1.0.10-signed.hap`（`B5EC606E…F2B714`）；版本策略保持 1.0.10，下次功能变更 1.0.11/1000011。
- **事故（自曝）**：合并脚本首次 dry-run 因 `/L` 误拼进 PowerShell 自动变量 `$args` 导致实际覆盖旧 northbound 5 个差异源码；已从旧构建 ArkTS 编译缓存逐字节恢复（DeviceModel 恢复哈希与 `docs/ARTIFACTS.md` 历史哈希一致），旧线完整归档于 `evidence/.../source-unify/northbound-1.0.0-archive/`（含 RECOVERY-NOTES）；脚本已修复并加 dry-run 强制 `/L` 安全网。
- 已知 stale：`device-capabilities.test.mjs` 4 条断言是 1.0.0 旧契约，canonical experiments 树同样失败，本轮不改，建议下轮更新。
- 证据：`competition/evidence/2026-10-28-three-legacy-closures/source-unify/`；文档 `competition/northbound/RELEASE.md`、`README.md`。

---

## 4. 运行时交接（01:04 最终状态）

| 组件 | PID/版本 | 说明 |
|---|---|---|
| mqtt_broker | 27820 | 127.0.0.1:1883 |
| mqtt_bridge | 46720 | 新代码；fport `127.0.0.1:9001`（status+relay），`--relay-ignore esp32-sos` |
| public-sync supervisor / worker | 32288 / 60936 | 1.0.x 新代码（有界熔断、ACK 设备白名单）；INGEST_KEY 仅内存 |
| DAYU homemon | 23655 | `A5F355C2…`；8 槽 + keepalive + EAGAIN 修复；`supported=false` |
| DAYU APP | 1.0.10/1000010 | 已安装；视频 Wi-Fi + 随身 SOS 横幅 |
| wearable-mirror | 61116 | `--source api --transport relay --relay-to 127.0.0.1:9001 --heartbeat-ms 5000`；relay connected/disconnects=0 |
| watcher | 38176 | `p0=healthy target=OK app=present inference=running frames=LIVE` |
| ECS wearable-mqtt | 1.0.1 | healthy；version 1.0.1 / alive 120000 |
| hdc fport | `tcp:9001→tcp:9000` | bridge/mirror 走 USB fport |

启动顺序：① `start-demo-all.cmd`（watcher；如需 P0 恢复时在其弹出窗口输入 INGEST_KEY）→ ② 启动 mirror：`powershell -ExecutionPolicy Bypass -File competition\cloud\wearable-mirror\scripts\start-mirror.ps1 -Transport relay`（USB fport 模式下默认 127.0.0.1:9001）→ ③ 打开 DAYU APP 确认 4/4 与随身求助。
（建议尽快把 ② 接入统一入口，见 §2.4。）
