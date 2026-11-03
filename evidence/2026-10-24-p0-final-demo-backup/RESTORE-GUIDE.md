# P0 演示恢复指南（2026-10-24 冻结基线）

本指南用于从本备份恢复“当前可演示基线”。恢复前先确认现场硬件与网络，再按顺序启动。
所有秘密（`INGEST_KEY`、guardian password、sessionToken、Authorization、Cookie、AppSecret、
Wi-Fi 密码、AssetStore 内容）**不得写入文档、命令行参数、日志或本备份包**。

## 1. 当前架构

```text
厨房 ESP32（esp32-kitchen） ┐
卫生间 ESP32（esp32-bath）  ├─ Wi-Fi/TCP 9101 ─ Bridge ─ 本地 MQTT 1883
DAYU200（dayu200-living）   ┘   HDC fport 9001→9000 ┘      │
                                                          ▼
                                               public-sync supervisor
                                                  └─ 唯一 worker → 公网 backend
                                                          ▼
                                              HarmonyOS 手机 APP（模拟器 127.0.0.1:5555）
```

边界：pc 本地 Broker/Bridge/supervisor 都在演示电脑上；DAYU 仅通过 HDC fport 接入；
public-sync **不连接 OneNET**，只使用 backend-only transport；4G/GNSS/COM8 不属于本基线。

## 2. 正常启动顺序

1. 接好硬件：厨房、卫生间 ESP32 与 DAYU200 供电；检查 USB 连接。
2. 确认网络：演示电脑与 ESP32 在同一原演示网络（ESP32 固件配置的网关主机可达），
   DAYU 通过 USB HDC 可见。
3. 双击正式入口：

```text
<WORKSPACE>\competition\materials\start-demo-supervisor.cmd
```

4. 在可见窗口按提示**隐藏输入一次** `INGEST_KEY`（输入不回显），保持窗口打开。
5. 等待 supervisor 输出 `HEALTHY`；不要关闭窗口。
6. 检查“一个 supervisor + 一个 worker”、父子关系正确、lock/state 一致：
   可运行 `artifacts/verify-supervisor-acceptance.ps1`（只读）或手工读取 runtime state。
7. 检查三设备自然 202：kitchen / bath / living 均出现 `status=202` 并持续增长。
8. 检查 API `lastSeenTs` 前进（需要 APP 账号，或使用已安装 APP 页面观察）。
9. 启动/连接既有模拟器 `127.0.0.1:5555`（不要新建、不要清数据）。
10. 打开 APP，检查：首页与 MonitorPage 均 3/5；MQ-5/MQ-2 原始 ADC 且“报警未启用”；
    卫生间 PIR 最近活动/今日次数；DAYU ALARM 如实显示且不 ACK。

## 3. 凭据类型必须区分清楚

```text
guardianId / password   = APP 登录到后端账号的凭据（在模拟器 APP 内输入）
INGEST_KEY              = public-sync 上传 backend 的 ingest 密钥（在 supervisor 隐藏提示输入）
```

- supervisor 启动只应要求 `INGEST_KEY`，不会要求 guardian password。
- 不得把 `INGEST_KEY` 填进 guardianId 输入框。
- 不得把 APP 登录密码当成 `INGEST_KEY`。
- 两者都不得出现在文档、命令行参数、聊天或日志中。

## 4. USB / fport 恢复（DAYU living 无自然 202 时）

若插拔 DAYU USB 或集线器后 `dayu200-living` 不再产生自然 202：

1. 只读执行：

```powershell
hdc list targets
```

2. 确认 USB 目标仍为 `450100445634303332012847942eca00`；若有多个目标，先人工确认，不要猜测。
3. 只读检查 fport：

```powershell
hdc fport ls
```

4. 仅当目标明确且缺少映射时，重建一次：

```powershell
hdc -t 450100445634303332012847942eca00 fport tcp:9001 tcp:9000
```

5. 不要修改 DAYU homemon，不要盲操作多个 HDC target，不要重启 HDC server 除非必要。
6. 确认 PC `127.0.0.1:9001` 有监听；等待 living 自然 202 恢复。

## 5. APP 回退

```text
当前包（本轮真实 PASS、已安装）：
  artifacts/guardian-app-p0-sensors-autorefreshfix-2026-10-24.hap
  size=2,086,949 B
  sha256=9EEBEE9A5FC9EEC5A5993DC6923F16F0BFCCCD1CD4DE64BAF36FC7197ECAD25A

回退包（冻结基线，保留）：
  artifacts/guardian-inline-summary-formal.hap
  size=2,077,912 B
  sha256=8A722EB6FDA7BB73EE58F3BDA3D95B5D238401DA8E3CC9179F1286FD5253A985
```

回退条件与步骤：

1. 只有当前包安装失败、启动失败或关键页面/刷新真实验收失败时才回退。
2. 回退前先保留失败证据（截图/日志/页面文本、APP PID、时间）。
3. 回退安装使用 `install -r`，**不卸载、不清 APP 数据**：

```powershell
hdc -t 127.0.0.1:5555 install -r artifacts/guardian-inline-summary-formal.hap
```

4. 回退后如实记录“已回退到 8A722”，不得把回退成功写成“当前新版本通过”。
5. 回退包本身含已知缺口（DevicePage 不完整显示 valueText/detailText 等），不能代表本轮 PASS。

## 6. 已知边界

1. supervisor 只能自动恢复 worker；supervisor 自身/终端被关闭、PC 重启后需要人工重新启动。
2. `INGEST_KEY` 不持久化；重启后必须再次双击入口并隐藏输入一次。
3. USB/fport 丢失的运行中自动恢复尚未实现，需要按第 4 节人工确认与重建。
4. 当前是 HarmonyOS 手机**模拟器**验收，不是实体手机兼容性验收。
5. 当前链路仍依赖演示电脑（Broker/Bridge/public-sync 均在 PC）。
6. 无“worker 存活但 MQTT 消费停止”的业务级看门狗；`HEALTHY` 只代表进程级。
7. DAYU 本机 YOLO、PC→DAYU 链路迁移、4G、COM8、门磁均不属于当前 P0。
8. 端口编号存在历史冲突，见 `docs/PORT-MAPPING-CONFLICT.md`；不得擅自改端口或配置。
