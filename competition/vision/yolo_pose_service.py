"""YOLO Pose adapter for the fall detector.

This is the one-week PC baseline. It is intentionally a thin adapter: an RKNN
runner can later create the same PoseFrame objects without changing the decision
logic or the alarm protocol.
"""

from __future__ import annotations

import argparse
import hashlib
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import math
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Callable, Optional

from fall_detector import DetectorConfig, FallDetector, FallState, PoseFrame, Zone
from frame_orientation import (
    FrameRotationError,
    OrientationObservation,
    OrientationWatchdog,
    parse_rotation,
    resolve_startup_rotation,
    rotate_image,
)
from evidence_uploader import EvidenceUploader, EvidenceUploadWorker


MAX_JPEG_BYTES = 2 * 1024 * 1024
FRAME_PATH = re.compile(r"^/v1/frames/([A-Za-z0-9._-]{1,64})$")


class FallEvidenceStore:
    """Persist the exact trigger JPEG and a bounded, atomic JSON index."""

    def __init__(self, root: Path, max_events: int = 200) -> None:
        if max_events <= 0:
            raise ValueError("max_events must be positive")
        self.root = Path(root)
        self.max_events = int(max_events)
        self.index_path = self.root / "index.json"
        self.root.mkdir(parents=True, exist_ok=True)
        self.index_trusted = True
        self.records = self._load_records()

    def event_id(self, record: dict) -> str:
        track = record.get("trackId")
        track_token = "na" if track is None else str(int(track))
        timestamp = int(record["ts"])
        used = {item.get("evidenceId") for item in self.records if isinstance(item, dict)}
        candidate = f"fall-{timestamp}-{track_token}"
        while candidate in used:
            timestamp += 1
            candidate = f"fall-{timestamp}-{track_token}"
        return candidate

    def save(self, payload: bytes, record: dict, source_id: str) -> dict:
        if not payload:
            raise ValueError("evidence JPEG must not be empty")
        if FRAME_PATH.fullmatch(f"/v1/frames/{source_id}") is None:
            raise ValueError("invalid evidence source id")

        evidence_id = str(record.get("evidenceId", "")) or self.event_id(record)
        if re.fullmatch(r"fall-[0-9]{1,16}-(?:na|[0-9]{1,12})", evidence_id) is None:
            raise ValueError("invalid evidence id")
        file_name = f"{evidence_id}-{source_id}.jpg"
        destination = self.root / file_name
        temporary = self.root / f".{file_name}.tmp"
        with temporary.open("wb") as output:
            output.write(payload)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, destination)

        entry = {
            "evidenceId": evidence_id,
            "event": "FALL",
            "ts": int(record["ts"]),
            "deviceId": source_id,
            "score": float(record["score"]),
            "trackId": record.get("trackId"),
            "fileName": file_name,
            "bytes": len(payload),
            "sha256": hashlib.sha256(payload).hexdigest().upper(),
        }
        self.records = [item for item in self.records if item.get("evidenceId") != evidence_id]
        self.records.append(entry)
        while len(self.records) > self.max_events:
            removed = self.records.pop(0)
            old_name = removed.get("fileName")
            if isinstance(old_name, str) and re.fullmatch(r"[A-Za-z0-9._-]+\.jpg", old_name):
                try:
                    (self.root / old_name).unlink()
                except FileNotFoundError:
                    pass
        self._write_index()
        return entry

    def _load_records(self) -> list[dict]:
        if not self.index_path.exists():
            return []
        try:
            value = json.loads(self.index_path.read_text(encoding="utf-8"))
            if not isinstance(value, list):
                raise ValueError("evidence index must be an array")
            required = ("evidenceId", "deviceId", "fileName", "sha256")
            for item in value:
                if not isinstance(item, dict) or any(not isinstance(item.get(key), str) for key in required):
                    raise ValueError("invalid evidence index record")
                if (re.fullmatch(r"fall-[0-9]{1,16}-(?:na|[0-9]{1,12})", item["evidenceId"]) is None
                        or re.fullmatch(r"[A-Za-z0-9._-]{1,64}", item["deviceId"]) is None
                        or re.fullmatch(r"[A-Za-z0-9._-]+\.jpg", item["fileName"]) is None
                        or re.fullmatch(r"[A-Fa-f0-9]{64}", item["sha256"]) is None):
                    raise ValueError("invalid evidence index record")
            return value
        except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError):
            self.index_trusted = False
            quarantine = self.root / f"index.corrupt-{int(time.time() * 1000)}.json"
            try:
                os.replace(self.index_path, quarantine)
            except OSError:
                pass
            print("[vision] evidence index is invalid; quarantined and rebuilt", file=sys.stderr, flush=True)
            return []

    def _write_index(self) -> None:
        temporary = self.root / ".index.json.tmp"
        with temporary.open("w", encoding="utf-8", newline="\n") as output:
            json.dump(self.records, output, ensure_ascii=False, indent=2)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, self.index_path)


