from pathlib import Path
from datetime import date

from docx import Document
from docx.enum.section import WD_SECTION
from docx.enum.table import WD_ALIGN_VERTICAL, WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Inches, Pt, RGBColor


OUTPUT_DIR = Path(r"D:\BaiduNetdiskDownload")
TODAY = "2026年10月12日"

NAVY = "17365D"
BLUE = "2F5597"
LIGHT_BLUE = "DCE6F1"
PALE_BLUE = "F4F7FB"
PALE_GRAY = "F2F2F2"
MID_GRAY = "666666"
BORDER = "D9D9D9"
GREEN = "2E7D32"
AMBER = "A15C00"
RED = "B3261E"
BLACK = "000000"
WHITE = "FFFFFF"


def set_run_font(run, name="Microsoft YaHei", size=10.5, bold=False, color=BLACK):
    run.font.name = name
    run._element.get_or_add_rPr().rFonts.set(qn("w:eastAsia"), name)
    run._element.get_or_add_rPr().rFonts.set(qn("w:ascii"), "Arial")
    run._element.get_or_add_rPr().rFonts.set(qn("w:hAnsi"), "Arial")
    run.font.size = Pt(size)
    run.font.bold = bold
    run.font.color.rgb = RGBColor.from_string(color)


def remove_paragraph_borders(paragraph_or_style):
    element = paragraph_or_style._element
    p_pr = element.pPr
    if p_pr is None:
        return
    borders = p_pr.find(qn("w:pBdr"))
    if borders is not None:
        p_pr.remove(borders)


def set_cell_shading(cell, fill):
    tc_pr = cell._tc.get_or_add_tcPr()
    shd = tc_pr.find(qn("w:shd"))
    if shd is None:
        shd = OxmlElement("w:shd")
        tc_pr.append(shd)
    shd.set(qn("w:fill"), fill)


def set_cell_margins(cell, top=90, start=110, bottom=90, end=110):
    tc = cell._tc
    tc_pr = tc.get_or_add_tcPr()
    tc_mar = tc_pr.first_child_found_in("w:tcMar")
    if tc_mar is None:
        tc_mar = OxmlElement("w:tcMar")
        tc_pr.append(tc_mar)
    for margin, value in (("top", top), ("start", start), ("bottom", bottom), ("end", end)):
        node = tc_mar.find(qn(f"w:{margin}"))
        if node is None:
            node = OxmlElement(f"w:{margin}")
            tc_mar.append(node)
        node.set(qn("w:w"), str(value))
        node.set(qn("w:type"), "dxa")


def set_table_borders(table, color=BORDER, size="6"):
    tbl_pr = table._tbl.tblPr
    borders = tbl_pr.find(qn("w:tblBorders"))
    if borders is None:
        borders = OxmlElement("w:tblBorders")
        tbl_pr.append(borders)
    for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
        tag = f"w:{edge}"
        element = borders.find(qn(tag))
        if element is None:
            element = OxmlElement(tag)
            borders.append(element)
        element.set(qn("w:val"), "single")
        element.set(qn("w:sz"), size)
        element.set(qn("w:space"), "0")
        element.set(qn("w:color"), color)


def set_repeat_header(row):
    tr_pr = row._tr.get_or_add_trPr()
    tbl_header = OxmlElement("w:tblHeader")
    tbl_header.set(qn("w:val"), "true")
    tr_pr.append(tbl_header)


def prevent_row_split(row):
    tr_pr = row._tr.get_or_add_trPr()
    cant_split = OxmlElement("w:cantSplit")
    cant_split.set(qn("w:val"), "true")
    tr_pr.append(cant_split)


def set_cell_width(cell, width_cm):
    tc_pr = cell._tc.get_or_add_tcPr()
    tc_w = tc_pr.find(qn("w:tcW"))
    if tc_w is None:
        tc_w = OxmlElement("w:tcW")
        tc_pr.append(tc_w)
    tc_w.set(qn("w:w"), str(int(Cm(width_cm).emu / 635)))
    tc_w.set(qn("w:type"), "dxa")


def set_cell_text(cell, text, bold=False, color=BLACK, size=9.2, align=None):
    cell.text = ""
    p = cell.paragraphs[0]
    p.paragraph_format.space_after = Pt(0)
    p.paragraph_format.space_before = Pt(0)
    p.paragraph_format.line_spacing = 1.15
    if align is not None:
        p.alignment = align
    run = p.add_run(str(text))
    set_run_font(run, size=size, bold=bold, color=color)
    cell.vertical_alignment = WD_ALIGN_VERTICAL.CENTER


