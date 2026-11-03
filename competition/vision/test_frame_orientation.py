"""test_frame_orientation.py — 方向合同测试（旋转、启动解析、运行期变化、横卧不误判）。"""

import json
import unittest

import numpy as np

from fall_detector import FallDetector, Point, PoseFrame
from frame_orientation import (
    ALLOWED_ROTATIONS,
    FrameRotationError,
    OrientationObservation,
    OrientationWatchdog,
    parse_rotation,
    resolve_startup_rotation,
    rotate_image,
)


def obs(dy, reliable=True, width=640, height=480):
    return OrientationObservation(width, height, dy, reliable)


def pose(ts_ms, bbox, shoulders, hips, track_id=1):
    points = {
        "left_shoulder": Point(shoulders[0], shoulders[1], 0.95),
        "right_shoulder": Point(shoulders[2], shoulders[3], 0.95),
        "left_hip": Point(hips[0], hips[1], 0.95),
        "right_hip": Point(hips[2], hips[3], 0.95),
    }
    return PoseFrame(ts_ms, bbox, points, pose_confidence=0.9, track_id=track_id)


class RotationParsingTests(unittest.TestCase):
    def test_accepts_only_quarter_turns(self):
        for value in (0, 90, 180, 270, "0", "90", "270"):
            self.assertIn(parse_rotation(value), ALLOWED_ROTATIONS)
        self.assertEqual(0, parse_rotation(360))
        for bad in (45, -90, 1, "auto", "abc", None, True):
            with self.assertRaises(FrameRotationError):
                parse_rotation(bad)


class RotateImageTests(unittest.TestCase):
    def test_rotation_shapes(self):
        image = np.arange(8).reshape(2, 4)   # h=2 w=4
        self.assertEqual((2, 4), rotate_image(image, 0).shape)
        self.assertEqual((4, 2), rotate_image(image, 90).shape)
        self.assertEqual((2, 4), rotate_image(image, 180).shape)
        self.assertEqual((4, 2), rotate_image(image, 270).shape)

    def test_marker_position_matches_expected_transform(self):
        # 标记放在原图 (y=0, x=0)（左上角）。归一化坐标 (0,0)。
        image = np.zeros((4, 8), dtype=np.uint8)
        image[0, 0] = 255
        def marker(a):
            ys, xs = np.where(a == 255)
            return (int(ys[0]), int(xs[0]), a.shape[1], a.shape[0])   # y, x, w, h
        # 90°（逆时针 rot90 k=1）：左上角 -> 左下角
        self.assertEqual((7, 0, 4, 8), marker(rotate_image(image, 90)))
        # 180°：左上角 -> 右下角
        self.assertEqual((3, 7, 8, 4), marker(rotate_image(image, 180)))
        # 270°（=90° 顺时针）：左上角 -> 右上角；新宽度=原高度=4，故 x=3
        self.assertEqual((0, 3, 4, 8), marker(rotate_image(image, 270)))

    def test_zero_rotation_is_identity(self):
        image = np.arange(6).reshape(2, 3)
        self.assertTrue(np.array_equal(image, rotate_image(image, 0)))


class StartupResolutionTests(unittest.TestCase):
    def test_resolves_zero_when_standing_vertical_sign_positive(self):
        result = resolve_startup_rotation([obs(0.2) for _ in range(6)], min_reliable=5)
        self.assertEqual(0, result.rotation)
        self.assertEqual("reliable_standing_vertical_sign", result.reason)

    def test_resolves_180_when_standing_sign_negative(self):
        result = resolve_startup_rotation([obs(-0.2) for _ in range(6)], min_reliable=5)
        self.assertEqual(180, result.rotation)

    def test_refuses_without_enough_reliable_standing(self):
        result = resolve_startup_rotation([obs(0.2, reliable=False) for _ in range(20)], min_reliable=5)
        self.assertIsNone(result.rotation)
        self.assertEqual("insufficient_reliable_standing_samples", result.reason)

    def test_refuses_on_ambiguous_sign(self):
        samples = [obs(0.2), obs(-0.2), obs(0.2), obs(-0.2), obs(0.2), obs(0.2)]
        result = resolve_startup_rotation(samples, min_reliable=5)
        self.assertIsNone(result.rotation)
        self.assertEqual("ambiguous_vertical_sign", result.reason)

    def test_refuses_on_possible_90_270(self):
        # 期望横向（expected_landscape=True）却收到竖幅尺寸 -> 可能是 90/270，拒绝自动选择
        samples = [OrientationObservation(480, 640, 0.2, True) for _ in range(6)]
        result = resolve_startup_rotation(samples, min_reliable=5, expected_landscape=True)
        self.assertIsNone(result.rotation)
        self.assertEqual("possible_90_270_rotation_needs_explicit_value", result.reason)

    def test_refuses_on_changing_dimensions(self):
        samples = [obs(0.2), obs(0.2), OrientationObservation(480, 640, 0.2, True)]
        result = resolve_startup_rotation(samples, min_reliable=1)
        self.assertIsNone(result.rotation)
        self.assertEqual("frame_dimensions_changed", result.reason)


