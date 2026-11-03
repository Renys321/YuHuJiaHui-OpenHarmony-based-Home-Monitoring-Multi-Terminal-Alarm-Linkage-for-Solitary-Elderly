# YED-M100MG-B1 4G/GNSS 接入准备

本目录用于把 YED-M100MG-B1 作为家庭网关的公网数据备链和定位来源。当前只完成资料核对、串口探测工具和接入边界定义；尚未在本项目中完成模块真机联网、GNSS 定位或 OneNET 上报。

## 已确认能力

- Cat.1 数据 DTU，供电范围 5-12 V，资料标称功率 10 W。
- 一路 TTL UART，支持 3.3 V/5 V 电平，波特率 1200-460800。
- 支持 TCP、UDP、MQTT、HTTP、WebSocket，以及 MQTTS/HTTPS/SSL。
- 厂商资料明确列出 OneNET。
- 可选独立 GNSS：`ATGM336H-5NR32`（GPS/北斗等）或 `ATGM336H-6N22`（北斗）。
- GNSS 输出为 WGS84；在国内地图展示时需要在可信后端转换坐标系。

公开资料没有列出麦克风、扬声器、音频引脚或语音呼叫能力。因此本项目把它用于数据、GNSS 和可选短信，不宣称可以直接拨打语音电话。微信小程序的一键拨号由用户点击 `wx.makePhoneCall` 完成；无人值守的自动语音外呼需要另配明确支持语音通话的蜂窝模块或第三方呼叫服务。

## 电气连接

1. 使用能够持续提供模块所需功率的独立 5-12 V 电源，不能默认由 USB-TTL 适配器给模块供电。
2. 模块 GND、USB-TTL GND 和 DAYU200 GND 必须共地。
3. 先确认 USB-TTL 与模块 UART 的电平设置，再连接 TX/RX；TX 与 RX 交叉连接。
4. GNSS 天线需要开阔天空视野。室内无法定位不等于模块故障。

## 首次串口探测（Node.js，首选）

Node.js 工具不依赖 PowerShell 5.1。安装锁定依赖、运行纯测试并列出串口：

```text
cd <WORKSPACE>\competition\hardware\yed-m100mg-b1
npm install
npm run check
npm test
npm run list
```

先被动监听，不向设备发送任何内容：

```text
node probe-dtu.js --listen --port <PORT> --baud 115200 --timeout 3000
```

`<PORT>` 必须来自本次 `npm run list` 的枚举结果。`COM12`、`COM7` 等历史端口号只代表当时的
Windows 枚举结果，重新插拔后可能变化，不能直接复制使用。被动监听确认出现 YED 固件回包后，
才允许执行后续只读查询。

只查询固件版本，适合最小化波特率排查：

```text
node probe-dtu.js --quick --port <PORT> --baud 115200
```

确认接线、电平、独立供电和波特率后，再执行默认四项探测：

```text
node probe-dtu.js --port <PORT> --baud 115200
```

默认只查询：

```text
config,get,firmwarever
config,get,csq
config,get,ssta
config,get,paramver
```

工具会删除终端控制字符、限制每行长度并脱敏明显身份字段，不写日志文件。只有确实需要时才使用 `--include-identifiers`；即使启用，IMEI/ICCID 仍只显示脱敏结果。

隐私保护 GNSS 探测只输出 GPS 开关和定位枚举，不显示或保存经纬度、速度、海拔、方向或原始回包：

```text
node probe-gnss.js --port <PORT> --baud 115200 --timeout 5000
```

该工具只允许两条固定只读命令：`config,get,location,2` 和 `config,get,gpsext`；任何 `config,set` 都会在本地被拒绝。

## 4G/GPS 串口接入软件层（2026-10-14 新增）

本目录在原有探测工具之上补齐了一个**可测试的接入软件层**：串口传输、协议解析、定位解析、
隐私脱敏和 Wi-Fi/4G 故障切换状态机。它与真机验证是两件事，请严格区分下文「证据分级」。

### 目录结构

| 文件 | 作用 |
| --- | --- |
| `lib/transport.js` | 串口 AT/DTU 传输层：串行命令、超时/重试、URC 与响应分离、掉线重连、主动关闭后不再重连；串口实现与解析全部依赖注入 |
| `lib/dtu-protocol.js` | YED DTU 文本协议解析：CSQ 换算、SSTA 枚举、GNSS 定位、字段来源标注 |
| `lib/at-parser.js` | 通用 3GPP AT 回包解析框架。**当前设备不使用**，本地资料无 AT 证据，见 `AT_PROBE_BLOCKED` |
| `lib/device.js` | 探测编排：按序发送只读命令、汇总稳定字段、单命令失败不中断 |
| `lib/failover.js` | Wi-Fi/4G 故障切换状态机（纯软件、确定性） |
| `lib/privacy.js` | 统一脱敏：ICCID/IMSI/IMEI/手机号/密钥，日志、JSON 与错误对象共用 |
| `lib/fake-serial.js`、`lib/fixture-transport.js`、`lib/test-helpers.js` | 无硬件测试用假串口、夹具回放与假定时器 |
| `lib/fixtures/*.fixture` | **根据厂家公开命令格式构造**的回放夹具（非真机录制） |
| `probe-device.js` + `lib/probe-device-core.js` | 诊断 CLI 与它的纯逻辑核心 |

