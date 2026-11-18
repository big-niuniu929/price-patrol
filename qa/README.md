# 价格监控平台 · QA 验证目录

浏览器端 / 无浏览器双通道验收工具。零第三方运行时依赖（jsdom 为只读复用，见下）。

```
qa/
├── verify.mjs              平台基础 E2E（静态检查 / jsdom 壳逻辑 / headless Edge E2E / 报告整理 / 工具链自检）
├── deep-patrol.mjs         平台壳 + 巡检 v1.3.4 深度功能闭环（51 项：48 通过 / 3 SKIP）
├── deep-business.mjs       市占率 + 竞品监控深度功能闭环（54 项全通过，含 xlsx 导入 / 下载 / mock 采集 / 导出最新数据 / 写入今日记录）
├── deep-jd2026.mjs         电商平台 2026 新版详情页真实 DOM 回放回归（12 项：三引擎 hand/main 与真实会员价一致）
├── engine/                 三业务取价引擎一致性矩阵（15 个 mock 商品页 × 3 引擎；含 REPORT.md 与 first/final-run 证据）
├── lib/
│   ├── cdp.mjs             极简 CDP 客户端 + headless Edge 启动/清理（复制自 市占率\tools\qa\lib，只读源）
│   └── nav.mjs             页面导航识别辅助（同来源，保留备用）
├── shots/                  平台基础 E2E 正式截图（10 张）
├── shots-deep-patrol/      巡检深度验收截图（11 张）与 evidence/ 下载证据
（深度验收截图与真实导出文件含业务数据，未随仓库提交；见案例页）
├── REPORT.md               平台基础 E2E 人读报告（含 v1.1.0/v1.1.1 变更、交叉验收汇总、修复点、风险）
├── JD2026-REPORT.md        电商平台新版详情页真实 DOM 回归报告（fixture 在 qa/engine/fixtures/jd-2026/）
├── DEEP-PATROL-REPORT.md   巡检深度验收报告（51 项断言表）
├── DEEP-BUSINESS-REPORT.md 市占/竞品深度验收报告（51 项断言表 + 1 个已修复 bug 前后对比）
└── report.json             平台基础 E2E 结构化报告
```

## 运行

```powershell
# 1) 静态检查（不开浏览器，最快；8 项）
node qa/verify.mjs --static

# 2) 静态检查 + jsdom 壳逻辑验证（无浏览器兜底；18 项，会写 report.json / REPORT.md）
node qa/verify.mjs --dom

# 3) 正式浏览器 E2E（必须在 full-access / 普通终端运行；DSH workspace-write 沙箱内 Chromium 无法启动）
node qa/verify.mjs

# 4) 报告整理（不跑验证；用现有 report.json 重新生成 REPORT.md，补环境/修复点/风险段）
node qa/verify.mjs --render

# 5) 工具链自检：加载只读原插件并截图（需要 full-access；产物 qa/shots/harness-selftest-share.png）
node qa/verify.mjs --selftest --ext "~/Desktop/市占率\extension"
```

可选参数：`--ext <扩展目录>`（覆盖 extDir）、`--out <报告目录>`、`--port <CDP端口>`、`--ext-id <ID>`、`--browser <浏览器路径>`、`--timeout <ms>`（单步等待，默认 20000）。

退出码：`0` 全部通过；`1` 存在失败项；`2` 环境/致命错误（未跑完）。

## 当前结论（v1.1.5 · 2026-11-17）

| 套件 | 脚本 | 结果 | 报告 |
|---|---|---|---|
| 平台基础 E2E（含第 4 入口使用说明页） | `node qa/verify.mjs` | ✅ **67/67 PASS**（1440×900 · 约 30s） | `REPORT.md` |
| 巡检 v1.3.4 深度闭环 | `node qa/deep-patrol.mjs` | ✅ **48/48 PASS，3 SKIP**（产品无排序/分页/抽屉交互）· 约 86s | `DEEP-PATROL-REPORT.md` |
| 市占率 + 竞品监控深度闭环 | `node qa/deep-business.mjs` | ✅ **54/54 PASS**（share 23/23 · radar 31/31）· 约 4m | `DEEP-BUSINESS-REPORT.md` |
| 取价引擎一致性 | `node qa/engine/engine-matrix.mjs` | ✅ **15/15 三引擎一致**（契约 5/5 · extras 9/9 · console 0）· 约 100s | `engine/REPORT.md` |
| 电商平台新版详情页真实 DOM | `node qa/deep-jd2026.mjs` | ✅ **12/12 通过**：三引擎均取到 hand=5149 / main=5499 · 约 50s | `JD2026-REPORT.md` |

