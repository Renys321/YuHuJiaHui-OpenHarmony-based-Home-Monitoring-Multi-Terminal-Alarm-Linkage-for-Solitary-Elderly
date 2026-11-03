# -*- coding: utf-8 -*-
"""生成后自检：结构、字数、图表、目录域、页码、盲审敏感词。"""
import os, re, sys
from docx import Document

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PATH = os.path.join(BASE, "docs", "submission", "设计方案.docx")
d = Document(PATH)

def all_text():
    out = []
    for p in d.paragraphs:
        out.append(p.text)
    for t in d.tables:
        for row in t.rows:
            for c in row.cells:
                out.append(c.text)
    for s in d.sections:
        for p in s.footer.paragraphs:
            out.append(p.text)
    return "\n".join(out)

txt = all_text()
han = len(re.findall(r"[\u4e00-\u9fff]", txt))
heads = [(p.style.name, p.text) for p in d.paragraphs if p.style.name.startswith("Heading")]
imgs = len(d.inline_shapes)
tables = len(d.tables)
toc = any("TOC" in p._p.xml for p in d.paragraphs)
update_fields = "updateFields" in d.settings.element.xml
page_field = any("PAGE" in p._p.xml for s in d.sections for p in s.footer.paragraphs)

bad = ["学校", "学院", "大学", "指导", "教师", "老师", "队员", "队名", "队长",
       "D:\\", "C:\\", "/home/", "sk-", "INGEST_KEY", "DEEPSEEK", "api key", "TODO", "xxx", "XXX"]
hits = [b for b in bad if b in txt]
# 允许出现 api.luxunacc.xyz 之外的域名？这里检查绝对路径与密钥痕迹

print("file:", PATH)
print("size:", os.path.getsize(PATH), "bytes")
print("paragraphs:", len(d.paragraphs), "tables:", tables, "images:", imgs)
print("headings:", len(heads), "| h1:", sum(1 for s, _ in heads if s == "Heading 1"))
print("chinese chars:", han)
print("TOC field:", toc, "| updateFields:", update_fields, "| footer PAGE:", page_field)
print("core.author:", repr(d.core_properties.author), "| last_modified_by:", repr(d.core_properties.last_modified_by))
print("forbidden hits:", hits if hits else "none")
print("H1 list:")
for s, t in heads:
    if s == "Heading 1":
        print("  -", t)
sys.exit(1 if hits else 0)
