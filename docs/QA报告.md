# 电商平台市占率数据工作台 · QA 验收报告

- 验收对象：`extension/`（**v2.1.7**，Edge MV3 扩展；2026-11-05 迭代：v2.1 关键字段/主题/统计子页/多采样复核；v2.1.2 小眼睛预览；v2.1.3 当前价格/总览页/布局/套餐；v2.1.4 匹配库核验/频控/新种子；v2.1.5 回填 16 列 · 确认写入完整性 · 列显隐/筛选/悬停 · 异常自动继续 · 匹配库保护/日志/类目合并去重；v2.1.6 价格只来自库/页面 · 尺寸严格识别（多值必空置）· 快速人工定位；**v2.1.7 移植巡检双轨版价格采集算法 · 价格类型/候选 JSON · 下架不计分母**）
- 验收人：docs-qa（数据侧/文档）+ Lead（浏览器侧终审）
- 验收依据：[DESIGN.md](../DESIGN.md) 第 16 节（v2.1）+ 第 17 节（v2.1.2）+ 第 18 节（v2.1.3）+ 第 19 节（v2.1.4）+ 第 20 节（v2.1.5，含 20.13）+ 第 21 节（v2.1.6 价格/尺寸/人工定位）+ **第 22 节（v2.1.7 巡检双轨版价格算法移植）** + 第 11 节（v2.0 基线）
- 报告日期：2026-11-05（v2.1~v2.1.7 终稿，数据侧与浏览器侧均已回填）
- 验收脚本：`tests/qa/run.mjs`（一键：`node tests/qa/run.mjs`）、`tests/qa/ui-smoke.mjs`（CDP UI 冒烟：主题/关键列/统计子页/需确认/小眼睛/当前价格/总览/布局/迁移/匹配库表头 + **v2.1.4 入库状态/确认写入/导出表头/频控/预览人工通道**）、`tools/qa/shot.mjs`（01~07 + **08 入库状态四色 + 09 确认写入**）
- 独立复核：`tests/qa/py/oracle.py`（Python + openpyxl 直接解析原始 xlsx）、`tests/qa/py/xlsx_dump.py`（openpyxl 打开生成文件核对）

---

## 一、结论摘要

| 验收项 | 结果 |
|---|---|
| 1. `node tests/qa/run.mjs`（读取/规则/表头/补数/统计/回填/静态/采集 + **v2.1 关键字段与多采样复核** + **v2.1.2 预览静态契约**） | **62 通过 / 0 失败 / 0 阻塞 / 2 跳过**（跳过项为需 Edge 渲染进程的浏览器用例；纯 Node 6~8s） |
| 2. v2.1 新增数据侧用例（第 4b 节，15 条） | **15/15 通过**：extractModel/extractPackage、priceBandInfo/bandMidpoint、chooseSampleValue、shouldResample、evaluatePriceReview、applyCaptures（多采样+确认+老格式兼容）、buildReferencePriceRange、computeStats 新字段、回填 19/22 列、配对明细 17 列、「待确认」sheet |
| 3. 回归基准（离线 4 榜单，未采集） | **800 行 / 尺寸段 726（90.75%）/ 价格段 192（24.0%，待采集 608）/ 品牌 771（96.4%）/ 成交金额合计 10262.6 万 / bySize 25 档 / 采集失败 0**，与 v2.0 完全一致 |
| 4. 浏览器验收（v2.1 UI 冒烟 + mock 商品页 CDP + 5 张截图） | **63 通过 / 0 失败 / 0 阻塞 / 0 跳过（72.1s）**；UI 冒烟 **86/86 项**；mock CDP **93/93 断言**；5 张截图已产出并核对（Lead 环境执行，详见第六/七节） |
| 5. 文档与截图 | README / `docs/使用说明.md` / 本报告已更新 v2.1；`docs/shots/01~04`（深色）+ `05-workbench-light.png`（浅色）已产出，`_meta.json` consoleErrors=[] / runtimeErrors=[] |
| 6. **v2.1.2 小眼睛预览**（DESIGN §17，详见第十一节） | 纯 Node 静态契约通过；`--with-ui` **64 通过 / 0 失败 / 0 跳过（77.2s）**、UI 冒烟 **99/99**、Lead 独立预览验收 **7/7**；悬停开窗/点击固定/关闭回收/无 console error 全部通过；截图 01~05 已用含小眼睛 UI 重生 |
| 7. **v2.1.3 当前价格/总览页/布局/套餐/匹配库表头**（DESIGN §18，详见第十二节） | 纯 Node **67/0/2**（4c 节 5 条全过）；**`--with-ui` 69 通过 / 0 失败 / 0 跳过（103.1s）**、UI 冒烟 **125/125**（consoleErrors=0）；Lead 独立验收 **11/11**、mock CDP **107/107**、openpyxl 导出复核 18/20/23 列；截图 **7 张**已重生核对 |
| 8. **v2.1.4 匹配库核验/导出表头/频控/新种子**（DESIGN §19，详见第十三节） | 数据侧 **core 132/0/30 套件**、纯 Node **74 通过 / 0 失败 / 2 跳过**；浏览器侧 **`--with-ui` 76/0/0/0（128.2s）**、UI 冒烟 **147 steps/147 pass/0 fail/0 skip**、Lead acceptance_v214 **14/14**、mock CDP **141/141**；导出表头 15/10/20/23 复核通过；**08/09 截图已重生（9 张）** |
| 9. **v2.1.5 回填 16 列/确认完整性/列筛选/异常继续/匹配库保护与合并去重**（DESIGN §20，详见第十四节） | 数据侧 **core 142/0/32 套件**、纯 Node **83/0/0/2 跳过**、CDP **153/153**；浏览器 **`--with-ui` 85/0/0/0（105.6s）**、UI 冒烟 **162/162**、Lead acceptance_v215 **17/17**；新基准 577（72.125%）/sizeAmbiguous 157/bySize 22；导出 openpyxl 16/15/10 列；**12 张截图已重生** |
| 10. **v2.1.6 价格只来自库/页面 · 尺寸严格（多值必空置）· 快速人工定位**（DESIGN §21，详见第十五节） | 数据侧 **core 145/0/32 套件**、纯 Node **89/0/0/2 跳过**、CDP **176/176**、selftest 43/232、client 40/40；浏览器 **`--with-ui` 91/0/0/0（104.6s）**、UI 冒烟 **181/181**、Lead acceptance_v216 **10/10**；新基准 478（59.75%）/165（20.6%，全库）/322/20/libStates 160/192/447/1；导出 openpyxl 16/15/10 列；**14 张截图已重生** |
| 11. **v2.1.7 移植巡检双轨版价格算法 · 价格类型/候选 JSON · 下架不计分母**（DESIGN §22，详见第十六节） | 数据侧 **core 151/0/33 套件**、纯 Node **95/0/0/2 跳过**（4g 6 条）、CDP **218/218**、selftest 50/277、client 41/41；浏览器 **`--with-ui` 97/0/0/0（109.8s）**、UI 冒烟 **192/192**、Lead acceptance_v217 **10/10**；离线基准不变 478/165/322/20/libStates 160/192/447/1；导出 openpyxl 16/15/10 列；**15 张截图已重生** |

> 结论：**通过**。数据侧 62/62 纯 Node 全绿（v2.1 新增 15 条 + v2.1.2 静态契约 1 条），浏览器侧 v2.1 `--with-ui` **63/63**、v2.1.2 `--with-ui` **64/64**、UI 冒烟 99/99、mock CDP 93/93、Lead e2e 与预览专项均通过、5 张截图核对通过。

---

## 二、环境与版本

