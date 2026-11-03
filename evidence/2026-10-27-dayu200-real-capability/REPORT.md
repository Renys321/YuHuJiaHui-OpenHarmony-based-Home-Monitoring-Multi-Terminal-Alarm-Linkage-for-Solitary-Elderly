# DAYU200 板端应用 1.0.3 · 真实能力与文案整改（2026-10-27）

- 设备：DAYU200（`hdc` target `450100445634303332012847942eca00`），OpenHarmony 7.0.0.38 / API 26，720×1280
- APP：`com.dsh.eldercare`，**1.0.2 / 1000002 → 1.0.3 / 1000003**
- 设备已安装原包：`dayu-eldercare-preview-integration-1.0.2-signed.hap`（1,883,399 B，SHA-256 `A696698A…324DAFFE`，保留为回滚包）
- 新包：`dayu-eldercare-realcap-1.0.3-signed.hap`（1,336,817 B，SHA-256 `016B13AF…50B2DB39`），签名身份与原包一致（证书指纹 `8E:93:86:3F:…:00:24:B5`），`verify-app` / `verify-profile` 通过
- 安装：`hdc install -r` 覆盖成功；应用数据目录保留（`eldercare_preview_tuning` 偏好仍在：widthPct=60 / scalePct=130）
- 结论：**板端应用已真实更新并安装**，不是只改源码或只写方案。

## 1. 为什么 1.0.2 需要更新（改造前实测）

| 问题 | 改造前表现（截图 `00-before-*`） | 性质 |
|---|---|---|
| 无活动告警文案 | “长时间未检测到人体活动，**疑似跌倒或昏迷**” | 误导：NO_MOTION 只表示未检测到活动，不等于跌倒/昏迷 |
| 客厅占位传感器 | 客厅显示“今日活动 0 次、温度 待确认、湿度 待确认、门窗 关闭”，但 DAYU 本机 PIR/温湿度/门磁**物理未接线** | 把固件兼容占位字段当已安装 |
| 厨房能力过期 | 厨房只显示温湿度/燃气/烟雾；PIR（GPIO38）与门磁（GPIO14）已于 2026-10-27 在板，却未显示 | 能力表仍是旧快照 |
| 卫生间门磁 | 卫生间不显示门磁；门磁 GPIO14 已真实上报 | 同上 |
| 离线读数标注 | 设备离线时仍显示温度/湿度等数值，仅顶部小字“已选设备离线” | 容易把历史值当当前状态 |
| 切换设备后的闭环提示 | 切到另一台设备后仍保留上一台的“✓ 设备已确认，闭环完成” | 跨设备误导 |
| 燃气/烟雾告警文案 | 若出现 GAS/SMOKE 告警，文案写“检测到燃气泄漏/疑似火情” | MQ 仅原始 ADC、阈值未标定/报警未启用，不能断言泄漏/火情 |
| 版本信息 | 无 APP 版本行，安装 1.0.2 无直观更新标识 | 无法确认是否更新 |

## 2. 1.0.3 改动（仅 APP，未改硬件/固件/P0 链路）

1. `model/DeviceCapabilities.ts`（2026-10-27 在板事实）：
   - 客厅 `dayu200-living`：仅 `camera=true`（本机取帧）；`motion/door/climate` 置 false（物理未接线，占位字段不展示）；
   - 厨房：新增 `motion=true`（SR312/GPIO38）、`door=true`（GPIO14），保留 climate/gas/smoke；
   - 卫生间：新增 `door=true`（GPIO14），保留 climate/motion/sos；
   - 新增 `esp32-sos`（仅 SOS，无环境/电量遥测）。
2. `model/DeviceModel.ets`：
   - NO_MOTION → “长时间未检测到活动；无活动不等于跌倒或昏迷，请确认老人情况”；
   - GAS/SMOKE → “设备上报燃气/烟雾异常（MQ 原始 ADC 未标定、报警阈值未启用，需现场核实）”。
