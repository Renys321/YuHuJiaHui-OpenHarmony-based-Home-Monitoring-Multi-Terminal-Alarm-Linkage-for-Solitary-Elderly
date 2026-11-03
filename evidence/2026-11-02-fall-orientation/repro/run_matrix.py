"""run_matrix.py — 前后对比实验：当前提交的 fall_detector.py（baseline）vs 2026-11-02 补丁。

实验对象（全部离线、可复现）：
  A. 合成 4 类场景矩阵（见 scenarios.py）：180° 侧倒 / 竖向屈膝 / 朝镜头前倒 /
     坐下 / 蹲下 / 弯腰 / 缓慢躺下 / 已躺卧 / 快速深蹲边界
  B. 仓库内真实 DAYU 关键点事件回放（evidence 下 6 个 jsonl 会话，全部为安全动作，
     已记录无真实跌倒），用于验证不会因放宽而误报。

输出（data/）：
  results_frames.csv       逐帧判定链路取值（两种实现 × 三套机位配置 × 全部场景）
  results_events.csv       事件级结果（通过/失败、事件数、首事件延迟、关键指标）
  real_replay_compare.json 真实数据回放对比（事件数/误报数）
  RESULTS.md               自动汇总表（供 README 引用）

用法：
  python run_matrix.py            # 跑全部
  python run_matrix.py --quick    # 只跑默认配置（absolute_4fps）
"""
from __future__ import annotations

import argparse
import collections
import csv
import importlib.util
import json
import os
import sys

REPRO = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.dirname(REPRO)
PROJECT = os.path.dirname(os.path.dirname(BASE))
VISION = os.path.join(PROJECT, "vision")
sys.path.insert(0, REPRO)
sys.path.insert(0, VISION)

import scenarios  # noqa: E402

DATA = os.path.join(BASE, "data")
EV = os.path.join(PROJECT, "evidence")

CONFIGS = [
    {
        "name": "absolute_4fps",
        "width": 640, "height": 480, "fps": 4.0, "ground_zones": (),
        "note": "当前提交启动脚本（start_dayu_usb_vision.cmd）使用的绝对低位阈值模式",
    },
    {
        "name": "groundzone_4fps",
        "width": 320, "height": 240, "fps": 4.0,
        "ground_zones": ((0.0, 0.55, 1.0, 1.0),),
        "note": "演示机位 --ground-zone 0,0.55,1,1（2026-10-28 联调记录）",
    },
    {
        "name": "absolute_2fps",
        "width": 640, "height": 480, "fps": 2.0, "ground_zones": (),
        "note": "低帧率（2 FPS）鲁棒性",
    },
]

REAL_FILES = [
    "2026-10-25-dayu-formal-camera-inference-regression/formal-pose-events.jsonl",
    "2026-10-25-dayu-formal-camera-inference-regression/formal-live-events.jsonl",
    "2026-10-25-dayu-formal-camera-inference-regression/formal-redo-events.jsonl",
    "2026-10-25-dayu-formal-camera-inference-regression/formal-redo3-events.jsonl",
    "2026-10-25-dayu-formal-camera-inference-regression/formal-capture-events.jsonl",
    "2026-10-26-demo-autostart/demo-events-mid.jsonl",
]
REAL_IMG_W, REAL_IMG_H = 640, 480


