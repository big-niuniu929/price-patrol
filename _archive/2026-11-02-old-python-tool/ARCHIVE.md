# 旧工具归档/删除方案（Lead 执行记录）

> 用户要求：「工作区里有一个工具，你读取之后，把他删了，然后重构一下。因为原本的这个根本不好用，一直报错。」
> 处理原则：**先归档、验证新工具后从工作区移除**，避免不可逆丢失（旧匹配库数据已迁移进新插件种子）。

## 1. 旧工具资产盘点

| 路径 | 内容 | 处理 |
|---|---|---|
| `app.py` | 旧 Tk 界面 + 核心读取/匹配逻辑 | 归档 |
| `web_app.py` | 旧本地 HTTP 服务 + Edge 应用窗口 | 归档 |
| `ui/` | 旧网页 UI（index.html/app.js/style.css） | 归档 |
| `data/match_library.json` | 旧内置匹配库（4 店，已迁移） | 归档（数据已并入 `extension/data/base-skus.json`） |
| `outputs/` | 旧生成的内部匹配库 xlsx 备份 | 归档 |
| `start.ps1`、`start_app.bat`、`requirements.txt` | 旧启动脚本与依赖 | 归档 |
| `README.md`（旧） | 旧工具说明 | 归档（新 README 由 docs-qa 产出） |
| `python-3.12.0-amd64.exe` | 旧工具附带的 Python 安装包（26MB，新插件不再需要） | 归档 |
| `市占率报表加工程序使用说明书.docx` | 旧工具说明书 | 归档（已被新 README/使用说明取代） |
| `work/` | 旧开发脚手架（build_manual.py、截图、competition_pdf 等） | 归档（新开发文件在 `work/` 会重建） |
| `__pycache__/` | Python 缓存 | 直接删除 |

## 2. 归档目标

```
_archive/2026-11-02-old-python-tool/
  app.py  web_app.py  ui/  data/  outputs/  start.ps1  start_app.bat
  requirements.txt  README.md  python-3.12.0-amd64.exe
  市占率报表加工程序使用说明书.docx
  old-work/            # 原 work/ 内容
  ARCHIVE.md           # 本说明 + 迁移结论
```

保留在根目录的新内容：`DESIGN.md`、`README.md`(新)、`extension/`、`tools/`、`tests/`、`dev-tools/`、`docs/`、`_archive/`。

## 3. 迁移结论（已验证）

- 旧 `data/match_library.json` 与 `资料/匹配库.xlsx` 已合并生成 `extension/data/base-skus.json`：
  4 个类目 / 1046 SKU / 588 条尺寸段+价格段齐全（`tools/build_base_from_xlsx.py` 可随时重建）。
- 旧工具的导出列（商品编号/商品名称/品牌名称/尺寸段/价格段/成交金额）与统计口径已被新插件的
  `buildResultWorkbook` / `buildBackfillWorkbook` 覆盖并增强（回填原榜单 + 按类目/尺寸段/价格段的市占率）。
- 旧工具的老鼠洞（表头硬编码、active sheet 取错、read_only 维度坑、依赖 Python 环境）在新插件里
  由 `lib/header-map.js`、`pickDataSheet`、自研 `xlsx-read.js`、纯浏览器运行分别解决。

## 4. 回滚方式

如果新工具不可用：`Move-Item _archive/2026-11-02-old-python-tool/* .` 即可恢复旧文件；
`data/match_library.json` 原样保留在归档里，可重新喂给旧工具。
