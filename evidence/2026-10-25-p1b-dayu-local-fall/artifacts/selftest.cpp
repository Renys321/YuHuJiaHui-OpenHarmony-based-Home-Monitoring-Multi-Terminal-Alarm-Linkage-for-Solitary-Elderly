// Deterministic fixture/time tests for the P1-B fall core (no camera, no model).
// Run on the board: ./dayu_local_fall --selftest
#include "fall_core.h"

#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

using namespace p1b;

static int g_fail = 0;
static int g_cases = 0;

static bool contains(const std::vector<std::string>& v, const char* s)
{
    for (size_t i = 0; i < v.size(); i++) if (v[i] == s) return true;
    return false;
}

static bool contains_sub(const std::vector<std::string>& v, const char* s)
{
    for (size_t i = 0; i < v.size(); i++) if (v[i].find(s) != std::string::npos) return true;
    return false;
}

static void check(bool ok, const char* what)
{
    if (!ok)
    {
        g_fail++;
        printf("    check failed: %s\n", what);
    }
}

static PersonObs make_pose(float bx, float by, float bw, float bh, float sh_y, float hip_y, float knee_y,
                           float ankle_y, float torso_dx, float conf = 0.90f)
{
    PersonObs p;
    p.x = bx; p.y = by; p.w = bw; p.h = bh; p.conf = 0.92f;
    const float cx = bx + bw * 0.5f;
    const float shx = cx + torso_dx;
    for (int i = 0; i < kNumKpts; i++) { p.kpts[i].x = cx; p.kpts[i].y = hip_y; p.kpts[i].conf = conf; }
    p.kpts[0].x = shx; p.kpts[0].y = sh_y - 0.08f * bh;       // nose
    p.kpts[1].x = shx - 0.04f * bw; p.kpts[1].y = sh_y - 0.11f * bh; // eyes
    p.kpts[2].x = shx + 0.04f * bw; p.kpts[2].y = sh_y - 0.11f * bh;
    p.kpts[3].x = shx - 0.06f * bw; p.kpts[3].y = sh_y - 0.10f * bh;
    p.kpts[4].x = shx + 0.06f * bw; p.kpts[4].y = sh_y - 0.10f * bh;
    p.kpts[5].x = shx - 0.18f * bw; p.kpts[5].y = sh_y;       // shoulders
    p.kpts[6].x = shx + 0.18f * bw; p.kpts[6].y = sh_y;
    p.kpts[7].x = shx - 0.24f * bw; p.kpts[7].y = (sh_y + hip_y) * 0.5f;
    p.kpts[8].x = shx + 0.24f * bw; p.kpts[8].y = (sh_y + hip_y) * 0.5f;
    p.kpts[9].x = shx - 0.25f * bw; p.kpts[9].y = hip_y - 0.04f * bh;
    p.kpts[10].x = shx + 0.25f * bw; p.kpts[10].y = hip_y - 0.04f * bh;
    p.kpts[11].x = cx - 0.10f * bw; p.kpts[11].y = hip_y;     // hips
    p.kpts[12].x = cx + 0.10f * bw; p.kpts[12].y = hip_y;
    p.kpts[13].x = cx - 0.11f * bw; p.kpts[13].y = knee_y;    // knees
    p.kpts[14].x = cx + 0.11f * bw; p.kpts[14].y = knee_y;
    p.kpts[15].x = cx - 0.11f * bw; p.kpts[15].y = ankle_y;   // ankles
    p.kpts[16].x = cx + 0.11f * bw; p.kpts[16].y = ankle_y;
    return p;
}