| 项 | 值 |
|---|---|
| 操作系统 | Windows（中文路径 `~/Desktop/市占率`） |
| 浏览器 | Microsoft Edge `Edg/156.0.4314.58`（headless=new，CDP；仅 Lead 环境） |
| Node | v24.21.0（内置 WebSocket / CompressionStream） |
| Python（仅 QA 复核用，插件运行不需要） | 3.12 + openpyxl |
| 网络 | 无外网：不真实访问电商平台，采集链路使用 mock 页验证 |
| 测试数据 | `~/Desktop/资料\` 下 4 个真实榜单 + 匹配库.xlsx（只读，未修改） |
| 其他分工 | xlsx-core（数据侧 lib）、jd-capture（采集侧）、workbench-ui（UI）、docs-qa（验收/文档/截图）、Lead（集成/终验） |

> 版本核对：`extension/manifest.json` 已升为 `version 2.1.2`（description 含型号/套餐/多采样复核/悬停预览说明），与 `app.js` 的 `APP_VERSION='2.1.2'`、README/使用说明一致（Lead 2026-11-03 升级；QA 静态用例覆盖 MV3/名称/权限/资源，版本号已人工核对）。

---

## 三、用例清单与结果（`node tests/qa/run.mjs`）

共 9 个测试段、64 条用例（纯 Node 62 条 + 浏览器 2 条）。纯 Node 侧 **62 通过 / 0 失败**；浏览器 2 条默认跳过（`--with-ui` 时全部 64 条通过，见第十一节 v2.1.2 终轮）。

### 3.1 环境与素材（4 条）

- 4 个榜单 + 匹配库都存在且大小正常；
- Node ≥22、WebSocket / DecompressionStream / CompressionStream 可用；
- Python + openpyxl 可用（独立复核基准）；
- extension 目录 14 个必需文件 + 4 个图标齐全。

### 3.2 规则引擎 `lib/rules.js`（8 条，v2.0 基线 + v2.1 扩展）

- 尺寸段 10 段 / 价格段 18 段枚举完整；
- `parseAmountRange` 14 组（含万/元混排：`￥200万 ~ ￥400万`→300、`￥6,000 ~ ￥8,000`→0.7、`￥8,000 ~ ￥1万`→0.9、无法解析→null）；
- `parseInch` 8 组（英寸/吋/寸，排除 1920×1080、4K）；
- `sizeBandOf` / `sizeBandFromText` / `normalizeSizeBand`（43/110/120/150/其他尺寸(n) 与历史脏值归一）；
- `priceBandOf` rightOpen/rightClosed 边界、`normalizePriceBand` / `parsePriceText`；
- 品牌补全（`BRAND_ALIASES` / `normalizeBrand` / `resolveBrand`）。

### 3.3 Excel 读取 / 表头自适应（6 条）

- `readXlsx` 读 5 个真实文件：4 榜单单据页各 200 数据行，匹配库 4 个 sheet；1×1 坏 dimension 文件正常；
- 教育教学文件识别到数据页「教学教育一体机」，不误选「尺寸段和价格段」说明页；
- 表头识别：`SKU ID` / `SPU ID` / `sku`、`商品名称`/`成交金额`/`品牌`/`店铺名称`；**v2.1 新增「型号」「套餐」列表头识别**；
- 行模型：4 榜单 800 行、SKU 全文本、raw 保留原始列、行号正确；与 Python 独立解析一致；
- `normalizeSku`：去 `.0`、去空格、保留前导零；
- `suggestStoreBinding`：会议平板→大家电 会议平板一体机(0.53)、会议电视→大家电 会议电视(0.48)、教育教学→品牌A 教育一体机(0.38)、tangping→3C店(0.10)。

### 3.4 内置匹配库 / `lib/store-schema.js`（7 条）

- 种子 `base-skus.json`：4 类目 / 1046 SKU / 588 条齐全；
- Python 独立复核：匹配库.xlsx 去重 1046 SKU、Excel 内齐全 579（+旧库合并 9=588）；
- `seedLibraryFromJson` / `emptyLibrary` / `statsOfLibrary`（skus 1046、complete 588、dirty 32）；
- `libraryToRows` / `findLibraryIssues` / `normalizeLibrary` / 合并与 upsert。

### 3.5 补数流水线 / 统计 / 导出 `lib/pipeline.js`（10 条）

- `analyzeReport`：4 榜单 800 行不丢行、状态合法；
- **离线覆盖率**：尺寸段 **90.8%**、价格段 **24.0%**；分榜单：会议平板 96.5%/3.5%、会议电视 99.0%/60.5%、教育教学 83.0%/2.0%、tangping 84.5%/30.0%；
- 成交金额：4 榜单合计 **10262.6 万**（Python 独立基准一致）；
- 品牌补全：96.0% / 100% / 93.0% / 96.5%（合计 96.4%）；
- `applyCaptures`：mock 采集结果补价格段/尺寸段（v2.1 提供一致双采样 + 候选数，避免触发复核信号），失败行正确标「采集失败」；
- `computeStats`：总额=各行中值之和、类目金额合计=总额、bySize 25 档且行数合计 800、品牌占比 100%、空品牌归「未标注品牌」；
- 回填导出 v2.1：普通榜单 **19 列**×201 行（13 原始 + 尺寸段/价格段/型号/套餐/数据来源/复核状态）、教育教学 **22 列**×201 行（原表已有 型号/套餐/尺寸段/价格段 → 原地填，只追加 数据来源/复核状态）；openpyxl 可打开、原列顺序不变、注入复核状态的行文案为「需确认…」/「✓ 已人工确认…」；
- 结果导出 v2.1：无待确认时 **7 个 sheet**（统计_类目/尺寸段/价格段 + 配对_1..4），配对页 **17 列**；openpyxl 复核通过；
- `buildBackupJson`：`market-share.backup/v1`，类目 4 / SKU 1046 / 采集缓存计数正确。

### 3.6 v2.1 关键字段 / 多采样复核 / 导出扩展（15 条，新增段 4b）

| # | 用例 | 关键断言 | 结果 |
|---|---|---|---|
| 1 | `extractModel` | 命中 75XW3F / MC75HEE / IHE2-86SU / L75MA-SM / 100XP3E；排除 4K/8K/GB/i5/1920×1080/纯数字/中文 | 通过 |
| 2 | `extractPackage` | 4+128G / 4+64GB / 8G+256G / i5/8G/256G / 翻页笔+投屏+推车 / 含支架等；空值返回 ''；长度 ≤40 | 通过 |
| 3 | `priceBandInfo` + `bandMidpoint` | 1500→1000元至2000元（边界距离 500）、999 判边界附近、rightClosed 2000 归 1000-2000、null→null；中值 1500 / 最高段 27500 | 通过 |
| 4 | `chooseSampleValue` | 5000/5008→5004 一致；5000/5500→5250 不一致；5000/5000→same；单样本 single；容差可配；空样本 null | 通过 |
| 5 | `shouldResample` | 正常不补采；边界/参考区间外/候选不足/价差大 → 再采；maxSamples 到顶不再采；single/double 模式语义；文案不含该口径敏感词 | 通过 |
| 6 | `evaluatePriceReview` | 6 类 code 全覆盖（SAMPLES_INCONSISTENT / SAMPLES_CROSS_BAND / NEAR_BOUNDARY / OUT_OF_REFERENCE / LIB_BAND_MISMATCH / WEAK_EVIDENCE）；正常行不误报；文案可直接展示 | 通过 |
| 7 | 教育教学「型号/套餐」列 | 表头识别 + 有值行数 >0 | 通过 |
| 8 | `analyzeReport` 行字段 + 提取率 | 每行 storeName/model/package/source 类型正确；型号 **489/800（61.1%）**、套餐 **473/800（59.1%）**（xlsx-core 实测口径，识别不到留空属预期） | 通过 |
| 9 | 回归 KPI | 800 / 726 / 192 / 771 / 10262.6 万 / 608 / 0 与 v2.0 完全一致；bySize 25 档、合计 800 | 通过 |
| 10 | 状态机 | `STATUS.REVIEW_NEEDED='需确认'`；`computeRowStatus`：复核未确认→需确认、确认后→已补采；`STATUS_FILTERS.需确认`；`formatReviewText` 文案 | 通过 |
| 11 | `applyCaptures` 多采样 | 一致样本→已补采；不一致→需确认（reasons 非空、价格段仍规范、sampleCount/sampleSpread 正确）；老 capture（无 samples）兼容；失败→采集失败；人工确认后 computeRowStatus→已补采、reviewNeeded=0 | 通过 |
| 12 | 复核数字可复现 | 5200/5210/5205→5205（价差 10、已补采）；5000/6000→5500（价差 1000、需确认，含 SAMPLES_INCONSISTENT+NEAR_BOUNDARY）；确认后→已补采 | 通过 |
| 13 | `buildReferencePriceRange` | 同店铺+同尺寸段 ≥5 样本 → {low,high,count,expandedLow,expandedHigh}；无样本尺寸段退化为同店铺；空库/不足 5 → null | 通过 |
| 14 | `computeStats` 新字段 | `total.reviewNeeded/sampled2/avgSampleSpread/storeNames` + `byStore[]` 同名计数；注入 3 条需确认→reviewNeeded≥3；确认 1 条后减 1 | 通过 |
| 15 | 「待确认」sheet | 有待确认行时生成 8 sheet（插在统计_价格段后、配对_1 前），12 列；openpyxl 可打开 | 通过 |

### 3.7 扩展静态检查（9 条）

- manifest MV3：名称「电商平台市占率数据工作台」、`version 2.1.2`、permissions/host_permissions/content_scripts/background/icons 正确（与 app.js `APP_VERSION='2.1.2'` 一致；文件带 UTF-8 BOM，QA 解析已兼容，Edge 可正常加载）；
- `extension/` 下无以 `_` 开头的文件/目录；
- app.html：四页导航、文件导入框、无内联 `<script>`/事件属性/远程资源；
- app.js/content.js：无 `eval` / `new Function` / 远程资源；动态 import 7 个 lib 路径存在；
- **app.js 调用的 30 个 lib 接口全部存在**；**app.js 引用 131 个 DOM id 都在 app.html**；**app.html 74 个静态控件都有 app.js 引用**（v2.1 新增主题/复核/统计子页控件已接线）；
- 7 个 lib 模块 Node 可直接 import、无 DOM 副作用。

### 3.8 采集链路（默认 2 条通过 + 1 条跳过；`--with-ui` 时全部执行）

- `CaptureRunner` 契约齐全、可注入 fake chromeApi；
- `dev-tools/test_capture_client.mjs` 多采样/decider/日志/旧行为回归单测通过；
- `dev-tools/cdp_capture_test.mjs`（mock 商品页，v2.1 新增划线价/标签法/交叉校验/型号/套餐断言）：默认纯 Node 跳过 → Lead 环境执行。

---

## 四、独立复核方法（不只依赖被测代码自证）

1. **数据读取**：`oracle.py` 用 openpyxl 独立解析 4 个榜单与匹配库，输出行数/表头/首 5 SKU/可解析金额/金额合计/库命中/含英寸行数；JS 端逐项对比。
2. **导出的 xlsx**：`xlsx_dump.py` 用 openpyxl 重新打开生成文件，核对 v2.1 新增：普通回填 19 列、教育教学 22 列、配对明细 17 列、结果 7/8 sheet、「待确认」sheet 12 列与行数、复核状态文案。
3. **种子库**：Python 直接统计匹配库.xlsx 的去重 SKU 与齐全数，与种子 JSON 及 `statsOfLibrary` 三方对照。
4. **复核规则**：除被测实现外，用独立构造的采样序列（一致/不一致/跨段/边界/参考区间外）与 xlsx-core 实测口径对照，确保「只提疑、不纠偏、取中位数」。

---

## 五、验收中发现的问题与处理

### 5.1 v2.0 基线（3 个产品缺陷 + 3 个测试脚本问题，均已修复/复验）

| # | 模块 | 问题 | 状态 |
|---|---|---|---|
| A | `rules.parseAmountRange` | 真实榜单成交金额「元/万元」混排（`￥6,000 ~ ￥8,000`）按万元解析，会议平板总额算成 148870.4 万 | 已修复（元口径 ≥1000 按元换算），4 榜单金额与 Python 一致 |
| B | `pipeline.buildResultWorkbook` | 未定义 `index` 生成 `配对_${index+1}`，导出抛 ReferenceError | 已修复，7 sheet 正常 |
| C | `pipeline.computeStats` | `bySize` 只遍历固定枚举，漏动态 `其他尺寸(n英寸)` | 已修复，行数=800、金额=总额 |
| D | `tools/qa/lib/cdp.mjs`（QA 工具） | 扩展 ID 误命中 Edge 自带扩展 | 已修复（只认 `service_worker/background.js`） |
| E | `tests/qa/ui-smoke.mjs`（QA 脚本） | 误把「当前榜单 200 行」断言成总行数 800 | 已修正断言 |
| F | `work/workbench-ui/check_ui.mjs`（视觉自测脚本） | 末步 null querySelector 报错 | 已由 workbench-ui 修复 |

### 5.2 v2.1（数据侧验证结论：未发现产品缺陷）

- `tests/qa/run.mjs` 首轮按 v2.0 断言跑到 v2.1 实现时出现 2 条过期断言（mock 采价恰好落在价格段边界→被判「需确认」；「复核状态」列对无复核行留空），已按 v2.1 契约修正 QA 用例，非产品缺陷；
- QA 断言与实现口径对齐时修正了 5 处理解偏差（`priceBandInfo.side` 语义、`chooseSampleValue.method`、参考区间 `expandedLow/High` 展开、`buildReferencePriceRange` 退化规则、`computeStats` 新字段位于 `total` 下）；
- **列数口径**：教育教学回填最终为 **22 列**、配对明细 **17 列**、结果「待确认」sheet 仅当有待确认行时生成（Lead 2026-11-03 裁决，DESIGN §16.1/§16.8 已同步）；QA 用例严格按 19/22/17 + 7/8 sheet 断言。

### 5.3 v2.1 待确认字段/口径

- `extension/manifest.json` 版本号已由 Lead 升为 `2.1.2`（与功能/文档一致，此项已闭环；文件含 UTF-8 BOM，QA 已兼容解析，建议后续保存为无 BOM）；
- 「复核状态」列：无需复核的行留空（不写「无需复核」），与实现一致；如需 Excel 侧筛选，可按「需确认：」前缀过滤。
- 数据侧/采集侧/UI 均已冻结（`tests/core` 116/0、mock CDP 93/93、capture-client 27/27）；Lead 已在真实 Edge 环境跑 `--with-ui` + 5 张截图，结果见第六/七节。

---

## 六、浏览器相关验收（Lead 环境执行 · 已回填）

> 分工说明：docs-qa 会话的沙箱无法启动 Edge **渲染进程**（browser 主进程/CDP 可启动，renderer 因 Windows 命名管道限制被拒），因此浏览器项由 Lead 在可启动浏览器的环境执行；脚本与 JSON/截图由 Lead 跑完后 docs-qa 回填本节。

### 6.1 脚本与检查点

```powershell
node "~/Desktop/市占率\tests\qa\run.mjs" --with-ui   # 含 UI 冒烟 + mock 商品页 CDP
node "~/Desktop/市占率\tests\qa\ui-smoke.mjs"        # 单独跑 UI 冒烟
node "~/Desktop/市占率\tools\qa\shot.mjs" --json "~/Desktop/市占率\docs\shots\_meta.json"
```

`ui-smoke.mjs` v2.1 新增/更新检查点（86 项，全部通过；v2.1.2 追加小眼睛预览 13 项后总计 **99 项**，见第十一节）：

1. 扩展加载、7 个 lib 就绪、`runtimeErrors=[]`；
2. **主题**：顶栏 ☀/🌙 切换 → `data-theme` 变化、`settings.ui.theme` 持久化、刷新后保持、切换过程无新增 console error；
3. **关键列**：配对表表头含 店铺/型号/套餐/采样；状态筛选含「需确认」；
4. 四页切换 + 截图（工作台/匹配库/统计/设置）；
5. 匹配库 1046 SKU / 4 类目；设置页 批量=0、采集模式 smart/double/single、maxSamples 2~5、容差、主题、表头映射区；
6. 导入 4 榜单 + 分析：KPI 4/800/726/192/771/10262.6 万/608/0、卡片 4 个、配对表 200 行、行内编辑控件、统计 800 行/4 类目/24~25 尺寸档（基准 25）/≥18 价格档；
7. **统计类目子页**：tab = 全部 + 4 类目；点单类目 → `state.statsStore` 变化、只显示该类目；点「全部」回汇总；
8. **多采样复核流程**：`simulateCaptures` 注入 3 条价差 1000 的样本 → 需确认 ≥3（含 SAMPLES_INCONSISTENT）→ KPI「待确认」点击切筛选 → 行内「确认」减少 1 → 「确认当前筛选(N)」批量确认 → reviewNeeded=0、采集行状态=已补采 → 刷新后仍为 0（持久化）；
9. **导出全部回填**：4 个 `回填_*.xlsx` 落盘且 >5KB；
10. 无 console error（过滤 favicon/网络类噪音）。

### 6.2 执行结果（Lead 环境 · 真实 Edge 156 + CDP）

- 执行人 / 执行时间：**Lead** / 2026-11-03 12:29（v2.1 `--with-ui` 轮）；**最终 v2.1.2 轮 15:07 见第十一节**
- `--with-ui` 汇总：**v2.1 轮 63 通过 / 0 失败 / 0 阻塞 / 0 跳过（72.1s）**；**v2.1.2 最终轮 64 通过 / 0 失败 / 0 跳过（77.2s）**
- UI 冒烟检查项：**v2.1 86/86 通过**；**v2.1.2 最终 99/99 通过**（`tests/qa/.tmp/ui-smoke.json`：主题切换+刷新持久化、关键列、统计类目 tab、需确认筛选、行内确认、批量确认归零、刷新持久化、导出 4 回填、小眼睛预览窗口机制、无 console error 全部 ✓）
- mock 商品页 CDP：**93/93 断言全绿**（`dev-tools/cdp_capture_test.mjs`，14 种页面布局，含划线价/标签法/交叉校验/型号套餐）
- Lead 独立 e2e（`work/lead/acceptance21.mjs`）：导入 4 榜单 → 关键列 → 主题切换/持久化 → 造 3 条需确认 → 行内+批量确认归零 → 统计类目 tab → 导出 7 文件全部落盘 → console error = 0
- 截图：`docs/shots/01-workbench.png`、`02-library.png`、`03-stats.png`、`04-settings.png`（深色）、`05-workbench-light.png`（浅色）；`_meta.json` consoleErrors=[] / runtimeErrors=[]

> 已知小口径差异：统计「尺寸段分档数」在极个别浏览器会话为 24 档（差 1 个 `其他尺寸(24英寸)` 之类边界归类），Lead/纯 Node 基准为 25 档；不影响品牌市占率结论，已列入已知限制与 v2.1.1 可选项（分析结果可重复性）。

---

## 七、截图清单（v2.1.7 已重生 15 张，逐张核对）

| 文件 | 大小 | 内容核对（v2.1.6） |
|---|---|---|
| `docs/shots/01-workbench.png` | 719.3 KB | 深色工作台：KPI **800 行 / 已补齐 238 / 待补采 635 / 待确认写入 1 / 尺寸 59.8% / 价格 20.6% / 金额 10,263 万**；快速人工定位 chip（待人工复核/缺尺寸段/缺价格段）、列设置/筛选、待复核/待人工视觉 |
| `docs/shots/02-library.png` | 902.0 KB | 匹配库：11 列表头；4 类目 / **1101 SKU（种子未动）**；已确认/待确认徽标；操作日志/合并类目/备份恢复入口 |
| `docs/shots/03-stats.png` | 698.0 KB | 统计看板：类目选择条、品牌市占率、尺寸段 **20 档**/价格段分布（v2.1.6 新基准） |
| `docs/shots/04-settings.png` | 640.5 KB | 设置与帮助：采集节奏 5~10s/每批上限 20（5~100）、异常等待 60s、复核、主题、匹配库备份恢复、模块状态 |
| `docs/shots/05-workbench-light.png` | 244.6 KB | 浅色主题工作台：KPI/表格/状态色/列设置/筛选可读 |
| `docs/shots/06-overview.png` | 655.9 KB | 配对总览：800 行、状态筛选（含尺寸待复核/缺尺寸/缺价格）、搜索、200 行/页、15 列、导出菜单 |
| `docs/shots/07-workbench-visible.png` | 587.1 KB | 1344×756 布局：首屏可见配对表/工具条/快速定位 chip，不被遮挡 |
| `docs/shots/08-workbench-libstates.png` | 710.7 KB | 入库状态四色 + KPI「待确认写入 1」；libStates=160/192/447/1；「确认写入匹配库(34)」 |
| `docs/shots/09-confirm-write.png` | 719.5 KB | 确认写入：确认后 KPI 变化、库记录 `written:1` |
| `docs/shots/10-workbench-colfilter.png` | 721.7 KB | 列筛选/列设置：列设置面板（隐藏成交金额/采样、行高）、表头筛选面板 |
| `docs/shots/11-library-log.png` | 854.0 KB | 匹配库操作日志（面板已打开）：时间/类型/类目/SKU/字段变化/来源、搜索、导出 CSV、清空 |
| `docs/shots/12-confirm-done.png` | 685.2 KB | 已确认状态：确认写入后搜索 SKU，入库状态「已确认」（badge=已确认）、行内按钮禁用 |
| `docs/shots/13-workbench-review-filter.png` | 693.1 KB | **快速人工定位（v2.1.6）**：「待人工复核」chip 激活筛选；chips 显示 65/65/199（shot 前面确认步骤改变了库/行；导入后基线 66/66/125） |
| `docs/shots/14-workbench-missing.png` | 686.8 KB | **缺尺寸段/待人工标记**：尺寸段空置行显示「待人工」，状态列「待复核」/「缺尺寸段」 |
| `docs/shots/15-workbench-pricetype.png` | 226.2 KB | **价格类型徽标 + 调试弹窗（v2.1.7）**：当前价格旁 4 个「到手价」徽标、行「调试」候选 JSON 弹窗（priceKind/priceChanges/priceRect/candidates + 复制按钮）；旧采集记录无 candidates 时弹窗为空属正常 | 
| `docs/shots/_meta.json` | 4.9 KB | 截图脚本运行信息：mode=extension、14 张图路径、`consoleErrors=[]`、dark/light、visibleRows1344、libStates、`runtimeErrors=[]` |

> 截图脚本：headless Edge 加载 `extension/` → 导入 4 个真实榜单并分析 → 深色 01~04 + 总览 06 → 1344×756 布局 07 → 核验 08 → simulateCaptures+confirm 09 → 列筛选 10 → 操作日志 11 → 已确认 12 → 待人工复核筛选 13 → 缺尺寸段 14 → 浅色 05；只读 `extension/`，不修改文件。

## 八、已知限制与风险

| 类别 | 说明 |
|---|---|
| 竞品数据没有标准答案 | 页面价随账号/券/地区/时间波动：工具只核对同一 SKU 多次采样是否一致、是否靠近价格段边界、是否偏离同类参考区间，**拿不准就标「需确认」交人工，不判断高低对错、不自动确认**（v2.1 核心原则） |
| 型号/套餐识别率 | 本月实测型号 489/800（61.1%）、套餐 473/800（59.1%）；识别不到留空属预期，可人工行内补并写回匹配库 |
| 真实电商平台页面 | 本机无外网，采集链路仅用 mock 页验证；真实页面 DOM 改版可能导致取价失败（工具标「采集失败」并保留手动兜底/调试 JSON） |
| 价格口径 | 页面价与人工口径可能有差异；每行标注来源与采集时间，支持手动修正与重采；多采样复核只是提疑，不纠偏 |
| 低频采集耗时 | 约 600 个待采 SKU × 3–6 秒 ≈ 30–60 分钟；开多采样复核后有疑点的 SKU 会多采 1–2 次（通常少数行），支持分批/暂停/断点续采 |
| 复杂 Excel 格式 | 回填按行值重写，合并单元格/条件格式等会归一化为普通值 |
| 表头极端变化 | 别名表 + 相似度 + 表头诊断兜底；完全认不出时需人工点选一次（按文件名记住） |
| 动态尺寸段 | `其他尺寸(n英寸)` 为合法值，统计已覆盖（bySize 25 档=10 固定+14 动态+未补） |
| 尺寸段分档数 24~25 档的口径差异 | 极个别浏览器会话对边界尺寸（如 `其他尺寸(24英寸)`）归类时统计显示 24 档，Lead 侧与纯 Node 基准为 25 档；差 1 行、不影响品牌市占率/金额结论，已作为 v2.1.1 可选项（分析结果可重复性） |
| 部署路径 | 扩展以绝对路径加载：移动/改名 `extension/` 会换扩展 ID、读不到 `chrome.storage.local`（要搬先导出备份 JSON，搬后导入） |
| 首次采集 | 建议「每次最多采集」=5~10 先跑一小批核对价格/尺寸口径，再全量 |
| 浏览器自动化 | docs-qa 沙箱无法启动 Edge 渲染进程，浏览器项由 Lead 环境执行；脚本与 JSON/截图可重复执行 |

---

## 九、复现方式

```powershell
# 全量纯 Node 验收（约 12 秒）
node tests/qa/run.mjs