def add_table(doc, headers, rows, widths, center_cols=(), status_col=None, font_size=9.0):
    table = doc.add_table(rows=1, cols=len(headers))
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    table.autofit = False
    set_table_borders(table)
    header = table.rows[0]
    set_repeat_header(header)
    for i, (cell, text) in enumerate(zip(header.cells, headers)):
        set_cell_width(cell, widths[i])
        set_cell_shading(cell, NAVY)
        set_cell_margins(cell, top=100, bottom=100)
        set_cell_text(cell, text, bold=True, color=WHITE, size=9.1, align=WD_ALIGN_PARAGRAPH.CENTER)
    for r_idx, row in enumerate(rows):
        table_row = table.add_row()
        prevent_row_split(table_row)
        cells = table_row.cells
        for i, (cell, value) in enumerate(zip(cells, row)):
            set_cell_width(cell, widths[i])
            set_cell_margins(cell)
            if r_idx % 2 == 1:
                set_cell_shading(cell, PALE_BLUE)
            align = WD_ALIGN_PARAGRAPH.CENTER if i in center_cols else WD_ALIGN_PARAGRAPH.LEFT
            color = BLACK
            bold = False
            if status_col is not None and i == status_col:
                bold = True
                label = str(value)
                if "完成" in label or "通过" in label or "PASS" in label:
                    color = GREEN
                elif "部分" in label or "待" in label or "PARTIAL" in label:
                    color = AMBER
                elif "未" in label or "阻塞" in label or "BLOCKED" in label:
                    color = RED
            set_cell_text(cell, value, bold=bold, color=color, size=font_size, align=align)
    doc.add_paragraph().paragraph_format.space_after = Pt(0)
    return table


def setup_document(title, subtitle):
    doc = Document()
    section = doc.sections[0]
    section.page_width = Cm(21.0)
    section.page_height = Cm(29.7)
    section.top_margin = Cm(2.0)
    section.bottom_margin = Cm(1.8)
    section.left_margin = Cm(2.15)
    section.right_margin = Cm(2.15)

    normal = doc.styles["Normal"]
    normal.font.name = "Microsoft YaHei"
    normal._element.rPr.rFonts.set(qn("w:eastAsia"), "Microsoft YaHei")
    normal.font.size = Pt(10.5)
    normal.font.color.rgb = RGBColor(0, 0, 0)
    normal.paragraph_format.space_after = Pt(6)
    normal.paragraph_format.line_spacing = 1.35

    title_style = doc.styles["Title"]
    title_style.font.name = "Microsoft YaHei"
    title_style._element.rPr.rFonts.set(qn("w:eastAsia"), "Microsoft YaHei")
    title_style.font.size = Pt(25)
    title_style.font.bold = True
    title_style.font.color.rgb = RGBColor(0, 0, 0)
    title_style.paragraph_format.space_after = Pt(10)
    remove_paragraph_borders(title_style)

    for style_name, size in (("Heading 1", 16), ("Heading 2", 12.5), ("Heading 3", 11)):
        style = doc.styles[style_name]
        style.font.name = "Microsoft YaHei"
        style._element.rPr.rFonts.set(qn("w:eastAsia"), "Microsoft YaHei")
        style.font.size = Pt(size)
        style.font.bold = True
        style.font.color.rgb = RGBColor(0, 0, 0)
        style.paragraph_format.keep_with_next = True
        style.paragraph_format.space_before = Pt(12 if style_name == "Heading 1" else 8)
        style.paragraph_format.space_after = Pt(6)

    p = doc.add_paragraph(style="Title")
    p.alignment = WD_ALIGN_PARAGRAPH.LEFT
    remove_paragraph_borders(p)
    r = p.add_run(title)
    set_run_font(r, size=25, bold=True)

    p = doc.add_paragraph()
    p.paragraph_format.space_after = Pt(18)
    r = p.add_run(subtitle)
    set_run_font(r, size=11.5, color=MID_GRAY)

    footer = section.footer
    fp = footer.paragraphs[0]
    fp.alignment = WD_ALIGN_PARAGRAPH.CENTER
    fr = fp.add_run(f"独居老人居家安全监测与应急辅助系统  |  {TODAY}")
    set_run_font(fr, size=8, color=MID_GRAY)
    return doc


def add_heading(doc, text, level=1):
    return doc.add_heading(text, level=level)


def add_para(doc, text, bold_lead=None, color=BLACK, size=10.5, align=None, keep=False):
    p = doc.add_paragraph()
    if align is not None:
        p.alignment = align
    p.paragraph_format.keep_together = keep
    if bold_lead and text.startswith(bold_lead):
        r1 = p.add_run(bold_lead)
        set_run_font(r1, size=size, bold=True, color=color)
        r2 = p.add_run(text[len(bold_lead):])
        set_run_font(r2, size=size, color=color)
    else:
        r = p.add_run(text)
        set_run_font(r, size=size, color=color)
    return p


