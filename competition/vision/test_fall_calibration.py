"""test_fall_calibration.py — 2026-10-16 校准的边界测试（底边截断直立分支 / 速率 / 时序）。

校准背景（真实机位实测）：下肢被画面底边截断时人体框近方形（bbox_aspect 最小 0.938），
原"细高框 <=0.85"直立判据不可达；安全受控下降峰值约 0.17/s、静止态 0.0–0.06/s。
因此：直立 = 躯干竖直 且（细高框 OR 框底触底）；drop 阈值 0.18->0.15；直立窗口 2500->6000 ms。
本文件锁定这些边界，并保证去重/低位持续/排除区/坐弯躺不误报等约束未被削弱。
"""

import unittest

from fall_detector import DetectorConfig, FallDetector, FallState, Point, PoseFrame


def pose(ts_ms, bbox, shoulders, hips, track_id=1, conf=0.95):
    points = {
        "left_shoulder": Point(shoulders[0], shoulders[1], conf),
        "right_shoulder": Point(shoulders[2], shoulders[3], conf),
        "left_hip": Point(hips[0], hips[1], conf),
        "right_hip": Point(hips[2], hips[3], conf),
    }
    return PoseFrame(ts_ms, bbox, points, pose_confidence=0.9, track_id=track_id)


# --- 姿态构造 ---------------------------------------------------------------
def tall_upright(ts_ms, hip_y=0.55, track_id=1):
    """完整细高人体（含腿部），aspect<=0.85。"""
    bbox = (0.42, 0.10, 0.58, 0.92)
    return pose(ts_ms, bbox, (0.44, hip_y - 0.22, 0.53, hip_y - 0.22), (0.45, hip_y, 0.54, hip_y), track_id)


def clipped_upright(ts_ms, hip_y=0.60, track_id=1):
    """下肢被底边截断：aspect≈0.94、bbox_bottom=0.99、躯干竖直。"""
    bbox = (0.30, 0.49, 0.77, 0.99)
    return pose(ts_ms, bbox, (0.44, hip_y - 0.16, 0.53, hip_y - 0.16), (0.45, hip_y, 0.54, hip_y), track_id)


def wide_no_clip_upright(ts_ms, hip_y=0.60, track_id=1):
    """aspect≈0.94 但框底未触底（不能仅凭躯干竖直建立直立）。"""
    bbox = (0.30, 0.40, 0.77, 0.90)
    return pose(ts_ms, bbox, (0.44, hip_y - 0.16, 0.53, hip_y - 0.16), (0.45, hip_y, 0.54, hip_y), track_id)


def horizontal_low(ts_ms, hip_y=0.82, track_id=1):
    """接近水平 + 低位（aspect>=1.05、bottom>=0.76、hip_y>=0.58）。"""
    bbox = (0.15, 0.62, 0.85, 0.99)
    return pose(ts_ms, bbox, (0.30, hip_y - 0.04, 0.30, hip_y + 0.02), (0.62, hip_y - 0.03, 0.62, hip_y + 0.03), track_id)


def sitting(ts_ms, track_id=1):
    bbox = (0.35, 0.37, 0.65, 0.92)
    return pose(ts_ms, bbox, (0.45, 0.46, 0.55, 0.46), (0.46, 0.70, 0.54, 0.70), track_id)


def bending(ts_ms, track_id=1):
    bbox = (0.28, 0.28, 0.68, 0.92)
    return pose(ts_ms, bbox, (0.35, 0.43, 0.43, 0.43), (0.51, 0.59, 0.59, 0.59), track_id)


