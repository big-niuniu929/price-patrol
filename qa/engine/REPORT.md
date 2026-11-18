# 取价引擎一致性同步报告（三引擎对齐「场景期望值」）

- 任务：team task-5「取价引擎一致性：以巡检 v2.1 为基准同步 share/radar 取价逻辑」
- 执行：engine-sync，2026-11-10；lead 于中途授权 **方案 B**：允许对平台内 `modules/patrol/content.js` 做 2 处最小取价边界修复
- 基准：`modules/patrol/content.js`（巡检 v1.3.4 内文件，取价规则 v2.1）
- 被同步：`modules/share/content.js`（市占率 v2.1.7 实现）、`modules/radar/content.js`（竞品价格雷达 v2.0 实现）
- 方式：**同页面三引擎结果对比**（非整体覆盖）；只改取价选择/校验相关行为，保留各自扩展能力
- 最终结果：**15/15 场景「巡检 / 市占 / 竞品」三引擎全部与期望值一致**（`last-run.json` / `final-run.json`，exit code 0）；消息契约 5/5、extras 9/9、页面 console error 0
- 说明：所有修复只发生在**平台副本**（`价格监控平台/modules/*`）；原始巡检 v1.3.4 插件包 / 用户原插件目录**未改**

---

## 0. 一句话结论

15 个 mock 电商平台商品页上，三个业务对「到手价 / 电商平台价 / PLUS 价、下架 / 售罄 / 无货 / 安全验证、是否猜价」的结论已完全一致。共修 7 处：市占 4 处（下架误判、拆分数字、券金额进选价、自身交叉校验丢价）、竞品 1 处（电商平台价冒充到手价）、巡检 2 处（lead 授权的最小边界修复：拆分小数丢失、优惠券金额被当电商平台价）。首跑基线保留在 `first-run.json/log` 作对照。

---

## 1. 方法与复跑方式

零依赖 CDP（复用 `qa/lib/cdp.mjs`，未修改）：

1. 无头 Edge 以 `--load-extension` 加载**整个平台目录**（真实扩展、真实 content_scripts 注入，Edge 157.0.4341.42）；
2. 打开平台扩展页 `app.html`，在页面里挂 `chrome.runtime.onMessage` 收集器；
3. 新建商品页标签页，用 CDP `Fetch` 拦截 `https://item.shop.example.com/<sku>.html`，`Fetch.fulfillRequest` 返回 `qa/engine/fixtures/` 本地 mock 商品页（**不联网真实电商平台**）；同一页面、同一扩展 isolated world 里三个 content.js 各注入一次（不重复注入）；
4. 巡检 / 竞品各自上报 `PATROL_ITEM_PRICE_RESULT` / `RADAR_ITEM_PRICE_RESULT`；市占率用 `chrome.tabs.query` 找到商品页 tabId 后 `chrome.tabs.sendMessage(tabId,{type:'PREVIEW_CAPTURE'})` 取 `PREVIEW_CAPTURE_RESULT` 快照（在巡检/竞品已定格后读 DOM，即最终态）；
5. 三引擎 × 场景与「场景期望值」比对，并检查三引擎读数是否一致。

复跑命令（普通 PowerShell）：

```powershell
cd ~/Desktop/三合一\价格监控平台
node qa/engine/build-fixtures.mjs      # 可选：重建 16 个夹具文件
node qa/engine/engine-matrix.mjs       # 全量矩阵（约 100s；含 S05/S08/S09 三个 ~20s 的「无价/下架早停」场景）
node qa/engine/engine-matrix.mjs --only S06,S13 --no-shots   # 只跑指定场景
```

矩阵判定口径：

- 期望值 = 场景应该得到的结论（`qa/engine/scenarios.mjs` 的 `expect`），为唯一判定基准；
- 字段归一化：`ok`（是否采信）、`price`（最终采信价）、`hand/main/plus`（到手价/电商平台价/PLUS价）、`verdict`（结论类别：`sellable` 正常有价 / `noprice` 商品页无价 / `unsellable` 下架·售罄·无货 / `verify` 安全验证 / `login` 登录页）；
- 通过 = 三引擎逐字段都等于期望，且三引擎读数一致；任一处不同即 exit code 1。

产物：`qa/engine/last-run.json`（最近一次完整结果 + 每场景原始字段/candidates 摘要/console/mock 计数）、`final-run.json`（最终复跑）、`first-run.json`（修复前基线）、`qa/engine/shots/s01–s15.png`（每场景 mock 页面截图 1440×900）。

