"""archive_summary.py — 归档 2026-11-02 跌倒实机测试（主结果 / 有效负例 / 作废批次）。

按 Lead 确认的口径分类（不把作废批次并入性能统计）：
  1) 主结果：18:22:04 / 18:22:27 / 18:22:39 / 18:25:08 共 4 次**受控跌倒**，全部正确检出；
     手机/板端告警正常（用户现场确认）。
  2) 有效负例：18:26:06–18:26:41 快速深蹲/快坐到地面，0 误报（旧代码）。
  3) 作废批次：18:31:18–18:34:17 批量采集，整段 bboxBottom≈0.998–1.0（腿被切）、
     hipY 0.50–0.97 抖动 → 构图无效，**不作性能依据**（其中 FALLEN/SUSPECTED 仅记录）。

数据：state2.csv / state3.csv / state4.csv（现场轮询，可能仍在追加）+ mqtt-fall.log。
为可复现，脚本只统计**固定时间窗**；输出 live_archive_summary.json / .md。
"""
from __future__ import annotations

import csv
import glob
import json
import os
import re
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
CST = timezone(timedelta(hours=8))
OUT_JSON = os.path.join(HERE, "live_archive_summary.json")
OUT_MD = os.path.join(HERE, "live_archive_summary.md")

MAIN_EVENTS = [
    (1793614924540, "18:22:04", "第 1 次受控跌倒（用户确认动作顺序第 1：竖向屈膝）"),
    (1793614947165, "18:22:27", "第 2 次受控跌倒（动作顺序第 2：朝镜头前倒）"),
    (1793614959744, "18:22:39", "第 3 次受控跌倒（动作顺序第 3：侧倒）"),
    (1793615108855, "18:25:08", "第 4 次受控跌倒（用户补充确认：主动受控跌倒）"),
]
EFFECTIVE_NEG = (1793615166869, 1793615201000)   # 18:26:06.869 – 18:26:41
VOID_BATCH = (1793615478000, 1793615657000)      # 18:31:18 – 18:34:17


def ts_of(hms):
    hh, mm, ss = (int(x) for x in hms.split(":"))
    return int(datetime(2026, 11, 2, hh, mm, ss, tzinfo=CST).timestamp() * 1000)


VOID_BATCH_2 = (ts_of("18:36:26"), ts_of("18:38:17"))  # 新补丁加载后仍构图无效的批次


def fmt(ms):
    return datetime.fromtimestamp(int(ms) / 1000.0, CST).strftime("%H:%M:%S.%f")[:-3]


def load_all():
    rows = []
    for path in sorted(glob.glob(os.path.join(HERE, "state*.csv"))):
        with open(path, encoding="utf-8") as fh:
            for row in csv.DictReader(fh):
                try:
                    ts = int(row["ts"])
                except (KeyError, TypeError, ValueError):
                    continue
                # 过滤 ts=0（服务未启动时的占位状态）与本测试日窗口外的行。
                if ts < 1793613000000 or ts > 1793620000000:
                    continue
                rows.append({
                    "ts": ts, "file": os.path.basename(path),
                    "state": row.get("state"),
                    "fall": row.get("fall") == "True",
                    "person": row.get("personDetected") == "True",
                    "hipY": _f(row.get("hipY")), "bottom": _f(row.get("bboxBottom")),
                    "torso": _f(row.get("torsoAngleDeg")), "aspect": _f(row.get("bboxAspect")),
                    "drop": _f(row.get("dropRate")),
                    "kneeY": _f(row.get("kneeY")), "ankleY": _f(row.get("ankleY")),
                    "bottomClipped": row.get("bottomClipped") == "True",
                    "framingInvalid": row.get("framingSuspectInvalid") == "True",
                })
    rows.sort(key=lambda r: r["ts"])
    # 去重（同一 ts 被两个轮询文件同时采到）
    dedup, seen = [], set()
    for r in rows:
        if r["ts"] in seen:
            continue
        seen.add(r["ts"])
        dedup.append(r)
    return dedup


def _f(value):
    try:
        return float(value) if value not in (None, "") else None
    except ValueError:
        return None


def values(rows, key):
    return [r[key] for r in rows if r[key] is not None]


