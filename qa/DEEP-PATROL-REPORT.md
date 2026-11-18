# 价格监控平台 · 深度真实浏览器验收报告（平台壳 + 巡检 v1.3.4）

- 生成时间：2026-11-10T04:39:53.875Z
- 结论：**全部通过（SKIP 项见下）**
- 断言：通过 48 · 失败 0 · 跳过 3 · 合计 51；耗时 97.5s
- console error：真实 0 条；已归类预期 1 条（见下）

## 环境

| 项 | 值 |
| --- | --- |
| 浏览器 | Edg/157.0.4341.42（C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe） |
| CDP 端口 | 9447 |
| 扩展 ID | iegegmaeojncdljmeacnkcpmjilladhd |
| 扩展目录 | ~/Desktop/三合一\价格监控平台 |
| 视口 | 1440x900 |
| Node | v24.19.0 |
| 下载目录 | ~\AppData\Local\Temp\deep-patrol-dl-fQsJjI |
| 旧版基表素材 | ~/Desktop/三合一\价格监控平台\qa\fixtures\materials\base-skus-20261109-2025.json（generatedAt=2026-11-09T20:25:06+08:00） |
| 内置基表 | 2026-11-10T10:19:24+08:00（153 行 / 146 行有 SKU） |
| 导入用 xlsx | ~/Desktop/三合一\价格监控平台\qa\fixtures\materials\SKU巡检表.xlsx |
| API 桥 | 在线 · accounts=品牌B官方自营旗舰店/品牌B大家电自营店 |

## 断言明细

