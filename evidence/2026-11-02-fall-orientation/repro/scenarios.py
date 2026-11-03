"""scenarios.py — 合成 COCO-17 关键点序列，覆盖跌倒方向鲁棒性 4 类场景。

重要声明：这些是**合成数据**（按 2D 图像投影 + 自由落体/受控动作的时间曲线手工构造），
不是真机录像、也不是真人跌倒。用途是构造可复现的"帧级判定链路"实验：
  1) side_fall_180     180° 侧倒/躺平（现有实现可检出，必须保持）
  2) vertical_buckle   直上直下屈膝下坠（竖向；现有实现漏检）
  3) forward_camera    朝摄像头方向前倒（透视压缩，投影仍近似竖直；现有实现漏检）
  4) sit/crouch/bend   坐下、蹲下、弯腰、缓慢躺下、已躺卧（不得误报）
  5) stress_fast_crouch 快速深蹲到地面（对抗性边界，用于量化残余误报风险）

坐标约定：关键点/人体框为**像素坐标**（与 Ultralytics YOLO 输出一致），
由 `PoseFrame.from_coco` 归一化；y 轴向下。时间单位为毫秒。

每个 scenario 的 keyframe 只描述 7 个主关节（hip/shoulder/nose/双膝/双踝），
其余 10 个 COCO 点由躯干方向解析派生（肩宽/髋宽/手臂随躯干旋转），
人体框由全部关键点外接框 + 固定边距生成，模拟检测器输出。
"""
from __future__ import annotations

import math
import random
from dataclasses import dataclass, field
from typing import Dict, List, Tuple

Point = Tuple[float, float]


@dataclass(frozen=True)
class Joints:
    hip: Point
    shoulder: Point
    nose: Point
    knee_l: Point
    knee_r: Point
    ankle_l: Point
    ankle_r: Point


@dataclass
class Scenario:
    name: str
    category: str          # positive / negative / boundary
    expected_fall: bool
    description: str
    keyframes: List[Tuple[int, Joints]]   # (ts_ms, joints) — 线性插值
    hold_until_ms: int
    motion_start_ms: int   # 用于计算检出门限延迟


@dataclass
class FrameSpec:
    ts_ms: int
    bbox_xyxy: Tuple[float, float, float, float]
    keypoints_xyc: List[List[float]]
    pose_confidence: float = 0.9


# ---------------------------------------------------------------------------
# 基础站姿（640x480 参考坐标；实际输出按目标分辨率缩放）
# ---------------------------------------------------------------------------
def standing() -> Joints:
    return Joints(
        hip=(320.0, 250.0), shoulder=(320.0, 145.0), nose=(320.0, 70.0),
        knee_l=(302.0, 345.0), knee_r=(338.0, 345.0),
        ankle_l=(300.0, 440.0), ankle_r=(340.0, 440.0),
    )


def _rotate(vec: Point, deg: float) -> Point:
    rad = math.radians(deg)
    return (vec[0] * math.cos(rad) - vec[1] * math.sin(rad),
            vec[0] * math.sin(rad) + vec[1] * math.cos(rad))


def _add(a: Point, b: Point) -> Point:
    return (a[0] + b[0], a[1] + b[1])


def _lerp(a: Point, b: Point, t: float) -> Point:
    return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)


def _joints_lerp(a: Joints, b: Joints, t: float) -> Joints:
    return Joints(
        hip=_lerp(a.hip, b.hip, t), shoulder=_lerp(a.shoulder, b.shoulder, t),
        nose=_lerp(a.nose, b.nose, t),
        knee_l=_lerp(a.knee_l, b.knee_l, t), knee_r=_lerp(a.knee_r, b.knee_r, t),
        ankle_l=_lerp(a.ankle_l, b.ankle_l, t), ankle_r=_lerp(a.ankle_r, b.ankle_r, t),
    )


