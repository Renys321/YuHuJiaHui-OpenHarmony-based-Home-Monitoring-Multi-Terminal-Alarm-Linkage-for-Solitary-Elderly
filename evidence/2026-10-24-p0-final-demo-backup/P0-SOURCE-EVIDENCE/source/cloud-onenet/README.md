# OneNET OneJSON 协议适配层

本目录负责项目内部状态与 OneNET OneJSON 消息之间的转换，以及独立的 MQTT 3.1.1 over TLS 传输。代码不保存或输出产品密钥、设备密钥、Token、账号或密码。

协议适配和 Token 算法使用 Node.js 原生 CommonJS；MQTT 协议使用锁定版本的 `mqtt.js`。设备密钥由调用方回调或部署平台 Secret 在运行时注入，传输层不会从 `.env` 文件自动加载，也不会把 MQTT password 放进事件或错误信息。

## 已核验的云端接入参数

以下参数于 2026-10-10 根据 OneNET 产品控制台和官方文档核验，仅包含公开元数据：

| 参数 | 值 |
|---|---|
| 产品 ID / MQTT username | `I19NBBq4xe` |
| 设备名称 / MQTT clientId | `dayu200-home-gateway` |
| 推荐协议 | MQTT 3.1.1 over TLS |
| 产品专属 TLS 地址 | `I19NBBq4xe.mqttstls.acc.cmcconenet.cn:8883` |
| 产品专属明文地址 | `I19NBBq4xe.mqtts.acc.cmcconenet.cn:1883`，仅用于受控诊断，不用于生产 |
| 官方公共 TLS 地址 | `mqttstls.heclouds.com:8883` |
| 官方公共明文地址 | `mqtts.heclouds.com:1883` |

MQTT password 是运行时生成的设备级 Token，不是 OneNET 网页账号密码。Token 使用设备级资源 `products/I19NBBq4xe/devices/dayu200-home-gateway`，版本为 `2018-10-31`，过期时间为 Unix 秒，签名推荐 `sha256`。签名密钥必须从安全存储或进程环境注入，禁止写入源码、配置样例、测试夹具或日志。

设备需发布属性与事件请求，并订阅平台响应和受限控制下行：

```text
publish   $sys/I19NBBq4xe/dayu200-home-gateway/thing/property/post
subscribe $sys/I19NBBq4xe/dayu200-home-gateway/thing/property/post/reply
subscribe $sys/I19NBBq4xe/dayu200-home-gateway/thing/property/set
publish   $sys/I19NBBq4xe/dayu200-home-gateway/thing/property/set_reply
publish   $sys/I19NBBq4xe/dayu200-home-gateway/thing/event/post
subscribe $sys/I19NBBq4xe/dayu200-home-gateway/thing/event/post/reply
```

注意 OneJSON 的属性设置响应主题是 `property/set_reply`，不是 `property/set/reply`。属性和事件中的 `time` 均为 UTC Unix epoch 毫秒。

## 安全传输层

```js
const { createTransportFromEnv } = require('./transport');

const transport = createTransportFromEnv(process.env, {
  handleCommand: async (command, context) => {
    // 调用 DAYU 命令路由并等待真实设备结果，再返回 { ok, message? }。
    return applyCommand(command, context.requestId);
  }
});

transport.on('transportError', ({ code }) => console.error('OneNET transport:', code));
transport.start();
await transport.waitForReady();

await transport.publishProperty(currentStatus, {
  id: nextNumericMessageId(),
  timestampMs: Date.now()
});
```

运行环境需要 `ONENET_PRODUCT_ID`、`ONENET_DEVICE_NAME` 和 `ONENET_DEVICE_KEY`。前两项是非敏感元数据，`ONENET_DEVICE_KEY` 必须由系统服务、部署平台 Secret 或等价安全存储注入；不要把它写进 `.env`、PowerShell 脚本、命令行参数、测试文件或日志。

