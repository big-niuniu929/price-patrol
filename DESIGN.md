# 市占率数据工作台 · 重构设计方案（v2）

> 状态：设计已定稿，进入实现。本文是所有模块的接口契约，改契约必须先改本文。
> 前身：`市占率/` 下的 Python 本地服务 + Edge 应用窗口工具（已归档到 `_archive/`）。
> 参考：`~/Desktop/巡检\extension`（电商平台价格巡检工作台，Edge MV3 插件，已稳定使用、未被反爬）。

---

## 1. 为什么要重构（旧工具实测问题）

读旧代码（`app.py` / `web_app.py`）并对比本月真实数据（`~/Desktop/资料\*.xlsx`）后确认：

| 现象 | 根因 |
|---|---|
| 换了个表头就认不出来 | 表头匹配是**硬编码候选集**：SKU 只认 `商品编号/sku/商品编码/sku（商品编码）`。本月榜单表头是 `SKU ID` / `SPU ID` → 直接报「缺少必要列」。 |
| 教育教学一体机文件直接失败 | `read_report()` 用 `workbook.active` 取工作表。该文件的 active sheet 是第 2 个「尺寸段和价格段」说明页，不是数据页。 |
| 读出来的行数是 0 / 只有表头 | `read_only=True` + `ws.cell()`：文件里 `dimension` 元数据不可靠，openpyxl 只认出 1×1，遍历拿不到数据。 |
| 本地启动麻烦、一直报错 | 依赖 Python 3 + openpyxl + tkinter 文件对话框 + 起本地 HTTP 服务 + 拉 Edge 应用窗口；任何一环（依赖、端口、杀软、tkinter）出错都表现为「打不开/报错」。 |
| 匹配库大量空格 | 匹配库 4 个 sheet 共 1046 个 SKU，只有 588 个填了尺寸段+价格段；「大家电 会议平板一体机」「品牌A 教育一体机」两个 sheet **0 填充**，旧工具只能人工一条条补。 |
| 尺寸段/价格段脏值 | 历史手工录入出现 `其他（50英寸）`、`其他尺寸(120英寸）`、`3000元3500元`、`未识别`、`110英寸` 等非规范值，无法直接用于统计口径。 |

**核心结论**：数据加工本质是「SKU → 尺寸段/价格段」的查表 + 补数。旧工具把重活全压在人工补录上；新工具用巡检插件的「在用户已登录的 Edge 里后台打开商品页读价」能力，把缺失的价格段/尺寸段自动补齐——这条路已验证没有反爬问题（同一账号、真人登录态、低频、只读页面 DOM）。

---

## 2. 目标

新工具是一个 **Edge/Chromium 浏览器插件（MV3）**，名字 **「电商平台市占率数据工作台」**，解决全流程：

1. **导入**任意版本的平台榜单 Excel（表头变了也能认）；
2. **自动绑定**榜单 → 匹配库类目（按 SKU 重合度 + 文件名，可人工改）；
3. **离线补数**：匹配库命中 → 同名商品推断 → 商品名解析尺寸（覆盖 84–93% 的尺寸段）；
4. **在线补数**：剩下的 SKU 用巡检插件同款方式后台打开 `item.shop.example.com/{sku}.html`，读价格与标题，自动换算 **价格段 + 尺寸段**；
5. **人工兜底**：表格内直接改、可筛选/搜索/批量重采；
6. **回填榜单**：在原榜单文件旁生成「已补齐尺寸段/价格段」的 xlsx（保留全部原始列）；
7. **出统计**：按类目/店铺的品牌销售金额与占比（市占率），以及按尺寸段、价格段的品牌分布；
8. **沉淀知识库**：本次补齐的映射自动写回内置匹配库，下个月直接用（越用越快）。

---

## 3. 架构

```
┌──────────────────────────── Edge（用户已登录电商平台） ────────────────────────────┐
│  extension/                                                                  │
│  ┌──────────────┐   chrome.tabs.update(url)    ┌───────────────────────────┐  │
│  │ app.html     │ ───────────────────────────► │ 后台标签页                 │  │
│  │ 工作台(4页)  │ ◄─────────────────────────── │ item.shop.example.com/{sku}.html    │  │
│  │ app.js       │   runtime.sendMessage        │ content.js 只读 DOM 取价   │  │
│  └──────┬───────┘                              └───────────────────────────┘  │
│         │ chrome.storage.local（本机，不上传）                                  │
│         │  lib/：xlsx-read / xlsx-write / header-map / rules / store / pipeline │
│         ▼                                                                     │
│   导入 xlsx（内存解析）→ 补数 → 导出 xlsx（浏览器内生成，anchor download）        │
└───────────────────────────────────────────────────────────────────────────────┘
```

- 纯 MV3 + 原生 JS（ES Module），**零外部依赖、零 CDN、零后端**：插件页 CSP 不允许远程脚本，也避免装环境。
- xlsx 读写自己实现：ZIP 用浏览器原生 `DecompressionStream/CompressionStream('deflate-raw')`，XML 自己解析。不依赖 SheetJS（无法联网下载，且体积大）。
- 数据只存 `chrome.storage.local`（申请 `unlimitedStorage`），不上传任何服务器；换电脑用「导出 JSON / 导入 JSON」。
- 采集节奏、暂停/停止/连续失败自动暂停、风控页识别、账号变化检测，全部沿用巡检插件 v1.1 已验证的策略。

---

## 4. 数据模型（chrome.storage.local）

键：`ds.library.v1`、`ds.session.v1`、`ds.settings.v1`、`ds.captures.v1`。每条带 `version`，读取时做迁移。

### 4.1 匹配库（knowledge base）

```js
// ds.library.v1
{
  version: 1,
  stores: {
    "大家电 会议电视": {
      name: "大家电 会议电视",
      keywords: ["会议电视", "电视"],       // 绑定榜单时的辅助词
      rows: {
        "100200174986": {
          sku: "100200174986",
          name: "海信100英寸会议电视…",
          brand: "海信",
          size: "98/100英寸",              // 规范值
          price: "10000元至15000元",        // 规范值
          sizeRaw: "", priceRaw: "",       // 导入时的原始脏值（便于追溯）
          source: "库",                    // 库 | 名称推断 | 页面采集 | 手动
          updatedAt: "2026-11-02T17:20:00+08:00"
        }
      }
    }
  },
  meta: { updatedAt, importedFrom: [] }
}
```

内置种子：`extension/data/base-skus.json`（由 `tools/build_base_from_xlsx.py` 从 `资料/匹配库.xlsx` + 旧 `data/match_library.json` 生成，当前 4 店 1046 SKU / 588 齐全）。首次打开插件自动导入种子。

### 4.2 会话（本月处理状态）

```js
// ds.session.v1
{
  version: 1,
  reports: [{
    id: "r-...", fileName: "11月-会议电视.xlsx", sheetName: "…汇总下载",
    headerRow: 0, columns: { sku:"SKU ID", name:"商品名称", brand:"品牌", amount:"成交金额", store:"店铺名称" },
    store: "大家电 会议电视", storeScore: 0.49,           // 绑定结果
    rows: [{
      rowNo: 2,
      raw: { "SKU ID": "100200174986", "商品名称": "...", ... },  // 全部原始列（保持顺序）
      sku, name, brand, amountRaw, amount: 300,                 // amount 单位：万元（区间中值）
      size: "98/100英寸", price: "10000元至15000元",
      source: { size: "库|名称推断|页面采集|手动|", price: "…" },
      status: "已匹配|已补采|部分|待补|待采集|采集失败",
      note: ""
    }],
    originalSheets: [...]   // 原文件全部工作表（用于回填时原样保留）
  }],
  activeReportId: "r-...",
  updatedAt: "..."
}
```

### 4.3 采集结果（按 SKU 缓存，跨月可复用）

```js
// ds.captures.v1
{ "100200174986": {
    sku, at, account, url, title, sizeInch: 100, sizeText: "100英寸",
    prices: { hand: 9999, main: 10999, plus: 9499 },
    priceKind: "hand",        // 采用的口径
    candidates: [...],        // 调试用原始候选
    flags: { verify:false, offSale:false, plusText:true },
    fail: null
} }
```

### 4.4 设置

```js
// ds.settings.v1
{
  version: 1,
  capture: { batchSize: 0, delayMin: 3, delayMax: 6, retries: 1, skipCapturedToday: true, keepTab: false },
  price: { prefer: ["hand","main","plus"], bandBoundary: "rightOpen", minPlausible: 30 },
  mapping: { overrides: { "某文件名.xlsx": { skuCol: "SKU ID", ... } } },
  ui: { lastPage: "workbench", bannerDismissed: false }
}
```

---

## 5. 规则引擎（lib/rules.js）

### 5.1 尺寸段（规范枚举，来自 `资料/11月-教育教学一体机.xlsx` 的「尺寸段和价格段」页）

| 英寸 | 尺寸段 |
|---|---|
| 55 | `55英寸` |
| 65 | `65英寸` |
| 75 | `75英寸` |
| 85 / 86 | `86/85英寸` |
| 98 / 100 | `98/100英寸` |
| 43 | `其他尺寸(43英寸)` |
| 110 | `其他尺寸(110英寸)` |
| 120 | `其他尺寸(120英寸)` |
| 150 | `其他尺寸(150英寸)` |
| 其他数字 | `其他尺寸({n}英寸)` |
| 完全解析不出 | `其他` |

- 从商品名/标题提取英寸：`/(\d{2,3})\s*(?:英寸|寸|吋)/`，兼容 `75吋`、`85寸`；排除 `分辨率`（如 `1920`）、`4K`、`英寸数` 之外的干扰数字（优先取带「英寸/寸/吋」的）。
- **脏值归一**：`其他（50英寸）`、`其他尺寸（50英寸）`、`其他尺寸(120英寸）` → `其他尺寸(50英寸)`；`110英寸` → `其他尺寸(110英寸)`；`未识别`/空 → `其他`。

### 5.2 价格段（18 段，规范枚举；`尺寸段和价格段` 表头写「17段」但实际列了 18 个值）

`1000元以下 / 1000元至2000元 / 2000元至2500元 / 2500元至3000元 / 3000元至3500元 / 3500元至4000元 / 4000元至4500元 / 4500元至5000元 / 5000元至5500元 / 5500元至6000元 / 6000元至7000元 / 7000元至8000元 / 8000元至9000元 / 9000元至10000元 / 10000元至15000元 / 15000元至20000元 / 20000元至25000元 / 25000元以上`

- 默认边界口径 `rightOpen`：`[low, high)`。即 `1000 ≤ 价 < 2000` → `1000元至2000元`；`price < 1000` → `1000元以下`；`price ≥ 25000` → `25000元以上`。
- 设置里可切 `rightClosed`：`(low, high]`，边界值归入下方区间。
- 脏值归一：`3000元3500元` → `3000元至3500元`；`3000元-3500元` → 同上；`25000以上` → `25000元以上`。
- 采集到的价格是「当前登录账号看到的页面价」，可能与人工口径有差异 → 每行显示 `价格参考` 与来源，允许手动改。

### 5.3 品牌补全（本月榜单实测：3 个榜单没有品牌列！）

旧工具要求「品牌名称」列，本月 4 个榜单里只有「教育教学一体机」有品牌列，其余 3 个没有 → 旧工具直接报「缺少必要列」。新工具必须有品牌识别链：

| 顺序 | 来源 | 说明 |
|---|---|---|
| 1 | 榜单品牌列 | 有该列且非空，归一化后使用 |
| 2 | 匹配库同 SKU 品牌 | 归一化（`华为（HUAWEI）` → `华为`） |
| 3 | 商品名称品牌词 | 别名表最长匹配优先（`品牌B会议平板…` → 品牌B） |
| 4 | 店铺名称品牌词 | `海信商用显示电商平台自营旗舰店` → 海信 |
| 5 | 兜底 | `''`，UI 显示「未标注品牌」，统计计入「未标注品牌」 |

- `rules.js` 导出 `BRAND_ALIASES`（canonical → 别名数组）与 `normalizeBrand(raw)`、`resolveBrand({brandRaw, name, storeName, libraryBrand})`。
- 实测覆盖率：会议平板 92%、会议电视 99%、3C店 86%、教育教学 86%（配合人工改品牌可到 100%）。
- UI 的品牌列同样允许行内编辑（兜底用），编辑后写回匹配库。

### 5.4 成交金额

榜单 `成交金额` 形如 `￥200万 ~ ￥400万`：取两个边界数字平均值 = `300`，**单位万元**。解析失败返回 `null` 并在行上标 `金额异常`（不阻断流程）。

**元/万元混排（本月真实数据实测，旧工具这里是错的）**：
- `￥200万 ~ ￥400万` → 300 万；`￥50万 ~ ￥75万` → 62.5 万；
- `￥6,000 ~ ￥8,000` → 0.7 万；`￥8,000 ~ ￥1万` → 0.9 万；
- 规则：带「万」先换成元；无「万」且任一边界 ≥ 1000 按元；两边界 < 1000 且无「万」才按万元。
- 本月 4 榜单：会议平板 42 行、会议电视 89 行是「元」口径，旧工具会放大 1 万倍，新工具合计 10262.6 万元已与 Python 独立基准一致。

---

## 6. 表头自适应（lib/header-map.js）——直接解决「换表头就报错」

1. **挑数据 sheet**：遍历所有 sheet，对前 10 行做表头打分（能匹配到 sku 字段 +2，name/brand/amount 各 +1），再按非空行数加权；跳过说明页（列数 < 3 或命中不到 sku 字段）。→ 修复「active sheet 是说明页」。
2. **挑表头行**：在前 10 行里选 `score = Σ(命中字段权重)` 最高的一行（有些榜单上面有合并标题行）。
3. **列名识别**（规范化：小写、去空格、全角括号转半角后比对）：
   - sku：`sku`、`sku id`、`skuid`、`spu id`、`商品编号`、`商品编码`、`sku（商品编码）`、`商品id`、`商品 id`
   - name：`商品名称`、`商品名`、`产品名称`、`标题`
   - brand：`品牌`、`品牌名称`、`品牌名`
   - amount：`成交金额`、`成交额`、`销售额`、`成交金额(元)`
   - store：`店铺`、`店铺名称`、`店铺名`、`商家名称`
   - size：`尺寸段`、`尺寸`、`屏幕尺寸`
   - price：`价格段`、`价格段(17段)`、`价格区间`、`价格`
   - rank：`排名`、`名次`；time：`时间`、`统计周期`、`周期`
   - 匹配策略：**精确别名 → 去标点后包含 → 编辑距离/相似度打分**；每个字段给出 `confidence` 与候选。
