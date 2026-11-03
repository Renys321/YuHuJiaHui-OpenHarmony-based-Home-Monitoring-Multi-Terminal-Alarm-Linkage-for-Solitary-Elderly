# 随身 SOS 4G 链路断连自愈 — 证据与交付（task-2 / wearable-link）

**状态**：代码修复完成、回归测试 49/49 全绿、可部署补丁包已生成；**尚未部署 ECS、未烧录固件、未向生产 MQTT 发布任何消息、未接管设备连接、未 ACK 任何生产告警**。
**时间**：2026-10-27 22:17–22:45 Asia/Shanghai。
**范围**：`competition/cloud/wearable-mqtt/**`、`competition/deploy/wearable/**` 可写；固件与既有 evidence 只读。

所有证据分两类，正文里逐条标注：

- **【真实】** 对生产环境只读探测（生产 API GET、MQTT 1883 连接/鉴权探测）。
- **【Mock】** 本地测试：假 HTTP 后端 + 真实内置 broker + 真实 MQTT 报文字节（不访问生产、不写生产）。

---

## 0. 结论（TL;DR）

1. 现场设备在 22:22–22:26 **是在线的**：生产 API 的 `esp32-sos.lastSeenTs` 精确每 30s 推进一次，
   `state=NORMAL`、`online=true`、SOS 告警稳定 8 条（没有新增/重复）。
   → 用户看到的“APP 无法恢复/像断线”更可能是 **APP/后端把陈旧 `online=true` 当实时** 的语义问题，
   不是设备当前没上报。旧数据问题见 §2 RC2 与 §8。
2. `docker restart wearable-mqtt` 才能恢复 ACK 的根因是 **适配器对“设备重新上线”零事件驱动**：
   设备重启窗口内 3 次下行全丢 → 命令 parked → 只能等 60s / 5min 的定时器；
   而 `docker restart` = 清空内存 parked + 用持久化游标续读 → 立即重投。已修 + 有回归测试（§3 F1）。
3. 设备离线后 APP 仍显示在线：**适配器从不发 `online=false`**，后端 `ingest` 只是把载荷里的
   `online` 原样写入且不做过期判定 → 22:01 快照的 `online=true / lastSeen=18:37:58` 就是这样留下的。
   已修（业务上行静默看门狗，默认 120s，去抖）+ 有回归测试（§3 F2）。
4. 另外发现并修复两个会“静默丢状态/ACK”的缺陷：parked 命令在后端响应缺项时被直接删除（RC4）；
   升级重跑 install 脚本时源码是 bind mount，`compose up -d` 不会重建容器 → 新代码不生效（已在安装脚本加 `--force-recreate`）。

---

## 1. 现场真实核验（只读，未改任何生产状态）

### 1.1 生产后端只读快照与连续监测【真实】

工具：`_work/prod-monitor.js`（凭据只从 `competition/.secrets/app_guardian.txt` 读取，**不落盘、不打印**；
只调用 `POST /api/v1/auth/app`（换 sessionToken，不落盘）+ `GET /api/v1/devices` + `GET /api/v1/alerts` + `GET /healthz`）。

| 证据文件 | 内容 |
|---|---|
| `snapshots/2026-10-27T14-22-17-761Z-wearable-link-t0.json` | 22:22:17 单次快照 |
| `snapshots/prod-monitor-2225.jsonl` | 22:23:49–22:26:18，14 个采样（每 10s） |

数据点：

- 22:22:17：`GET /healthz=200`，`devices=200`（8 台），`esp32-sos: online=true, state=NORMAL, monitorOnline=-1, csq=null`，
  `lastSeenTs=1793110925701` = 本地 `2026-10-27 22:22:05`（距探测仅 12s）。
- 22:23:49 → 22:26:18 的 `lastSeenTs` 依次为 `22:23:35 / 22:24:05 / 22:24:35 / 22:25:05 / 22:25:35 / 22:26:05`
  → **精确 30s 一条心跳**，与固件 `WB_HB_INTERVAL_MS=30s` 契约一致，说明设备在线、适配器 uplink→backend 处理正常。
- 同期 `esp32-sos` 告警条数稳定 8 条，`sosAlertCount` 全程不变 → **期间没有重复建告警**。
- `csq=null`：固件心跳只在知道 CSQ 时才带 `csq`（`wb_build_hb` 的 `csq>=0` 分支），
  M100 未给 `config,csq` 时就是 null，属预期，不是缺陷。

