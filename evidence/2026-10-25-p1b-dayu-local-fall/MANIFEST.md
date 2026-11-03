# P1-B 证据目录 MANIFEST

目录：`<WORKSPACE>\competition\evidence\2026-10-25-p1b-dayu-local-fall\`
日期：2026-10-25
最终结论：`POSE_VALIDATION_FAILED`

## 1. 结论摘要

- 320 性能闸门 **PASS**：真实相机 20.3 min，p50 462 ms、p95 484 ms、inferFps 2.05、errors 0、RSS 57–63 MB、temp 55–58.9 °C。
- 离线 fixture/状态机 13/13 PASS（FIXTURE，不是真人）。
- 真机姿态 **FAIL/BLOCKED**：现场空间不足，镜头只到近景头/肩，髋/膝关键点缺失，posture 全部 UNKNOWN；未做真实危险跌倒。
- 若忽略真机姿态失败，性能/离线数据本身成立；**不能**写成实时跌倒 PASS。
- P0：P0-A 正常；fport 曾丢失已重建；模拟器/APP 曾消失并自动重启（新 PID 5698），当前 P0 可用，但 P0-B 同一 PID 冻结实例已被外部重启打断，需用户按基线再确认。

## 2. 目录

| 路径 | 作用 |
|---|---|
| `P1B-REPORT.md` | 汇总报告 + 16 问 16 答 |
| `PERFORMANCE-BENCHMARK.md` | 640/416/320 图像基准 + 真实相机 20.3min 性能 |
| `POSE-CONTRACT.md` | 17 点定义、有效性、姿态判据、多人/跟踪契约、真机近景限制 |
| `FALL-STATE-MACHINE.md` | 状态机转换、唯一 FALL 条件、`fall/fallEvaluated` 语义 |
| `TEST-MATRIX.md` | fixture/图像/真机测试矩阵、证据等级 |
| `LIVE-SAFETY-ACCEPTANCE.md` | 真机安全动作验收（BLOCKED，未做危险动作） |
| `EVENT-SCHEMA-V2.md` | 事件字段、FALL 条件、真实样例、APP 响应 |
| `START-STOP-ROLLBACK.md` | 候选启停/回滚（当前已停止） |
| `P0-IMPACT.md` | P0 影响、fport 丢失/恢复、模拟器外部重启 |
| `KNOWN-LIMITATIONS.md` | 已知限制 |
| `LICENSE-NOTICE.md` | AGPL-3.0/ncnn/stb 许可说明 |
| `BUILD-AND-MODELS.md` | 模型导出/交叉编译/依赖/哈希 |
| `source/` | 候选源码（fall_core、dayu_local_fall、selftest、CMakeLists） |
| `artifacts/` | 板端二进制、源码副本、导出/分析脚本 |
| `models/320`、`models/416`、`models/640` | 三个输入尺寸的 ncnn 模型 |
| `testdata/` | 3 张既有项目测试图（非本轮真人照片） |
| `raw/` | 原始事件/统计/基准/监控/selftest 输出（不含图像视频） |
| `SHA256SUMS.txt` | 本目录哈希清单（不包含自身） |

## 3. 关键哈希

| 对象 | 大小(B) | SHA-256 |
|---|---:|---|
| `artifacts/dayu_local_fall` | 3,102,112 | `EF58405E2C930C476B80E520FE2BC61E86929D301CC65879023A1FBA556BBF0A` |
| `models/320/model.ncnn.param` | 25,354 | `105F6E42BB4B5151FFB17C6D78BCFF97B7419D98386DCC60143985F1E496C413` |
| `models/320/model.ncnn.bin` | 11,508,260 | `5DF9BAA9EE42DB00E408B59F5A707072B294DB1B0F38765B928FAB0E9DA537E1` |
| `models/416/model.ncnn.param` | 25,354 | `6A590ABE0E2507AFFE58FFF39B09844307A0B058C2382E299CD083E1FDEDEEF7` |
| `models/416/model.ncnn.bin` | 11,537,240 | `DAEDF7CB3732659E842F6A823B28502DAC815BB2AD209144A18C979CE48FD0A9` |
| `models/640/model.ncnn.param` | 25,357 | `6214EAE58D3ED8669E36E5FF14B0D20764CD8A97EB008D44DD1B13760F22F7E3` |
| `models/640/model.ncnn.bin` | 11,634,260 | `531602E61A5E77651873109D13BC06199C274B5ECE42AA608A95CBCA28E21FEA` |
| 原始 `yolo11n-pose.pt` | 6,255,593 | `869E83FCDFFDC7371FA4E34CD8E51C838CC729571D1635E5141E3075E9319DC0` |

## 4. 原始数据重点

- `raw/selftest_output.jsonl`：13/13 PASS。
- `raw/bench_320_stats.jsonl`：p50 399/p95 411，2.23 FPS（图像）。
- `raw/perf_stats.jsonl`：真实相机 20.3 min，p50 462/p95 484，2.05 FPS，errors=0。
- `raw/perf_analysis.json`：事件重算（2501 事件，posture UNKNOWN×2501，fallEvents=0）。
- `raw/perf_events.jsonl`：2501 条真实相机本地事件（含关键点；无图像）。
- `raw/perf_monitor.log`：服务/APP 状态监控。
- `raw/benchmark_summary.json`：三尺寸同输入对比。

## 5. 最终现场状态

- 候选 `dayu_local_fall`：**STOPPED**；DAYU `127.0.0.1:9200` 无 LISTEN（仅 TIME_WAIT）。
- 测试用 DAYU 正式 APP：已 `aa force-stop`/kill，当前 STOPPED；未卸载/未改包/未清数据。
- DAYU homemon：PID 2449，原始哈希未变。
- fport：`tcp:9001→tcp:9000` 已恢复。
- PC：Broker 1883 (43624)、Bridge 9101 (47704)、supervisor 11872/worker 50580 HEALTHY；9200 NO-LISTEN。
- 模拟器/手机 APP：外部自动重启后可用（Emulator PID 67520 自 02:18:57；APP PID 5698 自 02:19:11）；P0-B 同一 PID 26710 基线不再成立。
- 三设备 202：最终 k=333、b=355、l=352（02:21 快照），持续增长。
- 相机临时帧：设备 `frames*` 已删除；证据目录**不含**真实相机图像/视频（仅 testdata 3 张既有项目测试图）。

## 6. 复核方式

1. `Get-FileHash`/`sha256sum` 对照 `SHA256SUMS.txt`。
2. `./dayu_local_fall --selftest` 应 13/13 PASS。
3. 按 `START-STOP-ROLLBACK.md` 启动 320 服务（`--rotate 0`），APP 相机页打开后看 `raw/perf_events.jsonl` 增长；近景应出现 `KPT_INSUFFICIENT`/UNKNOWN，不应出现 fall。
4. 回滚：删除 DAYU 候选目录；不影响 P0。
5. P0-B 基线需用户按 P0 冻结文档重新确认（当前 APP PID 5698，非 26710）。
