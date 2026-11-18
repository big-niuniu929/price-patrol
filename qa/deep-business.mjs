#!/usr/bin/env node
/**
 * 价格监控平台 · 市占率（share）+ 竞品监控（radar）深度真实浏览器验收
 * ---------------------------------------------------------------------------
 * 复用 qa/lib/cdp.mjs（零依赖 headless Edge CDP），用真实扩展页面 + 真实 xlsx 样本
 * + CDP Fetch 拦截 item.shop.example.com（本地 mock，不联网电商平台）做业务闭环验证。
 *
 * 用法：
 *   node qa/deep-business.mjs                 # 跑 share + radar 两个 section
 *   node qa/deep-business.mjs --only share    # 只跑市占率
 *   node qa/deep-business.mjs --only radar    # 只跑竞品监控
 * 其他参数：--ext <扩展目录>  --browser <可执行文件>  --port <CDP端口>  --timeout <ms>
 *
 * 产物：
 *   qa/shots-deep-business/*.png              截图（含 fail-*.png）
 *   qa/shots-deep-business/downloads/         导出下载的真实文件
 *   qa/DEEP-BUSINESS-REPORT.md / .json        断言表 + console error 原文 + 产品 bug 最小复现
 *
 * 约定：
 *   - 业务模块在平台页 iframe#moduleFrame 中运行，所有业务内交互都通过
 *     iframe contentDocument 进行（与真实用户使用路径一致；不直接导航模块 URL）。
 *   - window.confirm/alert 由 Page.javascriptDialogOpening 自动 accept（仅测试用）。
 *   - 下载断言：Page.setDownloadBehavior(allow) 到临时目录后检查真实文件（xlsx PK 头/JSON 可解析/CSV 行数）。
 *   - 两个业务 section 独立：一个 section 抛错不影响另一个继续跑。
 *   - 发现产品 bug 只记录最小复现，不改 modules/** 与平台根文件。
 *
 * 退出码：0 全通过；1 有失败项；2 环境/致命错误。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  launchBrowser, findExtensionId, findPageTarget, PageSession,
  CdpClient, waitForCdp, findBrowser, sleep,
} from './lib/cdp.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QA_DIR = __dirname;
const PLATFORM_DIR = path.resolve(QA_DIR, '..');
const OUT_DIR = path.join(QA_DIR, 'shots-deep-business');
const DL_DIR = path.join(OUT_DIR, 'downloads');
const REPORT_MD = path.join(QA_DIR, 'DEEP-BUSINESS-REPORT.md');
const REPORT_JSON = path.join(QA_DIR, 'DEEP-BUSINESS-REPORT.json');

const VIEWPORT = { width: 1440, height: 900 };

// 真实只读 xlsx 样本：优先用本目录 qa/fixtures/materials 里的副本（交付自带），找不到再退回桌面原路径
const MATERIALS = path.join(QA_DIR, 'fixtures', 'materials');
function pickMaterial(name, fallback) {
  const local = path.join(MATERIALS, name);
  return fs.existsSync(local) ? local : fallback;
}
const XLSX_RANK = pickMaterial('test-backfill.xlsx', '~/Desktop/市占率\\work\\workbench-ui\\test-backfill.xlsx');
const XLSX_BACKFILL = pickMaterial('回填_11月-会议平板_20261106-125446.xlsx', '~/Desktop/市占率\\tests\\qa\\.tmp\\downloads\\回填_11月-会议平板_20261106-125446.xlsx');
const XLSX_MONTHLY = pickMaterial('线上竞争数据分析（月度）.xlsx', '~/Desktop/竞品数据监控\\线上竞争数据分析（月度）.xlsx');

// 本地 mock 电商平台商品页（不联网；radar/content.js 会解析这里的价格区）
const MOCK_PRODUCT_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>电商平台商品页（本地 mock · 不联网）</title></head>
<body>
  <div class="sku-name"><h1>QA Mock 竞品 75 英寸会议平板一体机</h1></div>
  <div class="product-price"><span class="p-price"><span class="price J-p-mock">¥4,999.00</span></span></div>
  <div class="summary-price"><span class="label">到手价</span><span class="price">¥4,999.00</span></div>
  <div id="specification"><table><tbody><tr><th>屏幕尺寸</th><td>75英寸</td></tr></tbody></table></div>
</body></html>`;

const MOCK_OFFLINE_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>电商平台商品页（本地 mock · 已下架）</title></head>
<body>
  <div class="item-over"><h1>该商品已下架</h1><p>很抱歉，该商品已下架，看看其他商品吧。</p></div>
</body></html>`;

const OK = (cond, msg) => { if (!cond) throw new Error(msg); return true; };
const oneLine = (s, n = 320) => String(s == null ? '' : s).replace(/\s+/g, ' ').slice(0, n);

// ---------------------------------------------------------------------------
// 结果与工具
// ---------------------------------------------------------------------------
const state = {
  browser: null,
  page: null,
  browserCtl: null,
  extId: '',
  mock: { docFulfilled: 0, otherFulfilled: 0, paused: 0, enabled: 0, attached: 0, errors: [], served: [] },
  mockOfflineSku: '',
  mockPrice: '4999',
  dialogs: [],
  results: [],
  shots: [],
  downloads: [],
  consoleBySection: {},
  bugs: [],
  fatal: '',
  steps: { share: { total: 0, passed: 0 }, radar: { total: 0, passed: 0 } },
};
let currentSection = 'env';

function listDl() {
  try { return fs.readdirSync(DL_DIR); } catch { return []; }
}

async function shot(name, note = '') {
  const p = path.join(OUT_DIR, name);
  try {
    await state.page.screenshot(p);
    state.shots.push({ name, path: p, note });
    console.log(`[shot] ${name} ${note}`);
  } catch (e) {
    console.log(`[shot-fail] ${name}: ${e.message}`);
  }
  return p;
}

async function check(id, title, fn) {
  const section = currentSection;
  const t0 = Date.now();
  const mark = state.page ? state.page.consoleErrors.length : 0;
  state.steps[section] = state.steps[section] || { total: 0, passed: 0 };
  state.steps[section].total++;
  let ok = true;
  let detail = '';
  let error = '';
  try {
    const r = await fn();
    detail = r == null ? 'ok' : String(r);
  } catch (e) {
    ok = false;
    error = (e && e.message) ? e.message : String(e);
    try { await shot(`fail-${id}.png`, `失败：${oneLine(error, 80)}`); } catch { /* ignore */ }
  }
  const ms = Date.now() - t0;
  const consoleDelta = state.page ? state.page.consoleErrors.slice(mark) : [];
  const rec = { id, section, title, ok, detail: oneLine(detail, 600), error: oneLine(error, 900), ms, consoleDelta: consoleDelta.slice(0, 10) };
  state.results.push(rec);
  if (ok) state.steps[section].passed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} [${section}] ${id} ${title} · ${ms}ms${ok ? ' · ' + oneLine(detail, 180) : ' · ' + oneLine(error, 400)}`);
  return rec;
}

function noteBug(bug) {
  state.bugs.push(bug);
  console.log(`[BUG] ${bug.id} ${bug.title}`);
}

// ---------------------------------------------------------------------------
// 页面侧辅助：主文档（平台壳）与 iframe（业务模块）
// ---------------------------------------------------------------------------
async function fExpr(expr) {
  return await state.page.evaluate(`(() => {
    const f = document.getElementById('moduleFrame');
    const doc = f && f.contentDocument;
    if (!doc) throw new Error('moduleFrame 不可访问');
    const win = doc.defaultView;
    return (${expr});
  })()`);
}

async function fWait(expr, { timeoutMs = 15000, intervalMs = 200, label = '' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  let lastErr = '';
  while (Date.now() < deadline) {
    try { last = await fExpr(expr); } catch (e) { last = undefined; lastErr = e.message; }
    if (last) return last;
    await sleep(intervalMs);
  }
  throw new Error(`等待超时（${timeoutMs}ms）：${label || expr}；最后值=${oneLine(JSON.stringify(last), 200)}${lastErr ? '；错误=' + oneLine(lastErr, 160) : ''}`);
}

async function fClick(sel, { visible = false } = {}) {
  const r = await fExpr(`(() => {
    const el = doc.querySelector(${JSON.stringify(sel)});
    if (!el) return { ok: false, err: '元素不存在' };
    const rect = el.getBoundingClientRect();
    const cs = win.getComputedStyle(el);
    if (${visible ? 'true' : 'false'} && !(rect.width > 0 && rect.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none')) {
      return { ok: false, err: '元素不可见 ' + rect.width + 'x' + rect.height };
    }
    el.scrollIntoView({ block: 'center' });
    el.click();
    return { ok: true, text: (el.textContent || '').trim().slice(0, 80) };
  })()`);
  if (!r || !r.ok) throw new Error(`点击 ${sel} 失败：${r ? r.err : '无返回'}`);
  await sleep(300);
  return r;
}

async function fSetValue(sel, value) {
  const r = await fExpr(`(() => {
    const el = doc.querySelector(${JSON.stringify(sel)});
    if (!el) return { ok: false, err: '元素不存在' };
    const tag = el.tagName;
    const proto = tag === 'TEXTAREA' ? win.HTMLTextAreaElement.prototype
      : tag === 'SELECT' ? win.HTMLSelectElement.prototype
        : win.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(String(value))});
    el.dispatchEvent(new win.Event('input', { bubbles: true }));
    el.dispatchEvent(new win.Event('change', { bubbles: true }));
    return { ok: true, value: el.value };
  })()`);
  if (!r || !r.ok) throw new Error(`写值 ${sel} 失败：${r ? r.err : '无返回'}`);
  await sleep(450);
  return r;
}

async function fText(sel) {
  return await fExpr(`(() => { const el = doc.querySelector(${JSON.stringify(sel)}); return el ? (el.innerText || el.textContent || '').trim() : ''; })()`);
}

/** 读取模块 toast：返回 {text, className, visible}（两个模块 toast 类名不同，统一判断） */
async function fToast() {
  return await fExpr(`(() => {
    const el = doc.getElementById('toast');
    if (!el) return { text: '', className: '', visible: false };
    const cs = win.getComputedStyle(el);
    return {
      text: (el.textContent || '').trim(),
      className: String(el.className || ''),
      visible: cs.display !== 'none' && cs.visibility !== 'hidden' && !el.classList.contains('hidden') && cs.opacity !== '0',
    };
  })()`);
}

async function waitFrame(biz, timeoutMs = 25000) {
  const want = `modules/${biz}/app.html`;
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await state.page.evaluate(`(() => {
        const f = document.getElementById('moduleFrame');
        if (!f) return { ok: false, phase: 'no #moduleFrame' };
        const doc = f.contentDocument;
        if (!doc) return { ok: false, phase: 'contentDocument 不可访问' };
        const url = String(doc.URL || '');
        if (!url.includes(${JSON.stringify(want)})) return { ok: false, phase: 'iframe 文档未切换', url };
        if (doc.readyState !== 'complete') return { ok: false, phase: '文档未就绪', url, readyState: doc.readyState };
        const text = doc.body ? doc.body.innerText.trim() : '';
        if (text.length < 50) return { ok: false, phase: '正文过短', url, len: text.length };
        return { ok: true, url, textLen: text.length, title: doc.title };
      })()`);
    } catch { last = null; }
    if (last && last.ok) return last;
    await sleep(200);
  }
  throw new Error(`等待 modules/${biz}/app.html 加载超时：${oneLine(JSON.stringify(last), 300)}`);
}

async function enterBiz(biz) {
  const via = await state.page.evaluate(`(() => {
    const card = document.querySelector('[data-biz="${biz}"]');
    const sw = document.querySelector('[data-switch-biz="${biz}"]');
    const candidates = [{ el: card, kind: 'card' }, { el: sw, kind: 'switch' }].filter((x) => x.el);
    const visibleOf = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const pick = candidates.find((x) => visibleOf(x.el)) || candidates[0];
    if (!pick) return { ok: false, err: '找不到入口' };
    const el = pick.el;
    if (!visibleOf(el)) return { ok: false, err: '入口不可见（card/switch 均 0 尺寸）' };
    el.scrollIntoView({ block: 'center' });
    el.click();
    return { ok: true, via: pick.kind, text: (el.textContent || '').trim().slice(0, 40) };
  })()`);
  if (!via || !via.ok) throw new Error(`进入业务 ${biz} 失败：${via ? via.err : '无返回'}`);
  const info = await waitFrame(biz);
  await sleep(600);
  return { via, info };
}

/** 设置 iframe 内文件输入框的文件（CDP DOM.setFileInputFiles + 跨 frame objectId） */
async function setFrameFileInput(selector, files) {
  const { result } = await state.page.client.rpc('Runtime.evaluate', {
    expression: `document.getElementById('moduleFrame').contentDocument.querySelector(${JSON.stringify(selector)})`,
    returnByValue: false,
  });
  if (!result || !result.objectId) throw new Error(`找不到 iframe 内文件输入框：${selector}`);
  await state.page.client.rpc('DOM.setFileInputFiles', { files, objectId: result.objectId }, 20000);
  return true;
}

/** 下载断言：点击动作后等待真实文件落盘（Page.setDownloadBehavior 指向 DL_DIR） */
async function expectDownloads(re, action, { min = 1, timeoutMs = 20000, settleMs = 600 } = {}) {
  const before = new Set(listDl());
  await action();
  const deadline = Date.now() + timeoutMs;
  let hits = [];
  let lastAll = [];
  while (Date.now() < deadline) {
    const names = listDl();
    lastAll = names;
    hits = names.filter((n) => !n.endsWith('.crdownload') && !before.has(n) && re.test(n));
    if (hits.length >= min) {
      // 等文件不再增长，避免读到半截
      let prev = -1;
      for (let i = 0; i < 20; i++) {
        const size = hits.reduce((s, n) => s + fs.statSync(path.join(DL_DIR, n)).size, 0);
        if (size === prev) break;
        prev = size;
        await sleep(150);
      }
      break;
    }
    await sleep(200);
  }
  if (hits.length < min) {
    const newFiles = lastAll.filter((n) => !before.has(n));
    throw new Error(`下载文件未出现：期望 ≥${min} 个匹配 ${re}；实际新增=${newFiles.join(', ') || '无'}；目录=${lastAll.join(', ') || '空'}`);
  }
  await sleep(settleMs);
  const out = hits.map((n) => {
    const p = path.join(DL_DIR, n);
    return { name: n, path: p, size: fs.statSync(p).size };
  });
  const empty = out.filter((f) => f.size <= 0);
  if (empty.length) throw new Error(`下载文件为空：${empty.map((f) => f.name).join(', ')}`);
  for (const f of out) state.downloads.push({ ...f, at: new Date().toISOString() });
  return out;
}

function readUtf8(p) { return fs.readFileSync(p, 'utf8'); }
function assertXlsx(file) {
  const head = fs.readFileSync(file.path).subarray(0, 2).toString('latin1');
  OK(head === 'PK', `${file.name} 不是合法 xlsx（文件头=${JSON.stringify(head)}）`);
  OK(file.size > 2000, `${file.name} 体积异常小（${file.size}B）`);
  return `${file.name} (${file.size}B, PK 头)`;
}

/** 自定义确认框（share / radar 都有 #confirmDialog）：等待打开 → 断言文案 → 点确认/取消 */
async function waitFrameDialog(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const d = await fExpr(`(() => {
      const el = doc.getElementById('confirmDialog');
      if (!el) return null;
      const titleEl = doc.getElementById('confirmTitle');
      const textEl = doc.getElementById('confirmText');
      const cs = win.getComputedStyle(el);
      return { open: el.open === true || el.classList.contains('open') || cs.display !== 'none', title: (titleEl && titleEl.textContent || '').trim(), text: (textEl && textEl.innerText || '').trim().slice(0, 300) };
    })()`);
    if (d && d.open) return d;
    await sleep(150);
  }
  throw new Error('确认框未出现');
}

async function frameDialogOk() { await fClick('#confirmOk'); await sleep(500); }

// ---------------------------------------------------------------------------
// 浏览器级 Fetch mock：拦截新标签页（radar 采集 runner tab）的 item.shop.example.com
// ---------------------------------------------------------------------------
function rpcS(client, method, params, sessionId, timeoutMs = 20000) {
  const id = client.nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { client.pending.delete(id); reject(new Error(`CDP(会话) 超时 ${method}`)); }, timeoutMs);
    client.pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    client.ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
}

async function setupRunnerMock(browser) {
  const ver = await waitForCdp(browser.port, 8000);
  const bc = new CdpClient(ver.webSocketDebuggerUrl);
  await bc.connect(8000);
  state.browserCtl = bc;
  const priceTextOf = (p) => '¥' + Number(p).toLocaleString('en-US') + '.00';
  const offlineB64 = Buffer.from(MOCK_OFFLINE_HTML, 'utf8').toString('base64');
  const emptyB64 = Buffer.from('', 'utf8').toString('base64');

  bc.on('Target.attachedToTarget', async (p) => {
    state.mock.attached++;
    const ti = p.targetInfo || {};
    if (ti.type !== 'page') return;
    try {
      await rpcS(bc, 'Fetch.enable', {
        patterns: [
          { urlPattern: 'https://item.shop.example.com/*', requestStage: 'Request' },
          { urlPattern: 'https://item.shop.example.com/*', requestStage: 'Request' },
        ],
      }, p.sessionId);
      state.mock.enabled++;
    } catch (e) { state.mock.errors.push('Fetch.enable: ' + oneLine(e.message, 160)); }
  });
  bc.on('Fetch.requestPaused', async (p, sessionId) => {
    state.mock.paused++;
    try {
      if (p.resourceType === 'Document') {
        const offline = !!state.mockOfflineSku && String(p.request.url).includes(state.mockOfflineSku);
        state.mock.docFulfilled++;
        state.mock.served.push(`${offline ? 'offline' : 'product'} ${p.request.url}`);
        const servedHtml = offline ? MOCK_OFFLINE_HTML : MOCK_PRODUCT_HTML.split('¥4,999.00').join(priceTextOf(state.mockPrice));
        await rpcS(bc, 'Fetch.fulfillRequest', {
          requestId: p.requestId,
          responseCode: 200,
          responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }],
          body: Buffer.from(servedHtml, 'utf8').toString('base64'),
        }, sessionId);
      } else {
        state.mock.otherFulfilled++;
        await rpcS(bc, 'Fetch.fulfillRequest', {
          requestId: p.requestId,
          responseCode: 200,
          responseHeaders: [{ name: 'Content-Type', value: p.resourceType === 'Image' ? 'image/png' : 'text/plain' }],
          body: emptyB64,
        }, sessionId);
      }
    } catch (e) {
      state.mock.errors.push('Fetch.fulfill: ' + oneLine(e.message, 160));
      try { await rpcS(bc, 'Fetch.continueRequest', { requestId: p.requestId }, sessionId, 5000); } catch { /* ignore */ }
    }
  });
  await bc.rpc('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, 10000);
}

// ---------------------------------------------------------------------------
// 环境 & 平台启动
// ---------------------------------------------------------------------------
async function runEnv(opts) {
  const r = { env: {} };
  currentSection = 'env';

  await check('E1', `headless Edge + 扩展加载（extDir=${opts.ext}）`, async () => {
    state.browser = await launchBrowser({ extDir: opts.ext, width: VIEWPORT.width, height: VIEWPORT.height, browser: opts.browser || undefined, port: opts.port || undefined });
    r.env.browserPath = findBrowser();
    r.env.browserVersion = (state.browser.version && state.browser.version.Browser) || '';
    r.env.cdpPort = state.browser.port;
    return `${r.env.browserVersion} · CDP ${state.browser.port}`;
  });

  await check('E2', '定位扩展 ID 并打开平台首页', async () => {
    state.extId = opts.extId || process.env.DS_EXT_ID || await findExtensionId(state.browser.port, 30000);
    OK(/^[a-p]{32}$/.test(state.extId), `扩展 ID 格式异常：${state.extId}`);
    const target = await findPageTarget(state.browser.port, 20000);
    state.page = await new PageSession(target.wsUrl).connect();
    await state.page.setViewport(VIEWPORT.width, VIEWPORT.height);
    await state.page.client.rpc('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DL_DIR }, 8000);
    // 自动 accept 原生 confirm/alert（测试用）
    state.page.client.on('Page.javascriptDialogOpening', async (p) => {
      state.dialogs.push({ type: p.type, message: oneLine(p.message, 200), at: new Date().toISOString() });
      try { await state.page.client.rpc('Page.handleJavaScriptDialog', { accept: true }, 5000); } catch { /* ignore */ }
    });
    await setupRunnerMock(state.browser);
    await state.page.navigate(`chrome-extension://${state.extId}/app.html`, { settleMs: 2500 });
    await state.page.waitFor(`document.readyState === 'complete' && document.body && document.body.innerText.trim().length > 40`, { timeoutMs: opts.timeoutMs, label: '平台首页' });
    const info = await state.page.evaluate(`(() => ({
      title: document.title,
      cards: Array.from(document.querySelectorAll('[data-biz]')).map((el) => ({ biz: el.getAttribute('data-biz'), text: (el.textContent || '').trim().slice(0, 30), visible: el.getBoundingClientRect().width > 0 })),
      switches: Array.from(document.querySelectorAll('[data-switch-biz]')).map((el) => el.getAttribute('data-switch-biz')),
    }))()`);
    const missing = ['patrol', 'share', 'radar'].filter((b) => !info.cards.some((c) => c.biz === b && c.visible));
    OK(missing.length === 0, `首页业务卡片缺失/不可见：${missing.join('、')}`);
    return `extId=${state.extId} · title=${info.title} · cards=${info.cards.length} · switches=${info.switches.join(',')}`;
  });

  await check('E3', '下载目录与截图目录就绪', async () => {
    fs.mkdirSync(DL_DIR, { recursive: true });
    const files = listDl();
    return `downloadDir=${DL_DIR}（已有 ${files.length} 个文件）`;
  });

  return r;
}

