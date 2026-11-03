import json
import msgpack
import sys

CACHE = r"D:\OpenHarmony\competition\northbound\entry\build\default\cache\default\default@CompileArkTS\esmodule\debug\compiler.cache\modules"
TARGET = r"D:\OpenHarmony\competition\evidence\2026-10-28-three-legacy-closures\source-unify\recovery"
import os
os.makedirs(TARGET, exist_ok=True)

candidates = [n for n in os.listdir(CACHE) if n.startswith("Index.ets-")]
print("candidates:", candidates)
path = os.path.join(CACHE, candidates[0])
with open(path, "rb") as f:
    data = f.read()
print("size:", len(data), "head:", data[:16].hex())

obj = msgpack.unpackb(data, raw=False, strict_map_key=False)


def describe(o, depth=0, maxdepth=3):
    pad = "  " * depth
    if isinstance(o, dict):
        print(pad + "dict len=%d keys=%s" % (len(o), list(o.keys())[:12]))
        if depth < maxdepth:
            for k, v in list(o.items())[:12]:
                print(pad + "  key=%r -> %s" % (k, type(v).__name__))
                describe(v, depth + 2, maxdepth)
    elif isinstance(o, (list, tuple)):
        print(pad + "%s len=%d" % (type(o).__name__, len(o)))
        for i, v in enumerate(o[:4]):
            print(pad + "  [%d] %s" % (i, type(v).__name__))
            describe(v, depth + 2, maxdepth)
    elif isinstance(o, bytes):
        print(pad + "bytes len=%d head=%r" % (len(o), o[:80]))
    else:
        s = repr(o)
        print(pad + "%s %s" % (type(o).__name__, s[:160]))


describe(obj)
