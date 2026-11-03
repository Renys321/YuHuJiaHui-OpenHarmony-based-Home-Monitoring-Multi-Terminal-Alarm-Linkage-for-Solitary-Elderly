# -*- coding: utf-8 -*-
"""生成《答辩 PPT》（赛题四）—— 16:9，14 页，结论式标题，含口播备注。

约束（来自官方提交要求与 docs/PROMPT-DOCX-PPT.md）：
- 汇报 ≤7 分钟，12–14 页；每页标题即结论，正文 ≤5 条、每条 ≤18 字，字号 ≥20pt；
- 盲审：不出现学校/学院/指导教师/队员/队名/校徽；核心属性中性；
- 不虚构指标，只用可核实数字（端口、节点数、实测时延、证据目录）。
用法（DSH 捆绑 Python）：
    python build_defense_ppt.py
输出：docs/submission/答辩PPT.pptx
"""
import os
from pptx import Presentation
from pptx.util import Inches, Pt
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from pptx.enum.shapes import MSO_SHAPE
from pptx.oxml.ns import qn
from lxml import etree
from PIL import Image

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SUBMIT = os.path.join(BASE, "docs", "submission")
FIG = os.path.join(SUBMIT, "figures")
EV = os.path.join(BASE, "evidence", "2026-11-01-elder-safe-app")
OUT = os.path.join(SUBMIT, "答辩PPT.pptx")

NAVY = RGBColor(0x16, 0x32, 0x4F)
BLUE = RGBColor(0x3F, 0x7D, 0xE6)
GRAY = RGBColor(0x5A, 0x6B, 0x7B)
LIGHT = RGBColor(0xF2, 0xF6, 0xFC)
WHITE = RGBColor(0xFF, 0xFF, 0xFF)
GREEN = RGBColor(0x2E, 0xA3, 0x6B)
ORANGE = RGBColor(0xE6, 0xA2, 0x3C)
RED = RGBColor(0xD9, 0x53, 0x4F)
FONT = "微软雅黑"

prs = Presentation()
prs.slide_width = Inches(13.333)
prs.slide_height = Inches(7.5)
BLANK = prs.slide_layouts[6]

W = 13.333
H = 7.5
M = 0.62


def set_font(run, size=20, bold=False, color=NAVY):
    f = run.font
    f.size = Pt(size)
    f.bold = bold
    f.name = FONT
    f.color.rgb = color
    rPr = run._r.get_or_add_rPr()
    latin = rPr.find(qn("a:latin"))
    ea = rPr.find(qn("a:ea"))
    if ea is None:
        ea = etree.SubElement(rPr, qn("a:ea"))
        if latin is not None:
            latin.addnext(ea)
    ea.set("typeface", FONT)


def textbox(slide, x, y, w, h, anchor=MSO_ANCHOR.TOP):
    tb = slide.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h))
    tf = tb.text_frame
    tf.word_wrap = True
    tf.vertical_anchor = anchor
    tf.margin_left = tf.margin_right = Inches(0.02)
    tf.margin_top = tf.margin_bottom = Inches(0.02)
    return tb


def para(tf, text, size=20, bold=False, color=NAVY, space_after=6, first=False,
         align=PP_ALIGN.LEFT, line_spacing=1.15):
    p = tf.paragraphs[0] if first else tf.add_paragraph()
    p.alignment = align
    p.space_after = Pt(space_after)
    p.line_spacing = line_spacing
    r = p.add_run()
    r.text = text
    set_font(r, size, bold, color)
    return p


def rect(slide, x, y, w, h, fill=LIGHT, line=None, shape=MSO_SHAPE.ROUNDED_RECTANGLE, radius=0.08):
    s = slide.shapes.add_shape(shape, Inches(x), Inches(y), Inches(w), Inches(h))
    s.fill.solid()
    s.fill.fore_color.rgb = fill
    if line is None:
        s.line.fill.background()
    else:
        s.line.color.rgb = line
        s.line.width = Pt(1.25)
    s.shadow.inherit = False
    try:
        s.adjustments[0] = radius
    except Exception:
        pass
    return s