class MonotonicWallClock:
    """Wall-clock milliseconds that never repeat or move backwards."""

    def __init__(self, wall_time: Callable[[], float] = time.time) -> None:
        self._wall_time = wall_time
        self._last_ms = 0

    def now_ms(self) -> int:
        return self.observe_ms(int(self._wall_time() * 1000))

    def observe_ms(self, candidate_ms: int) -> int:
        candidate = int(candidate_ms)
        self._last_ms = max(candidate, self._last_ms + 1)
        return self._last_ms


def parse_ground_zone(value: str):
    """归一化场景地面区域：4 个数字=矩形 x1,y1,x2,y2；>=6 且偶数=多边形顶点序列。

    只接受 [0,1] 内归一化坐标；不含任何家庭实际坐标的默认值（当前无 REAL 图像证据，不写死）。
    """
    parts = [item for item in re.split(r"[,;\s]+", str(value).strip()) if item]
    try:
        numbers = [float(item) for item in parts]
    except ValueError:
        raise argparse.ArgumentTypeError("ground zone must be numeric: " + str(value))
    if any(number < 0.0 or number > 1.0 for number in numbers):
        raise argparse.ArgumentTypeError("ground zone values must be normalized to [0,1]")
    if len(numbers) == 4:
        x1, y1, x2, y2 = numbers
        if x1 >= x2 or y1 >= y2:
            raise argparse.ArgumentTypeError("ground zone rect must satisfy x1<x2 and y1<y2")
        return (x1, y1, x2, y2)
    if len(numbers) >= 6 and len(numbers) % 2 == 0:
        return tuple(numbers)
    raise argparse.ArgumentTypeError("ground zone must be 4 numbers (rect) or >=6 even numbers (polygon)")


def parse_zone(value: str) -> Zone:
    parts = [float(part.strip()) for part in value.split(",")]
    if len(parts) != 4:
        raise argparse.ArgumentTypeError("zone must be x1,y1,x2,y2")
    x1, y1, x2, y2 = parts
    if not (0 <= x1 < x2 <= 1 and 0 <= y1 < y2 <= 1):
        raise argparse.ArgumentTypeError("zone coordinates must be normalized and ordered")
    return x1, y1, x2, y2


def parse_source(value: str):
    return int(value) if value.isdigit() else value


def primary_pose(result, ts_ms: int) -> Optional[PoseFrame]:
    boxes = result.boxes
    keypoints = result.keypoints
    if boxes is None or keypoints is None or len(boxes) == 0:
        return None

    xyxy = boxes.xyxy.cpu().tolist()
    confidences = boxes.conf.cpu().tolist()
    pose_points = keypoints.data.cpu().tolist()
    candidates = []
    for index, bounds in enumerate(xyxy):
        width = max(0.0, bounds[2] - bounds[0])
        height = max(0.0, bounds[3] - bounds[1])
        candidates.append((width * height * float(confidences[index]), index))
    _, selected = max(candidates)

    track_id = None
    if boxes.id is not None:
        raw_track_id = boxes.id.cpu().tolist()[selected]
        if raw_track_id is not None and math.isfinite(float(raw_track_id)):
            track_id = int(raw_track_id)
    frame_height, frame_width = result.orig_shape
    return PoseFrame.from_coco(
        ts_ms=ts_ms,
        bbox_xyxy=xyxy[selected],
        keypoints_xyc=pose_points[selected],
        image_width=frame_width,
        image_height=frame_height,
        pose_confidence=float(confidences[selected]),
        track_id=track_id,
    )


class MqttCommandSink:
    def __init__(self, node: str, tool: Path, broker: str, device_id: str) -> None:
        self.node = node
        self.tool = tool
        self.broker = broker
        self.device_id = device_id

    def publish_fall(self, score: float, evidence_id: str = "") -> None:
        message = {"cmd": "fall", "score": score, "source": "yolo-pose"}
        if evidence_id:
            message["evidenceId"] = evidence_id
        payload = json.dumps(
            message,
            ensure_ascii=False,
            separators=(",", ":"),
        )
        self._publish(payload)

    def publish_monitor(self, state: str, reason: str) -> None:
        """Tell the device that frame ingest stopped or resumed."""
        payload = json.dumps(
            {"cmd": "monitor", "state": state, "reason": reason, "source": "yolo-pose"},
            ensure_ascii=False,
            separators=(",", ":"),
        )
        self._publish(payload)

    def publish_motion(self) -> None:
        """Reset the device-side last-activity timer while a person is visible."""
        payload = json.dumps(
            {"cmd": "motion", "source": "yolo-pose"},
            ensure_ascii=False,
            separators=(",", ":"),
        )
        self._publish(payload)

    def _publish(self, payload: str) -> None:
        command = [
            self.node,
            str(self.tool),
            "pub",
            "--broker",
            self.broker,
            "--topic",
            f"home/{self.device_id}/cmd",
            "--msg",
            payload,
        ]
        completed = subprocess.run(command, capture_output=True, text=True, timeout=8)
        if completed.returncode != 0:
            raise RuntimeError(completed.stderr.strip() or completed.stdout.strip())


