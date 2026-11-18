from pathlib import Path

from docx import Document
from docx.enum.table import WD_CELL_VERTICAL_ALIGNMENT, WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor


ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = Path(r"~/Desktop/市占率报表加工程序_比赛文案")


def font(run, size=10.5, bold=False, color="222222"):
    run.font.name = "Microsoft YaHei"
    run._element.get_or_add_rPr().rFonts.set(qn("w:eastAsia"), "Microsoft YaHei")
    run._element.get_or_add_rPr().rFonts.set(qn("w:ascii"), "Microsoft YaHei")
    run._element.get_or_add_rPr().rFonts.set(qn("w:hAnsi"), "Microsoft YaHei")
    run.font.size = Pt(size)
    run.bold = bold
    run.font.color.rgb = RGBColor.from_string(color)


def ptext(doc, text="", size=10.5, bold=False, color="222222", align=None, after=6):
    p = doc.add_paragraph()
    if align is not None:
        p.alignment = align
    p.paragraph_format.space_after = Pt(after)
    p.paragraph_format.line_spacing = 1.25
    font(p.add_run(text), size, bold, color)
    return p


def heading(doc, text, level=1):
    p = doc.add_heading(text, level=level)
    p.paragraph_format.keep_with_next = True
    p.paragraph_format.space_before = Pt(10 if level == 1 else 6)
    p.paragraph_format.space_after = Pt(5)
    for r in p.runs:
        font(r, 15 if level == 1 else 12, True, "1F4E78")
    return p


def shade(cell, fill):
    tc_pr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:fill"), fill)
    tc_pr.append(shd)


def borders(cell, color="D9E2F3"):
    tc_pr = cell._tc.get_or_add_tcPr()
    b = OxmlElement("w:tcBorders")
    for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
        e = OxmlElement("w:" + edge)
        e.set(qn("w:val"), "single")
        e.set(qn("w:sz"), "6")
        e.set(qn("w:color"), color)
        b.append(e)
    tc_pr.append(b)


def margins(cell, value=100):
    tc_pr = cell._tc.get_or_add_tcPr()
    m = OxmlElement("w:tcMar")
    for edge in ("top", "start", "bottom", "end"):
        e = OxmlElement("w:" + edge)
        e.set(qn("w:w"), str(value))
        e.set(qn("w:type"), "dxa")
        m.append(e)
    tc_pr.append(m)


def table(doc, headers, rows, widths=None, font_size=9.5):
    t = doc.add_table(rows=1, cols=len(headers))
    t.alignment = WD_TABLE_ALIGNMENT.CENTER
    t.autofit = False
    tr_pr = t.rows[0]._tr.get_or_add_trPr()
    header_flag = OxmlElement("w:tblHeader")
    header_flag.set(qn("w:val"), "true")
    tr_pr.append(header_flag)
    for i, value in enumerate(headers):
        c = t.rows[0].cells[i]
        c.text = ""
        p = c.paragraphs[0]
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        font(p.add_run(value), font_size, True, "FFFFFF")
        shade(c, "1F4E78")
        borders(c)
        margins(c)
        c.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
    for ri, row in enumerate(rows):
        cells = t.add_row().cells
        for i, value in enumerate(row):
            c = cells[i]
            c.text = ""
            p = c.paragraphs[0]
            p.paragraph_format.space_after = Pt(0)
            p.paragraph_format.line_spacing = 1.15
            font(p.add_run(str(value)), font_size)
            shade(c, "F5F8FC" if ri % 2 else "FFFFFF")
            borders(c)
            margins(c)
            c.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
    if widths:
        for row in t.rows:
            for c, w in zip(row.cells, widths):
                c.width = Cm(w)
    doc.add_paragraph().paragraph_format.space_after = Pt(2)
    return t


def setup(doc, title, subtitle):
    section = doc.sections[0]
    section.top_margin = Cm(1.8)
    section.bottom_margin = Cm(1.7)
    section.left_margin = Cm(2.0)
    section.right_margin = Cm(2.0)
    normal = doc.styles["Normal"]
    normal.font.name = "Microsoft YaHei"
    normal._element.rPr.rFonts.set(qn("w:eastAsia"), "Microsoft YaHei")
    normal.font.size = Pt(10.5)
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.space_before = Pt(20)
    p.paragraph_format.space_after = Pt(8)
    font(p.add_run(title), 21, True, "1F4E78")
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.space_after = Pt(18)
    font(p.add_run(subtitle), 10.5, False, "666666")