def add_slide(title=None, page=None):
    s = prs.slides.add_slide(BLANK)
    bg = s.background.fill
    bg.solid()
    bg.fore_color.rgb = WHITE
    if title is not None:
        # 顶部强调条
        rect(s, 0, 0, W, 0.09, fill=BLUE, shape=MSO_SHAPE.RECTANGLE)
        tb = textbox(s, M, 0.33, 12.1, 0.9)
        p = tb.text_frame.paragraphs[0]
        p.alignment = PP_ALIGN.LEFT
        r = p.add_run()
        r.text = title
        set_font(r, 28, True, NAVY)
        rect(s, M, 1.24, 1.1, 0.055, fill=BLUE, shape=MSO_SHAPE.RECTANGLE)
    # 页脚
    ft = textbox(s, M, H - 0.42, 7.0, 0.3)
    para(ft.text_frame, "域护家徽 · 赛题四", size=12, color=GRAY, first=True)
    if page is not None:
        pn = textbox(s, W - 1.2, H - 0.42, 0.8, 0.3)
        p = pn.text_frame.paragraphs[0]
        p.alignment = PP_ALIGN.RIGHT
        r = p.add_run()
        r.text = str(page)
        set_font(r, 12, False, GRAY)
    return s


def bullets(slide, items, x=M, y=1.55, w=6.2, size=22, gap=12, color=NAVY):
    tb = textbox(slide, x, y, w, 5.2)
    tf = tb.text_frame
    for i, it in enumerate(items):
        para(tf, "· " + it, size=size, color=color, space_after=gap, first=(i == 0), line_spacing=1.2)
    return tb


def card(slide, x, y, w, h, head, body, accent=BLUE, head_size=21, body_size=20):
    rect(slide, x, y, w, h, fill=LIGHT, line=RGBColor(0xC9, 0xD6, 0xE8))
    rect(slide, x, y, 0.08, h, fill=accent, shape=MSO_SHAPE.RECTANGLE)
    tb = textbox(slide, x + 0.22, y + 0.14, w - 0.4, h - 0.28, anchor=MSO_ANCHOR.TOP)
    tf = tb.text_frame
    para(tf, head, size=head_size, bold=True, color=accent, space_after=4, first=True)
    if body:
        para(tf, body, size=body_size, color=NAVY, space_after=0, line_spacing=1.1)


def fit_image(slide, path, x, y, w, h):
    """等比缩放放进 (x,y,w,h) 区域并居中。"""
    iw, ih = Image.open(path).size
    scale = min(w / iw, h / ih)
    nw, nh = iw * scale, ih * scale
    return slide.shapes.add_picture(path, Inches(x + (w - nw) / 2), Inches(y + (h - nh) / 2),
                                    Inches(nw), Inches(nh))


def notes(slide, text):
    slide.notes_slide.notes_text_frame.text = text


# ============================ 1 封面 ============================
s = add_slide()
rect(s, 0, 0, W, H, fill=NAVY, shape=MSO_SHAPE.RECTANGLE)
rect(s, 0, 0, W, 0.16, fill=BLUE, shape=MSO_SHAPE.RECTANGLE)
tb = textbox(s, M, 1.85, 12.1, 1.5)
para(tb.text_frame, "域护家徽", size=64, bold=True, color=WHITE, first=True)
tb = textbox(s, M, 3.35, 12.1, 0.9)
para(tb.text_frame, "OpenHarmony 驱动的独居老人居家传感监测与多端告警联动系统",
     size=22, color=RGBColor(0xD6, 0xE2, 0xF5), first=True)
rect(s, M, 4.55, 1.4, 0.06, fill=BLUE, shape=MSO_SHAPE.RECTANGLE)
tb = textbox(s, M, 4.85, 12.1, 0.7)
para(tb.text_frame, "赛题四 · 独居老人居家安全监测与应急辅助系统", size=20,
     color=RGBColor(0xB9, 0xCB, 0xE4), first=True)