OneNET 官方 MQTT CA 来自其官方文档的“证书下载”包。当前证书是无 SAN 的自签名 `CN=OneNET MQTTS`，标准 DNS 主机名检查无法通过。因此本实现保持 `rejectUnauthorized=true`，同时使用官方 CA 验证证书链并固定叶证书 SHA-256 指纹 `7D:E9:BC:4C:1A:ED:01:34:46:67:64:56:78:D4:49:74:12:10:B1:70:49:48:98:38:BF:63:79:53:B3:E9:01:17`。证书轮换时必须从 OneNET 官方文档重新取得 CA、核验后同时更新证书与指纹，不能通过关闭验证解决。

安全行为：

- 强制 `mqtts://`、官方 CA 验证和证书指纹固定，不提供关闭证书验证的选项。
- 使用 QoS 1，但 PUBACK 只表示 Broker 收到；属性/事件上报还必须收到 OneNET `code=200` 回复才完成。
- 每次断线重连重新读取设备密钥并生成新的短期 Token，使用指数退避，避免复用过期 Token。
- 只订阅属性/事件回复和 `property/set`，只执行适配器白名单内的 `ACK`、`RESET`、`SET_CONFIG`。
- 无效下行只返回通用错误，不回显原始载荷；单条收发消息限制为 16 KiB。
- 2026-10-10 已通过隐藏运行时注入完成真实设备级 Token 登录：MQTT CONNECT、主题订阅和属性上报均成功，OneNET 对 `property/post` 返回 `code=200`，设备列表记录最近在线时间 `2026-10-10 22:08:01`。
- 同日通过 `downlink-check.js` 接收真实 `control.command=RESET`，并回发 `property/set_reply code=200`；OneNET 设备调试页显示外层 `code=0`、内层设备回复 `code=200`。该一次性处理器只验证公网协议闭环，没有执行 DAYU/ESP32 动作。

## 文件

| 文件 | 用途 |
|---|---|
| `adapter.js` | topic 构造、属性/事件上行、受限属性下行和回复载荷 |
| `token.js` | OneNET 设备级短期 Token 的 HMAC-SHA256 生成与输入校验 |
| `transport.js` | MQTTS、证书校验、重连、订阅、云端业务确认和下行处理 |
| `gateway.js` | **常驻家庭云网关**：本地 `home/+/status` 聚合上云，受限下行驱动真实设备 |
| `gateway-local-integration.js` | 分层验收：真实本地 Broker + 真实 MQTT 报文 + 伪 OneNET Transport |
| `real-device-harness.js` | 真机验收用网关进程：真实网关代码 + 伪 OneNET 传输层，事件写 JSONL |
| `real-device-acceptance.ps1` | 真机分层验收编排（PowerShell 负责 hdc，Node 只负责 MQTT） |
| `tls-live-check.js` | OneNET 8883 真实 TLS 自检（官方 CA + 指纹固定，无凭据、不发 MQTT） |
| `cloud-sync.js` | 把网关聚合状态同步到可信后端 `/internal/v1/device-status`（小程序的数据来源） |
| `cloud-sync.test.js` | 同步客户端契约与降级语义测试 |
| `cloud-sync-integration.js` | 网关 -> 真实后端 -> 小程序查询接口 的端到端验收 |
| `command-sync.js` | 轮询可信后端 ACK 队列，精确定向本地设备并将真实回执写回后端 |
| `command-sync.test.js` | 命令校验、定向发布、回执绑定、幂等和结果回写重试测试 |
| `command-sync-integration.js` | 小程序 ACK -> 真实后端 HTTP -> 同步器 -> 模拟设备 -> 后端闭环验收 |
| `persistent-command-restart-integration.js` | 后端三次生命周期中恢复 PENDING、完成 ACKED 并再次查询的验收 |
| `gateway-toctou-check.js` | 不依赖 `node:test` 的 RESET 语义核对 |
| `live-check.js` | 一次性真实上行检查；收到 `code=200` 后保持连接 10 秒并安全退出 |
| `downlink-check.js` | 一次性真实 `RESET` 下行检查；仅做严格解析和回复，不执行硬件动作 |
| `activate-onenet.ps1` | 隐藏读取设备密钥，仅通过子进程环境传递并在退出时清理 |
| `certs/onenet-mqtt-ca.pem` | OneNET 官方 MQTT CA 公共证书，用于证书链验证与指纹固定 |
| `thing-model.json` | 项目使用的属性、事件与受限控制物模型 |
| `thing-model.onenet-import.json` | 保留平台标准功能点并加入项目字段的 OneNET 导入文件 |
| `build-import-model.js` | 从 OneNET 官方导出文件重新生成并校验导入文件 |
| `*.test.js` | `node:test` 协议、Token、TLS 选项和状态机边界回归 |
| `package.json` / `package-lock.json` | 锁定 `mqtt.js` 运行依赖 |