> 与 Lead 给的 22:01 快照（`online=true` 但 `lastSeen=18:37:58`，3.5 小时前）对比：
> 说明 **`online` 只是载荷里的布尔值，不会随静默时间自动变 false**；22:23 后设备恢复心跳，
> `lastSeenTs` 才继续推进。这正是 RC2 的现场证据。

### 1.2 MQTT 1883 只读探测【真实】

工具：`_work/mqtt-probe.js`；输出：`snapshots/mqtt-probe-2230.json`（22:27:12）。

| 探测 | 结果 | 说明 |
|---|---|---|
| TCP `47.76.70.118:1883` | ✅ 连接成功，84ms | broker 存活、安全组 1883 通 |
| CONNECT（**非白名单** clientId，正确用户名/密码） | CONNACK `rc=5`（CLIENT_ID_NOT_ALLOWED），167ms | broker 先校验用户名/密码再校验 clientId，因此 rc=5 证明 **鉴权通过 + broker CONNECT 路径正常** |
| 以白名单 clientId `wearable-sos-001` 订阅 up 主题 | ❌ **未执行（有意）** | 白名单只有一个身份，用它连接会按 MQTT 3.1.1 接管规则把现场 M100 的生产连接踢掉（设备此刻在线，30s/条 hb），有丢真实上行/干扰真机验收风险。已向 Lead 说明；未得到“可中断”授权前不做 |
| 发布任何消息 | ❌ 未执行 | 纪律要求：绝不向 up 主题发测试消息 |
| `GET 47.76.70.118:8099/healthz` | ❌ 超时（4006ms） | 符合设计：`/healthz` 只绑容器回环 `127.0.0.1:8099`，未加入 compose `ports`，公网不可达；运维只能 `docker exec` |

### 1.3 当前生产事实清单（截至 22:27）

- `wearable-mqtt` broker：存活、鉴权正常、1883 公网可达，`/healthz` 不对外（设计如此）。
- `esp32-sos`：在线，30s 心跳，`state=NORMAL`，无未 ACK 的新告警（告警列表 8 条中 `sos-2/3/4/5` 均 ACKED；
  另有一条历史 `e-1793076169-1` state=ALARM、ackPending=false 的旧记录，**不是本次任务产生的，未做任何处置**）。
- 生产 API 无法直接看到适配器内部 `parked/inflight`；那是 `/status`（容器内 8099）的信息，需要 ECS `docker exec`（见 §5 验收步骤，由 Lead/用户执行）。

---

## 2. 根因（代码级，含旧行为）

| 编号 | 根因 | 旧代码位置/行为 | 证据 |
|---|---|---|---|
| **RC1** | parked ACK 只靠定时器恢复，没有“设备重新上线”事件驱动 | `_deliver()` 3 次投递后写 `parked`，`nextCheckAt = parkedRetryMs(60s)`；`_checkParked()` 只在 `_pollCycle()` 里到点才回读；轮次用尽后 `slowRetryMs=5min`。`docker restart` = 清空内存 `parked` + 用持久化 `commandCursor` 续读 → 立刻重投，所以“重启就好了” | `_work` 无；见旧 README §5.1 与 `test/command-sync.test.js` 现有 parked 用例；修复后有 `test/reconnect-recovery.test.js` ① / ①b 对照 |
| **RC2** | 设备离线后无人上报 `online=false`，后端也无陈旧判定 | 适配器只在收到上行时发 `online:true`；后端 `normalizeStatus()` 用 `online: input.online !== false` 原样写入，`store.ingest()` 每次 `devices.set(...)`，`lastSeenTs = receivedAt`（服务器收到时间），**没有过期计算** → 最后一条 status 的 `online=true` 永久保留 | 22:01 快照（Lead）与 §1.1 真实监测 |
| **RC3** | 适配器重启丢失全部内存态，且启动后不主动纠正后端在线态 | `inflight / parked / pendingResults / activeAlarm / dedupe / latestGps` 都是内存；`start()` 只读 `seq/commandCursor/sosCount`，没有“最后已知设备状态”，设备不回来就一直不纠正后端 | `src/main.js:43-45`（旧 `state.load()`）、旧 `adapter.start()`；修复后见 `test/reconnect-recovery.test.js` ④ / ④b |
| **RC4** | parked 命令在后端响应缺项时被**静默删除** | 旧 `_checkParked()`：`if (!raw || raw.status != PENDING) { parked.delete(id); log COMMAND_CLEARED_EXTERNALLY }` —— 后端响应异常/暂时缺项会被当成“已外部结算”，ACK 永久丢失 | 修复后 `COMMAND_PARKED_LOOKUP_MISSING` + 测试 ⑤ |
| **RC5** | `boot` 无条件把设备状态报成 `NORMAL` | 旧 `_handleBoot()` 固定 `state:'NORMAL', alarm.id:''`；若设备重启时仍有未确认告警，APP 设备状态会变 NORMAL 与未 ACK 告警矛盾（有“误显示已解除”风险） | 修复后 `_handleBoot()` 依据本地未确认事件报 ALARM；测试 ④/④b 断言 |
| **RC6（部署缺陷）** | 升级时新代码可能不生效 | `install-on-ecs.sh` 用只读 bind mount 挂源码，`compose up -d` 在 compose 配置未变时**不会重建容器** → 容器里还是旧进程的旧代码 | 已修：`--force-recreate`；并用 `release/wearable-reconnect-fix-v1.0.1.tar.gz` 解包副本跑通 49 项测试 |

