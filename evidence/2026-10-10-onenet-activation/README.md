# OneNET 真实设备激活与属性上行证据

日期：2026-10-10（Asia/Shanghai）

本记录只保存非敏感验收结果，不包含设备密钥、Token、MQTT password、账号密码、AccessKey、Cookie、消息 ID 或完整连接参数。

## 对象

| 项目 | 值 |
|---|---|
| 产品 ID | `I19NBBq4xe` |
| 设备名称 | `dayu200-home-gateway` |
| 协议 | MQTT 3.1.1 over TLS / OneJSON |
| TLS 端口 | `8883` |

## 真实运行结果

通过 `cloud/onenet/activate-onenet.ps1` 隐藏输入设备密钥，启动 `live-check.js`：

1. `MQTT_CONNECTED`：设备级 Token 认证和 MQTT CONNECT 成功。
2. `SUBSCRIPTIONS_OK`：属性上报回复、属性设置和事件回复主题订阅成功。
3. `PROPERTY_ACCEPTED code=200`：一次非告警网关属性快照被 OneNET 业务层接受。
4. `HOLDING_CONNECTION ms=10000`：收到业务回复后继续保持连接 10 秒，再主动退出。

OneNET 设备列表随后显示：

| 字段 | 结果 |
|---|---|
| 启停状态 | 启用 |
| 设备状态 | 离线 |
| 最近在线时间 | `2026-10-10 22:08:01` |

“离线”是一次性检查主动断开后的预期状态；“未激活”已经消失，说明设备完成激活并留下最近在线记录。

## 真实下行验证

设备通过 `downlink-check.js` 在线等待后，在 OneNET 设备调试的“应用模拟器 -> 属性设置”中仅设置 `control.command=RESET`。平台结构体表单自动附带空的 `alarmId` 和 `action`，适配器只对这两个空占位做窄兼容。

| 字段 | 结果 |
|---|---|
| 下发时间 | `2026-10-10 22:24:48` |
| 命令 | `RESET` |
| OneNET 外层结果 | `code=0`, `msg=succ` |
| 设备业务回复 | `code=200`, `msg=success` |

首次在旧监听器超时后发送得到 `code=10411`（设备不在线）；重新上线并在 10 分钟窗口内发送后成功。失败记录没有被覆盖或误写为成功。

一次性处理器只完成严格白名单解析和 `property/set_reply`，不调用 DAYU200、ESP32、蜂鸣器或告警状态机，因此不能作为真实硬件执行证据。

## 结论边界

- PASS：真实 MQTTS 认证、主题订阅、QoS 1 属性发布、OneNET `code=200` 业务确认和设备激活。
- PASS：OneNET `property/set` 真实 `RESET` 下行和 `property/set_reply` 云端闭环。
- NOT TESTED：下行命令驱动 DAYU200/ESP32 真实动作并依据真实设备结果回复云端。
- NOT TESTED：DAYU200 常驻网关进程、4G DTU、可信公网 HTTPS 后端和微信手机真机。
