# 随身 SOS（ESP32-S3 + M100MG-B1 4G + APP 地图 + ACK）交付说明

**状态：真机全链路验收通过（2026-10-27，Asia/Shanghai）**

按下随身实体按钮 → 蜂鸣器响 → ESP32 生成 `alarmId` → UART → M100 经 4G/MQTT 上行
→ 公网适配服务 → 现有后端 → APP 显示随身求助 + APP 内地图真实定位
→ 监护人点确认 → 后端 ACK 命令 → MQTT 下行 → M100 → UART → ESP32 停止提示并回执
→ 后端告警 ACKED。**全程不依赖 ESP32 Wi-Fi、不依赖电脑串口转发、不依赖家庭 bridge。**

## 1. 最终验收结果

| # | 验收项 | 结果 | 证据 |
|---|---|---|---|
| 1 | 实体按键触发、蜂鸣器响应 | ✅ PASS（用户现场） | 4 次真实按键事件 `sos-2/3/4/5` |
| 2 | 不用 Wi-Fi，SOS 经 4G 出现在 APP | ✅ PASS | ESP32 固件不初始化 Wi-Fi；后端 `esp32-sos` 在线、告警真实入库 |
| 3 | APP 内地图显示真实定位 | ✅ PASS | `app-map-detail.png`：高德瓦片 + 标记 + 经纬度 + 定位状态/时间 |
| 4 | APP ACK 经 4G→M100→UART→ESP32 | ✅ PASS | `sos-2/3/4` 创建→确认约 26~46 s，设备回执后 ACKED |
| 5 | 设备结束提示，再按产生新事件 | ✅ PASS | `sos-2→sos-3→sos-4→sos-5`，每次均为新 `alarmId` |
| 6 | GPS 无定位仍能求助 | 🟡 逻辑与降级已实现/单测覆盖；**未做“拔天线无定位”现场实测** | 告警创建不依赖 GPS；APP 有“暂无定位/定位已过期”分支 |
| 7 | 短暂断网恢复不丢待发、不重复 | ✅ PASS（用户现场） | 断网期间按键→恢复后 APP **只出现一条** `sos-4`，无重复；ACKED |
| 8 | 脱离电脑独立供电 | ✅ PASS（用户现场） | 充电宝供电下按键→APP 出现 `sos-5` 并显示地图；ACK 见 §6 说明 |

### 事件时间线（后端实测）

| alarmId | 创建 | 确认（ACKED） | 间隔 |
|---|---|---|---|
| `sos-2-124737aa` | 18:03:23 | 18:04:02 | ~39 s |
| `sos-3-0555328b` | 18:05:43 | 18:06:30 | ~46 s |
| `sos-4-6c6aed3f` | 18:07:19 | 18:07:45 | ~26 s（断网恢复测试） |
| `sos-5-a865a846` | 18:14:23 | 18:27:54 | ~13.5 min（见 §6 已知问题） |

设备 `esp32-sos` 在公网后端：`online=true`，`roomName=随身求助`，`state` 随事件在 `ALARM/ACKED/NORMAL` 间正确变化。

## 2. 交付文件

| 文件 | 内容 |
|---|---|
| `M100-CONFIG.md` | **M100 最终配置表**（逐字段，含本机实测踩到的“参数源=串口”防覆盖） |
| `WIRING.md` | **最终接线表**（ESP32↔M100 UART、按钮、蜂鸣器、供电） |
| `DEPLOY-ECS.md` | 公网服务部署/回滚/排障（已实际部署） |
| `DEPLOY-RECORD.md` | 本次公网部署执行记录、备份路径、适配器计数、运维命令 |
| `QUICK-START.md` | 演示当天一页纸速查（上电顺序、演示动作、故障排查） |
| `ACCEPTANCE.md` | 现场验收步骤与成功标志 |
| `DESIGN-CONTRACT.md` | 设备/串口/MQTT/后端/APP 集成契约（含真机修正） |
| `firmware/` | 最终固件镜像、bootloader/分区表与回退备份 |
| `verify/` | 后端 API 快照（JSON） |
| `tools/` | 真机验证脚本（透传、ACK、串口监视） |
| `eldercare-guardian-v1.0.6-unsigned.hap` | 最终 APP 安装包 |
| `app-map-detail.png` | **APP 告警详情：真实瓦片地图 + 标记 + 坐标 + 定位状态 + 设备已确认** |
| `app-after-ack.png` | APP 告警详情（ACK 区域特写：设备回执时间/回执人） |
| `app-final-home.png` / `app-home-standalone.png` | APP 运行截图（真实 API、8 台设备） |

## 3. 版本与哈希

| 制品 | 版本/哈希 |
|---|---|
| ESP32 固件（最终） | `esp32_wearable_sos.bin` 274,432 B，SHA-256 `84F9819F571E6FDCBCD03D7D7AE4213786262C15B9C31E51A5A1D99FD1140207` |
| 烧录偏移 | bootloader `0x0` / partition-table `0x8000` / app `0x10000`；dio / 16MB / 80MHz |
| 固件回退 | 烧录前 app 分区备份 `firmware/com8-app-before-wearable-20261027.bin`（1 MiB，SHA-256 `686710BC7300093A345F117CECA3914B58EB8CAAB546EC60DC085521A9DC32E9`）；另有 16MB 全片备份 `D:\esp32-sos-build\.local\com8-full-backup-20261026.bin`（SHA-256 `17D0EFAFE6D25C82164DAD621A0F2A39B48F018BB442BC58AC0CA6DF4E5EA8E4`） |
| APP | `com.example.program_04` v1.0.6 (versionCode 1000006)，HAP 3,202,739 B，SHA-256 `3D21B5591BE4340FE5E0D968D420BD61CAD1810DCACE688A94DEA4A96BA8C7F7` |
| 公网服务 | `wearable-mqtt`（零 npm 依赖：内置带鉴权 MQTT Broker + 后端适配器），复用 `eldercare-cloud-backend:local` 镜像运行，唯一对外端口 1883/tcp |
| 后端 | 保持既有线上版本（**未重新部署**，避免回退 D/E、门磁 v7、健康评估） |
| M100 | `YED_DTU4_2.0.3`，参数源=串口（`paramsrc=1`），MQTT 3.1.1、明文 1883 |

