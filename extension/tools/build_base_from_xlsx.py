# -*- coding: utf-8 -*-
"""把《SKU巡检表.xlsx》转成扩展内置的 data/base-skus.json。

特点：
  - 按**表头名称**识别列（不依赖固定列号），因此各 sheet 列顺序/列数可以不同
    （例如「音视频店」没有「套餐」列也能正确解析）；
  - 支持表头里带空格的写法（如「普惠最低 到手价」「普惠 当前价格」）。

用法：
  python build_base_from_xlsx.py [xlsx路径] [输出json路径]
"""
from __future__ import annotations

import json
import math
import re
import sys
from datetime import datetime
from pathlib import Path

from openpyxl import load_workbook

DEFAULT_XLSX = Path(r"~/Desktop/SKU巡检表.xlsx")
DEFAULT_JSON = Path(__file__).resolve().parents[1] / "data" / "base-skus.json"

# 逻辑字段 -> 可能的表头写法（比较时会去掉所有空白）
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


def to_number(value):
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip().replace(",", "").replace("￥", "").replace("¥", "")
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def to_text(value) -> str:
    if value is None:
        return ""
    return str(value).strip()


# ---- 简单公式求值（阈值写成 =E58-1060 之类、且保存时没有缓存结果的单元格）----
def _eval_formula(ws, formula, cache, stack):
    text = re.sub(r"\s+", "", str(formula or "").lstrip("="))
    n = len(text)
    pos = [0]

    def peek():
        return text[pos[0]] if pos[0] < n else ""

    def parse_expr():
        value = parse_term()
        while peek() in ("+", "-"):
            op = text[pos[0]]
            pos[0] += 1
            right = parse_term()
            value = value + right if op == "+" else value - right
        return value

    def parse_term():
        value = parse_factor()
        while peek() in ("*", "/"):
            op = text[pos[0]]
            pos[0] += 1
            right = parse_factor()
            value = value * right if op == "*" else value / right
        return value

    def parse_factor():
        if peek() == "+":
            pos[0] += 1
            return parse_factor()
        if peek() == "-":
            pos[0] += 1
            return -parse_factor()
        if peek() == "(":
            pos[0] += 1
            value = parse_expr()
            if peek() == ")":
                pos[0] += 1
            return value
        m = re.match(r"\d+(?:\.\d+)?", text[pos[0]:])
        if m:
            pos[0] += len(m.group(0))
            return float(m.group(0))
        m = re.match(r"\$?([A-Z]+)\$?(\d+)", text[pos[0]:])
        if m:
            pos[0] += len(m.group(0))
            col = 0
            for ch in m.group(1):
                col = col * 26 + (ord(ch) - 64)
            ref_value = _cell_value(ws, int(m.group(2)), col, cache, stack)
            num = to_number(ref_value)
            return num if num is not None else float("nan")
        pos[0] = n
        return float("nan")

    try:
        value = parse_expr()
        if pos[0] < n or not math.isfinite(value):
            return None
        return value
    except Exception:  # noqa: BLE001
        return None


def _cell_value(ws, row, col, cache, stack):
    key = (row, col)
    if key in cache:
        return cache[key]
    cell = ws.cell(row=row, column=col)
    value = cell.value
    if cell.data_type == "f" and isinstance(value, str):
        if key in stack:
            return None
        stack.add(key)
        try:
            result = _eval_formula(ws, value, cache, stack)
        finally:
            stack.discard(key)
        if result is None:
            result = cell.value  # 回退：返回公式字符串（后续 to_number 会得到 None）
        cache[key] = result
        return result
    cache[key] = value
    return value


def detect_columns(ws):
    """按表头识别列号，返回 {逻辑字段: 列号}。"""
    header_values = {}
    max_col = min(ws.max_column or 1, 40)
    for col in range(1, max_col + 1):
        text = norm_header(_cell_value(ws, 1, col, {}, set()))
        if text:
            header_values[col] = text

    mapping = {}
    for field, aliases in HEADER_ALIASES.items():
        alias_set = {norm_header(a) for a in aliases}
        for col, text in header_values.items():
            if text in alias_set:
                mapping[field] = col
                break
    return mapping, header_values