4. **兜底**：识别不出必需字段（sku）时，打开「表头诊断」对话框：列出前 10 行 × 各列内容，让用户点选哪列是 SKU/名称/品牌/金额/店铺，保存为按文件名记住的 overrides。
5. **SKU 文本化**：去首尾空格、去尾部 `.0`、保留前导零、禁止科学计数法；全表统一为字符串。
6. **行模型**：`raw` 保留全部原始列（顺序不变），只在末尾追加/补齐输出列。

---

## 7. 补数流水线（lib/pipeline.js）

`analyzeReport(report, library, settings)` 对每行按优先级求 `size` / `price`：

| 顺序 | 来源 source | 规则 |
|---|---|---|
| 1 | `库` | 匹配库同 SKU 有值（先归一化脏值） |
| 2 | `名称推断` | 全库同名商品（名称去标点后前 24 字符一致）且有值 → 采用，同分取同 sheet 优先 |
| 3 | `名称解析` | 从本行商品名解析英寸 → 尺寸段（只补 size） |
| 4 | 待办 | 仍缺 → `待采集`（缺 price） / `待补`（缺 size） |

`applyCaptures(report, captures)`：用采集结果补 `price=priceBandOf(price)`、`size=sizeBandOf(sizeInch)`（两者都有值时跳过）。
状态机：`已匹配`（库/名称推断）→ `已补采`（采集）→ `部分`（只有一项）→ `待采集`/`采集失败`/`待补`（人工）。

**实测工作量**（本月 4 个榜单 800 行，2026-11-02）：
- 尺寸段离线补全 **726/800 = 90.8%**（会议平板 96.5% / 会议电视 99% / 教育教学 83% / 3C店 84.5%）——比原估 75% 高，因为库命中 + 同名推断 + 名称解析叠加；
- 价格段离线补全 **192/800 = 24%**，剩余 **608 个 SKU 需在线采集**（3–6 秒/个约 30–60 分钟，可分批/暂停/断点续采）；
- 品牌识别 **771/800 = 96.4%**（会议平板 96% / 会议电视 100% / 教育教学 93% / 3C店 96.5%）；
- 成交金额合计 **10262.6 万元**（与 Python 独立基准完全一致）。

---

## 8. 采集（content.js + lib/capture-client.js）

- `content.js`：在 `item.shop.example.com` 商品页只读 DOM。沿用巡检 v1.1：价格稳定等待（连续 2 次一致，最长 20s）、过滤数字片段/折扣角标、合理价下限 30 元、多信号选价（到手价 → 电商平台价 → PLUS 价）。**新增**：标题、英寸尺寸、品牌、风控/下架标记。
  - 取价细节（v2.0）：7 类价格根节点（`#price`/`.summary-price`/`.p-price`/`#priceBox`…）→ 叶子/近叶子元素；候选必须「￥+数字」或类名含 price 的裸数字；**容器节点必须整段文本就是一个价格**（`电商平台价￥5999.00` ✓ / `到手价￥55折` ✗），防止把价格与「5折」拼成假价；剔除 `<del>/<s>/line-through/old|market|origin|strike|原价`、优惠券/满减/定金/尾款/运费/月供/分期/白条/已售/评价/销量上下文与隐藏节点；`getClientRects()` 为空或未连接的节点丢弃。
  - 口径：到手价/券后/预估到手 → `hand`；PLUS/会员价 → `plus`；电商平台价/秒杀价/促销价/售价 → `main`；默认优先级 hand→main→plus（设置可改）。
  - 尺寸来源优先级：商品标题（`.sku-name`/`#name h1`/`h1`）→ 规格参数表（`屏幕尺寸`/`显示尺寸`/`对角线尺寸` → `整机尺寸`/`产品尺寸`/`外形尺寸`；兼容 dl/dt/dd、table th/td、li「标签：值」）→ 主图 alt → `document.title`；正则 `(\d{2,3}(?:\.\d+)?)\s*(英寸|英吋|寸|吋)`，合理范围 10–300 英寸；「整机尺寸/产品尺寸」这类 mm/cm 三围**必须带英寸单位才采用**（不反推对角线）。
  - 异常 reason：风控/下架/取价不完整/无价格 四类中文文案；脚本内部异常 catch 后立刻发失败消息（不会让工作台空等 35s）。
- `capture-client.js`（`CaptureRunner`）：工作台页驱动一个**后台标签页**复用导航（不弹窗、不抢焦点），按设置节奏取数；消息按 sku 匹配（旧 sku / 其它标签页的迟到消息忽略并缓存早到消息），超时 35s、按 `settings.capture.retries` 重试（风控/下架不重试）；暂停/继续/停止；连续 3 个失败或识别到安全验证 → 自动暂停并提示；支持 `skus[]` 子集重采；每步回调进度；结束时关标签页（可保留）。
  - 采集结果消息（content.js → 工作台）：`{type:'ITEM_CAPTURE_RESULT', version, sku, url, title, titleRaw, titleSource, at, ok, reason, brand, size:{inch,text,source,sources}, main/plus/hand:{price,kind,cls,label,text}, pricePick:{price,kind}, candidates:[...], flags:{verify,offSale,plusText,loginText,priceFragment}, account:{nickname,plusHint,source}}`；`PING` → `{ok,sku,url,version}`。
  - `CaptureRunner.start(tasks, {skus?, keepTab?})` → summary `{done,total,ok,fail,stopped,autoPaused,autoPauseReason,skipped}`；`onResult({task,attempt,ok,reason,result,pricePick,capture})`，其中 `capture` 已是 §4.3 形状，UI 直接写缓存。
- 频率与合规：默认 3–6 秒随机、可分批、可暂停；只读页面、不调接口、不提交；建议专用账号；看到安全验证立即停。

---

## 9. 界面（app.html/app.css/app.js）

单页四区（沿用巡检工作台的深色玻璃风格，保持熟悉感）：

1. **工作台**：顶部 KPI（文件数/总行数/已补齐/待采集/采集失败/总成交金额）→ 数据源卡片（每个榜单：文件名、识别到的工作表、绑定类目、行数、可改绑）→ 工具栏（分析、补采价格、暂停/停止、筛选、搜索、导出）→ 配对表（虚拟滚动或分页 200 行，状态色、行内改尺寸段/价格段、打开商品页、单条重采）。
2. **匹配库**：店铺/类目列表 + SKU 表格（筛选：齐全/缺失/脏值）；导入（合并/覆盖）、导出、归一化清洗、冲突与重复检查、覆盖率统计。
3. **统计看板**：按类目的品牌金额/占比排名表 + 柱状图（纯 SVG）+ 尺寸段/价格段分布 + 交叉矩阵（品牌 × 价格段）。
4. **设置/帮助**：采集节奏、价格口径、边界口径、表头 overrides、数据导入导出（JSON 备份/恢复）、调试（最近原始候选）、帮助文档。

导出文件：
- `回填_<榜单文件名>_<时间>.xlsx`：原榜单全部列 + `尺寸段`/`价格段`（原表已有这两列则原地填），追加 `数据来源`。
- `市占率结果_<时间>.xlsx`：`统计_类目`、`统计_尺寸段`、`统计_价格段`、`配对_1..n`。
- `市占率备份_<时间>.json`：library + session + captures（可换机恢复）。
- CSV 明细（配对表当前筛选结果）。

---

## 10. 文件结构与分工（写入范围强制隔离）

```
extension/
  manifest.json            # jd-capture
  background.js            # jd-capture：点图标打开/复用工作台
  content.js               # jd-capture：商品页取价+取尺寸
  lib/capture-client.js    # jd-capture：批量采集驱动器（可注入 fake chrome 测试）
  app.html / app.css / app.js   # workbench-ui：工作台 UI + 编排
  lib/xlsx-read.js         # xlsx-core：xlsx 读取
  lib/xlsx-write.js        # xlsx-core：xlsx 写出
  lib/header-map.js        # xlsx-core：表头自适应
  lib/rules.js             # xlsx-core：尺寸段/价格段/金额规则
  lib/store-schema.js      # xlsx-core：存储模型/合并/归一化/冲突检查
  lib/pipeline.js          # xlsx-core：补数流水线 + 统计 + 导出数据组装
  data/base-skus.json      # Lead（已生成）
  icons/                   # Lead（已生成）
tools/                     # Lead：build_base_from_xlsx.py 等
tests/                     # xlsx-core 单测；docs-qa：验收脚本
dev-tools/                 # jd-capture：mock 商品页 + CDP 测试（注意：不能放进 extension/）
docs/                      # docs-qa：使用说明、截图、QA 报告
README.md                  # docs-qa（Lead 终审）
DESIGN.md                  # Lead
```

### 模块接口契约（ES Module，`window` 无副作用，可被 Node 直接 import）

```js
// lib/rules.js
export const SIZE_BANDS, PRICE_BANDS;
export function parseAmountRange(raw): number|null;
export function parseInch(text): {inch:number, match:string}|null;
export function sizeBandOf(inch, opts?): string;
export function sizeBandFromText(text): string;          // '' 表示解析不出
export function normalizeSizeBand(raw): {value:string, dirty:boolean};
export function priceBandOf(price, mode='rightOpen'): string;
export function normalizePriceBand(raw): {value:string, dirty:boolean};
export function parsePriceText(text): number|null;
export const SIZE_SYNONYMS, PRICE_SYNONYMS;              // 供 UI 下拉候选

// lib/xlsx-read.js
export async function readXlsx(input /* ArrayBuffer|Uint8Array|Blob|File */): Promise<{
  sheets: [{ name, rows: Array<Array<string|null>> }]
}>;

// lib/xlsx-write.js
export async function writeXlsx(workbook: { sheets: [{ name, columns?:[{header,width}], rows: Array<Array<string|number|null>>, freeze?:boolean }] }): Promise<Uint8Array>;

// lib/header-map.js
export const FIELD_ALIASES;
export function pickDataSheet(sheets): {index:number, reason:string, scores:[]};
export function detectHeader(rows): {headerRow:number, columns:{sku,name,brand,amount,store,size,price}, confidence, diagnostics};
export function normalizeSku(v): string;
export function parseReportSheet(sheet, overrides?): {fileName?, sheetName, headerRow, columns, rows: Array<{rowNo, raw, sku, name, brand, amountRaw}>};
export function suggestStoreBinding(report, library): {store:string, score:number, reasons:string[]};

// lib/store-schema.js
export const SEED_URL = 'data/base-skus.json';
export function emptyLibrary(); export function seedLibraryFromJson(seed);
export function mergeLibrary(lib, {stores, mode:'merge'|'replace'}); export function findLibraryIssues(lib);
export function upsertMatch(lib, store, record); export function normalizeLibrary(lib);
export function libraryToRows(lib); export function statsOfLibrary(lib);

// lib/pipeline.js
export function analyzeReport(report, library, settings): {rows, summary};
export function applyCaptures(report, captures): {updated:number};
export function computeStats(reports, library): {byStore, bySize, byPrice, matrix};
export function buildResultWorkbook(reports, stats, meta): workbookPayload;   // 给 writeXlsx
export function buildBackfillWorkbook(report): workbookPayload;
export function buildBackupJson({library, session, captures}): object;

// lib/capture-client.js
export class CaptureRunner {
  constructor({chromeApi, settings, onProgress, onResult, onLog});
  async start(tasks /* [{sku,url}] */, opts?); pause(); resume(); stop();
  get running; get state;
}
```

UI 只能调用上述接口，不得复制规则逻辑；规则变更只改 lib。

### 共同硬约束

- 扩展页面 CSP 严格：不许 `eval`、不许远程 `<script>`/`<link>`、不许内联事件属性（用 addEventListener）。
- 中文 UI；金额单位万元；SKU 一律字符串。
- 所有异步读取要 try/catch，错误要能在 UI 上显示成人话（不要 alert 原始异常）。
- 不修改 `~/Desktop/资料\` 下的任何文件（只读）。

---

## 11. 验收标准

1. `node tests/run.mjs` 全绿：xlsx 读取 5 个真实文件（行数/表头全部正确，含 1×1 dimension 的坏文件）、写出后用 openpyxl 复核、表头别名/边界口径/脏值归一单测。
2. 4 个榜单离线分析：`尺寸段` 覆盖率 ≥ 75%，`价格段` 覆盖率 = 库命中 + 同名推断（约 11%），其余标 `待采集`，不丢行、不抛异常。
3. 回填导出：原榜单全部列 + `尺寸段`/`价格段`/`数据来源`（原 13 列榜单 → 16 列；「教育教学」原表已有 `尺寸段`/`价格段` 两列 → 21 列，原地填值），行数与工作簿其它 sheet 一致；xlsx 能被 Excel/openpyxl 正常打开。验收口径以本条为准（不是「固定新增两列」）。
4. 插件在 Edge 中可加载（`edge://extensions` 无报错），工作台首屏可交互，四页可切换。
5. 采集链路用 mock 商品页（`dev-tools/mock-item.html`）跑通：价格/尺寸识别正确、暂停/停止/重采可用、连续失败自动暂停。
6. 统计正确性：类目总额 = 各行成交金额中值之和，品牌占比合计 100%（容差 0.01%）。

## 12. 路径稳定性与数据迁移（重要）

- 扩展以**绝对路径**加载，Edge 会按路径生成扩展 ID；**扩展目录一旦移动/改名，扩展 ID 变化，`chrome.storage.local` 里的数据会全部丢失**（巡检插件 README 里已经踩过这个坑）。
- 因此：`extension/` 必须固定在 `~/Desktop/市占率\extension`，README/使用说明首屏要写明；旧工具的其他文件可以归档/删除，但这个目录不能动。
- 数据可迁移：设置页提供「导出备份 JSON / 导入备份 JSON」，覆盖匹配库、会话、采集缓存；换电脑或重装时先导出再导入。
- 我们的重构不动 `extension/` 的路径；旧 Python 工具的文件归档到 `_archive/`，与新插件无关。

