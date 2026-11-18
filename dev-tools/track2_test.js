// 第二轨道自测：UI/设置/AI识图/官方API/截图列
const fs = require('fs');
const PORT = Number(process.argv[2] || 9267);
const IMG = process.argv[3] || '~/Desktop/巡检\\巡检插件版\\qa\\ai-vision-test.png';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function httpJson(p) { const res = await fetch('http://127.0.0.1:' + PORT + p); return JSON.parse(await res.text()); }
async function main() {
  const version = await httpJson('/json/version');
  let app = null;
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    const list = await httpJson('/json/list');
    app = list.find((t) => t.type === 'page' && String(t.url).includes('/app.html'));
    if (app) break;
    await sleep(700);
  }
  if (!app) { console.log(JSON.stringify({ ok: false, error: 'no app' })); process.exit(2); }
  const ws = new WebSocket(app.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws fail')); });
  let seq = 0; const pending = new Map();
  ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch (e) { return; } if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result); } };
  const send = (method, params) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id: id, method: method, params: params || {} })); });
  const evaluate = async (expression, awaitPromise) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: !!awaitPromise });
    if (r.exceptionDetails) throw new Error('eval error: ' + JSON.stringify(r.exceptionDetails).slice(0, 600));
    return r.result.value;
  };
  await send('Runtime.enable'); await send('Page.enable'); await sleep(2800);
  await evaluate("window.alert = function (m) { window.__lastAlert = String(m); }; window.confirm = function () { return true; }; true");

  const out = {};
  out.ui = await evaluate(`(() => {
    const headers = Array.from(document.querySelectorAll('#tblHead th, table.tbl thead th')).map((th) => th.textContent.trim()).filter(Boolean);
    const wrap = document.getElementById('tableWrap');
    return {
      rows: state.rows.length,
      headers: headers.slice(0, 20),
      shotColumn: headers.indexOf('截图') >= 0,
      hasOfficialBtn: !!document.getElementById('runOfficialBtn'),
      hasShotDialog: !!document.getElementById('shotDialog'),
      horizontalScroll: wrap ? wrap.scrollWidth > wrap.clientWidth + 1 : null,
      tableWidth: wrap ? wrap.scrollWidth : null,
      wrapWidth: wrap ? wrap.clientWidth : null,
      patrolMode: state.db.settings.patrolMode,
      aiEndpoint: state.db.settings.aiEndpoint,
      aiModel: state.db.settings.aiModel
    };
  })()`);

  const b64 = fs.readFileSync(IMG).toString('base64');
  const dataUrl = 'data:image/png;base64,' + b64;
  out.ai = await evaluate(`(async () => {
    state.db.settings.aiApiKey = 'sk-REDACTED';
    state.db.settings.aiVerifyMode = 'fallback';
    const ai = await aiExtractPrice(${JSON.stringify(dataUrl)});
    return ai;
  })()`, true);

  out.official = await evaluate(`(async () => {
    await runOfficialApi();
    const caps = state.db.captures || {};
    const official = Object.keys(caps).filter((sku) => caps[sku] && caps[sku].util && caps[sku].util.kind === 'official');
    const all = Object.keys(caps);
    return { officialCount: official.length, capturedSkuCount: all.length, sample: official.slice(0, 5).map((s) => ({ sku: s, price: caps[s].util.price })), toast: document.getElementById('toast') ? document.getElementById('toast').textContent : '' };
  })()`, true);

  out.thumb = await evaluate(`(async () => {
    const sku = state.rows.find((r) => r.sku && state.rows.every((x) => x.sku !== null)).sku;
    const target = state.rows.find((r) => r.sku);
    await storeThumb(target.sku, ${JSON.stringify(dataUrl)}, { fallback: true, at: new Date().toISOString(), hand_price: 12399 });
    renderAll();
    const imgs = document.querySelectorAll('#tblBody img.shotThumb');
    const badges = Array.from(document.querySelectorAll('#tblBody .shotBadge')).map((b) => b.textContent);
    openShotDialog(target.sku);
    const dialogOpen = document.getElementById('shotDialog').open;
    document.getElementById('shotDialog').close();
    return { sku: target.sku, thumbImgs: imgs.length, badges: badges.slice(0, 3), dialogOpen };
  })()`, true);

  out.errors = await evaluate("(window.__errors || []).slice(0, 5)");
  console.log(JSON.stringify({ ok: true, browser: version.Browser, out }, null, 2));
  ws.close();
}
main().catch((e) => { console.log(JSON.stringify({ ok: false, error: String((e && e.stack) || e) })); process.exit(1); });
