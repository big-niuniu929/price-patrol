// v1.1.1 电商平台 2026 新版详情页真实 DOM 回归：三个引擎在同一份真实页面结构上的取价结果
// 真实 DOM 由用户用 jd-diag 工具抓取（已脱敏），放在 qa/engine/fixtures/jd-2026/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser, findPageTarget, PageSession, sleep } from './lib/cdp.mjs';

const QA = path.dirname(fileURLToPath(import.meta.url));
const PLATFORM = path.resolve(QA, '..');
const FIX = path.join(QA, 'engine/fixtures/jd-2026');
const FIXTURE = path.join(FIX, 'real-100370009110.html');
const REPORT_MD = path.join(QA, 'JD2026-REPORT.md');
const REPORT_JSON = path.join(QA, 'JD2026-REPORT.json');

// 用户真实页面（联想 T65SE，会员价）核心期望
const EXPECT = { sku: '100370009110', hand: 5149, main: 5499 };

const ENGINES = {
  patrol: { file: path.join(PLATFORM, 'modules/patrol/content.js') },
  share: { file: path.join(PLATFORM, 'modules/share/content.js') },
  radar: { file: path.join(PLATFORM, 'modules/radar/content.js') },
};

const STUB = `(() => {
  window.__msgs = [];
  const clone = (m) => { try { return JSON.parse(JSON.stringify(m)); } catch (e) { return m; } };
  const chromeStub = {
    runtime: {
      sendMessage: (m) => { window.__msgs.push(clone(m)); return Promise.resolve({ ok: true }); },
      onMessage: { addListener: () => {} },
      getURL: (p) => p,
      lastError: null,
    },
    storage: {
      local: { get: () => Promise.resolve({}), set: () => Promise.resolve(), remove: () => Promise.resolve() },
      onChanged: { addListener: () => {} },
    },
  };
  try { Object.defineProperty(window, 'chrome', { value: chromeStub, configurable: true, writable: true }); } catch (e) { window.chrome = chromeStub; }
  window.addEventListener('error', (e) => { window.__engineError = String(e.message || e); });
  window.addEventListener('unhandledrejection', (e) => { window.__engineError = String((e.reason && e.reason.stack) || e.reason || e); });
  return true;
})()`;

const checks = [];
const notes = [];
function check(id, label, ok, detail) {
  checks.push({ id, label, ok: !!ok, detail: String(detail == null ? '' : detail).slice(0, 400) });
  console.log(`${ok ? '✔' : '✘'} [${id}] ${label} — ${detail}`);
}

if (!fs.existsSync(FIXTURE)) {
  console.log('缺少真实页面 fixture:', FIXTURE);
  process.exit(1);
}
const html = fs.readFileSync(FIXTURE, 'utf8');