---

## 2. 场景矩阵（最终复跑，三引擎全部一致）

格式：`ok | 最终价 | 到手/电商平台/PLUS | 结论`；`—` = null。

| # | 场景 | 期望 | 巡检（patrol） | 市占（share） | 竞品（radar） | 判定 |
|---|---|---|---|---|---|---|
| S01 | 标准到手价 + 划线电商平台价 | true \| 15699 \| 15699/16999/— \| sellable | true \| 15699 \| 15699/16999/— | 同左 | 同左 | ✅ |
| S02 | PLUS 会员价（到手/电商平台/PLUS） | true \| 15699 \| 15699/16999/14999 | true \| 15699 \| 15699/16999/14999 | 同左 | 同左 | ✅ |
| S03 | 跨平台比价卡片（更大字号 ￥8,499 到手价） | true \| 15699 \| 15699/16999/— | true \| 15699 \| 15699/16999/— | 同左 | 同左 | ✅ |
| S04 | 关联购买/推荐/广告（推荐位含「已下架」字样） | true \| 15699 \| 15699/16999/— | true \| 15699 \| 15699/16999/— | 同左 | 同左 | ✅ |
| S05 | 隐藏价格（display:none） | false \| — \| noprice | false \| — \| noprice | 同左 | 同左 | ✅ |
| S06 | 拆分数字 ￥8,607 + .56 | true \| **8607.56** \| 8607.56/—/— | true \| 8607.56 \| 8607.56/—/— | 同左 | 同左 | ✅ |
| S07 | 片段 56/.56/5折/满5000减500/12期 | true \| 15699 \| 15699/16999/— | true \| 15699 \| 15699/16999/— | 同左 | 同左 | ✅ |
| S08 | 下架页（该商品已下架 + 推荐位残留价） | false \| — \| unsellable | false \| — \| unsellable | 同左 | 同左 | ✅ |
| S09 | 售罄/无货（该商品已售完 + 到货通知） | false \| — \| unsellable | false \| — \| unsellable | 同左 | 同左 | ✅ |
| S10 | 安全验证页（滑块/访问频繁） | false \| — \| verify | false \| — \| verify | 同左 | 同左 | ✅ |
| S11 | 首屏外价格（放宽整页后取到 15699） | true \| 15699 \| 15699/16999/— | true \| 15699 \| 15699/16999/— | 同左 | 同左 | ✅ |
| S12 | 小字划线价（￥19,999 不替换电商平台价 16999） | true \| 15699 \| 15699/16999/— | true \| 15699 \| 15699/16999/— | 同左 | 同左 | ✅ |
| S13 | 券后价（15499 + 侧栏优惠券 ￥500） | true \| 15499 \| 15499/**16999**/— | true \| 15499 \| 15499/16999/— | 同左 | 同左 | ✅ |
| S14 | 价格二次刷新 24699 → 25099 | true \| **25099** \| 25099/26999/— | true \| 25099 \| 25099/26999/— | 同左 | 同左 | ✅ |
| S15 | 无「到手价」标签（只有电商平台价） | true \| 16999 \| —/16999/— | true \| 16999 \| —/16999/— | 同左 | 同左 | ✅ |

- 三引擎读数：15 个场景**逐字段完全一致**（`last-run.json` → `summary.engineDisagreements = []`）。
- S14 巡检/竞品都记录了价格变化 `24699 → 25099` 并采用最终价（`priceChanges` 见 JSON，extras 检查项通过）。
- S10 三引擎都在 1 秒内判定「安全验证页」并早停，不解析价格（只识别、不绕过风控）。

---

## 3. 修复前后对比（首跑 4 处偏差 → 中间态 2 处巡检偏差 → 最终 15/15）

- **首跑基线**：`first-run.json` / `first-run.log`（11:51，任何修复前）。15 场景中 4 处偏差：
  S04（市占把推荐位「已下架」误判整页下架）、S06（市占价格 8607；巡检 8607；竞品 8607.56）、S13（市占价格落到 500；巡检 main=500）、S15（竞品把电商平台价冒充 hand）。