def interpolate(keyframes: List[Tuple[int, Joints]], ts: int) -> Joints:
    if ts <= keyframes[0][0]:
        return keyframes[0][1]
    for (t0, j0), (t1, j1) in zip(keyframes, keyframes[1:]):
        if t0 <= ts <= t1:
            span = max(1, t1 - t0)
            return _joints_lerp(j0, j1, (ts - t0) / span)
    return keyframes[-1][1]


def joints_to_coco(j: Joints) -> List[List[float]]:
    """由 7 个主关节派生 17 个 COCO 关键点（像素坐标, conf=0.92）。"""
    torso = (j.hip[0] - j.shoulder[0], j.hip[1] - j.shoulder[1])
    length = math.hypot(*torso) or 1.0
    # 躯干方向的垂直单位向量（图像坐标）
    perp = (-torso[1] / length, torso[0] / length)

    def off(base: Point, along: float, across: float) -> Point:
        return (base[0] + torso[0] * along + perp[0] * across,
                base[1] + torso[1] * along + perp[1] * across)

    pts: List[Point] = []
    # 0 nose, 1/2 eyes, 3/4 ears
    pts.append(j.nose)
    pts.append((j.nose[0] - 9.0, j.nose[1] - 8.0))
    pts.append((j.nose[0] + 9.0, j.nose[1] - 8.0))
    pts.append((j.nose[0] - 20.0, j.nose[1] + 2.0))
    pts.append((j.nose[0] + 20.0, j.nose[1] + 2.0))
    # 5/6 shoulders
    pts.append((j.shoulder[0] + perp[0] * 30.0, j.shoulder[1] + perp[1] * 30.0))
    pts.append((j.shoulder[0] - perp[0] * 30.0, j.shoulder[1] - perp[1] * 30.0))
    # 7/8 elbows, 9/10 wrists（沿躯干方向垂下，随躯干旋转）
    pts.append(off(j.shoulder, 0.42, 34.0))
    pts.append(off(j.shoulder, 0.42, -34.0))
    pts.append(off(j.shoulder, 0.78, 42.0))
    pts.append(off(j.shoulder, 0.78, -42.0))
    # 11/12 hips
    pts.append((j.hip[0] + perp[0] * 20.0, j.hip[1] + perp[1] * 20.0))
    pts.append((j.hip[0] - perp[0] * 20.0, j.hip[1] - perp[1] * 20.0))
    # 13/14 knees, 15/16 ankles（显式给定；左右按 x 排序）
    kl, kr = sorted([j.knee_l, j.knee_r], key=lambda p: p[0])
    al, ar = sorted([j.ankle_l, j.ankle_r], key=lambda p: p[0])
    pts.extend([kl, kr, al, ar])
    return [[round(x, 2), round(y, 2), 0.92] for (x, y) in pts]


def coco_to_bbox(points: List[List[float]], width: int, height: int) -> Tuple[float, float, float, float]:
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    x_span = max(xs) - min(xs)
    y_span = max(ys) - min(ys)
    # 边距按分辨率缩放，保证 640x480 与 320x240 的框形状一致（避免缩放伪影）。
    pad_x = 10.0 * (width / 640.0)
    pad_y = 6.0 * (height / 480.0)
    x1 = min(xs) - 0.12 * x_span - pad_x
    x2 = max(xs) + 0.12 * x_span + pad_x
    y1 = min(ys) - 0.05 * y_span - pad_y
    y2 = max(ys) + 0.05 * y_span + pad_y
    x1, x2 = max(0.0, x1), min(float(width), x2)
    y1, y2 = max(0.0, y1), min(float(height), y2)
    return (x1, y1, x2, y2)


