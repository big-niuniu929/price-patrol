// 取价逻辑离线自测：用合成 DOM 模拟电商平台价格区，验证 content.js 的识别结果
const fs = require('fs');
const path = require('path');
const PORT = Number(process.argv[2] || 9238);
const EXT = process.argv[3] || '~/Desktop/巡检\\巡检插件版\\extension';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function httpJson(p) { const res = await fetch('http://127.0.0.1:' + PORT + p); return JSON.parse(await res.text()); }

const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>测试商品</title></head><body>
<div id="ttbar-userinfo"><span>测试账号</span></div>
<div class="summary-price">
  <div class="p-price">
    <span class="price">¥12399</span>
    <span class="tag">到手价</span>
    <del class="price-del">¥13499</del>
  </div>
  <div class="price-plus"><span class="label">PLUS会员价</span><span class="price">¥11899</span></div>
  <span class="price-5">5折</span>
  <span class="price-odometer"><span>5</span><span>9</span><span>9</span><span>9</span></span>
  <span class="price-installment">¥5 首付</span>
</div>
</body></html>`;

const PAGE2 = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>测试商品2</title></head><body>
<div class="summary-price">
  <span class="price-5">5折</span>
  <span class="price-tag">¥5</span>
</div>
</body></html>`;

async function main() {
  const version = await httpJson('/json/version');
  const list = await httpJson('/json/list');
  const pageTarget = list.find((t) => t.type === 'page');
  const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws fail')); });
  let seq = 0; const pending = new Map();
  ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch (e) { return; } if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result); } };
  const send = (method, params) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id: id, method: method, params: params || {} })); });
  const evaluate = async (expression, awaitPromise) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: !!awaitPromise });
    if (r.exceptionDetails) throw new Error('eval error: ' + JSON.stringify(r.exceptionDetails).slice(0, 500));
    return r.result.value;
  };
  await send('Runtime.enable');
  await send('Page.enable');

  let source = fs
    .readFileSync(path.join(EXT, 'content.js'), 'utf8')
    .replace("if (location.hostname !== 'item.shop.example.com') return;", '/* host guard removed for test */')
    .replace(/chrome\.runtime/g, 'window.__stubChrome.runtime');
  source = source.replace('  main();', '  window.__jdTest = { collectCandidates: collectCandidates, pickPrices: pickPrices }; main();');

  async function runCase(html) {
    await send('Page.navigate', { url: 'about:blank' });
    await sleep(600);
    await evaluate('document.open(); document.write(' + JSON.stringify(html) + '); document.close(); true');
    await sleep(500);
    await evaluate(
      'window.__jdPatrolItemV2 = false; window.__testResult = null; window.__testError = null;' +
        'window.onerror = function (m) { window.__testError = String(m); };' +
        'window.__stubChrome = { runtime: {' +
        '  sendMessage: function (msg, cb) { window.__testResult = msg; if (cb) cb(); },' +
        '  onMessage: { addListener: function () {} },' +
        '  lastError: null' +
        '} }; true'
    );
    await evaluate('window.onunhandledrejection = function (e) { window.__testError = "rejection: " + String((e.reason && e.reason.stack) || e.reason); }; true');
    try {
      await evaluate(source);
    } catch (e) {
      return { error: String(e).slice(0, 500) };
    }
    await sleep(1200);
    const diag = await evaluate('(() => { try { const hook = window.__jdTest; const cands = hook ? hook.collectCandidates() : null; const picked = hook && cands ? hook.pickPrices(cands) : null; return { v2: window.__jdPatrolItemV2, err: window.__testError, hook: !!hook, candCount: cands ? cands.length : -1, top: cands ? cands.slice(0, 5).map(c => ({ price: c.price, kind: c.kind, strong: !!c.strong, score: c.score, text: c.text })) : null, picked: picked }; } catch (e) { return { diagError: String(e && e.stack || e) }; } })()');
    console.error('DIAG=' + JSON.stringify(diag));
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      const state = await evaluate('({ result: window.__testResult, err: window.__testError })');
      if (state.result) return state.result;
      if (state.err) return { error: state.err };
    }
    return { timeout: true };
  }

  const r1 = await runCase(PAGE);
  const r2 = await runCase(PAGE2);
  console.log(
    JSON.stringify(
      {
        ok: true,
        browser: version.Browser,
        case1: r1 && r1.error ? { error: r1.error } : r1 && r1.timeout ? { timeout: true } : { ok: r1.ok, reason: r1.reason, main: r1.main && r1.main.price, plus: r1.plus && r1.plus.price, hand: r1.hand && r1.hand.price },
        case2: r2 && r2.error ? { error: r2.error } : r2 && r2.timeout ? { timeout: true } : { ok: r2.ok, reason: r2.reason, main: r2.main && r2.main.price, candidateCount: (r2.candidates || []).length }
      },
      null,
      2
    )
  );
  ws.close();
}
main().catch((e) => { console.log(JSON.stringify({ ok: false, error: String((e && e.stack) || e) })); process.exit(1); });