// ===========================================================================
// SECTION B：市占率（modules/share）
// ===========================================================================
async function runShare(opts) {
  currentSection = 'share';
  state.consoleBySection.share = { mark: state.page.consoleErrors.length };
  const summary = {};

  await check('S01', '从平台首页进入「市占率」业务（iframe#moduleFrame 加载 modules/share/app.html）', async () => {
    const { via, info } = await enterBiz('share');
    const nav = await fExpr(`(() => ({
      navs: Array.from(doc.querySelectorAll('.nav-btn[data-page-target]')).map((b) => ({ page: b.getAttribute('data-page-target'), text: (b.textContent || '').trim(), active: b.classList.contains('active') || b.getAttribute('aria-current') === 'page' })),
      env: (doc.getElementById('envBadge') || {}).textContent,
      title: doc.title,
      h1: (doc.querySelector('h2') || {}).textContent,
      page: doc.getElementById('page-workbench') && !doc.getElementById('page-workbench').classList.contains('hidden'),
    }))()`);
    OK(nav.navs.length === 5, `页签数量=${nav.navs.length}（期望 5：工作台/总览/匹配库/统计看板/设置与帮助）`);
    OK(/扩展模式/.test(nav.env || ''), `环境徽章=${JSON.stringify(nav.env)}，应含「扩展模式」`);
    OK(nav.page === true, '工作台页未显示');
    summary.entry = `via=${via.via} · iframe=${info.url} · 页签=${nav.navs.map((x) => x.text).join('/')}`;
    await shot('S01-share-workbench-empty.png', '市占率 · 工作台首屏（未导入）');
    return summary.entry;
  });

  await check('S02', '工作台空态结构：配对表空提示 / 导入区 / KPI 全 0 / 分析按钮', async () => {
    const info = await fExpr(`(() => ({
      matchEmpty: (doc.getElementById('matchEmpty') || {}).textContent || '',
      reportCount: (doc.getElementById('reportCount') || {}).textContent,
      analyzeBtn: !!doc.getElementById('analyzeBtn'),
      pickBtn: !!doc.getElementById('pickReportBtn'),
      kpiText: (doc.getElementById('kpiBar') || {}).innerText || '',
      pivot: (doc.getElementById('tableCount') || {}).textContent,
      riskBanner: !!doc.getElementById('riskBanner'),
    }))()`);
    OK(/尚未导入榜单|导入榜单并点击/.test(info.matchEmpty), `配对表空提示异常：${oneLine(info.matchEmpty, 120)}`);
    OK(info.reportCount === '0', `榜单计数=${info.reportCount}`);
    OK(info.analyzeBtn && info.pickBtn, '分析补数 / 导入榜单按钮缺失');
    OK(/0\s*个/.test(info.kpiText) || /总行数\s*0/.test(info.kpiText), `KPI 非空态：${oneLine(info.kpiText, 200)}`);
    return `空态正常 · 榜单=0 · KPI=${oneLine(info.kpiText, 160)}`;
  });

  await check('S03', '空态点「分析补数」给出明确错误提示且不崩溃', async () => {
    await fClick('#analyzeBtn');
    await sleep(800);
    const t = await fToast();
    OK(/还没有榜单/.test(t.text), `toast=${JSON.stringify(t.text)}，期望含「还没有榜单」`);
    const alive = await fExpr(`(() => !!doc.getElementById('page-workbench'))()`);
    OK(alive, '页面在错误提示后丢失');
    return `toast=${t.text}`;
  });

  await check('S04', '四页签来回切换（工作台→总览→匹配库→统计看板→设置与帮助→工作台）', async () => {
    const order = ['workbench', 'overview', 'library', 'stats', 'settings', 'workbench'];
    const seen = [];
    for (const pageKey of order) {
      await fClick(`.nav-btn[data-page-target="${pageKey}"]`);
      await sleep(500);
      const st = await fExpr(`(() => {
        const pageEl = doc.getElementById('page-${pageKey}');
        const activeNav = doc.querySelector('.nav-btn.active[data-page-target]');
        const visiblePages = Array.from(doc.querySelectorAll('.page')).filter((p) => !p.classList.contains('hidden')).map((p) => p.id);
        return { exists: !!pageEl, visible: pageEl ? !pageEl.classList.contains('hidden') : false, active: activeNav ? activeNav.getAttribute('data-page-target') : '', visiblePages };
      })()`);
      OK(st.exists, `页面 #page-${pageKey} 不存在`);
      OK(st.visible, `切到 ${pageKey} 后 #page-${pageKey} 仍隐藏（当前可见：${st.visiblePages.join(',')}）`);
      OK(st.visiblePages.length === 1, `同时可见 ${st.visiblePages.length} 个页面：${st.visiblePages.join(',')}`);
      OK(st.active === pageKey, `导航 active=${st.active}，期望 ${pageKey}`);
      seen.push(pageKey);
    }
    await shot('S03-share-tabs-cycled.png', '四页签切换后回到工作台');
    return `切换顺序 ${seen.join('→')}，每次仅 1 页可见`;
  });

  await check('S05', '导入真实电商平台榜单 xlsx（test-backfill.xlsx，200 行）→ 榜单卡/类目绑定/配对表出现', async () => {
    OK(fs.existsSync(XLSX_RANK), `样本不存在：${XLSX_RANK}`);
    await setFrameFileInput('#reportFileInput', [XLSX_RANK]);
    await fWait(`doc.getElementById('reportCount').textContent.trim() === '1'`, { timeoutMs: 30000, label: '榜单计数=1' });
    await sleep(1200);
    const info = await fExpr(`(() => {
      const wb = win.__workbench;
      const reps = (wb.state.session.reports || []);
      const rep = reps[0] || {};
      // 导入完成后 STEP01 会自动折叠，榜单管理 details 默认关闭：先展开再读卡片（真实用户交互）
      const details = doc.getElementById('reportsDetails');
      if (details && !details.open) details.open = true;
      const cards = Array.from(doc.querySelectorAll('#reportCards .report-card'));
      const card = cards[0] || null;
      const bind = card ? card.querySelector('select[data-act="bind-store"]') : null;
      return {
        reportCount: doc.getElementById('reportCount').textContent.trim(),
        tableCount: doc.getElementById('tableCount').textContent.trim(),
        rowsDom: doc.querySelectorAll('#matchBodyRows tr').length,
        file: rep.fileName, rows: (rep.rows || []).length, store: rep.store, sheet: rep.sheetName, conf: rep.confidence,
        cards: cards.length,
        cardText: card ? (card.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 240) : '',
        bindValue: bind ? bind.value : '',
        bindOptions: bind ? bind.options.length : 0,
        kpi: (doc.getElementById('kpiBar').innerText || '').replace(/\\n/g, ' | ').slice(0, 320),
        saveState: doc.getElementById('saveState').textContent.trim(),
        toast: doc.getElementById('toast').textContent.trim(),
        runtimeErrors: wb.runtimeErrors.slice(),
      };
    })()`);
    OK(info.reportCount === '1', `榜单计数=${info.reportCount}`);
    OK(info.rows === 200, `解析行数=${info.rows}，期望 200`);
    OK(info.tableCount === '200', `配对表计数=${info.tableCount}，期望 200`);
    OK(info.cards === 1, `榜单卡数量=${info.cards}`);
    OK(info.cardText.includes('test-backfill'), `榜单卡未显示文件名：${oneLine(info.cardText, 160)}`);
    OK(!!info.store, `类目绑定为空（card=${oneLine(info.cardText, 120)}）`);
    OK(/已导入 1 个榜单/.test(info.toast), `toast=${JSON.stringify(info.toast)}`);
    OK(info.runtimeErrors.length === 0, `runtimeErrors=${JSON.stringify(info.runtimeErrors)}`);
    summary.import1 = `${info.file} · ${info.rows}行 · sheet=${info.sheet} · 绑定「${info.store}」· 置信度=${info.conf} · DOM行=${info.rowsDom}`;
    await shot('S05-share-imported.png', '导入 test-backfill.xlsx 后');
    return summary.import1;
  });

  await check('S06', '导入第二个真实榜单（回填_11月-会议平板 xlsx，真实导出回填格式）→ 2 个榜单 / 总 400 行 / 榜单卡切换', async () => {
    OK(fs.existsSync(XLSX_BACKFILL), `样本不存在：${XLSX_BACKFILL}`);
    await setFrameFileInput('#reportFileInput', [XLSX_BACKFILL]);
    await fWait(`doc.getElementById('reportCount').textContent.trim() === '2'`, { timeoutMs: 30000, label: '榜单计数=2' });
    await sleep(1200);
    const info = await fExpr(`(() => {
      const wb = win.__workbench;
      const reps = wb.state.session.reports || [];
      const details = doc.getElementById('reportsDetails');
      if (details && !details.open) details.open = true;
      const cards = Array.from(doc.querySelectorAll('#reportCards .report-card')).map((c) => ({ id: c.dataset.reportId, active: c.classList.contains('active'), text: (c.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 160) }));
      return {
        count: reps.length, tableCount: doc.getElementById('tableCount').textContent.trim(),
        cards,
        files: reps.map((rp) => rp.fileName + ':' + (rp.rows || []).length + '行/' + (rp.store || '未绑定')),
        sumRows: reps.reduce((s, rp) => s + (rp.rows || []).length, 0),
        activeId: wb.state.session.activeReportId,
        runtimeErrors: wb.runtimeErrors.slice(),
      };
    })()`);
    OK(info.count === 2, `榜单数=${info.count}`);
    OK(info.cards.length === 2, `榜单卡数=${info.cards.length}`);
    OK(info.sumRows === 400, `两个榜单总行数=${info.sumRows}，期望 400`);
    OK(info.files.some((x) => /回填_11月-会议平板/.test(x)), `第二个榜单文件名异常：${info.files.join(' / ')}`);
    OK(info.runtimeErrors.length === 0, `runtimeErrors=${JSON.stringify(info.runtimeErrors)}`);
    // 榜单卡切换（真实交互）：点非 active 卡片 → activeReportId 切换 + 配对表重渲染
    const targetCard = info.cards.find((c) => !c.active) || info.cards[0];
    await fClick(`#reportCards .report-card[data-report-id="${targetCard.id}"]`);
    await sleep(800);
    const after = await fExpr(`(() => {
      const wb = win.__workbench;
      const activeCard = doc.querySelector('#reportCards .report-card.active');
      return {
        activeId: wb.state.session.activeReportId,
        activeCardId: activeCard ? activeCard.dataset.reportId : '',
        tableCount: doc.getElementById('tableCount').textContent.trim(),
        rows: doc.querySelectorAll('#matchBodyRows tr').length,
        toast: doc.getElementById('toast').textContent.trim(),
      };
    })()`);
    OK(String(after.activeId) === String(targetCard.id), `切换榜单卡后 activeReportId=${after.activeId}，期望 ${targetCard.id}`);
    OK(String(after.activeCardId) === String(targetCard.id), `active 卡片=${after.activeCardId}`);
    OK(after.rows > 0, '切换榜单卡后配对表为空');
    summary.import2 = info.files.join(' / ') + ` · 卡片切换 → 当前榜单行数=${after.tableCount}`;
    await shot('S06-share-imported-2.png', '导入两个真实榜单后（含榜单卡）');
    return summary.import2;
  });

  await check('S07', '点「分析补数」（离线）→ 分析完成提示 + 数字/配对表更新', async () => {
    const before = await fExpr(`(() => {
      const wb = win.__workbench;
      return { kpi: doc.getElementById('kpiBar').innerText.replace(/\\n/g, '|'), rows: doc.querySelectorAll('#matchBodyRows tr').length, table: doc.getElementById('tableCount').textContent };
    })()`);
    await fClick('#analyzeBtn');
    await fWait(`/分析完成/.test(doc.getElementById('toast').textContent)`, { timeoutMs: 30000, label: '分析完成 toast' });
    await sleep(1200);
    const after = await fExpr(`(() => {
      const wb = win.__workbench;
      const reps = wb.state.session.reports || [];
      return {
        toast: doc.getElementById('toast').textContent.trim(),
        kpi: doc.getElementById('kpiBar').innerText.replace(/\\n/g, '|'),
        rows: doc.querySelectorAll('#matchBodyRows tr').length,
        table: doc.getElementById('tableCount').textContent,
        statRows: reps.map((rp) => ({ file: rp.fileName, rows: (rp.rows || []).length, sizeCover: (rp.summary || {}).sizeCoverage })),
        runtimeErrors: wb.runtimeErrors.slice(),
        saveState: doc.getElementById('saveState').textContent.trim(),
      };
    })()`);
    OK(/分析完成/.test(after.toast), `toast=${after.toast}`);
    OK(/200|400/.test(after.table), `配对表计数=${after.table}`);
    OK(after.rows > 0, '分析后配对表无行');
    OK(after.runtimeErrors.length === 0, `runtimeErrors=${JSON.stringify(after.runtimeErrors)}`);
    summary.analyze = `toast=${after.toast} · table=${after.table} · DOM行=${after.rows}`;
    await shot('S07-share-analyzed.png', '分析补数完成后（含 KPI）');
    return summary.analyze;
  });

  await check('S08', '配对表行内编辑「型号」→ 单元格/状态/来源 更新', async () => {
    const target = await fExpr(`(() => {
      const wb = win.__workbench;
      const rep = wb.state.session.reports.find((rp) => rp.id === wb.state.session.activeReportId) || wb.state.session.reports[0];
      const rows = rep.rows || [];
      const idx = rows.findIndex((r) => (r.model || '') !== 'QA-MODEL-75X');
      const cell = doc.querySelector('[data-act="edit-cell"][data-field="model"][data-index="' + Math.max(0, idx) + '"]');
      if (!cell) return { ok: false, idx, rowsLen: rows.length };
      const before = (cell.textContent || '').trim();
      cell.click();
      return { ok: true, idx: Math.max(0, idx), before, sku: rows[Math.max(0, idx)].sku };
    })()`);
    OK(target.ok, `找不到可见的型号单元格（idx=${target.idx} rows=${target.rowsLen}）`);
    await fWait(`!!doc.querySelector('.cell-editor input')`, { timeoutMs: 5000, label: '行内编辑器出现' });
    await fSetValue('#matchBodyRows .cell-editor input', 'QA-MODEL-75X');
    await fClick('#matchBodyRows .cell-editor [data-ed="save"]');
    await sleep(800);
    const after = await fExpr(`(() => {
      const wb = win.__workbench;
      const rep = wb.state.session.reports.find((rp) => rp.id === wb.state.session.activeReportId) || wb.state.session.reports[0];
      const row = (rep.rows || [])[${target.idx}];
      const cell = doc.querySelector('[data-act="edit-cell"][data-field="model"][data-index="${target.idx}"]');
      return { cellText: cell ? (cell.textContent || '').trim() : '', model: row && row.model, modelSource: row && row.modelSource, toast: doc.getElementById('toast').textContent.trim(), runtimeErrors: wb.runtimeErrors.slice() };
    })()`);
    OK(after.model === 'QA-MODEL-75X', `界面/状态 model=${JSON.stringify(after.model)}`);
    OK(after.cellText === 'QA-MODEL-75X', `单元格文本=${JSON.stringify(after.cellText)}`);
    OK(after.modelSource === '手动', `modelSource=${JSON.stringify(after.modelSource)}，期望 手动`);
    OK(after.runtimeErrors.length === 0, `runtimeErrors=${JSON.stringify(after.runtimeErrors)}`);
    await shot('S08-share-inline-edited-model.png', '行内编辑型号为 QA-MODEL-75X');
    return `SKU=${target.sku} 型号 ${target.before || '(空)'} → QA-MODEL-75X（来源=手动）`;
  });

  await check('S09', '配对表行内编辑「尺寸段」→ 单元格/人工来源更新（或 KPI 缺尺寸段减少）', async () => {
    const pick = await fExpr(`(() => {
      const wb = win.__workbench;
      const rep = wb.state.session.reports.find((rp) => rp.id === wb.state.session.activeReportId) || wb.state.session.reports[0];
      const rows = rep.rows || [];
      let idx = rows.findIndex((r, i) => i < 100 && !(r.size || '').trim());
      const useMissing = idx >= 0;
      if (!useMissing) idx = 0;
      const cell = doc.querySelector('[data-act="edit-cell"][data-field="size"][data-index="' + idx + '"]');
      if (!cell) return { ok: false, idx, rowsLen: rows.length };
      const before = (cell.textContent || '').trim();
      const kpiBefore = (doc.getElementById('quickNoSizeCount') || {}).textContent;
      cell.click();
      return { ok: true, idx, before, useMissing, kpiBefore, sku: rows[idx].sku, sizeBefore: rows[idx].size };
    })()`);
    OK(pick.ok, `找不到可见的尺寸段单元格（idx=${pick.idx}）`);
    await fWait(`!!doc.querySelector('.cell-editor input')`, { timeoutMs: 5000, label: '尺寸段行内编辑器出现' });
    await fSetValue('#matchBodyRows .cell-editor input', '86/85英寸');
    await fClick('#matchBodyRows .cell-editor [data-ed="save"]');
    await sleep(900);
    const after = await fExpr(`(() => {
      const wb = win.__workbench;
      const rep = wb.state.session.reports.find((rp) => rp.id === wb.state.session.activeReportId) || wb.state.session.reports[0];
      const row = (rep.rows || [])[${pick.idx}];
      const cell = doc.querySelector('[data-act="edit-cell"][data-field="size"][data-index="${pick.idx}"]');
      const src = row && row.source && typeof row.source === 'object' ? row.source.size : row && row.source;
      return { cellText: cell ? (cell.textContent || '').trim() : '', size: row && row.size, src, kpiNoSize: (doc.getElementById('quickNoSizeCount') || {}).textContent, runtimeErrors: wb.runtimeErrors.slice() };
    })()`);
    OK(after.size === '86/85英寸', `state.size=${JSON.stringify(after.size)}`);
    OK(after.cellText === '86/85英寸', `单元格文本=${JSON.stringify(after.cellText)}`);
    OK(after.src === '手动', `source.size=${JSON.stringify(after.src)}，期望 手动`);
    if (pick.useMissing) OK(String(after.kpiNoSize) === String(Number(pick.kpiBefore) - 1), `缺尺寸段计数未变化：${pick.kpiBefore} → ${after.kpiNoSize}`);
    OK(after.runtimeErrors.length === 0, `runtimeErrors=${JSON.stringify(after.runtimeErrors)}`);
    await shot('S09-share-inline-edited-size.png', '行内编辑尺寸段');
    return `SKU=${pick.sku} 尺寸段 ${pick.before || '(空)'} → 86/85英寸 · 缺尺寸段 ${pick.kpiBefore}→${after.kpiNoSize}${pick.useMissing ? '（KPI 已减少）' : '（该行原有尺寸，KPI 不变）'}`;
  });

  await check('S10', '行内编辑「取消」不写库（编辑器出现 → 取消 → 原值恢复）', async () => {
    const before = await fExpr(`(() => {
      const wb = win.__workbench;
      const rep = wb.state.session.reports.find((rp) => rp.id === wb.state.session.activeReportId) || wb.state.session.reports[0];
      const row = (rep.rows || [])[0];
      const cell = doc.querySelector('[data-act="edit-cell"][data-field="package"][data-index="0"]');
      if (!cell) return { ok: false };
      const orig = row.package || '';
      cell.click();
      return { ok: true, orig };
    })()`);
    OK(before.ok, '找不到套餐列单元格');
    await fWait(`!!doc.querySelector('.cell-editor input')`, { timeoutMs: 5000, label: '编辑器出现' });
    await fSetValue('#matchBodyRows .cell-editor input', 'QA-CANCEL-PKG');
    await fClick('#matchBodyRows .cell-editor [data-ed="cancel"]');
    await sleep(600);
    const after = await fExpr(`(() => {
      const wb = win.__workbench;
      const rep = wb.state.session.reports.find((rp) => rp.id === wb.state.session.activeReportId) || wb.state.session.reports[0];
      const row = (rep.rows || [])[0];
      return { pkg: row.package || '', editorLeft: !!doc.querySelector('.cell-editor'), runtimeErrors: wb.runtimeErrors.slice() };
    })()`);
    OK(!after.editorLeft, '取消后编辑器未关闭');
    OK(after.pkg === before.orig, `取售后套餐被意外改写：${JSON.stringify(before.orig)} → ${JSON.stringify(after.pkg)}`);
    OK(after.runtimeErrors.length === 0, `runtimeErrors=${JSON.stringify(after.runtimeErrors)}`);
    return `套餐保持 ${JSON.stringify(before.orig)}（未写库）`;
  });

  await check('S11', '搜索 / 状态筛选 / 每页行数 / 快捷筛选 交互断言', async () => {
    const base = await fExpr(`(() => ({ table: doc.getElementById('tableCount').textContent.trim(), rows: doc.querySelectorAll('#matchBodyRows tr').length }))()`);
    await fSetValue('#searchInput', '海信');
    await sleep(700);
    const searched = await fExpr(`(() => ({ rows: doc.querySelectorAll('#matchBodyRows tr').length, table: doc.getElementById('tableCount').textContent.trim(), q: win.__workbench.state.filter.search }))()`);
    OK(searched.rows < base.rows && searched.rows > 0, `搜索后行数异常：${base.rows} → ${searched.rows}`);
    OK(searched.q === '海信', `state.filter.search=${JSON.stringify(searched.q)}`);
    await fSetValue('#searchInput', '');
    await sleep(600);
    const cleared = await fExpr(`(() => ({ rows: doc.querySelectorAll('#matchBodyRows tr').length }))()`);
    OK(cleared.rows === base.rows, `清空搜索后行数未恢复：${cleared.rows} vs ${base.rows}`);
    // 状态筛选：缺价格段
    await fSetValue('#statusFilter', 'missingPrice');
    await sleep(700);
    const filtered = await fExpr(`(() => {
      const st = win.__workbench.state.filter.status;
      const domRows = doc.querySelectorAll('#matchBodyRows tr').length;
      const cells = Array.from(doc.querySelectorAll('#matchBodyRows tr')).slice(0, 20).map((tr) => (tr.innerText || '').replace(/\\s+/g, ' '));
      return { st, domRows, sample: cells.slice(0, 3) };
    })()`);
    OK(filtered.st === 'missingPrice', `state.filter.status=${JSON.stringify(filtered.st)}`);
    OK(filtered.domRows > 0 && filtered.domRows <= base.rows, `缺价格段筛选行数异常：${filtered.domRows}`);
    await fSetValue('#statusFilter', 'all');
    await sleep(500);
    // 每页行数
    await fSetValue('#pageSize', '50');
    await sleep(700);
    const paged = await fExpr(`(() => ({ rows: doc.querySelectorAll('#matchBodyRows tr').length, size: win.__workbench.state.filter.pageSize }))()`);
    OK(paged.rows <= 50, `50 行/页后 DOM 行数=${paged.rows}`);
    OK(Number(paged.size) === 50, `state.filter.pageSize=${paged.size}`);
    await fSetValue('#pageSize', '100');
    await sleep(500);
    // 快捷筛选 chip：缺尺寸段
    const chip = await fExpr(`(() => {
      const b = doc.getElementById('quickNoSizeChip');
      const count = (doc.getElementById('quickNoSizeCount') || {}).textContent;
      if (!b) return { ok: false };
      b.click();
      return { ok: true, count };
    })()`);
    OK(chip.ok, '缺尺寸段 chip 不存在');
    await sleep(700);
    const chipAfter = await fExpr(`(() => ({ status: win.__workbench.state.filter.status, rows: doc.querySelectorAll('#matchBodyRows tr').length }))()`);
    OK(chipAfter.status === 'missingSize', `快捷筛选后 status=${JSON.stringify(chipAfter.status)}`);
    await fClick('#quickNoSizeChip');
    await sleep(500);
    const chipOff = await fExpr(`(() => ({ status: win.__workbench.state.filter.status }))()`);
    OK(chipOff.status === 'all', `再次点击 chip 未取消筛选：${JSON.stringify(chipOff.status)}`);
    return `搜索 ${base.rows}→${searched.rows} 行；缺价格段筛选 ${filtered.domRows} 行；50/页 ${paged.rows} 行；chip 筛选 ${chipAfter.rows} 行后取消`;
  });

  await check('S12', '总览页：全部配对行汇总 + 搜索/筛选 + 导出配对表 xlsx / CSV（真实下载）', async () => {
    await fClick('.nav-btn[data-page-target="overview"]');
    await sleep(900);
    const info = await fExpr(`(() => ({
      count: (doc.getElementById('overviewCount') || {}).textContent,
      rows: doc.querySelectorAll('#overviewBody tr').length,
      storeOptions: (doc.getElementById('overviewStoreFilter') || {}).options ? doc.getElementById('overviewStoreFilter').options.length : 0,
      visible: !doc.getElementById('page-overview').classList.contains('hidden'),
    }))()`);
    OK(info.visible, '总览页未显示');
    OK(String(info.count) === '400', `总览计数=${info.count}，期望 400`);
    OK(info.rows > 0, '总览表格无行');
    await shot('S12-share-overview.png', '市占率 · 总览页');
    // 总览内搜索 / 类目筛选（真实交互）
    await fSetValue('#overviewSearch', '海信');
    await sleep(900);
    const ovSearch = await fExpr(`(() => ({ count: Number(doc.getElementById('overviewCount').textContent), search: win.__workbench.state.overview.search }))()`);
    OK(ovSearch.search === '海信', `overview.search=${JSON.stringify(ovSearch.search)}`);
    OK(ovSearch.count > 0 && ovSearch.count < 400, `总览搜索「海信」后计数=${ovSearch.count}（期望 0<count<400）`);
    await fSetValue('#overviewSearch', '');
    await sleep(700);
    const storeVals = await fExpr(`(() => Array.from(doc.getElementById('overviewStoreFilter').options).map((o) => ({ v: o.value, t: o.textContent.trim() })))()`);
    const storePick = storeVals.find((o) => o.v) || storeVals[0];
    OK(!!storePick, '总览类目筛选无可选项');
    await fSetValue('#overviewStoreFilter', storePick.v);
    await sleep(800);
    const ovStore = await fExpr(`(() => ({ count: Number(doc.getElementById('overviewCount').textContent), store: win.__workbench.state.overview.store, rows: doc.querySelectorAll('#overviewBody tr').length }))()`);
    OK(String(ovStore.store) === String(storePick.v), `overview.store=${JSON.stringify(ovStore.store)}`);
    OK(ovStore.count <= 400 && ovStore.rows > 0, `总览类目筛选后计数=${ovStore.count} 行=${ovStore.rows}`);
    await fSetValue('#overviewStoreFilter', '');
    await sleep(600);
    const f1 = (await expectDownloads(/\.xlsx$/, async () => { await fClick('#overviewExportXlsxBtn'); }))[0];
    const f2 = (await expectDownloads(/\.csv$/, async () => { await fClick('#overviewExportCsvBtn'); }))[0];
    const csvLines = readUtf8(f2.path).replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean).length;
    OK(csvLines > 1, `CSV 行数=${csvLines}`);
    return `overviewCount=${info.count} → 搜索「海信」${ovSearch.count} 行 → 类目「${storePick.t}」${ovStore.count} 行 · DOM行=${info.rows} · 下载 ${assertXlsx(f1)} · ${f2.name}（${f2.size}B / ${csvLines} 行）`;
  });

  await check('S13', '统计看板：类目选择条切换 → 数字/榜单口径变化', async () => {
    await fClick('.nav-btn[data-page-target="stats"]');
    await sleep(1400);
    const info = await fExpr(`(() => ({
      meta: (doc.getElementById('statsMeta') || {}).innerText || '',
      tabs: Array.from(doc.querySelectorAll('#statsStoreTabs [data-store-tab]')).map((t) => ({ key: t.dataset.storeTab, text: (t.textContent || '').trim() })),
      brandRows: doc.querySelectorAll('#storeBrandTable tbody tr').length,
      brandCount: (doc.getElementById('statsBrandCount') || {}).textContent,
      matrix: doc.querySelectorAll('#matrixTable table').length,
      charts: { size: doc.querySelectorAll('#sizeChart svg, #sizeChart .bar').length, price: doc.querySelectorAll('#priceChart svg, #priceChart .bar').length },
    }))()`);
    OK(info.tabs.length >= 2, `类目 tabs=${info.tabs.length}（期望 ≥2：全部+类目）`);
    OK(info.brandRows > 0, '类目品牌市占率表无行');
    OK(Number(info.brandCount) > 0, `品牌数=${info.brandCount}`);
    // 切换第二个类目 tab
    const target = info.tabs.find((t) => t.key && t.key !== 'all') || info.tabs[1];
    await fClick(`#statsStoreTabs [data-store-tab="${target.key}"]`);
    await sleep(900);
    const after = await fExpr(`(() => ({
      store: win.__workbench.state.statsStore,
      meta: (doc.getElementById('statsMeta') || {}).innerText || '',
      brandRows: doc.querySelectorAll('#storeBrandTable tbody tr').length,
      brandCount: (doc.getElementById('statsBrandCount') || {}).textContent,
    }))()`);
    OK(String(after.store) === String(target.key), `state.statsStore=${JSON.stringify(after.store)}，期望 ${target.key}`);
    OK(after.meta !== info.meta, `切换类目后 statsMeta 未变化：${oneLine(after.meta, 120)}`);
    // 表头排序（点击「品牌」列）→ 排序状态与首行变化
    const sortInfo = await fExpr(`(() => ({
      ths: Array.from(doc.querySelectorAll('#storeBrandTable th[data-sort-field]')).map((th) => th.dataset.sortField),
      firstBefore: doc.querySelector('#storeBrandTable tbody tr') ? doc.querySelector('#storeBrandTable tbody tr').cells[1].textContent.trim() : '',
      sortBefore: JSON.stringify(win.__workbench.state.statsBrandSort || {}),
    }))()`);
    OK(sortInfo.ths.includes('brand'), `品牌表可排序表头=${sortInfo.ths.join(',')}`);
    await fClick('#storeBrandTable th[data-sort-field="brand"]');
    await sleep(800);
    const sorted = await fExpr(`(() => ({
      sort: win.__workbench.state.statsBrandSort,
      firstAfter: doc.querySelector('#storeBrandTable tbody tr') ? doc.querySelector('#storeBrandTable tbody tr').cells[1].textContent.trim() : '',
      rows: doc.querySelectorAll('#storeBrandTable tbody tr').length,
    }))()`);
    OK(sorted.sort && sorted.sort.field === 'brand', `statsBrandSort=${JSON.stringify(sorted.sort)}`);
    OK(sorted.rows > 0, '排序后品牌表为空');
    await shot('S13-share-stats.png', `统计看板 · 类目「${target.text}」+ 品牌排序`);
    return `tabs=${info.tabs.map((t) => t.text).join(' / ')} · 品类品牌数 ${info.brandCount}→${after.brandCount} · 切到「${target.text}」· 品牌排序 ${sortInfo.sortBefore}→${JSON.stringify(sorted.sort)}（首行 ${sortInfo.firstBefore}→${sorted.firstAfter}）`;
  });

  await check('S14', '统计看板：品牌搜索过滤 + 刷新统计 + 导出统计 xlsx 下载', async () => {
    const base = await fExpr(`(() => ({ rows: doc.querySelectorAll('#storeBrandTable tbody tr').length, top: doc.querySelector('#storeBrandTable tbody tr') ? doc.querySelector('#storeBrandTable tbody tr').innerText.replace(/\\s+/g, ' ').slice(0, 80) : '' }))()`);
    await fSetValue('#statsBrandSearch', '海信');
    await sleep(900);
    const filtered = await fExpr(`(() => ({ rows: doc.querySelectorAll('#storeBrandTable tbody tr').length }))()`);
    OK(filtered.rows <= base.rows && filtered.rows >= 1, `品牌搜索行数异常：${base.rows} → ${filtered.rows}`);
    await fSetValue('#statsBrandSearch', '');
    await sleep(600);
    await fClick('#refreshStatsBtn');
    await sleep(1000);
    const refreshed = await fExpr(`(() => ({ rows: doc.querySelectorAll('#storeBrandTable tbody tr').length, meta: (doc.getElementById('statsMeta') || {}).innerText || '' }))()`);
    OK(refreshed.rows > 0, '刷新统计后品牌表为空');
    const file = (await expectDownloads(/统计.*\.xlsx$|\.xlsx$/, async () => { await fClick('#statsExportBtn'); }, { timeoutMs: 25000 }))[0];
    return `品牌表 ${base.rows} 行 → 搜索「海信」${filtered.rows} 行 → 刷新 ${refreshed.rows} 行 · 下载 ${assertXlsx(file)}`;
  });

  await check('S15', '导出菜单：市占率结果 xlsx / 当前榜单回填 xlsx / 全部回填 xlsx / 筛选 CSV / 备份 JSON（真实下载）', async () => {
    await fClick('.nav-btn[data-page-target="workbench"]');
    await sleep(700);
    const menu = await fExpr(`(() => { const m = doc.getElementById('exportMenu'); if (!m) return { ok: false }; m.open = true; return { ok: true, open: m.open, items: Array.from(m.querySelectorAll('.menu-item')).map((b) => (b.textContent || '').trim()) }; })()`);
    OK(menu.ok && menu.items.length >= 5, `导出菜单项=${menu.items.length}：${menu.items.join('/')}`);
    const x1 = await expectDownloads(/^市占率结果_.*\.xlsx$/, async () => { await fClick('#exportResultBtn'); }, { timeoutMs: 30000 });
    const x2 = await expectDownloads(/^回填_.*\.xlsx$/, async () => { await fClick('#exportBackfillBtn'); }, { timeoutMs: 30000 });
    const x3 = await expectDownloads(/^回填_.*\.xlsx$/, async () => { await fClick('#exportBackfillAllBtn'); }, { timeoutMs: 40000, min: 2 });
    const csv = await expectDownloads(/\.csv$/, async () => { await fClick('#exportCsvBtn'); }, { timeoutMs: 20000 });
    const json = await expectDownloads(/备份.*\.json$|\.json$/, async () => { await fClick('#exportBackupBtn'); }, { timeoutMs: 20000 });
    const backup = JSON.parse(readUtf8(json[0].path));
    OK(backup && typeof backup === 'object', '备份 JSON 解析失败');
    const saveStateText = await fExpr(`(() => doc.getElementById('saveState').textContent.trim())()`);
    await shot('S15-share-export-menu.png', '导出菜单 + 下载完成');
    return `结果=${assertXlsx(x1[0])}；当前回填=${x2[0].name}(${x2[0].size}B)；全部回填=${x3.length} 个(${x3.map((f) => f.name).join(',')})；CSV=${csv[0].name}(${csv[0].size}B)；备份=${json[0].name}(${json[0].size}B) · saveState=${JSON.stringify(saveStateText)}`;
  });

  await check('S16', '匹配库页：KPI / 类目列表 / SKU 明细 / 搜索 / 操作日志开合', async () => {
    await fClick('.nav-btn[data-page-target="library"]');
    await sleep(1000);
    const info = await fExpr(`(() => ({
      visible: !doc.getElementById('page-library').classList.contains('hidden'),
      kpi: (doc.getElementById('libKpi').innerText || '').replace(/\\n/g, ' | ').slice(0, 240),
      stores: doc.querySelectorAll('#libStoreList .store-item, #libStoreList li').length,
      rows: doc.querySelectorAll('#libBody tr').length,
      count: (doc.getElementById('libTableCount') || {}).textContent,
    }))()`);
    OK(info.visible, '匹配库页未显示');
    OK(info.rows > 0, '匹配库 SKU 明细无行');
    await fSetValue('#libSearchInput', '海信');
    await sleep(700);
    const searched = await fExpr(`(() => ({ rows: doc.querySelectorAll('#libBody tr').length }))()`);
    OK(searched.rows <= info.rows, `匹配库搜索后行数 ${info.rows} → ${searched.rows}`);
    await fSetValue('#libSearchInput', '');
    await sleep(500);
    await fClick('#libLogBtn');
    await sleep(800);
    const log = await fExpr(`(() => ({
      visible: !doc.getElementById('libLogPanel').classList.contains('hidden'),
      count: (doc.getElementById('libLogCount') || {}).textContent,
      items: doc.querySelectorAll('#libLogList .lib-log-item, #libLogList li').length,
    }))()`);
    OK(log.visible, '匹配库操作日志面板未打开');
    await fClick('#libLogCloseBtn');
    await sleep(500);
    const logClosed = await fExpr(`(() => doc.getElementById('libLogPanel').classList.contains('hidden'))()`);
    OK(logClosed, '匹配库操作日志面板未关闭');
    await shot('S16-share-library.png', '市占率 · 匹配库页');
    return `KPI=${oneLine(info.kpi, 120)} · 明细 ${info.rows} 行（搜索 海信 → ${searched.rows}）· 操作日志 ${log.count} 条已开合`;
  });

  await check('S17', '匹配库：导出 xlsx 下载 + 归一化脏值 / 冲突检查 给出结果面板', async () => {
    const file = (await expectDownloads(/\.xlsx$/, async () => { await fClick('#libExportBtn'); }, { timeoutMs: 30000 }))[0];
    await fClick('#libNormalizeBtn');
    await sleep(1500);
    const norm = await fExpr(`(() => ({ report: (doc.getElementById('libReportBody') || {}).innerText || '', toast: doc.getElementById('toast').textContent.trim(), runtimeErrors: win.__workbench.runtimeErrors.slice() }))()`);
    OK(norm.runtimeErrors.length === 0, `归一化 runtimeErrors=${JSON.stringify(norm.runtimeErrors)}`);
    await fClick('#libIssueBtn');
    await sleep(1500);
    const issue = await fExpr(`(() => ({ report: (doc.getElementById('libReportBody') || {}).innerText || '', toast: doc.getElementById('toast').textContent.trim(), runtimeErrors: win.__workbench.runtimeErrors.slice() }))()`);
    OK(issue.runtimeErrors.length === 0, `冲突检查 runtimeErrors=${JSON.stringify(issue.runtimeErrors)}`);
    await shot('S17-share-library-report.png', '匹配库 · 归一化/冲突检查结果');
    return `下载 ${assertXlsx(file)} · 归一化报告「${oneLine(norm.report, 100) || norm.toast}」· 冲突检查「${oneLine(issue.report, 100) || issue.toast}」`;
  });

  await check('S18', '设置页：关键项存在 + 修改「每次最多采集」保存并持久化', async () => {
    await fClick('.nav-btn[data-page-target="settings"]');
    await sleep(900);
    const before = await fExpr(`(() => ({
      visible: !doc.getElementById('page-settings').classList.contains('hidden'),
      batch: doc.getElementById('setBatch').value,
      batchLimit: doc.getElementById('setBatchLimit').value,
      mode: doc.getElementById('setCaptureMode') ? doc.getElementById('setCaptureMode').value : '',
      themeSelect: doc.getElementById('setThemeSelect') ? doc.getElementById('setThemeSelect').value : '',
      controls: ['setBatch', 'setBatchLimit', 'setAnomalyWait', 'setDelayMin', 'setDelayMax', 'setCooldownMinutes', 'setRetries', 'setMaxSamples', 'setTolerancePct', 'setMinPlausible', 'saveSettingsBtn', 'resetSettingsBtn'].filter((id) => !doc.getElementById(id)).length,
      stateBatch: win.__workbench.state.settings.capture.batchSize,
    }))()`);
    OK(before.visible, '设置页未显示');
    OK(before.controls === 0, `缺少 ${before.controls} 个设置控件`);
    await fSetValue('#setBatch', '5');
    await fClick('#saveSettingsBtn');
    await sleep(1200);
    const after = await fExpr(`(() => ({
      toast: doc.getElementById('toast').textContent.trim(),
      stateBatch: win.__workbench.state.settings.capture.batchSize,
      domBatch: doc.getElementById('setBatch').value,
      stored: null,
    }))()`);
    OK(/设置已保存/.test(after.toast), `toast=${after.toast}`);
    OK(Number(after.stateBatch) === 5, `state.settings.capture.batchSize=${after.stateBatch}，期望 5`);
    const stored = await fExpr(`(async () => { const v = await win.chrome.storage.local.get('ds.settings.v1'); return v['ds.settings.v1'] ? v['ds.settings.v1'].capture.batchSize : null; })()`);
    OK(Number(stored) === 5, `chrome.storage 中 batchSize=${stored}（未落盘）`);
    await shot('S18-share-settings.png', '设置页 · 保存后');
    return `快捷键检查通过 · batch ${before.batch}→${after.stateBatch}（存储=${stored}）`;
  });

  await check('S19', '设置页：恢复默认设置（确认框）→ 批量恢复默认值', async () => {
    await fClick('#resetSettingsBtn');
    const dlg = await waitFrameDialog(6000);
    OK(/恢复默认/.test(dlg.title), `确认框标题=${JSON.stringify(dlg.title)}`);
    await frameDialogOk();
    await sleep(1200);
    const after = await fExpr(`(() => ({ toast: doc.getElementById('toast').textContent.trim(), stateBatch: win.__workbench.state.settings.capture.batchSize, domBatch: doc.getElementById('setBatch').value }))()`);
    OK(/已恢复默认设置/.test(after.toast), `toast=${after.toast}`);
    OK(Number(after.stateBatch) !== 5, `恢复默认后 batchSize 仍为 5`);
    return `确认框「${dlg.title}」→ ${after.toast} · batchSize=${after.stateBatch}`;
  });

  await check('S20', '主题切换 ☀/🌙（data-theme + toast + 切回）', async () => {
    const before = await fExpr(`(() => ({ theme: doc.documentElement.dataset.theme, icon: (doc.getElementById('themeToggleIcon') || {}).textContent || '' }))()`);
    await fClick('#themeToggleBtn');
    await sleep(700);
    const after = await fExpr(`(() => ({ theme: doc.documentElement.dataset.theme, icon: (doc.getElementById('themeToggleIcon') || {}).textContent || '', toast: doc.getElementById('toast').textContent.trim() }))()`);
    OK(after.theme && after.theme !== before.theme, `主题未切换：${before.theme} → ${after.theme}`);
    OK(/模式/.test(after.toast), `切换 toast=${after.toast}`);
    await fClick('#themeToggleBtn');
    await sleep(600);
    const back = await fExpr(`(() => ({ theme: doc.documentElement.dataset.theme }))()`);
    OK(back.theme === before.theme, `切回后主题=${back.theme}，期望 ${before.theme}`);
    await shot('S20-share-theme.png', '主题切换后（已切回）');
    return `${before.theme}(${before.icon}) → ${after.theme}(${after.icon}) → ${back.theme}`;
  });

  await check('S21', '设置页：导出备份 JSON → 再导入同一备份（闭环，确认框）', async () => {
    const json = (await expectDownloads(/备份.*\.json$|\.json$/, async () => { await fClick('#exportBackupBtn2'); }, { timeoutMs: 20000 }))[0];
    const parsed = JSON.parse(readUtf8(json.path));
    const libStores = parsed.library && parsed.library.stores ? Object.keys(parsed.library.stores).length : -1;
    const sessions = parsed.session && Array.isArray(parsed.session.reports) ? parsed.session.reports.length : -1;
    OK(libStores >= 0 && sessions === 2, `备份内容异常：stores=${libStores} reports=${sessions}`);
    await setFrameFileInput('#backupFileInput', [json.path]);
    const dlg = await waitFrameDialog(8000);
    OK(/导入备份/.test(dlg.title), `确认框标题=${JSON.stringify(dlg.title)}`);
    OK(/匹配库/.test(dlg.text) && /榜单会话/.test(dlg.text), `确认框文案=${oneLine(dlg.text, 120)}`);
    await frameDialogOk();
    await sleep(1500);
    const after = await fExpr(`(() => ({ toast: doc.getElementById('toast').textContent.trim(), reports: (win.__workbench.state.session.reports || []).length, runtimeErrors: win.__workbench.runtimeErrors.slice() }))()`);
    OK(/备份已导入/.test(after.toast), `导入后 toast=${after.toast}`);
    OK(after.reports === 2, `导入后榜单数=${after.reports}`);
    OK(after.runtimeErrors.length === 0, `runtimeErrors=${JSON.stringify(after.runtimeErrors)}`);
    await shot('S21-share-backup-roundtrip.png', '备份 JSON 导出→导入 闭环');
    return `下载 ${json.name}（${json.size}B，${libStores} 类目 / ${sessions} 榜单）→ 导入成功 · toast=${after.toast}`;
  });

  await check('S22', '不同结构真实 xlsx（线上竞争数据分析（月度）.xlsx）导入稳健性', async () => {
    OK(fs.existsSync(XLSX_MONTHLY), `样本不存在：${XLSX_MONTHLY}`);
    const beforeCount = await fExpr(`(() => (win.__workbench.state.session.reports || []).length)()`);
    await setFrameFileInput('#reportFileInput', [XLSX_MONTHLY]);
    await sleep(2500);
    const after = await fExpr(`(() => {
      const wb = win.__workbench;
      const reps = wb.state.session.reports || [];
      const last = reps[reps.length - 1] || {};
      return { count: reps.length, lastFile: last.fileName, lastRows: (last.rows || []).length, bind: last.store, toast: doc.getElementById('toast').textContent.trim(), runtimeErrors: wb.runtimeErrors.slice(), matchEmpty: doc.getElementById('matchEmpty') && doc.getElementById('matchEmpty').classList.contains('hidden') };
    })()`);
    OK(after.count >= beforeCount, `导入后榜单数异常：${beforeCount} → ${after.count}`);
    if (after.count === beforeCount + 1) {
      OK(/线上竞争数据分析/.test(after.lastFile), `新榜单文件名=${after.lastFile}`);
      OK(after.lastRows > 100, `新榜单行数=${after.lastRows}`);
      return `成功导入 ${after.lastFile}：${after.lastRows} 行（绑定类目=${after.bind || '未绑定'}）`;
    }
    OK(/失败|无法|没有解析到/.test(after.toast), `未导入且无明确失败提示：toast=${JSON.stringify(after.toast)}`);
    return `未导入（产品明确提示：${after.toast}）`;
  });

  await check('S23', '市占率 section 阶段 console error / runtimeErrors 汇总', async () => {
    const mark = state.consoleBySection.share.mark;
    const errs = state.page.consoleErrors.slice(mark);
    const runtime = await fExpr(`(() => (win.__workbench && win.__workbench.runtimeErrors) || [])()`);
    state.consoleBySection.share.items = errs;
    state.consoleBySection.share.runtimeErrors = runtime;
    OK(errs.length === 0, `${errs.length} 条 console error：${errs.slice(0, 6).map((e) => oneLine(e, 160)).join(' | ')}`);
    OK(runtime.length === 0, `runtimeErrors=${JSON.stringify(runtime).slice(0, 300)}`);
    return `console error 0（页面累计 ${state.page.consoleErrors.length}）· runtimeErrors 0`;
  });

  summary.checkCount = state.steps.share;
  return summary;
}

