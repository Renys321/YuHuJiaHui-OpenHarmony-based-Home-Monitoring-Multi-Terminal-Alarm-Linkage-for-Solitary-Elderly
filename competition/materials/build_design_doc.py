# -*- coding: utf-8 -*-
"""生成《设计方案》DOCX（赛题四）。

规格：A4；正文宋体小四 1.5 倍行距；标题黑体；自动目录；页码；图表编号与题注；三线表。
内容口径：只写可核实的能力，未实测项明确标注；不出现学校/教师/队员/队名、绝对路径、密钥。
用法（使用 DSH 捆绑 Python）：
    python build_design_doc.py
输出：docs/submission/设计方案.docx
"""
import os
from docx import Document
from docx.shared import Pt, Cm, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.section import WD_SECTION
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.oxml.ns import qn
from docx.oxml import OxmlElement
from PIL import Image, ImageDraw, ImageFont

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SUBMIT = os.path.join(BASE, "docs", "submission")
FIGDIR = os.path.join(SUBMIT, "figures")
OUT = os.path.join(SUBMIT, "设计方案.docx")
os.makedirs(FIGDIR, exist_ok=True)

FONT = "C:/Windows/Fonts/msyh.ttc"
FONT_B = "C:/Windows/Fonts/msyhbd.ttc"


# ============================ 制图（PIL） ============================
def _font(size, bold=False):
    return ImageFont.truetype(FONT_B if bold else FONT, size)


def _box(d, xy, text, fill="#F2F6FF", outline="#3F7DE6", size=20, bold=False):
    d.rounded_rectangle(xy, radius=10, fill=fill, outline=outline, width=2)
    f = _font(size, bold)
    lines = text.split("\n")
    h = len(lines) * (size + 6)
    y = (xy[1] + xy[3] - h) / 2
    for ln in lines:
        w = d.textlength(ln, font=f)
        d.text(((xy[0] + xy[2] - w) / 2, y), ln, font=f, fill="#16324F")
        y += size + 6