## 13. QA 环境事实（Lead 实测）

- Edge 版本 Edg/156.0.4314.58，`--headless=new` **可以加载未打包扩展**：CDP `/json/list` 里能看到 `chrome-extension://<id>/background.js` 的 service_worker target；`<id>` 从列表动态取，不要硬编码。
- 启动参数：`--headless=new --remote-debugging-port=<port> --user-data-dir=<%TEMP%临时目录> --no-first-run --no-default-browser-check --disable-gpu --load-extension="<扩展绝对路径>" about:blank`；启动约 2–8 秒后 CDP 可用。
- 沙箱下 Edge 启动会打印 crashpad/cache「拒绝访问」错误，属正常噪音，不影响 CDP。
- 清理测试浏览器：`taskkill /PID <初始进程id> /T /F`；**不要** `Get-Process msedge | Stop-Process`（会杀掉用户自己正在用的 Edge）。
- 无外网：不能访问 item.shop.example.com，采集链路只能用本地 mock 页面验证；真实取价由用户在已登录的 Edge 里首次试用时验证。

## 14. 风险与对策

| 风险 | 对策 |
|---|---|
| 电商平台商品页 DOM 改版，取不到价 | 沿用巡检多信号+合理价过滤；采集失败落到「采集失败」并支持手动改；设置里保留原始候选 JSON 便于排查 |
| 页面价格与人工口径不同（账号/券/地区） | 每行标注来源与采集时间；价格可手动改；可切账号重采 |
| 低频采集耗时（约 700 个 SKU） | 支持分批、断点续采（captures 持久化）、按类目跑 |
| 榜单表头再次变化 | 别名表 + 相似度 + 表头诊断手动映射（按文件名记住） |
| xlsx 特殊格式（合并单元格/隐藏列/公式） | 读取时取公式缓存值；回填时按行值重写（说明：极少数复杂格式会归一化） |

---

## 15. 实现与验收结果（2026-11-02 交付）

### 15.1 交付物

| 路径 | 说明 |
|---|---|
| `extension/` | 插件本体（Edge 加载这个目录）：manifest/background/content/app.html/app.css/app.js + `lib/` 7 个模块 + `data/base-skus.json` 种子 + icons |
| `README.md` | 面向使用者的安装/工作流/口径/FAQ/合规/开发验收说明 |
| `DESIGN.md` | 本文件（设计与接口契约） |
| `docs/使用说明.md`、`docs/QA报告.md`、`docs/shots/01~04.png` | 详细手册、验收报告、四页截图 |
| `tools/build_base_from_xlsx.py`、`tools/make_icons.py`、`tools/qa/shot.mjs` | 种子生成、图标、截图工具 |
| `tests/core/`、`tests/qa/`、`dev-tools/` | 单测 93 条、QA 验收 48 条、mock 商品页与采集 CDP 测试 |
| `_archive/2026-11-02-old-python-tool/` | 旧 Python 工具归档（含旧匹配库数据、旧说明书、回滚说明 ARCHIVE.md） |

### 15.2 验收证据（全部由 Lead 在真实 Edge 156 环境复跑）

| 门禁 | 结果 |
|---|---|
| `node tests/core/run.mjs` | **93 通过 / 0 失败 / 24 套件** |
| `node tests/qa/run.mjs` | **46 通过 / 0 失败**（纯 Node + Python openpyxl 独立复核） |
| `node tests/qa/run.mjs --with-ui` | **48 通过 / 0 失败 / 0 阻塞 / 0 跳过** |
| `node dev-tools/content_selftest_dom.mjs` | **18 用例 / 60 断言全绿**（取价+取尺寸，纯 Node） |
| `node dev-tools/test_capture_client.mjs` | **16/16 全绿**（采集驱动器） |
| `node dev-tools/cdp_capture_test.mjs` | **64 断言全绿**（mock 电商平台页 9 种布局） |
| Lead e2e（真实扩展 + CDP） | 导入 4 真实榜单 → KPI=4/800/90.75%/96.4%/10262.6万 → 分析 → 四页切换 → 导出 7 个文件全部落盘；console error = 0、runtimeErrors = [] |
| 官方截图 | `docs/shots/01-workbench.png` ~ `04-settings.png`（1440×900，已逐张人工核对） |

### 15.3 与初始设计的偏差（实现期确认，均已验收）

1. **品牌补全链**（§5.3）为实测新增：本月 3 个榜单无品牌列，必须从名称/店铺推断，否则市占率统计为空。
2. **成交金额元/万元混排**（§5.4）：真实榜单有「元」口径，旧工具会放大 1 万倍；新规则已修。
3. **价格段 18 段**（模板表头写 17 段，实际列了 18 个值）。
4. **品牌别名表扩充**：基础 51 词 + 24 个实测品牌（夏普/乐视/H3C/伍贰伍…），4 榜单识别率 96.4%。
5. **新增「导出全部榜单回填」**：每月 4 个榜单一键导出 4 个回填 xlsx（400ms 间隔，避免浏览器拦截连续下载）。
6. **采集协议附加字段**：`titleRaw/titleSource/elapsedMs/pricePick/size.source/size.sources/brand`（向后兼容）。
7. 回填列数：普通榜单 13 列 → **16 列**；「教育教学」原表已有尺寸段/价格段 → **21 列**。
8. UI 用「动态 import + try/catch 降级」，lib 未就绪时中文提示，不白屏。

### 15.4 后续可迭代（不在本次范围）

- 历史月份归档与市占率趋势看板（数据已具备，追加快照即可）；
- 采集结果多账号（普惠/PLUS）对照，用于「页面价 vs 会员价」分析；
- 复杂格式 xlsx 的样式级回填（当前是值级重写，样式归一化）；
- 飞书多维表格/在线协作接入（数据模型已按可迁移设计）。

---

## 16. v2.1 迭代设计（2026-11-03）：关键字段补全 · 日夜主题 · 类目子页 · 多采样复核

> 需求来源：用户 2026-11-03 反馈。
> 借鉴来源：`巡检插件版/extension`（2026-11-03 更新版）的「一个 SKU 多次采集 + 需人工确认」思路。
> **重要前提**：本工具采集的是**竞品数据**，没有阈值，也不猜阈值 → **不引入任何「向阈值/期望值靠近选值」的逻辑**；多采样只用于核对一致性，拿不准就交人工确认。

### 16.1 关键字段补全（本次重点）

用户明确的月度关键列（采集或直接从榜单导出）：

`SKU · 店铺 · 品牌 · 型号 · 套餐 · 尺寸段 · 价格段`

| 字段 | 现状 | v2.1 处理 |
|---|---|---|
| SKU | ✅ 已有 | 保持（文本化） |
| 店铺 | ⚠️ 只解析到 `row.storeName`，UI/导出未展示 | 配对表新增「店铺」列；回填保留原列；配对明细/CSV/结果 xlsx 均输出；无店铺列时用报告绑定的类目名兜底并标注 |
| 品牌 | ✅ 已有（推断链） | 保持 |
| 型号 | ❌ 缺 | 三级来源：① 榜单「型号」列（教育教学文件有）② 商品名称正则 ③ 页面采集规格参数（权威）→ 空则留空；匹配库新增可存 `model` |
| 套餐 | ❌ 缺 | ① 榜单「套餐」列 ② 商品名称正则（`4+128G`、`i5/8G/256G`、`翻页笔+投屏+推车` 等）③ 页面规格「套餐/套装/版本/规格」；识别不到就留空（用户已同意） |
| 尺寸段 / 价格段 | ✅ 已有 | 保持，多采样复核见 16.4 |

- 匹配库记录可选新增 `model`、`package` 字段（向后兼容，缺省空）；行内编辑可写回，下月复用。
- **实测提取率**（2026-11-03，4 榜单 800 行离线）：型号 **489/800 = 61.1%**、套餐 **473/800 = 59.1%**（会议平板 132/132、会议电视 144/87、教育教学 91/141、3C店 122/113）；剩余靠页面采集规格参数补齐，识别不到留空（不阻断）。
- 回填列策略：原表**已有** `尺寸段/价格段/型号/套餐` 列 → 原地填；没有 → 追加；尾部追加 `数据来源`、`复核状态`。
  普通榜单：13 列 → **19 列**（+尺寸段+价格段+型号+套餐+数据来源+复核状态）；教育教学：原表 20 列**已含 型号/套餐/尺寸段/价格段 4 列**（第 4–7 列）→ 原地填，只追加 **数据来源+复核状态 → 22 列**。通用规则：**列去重 + 已有原地填 + 缺的追加**，不重复加同名列。
- 配对明细/CSV 列（按用户给的 7 个关键列优先）：`SKU, 店铺, 品牌, 型号, 套餐, 尺寸段, 价格段, 商品名称, 成交金额(万元), 尺寸来源, 价格来源, 采样, 复核状态, 状态, 备注, 榜单, 行号`。

### 16.2 白天/黑夜主题

- `settings.ui.theme = 'auto' | 'light' | 'dark'`，默认 `auto`（跟随系统 `prefers-color-scheme`）。
- 顶栏新增主题切换按钮（☀/🌙），切换即生效并持久化；`<html data-theme="light|dark">`。
- app.css 改造成 CSS 变量 token（背景/玻璃卡片/文字/边框/表头/状态色/图表色/弹窗/toast/按钮），两套 token：`[data-theme="dark"]`、`[data-theme="light"]`；SVG 图表用 `var(--...)` 取色。
- 浅色模式必须可读：表格斑马纹、状态徽标（已补齐/需确认/采集失败）、KPI 数字、图表、dialog/toast 都要检查；浏览器原生控件（select/checkbox）跟随主题。
- 截图：深色 4 张为交付主图；浅色补 1 张 `docs/shots/05-workbench-light.png`。

### 16.3 类目品牌市占率 → 店铺子页（少滚动）

- 统计看板顶部加「类目选择条」：`全部` + 每个已绑定类目（`类目名 · 行数 · 金额`），点击切换；当前选择高亮。
- 选中单个类目时：
  - 「类目品牌市占率」区域只渲染该类目：品牌表全宽（排名、品牌、商品数、金额、占比、占比条），不再 4 个类目纵向堆叠；
  - 尺寸段分布 / 价格段分布 / 品牌×价格段矩阵 均按所选类目过滤；
  - 提供「打开该类目榜单」按钮 → 切到工作台并把该类目的榜单设为当前榜单。
- `全部` 视图保留原汇总表（可折叠/紧凑）。
- 状态存内存即可（可加 URL hash `#stats=<类目名>` 便于截图，可选）。

### 16.4 多采样复核（借鉴巡检「一个 SKU 查两次」，去掉阈值）

**采集模式**（`settings.capture.mode`）：

| 模式 | 行为 | 适用 |
|---|---|---|
| `smart`（默认） | 先采 1 次；命中「需复核信号」才再采，最多 `maxSamples` 次 | 日常（推荐） |
| `double` | 固定采 2 次，差值超容差可再补到 `maxSamples` | 价格段敏感月份 |
| `single` | 只采 1 次（旧行为） | 快速跑量 |

- `settings.capture.maxSamples = 3`（2~5）、`tolerancePct = 0.01`、`toleranceAbs = 30` → 一致判定：`spread <= max(toleranceAbs, minPrice × tolerancePct)`。
- **需复核信号**（`rules.shouldResample`，纯规则、无阈值）：
  1. `NEAR_BOUNDARY` 距价格段边界 ≤ `max(10, price × boundaryMarginPct)`（`price.boundaryMarginPct=0.01`）；
  2. `OUT_OF_REFERENCE` 价格超出「同店铺 + 同尺寸段」匹配库参考区间（库样本 ≥5：`[p10×0.3, p90×3]`）；
  3. `WEAK_EVIDENCE` 候选数 <2 / 选中口径 unknown / 来自文本兜底；
  4. 已有样本 `spread` 超容差 → 再补采（最多 maxSamples）。
- **选值**（`rules.chooseSampleValue`）：一致样本取**中位数**（偶数取中间均值）；不一致也取中位数，但标「需确认」。**绝不向库值/期望值靠拢**。
- **复核判定**（`rules.evaluatePriceReview`）→ `review.reasons[]`：

| code | 文案 | 说明 |
|---|---|---|
| `SAMPLES_INCONSISTENT` | 多次采样价差超容差（差 X 元） | 页面价在波动 |
| `SAMPLES_CROSS_BAND` | 多次采样落在不同价格段 | 边界附近真实波动 |
| `NEAR_BOUNDARY` | 价格接近价格段边界（距 X 元） | 小波动会改段 |
| `OUT_OF_REFERENCE` | 价格明显偏离同类参考区间 | 可能采错商品/读到配件价 |
| `LIB_BAND_MISMATCH` | 与匹配库已有价格段不一致 | 库有值但榜单价段为空时触发 |
| `WEAK_EVIDENCE` | 取价证据弱（候选不足/文本兜底） | 建议人工核对 |

- `review.needed = reasons.length>0 && !confirmed`；行状态新增 `需确认`；确认后→`已补采` + 「✓ 已人工确认（时间）」。
- UI：筛选「需确认」、KPI 卡片「待确认」（可点击筛选）、行内「确认」、工具条「确认当前筛选(N)」；确认记录 `confirmedAt`。
- 采集日志：每条显示「第 2 次复核」「2 次一致 median=¥X」「价差 ¥X 标需确认」。\n- **复核失败语义**（jd-capture 实现确认）：第 2 次及以后复核失败**不会**让整条任务失败——保留已成功样本继续取中位数出值；只有一次成功样本都没有才记「采集失败」；风控/下架仍照常触发自动暂停；日志写「复核第 N 次失败（原因），保留已有采样结果」。

### 16.5 取价加固（移植巡检 2026-11-03 版）