def rng(rows, key, places=3):
    vals = values(rows, key)
    if not vals:
        return None
    return [round(min(vals), places), round(max(vals), places)]


def episodes(rows):
    out = []
    for r in rows:
        if not out or out[-1]["state"] != r["state"]:
            out.append({"state": r["state"], "start_ts": r["ts"], "end_ts": r["ts"],
                        "samples": [r]})
        else:
            out[-1]["end_ts"] = r["ts"]
            out[-1]["samples"].append(r)
    return out


def window(rows, lo, hi):
    return [r for r in rows if lo <= r["ts"] <= hi]


def _hms_to_ms(hms):
    return int(datetime.strptime(hms, "%H:%M:%S.%f")
               .replace(year=2026, month=11, day=2, tzinfo=CST).timestamp() * 1000)


def _batch2_summary(rows, fallen_eps, cancelled):
    """新补丁加载后（18:36:26–18:38:17）仍构图无效的批次：只记录，不作性能依据。"""
    win = window(rows, *VOID_BATCH_2)
    clipped = sum(1 for r in win if r["bottom"] is not None and r["bottom"] >= 0.98)
    in_win = lambda ts: VOID_BATCH_2[0] <= ts <= VOID_BATCH_2[1]
    return {
        "window": [fmt(win[0]["ts"]), fmt(win[-1]["ts"])] if win else None,
        "samples": len(win),
        "bboxBottom_clipped_samples": clipped,
        "bboxBottom_clipped_ratio": round(clipped / len(win), 3) if win else None,
        "bboxBottom_range": rng(win, "bottom", 3),
        "hipY_range": rng(win, "hipY", 3),
        "fallen_episodes": [{"start": fmt(e["start_ts"]), "end": fmt(e["end_ts"])}
                            for e in fallen_eps if in_win(e["start_ts"])],
        "suspected_cancelled": [c for c in cancelled if in_win(_hms_to_ms(c["time"]))],
        "note": "新补丁已加载但构图仍无效（腿/脚截断 >40% 帧）；**作废，不作性能依据**。",
    }


def parse_mqtt():
    path = os.path.join(HERE, "mqtt-fall.log")
    cmds, alarms = [], []
    if not os.path.exists(path):
        return cmds, alarms
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            m = re.search(r'\{"cmd":"fall".*\}', line)
            if m:
                try:
                    cmds.append(json.loads(m.group(0)))
                except json.JSONDecodeError:
                    pass
            if '"alarm"' in line and '"type":"FALL"' in line:
                m = re.search(r'"alarm":\{[^}]*\}', line)
                if m:
                    try:
                        alarms.append(json.loads("{" + m.group(0) + "}")["alarm"])
                    except json.JSONDecodeError:
                        pass
    dedup_cmds, seen = [], set()
    for c in cmds:
        key = c.get("evidenceId")
        if key not in seen:
            seen.add(key)
            dedup_cmds.append(c)
    dedup_alarms, seen = [], set()
    for a in alarms:
        key = a.get("id")
        if key not in seen:
            seen.add(key)
            dedup_alarms.append(a)
    return dedup_cmds, dedup_alarms


