"""从 hvigor/ArkTS 编译缓存 msgpack 中恢复旧 northbound 1.0.0 源码的原始文本。

背景（2026-10-28）：00-snapshot-archive-sync.ps1 的 dry-run 因 /L 参数拼接 bug
实际执行了源码覆盖，旧 northbound 5 个差异源码文件被 experiments 1.0.10 版本覆盖。
旧 northbound 在 2026-10-25 20:59 有过一次完整构建，其 ArkTS 编译缓存
`entry/build/default/cache/.../compiler.cache/modules/*.msgpack` 中保存了每个源文件的
原始文本；缓存文件名后缀即该源文件的 SHA-256。本脚本据此做逐字节恢复并校验。

产出：recovery/old-northbound-src/<原相对路径>（逐字节原始内容）
      recovery/recovery-report.json（每个文件的 hash/大小/来源）
"""
import hashlib
import io
import json
import os

import msgpack

CACHE = (r"D:\OpenHarmony\competition\northbound\entry\build\default\cache\default"
         r"\default@CompileArkTS\esmodule\debug\compiler.cache\modules")
OUT = r"D:\OpenHarmony\competition\evidence\2026-10-28-three-legacy-closures\source-unify\recovery\old-northbound-src"
REPORT = r"D:\OpenHarmony\competition\evidence\2026-10-28-three-legacy-closures\source-unify\recovery\recovery-report.json"

# 缓存 flat 文件名 -> 旧 northbound 源文件相对路径
MAPPING = {
    "Index.ets": "entry/src/main/ets/pages/Index.ets",
    "CameraModel.ets": "entry/src/main/ets/model/CameraModel.ets",
    "DeviceModel.ets": "entry/src/main/ets/model/DeviceModel.ets",
    "DeviceCapabilities.ts": "entry/src/main/ets/model/DeviceCapabilities.ts",
    "DeviceLink.ets": "entry/src/main/ets/model/DeviceLink.ets",
    "PhotoRetention.ts": "entry/src/main/ets/model/PhotoRetention.ts",
    "VisionFrameStreamer.ets": "entry/src/main/ets/model/VisionFrameStreamer.ets",
    "EntryAbility.ets": "entry/src/main/ets/entryability/EntryAbility.ets",
    "EntryBackupAbility.ets": "entry/src/main/ets/entrybackupability/EntryBackupAbility.ets",
    "SosVoiceAbility.ets": "entry/src/main/ets/sosvoiceability/SosVoiceAbility.ets",
}


def walk_strings(o, out):
    if isinstance(o, dict):
        for k, v in o.items():
            if isinstance(k, str):
                out.append(k)
            walk_strings(v, out)
    elif isinstance(o, (list, tuple)):
        for v in o:
            walk_strings(v, out)
    elif isinstance(o, str):
        out.append(o)


def recover_one(fname):
    stem = fname.split("-")[0]
    if stem not in MAPPING:
        return None
    expected = fname.rsplit("-", 1)[1].rsplit(".", 1)[0].lower()
    data = open(os.path.join(CACHE, fname), "rb").read()
    up = msgpack.Unpacker(io.BytesIO(data), raw=False, strict_map_key=False)
    strings = []
    for obj in up:
        walk_strings(obj, strings)
    best = None
    for s in strings:
        b = s.encode("utf-8")
        if hashlib.sha256(b).hexdigest() == expected:
            best = b
            break
    if best is None:
        return {"file": MAPPING[stem], "status": "HASH-MISMATCH", "msgpack": fname}
    dst = os.path.join(OUT, MAPPING[stem].replace("/", os.sep))
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    with open(dst, "wb") as f:
        f.write(best)
    return {
        "file": MAPPING[stem],
        "status": "RECOVERED-EXACT",
        "bytes": len(best),
        "sha256": expected,
        "msgpack": fname,
    }


def main():
    os.makedirs(OUT, exist_ok=True)
    results = []
    for fname in sorted(os.listdir(CACHE)):
        if fname.endswith(".msgpack") and fname.split("-")[0] in MAPPING:
            r = recover_one(fname)
            if r:
                results.append(r)
                print(r)
    with open(REPORT, "w", encoding="utf-8") as f:
        json.dump(results, f, indent=2, ensure_ascii=False)
    print("recovered:", sum(1 for r in results if r["status"] == "RECOVERED-EXACT"), "/", len(results))


if __name__ == "__main__":
    main()
