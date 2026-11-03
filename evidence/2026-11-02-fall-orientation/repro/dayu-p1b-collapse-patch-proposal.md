# DAYU 本地 C++（P1-B fall_core）方向不敏感补丁建议

> 状态：**仅建议，未改 P1-B 原件、未上板**。本仓库当前真机演示链路的跌倒判定在
> **PC 侧 Python**（`vision/fall_detector.py`）；P1-B 的 `fall_core.cpp` 是板端独立的
> 候选实现（`evidence/2026-10-25-p1b-dayu-local-fall/`），两者阈值是**两套**，不能互相
> 套用。本文件给出把 PC 侧已验证的"快速塌落"判据移植到 C++ 的设计与行号。
>
> **可编译草案已单独生成并在主机跑通**：`repro/dayu-p1b-collapse-draft/`（含 `fall_core.h/cpp`
> 补丁副本 + `host_selftest.cpp`，MSYS2 g++ 16.1 编译、6/6 用例通过；未在 ARM32/ncnn/板上编译）。
> 生成脚本 `repro/make_draft.py`，输出见 `data/draft_host_selftest.log`。

## 1. 现有 C++ 判定的漏检点

`fall_core.h`：

| 行 | 常量 | 默认值 | 问题 |
|---|---|---|---|
| 66 | `torso_horizontal_min_deg` | 55° | HORIZONTAL 姿态要求在图像平面内旋转到接近水平 |
| 67 | `bbox_horizontal_aspect_min` | 1.35 | 或横框，同样要求身体"摊平" |
| 73 | `descent_velocity_min_per_s` | 0.45/s | 速度门槛本身正确，但下降后**必须出现 HORIZONTAL** 才能进入候选 |
| 74 | `descent_drop_min` | 0.15 | 同上 |
| 78-79 | `horizontal_confirm_ms` / `fall_confirm_ms` | 800 / 2200 ms | 要求水平姿态持续 2.2 s |

`fall_core.cpp`：

- L227-231：`horizontal_by_angle` / `horizontal_by_aspect` 定义 HORIZONTAL；
- L678-688：MONITORING → DESCENT_CANDIDATE（快速下降候选，OK）；**DESCENT_CANDIDATE 只有出现 HORIZONTAL 才能进入 HORIZONTAL_CANDIDATE**（L682）；
- L714-756：HORIZONTAL_CANDIDATE → PERSISTENT_HORIZONTAL → FALL_CONFIRMED（L739-756）。

因此与 PC 侧同一根因：竖向屈膝下坠、朝摄像头前倒（投影竖直）在 C++ 侧同样永远
进不了 FALL_CONFIRMED。另外 `src/dayu_local_yolo.cpp:557,600` 对 APP 固定返回
`"fall":false,"fallEvaluated":false`——板端目前**不做告警输出**，即使状态机判到
FALL_CONFIRMED 也只写本地 JSONL。

## 2. 建议改动（fall_core.h）

```cpp
enum class FallState {
    MONITORING = 0,
    DESCENT_CANDIDATE,
    HORIZONTAL_CANDIDATE,
    PERSISTENT_HORIZONTAL,
    COLLAPSE_CANDIDATE,      // 新增：方向不敏感的快速塌落候选
    FALL_CONFIRMED,
    UNKNOWN,
};

struct FallConfig {
    // ...既有字段保持不变...
    // 方向不敏感快速塌落（与 PC 侧 2026-11-02 补丁同一组参数）
    bool  collapse_enabled              = true;
    float collapse_min_body_drop        = 0.22f;  // 相对最近站立基线
    float collapse_window_ms            = 2500.f;
    float collapse_peak_drop_per_s      = 0.30f;  // 受控坐下实测 0.17/s
    float collapse_floor_hip_norm       = 0.78f;  // 髋部图像高度（归一化）
    float collapse_floor_shoulder_norm  = 0.72f;
    float collapse_inversion_margin     = 0.03f;  // 肩中心低于髋中心（图像 y 向下）
    float collapse_height_ratio         = 0.55f;  // 框高 / 站立基线框高
    float collapse_confirm_ms           = 200.f;
};

struct PostureInfo {
    // ...既有字段...
    float shoulder_y = 0.f;       // 新增：肩中心 y（像素）
    float shoulder_y_norm = 0.f;  // 新增：归一化
};
```

`FallEngine` 新增成员：

```cpp
bool   have_standing_baseline_ = false;
int64_t standing_baseline_ms_ = 0;
float   baseline_hip_norm_ = 0.f;
float   baseline_shoulder_norm_ = 0.f;
float   baseline_bbox_h_ = 0.f;
float   peak_hip_v_ = 0.f;       // 自站立基线以来最大髋下降速度
float   peak_shoulder_v_ = 0.f;
uint64_t collapse_since_ms_ = 0;
```

## 3. 建议改动（fall_core.cpp）