> 关于“13.5 分钟才 ACKED 的 sos-5”：把 RC1 的定时器叠加起来（3 次×5s 投递 → parked 60s/轮 ×3 轮 → slow 5min/轮）
> 完全能解释分钟级到十几分钟的恢复时间；期间人工 `docker restart` 会立刻结束等待。本条为**推断**（当时没有 `/status` 快照），
> 修复后由测试 ①/①b 直接证明“<10s 恢复”。

---

## 3. 修复内容（对应用户可见语义）

### F1 设备重新上线 → PENDING ACK 立即重投（无需重启容器）

- broker `clientConnect`（设备 MQTT 链路恢复）或任一**业务上行**（`boot/hb/sos/ack`）到达时，
  把 parked 命令 `nextCheckAt=0`、`slow=false`、轮次重置 → 下一次轮询（默认 ≤1s）回读后端并重投。
- 只改本地投递节奏：**不改后端命令状态、不代报 ACKED/FAILED**；没有真实 `t:"ack"` 就永远不发 result。
- 代码：`src/adapter.js` `_onClientConnect`(239) / `_noteDeviceAlive`(263) / `_recoverParkedCommands`(277) / `_deliver` 不变。

### F2 离线语义：业务上行静默看门狗（去抖）

- 只看业务上行（`sos/hb/boot/ack`）；M100 自己上报的 GPS 固定格式行**不算**设备存活（否则 ESP32 断电会被掩盖）。
- 静默超过 `DEVICE_ALIVE_TIMEOUT_MS`（默认 **120000ms = 4×心跳**，容忍 2 次丢帧）才上报**一次** `online=false`；
  恢复时首个业务上行立即 `online=true`；阈值内的新心跳会重置看门狗（不闪离线）。
- 离线上报：保留最后已知 `state/alarm.id/csq`，`ts` 用最后一次真实业务上行时间（**不用 PC 当前时间冒充设备时间**），
  `gps` 只在有真实 `latestGps` 时携带原始 `fixTime`（绝不新造坐标）。
- 代码：`_armAliveWatchdog`(291) / `_onAliveTimeout`(307) / `_buildStatusBody`(342)。

### F3 boot 与未确认事件不再互相矛盾

- `boot` 时若本地有未确认事件：报 `ALARM + alarm.id`（fail-safe，不伪造“已解除”），等设备真实 SOS 重发或 30s 内的 IDLE 心跳。
- 设备**明确 IDLE 心跳**才清本地事件快照，计数 `ACTIVE_EVENT_CLEARED_BY_DEVICE` 并写日志；
  后端告警保持未确认（人仍能看到），**绝不代报 ACKED**。
- 代码：`_handleBoot`(744) / `_handleHeartbeat`(670)。

### F4 不静默丢 ACK / 不丢未确认求助

- `_checkParked`(1079)：后端响应缺该命令 → 保留 parked、计数 `parkedLookupMissing`、下轮继续回读；
  只有明确看到 `status != PENDING` 才算外部结算。
