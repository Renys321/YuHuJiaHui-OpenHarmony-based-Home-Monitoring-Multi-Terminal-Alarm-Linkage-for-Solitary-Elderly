import inspect
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest import mock

import yolo_pose_service as service

from fall_detector import FallDetector, FallState
from yolo_pose_service import (
    FallPublishCoordinator,
    parse_source,
    parse_zone,
    primary_pose,
    process_result,
    run_http_ingest,
    track_pose_stream,
)


class FakeSink:
    def __init__(self, failures=0):
        self.failures = failures
        self.scores = []
        self.evidence_ids = []

    def publish_fall(self, score, evidence_id=""):
        self.scores.append(score)
        self.evidence_ids.append(evidence_id)
        if self.failures > 0:
            self.failures -= 1
            raise RuntimeError("broker unavailable")


class FakeTensor:
    def __init__(self, value):
        self.value = value

    def cpu(self):
        return self

    def tolist(self):
        return self.value


class FakeBoxes:
    def __init__(self, track_ids=None):
        self.xyxy = FakeTensor([[10, 20, 110, 220], [100, 50, 500, 450]])
        self.conf = FakeTensor([0.95, 0.80])
        self.id = FakeTensor([7, 11] if track_ids is None else track_ids)

    def __len__(self):
        return 2


class FakeKeypoints:
    def __init__(self):
        first = [[0, 0, 0.1] for _ in range(17)]
        second = [[200, 100, 0.9] for _ in range(17)]
        self.data = FakeTensor([first, second])


class FakeResult:
    boxes = FakeBoxes()
    keypoints = FakeKeypoints()
    orig_shape = (500, 1000)


class FakeResultWithoutConfirmedTrack(FakeResult):
    boxes = FakeBoxes([7, None])


class FakeResultWithoutPerson:
    boxes = None
    keypoints = None
    orig_shape = (500, 1000)


class FakeModel:
    def __init__(self):
        self.kwargs = None

    def track(self, **kwargs):
        self.kwargs = kwargs
        return []