notes(s, "各位评委好，我们的作品是域护家徽。针对独居老人，用 OpenHarmony 开发板做家庭边缘主控，"
         "配合两块 ESP32-S3 房间节点、本地网关与云端后端，形成一条本地优先、设备级确认的告警闭环。"
         "接下来用六七分钟说明：它解决什么问题、怎么实现、验证到什么程度，并留一次现场演示。")

# ============================ 2 痛点 ============================
s = add_slide("断网仍可用、确认要真闭环，才是独居监护的关键", 2)
items = ["独居风险：突发、发现慢、依赖家属",
         "常见方案：断网即哑、点确认当闭环",
         "我们的目标：本地先响、多端可见",
         "三个约束：可靠、隐私、可扩展",
         "不追求：医学诊断与准确率承诺"]
bullets(s, items, w=12.0, size=24, gap=18)
notes(s, "先说我们的判断。独居老人遇到跌倒、长时间无活动、燃气泄漏，最怕没人及时发现。"
         "不少方案依赖云端，断网就失效；还有的把家属点一下确认当成处理完成。"
         "所以目标定成三件事：本地先响、多端可见、确认要真闭环。这里的本地，指公网断开时节点本地照常；跨房间路由依赖网关。")

# ============================ 3 架构 ============================
s = add_slide("五层解耦：设备、边缘、本地网关、云、应用", 3)
items = ["节点只管采集与执行", "网关做协议转换与智能", "云端管账号与留痕", "应用分监护 APP 与板载 APP"]
bullets(s, items, w=4.6, size=22, gap=16)
fit_image(s, os.path.join(FIG, "fig3-1-architecture.png"), 5.2, 1.5, 7.6, 5.4)
notes(s, "系统分五层。房间节点不实现 MQTT，只用 JSON 行协议；本地网关负责桥接、视觉、语音和视频；"
         "边缘主控做本地判定和人机交互；云端只承担账号、告警和跨端同步。层间用固定端口，"
         "公网断开时本地照常；跨房间路由依赖本地网关（PC+USB/hdc），这是已列的单点。")

# ============================ 4 硬件 ============================
s = add_slide("两块 S3 节点 + DAYU200，本地先响", 4)
card(s, M, 1.6, 3.85, 1.62, "边缘主控", "摄像头、人体检测、板载 APP", BLUE)
card(s, 4.7, 1.6, 3.85, 1.62, "厨房节点", "温湿度、燃气、烟雾、门磁", GREEN)
card(s, 8.78, 1.6, 3.85, 1.62, "卫生间节点", "PIR、门磁、外接 SOS", GREEN)
card(s, M, 3.45, 3.85, 1.62, "音频通路", "ES8388 播放 + 板载咪头", ORANGE)
card(s, 4.7, 3.45, 3.85, 1.62, "声光执行", "XL9555 控功放与蜂鸣器", ORANGE)
card(s, 8.78, 3.45, 3.85, 1.62, "本地网关", "Windows PC：桥接/视觉/语音", BLUE)
tb = textbox(s, M, 5.35, 12.1, 1.2)
para(tb.text_frame, "节点 = 通用 ESP32-S3；差异只在配置；传感器按设计能力列出，部分待接线",
     size=20, color=GRAY, first=True)
notes(s, "硬件上，DAYU200 做边缘主控，板载摄像头、显示和音频。两块 ESP32-S3 分别装在厨房和卫生间，"
         "采集温湿度、燃气、烟雾、PIR 和门磁，按键做 SOS。音频走板载 ES8388，功放和蜂鸣器由 I/O 扩展器控制。"
         "两块节点硬件相同，差异只在配置。")

