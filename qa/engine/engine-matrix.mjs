// 取价引擎一致性矩阵 · CDP 真实浏览器运行器（零依赖，复用 qa/lib/cdp.mjs）
//
// 做什么：
//   1) 用无头 Edge 加载「价格监控平台」扩展（--load-extension）；
//   2) 打开平台页 app.html，在扩展页里挂 chrome.runtime.onMessage 监听，收集三个 content.js 的上报；
//   3) 新建商品页标签页，用 CDP Fetch 拦截 https://item.shop.example.com/<sku>.html，返回 qa/engine/fixtures/ 下的本地 mock 页
//      （不联网真实电商平台），三个业务引擎在同一页面、同一 isolated world 注入；
//   4) 巡检/竞品各自上报 PATROL_ITEM_PRICE_RESULT / RADAR_ITEM_PRICE_RESULT；
//      市占率用 chrome.tabs.sendMessage(tabId, {type:'PREVIEW_CAPTURE'}) 取 PREVIEW_CAPTURE_RESULT 快照；
//   5) 三个引擎 × 场景矩阵与「场景期望值」比对，输出 qa/engine/last-run.json 与终端报表。
//
// 用法：
//   node qa/engine/engine-matrix.mjs                # 全量
//   node qa/engine/engine-matrix.mjs --only S01,S14 # 只跑指定场景
//   node qa/engine/engine-matrix.mjs --no-shots     # 不截图
//   node qa/engine/engine-matrix.mjs --out 自定义.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  launchBrowser, findBrowser, findExtensionId, findPageTarget, createPageTarget, PageSession, sleep,
} from '../lib/cdp.mjs';
import { SCENARIOS, COMPARE_FIELDS } from './scenarios.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLATFORM_ROOT = path.resolve(HERE, '..', '..');
const FIXTURES = path.join(HERE, 'fixtures');
const SHOTS = path.join(HERE, 'shots');
const VIEWPORT = { width: 1440, height: 900 };

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const opts = { only: null, shots: true, out: path.join(HERE, 'last-run.json'), browser: null, port: null, timeoutMs: 40000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--only' && argv[i + 1]) { opts.only = argv[++i].split(',').map((s) => s.trim()).filter(Boolean); }
    else if (a === '--no-shots') opts.shots = false;
    else if (a === '--out' && argv[i + 1]) opts.out = path.resolve(process.cwd(), argv[++i]);
    else if (a === '--browser' && argv[i + 1]) opts.browser = argv[++i];
    else if (a === '--port' && argv[i + 1]) opts.port = Number(argv[++i]);
    else if (a === '--timeout' && argv[i + 1]) opts.timeoutMs = Number(argv[++i]) || 40000;
  }
  return opts;
}

// ---------------------------------------------------------------------------
// 结果归一化：把三个引擎的字段映射成同一套可比较口径
// ---------------------------------------------------------------------------
const num = (v) => (v == null || v === '' || !isFinite(Number(v)) ? null : Number(v));

function fromPatrol(msg) {
  if (!msg) return { missing: true, ok: null, price: null, hand: null, main: null, plus: null, verdict: 'missing' };
  const hand = msg.hand ? num(msg.hand.price) : null;
  const main = msg.main ? num(msg.main.price) : null;
  const plus = msg.plus ? num(msg.plus.price) : null;
  const ok = !!msg.ok;
  const price = ok ? (hand ?? main ?? plus) : null;
  const verdict = ok
    ? 'sellable'
    : msg.flags && msg.flags.verify
      ? 'verify'
      : msg.flags && msg.flags.offSale
        ? 'unsellable'
        : 'noprice';
  return { missing: false, ok, price, hand, main, plus, verdict };
}