def render(scenario: Scenario, width: int = 640, height: int = 480, fps: float = 4.0,
           noise_px: float = 1.0, seed: int = 7) -> List[FrameSpec]:
    """把 scenario 渲染成逐帧检测器输出（带可复现的轻微关键点抖动）。"""
    rng = random.Random(seed)
    sx, sy = width / 640.0, height / 480.0
    frame_ms = 1000.0 / fps
    count = int(round(scenario.hold_until_ms / frame_ms)) + 1
    frames: List[FrameSpec] = []
    for i in range(count):
        ts = int(round(i * frame_ms))
        j = interpolate(scenario.keyframes, ts)          # 参考坐标 640x480
        kpts = joints_to_coco(j)                         # 参考像素派生 17 点
        kpts = [[p[0] * sx, p[1] * sy, p[2]] for p in kpts]
        if noise_px > 0:
            # 抖动按分辨率缩放，保证 640 与 320 的相对噪声一致
            nx = noise_px * sx
            ny = noise_px * sy
            kpts = [[p[0] + rng.gauss(0, nx), p[1] + rng.gauss(0, ny), p[2]]
                    for p in kpts]
        bbox = coco_to_bbox(kpts, width, height)
        frames.append(FrameSpec(ts, bbox, kpts))
    return frames


# ---------------------------------------------------------------------------
# 场景定义（参考分辨率 640x480，时间基准 ms）
# ---------------------------------------------------------------------------
def _hold(frames, until):
    return frames + [(until, frames[-1][1])]


def scenario_side_fall_180() -> Scenario:
    s = standing()
    kf = [
        (0, s), (1000, s),
        (1250, Joints(hip=(320, 300), shoulder=(372, 209), nose=(410, 144),
                      knee_l=(320, 360), knee_r=(340, 360), ankle_l=(320, 430), ankle_r=(345, 430))),
        (1500, Joints(hip=(340, 380), shoulder=(439, 344), nose=(509, 318),
                      knee_l=(350, 415), knee_r=(360, 415), ankle_l=(355, 445), ankle_r=(365, 445))),
        (1750, Joints(hip=(350, 410), shoulder=(455, 410), nose=(530, 410),
                      knee_l=(360, 420), knee_r=(370, 420), ankle_l=(365, 445), ankle_r=(375, 445))),
    ]
    kf = _hold(kf, 3500)
    return Scenario("side_fall_180", "positive", True,
                    "180° 侧倒/躺平：躯干在图像平面旋转到 ~90° 并落地（现有实现可检出的正例）",
                    kf, 3500, 1000)


def scenario_vertical_buckle() -> Scenario:
    s = standing()
    kf = [
        (0, s), (1000, s),
        (1250, Joints(hip=(320, 300), shoulder=(320, 195), nose=(320, 120),
                      knee_l=(302, 390), knee_r=(338, 390), ankle_l=(300, 440), ankle_r=(340, 440))),
        (1500, Joints(hip=(320, 360), shoulder=(320, 255), nose=(320, 180),
                      knee_l=(290, 415), knee_r=(350, 415), ankle_l=(300, 442), ankle_r=(340, 442))),
        (1750, Joints(hip=(320, 405), shoulder=(320, 300), nose=(320, 225),
                      knee_l=(270, 428), knee_r=(370, 428), ankle_l=(300, 442), ankle_r=(340, 442))),
        (2000, Joints(hip=(320, 418), shoulder=(320, 310), nose=(320, 235),
                      knee_l=(270, 432), knee_r=(370, 432), ankle_l=(300, 442), ankle_r=(340, 442))),
    ]
    kf = _hold(kf, 3500)
    return Scenario("vertical_buckle", "positive", True,
                    "直上直下屈膝下坠：躯干全程竖直（torso≈0°），髋/肩快速整体下沉并停在地面层（竖向跌倒）",
                    kf, 3500, 1000)