### 命令

```text
npm run check              # 全部源码语法检查
npm test                   # 全部测试（node --test）
npm run test:isolated      # 逐文件隔离运行 + 强制超时，便于定位挂住的用例
npm run probe              # 夹具模式默认档案（registered）
npm run probe:gnss         # 夹具模式 gnss-fixed
npm run probe:at           # 夹具模式 AT 框架（仅夹具，不对真机发 AT）
npm run failover-demo      # 纯软件故障切换演示
```

CLI 直接用法：

```text
node probe-device.js --fixture --profile registered|gnss-fixed|no-fix|csq-invalid|error-timeout-drop|at
node probe-device.js --fixture --fixture-file <path> --samples 5 --pretty
node probe-device.js --failover-demo --max-attempts 5
node probe-device.js --real --port <PORT> --baud 115200     # 必须同时给 --real 和 --port
```

安全约束：夹具模式是默认模式，**绝不打开串口**；只给 `--port` 而不给 `--real` 会被直接拒绝
（避免"以为在开真口、其实走了夹具"的误判）。退出码 `0` 全部成功、`2` 部分失败、`1` 全部失败、`64` 用法错误。

### 4G 状态解析

- `AT` 连通性、`+CPIN` SIM 就绪、`+CREG`/`+CGREG`/`+CEREG` 注册状态、`+CSQ` 信号、`+COPS` 运营商
  由 `lib/at-parser.js` 按 3GPP TS 27.007 公开格式解析；注册状态 `stat` 0-5 分别映射
  NOT_REGISTERED/REGISTERED/SEARCHING/DENIED/UNKNOWN/ROAMING，字段缺失时返回 UNKNOWN，绝不推断为已注册。
- 真机走的是 DTU 文本协议：`config,get,firmwarever|paramver|csq|ssta`，厂商 `SSTA` 枚举
  0-6 推导 SIM/注册/服务器状态，每条结论都带 `source` 标记。
- **信号质量**：CSQ 0-31 有效并按标准公式 `dBm = -113 + 2 × CSQ` 换算；`99` 表示未知，
  不换算、不算强信号；其余一律 INVALID 且无 dBm。
- **数据连接状态**：本地资料中没有对应查询命令，因此恒为 `UNKNOWN` 并附
  `no_local_evidence_for_data_connection_query`，不发明指令。
- 运营商信息在 DTU 协议下同样没有本地证据，标记为 `supported: false`。

### GPS/GNSS 解析

依据本地资料中已核对的 `config,get,gpsext` 回包格式（**不使用猜测的厂商私有 NMEA/AT 命令**）：

- 短包 `config,gps,ok,<EW>,<lon>,<NS>,<lat>` 没有显式 fix 标志，只能判定 `UNKNOWN`；
- 扩展包 `<flag>,<EW>,<lon>,<NS>,<lat>,<speed>,<course>,<alt>,...,<time>` 只有同时满足
  `flag=1`、半球合法、经纬度成对且非零且分别在 ±180/±90 内，才允许 `valid: true`；
- UTC 时间字段严格校验年月日时分秒范围，越界返回 `null`；
- 无 fix、空字段、零坐标、越界坐标一律 `NO_FIX`，**绝不伪装成有效定位**。

### Wi-Fi / 4G 故障切换状态机

`lib/failover.js` 是**纯软件**状态机，不操作真实网络：`WIFI_PRIMARY → CELLULAR_CONNECTING →
CELLULAR_ACTIVE / OFFLINE`，支持失败计数、回退延迟与指数退避（`base × 2^n`，上限封顶）、
Wi-Fi 抖动去抖、以及"Wi-Fi 恢复后必须连续稳定 `wifiStableMs` 才回切"的迟滞。

`npm run failover-demo` 用确定性时间轴演示该过程，输出 `claims.realWifiToCellularTakeoverVerified = false`：
**真实 Wi-Fi 到 4G 的自动接管尚未在硬件上验证**。

### 证据分级（必须随结论一起引用）

