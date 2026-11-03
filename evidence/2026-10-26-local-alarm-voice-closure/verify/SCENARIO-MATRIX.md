# 场景验证记录（真实设备 / 隔离台架）

- 时间：2026-10-26 16:20–18:37（Asia/Shanghai）
- 设备：厨房 `esp32-kitchen`/COM5/MAC `50:78:7d:16:ed:60`；卫生间 `esp32-bath`/COM4/MAC `14:c1:9f:42:dd:b4`
- 方法：`tools/bench-serial.py` 通过 UART0（115200 8N1）下发台架命令；固件为同一源码的 `CONFIG_NODE_ALARM_BENCH_INJECT=y` 变体，**不启动 WiFi/网关/NTP，不产生云端事件**。正式参数与台架参数的差异见 REPORT.md §3.2。
- 声音证据：串口 `local-voice: PLAY clip=N` / `STOP result=… cancelled=…`；真实扬声器与板载蜂鸣器参与。日志为 UTF-8，含毫秒时间戳。

## 房间与能力

| 房间 | PIR | SOS 按键 | AHT20 | MQ | 扬声器 | 蜂鸣器 | 无活动提醒 | SOS | 温湿度提醒 |
|---|---|---|---|---|---|---|---|---|---|
| 厨房 | 无（-1） | 无（-1） | 有 | MQ2/MQ5 原始 ADC（阈值禁用） | ES8388 | XL9555 P0_3 | 不适用 | 无硬件（仅台架注入验证逻辑） | 适用 |
| 卫生间 | GPIO36 | GPIO15 | 有 | 无 | ES8388 | XL9555 P0_3 | 适用 | 适用 | 适用 |

## 厨房（台架固件 B587982B…）

| 场景 | 日志 | 关键观察 | 结论 |
|---|---|---|---|
| 正常/启动 | `kitchen-01-boot`、`kitchen-09-production-normal` | 启动 `READY … no boot alarm`；正常态无 PLAY；NORMAL、温湿度/ADC 有效 | PASS |
| 停止/实际中断播放 | `kitchen-05-stop-cancel` | 播放中 1.2s 下发 `stop`：`STOP 已接受…state 保持 ALARM`，语音任务 `STOP result=ESP_OK cancelled=1`（**确认实际中断**），随后 16s 无再次播放 | PASS |
| 温湿度闭环 | `kitchen-02b-climate` | 2 次有效越界→`ALARM e-224-1`+`PLAY clip=2`；10s 后 `持续异常限频提醒` 仅 1 次；24s `STOP 已接受…state 保持 ALARM` 后无重复；38/39s 恢复→`异常解除 -> NORMAL`；45/46s 再越界→新 `e-261-2`+播放；52s `ACK 已接受并生效 → ACKED` 立即上报 | PASS |
| 优先级（台架注入） | `kitchen-03b-priority` | CLIMATE `e-282-1` 播放中 SOS 抢占 `PLAY clip=1`（`e-288-2`）；重复 SOS 被抑制；stop 后 CLIMATE 未覆盖 SOS（优先级保护）；ACK SOS 后 CLIMATE 才升级为新告警 `e-307-3` | PASS（SOS 为台架注入，厨房无 SOS 硬件） |
| 重启 | `kitchen-04b-restart` | 告警中重启：`no boot alarm`、无 PLAY、NORMAL、采集/温湿度恢复 | PASS |
| 正式固件运行 | `kitchen-09-production-normal`、`kitchen-10-production-restart` | 40s 无 PLAY；26s 完整启动无重放；WiFi 重连（10.127.130.168）后自然 202 | REAL PASS（正常态/重启） |

## 卫生间（台架固件 5268C90B…）

| 场景 | 日志 | 关键观察 | 结论 |
|---|---|---|---|
| 正常/启动 | `bath-01-boot`、`bath-09-production-normal` | 启动无试听；PIR/温湿度有效；无 PLAY | PASS |
| SOS 闭环 | `bath-02-sos` | SOS→`e-34-1`+`PLAY clip=1`；重复 SOS 不叠播；15s `STOP` 保留 ALARM；18s 再次按下→恢复提醒（同 ID）；24s `ACK → ACKED`；28s SOS→新 `e-54-2`；34s ACK 接受 | PASS（SOS 电平由台架注入；实体按键验收待用户） |
| 多告警/优先级 | `bath-04-multi` | SOS `e-134-1`；期间 CLIMATE 越界不覆盖 SOS；20s ACK SOS 后 CLIMATE 升级 `e-147-2`；stop；恢复 NORMAL；再越界 `e-164-3`；ACK | PASS |
| 长时间无活动 | `bath-05-nomotion` | `inj motion` 武装后 20s 无活动→`NO_MOTION e-205-1`+播放（仅一次，不重复）；活动恢复→NORMAL；再次无活动→新 `e-233-2` | PASS |
| 暂停/恢复 | `bath-06-pause` | `PAUSE` 后 30s 不触发；`RESUME` 后立即补报 `NO_MOTION e-289-1`；stop 后恢复 | PASS |
| 暂停跨重启 | `bath-07-pause-persist` | pause→重启，启动日志 `监护暂停状态(持久化)=PAUSED`，暂停期间不触发；resume 后补报 `e-350-1` | PASS |
| 重启 | `bath-08-restart` | 告警中重启：`no boot alarm`、无重放、NORMAL | PASS |
| 正式固件运行 | `bath-09-production-normal`、`bath-10-production-restart` | 40s 无 PLAY、PIR 实时；重启日志 `ACTIVE` + `no boot alarm`、无重放；重连 IP 10.127.130.71 | REAL PASS（正常态/重启） |

## 真实链路恢复观察

- `verify/live-nodes-online-after-flash.txt`：18:36 两块板与 bridge 9101 建立真实 TCP 连接（10.127.130.168 / 10.127.130.71）；`public-sync-supervisor.log` 对两个设备均自然 `status=202`。
- 早前 16:20 曾观察到旧固件 WiFi `reason=201 (NO_AP_FOUND)`（演示热点不在）；期间本地采集/判定继续。网络恢复后**未重放历史声音、未重复产生云端事件**。

## 现场非注入异常记录

- `bath-04-multi` 开始前（18:28:22）日志出现一次 `SOS 按键 -> ALARM（e-127-3）`，当时台架只发送了温湿度注入，未发送 SOS。无法区分用户按下与 GPIO15 悬空/噪声；已在 REPORT §7/§9 列为待用户确认事项。

## 未覆盖

- 真实 SOS 实体按键 + 手机/DAYU ACK（用户动作）；
- 真实高低温/高湿与 30 分钟档无活动（未做危险/耗时测试）；
- 正式固件真断网长时间运行（本轮网络在烧正式固件前已恢复）；
- 音频初始化失败故障注入（代码路径为非阻塞+降级保留蜂鸣器，未做板端故障注入）。
