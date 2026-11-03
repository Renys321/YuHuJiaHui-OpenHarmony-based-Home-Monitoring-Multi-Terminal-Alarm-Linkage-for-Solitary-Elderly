"""test_ground_zone.py — 场景地面区域（ground-zone）语义与兼容性测试。

合同（2026-10-17 修订）：
  - 未配置 ground-zone：low = low_absolute（完全沿用原有绝对规则，兼容默认）；
  - 配置 ground-zone：low = ground_hit（**不再强制全局 hip_y>=0.58**）。
    ground-zone 即该机位"地板/安全测试垫区域"的场景定义，用于解决真实水平帧 hip_y=0.231 被全局门槛否决的问题；
  - ground_hit 以**真实髋部中点 hip_x/hip_y** 为主判据；人体框路径要求框中心在区域内且重叠面积≥ground_min_overlap；
  - ground-zone 与 exclude-zone 明显重叠 -> 配置被拒绝（fail closed）；exclude-zone 始终优先；
  - exclude-zone（床/沙发）继续抑制告警；床/沙发不得同时当普通地面区域；
  - 当前无 REAL 图像证据，因此**不提供任何写死的家庭默认地面区域**（只做配置/校验/诊断/测试）。
"""

import argparse
import unittest

from fall_detector import DetectorConfig, FallDetector, FallState, Point, PoseFrame
from yolo_pose_service import parse_ground_zone


def pose(ts_ms, bbox, shoulders, hips, track_id=1):
    points = {
        "left_shoulder": Point(shoulders[0], shoulders[1], 0.95),
        "right_shoulder": Point(shoulders[2], shoulders[3], 0.95),
        "left_hip": Point(hips[0], hips[1], 0.95),
        "right_hip": Point(hips[2], hips[3], 0.95),
    }
    return PoseFrame(ts_ms, bbox, points, pose_confidence=0.9, track_id=track_id)


def clipped_upright(ts_ms, hip_y=0.60, track_id=1):
    bbox = (0.30, 0.49, 0.77, 0.99)
    return pose(ts_ms, bbox, (0.44, hip_y - 0.16, 0.53, hip_y - 0.16), (0.45, hip_y, 0.54, hip_y), track_id)


def horizontal_low(ts_ms, hip_y=0.82, top=0.62, track_id=1):
    bbox = (0.15, top, 0.85, 0.99)
    return pose(ts_ms, bbox, (0.30, hip_y - 0.04, 0.30, hip_y + 0.02), (0.62, hip_y - 0.03, 0.62, hip_y + 0.03), track_id)


def fall_sequence():
    return [clipped_upright(0, 0.60), clipped_upright(375, 0.66), horizontal_low(1000, 0.82), horizontal_low(2200, 0.85)]


FLOOR = (0.0, 0.55, 1.0, 1.0)          # 地面在画面下半部
CEILING = (0.0, 0.0, 1.0, 0.30)        # 明显不是地面
FLOOR_POLYGON = (0.0, 0.60, 1.0, 0.60, 1.0, 1.0, 0.0, 1.0)


def projected_horizontal(ts_ms, hip_y=0.231, hip_x=0.504, track_id=1):
    """真实机位实测形态：torso≈52°、aspect≈1.11（水平），但髋部投影落在画面上部（hip_y≈0.23）。"""
    bbox = (0.15, 0.05, 0.85, 0.68)
    shoulder_y = hip_y - 0.081
    shoulders = (hip_x - 0.156, shoulder_y, hip_x - 0.052, shoulder_y)   # 中点 x = hip_x-0.104 -> dx=0.104
    hips = (hip_x - 0.001, hip_y, hip_x + 0.001, hip_y)                  # 中点 x = hip_x
    return pose(ts_ms, bbox, shoulders, hips, track_id)


def body_above_zone(ts_ms, track_id=1):
    """人体框底边轻触地面区域、但真实髋部与主要身体都在区域之上。"""
    bbox = (0.15, 0.20, 0.85, 0.75)          # 框中心 y=0.475、底边 0.75
    shoulders = (0.42, 0.35, 0.52, 0.35)     # 肩中点 (0.47, 0.35)
    hips = (0.43, 0.45, 0.53, 0.45)          # 髋中点 (0.48, 0.45) -> hip_x=0.48 ≠ 框中心 0.5
    return pose(ts_ms, bbox, shoulders, hips, track_id)


