"""静态核对：northbound 构建出的 1.0.10 HAP vs experiments 1.0.10 构建产物。

检查：
 1) 包内 module.json 的 bundleName/versionName/versionCode/debug；
 2) 包内 entry 清单与数量（应与 experiments 1.0.10 一致）；
 3) 逐 entry SHA-256 对比（如实标注哪些 entry 不同）；
 4) 已验收能力的关键标记在 ets/modules.abc 中是否出现：
    视频 Wi-Fi 直连（0.0.0.0 / LAN_ONLY / 9301）、随身 SOS 横幅（WearableBannerStore、
    wb_acked_）、预览调参（PreviewTuning）、无 PIR 文案、告警房间归属字段等；
 5) 旧线缺陷不得回退：CameraModel 的 setPreviewRotation 调用应不存在；
 6) 包内不得有 .bak/临时文件。

用法: python 01b-static-checks.py <new-signed.hap> <baseline-signed.hap> <out.txt> <out.json>
"""
import hashlib
import json
import os
import sys
import zipfile

new_hap = sys.argv[1]
base_hap = sys.argv[2] if len(sys.argv) > 2 else ""
out_txt = sys.argv[3] if len(sys.argv) > 3 else "static-checks.txt"
out_json = sys.argv[4] if len(sys.argv) > 4 else "static-checks.json"

MARKERS = [
    ("VideoStreamServer 绑定 0.0.0.0", b"0.0.0.0"),
    ("LAN_ONLY 私网白名单错误码", b"LAN_ONLY"),
    ("VIDEO_STREAM_PORT 常量", b"VIDEO_STREAM_PORT"),
    ("视频帧率控制 frameIntervalMs", b"frameIntervalMs"),
    ("视频协议版本 VIDEO_STREAM_PROTO", b"VIDEO_STREAM_PROTO"),
    ("WearableBannerStore 类", b"WearableBannerStore"),
    ("横幅偏好键前缀 wb_acked_", b"wb_acked_"),
    ("横幅偏好键前缀 wb_alarm_", b"wb_alarm_"),
    ("横幅 preferences 名", b"eldercare_wearable_banner"),
    ("预览调参 PreviewTuning", b"PreviewTuning"),
    ("随身求助文案", "随身求助".encode("utf-8")),
    ("未配置 PIR 文案", "未配置 PIR".encode("utf-8")),
    ("暂无定位 文案", "暂无定位".encode("utf-8")),
    ("设备已确认 文案", "设备已确认".encode("utf-8")),
    ("告警自身归属 room 字段", b"ackSource"),
    ("随身 SOS 告警标识", b"wearable"),
]
NEGATIVE = [
    ("旧线相机旋转候选调用（应不存在）", b"setPreviewRotation"),
]


def read_zip(path):
    with zipfile.ZipFile(path) as z:
        names = sorted(z.namelist())
        entries = {n: hashlib.sha256(z.read(n)).hexdigest() for n in names}
        module = json.loads(z.read("module.json").decode("utf-8")) if "module.json" in names else {}
        abc = z.read("ets/modules.abc") if "ets/modules.abc" in entries else b""
    return names, entries, module, abc


result = {"new_hap": new_hap, "baseline_hap": base_hap, "checks": {}}
lines = []


def emit(s):
    lines.append(s)
    print(s)


new_names, new_entries, new_mod, new_abc = read_zip(new_hap)
app = new_mod.get("app", {})
mod = new_mod.get("module", {})
emit("## 新构建 HAP: %s (%d bytes)" % (os.path.basename(new_hap), os.path.getsize(new_hap)))
emit("bundleName=%s versionName=%s versionCode=%s debug=%s" %
     (app.get("bundleName"), app.get("versionName"), app.get("versionCode"), app.get("debug")))
emit("deviceTypes=%s minAPIVersion=%s targetAPIVersion=%s" %
     (mod.get("deviceTypes"), app.get("minAPIVersion"), app.get("targetAPIVersion")))
result["checks"]["module"] = {
    "bundleName": app.get("bundleName"),
    "versionName": app.get("versionName"),
    "versionCode": app.get("versionCode"),
    "debug": app.get("debug"),
    "deviceTypes": mod.get("deviceTypes"),
}