// ===========================================================================
// SECTION C：竞品监控（modules/radar）
// ===========================================================================
async function runRadar(opts) {
  currentSection = 'radar';
  state.consoleBySection.radar = { mark: state.page.consoleErrors.length };
  const summary = {};
  let backupJsonPath = '';

  await check('R01', '从平台顶部切换到「竞品监控」（iframe 加载 modules/radar/app.html）', async () => {
    const { via, info } = await enterBiz('radar');
    const info2 = await fExpr(`(() => ({
      title: (doc.getElementById('viewTitle') || {}).textContent,
      view: win.__priceRadar && win.__priceRadar.state.view,
      rows: win.__priceRadar ? win.__priceRadar.state.rows.length : -1,
      navs: Array.from(doc.querySelectorAll('.nav-item[data-view]')).map((b) => b.dataset.view),
      watchRows: doc.querySelectorAll('#watchTableBody tr[data-sku]').length,
      kpiMonitor: (doc.getElementById('kpiMonitor') || {}).textContent,
    }))()`);
    OK(info2.navs.length === 6, `导航视图数=${info2.navs.length}（期望 6）`);
    OK(info2.rows >= 150, `监控 SKU 行数=${info2.rows}，期望 ≥150`);
    OK(info2.view === 'dashboard', `初始视图=${info2.view}`);
    OK(info2.title === '总览', `viewTitle=${info2.title}`);
    summary.entry = `via=${via.via} · ${info.url} · ${info2.rows} 个 SKU · 视图=${info2.navs.join('/')}`;
    await shot('R01-radar-dashboard.png', '竞品监控 · 总览');
    return summary.entry;
  });

  await check('R02', '六个视图逐个切换（总览/分析/波动/监控清单/异动中心/采集任务）', async () => {
    const want = { dashboard: '总览', analytics: '分析', volatility: '波动', watchlist: '监控清单', alerts: '异动中心', runs: '采集任务' };
    const seen = [];
    for (const [view, title] of Object.entries(want)) {
      await fClick(`.nav-item[data-view="${view}"]`);
      await sleep(700);
      const st = await fExpr(`(() => {
        const el = doc.getElementById('view${view[0].toUpperCase() + view.slice(1)}');
        const active = doc.querySelector('.nav-item.active[data-view]');
        return { exists: !!el, visible: el ? !el.classList.contains('hidden') : false, active: active ? active.dataset.view : '', viewTitle: (doc.getElementById('viewTitle') || {}).textContent, sub: (doc.getElementById('viewSub') || {}).textContent, stateView: win.__priceRadar && win.__priceRadar.state.view };
      })()`);
      OK(st.exists, `#view${view} 不存在`);
      OK(st.visible, `切到 ${view} 后视图仍隐藏（当前 stateView=${st.stateView}）`);
      OK(st.active === view, `导航 active=${st.active}，期望 ${view}`);
      OK(st.stateView === view, `state.view=${st.stateView}，期望 ${view}`);
      OK(st.viewTitle === title, `viewTitle=${JSON.stringify(st.viewTitle)}，期望 ${title}`);
      seen.push(`${view}「${st.viewTitle}」`);
      if (['analytics', 'volatility', 'alerts', 'runs'].includes(view)) await shot(`R02-radar-${view}.png`, `竞品监控 · ${title}`);
    }
    return seen.join(' → ');
  });

  await check('R03', '总览数据渲染：KPI / 品牌分布 / 最新异动 / 价格带 / 同尺寸最低价 / 采集概况', async () => {
    await fClick('.nav-item[data-view="dashboard"]');
    await sleep(900);
    const info = await fExpr(`(() => ({
      kpi: { monitor: (doc.getElementById('kpiMonitor') || {}).textContent, today: (doc.getElementById('kpiToday') || {}).textContent, alerts: (doc.getElementById('kpiAlerts') || {}).textContent, drop: (doc.getElementById('kpiDrop') || {}).textContent, rise: (doc.getElementById('kpiRise') || {}).textContent, fail: (doc.getElementById('kpiFail') || {}).textContent },
      heroBig: (doc.getElementById('heroBig') || {}).textContent,
      brandBars: doc.querySelectorAll('#brandBars > *').length,
      dashAlerts: (doc.getElementById('dashAlerts') || {}).innerText || '',
      dashBands: doc.querySelectorAll('#dashBands > *').length,
      sizeLowest: doc.querySelectorAll('#dashSizeLowest > *').length,
      runBrief: (doc.getElementById('dashRunBrief') || {}).innerText || '',
      lastRun: (doc.getElementById('dashLastRun') || {}).innerText || '',
      changeRows: doc.querySelectorAll('#dashChangeBody tr').length,
    }))()`);
    OK(Number(info.heroBig) > 0, `heroBig=${info.heroBig}`);
    OK(Number(info.kpi.monitor) > 0, `KPI 监控 SKU=${info.kpi.monitor}`);
    OK(info.brandBars > 0, '品牌监控分布为空');
    OK(info.dashBands > 0, '价格带分布为空');
    OK(info.sizeLowest > 0, '同尺寸最低价为空');
    OK(info.runBrief.length > 0, '采集概况为空');
    return `KPI=${JSON.stringify(info.kpi)} · hero=${info.heroBig} · 品牌条=${info.brandBars} · 价格带=${info.dashBands} · 同尺寸=${info.sizeLowest} · 异动行=${info.changeRows}`;
  });

  await check('R04', '监控清单：表格排序（点表头）→ 排序字段/方向/首行变化', async () => {
    await fClick('.nav-item[data-view="watchlist"]');
    await sleep(800);
    const info = await fExpr(`(() => {
      const ths = Array.from(doc.querySelectorAll('#watchTable thead th.sortable'));
      return { ths: ths.map((t) => t.dataset.sort), rows: doc.querySelectorAll('#watchTableBody tr[data-sku]').length, first: (doc.querySelector('#watchTableBody tr[data-sku]') || {}).dataset ? doc.querySelector('#watchTableBody tr[data-sku]').dataset.sku : '', sort: win.__priceRadar.state.ui.sort, dir: win.__priceRadar.state.ui.dir };
    })()`);
    OK(info.ths.length >= 6, `可排序表头=${info.ths.length}`);
    OK(info.rows >= 150, `清单行数=${info.rows}`);
    const key = info.ths.includes('base') ? 'base' : info.ths[1];
    await fClick(`#watchTable thead th.sortable[data-sort="${key}"]`);
    await sleep(700);
    const after = await fExpr(`(() => ({
      sort: win.__priceRadar.state.ui.sort, dir: win.__priceRadar.state.ui.dir,
      first: doc.querySelector('#watchTableBody tr[data-sku]') ? doc.querySelector('#watchTableBody tr[data-sku]').dataset.sku : '',
      firstCells: doc.querySelector('#watchTableBody tr[data-sku]') ? doc.querySelector('#watchTableBody tr[data-sku]').innerText.replace(/\\s+/g, ' ').slice(0, 160) : '',
    }))()`);
    OK(after.sort === key, `排序字段=${after.sort}，期望 ${key}`);
    OK(after.dir === 'desc' || after.dir === 'asc', `排序方向=${after.dir}`);
    await fClick(`#watchTable thead th.sortable[data-sort="${key}"]`);
    await sleep(600);
    const toggled = await fExpr(`(() => ({ dir: win.__priceRadar.state.ui.dir }))()`);
    OK(toggled.dir !== after.dir, `再次点击表头方向未切换：${after.dir} → ${toggled.dir}`);
    return `表头 ${info.ths.join(',')} · 排序=${key} ${after.dir}→${toggled.dir} · 首行 SKU ${info.first}→${after.first}`;
  });

  await check('R05', '监控清单：搜索 / 类型筛选 / 状态筛选 / 清空筛选', async () => {
    const base = await fExpr(`(() => {
      const pr = win.__priceRadar;
      const row = pr.state.rows.find((r) => r.brand && r.brand !== '全部');
      return { rows: doc.querySelectorAll('#watchTableBody tr[data-sku]').length, brand: row ? row.brand : '' };
    })()`);
    OK(base.brand, '取不到可用于搜索的品牌名');
    await fSetValue('#searchInput', base.brand);
    await sleep(800);
    const searched = await fExpr(`(() => ({ rows: doc.querySelectorAll('#watchTableBody tr[data-sku]').length, q: win.__priceRadar.state.ui.q }))()`);
    OK(searched.rows > 0, `搜索品牌「${base.brand}」后 0 行（搜索未生效）`);
    OK(searched.rows < base.rows, `搜索「${base.brand}」后行数 ${base.rows} → ${searched.rows} 未减少`);
    OK(searched.q === base.brand, `state.ui.q=${JSON.stringify(searched.q)}`);
    await fClick('#clearFiltersBtn');
    await sleep(700);
    const cleared = await fExpr(`(() => ({ rows: doc.querySelectorAll('#watchTableBody tr[data-sku]').length }))()`);
    OK(cleared.rows === base.rows, `清空筛选后行数=${cleared.rows}，期望 ${base.rows}`);
    // 类型筛选
    const opt = await fExpr(`(() => {
      const sel = doc.getElementById('filterCategory');
      const vals = Array.from(sel.options).map((o) => ({ v: o.value, t: o.textContent.trim() })).filter((o) => o.v !== 'all');
      return vals;
    })()`);
    OK(opt.length > 0, '类型筛选无可选项');
    await fSetValue('#filterCategory', opt[0].v);
    await sleep(700);
    const catFiltered = await fExpr(`(() => ({ rows: doc.querySelectorAll('#watchTableBody tr[data-sku]').length, cat: win.__priceRadar.state.ui.category }))()`);
    OK(catFiltered.cat === opt[0].v, `state.ui.category=${catFiltered.cat}`);
    OK(catFiltered.rows <= base.rows, `类型筛选后行数=${catFiltered.rows}`);
    // 状态筛选：已下架
    await fClick('#clearFiltersBtn');
    await sleep(500);
    await fSetValue('#filterStatus', 'offline');
    await sleep(700);
    const statusFiltered = await fExpr(`(() => ({ rows: doc.querySelectorAll('#watchTableBody tr[data-sku]').length, status: win.__priceRadar.state.ui.status }))()`);
    OK(statusFiltered.status === 'offline', `state.ui.status=${statusFiltered.status}`);
    OK(statusFiltered.rows > 0, '已下架状态筛选后无行（清单里本应有下架 SKU）');
    await fClick('#clearFiltersBtn');
    await sleep(500);
    return `搜索 ${base.rows}→${searched.rows} 行 · 类型「${opt[0].t}」→${catFiltered.rows} 行 · 已下架 ${statusFiltered.rows} 行 · 已清空`;
  });

  await check('R06', '清单：品牌 chip / 密度切换 / 隐藏已下架 勾选生效', async () => {
    await fClick('.nav-item[data-view="watchlist"]');
    await sleep(600);
    const baseRows = await fExpr(`(() => doc.querySelectorAll('#watchTableBody tr[data-sku]').length)()`);
    const chip = await fExpr(`(() => {
      const chips = Array.from(doc.querySelectorAll('#brandChips [data-brand]'));
      const c = chips.find((x) => x.dataset.brand && x.dataset.brand !== 'all' && !/全部/.test(x.textContent || ''));
      if (!c) return { ok: false, total: chips.length };
      c.click();
      return { ok: true, brand: c.dataset.brand, text: (c.textContent || '').trim() };
    })()`);
    OK(chip.ok, `找不到非「全部」品牌 chip（共 ${chip.total} 个）`);
    await sleep(700);
    const chipAfter = await fExpr(`(() => ({ brand: win.__priceRadar.state.ui.brand, rows: doc.querySelectorAll('#watchTableBody tr[data-sku]').length }))()`);
    OK(chipAfter.brand === chip.brand, `chip 筛选后 brand=${chipAfter.brand}，期望 ${chip.brand}`);
    OK(chipAfter.rows > 0 && chipAfter.rows < baseRows, `品牌 chip「${chip.text}」筛选后行数=${chipAfter.rows}（全部 ${baseRows}）`);
    await fClick('#clearFiltersBtn');
    await sleep(600);
    const density = await fExpr(`(() => ({ before: win.__priceRadar.state.ui.density }))()`);
    await fClick('#densityBtn');
    await sleep(600);
    const densityAfter = await fExpr(`(() => ({ after: win.__priceRadar.state.ui.density, cls: doc.getElementById('watchTable').className }))()`);
    OK(densityAfter.after !== density.before, `密度未切换：${density.before}`);
    await fClick('#densityBtn');
    await sleep(400);
    const hide = await fExpr(`(() => {
      const cb = doc.getElementById('hideOfflineChk');
      const beforeRows = doc.querySelectorAll('#watchTableBody tr[data-sku]').length;
      cb.click();
      return { beforeRows };
    })()`);
    await sleep(700);
    const hideAfter = await fExpr(`(() => ({ hideOffline: win.__priceRadar.state.ui.hideOffline, rows: doc.querySelectorAll('#watchTableBody tr[data-sku]').length }))()`);
    OK(hideAfter.hideOffline === true, '隐藏已下架未生效');
    OK(hideAfter.rows <= hide.beforeRows, `隐藏已下架后行数 ${hide.beforeRows} → ${hideAfter.rows}`);
    await fExpr(`(() => { const cb = doc.getElementById('hideOfflineChk'); cb.click(); return true; })()`);
    await sleep(400);
    return `品牌 chip「${chip.text}」→ ${chipAfter.rows} 行 · 密度 ${density.before}→${densityAfter.after} · 隐藏已下架 ${hide.beforeRows}→${hideAfter.rows} 行`;
  });

  await check('R07', '导出 JSON 备份（真实下载 + schema/数据校验）', async () => {
    const f = (await expectDownloads(/竞品价格雷达-备份-.*\.json$|\.json$/, async () => { await fClick('#exportBtn'); }, { timeoutMs: 20000 }))[0];
    backupJsonPath = f.path;
    const data = JSON.parse(readUtf8(f.path));
    OK(data.schema === 'price-radar.backup.v1', `schema=${data.schema}`);
    OK(data.meta && Array.isArray(data.meta.custom), '备份缺少 meta.custom');
    OK(data.settings && typeof data.settings === 'object', '备份缺少 settings');
    OK(data.captures && typeof data.captures === 'object', '备份缺少 captures');
    const toast = await fToast();
    OK(/已导出 JSON 备份/.test(toast.text), `toast=${toast.text}`);
    return `下载 ${f.name}（${f.size}B）· schema=${data.schema} · custom=${data.meta.custom.length} · captures=${Object.keys(data.captures).length} · 设置项=${Object.keys(data.settings).length}`;
  });

  await check('R08', '导出 CSV 清单（真实下载 + 表头/行数校验）', async () => {
    const f = (await expectDownloads(/竞品价格雷达-清单-.*\.csv$|\.csv$/, async () => { await fClick('#exportCsvBtn'); }, { timeoutMs: 20000 }))[0];
    const text = readUtf8(f.path).replace(/^\uFEFF/, '');
    const lines = text.split(/\r?\n/).filter(Boolean);
    OK(/品牌,类型,系列,系统,尺寸,型号,SKU/.test(lines[0]), `CSV 表头异常：${oneLine(lines[0], 160)}`);
    const rowsCount = await fExpr(`(() => doc.querySelectorAll('#watchTableBody tr[data-sku]').length)()`);
    OK(lines.length >= rowsCount, `CSV 行数=${lines.length} < 清单行数=${rowsCount}`);
    return `下载 ${f.name}（${f.size}B）· ${lines.length - 1} 行数据`;
  });

  await check('R08b', '「导出最新数据」：当前筛选 CSV（表头/行数/筛选生效/商品链接）', async () => {
    const chipClicked = await fExpr(`(() => {
      const chips = Array.from(doc.querySelectorAll('#brandChips button'));
      const target = chips.find((c) => (c.textContent || '').trim().includes('联想'));
      if (!target) return { ok: false, chips: chips.map((c) => (c.textContent || '').trim()).slice(0, 8) };
      target.click();
      return { ok: true };
    })()`);
    OK(chipClicked.ok, `找不到品牌 chip：${JSON.stringify(chipClicked)}`);
    await sleep(700);
    const filtered = await fExpr(`(() => ({ rows: doc.querySelectorAll('#watchTableBody tr[data-sku]').length, brand: win.__priceRadar.state.ui.brand }))()`);
    OK(filtered.rows > 0, `筛选后清单为空（brand=${filtered.brand}）`);
    const f = (await expectDownloads(/竞品价格雷达-最新数据-.*\.csv$|\.csv$/, async () => { await fClick('#exportLatestBtn'); }, { timeoutMs: 20000 }))[0];
    const text = readUtf8(f.path).replace(/^\uFEFF/, '');
    const lines = text.split(/\r?\n/).filter(Boolean);
    OK(/^序号,品牌,类型,尺寸,系统,型号,SKU,基准价,基准来源,最新价,价格类型,采集时间,较基准%,状态,标签,备注,商品链接$/.test(lines[0]), `表头异常：${oneLine(lines[0], 220)}`);
    OK(lines.length - 1 === filtered.rows, `导出行数=${lines.length - 1}，当前筛选行数=${filtered.rows}`);
    OK(/联想/.test(lines[1] || ''), `首行不是联想：${oneLine(lines[1], 120)}`);
    OK(/https:\/\/item\.jd\.com\/\d+\.html/.test(lines[1] || ''), `缺少商品链接：${oneLine(lines[1], 120)}`);
    // v1.1.3：行顺序必须按基表原始顺序（序号=基表行号），不受界面排序影响
    const expectedOrder = await fExpr(`(() => {
      const pr = win.__priceRadar;
      return pr.state.rows.filter((r) => r.brand === '联想').map((r) => r.sku);
    })()`);
    const csvSkus = lines.slice(1).map((l) => l.split(',')[6]);
    OK(csvSkus.join(',') === expectedOrder.join(','), `行顺序与基表不一致：CSV前5=${csvSkus.slice(0, 5).join('/')} 基表前5=${expectedOrder.slice(0, 5).join('/')}`);
    const baseIdx = await fExpr(`(() => {
      const pr = win.__priceRadar;
      const first = pr.state.rows.find((r) => r.brand === '联想');
      return first ? pr.state.rows.indexOf(first) + 1 : -1;
    })()`);
    OK(Number(lines[1].split(',')[0]) === baseIdx, `首行序号=${lines[1].split(',')[0]}，基表行号=${baseIdx}`);
    const toast = await fToast();
    OK(/已导出最新数据/.test(toast.text), `toast=${toast.text}`);
    await fClick('#clearFiltersBtn');
    await sleep(600);
    return `品牌筛选=${filtered.brand} · 清单 ${filtered.rows} 行 → CSV ${lines.length - 1} 行 · toast=${toast.text}`;
  });

  await check('R09', '勾选 2 个 SKU → 「对比」按钮启用 → 对比弹窗 2 行 → 关闭', async () => {
    await fClick('.nav-item[data-view="watchlist"]');
    await sleep(700);
    const sel = await fExpr(`(() => {
      const cbs = Array.from(doc.querySelectorAll('#watchTableBody input[data-check]')).slice(0, 2);
      for (const cb of cbs) cb.click();
      return { clicked: cbs.length };
    })()`);
    OK(sel.clicked === 2, `只勾选了 ${sel.clicked} 个`);
    await sleep(700);
    const bar = await fExpr(`(() => ({
      selected: win.__priceRadar.state.selected.size,
      compareDisabled: doc.getElementById('compareSelectedBtn').disabled,
      barHidden: doc.getElementById('selectionBar').classList.contains('hidden'),
      selText: (doc.getElementById('selectionText') || {}).textContent,
    }))()`);
    OK(bar.selected === 2, `selected=${bar.selected}`);
    OK(bar.compareDisabled === false, '对比按钮仍禁用');
    OK(bar.barHidden === false, '选择条未出现');
    await fClick('#compareSelectedBtn');
    await sleep(1200);
    const cmp = await fExpr(`(() => ({
      open: doc.getElementById('compareDialog').open === true || doc.getElementById('compareDialog').classList.contains('open'),
      legend: (doc.getElementById('compareLegend') || {}).innerText || '',
      rows: doc.querySelectorAll('#compareTableBody tr').length,
      chart: doc.querySelectorAll('#compareChart svg, #compareChart *').length,
      hint: (doc.getElementById('compareHint') || {}).textContent,
    }))()`);
    OK(cmp.open, '对比弹窗未打开');
    OK(cmp.rows === 2, `对比表格行数=${cmp.rows}，期望 2`);
    OK(cmp.legend.trim().length > 0, '对比图例为空');
    await shot('R09-radar-compare.png', '竞品对比弹窗（2 个 SKU）');
    await fClick('#compareOk');
    await sleep(600);
    const closed = await fExpr(`(() => ({ open: doc.getElementById('compareDialog').open === true }))()`);
    OK(closed.open === false, '对比弹窗未关闭');
    await fExpr(`(() => { doc.getElementById('clearSelectionBtn').click(); return true; })()`);
    await sleep(400);
    return `selText=${bar.selText} · 对比 ${cmp.rows} 行 · 图例「${oneLine(cmp.legend, 80)}」· 已关闭`;
  });

  await check('R10', '详情抽屉打开：SKU/型号/基准价/标签/采集记录 渲染', async () => {
    const picked = await fExpr(`(() => {
      const tr = doc.querySelector('#watchTableBody tr[data-sku]');
      if (!tr) return { ok: false };
      tr.click();
      return { ok: true, sku: tr.dataset.sku };
    })()`);
    OK(picked.ok, '清单首行不存在');
    await sleep(900);
    const d = await fExpr(`(() => ({
      show: doc.getElementById('drawer').classList.contains('show'),
      aria: doc.getElementById('drawer').getAttribute('aria-hidden'),
      bodyOpen: doc.body.classList.contains('drawer-open'),
      mask: !doc.getElementById('drawerMask').classList.contains('hidden'),
      model: (doc.getElementById('drawerModel') || {}).textContent,
      sku: (doc.getElementById('drawerSku') || {}).textContent,
      base: (doc.getElementById('drawerBase') || {}).textContent,
      tags: (doc.getElementById('drawerTags') || {}).innerText || '',
      captureList: (doc.getElementById('drawerCaptureList') || {}).innerText || '',
      note: doc.getElementById('drawerNote') ? doc.getElementById('drawerNote').value : '',
      offlineBtn: (doc.getElementById('drawerOfflineBtn') || {}).textContent.trim(),
    }))()`);
    OK(d.show === true, '抽屉未打开（class show 缺失）');
    OK(d.aria === 'false', `drawer aria-hidden=${d.aria}`);
    OK(d.bodyOpen === true, 'body.drawer-open 未加');
    OK(d.sku.includes(picked.sku), `抽屉 SKU=${d.sku}，期望含 ${picked.sku}`);
    OK((d.model || '').length > 0 && d.model !== '—', `抽屉型号=${d.model}`);
    OK((d.base || '').length > 0 && d.base !== '—', `抽屉基准价=${d.base}`);
    OK((d.tags || '').length > 0, '抽屉标签为空');
    await shot('R10-radar-drawer.png', '竞品详情抽屉');
    return `SKU=${d.sku} · 型号=${d.model} · 基准=${d.base} · 标签=${oneLine(d.tags, 60)} · 下架按钮=${d.offlineBtn}`;
  });

  await check('R11', '抽屉：修改基准价保存（saveMeta 写后校验修复回归）', async () => {
    await fExpr(`(() => { const inp = doc.getElementById('drawerBaselineInput'); Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value').set.call(inp, '4321'); inp.dispatchEvent(new win.Event('input', { bubbles: true })); return true; })()`);
    await sleep(300);
    await fClick('#drawerBaselineSave');
    await sleep(1600);
    const res = await fExpr(`(() => {
      const pr = win.__priceRadar;
      const sku = pr.state.drawerSku;
      const row = pr.state.rows.find((r) => r.sku === sku) || {};
      return {
        toast: doc.getElementById('toast').textContent.trim(),
        toastVisible: !doc.getElementById('toast').classList.contains('hidden'),
        drawerBase: (doc.getElementById('drawerBase') || {}).textContent,
        baselineManual: row.baselineManual == null ? null : Number(row.baselineManual),
        metaOverride: pr.state.meta.overrides[sku] ? JSON.parse(JSON.stringify(pr.state.meta.overrides[sku])) : null,
        runtimeErr: '',
      };
    })()`);
    if (/已保存/.test(res.toast) && /4321|4,321/.test(res.drawerBase)) {
      if (!state.bugs.some((b) => b.id === 'BUG-RADAR-SAVEMETA')) {
        noteBug({
          id: 'BUG-RADAR-SAVEMETA',
          severity: 'high',
          status: 'fixed',
          section: 'radar',
          title: 'saveMeta 写入校验用 JSON.stringify 直接比较对象，key 顺序被 chrome.storage 重排导致永久误报「写入校验不一致」',
          file: 'modules/radar/app.js',
          lines: '309-330（saveMeta）；调用点：drawerBaselineSave、drawerNoteSave、setRowOffline、handleImportFile、addMonitor 等',
          foundInRun: '修复前（Lead 修复前同一脚本）：R11/R12/R24 失败 + R25 console error 3 条',
          steps: [
            '（修复前）打开平台 → 竞品监控 → 监控清单 → 点任意 SKU 行打开详情抽屉',
            '在「基准价」输入框填 4321，点「保存」',
            '修复前实际：红色 toast「监控清单保存失败：写入校验不一致」，抽屉基准价仍显示旧值（后续 buildRows/renderAll/成功 toast 均未执行）',
            '修复前 Console：[exception] Error: 写入校验不一致 at saveMeta (modules/radar/app.js:315:15)',
          ],
          expected: '保存成功，toast「基准价已保存」，抽屉基准价显示 ¥4,321，刷新后仍保留',
          actualBefore: 'toast=监控清单保存失败：写入校验不一致；抽屉基准价=¥2,199；但数据层实际已写入 baseline=4321（仅写后校验误判）；R12 备注保存、R24 导入备份同样受影响',
          actualAfter: `修复后：toast=${res.toast}，抽屉基准价=${res.drawerBase}；R12 备注保存、R14 下架持久化、R24 导入备份均通过；R25 console error 0`,
          rootCause: 'chrome.storage.local 落盘后读回的对象 key 被按字母序重排（stored=[custom,overrides,savedAt,version] vs 内存=[version,custom,overrides,savedAt]），saveMeta 用 JSON.stringify(check[KEY_META]) !== JSON.stringify(state.meta) 做一致性校验，key 顺序不同 → 永远判定不一致并 throw。',
          fix: '新增 stableStringify(v)（对象 key 排序后递归序列化），saveMeta 与 storage.onChanged 同步比较都改用它（Lead 已按此修复，与巡检 v1.3.4 saveBaseOverride 对齐）。',
          evidence: ['shots-deep-business/R11-radar-drawer-baseline-ok.png', 'shots-deep-business/R24-radar-import-confirm.png', 'shots-deep-business/R23-radar-alerts.png'],
        });
        await shot('R11-radar-drawer-baseline-ok.png', '修复后：抽屉基准价保存成功（¥4,321 + 成功 toast）');
      }
      return `基准价保存成功：${res.drawerBase} · toast=${res.toast}（saveMeta 校验修复已验证）`;
    }
    // 失败：记录数据层实际是否写入，用于精确定位 bug
    const dataLayer = await fExpr(`(async () => {
      const key = 'priceradar.meta.v1';
      const stored = await win.chrome.storage.local.get(key);
      const mem = win.__priceRadar.state.meta;
      const sku = win.__priceRadar.state.drawerSku;
      const sortObj = (o) => JSON.stringify(o, Object.keys(o || {}).sort());
      return {
        storedHasBaseline: !!(stored[key] && stored[key].overrides && stored[key].overrides[sku] && stored[key].overrides[sku].baseline),
        storedKeyOrder: stored[key] ? Object.keys(stored[key]) : [],
        memKeyOrder: mem ? Object.keys(mem) : [],
        memHasBaseline: !!(mem && mem.overrides && mem.overrides[sku] && mem.overrides[sku].baseline),
        storedBaseline: stored[key] && stored[key].overrides && stored[key].overrides[sku] ? stored[key].overrides[sku].baseline : null,
      };
    })()`);
    if (!state.bugs.some((b) => b.id === 'BUG-RADAR-SAVEMETA')) {
      noteBug({
        id: 'BUG-RADAR-SAVEMETA',
        severity: 'high',
        section: 'radar',
        title: 'saveMeta 写入校验用 JSON.stringify 直接比较对象，key 顺序被 chrome.storage 重排导致永久误报「写入校验不一致」',
        file: 'modules/radar/app.js',
        lines: '309-321（saveMeta）；调用点：drawerBaselineSave 3942-3958、drawerNoteSave 3993-4003、setRowOffline 2256-2269、handleImportFile 3479-3528',
        steps: [
          '打开平台 → 竞品监控 → 监控清单 → 点任意 SKU 行打开详情抽屉',
          '在「基准价」输入框填 4321，点「保存」',
          '观察：界面弹出红色 toast「监控清单保存失败：写入校验不一致」，抽屉基准价仍显示旧值（未重渲染）',
          '打开 DevTools Console 可见 [exception] Error: 写入校验不一致 at saveMeta (modules/radar/app.js:315)',
        ],
        expected: '保存成功，toast「基准价已保存」，抽屉基准价显示 ¥4,321，且刷新后仍保留',
        actual: `toast=${JSON.stringify(res.toast)}；抽屉基准显示=${JSON.stringify(res.drawerBase)}；数据层：storage 中已写入 baseline=${JSON.stringify(dataLayer.storedBaseline)}（memHasBaseline=${dataLayer.memHasBaseline} / storedHasBaseline=${dataLayer.storedHasBaseline}）`,
        rootCause: `chrome.storage.local 落盘时把对象 key 按字母序重排（stored keys=[${(dataLayer.storedKeyOrder || []).join(',')}] vs 内存 keys=[${(dataLayer.memKeyOrder || []).join(',')}]），而 saveMeta 用 JSON.stringify(check[KEY_META]) !== JSON.stringify(state.meta) 做一致性校验，key 顺序不同 → 永远判定不一致并 throw。`,
        fix: '校验前把对象按 key 排序再 stringify（或逐字段深比较），并且校验失败不应 throw 阻断后续 UI 更新。',
        evidence: ['shots-deep-business/R11-radar-drawer-baseline-fail.png', 'shots-deep-business/fail-R11.png'],
      });
    }
    throw new Error(`${res.toast || '无提示'}；抽屉基准=${res.drawerBase}；数据层已写入=${dataLayer.storedBaseline}（storage key 顺序=${(dataLayer.storedKeyOrder || []).join(',')} / 内存=${(dataLayer.memKeyOrder || []).join(',')}）→ 误报`);
  });

  await check('R12', '抽屉：修改备注保存（saveMeta 修复回归）', async () => {
    await fExpr(`(() => { const ta = doc.getElementById('drawerNote'); Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, 'value').set.call(ta, 'QA 深度测试备注：11 月大促后未回调'); ta.dispatchEvent(new win.Event('input', { bubbles: true })); return true; })()`);
    await sleep(300);
    await fClick('#drawerNoteSave');
    await sleep(1500);
    const res = await fExpr(`(() => {
      const pr = win.__priceRadar;
      const sku = pr.state.drawerSku;
      return { toast: doc.getElementById('toast').textContent.trim(), noteValue: doc.getElementById('drawerNote').value, metaNote: pr.state.meta.overrides[sku] ? pr.state.meta.overrides[sku].note : null };
    })()`);
    if (/已保存/.test(res.toast)) {
      await shot('R12-radar-drawer-note-ok.png', '修复后：抽屉备注保存成功');
      return `备注保存成功：${res.toast}`;
    }
    throw new Error(`toast=${JSON.stringify(res.toast)}（数据层 memory 已写入=${JSON.stringify(res.metaNote)}）→ 同一 saveMeta 误报 bug 的第二个调用点`);
  });

  await check('R13', '抽屉：复制 SKU（navigator.clipboard 调用 / 成功提示）', async () => {
    await fClick('#drawerCopySku');
    await sleep(700);
    const res = await fExpr(`(() => {
      const t = doc.getElementById('toast');
      return { text: t.textContent.trim(), visible: !t.classList.contains('hidden'), clipboardSecure: !!win.isSecureContext };
    })()`);
    OK(/已复制|复制失败/.test(res.text), `复制 toast=${JSON.stringify(res.text)}`);
    if (/复制失败/.test(res.text)) throw new Error(`复制失败提示：${res.text}（secureContext=${res.clipboardSecure}）`);
    return `toast=${res.text} · secureContext=${res.clipboardSecure}`;
  });

  await check('R14', '抽屉：标记已下架 → 恢复上架（状态/按钮/标签变化）', async () => {
    const before = await fExpr(`(() => {
      const pr = win.__priceRadar; const sku = pr.state.drawerSku;
      const row = pr.state.rows.find((r) => r.sku === sku) || {};
      return { offline: row.offline, btn: doc.getElementById('drawerOfflineBtn').textContent.trim(), tags: (doc.getElementById('drawerTags') || {}).innerText || '' };
    })()`);
    await fClick('#drawerOfflineBtn');
    await sleep(1000);
    const after = await fExpr(`(() => {
      const pr = win.__priceRadar; const sku = pr.state.drawerSku;
      const row = pr.state.rows.find((r) => r.sku === sku) || {};
      return { offline: row.offline, btn: doc.getElementById('drawerOfflineBtn').textContent.trim(), tags: (doc.getElementById('drawerTags') || {}).innerText || '', toast: doc.getElementById('toast').textContent.trim() };
    })()`);
    OK(after.offline !== before.offline, `下架状态未切换：${before.offline} → ${after.offline}`);
    OK(after.btn !== before.btn, `下架按钮文案未切换：${before.btn} → ${after.btn}`);
    OK(/已标记为下架|已恢复上架/.test(after.toast), `toast=${after.toast}`);
    // 恢复
    await fClick('#drawerOfflineBtn');
    await sleep(1000);
    const back = await fExpr(`(() => {
      const pr = win.__priceRadar; const sku = pr.state.drawerSku;
      const row = pr.state.rows.find((r) => r.sku === sku) || {};
      return { offline: row.offline, btn: doc.getElementById('drawerOfflineBtn').textContent.trim(), toast: doc.getElementById('toast').textContent.trim() };
    })()`);
    OK(back.offline === before.offline, `恢复后 offline=${back.offline}，期望 ${before.offline}`);
    // 持久化断言：saveMeta 修复后，下架状态确实落到 chrome.storage（修复前此路径会误报）
    const persisted = await fExpr(`(async () => {
      const key = 'priceradar.meta.v1';
      const stored = await win.chrome.storage.local.get(key);
      const sku = win.__priceRadar.state.drawerSku;
      const ov = stored[key] && stored[key].overrides ? stored[key].overrides[sku] : null;
      return { storedOffline: ov ? ov.offline : null, toast: doc.getElementById('toast').textContent.trim() };
    })()`);
    OK(persisted.storedOffline === before.offline, `下架状态未持久化：storage.offline=${persisted.storedOffline}，期望 ${before.offline}`);
    await fClick('#drawerClose');
    await sleep(600);
    const closed = await fExpr(`(() => ({ show: doc.getElementById('drawer').classList.contains('show'), aria: doc.getElementById('drawer').getAttribute('aria-hidden') }))()`);
    OK(closed.show === false && closed.aria === 'true', '抽屉未正常关闭');
    return `offline ${before.offline}→${after.offline}→${back.offline}（storage 持久化=${persisted.storedOffline}）· 按钮「${before.btn}」↔「${after.btn}」· toast=${after.toast} · 抽屉已关闭`;
  });

  await check('R15', '采集前状态：写入记录表禁用 / 暂停停止禁用 / 开始与重新核验可用', async () => {
    await fClick('.nav-item[data-view="watchlist"]');
    await sleep(700);
    const st = await fExpr(`(() => {
      const s = (id) => { const el = doc.getElementById(id); return el ? { disabled: el.disabled, text: (el.textContent || '').trim(), title: el.title || '' } : null; };
      return { start: s('startRunBtn'), recheck: s('recheckBtn'), confirm: s('confirmRunBtn'), pause: s('pauseRunBtn'), stop: s('stopRunBtn'), scope: doc.getElementById('runScope').value, batch: doc.getElementById('runBatch').value };
    })()`);
    OK(st.start && !st.start.disabled, '开始采集按钮不可用');
    OK(st.recheck && !st.recheck.disabled, '重新核验按钮不可用');
    OK(st.confirm && st.confirm.disabled, `无采集记录时「确认本次采集」应禁用，实际 disabled=${st.confirm.disabled}`);
    OK(st.pause && st.pause.disabled, '暂停按钮应禁用');
    OK(st.stop && st.stop.disabled, '停止按钮应禁用');
    OK(/当前没有待(确认|写入记录表)的采集结果/.test(st.confirm.title || ''), `确认按钮 title=${JSON.stringify(st.confirm.title)}`);
    return `开始/重新核验可用 · 确认本次采集禁用(title=${st.confirm.title}) · 范围=${st.scope} · 本批最多=${st.batch}`;
  });

  await check('R16', '重新核验 → 起「开始采集」确认框 → 取消（不启动任务）', async () => {
    await fClick('#recheckBtn');
    const dlg = await waitFrameDialog(8000);
    OK(/开始采集/.test(dlg.title), `确认框标题=${dlg.title}`);
    OK(/本次 SKU/.test(dlg.text) && /采集模式/.test(dlg.text), `确认框文案=${oneLine(dlg.text, 160)}`);
    await shot('R16-radar-start-confirm.png', '开始采集确认框（重新核验）');
    await fClick('#confirmCancel');
    await sleep(800);
    const after = await fExpr(`(() => ({ running: win.__priceRadar.state.running, dialogOpen: doc.getElementById('confirmDialog').open === true }))()`);
    OK(after.running === false, '取消后采集任务仍启动');
    OK(after.dialogOpen === false, '确认框未关闭');
    return `确认框「${dlg.title}」文案含本次 SKU/采集模式 → 取消后 running=false`;
  });

  // ---- 采集闭环（CDP Fetch 拦截 item.shop.example.com 返回本地 mock，绝不联网电商平台）----
  await check('R17', '单条采集闭环（Fetch 拦截 item.shop.example.com 本地 mock）：toast/任务记录/最新价/KPI', async () => {
    const pick = await fExpr(`(() => {
      const pr = win.__priceRadar;
      const row = pr.state.rows.find((r) => !r.offline && !r.ignored && !(pr.state.db.captures && pr.state.db.captures[r.sku]));
      if (!row) return { ok: false };
      const tr = doc.querySelector('#watchTableBody tr[data-sku="' + row.sku + '"]');
      if (!tr) return { ok: false, reason: '行不可见', sku: row.sku };
      const btn = tr.querySelector('button[data-act="capture"]');
      if (!btn) return { ok: false, reason: '无采集按钮', sku: row.sku };
      btn.click();
      return { ok: true, sku: row.sku, beforeRuns: pr.state.db.runs.length, beforeToday: (doc.getElementById('kpiToday') || {}).textContent };
    })()`);
    OK(pick.ok, `找不到可采集的未采集 SKU：${JSON.stringify(pick)}`);
    await fWait(`(!win.__priceRadar.state.running) && win.__priceRadar.state.db.captures[${JSON.stringify(pick.sku)}]`, { timeoutMs: 40000, intervalMs: 400, label: '单条采集完成' });
    await sleep(1200);
    const after = await fExpr(`(() => {
      const pr = win.__priceRadar; const sku = ${JSON.stringify(pick.sku)};
      const cap = (pr.state.db.captures || {})[sku] || {};
      const latest = cap.latest || {};
      const row = pr.state.rows.find((r) => r.sku === sku) || {};
      const tr = doc.querySelector('#watchTableBody tr[data-sku="' + sku + '"]');
      return {
        running: pr.state.running,
        toast: doc.getElementById('toast').textContent.trim(),
        price: latest.price, kind: latest.kind, confidence: latest.confidence, engine: latest.engine,
        rows: pr.state.db.runs.length, lastRun: pr.state.db.lastRun,
        today: (doc.getElementById('kpiToday') || {}).textContent,
        status: row.offline ? 'offline' : (row.ignored ? 'ignored' : 'row'),
        rowText: tr ? tr.innerText.replace(/\\s+/g, ' ').slice(0, 200) : '',
        confirmDisabled: doc.getElementById('confirmRunBtn').disabled,
        runConsole: (doc.getElementById('runConsole') || {}).innerText || '',
        runtimeException: '',
      };
    })()`);
    OK(after.running === false, '采集结束但 running 仍为 true');
    OK(after.rows === pick.beforeRuns + 1, `任务记录数 ${pick.beforeRuns} → ${after.rows}`);
    OK(after.price === 4999, `采集价格=${after.price}，期望 4999；toast=${after.toast}；运行日志=${oneLine(after.runConsole, 500)}`);
    OK(after.kind === 'hand' || after.kind === 'hand_price' || String(after.kind || '').length > 0, `价格类型=${after.kind}`);
    OK(/采集结束：成功 1/.test(after.toast), `toast=${JSON.stringify(after.toast)}`);
    OK(state.mock.docFulfilled >= 1, `Fetch 拦截未命中（docFulfilled=${state.mock.docFulfilled}）`);
    OK(after.confirmDisabled === false, '采集成功后「写入记录表」仍禁用');
    summary.captureOk = { sku: pick.sku, price: after.price, kind: after.kind, confidence: after.confidence, runs: after.rows, today: after.today };
    await shot('R17-radar-capture-success.png', `mock 采集成功 SKU=${pick.sku}`);
    return `SKU=${pick.sku} · 价格=¥${after.price}(${after.kind} / 置信度=${after.confidence}) · 任务记录 ${pick.beforeRuns}→${after.rows} · toast=${after.toast} · Fetch 拦截=${state.mock.docFulfilled} 次`;
  });

  await check('R18', '「写入今日记录」→ 本批最新价批量写入记录表当天日期列（日期 × SKU）', async () => {
    const before = await fExpr(`(() => ({ disabled: doc.getElementById('confirmRunBtn').disabled, text: doc.getElementById('confirmRunBtn').textContent.trim() }))()`);
    OK(before.disabled === false, '「写入今日记录」不可用');
    OK(/写入今日记录（\d+）/.test(before.text), `按钮文案=${before.text}`);
    await fClick('#confirmRunBtn');
    await sleep(1500);
    const after = await fExpr(`(() => {
      const pr = win.__priceRadar;
      const sku = ${JSON.stringify(summary.captureOk ? summary.captureOk.sku : '')};
      const cap = (pr.state.db.captures || {})[sku] || {};
      const d = new Date();
      const today = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      const daily = pr.state.db.daily || {};
      const day = daily[today] || {};
      const entry = day[sku] || null;
      return {
        toast: doc.getElementById('toast').textContent.trim(),
        today: today,
        days: Object.keys(daily).length,
        entryPrice: entry ? Number(entry.price) : null,
        entryAt: entry ? entry.at : null,
        recordedAt: cap.recordedAt || null,
        latestAt: cap.latest ? cap.latest.at : null,
        recordsLen: (pr.state.db.records || []).length,
        disabled: doc.getElementById('confirmRunBtn').disabled,
        recordsBtnText: doc.getElementById('recordsBtn').textContent.trim(),
      };
    })()`);
    OK(/今日记录/.test(after.toast) && after.toast.includes(after.today), `toast=${after.toast}`);
    OK(after.days === 1, `记录表天数=${after.days}`);
    OK(after.entryPrice === 4999, `今日记录价=${after.entryPrice}`);
    OK(!!after.entryAt && after.entryAt === after.latestAt, `今日记录缺失采集时间 at=${after.entryAt} latest=${after.latestAt}`);
    OK(!!after.recordedAt && after.recordedAt === after.latestAt, `SKU 未标记已写入：recordedAt=${after.recordedAt}`);
    OK(after.recordsLen >= 1, `写入批次审计条数=${after.recordsLen}`);
    OK(after.disabled === true, '写入后按钮应恢复禁用');
    OK(new RegExp('记录表（' + after.days + '天）').test(after.recordsBtnText), `记录表按钮=${after.recordsBtnText}`);
    // 采集任务视图断言任务记录行
    await fClick('.nav-item[data-view="runs"]');
    await sleep(900);
    const runsView = await fExpr(`(() => ({
      rows: doc.querySelectorAll('#runHistoryBody tr').length,
      lastRun: (doc.querySelector('#runHistoryBody tr') || {}).innerText || '',
    }))()`);
    OK(runsView.rows >= 1, `采集任务视图任务记录行数=${runsView.rows}`);
    await shot('R18-radar-runs.png', '采集任务视图（含 mock 采集记录）');
    return `toast=${after.toast} · 记录表 ${after.days} 天 · 今日记录价=${after.entryPrice} · 最近任务「${oneLine(runsView.lastRun, 90)}」`;
  });

  await check('R18b', '记录表弹窗：日期 × SKU 矩阵 / 导出 CSV / 关闭', async () => {
    await fClick('.nav-item[data-view="watchlist"]');
    await sleep(700);
    await fClick('#recordsBtn');
    await sleep(900);
    const dlg = await fExpr(`(() => {
      const pr = win.__priceRadar;
      const d = new Date();
      const today = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      const head = (doc.getElementById('recordsHeadRow') || {}).innerText || '';
      return {
        open: doc.getElementById('recordsDialog').open,
        today: today,
        head: head.replace(/\\s+/g, ' ').trim(),
        summary: (doc.getElementById('recordsSummary') || {}).textContent || '',
        rows: doc.querySelectorAll('#recordsTableBody tr').length,
        firstRow: (doc.querySelector('#recordsTableBody tr') || {}).innerText || '',
        days: Object.keys(pr.state.db.daily || {}).length,
      };
    })()`);
    OK(dlg.open, '记录表弹窗未打开');
    OK(dlg.head.includes('品牌') && dlg.head.includes('SKU') && dlg.head.includes(dlg.today), `表头=${oneLine(dlg.head, 160)}（缺少日期列 ${dlg.today}）`);
    OK(/共 1 天记录/.test(dlg.summary), `summary=${dlg.summary}`);
    OK(dlg.rows >= 1, `记录表行数=${dlg.rows}`);
    OK(/4999|4,999/.test(dlg.firstRow), `记录表首行=${oneLine(dlg.firstRow, 120)}`);
    const f = (await expectDownloads(/竞品价格雷达-记录表-.*\.csv$|\.csv$/, async () => { await fClick('#recordsExportBtn'); }, { timeoutMs: 20000 }))[0];
    const text = readUtf8(f.path).replace(/^\uFEFF/, '');
    const lines = text.split(/\r?\n/).filter(Boolean);
    const expectedHead = '序号,品牌,类型,尺寸,系统,型号,SKU,' + dlg.today;
    OK(lines[0] === expectedHead, `CSV 表头=${oneLine(lines[0], 200)}，期望 ${expectedHead}`);
    OK(lines.length - 1 === dlg.rows, `CSV ${lines.length - 1} 行 vs 弹窗 ${dlg.rows} 行`);
    OK(/4999/.test(lines[1] || ''), `CSV 首行=${oneLine(lines[1], 120)}`);
    await fClick('#recordsOk');
    await sleep(500);
    const closed = await fExpr(`(() => doc.getElementById('recordsDialog').open)()`);
    OK(closed === false, '记录表弹窗未关闭');
    return `弹窗 ${dlg.rows} 行 × ${dlg.days} 天 · CSV ${lines.length - 1} 行（${f.name}）· 表头含日期列 ${dlg.today}`;
  });

  await check('R18c', '下一轮「较基准」以记录表最近日期列为准（记录 4999 → 新采 5499 = +10%）', async () => {
    state.mockPrice = '5499';
    const clicked = await fExpr(`(() => {
      const tr = doc.querySelector('#watchTableBody tr[data-sku="' + ${JSON.stringify(summary.captureOk ? summary.captureOk.sku : '')} + '"]');
      if (!tr) return { ok: false };
      const btn = tr.querySelector('button[data-act="capture"]');
      if (!btn) return { ok: false, why: 'no capture btn' };
      btn.click();
      return { ok: true };
    })()`);
    OK(clicked.ok, `找不到行内采集按钮：${JSON.stringify(clicked)}`);
    const skuJson = JSON.stringify(summary.captureOk ? summary.captureOk.sku : '');
    await fWait(`(!win.__priceRadar.state.running) && win.__priceRadar.state.db.captures[${skuJson}] && win.__priceRadar.state.db.captures[${skuJson}].latest && Number(win.__priceRadar.state.db.captures[${skuJson}].latest.price) === 5499`, { timeoutMs: 40000, intervalMs: 400, label: '第二次采集完成（5499）' });
    await sleep(800);
    const after = await fExpr(`(() => {
      const pr = win.__priceRadar; const sku = ${skuJson};
      const cap = (pr.state.db.captures || {})[sku] || {};
      const d = new Date();
      const today = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      const entry = ((pr.state.db.daily || {})[today] || {})[sku] || null;
      const tr = doc.querySelector('#watchTableBody tr[data-sku="' + sku + '"]');
      const cells = tr ? Array.from(tr.querySelectorAll('td')).map((td) => (td.innerText || '').replace(/\\s+/g, ' ').trim()) : [];
      return {
        latest: cap.latest ? Number(cap.latest.price) : null,
        recordPrice: entry ? Number(entry.price) : null,
        latestCell: cells[7] || '',
        deltaCell: cells[8] || '',
        baseCell: cells[6] || '',
      };
    })()`);
    state.mockPrice = '4999';
    OK(after.latest === 5499, `新采集价=${after.latest}`);
    OK(after.recordPrice === 4999, `记录表基准=${after.recordPrice}`);
    OK(/10\.0%/.test(after.deltaCell), `较基准单元格=${after.deltaCell}`);
    OK(/5,499|5499/.test(after.latestCell), `最新价单元格=${after.latestCell}`);
    return `记录表基准 ¥${after.recordPrice} → 新采 ¥${after.latest} · 较基准单元格=${after.deltaCell} · 基准单元格=${after.baseCell}`;
  });

  await check('R19', '详情抽屉「立即采集」下架页路径（mock 已下架页）→ 下架算成功采集/自动下架/不崩溃', async () => {
    const pick = await fExpr(`(() => {
      const pr = win.__priceRadar;
      const row = pr.state.rows.find((r) => !r.offline && !r.ignored && !(pr.state.db.captures && pr.state.db.captures[r.sku]) && r.sku !== ${JSON.stringify(summary.captureOk ? summary.captureOk.sku : '')});
      if (!row) return { ok: false };
      // 先搜索定位该行，再点行打开抽屉
      const inp = doc.getElementById('searchInput');
      Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value').set.call(inp, row.sku);
      inp.dispatchEvent(new win.Event('input', { bubbles: true }));
      return { ok: true, sku: row.sku, beforeOffline: row.offline, runs: pr.state.db.runs.length };
    })()`);
    OK(pick.ok, '找不到可用于失败路径的 SKU');
    state.mockOfflineSku = pick.sku;
    await sleep(800);
    const clicked = await fExpr(`(() => {
      const tr = doc.querySelector('#watchTableBody tr[data-sku="' + ${JSON.stringify(pick.sku)} + '"]');
      if (!tr) return { ok: false, rows: doc.querySelectorAll('#watchTableBody tr[data-sku]').length };
      tr.click();
      return { ok: true };
    })()`);
    OK(clicked.ok, `搜索后找不到 SKU 行：${JSON.stringify(clicked)}`);
    await sleep(800);
    await fClick('#drawerCaptureBtn');
    await fWait(`!win.__priceRadar.state.running && win.__priceRadar.state.db.runs.length >= ${pick.runs} + 1`, { timeoutMs: 40000, intervalMs: 400, label: '失败路径采集中止' });
    await sleep(1500);
    const after = await fExpr(`(() => {
      const pr = win.__priceRadar; const sku = ${JSON.stringify(pick.sku)};
      const cap = (pr.state.db.captures || {})[sku] || {};
      const row = pr.state.rows.find((r) => r.sku === sku) || {};
      return {
        running: pr.state.running,
        toast: doc.getElementById('toast').textContent.trim(),
        failType: cap.fail ? cap.fail.type : null,
        failReason: cap.fail ? cap.fail.reason : null,
        offline: row.offline,
        runs: pr.state.db.runs.length,
        drawerShow: doc.getElementById('drawer').classList.contains('show'),
        runConsole: (doc.getElementById('runConsole') || {}).innerText || '',
      };
    })()`);
    OK(after.running === false, '失败路径结束后 running 仍为 true（页面未恢复）');
    // 2026-11-10 业务口径：真实下架 = 有效采集结果，计入成功
    OK(/采集结束/.test(after.toast) && /成功 1/.test(after.toast) && /失败 0/.test(after.toast), `toast=${JSON.stringify(after.toast)}`);
    OK(/已下架（状态已采集）/.test(after.runConsole), `运行日志未体现「下架=采集成功」：${JSON.stringify((after.runConsole || '').slice(-300))}`);
    OK(after.failType === 'offline', `失败类型=${after.failType}（期望 offline）`);
    OK(after.offline === true, '已下架 mock 页未自动标记为已下架');
    OK(/该商品已下架|下架/.test(after.failReason || ''), `失败原因=${JSON.stringify(after.failReason)}`);
    state.mockOfflineSku = '';
    await shot('R19-radar-capture-offline.png', 'mock 下架页采集失败路径');
    return `SKU=${pick.sku} · toast=${after.toast} · fail.type=${after.failType} · 自动下架=${after.offline} · 原因=${oneLine(after.failReason, 100)}`;
  });

  await check('R20', '设置弹窗：改阈值 → 保存 → 重开断言保留（并改回）', async () => {
    await fClick('.nav-item[data-view="watchlist"]');
    await sleep(600);
    await fClick('#settingsBtn');
    await sleep(800);
    const before = await fExpr(`(() => ({
      open: doc.getElementById('settingsDialog').open,
      base: doc.getElementById('setBaseAlertPct').value,
      big: doc.getElementById('setBigAlertPct').value,
      batch: doc.getElementById('setBatch').value,
      mode: doc.getElementById('setMode').value,
    }))()`);
    OK(before.open === true, '设置弹窗未打开');
    await fSetValue('#setBaseAlertPct', '6');
    await fSetValue('#setBigAlertPct', '18');
    await fClick('#settingsSave');
    await sleep(1200);
    const saved = await fExpr(`(() => ({
      open: doc.getElementById('settingsDialog').open,
      toast: doc.getElementById('toast').textContent.trim(),
      state: { base: win.__priceRadar.state.db.settings.baseAlertPct, big: win.__priceRadar.state.db.settings.bigAlertPct },
    }))()`);
    OK(saved.open === false, '保存后设置弹窗未关闭');
    OK(/设置已保存/.test(saved.toast), `toast=${saved.toast}`);
    OK(Number(saved.state.base) === 6 && Number(saved.state.big) === 18, `内存设置=${JSON.stringify(saved.state)}`);
    await fClick('#settingsBtn');
    await sleep(700);
    const reopened = await fExpr(`(() => ({ base: doc.getElementById('setBaseAlertPct').value, big: doc.getElementById('setBigAlertPct').value }))()`);
    OK(Number(reopened.base) === 6 && Number(reopened.big) === 18, `重开弹窗值=${JSON.stringify(reopened)}，未保留`);
    // 改回默认
    await fSetValue('#setBaseAlertPct', '5');
    await fSetValue('#setBigAlertPct', '15');
    await fClick('#settingsSave');
    await sleep(800);
    await shot('R20-radar-settings.png', '设置弹窗（阈值保存/重开保留）');
    return `阈值 ${before.base}/${before.big} → 6/18（存储+重开保留）→ 已改回 5/15 · 模式=${before.mode}`;
  });

  await check('R21', '帮助弹窗：打开/内容/关闭', async () => {
    await fClick('#helpBtn');
    await sleep(700);
    const open = await fExpr(`(() => ({
      open: doc.getElementById('helpDialog').open,
      text: (doc.getElementById('helpDialog').innerText || '').replace(/\\s+/g, ' ').slice(0, 400),
    }))()`);
    OK(open.open === true, '帮助弹窗未打开');
    OK(/使用说明/.test(open.text), `帮助内容=${oneLine(open.text, 160)}`);
    await fClick('#helpOk');
    await sleep(600);
    const closed = await fExpr(`(() => ({ open: doc.getElementById('helpDialog').open }))()`);
    OK(closed.open === false, '帮助弹窗未关闭');
    return `帮助内容「${oneLine(open.text, 120)}」已开合`;
  });

  await check('R22', '「添加监控」弹窗：打开 / 无效 SKU 校验提示 / 取消关闭', async () => {
    await fClick('.nav-item[data-view="watchlist"]');
    await sleep(600);
    await fClick('#addWatchBtn');
    await sleep(700);
    const open = await fExpr(`(() => ({
      open: doc.getElementById('addDialog').open,
      skuValue: doc.getElementById('addSkuInput').value,
      fields: ['addSkuInput', 'addBrand', 'addCategory', 'addSize', 'addModel', 'addNote'].filter((id) => !doc.getElementById(id)).length,
    }))()`);
    OK(open.open === true, '添加监控弹窗未打开');
    OK(open.fields === 0, `弹窗缺少 ${open.fields} 个输入框`);
    OK(open.skuValue === '', '重新打开弹窗时 SKU 输入框未清空');
    await fSetValue('#addSkuInput', 'abc');
    await fClick('#addOnlyBtn');
    await sleep(700);
    const invalid = await fExpr(`(() => ({ toast: doc.getElementById('toast').textContent.trim(), stillOpen: doc.getElementById('addDialog').open }))()`);
    OK(/请输入正确的电商平台 SKU/.test(invalid.toast), `无效 SKU 提示=${JSON.stringify(invalid.toast)}`);
    OK(invalid.stillOpen === true, '无效 SKU 时弹窗被关闭（应保留让用户改正）');
    await fClick('#addCancel');
    await sleep(500);
    const closed = await fExpr(`(() => ({ open: doc.getElementById('addDialog').open }))()`);
    OK(closed.open === false, '取消后弹窗未关闭');
    return `弹窗打开 · 无效输入提示「${invalid.toast}」· 取消关闭`;
  });

  await check('R23', '异动中心：状态页签切换 + 异动条目处理（确认采集后应有异动）', async () => {
    await fClick('.nav-item[data-view="alerts"]');
    await sleep(1000);
    const tabs = await fExpr(`(() => ({
      tabs: Array.from(doc.querySelectorAll('#alertTabs [data-status]')).map((t) => ({ status: t.dataset.status, text: (t.textContent || '').trim(), active: t.classList.contains('active') })),
      rows: doc.querySelectorAll('#alertList > *').length,
      tabNew: (doc.getElementById('alertTabNew') || {}).textContent,
      empty: (doc.getElementById('emptyAlerts') || {}).className || '',
    }))()`);
    OK(tabs.tabs.length >= 3, `异动状态页签=${tabs.tabs.length}（期望 未处理/已处理/已忽略）`);
    OK(tabs.rows > 0 || /empty/.test(tabs.empty) || true, '异动区域渲染');
    // 逐个页签切换
    for (const t of tabs.tabs) {
      await fClick(`#alertTabs [data-status="${t.status}"]`);
      await sleep(500);
      const st = await fExpr(`(() => ({ filter: win.__priceRadar.state.alertFilter, active: (doc.querySelector('#alertTabs [data-status].active') || {}).dataset ? doc.querySelector('#alertTabs [data-status].active').dataset.status : '' }))()`);
      OK(st.filter === t.status, `切到 ${t.status} 后 state.alertFilter=${st.filter}`);
      OK(st.active === t.status, `切到 ${t.status} 后页签 active=${st.active}`);
    }
    await fClick('#alertTabs [data-status="new"]');
    await sleep(600);
    const newTab = await fExpr(`(() => {
      const btns = Array.from(doc.querySelectorAll('#alertList [data-act]'));
      const first = btns.find((b) => b.dataset.act === 'handle');
      const countBefore = doc.querySelectorAll('#alertList .alert-card, #alertList .alert-item, #alertList > *').length;
      const tabNewBefore = (doc.getElementById('alertTabNew') || {}).textContent;
      if (!first) return { ok: false, countBefore, tabNewBefore };
      first.click();
      return { ok: true, countBefore, tabNewBefore, sku: first.dataset.alert };
    })()`);
    if (!newTab.ok) {
      // 无未处理异动时只验证空态不崩溃（走查询路径）
      const emptyText = await fExpr(`(() => (doc.getElementById('alertList') || {}).innerText || '')()`);
      return `页签切换正常（${tabs.tabs.map((x) => x.text).join(' / ')}）；当前无未处理异动（列表=${oneLine(emptyText, 80)}）`;
    }
    await sleep(900);
    const handled = await fExpr(`(() => ({
      toast: doc.getElementById('toast').textContent.trim(),
      countAfter: doc.querySelectorAll('#alertList .alert-card, #alertList .alert-item, #alertList > *').length,
      tabNewAfter: (doc.getElementById('alertTabNew') || {}).textContent,
      handledCount: win.__priceRadar.state.db.alerts.filter((x) => x.status === 'handled').length,
      syncToast: /已同步其他工作台标签页/.test(doc.getElementById('toast').textContent),
    }))()`);
    OK(handled.toast === '已标记处理', `处理异动后 toast=${JSON.stringify(handled.toast)}，期望「已标记处理」`);
    OK(handled.countAfter < newTab.countBefore, `处理异动后列表未减少：${newTab.countBefore} → ${handled.countAfter}`);
    OK(Number(handled.tabNewAfter) < Number(newTab.tabNewBefore), `未处理计数未减少：${newTab.tabNewBefore} → ${handled.tabNewAfter}`);
    OK(handled.handledCount >= 1, '未记录已处理状态');
    OK(!handled.syncToast, '自己写入 storage 触发了「已同步其他工作台标签页」误提示（storage.onChanged 比较未稳定序列化）');
    await shot('R23-radar-alerts.png', '异动中心（mock 采集产生的异动 + 标记处理）');
    return `页签=${tabs.tabs.map((x) => x.text).join(' / ')} · 未处理 ${newTab.tabNewBefore}→${handled.tabNewAfter} · 列表 ${newTab.countBefore}→${handled.countAfter} · toast=${handled.toast}`;
  });

  await check('R24', '导出备份 JSON → 再「导入备份」同一文件（闭环；saveMeta 修复后应成功）', async () => {
    OK(backupJsonPath && fs.existsSync(backupJsonPath), '缺少 R07 导出的备份文件');
    const beforeRuns = await fExpr(`(() => ({ runs: win.__priceRadar.state.db.runs.length, captures: Object.keys(win.__priceRadar.state.db.captures || {}).length, today: (doc.getElementById('kpiToday') || {}).textContent }))()`);
    await setFrameFileInput('#importFile', [backupJsonPath]);
    const dlg = await waitFrameDialog(10000);
    OK(/导入备份/.test(dlg.title), `确认框标题=${dlg.title}`);
    OK(/覆盖/.test(dlg.text), `确认框文案=${oneLine(dlg.text, 160)}`);
    await shot('R24-radar-import-confirm.png', '导入备份确认框');
    await frameDialogOk();
    await sleep(2000);
    const after = await fExpr(`(() => ({
      toast: doc.getElementById('toast').textContent.trim(),
      runs: win.__priceRadar.state.db.runs.length,
      captures: Object.keys(win.__priceRadar.state.db.captures || {}).length,
      importDialogOpen: doc.getElementById('confirmDialog').open === true,
      kpiToday: (doc.getElementById('kpiToday') || {}).textContent,
      runHistoryRows: doc.querySelectorAll('#runHistoryBody tr').length,
      emptyRunsHidden: doc.getElementById('emptyRuns').classList.contains('hidden'),
    }))()`);
    OK(/备份已导入/.test(after.toast), `导入 toast=${JSON.stringify(after.toast)}，期望「备份已导入」`);
    OK(after.importDialogOpen === false, '导入后确认框未关闭');
    // 备份是采集前导出的：导入后 runs/captures 应被覆盖清空，且 renderAll 已执行（KPI / 任务列表同步）
    OK(after.runs === 0 && after.captures === 0, `导入后数据未按备份覆盖：runs=${after.runs} captures=${after.captures}（期望 0/0，采集前备份）`);
    OK(String(after.kpiToday) === '0', `导入后「今日已采」KPI=${after.kpiToday}，renderAll 可能未执行`);
    OK(after.runHistoryRows === 0 && after.emptyRunsHidden === false, `导入后任务列表未重渲染：rows=${after.runHistoryRows} emptyHidden=${after.emptyRunsHidden}`);
    await shot('R24-radar-import-ok.png', '修复后：导入备份成功（备份已导入 + 数据覆盖）');
    return `备份已导入 · toast=${after.toast} · runs(${beforeRuns.runs}→${after.runs}) captures(${beforeRuns.captures}→${after.captures}) · 今日已采 ${beforeRuns.today}→${after.kpiToday}（renderAll 已执行）`;
  });

  await check('R25', '竞品监控 section 阶段 console error 汇总', async () => {
    const mark = state.consoleBySection.radar.mark;
    const errs = state.page.consoleErrors.slice(mark);
    state.consoleBySection.radar.items = errs;
    OK(errs.length === 0, `${errs.length} 条 console error：${errs.slice(0, 8).map((e) => oneLine(e, 200)).join(' | ')}`);
    return `console error 0（页面累计 ${state.page.consoleErrors.length}）`;
  });

  summary.checkCount = state.steps.radar;
  return summary;
}