- `DATA_DIR` 新增可选持久化 `device`（`state/alarmId/csq/lastSeen/lastBusinessUplinkAt`，**绝不含坐标**）：
  容器重启后若设备不回来，仍能如实上报 `online=false` 且保留未确认告警 `alarm.id`；已 ACKED 不回退；`commandCursor` 继续续读。
- 代码：`src/state-store.js` `normalizeDeviceSnapshot`(41)/`setDeviceSnapshot`(202)/`getDeviceSnapshot`(215)；`src/adapter.js` `_restoreDeviceSnapshot`(370)/`_persistDeviceSnapshot`(403)。

### F5 可观测性

- `/status` 新增 `adapter.link={deviceClientId,aliveTimeoutMs,watchdogArmed,offlineReported}`；
  `adapter.counters` 新增 `deviceLinkUps/deviceLinkDowns/deviceOfflineReports/deviceStateRestored/parkedRecoveryTriggers/parkedLookupMissing/activeEventClearedByDevice/activeEventReplacedByDevice`。
- `state.device` 暴露持久化的最后已知设备状态；`/status` 顶部 `version=1.0.1`。

### F6 部署脚本修复

- `install-on-ecs.sh`：备份线上源码（`wearable-src-before.tar.gz`）→ 同步 `src/server.js/package.json/test` → **`up -d --force-recreate`** →
  校验 healthy/1883//healthz/端口边界/**容器内 `node --test` 回归测试全绿** → 打印 `version` 与 `reconnectFix` 计数。
- 新增 `rollback-upgrade.sh`：恢复升级前源码 + 强制重建容器 + 校验，用于“升级回滚”（`rollback.sh` 保持“首次安装回滚=移除服务”语义）。
- `wearable.env` 新增 `DEVICE_ALIVE_TIMEOUT_MS=120000`；`DEVICE_MQTT_CLIENT_ID` 默认取 `MQTT_CLIENT_ID` 白名单第一个（生产即 `wearable-sos-001`）。

### 修改文件清单

| 文件 | 变更 |
|---|---|
| `cloud/wearable-mqtt/src/adapter.js` | F1–F5 主体（链路事件、看门狗、boot/心跳语义、parked 保留、状态持久化、诊断计数） |
| `cloud/wearable-mqtt/src/config.js` | 新增 `DEVICE_MQTT_CLIENT_ID`、`DEVICE_ALIVE_TIMEOUT_MS`；`describeConfig` 增字段 |
| `cloud/wearable-mqtt/src/state-store.js` | 可选 `device` 快照持久化（严格校验，非法只告警忽略，不影响 seq/游标 fail-closed） |
| `cloud/wearable-mqtt/src/main.js`、`package.json` | `SERVICE_VERSION`/版本 → `1.0.1` |
| `cloud/wearable-mqtt/test/helpers/harness.js` | `DEVICE_MQTT_CLIENT_ID=test-device`、`DEVICE_ALIVE_TIMEOUT_MS=60000` |
| `cloud/wearable-mqtt/test/reconnect-recovery.test.js` | **新增 8 项回归测试** |
| `cloud/wearable-mqtt/README.md` | 新增 §8 断连自愈语义、环境变量、测试覆盖 49 项、遗留建议 |
| `deploy/wearable/install-on-ecs.sh` | 源码备份、force-recreate、test 同步、容器内回归自检、诊断增强 |
| `deploy/wearable/rollback-upgrade.sh` | **新增**：升级回滚脚本 |
| `deploy/wearable/README.md` | 新增 §8：升级/成功标志/两条回滚路径/风险 |

---

## 4. 测试（本地；【Mock】假后端 + 真实 broker/真实 MQTT 报文，不触生产）

| 证据文件 | 结果 |
|---|---|
| `logs/npm-test-full.log` | `node --test "test/*.test.js"` → **tests 49 / pass 49 / fail 0**（基线 41 + 新增 8） |
| `logs/reconnect-recovery-only.log` | `node --test test/reconnect-recovery.test.js` → **8/8 pass** |
| 包内自测 | 把 `release/wearable-reconnect-fix-v1.0.1.tar.gz` 解包到临时目录后 `npm test` → **49/49 pass**（证明发布包自足） |

新增 8 项断言（`test/reconnect-recovery.test.js`）：

