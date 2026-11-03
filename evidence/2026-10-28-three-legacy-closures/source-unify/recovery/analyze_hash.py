import hashlib
import io
import os

import msgpack

CACHE = (r"D:\OpenHarmony\competition\northbound\entry\build\default\cache\default"
         r"\default@CompileArkTS\esmodule\debug\compiler.cache\modules")
NB = r"D:\OpenHarmony\competition\northbound"
CUR = {
    "VisionFrameStreamer.ets": "entry/src/main/ets/model/VisionFrameStreamer.ets",
    "DeviceLink.ets": "entry/src/main/ets/model/DeviceLink.ets",
    "PhotoRetention.ts": "entry/src/main/ets/model/PhotoRetention.ts",
    "EntryAbility.ets": "entry/src/main/ets/entryability/EntryAbility.ets",
    "SosVoiceAbility.ets": "entry/src/main/ets/sosvoiceability/SosVoiceAbility.ets",
}


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


def sha(b):
    return hashlib.sha256(b).hexdigest()


for fname in sorted(os.listdir(CACHE)):
    stem = fname.split("-")[0]
    if fname.endswith(".msgpack") and stem in CUR:
        path = os.path.join(CACHE, fname)
        data = open(path, "rb").read()
        up = msgpack.Unpacker(io.BytesIO(data), raw=False, strict_map_key=False)
        strings = []
        for obj in up:
            walk(obj, strings)
        strings.sort(key=len, reverse=True)
        cur_path = os.path.join(NB, CUR[stem].replace("/", os.sep))
        cur = open(cur_path, "rb").read()
        exp = fname.rsplit("-", 1)[1].rsplit(".", 1)[0]
        print("==", fname)
        print("  filename-hash:", exp)
        print("  current-file :", len(cur), sha(cur), "match_filename=", sha(cur) == exp)
        for s in strings[:3]:
            b = s.encode("utf-8")
            print("  cand len=%d sha=%s match_cur=%s match_name=%s" % (len(b), sha(b), sha(b) == sha(cur), sha(b) == exp))
            variants = {
                "bom": b"\xef\xbb\xbf" + b,
                "crlf": b.replace(b"\n", b"\r\n"),
                "strip_nl": b.rstrip(b"\r\n"),
                "cur_end": b + b"\r\n" if not b.endswith(b"\n") else b,
            }
            for k, v in variants.items():
                if sha(v) == exp or sha(v) == sha(cur):
                    print("    variant match:", k, len(v))
