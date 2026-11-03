# YED / ESP32 串口识别记录（脱敏）

时间：2026-10-11T11:38:32+08:00

## 工具

- `hardware/yed-m100mg-b1/probe-core.js`
- `hardware/yed-m100mg-b1/probe-dtu.js`
- Node.js v24.19.0
- `serialport` 13.0.0
- `npm run check`：PASS
- `npm test`：17/17 PASS

探测器默认只查询 `firmwarever/csq/ssta/paramver`，本轮没有启用身份查询，不请求 IMEI/ICCID，不写串口日志。终端输出经过控制字符清洗、长度限制和身份字段脱敏。

## 端口识别

| 端口 | 枚举信息 | 实测 | 结论 |
|---|---|---|---|
| COM6 | CH340，VID 1A86，PID 7523 | 115200 被动监听得到 `elder-node` ESP32 日志及 Wi-Fi `reason=201` | 当前 ESP32 端口，不是 YED 探测口 |
| COM11 | FTDI，VID 0403，PID 6001 | 可打开；被动监听无数据 | 仅证明 USB-TTL 在线，不证明 YED 在线 |
| COM12 | CH340，VID 1A86，PID 7523 | 用户现场确认连接 YED 测试底板；115200 两轮合法只读回包 | YED 实际串口，协议通信已验证 |
| COM7 | CH340，VID 1A86，PID 7523 | 重新插拔后由 COM12 重枚举；固件回包再次确认为同一 YED | 当前 YED 串口 |

## COM11 最小查询

只发送 `config,get,firmwarever` 或默认四项只读查询：

| 波特率 | 结果 |
|---:|---|
| 9600 | 无响应 |
| 38400 | 无响应 |
| 57600 | 无响应 |
| 115200 | 收到不可解析字节，无合法 `config,...` 回包 |
| 230400 | 收到不可解析字节，无合法 `config,...` 回包 |
| 460800 | 收到不可解析字节，无合法 `config,...` 回包 |

## COM12 真实只读回包

`COM12 @ 115200` 首轮及等待 20 秒后的第二轮结果一致：

```text
firmware = YED_DTU4_2.0.3
csq = 99
ssta = 2
paramver = 0
```

厂家公开《DTU透传固件基本命令》定义：`SSTA=2` 为“识别卡无网络”；CSQ 有效范围 0-31，越大越好，一般大于 17 可稳定工作。因此本轮证明 YED 串口协议通信和 SIM 识别，但同时证明当前移动网络尚未注册，`CSQ=99` 不属于有效信号范围。

## 结论边界

已验证：真实 YED 端口为 COM12、115200 波特率、固件版本、SIM 可被识别。

阶段性失败（天线调整前）：移动网络注册与有效 CSQ。现场调整后结果见下方“天线调整后的复查”，其最新结论覆盖本段。

未验证：数据业务、GNSS 子型号/定位、OneNET MQTTS、Wi-Fi/4G 切换。全程未查询 IMEI/ICCID，未写配置或复位。

## 天线调整后的复查

测试底板重新插拔后由 COM12 枚举为 COM7；用相同固件回包确认是同一设备。首轮 `CSQ=26`、`SSTA=3`，15 秒后第二轮 `CSQ=30`、`SSTA=3`。厂家定义 `SSTA=3` 为“网络正常没连上服务器”，且 CSQ 大于 17 可稳定工作。

因此最新结论替代上段的阶段性失败：蜂窝网络注册与有效 CSQ 已 **PASS**；尚未连接或验证任何服务器、GNSS 或 OneNET。

## GNSS 隐私探测

新增 `gnss-probe-core.js` 与 `probe-gnss.js`，YED 目录语法检查通过、全部 **41/41**。工具只允许 `config,get,location,2` 与 `config,get,gpsext` 两条只读命令，原始回包和坐标只在内存中校验后丢弃，不打印、不写文件。

真实 COM7 脱敏摘要：

```text
GNSS SETTINGS: ENABLED
GNSS: NO_FIX
```

这证明 GPS 功能已开启且 GNSS 查询受支持，但尚未取得卫星定位；没有保存或展示精确位置。下一步需将 GPS 天线朝上置于室外空旷处 60 秒以上后复查。