class YoloPoseAdapterTests(unittest.TestCase):
    def test_http_ingest_watchdog_is_kept_in_mutable_state(self):
        source = inspect.getsource(run_http_ingest)
        self.assertIn('"watchdog": OrientationWatchdog(', source)
        self.assertIn('orientation["watchdog"] = OrientationWatchdog(', source)
        self.assertNotIn('rotation_watchdog = OrientationWatchdog(', source)

    def test_auto_orientation_frames_keep_monitor_online_and_refusal_is_bounded(self):
        source = inspect.getsource(run_http_ingest)
        auto_block = source[source.index('if orientation["auto"]'):source.index('if rotation_watchdog is not None')]
        self.assertIn('monitor.note_frame(now_ms)', auto_block)
        self.assertIn('if orientation["refused"]:', auto_block)
        self.assertIn('orientation["observations"].clear()', auto_block)
        self.assertIn('"personDetected": False', auto_block)
        self.assertIn('"fall": False', auto_block)

    def test_explicit_rotation_http_path_processes_a_frame_without_scope_error(self):
        captured = {}

        def capture_handler(callback, _max_frame_bytes):
            captured["callback"] = callback
            return object()

        class OneFrameServer:
            def __init__(self, _address, _handler):
                self.timeout = 0.0
                self.calls = 0

            def handle_request(self):
                if self.calls > 0:
                    raise KeyboardInterrupt()
                self.calls += 1
                captured["response"] = captured["callback"](
                    b"jpeg", 1000, "dayu200-living"
                )

            def server_close(self):
                return None

        with tempfile.TemporaryDirectory() as temp_dir:
            args = SimpleNamespace(
                publish=False,
                frame_timeout_ms=10000,
                frame_startup_grace_ms=15000,
                monitor_heartbeat_ms=30000,
                evidence_dir=Path(temp_dir),
                evidence_max_events=10,
                evidence_upload_url="",
                evidence_ingest_key_env="INGEST_KEY",
                frame_rotation="0",
                rotation_calibration_samples=3,
                rotation_calibration_max_frames=10,
                model_conf=0.35,
                imgsz=640,
                device="cpu",
                diag_conditions=False,
                max_frame_bytes=1024,
                listen_host="127.0.0.1",
                listen_port=0,
            )
            with mock.patch.object(service, "create_frame_handler", side_effect=capture_handler), \
                    mock.patch.object(service, "HTTPServer", OneFrameServer), \
                    mock.patch.object(service, "decode_jpeg", return_value=object()), \
                    mock.patch.object(
                        service,
                        "track_pose_stream",
                        return_value=iter([FakeResultWithoutPerson()]),
                    ):
                code = run_http_ingest(args, object(), FallDetector(), FakeSink())

        self.assertEqual(0, code)
        self.assertTrue(captured["response"]["ok"])
        self.assertEqual("dayu200-living", captured["response"]["source"])

    def test_primary_pose_selects_largest_confidence_weighted_person(self):
        pose = primary_pose(FakeResult(), 1234)
        self.assertIsNotNone(pose)
        self.assertEqual(11, pose.track_id)
        self.assertEqual(1234, pose.ts_ms)
        self.assertEqual((0.1, 0.1, 0.5, 0.9), pose.bbox)
        self.assertAlmostEqual(0.2, pose.keypoints["left_shoulder"].x)
        self.assertAlmostEqual(0.2, pose.keypoints["left_shoulder"].y)
        self.assertAlmostEqual(0.8, pose.pose_confidence)

    def test_primary_pose_normalizes_with_original_frame_shape(self):
        pose = primary_pose(FakeResult(), 1234)
        self.assertIsNotNone(pose)
        width = pose.bbox[2] - pose.bbox[0]
        height = pose.bbox[3] - pose.bbox[1]
        self.assertAlmostEqual(0.5, width / height)

    def test_primary_pose_accepts_unconfirmed_track(self):
        pose = primary_pose(FakeResultWithoutConfirmedTrack(), 1234)
        self.assertIsNotNone(pose)
        self.assertIsNone(pose.track_id)

    def test_track_pose_stream_requests_rectangular_inference(self):
        model = FakeModel()
        results = track_pose_stream(model, "wide.mp4", 0.35, 640, "cpu")
        self.assertEqual([], results)
        self.assertEqual("wide.mp4", model.kwargs["source"])
        self.assertTrue(model.kwargs["stream"])
        self.assertTrue(model.kwargs["persist"])
        self.assertEqual("bytetrack.yaml", model.kwargs["tracker"])
        self.assertTrue(model.kwargs["rect"])
        self.assertEqual(0.35, model.kwargs["conf"])
        self.assertEqual(640, model.kwargs["imgsz"])
        self.assertEqual("cpu", model.kwargs["device"])

    def test_source_and_zone_parsing(self):
        self.assertEqual(0, parse_source("0"))
        self.assertEqual("video.mp4", parse_source("video.mp4"))
        self.assertEqual((0.1, 0.2, 0.8, 0.9), parse_zone("0.1,0.2,0.8,0.9"))
        with self.assertRaises(Exception):
            parse_zone("0.8,0.2,0.1,0.9")

    def test_process_result_keeps_fall_active_until_detector_recovers(self):
        detector = FallDetector()
        detector.state = FallState.FALLEN
        response, record = process_result(FakeResultWithoutPerson(), detector, 1234)
        self.assertTrue(response["fall"])
        self.assertEqual("FALLEN", response["state"])
        self.assertIsNone(record)

    def test_fall_publish_retries_then_clears_exactly_once(self):
        sink = FakeSink(failures=1)
        publisher = FallPublishCoordinator(True, sink, retry_ms=2000)
        record = {"score": 0.91}

        self.assertEqual("failed", publisher.handle(record, 1000))
        self.assertIsNone(publisher.handle(None, 2999))
        self.assertEqual("published", publisher.handle(None, 3000))
        self.assertIsNone(publisher.handle(None, 5000))
        self.assertEqual([0.91, 0.91], sink.scores)

    def test_fall_publish_is_disabled_without_publish_flag(self):
        sink = FakeSink()
        publisher = FallPublishCoordinator(False, sink)
        self.assertIsNone(publisher.handle({"score": 0.75}, 1000))
        self.assertEqual([], sink.scores)

    def test_fall_publish_retry_does_not_require_another_detection(self):
        sink = FakeSink(failures=1)
        publisher = FallPublishCoordinator(True, sink, retry_ms=2000)

        self.assertEqual("failed", publisher.handle({"score": 0.82}, 1000))
        self.assertEqual("published", publisher.handle(None, 3000))
        self.assertEqual([0.82, 0.82], sink.scores)

    def test_fall_publish_preserves_evidence_id_across_retry(self):
        sink = FakeSink(failures=1)
        publisher = FallPublishCoordinator(True, sink, retry_ms=2000)

        record = {"score": 0.93, "evidenceId": "fall-123-7"}
        self.assertEqual("failed", publisher.handle(record, 1000))
        self.assertEqual("published", publisher.handle(None, 3000))
        self.assertEqual(["fall-123-7", "fall-123-7"], sink.evidence_ids)

    def test_stale_fall_publish_is_dropped(self):
        sink = FakeSink(failures=1)
        publisher = FallPublishCoordinator(True, sink, retry_ms=2000, ttl_ms=5000)

        self.assertEqual("failed", publisher.handle({"score": 0.88}, 1000))
        self.assertEqual("expired", publisher.handle(None, 6001))
        self.assertEqual([0.88], sink.scores)


if __name__ == "__main__":
    unittest.main()
