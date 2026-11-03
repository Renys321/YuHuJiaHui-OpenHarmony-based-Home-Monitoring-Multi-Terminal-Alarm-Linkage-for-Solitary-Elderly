from ultralytics import YOLO
import os
os.chdir(r"D:\OpenHarmony\competition\vision\dayu-local\export")
m = YOLO(r"D:\OpenHarmony\competition\vision\yolo11n-pose.pt")
out = m.export(format="ncnn", imgsz=640, half=False, batch=1, device="cpu")
print("EXPORT_RESULT", out)