- **中间复跑**（只修 share/radar 后）：15/15 share/radar 对齐期望；巡检仍有 S06/S13 两处与期望不符（已报 lead，lead 授权方案 B）。
- **最终复跑**（share/radar 4 处 + 巡检 2 处修复）：`final-run.json` / `final-run.log`，**15/15 三引擎全部一致，exit 0**。

| 场景 | 首跑偏差（文件） | 根因 | 修复后 |
|---|---|---|---|
| S04 | 市占 `ok=false/pageKind=offSale`、价格 null（巡检、竞品正常 15699） | 市占「下架」判定扫**整页正文**（`OFF_SALE_TEXT_RE` 含裸「已下架」），命中推荐位某商品的「已下架」，整页被判下架、放弃取价 | 三引擎一致：ok=true、price=15699、main=16999 |
| S06 | 市占 8607；巡检 8607；竞品 8607.56 | 两者都只按单元素 `textContent` 解析，没有邻接文本拼接；整数片段 `<span class="int">8,607</span>` 的 rect.top 比父容器高 2px，同字号下按 top 排序选中了片段（竞品有拼接能力，所以它是对的） | 三引擎一致：8607.56 |
| S13 | 市占 `price=500/hand=null`；巡检 `main=500`；竞品 15499/16999 | 市占：① 独有「hand > main×1.02 就丢 hand」交叉校验，main 被 ￥500 误选后把正确到手价 15499 丢弃；② decoy（优惠券/月供…）候选标记从未真正排除，￥500 进入选价。巡检：main 选择只看字号/位置，不优先「电商平台价」标签，￥500 顶掉电商平台价 | 三引擎一致：price=15499、hand=15499、main=16999 |
| S15 | 竞品 `hand=16999/main=19999`；巡检、市占 `hand=null/main=16999` | 竞品有「主价格区只有一个大字号价格、也没有标签时就是 hand」的兜底，把**有「电商平台价」标签**的大字号价格强判成 hand；随后 main 又落到小字划线价 19999 | 三引擎一致：hand=null、main=16999（置信度按最终采信价计算，取值口径不变） |

---

## 4. 修复点明细（文件:行 / 函数 / 原因 / 行为前后）

### 4.1 `modules/share/content.js`（市占率，4 处）

**(a) 下架判定只看当前商品信息区（修 S04）** — `content.js:193-268`（新增 `visibleBodyTextOutsideExcluded()` / `productFlagText()`）、`content.js:286-289`（`pageFlags`）、`content.js:374`（`detectPageState`）

- 新增两个函数：优先扫当前商品主信息区（`.itemInfo-wrap / .product-intro / .sku-name / #name / .summary-price* / #price / .notice / [class*=offline] …`），逐层跳过 `EXCLUDE_CONTAINER`（recommend / cross_platform / advert / continuous-product / rank / banner …）与隐藏节点；只有页面**没有商品骨架**（整页下架/不存在提示）时才扫可见正文兜底，兜底同样排除推荐/比价模块。
- `pageFlags().offSale` 与 `detectPageState()` 的「下架」判定改用该文本；**风控（verify）判定仍用整页正文**，风控识别不降级；`OFF_SALE_TEXT_RE` 词表未删减（含「已售完/页面不存在/商品不存在」等），只收窄扫描范围。
- 前：推荐位出现「已下架」→ 市占整页判下架 → `ok:false` 不取价；后：正常商品照常取价，真下架页（S08）仍正确判 `offSale`（失败原因「已下架」，不冷却、不算风控）。

**(b) 拆分价格的邻接文本拼接（修 S06）** — `content.js:668-735`

- 新增 `combinedPriceText()`（`￥`/整数/小数分处相邻节点时拼回完整文本）与「整数片段跳过」：若候选后面紧跟 `.56` 这类小数节点且拼接文本不同，跳过该整数片段，让拼接后的完整价格（父容器/相邻文本）成为候选。
- 实现巡检 README 规则 4「数字被拆成多个节点时先拼回完整文本再解析」（竞品 radar 已有同款）；前：`￥8,607` + `.56` → 8607；后：8607.56。

**(c) decoy 候选真正排除出选价（修 S13）** — `content.js:657-666`（`priceContextIsDecoy`）、`content.js:751`（`cand.decoy`）、`content.js:761-768`（`pickPriceCandidates` 过滤）