function fromRadar(msg) {
  if (!msg) return { missing: true, ok: null, price: null, hand: null, main: null, plus: null, verdict: 'missing' };
  const hand = msg.hand ? num(msg.hand.price) : null;
  const main = msg.main ? num(msg.main.price) : null;
  const plus = msg.plus ? num(msg.plus.price) : null;
  const ok = !!msg.ok;
  const price = ok ? (hand ?? main ?? plus) : null;
  const f = msg.flags || {};
  const state = f.pageState || '';
  let verdict;
  if (ok) verdict = 'sellable';
  else if (state === 'verify') verdict = 'verify';
  else if (state === 'login') verdict = 'login';
  else if (state === 'offline' || state === 'unavailable' || f.offSale || f.unavailable) verdict = 'unsellable';
  else if (state === 'unknown') verdict = 'blocked';
  else verdict = 'noprice';
  return { missing: false, ok, price, hand, main, plus, verdict };
}

function fromShare(snap) {
  if (!snap) return { missing: true, ok: null, price: null, hand: null, main: null, plus: null, verdict: 'missing' };
  const prices = snap.prices || {};
  const hand = num(prices.hand);
  const main = num(prices.main);
  const plus = num(prices.plus);
  const ok = !!snap.ok;
  const price = ok ? (num(snap.price) ?? hand ?? main ?? plus) : null;
  const kind = snap.pageKind || (snap.offSale ? 'offSale' : snap.softAnomaly ? 'softAnomaly' : '');
  const risk = snap.risk || {};
  let verdict;
  if (ok) verdict = 'sellable';
  else if (kind === 'offSale') verdict = 'unsellable';
  else if (kind === 'risk') verdict = risk.reason === 'login' ? 'login' : risk.reason === 'verify' ? 'verify' : 'blocked';
  else if (kind === 'softAnomaly') verdict = 'blocked';
  else verdict = 'noprice';
  return { missing: false, ok, price, hand, main, plus, verdict, pageKind: kind, riskReason: risk.reason || '' };
}

function sameValue(a, b) {
  if (a == null && b == null) return true;
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= 0.005;
  return a === b;
}

function compareEngine(engineName, got, expect) {
  const diffs = [];
  for (const field of COMPARE_FIELDS) {
    if (!sameValue(got[field], expect[field])) diffs.push(`${field}: 期望 ${JSON.stringify(expect[field])} 实际 ${JSON.stringify(got[field])}`);
  }
  return { engine: engineName, pass: diffs.length === 0, diffs };
}

