# 价格监控平台 · 市占率 + 竞品监控 深度真实浏览器验收报告

- 生成时间：2026/11/17 15:54:55（Asia/Shanghai；ISO: 2026-11-17T07:54:55.352Z）
- 浏览器：Edg/157.0.4341.60（headless Edge，CDP 端口 9575）
- 扩展：`iegegmaeojncdljmeacnkcpmjilladhd` · 目录 `~/Desktop/三合一\价格监控平台`
- 视口：1440x900
- 脚本：`qa/deep-business.mjs`（复用 `qa/lib/cdp.mjs`，未修改平台任何产品文件）

## 总览

| 指标 | 值 |
| --- | --- |
| 断言总数 | 54 |
| 通过 | ✅ 54 |
| 失败 | ❌ 0 |
| 环境 section | 3/3 |
| 市占率 share | 23/23 |
| 竞品监控 radar | 28/28 |
| 发现产品 bug | 1（已修复 ✅ 1 / 仍存在 ❌ 0） |
| 测试期望修正（非产品 bug） | 3 项（S02/S05/S06，见下） |
| 真实下载文件 | 15 个（见附录） |
| 截图 | 33 张 |

浏览器内 CDP Fetch 拦截 `https://item.shop.example.com/*` 返回本地 mock 商品页共 **3** 次（全程未联网抓取真实电商平台页）。

## 产品 Bug（最小复现 + 修复前后对比；未自行修改产品文件，已同步 Lead）

### BUG-RADAR-SAVEMETA（high · ✅ 已修复并回归通过）saveMeta 写入校验用 JSON.stringify 直接比较对象，key 顺序被 chrome.storage 重排导致永久误报「写入校验不一致」

- 发现于：修复前（Lead 修复前同一脚本）：R11/R12/R24 失败 + R25 console error 3 条
- 位置：`modules/radar/app.js` 第 309-330（saveMeta）；调用点：drawerBaselineSave、drawerNoteSave、setRowOffline、handleImportFile、addMonitor 等 行
- 最小复现：
  1. （修复前）打开平台 → 竞品监控 → 监控清单 → 点任意 SKU 行打开详情抽屉
  2. 在「基准价」输入框填 4321，点「保存」
  3. 修复前实际：红色 toast「监控清单保存失败：写入校验不一致」，抽屉基准价仍显示旧值（后续 buildRows/renderAll/成功 toast 均未执行）
  4. 修复前 Console：[exception] Error: 写入校验不一致 at saveMeta (modules/radar/app.js:315:15)
- 期望：保存成功，toast「基准价已保存」，抽屉基准价显示 ¥4,321，刷新后仍保留
- 修复前实际：toast=监控清单保存失败：写入校验不一致；抽屉基准价=¥2,199；但数据层实际已写入 baseline=4321（仅写后校验误判）；R12 备注保存、R24 导入备份同样受影响
- 修复后实际：修复后：toast=基准价已保存，抽屉基准价=¥4,321；R12 备注保存、R14 下架持久化、R24 导入备份均通过；R25 console error 0
- 根因分析：chrome.storage.local 落盘后读回的对象 key 被按字母序重排（stored=[custom,overrides,savedAt,version] vs 内存=[version,custom,overrides,savedAt]），saveMeta 用 JSON.stringify(check[KEY_META]) !== JSON.stringify(state.meta) 做一致性校验，key 顺序不同 → 永远判定不一致并 throw。
- 修复方案：新增 stableStringify(v)（对象 key 排序后递归序列化），saveMeta 与 storage.onChanged 同步比较都改用它（Lead 已按此修复，与巡检 v1.3.4 saveBaseOverride 对齐）。
- 证据：`shots-deep-business/R11-radar-drawer-baseline-ok.png`、`shots-deep-business/R24-radar-import-confirm.png`、`shots-deep-business/R23-radar-alerts.png`

## 测试期望修正说明（核对产品语义后修正断言，不是产品 bug）

