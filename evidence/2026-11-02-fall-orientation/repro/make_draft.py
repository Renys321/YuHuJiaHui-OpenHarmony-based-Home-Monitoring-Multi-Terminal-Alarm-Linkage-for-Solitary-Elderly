"""make_draft.py — 生成 DAYU P1-B `fall_core` 的"方向不敏感 collapse 判据"可编译草案。

读：evidence/2026-10-25-p1b-dayu-local-fall/source/fall_core.{h,cpp}（**只读，不修改原件**）
写：evidence/2026-11-02-fall-orientation/repro/dayu-p1b-collapse-draft/fall_core.{h,cpp}
    + host_selftest.cpp（主机侧单测；x86 g++，不依赖 ncnn/相机）
不做：不改 firmware/、不编译板端产物、不烧录。主机编译命令见 draft/README.md。

用法：
  python make_draft.py            # 生成 3 个文件
  python make_draft.py --check    # 只检查所有锚点存在（不写文件）
"""
from __future__ import annotations

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(HERE))),
                   "evidence", "2026-10-25-p1b-dayu-local-fall", "source")
DRAFT = os.path.join(HERE, "dayu-p1b-collapse-draft")


def replace_once(text, old, new, tag):
    count = text.count(old)
    if count != 1:
        raise SystemExit("[make_draft] anchor '%s' matched %d times (expected 1)" % (tag, count))
    return text.replace(old, new, 1)


def patch_header(text):
    text = replace_once(
        text,
        "enum class FallState {\n    MONITORING = 0,\n    DESCENT_CANDIDATE,\n"
        "    HORIZONTAL_CANDIDATE,\n    PERSISTENT_HORIZONTAL,\n    FALL_CONFIRMED,\n"
        "    UNKNOWN,\n};",
        "enum class FallState {\n    MONITORING = 0,\n    DESCENT_CANDIDATE,\n"
        "    HORIZONTAL_CANDIDATE,\n    PERSISTENT_HORIZONTAL,\n"
        "    COLLAPSE_CANDIDATE,      // 2026-11-02: orientation-agnostic fast collapse\n"
        "    FALL_CONFIRMED,\n    UNKNOWN,\n};",
        "FallState::COLLAPSE_CANDIDATE",
    )
    text = replace_once(
        text,
        "    float horizontal_confirm_ms = 800.f;\n    float fall_confirm_ms = 2200.f;\n",
        "    float horizontal_confirm_ms = 800.f;\n    float fall_confirm_ms = 2200.f;\n"
        "\n    // ---- 2026-11-02 orientation-agnostic fast-collapse (port of PC patch) ----\n"
        "    bool  collapse_enabled = true;\n"
        "    float collapse_min_body_drop = 0.22f;\n"
        "    float collapse_window_ms = 2500.f;\n"
        "    float collapse_peak_drop_per_s = 0.30f;\n"
        "    float collapse_terminal_drop_per_s = 0.22f;\n"
        "    float collapse_floor_hip_norm = 0.78f;\n"
        "    float collapse_floor_shoulder_norm = 0.72f;\n"
        "    float collapse_inversion_margin = 0.03f;\n"
        "    float collapse_height_ratio = 0.55f;\n"
        "    float collapse_confirm_ms = 200.f;\n",
        "FallConfig collapse fields",
    )
    text = replace_once(
        text,
        "        float hip_y = 0.f;\n        float hip_y_norm = 0.f;\n        bool hip_valid = false;\n",
        "        float hip_y = 0.f;\n        float hip_y_norm = 0.f;\n"
        "        float shoulder_y = 0.f;\n        float shoulder_y_norm = 0.f;\n"
        "        float bbox_h_norm = 0.f;\n"
        "        bool hip_valid = false;\n",
        "PostureInfo shoulder_y",
    )
    text = replace_once(
        text,
        "    void reset_candidates(int64_t now);\n",
        "    // ---- 2026-11-02 collapse baseline / peaks ----\n"
        "    bool have_standing_baseline_ = false;\n"
        "    int64_t standing_baseline_ms_ = 0;\n"
        "    float baseline_hip_norm_ = 0.f;\n"
        "    float baseline_shoulder_norm_ = 0.f;\n"
        "    float baseline_bbox_h_norm_ = 0.f;\n"
        "    bool have_last_norms_ = false;\n"
        "    float last_hip_norm_ = 0.f;\n"
        "    float last_shoulder_norm_ = 0.f;\n"
        "    int64_t last_norms_ms_ = 0;\n"
        "    float peak_hip_v_ = 0.f;\n"
        "    float peak_shoulder_v_ = 0.f;\n"
        "    int64_t collapse_since_ms_ = 0;\n"
        "    bool collapse_evidence(const PostureInfo& pi, float velocity,\n"
        "                           float shoulder_velocity, bool require_terminal,\n"
        "                           int64_t now) const;\n"
        "\n    void reset_candidates(int64_t now);\n",
        "FallEngine private members",
    )
    return text


