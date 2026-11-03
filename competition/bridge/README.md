# 云端桥接（MQTT）— 设计、用法与验证

对应赛题要求：**「基于物联网云平台进行设备管理，以开源鸿蒙 APP 为控制端」**
与创新项：**「预警信息同步推送至子女、社区网格员、物业值班人员等多台手机」**

## 一、架构

```
┌─ 板子 DAYU200 ────────────┐        ┌─ PC（本机）──────────────────┐        ┌─ 云 ─────────┐
│ homemon（南向守护进程）    │        │ mqtt_bridge.js               │        │ MQTT Broker  │
│  status.json  ← 状态       │ ─TCP→  │  · 上行：状态 JSON → PUBLISH │ ─MQTT→ │ (自包含       │
│  control      ← 命令       │ ←TCP─  │  · 下行：SUBSCRIBE → 写命令  │ ←MQTT─ │  mqtt_broker │
└───────────────────────────┘        └──────────────────────────────┘        │  或 EMQX)    │
                                                                              └──────┬───────┘
                                    APP(子女) / APP(网格员) / APP(物业) ← 同一 topic 多订阅者
```

- **上行**：`home/<deviceId>/status`
- **下行**：`home/<deviceId>/cmd`（`ack` / `reset` / `config` / `fall`）
- **多终端推送**：MQTT 天然支持——同一 topic 下 N 个订阅者各自收到同一条预警（无需额外代码）

## 二、🔴 为什么自建 Broker（实测结论）

**本机到 `broker.emqx.io:1883` TCP 不通**（`Test-NetConnection` 返回 False）。
比赛现场 WiFi 同样可能封 1883/8883 → **依赖公网 broker 的演示有翻车风险**。

因此本项目自带 `mqtt_broker.js`（约 100 行，零依赖）：
- 本机或局域网内即可完成"板子 → 桥接 → 云 → 多台手机"全链路；
- 正式部署时换成 EMQX / Mosquitto / 华为云 IoTDA 只需改 `--broker` 地址，**桥接代码不变**。

## 三、文件与用法

| 文件 | 作用 |
|---|---|
| `mqtt_broker.js` | 极简 MQTT 3.1.1 Broker（CONNECT/SUBSCRIBE/PUBLISH/PING，支持 `+` `#` 通配） |
| `mqtt_bridge.js` | 板子状态 ↔ 云端主题的双向桥接（上行发布、下行落地为 homemon 控制命令） |
| `mqtt_tool.js` | 命令行 sub/pub 工具：测试用，也可用来模拟"第二/第三台手机"验证多终端推送 |

```powershell
$node = '<USER_HOME>\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
cd <WORKSPACE>\competition\bridge

# 1) 起 broker（自包含）
& $node mqtt_broker.js 1883

# 2) 起桥接（把板子状态发布到云）
& $node mqtt_bridge.js --broker 127.0.0.1:1883 --device dayu200-01 `
      --status-file .\_test\status.json --cmd-out .\_test\control --interval 1500

# 3) 模拟"子女手机"订阅（可开多个 = 多终端推送）
& $node mqtt_tool.js sub --broker 127.0.0.1:1883 --topic "home/dayu200-01/#" --seconds 30

# 4) 模拟"APP 确认预警"（下行命令 → 事件闭环）
& $node mqtt_tool.js pub --broker 127.0.0.1:1883 --topic home/dayu200-01/cmd --msg-file .\_test\cmd.json
```

> ⚠️ Windows 下用 PowerShell 传 `--msg '{"cmd":"ack"}'` 时，**内层双引号会被吞掉**（实测踩过），
> 所以工具提供 `--msg-file`：把 JSON 写进文件再传路径，稳妥。

## 四、验证结果（2026-10-09 实测）

| 环节 | 证据 |
|---|---|
| 连接与订阅 | `[MQTT] 已连接 127.0.0.1:1883` / `订阅成功: home/dayu200-01/cmd` |
| **上行** | 状态文件变更 → `[bridge] → home/dayu200-01/status state=ALARM` → 订阅端收到完整 JSON |
| **下行** | 发布 cmd → `[bridge] ← home/dayu200-01/cmd` → `control` 文件出现 `ack a-test-1 已联系社区网格员上门查看，老人一切正常`（UTF-8 校验通过） |
| **多终端** | broker 日志 `PUBLISH home/dayu200-01/cmd (91B) → 转发给 2 个订阅者`；`status` 转发给订阅端 |
| 状态回传 | 修改 status.json 为 `ACKED` → 订阅端再次收到更新后的状态 |

## 五、与板子的对接

**实现方式**：homemon 内置 TCP **服务端**（配置项 `tcp_port=9000`），桥接用 `--status-tcp` 作为**客户端**读取。
板子侧零网络配置要求（实测 `eth0/eth1/wlan0` **都没有 IP**），通过 `hdc fport` 把 PC 的 9000 映射到板子 9000：

```powershell
# 板子：OH 7.0 的用户态为 32 位，启动带 TCP 通道的 ARM32 homemon
hdc shell "pkill homemon; sleep 2"
hdc file send out\homemon-arm /data/local/tmp/homemon
hdc shell "(/data/local/tmp/homemon /data/local/tmp/homemon.conf > /data/local/tmp/hm.log 2>&1 &)"

