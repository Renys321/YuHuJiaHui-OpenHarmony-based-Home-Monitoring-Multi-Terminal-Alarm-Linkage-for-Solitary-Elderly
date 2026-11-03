# 性能基准（P1-B）

## 1. 同输入图像基准（DAYU 真机）

命令：`./dayu_local_fall --dir testdata --repeat 10 --size <N> ...`
测试图：`person_camera_preview.jpeg`（1 人）、`no_person_camera_check.jpeg`、`no_person_living_room.jpeg`
每个尺寸 30 帧；模型加载不计入 p50/p95。

| size | p50 ms | p95 ms | min/max ms | infer FPS | errors | RSS | temp |
|---|---:|---:|---|---:|---:|---:|---:|
| 640 | 1641 | 1653 | 1627/1689 | 0.59 | 0 | 122,092 kB | 48.9 °C |
| 416 | 694 | 704 | 683/715 | 1.34 | 0 | 81,908 kB | 50.0 °C |
| **320** | **399** | **411** | **394/415** | **2.23** | **0** | **62,940 kB** | **50.0 °C** |

- 性能闸门（infer FPS ≥2.0、p95 ≤700 ms）：**320 通过**（图像级）；416/640 不通过。
- 320 相对 640：p50 降约 75.7%，p95 降约 75.1%，FPS 提升约 3.8 倍。
- 选择 320 的理由：唯一满足性能闸门的尺寸；416 的 p95=704 ms 且 1.34 FPS，640=0.59 FPS。

## 2. 关键点质量与一致性

同输入对比（320/416 对 640）：

| 尺寸 | 有人图 validKpts 平均 | kptConfAvg | kptConfMin | 640↔候选 bbox IoU 平均 | 关键点平均距离 |
|---|---:|---:|---:|---:|---:|
| 640 | 4 | 0.212 | 0.031 | — | — |
| 416 | 6 | 0.212 | 0.017 | 0.515 | 207 px |
| 320 | 2 | 0.108 | 0.011 | 0.516 | 341 px |

解释：

- 这张项目测试图人物较小/较远（640 也只有 4 个点 ≥0.30），**不能代表近景全身**；但它已说明小输入会进一步降低关键点质量。
- 真实相机近景帧（320）validKptCount≈6–8、hips conf≈0.01–0.02 → 无法满足姿态所需髋/膝点；见 `POSE-CONTRACT.md` 与 `LIVE-SAFETY-ACCEPTANCE.md`。
- 结论：320 满足**性能**闸门；关键点质量在真实近景下**不满足姿态判断**，因此最终 `POSE_VALIDATION_FAILED`，不能写实时跌倒 PASS。

## 3. 真实相机 20 分钟连续运行（320）

`raw/perf_stats.jsonl`（进程内统计）+ `raw/perf_analysis.json`（原始事件重算）：

```text
cameraActiveSec = 1217.2（20.3 min，>20 min 要求）
framesReceived = 2989
framesInferred = 2501
framesDropped = 488（16.3%）
errors = 0
inferMsP50 = 462 ms；p95 = 484 ms；max = 698 ms
captureFps = 2.45；inferFps = 2.05
RSS = 57,416–63,276 kB（稳定约 63 MB）
tempC = 55.0–58.9 °C；governor=performance，1.992 GHz（无降频证据）
cpuSeconds = 1188.23 / 1217.9 s ≈ 97.6% 单核
postureCounts = UNKNOWN 2501；fallConfirmedEvents = 0
personCounts = 1×2500、2×1；validKptCount 平均 6.51
```

**性能闸门结论：PASS**（inferFps 2.05 ≥2.0，p95 484 ms ≤700 ms，连续 20.3 min，errors=0，RSS 无持续增长，温度未降频）。

但同一窗口的真实姿态 **全部 UNKNOWN**（近景只有头/肩，髋/膝缺失），因此“实时跌倒检测”**不能** PASS；见 `POSE-CONTRACT.md`、`LIVE-SAFETY-ACCEPTANCE.md`。

## 4. 说明

- capture FPS 是 APP 实际 POST 到达率；infer FPS 是本机处理率；未处理帧计 dropped，不伪装。
- 所有推理均在 DAYU 本机；PC 只做构建/取证。
- 640/416/320 均为同一模型导出，仅输入尺寸不同；测试输入相同（3 张项目图 ×10 轮；真实帧另做回放）。