3. `pages/Index.ets`：
   - 选中设备离线时显示黄色横幅：“已选设备离线：以下为最后一次上报的历史读数，不代表当前状态”；
   - 切换设备清空上一台设备的 ACK 闭环提示；
   - 设备信息卡新增 “APP 版本 1.0.3 · 2026-10-27 真实能力整改”；
   - 统计页无 PIR 的房间改为“该房间未配置 PIR 人体活动传感器 / 客厅人员检测来自摄像头”，不再画全 0 活动图。
4. `AppScope/app.json5`：1.0.2 → 1.0.3 / 1000003。

## 3. 运行验收（安装后实拍）

| 截图 | 结果 |
|---|---|
| `01-after-launch.jpeg` | 客厅页只保留“设备信息 + 客厅摄像头（本地取帧/640×480/FRONT）”；`今日活动/温度/湿度/门窗` 占位卡已消失；版本行 1.0.3 |
| `02-kitchen.jpeg` | 厨房新增真实 `今日活动 1 次`、`最后活动 18 分钟前`、`门窗 开启`、`厨房·门窗状态`；燃气/烟雾仍为“原始 ADC 4095/70 · 报警未启用” |
| `03-bath.jpeg` | 卫生间显示 `今日活动 110 次`、温湿度、`门窗 开启` |
| `04-living-alert.jpeg` | 无活动告警文案已改为“长时间未检测到活动；无活动不等于跌倒或昏迷，请确认老人情况” |
| `05-living-report.jpeg` | 客厅统计页不再显示全 0 活动图，改为“该房间未配置 PIR 人体活动传感器 / 摄像头人员检测见实时状态”；预警统计真实（今日 1 / 待处理 1 / 已闭环 0） |

- 安装后 `bm dump`：`versionName=1.0.3`、`versionCode=1000003`、`appProvisionType=debug`、`fingerprint=8E9386…24B5`（与原包一致）。
- 未执行 ACK/处置/清数据；本地 homemon 在页面重启后新产生的一条 NO_MOTION 告警仅展示，未确认。

## 4. 未完成 / 限制（如实）

1. **离线横幅未实拍**：验收时厨房/卫生间/客厅均在线（3/3），未制造离线窗口；横幅代码已构建，标记为 SOURCE-ONLY。
2. **NO_MOTION 告警身份**：本地 homemon 在无 PIR 的客厅仍会按时限产生 NO_MOTION（固件逻辑既有）；1.0.3 只保证文案不推断跌倒/昏迷，未改 homemon 判定逻辑。
3. **摄像头/预览**：沿用 1.0.2 的本地相机与预览调节；本次未改 CameraModel/Streamer，也未做远程视频。
4. **电量**：DAYU200 由适配器供电、无电池采样，本页不显示电量；状态栏 11% 是设备系统电池图标，不是 APP 数据。
5. **未改硬件/固件/P0 链路**：未烧录、未开串口、未改 homemon/bridge/后端，未触发 ACK/SOS。
6. **回滚**：若需回退，`hdc -t <DAYU> install -r rollback-1.0.2-signed.hap`（覆盖安装、保留数据）。

## 5. 证据

- `dayu-eldercare-realcap-1.0.3-signed.hap`、`rollback-1.0.2-signed.hap`、`SHA256-1.0.3.txt`、`SHA256-rollback.txt`
- `build-1.0.3-unsigned.log`、`verify-app-1.0.3.log`、`verify-profile.log`、`verify-profile.json`
- `bm-dump-before-1.0.2.txt`、`bm-dump-after-1.0.3.txt`
- `screenshots/00-before-*`（改造前 4 张）、`01-after-launch` / `02-kitchen` / `03-bath` / `04-living-alert` / `05-living-report`（1.0.3 运行）
- 源码工作副本：`competition/experiments/dayu-eldercare-preview-integration-2026-10-25`（签名/构建脚本与签名材料目录同前）
- 改造前源码备份：`competition/evidence/2026-10-27-real-capability-app/_work/dayu-before-20261027-1950/`