G_UPPER = (0.0, 0.10, 1.0, 0.35)     # 髋部投影所在区域（真实水平帧）
G_EDGE = (0.0, 0.72, 1.0, 1.0)       # 仅被框底边轻触


class GroundZoneRevisionTests(unittest.TestCase):
    def test_configured_ground_zone_replaces_absolute_low(self):
        """核心修复：hip_y=0.231（全局绝对规则会判 false）但真实髋点在 ground-zone 内 -> low=true 并可告警。"""
        detector = FallDetector(ground_zones=[G_UPPER])
        detector.update(clipped_upright(0, 0.60))
        detector.update(clipped_upright(375, 0.66))
        detector.update(projected_horizontal(1000))
        self.assertEqual(FallState.SUSPECTED, detector.state, "配置 ground-zone 后不得再被全局 hip_y 门槛否决")
        events = [detector.update(projected_horizontal(2200))]
        self.assertEqual(1, len([e for e in events if e is not None]))
        self.assertEqual(FallState.FALLEN, detector.state)

    def test_same_posture_outside_zone_is_not_low(self):
        detector = FallDetector(ground_zones=[(0.0, 0.60, 1.0, 1.0)])
        events = [
            detector.update(clipped_upright(0, 0.60)),
            detector.update(clipped_upright(375, 0.66)),
            detector.update(projected_horizontal(1000)),
            detector.update(projected_horizontal(2200)),
            detector.update(projected_horizontal(3000)),
        ]
        self.assertFalse(any(events), "髋点不在 ground-zone 内不得判为低位")
        self.assertEqual(FallState.NORMAL, detector.state)

    def test_tiny_edge_contact_is_not_enough(self):
        detector = FallDetector(ground_zones=[G_EDGE])
        features = detector.features(body_above_zone(0))
        self.assertFalse(detector._ground_hit(features), "框边缘轻触区域不得判为在地面上")
        self.assertLess(detector._zone_overlap_ratio(features, G_EDGE), detector.config.ground_min_overlap)

    def test_hip_x_comes_from_real_hip_keypoints(self):
        detector = FallDetector()
        features = detector.features(body_above_zone(0))
        # 髋关键点中点 x = (0.43+0.53)/2 = 0.48；框中心 x = (0.15+0.85)/2 = 0.50
        self.assertAlmostEqual(0.48, features.hip_x, places=6)
        self.assertNotAlmostEqual(features.center_x, features.hip_x, places=3)

    def test_zone_conflict_detection_fails_closed_for_bed_overlap(self):
        conflicts = FallDetector.find_zone_conflicts([(0.0, 0.55, 1.0, 1.0)], [(0.0, 0.50, 1.0, 1.0)])
        self.assertTrue(conflicts, "床/沙发 exclude-zone 明显覆盖地面区域必须被拒绝")
        self.assertEqual([], FallDetector.find_zone_conflicts([(0.0, 0.80, 1.0, 1.0)], [(0.0, 0.0, 1.0, 0.40)]))

    def test_exclude_zone_priority_with_configured_ground_zone(self):
        detector = FallDetector(excluded_zones=[(0.0, 0.0, 1.0, 1.0)], ground_zones=[G_UPPER])
        events = [
            detector.update(clipped_upright(0, 0.60)),
            detector.update(clipped_upright(375, 0.66)),
            detector.update(projected_horizontal(1000)),
            detector.update(projected_horizontal(2200)),
        ]
        self.assertFalse(any(events), "exclude-zone 始终优先，即使 ground-zone 命中也不得告警")


class GroundZoneParsingTests(unittest.TestCase):
    def test_rect_and_polygon_accepted(self):
        self.assertEqual((0.1, 0.6, 0.9, 1.0), parse_ground_zone("0.1,0.6,0.9,1.0"))
        self.assertEqual((0.1, 0.6, 0.9, 1.0), parse_ground_zone("0.1 0.6 0.9 1.0"))
        self.assertEqual(FLOOR_POLYGON, parse_ground_zone("0,0.6,1,0.6,1,1,0,1"))

    def test_invalid_values_rejected(self):
        with self.assertRaises(argparse.ArgumentTypeError):
            parse_ground_zone("0.1,0.6,0.9")             # 3 个数字
        with self.assertRaises(argparse.ArgumentTypeError):
            parse_ground_zone("0.1,0.6,0.9,1.2")         # 越界
        with self.assertRaises(argparse.ArgumentTypeError):
            parse_ground_zone("0.9,0.6,0.1,1.0")         # x1>=x2
        with self.assertRaises(argparse.ArgumentTypeError):
            parse_ground_zone("a,b,c,d")

    def test_no_hardcoded_default_ground_zone(self):
        detector = FallDetector()
        self.assertEqual((), detector.ground_zones, "无 REAL 图像证据前不得写死家庭地面区域")


