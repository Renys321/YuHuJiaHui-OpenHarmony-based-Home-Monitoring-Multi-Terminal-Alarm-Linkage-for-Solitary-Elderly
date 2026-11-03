# 现场验收计划：断连恢复 + DAYU 随身 SOS + 客厅无 PIR

日期：2026-10-27 22:35 起（Asia/Shanghai）。Lead 执行，用户配合物理动作。
原则：真实断开/重连、真实按键；mock/本地测试单独标注；不清缓存、不删数据、不 ACK 未要求处置的告警、不伪造状态。

## 0. 当前现场基线（22:30 已取证）

| 项 | 事实 | 证据 |
|---|---|---|
| PC 网络 | WLAN = ElderCareLab，IP 10.127.130.179/24 | `lead/` 现场记录 |
| 房间节点 | esp32-kitchen(10.127.130.168)、esp32-bath(10.127.130.71) 均在线并上报 | `lead/` MQTT 快照 |
| MQTT/bridge | broker 1883、bridge 61072（--status-tcp 10.127.130.131:9000） | 进程/日志 |
| P0 公网同步 | 22:29:56 启动 supervisor+worker；三设备 202 已恢复 | `lead/prod-snapshot.js` t1/t2 快照 |
| APP | 22:31 更新、4/4 在线、bath 真实未确认 SOS“刚刚” | `lead/app-after-p0-restart.jpeg` |
| DAYU | 全屋在线 3/3；厨房 SOS 已闭环；客厅 NO_MOTION 错误仍在 | `lead/dayu-layout-baseline-2215.json` |
| esp32-sos | 在线（30s hb），已有真实事件 sos-2..sos-6（sos-6 最新，已 ACKED） | `lead/` API 快照 |

## 1. 部署顺序（Lead）

1. bridge 修复（relay-ignore + relay keepalive + 探针噪声）：备份 → 重启 bridge → 验证三房间继续 3/3、MQTT 正常。
2. homemon 修复（无 PIR 门控 + MAX_CLIENTS 8）：备份 /data/homemon/homemon 与 conf → 部署 → 重启 homemon → 更新 start-demo-supervisor.ps1 的 HomemonSha → 验证状态无 NO_MOTION、supported=false。
3. DAYU HAP 1.0.5：安装（保留 1.0.4 回退包）→ 验证房间/相机/语音不回归、随身 SOS 卡片。
4. mirror 服务：启动（单实例）→ 验证 relay 注入被 bridge 忽略、homemon 广播出现 esp32-sos、DAYU 显示随身求助。
5. 手机 APP HAP（如需）：安装 → 验证陈旧数据/无 PIR 文案。
6. ECS wearable-mqtt 修复：由用户 Workbench 部署 → 验证 healthy 与 ACK 自愈。

## 2. 验收 A：房间 ESP32 断开再启动（不用人工重启服务）

准备：P0、bridge、homemon、mirror 均运行；开始记录时间。
1. 记录 t0 与当前 esp32-kitchen 最后 ts/202。
2. 用户拔掉厨房板 USB 供电（真实断电），等待 ≥30s。
   - 期望：bridge 日志节点断开；APP 显示厨房离线/最后更新时间（不显示为新数据）；DAYU 显示厨房离线/最后更新。
3. 用户重新插回供电。
   - 期望：ESP32 自动重新联网并接入 bridge（无人工重启服务）；新 MQTT 状态、新 202；APP 在轮询周期内恢复在线并显示新时间；DAYU 恢复 3/3。
   - 记录恢复耗时（断电→首个新 202 / APP 刷新 / DAYU 3/3）。
4. 重复一次（验证可重复）。
5. 附加：卫生间 e-1793109878-1 是真实未确认 MANUAL_SOS。另做一次卫生间断电重启，验证该告警不自称 ACKED、不静默消失（如固件会丢，如实记录为缺陷，不改写历史）。

## 3. 验收 B：随身 SOS 同一条事件在 APP 与 DAYU

准备：mirror 运行、DAYU 1.0.5 显示随身求助、esp32-sos 在线、P0 运行。
1. 用户按一次实体按钮（记录按下的本地时间）。
2. APP：出现新的“随身求助”告警（新 alarmId），事件时间、位置状态、ACK 状态（待处理）。
3. DAYU：显示同一 alarmId、来源“随身求助”、事件时间、GPS 状态/定位时间（无定位显示“暂无定位”）、ACK 待处理。
4. 用户在 APP 点确认（真实 ACK）：后端命令 PENDING → 适配器 → M100 → 设备真实回执 → ACKED。
5. APP 与 DAYU 都显示已确认（DAYU 只能来自同源 ACKED 状态），无重复告警。
6. 记录两端截图与日志；核对 alarmId 完全一致。

## 4. 验收 C：断开重启恢复（随身 4G）

1. 用户断开随身设备供电（ESP32+M100），等待 ≥2min。
   - 期望（修复后）：后端 esp32-sos online=false，APP 显示离线/最后时间，不伪造实时。
2. 重新上电：boot/hb → 后端 online=true、lastSeen 前进；APP 恢复；未确认事件（若有）继续以原 alarmId 重试，不重复生成。
3. 期间发生的 PENDING ACK 在设备恢复后自动重投，无需 docker restart。
4. 记录 ECS 容器日志短码与后端状态。

## 5. 验收 D：客厅无 PIR

1. 部署 homemon 修复并重启后，观察 ≥35 分钟（≥ no_motion_sec+余量）：
   - 不产生新的 NO_MOTION（MQTT 与后端无新 alarmId）；状态带 sensors.motion.supported=false、reported=false、reason=not_configured、lastActiveTs=0。
   - DAYU 显示“未配置 PIR，无活动监测 / 暂无有效 PIR 数据”，不显示“长时间无活动”。
   - APP 客厅能力文案一致；历史告警保留。
2. 摄像头：DAYU 相机/推理运行→显示有人/无人；停止推理→“暂无有效检测数据/离线”，不据此说无人活动。
3. 回归：卫生间 PIR 仍正常计数（活动变化即刷新），厨房无 PIR 行为不变。

## 6. 证据与交付

- 证据目录：`competition/evidence/2026-10-27-reconnect-dayu-sos/{lead,room-relink,wearable-link,dayu-sos,homemon-nomotion,app-ui}/`
- 报告需含：根因、每段断开/恢复时间戳、设备 ID、服务端新数据时间、两端界面结果、同一 alarmId、ACK 状态、构建/安装版本与回滚、未解决阻塞项。
- 所有 mock/bench 结果必须与真机结果分栏标注。