let browser = null;
const results = {};
try {
  const edge = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].filter((p) => fs.existsSync(p))[0];
  browser = await launchBrowser({ browser: edge, width: 1440, height: 900 });
  for (const [name, eng] of Object.entries(ENGINES)) {
    const target = await findPageTarget(browser.port);
    const page = await new PageSession(target.wsUrl).connect();
    await page.setViewport(1440, 900);
    await page.client.rpc('Fetch.enable', { patterns: [{ urlPattern: 'https://item.shop.example.com/*', requestStage: 'Request' }] });
    page.client.on('Fetch.requestPaused', async (p) => {
      try {
        if (/item\.jd\.com\/(\d+|product\/\d+)/.test(p.request.url || '') && /\.html/.test(p.request.url || '')) {
          await page.client.rpc('Fetch.fulfillRequest', {
            requestId: p.requestId, responseCode: 200,
            responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }],
            body: Buffer.from(html, 'utf8').toString('base64'),
          });
        } else {
          await page.client.rpc('Fetch.continueRequest', { requestId: p.requestId });
        }
      } catch (e) { /* ignore */ }
    });
    const src = fs.readFileSync(eng.file, 'utf8');
    // 模拟 content script 的 document_idle 注入：等 DOMContentLoaded 后再执行引擎（body/DOM 已就绪）
    const inject = STUB + '\n;' + `(() => {
      const run = () => { try { \n${src}\n } catch (e) { window.__engineError = String((e && e.stack) || e); } };
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
      else run();
    })();`;
    await page.client.rpc('Page.addScriptToEvaluateOnNewDocument', { source: inject });
    await page.client.rpc('Page.navigate', { url: `https://item.shop.example.com/${EXPECT.sku}.html` }, 20000).catch(() => {});
    await sleep(14000);
    const out = await page.evaluate('({ msgs: window.__msgs || [], err: window.__engineError || "" })').catch((e) => ({ msgs: [], err: String(e) }));
    const priceMsg = (out.msgs || []).find((m) => m && (m.hand || m.main || m.price != null)) || (out.msgs || [])[0];
    results[name] = { msgs: out.msgs || [], err: out.err, msg: priceMsg || null };
    page.close?.();
    await sleep(400);
  }

  check('J1', '真实页面 fixture（电商平台 2026 新版详情页快照）存在', fs.existsSync(FIXTURE), `${(fs.statSync(FIXTURE).size / 1024).toFixed(0)} KB · SKU ${EXPECT.sku}`);

  for (const [name, r] of Object.entries(results)) {
    check(`J-${name}-1`, `${name} 引擎在真实新版页面收到上报`, !!r.msg && !r.err, r.err || `type=${r.msg && r.msg.type} ok=${r.msg && r.msg.ok}`);
    const hand = r.msg && r.msg.hand ? Number(r.msg.hand.price) : null;
    const main = r.msg && r.msg.main ? Number(r.msg.main.price) : null;
    check(`J-${name}-2`, `${name} 引擎取到真实到手价 ¥${EXPECT.hand}`, hand === EXPECT.hand, `hand=${hand}`);
    check(`J-${name}-3`, `${name} 引擎取到划线价 ¥${EXPECT.main}`, main === EXPECT.main, `main=${main}`);
  }

  const radar = results.radar && results.radar.msg;
  check('J-radar-4', 'radar 不再把新版页面误判为下架', radar && radar.flags && radar.flags.offSale === false && radar.flags.hasProductName === true,
    radar ? `offSale=${radar.flags.offSale} hasProductName=${radar.flags.hasProductName}` : '无消息');
  const patrol = results.patrol && results.patrol.msg;
  const share = results.share && results.share.msg;
  const samePrice = (a, b) => Number(a) === Number(b);
  check('J-consistency', '三引擎到手价口径一致（巡检=市占率=竞品）',
    samePrice(patrol && patrol.hand && patrol.hand.price, radar && radar.hand && radar.hand.price) &&
    samePrice(share && (share.price || (share.hand && share.hand.price)), radar && radar.hand && radar.hand.price),
    `patrol=${patrol && patrol.hand && patrol.hand.price} share=${share && (share.price || (share.hand && share.hand.price))} radar=${radar && radar.hand && radar.hand.price}`);

  const failed = checks.filter((c) => !c.ok);
  const summary = { at: new Date().toISOString(), total: checks.length, passed: checks.length - failed.length, failed: failed.length, expect: EXPECT, results: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, { msg: v.msg, err: v.err }])) };
  fs.writeFileSync(REPORT_JSON, JSON.stringify(summary, null, 2));
  const md = [
    '# 电商平台 2026 新版详情页 · 真实 DOM 取价回归（v1.1.1）',
    '',
    `- 时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}`,
    `- 页面来源：用户真实浏览器抓取的电商平台详情页 DOM 快照（脱敏），\`qa/engine/fixtures/jd-2026/real-${EXPECT.sku}.html\``,
    `- 期望：到手价 ¥${EXPECT.hand} / 划线价 ¥${EXPECT.main}（用户核对的会员价）`,
    '',
    '| # | 检查项 | 结果 | 详情 |',
    '|---|---|---|---|',
    ...checks.map((c) => `| ${c.id} | ${c.label} | ${c.ok ? '✅' : '❌'} | ${c.detail} |`),
    '',
    `结论：${failed.length ? '❌ 失败 ' + failed.length : '✅ 全部通过'}（${checks.length - failed.length}/${checks.length}）`,
    '',
  ].join('\n');
  fs.writeFileSync(REPORT_MD, md);
  console.log(`\n[report] ${REPORT_MD}`);
  console.log(`[summary] ${checks.length - failed.length}/${checks.length} passed`);
  if (failed.length) process.exitCode = 1;
} catch (e) {
  console.error('FATAL', (e && e.stack) || e);
  process.exitCode = 1;
} finally {
  try { await browser?.close(); } catch { /* ignore */ }
}
