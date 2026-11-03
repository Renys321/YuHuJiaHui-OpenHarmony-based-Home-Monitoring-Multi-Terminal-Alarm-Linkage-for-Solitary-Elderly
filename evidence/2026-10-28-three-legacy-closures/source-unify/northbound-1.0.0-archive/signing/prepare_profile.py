"""为 DAYU200(API 11) 准备 OpenHarmony debug profile 与签名证书链。

关键事实（实测得出，容易踩）：
  1. p12 里 'openharmony application release' 那张证书是【自签名】的，
     它只是私钥的载体；真正的应用证书是 profile 模板里内嵌的
     development-certificate（签发者 = OpenHarmony Application CA）。
  2. 正确的 -appCertFile 链 = 模板证书 -> OpenHarmony Application CA -> Root CA，
     少一张就报 "Profile cert must a cert chain"，链不对就报 "Signature does not match"。
  3. debug profile 只允许 device-ids 里列出的设备安装，必须填板子的 UDID。
  4. 模板里的 validity 早已过期（2021~2023），必须改成当前有效期。
"""
import json
import re
import time
import uuid
import base64
import os

LIB = r"D:\DevEcoStudio\DevEco Studio\sdk\default\openharmony\toolchains\lib"
SIGN = r"D:\OpenHarmony\hellohap\signing"
BUNDLE = "com.dsh.hellohap"
UDID = "DC3ABD0514880C60A274F7442EC3C068F4E3C2EE59F28D1BF2DD35CE49C0D54C"

with open(os.path.join(LIB, "UnsgnedDebugProfileTemplate.json"), "r", encoding="utf-8") as f:
    p = json.load(f)

# --- 应用证书（就是模板里内嵌的那张，不要替换成 p12 的自签名证书！） ---
app_cert_pem = p["bundle-info"]["development-certificate"]

# --- profile 本体改写 ---
now = int(time.time())
p["uuid"] = str(uuid.uuid4())
p["validity"] = {"not-before": now - 3600, "not-after": now + 10 * 365 * 24 * 3600}
p["bundle-info"]["bundle-name"] = BUNDLE
p["debug-info"]["device-ids"] = [UDID]
p["debug-info"]["device-id-type"] = "udid"

with open(os.path.join(SIGN, "profile-debug.json"), "w", encoding="utf-8") as f:
    json.dump(p, f, indent=4, ensure_ascii=False)

# --- 生成签名证书链：应用证书 + CA + Root CA ---
def read(p_):
    return open(p_, "r", encoding="ascii").read().strip()

chain = [app_cert_pem.strip(), read(os.path.join(SIGN, "ca.pem")), read(os.path.join(SIGN, "rootca.pem"))]
with open(os.path.join(SIGN, "app-chain.pem"), "w", encoding="ascii") as f:
    f.write("\n".join(chain) + "\n")

print("bundle-name  :", p["bundle-info"]["bundle-name"])
print("device-ids   :", p["debug-info"]["device-ids"])
print("validity     :", p["validity"])
print("证书链张数   :", sum(c.count("BEGIN CERTIFICATE") for c in chain))
print("profile  ->", os.path.join(SIGN, "profile-debug.json"))
print("certchain ->", os.path.join(SIGN, "app-chain.pem"))
