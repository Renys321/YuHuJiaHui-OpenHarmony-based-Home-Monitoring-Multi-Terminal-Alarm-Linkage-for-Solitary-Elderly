# 生成赛题四《独居老人居家安全监测与应急辅助系统》讲解 PPT
# 目标：讲解 ≤10 分钟 → 12 页；16:9；材料中不含队名/校名/指导老师
import os
from pptx import Presentation
from pptx.util import Inches, Pt
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from pptx.enum.shapes import MSO_SHAPE

BASE = os.path.dirname(os.path.abspath(__file__))
NB = os.path.join(os.path.dirname(BASE), "northbound")
OUT = os.path.join(BASE, "讲解PPT.pptx")

NAVY = RGBColor(0x1F, 0x3B, 0x73)
BLUE = RGBColor(0x2E, 0x6D, 0xB4)
GREY = RGBColor(0x44, 0x44, 0x44)
LIGHT = RGBColor(0xF2, 0xF5, 0xFA)
WHITE = RGBColor(0xFF, 0xFF, 0xFF)
RED = RGBColor(0xC0, 0x39, 0x2B)
GREEN = RGBColor(0x27, 0x8A, 0x4A)

prs = Presentation()
prs.slide_width = Inches(13.333)
prs.slide_height = Inches(7.5)
BLANK = prs.slide_layouts[6]


def tb(slide, x, y, w, h, text, size=16, bold=False, color=GREY,
       align=PP_ALIGN.LEFT, font="微软雅黑", anchor=MSO_ANCHOR.TOP, line=1.25):
    box = slide.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h))
    tf = box.text_frame
    tf.word_wrap = True
    tf.vertical_anchor = anchor
    lines = text.split("\n")
    for i, ln in enumerate(lines):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.text = ln
        p.alignment = align
        p.line_spacing = line
        for r in p.runs:
            r.font.size = Pt(size)
            r.font.bold = bold
            r.font.color.rgb = color
            r.font.name = font
    return box


def head(slide, title, idx=None):
    bar = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, 0, 0, prs.slide_width, Inches(1.0))
    bar.fill.solid(); bar.fill.fore_color.rgb = NAVY; bar.line.fill.background()
    bar.shadow.inherit = False
    tf = bar.text_frame; tf.word_wrap = True
    tf.margin_left = Inches(0.5); tf.vertical_anchor = MSO_ANCHOR.MIDDLE
    p = tf.paragraphs[0]; p.text = title
    r = p.runs[0]; r.font.size = Pt(28); r.font.bold = True; r.font.color.rgb = WHITE; r.font.name = "微软雅黑"
    if idx:
        tb(slide, 12.3, 6.9, 0.9, 0.4, str(idx), size=12, color=RGBColor(0x99, 0x99, 0x99),
           align=PP_ALIGN.RIGHT)


def bullets(slide, x, y, w, h, items, size=15, gap=6):
    box = slide.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h))
    tf = box.text_frame; tf.word_wrap = True
    for i, (txt, lvl) in enumerate(items):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.text = ("• " if lvl == 0 else "    – ") + txt
        p.line_spacing = 1.3
        p.space_after = Pt(gap)
        for r in p.runs:
            r.font.size = Pt(size if lvl == 0 else size - 2)
            r.font.color.rgb = GREY if lvl == 0 else RGBColor(0x66, 0x66, 0x66)
            r.font.name = "微软雅黑"
    return box


def table(slide, x, y, w, h, headers, rows, fs=12):
    shape = slide.shapes.add_table(len(rows) + 1, len(headers), Inches(x), Inches(y),
                                   Inches(w), Inches(h))
    t = shape.table
    for j, htxt in enumerate(headers):
        c = t.cell(0, j); c.text = htxt
        c.fill.solid(); c.fill.fore_color.rgb = NAVY
        for p in c.text_frame.paragraphs:
            for r in p.runs:
                r.font.size = Pt(fs); r.font.bold = True; r.font.color.rgb = WHITE; r.font.name = "微软雅黑"
    for i, row in enumerate(rows, 1):
        for j, v in enumerate(row):
            c = t.cell(i, j); c.text = str(v)
            if i % 2 == 0:
                c.fill.solid(); c.fill.fore_color.rgb = LIGHT
            for p in c.text_frame.paragraphs:
                for r in p.runs:
                    r.font.size = Pt(fs); r.font.color.rgb = GREY; r.font.name = "微软雅黑"
    return t


