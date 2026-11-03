# 2026-10-24 P0 真实验收与最终冻结

## 0. 结论

```text
P0-A（public-sync supervisor + 演示一键启动）：PASS（REAL）
P0-B（APP MQ-2/MQ-5/PIR/DevicePage + 自动刷新/离线/恢复）：PASS（REAL，含一次真实失败点修正）
回退：未发生（8A722 回退包保留未动）
```

本轮为真实部署与真实现场验收，不是审计或本地测试替代：

- 用户从 Windows Explorer 真实双击一键入口，隐藏输入一次 `INGEST_KEY`；
- supervisor/worker 真实运行，三设备自然 202 与 API `lastSeenTs` 真实前进；
- 受控终止 worker 后自动恢复；
- APP 真实安装到既有 Mate 90 Pro 模拟器（`127.0.0.1:5555`，未新建、未清数据）；
- 发现并修正了一个真实 UI 渲染缺陷（传感器卡片自动刷新不重渲染），重新构建、安装并复验通过。

## 1. 当前实际运行版本

### 1.1 电脑本地链路（本轮验收时真实运行）

```text
入口            evidence/2026-10-24-public-sync-supervisor-candidate/start-demo-supervisor-candidate.cmd
supervisor PID  11872（HEALTHY，lock/state 一致）
worker PID      50580（唯一，父进程 11872）
Broker          1883（PID 43624）
Bridge          9101（PID 47704）
hdc fport       tcp:9001 -> tcp:9000（DAYU target 450100445634303332012847942eca00）
DAYU homemon    /data/homemon/homemon sha256=0d243539...（冻结原版，未替换）
```

正式入口已合入并通过只读预检（见第 4 节）；下次演示应使用：

```text
<WORKSPACE>\competition\materials\start-demo-supervisor.cmd
```

### 1.2 手机 APP（本轮真实安装并验收）

```text
bundle          com.example.program_04
versionName     1.0.0 / versionCode 1000000
target          127.0.0.1:5555（既有 Mate 90 Pro，HarmonyOS 7.0.0.107）
安装方式        hdc -t 127.0.0.1:5555 install -r（保留数据）
APP PID         26710（自 23:27:48 起，自动刷新/离线/恢复全程未重启）
HAP 路径        <WORKSPACE>\competition\evidence\2026-10-24-app-p0-sensors-local\
                guardian-app-p0-sensors-autorefreshfix-2026-10-24.hap
HAP 大小        2,086,949 B
HAP SHA-256     9EEBEE9A5FC9EEC5A5993DC6923F16F0BFCCCD1CD4DE64BAF36FC7197ECAD25A
```

源码哈希（构建该 HAP 时）：

```text
MonitorPage.ets  AE4BB64468138519B3E8ECB972D0F0EB3E909B3596776418F3943721732F7B7A  (12,948 B)
DevicePage.ets   1B50DDE3824368C8AE0A26A0FD688978B7830373A3D7B7D9C1AC5C5D768194A5  (18,360 B)
Contracts.ts     4CC10AAB040B0F04516C5D9EB2303D61EAA18E94643656709F2AD999FCA72428
ViewMapper.ts    432EC89853AEFEE1EC582A38FADE991A984014DBC80F0994F25266B47FB76106
HomePage.ets     4AEC2E18329528C53883CC86AB0340FF5EB18225FE4E867ACF5D2A20DA2BBF85
构建            hvigorw assembleHap --mode module -p product=default -p buildMode=debug --no-daemon
                BUILD SUCCESSFUL（未配置 signingConfigs，产物 unsigned，模拟器可安装）
单元测试        hvigorw test -> Tests run: 21, Failure: 0, Error: 0, Pass: 21, Ignore: 0
诊断日志        当前 APP 源码无 IdentityTrace/DeviceIdentityDiag/DiagTrace 残留；最终 HAP 为干净构建
```

回退包（保留，未使用）：

```text
<WORKSPACE>\competition\evidence\2026-10-22-monitor-inline-summary-local\
guardian-inline-summary-formal.hap
size=2,077,912 B
sha256=8A722EB6FDA7BB73EE58F3BDA3D95B5D238401DA8E3CC9179F1286FD5253A985
```

## 2. P0-A 证据（REAL PASS）

详见：[P0-A supervisor 真实验收](2026-10-24-p0a-supervisor-real-acceptance.md)

要点：

- 22:32 用户双击入口并隐藏输入一次 key；22:32:32 supervisor `11872` 启动；22:32:48 worker `45928`；
- 22:35:49 受控只杀 worker `45928` → 1282 ms 内自动拉起 `50580`，supervisor 未变、无双实例、未再次要求密钥；
- 22:41:33–22:56:46 15 分钟观察：supervisor PID 稳定、worker 始终 1 个；
  三设备自然 202：`esp32-kitchen=32`、`esp32-bath=32`、`dayu200-living=47`，持续增长；
