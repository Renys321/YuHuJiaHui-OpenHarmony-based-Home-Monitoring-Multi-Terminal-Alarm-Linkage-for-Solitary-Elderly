from ultralytics import YOLO
import os, shutil
base = r"D:\OpenHarmony\competition\evidence\2026-10-25-p1b-dayu-local-fall"
model = YOLO(r"D:\OpenHarmony\competition\vision\yolo11n-pose.pt")
for size in (416, 320):
    out = model.export(format="ncnn", imgsz=size, half=False, batch=1, device="cpu")
    src = str(out)
    dst = os.path.join(base, "models", str(size))
    os.makedirs(dst, exist_ok=True)
    for f in ("model.ncnn.param", "model.ncnn.bin", "metadata.yaml"):
        s = os.path.join(src, f)
        if os.path.exists(s):
            shutil.copy2(s, os.path.join(dst, f))
    print("EXPORTED", size, dst)