| 断言 | 主题 | 产品实际语义 | 修正内容 |
| --- | --- | --- | --- |
| S02 | 空态配对表提示文案 | #matchEmpty 运行时文案为「尚未导入榜单。导入后点「分析补数」，这里会显示每一行的尺寸段 / 价格段与来源。」（与 app.html 静态初始文案不同，由 renderMatchTable 在空态时替换） | 断言从固定文案「导入榜单并点击」改为兼容实际空态文案；属于测试期望修正，不是产品 bug。 |
| S05 | 导入后榜单卡文件名 | 导入完成后「STEP 01 导入区」按设计自动折叠、榜单管理 details 默认关闭，隐藏 details 内元素的 innerText 为空，但卡片 DOM 与文件名均正确存在（report cards 由 renderReports 渲染） | 测试改为先展开「榜单管理」details（真实用户可见路径）再断言卡片 textContent；产品行为符合 DESIGN 18.3，不是产品 bug。 |
| S06 | 两个榜单后的「配对表」行数 | 配对表 #tableCount 统计「当前榜单」行数（200），不是多榜单合计；总览页 #overviewCount 才是全部榜单合计 400。产品语义正确。 | 断言改为：2 个榜单各 200 行、合计 400 行、配对表=当前榜单 200 行，并补充「点击榜单卡切换当前榜单」交互断言；属于测试期望修正，不是产品 bug。 |

## 断言明细

### 环境与启动（3/3 通过）

| ID | 断言 | 结果 | 耗时 | 证据 / 说明 |
| --- | --- | --- | --- | --- |
| E1 | headless Edge + 扩展加载（extDir=~/Desktop/三合一\价格监控平台） | ✅ 通过 | 2.0s | Edg/157.0.4341.60 · CDP 9575 |
| E2 | 定位扩展 ID 并打开平台首页 | ✅ 通过 | 12.0s | extId=iegegmaeojncdljmeacnkcpmjilladhd · title=价格监控平台 · cards=4 · switches=patrol,share,radar,guide |
| E3 | 下载目录与截图目录就绪 | ✅ 通过 | 5ms | downloadDir=`qa/shots-deep-business/downloads`（已有 0 个文件；目录未随仓库提交） |

### 市占率 share（23/23 通过）