## Topic

```js
const { buildTopics } = require('./adapter');

const topics = buildTopics('PRODUCT_ID', 'esp32-bath');
// topics.propertyPost     $sys/PRODUCT_ID/esp32-bath/thing/property/post
// topics.propertySet      $sys/PRODUCT_ID/esp32-bath/thing/property/set
// topics.propertySetReply $sys/PRODUCT_ID/esp32-bath/thing/property/set_reply
// topics.eventPost        $sys/PRODUCT_ID/esp32-bath/thing/event/post
```

`productId` 和 `deviceName` 只允许 `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`。斜杠、空白、`$`、路径片段、中文和超长值会被拒绝，不能借输入改变 topic 层级。

## 状态转 property/post

```js
const { toPropertyPost } = require('./adapter');

const payload = toPropertyPost({
  deviceId: 'esp32-bath',
  room: '卫生间',
  online: true,
  state: 'NORMAL',
  sensors: {
    motion: { lastActiveTs: 1791608769555, countToday: 3 },
    door: { open: false, lastOpenTs: 0 },
    climate: { tempC: 24.6, rh: 41.2, ok: true },
    gas: { raw: 123, ok: true },
    smoke: { raw: 45, ok: true }
  },
  fall: { detected: false, confidence: 0.03, detectedAt: 0 },
  alarm: { id: '', type: '', countToday: 0 },
  csq: 24
}, {
  id: '1001',
  timestampMs: Date.now()
});
```

所有 OneJSON 属性使用同一个 UTC Unix epoch 毫秒时间。显式时间必须是 13 位安全整数；不传时使用 `Date.now()`。消息 `id` 必须是最多 13 位的纯数字字符串。内部传感器的 `lastActiveTs`、`lastOpenTs` 和 GNSS `fixTime` 允许用 `0` 表示未知，非零值必须是毫秒时间，禁止混入 10 位秒值。GNSS 还携带 `valid`，用于明确区分室内无有效定位和真实坐标。

## 告警转 event/post

```js
const { toAlarmEvent } = require('./adapter');

const payload = toAlarmEvent(alarmStatus, {
  id: '1002',
  timestampMs: Date.now()
});
```

只有 `state=ALARM`、非空告警编号以及白名单告警类型才能形成 `safetyAlarm` 事件。支持 `NO_MOTION`、`MANUAL_SOS`、`CLIMATE`、`GAS`、`SMOKE` 和 `FALL`。

## property/set 下行

适配器只接受唯一的 `control` 属性。允许直接值或 OneJSON `{ "value": ... }` 包装：

```json
{
    "id": "1001",
  "version": "1.0",
  "params": {
    "control": {
      "command": "ACK",
      "alarmId": "e-1791608811-2",
      "action": "已电话确认老人安全"
    }
  }
}
```

```js
const { mapPropertySet, makePropertySetReply } = require('./adapter');

const request = mapPropertySet(receivedPayload);
// request.requestId 必须用于 property/set_reply
// request.command 是经过校验的内部结构，不是可直接执行的 shell 文本

const reply = makePropertySetReply(request.requestId, { ok: true });
```

白名单如下：

| 命令 | 必需字段 | 限制 |
|---|---|---|
| `ACK` | `alarmId`、`action` | 非空；拒绝 CR/LF 和其他控制字符 |
| `RESET` | 无 | 出现任何额外字段即拒绝 |
| `SET_CONFIG` | `noMotionSec` 和/或 `reportIntervalSec` | 至少提供一个，只允许这两个扁平配置项 |

安全配置范围：

| 配置 | 范围 |
|---|---|
| `noMotionSec` | 30 到 86400 秒 |
| `reportIntervalSec` | 1 到 3600 秒 |