def competition_doc():
    doc = Document()
    setup(doc, "市占率数据加工小程序 作品说明文案", "AI Maker 智造大赛填写稿 · 根据当前程序真实功能整理")
    ptext(doc, "使用方式：以下内容对应比赛作品信息页面的“作品简介、实现方案、创新点、落地阶段、效率效益产出、补充说明”栏目。作品简介控制在 500 字以内，其余段落可按页面需要直接复制或再做少量删减。", 10, False, "666666")

    heading(doc, "一 作品简介", 1)
    ptext(doc, "本作品是一款面向电商平台商智商品榜单的市占率数据加工小程序，主要服务于负责月度数据整理的运营同事。每月从电商平台商智导出榜单后，程序可以读取一个或多个报表，按商品 SKU 自动匹配匹配库中的价格段和尺寸段，生成便于后续统计的配对基表，并按店铺或品类汇总品牌成交金额和销售占比。对于匹配库中没有的新 SKU，使用者只需要补充尺寸段和价格段，程序即可保存到统一匹配库并用于后续月份。作品针对的是一个明确、重复发生且规则相对固定的业务场景，目标是减少复制粘贴、VLOOKUP 和重复整理，让运营同事按照统一步骤完成月度前置数据处理。")
    ptext(doc, "建议字数：约 260 字；可直接粘贴。", 9, False, "777777")

    heading(doc, "二 实现方案", 1)
    ptext(doc, "程序采用本地 Python 服务加浏览器界面的方式实现。用户通过 Edge 应用窗口进入工作台，选择一个或多个电商平台商智导出报表；程序读取商品编号、商品名称、品牌名称和成交金额等字段，并以 SKU 作为唯一匹配键，从内置匹配库中取出尺寸段和价格段。报表文件名中包含店铺关键字时，程序会给出店铺匹配建议；使用者也可以在界面中手动选择对应店铺。")
    ptext(doc, "匹配完成后，界面会展示配对明细和待补充 SKU。尺寸段、价格段可以从已有值中选择，也可以自定义输入。保存时，匹配结果会写入软件内部的统一匹配库；如果本次导入过桌面版匹配库文件，程序还可以在备份后同步写回该文件。最后生成包含配对明细和统计结果的 Excel 文件，供后续运营统计和汇报使用。")
    ptext(doc, "系统由数据读取、SKU 匹配、匹配库管理、报表处理、结果导出和页面交互几个部分组成。人工主要负责选择报表和店铺、确认自动建议、补充新 SKU 信息以及检查结果。")

    heading(doc, "三 创新点", 1)
    table(doc, ["原有工作", "本作品的改进"], [
        ["不同同事各自整理报表，步骤和结果格式不统一。", "把月度榜单处理步骤固定在同一套界面和输出结构中。"],
        ["创建、删除中间表，复制粘贴字段，再使用 VLOOKUP 匹配。", "程序按 SKU 自动读取和匹配尺寸段、价格段，减少重复操作。"],
        ["匹配库分散在个人文件中，新增 SKU 容易遗漏。", "匹配库内置在软件中，支持合并导入、覆盖导入、在线修改和导出。"],
        ["多个店铺需要分别处理，人工容易混淆文件与店铺。", "支持一次添加多个报表，并对每个报表自动建议或手动指定店铺。"],
        ["配对表完成后还要再次整理统计结果。", "在生成配对明细的同时，输出按店铺或品类汇总的品牌销售金额和占比。"],
    ], widths=[7.2, 9.0])
    ptext(doc, "本作品的创新主要体现在对具体业务流程的整理和固化。它没有依赖外部 API 或持续爬取商品信息，新增 SKU 仍由运营人员根据业务规则补充尺寸段和价格段，保留了人工判断环节，也更适合当前数据来源和使用条件。")

    heading(doc, "四 落地阶段", 1)
    ptext(doc, "已内部试用。当前版本已经完成 Windows 环境下的本地运行、电商平台商智榜单读取、单店铺和多店铺报表处理、店铺手动匹配和关键字建议、SKU 配对、新 SKU 补录、内置匹配库维护、桌面 Excel 同步写回、配对明细导出和当前月统计结果导出。历史月份趋势图和更完整的看板将在历史数据补齐并确认统计口径后继续完善。")

    heading(doc, "五 效率效益产出", 1)
    ptext(doc, "当前版本已将原本需要反复创建中间表、复制粘贴和调用 VLOOKUP 的工作，整理为“导入报表、确认店铺、分析匹配、补充新 SKU、导出结果”的连续流程。可核对的产出包括：统一的配对明细表、统一的内置 SKU 匹配库、带备份的匹配库写回结果，以及按店铺或品类生成的品牌成交金额和销售占比表。")
    ptext(doc, "目前暂不承诺固定的分钟数或百分比提升，因为不同月份的报表数量、新 SKU 数量和人工确认量会影响实际耗时。后续可以通过对比传统处理和软件处理的实际用时，补充更准确的效率指标。")

    heading(doc, "六 补充说明", 1)
    ptext(doc, "本程序针对电商平台商智商品榜单的固定导出结构设计。其他类型店铺或其他平台如果需要接入，需要先统一报表导出字段，并补充匹配库中的店铺和 SKU 信息。由于电商平台数据存在反频控限制，在没有稳定 API 授权的情况下，程序不通过长期爬取方式自动获取新品的尺寸段和价格段；新品信息仍需要运营人员人工确认后录入。软件当前保存的是匹配和统计所需的业务数据，后续可以根据历史数据接入月度趋势图和市占率变化分析。")
    ptext(doc, "建议在比赛页面上传软件工作台截图、匹配库页面截图、SKU 编辑截图和最终导出 Excel 示例，配合视频脚本展示完整流程。", 10, False, "666666")
    doc.core_properties.title = "市占率数据加工小程序 作品说明文案"
    doc.core_properties.subject = "AI Maker 智造大赛作品信息填写文案"
    doc.save(OUT_DIR / "AI_Maker作品说明文案.docx")