def scenario_forward_camera() -> Scenario:
    s = standing()
    kf = [
        (0, s), (1000, s),
        (1250, Joints(hip=(320, 270), shoulder=(320, 200), nose=(320, 150),
                      knee_l=(320, 350), knee_r=(340, 350), ankle_l=(320, 435), ankle_r=(345, 435))),
        (1500, Joints(hip=(320, 290), shoulder=(320, 280), nose=(320, 320),
                      knee_l=(320, 360), knee_r=(345, 360), ankle_l=(310, 425), ankle_r=(350, 425))),
        (1750, Joints(hip=(320, 305), shoulder=(320, 330), nose=(320, 360),
                      knee_l=(320, 375), knee_r=(345, 375), ankle_l=(300, 425), ankle_r=(350, 425))),
        (2000, Joints(hip=(320, 310), shoulder=(320, 345), nose=(320, 370),
                      knee_l=(320, 378), knee_r=(345, 378), ankle_l=(300, 425), ankle_r=(350, 425))),
    ]
    kf = _hold(kf, 3500)
    return Scenario("forward_camera_fall", "positive", True,
                    "朝摄像头方向前倒：透视压缩后肩中心投影到髋下方（shoulder_hip_dy<0），"
                    "躯干投影角≈0°、框仍偏竖（前向跌倒；约 1s 完成，覆盖 2 FPS 采样）",
                    kf, 3500, 1000)


def scenario_sit_down() -> Scenario:
    s = standing()
    kf = [
        (0, s), (1000, s),
        (1250, Joints(hip=(320, 272), shoulder=(320, 167), nose=(320, 92),
                      knee_l=(310, 350), knee_r=(330, 350), ankle_l=(300, 440), ankle_r=(340, 440))),
        (1500, Joints(hip=(320, 295), shoulder=(320, 190), nose=(320, 115),
                      knee_l=(305, 358), knee_r=(335, 358), ankle_l=(300, 440), ankle_r=(340, 440))),
        (1750, Joints(hip=(320, 315), shoulder=(320, 210), nose=(320, 135),
                      knee_l=(302, 368), knee_r=(338, 368), ankle_l=(300, 440), ankle_r=(340, 440))),
        (2000, Joints(hip=(320, 335), shoulder=(320, 232), nose=(320, 157),
                      knee_l=(300, 378), knee_r=(340, 378), ankle_l=(300, 440), ankle_r=(340, 440))),
    ]
    kf = _hold(kf, 4500)
    return Scenario("negative_sit_down", "negative", False,
                    "正常坐下（受控下降，髋下沉≈0.18、峰值速度≈0.18/s，无地面冲击）",
                    kf, 4500, 1000)


def scenario_crouch_down() -> Scenario:
    s = standing()
    kf = [
        (0, s), (1000, s),
        (1250, Joints(hip=(320, 270), shoulder=(320, 175), nose=(320, 100),
                      knee_l=(290, 350), knee_r=(350, 350), ankle_l=(300, 440), ankle_r=(340, 440))),
        (1500, Joints(hip=(320, 290), shoulder=(320, 198), nose=(320, 123),
                      knee_l=(285, 360), knee_r=(355, 360), ankle_l=(300, 440), ankle_r=(340, 440))),
        (1750, Joints(hip=(320, 310), shoulder=(320, 220), nose=(320, 145),
                      knee_l=(280, 370), knee_r=(360, 370), ankle_l=(300, 440), ankle_r=(340, 440))),
        (2000, Joints(hip=(320, 330), shoulder=(320, 245), nose=(320, 170),
                      knee_l=(278, 380), knee_r=(362, 380), ankle_l=(300, 440), ankle_r=(340, 440))),
    ]
    kf = _hold(kf, 4500)
    return Scenario("negative_crouch_down", "negative", False,
                    "正常蹲下（受控，髋下沉≈0.17、峰值≈0.17/s）",
                    kf, 4500, 1000)