def add_bullets(doc, items, level=0):
    for text in items:
        p = doc.add_paragraph(style="List Bullet" if level == 0 else "List Bullet 2")
        p.paragraph_format.left_indent = Cm(0.65 + level * 0.5)
        p.paragraph_format.first_line_indent = Cm(-0.25)
        p.paragraph_format.space_after = Pt(3)
        r = p.add_run(text)
        set_run_font(r, size=10.2)


def add_numbered(doc, items):
    for text in items:
        p = doc.add_paragraph(style="List Number")
        p.paragraph_format.left_indent = Cm(0.75)
        p.paragraph_format.first_line_indent = Cm(-0.35)
        p.paragraph_format.space_after = Pt(4)
        r = p.add_run(text)
        set_run_font(r, size=10.2)


def add_page_break(doc):
    doc.add_page_break()


def build_progress_document(path):
    doc = setup_document(
        "项目当前成果 进度与未完成事项",
        "独居老人居家安全监测与应急辅助系统  |  状态基线 " + TODAY,
    )
    doc.core_properties.title = "项目当前成果 进度与未完成事项"
    doc.core_properties.subject = "独居老人居家安全监测与应急辅助系统项目状态"
    doc.core_properties.author = "独居老人居家安全监测与应急辅助系统项目组"

    add_heading(doc, "结论", 1)
    add_para(
        doc,
        "项目已经形成可运行的竞赛原型：DAYU200 主控、ESP32 无线节点、局域网 Bridge 和监护 APP 的主链路已有真机证据；OneNET 安全接入、可信后端和微信小程序已有较完整的软件基础。当前还不是可交付成品，关键缺口集中在公网部署、手机真机、DAYU 摄像头、板端跌倒识别、厨房和卧室实体传感器、双向语音、自动电话以及 4G 备链。",
        keep=True,
    )
    add_para(
        doc,
        "按代码与本地测试衡量，软件原型约完成 65% 至 70%；按真实硬件、公网和手机的一体化闭环衡量，约完成 40% 至 45%。建议对外使用“局域网主链路已成型，云端与多模态能力正在收口”的表述，不把模拟设备或一次性云端检查写成完整产品。",
        keep=True,
    )

    add_heading(doc, "进度口径", 1)
    add_table(
        doc,
        ["口径", "估算进度", "计算边界"],
        [
            ["软件原型", "65% 至 70%", "已存在代码、单元测试和本地集成；不要求全部部署到公网或实体硬件"],
            ["最终一体化", "40% 至 45%", "要求手机、公网、边缘主控、实体传感器和告警回执形成可重复闭环"],
            ["当前建议基线", "约 43%", "按八个功能域加权估算，只用于排期，不代表工时或比赛得分"],
        ],
        [3.2, 3.2, 10.2],
        center_cols=(1,),
    )

    module_rows = [
        ["DAYU 局域网边缘主链", "15%", "80%", "真机 APP、homemon、Bridge、告警与 ACK 有历史证据"],
        ["ESP32 无线节点", "15%", "60%", "当前固件上行、NTP、毫秒时间戳通过；最终下行与实体传感器待验收"],
        ["OneNET 与可信后端", "15%", "55%", "真实 MQTTS 属性上报通过；公网常驻部署与实体下行未完成"],
        ["微信小程序", "15%", "40%", "五页面和 API 代码完成；正式 AppID、域名和手机真机未验收"],
        ["摄像头与跌倒检测", "15%", "25%", "PC YOLO Pose 基线通过；DAYU 取帧、RKNN/NPU、真人数据未完成"],
        ["语音与电话", "10%", "10%", "播放软件链路存在；交流、ASR、自动外呼未实现"],
        ["4G 与 GPS", "10%", "30%", "蜂窝注册和信号通过；GPS 无定位、服务器连接与备链未完成"],
        ["最终系统验收", "5%", "5%", "尚未按当前全部源码形成手机至实体设备的完整演示证据"],
    ]
    add_table(doc, ["功能域", "权重", "完成估算", "判断依据"], module_rows, [4.2, 2.0, 2.4, 8.0], center_cols=(1, 2))
    add_para(doc, "说明：上述百分比是工程成熟度估算。任何单项即使测试数量很多，只要没有完成真实部署或真机闭环，就不会按 100% 计。", color=MID_GRAY, size=9.2)

    add_heading(doc, "已经完成的工作", 1)

    add_heading(doc, "DAYU200 与局域网监护主链", 2)
    add_bullets(doc, [
        "DAYU200 已能运行 homemon、Bridge 关联链路和 OpenHarmony 监护 APP。",
        "APP 能显示客厅、卫生间等设备状态，并处理告警、正确 ACK、错误 ACK、重复 ACK、离线拒绝和同 ID 恢复。",
        "第三轮真机 UI 与日志证据覆盖跨房间 pending 结算、12 秒离线判定和恢复在线。",
        "DAYU 本地 SOS 能进入语音播放软件链路，系统出现 playing 和 completed 状态。",
    ])

    add_heading(doc, "ESP32 S3 无线节点", 2)
    add_bullets(doc, [
        "当前源码已经重新构建并烧录到真实 ESP32-S3。",
        "真实验证包括 2.4 GHz Wi-Fi、TCP 上行、NTP 同步、13 位毫秒时间戳和 Bridge/MQTT 状态发布。",
        "当前节点身份为 esp32-bath，可代表卫生间无线节点。",
        "Bridge 已完成重复 deviceId 连接替换、状态保护和定向路由测试。",
    ])

    add_heading(doc, "OneNET 可信后端与命令状态机", 2)
    add_bullets(doc, [
        "OneNET 产品、物模型和首个设备已经建立。",
        "真实设备 Token 曾完成 MQTTS CONNECT、订阅和属性上报，OneNET 返回业务 code 200。",
        "传输层具备 TLS、官方 CA、证书指纹固定、QoS 1、OneJSON、短期 Token 和下行白名单。",
        "后端已实现微信登录边界、家庭允许名单、设备与告警查询、ACK 队列、原子持久化、重启恢复和磁盘错误回滚。",
        "命令同步器要求同设备、同 alarmId 的新 ACKED 回执，避免 HTTP 成功被误当作设备确认。",
    ])

    add_heading(doc, "微信小程序软件框架", 2)
    add_bullets(doc, [
        "已经存在总览、房间、告警、设备与位置、联系人等五个页面。",
        "已经实现微信登录接口调用、设备和告警查询、统计展示、告警 ACK 入队和 wx.makePhoneCall 点击拨号代码。",
        "本地静态与模拟 API 检查共 45 项通过。",
    ])

    add_heading(doc, "视觉跌倒检测基线", 2)
    add_bullets(doc, [
        "PC CPU 已能加载 yolo11n-pose.pt 并输出 17 个关键点。",
        "时序规则覆盖坐下、弯腰、初始躺卧、床区排除、关键点丢失和跨 track 抑制。",
        "fall 定向命令、homemon FALL 构建和 APP 文案构建已有本地测试证据。",
    ])

    add_heading(doc, "YED 4G 与 GPS", 2)
    add_bullets(doc, [
        "YED-M100MG-B1 当前以 COM7、115200 波特率稳定返回固件信息。",
        "两轮实测为 SSTA=3、CSQ=26/30，证明 SIM 已识别、蜂窝网络已注册且信号有效。",
        "GNSS 已开启，隐私探测工具只输出 FIXED 或 NO_FIX，不保存家庭精确坐标；当前实测为 NO_FIX。",
    ])

    add_heading(doc, "证据等级与当前边界", 1)
    evidence_rows = [
        ["真实硬件或真实公网已验证", "DAYU 局域网 APP 闭环；ESP32 最终固件上行；OneNET 一次真实 MQTTS 属性上报；YED 串口、SIM、4G 注册和信号", "可以描述为已验证，但必须保留对应版本与现场条件"],
        ["本地单元或集成测试通过", "OneNET 122/122；网关 47/47；后端 36/36；小程序 45 checks；本地 ACK 13/13；跨重启 14/14；YED 工具 41/41", "证明代码逻辑，不等于公网、手机或实体设备闭环"],
        ["代码存在但没有真机验收", "小程序正式登录与拨号；相机权限和预览目标；语音播放效果；部分下行命令", "演示前必须补真机操作和日志证据"],
        ["尚未实现", "双向语音交流；自动电话；RKNN/NPU 板端跌倒推理；Wi-Fi 到 4G 自动接管；厨房卧室完整实体节点", "需要新增代码、硬件或外部服务"],
    ]
    add_table(doc, ["证据等级", "当前项目中的代表项", "可对外宣称的范围"], evidence_rows, [4.2, 7.2, 5.4])

    add_heading(doc, "仍未完成的关键事项", 1)
    unfinished_rows = [
        ["P0", "公网 HTTPS 后端", "部署服务器、域名、证书、Secret 和持久化目录，完成长期运行"],
        ["P0", "微信小程序手机真机", "配置正式 AppID、服务端 AppSecret、合法域名和监护人 openid；真机登录、查询、ACK、拨号"],
        ["P0", "手机到实体设备闭环", "手机 ACK 经公网后端与网关到真实 DAYU/ESP32，再由 ACKED 回写手机"],
        ["P0", "厨房和卧室节点", "完成烟雾/燃气、人体/离床、SOS 等实体接线；保证多个房间同时在线"],
        ["P1", "DAYU 摄像头", "枚举驱动、Camera 权限、预览、抓拍、权限拒绝和隐私开关"],
        ["P1", "板端跌倒检测", "模型转换、RKNN/NPU 推理、持续 FPS 与资源测试、真人数据和误报评估"],
        ["P1", "最终 ESP32 下行复验", "正确、错误和重复 ACK；断线恢复；PIR、门磁、蜂鸣器实物效果"],
        ["P1", "4G 与 GPS", "室外取得 GNSS FIX；建立可信服务器连接；验证 Wi-Fi 断开后的 4G 接管"],
        ["P2", "语音交流与自动电话", "实现 ASR、TTS、唤醒或双向音频；另选 VoLTE 模块或云呼叫服务"],
        ["P2", "重启自动校时", "人工校时曾成功，但无 RTC 电池时重启可能回退，需要自动网络校时"],
        ["P0", "最终演示证据", "按当前源码重建、安装、启动并录制手机、板端、串口、云端和回执证据"],
    ]
    add_table(doc, ["优先级", "事项", "完成定义"], unfinished_rows, [1.7, 4.4, 10.7], center_cols=(0,), status_col=None)

    add_heading(doc, "建议的收口顺序", 1)
    add_numbered(doc, [
        "先部署公网 HTTPS 后端，配置域名、证书、运行 Secret 和可恢复数据目录。",
        "导入微信小程序并在真实手机完成登录、设备列表、告警、ACK 和点击拨号。",
        "将手机 ACK 与真实 DAYU/ESP32 串成一条公网闭环，保存所有层级证据。",
        "完成 DAYU 摄像头枚举、预览和抓拍，再迁移 YOLO Pose 到 RKNN/NPU。",
        "补齐厨房和卧室传感器，完成真实并发多房间演示。",
        "取得 GPS FIX，确定 YED 安全服务器路线并验证 Wi-Fi/4G 切换。",
        "最后实现语音交流或自动电话方案，并做整套回归和演示录制。",
    ])

    add_heading(doc, "最终验收应看到什么", 1)
    acceptance_rows = [
        ["手机端", "真实手机登录后能看到各房间在线状态、告警与相对时间；ACK 后最终显示实体设备 ACKED"],
        ["边缘端", "DAYU 重启后自动校时并自启动服务；摄像头、语音和传感器异常不阻断主告警链路"],
        ["房间节点", "客厅、卫生间、厨房、卧室按实际硬件同时在线；每个告警能定位到正确 deviceId 和 room"],
        ["云端", "HTTPS、OneNET、后端和命令同步器长期运行，凭据不出现在源码、日志和小程序"],
        ["视觉", "跌倒、坐下、弯腰、躺床、遮挡和无人场景有数据集及误报、漏报记录"],
        ["备链", "断开 Wi-Fi 后 4G 接管，恢复 Wi-Fi 后不产生重复告警；GPS 只上报经过授权的有效定位"],
        ["应急", "声光提醒可听可见；电话能力的触发主体、号码、确认回执和失败处理均有明确记录"],
    ]
    add_table(doc, ["验收层", "必须满足"], acceptance_rows, [3.2, 13.6])

    add_heading(doc, "编制依据", 1)
    add_para(doc, "本状态基线以工程中的 VALIDATION-MATRIX.md、AI-COLLAB.md、HANDOFF.md、HARDWARE-MAP.md 以及 2026年10月11日 YED 真机证据为准。旧报告中的冲突结论不作为当前完成状态。", size=9.5, color=MID_GRAY)
    doc.save(path)


