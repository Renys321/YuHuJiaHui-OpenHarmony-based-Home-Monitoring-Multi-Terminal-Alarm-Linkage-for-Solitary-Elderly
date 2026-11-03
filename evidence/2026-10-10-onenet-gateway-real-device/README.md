# DAYU200 真机网关分层验收证据

日期：2026-10-10（Asia/Shanghai）
执行人：DeepSeek（接手会话）
本轮证据目录：`evidence/2026-10-10-onenet-gateway-real-device/`

## 1. 本轮结论摘要

### 1.1 上行分层验收（`real-device-acceptance.ps1`）：17/17 PASS

| 结论 | 状态 | 关键证据 |
|---|---|---|
| DAYU200 在线且系统基线一致 | PASS | `real-device-results.json`：API 26、OpenHarmony 7.0.0.38、`aarch64`、`LONG_BIT=32` |
| 板端 homemon 与权威制品一致 | PASS | 板端 `sha256sum` = `0d243539...42881e6`，与 `ARTIFACTS.md` 的 `homemon-arm` 相同 |
| 真实板端状态经 Broker 到达网关 | PASS | `broker.out.log` 有 `SUBSCRIBE home-cloud-gateway-* → home/+/status` |
| 上云属性保留 deviceId 与房间来源 | PASS | `gateway-events.jsonl`：`deviceId=dayu200-living room=客厅` |
| 稳定状态限频 | PASS | 同状态下连续上报 4 次，property 事件数未增长 |
| 真实板端告警产生 `safetyAlarm` 事件 | PASS | `alarmId=a-1609503175-2 type=MANUAL_SOS` |
| 同一 alarmId 不重复告警 | PASS | 该 alarmId 全程事件数 before=1 after=1；而板端新产生的 `a-1609503256-3` 正确告警一次 |
| 非法报文零污染 | PASS | 本轮 `rejected` 与 `cloudError` 事件均为 0 |
| 清理 | PASS | Broker 端口释放、无残留网关进程 |

**17/17 断言通过，退出码 0。**

### 1.2 真机下行 RESET 闭环验收（`real-device-reset-acceptance.ps1`）：20/20 PASS

链路全部真实（含 `hdc fport` 上的真实 Bridge），只有 OneNET 传输层是伪的：

```text
板端 homemon :9000
  --hdc fport--> PC 127.0.0.1:9000
  --mqtt_bridge.js--> 本地 Broker :1883 --> gateway.js（真实代码）
  --RESET--> home/dayu200-living/cmd --> Bridge 按 deviceId 路由 --> 板端 homemon 执行 reset
  --板端 state=NORMAL--> Bridge --> Broker --> 网关收到真实回执并回复成功
```

关键证据：

| 环节 | 原始记录 |
|---|---|
| 板端真实告警 | `[1609503903] ALARM id=a-1609503903-8 type=MANUAL_SOS` |
| 网关下行负载 | `reset-broker.out.log`：`PUBLISH home/dayu200-living/cmd (15B) → 转发给 1 个订阅者` |
| **Bridge 真实路由** | `reset-bridge.out.log`：`[MQTT] ← home/dayu200-living/cmd: {"cmd":"reset"}` 与 `[bridge] 命令已写入节点 dayu200-living 的活动连接: reset` |
| **板端真实执行** | `[1609503907] 状态复位 -> NORMAL` |
| 网关依据真实回执成功 | `reset-harness.out.log`：`RESET scope=self device=dayu200-living result=OK baselineSeq=4 seenSeq=5 seenState=NORMAL` |

**20/20 断言通过，退出码 0。**

### 1.3 本轮真机验收抓出并修复的两个网关缺陷

这两个缺陷**只有真机能发现**（伪传输层单测全部通过）：

**缺陷 1：下行负载格式错误。** 网关把裸字符串 `reset` 发到 `home/<deviceId>/cmd`，
而 Bridge 只接受 JSON（`bridge/mqtt_bridge.js:320-332`），Bridge 因此记为
`[bridge] 无法解析下行命令: reset` 并**静默丢弃**。命令根本没到设备。
修复：发布 `{"cmd":"reset"}`（`gateway.js` 的 `_publishLocal`）。

