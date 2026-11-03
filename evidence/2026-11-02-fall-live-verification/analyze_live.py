"""analyze_live.py — 归档 2026-11-02 受控实机测试（state.csv/state2.csv + mqtt-fall.log）。

输出：
  live_events.json   状态机 episode、每个 FALLEN/SUSPECTED 的特征、负例窗口、MQTT 命令与告警
  live_summary.md    可直接引用的表格

说明：轮询是 5 Hz 快照（不是每帧推理结果），dropRate 是轮询时刻那一帧的下降速度。
用户确认的 3 个受控动作：竖向屈膝 → 朝镜头前倒 → 侧倒，对应 18:22:04 / 18:22:27 / 18:22:39。
state2.csv 另含 18:25:08 的第 4 个 FALLEN（不在用户确认的 3 次动作内），单独列出。
"""
from __future__ import annotations

import csv
import json
import os
import re
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
STATE2 = os.path.join(HERE, "state2.csv")
STATE = os.path.join(HERE, "state.csv")
MQTT = os.path.join(HERE, "mqtt-fall.log")
OUT_JSON = os.path.join(HERE, "live_events.json")
OUT_MD = os.path.join(HERE, "live_summary.md")
CST = timezone(timedelta(hours=8))
CONFIRMED = (1793614924540, 1793614947165, 1793614959744)


def fmt_ms(ms):
    return datetime.fromtimestamp(int(ms) / 1000.0, CST).strftime("%H:%M:%S.%f")[:-3]