def patch_cpp(text):
    # 1) reset_state: clear collapse baseline
    text = replace_once(
        text,
        "    last_primary_matched_ = false;\n    primary_last_seen_ms_ = 0;\n}",
        "    last_primary_matched_ = false;\n    primary_last_seen_ms_ = 0;\n"
        "    have_standing_baseline_ = false;\n"
        "    standing_baseline_ms_ = 0;\n"
        "    baseline_hip_norm_ = baseline_shoulder_norm_ = baseline_bbox_h_norm_ = 0.f;\n"
        "    have_last_norms_ = false;\n"
        "    peak_hip_v_ = peak_shoulder_v_ = 0.f;\n"
        "    collapse_since_ms_ = 0;\n}",
        "reset_state collapse fields",
    )
    # 2) reset_candidates: clear collapse timer
    text = replace_once(
        text,
        "    descent_start_ms_ = 0;\n    horizontal_start_ms_ = 0;\n    history_.clear();\n}",
        "    descent_start_ms_ = 0;\n    horizontal_start_ms_ = 0;\n"
        "    collapse_since_ms_ = 0;\n    history_.clear();\n}",
        "reset_candidates collapse timer",
    )
    # 3) evaluate_posture: shoulder / bbox height
    text = replace_once(
        text,
        "    pi.torso_angle = clampf(pi.torso_angle, 0.f, 90.f);\n",
        "    pi.torso_angle = clampf(pi.torso_angle, 0.f, 90.f);\n"
        "    pi.shoulder_y = shy;\n"
        "    pi.shoulder_y_norm = img_h > 0 ? clampf(shy / (float)img_h, -0.5f, 1.5f) : 0.f;\n"
        "    pi.bbox_h_norm = img_h > 0 ? clampf(p.h / (float)img_h, 0.f, 1.5f) : 0.f;\n",
        "evaluate_posture shoulder",
    )
    # 4) process(): baseline tracking + collapse flag, right after descent velocity
    text = replace_once(
        text,
        "    d.descent_velocity = velocity;\n",
        "    d.descent_velocity = velocity;\n"
        "\n"
        "    // ---- 2026-11-02 orientation-agnostic fast-collapse (port of PC patch) ----\n"
        "    float shoulder_velocity = 0.f;\n"
        "    if (have_last_norms_ && pi.shoulder_y_norm > last_shoulder_norm_)\n"
        "    {\n"
        "        int64_t dt = now - last_norms_ms_;\n"
        "        if (dt >= 50 && dt <= 1500)\n"
        "            shoulder_velocity = (pi.shoulder_y_norm - last_shoulder_norm_) * 1000.f / (float)dt;\n"
        "    }\n"
        "    bool standing_like = false;\n"
        "    if (pi.hip_valid && pi.torso_valid)\n"
        "    {\n"
        "        const bool shoulder_above_hip = pi.shoulder_y_norm < pi.hip_y_norm;\n"
        "        const bool upright_pose = pi.torso_angle <= cfg_.torso_upright_max_deg;\n"
        "        standing_like = upright_pose && shoulder_above_hip &&\n"
        "            (!have_standing_baseline_ || pi.hip_y_norm <= baseline_hip_norm_ + 0.02f);\n"
        "        if (standing_like)\n"
        "        {\n"
        "            have_standing_baseline_ = true;\n"
        "            standing_baseline_ms_ = now;\n"
        "            baseline_hip_norm_ = pi.hip_y_norm;\n"
        "            baseline_shoulder_norm_ = pi.shoulder_y_norm;\n"
        "            baseline_bbox_h_norm_ = pi.bbox_h_norm;\n"
        "            peak_hip_v_ = peak_shoulder_v_ = 0.f;\n"
        "        }\n"
        "        else\n"
        "        {\n"
        "            peak_hip_v_ = std::max(peak_hip_v_, velocity);\n"
        "            peak_shoulder_v_ = std::max(peak_shoulder_v_, shoulder_velocity);\n"
        "        }\n"
        "        have_last_norms_ = true;\n"
        "        last_hip_norm_ = pi.hip_y_norm;\n"
        "        last_shoulder_norm_ = pi.shoulder_y_norm;\n"
        "        last_norms_ms_ = now;\n"
        "    }\n"
        "    const bool collapse = collapse_evidence(pi, velocity, shoulder_velocity, true, now);\n",
        "process baseline tracking",
    )
    # 5) MONITORING: collapse entry before rapid-descent branch
    text = replace_once(
        text,
        "        if (velocity >= cfg_.descent_velocity_min_per_s && drop >= cfg_.descent_drop_min)\n",
        "        if (collapse)\n"
        "        {\n"
        "            state_ = FallState::COLLAPSE_CANDIDATE;\n"
        "            state_since_ms_ = now;\n"
        "            collapse_since_ms_ = now;\n"
        "            d.state = state_;\n"
        "            d.fall_evaluated = true;\n"
        "            add_reason(d, \"COLLAPSE_FAST_DESCENT\");\n"
        "            d.selected_reason = \"COLLAPSE_FAST_DESCENT\";\n"
        "            return d;\n"
        "        }\n"
        "        if (velocity >= cfg_.descent_velocity_min_per_s && drop >= cfg_.descent_drop_min)\n",
        "MONITORING collapse entry",
    )
    # 6) DESCENT_CANDIDATE: collapse 也可接管（竖向塌落会先被旧速度门抓成 descent 候选）
    text = replace_once(
        text,
        "    if (state_ == FallState::DESCENT_CANDIDATE)\n    {\n",
        "    if (state_ == FallState::DESCENT_CANDIDATE)\n    {\n"
        "        if (collapse)\n"
        "        {\n"
        "            state_ = FallState::COLLAPSE_CANDIDATE;\n"
        "            state_since_ms_ = now;\n"
        "            collapse_since_ms_ = now;\n"
        "            d.state = state_;\n"
        "            d.fall_evaluated = true;\n"
        "            add_reason(d, \"COLLAPSE_AFTER_DESCENT\");\n"
        "            d.selected_reason = \"COLLAPSE_AFTER_DESCENT\";\n"
        "            return d;\n"
        "        }\n",
        "DESCENT_CANDIDATE collapse takeover",
    )
    # 7) FALL_CONFIRMED recovery: use standing_like (still at standing height)
    text = replace_once(
        text,
        "        if (pi.posture == Posture::UPRIGHT)\n        {\n            if (state_since_ms_ == 0)",
        "        if (standing_like)\n        {\n            if (state_since_ms_ == 0)",
        "FALL_CONFIRMED recovery",
    )
    # 8) COLLAPSE_CANDIDATE state branch
    text = replace_once(
        text,
        "    if (state_ == FallState::HORIZONTAL_CANDIDATE || state_ == FallState::PERSISTENT_HORIZONTAL)\n",
        "    if (state_ == FallState::COLLAPSE_CANDIDATE)\n"
        "    {\n"
        "        const bool hold = collapse_evidence(pi, velocity, shoulder_velocity, false, now);\n"
        "        if (standing_like && now - state_since_ms_ >= (int64_t)cfg_.cancel_upright_ms)\n"
        "        {\n"
        "            reset_candidates(now);\n"
        "            d.state = FallState::MONITORING;\n"
        "            d.fall_evaluated = true;\n"
        "            add_reason(d, \"COLLAPSE_CANCELLED_UPRIGHT\");\n"
        "            d.selected_reason = \"COLLAPSE_CANCELLED_UPRIGHT\";\n"
        "            return d;\n"
        "        }\n"
        "        if (hold)\n"
        "        {\n"
        "            if (now - collapse_since_ms_ >= (int64_t)cfg_.collapse_confirm_ms)\n"
        "            {\n"
        "                state_ = FallState::FALL_CONFIRMED;\n"
        "                state_since_ms_ = now;\n"
        "                active_event_id_ = next_event_id(primary->id);\n"
        "                active_event_ = true;\n"
        "                last_event_id_ = active_event_id_;\n"
        "                recovered_flag_ = false;\n"
        "                d.state = state_;\n"
        "                d.event_type = \"FALL_CONFIRMED\";\n"
        "                d.fall = true; // only place where fall=true is emitted\n"
        "                d.fall_evaluated = true;\n"
        "                d.fall_event_id = active_event_id_;\n"
        "                d.fall_event_active = true;\n"
        "                d.fall_already_confirmed = false;\n"
        "                add_reason(d, \"FALL_CONFIRMED_COLLAPSE\");\n"
        "                d.selected_reason = \"FALL_CONFIRMED_COLLAPSE\";\n"
        "                return d;\n"
        "            }\n"
        "            d.state = state_;\n"
        "            d.fall_evaluated = true;\n"
        "            add_reason(d, \"COLLAPSE_CANDIDATE\");\n"
        "            d.selected_reason = \"COLLAPSE_CANDIDATE\";\n"
        "            return d;\n"
        "        }\n"
        "        if (now - collapse_since_ms_ > (int64_t)cfg_.descent_candidate_max_ms)\n"
        "        {\n"
        "            reset_candidates(now);\n"
        "            d.state = FallState::MONITORING;\n"
        "            d.fall_evaluated = true;\n"
        "            add_reason(d, \"COLLAPSE_TIMEOUT\");\n"
        "            d.selected_reason = \"COLLAPSE_TIMEOUT\";\n"
        "            return d;\n"
        "        }\n"
        "        d.state = state_;\n"
        "        d.fall_evaluated = true;\n"
        "        add_reason(d, \"COLLAPSE_HOLD\");\n"
        "        d.selected_reason = \"COLLAPSE_HOLD\";\n"
        "        return d;\n"
        "    }\n"
        "\n"
        "    if (state_ == FallState::HORIZONTAL_CANDIDATE || state_ == FallState::PERSISTENT_HORIZONTAL)\n",
        "COLLAPSE_CANDIDATE branch",
    )
    # 8) collapse_evidence implementation before namespace end
    text = replace_once(
        text,
        "} // namespace p1b\n",
        "bool FallEngine::collapse_evidence(const PostureInfo& pi, float velocity,\n"
        "                                   float shoulder_velocity, bool require_terminal,\n"
        "                                   int64_t now) const\n"
        "{\n"
        "    if (!cfg_.collapse_enabled || !have_standing_baseline_) return false;\n"
        "    if (!pi.hip_valid || !pi.torso_valid) return false;\n"
        "    const int64_t age = now - standing_baseline_ms_;\n"
        "    if (age < 0 || (float)age > cfg_.collapse_window_ms) return false;\n"
        "    const float hip_drop = pi.hip_y_norm - baseline_hip_norm_;\n"
        "    const float sh_drop = pi.shoulder_y_norm - baseline_shoulder_norm_;\n"
        "    const float body_drop = std::max(hip_drop, sh_drop);\n"
        "    const float peak = std::max(peak_hip_v_, peak_shoulder_v_);\n"
        "    if (body_drop < cfg_.collapse_min_body_drop) return false;\n"
        "    if (peak < cfg_.collapse_peak_drop_per_s) return false;\n"
        "    if (pi.hip_y_norm < 0.58f) return false; // low context\n"
        "    if (require_terminal &&\n"
        "        std::max(velocity, shoulder_velocity) < cfg_.collapse_terminal_drop_per_s)\n"
        "        return false; // controlled descent decelerates before the bottom\n"
        "    const bool floor_hip = pi.hip_y_norm >= cfg_.collapse_floor_hip_norm;\n"
        "    const bool floor_shoulder = pi.shoulder_y_norm >= cfg_.collapse_floor_shoulder_norm &&\n"
        "                                pi.hip_y_norm >= 0.62f;\n"
        "    const bool inverted = pi.shoulder_y_norm >= pi.hip_y_norm - cfg_.collapse_inversion_margin &&\n"
        "                          pi.hip_y_norm >= 0.62f;\n"
        "    bool height_collapse = false;\n"
        "    if (baseline_bbox_h_norm_ > 1e-6f && pi.hip_y_norm >= 0.70f)\n"
        "        height_collapse = (pi.bbox_h_norm / baseline_bbox_h_norm_ <= cfg_.collapse_height_ratio);\n"
        "    return floor_hip || floor_shoulder || inverted || height_collapse;\n"
        "}\n"
        "\n} // namespace p1b\n",
        "collapse_evidence impl",
    )
    return text


