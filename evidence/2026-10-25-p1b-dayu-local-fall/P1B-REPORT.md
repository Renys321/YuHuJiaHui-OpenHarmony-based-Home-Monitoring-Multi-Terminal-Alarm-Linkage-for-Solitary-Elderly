# P1-B 报告：DAYU200 本机 Pose 性能、姿态语义与本地跌倒状态机

日期：2026-10-25（CST）
目录：`<WORKSPACE>\competition\evidence\2026-10-25-p1b-dayu-local-fall\`

## 0. 最终结论

```text
POSE_VALIDATION_FAILED
```

**P1-B 技术结论**：320 性能闸门 PASS（真实相机 20.3 min，inferFps 2.05、p50 462 ms、p95 484 ms、errors 0）；离线 fixture/状态机 13/13 PASS；**真机姿态验证 FAIL**（现场空间不足无法全身入镜，真实帧只有头/肩，髋/膝缺失，posture 全部 UNKNOWN）；未做真实跌倒/危险动作。若把 fixture 或性能结果写成“实时跌倒检测 PASS”是不成立的。

**P0 现场异常（不中止 P1-B，但必须记录）**：P1-B 收尾窗口发现 fport 丢失（已按 P0 文档重建，living 202 于 02:17:26 恢复）；模拟器/手机 APP 一度消失（5555 无监听、hdc target 缺失），随后模拟器于 **02:18:57 自动重启**、手机 APP 以新 PID 5698 运行，hdc 已重新连接、5555 LISTEN、P0-A 202 继续。该重启**不是本任务启动**（未执行任何 emulator 启动命令），但 P0-B 冻结时的“同一 PID 26710 未重启”当前实例已不成立；P0 当前可用，P0-B 需用户按原基线再确认。详见 `P0-IMPACT.md`。

## 1. 基线校验（先校验再使用）

- P1-A `SHA256SUMS.txt`：**38/38 通过，0 缺失/0 篡改**。
- 冻结 APP：2,086,949 B / `9EEBEE9A…D25A`；回退 APP：2,077,912 B / `8A722EB6…A985`，与基线一致。
- 已完整阅读：P0 冻结、P0-A 验收；P1-A 的 REPORT/COMPATIBILITY/MODEL/STAGE-A/STAGE-B-C/EVENT-SCHEMA/NEXT/START-STOP/P0-IMPACT/MANIFEST/SHA256SUMS + `dayu_local_yolo.cpp` 802 行。
- 阶段 A 只读预检 10 项全部通过（当时模拟器 5555 LISTEN、手机 APP 26710 在、fport 在、homemon 哈希原版、9200 无监听、P1-A 目录完整）。
- 本轮新增只写 `evidence/2026-10-25-p1b-dayu-local-fall/` 与 DAYU `/data/local/tmp/p1b-fall-2026-10-25/`；没有改 P1-A/P0 文件。

## 2. 已实现内容（复用 P1-A ncnn/模型）

源码（`source/`，交付副本在 `artifacts/`）：

- `fall_core.h/.cpp`：纯逻辑（跟踪、姿态、跌倒状态机），无 ncnn/HTTP 依赖，便于 fixture 测试。
- `dayu_local_fall.cpp`：ncnn 推理、640/416/320 输入、HTTP 收帧、有界最新帧、事件 JSONL、`--image/--dir/--serve/--selftest`。
- `selftest.cpp`：13 个确定性 fixture/时间测试。
- `CMakeLists.txt`：复用 P1-A ncnn arm32 静态库。

模型：`models/640`、`models/416`、`models/320`（同源 YOLO11n-pose，仅输入尺寸不同）。
候选程序：`artifacts/dayu_local_fall`（ELF32 ARM PIE）。

## 3. 性能（详见 `PERFORMANCE-BENCHMARK.md`）

| size | p50 | p95 | infer FPS（图像） | 结论 |
|---|---:|---:|---:|---|
| 640 | 1641 ms | 1653 ms | 0.59 | 不达标 |
| 416 | 694 ms | 704 ms | 1.34 | p95/FPS 均不达标 |
| **320** | **399 ms** | **411 ms** | **2.23** | **图像级达标** |

真实相机 320 连续 20.3 min：

```text
framesReceived=2989  inferred=2501  dropped=488  errors=0
inferMsP50=462  p95=484  max=698
captureFps=2.45  inferFps=2.05
RSS 57–63 MB；temp 55–58.9 °C；CPU ≈97.6% 单核；governor=performance/1.992GHz
posture=UNKNOWN 2501；fallConfirmedEvents=0
```

→ **性能闸门 PASS**（FPS≥2、p95≤700、20.3min、无错误、无持续内存增长、无降频证据）。

## 4. 姿态语义与真实相机（关键失败点）

实现了 6 个姿态状态：`NO_PERSON / UPRIGHT / SITTING_OR_CROUCHING / HORIZONTAL / TRANSITION / UNKNOWN`；判据集中在 `FallConfig`，包含肩/髋中点、躯干角、bbox 宽高比、髋-膝/髋-踝间距、关键点有效率、时间。

真机问题：

- 抓到的 JPEG 为 640×480 正面近景；人工核对**方向正常**，无需旋转（`--rotate 0` 得高置信度头/肩；90/270 反而丢检）。
- 真实帧逐帧结果：`personCount=1`，`validKptCount≈6–8`，nose/eyes/ears/shoulders conf 0.7–0.97，但 **hips conf≈0.01–0.02** → `KPT_INSUFFICIENT`、`posture=UNKNOWN`、`fallEvaluated=false`。
- 用户明确反馈现场空间不足，无法后退到全身（头到脚）入镜；因此**未执行**站立/坐下/弯腰/蹲下/缓慢躺下等真机安全动作验收；**未做真实跌倒**。
- 用户看到的 APP 预览旋转 90° 是显示层问题，与抓帧方向不一致；未修改 APP/HAP。

## 5. 离线/时间/状态机测试

`./dayu_local_fall --selftest` → **13/13 PASS，failures=0**（`raw/selftest_output.jsonl`）：

- 站立、坐下、弯腰、蹲下、缓慢躺下（不 FALL）；
- 快速下降后恢复（取消，不 FALL）；
- 快速下降后持续横卧（唯一 FALL_CONFIRMED，fallEventId 唯一，重复横卧不重复 FALL）；
- 关键点短暂丢失 grace、超过 grace → UNKNOWN/fallEvaluated=false；
- 相机/推理无效 → personCount=-1/UNKNOWN/fallEvaluated=false；
- 多人主目标切换（trackId 变化、状态重置）；
- 单帧水平不确认 FALL；
- 恢复后允许新事件（两个不同 eventId）；
- 有效无人 personCount=0；非单调时间拒绝。

**证据等级：FIXTURE（合成关键点，不是真人/视频）**。

## 6. 事件与状态机

事件 `p1b.dayu.local.fall.event/2`，字段和真实样例见 `EVENT-SCHEMA-V2.md`。`fall=true` 唯一条件：

```text
dataValid=true + 主目标稳定（hits≥2）
+ 快速下降候选（≥0.45 图像高/s 且 ≥0.15 图像高）
+ HORIZONTAL 持续 ≥800ms → PERSISTENT_HORIZONTAL
+ 距首次水平 ≥2200ms
→ 唯一 FALL_CONFIRMED 转换事件
```

真实相机本轮 `fallConfirmedEvents=0`；APP HTTP 固定 `fall=false/fallEvaluated=false`（不接正式告警）。

## 7. P0 影响与现场异常

- P0-A 核心：supervisor 11872/worker 50580 HEALTHY；Broker 43624；Bridge 47704；homemon 2449 原版未重启；fport 重建后 `tcp:9001→tcp:9000` 恢复；living 202 于 02:17:26 恢复。
- **P0-B 经历外部重启**：收尾窗口模拟器/APP 一度消失（5555 无监听、hdc target 缺失、tconn 失败）；随后模拟器于 02:18:57 自动重启，手机 APP 以新 PID 5698 运行，5555/hdc/APP 恢复；不是本任务启动，但冻结基线的同一 PID 26710 已被破坏。
- 当前 P0 可用；P0-B 需用户按原冻结基线重新确认（新 PID 实例）。
- 因此 P1-B 最终按技术结果分类 `POSE_VALIDATION_FAILED`，而不是 P0 中止。

## 8. 十六个必答问题

| # | 问题 | 回答 |
|---|---|---|
| 1 | 最终选择 640/416/320？ | **320**：唯一满足性能闸门（2.05 FPS 实测、p95 484 ms）；416 p95 704/FPS1.34、640 FPS0.59 均不达标。 |
| 2 | 真机 infer FPS/p50/p95/RSS/CPU/温度？ | 20.3 min：**2.05 / 462 ms / 484 ms**；RSS 57–63 MB；CPU≈97.6% 单核；55–58.9 °C；errors=0。 |
| 3 | 是否达到≥2 FPS？ | **是**（真实相机 2.05；图像级 2.23），但真机姿态仍失败，不构成实时跌倒 PASS。 |
| 4 | 17 点是否被姿态算法真实消费？ | **是**：姿态由肩/髋/膝/踝等关键点计算（`fall_core.cpp`）；真实近景因髋/膝缺失返回 UNKNOWN，不是“只写 JSON”。 |
| 5 | 实现了哪些姿态状态？ | NO_PERSON、UPRIGHT、SITTING_OR_CROUCHING、HORIZONTAL、TRANSITION、UNKNOWN。 |
| 6 | 状态机完整转换？ | MONITORING→DESCENT_CANDIDATE→HORIZONTAL_CANDIDATE→PERSISTENT_HORIZONTAL→FALL_CONFIRMED→RECOVERED/MONITORING；任意无效→UNKNOWN；详见 `FALL-STATE-MACHINE.md`。 |
| 7 | fall=true 唯一条件？ | 有效输入 + 稳定主目标 + 快速下降候选 + HORIZONTAL 持续≥2200ms 的唯一 FALL_CONFIRMED 转换；仅 fixture 触发过，真实相机 0 次。 |
| 8 | 正常坐下/弯腰/缓慢躺下是否误报？ | fixture 均不误报；**真机未完成**（无法全身入镜），不能声称真机无误报。 |
| 9 | 快速下降/持续横卧证据等级？ | **FIXTURE**；无预录视频/显示器视频/真人快速跌落。 |
| 10 | 相机/推理/关键点无效时？ | 保持 UNKNOWN、`fallEvaluated=false`；无效 personCount=-1，不输出安全/无人；真机近景帧已验证 KPT_INSUFFICIENT。 |
| 11 | 多人如何选择和跟踪？ | 优先上一主目标；IoU/中心距离关联；丢失 800ms grace 内不切换；超时后按 conf+面积选新主目标并重置状态；详见 `POSE-CONTRACT.md`。 |
| 12 | 是否产生重复 FALL 事件？ | fixture 中同一次跌倒只 1 个 eventId，持续横卧不重复；真实相机 0 次，无法做真机重复验证。 |
| 13 | P0 是否始终保持正常？ | P0-A 核心始终正常（supervisor/worker/homemon/Broker/Bridge）；但收尾窗口 fport 曾丢失（已重建，living 202 恢复），模拟器/APP 曾消失并**自动重启**（新 PID 5698，非本任务启动）→ 当前可用，但不是“同一实例从未波动”；P0-B 需用户按原基线再确认。 |
| 14 | PC 是否参与最终推理？ | **否**；PC 只做模型导出/构建/日志分析；推理在 DAYU。 |
| 15 | 候选是否停止且可完整回滚？ | 已停止；DAYU 9200 无 LISTEN（仅 TIME_WAIT）；APP 已退出；删除 `/data/local/tmp/p1b-fall-2026-10-25` 即回滚。 |
| 16 | 距正式 APP/告警链还缺什么？ | 全身入镜/相机视野或广角方案、真机姿态验收；APP/NAPI 内嵌与显示方向修正；事件接 homemon/Bridge/MQTT/public-sync；启动/看护/模型版本/回滚；性能余量与 AGPL 许可。 |

## 9. 交付物

`P1B-REPORT.md`、`PERFORMANCE-BENCHMARK.md`、`POSE-CONTRACT.md`、`FALL-STATE-MACHINE.md`、`TEST-MATRIX.md`、`LIVE-SAFETY-ACCEPTANCE.md`、`EVENT-SCHEMA-V2.md`、`START-STOP-ROLLBACK.md`、`P0-IMPACT.md`、`KNOWN-LIMITATIONS.md`、`LICENSE-NOTICE.md`、`MANIFEST.md`、`SHA256SUMS.txt`；源码/二进制/320·416·640 模型；`raw/` 原始事件、统计、监控与 seltest/benchmark。

**不得**把本报告的 fixture 或性能结果解读为“真实跌倒检测 PASS”；P0-B 实例已被外部重启，需用户按冻结基线再确认一次，再复用本目录证据继续验收。