- 原代码已给候选打 `suspect`（划线/优惠券等），但 `pickPriceCandidates` 选价时**根本没看这个标记**。现拆出 `priceContextIsDecoy()` 只判「优惠券/满减/月供/分期/白条/评价/销量…」上下文（**划线价不算 decoy**，仍需用它识别电商平台价），新增内部字段 `cand.decoy`，选价时过滤 `decoy` 候选（全部被标记时才退回全量兜底）；候选调试输出结构不变（`decoy` 不进入 `slimCandidate`/快照）。
- 前：券金额 ￥500 进入选价并挤掉电商平台价；后：￥500 只留在 candidates 调试列表，电商平台价正确选 16999。

**(d) 去掉市占独有的 hand/main 交叉校验（修 S13 的 price=500）** — `content.js:801-807`

- 删除 `applyHandCrossCheck()`（「到手价 > 电商平台价×1.02 就丢弃 hand」）。巡检 v2.1 无此规则；该规则会因 main 被误选而丢掉正确的到手价，把最终价打到 500。
- 前：price=500、hand=null；后：price=15499、hand=15499。

### 4.2 `modules/radar/content.js`（竞品监控，1 处）

**(e) 不再把「电商平台价」冒充 hand；置信度按最终采信价计算（修 S15）** — `content.js:401-446`

- 删除 `if (!hand && biggest && !biggest.strike && biggest.font >= 18) hand = biggest;` 兜底。巡检口径：hand 只在有「到手价/券后价」等标签或最大候选非 main 时才有，否则电商平台价就是 `main`；价格仍由 `bestPriceOf` 的 main 兜底，不影响采集（radar app.js 的 `pickPrice` 本来就是 `hand → main → plus` 顺序）。
- 置信度改为按 `hand || main`（最终采信价）计算：主价格区 + 到手价标签 = high，只命中其一 = medium，纯字号/位置 = medium/low —— 该页修复前后都是 medium，**置信度字段与取值口径不变**，只是不再把 main 谎报成 hand。
- 前：`hand=16999`、`main=19999`；后：`hand=null`、`main=16999`（与巡检/市占一致）。

### 4.3 `modules/patrol/content.js`（巡检，lead 授权方案 B，2 处最小修复）

> 这两处是巡检自身的真实取价缺陷（首跑就与场景期望不符），按 lead 决策只修**平台副本**，原始巡检 v1.3.4 插件包/用户原插件未动。

**(f) S06：补「同一价格容器的邻接文本拼接」（修丢失 .56）** — `content.js:178-226`

- 新增 `combinedPriceText(el)`：当价格被拆在相邻节点（`￥` / 整数 / 小数分处相邻 span 或文本节点）时拼回完整文本再解析；并新增「整数片段跳过」：若候选后紧跟 `.56` 这类小数节点且拼接文本不同，跳过整数片段，让拼接后的完整价格成为候选。
- 严格限制：**不放宽** `parsePriceText` 对 `56 / .56 / 5折 / 满5000减500 / 12期` 等独立片段的拒绝规则（S07 仍 PASS）；只在原有单元素解析失败时尝试拼接（`price == null` 才拼），价格区间/促销文案规则原样保留。
- 前：`hand=8607`（取到 `<span class="int">`，rect.top 比父容器高 2px 同字号排到前面）；后：`hand=8607.56`（与 share/radar/期望一致）。

**(g) S13：main（电商平台价）优先「电商平台价标签 / 划线」候选（修 main=500）** — `content.js:262-270`

- main 候选池在原条件（`kind==='main'` 且字号 ≤ hand 字号）上改为优先序：**带「电商平台价/前台价/原价/划线价」标签** → **划线（strike）** → 原字号/位置顺序（即原 `mainPool[0]`）。
- 只影响 `main` 字段：`hand` 选价逻辑一行未动（S01/S02/S06/S14 的到手价不变）；S15（无到手价标签、hand=null）仍回退 main 并正确取 16999（`市场价` 不在优先标签里）；S12（小字划线价 ￥19,999）仍正确取电商平台价 16999。
- 前：`main=500`（侧栏优惠券金额 top 更靠上、字号相同，排到电商平台价前面）；后：`main=16999`（与 share/radar/期望一致）。

---

## 5. 两处巡检缺陷的根因分析（保留记录）

### 5.1 拆分数字丢失 .56（S06）

