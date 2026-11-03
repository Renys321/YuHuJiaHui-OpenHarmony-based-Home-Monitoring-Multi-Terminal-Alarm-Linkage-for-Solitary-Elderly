"""replay_demo_trace.py — 用 2026-10-28 现场演示 trace 复现"180° 用例必须保持通过"。

数据：evidence/2026-10-28-fall-live-test/trace-live.log（唯一一次真实现场成功触发
NORMAL→SUSPECTED→FALLEN 的逐帧记录）。trace 只记录特征值（hipY/bottom/angle/aspect/drop/
person/track），因此这里按记录值**反推**一个等价 PoseFrame：
  - hip = (0.5, hipY)；
  - |dx_norm| = tan(angle) * dy_norm，dy_norm 取 0.10（角度与尺度无关）；
  - bbox 高度取 0.30，宽 = aspect * 高度，底边 = bottom，中心 x = hip.x。
这不是逐像素真机复现，而是"给定服务当时记录的特征值，判定状态机是否仍然触发"的回归。

输出：data/demo_trace_replay.json —— baseline 与 patched 的事件时刻/状态是否一致。
"""
from __future__ import annotations

import importlib.util
import json
import math
import os
import re
import sys

REPRO = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.dirname(REPRO)
PROJECT = os.path.dirname(os.path.dirname(BASE))
VISION = os.path.join(PROJECT, "vision")
sys.path.insert(0, VISION)
TRACE = os.path.join(PROJECT, "evidence", "2026-10-28-fall-live-test", "trace-live.log")

LINE = re.compile(
    r"(?P<h>\d{2}):(?P<m>\d{2}):(?P<s>\d{2})\.(?P<ms>\d{3})\s+"
    r"state=(?P<state>\w+)\s+person=(?P<person>True|False)\s+"
    r"hipY=(?P<hip>[\d.]+)\s+bottom=(?P<bottom>[\d.]+)\s+"
    r"angle=(?P<angle>[\d.]+)\s+aspect=(?P<aspect>[\d.]+)\s+"
    r"drop=(?P<drop>[\d.]+)\s+track=(?P<track>\d*)"
)


def load_baseline():
    path = os.path.join(REPRO, "fall_detector_baseline.py")
    spec = importlib.util.spec_from_file_location("fall_detector_baseline", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules["fall_detector_baseline"] = module
    spec.loader.exec_module(module)
    return module


def load_patched():
    import fall_detector
    return fall_detector


def parse_trace(path):
    frames = []
    day_start = None
    with open(path, encoding="utf-8-sig") as fh:
        for line in fh:
            m = LINE.search(line)
            if not m:
                continue
            h, mi, s, ms = (int(m.group(k)) for k in ("h", "m", "s", "ms"))
            t = ((h * 60 + mi) * 60 + s) * 1000 + ms
            if day_start is None:
                day_start = t
            frames.append({
                "ts": t - day_start,
                "person": m.group("person") == "True",
                "hip": float(m.group("hip")),
                "bottom": float(m.group("bottom")),
                "angle": float(m.group("angle")),
                "aspect": float(m.group("aspect")),
                "drop": float(m.group("drop")),
                "track": int(m.group("track")) if m.group("track") else None,
            })
    return frames


def reconstruct(module, item):
    """按 trace 特征值反推 PoseFrame（见模块 docstring 的假设）。"""
    if not item["person"]:
        return None
    dy = 0.10
    dx = math.tan(math.radians(item["angle"])) * dy
    hip = (0.5, item["hip"])
    shoulder = (0.5 - dx, item["hip"] - dy)
    height = 0.30
    width = item["aspect"] * height
    bbox = (hip[0] - width / 2.0, item["bottom"] - height,
            hip[0] + width / 2.0, item["bottom"])
    points = {
        "left_shoulder": module.Point(shoulder[0] - 0.02, shoulder[1], 0.95),
        "right_shoulder": module.Point(shoulder[0] + 0.02, shoulder[1], 0.95),
        "left_hip": module.Point(hip[0] - 0.02, hip[1], 0.95),
        "right_hip": module.Point(hip[0] + 0.02, hip[1], 0.95),
    }
    return module.PoseFrame(item["ts"], bbox, points, pose_confidence=0.9,
                            track_id=item["track"])


def replay(module, frames):
    detector = module.FallDetector()
    events = []
    for item in frames:
        frame = reconstruct(module, item)
        event = detector.update(frame, item["ts"])
        if event is not None:
            events.append({"ts": event.ts_ms, "state": detector.state.value,
                           "score": event.score,
                           "torso": round(event.torso_angle_deg, 1),
                           "aspect": round(event.bbox_aspect, 2),
                           "drop": round(event.hip_drop_per_sec, 3)})
    return {"events": events, "final_state": detector.state.value}


def main():
    trace = parse_trace(TRACE)
    baseline = replay(load_baseline(), trace)
    patched = replay(load_patched(), trace)
    out = {
        "source": "evidence/2026-10-28-fall-live-test/trace-live.log",
        "trace_frames": len(trace),
        "person_frames": sum(1 for t in trace if t["person"]),
        "baseline": baseline,
        "patched": patched,
        "same_event_timing": [e["ts"] for e in baseline["events"]] ==
                             [e["ts"] for e in patched["events"]],
        "note": "特征级反推回放（非逐帧真机复现）；用于确认 180° 演示用例未被补丁破坏",
    }
    os.makedirs(os.path.join(BASE, "data"), exist_ok=True)
    with open(os.path.join(BASE, "data", "demo_trace_replay.json"), "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=2)
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
