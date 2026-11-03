# 最终交付索引（2026-10-22?
当前稳定演示版本已完成归档并冻结；本?*未改业务代码、未重建、未安装、未重启服务**? 
运行目标?**HarmonyOS 手机模拟?*，不是实体手机兼容性验收? 
所有历史证据保留；本索引作为最新入口，不重写历史结论?
## 1. 先看这三?
| 文档 | 用?|
|---|---|
| [最终演示版本清单与验收矩阵](2026-10-22-final-delivery-baseline.md) | 当前实际运行的固?HAP/gateway/homemon、完?SHA-256、已部署/候?回退状态、最?PASS 矩阵 |
| [8A722 最终版本冻结与交付收尾](2026-10-23-final-freeze-8a722.md) | 唯一推荐包、模拟器/实体手机边界、源码快照、DAYU 恢复说明、冻结声?|
| [演示前启动与三房间检查清单](2026-10-22-demo-startup-checklist.md) | 现场启动顺序、单实例、HDC target/fport、节?202?/3 ?3/5 口径 |
| [本机 valid 部署验收](2026-10-22-valid-contract-deployment-acceptance.md) | public-sync/HAP 实际部署、手机真实“读数有效”验收、回退步骤 |

## 2. 当前版本一句话

```text
厨房/卫生间固件：330D9C?/ 8D4E9A…（已部署）
DAYU signed HAP?F2529…（已部署，未改?手机当前：guardian-inline-summary-formal.hap 8A722…（已安装；模拟?APP 真实同进程自动恢?PASS；回退 8F8925…）
手机回退?F8925…（含“恢复后监测页可能不更新”已知缺陷）?6805D?94F90E?为更早基?gateway.js?4790E…（本机 public-sync 已加载）
板端 homemon?D2435…（旧程序，?climate.valid；未替换?homemon 候选：06ECFB…（仅候选，部署 BLOCKED?```

## 3. 最新证?
### 三节?卫生间恢?
- [COM8 只读识别（ESP32-S3 候选板，非项目固件）](2026-10-23-com8-identification.md)
- [COM8 实物/外设确认（外设均未接入）](2026-10-23-com8-hardware-wiring-confirmation.md)
- [COM8 客厅门磁/PIR/DHT11 接线与独立固件准备（未烧录）](2026-10-23-com8-living-wiring-and-firmware-prep.md)
- [COM8 bench 烧录?DHT11 自检失败（历史）](2026-10-23-com8-bench-flash-and-dht11-failure.md)
- [COM8 DHT11 五连?bench PASS（驱动时序修复）](2026-10-23-com8-dht11-bench-pass.md)
- [COM8 PIR/SOS 本地 bench BLOCKED（无 GPIO 变化）](2026-10-23-com8-pir-sos-bench-blocked.md)
- [卫生?Wi-Fi 恢复与三节点在线](2026-10-23-bath-wifi-recovery-final.md)
- [卫生间当前故障定位](2026-10-22-bath-node-current-fault.md)
- [卫生间凭据复核与现场恢复](2026-10-22-bath-wifi-credential-recheck-recovery.md)
- [厨房/卫生间双节点重新烧录](2026-10-22-kitchen-bath-dual-reflash.md)

### `valid` 合同与部?
- [字段追踪与本地修复](2026-10-22-valid-contract-field-trace.md)
- [本机部署与手机真实验收](2026-10-22-valid-contract-deployment-acceptance.md)
- [homemon climate.valid 合同（未部署候选）](2026-10-22-homemon-climate-valid-contract.md)

### 客户?展示

- [UI 能力与在线概览修复](2026-10-22-ui-capability-online-overview-fix.md)
- [三房间展示与卫生?SOS/ACK（历史）](2026-10-22-three-room-display-and-bath-sos-ack.md)

历史汇总入口：`docs/ARTIFACTS.md` 保留为历史，不作为当前版本安装依据；当前以本索引和最终版本清单为准?
## 4. 回退入口

```text
手机回退 HAP:
<WORKSPACE>\competition\evidence\2026-10-23-valid-contract-local\guardian-baseline.hap
sha256 94F90E2148042C875B259464A331C72101979E77471225F64F9B09B14812CBFD

手机上安装的当前候选（摘要内联；真?PASS?
<WORKSPACE>\competition\evidence\2026-10-22-monitor-inline-summary-local\guardian-inline-summary-formal.hap
sha256 8A722EB6FDA7BB73EE58F3BDA3D95B5D238401DA8E3CC9179F1286FD5253A985

回退包（8F?
<WORKSPACE>\competition\evidence\2026-10-22-offline-expiry-local\guardian-offline-expiry-candidate.hap
sha256 8F8925BD85B6F28524DC9EDAC3E4BFF00C0658A736770CEEFC062C72680F769F

监测刷新失败候?1（未安装?
<WORKSPACE>\competition\evidence\2026-10-22-monitor-refresh-local\guardian-monitor-refresh-candidate.hap
sha256 94361A6603A3ABCFC33EF2F965D92B55B301E087695B4931A63CFF843F2212A7

监测刷新失败候?2 / live-snapshot（未安装?
<WORKSPACE>\competition\evidence\2026-10-22-monitor-refresh-local\guardian-live-snapshot-candidate.hap
sha256 7A78C68C928A0FF2C6B688DED34BD70FD3A0E52E3B073E25ADC1A1FD5C21A7EE

平台绑定测试候选（失败，未安装，禁止演示）:
<WORKSPACE>\competition\evidence\2026-10-22-monitor-refresh-local\guardian-platform-test-candidate.hap
sha256 6B7CD42C0B41E417579DE298DA0A18EC1F5BCC96701FCBAF858F31FDC9D9F816

摘要内联正式候选（平台 PASS，真实模拟器 PASS，最终已安装?
<WORKSPACE>\competition\evidence\2026-10-22-monitor-inline-summary-local\guardian-inline-summary-formal.hap
sha256 8A722EB6FDA7BB73EE58F3BDA3D95B5D238401DA8E3CC9179F1286FD5253A985

上一版回退 HAP:
<WORKSPACE>\competition\evidence\2026-10-23-valid-contract-local\guardian-valid-candidate.hap
sha256 86805DC2EBAA3D39DE58F5255CFBCF924EF178EA64820BAECF8C65325DDF9504

gateway 回退/修改前重建副?
<WORKSPACE>\competition\evidence\2026-10-23-valid-contract-local\source-original\

板端 homemon 原程?
<WORKSPACE>\competition\evidence\2026-10-23-homemon-valid-baseline\homemon.board-pre
sha256 0D243539403DE89C547DEFACF43C86A4980142EF8EC686B277BE7133C42881E6
```