function crossEngineDiff(engines) {
  const out = [];
  for (const field of COMPARE_FIELDS) {
    const vals = { patrol: engines.patrol[field], share: engines.share[field], radar: engines.radar[field] };
    const ins = new Set(Object.values(vals).map((v) => JSON.stringify(v)));
    if (ins.size > 1) out.push(`${field}: patrol=${JSON.stringify(vals.patrol)} share=${JSON.stringify(vals.share)} radar=${JSON.stringify(vals.radar)}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(path.join(PLATFORM_ROOT, 'manifest.json'))) {
    throw new Error(`找不到平台 manifest.json：${PLATFORM_ROOT}`);
  }
  if (!fs.existsSync(path.join(FIXTURES, 'fixture-base.css'))) {
    throw new Error('夹具缺失：先运行 node qa/engine/build-fixtures.mjs');
  }
  const scenarios = opts.only ? SCENARIOS.filter((s) => opts.only.includes(s.id)) : SCENARIOS.slice();
  if (!scenarios.length) throw new Error(`--only 没匹配到场景：${opts.only.join(',')}`);
  const fixtures = new Map();
  for (const sc of scenarios) {
    const p = path.join(FIXTURES, sc.file);
    if (!fs.existsSync(p)) throw new Error(`场景 ${sc.id} 夹具不存在：${p}（先跑 build-fixtures.mjs）`);
    fixtures.set(sc.sku, fs.readFileSync(p, 'utf8'));
  }
  const cssPath = path.join(FIXTURES, 'fixture-base.css');
  const cssBody = fs.readFileSync(cssPath, 'utf8');

  let browser = null;
  let app = null;
  let item = null;
  let itemTargetId = '';
  const report = {
    engine: 'qa/engine/engine-matrix.mjs',
    startedAt: new Date().toISOString(),
    platformRoot: PLATFORM_ROOT,
    browser: '',
    extensionId: '',
    viewport: VIEWPORT,
    scenarios: [],
    extras: {},
    contract: null,
    consoleErrors: [],
  };

  try {
    browser = await launchBrowser({
      extDir: PLATFORM_ROOT,
      browser: opts.browser || undefined,
      port: opts.port || undefined,
      width: VIEWPORT.width,
      height: VIEWPORT.height,
    });
    report.browser = (browser.version && browser.version.Browser) || '';
    report.cdpPort = browser.port;
    console.log(`[browser] ${report.browser} · CDP ${browser.port} · extDir=${PLATFORM_ROOT}`);

    const extensionId = process.env.DS_EXT_ID || (await findExtensionId(browser.port, 30000));
    report.extensionId = extensionId;
    console.log(`[extension] id=${extensionId}`);

    // ---- 平台页：消息收集器 ----
    const firstPage = await findPageTarget(browser.port, 15000);
    app = await new PageSession(firstPage.wsUrl).connect();
    await app.setViewport(VIEWPORT.width, VIEWPORT.height);
    await app.navigate(`chrome-extension://${extensionId}/app.html`, { timeoutMs: 30000, settleMs: 1200 });
    const installed = await app.evaluate(`(() => {
      window.__qaResults = [];
      window.__qaCollectorError = '';
      try {
        chrome.runtime.onMessage.addListener((msg, sender) => {
          try {
            window.__qaResults.push({
              t: Date.now(),
              tabId: (sender && sender.tab && sender.tab.id) || null,
              url: (sender && sender.tab && sender.tab.url) || '',
              msg: msg
            });
          } catch (e) { window.__qaCollectorError = String(e); }
        });
        return { installed: true };
      } catch (e) { return { installed: false, error: String(e) }; }
    })()`);
    if (!installed.installed) throw new Error(`平台页消息监听安装失败：${installed.error}`);
    console.log('[app] 平台页已就绪，chrome.runtime.onMessage 收集器已安装');

    // ---- 商品页 target + Fetch mock ----
    const itemTarget = await createPageTarget(browser.port, 'about:blank');
    itemTargetId = itemTarget.targetId;
    item = await new PageSession(itemTarget.wsUrl).connect();
    await item.setViewport(VIEWPORT.width, VIEWPORT.height);
    const mockState = { docFulfilled: 0, cssFulfilled: 0, otherFulfilled: 0, servedSku: [] };
    item.client.on('Fetch.requestPaused', async (p) => {
      const url = (p && p.request && p.request.url) || (p && p.requestUrl) || '';
      const rid = p && p.requestId;
      try {
        if (p && p.resourceType === 'Document') {
          const m = url.match(/^https:\/\/item\.jd\.com\/(\d{6,})\.html/);
          const html = m ? fixtures.get(m[1]) : null;
          if (html == null) {
            await item.client.rpc('Fetch.fulfillRequest', {
              requestId: rid, responseCode: 404,
              responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }],
              body: Buffer.from('<h1>404 未知 mock SKU</h1>', 'utf8').toString('base64'),
            }, 15000);
            return;
          }
          mockState.docFulfilled += 1;
          mockState.servedSku.push(m[1]);
          await item.client.rpc('Fetch.fulfillRequest', {
            requestId: rid, responseCode: 200,
            responseHeaders: [
              { name: 'Content-Type', value: 'text/html; charset=utf-8' },
              { name: 'Cache-Control', value: 'no-store' },
            ],
            body: Buffer.from(html, 'utf8').toString('base64'),
          }, 15000);
          return;
        }
        if (/fixture-base\.css(\?|$)/.test(url)) {
          mockState.cssFulfilled += 1;
          await item.client.rpc('Fetch.fulfillRequest', {
            requestId: rid, responseCode: 200,
            responseHeaders: [
              { name: 'Content-Type', value: 'text/css; charset=utf-8' },
              { name: 'Cache-Control', value: 'no-store' },
            ],
            body: Buffer.from(cssBody, 'utf8').toString('base64'),
          }, 15000);
          return;
        }
        mockState.otherFulfilled += 1;
        await item.client.rpc('Fetch.fulfillRequest', {
          requestId: rid, responseCode: 200,
          responseHeaders: [{ name: 'Content-Type', value: 'text/plain; charset=utf-8' }],
          body: Buffer.from('', 'utf8').toString('base64'),
        }, 15000);
      } catch {
        try { await item.client.rpc('Fetch.continueRequest', { requestId: rid }, 5000); } catch { /* ignore */ }
      }
    });
    await item.client.rpc('Fetch.enable', {
      patterns: [{ urlPattern: 'https://item.shop.example.com/*', requestStage: 'Request' }],
    }, 15000);

    // ---- 逐场景 ----
    for (const sc of scenarios) {
      console.log(`\n[${sc.id}] ${sc.name}`);
      const url = `https://item.shop.example.com/${sc.sku}.html`;
      await app.evaluate('window.__qaResults.length = 0');
      const consoleMark = item.consoleErrors.length;

      const navRes = await item.navigate(url, { timeoutMs: 30000, settleMs: 500 });
      if (navRes && navRes.errorText) throw new Error(`${sc.id} 导航失败：${navRes.errorText}`);

      // 等巡检 + 竞品结果（无价/下架场景最长 20s 等待，给 40s 余量）
      const waitStart = Date.now();
      let got = { patrol: null, radar: null, shareMain: null, tabId: null, all: [] };
      while (Date.now() - waitStart < opts.timeoutMs) {
        const list = await app.evaluate(`window.__qaResults.map((r) => ({ type: (r.msg && r.msg.type) || '', sku: (r.msg && r.msg.sku) || '', tabId: r.tabId }))`);
        const mine = (list || []).filter((x) => x.sku === sc.sku);
        const hasPatrol = mine.some((x) => x.type === 'PATROL_ITEM_PRICE_RESULT');
        const hasRadar = mine.some((x) => x.type === 'RADAR_ITEM_PRICE_RESULT');
        if (hasPatrol && hasRadar) break;
        await sleep(250);
      }
      got.all = await app.evaluate(`window.__qaResults.filter((r) => r.msg && r.msg.sku === ${JSON.stringify(sc.sku)}).map((r) => r.msg)`);
      for (const m of got.all || []) {
        if (m.type === 'PATROL_ITEM_PRICE_RESULT') got.patrol = m;
        else if (m.type === 'RADAR_ITEM_PRICE_RESULT') got.radar = m;
        else if (m.type === 'ITEM_CAPTURE_RESULT') got.shareMain = m;
      }
      const tabId = await app.evaluate(`new Promise((resolve) => {
        chrome.tabs.query({ url: 'https://item.shop.example.com/*' }, (tabs) => {
          const t = (tabs || []).find((x) => (x.url || '').indexOf(${JSON.stringify(sc.sku)}) >= 0) || (tabs || [])[0];
          resolve(t ? t.id : null);
        });
      })`);
      got.tabId = tabId;

      // 市占率：PREVIEW_CAPTURE 快照（读当前 DOM；此时巡检/竞品已定格，DOM 为最终态）
      let preview = null;
      if (tabId != null) {
        const pv = await app.evaluate(`new Promise((resolve) => {
          try {
            chrome.tabs.sendMessage(${JSON.stringify(tabId)}, { type: 'PREVIEW_CAPTURE' }, (resp) => {
              const err = chrome.runtime.lastError ? chrome.runtime.lastError.message : '';
              resolve({ error: err, snapshot: resp || null });
            });
          } catch (e) { resolve({ error: String(e), snapshot: null }); }
        })`);
        if (pv && pv.snapshot) preview = pv.snapshot;
        else console.log(`  [warn] 市占率 PREVIEW_CAPTURE 失败：${pv && pv.error}`);
      } else {
        console.log('  [warn] 没拿到商品页 tabId，无法请求市占率快照');
      }

      const itemInfo = await item.evaluate(`({ url: location.href, title: document.title, innerH: window.innerHeight, innerW: window.innerWidth, readyState: document.readyState })`);

      const engines = {
        patrol: fromPatrol(got.patrol),
        share: fromShare(preview),
        radar: fromRadar(got.radar),
      };
      const checks = COMPARE_FIELDS.length ? ['patrol', 'share', 'radar'].map((k) => compareEngine(k, engines[k], sc.expect)) : [];
      const patrolCheck = checks.find((c) => c.engine === 'patrol');
      const shareRadarChecks = checks.filter((c) => c.engine !== 'patrol');
      // 矩阵判定：本次任务只能改 share/radar，所以「全绿」= 这两个引擎都与场景期望一致；
      // 巡检与期望不符时按任务要求「不改巡检、先报告 lead」，单列为基准偏差（不计入 share/radar 失败）。
      const shareRadarPass = shareRadarChecks.every((c) => c.pass);
      const baselineDeviation = patrolCheck && !patrolCheck.pass
        ? { engine: 'patrol', diffs: patrolCheck.diffs, note: '巡检与场景期望不符：按任务约束不改 modules/patrol，已报告 lead 待决策' }
        : null;
      const cross = crossEngineDiff(engines);
      const shareRadarCross = crossEngineDiff({ share: engines.share, radar: engines.radar, patrol: engines.radar });
      void shareRadarCross;
      const pass = shareRadarPass;

      if (opts.shots) {
        fs.mkdirSync(SHOTS, { recursive: true });
        try {
          await item.screenshot(path.join(SHOTS, `${sc.id.toLowerCase()}.png`));
        } catch (e) {
          console.log(`  [warn] 截图失败：${e.message}`);
        }
      }

      const newErrors = item.consoleErrors.slice(consoleMark);
      report.consoleErrors.push({ id: sc.id, errors: newErrors });

      const row = {
        id: sc.id,
        sku: sc.sku,
        name: sc.name,
        url,
        expect: sc.expect,
        engines,
        checks,
        shareRadarPass,
        baselineDeviation,
        crossEngineDiffs: cross,
        pass,
        raw: {
          patrol: got.patrol ? {
            ok: got.patrol.ok, reason: got.patrol.reason || '', flags: got.patrol.flags || null,
            hand: got.patrol.hand || null, main: got.patrol.main || null, plus: got.patrol.plus || null,
            source: got.patrol.source || '', priceChanges: got.patrol.priceChanges || [],
          } : null,
          radar: got.radar ? {
            ok: got.radar.ok, reason: got.radar.reason || '', flags: got.radar.flags || null,
            hand: got.radar.hand || null, main: got.radar.main || null, plus: got.radar.plus || null,
            confidence: got.radar.confidence || '', source: got.radar.source || '',
            priceChanges: got.radar.priceChanges || [],
          } : null,
          share: preview ? {
            ok: preview.ok, reason: preview.reason || '', pageKind: preview.pageKind, risk: preview.risk || null,
            price: preview.price, prices: preview.prices || null, priceKind: preview.priceKind || '',
            priceKindLabel: preview.priceKindLabel || '', priceRect: preview.priceRect || null,
            sourceLabel: preview.sourceLabel || '', pricePick: preview.pricePick || null,
            priceChanges: preview.priceChanges || null,
            candidates: Array.isArray(preview.candidates) ? preview.candidates.slice(0, 6) : [],
            candidateCount: preview.candidateCount != null ? preview.candidateCount : null,
            size: preview.size || null, sizeUncertain: preview.sizeUncertain, sizeReason: preview.sizeReason || '',
            model: preview.model || '', modelSource: preview.modelSource || '',
            package: preview.package || '', packageSource: preview.packageSource || '',
            packageGroup: preview.packageGroup || '', specGroups: preview.specGroups || [],
          } : null,
          shareMain: got.shareMain ? {
            ok: got.shareMain.ok, reason: got.shareMain.reason || '', price: got.shareMain.price,
            pageKind: got.shareMain.pageKind, brand: got.shareMain.brand || '',
            size: got.shareMain.size || null, model: got.shareMain.model || '',
            modelSource: got.shareMain.modelSource || '', package: got.shareMain.package || '',
            specGroups: got.shareMain.specGroups || [], flags: got.shareMain.flags || null,
          } : null,
        },
        page: itemInfo,
        previewError: preview ? '' : 'missing',
        elapsedMs: Date.now() - waitStart,
      };
      report.scenarios.push(row);
      report.mock = mockState;

      const fmt = (e) => `ok=${e.ok} price=${e.price == null ? 'null' : e.price} hand=${e.hand == null ? 'null' : e.hand} main=${e.main == null ? 'null' : e.main} plus=${e.plus == null ? 'null' : e.plus} verdict=${e.verdict}`;
      console.log(`  expect  ${fmt(sc.expect)}`);
      console.log(`  patrol  ${fmt(engines.patrol)}`);
      console.log(`  share   ${fmt(engines.share)}`);
      console.log(`  radar   ${fmt(engines.radar)}`);
      for (const c of checks) if (!c.pass) console.log(`  ${c.engine === 'patrol' ? '△' : '✗'} ${c.engine}: ${c.diffs.join(' | ')}`);
      if (baselineDeviation) console.log('  △ 巡检基准偏差（不改巡检，已报 lead）：' + baselineDeviation.diffs.join(' | '));
      if (cross.length) console.log(`  △ 引擎间不一致（含巡检，见 REPORT）: ${cross.join(' | ')}`);
      const allThreeOk = checks.every((c) => c.pass) && cross.length === 0;
      console.log(`  → ${allThreeOk ? 'PASS（三引擎均与期望一致）' : 'FAIL'}${baselineDeviation ? '（巡检另有偏差）' : ''}（${Date.now() - waitStart}ms，页面=${itemInfo.readyState}）`);
    }

    // ---- 契约与 extras 检查 ----
    report.contract = await runContractChecks(app, item, scenarios, report);
    report.extras = runExtrasChecks(report);
  } finally {
    try { item?.close(); } catch { /* ignore */ }
    try { app?.close(); } catch { /* ignore */ }
    if (browser) {
      try { await browser.close(); } catch { /* ignore */ }
      console.log(`[cleanup] 浏览器已关闭（pid=${browser.child && browser.child.pid}）`);
    }
  }

  report.finishedAt = new Date().toISOString();
  const allEnginesPass = report.scenarios.filter((s) => s.checks.every((c) => c.pass) && s.crossEngineDiffs.length === 0).length;
  const summary = {
    total: report.scenarios.length,
    passed: report.scenarios.filter((s) => s.pass).length,
    allEnginesPass,
    failed: report.scenarios.filter((s) => !s.pass).map((s) => ({
      id: s.id,
      name: s.name,
      engineFails: s.checks.filter((c) => !c.pass).map((c) => `${c.engine}: ${c.diffs.join('; ')}`),
      cross: s.crossEngineDiffs,
    })),
    patrolBaselineDeviations: report.scenarios.filter((s) => s.baselineDeviation).map((s) => ({
      id: s.id,
      name: s.name,
      diffs: s.baselineDeviation.diffs,
      actual: s.engines.patrol,
      expect: s.expect,
    })),
    engineDisagreements: report.scenarios.filter((s) => s.crossEngineDiffs.length).map((s) => ({ id: s.id, diffs: s.crossEngineDiffs })),
    contract: report.contract,
    extras: report.extras,
  };
  report.summary = summary;
  fs.writeFileSync(opts.out, JSON.stringify(report, null, 2), 'utf8');
  console.log(`\n===== 矩阵结果（三引擎对期望）：${summary.allEnginesPass}/${summary.total} 场景三引擎全部一致 =====`);
  if (summary.failed.length) {
    for (const f of summary.failed) {
      console.log(`✗ ${f.id} ${f.name}`);
      for (const e of f.engineFails) console.log(`    ${e}`);
    }
  }
  if (summary.patrolBaselineDeviations.length) {
    console.log(`\n----- 巡检与期望不一致 ${summary.patrolBaselineDeviations.length} 处 -----`);
    for (const d of summary.patrolBaselineDeviations) {
      console.log(`△ ${d.id} ${d.name}`);
      console.log(`    ${d.diffs.join(' | ')}`);
    }
  }
  if (summary.engineDisagreements.length) {
    console.log(`\n----- 三引擎读数不一致 ${summary.engineDisagreements.length} 处（明细见 REPORT.md）-----`);
    for (const d of summary.engineDisagreements) console.log(`△ ${d.id}: ${d.diffs.join(' | ')}`);
  }
  if (report.contract) console.log(`[契约] ${JSON.stringify(report.contract.summary)}`);
  if (report.extras) console.log(`[extras] ${JSON.stringify(report.extras.summary)}`);
  console.log(`[report] ${opts.out}`);
  process.exitCode = summary.failed.length || summary.patrolBaselineDeviations.length || summary.engineDisagreements.length ? 1 : 0;
}