- 夹具：`<div class="p-hand-split"><span class="cur">￥</span><span class="int">8,607</span><span class="dec">.56</span></div>`（父容器文本完整「￥8,607.56」，整数/小数为相邻子节点，典型电商平台拆价写法）。
- 巡检原实现：`collectPriceElements` 只用单个元素 `textContent` 解析，没有邻接拼接；候选排序「字号 → rect.top → rect.left」时，整数片段 span 的 rect.top 比父容器高 2px（inline 盒 vs block 盒），同字号就选中了片段。
- 与 `modules/patrol/README.md` 规则 4 自相矛盾（规则写着「数字被拆成多个节点时先拼回完整文本」）；share/radar 补上同款拼接后三引擎一致。

### 5.2 优惠券金额被当电商平台价（S13）

- 夹具：主价格区 `电商平台价 ￥16,999(划线)`、`券后价 ￥15,499(大号红字)`，侧栏优惠券卡片里有独立文本 `￥500`（「满5000减500」的可视化金额）。
- 巡检原实现：最终价 `15499` 正确（到手价/券后价），但 `main` 选了 `￥500`：`pickFromCandidates` 选 main 只看 `kind/字号/位置`，不优先带「电商平台价/划线价」标签的候选；￥500 的 top 更小、字号相同，排在电商平台价前面。**不影响最终采信价**，只影响上报的电商平台价字段（明细展示/AI 复核用价格块，不读 main）。
- 修复见 4.3(g)，改为标签/划线优先。

---

## 6. 能力保留证明（extras 9/9，`last-run.json`）

| 引擎 | 检查项 | 结果 |
|---|---|---|
| share | 预览快照结构字段齐全（`prices/price/priceKind/priceRect/pricePick/sourceLabel/candidates/pageKind/size/specGroups`） | ✅ |
| share | 尺寸提取（规格表「屏幕尺寸 75英寸」→ `size.inch=75, source=spec`） | ✅ |
| share | 品牌提取（规格表「品牌 酷开」；主结果 `brand=酷开`） | ✅ |
| share | 型号提取（`75P5 Pro`） | ✅ |
| share | 套餐提取（版本组已选「会议大屏+摄像头【免费送装一体】」，来源=规格选项） | ✅ |
| share | 规格选择区结构（版本/屏幕尺寸两组，`specGroups.length=2`） | ✅ |
| radar | 置信度/页面状态字段齐全（每场景 `confidence` 非空、`flags.pageState` 为字符串） | ✅ |
| radar | S01 置信度=high（主价格区 + 到手价标签） | ✅ |
| 三引擎 | S14 二次刷新最终价 = ￥25,099（巡检/竞品 priceChanges 记录 24699→25099） | ✅ |

其他未被破坏的行为（矩阵同时验证）：

- **下架/风控/不可售识别不降级**：S08 下架（市占仍判 `pageKind=offSale`，失败原因「已下架」且不冷却/不算风控）、S09 售罄/无货（市占 `offSale`、竞品 `pageState=unavailable`、巡检 `flags.offSale`，归一化结论均为「不可售」）、S10 安全验证（三引擎都判验证页、不解析价格）；市占的 `RISK_TEXT_RE` 与整页风控扫描、竞品的 `STRONG_OFFLINE_TEXT_RE`/主价格区/弱下架逻辑均未改动。
- **不猜价**：S05 隐藏价格 → 三引擎都 `ok:false`、无价；S07 的 `56/.56/5折/满5000减500/12期` 都不作为价格来源。
- **排除卡片**：S03 跨平台比价（更大字号 ￥8,499）、S04 推荐/关联购买/广告（￥1,999/￥8,499/￥666）都不影响当前商品取价。
- **首屏外兜底**：S11 首屏无价时三引擎都放宽整页仍取到 15699（仍排除卡片）。

---

## 7. 消息契约（5/5 通过）

同一个 `https://item.shop.example.com/<sku>.html` 页面上，三个 content.js 各注入一次、互不串消息：

| 检查 | 结果 |
|---|---|
| `PATROL_PING` 应答 | ✅ `{ok:true, sku, url}` |
| `RADAR_PING` 应答 | ✅ `{ok:true, engine:'priceradar-dom/2.0', sku, url}` |
| `SHARE_PING` 应答 | ✅ `{ok:true, sku, url, version:'2.1.7'}` |
| `PREVIEW_CAPTURE` → `PREVIEW_CAPTURE_RESULT` | ✅ `type=PREVIEW_CAPTURE_RESULT`、`sku/pageKind/ok` 正常 |
| 结果消息类型名 | ✅ `PATROL_ITEM_PRICE_RESULT` / `RADAR_ITEM_PRICE_RESULT` / `ITEM_CAPTURE_RESULT` 均未改名 |

