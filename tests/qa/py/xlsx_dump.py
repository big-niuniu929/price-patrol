#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""tests/qa/py/xlsx_dump.py —— 用 openpyxl 打开一个 xlsx 并输出结构化 JSON（供 JS 断言）。

用法：python tests/qa/py/xlsx_dump.py <xlsx路径> [maxRows]
输出：{"ok":true, "sheets":[{"name","rows":[[...]],"rowCount","colCount"}], "rowCounts":{...}}
用途：
  1) 证明插件导出的 xlsx 能被 Excel 生态（openpyxl）正常打开；
  2) 给 JS 断言列数/行数/表头/单元格值。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import openpyxl


def cell_text(value) -> str:
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def emit(payload) -> None:
    sys.stdout.buffer.write(json.dumps(payload, ensure_ascii=False).encode("utf-8"))


def main() -> int:
    if len(sys.argv) < 2:
        emit({"ok": False, "error": "缺少 xlsx 路径参数"})
        return 2
    path = Path(sys.argv[1])
    max_rows = int(sys.argv[2]) if len(sys.argv) > 2 else 0
    if not path.exists():
        emit({"ok": False, "error": f"文件不存在：{path}"})
        return 2
    try:
        wb = openpyxl.load_workbook(path, data_only=True)
    except Exception as exc:  # noqa: BLE001 - 需要把失败原因回传
        emit({"ok": False, "error": f"openpyxl 打开失败：{type(exc).__name__}: {exc}"})
        return 2
    try:
        sheets = []
        row_counts = {}
        for ws in wb.worksheets:
            rows = []
            limit = max_rows if max_rows > 0 else None
            for idx, row in enumerate(ws.iter_rows(values_only=True), 1):
                if limit and idx > limit:
                    break
                rows.append([cell_text(v) for v in row])
            row_counts[ws.title] = ws.max_row
            sheets.append({
                "name": ws.title,
                "rowCount": ws.max_row,
                "colCount": ws.max_column,
                "rows": rows,
            })
        payload = {"ok": True, "path": str(path), "sheetNames": wb.sheetnames,
                   "sheets": sheets, "rowCounts": row_counts}
        emit(payload)
        return 0
    finally:
        wb.close()


if __name__ == "__main__":
    sys.exit(main())