static PersonObs make_horizontal(float bx, float by, float bw, float bh, float conf = 0.90f)
{
    PersonObs p;
    p.x = bx; p.y = by; p.w = bw; p.h = bh; p.conf = 0.94f;
    const float cy = by + bh * 0.55f;
    for (int i = 0; i < kNumKpts; i++) { p.kpts[i].x = bx + bw * 0.5f; p.kpts[i].y = cy; p.kpts[i].conf = conf; }
    p.kpts[0].x = bx + 0.90f * bw; p.kpts[0].y = cy - 0.05f * bh;
    p.kpts[5].x = bx + 0.72f * bw; p.kpts[5].y = cy - 0.02f * bh;
    p.kpts[6].x = bx + 0.76f * bw; p.kpts[6].y = cy + 0.02f * bh;
    p.kpts[7].x = bx + 0.60f * bw; p.kpts[7].y = cy; p.kpts[8].x = bx + 0.66f * bw; p.kpts[8].y = cy;
    p.kpts[9].x = bx + 0.48f * bw; p.kpts[9].y = cy; p.kpts[10].x = bx + 0.54f * bw; p.kpts[10].y = cy;
    p.kpts[11].x = bx + 0.38f * bw; p.kpts[11].y = cy;
    p.kpts[12].x = bx + 0.42f * bw; p.kpts[12].y = cy;
    p.kpts[13].x = bx + 0.24f * bw; p.kpts[13].y = cy + 0.02f * bh;
    p.kpts[14].x = bx + 0.28f * bw; p.kpts[14].y = cy + 0.02f * bh;
    p.kpts[15].x = bx + 0.08f * bw; p.kpts[15].y = cy + 0.03f * bh;
    p.kpts[16].x = bx + 0.12f * bw; p.kpts[16].y = cy + 0.03f * bh;
    return p;
}

static PersonObs make_bad_kpts(float bx, float by, float bw, float bh)
{
    PersonObs p;
    p.x = bx; p.y = by; p.w = bw; p.h = bh; p.conf = 0.90f;
    for (int i = 0; i < kNumKpts; i++) { p.kpts[i].x = bx + bw * 0.5f; p.kpts[i].y = by + bh * 0.5f; p.kpts[i].conf = 0.05f; }
    return p;
}

static FrameInput frame(int64_t t, std::vector<PersonObs> persons)
{
    FrameInput f;
    f.mono_ms = t;
    f.data_valid = true;
    f.img_w = 720;
    f.img_h = 1280;
    f.persons = persons;
    return f;
}

static FrameInput invalid_frame(int64_t t, const char* err)
{
    FrameInput f;
    f.mono_ms = t;
    f.data_valid = false;
    f.error = err;
    f.img_w = 720;
    f.img_h = 1280;
    return f;
}

static std::vector<FallDecision> run(FallEngine& e, const std::vector<FrameInput>& frames)
{
    std::vector<FallDecision> out;
    for (size_t i = 0; i < frames.size(); i++) out.push_back(e.process(frames[i]));
    return out;
}

static const char* last_posture(const std::vector<FallDecision>& d)
{
    return d.empty() ? "EMPTY" : posture_name(d.back().posture);
}

static void emit_case(const char* name, bool pass)
{
    g_cases++;
    printf("{\"case\":\"%s\",\"pass\":%s}\n", name, pass ? "true" : "false");
}

static void case_standing()
{
    int before = g_fail;
    FallEngine e;
    std::vector<FrameInput> fs;
    for (int i = 0; i < 8; i++)
        fs.push_back(frame(1000 + i * 500, {make_pose(200, 250, 300, 800, 430, 680, 900, 1080, 0)}));
    std::vector<FallDecision> d = run(e, fs);
    check(std::string(last_posture(d)) == "UPRIGHT", "standing posture");
    check(d.back().fall == false, "standing no fall");
    check(d.back().fall_evaluated == true, "standing evaluated");
    check(d.back().state == FallState::MONITORING, "standing monitoring");
    emit_case("standing_stable", g_fail == before);
}

static void case_sitting()
{
    int before = g_fail;
    FallEngine e;
    std::vector<FrameInput> fs;
    for (int i = 0; i < 8; i++)
        fs.push_back(frame(1000 + i * 500, {make_pose(200, 500, 300, 600, 620, 820, 830, 1030, 0)}));
    std::vector<FallDecision> d = run(e, fs);
    check(std::string(last_posture(d)) == "SITTING_OR_CROUCHING", "sitting posture");
    check(d.back().fall == false, "sitting no fall");
    emit_case("sitting", g_fail == before);
}

static void case_bending()
{
    int before = g_fail;
    FallEngine e;
    std::vector<FrameInput> fs;
    for (int i = 0; i < 6; i++)
        fs.push_back(frame(1000 + i * 500, {make_pose(200, 450, 300, 700, 650, 800, 980, 1090, 150)}));
    std::vector<FallDecision> d = run(e, fs);
    check(std::string(last_posture(d)) == "TRANSITION", "bending transition");
    check(d.back().fall == false, "bending no fall");
    emit_case("bending", g_fail == before);
}