# ============================ 5 状态上行 ============================
s = add_slide("状态一次上行，多端同时看见", 5)
items = ["节点→bridge→MQTT→云端", "同状态限频去重", "12 秒无状态判离线", "监护 APP 与板载端同时订阅", "公网断开只降云端能力"]
bullets(s, items, x=M, y=1.55, w=4.8, size=21, gap=14)
fit_image(s, os.path.join(FIG, "fig3-2-uplink.png"), 5.35, 1.5, 7.4, 4.6)
notes(s, "状态链路是：节点通过 TCP 发 JSON 行到 bridge，bridge 转成 MQTT，再经 public-sync 用 HTTPS 推到云端。"
         "我们做了同状态限频去重和 12 秒离线判定，两端看到同一份状态。")

# ============================ 6 ACK ============================
s = add_slide("点确认不等于闭环，设备回执才算", 6)
items = ["202 只代表已入队", "alarmId 必须精确匹配", "8 秒无回执判超时", "离线设备拒绝 ACK", "重复 ACK 被拒绝"]
bullets(s, items, x=M, y=1.55, w=4.8, size=21, gap=14)
fit_image(s, os.path.join(FIG, "fig5-1-ack.png"), 5.35, 1.5, 7.4, 4.7)
tb = textbox(s, 6.0, 6.28, 6.8, 0.45)
para(tb.text_frame, "图为设计链路；实体公网 ACKED 闭环未测", size=20, color=GRAY, first=True)
notes(s, "这是最容易被做成假闭环的一环。家属点确认，后端只返回 202，代表进入待下发队列；"
         "命令经网关下到设备，设备校验 alarmId 精确匹配后回执 ACKED，告警才真正结清。"
         "8 秒没有匹配状态就判超时，离线设备直接拒绝确认。图为设计链路；公网实体闭环尚未实测，本地真机闭环已通过。"
         "演示：按 KEY0，APP 出现待处置，点确认后进入等待回执，设备回执才闭环；超时即 8 秒保护。")

# ============================ 7 视觉 ============================
s = add_slide("跌倒不再只认 180°：方向不敏感判据", 7)
items = ["方向不敏感塌落判据", "竖向 / 前向 750–1500ms", "180° 侧倒保持检出", "快速深蹲 0/3 误报", "真实跌倒阈值待标定"]
bullets(s, items, x=M, y=1.55, w=5.0, size=21, gap=14)
fit_image(s, os.path.join(FIG, "fig5-2-fall.png"), 5.6, 1.55, 7.2, 4.3)
notes(s, "视觉用 YOLO 姿态模型提关键点。原来的判据要求身体在画面里转到水平，所以竖向屈膝和朝镜头前倒检不出。"
         "我们新增方向不敏感的塌落判据：身体相对站立基线快速下沉、末端到低位，再确认 200 毫秒；180° 侧倒判据保持不变。"
         "离线矩阵 7/7；受控实机 4 次不同方向跌倒全部检出，交替测试跌倒 3/3、快速深蹲 0/3。"
         "真实跌倒录像尚未标定。")

# ============================ 8 多节点 ============================
s = add_slide("新增房间只改配置，不改代码", 8)
cards8 = [
    ("协议同构", "节点不实现 MQTT，JSON 行"),
    ("配置化", "节点 ID / 房间 / 引脚在配置"),
    ("定向推送", "30 轮回归逐轮校验，无串台"),
    ("重连语义", "同 ID 重连原子替换"),
    ("云端零改动", "新增房间不改云端与 APP"),
]
for i, (head, body) in enumerate(cards8):
    card(s, M + i * 2.46, 1.9, 2.35, 2.9, head, body, accent=BLUE if i % 2 == 0 else GREEN,
         head_size=21, body_size=20)
tb = textbox(s, M, 5.15, 12.1, 1.2)
para(tb.text_frame, "新节点须用新 deviceId 并重刷固件；云端与 APP 零改动", size=20, color=GRAY, first=True)
notes(s, "扩展性上，节点完全不实现 MQTT，只用同一套 JSON 行协议，节点 ID、房间名和引脚都在配置里。"
         "30 轮回归逐轮校验定向推送，没有出现串台。"
         "需要说明的是，新增房间需要重刷固件配置，但云端和 APP 不用改。")

