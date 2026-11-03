# 自动实验结果（run_matrix.py 生成）

> 合成场景为手工构造的 COCO-17 关键点序列，**非真机录像**；真实回放数据来自
> evidence/2026-10-25-dayu-formal-camera-inference-regression 与 2026-10-26-demo-autostart，
> 均为已记录的安全动作（无真实跌倒）。
> 2026-11-02 晚：`stress_fast_deep_crouch` 改为受控减速的物理合理曲线，并新增
> `boundary_constant_speed_collapse` 只记录恒速（≈自由落体）边界，不列入硬指标。

## 配置 `absolute_4fps`（当前提交启动脚本（start_dayu_usb_vision.cmd）使用的绝对低位阈值模式）

| scenario | 类别 | 期望 | baseline 事件 | baseline 通过 | patched 事件 | patched 通过 | 首事件延迟(ms) |
|---|---|---|---|---|---|---|---|
| side_fall_180 | positive | 跌倒 | 1 | PASS | 1 | PASS | 750 |
| vertical_buckle | positive | 跌倒 | 0 | FAIL | 1 | PASS | 1000 |
| forward_camera_fall | positive | 跌倒 | 0 | FAIL | 1 | PASS | 1000 |
| negative_sit_down | negative | 非跌倒 | 0 | PASS | 0 | PASS | - |
| negative_crouch_down | negative | 非跌倒 | 0 | PASS | 0 | PASS | - |
| negative_bend_over | negative | 非跌倒 | 0 | PASS | 0 | PASS | - |
| negative_slow_lie_down | boundary | 非跌倒 | 1 | 记录（非验收） | 1 | 记录（非验收） | 3250 |
| negative_already_lying | negative | 非跌倒 | 0 | PASS | 0 | PASS | - |
| stress_fast_deep_crouch | boundary | 非跌倒 | 0 | 记录（非验收） | 0 | 记录（非验收） | - |
| boundary_constant_speed_collapse | boundary | 非跌倒 | 0 | 记录（非验收） | 1 | 记录（非验收） | 750 |

**硬指标（required，patched）：7/7 PASS**

## 配置 `groundzone_4fps`（演示机位 --ground-zone 0,0.55,1,1（2026-10-28 联调记录））

| scenario | 类别 | 期望 | baseline 事件 | baseline 通过 | patched 事件 | patched 通过 | 首事件延迟(ms) |
|---|---|---|---|---|---|---|---|
| side_fall_180 | positive | 跌倒 | 1 | PASS | 1 | PASS | 750 |
| vertical_buckle | positive | 跌倒 | 0 | FAIL | 1 | PASS | 750 |
| forward_camera_fall | positive | 跌倒 | 0 | FAIL | 1 | PASS | 750 |
| negative_sit_down | negative | 非跌倒 | 0 | PASS | 0 | PASS | - |
| negative_crouch_down | negative | 非跌倒 | 0 | PASS | 0 | PASS | - |
| negative_bend_over | negative | 非跌倒 | 0 | PASS | 0 | PASS | - |
| negative_slow_lie_down | boundary | 非跌倒 | 1 | 记录（非验收） | 1 | 记录（非验收） | 3250 |
| negative_already_lying | negative | 非跌倒 | 0 | PASS | 0 | PASS | - |
| stress_fast_deep_crouch | boundary | 非跌倒 | 0 | 记录（非验收） | 0 | 记录（非验收） | - |
| boundary_constant_speed_collapse | boundary | 非跌倒 | 0 | 记录（非验收） | 1 | 记录（非验收） | 750 |

**硬指标（required，patched）：7/7 PASS**

## 配置 `absolute_2fps`（低帧率（2 FPS）鲁棒性）

