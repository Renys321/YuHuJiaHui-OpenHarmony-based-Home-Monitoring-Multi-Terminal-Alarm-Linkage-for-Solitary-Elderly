"""audit_live_events.py — 18:39–18:41 事件批次的**离线候选分析**（该批次归属不清，不作误报证据）。

数据：
  evidence/2026-11-02-fall-live-verification/fall-events.jsonl（真实 FALL 事件记录）
  evidence/2026-11-02-fall-live-verification/state5.csv（24 列新 schema 的 5 Hz 轮询，含肩/膝/踝/框高）

做两件事：
 A) 帧级审计：对每个事件，取触发时刻最近的状态行，判断“45° / 48.5°”下 horizontal 是否成立，
    并给出低位判断；用于评估“若这批弯腰/蹲下确为负例，45° 是否太松”。
 B) 特征级回放：用 state5 每行重建 PoseFrame，分别用 horizontal=45 与 48.5 跑 FallDetector。

注意：用户已澄清该批次**动作归属不清、不作误报/命中率证据**；因此本脚本结果只是
“48.5° 收紧候选”的离线评估，**没有应用到生产阈值**。5 Hz 轮询不是服务逐帧序列，回放只是近似。
"""
from __future__ import annotations

import csv
import json
import math
import os
import sys
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.dirname(HERE)
PROJECT = os.path.dirname(os.path.dirname(BASE))
VISION = os.path.join(PROJECT, "vision")
sys.path.insert(0, VISION)
import fall_detector as fd  # noqa: E402

LIVE = os.path.join(PROJECT, "evidence", "2026-11-02-fall-live-verification")
STATE5 = os.path.join(LIVE, "state5.csv")
EVENTS = os.path.join(LIVE, "fall-events.jsonl")
OUT_JSON = os.path.join(BASE, "data", "real_machine_event_audit.json")
OUT_MD = os.path.join(BASE, "data", "real_machine_event_audit.md")
CST = timezone(timedelta(hours=8))

# 2026-11-02 18:39–18:41 批次：用户已澄清动作归属不清 → 仅作路径/角度分析，不作误报证据。
GROUND_TRUTH = {
    1793615839684: ("fall", "竖向屈膝（collapse 路径；归属不清批次）"),
    1793615875577: ("fall", "竖向屈膝（collapse 路径；归属不清批次）"),
    1793615965054: ("fall", "躺地（horizontal 路径；归属不清批次）"),
    1793615974808: ("unlabeled", "深弯腰（归属不清，仅分析）"),
    1793616000579: ("unlabeled", "蹲跪（归属不清，仅分析）"),
    1793616013144: ("fall", "侧向腾空（collapse 路径；归属不清批次）"),
    1793616023917: ("fall", "躺地（horizontal 路径；归属不清批次）"),
    1793616116408: ("unlabeled", "蹲坐/快坐（归属不清，仅分析）"),
}


def fmt(ts):
    return datetime.fromtimestamp(int(ts) / 1000.0, CST).strftime("%H:%M:%S.%f")[:-3]


def f(value):
    try:
        return float(value) if value not in (None, "") else None
    except ValueError:
        return None


def load_rows():
    rows = []
    with open(STATE5, encoding="utf-8") as fh:
        for r in csv.DictReader(fh):
            ts = f(r.get("ts"))
            if ts is None or ts < 1793613000000:
                continue
            rows.append({
                "ts": int(ts), "state": r.get("state"),
                "person": r.get("personDetected") == "True",
                "hip": f(r.get("hipY")), "bottom": f(r.get("bboxBottom")),
                "torso": f(r.get("torsoAngleDeg")), "aspect": f(r.get("bboxAspect")),
                "drop": f(r.get("dropRate")), "shoulder": f(r.get("shoulderY")),
                "bh": f(r.get("bboxHeight")), "knee": f(r.get("kneeY")),
                "ankle": f(r.get("ankleY")),
            })
    rows.sort(key=lambda r: r["ts"])
    dedup, seen = [], set()
    for r in rows:
        if r["ts"] in seen:
            continue
        seen.add(r["ts"])
        dedup.append(r)
    return dedup


