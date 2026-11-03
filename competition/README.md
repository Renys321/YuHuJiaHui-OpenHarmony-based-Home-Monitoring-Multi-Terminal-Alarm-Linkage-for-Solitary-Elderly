# 域护家徽：OpenHarmony 驱动的独居老人居家安全监测与多端告警闭环系统

> 赛题四：独居老人居家安全监测与应急辅助系统。

本目录是“域护家徽”的多端原型工程。目标形态是房间 ESP32 节点接入 DAYU200 家庭边缘主控，经 Wi-Fi/4G 和云端同步到手机 APP；核心是**本地优先的应急闭环**与**设备级 ACK**。

DAYU200 当前基线运行于 OpenHarmony 7.0.0.38 / API 26，设备用户态为 32 位，因此真机部署南向程序时必须使用 `southbound/out/homemon-arm`。

## 当前状态

> **2026-10-29 现状（以此为准；下文历史条目仅作过程记录）**
>
> - 主线：ESP32-S3 节点 → PC `bridge(9101)`/`broker(1883)` → `public-sync` → ECS 后端 `https://api.luxunacc.xyz` → 手机 ArkTS APP；DAYU200 经 `hdc fport 9001` 接入 bridge，板载 APP 本地 `9000`。
> - 已实测：4 设备在线（厨房/卫生间/客厅/随身）、跌倒视觉联调、视频 relay 端到端 43 帧/7 s、DAYU200 PIR 已启用、设备级 ACK 闭环、上行返回 202。
> - 当前演示入口：`materials/start-demo-full.cmd`（自动预检 + 重建映射 + P0 + 板端页面 + 视觉 + relay + mirror + 验收）。
> - 未完成/边界：视觉为"关键点+规则"（不宣称准确率）、ECS 单点、厨房 ESP32 疑似硬件故障、多角色（网格员/物业）协同未实现。

- 北向 ArkTS 应用、南向 `homemon`、MQTT Bridge、模拟无线节点和 ESP32 节点源码均已实现。
- 北向 HAP 和南向 ARM32/ARM64 程序均已构建；当前权威制品和 SHA-256 见 `docs/ARTIFACTS.md`。
- DAYU 软件求助语音链路已有真机日志证据；音频策略选择 `SPEAKER` 并完成播放。
- DAYU 本机 ACK 的错误 ID、正确 ID、重复 ID 均出现了符合预期的状态和日志；第三轮已确认重复 ACK 不新增安全日志记录。
- 目标路由协议完成了本地 Socket 集成测试；当前 Bridge 加固与 `FALL` 路由共 11 项断言全部通过。
- 第三轮冻结的一键启动脚本已在真机完整运行；APP 的跨设备闭环、跨房间 pending 结算、12 秒离线、离线拒绝 ACK 和同 ID 恢复均已通过该轮真机验证。当前参数化启动脚本已通过静态检查，待设备重新接入后整脚本复跑。
- 真实 ESP32-S3 已按当前源码重建并完成 COM9 烧录、2.4 GHz 热点接入、TCP 上行、NTP 同步和 13 位毫秒状态上报；最终 BIN/ELF 与证据见 `docs/ARTIFACTS.md` 和 `evidence/2026-10-10-final-esp32-and-bridge-hardening/`。
- 已核对 `F:\ESP` 中的 DNESP32S3、OV2640/OV5640 和 IO 资料。DAYU200 的 MIPI-CSI2 摄像头作为主视觉入口；ESP32-S3 当前继续作为 PIR、门磁和蜂鸣器无线节点。硬件资源、引脚冲突和相机接入边界见 `docs/HARDWARE-MAP.md`。
- YOLO Pose 跌倒检测 PC 基线已实现：模型权重与独立环境已落地，11 项规则/适配器测试、CPU 模型推理、MQTT `fall` 定向路由、homemon 双架构构建和 HAP 离线验签均通过。DAYU 摄像头取帧、真人跌倒数据和 RKNN/NPU 仍未实测。
- OneNET 产品 `I19NBBq4xe`、完整物模型和设备 `dayu200-home-gateway` 已注册；OneJSON 适配、设备级 Token、官方 CA/证书指纹固定、重连、云端确认和受限下行传输层共 91 项本地测试通过（原有 37 项 + 网关 41 项 + 后端同步 13 项）。真实设备级 Token 已完成 MQTTS 认证、主题订阅和属性上报，OneNET 返回 `code=200`。真实 `RESET` 下行完成 `property/set -> 白名单解析 -> property/set_reply`，OneNET 显示外层 `code=0`、设备回复 `code=200`；该一次性处理器未执行 DAYU/ESP32 动作。
- 常驻家庭云网关 `cloud/onenet/gateway.js` 已完成第一阶段：订阅本地 `home/+/status` 做严格校验与聚合、状态变化立即上云、稳定状态 30 秒限频、按 `deviceId + alarmId` 去重事件、网关自身 `RESET` 下行并等真实设备回执才回复 `code=200`。真实本地 Broker + 真实 MQTT 报文 + 伪 OneNET 传输层的 14 项分层断言通过；**2026-10-10 已在 DAYU200 真机上完成 17/17 分层验收**：真实板端状态经真实 Broker 上云并保留房间来源、稳定状态限频、板端真实 `MANUAL_SOS` 告警产生一次 `safetyAlarm` 且同 `alarmId` 不重复告警，证据见 `evidence/2026-10-10-onenet-gateway-real-device/`。**2026-10-10 又完成真机下行 RESET 闭环验收 20/20**：网关命令经真实 `hdc fport` 上的真实 `mqtt_bridge.js` 写入板端活动连接，DAYU200 真实执行 `状态复位 -> NORMAL`，网关依据真实回执回复成功（证据 `reset-acceptance-results.json`、`reset-bridge.out.log`）。该轮抓出并修复了两个只有真机能发现的网关缺陷：下行负载必须为 JSON `{"cmd":"reset"}`（裸字符串会被 Bridge 丢弃），以及 RESET 回执必须晚于本笔告警且目标当前确实处于 `ALARM`。用真实凭据常驻运行和经真实 OneNET 公网下行仍为 `NOT TESTED`。第一阶段有意不做 `ACK`/`SET_CONFIG` 下推：物模型 `control` 暂无 `deviceId`，无法安全定向，不按“当前房间”猜测。
- 2026-10-10 真机复核发现 **板端系统时钟为 `2021-01-01`**，比 PC 落后约 5.8 年；板端自身 `ts` 数值不可用于云端时间。网关使用 PC 本地接收时间作为上云时间戳。该问题记入 `docs/KNOWN-RISKS.md`。
- 微信小程序原生骨架已实现总览、房间、告警、设备/位置、联系人和用户点击后一键拨号，45 项静态/模拟 API 检查通过；尚未配置正式 AppID、合法域名或手机预览。
- 可信 HTTPS API 原型已实现微信 code 换短会话、设备状态入口、查询接口和 ACK 待回执队列，6 项接口及跨端契约测试通过；当前内存存储不能作为生产部署。
- YED-M100MG-B1 的 4G/GNSS 能力、供电和串口边界已整理；Node 脱敏串口与隐私 GNSS 工具共 **41/41**。当前 `COM7 @ 115200` 真实两轮 `SSTA=3`、`CSQ=26/30`，SIM、蜂窝注册和信号已通过；GPS 已开启但尚未定位。YED 安全直连 OneNET 因 Y100E 服务器证书校验能力无公开证据而暂停，不能降级明文或关闭校验；PC/DAYU 现有安全 OneNET MQTTS 链路不受影响。
- 尚未验收的是最终固件上的 APP 发起 ACK、真实 PIR/门磁/蜂鸣器以及实体扬声器听觉效果。
- 历史真机报告中有一条无线下行结论不成立；以 `docs/VALIDATION-MATRIX.md` 为当前结论，不直接引用旧报告的汇总表。