// ---------------------------------------------------------------------------
// 契约检查：消息类型名不变、PING 可应答、PREVIEW_CAPTURE 结构完整
// ---------------------------------------------------------------------------
async function runContractChecks(app, item, scenarios, report) {
  const out = { checks: [], summary: {} };
  const sc = scenarios[0];
  if (!sc) return out;
  try {
    // 回到第一个场景页，让三个 content.js 处于正常商品页
    await item.navigate(`https://item.shop.example.com/${sc.sku}.html`, { timeoutMs: 30000, settleMs: 600 });
    // 等三个 content.js 注入完成（隔离环境里各自 guard 置位）
    let tabInfo = null;
    for (let i = 0; i < 40 && !tabInfo; i++) {
      tabInfo = await app.evaluate(`new Promise((resolve) => {
        chrome.tabs.query({ url: 'https://item.shop.example.com/*' }, (tabs) => {
          const t = (tabs || []).find((x) => (x.url || '').indexOf(${JSON.stringify(sc.sku)}) >= 0);
          resolve(t ? { id: t.id, url: t.url } : null);
        });
      })`);
      if (!tabInfo) await sleep(250);
    }
    if (!tabInfo) {
      out.checks.push({ name: 'PING/PREVIEW 契约', pass: false, detail: '找不到商品页 tab' });
      out.summary = { pass: false };
      return out;
    }
    const sendAndWait = async (type) => {
      let last = { error: 'not-sent', resp: null };
      for (let i = 0; i < 12; i++) {
        last = await app.evaluate(`new Promise((resolve) => {
          chrome.tabs.sendMessage(${JSON.stringify(tabInfo.id)}, { type: ${JSON.stringify(type)} }, (resp) => {
            const err = chrome.runtime.lastError ? chrome.runtime.lastError.message : '';
            resolve({ error: err, resp: resp || null });
          });
        })`);
        if (last && last.resp) return last;
        await sleep(250);
      }
      return last;
    };
    const patrolPing = await sendAndWait('PATROL_PING');
    const radarPing = await sendAndWait('RADAR_PING');
    const sharePing = await sendAndWait('SHARE_PING');
    const preview = await sendAndWait('PREVIEW_CAPTURE');
    out.checks.push({ name: 'PATROL_PING', pass: !!(patrolPing.resp && patrolPing.resp.ok), detail: patrolPing.resp || patrolPing.error });
    out.checks.push({ name: 'RADAR_PING', pass: !!(radarPing.resp && radarPing.resp.ok), detail: radarPing.resp || radarPing.error });
    out.checks.push({ name: 'SHARE_PING', pass: !!(sharePing.resp && sharePing.resp.ok), detail: sharePing.resp || sharePing.error });
    out.checks.push({
      name: 'PREVIEW_CAPTURE_RESULT',
      pass: !!(preview.resp && preview.resp.type === 'PREVIEW_CAPTURE_RESULT'),
      detail: preview.resp ? { type: preview.resp.type, sku: preview.resp.sku, pageKind: preview.resp.pageKind, ok: preview.resp.ok } : preview.error,
    });
    // 巡检/竞品结果消息类型（从第一轮场景结果里取，只校验类型名没被改）
    const first = (report.scenarios || []).find((s) => s.raw && s.raw.patrol);
    out.checks.push({
      name: '结果消息类型名',
      pass: !!(first && first.raw.patrol && first.raw.radar && first.raw.share),
      detail: { patrolResult: 'PATROL_ITEM_PRICE_RESULT', radarResult: 'RADAR_ITEM_PRICE_RESULT', shareResult: 'ITEM_CAPTURE_RESULT / PREVIEW_CAPTURE_RESULT' },
    });
    out.summary = { pass: out.checks.every((c) => c.pass), passed: out.checks.filter((c) => c.pass).length, total: out.checks.length };
  } catch (e) {
    out.checks.push({ name: '契约检查异常', pass: false, detail: String(e && e.message) });
    out.summary = { pass: false, passed: 0, total: out.checks.length };
  }
  return out;
}

