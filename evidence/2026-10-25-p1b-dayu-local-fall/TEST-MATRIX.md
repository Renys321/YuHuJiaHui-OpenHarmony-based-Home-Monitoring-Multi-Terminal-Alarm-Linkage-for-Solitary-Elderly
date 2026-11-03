# 测试矩阵（P1-B）

## 1. 离线/可重复测试（板端同一核心代码）

运行：`./dayu_local_fall --selftest`（DAYU，无相机/无模型）
原始输出：`raw/selftest_output.jsonl`
结果：**13/13 PASS，failures=0**

| 用例 | 目的 | 结果 |
|---|---|---|
| standing_stable | 站立稳定 → UPRIGHT，无 fall | PASS |
| sitting | 坐下 → SITTING_OR_CROUCHING，无 fall | PASS |
| bending | 弯腰 → TRANSITION，无 fall | PASS |
| squatting | 蹲下 → SITTING_OR_CROUCHING，无 fall | PASS |
| slow_lying | 缓慢躺下 → HORIZONTAL，但无 fall（HORIZONTAL_WITHOUT_DESCENT） | PASS |
| fast_descent_recovery | 快速下降后恢复 → 候选取消，无 fall | PASS |
| fast_descent_persistent_horizontal | 快速下降 + 水平持续 → 唯一 FALL_CONFIRMED，eventId 唯一，重复横卧不重复 fall | PASS |
| kpt_loss_grace | 关键点短暂丢失保留姿态；超过 grace → UNKNOWN/fallEvaluated=false | PASS |
| camera_and_inference_invalid | 相机/推理无效 → personCount=-1、UNKNOWN、fallEvaluated=false | PASS |
| multi_person_primary_switch | 多人主目标切换 → trackId 变化、状态重置 | PASS |
| single_frame_horizontal_not_fall | 单帧水平 → 不确认 FALL | PASS |
| recovery_then_new_event | 恢复后允许新跌倒 → 两个不同 eventId | PASS |
| no_person_and_non_monotonic_time | 有效无人 personCount=0；非单调时间被拒绝 | PASS |

说明：fixture 是**合成关键点序列**（不是真人、不是视频），只证明核心逻辑/时序/去重；不能替代真机姿态验收。

## 2. 同输入图像基准（真实板端推理）

同一组 3 张项目测试图，各 10 轮（30 帧/尺寸），`--dir testdata --repeat 10`；原始数据 `raw/bench_*`，汇总 `raw/benchmark_summary.json`。

| 尺寸 | p50 ms | p95 ms | infer FPS | errors | 结论 |
|---|---:|---:|---:|---:|---|
| 640 | 1641 | 1653 | 0.59 | 0 | 不满足性能闸门 |
| 416 | 694 | 704 | 1.34 | 0 | p95>700、FPS<2，不满足 |
| 320 | 399 | 411 | 2.23 | 0 | 满足性能闸门（图像级） |

关键点/一致性见 `PERFORMANCE-BENCHMARK.md`；旧测试图人物小/远，关键点质量偏低，小输入进一步降低；真实近景帧另行判断。

## 3. 真实相机测试

| 项 | 方式 | 结果/证据等级 |
|---|---|---|
| 相机帧接入 | 正式 APP 相机页 → 设备 loopback 9200 | **REAL_CAMERA**，已收帧 |
| 近景画面 | 640×480，方向正常，头/肩可见，髋/膝缺失 | **REAL_CAMERA**；posture=UNKNOWN / KPT_INSUFFICIENT |
| 站立/坐下/弯腰/蹲下/缓慢躺下 | 需全身入镜 | **BLOCKED**：现场空间不足，无法全身入镜；未完成 |
| 快速下降/持续横卧 | 禁止危险真人动作 | **未做**；仅 FIXTURE |
| 真实 FALL_CONFIRMED | 不要求危险动作，故未做 | **未做**；不得声称真人跌倒 PASS |
| 20 分钟性能 | 320 + 真实 APP 相机（近景） | **REAL_CAMERA_PERF PASS**：20.3 min，p50 462/p95 484 ms，2.05 FPS，errors=0，RSS 57–63 MB，temp 55–58.9 °C |

证据分级：

```text
FIXTURE              合成关键点，仅逻辑
IMAGE_FILE           项目测试图，非真人本轮拍摄
REAL_CAMERA          本轮 DAYU 相机真实帧（近景，姿态点不足）
REAL_SAFE_ACTION     未完成（空间不足）
DISPLAY_VIDEO        未使用
REAL_FALL            未执行（安全边界）
```

## 4. 结论

- 状态机、姿态、跟踪、时间语义：fixture **PASS**。
- 320 图像级性能：**PASS**；416/640 不达标。
- 320 真实相机 20.3 min 性能：**PASS**（2.05 FPS / p95 484 ms / errors 0）。
- 真机姿态语义：**FAIL/BLOCKED**（近景导致髋/膝缺失，posture 全 UNKNOWN；无法做站立/坐/躺真机验收）。
- 最终任务结论：`POSE_VALIDATION_FAILED`（性能达标，但真机姿态失败，不是实时跌倒 PASS）。
- P0 现场：fport 曾丢失已重建；模拟器/APP 曾消失并自动重启（新 PID），当前 P0 可用但 P0-B 需按冻结基线再确认。