## 文档入口

| 文档 | 用途 |
|---|---|
| `docs/INDEX.md` | **文档入口（先读这里）**：按"想了解/想运行/想验收"分流 |
| `docs/ARCHITECTURE.md` | 稳定架构、端口和协议 |
| `docs/RUNBOOK.md` | 构建、部署、启动、诊断和取证命令 |
| `docs/VALIDATION-MATRIX.md` | `PASS / PARTIAL / FAIL / NOT TESTED` 与证据映射 |
| `docs/KNOWN-RISKS.md` | 当前风险、边界和处理顺序 |
| `docs/ARTIFACTS.md` | 权威制品、源码指纹与哈希 |
| `docs/HARDWARE-MAP.md` | DAYU200 摄像头与 DNESP32S3 硬件资源、引脚冲突和扩展路线 |
| `vision/README.md` | YOLO Pose 跌倒检测 PC 基线、时序判定、运行和验收 |
| `cloud/onenet/README.md` | OneNET OneJSON 物模型、Token、安全 MQTTS 传输与常驻家庭云网关 |
| `cloud/backend/README.md` | 微信小程序可信 HTTPS API 原型 |
| `mobile/wechat-miniprogram/README.md` | 手机微信小程序导入、页面和 API 契约 |
| `hardware/yed-m100mg-b1/README.md` | 4G/GNSS 模块接线、探测与真机验收 |

旧阶段说明保存在 `docs/archive/2026-10-09/`，仅用于追溯，不能作为当前状态来源。原始日志保存在 `evidence/`，保持原样，不以汇总说明替代原始证据。

## 目录

```text
competition/
|-- northbound/      ArkTS 监护端应用及 HAP 产物
|-- southbound/      C 语言 homemon、配置、语音启动脚本和 ELF 产物
|-- bridge/          自包含 MQTT Broker、Bridge、工具和模拟节点
|-- esp32-node/      ESP32-S3 节点源码
|-- vision/          YOLO Pose 适配器、时序跌倒判定、测试和模型权重
|-- cloud/           OneNET OneJSON 适配层与可信 API 原型
|-- mobile/          原生微信小程序
|-- hardware/        4G/GNSS 等硬件接入说明和安全探测工具
|-- materials/       工程辅助脚本与说明材料
|-- evidence/        原始测试日志和冻结证据
`-- docs/            当前文档与历史归档
```

## 系统路径

```text
DAYU homemon :9000 <-> ArkTS APP
       ^
       | relay / route，经 hdc fport 暴露到 PC
       v