- API 探针：三设备 `lastSeenTs` 全部前进；kitchen gas/smoke raw+valid、bath motion、living state 均为真实字段；
- 事件日志（含 worker stdout/stderr，无 key）：
  `evidence/2026-10-24-public-sync-supervisor-candidate/runtime/public-sync-supervisor.log`
- 15 分钟观察日志：`.../watch15-2026-10-24.log`
- API 证据：`.../runtime/api-lastseen-20261024-224316.json`

正式入口（本轮合入，已通过 `-Preflight` 且带跨入口双实例保护）：

```text
cloud/onenet/public-sync-supervisor.js     16312 B  078553D4F7AA2CDCCE365F6B44C4616E6535F8F0C596B995A5A6F23AD20A1D47
cloud/onenet/public-sync-worker.js          1953 B  7C4138718CE4FDE259C85123A7DABF5E5C8F2A9C2A2B4022A11B93D401761164
materials/start-demo-supervisor.ps1        15335 B  D83101EC90CAB977B2F4CC82D8FE8629C01430C6FDE13EBD8C543EF28F084FBE
materials/start-demo-supervisor.cmd          186 B  85FD74D53E56232811D79FDE83FCFBADEF0BA48FEFAFADBDE846D5EFDFF82072
materials/verify-supervisor-acceptance.ps1  8696 B  E2150FE01C193C924E32BEDAA18B20E6CF0127A18BC26E0D32A242C2222E9A16
```

## 3. P0-B 证据（REAL PASS）

### 3.1 身份诊断（同一 APP PID，安装后）

```text
PRIOR_IDENTITY_MISMATCH_NOT_REPRODUCED_AFTER_INSTALL
```

详见：[身份诊断结论](../evidence/2026-10-24-app-device-identity-diag/IDENTITY-DIAG-CONCLUSION-2026-10-24.md)

同一 PID `5386` 下，HTTP raw → DTO → ViewMapper → AppStorage → MonitorPage 的
`deviceId/roomId/roomName/kind` 全部一致；`sensorDeviceIdMismatches=0`；
kitchen=厨房（gas/smoke）、bath=卫生间（motion）、living=客厅（pending），无串房。
原“全部筛选都显示客厅”未复现，因此只能如实记录为“安装后未复现”，不声称修复原内存问题。

### 3.2 APP-P0-Sensors 真实验收

```text
首页在线数：3/5（与 MonitorPage 3/5 一致；保留 5 台历史设备，不删除）
MonitorPage：3/5；厨房 MQ-5/MQ-2 原始 ADC + “报警未启用”；客厅待确认；卫生间 PIR
DevicePage：stateText/valueText/detailText 均显示
  厨房节点：能力已核实；AHT20 温湿度、MQ-5、MQ-2；无 PIR/门磁/摄像头；
            燃气（MQ-5）报警未启用 原始 ADC n；烟雾（MQ-2）原始 ADC n
  卫生间节点：能力已核实；温湿度、人体活动（PIR）、紧急求助按键；无燃气/烟雾/门磁/摄像头；
            PIR“正常 / 最近活动 刚刚 / 今日 N 次”
归属：MQ-5/MQ-2 属于 esp32-kitchen；motion 属于 esp32-bath；厨房无 PIR，卫生间无 MQ
自然帧：MQTT 观察 retain=0；bath motion.countToday 37→49、96→98、126→134 真实增长；
        kitchen gas/smoke raw+valid=true；bath gas/smoke raw=0 valid=false（无 MQ，UI 不展示）
DAYU ALARM：living 自然帧 state=ALARM retain=0，APP 如实显示待确认告警；本轮未发送 ACK
```

### 3.3 本轮发现的真实失败点与修正

```text
首个真实失败点：MonitorPage 传感器卡片在自动轮询后不重渲染（列表项复用旧值）
  证据：同一 APP PID 下 MonitorPage 停在“今日 83 次”，重新打开 DevicePage 已显示“98 次”，
        且 MQTT/API 均为 96–98；顶部“上次更新”却在前进。
  根因：ForEach key 为稳定值（deviceId_kind_idx），ArkUI 复用列表项，
        SensorCard 的 @Prop 不会随父级重建而更新。
  修正：MonitorPage / DevicePage 的 ForEach key 纳入 stateText/valueText/detailText
        （DevicePage 设备卡 key 纳入 lastSeenTs/online），仅事件驱动重建，不改业务逻辑。
  构建：BUILD SUCCESSFUL；单测 21/21 PASS；install -r 后同一 PID 复验：
        未触碰 UI 的 100 秒内 kitchen 原始 ADC 264→265、烟雾 111→112；
        PIR 今日次数 126→134 自动更新。
```

### 3.4 90 秒离线与恢复（同一 APP PID）