def card(slide, x, y, w, h, title, body, color=BLUE, tsize=15, bsize=12):
    sh = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(x), Inches(y), Inches(w), Inches(h))
    sh.fill.solid(); sh.fill.fore_color.rgb = LIGHT
    sh.line.color.rgb = color; sh.line.width = Pt(1.5); sh.shadow.inherit = False
    tf = sh.text_frame; tf.word_wrap = True
    tf.margin_left = Inches(0.15); tf.margin_right = Inches(0.15); tf.margin_top = Inches(0.1)
    p = tf.paragraphs[0]; p.text = title
    for r in p.runs:
        r.font.size = Pt(tsize); r.font.bold = True; r.font.color.rgb = color; r.font.name = "微软雅黑"
    p2 = tf.add_paragraph(); p2.text = body; p2.line_spacing = 1.2
    for r in p2.runs:
        r.font.size = Pt(bsize); r.font.color.rgb = GREY; r.font.name = "微软雅黑"
    return sh


# ---------------- 1 封面 ----------------
s = prs.slides.add_slide(BLANK)
bg = s.shapes.add_shape(MSO_SHAPE.RECTANGLE, 0, 0, prs.slide_width, prs.slide_height)
bg.fill.solid(); bg.fill.fore_color.rgb = NAVY; bg.line.fill.background(); bg.shadow.inherit = False
tb(s, 1.0, 1.9, 11.3, 1.6, "独居老人居家安全监测与应急辅助系统", size=40, bold=True,
   color=WHITE, align=PP_ALIGN.CENTER)
tb(s, 1.0, 3.5, 11.3, 0.6, "设计方案 · 作品讲解", size=20, color=RGBColor(0xBF, 0xD3, 0xEA),
   align=PP_ALIGN.CENTER)
line = s.shapes.add_shape(MSO_SHAPE.RECTANGLE, Inches(5.2), Inches(4.35), Inches(2.9), Pt(2))
line.fill.solid(); line.fill.fore_color.rgb = RGBColor(0x7F, 0xAF, 0xE0); line.line.fill.background()
tb(s, 1.0, 4.7, 11.3, 1.2,
   "基于 OpenHarmony 开发板 · 南向感知与本地应急 + 北向监护与云端协同",
   size=16, color=RGBColor(0xDD, 0xE7, 0xF5), align=PP_ALIGN.CENTER)

# ---------------- 2 场景与痛点 ----------------
s = prs.slides.add_slide(BLANK); head(s, "一、场景与痛点", 2)
tb(s, 0.8, 1.3, 11.8, 0.7, "独居老人一旦在家发生意外，\"无人知晓\"往往比意外本身更致命。",
   size=18, bold=True, color=NAVY)
card(s, 0.8, 2.2, 3.7, 2.1, "突发健康风险", "跌倒、突发疾病后无法起身求助，\n黄金救援时间被延误。", RED)
card(s, 4.8, 2.2, 3.7, 2.1, "居家环境风险", "燃气泄漏、火情等隐患在无人察觉时\n迅速扩大。", RED)
card(s, 8.8, 2.2, 3.7, 2.1, "家属信息缺口", "子女只能靠电话确认，无法掌握\n日常活动规律与异常变化。", RED)
tb(s, 0.8, 4.7, 11.8, 1.0,
   "本作品的目标：把\"无人知晓\"变成\"异常即被感知、被响应、被记录\"。",
   size=17, bold=True, color=GREEN)

# ---------------- 3 方案总览 ----------------
s = prs.slides.add_slide(BLANK); head(s, "二、方案总览：四层架构", 3)
table(s, 0.8, 1.35, 11.7, 3.4,
      ["层次", "组成", "职责"],
      [["应用层", "监护人 APP", "实时状态、活动规律报告、预警闭环、统计报表"],
       ["云端汇聚层", "物联网云平台（消息主题）", "状态发布、命令下发、多订阅者广播"],
       ["边缘判定层", "开发板 + 南向守护进程", "周期采集、阈值与时长判定、状态机、声光与语音"],
       ["感知层", "红外人体、门窗磁、温湿度、求助按钮、燃气/烟雾", "把物理状态转为电信号"]], fs=13)