**缺陷 2：回执判定可被过期快照满足。** 即使命令没有真正送达，网关也会把设备
“告警前”的旧 `NORMAL` 快照当成 RESET 回执，返回 `code=200`。修复为两层约束：

1. 目标必须**当前确实处于 `ALARM`**，否则直接拒绝（`target has no active alarm to reset`）——
   这同时符合 RESET 的语义。
2. 回执必须**晚于本笔告警被观测到的序号**（`device.alarmSeq`）。

新增回归测试：`gateway.test.js` 的 “RESET is refused when the target has no active alarm”
与 “RESET is not confirmed by a stale pre-alarm status”；
另附独立行为核对脚本 `gateway-toctou-check.js`（不依赖 `node:test` 运行器，避免沙箱 `spawn EPERM`），
三个场景分别验证：无告警必须拒绝、有告警但无回执必须超时失败、有告警且有新回执才成功。

### 1.4 生产入口启动健壮性（不需要密钥）

真机与本地分层验收都走 `real-device-harness.js`（注入伪传输层），因此 `gateway.js` **自己的生产
入口长期没有被执行过**。补测 `npm run gateway`（起真实 Broker，故意不设 `ONENET_DEVICE_KEY`），
抓出并修复两个启动期缺陷：

| 缺陷 | 现象 | 修复 |
|---|---|---|
| `createGateway` 拒绝 `process.env` | 生产入口一启动即 `[gateway] FATAL code=UNKNOWN message=env must be a plain object`，**完全无法启动** | 配置容器改用“非 null 对象且非数组”校验（`isEnvLike`），不再要求原型为 `Object.prototype` |
| `transportError` 无人监听 | 传输层的 `CONNECT_SETUP_FAILED` 等错误既不记录也不转发，常驻进程里完全不可见 | 网关挂监听并转成安全的 `cloudError` 事件与日志 |

根因：`process.env` 的原型不是 `Object.prototype`，被自身的“纯对象”守卫挡下；而此前所有验收都
注入了普通对象 `env`，所以这条路径从未被覆盖。

修复后实测（PC 本地真实 Broker）：

```text
[gateway] START mode=self device=dayu200-living
[gateway] LOCAL_SUBSCRIBED topic=home/+/status
[broker]  SUBSCRIBE home-cloud-gateway-46711 → home/+/status
```

进程保持存活 10s 以上、不退出；缺少设备密钥只让 OneNET 侧按指数退避重试。启动失败日志也从只有
`code=UNKNOWN` 改为输出安全错误码 + 消息，并支持 `GATEWAY_DEBUG=1` 打印堆栈（默认不含载荷或密钥）。

新增回归测试：`gateway.test.js` 的 “createGateway works with the real process.env”、
“createGateway reads gateway settings from the supplied env”、“createGateway rejects a
non-object env”、“transport errors are surfaced as safe cloudError codes”。

### 1.5 本轮验收总览（第 3~4 轮，2026-10-10）

| 层 | 结果 |
|---|---|
| 单元回归（`cloud/onenet` 全目录） | **78/78**（原有 37 项零回归） |
| RESET 语义核对（不依赖 `node:test`） | PASS |
| 本地分层（真实 Broker + 伪 OneNET） | **14/14** |
| 真机上行分层 | **17/17** |
| 真机下行 RESET 闭环 | **20/20** |
| 生产入口启动自检（无密钥保持存活 / 缺必填元数据 fail fast） | PASS |

### 1.6 OneNET 8883 真实 TLS 自检（无凭据，第 5 轮新增）

真实凭据常驻运行里唯一**不需要密钥**的那一半已单独验收：用 `transport.js` 完全相同的 TLS 选项
（官方 CA + 固定叶证书指纹 + `rejectUnauthorized=true`）对产品专属 8883 入口做真实握手，
**不发送任何 MQTT 字节、不携带凭据**。

证据：`onenet-8883-tls-live-check.txt`（脚本 `cloud/onenet/tls-live-check.js`，6/6 PASS）

