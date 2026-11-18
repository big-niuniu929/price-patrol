from __future__ import annotations

import re
import os
import shutil
import sys
import tempfile
from datetime import datetime
from pathlib import Path
from tkinter import END, BOTH, LEFT, RIGHT, X, Y, Canvas, StringVar, Tk, Toplevel, filedialog, messagebox
from tkinter import ttk

from openpyxl import Workbook, load_workbook
from openpyxl.styles import Font, PatternFill


OUTPUT_HEADERS = ["商品编号", "商品名称", "品牌名称", "尺寸段", "价格段", "成交金额"]
SKU_HEADERS = {"sku（商品编码）", "sku", "商品编号", "商品编码"}
SIZE_HEADERS = {"尺寸段", "尺寸"}
PRICE_HEADERS = {"价格段", "价格段(17段)", "价格"}
NAME_HEADERS = {"商品名称", "商品名"}
BRAND_HEADERS = {"品牌", "品牌名称"}


def text(value) -> str:
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    if isinstance(value, int):
        return str(value)
    return str(value).strip()


def header_map(ws):
    result = {}
    for index, value in enumerate(next(ws.iter_rows(min_row=1, max_row=1, values_only=True)), 1):
        key = text(value).lower()
        if key:
            result[key] = index
    return result


def find_column(headers, candidates, required=True):
    for candidate in candidates:
        if candidate.lower() in headers:
            return headers[candidate.lower()]
    if required:
        raise ValueError(f"缺少必要列：{'、'.join(candidates)}")
    return None


def sku_key(value):
    return text(value)


def parse_amount_range(value):
    raw = text(value).replace(",", "").replace("，", "")
    numbers = re.findall(r"\d+(?:\.\d+)?", raw)
    if len(numbers) < 2:
        raise ValueError(f"无法解析成交金额区间：{raw or '空值'}")
    return (float(numbers[0]) + float(numbers[1])) / 2


def read_library(path):
    workbook = load_workbook(path)
    stores = []
    for ws in workbook.worksheets:
        headers = header_map(ws)
        if not headers:
            continue
        try:
            sku_col = find_column(headers, SKU_HEADERS)
            size_col = find_column(headers, SIZE_HEADERS)
            price_col = find_column(headers, PRICE_HEADERS)
        except ValueError as exc:
            raise ValueError(f"工作表“{ws.title}”格式不完整：{exc}") from exc
        name_col = find_column(headers, NAME_HEADERS, required=False)
        brand_col = find_column(headers, BRAND_HEADERS, required=False)
        records = {}
        duplicates = []
        for row in range(2, ws.max_row + 1):
            sku = sku_key(ws.cell(row, sku_col).value)
            if not sku:
                continue
            record = {
                "sku": sku,
                "size": text(ws.cell(row, size_col).value),
                "price": text(ws.cell(row, price_col).value),
                "row": row,
            }
            if sku in records:
                duplicates.append(sku)
            records[sku] = record
        stores.append({
            "name": ws.title,
            "rows": records,
            "duplicates": duplicates,
            "columns": {"sku": sku_col, "size": size_col, "price": price_col,
                         "name": name_col, "brand": brand_col},
        })
    workbook.close()
    return stores


def read_report(path):
    workbook = load_workbook(path, data_only=True, read_only=True)
    ws = workbook.active
    headers = header_map(ws)
    try:
        sku_col = find_column(headers, {"商品编号", "sku", "sku（商品编码）"})
        name_col = find_column(headers, {"商品名称"})
        brand_col = find_column(headers, {"品牌名称", "品牌"})
        amount_col = find_column(headers, {"成交金额"})
    except ValueError as exc:
        raise ValueError(f"榜单格式不完整：{exc}") from exc
    rows = []
    for row in range(2, ws.max_row + 1):
        sku = sku_key(ws.cell(row, sku_col).value)
        if not sku:
            continue
        rows.append({
            "sku": sku,
            "name": text(ws.cell(row, name_col).value),
            "brand": text(ws.cell(row, brand_col).value),
            "amount_raw": text(ws.cell(row, amount_col).value),
            "amount": parse_amount_range(ws.cell(row, amount_col).value),
        })
    workbook.close()
    return rows


def backup_path(path):
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    return path.with_name(f"{path.stem}_备份_{stamp}{path.suffix}")


