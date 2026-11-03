# -*- coding: utf-8 -*-
"""大字号示意图（DOCX 与 PPT 共用）。

设计目标：图像缩放到 15cm（DOCX）或 7in（PPT）宽时，正文字号仍 ≥9pt，
因此画布宽度 1600px、正文字号 26–30px（约 1.7–1.9% 宽度）。

用法：python -c "import figures; figures.make_all('docs/submission/figures')"
"""
import math
import os

from PIL import Image, ImageDraw, ImageFont

FONT = "C:/Windows/Fonts/msyh.ttc"
FONT_B = "C:/Windows/Fonts/msyhbd.ttc"

NAVY = "#16324F"
BLUE = "#3F7DE6"
GRAY = "#5A6B7B"
LIGHT = "#F2F6FC"
GREEN = "#2E8B57"
ORANGE = "#C77C11"
RED = "#C0392B"


def _font(size, bold=False):
    return ImageFont.truetype(FONT_B if bold else FONT, size)


def _box(d, xy, text, fill=LIGHT, outline=BLUE, size=26, bold=False, radius=12):
    d.rounded_rectangle(xy, radius=radius, fill=fill, outline=outline, width=3)
    f = _font(size, bold)
    lines = text.split("\n")
    lh = size + 8
    y = xy[1] + (xy[3] - xy[1] - lh * len(lines)) / 2
    for ln in lines:
        w = d.textlength(ln, font=f)
        d.text((xy[0] + (xy[2] - xy[0] - w) / 2, y), ln, font=f, fill=NAVY)
        y += lh


