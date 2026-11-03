# 硬件事实核验结论摘要（2026-10-27，只读）

- 工作区：`<WORKSPACE>`；时区 Asia/Shanghai；执行方式：只读源码/配置/构建产物/固件 bin 字符串/本地日志/APP UI 快照。
- **硬性边界遵守情况**：未修改 APP/后端/固件源码；未烧录、未开串口、未连接/重启设备、未访问或修改生产后端、未触发告警、未读取 `.secrets`/`.env.deploy` 真实值。
- 分级：**REAL**（本轮只读可复核事实，不代表设备此刻在线）/ **SOURCE-ONLY**（代码或配置在，未随可验证构建/部署）/ **NOT TESTED**（本轮未现场验证）/ **BLOCKED**（需设备操作或授权）。

## 0. 结论总表（每行一个可独立引用的结论）

| # | 结论 | 等级 | 关键证据 |
|---|---|---|---|
| B1 | 全部受监护板卡（kitchen/bath/sos/DAYU/wearable）均**未接入电量检测**：无采样电路、无分压、无 ADC、无固件字段、无后端字段、无 APP 数据源 | **REAL** | `BATTERY-AUDIT.md` §1；`esp32-node/main/node_main.c:1526-1556`；`.local/door-v7-20261027/build-{kitchen,bath}/config/sdkconfig.json`；`APP/.../core/inventory/DeviceInventory.ts:81-99,134-147` |
| B2 | 补电量必须“硬件分压 + 空闲 ADC1 脚 + 校准 + 固件/网关/后端/契约/UI 六层改动”，且厨房 app 分区仅余 ~26 KB | **REAL（方案）** | `BATTERY-AUDIT.md` §3；`evidence/2026-10-27-door-v7-e2e/REPORT.md` §4 分区表 |
| B3 | 厨房 PIR（SR312/GPIO38）**已装、已刷入**并真实检测到活动（2026-10-27 01:15） | **REAL** | `evidence/2026-10-27-voice-led-restore/KITCHEN-PIR-FLASH-RECORD.md:22-57` |
| B4 | 卫生间 PIR（GPIO36）真实工作（本机状态 `countToday=81`）；厨房 MQ-2(ADC CH5/GPIO6)、MQ-5(ADC CH6/GPIO7) 已接、只有原始 ADC、报警阈值 4096=禁用 | **REAL** | `bridge/status.json`；`.local/door-v7-20261027/build-{bath,kitchen}/config/sdkconfig.json`；`esp32-node/main/Kconfig.projbuild:217-241` |
| B5 | 厨房+卫生间门磁（干簧管 NO / GPIO14 / OPEN_LEVEL=1）**已装、真实开关验收、生产 v7 后端已入库 26 条** | **REAL** | `evidence/2026-10-26-door-contact-closure/report.md:142-158,241-302`；`evidence/2026-10-27-door-v7-e2e/REPORT.md:12-14,58-68,89-115` |
| B6 | 水漏**未安装**（两节点 `WATER_GPIO=-1`，仅代码/主机测试存在） | **SOURCE-ONLY**（硬件未装） | `profiles/bathroom.sdkconfig.defaults:12`；`docs/evidence/2026-10-20-bathroom-esp32-stage1-source.md:6,48,117` |
| B7 | APP 能力表（当前安装版 1.0.6 / 模拟器 `PHONE-001`；实体手机版本本轮未核实）是 **2026-10-21 静态快照**：厨房仍写“无 PIR/门磁”，卫生间门磁仍“未安装”，与 2026-10-27 在板固件不一致 | **REAL（文案过期）** | `APP/.../core/capability/DeviceCapabilities.ts:4-7,121-157`；`baseline/layout/devmgmt_top.json`；`baseline/raw/bm_dump.txt:161-162,173,528` |
| B8 | 生产“长时间无活动 · esp32-kitchen”**在能力上可真实发生**（30 min + 先武装），但该条的 alarmId/触发瞬间未取证；若早于 01:15 则只能是历史/测试/注入/错配 | **能力 REAL；告警身份 NOT TESTED** | `PIR-DOOR-AUDIT.md` §2；`KITCHEN-PIR-FLASH-RECORD.md:84-88`；`runtime/ui-last.json`（DAYU 文本“长时间无活动 / 厨房 · 14:41”） |
| B9 | DAYU/后端也会产生 NO_MOTION：DAYU homemon 无“先武装”门槛，**没有 PIR 也能在 30 分钟后超时告警**（源码事实；客厅日志形态为旁证但未打印 alarm.type）；不能由“出现 NO_MOTION”反推有 PIR | **REAL（源码事实）/ 类型旁证 NOT TESTED** | `southbound/src/homemon.c:847,977,1021-1033,1088-1105`；`bridge/_test/current-runtime/supervisor/bridge.out.log:18852-18914` |
| V1 | 手机端**没有可播放的远程视频**：唯一相机是 DAYU 本机 HarmonyOS 相机会话；`127.0.0.1:9200` 是 loopback JPEG 上传/推理口（POST 单帧、返回 JSON），不是视频流 | **REAL** | `VIDEO-LINK-AUDIT.md` §1；`northbound/.../CameraModel.ets:72-180`；`VisionFrameStreamer.ets:5-11,143-166`；`vision/yolo_pose_service.py:35-36,448-458,596-625,856-859` |
| V2 | 仓库内**不存在** RTSP/MJPEG/HLS/WebRTC 实现；公网 backend 无视频接口；手机“视频探望”是 `enabled=false` 的“未开放”占位 | **REAL** | `VIDEO-LINK-AUDIT.md` §1.4-1.6；`APP/.../pages/HomePage.ets:266-289,455-460`；backend 路由清单 `cloud/backend/src/server.js:388-1049` |
| V3 | 只有“告警证据单张 JPEG”接口/APP 代码（SOURCE-ONLY，且当前 1.0.6 是否包含未核实）；单张图不等于视频探望 | **SOURCE-ONLY / NOT TESTED** | `cloud/backend/src/server.js:987-1000`；`docs/APP-API-v1.md:75-81`；`APP/.../core/api/ApiClient.ts:221` |
| C1 | 当前生产链路状态：APP 设备管理页 8 台设备 / 0 在线 / 8 离线；Bridge 转发目标 `127.0.0.1:9001` 持续重连失败 → 现场链路此刻不通（只读快照，不代表设备损坏） | **REAL（快照）** | `baseline/layout/devmgmt_top.json`；`bridge/_test/current-runtime/supervisor/bridge.out.log` 末尾 |

