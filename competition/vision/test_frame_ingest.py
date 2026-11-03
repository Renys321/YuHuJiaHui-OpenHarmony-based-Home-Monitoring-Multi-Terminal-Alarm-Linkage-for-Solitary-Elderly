import http.client
import json
import threading
import unittest
from http.server import HTTPServer
from unittest.mock import Mock

from yolo_pose_service import MonotonicWallClock, create_frame_handler


class FrameIngestTests(unittest.TestCase):
    def setUp(self):
        self.calls = []

        def process_jpeg(payload, now_ms, source_id):
            self.calls.append((payload, now_ms, source_id))
            if payload == b"bad-jpeg":
                raise ValueError("invalid JPEG payload")
            return {"ok": True, "personDetected": False, "source": source_id}

        handler = create_frame_handler(process_jpeg, max_frame_bytes=32)
        self.server = HTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.port = self.server.server_address[1]

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=2)
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        payload = json.loads(response.read().decode("utf-8"))
        connection.close()
        return response.status, payload

    def test_health(self):
        status, payload = self.request("GET", "/healthz")
        self.assertEqual(200, status)
        self.assertTrue(payload["ok"])

    def test_accepts_bounded_jpeg(self):
        status, payload = self.request(
            "POST",
            "/v1/frames/dayu200-living",
            body=b"jpeg-data",
            headers={"Content-Type": "image/jpeg"},
        )
        self.assertEqual(200, status)
        self.assertEqual("dayu200-living", payload["source"])
        self.assertEqual(b"jpeg-data", self.calls[0][0])
        self.assertGreater(self.calls[0][1], 0)

    def test_rejects_wrong_content_type(self):
        status, payload = self.request(
            "POST",
            "/v1/frames/dayu200-living",
            body=b"jpeg-data",
            headers={"Content-Type": "application/octet-stream"},
        )
        self.assertEqual(415, status)
        self.assertEqual("jpeg_required", payload["error"])
        self.assertEqual([], self.calls)

    def test_rejects_oversized_frame(self):
        status, payload = self.request(
            "POST",
            "/v1/frames/dayu200-living",
            body=b"x" * 33,
            headers={"Content-Type": "image/jpeg"},
        )
        self.assertEqual(413, status)
        self.assertEqual("frame_too_large", payload["error"])
        self.assertEqual([], self.calls)

    def test_maps_decode_error_to_422(self):
        status, payload = self.request(
            "POST",
            "/v1/frames/dayu200-living",
            body=b"bad-jpeg",
            headers={"Content-Type": "image/jpeg"},
        )
        self.assertEqual(422, status)
        self.assertEqual("invalid JPEG payload", payload["error"])

    def test_clock_never_repeats_or_moves_backwards(self):
        values = iter([10.000, 10.000, 9.500, 10.010])
        clock = MonotonicWallClock(lambda: next(values))
        self.assertEqual([10000, 10001, 10002, 10010], [clock.now_ms() for _ in range(4)])

    def test_received_milliseconds_are_monotonic(self):
        clock = MonotonicWallClock()
        self.assertEqual(
            [25000, 25001, 25002, 25010],
            [clock.observe_ms(value) for value in (25000, 25000, 24900, 25010)],
        )

    def test_client_disconnect_during_json_response_is_contained(self):
        handler_type = create_frame_handler(lambda *_: {}, max_frame_bytes=32)
        for error_type in (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            for failure_point in ("headers", "body"):
                with self.subTest(error=error_type.__name__, failure_point=failure_point):
                    handler = object.__new__(handler_type)
                    handler.send_response = Mock()
                    handler.send_header = Mock()
                    handler.end_headers = Mock()
                    handler.wfile = Mock()
                    if failure_point == "headers":
                        handler.end_headers.side_effect = error_type("client closed")
                    else:
                        handler.wfile.write.side_effect = error_type("client closed")
                    handler._send_json(200, {"ok": True})


if __name__ == "__main__":
    unittest.main()
