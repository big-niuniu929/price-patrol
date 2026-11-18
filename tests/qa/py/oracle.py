#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""tests/qa/py/oracle.py —— 用 Python + openpyxl 独立算出「应有」指标，作为 JS 实现的对照基准。

输出一个 JSON（UTF-8）到 stdout：
{
  "reports": [{file, sheet, dataRows, headers, skuHeader, uniqueSkus, amountOk, amountSumWan,
               inchRegexRows, libSizeHits, libPriceHits, libBothHits}],
  "libraryXlsx": {storeName: {skus, filled}, ...},
  "seed": {stores, totalRows, filled, storeRows, storeFilled},
  "files": {file: {exists, bytes}}
}
只读 资料/ 与 extension/data/base-skus.json，不写任何文件。
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import openpyxl

ROOT = Path(__file__).resolve().parents[3]
DATA = Path(r"~/Desktop/资料")
SEED = ROOT / "extension" / "data" / "base-skus.json"

REPORTS = [
    ("11月-会议平板.xlsx", ["SKU ID"]),
    ("11月-会议电视.xlsx", ["SKU ID"]),
    ("11月-教育教学一体机.xlsx", ["sku", "SKU ID"]),
    ("tangpingnature_商品榜单_热销排名_离线_汇总下载_2026-10-01_2026-10-31.xlsx", ["SPU ID"]),
]

AMOUNT_RE = re.compile(r"(\d+(?:\.\d+)?)\s*(万)?")
INCH_RE = re.compile(r"(\d{2,3}(?:\.\d+)?)\s*(?:英寸|英吋|吋|寸)")


def parse_amount_wan(raw) -> float | None:
    """成交金额 → 万元（取两个边界中值）。

    真实榜单的「成交金额」是混排写法：
      ￥200万 ~ ￥400万  -> 300
      ￥8,000 ~ ￥1万    -> 0.9（元口径）
      ￥6,000 ~ ￥8,000  -> 0.7（元口径，无「万」且 ≥1000 视为元）
      ￥2,000 ~ ￥4,000  -> 0.3
    与 extension/lib/rules.js parseAmountRange 修复后的口径一致，作为独立对照基准。
    """
    text = cell_text(raw).replace(",", "").replace("，", "")
    if not text:
        return None
    numbers = [(float(n), bool(w)) for n, w in AMOUNT_RE.findall(text) if n]
    if not numbers:
        return None
    has_wan = any(w for _, w in numbers)
    yuan = [n * 10000 if w else n for n, w in numbers]
    if has_wan or any(n >= 1000 for n, _ in numbers):
        base = yuan[:2]
        return round(sum(base) / len(base) / 10000, 4)
    base = [n for n, _ in numbers[:2]]
    return round(sum(base) / len(base), 4)


def emit(payload) -> None:
    sys.stdout.buffer.write(json.dumps(payload, ensure_ascii=False).encode("utf-8"))


def cell_text(value) -> str:
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value).strip()


def sku_text(value) -> str:
    raw = cell_text(value)
    if re.fullmatch(r"\d+\.0", raw):
        raw = raw[:-2]
    return raw


def load_seed() -> dict:
    if not SEED.exists():
        return {"stores": 0, "totalRows": 0, "filled": 0, "storeRows": {}, "storeFilled": {}}
    payload = json.loads(SEED.read_text(encoding="utf-8"))
    stores = payload.get("stores") or {}
    total = 0
    filled = 0
    store_rows = {}
    store_filled = {}
    for name, store in stores.items():
        rows = (store or {}).get("rows") or {}
        store_rows[name] = len(rows)
        store_filled[name] = sum(1 for rec in rows.values() if (rec or {}).get("size") and (rec or {}).get("price"))
        total += len(rows)
        filled += store_filled[name]
    return {"stores": len(stores), "totalRows": total, "filled": filled,
            "storeRows": store_rows, "storeFilled": store_filled}