def _arrow(d, p1, p2, label="", color="#3F7DE6", size=16, dash=False):
    import math
    if dash:
        # 手绘虚线
        dist = math.hypot(p2[0] - p1[0], p2[1] - p1[1])
        steps = max(1, int(dist // 12))
        for i in range(0, steps, 2):
            a = (p1[0] + (p2[0] - p1[0]) * i / steps, p1[1] + (p2[1] - p1[1]) * i / steps)
            b = (p1[0] + (p2[0] - p1[0]) * (i + 1) / steps, p1[1] + (p2[1] - p1[1]) * (i + 1) / steps)
            d.line([a, b], fill=color, width=3)
    else:
        d.line([p1, p2], fill=color, width=3)
    ang = math.atan2(p2[1] - p1[1], p2[0] - p1[0])
    for s in (0.45, -0.45):
        d.line([p2, (p2[0] - 14 * math.cos(ang + s), p2[1] - 14 * math.sin(ang + s))], fill=color, width=3)
    if label:
        f = _font(size)
        mx, my = (p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2
        lines = label.split("\n")
        widths = [d.textlength(ln, font=f) for ln in lines]
        bw, bh = max(widths) + 8, len(lines) * (size + 4) + 4
        top = my - bh / 2
        d.rectangle([mx - bw / 2, top, mx + bw / 2, top + bh], fill="white")
        y = top + 2
        for ln, w in zip(lines, widths):
            d.text((mx - w / 2, y), ln, font=f, fill="#5A6B7B")
            y += size + 4


def fig_architecture(path):
    W, H = 1700, 1360
    im = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(im)
    d.text((40, 20), "图 3-1  总体架构：端—边—本地网关—云—应用", font=_font(28, True), fill="#16324F")
    bands = [
        (70, "应用层", [
            ("手机监护人 APP\n登录/告警/ACK/自述安全", 120, 380),
            ("板载 APP\n实时状态/摄像头/AI 问答", 1000, 380)]),
        (330, "云端", [
            ("公网后端  https://api.*\n鉴权 / 告警 / 命令 / 自述安全 / 证据", 420, 500)]),
        (590, "本地网关（PC）", [
            ("bridge + broker\n1883 / 9101", 90, 210),
            ("voice-gateway\n9302 / 9303 / 9102", 620, 210),
            ("vision\n9200", 1120, 120),
            ("video relay\n9443", 1360, 120)]),
        (850, "边缘主控 DAYU200", [
            ("homemon 9000 + 板载 APP\n摄像头 / 人体检测 / 声光语音", 380, 560)]),
        (1110, "房间节点", [
            ("ESP32-S3 厨房\nesp32-kitchen", 200, 330),
            ("ESP32-S3 卫生间\nesp32-bath", 640, 330),
            ("随身 SOS\n4G / 定位", 1180, 300)]),
    ]
    for y0, label, items in bands:
        d.rectangle([30, y0 - 24, W - 30, y0 + 150], outline="#C9D6E8", width=2)
        d.text((44, y0 - 18), label, font=_font(22, True), fill="#5A6B7B")
        for text, x, w in items:
            _box(d, (x, y0 + 20, x + w, y0 + 130), text, size=17)
    # 节点经 Wi-Fi 直连 PC 网关（不经过 DAYU）
    _arrow(d, (1520, 1086), (1520, 745), "Wi-Fi TCP 9101 / 9303 / 9102", size=14)
    # DAYU 与本地网关的 hdc 映射
    _arrow(d, (380, 905), (250, 724), "hdc fport 9001→9000", size=14)
    _arrow(d, (720, 724), (720, 866), "rport 9200 / 9302", size=14)
    # PC 与云
    _arrow(d, (760, 590), (760, 480), "HTTPS 443 上行/下行", size=15)
    _arrow(d, (760, 330), (760, 250), "HTTPS / 轮询", size=15)
    # 视频
    _arrow(d, (940, 950), (1420, 724), "视频 9301 / 帧 9200", size=14)
    im.save(path, "PNG")


def fig_uplink(path):
    W, H = 2060, 800
    im = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(im)
    d.text((40, 20), "图 3-2  状态上行与多端同步", font=_font(28, True), fill="#16324F")
    nodes = [
        ("ESP32-S3 节点\nJSON 行 / 毫秒 ts", 40, 260),
        ("bridge\nTCP 9101", 380, 260),
        ("broker\nMQTT 1883", 720, 260),
        ("public-sync\n隐藏输入摄入密钥", 1060, 260),
        ("公网后端\n/internal/v1/device-status", 1400, 260),
        ("监护 APP（手机端） / 板载 APP\n告警与状态", 1740, 260),
    ]
    for text, x, y in nodes:
        _box(d, (x, y, x + 260, y + 120), text, size=16)
    gaps = [(302, 380, "状态行"), (642, 720, "status"), (982, 1060, "限频/去重"),
            (1322, 1400, "HTTPS 202"), (1662, 1740, "轮询")]
    for x1, x2, lb in gaps:
        _arrow(d, (x1, 320), (x2 - 4, 320), lb, size=13)
    _box(d, (380, 500, 980, 640), "DAYU200 homemon\n状态 / 告警 / 视频票据", size=17,
         fill="#FFF7EC", outline="#E6A23C")
    _arrow(d, (680, 500), (860, 376), "hdc fport 9001→9000", size=14)
    d.text((40, 700), "在线判定：12 秒无新状态标离线；MQTT QoS0，不做离线补传；状态时间用 PC 接收时间兜底。",
           font=_font(17), fill="#5A6B7B")
    im.save(path, "PNG")


def fig_ack(path):
    W, H = 1700, 900
    im = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(im)
    d.text((40, 20), "图 5-1  设备级 ACK 闭环时序（HTTP 202 ≠ 闭环）", font=_font(28, True), fill="#16324F")
    actors = ["监护 APP（手机端）", "公网后端", "public-sync", "bridge / MQTT", "房间设备"]
    xs = [140, 480, 820, 1160, 1520]
    for x, a in zip(xs, actors):
        _box(d, (x - 110, 70, x + 110, 130), a, size=18)
        d.line([(x, 130), (x, 840)], fill="#C9D6E8", width=2)
    msgs = [
        (0, 1, 170, "① ACK 请求（alarmId）"),
        (1, 0, 250, "② 202 PENDING（仅入队）"),
        (1, 2, 330, "③ 待下发队列"),
        (2, 3, 410, "④ 命令同步（受限白名单）"),
        (3, 4, 490, "⑤ cmd（不嵌套 route/relay）"),
        (4, 3, 570, "⑥ 校验 alarmId 精确匹配"),
        (3, 1, 650, "⑦ 设备回执 ACKED"),
        (1, 2, 730, "⑧ 告警转 ACKED / 队列结清"),
        (1, 0, 810, "⑨ APP 显示已闭环"),
    ]
    for a, b, y, label in msgs:
        x1, x2 = xs[a], xs[b]
        color = "#3F7DE6" if x2 > x1 else "#E6A23C"
        _arrow(d, (x1, y), (x2, y), label, color=color, size=15)
    d.text((60, 850), "约束：状态必须为 ALARM 且 alarmId 精确匹配；8 秒无匹配状态判超时；离线设备拒绝 ACK；HTTP 到达不算闭环。",
           font=_font(16), fill="#5A6B7B")
    im.save(path, "PNG")


def fig_fall(path):
    W, H = 1700, 760
    im = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(im)
    d.text((40, 20), "图 5-2  视觉跌倒链路与时序状态机", font=_font(28, True), fill="#16324F")
    seq = [
        ("DAYU200 摄像头\n前台预览", 40, 220),
        ("USB 有界送帧\n640×480", 300, 220),
        ("PC 视觉服务\nletterbox→640×384", 560, 240),
        ("YOLO11n-pose\n17 关键点", 860, 220),
        ("时序状态机\n正常→疑似→跌倒", 1140, 240),
        ("受限 fall 事件\n→ homemon 告警", 1450, 220),
    ]
    for i, (text, x, w) in enumerate(seq):
        warn = (i == 4)
        _box(d, (x, 200, x + w, 330), text, size=16,
             fill="#FFF2F2" if warn else "#F2FFF5",
             outline="#D9534F" if warn else "#2EA36B")
    for i in range(len(seq) - 1):
        _arrow(d, (seq[i][1] + seq[i][2] + 2, 265), (seq[i + 1][1] - 8, 265), "", size=14)
    d.text((60, 390), "判定条件（缺一不可）：近期直立 → 快速髋部下落 → 低位水平姿态持续；不同 trackID 历史不得拼接。",
           font=_font(17), fill="#5A6B7B")
    d.text((60, 440), "边界：当前为 PC CPU 基线，短时约 2 FPS；仅 APP 前台有效；30 秒丢弃陈旧事件；PC 10 秒无帧触发失联提示。",
           font=_font(17), fill="#5A6B7B")
    # 状态机小图
    st = [("NORMAL", 80), ("SUSPECTED", 420), ("FALLEN", 780)]
    for name, x in st:
        _box(d, (x, 560, x + 250, 660), name, size=18, fill="#F7F9FC")
    _arrow(d, (334, 610), (414, 610), "髋部快速下落", size=14)
    _arrow(d, (674, 610), (774, 610), "持续低位", size=14)
    _arrow(d, (900, 690), (300, 690), "恢复直立 / 用户关闭预览（虚线回退）", size=14, dash=True)
    im.save(path, "PNG")


FIG_ARCH = os.path.join(FIGDIR, "fig3-1-architecture.png")
FIG_UP = os.path.join(FIGDIR, "fig3-2-uplink.png")
FIG_ACK = os.path.join(FIGDIR, "fig5-1-ack.png")
FIG_FALL = os.path.join(FIGDIR, "fig5-2-fall.png")
FIG_APPS = os.path.join(FIGDIR, "fig4-1-apps.png")
# 统一使用大字号图（materials/figures.py），保证 15cm 宽时正文仍可读
import sys as _sys
_sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from figures import make_all as _make_figs
_make_figs(FIGDIR)


# ============================ DOCX 基础样式 ============================
doc = Document()

sec = doc.sections[0]
sec.page_width, sec.page_height = Cm(21.0), Cm(29.7)   # A4
sec.left_margin = sec.right_margin = Cm(2.6)
sec.top_margin = sec.bottom_margin = Cm(2.4)

normal = doc.styles["Normal"]
normal.font.name = "宋体"
normal.font.size = Pt(12)                              # 小四
normal.element.rPr.rFonts.set(qn("w:eastAsia"), "宋体")
pf = normal.paragraph_format
pf.line_spacing = 1.5
pf.space_after = Pt(0)

for lvl, size in ((1, 16), (2, 14), (3, 12)):
    st = doc.styles["Heading %d" % lvl]
    st.font.name = "黑体"
    st.element.rPr.rFonts.set(qn("w:eastAsia"), "黑体")
    st.font.size = Pt(size)
    st.font.bold = True
    st.font.color.rgb = RGBColor(0, 0, 0)
    st.paragraph_format.line_spacing = 1.5
    st.paragraph_format.space_before = Pt(12)
    st.paragraph_format.space_after = Pt(6)

doc.styles["Title"].font.name = "黑体"
doc.styles["Title"].element.rPr.rFonts.set(qn("w:eastAsia"), "黑体")
doc.styles["Title"].font.size = Pt(26)

# 图表/表格题注样式（五号宋体居中）
try:
    cap = doc.styles["Caption"]
except KeyError:
    from docx.enum.style import WD_STYLE_TYPE
    cap = doc.styles.add_style("Caption", WD_STYLE_TYPE.PARAGRAPH)
cap.font.name = "宋体"
cap.element.rPr.rFonts.set(qn("w:eastAsia"), "宋体")
cap.font.size = Pt(10.5)
cap.font.color.rgb = RGBColor(0, 0, 0)
cap.paragraph_format.alignment = WD_ALIGN_PARAGRAPH.CENTER
cap.paragraph_format.line_spacing = 1.0


def _set_run_font(run, name="宋体", size=12, bold=False):
    run.font.name = name
    run._element.rPr.rFonts.set(qn("w:eastAsia"), name)
    run.font.size = Pt(size)
    run.bold = bold


_bullet_seq = 0


def H(text, level=1):
    global _bullet_seq
    _bullet_seq = 0
    doc.add_heading(text, level=level)


def _add_rich(p, text, size=12, bold=False):
    parts = text.split("**")
    for i, part in enumerate(parts):
        if not part:
            continue
        r = p.add_run(part)
        _set_run_font(r, size=size, bold=bold or (i % 2 == 1))


def P(text, indent=True, bold=False, size=12):
    p = doc.add_paragraph()
    if indent:
        p.paragraph_format.first_line_indent = Pt(size * 2)
    _add_rich(p, text, size=size, bold=bold)
    return p


def BULLET(text):
    global _bullet_seq
    _bullet_seq += 1
    p = doc.add_paragraph()
    p.paragraph_format.left_indent = Pt(24)
    p.paragraph_format.first_line_indent = Pt(-12)
    p.paragraph_format.line_spacing = 1.5
    _add_rich(p, "（%d）" % _bullet_seq + text)
    return p


def _tbl_borders(t):
    tblPr = t._tbl.tblPr
    b = OxmlElement("w:tblBorders")
    for edge, val, sz in (("top", "single", 12), ("bottom", "single", 12),
                          ("left", "none", 0), ("right", "none", 0),
                          ("insideH", "none", 0), ("insideV", "none", 0)):
        e = OxmlElement("w:" + edge)
        e.set(qn("w:val"), val)
        e.set(qn("w:sz"), str(sz))
        e.set(qn("w:space"), "0")
        e.set(qn("w:color"), "000000")
        b.append(e)
    # 按 OOXML 顺序插入，避免 tblBorders 出现在 tblLayout 之后导致文档被判定需修复
    tblPr.insert_element_before(b, "w:shd", "w:tblLayout", "w:tblCellMar", "w:tblLook")


def _header_bottom(cell):
    tcPr = cell._tc.get_or_add_tcPr()
    b = OxmlElement("w:tcBorders")
    e = OxmlElement("w:bottom")
    e.set(qn("w:val"), "single")
    e.set(qn("w:sz"), "6")
    e.set(qn("w:color"), "000000")
    b.append(e)
    tcPr.append(b)


def TABLE(headers, rows, widths=None, caption=None):
    if caption:
        p = doc.add_paragraph(style="Caption")
        _set_run_font(p.add_run("表 "), size=10.5)
        _field(p, 'STYLEREF 1 \s', "1")
        _set_run_font(p.add_run("-"), size=10.5)
        _field(p, 'SEQ 表 \* ARABIC \s 1', "1")
        _set_run_font(p.add_run("  " + caption), size=10.5)
    t = doc.add_table(rows=1, cols=len(headers))
    t.alignment = WD_TABLE_ALIGNMENT.CENTER
    t.autofit = False
    TEXT_CM = 15.8
    if not widths:
        widths = [TEXT_CM / len(headers)] * len(headers)
    else:
        k = TEXT_CM / sum(widths)
        widths = [w * k for w in widths]
    hdr = t.rows[0].cells
    for i, h in enumerate(headers):
        hdr[i].text = ""
        p = hdr[i].paragraphs[0]
        p.paragraph_format.line_spacing = 1.0
        r = p.add_run(h)
        _set_run_font(r, size=10.5, bold=True)
        _header_bottom(hdr[i])
    for row in rows:
        cells = t.add_row().cells
        for i, v in enumerate(row):
            cells[i].text = ""
            p = cells[i].paragraphs[0]
            p.paragraph_format.line_spacing = 1.0
            r = p.add_run(str(v))
            _set_run_font(r, size=10.5)
    for i, w in enumerate(widths):
        for row in t.rows:
            row.cells[i].width = Cm(w)
    # 表头跨页重复、数据行不跨页
    trPr = t.rows[0]._tr.get_or_add_trPr()
    th = OxmlElement("w:tblHeader")
    th.set(qn("w:val"), "true")
    trPr.append(th)
    for row in t.rows:
        rp = row._tr.get_or_add_trPr()
        cs = OxmlElement("w:cantSplit")
        rp.append(cs)
    _tbl_borders(t)
    layout = OxmlElement("w:tblLayout")
    layout.set(qn("w:type"), "fixed")
    t._tbl.tblPr.insert_element_before(layout, "w:tblCellMar", "w:tblLook")
    doc.add_paragraph()
    return t


_fig_chapter = None
_fig_seq = 0
_tab_chapter = None
_tab_seq = 0


def FIGURE(path, caption, chapter="1", width_cm=15.2):
    global _fig_chapter, _fig_seq
    if chapter != _fig_chapter:
        _fig_chapter = chapter
        _fig_seq = 0
    _fig_seq += 1
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.space_before = Pt(6)
    p.add_run().add_picture(path, width=Cm(width_cm))
    c = doc.add_paragraph(style="Caption")
    _set_run_font(c.add_run("图 %s-" % chapter), size=10.5)
    _field(c, 'SEQ 图 \* ARABIC' + (' \\r 1' if _fig_seq == 1 else ''), str(_fig_seq))
    _set_run_font(c.add_run("  " + caption), size=10.5)


def TABLE(headers, rows, widths=None, caption=None, chapter="1"):
    global _tab_chapter, _tab_seq
    if caption:
        if chapter != _tab_chapter:
            _tab_chapter = chapter
            _tab_seq = 0
        _tab_seq += 1
        p = doc.add_paragraph(style="Caption")
        _set_run_font(p.add_run("表 %s-" % chapter), size=10.5)
        _field(p, 'SEQ 表 \* ARABIC' + (' \\r 1' if _tab_seq == 1 else ''), str(_tab_seq))
        _set_run_font(p.add_run("  " + caption), size=10.5)
    t = doc.add_table(rows=1, cols=len(headers))
    t.alignment = WD_TABLE_ALIGNMENT.CENTER
    t.autofit = False
    TEXT_CM = 15.8
    if not widths:
        widths = [TEXT_CM / len(headers)] * len(headers)
    else:
        k = TEXT_CM / sum(widths)
        widths = [w * k for w in widths]
    hdr = t.rows[0].cells
    for i, h in enumerate(headers):
        hdr[i].text = ""
        p = hdr[i].paragraphs[0]
        p.paragraph_format.line_spacing = 1.0
        r = p.add_run(h)
        _set_run_font(r, size=10.5, bold=True)
        _header_bottom(hdr[i])
    for row in rows:
        cells = t.add_row().cells
        for i, v in enumerate(row):
            cells[i].text = ""
            p = cells[i].paragraphs[0]
            p.paragraph_format.line_spacing = 1.0
            r = p.add_run(str(v))
            _set_run_font(r, size=10.5)
    for i, w in enumerate(widths):
        for row in t.rows:
            row.cells[i].width = Cm(w)
    trPr = t.rows[0]._tr.get_or_add_trPr()
    th = OxmlElement("w:tblHeader")
    th.set(qn("w:val"), "true")
    trPr.append(th)
    for row in t.rows:
        rp = row._tr.get_or_add_trPr()
        cs = OxmlElement("w:cantSplit")
        rp.append(cs)
    _tbl_borders(t)
    layout = OxmlElement("w:tblLayout")
    layout.set(qn("w:type"), "fixed")
    t._tbl.tblPr.insert_element_before(layout, "w:tblCellMar", "w:tblLook")
    doc.add_paragraph()
    return t


def _field(paragraph, instr, hint=""):
    r = paragraph.add_run()
    a = OxmlElement("w:fldChar"); a.set(qn("w:fldCharType"), "begin")
    b = OxmlElement("w:instrText"); b.set(qn("xml:space"), "preserve"); b.text = instr
    c = OxmlElement("w:fldChar"); c.set(qn("w:fldCharType"), "separate")
    d = OxmlElement("w:t"); d.text = hint
    e = OxmlElement("w:fldChar"); e.set(qn("w:fldCharType"), "end")
    for x in (a, b, c, d, e):
        r._r.append(x)


def add_toc():
    H("目录", 1)
    p = doc.add_paragraph()
    _field(p, 'TOC \\o "1-3" \\h \\z \\u', "（更新域后显示）")
    H("图目录", 1)
    p = doc.add_paragraph()
    _field(p, 'TOC \h \z \c "图"', "（更新域后显示）")
    H("表目录", 1)
    p = doc.add_paragraph()
    _field(p, 'TOC \h \z \c "表"', "（更新域后显示）")
    doc.add_page_break()


def add_page_numbers():
    footer = doc.sections[0].footer
    p = footer.paragraphs[0]
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    r = p.add_run("第 ")
    _set_run_font(r, size=9)
    _field(p, "PAGE", "1")
    r = p.add_run(" 页")
    _set_run_font(r, size=9)


# ============================ 正文 ============================
cover = doc.add_paragraph()
cover.alignment = WD_ALIGN_PARAGRAPH.CENTER
cover.paragraph_format.space_before = Pt(150)
r1 = cover.add_run("OpenHarmony 驱动的")
r1.add_break()
r2 = cover.add_run("独居老人居家传感监测")
r2.add_break()
r3 = cover.add_run("与多端告警联动系统")
for _r in (r1, r2, r3):
    _set_run_font(_r, name="黑体", size=24, bold=True)

sub = doc.add_paragraph()
sub.alignment = WD_ALIGN_PARAGRAPH.CENTER
r = sub.add_run("赛题四 · 独居老人居家安全监测与应急辅助系统")
_set_run_font(r, name="黑体", size=16, bold=True)

line = doc.add_paragraph()
line.alignment = WD_ALIGN_PARAGRAPH.CENTER
line.paragraph_format.space_before = Pt(36)
r = line.add_run("设 计 方 案")
_set_run_font(r, name="黑体", size=22, bold=True)

doc.add_page_break()
doc.add_heading("摘要", level=1)
P("针对独居老人居家安全监测存在告警确认不可靠、断网失效与多房间部署成本高等问题，本文设计并实现一套基于 OpenHarmony 的居家安全监测与应急辅助系统。系统采用“房间节点—边缘主控—本地网关—云端—应用”五层架构，以本地判定与设备回执告警闭环为核心，实现断网条件下本地告警可用；视觉跌倒检测采用方向不敏感判据，降低漏检概率；节点采用统一协议，支持配置化扩展。硬件实测表明，系统可完成本地声光告警、SOS 求助、跌倒检测与语音问答等功能；本文同时明确工程边界并给出后续迭代方向。")
P("**关键词**：独居老人监护；OpenHarmony；告警闭环；跌倒检测；边缘计算")
doc.add_page_break()
add_toc()

# 1 ------------------------------------------------------------------
H("一、绪论", 1)
P("独居老人居家风险的共同点是：**发生突然、发现滞后、处置依赖他人**。跌倒、长时间无活动、"
  "燃气或烟雾泄漏，往往在数分钟到数小时内决定后果；子女通常无法实时在场。")

H("1.1 研究背景与问题", 2)
BULLET("**跌倒或突发疾病**：老人倒地后可能无法呼救，黄金处置时间很短。")
BULLET("**长时间无活动**：没有明显报警，但活动量持续下降，家属无法判断是否安全。")
BULLET("**环境风险**：燃气、烟雾、温湿度异常，往往先于人体异常被忽视。")

H("1.2 核心设计原则", 2)
P("现有独居老人监护方案通常存在三方面不足：一是告警确认依赖 APP 点击，缺少设备侧的真实回执；二是高度依赖云端网络，断网后告警能力受限；三是新增传感节点往往需要修改程序，房间扩展成本较高。针对上述问题，本文提出三条核心设计原则。")
P("**判断一：告警必须是“设备确认的闭环”，不是“通知已读”。** 家属点一下“确认”不等于现场已处置，"
  "只有设备回执 ACKED 才算真正闭环。")
P("**判断二：安全链路必须本地优先，断网仍可用。** 告警不能等公网往返，本地声光、按键求助与状态机"
  "要在断网时继续工作。")
P("**判断三：扩展必须配置化，新增房间不改代码。** 节点统一协议，房间、设备 ID、引脚通过配置区分，"
  "避免每加一个房间就改一次系统。")

H("1.3 作品价值", 2)
BULLET("**对老人**：一个按键就能求助，语音提示与本地声光不依赖手机；操作不超过一个动作。")
BULLET("**对家属**：手机端远程看状态、看告警、填写处置结果，处置过程有日志可查。")
BULLET("**对部署者**：双节点同构、一键自检、网关与映射可自愈，演示与日常运行不靠人盯。")
P("综上，作品的设计目标可概括为：**使每一次异常都被及时感知并获得确认。**")

# 2 ------------------------------------------------------------------
H("二、系统总体方案", 1)
H("2.1 五层架构", 2)
P("系统分为五层：**房间节点（采集与执行）→ 边缘主控（本地判定与人机交互）→ 本地网关（协议桥接、"
  "视觉、语音与视频）→ 云端（账号、告警、事件）→ 应用层（监护 APP 与板载 APP）**。任一层故障只降级"
  "对应能力，不影响其他层。")
FIGURE(FIG_ARCH, "总体架构（端—边—本地网关—云—应用）", chapter="2")
P("两个应用端定位不同：**监护 APP（手机端）**负责远程查看、告警与 ACK；**板载 APP（DAYU200 室内）**"
  "负责现场实时状态、摄像头、预警处置与 AI 问答。两端共享同一份告警状态，但界面与权限不同，不能互相替代。")

H("2.2 告警闭环流程", 2)
BULLET("**采集**：房间节点采集活动、门窗、温湿度与随身求助按钮，统一 JSON 行协议上传。")
BULLET("**判定**：边缘主控与本地网关做阈值、持续时间和时序状态机判断，只提交受限事件。")
BULLET("**现场告警**：异常触发蜂鸣器与 LED；SOS 按键同时播放本地求助语音。")
BULLET("**远程确认**：告警同步到监护 APP 与板载 APP；家属确认后进入“等待设备回执”。")
BULLET("**归档统计**：设备回执 ACKED 才结清；处置结果进入安全日志，活动数据进入统计报告。")
FIGURE(FIG_UP, "状态上行与多端同步", chapter="2")

H("2.3 赛题功能对照", 2)
P("赛题四明确列出五项强制功能。下表逐项对照本作品的实现与边界；**现场未生效的传感项按实际标注，"
  "不计入通过项**，避免把“链路通过”写成“功能验收”。")
TABLE(["序号", "赛题强制功能", "本作品实现", "状态与证据"], [
    ["1", "南向数据采集与控制", "节点采集活动、门窗、温湿度与 SOS，JSON 行上传；厨房/卫生间双节点", "链路已调通；部分传感器接线依赖现场部署条件，实测结果见 6.2"],
    ["2", "本地声光预警与自助求助", "蜂鸣器 + LED；KEY0 一键 SOS；本地语音 11.75 秒；断网可用", "已实现（真机）"],
    ["3", "北向数据展示", "监护 APP + 板载 APP：实时状态、在线状态、历史预警、统计入口", "已实现（界面/接口）"],
    ["4", "事件闭环管理", "三态 + 设备回执 ACKED + 8 秒超时 + 处置日志", "已实现（真机/接口）"],
    ["5", "数据统计分析", "统计报告页：活动时段、趋势与周/月入口", "页面/接口已具备；数据以实报为准"],
], widths=[1.3, 3.2, 7.4, 4.1], caption="赛题五项强制功能对照", chapter="2")

# 3 ------------------------------------------------------------------
H("三、关键设计与创新", 1)
P("本章围绕四项关键设计展开，均按“设计动机—实现方法—验证结果”组织，避免仅罗列功能。")

H("3.1 设备级 ACK 闭环设计", 2)
P("**设计动机**：家属点“确认”只代表看到了通知，不代表现场已处置；系统必须拿到设备的真实回执，"
  "才能把告警结清。")
P("**实现方法**：告警状态机采用三态——未确认 → 等待设备回执 → 已闭环。设备回执中的 alarmId 必须精确匹配，"
  "**8 秒内未回执则进入超时保护**；云端返回受理应答只表示请求已接收，**受理不等于闭环**，必须等待设备回执 ACKED。")
P("**验证结果**：真机上完成“APP 确认 → 设备回执 → 告警 ACKED”闭环；错误或重复 alarmId 被拒绝，"
  "历史 pending 告警不会假结清。")
FIGURE(FIG_ACK, "设备级 ACK 闭环时序", chapter="3")

H("3.2 方向不敏感跌倒判据", 2)
P("**设计动机**：老人跌倒不一定把身体“转到水平”。竖向屈膝下坠、朝摄像头前倒同样危险，"
  "如果判据只认水平姿态，就会漏检。")
P("**实现方法**：保留 180° 侧倒判据不变，新增方向不敏感的“快速塌落”路径：**相对最近站立基线下沉 ≥0.22、"
  "窗口内峰值下坠 ≥0.30/秒、末端证据成立、进入帧触底瞬时速度 ≥0.22/秒**。末端证据包括髋到地面层、"
  "肩部低位、肩低于髋，或人体框高度塌缩到基线的 55% 以下。")
P("**验证结果**：离线 3 套机位矩阵 **7/7** 通过；受控实机 **4 次不同方向跌倒全部检出**；交替测试"
  "**跌倒 3/3、快速深蹲 0/3 误报**。本文跌倒检测阈值基于受控模拟跌倒动作确定，尚未经过真实老人跌倒场景的大规模标定。")
FIGURE(FIG_FALL, "视觉跌倒链路与时序状态机", chapter="3")

H("3.3 配置化多节点与网关自愈", 2)
P("**设计动机**：家庭场景会不断增加房间与传感器；如果每加一个房间就改代码，系统无法复制。")
P("**实现方法**：节点不实现 MQTT，统一使用换行分隔的 JSON 行协议；房间、设备 ID、引脚由配置区分。"
  "网关侧做**同状态限频去重、12 秒无状态判离线**；守护脚本每 15 秒巡检，USB 调试映射丢失自动重建，"
  "网关按端口识别进程，避免“假重启”。")
P("**验证结果**：双节点、双目标定向播报 **10/10**；30 轮稳定性浸泡 **210/210** 通过；"
  "一键体检 **OK=11 / WARN=0 / FAIL=0**。")

H("3.4 受限视觉事件与双端协同", 2)
P("**设计动机**：把“疑似”直接写成“确认”会制造假告警，也会让家属失去信任；同时，手机端与现场端的"
  "使用场景完全不同。")
P("**实现方法**：视觉侧只提交受限的 fall 事件，不把未经验证的判断写入告警；**监护 APP 负责远程查看与确认，"
  "板载 APP 负责现场状态、摄像头与语音交互**，两端共享同一份告警状态但权限不同。")
P("**验证结果**：告警可解释、可回溯；现场与远程各司其职，老人不需要学习手机操作。")

H("3.5 创新点总结", 2)
BULLET("**设备级闭环**：解决“家属 APP 点确认、现场风险并未解除”的监护痛点；用设备回执替代“通知已读”，以少量实现复杂度换取真实处置。")
BULLET("**方向不敏感跌倒判据**：解决单一水平姿态判据容易漏检前向、竖向跌倒的问题；用“塌落过程 + 末端证据”替代“身体必须水平”。")
BULLET("**受限视觉事件**：解决“误报多、无法解释”的问题；只提交 fall 事件，不把未验证判断写进告警，换可解释与低误报。")
BULLET("**配置化多节点 + 自愈运维**：解决“每加一个房间就改一次代码”的扩展痛点；用协议同构与巡检自愈，换可复制部署。")

# 4 ------------------------------------------------------------------
H("四、系统实现", 1)
H("4.1 硬件组成", 2)
P("房间侧使用两块 ESP32-S3 节点（厨房、卫生间），复用板载音频编解码器、I/O 扩展器与按键；"
  "边缘主控使用 DAYU200（OpenHarmony），承担摄像头、显示、本地判定与人机交互。原型演示阶段，"
  "视觉处理、协议桥接与语音网关服务部署于 PC；产品化阶段可将上述网关服务裁剪并迁移至 DAYU200 等"
  "OpenHarmony 设备，去除 PC 依赖。云端负责账号、告警、事件与证据索引。节点与主控之间通过家庭 Wi-Fi 通信。")

H("4.2 端侧固件与状态机", 2)
P("固件采用统一入口：上电自检 → 本地台架自检 → 网络启动 → 主循环。主循环以约 100 毫秒周期处理"
  "传感器采样、按键、串口命令与音频；本地状态机在设备侧完成 NORMAL → WARN → ALARM 的迁移，"
  "并把状态与告警以 JSON 行上报。SOS、健康语音、自述安全共用同一条采音链路，用不同的 reason 区分语义，"
  "保证每种操作都有独立日志。")

H("4.3 本地网关与云端", 2)
P("本地网关把设备行协议转换成 MQTT，并承担视觉、语音、视频与桥接；云端由公网后端与同步进程组成，"
  "负责账号、告警、ACK 队列、事件与证据索引。**云端断开时，本地声光与状态机仍工作**，"
  "只损失远程查看与跨端同步。端口与协议参数见附录 A。")

H("4.4 应用端", 2)
P("**监护 APP（手机端）**提供登录、实时状态、告警列表与详情、ACK 处置、自述安全卡片、统计入口；"
  "**板载 APP（DAYU200）**提供实时状态、摄像头预览、预警处置、统计报告与 AI 问答。"
  "板载端只读展示、不提供任意文本输入，降低老人误操作概率。两端界面示例如图 4-1 所示。")
FIGURE(FIG_APPS, "板载 APP 与监护 APP 界面示例（左：板载端预警处置；右：监护端首页）", chapter="4")

H("4.5 语音与视觉", 2)
P("语音侧：KEY0 触发 SOS，KEY1 触发健康语音；老人说“我没事”只记录自述安全事件，"
  "**不自动 ACK 原告警**；普通问答经本地网关调用大模型，回答以文字展示、语音由目标房间节点播放。"
  "视觉侧：DAYU 送帧到 PC 视觉服务，YOLO pose 提取关键点，时序状态机判断后只提交受限 fall 事件，"
  "证据默认保存在本地，需授权读取。")

# 5 ------------------------------------------------------------------
H("五、测试与验证", 1)
H("5.1 测试方法与口径", 2)
P("测试分四类：**离线矩阵**（多机位回放模拟场景）、**受控实机**（人员按脚本完成模拟跌倒等真人动作）、"
  "**宿主测试**（纯逻辑与协议，不依赖板卡）、**稳定性浸泡**（长时间循环运行，验证连续工作可靠性）。"
  "所有“通过”结论都对应原始日志或串口输出；未接线、未标定或未做长时验证的内容逐项标注，"
  "不用“理论上支持”替代实测。")

doc.add_page_break()
H("5.2 关键结果摘要", 2)
TABLE(["测试项", "结果", "说明"], [
    ["跌倒方向离线矩阵", "7/7", "3 套机位 × 9 类场景；含竖向、前向、180° 与安全动作"],
    ["跌倒受控实机", "4/4", "4 次不同方向跌倒全部检出"],
    ["跌倒 vs 快速深蹲", "3/3；0/3", "交替测试：跌倒全部检出，快速深蹲 0 误报"],
    ["稳定性浸泡", "210/210", "30 轮检查全部通过"],
    ["一键体检", "11/11", "core-start OK=11 / WARN=0 / FAIL=0"],
    ["语音问答时延", "663–1321 ms", "不含播放时间"],
    ["双目标定向播报", "10/10", "厨房/卫生间双节点路由"],
    ["设备离线判定", "12 秒", "无状态上报即判离线"],
], widths=[4.2, 3.2, 8.0], caption="关键测试结果摘要", chapter="5")

H("5.3 验证结论", 2)
P("**安全链路的关键指标已可复现**：跌倒方向鲁棒性、ACK 闭环、稳定性与语音时延都有原始记录。"
  "本系统跌倒检测结果均来自模拟受控测试，尚未经过真实老人跌倒场景的大规模标定，相关边界见第六章局限性。")

# 6 ------------------------------------------------------------------
H("六、安全性与隐私保护", 1)
H("6.1 安全与隐私", 2)
P("系统以活动与环境传感为主，**不采集室内影音内容**；照片与视觉证据默认保存在本地，需监护人授权才能读取；"
  "云端只保存必要的告警与事件元数据。密钥方面：大模型 Key 只从环境变量或受限文件读取，"
  "云端摄入密钥以隐藏方式输入，不写入源码、命令行或日志。")
P("当前原型运行于受管控的家庭局域网，设备间 TCP 行协议与 MQTT 通信暂未启用 TLS 加密与设备身份鉴权，"
  "MQTT 采用 QoS0，仅适用于内部演示场景。产品化部署需要增加 TLS 传输加密与设备密钥鉴权机制，提升通信安全。")

H("6.2 局限性", 2)
BULLET("**P0**：局域网设备链路无鉴权/TLS，MQTT 为 QoS0，仅适用于受控演示网络。")
BULLET("**P0**：原型调试依赖 USB HDC 通道，插拔会造成映射丢失；系统通过守护脚本自动恢复；正式产品可改用板载原生通信方案规避。")
BULLET("**P1**：卫生间部分门磁传感硬件已接入系统框架，原型阶段尚未完成现场接线调试，该部分能力待后续完成实测验收。")
BULLET("**P1**：跌倒方向鲁棒性已补（竖向/前向/180° 受控通过），但**真实跌倒阈值未标定**，"
       "仍为 PC CPU 基线（短时约 2 FPS）。")
BULLET("**P2**：板载 APP（HAP）已用 Release 证书签名安装；监护 APP（手机端）尚未正式签名与真机安装，"
       "系统级推送与多租户权限未做。")

H("6.3 后续工作", 2)
P("按“先安全、再体验”的顺序推进：先补真实跌倒录像标定与近景构图支持，再完成门磁与卫生间传感器接线验收，"
  "最后处理监护 APP 正式签名与长时浸泡。每完成一项都以可复现的回归数据收口，并在验证矩阵中更新状态，"
  "**避免“改了就默认更好”**。")

# 7 ------------------------------------------------------------------
H("七、部署方案与成本分析", 1)
P("部署侧已经做成“一键启动 + 一键体检”：脚本按顺序完成环境检查、重复进程清理、DAYU 映射恢复、"
  "板载 APP 启动、端口检查与健康汇总；日常运行只需要保持一个守护窗口。单户成本主要是两块 ESP32-S3 节点、"
  "一块 DAYU200 与一台常开 PC；原型阶段由 PC 承担网关服务，产品化后可将网关能力迁移至 OpenHarmony 主控，"
  "降低对常开 PC 的依赖，成本与部署复杂度相应下降。传感器可按需增加；社区化推广需要把本地网关能力上收为"
  "集中服务，并补齐多租户与权限模型，这部分当前未实现，只作为方向。")

# 8 ------------------------------------------------------------------
H("八、结论", 1)
P("本作品的核心并非增加一个独立报警器，而是围绕三方面展开："
  "**本地优先的现场能力、设备确认的告警闭环、配置化的多节点扩展**。"
  "它已经在真实硬件上跑通告警、ACK、语音与视觉链路，也保留了一份诚实的边界清单。")
P("**设计目标可概括为：使每一次异常都被及时感知并获得确认。**")

# 9 ------------------------------------------------------------------
H("九、附录", 1)
H("附录 A  端口与协议参数", 2)
BULLET("端口分配：MQTT 1883；节点 TCP 接入 9101；音箱 PCM 9102；视觉 HTTP 9200；语音会话 9302；音频上传 9303；视频中继 9443；DAYU homemon 9000/9001；云端 80/443。")
BULLET("MQTT：QoS0；主题按 home/<device>/... 组织；状态 12 秒无上报判离线。")
BULLET("设备行协议：换行分隔 JSON；文本命令 + 状态回执；ACK 回执 alarmId 精确匹配。")
BULLET("HTTP：云端受理返回 202，仅表示请求已接收，不代表告警闭环。")
BULLET("**协议三条硬约束**：设备不实现 MQTT，统一 JSON 行协议；视觉只提交受限事件；ACK 必须由设备回执且 alarmId 精确匹配。")
BULLET("**证据说明**：本文档的“通过”结论均可在仓库验证矩阵与证据目录中追溯；未实测项已逐条标注。")
BULLET("**AI 工具使用说明**：仅用于文档润色、代码审查与测试脚本辅助；核心设计、参数选择与结论由团队完成并实测复核。")


add_page_numbers()
# 打开时自动更新目录域
settings = doc.settings.element
uf = OxmlElement("w:updateFields")
uf.set(qn("w:val"), "true")
settings.append(uf)

cp = doc.core_properties
cp.author = "参赛作品"
cp.last_modified_by = "参赛作品"
cp.title = "OpenHarmony 驱动的独居老人居家传感监测与多端告警联动系统 设计方案"
cp.subject = "赛题四 设计方案"
cp.comments = ""

doc.save(OUT)
print("saved:", OUT)