def build_requirements_document(path):
    doc = setup_document(
        "硬件 服务与采购准备清单",
        "独居老人居家安全监测与应急辅助系统  |  采购与接线基线 " + TODAY,
    )
    doc.core_properties.title = "硬件 服务与采购准备清单"
    doc.core_properties.subject = "独居老人居家安全监测与应急辅助系统采购与接线基线"
    doc.core_properties.author = "独居老人居家安全监测与应急辅助系统项目组"

    add_heading(doc, "使用说明", 1)
    add_para(
        doc,
        "这份清单用于把当前原型补成可演示、可验收的多房间系统。清单优先利用现有 DAYU200、两块 ESP32-S3 和 YED 4G/GPS 模块，只采购形成闭环所必需的传感器、电源、接口保护件和服务。涉及燃气、烟雾和阀门的设备必须区分“比赛演示模块”与“生命安全设备”。",
    )
    add_para(
        doc,
        "重要安全原则：MQ-2、MQ-5、火焰模块等开发板传感器只能用于算法开发和趋势演示，不能替代通过国家标准认证的独立式烟雾报警器或可燃气体报警器。燃气切断阀、强电和固定安装由具备资质的人员实施，ESP32 不得直接驱动市电或燃气阀。",
        bold_lead="重要安全原则：",
    )

    add_heading(doc, "已经具备的核心设备", 1)
    existing_rows = [
        ["DAYU200", "1 块", "家庭边缘主控、OpenHarmony APP、摄像头和本地语音入口", "用户确认板上有摄像头；仍需真机枚举、预览和抓帧"],
        ["ESP32-S3", "2 块", "房间无线传感节点", "可同时代表两个实体房间；不足以同时覆盖卫生间、厨房和卧室三个节点"],
        ["YED-M100MG-B1", "1 套", "4G 数据备链与 GNSS", "4G 注册和信号通过；GPS 尚无 FIX；服务器安全连接待定"],
        ["OneNET 产品与设备", "已创建", "设备管理、属性和事件上云", "已有一次真实 MQTTS 上报；尚未常驻运行"],
        ["PC 开发环境", "1 套", "构建、烧录、Bridge、Broker、测试和取证", "最终演示应减少对 PC 临时转发的依赖"],
    ]
    add_table(doc, ["已有项", "数量", "用途", "当前边界"], existing_rows, [3.2, 2.0, 5.3, 6.3], center_cols=(1,))

    add_heading(doc, "必须先确认的现有配件", 1)
    confirm_rows = [
        ["DAYU 摄像头模组和排线", "确认摄像头已装好、排线方向正确、镜头可用；先做系统枚举，暂不重复购买"],
        ["DAYU 麦克风和扬声器", "确认板载音频是否完整、音量是否够；实测前不盲目购买 USB 音频设备"],
        ["YED LTE 天线", "4G 已注册，说明当前链路基本可用；检查接头和固定方式"],
        ["YED GNSS 天线", "确认是否为有源天线、接口和供电匹配；NO_FIX 时先室外朝上测试"],
        ["YED 电源", "资料要求 5 至 12 V、约 10 W 供电能力；不要默认由 USB TTL 供电"],
        ["SIM 卡套餐", "确认具备数据流量、无 APN 限制、长期在线资费可接受；不要把账户或号码写入文档和日志"],
    ]
    add_table(doc, ["配件", "确认内容"], confirm_rows, [4.3, 12.5])

    add_heading(doc, "第一优先级采购清单", 1)
    p0_rows = [
        ["增加 1 块同型号 ESP32-S3", "1", "让卫生间、厨房、卧室三个房间可以同时各有一个实体节点", "同现有板卡、USB 线和烧录方式一致"],
        ["独立式光电感烟火灾探测报警器", "1", "厨房或邻近区域烟雾报警", "优先选带继电器或干接点输出、符合现行国家标准的产品"],
        ["可燃气体探测报警器", "1", "燃气泄漏报警", "必须按家中气源选择天然气或液化气型号；优先干接点输出和认证产品"],
        ["隔离式干接点输入模块", "2", "把烟雾和燃气报警器的继电器信号安全送入 ESP32", "3.3 V 逻辑兼容，带光耦或明确隔离；禁止把 12 V 直接接 GPIO"],
        ["人体存在传感器", "2", "卫生间和卧室活动检测", "首版可用 PIR；需要静止存在检测时选择 24 GHz 毫米波模块"],
        ["门磁传感器", "2", "卫生间门和入户或卧室门状态", "常开或常闭定义必须在软件中记录，线缆要防拉脱"],
        ["床垫压力或离床传感垫", "1", "卧室在床、离床和夜间异常检测", "优先数字开关或干接点输出，避免未经标定的裸压力片"],
        ["防水紧急求助按钮", "2", "卫生间和卧室手动 SOS", "低压、干接点、明显且便于老人触及；卫生间需防潮"],
        ["有源蜂鸣器或声光报警器", "2", "厨房和卫生间本地提醒", "3.3/5 V 小功率可用驱动管；大功率设备用隔离继电器和独立电源"],
        ["漏水传感器", "1", "卫生间地面积水检测", "低压探头，便于更换；与烟雾或燃气告警使用不同 alarm type"],
        ["接线与保护套件", "1 套", "完成可靠接线和现场维护", "面包板或洞洞板、杜邦线、端子台、保险丝、热缩管、扎带、万用表"],
        ["独立稳压电源", "按设备", "为 ESP32、YED 和 12 V 报警设备供电", "按铭牌选型并留 30% 余量；不同电压分开，公共地只在设计允许时连接"],
    ]
    add_table(doc, ["物品", "建议数量", "用途", "选型要点"], p0_rows, [4.2, 2.0, 4.6, 6.0], center_cols=(1,))

    add_heading(doc, "为什么烟雾和燃气要买两类设备", 1)
    add_para(doc, "烟雾报警器检测燃烧产生的烟雾；可燃气体报警器检测天然气、液化气等泄漏。二者检测对象、安装位置和响应机制不同，不能互相替代。厨房油烟还可能造成误报，因此烟雾报警器的安装位置应按产品说明和现场条件确定。")
    add_para(doc, "比赛演示可以额外接 MQ 系列模块显示模拟浓度曲线，但真正的安全告警应以认证报警器自身的声响和干接点为基础。系统读取干接点只是增加远程通知，不能成为唯一报警手段。")

    add_heading(doc, "按房间配置", 1)
    room_rows = [
        ["客厅", "DAYU200、板载摄像头、麦克风、扬声器、SOS", "现场跌倒检测、主控汇聚、语音提醒、手机状态来源", "摄像头权限与隐私开关；不要让客厅画面替代其他房间证据"],
        ["卫生间", "ESP32、人体存在、门磁、防水 SOS、漏水、蜂鸣器", "长时间无活动、门状态、摔倒后主动求助、积水风险", "优先低压和防潮；摄像头通常不建议放在卫生间"],
        ["厨房", "ESP32、认证烟雾报警器、对应气源的燃气报警器、温度、蜂鸣器", "烟雾、燃气、异常温升和本地声光提醒", "燃气报警器安装高度随气体密度而异，按说明书和专业意见安装"],
        ["卧室", "ESP32、人体存在、床垫压力、门磁、SOS、夜灯或蜂鸣器", "在床、离床、夜间活动、长时间无活动和主动求助", "毫米波比 PIR 更适合静止存在，但必须现场调整灵敏度和区域"],
    ]
    add_table(doc, ["区域", "建议设备", "主要检测", "注意事项"], room_rows, [2.3, 5.1, 4.6, 4.8])

    add_heading(doc, "第二优先级增强项", 1)
    p1_rows = [
        ["SHT30 或 DHT22 温湿度", "厨房或卧室环境趋势；SHT30 稳定性通常更好"],
        ["DS18B20 温度探头", "厨房局部温升或设备表面温度实验，注意探头安装位置"],
        ["24 GHz 毫米波存在模块", "提升卧室静止存在和卫生间长时间停留检测；需做区域和串扰标定"],
        ["摄像头固定支架和隐私遮挡片", "固定 DAYU 视角，支持明确的物理隐私状态"],
        ["补光灯或均匀照明", "提高 YOLO Pose 在夜间和逆光下的关键点质量；避免直射镜头"],
        ["备用 GNSS 有源天线和延长线", "仅在确认当前接口和供电方式后购买，用于室外定位测试"],
        ["小型 UPS 或后备电源", "支持短时断电继续告警；必须评估电池、充电和消防安全"],
        ["网络路由器或独立 2.4 GHz AP", "提供稳定 Wi-Fi，避免依赖临时手机热点"],
    ]
    add_table(doc, ["增强项", "用途与条件"], p1_rows, [5.0, 11.8])

    add_heading(doc, "只适合演示或实验的器件", 1)
    demo_rows = [
        ["MQ-2 或 MQ-5 模块", "演示气体或烟雾趋势、测试 ADC 与阈值", "需要预热和标定，选择性差，不能作为唯一家庭报警器"],
        ["红外火焰传感器", "近距离明火实验", "易受阳光和反射干扰，不能替代烟雾或燃气报警器"],
        ["普通光敏模块", "环境亮度或夜间模式", "不用于判断老人是否在房间"],
        ["裸压力传感片", "床垫压力算法实验", "机械结构和阈值漂移较大，正式演示优先成品压力垫或干接点"],
    ]
    add_table(doc, ["器件", "可用场景", "禁止外推"], demo_rows, [4.2, 5.3, 7.3])

    add_heading(doc, "语音 电话和联网所需资源", 1)
    service_rows = [
        ["公网云服务器", "必需", "运行 HTTPS 后端、家庭网关或可信中继", "固定公网地址或域名、Linux、Node.js 运行环境、持久化磁盘和备份"],
        ["域名与 HTTPS 证书", "必需", "微信小程序合法域名和 API 加密", "完成备案或平台要求；证书自动续期"],
        ["微信小程序 AppID", "必需", "开发者工具和手机预览、正式登录", "AppSecret 只放服务端 Secret，不进小程序源码"],
        ["OneNET 设备凭据", "已有但需安全管理", "常驻网关连接 OneNET", "运行时注入，不写文档、源码或日志"],
        ["云呼叫服务", "自动电话时必需", "告警后由平台外呼联系人", "需要实名认证、模板审核、号码和费用；先确认比赛是否允许"],
        ["VoLTE 音频模块", "云呼叫替代方案", "设备直接语音通话", "必须明确支持 VoLTE、麦克风、扬声器和音频接口；当前 YED 不能据现有资料承担此功能"],
        ["ASR 与 TTS 服务或本地模型", "双向语音时需要", "老人语音识别、播报和简单问答", "明确离线或在线路线、延迟、隐私、费用和断网降级"],
    ]
    add_table(doc, ["资源", "必要性", "用途", "选型条件"], service_rows, [3.7, 2.6, 4.5, 6.0], center_cols=(1,))

    add_heading(doc, "4G 与 GPS 的补齐项", 1)
    add_bullets(doc, [
        "把 GNSS 天线朝上放到室外空旷区域至少 60 秒，先确认模块能从 NO_FIX 变为 FIXED，再决定是否购买新天线。",
        "向厂家确认 Y100E 固件是否支持强制验证服务器证书；未确认前不得用明文 1883 或关闭证书校验连接 OneNET。",
        "如果模块不能安全直连 OneNET，准备一个可信公网中继，由中继再使用现有 MQTTS 连接 OneNET。",
        "完成 Wi-Fi 断开、4G 接管、Wi-Fi 恢复和告警去重测试。",
        "精确家庭坐标不写入普通日志；上传位置必须包含 valid 和 fixTime，NO_FIX 不能伪装为 0,0。",
    ])

    add_heading(doc, "不建议现在购买", 1)
    no_buy_rows = [
        ["不明接口的摄像头", "DAYU 已有摄像头，先枚举现有模组；ESP32 相机还与 GPIO4/5/6 冲突"],
        ["只写 5 V TTL 的传感器直接接 ESP32", "ESP32 GPIO 为 3.3 V，必须确认输出电平或加分压、光耦、转换器"],
        ["普通继电器直接控制燃气阀", "燃气阀需要合规电源、失效状态和专业安装，不能只看继电器能否吸合"],
        ["没有音频接口证明的 4G 模块用于打电话", "支持数据或短信不等于支持 VoLTE 语音"],
        ["大量同类开发传感器", "先各买一套完成接口、阈值和误报验证，再决定批量"],
    ]
    add_table(doc, ["物品", "原因"], no_buy_rows, [5.6, 11.2])

    add_heading(doc, "建议采购批次", 1)
    batch_rows = [
        ["第一批 立即采购", "第 3 块 ESP32、认证烟雾报警器、对应气源燃气报警器、2 个隔离输入模块、人体存在、门磁、压力垫、SOS、漏水、蜂鸣器、接线与电源", "形成卫生间、厨房、卧室三个实体节点"],
        ["第二批 摄像头验收后", "支架、隐私遮挡片、补光；必要时才采购兼容摄像头或外部音频", "避免重复购买不兼容模组"],
        ["第三批 公网方案确定后", "云服务器、域名、证书、云呼叫或 VoLTE 模块", "先确定小程序和电话路线再付费"],
        ["第四批 可靠性增强", "UPS、外壳、端子、备件、独立 AP", "用于持续运行和最终演示稳定性"],
    ]
    add_table(doc, ["批次", "内容", "目标"], batch_rows, [3.4, 8.6, 4.8])

    add_heading(doc, "到货验收清单", 1)
    add_numbered(doc, [
        "拍摄包装、型号、供电、电平、接口和认证标识，不记录 SIM 号码、IMEI 或设备密钥。",
        "先用万用表确认电源和输出电平，再连接 ESP32；任何高于 3.3 V 的信号先隔离或转换。",
        "每个传感器单独运行至少 30 分钟，记录正常、触发、恢复、断线和上电默认状态。",
        "给每个节点分配唯一 deviceId、room 和传感器清单，禁止一块板同时伪装多个在线房间。",
        "烟雾和燃气测试使用安全、可控的方法，遵守厂家说明；不得在室内制造危险浓度或真实火焰。",
        "完成单节点后再接入 Bridge、OneNET 和小程序，保存从传感器触发到 ACKED 的完整时间线。",
    ])

    add_heading(doc, "采购完成的判定", 1)
    add_para(doc, "采购不是以“买到器件”为完成，而是以“型号核对、供电安全、单件测试、接入代码、房间级告警、手机查看和回执闭环”全部通过为完成。任何尚未接线或只在模拟器中出现的设备，都不得写成实体系统已经具备。")

    add_heading(doc, "编制依据", 1)
    add_para(doc, "本清单依据当前 HARDWARE-MAP.md、ARCHITECTURE.md、VALIDATION-MATRIX.md 和 YED-M100MG-B1 真机状态编制。具体购买前仍应核对现场使用的燃气类型、报警器认证、DAYU 摄像头枚举结果、供电铭牌和各模块电平。", size=9.5, color=MID_GRAY)
    doc.save(path)


def main():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    progress_path = OUTPUT_DIR / "独居老人居家安全监测与应急辅助系统_当前进度与未完成事项_2026-10-12.docx"
    requirements_path = OUTPUT_DIR / "独居老人居家安全监测与应急辅助系统_硬件与服务需求清单_2026-10-12.docx"
    build_progress_document(progress_path)
    build_requirements_document(requirements_path)
    print(progress_path)
    print(requirements_path)


if __name__ == "__main__":
    main()