注意：`source-original` ?*反向补丁重建?*，不是现场原始复制；差异仅撤销本轮 `valid` 旁路保留。回退步骤见版本清?部署验收文档?
## 5. 边界：模拟器 / 实体手机

- 当前真实端到端通过?**HarmonyOS 手机模拟?APP + 真实后端/实体节点**；实体手机兼容?**NOT TESTED**?- `8F8925…` ?*含已知缺陷的回退版本**（恢复后监测页可能不更新），不能当作等价交付?- DAYU 摄像头切换、SOS/ACK 实体闭环为历史证据，本轮未重测?- 详细冻结边界?[8A722 最终版本冻结](2026-10-23-final-freeze-8a722.md)?
## 5.1 仍未解决/未部?
- 客厅 `climate.valid` ?homemon 候选兼容验证已完成；但手机端既?capability 仍显示“待确认”，bath 在部署尝试期间外?202 中断，部署已按安全条件回退原程序。详?[homemon valid 部署尝试与回退](2026-10-22-homemon-valid-deployment-attempt.md)。当?bath 已通过现场供电/位置变化恢复，精确物理根因未隔离，见 [凭据复核与现场恢复](2026-10-22-bath-wifi-credential-recheck-recovery.md)?- ?homemon 候选：**未部?*（已回退；来?客户?链路阻塞见上）；最终版本清单继续指向旧 `0D2435…`?- 客厅 `climate.valid`：板端旧程序仍缺字段，手?DAYU 如实“待确认”；建议独立维护，不立即替换来源未核清的板端程序?- 公网 backend?*未部署、未改动**；当前链路依赖既有线上版本，手机已真实显示厨?卫生间有效?- 真实传感器故?`valid=false`、SOS/ACK 实体重测、PIR/蜂鸣?燃气报警?*未测?*（历?ACK 不作为本轮重测）?- 当前禁用/未开放：厨房 MQ 报警、卫生间 MQ/水漏、厨?卫生间摄像头、手机一键呼?视频探望等，按现有能力配置保留?- 手机离线过期修复：断?2/5、历史读数已真实验收；恢复后监测页自动刷新仍有残余，需重启 APP 才从 2/5 收敛?3/5。详?[离线过期修复验收](2026-10-22-offline-expiry-recovery-fix.md)?- 监测?live-snapshot/revision 修复尝试?FAIL，已回退?8F；详?[monitor refresh failed](2026-10-22-monitor-refresh-live-snapshot-failed.md)?- 平台 A→B→C 验证也在 B 阶段 FAIL（卡片更新、摘要仍 3/5），详见 [ArkUI binding failed](2026-10-22-monitorpage-arkui-binding-failed.md)?- 摘要内联修复平台 A→B→C PASS；living 断点恢复后，8A722 在真实同进程完成 3/5?/5→自?3/5，详?[living restore + final acceptance](2026-10-22-living-chain-and-8a722-final-acceptance.md)?
## 6. 当前服务状态（2026-10-23 01:03 只读检查；PID 仅历史参考）

```text
Broker 6540 / 1883
Bridge 13508 / 9101
public-sync 32584 + 30216，lock 32584（单逻辑实例?HDC fport tcp:9001 -> tcp:9000
DAYU homemon 2442 / 9000（原版）
手机模拟?127.0.0.1:5555
```

最新自?202?1:03 CST）：living 17:03:33Z、kitchen 17:03:09Z、bath 17:03:18Z；DAYU 3/3，手?3/5（两台历史离线设备保留）。PID 会随重启变化，不作为长期存活证明?

---

## 2026-10-24 £P0-A/P0-B ʵպ

 [2026-10-24 P0 ʵն](2026-10-24-p0-final-freeze.md)

- P0-Asupervisor + һREAL PASS豸Ȼ 202ܿ worker ֹԶָ15 ȶAPI lastSeen ǰ
- P0-BAPP MQ-2/MQ-5/PIR/DevicePage/Զˢ/߻ָREAL PASSͬһ APP PID 26710ڼ䷢ֲ MonitorPage ƬԶˢ²Ⱦȱݡ
- ǰֻ APPevidence/2026-10-24-app-p0-sensors-local/guardian-app-p0-sensors-autorefreshfix-2026-10-24.hap
  2,086,949 BSHA-256 9EEBEE9A5FC9EEC5A5993DC6923F16F0BFCCCD1CD4DE64BAF36FC7197ECAD25AѰװ 127.0.0.1:5555
- 8A722 ˰ 8A722EB6...A985 δʹûˡ
- ʾƼڣmaterials/start-demo-supervisor.cmd start-demo-current.cmd Ϊˣ