| 校验 | 结果 |
|---|---|
| `rejectUnauthorized=true` 握手完成 | `authorized=true` |
| 证书链对官方 CA 验证 | `authorizationError=none` |
| 叶证书指纹 == 固定 SHA-256 | 完全一致 |
| 叶证书 CN | `OneNET MQTT`（`C=CN, O=CMIOT`） |
| 协议 / 套件 | `TLSv1.3` / `TLS_AES_256_GCM_SHA384` |
| 有效期 | `2019-05-29` → `2049-05-21`（未轮换、未过期） |

结论：链路、CA 与证书指纹固定在当前仍与线上一致，**证书层不是**凭据验收的阻塞点；
阻塞点只有凭据注入本身。该结果**不能**替代带凭据的 MQTT CONNECT 验收。

### 1.7 启动配置自检（第 4 轮新增）

`npm run gateway` 现在启动即打印非敏感配置，并在缺失必填元数据时 **fail fast**，
避免“进程看起来在运行却永远不会成功”：

```text
[gateway] CONFIG productId=I19NBBq4xe deviceName=dayu200-living
[gateway] CONFIG deviceKey=unset          # 只显示 set/unset，绝不打印密钥值
[gateway] FATAL code=MISSING_CONFIGURATION message=missing required configuration: ONENET_PRODUCT_ID, ONENET_DEVICE_NAME
```

设备密钥保持**惰性读取**（允许运行期由 Secret 注入），因此缺失密钥不算配置错误，
只让 OneNET 侧按指数退避重试；缺 `ONENET_PRODUCT_ID`/`ONENET_DEVICE_NAME` 则直接拒绝启动。
回归测试见 `gateway.test.js` 的 `assertRequiredEnv` 用例（含“密钥值不得出现在错误信息中”断言）。

## 2. 本轮做了什么

1. 只读预检确认设备上线、系统基线与 `docs/ARTIFACTS.md` 一致。
2. 推送并核验 `southbound/out/homemon-arm` 与 `southbound/say.sh`（板端 SHA-256 与本地一致后启动）。
3. 用 `materials/demo_start.ps1:167-183` 的同一份演示配置启动 homemon（`no_motion_sec=30`）。
4. 起本地 `bridge/mqtt_broker.js`，用真实板端 `status.json` 发布到 `home/dayu200-living/status`。
5. 起 `cloud/onenet/gateway.js` 真实代码（订阅真实 `home/+/status`），仅把 OneNET 传输层换成伪传输层，因此**不需要真实设备密钥**。
6. 通过板端 `control` 注入 `sos` 触发真实 `MANUAL_SOS` 告警，观察 `safetyAlarm` 上报与去重。

## 3. 为什么用 PowerShell 编排

受限沙箱下 Node **无法**以管道 stdio 调用 `hdc`：`hdc` 会常驻 server 并持有管道，导致 Node 的
`spawnSync` 永不返回（或直接 `EPERM`）。因此本轮由 `real-device-acceptance.ps1` 负责全部 `hdc`
操作与进程编排，Node 只负责 MQTT 侧。首次实现（Node 编排）因此无法运行，已删除。

## 4. 本轮发现的三个现场问题

### 4.1 板端系统时间严重偏离（PASS 不能掩盖）

| 项目 | 值 |
|---|---|
| PC 本地时间 | `2026-10-10 23:02 +08:00` |
| 板端 `date` | `Fri Jan  1 20:13:30 CST 2021` |
| 板端 `date -u` | `Fri Jan  1 12:13:30 UTC 2021` |

板端比 PC **落后约 5.8 年**，与 `docs/KNOWN-RISKS.md` 第 4 条“DAYU200 重启后系统时间可能回退”
一致。两个后果：

- 板端自身生成的 `ts` 是 13 位毫秒但**数值错误**（如 `1609503263868`）。本轮网关使用 **PC 本地接收
  时间** 作为上云时间戳，因此云端时间正确；但不能据此认为板端时间已修好。
