# 系统架构与协议

本文只记录相对稳定的架构和协议，不记录易变化的验证进度。验证状态见 `VALIDATION-MATRIX.md`。

## 1. 组件关系

```text
ESP32 房间节点（两块实体板，可配置为卫生间 / 厨房 / 卧室中的两个）
        | Wi-Fi + 当前 TCP 行协议
        v
DAYU200 家庭边缘主控
  homemon <-> 本地 OpenHarmony HAP
  MIPI 摄像头 -> YOLO Pose 跌倒判定
  本地声光 / 告警语音 / 节点汇聚
        |
        +-- 当前开发链路 --> PC Bridge + 本地 MQTT Broker
        |
        `-- 目标公网链路 --> Wi-Fi 或 YED-M100MG-B1 4G DTU
                              -> OneNET MQTTS / OneJSON
                              -> 可信 HTTPS API
                              -> 手机微信小程序
```

当前局域网链路已有真机证据。OneNET 产品、物模型和首个 DAYU200 设备已注册；可信后端已部署到 `https://api.luxunacc.xyz`，公共 TLS、APP 登录和 API 合同已验收。家庭网关到该公网后端的真实设备状态同步、手机真机和公网 ACK 实体闭环仍未验收。

## 1.1 视觉与传感职责

- DAYU200 配套 MIPI-CSI2 摄像头是主视觉入口。相机功能通过 OpenHarmony Camera Kit 接入，
  不由 `homemon` 直接操作摄像头供电 GPIO。
- ESP32-S3 是卫生间无线传感节点，当前职责为 PIR、门磁和本地蜂鸣器，不直接承担视频上行。
- DAYU 摄像头只能代表其实际安装房间。卫生间 ESP32 告警不能默认触发客厅摄像头抓拍。
- `F:\ESP` 中 DNESP32S3 的 OV2640/OV5640 摄像头是备选扩展。摄像头会占用当前传感固件的
  GPIO4/5/6，启用前必须重新规划引脚和完成独立真机验收。
- 相机功能应默认关闭自动抓拍，仅在用户授权后对摄像头所属房间的新告警执行本地抓拍；
  抓拍失败不得阻断告警、语音或 ACK 闭环。
- 跌倒判定使用 YOLO Pose 关键点加时序状态机。只有近期直立、快速髋部下落、低位水平姿态
  持续成立时才发出受限 `fall` 命令；不同 track ID 的历史不得拼接。YOLO 推理与规则判定
  分离，以便后续把 PC Ultralytics 适配器替换为经验证的 RKNN 适配器。
- 两块 ESP32 可同时形成两个真实房间节点；第三房间只能换配置分阶段演示，不能写成三节点同时在线。
- 厨房节点目标传感为燃气、烟雾、火焰和温度，可选阀门/排风执行器；卧室节点目标传感为 PIR、床垫压力、夜间离床和 SOS；这些实体传感器尚未到齐和验收。

## 1.2 公网与手机边界

- `cloud/onenet` 负责内部状态、OneJSON、短期设备 Token 和安全 MQTTS 传输。设备密钥只由系统 Secret 或调用方回调在运行时注入，不写入源码或日志。
- `cloud/backend` 是可信服务端边界：微信登录 code 只在服务端换取会话；设备入口与手机会话使用不同密钥。
- 微信小程序只连接受信 HTTPS API，不直接持有 OneNET Product access key、设备 Token 或微信 AppSecret。
- 手机告警 ACK 先进入待下发队列；只有设备回报 `ACKED` 才显示闭环完成，HTTP 请求到达不能冒充设备确认。
- `wx.makePhoneCall` 只在用户点击联系人按钮后调用。YED-M100MG-B1 公开资料没有证明语音呼叫能力，自动语音外呼不属于当前已实现功能。

## 2. 端口

| 端口 | 组件 | 方向 |
|---:|---|---|
| 9000 | DAYU homemon TCP 状态/命令通道 | APP、Bridge 与 homemon 双向 |
| 1883 | 自包含 MQTT Broker | Bridge、测试工具 |
| 9100 | Bridge 无线节点监听 | 默认模拟节点基线 -> Bridge |
| 9101 | Bridge 无线节点监听 | 当前真实 ESP32 配置 -> Bridge |