# PC：建端口转发 + 起桥接（⚠️ 必须同一条命令内，原因见下）
hdc fport tcp:9000 tcp:9000
node mqtt_bridge.js --broker 127.0.0.1:1883 --device dayu200-01 --status-tcp 127.0.0.1:9000
```

### ⚠️ 环境坑：`hdc fport` 规则不能跨命令存活

实测：在一条命令里建立转发后，**下一条命令里 `hdc fport ls` 就变成 `[Empty]`**（hdc 服务进程 PID 每次都变）。
原因是本执行环境的每条命令结束后会回收其子进程，hdc 服务随之重启、转发规则丢失。

**对策**：把「建 fport + 起桥接」放在**同一个任务**里执行（本项目已验证可行）。

### 历史真机链路记录（2026-10-09）

> 本节记录早期单设备链路，不能覆盖后来新增的严格 alarmId、
> `pendingDeviceId + pendingAckId`、目标 route 和 12 秒离线判定。
> 当前验证结论统一以 `docs/VALIDATION-MATRIX.md` 为准。

```
板子 homemon(GPIO/传感器 → 状态机)
   └─ TCP:9000 ──hdc fport──▶ PC 桥接 ──MQTT──▶ 云 Broker ──▶ 订阅端(手机/网格员/物业, 可多个)
                                         ◀── cmd(ack/reset) ──┘
```

| 环节 | 实测证据 |
|---|---|
| 板子 TCP 监听 | `netstat`: `0.0.0.0:9000 LISTEN 3221/homemon` |
| 桥接接入 | `[bridge] 已连接板子 TCP 状态通道 127.0.0.1:9000` |
| **上行（真实数据）** | 订阅端连续收到板子状态：`{"state":"NORMAL",...}`（含板子自己的时间戳） |
| **下行（真实闭环）** | 发布 cmd → 板子日志 `[1501926923] ACK 收到确认： a-real-1 已联系社区网格员上门查看，老人一切正常`；状态转为 `"state":"ACKED"` |
| **居家安全日志** | 板子 `/data/homemon/safety.log` 出现 `1501926923,a-real-1,已联系社区网格员上门查看，老人一切正常` |
| 多终端 | broker 日志显示同一 topic 转发给多个订阅者 |

**结论边界：本节只能证明当时版本的单设备上行和 ACK 数据链路；当前版本仍需第三轮真机复验。**

### 备选通道（现场兜底）

| 方案 | 做法 | 状态 |
|---|---|---|
| A. USB + `hdc fport`（当前采用） | 不依赖板端网络；最新版脚本使用 JSON 协议探针 | ⏳ 待第三轮完整复验 |
| B. 局域网 TCP | 给板子配好 WiFi/IP 后，homemon 直接监听、桥接连板子 IP | ⏳ 板子网络未配置 |
| C. hdc 文件同步 | 桥接写 `control` 后由脚本 push 到板子 | ✅ 代码内已作降级路径 |

## 六、多节点支持（2026-10-09 新增并真机验证）

赛题创新项「**可扩展多节点 / 星闪自组网**」的落点：一个桥接进程可同时接入多个房间节点，
**设备编号由报文自身的 `deviceId` 决定**，新增节点（ESP32-S3 / 另一块板子 / 同板多实例）**无需改动桥接代码**。

```powershell
# 一个桥接进程接入 3 个节点（逗号分隔）
node mqtt_bridge.js --broker 127.0.0.1:1883 \
     --status-tcp 127.0.0.1:9000,127.0.0.1:9001,127.0.0.1:9002 --cmd-out control