def main():
    rows = load_all()
    eps = episodes(rows)
    fallen_eps = [e for e in eps if e["state"] == "FALLEN"]
    cancelled = []
    for e in eps:
        if e["state"] != "SUSPECTED":
            continue
        nxt = [x for x in eps if x["start_ts"] > e["end_ts"]]
        next_state = nxt[0]["state"] if nxt else None
        if next_state != "FALLEN":
            cancelled.append({"time": fmt(e["start_ts"]), "next": next_state,
                              "hipY": e["samples"][0]["hipY"],
                              "drop": e["samples"][0]["drop"]})

    mqtt_cmds, mqtt_alarms = parse_mqtt()

    def find_mqtt(ts):
        for c in mqtt_cmds:
            parts = str(c.get("evidenceId", "")).split("-")
            if len(parts) >= 2 and parts[1].isdigit():
                if abs(int(parts[1]) - ts) < 3000:
                    return c
        return None

    main_events = []
    for ts, hhmm, note in MAIN_EVENTS:
        ep = next((e for e in fallen_eps if abs(e["start_ts"] - ts) < 3000), None)
        prev = [r for r in rows if r["ts"] < ts][-6:]
        sus = [r for r in prev if r["state"] == "SUSPECTED"]
        after = [r for r in rows if r["ts"] > ts and r["state"] != "FALLEN"]
        duration = None
        if ep is not None and after:
            duration = round((after[0]["ts"] - ep["start_ts"]) / 1000.0, 2)
        main_events.append({
            "index": len(main_events) + 1,
            "time": hhmm,
            "note": note,
            "suspected": [{"time": fmt(r["ts"]), "hipY": r["hipY"], "drop": r["drop"],
                           "torso": r["torso"], "aspect": r["aspect"]} for r in sus],
            "fallen": None if ep is None else {
                "start": fmt(ep["start_ts"]), "end": fmt(ep["end_ts"]),
                "duration_s": duration,
                "samples": len(ep["samples"]),
                "hipY": ep["samples"][0]["hipY"], "bottom": ep["samples"][0]["bottom"],
                "torso": ep["samples"][0]["torso"], "aspect": ep["samples"][0]["aspect"],
                "drop": ep["samples"][0]["drop"],
            },
            "mqtt_command": find_mqtt(ts),
        })

    eff = window(rows, *EFFECTIVE_NEG)
    void = window(rows, *VOID_BATCH)
    summary = {
        "generated_from": ["state*.csv（现场 5 Hz 轮询，可能仍在追加）", "mqtt-fall.log"],
        "sample_count_union": len(rows),
        "window": [fmt(rows[0]["ts"]), fmt(rows[-1]["ts"])] if rows else None,
        "main_result": {
            "events": main_events,
            "count": sum(1 for e in main_events if e["fallen"] is not None),
            "note": "用户确认的 4 次受控跌倒（第 4 次 18:25:08 为用户补充确认），全部正确检出；"
                    "手机/板端告警正常为现场用户确认。",
        },
        "effective_negative": {
            "window": [fmt(eff[0]["ts"]), fmt(eff[-1]["ts"])] if eff else None,
            "samples": len(eff),
            "states": sorted({r["state"] for r in eff}),
            "max_drop": rng(eff, "drop", 3),
            "hipY_range": rng(eff, "hipY", 3),
            "note": "18:26:06–18:26:41 快速深蹲/快坐到地面：0 误报（旧代码，有效负例）。",
        },
        "void_batch": {
            "window": [fmt(void[0]["ts"]), fmt(void[-1]["ts"])] if void else None,
            "samples": len(void),
            "fallen_episodes": [{"start": fmt(e["start_ts"]), "end": fmt(e["end_ts"])}
                                for e in fallen_eps
                                if VOID_BATCH[0] <= e["start_ts"] <= VOID_BATCH[1]],
            "suspected_cancelled": [c for c in cancelled
                                    if VOID_BATCH[0]
                                    <= int(datetime.strptime(c["time"], "%H:%M:%S.%f")
                                           .replace(year=2026, month=11, day=2,
                                                    tzinfo=CST).timestamp() * 1000)
                                    <= VOID_BATCH[1]],
            "bboxBottom_range": rng(void, "bottom", 3),
            "hipY_range": rng(void, "hipY", 3),
            "max_drop": rng(void, "drop", 3),
            "bottomClipped_samples": sum(1 for r in void if r["bottomClipped"]),
            "note": "构图无效（腿/脚被画面切掉，bboxBottom≈0.998–1.0，hipY 0.50–0.97 抖动）；"
                    "**作废，不作性能依据**。",
        },
        "void_batch_2": _batch2_summary(rows, fallen_eps, cancelled),
        "cancelled_suspected_all": cancelled,
        "mqtt": {
            "fall_commands": parse_mqtt()[0],
            "fall_alarm_ids": parse_mqtt()[1],
        },
    }
    with open(OUT_JSON, "w", encoding="utf-8") as fh:
        json.dump(summary, fh, ensure_ascii=False, indent=2)

    lines = ["# 实机测试归档汇总（archive_summary.py 生成）", "",
             "- 数据：state*.csv 去重后 %d 样本，窗口 %s–%s" % (
                 len(rows), summary["window"][0] if summary["window"] else "?",
                 summary["window"][1] if summary["window"] else "?"),
             "- 统计只按固定的时间窗，后续现场追加的数据不计入本文件已列窗口。", "",
             "## 1. 主结果：4 次受控跌倒全部检出（用户确认）", "",
             "| # | 时间 | SUSPECTED 进入帧 | FALLEN 首帧 | 持续 | 说明 |",
             "|---|---|---|---|---|---|"]
    for e in main_events:
        sus = "；".join("hipY=%.3f drop=%.3f" % (s["hipY"], s["drop"]) for s in e["suspected"]) or "-"
        f = e["fallen"]
        lines.append("| %d | %s | %s | %s | %s | %s |" % (
            e["index"], e["time"], sus,
            "-" if f is None else "hipY=%.3f bottom=%.3f torso=%.1f° aspect=%.2f" % (
                f["hipY"], f["bottom"], f["torso"], f["aspect"]),
            "-" if f is None else "%.2fs" % f["duration_s"], e["note"]))
    lines += ["", "> 手机/板端告警正常为**用户现场确认**；MQTT 日志可确认 `cmd:fall` 与告警对象，"
              "但 ACK/手机端截图未在本目录归档。", "",
              "## 2. 有效负例：快速深蹲/快坐到地面 0 误报", "",
              "- 窗口 %s，%d 样本，状态=%s，dropRate=%s，hipY=%s" % (
                  summary["effective_negative"]["window"],
                  summary["effective_negative"]["samples"],
                  summary["effective_negative"]["states"],
                  summary["effective_negative"]["max_drop"],
                  summary["effective_negative"]["hipY_range"]),
              "", "## 3. 作废批次：构图无效，不作性能依据", "",
              "- 窗口 %s，%d 样本" % (summary["void_batch"]["window"],
                                     summary["void_batch"]["samples"]),
              "- bboxBottom=%s，hipY=%s，dropRate=%s" % (
                  summary["void_batch"]["bboxBottom_range"],
                  summary["void_batch"]["hipY_range"],
                  summary["void_batch"]["max_drop"]),
              "- 批次内 FALLEN：%s" % (summary["void_batch"]["fallen_episodes"] or "无"),
              "- 批次内取消的 SUSPECTED：%d 次（18:32:13/20/45/52 等）" % len(
                  summary["void_batch"]["suspected_cancelled"]),
              "- 原因：整段下肢/脚被画面切掉，髋位不可信 → 作废。", "",
              "## 3b. 作废批次 2：18:36:26–18:38:17（新补丁加载后，构图仍无效）", "",
              "- 窗口 %s，%d 样本；`bboxBottom≥0.98` 的帧 %d（%.0f%%），bboxBottom=%s，hipY=%s" % (
                  summary["void_batch_2"]["window"], summary["void_batch_2"]["samples"],
                  summary["void_batch_2"]["bboxBottom_clipped_samples"],
                  100.0 * (summary["void_batch_2"]["bboxBottom_clipped_ratio"] or 0),
                  summary["void_batch_2"]["bboxBottom_range"],
                  summary["void_batch_2"]["hipY_range"]),
              "- 批次内 FALLEN：%s" % (summary["void_batch_2"]["fallen_episodes"] or "无"),
              "- 批次内取消的 SUSPECTED：%d 次（18:36:56 torso 45.6°/drop 0.273；"
              "18:37:05 torso 79.3°/drop 0.206）" % len(
                  summary["void_batch_2"]["suspected_cancelled"]),
              "- 结论：仍属构图问题（近景/下肢截断），**不作性能依据**；"
              "代码侧已加 bottom-clip 直立兜底保护 + `/v1/state` 构图告警。", "",
              "## 4. MQTT", ""]
    for c in parse_mqtt()[0]:
        lines.append("- `cmd:fall` evidenceId=%s score=%s" % (
            c.get("evidenceId"), c.get("score")))
    for a in parse_mqtt()[1]:
        lines.append("- alarm id=%s type=%s evidenceId=%s countToday=%s" % (
            a.get("id"), a.get("type"), a.get("evidenceId"), a.get("countToday")))
    with open(OUT_MD, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
