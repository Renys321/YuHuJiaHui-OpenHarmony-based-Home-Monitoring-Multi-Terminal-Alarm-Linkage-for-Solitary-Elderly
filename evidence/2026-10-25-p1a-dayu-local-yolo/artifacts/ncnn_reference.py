"""PC reference for ncnn YOLO11n-pose decode (preparation/verification only).

This mirrors the on-device C++ preprocessing/postprocessing so the decode logic can be
validated against the PyTorch reference before cross-compiling.
"""
import argparse, json, math, time
import cv2
import numpy as np
import ncnn


def letterbox_params(img_w, img_h, target=640):
    scale = min(target / img_w, target / img_h)
    w = int(round(img_w * scale))
    h = int(round(img_h * scale))
    dw = target - w
    dh = target - h
    left = dw // 2
    top = dh // 2
    return w, h, dw, dh, left, top, scale


def nms(boxes, scores, thr):
    order = np.argsort(-scores)
    keep = []
    while order.size > 0:
        i = order[0]
        keep.append(int(i))
        if order.size == 1:
            break
        xx1 = np.maximum(boxes[i, 0], boxes[order[1:], 0])
        yy1 = np.maximum(boxes[i, 1], boxes[order[1:], 1])
        xx2 = np.minimum(boxes[i, 2], boxes[order[1:], 2])
        yy2 = np.minimum(boxes[i, 3], boxes[order[1:], 3])
        inter = np.maximum(0.0, xx2 - xx1) * np.maximum(0.0, yy2 - yy1)
        area_i = (boxes[i, 2] - boxes[i, 0]) * (boxes[i, 3] - boxes[i, 1])
        area_o = (boxes[order[1:], 2] - boxes[order[1:], 0]) * (boxes[order[1:], 3] - boxes[order[1:], 1])
        iou = inter / (area_i + area_o - inter + 1e-9)
        order = order[1:][iou <= thr]
    return keep


def detect(param, binf, image, conf_thr=0.25, nms_thr=0.45, target=640):
    bgr = cv2.imread(image, cv2.IMREAD_COLOR)
    if bgr is None:
        raise SystemExit(f"cannot read {image}")
    img_h, img_w = bgr.shape[:2]
    w, h, dw, dh, left, top, scale = letterbox_params(img_w, img_h, target)
    mat = ncnn.Mat.from_pixels_resize(bgr.tobytes(), ncnn.Mat.PixelType.PIXEL_BGR2RGB, img_w, img_h, w, h)
    padded = ncnn.copy_make_border(mat, top, dh - top, left, dw - left,
                                   ncnn.BorderType.BORDER_CONSTANT, 114.0)
    padded.substract_mean_normalize([], [1 / 255.0, 1 / 255.0, 1 / 255.0])
    net = ncnn.Net()
    net.opt.use_vulkan_compute = False
    net.opt.num_threads = 4
    net.load_param(param)
    net.load_model(binf)
    t0 = time.time()
    ex = net.create_extractor()
    ex.input("in0", padded)
    rc, out = ex.extract("out0")
    infer_ms = (time.time() - t0) * 1000.0
    if rc != 0:
        raise SystemExit(f"extract failed rc={rc}")
    features = out.h
    anchors = out.w
    boxes, scores, kpts = [], [], []
    for a in range(anchors):
        s = float(out.row(4)[a])
        if s < conf_thr:
            continue
        cx = float(out.row(0)[a]); cy = float(out.row(1)[a])
        bw = float(out.row(2)[a]); bh = float(out.row(3)[a])
        x0 = (cx - bw / 2 - left) / scale
        y0 = (cy - bh / 2 - top) / scale
        x1 = (cx + bw / 2 - left) / scale
        y1 = (cy + bh / 2 - top) / scale
        boxes.append([x0, y0, x1, y1])
        scores.append(s)
        kp = []
        for k in range(17):
            kx = (float(out.row(5 + k * 3)[a]) - left) / scale
            ky = (float(out.row(6 + k * 3)[a]) - top) / scale
            kc = float(out.row(7 + k * 3)[a])
            kp.append([kx, ky, kc])
        kpts.append(kp)
    if boxes:
        boxes_np = np.asarray(boxes, dtype=np.float32)
        scores_np = np.asarray(scores, dtype=np.float32)
        keep = nms(boxes_np, scores_np, nms_thr)
    else:
        keep = []
    dets = []
    for i in keep:
        b = boxes[i]
        dets.append({
            "bbox": [round(b[0], 2), round(b[1], 2), round(b[2], 2), round(b[3], 2)],
            "conf": round(float(scores[i]), 5),
            "keypoints": [[round(k[0], 1), round(k[1], 1), round(float(k[2]), 4)] for k in kpts[i]],
        })
    return {
        "image": image, "img_w": img_w, "img_h": img_h,
        "input_w": w, "input_h": h, "pad_left": left, "pad_top": top, "scale": round(scale, 6),
        "personCount": len(dets), "detections": dets,
        "output_shape": [features, anchors], "infer_ms_pc_reference": round(infer_ms, 2),
    }


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--param", required=True)
    ap.add_argument("--bin", required=True)
    ap.add_argument("--image", required=True)
    ap.add_argument("--out", default="")
    a = ap.parse_args()
    res = detect(a.param, a.bin, a.image)
    print(json.dumps(res, ensure_ascii=False, indent=1))
    if a.out:
        open(a.out, "w", encoding="utf-8").write(json.dumps(res, ensure_ascii=False, indent=1))