1. `evaluate_posture()` L208-223 处：`pi.shoulder_y = shy; pi.shoulder_y_norm = shy/img_h;`
2. `process()` 中在拿到 `pi` 之后、状态机之前维护基线（伪代码）：

```cpp
bool upright_pose = (pi.posture == Posture::UPRIGHT);
bool standing_like = upright_pose &&
    (!have_standing_baseline_ || pi.hip_y_norm <= baseline_hip_norm_ + 0.02f);
if (standing_like) {
    have_standing_baseline_ = true;
    standing_baseline_ms_ = now;
    baseline_hip_norm_ = pi.hip_y_norm;
    baseline_shoulder_norm_ = pi.shoulder_y_norm;
    baseline_bbox_h_ = p.h / frame.img_h;
    peak_hip_v_ = peak_shoulder_v_ = 0.f;
} else if (have_standing_baseline_) {
    peak_hip_v_ = std::max(peak_hip_v_, velocity);
    // 肩下降速度：需要把 shoulder_y_norm 也 push 进 history_，或保留上一帧 shoulder_y_norm 计算
    peak_shoulder_v_ = std::max(peak_shoulder_v_, shoulder_velocity);
}

bool collapse = have_standing_baseline_ && cfg_.collapse_enabled &&
    (now - standing_baseline_ms_ <= (int64_t)cfg_.collapse_window_ms) &&
    (std::max(pi.hip_y_norm - baseline_hip_norm_,
              pi.shoulder_y_norm - baseline_shoulder_norm_) >= cfg_.collapse_min_body_drop) &&
    (std::max(peak_hip_v_, peak_shoulder_v_) >= cfg_.collapse_peak_drop_per_s) &&
    (pi.hip_y_norm >= 0.58f) /* 低位上下文 */ &&
    ( pi.hip_y_norm >= cfg_.collapse_floor_hip_norm
      || pi.shoulder_y_norm >= cfg_.collapse_floor_shoulder_norm
      || pi.shoulder_y_norm >= pi.hip_y_norm - cfg_.collapse_inversion_margin
      || (pi.aspect > 0.f &&
          (p.h / frame.img_h) / std::max(1e-6f, baseline_bbox_h_) <= cfg_.collapse_height_ratio) );
```

3. 状态机插入（在 L650 起的 MONITORING 分支之后、L714 之前）：

```cpp
// DESCENT_CANDIDATE 分支内：允许以 collapse 代替 HORIZONTAL
if (collapse) {
    state_ = FallState::COLLAPSE_CANDIDATE;
    state_since_ms_ = now;
    collapse_since_ms_ = now;
    add_reason(d, "COLLAPSE_AFTER_DESCENT");
    return d;
}

// 新增 COLLAPSE_CANDIDATE 分支
if (state_ == FallState::COLLAPSE_CANDIDATE) {
    if (pi.posture == Posture::UPRIGHT && standing_like &&
        now - state_since_ms_ >= (int64_t)cfg_.cancel_upright_ms) {
        state_ = FallState::MONITORING;               // 站起来 -> 取消
        return d;
    }
    if (collapse) {
        if (now - collapse_since_ms_ >= (int64_t)cfg_.collapse_confirm_ms) {
            state_ = FallState::FALL_CONFIRMED;
            active_event_id_ = next_event_id(primary->id);
            local_fall_event(d);                      // 唯一 fall=true 的出口
        }
    } else if (now - collapse_since_ms_ > (int64_t)cfg_.descent_candidate_max_ms) {
        state_ = FallState::MONITORING;
    }
    return d;
}
```

4. **FALL_CONFIRMED → MONITORING 的恢复条件**必须从"姿态 UPRIGHT"改为
   "回到站立基线高度"（`upright && hip_y_norm <= baseline_hip_norm_ + 0.02`），
   否则"竖向跌倒在低处仍呈直立姿态"会被立刻当成恢复。

## 4. 上板前必须验证（未验证项）

1. 用真实相机回放"竖向屈膝 / 朝镜头前倒 / 坐下 / 蹲下 / 弯腰"各 ≥5 次，
   记录 `hip_y_norm / shoulder_y_norm / descent_velocity / collapse 触发帧`；
2. 标定 `collapse_peak_drop_per_s`：真机受控坐下实测峰值约 0.17/s（PC 侧 2026-10-16
   证据），真实跌倒预期 ≥0.4/s，需要在 DAYU 2 FPS 采样下确认余量；
3. 确认 `collapse_floor_hip_norm=0.78` 在演示机位是否可达（PC 侧 2026-10-28 机位
   躺姿 hip 仅 0.617；若板端机位同样如此，需改用 ground-zone 或 shoulder 通道）；
4. 单独评估"快速坐到地上/快速深蹲"的误报率（PC 侧合成边界用例已显示该残余风险）；
5. 把 `fall/fallEvaluated` 接到 APP 前，先只写本地 JSONL 观察误报，再开放 MQTT/告警。
