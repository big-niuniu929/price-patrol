# 价格监控平台 · 浏览器端验收报告

- 生成时间：2026-11-17T09:26:12.530Z（北京时间 2026-11-17 17:26:12 (UTC+8)）
- 结论：**PASS**（通过 67/67，失败 0）

- 验证模式：platform
- 扩展目录：`~/Desktop/三合一\价格监控平台`
- 扩展 ID：`iegegmaeojncdljmeacnkcpmjilladhd`
- 视口：1440x900 · headless Edge：Edg/157.0.4341.60 · CDP 端口：9587
- 耗时：39.1s

## 验收环境与时间

| 项 | 值 |
|---|---|
| 验收时间 | 2026-11-17 17:26:12 (UTC+8) |
| 验证方式 | platform（headless Edge 真实浏览器 E2E） |
| 视口 | 1440x900 |
| 浏览器 | Edg/157.0.4341.60（headless Edge，--load-extension 加载未打包扩展） |
| CDP 端口 | 9587 |
| Node | v24.19.0 |
| 扩展目录 | `~/Desktop/三合一\价格监控平台` |
| 扩展 ID | `iegegmaeojncdljmeacnkcpmjilladhd` |
| 断言总数 | 67（通过 67 / 失败 0） |
| 截图 | 12 张（`qa/shots/`） |
| 主页面耗时 | 39.1s |

截图均为 1440×900 视口、headless Edge 真实渲染：01 首页（四卡片）、02~04 三业务首屏、05 独立标签页、06 返回首页、07 深链 #/patrol、08/08b 两步后退、09 content.js 共存 mock 页、10 使用说明页、11 使用说明独立标签页。

## 断言明细