## 1. 对 APP 文案/UI 的直接影响（本轮结论的可执行清单）

1. **电量**：每台设备（esp32-kitchen、esp32-bath、esp32-sos、dayu200-living、esp32-node-wearable，以及“隔离测试节点”）都必须显示 **“该设备未接入电量检测”**，**绝不显示百分比/默认 100%/0%**。设备管理页“电池提醒本轮未开放（无对应后端接口）”的说明与事实一致，可保留直到真实采集上线。现有源码已有 `BatteryCapability` 兜底（`DeviceInventory.ts:26-44,134-147`；`ViewMapper.ts:476-480`；`DevicePage.ets:595`），需确保新 DTO 不会把缺失电量当 0。
2. **厨房能力表**：必须改为“PIR 已装（GPIO38，2026-10-27 起）/门磁已装（GPIO14，2026-10-27 起）/水漏、摄像头未装”，否则会与真实告警/数据自相矛盾。
3. **卫生间能力表**：门磁应从“未安装”改为“已装（GPIO14）”；水漏仍“未启用”。
4. **“能力核对”横幅**：在能力表修复前，厨房 NO_MOTION 告警不应显示“可能来自测试/历史/错配数据”的降级提示（`ViewMapper.ts:712-713`；`AlertDetailPage.ets:887-922`），否则真实告警会被误判。
5. **NO_MOTION 文案**：统一为“长时间未检测到活动/请确认家人情况”，**不得写“疑似跌倒/昏迷”**（DAYU 快照现文案需改；`northbound/.../DeviceModel.ets:242-250`；边界见交接文档 `:38`）。
6. **视频探望**：保持“未开放”；不得把本地 9200、DAYU 相机画面、告警证据 JPEG 宣传成“手机视频探望”。若未来上线，需按 `VIDEO-LINK-AUDIT.md` §3 的 6 项条件逐项验收后才能改文案。
7. **MQ 展示**：只显示“原始 ADC / 报警未启用 / 未标定，不代表 ppm 或安全”；厨房 MQ-5 原始值 4095 为满量程，不能推断气体安全或泄漏。
8. **隔离测试节点**：继续“能力待确认/未纳入监护”，不显示传感器正常、不显示电量。

## 2. 证据文件索引

| 文件 | 内容 |
|---|---|
| [BATTERY-AUDIT.md](BATTERY-AUDIT.md) | 逐板电量能力、全链路字段缺失、补齐方案（分压/ADC/冲突/校准/固件/后端/APP） |
| [PIR-DOOR-AUDIT.md](PIR-DOOR-AUDIT.md) | PIR/门磁/水漏/MQ 真实安装与配置；生产告警与能力表冲突的三层解释 |
| [VIDEO-LINK-AUDIT.md](VIDEO-LINK-AUDIT.md) | 相机链路逐段、9200/HDC/bridge/backend/APP；视频探望缺口清单 |
| `../baseline/`（其他任务产物） | 生产 APP 设备管理页 UI 快照与 `bm_dump`（1.0.6/1000006） |

## 3. 本轮明确未做 / 阻塞

- 未开串口/未烧录/未按键/未接传感器/未用万用表；所有“可候选引脚/接线”均未实物复核 → NOT TESTED。
- 未访问生产 backend/APP 账号；生产告警的 alarmId/触发时间与 PIR 触发瞬间未取证 → BLOCKED（未授权）。
- 未做视频播放、公网/4G 连通性、长时间稳定性测试 → BLOCKED/NOT TESTED。
- 门磁/无活动告警的真实触发、电量真实放电曲线：需另立真实硬件验收任务。
