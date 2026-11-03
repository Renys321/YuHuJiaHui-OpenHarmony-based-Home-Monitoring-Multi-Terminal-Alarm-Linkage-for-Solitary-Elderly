# DAYU P1-B `fall_core` 方向不敏感 collapse 判据 —— 可编译草案 + 主机单测

> **只读草案，不碰板**：本目录由 `../make_draft.py` 从
> `evidence/2026-10-25-p1b-dayu-local-fall/source/fall_core.{h,cpp}` **只读复制并打补丁**生成；
> 没有修改原 P1-B 源码、没有改 firmware/、没有编译/烧录板端产物。
> 主机侧（Windows x86 / MSYS2 g++ 16.1）已**实际编译并跑通** 6 个用例（见
> `data/draft_host_selftest.log`）。

## 1. 生成 / 编译 / 运行

```bash
cd competition
.venv-vision/Scripts/python.exe evidence/2026-11-02-fall-orientation/repro/make_draft.py
cd evidence/2026-11-02-fall-orientation/repro/dayu-p1b-collapse-draft

# 主机编译（不需要 ncnn / 相机 / 交叉工具链）
g++ -std=c++11 -O2 -I. fall_core.cpp host_selftest.cpp -o host_selftest
./host_selftest        # exit 0 = 全部通过
```

期望输出（2026-11-02 实测）：

```text
  case vertical_collapse                  fall=yes first=2100ms
  case forward_camera_fall                fall=yes first=2000ms
  case sit_down                           fall=no first=-1ms
  case fast_controlled_crouch             fall=no first=-1ms
  case standing_only                      fall=no first=-1ms
  case already_lying                      fall=no first=-1ms
{"host_selftest":"p1b-collapse-draft","failures":0}
```

## 2. 草案改了什么（与 PC 侧 Python 补丁同参数、同结构）

`fall_core.h`：
- `FallState` 新增 `COLLAPSE_CANDIDATE`；
- `FallConfig` 新增 `collapse_*` 参数（默认与 PC 侧一致）：
  `min_body_drop=0.22`、`window_ms=2500`、`peak_drop_per_s=0.30`、
  `terminal_drop_per_s=0.22`、`floor_hip_norm=0.78`、`floor_shoulder_norm=0.72`、
  `inversion_margin=0.03`、`height_ratio=0.55`、`confirm_ms=200`；
- `PostureInfo` 新增 `shoulder_y / shoulder_y_norm / bbox_h_norm`；
- `FallEngine` 新增站立基线、髋/肩峰速、collapse 计时器与 `collapse_evidence()`。

`fall_core.cpp`：
- `evaluate_posture()` 填肩中心/框高归一化；
- `process()` 中维护“站立基线”（几何判定：躯干角 ≤ `torso_upright_max_deg`、肩在髋上方、
  髋不高于基线 +0.02），累计峰值髋/肩速度；
- `collapse_evidence()`：总下沉 ≥0.22、峰值 ≥0.30、低位上下文、**进入帧**触底速度 ≥0.22、
  末端证据（髋到地面层/肩很低/肩低于髋投影反置/框高塌缩）；确认阶段不再查 terminal；
- 状态机：MONITORING 直接进 COLLAPSE_CANDIDATE；旧 DESCENT_CANDIDATE 也可被 collapse 接管；
  COLLAPSE_CANDIDATE →（持续 200ms）FALL_CONFIRMED，站起来取消；
- FALL_CONFIRMED 恢复条件从“姿态 UPRIGHT”改为“回到站立基线”（`standing_like`）。

**未移植/未验证**：
- C++ 草案只用绝对地面层 `floor_hip_norm`，**没有** ground-zone 多边形支持（PC 侧有）；
- 未接 APP 响应（`dayu_local_fall.cpp` 对 APP 仍固定 `fall=false`）；
- 未在 ARM32/ncnn 工具链、未在 DAYU 板上编译或运行；
- 主机夹具是**合成关键点**，不是真实相机帧。

## 3. 主机侧单测建议（扩展现有 `selftest.cpp`）

现有 `selftest.cpp` 已有 `case_fast_descent_persistent()` 等 13 个 fixture；建议新增：

| 用例 | 输入 | 期望 |
|---|---|---|
| `case_collapse_vertical` | 站立 3 帧 → 髋 0.52→0.75→0.84（0.3–0.5/s）→ 保持，髋 0.84、肩 0.63 | `FALL_CONFIRMED_COLLAPSE` 1 次（`fall=true` 恰好一次） |
| `case_collapse_forward` | 站立 → 肩下沉到髋下方（inversion），torso 投影角 <25° | 1 次 FALL；`fallEventId` 唯一 |
| `case_collapse_controlled_crouch` | 站立 → 0.32/s 后减速到 0.05/s 坐到地面（触底帧 <0.22/s） | 0 次 FALL |
| `case_collapse_sit` | 慢坐（峰值 0.17/s，髋 0.70，框高比 0.7） | 0 次 FALL |
| `case_collapse_already_lying` | 起始即躺卧、无站立基线 | 0 次 FALL |
| `case_collapse_recovery` | 竖向塌落 FALLEN 后回到站立基线 ≥900ms | `RECOVERED`，可再次产生新 eventId |
| `case_collapse_timeout` | 进入 COLLAPSE_CANDIDATE 后 5s 内未落定、仍站立 | 取消回 MONITORING，不产生 fall=true |

断言建议：
1. `fall=true` 只在 `FALL_CONFIRMED` 转换出现一次；持续躺卧帧 `fall=false` 且
   `fallAlreadyConfirmed=true`；
2. 竖向/前向用例的 `torso_angle` 在 0–30°，`bbox_aspect` 保持竖长（证明不是旧 HORIZONTAL 路径）；
3. 用 `--selftest` 输出 JSON 计数（现有 `run_selftest()` 返回 `failures`），把新用例加入同一
   `g_cases/g_fail` 统计；
4. 板上运行前，先把同一组 fixture 在主机上跑通（本目录已给出 6 例样例）。

## 4. 上板前必须做的验证（未完成）

1. 在 DAYU ARM32 + ncnn 工具链编译（只新增纯 C++ 逻辑，无新依赖，但仍需板端编译验证）；
2. 用真实相机帧（640×480、≥2 m 全身入镜）跑三方向动作与快速深蹲，采集
   `hip_y_norm/shoulder_y_norm/velocity/terminal` 分布，复核 0.30/0.22/0.78 三个阈值；
3. 与 PC 侧同一组录帧做 A/B，确认 C++ 与 Python 判定一致（同输入同输出）；
4. 确认 `min_valid_kpts=8`/`kpt_conf_min=0.30` 在板端近景帧下的可用性（P1-B 已知真机关键点
   不足问题，见 `KNOWN-LIMITATIONS.md`）；
5. 通过后才考虑把 `fall=true` 接到 APP（现在固定 false）。
