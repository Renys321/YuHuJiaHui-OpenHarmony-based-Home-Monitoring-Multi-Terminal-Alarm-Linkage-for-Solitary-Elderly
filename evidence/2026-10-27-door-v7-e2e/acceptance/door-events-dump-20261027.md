# 生产门磁台账 dump（2026-10-27 02:18 后，schema v7）

来源：主机 `/data/backend-state.json` 只读挂载 dump（`dump-door-events.js`）。
汇总：`schemaVersion=7`、`devices=8`、`doorEventCount=26`；全部 `source=device-cache`、`timeSource=device`。

| eventId | deviceId | room | open | occurredAt (ms) | 序号 seq |
|---|---|---|---|---|---|
| dr-1 | esp32-kitchen | 厨房 | true | 1793037820560 | 17 |
| dr-2 | esp32-kitchen | 厨房 | false | 1793037822750 | 18 |
| dr-3 | esp32-bath | 卫生间 | false | 1793037831807 | 23 |
| dr-4 | esp32-bath | 卫生间 | true | 1793037835087 | 24 |
| dr-5 | esp32-kitchen | 厨房 | true | 1793037840360 | 19 |
| dr-6 | esp32-bath | 卫生间 | false | 1793037838407 | 25 |
| dr-7 | esp32-kitchen | 厨房 | false | 1793037842600 | 20 |
| dr-8 | esp32-bath | 卫生间 | true | 1793037897857 | 26 |
| dr-9 | esp32-bath | 卫生间 | false | 1793037901137 | 27 |
| dr-10 | esp32-kitchen | 厨房 | true | 1793038397280 | 21 |
| dr-11 | esp32-kitchen | 厨房 | false | 1793038409410 | 22 |
| dr-12 | esp32-bath | 卫生间 | true | 1793038464598 | 28 |
| dr-13 | esp32-bath | 卫生间 | false | 1793038474467 | 29 |
| dr-14 | esp32-bath | 卫生间 | true | 1793038485457 | 30 |
| dr-15 | esp32-bath | 卫生间 | false | 1793038494297 | 31 |
| dr-16 | esp32-bath | 卫生间 | true | 1793038507487 | 32 |
| dr-17 | esp32-kitchen | 厨房 | true | 1793038615990 | 23 |
| dr-18 | esp32-bath | 卫生间 | false | 1793038637618 | 33 |
| dr-19 | esp32-bath | 卫生间 | true | 1793038655278 | 34 |
| dr-20 | esp32-bath | 卫生间 | false | 1793038658628 | 35 |
| dr-21 | esp32-kitchen | 厨房 | false | 1793038690850 | 24 |
| dr-22 | esp32-kitchen | 厨房 | true | 1793038695290 | 25 |
| dr-23 | esp32-kitchen | 厨房 | false | 1793038699730 | 26 |
| dr-24 | esp32-bath | 卫生间 | true | 1793038679637 | 36 |
| dr-25 | esp32-bath | 卫生间 | false | 1793038687347 | 37 |
| dr-26 | esp32-kitchen | 厨房 | true | 1793038706400 | 27 |

## 离线窗口（第二次测试）

- `BACKEND_STOPPED 2026-10-27T02:17:48+08:00` → `BACKEND_STARTED 2026-10-27T02:18:22+08:00`
- 窗口内真实事件（occurredAt 换算为本地时间）：
  - kitchen seq24 = 02:18:10.850（dr-21）
  - kitchen seq25 = 02:18:15.290（dr-22）
  - kitchen seq26 = 02:18:19.730（dr-23）
  - bath seq36 = 02:17:59.637（dr-24）
  - bath seq37 = 02:18:07.347（dr-25）
- 结论：窗口内事件在恢复后按 seq 补传、无重复、无丢失；窗口前 16 条原样保留。
- 另：kitchen seq27 = 02:18:26.400（dr-26）产生于恢复后，正常实时入库。

## 历史待补传（未保全，如实记录）

- 厨房固件在 v7 上线前（01:34–01:35）产生的 8 条缓存事件，因固件缓存 TTL=300s，在 v7 部署（01:58）前已过期；烧录后启动日志 `门磁序号恢复 seq=16 待补传事件=0` 且状态无 `events` 字段。
- 未清空队列、未伪造补传；此为固件 TTL 设计导致的历史数据无法补传。