class WatchdogTests(unittest.TestCase):
    def test_horizontal_body_is_not_mistaken_for_rotation_change(self):
        # 锁定 0°；横卧/坐姿帧 reliable_standing=False 且 dy 可能为负 —— 不得触发方向变化
        watchdog = OrientationWatchdog(0, change_streak=3)
        for _ in range(20):
            self.assertFalse(watchdog.observe(obs(-0.9, reliable=False)).detected)
        self.assertFalse(watchdog.changed)

    def test_vertical_sign_inversion_needs_streak(self):
        watchdog = OrientationWatchdog(0, change_streak=5)
        for _ in range(4):
            self.assertFalse(watchdog.observe(obs(-0.2)).detected)
        self.assertFalse(watchdog.changed, "迟滞内不得提前判定方向变化")
        change = watchdog.observe(obs(-0.2))
        self.assertTrue(change.detected)
        self.assertEqual("vertical_sign_inverted", change.kind)
        self.assertTrue(watchdog.changed)

    def test_dimension_swap_detected_immediately(self):
        watchdog = OrientationWatchdog(0, change_streak=5)
        watchdog.observe(obs(0.2, width=640, height=480))
        change = watchdog.observe(obs(0.2, width=480, height=640))
        self.assertTrue(change.detected)
        self.assertEqual("frame_dimensions_changed", change.kind)

    def test_change_is_reported_once(self):
        watchdog = OrientationWatchdog(0, change_streak=1)
        self.assertTrue(watchdog.observe(obs(-0.2)).detected)
        self.assertFalse(watchdog.observe(obs(-0.2)).detected)

    def test_180_lock_expects_positive_sign_after_normalization(self):
        watchdog = OrientationWatchdog(180, change_streak=3)
        for _ in range(5):
            self.assertFalse(watchdog.observe(obs(0.2)).detected, "180° 旋转后归一化姿态应为正号")
        self.assertFalse(watchdog.changed)
        self.assertFalse(watchdog.observe(obs(-0.2)).detected)
        self.assertFalse(watchdog.observe(obs(-0.2)).detected)
        self.assertTrue(watchdog.observe(obs(-0.2)).detected)


class SignedVectorTests(unittest.TestCase):
    def test_signed_dy_positive_upright_and_flips_when_inverted(self):
        # 正常方向：肩在髋上方（y 更小）-> dy > 0
        normal = pose(0, (0.42, 0.10, 0.58, 0.92), (0.46, 0.30, 0.54, 0.30), (0.46, 0.60, 0.54, 0.60))
        features = FallDetector().features(normal)
        self.assertGreater(features.shoulder_hip_dy, 0)
        self.assertIn("shoulder_hip_dy", FallDetector().snapshot(0))
        # 180° 倒置：把 y 映射为 1-y（髋跑到肩上方）-> dy < 0，且归一化后恢复
        inverted = pose(0, (0.42, 0.08, 0.58, 0.90), (0.46, 1 - 0.30, 0.54, 1 - 0.30), (0.46, 1 - 0.60, 0.54, 1 - 0.60))
        inv_features = FallDetector().features(inverted)
        self.assertLess(inv_features.shoulder_hip_dy, 0)
        # 左右点对称 => 归一化（y -> 1-y）后与原帧同向
        normalized = pose(0, (0.42, 0.10, 0.58, 0.92), (0.46, 0.30, 0.54, 0.30), (0.46, 0.60, 0.54, 0.60))
        self.assertGreater(FallDetector().features(normalized).shoulder_hip_dy, 0)


if __name__ == "__main__":
    unittest.main()