WATCHDOG_STARTING = "starting"
WATCHDOG_ONLINE = "online"
WATCHDOG_OFFLINE = "offline"


class FrameWatchdog:
    """Edge-triggered loss-of-contact detector for the USB sampled-frame path.

    The APP can only sample the camera surface while it is in the foreground, so
    the vision path stops as soon as the screen turns off or the app is
    backgrounded. The board cannot report that on its own (the camera is already
    released), and the PC is the only component that keeps running, so the PC
    owns the transition:

      starting --(first frame)--> online --(gap > timeout_ms)--> offline
      starting --(startup grace elapsed, still no frame)--> offline
      offline  --(frame)--> online

    Every transition is returned exactly once. A positive ``heartbeat_ms``
    repeats the *current* state without counting as a transition, so a device
    that restarted (and lost the last state) can re-learn it.
    """

    def __init__(self, timeout_ms: int, startup_grace_ms: int, heartbeat_ms: int = 60000) -> None:
        if timeout_ms <= 0:
            raise ValueError("timeout_ms must be positive")
        if startup_grace_ms <= 0:
            raise ValueError("startup_grace_ms must be positive")
        if heartbeat_ms < 0:
            raise ValueError("heartbeat_ms must not be negative")
        self.timeout_ms = int(timeout_ms)
        self.startup_grace_ms = int(startup_grace_ms)
        self.heartbeat_ms = int(heartbeat_ms)
        self.state = WATCHDOG_STARTING
        self.reason = "startup"
        self.episodes = 0
        self.started_ms = 0
        self.last_frame_ms = 0
        self.last_publish_ms = 0
        self.started = False

    def note_frame(self, now_ms: int) -> Optional[tuple[str, str, bool]]:
        self.last_frame_ms = int(now_ms)
        if self.state == WATCHDOG_ONLINE:
            return self._heartbeat(self.last_frame_ms)
        first = self.state == WATCHDOG_STARTING
        self.state = WATCHDOG_ONLINE
        self.reason = "first_frame" if first else "frames_resumed"
        return self._report(self.last_frame_ms, True)

    def poll(self, now_ms: int) -> Optional[tuple[str, str, bool]]:
        now = int(now_ms)
        if not self.started:
            # 只有"启动宽限"的基准取自首个 poll。last_publish_ms 专属于 _report()，
            # 这里绝不能重置：若首帧先于首个 poll 到达，重置会把心跳基准推迟到 poll
            # 时刻，使 heartbeat 比实际发布时刻晚一整拍。
            self.started = True
            self.started_ms = now
        if self.state == WATCHDOG_ONLINE:
            if now - self.last_frame_ms > self.timeout_ms:
                return self._enter_offline("no_frame", now)
            return self._heartbeat(now)
        if self.state == WATCHDOG_STARTING:
            if now - self.started_ms >= self.startup_grace_ms:
                return self._enter_offline("no_first_frame", now)
            return None
        return self._heartbeat(now)

    def _enter_offline(self, reason: str, now_ms: int) -> tuple[str, str, bool]:
        self.state = WATCHDOG_OFFLINE
        self.reason = reason
        self.episodes += 1
        return self._report(now_ms, True)

    def _heartbeat(self, now_ms: int) -> Optional[tuple[str, str, bool]]:
        if self.heartbeat_ms <= 0 or now_ms - self.last_publish_ms < self.heartbeat_ms:
            return None
        return self._report(now_ms, False)

    def _report(self, now_ms: int, transition: bool) -> tuple[str, str, bool]:
        self.last_publish_ms = now_ms
        return (self.state, self.reason, transition)


class MonitorReporter:
    """Publishes watchdog transitions once; never repeats them per poll.

    ``enabled`` follows ``--publish``: when publishing is disabled the
    transitions are still logged locally but nothing is written to MQTT.
    """

    def __init__(self, enabled: bool, sink: MqttCommandSink, watchdog: FrameWatchdog) -> None:
        self.enabled = enabled
        self.sink = sink
        self.watchdog = watchdog

    def note_frame(self, now_ms: int) -> None:
        self._emit(self.watchdog.note_frame(now_ms))

    def poll(self, now_ms: int) -> None:
        self._emit(self.watchdog.poll(now_ms))

    def _emit(self, event: Optional[tuple[str, str, bool]]) -> None:
        if event is None:
            return
        state, reason, transition = event
        if transition:
            print(f"[vision] monitor {state}: {reason}", file=sys.stderr, flush=True)
        if not self.enabled:
            return
        try:
            self.sink.publish_monitor(state, reason)
        except (OSError, subprocess.SubprocessError, RuntimeError) as error:
            print(f"[vision] monitor publish failed: {error}", file=sys.stderr, flush=True)