- `isStrike(el)`：`<del>/<s>/<strike>` 或自身/3 层祖先 `getComputedStyle().textDecoration` 含 `line-through` → 不是到手价，剔除。
- **精准标签法**：页面元素文本命中 `电商平台价/到手价/预估到手/券后/PLUS会员价/会员价` → 在最近 3 层容器里找非划线价格节点 → 生成 `strong` 候选（评分 +15）。
- **交叉校验**：`hand`/`plus` 价格高于 `main × 1.02` → 丢弃，防误判。
- 保留本工具已有的：价格稳定等待（连续 2 次一致）、合理价下限、数字片段/角标过滤、文本兜底、风险/下架识别。
- content.js 新增输出：`model/modelSource`、`package/packageSource`、`candidateCount`（可用候选数）、`textFallback`（是否用了文本兜底）；型号/套餐优先级：规格参数表 → 标题正则（识别不到返回空串，不阻断）。\n- CaptureRunner 记录新增：`price`、`samples[]`、`spread`、`consistent`、`sampleCount`、`candidateCount`、`textFallback`、`model/modelSource/package/packageSource`；旧字段全部保留。

### 16.6 配置与存储

```js
// ds.settings.v1 新增（老数据自动补默认值）
capture: { mode:'smart', maxSamples:3, tolerancePct:0.01, toleranceAbs:30 },
price:   { bandIdentity:'utils' /*本轮不启用*/, boundaryMarginPct:0.01 },
ui:      { theme:'auto' }

// ds.captures.v1 记录（向后兼容，老记录照常读）
{
  ...旧字段（prices/priceKind/sizeInch/...）,
  samples: [{price, kind, at}],      // 本轮采样明细
  spread: 18,                        // 采样价差（元）
  consistent: true,
  price: 5499,                       // 选中的价格（= prices[priceKind]）
  review: { needed:true, reasons:[{code,text,detail}], confirmed:false, confirmedAt:'' }
}

// 行（report.rows[]）新增
{ storeName, model, package, modelSource, packageSource,
  capturePrice, sampleCount, sampleSpread,
  review: {needed, reasons, confirmed, confirmedAt} }
```

### 16.7 明确不做 / 后续

- **不做阈值/期望值选值**：竞品数据没有阈值（用户已确认），只做一致性核对。
- **本轮不做双账号（普惠/PLUS）差价采集**：预留设计位置，等确认需要时再加。
- 套餐识别不到就留空，不阻断流程。

### 16.8 验收标准（v2.1）

1. `tests/core/run.mjs` 全绿且新增用例：`extractModel/extractPackage`、`priceBandInfo/chooseSampleValue/shouldResample/evaluatePriceReview`、`applyCaptures`（多采样+复核+老数据兼容）、导出列（回填普通 19 列 / 教育教学 22 列、配对明细 17 列、待确认 sheet 仅在有待确认行时生成）。
2. `dev-tools/test_capture_client.mjs`：多采样（smart/double/single）、decider 回调、样本一致性、日志与 summary、老行为回归。
3. `dev-tools/cdp_capture_test.mjs`：原有 64 断言全绿 + 新增「划线价/标签法/交叉校验/型号/套餐」用例。
4. `tests/qa/run.mjs --with-ui`：全绿；新增断言：主题切换（`data-theme` 变化+持久化）、四列存在（店铺/型号/套餐/复核）、统计类目 tab 切换、需确认筛选+确认流程、浅色模式无 console error。
5. 回归：4 榜单离线 KPI 不变（800 行 / 尺寸 90.8% / 品牌 96.4% / 金额 10262.6 万）；采集复核相关数字在 mock 数据下可复现。
6. 截图：深色 4 张 + 浅色 1 张，README/使用说明同步更新。

### 16.9 分工与写入范围（强制隔离）

| 负责人 | 文件 | 内容 |
|---|---|---|
| xlsx-core | `extension/lib/rules.js`、`header-map.js`、`pipeline.js`、`store-schema.js`、`tests/core/` | 字段提取、多采样/复核规则、行模型、导出列、单测 |
| jd-capture | `extension/content.js`、`extension/lib/capture-client.js`、`dev-tools/` | 取价加固、型号/套餐提取、多采样驱动、mock/CDP/单测 |
| workbench-ui | `extension/app.html`、`app.css`、`app.js` | 主题、字段列、统计子页、复核 UI、设置、确认流程 |
| docs-qa | `README.md`、`docs/`、`tests/qa/`、`tools/qa/` | 验收套件、文档、截图、QA 报告 |
| Lead | `DESIGN.md`、集成、终验 | 契约、联调、验收、交付 |

### 16.10 v2.1 实现与验收结果（2026-11-03）

| 门禁 | 结果 |
|---|---|
| `node tests/core/run.mjs` | **116 通过 / 0 失败 / 27 套件**（rules 28 / xlsx 13 / header-map 21 / store-schema 18 / pipeline 36） |
| `node tests/qa/run.mjs` | **61 通过 / 0 失败 / 2 跳过**（纯 Node + Python openpyxl 独立复核） |
| `node tests/qa/run.mjs --with-ui` | **63 通过 / 0 失败 / 0 阻塞 / 0 跳过（72.1s）**（ui-smoke 86/86 项） |
| `node dev-tools/cdp_capture_test.mjs` | **93/93 断言**（原 64 + v2.1 新增 29：划线价/标签法/交叉校验/型号套餐） |
| `node dev-tools/content_selftest_dom.mjs` | 23 用例 / 84 断言全绿 |
| `node dev-tools/test_capture_client.mjs` | 27/27（多采样、decideMore、账号变化暂停、复核失败保留样本） |
| Lead e2e（真实扩展） | 导入 4 榜单 → 关键列 → 主题切换/持久化 → `simulateCaptures` 造 3 条需确认 → 行内确认 + 批量确认归零 → 统计类目 tab → 导出 7 文件（4 回填+结果+备份+CSV）→ console error=0 |
| 截图 | `docs/shots/01~04`（深色）+ `05-workbench-light.png`（浅色），`_meta.json` consoleErrors=[] / runtimeErrors=[] |

- **版本**：`manifest.json` / `content.js` / `app.js` 均为 **2.1.0**；lib 接口冻结。
- **实测数据**：4 榜单 800 行；尺寸段 726/800=90.75%；价格段 192/800=24.0%（待采集 608）；品牌 771/800=96.4%；成交金额 10262.6 万；型号 489/800=61.1%；套餐 473/800=59.1%（识别不到留空）。
- **已知小口径差异**：统计「尺寸段分档数」在极个别浏览器会话为 24 档（差 1 个 `其他尺寸(24英寸)` 之类边界归类），Lead/纯 Node 基准为 25 档；不影响品牌市占率结论；已写入 QA 报告已知限制，列为 v2.1.1 可选项（分析结果可重复性）。
- **已知限制**：真实电商平台商品页本环境无法联网验证（首次建议每批 5~10 条核对口径）；型号/套餐为启发式（规格表优先、标题兜底）；多采样只做一致性核对，不向任何阈值/参考值靠拢（竞品数据无阈值）。

---

## 17. v2.1.2 迭代：SKU「小眼睛」悬停预览商品页（2026-11-03）

> 需求：用户「每个 SKU 旁边加一个小眼睛，鼠标移动过去就能渲染出商品页面，这样就不需要频繁打开关闭（标签页）」。
> 参考：`巡检插件版/extension/app.js` 第 782–887 行「商品页预览（小眼睛）」——同一用户已在巡检工具中验证并认可该交互。
> 环境已验证：`chrome.windows.create({type:'popup', focused:false})` 在本扩展页面可用（无需新增 manifest 权限；现有 `storage/tabs/unlimitedStorage` 足够）。

### 17.1 交互

- **位置**：工作台「配对表」每一行的 SKU 文本右侧，一个小眼睛按钮 `button[data-act="preview"][data-sku]`（无 SKU 的行不显示）；匹配库页本期不做（后续可加）。
- **悬停打开**：鼠标移入眼睛 → 延迟 **600ms** 打开预览小窗（`type:'popup'`，**不抢焦点**）→ 加载真实 `https://item.shop.example.com/<sku>.html` 页面（即“渲染商品页面”）。
- **移开自动关**：鼠标移出眼睛 → 若 600ms 延迟尚未触发则取消；若窗口已开且**未固定** → 延迟 **500ms** 自动关闭（给用户滑入窗口的时间）。
- **点击固定**：点击眼睛 → 打开并**固定**（窗口获得焦点，鼠标移开不关）；已固定时再点 → 关闭。再次悬停其它行 → 关闭旧窗口、打开新行窗口（同一时刻只存在 1 个预览窗口）。
- **自动清理**：切换工作台以外的页面、开始补采、工作台页关闭时关闭预览窗口；用户手动关窗后状态复位。

### 17.2 窗口位置与尺寸

- 尺寸：`width = min(1100, availWidth-80)`、`height = min(820, availHeight-100)`（按当前屏幕可用区域）。
- 优先放在工作台窗口**右侧**（不遮挡表格）；右侧放不下则放左侧；再不行居中；均按屏幕边界 clamp。
- `focused:false`（悬停打开）；固定时才 `focused:true`；位置参数非法（多屏/缩放）时退化为 `chrome.windows.create({url,type:'popup',width,height})`。

### 17.3 容错

| 场景 | 行为 |
|---|---|
| 非扩展环境（file:// 预览） | 眼睛按钮隐藏或点击提示「预览需要在插件内使用」 |
| `chrome.windows` 创建失败 | 中文 toast「预览窗口打开失败：…（可直接点『打开』查看商品页）」，不影响表格 |
| 页面加载慢/未登录/无网络 | 窗口内是电商平台页面自身的加载/登录/错误提示，工具不做额外处理；可点「打开」在标签页查看 |
| SKU 为空 | 不渲染眼睛按钮 |
| 补采运行中悬停 | 允许预览，但补采开始时会关闭已有预览窗口，避免抢占焦点 |

### 17.4 调试 API / DOM 契约（供 QA）

```js
window.__workbench.previewSku(sku, { pinned = false }) // Promise<{winId, tabId, url, pinned}>
window.__workbench.closePreview()                      // Promise<{closed:boolean}>
window.__workbench.getPreviewState()                   // {winId, sku, url, pinned} | null
```
- 行内按钮：`#matchBodyRows button[data-act="preview"][data-sku="<sku>"]`（`title` 含「悬停预览商品页；点击固定/取消固定」）。
- 固定态样式：`.eye-btn.pinned`。
- QA 浏览器断言：悬停 → 出现 `type=popup` 的窗口且 tab.url === `https://item.shop.example.com/<sku>.html`；点击固定 → `getPreviewState().pinned===true`；`closePreview()` 后窗口数回落且无残留；无 console error。

### 17.5 验收标准

1. `tests/core/run.mjs`、`tests/qa/run.mjs` 回归不破；
2. `--with-ui` 全绿 + 新增浏览器断言（悬停开窗 / 点击固定 / 关闭回收 / 无 console error）；
3. `node dom-dryrun.mjs`（fake chrome 含 windows mock）全绿；
4. 截图补充：`docs/shots/06-preview-hover.png`（悬停时预览窗口与表格同屏）说明性截图（headless 无网络时窗口内为空白/错误页，截图可用 mock 页面或注明；以 QA 报告说明为准）。
5. README/使用说明新增「小眼睛预览」说明与 FAQ。

### 17.6 v2.1.2 验收结果（2026-11-03）

| 门禁 | 结果 |
|---|---|
| `node tests/qa/run.mjs`（纯 Node） | **62 通过 / 0 失败 / 2 跳过**（新增预览静态契约 1 条） |
| `node tests/qa/run.mjs --with-ui` | **64 通过 / 0 失败 / 0 阻塞 / 0 跳过（77.2s）**；UI 冒烟 **99/99 项** |
| Lead 独立预览验收 `work/lead/acceptance_preview.mjs`（真实 Edge + CDP） | **7/7 断言**：100 个眼睛渲染、悬停 600ms 出 popup（focused=false、url=item.shop.example.com/<sku>.html）、移开 500ms 自动关、点击 pinned=true、closePreview 回收无残留、无 console error |
| `work/workbench-ui/dom-dryrun.mjs`（plain / WB_EXT） | runtimeErrors=[]；预览用例（悬停/移开/点击固定/再点关闭/手动关窗/切页关窗）全绿；补采 8/8、复核无回归 |
| 静态检查 | `check-ids` 135 个 DOM id 对齐、`check-contracts` 28/28、CSS 双主题 token 全绿 |
| 版本 | `manifest.json` / `app.js` / 文档统一 **2.1.2**（content.js 仍 2.1.0，未改动） |

- **真实环境观察**：未登录/高频访问时，预览窗口内的页面约 1s 后被电商平台重定向到 `https://pc-frequent-pro.pf.shop.example.com/?from=pc_item&reason=403`（验证页）；`getPreviewState().url` 始终是请求地址 `https://item.shop.example.com/<sku>.html`，因此断言以请求地址为准；正常登录浏览器应可直接看到商品页。已写入 README/使用说明 FAQ 与 QA 报告已知限制。
- **说明**：预览小窗是独立 `popup` 窗口，`page.screenshot` 无法与主表格同屏捕获，故未生成 `06-preview-hover.png`，交互以 `--with-ui` 的 8 组断言为准（DESIGN §17.5 允许）。
- **入口**：工作台「配对表」每个 SKU 右侧的小眼睛；匹配库页本期不加（后续可选）。

---

## 18. v2.1.3 迭代：当前价格列 · 配对总览页 · 工作台布局 · 套餐口径修正（2026-11-03）

> 用户反馈（2026-11-03 17:0x）：
> 1. 配对表缺少「当前价格」列——人工审核只需对照「当前价格列」和商品页价格是否相同（价格段由脚本匹配，一般不会错）；
> 2. 配对表显示区域太小——建议工作台增加「总览页」与「原工作页」区分，总览页呈现完整配对表，可筛选店铺、修改配对参数，修改后写入匹配库；
> 3. 在数据采集（工作台）想导出配对表时，发现配对表被遮挡（导入区/数据源/进度面板把表格挤到屏幕外，且导出下拉可能被盖）；
> 4. 「套餐」定义纠正：指商品页里**已选中的商品套餐/版本选项**（截图绿框：上面价格、下面 版本「会议大屏+摄像头【免费送装一体】」），不是标题里的内存规格（4+64GB 之类）。
> 另：用户担心修改代码后重新加载扩展，已跑出来的数据会不会被覆盖 → 见 18.5。