def main() -> int:
    seed = load_seed()
    # SKU -> 多条记录（跨 sheet 可能重复）
    seed_rows = {}
    if SEED.exists():
        payload = json.loads(SEED.read_text(encoding="utf-8"))
        for store in (payload.get("stores") or {}).values():
            for sku, rec in ((store or {}).get("rows") or {}).items():
                seed_rows.setdefault(str(sku), []).append(rec or {})

    reports = []
    for file_name, sku_headers in REPORTS:
        path = DATA / file_name
        entry = {"file": file_name, "exists": path.exists(), "bytes": path.stat().st_size if path.exists() else 0}
        if not entry["exists"]:
            reports.append(entry)
            continue
        wb = openpyxl.load_workbook(path, data_only=True)
        ws = wb.worksheets[0]
        rows = list(ws.iter_rows(values_only=True))
        wb.close()
        headers = [cell_text(v) for v in rows[0]] if rows else []
        sku_col = next((i for i, h in enumerate(headers) if h in sku_headers), -1)
        name_col = headers.index("商品名称") if "商品名称" in headers else -1
        amount_col = headers.index("成交金额") if "成交金额" in headers else -1
        skus = []
        amount_ok = 0
        amount_sum = 0.0
        lib_size = lib_price = lib_both = 0
        inch_rows = 0
        for row in rows[1:]:
            values = list(row)
            sku = sku_text(values[sku_col]) if sku_col >= 0 and sku_col < len(values) else ""
            skus.append(sku)
            raw_amount = cell_text(values[amount_col]) if amount_col >= 0 and amount_col < len(values) else ""
            amount = parse_amount_wan(raw_amount)
            if amount is not None:
                amount_ok += 1
                amount_sum += amount
            name = cell_text(values[name_col]) if name_col >= 0 and name_col < len(values) else ""
            if INCH_RE.search(name):
                inch_rows += 1
            records = seed_rows.get(sku, [])
            has_size = any(cell_text(r.get("size")) for r in records)
            has_price = any(cell_text(r.get("price")) for r in records)
            lib_size += 1 if has_size else 0
            lib_price += 1 if has_price else 0
            lib_both += 1 if (has_size and has_price) else 0
        entry.update({
            "sheet": ws.title,
            "dataRows": len(skus),
            "uniqueSkus": len(set(s for s in skus if s)),
            "headers": headers,
            "amountCol": amount_col,
            "nameCol": name_col,
            "skuCol": sku_col,
            "skuHeader": headers[sku_col] if sku_col >= 0 else "",
            "amountOk": amount_ok,
            "amountSumWan": round(amount_sum, 4),
            "inchRegexRows": inch_rows,
            "libSizeHits": lib_size,
            "libPriceHits": lib_price,
            "libBothHits": lib_both,
            "firstSkus": skus[:5],
        })
        reports.append(entry)

    library = {}
    lib_path = DATA / "匹配库.xlsx"
    if lib_path.exists():
        wb = openpyxl.load_workbook(lib_path, data_only=True)
        for ws in wb.worksheets:
            rows = list(ws.iter_rows(min_row=2, values_only=True))
            skus = set()
            filled = 0
            for row in rows:
                if not row:
                    continue
                sku = sku_text(row[0]) if len(row) > 0 else ""
                if not sku:
                    continue
                skus.add(sku)
                if len(row) > 4 and cell_text(row[3]) and cell_text(row[4]):
                    filled += 1
            library[ws.title] = {"skus": len(skus), "filled": filled}
        wb.close()

    files = {}
    for name in [r[0] for r in REPORTS] + ["匹配库.xlsx"]:
        p = DATA / name
        files[name] = {"exists": p.exists(), "bytes": p.stat().st_size if p.exists() else 0}

    emit({"reports": reports, "libraryXlsx": library, "seed": seed,
          "seedFile": {"exists": SEED.exists(), "bytes": SEED.stat().st_size if SEED.exists() else 0},
          "files": files})
    return 0


if __name__ == "__main__":
    sys.exit(main())