def video_doc():
    doc = Document()
    setup(doc, "市占率数据加工小程序 视频文案脚本", "建议时长 3 至 4 分钟 · 画面操作与配音分离")
    ptext(doc, "视频基调：以真实工作流程为主，展示软件如何减少重复整理。配音语气平实，使用“我在实习期间整理了一个小场景工具”“目前已经完成内部试用”等表述，避免夸大成果。", 10, False, "666666")
    heading(doc, "一 视频结构", 1)
    table(doc, ["段落", "建议时长", "核心内容"], [
        ["问题背景", "25 秒", "月度榜单处理重复、分散、容易出错。"],
        ["作品介绍", "25 秒", "说明工具服务对象和处理范围。"],
        ["实际操作", "约 2 分钟", "匹配库、多个报表、店铺选择、SKU 补录和导出。"],
        ["效果与边界", "35 秒", "统一输出、降低重复操作，同时说明人工补录和适用范围。"],
        ["结尾", "15 秒", "说明后续历史数据趋势分析方向。"],
    ], widths=[3.0, 3.0, 10.2])

    heading(doc, "二 分镜脚本", 1)
    scenes = [
        ("00:00-00:25", "问题背景", "画面：展示一张原始电商平台商智榜单，再快速切换到多个中间 Excel 表、复制粘贴和 VLOOKUP 公式。画面只展示示意数据，不展示敏感信息。", "每个月，运营同事都需要处理上个月的电商平台商智榜单。原始报表字段比较多，传统方式通常需要创建中间表、复制粘贴数据，再通过 VLOOKUP 按 SKU 匹配价格段和尺寸段。不同同事的处理方式也可能不完全一样，后续统计时还需要再次整理。"),
        ("00:25-00:50", "作品介绍", "画面：打开程序启动文件，进入 Edge 应用窗口，停留在 Liquid Glass 工作台首页。镜头缓慢扫过顶部导航和三个页面入口。", "我在实习期间，针对这个固定的月度处理场景，整理了一个市占率报表加工小程序。它主要给负责榜单整理的运营同事使用，把导入、匹配、补录和导出这些前置步骤放到一个统一流程里。"),
        ("00:50-01:15", "进入匹配库", "画面：点击“匹配库”页面，展示店铺列表和 SKU 数量；点击“导入并合并”或“导入并覆盖”，展示匹配库 Excel 选择框。", "程序内置了一份统一匹配库，按照店铺保存 SKU、尺寸段和价格段。首次使用可以导入完整匹配库，后续也可以选择合并新增数据，或者用完整文件覆盖更新。匹配库还支持导出，方便备份和交接。"),
        ("01:15-01:45", "添加多个报表", "画面：返回工作台，点击“添加”，一次选择多个榜单文件。展示报表列表，每个文件右侧有店铺下拉框。", "电商平台栏目下有多个店铺时，可以一次添加多个榜单。程序会根据文件名中的关键字给出店铺建议，运营同事也可以手动确认或调整每个报表对应的店铺。这样可以减少文件和店铺对应错误。"),
        ("01:45-02:10", "开始分析", "画面：点击“分析匹配”，展示匹配进度环、榜单商品数量、已匹配数量和待补充数量。切换报表名称，展示不同报表的配对明细。", "确认店铺后，点击分析匹配。程序以 SKU 作为唯一匹配键，自动补齐尺寸段和价格段，并在表格中标记哪些记录已经匹配，哪些记录还需要人工确认。多个报表会分别保留明细，同时汇总到后面的统计结果中。"),
        ("02:10-02:45", "补充新 SKU", "画面：单击一条待补充记录，再点击“编辑选中 SKU”；展示尺寸段和价格段输入框的候选下拉值，然后输入一个自定义值并保存。", "新品 SKU 或者匹配库中没有的 SKU，仍然需要人工补充。这里可以直接选择已有的尺寸段和价格段，也可以输入新的值。保存这条记录后，它会先暂存在当前结果中，点击最终保存时才写入匹配库。这个环节保留了运营人员对商品信息的判断。"),
        ("02:45-03:10", "写回和导出", "画面：点击“写回匹配库并导出”，展示提示信息；随后打开导出的 Excel，依次展示“统计结果”和“配对明细”工作表。", "确认结果后，点击写回匹配库并导出。程序会保存内置匹配库，如果本次使用了桌面版匹配库，也会在备份后同步写回。导出的工作簿同时包含配对明细和统计结果，减少了从基表到统计表的重复整理。"),
        ("03:10-03:35", "结果说明", "画面：放大统计结果中的品牌、销售金额和占比列，随后回到程序的统计结果页面。", "当前统计结果按照店铺或品类汇总品牌成交金额，并计算品牌在当前处理范围内的销售占比。它可以作为后续市占率汇报的基础数据。最终的统计口径仍然需要结合月份和上级要求进行确认。"),
        ("03:35-04:00", "边界与后续", "画面：展示“统计结果”页面，再叠加简单的后续路线文字：历史数据、趋势图、飞书迁移。最后回到程序首页。", "这个程序针对电商平台商智商品榜单的固定导出结构设计。新品的尺寸段和价格段目前仍需要人工补充，程序也不依赖不稳定的长期爬取。后续如果补充历史数据并统一统计口径，可以继续增加月度趋势图和市占率变化分析，也可以进一步迁移到飞书环境中。"),
    ]
    table(doc, ["时间", "段落", "画面和操作指示", "配音台词"], scenes, widths=[2.3, 2.4, 6.2, 6.1], font_size=8.7)

    heading(doc, "三 录制注意事项", 1)
    for item in [
        "录制前准备一份脱敏的榜单文件和测试匹配库，商品名称、品牌和文件路径中不要出现公司内部敏感信息。",
        "鼠标操作尽量放慢，每个关键按钮点击后停留 1 至 2 秒，让观众看清状态变化。",
        "演示新 SKU 时只补充一条记录即可，重点展示候选选择、自定义输入和保存写回流程。",
        "导出文件打开后停留在统计结果页，再切换到配对明细页，观众可以直观看到两个输出结果。",
        "配音中的“市占率”建议解释为当前报表范围内的品牌销售占比，避免把当前版本描述成已经完成全部市场数据自动采集。",
        "结尾可以使用“目前已经完成内部试用，后续根据真实使用反馈继续完善”作为收束。",
    ]:
        ptext(doc, "• " + item, 10, False, "222222", after=3)
    doc.core_properties.title = "市占率数据加工小程序 视频文案脚本"
    doc.core_properties.subject = "AI Maker 智造大赛作品演示视频脚本"
    doc.save(OUT_DIR / "市占率数据加工小程序视频文案脚本.docx")


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    competition_doc()
    video_doc()
    print(OUT_DIR)


if __name__ == "__main__":
    main()
