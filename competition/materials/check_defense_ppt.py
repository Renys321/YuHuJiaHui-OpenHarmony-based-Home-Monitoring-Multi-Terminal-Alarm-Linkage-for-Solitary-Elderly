# -*- coding: utf-8 -*-
"""答辩 PPT 自检：页数/字数/字号/备注时长/盲审敏感词/文本溢出估算。"""
import math
import os
import re
from pptx import Presentation
from pptx.util import Emu

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PATH = os.path.join(BASE, "docs", "submission", "答辩PPT.pptx")
prs = Presentation(PATH)
EMU_IN = 914400

bad_words = ["学校", "学院", "大学", "指导教师", "教师", "老师", "队员", "队名", "队长",
             "D:\\", "C:\\", "sk-", "INGEST_KEY", "TODO", "xxx"]

all_text = []
notes_total = 0
rows = []
issues = []

for idx, slide in enumerate(prs.slides, start=1):
    texts, small, total_boxes = [], [], 0
    for sh in slide.shapes:
        if not sh.has_text_frame:
            continue
        total_boxes += 1
        box_w = sh.width / EMU_IN
        box_h = sh.height / EMU_IN
        need_h = 0.0
        for p in sh.text_frame.paragraphs:
            t = "".join(r.text for r in p.runs)
            if not t:
                continue
            texts.append(t)
            all_text.append(t)
            size = max([(r.font.size.pt if r.font.size else 18) for r in p.runs] or [18])
            for r in p.runs:
                s = r.font.size.pt if r.font.size else 18
                if s < 20:
                    small.append((t[:14], s))
            # 估算：中文字宽≈字号，行数=ceil(文本宽/框宽)，行高=字号*1.35
            per_line = max(1, int(box_w * 72 / size))
            lines = max(1, math.ceil(len(t) / per_line))
            need_h += lines * size * 1.35 / 72 + 0.06
        if need_h > box_h + 0.05:
            issues.append("slide %d 文本可能溢出: 需 %.2fin > 框 %.2fin :: %s" %
                          (idx, need_h, box_h, " / ".join(texts)[:60]))
    note = slide.notes_slide.notes_text_frame.text if slide.has_notes_slide else ""
    notes_total += len(note)
    rows.append((idx, len("".join(texts)), len(note), len(small)))

body_text = "\n".join(all_text)
hits = [w for w in bad_words if w in body_text]
han = len(re.findall(r"[\u4e00-\u9fff]", body_text))
images = sum(1 for s in prs.slides for sh in s.shapes if sh.shape_type == 13)
dur = notes_total / 4.2
print("file:", PATH, "| size:", os.path.getsize(PATH), "bytes")
print("slides:", len(prs.slides), "| images:", images, "| 中文字符:", han)
print("notes 总字数:", notes_total, "| 估算时长: %.0f 秒 (%.1f 分钟, 按 4.2 字/秒)" % (dur, dur / 60))
print("盲审敏感词:", hits if hits else "none")
print("核心属性 author:", repr(prs.core_properties.author))
print()
print("页 | 正文字数 | 备注字数 | <20pt 文本数")
for r in rows:
    print("%2d | %8d | %8d | %d" % r)
if issues:
    print("\n可能的排版问题:")
    for i in issues:
        print(" -", i)
else:
    print("\n未发现明显文本溢出")
small_all = []
for idx, slide in enumerate(prs.slides, start=1):
    for sh in slide.shapes:
        if not sh.has_text_frame:
            continue
        for p in sh.text_frame.paragraphs:
            for r in p.runs:
                s = r.font.size.pt if r.font.size else 18
                if s < 20 and r.text.strip() and "赛题四" not in r.text and not r.text.strip().isdigit():
                    small_all.append((idx, s, r.text[:20]))
print("\n小于 20pt 的正文（不含页脚/页码）:", small_all[:10] if small_all else "none")
print("时长是否 ≤7 分钟:", dur <= 420)
