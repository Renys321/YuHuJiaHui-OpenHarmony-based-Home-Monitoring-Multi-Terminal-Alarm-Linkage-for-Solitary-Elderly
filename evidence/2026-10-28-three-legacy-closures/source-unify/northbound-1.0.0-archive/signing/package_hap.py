"""北向 APP 打包前处理：剔除 rpcid.sc + 生成与 bundle 匹配的 debug profile。

背景见交接文档 §0.5.6：
  - SDK 26 会写入 rpcid.sc（全量 syscap 表），OH 4.1 的 BMS 会逐条校验 → 删掉即可
  - debug profile 必须内嵌【p12 里那张真实应用证书】（不是自签占位证书），
    且要填 bundle-name 与目标设备 UDID、并把有效期改到当前
用法: python package_hap.py <unsigned.hap> <bundleName>
"""
import json
import os
import re
import sys
import time
import uuid
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
LIB = r"D:\DevEcoStudio\DevEco Studio\sdk\default\openharmony\toolchains\lib"


def read_provision_udid():
    value = os.environ.get("DAYU_PROVISION_UDID", "").strip()
    if not re.fullmatch(r"[A-Fa-f0-9]{64}", value):
        raise SystemExit("DAYU_PROVISION_UDID is required and must be a 64-character hexadecimal value")
    return value.upper()

src = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    HERE, "..", "entry", "build", "default", "outputs", "default", "entry-default-unsigned.hap")
bundle = sys.argv[2] if len(sys.argv) > 2 else "com.dsh.eldercare"
src = os.path.abspath(src)
udid = read_provision_udid()

# --- 1) 剔除 rpcid.sc ---
dst = os.path.join(HERE, "app-unsigned-norpc.hap")
zin = zipfile.ZipFile(src)
removed = []
with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as zo:
    for name in zin.namelist():
        if name == "rpcid.sc":
            removed.append(name)
            continue
        zo.writestr(name, zin.read(name))
print(f"unsigned: {src} ({os.path.getsize(src):,} 字节)")
print(f"剔除了   : {removed if removed else '（本来就没有 rpcid.sc）'}")
print(f"输出     : {dst} ({os.path.getsize(dst):,} 字节)")

# --- 2) 生成 profile（内嵌 p12 的真实应用证书） ---
with open(os.path.join(LIB, "UnsgnedDebugProfileTemplate.json"), "r", encoding="utf-8") as f:
    p = json.load(f)

p["uuid"] = str(uuid.uuid4())
now = int(time.time())
p["validity"] = {"not-before": now - 3600, "not-after": now + 10 * 365 * 24 * 3600}
p["bundle-info"]["bundle-name"] = bundle
p["debug-info"]["device-ids"] = [udid]
p["debug-info"]["device-id-type"] = "udid"

out = os.path.join(HERE, "profile-debug.json")
with open(out, "w", encoding="utf-8") as f:
    json.dump(p, f, indent=4, ensure_ascii=False)
print(f"profile  : {out}  bundle={bundle}  udid=provided")