```

南向节点侧只需在配置里写：

```ini
device_id=dayu200-bedroom     # 设备编号（决定 MQTT 主题）
room=卧室                      # 房间名（随报文上报，供 APP 展示）
tcp_port=9001                 # 每个节点一个端口
dir=/data/homemon2            # 每个节点独立运行目录
```

### 真机验证结果（同板跑两个 homemon 实例模拟两个房间）

| 验证项 | 实测证据 |
|---|---|
| 双节点接入 | `[bridge] 已接入节点 127.0.0.1:9000` / `127.0.0.1:9001` |
| **按 deviceId 分发主题** | `→ home/dayu200-living/status  room=客厅 countToday=39` 与 `→ home/dayu200-bedroom/status  room=卧室 countToday=0` **各自独立** |
| 订阅端同时看到 | `[tool] ← home/dayu200-bedroom/status` 与 `← home/dayu200-living/status` 交替到达 |
| **下行按设备路由** | 只向 `home/dayu200-bedroom/cmd` 发 `{"cmd":"sos"}` → **卧室 `state=ALARM`（alarm MANUAL_SOS）**，而**客厅仍 `state=NORMAL`**（计数正常累加，未受影响） |
| 端口独立 | `netstat`: `0.0.0.0:9000 LISTEN` 与 `0.0.0.0:9001 LISTEN` 并存 |

**结论：多房间（多节点）的采集、上云、下发路由三层均已跑通，为接入 ESP32-S3 无线节点做好了全部准备。**

### APP 侧：设备自动发现 + 切换（2026-10-09 真机验证）

APP 已实现**设备自动发现 + 切换**（2026-10-09 真机验证）：

| 验证项 | 实测证据 |
|---|---|
| 自动发现多节点 | APP 同时连接 `:9000` 与 `:9001`，顶部标签出现 **[卧室] [客厅]**，诊断行"在线 2 个节点" |
| 数据按房间区分 | 切到**卧室** → 今日活动 `0 次`；切到**客厅** → 今日活动 `47 次`（与各自 `status.json` 逐项一致） |
| 告警按房间区分 | 卧室 `state=ALARM` 时顶部显示"异常告警"，告警卡片带房间名前缀（`主动求助 · 卧室 · 17:24`） |
| **闭环按节点路由** | 在 APP 对**卧室**告警点"确认闭环" → 卧室 `safety.log` 写入 `1501925094,a-1501925063-2,已确认，老人一切正常`，状态转 `ACKED`；而**客厅日志仍为空**（未受影响） |
| 界面回显 | 卡片变为"已闭环"，显示处置结果与确认时间 |

## 七、无线节点接入（`--listen`，2026-10-09 验证）

无线节点（ESP32-S3）**不实现 MQTT**，而是说与 `homemon` **逐字段相同的 JSON 行协议**，
主动连到网关的监听端口 —— 桥接与 APP **零改动**即可接住。

```powershell
node mqtt_bridge.js --broker 127.0.0.1:1883 --listen 9100
```

### 验证结果（用软件模拟节点 `sim_node.js` 先跑通路径）

| 环节 | 实测日志 |
|---|---|
| 监听 | `监听端口 : 9100（等待无线节点接入）` |
| 节点接入 | `[bridge] 无线节点接入 ::ffff:127.0.0.1:59522` |
| **上行** | `[bridge] → home/esp32-sim-bath/status  state=NORMAL room=卫生间` |
| **下行路由** | 发布 `home/esp32-sim-bath/cmd {"cmd":"gas"}` → `[bridge] 命令已发往节点 esp32-sim-bath: gas` |
| 状态回传 | 节点随即转为 `state=ALARM`，`alarm.type=GAS` 回传云端 |
| 订阅端可见 | `[tool] ← home/esp32-sim-bath/status`；当前 APP 标签显示仍需单独真机取证 |

> 结论：2026-10-09 的基线模拟节点已人工跑通 TCP、Bridge 与 MQTT 路径；新增 profile 另有软件自动化测试。两者都不代表实体传感器验收。
> 模拟节点脚本：`bridge/sim_node.js`（也可用于现场临时补一个房间节点）。

#### 厨房 / 卧室软件模板（不替代实体验收）

硬件未到时，可用独立 profile 验证两个房间的设备 ID、告警类型与命令闭环互不串线：

```powershell
node sim_node.js --profile kitchen --gw 127.0.0.1:9100
node sim_node.js --profile bedroom --gw 127.0.0.1:9100
```

- `kitchen` 默认是 `esp32-kitchen / 厨房`，模拟温湿度、燃气、烟雾和 SOS。
- `bedroom` 默认是 `esp32-bedroom / 卧室`，模拟人体活动、门磁、温湿度和 SOS。
- `--id`、`--room`、`--every` 仍可覆盖默认值；ID、端口和周期会严格校验。
- 不启动 Broker 或 Bridge，也能运行 `node sim_multiroom_check.js` 做房间隔离、能力隔离和精确 ACK 自检。

以上结果只属于**软件协议和路由模拟**。实体烟雾/燃气报警器、人体存在、门磁、压力垫的接线、阈值、误报率和实际安装位置仍需硬件到货后分别验收。

### 让无线节点也出现在**板上 APP** 里：`--relay-to`

板上 APP 只能连本机端口，无线节点只能连到 PC —— 两者本来看不到对方。
桥接用 `--relay-to` 把其他节点的状态**注入板的 homemon**（homemon 用 `relay` 命令广播给所有客户端）：

```powershell
node mqtt_bridge.js --broker 127.0.0.1:1883 `
     --listen 9100 --relay-to 127.0.0.1:9000
```