PC mqtt_bridge :9100（模拟基线）或 :9101（当前 ESP32 配置）
       ^
       | 原始 TCP；MQTT 由 Bridge 发布
       +---- 模拟节点或 ESP32 节点
       |
       v
PC MQTT broker :1883
```

公网目标链路尚未真机打通：

```text
ESP32 房间节点 -> DAYU200 边缘主控 -> Wi-Fi / YED 4G DTU
                                      -> OneNET MQTTS
                                      -> 可信 HTTPS API
                                      -> 微信小程序
```

现有两块 ESP32-S3 可同时承担两个实体房间节点；可通过重新配置分别演示厨房、卧室和卫生间逻辑，但不能据此声称三个房间同时有三套实体节点。

## 协议摘要

### 3.1 状态上报

设备按行发送 JSON，关键字段包括：

```json
{
  "deviceId": "dayu200-living",
  "room": "客厅",
  "online": true,
  "state": "NORMAL",
  "alarms": []
}
```

MQTT 上行主题为 `home/<deviceId>/status`，下行主题为 `home/<deviceId>/cmd`。

### 3.2 目标路由与 ACK

APP 向指定设备下发：

```text
route <deviceId> <原命令>
```

示例：

```text
route esp32-bath ack alarm-1 已电话确认
```

ACK 只有在设备处于 `ALARM` 且 `alarmId` 精确匹配时才会被接受。错误 ID 和重复 ACK 不应改变状态。`deviceId` 仅允许 `[A-Za-z0-9._-]{1,64}`，处置文本中的 CR/LF 会被压成空格，嵌套 `route` / `relay` 会被拒绝。

### 3.3 在线状态

APP 使用本地接收时间记录 `lastSeenMs`，每 3 秒检查一次；超过 12 秒没有该设备的新状态即标记离线。新状态到达后恢复在线，离线设备拒绝 ACK。

## 快速开始

完整前置条件和诊断步骤见 `docs/RUNBOOK.md`。环境满足时，入口命令为：

```powershell
<WORKSPACE>\competition\materials\start-demo-supervisor.cmd
```

（旧入口 `demo_start.ps1` 已于 2026-10-29 删除；启动只认 `start-demo-supervisor.cmd`。）

不要把脚本输出“环境就绪”直接等同于全部验收通过；必须按 `docs/VALIDATION-MATRIX.md` 保存对应层级的原始证据。

## 7.1 当前证据摘要

- `evidence/2026-10-09-local-route-integration/`：可信的本地 Socket 路由基线，但不包含真机 APP，并且所记录的 `Index.ets` 早于当前版本。
- `evidence/2026-10-09-device-validation/`：两轮真机历史记录。语音软件链路和 DAYU ACK 日志可用；无线下行汇总结论需要以新验证矩阵中的更正为准。
- `evidence/2026-10-10-third-device-validation/`：当前第三轮真机基线，覆盖最新版一键启动、合法 JSON MQTT GAS、APP 远端闭环、离线/恢复、跨房间 pending 结算和 DAYU 安全日志行数。
- `evidence/2026-10-10-real-esp32-validation/`：真实 ESP32 的多轮热点、串口和链路排查记录；目录混有不同固件阶段，不能整体视为最终版本证据。
- `evidence/2026-10-10-final-esp32-and-bridge-hardening/`：最终 `now_ms()` 固件烧录、13 位毫秒状态快照和 Bridge 同 ID 重连加固证据。
- `evidence/2026-10-10-yolo-fall-baseline/`：YOLO Pose 规则/适配器测试、CPU 推理、FALL 路由、双架构构建与 HAP 离线验签边界。
- `evidence/2026-10-10-onenet-gateway-real-device/`：DAYU200 真机网关分层验收（17/17）：真实板端状态经真实 Broker 到网关并上云、限频、真实 `MANUAL_SOS` 告警产生一次 `safetyAlarm`、同 `alarmId` 去重；同时记录板端时钟落后 5.8 年与 `NO_MOTION` 不可靠两项现场问题。OneNET 侧为伪传输层，不含真实凭据。
- `evidence/2026-10-10-script-hardening-static-review.txt`：启动与语音脚本加固的静态复核、Parser 检查和无文件 FFmpeg 行为测试。
- `evidence/2026-10-10-make-voice-entry-fix-and-selftest.txt`：真实 M4A 转换发现并修复 `$Input` 自动变量冲突，记录成功/失败路径及生产音频未被覆盖的证明。
- `evidence/2026-10-10-OH7.0-验证记录.md`：刷机与音频历史记录；历史时间线曾有 8 小时混淆。Unix epoch 必须保持 UTC，不得人为增加 `28800` 秒。

