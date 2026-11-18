#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把「匹配库.xlsx」转成插件内置基表 extension/data/base-skus.json。

- 按表头名称自适应识别列（SKU / 商品名称 / 品牌 / 尺寸段 / 价格段），
  不依赖固定列号，也不依赖 sheet 顺序；
- 可叠加旧版匹配库 data/match_library.json 里的记录做补全（Excel 优先）；
  旧文件已随旧 Python 工具归档到 `_archive/2026-11-02-old-python-tool/data/match_library.json`，
  脚本默认从归档位置读取（可加 --legacy 指向别处，不存在则跳过）。

用法：
    python tools/build_base_from_xlsx.py
    python tools/build_base_from_xlsx.py --xlsx "C:\\...\\匹配库.xlsx" --legacy "C:\\...\\match_library.json"
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from datetime import datetime
from pathlib import Path

import openpyxl

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_XLSX = Path(r"~/Desktop/资料\匹配库.xlsx")
# v2.1.4：用户已明确「新版 匹配库.xlsx 为唯一权威数据」，默认不再合并旧内置库；
# 如需临时合并可显式传 --legacy <path>。
DEFAULT_LEGACY = None
DEFAULT_OUT = ROOT / "extension" / "data" / "base-skus.json"

ALIASES = {
    "sku": ["sku（商品编码）", "sku(商品编码)", "sku", "商品编号", "商品编码", "sku id", "spu id", "商品id"],
    "name": ["商品名称", "商品名", "产品名称", "标题"],
    "brand": ["品牌", "品牌名称", "品牌名"],
    "size": ["尺寸段", "尺寸", "屏幕尺寸"],
    "price": ["价格段", "价格段(17段)", "价格段（17段）", "价格"],
}


def norm(value) -> str:
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value).strip()


def sku_text(value) -> str:
    raw = norm(value)
    if re.fullmatch(r"\d+\.0", raw):
        raw = raw[:-2]
    return raw


def header_map(ws):
    row = next(ws.iter_rows(min_row=1, max_row=1, values_only=True), ())
    mapping = {}
    for index, value in enumerate(row, 1):
        key = norm(value).lower().replace(" ", "")
        if key:
            mapping[key] = index
    return mapping


def find_col(mapping, field):
    for alias in ALIASES[field]:
        key = alias.lower().replace(" ", "")
        if key in mapping:
            return mapping[key]
    return None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--xlsx", default=str(DEFAULT_XLSX))
    parser.add_argument("--legacy", default="", help="可选：旧内置库 JSON（默认不合并）")
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    args = parser.parse_args()

    xlsx_path = Path(args.xlsx)
    if not xlsx_path.exists():
        print(f"[ERR] 找不到匹配库：{xlsx_path}")
        return 1

    wb = openpyxl.load_workbook(xlsx_path, data_only=True)
    stores = {}
    stats = []
    for ws in wb.worksheets:
        mapping = header_map(ws)
        cols = {field: find_col(mapping, field) for field in ALIASES}
        if not cols["sku"]:
            print(f"[SKIP] 工作表 {ws.title}：找不到 SKU 列")
            continue
        rows = {}
        duplicates = []
        for row in ws.iter_rows(min_row=2, values_only=True):
            values = list(row)
            def cell(field):
                index = cols[field]
                return norm(values[index - 1]) if index and index <= len(values) else ""
            sku = sku_text(cell("sku"))
            if not sku:
                continue
            if sku in rows:
                duplicates.append(sku)
            rows[sku] = {
                "sku": sku,
                "name": cell("name"),
                "brand": cell("brand"),
                "size": cell("size"),
                "price": cell("price"),
            }
        filled = sum(1 for item in rows.values() if item["size"] and item["price"])
        stores[ws.title] = {
            "name": ws.title,
            "note": "来自匹配库 Excel",
            "rows": rows,
        }
        stats.append({"name": ws.title, "rows": len(rows), "filled": filled, "duplicates": duplicates})
        print(f"[OK] {ws.title}: {len(rows)} 个 SKU，其中 {filled} 个尺寸段+价格段齐全")
    wb.close()

    legacy_filled = 0
    legacy_path = Path(args.legacy) if args.legacy else None
    if legacy_path and legacy_path.exists():
        try:
            legacy = json.loads(legacy_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            print(f"[WARN] 旧内置库读取失败：{exc}")
            legacy = {}
        for sheet_name, store in (legacy or {}).items():
            if not isinstance(store, dict):
                continue
            target = stores.setdefault(sheet_name, {"name": sheet_name, "note": "来自旧内置匹配库", "rows": {}})
            for sku, record in (store.get("rows") or {}).items():
                sku = sku_text(sku)
                if not sku:
                    continue
                current = target["rows"].get(sku)
                if current is None:
                    target["rows"][sku] = {
                        "sku": sku,
                        "name": "",
                        "brand": "",
                        "size": norm(record.get("size")),
                        "price": norm(record.get("price")),
                    }
                    legacy_filled += 1
                else:
                    if not current.get("size") and record.get("size"):
                        current["size"] = norm(record.get("size"))
                    if not current.get("price") and record.get("price"):
                        current["price"] = norm(record.get("price"))
                    legacy_filled += 1
        print(f"[OK] 旧内置库合并：{legacy_filled} 条记录")

    # 指纹：SKU + 四个字段的稳定哈希，用于插件升级时判断内置匹配库是否变化（DESIGN 19.4）
    canonical = json.dumps(
        [
            [sheet_name, sku, item["name"], item["brand"], item["size"], item["price"]]
            for sheet_name in sorted(stores)
            for sku, item in sorted(stores[sheet_name]["rows"].items())
        ],
        ensure_ascii=False,
        separators=(",", ":"),
    )
    fingerprint = hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]
    xlsx_mtime = datetime.fromtimestamp(xlsx_path.stat().st_mtime).astimezone().isoformat(timespec="seconds")
    schema_version = "2026-11-03." + fingerprint[:6]

    payload = {
        "schema": "market-share.base/v1",
        "schemaVersion": schema_version,
        "fingerprint": fingerprint,
        "generatedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
        "source": str(xlsx_path),
        "sourceMtime": xlsx_mtime,
        "legacySource": str(legacy_path) if (legacy_path and legacy_path.exists()) else "",
        "sizeBands": ["55英寸", "65英寸", "75英寸", "86/85英寸", "98/100英寸",
                      "其他尺寸(43英寸)", "其他尺寸(110英寸)", "其他尺寸(120英寸)", "其他尺寸(150英寸)", "其他"],
        "priceBands": ["1000元以下", "1000元至2000元", "2000元至2500元", "2500元至3000元",
                       "3000元至3500元", "3500元至4000元", "4000元至4500元", "4500元至5000元",
                       "5000元至5500元", "5500元至6000元", "6000元至7000元", "7000元至8000元",
                       "8000元至9000元", "9000元至10000元", "10000元至15000元",
                       "15000元至20000元", "20000元至25000元", "25000元以上"],
        "stores": stores,
        "stats": stats,
    }

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    total = sum(len(store["rows"]) for store in stores.values())
    filled_total = sum(1 for store in stores.values() for row in store["rows"].values() if row["size"] and row["price"])
    print(f"\n已生成：{out_path}")
    print(f"店铺/类目 {len(stores)} 个，SKU 合计 {total} 个，尺寸段+价格段齐全 {filled_total} 个")
    return 0


if __name__ == "__main__":
    sys.exit(main())