def scenario_bend_over() -> Scenario:
    s = standing()
    kf = [
        (0, s), (1000, s),
        (1250, Joints(hip=(320, 252), shoulder=(355, 195), nose=(420, 235),
                      knee_l=(302, 345), knee_r=(338, 345), ankle_l=(300, 440), ankle_r=(340, 440))),
        (1500, Joints(hip=(320, 255), shoulder=(395, 232), nose=(475, 268),
                      knee_l=(302, 345), knee_r=(338, 345), ankle_l=(300, 440), ankle_r=(340, 440))),
        (1750, Joints(hip=(320, 252), shoulder=(350, 190), nose=(410, 225),
                      knee_l=(302, 345), knee_r=(338, 345), ankle_l=(300, 440), ankle_r=(340, 440))),
        (2000, s),
    ]
    kf = _hold(kf, 4000)
    return Scenario("negative_bend_over", "negative", False,
                    "弯腰捡东西：躯干前倾到 ~50° 后恢复，髋部基本不下降（不得误报）",
                    kf, 4000, 1000)


def scenario_slow_lie_down() -> Scenario:
    s = standing()
    kf = [
        (0, s), (1000, s),
        (2000, Joints(hip=(320, 290), shoulder=(372, 199), nose=(410, 134),
                      knee_l=(315, 355), knee_r=(325, 355), ankle_l=(315, 435), ankle_r=(325, 435))),
        (3000, Joints(hip=(330, 330), shoulder=(413, 296), nose=(478, 260),
                      knee_l=(340, 390), knee_r=(350, 390), ankle_l=(340, 438), ankle_r=(350, 438))),
        (4000, Joints(hip=(340, 370), shoulder=(436, 367), nose=(510, 361),
                      knee_l=(350, 405), knee_r=(360, 405), ankle_l=(355, 442), ankle_r=(365, 442))),
        (5000, Joints(hip=(350, 410), shoulder=(455, 410), nose=(530, 410),
                      knee_l=(360, 420), knee_r=(370, 420), ankle_l=(365, 445), ankle_r=(375, 445))),
    ]
    kf = _hold(kf, 6500)
    return Scenario("negative_slow_lie_down", "boundary", False,
                    "缓慢躺下（髋部下降约 0.083/s）：baseline 与 patched 都会经**旧 horizontal 路径**"
                    "在 3.25s 触发（demo 调参 rapid_hip_drop=0.10 的历史副作用，非本补丁引入）；"
                    "列为 legacy 边界、不计入本补丁硬指标",
                    kf, 6500, 1000)


def scenario_already_lying() -> Scenario:
    lying = Joints(hip=(350, 410), shoulder=(455, 410), nose=(530, 410),
                   knee_l=(360, 420), knee_r=(370, 420),
                   ankle_l=(365, 445), ankle_r=(375, 445))
    kf = [(0, lying)]
    kf = _hold(kf, 3000)
    return Scenario("negative_already_lying", "negative", False,
                    "一开始就躺在地上（没有近期直立历史；不得误报）",
                    kf, 3000, 0)