1. **① 链路恢复后 parked ACK <10s 重投**：parked 定时器故意设 60s，只有 clientConnect 事件能救场；断言重投 <10s、
   重投时 `result=0`、命令仍 PENDING；随后真实 `t:"ack"` 才 result ACKED。
2. **①b boot 上行后同样 <10s 重投**，且 boot 不触发 ACKED。
3. **② 同一 alarmId 跨断连重连只建一条告警**，新 alarmId 才新告警。
4. **③ 静默 >阈值才 `online=false`**：断言离线上报 `ts` == 最后真实上行时间（不用 PC 时间）、
   `gps.fixTime` 是该定位帧真实接收时间、只上报一次；恢复首个上行立即 `online=true`；
   M100 的 GPS 行不能阻止离线判定。
5. **③b 去抖**：阈值内第二次心跳重置看门狗，不误报离线。
6. **④ 容器重启**：持久化状态含 `state=ALARM/alarmId` 且**不含坐标**；重启后设备不回来时上报 `online=false` 且保留 `alarm.id`，不代报 result。
7. **④b 容器重启不回退 ACKED**：不重复 result、游标不回退、设备回来只新增真实 NORMAL 状态。
8. **⑤ 后端响应缺 parked 命令**：不得静默删除，恢复后继续重投且仍不代报。

> 说明：测试里的“后端”是 `test/helpers/fake-backend.js`（本地 HTTP，port 0），MQTT 是真实内置 broker 的真实 TCP 报文，
> 设备是 `test/helpers/raw-mqtt-client.js` 裸 TCP 客户端。**没有任何测试连接生产后端或生产 MQTT**。

---

## 5. 可部署补丁包与逐步部署命令（等 Lead 拿到 Workbench 窗口后执行）

### 5.1 产物

| 项 | 值 |
|---|---|
| 补丁包 | `competition/deploy/wearable/release/wearable-reconnect-fix-v1.0.1.tar.gz`（90,027 B） |
| SHA-256 | `D118A41A8A2ECA8F6317C926DCF6FC70B07A1325F47917ECCC2E69B173A68C8B` |
| 校验文件 | `wearable-reconnect-fix-v1.0.1.tar.gz.sha256`（同目录） |
| 包结构 | `cloud/wearable-mqtt/{server.js,package.json,src/,test/,tools/,README.md}` + `deploy/wearable/{install-on-ecs.sh,compose.wearable.yaml,rollback.sh,rollback-upgrade.sh,README.md,...}`（37 个条目，无嵌套 release 目录） |
| 服务版本 | `1.0.1`（`/status` 的 `version`） |

### 5.2 部署步骤（ECS Workbench，逐步）

```bash
# 0) 上传：把 wearable-reconnect-fix-v1.0.1.tar.gz 上传到 ECS /root（Workbench 文件面板）
#    然后校验哈希（应等于上面的 SHA-256）
sha256sum /root/wearable-reconnect-fix-v1.0.1.tar.gz

# 1) 解包
mkdir -p /root/wearable-src
rm -rf /root/wearable-src/cloud /root/wearable-src/deploy
tar -xzf /root/wearable-reconnect-fix-v1.0.1.tar.gz -C /root/wearable-src
ls /root/wearable-src/cloud/wearable-mqtt/server.js /root/wearable-src/deploy/wearable/install-on-ecs.sh

# 2) 升级（复用已有 /opt/eldercare/deploy/wearable.env 里的 MQTT 用户/密码，不打印密码）
bash /root/wearable-src/deploy/wearable/install-on-ecs.sh --mqtt-user wearable-sos-001
```

成功标志（脚本会逐条打印，任何一条不通过都会中止并提示回滚；回归测试为“强警告不中止”，
若出现 “回归测试未全绿（强警告…）” 则安装仍完成但**不得直接演示**，先复核输出或回滚）：

```
已备份线上源码: /opt/eldercare/deploy/backup/wearable-<时间戳>/wearable-src-before.tar.gz
容器健康状态: healthy
自检通过: /healthz 200
自检通过: 0.0.0.0:1883 可连接
自检通过: 端口映射仅 1883/tcp
自检通过: backend 仍在运行（同网络服务名 backend 可解析）
自检通过: 回归测试全绿（断连自愈 / 不代报 ACK / 不重复告警 / 离线语义）
wearable-mqtt 安装完成（只新增 1 个服务，未改动 backend/caddy）
```

