# P1-A 证据目录清单

目录：`<WORKSPACE>\competition\evidence\2026-10-25-p1a-dayu-local-yolo\`
日期：2026-10-25（CST）
结论：`DAYU_LOCAL_CAMERA_INFERENCE_PASS` / `CPU_ONLY`

## 1. 目录结构

| 路径 | 作用 |
|---|---|
| `P1A-REPORT.md` | 汇总报告：结论、8 问 8 答、兼容性、路线、结果、P0 影响、后续 |
| `COMPATIBILITY-MATRIX.md` | DAYU 系统/ABI/CPU/RAM/NPU/相机/工具链实测矩阵 |
| `EXISTING-WORK-INVENTORY.md` | 实际读取的已有代码/文档与复用/不复用理由 |
| `MODEL-AND-BUILD.md` | 模型来源/许可证/输入输出/哈希、转换与交叉编译命令、依赖版本 |
| `STAGE-A-RESULTS.md` | 阶段 A 单图真机结果（含 NEON 缺陷与修复） |
| `STAGE-B-C-RESULTS.md` | 阶段 B 进入/离开/再次进入 + 阶段 C 19 分钟稳定性 |
| `EVENT-SCHEMA.md` | 本地事件 schema、失败语义、真实样例、APP 响应 |
| `START-STOP-ROLLBACK.md` | 候选身份/启停命令/回滚/注意事项 |
| `P0-IMPACT.md` | 对正式 P0 的影响检查（PIDs/端口/fport/202/现场恢复） |
| `NEXT-INTEGRATION-NOTES.md` | 后续正式集成接口建议（仅建议，未实现） |
| `artifacts/dayu_local_yolo` | 最终板端程序（ELF32 ARM PIE，2,984,528 B） |
| `artifacts/dayu_local_yolo.cpp` / `CMakeLists.txt` | 板端源码/构建入口 |
| `artifacts/model.ncnn.param` / `.bin` / `metadata.yaml` | 板端实际使用的 ncnn 模型 |
| `artifacts/export_ncnn.py` / `ncnn_reference.py` | PC 转换脚本/PC 参考解码（仅准备/对照） |
| `raw/*` | 原始事件/统计/分析/监控日志（含修复前后与压力测试） |
| `logs/server*.log` | 候选服务启动日志 |
| `SHA256SUMS.txt` | 本目录全部文件哈希 |

## 2. 关键哈希

| 对象 | 大小(B) | SHA-256 |
|---|---:|---|
| 板端程序 | 2,984,528 | `F80FFD7CC0015D96C63EE88DC037FEC5F0B08B76F6526F521E869EF0ED8BDD25` |
| 板端程序（日志修复前） | 2,984,512 | `A3D0FFDD28EF0C3DC754D0583E67DAC4A0DB6DECA43CCD14D16DDCFEEE91D74A` |
| `model.ncnn.param` | 25,357 | `6214EAE58D3ED8669E36E5FF14B0D20764CD8A97EB008D44DD1B13760F22F7E3` |
| `model.ncnn.bin` | 11,634,260 | `531602E61A5E77651873109D13BC06199C274B5ECE42AA608A95CBCA28E21FEA` |
| `model.ncnn` metadata | 465 | `ACD1953D80B29D7556BF8035A50EA7158FBD00E443C32EDDE57415647061BF1B` |
| 源码 `dayu_local_yolo.cpp` | 26,867 | `E891D32BC98520657332448639339A9ECE810331EA624AD335BE5106C513E785` |
| `CMakeLists.txt` | 702 | `C3E2C3CBB2299B4C0BEBAD27A029D4E6C9FCF65A37E8D6C0DAB7908DB98C05DD` |
| 原始 `yolo11n-pose.pt` | 6,255,593 | `869E83FCDFFDC7371FA4E34CD8E51C838CC729571D1635E5141E3075E9319DC0` |
| ncnn 源码 commit | — | `cb65ca26ba955bf456f3a26e13e9a644769fc4a4` |

完整哈希见 `SHA256SUMS.txt`（37 个文件，约 19.4 MB）。

## 3. 目录之外的源码/构建位置

- `<WORKSPACE>\competition\vision\dayu-local\`
  - `src/dayu_local_yolo.cpp`、`CMakeLists.txt`
  - `model/`（param/bin/metadata）
  - `third_party/ncnn/`（gitee commit `cb65ca26…`）
  - `build-arm-neon2/`（ncnn 静态库）、`build-app-neon4/`（板端程序）
  - `export/`（转换脚本、PC ncnn 参考、PC 测试扫描）
- `<WORKSPACE>\competition\vision\yolo11n-pose_ncnn_model\`（Ultralytics 导出目录）
- DAYU：`/data/local/tmp/p1a-yolo-2026-10-25/`（程序、模型、测试图、设备侧 evidence；服务已停止）

## 4. 最终状态

- 候选进程：**已停止**（SIGTERM 写出 summary；无 `dayu_local_yolo` 进程）。
- 正式 APP：测试时为取帧由用户打开，测试后 `aa force-stop com.dsh.eldercare`；未卸载/未改包/未清数据，当前未运行。
- P0：supervisor 11872 / worker 50580 HEALTHY；Broker 43624；Bridge 47704；fport 9001→9000；homemon 2449；手机 APP 26710；三设备 202 持续增长。
- 未做：APP 集成、Broker/Bridge/public-sync 迁移、4G、APP/后端修改、HAP 安装、系统/驱动修改。

## 5. 复核方式

1. `Get-FileHash`/`sha256sum` 对照 `SHA256SUMS.txt`。
2. 阶段 A：按 `START-STOP-ROLLBACK.md` §3 重跑单图，应得到 personCount=1/0/0。
3. 阶段 C：按 §4 启动服务，用户打开 APP 相机页，观察 `events_cam.jsonl` 增长与 `personCount` 变化；10 分钟后停止并查看 summary。
4. 事件完整性：`raw/events_cam2.jsonl`（修复后）应 80/80 可解析；`raw/events_stress.jsonl` 为 4 MB 单行压力样例。