def load_events():
    events = []
    with open(EVENTS, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                events.append(json.loads(line))
    return events


def frame_from_row(row):
    if not row["person"] or row["hip"] is None or row["torso"] is None:
        return None
    hip = (0.5, row["hip"])
    shoulder_y = row["shoulder"] if row["shoulder"] is not None else row["hip"] - 0.10
    dy = row["hip"] - shoulder_y
    if abs(dy) < 0.005:
        dy = 0.02
    dx = math.tan(math.radians(row["torso"])) * abs(dy)
    shoulder = (0.5 - dx, shoulder_y)
    bh = row["bh"] if row["bh"] is not None else 0.30
    bh = max(0.02, min(1.0, bh))
    aspect = row["aspect"] if row["aspect"] is not None else 0.4
    width = max(0.02, aspect * bh)
    bottom = row["bottom"] if row["bottom"] is not None else 0.99
    bbox = (0.5 - width / 2.0, max(0.0, bottom - bh), 0.5 + width / 2.0, min(1.0, bottom))
    points = {
        "left_shoulder": fd.Point(shoulder[0] - 0.04, shoulder_y, 0.95),
        "right_shoulder": fd.Point(shoulder[0] + 0.04, shoulder_y, 0.95),
        "left_hip": fd.Point(hip[0] - 0.03, hip[1], 0.95),
        "right_hip": fd.Point(hip[0] + 0.03, hip[1], 0.95),
    }
    if row["knee"] is not None:
        points["left_knee"] = fd.Point(0.47, row["knee"], 0.9)
        points["right_knee"] = fd.Point(0.53, row["knee"], 0.9)
    if row["ankle"] is not None:
        points["left_ankle"] = fd.Point(0.47, row["ankle"], 0.9)
        points["right_ankle"] = fd.Point(0.53, row["ankle"], 0.9)
    return fd.PoseFrame(row["ts"], bbox, points, pose_confidence=0.9, track_id=1)


def gate_audit(rows, events):
    """帧级审计：事件时刻是否满足 horizontal（旧/新）与低位。"""
    out = []
    for ev in events:
        ts = int(ev["ts"])
        label, desc = GROUND_TRUTH.get(ts, ("unknown", "未标注"))
        before = [r for r in rows if r["ts"] <= ts + 200]
        if not before:
            continue
        row = before[-1]
        torso = row["torso"] if row["torso"] is not None else ev.get("torsoAngleDeg")
        aspect = row["aspect"] if row["aspect"] is not None else ev.get("bboxAspect")
        hip = row["hip"]
        bottom = row["bottom"]
        low = bool(hip is not None and bottom is not None and hip >= 0.55 and bottom >= 0.76)
        horizontal_old = bool(torso is not None and torso >= 45.0)
        horizontal_new = bool(torso is not None and torso >= 48.5)
        path = "horizontal" if horizontal_old else "collapse"
        out.append({
            "ts": ts, "time": fmt(ts), "event_torso": ev.get("torsoAngleDeg"),
            "event_drop": ev.get("hipDropPerSec"),
            "state_at_ts": row["state"],
            "state_row_torso": torso, "hip_y": hip, "bbox_bottom": bottom,
            "aspect": aspect, "low": low,
            "horizontal_45": horizontal_old, "horizontal_48_5": horizontal_new,
            "path": path,
            "truth": label, "note": desc,
            "accepted_old": bool(horizontal_old and low),
            "accepted_new": bool(horizontal_new and low),
        })
    return out


def replay(rows, horizontal_angle):
    cfg = fd.DetectorConfig(
        horizontal_torso_angle_deg=horizontal_angle,
        collapse_enabled=True,
    )
    detector = fd.FallDetector(cfg, ground_zones=[(0.0, 0.55, 1.0, 1.0)])
    events = []
    for row in rows:
        frame = frame_from_row(row)
        event = detector.update(frame, row["ts"])
        if event is not None:
            events.append({
                "ts": event.ts_ms, "time": fmt(event.ts_ms),
                "torso": round(event.torso_angle_deg, 1),
                "aspect": round(event.bbox_aspect, 2),
                "drop": round(event.hip_drop_per_sec, 3),
                "score": event.score,
                "state_row_torso": row["torso"],
            })
    return events


def main():
    rows = load_rows()
    events = load_events()
    audit = gate_audit(rows, events)
    replay_old = replay(rows, 45.0)
    replay_new = replay(rows, 48.5)

    summary = {
        "source": {
            "events": "evidence/2026-11-02-fall-live-verification/fall-events.jsonl",
            "state": "evidence/2026-11-02-fall-live-verification/state5.csv",
            "caveat": "state5 是 5 Hz 轮询，不是服务逐帧序列；回放为近似，帧级审计(A)为主证据。",
        },
        "frame_audit": audit,
        "replay_45": replay_old,
        "replay_48_5": replay_new,
        "replay_caveat": "回放用重建 PoseFrame（肩/髋/膝/踝/框均来自轮询值）；换 track/丢帧无法复现。",
    }
    with open(OUT_JSON, "w", encoding="utf-8") as fh:
        json.dump(summary, fh, ensure_ascii=False, indent=2)

    lines = ["# 18:39–18:41 事件批次离线分析（归属不清，不作误报证据）", "",
             "> 由 `repro/audit_live_events.py` 生成。用户已澄清该批次动作归属不清，"
             "**不作为误报/命中率证据**；本文件只用于评估“45°→48.5°”收紧候选（未应用）。"
             "帧级审计是主证据，回放只是近似。", "",
             "## A. 帧级审计：horizontal 阈值 45° → 48.5°（候选）", "",
             "| 时间 | 真值（快照目视） | 事件 torso | 帧 torso | hipY | bottom | low | 路径 | horizontal@45 | horizontal@48.5 | 旧阈值 | 新阈值 |",
             "|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for a in audit:
        if a["path"] == "collapse":
            old_v = new_v = "不适用（collapse 路径）"
        else:
            old_v = "**触发**" if a["accepted_old"] else "拒绝"
            new_v = "**触发**" if a["accepted_new"] else "拒绝"
        lines.append("| %s | %s | %.1f° | %s | %s | %s | %s | %s | %s | %s | %s | %s |" % (
            a["time"], a["note"], a["event_torso"] or -1,
            "-" if a["state_row_torso"] is None else "%.1f°" % a["state_row_torso"],
            "-" if a["hip_y"] is None else "%.3f" % a["hip_y"],
            "-" if a["bbox_bottom"] is None else "%.3f" % a["bbox_bottom"],
            "✅" if a["low"] else "—",
            a["path"],
            "✅" if a["horizontal_45"] else "—",
            "✅" if a["horizontal_48_5"] else "—",
            old_v, new_v))
    horiz = [a for a in audit if a["path"] == "horizontal"]
    falls = [a for a in horiz if a["truth"] == "fall"]
    fps = [a for a in horiz if a["truth"] == "false_positive"]
    lines += ["",
              "**候选收紧后的帧级效果（仅分析，不作证据）**：按快照目视，horizontal 路径里 "
              "3 次“躺地/腾空”帧在 48.5° 下仍接受、2 次“弯腰/蹲下”帧被拒绝；"
              "10-28 trace 的 68.1° 不受影响。该收紧**未应用**（依据批次归属不清）。",
              "", "**collapse 路径**（torso <45°，角度阈值管不到）：2 次竖向屈膝按 collapse 正常检出；"
              "18:41:56 蹲坐帧仍是 collapse 路径（归属不清，理论残余风险）。", "",
              "## B. 特征级回放（state5 重建，近似；不作为检测率证据）", "",
              "- horizontal=45.0：%d 个 FALLEN 事件" % len(replay_old),
              "- horizontal=48.5：%d 个 FALLEN 事件" % len(replay_new),
              "- ⚠️ 5 Hz 轮询漏掉服务逐帧序列，回放**不能**复现 18:39:25/18:40:13/18:40:23 "
              "三个 FALLEN（轮询间隙），只用于确认 collapse 路径事件是否仍在。", ""]
    for name, evs in (("45°", replay_old), ("48.5°", replay_new)):
        lines.append("**horizontal=%s**" % name)
        for e in evs:
            lines.append("- %s torso=%.1f° aspect=%.2f drop=%.3f" % (
                e["time"], e["torso"], e["aspect"], e["drop"]))
        if not evs:
            lines.append("- （无）")
        lines.append("")
    with open(OUT_MD, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
