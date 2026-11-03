"""Deterministic local HTTP stub for DAYU fall-evidence acceptance tests.

The service deliberately returns the same evidenceId for every uploaded frame.
That makes it possible to verify on real hardware that the application captures
only one high-resolution DAYU photo per fall event. Restart it with a different
``--event-id`` to verify that a new event triggers a second photo.
"""

from __future__ import annotations

import argparse
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class AcceptanceServer(ThreadingHTTPServer):
    event_id: str
    snapshot_file: str
    request_count: int
    request_lock: threading.Lock


class Handler(BaseHTTPRequestHandler):
    server: AcceptanceServer

    def do_GET(self) -> None:  # noqa: N802 - stdlib handler API
        if self.path != "/healthz":
            self.send_error(404)
            return
        self._send_json({"ok": True, "requests": self.server.request_count})

    def do_POST(self) -> None:  # noqa: N802 - stdlib handler API
        if not self.path.startswith("/v1/frames/"):
            self.send_error(404)
            return

        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.send_error(400, "invalid Content-Length")
            return
        payload = self.rfile.read(content_length)
        with self.server.request_lock:
            self.server.request_count += 1
            request_number = self.server.request_count

        body = {
            "ok": True,
            "personDetected": True,
            "fall": True,
            "source": self.path.rsplit("/", 1)[-1],
            "event": {
                "event": "FALL",
                "evidenceId": self.server.event_id,
                "ts": 1791643200000,
                "score": 0.99,
                "snapshot": {
                    "saved": True,
                    "fileName": self.server.snapshot_file,
                    "bytes": len(payload),
                    "sha256": "acceptance-stub",
                },
            },
        }
        print(
            f"[acceptance-stub] request={request_number} bytes={len(payload)} "
            f"eventId={self.server.event_id}",
            flush=True,
        )
        self._send_json(body)

    def log_message(self, _format: str, *_args: object) -> None:
        return

    def _send_json(self, value: object) -> None:
        encoded = json.dumps(value, separators=(",", ":")).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        try:
            self.wfile.write(encoded)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            # A DAYU request may time out after the frame has already arrived.
            pass


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=9200)
    parser.add_argument("--event-id", required=True)
    parser.add_argument("--snapshot-file", required=True)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    server = AcceptanceServer((args.host, args.port), Handler)
    server.event_id = args.event_id
    server.snapshot_file = args.snapshot_file
    server.request_count = 0
    server.request_lock = threading.Lock()
    print(
        f"[acceptance-stub] listening http://{args.host}:{args.port} "
        f"eventId={args.event_id}",
        flush=True,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
