import io
import json
import msgpack
import os

CACHE = r"D:\OpenHarmony\competition\northbound\entry\build\default\cache\default\default@CompileArkTS\esmodule\debug\compiler.cache\modules"


def walk(o, out):
    if isinstance(o, dict):
        for k, v in o.items():
            out.append(k) if isinstance(k, str) else None
            walk(v, out)
    elif isinstance(o, (list, tuple)):
        for v in o:
            walk(v, out)
    elif isinstance(o, str):
        out.append(o)
    elif isinstance(o, bytes):
        pass


def inspect(name):
    path = os.path.join(CACHE, name)
    data = open(path, "rb").read()
    up = msgpack.Unpacker(io.BytesIO(data), raw=False, strict_map_key=False)
    objs = []
    try:
        for o in up:
            objs.append(o)
    except Exception as e:
        print("unpack stop:", e)
    print("=== %s (%d bytes, %d top-level objects)" % (name, len(data), len(objs)))
    strs = []
    for o in objs:
        walk(o, strs)
    uniq = []
    seen = set()
    for s in strs:
        if len(s) > 200 and s not in seen:
            seen.add(s)
            uniq.append(s)
    uniq.sort(key=len, reverse=True)
    for i, s in enumerate(uniq[:8]):
        print("  [%d] len=%d head=%r" % (i, len(s), s[:180]))
    return objs, uniq


if __name__ == "__main__":
    inspect("Index.ets-a6426e26ffab9a4beb0ca861dbf7f6c60e0010f4de42c45610cb774dfd2fa5e6.msgpack")