def load_state(path):
    rows = []
    if not os.path.exists(path):
        return rows
    with open(path, encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            try:
                rows.append({
                    "ts": int(row["ts"]),
                    "state": row["state"],
                    "fall": row["fall"] == "True",
                    "person": row["personDetected"] == "True",
                    "hipY": float(row["hipY"]) if row["hipY"] else None,
                    "bottom": float(row["bboxBottom"]) if row["bboxBottom"] else None,
                    "torso": float(row["torsoAngleDeg"]) if row["torsoAngleDeg"] else None,
                    "aspect": float(row["bboxAspect"]) if row["bboxAspect"] else None,
                    "drop": float(row["dropRate"]) if row["dropRate"] else None,
                    "frames": int(row["frames"]) if row["frames"] else None,
                    "file": os.path.basename(path),
                })
            except ValueError:
                continue
    rows.sort(key=lambda r: r["ts"])
    return rows


def episodes(rows):
    out = []
    for row in rows:
        if not out or out[-1]["state"] != row["state"]:
            out.append({"state": row["state"], "start_ts": row["ts"],
                        "end_ts": row["ts"], "samples": [row]})
        else:
            out[-1]["end_ts"] = row["ts"]
            out[-1]["samples"].append(row)
    return out


def rng(rows, key):
    vals = [r[key] for r in rows if r[key] is not None]
    return (min(vals), max(vals)) if vals else (None, None)


def main():
    s2 = load_state(STATE2)
    s1 = load_state(STATE)
    eps2 = episodes(s2)
    fallen = [e for e in eps2 if e["state"] == "FALLEN"]
    suspected = [e for e in eps2 if e["state"] == "SUSPECTED"]

    events = []
    for idx, ep in enumerate(fallen, 1):
        first = ep["samples"][0]
        prev = [r for r in s2 if r["ts"] < first["ts"]][-10:]
        sus = [r for r in prev if r["state"] == "SUSPECTED"]
        events.append({
            "index": idx,
            "confirmed_by_user": first["ts"] in CONFIRMED,
            "fallen_ts": first["ts"],
            "fallen_time": fmt_ms(first["ts"]),
            "fallen_end_time": fmt_ms(ep["end_ts"]),
            "fallen_duration_s": round((ep["end_ts"] - ep["start_ts"]) / 1000.0, 2),
            "fallen_samples": len(ep["samples"]),
            "features_at_fallen": {k: first[k] for k in
                                   ("hipY", "bottom", "torso", "aspect", "drop", "person")},
            "suspected_samples": [{"ts": r["ts"], "time": fmt_ms(r["ts"]),
                                   "hipY": r["hipY"], "bottom": r["bottom"],
                                   "torso": r["torso"], "aspect": r["aspect"],
                                   "drop": r["drop"]} for r in sus],
            "pre_frames": [{"time": fmt_ms(r["ts"]), "state": r["state"],
                            "hipY": r["hipY"], "torso": r["torso"],
                            "aspect": r["aspect"], "drop": r["drop"]} for r in prev[-6:]],
        })

    # 未确认成 FALLEN 的 SUSPECTED（取消案例）
    cancelled = []
    for ep in suspected:
        nxt = [e for e in eps2 if e["start_ts"] >= ep["end_ts"] and e is not ep]
        next_state = nxt[0]["state"] if nxt else None
        if next_state == "FALLEN":
            continue
        first = ep["samples"][0]
        cancelled.append({
            "time": fmt_ms(first["ts"]), "ts": first["ts"],
            "next_state": next_state,
            "features": {k: first[k] for k in ("hipY", "bottom", "torso", "aspect", "drop")},
        })

    # 负例窗口：FALLEN 之后的 NORMAL 长段（>=20 样本）
    negatives = []
    for ep in eps2:
        if ep["state"] != "NORMAL" or len(ep["samples"]) < 20:
            continue
        if ep["start_ts"] < fallen[0]["start_ts"]:
            continue
        drop_lo, drop_hi = rng(ep["samples"], "drop")
        hip_lo, hip_hi = rng(ep["samples"], "hipY")
        torso_lo, torso_hi = rng(ep["samples"], "torso")
        negatives.append({
            "start": fmt_ms(ep["start_ts"]), "end": fmt_ms(ep["end_ts"]),
            "samples": len(ep["samples"]),
            "max_drop": drop_hi, "min_drop": drop_lo,
            "hip_y_range": [round(hip_lo, 3), round(hip_hi, 3)],
            "torso_range": [round(torso_lo, 1), round(torso_hi, 1)],
            "any_suspected_or_fallen": False,
        })

    # 主数据文件整体判定
    total_neg_samples = sum(n["samples"] for n in negatives)
    summary = {
        "primary_state_file": os.path.basename(STATE2),
        "aux_state_file": os.path.basename(STATE),
        "primary_samples": len(s2),
        "primary_window": [fmt_ms(s2[0]["ts"]), fmt_ms(s2[-1]["ts"])],
        "aux_samples": len(s1),
        "aux_window": [fmt_ms(s1[0]["ts"]), fmt_ms(s1[-1]["ts"])] if s1 else None,
        "episodes": [{"state": e["state"], "start": fmt_ms(e["start_ts"]),
                      "end": fmt_ms(e["end_ts"]), "samples": len(e["samples"])}
                     for e in eps2],
        "fallen_events": events,
        "cancelled_suspected": cancelled,
        "negative_windows": negatives,
        "negative_total_samples": total_neg_samples,
        "negative_states": ["NORMAL"],
        "negative_max_drop": max((n["max_drop"] for n in negatives if n["max_drop"] is not None),
                                 default=None),
    }
    with open(OUT_JSON, "w", encoding="utf-8") as fh:
        json.dump(summary, fh, ensure_ascii=False, indent=2)

    lines = ["# 实机测试自动汇总（analyze_live.py）", "",
             "- 主数据：`%s`（5 Hz 轮询快照），%d 样本，%s–%s" % (
                 summary["primary_state_file"], summary["primary_samples"],
                 summary["primary_window"][0], summary["primary_window"][1]),
             "- 辅助数据：`%s`，%d 样本，%s–%s（含 UNKNOWN 段）" % (
                 summary["aux_state_file"], summary["aux_samples"],
                 summary["aux_window"][0] if summary["aux_window"] else "?",
                 summary["aux_window"][1] if summary["aux_window"] else "?"),
             "", "## 状态机 episode", "",
             "| 状态 | 开始 | 结束 | 样本 |", "|---|---|---|---|"]
    for e in summary["episodes"]:
        lines.append("| %s | %s | %s | %d |" % (e["state"], e["start"], e["end"], e["samples"]))
    lines += ["", "## FALLEN 事件", "",
              "| # | 用户确认 | FALLEN 时刻 | 持续 | FALLEN 首帧特征 | SUSPECTED 帧 |",
              "|---|---|---|---|---|---|"]
    for ev in events:
        f = ev["features_at_fallen"]
        sus = "；".join("%s hipY=%.3f drop=%.3f" % (s["time"], s["hipY"], s["drop"])
                        for s in ev["suspected_samples"]) or "（轮询未捕获）"
        lines.append("| %d | %s | %s | %.2fs | hipY=%.3f bottom=%.3f torso=%.1f° aspect=%.2f drop=%.3f | %s |" % (
            ev["index"], "是" if ev["confirmed_by_user"] else "否（额外）",
            ev["fallen_time"], ev["fallen_duration_s"],
            f["hipY"], f["bottom"], f["torso"], f["aspect"], f["drop"], sus))
    if cancelled:
        lines += ["", "## 取消的 SUSPECTED（未升级为 FALLEN）", ""]
        for c in cancelled:
            f = c["features"]
            lines.append("- %s → 下一状态 %s：hipY=%.3f bottom=%.3f torso=%.1f° aspect=%.2f drop=%.3f" % (
                c["time"], c["next_state"], f["hipY"], f["bottom"], f["torso"], f["aspect"], f["drop"]))
    lines += ["", "## 负例窗口（NORMAL，全部无 SUSPECTED/FALLEN）", "",
              "| 开始 | 结束 | 样本 | drop 范围 | hipY 范围 | torso 范围 |",
              "|---|---|---|---|---|---|"]
    for n in negatives:
        lines.append("| %s | %s | %d | %s–%s | %s | %s° |" % (
            n["start"], n["end"], n["samples"], n["min_drop"], n["max_drop"],
            n["hip_y_range"], n["torso_range"]))
    lines += ["", "负例合计：%d 样本，最大 dropRate=%s" % (
        total_neg_samples, summary["negative_max_drop"])]
    with open(OUT_MD, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