| 环节 | 实测日志（`link_probe.js` 模拟板上 APP） |
|---|---|
| 有线节点 | `[probe] ← dayu200-living (客厅) state=NORMAL count=47` |
| **无线节点（注入）** | `[probe] ← esp32-bath (卫生间) state=NORMAL count=0` |
| 汇总 | `[probe] 汇总：看到 2 个设备 → dayu200-living , esp32-bath` |

> 为此 homemon 的 TCP 通道已升级为**多客户端**（最多 4 路）：APP 与桥接可同时接入，
> 桥接注入的行会广播给全部客户端。验证工具：`bridge/link_probe.js`。

## 八、目标路由协议（从 APP 向无线节点下发命令）

APP 把无线节点的命令发给 homemon；桥接从 `--relay-to` 指向的 homemon socket 读到 `route` 行后，按 `deviceId` 转发给对应无线节点。

**格式**：`route <deviceId> <原命令>`  
**示例**：`route esp32-bath ack alarm-1 已电话确认`

| 流向 | 说明 |
|---|---|
| APP → homemon | APP 发送 `route esp32-bath ack alarm-1 已电话确认` |
| homemon 本机判断 | 目标 `deviceId` 等于 DAYU 本机时，homemon 本机执行命令；目标为无线节点时，homemon **只广播该 route 行**（不执行） |
| homemon → 桥接 | 桥接从 relay socket 读到该行，解析出 `deviceId` 和原命令 |
| 桥接 → 无线节点 | 桥接按 `deviceId` 查找对应的无线节点连接，把原命令发给该节点 |

同一 `deviceId` 同时出现多条连接时，最后完成合法身份绑定的新连接成为唯一活动连接，旧连接立即关闭且不再允许发布状态或接收命令。连接启用 TCP keepalive；同一 socket 中途更换 `deviceId` 或使用非法 ID 会被拒绝。

**安全约束**：
- `deviceId` 白名单：`[A-Za-z0-9._-]{1,64}`
- CR/LF 字符清洗（防注入）
- 禁止嵌套 `route` / `relay`
- 设备离线或未知时拒绝

**ACK 命令特殊要求**：
- 节点只接受 `alarmId` 精确匹配且当前状态为 `ALARM` 的 ACK
- 错误 `alarmId` 或重复 ACK 不改变状态

**验证覆盖**（本地 socket 集成测试，尚未真机验证）：
- 拆包场景（`route` 命令跨 4 个 TCP 分片到达）
- 错误 `alarmId`（节点拒绝，状态不变）
- 正确 `alarmId`（节点状态转 `ACKED`）
- 重复 ACK（节点忽略）
- 未知 `deviceId`（桥接拒绝）
- 非 `route` 命令（桥接忽略，不转发给无线节点）

## 九、在线判定与超时离线