static void case_squatting()
{
    int before = g_fail;
    FallEngine e;
    std::vector<FrameInput> fs;
    for (int i = 0; i < 8; i++)
        fs.push_back(frame(1000 + i * 500, {make_pose(200, 550, 300, 550, 650, 880, 900, 1060, 0)}));
    std::vector<FallDecision> d = run(e, fs);
    check(std::string(last_posture(d)) == "SITTING_OR_CROUCHING", "squat posture");
    check(d.back().fall == false, "squat no fall");
    emit_case("squatting", g_fail == before);
}

static void case_slow_lying()
{
    int before = g_fail;
    FallEngine e;
    std::vector<FrameInput> fs;
    for (int i = 0; i <= 12; i++)
    {
        float k = i / 12.f;
        float hip = 680 + k * 280;       // 0.28 H over 6s => ~0.047 H/s
        float sh = 430 + k * 300;
        float knee = 900 - k * 120;
        float ankle = 1080 - k * 60;
        float bw = 300 + k * 220;
        float bh = 800 - k * 380;
        bool horiz = k > 0.80f;
        PersonObs p = horiz ? make_horizontal(120, 560, 520, 260) : make_pose(200, 250 + k * 200, bw, bh, sh, hip, knee, ankle, 0);
        fs.push_back(frame(1000 + i * 500, {p}));
    }
    std::vector<FallDecision> d = run(e, fs);
    check(d.back().fall == false, "slow lying no fall");
    check(std::string(last_posture(d)) == "HORIZONTAL", "slow lying final horizontal posture");
    check(d.back().state == FallState::MONITORING, "slow lying not confirmed");
    check(contains_sub(d.back().reason_codes, "HORIZONTAL_WITHOUT_DESCENT"), "slow lying reason");
    emit_case("slow_lying", g_fail == before);
}

static void case_fast_descent_recovery()
{
    int before = g_fail;
    FallEngine e;
    std::vector<FrameInput> fs;
    fs.push_back(frame(1000, {make_pose(200, 250, 300, 800, 430, 680, 900, 1080, 0)}));
    fs.push_back(frame(1500, {make_pose(200, 250, 300, 800, 430, 680, 900, 1080, 0)}));
    // rapid hip drop: 0.30 H in 500 ms => 0.60 image-heights/s
    fs.push_back(frame(2000, {make_pose(200, 380, 300, 800, 560, 1060, 1100, 1160, 40)}));
    fs.push_back(frame(2500, {make_pose(200, 250, 300, 800, 430, 680, 900, 1080, 0)}));
    fs.push_back(frame(3000, {make_pose(200, 250, 300, 800, 430, 680, 900, 1080, 0)}));
    fs.push_back(frame(3500, {make_pose(200, 250, 300, 800, 430, 680, 900, 1080, 0)}));
    std::vector<FallDecision> d = run(e, fs);
    bool saw_descent = false;
    for (size_t i = 0; i < d.size(); i++) if (d[i].state == FallState::DESCENT_CANDIDATE) saw_descent = true;
    check(saw_descent, "descent candidate seen");
    check(!d.back().fall, "fast descent recovery no fall");
    check(d.back().state == FallState::MONITORING, "fast descent recovery monitoring");
    bool saw_cancel = false;
    for (size_t i = 0; i < d.size(); i++) if (contains_sub(d[i].reason_codes, "CANCELLED")) saw_cancel = true;
    check(saw_cancel, "fast descent recovery cancel reason");
    emit_case("fast_descent_recovery", g_fail == before);
}

static void case_fast_descent_persistent()
{
    int before = g_fail;
    FallEngine e;
    std::vector<FrameInput> fs;
    fs.push_back(frame(1000, {make_pose(200, 250, 300, 800, 430, 680, 900, 1080, 0)}));
    fs.push_back(frame(1500, {make_pose(200, 250, 300, 800, 430, 680, 900, 1080, 0)}));
    fs.push_back(frame(2000, {make_pose(200, 380, 300, 800, 560, 1060, 1100, 1160, 40)}));
    for (int i = 0; i < 8; i++) fs.push_back(frame(2500 + i * 500, {make_horizontal(120, 560, 520, 260)}));
    std::vector<FallDecision> d = run(e, fs);
    int fall_events = 0;
    std::string id;
    size_t confirm_idx = 0;
    for (size_t i = 0; i < d.size(); i++)
    {
        if (d[i].fall)
        {
            fall_events++;
            id = d[i].fall_event_id;
            confirm_idx = i;
        }
    }
    check(fall_events == 1, "exactly one fall confirmation event");
    check(!id.empty(), "fall event id non-empty");
    check(confirm_idx > 0 && d[confirm_idx].state == FallState::FALL_CONFIRMED, "fall state confirmed at event");
    // no repeated FALL events afterwards; same event id retained
    for (size_t i = confirm_idx + 1; i < d.size(); i++)
    {
        check(d[i].fall == false, "no repeated fall=true after confirmation");
        check(d[i].state == FallState::FALL_CONFIRMED, "persistent confirmed state");
        check(d[i].fall_event_id == id, "same fall event id");
    }
    emit_case("fast_descent_persistent_horizontal", g_fail == before);
}