class FallPublishCoordinator:
    """Queue detector events for bounded, timer-driven MQTT delivery attempts."""

    def __init__(
        self,
        enabled: bool,
        sink: MqttCommandSink,
        retry_ms: int = 2000,
        ttl_ms: int = 30000,
    ) -> None:
        self.enabled = enabled
        self.sink = sink
        self.retry_ms = retry_ms
        self.ttl_ms = ttl_ms
        self.pending_events: list[tuple[float, str, int]] = []
        self.next_attempt_ms = 0

    def handle(self, record: Optional[dict], now_ms: int) -> Optional[str]:
        if not self.enabled:
            return None
        if record is not None:
            self.pending_events.append(
                (float(record["score"]), str(record.get("evidenceId", "")), now_ms)
            )
        expired = False
        while self.pending_events and now_ms - self.pending_events[0][2] > self.ttl_ms:
            self.pending_events.pop(0)
            expired = True
        if not self.pending_events:
            self.next_attempt_ms = 0
            return "expired" if expired else None
        if now_ms < self.next_attempt_ms:
            return None
        try:
            score, evidence_id, _ = self.pending_events[0]
            self.sink.publish_fall(score, evidence_id)
        except (OSError, subprocess.SubprocessError, RuntimeError):
            self.next_attempt_ms = now_ms + self.retry_ms
            return "failed"
        self.pending_events.pop(0)
        self.next_attempt_ms = now_ms if self.pending_events else 0
        return "published"


def log_publish_result(result: Optional[str]) -> None:
    if result == "published":
        print("[vision] FALL command published", file=sys.stderr, flush=True)
    elif result == "failed":
        print("[vision] FALL publish failed; queued for retry", file=sys.stderr, flush=True)
    elif result == "expired":
        print("[vision] stale FALL command dropped after retry timeout", file=sys.stderr, flush=True)


def build_parser() -> argparse.ArgumentParser:
    project_root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description="YOLO Pose fall detection baseline")
    parser.add_argument("--source", default="0", help="camera index, video path, or stream URL")
    parser.add_argument("--model", default="yolo11n-pose.pt")
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--imgsz", type=int, default=640)
    parser.add_argument("--model-conf", type=float, default=0.35)
    parser.add_argument(
        "--listen-host",
        default="127.0.0.1",
        help="HTTP JPEG ingestion address; keep loopback when using hdc rport",
    )
    parser.add_argument(
        "--listen-port",
        type=int,
        default=0,
        help="enable HTTP JPEG ingestion on this port; 0 disables it and opens --source",
    )
    parser.add_argument("--max-frame-bytes", type=int, default=MAX_JPEG_BYTES)
    parser.add_argument(
        "--evidence-dir",
        type=Path,
        default=project_root / "vision" / "evidence",
        help="private directory for FALL trigger JPEGs and index.json",
    )
    parser.add_argument(
        "--evidence-max-events",
        type=int,
        default=200,
        help="maximum retained FALL snapshots; oldest files are deleted first",
    )
    parser.add_argument(
        "--evidence-upload-url",
        default="",
        help="trusted backend base URL; remote targets must use HTTPS",
    )
    parser.add_argument(
        "--evidence-ingest-key-env",
        default="BACKEND_INGEST_KEY",
        help="environment variable containing the backend ingest key",
    )
    parser.add_argument(
        "--frame-timeout-ms",
        type=int,
        default=10000,
        help="report MONITOR_OFFLINE after this gap between frames (ingest mode)",
    )
    parser.add_argument(
        "--frame-startup-grace-ms",
        type=int,
        default=15000,
        help="grace before reporting MONITOR_OFFLINE while no first frame has arrived",
    )
    parser.add_argument(
        "--monitor-heartbeat-ms",
        type=int,
        default=60000,
        help="re-publish the current monitor state this often; 0 disables heartbeats",
    )
    parser.add_argument(
        "--motion-heartbeat-sec",
        type=int,
        default=45,
        help="publish a motion command this often while a person is visible; 0 disables it",
    )
    parser.add_argument("--exclude-zone", action="append", type=parse_zone, default=[])
    parser.add_argument(
        "--frame-rotation",
        default="0",
        help="rotate frames BEFORE inference: 0|90|180|270, or 'auto' (resolve once at startup; refuse if unreliable)",
    )
    parser.add_argument(
        "--ground-zone",
        action="append",
        type=parse_ground_zone,
        default=[],
        help="normalized scene ground zone (rect 4 numbers or polygon >=6 even numbers); repeatable",
    )
    parser.add_argument(
        "--rotation-calibration-samples",
        type=int,
        default=12,
        help="reliable standing samples needed to resolve --frame-rotation auto",
    )
    parser.add_argument(
        "--rotation-calibration-max-frames",
        type=int,
        default=180,
        help="give up auto rotation resolution after this many frames and demand an explicit value",
    )
    parser.add_argument(
        "--diag-conditions",
        action="store_true",
        help="print a read-only per-frame snapshot of the five fall conditions (diagnostics only)",
    )
    parser.add_argument(
        "--disable-collapse",
        action="store_true",
        help="disable the orientation-agnostic fast-collapse fall path (2026-11-02); "
             "use for A/B on a real camera without changing code",
    )
    parser.add_argument("--publish", action="store_true", help="publish a real FALL command")
    parser.add_argument("--broker", default="127.0.0.1:1883")
    parser.add_argument("--target-device", default="dayu200-living")
    parser.add_argument("--node", default="node")
    parser.add_argument(
        "--mqtt-tool",
        type=Path,
        default=project_root / "bridge" / "mqtt_tool.js",
    )
    return parser