class GroundZoneSemanticsTests(unittest.TestCase):
    def test_without_ground_zone_absolute_low_still_fires(self):
        detector = FallDetector()
        events = [detector.update(f) for f in fall_sequence()]
        self.assertEqual(1, len([e for e in events if e is not None]), "未配置地面区域时必须保持原有行为")

    def test_inside_ground_zone_enters_suspected_then_fires_once(self):
        detector = FallDetector(ground_zones=[FLOOR])
        detector.update(clipped_upright(0, 0.60))
        detector.update(clipped_upright(375, 0.66))
        detector.update(horizontal_low(1000, 0.82))
        self.assertEqual(FallState.SUSPECTED, detector.state, "地面区域内水平低位应进入 SUSPECTED")
        events = [detector.update(horizontal_low(2200, 0.85))]
        self.assertEqual(1, len([e for e in events if e is not None]))

    def test_polygon_ground_zone_is_supported(self):
        detector = FallDetector(ground_zones=[FLOOR_POLYGON])
        for index, frame in enumerate(fall_sequence()):
            event = detector.update(frame)
        self.assertEqual(FallState.FALLEN, detector.state, "多边形地面区域同样应支持")

    def test_lying_outside_ground_zone_never_fires(self):
        detector = FallDetector(ground_zones=[CEILING])
        events = [detector.update(f) for f in fall_sequence()]
        self.assertFalse(any(events), "地面区域之外的水平低位不得告警")
        self.assertEqual(FallState.NORMAL, detector.state)

    def test_exclude_zone_still_blocks_inside_ground_zone(self):
        detector = FallDetector(excluded_zones=[(0.0, 0.0, 1.0, 1.0)], ground_zones=[FLOOR])
        events = [detector.update(f) for f in fall_sequence()]
        self.assertFalse(any(events), "床/沙发 exclude-zone 必须继续抑制告警")

    def test_already_lying_inside_ground_zone_never_fires(self):
        detector = FallDetector(ground_zones=[FLOOR])
        events = [detector.update(horizontal_low(ts, 0.85)) for ts in range(0, 6000, 300)]
        self.assertFalse(any(events))

    def test_sitting_and_bending_still_safe_with_ground_zone(self):
        detector = FallDetector(ground_zones=[FLOOR])
        sitting_bbox = (0.35, 0.37, 0.65, 0.92)
        bending_bbox = (0.28, 0.28, 0.68, 0.92)
        events = []
        for ts in range(0, 6000, 300):
            events.append(detector.update(pose(ts, sitting_bbox, (0.45, 0.46, 0.55, 0.46), (0.46, 0.70, 0.54, 0.70))))
            events.append(detector.update(pose(ts + 100, bending_bbox, (0.35, 0.43, 0.43, 0.43), (0.51, 0.59, 0.59, 0.59))))
        self.assertFalse(any(events), "配置地面区域后坐下/弯腰仍不得告警")

    def test_track_switch_still_does_not_join_with_ground_zone(self):
        detector = FallDetector(ground_zones=[FLOOR])
        events = [
            detector.update(clipped_upright(0, 0.60, track_id=1)),
            detector.update(clipped_upright(375, 0.66, track_id=1)),
            detector.update(horizontal_low(1000, 0.82, track_id=2)),
            detector.update(horizontal_low(2200, 0.85, track_id=2)),
        ]
        self.assertFalse(any(events))

    def test_deduplication_still_holds_with_ground_zone(self):
        detector = FallDetector(ground_zones=[FLOOR])
        events = [detector.update(f) for f in fall_sequence()]
        self.assertEqual(1, len([e for e in events if e is not None]))
        for ts in range(2500, 8000, 300):
            self.assertIsNone(detector.update(horizontal_low(ts, 0.85)), "FALLEN 持续不得重复告警")


if __name__ == "__main__":
    unittest.main()
