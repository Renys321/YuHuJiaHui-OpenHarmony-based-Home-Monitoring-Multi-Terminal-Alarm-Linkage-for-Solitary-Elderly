# APP-P0-Sensors 最终安装版本记录（2026-10-24）

```text
bundle          com.example.program_04
versionName     1.0.0 / versionCode 1000000
target          127.0.0.1:5555（既有 Mate 90 Pro 模拟器，未新建、未清数据）
APP PID         26710（23:27:48 起；自动刷新/离线/恢复全程未重启）
安装方式        hdc -t 127.0.0.1:5555 install -r（保留数据）
```

## HAP

```text
path    <WORKSPACE>\competition\evidence\2026-10-24-app-p0-sensors-local\
        guardian-app-p0-sensors-autorefreshfix-2026-10-24.hap
size    2,086,949 B
sha256  9EEBEE9A5FC9EEC5A5993DC6923F16F0BFCCCD1CD4DE64BAF36FC7197ECAD25A
```

构建：

```text
hvigorw assembleHap --mode module -p product=default -p buildMode=debug --no-daemon
BUILD SUCCESSFUL（signingConfigs 未配置，unsigned；模拟器可安装）
```

单元测试：

```text
hvigorw test --mode module -p product=default -p module=entry@default --no-daemon
Tests run: 21, Failure: 0, Error: 0, Pass: 21, Ignore: 0
```

## 本轮真实修正（相对 F91852D0 候选）

F91852 候选在真实验中暴露：MonitorPage 传感器卡片在自动轮询后不重渲染
（同一 APP PID：MonitorPage 停在“今日 83 次”，重新打开 DevicePage 已是“98 次”，
MQTT/API 均为 96–98；顶部“上次更新”却前进）。

根因：`ForEach` key 为稳定值 `deviceId_kind_idx`，ArkUI 复用列表项，
`SensorCard` 的 `@Prop` 不随父级重建更新。

修正（仅 key，业务逻辑未改）：

```text
pages/MonitorPage.ets
  ForEach key: 增加 stateText/valueText/detailText
pages/DevicePage.ets
  sensor row key: 增加 stateText/valueText/detailText
  device card key: 增加 lastSeenTs/online
```

源码哈希：

```text
pages/MonitorPage.ets  AE4BB64468138519B3E8ECB972D0F0EB3E909B3596776418F3943721732F7B7A  (12,948 B)
pages/DevicePage.ets   1B50DDE3824368C8AE0A26A0FD688978B7830373A3D7B7D9C1AC5C5D768194A5  (18,360 B)
core/api/Contracts.ts  4CC10AAB040B0F04516C5D9EB2303D61EAA18E94643656709F2AD999FCA72428
core/view/ViewMapper.ts 432EC89853AEFEE1EC582A38FADE991A984014DBC80F0994F25266B47FB76106
pages/HomePage.ets     4AEC2E18329528C53883CC86AB0340FF5EB18225FE4E867ACF5D2A20DA2BBF85
```

构建/测试日志：

```text
build-after-autorefresh-fix-2026-10-24.log
test-after-autorefresh-fix-2026-10-24.log
```

## 真实页面验收（同 PID 26710）

```text
首页           3/5 在线/设备；保留 5 台历史设备（不删除）
MonitorPage    3/5；厨房 MQ-5/MQ-2 原始 ADC + “报警未启用”；卫生间 PIR；客厅待确认
DevicePage     厨房节点：AHT20 + MQ-5/MQ-2（原始 ADC、报警未启用、无 PIR）
               卫生间节点：AHT20 + PIR（最近活动/今日 N 次、无 MQ）
               两页数值来自同一批 devices，房间归属无串
自动刷新       未触碰 UI 的 100 秒：厨房 原始 ADC 264→265、烟雾 111→112、更新时间前进
               PIR 今日次数 126→134（用户真实走动两次后自动更新）
90 秒离线      bath 自然离线（最后 202 23:32:03）→ MonitorPage/HomePage 均 2/5；
               卡片“离线·上次读数（最近活动 2 分钟前，今日 134 次）”，不冒充 0、不清历史
恢复           现场恢复 bath Wi-Fi 后自然帧恢复；期间 fport 丢失已重建；
               23:48 MonitorPage/HomePage 恢复 3/5，bath PIR“最近活动 刚刚 / 今日 11 次”，
               全程 APP PID 26710 未重启
MQ/PIR 原始    MQTT 观察 retain=0：bath motion.countToday 37→49、96→98、126→134；
               kitchen gas/smoke raw+valid=true；bath gas/smoke raw=0 valid=false（无 MQ，UI 不展示）
DAYU ALARM     living 自然帧 state=ALARM retain=0，APP 如实展示待确认告警；本轮未发送 ACK
```

证据文件：

```text
FINAL-monitorpage-2026-10-24.txt
FINAL-homepage-2026-10-24.txt
FINAL-devicepage-2026-10-24.txt
runtime-monitorpage-pir-final-2026-10-24.txt
runtime-monitorpage-autorefresh-pir-2026-10-24.json
runtime-monitorpage-offline-natural-2026-10-24.txt
runtime-homepage-offline-natural-2026-10-24.txt
mqtt-observe-pir-2026-10-24.log
mqtt-observe-pir2-2026-10-24.log
```

## 回退

保留 8A722 回退包，未使用：

```text
<WORKSPACE>\competition\evidence\2026-10-22-monitor-inline-summary-local\
guardian-inline-summary-formal.hap
size=2,077,912 B
sha256=8A722EB6FDA7BB73EE58F3BDA3D95B5D238401DA8E3CC9179F1286FD5253A985
```

完整冻结结论见 `docs/evidence/2026-10-24-p0-final-freeze.md`。
