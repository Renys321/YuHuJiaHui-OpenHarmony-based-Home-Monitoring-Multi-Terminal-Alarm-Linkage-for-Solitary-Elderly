"""test_diag_snapshot.py — 只读条件快照的边界测试（不改变判定行为）。"""

import json
import unittest

from fall_detector import FallDetector, FallState, Point, PoseFrame


def frame(ts_ms, kind, track_id=1):
    if kind == "upright":
        bbox = (0.40, 0.12, 0.60, 0.92)
        shoulders = (0.46, 0.31, 0.54, 0.31)
        hips = (0.47, 0.53, 0.53, 0.53)
    elif kind == "horizontal":
        bbox = (0.18, 0.66, 0.82, 0.92)
        shoulders = (0.34, 0.74, 0.34, 0.80)
        hips = (0.58, 0.75, 0.58, 0.81)
    else:
        raise ValueError(kind)
    points = {
        "left_shoulder": Point(shoulders[0], shoulders[1], 0.95),
        "right_shoulder": Point(shoulders[2], shoulders[3], 0.95),
        "left_hip": Point(hips[0], hips[1], 0.95),
        "right_hip": Point(hips[2], hips[3], 0.95),
    }
    return PoseFrame(ts_ms, bbox, points, pose_confidence=0.9, track_id=track_id)


class DiagSnapshotTests(unittest.TestCase):
    def test_empty_detector_snapshot_is_safe_and_serializable(self):
        detector = FallDetector()
        snap = detector.snapshot(1000)
        self.assertEqual("NORMAL", snap["state"])
        self.assertFalse(snap["features_valid"])
        self.assertFalse(snap["upright"])
        self.assertFalse(snap["horizontal"])
        self.assertFalse(snap["low"])
        self.assertIsNone(snap["since_upright_ms"])
        self.assertIn("thresholds", snap)
        json.dumps(snap, allow_nan=False)

    def test_snapshot_reports_upright_and_horizontal_flags(self):
        detector = FallDetector()
        detector.update(frame(0, "upright"))
        up = detector.snapshot(0)
        self.assertTrue(up["features_valid"])
        self.assertTrue(up["upright"])
        self.assertFalse(up["horizontal"])
        detector.update(frame(200, "horizontal"))
        horiz = detector.snapshot(200)
        self.assertTrue(horiz["features_valid"])
        self.assertTrue(horiz["horizontal"])
        self.assertTrue(horiz["low"])
        self.assertGreater(horiz["drop_rate"], 0.0)
        self.assertEqual(9, len(horiz["thresholds"]), "快照必须带全部 9 个阈值（含 bottom_clip_y），便于逐条对照")

    def test_snapshot_does_not_change_detection_behaviour(self):
        # 同一序列：A 不取快照，B 每帧取快照 —— 事件与状态必须完全一致。
        plain = FallDetector()
        plain_events = []
        for ts in (0, 200, 900, 1500, 2200):
            kind = "upright" if ts == 0 else "horizontal"
            plain_events.append(plain.update(frame(ts, kind)))
        probed = FallDetector()
        probed_events = []
        for ts in (0, 200, 900, 1500, 2200):
            kind = "upright" if ts == 0 else "horizontal"
            probed_events.append(probed.update(frame(ts, kind)))
            probed.snapshot(ts)
        self.assertEqual(plain.state, probed.state)
        self.assertEqual(
            [None if e is None else e.ts_ms for e in plain_events],
            [None if e is None else e.ts_ms for e in probed_events],
        )
        self.assertEqual(1, sum(1 for e in probed_events if e is not None), "只允许一个新 episode")

    def test_thresholds_match_detector_config(self):
        config = FallDetector().config
        snap = FallDetector().snapshot(0)
        self.assertEqual(config.rapid_hip_drop_per_sec, snap["thresholds"]["rapid_hip_drop_per_sec"])
        self.assertEqual(config.confirm_ms, snap["thresholds"]["confirm_ms"])
        self.assertEqual(config.recent_upright_ms, snap["thresholds"]["recent_upright_ms"])
        self.assertEqual(config.low_hip_y, snap["thresholds"]["low_hip_y"])


if __name__ == "__main__":
    unittest.main()