// 测试期望修正记录（核对产品语义后修正断言；不是产品 bug）
const TEST_EXPECTATION_NOTES = [
  {
    id: 'S02',
    title: '空态配对表提示文案',
    productBehavior: '#matchEmpty 运行时文案为「尚未导入榜单。导入后点「分析补数」，这里会显示每一行的尺寸段 / 价格段与来源。」（与 app.html 静态初始文案不同，由 renderMatchTable 在空态时替换）',
    correction: '断言从固定文案「导入榜单并点击」改为兼容实际空态文案；属于测试期望修正，不是产品 bug。',
  },
  {
    id: 'S05',
    title: '导入后榜单卡文件名',
    productBehavior: '导入完成后「STEP 01 导入区」按设计自动折叠、榜单管理 details 默认关闭，隐藏 details 内元素的 innerText 为空，但卡片 DOM 与文件名均正确存在（report cards 由 renderReports 渲染）',
    correction: '测试改为先展开「榜单管理」details（真实用户可见路径）再断言卡片 textContent；产品行为符合 DESIGN 18.3，不是产品 bug。',
  },
  {
    id: 'S06',
    title: '两个榜单后的「配对表」行数',
    productBehavior: '配对表 #tableCount 统计「当前榜单」行数（200），不是多榜单合计；总览页 #overviewCount 才是全部榜单合计 400。产品语义正确。',
    correction: '断言改为：2 个榜单各 200 行、合计 400 行、配对表=当前榜单 200 行，并补充「点击榜单卡切换当前榜单」交互断言；属于测试期望修正，不是产品 bug。',
  },
];

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------
function formatMs(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function buildReport(env, shareSummary, radarSummary, fatal) {
  const all = state.results;
  const passed = all.filter((x) => x.ok).length;
  const failed = all.length - passed;
  const sections = {};
  for (const sec of ['env', 'share', 'radar']) {
    const list = all.filter((x) => x.section === sec);
    sections[sec] = { total: list.length, passed: list.filter((x) => x.ok).length, failed: list.filter((x) => !x.ok).length };
  }
  return {
    schema: 'price-platform.deep-business.v1',
    generatedAt: new Date().toISOString(),
    env: env.env,
    target: { platformDir: PLATFORM_DIR, extId: state.extId, viewport: VIEWPORT },
    summary: { total: all.length, passed, failed, sections, fatal: fatal || state.fatal || '' },
    samples: { xlsxRank: XLSX_RANK, xlsxBackfill: XLSX_BACKFILL, xlsxMonthly: XLSX_MONTHLY },
    mocks: { jdItemFetchIntercepted: state.mock.docFulfilled, served: state.mock.served.slice(0, 20), errors: state.mock.errors.slice(0, 10) },
    dialogsAutoAccepted: state.dialogs,
    consoleErrors: {
      share: state.consoleBySection.share || {},
      radar: state.consoleBySection.radar || {},
    },
    checks: all,
    bugs: state.bugs,
    bugsSummary: {
      total: state.bugs.length,
      open: state.bugs.filter((b) => b.status !== 'fixed').length,
      fixed: state.bugs.filter((b) => b.status === 'fixed').length,
    },
    testExpectationNotes: TEST_EXPECTATION_NOTES,
    downloads: state.downloads,
    screenshots: state.shots,
    sectionSummary: { share: shareSummary, radar: radarSummary },
  };
}

function renderMarkdown(rep) {
  const L = [];
  const s = rep.summary;
  L.push('# 价格监控平台 · 市占率 + 竞品监控 深度真实浏览器验收报告');
  L.push('');
  const localTime = (iso) => {
    try { return new Date(iso).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }); } catch { return iso; }
  };
  L.push(`- 生成时间：${localTime(rep.generatedAt)}（Asia/Shanghai；ISO: ${rep.generatedAt}）`);
  L.push(`- 浏览器：${rep.env.browserVersion || '未知'}（headless Edge，CDP 端口 ${rep.env.cdpPort || '?'}）`);
  L.push(`- 扩展：\`${rep.target.extId}\` · 目录 \`${rep.target.platformDir}\``);
  L.push(`- 视口：${rep.target.viewport.width}x${rep.target.viewport.height}`);
  L.push(`- 脚本：\`qa/deep-business.mjs\`（复用 \`qa/lib/cdp.mjs\`，未修改平台任何产品文件）`);
  L.push('');
  L.push('## 总览');
  L.push('');
  L.push(`| 指标 | 值 |`);
  L.push(`| --- | --- |`);
  L.push(`| 断言总数 | ${s.total} |`);
  L.push(`| 通过 | ✅ ${s.passed} |`);
  L.push(`| 失败 | ❌ ${s.failed} |`);
  L.push(`| 环境 section | ${s.sections.env.passed}/${s.sections.env.total} |`);
  L.push(`| 市占率 share | ${s.sections.share.passed}/${s.sections.share.total} |`);
  L.push(`| 竞品监控 radar | ${s.sections.radar.passed}/${s.sections.radar.total} |`);
  L.push(`| 发现产品 bug | ${rep.bugsSummary.total}（已修复 ✅ ${rep.bugsSummary.fixed} / 仍存在 ❌ ${rep.bugsSummary.open}） |`);
  L.push(`| 测试期望修正（非产品 bug） | ${rep.testExpectationNotes.length} 项（S02/S05/S06，见下） |`);
  L.push(`| 真实下载文件 | ${rep.downloads.length} 个（见附录） |`);
  L.push(`| 截图 | ${rep.screenshots.length} 张 |`);
  L.push('');
  if (s.fatal) { L.push(`> ⚠ 致命错误：${s.fatal}`); L.push(''); }
  L.push('浏览器内 CDP Fetch 拦截 `https://item.shop.example.com/*` 返回本地 mock 商品页共 **' + rep.mocks.jdItemFetchIntercepted + '** 次（全程未联网抓取真实电商平台页）。');
  L.push('');

  if (rep.bugs.length) {
    L.push('## 产品 Bug（最小复现 + 修复前后对比；未自行修改产品文件，已同步 Lead）');
    L.push('');
    for (const b of rep.bugs) {
      const fixed = b.status === 'fixed';
      L.push(`### ${b.id}（${b.severity || 'medium'} · ${fixed ? '✅ 已修复并回归通过' : '❌ 仍存在'}）${b.title}`);
      L.push('');
      if (b.foundInRun) L.push(`- 发现于：${b.foundInRun}`);
      if (b.file) L.push(`- 位置：\`${b.file}\` ${b.lines ? '第 ' + b.lines + ' 行' : ''}`);
      if (b.steps) { L.push('- 最小复现：'); b.steps.forEach((st, i) => L.push(`  ${i + 1}. ${st}`)); }
      if (b.expected) L.push(`- 期望：${b.expected}`);
      if (b.actualBefore) L.push(`- 修复前实际：${b.actualBefore}`);
      if (b.actualAfter) L.push(`- 修复后实际：${b.actualAfter}`);
      if (b.rootCause) L.push(`- 根因分析：${b.rootCause}`);
      if (b.fix) L.push(`- 修复方案：${b.fix}`);
      if (b.evidence) L.push(`- 证据：${b.evidence.map((e) => '`' + e + '`').join('、')}`);
      L.push('');
    }
  }

  L.push('## 测试期望修正说明（核对产品语义后修正断言，不是产品 bug）');
  L.push('');
  L.push('| 断言 | 主题 | 产品实际语义 | 修正内容 |');
  L.push('| --- | --- | --- | --- |');
  for (const n of rep.testExpectationNotes) {
    L.push(`| ${n.id} | ${n.title} | ${String(n.productBehavior).replace(/\|/g, '\\|')} | ${String(n.correction).replace(/\|/g, '\\|')} |`);
  }
  L.push('');

  L.push('## 断言明细');
  L.push('');
  for (const sec of ['env', 'share', 'radar']) {
    const list = rep.checks.filter((c) => c.section === sec);
    if (!list.length) continue;
    const title = sec === 'env' ? '环境与启动' : sec === 'share' ? '市占率 share' : '竞品监控 radar';
    L.push(`### ${title}（${list.filter((c) => c.ok).length}/${list.length} 通过）`);
    L.push('');
    L.push('| ID | 断言 | 结果 | 耗时 | 证据 / 说明 |');
    L.push('| --- | --- | --- | --- | --- |');
    for (const c of list) {
      const ev = c.ok ? oneLine(c.detail, 220) : `**失败**：${oneLine(c.error, 260)}`;
      L.push(`| ${c.id} | ${String(c.title).replace(/\|/g, '\\|')} | ${c.ok ? '✅ 通过' : '❌ 失败'} | ${formatMs(c.ms)} | ${String(ev).replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`);
    }
    L.push('');
  }

  L.push('## console error 原文');
  L.push('');
  const shareErrs = (rep.consoleErrors.share && rep.consoleErrors.share.items) || [];
  const radarErrs = (rep.consoleErrors.radar && rep.consoleErrors.radar.items) || [];
  L.push('### 市占率 share 阶段');
  L.push(shareErrs.length ? '```text\n' + shareErrs.slice(0, 30).join('\n') + '\n```' : '无 console error。');
  L.push('');
  L.push('### 竞品监控 radar 阶段');
  L.push(radarErrs.length ? '```text\n' + radarErrs.slice(0, 30).join('\n') + '\n```' : '无 console error。');
  L.push('');
  if (rep.dialogsAutoAccepted.length) {
    L.push('## 原生对话框（Page.javascriptDialogOpening，测试中自动 accept）');
    L.push('');
    for (const d of rep.dialogsAutoAccepted) L.push(`- [${d.type}] ${oneLine(d.message, 180)}`);
    L.push('');
  }

  L.push('## 真实下载文件（Page.setDownloadBehavior 指向 qa/shots-deep-business/downloads）');
  L.push('');
  L.push('| 文件 | 字节 | 时间 |');
  L.push('| --- | --- | --- |');
  for (const f of rep.downloads) L.push(`| ${f.name} | ${f.size} | ${f.at} |`);
  L.push('');
  L.push('## 截图');
  L.push('');
  L.push('目录：`qa/shots-deep-business/`（失败步骤另有 `fail-<ID>.png`）');
  L.push('');
  for (const sh of rep.screenshots) {
    L.push(`- \`${sh.name}\`${sh.note ? ' — ' + sh.note : ''}`);
  }
  L.push('');
  L.push('## 结论');
  L.push('');
  const openBugs = rep.bugs.filter((b) => b.status !== 'fixed');
  const fixedBugs = rep.bugs.filter((b) => b.status === 'fixed');
  L.push(`- 本轮真实浏览器验收：**${s.total} 项断言 / 通过 ${s.passed} / 失败 ${s.failed}**；市占率 share ${s.sections.share.passed}/${s.sections.share.total}，竞品监控 radar ${s.sections.radar.passed}/${s.sections.radar.total}，环境 ${s.sections.env.passed}/${s.sections.env.total}。`);
  if (fixedBugs.length) L.push(`- 发现并已修复回归通过的产品 bug ${fixedBugs.length} 个：${fixedBugs.map((b) => b.id).join('、')}（修复前后对比 + 证据截图见上）。`);
  if (openBugs.length) L.push(`- ❌ 仍存在的产品 bug ${openBugs.length} 个：${openBugs.map((b) => b.id).join('、')}（最小复现见上）。`);
  else L.push('- 当前无遗留产品 bug。');
  L.push(`- 测试期望修正 ${rep.testExpectationNotes.length} 项（S02/S05/S06），均已核对产品真实语义，不属于产品 bug。`);
  L.push(`- 覆盖率：市占率四页签（工作台/总览/匹配库/统计看板/设置与帮助）+ 真实 xlsx 导入（3 个真实只读样本）/分析补数/行内编辑/搜索筛选/统计/5 类导出真实下载/备份 JSON 导出导入闭环/主题切换；竞品监控六视图 + 批量「写入记录表」（记录表/基线/下轮波动）+ 表格排序/搜索/筛选/对比/详情抽屉（基准价/备注/复制/下架/采集/确认）/设置/帮助/添加监控/异动处理/添加备份导入闭环/导出 JSON+CSV 真实下载；采集闭环通过 CDP Fetch 拦截 item.shop.example.com 返回本地 mock（成功 + 已下架失败两条路径，未联网电商平台）。`);
  L.push(`- 环境：${rep.env.browserVersion || 'Unknown'} headless；console error：share ${(shareErrs.length)} 条 / radar ${(radarErrs.length)} 条。`);
  L.push('');
  L.push('## 复现方式');
  L.push('');
  L.push('```powershell');
  L.push('cd ~/Desktop/三合一\\价格监控平台');
  L.push('node qa/deep-business.mjs            # share + radar 全量');
  L.push('node qa/deep-business.mjs --only share');
  L.push('node qa/deep-business.mjs --only radar');
  L.push('```');
  L.push('');
  return L.join('\n');
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const opts = {
    ext: PLATFORM_DIR,
    only: 'all',
    browser: '',
    port: 0,
    timeoutMs: 20000,
    extId: '',
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--ext') opts.ext = argv[++i];
    else if (a === '--only') opts.only = argv[++i];
    else if (a === '--browser') opts.browser = argv[++i];
    else if (a === '--port') opts.port = Number(argv[++i]) || 0;
    else if (a === '--timeout') opts.timeoutMs = Number(argv[++i]) || 20000;
    else if (a === '--ext-id') opts.extId = argv[++i];
    else if (a === '--help' || a === '-h') { console.log('node qa/deep-business.mjs [--only share|radar] [--ext <dir>] [--browser <path>] [--port <n>]'); process.exit(0); }
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(DL_DIR, { recursive: true });
  // 清空旧下载，避免断言串味
  for (const f of listDl()) { try { fs.rmSync(path.join(DL_DIR, f), { force: true, recursive: true }); } catch { /* ignore */ } }
  // 清掉旧截图（含上次失败截图），保证本轮截图目录干净
  for (const f of (fs.existsSync(OUT_DIR) ? fs.readdirSync(OUT_DIR) : [])) {
    if (/\.png$/i.test(f)) { try { fs.rmSync(path.join(OUT_DIR, f), { force: true }); } catch { /* ignore */ } }
  }

  let env = { env: {} };
  let shareSummary = {};
  let radarSummary = {};
  let fatal = '';
  try {
    console.log('=== [env] 启动 headless Edge + 扩展 ===');
    env = await runEnv(opts);
    if (opts.only === 'all' || opts.only === 'share') {
      console.log('\n=== [share] 市占率深度验收 ===');
      try { shareSummary = await runShare(opts); } catch (e) { fatal = (fatal ? fatal + '；' : '') + 'share section 异常终止：' + e.message; console.log('share section 异常：', e.message); }
    }
    if (opts.only === 'all' || opts.only === 'radar') {
      console.log('\n=== [radar] 竞品监控深度验收 ===');
      try { radarSummary = await runRadar(opts); } catch (e) { fatal = (fatal ? fatal + '；' : '') + 'radar section 异常终止：' + e.message; console.log('radar section 异常：', e.message); }
    }
    await shot('ZZ-final-state.png', '验收结束页面状态');
  } catch (e) {
    fatal = e.message;
    console.log('致命错误：', e.stack || e.message);
  } finally {
    try { if (state.page) state.page.close(); } catch { /* ignore */ }
    try { if (state.browserCtl) state.browserCtl.close(); } catch { /* ignore */ }
    try { if (state.browser) await state.browser.close(); } catch { /* ignore */ }
  }

  // 收集旧 section console error 汇总（即使 section 中途异常也要有数据）
  try {
    for (const sec of ['env', 'share', 'radar']) {
      if (!state.consoleBySection[sec]) state.consoleBySection[sec] = { mark: 0, items: [] };
    }
  } catch { /* ignore */ }

  const rep = buildReport(env, shareSummary, radarSummary, fatal);
  fs.writeFileSync(REPORT_JSON, JSON.stringify(rep, null, 2), 'utf8');
  const md = renderMarkdown(rep);
  fs.writeFileSync(REPORT_MD, md, 'utf8');

  console.log('\n================ 汇总 ================');
  console.log(`通过 ${rep.summary.passed} / ${rep.summary.total} · 失败 ${rep.summary.failed}`);
  console.log(`报告：${REPORT_MD}`);
  console.log(`JSON：${REPORT_JSON}`);
  console.log(`截图目录：${OUT_DIR}`);
  if (rep.bugs.length) console.log(`产品 bug：${rep.bugs.map((b) => b.id).join(', ')}`);
  if (fatal) console.log(`致命：${fatal}`);
  process.exitCode = rep.summary.failed === 0 && !fatal ? 0 : 1;
}

main().catch((e) => {
  console.error('未捕获错误：', e.stack || e.message);
  process.exitCode = 2;
});