def track_pose_stream(model, source, model_conf: float, imgsz: int, device: str):
    """Start rectangular streaming inference without coupling tests to Ultralytics."""
    return model.track(
        source=source,
        stream=True,
        persist=True,
        tracker="bytetrack.yaml",
        rect=True,
        verbose=False,
        conf=model_conf,
        imgsz=imgsz,
        device=device,
    )


def event_record(event) -> dict:
    return {
        "event": "FALL",
        "ts": event.ts_ms,
        "score": event.score,
        "trackId": event.track_id,
        "torsoAngleDeg": round(event.torso_angle_deg, 1),
        "bboxAspect": round(event.bbox_aspect, 2),
        "hipDropPerSec": round(event.hip_drop_per_sec, 3),
    }


_LAST_STATE: dict = {"ts": 0, "state": "UNKNOWN", "personDetected": False, "trackId": None,
                    "fall": False, "features": None, "dropRate": 0.0, "frames": 0,
                    "collapse": None, "framing": None}


def process_result(result, detector: FallDetector, now_ms: int) -> tuple[dict, Optional[dict]]:
    pose = primary_pose(result, now_ms)
    event = detector.update(pose, now_ms)
    feat = detector._last_features
    snap = detector.snapshot(now_ms)
    _LAST_STATE["ts"] = now_ms
    _LAST_STATE["state"] = detector.state.value
    _LAST_STATE["personDetected"] = pose is not None
    _LAST_STATE["trackId"] = None if pose is None else pose.track_id
    _LAST_STATE["fall"] = detector.state == FallState.FALLEN
    _LAST_STATE["dropRate"] = round(float(detector._latest_drop_rate), 3)
    _LAST_STATE["frames"] = _LAST_STATE.get("frames", 0) + 1
    _LAST_STATE["features"] = None if feat is None else {
        "hipY": round(feat.hip_y, 3), "bboxBottom": round(feat.bbox_bottom, 3),
        "torsoAngleDeg": round(feat.torso_angle_deg, 1), "bboxAspect": round(feat.bbox_aspect, 2),
        "centerY": round(feat.center_y, 3),
        # 2026-11-02 收尾：真机标定"髋-膝-踝几何"与"触底瞬时速度"所需的只读诊断量。
        "shoulderY": round(feat.shoulder_y, 3),
        "bboxHeight": round(feat.bbox_height, 3),
        "kneeY": None if feat.knee_y is None else round(feat.knee_y, 3),
        "ankleY": None if feat.ankle_y is None else round(feat.ankle_y, 3),
        # 构图诊断：True = 框底触底/下肢被切，髋位与 upright 不可信。
        "bottomClipped": bool(feat.bottom_clipped),
    }
    _LAST_STATE["collapse"] = snap.get("collapse")
    _LAST_STATE["suspectedMode"] = snap.get("suspected_mode")
    # 2026-11-02 现场教训（18:31 批次作废）：近景/下肢截断时关键点与髋位不可信，
    # 必须把"构图无效"作为现场告警字段暴露，避免在无效构图上得出性能结论。
    # 判据（与 docs/KNOWN-RISKS.md「机位/构图前提」一致）：
    #   框底触底（下肢被切）或 站立帧髋部投影 hipY >= 0.70（离相机太近）。
    hip_y = None if feat is None else feat.hip_y
    near_camera_standing = bool(
        feat is not None and snap.get("standing") and hip_y is not None and hip_y >= 0.70
    )
    _LAST_STATE["framing"] = {
        "bottomClipped": bool(feat is not None and feat.bottom_clipped),
        "hipY": None if hip_y is None else round(hip_y, 3),
        "bboxBottom": None if feat is None else round(feat.bbox_bottom, 3),
        "suspectInvalid": bool(
            feat is not None
            and (feat.bottom_clipped or feat.bbox_bottom >= 0.97 or near_camera_standing)
        ),
    }
    response = {
        "ok": True,
        "personDetected": pose is not None,
        "trackId": None if pose is None else pose.track_id,
        "fall": detector.state == FallState.FALLEN,
        "state": detector.state.value,
    }
    return response, None if event is None else event_record(event)