| ID | 断言 | 结果 | 耗时 | 证据 / 说明 |
| --- | --- | --- | --- | --- |
| S1 | 启动 headless Edge 并加载扩展、定位扩展 ID：~/Desktop/三合一\价格监控平台 | ✅ 通过 | 3381ms | CDP 9447 · Edg/157.0.4341.42 · extId=iegegmaeojncdljmeacnkcpmjilladhd |
| S2 | 打开平台页并定位主 target，内置关键数据 JSON 均 200 | ✅ 通过 | 3319ms | target=chrome-extension://iegegmaeojncdljmeacnkcpmjilladhd/app.html · base-skus.json:60189字符 ai-config.json:254字符 preset-settings.json:486字符 |
| S3 | 下载通道就绪：页面内触发小文件下载，Browser.downloadProgress 报告已落盘 | ✅ 通过 | 3113ms | qa-download-probe.txt 17B · ~\AppData\Local\Temp\deep-patrol-dl-fQsJjI\qa-download-probe.txt |
| P1 | 业务选择页：三张业务卡片齐全可见、文案正确、上次使用标记初始隐藏 | ✅ 通过 | 9ms | patrol/share/radar · title=价格监控平台 |
| P2 | 点击首页「价格巡检」卡片：工作区显示、iframe 指向 modules/patrol/app.html、hash=#/patrol、面包屑正确 | ✅ 通过 | 547ms | iframe=patrol/app.html · hash=#/patrol · crumb=价格巡检 |
| P3 | 平台 iframe 内巡检首屏正常：4 个类目 tab（+全部）、表格 153 行、统计卡片 8 个；iframe 内切「大家电」后 53 行 | ✅ 通过 | 1074ms | tabs=全部/146 品牌A/36 大家电/51 3C店铺/43 音视频店/16 · iframe 大家电→53 行 |
| P4 | 顶部切换 [data-switch-biz=share]：iframe 切到 modules/share/app.html、hash=#/share、面包屑=市场占有率 | ✅ 通过 | 723ms | hash=#/share · iframe=share/app.html · 正文 854 字符 |
| P5 | 顶部切换 [data-switch-biz=radar]：iframe 切到 modules/radar/app.html、hash=#/radar、面包屑=竞品监控 | ✅ 通过 | 581ms | hash=#/radar · iframe=radar/app.html · 正文 631 字符 |
| P6 | 顶部「业务选择」返回首页：landing 可见、iframe 释放为 about:blank、hash 清空、竞品监控卡片带「上次使用」标记 | ✅ 通过 | 747ms | landing=可见 · frame=about:blank · 上次使用=radar |
| P7 | 首页从卡片重新进入「市场占有率」，按 Esc 返回业务选择（键盘交互） | ✅ 通过 | 1146ms | 卡片进入市占率 → Esc 回首页 |
| P8 | 首页键盘「3」直达竞品监控（快捷键 1/2/3） | ✅ 通过 | 276ms | hash=#/radar · iframe 正文 631 字符 |
| P9 | 深链 #/patrol 冷启动：直接打开 app.html#/patrol 落在价格巡检，刷新后仍在巡检 | ✅ 通过 | 5696ms | 冷启动 hash=#/patrol · 刷新后 hash=#/patrol · iframe 正文 16202 字符 |
| P10 | 「独立打开」：新标签页直接打开 modules/patrol/app.html 且首屏渲染正常 | ✅ 通过 | 805ms | 新标签页=chrome-extension://iegegmaeojncdljmeacnkcpmjilladhd/modules/patrol/app.html · 153 行 · title=【双轨版 · 轨道②】电商平台价格巡检工作台 |
| P11 | 浏览器后退：首页→巡检→市占率 后，后退 1 次回巡检（hash=#/patrol、iframe 非空），后退 2 次回业务选择 | ✅ 通过 | 4269ms | 后退1次 hash=#/patrol/crumb=价格巡检 · 后退2次 hash=""/iframe=about:blank |
| P12 | 平台壳阶段（含巡检/市占率/竞品 iframe 加载）console 零真实 error | ✅ 通过 | 1ms | 真实 error 0 · 累计 console 条目 0 |
| P13 | 平台壳关键页截图（首页 / 巡检工作区 / 独立标签页 / 后退首页） | ✅ 通过 | 4309ms | 01-platform-home / 02-platform-patrol / 03-platform-deeplink-patrol / 04-platform-independent-tab / 05-platform-history-back |
| M0 | 巡检页初始化：state/computeStats 可观测、基表 153 行、表格已渲染 | ✅ 通过 | 3ms | state 可访问 · 基表 153 行 · 表格 153 行 · 预览按钮 146 个 |
| M-SORT | 表格排序（点表头排序） | ⏭ 跳过 | 0ms | v1.3.4 产品未提供表格排序交互：DOM 中可排序表头控件 0 个；表头仅做展示。属需求范围差异，不是回归 bug，需 Lead 确认。 |
| M-PAGE | 表格分页 | ⏭ 跳过 | 0ms | v1.3.4 产品无分页组件（DOM 匹配 pager/pagination 节点 0 个），表格一次渲染全部 153 行。需 Lead 确认是否需求遗漏。 |
| M-DRAWER | 行详情 SKU 抽屉 | ⏭ 跳过 | 0ms | 产品无 SKU 抽屉交互（DOM 中抽屉节点 0 个）；行详情能力由 SKU 链接 / 改价 / 重采 / 下架 / 👁 预览入口承担，预览见 M29。 |
| M1 | 巡检首屏：双轨徽标/标题、5 个类目 tab（含数量）、8 个统计卡片、基表信息=内置 153 行、AI/API 状态 chip | ✅ 通过 | 16ms | tabs=全部·146 品牌A·36 大家电·51 3C店铺·43 音视频店·16 · chips=8 · baseInfo=基表：4 个类目 · 153 行 · 146 行有 SKU · 生成于 11-10 10:19｜当前使用：内置基表 · AI=AI 已就绪 · deepseek-flash · API=官方API 已连接 · 2 个账号 |
| M2 | 4 个类目 tab 切换：类目名/行数与基表一致，首行类目正确，最后切回「全部」153 行 | ✅ 通过 | 348ms | 品牌A:36 · 大家电:53 · 3C店铺:48 · 音视频店:16 · 全部→153 |
| M3 | 总览页：12 个数字卡片逐一点击筛选（active/hint/行数/空状态），再点一次回到全部；类目筛选 + 清除筛选 | ✅ 通过 | 10364ms | 12 卡片逐一点击 ✓（全部行=153 普惠已采集=0 会员已采集=0 低于阈值=0 高于/等于阈值=0 偏离阈值=0 需人工确认=0 手动改价=0 采集失败=0 未采集=146 待补 SKU=7 已下架=0）· 类目筛选/清除筛选 ✓ |
| M4 | 工作台搜索与状态筛选：SKU 精确搜索 1 行、型号搜索多行、无结果空状态、待补 SKU 7 行、全部 153 行 | ✅ 通过 | 3162ms | SKU 搜索 1 行 · 型号搜索 10 行 · 无结果空状态 ✓ · 待补 7 行 · 全部 153 行 |
| M5 | 行勾选：全选 146 行→「重采选中 (146)」、取消→恢复；单行勾选→「重采选中 (1)」 | ✅ 通过 | 1626ms | 全选=重采选中 (146) · 取消=重采选中 · 单行=重采选中 (1) |
| M6 | 手动改价（普惠列）：大家电 100274532085 改为 ¥4000 → 状态/统计/采集记录正确 | ✅ 通过 | 961ms | toast=已手动保存 ¥4,000 · capture=4000/manual · 手动改价1 · 低于阈值1 · 行状态=低于阈值 |
| M7 | 手动改价（第二行）：3C店铺 100170086647 改为 ¥4500 → 手动改价 2、普惠已采集 2 | ✅ 通过 | 956ms | capture=4500/manual · 手动改价2 · 普惠已采集2/146 |
| M8 | 同品比价：15 组 / 30 SKU；全部/只看有差异(1组,差¥500)/只看待采齐 切换；导出比价 CSV 真实落盘且内容正确 | ✅ 通过 | 2977ms | summary=同款分组 15 组（大家电 / 3C店铺）｜共 30 个 SKU｜有差异 1 组｜一致 0 组｜待采齐 15 组 · 全部 15 组 · 有差异 1 组(差¥500) · 待采齐 15 组 · CSV=2.7KB |
| M9 | 「采集全部比价 SKU」弹窗：提示 15 组 / 30 个 SKU，含账号+轨道选择，取消后无副作用 | ✅ 通过 | 46ms | hint=一键采集比价产品：15 组同款 / 30 个 SKU（两个店铺都算）。 请选择用哪个账号（普惠 / 会员）和哪条轨道采集；选中账号后请确认浏览器当前登录的就是该账号。 · 账号 util/plus · 轨道 background/foreground · 取消无副作用 |
| M10 | 管理基表弹窗：4 类目 tab（+全部）、首类目 36 行、导出基表 JSON 真实落盘（4 类目/153 行/146 有 SKU） | ✅ 通过 | 2370ms | 类目 tab=全部·153 品牌A·36 大家电·53 3C店铺·48 音视频店·16 · 首类目 36 行 · 导出 61.9KB |
| M11 | 导入基表（上一步导出的 JSON，与当前一致）：confirm 展示 4 类目/153 行，alert 提示无变化，基表仍 153 行 | ✅ 通过 | 885ms | confirm=4类目/153行 · alert=完全一致 · baseInfo=基表：4 个类目 · 153 行 · 146 行有 SKU · 生成于 11-10 12:39｜当前使用：SKU巡检表-基表备份-20261110.json的基表（保存于 11-10 12:39） |
| M12 | 导入基表（真实 SKU巡检表.xlsx）：confirm 展示 154 行，alert 展示变化明细，导入后 154 行生效 | ✅ 通过 | 1278ms | confirm=154行 · alert=基表已导入并生效。 会员阈值 1 处、型号 1 处 变化明细： · 100326999922（会员阈值）：13959 → 12439 · 100326999922（型号）：SH86CAB+MT81 → SH86CAB(MT81A) · 100326999922（套餐）：空 → SH86双系统单机 · toast=基表已导入：4 个类目 · 154 行 · 146 行有 SKU；会员阈值 1 处、 |
| M13 | 「恢复内置」：confirm 后基表回到内置 153 行，baseInfo 显示「内置基表」 | ✅ 通过 | 592ms | baseInfo=基表：4 个类目 · 153 行 · 146 行有 SKU · 生成于 11-10 10:19｜当前使用：内置基表 |
| M14 | 设置弹窗：取消不保存；改 batch/间隔/跳过今天/预览延迟/偏离阈值 + patrolMode 后保存，重开与刷新后值都在 | ✅ 通过 | 3836ms | 取消不保存 ✓ · 保存重开 ✓ · 刷新后 batch=5/delay=2-4/preview=800/dev=600-1600 |
| M15 | 「AI 设置」按钮打开设置弹窗：AI 接口/模型/Key/复核模式已预配置（不发起外部 AI 请求） | ✅ 通过 | 703ms | AI 接口预配置 · 模型=deepseek-flash · Key 长度=35 · 复核=fallback |
| M16 | 双轨切换：点「轨道①」→ 徽标/标题/正文 class 切到后台标签页；点「轨道②」切回 | ✅ 通过 | 1030ms | 轨道① 徽标=双轨版 · 轨道① · 后台标签页 · 轨道② 徽标=双轨版 · 轨道② · 前台窗口+AI复核 |
| M17 | 下架/恢复：100230282311 下架后从默认表隐藏、统计「已下架 1 行」、筛选已下架可见并可恢复 | ✅ 通过 | 2347ms | 下架 toast=已移入下架库：100230282311（下次巡检不会出现，可在「已下架」里恢复） · 已下架1行 · 恢复 toast=已恢复：100230282311 · 状态已清空 |
| M18 | 导出 CSV 与导出 JSON：真实下载落盘；CSV 表头/153 行/含手动改价；JSON 含 captures/settings/rows | ✅ 通过 | 1658ms | CSV=14.9KB/154 行 · JSON=41.6KB captures=2 rows=153 |
| M19 | 清空采集：confirm 文案正确、清空前自动下载 JSON 备份、清空后采集数与「手动改价」统计归零 | ✅ 通过 | 1339ms | confirm ✓ · 自动备份 41.6KB（captures=2）· 清空后 captures=0 |
| M20 | 导入数据：用 M18 导出的 JSON 通过 DOM.setFileInputFiles 回导，confirm 后 2 个 SKU 采集记录与手动改价恢复 | ✅ 通过 | 1494ms | toast=已导入巡检数据：2 个 SKU · captures=2 · 手动改价2 · 价格 ¥4,000 改 手动 · 11-10 12:39 低 ¥99 |
| M21 | 导入数据负例：导入非法 JSON 时 alert 明确报错且现有采集数据不受影响 | ✅ 通过 | 562ms | alert=JSON 解析失败：Expected property name or '}' in JSON at position 2 (line 1 column 3) · captures 仍为 2 |
| M22 | 总览复检（普惠已采集 2/146、手动改价 2、低于阈值 1）→ 手动改价筛选 2 行 → 汇总选中 → 导出待上报 Excel（xlsx 落盘）→ 清空待上报 | ✅ 通过 | 3594ms | 卡片复检 ✓ · 手动改价 2 行 · 待上报 1 条 · xlsx=4.9KB · 已清空待上报 |
| M23 | 「普惠号巡检」确认弹窗：展示 SKU 数与采集方式，取消后不进入运行态（不发起真实外部采集） | ✅ 通过 | 1084ms | confirm=开始【普惠账号】巡检 本次 SKU：5 个 预计耗时：约 1 分钟 采集方式：前台小窗逐个打开商品页读取价格（每单约 10–20 秒，采集期间不要用电脑） 请先确认：当前 Edge 登录的是【普通/普惠】账号，并且能正常打开电商平台商品页。 确 · 取消后 running=false · 未打开电商平台页 |
| M24 | 多供应商 API 账号区：桥状态 chip、账号行、刷新、新增供应商行、空保存提示（不写入真实凭据） | ✅ 通过 | 2690ms | chip=官方API 已连接 · 2 个账号 · 初始账号行=2 · 新增后=3 · 空保存 toast=新增供应商账号需要填完整的账号名 / appKey / appSecret / accessToken |
| M25 | API 桥未连接分支：把官方API地址改为不可达端口后，账号区显示「API 桥未连接」且应用不崩（浏览器网络日志已归类） | ✅ 通过 | 4099ms | 未连接提示=API 桥未连接：Failed to fetch（确认“启动API桥.py”在运行） · 页面无脚本错误框 · 已恢复地址=http://127.0.0.1:18765 |
| M26 | 基表自动升级：从平台首页写入旧 generatedAt 基表(2026-11-09T20:25:06+08:00) + 下架/改价状态 → 进巡检页提示「内置基表已更新」、153 行、状态保留 | ✅ 通过 | 4992ms | toast=内置基表已更新（11-10 10:19），已下架 / 手动改价状态已保留 · from=2026-11-09T20:25:06+08:00 → to=2026-11-10T10:19:24+08:00 · 153 行 · captures=1 · 已下架1/手动改价1 · 已下架行=100230282311 |
| M27 | 「帮助」弹窗：使用说明条目完整（≥15 条）并可关闭 | ✅ 通过 | 157ms | 标题=使用说明 · 17 条 · 关闭 ✓ |
| M28 | 管理基表：新增一行→保存修改 154 行生效（当前使用=手动管理）→ 恢复内置回 153 行 | ✅ 通过 | 2695ms | 新增行 36→37 · 保存 toast=基表已保存：4 个类目 · 154 行 · 146 行有 SKU（已保存到本机） · 恢复内置 153 行 |
| M29 | 行预览「👁」悬停：创建商品页预览小窗（chrome.windows.create），随后关闭 | ✅ 通过 | 0ms | 预览窗口 target=https://item.shop.example.com/100307302352.html |
| M30 | 巡检关键页截图：工作台（含容器/统计）、双轨运行条、总览、设置 | ✅ 通过 | 4043ms | 10-patrol-workbench / 11-patrol-settings-ai / 12-patrol-overview / 13-patrol-base-upgrade / 14-patrol-compare / 15-patrol-settings |
| M31 | 巡检全程 console 零真实 error、无未捕获异常（预期的网络日志已归类并在报告说明） | ✅ 通过 | 0ms | 真实 error 0；归类预期网络日志 1 条 · 未捕获异常 0 · console 条目 0 |