def load_baseline():
    path = os.path.join(REPRO, "fall_detector_baseline.py")
    spec = importlib.util.spec_from_file_location("fall_detector_baseline", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules["fall_detector_baseline"] = module   # dataclass 需要模块已注册
    spec.loader.exec_module(module)
    return module


def load_patched():
    import fall_detector
    return fall_detector


def frame_for(module, spec: scenarios.FrameSpec, width, height):
    return module.PoseFrame.from_coco(
        ts_ms=spec.ts_ms,
        bbox_xyxy=spec.bbox_xyxy,
        keypoints_xyc=spec.keypoints_xyc,
        image_width=width,
        image_height=height,
        pose_confidence=spec.pose_confidence,
        track_id=1,
    )


def low_effective(snap):
    return bool(snap["ground_hit"]) if snap.get("ground_zones") else bool(snap["low"])


def run_scenario(module, scenario, cfg, mode):
    detector = module.FallDetector(ground_zones=cfg["ground_zones"])
    frames = scenarios.render(scenario, width=cfg["width"], height=cfg["height"],
                              fps=cfg["fps"], seed=7)
    records = []
    events = []
    for spec in frames:
        frame = frame_for(module, spec, cfg["width"], cfg["height"])
        event = detector.update(frame)
        snap = detector.snapshot(spec.ts_ms)
        if event is not None:
            events.append({"ts": event.ts_ms, "score": event.score,
                           "torso": round(event.torso_angle_deg, 1),
                           "aspect": round(event.bbox_aspect, 2),
                           "drop": round(event.hip_drop_per_sec, 3)})
        near_upright = (snap["since_upright_ms"] is not None
                        and snap["since_upright_ms"] <= 6000)
        recent_drop = (snap["since_drop_ms"] is not None
                       and snap["since_drop_ms"] <= 2000)
        blocked_by_horizontal = bool(
            snap["features_valid"] and near_upright and recent_drop
            and low_effective(snap) and not snap["horizontal"] and not snap["excluded"]
        )
        collapse = snap.get("collapse") or {}
        records.append({
            "mode": mode,
            "config": cfg["name"],
            "scenario": scenario.name,
            "category": scenario.category,
            "ts_ms": spec.ts_ms,
            "features_valid": snap["features_valid"],
            "torso_angle_deg": snap["torso_angle_deg"],
            "bbox_aspect": snap["bbox_aspect"],
            "hip_y": snap["hip_y"],
            "shoulder_y": collapse.get("shoulder_y", ""),
            "bbox_height": collapse.get("bbox_height", ""),
            "bbox_bottom": snap["bbox_bottom"],
            "shoulder_hip_dy": snap["shoulder_hip_dy"],
            "drop_rate": snap["drop_rate"],
            "shoulder_drop_rate": collapse.get("latest_shoulder_drop_per_sec", ""),
            "upright": snap["upright"],
            "horizontal": snap["horizontal"],
            "low": snap["low"],
            "low_effective": low_effective(snap),
            "excluded": snap["excluded"],
            "blocked_by_horizontal": blocked_by_horizontal,
            "collapse_evidence": collapse.get("evidence", ""),
            "collapse_hip_drop": collapse.get("hip_drop_from_baseline", ""),
            "collapse_peak": collapse.get("peak_hip_drop_per_sec", ""),
            "state": snap["state"],
            "suspected_mode": snap.get("suspected_mode", ""),
            "event": bool(event),
        })
    return records, events


def evaluate(scenario, events):
    count = len(events)
    if scenario.expected_fall:
        passed = count >= 1
    else:
        passed = count == 0
    first = events[0] if events else None
    latency = None
    if first is not None and scenario.motion_start_ms:
        latency = first["ts"] - scenario.motion_start_ms
    return {
        "scenario": scenario.name,
        "category": scenario.category,
        "expected_fall": scenario.expected_fall,
        "required": scenario.category != "boundary",
        "pass": passed,
        "event_count": count,
        "first_event_ts": None if first is None else first["ts"],
        "latency_ms": latency,
        "event_torso_deg": None if first is None else first["torso"],
        "event_aspect": None if first is None else first["aspect"],
        "event_drop_per_sec": None if first is None else first["drop"],
    }


def real_replay(module):
    """真实 DAYU 关键点会话回放（安全动作，无真实跌倒）。"""
    out = {}
    for rel in REAL_FILES:
        path = os.path.join(EV, rel)
        if not os.path.exists(path):
            continue
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
        detector = module.FallDetector()
        events = []
        for row in rows:
            ts = int(row.get("eventTsMs") or row.get("frameTsMs") or 0)
            frame = None
            if row.get("dataValid") and len(row.get("primaryKeypoints") or []) >= 17 \
                    and len(row.get("primaryBBox") or []) == 4:
                frame = module.PoseFrame.from_coco(
                    ts_ms=ts,
                    bbox_xyxy=row["primaryBBox"],
                    keypoints_xyc=row["primaryKeypoints"],
                    image_width=REAL_IMG_W,
                    image_height=REAL_IMG_H,
                    pose_confidence=float(row.get("postureConfidence") or 1.0),
                    track_id=1,
                )
            event = detector.update(frame, ts)
            if event is not None:
                events.append({"ts": event.ts_ms,
                               "torso": round(event.torso_angle_deg, 1),
                               "aspect": round(event.bbox_aspect, 2),
                               "drop": round(event.hip_drop_per_sec, 3)})
        out[rel] = {
            "frames": len(rows),
            "fall_events": len(events),
            "event_samples": events[:6],
        }
    return out


def write_csv(path, records):
    if not records:
        return
    keys = list(records[0].keys())
    with open(path, "w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=keys)
        writer.writeheader()
        writer.writerows(records)


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--quick", action="store_true")
    args = parser.parse_args(argv)
    os.makedirs(DATA, exist_ok=True)

    baseline = load_baseline()
    patched = load_patched()
    configs = CONFIGS[:1] if args.quick else CONFIGS
    scenarios_list = scenarios.all_scenarios()

    frame_rows = []
    event_rows = []
    for cfg in configs:
        for scenario in scenarios_list:
            for mode, module in (("baseline", baseline), ("patched", patched)):
                records, events = run_scenario(module, scenario, cfg, mode)
                frame_rows.extend(records)
                row = evaluate(scenario, events)
                row.update({"mode": mode, "config": cfg["name"]})
                event_rows.append(row)

    write_csv(os.path.join(DATA, "results_frames.csv"), frame_rows)
    write_csv(os.path.join(DATA, "results_events.csv"), event_rows)

    real_before = real_replay(baseline)
    real_after = real_replay(patched)
    real_compare = {}
    for rel in real_before:
        real_compare[rel] = {
            "frames": real_before[rel]["frames"],
            "baseline_fall_events": real_before[rel]["fall_events"],
            "patched_fall_events": real_after.get(rel, {}).get("fall_events"),
            "baseline_samples": real_before[rel]["event_samples"],
            "patched_samples": real_after.get(rel, {}).get("event_samples", []),
        }
    with open(os.path.join(DATA, "real_replay_compare.json"), "w", encoding="utf-8") as fh:
        json.dump(real_compare, fh, ensure_ascii=False, indent=2)

    # ---- 控制台汇总 ----
    by_mode = collections.defaultdict(list)
    for row in event_rows:
        by_mode[row["mode"]].append(row)
    print("\n== 合成场景事件级结果（pass=正例检出/负例不误报；boundary=仅记录） ==")
    header = "%-38s %-9s %-9s %-6s %-8s %-6s %-10s" % (
        "scenario", "expected", "baseline", "pass", "patched", "pass", "latency_ms")
    print(header)
    for scenario in scenarios_list:
        b = next(r for r in by_mode["baseline"]
                 if r["scenario"] == scenario.name and r["config"] == configs[0]["name"])
        p = next(r for r in by_mode["patched"]
                 if r["scenario"] == scenario.name and r["config"] == configs[0]["name"])
        tag = "记录" if p["category"] == "boundary" else p["pass"]
        print("%-38s %-9s %-9d %-6s %-8d %-6s %-10s" % (
            scenario.name, b["expected_fall"], b["event_count"], b["pass"],
            p["event_count"], tag, p["latency_ms"]))

    # 硬指标：所有 required 场景在 patched 下必须通过（boundary 只记录）
    required = [r for r in by_mode["patched"]
                if r["config"] == configs[0]["name"] and r["required"]]
    hard_fail = [r["scenario"] for r in required if not r["pass"]]
    print("\n== 硬指标（required 场景，patched）: %d/%d PASS%s ==" % (
        len(required) - len(hard_fail), len(required),
        "" if not hard_fail else "，FAIL: %s" % hard_fail))
    print("\n== 真实 DAYU 关键点回放（安全动作，应 0 事件） ==")
    for rel, row in real_compare.items():
        print("%-90s baseline=%d patched=%d" % (
            rel, row["baseline_fall_events"], row["patched_fall_events"]))

    # 生成 RESULTS.md
    lines = ["# 自动实验结果（run_matrix.py 生成）", "",
             "> 合成场景为手工构造的 COCO-17 关键点序列，**非真机录像**；真实回放数据来自",
             "> evidence/2026-10-25-dayu-formal-camera-inference-regression 与 2026-10-26-demo-autostart，",
             "> 均为已记录的安全动作（无真实跌倒）。",
             "> 2026-11-02 晚：`stress_fast_deep_crouch` 改为受控减速的物理合理曲线，并新增",
             "> `boundary_constant_speed_collapse` 只记录恒速（≈自由落体）边界，不列入硬指标。", ""]
    for cfg in configs:
        lines.append("## 配置 `%s`（%s）" % (cfg["name"], cfg["note"]))
        lines.append("")
        lines.append("| scenario | 类别 | 期望 | baseline 事件 | baseline 通过 | patched 事件 | patched 通过 | 首事件延迟(ms) |")
        lines.append("|---|---|---|---|---|---|---|---|")
        for scenario in scenarios_list:
            b = next(r for r in by_mode["baseline"]
                     if r["scenario"] == scenario.name and r["config"] == cfg["name"])
            p = next(r for r in by_mode["patched"]
                     if r["scenario"] == scenario.name and r["config"] == cfg["name"])
            if p["category"] == "boundary":
                patched_verdict = "记录（非验收）"
                baseline_verdict = "记录（非验收）"
            else:
                patched_verdict = "PASS" if p["pass"] else "FAIL"
                baseline_verdict = "PASS" if b["pass"] else "FAIL"
            lines.append("| %s | %s | %s | %d | %s | %d | %s | %s |" % (
                scenario.name, scenario.category, "跌倒" if scenario.expected_fall else "非跌倒",
                b["event_count"], baseline_verdict,
                p["event_count"], patched_verdict,
                "-" if p["latency_ms"] is None else p["latency_ms"]))
        lines.append("")
        required_cfg = [r for r in by_mode["patched"]
                        if r["config"] == cfg["name"] and r["required"]]
        failed = [r["scenario"] for r in required_cfg if not r["pass"]]
        lines.append("**硬指标（required，patched）：%d/%d PASS**%s" % (
            len(required_cfg) - len(failed), len(required_cfg),
            "" if not failed else "；FAIL: %s" % failed))
        lines.append("")

    # 帧级根因：正例中被 horizontal 单条挡掉的帧数
    lines.append("## 帧级根因：正例中被 `horizontal` 单独挡掉的帧数（baseline）")
    lines.append("")
    lines.append("| 配置 | scenario | 帧数 | horizontal 为假且其余门都通过 | 占比 |")
    lines.append("|---|---|---|---|---|")
    for cfg in configs:
        for scenario in scenarios_list:
            rows = [r for r in frame_rows
                    if r["config"] == cfg["name"] and r["scenario"] == scenario.name]
            blocked = sum(1 for r in rows if r["blocked_by_horizontal"])
            if blocked:
                lines.append("| %s | %s | %d | %d | %.0f%% |" % (
                    cfg["name"], scenario.name, len(rows), blocked,
                    100.0 * blocked / max(1, len(rows))))
    lines.append("")
    lines.append("## 真实 DAYU 关键点回放（安全动作，期望 0 事件）")
    lines.append("")
    lines.append("| 真实会话 | 帧数 | baseline 事件 | patched 事件 |")
    lines.append("|---|---|---|---|")
    for rel, row in real_compare.items():
        lines.append("| %s | %d | %d | %d |" % (
            rel, row["frames"], row["baseline_fall_events"], row["patched_fall_events"]))
    lines.append("")
    with open(os.path.join(DATA, "RESULTS.md"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines))
    print("\n写出：data/results_frames.csv, data/results_events.csv, "
          "data/real_replay_compare.json, data/RESULTS.md")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
