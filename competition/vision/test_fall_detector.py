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
    elif kind == "sitting":
        bbox = (0.35, 0.37, 0.65, 0.92)
        shoulders = (0.45, 0.46, 0.55, 0.46)
        hips = (0.46, 0.70, 0.54, 0.70)
    elif kind == "bending":
        bbox = (0.28, 0.28, 0.68, 0.92)
        shoulders = (0.35, 0.43, 0.43, 0.43)
        hips = (0.51, 0.59, 0.59, 0.59)
    else:
        raise ValueError(kind)

    points = {
        "left_shoulder": Point(shoulders[0], shoulders[1], 0.95),
        "right_shoulder": Point(shoulders[2], shoulders[3], 0.95),
        "left_hip": Point(hips[0], hips[1], 0.95),
        "right_hip": Point(hips[2], hips[3], 0.95),
    }
    return PoseFrame(ts_ms, bbox, points, pose_confidence=0.9, track_id=track_id)


class FallDetectorTests(unittest.TestCase):
    def test_stable_upright_never_falls(self):
        detector = FallDetector()
        events = [detector.update(frame(ts, "upright")) for ts in range(0, 5000, 250)]
        self.assertFalse(any(events))
        self.assertEqual(FallState.NORMAL, detector.state)

    def test_quick_drop_and_sustained_horizontal_pose_emits_once(self):
        detector = FallDetector()
        detector.update(frame(0, "upright"))
        detector.update(frame(200, "horizontal"))
        self.assertIsNone(detector.update(frame(900, "horizontal")))
        event = detector.update(frame(1500, "horizontal"))
        self.assertIsNotNone(event)
        self.assertEqual(FallState.FALLEN, detector.state)
        self.assertGreaterEqual(event.score, 0.5)
        self.assertGreaterEqual(event.hip_drop_per_sec, 0.18)
        self.assertIsNone(detector.update(frame(2200, "horizontal")))

    def test_sitting_is_not_a_fall(self):
        detector = FallDetector()
        detector.update(frame(0, "upright"))
        for ts in (300, 900, 1600, 2400):
            self.assertIsNone(detector.update(frame(ts, "sitting")))
        self.assertEqual(FallState.NORMAL, detector.state)

    def test_bending_is_not_a_fall(self):
        detector = FallDetector()
        detector.update(frame(0, "upright"))
        for ts in (200, 600, 1000, 1500):
            self.assertIsNone(detector.update(frame(ts, "bending")))
        self.assertEqual(FallState.NORMAL, detector.state)

    def test_person_already_lying_down_does_not_trigger(self):
        detector = FallDetector()
        for ts in (0, 500, 1200, 2000):
            self.assertIsNone(detector.update(frame(ts, "horizontal")))
        self.assertEqual(FallState.NORMAL, detector.state)

    def test_excluded_bed_zone_suppresses_event(self):
        detector = FallDetector(excluded_zones=((0.10, 0.55, 0.90, 0.98),))
        detector.update(frame(0, "upright"))
        for ts in (200, 900, 1500, 2200):
            self.assertIsNone(detector.update(frame(ts, "horizontal")))
        self.assertEqual(FallState.NORMAL, detector.state)

    def test_lost_pose_cancels_unconfirmed_suspicion(self):
        detector = FallDetector()
        detector.update(frame(0, "upright"))
        detector.update(frame(200, "horizontal"))
        self.assertEqual(FallState.SUSPECTED, detector.state)
        detector.update(None, 1600)
        self.assertEqual(FallState.NORMAL, detector.state)

    def test_different_tracks_cannot_form_one_fall(self):
        detector = FallDetector()
        detector.update(frame(0, "upright", track_id=1))
        detector.update(frame(200, "horizontal", track_id=2))
        self.assertIsNone(detector.update(frame(1600, "horizontal", track_id=2)))
        self.assertEqual(FallState.NORMAL, detector.state)

    def test_recovery_allows_a_later_fall(self):
        detector = FallDetector()
        detector.update(frame(0, "upright"))
        detector.update(frame(200, "horizontal"))
        first = detector.update(frame(1500, "horizontal"))
        self.assertIsNotNone(first)
        detector.update(frame(2300, "upright"))
        detector.update(frame(4500, "upright"))
        self.assertEqual(FallState.NORMAL, detector.state)
        detector.update(frame(4700, "horizontal"))
        second = detector.update(frame(6000, "horizontal"))
        self.assertIsNotNone(second)


if __name__ == "__main__":
    unittest.main()

