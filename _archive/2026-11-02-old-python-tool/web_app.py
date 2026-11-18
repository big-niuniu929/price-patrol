from __future__ import annotations

import json
import os
import re
import shutil
import threading
import time
import traceback
import webbrowser
from datetime import datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from tkinter import Tk, filedialog
from urllib.parse import quote, urlparse

from openpyxl import Workbook, load_workbook
from openpyxl.styles import Font, PatternFill

from app import OUTPUT_HEADERS, backup_path, read_library, read_report, sku_key


ROOT = Path(__file__).resolve().parent
UI_DIR = ROOT / "ui"
DATA_DIR = ROOT / "data"
EMBEDDED_LIBRARY = DATA_DIR / "match_library.json"
STATE = {
    "library_path": None,
    "report_path": None,
    "stores": [],
    "report_rows": [],
    "library_data": {},
    "reports": [],
    "active_report_id": "",
    "matches": {},
    "selected_store": "",
    "analyzed_store": "",
}
LOCK = threading.Lock()
LAST_PING = {"time": 0.0}


def store_data_from_sheets(stores):
    return {
        store["name"]: {
            "name": store["name"],
            "rows": {
                sku: {"sku": record["sku"], "size": record["size"], "price": record["price"]}
                for sku, record in store["rows"].items()
            },
        }
        for store in stores
    }