def scenario_stress_fast_crouch() -> Scenario:
    """快速深蹲/快坐到地面的**物理合理版**：先快后减速，触底前已明显减速。

    2026-11-02 白天版此用例是"恒定 0.58/s 匀速下坠到地面"，那在物理上就是自由落体，
    与跌倒不可区分；真机 2026-11-02 的快速深蹲（18:26:06–18:26:41）全程 NORMAL，
    录到的下降是分段减速的。本版按受控减速重构：
      速度 0.32 → 0.28 → 0.20 → 0.17 → 0.12 → 0.08 → 0.04 /s，髋最终 0.82（≈地面层）。
    旧版恒速曲线保留为 `boundary_constant_speed_collapse`，作为"已知对抗性边界"单独报告。
    """
    s = standing()
    kf = [
        (0, s), (1000, s),
        (1250, Joints(hip=(320, 288), shoulder=(320, 188), nose=(320, 113),
                      knee_l=(292, 378), knee_r=(348, 378), ankle_l=(300, 440), ankle_r=(340, 440))),
        (1500, Joints(hip=(320, 322), shoulder=(320, 222), nose=(320, 147),
                      knee_l=(284, 400), knee_r=(356, 400), ankle_l=(300, 440), ankle_r=(340, 440))),
        (1750, Joints(hip=(320, 346), shoulder=(320, 246), nose=(320, 171),
                      knee_l=(278, 414), knee_r=(362, 414), ankle_l=(300, 440), ankle_r=(340, 440))),
        (2000, Joints(hip=(320, 365), shoulder=(320, 261), nose=(320, 186),
                      knee_l=(272, 422), knee_r=(368, 422), ankle_l=(300, 440), ankle_r=(340, 440))),
        (2250, Joints(hip=(320, 379), shoulder=(320, 271), nose=(320, 196),
                      knee_l=(268, 428), knee_r=(372, 428), ankle_l=(300, 440), ankle_r=(340, 440))),
        (2500, Joints(hip=(320, 389), shoulder=(320, 277), nose=(320, 202),
                      knee_l=(266, 432), knee_r=(374, 432), ankle_l=(300, 440), ankle_r=(340, 440))),
        (2750, Joints(hip=(320, 392), shoulder=(320, 279), nose=(320, 204),
                      knee_l=(266, 433), knee_r=(374, 433), ankle_l=(300, 440), ankle_r=(340, 440))),
    ]
    kf = _hold(kf, 5000)
    return Scenario("stress_fast_deep_crouch", "boundary", False,
                    "快速深蹲/快坐到地面（受控减速：0.32→0.28→0.20→0.17→0.12→0.08/s，髋到 0.82）；"
                    "硬指标：0 误报（离线边界风险；真机 2026-11-02 未复现）",
                    kf, 5000, 1000)


def scenario_boundary_constant_speed() -> Scenario:
    """旧版恒速塌落曲线：保留为**已知对抗性边界**，不列入"必须 0 误报"。

    恒定 0.58/s 下降到地面在物理上等同自由落体；若要求检测器同时"拒绝一切快速蹲坐"，
    就无法接受同样的运动曲线。仅用于记录残余风险，不作为验收项。
    """
    s = standing()
    kf = [
        (0, s), (1000, s),
        (1250, Joints(hip=(320, 320), shoulder=(320, 215), nose=(320, 140),
                      knee_l=(280, 380), knee_r=(360, 380), ankle_l=(300, 440), ankle_r=(340, 440))),
        (1500, Joints(hip=(320, 380), shoulder=(320, 275), nose=(320, 200),
                      knee_l=(260, 405), knee_r=(380, 405), ankle_l=(300, 440), ankle_r=(340, 440))),
        (1750, Joints(hip=(320, 385), shoulder=(320, 280), nose=(320, 205),
                      knee_l=(260, 408), knee_r=(380, 408), ankle_l=(300, 440), ankle_r=(340, 440))),
    ]
    kf = _hold(kf, 4000)
    return Scenario("boundary_constant_speed_collapse", "boundary", False,
                    "对抗性边界：恒速 0.58/s 塌落到地面（物理上≈自由落体）；记录残余风险，不作验收",
                    kf, 4000, 1000)


def all_scenarios() -> List[Scenario]:
    return [
        scenario_side_fall_180(),
        scenario_vertical_buckle(),
        scenario_forward_camera(),
        scenario_sit_down(),
        scenario_crouch_down(),
        scenario_bend_over(),
        scenario_slow_lie_down(),
        scenario_already_lying(),
        scenario_stress_fast_crouch(),
        scenario_boundary_constant_speed(),
    ]


if __name__ == "__main__":
    for sc in all_scenarios():
        frames = render(sc)
        print("%-28s frames=%3d category=%-8s expected_fall=%s"
              % (sc.name, len(frames), sc.category, sc.expected_fall))