def decode_jpeg(payload: bytes):
    import cv2
    import numpy as np

    encoded = np.frombuffer(payload, dtype=np.uint8)
    frame = cv2.imdecode(encoded, cv2.IMREAD_COLOR)
    if frame is None or frame.size == 0:
        raise ValueError("invalid JPEG payload")
    return frame


def create_frame_handler(
    process_jpeg: Callable[[bytes, int, str], dict], max_frame_bytes: int
) -> type[BaseHTTPRequestHandler]:
    if max_frame_bytes <= 0:
        raise ValueError("max_frame_bytes must be positive")

    class FrameHandler(BaseHTTPRequestHandler):
        server_version = "ElderCareVision/1.0"

        def do_GET(self) -> None:
            if self.path == "/healthz":
                self._send_json(200, {"ok": True})
            elif self.path == "/v1/state":
                now_ms = int(time.time() * 1000)
                snap = dict(_LAST_STATE)
                snap["ageMs"] = now_ms - int(snap.get("ts", 0))
                self._send_json(200, snap)
            else:
                self._send_json(404, {"ok": False, "error": "not_found"})

        def do_POST(self) -> None:
            match = FRAME_PATH.fullmatch(self.path)
            if match is None:
                self._send_json(404, {"ok": False, "error": "not_found"})
                return
            content_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
            if content_type != "image/jpeg":
                self._send_json(415, {"ok": False, "error": "jpeg_required"})
                return
            raw_length = self.headers.get("Content-Length", "")
            try:
                content_length = int(raw_length)
            except ValueError:
                self._send_json(411, {"ok": False, "error": "content_length_required"})
                return
            if content_length <= 0:
                self._send_json(400, {"ok": False, "error": "empty_frame"})
                return
            if content_length > max_frame_bytes:
                self._send_json(413, {"ok": False, "error": "frame_too_large"})
                return
            payload = self.rfile.read(content_length)
            if len(payload) != content_length:
                self._send_json(400, {"ok": False, "error": "incomplete_frame"})
                return
            try:
                result = process_jpeg(payload, int(time.time() * 1000), match.group(1))
            except ValueError as error:
                self._send_json(422, {"ok": False, "error": str(error)})
                return
            except Exception as error:
                print(f"[vision] frame processing failed: {error}", file=sys.stderr, flush=True)
                self._send_json(500, {"ok": False, "error": "processing_failed"})
                return
            self._send_json(200, result)

        def _send_json(self, status: int, payload: dict) -> None:
            body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            try:
                self.send_response(status)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                # DAYU enforces a strict request deadline and can destroy the
                # socket after processing completed. Do not emit a server stack.
                return

        def log_message(self, format: str, *args) -> None:
            return

    return FrameHandler