## 跳过项与原因（不计入失败）

- **M-SORT** 表格排序（点表头排序）：v1.3.4 产品未提供表格排序交互：DOM 中可排序表头控件 0 个；表头仅做展示。属需求范围差异，不是回归 bug，需 Lead 确认。
- **M-PAGE** 表格分页：v1.3.4 产品无分页组件（DOM 匹配 pager/pagination 节点 0 个），表格一次渲染全部 153 行。需 Lead 确认是否需求遗漏。
- **M-DRAWER** 行详情 SKU 抽屉：产品无 SKU 抽屉交互（DOM 中抽屉节点 0 个）；行详情能力由 SKU 链接 / 改价 / 重采 / 下架 / 👁 预览入口承担，预览见 M29。

## console error 汇总

- 真实 console error：**0 条**。

- 已归类的预期日志（浏览器级网络错误，非 JS 异常 / 非产品未捕获错误）：
  - `[log.error] Failed to load resource: net::ERR_CONNECTION_REFUSED` —— API 桥未连接分支：页面按设计去探测了不可达地址，Chromium 自身打印 net::ERR_CONNECTION_REFUSED；应用已 catch 并显示「API 桥未连接」，非 JS 未捕获错误。

## 下载件（真实落盘）

- qa-download-probe.txt · completed · 17B · `~\AppData\Local\Temp\deep-patrol-dl-fQsJjI\qa-download-probe.txt`
- 同品比价-20261110.csv · completed · 2.7KB · `~\AppData\Local\Temp\deep-patrol-dl-fQsJjI\同品比价-20261110.csv`
- SKU巡检表-基表备份-20261110.json · completed · 61.9KB · `~\AppData\Local\Temp\deep-patrol-dl-fQsJjI\SKU巡检表-基表备份-20261110.json`
- SKU巡检表-巡检结果-20261110.csv · completed · 14.9KB · `~\AppData\Local\Temp\deep-patrol-dl-fQsJjI\SKU巡检表-巡检结果-20261110.csv`
- SKU巡检表-巡检数据-20261110.json · completed · 41.6KB · `~\AppData\Local\Temp\deep-patrol-dl-fQsJjI\SKU巡检表-巡检数据-20261110.json`
- SKU巡检表-巡检数据-20261110.json · completed · 41.6KB · `~\AppData\Local\Temp\deep-patrol-dl-fQsJjI\SKU巡检表-巡检数据-20261110.json`
- SKU巡检表-待上报-20261110.xlsx · completed · 4.9KB · `~\AppData\Local\Temp\deep-patrol-dl-fQsJjI\SKU巡检表-待上报-20261110.xlsx`