def _arrow(d, p1, p2, label="", color=BLUE, size=22):
    d.line([p1, p2], fill=color, width=4)
    ang = math.atan2(p2[1] - p1[1], p2[0] - p1[0])
    for s in (0.5, -0.5):
        d.line([p2, (p2[0] - 18 * math.cos(ang + s), p2[1] - 18 * math.sin(ang + s))],
               fill=color, width=4)
    if label:
        f = _font(size)
        mx, my = (p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2
        lines = label.split("\n")
        widths = [d.textlength(t, font=f) for t in lines]
        bw, bh = max(widths) + 12, len(lines) * (size + 6) + 6
        top = my - bh / 2
        d.rectangle([mx - bw / 2, top, mx + bw / 2, top + bh], fill="white")
        y = top + 3
        for ln, w in zip(lines, widths):
            d.text((mx - w / 2, y), ln, font=f, fill=GRAY)
            y += size + 6


def _text(d, xy, text, size=20, color=GRAY):
    f = _font(size)
    w = d.textlength(text, font=f)
    d.rectangle([xy[0] - 6, xy[1] - 4, xy[0] + w + 6, xy[1] + size + 10], fill="white")
    d.text(xy, text, font=f, fill=color)


def fig_architecture(path):
    W, H = 1600, 1090
    im = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(im)
    d.text((40, 22), "总体架构：端—边—网关—云—应用", font=_font(38, True), fill=NAVY)
    bands = [
        (86, "应用层", [("监护 APP（手机端）", 900, 460)]),
        (300, "云端", [("公网后端  HTTPS", 480, 620)]),
        (514, "本地网关", [("bridge + MQTT" + chr(10) + "1883 / 9101", 50, 330),
                        ("语音网关" + chr(10) + "9302 / 9303 / 9102", 430, 400),
                        ("视觉" + chr(10) + "9200", 880, 210),
                        ("视频 relay" + chr(10) + "9443", 1130, 230)]),
        (728, "边缘主控", [("DAYU200 homemon 9000", 300, 560), ("板载 APP", 1000, 340)]),
        (942, "房间节点", [("厨房 S3", 160, 250), ("卫生间 S3", 470, 250), ("随身 SOS", 1300, 260)]),
    ]
    for y0, label, items in bands:
        d.rectangle([30, y0 - 22, W - 30, y0 + 148], outline="#C9D6E8", width=2)
        d.text((46, y0 - 18), label, font=_font(28, True), fill=GRAY)
        for text, x, w in items:
            _box(d, (x, y0 + 16, x + w, y0 + 132), text, size=26)
    _arrow(d, (120, 958), (120, 650))
    _text(d, (135, 792), "Wi-Fi 9101", 22)
    _arrow(d, (300, 800), (200, 650))
    _text(d, (206, 664), "hdc 9001", 22)
    _arrow(d, (860, 780), (760, 650))
    _text(d, (700, 700), "rport 9200 / 9302", 22)
    _arrow(d, (862, 800), (996, 800))
    _text(d, (890, 752), "本地", 22)
    _arrow(d, (800, 490), (800, 436))
    _text(d, (816, 452), "HTTPS", 22)
    _arrow(d, (1000, 276), (1000, 236))
    _text(d, (1016, 240), "HTTPS", 22)
    _arrow(d, (1430, 958), (1430, 436), color=ORANGE)
    _text(d, (1446, 700), "4G 上云", 22)
    im.save(path, "PNG")


def fig_uplink(path):
    W, H = 1600, 760
    im = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(im)
    d.text((40, 22), "状态上行与多端同步", font=_font(38, True), fill=NAVY)
    xs = [40, 340, 640, 940, 1240]
    texts = ["ESP32 节点\nJSON 行", "bridge\nTCP 9101", "MQTT\n1883",
             "public-sync\nHTTPS 上云", "监护 APP"]
    for x, t in zip(xs, texts):
        _box(d, (x, 200, x + 270, 340), t, size=26)
    for i in range(4):
        _arrow(d, (xs[i] + 274, 270), (xs[i + 1] - 6, 270), "", size=20)
    _arrow(d, (450, 480), (450, 346), "hdc 9001→9000", size=20)
    _box(d, (260, 480, 760, 620), "DAYU200 homemon\n状态 / 告警 / 视频票据", size=26,
         fill="#FFF7EC", outline=ORANGE)
    d.text((40, 650), "在线判定 12 秒；MQTT QoS0；状态限频去重", font=_font(24), fill=GRAY)
    d.text((40, 700), "板载 APP 经 homemon 本地供数，不走此链", font=_font(22), fill=GRAY)
    im.save(path, "PNG")


def fig_ack(path):
    W, H = 1600, 840
    im = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(im)
    d.text((40, 22), "设备级 ACK 闭环（受理不等于闭环）", font=_font(38, True), fill=NAVY)
    actors = ["监护 APP", "云端", "public-sync", "bridge / MQTT", "设备"]
    xs = [130, 470, 800, 1110, 1450]
    for x, a in zip(xs, actors):
        _box(d, (x - 110, 92, x + 110, 158), a, size=26)
        d.line([(x, 158), (x, 790)], fill="#C9D6E8", width=3)
    msgs = [
        (0, 1, 220, "① ACK 请求（alarmId）"),
        (1, 0, 290, "② 受理应答（PENDING）"),
        (1, 2, 360, "③ 待下发队列"),
        (2, 3, 430, "④ 命令同步"),
        (3, 4, 500, "⑤ cmd 下行"),
        (4, 1, 590, "⑥ 回执 ACKED"),
        (1, 0, 680, "⑦ APP 已闭环"),
    ]
    for a, b, y, label in msgs:
        color = BLUE if b > a else ORANGE
        _arrow(d, (xs[a], y), (xs[b], y), label, color=color, size=20)
    d.text((40, 795), "alarmId 精确匹配；8 秒无回执判超时；离线设备拒绝 ACK", font=_font(24), fill=GRAY)
    im.save(path, "PNG")


def fig_fall(path):
    W, H = 1600, 780
    im = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(im)
    d.text((40, 22), "视觉跌倒：只提交受限事件", font=_font(38, True), fill=NAVY)
    chain = [("摄像头", 40, 240), ("送帧", 320, 200), ("YOLO pose", 560, 250),
             ("时序状态机", 870, 260), ("受限 fall", 1200, 240)]
    for i, (t, x, w) in enumerate(chain):
        fill = "#FFF2F2" if i == 4 else "#F2FFF5"
        line = RED if i == 4 else GREEN
        _box(d, (x, 190, x + w, 330), t, fill=fill, outline=line, size=26)
    for i in range(4):
        _arrow(d, (chain[i][1] + chain[i][2] + 4, 260), (chain[i + 1][1] - 6, 260), "", size=20)
    d.text((40, 380), "条件：近期直立 → 髋部快速下落 → 低位姿态持续", font=_font(24), fill=GRAY)
    d.text((40, 420), "边界：PC CPU 基线，短时约 2 FPS；真人准确率未测", font=_font(24), fill=GRAY)
    st = [("NORMAL", 160), ("SUSPECTED", 560), ("FALLEN", 980)]
    for name, x in st:
        _box(d, (x, 520, x + 320, 660), name, size=28, fill="#F7F9FC")
    _arrow(d, (484, 590), (556, 590), "髋部下落", size=20)
    _arrow(d, (884, 590), (976, 590), "持续低位", size=20)
    _arrow(d, (1140, 700), (330, 700), "恢复直立 / 关闭预览", size=20, color=GRAY)
    im.save(path, "PNG")


def make_all(outdir):
    os.makedirs(outdir, exist_ok=True)
    targets = {
        "fig3-1-architecture.png": fig_architecture,
        "fig3-2-uplink.png": fig_uplink,
        "fig5-1-ack.png": fig_ack,
        "fig5-2-fall.png": fig_fall,
    }
    for name, fn in targets.items():
        fn(os.path.join(outdir, name))
    return [os.path.join(outdir, n) for n in targets]


if __name__ == "__main__":
    base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out = os.path.join(base, "docs", "submission", "figures")
    for p in make_all(out):
        print(p, os.path.getsize(p))