static void case_kpt_loss()
{
    int before = g_fail;
    FallEngine e;
    std::vector<FrameInput> fs;
    for (int i = 0; i < 3; i++)
        fs.push_back(frame(1000 + i * 500, {make_pose(200, 250, 300, 800, 430, 680, 900, 1080, 0)}));
    fs.push_back(frame(2500, {make_bad_kpts(200, 250, 300, 800)}));
    std::vector<FallDecision> d = run(e, fs);
    check(std::string(posture_name(d.back().posture)) == "UPRIGHT", "kpt loss within grace keeps last posture");
    check(d.back().fall_evaluated == false, "kpt loss not evaluated");
    fs.clear();
    FallEngine e2;
    for (int i = 0; i < 3; i++)
        fs.push_back(frame(1000 + i * 500, {make_pose(200, 250, 300, 800, 430, 680, 900, 1080, 0)}));
    fs.push_back(frame(2500, {make_bad_kpts(200, 250, 300, 800)}));
    fs.push_back(frame(4000, {make_bad_kpts(200, 250, 300, 800)}));
    std::vector<FallDecision> d2 = run(e2, fs);
    check(std::string(posture_name(d2.back().posture)) == "UNKNOWN", "kpt loss beyond grace UNKNOWN");
    check(d2.back().fall_evaluated == false, "kpt loss beyond grace not evaluated");
    check(d2.back().fall == false, "kpt loss no fall");
    emit_case("kpt_loss_grace", g_fail == before);
}

static void case_invalid_inputs()
{
    int before = g_fail;
    FallEngine e;
    std::vector<FrameInput> fs;
    fs.push_back(invalid_frame(1000, "camera_invalid"));
    fs.push_back(invalid_frame(1500, "inference_extract_failed"));
    std::vector<FallDecision> d = run(e, fs);
    for (size_t i = 0; i < d.size(); i++)
    {
        check(d[i].data_valid == false, "invalid data marked invalid");
        check(d[i].person_count == -1, "invalid data personCount -1");
        check(d[i].posture == Posture::UNKNOWN, "invalid data posture UNKNOWN");
        check(d[i].fall_evaluated == false, "invalid data fallEvaluated false");
        check(d[i].fall == false, "invalid data fall false");
    }
    emit_case("camera_and_inference_invalid", g_fail == before);
}

static void case_multi_person()
{
    int before = g_fail;
    FallEngine e;
    std::vector<FrameInput> fs;
    PersonObs a = make_pose(80, 250, 300, 800, 430, 680, 900, 1080, 0);   // large/left, primary
    PersonObs b = make_pose(430, 430, 200, 520, 560, 760, 940, 1090, 0);  // smaller/right
    for (int i = 0; i < 4; i++) fs.push_back(frame(1000 + i * 500, {a, b}));
    fs.push_back(frame(3000, {b})); // A lost, B continues -> primary lost grace, no switch
    fs.push_back(frame(4500, {b})); // beyond grace -> switch to B
    fs.push_back(frame(5000, {b}));
    std::vector<FallDecision> d = run(e, fs);
    bool saw_switch = false;
    bool saw_switch_reason = false;
    for (size_t i = 0; i < d.size(); i++)
    {
        if (d[i].track_switched) saw_switch = true;
        if (contains_sub(d[i].reason_codes, "TRACK_SWITCH")) saw_switch_reason = true;
    }
    check(d.back().fall == false, "multi person no fall");
    check(saw_switch, "multi person switch flagged");
    check(saw_switch_reason, "switch reason");
    emit_case("multi_person_primary_switch", g_fail == before);
}