## 截图

- `03-platform-deeplink-patrol.png` —— 深链 #/patrol 冷启动 + 刷新后
- `04-platform-independent-tab.png` —— 平台「独立打开」新标签页（巡检模块页）
- `05-platform-history-back.png` —— 浏览器后退：回到业务选择首页
- `01-platform-home.png` —— 业务选择首页（三业务卡片）
- `02-platform-patrol.png` —— 平台壳内嵌价格巡检
- `11-patrol-settings-ai.png` —— 巡检设置弹窗（AI 已预配置 + 官方API账号区）
- `12-patrol-overview.png` —— 总览页（12 数字卡片 + 待上报区/筛选）
- `13-patrol-base-upgrade.png` —— 基表自动升级提示（内置基表已更新）+ 状态保留
- `10-patrol-workbench.png` —— 巡检工作台（表格/统计/工具栏/运行条）
- `14-patrol-compare.png` —— 同品比价页
- `15-patrol-settings.png` —— 巡检设置弹窗

## 需 Lead 判断的点 / 风险

### 任务清单中的「表格排序 / 分页 / SKU 抽屉」在巡检 v1.3.4 中不存在（需求范围差异，非回归 bug）

任务描述要求覆盖「表格排序/分页」「行详情（SKU 抽屉）」，但巡检 v1.3.4 的产品 UI 与源码都没有这些交互：
- app.html 表头（15 列）没有任何排序控件 / aria-sort / data-sort；app.js 里只有同品比价分组排序（compareEntries）与对象键排序，没有表格排序逻辑；
- 没有分页器组件，工作台一次渲染全部 153 行（同品比价最多渲染 400 组并提示导出查看）；
- 没有 SKU 侧边抽屉，行详情能力由 SKU 链接、「改」手动改价、「重采」、「下架/恢复」、👁 预览入口承担。
本次已把这三项记为 SKIP（不计通过、不作为失败），并实际覆盖了替代交互（手动改价/重采弹窗/下架恢复/预览）。请 Lead 确认是否属于需求遗漏。