// ---------------------------------------------------------------------------
// extras 检查：share 的尺寸/型号/套餐/品牌/快照结构、radar 的置信度/页面状态不能被破坏
// ---------------------------------------------------------------------------
function runExtrasChecks(report) {
  const out = { checks: [], summary: {} };
  const s01 = report.scenarios.find((s) => s.id === 'S01');
  const share = s01 && s01.raw.share;
  const shareMain = s01 && s01.raw.shareMain;
  if (share) {
    out.checks.push({
      name: 'share 预览快照结构字段齐全',
      pass: ['prices', 'price', 'priceKind', 'priceRect', 'pricePick', 'sourceLabel', 'candidates', 'pageKind', 'size', 'specGroups'].every((k) => k in share),
      detail: Object.keys(share),
    });
    out.checks.push({ name: 'share 尺寸提取（75英寸）', pass: !!(share.size && Number(share.size.inch) === 75), detail: share.size });
    out.checks.push({ name: 'share 品牌提取（酷开，主结果）', pass: !!(shareMain && shareMain.brand === '酷开'), detail: shareMain && shareMain.brand });
    out.checks.push({ name: 'share 型号提取（含 75P5）', pass: /75P5/i.test(share.model || ''), detail: share.model });
    out.checks.push({ name: 'share 套餐提取（版本已选项）', pass: !!share.package, detail: share.package });
    out.checks.push({ name: 'share 规格选择区结构', pass: Array.isArray(share.specGroups) && share.specGroups.length > 0, detail: { count: (share.specGroups || []).length } });
  } else {
    out.checks.push({ name: 'share 预览快照（S01）', pass: false, detail: '缺少 S01 快照' });
  }
  const radarRows = report.scenarios.filter((s) => s.raw && s.raw.radar);
  const radarFieldsOk = radarRows.every((s) => {
    const r = s.raw.radar;
    return r && typeof r.confidence === 'string' && r.confidence !== '' && r.flags && typeof r.flags.pageState === 'string';
  });
  out.checks.push({ name: 'radar 置信度/页面状态字段齐全', pass: radarFieldsOk, detail: { rows: radarRows.length } });
  const s01Radar = s01 && s01.raw.radar;
  out.checks.push({ name: 'radar S01 置信度=high（主价格区+到手价）', pass: !!(s01Radar && s01Radar.confidence === 'high'), detail: s01Radar && s01Radar.confidence });
  const s14 = report.scenarios.find((s) => s.id === 'S14');
  if (s14) {
    const s14patrol = s14.raw.patrol;
    const s14radar = s14.raw.radar;
    out.checks.push({
      name: 'S14 二次刷新最终价=￥25,099（巡检/竞品）',
      pass: !!(s14patrol && Number(s14patrol.hand && s14patrol.hand.price) === 25099 && s14radar && Number(s14radar.hand && s14radar.hand.price) === 25099),
      detail: {
        patrolChanges: s14patrol && s14patrol.priceChanges,
        radarChanges: s14radar && s14radar.priceChanges,
      },
    });
  } else {
    out.checks.push({ name: 'S14 二次刷新最终价=￥25,099（巡检/竞品）', pass: null, skipped: true, detail: '本次未运行 S14' });
  }
  const effective = out.checks.filter((c) => c.pass !== null && !c.skipped);
  out.summary = { pass: effective.every((c) => c.pass), passed: effective.filter((c) => c.pass).length, total: effective.length, skipped: out.checks.filter((c) => c.skipped).length };
  return out;
}

main().catch((e) => {
  console.error(`[fatal] ${e && e.stack ? e.stack : e}`);
  process.exitCode = 2;
});