### 共享连接下的单设备离线检测

当 homemon relay 与 DAYU 共用 APP socket 时（无线节点经 relay 注入），单个无线节点断开**不会触发 TCP Link close**。  
因此 APP 采用**本地 lastSeen 超时机制**：

- **lastSeenMs**：每次收到合法状态行时，DevSnap 记录 `Date.now()`（不信任设备 ts）
- **超时判定**：每 3 秒定时器检查所有快照，超过 **12 秒**未收到该设备状态 → `online=false`
- **自动恢复**：新状态到达时自然生成 `online=true` 快照
- **闭环拒绝**：`doAck` 已有 `snap.online` 检查，离线时拒绝下发

**Link 真正断开时**，现有 `deviceIds` 全量 `markOffline` 保留（双重保障）。

**验证状态**：代码已实现，尚未真机断开/恢复测试。

## 十、自动恢复与运维参数（2026-10-27 加固）

### 10.1 日志时间戳

所有 bridge 日志现在带 ISO 时间戳前缀（`[2026-10-27T14:41:22.123Z] [bridge] ...`）。2026-10-27 复盘时
`bridge.out.log` 没有时间戳，无法把"节点断开/重连/relay 恢复"对齐到真实时刻；消息正文与旧版逐字一致，
既有按子串匹配的脚本/测试不受影响。

### 10.2 relay 通道断线重连与状态补发

- `--relay-to` 连接加 TCP keepalive（10s 空闲探测），半开连接不再永久假死；
- relay 断开期间入站设备状态**不再静默丢弃**：每台设备只缓存最后一条，relay 恢复后自动补发
  （`relay 通道已恢复：补发 N 台入站设备的最后状态`），DAYU 不必等下一次上报；
- 设备真正断开时清掉它的 relay 缓存，**绝不补发"假在线"旧状态**；
- 重连退避 3s→6s→12s→24s 封顶 30s，绝不永久停止重试。

### 10.3 MQTT 重连后重放最后状态

本自包含 broker 不实现 retain。bridge 现在缓存每台设备最后状态，MQTT 重连成功后重放一次
（`MQTT 重连后重放最后状态：<deviceId>`），broker 重启/网络闪断期间云端与 APP 不会永久停在旧值。

### 10.4 `--relay-ignore <deviceId,...>`

板端 status 端点会收到 homemon 广播的所有 `relay` 行。若某设备的 relay 由**板外进程**直接注入
homemon（例如随身求助 mirror 注入 `esp32-sos`），桥接并不持有它的连接；旧逻辑会把这种回灌当成
"板端连接改名"并 retire 板端连接（DAYU 永久失联）。列入 `--relay-ignore` 的 deviceId 在板端连接上
一律只忽略：不 bindNode、不发布、不 retire，并限频记一条日志。

```powershell
node mqtt_bridge.js --broker 127.0.0.1:1883 --status-tcp 127.0.0.1:9001 `
     --listen 9101 --relay-to 127.0.0.1:9001 --relay-ignore esp32-sos `
     --lock-file .\_test\current-runtime\supervisor\bridge.lock
```

### 10.5 `--lock-file <path>` 单实例锁

两个 Bridge 同时连同一 broker/relay 会重复发布状态、重复注入 relay。`--lock-file` 用 PID 锁文件
保证单实例：第二个实例退出码 3；死 PID 的陈旧锁自动接管（不需要人工删文件）。不传该参数时行为与旧版一致。

### 10.6 端口健康探测不再污染日志

`demo-autostart` 每 2s 的 `Test-Tcp(1883/9101)`、`start-demo-supervisor` 预检、`nc` 等探测会连上
9101 立刻断开。现在只有**收到合法状态行并完成 deviceId 绑定**才记
`无线节点接入并完成身份绑定：<deviceId>`；裸探测最多每 60s 记一条
`忽略未识别的探测连接（... 未发送状态行；不计为节点接入）`。

### 10.7 回归测试

```powershell
cd <WORKSPACE>\competition\bridge
node --test bridge_auto_recovery.test.js   # 6 项：relay 恢复补发、旧缺陷复现、MQTT 重放、探测日志、单实例锁
node --test                                 # 全目录
```

测试中的假节点、假 relay、假 broker 端口均为 **mock**，只证明传输层协议与恢复逻辑，不代表真实 ESP32/DAYU 链路。