最小复现：
```
打开 modules/patrol/app.html：document.querySelectorAll('.tbl th[data-sort], th[aria-sort]').length === 0；无 pager 节点；表格一次渲染 153 行。
```

### 「API 桥未启动」时浏览器控制台会产生 1 条 net::ERR_CONNECTION_REFUSED 网络日志（浏览器级，非 JS 异常）

M25 把「官方API地址」指向不可达端口，页面按设计去 fetch 探测：loadApiAccountInfo() 的失败被 catch，界面正确显示「API 桥未连接：Failed to fetch（确认“启动API桥.py”在运行）」，页面无脚本错误框、无未捕获异常。
唯一新增 console error 是 Chromium 对失败请求打印的 `Failed to load resource: net::ERR_CONNECTION_REFUSED`（Log.entryAdded，url=http://127.0.0.1:18799/api/accounts），这条日志由浏览器产生、页面 JS 无法抑制。本次已单独归类并在报告说明，不计为产品 bug；若验收要求控制台绝对零 error，需要接受该网络日志或改为非 fetch 探测方案（例如由 background 通过 chrome.runtime 消息探测）。

最小复现：
```
设置 → 官方API地址改为 http://127.0.0.1:18799 → 保存 → 重开设置；控制台出现 1 条 net::ERR_CONNECTION_REFUSED（URL 可在 DevTools Network/Console 看到）。
```