页面 console：15 场景 + 契约复访，**content script 级 console error = 0**（无 SyntaxError / 重复声明 / 未捕获异常）。

---

## 8. `node --check` 结果（全部 exit 0）

```
node --check modules/patrol/content.js        → OK
node --check modules/share/content.js         → OK
node --check modules/radar/content.js         → OK
node --check qa/engine/engine-matrix.mjs      → OK
node --check qa/engine/build-fixtures.mjs     → OK
node --check qa/engine/scenarios.mjs          → OK
```

---

## 9. 证据文件清单

| 文件 | 说明 |
|---|---|
| `qa/engine/engine-matrix.mjs` | CDP 矩阵运行器（真实扩展 + Fetch mock + 三引擎结果采集/比对/契约/extras） |
| `qa/engine/scenarios.mjs` | 15 场景定义 + 期望值 + 归一化口径 |
| `qa/engine/build-fixtures.mjs` | 夹具生成器 |
| `qa/engine/fixtures/fixture-base.css` + `s01–s15*.html` | 16 个本地 mock 商品页夹具 |
| `qa/engine/first-run.json` / `first-run.log` | **修复前**基线（4 处偏差，11:51） |
| `qa/engine/final-run.json` / `final-run.log` | **修复后**最终复跑（三引擎 15/15，12:1x） |
| `qa/engine/last-run.json` | 最近一次运行完整结果（含每场景原始字段、candidates 摘要、console、mock 计数） |
| `qa/engine/shots/s01–s15.png` | 每个场景的 mock 页面截图（1440×900） |
| `qa/engine/REPORT.md` | 本报告 |

---

## 10. 约束核对 / 改动范围

**改动（平台副本）**：

- `modules/share/content.js`：83160 → 88727 字节（市占 4 处 + 注释）；
- `modules/radar/content.js`：37675 → 38187 字节（竞品 1 处 + 注释）；
- `modules/patrol/content.js`：17091 → 19295 字节（lead 授权 2 处 + 注释；巡检 `app.js/app.html/app.css/README.md` 未动）；
- `qa/engine/**`：新建夹具/运行器/报告（不参与扩展运行）。

**未改**：平台根 `manifest.json / app.html / app.js / app.css / background.js / README.md`、`qa/verify.mjs`、`qa/lib/**`、`modules/*/app.js / app.html / app.css / data/**`、`icons/**`。

**原插件未改**：本次全部修复只在「价格监控平台」副本内；原始巡检 v1.3.4 插件包（桌面 zip / 用户原插件目录）与市占率、竞品插件原目录均未触碰。最终交付说明里会写清「平台内巡检模块含 2 处取价边界修复，原插件未改」。

**未改契约**：消息类型名（`PATROL_PING/SHARE_PING/RADAR_PING`、`PATROL_ITEM_PRICE_RESULT`、`RADAR_ITEM_PRICE_RESULT`、`ITEM_CAPTURE_RESULT`、`PREVIEW_CAPTURE/PREVIEW_CAPTURE_RESULT` 全部不变）；share 预览快照/结果字段结构不变；radar 置信度/页面状态字段不变；share 版本字符串仍 `2.1.7`、radar `priceradar-dom/2.0`。

---

## 11. 限制与未覆盖

- 矩阵使用**本地 mock 商品页**（DOM 结构/类名/字号按真实 item.shop.example.com 摘要价区、到手价大号红字、电商平台价小字划线、跨平台比价卡片、推荐/关联购买/广告位、下架/验证页写法构造），**未联网访问真实电商平台商品页**；真实页面的登录态、真实券后计算、A/B 改版类名差异未覆盖。
- 三个 content.js 的取价等待策略（稳定 3 轮 + 复核）在 mock 页与真实页一致，但真实页渲染慢/风控弹窗等长尾未覆盖。
- 本报告只覆盖商品页取价引擎，不覆盖业务页（app.js）与平台壳；share/radar extras 仅验证「结构/字段仍在、取值合理」，未逐项回归其工作台 UI。
- `first-run.json` 生成时巡检尚未授权修复，其 `summary.failed` 里的 patrol 条目即当时的巡检基准偏差；与 `final-run.json` 对照可看修复前后差异。