- 板端告警 ID 形如 `a-1609503175-2`，其中的 epoch 秒来自错误的板端时钟。

处理建议：把网络校时纳入启动流程（`RUNBOOK.md` 第 11 节之后），并在每次取证时同时记录 PC 与设备时间。

### 4.2 演示配置的 `NO_MOTION` 路径在本机不可靠
`no_motion_sec=30` 需要 PIR 连续 30 秒无活动。实测 `motion_gpio=29` 悬空时持续触发活动
（`countToday` 从 1724 涨到 1976），因此 `NO_MOTION` 可能永不触发。这不是固件缺陷，而是
`docs/KNOWN-RISKS.md` 第 5 条已记录的演示阈值问题。

本轮改用板端 `control` 注入 `sos`：`southbound/README.md` 说明该命令与实体求助按钮走**完全相同**
的判定/执行路径，仍是真实板端产生的告警与 alarmId。**未**用模拟节点伪造。


### 4.3 ESP32-S3 实体在线但 WiFi 失败（COM9）

对 COM9 做**只读**串口监听（未烧录、未发送任何命令）确认：COM9 就是 ESP32-S3。

```text
ESP-ROM:esp32s3-20210327
I (27) boot: ESP-IDF v5.1.6-dirty 2nd stage bootloader
I (27) boot: compile time Oct  9 2026
W (10365) elder-node: WiFi 连接失败 reason=201 ...
```

| 结论 | 状态 |
|---|---|
| ESP32-S3 实体在线、运行当前固件 | PASS（启动标识与 `ARTIFACTS.md` 构建元数据一致） |
| WiFi 接入 | FAIL；`reason=201` = `WIFI_REASON_NO_AP_FOUND`，找不到固件配置的 SSID |
| 节点接入 Bridge / 上行 | NOT TESTED（依赖 WiFi） |
| APP 下行 ACK | NOT TESTED（无在线节点可下发） |

这是现场 WiFi 环境问题，不是固件缺陷。完整记录见 `esp32-com9-serial-observation.txt`。

**已定位到具体 SSID 与网关地址**（只读核对固件配置，未烧录）：

| 配置项 | 值 | 来源 |
|---|---|---|
| WiFi SSID | `ElderCareLab` | `esp32-node/sdkconfig.defaults:2` |
| 网关地址 | `10.188.108.179:9101` | `esp32-node/sdkconfig:489-490` |
| deviceId / room | `esp32-bath` / 卫生间 | `esp32-node/sdkconfig:487-488` |

现场核查确认存在**两个独立阻塞**：

1. 本机 `netsh wlan show networks` **看不到 `ElderCareLab`** → `reason=201` 的直接原因。
2. PC 与 DAYU200 **都没有任何 IPv4 地址**（DAYU `ping` 返回 `Network unreachable`），
   因此即使热点存在，也没有可提供 `9101` 的可达网络与主机 IP。

两项都解决前，ESP32 无法接入 Bridge，APP 下行 ACK 只能保持 `NOT TESTED`。

## 5. 本次仍未验收（不得外推）

| 项目 | 状态 | 原因 |
|---|---|---|
| 真实 OneNET 凭据常驻运行网关 | NOT TESTED | 本轮 OneNET 侧为伪传输层，未使用真实设备密钥 |
| 经真实 OneNET 公网下行驱动 DAYU/ESP32 | NOT TESTED | 未用真实凭据；本轮的 RESET 触发源是本地伪 `property/set` |
| 最终 ESP32 固件 APP 下行 ACK | NOT TESTED | ESP32 实体在线且固件正确，但 WiFi `reason=201` 未接入 Bridge，无在线节点可下发 |
| 真实 PIR / 门磁 / 蜂鸣器 / 实体声学 | NOT TESTED | 传感器悬空或未接线，未做听测 |
| ACK 写入板端 `safety.log` | NOT TESTED | `board-safety.log` 仅含历史两条记录，本轮无新增 |

## 6. 文件清单

### 上行分层验收（第 1.1 节）