真实 ESP32 使用原始 TCP 行协议连接 Bridge，不直接实现 MQTT。Bridge 才是 MQTT 发布者。板端 relay 可经默认 `9000 -> 9000` fport，或使用独立本地端口 `9001 -> 9000`。

## 3. 状态上报

设备以换行分隔的 JSON 上报状态。`deviceId` 是路由主键，`room` 是界面标签，`state` 使用：

```text
NORMAL -> WARN -> ALARM -> ACKED
```

MQTT 主题：

```text
上行 home/<deviceId>/status
下行 home/<deviceId>/cmd
```

Bridge 注入无线节点状态时，向 homemon 发送：

```text
relay <完整状态 JSON>
```

homemon 只接受 JSON 对象形式的 relay 数据，并将合法状态广播给连接中的 APP。

## 4. 目标命令路由

APP 下发：

```text
route <deviceId> <原命令>
```

处理分支：

1. `deviceId` 等于 DAYU 本机：homemon 本地执行原命令。
2. `deviceId` 属于远端节点：homemon 不执行，只广播 route 行。
3. Bridge 从 relay socket 按行重组 route，查找该设备当前连接并转发原命令。
4. 未知、断开或不合法设备 ID 被拒绝。
5. 同一 `deviceId` 的新连接会原子替换旧连接；旧连接不再允许发布状态或接收下行。

安全约束：

- `deviceId`: `^[A-Za-z0-9._-]{1,64}$`
- 处置文本中的 CR/LF 压成空格。
- 禁止嵌套 `route` 和 `relay`。
- 普通 JSON、裸命令和 `routeXXX` 不进入远端节点命令通道。

## 5. ACK 语义

ACK 需要同时满足：

- 当前设备状态为 `ALARM`。
- `alarmId` 与当前告警精确匹配。
- 当前没有另一笔发送未落定或等待设备确认的操作。

APP 在 Socket Promise 成功后记录 `pendingDeviceId + pendingAckId`。任意设备快照到达时都可以触发结算，但只有设备 ID 和告警 ID 同时匹配才会完成闭环。等待超过 8 秒仍无匹配状态时提示超时。

## 6. 在线判定

- 每份合法设备状态到达时记录本地 `Date.now()`。
- 每 3 秒扫描所有快照。
- 12 秒无新状态则 `online=false`。
- 新状态到达后恢复 `online=true`。
- Link 断开时，该 Link 见过的全部设备立即标离线。
- 离线设备不允许发送 ACK。

## 7. SOS 语音

```text
homemon alarm_raise()
  -> say_cmd
  -> southbound/say.sh
  -> aa start SosVoiceAbility
  -> rawfile 写入应用沙箱并只读打开
  -> AVPlayer fd://
  -> STREAM_USAGE_ALARM
```

语音文件在写入沙箱时使用截断模式，避免新文件较短时保留旧尾部。播放器结束或失败时释放 AVPlayer、关闭 fd，并终止 Ability。

## 8. OneNET OneJSON

上行使用：

```text
$sys/{productId}/{deviceName}/thing/property/post
$sys/{productId}/{deviceName}/thing/event/post
```

下行订阅 `property/set`，只接受 `ACK`、`RESET` 和有范围限制的 `SET_CONFIG`。消息 ID 为最多 13 位数字字符串；时间为 UTC Unix epoch 毫秒。完整字段见 `cloud/onenet/thing-model.json`。

公网传输使用 MQTT 3.1.1 over TLS、OneNET 官方 CA 与证书指纹固定、QoS 1 和短期设备级 Token。OneNET 当前 MQTT 证书无 SAN，因此以官方 CA 和精确 SHA-256 指纹替代标准 DNS 主机名检查，仍保持 `rejectUnauthorized=true`。属性与事件必须收到 OneNET `code=200` 的业务回复才视为完成；断线后重新读取 Secret、生成新 Token 并指数退避重连。产品专属 `8883` 的无凭据 TLS 1.3 握手已通过，尚未使用真实设备密钥登录 MQTT。

## 9. 当前安全边界

当前局域网设备链路未实现身份鉴别、TLS 或消息签名，MQTT 使用 QoS 0。公网 API 已通过 Caddy 和公共 TLS 部署，backend 仅在容器网络监听，家庭侧只应主动出站访问 443。局域网 MQTT、Bridge 与设备端口仍只适用于受控开发环境，不得直接暴露到不可信网络。

