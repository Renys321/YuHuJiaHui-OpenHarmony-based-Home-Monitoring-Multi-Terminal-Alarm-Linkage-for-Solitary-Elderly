"""把 hvigor 产出的 unsigned hap 处理成"能装进 API 11 板子"的版本。

背景（实测结论，见交接文档 §0.5.6）：
  SDK 26 打包时会写入 rpcid.sc —— 一张【全量 syscap 名表】（首个是 API 12+ 才有的
  SystemCapability.ArkUI.ArkUI.Circle）。板子的 BMS 是 OH 4.1 时代实现，会逐条要求设备具备
  这些能力，于是 install 直接失败（code 9568293 / check syscap failed）。
  本应用只用 Column/Text，不需要那份表 → 直接剔除 rpcid.sc 即可。

用法:
  python strip_rpcid.py [输入hap] [输出hap]
  默认: entry/build/default/outputs/default/entry-default-unsigned.hap
      -> signing/app-unsigned-norpc.hap
"""
import os
import sys
import zipfile

BUILD_OUT = r"D:\OpenHarmony\hellohap\entry\build\default\outputs\default\entry-default-unsigned.hap"
DST = r"D:\OpenHarmony\hellohap\signing\app-unsigned-norpc.hap"

src = sys.argv[1] if len(sys.argv) > 1 else BUILD_OUT
dst = sys.argv[2] if len(sys.argv) > 2 else DST

if not os.path.exists(src):
    print("找不到输入 hap:", src)
    print("请先在工程目录执行 hvigorw assembleHap（见交接文档 §0.5.6 路线 B）")
    sys.exit(1)

zin = zipfile.ZipFile(src)
removed = []
with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as zo:
    for name in zin.namelist():
        if name in ("rpcid.sc",):
            removed.append(name)
            continue
        zo.writestr(name, zin.read(name))

print("输入:", src)
print("输出:", dst, f"({os.path.getsize(dst)} bytes)")
print("剔除:", removed if removed else "（输入里本来就没有 rpcid.sc）")