| 文件 | 内容 |
|---|---|
| `real-device-results.json` | 17 项断言的结构化结果、PC/设备时间、板端与本地哈希 |
| `gateway-events.jsonl` | 网关事件流（property / alarm / rejected / cloudError） |
| `gateway-harness.out.log` | 网关进程 stdout（含 `LOCAL_SUBSCRIBED`） |
| `broker.out.log` | 真实 Broker 日志（CONNACK、SUBSCRIBE、PUBLISH 转发计数） |
| `board-homemon.log` | 板端 `homemon.log` 原始尾部 |
| `board-status.json` | 板端 `status.json` 快照 |
| `board-safety.log` | 板端 `safety.log`（本轮未新增记录） |

### 真机下行 RESET 闭环验收（第 1.2 节）

| 文件 | 内容 |
|---|---|
| `reset-acceptance-results.json` | 20 项断言的结构化结果 |
| `reset-bridge.out.log` | **真实 Bridge 日志**：`命令已写入节点 dayu200-living 的活动连接: reset` |
| `reset-bridge.err.log` | 修复前为 `无法解析下行命令: reset`；修复后为空 |
| `reset-broker.out.log` | 真实 Broker 日志（含 `PUBLISH home/dayu200-living/cmd (15B)`） |
| `reset-harness.out.log` | 网关诊断：`result=OK baselineSeq=… seenSeq=… seenState=NORMAL` |
| `gateway-reset-events.jsonl` | 下行触发与 `resetResult` 事件 |
| `esp32-com9-serial-observation.txt` | ESP32-S3 在 COM9 的只读串口观察（实体在线、固件版本、WiFi `reason=201`） |

## 7. 复现命令

```powershell
# 只读预检
powershell -ExecutionPolicy Bypass -File <WORKSPACE>\competition\materials\device-preflight.ps1

# 第 1 层：单元测试（36 项）
node <WORKSPACE>\competition\cloud\onenet\gateway.test.js

# 第 2 层：本地真实 Broker 分层验收（14 项）
node <WORKSPACE>\competition\cloud\onenet\gateway-local-integration.js

# 第 3 层：真机上行分层验收（17 项；OneNET 侧为伪传输层，不需要密钥）
powershell -ExecutionPolicy Bypass -File <WORKSPACE>\competition\cloud\onenet\real-device-acceptance.ps1 `
  -Evidence <WORKSPACE>\competition\evidence\2026-10-10-onenet-gateway-real-device

# 第 4 层：真机下行 RESET 闭环（20 项；真实 fport + 真实 Bridge）
powershell -ExecutionPolicy Bypass -File <WORKSPACE>\competition\cloud\onenet\real-device-reset-acceptance.ps1 `
  -Evidence <WORKSPACE>\competition\evidence\2026-10-10-onenet-gateway-real-device

# 不依赖 node:test 运行器的 RESET 语义核对（避免沙箱 spawn EPERM）
node <WORKSPACE>\competition\cloud\onenet\gateway-toctou-check.js
```

板端 homemon 目前仍在运行（演示配置，`no_motion_sec=30`），`/data/homemon/control` 已被清空。
最后一次 RESET 验收使板端状态回到 `NORMAL`（板端日志 `[1609503907] 状态复位 -> NORMAL`）。

注意：`reset` 只清 `state`，`status.json` 中的 `alarm.id`/`alarm.type` 仍保留上一次告警值
（如 `a-1609503903-8`/`MANUAL_SOS`）。这与 `southbound/src/homemon.c:477-480` 的实现一致，
不是网关或验收脚本的缺陷。另外板端每 `report_every_sec`（演示配置 3 秒）才刷新一次
`status.json`，因此验收脚本对“复位是否生效”必须**有界等待**，不能下发后立刻读一次就下结论。
停止板端 homemon：

```powershell
& '<WORKSPACE>\tools\hdc\hdc.exe' shell "pkill homemon"
```

验收脚本自身只**读**板端 `status.json`，唯一的写操作是控制告警触发：`control` 先清空再注入
`sos`（见 `real-device-reset-acceptance.ps1`），因此重复运行是确定性的，不会因上一轮
残留的 `sos` 而产生额外告警。
