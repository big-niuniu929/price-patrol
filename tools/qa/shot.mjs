#!/usr/bin/env node
// 截图脚本：用 CDP 驱动 headless Edge 打开工作台，遍历四个页面各截一张 1440×900 PNG。
//
// 两种模式：
//   1) 扩展模式（默认）：--load-extension 加载 <repo>/extension，从 /json/list 动态找扩展 ID，
//      再打开 chrome-extension://<id>/app.html（真实 chrome.storage 环境，种子库自动导入）。
//   2) 任意 URL 模式：--url <http(s)://...|file:///...>，不加载扩展，用于验证脚本本身或截其他页面。
//
// 用法（在仓库根目录）：
//   node tools/qa/shot.mjs                          # 默认：扩展 + 导入 4 个真实榜单 + 四页截图
//   node tools/qa/shot.mjs --no-import              # 只截首屏（lib 未就绪/不想导入数据时）
//   node tools/qa/shot.mjs --url file:///C:/tmp/demo.html --single
//   node tools/qa/shot.mjs --help
//
// 产物：docs/shots/01-workbench.png、02-library.png、03-stats.png、04-settings.png（深色主图）
//       + 05-workbench-light.png（v2.1 浅色主题）
//       + 06-overview.png（v2.1.3 配对总览页）、07-workbench-visible.png（v2.1.3 1344×756 首屏可见配对表）
//       + _meta.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  launchBrowser, findExtensionId, findPageTarget, createPageTarget, PageSession, sleep, EDGE_CANDIDATES,
} from './lib/cdp.mjs';
import { PAGES, detectNav, clickNav, clickStableNav, waitPageVisible } from './lib/nav.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const DATA_DIR = '~/Desktop/资料';

const DEFAULT_REPORTS = [
  '11月-会议平板.xlsx',
  '11月-会议电视.xlsx',
  '11月-教育教学一体机.xlsx',
  'tangpingnature_商品榜单_热销排名_离线_汇总下载_2026-10-01_2026-10-31.xlsx',
];

function parseArgs(argv) {
  const opts = {
    ext: null,
    url: null,
    out: path.join(ROOT, 'docs', 'shots'),
    browser: null,
    width: 1440,
    height: 900,
    import: true,
    analyze: ['分析补数', '分析匹配', '分析', '开始分析'],
    single: false,
    settleMs: 1500,
    waitMs: 1200,
    waitFor: null,
    keepOpen: false,
    json: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--ext') opts.ext = path.resolve(next());
    else if (a === '--url') opts.url = next();
    else if (a === '--out') opts.out = path.resolve(next());
    else if (a === '--browser') opts.browser = next();
    else if (a === '--width') opts.width = Number(next());
    else if (a === '--height') opts.height = Number(next());
    else if (a === '--no-import') opts.import = false;
    else if (a === '--single') opts.single = true;
    else if (a === '--settle') opts.settleMs = Number(next());
    else if (a === '--wait-ms') opts.waitMs = Number(next());
    else if (a === '--wait-for') opts.waitFor = next();
    else if (a === '--keep-open') opts.keepOpen = true;
    else if (a === '--json') opts.json = path.resolve(next());
    else if (a === '--files') opts.files = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else throw new Error(`未知参数：${a}（--help 查看用法）`);
  }
  if (!opts.ext && !opts.url) opts.ext = path.join(ROOT, 'extension');
  return opts;
}

function printHelp() {
  console.log(`截图脚本（CDP + headless Edge）

用法：
  node tools/qa/shot.mjs [选项]

选项：
  --ext <目录>       加载的扩展目录（默认 <repo>/extension）
  --url <地址>       任意页面模式：不加载扩展，直接打开该 URL
  --out <目录>       截图输出目录（默认 docs/shots）
  --browser <路径>   浏览器可执行文件（默认自动找 Edge）
  --width/--height   视口尺寸（默认 1440×900）
  --no-import        不导入榜单文件（lib 未就绪时用）
  --files a,b,c      导入的 xlsx 文件（默认资料目录下 4 个真实榜单）
  --single           只截当前页，不遍历四页
  --wait-for <expr>  页面就绪等待的 JS 表达式（默认自动等待）
  --settle <ms>      导航后额外等待（默认 1500）
  --wait-ms <ms>     切页后等待（默认 1200）
  --keep-open        截图完保留浏览器（调试用；Ctrl+C 结束）
  --json <路径>      把截图/控制台结果写成 JSON

说明：脚本只负责截图与记录 console 错误，不修改 extension/ 下任何文件。`);
}