### 18.1 当前价格列

- 数据沿用 `row.capturePrice`（采集/多采样中位数，单位元）；无采集为 `null`。
- 工作台配对表：在「价格段」后新增列「当前价格(元)」；有值显示数字（千分位可关闭，保持纯数字便于对照）；无值显示 `—`。`title` 显示明细：`到手价 ¥x · 电商平台价 ¥y · PLUS ¥z · 采样 N 次 · 采集时间`；未采集时 title 提示「还没补采，点『补采价格』」。
- 总览页同列（见 18.2）。
- 导出列：
  - **配对明细**：17 → **18 列**，在「价格段」后插「当前价格(元)」（值=number 或 null）。
  - **CSV**：17 → **18 列**（表头「当前价格(元)」）。
  - **待确认 sheet**：「采集价」改名为「当前价格(元)」，保持列数 12。
  - **回填榜单**：追加「当前价格」列（普通 19 → **20 列**、教育教学 22 → **23 列**，位置在「价格段」后；已有「当前价格/采集价」列则原地填）。
- 统计（品牌市占率/价格段分布）不受影响。

### 18.2 配对总览页（新增第 5 页）

- 顶部导航：工作台 / **总览** / 匹配库 / 统计看板 / 设置与帮助；`data-page="overview"`，`#page-overview`。
- 布局：整页卡片，**表格占满视口剩余高度**（内部滚动、表头 sticky、底部 pager sticky），标题「配对总览 · 全部榜单配对结果（改完自动写回匹配库）」。
- 工具条（`#overviewTools`）：
  - 店铺筛选 `#overviewStoreFilter`：全部 + 各报表绑定类目（单选，默认全部）；
  - 状态筛选 `#overviewStatusFilter`（同工作台 6 态）；
  - 搜索框 `#overviewSearch`（SKU/名称/品牌/店铺/型号）；
  - 每页 `#overviewPageSize`：200 / 500 / 全部（800）；
  - 导出：`#overviewExportXlsxBtn`（导出当前筛选配对表 xlsx）、`#overviewExportCsvBtn`（CSV）。
- 表格列（15）：`行`（显示「榜单简称 #行号」）| `SKU`（带小眼睛预览）| `商品名称` | `店铺` | `品牌` | `型号` | `套餐` | `尺寸段` | `价格段` | `当前价格(元)` | `成交金额(万元)` | `采样` | `数据来源` | `状态` | `操作`（行内「确认」/「打开」）。
- 行内编辑（核心）：品牌/型号/套餐/尺寸段/价格段 五个 chip，点击→输入/下拉（尺寸段/价格段用 datalist 规范值）→Enter/失焦保存，Esc 取消。保存动作：
  1) 更新该行字段与 `row.source.* = '手动'`，重算 `status/review` 显示；
  2) `pipeline`/`store-schema.upsertMatch(library, {sku, brand, model, package, size, price, store, source:'手动'})` **写入匹配库**（同一 SKU 多处出现同步更新）；
  3) `markDirty('session'/'library')` 持久化 + toast「已写入匹配库（SKU 1234567）」；
  4) 失败/非法值（尺寸段/价格段不在规范枚举）→ 红框 + toast，不改库不写行。
- 排序：表头点击按 行号 / 成交金额 / 当前价格 / 尺寸段 / 价格段 排序（升降切换）。
- 数据范围：所有已导入榜单的全部行（跨榜单）；「店铺」筛选对应 `report.store`（类目绑定）。
- 空状态：未导入时提示「先在『工作台』导入榜单并分析补数」。
- 调试 API：`showOverview({store,status,search,pageSize})`、`getOverviewRows()`（返回筛选后行数/前 N 行摘要）、`editOverviewCell(sku, field, value)`（QA 用，返回 `{ok, oldValue, newValue, libraryWritten}`）。

### 18.3 工作台布局修复（配对表不再被挤到屏幕外 / 导出菜单不被遮挡）

- 导入完成后：STEP01 导入区折叠为紧凑条（显示「已导入 4 个榜单 · 重新导入/管理」按钮，点击展开上传区）；数据源卡片区折叠为默认收起的 `<details>`（summary 显示「数据源 4 个 · 类目绑定」）。
- 工作台页改为纵向 flex：KPI 行 + 工具条 + 配对表面板；`.table-wrap` 高度改为 `clamp(320px, calc(100vh - 300px), 900px)`，内部滚动、表头 sticky；pager 常驻可见。
- 补采运行时：进度/日志面板限高（`.log-panel` max-height 110px），且可折叠（`#progressPanel` 保留），不把配对表挤出视口。
- 导出下拉 `.menu-list`：z-index ≥ 200；靠近视口底部时向上弹出；点击任一项后自动关闭；确保 1344×756 下完整可见、可点。
- 验收（1344×756 与 1440×900）：导入 4 榜单后**首屏可直接看到配对表 ≥6 行**；导出菜单 5 项完整可见；补采进行中配对表仍可见（可滚动）。

### 18.4 套餐口径修正：商品页「版本/套餐」已选项

- 内容脚本新增 `extractVariantGroups()`：
  - 扫描商品页右侧规格选择区（`#choose-attrs`、`.Ptable`、`[class*="choose-attr"]`、`[class*="sku-"]`、`[class*="spec"]` 等候选容器）；
  - 按「标签行（系列品/屏幕尺寸/版本/套餐/规格/颜色/型号/配置/套装/组合/包装）+ 选项按钮组」识别分组；
  - 组内选中项判定：`[class*="selected"]` / `[aria-selected="true"]` / `.cur` / `.active` / 计算样式有明显高亮（边框/背景色）；
  - 输出 `specGroups: [{label, selected, options, source}]`。
- `package` 取值优先级：label 匹配 `/套餐|版本|套装|组合|配置|规格/` 的组选中项（排除 `屏幕尺寸/尺寸/系列品/颜色/型号`）；取完整文本（保留 `【】`，去掉「已选：」「请选择」等前缀、箭头），长度 2~80；识别不到 → `''`（**不再用标题内存规格兜底**）。
- 附加：`屏幕尺寸` 组选中项参与尺寸解析（来源 `variant`）。尺寸优先级：**有规格选择区的新版页面** = `规格参数表 > variant > 标题`；**没有变体区的老页面**沿用旧链路 `标题 > 规格参数表 > alt > document.title`（保证 93 条旧基线不回归）。`packageGroup` 记录来源标签。
- capture 消息新增 `specGroups`、`packageGroup`；`packageSource` 取值 `规格选项`/`规格表`/`标题`（`applyCaptures` 写入行时统一展示为「页面采集」）。
- 离线分析：套餐只来自榜单「套餐」列（header-map 已支持）；**实测教学教育文件「套餐」列仅有 1 行有值，其余榜单为 0 → 离线套餐 ≈ 1/800，必须靠页面采集补**；`analyzeReport` 不再从标题提取套餐；旧会话中 `packageSource ∈ {名称, 标题, 名称解析}` 的套餐值在升级首次加载时**清理为空**（保留 `列 / 页面采集 / 手动` 的值），toast 提示清理条数并建议导出备份。\n- **补采范围相应放宽**：采集任务除「缺价格/尺寸」外，还包含「缺套餐/缺型号」的行（含已补齐价格但套餐为空的行，采集时只更新型号/套餐/品牌，不改已确认的价格/尺寸）；工具条与进度面板显示「含补套餐/型号」。
- mock 页面新增与截图一致的「系列品 / 屏幕尺寸 / 版本（4 个选项，选中『会议大屏+摄像头【免费送装一体】』）」布局；CDP/自检断言 `package === '会议大屏+摄像头【免费送装一体】'`、尺寸 `100英寸`、价格读到手价。

### 18.5 数据持久化（回答用户问题）

- 扩展数据保存在 `chrome.storage.local`：`session`（导入的榜单 + 每行结果 + 状态 + 人工确认）、`captures`（采集缓存/多采样）、`library`（匹配库）、`settings`。与代码文件分离。
- **重新加载扩展 / 刷新页面不会覆盖已跑数据**：扩展目录路径不变 → 扩展 ID 不变 → storage 原样保留；页面打开时自动恢复（已有 v2.1 QA 用例覆盖：刷新后 800 行、确认状态、匹配库都还在）。
- 升级 v2.1.3 首次打开会执行一次迁移：仅清理旧版「标题推测套餐」（无采集/无手动来源的），其余全部保留；迁移前把旧 `session` 快照写入存储键 `backup_v213`，并在日志提示可导出备份 JSON。
- 会丢数据的操作：移动/重命名 `extension/` 目录（ID 变化）、移除扩展或在扩展详情里清除数据、浏览器「清除站点数据」、工具内「清空榜单」。
- 建议：改动较大前点「导出备份 JSON」，出问题可从备份恢复。

### 18.6 验收标准（v2.1.3）

1. `tests/core/run.mjs`：导出列 18（配对明细）/20（普通回填）/23（教育教学回填）；套餐离线=仅榜单列（**实测 1/800**，教育 E 列仅 1 行有值）+ 页面采集覆盖；迁移清理函数；当前价格字段导出；原有 116+ 条不回归。
2. `tests/qa/run.mjs --with-ui`：新增 UI 断言 ≥12 条——当前价格列存在且显示采集价；总览页全量行数=800、店铺筛选、行内编辑后匹配库有值、刷新后仍在；工作台 1344×756 首屏表行数≥6；导出菜单 5 项可见；mock 页面套餐断言（CDP）；数据迁移清理断言。
3. 截图：`06-overview.png`（总览页全量表格）、`07-workbench-visible.png`（1344×756 首屏可见配对表）；旧 01~05 重生。
4. 手册/README/QA 报告更新（当前价格列、总览页、套餐来源、持久化 FAQ）。

### 18.7 匹配库表头与工作台对齐（用户 2026-11-03 17:1x 追加）

- 匹配库页 `lib-tbl` 表头顺序改为与工作台配对表一致（去掉工作台专属的 行/当前价格/成交金额/采样/状态）：
  `SKU | 商品名称 | 店铺 | 品牌 | 型号 | 套餐 | 尺寸段 | 价格段 | 数据来源 | 更新时间 | 操作`（11 列）。
- 店铺列取值：匹配库记录按类目归档，显示 `record.storeName`（类目名，例如「大家电 会议平板一体机」），`title` 说明「匹配库按类目归档」；若记录带 `shop`（JD 店铺名，来自行内编辑写回时记录）则优先显示 `record.shop`。
- 型号/套餐列若库记录缺省显示 `—`；品牌/型号/套餐/尺寸段/价格段在匹配库表中同样可点击行内编辑（写回本库记录，来源=手动），与工作台/总览页行为一致。
- `来源` 表头改「数据来源」，取值仍为 库/导入/手动 等；更新时间保留。
- 验收：ui-smoke 断言匹配库表头数组以 `['SKU','商品名称','店铺','品牌','型号','套餐','尺寸段','价格段']` 开头；库内编辑型号/套餐后刷新仍在；导出匹配库 xlsx 的列顺序与新表头一致。

### 18.8 v2.1.3 验收结果（2026-11-03，真实 Edge 156 + CDP）

| 门禁 | 结果 |
|---|---|
| `node tests/core/run.mjs` | **120 通过 / 0 失败 / 28 套件（7.5s）** |
| `node tests/qa/run.mjs`（纯 Node） | **67 通过 / 0 失败 / 2 跳过**（新增 4c 节 5 条 v2.1.3） |
| `node tests/qa/run.mjs --with-ui` | **69 通过 / 0 失败 / 0 阻塞 / 0 跳过（103.1s）**；ui-smoke 125/125 项 |
| Lead `work/lead/acceptance_v213.mjs` | **11/11**：首屏配对表 **10 行**（1344×756）、导出菜单 5 项完整、当前价格列 5555、总览 800/店铺 200/编辑写库/刷新持久化、匹配库 11 列表头、迁移清空+flag、console errors=0 |
| `node dev-tools/cdp_capture_test.mjs` | **107/107**（variantpanel 14 条 + 旧口径 4 条调整） |
| `node dev-tools/content_selftest_dom.mjs` | 28 用例 / 110 断言 |
| `node dev-tools/test_capture_client.mjs` | 27/27 |
| 导出独立复核（openpyxl） | 配对明细 **18 列**（价格段后「当前价格(元)」=5555）、回填普通 **20 列**、教育 **23 列**、待确认 12 列第 10 列「当前价格(元)」、套餐页面采集值 `会议大屏+摄像头【免费送装一体】` |
| 截图 | `docs/shots/01~05` 重生 + **06-overview.png**（总览 800 行）+ **07-workbench-visible.png**（1344×756 首屏可见 11 行） |

- 版本：`manifest.json` / `content.js` / `app.js` = **2.1.3**（content VERSION 2.1.3、APP_VERSION 2.1.3）；manifest 无 BOM。
- 当前价格列：`row.capturePrice`；无采集显示 `—`；CSV/配对明细/回填/待确认均带该列。
- 补采范围已含「缺套餐/缺型号」（工作台提示「缺套餐 799、缺型号 311」），采集时页面「版本」已选项写入套餐；`applyCaptures` 允许已补齐行只补型号/套餐/品牌。
- 匹配库：11 列表头对齐 `SKU|商品名称|店铺|品牌|型号|套餐|尺寸段|价格段|数据来源|更新时间|操作`；店铺列=匹配库类目；型号/套餐/品牌/尺寸段/价格段均可行内编辑写回。
- 已知提示：`资料/匹配库.xlsx` 于 17:53 被外部更新（3C店 447→502 行），内置种子未重建；用户可在匹配库页「导入并合并/覆盖」导入最新文件（不影响已跑数据）。

---

## 19. v2.1.4 迭代：匹配库人工核验 · 导出表头一致性 · 频控应对 · 新内置匹配库（2026-11-04）