class CalibrationTests(unittest.TestCase):
    # 1) 完整细高直立仍被识别为 upright
    def test_1_complete_tall_upright_still_recognized(self):
        detector = FallDetector()
        detector.update(tall_upright(0))
        snap = detector.snapshot(0)
        self.assertTrue(snap["features_valid"])
        self.assertTrue(snap["upright"], "完整细高人体必须仍判为直立")
        self.assertFalse(snap["bottom_clipped"])

    # 2) 底边截断 + 躯干竖直 -> 可建立 upright 历史
    def test_2_bottom_clipped_upright_establishes_history(self):
        detector = FallDetector()
        detector.update(clipped_upright(0, hip_y=0.60))
        snap = detector.snapshot(0)
        self.assertAlmostEqual(0.94, snap["bbox_aspect"], places=2)
        self.assertTrue(snap["bottom_clipped"])
        self.assertTrue(snap["upright"], "框底触底且躯干竖直时必须算直立")

    # 3) aspect≈0.94 但未触底 -> 不算直立
    def test_3_wide_box_without_bottom_clip_is_not_upright(self):
        detector = FallDetector()
        detector.update(wide_no_clip_upright(0))
        snap = detector.snapshot(0)
        self.assertAlmostEqual(0.94, snap["bbox_aspect"], places=2)
        self.assertFalse(snap["bottom_clipped"])
        self.assertFalse(snap["upright"], "未触底的近方形框不得仅凭躯干竖直算直立")

    # 4) 已经躺着的人不触发
    def test_4_already_lying_person_never_fires(self):
        detector = FallDetector()
        events = [detector.update(horizontal_low(ts)) for ts in range(0, 6000, 300)]
        self.assertFalse(any(events))
        self.assertEqual(FallState.NORMAL, detector.state)

    # 5) 正常坐下不触发
    def test_5_sitting_never_fires(self):
        detector = FallDetector()
        events = [detector.update(sitting(ts)) for ts in range(0, 8000, 300)]
        self.assertFalse(any(events))

    # 6) 弯腰不触发
    def test_6_bending_never_fires(self):
        detector = FallDetector()
        events = [detector.update(bending(ts)) for ts in range(0, 8000, 300)]
        self.assertFalse(any(events))

    # 7) 髋部下降 0.10/s 不触发
    def test_7_slow_drop_010_per_sec_never_fires(self):
        detector = FallDetector()
        frames = [
            clipped_upright(0, hip_y=0.60),
            clipped_upright(400, hip_y=0.64),      # (0.04/0.4s) = 0.10/s < 0.15
            horizontal_low(1000, hip_y=0.70),      # 0.10/s
            horizontal_low(1600, hip_y=0.74),      # 0.066/s
            horizontal_low(2200, hip_y=0.78),      # 0.066/s
            horizontal_low(3000, hip_y=0.80),
        ]
        events = [detector.update(f) for f in frames]
        self.assertFalse(any(events), "0.10/s 的安全下降不得触发")
        self.assertEqual(FallState.NORMAL, detector.state)

    # 8) 受控下降 0.16/s + 6s 内直立 + 水平低位持续 1.2s -> 恰好一次
    def test_8_controlled_descent_016_fires_exactly_once(self):
        detector = FallDetector()
        events = [
            detector.update(clipped_upright(0, hip_y=0.60)),
            detector.update(clipped_upright(375, hip_y=0.66)),   # 0.16/s
            detector.update(horizontal_low(1000, hip_y=0.82)),   # SUSPECTED
            detector.update(horizontal_low(1600, hip_y=0.84)),
            detector.update(horizontal_low(2200, hip_y=0.85)),   # >=1.2s -> FALLEN
            detector.update(horizontal_low(2800, hip_y=0.85)),
        ]
        fired = [e for e in events if e is not None]
        self.assertEqual(1, len(fired), "同一 episode 只能产生一个 FALL")
        self.assertEqual(FallState.FALLEN, detector.state)
        self.assertGreaterEqual(fired[0].hip_drop_per_sec, 0.15)

    # 9) 单帧抖动/轨迹跳变不能形成 FALL
    def test_9_single_frame_jitter_does_not_fire(self):
        detector = FallDetector()
        events = [
            detector.update(clipped_upright(0, hip_y=0.60)),
            detector.update(horizontal_low(300, hip_y=0.90)),    # 单帧跳变 -> SUSPECTED
            detector.update(clipped_upright(600, hip_y=0.62)),   # 立刻恢复直立 -> 复位
            detector.update(clipped_upright(900, hip_y=0.62)),
            detector.update(clipped_upright(1200, hip_y=0.62)),
        ]
        self.assertFalse(any(events))
        self.assertEqual(FallState.NORMAL, detector.state)

    # 10) track ID 切换不能拼接成一次 FALL
    def test_10_track_switch_does_not_join_event(self):
        detector = FallDetector()
        events = [
            detector.update(clipped_upright(0, hip_y=0.60, track_id=1)),
            detector.update(clipped_upright(375, hip_y=0.66, track_id=1)),
            detector.update(horizontal_low(1000, hip_y=0.82, track_id=2)),
            detector.update(horizontal_low(1600, hip_y=0.84, track_id=2)),
            detector.update(horizontal_low(2200, hip_y=0.85, track_id=2)),
        ]
        self.assertFalse(any(events), "换了 track 不得把前一段上升与后一段水平拼成 FALL")

    # 11) exclude-zone 仍抑制事件
    def test_11_exclude_zone_still_suppresses(self):
        detector = FallDetector(excluded_zones=[(0.0, 0.0, 1.0, 1.0)])
        events = [
            detector.update(clipped_upright(0, hip_y=0.60)),
            detector.update(clipped_upright(375, hip_y=0.66)),
            detector.update(horizontal_low(1000, hip_y=0.82)),
            detector.update(horizontal_low(1600, hip_y=0.84)),
            detector.update(horizontal_low(2200, hip_y=0.85)),
        ]
        self.assertFalse(any(events))

    # 12) FALLEN 持续帧不能重复生成事件
    def test_12_fallen_persistence_does_not_repeat(self):
        detector = FallDetector()
        events = [
            detector.update(clipped_upright(0, hip_y=0.60)),
            detector.update(clipped_upright(375, hip_y=0.66)),
            detector.update(horizontal_low(1000, hip_y=0.82)),
            detector.update(horizontal_low(2200, hip_y=0.85)),
        ]
        self.assertEqual(1, len([e for e in events if e is not None]))
        for ts in range(2500, 8000, 300):
            self.assertIsNone(detector.update(horizontal_low(ts, hip_y=0.85)), "FALLEN 期间不得重复告警")
        self.assertEqual(FallState.FALLEN, detector.state)

    # 额外：校准值本身必须精确锁定，防止后续被悄悄放宽
    def test_13_calibrated_defaults_are_exact(self):
        config = DetectorConfig()
        self.assertEqual(0.15, config.rapid_hip_drop_per_sec, "速率阈值不得低于 0.15")
        self.assertEqual(6000, config.recent_upright_ms)
        self.assertEqual(0.98, config.bottom_clip_y)
        self.assertEqual(0.85, config.upright_bbox_aspect, "完整人体的细高框判据必须保留")
        self.assertEqual(1200, config.confirm_ms, "水平低位持续 1.2s 必须保留")


if __name__ == "__main__":
    unittest.main()