OneNET 只支持 `r` 和 `rw` 属性，因此云端物模型中的 `control` 标为 `rw`；适配器仍只把它作为受限下行命令处理。平台不允许结构体嵌套，所以 `SET_CONFIG` 在 OneJSON 中使用扁平字段，适配器校验后再映射为内部 `config` 对象。

下行采用逐层精确字段校验。未知命令、未知属性、旧版嵌套 `config`、额外字段、Wi-Fi/密码、主机、端口、文件路径、脚本、超范围数值、控制字符、错误协议版本和超过 16 KiB 的载荷均被拒绝。调用方仍须在真正执行 `ACK` 时核对当前 `alarmId` 和设备状态，并在执行 `SET_CONFIG` 时采用原子更新与持久化校验。

## 常驻家庭云网关（`gateway.js`）

把 `transport.js` 的安全 OneNET 通道接到本地 MQTT 链路，形成可启动、可停止、可重连的常驻进程。

```text
本地 MQTT home/+/status
  -> adapter.js 严格校验与归一化
  -> 聚合为家庭状态（保留房间来源）
  -> OneNET property/post；新 alarmId 额外发 event/post(safetyAlarm)

OneNET property/set
  -> adapter.js 白名单校验
  -> 第一阶段只执行“网关自身 RESET”
  -> 命令真的到达 home/<deviceId>/cmd 并收到真实回执才回复 code=200
```

### 启动与停止

```powershell
cd <WORKSPACE>\competition\cloud\onenet
# ONENET_DEVICE_KEY 必须由系统 Secret 注入，不要写进命令行或文件
npm run gateway
```

正常退出使用 `Ctrl+C`（SIGINT）或 SIGTERM；进程会清理本地 MQTT 连接、离线扫描定时器和全部
pending 回执等待，不会留下悬挂 Promise。

**缺少或错误的设备密钥不会终止进程**（2026-10-10 实测）：网关会先连上本地 Broker 并订阅
`home/+/status`，OneNET 侧按指数退避重试，本地告警与聚合继续可用。此时日志只有安全错误码：

```text
[gateway] START mode=self device=dayu200-living
[gateway] LOCAL_SUBSCRIBED topic=home/+/status
[gateway] CLOUD_TRANSPORT_ERROR code=CONNECT_SETUP_FAILED
```

**但缺失非敏感必填元数据会 fail fast**，避免进程“看起来在运行”却永远不会成功：

```text
[gateway] FATAL code=MISSING_CONFIGURATION message=missing required configuration: ONENET_PRODUCT_ID, ONENET_DEVICE_NAME
```

启动时会打印非敏感配置自检（`deviceKey` 只显示 `set`/`unset`，绝不打印密钥值）：

```text
[gateway] CONFIG productId=I19NBBq4xe deviceName=dayu200-living
[gateway] CONFIG deviceKey=unset
```

排查启动失败时可用 `GATEWAY_DEBUG=1` 打印堆栈；默认日志只输出安全错误码与消息，不带载荷或密钥。

### 配置（环境变量）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `ONENET_PRODUCT_ID` | 必填 | 非敏感元数据 |
| `ONENET_DEVICE_NAME` | 必填 | 同时用作“网关自身设备”的 deviceId |
| `ONENET_DEVICE_KEY` | 必填 | **只允许**系统 Secret 或隐藏输入注入 |
| `GATEWAY_BROKER_URL` | `mqtt://127.0.0.1:1883` | 本地 Broker |
| `GATEWAY_STATUS_TOPIC` | `home/+/status` | 本地状态订阅主题 |
| `GATEWAY_RESET_MODE` | `self` | `local` / `self` / `target`，见下 |

`GATEWAY_RESET_MODE`：

- `local`：只复位网关自身的聚合状态，**不下发**到任何房间设备。
- `self`（默认）：把 `reset` 发给 `ONENET_DEVICE_NAME` 对应的那台设备，等待真实回执。
- `target`：仅当**恰好一台**设备在线时下发；多于一台或零台一律拒绝，避免误伤。

### 设计要点

1. **限频上云**：状态变化立即上云；稳定状态按 30 秒限频，避免设备每 5 秒上报就无限刷云。
2. **事件去重**：只对新的 `alarmId` 发布 `safetyAlarm`，记忆以 `deviceId + alarmId` 为键且与设备
   当前状态解耦。设备 `reset` 后收到同一条 retained 报文也不会重复告警。