> 用户反馈（2026-11-03 晚 / 11-04 上午）：
> 1. 仅靠商品名识别与页面取价的结果不应直接写回匹配库（会污染、未经人工核验）——导入新榜单时要能识别「库里没有的 SKU」并用不同颜色标出；脚本/AI 补齐后必须人工点「确认写入匹配库」才变为普通颜色；
> 2. **BUG**：匹配库和工作台导出的表格与插件界面里看到的表头不一致（列名/列序都不一样）；
> 3. 已被电商平台频控，无法巡检（打开商品页变成电商平台商城首页）；
> 4. 但鼠标悬停小眼睛仍能渲染商品页；
> 5. `资料/匹配库.xlsx`（2026-11-03 17:53 更新版）为权威数据，插件内置旧种子是脏数据，必须改用新文件。

### 19.1 匹配库信任/核验机制（新增）

**库记录字段**（store-schema）：
- `verified:boolean`（是否人工核验过；种子/导入默认 true，自动写入默认 false，人工确认后 true）、`origin:'seed'|'import'|'manual'|'confirm'`、`verifiedAt`。

**行级状态 `row.libState`**（pipeline 新增 `annotateLibraryStates(reports, library)` 计算，UI 展示）：
| libState | 条件 | 颜色 | 徽标 |
|---|---|---|---|
| `verified` | 库中记录存在且 verified 且有尺寸段+价格段 | 正常 | 已入库 |
| `incomplete` | 库中记录存在但 verified=false 或缺尺寸段/价格段 | 浅黄 | 库数据不全 |
| `new` | 库中不存在该 SKU | 橙色 | 新 SKU |
| `pending` | 自动补齐（名称/采集）后尚未确认写入 | 蓝色 | 待确认写入 |

- **写入规则**：`analyzeReport`/`applyCaptures` **绝不写匹配库**；只有①用户行内手动改（视为人工核验，写库 verified=true origin=manual）②用户点「确认写入匹配库」（写库 verified=true origin=confirm）才写。
- UI：
  - 工作台/总览新增列「入库状态」+ 行底色/左侧色条（按 libState）；状态筛选新增「新 SKU / 库数据不全 / 待确认写入」三项；
  - KPI 新增「待确认写入 N」；工具栏按钮「确认写入匹配库(N)」（当前筛选内 libState=pending 的行，批量）；
  - 行内操作新增「确认写入」（pending 行）；确认前校验尺寸段/价格段合法且齐全（缺则拒绝并提示）；
  - 确认后：写库 + `row.libState='verified'` + 颜色/徽标更新 + toast；`settings.ui.confirmedWrites` 计数。
  - 匹配库页：记录显示「已核验/待核验」小徽标（不影响 11 列表头）。
- 自动化：`window.__workbench.getLibraryStates()` → `{verified,incomplete,new,pending, total}`；`confirmLibraryWrite(skus?)` → Promise<{written, rejected}>。

### 19.2 导出表头与界面完全一致（BUG 修复）

**唯一列定义（与界面表头逐字一致，导出不含「操作」列）**：

- 工作台配对表 / 总览表 / 配对明细 xlsx / CSV（**15 列**）：
  `行`、`SKU`、`商品名称`、`店铺`、`品牌`、`型号`、`套餐`、`尺寸段`、`价格段`、`当前价格(元)`、`成交金额(万元)`、`采样`、`数据来源`、`状态`、`入库状态`
  - `行` 的单元格内容 = `榜单简称 #行号`（与界面一致）；界面另有「操作」列，不导出。
- 匹配库页 / 匹配库导出 xlsx（**10 列**）：`SKU`、`商品名称`、`店铺`、`品牌`、`型号`、`套餐`、`尺寸段`、`价格段`、`数据来源`、`更新时间`（界面另有「操作」）。
- 回填榜单：原表全部列保留，追加列名统一为 `尺寸段`/`价格段`/`当前价格(元)`/`型号`/`套餐`/`数据来源`/`复核状态`（普通 20 列、教育教学 23 列，数量不变；「当前价格」改名为「当前价格(元)」）。
- 待确认 sheet 12 列不变，表头与界面一致（当前价格(元)）。
- 验收：导出文件表头数组 === 界面表头数组（去掉操作列），列序一致；openpyxl 复核。

### 19.3 频控应对（无法绕过，只能降风险 + 人工通道）

- **风险识别**：content.js 检测落地页异常——跳电商平台首页（`item.shop.example.com/` 根、`www.shop.example.com`、`home.shop.example.com`）、登录页、验证页（含「安全验证/访问频繁/请验证/电商平台验证」等文案）→ 结果 `risk:{hit:true, reason, url}`。
- **自动冷却**：CaptureRunner 遇 risk → 立即暂停 + 记录 `cooldownUntil = now + settings.capture.cooldownMinutes`（默认 60 分钟）；进度面板显示「已触发风控，建议冷却/换账号/换网络」倒计时；冷却期内禁止开始补采。
- **降低风险设置**（默认值保守）：采集随机间隔 5~10s、每批上限 20 条、每 8 条随机长休息 30~60s、单标签页复用；设置页可调。
- **人工预览采集通道（关键 workaround）**：悬停小眼睛打开的商品页小窗，加载完成后扩展自动向该 tab 请求一次快照（`PREVIEW_CAPTURE`），返回 到手价/电商平台价/尺寸/型号/套餐；工作台显示一条「预览读数：SKU · 到手价 ¥x · 尺寸 · 套餐 [采用] [忽略]」浮条；用户点「采用」→ 按普通采集结果写入当前行（仍为 `pending`，需再人工确认入库）。人工逐条、低频，规避自动化频控。
- **用户操作建议**（写入 README/FAQ/报告，并在风控横幅提示）：停 24 小时再采、切换电商平台账号、切网络（手机热点/家宽）、降低频率（每批 ≤10、间隔 ≥10s）、优先用预览人工核对；不要连续重试。

### 19.4 新内置匹配库（权威版 2026-11-03 17:53）

- 已用 `tools/build_base_from_xlsx.py --legacy 不存在` 从新版 `资料/匹配库.xlsx` 重建 `extension/data/base-skus.json`：4 类目 **1101 SKU**（会议电视 200/齐全 148、会议平板 200/齐全 0、3C店 501/齐全 490、教育 200/齐全 0）；旧 legacy 合并已关闭。
- 种子增加 `schemaVersion`/`fingerprint`；`store-schema.seedLibraryFromJson` 带 meta。
- **升级迁移**：初始化检测到 stored library 的 `meta.fingerprint` ≠ 内置新指纹 → 用新种子替换内置库，保留 `origin='manual'/'confirm'` 的人工信记录（合并覆盖），toast「内置匹配库已更新为新版（1101 SKU）」，并写 settings.ui.seedVersion；不再导入旧「脏」种子。
- **新回归基准（4 榜单 800 行，未采集）**：尺寸段 **734（91.75%）**、价格段 **242（30.25%）**、品牌 **772（96.5%）**、金额 10262.6 万、bySize 25 档、品牌数 69。库状态（`annotateLibraryStates`）：**verified 160 / incomplete 184 / new 378 / pending 78**（pending=脚本补齐尺寸+价格但未人工确认，含名称推断 69 新 SKU + 9 库内不全行）；采集一条 new 行后 pending 78→79、new 378→377。旧基准 726/192/771/pending0 作废，tests/core、tests/qa、文档、截图数字全部按新基准更新。

### 19.5 验收标准

1. `tests/core`：种子 1101/638、fingerprint/meta、verified/origin 字段、`annotateLibraryStates`（4 态计数/不写库）、导出 15/10 列表头与界面一致、回填 `当前价格(元)`、新基准 734/242/772。
2. `tests/qa --with-ui`：新 SKU/库数据不全/待确认写入 颜色与徽标、筛选、KPI、确认写入（单行+批量+非法拒绝+刷新持久化+库记录 verified）、导出表头 === 界面表头（工作台 CSV/总览 xlsx/配对明细/匹配库 xlsx）、预览读数采用流程（模拟）、风险横幅/冷却、新种子迁移。
3. mock 商品页/风险页：content 返回 risk；预览快照 handler 可用。
4. 截图：`08-workbench-libstates.png`（四色行）、`09-confirm-write.png`（确认写入）；01~07 重生。
5. 文档：README/使用说明/QA 报告更新；频控应对章节。

### 19.8 v2.1.4 验收结果（2026-11-04，真实 Edge 156 + CDP）

| 门禁 | 结果 |
|---|---|
| `node tests/core/run.mjs` | **132 通过 / 0 失败 / 30 套件** |
| `node tests/qa/run.mjs`（纯 Node） | **74 通过 / 0 失败 / 0 阻塞 / 2 跳过**（4d 节 7 条全过） |
| `node tests/qa/run.mjs --with-ui` | **76 通过 / 0 失败 / 0 阻塞 / 0 跳过（113.8s）**；ui-smoke 142 steps / 140 pass / 2 skip |
| Lead `work/lead/acceptance_v214.mjs` | **14/14**：KPI 734/242/772、`getLibraryStates()` 160/184/378/78、四色行类与筛选、确认写入（pending 78→79→78、库记录 verified/origin=confirm）、导出表头逐字一致（CSV 15 列 / 匹配库 xlsx 10 列，openpyxl 复核）、种子迁移幂等（1101/keptManual/fingerprint）、风控横幅+冷却禁用+恢复、预览读数 API，console errors=0 |
| `node dev-tools/cdp_capture_test.mjs` | **141/141**（riskhome 18、variantpanel 30 含 PREVIEW_CAPTURE、原 107 不回归） |
| `node dev-tools/content_selftest_dom.mjs` / `test_capture_client.mjs` | 34 用例 / 163 断言；33/33 |
| 导出复核 | 配对明细/CSV 15 列 === 界面表头去「操作」；匹配库 xlsx 10 列；回填 20/23 列且表头「当前价格(元)」；待确认 12 列 |
| 截图 | `docs/shots/01~09`（08 四色入库状态、09 确认写入） |
| 版本 | manifest/app.js/content.js = **2.1.4**（manifest 无 BOM） |

- 新基准（新内置库 1101 SKU/638 齐全，fingerprint 780d76cf20900fe3）：尺寸段 734/800=91.75%、价格段 242/800=30.25%（待采集 558）、品牌 772/800=96.5%、金额 10262.6 万、bySize 25、品牌数 69。
- 匹配库可信度：`annotateLibraryStates` = verified 160 / incomplete 184 / new 378 / pending 78；**analyze/capture 绝不写库**；只有人工「确认写入匹配库」（或手动编辑）才写，写后 verified/origin=confirm。
- 频控：识别首页/验证页/登录页 → 自动暂停 + 冷却 60 分钟 + 降频默认（5~10s、每批 20、每 8 条长休息 30~60s）；预览人工通道 `PREVIEW_CAPTURE` → 浮条「采用/忽略」，采用后仍 pending 需人工确认入库。
- 已知限制：电商平台风控无法绕过（仅识别/冷却/降频/人工预览）；真实电商平台 DOM 风险页/变体组识别为启发式；匹配库 Excel 若后续再更新，重新运行 `tools/build_base_from_xlsx.py` 并用「重置为内置新版」即可。

---

## 20. v2.1.5 迭代：回填导出对齐 · 确认写入完整性 · 表格列筛选/显隐 · 异常自动继续 · 匹配库保护与操作日志（2026-11-04）

> 用户反馈（2026-11-04 15:27，11 条）：
> 1. 导出的「榜单回填 xlsx」与工具界面不一致，应为界面同款列：`行 SKU 商品名称 店铺 品牌 型号 套餐 尺寸段 价格段 当前价格(元) 成交金额(万元) 采样 数据来源 状态 入库状态 操作`；
> 2. 采集「20 条/批」频控保护无法在设置里调整/调整后仍按 20 条运行；
> 3. 点「确认写入」后进入匹配库，原「确认写入」应显示「已确认」；
> 4. 配对表/总览允许隐藏指定列（屏幕放不下，左右横拉麻烦），或允许表格缩放；
> 5. **BUG**：确认写入后库里字段不全（只写尺寸段缺价格段，或反之）；
> 6. 鼠标在哪一列，哪一列显亮色（列悬停高亮）；
> 7. 匹配算法：优先匹配库 → 库里没有按商品名称匹配尺寸段；**名称里出现多个尺寸值时不识别、留空等人复核**；价格段库没有则去页面取价后识别价格段；
> 8. 下架商品显示下架、部分商品跳回电商平台首页（非频控）被误判为风控并永久暂停；应「等 1 分钟自动继续」，不要人工重启；
> 9/11. 配对表表头加筛选功能；
> 10. 匹配库很重要，需要**操作日志**；
> 11. **用户已在插件匹配库里更新了很多内容，本次升级绝不能覆盖匹配库**（现有库比 资料/匹配库.xlsx 更全）。

### 20.1 回填导出与界面一致

- 「导出当前/全部榜单回填 xlsx」改为**工具配对表同款 16 列**（按用户给定顺序）：
  `行、SKU、商品名称、店铺、品牌、型号、套餐、尺寸段、价格段、当前价格(元)、成交金额(万元)、采样、数据来源、状态、入库状态、操作`
  - 每个榜单文件生成 1 个 sheet（sheet 名=榜单简称），行=`榜单简称 #行号`；`操作` 列留空（文件无按钮，表头保留以与界面逐字一致）。
  - 不再输出原始榜单列（v2.0 的「保留原列+追加」口径作废，用户已明确要求界面同款）。
- 总览导出/配对明细/CSV 维持 15 列（上一轮已一致）；匹配库导出 10 列不变。

### 20.2 采集批量保护设置生效

- 设置页「每批上限」（`#setBatchLimit`，默认 20，可 5~100）必须在**运行时生效**：`startCapture` 使用当前 settings 值构建任务队列并截断，不得再写死 20；进度/日志显示「本批 N 条（上限 M）」；capture-client `maxBatch` 以传入 settings 为准。
- 同样检查随机间隔/冷却/自动暂停设置实时生效（改完保存后下一次采集即生效）。

### 20.3 确认后文案「已确认」