| 级别 | 内容 |
| --- | --- |
| A. 源码证据 | `lib/*.js` 的实现与注释；厂家公开命令格式核对记录 |
| B. 本地单元测试 | `npm test`，10 个测试文件 **164/164** 通过 |
| C. 模拟串口集成测试 | 夹具回放与假串口：URC 交错、超时、ERROR、掉线重连、状态机、报告 JSON |
| D. 尚未执行的真实串口测试 | 本轮**未**打开任何真实端口：未在真实 COM 口验证本软件层 |
| E. 尚未执行的真机验证 | 真实 4G 公网上云、真实 GPS 室外定位、真实 Wi-Fi/4G 接管 |

C 级结果只证明代码逻辑，**不等于**真机联通。真机历史结论仍只在 `2026-10-11 当前探测结果`
与 `docs/VALIDATION-MATRIX.md` 中，且只覆盖串口协议、SIM 识别、蜂窝注册和信号质量。


## 2026-10-11 当前探测结果

- Node 串口工具语法检查通过，纯单元测试 **17/17**。
- `COM6` 是 CH340；被动监听获得当前 `elder-node` ESP32 固件日志和 Wi-Fi `reason=201`，因此已明确排除为 YED 探测口。
- 用户现场确认原 `COM12` 是 YED 测试底板；重新插拔后 Windows 将同一底板枚举为 `COM7`。`COM7 @ 115200` 的固件回包再次确认设备身份。
- 天线/位置调整后首轮返回 `CSQ=26`、`SSTA=3`，15 秒后复查为 `CSQ=30`、`SSTA=3`；固件仍为 `YED_DTU4_2.0.3`，`paramver=0`。
- 厂家公开命令文档定义 `SSTA=3` 为“网络正常没连上服务器”；CSQ 有效范围为 0-31，一般大于 17 可稳定工作。因此串口协议、SIM 识别、蜂窝注册和信号质量均已通过，但服务器/OneNET 连接尚未验证。
- 隐私 GNSS 探测器与核心测试已通过，YED 目录总计 **41/41**。真实 COM7 回包被就地解析并丢弃坐标，安全摘要为 `GNSS SETTINGS: ENABLED`、`GNSS: NO_FIX`：GPS 功能已开启且命令受支持，但当前尚未获得卫星定位。
- 本轮没有查询 IMEI/ICCID，没有写配置或复位，没有保存未脱敏串口日志；GNSS 成功定位、服务器连接、OneNET MQTTS 和 Wi-Fi/4G 切换仍未验证。

脱敏执行记录见 `evidence/2026-10-11-yed-node-serial-probe/README.md`。

## 旧 PowerShell 探测器

`probe_dtu.ps1` 仅为历史兼容保留，不再提供为当前操作步骤，也不参与本项目的默认运行路径。
当前串口枚举、被动监听、只读探测和 GNSS 探测全部使用上面的 Node.js 命令，避免依赖
PowerShell 5.1。

请只在聊天中提供固件版本、模块家族、CSQ 和注册状态，不要发送完整 IMEI、ICCID、SIM 号码或任何 Token。

## OneNET 路线门禁

厂商的“新移动物联网平台”模板和有证书 SSL 教程都明确限定 Air780；当前真机固件为 Y100E 路线 `YED_DTU4_2.0.3`，没有公开证据证明可用该模板或强制校验服务器证书。不能直接套用模板，也不能为了演示降级到明文 1883 或“不校验证书”的 MQTTS。

通用 MQTT 命令格式已从厂家公开手册核对，支持客户端 ID、用户名、密码、主题、QoS 和 MQTT 3.1.1；但 OneNET 设备 Token 会过期，且当前 Y100E 证书校验能力未证明。后续路线必须满足其一：

- 厂商提供并验证适用于 Y100E 的服务器证书强制校验固件/说明；或
- 使用可信公网中继，在应用层完成认证与安全封装，再由中继使用现有安全 OneNET MQTTS 传输。

OneNET 设备侧所需的是 Product ID、设备名称和设备 Token，不是网页登录账号密码。所有密钥只允许进入 DTU、DAYU 私有配置或可信后端环境变量；微信小程序不得包含 Product access key 或设备 Token。

## 真机验收标准

- 串口能稳定返回固件版本、CSQ、SIM/网络注册状态。
- 明确实际 GNSS 子型号，并在室外获得有效 WGS84 定位和 UTC 定位时间；证据只保留 `FIXED/NO_FIX` 等脱敏结论，不保存家庭精确坐标。
- MQTTS 证书校验开启，成功发布 OneJSON 属性并收到 OneNET reply。
- 断开 Wi-Fi 后，DAYU 状态能经 4G 继续上报；恢复 Wi-Fi 后不产生重复告警。
- 下行 ACK 只作用于完全匹配的 `deviceId + alarmId`。
- 保存一份新的证据目录，包含脱敏串口日志、OneNET 消息 ID、时间戳和 APP 结果。

