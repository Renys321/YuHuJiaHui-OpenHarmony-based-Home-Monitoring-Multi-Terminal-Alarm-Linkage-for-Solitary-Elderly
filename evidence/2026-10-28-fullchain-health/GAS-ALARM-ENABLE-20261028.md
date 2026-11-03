# 燃气/烟雾报警阈值启用 · 实施记录（2026-10-28 02:19–02:41）

- 授权：用户明确「启用阈值，现在就做，全部；COM4 是 ESP32-S3 厨房固件」
- 范围：固件阈值 + 板端 APP 能力 + 手机 APP 能力（三处缺一不可）
- 结论：**三处全部完成并验证**；设备已按新阈值运行，APP 文案已切换；**尚未用真实气体触发验证**
- 回滚点：固件 app 分区备份、APP 源码改动、HAP 产物均在下方列出

---

## 1. 阈值与算法

| 参数 | 值 | 依据 |
|---|---|---|
| GAS（MQ-5）阈值 | **900** | 实测基线 326–462（峰值 462），约 2 倍余量 |
| SMOKE（MQ-2）阈值 | **700** | 实测基线 119–295，约 2.4 倍余量 |
| 连续确认次数 | 3（`CONFIG_NODE_MQ_CONFIRM_COUNT`） | 沿用既有配置；5.5s/帧 → 约 15s 触发 |
| 回差 | 20（`CONFIG_NODE_MQ_HYSTERESIS_RAW`） | 解除需连续 3 帧 < 阈值−20 |

算法位置：`esp32-node/main/alarm_logic.h: mq_stab_update()`——阈值 ≥4096 视为禁用；否则未危险需连续 confirm 次 ≥ 阈值，已危险需连续 confirm 次 < 阈值−回差才解除。

---

## 2. 固件（厨房 ESP32-S3，COM4）

| 项 | 值 |
|---|---|
| 写前身份核对 | `esptool chip_id` → ESP32-S3 QFN56 v0.2，MAC **50:78:7d:16:ed:60**（厨房） |
| 源码 | `.local/gas-alarm-20261028/kitchen-src`（复制当前在板同源的 door-v7 树，仅改配置） |
| 配置 | `sdkconfig.kitchen-alarm`：`MQ5_ALARM_RAW=900`、`MQ2_ALARM_RAW=700`；PIR=38、门磁=14、VOICE=y、MQ5=CH6 全部保留 |
| 构建 | ESP-IDF v5.1.6，`idf.py build`，967 目标，BUILD OK；`CONFIG_NODE_MQ*_ALARM_RAW` 已在 `sdkconfig.h` 复核 |
| 镜像 | `build/esp32_elder_node.bin` **1,023,440 B**，SHA-256 `17852D7501FC1F42FDB36214FC95E89F2C6C3EB5458580E8A1F0ED7E604491B2` |
| 写前备份 | `device-backup/COM4-app-before-gas-alarm-20261028.bin`，1,048,576 B，SHA-256 `930F02378D2F46F7898BB65700EA5AB0D4ABD9D1C643CA228230BE1006F97756` |
| 写入 | `write_flash 0x10000`，只写 app 分区、不整片擦除；`Hash of data verified`，15.9s |
| 启动验证 | 02:27:00 重新绑定 9101（新源端口 61490），state=NORMAL，gas 395–462 / smoke 119–167，**无告警**（均低于阈值） |

---

## 3. 手机 APP（com.example.program_04，模拟器 127.0.0.1:5555）