覆盖：电商平台新版详情页真实 DOM 回放（竞品雷达 v1.1.1 修复验证）；平台壳（业务选择/切换/独立打开/深链/后退/快捷键/跨标签页状态）；巡检（4 类目、总览 12 卡片、搜索筛选勾选、手动改价、同品比价、基表导入/导出/自动升级、导出 CSV/JSON/Excel→清空→导入回导、设置/AI 设置、多供应商 API 账号、双轨切换、下架恢复、悬停预览）；市占率（5 页签、3 个真实 xlsx 导入、分析补数、行内编辑、统计看板、匹配库、5 类导出下载、备份 JSON 闭环、主题切换）；竞品监控（六视图、导出 JSON/CSV、对比、详情抽屉全按钮、mock 采集成功/下架失败两条链路、确认本次采集、异动处理、导入备份闭环、设置）；取价矩阵 15 场景三引擎逐字段一致。

**环境限制**（为什么浏览器 E2E 需在 full-access 环境跑）：DSH workspace-write 沙箱禁止子进程命名管道，Chromium 的 mojo IPC 无法建立，headless Edge 启动后必然 FATAL 退出（本机复现：`FATAL:mojo\public\cpp\platform\platform_channel.cc:187 Check failed: . : 拒绝访问 (0x5)`，exit code 2147483651；已尝试默认参数 / `--no-sandbox` / `--single-process` / 更换 profile 位置均无效）。因此本目录脚本在沙箱内只跑静态/jsdom，正式 E2E 由 Lead 在 full-access 会话执行，报告与截图已落盘到本目录。

## 断言清单

### S —— 静态（不依赖浏览器）
S1 manifest JSON 可解析 · S2 MV3/名称/background.service_worker/permissions/host_permissions · S3 content_scripts 注入三模块 content.js · S4 app.html 含 `iframe#moduleFrame`、三张 `[data-biz]` 卡片、无内联脚本/远程资源 · S5 `modules/<id>/app.html` 存在且模块根 manifest/background 已移除 · S6 模块关键 data JSON 就位 · S7 icons 16/32/48/128 · S8 README 非空。

### J —— jsdom 壳逻辑（无浏览器兜底）
J1 首屏（首页可见/三卡/iframe about:blank）· J2 点击 `[data-biz=patrol]`（landing 隐藏、workspace 显示、iframe 当前文档=`modules/patrol/app.html`、`hash=#/patrol`、标题/面包屑/高亮/localStorage）· J3 iframe load 后 `#frameMask.done` + 「已就绪」· J4 `[data-switch-biz=share]` 切换 · J5 `#openTabBtn` → `chrome.tabs.create(url=.../modules/share/app.html)` · J6 `#backBtn` 回首页（iframe 释放 about:blank、hash 清空）· J7 数字键 3 + Esc · J8 数字键 1 · J9 深链 `#/radar` 冷启动 · J10 jsdom 零 console.error/jsdomError。

jsdom 限制：不加载 iframe 内模块页、不渲染布局、不截图。平台壳用 `contentWindow.location.replace()` 切 iframe（不写 src 属性），jsdom 不支持真实跨文档导航——脚本用假的 `iframe.contentWindow.location` 记录目标 URL 并在断言里读取；`iframe load` 由脚本显式派发（验证的是 app.js 的 load 处理逻辑）。