```text
bath 自然离线：最后一条 202 在 23:32:03；之后 ARP Stale、无自然帧（非人为改 Wi-Fi/固件）
APP 表现（PID 26710）：
  23:34:34 MonitorPage 2/5；bath 卡片“离线·上次读数 / 最近活动 2 分钟前 / 今日 134 次”；
             “设备离线，展示上次读数，不代表当前状态”；HomePage 同为 2/5
恢复：bath Wi-Fi 由用户按历史方式现场恢复后 23:44 自然帧恢复；
      期间 DAYU fport tcp:9001→tcp:9000 丢失（USB 集线器插拔影响），按既有恢复方式重建；
      23:48 MonitorPage 3/5、HomePage 3/5、bath PIR 恢复为“最近活动 刚刚 / 今日 11 次”（设备重启后计数重置）
全程 APP PID 26710 未重启；supervisor 11872/worker 50580 未受影响
```

## 4. 本轮实际修改/新增文件

```text
修改（APP 源码，最小 UI 修正）：
  APP/ElderlyCareGuardian/entry/src/main/ets/pages/MonitorPage.ets
  APP/ElderlyCareGuardian/entry/src/main/ets/pages/DevicePage.ets
修改（supervisor 候选，P0-A 加固）：
  evidence/2026-10-24-public-sync-supervisor-candidate/public-sync-supervisor.js
  evidence/2026-10-24-public-sync-supervisor-candidate/public-sync-worker.js
  evidence/2026-10-24-public-sync-supervisor-candidate/start-demo-supervisor-candidate.ps1
  evidence/2026-10-24-public-sync-supervisor-candidate/test/supervisor.test.js
  evidence/2026-10-24-public-sync-supervisor-candidate/DESIGN.md
新增（正式链路）：
  cloud/onenet/public-sync-supervisor.js
  cloud/onenet/public-sync-worker.js
  materials/start-demo-supervisor.ps1
  materials/start-demo-supervisor.cmd
  materials/verify-supervisor-acceptance.ps1
  materials/README.md（新增三行说明，其余保留）
新增（验收工具与证据）：
  evidence/2026-10-24-public-sync-supervisor-candidate/verify-supervisor-acceptance.ps1
  evidence/2026-10-24-public-sync-supervisor-candidate/probe-api-lastseen-p0a.ps1
  evidence/2026-10-24-public-sync-supervisor-candidate/test/lifecycle-probe.js
  evidence/2026-10-24-public-sync-supervisor-candidate/test/probe-harness.js
  evidence/2026-10-24-public-sync-supervisor-candidate/test/probe-stub-public-sync.js
  evidence/2026-10-24-app-p0-sensors-local/mqtt-observe-natural.js
  evidence/2026-10-24-app-p0-sensors-local/guardian-app-p0-sensors-autorefreshfix-2026-10-24.hap
  evidence/2026-10-24-app-device-identity-diag/IDENTITY-DIAG-CONCLUSION-2026-10-24.md
本文件：
  docs/evidence/2026-10-24-p0-final-freeze.md
```

## 5. 边界与未做事项

1. 未操作/未烧录 ESP32（COM5/COM8/COM14 均未操作；现场端口以用户口径 COM6/COM9/COM11 为准）。
2. 未修改公网 backend、设备绑定、Wi-Fi/AP、DNS；未恢复 OneNET；未接入 4G/GNSS；未做 DAYU 本机 YOLO 迁移。
3. 未手工发布 MQTT / 未发送 HTTP ingest；202 均来自自然上报，retain=0。
4. 未触发 SOS/ACK/reset；DAYU 的 ALARM 状态如实保留，未 ACK。
5. 未覆盖 DAYU 正式 HAP 或 homemon。
6. supervisor 仍不能防自身/整个 Windows Job 被强杀；密钥不持久化，重启电脑后需再次双击并隐藏输入。
7. 仍无“worker 存活但 MQTT 消费停止”的业务级看门狗；HEALTHY 只是进程级状态，业务健康由自然 202/API 证明。
8. 当前实际运行的 supervisor 入口是 evidence 候选入口；正式 materials 入口已合入但尚未实际启动（下一次演示使用新入口即可）。
9. fport 在 USB 集线器插拔后可能丢失，重启/插拔 USB 后需确认 `hdc fport ls`，必要时重建。

## 6. 下一次现场启动（最小步骤）

```text
1. 确认电脑与三设备在同一原演示网络（PC IP 10.127.130.179；ESP32 网关配置）。
2. 关闭旧 supervisor 窗口（若在运行），双击：
   <WORKSPACE>\competition\materials\start-demo-supervisor.cmd
3. 等待结构检查通过，在可见窗口隐藏输入一次 INGEST_KEY，保持窗口打开。
4. 手机模拟器 127.0.0.1:5555 使用本文件第 1.2 节的 HAP（已安装）；如重装用 install -r。
5. 核对：首页/MonitorPage 3/5；三设备自然 202；API lastSeen 前进；
   `materials/verify-supervisor-acceptance.ps1 -WatchMinutes 15 -MinPerDevice 10`。
```