def parse_sheet(ws):
    mapping, header_values = detect_columns(ws)
    if "sku" not in mapping or "model" not in mapping:
        return [], mapping, header_values, 0

    rows = []
    cell_cache = {}
    cell_stack = set()
    for row_idx in range(2, ws.max_row + 1):
        def cell(field):
            col = mapping.get(field)
            return _cell_value(ws, row_idx, col, cell_cache, cell_stack) if col else None

        sku_text = to_text(cell("sku"))
        sku = sku_text if sku_text.isdigit() else ""
        note = "" if sku or not sku_text else sku_text

        row = {
            "rowId": f"{ws.title}!{row_idx}",
            "sheet": ws.title,
            "excelRow": row_idx,
            "sku": sku,
            "note": note,
            "model": to_text(cell("model")),
            "package": to_text(cell("package")),
            "frontPrice": to_number(cell("frontPrice")),
            "utilMin": to_number(cell("utilMin")),
            "plusMin": to_number(cell("plusMin")),
            "utilCurrent": to_number(cell("utilCurrent")),
            "plusCurrent": to_number(cell("plusCurrent")),
        }
        if not any(
            [
                row["sku"],
                row["note"],
                row["model"],
                row["package"],
                row["frontPrice"] is not None,
                row["utilMin"] is not None,
                row["plusMin"] is not None,
            ]
        ):
            continue
        rows.append(row)

    # 按 SKU 去重（同一 sheet 内）：保留第一行的位置，用最后一条数据覆盖，
    # 这样新表里重复的 SKU 只保留一条最新数据。
    by_sku = {}
    deduped = []
    dropped = 0
    for row in rows:
        sku = row["sku"]
        if not sku:
            deduped.append(row)
            continue
        if sku in by_sku:
            existing = by_sku[sku]
            keep_row_id = existing["rowId"]
            keep_excel_row = existing["excelRow"]
            existing.update(row)
            existing["rowId"] = keep_row_id
            existing["excelRow"] = keep_excel_row
            dropped += 1
        else:
            by_sku[sku] = row
            deduped.append(row)
    return deduped, mapping, header_values, dropped


def merge_new_sheets(sheets):
    """把「XX新表」合并进「XX」：同 SKU 用新表非空字段覆盖旧表；新 SKU/无 SKU 行追加到末尾。

    行号 / rowId 保持旧表不变（这样已下架状态、手动改价不会漂移）。
    """
    by_name = {s["name"]: s for s in sheets}
    consumed = set()
    for s in sheets:
        name = s["name"]
        if not name.endswith("新表"):
            continue
        base_name = name[: -len("新表")]
        base = by_name.get(base_name)
        if not base:
            continue
        old_by_sku = {r["sku"]: r for r in base["rows"] if r["sku"]}
        fields = ["model", "package", "frontPrice", "utilMin", "plusMin", "utilCurrent", "plusCurrent"]
        next_row = max((r.get("excelRow") or 0) for r in base["rows"]) + 1
        added = 0
        for r in s["rows"]:
            sku = r["sku"]
            if sku and sku in old_by_sku:
                target = old_by_sku[sku]
                for f in fields:
                    v = r.get(f)
                    if v is None or (isinstance(v, str) and not v.strip()):
                        continue  # 新表空字段保留旧值
                    target[f] = v
                continue
            row = dict(r)
            row["sheet"] = base_name
            row["excelRow"] = next_row
            row["rowId"] = "%s!%d" % (base_name, next_row)
            if not row.get("sku") and not row.get("note"):
                row["note"] = "%s新增，待补 SKU" % name
            base["rows"].append(row)
            old_by_sku[row["sku"]] = row
            next_row += 1
            added += 1
        base["rowCount"] = len(base["rows"])
        base["withSku"] = sum(1 for r in base["rows"] if r["sku"])
        base["missingSku"] = base["rowCount"] - base["withSku"]
        consumed.add(name)
        print("[merge] %s -> %s：新增 %d 行，合并后 %d 行" % (name, base_name, added, base["rowCount"]))
    return [s for s in sheets if s["name"] not in consumed]


def main():
    xlsx = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_XLSX
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else DEFAULT_JSON

    wb = load_workbook(xlsx)  # 不用 data_only：需要读取公式并自行计算
    sheets = []
    total = 0
    for ws in wb.worksheets:
        rows, mapping, header_values, dropped = parse_sheet(ws)
        total += len(rows)
        with_sku = sum(1 for r in rows if r["sku"])
        sheets.append(
            {
                "name": ws.title,
                "rowCount": len(rows),
                "withSku": with_sku,
                "missingSku": len(rows) - with_sku,
                "deduped": dropped,
                "columns": {k: v for k, v in mapping.items()},
                "headers": {str(k): v for k, v in header_values.items()},
                "rows": rows,
            }
        )
        print(f"[{ws.title}] rows={len(rows)} withSku={with_sku} deduped={dropped} columns={mapping}")
    wb.close()
    sheets = merge_new_sheets(sheets)
    total = sum(len(s["rows"]) for s in sheets)

    seen = {}
    for sheet in sheets:
        for row in sheet["rows"]:
            if not row["sku"]:
                continue
            seen.setdefault(row["sku"], []).append(f"{sheet['name']}!{row['excelRow']}")
    dup = {sku: places for sku, places in seen.items() if len(places) > 1}

    data = {
        "generatedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
        "source": str(xlsx),
        "sheets": sheets,
        "totalRows": total,
        "totalWithSku": sum(s["withSku"] for s in sheets),
        "duplicates": dup,
    }

    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")

    print(f"json: {out}  size={out.stat().st_size}")
    print(f"sheets={len(sheets)} totalRows={total} withSku={data['totalWithSku']}")
    print(f"duplicates={len(dup)}")
    for sku, places in list(dup.items())[:10]:
        print(f"  dup {sku}: {places}")


if __name__ == "__main__":
    main()