def run_http_ingest(args, model, detector: FallDetector, sink: MqttCommandSink) -> int:
    clock = MonotonicWallClock()
    publisher = FallPublishCoordinator(args.publish, sink)
    watchdog = FrameWatchdog(
        args.frame_timeout_ms, args.frame_startup_grace_ms, args.monitor_heartbeat_ms
    )
    monitor = MonitorReporter(args.publish, sink, watchdog)
    evidence = FallEvidenceStore(args.evidence_dir, args.evidence_max_events)
    upload_worker = None
    if args.evidence_upload_url:
        ingest_key = os.environ.get(args.evidence_ingest_key_env, "")
        if ingest_key:
            upload_worker = EvidenceUploadWorker(
                EvidenceUploader(args.evidence_upload_url, ingest_key),
                capacity=min(args.evidence_max_events, 200),
                outbox_root=evidence.root,
                index_entries=evidence.records if evidence.index_trusted else None,
            )
        else:
            print(
                f"[vision] evidence upload disabled: environment {args.evidence_ingest_key_env} is empty",
                file=sys.stderr,
                flush=True,
            )

    # ---- 方向合同（2026-10-17）：显式锁定或启动期一次性解析；锁定后运行期监测变化 ----
    try:
        locked_rotation = parse_rotation(args.frame_rotation)
        auto_rotation = False
    except FrameRotationError:
        if str(args.frame_rotation).strip().lower() == "auto":
            locked_rotation = None
            auto_rotation = True
        else:
            raise
    orientation = {
        "rotation": locked_rotation,
        "auto": auto_rotation,
        "observations": [],
        "frames": 0,
        "refused": False,
        "suspended": bool(auto_rotation),   # auto 未解析前一律不判定/不发布
        # Keep the watchdog in mutable state. Assigning a closure-local variable
        # during auto resolution makes explicit-rotation requests fail before
        # their first frame can be processed.
        "watchdog": OrientationWatchdog(locked_rotation) if locked_rotation is not None else None,
    }
    if locked_rotation is not None:
        print(f"[vision] frame rotation locked: {locked_rotation}", file=sys.stderr, flush=True)

    def observe_orientation(result, received_ms: int) -> Optional[OrientationObservation]:
        """从单帧结果提取方向观测（只含非敏感几何量）。"""
        try:
            height, width = result.orig_shape
            pose = primary_pose(result, received_ms)
            if pose is None:
                return None
            features = detector.features(pose)
            reliable = bool(
                features.valid and features.torso_angle_deg <= detector.config.upright_torso_angle_deg
            )
            return OrientationObservation(int(width), int(height), float(features.shoulder_hip_dy), reliable)
        except Exception:
            return None

    motion_state = {"ts": 0}

    def process_jpeg(payload: bytes, received_ms: int, source_id: str) -> dict:
        raw = decode_jpeg(payload)
        rotation = orientation["rotation"] if orientation["rotation"] is not None else 0
        frame = rotate_image(raw, rotation)
        results = track_pose_stream(model, frame, args.model_conf, args.imgsz, args.device)
        result = next(iter(results))
        now_ms = clock.observe_ms(received_ms)

        if orientation["auto"] and orientation["rotation"] is None:
            # 启动期一次性解析：只收集观测，不做任何判定、不发 FALL
            # 校准帧仍是真实在线帧，必须喂给监控看门狗，避免等待可靠站立
            # 样本时误报 MONITOR_OFFLINE。
            monitor.note_frame(now_ms)
            if orientation["refused"]:
                return {
                    "ok": True,
                    "personDetected": False,
                    "fall": False,
                    "rotation": "refused",
                    "suspended": True,
                    "refused": True,
                    "source": source_id,
                }
            orientation["frames"] += 1
            observation = observe_orientation(result, now_ms)
            if observation is not None:
                orientation["observations"].append(observation)
            resolution = resolve_startup_rotation(
                orientation["observations"],
                min_reliable=max(1, args.rotation_calibration_samples),
                expected_landscape=True,   # 该机位真实预览为 4:3 横向（640x480）
            )
            if resolution.rotation is not None:
                orientation["rotation"] = resolution.rotation
                orientation["suspended"] = False
                orientation["watchdog"] = OrientationWatchdog(resolution.rotation)
                print(
                    "[vision] frame rotation auto-resolved: %d (%s, samples=%d)"
                    % (resolution.rotation, resolution.reason, resolution.samples),
                    file=sys.stderr,
                    flush=True,
                )
            elif orientation["frames"] >= max(1, args.rotation_calibration_max_frames):
                orientation["refused"] = True
                orientation["observations"].clear()
                print(
                    "[vision] frame rotation auto-resolution REFUSED (%s): "
                    "restart with an explicit --frame-rotation 0|90|180|270" % resolution.reason,
                    file=sys.stderr,
                    flush=True,
                )
            return {
                "ok": True,
                "personDetected": False,
                "fall": False,
                "rotation": orientation["rotation"] if orientation["rotation"] is not None else
                    ("refused" if orientation["refused"] else "calibrating"),
                "reason": resolution.reason,
                "suspended": orientation["rotation"] is None,
                "refused": orientation["refused"],
                "source": source_id,
            }

        rotation_watchdog = orientation["watchdog"]
        if rotation_watchdog is not None:
            observation = observe_orientation(result, now_ms)
            if observation is not None:
                change = rotation_watchdog.observe(observation)
                if change.detected and not orientation["suspended"]:
                    orientation["suspended"] = True
                    print(
                        "[vision] frame orientation CHANGE detected (%s: %s); "
                        "FALL publish suspended, restart to re-lock" % (change.kind, change.detail),
                        file=sys.stderr,
                        flush=True,
                    )

        if orientation["suspended"]:
            # 方向不可信：不判定、不产生证据、不发 FALL；仅维持接帧与 watchdog
            monitor.note_frame(now_ms)
            return {
                "ok": True,
                "rotation": orientation["rotation"],
                "suspended": True,
                "refused": orientation["refused"],
                "source": source_id,
            }

        response, record = process_result(result, detector, now_ms)
        # 有人活动心跳：让设备侧 lastActiveTs 保持新鲜，避免 NO_MOTION 反复抢占 FALL。
        if (args.publish and args.motion_heartbeat_sec > 0
                and _LAST_STATE.get("personDetected") and _LAST_STATE.get("features")):
            last_motion = int(motion_state.get("ts", 0))
            if now_ms - last_motion >= args.motion_heartbeat_sec * 1000:
                motion_state["ts"] = now_ms
                try:
                    sink.publish_motion()
                except Exception as error:
                    print(f"[vision] motion heartbeat failed: {error}", file=sys.stderr, flush=True)
        if args.diag_conditions:
            try:
                print(
                    "[vision][diag] " + json.dumps(detector.snapshot(now_ms), ensure_ascii=False, separators=(",", ":")),
                    file=sys.stderr,
                    flush=True,
                )
            except Exception:
                pass
        response["source"] = source_id
        if record is not None:
            record["evidenceId"] = evidence.event_id(record)
            snapshot = None
            try:
                snapshot = evidence.save(payload, record, source_id)
                record["snapshot"] = {
                    "saved": True,
                    "fileName": snapshot["fileName"],
                    "bytes": snapshot["bytes"],
                    "sha256": snapshot["sha256"],
                }
            except Exception as error:
                record["snapshot"] = {"saved": False}
                print(f"[vision] FALL evidence save failed: {error}", file=sys.stderr, flush=True)
            if snapshot is not None and upload_worker is not None:
                try:
                    if evidence.index_trusted:
                        upload_worker.reconcile(evidence.records)
                    upload_worker.submit(snapshot, evidence.root / snapshot["fileName"])
                except Exception as error:
                    print(f"[vision] FALL evidence upload registration failed: {error}", file=sys.stderr, flush=True)
            response["event"] = record
            print(json.dumps(record, ensure_ascii=False), flush=True)
        monitor.note_frame(now_ms)
        log_publish_result(publisher.handle(record, now_ms))
        return response

    handler = create_frame_handler(process_jpeg, args.max_frame_bytes)
    server = HTTPServer((args.listen_host, args.listen_port), handler)
    server.timeout = 0.25
    print(
        f"[vision] HTTP JPEG ingest listening on {args.listen_host}:{args.listen_port}",
        file=sys.stderr,
        flush=True,
    )
    print(
        f"[vision] monitor watchdog: timeout={args.frame_timeout_ms}ms "
        f"startup-grace={args.frame_startup_grace_ms}ms heartbeat={args.monitor_heartbeat_ms}ms",
        file=sys.stderr,
        flush=True,
    )
    try:
        while True:
            server.handle_request()
            now_ms = clock.now_ms()
            log_publish_result(publisher.handle(None, now_ms))
            monitor.poll(now_ms)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        if upload_worker is not None:
            upload_worker.close()
    return 0