async function collectDiagnostics(page) {
  return await page.evaluate(`(() => ({
    title: document.title,
    readyState: document.readyState,
    bodyLength: document.body ? document.body.innerText.length : 0,
    tables: document.querySelectorAll('table').length,
    tbodyRows: document.querySelectorAll('tbody tr').length,
    buttons: Array.from(document.querySelectorAll('button')).slice(0, 40).map((b) => (b.textContent || '').trim().slice(0, 20)),
    fileInputs: document.querySelectorAll('input[type=file]').length,
    bodyHead: document.body ? document.body.innerText.slice(0, 500) : '',
  }))()`);
}

// 截图前强制隐藏 toast（主题切换/导入完成等提示会遮挡右下角），保证交付截图干净
async function hideToast(page) {
  try {
    await page.evaluate(`(() => {
      const el = document.getElementById('toast');
      if (el) { el.classList.add('hidden'); el.textContent = ''; }
      return true;
    })()`);
  } catch { /* ignore */ }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const report = { mode: opts.url ? 'url' : 'extension', out: opts.out, shots: [], consoleErrors: [], warnings: [], diag: null };
  let browser = null;
  let page = null;
  try {
    fs.mkdirSync(opts.out, { recursive: true });
    if (opts.browser && !fs.existsSync(opts.browser)) throw new Error(`浏览器路径不存在：${opts.browser}`);
    if (!opts.browser) {
      const hit = EDGE_CANDIDATES.find((p) => fs.existsSync(p));
      if (!hit) throw new Error('找不到 Edge/Chrome，请用 --browser 指定');
      opts.browser = hit;
    }
    if (opts.url) {
      console.log(`[shot] URL 模式：${opts.url}`);
      browser = await launchBrowser({ browser: opts.browser, width: opts.width, height: opts.height, startupUrl: opts.url });
      const target = await findPageTarget(browser.port);
      page = await new PageSession(target.wsUrl).connect();
      await page.setViewport(opts.width, opts.height);
      // 页面在启动参数里已开始加载，等它稳定即可
      try { await page.waitFor('document.readyState === "complete"', { timeoutMs: 30000, label: '页面加载' }); } catch { /* 继续 */ }
      await sleep(opts.settleMs);
    } else {
      const extDir = path.resolve(opts.ext);
      if (!fs.existsSync(path.join(extDir, 'manifest.json'))) {
        throw new Error(`扩展目录缺少 manifest.json：${extDir}\n（如果 extension/ 还没实现，先用 --url 模式验证脚本，或 --no-import + 任意本地 html）`);
      }
      console.log(`[shot] 扩展模式：${extDir}`);
      browser = await launchBrowser({ browser: opts.browser, extDir, width: opts.width, height: opts.height });
      const extId = await findExtensionId(browser.port);
      console.log(`[shot] 扩展 ID：${extId}`);
      const pageUrl = `chrome-extension://${extId}/app.html`;
      let target = null;
      try { target = await findPageTarget(browser.port, 5000); } catch { /* 兜底新建 */ }
      const wsUrl = target ? target.wsUrl : (await createPageTarget(browser.port, pageUrl)).wsUrl;
      page = await new PageSession(wsUrl).connect();
      await page.setViewport(opts.width, opts.height);
      await page.navigate(pageUrl, { settleMs: opts.settleMs });
      // 扩展页首次打开要导种子库/初始化，多等一会儿
      await sleep(1200);
    }

    // 等首屏渲染
    if (opts.waitFor) {
      await page.waitFor(opts.waitFor, { timeoutMs: 30000, label: opts.waitFor });
    } else {
      try {
        await page.waitFor('document.readyState === "complete" && document.body && document.body.innerText.trim().length > 20', { timeoutMs: 20000, label: '首屏渲染' });
      } catch (err) {
        report.warnings.push(`首屏等待超时（继续截图）：${err.message}`);
      }
    }
    await sleep(800);

    // 导入真实榜单（扩展模式且未禁用）
    if (!opts.url && opts.import) {
      const explicit = opts.files ? opts.files : DEFAULT_REPORTS.map((f) => path.join(DATA_DIR, f));
      const files = explicit.filter((f) => fs.existsSync(f));
      const missing = explicit.filter((f) => !fs.existsSync(f));
      if (missing.length) report.warnings.push(`缺少榜单文件（已跳过）：${missing.join('、')}`);
      if (files.length) {
        try {
          const hasInput = await page.evaluate('!!document.getElementById("reportFileInput")');
          if (!hasInput) {
            report.warnings.push('页面没有 #reportFileInput，跳过导入');
          } else {
            await page.setFileInputs('#reportFileInput', files);
            console.log(`[shot] 已选择 ${files.length} 个榜单文件`);
            // app.js 导入后会自动分析；等榜单数与分析完成
            try {
              await page.waitFor(
                `window.__workbench && window.__workbench.getKpis && window.__workbench.getKpis().reports >= ${files.length}`,
                { timeoutMs: 30000, label: '榜单导入+自动分析' },
              );
            } catch { report.warnings.push('等待榜单导入超时（继续截图）'); }
            // 再点一次「分析补数」（幂等），确保统计基于最新分析
            const clickedAnalyze = await page.evaluate(`(() => { const el = document.getElementById('analyzeBtn'); if (!el) return false; el.click(); return true; })()`);
            if (!clickedAnalyze) { try { await page.evaluate('window.__workbench.analyze()'); } catch { /* ignore */ } }
            try {
              await page.waitFor('document.querySelectorAll("#matchBody tr").length > 0', { timeoutMs: 25000, label: '配对表渲染' });
            } catch { report.warnings.push('配对表渲染等待超时（继续截图）'); }
            await sleep(1200);
            try {
              report.kpis = await page.evaluate('window.__workbench && window.__workbench.getKpis ? window.__workbench.getKpis() : null');
              console.log('[shot] KPI：', JSON.stringify(report.kpis).slice(0, 320));
            } catch { /* ignore */ }
            try {
              report.runtimeErrors = await page.evaluate('window.__workbench && window.__workbench.runtimeErrors ? window.__workbench.runtimeErrors.slice(0, 20) : []');
            } catch { /* ignore */ }
          }
        } catch (err) {
          report.warnings.push(`导入榜单失败（继续截图）：${err.message}`);
        }
      }
    }

    // 清理导入/分析日志：日志面板无内容时会自动隐藏，工作台截图更干净
    if (!opts.url) {
      try {
        await page.evaluate(`(() => { const el = document.getElementById('clearLogBtn'); if (el) el.click(); return !!el; })()`);
        await sleep(500);
      } catch { /* ignore */ }
    }

    // v2.1：深色 4 张为交付主图 —— 先确保切到深色（主题 auto 在 headless 下可能解析为浅色）
    if (!opts.url) {
      try {
        let theme = await page.evaluate('document.documentElement.dataset.theme || ""');
        for (let i = 0; i < 2 && theme !== 'dark'; i += 1) {
          await page.evaluate(`(() => { const el = document.getElementById('themeToggleBtn'); if (el) el.click(); return !!el; })()`);
          await sleep(600);
          theme = await page.evaluate('document.documentElement.dataset.theme || ""');
        }
        report.darkTheme = theme;
        if (theme !== 'dark') report.warnings.push('未能切到深色主题（01~04 可能为浅色）');
      } catch (err) {
        report.warnings.push(`切换深色主题失败：${err.message}`);
      }
    }

    // 先截一张「首屏/工作台」
    await hideToast(page);
    const firstPath = path.join(opts.out, '01-workbench.png');
    await page.screenshot(firstPath);
    report.shots.push(firstPath);
    console.log(`[shot] ${firstPath}`);

    // 找导航并遍历剩余三页
    if (!opts.single) {
      let nav = {};
      try { nav = await detectNav(page) || {}; } catch (err) { report.warnings.push(`导航检测失败：${err.message}`); }
      console.log('[shot] 导航检测：', Object.keys(nav).length ? JSON.stringify(nav) : '未找到（只截当前页）');
      for (const p of PAGES) {
        if (p.key === 'workbench') continue; // 首屏已截
        // 优先用稳定入口 .nav-btn[data-page-target]，再退回自动检测/文案
        let ok = await clickStableNav(page, p.key);
        if (!ok && nav[p.key]) ok = await clickNav(page, nav[p.key].idx);
        if (!ok) ok = !!(await page.clickByText(p.names, { selector: 'button, a, [role="tab"], .tab, .nav-item, li', exact: false }));
        if (!ok) {
          report.warnings.push(`没找到「${p.names[0]}」页入口，跳过 ${p.file}`);
          continue;
        }
        const visible = await waitPageVisible(page, p.key, 8000);
        if (!visible) report.warnings.push(`「${p.names[0]}」页未确认可见（继续截图）`);
        await sleep(opts.waitMs);
        // 统计看板：点一次「刷新统计」，等类目表渲染
        if (p.key === 'stats') {
          try {
            await page.evaluate(`(() => { const el = document.getElementById('refreshStatsBtn'); if (el) el.click(); return !!el; })()`);
            await page.waitFor('(() => { const el = document.getElementById("storeStats"); return el && el.innerText.trim().length > 10; })()', { timeoutMs: 10000, label: '统计渲染' });
          } catch { report.warnings.push('统计看板渲染等待超时（继续截图）'); }
          await sleep(500);
        }
        // 匹配库：等 SKU 表格渲染
        if (p.key === 'library') {
          try {
            await page.waitFor('document.querySelectorAll("#libBody tr").length > 0', { timeoutMs: 10000, label: '匹配库表格渲染' });
          } catch { report.warnings.push('匹配库表格渲染等待超时（继续截图）'); }
          await sleep(600);
        }
        // v2.1.3 总览页：等全量配对表渲染
        if (p.key === 'overview') {
          try {
            await page.waitFor('document.querySelectorAll("#overviewBody tr").length > 0', { timeoutMs: 10000, label: '总览表格渲染' });
          } catch { report.warnings.push('总览页表格渲染等待超时（继续截图）'); }
          await sleep(800);
        }
        const shotPath = path.join(opts.out, p.file);
        await hideToast(page);
        await page.screenshot(shotPath);
        report.shots.push(shotPath);
        console.log(`[shot] ${shotPath}`);
      }
    }

    // v2.1.3 布局验收截图：1344×756 首屏可见配对表 ≥6 行（DESIGN §18.3）
    if (!opts.url) {
      try {
        await clickStableNav(page, 'workbench');
        await waitPageVisible(page, 'workbench', 8000);
        await page.setViewport(1344, 756);
        await sleep(opts.waitMs);
        await hideToast(page);
        const visible = await page.evaluate(`(() => {
          const body = document.getElementById('matchBodyRows');
          if (!body) return 0;
          const vh = window.innerHeight;
          return Array.from(body.querySelectorAll('tr')).filter((tr) => {
            const r = tr.getBoundingClientRect();
            return r.height > 0 && r.top >= 0 && r.top + Math.min(r.height, 12) <= vh;
          }).length;
        })()`);
        const visiblePath = path.join(opts.out, '07-workbench-visible.png');
        await page.screenshot(visiblePath);
        report.shots.push(visiblePath);
        report.visibleRows1344 = visible;
        if (visible < 6) report.warnings.push(`1344×756 首屏配对表仅 ${visible} 行（预期 ≥6）`);
        console.log(`[shot] ${visiblePath}（1344×756 可见配对行 ${visible}）`);
        await page.setViewport(1440, 900);
        await sleep(500);
      } catch (err) {
        report.warnings.push(`1344×756 布局截图失败：${err.message}`);
      }
    }

    // v2.1.4 匹配库核验截图（DESIGN §19.5）：08 入库状态四色、09 确认写入
    if (!opts.url) {
      try {
        await clickStableNav(page, 'workbench');
        await waitPageVisible(page, 'workbench', 8000);
        await sleep(opts.waitMs);
        await hideToast(page);
        const statePath = path.join(opts.out, '08-workbench-libstates.png');
        await page.screenshot(statePath);
        report.shots.push(statePath);
        const libStates = await page.evaluate(`(() => {
          const wb = window.__workbench;
          if (!wb || typeof wb.getLibraryStates !== 'function') return null;
          return wb.getLibraryStates();
        })()`);
        report.libStates = libStates;
        console.log(`[shot] ${statePath}（libState ${JSON.stringify(libStates)}）`);
        // 09 确认写入：模拟采集 1 条新 SKU → pending → 确认写入后截图（若 API 可用）
        const confirmable = await page.evaluate(`(async () => {
          const wb = window.__workbench;
          if (!wb || typeof wb.confirmLibraryWrite !== 'function' || typeof wb.simulateCaptures !== 'function') return { skipped: 'API 未就绪' };
          const rows = (wb.state.session.reports || []).flatMap((r) => r.rows || []);
          const target = rows.find((r) => r.libState === 'new' && r.sku) || rows.find((r) => r.sku);
          if (!target) return { skipped: '没有可用行' };
          wb.simulateCaptures({ [target.sku]: { sku: target.sku, prices: { hand: 5555 }, priceKind: 'hand', sizeInch: 75, sizeText: '75英寸', samples: [{ price: 5550, kind: 'hand' }, { price: 5560, kind: 'hand' }], candidateCount: 2, candidates: [{}, {}], at: new Date().toISOString() } });
          await new Promise((r) => setTimeout(r, 700));
          const res = await wb.confirmLibraryWrite([target.sku]);
          await new Promise((r) => setTimeout(r, 600));
          return { sku: target.sku, res };
        })()`);
        report.confirmWrite = confirmable;
        await sleep(500);
        const confirmPath = path.join(opts.out, '09-confirm-write.png');
        await hideToast(page);
        await page.screenshot(confirmPath);
        report.shots.push(confirmPath);
        console.log(`[shot] ${confirmPath}（${JSON.stringify(confirmable)}）`);
        if (confirmable.skipped) report.warnings.push(`09 确认写入截图跳过：${confirmable.skipped}`);
      } catch (err) {
        report.warnings.push(`v2.1.4 核验截图失败：${err.message}`);
      }
    }

    // v2.1.5 截图（DESIGN §20.12）：10 列筛选/列设置、11 匹配库操作日志、12 已确认
    if (!opts.url) {
      try {
        // 10：工作台列设置/表头筛选
        await clickStableNav(page, 'workbench');
        await waitPageVisible(page, 'workbench', 8000);
        await sleep(500);
        const colOpen = await page.evaluate(`(() => {
          const menu = document.getElementById('matchColumnMenu') || document.querySelector('[data-column-settings]');
          if (menu) { menu.click(); return 'column-menu'; }
          const filterBtn = document.querySelector('#matchBody thead [data-col-filter], #matchBody thead .th-filter, #matchBody thead .col-filter-btn');
          if (filterBtn) { filterBtn.click(); return 'header-filter'; }
          return '';
        })()`);
        await sleep(700);
        const colPath = path.join(opts.out, '10-workbench-colfilter.png');
        await page.screenshot(colPath);
        report.shots.push(colPath);
        report.columnUi = colOpen || '未实现';
        console.log(`[shot] ${colPath}（列设置/筛选：${colOpen || '未实现'}）`);
        if (!colOpen) report.warnings.push('10 列筛选截图：未找到列设置/表头筛选按钮（可能尚未接线）');
        await page.evaluate(`(() => { document.body.click(); const panel = document.querySelector('[data-column-panel], .column-panel, #colFilterPanel, .col-filter-panel'); if (panel) { const close = panel.querySelector('[data-close], .close'); if (close) close.click(); } return true; })()`);
        await sleep(300);
        // 11：匹配库操作日志面板
        await clickStableNav(page, 'library');
        await waitPageVisible(page, 'library', 8000);
        await sleep(600);
        const logOpen = await page.evaluate(`(() => {
          const btn = document.getElementById('libLogBtn') || document.querySelector('[data-act="library-log"]');
          if (!btn) return false;
          btn.click();
          return !!document.querySelector('#libLogPanel, #libraryLogPanel, [data-log-panel], .log-drawer');
        })()`);
        await sleep(700);
        const logPath = path.join(opts.out, '11-library-log.png');
        await page.screenshot(logPath);
        report.shots.push(logPath);
        report.libraryLogUi = logOpen;
        console.log(`[shot] ${logPath}（操作日志面板：${logOpen}）`);
        if (!logOpen) report.warnings.push('11 匹配库操作日志截图：未找到 #libLogBtn 或面板尚未渲染');
        await page.evaluate(`(() => { const close = document.getElementById('libLogCloseBtn') || document.querySelector('#libLogPanel [data-close], .log-drawer [data-close]'); if (close) close.click(); return true; })()`);
        await sleep(300);
        // 12：已确认（确认写入后行入库状态=已确认）
        await clickStableNav(page, 'workbench');
        await waitPageVisible(page, 'workbench', 8000);
        await sleep(400);
        const doneInfo = await page.evaluate(`(async () => {
          const wb = window.__workbench;
          const reports = wb.state.session.reports || [];
          let target = null; let report = null;
          for (const r of reports) { const row = (r.rows || []).find((x) => x.libState === 'verified'); if (row) { target = row; report = r; break; } }
          if (!target) return { skipped: '没有已确认行' };
          wb.state.session.activeReportId = report.id;
          const sf = document.getElementById('statusFilter'); if (sf) { sf.value = 'all'; }
          const search = document.getElementById('searchInput'); if (search) { search.value = target.sku; search.dispatchEvent(new Event('input', { bubbles: true })); }
          wb.render();
          await new Promise((r) => setTimeout(r, 800));
          const idx = Array.from(document.querySelectorAll('#matchBody thead th')).findIndex((th) => /入库状态/.test(th.innerText));
          const tr = Array.from(document.querySelectorAll('#matchBodyRows tr')).find((row) => String(row.getAttribute('data-sku')) === String(target.sku));
          const badge = tr && idx >= 0 ? (tr.children[idx] || {}).innerText || '' : '';
          return { sku: target.sku, badge };
        })()`);
        await sleep(500);
        const donePath = path.join(opts.out, '12-confirm-done.png');
        await hideToast(page);
        await page.screenshot(donePath);
        report.shots.push(donePath);
        report.confirmDone = doneInfo;
        console.log(`[shot] ${donePath}（${JSON.stringify(doneInfo)}）`);
        if (!doneInfo.badge || !/已确认/.test(doneInfo.badge)) report.warnings.push(`12 已确认截图：未在界面捕获到「已确认」徽标（${JSON.stringify(doneInfo)}）`);
      } catch (err) {
        report.warnings.push(`v2.1.5 截图失败：${err.message}`);
      }
    }

    // v2.1.6 截图（DESIGN §21.3）：13 快速人工定位（待人工复核筛选）、14 缺尺寸段/待人工标记
    if (!opts.url) {
      try {
        await clickStableNav(page, 'workbench');
        await waitPageVisible(page, 'workbench', 8000);
        await sleep(600);
        await page.evaluate(`(() => {
          const search = document.getElementById('searchInput');
          if (search) { search.value = ''; search.dispatchEvent(new Event('input', { bubbles: true })); }
          const sf = document.getElementById('statusFilter');
          if (sf) { sf.value = 'all'; sf.dispatchEvent(new Event('change', { bubbles: true })); }
          const wb = window.__workbench;
          if (wb && wb.render) wb.render();
          return true;
        })()`);
        await sleep(500);
        const hasQuick = await page.evaluate(`!!document.getElementById('quickFilterBar')`);
        if (hasQuick) {
          const chips = await page.evaluate(`(() => {
            const text = (id) => { const el = document.getElementById(id); return el ? String(el.textContent || '').trim() : ''; };
            return { review: text('quickReviewChip'), noSize: text('quickNoSizeChip'), noPrice: text('quickNoPriceChip') };
          })()`);
          report.quickFilters = chips;
          const clickChip = (id) => page.evaluate(`(() => { const el = document.getElementById('${id}'); if (el) { el.click(); el.scrollIntoView({ block: 'center' }); } return !!el; })()`);
          await clickChip('quickReviewChip');
          await sleep(700);
          const reviewPath = path.join(opts.out, '13-workbench-review-filter.png');
          await hideToast(page);
          await page.screenshot(reviewPath);
          report.shots.push(reviewPath);
          console.log(`[shot] ${reviewPath}（chips=${JSON.stringify(chips)}）`);
          await clickChip('quickNoSizeChip');
          await sleep(700);
          const noSizePath = path.join(opts.out, '14-workbench-missing.png');
          await hideToast(page);
          await page.screenshot(noSizePath);
          report.shots.push(noSizePath);
          console.log(`[shot] ${noSizePath}（缺尺寸段筛选）`);
          // 复位筛选
          await clickChip('quickNoSizeChip');
          await sleep(300);
        } else {
          report.warnings.push('13/14 快速人工定位截图跳过：#quickFilterBar 未实现');
        }
      } catch (err) {
        report.warnings.push(`v2.1.6 截图失败：${err.message}`);
      }
    }

    // v2.1.7 截图（DESIGN §22.4）：15 价格类型徽标 / 采集调试 JSON
    if (!opts.url) {
      try {
        await clickStableNav(page, 'workbench');
        await waitPageVisible(page, 'workbench', 8000);
        await sleep(600);
        const info = await page.evaluate(`(() => {
          const wb = window.__workbench;
          const rows = (wb.state.session.reports || []).flatMap((r) => r.rows || []);
          const captured = rows.filter((r) => r.capturePrice != null || r.priceKind);
          const sku = captured[0] ? String(captured[0].sku) : "";
          let opened = false;
          let kindLabel = "";
          try {
            if (sku && typeof wb.openPriceDebug === "function") { wb.openPriceDebug(sku); opened = !!(document.getElementById("priceDebugDialog") || {}).open; }
            kindLabel = sku && typeof wb.getPriceKindLabel === "function" ? String(wb.getPriceKindLabel(sku) || "") : "";
          } catch (e) { /* ignore */ }
          const badge = document.querySelector(".price-kind-badge");
          return { captured: captured.length, sku, opened, kindLabel, hasBadge: !!badge, badgeText: badge ? String(badge.textContent || "").trim() : "" };
        })()`);
        report.priceTypes = info;
        await sleep(500);
        const path15 = path.join(opts.out, '15-workbench-pricetype.png');
        await hideToast(page);
        await page.screenshot(path15);
        report.shots.push(path15);
        console.log(`[shot] ${path15}（${JSON.stringify(info)}）`);
        if (!info.captured && !info.hasBadge) report.warnings.push('15 价格类型截图：当前无采集行/徽标（可在补采或 simulateCaptures 后重生）');
        if (!info.opened) report.warnings.push(`15 价格调试弹窗未打开（sku=${info.sku || "无"}），截图仅含工作台`);
      } catch (err) {
        report.warnings.push(`v2.1.7 截图失败：${err.message}`);
      }
    }
    // v2.1 浅色主题截图（DESIGN §16.2）：深色 4 张为交付主图，浅色补 1 张 05-workbench-light.png
    if (!opts.url) {
      try {
        let theme = await page.evaluate('document.documentElement.dataset.theme || ""');
        for (let i = 0; i < 2 && theme !== 'light'; i += 1) {
          await page.evaluate(`(() => { const el = document.getElementById('themeToggleBtn'); if (el) el.click(); return !!el; })()`);
          await sleep(600);
          theme = await page.evaluate('document.documentElement.dataset.theme || ""');
        }
        if (theme === 'light') {
          await clickStableNav(page, 'workbench');
          await waitPageVisible(page, 'workbench', 8000);
          await sleep(opts.waitMs);
          const lightPath = path.join(opts.out, '05-workbench-light.png');
          await hideToast(page);
          await page.screenshot(lightPath);
          report.shots.push(lightPath);
          report.lightTheme = theme;
          console.log(`[shot] ${lightPath}`);
        } else {
          report.warnings.push('未切换到浅色主题，跳过 05-workbench-light.png');
        }
      } catch (err) {
        report.warnings.push(`浅色主题截图失败：${err.message}`);
      }
    }

    report.diag = await collectDiagnostics(page);
    report.consoleErrors = page.consoleErrors.slice(0, 50);
    if (report.consoleErrors.length) {
      console.log(`\n[console] 捕获 ${report.consoleErrors.length} 条错误：`);
      for (const e of report.consoleErrors.slice(0, 10)) console.log('  -', e);
    }
    if (report.warnings.length) {
      console.log('\n[warning]');
      for (const w of report.warnings) console.log('  -', w);
    }
    console.log(`\n[OK] 截图 ${report.shots.length} 张 → ${opts.out}`);
    if (opts.json) {
      fs.mkdirSync(path.dirname(opts.json), { recursive: true });
      fs.writeFileSync(opts.json, JSON.stringify(report, null, 2), 'utf8');
    }
    if (opts.keepOpen) {
      console.log('[shot] --keep-open：浏览器保留，按 Ctrl+C 结束');
      await new Promise(() => {});
    }
  } finally {
    try { page?.close(); } catch { /* ignore */ }
    if (browser) await browser.close();
  }
}

main().catch((err) => {
  console.error('[shot] 失败：', err?.stack || err?.message || err);
  process.exit(1);
});