tb(s, 0.8, 4.95, 11.8, 1.6,
   "设计原则：① 本地优先——断网时采集/判定/声光/语音仍完整可用；"
   "② 隐私友好——以人体活动与环境传感为主，不采集影音；③ 可扩展多节点——协议按多设备设计。",
   size=15, color=BLUE)

# ---------------- 4 硬件与接口 ----------------
s = prs.slides.add_slide(BLANK); head(s, "三、硬件选型与接口分配", 4)
table(s, 0.8, 1.3, 6.0, 4.6,
      ["功能", "器件 / 接口", "说明"],
      [["主控", "OpenHarmony 开发板（RK3568）", "板载三色灯/喇叭/加速度计"],
       ["人体活动", "红外人体 ×2", "GPIO 输入"],
       ["门窗状态", "门窗磁", "GPIO 输入"],
       ["主动求助", "无线求助按钮", "GPIO 输入"],
       ["声报警", "有源蜂鸣器", "GPIO 输出"],
       ["温湿度", "数字温湿度传感器", "I2C"],
       ["燃气/烟雾", "半导体气体传感器", "板载 ADC"]], fs=11)
card(s, 7.1, 1.3, 5.4, 2.1, "复用板载资源，压缩 BOM",
     "三色灯 = 光报警；板载喇叭 = 语音播报；\n加速度计可作活动量辅助判据。", GREEN, 14, 12)
card(s, 7.1, 3.6, 5.4, 2.3, "接口按实机原理图与占用表确定",
     "扩展口 20Pin：GPIO 与 I2C、ADC 均已实测可用；\n避开已被系统占用的引脚，接线一次成功。", BLUE, 14, 12)

# ---------------- 5 南向：采集与识别 ----------------
s = prs.slides.add_slide(BLANK); head(s, "四、南向：采集与异常识别", 5)
bullets(s, 0.8, 1.3, 5.6, 4.6, [
    ("周期采集：数字量（GPIO）、温湿度（I2C）、燃气烟雾（板载 ADC）", 0),
    ("阈值 + 持续时长 双判据，避免瞬时抖动误报", 0),
    ("燃气/烟雾优先级最高，其次主动求助，再次长时间无活动", 0),
    ("启动宽限期 + 连续多次一致消抖（真机踩坑后加入）", 0),
    ("状态机四态：正常 → 关注 → 告警 → 已确认", 0),
], size=14)
table(s, 6.7, 1.4, 5.8, 3.4,
      ["状态", "触发条件", "现场表现"],
      [["正常", "指标均在阈值内", "绿灯常亮"],
       ["关注", "接近阈值（如达 60%）", "黄灯慢闪"],
       ["告警", "越界或主动求助", "红灯闪烁 + 蜂鸣"],
       ["已确认", "监护人在 APP 确认", "蓝灯 + 写安全日志"]], fs=12)

# ---------------- 6 本地应急响应 ----------------
s = prs.slides.add_slide(BLANK); head(s, "五、本地应急响应：声 · 光 · 语音", 6)
card(s, 0.8, 1.5, 3.7, 2.4, "光报警", "板载三色灯分级指示：\n绿=正常 / 黄=关注 / 红=告警 / 蓝=已确认", BLUE)
card(s, 4.8, 1.5, 3.7, 2.4, "声报警", "蜂鸣器鸣响，\n即使老人不在手机旁也能被提醒", BLUE)
card(s, 8.8, 1.5, 3.7, 2.4, "语音自助求助", "按下随身求助按钮，\n现场播放预录语音\"我需要帮助\"", GREEN)
tb(s, 0.8, 4.3, 11.8, 2.0,
   "关键点：这三项都在开发板本地完成，不依赖外网、不依赖手机。\n"
   "老人按下按钮 → 现场声光 + 语音 → 同时上报云端 → 云端订阅端收到同一预警，形成\"自救 + 他救\"双通道。",
   size=15, color=GREY)