- 确认写入成功后：工作台/总览「入库状态」= **已确认**（原「已入库」）；行内操作按钮变为**已确认**（禁用样式，不可重复点）；匹配库页记录徽标 = **已确认**（原「已核验」）；匹配库「数据来源」显示 `已确认（人工）`。
- 未确认时保持「待确认写入」/「待确认」。

### 20.4 表格列显隐 + 缩放

- 配对表与总览页工具条新增「列设置」按钮（`#matchColumnMenu` / `#overviewColumnMenu`）：可勾选显示/隐藏非必选列（`商品名称、店铺、品牌、型号、套餐、尺寸段、价格段、当前价格、成交金额、采样、数据来源、状态、入库状态、操作` 均可选；`行/SKU` 必选）。
- 选择持久化到 `settings.ui.tableCols.match/overview`；刷新/重开保持。
- 另外提供「紧凑/标准/宽松」行高切换（可选，不影响列宽逻辑）。
- 目标：1440 宽下默认展示能放下核心列（SKU/品牌/型号/套餐/尺寸段/价格段/当前价格/入库状态/操作），需要时可隐藏其它列。

### 20.5 确认写入完整性（BUG 修复）

- 确认写入时**只使用行上显示的规范值** `row.size / row.price / row.brand / row.model / row.package`，**不再传 `sizeRaw/priceRaw`**（旧 raw 会让 makeRecord 归一化出另一个值或空值，造成「只写了一个字段」）。
- `upsertMatch` 语义明确：当调用方显式提供规范 `size`/`price`（非空）时，库记录对应字段**强制覆盖为归一化后的该值**，不得被旧 raw/旧值顶掉；日志记录 before→after。
- 匹配库页/导出/刷新后 **尺寸段与价格段必须同时存在**（两者都提供了就必须都写）。
- 写库后追加操作日志（见 20.7）。

### 20.6 列悬停高亮

- 鼠标在配对表/总览/匹配库任一列（th 或 td）上时，**该列所有单元格加高亮背景**（`.col-hover`），移出取消；与行 hover 并存；深浅主题各一套 token。

### 20.7 匹配算法调整（名称多尺寸不猜）

- 优先级：**匹配库**（SKU 命中，尺寸/价格段取库值）→ 库无尺寸段时按**商品名称**解析尺寸段 → 价格段库无则**页面采集价格**后识别价格段（现有采集链路）。
- **名称里出现 ≥2 个不同英寸值时不识别**：`row.size=''`、`row.sizeAmbiguous=true`、`row.source.size=''`、note 追加「名称含多个尺寸，待人工复核」，状态按缺尺寸处理；UI 标记（状态徽章/备注）提示人工复核。
- 名称只有一个尺寸值时按现有解析；价格段不受此规则影响。
- 采集页价格取到后写入 row.price（价格段）逻辑不变。

### 20.8 异常自动继续（1 分钟）

- 采集结果分类：`offSale`（商品下架/不存在）→ 标记失败原因「已下架」，**跳过继续下一条**（不暂停、不计风控）；`risk`（安全验证/登录/验证页/验证码）→ 触发冷却+暂停（保持 v2.1.4）；`softAnomaly`（被重定向到电商平台首页/商城页但无验证特征、空页面、跳转异常）→ **等待 N 秒自动继续**（`settings.capture.anomalyWaitSec` 默认 **60**，0=不等待立即下一条），不要求人工重启。
- UI：异常等待时显示「检测到异常/跳转，等待 60 秒后继续（剩余 mm:ss）」，可点「立即继续」跳过等待、可点「停止」；连续异常 ≥3 次仍未恢复可再升级为冷却暂停并提示换账号/网络（可配置）。
- 日志中文记录每次异常/下架/等待/继续。

### 20.9 表头列筛选（配对表/总览）

- 表头每列右侧加筛选按钮（除 行/操作）：弹出面板支持「值多选（去重值，带搜索）+ 清空」；可同时多列筛选（AND）；与现有状态/搜索过滤叠加；筛选状态显示在表头（高亮/数量角标）。
- 覆盖列：SKU、商品名称（文本包含）、店铺、品牌、型号、套餐、尺寸段、价格段、当前价格（数值区间可选）、成交金额、采样、数据来源、状态、入库状态。
- 与列显隐、列悬停高亮兼容；总览页同样支持。

### 20.10 匹配库操作日志

- `library.meta.logs`（最多 500 条滚动）记录：`{at, action, store, sku, field, before, after, source, note}`。
  - action：`confirm`（确认写入）、`manual-edit`（行内/库内编辑）、`import-merge`、`import-replace`、`normalize`、`seed-migrate`、`add-store`、`delete-store`、`reset-seed`。
- 匹配库页新增「操作日志」按钮：弹出面板/抽屉，列表展示（时间/类型/类目/SKU/字段/原值→新值/来源），支持按 SKU/类目/类型搜索，支持导出 CSV；保留最近 500 条。
- 所有写库入口统一走 lib 的 `appendLibraryLog`；确认写入/编辑/导入/迁移/归一化都必须留痕。

### 20.11 匹配库保护（用户强调）

- **本次升级绝不覆盖/替换用户现有匹配库**：不重建 `base-skus.json`、不改种子 fingerprint、init 不执行 `applySeedMigration` 强制替换（指纹相同即幂等；若未来种子变化也只做「新增缺失 SKU」合并，不覆盖已有记录，且需用户确认）。
- init 时对现有库做 `libraryBackup_v215` 快照（含 meta/logs），失败不阻塞；设置页显示备份时间与「从备份恢复」按钮。
- 不自动 `normalizeLibrary`（会改值），只在用户主动点「归一化脏值」时执行且写日志。
- 本次所有写库动作都走 verify/日志，**不得静默改用户库**。

### 20.12 验收标准（2026-11-04 更新：多尺寸规则细化后基准）

1. `tests/core`：名称多尺寸（同段规范写法可解析、≥2 个不同段才留空）；新基准 尺寸段 **577/800=72.125%**（分榜单 165/183/80/149）、`sizeAmbiguous` **157 行**、价格段 242、品牌 772、bySize 22；回填 xlsx 16 列表头；确认写入同时包含 size+price（含旧 raw 干扰用例）；upsert 强制覆盖；library log 记录/上限；种子不被替换（applySeedMigration 不自动跑的约束由 UI 保证）。
2. `tests/qa --with-ui`：回填导出 16 列（openpyxl）；每批上限设置 10 → 队列 10；确认后「已确认」文案+操作禁用；列显隐持久化；列悬停 class；列筛选（品牌多选/尺寸段）行数正确；异常等待/自动继续（mock）；匹配库日志记录确认/手动/导入并展示；匹配库内容升级后不变（未采集前/后对比 + 用户库快照）。
3. 截图：10-workbench-colfilter.png（列筛选+列设置）、11-library-log.png（操作日志）、12-confirm-done.png（已确认）；01~09 重生。
4. 文档：README/使用说明/QA 报告更新（回填列、批量上限、已确认、列显隐/筛选、异常自动继续、匹配库保护与日志）。

### 20.13 匹配库「类目合并去重」（用户 2026-11-04 追加）

- 背景：用户「3C 类目」与最新「导入并合并」进来的类目实为同一榜单，产生重复；需要把两个/多个类目**合并为一个并去重**。
- 匹配库页「类目」面板：
  - 每个类目行加**多选框**（进入「选择模式」）；工具条出现「合并所选类目…」按钮；也支持单类目「去重」。
  - 合并弹窗：选择目标类目（现有类目或输入新名称）；先「预览」：类目数、合并前 SKU 总数、去重后 SKU 数、重复条数、**字段冲突条数**（含前 20 条明细：SKU/字段/旧值→新值/采用来源）；确认后执行。
- 去重/合并规则（store-schema `mergeStores`）：
  - 按 `normalizeSku` 去重（兼容前后空格/前导零/大小写差异）；
  - 同一 SKU 多条记录时：优先 `verified=true` → 再按 `updatedAt` 新→旧 → 再按字段完整度（size/price/brand/model/package 非空个数）；
  - 逐字段取值：取优先级最高记录的非空值；`size/price` 用规范值；若多条记录非空且不同 → 采用高优先级值，低优先级值记入 `conflicts`（旧值→新值）；
  - 合并后保留 `verified/origin/verifiedAt`（人工/confirm 记录保持已确认）；删除源类目，所有记录归入目标类目；
  - 合并前自动快照 `libraryBackup_v215`（若未备份）；写一条操作日志 `merge-stores`（含 sources/target/rowsBefore/after/duplicates/conflicts 数）。
- 单类目「去重」：对该类目内 normalizeSku 相同的记录去重（同一规则），写日志 `dedupe-store`。
- 预览（dryRun）不修改库；执行后刷新 KPI/列表/统计，并 toast 显示「已合并 N 个类目，去重 X 条，字段冲突 Y 条（详见操作日志）」。
- 验收：合并后 SKU 总数 = 去重数；原两条重复 SKU 只保留一条且字段取优先级高者；冲突记录可在日志查看；合并可撤销（从 libraryBackup_v215 恢复）；重建后类目列表/左侧筛选正常。

### 20.14 v2.1.5 验收结果（2026-11-04，真实 Edge 156 + CDP）

| 门禁 | 结果 |
|---|---|
| `node tests/core/run.mjs` | **142 通过 / 0 失败 / 32 套件** |
| `node tests/qa/run.mjs`（纯 Node） | **83 通过 / 0 失败 / 0 阻塞 / 2 跳过**（4e 节 9 条全过） |
| `node tests/qa/run.mjs --with-ui` | **85 通过 / 0 失败 / 0 阻塞 / 0 跳过（105.6s）**；ui-smoke **162/162 steps** |
| Lead `work/lead/acceptance_v215.mjs` | **17/17**：KPI 577/242/772、多尺寸 157、libStates 160/184/378/78、表头 16 列、默认隐藏金额/采样、确认写入后库 size+price 均在且「已确认」、列显隐/筛选/悬停、批量上限 20、合并预览不改库、日志面板、导出 16/15/10 列（openpyxl） |
| `node dev-tools/cdp_capture_test.mjs` | **153/153**（offSale 11、homejump 20、variantpanel 33、其余不回归） |
| content selftest / capture-client | 37 用例 / 202 断言；39/39 |
| 截图 | `docs/shots/01~12`（10 列筛选/列设置、11 操作日志、12 已确认） |
| 版本 | manifest/app.js/content.js = **2.1.5**；种子未动（1101/638、fingerprint 780d76cf20900fe3） |

- 已知问题修复：`columnFilterContextRows` 误把 `filteredMatchRows()` 返回对象当数组迭代导致表头筛选面板报错 → 已修（`{report,rows}` 解构）。
- 匹配库保护：升级不替换用户库；首次启动/合并前自动快照 `libraryBackup_v215`；`applySeedMigration` 默认 merge-missing；`replace` 仅二次确认重置。
- 新增「类目合并去重」：`mergeStores/dedupeStore`（预览/去重/字段互补/冲突优先级 verified→updatedAt→完整度/日志），UI 多选类目 → 预览 → 合并。

---

## 21. v2.1.6 迭代：价格只来自页面/库 · 尺寸严格识别（多值必空置）· 快速人工定位（2026-11-04 18:34）

> 用户反馈（2026-11-04 18:34）：
> 1. **价格绝对不能由名称判断，只能读取页面。名称上根本没有价格。**
> 2. **价格段和尺寸段都会有错。尺寸段主要是因为识别名称误判**：一个商品名称内出现多个数据，脚本就会觉得其中一个就是型号；只有名称中**明确出现唯一的数据、并且和常见尺寸相关**时才能识别为尺寸；名称当中出现多段数据就**必须空置等人工填**。不改的话每个 SKU 都要点进去看。
> 3. 改完后要能**快速根据空缺定位到需要人工核验的地方**。

### 21.1 价格来源收口（硬约束）

- 价格段唯一允许来源：**① 匹配库中该 SKU 已核验记录**（库值，非名称）→ ② **页面采集价格**（到手价/电商平台价 → 价格段）。
- 删除所有「名称推断价格」路径：`analyzeReport` 同名商品推断不得再补 `price/size`；不得从商品名称解析价格；`来源` 不再出现「名称推断」。
- 若库无该 SKU 价格段 → `price=''`、`source.price=''`、状态「缺价格段，可在线采集」，由采集页价格写入（价格只认页面 DOM）。
- 保留库值优先（用户维护的库是可信数据，不是从名称猜的）；库缺才采集。

### 21.2 尺寸严格识别（名称多值必空置）

- 尺寸段来源顺序：**匹配库该 SKU 记录** → **名称严格解析** → **页面采集（规格参数优先）** → 空置等人工。
- 名称严格解析规则（`parseSizeFromNameStrict`）：
  - 只统计**明确尺寸表达**：数字 + 尺寸单位（英寸/寸/吋），如 `65英寸`、`75寸`；
  - **名称中出现 ≥2 个不同尺寸表达**（含 `55/65英寸`、`98/100英寸`、`86/85英寸`、「75英寸 86英寸」等）→ **不识别，size=''、sizeAmbiguous=true、note「名称含多个尺寸，待人工复核」**；
  - 名称中 **0 个**明确尺寸表达 → 不放宽猜测（不把型号数字当尺寸），`size=''`；若名称含 2~3 位可疑数字但无单位 → 记 `sizeAmbiguous`（待人工）而不是猜；
  - **恰好 1 个**明确尺寸表达且属于常见尺寸（20~200 英寸，或落进已知尺寸段）→ 采用该尺寸段；
  - 不再做「多个英寸先归一、同段可接受」的放宽（v2.1.5 规则作废：用户要求多值必须空置）。
- 删除跨行/同名推断补尺寸（`nameIndex` 同名推断整条移除），避免「别的商品名称」污染本行。
- 页面采集尺寸：**规格参数表「屏幕尺寸/显示尺寸/整机尺寸」优先**；标题只在「明确唯一尺寸表达」时采用；标题多值 → 不用并标记 `sizeUncertain`（等人工）。页面采集到明确尺寸后清除 `sizeAmbiguous`。