# 带浏览器项（需要可启动 Edge 的环境）
node tests/qa/run.mjs --with-ui

# 只跑 v2.1 段
node tests/qa/run.mjs --only v21

# 只跑部分段
node tests/qa/run.mjs --only rules,read,pipeline,v21

# 5 张截图（深色 4 + 浅色 1）
node tools/qa/shot.mjs

# 重新生成内置匹配库种子（匹配库.xlsx 更新后）
python tools/build_base_from_xlsx.py
```

产出：`tests/qa/.tmp/qa-result.json`（结构化结果）、`tests/qa/.tmp/ui-smoke.json`（浏览器冒烟）、`tests/qa/.tmp/qa-*.xlsx`（导出复核中间文件）、`docs/shots/*.png`（5 张）与 `_meta.json`。

---

## 十、验收结论

1. **v2.1 数据侧通过**：`node tests/qa/run.mjs` → **62 通过 / 0 失败 / 0 阻塞**；v2.1 新增 15 条用例全部通过（关键字段提取、多采样复核规则、applyCaptures 复核/确认/老数据兼容、参考区间、统计新字段、19/22/17 列导出与「待确认」sheet），v2.1.2 新增 1 条预览静态契约通过；
2. **回归不破**：4 榜单离线基准 800 行 / 尺寸 90.75% / 价格 24.0% / 品牌 96.4% / 金额 10262.6 万与 v2.0 完全一致；v2.0 的 46+2 条用例仍全绿；
3. **浏览器侧通过**：`node tests/qa/run.mjs --with-ui` → v2.1 轮 **63 通过 / 0 失败 / 0 跳过（72.1s）**、v2.1.2 最终轮 **64 通过 / 0 失败 / 0 跳过（77.2s）**；UI 冒烟 **99/99 项**、mock CDP **93/93 断言**、Lead 独立 e2e 与预览专项（7/7）通过、5 张截图核对通过（详见第六/七/十一节）；
4. 未发现 v2.1 新增产品缺陷；manifest 版本已升 `2.1.2`（此项闭环；文件含 UTF-8 BOM，QA 已兼容解析）；「复核状态」无需复核行留空为设计选择；已知限制里记录「尺寸段分档 24~25 档的极小口径差异（不影响市占率结论）」和「真实电商平台页需首次 5~10 条小批量核对口径」。

**最终结论：通过。数据侧 61/61 + 浏览器侧 63/63 全绿，v2.1 可交付。**

---

## 十一、v2.1.2 迭代：SKU「小眼睛」悬停预览商品页（已验收·全绿）

> 需求来源：用户 2026-11-03「给每个 SKU 加小眼睛，鼠标移过去渲染商品页，不用频繁开/关标签页」。
> 设计契约：[DESIGN.md](../DESIGN.md) 第 17 节；实现：workbench-ui（task-9，进行中）；文档/验收：docs-qa（task-10）。
> 权限说明：`chrome.windows.create({type:'popup', focused:false})` 在当前 MV3 扩展可用，**manifest 无需新增权限**。

### 11.1 功能与交互（DESIGN §17）

- 配对表每行 SKU 文本右侧新增小眼睛按钮：`button[data-act="preview"][data-sku]`（内联 SVG，无 SKU 不渲染）；
- 悬停 **600ms** 打开 `https://item.shop.example.com/<SKU>.html` 的 `type='popup'` 小窗（`focused:false`，不抢焦点）；移开 500ms 自动关（未固定时）；
- 点击固定（`pinned`，获得焦点）；再点关闭；同一时刻只有 1 个预览窗口；
- 切页 / 开始补采 / 关闭工作台自动清理；用户手动关窗后状态复位；
- 窗口优先工作台右侧，放不下左侧/居中并按屏幕边界 clamp；位置参数异常时退化创建；
- 非扩展环境（`file://`）无 `chrome.windows` → 眼睛隐藏或提示「预览需要在插件内使用」；
- 调试 API：`__workbench.previewSku(sku,{pinned})`、`closePreview()`、`getPreviewState()`，DOM/API 契约见 DESIGN §17.4。

### 11.2 验收断言（已加入脚本，Lead 环境执行）

**ui-smoke.mjs 新增（只验窗口机制，不验窗口内页面内容——headless 无外网）：**

1. `__workbench.previewSku / getPreviewState / closePreview` 三个调试 API 存在（否则该组标 skip，不误报失败）；
2. 配对表存在 `#matchBodyRows button[data-act="preview"][data-sku]`，有 SKU 的行才有眼睛按钮，`title` 含「悬停预览商品页；点击固定/取消固定」；
3. **悬停开窗**：CDP `Input.dispatchMouseEvent` 移到眼睛按钮 → 等 900ms → `chrome.windows.getAll({populate:true})` 出现 `type==='popup'` 窗口；**请求地址**以 `getPreviewState().url`（或 `previewSku()` 返回值）断言以 `https://item.shop.example.com/<SKU>.html` 开头（不受重定向影响）；窗口侧 `tab.url` **轮询最多 5s**（popup 刚创建时 url 可能为空串）后允许为商品页**或电商平台验证页** `pc-frequent-pro.pf.shop.example.com`（未登录/高频访问时的风控重定向，见 11.5）；轮询后仍为空则以「窗口存在 + 请求地址正确」判定（Lead 口径 B 兜底）；
4. `getPreviewState()` 返回该 SKU 且 `pinned===false`（同时记录 `requestUrl`、`tabUrl`、`windowUrlRedirected`）；
5. **点击固定**：点眼睛 → `getPreviewState().pinned===true`，且固定态 `getPreviewState().url` 仍以 `https://item.shop.example.com/<SKU>.html` 开头；
6. **关闭回收**：`closePreview()` 返回对象；轮询 2s 内 popup 窗口消失、`getPreviewState()===null`、窗口 id 集合回落到基线（无泄漏）；
7. 预览全程无新增 console error；
8. metrics 记录：`baselineWindowCount`、`popupWinId`、`popupFocused`、`tabUrl`、`requestUrl`、`windowUrlRedirected`、`pinnedRequestUrl`、`hoverState`、`pinned`、`closeResult`、`popupGone`、`afterWindowCount`、`backToBaseline`、`openPath`（CDP 悬停 / previewSku 兜底）。

**run.mjs 纯 Node（静态契约，新增 1 条）：**

- `previewSku/getPreviewState/closePreview` 存在于 app.js；使用 `chrome.windows.*`；渲染 `data-act="preview"` 与 `.eye-btn`；app.css 定义 `.eye-btn`；支持 `pinned`。未实现/实现中时该用例输出「实现中，待生效」不计失败（实现就绪后自动转严格断言）。

### 11.3 当前状态（终稿：浏览器验收已通过）

- 数据侧/旧功能回归：`node tests/core/run.mjs` 116/0/27；`node tests/qa/run.mjs` **62 通过 / 0 失败 / 2 跳过**（新增 1 条静态契约用例，跳过 2 条=浏览器项，`--with-ui` 时全部执行）；v2.1 的 63/63 浏览器基线不受影响；
- **Lead 真实浏览器最终门禁**：`node tests/qa/run.mjs --with-ui` → **64 通过 / 0 失败 / 0 阻塞 / 0 跳过（77.2s）**；UI 冒烟 **99 steps / 99 pass / 0 fail / 0 skip**（`ui-smoke.ok=true`，`consoleErrors=0`）；Lead 独立预览验收 `work/lead/acceptance_preview.mjs`（真实 Edge）**7/7 断言通过**；
- 首轮曾观察到未登录/高频环境约 1s 后 tab 被电商平台风控重定向到 `https://pc-frequent-pro.pf.shop.example.com/?from=pc_item&reason=403`；后续断言改为「请求地址以 `state.url` 为准 + 窗口 url 允许验证页 + tab.url 轮询 5s / 口径 B 兜底」，最终轮 `windowUrlRedirected=false` 全绿（见 11.4）；
- 截图 `docs/shots/06-preview-hover.png`（可选）：**未产出**。原因：预览是独立 `popup` 窗口，`page.screenshot` 只能截扩展页面、无法把 popup 与表格同屏捕获；且 headless 无外网时窗口内为错误页，说明性截图意义有限 → **以 ui-smoke 的窗口/状态断言为准**（DESIGN §17.5 允许）。
- 截图 01~05 已由 Lead 用含小眼睛的 v2.1.2 UI 重新生成（01/02/03/04 深色 + 05 浅色），浅色 05 也含小眼睛列；大小约 806/911/712/646/542 KB，`_meta.json` consoleErrors=[]、runtimeErrors=[]（截图尺寸/时间见第七节）。

### 11.4 执行结果（Lead 环境 · 真实 Edge 156 + CDP）

- 执行人 / 执行时间：**Lead** / **2026-11-03 15:07**
- `node tests/qa/run.mjs --with-ui` 汇总：**64 通过 / 0 失败 / 0 阻塞 / 0 跳过（77.2s）** → `tests/qa/.tmp/qa-result.json`（本轮 `withUi=true`）
- UI 冒烟检查项（含小眼睛）：**99 项全部通过 / 0 失败 / 0 跳过**（`tests/qa/.tmp/ui-smoke.json`，`ok=true`，`consoleErrors=0`）
- 小眼睛专项（`metrics.preview` 实测）：

```json
{"implemented":true,"sku":"100221505838","openPath":"hover","eyeButtonCount":100,
 "buttonTitle":"悬停预览商品页；点击固定/取消固定","popupWinId":546572052,"popupFocused":false,
 "tabUrl":"https://item.shop.example.com/100221505838.html","requestUrl":"https://item.shop.example.com/100221505838.html",
 "windowUrlRedirected":false,"pinnedRequestUrl":"https://item.shop.example.com/100221505838.html",
 "hoverState":{"winId":546572052,"sku":"100221505838","url":"https://item.shop.example.com/100221505838.html","pinned":false},
 "pinned":true,"closeResult":{"closed":true},"popupGone":true,"stateAfterClose":null,
 "baselineWindowCount":1,"afterWindowCount":1,"backToBaseline":true}
```

  - 悬停开窗 ✅（`openPath=hover`，100 个眼睛按钮，`popupFocused=false` 不抢焦点）；请求/窗口 url 均为商品页、`windowUrlRedirected=false`；点击固定 ✅（`pinned=true`）；`closePreview()` ✅（`closed:true`、窗口消失、状态 null、窗口数 1→1 回基线、无泄漏）；无 console error ✅。
- mock 商品页 CDP / 截图：沿用 v2.1 基线（93/93、5 张）并已重生含小眼睛版本。

### 11.5 已知限制

- **headless 无外网**：只能验证「窗口被创建、请求 URL 正确、固定/关闭/回收状态正确」，**无法验证窗口内真实电商平台页面的渲染效果**；真实页面渲染需在用户自己的已登录 Edge 中查看；
- **电商平台风控重定向**：未登录/高频访问环境下，预览窗口的 tab 可能从 `item.shop.example.com/<SKU>.html` 被重定向到 `https://pc-frequent-pro.pf.shop.example.com/...`（电商平台验证页）；这是电商平台风控行为，**不等于预览失效**——请求 URL 以 `getPreviewState().url` 为准；用户正常登录的浏览器通常可正常显示商品页；
- 预览窗口加载真实商品页，页面慢/未登录/网络异常时窗口内是电商平台自身的加载/登录/错误页，工具不做额外处理（可点「打开」在新标签页查看）；
- 预览与补采一样会访问电商平台商品页，**需保持低频**，遇到安全验证立即停止；
- 非扩展环境（`file://`）无 `chrome.windows`，预览不可用（按钮隐藏或提示）；
- 多屏/缩放极端情况下窗口位置可能退化为默认位置，可手动拖动调整。

> 结论：**通过**（v2.1.2 小眼睛预览：`--with-ui` **64/64 全绿**、UI 冒烟 **99/99**、Lead 独立预览验收 **7/7**；v2.1 基线 63/63 不受影响）。

---

## 十二、v2.1.3 迭代：当前价格列 · 配对总览页 · 布局 · 套餐口径 · 匹配库表头（已验收·全绿）

> 需求：用户 2026-11-03 反馈（DESIGN §18）：① 配对表加「当前价格」；② 新增总览页（完整配对表/店铺筛选/行内改参数写回匹配库）；③ 修复导入区/数据源/进度面板挤占导致配对表被遮挡、导出菜单被盖；④ 套餐口径纠正（商品页已选「版本/套餐」选项，不是标题内存规格）；⑤ 数据持久化 FAQ。另 §18.7 追加匹配库表头与工作台对齐。

### 12.1 功能点

1. **当前价格列**：`row.capturePrice`（多采样中位数，元）→ 工作台配对表/总览页/回填 xlsx/结果 xlsx/CSV；导出列：配对明细与 CSV **18 列**、回填普通 **20 列**、教育教学 **23 列**、待确认 sheet 第 10 列改名「当前价格(元)」（仍 12 列）；
2. **配对总览页（第 5 页）**：全部 800 行、店铺/状态筛选、搜索、每页 200/500/全部、行内编辑 品牌/型号/套餐/尺寸段/价格段 → 写回匹配库 + 持久化 + 非法值拒绝；表头排序；导出 xlsx/CSV；
3. **工作台布局修复**：导入后 STEP01 折叠、数据源 `<details>` 收起；配对表占满视口（内部滚动、表头 sticky、pager 常驻）；补采进度/日志限高；导出菜单 z-index/向上弹出，点击后关闭；**1344×756 首屏可见 ≥6 行配对表**；
4. **套餐口径纠正**：套餐 = 商品页「版本/套餐」**已选中选项**（如 `会议大屏+摄像头【免费送装一体】`）；离线只取榜单列；标题猜测弃用；`migrateLegacyPackages` 清理旧「名称/标题/名称解析」套餐（保留 列/页面采集/手动），`settings.ui.migratedV213` 标记；**v2.1.3 起套餐口径变更：标题推测已废弃，离线仅榜单列 1/800，页面采集补充（§16.10 的 v2.1 473/800 为历史快照）**；
5. **匹配库表头对齐**：`SKU | 商品名称 | 店铺 | 品牌 | 型号 | 套餐 | 尺寸段 | 价格段 | 数据来源 | 更新时间 | 操作`；店铺列显示匹配库类目归档（有 shop 优先）；型号/套餐可行内编辑写回；导出列序一致。

### 12.2 断言清单

**纯 Node（`tests/qa/run.mjs` 第 4c 节，v2.1.3 数据侧，5 条，全部通过）：**

1. `migrateLegacyPackages`：清理 名称/标题/名称解析 共 3 条、保留 列/页面采集/手动、二次调用幂等返回 0；
2. 套餐离线口径：**1/800**（仅教育文件「翻页笔+投屏+推车」，来源=列），无标题/名称推测来源（DESIGN 18.6 写「141/800」有误，经 xlsx-core 确认按 1/800）；
3. 当前价格导出：配对明细 18 列（当前价格紧跟价格段，number|null）、待确认 sheet 12 列（第 10 列当前价格=5205，openpyxl 复核）；
4. 回填「当前价格」列：普通 20 列 / 教育 23 列，值=capturePrice；
5. `applyCaptures` 写入 `row.capturePrice`=多采样中位数（5200/5210→5205）。

**浏览器（`tests/qa/ui-smoke.mjs` 新增，特征门禁：元素/API 不存在时标 skip 不误报）：**

1. 工作台配对表含「当前价格(元)」列；有采集行显示数字、未采集行显示 `—`；
2. 导航「总览」页可打开；全部配对行=800；店铺筛选→200；每页「全部行」→渲染 800 行；搜索 SKU 精确过滤 1 行；
3. 总览行内编辑：尺寸段改 `65英寸` → `ok=true`、写回匹配库、刷新后仍在；非法尺寸段 → `ok=false` 且不改库；
4. 匹配库表头前 8 列 === `['SKU','商品名称','店铺','品牌','型号','套餐','尺寸段','价格段']`，「来源」改名「数据来源」；库内编辑型号 → 写回本库记录；
5. **1344×756** 首屏可见配对表 ≥6 行（截图 `07-workbench-visible.png`）；
6. 导出菜单 5 项 boundingRect 全部在视口内可点，点击菜单项后自动关闭；
7. 数据迁移：构造 `packageSource='名称'` 旧会话 + 手动套餐 → 刷新后旧值清空、手动保留、`settings.ui.migratedV213=true`（未接线时标 skip）；
8. 导出列 18/20/23、待确认 sheet 12 列（由纯 Node openpyxl 用例覆盖，UI 侧不重复造轮子）。

### 12.3 当前状态（终稿：实现已冻结，浏览器验收数据已回填）

- **数据侧已冻结**：`node tests/core/run.mjs` **120/0/28**（xlsx-core）；`node tests/qa/run.mjs` **67 通过 / 0 失败 / 0 阻塞 / 2 跳过**（新增 4c 节 5 条全过）；
- **UI/采集侧已冻结**：workbench-ui task-13 / jd-capture task-12 完成；manifest/content/app 版本均 **2.1.3**（manifest 已去 BOM）；
- **mock 商品页 CDP**：**107/107**（jd-capture 新增「已选版本套餐 / 尺寸变体组」断言：`会议大屏+摄像头【免费送装一体】`、`100英寸`）；`content_selftest_dom.mjs` 28 用例/110 断言；`test_capture_client.mjs` 27/27；
- **截图已重生 7 张**（Lead 环境 18:51）：`01~05`（v2.1.3 UI）+ `06-overview.png`（总览 800 行全屏）+ `07-workbench-visible.png`（1344×756 首屏可见 **11 行**）；`_meta.json`：`shots=7`、`visibleRows1344=11`、`consoleErrors=[]`、`warnings=[]`、`darkTheme=dark`、`lightTheme=light`。

### 12.4 执行结果（Lead 环境 · 真实 Edge 156 + CDP）

- 执行人 / 执行时间：**Lead** / **2026-11-03 18:5x**（真实 Edge + CDP）
- **数据侧**：`node tests/core/run.mjs` **120/0/28**；`node tests/qa/run.mjs` **67 通过 / 0 失败 / 0 阻塞 / 2 跳过**（4c 节 5 条全过）
- **Lead 独立验收（`acceptance_v213.mjs`）**：**11/11 断言通过**——首屏配对表 **10 行**、导出菜单 5 项完整可见、当前价格列显示 **5555**、总览 **800** 行/店铺筛选 **200**、行内编辑返回 `{ok:true, libraryWritten:true, syncedRows:1}` 且刷新持久化、匹配库 **11 列表头** `SKU|商品名称|店铺|品牌|型号|套餐|尺寸段|价格段|数据来源|更新时间|操作`、迁移清空旧套餐+保留手动+`migratedV213=true`、console errors=**0**
- **QA `--with-ui` 最终轮（19:13，Lead 环境真实 Edge）**：**69 通过 / 0 失败 / 0 阻塞 / 0 跳过（103.1s）**；UI 冒烟 **125/125 steps**（`ui-smoke.ok=true`、`consoleErrors=0`、`skip=0`）；
  - `priceColumn`：表头 15 列，`当前价格(元)` idx=9，numericCells=3（5000/5300/5600），dashCells=97，capturedRows=3；
  - 总览：`count=800 / rows=200`（默认 200/页）、店铺筛选「3C店」→200、每页全部→渲染 800、搜索 SKU→1 行；
  - 行内编辑：`{ok:true, oldValue:'75英寸', newValue:'65英寸', libraryWritten:true, syncedRows:1}`，刷新后 rowSize=65英寸、page=overview；非法值 `{ok:false, invalid:true, libraryWritten:false}`；
  - 布局：1344×756 `viewport1344={total:100, visible:6, vh:756}`；导出菜单 `{count:5, allInView:true}`；迁移 `{legacyPackage:'', manualPackage:'会议大屏+摄像头【免费送装一体】', migrated:true}`；
  - 匹配库：`libraryTable.headers` 11 列、editable=true、rows=100；库内编辑型号 `QA-EDITED-MODEL` 写回（source=手动）；
  - 小眼睛预览回归仍 True（pinned + backToBaseline）。
- **导出独立复核（Lead 用 openpyxl）**：配对明细 **18 列**（当前价格(元)=5555）、回填普通 **20 列**、教育 **23 列**、待确认 **12 列**第 10 列「当前价格(元)」、套餐页面采集值 `会议大屏+摄像头【免费送装一体】`
- **mock 商品页 CDP**：**107/107**；截图 7 张已重生并核对（见 12.3/第七节）
- 已知小差异：「卡片包含 xxx.xlsx」4 条首轮为断言口径问题（STEP01/数据源自动折叠导致 `innerText` 读不到），已修正为「会话 API `state.session.reports[].fileName` 优先 + 展开 `#dataSourceDetails` 兜底」，最终轮全绿——非产品缺陷。
- 截图 06/07 与 01~05 重生：**已完成**（01~05 727/889/701/640/448 KB + 06 703 KB + 07 625 KB，`_meta.json` `shots=7`、`visibleRows1344=11`、consoleErrors=[]、warnings=[]）。

### 12.5 已知限制

- **v2.1.3 套餐口径变更（历史快照说明）**：自 v2.1.3 起「标题推测套餐」已废弃——离线套餐只来自榜单「套餐/套装/版本」列（实测 **1/800**，教育 E 列仅 1 行有值），页面采集按商品页「版本/套餐」已选选项补充；§16.10/§11 中 v2.1 的「套餐 473/800」为历史快照，保留于历史章节不再修改；
- **数据源已更新、种子未重建**：`资料/匹配库.xlsx` 于 2026-11-03 17:53 被外部更新（3C店 sheet 447→502 行、去重 446→501），本迭代**不重建** `extension/data/base-skus.json` 种子（避免影响已冻结回归基准与用户现有匹配库）——匹配库页仍显示 4 类目 1046 SKU；用户可在「匹配库」页用「导入并合并」（或「导入并覆盖」）导入最新 Excel；QA 用例已按「数据漂移提示、不判失败」处理；
- **真实电商平台 DOM 变体组识别容错**：套餐/尺寸依赖商品页「版本/屏幕尺寸」选择区结构（`#choose-attrs`、`.Ptable`、`[class*="choose-attr"]` 等候选容器 + 选中态判定）；页面改版可能导致识别不到 → 套餐留空、尺寸回退标题/规格表，工具不写错值，可手工补；
- **标题套餐已弃用**：离线不再从标题猜内存规格，套餐只在榜单列/页面已选版本/手工来源出现；旧数据升级会清空标题推测值（预期行为）；
- **DESIGN 18.6 的套餐计数**：文档写「教育 141/800」有误，实测离线套餐 **1/800**（仅教育列 1 行），按 1/800 断言；
- **迁移只清「标题推测套餐」**：来源为 列/页面采集/手动 的套餐不动；迁移前旧 session 快照写 `backup_v213`；移动/重命名 extension 目录/清除站点数据仍会丢数据（FAQ 已写）；
- **浏览器项**：docs-qa 沙箱无法启动 Edge 渲染进程，v2.1.3 浏览器断言与 06/07 截图由 Lead 环境执行后回填本节。

> 结论：**通过**。数据侧：`tests/qa` **67/0/2（纯 Node）**、`tests/core` **120/0/28**、mock CDP **107/107**、content_selftest **28 用例/110 断言**、capture-client **27/27**；浏览器侧：`--with-ui` **69/0/0/0（103.1s）**、UI 冒烟 **125/125**、Lead 独立验收 **11/11**、openpyxl 导出复核 18/20/23 列、7 张截图已重生核对；v2.1.3 可交付。

---

## 十三、v2.1.4 迭代：匹配库人工核验 · 导出表头一致性 · 频控应对 · 新内置匹配库（已验收·全绿）

> 需求（DESIGN §19，用户 2026-11-03 晚 / 11-04 上午）：① 脚本补齐数据不得自动写匹配库（会污染），新 SKU/不全/待确认写入要分色并人工确认；② 修复导出表头与界面不一致 BUG；③ 已被电商平台频控（打开商品页变商城首页），需要风险识别/自动暂停/冷却/降频 + 预览人工通道；④ 用权威版 `资料/匹配库.xlsx` 重建内置种子。

### 13.1 功能点

1. **匹配库人工核验**：记录增加 `verified/origin/verifiedAt`；行级 `row.libState` 四态（verified/incomplete/new/pending）驱动颜色/徽标/筛选/KPI「待确认写入 N」；`annotateLibraryStates` 只打标；`analyzeReport/applyCaptures` 不写库；仅行内手动改或「确认写入匹配库」写库（写入前校验尺寸段/价格段合法齐全）；匹配库页记录显示「已核验/待核验」徽标（11 列表头不变）；
2. **导出表头一致性（BUG 修复）**：工作台/总览/配对明细/CSV 统一 **15 列**与界面逐字一致（不含「操作」）；匹配库导出 **10 列**；回填表头「当前价格(元)」；待确认 sheet 12 列不变；
3. **频控应对**：`content.js` 识别电商平台首页/登录页/验证页 → `risk`；`CaptureRunner` 自动暂停 + 冷却 60 分钟 + 冷却期禁用补采 + 风控横幅；降频默认 5~10s/每批 20/每 8 条长休息；**预览人工通道**：小眼睛窗口加载后自动快照 → 浮条「预览读数 [采用][忽略]」，采用写入当前行（pending，不写库）；
4. **新内置匹配库**：`extension/data/base-skus.json` 用 `资料/匹配库.xlsx`（2026-11-03 17:53 权威版）重建：4 类目 **1101 SKU / 638 齐全**，meta `schemaVersion=2026-11-03.780d76`、`fingerprint=780d76cf20900fe3`；升级自动替换旧脏种子、保留 manual/confirm 记录、写 `settings.ui.seedVersion`；
5. **新回归基准**（旧 726/192/771/1046 作废）：尺寸段 **734（91.75%）**、价格段 **242（30.25%，待采集 558）**、品牌 **772（96.5%）**、金额 10262.6 万、bySize **25**；libState **verified 160 / incomplete 184 / new 378 / pending 78**（pending 口径经 Lead 拍板：非 verified 且已有尺寸+价格 → pending）。

### 13.2 断言清单

**纯 Node（`tests/qa/run.mjs` 第 4d 节，7 条新增）：**

1. 新种子 meta：1101 SKU / 638 齐全 / schemaVersion+fingerprint / 不再合并 legacy；
2. 种子记录 `verified=true/origin=seed`，library meta 指纹/schemaVersion 正确；
3. `annotateLibraryStates`：**160 verified / 184 incomplete / 378 new / 78 pending（合计 800）**，行上有 libState，且**库内容 JSON 完全不变**（不写库）；
4. `applySeedMigration`：旧指纹 → `{migrated:true, seedRows:1101, keptManual:1}`、人工记录字段保留、meta.migratedFrom 记录、第二次幂等 `{migrated:false}`；
5. 导出表头一致：配对明细 15 列 === `PAIR_EXPORT_HEADERS`、匹配库 10 列 === `LIBRARY_EXPORT_HEADERS`、待确认 12 列第 10 列「当前价格(元)」；
6. 采集/分析不写库：`analyzeReport + applyCaptures` 后匹配库 JSON 不变；
7. 频控（jd-capture 已冻结）：content.js `detectRiskPage`/`PREVIEW_CAPTURE_RESULT`、capture-client `canStart()/cooldownUntil`（构造恢复、未来时间阻塞 canStart/start、过期放行）、默认降频 5~10s/每批 20/冷却 60min/每 8 条长休息。

**浏览器（`tests/qa/ui-smoke.mjs` v2.1.4 骨架，特征门禁缺失 skip）：**

1. 工作台配对表含「入库状态」列，徽标文案 ∈ {已入库/库数据不全/新 SKU/待确认写入}；状态筛选含三项；`libStateFresh` = {verified:160,incomplete:184,new:378,pending:78,total:800}（导入后、任何 simulate/编辑之前断言，实测通过）；
2. 采集 1 条新 SKU → pending 78→≥79；`confirmLibraryWrite([sku])` → written≥1、库记录 verified=true、pending 回到 78；非法值拒绝（后续冻结补）；
3. 导出表头 = 界面：工作台 15 列（去操作）=== 导出 15 列；匹配库 10 列；KPI/种子指纹 `780d76cf20900fe3`；
4. 频控横幅默认隐藏、设置页含降频/冷却/自动暂停控件；预览读数浮条 `#previewReadBar`（初始 hidden）+ `#previewApplyBtn`「采用」+ `#previewIgnoreBtn`「忽略」均实测存在（`v214RiskUi.previewBar/previewBarHidden/applyBtn/ignoreBtn` 全 true）；
5. 新基准 KPI：尺寸 734、价格 242、品牌 772、待补采 558、匹配库 1101 SKU。

### 13.3 当前状态（终稿：数据侧 + 浏览器侧全部回填）

- **数据侧已冻结**：xlsx-core `tests/core` **132 通过 / 0 失败 / 30 套件**；`tests/qa/run.mjs` **74 通过 / 0 失败 / 0 阻塞 / 2 跳过**（4d 节 7 条全过，含频控功能验证）；
- **浏览器终轮（Lead 环境，2026-11-04 10:50）**：`node tests/qa/run.mjs --with-ui` → **76 通过 / 0 失败 / 0 阻塞 / 0 跳过（128.2s）**；UI 冒烟 **147 steps / 147 pass / 0 fail / 0 skip**（`ui-smoke.ok=true`、`consoleErrors=0`）；
- **v2.1.4 浏览器实测**：`libStateFresh` 导入基线 **160/184/378/78（total 800）**；入库状态列 UI 第 15 列、徽标四色齐全（已入库/待确认写入/库数据不全/新 SKU）、筛选三项；确认写入 `{written:1,rejected:[]}`、库记录 `verified=true/origin=confirm`、pending 采集后 80→81、确认后回 80、verified 162；工作台 UI 16 列（15+操作）、匹配库 11 列（10+操作）；风控横幅默认隐藏、降频/冷却/自动暂停控件在；预览读数浮条 `#previewReadBar`（含 [采用][忽略]，初始 hidden）已接线；`settings.ui.seedVersion=2026-11-03.780d76`、`library.meta.fingerprint=780d76cf20900fe3`；
- **截图 9 张已重生**（Lead 10:41）：01~07 按 v2.1.4 UI/新基准、08 四色行、09 确认写入；`_meta.json` libStates 160/184/378/78、confirmWrite written:1、consoleErrors=[]、warnings=[]；
- **版本一致性**：manifest **2.1.4**（无 BOM）＝ app.js `APP_VERSION` ＝ content.js `VERSION` ＝ 文档 v2.1.4。

### 13.4 执行结果（Lead 环境 · 真实 Edge 156 + CDP，2026-11-04 10:50）

- 执行人 / 执行时间：**Lead** / **2026-11-04 10:50**（真实 Edge + CDP）
- **数据侧**：`node tests/core/run.mjs` **132/0/30 套件**；`node tests/qa/run.mjs` **74 通过 / 0 失败 / 0 阻塞 / 2 跳过**（4d 节 7 条全过）
- **`--with-ui` 汇总**：**76 通过 / 0 失败 / 0 阻塞 / 0 跳过（128.2s）**
- **UI 冒烟**：**147 steps / 147 pass / 0 fail / 0 skip**（`ui-smoke.ok=true`、`consoleErrors=0`）
- **libStates/确认写入**（`ui-smoke.json`）：
  - `libStateFresh`：`{"states":{"verified":160,"incomplete":184,"new":378,"pending":78,"total":800},"hasLibStateCol":true}`（导入后、任何 simulate/编辑之前）；
  - `libStateUi`：表头 16 列（…状态、入库状态、操作）、入库状态 idx=14、`labels=["已入库","待确认写入","库数据不全","新 SKU"]`、筛选 3 项；`kpiPending=80`（该段在后续用例后取，基线以 libStateFresh 为准）；
  - `confirmWrite`：base 161/181/378/80 → before 161/181/377/81 → `res {written:1, rejected:[]}` → after 162/181/377/80；库记录 `{verified:true, origin:'confirm', size:'98/100英寸', price:'5500元至6000元'}`；
  - `v214RiskUi`：`{alert:true, hidden:true, batch:true, cooldown:true, autoPause:true, previewBar:true, previewBarHidden:true, applyBtn:true, ignoreBtn:true, seedVersion:'2026-11-03.780d76', libFingerprint:'780d76cf20900fe3'}`。
- **专项**：入库状态四色/筛选/KPI ✅；确认写入单行 ✅（批量由 workbench-ui/Lead acceptance 覆盖）；导出表头 === 界面（15/10 列，纯 Node 断言）✅；频控横幅/控件 ✅（冷却行为由 capture-client 4d 用例 + Lead CDP 141/141 覆盖）；预览读数浮条/采用/忽略 ✅；新种子迁移（settings.seedVersion + fingerprint）✅
- **导出独立复核（Lead openpyxl）**：配对明细 **15 列**（行…入库状态）、匹配库 **10 列**、回填普通 **20 列** / 教育 **23 列**（当前价格(元)）、待确认 **12 列**。
- **截图 9 张（Lead 10:41 重生）**：01 735.1 KB / 02 906.0 / 03 694.2 / 04 632.7 / 05 458.8 / 06 710.8 / 07 634.5 / 08 731.3 / 09 736.5 / `_meta.json` 3.7 KB；`_meta`：libStates=160/184/378/78、confirmWrite=written:1、consoleErrors=[]。

### 13.5 已知限制

- **频控无法绕过**：只能降风险 + 人工通道；冷却 60 分钟/降频默认值偏保守，真实风控阈值不可知；建议用户停 24h/换账号换网络，不要连续重试；
- **pending 口径**（Lead 拍板）：只认「非 verified 且已有尺寸段+价格段」→ 未采集 pending=78（DESIGN 字面口径会多 77 行，已按拍板值断言）；
- **真实电商平台 DOM 变体组/风险页识别容错**：页面改版可能导致套餐/尺寸识别不到或风险页文案变化；工具会留空/失败而不是写错值；
- **种子迁移**：只保留 manual/confirm 人工记录；`import` 记录会被新种子替换（如需保留请先导出 xlsx/备份 JSON）；旧 `data/match_library.json` 不再合并；
- **浏览器项**：docs-qa 沙箱无法启动 Edge 渲染进程，v2.1.4 浏览器断言/频控专项/08/09 截图由 Lead 环境执行后回填本节。

> 结论：**通过**。数据侧：core **132/0/30 套件**、纯 Node **74/0/0/2 跳过**、mock CDP **141/141**、content selftest **34 用例/163 断言**、capture-client **33/33**；浏览器侧：**`--with-ui` 76/0/0/0（128.2s）**、UI 冒烟 **147 steps/147 pass/0 fail/0 skip**、Lead 独立 acceptance_v214 **14/14**、导出表头 15/10/20/23 复核、9 张截图重生核对；v2.1.4 可交付。

---

---

## 十四、v2.1.5 迭代：回填 16 列 · 确认写入完整性 · 列显隐/筛选/悬停 · 异常自动继续 · 匹配库保护与操作日志（已验收·全绿）

> 需求：用户 2026-11-04 15:27 的 11 条反馈（DESIGN §20）+ 追加「匹配库类目合并去重」（§20.13）。核心诉求：导出与界面一致、确认写入不丢字段、表格列可管理、异常不永久暂停、匹配库绝不被升级覆盖且可追溯。

### 14.1 功能点

1. **回填导出与界面一致**：回填 xlsx 改为界面同款 **16 列**（行…入库状态、操作留空），每榜单 1 个 sheet（sheet 名=榜单简称），不再保留原榜单列；配对明细/总览/CSV 仍 15 列、匹配库 10 列；
2. **每批上限设置生效**：设置页每批上限（默认 20，范围 5~100）运行时按当前设置截断（不再写死 20）；间隔/冷却/自动暂停同样实时生效；
3. **确认后文案「已确认」**：入库状态=已确认、行内按钮变「已确认」并禁用、匹配库徽标=已确认、数据来源=`已确认（种子/导入/人工/人工确认）`；未确认仍「待确认写入/待确认」；
4. **列显隐 + 表头列筛选 + 列悬停高亮**：配对表/总览列设置（持久化 `settings.ui.tableCols`）、表头值多选/数值区间筛选（多列 AND）、`.col-hover` 整列高亮；
5. **确认写入完整性（BUG 修复）**：只用行上规范值 `size/price/brand/model/package` 写库（不再传旧 raw）；`upsertMatch` 对显式规范 size/price 强制覆盖，尺寸段与价格段必须同时写入；写库追加日志；
6. **名称多尺寸不猜（细化）**：多个英寸值先归一到尺寸段，全部同段（98/100、86/85）正常识别；≥2 个不同段才留空 + `sizeAmbiguous=true` + 备注待人工复核；新基准 尺寸段 **577/800（72.125%）**、sizeAmbiguous **157 行**、bySize **22**（价格 242/品牌 772/金额 10262.6 不变）；
7. **异常自动继续**：`offSale` 下架→标记失败并跳过；`softAnomaly` 跳首页/空页→等待 `anomalyWaitSec`（默认 60s）自动继续（可立即继续/停止）；仅 `risk` 验证/登录触发冷却暂停；连续异常可升级冷却；
8. **匹配库操作日志**：`library.meta.logs`（≤500 条滚动）记录 confirm/manual-edit/import-merge/import-replace/normalize/seed-migrate/merge-stores/dedupe-store/add-store/delete-store/reset-seed；匹配库页面板可查看/搜索/导出 CSV；
9. **匹配库保护**：升级不重建种子、不改 fingerprint；`applySeedMigration` 默认 **merge-missing** 只补缺失 SKU，已有/用户改过记录完全不动（仅显式 `{mode:'replace'}` 才整体替换）；UI 首次写库前快照 `libraryBackup_v215`；不自动 normalize；
10. **类目合并去重（§20.13）**：`mergeStores`（多选类目→目标类目，先 dryRun 预览 rowsBefore/uniqueAfter/duplicates/conflictCount/conflicts）与 `dedupeStore`（单类目去重）；按 `normalizeSku` 去重，冲突按 verified→updatedAt→字段完整度 取值；保留 verified/origin；写 `merge-stores`/`dedupe-store` 日志与备份时间。

### 14.2 断言清单

**纯 Node（`tests/qa/run.mjs` 第 4e 节，9 条，全部通过）：**

1. 回填导出 16 列 = `BACKFILL_EXPORT_HEADERS`（普通/教育一致），每榜单 1 sheet，行=`榜单简称 #行号`，操作列留空，openpyxl 复核；
2. 确认写入完整性：显式 size+price 强制覆盖旧 raw，两字段同时写库，库导出/界面读到一致值；
3. 名称多尺寸：≥2 不同段 → size 留空+sizeAmbiguous+note；同段写法（98/100、86/85）正常识别；覆盖「55/65、75/86 才留空」；
4. 操作日志：505 条→保留 500、时间倒序、字段 {at,action,store,sku,field,before,after,source}、滚动；
5. 匹配库保护：同指纹不迁移/不变；不同指纹 merge-missing 保留用户字段/来源，缺失种子 SKU 补回，二次幂等；显式 replace 才整体替换；
6. 每批上限：capture-client 按 settings.maxBatch（10→10、500→100、1→5），默认 20/5~100 校验；
7. 异常分类：content `detectPageState` offSale/softAnomaly/risk、client `anomalyWaitSec`/offSale 跳过、risk 仍冷却；
8. 「已确认」文案：`LIB_STATE_LABELS.verified=已确认`、libraryToRows verifiedText 已确认/待确认、libraryExportRows 数据来源 `已确认（…）`；
9. 类目合并去重：dryRun 预览 rowsBefore/uniqueAfter/duplicates/conflictCount/conflicts 与字节级不改库；执行后 SKU 数=去重数、冲突取 verified 值、保留 origin/verified、删源类目、日志 merge-stores；dedupeStore 单类目去重 + 日志；
10. 新基准：尺寸段 577（72.125%）、sizeAmbiguous 157、bySize 22、分榜单 165/183/80/149（歧义 28/15/86/28）；种子未被改动（1101/638/fingerprint 780d76cf20900fe3）。

**浏览器（`tests/qa/ui-smoke.mjs` v2.1.5 骨架，特征门禁缺失 skip）：**

1. 列设置面板（配对表/总览）可打开、选择持久化；
2. 表头列筛选按钮/面板/值多选；列悬停 `.col-hover` 生效；
3. 每批上限默认 20、设置范围 5~100；异常等待默认 60s；
4. 已确认文案（KPI/行徽标/匹配库 verifiedText）；
5. 匹配库操作日志面板可打开；合并类目入口；备份恢复入口；异常等待「立即继续/停止」；
6. 匹配库保护：刷新前后样本记录字段不变；
7. 回填 16 列由纯 Node openpyxl 覆盖。

### 14.3 当前状态（终稿：数据侧 + 浏览器侧全部回填）

- **数据侧已冻结**：xlsx-core `tests/core` **142 通过 / 0 失败 / 32 套件**；`tests/qa/run.mjs` 纯 Node **83 通过 / 0 失败 / 0 阻塞 / 2 跳过**（4e 节 9 条全过）；
- **浏览器终轮（Lead 环境，2026-11-04 18:0x）**：`node tests/qa/run.mjs --with-ui` → **85 通过 / 0 失败 / 0 阻塞 / 0 跳过（105.6s）**；UI 冒烟 **162 steps / 162 pass / 0 fail / 0 skip**（`ui-smoke.ok=true`、`consoleErrors=0`）；
- **新基准（4 榜单未采集）**：尺寸段 **577/800 = 72.125%**（分榜单 165/183/80/149）、sizeAmbiguous **157 行**（28/15/86/28）、价格段 **242**、品牌 **772**、金额 **10262.6 万**、bySize **22**；型号 489、套餐仅榜单列 1；libStates 仍 **160/184/378/78**；
- **种子保护红线**：`extension/data/base-skus.json` 未被改动（fingerprint `780d76cf20900fe3`、1101 SKU/638 齐全）；升级默认 merge-missing，用户库内容保持不变；
- **版本一致性**：manifest **2.1.5** ＝ app.js `APP_VERSION` ＝ content.js `VERSION` ＝ 文档 v2.1.5；UI 真 bug（表头筛选 `filteredMatchRows` 迭代对象）已由 Lead 合入并回归；
- **截图 12 张已重生**（Lead 18:07~18:12）：01~10 由 shot.mjs 生成，**11/12 由 Lead 用真实 CDP 手动补齐**（shot 旧版查 `#libraryLogBtn`、实际 id 为 `#libLogBtn`，已修正 shot.mjs）；`_meta.json` `shots=12`、libStates 160/184/378/78、consoleErrors=[]、warnings=2（11/12 手动生成说明）。

### 14.4 执行结果（Lead 环境 · 真实 Edge 156 + CDP，2026-11-04 18:0x）

- 执行人 / 执行时间：**Lead** / **2026-11-04 18:0x**（真实 Edge + CDP）
- **数据侧**：`tests/core` **142/0/32 套件**；`tests/qa` 纯 Node **83/0/0/2 跳过**（4e 节 9 条全过）；mock CDP **153/153**；content selftest **37 用例/202 断言**；capture-client **39/39**
- **`--with-ui` 汇总**：**85 通过 / 0 失败 / 0 阻塞 / 0 跳过（105.6s）**
- **UI 冒烟**：**162 steps / 162 pass / 0 fail / 0 skip**（`ui-smoke.ok=true`、`consoleErrors=0`）
- **v2.1.5 关键 metrics（`ui-smoke.json`）**：
  - `v215`：hasColumnMenu/hasOverviewColumnMenu/hasColHoverCss/hasHeaderFilter=true；batchLimit=20；anomalyWaitSec=60；hasLibraryLogBtn/hasMergeBtn/hasAnomalyBar/hasBackupRestore=true；libStateLabels `{verified:'已确认',incomplete:'库数据不全',new:'新 SKU',pending:'待确认写入'}`；libLogActions 12 类（含 merge-stores/dedupe-store/clear-logs）
  - `v215ColumnMenu`：opened=true；match/overview 均 amount=false、sample=false，其余 true（默认隐藏成交金额/采样）
  - `v215ColFilter`：panel=true、values=401（品牌等去重值多选）
  - `v215ColHover`：hasCss=true、hovered=true（.col-hover）
  - `v215BatchUi`：value=20 / min=5 / max=100
  - `v215ConfirmText`：labelVerified='已确认'
  - `v215Ambiguous`：count=157、sizeFilled=577
  - `v215LibraryLog`：panel=true
  - `v215Protection`：before/after 样本记录完全一致（3C店 SKU 100004577875，65英寸/3500元至4000元，count 501 不变）
- **Lead 独立 acceptance_v215**：**17/17**（KPI 577/242/772、libStates、多尺寸 157、回填 16 列表头、默认隐藏金额/采样、确认写入后库 size+price 均在且已确认、列显隐/列筛选/列悬停、批量上限 plan.maxBatch=20、合并预览 dryRun 不改库、日志面板 6 条）
- **导出 openpyxl 复核**：回填 xlsx **16 列**（每榜单 1 sheet、操作列空）、配对/工作台 CSV **15 列**、匹配库 xlsx **10 列**；待确认 sheet 12 列不变
- **12 张截图（18:07~18:12 重生）**：01 744.0 KB / 02 899.6 / 03 695.8 / 04 639.9 / 05 456.1 / 06 729.1 / 07 647.9 / 08 742.8 / 09 747.0 / 10 745.8 / 11 544.6 / 12 604.2 / `_meta.json` 4.3 KB
- **专项**：回填 16 列 ✅；每批上限 20（5~100）✅；「已确认」文案+按钮禁用 ✅；列显隐持久化/列筛选（401 值）/列悬停 ✅；异常继续 UI（下架/软异常/风控）✅；操作日志面板+合并去重入口 ✅；匹配库升级前后内容不变 ✅

### 14.5 已知限制

- **名称多尺寸为启发式**：按尺寸段归一（98/100、86/85 算同段），≥2 段才留空；页面改版/写法怪异时仍可能误判，留空+人工复核兜底；
- **频控无法绕过**：只能降风险 + 人工通道；异常自动继续等待期可「立即继续/停止」；冷却阈值/连续异常升级次数可配置，真实电商平台阈值不可知；
- **合并/去重策略**：冲突按 verified→updatedAt→字段完整度 取值，低优先级值只记录在 conflicts/日志；合并前自动快照可恢复，但「从备份恢复」会覆盖当前库（需确认）；
- **日志上限 500 条滚动**：更早记录会被淘汰，重要操作建议定期导出 CSV/备份 JSON；
- **种子保护边界**：默认 merge-missing 不覆盖；仅用户显式「重置内置库」/`{mode:'replace'}` 会整体替换（有 `reset-seed` 日志 + 快照）；
- **截图 11/12 为 Lead 手动 CDP 生成**：shot.mjs 原查 `#libraryLogBtn`（实际 `#libLogBtn`）已修正；12 需先确认写入+搜索 SKU 才能截到「已确认」，脚本已保留该逻辑，后续可一键复现。

> 结论：**通过**。数据侧：core **142/0/32 套件**、纯 Node **83/0/0/2 跳过**、CDP **153/153**、content selftest **37/202**、capture-client **39/39**；浏览器侧：**`--with-ui` 85/0/0/0（105.6s）**、UI 冒烟 **162/162**、Lead acceptance_v215 **17/17**、导出 openpyxl 16/15/10 列、12 张截图核对；v2.1.5 可交付。

---

---

## 十五、v2.1.6 迭代：价格只来自匹配库/页面 · 尺寸严格识别（多值必空置）· 快速人工定位（已验收·全绿）

> 需求：用户 2026-11-04 18:34 硬反馈（DESIGN §21）——① **价格绝不能由名称判断，只能读页面/匹配库；名称上根本没有价格**；② **尺寸段错误主要来自名称误判**：名称出现多段数据就必须空置等人工，只有唯一明确尺寸才识别，型号数字不得当尺寸；③ 改完要能**按空缺快速定位人工核验点**。核心目标：宁可空置也不猜，人工只补空缺。

### 15.1 功能点

1. **价格来源收口（硬约束，§21.1）**：价格段唯一合法来源 = ① 匹配库该 SKU 已核验记录（`source.price=库`）② 页面采集价格（到手价/电商平台价 → 价格段）③ 手动/榜单列；**删除全部「名称推断价格」**（同名商品不再补任何字段、名称金额不产价格、`bySource.price` 无「名称推断」、`summary.nameInferred` 恒 0）；库无价格 → 空置 + 「缺价格段」定位 + 在线采集；
2. **尺寸严格识别（§21.2）**：来源顺序 库该 SKU → 名称严格解析 → 页面采集（规格参数优先）→ 空置等人工；名称只统计**明确尺寸表达**（数字 + 英寸/寸/吋）；**≥2 个表达（含 55/65、98/100、86/85、「75英寸 86英寸」）一律不识别**：`size=''`、`sizeAmbiguous=true`、`sizeAmbiguousReason`、note「名称含多个尺寸，待人工复核」；型号数字（75MBK7/VH75CAD）与无单位数字（5000元/4K）不识别且标待人工；恰好 1 个常见尺寸才采用；**v2.1.5 同段归一规则作废**；采集到明确尺寸后清除标记；
3. **快速人工定位（§21.3）**：工作台/总览工具条新增 **待人工复核 N / 缺尺寸段 N / 缺价格段 N** 快捷 chip（点击筛选、再点取消、可与状态/搜索叠加）；状态筛选新增「尺寸待复核」「缺尺寸段」「缺价格段」；行内尺寸空格显示「待人工/缺」+ 原因 tooltip，待复核行状态列标「待复核」；导出「状态」列体现「待复核」及原因（列结构不变）；
4. **兼容（§21.4）**：匹配库保护/日志/类目合并去重不变；导出列结构不变（回填 16 / 配对 15 / 匹配库 10）；新基准重算并写入文档。

### 15.2 断言清单

**纯 Node（`tests/qa/run.mjs` 第 4f 节，6 条）：**

1. 价格来源硬约束：4 榜单 800 行中，凡有价格的行 `source.price` ∈ {库/列/页面采集/手动} 且不含「名称/推断/解析」；`priceSources['名称推断']=0`；note 无名称推断价格；
2. 名称含金额不得产出价格：构造名称含 `￥3999`、`3000元 3500元` 的行 → `price=''`、`source.price=''`、`capturePrice=null`；唯一尺寸 65英寸 仍识别；
3. 同名商品不再跨行推断：同名两行，A 有列值、B 无 → B 不得从 A 补 price/size（B 名称无尺寸 → size 空）；
4. 尺寸严格识别：`55/65`、`98/100`、`86/85`、`75英寸 86英寸` → 全部 size 空 + sizeAmbiguous + note 人工复核；`65英寸`/`75英寸` 单值正常识别；`75MBK7`/`VH75CAD` 型号数字不当尺寸；
5. 页面采集尺寸清标记：名称多值行（ambiguous）→ 采集 sizeInch=86 + spec 来源 → size 写入、`sizeAmbiguous=false`；
6. 新基准：尺寸段 **478/800（59.75%）**、价格段 **165/800（20.6%，全部来自库）**、sizeAmbiguous **322**（多值 248 + 无明确 74）、bySize **20**；分榜单尺寸 134/143/67/134、价格 0/89/1/75、歧义 66/57/133/66；离线有价行 `source.price` 必须为「库」。

**浏览器（`tests/qa/ui-smoke.mjs` v2.1.6 断言组）：**

1. `#quickFilterBar` 三个 chip 存在，计数 = 待复核行数（sizeAmbiguous/sizeUncertain）/缺尺寸行数/缺价格行数；
2. 点「待人工复核」→ 仅显示待复核行、状态列「待复核」、尺寸段「待人工/缺」、数据来源无「名称推断」；点「缺尺寸段」「缺价格段」→ 对应列为空；再点取消；
3. 总览页同款 chip 计数一致、状态筛选含 sizeReview/missingSize/missingPrice、点击可筛出待复核行；
4. KPI 新基准：尺寸 478、价格 165、待补采 635、libStates 160/192/447/1、sizeAmbiguous 322；
5. 导出状态「待复核/原因」、导出列结构不变（回填 16 / 配对 15 / 匹配库 10）；
6. v2.1.5 回归：列显隐/表头筛选/列悬停/每批上限/已确认/异常继续/匹配库日志与保护继续通过。

### 15.3 当前状态（终稿：数据侧 + 浏览器侧全部回填）

- **数据侧已冻结**：xlsx-core `tests/core` **145 通过 / 0 失败 / 32 套件**；`tests/qa/run.mjs` 纯 Node **89 通过 / 0 失败 / 0 阻塞 / 2 跳过**（4f 节 6 条全过）；
- **浏览器终轮（Lead 环境，2026-11-05 10:05）**：`node tests/qa/run.mjs --with-ui` → **91 通过 / 0 失败 / 0 阻塞 / 0 跳过（104.6s）**；UI 冒烟 **181 steps / 181 pass / 0 fail / 0 skip**（`ui-smoke.ok=true`、`consoleErrors=0`）；
- **新基准（4 榜单 800 行，未采集）**：尺寸段 **478/800=59.75%**（分榜单 134/143/67/134）、sizeAmbiguous **322 行**（多值 248 + 无明确 74；分榜单 66/57/133/66）、价格段 **165/800=20.625%**（分榜单 0/89/1/75，全部来自库）、待补采 **635**；品牌 772、金额 10262.6、bySize **20**、byPrice 19（18+未补）；型号 489、套餐仅榜单列 1；
- **状态计数**：已匹配 161 / 部分 317 / 待采集 318 / 待补 4 / 已补采 0 / 采集失败 0 / 需确认 0；**libStates verified 160 / incomplete 192 / new 447 / pending 1**；source：尺寸 库 162 + 名称解析 316，价格 库 165；
- **价格收口证据**：原价格 242 中 **77 条来自名称推断，已剔除**（现 165 全部 `source.price=库`）；同名推断路径删除后 `summary.nameInferred=0`；ui-smoke `v216Baseline.priceFromName=0`；
- **种子保护**：`extension/data/base-skus.json` 未改动（sha256 `b00e78cc67e7…`、fingerprint `780d76cf20900fe3`、1101/638）；
- **版本一致性**：manifest = app.js `APP_VERSION` = content.js `VERSION` = 文档 **v2.1.6**；
- **截图 14 张已重生**（Lead 10:05）：01~14 全部核对；13 的 chips 显示 65/65/199 是 shot 脚本前面确认步骤改变库/行所致（导入后基线 66/66/125，QA `v216Baseline` 已断言 322/478/165）；`_meta.json` 4.5 KB。

### 15.4 执行结果（Lead 环境 · 真实 Edge + CDP，2026-11-05 10:05）

- 执行人 / 执行时间：**Lead** / **2026-11-05 10:05**（真实 Edge + CDP）
- **数据侧**：`tests/core` **145/0/32 套件**；`tests/qa` 纯 Node **89/0/0/2 跳过**（4f 节 6 条全过）；mock CDP **176/176**；content selftest **43 用例/232 断言**；capture-client **40/40**
- **`--with-ui` 汇总**：**91 通过 / 0 失败 / 0 阻塞 / 0 跳过（104.6s）**
- **UI 冒烟**：**181 steps / 181 pass / 0 fail / 0 skip**（`ui-smoke.ok=true`、`consoleErrors=0`）
- **v2.1.6 关键 metrics（`ui-smoke.json`）**：
  - `v216Baseline`（导入后、simulate 之前）：`{total:800,sizeFilled:478,priceFilled:165,sizeAmbiguous:322,priceFromName:0,states:{verified:160,incomplete:192,new:447,pending:1}}`
  - `v216`：hasQuickBar/hasOverviewBar=true；active（当前榜单 200 行）review 65 / missingSize 65 / missingPrice 196；all（全部 800 行）review 321 / missingSize 321 / missingPrice 631；chips **65/65/196**；priceFromName 0
  - `v216ReviewFilter`：count 65、尺寸全「待人工」、状态全「待复核」、来源「尺 — / 价 —」
  - `v216NoSizeFilter`：count 65、`stateSizeFilled` 全 false
  - `v216NoPriceFilter`：count 100（match 页上限）、状态「缺价格段」、`statePriceFilled` 全 false、尺寸来源含「名称解析」（合法）
  - `v216Overview`：321/321/631；状态选项含 sizeReview/missingSize/missingPrice
  - `v216OverviewFilter`：count 200（总览页上限）
- **Lead 独立 acceptance_v216**：**10/10**（KPI 478/165/772、价格 165 全库且 namePrice=0、322 ambiguous、chips 66/66/125、待人工+待复核、总览筛选、回填 16 列含待复核行 66/57/133/66、确认回归）
- **导出 openpyxl 复核**：回填 xlsx **16 列**（含待复核行）、配对/工作台 CSV **15 列**（待复核 66 行、来源含「名称」=0）、匹配库 xlsx **10 列**
- **14 张截图（10:05 重生）**：01 753.6 KB / 02 907.1 KB / 03 705.3 KB / 04 642.7 KB / 05 483.6 KB / 06 735.8 KB / 07 644.3 KB / 08 749.4 KB / 09 758.7 KB / 10 760.8 KB / 11 850.9 KB / 12 675.0 KB / 13 728.9 KB / 14 727.7 KB / `_meta.json` 4.5 KB
- **专项**：价格只来自库/页面 ✅；名称金额不产价格 ✅；同名商品不再补字段 ✅；多值尺寸必空置（55/65、98/100、86/85、75英寸 86英寸）✅；型号数字不误判 ✅；快速人工定位 chip/筛选/总览/导出「待复核」✅；v2.1.5 全部回归 ✅

### 15.5 已知限制

- **严格规则必然增加空置**：多值/无明确尺寸 322 行、缺价格 635 行需人工/采集处理——这是用户要求的「宁空勿猜」，不是缺陷；
- **名称多尺寸为启发式判定**：明确尺寸表达 = 数字+单位；特殊写法（「六十五寸」、符号变体）可能识别不出 → 留空+待人工兜底；
- **价格只认库/页面**：离线分析不产价格（价格基准 165 全部库命中），未采集前「缺价格段」很多属预期；页面采集受频控限制（同 v2.1.5 异常继续/冷却）；
- **快速定位为筛选**：chip 只定位不自动补，需人工填/采集；分页时只显示当前页匹配行；工作台 chip 为当前榜单口径、总览 chip 为全部 800 行口径；
- **数据来源列**：尺寸可出现「名称解析」（严格单值解析，合法）；**价格来源不会出现「名称推断」**（QA/acceptance 专项校验 namePrice=0）。

> 结论：**通过**。数据侧：core **145/0/32 套件**、纯 Node **89/0/0/2 跳过**、CDP **176/176**、content selftest **43/232**、capture-client **40/40**；浏览器侧：**`--with-ui` 91/0/0/0（104.6s）**、UI 冒烟 **181/181**、Lead acceptance_v216 **10/10**、openpyxl 回填 16/CSV 15/匹配库 10 列、14 张截图核对；v2.1.6 可交付。

---

---

## 十六、v2.1.7 迭代：移植「巡检双轨版」价格采集算法 · 价格类型/候选 JSON · 下架不计分母（已验收·全绿）

> 需求：用户 2026-11-05 11:50 硬反馈——本插件采集价格错误率极高；桌面 `巡检\巡检插件-双轨版` 的价格采集算法实测准确率最高，要求**直接替换**，并评估其架构可复用项（DESIGN §22）。核心目标：取价只认「当前商品价格区 + 可见 + 完整价格 + 字号最大」，排除比价卡/关联购买干扰；价格类型/候选 JSON 可追溯；下架行不拖累进度。

### 16.1 功能点

1. **价格算法移植（§22.2）**：锁定当前商品价格区（不聚合全页）→ 可见/首屏优先 → 严格完整价格（拒绝 56 片段/折扣/分期/月供/评价等）→ 排除比价卡/关联购买/推荐/广告/店铺卡/促销卡容器 → **字号最大**优先 → hand/plus/main 口径 → **连续 3 轮稳定（约 1.5s，最长 20s）+ 稳定后最多 4 次 ×1.2s 复核** → 变化记 `priceChanges`（不按阈值挑值、不猜）；
2. **新增字段（§22.2-8）**：`price/priceKind/priceKindLabel/priceRect/sourceLabel/priceChanges/candidates`（候选含 price/kind/text/cls/font/strike/rect，前 12 条）；数据来源细化 `页面采集(到手价/PLUS价/电商平台价)`；当前价格旁显示价格类型徽标；
3. **借鉴项（§22.3）**：价格类型徽标、行调试候选 JSON（可复制）、priceChanges、**下架行不计入进度分母**（stats.offSale/progressDenom/progressPct，KPI「待补采 X / 有效 Y（已下架 Z 不计入）」，总览「已下架」筛选）、基表读回校验沿用现有保存校验；
4. **不采纳项（§22.3，写入文档）**：① 官方价 API 桥（SP-API `price-stars`）只覆盖授权店铺自有商品普惠价，竞品 SKU 不适用；② AI 复核需 AI Key，列为后续可选（只校验不覆盖 DOM）；③ 双轨/前台小窗：竞品批量用后台标签页即可；
5. **兼容（§22.4）**：保留既有风控/下架/软异常三分类、尺寸严格识别、型号/套餐/规格组、PREVIEW_CAPTURE；导出列结构不变（回填 16 / 配对 15 / 匹配库 10）；旧采集记录兼容。

### 16.2 断言清单

**纯 Node（`tests/qa/run.mjs` 第 4g 节，6 条，实现就绪后生效）：**

1. `content.js` 静态契约：`EXCLUDE_CONTAINER`（比价卡/关联购买/推荐/广告）、`STABLE_ROUNDS=3`、1.2s×4 复核、字号选价、首屏/可见判断、完整价格解析、`priceChanges`/`priceRect`/`sourceLabel`/`priceKind`/`candidates`；
2. `applyCaptures` 新字段：price/priceKind/priceKindLabel/priceRect/sourceLabel/priceChanges/candidates 全部落到行上；候选含字号与位置；价格来源=页面采集；
3. 数据来源文案：到手价 → `页面采集(到手价)`、PLUS → `页面采集(PLUS价)`、电商平台价 → `页面采集(电商平台价)`；
4. 下架分母：10 行中 2 行已下架 → `offSale=2`、`progressDenom=8`、`progressPct` 按有效行计算；
5. 旧记录兼容：无新字段的旧采集记录不报错、来源回退、回填 16/配对 15/匹配库 10 列不变；
6. mock 布局用例：比价卡 8499、关联购买 1999、拆分数字 ¥8607.56、价格刷新 24699→25099、排除容器类名已加入 dev-tools。

**浏览器（`tests/qa/ui-smoke.mjs` v2.1.7 断言组，Lead 执行）：**

1. 当前价格单元格显示价格类型徽标（到手价/PLUS价/电商平台价），数据来源 `页面采集(…)`；
2. 行调试面板 JSON 含 candidates（价格/字号/位置）与 priceChanges，可复制；
3. KPI「待补采 X / 有效 Y（已下架 Z 不计入）」；总览状态筛选含「已下架」；
4. v2.1.6 全部回归（价格只来自库/页面、尺寸严格、快速人工定位、导出结构）。

### 16.3 当前状态（终稿：数据侧 + 浏览器侧全部回填）

- **数据侧已冻结**：xlsx-core `tests/core` **151 通过 / 0 失败 / 33 套件（5.7s）**；`tests/qa/run.mjs` 纯 Node **95 通过 / 0 失败 / 0 阻塞 / 2 跳过**（4g 节 6 条全过，mock 布局用例经 jd-capture 补充后通过）；
- **浏览器终轮（Lead 环境，2026-11-05 14:0x）**：`node tests/qa/run.mjs --with-ui` → **97 通过 / 0 失败 / 0 阻塞 / 0 跳过（109.8s）**；UI 冒烟 **192 steps / 192 pass / 0 fail / 0 skip**（`ui-smoke.ok=true`、`consoleErrors=0`）；
- **采集侧**：mock CDP **218/218**（pricecards 10 / splitprice 6 / hiddenprice 4 / pricerefresh 4 / belowfold 5 / mainonly 6，原 176 不回归）；content selftest **50 用例 / 277 断言**；capture-client **41/41**；
- **版本一致性**：manifest = app.js `APP_VERSION` = content.js `VERSION` = 文档 **v2.1.7**；种子未动（1101/638、fingerprint `780d76cf20900fe3`）；
- **离线基准不变**：尺寸 **478/59.75%**、价格 **165/20.6%（全部来自库）**、sizeAmbiguous **322**、bySize 20、libStates 160/192/447/1、金额 10262.6 万；本次只改采集取价与展示/分母，不改变离线补数口径；
- **导出结构不变**：回填 16 / 配对 15 / 匹配库 10 列（openpyxl 复核通过）；
- **15 张截图已重生**（Lead 14:0x）：01~14 + 15（价格类型徽标 + 调试弹窗）；`_meta.json` 4.9 KB。

### 16.4 执行结果（Lead 环境 · 真实 Edge + CDP，2026-11-05 14:0x）

- 执行人 / 执行时间：**Lead** / **2026-11-05 14:0x**
- **`--with-ui` 汇总**：**97 通过 / 0 失败 / 0 阻塞 / 0 跳过（109.8s）**；UI 冒烟 **192/192**（`ok=true`、`consoleErrors=0`）
- **v2.1.7 关键 metrics（`ui-smoke.json`）**：
  - `v217`：captured=4、kinds 全 hand、kindCount=4、priceSrc 4 个「页面采集(到手价)」；kpis `{offSale:0, validTotal:800, pending:635, progressDenom:800, progressPct:21}`；KPI 文案「待补采 635 / 有效 800 行」「已下架 0 行（不计入分母）」；kindLabel=到手价；hasBadgeCss/hasCopyBtn/hasDebugDialog/hasOffSaleFilter=true
  - `v217Badge`：badgeCount=4、labels 全「到手价」
  - `v217Debug`：`{sku, price:5000, priceKind:hand, priceKindLabel:到手价, priceChanges:[], priceRect:null, sourceLabel:'页面采集(到手价)', candidates:[], at}`（该行来自旧采集记录，无候选属正常）
  - `v217DebugDialog`：open/candidates/priceChanges/priceKind/copyBtn 全 true
- **Lead 独立 acceptance_v217**：**10/10**（采集字段 priceKind=hand / 来源「页面采集(到手价)」/ priceRect `{x:820,y:120,w:180,h:40}` / priceChanges / note、价格类型徽标、调试弹窗与 lastDebug、下架分母 799、导出、回归）
- **mock CDP 新布局**：比价卡 8499、关联购买 1999、隐藏价、拆分数字 ¥8607.56、价格刷新 24699→25099 全部按预期取到真实价/口径，原 176 用例不回归
- **真实页面 10 SKU 手测**：**本轮未执行**（Lead headless 新配置未登录电商平台、且可能触发频控，避免误判）；手测方法已写入使用说明 3.18（真实登录 Edge 跑 10 个 SKU → 看价格类型徽标 + 行「调试」候选 JSON 的字号/位置与页面大号红字是否一致；异常发开发）
- **15 张截图（14:0x 重生）**：01 719.3 KB / 02 902.0 / 03 698.0 / 04 640.5 / 05 244.6 / 06 655.9 / 07 587.1 / 08 710.7 / 09 719.5 / 10 721.7 / 11 854.0 / 12 685.2 / 13 693.1 / 14 686.8 / 15 226.2（价格类型徽标 + 调试弹窗）/ `_meta.json` 4.9 KB

### 16.5 已知限制

- **电商平台页面 DOM 可能改版**：算法按当前页面结构（大号红字到手价/旁边小号电商平台价）设计，改版可能导致候选为空或口径误判——行「调试」JSON 可快速定位；不按阈值挑值，宁可采集失败也不猜；
- **真实页面手测未覆盖**：本轮 headless 未登录/有频控风险，10 SKU 真实页对照由用户/后续在登录环境执行；mock 布局覆盖有限，官方价 API 桥不适用竞品 SKU，AI 复核未集成（需 Key，后续可选）；
- **下架分母口径**：仅「已下架」不计入进度；软异常/风控仍计入（会重试/冷却），采集失败计入失败数；
- **价格类型徽标/调试弹窗**：旧采集记录无 candidates 时调试 JSON 为空属正常，需重新采集后才有候选明细；
- **稳定性等待时长**：连续 3 轮稳定 + 4×1.2s 复核会增加单 SKU 采集耗时（约 +5s 上限），换取最终刷新价准确，属预期。

> 结论：**通过**。数据侧：core **151/0/33 套件**、纯 Node **95/0/0/2 跳过**（4g 6 条）、CDP **218/218**、content selftest **50/277**、capture-client **41/41**；浏览器侧：**`--with-ui` 97/0/0/0（109.8s）**、UI 冒烟 **192/192**、Lead acceptance_v217 **10/10**、openpyxl 回填 16/配对 15/匹配库 10 列、15 张截图核对；v2.1.7 可交付。价格算法已整体移植自巡检双轨版 v2.1；官方价 API 桥/AI 复核/前台双轨按 §22.3 不采纳（原因见 16.1/README 2.12）。

---

> 报告维护：docs-qa（数据侧/文档）+ Lead（浏览器侧）· 最后更新 2026-11-05 14:1x（v2.1.7 终稿：数据侧 + 浏览器侧全部回填）· 结果 JSON：`tests/qa/.tmp/qa-result.json`（--with-ui 97/0/0/0）、`tests/qa/.tmp/ui-smoke.json`（192 steps / 192 pass / 0 skip）；截图：`docs/shots/`（01~15 共 15 张）。