3. **在线判定**：设备报文里**没有** `online` 字段（ESP32 也没有），因此按本地 `lastSeen` 判在线，
   12 秒阈值与北向 APP 一致，绝不信设备字段。
4. **13 位毫秒校验**：`adapter.js` 不读取根级 `ts`（云端时间由调用方传入），所以网关显式补上
   13 位毫秒校验。`bridge/status.json` 中真实存在 10 位秒值的历史样本，这类报文会被拒绝。
5. **云断线不影响本地**：上云失败只记录安全错误码，本地告警与聚合继续工作。
6. **日志边界**：只记录 productId、deviceName、deviceId、命令类型和安全错误码，不记录载荷全文或密钥。

### 关于 retained 报文

本地 Bridge 用 `retain=true` 发布 `home/<deviceId>/status`（`bridge/mqtt_bridge.js:239`），但仓库自带的
`bridge/mqtt_broker.js` 在转发时会剥掉 retain 位（`mqtt_broker.js:86`），所以默认链路并不会“订阅即回放”；
换成真实 Broker 时会回放。去重逻辑对两种行为都安全。

### 第一阶段下行范围

当前物模型 `control` **没有** `deviceId` 字段，因此无法把 `ACK` 安全绑定到具体设备。按已确认的
第一阶段范围：

- 只执行**网关自身 RESET**，且必须等真实设备回执才回复 `code=200`。
- `ACK` 与 `SET_CONFIG` 一律回失败，**不猜测“当前房间”**，也不产生任何部分生效。
- 打通手机确认闭环需要先给 `control` 增加可选 `deviceId` 并同步修改物模型与适配器测试，
  属于后续阶段。

### 分层验收

```powershell
# 第 1 层：单元测试，全部依赖注入，不连接真实 OneNET 或真实 Broker
node gateway.test.js

# 第 2 层：真实本地 Broker + 真实 MQTT 报文 + 伪 OneNET Transport
node gateway-local-integration.js
```

`gateway-local-integration.js` 会自行拉起 `bridge/mqtt_broker.js`、用真实 MQTT 客户端订阅
`home/+/status`，并用 `bridge/mqtt_tool.js` 以真实设备报文形状发布，覆盖正常上云、稳定限频、
新告警去重、非法报文拒绝、10 位秒值拒绝、RESET 失败与成功闭环、云断线不影响本地，共 14 项断言。

### 第 3 层：DAYU200 真机分层验收

```powershell
# 只读预检（不安装、不启动、不写板端）
powershell -ExecutionPolicy Bypass -File <WORKSPACE>\competition\materials\device-preflight.ps1

# 真机验收：真实板端状态 + 真实本地 Broker + 真实网关代码，OneNET 侧为伪传输层（无需密钥）
powershell -ExecutionPolicy Bypass -File .\real-device-acceptance.ps1 `
  -Evidence <WORKSPACE>\competition\evidence\<本轮证据目录>
```

2026-10-10 实测结果 **17/17 通过**，证据见 `evidence/2026-10-10-onenet-gateway-real-device/`：
真实板端 `dayu200-living` 的状态经真实 Broker 到达网关并生成 OneNET `property/post`
（保留 `room=客厅`）、稳定状态被限频、板端真实 `MANUAL_SOS` 告警（`a-1609503175-2`）产生一次
`safetyAlarm`、同一 `alarmId` 重复上报不重复告警、板端新告警 `a-1609503256-3` 正常告警一次。

注意：该层仍**不涉及真实 OneNET 凭据**，因此不能替代“真实公网常驻已通过”。
另外该脚本必须由 PowerShell 编排（沙箱下 Node 无法用管道 stdio 调用 `hdc`），
且发布 JSON 必须走 `--msg-file`（PowerShell 会吞掉 `--msg` 里的双引号）。

### 第 4 层：真机下行 RESET 闭环

```powershell
powershell -ExecutionPolicy Bypass -File .\real-device-reset-acceptance.ps1 `
  -Evidence <WORKSPACE>\competition\evidence\<本轮证据目录>
```

