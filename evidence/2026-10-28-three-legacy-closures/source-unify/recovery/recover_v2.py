"""恢复旧 northbound 1.0.0 的 5 个差异源码文件（逐字节原始文本）。

校验依据：
 1) 同批 msgpack 中"两棵树逐字节相同"的文件（VisionFrameStreamer/DeviceLink/PhotoRetention/
    EntryAbility/SosVoiceAbility）恢复出的文本 SHA-256 与当前文件一致 -> 证明 msgpack 内
    字符串就是源文件原始内容（逐字节）；
 2) 恢复出的旧文件字节数必须与覆盖前登记的旧文件大小完全一致
    （Index 66,383 / CameraModel 18,137 / DeviceModel 9,342 / DeviceCapabilities 1,927）。
"""
import hashlib
import io
import json
import os

import msgpack

CACHE = (r"D:\OpenHarmony\competition\northbound\entry\build\default\cache\default"
         r"\default@CompileArkTS\esmodule\debug\compiler.cache\modules")
REC = r"D:\OpenHarmony\competition\evidence\2026-10-28-three-legacy-closures\source-unify\recovery"
OUT = os.path.join(REC, "old-northbound-src")

EXPECT = {
    "Index.ets": (66383, "entry/src/main/ets/pages/Index.ets"),
    "CameraModel.ets": (18137, "entry/src/main/ets/model/CameraModel.ets"),
    "DeviceModel.ets": (9342, "entry/src/main/ets/model/DeviceModel.ets"),
    "DeviceCapabilities.ts": (1927, "entry/src/main/ets/model/DeviceCapabilities.ts"),
}

VALIDATED = {
    "VisionFrameStreamer.ets": "entry/src/main/ets/model/VisionFrameStreamer.ets",
    "DeviceLink.ets": "entry/src/main/ets/model/DeviceLink.ets",
    "PhotoRetention.ts": "entry/src/main/ets/model/PhotoRetention.ts",
    "EntryAbility.ets": "entry/src/main/ets/entryability/EntryAbility.ets",
    "SosVoiceAbility.ets": "entry/src/main/ets/sosvoiceability/SosVoiceAbility.ets",
}
NB = r"D:\OpenHarmony\competition\northbound"


def walk(o, out):
    if isinstance(o, dict):
        for k, v in o.items():
            if isinstance(k, str):
                out.append(k)
            walk(v, out)
    elif isinstance(o, (list, tuple)):
        for v in o:
            walk(v, out)
    elif isinstance(o, str):
        out.append(o)


def longest_string(path):
    data = open(path, "rb").read()
    up = msgpack.Unpacker(io.BytesIO(data), raw=False, strict_map_key=False)
    strings = []
    for obj in up:
        walk(obj, strings)
    if not strings:
        return b""
    s = max(strings, key=len)
    return s.encode("utf-8")


def main():
    os.makedirs(OUT, exist_ok=True)
    report = {"validation": [], "recovered": []}

    # 1) 验证提取方法是逐字节的
    for stem, rel in VALIDATED.items():
        cand = [f for f in os.listdir(CACHE) if f.startswith(stem + "-") and f.endswith(".msgpack")]
        if not cand:
            continue
        extracted = longest_string(os.path.join(CACHE, cand[0]))
        cur = os.path.join(NB, rel.replace("/", os.sep))
        cur_bytes = open(cur, "rb").read()
        ok = hashlib.sha256(extracted).hexdigest() == hashlib.sha256(cur_bytes).hexdigest()
        report["validation"].append({"file": rel, "current_bytes": len(cur_bytes), "match": ok})
        print("validate", rel, "exact" if ok else "MISMATCH")

    # 2) 恢复旧文件
    for stem, (want_bytes, rel) in EXPECT.items():
        cand = [f for f in os.listdir(CACHE) if f.startswith(stem + "-") and f.endswith(".msgpack")]
        if not cand:
            print("no msgpack for", stem)
            continue
        extracted = longest_string(os.path.join(CACHE, cand[0]))
        dst = os.path.join(OUT, rel.replace("/", os.sep))
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        with open(dst, "wb") as f:
            f.write(extracted)
        entry = {
            "file": rel,
            "bytes": len(extracted),
            "expected_bytes": want_bytes,
            "size_match": len(extracted) == want_bytes,
            "sha256": hashlib.sha256(extracted).hexdigest(),
            "source_msgpack": cand[0],
        }
        report["recovered"].append(entry)
        print(entry)

    with open(os.path.join(REC, "recovery-report.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)
    print("all sizes match:", all(r["size_match"] for r in report["recovered"]))


if __name__ == "__main__":
    main()