### 21.3 快速人工定位（UI）

- 筛选/状态新增：`尺寸待复核（名称多尺寸/无法确定）`、`缺尺寸段`、`缺价格段`（可叠加现有状态筛选）。
- KPI/工具条新增「**待人工复核 N**」（sizeAmbiguous 行数）与「缺尺寸段 N / 缺价格段 N」快捷入口，点击即筛选。
- 行内视觉：尺寸段为空的行，尺寸段单元格显示「待人工」/「缺」标记 + tooltip 原因；`sizeAmbiguous` 行在状态列标记「待复核」（不改变库状态四色）。
- 总览页同步可筛/可定位；导出「状态」列体现「待复核」与原因（列结构不变）。
- 目标：用户按「待人工复核」筛选后逐条补齐/确认，不再全量点开商品页。

### 21.4 兼容与回归

- 匹配库保护不变（升级不覆盖、merge-missing、备份/日志、类目合并去重）。
- 导出列结构不变（回填 16 / 配对 15 / 匹配库 10）。
- 新基准（删除同名推断 + 严格尺寸后）需重算并写入文档：sizeFilled / sizeAmbiguous / 分榜单 / 状态计数；价格段基准不变（242）除非页面采集数据变化。
- 测试：名称单值（`65英寸`）→ 识别；双值（`55/65英寸`、`98/100英寸`、`75英寸 86英寸`）→ 空置+ambiguous；型号数字（`75MBK7`、`VH75CAD`）→ 不当尺寸；价格任何路径不得由名称产生；同名商品不再补任何字段；UI 筛选/徽标/导出状态。

### 21.5 v2.1.6 新基准（删除名称推断 + 严格尺寸后，2026-11-04 18:47，未采集状态）

- **价格段 165/800 = 20.625%**（此前 242，差额 77 条全部来自已删除的「同名商品名称推断」；分榜单 0 / 89 / 1 / 75，全部 `source.price='库'`，无一条来自名称）。
- **尺寸段 478/800 = 59.75%**（分榜单 134/143/67/134）；`sizeAmbiguous` **322 行**（多尺寸 248 / 无明确 74；分榜单 66/57/133/66）；bySize 20 档。
- 品牌 772（96.5%）、金额 10262.6 万、型号 489 不变。
- 状态：已匹配 161 / 部分 317 / 待采集 318 / 待补 4；libStates：verified 160 / incomplete 192 / new 447 / pending 1。
- 来源：size 库 162 + 名称解析 316；price 库 165（名称 0 / 页面 0）。
- 旧 577/242 口径作废；文档/UI/QA 一律用本基准。

### 21.6 v2.1.6 验收结果（2026-11-05，真实 Edge 156 + CDP）

| 门禁 | 结果 |
|---|---|
| `node tests/core/run.mjs` | **145 通过 / 0 失败 / 32 套件** |
| `node tests/qa/run.mjs`（纯 Node） | **89 通过 / 0 失败 / 0 阻塞 / 2 跳过**（4f 节 6 条全过） |
| `node tests/qa/run.mjs --with-ui` | **91 通过 / 0 失败 / 0 阻塞 / 0 跳过（104.6s）**；ui-smoke **181/181 steps** |
| Lead `work/lead/acceptance_v216.mjs` | **10/10**：KPI 478/165/772、libStates 160/192/447/1、sizeAmbiguous 322、价格 165 条全部来源=库（namePrice=0）、快捷 chip 计数与筛选、行内「待人工/待复核」、总览筛选 322→200、导出回填 16 列含待复核 66/57/133/66、确认写入回归 |
| `node dev-tools/cdp_capture_test.mjs` | **176/176**（sizespec 6、sizemulti 13、variantpanel 34、homejump 20、其余不回归） |
| content selftest / capture-client | 43 用例 / 232 断言；40/40 |
| 截图 | `docs/shots/01~14`（13 待人工复核筛选、14 缺尺寸段标记） |
| 版本 | manifest/app.js/content.js = **2.1.6**；种子未动（1101/638、fingerprint 780d76cf20900fe3） |

- 价格审计：全量 800 行中价格段 165，来源全部「库」；名称含金额不产生价格；同名商品推断代码已删除（grep 无残留）。
- 尺寸：478 有值（库 162 + 名称严格解析 316）；322 行待人工复核（多值 248 / 无明确 73 / 不常见 1）；型号数字不误判。
- 导出结构不变：回填 16 / 配对 15 / 匹配库 10 列；状态列含「待复核」；数据来源无「名称推断」。

---

## 22. v2.1.7 迭代：移植「巡检双轨版」价格采集算法（2026-11-05 11:50）

> 用户反馈：本插件当前采集价格错误率极高；桌面 `巡检\巡检插件-双轨版` 的价格采集算法实测准确率最高，要求**直接替换**；并评估该巡检架构有哪些可复用。

### 22.1 源版本审计（巡检双轨版 v2.1 / 2026-11-05）

- 价格脚本：`巡检插件-双轨版\extension\content.js`（v2.1，464 行），规则见 22.2；
- 双轨：轨道①后台标签页、轨道②前台小窗+AI（同一份 content.js；AI 只校验不覆盖 DOM，截图只裁价格块、不落盘）；
- 官方价 API 桥：`api_bridge.py`（127.0.0.1:18765）+ `vendor/patrol/jd_client.py`（电商平台 SP-API `price-stars.handPrice`，多账号令牌）；仅覆盖**授权店铺自有商品**的普惠到手价，无会员价；
- 工程化：基表独立存储 `patrol.base.v1`+保存读回校验+多标签同步、每单候选价调试 JSON（价格/字号/class/位置）、价格变化记录、下架行不计入进度分母、手动改价/重采选账号轨道。
- 结论：**官方 API 桥不适用于竞品市占率数据**（竞品 SKU 不归属授权店铺），本轮不接；双轨/前台小窗对竞品批量采集非必需；AI 复核可作为后续可选项（需 AI Key，只校验不覆盖）。

### 22.2 价格采集算法（按源版 v2.1 逐条移植，硬约束）

1. **锁定当前商品价格区**：不做全页价格聚合；候选必须「可见、在当前商品首屏范围内（首选）、且文本是一个完整价格」；最终按**字号最大**优先选价（电商平台到手价=首屏大号红字；电商平台价=旁边小号灰字）。
2. **排除无关价格卡片**：容器 class/id 命中 `cross_platform|continuous-product|recommend|similar|guess|like-|maylike|also-buy|rank|banner|advert|shop-card|shopcard|promo-card|promotion-card|footprint|history-item|compare-card|price-compare` 的候选全部跳过（源版实测旧逻辑 76% 会员价错读自这些卡片：8499/1999）。
3. **只认可见元素**：`display:none`、`visibility:hidden`、`opacity<=0`、无布局尺寸、隐藏抽屉内一律跳过（后台标签页也适用）。
4. **严格完整价格**：文本去空白后须匹配 `^[¥￥]?\s*\d[\d,]*(\.\d{1,2})?\s*[元起]?$`；长度<=24；拒绝含 `折/期/件/满/减/%/人/年/星/分/白条/免息/定金/尾款/月供/评价/销量/已售/优惠/券后立减`；无货币符号时整数位必须>=3（拒绝「56」小数片段）；价格>=30。
5. **口径判定**：标签含 PLUS/会员→plus；到手价/预估到手/券后→hand；电商平台价/原价/划线价→main；无标签按字号（>=18 hand，否则 main）；被划线（del/s/line-through）→main。
6. **选价**：按字号降序（同字号按 top、left）；hand 优先且字号需接近最大；main 取同区域更小字号/划线价；plus 单独标记；hand==plus 时去重。
7. **稳定性**：连续 **3 轮**（约 1.5s）读到同一价格才算稳定（最长等 20s）；仅主价（无到手价标签）时最多 6s 接受；稳定后**再复核最多 4 次×1.2s**，以页面最终刷新后的读数为准，价格变化记录 `priceChanges:[{from,to}]`（不挑「离阈值最近」的值，不猜）。
8. **上报**：`price`（最终采用价）、`priceKind`（hand/plus/main）、`priceRect`（价格元素位置，供预览/AI 裁剪）、`candidates`（前 12 条：price/kind/text/cls/font/strike/rect）、`priceChanges`、`sourceLabel`。
9. 保留本插件既有能力：风控/下架/软异常三分类、尺寸严格识别、型号/套餐/规格组、PREVIEW_CAPTURE；价格缺失仍不猜。
10. 采集记录/状态：「数据来源」显示 `页面采集(到手价/PLUS价/电商平台价)`；采集日志记录稳定性/价格刷新；调试 JSON 供排查。

### 22.3 可复用清单（采纳 / 不采纳）

| 源版能力 | 本插件处理 |
|---|---|
| 22.2 价格算法 | **采纳（替换现有 content.js 取价核心）** |
| 候选价格调试 JSON（价格/字号/class/位置） | **采纳**：行详情/调试按钮可复制 |
| 价格类型 hand/plus/main | **采纳**：当前价单元格小徽标 + 数据来源 |
| 价格变化 priceChanges | **采纳**：日志/调试 JSON |
| 下架行不计入采集进度分母 | **采纳**：统计与 KPI 区分已下架 |
| 基表独立存储+读回校验+多标签同步 | 部分采纳（本插件已有 library 备份/操作日志；读回校验沿用现有保存校验） |
| AI 复核（价格块截图→AI 校验，不覆盖 DOM） | 暂不集成（需 AI Key；列为后续可选） |
| 双轨/前台小窗 | 暂不集成（竞品批量采集用后台标签页即可；频控严重时再评估） |
| 官方价 API 桥（SP-API price-stars） | **不适用**：仅授权店铺自有商品普惠价；竞品 SKU 无法取数（若以后测自有 SKU 可复用桥） |

### 22.4 验收标准

- mock 商品页新增布局：比价卡片（真实价 5999 + 卡片 8499）、关联购买（1999）、隐藏价、折叠下方价、拆分数字（¥8607.56）、片段（56）、价格刷新（24699→25099）；断言取到真实价、kind 正确、candidates 带字号/位置、priceChanges 记录。
- 回归：selftest 原 43 用例、CDP 176、真实页面手测 10 个 SKU 与页面大号红字一致。
- 工作台：当前价格旁显示价格类型；详情/调试可复制候选 JSON；数据来源含到手价/PLUS价/电商平台价；导出列结构不变。
- 文档：README/使用说明/QA 报告新增算法说明与验收结果；截图 15（价格类型/调试）。

### 22.5 v2.1.7 验收结果（2026-11-05，真实 Edge 156 + CDP）

| 门禁 | 结果 |
|---|---|
| `node tests/core/run.mjs` | **151 通过 / 0 失败 / 33 套件（5.7s）** |
| `node tests/qa/run.mjs`（纯 Node） | **95 通过 / 0 失败 / 0 阻塞 / 2 跳过**（4g 节 6 条全过） |
| `node tests/qa/run.mjs --with-ui` | **97 通过 / 0 失败 / 0 阻塞 / 0 跳过（109.8s）**；ui-smoke **192/192 steps** |
| Lead `work/lead/acceptance_v217.mjs` | **10/10**：采集字段 priceKind=hand / 来源「页面采集(到手价)」/ priceRect{x:820,y:120,w:180,h:40} / priceChanges / note、价格类型徽标、调试弹窗与 lastCaptureDebug、下架分母 799、导出 16/15/10、v2.1.5/2.1.6 回归 |
| `node dev-tools/cdp_capture_test.mjs` | **218/218**（pricecards 10、splitprice 6、hiddenprice 4、pricerefresh 4、belowfold 5、mainonly 6；原 176 不回归） |
| content selftest / capture-client | 50 用例 / 277 断言；41/41 |
| 截图 | `docs/shots/01~15`（15 价格类型徽标+调试 JSON） |
| 版本 | manifest/app.js/content.js = **2.1.7**；种子未动（1101/638、fingerprint 780d76cf20900fe3） |

- 价格核心已替换为巡检双轨版 v2.1 算法；失败场景（比价卡 8499/关联 1999/拆分 8607.56+片段 56/隐藏价/首屏无价/24699→25099 刷新）全部被 mock/CDP 覆盖。
- `priceRect` 兼容源版 `{left,top,width,height}` 与 `{x,y,w,h}`（pipeline.normalizePriceRect，输出两组）。
- 下架行不计入进度分母（stats.offSale/progressDenom/progressPct）；已下架筛选/KPI 文案。
- 真实页面 10 SKU 手测未在 headless 环境执行（未登录+频控风险），详见 README「价格调试」流程。

### 22.6 v2.1.7 补丁（2026-11-06）：匹配库类目无法勾选/无法合并修复

- 现象：匹配库页类目行勾选框点不动/勾了又消失，「合并所选类目…」按钮始终灰色（0），无法打开合并弹窗。
- 根因 1：类目行的点击事件（用于切换类目筛选）没有排除勾选框，点复选框会冒泡到 `.store-item` → 触发 `renderLibraryStores()` 整块 innerHTML 重建 → 勾选状态被清空。
- 根因 2：`syncMergeStoresButton()` 使用初始化时缓存的 `els.mergeStoresBtn`，而类目列表每次渲染都会重建按钮节点；缓存指向已脱离文档的旧按钮，所以新按钮一直 disabled、计数为 0；点击也被 disabled 拦截。
- 修复（app.js，两处）：
  1) 类目行点击处理：`e.target.closest('.store-select')/('.store-bulk')/('#mergeStoresBtn')` 时直接 return，不触发筛选重渲染；
  2) `syncMergeStoresButton()` 改为始终 `document.getElementById('mergeStoresBtn')` 取当前节点并回写 `els.mergeStoresBtn`。
- 验证（真实 Edge CDP）：勾选 2 个类目 → 按钮变「合并所选类目…（2）」可点 → 弹窗正常 → 预览「类目2/合并前901/去重后901/重复0/冲突0」→ 取消；关闭后点类目名仍正常筛选（3C店 100 行）；QA `--with-ui` 回归 97/0/0/0。
- 版本保持 2.1.7（同版本热修，重新加载扩展即可生效）；无数据/匹配库结构变更。