部署后手工确认（`version=1.0.1`、`deviceAliveTimeoutMs=120000`、`online`/`lastSeen` 状态）：

```bash
docker exec $(docker ps -qf name=wearable-mqtt) node -e \
  "fetch('http://127.0.0.1:8099/status').then(r=>r.json()).then(j=>console.log(JSON.stringify({version:j.version,link:j.adapter.link,device:j.adapter.device,counters:{offline:j.adapter.counters.deviceOfflineReports,parkedRecovery:j.adapter.counters.parkedRecoveryTriggers,resultOk:j.adapter.counters.commandResultOk}},null,2)))"
```

### 5.3 回滚（两条路）

```bash
# A) 升级回滚（推荐）：恢复升级前源码 + 强制重建容器，服务继续以旧版本运行；保留数据卷
bash /root/wearable-src/deploy/wearable/rollback-upgrade.sh \
  --backup /opt/eldercare/deploy/backup/wearable-<升级时打印的时间戳>
#   也可 --dry-run 先看动作；校验 /healthz、1883、version 回到 1.0.0

# B) 首次安装回滚：把 wearable-mqtt 整个服务移除（回到从未安装状态）
bash /opt/eldercare/deploy/rollback-wearable.sh \
  --backup /opt/eldercare/deploy/backup/wearable-<时间戳>
```

### 5.4 部署风险（如实）

- 升级会重建 `wearable-mqtt` 容器 → M100 的 MQTT 连接短暂断开，M100 自动重连（约 20–30s）；
  **建议在无未确认告警时升级**，等 NET 灯 1000ms 慢闪后再做下行 ACK 验证。
- backend/caddy 不动；数据卷 `eldercare-public_wearable-data` 保留；老版本代码会忽略新增的可选 `device` 字段（可安全回滚）。
- 部署失败时脚本会打印回滚命令；**不要**手删数据卷（会丢命令游标）。

---

## 6. 真实 4G 验收需要哪些物理动作（交给 Lead 执行）

前提：§5 部署完成 + 设备已上电。所有动作都要留 APP 截图/后端 JSON。

1. **上电顺序**：M100 先上电（DC 5–12V，**底板 USB 数据线拔掉**，天线接好），等 **NET 灯 1000ms 慢闪 + RDY 常亮**；
   再给 ESP32 上电（充电宝/USB）。
2. **确认在线**：生产 API `esp32-sos.online=true` 且 `lastSeenTs` 每 ~30s 推进（可用 §1.1 的只读监测脚本复查）；
   ECS `/status` 里 `broker.clients` 出现 `wearable-sos-001`。
3. **按键 → 告警**：按实体键 1 次（蜂鸣器立即响）→ APP 出现新的「随身求助」告警（记下 `alarmId`），
   DAYU 显示同一 `alarmId`（mirror 就绪后）；**3 分钟内确认列表里没有第二条同 alarmId 告警**。
4. **APP 确认 → 设备 ACK 链路**：APP 点确认 → 设备蜂鸣停止 → APP 显示“设备已确认”（ACKED）；
   ECS `/status` 的 `commandResultOk` +1，后端命令 `status=ACKED`。
5. **断连重启恢复（核心验收）**：
   a. 按一次键产生告警（APP 可见）；
   b. 立刻给 **ESP32 断电 30–60s 再上电**（M100 保持供电；或按真实场景一起断电再上电）；
   c. 观察：设备上电后 boot → APP 在线恢复应 ≤30–60s（`lastSeenTs` 继续推进、`online` 恢复 true）；
   d. 在断电窗口内去 APP 点“确认”，或上电后立刻点：命令应**秒级~10s 级**送达设备（旧版本要等分钟级或重启容器），
      设备停止蜂鸣、APP 变 ACKED。**不需要任何 `docker restart`**。
6. **离线语义**：ESP32 断电 **>2 分钟**（默认 `DEVICE_ALIVE_TIMEOUT_MS=120s`，M100 可保持在线）：
   生产 API 的 `online` 应变为 **false**（不要只看 `lastSeenTs`）；重新上电后 ≤30s 恢复 `online=true`。
   注意：`lastSeenTs` 语义是“服务器最后一次收到状态”，离线报告会刷新它 —— 这是后端既有语义，见 §8。
