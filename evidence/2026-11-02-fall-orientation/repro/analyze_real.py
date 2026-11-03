"""analyze_real.py — 用真实 DAYU 关键点事件回放并统计"方向不敏感判据"所需的量。

只读 evidence/*.jsonl（p1b 事件包，含原始像素 keypoints），产出：
  data/real_replay_summary.json   每个真实会话的回放结果（当前检测器事件数、误报）
  data/real_features.csv          逐帧特征（真实数据）
并打印控制下降 / 安全动作的关键统计，用于阈值标定。
"""
from __future__ import annotations

import collections
import csv
import json
import os
import sys

REPRO = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.dirname(REPRO)                       # evidence/2026-11-02-fall-orientation
PROJECT = os.path.dirname(os.path.dirname(BASE))    # competition
sys.path.insert(0, os.path.join(PROJECT, "vision"))

from fall_detector import FallDetector, FallState, PoseFrame, COCO_KEYPOINT_NAMES  # noqa: E402

EV = os.path.join(PROJECT, "evidence")
IMG_W, IMG_H = 640, 480
FILES = [
    "2026-10-25-dayu-formal-camera-inference-regression/formal-pose-events.jsonl",
    "2026-10-25-dayu-formal-camera-inference-regression/formal-live-events.jsonl",
    "2026-10-25-dayu-formal-camera-inference-regression/formal-redo-events.jsonl",
    "2026-10-25-dayu-formal-camera-inference-regression/formal-redo3-events.jsonl",
    "2026-10-25-dayu-formal-camera-inference-regression/formal-capture-events.jsonl",
    "2026-10-26-demo-autostart/demo-events-mid.jsonl",
]


def load(path):
    rows = []
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    rows.sort(key=lambda r: r.get("eventTsMs") or r.get("frameTsMs") or 0)
    return rows


def to_frame(row):
    """真实事件 -> PoseFrame；无效帧返回 None。"""
    if not row.get("dataValid"):
        return None
    kpts = row.get("primaryKeypoints") or []
    if len(kpts) < 17:
        return None
    bbox = row.get("primaryBBox") or []
    if len(bbox) != 4:
        return None
    return PoseFrame.from_coco(
        ts_ms=int(row.get("eventTsMs") or row.get("frameTsMs") or 0),
        bbox_xyxy=bbox,
        keypoints_xyc=kpts,
        image_width=IMG_W,
        image_height=IMG_H,
        pose_confidence=float(row.get("postureConfidence") or 1.0),
        track_id=1,
    )


def main():
    out_dir = os.path.join(BASE, "data")
    os.makedirs(out_dir, exist_ok=True)
    csv_path = os.path.join(out_dir, "real_features.csv")
    summary = {}
    rows_out = []
    for rel in FILES:
        path = os.path.join(EV, rel)
        raw = load(path)
        if not raw:
            continue
        detector = FallDetector()
        events = []
        feats = {}
        peaks = []
        last_ts = None
        dts = []
        for row in raw:
            ts = int(row.get("eventTsMs") or row.get("frameTsMs") or 0)
            frame = to_frame(row)
            ev = detector.update(frame, ts)
            if last_ts is not None:
                dts.append(ts - last_ts)
            last_ts = ts
            if ev is not None:
                events.append({"ts": ev.ts_ms, "score": ev.score,
                               "torso": round(ev.torso_angle_deg, 1),
                               "aspect": round(ev.bbox_aspect, 2),
                               "drop": round(ev.hip_drop_per_sec, 3)})
            if detector._last_features is not None and detector._last_features.valid:
                f = detector._last_features
                feats[ts] = f
                rows_out.append({
                    "session": rel.split("/")[0] + "/" + os.path.basename(rel),
                    "ts_ms": ts,
                    "posture": row.get("posture"),
                    "hip_y": round(f.hip_y, 4),
                    "hip_x": round(f.hip_x, 4),
                    "shoulder_y": round(_shoulder_y(row, f), 4),
                    "torso_angle_deg": round(f.torso_angle_deg, 2),
                    "bbox_aspect": round(f.bbox_aspect, 3),
                    "bbox_height": round(f.bbox_y2 - f.bbox_y1, 4),
                    "bbox_bottom": round(f.bbox_bottom, 4),
                    "bbox_top": round(f.bbox_y1, 4),
                    "ankle_y": _num(_ankle_y(row)),
                    "knee_y": _num(_mid_y(row, 13, 14)),
                    "drop_rate": round(detector._latest_drop_rate, 4),
                    "shoulder_hip_dy": round(f.shoulder_hip_dy, 4),
                })
                if detector._latest_drop_rate >= 0.10:
                    peaks.append({
                        "ts": ts, "drop": round(detector._latest_drop_rate, 3),
                        "posture": row.get("posture"), "hip_y": round(f.hip_y, 3),
                        "torso": round(f.torso_angle_deg, 1),
                        "aspect": round(f.bbox_aspect, 2),
                    })
        dts = sorted(d for d in dts if d > 0)
        summary[rel] = {
            "frames": len(raw),
            "duration_s": round((last_ts - int(raw[0].get("eventTsMs") or raw[0].get("frameTsMs"))) / 1000.0, 1),
            "dt_median_ms": dts[len(dts) // 2] if dts else None,
            "posture_counts": dict(collections.Counter(r.get("posture") for r in raw)),
            "fall_events": events,
            "fall_event_count": len(events),
            "frames_with_drop_ge_010": len(peaks),
            "rapid_drop_samples": peaks[:12],
        }
    with open(csv_path, "w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(rows_out[0].keys()))
        writer.writeheader()
        writer.writerows(rows_out)
    with open(os.path.join(out_dir, "real_replay_summary.json"), "w", encoding="utf-8") as fh:
        json.dump(summary, fh, ensure_ascii=False, indent=2)
    print(json.dumps({k: {kk: vv for kk, vv in v.items() if kk != "rapid_drop_samples"}
                      for k, v in summary.items()}, ensure_ascii=False, indent=2))
    for k, v in summary.items():
        if v["rapid_drop_samples"]:
            print("\n##", k)
            for s in v["rapid_drop_samples"]:
                print("  ", s)


def _num(value, places=4):
    return round(value, places) if isinstance(value, (int, float)) else ""


def _kpt(row, idx):
    k = row.get("primaryKeypoints") or []
    if len(k) <= idx:
        return None
    return k[idx]


def _mid_y(row, a, b):
    ka, kb = _kpt(row, a), _kpt(row, b)
    if not ka or not kb:
        return ""
    if len(ka) < 3 or len(kb) < 3 or ka[2] < 0.35 or kb[2] < 0.35:
        return ""
    return (ka[1] + kb[1]) / 2.0 / IMG_H


def _shoulder_y(row, feat):
    v = _mid_y(row, 5, 6)
    return v if v != "" else (feat.hip_y - feat.shoulder_hip_dy)


def _ankle_y(row):
    return _mid_y(row, 15, 16)


if __name__ == "__main__":
    main()