### B/M/D/E/C —— 浏览器 E2E（headless Edge，1440×900）
- B1 启动 Edge + 加载扩展 · B2 扩展 ID（background service_worker 存在）· B3 打开 `chrome-extension://<id>/app.html` · B4 三卡片可见 + 「选择业务」文案 · B5 无内联脚本/事件 · B6 截图 `01-platform-home-1440.png` · B7 首页零 console error。
- M-<biz>-1..7（patrol / share / radar 各 7 项）：iframe 当前文档 `contentDocument.URL` 含 `modules/<biz>/app.html`（share 会带 `#workbench`，用 includes）· 首屏关键 DOM（patrol `#viewWorkbench/#tblBody/#statsBar`、share `#page-workbench`、radar `#viewDashboard`）· iframe 尺寸合理 · `#frameMask.done` · 关键 data JSON 均 200（主动 fetch 兜底）· 截图 `02/03/04` · 阶段零 console error · 阶段无 4xx/5xx/加载失败。
- D1 `[data-switch-biz]` 三业务齐全 · D2 返回首页 · D2b 截图 `06` · D3 首页再次进入 share · D4 `#openTabBtn` 独立标签页：新 target URL 直接是 `modules/<biz>/app.html`（产品设计：原生业务页、不带平台导航条），校验其自身页面正文/关键 DOM/零 console error，截图 `05-independent-tab-<biz>-1440.png` · D3b 浏览器后退两步：后退 1 次回上一个业务（`#/patrol`、iframe 正文非空，截图 `08`），后退 2 次回业务选择首页（三卡片可见、iframe about:blank，截图 `08b`）· D5 深链 `#/patrol` 冷启动（截图 `07`）· D6 刷新后深链保持 · D7 深链阶段零 error/网络问题。
- E1 全程 console 零 error 汇总 · E2 全程 data JSON / modules 资源无 4xx/5xx/失败。
- C0~C4 `content.js` 三份共存验证（合并最大风险点）：CDP `Fetch.enable` 拦截 `https://item.shop.example.com/*`，`Fetch.fulfillRequest` 返回本地极简商品页（不联网真实电商平台）→ 等三个 content_scripts 注入同一扩展的 isolated world → 断言 `window.__jdPatrolItemV3` / `window.__jdMarketCaptureV2` / `window.__priceRadarV1` 三个 guard 均为 true、无 `SyntaxError`/`Identifier has already been declared` 类脚本级错误、mock 页 console 干净，截图 `09-content-scripts-coexist-1440.png`。

## 产物

| 文件 | 说明 |
|---|---|
| `report.json` | 结构化报告：`verification`（时间/环境/视口/CDP 端口/扩展 ID）、59 项 `checks`（耗时/详情/错误）、`consoleErrors`、`network`、`contentCoexistence`、`knownBenign`、`productFixes`、`residualRisks`、`screenshots`、`summary` |
| `REPORT.md` | 人读报告：结论 / 验收环境与时间 / 断言明细表 / 失败项（无）/ 产品修复点 / UI 交互观察 / 截图索引 / 遗留风险 / console error / 网络 / content.js 共存验证 |
| `shots/01-platform-home-1440.png` | 首页（业务选择） |
| `shots/02-module-patrol-1440.png` | 价格巡检首屏 |
| `shots/03-module-share-1440.png` | 市占率首屏 |
| `shots/04-module-radar-1440.png` | 竞品监控首屏 |
| `shots/05-independent-tab-share-1440.png` | 独立标签页（直接打开业务原生页） |
| `shots/06-platform-home-back-1440.png` | 业务 → 返回首页 |
| `shots/07-deeplink-patrol-1440.png` | 深链 `#/patrol` 冷启动 |
| `shots/08-history-back-1440.png` | 后退 1 次：回到上一个业务「价格巡检」 |
| `shots/08b-history-back-home-1440.png` | 后退 2 次：回到业务选择首页 |
| `shots/09-content-scripts-coexist-1440.png` | 三个 content.js 共存验证（item.shop.example.com 本地 mock） |
| `shots/fail-<checkId>.png` | 失败现场截图（自动；每次运行前会清空旧的） |
| `shots/harness-selftest-share.png` | 工具链自检截图（`--selftest`） |

## 备注 / 已知非问题

- 本目录截图与 `report.json`/`REPORT.md` 为 **2026-11-10 12:13 的 59/59 正式浏览器 E2E**（v1.1.0：巡检 v1.3.4 + 三业务取价统一 + 竞品存储校验修复）；重跑 `node qa/verify.mjs` 会整体覆盖。
- 深度验收与取价矩阵的产物（`DEEP-*-REPORT.*`、`engine/**`、`shots-deep-*/**`）由各自脚本生成，与基础 E2E 相互独立。
- `modules/patrol/data/preset-settings.json`：v1.0.0 时巡检源码包没有该文件（fetch 404 被 try/catch 兜住），曾补空 `{}`；v1.1.0 起随巡检 v1.3.4 完整版带真实预置（采集节奏/巡检范围/AI 等偏好），首次安装自动预置、不覆盖已有设置，404 噪音仍为 0。
- 报告整理：`node qa/verify.mjs --render` 可在不重跑浏览器的情况下，用现有 `report.json` 重新生成 `REPORT.md`（例如补充说明后）。
- 写入范围：本目录之外不做任何修改；`lib/*.mjs` 为只读复制，未改动桌面原始插件。
