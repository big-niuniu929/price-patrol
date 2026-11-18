# -*- coding: utf-8 -*-
"""把工作台导出的 CSV 回填到《SKU巡检表》的 Excel 副本。

特点：
  - 按**表头名称**识别各 sheet 的「普惠 当前价格 / 会员 当前价格」列（不同 sheet 列顺序不同也能写对）；
  - 按「类目 + Excel行」定位，不依赖行号顺序；
  - 低于阈值（当前价格 < 最低到手价）的单元格标红；
  - 不修改原文件，输出一份新副本。

用法：
  python apply_results_to_xlsx.py <导出的CSV> [原xlsx路径] [输出xlsx路径]
"""
from __future__ import annotations

import csv
import re
import sys
from datetime import datetime
from pathlib import Path

from openpyxl import load_workbook
from openpyxl.styles import Font

DEFAULT_XLSX = Path(r"~/Desktop/SKU巡检表.xlsx")
RED = Font(color="C00000", bold=True)

HEADER_ALIASES = {
    "sku": ["sku", "SKU", "商品编号", "sku_id", "商品SKU"],
    "model": ["套餐型号", "型号", "商品型号"],
    "package": ["套餐", "套餐名称"],
    "frontPrice": ["前台价格", "前台价"],
    "utilMin": ["普惠最低到手价", "普惠最低 到手价", "普惠最低价", "普惠阈值"],
    "utilCurrent": ["普惠当前价格", "普惠 当前价格", "普惠当前价"],
    "plusMin": ["会员最低到手价", "会员最低 到手价", "会员最低价", "会员阈值"],
    "plusCurrent": ["会员当前价格", "会员 当前价格", "会员当前价"],
}


def norm_header(value) -> str:
    return re.sub(r"\s+", "", str(value or "")).strip()


def detect_columns(ws):
    header_values = {}
    for col in range(1, min(ws.max_column or 1, 40) + 1):
        text = norm_header(ws.cell(row=1, column=col).value)
        if text:
            header_values[col] = text
    mapping = {}
    for field, aliases in HEADER_ALIASES.items():
        alias_set = {norm_header(a) for a in aliases}
        for col, text in header_values.items():
            if text in alias_set:
                mapping[field] = col
                break
    return mapping


def parse_num(value):
    if value is None:
        return None
    text = str(value).strip().replace(",", "").replace("¥", "").replace("￥", "")
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def main():
    if len(sys.argv) < 2:
        print("用法: python apply_results_to_xlsx.py <导出的CSV> [原xlsx路径] [输出xlsx路径]")
        return
    csv_path = Path(sys.argv[1])
    xlsx = Path(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2].strip() else DEFAULT_XLSX
    stamp = datetime.now().strftime("%Y%m%d-%H%M")
    out = Path(sys.argv[3]) if len(sys.argv) > 3 and sys.argv[3].strip() else xlsx.with_name(
        xlsx.stem + "-巡检结果-" + stamp + ".xlsx"
    )

    if not csv_path.exists():
        print("CSV 不存在:", csv_path)
        return
    if not xlsx.exists():
        print("Excel 不存在:", xlsx)
        return

    rows = {}
    with csv_path.open("r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        for r in reader:
            sheet = (r.get("类目") or "").strip()
            try:
                excel_row = int((r.get("Excel行") or "").strip())
            except ValueError:
                continue
            rows[(sheet, excel_row)] = r
    print("CSV 数据行:", len(rows))

    wb = load_workbook(xlsx, data_only=False)
    filled_util = filled_plus = below = 0
    skipped_sheet = []
    for ws in wb.worksheets:
        mapping = detect_columns(ws)
        util_col = mapping.get("utilCurrent")
        plus_col = mapping.get("plusCurrent")
        if not util_col and not plus_col:
            skipped_sheet.append(ws.title)
            continue
        print(f"[{ws.title}] 当前价格列：普惠={util_col} 会员={plus_col}")
        for excel_row in range(2, ws.max_row + 1):
            r = rows.get((ws.title, excel_row))
            if not r:
                continue
            util_price = parse_num(r.get("普惠当前价格"))
            plus_price = parse_num(r.get("会员当前价格"))
            util_min = parse_num(r.get("普惠最低到手价"))
            plus_min = parse_num(r.get("会员最低到手价"))
            if util_min is None and mapping.get("utilMin"):
                util_min = parse_num(ws.cell(row=excel_row, column=mapping["utilMin"]).value)
            if plus_min is None and mapping.get("plusMin"):
                plus_min = parse_num(ws.cell(row=excel_row, column=mapping["plusMin"]).value)

            if util_price is not None and util_col:
                cell = ws.cell(row=excel_row, column=util_col)
                cell.value = util_price
                filled_util += 1
                if util_min is not None and util_price < util_min:
                    cell.font = RED
                    below += 1
            if plus_price is not None and plus_col:
                cell = ws.cell(row=excel_row, column=plus_col)
                cell.value = plus_price
                filled_plus += 1
                if plus_min is not None and plus_price < plus_min:
                    cell.font = RED
                    below += 1

    out.parent.mkdir(parents=True, exist_ok=True)
    wb.save(out)
    wb.close()

    # 重新打开校验
    wb2 = load_workbook(out, data_only=False)
    check_util = check_plus = 0
    for ws in wb2.worksheets:
        mapping = detect_columns(ws)
        for excel_row in range(2, ws.max_row + 1):
            if mapping.get("utilCurrent") and ws.cell(row=excel_row, column=mapping["utilCurrent"]).value is not None:
                check_util += 1
            if mapping.get("plusCurrent") and ws.cell(row=excel_row, column=mapping["plusCurrent"]).value is not None:
                check_plus += 1
    wb2.close()

    print(f"回填普惠当前价格: {filled_util} 个")
    print(f"回填会员当前价格: {filled_plus} 个")
    print(f"低于阈值标红: {below} 处")
    if skipped_sheet:
        print("这些 sheet 没有找到当前价格列，已跳过：", skipped_sheet)
    print(f"输出文件: {out}  (校验：普惠列非空 {check_util}，会员列非空 {check_plus})")


if __name__ == "__main__":
    main()