链路全部真实（含 `hdc fport` 上的真实 `mqtt_bridge.js`），只有 OneNET 传输层是伪的。
2026-10-10 实测 **20/20 通过**：网关把 `{"cmd":"reset"}` 发到 `home/dayu200-living/cmd`，
Bridge 记录 `命令已写入节点 dayu200-living 的活动连接: reset`，板端 homemon 真实执行
`状态复位 -> NORMAL`，网关依据真实回执回复成功。

该轮抓出并修复了两个只有真机能发现的网关缺陷：

1. **下行负载必须是 JSON。** 之前发裸字符串 `reset`，Bridge 记为 `无法解析下行命令` 并静默丢弃。
2. **回执判定不能被过期快照满足。** 现在要求目标当前确实处于 `ALARM`（否则拒绝），且回执必须
   晚于本笔告警被观测到的序号（`device.alarmSeq`）。

对应回归测试见 `gateway.test.js`，另有不依赖 `node:test` 运行器的行为核对脚本
`gateway-toctou-check.js`（沙箱下 `node --test` 会因管道 stdio 报 `spawn EPERM`）。

### 第 5 层：生产入口启动健壮性（不需要密钥）

真机与本地分层验收都走 `real-device-harness.js`（注入伪传输层），因此 `gateway.js` 自己的生产
入口长期没有被执行过。2026-10-10 补测 `npm run gateway`，抓出并修复两个启动期缺陷：

1. **`createGateway` 拒绝 `process.env`**：`process.env` 的原型不是 `Object.prototype`，
   被 `isPlainObject` 判为“非纯对象”，导致 `npm run gateway` 一启动就
   `FATAL message=env must be a plain object`。修复为以“非 null 对象且非数组”校验配置容器。
2. **`transportError` 无人监听**：传输层用该事件上报 `CONNECT_SETUP_FAILED` 等错误，
   网关既不记录也不转发，常驻进程里完全不可见。修复为转成安全的 `cloudError` 事件与日志。

复现验证（无需真实密钥）：

```powershell
# 1) 起真实 Broker
node <WORKSPACE>\competition\bridge\mqtt_broker.js 1883
# 2) 用生产入口启动（不设 ONENET_DEVICE_KEY）
$env:ONENET_PRODUCT_ID='I19NBBq4xe'; $env:ONENET_DEVICE_NAME='dayu200-living'
$env:GATEWAY_BROKER_URL='mqtt://127.0.0.1:1883'
node gateway.js
```

预期：进程保持存活（不退出）并打印 `START` 与 `LOCAL_SUBSCRIBED`；Broker 日志出现该客户端的
`SUBSCRIBE … home/+/status`。

尚未进行（仍为 `NOT TESTED`）：真实 OneNET 凭据下的常驻运行、经真实 OneNET 公网下行驱动 DAYU/ESP32。

## 同步到可信后端（`cloud-sync.js`）

`cloud/backend/README.md` 曾列出“尚未把 OneNET 消息同步到 `/internal/v1/device-status`”。
缺少这一环时，微信小程序永远拿不到云数据。`cloud-sync.js` 补上这一段：

```text
设备 -> 网关 -> OneNET          （已实现，上行验收 17/17）
              -> /internal/v1/device-status -> 小程序查询接口   （本模块）
```

### 配置

| 变量 | 默认值 | 说明 |
|---|---|---|
| `BACKEND_URL` | `http://127.0.0.1:8080` | 可信后端基址 |
| `BACKEND_INGEST_KEY` | 空 | `x-ingest-key`；**缺失时同步自动禁用**，不报错 |
| `BACKEND_TIMEOUT_MS` | `5000` | 单次同步超时 |

安全与降级语义：

- `x-ingest-key` 只从环境变量读取，绝不写入源码、日志或命令行；日志只输出安全错误码。
- 同步是**旁路**：后端慢或不可达只记录错误码，**不阻塞、不影响**本地告警聚合与 OneNET 上报。
- 后端只认 `NORMAL/WARN/ALARM/ACKED`；网关本的 `OFFLINE` 不直接转发，改用 `online=false` 表达。
- `BACKEND_URL` 不得携带凭据、query 或 fragment。

### 端到端验收

```powershell
node cloud-sync-integration.js
```

