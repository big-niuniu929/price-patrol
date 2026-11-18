// 双轨版自测：轨道切换 / AI 预配置 / 官方API状态
const PORT = Number(process.argv[2] || 9277);
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
    if (r.exceptionDetails) throw new Error('eval error: ' + JSON.stringify(r.exceptionDetails).slice(0, 500));
    return r.result.value;
  };
  await send('Runtime.enable'); await send('Page.enable'); await sleep(3200);
  await evaluate("window.alert = function (m) { window.__lastAlert = String(m); }; window.confirm = function () { return true; }; true");

  const out = {};
  out.initial = await evaluate(`(() => ({
    title: document.title,
    bodyClass: document.body.className,
    badge: document.getElementById('trackBadge').textContent,
    meta: document.getElementById('trackMeta').textContent,
    activeTrack: state.db.settings.patrolMode,
    aiChip: document.getElementById('aiStatusChip').textContent,
    aiChipClass: document.getElementById('aiStatusChip').className,
    apiChip: document.getElementById('apiStatusChip').textContent,
    aiKeyConfigured: !!state.db.settings.aiApiKey,
    aiModel: state.db.settings.aiModel,
    trackButtons: Array.from(document.querySelectorAll('.trackOpt')).map((b) => b.textContent.trim()),
    hasAiBtn: !!document.getElementById('aiBtn')
  }))()`);
  await sleep(1200);
  out.apiChipAfterCheck = await evaluate("document.getElementById('apiStatusChip').textContent + ' / ' + document.getElementById('apiStatusChip').className");

  out.switch1 = await evaluate(`(async () => {
    document.querySelector('.trackOpt[data-track="track1"]').click();
    await new Promise((r) => setTimeout(r, 400));
    return {
      mode: state.db.settings.patrolMode,
      bodyClass: document.body.className,
      badge: document.getElementById('trackBadge').textContent,
      title: document.title,
      active: Array.from(document.querySelectorAll('.trackOpt')).map((b) => b.className)
    };
  })()`, true);

  out.switch2 = await evaluate(`(async () => {
    document.querySelector('.trackOpt[data-track="track2"]').click();
    await new Promise((r) => setTimeout(r, 400));
    return {
      mode: state.db.settings.patrolMode,
      bodyClass: document.body.className,
      badge: document.getElementById('trackBadge').textContent,
      title: document.title
    };
  })()`, true);

  out.aiTest = await evaluate(`(async () => {
    const ai = await aiExtractPrice(${JSON.stringify('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==')});
    return { got: ai, keyLoaded: !!state.db.settings.aiApiKey };
  })()`, true).catch((e) => ({ error: String((e && e.message) || e) }));

  out.settingsUi = await evaluate(`(() => {
    openSettings();
    const visible = (id) => { const el = document.getElementById(id); return !!(el && el.offsetParent !== null); };
    const res = {
      aiEndpointVisible: visible('setAiEndpoint'),
      aiKeyVisible: visible('setAiKey'),
      aiTestBtnVisible: visible('aiTestBtn'),
      patrolModeVisible: visible('setPatrolMode')
    };
    document.getElementById('settingsDialog').close();
    return res;
  })()`);

  out.official = await evaluate(`(async () => {
    await runOfficialApi();
    const caps = state.db.captures || {};
    const official = Object.keys(caps).filter((sku) => caps[sku] && caps[sku].util && caps[sku].util.kind === 'official');
    const sample = official.slice(0, 3).map((sku) => ({ sku, price: caps[sku].util.price, source: caps[sku].util.source }));
    return { officialCount: official.length, sample, apiChip: document.getElementById('apiStatusChip').textContent };
  })()`, true);

  out.alerts = await evaluate("window.__lastAlert || ''");
  console.log(JSON.stringify({ ok: true, browser: version.Browser, out }, null, 2));
  ws.close();
}
main().catch((e) => { console.log(JSON.stringify({ ok: false, error: String((e && e.stack) || e) })); process.exit(1); });