| scenario | 类别 | 期望 | baseline 事件 | baseline 通过 | patched 事件 | patched 通过 | 首事件延迟(ms) |
|---|---|---|---|---|---|---|---|
| side_fall_180 | positive | 跌倒 | 1 | PASS | 1 | PASS | 1000 |
| vertical_buckle | positive | 跌倒 | 0 | FAIL | 1 | PASS | 1500 |
| forward_camera_fall | positive | 跌倒 | 0 | FAIL | 1 | PASS | 1500 |
| negative_sit_down | negative | 非跌倒 | 0 | PASS | 0 | PASS | - |
| negative_crouch_down | negative | 非跌倒 | 0 | PASS | 0 | PASS | - |
| negative_bend_over | negative | 非跌倒 | 0 | PASS | 0 | PASS | - |
| negative_slow_lie_down | boundary | 非跌倒 | 0 | 记录（非验收） | 0 | 记录（非验收） | - |
| negative_already_lying | negative | 非跌倒 | 0 | PASS | 0 | PASS | - |
| stress_fast_deep_crouch | boundary | 非跌倒 | 0 | 记录（非验收） | 0 | 记录（非验收） | - |
| boundary_constant_speed_collapse | boundary | 非跌倒 | 0 | 记录（非验收） | 1 | 记录（非验收） | 1000 |

**硬指标（required，patched）：7/7 PASS**

## 帧级根因：正例中被 `horizontal` 单独挡掉的帧数（baseline）

| 配置 | scenario | 帧数 | horizontal 为假且其余门都通过 | 占比 |
|---|---|---|---|---|
| absolute_4fps | side_fall_180 | 30 | 2 | 7% |
| absolute_4fps | vertical_buckle | 30 | 20 | 67% |
| absolute_4fps | forward_camera_fall | 30 | 18 | 60% |
| absolute_4fps | negative_sit_down | 38 | 22 | 58% |
| absolute_4fps | negative_crouch_down | 38 | 22 | 58% |
| absolute_4fps | stress_fast_deep_crouch | 42 | 26 | 62% |
| absolute_4fps | boundary_constant_speed_collapse | 34 | 20 | 59% |
| groundzone_4fps | side_fall_180 | 30 | 2 | 7% |
| groundzone_4fps | vertical_buckle | 30 | 20 | 67% |
| groundzone_4fps | forward_camera_fall | 30 | 20 | 67% |
| groundzone_4fps | negative_sit_down | 38 | 24 | 63% |
| groundzone_4fps | negative_crouch_down | 38 | 24 | 63% |
| groundzone_4fps | stress_fast_deep_crouch | 42 | 26 | 62% |
| groundzone_4fps | boundary_constant_speed_collapse | 34 | 20 | 59% |
| absolute_2fps | vertical_buckle | 16 | 10 | 62% |
| absolute_2fps | forward_camera_fall | 16 | 10 | 62% |
| absolute_2fps | negative_sit_down | 20 | 12 | 60% |
| absolute_2fps | negative_crouch_down | 20 | 12 | 60% |
| absolute_2fps | stress_fast_deep_crouch | 22 | 14 | 64% |
| absolute_2fps | boundary_constant_speed_collapse | 18 | 10 | 56% |

## 真实 DAYU 关键点回放（安全动作，期望 0 事件）

| 真实会话 | 帧数 | baseline 事件 | patched 事件 |
|---|---|---|---|
| 2026-10-25-dayu-formal-camera-inference-regression/formal-pose-events.jsonl | 436 | 2 | 0 |
| 2026-10-25-dayu-formal-camera-inference-regression/formal-live-events.jsonl | 1288 | 0 | 0 |
| 2026-10-25-dayu-formal-camera-inference-regression/formal-redo-events.jsonl | 495 | 0 | 0 |
| 2026-10-25-dayu-formal-camera-inference-regression/formal-redo3-events.jsonl | 646 | 1 | 0 |
| 2026-10-25-dayu-formal-camera-inference-regression/formal-capture-events.jsonl | 142 | 0 | 0 |
| 2026-10-26-demo-autostart/demo-events-mid.jsonl | 1396 | 0 | 0 |