用**真实后端 HTTP 服务 + 真实同步客户端**跑通：正常状态、告警生成、错误 ingest key 被拒（401）、
小程序会话认证后能看到设备与告警、`ACKED` 结清同一条告警而不重复、后端不可达时安全降级。
预期 **12/12**、退出码 0。

## 从可信后端同步 ACK（`command-sync.js`）

`gateway.js` 会在存在 `BACKEND_INGEST_KEY` 时自动启用命令同步器；缺少该变量时保持禁用且不发起 HTTP。
同步器轮询 `/internal/v1/commands`，只接受完整合法的 `ACK`，并只向
`home/<deviceId>/cmd` 发布。它必须看到发布之后到达、设备和 `alarmId` 都精确匹配的 `ACKED`
状态，才向 `/internal/v1/commands/<id>/result` 回写成功。结果 POST 临时失败时只重试原始结果体，
不会重复发布设备命令或错误推进游标。

## 已部署公网后端的安全启动入口（`public-sync.js`）

公网 API 已部署在 `https://api.luxunacc.xyz`。家庭侧只需主动出站访问 HTTPS 443，
不开放本地 MQTT、Bridge 或设备端口，也不需要公网 IP 或端口映射。此入口专门执行：

```text
本地 home/+/status -> 公网 /internal/v1/device-status
公网 /internal/v1/commands -> 本地 home/<deviceId>/cmd -> ACKED 回写
```

在可交互终端运行：

```powershell
cd <WORKSPACE>\competition\cloud\onenet
npm run public-sync
```

终端出现 `Enter public backend INGEST_KEY (hidden):` 后，输入服务器
`/opt/eldercare/deploy/.env.deploy` 中同名值并回车。输入只显示星号；密钥不进入命令行、
环境变量或项目文件。不要把它粘贴到聊天、日志或 Git。成功接入本地 Broker 时至少出现：

```text
[public-sync] CONFIG backend=https://api.luxunacc.xyz
[public-sync] CONFIG ingestKey=set
[gateway] START mode=self device=-
[gateway] LOCAL_SUBSCRIBED topic=home/+/status
```

`public-sync.js` 不连接 OneNET，因此不需要 OneNET 设备密钥，OneNET 在线状态也不会阻塞
APP 公网闭环。它要求本地 Broker、Bridge 与实体设备另行保持运行；若本地 `1883` 未监听，
会持续安全重连，但不会产生真实公网设备数据。

```powershell
node command-sync-integration.js
```

本地验收使用真实后端 HTTP 服务和模拟设备，预期 **13/13**；它不连接 OneNET 公网，也不代表实体设备已验收。

后端持久化启用后还可运行：

```powershell
node persistent-command-restart-integration.js
```

该验收真实关闭并重启后端两次，确认 PENDING 恢复、命令同步、ACKED 落盘和再次恢复，预期 **14/14**；设备仍为模拟实现。

## 测试
```powershell
cd <WORKSPACE>\competition\cloud\onenet
npm ci --ignore-scripts
npm run check
npm test
```

当前全目录共 132 项测试，其中命令同步器 25 项、网关 47 项、公网同步入口 4 项。测试使用可注入的伪 MQTT 客户端和伪传输层，
不访问 OneNET，不需要也不会读取任何真实凭据。

> 环境注意：在受限沙箱中直接跑 `npm test`（`node --test`）会报 `spawn EPERM`，因为测试运行器要用
> 管道 stdio 拉起每个测试文件的子进程，而沙箱禁止该操作。这是沙箱限制，不是代码缺陷。逐个文件
> 直接执行（`node adapter.test.js` 等）会以同一套用例在进程内运行并全部通过。

## 一次性真实上行检查

在 Windows PowerShell 中运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<WORKSPACE>\competition\cloud\onenet\activate-onenet.ps1"
```

启动器使用隐藏输入读取设备密钥，不把密钥放入命令行、文件或日志。验收条件依次为 `MQTT_CONNECTED`、`SUBSCRIPTIONS_OK` 和 `PROPERTY_ACCEPTED code=200`。程序随后保持连接 10 秒并主动退出，因此 OneNET 设备列表最终显示“离线”是一次性检查的预期结果，不表示激活失败。