# ---------------- 7 北向 APP（三张截图） ----------------
s = prs.slides.add_slide(BLANK); head(s, "六、北向监护人 APP（真机运行截图）", 7)
for i, (fn, cap) in enumerate([("shot-status.jpg", "实时状态"),
                               ("shot-alarm.jpg", "预警处置闭环"),
                               ("shot-report.jpg", "活动规律报告")]):
    p = os.path.join(NB, fn)
    if os.path.exists(p):
        s.shapes.add_picture(p, Inches(0.9 + i * 4.15), Inches(1.4), height=Inches(4.5))
    tb(s, 0.9 + i * 4.15, 6.05, 3.6, 0.5, cap, size=15, bold=True, color=NAVY, align=PP_ALIGN.CENTER)
tb(s, 0.9, 6.6, 11.6, 0.6,
   "状态实时刷新；预警可填写处置结果并闭环；活动报告给出\"较昨日下降 X%\"的趋势判断。",
   size=13, color=GREY)

# ---------------- 8 云端与多终端 ----------------
s = prs.slides.add_slide(BLANK); head(s, "七、云端汇聚与多终端推送", 8)
card(s, 0.8, 1.5, 3.6, 2.6, "1  设备上报", "开发板按设备编号\n发布状态到云端主题", BLUE, 15, 12)
card(s, 4.8, 1.5, 3.6, 2.6, "2  云端广播", "云端按主题广播，\n订阅者数量不受限", BLUE, 15, 12)
card(s, 8.8, 1.5, 3.6, 2.6, "3  多方同时响应", "任意订阅端（手机 MQTT 客户端 /\n社区 / 物业）同时收到同一条预警", GREEN, 15, 12)
tb(s, 0.8, 4.5, 11.8, 1.8,
   "闭环回路：监护人确认并填写处置结果 → 命令下行至设备 → 设备记录居家安全日志（时间、告警标识、处置结果）。\n"
   "已用真机验证：云端下发确认后，设备日志即时生成对应记录。",
   size=14, color=GREY)

# ---------------- 9 关键实现与踩坑 ----------------
s = prs.slides.add_slide(BLANK); head(s, "八、关键实现：真机踩坑与对策", 9)
table(s, 0.8, 1.35, 11.7, 4.5,
      ["问题", "真实现象", "对策"],
      [["悬空输入误报", "未接传感器时开机即误报求助与门开", "启动宽限期 + 连续多次一致消抖"],
       ["音频格式不识别", "以文件描述符播放音频时解码失败", "先把音频释放到应用沙箱，再按带扩展名路径播放"],
       ["公网服务端口被拦", "公有消息服务端口在本网络不可达", "自建轻量消息服务，演示与现场环境自洽"],
       ["大文件传输中断", "经扩展坞传输大文件时链路闪断", "直连主机端口 + 分块校验 + 刷机前整机备份"],
       ["长时间无活动判据", "阈值太短会误报、太长会漏报", "阈值可配置，并设\"关注\"中间态提前提示"]], fs=12)

# ---------------- 10 测试结果 ----------------
s = prs.slides.add_slide(BLANK); head(s, "九、测试结果", 10)
table(s, 0.8, 1.3, 11.7, 4.6,
      ["验证项", "方法", "结果"],
      [["北向实时展示", "APP 查看设备状态", "通过（界面数值与设备报文逐项一致）"],
       ["活动规律报告", "统计页查看趋势", "通过（设备端累计日统计，逐项对账一致）"],
       ["事件闭环", "APP 确认并填写处置 → 设备日志", "通过（板上 APP→设备→日志；需设备回 ACKED 才算闭环）"],
       ["多终端推送", "两个订阅端同时在线", "通过（2 端实测；订阅端数量协议上不受限）"],
       ["多房间多节点", "两个房间节点分别触发", "通过（互不干扰；应用内可切换房间）"],
       ["闭环按节点路由", "对某房间告警确认处置", "通过（仅该房间设备写入安全日志）"],
       ["无线节点接入", "无线节点经局域网接入网关", "路径通过（上行入云、下行可达；固件待烧录）"],
       ["数据链路稳定性", "连续写入 2 GiB 数据后校验", "通过（校验值一致）"],
       ["传感器触发告警", "遮挡红外 / 气体触发", "传感器到货后复测"]], fs=10)