## 备注

- 真实电商平台采集未执行：真实采集需要登录普惠/PLUS 电商平台账号并会逐个打开真实商品页，属外部依赖与业务动作；本次只验证运行入口确认弹窗的取消路径（M23）与采集相关设置/轨道 UI，不发起外部采集、不写入任何电商平台账号。
- 同品比价使用内置基表的真实数据（15 组 / 30 SKU）；通过两行手动改价造出 1 组 ¥500 差异，验证「只看有差异」与导出比价 CSV。
- 基表自动升级测试从「平台首页」写入 chrome.storage.local：若在巡检页内直接写 patrol.base.v1，页面自身的 storage.onChanged 监听会先就地升级并把旧内存库写回，属于测试姿势问题；从首页写入后进巡检页，才是「扩展更新后首次打开」的真实升级路径。
- 导入用 SKU巡检表.xlsx 比内置基表多 1 行（154 vs 153，SKU 数同为 146）；导入差异提示正确列出 1 处会员阈值 + 型号/套餐变化，说明「自动升级+差异提示」链路有效。
- 预览小眼睛在 headless 下也能真实创建 chrome.windows.create 预览窗口（target=item.shop.example.com），已随测试关闭；未点击「测试 AI」，避免发起外部 AI 请求。

---

验收口径：每条断言都要求关键 UI 有实际反馈；console error 除「故意指向不可达 API 桥」时浏览器自身产生的 net::ERR_CONNECTION_REFUSED 网络日志外，任何新增 error 均记失败。SKIP 项为产品确实不存在的交互，不虚报通过。