def main() -> int:
    args = build_parser().parse_args()
    config_dir = Path(__file__).resolve().parent / ".ultralytics"
    config_dir.mkdir(exist_ok=True)
    os.environ.setdefault("YOLO_CONFIG_DIR", str(config_dir))
    try:
        from ultralytics import YOLO
    except ImportError:
        print(
            "Missing ultralytics. Create the vision virtual environment and install "
            "vision/requirements-pc.txt first.",
            file=sys.stderr,
        )
        return 2

    # ground-zone 与 exclude-zone 明显重叠 -> fail closed（床/沙发不得同时当地板区域）
    conflicts = FallDetector.find_zone_conflicts(args.ground_zone, args.exclude_zone)
    if conflicts:
        for problem in conflicts:
            print(f"[vision] ground zone config REJECTED: {problem}", file=sys.stderr, flush=True)
        return 2
    detector = FallDetector(
        DetectorConfig(collapse_enabled=not args.disable_collapse),
        excluded_zones=args.exclude_zone,
        ground_zones=args.ground_zone,
    )
    sink = MqttCommandSink(args.node, args.mqtt_tool, args.broker, args.target_device)
    model = YOLO(args.model)
    if args.listen_port < 0 or args.listen_port > 65535:
        print("--listen-port must be between 0 and 65535", file=sys.stderr)
        return 2
    if (args.frame_timeout_ms <= 0 or args.frame_startup_grace_ms <= 0
            or args.monitor_heartbeat_ms < 0 or args.evidence_max_events <= 0
            or args.evidence_max_events > 200):
        print(
            "--frame-timeout-ms and --frame-startup-grace-ms must be positive; "
            "--monitor-heartbeat-ms must not be negative; "
            "--evidence-max-events must be in [1, 200]",
            file=sys.stderr,
        )
        return 2
    if args.listen_port > 0:
        return run_http_ingest(args, model, detector, sink)
    # --source（文件/本机摄像头）模式不启用失联 watchdog：帧由本进程同步消费，
    # 没有"远端送帧中断"这一失败模式。
    source = parse_source(args.source)
    clock = MonotonicWallClock()
    publisher = FallPublishCoordinator(args.publish, sink)

    results = track_pose_stream(model, source, args.model_conf, args.imgsz, args.device)
    for result in results:
        now_ms = clock.now_ms()
        _, record = process_result(result, detector, now_ms)
        if record is not None:
            print(json.dumps(record, ensure_ascii=False), flush=True)
        log_publish_result(publisher.handle(record, now_ms))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