# ---------------- 11 创新点 ----------------
s = prs.slides.add_slide(BLANK); head(s, "十、创新点", 11)
card(s, 0.8, 1.5, 5.7, 2.2, "多维安全监测", "在赛题要求基础上增加燃气与烟雾监测，\n把安全覆盖面从人身扩展到火灾与燃气泄漏。", GREEN)
card(s, 6.8, 1.5, 5.7, 2.2, "多终端协同推送", "一次预警可触达多个云端订阅端（实测 2 端），\n把\"一个人知道\"变成\"一群人响应\"。", GREEN)
card(s, 0.8, 4.0, 5.7, 2.2, "本地优先架构", "断网时采集/判定/声光/语音求助完整可用，\n核心可靠性不依赖外网。", BLUE)
card(s, 6.8, 4.0, 5.7, 2.2, "可扩展多节点（多房间已实测）", "同网关接入多房间节点，按编号分别展示与路由；\n无线节点免布线（协议已验证，固件待烧录）。", BLUE)

# ---------------- 12 局限与展望 ----------------
s = prs.slides.add_slide(BLANK); head(s, "十一、局限与展望", 12)
bullets(s, 0.8, 1.4, 11.8, 4.0, [
    ("跌倒识别：拟引入毫米波雷达模块——自带判定算法、不受光照影响、隐私友好，且演示风险低", 0),
    ("语音播报：当前为预录提示音，后续可扩展多语种与可配置内容", 0),
    ("云平台：当前为自建轻量消息服务，后续可对接公有物联网平台，实现远程运维与长期留存", 0),
    ("数据分析：积累足够数据后引入趋势预测，提前发现健康风险", 0),
    ("通信方式：可扩展独立联网能力，使预警不依赖家庭宽带", 0),
], size=15)
tb(s, 0.8, 5.7, 11.8, 1.0, "以最小的硬件成本，把\"无人知晓\"变成\"处处有响应\"。",
   size=20, bold=True, color=NAVY, align=PP_ALIGN.CENTER)

# ---------------- 讲解备注（路演时照读；合计约 10 分钟） ----------------
NOTES = [
    ("0:00-0:20", "开场。一句话说清价值：独居老人最大的风险不是意外本身，而是意外发生后没人知道。本作品要解决的就是这一点。"),
    ("0:20-1:10", "痛点三连：突发健康风险、居家环境风险、家属信息缺口。强调“无人知晓”是共同症结。"),
    ("1:10-2:00", "总览四层架构：感知层—边缘判定层—云端汇聚层—应用层。点出三条设计原则：本地优先、隐私友好、可扩展多节点。"),
    ("2:00-2:50", "硬件方案。强调“复用板载资源压缩成本”：三色灯当光报警、板载喇叭当语音播报、加速度计作活动量辅助判据。接口按实机原理图与占用表确定。"),
    ("2:50-3:50", "南向采集与识别。说明阈值+持续时长双判据、优先级顺序、以及“关注”中间态；顺带提一句启动宽限期与消抖是实测踩坑后加的。"),
    ("3:50-4:40", "现场应急响应：声、光、语音三条通道，全部在板子本地完成，不依赖外网、不依赖手机。强调“自救+他救”双通道。"),
    ("4:40-6:10", "北向 APP 重点讲。三张截图都是真机运行：实时状态与设备报文逐项一致；预警可填写处置结果并闭环；活动报告给出“较昨日下降 X%”。现场若有设备，直接实机演示。"),
    ("6:10-7:10", "云端与多终端。按设备编号组织主题，订阅者数量不受限——把“一个人知道”变成“一群人响应”。闭环回路：确认→下发→设备留痕。"),
    ("7:10-8:00", "关键实现与真实踩坑。挑 1-2 个讲透即可（音频接口只接受 fd 形式、界面局部更新机制），体现工程真实性与解决问题的能力。"),
    ("8:00-8:50", "测试结果。指出哪些项已真机验证通过、哪些待传感器到货复测——如实说明比夸大更加分。"),
    ("8:50-9:40", "创新点四张卡：多维安全监测、多终端协同推送、本地优先架构、可扩展多节点。"),
    ("9:40-10:00", "收尾。回到痛点那句话：用最小的硬件成本，把独居老人身边无人知晓的风险，变成处处有响应的守护。"),
]
for i, (t, n) in enumerate(NOTES):
    if i < len(prs.slides):
        prs.slides[i].notes_slide.notes_text_frame.text = f"[建议时长 {t}] {n}"

prs.save(OUT)
print("已生成:", OUT, f"({os.path.getsize(OUT):,} 字节)  幻灯片数: {len(prs.slides)}（含讲解备注）")
