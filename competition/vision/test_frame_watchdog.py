"""Tests for the long-gap frame watchdog and its MQTT monitor reporter.

These tests never import Ultralytics: they exercise the pure decision logic and
the sink contract only.
"""

import unittest

from yolo_pose_service import FrameWatchdog, MonitorReporter


class FakeMonitorSink:
    def __init__(self, failures=0):
        self.failures = failures
        self.calls = []

    def publish_monitor(self, state, reason):
        self.calls.append((state, reason))
        if self.failures > 0:
            self.failures -= 1
            raise RuntimeError("broker unavailable")


def watchdog(timeout_ms=1000, startup_grace_ms=3000, heartbeat_ms=0):
    return FrameWatchdog(
        timeout_ms=timeout_ms,
        startup_grace_ms=startup_grace_ms,
        heartbeat_ms=heartbeat_ms,
    )


class FrameWatchdogTests(unittest.TestCase):
    def test_healthy_frames_never_report_offline(self):
        wd = watchdog()
        events = [wd.poll(0)]
        for t in range(100, 1000):
            events.append(wd.note_frame(t))
            events.append(wd.poll(t))
        reported = [event for event in events if event is not None]
        self.assertEqual([("online", "first_frame", True)], reported)
        self.assertEqual(0, wd.episodes)

    def test_timeout_reports_offline_once(self):
        wd = watchdog()
        wd.note_frame(0)
        # boundary: exactly timeout_ms is still online
        self.assertIsNone(wd.poll(1000))
        self.assertEqual(("offline", "no_frame", True), wd.poll(1001))
        self.assertEqual(1, wd.episodes)

    def test_continuous_gap_does_not_repeat_the_alarm(self):
        wd = watchdog()
        wd.note_frame(0)
        self.assertEqual(("offline", "no_frame", True), wd.poll(1001))
        repeats = [wd.poll(t) for t in range(1100, 30000, 250)]
        self.assertEqual([None] * len(repeats), repeats)
        self.assertEqual(1, wd.episodes)

    def test_frame_after_gap_reports_recovery_once(self):
        wd = watchdog()
        wd.note_frame(0)
        wd.poll(1001)
        self.assertEqual(("online", "frames_resumed", True), wd.note_frame(2000))
        self.assertIsNone(wd.note_frame(2100))
        self.assertIsNone(wd.poll(2200))

    def test_second_gap_starts_a_new_episode(self):
        wd = watchdog()
        wd.note_frame(0)
        wd.poll(1001)
        wd.note_frame(2000)
        self.assertEqual(("offline", "no_frame", True), wd.poll(3001))
        self.assertEqual(2, wd.episodes)

    def test_startup_reports_no_first_frame_once(self):
        wd = watchdog()
        self.assertIsNone(wd.poll(0))
        self.assertIsNone(wd.poll(2999))
        self.assertEqual(("offline", "no_first_frame", True), wd.poll(3000))
        self.assertIsNone(wd.poll(6000))
        self.assertEqual(1, wd.episodes)
        self.assertEqual(("online", "frames_resumed", True), wd.note_frame(7000))

    def test_heartbeat_repeats_current_state_without_new_episode(self):
        online_wd = watchdog(timeout_ms=10000, startup_grace_ms=30000, heartbeat_ms=500)
        online_wd.note_frame(0)
        self.assertIsNone(online_wd.poll(499))
        self.assertEqual(("online", "first_frame", False), online_wd.poll(500))
        self.assertEqual(0, online_wd.episodes)

        offline_wd = watchdog(timeout_ms=1000, startup_grace_ms=30000, heartbeat_ms=5000)
        offline_wd.note_frame(0)
        self.assertEqual(("offline", "no_frame", True), offline_wd.poll(1001))
        self.assertEqual(("offline", "no_frame", False), offline_wd.poll(6001))
        self.assertEqual(1, offline_wd.episodes)

    def test_publish_disabled_does_not_touch_mqtt(self):
        sink = FakeMonitorSink()
        wd = watchdog()
        reporter = MonitorReporter(False, sink, wd)
        reporter.note_frame(0)
        reporter.poll(1001)
        reporter.poll(3000)
        self.assertEqual([], sink.calls)
        self.assertEqual(1, wd.episodes)

    def test_publish_enabled_reports_transitions_to_mqtt(self):
        sink = FakeMonitorSink()
        wd = watchdog()
        reporter = MonitorReporter(True, sink, wd)
        reporter.note_frame(0)
        reporter.poll(1001)
        reporter.poll(3000)
        reporter.note_frame(4000)
        self.assertEqual(
            [("online", "first_frame"), ("offline", "no_frame"), ("online", "frames_resumed")],
            sink.calls,
        )

    def test_monitor_publish_failure_is_contained(self):
        sink = FakeMonitorSink(failures=1)
        wd = watchdog()
        reporter = MonitorReporter(True, sink, wd)
        reporter.note_frame(0)
        reporter.poll(1001)
        reporter.note_frame(2000)
        self.assertEqual(3, len(sink.calls))
        self.assertEqual("online", wd.state)

    def test_invalid_parameters_are_rejected(self):
        with self.assertRaises(ValueError):
            FrameWatchdog(timeout_ms=0, startup_grace_ms=1000)
        with self.assertRaises(ValueError):
            FrameWatchdog(timeout_ms=1000, startup_grace_ms=0)
        with self.assertRaises(ValueError):
            FrameWatchdog(timeout_ms=1000, startup_grace_ms=1000, heartbeat_ms=-1)


if __name__ == "__main__":
    unittest.main()
