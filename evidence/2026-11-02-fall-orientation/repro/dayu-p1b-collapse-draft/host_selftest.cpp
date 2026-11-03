// Host-side unit test for the 2026-11-02 collapse draft (x86, no ncnn/camera).
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