# ============================ 9 视频/随身 ============================
s = add_slide("两条旁路：视频不落盘、随身走 4G", 9)
items = ["票据一次性，60 秒失效", "WS 只转发，首帧约 0.4 秒", "无人观看即断，不落盘",
         "随身 SOS 走 4G，不进本地 MQTT"]
bullets(s, items, w=12.0, size=24, gap=18)
tb = textbox(s, M, 5.3, 12.1, 1.0)
para(tb.text_frame, "边界：镜像链路已验在线与轮询；断网切换未测", size=20, color=GRAY, first=True)
notes(s, "两条旁路。视频探望用一次性票据换 WebSocket，票据 60 秒失效，只转发首帧约 0.4 秒，"
         "无人观看立即断开、不落盘。随身 SOS 走 4G 直达云端，刻意不进本地 MQTT，避免与房间节点混淆。"
         "镜像链路已验证在线与轮询；断网切换未测。")

# ============================ 10 可靠性 ============================
s = add_slide("可靠性靠自愈，不靠人盯", 10)
items = ["守护脚本 15 秒巡检", "hdc 映射丢失自动重建", "网关按端口识别进程", "30 轮 210 项检查全过", "视觉 45s 活动心跳"]
bullets(s, items, x=M, y=1.55, w=5.6, size=21, gap=14)
card(s, 6.6, 1.6, 6.0, 1.5, "一键启动", "8 步：预检→映射→P0→板端→视觉→relay→语音→mirror→汇总", BLUE, body_size=20)
card(s, 6.6, 3.3, 6.0, 1.5, "实测体检", "体检 11/11 全过", GREEN, body_size=20)
card(s, 6.6, 5.0, 6.0, 1.5, "防误报", "活动心跳 + 静默锁防误报", ORANGE, body_size=20)
notes(s, "稳定性做了三层：守护脚本每 15 秒巡检，自动恢复网关和 hdc 映射；一键脚本按端口识别进程，避免假重启；"
         "回归测试 30 轮共 210 项全部通过；视觉服务每 45 秒发活动心跳，避免设备侧误判“无活动”顶掉跌倒告警。"
         "演示时还有静默锁。")

# ============================ 11 验证与边界 ============================
from PIL import Image as _Image


def _crop(src, dst, box):
    _Image.open(src).crop(box).save(dst)


CROP_BOX = (30, 905, 1225, 1200)
_crop(os.path.join(EV, "phone-16-unconfirmed-before-ack.jpg"),
      os.path.join(FIG, "phone-state-unconfirmed.png"), CROP_BOX)
_crop(os.path.join(EV, "phone-17-pending-device-ack.jpg"),
      os.path.join(FIG, "phone-state-pending.png"), CROP_BOX)

s = add_slide("验证过什么、没验证什么，逐条写清", 11)
card(s, M, 1.55, 3.8, 1.5, "PASS", "登录、告警、ACK、跌倒 4/4", GREEN)
card(s, 4.65, 1.55, 3.8, 1.5, "PARTIAL", "公网全链、证据上传", ORANGE)
card(s, 8.7, 1.55, 3.8, 1.5, "NOT TESTED", "真实跌倒标定、长时性能", RED)
fit_image(s, os.path.join(FIG, "phone-state-unconfirmed.png"), 0.7, 3.3, 5.0, 1.23)
tb = textbox(s, 0.7, 4.6, 5.0, 0.4)
para(tb.text_frame, "未确认（不影响原告警）", size=20, color=GRAY, first=True)
fit_image(s, os.path.join(FIG, "phone-state-pending.png"), 0.7, 5.05, 5.0, 1.23)
tb = textbox(s, 0.7, 6.35, 5.0, 0.4)
para(tb.text_frame, "等待设备回执", size=20, color=GRAY, first=True)
tb = textbox(s, 6.35, 3.25, 6.3, 3.6)
tf = tb.text_frame
para(tf, "三态：未确认 → 等待回执 → 已闭环", size=20, bold=True, color=BLUE, first=True, space_after=10)
para(tf, "设备回执 ACKED 才归档", size=20, color=NAVY, space_after=8)
para(tf, "已闭环后绿色卡片消失（phone-18 实拍）", size=20, color=NAVY, space_after=8)
para(tf, "证据：evidence/（详见仓库）", size=20, color=GRAY, space_after=0)
notes(s, "验证按三级标注：PASS 有原始证据，比如登录、告警、ACK 页面，以及受控实机 4 次跌倒全部检出；"
         "PARTIAL 是只部分成立，比如公网全链；NOT TESTED 包括真实跌倒阈值标定、长时性能。"
         "下方是监护 APP（手机端）三态实拍。")