7. **不伪造确认**：整个过程中，没收到设备真实回执前 APP 只能显示“等待设备确认”，不得出现 ACKED；
   不在场时绝不替用户点确认。
8. **长稳（建议）**：保持在线 ≥30–60 分钟，观察 `hb` 是否始终 30s 节奏、无重复告警、无 `MALFORMED_JSON` 激增。

---

## 7. 固件

**本次不需要改固件、未构建、未烧录**。固件现有行为已满足服务端自愈所需（每 10s 同 alarmId 重发、
boot 帧、30s hb、NVS 恢复未确认事件、重复 ACK 也回执）。可选改进与风险见 `FIRMWARE-NOTES.md`。

---

## 8. 未解决项与建议（不改公网 backend）

1. **APP 陈旧判定（建议 task-5 协同）**：后端 `online` 只由上次 status 载荷写死，`lastSeenTs = receivedAt`（服务器收到时间），
   没有服务端过期计算。本服务现在会如实发 `online=false`，但 APP 若只看 `lastSeenTs`/不自动刷新，仍可能把旧数据显示为实时。
   建议 APP：以 `online` 标志为准 + 本地“最后刷新时间”；长时间无新数据时显示“数据可能已过期/最后更新时间”。
2. **后端语义建议（不改现网）**：`lastSeenTs` 语义是“服务器最后一次收到该设备状态的时间”，离线报告会刷新它；
   长期方案建议 backend 增加 `lastDeviceUplinkTs`（设备最后业务上行时间）或由服务端按阈值推导 `online`。
3. **设备侧事件丢失（NVS 损坏/被擦除）**：设备重启后若丢失未确认事件，后端告警会保持未确认；此时 APP 再点确认
   会产生 PENDING 命令但设备无匹配事件（固件忽略不匹配 ACK），命令会一直 PENDING。已计数/记日志
   （`ACTIVE_EVENT_CLEARED_BY_DEVICE`），**不伪造 ACKED**；现场建议改用“登记处置”。
4. **M100 4G/MQTT 长稳 >1 小时**仍未实测（本轮是代码级回归 + 只读现网观察，未做长稳）。
5. `wearable_env` 里 `DEVICE_ALIVE_TIMEOUT_MS` 可按现场网络调（不建议 <60s，避免 M100 重连抖动误报离线）。
6. 旧 `onenet/public-sync`/`gateway` 仍不能与演示同时启动（会抢领同一命令队列）——沿用既有约束。

---

## 9. 证据与安全边界声明

- 本目录所有文件**不含**任何密码/`INGEST_KEY`/sessionToken/坐标明细；`mqtt-probe.js` 输出只保留 env 的 key 名并把 `MQTT_PASS`/`INGEST_KEY` 标为 `(redacted)`。
- 未向生产 MQTT 发布任何消息；未使用白名单 clientId 建立连接；未 ACK 任何生产告警；未重启任何用户服务；未部署 ECS；未烧录固件。
- 【真实】= 生产只读探测文件：`snapshots/*`；【Mock】= 本地测试日志：`logs/*` 与测试源文件 `cloud/wearable-mqtt/test/**`。

### 文件索引

```
competition/evidence/2026-10-27-reconnect-dayu-sos/wearable-link/
├── README.md                     ← 本文件（事实/根因/修复/测试/部署/验收/遗留）
├── DEPLOY-PACKAGE.md             ← 补丁包哈希、上传/安装/回滚一页纸（给 Lead 执行）
├── FIRMWARE-NOTES.md             ← 固件建议与风险（不烧录）
├── ACCEPTANCE-4G-CHECKLIST.md    ← 真机 4G 验收物理动作清单（勾选式）
├── logs/
│   ├── npm-test-full.log         ← 49/49 全绿
│   └── reconnect-recovery-only.log ← 新增 8 项
├── snapshots/
│   ├── 2026-10-27T14-22-17-761Z-wearable-link-t0.json ← 生产 API 快照【真实】
│   ├── prod-monitor-2225.jsonl   ← 22:23–22:26 连续监测【真实】
│   └── mqtt-probe-2230.json      ← 1883 存活/鉴权/8099 探测【真实】
└── _work/
    ├── prod-monitor.js           ← 只读生产监测脚本（凭据不落盘）
    └── mqtt-probe.js             ← 只读 MQTT 探测脚本（不 publish、不接管）
```