# 2) entry 清单
emit("entry 数量=%d" % len(new_names))
emit("entry 列表: " + ", ".join(new_names))
result["checks"]["entry_count"] = len(new_names)
result["checks"]["entries"] = new_names
bad = [n for n in new_names if n.endswith(".bak") or ".bak" in n or n.endswith("~")]
emit("临时/备份文件: %s" % (bad if bad else "无"))
result["checks"]["temp_files"] = bad

# 3) 与 baseline 对比
if base_hap and os.path.exists(base_hap):
    bn, be, bmod, babc = read_zip(base_hap)
    bapp = bmod.get("app", {})
    emit("")
    emit("## baseline: %s (%d bytes) bundle=%s version=%s/%s entries=%d" % (
        os.path.basename(base_hap), os.path.getsize(base_hap),
        bapp.get("bundleName"), bapp.get("versionName"), bapp.get("versionCode"), len(bn)))
    only_new = sorted(set(bn) - set(bn))
    only_base = sorted(set(bn) - set(new_names))
    diff_entries = sorted(n for n in set(new_names) & set(bn) if new_entries[n] != be.get(n))
    emit("仅新包 entry: %s" % (only_new if only_new else "无"))
    emit("仅 baseline entry: %s" % (only_base if only_base else "无"))
    emit("逐 entry 内容不同的: %s" % (diff_entries if diff_entries else "无"))
    result["checks"]["baseline"] = {
        "entries": len(bn),
        "only_new": only_new,
        "only_baseline": only_base,
        "changed_entries": diff_entries,
        "module_same_app_fields": {
            "bundleName": app.get("bundleName") == bapp.get("bundleName"),
            "versionName": app.get("versionName") == bapp.get("versionName"),
            "versionCode": app.get("versionCode") == bapp.get("versionCode"),
        },
    }

# 4) 正向标记（同时核对 baseline）
emit("")
emit("## 关键能力标记（ets/modules.abc 字节搜索）")
marker_result = {}
for label, needle in MARKERS:
    in_new = needle in new_abc
    in_base = (needle in babc) if (base_hap and os.path.exists(base_hap)) else None
    emit("- %-34s new=%-5s baseline=%s" % (label, in_new, in_base))
    marker_result[label] = {"new": in_new, "baseline": in_base}
result["checks"]["markers"] = marker_result

emit("")
emit("## 负向标记（旧线缺陷不得回退）")
neg_result = {}
for label, needle in NEGATIVE:
    in_new = needle in new_abc
    in_base = (needle in babc) if (base_hap and os.path.exists(base_hap)) else None
    emit("- %-40s new=%-5s baseline=%s（期望 new=False）" % (label, in_new, in_base))
    neg_result[label] = {"new": in_new, "baseline": in_base}
result["checks"]["negative"] = neg_result

failed = [l for l, v in marker_result.items() if not v["new"]]
failed_neg = [l for l, v in neg_result.items() if v["new"]]
result["summary"] = {
    "markers_ok": not failed,
    "missing_markers": failed,
    "regressions": failed_neg,
    "version_ok": app.get("versionName") == "1.0.10" and app.get("versionCode") == 1000010,
    "bundle_ok": app.get("bundleName") == "com.dsh.eldercare",
}
emit("")
emit("## 结论")
emit("版本/bundle: %s" % ("OK" if result["summary"]["version_ok"] and result["summary"]["bundle_ok"] else "FAIL"))
emit("能力标记: %s" % ("OK（全部存在）" if not failed else ("缺少: " + ", ".join(failed))))
emit("无回退标记: %s" % ("OK" if not failed_neg else ("发现回退标记: " + ", ".join(failed_neg))))
result["summary"]["ok"] = (result["summary"]["markers_ok"] and not failed_neg and
                           result["summary"]["version_ok"] and result["summary"]["bundle_ok"])

with open(out_txt, "w", encoding="utf-8") as f:
    f.write("\n".join(lines) + "\n")
with open(out_json, "w", encoding="utf-8") as f:
    json.dump(result, f, indent=2, ensure_ascii=False)
sys.exit(0 if result["summary"]["ok"] else 1)