class App:
    def __init__(self, root):
        self.root = root
        self.root.title("市占率报表加工程序")
        self.root.geometry("1120x680")
        self.library_path = None
        self.report_path = None
        self.stores = []
        self.report_rows = []
        self.matches = {}
        self.missing = []
        self.analyzed_store = None
        self.liquid_phase = 0
        self._build_ui()

    def _build_ui(self):
        self.root.configure(bg="#0c1118")
        self.root.minsize(1000, 640)
        style = ttk.Style(self.root)
        style.theme_use("clam")
        style.configure("App.TFrame", background="#0c1118")
        style.configure("Sidebar.TFrame", background="#111a24")
        style.configure("Glass.TFrame", background="#1b2b38")
        style.configure("Glass.TLabelframe", background="#1b2b38", bordercolor="#6f9baa", relief="solid")
        style.configure("Glass.TLabelframe.Label", background="#1b2b38", foreground="#c9f5fb", font=("Segoe UI", 10, "bold"))
        style.configure("Title.TLabel", background="#1b2b38", foreground="#f5fdff", font=("Segoe UI", 22, "bold"))
        style.configure("Section.TLabel", background="#1b2b38", foreground="#a7cbd3", font=("Segoe UI", 10))
        style.configure("SidebarTitle.TLabel", background="#111a24", foreground="#f4fdff", font=("Segoe UI", 14, "bold"))
        style.configure("SidebarSmall.TLabel", background="#111a24", foreground="#7fa3ad", font=("Segoe UI", 9))
        style.configure("Nav.TLabel", background="#111a24", foreground="#8eabb4", font=("Segoe UI", 10), padding=(10, 12))
        style.configure("ActiveNav.TLabel", background="#294553", foreground="#aef7ff", font=("Segoe UI", 10, "bold"), padding=(10, 12))
        style.configure("MetricName.TLabel", background="#1b2b38", foreground="#9bc2ca", font=("Segoe UI", 9))
        style.configure("MetricValue.TLabel", background="#1b2b38", foreground="#f1feff", font=("Consolas", 22, "bold"))
        style.configure("Path.TLabel", background="#1b2b38", foreground="#c0d8dd", font=("Segoe UI", 9))
        style.configure("Status.TLabel", background="#1b2b38", foreground="#aef7ff", font=("Segoe UI", 9, "bold"))
        style.configure("Ghost.TButton", background="#203743", foreground="#d7f1f4", bordercolor="#82b7c1", padding=(14, 8), font=("Segoe UI", 9, "bold"))
        style.map("Ghost.TButton", background=[("active", "#315665"), ("pressed", "#162832")], foreground=[("active", "#ffffff")])
        style.configure("Primary.TButton", background="#147f91", foreground="#f0ffff", bordercolor="#b1f8ff", padding=(16, 9), font=("Segoe UI", 9, "bold"))
        style.map("Primary.TButton", background=[("active", "#2baabc"), ("pressed", "#0d5662")], foreground=[("active", "#ffffff")])
        style.configure("Warm.TButton", background="#80642c", foreground="#fff7da", bordercolor="#ffe29a", padding=(14, 8), font=("Segoe UI", 9, "bold"))
        style.map("Warm.TButton", background=[("active", "#aa8742"), ("pressed", "#59451e")])
        style.configure("Dark.TCombobox", fieldbackground="#13212b", background="#13212b", foreground="#e5faff", arrowcolor="#aef7ff", bordercolor="#82b7c1", padding=5)
        style.map("Dark.TCombobox", fieldbackground=[("readonly", "#13212b")], foreground=[("readonly", "#e5faff")])
        style.configure("Glass.Treeview", background="#13212b", fieldbackground="#13212b", foreground="#e4f7fa", bordercolor="#6f9baa", rowheight=28, font=("Segoe UI", 9))
        style.configure("Glass.Treeview.Heading", background="#294553", foreground="#e9fbfd", relief="flat", font=("Segoe UI", 9, "bold"))
        style.map("Glass.Treeview", background=[("selected", "#248b9d")], foreground=[("selected", "#ffffff")])

        frame = ttk.Frame(self.root, style="App.TFrame")
        frame.pack(fill=BOTH, expand=True)
        frame.columnconfigure(1, weight=1)
        frame.rowconfigure(0, weight=1)

        sidebar = ttk.Frame(frame, width=220, style="Sidebar.TFrame")
        sidebar.grid(row=0, column=0, sticky="nsew")
        sidebar.grid_propagate(False)
        ttk.Label(sidebar, text="MARKET / SHARE", style="SidebarTitle.TLabel").pack(anchor="w", padx=24, pady=(28, 4))
        ttk.Label(sidebar, text="MONTHLY DATA STUDIO", style="SidebarSmall.TLabel").pack(anchor="w", padx=24, pady=(0, 34))
        for label, active in (("配对工作台", True), ("匹配库管理", False), ("统计与看板", False)):
            ttk.Label(sidebar, text=f"  {label}", style="ActiveNav.TLabel" if active else "Nav.TLabel").pack(fill=X, padx=14, pady=3)
        ttk.Label(sidebar, text="", style="SidebarSmall.TLabel").pack(expand=True, fill=Y)
        ttk.Label(sidebar, text="LOCAL WORKSPACE", style="SidebarSmall.TLabel").pack(anchor="w", padx=24, pady=(0, 4))
        ttk.Label(sidebar, text="v0.1  /  CORE ONLINE", style="SidebarSmall.TLabel").pack(anchor="w", padx=24, pady=(0, 24))

        content = ttk.Frame(frame, padding=(24, 18, 24, 16), style="App.TFrame")
        content.grid(row=0, column=1, sticky="nsew")
        content.columnconfigure(0, weight=1)
        content.rowconfigure(3, weight=1)

        topbar = ttk.Frame(content, style="Glass.TFrame", padding=(18, 12))
        topbar.grid(row=0, column=0, sticky="ew", pady=(0, 14))
        topbar.columnconfigure(0, weight=1)
        ttk.Label(topbar, text="市占率配对工作台", style="Title.TLabel").grid(row=0, column=0, sticky="w")
        ttk.Label(topbar, text="SKU MATCHING / MONTHLY WORKFLOW", style="Section.TLabel").grid(row=1, column=0, sticky="w", pady=(3, 0))
        self.status = StringVar(value="请选择匹配库和平台导出报表。")
        ttk.Label(topbar, textvariable=self.status, style="Status.TLabel").grid(row=0, column=1, rowspan=2, padx=(18, 0), sticky="e")
        self.liquid_canvas = Canvas(topbar, height=4, bg="#1b2b38", highlightthickness=0, bd=0)
        self.liquid_canvas.grid(row=2, column=0, columnspan=2, sticky="ew", pady=(10, 0))
        self.animate_liquid_light()

        metrics = ttk.Frame(content, style="App.TFrame")
        metrics.grid(row=1, column=0, sticky="ew", pady=(0, 14))
        for i in range(4):
            metrics.columnconfigure(i, weight=1)
        self.metric_vars = [StringVar(value="--") for _ in range(4)]
        metric_specs = [("店铺工作表", "当前匹配库"), ("榜单商品", "本次导入"), ("待补充 SKU", "需要人工确认"), ("成交金额", "中位值单位：万元")]
        for i, (name, hint) in enumerate(metric_specs):
            card = ttk.Frame(metrics, style="Glass.TFrame", padding=(16, 12))
            card.grid(row=0, column=i, sticky="ew", padx=(0 if i == 0 else 6, 0))
            ttk.Label(card, text=name, style="MetricName.TLabel").pack(anchor="w")
            ttk.Label(card, textvariable=self.metric_vars[i], style="MetricValue.TLabel").pack(anchor="w", pady=(4, 0))
            ttk.Label(card, text=hint, style="MetricName.TLabel").pack(anchor="w", pady=(2, 0))

        files = ttk.LabelFrame(content, text="  数据源与店铺  ", padding=12, style="Glass.TLabelframe")
        files.grid(row=2, column=0, sticky="ew", pady=(0, 14))
        files.columnconfigure(1, weight=1)
        self.library_label = StringVar(value="未选择匹配库")
        self.report_label = StringVar(value="未选择平台导出报表")
        ttk.Button(files, text="选择匹配库", style="Ghost.TButton", command=self.choose_library).grid(row=0, column=0, padx=(0, 10), pady=4)
        ttk.Label(files, textvariable=self.library_label, style="Path.TLabel").grid(row=0, column=1, sticky="ew")
        ttk.Button(files, text="选择导出报表", style="Ghost.TButton", command=self.choose_report).grid(row=1, column=0, padx=(0, 10), pady=4)
        ttk.Label(files, textvariable=self.report_label, style="Path.TLabel").grid(row=1, column=1, sticky="ew")
        ttk.Label(files, text="店铺", style="Section.TLabel").grid(row=0, column=2, padx=(20, 8), sticky="e")
        self.store_var = StringVar()
        self.store_combo = ttk.Combobox(files, textvariable=self.store_var, state="readonly", width=22, style="Dark.TCombobox")
        self.store_combo.grid(row=0, column=3, padx=(0, 4), sticky="ew")
        self.store_combo.bind("<<ComboboxSelected>>", self.on_store_changed)

        table_card = ttk.LabelFrame(content, text="  配对明细  ", padding=10, style="Glass.TLabelframe")
        table_card.grid(row=3, column=0, sticky="nsew")
        table_card.columnconfigure(0, weight=1)
        table_card.rowconfigure(0, weight=1)
        table_frame = ttk.Frame(table_card, style="Glass.TFrame")
        table_frame.grid(row=0, column=0, sticky="nsew")
        table_frame.columnconfigure(0, weight=1)
        table_frame.rowconfigure(0, weight=1)
        columns = ("sku", "name", "brand", "size", "price", "amount", "status")
        self.tree = ttk.Treeview(table_frame, columns=columns, show="headings", style="Glass.Treeview")
        labels = {"sku": "商品编号", "name": "商品名称", "brand": "品牌名称", "size": "尺寸段",
                  "price": "价格段", "amount": "成交金额", "status": "匹配状态"}
        widths = {"sku": 125, "name": 330, "brand": 120, "size": 100, "price": 140, "amount": 90, "status": 90}
        for col in columns:
            self.tree.heading(col, text=labels[col])
            self.tree.column(col, width=widths[col], anchor="w")
        yscroll = ttk.Scrollbar(table_frame, orient="vertical", command=self.tree.yview)
        xscroll = ttk.Scrollbar(table_frame, orient="horizontal", command=self.tree.xview)
        self.tree.configure(yscrollcommand=yscroll.set, xscrollcommand=xscroll.set)
        self.tree.grid(row=0, column=0, sticky="nsew")
        yscroll.grid(row=0, column=1, sticky="ns")
        xscroll.grid(row=1, column=0, sticky="ew")

        toolbar = ttk.Frame(content, style="Glass.TFrame", padding=(12, 10))
        toolbar.grid(row=4, column=0, sticky="ew", pady=(14, 0))
        ttk.Button(toolbar, text="分析匹配", style="Primary.TButton", command=self.analyze).pack(side=LEFT, padx=(0, 8))
        ttk.Button(toolbar, text="编辑选中 SKU", style="Warm.TButton", command=self.edit_selected).pack(side=LEFT, padx=8)
        ttk.Button(toolbar, text="写回匹配库并导出", style="Primary.TButton", command=self.save_and_export).pack(side=RIGHT)

        self.refresh_metrics()

    def animate_liquid_light(self):
        if not self.liquid_canvas.winfo_exists():
            return
        width = max(self.liquid_canvas.winfo_width(), 240)
        phase = self.liquid_phase % (width + 220) - 220
        self.liquid_canvas.delete("all")
        self.liquid_canvas.create_rectangle(0, 1, width, 3, fill="#315866", outline="")
        self.liquid_canvas.create_rectangle(phase, 0, phase + 150, 4, fill="#9ef7ff", outline="")
        self.liquid_canvas.create_rectangle(phase + 30, 0, phase + 90, 4, fill="#ffffff", outline="")
        self.liquid_phase += 12
        self.root.after(90, self.animate_liquid_light)

    def refresh_metrics(self):
        if not hasattr(self, "metric_vars"):
            return
        self.metric_vars[0].set(str(len(self.stores)) if self.stores else "--")
        self.metric_vars[1].set(str(len(self.report_rows)) if self.report_rows else "--")
        self.metric_vars[2].set(str(len(self.missing)) if self.report_rows else "--")
        total = sum(row["amount"] for row in self.report_rows) if self.report_rows else 0
        self.metric_vars[3].set(f"{total:,.0f}" if self.report_rows else "--")

    def choose_library(self):
        path = filedialog.askopenfilename(title="选择匹配库", filetypes=[("Excel 文件", "*.xlsx")])
        if not path:
            return
        try:
            stores = read_library(Path(path))
        except Exception as exc:
            messagebox.showerror("读取失败", str(exc))
            return
        self.library_path = Path(path)
        self.stores = stores
        self.matches = {}
        self.missing = []
        self.analyzed_store = None
        self.refresh_tree()
        self.library_label.set(str(self.library_path))
        self.store_combo["values"] = [s["name"] for s in stores]
        if stores:
            self.store_combo.current(0)
        self.refresh_metrics()
        self.status.set(f"已读取 {len(stores)} 个店铺工作表。")

    def choose_report(self):
        path = filedialog.askopenfilename(title="选择平台导出报表", filetypes=[("Excel 文件", "*.xlsx")])
        if not path:
            return
        try:
            rows = read_report(Path(path))
        except Exception as exc:
            messagebox.showerror("读取失败", str(exc))
            return
        self.report_path = Path(path)
        self.report_rows = rows
        self.matches = {}
        self.missing = []
        self.analyzed_store = None
        self.refresh_tree()
        self.report_label.set(str(self.report_path))
        self.refresh_metrics()
        self.status.set(f"已读取 {len(rows)} 条榜单记录。")

    def analyze(self):
        if not self.library_path or not self.report_path or not self.store_var.get():
            messagebox.showwarning("信息不完整", "请先选择匹配库、导出报表和店铺。")
            return
        duplicate_report_skus = sorted({r["sku"] for r in self.report_rows if sum(x["sku"] == r["sku"] for x in self.report_rows) > 1})
        if duplicate_report_skus:
            messagebox.showerror("榜单有重复 SKU", f"请先清理重复商品编号：{', '.join(duplicate_report_skus[:10])}")
            return
        store = next((s for s in self.stores if s["name"] == self.store_var.get()), None)
        if store is None:
            messagebox.showwarning("店铺未选择", "请选择本次处理的店铺。")
            return
        if store["duplicates"]:
            messagebox.showerror("匹配库有重复 SKU", f"店铺“{store['name']}”存在重复 SKU：{', '.join(store['duplicates'][:10])}")
            return
        self.matches = store["rows"]
        self.analyzed_store = store["name"]
        self.missing = [r for r in self.report_rows if r["sku"] not in self.matches]
        self.refresh_tree()
        self.refresh_metrics()
        self.status.set(f"分析完成：{len(self.report_rows) - len(self.missing)} 条已匹配，{len(self.missing)} 条待补充。")

    def refresh_tree(self):
        for item in self.tree.get_children():
            self.tree.delete(item)
        for index, row in enumerate(self.report_rows):
            match = self.matches.get(row["sku"], {})
            status = "已匹配" if match.get("size") and match.get("price") else "待补充"
            self.tree.insert("", END, iid=f"report-{index}", values=(
                row["sku"], row["name"], row["brand"], match.get("size", ""),
                match.get("price", ""), f"{row['amount']:g}", status,
            ))

    def on_store_changed(self, _event=None):
        self.matches = {}
        self.missing = []
        self.analyzed_store = None
        self.refresh_tree()
        self.refresh_metrics()
        self.status.set(f"已选择店铺“{self.store_var.get()}”，请点击分析匹配。")

    def edit_selected(self):
        selected = self.tree.selection()
        if not selected:
            messagebox.showinfo("请选择记录", "请先选择一条待补充或需要修改的 SKU。")
            return
        sku = self.tree.item(selected[0], "values")[0]
        report = next(r for r in self.report_rows if r["sku"] == sku)
        current = self.matches.get(sku, {})
        dialog = Toplevel(self.root)
        dialog.title(f"编辑 SKU {sku}")
        dialog.transient(self.root)
        dialog.grab_set()
        ttk.Label(dialog, text=f"SKU：{sku}").grid(row=0, column=0, columnspan=2, padx=12, pady=10, sticky="w")
        ttk.Label(dialog, text="尺寸段").grid(row=1, column=0, padx=12, pady=6, sticky="e")
        size = StringVar(value=current.get("size", ""))
        ttk.Entry(dialog, textvariable=size, width=30).grid(row=1, column=1, padx=12, pady=6)
        ttk.Label(dialog, text="价格段").grid(row=2, column=0, padx=12, pady=6, sticky="e")
        price = StringVar(value=current.get("price", ""))
        ttk.Entry(dialog, textvariable=price, width=30).grid(row=2, column=1, padx=12, pady=6)

        def confirm():
            if not size.get().strip() or not price.get().strip():
                messagebox.showwarning("信息不完整", "尺寸段和价格段都必须填写。", parent=dialog)
                return
            self.matches[sku] = {"sku": sku, "size": size.get().strip(), "price": price.get().strip(), "row": None}
            self.missing = [r for r in self.report_rows if r["sku"] not in self.matches]
            self.refresh_tree()
            self.refresh_metrics()
            dialog.destroy()
            self.status.set(f"已补充 {sku}，剩余 {len(self.missing)} 条待补充。")

        ttk.Button(dialog, text="保存", command=confirm).grid(row=3, column=0, columnspan=2, pady=12)

    def save_and_export(self):
        if not self.library_path or not self.report_path or not self.store_var.get():
            messagebox.showwarning("信息不完整", "请先完成文件选择、店铺选择和分析。")
            return
        if self.analyzed_store != self.store_var.get():
            messagebox.showwarning("尚未分析", "店铺已变化，请先点击“分析匹配”。")
            return
        if not self.report_rows:
            messagebox.showwarning("没有数据", "当前没有可导出的榜单记录。")
            return
        unresolved = [r["sku"] for r in self.report_rows if not self.matches.get(r["sku"], {}).get("size") or not self.matches.get(r["sku"], {}).get("price")]
        if unresolved:
            messagebox.showwarning("仍有未匹配 SKU", f"请先补充 {len(unresolved)} 条记录，例如：{', '.join(unresolved[:5])}")
            return
        try:
            backup = backup_path(self.library_path)
            shutil.copy2(self.library_path, backup)
            workbook = load_workbook(self.library_path)
            ws = workbook[self.store_var.get()]
            store = next(s for s in self.stores if s["name"] == self.store_var.get())
            cols = store["columns"]
            by_sku = {}
            for row in range(2, ws.max_row + 1):
                key = sku_key(ws.cell(row, cols["sku"]).value)
                if key:
                    by_sku[key] = row
            added = 0
            for report in self.report_rows:
                match = self.matches[report["sku"]]
                target = by_sku.get(report["sku"])
                if target is None:
                    target = ws.max_row + 1
                    ws.cell(target, cols["sku"], report["sku"])
                    if cols["name"]:
                        ws.cell(target, cols["name"], report["name"])
                    if cols["brand"]:
                        ws.cell(target, cols["brand"], report["brand"])
                    added += 1
                ws.cell(target, cols["size"], match["size"])
                ws.cell(target, cols["price"], match["price"])
            output = self.export_result()
            temp_path = self.library_path.with_name(f".{self.library_path.stem}.tmp_{datetime.now().strftime('%Y%m%d_%H%M%S_%f')}.xlsx")
            try:
                workbook.save(temp_path)
                os.replace(temp_path, self.library_path)
            finally:
                if temp_path.exists():
                    temp_path.unlink()
            workbook.close()
            messagebox.showinfo("处理完成", f"匹配库已写回。\n备份：{backup.name}\n新增/写入记录：{added}\n结果：{output.name}")
            self.refresh_metrics()
            self.status.set(f"完成：已写回匹配库并导出 {output.name}。")
        except Exception as exc:
            messagebox.showerror("保存失败", str(exc))

    def export_result(self):
        output = self.report_path.with_name(f"{self.report_path.stem}_配对结果_{datetime.now().strftime('%Y%m%d_%H%M%S_%f')}.xlsx")
        workbook = Workbook()
        ws = workbook.active
        ws.title = "配对结果"
        ws.append(OUTPUT_HEADERS)
        for cell in ws[1]:
            cell.font = Font(bold=True, color="FFFFFF")
            cell.fill = PatternFill("solid", fgColor="1F4E78")
        for report in self.report_rows:
            match = self.matches[report["sku"]]
            ws.append([report["sku"], report["name"], report["brand"], match["size"], match["price"], report["amount"]])
        ws.freeze_panes = "A2"
        ws.auto_filter.ref = ws.dimensions
        widths = [18, 55, 18, 14, 20, 14]
        for index, width in enumerate(widths, 1):
            ws.column_dimensions[chr(64 + index)].width = width
        workbook.save(output)
        return output


def main():
    root = Tk()
    App(root)
    root.mainloop()


if __name__ == "__main__":
    main()