# ============================ 12 创新 ============================
s = add_slide("四个创新点，对应四个工程取舍", 12)
card(s, M, 1.6, 5.9, 2.2, "① 本地优先闭环", "断网仍能采集、判定、声光与按键求助", BLUE, body_size=20)
card(s, 6.75, 1.6, 5.9, 2.2, "② 设备级 ACK", "202 不算闭环，设备回执 alarmId 才结清", GREEN, body_size=20)
card(s, M, 4.15, 5.9, 2.2, "③ 多节点同构", "节点不实现 MQTT，新增房间零改云端", ORANGE, body_size=20)
card(s, 6.75, 4.15, 5.9, 2.2, "④ 受限视觉事件", "方向不敏感只提交 fall；坐蹲不误报", RED, body_size=20)
notes(s, "总结四个点：本地优先闭环、设备级 ACK、多节点同构、受限视觉事件。"
         "它们都对应明确的工程取舍：本地优先换现场可用，设备级 ACK 换真实闭环，同构协议换扩展成本，受限事件换可解释性。")

# ============================ 13 边界与后续 ============================
s = add_slide("边界清楚，才敢承诺", 13)
items = ["局域网链路暂无 TLS 与鉴权", "PC/USB 网关为单点，小时级未测", "真实跌倒阈值未标定、近景不支持",
         "门磁与卫生间传感器待接线", "板载 HAP 已签名；监护 APP 未正式签名"]
bullets(s, items, w=12.0, size=23, gap=17)
notes(s, "边界也写清楚：家庭局域网链路目前没有 TLS 和身份鉴别，只适用于受控网络；还没做小时级浸泡和多目标并发；"
         "板载 HAP 已签名安装，但真实跌倒阈值未标定、近景构图不支持；部分传感器还没接线。"
         "后续先稳定、再扩展；PC 与 USB 是最大单点。")

# ============================ 14 结束 ============================
s = add_slide()
rect(s, 0, 0, W, H, fill=NAVY, shape=MSO_SHAPE.RECTANGLE)
rect(s, 0, H - 0.16, W, 0.16, fill=BLUE, shape=MSO_SHAPE.RECTANGLE)
tb = textbox(s, M, 2.3, 12.1, 1.2)
para(tb.text_frame, "域护家徽", size=54, bold=True, color=WHITE, first=True)
tb = textbox(s, M, 3.6, 12.1, 0.9)
para(tb.text_frame, "让每一次异常，都有人知道", size=28, color=RGBColor(0xD6, 0xE2, 0xF5), first=True)
tb = textbox(s, M, 4.8, 12.1, 0.7)
para(tb.text_frame, "赛题四 · 独居老人居家安全监测与应急辅助系统", size=20,
     color=RGBColor(0xB9, 0xCB, 0xE4), first=True)
notes(s, "我们的目标很简单：让每一次异常都有人知道，而且确认是真的。系统当前已具备演示条件，现场可实际触发 SOS、自述安全和 KEY1 健康语音。谢谢各位评委。")

# 核心属性置中性（盲审）
cp = prs.core_properties
cp.author = "参赛作品"
cp.last_modified_by = "参赛作品"
cp.title = "域护家徽：OpenHarmony 驱动的独居老人居家传感监测与多端告警联动系统 答辩PPT"
cp.subject = "赛题四 答辩"
cp.comments = ""

prs.save(OUT)
print("saved:", OUT, "slides:", len(prs.slides.__iter__.__self__._sldIdLst))
