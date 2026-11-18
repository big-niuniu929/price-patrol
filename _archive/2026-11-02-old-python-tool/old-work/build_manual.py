from pathlib import Path

from docx import Document
from docx.enum.section import WD_SECTION
from docx.enum.table import WD_CELL_VERTICAL_ALIGNMENT, WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Inches, Pt, RGBColor


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "市占率报表加工程序使用说明书.docx"
SCREENSHOT = ROOT / "work" / "ui-batch.png"


def set_cell_shading(cell, fill):
    tc_pr = cell._tc.get_or_add_tcPr()
    shd = tc_pr.find(qn("w:shd"))
    if shd is None:
        shd = OxmlElement("w:shd")
        tc_pr.append(shd)
    shd.set(qn("w:fill"), fill)


def set_cell_border(cell, color="D9D9D9", size="6"):
    tc = cell._tc
    tc_pr = tc.get_or_add_tcPr()
    borders = tc_pr.first_child_found_in("w:tcBorders")
    if borders is None:
        borders = OxmlElement("w:tcBorders")
        tc_pr.append(borders)
    for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
        tag = "w:" + edge
        element = borders.find(qn(tag))
        if element is None:
            element = OxmlElement(tag)
            borders.append(element)
        element.set(qn("w:val"), "single")
        element.set(qn("w:sz"), size)
        element.set(qn("w:space"), "0")
        element.set(qn("w:color"), color)


def set_cell_margins(cell, top=90, start=120, bottom=90, end=120):
    tc = cell._tc
    tc_pr = tc.get_or_add_tcPr()
    margins = tc_pr.first_child_found_in("w:tcMar")
    if margins is None:
        margins = OxmlElement("w:tcMar")
        tc_pr.append(margins)
    for margin, value in (("top", top), ("start", start), ("bottom", bottom), ("end", end)):
        node = margins.find(qn("w:" + margin))
        if node is None:
            node = OxmlElement("w:" + margin)
            margins.append(node)
        node.set(qn("w:w"), str(value))
        node.set(qn("w:type"), "dxa")


def set_run_font(run, name="Microsoft YaHei", size=None, bold=None, color=None):
    run.font.name = name
    run._element.get_or_add_rPr().rFonts.set(qn("w:eastAsia"), name)
    run._element.get_or_add_rPr().rFonts.set(qn("w:ascii"), name)
    run._element.get_or_add_rPr().rFonts.set(qn("w:hAnsi"), name)
    if size:
        run.font.size = Pt(size)
    if bold is not None:
        run.bold = bold
    if color:
        run.font.color.rgb = RGBColor.from_string(color)


def style_paragraph(paragraph, space_after=6, line=1.25):
    fmt = paragraph.paragraph_format
    fmt.space_after = Pt(space_after)
    fmt.line_spacing = line


def add_text(doc, text, style=None, bold_lead=None):
    p = doc.add_paragraph(style=style)
    style_paragraph(p)
    if bold_lead and text.startswith(bold_lead):
        lead = p.add_run(bold_lead)
        set_run_font(lead, bold=True)
        rest = p.add_run(text[len(bold_lead):])
        set_run_font(rest)
    else:
        r = p.add_run(text)
        set_run_font(r)
    return p


def add_bullets(doc, items):
    for item in items:
        p = doc.add_paragraph(style="List Bullet")
        style_paragraph(p, space_after=3)
        r = p.add_run(item)
        set_run_font(r)


def add_numbered(doc, items):
    for item in items:
        p = doc.add_paragraph(style="List Number")
        style_paragraph(p, space_after=4)
        r = p.add_run(item)
        set_run_font(r)


def add_table(doc, headers, rows, widths=None):
    table = doc.add_table(rows=1, cols=len(headers))
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    table.autofit = False
    for idx, header in enumerate(headers):
        cell = table.rows[0].cells[idx]
        cell.text = ""
        p = cell.paragraphs[0]
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        r = p.add_run(header)
        set_run_font(r, size=9.5, bold=True, color="FFFFFF")
        set_cell_shading(cell, "1F4E78")
        set_cell_border(cell)
        set_cell_margins(cell)
        cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
    tr_pr = table.rows[0]._tr.get_or_add_trPr()
    tbl_header = OxmlElement("w:tblHeader")
    tbl_header.set(qn("w:val"), "true")
    tr_pr.append(tbl_header)
    for row_index, row in enumerate(rows):
        cells = table.add_row().cells
        for idx, value in enumerate(row):
            cell = cells[idx]
            cell.text = ""
            p = cell.paragraphs[0]
            style_paragraph(p, space_after=0, line=1.1)
            r = p.add_run(str(value))
            set_run_font(r, size=9.2)
            if idx == 0 and len(row) <= 3:
                p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            set_cell_shading(cell, "F3F6FA" if row_index % 2 else "FFFFFF")
            set_cell_border(cell)
            set_cell_margins(cell)
            cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
    if widths:
        for row in table.rows:
            for cell, width in zip(row.cells, widths):
                cell.width = Cm(width)
    doc.add_paragraph().paragraph_format.space_after = Pt(2)
    return table