static void case_single_horizontal()
{
    int before = g_fail;
    FallEngine e;
    std::vector<FrameInput> fs;
    fs.push_back(frame(1000, {make_horizontal(120, 560, 520, 260)}));
    std::vector<FallDecision> d = run(e, fs);
    check(d.back().fall == false, "single horizontal no fall");
    check(d.back().state != FallState::FALL_CONFIRMED, "single horizontal not confirmed");
    emit_case("single_frame_horizontal_not_fall", g_fail == before);
}

static void case_recovery_new_event()
{
    int before = g_fail;
    FallEngine e;
    std::vector<FrameInput> fs;
    fs.push_back(frame(1000, {make_pose(200, 250, 300, 800, 430, 680, 900, 1080, 0)}));
    fs.push_back(frame(1500, {make_pose(200, 250, 300, 800, 430, 680, 900, 1080, 0)}));
    fs.push_back(frame(2000, {make_pose(200, 380, 300, 800, 560, 1060, 1100, 1160, 40)}));
    for (int i = 0; i < 8; i++) fs.push_back(frame(2500 + i * 500, {make_horizontal(120, 560, 520, 260)}));
    // recovery upright
    for (int i = 0; i < 3; i++) fs.push_back(frame(6500 + i * 500, {make_pose(200, 250, 300, 800, 430, 680, 900, 1080, 0)}));
    // new fall: reset history with enough baseline, then fast descent + persistent horizontal
    for (int i = 0; i < 2; i++) fs.push_back(frame(8000 + i * 500, {make_pose(200, 250, 300, 800, 430, 680, 900, 1080, 0)}));
    fs.push_back(frame(9000, {make_pose(200, 380, 300, 800, 560, 1060, 1100, 1160, 40)}));
    for (int i = 0; i < 8; i++) fs.push_back(frame(9500 + i * 500, {make_horizontal(120, 560, 520, 260)}));
    std::vector<FallDecision> d = run(e, fs);
    std::vector<std::string> ids;
    for (size_t i = 0; i < d.size(); i++) if (d[i].fall) ids.push_back(d[i].fall_event_id);
    check(ids.size() == 2, "two distinct fall episodes");
    check(ids.size() == 2 && ids[0] != ids[1], "new event id after recovery");
    bool recovered = false;
    for (size_t i = 0; i < d.size(); i++) if (d[i].event_type == "RECOVERED" && d[i].recovered) recovered = true;
    check(recovered, "recovered event present");
    emit_case("recovery_then_new_event", g_fail == before);
}

static void case_no_person_and_time()
{
    int before = g_fail;
    FallEngine e;
    std::vector<FrameInput> fs;
    fs.push_back(frame(1000, {}));
    std::vector<FallDecision> d = run(e, fs);
    check(d.back().person_count == 0, "valid no-person count 0");
    check(d.back().posture == Posture::NO_PERSON, "valid no-person posture");
    check(d.back().fall == false, "valid no-person no fall");
    check(d.back().fall_evaluated == false, "valid no-person not evaluated as safe");

    FallEngine e2;
    std::vector<FrameInput> fs2;
    fs2.push_back(frame(1000, {make_pose(200, 250, 300, 800, 430, 680, 900, 1080, 0)}));
    fs2.push_back(frame(500, {make_pose(200, 250, 300, 800, 430, 680, 900, 1080, 0)}));
    std::vector<FallDecision> d2 = run(e2, fs2);
    check(d2.back().data_valid == false, "non-monotonic rejected");
    check(contains_sub(d2.back().reason_codes, "NON_MONOTONIC_TIME"), "non-monotonic reason");
    emit_case("no_person_and_non_monotonic_time", g_fail == before);
}

int run_selftest()
{
    printf("{\"selftest\":\"p1b-fall-core\",\"version\":\"%s\"}\n", "p1b-2026-10-25");
    case_standing();
    case_sitting();
    case_bending();
    case_squatting();
    case_slow_lying();
    case_fast_descent_recovery();
    case_fast_descent_persistent();
    case_kpt_loss();
    case_invalid_inputs();
    case_multi_person();
    case_single_horizontal();
    case_recovery_new_event();
    case_no_person_and_time();
    printf("{\"summary\":{\"cases\":%d,\"failures\":%d,\"pass\":%s}}\n", g_cases, g_fail,
           g_fail == 0 ? "true" : "false");
    return g_fail == 0 ? 0 : 1;
}