| 项 | 内容 |
|---|---|
| 源码改动 | `core/capability/DeviceCapabilities.ts`：厨房 gas/smoke 的 `alarmEnabled` false→true（含 note）；`core/view/ViewMapper.ts`：启用分支 detailText 改为“GAS/SMOKE 报警已启用（阈值 900/700，连续 3 帧）…”，无效分支去掉“报警未启用”字样 |
| 构建 | hvigor assembleHap → `entry-default-unsigned.hap` **3,598,409 B**，SHA-256 `A2A0CA711800ED3153389687751505287D4EF33292A13A8B75606DBA30D6CC14` |
| 安装 | 模拟器为开发镜像，**接受未签名 HAP**（`install -r` 成功）；带签名的包因与在装应用签名身份不一致被拒（9568332） |
| 副作用与恢复 | 重装会重启 APP，会话只存内存 → 回到登录页；已用 `.secrets/app_guardian.txt` 的监护人凭据经 UI 自动化重新登录，恢复为 4 房间 / 4 设备 / 真实 API 数据 |
| 验证 | 监测页实测：`燃气（MQ-5） 原始 ADC 420` + `GAS/SMOKE 报警已启用（阈值 900/700，连续 3 帧），未标定，不代表 ppm`；`烟雾（MQ-2） 原始 ADC 153`；**全页无“报警未启用”** |

---

## 4. 板端 APP（com.dsh.eldercare，DAYU200）

| 项 | 内容 |
|---|---|
| 源码改动 | `entry/src/main/ets/model/DeviceCapabilities.ts`：厨房 `mqAlarmEnabled` false→true（并更新注释） |
| 构建 | hvigor assembleHap → unsigned HAP 2,024,688 B |
| 签名 | 板端强制验签（未签名报 9568320）；用 `northbound/signing/app-chain.pem` + `final-profile.p7b`（bundle=com.dsh.eldercare，device-id=DC3ABD…54C 与板端 UDID 一致）+ SDK `OpenHarmony.p12`（口令 123456）签名成功 |
| 产物 | `lead/artifacts/app-board-sign/eldercare-gas-alarm-signed.hap` **2,063,260 B**，SHA-256 `6174573A8BEA2643CD18EF413564253BA148958D7B95DAECB24B783693BCBE07` |
| 安装 | `hdc -t 4501… install -r` → `install bundle successfully` |
| 验证 | 启动后 UI 仍显示 `随身求助 · 全屋在线 4/4 台设备`；watcher `p0=healthy / nodes=4/4 / inference=running` 未受影响 |

---

## 5. 端到端现状（02:41）

- 厨房节点 online（02:27 重启后持续上报，5.5s 节拍），gas 414–422 / smoke 154–157，state=NORMAL；
- 9101 两节点连接稳定；bridge 零错误（仅既有 esp32-sos 坏帧）；
- watcher：`p0=healthy`、`nodes=4/4`、`app=present`、`inference=running`、`cameraFrames=LIVE`。

---

## 6. 未验证项与风险（必须知道）

1. **阈值未用真实气体触发验证**：目前只证明“低于阈值不误报”；能否被 LPG 触发、触发后声光/语音/APP 告警卡是否正常，**未做**。
   - 若要验证，建议用打火机在传感器附近放气（不点火），观察 raw 是否越过 900；或接受“未实测”并在演示前口头说明。
2. **手机 APP 会话不持久**（登录页“记住登录状态”默认未勾选）：APP 进程被杀/设备重启后需要重新登录。本次重装已导致一次登录丢失并已恢复；演示前不要再重装 APP。
3. **板端 APP 的燃气行未逐页截图确认**（只验证了安装成功与 4/4 保持）；标签逻辑在 `Index.ets:850`，已随 `mqAlarmEnabled=true` 切换。
4. 阈值是工程值，不是标定值：不得宣称 ppm、浓度或“燃气安全”；MQ-5 仍需 24–48h 老化后复测基线。

---

## 7. 回滚方法

| 层 | 回滚 |
|---|---|
| 固件 | `esptool --chip esp32s3 -p COM4 write_flash 0x10000 device-backup/COM4-app-before-gas-alarm-20261028.bin`（恢复旧阈值 4096=禁用） |
| 手机 APP | 源码改回 `alarmEnabled=false` 并更新 ViewMapper 文案 → 重新 hvigor 构建 → `hdc -t 127.0.0.1:5555 install -r` |
| 板端 APP | 源码改回 `mqAlarmEnabled=false` → 构建 → 用同一签名链重签 → `hdc -t 4501… install -r` |