## 4. 配置摘要（完整表见 M100-CONFIG.md）

| 项 | 值 |
|---|---|
| Broker | `47.76.70.118:1883`（与 api.luxunacc.xyz 同一台 ECS） |
| Client ID / 用户名 | `wearable-sos-001` |
| 密码 | 见本目录部署记录或 `competition/.secrets/wearable-mqtt.env`（不写入公开文档） |
| 上行/下行主题 | `eldercare/wearable/sos-001/up` / `eldercare/wearable/sos-001/down` |
| 串口 | 115200 8N1，打包超时 80 ms，透传（数据流模版不启动） |
| GPS | 启动，更新时间 60 s（设备实际支持值），主动上报=固定格式 `经度_纬度`（WGS84 十进制），通道=网络通道1 |
| 关键坑 | **分组参数更新会把串口写入覆盖**；必须 `config,set,paramsrc,1` 后 `config,set,save` |

## 5. 已知问题与恢复方法

### 5.1 ACK 偶发未送达（设备重启窗口）
独立供电测试那次（`sos-5`）第一次 ACK 没有在 3 次重投窗口内送达设备，命令被适配器“parked”：
- 恢复方法（已实测有效）：`docker restart $(docker ps -qf name=wearable-mqtt)`，适配器重启后会重新投递仍为 PENDING 的命令，设备随后确认（该事件已 ACKED）。
- 影响：APP 会先显示“等待设备确认”，不会伪造成功；恢复后正常。
- 建议：演示时先确认设备已上电稳定 10 s 再点确认。

### 5.2 位置标注“求助后更新”
APP 读的是 `GET /api/v1/location` 的**当前**位置；事件 ACK 后适配器恢复上报最新 GPS，因此事后打开详情可能显示“求助后更新”（本次截图即如此）。这是**如实标注**，不是把后续位置冒充求助瞬间位置。
- 事件进行中（未 ACK）适配器会把 `device-status.gps` 冻结在求助时刻快照，地图会显示“求助时刻位置”。

### 5.3 演示环境约束
- 1883 为明文 MQTT（竞赛演示允许），已用强随机密码 + Client ID 白名单；演示结束建议删除安全组 1883 规则。
- **演示期间不要启动旧的 `cloud/onenet/public-sync`/`gateway`**：其命令轮询不按 deviceId 过滤，可能抢领 `esp32-sos` 的 ACK。
- M100 底板 USB 数据线**最终运行必须拔掉**（与 ESP32 TX 争用 M100 RXD，实测会阻断上行）。

### 5.4 上行偶发 MALFORMED_JSON
M100 的 DTU 分帧（网络分帧 30 ms / 串口打包 80 ms）偶尔会把一帧 JSON 拆成两条 MQTT 消息，
其中一条解析失败（适配器计 `malformedJson` 并忽略，不崩溃）。
- 影响：该次重发可能丢失，但固件未确认时会**每 10 s 重发同一 alarmId**，实际演示 4 次按键均正常建成告警。
- 缓解：固件已改为单行短 JSON（约 100~150 B）；如现场频繁出现，可把 M100 网络分帧时间从 30 ms 调到 100~200 ms。

### 5.5 串口调试口与透传口不能同时占用
M100 底板 USB-TTL 与 ESP32 共用 M100 的 UART：插着 USB 时 CH340 的 TX 会与 ESP32 GPIO17 同时驱动
M100 RXD，实测上行被阻断。**联调时要么用 USB 观察、要么用 ESP32 透传，不能两者同时。**

## 6. 未完成/未实测（如实列出）

1. **GPS 无定位真实场景**：未做“拔掉 GPS 天线/室内冷启动”的现场测试；只验证了代码路径与单元测试，以及位置过期时的地图降级显示。
2. 4G/MQTT **自动重连**的长时间稳定性（>1 小时）未做长稳；已实测一次电源断开 30~40 s 恢复。
3. 明文 MQTT 无 TLS（按任务允许）；生产化需 MQTTS/证书与 Topic ACL。
4. 电压/功耗未测量；ESP32 与 M100 当前各自独立供电、共地。
5. 上述 `sos-5` 的 ACK 偶发未送达未定位到唯一根因（设备重启窗口/下行时序），已给出可用的恢复步骤。

## 7. 复现（下次演示最短路径）

1. M100：DC 5~12V 供电、底板 USB **不插**、天线接好；等 NET 1000ms 慢闪 + RDY 常亮。
2. ESP32：充电宝供电（或 USB），按 `WIRING.md` 接线。
3. APP：打开即用（账号 `luxunluxunluxun`）。
4. 按按钮 → APP 出现「随身求助」→ 打开详情看地图/坐标 → 点确认 → 蜂鸣停止、APP 显示设备已确认。
5. 服务器健康检查：`docker ps | grep wearable-mqtt` 为 healthy；`docker logs` 无错误短码。
