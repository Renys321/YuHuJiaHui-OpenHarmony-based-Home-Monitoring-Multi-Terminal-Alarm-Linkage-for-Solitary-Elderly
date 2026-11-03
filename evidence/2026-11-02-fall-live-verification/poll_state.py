# -*- coding: utf-8 -*-
"""轮询 /v1/state 记录跌倒检测状态，供现场动作测试取证。

2026-11-02 收尾版：增加"髋-膝-踝几何 + collapse 诊断"列（服务端需为带
2026-11-02 evening 补丁的 yolo_pose_service.py；旧版服务缺少这些字段时自动留空）。
快速深蹲/坐地测试请务必用本版本，才能采到 terminal_drop / kneeY / ankleY。
"""
import csv
import json
import sys
import time
import urllib.request

OUT = sys.argv[1] if len(sys.argv) > 1 else "state.csv"
SECONDS = int(sys.argv[2]) if len(sys.argv) > 2 else 600
URL = "http://127.0.0.1:9200/v1/state"

fields = [
    "ts", "state", "fall", "personDetected", "hipY", "bboxBottom",
    "torsoAngleDeg", "bboxAspect", "dropRate", "frames",
    # 2026-11-02 收尾新增（髋-膝-踝几何 + collapse 诊断）
    "shoulderY", "bboxHeight", "kneeY", "ankleY",
    "collapseEvidence", "collapseHoldEvidence", "terminalDrop",
    "peakHipDrop", "peakShoulderDrop", "hipDropFromBaseline",
    "shoulderDropFromBaseline", "baselineAgeMs", "suspectedMode",
    # 2026-11-02 构图告警（下肢截断/近景时 framingSuspectInvalid=True，结果不可作性能依据）
    "bottomClipped", "framingSuspectInvalid",
]
last_state = None
t0 = time.time()
with open(OUT, "w", newline="", encoding="utf-8") as f:
    w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
    w.writeheader()
    while time.time() - t0 < SECONDS:
        try:
            with urllib.request.urlopen(URL, timeout=1.5) as r:
                d = json.loads(r.read().decode("utf-8"))
        except Exception:
            time.sleep(0.2)
            continue
        feat = d.get("features") or {}
        coll = d.get("collapse") or {}
        framing = d.get("framing") or {}
        row = {
            "ts": d.get("ts"),
            "state": d.get("state"),
            "fall": d.get("fall"),
            "personDetected": d.get("personDetected"),
            "hipY": feat.get("hipY"),
            "bboxBottom": feat.get("bboxBottom"),
            "torsoAngleDeg": feat.get("torsoAngleDeg"),
            "bboxAspect": feat.get("bboxAspect"),
            "dropRate": d.get("dropRate"),
            "frames": d.get("frames"),
            "shoulderY": feat.get("shoulderY"),
            "bboxHeight": feat.get("bboxHeight"),
            "kneeY": feat.get("kneeY"),
            "ankleY": feat.get("ankleY"),
            "collapseEvidence": coll.get("evidence"),
            "collapseHoldEvidence": coll.get("hold_evidence"),
            "terminalDrop": coll.get("terminal_drop_per_sec"),
            "peakHipDrop": coll.get("peak_hip_drop_per_sec"),
            "peakShoulderDrop": coll.get("peak_shoulder_drop_per_sec"),
            "hipDropFromBaseline": coll.get("hip_drop_from_baseline"),
            "shoulderDropFromBaseline": coll.get("shoulder_drop_from_baseline"),
            "baselineAgeMs": coll.get("baseline_age_ms"),
            "suspectedMode": d.get("suspectedMode"),
            "bottomClipped": feat.get("bottomClipped"),
            "framingSuspectInvalid": framing.get("suspectInvalid"),
        }
        w.writerow(row)
        f.flush()
        if d.get("state") != last_state:
            print("%s state=%s fall=%s feat=%s" % (
                time.strftime("%H:%M:%S"), d.get("state"), d.get("fall"), feat), flush=True)
            last_state = d.get("state")
        time.sleep(0.2)
