# DEMO-AUTOSTART 收尾报告

日期：2026-10-26
范围：只补齐无 P0 冷启动、物理 USB 恢复、页面耗时口径。无线节点 2/3→1/1 波动为用户另行调试，**本轮明确排除**，未检查/未操作。

## 1. 只读预检

- 正式入口：`materials\start-demo-all.cmd`；看护器运行（见 ACCEPTANCE 当前 PID）；
- P0 supervisor/worker HEALTHY；Broker/Bridge 监听；
- DAYU target Connected；homemon、fport、app、推理 9200 正常；
- 页面：`监护运行中`，检测辅助有帧数和 ms；相机控件可见；
- 三节点现场 **1/3 至 1/1**，离线节点用户另行调试；本报告不将其作为通过或阻塞条件。

## 2. 页面耗时口径（详见 LATENCY-FIELD.md）

**结论：页面 ms 是客户端抓取+JPEG+HTTP 往返，不是单帧推理耗时。**

- 源：`VisionFrameStreamer.ets` L139 记录 `startedAt`；L143–166 抓 Surface/JPEG/POST；L191 用 `Date.now()-startedAt` 赋 `lastLatencyMs`；页面 `Index.ets` L284 显示 `${framesSent} 帧 · ${lastLatencyMs} ms`。
- P1-B `/v1/frames/` 收到帧后立即返回 `last_result`，异步 worker 才做推理；`inferMs` 来自 worker/事件/summary，不在 HTTP 同步响应里等待。
- 因此页面 222/248 ms 与 summary inferMs 605/641 ms 不是同一指标，不矛盾；页面结果本身还可能滞后一帧/数帧。
- 未改数字/统计；未改 HAP。标签 `ms` 语义不完整，若正式 HAP 更新，建议改成“上传往返 ms”或在页面另行显示服务端 `inferMs`；需用户确认后再构建/签名/重装。

## 3. 物理 USB 拔插

**结果：纯 USB 通信断开 FAILED；实际发生 USB 拔插 + DAYU 断电重启，重连后自动恢复 PASS（但不等同纯 USB）。**

- 用户确认“独立供电”后拔下正确 USB；PC 端 target 变为 `USB Offline`；看护器进入 `targetConnected=false, WAIT`；P0 保持 HEALTHY。
- 插回后 target 重新出现，但设备 `uptime=41.57s`（拔插前 2526s），应用 PID/推理 PID 全部变化；证明拔插同时导致 DAYU 断电/重启，不能记为纯通信断开。
- 重连后看护器自动恢复：homemon、fport、app、推理、9200、事件；最终 `app=active`、`inference=running`、`frames=LIVE`，事件继续增长（5095→5110 事件快照）。
- 期间发现并修复看护器在 HDC 抖动下重复启动 homemon 的问题：改用 `pidof homemon`，并加 15 秒启动冷却；清理重复进程后保持一个 homemon、一个推理。
- 离线节点未操作；节点数 1/1 不参与本节判定。

## 4. 无 P0 / PC 重启冷启动

**NOT TESTED（等待用户正常重启 PC）。**

- 当前 P0 健康，按任务要求没有为制造冷启动结束现有 P0。
- 冷启动交接：`COLD-START-HANDOFF.md`；用户重启后只双击 `start-demo-all.cmd`，P0 窗口出现时隐藏输入一次密钥；不需要 AI 再补命令。
- 判定要求：P0/Broker/Bridge/supervisor/worker 单实例、app/camera 新帧、推理新事件、公网自然 202；如 AI 必须补命令则该次不算一键 PASS。

## 5. 本轮修复与复验

| 修复 | 原因 | 复验 |
|---|---|---|
| `Get-HomemonRunning` 改 `pidof` + 15s 冷却 | HDC 抖动时 `ps` 解析失败导致重复 homemon | USB 重连后已清理为单 homemon；待冷启动再次确认 |
| 页面耗时解释 | 222/248 ms 与 inferMs 605/641 ms 口径不同 | 源码/服务端实现追踪完成，无需改数 |

## 6. 当前限制

- 本轮没有纯 USB 通信断开证据；用户拔插实际断电重启。若需纯 USB PASS，需使用仅数据 USB 线/确认独立供电后重做一次。
- 冷启动未执行前不能写“PC 重启后冷启动 PASS”。
- 三节点为用户另行调试，保持排他；不以恢复 3/3 为条件。
- 页面 `ms` 标签语义不完整，正式 HAP 更新未授权，本轮未改。