def persist_embedded_library():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    temp = EMBEDDED_LIBRARY.with_suffix(".tmp")
    temp.write_text(json.dumps(STATE["library_data"], ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temp, EMBEDDED_LIBRARY)


def load_embedded_library():
    if not EMBEDDED_LIBRARY.exists():
        return
    try:
        data = json.loads(EMBEDDED_LIBRARY.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            STATE["library_data"] = data
            refresh_store_view()
    except (OSError, json.JSONDecodeError):
        pass


def refresh_store_view():
    STATE["stores"] = []
    for name, value in STATE["library_data"].items():
        rows = value.get("rows", {}) if isinstance(value, dict) else {}
        STATE["stores"].append({"name": name, "rows": rows, "duplicates": [], "columns": {}})
    if STATE["stores"] and STATE["selected_store"] not in {s["name"] for s in STATE["stores"]}:
        STATE["selected_store"] = STATE["stores"][0]["name"]


def report_id(report):
    return report["id"]


def report_rows_for(report):
    rows = []
    for row in report["rows"]:
        match = report.get("matches", {}).get(row["sku"], {})
        rows.append({
            "sku": row["sku"], "name": row["name"], "brand": row["brand"],
            "size": match.get("size", ""), "price": match.get("price", ""),
            "amount": row["amount"],
            "status": "已匹配" if match.get("size") and match.get("price") else "待补充",
        })
    return rows


def suggest_store(filename):
    base = Path(filename).stem.lower()
    candidates = []
    for store in STATE["stores"]:
        name = store["name"]
        compact = name.lower().replace("店", "")
        if compact and compact in base:
            candidates.append((len(compact), name))
        tokens = [token for token in re.split(r"[\s_\-]+", compact) if len(token) >= 2]
        score = sum(token in base for token in tokens)
        if score:
            candidates.append((score, name))
    return max(candidates)[1] if candidates else ""


def choose_file(title):
    root = Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    path = filedialog.askopenfilename(title=title, filetypes=[("Excel 文件", "*.xlsx")])
    root.destroy()
    return path


def choose_files(title):
    root = Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    paths = filedialog.askopenfilenames(title=title, filetypes=[("Excel 文件", "*.xlsx")])
    root.destroy()
    return list(paths)


def clear_analysis():
    STATE["matches"] = {}
    STATE["analyzed_store"] = ""
    for report in STATE["reports"]:
        report["matches"] = {}


def all_result_rows():
    return [row for report in STATE["reports"] for row in report_rows_for(report)]


def state_view():
    active = next((r for r in STATE["reports"] if r["id"] == STATE["active_report_id"]), STATE["reports"][0] if STATE["reports"] else None)
    rows = report_rows_for(active) if active else []
    all_rows = all_result_rows()
    matched = sum(x["status"] == "已匹配" for x in all_rows)
    pending = len(all_rows) - matched
    size_options = sorted({r.get("size", "") for s in STATE["stores"] for r in s["rows"].values() if r.get("size")})
    price_options = sorted({r.get("price", "") for s in STATE["stores"] for r in s["rows"].values() if r.get("price")})
    return {
        "library": str(STATE["library_path"] or "内置匹配库"),
        "report": str(STATE["report_path"] or ""),
        "stores": [{"name": s["name"], "count": len(s["rows"]), "duplicates": s["duplicates"]} for s in STATE["stores"]],
        "reports": [{"id": r["id"], "name": Path(r["path"]).name, "path": r["path"], "store": r.get("store", ""), "suggested_store": r.get("suggested_store", ""), "count": len(r["rows"])} for r in STATE["reports"]],
        "active_report_id": active["id"] if active else "",
        "selected_store": STATE["selected_store"],
        "analyzed_store": STATE["analyzed_store"],
        "rows": rows,
        "metrics": {"store_count": len(STATE["stores"]), "report_count": len(all_rows), "matched": matched, "pending": pending, "amount": sum(x["amount"] for x in all_rows)},
        "options": {"sizes": size_options, "prices": price_options},
    }


def api_pick(payload):
    kind = payload.get("kind")
    if kind == "reports":
        return {"paths": choose_files("选择一个或多个平台导出报表")}
    path = choose_file("选择匹配库")
    return {"path": path}


def api_load(payload):
    kind = payload.get("kind")
    path = Path(str(payload.get("path", "")))
    if kind != "reports" and (not path.exists() or path.suffix.lower() != ".xlsx"):
        return {"error": "请选择有效的 .xlsx 文件"}
    try:
        if kind == "library":
            STATE["library_path"] = path
            imported = store_data_from_sheets(read_library(path))
            mode = payload.get("mode", "merge")
            if mode == "replace":
                STATE["library_data"] = imported
            else:
                for name, incoming in imported.items():
                    target = STATE["library_data"].setdefault(name, {"name": name, "rows": {}})
                    target.setdefault("rows", {}).update(incoming["rows"])
            persist_embedded_library()
            refresh_store_view()
        elif kind == "report":
            STATE["report_path"] = path
            rows = read_report(path)
            report = {"id": f"report-{int(time.time() * 1000000)}", "path": str(path), "rows": rows, "matches": {}, "store": "", "suggested_store": suggest_store(path.name)}
            STATE["reports"].append(report)
        elif kind == "reports":
            for raw in payload.get("paths", []):
                item = Path(str(raw))
                if item.exists() and item.suffix.lower() == ".xlsx" and not any(r["path"] == str(item) for r in STATE["reports"]):
                    report = {"id": f"report-{int(time.time() * 1000000)}-{len(STATE['reports'])}", "path": str(item), "rows": read_report(item), "matches": {}, "store": "", "suggested_store": suggest_store(item.name)}
                    STATE["reports"].append(report)
                    STATE["active_report_id"] = report["id"]
        else:
            return {"error": "未知文件类型"}
        clear_analysis()
        return {"ok": True, "state": state_view()}
    except Exception as exc:
        return {"error": str(exc)}


def api_select_store(payload):
    name = str(payload.get("store", ""))
    if not any(s["name"] == name for s in STATE["stores"]):
        return {"error": "店铺不存在"}
    STATE["selected_store"] = name
    clear_analysis()
    return {"ok": True, "state": state_view()}


def api_report_store(payload):
    report = next((r for r in STATE["reports"] if r["id"] == payload.get("id")), None)
    name = str(payload.get("store", ""))
    if not report or name not in {s["name"] for s in STATE["stores"]}:
        return {"error": "报表或店铺不存在"}
    report["store"] = name
    report["matches"] = {}
    STATE["analyzed_store"] = ""
    return {"ok": True, "state": state_view()}


def api_report_select(payload):
    if not any(r["id"] == payload.get("id") for r in STATE["reports"]):
        return {"error": "报表不存在"}
    STATE["active_report_id"] = payload["id"]
    return {"ok": True, "state": state_view()}


def api_report_remove(payload):
    STATE["reports"] = [r for r in STATE["reports"] if r["id"] != payload.get("id")]
    STATE["active_report_id"] = STATE["reports"][0]["id"] if STATE["reports"] else ""
    clear_analysis()
    return {"ok": True, "state": state_view()}


def api_analyze(_payload):
    if not STATE["stores"] or not STATE["reports"]:
        return {"error": "请先导入匹配库和至少一个平台导出报表"}
    for report in STATE["reports"]:
        if not report.get("store"):
            report["store"] = report.get("suggested_store") or STATE["selected_store"]
        if not report["store"]:
            return {"error": f"请为报表 {Path(report['path']).name} 选择店铺"}
        duplicate_report_skus = sorted({row["sku"] for row in report["rows"] if sum(x["sku"] == row["sku"] for x in report["rows"]) > 1})
        if duplicate_report_skus:
            return {"error": f"榜单 {Path(report['path']).name} 中存在重复 SKU：{', '.join(duplicate_report_skus[:10])}"}
        store = next(s for s in STATE["stores"] if s["name"] == report["store"])
        report["matches"] = {sku: dict(value) for sku, value in store["rows"].items()}
    first = STATE["reports"][0]
    STATE["active_report_id"] = STATE["active_report_id"] or first["id"]
    STATE["matches"] = first["matches"]
    STATE["analyzed_store"] = first.get("store", "")
    return {"ok": True, "state": state_view()}


def api_edit(payload):
    target_id = payload.get("report_id") or STATE["active_report_id"]
    report = next((r for r in STATE["reports"] if r["id"] == target_id), STATE["reports"][0] if STATE["reports"] else None)
    if not report or not report.get("matches"):
        return {"error": "请先分析当前报表"}
    sku = sku_key(payload.get("sku"))
    size = str(payload.get("size", "")).strip()
    price = str(payload.get("price", "")).strip()
    if not sku or not size or not price:
        return {"error": "SKU、尺寸段和价格段都不能为空"}
    current = report["matches"].get(sku, {})
    report["matches"][sku] = {"sku": sku, "size": size, "price": price, "row": current.get("row")}
    STATE["matches"] = report["matches"]
    return {"ok": True, "state": state_view()}


def build_statistics():
    groups = []
    for report in STATE["reports"]:
        rows = report_rows_for(report)
        bucket = next((x for x in groups if x["name"] == report.get("store")), None)
        if not bucket:
            bucket = {"name": report.get("store") or Path(report["path"]).stem, "amount": 0, "brands": {}}
            groups.append(bucket)
        for row in rows:
            bucket["amount"] += row["amount"]
            bucket["brands"][row["brand"] or "未标注品牌"] = bucket["brands"].get(row["brand"] or "未标注品牌", 0) + row["amount"]
    for bucket in groups:
        bucket["ranking"] = sorted(bucket["brands"].items(), key=lambda item: item[1], reverse=True)
    return groups


def style_sheet(ws):
    for cell in ws[1]:
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = PatternFill("solid", fgColor="4768c4")
    ws.freeze_panes = "A2"
    ws.auto_filter.ref = ws.dimensions


def sync_original_library():
    if not STATE["library_path"] or not Path(STATE["library_path"]).exists():
        return {"backup": "", "added": 0}
    library_path = Path(STATE["library_path"])
    backup = backup_path(library_path)
    shutil.copy2(library_path, backup)
    workbook = load_workbook(library_path)
    added = 0
    try:
        for store_name, data in STATE["library_data"].items():
            if store_name not in workbook.sheetnames:
                continue
            ws = workbook[store_name]
            headers = {str(ws.cell(1, col).value).strip().lower(): col for col in range(1, ws.max_column + 1) if ws.cell(1, col).value}
            sku_col = next((headers.get(x) for x in ("商品编号", "sku", "sku（商品编码）", "商品编码") if headers.get(x)), None)
            size_col = next((headers.get(x) for x in ("尺寸段", "尺寸") if headers.get(x)), None)
            price_col = next((headers.get(x) for x in ("价格段", "价格段(17段)", "价格") if headers.get(x)), None)
            if not sku_col or not size_col or not price_col:
                continue
            name_col = next((headers.get(x) for x in ("商品名称", "商品名") if headers.get(x)), None)
            brand_col = next((headers.get(x) for x in ("品牌", "品牌名称") if headers.get(x)), None)
            by_sku = {sku_key(ws.cell(row, sku_col).value): row for row in range(2, ws.max_row + 1) if sku_key(ws.cell(row, sku_col).value)}
            report_rows = [row for report in STATE["reports"] if report.get("store") == store_name for row in report["rows"]]
            for sku, match in data.get("rows", {}).items():
                target = by_sku.get(sku)
                source = next((row for row in report_rows if row["sku"] == sku), None)
                if target is None and source:
                    target = ws.max_row + 1
                    ws.cell(target, sku_col, sku)
                    if name_col: ws.cell(target, name_col, source["name"])
                    if brand_col: ws.cell(target, brand_col, source["brand"])
                    by_sku[sku] = target
                    added += 1
                if target:
                    ws.cell(target, size_col, match.get("size", ""))
                    ws.cell(target, price_col, match.get("price", ""))
        temp_path = library_path.with_name(f".{library_path.stem}.tmp_{datetime.now().strftime('%Y%m%d_%H%M%S_%f')}.xlsx")
        workbook.save(temp_path)
        os.replace(temp_path, library_path)
    finally:
        workbook.close()
        if 'temp_path' in locals() and temp_path.exists():
            temp_path.unlink()
    return {"backup": str(backup), "added": added}


def write_library_and_export():
    for report in STATE["reports"]:
        store_name = report.get("store")
        if not store_name or not report.get("matches"):
            continue
        store_data = STATE["library_data"].setdefault(store_name, {"name": store_name, "rows": {}})
        rows = store_data.setdefault("rows", {})
        for source in report["rows"]:
            match = report["matches"].get(source["sku"])
            if match:
                rows[source["sku"]] = {"sku": source["sku"], "size": match.get("size", ""), "price": match.get("price", "")}
    refresh_store_view()
    persist_embedded_library()
    synced = sync_original_library()
    output_dir = Path(STATE["reports"][0]["path"]).parent if STATE["reports"] else ROOT / "outputs"
    output = output_dir / f"市占率配对与统计结果_{datetime.now().strftime('%Y%m%d_%H%M%S_%f')}.xlsx"
    out_wb = Workbook()
    out_wb.remove(out_wb.active)
    stats = build_statistics()
    ws_stats = out_wb.create_sheet("统计结果")
    ws_stats.append(["电商平台月度品牌市占率结果"])
    ws_stats.append(["品类/店铺", "总成交金额", "品牌", "销售金额", "占比"])
    for bucket in stats:
        for rank, (brand, amount) in enumerate(bucket["ranking"], 1):
            ws_stats.append([bucket["name"], bucket["amount"] if rank == 1 else "", brand, amount, amount / bucket["amount"] if bucket["amount"] else 0])
    style_sheet(ws_stats)
    ws_stats.column_dimensions["A"].width = 28
    ws_stats.column_dimensions["B"].width = 16
    ws_stats.column_dimensions["C"].width = 28
    ws_stats.column_dimensions["D"].width = 16
    ws_stats.column_dimensions["E"].width = 12
    for report_index, report in enumerate(STATE["reports"], 1):
        title = f"配对_{report_index}"
        ws = out_wb.create_sheet(title)
        ws.append(OUTPUT_HEADERS + ["处理店铺"])
        for row in report_rows_for(report):
            ws.append([row["sku"], row["name"], row["brand"], row["size"], row["price"], row["amount"], report.get("store", "")])
        style_sheet(ws)
        for index, width in enumerate([18, 55, 18, 14, 20, 14, 22], 1):
            ws.column_dimensions[chr(64 + index)].width = width
    out_wb.save(output)
    return {"output": str(output), "backup": synced["backup"], "added": synced["added"], "pending": sum(x["status"] != "已匹配" for x in all_result_rows())}


def export_embedded_library():
    output = ROOT / "outputs" / f"内置匹配库_{datetime.now().strftime('%Y%m%d_%H%M%S')}.xlsx"
    output.parent.mkdir(parents=True, exist_ok=True)
    workbook = Workbook()
    workbook.remove(workbook.active)
    for name, data in STATE["library_data"].items():
        ws = workbook.create_sheet(name[:31] or "匹配库")
        ws.append(["商品编号", "尺寸段", "价格段"])
        for row in data.get("rows", {}).values():
            ws.append([row.get("sku", ""), row.get("size", ""), row.get("price", "")])
        style_sheet(ws)
        ws.column_dimensions["A"].width = 20
        ws.column_dimensions["B"].width = 16
        ws.column_dimensions["C"].width = 22
    workbook.save(output)
    return output


def api_save(_payload):
    if not STATE["reports"] or not any(r.get("matches") for r in STATE["reports"]):
        return {"error": "请先分析报表"}
    try:
        return {"ok": True, **write_library_and_export()}
    except Exception as exc:
        return {"error": str(exc)}


def api_ping(_payload):
    LAST_PING["time"] = time.time()
    return {"ok": True}


ROUTES = {
    "/api/state": lambda p: state_view(),
    "/api/pick": api_pick,
    "/api/load": api_load,
    "/api/store": api_select_store,
    "/api/report-store": api_report_store,
    "/api/report-select": api_report_select,
    "/api/report-remove": api_report_remove,
    "/api/analyze": api_analyze,
    "/api/edit": api_edit,
    "/api/save": api_save,
    "/api/ping": api_ping,
}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(UI_DIR), **kwargs)

    def log_message(self, _fmt, *_args):
        pass

    def _json(self, body, code=200):
        raw = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/library-export":
            output = export_embedded_library()
            raw = output.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
            self.send_header("Content-Disposition", f"attachment; filename=match_library.xlsx; filename*=UTF-8''{quote(output.name)}")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
            return
        if path in ROUTES:
            return self._json(ROUTES[path]({}))
        if path in ("", "/"):
            self.path = "/index.html"
        return super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path
        fn = ROUTES.get(path)
        if not fn:
            return self._json({"error": "未知接口"}, 404)
        size = int(self.headers.get("Content-Length", 0))
        try:
            payload = json.loads(self.rfile.read(size).decode("utf-8")) if size else {}
            with LOCK:
                result = fn(payload)
            return self._json(result)
        except Exception as exc:
            traceback.print_exc()
            return self._json({"error": f"{type(exc).__name__}: {exc}"}, 500)


def start_server():
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{port}/"


def open_browser(url):
    candidates = [
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    ]
    for browser in candidates:
        if os.path.exists(browser):
            profile = os.path.join(os.environ.get("TEMP", str(ROOT / "work")), "market_share_liquid_ui")
            try:
                import subprocess
                subprocess.Popen([browser, f"--app={url}", f"--user-data-dir={profile}", "--window-size=1380,900", "--no-proxy-server"])
                return
            except Exception:
                pass
    webbrowser.open(url)


if __name__ == "__main__":
    load_embedded_library()
    server, url = start_server()
    print(f"MARKET_SHARE_URL={url}", flush=True)
    threading.Thread(target=lambda: (time.sleep(0.8), open_browser(url)), daemon=True).start()
    try:
        while True:
            time.sleep(3)
            if LAST_PING["time"] and time.time() - LAST_PING["time"] > 30:
                break
    except KeyboardInterrupt:
        pass
    server.shutdown()