| ID | 断言 | 结果 | 耗时 | 证据 / 说明 |
| --- | --- | --- | --- | --- |
| S01 | 从平台首页进入「市占率」业务（iframe#moduleFrame 加载 modules/share/app.html） | ✅ 通过 | 3.2s | via=card · iframe=chrome-extension://iegegmaeojncdljmeacnkcpmjilladhd/modules/share/app.html · 页签=工作台/总览/匹配库/统计看板/设置与帮助 |
| S02 | 工作台空态结构：配对表空提示 / 导入区 / KPI 全 0 / 分析按钮 | ✅ 通过 | 3ms | 空态正常 · 榜单=0 · KPI=榜单文件 0 个 总行数 0 行 已补齐 0 / 0 行 待补采 0 / 有效 0 行 已下架 0 行（不计入分母） 采集失败 0 行 待确认 0 行 待确认写入 0 行 待人工复核 0 行 缺尺寸段 0 行 缺价格段 0 行 尺寸段覆盖 0% 0/0 价格段覆盖 0% 0/0 总成交金额 0 万元 |
| S03 | 空态点「分析补数」给出明确错误提示且不崩溃 | ✅ 通过 | 1.1s | toast=还没有榜单：先导入 .xlsx 榜单文件 |
| S04 | 四页签来回切换（工作台→总览→匹配库→统计看板→设置与帮助→工作台） | ✅ 通过 | 6.8s | 切换顺序 workbench→overview→library→stats→settings→workbench，每次仅 1 页可见 |
| S05 | 导入真实电商平台榜单 xlsx（test-backfill.xlsx，200 行）→ 榜单卡/类目绑定/配对表出现 | ✅ 通过 | 3.6s | test-backfill.xlsx · 200行 · sheet=品牌B大家电商智_商品榜单_热销排名_离线_汇总下载 · 绑定「大家电 会议电视」· 置信度=1 · DOM行=100 |
| S06 | 导入第二个真实榜单（回填_11月-会议平板 xlsx，真实导出回填格式）→ 2 个榜单 / 总 400 行 / 榜单卡切换 | ✅ 通过 | 5.1s | test-backfill.xlsx:200行/大家电 会议电视 / 回填_11月-会议平板_20261106-125446.xlsx:200行/大家电 会议平板一体机 · 卡片切换 → 当前榜单行数=200 |
| S07 | 点「分析补数」（离线）→ 分析完成提示 + 数字/配对表更新 | ✅ 通过 | 3.8s | toast=分析完成：2 个榜单 / 400 行 · table=200 · DOM行=100 |
| S08 | 配对表行内编辑「型号」→ 单元格/状态/来源 更新 | ✅ 通过 | 3.7s | SKU=100200174986 型号 100XP3E → QA-MODEL-75X（来源=手动） |
| S09 | 配对表行内编辑「尺寸段」→ 单元格/人工来源更新（或 KPI 缺尺寸段减少） | ✅ 通过 | 3.8s | SKU=100200174986 尺寸段 98/100英寸 → 86/85英寸 · 缺尺寸段 2→2（该行原有尺寸，KPI 不变） |
| S10 | 行内编辑「取消」不写库（编辑器出现 → 取消 → 原值恢复） | ✅ 通过 | 1.5s | 套餐保持 ""（未写库） |
| S11 | 搜索 / 状态筛选 / 每页行数 / 快捷筛选 交互断言 | ✅ 通过 | 8.4s | 搜索 100→71 行；缺价格段筛选 100 行；50/页 50 行；chip 筛选 2 行后取消 |
| S12 | 总览页：全部配对行汇总 + 搜索/筛选 + 导出配对表 xlsx / CSV（真实下载） | ✅ 通过 | 12.4s | overviewCount=400 → 搜索「海信」101 行 → 类目「大家电 会议电视（200 行）」200 行 · DOM行=200 · 下载 配对总览_20261117-155156.xlsx (43008B, PK 头) · 配对总览_20261117.csv（126487B / 401 行） |
| S13 | 统计看板：类目选择条切换 → 数字/榜单口径变化 | ✅ 通过 | 5.9s | tabs=全部400 行 · 4,246 万 / 大家电 会议电视200 行 · 2,361 万 / 大家电 会议平板一体机200 行 · 1,885 万 · 品类品牌数 34→16 · 切到「大家电 会议电视200 行 · 2,361 万」· 品牌排序 {"field":"amount","dir":"desc"}→{"field":"brand","dir":"asc"}（首行 海信→奥德文仪） |
| S14 | 统计看板：品牌搜索过滤 + 刷新统计 + 导出统计 xlsx 下载 | ✅ 通过 | 5.1s | 品牌表 16 行 → 搜索「海信」1 行 → 刷新 16 行 · 下载 市占率结果_20261117-155209.xlsx (48447B, PK 头) |
| S15 | 导出菜单：市占率结果 xlsx / 当前榜单回填 xlsx / 全部回填 xlsx / 筛选 CSV / 备份 JSON（真实下载） | ✅ 通过 | 10.9s | 结果=市占率结果_20261117-155212.xlsx (48447B, PK 头)；当前回填=回填_test-backfill_20261117-155213.xlsx(23673B)；全部回填=2 个(回填_test-backfill_20261117-155214.xlsx,回填_回填_11月-会议平板_20261106-125446_20261117-155215.xlsx)；CSV=配对明细_20261117.csv(61 |
| S16 | 匹配库页：KPI / 类目列表 / SKU 明细 / 搜索 / 操作日志开合 | ✅ 通过 | 7.4s | KPI=类目 \| 4 \| 个 \| SKU 总数 \| 1,101 \| 个 \| 尺寸段覆盖 \| 58% \| 639/1,101 \| 价格段覆盖 \| 58.9% \| 648/1,101 \| 尺寸+价格齐全 \| 58% \| 638 条 \| 历史脏值记录 \| · 明细 100 行（搜索 海信 → 100）· 操作日志 2 条已开合 |
| S17 | 匹配库：导出 xlsx 下载 + 归一化脏值 / 冲突检查 给出结果面板 | ✅ 通过 | 6.3s | 下载 匹配库_20261117-155229.xlsx (73424B, PK 头) · 归一化报告「归一化完成：共修正 1 处脏值（最多展示 200 条）。 # 类目 SKU 字段 修正前 修正后 1 大家电 会议电视 100200174986 尺寸段 86/85英寸 98/100英寸」· 冲突检查「匹配库检查： 类目 4 SKU 1,101 尺寸/价格不完整 463 历史脏值 27 跨类目冲突 0 空商品名 200 尺寸段 / 价格 |
| S18 | 设置页：关键项存在 + 修改「每次最多采集」保存并持久化 | ✅ 通过 | 4.7s | 快捷键检查通过 · batch 0→5（存储=5） |
| S19 | 设置页：恢复默认设置（确认框）→ 批量恢复默认值 | ✅ 通过 | 2.4s | 确认框「恢复默认设置」→ 已恢复默认设置 · batchSize=0 |
| S20 | 主题切换 ☀/🌙（data-theme + toast + 切回） | ✅ 通过 | 3.6s | dark(☀) → light(🌙) → dark |
| S21 | 设置页：导出备份 JSON → 再导入同一备份（闭环，确认框） | ✅ 通过 | 6.0s | 下载 市占率备份_20261117-155245.json（2015178B，4 类目 / 2 榜单）→ 导入成功 · toast=备份已导入：匹配库 4 个类目 / 榜单 2 个 |
| S22 | 不同结构真实 xlsx（线上竞争数据分析（月度）.xlsx）导入稳健性 | ✅ 通过 | 2.5s | 成功导入 线上竞争数据分析（月度）.xlsx：176 行（绑定类目=3C店） |
| S23 | 市占率 section 阶段 console error / runtimeErrors 汇总 | ✅ 通过 | 2ms | console error 0（页面累计 0）· runtimeErrors 0 |

### 竞品监控 radar（28/28 通过）

| ID | 断言 | 结果 | 耗时 | 证据 / 说明 |
| --- | --- | --- | --- | --- |
| R01 | 从平台顶部切换到「竞品监控」（iframe 加载 modules/radar/app.html） | ✅ 通过 | 1.7s | via=switch · chrome-extension://iegegmaeojncdljmeacnkcpmjilladhd/modules/radar/app.html · 176 个 SKU · 视图=dashboard/analytics/volatility/watchlist/alerts/runs |
| R02 | 六个视图逐个切换（总览/分析/波动/监控清单/异动中心/采集任务） | ✅ 通过 | 8.5s | dashboard「总览」 → analytics「分析」 → volatility「波动」 → watchlist「监控清单」 → alerts「异动中心」 → runs「采集任务」 |
| R03 | 总览数据渲染：KPI / 品牌分布 / 最新异动 / 价格带 / 同尺寸最低价 / 采集概况 | ✅ 通过 | 1.4s | KPI={"monitor":"173","today":"0","alerts":"0","drop":"0","rise":"0","fail":"0"} · hero=173 · 品牌条=7 · 价格带=6 · 同尺寸=5 · 异动行=0 |
| R04 | 监控清单：表格排序（点表头）→ 排序字段/方向/首行变化 | ✅ 通过 | 3.7s | 表头 brand,category,size,sku,base,latest,delta,band,peer,updated,status · 排序=base desc→asc · 首行 SKU 100226456369→100406803958 |
| R05 | 监控清单：搜索 / 类型筛选 / 状态筛选 / 清空筛选 | ✅ 通过 | 6.8s | 搜索 176→47 行 · 类型「LED屏」→2 行 · 已下架 3 行 · 已清空 |
| R06 | 清单：品牌 chip / 密度切换 / 隐藏已下架 勾选生效 | ✅ 通过 | 7.3s | 品牌 chip「联想 47」→ 47 行 · 密度 comfortable→compact · 隐藏已下架 176→173 行 |
| R07 | 导出 JSON 备份（真实下载 + schema/数据校验） | ✅ 通过 | 2.0s | 下载 竞品价格雷达-备份-20261117-1553.json（787B）· schema=price-radar.backup.v1 · custom=0 · captures=0 · 设置项=20 |
| R08 | 导出 CSV 清单（真实下载 + 表头/行数校验） | ✅ 通过 | 1.5s | 下载 竞品价格雷达-清单-20261117.csv（19884B）· 176 行数据 |
| R08b | 「导出最新数据」：当前筛选 CSV（表头/行数/筛选生效/商品链接） | ✅ 通过 | 3.3s | 品牌筛选=联想 · 清单 47 行 → CSV 47 行 · toast=已导出最新数据 47 行（当前筛选（品牌=联想），按基表顺序） |
| R09 | 勾选 2 个 SKU → 「对比」按钮启用 → 对比弹窗 2 行 → 关闭 | ✅ 通过 | 5.9s | selText=已选 2 个 · 对比 2 行 · 图例「联想 55英寸 联想 65英寸」· 已关闭 |
| R10 | 详情抽屉打开：SKU/型号/基准价/标签/采集记录 渲染 | ✅ 通过 | 2.0s | SKU=SKU 100226456369 · 型号=联想 55英寸 · 基准=¥2,199 · 标签=联想 会议电视 55英寸 安卓 < 3,000 已下架 · 下架按钮=恢复上架 |
| R11 | 抽屉：修改基准价保存（saveMeta 写后校验修复回归） | ✅ 通过 | 2.7s | 基准价保存成功：¥4,321 · toast=基准价已保存（saveMeta 校验修复已验证） |
| R12 | 抽屉：修改备注保存（saveMeta 修复回归） | ✅ 通过 | 2.6s | 备注保存成功：备注已保存 |
| R13 | 抽屉：复制 SKU（navigator.clipboard 调用 / 成功提示） | ✅ 通过 | 1.0s | toast=已复制 SKU：100226456369 · secureContext=true |
| R14 | 抽屉：标记已下架 → 恢复上架（状态/按钮/标签变化） | ✅ 通过 | 3.7s | offline true→false→true（storage 持久化=true）· 按钮「恢复上架」↔「标记已下架」· toast=已恢复上架，重新加入自动采集 · 抽屉已关闭 |
| R15 | 采集前状态：写入记录表禁用 / 暂停停止禁用 / 开始与重新核验可用 | ✅ 通过 | 1.2s | 开始/重新核验可用 · 确认本次采集禁用(title=当前没有待写入记录表的采集结果) · 范围=filtered · 本批最多=40 |
| R16 | 重新核验 → 起「开始采集」确认框 → 取消（不启动任务） | ✅ 通过 | 2.1s | 确认框「开始采集」文案含本次 SKU/采集模式 → 取消后 running=false |
| R17 | 单条采集闭环（Fetch 拦截 item.shop.example.com 本地 mock）：toast/任务记录/最新价/KPI | ✅ 通过 | 8.1s | SKU=100302202082 · 价格=¥4999(hand / 置信度=high) · 任务记录 0→1 · toast=采集结束：成功 1 · 失败 0；点「写入今日记录」批量更新下轮基准 · Fetch 拦截=1 次 |
| R18 | 「写入今日记录」→ 本批最新价批量写入记录表当天日期列（日期 × SKU） | ✅ 通过 | 3.5s | toast=已把 1 个 SKU 的本次采集价写入今日记录（2026-11-17）；下一轮波动以记录表为准 · 记录表 1 天 · 今日记录价=4999 · 最近任务「2026-11-17 15:53 后台标签页 1 1 0 — 6s」 |
| R18b | 记录表弹窗：日期 × SKU 矩阵 / 导出 CSV / 关闭 | ✅ 通过 | 5.4s | 弹窗 1 行 × 1 天 · CSV 1 行（竞品价格雷达-记录表-20261117-1554.csv）· 表头含日期列 2026-11-17 |
| R18c | 下一轮「较基准」以记录表最近日期列为准（记录 4999 → 新采 5499 = +10%） | ✅ 通过 | 6.8s | 记录表基准 ¥4999 → 新采 ¥5499 · 较基准单元格=↑10.0% · 基准单元格=¥4,999 记录表 |
| R19 | 详情抽屉「立即采集」下架页路径（mock 已下架页）→ 下架算成功采集/自动下架/不崩溃 | ✅ 通过 | 4.3s | SKU=100302202034 · toast=采集结束：成功 1 · 失败 0；点「写入今日记录」批量更新下轮基准 · fail.type=offline · 自动下架=true · 原因=商品已下架 / 页面不存在（页面标题：电商平台商品页（本地 mock · 已下架）） |
| R20 | 设置弹窗：改阈值 → 保存 → 重开断言保留（并改回） | ✅ 通过 | 8.0s | 阈值 5/15 → 6/18（存储+重开保留）→ 已改回 5/15 · 模式=background |
| R21 | 帮助弹窗：打开/内容/关闭 | ✅ 通过 | 2.0s | 帮助内容「使用说明 一分钟上手 Edge 打开 edge://extensions/ → 打开「开发人员模式」→「加载解压缩的扩展」→ 选择 竞品价格雷达\extension → 固定到工具栏。 点扩展图标打开工作台。内置监控清单来自《线上竞争数据分」已开合 |
| R22 | 「添加监控」弹窗：打开 / 无效 SKU 校验提示 / 取消关闭 | ✅ 通过 | 4.4s | 弹窗打开 · 无效输入提示「请输入正确的电商平台 SKU 或商品链接（6–20 位数字）」· 取消关闭 |
| R23 | 异动中心：状态页签切换 + 异动条目处理（确认采集后应有异动） | ✅ 通过 | 6.9s | 页签=未处理 3 / 已处理 0 / 已忽略 0 / 全部 3 · 未处理 3→2 · 列表 3→2 · toast=已标记处理 |
| R24 | 导出备份 JSON → 再「导入备份」同一文件（闭环；saveMeta 修复后应成功） | ✅ 通过 | 3.6s | 备份已导入 · toast=备份已导入 · runs(3→0) captures(2→0) · 今日已采 1→0（renderAll 已执行） |
| R25 | 竞品监控 section 阶段 console error 汇总 | ✅ 通过 | 1ms | console error 0（页面累计 0） |

## console error 原文

### 市占率 share 阶段
无 console error。

### 竞品监控 radar 阶段
无 console error。

## 真实下载文件（Page.setDownloadBehavior 指向 qa/shots-deep-business/downloads）

| 文件 | 字节 | 时间 |
| --- | --- | --- |
| 配对总览_20261117-155156.xlsx | 43008 | 2026-11-17T07:51:58.069Z |
| 配对总览_20261117.csv | 126487 | 2026-11-17T07:51:59.788Z |
| 市占率结果_20261117-155209.xlsx | 48447 | 2026-11-17T07:52:10.769Z |
| 市占率结果_20261117-155212.xlsx | 48447 | 2026-11-17T07:52:13.360Z |
| 回填_test-backfill_20261117-155213.xlsx | 23673 | 2026-11-17T07:52:14.664Z |
| 回填_test-backfill_20261117-155214.xlsx | 23673 | 2026-11-17T07:52:16.856Z |
| 回填_回填_11月-会议平板_20261106-125446_20261117-155215.xlsx | 23318 | 2026-11-17T07:52:16.856Z |
| 配对明细_20261117.csv | 61689 | 2026-11-17T07:52:18.154Z |
| 市占率备份_20261117-155218.json | 2014809 | 2026-11-17T07:52:19.497Z |
| 匹配库_20261117-155229.xlsx | 73424 | 2026-11-17T07:52:30.343Z |
| 市占率备份_20261117-155245.json | 2015178 | 2026-11-17T07:52:47.323Z |
| 竞品价格雷达-备份-20261117-1553.json | 787 | 2026-11-17T07:53:25.966Z |
| 竞品价格雷达-清单-20261117.csv | 19884 | 2026-11-17T07:53:27.502Z |
| 竞品价格雷达-最新数据-20261117-1553.csv | 7547 | 2026-11-17T07:53:29.811Z |
| 竞品价格雷达-记录表-20261117-1554.csv | 117 | 2026-11-17T07:54:08.252Z |

## 截图

目录：`qa/shots-deep-business/`（失败步骤另有 `fail-<ID>.png`）

- `S01-share-workbench-empty.png` — 市占率 · 工作台首屏（未导入）
- `S03-share-tabs-cycled.png` — 四页签切换后回到工作台
- `S05-share-imported.png` — 导入 test-backfill.xlsx 后
- `S06-share-imported-2.png` — 导入两个真实榜单后（含榜单卡）
- `S07-share-analyzed.png` — 分析补数完成后（含 KPI）
- `S08-share-inline-edited-model.png` — 行内编辑型号为 QA-MODEL-75X
- `S09-share-inline-edited-size.png` — 行内编辑尺寸段
- `S12-share-overview.png` — 市占率 · 总览页
- `S13-share-stats.png` — 统计看板 · 类目「大家电 会议电视200 行 · 2,361 万」+ 品牌排序
- `S15-share-export-menu.png` — 导出菜单 + 下载完成
- `S16-share-library.png` — 市占率 · 匹配库页
- `S17-share-library-report.png` — 匹配库 · 归一化/冲突检查结果
- `S18-share-settings.png` — 设置页 · 保存后
- `S20-share-theme.png` — 主题切换后（已切回）
- `S21-share-backup-roundtrip.png` — 备份 JSON 导出→导入 闭环
- `R01-radar-dashboard.png` — 竞品监控 · 总览
- `R02-radar-analytics.png` — 竞品监控 · 分析
- `R02-radar-volatility.png` — 竞品监控 · 波动
- `R02-radar-alerts.png` — 竞品监控 · 异动中心
- `R02-radar-runs.png` — 竞品监控 · 采集任务
- `R09-radar-compare.png` — 竞品对比弹窗（2 个 SKU）
- `R10-radar-drawer.png` — 竞品详情抽屉
- `R11-radar-drawer-baseline-ok.png` — 修复后：抽屉基准价保存成功（¥4,321 + 成功 toast）
- `R12-radar-drawer-note-ok.png` — 修复后：抽屉备注保存成功
- `R16-radar-start-confirm.png` — 开始采集确认框（重新核验）
- `R17-radar-capture-success.png` — mock 采集成功 SKU=100302202082
- `R18-radar-runs.png` — 采集任务视图（含 mock 采集记录）
- `R19-radar-capture-offline.png` — mock 下架页采集失败路径
- `R20-radar-settings.png` — 设置弹窗（阈值保存/重开保留）
- `R23-radar-alerts.png` — 异动中心（mock 采集产生的异动 + 标记处理）
- `R24-radar-import-confirm.png` — 导入备份确认框
- `R24-radar-import-ok.png` — 修复后：导入备份成功（备份已导入 + 数据覆盖）
- `ZZ-final-state.png` — 验收结束页面状态

## 结论

- 本轮真实浏览器验收：**54 项断言 / 通过 54 / 失败 0**；市占率 share 23/23，竞品监控 radar 28/28，环境 3/3。
- 发现并已修复回归通过的产品 bug 1 个：BUG-RADAR-SAVEMETA（修复前后对比 + 证据截图见上）。
- 当前无遗留产品 bug。
- 测试期望修正 3 项（S02/S05/S06），均已核对产品真实语义，不属于产品 bug。
- 覆盖率：市占率四页签（工作台/总览/匹配库/统计看板/设置与帮助）+ 真实 xlsx 导入（3 个真实只读样本）/分析补数/行内编辑/搜索筛选/统计/5 类导出真实下载/备份 JSON 导出导入闭环/主题切换；竞品监控六视图 + 批量「写入记录表」（记录表/基线/下轮波动）+ 表格排序/搜索/筛选/对比/详情抽屉（基准价/备注/复制/下架/采集/确认）/设置/帮助/添加监控/异动处理/添加备份导入闭环/导出 JSON+CSV 真实下载；采集闭环通过 CDP Fetch 拦截 item.shop.example.com 返回本地 mock（成功 + 已下架失败两条路径，未联网电商平台）。
- 环境：Edg/157.0.4341.60 headless；console error：share 0 条 / radar 0 条。

## 复现方式

```powershell
cd ~/Desktop/三合一\价格监控平台
node qa/deep-business.mjs            # share + radar 全量
node qa/deep-business.mjs --only share
node qa/deep-business.mjs --only radar
```