def add_heading(doc, text, level=1):
    p = doc.add_heading(text, level=level)
    p.paragraph_format.keep_with_next = True
    style_paragraph(p, space_after=8 if level == 1 else 5, line=1.1)
    for r in p.runs:
        set_run_font(r, size=16 if level == 1 else 12.5, bold=True, color="000000")
    return p


def add_page_number(paragraph):
    paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = paragraph.add_run("第 ")
    set_run_font(run, size=9, color="666666")
    fld_char1 = OxmlElement("w:fldChar")
    fld_char1.set(qn("w:fldCharType"), "begin")
    instr = OxmlElement("w:instrText")
    instr.set(qn("xml:space"), "preserve")
    instr.text = "PAGE"
    fld_char2 = OxmlElement("w:fldChar")
    fld_char2.set(qn("w:fldCharType"), "end")
    run._r.append(fld_char1)
    run._r.append(instr)
    run._r.append(fld_char2)
    tail = paragraph.add_run(" 页")
    set_run_font(tail, size=9, color="666666")


def build():
    doc = Document()
    section = doc.sections[0]
    section.top_margin = Cm(2.0)
    section.bottom_margin = Cm(1.8)
    section.left_margin = Cm(2.1)
    section.right_margin = Cm(2.1)

    normal = doc.styles["Normal"]
    normal.font.name = "Microsoft YaHei"
    normal._element.rPr.rFonts.set(qn("w:eastAsia"), "Microsoft YaHei")
    normal.font.size = Pt(10.5)
    for style_name in ("Title", "Heading 1", "Heading 2", "List Bullet", "List Number"):
        style = doc.styles[style_name]
        style.font.name = "Microsoft YaHei"
        style._element.rPr.rFonts.set(qn("w:eastAsia"), "Microsoft YaHei")

    footer = section.footer
    add_page_number(footer.paragraphs[0])

    # Cover
    p = doc.add_paragraph(style="Title")
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.space_before = Pt(92)
    p.paragraph_format.space_after = Pt(18)
    r = p.add_run("市占率报表加工程序")
    set_run_font(r, size=27, bold=True, color="000000")
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    r = p.add_run("使用说明书")
    set_run_font(r, size=18, bold=True, color="1F4E78")
    p.paragraph_format.space_after = Pt(28)
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    r = p.add_run("用于平台榜单匹配、匹配库维护、多店铺处理和统计结果导出")
    set_run_font(r, size=11, color="555555")
    p.paragraph_format.space_after = Pt(70)
    if SCREENSHOT.exists():
        p = doc.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        picture_run = p.add_run()
        picture_run.add_picture(str(SCREENSHOT), width=Inches(5.9))
        drawing = picture_run._r.drawing_lst[-1]
        doc_pr = drawing.find(".//" + qn("wp:docPr"))
        if doc_pr is not None:
            doc_pr.set("descr", "市占率报表加工程序工作台界面截图")
            doc_pr.set("title", "工作台界面")
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    r = p.add_run("版本：第一阶段 · 2026年10月")
    set_run_font(r, size=10, color="777777")
    doc.add_page_break()

    add_heading(doc, "一 软件概述", 1)
    add_text(doc, "本软件用于处理电商平台平台导出的商品榜单数据。程序以 SKU 作为唯一匹配键，从匹配库中补齐商品的尺寸段和价格段，并根据榜单中的成交金额区间计算成交金额中位值。处理完成后，程序可以保存匹配库、导出配对明细，并生成按店铺或品类汇总的品牌销售金额和占比结果。")
    add_text(doc, "程序采用本地服务和浏览器界面运行。用户在 Windows 上可以双击启动文件，程序会自动打开 Edge 应用窗口。匹配库同时保存在软件内部，便于后续迁移到飞书或其他多人协作环境。")
    add_heading(doc, "适用人员", 2)
    add_bullets(doc, ["负责月度店铺市占率数据整理的同事。", "需要维护 SKU、尺寸段和价格段对应关系的同事。", "需要输出配对明细和品牌销售占比结果的同事。"])
    add_heading(doc, "开始前准备", 2)
    add_bullets(doc, ["准备电商平台平台导出的榜单 Excel 文件，文件格式为 .xlsx。", "首次使用或需要更新匹配库时，准备已有的匹配库 Excel 文件。", "确认榜单中的商品编号、商品名称、品牌名称和成交金额列存在。"])

    add_heading(doc, "二 启动软件", 1)
    add_numbered(doc, [
        "打开软件文件夹：~/Desktop/2026-10-10\\xv-a。",
        "双击 start_app.bat。",
        "等待 Edge 应用窗口自动打开。首次使用时，如果匹配库页面为空，先在匹配库页面导入匹配库 Excel。",
        "关闭软件时直接关闭 Edge 应用窗口即可。"
    ])
    add_text(doc, "如果双击后没有打开窗口，可以右键 start_app.bat，选择“以 PowerShell 运行”，查看启动提示。软件需要 Python 3 和 openpyxl 依赖；正常使用时启动脚本会自动检查项目依赖。", bold_lead="提示：")
    add_heading(doc, "LibreOffice 的作用", 2)
    add_text(doc, "LibreOffice 是一套办公软件。在本项目中，它只用于开发人员把 Word 说明书转换成 PDF 或页面图片，检查分页、表格和中文显示是否正常。普通同事使用市占率报表加工程序时，不需要安装或启动 LibreOffice；程序的 Excel 读取、匹配、写回、导出和 Edge 界面运行都不依赖 LibreOffice。")

    add_heading(doc, "三 页面说明", 1)
    add_table(doc, ["页面", "主要用途", "常用操作"], [
        ["工作台", "完成榜单导入、店铺匹配、SKU 分析、编辑和导出", "添加报表、分析匹配、编辑 SKU、写回并导出"],
        ["匹配库", "维护软件内部保存的店铺和 SKU 对应关系", "合并导入、覆盖导入、导出匹配库"],
        ["统计结果", "查看当前已分析数据的品牌销售金额和占比", "查看品牌排名和占比，最终结果随导出文件保存"],
    ], widths=[2.2, 7.0, 7.0])
    add_text(doc, "工作台中的“配对明细”表默认显示当前选中的报表。批量导入多个报表后，可以在数据源区域点击报表名称切换查看对象。")

    add_heading(doc, "四 维护匹配库", 1)
    add_text(doc, "匹配库是程序进行 SKU 配对的基础数据。软件内部匹配库保存在 data\\match_library.json 中，普通使用者不需要直接打开或修改这个文件，应通过“匹配库”页面操作。")
    add_heading(doc, "首次导入匹配库", 2)
    add_numbered(doc, ["进入“匹配库”页面。", "点击“导入并覆盖”，选择现有匹配库 Excel。", "确认页面显示店铺工作表和 SKU 数量。"])
    add_text(doc, "覆盖导入适合首次建立内部库，或确认外部 Excel 是完整版本时使用。")
    add_heading(doc, "补充新的匹配库数据", 2)
    add_numbered(doc, ["点击“导入并合并”。", "选择包含新店铺或新增 SKU 的 Excel。", "程序按店铺名称和 SKU 合并数据。已有 SKU 会以本次导入的尺寸段和价格段为准。", "返回工作台重新分析报表。"])
    add_heading(doc, "导出匹配库", 2)
    add_text(doc, "在匹配库页面点击“导出匹配库”，程序会生成一个新的 Excel 文件。导出的文件可作为备份、交接材料或下一次导入的基础文件。")

    add_heading(doc, "五 处理一个或多个店铺报表", 1)
    add_numbered(doc, [
        "进入工作台，点击“选择榜单文件”或数据源区域的“添加”。",
        "在文件选择窗口中选择一个或多个平台榜单 Excel。",
        "在报表列表中检查每个文件对应的店铺。程序会根据文件名关键字给出自动建议，也可以使用下拉框手动选择。",
        "确认本次处理店铺和每个报表的店铺对应关系后，点击“分析匹配”。",
        "查看配对明细和待补充 SKU 数量。"
    ])
    add_text(doc, "一次导入多个报表时，每个报表都会生成自己的配对明细页；统计结果会按对应店铺或品类合并汇总。")
    add_heading(doc, "店铺匹配方式", 2)
    add_table(doc, ["方式", "说明"], [
        ["自动建议", "程序从报表文件名中查找与匹配库店铺名称相同或相近的关键字。"],
        ["手动选择", "在报表列表中打开店铺下拉框，选择正确的匹配库工作表。"],
        ["检查原则", "自动建议只作为提示，正式分析前应确认每个报表的店铺都正确。"],
    ], widths=[3.0, 13.2])

    add_heading(doc, "六 补充新 SKU", 1)
    add_text(doc, "当榜单中出现匹配库没有记录的 SKU，或匹配记录缺少尺寸段、价格段时，配对明细会显示“待补充”。")
    add_numbered(doc, [
        "在配对明细中单击需要处理的行。",
        "点击“编辑选中 SKU”，或直接双击该行。",
        "在尺寸段和价格段输入框中点击选择已有值，也可以直接输入自定义值。",
        "点击“保存这条记录”。此时修改暂存在当前处理结果中。",
        "确认修改无误后，点击“写回匹配库并导出”。"
    ])
    add_text(doc, "只修改一条 SKU 也可以写回，不需要先补完全部待补充记录。未补充的记录会保留为空，并在导出提示中显示待补充数量。")
    add_text(doc, "尺寸段和价格段的候选值来自当前内置匹配库中已有的值。输入新的值并保存后，该值会成为后续可选择的候选项。", bold_lead="候选值：")

    add_heading(doc, "七 保存和导出结果", 1)
    add_text(doc, "点击“写回匹配库并导出”后，程序会先保存内置匹配库，再根据当前报表生成结果文件。如果本次处理之前导入过桌面匹配库，程序还会同步写回该 Excel，并在写回前生成带时间戳的备份。")
    add_table(doc, ["输出内容", "说明"], [
        ["统计结果", "按店铺或品类列出品牌销售金额和占比。"],
        ["配对明细页", "包含商品编号、商品名称、品牌名称、尺寸段、价格段和成交金额。"],
        ["成交金额", "从榜单“成交金额”区间取两个边界值的平均值。例如 200万至400万得到300。"],
        ["匹配库备份", "同步写回桌面 Excel 时生成，避免直接覆盖后无法恢复。"],
    ], widths=[3.2, 13.0])
    add_text(doc, "导出文件默认保存在榜单文件所在文件夹，文件名以“市占率配对与统计结果”开头。内置匹配库导出文件保存在软件目录的 outputs 文件夹。")

    add_heading(doc, "八 数据安全和协作建议", 1)
    add_bullets(doc, ["每月处理前先备份内置匹配库或导出一份匹配库 Excel。", "多人使用时建议由一人负责维护匹配库，其他人使用导出的结果文件。", "不要直接删除 data\\match_library.json；如果需要更换完整库，使用匹配库页面的“覆盖导入”。", "软件当前是本地版本。后续迁移到飞书时，内置匹配库可以迁移为飞书多维表格或云端数据库，用户操作流程可以继续沿用。"])

    add_heading(doc, "九 常见问题", 1)
    add_heading(doc, "双击启动文件后没有窗口", 2)
    add_text(doc, "确认 Python 3 已安装，并重新双击 start_app.bat。如果窗口一闪而过，使用 PowerShell 运行 start.ps1，查看具体提示。")
    add_heading(doc, "为什么有些 SKU 显示待补充", 2)
    add_text(doc, "通常是匹配库中没有该 SKU，或者该 SKU 的尺寸段、价格段为空。通过编辑选中 SKU 补充后即可保存。")
    add_heading(doc, "修改后桌面匹配库没有变化", 2)
    add_text(doc, "需要点击“写回匹配库并导出”完成保存。只点击“保存这条记录”时，修改只保存在当前处理状态中。只有本次处理导入过桌面匹配库文件时，程序才会同步写回该文件；仅使用内置库时，修改会保存到软件内部。")
    add_heading(doc, "统计结果和人工统计不一致", 2)
    add_text(doc, "先检查报表店铺是否绑定正确，再检查成交金额区间是否符合当前月份的统计口径。程序当前按成交金额区间的两个边界值取平均，历史数据和人工修正口径接入后还需要统一规则。")
    add_heading(doc, "十 当前版本范围", 1)
    add_text(doc, "当前版本已经覆盖匹配库维护、单店铺和多店铺榜单处理、SKU 补录、配对表导出和当前月统计结果导出。历史月份趋势图和市占率趋势看板将在历史数据补齐并确认统计口径后继续开发。")

    doc.core_properties.title = "市占率报表加工程序使用说明书"
    doc.core_properties.subject = "软件操作说明"
    doc.core_properties.author = ""
    doc.save(OUT)
    print(OUT)


if __name__ == "__main__":
    build()