HOST_SELFTEST = r'''// Host-side unit test for the 2026-11-02 collapse draft (x86, no ncnn/camera).
// Build:
//   g++ -std=c++11 -O2 -I. fall_core.cpp host_selftest.cpp -o host_selftest
// Run:
//   ./host_selftest            (exit 0 = all pass)
#include <cstdio>
#include <cmath>
#include "fall_core.h"

using namespace p1b;

static int g_fail = 0;

static PersonObs make_pose(float hip_y, float sh_y, float bbox_top, float bbox_h,
                           float knee_y = -1.f, float ankle_y = -1.f)
{
    PersonObs p;
    p.x = 200.f; p.y = bbox_top; p.w = 240.f; p.h = bbox_h; p.conf = 0.90f;
    for (int i = 0; i < kNumKpts; i++) { p.kpts[i].x = 320.f; p.kpts[i].y = hip_y; p.kpts[i].conf = 0.90f; }
    p.kpts[5].y = sh_y - 10.f; p.kpts[6].y = sh_y + 10.f; p.kpts[5].x = 290.f; p.kpts[6].x = 350.f;
    p.kpts[11].y = hip_y; p.kpts[12].y = hip_y; p.kpts[11].x = 300.f; p.kpts[12].x = 340.f;
    p.kpts[13].y = knee_y >= 0.f ? knee_y : hip_y + 90.f;
    p.kpts[14].y = p.kpts[13].y;
    p.kpts[15].y = ankle_y >= 0.f ? ankle_y : hip_y + 180.f;
    p.kpts[16].y = p.kpts[15].y;
    return p;
}

static FrameInput frame(int64_t ms, const PersonObs& p)
{
    FrameInput f;
    f.mono_ms = ms; f.data_valid = true; f.img_w = 640; f.img_h = 480;
    f.persons.push_back(p);
    return f;
}

static bool run_case(const char* name, FallConfig cfg, const std::vector<FrameInput>& frames)
{
    FallEngine eng(cfg);
    bool fired = false;
    int64_t first_ms = -1;
    for (size_t i = 0; i < frames.size(); i++)
    {
        FallDecision d = eng.process(frames[i]);
        if (d.fall) { fired = true; if (first_ms < 0) first_ms = d.mono_ms; }
    }
    printf("  case %-34s fall=%s first=%lldms\n", name, fired ? "yes" : "no",
           (long long)first_ms);
    return fired;
}

static FallConfig base_cfg()
{
    FallConfig c;
    // 只测新增 collapse 路径；旧路径阈值保持 p1b 默认。
    c.collapse_enabled = true;
    return c;
}

int main()
{
    FallConfig cfg = base_cfg();
    const PersonObs stand = make_pose(250.f, 145.f, 40.f, 420.f);

    // 1) 竖向屈膝塌落：全程竖直、髋/肩快速下沉到地面层 → 必须以 collapse 路径检出
    {
        std::vector<FrameInput> fs;
        fs.push_back(frame(0, stand)); fs.push_back(frame(500, stand)); fs.push_back(frame(1000, stand));
        fs.push_back(frame(1500, make_pose(360.f, 255.f, 120.f, 340.f)));
        fs.push_back(frame(1800, make_pose(405.f, 300.f, 150.f, 320.f)));
        fs.push_back(frame(2100, make_pose(418.f, 310.f, 155.f, 320.f)));
        fs.push_back(frame(2600, make_pose(418.f, 310.f, 155.f, 320.f)));
        if (!run_case("vertical_collapse", cfg, fs)) g_fail++;
    }
    // 2) 朝镜头前倒：肩投影到髋下方（inversion）→ 检出
    {
        std::vector<FrameInput> fs;
        fs.push_back(frame(0, stand)); fs.push_back(frame(500, stand)); fs.push_back(frame(1000, stand));
        fs.push_back(frame(1250, make_pose(270.f, 200.f, 60.f, 420.f)));
        fs.push_back(frame(1500, make_pose(290.f, 280.f, 150.f, 340.f)));
        fs.push_back(frame(1750, make_pose(305.f, 330.f, 200.f, 300.f)));
        fs.push_back(frame(2000, make_pose(310.f, 345.f, 210.f, 300.f)));
        fs.push_back(frame(2400, make_pose(310.f, 345.f, 210.f, 300.f)));
        if (!run_case("forward_camera_fall", cfg, fs)) g_fail++;
    }
    // 3) 正常坐下（受控、慢）→ 不得误报
    {
        std::vector<FrameInput> fs;
        fs.push_back(frame(0, stand)); fs.push_back(frame(500, stand)); fs.push_back(frame(1000, stand));
        fs.push_back(frame(1500, make_pose(295.f, 190.f, 190.f, 360.f)));
        fs.push_back(frame(2000, make_pose(335.f, 232.f, 220.f, 330.f)));
        fs.push_back(frame(2600, make_pose(335.f, 232.f, 220.f, 330.f)));
        fs.push_back(frame(3200, make_pose(335.f, 232.f, 220.f, 330.f)));
        if (run_case("sit_down", cfg, fs)) g_fail++;
    }
    // 4) 快速深蹲到地面（受控减速：触底帧速度已低于 0.22/s）→ 不得误报
    {
        std::vector<FrameInput> fs;
        fs.push_back(frame(0, stand)); fs.push_back(frame(500, stand)); fs.push_back(frame(1000, stand));
        fs.push_back(frame(1250, make_pose(288.f, 188.f, 100.f, 380.f)));
        fs.push_back(frame(1500, make_pose(322.f, 222.f, 130.f, 380.f)));
        fs.push_back(frame(1750, make_pose(346.f, 246.f, 150.f, 380.f)));
        fs.push_back(frame(2000, make_pose(365.f, 261.f, 165.f, 380.f)));
        fs.push_back(frame(2250, make_pose(379.f, 271.f, 175.f, 380.f)));
        fs.push_back(frame(2500, make_pose(389.f, 277.f, 180.f, 380.f)));
        fs.push_back(frame(2750, make_pose(392.f, 279.f, 182.f, 380.f)));
        fs.push_back(frame(3500, make_pose(392.f, 279.f, 182.f, 380.f)));
        if (run_case("fast_controlled_crouch", cfg, fs)) g_fail++;
    }
    // 5) 一直站立 → 不得误报
    {
        std::vector<FrameInput> fs;
        for (int i = 0; i < 12; i++) fs.push_back(frame(i * 500, stand));
        if (run_case("standing_only", cfg, fs)) g_fail++;
    }
    // 6) 已经躺在地上（无近期的站立基线/快速下降）→ 不得误报
    {
        std::vector<FrameInput> fs;
        PersonObs lying = make_pose(410.f, 410.f, 380.f, 60.f);
        for (int i = 0; i < 12; i++) fs.push_back(frame(i * 500, lying));
        if (run_case("already_lying", cfg, fs)) g_fail++;
    }

    printf("{\"host_selftest\":\"p1b-collapse-draft\",\"failures\":%d}\n", g_fail);
    return g_fail == 0 ? 0 : 1;
}
'''


def main():
    check_only = "--check" in sys.argv[1:]
    header = open(os.path.join(SRC, "fall_core.h"), encoding="utf-8").read()
    cpp = open(os.path.join(SRC, "fall_core.cpp"), encoding="utf-8").read()
    new_header = patch_header(header)
    new_cpp = patch_cpp(cpp)
    if check_only:
        print("[make_draft] all anchors found")
        return 0
    os.makedirs(DRAFT, exist_ok=True)
    with open(os.path.join(DRAFT, "fall_core.h"), "w", encoding="utf-8", newline="\n") as fh:
        fh.write(new_header)
    with open(os.path.join(DRAFT, "fall_core.cpp"), "w", encoding="utf-8", newline="\n") as fh:
        fh.write(new_cpp)
    with open(os.path.join(DRAFT, "host_selftest.cpp"), "w", encoding="utf-8", newline="\n") as fh:
        fh.write(HOST_SELFTEST)
    print("[make_draft] wrote", DRAFT)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