| 项 | 断言 | 结果 | 耗时 | 详情/错误 |
|---|---|---|---|---|
| S1 | manifest.json 存在且 JSON 可解析 | ✅ PASS | 5ms | name=价格监控平台 · 电商平台价格与竞品监控三合一 · version=1.1.5 · manifest_version=3 |
| S2 | manifest 符合合并规格（MV3 / 名称 / background / permissions / host_permissions） | ✅ PASS | 0ms | permissions=storage,tabs,unlimitedStorage,clipboardWrite · hosts=6 条 |
| S3 | content_scripts 注入三个模块的 content.js | ✅ PASS | 0ms | modules/patrol/content.js, modules/share/content.js, modules/radar/content.js |
| S4 | app.html 含 #moduleFrame、四张卡片 data-biz（三业务 + guide），且无内联脚本（MV3 CSP） | ✅ PASS | 2ms | 10KB · 四卡片四切换按钮齐全 · 无内联脚本/远程资源 |
| S5 | modules/<id>/app.html 存在；模块根 manifest.json/background.js 已移除 | ✅ PASS | 8ms | patrol: 9 项 · share: 7 项 · radar: 7 项 |
| S6 | 模块关键数据 JSON 已就位 | ✅ PASS | 5ms | patrol: 2 个 · share: 1 个 · radar: 1 个 |
| S7 | icons 16/32/48/128 存在 | ✅ PASS | 3ms | 16/32/48/128 齐全 |
| S8 | 平台根 README.md 存在且非空 | ✅ PASS | 0ms | 17KB |
| S9 | 使用说明页 guide.html + guide.css 存在，符合 MV3 CSP，关键小节齐全 | ✅ PASS | 3ms | 16KB · 13KB CSS · 无内联脚本/事件/远程资源 · 小节 7 项 |
| B1 | 启动 headless Edge 并加载扩展：~/Desktop/三合一\价格监控平台 | ✅ PASS | 2037ms | CDP 9587 · Edg/157.0.4341.60 · extDir=~/Desktop/三合一\价格监控平台 |
| B2 | 扩展加载成功且定位到本扩展 ID（background service worker 存在） | ✅ PASS | 1590ms | extId=iegegmaeojncdljmeacnkcpmjilladhd（未匹配路径推导变体，仅记录） |
| B3 | 打开 chrome-extension://iegegmaeojncdljmeacnkcpmjilladhd/app.html 并完成首屏 | ✅ PASS | 3541ms | title=价格监控平台 · readyState=complete · body=833 字符 |
| B4 | 业务选择页：四张卡片 [data-biz=patrol\|share\|radar\|guide] 齐全且可见 +「选择业务」文案 | ✅ PASS | 16ms | patrol「01 价格巡检 PRICE PATROL · 」 · share「02 市场占有率 MARKET SHARE W」 · radar「03 竞品监控 COMPETITOR PRIC」 · guide「04 使用说明 USER GUIDE · 操作」 · h1=选择业务 |
| B5 | 平台页无内联脚本与内联事件处理器（MV3 CSP） | ✅ PASS | 21ms | inline script 0 · inline handler 0 |
| B6 | 首页截图 01-platform-home-1440.png | ✅ PASS | 799ms | qa/shots/01-platform-home-1440.png |
| B7 | 首页无 console error（允许 warning） | ✅ PASS | 0ms | console error 0（累计 0） |
| M-patrol-enter | 点击首页业务卡片进入「价格巡检」 | ✅ PASS | 54ms | card [data-biz="patrol"]「01 价格巡检 」 |
| M-patrol-1 | iframe#moduleFrame 加载 modules/patrol/app.html | ✅ PASS | 487ms | src= · docUrl=chrome-extension://iegegmaeojncdljmeacnkcpmjilladhd/modules/patrol/app.html · readyState=complete · text=501 · tables=2/rows=0 |
| M-patrol-2 | 「价格巡检」首屏关键 DOM 渲染（#viewWorkbench / #tblBody / #statsBar） | ✅ PASS | 3ms | 命中 #viewWorkbench, #tblBody(不可见), #statsBar · docUrl=chrome-extension://iegegmaeojncdljmeacnkcpmjilladhd/modules/patrol/app.html · text=501 · tables=2 rows=0 · title=电商平台价格巡检工作台 |
| M-patrol-2b | 「价格巡检」iframe 尺寸合理（宽 ≥1000、高 ≥400） | ✅ PASS | 4ms | 1440x848 |
| M-patrol-2c | 「价格巡检」加载遮罩已消失（#frameMask.done） | ✅ PASS | 2ms | mask.done=true |
| M-patrol-3 | 「价格巡检」关键数据 JSON 均 200 | ✅ PASS | 401ms | modules/patrol/data/base-skus.json → 200 (60189 chars)；modules/patrol/data/ai-config.json → 200 (254 chars) |
| M-patrol-4 | 「价格巡检」截图 02-module-patrol-1440.png | ✅ PASS | 114ms | qa/shots/02-module-patrol-1440.png |
| M-patrol-5 | 「价格巡检」阶段 console 零 error | ✅ PASS | 1ms | 0（页面累计 0） |
| M-patrol-6 | 「价格巡检」阶段关键资源无 4xx/5xx/加载失败 | ✅ PASS | 0ms | 关键资源全部正常（data json 已另测） |
| M-share-enter | 用顶部切换按钮 [data-switch-biz="share"] 切到「市占率」 | ✅ PASS | 286ms | [data-switch-biz="share"]「市场占有率」 |
| M-share-1 | iframe#moduleFrame 加载 modules/share/app.html | ✅ PASS | 495ms | src= · docUrl=chrome-extension://iegegmaeojncdljmeacnkcpmjilladhd/modules/share/app.html · readyState=complete · text=854 · tables=3/rows=0 |
| M-share-2 | 「市占率」首屏关键 DOM 渲染（#page-workbench / [data-page-target="workbench"]） | ✅ PASS | 20ms | 命中 #page-workbench, [data-page-target="workbench"] · docUrl=chrome-extension://iegegmaeojncdljmeacnkcpmjilladhd/modules/share/app.html · text=854 · tables=3 rows=0 · title=电商平台市占率数据工作台 |
| M-share-2b | 「市占率」iframe 尺寸合理（宽 ≥1000、高 ≥400） | ✅ PASS | 4ms | 1440x848 |
| M-share-2c | 「市占率」加载遮罩已消失（#frameMask.done） | ✅ PASS | 4ms | mask.done=true |
| M-share-3 | 「市占率」关键数据 JSON 均 200 | ✅ PASS | 330ms | modules/share/data/base-skus.json → 200 (252198 chars) |
| M-share-4 | 「市占率」截图 03-module-share-1440.png | ✅ PASS | 1964ms | qa/shots/03-module-share-1440.png |
| M-share-5 | 「市占率」阶段 console 零 error | ✅ PASS | 0ms | 0（页面累计 0） |
| M-share-6 | 「市占率」阶段关键资源无 4xx/5xx/加载失败 | ✅ PASS | 0ms | 关键资源全部正常（data json 已另测） |
| M-radar-enter | 用顶部切换按钮 [data-switch-biz="radar"] 切到「竞品监控」 | ✅ PASS | 87ms | [data-switch-biz="radar"]「竞品监控」 |
| M-radar-1 | iframe#moduleFrame 加载 modules/radar/app.html | ✅ PASS | 674ms | src= · docUrl=chrome-extension://iegegmaeojncdljmeacnkcpmjilladhd/modules/radar/app.html · readyState=complete · text=1336 · tables=10/rows=393 |
| M-radar-2 | 「竞品监控」首屏关键 DOM 渲染（#viewDashboard / #viewTitle） | ✅ PASS | 87ms | 命中 #viewDashboard, #viewTitle · docUrl=chrome-extension://iegegmaeojncdljmeacnkcpmjilladhd/modules/radar/app.html · text=1345 · tables=10 rows=393 · title=竞品价格雷达 · 电商平台竞品价格监控 |
| M-radar-2b | 「竞品监控」iframe 尺寸合理（宽 ≥1000、高 ≥400） | ✅ PASS | 5ms | 1440x848 |
| M-radar-2c | 「竞品监控」加载遮罩已消失（#frameMask.done） | ✅ PASS | 3ms | mask.done=true |
| M-radar-3 | 「竞品监控」关键数据 JSON 均 200 | ✅ PASS | 135ms | modules/radar/data/competitor-skus.json → 200 (125977 chars) |
| M-radar-4 | 「竞品监控」截图 04-module-radar-1440.png | ✅ PASS | 338ms | qa/shots/04-module-radar-1440.png |
| M-radar-5 | 「竞品监控」阶段 console 零 error | ✅ PASS | 0ms | 0（页面累计 0） |
| M-radar-6 | 「竞品监控」阶段关键资源无 4xx/5xx/加载失败 | ✅ PASS | 0ms | 关键资源全部正常（data json 已另测） |
| D1 | 顶部业务切换按钮 [data-switch-biz] 四个入口齐全（三业务 + 使用说明） | ✅ PASS | 4ms | patrol「价格巡检」 · share「市场占有率」 · radar「竞品监控」 · guide「使用说明」 |
| D2 | 返回首页：回到业务选择页（四张卡片重新可见） | ✅ PASS | 280ms | 点击方式=#homeBtn「价格监控平台 —」 |
| D2b | 返回首页截图 06-platform-home-back-1440.png | ✅ PASS | 1126ms | qa/shots/06-platform-home-back-1440.png |
| D3 | 从首页重新进入「市占率」（首页↔业务切换往返） | ✅ PASS | 737ms | iframe docUrl=chrome-extension://iegegmaeojncdljmeacnkcpmjilladhd/modules/share/app.html · text=854 |
| D4 | 独立标签页打开：新标签页直接打开当前业务模块页且首屏渲染正常 | ✅ PASS | 1974ms | 点击=#openTabBtn · 新标签页=chrome-extension://iegegmaeojncdljmeacnkcpmjilladhd/modules/share/app.html · biz=share · title=电商平台市占率数据工作台 · text=855 · 命中=#page-workbench,[data-page-target="workbench"] · tables=3/rows=0 |
| D3b | 浏览器后退：1 次回到上一个业务（iframe 正文非空），2 次回到业务选择首页（四卡片） | ✅ PASS | 3642ms | 后退 1 次 → hash=#/patrol · 巡检正文 501 字符；后退 2 次 → 首页四卡片可见 · iframe=about:blank |
| D5 | 深链 #/patrol 冷启动：直接打开 app.html#/patrol 落在巡检业务 | ✅ PASS | 3388ms | hash=#/patrol · iframe docUrl=chrome-extension://iegegmaeojncdljmeacnkcpmjilladhd/modules/patrol/app.html · text=16202 |
| D5b | 深链截图 07-deeplink-patrol-1440.png | ✅ PASS | 178ms | qa/shots/07-deeplink-patrol-1440.png |
| D6 | 刷新后深链 #/patrol 仍落在巡检业务 | ✅ PASS | 2351ms | 刷新后 hash=#/patrol · iframe docUrl=chrome-extension://iegegmaeojncdljmeacnkcpmjilladhd/modules/patrol/app.html · text=16202 |
| D7 | 深链+刷新阶段 console 零 error、无关键资源失败 | ✅ PASS | 0ms | console error 0 · 网络问题 0 |
| G1 | 首页点击 [data-biz=guide] 卡片进入「使用说明」：iframe 文档为 guide.html，面包屑/标题/高亮同步 | ✅ PASS | 626ms | 点击卡片「04 使用说明 」→ iframe docUrl=chrome-extension://iegegmaeojncdljmeacnkcpmjilladhd/guide.html · hash=#/guide · 面包屑=使用说明 · 正文 5390 字符 |
| G2 | 使用说明页内容检查：h1=使用说明、7 个小节标题齐全、guide.css 生效、无内联脚本/事件/远程资源 | ✅ PASS | 0ms | h1=使用说明 · h2 7 个（一、平台是什么、怎么打开 / 二、三个业务分别做什么 / 三、取价逻辑：价格是怎么取到的 / 四、基准价、记录表与「波动%」 / 五、数据存在哪、怎么迁移 / 六、常见问题 / 七、后续 Web 版说明）· 正文 5390 字符 · CSS 已加载 · CSP 干净 |
| G3 | 深链 #/guide 冷启动：直接打开 app.html#/guide 落在使用说明 | ✅ PASS | 3203ms | hash=#/guide · crumb=使用说明 · iframe docUrl=chrome-extension://iegegmaeojncdljmeacnkcpmjilladhd/guide.html · 正文 5390 字符 |
| G4 | 顶部切换条也能切到「使用说明」：从使用说明切到巡检，再切回使用说明 | ✅ PASS | 532ms | 切换方式=使用说明 · docUrl=chrome-extension://iegegmaeojncdljmeacnkcpmjilladhd/guide.html · 正文 5390 字符 |
| G5 | 使用说明「独立打开」：新标签页打开 chrome-extension://<id>/guide.html 且渲染正常 | ✅ PASS | 839ms | 新标签页=chrome-extension://iegegmaeojncdljmeacnkcpmjilladhd/guide.html · title=使用说明 · 价格监控平台 · 正文 5390 字符 · console error 0 |
| G6 | 使用说明页截图 10-guide-1440.png | ✅ PASS | 759ms | qa/shots/10-guide-1440.png |
| G7 | 使用说明阶段 console 零 error、guide.html/guide.css 无 4xx/5xx/加载失败 | ✅ PASS | 1ms | console error 0 · 网络问题 0 |
| E1 | 全程 console 零 error 汇总 | ✅ PASS | 0ms | 0 条 |
| E2 | 全程关键资源（data/*.json 及 modules/ 资源）无 4xx/5xx/失败 | ✅ PASS | 1ms | data json 响应全部正常 |
| C0 | 拦截 https://item.shop.example.com/* 并返回本地 mock 商品页（不联网真实电商平台） | ✅ PASS | 2282ms | URL=https://item.shop.example.com/100012043978.html · title=电商平台商品页（本地 mock · 不联网） · docFulfilled=1 · other=1 |
| C1 | 三个 content.js 共存注入：同一页面三个 guard 均为 true | ✅ PASS | 2ms | isolated 上下文 1 个 · patrol/share/radar 全 true（context#3 价格监控平台 · 电商平台价格与竞品监控三合一） |
| C2 | content.js 无 SyntaxError / Identifier already declared 类脚本级错误 | ✅ PASS | 1ms | 0 条（mock 页 console error 共 0 条） |
| C3 | mock 商品页 console 干净（content.js 初始化无异常） | ✅ PASS | 0ms | console error 0 条 |
| C4 | mock 页截图 09-content-scripts-coexist-1440.png | ✅ PASS | 76ms | qa/shots/09-content-scripts-coexist-1440.png |

## 失败项与修复建议

无失败项。

## v1.1.5 变更（2026-11-17）· 四项业务优化

1. **市场占有率尺寸段规则 v2.2**：页面规格表 > 规格选择区 > 页面标题/网页标题 > 主图 alt > 上传榜单标题；
   唯一明确直接用，多个明确按型号/规格匹配、匹配不到取第一个并标「待核对」；页面采集尺寸可覆盖导入标题解析/待核对值，手动与库值不被覆盖。
2. **市场占有率配对表自适应**：去掉页面与表格固定最小宽度，表格 100% + 百分比列宽、高度随窗口；缩放时外框稳定、框内列宽/可见行数自适应（1000/1280/1440/1920 验证无横向滚动）。
3. **竞品监控记录表改为「日期 × SKU」矩阵**：点「写入今日记录」把本批最新价批量写入今天日期列；每次确认新增一列；下一轮「较基准%」以每行最近日期列为基准；记录表可查看/导出 CSV/清空；旧数据自动迁移。
4. **平台首页新增「使用说明」页**：首页第 4 入口、顶栏、快捷键 4、深链 #/guide、独立打开；覆盖业务说明、取价逻辑、基准价/记录表/波动%、数据迁移、常见问题、Web 版规划。

## 交叉验收汇总（v1.1.5，全部真实 headless Edge）

| 套件 | 脚本 | 结果 | 报告 |
|---|---|---|---|
| 平台 E2E（四入口/切换/深链/后退/独立打开/使用说明页） | `qa/verify.mjs` | **67/67 通过** | 本文件 |
| 巡检深度闭环 | `qa/deep-patrol.mjs` | **48 通过 / 3 跳过** | `DEEP-PATROL-REPORT.md` |
| 市占率 + 竞品监控深度闭环 | `qa/deep-business.mjs` | **54/54 通过** | `DEEP-BUSINESS-REPORT.md` |
| 三引擎取价矩阵 | `qa/engine/engine-matrix.mjs` | **15/15 一致** | `engine/REPORT.md` |
| 电商平台新版详情页真实 DOM | `qa/deep-jd2026.mjs` | **12/12 通过** | `JD2026-REPORT.md` |
| 市占率尺寸规则 v2.2 | 临时单元/mock 脚本 | 30 + 19 项通过 | — |

## 产品修复点（累计）

- v1.0.0：iframe 导航改 location.replace；独立打开=业务原生页；三 content.js 共存。
- v1.1.0：巡检 v1.3.4（基表 153 行/自动升级/多供应商 API）；三业务取价统一；竞品 saveMeta 稳定序列化修复。
- v1.1.1：竞品雷达适配电商平台 2026 新版详情页（含 floor 误伤修复）；下架计成功；真实 DOM 回归。
- v1.1.2 / v1.1.3：监控清单「导出最新数据」；按基表顺序导出、序号=基表行号。
- v1.1.4：批量「写入记录表」+ 记录表查看/导出/清空。
- v1.1.5：市占率尺寸规则 v2.2 + 配对表自适应；竞品记录表日期×SKU 矩阵；首页使用说明页。

## 遗留风险 / 未覆盖范围

- 市占率尺寸多值且无型号可匹配时取第一个并标待核对，建议人工抽检；旧版采集兜底路径不透传 sizeUncertain/sizeReason（主路径已透传）。
- 竞品记录表基准=最近日期列；同一天重复写入覆盖当天单元格（批次审计保留）；清空后退回导入历史/首次采集价。
- 使用说明页为扩展内静态页；Web 版需服务端承载/登录/权限/数据迁移设计（规划中）。
- 真实批量联网采集、AI 外网调用、官方 API 桥真实采价联调未覆盖。

## console error 汇总

0 条。

- 已知可接受资源说明：modules/patrol/data/preset-settings.json 已补为空 {}（本次运行返回 200），404 噪音已消失，knownBenign 过滤未触发。

## 网络（data/*.json 与 modules/ 资源）

- 200 chrome-extension://iegegmaeojncdljmeacnkcpmjilladhd/modules/patrol/data/base-skus.json（×5）
- 200 chrome-extension://iegegmaeojncdljmeacnkcpmjilladhd/modules/patrol/data/preset-settings.json（×6）
- 200 chrome-extension://iegegmaeojncdljmeacnkcpmjilladhd/modules/patrol/data/ai-config.json（×7）
- 200 chrome-extension://iegegmaeojncdljmeacnkcpmjilladhd/modules/share/data/base-skus.json（×5）
- 200 chrome-extension://iegegmaeojncdljmeacnkcpmjilladhd/modules/radar/data/competitor-skus.json（×2）

## content.js 共存验证（item.shop.example.com 本地 mock）

- isolated world 上下文：1 个，三个 guard 齐活（context#3）
- guard：patrol=`true` · share=`true` · radar=`true`
- mock 页 console error：0 条
- 说明：用 CDP Fetch 拦截 https://item.shop.example.com/* 返回本地极简商品页（不联网真实电商平台），验证三个 content.js 能在同一扩展 isolated world 共存注入。

---

最小复现：`node qa/verify.mjs`（可选 `--ext <目录>` 覆盖扩展目录）；失败现场截图见 `qa/shots/fail-*.png`。