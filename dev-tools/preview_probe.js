// 预览窗口探针
const PORT = Number(process.argv[2] || 9251);
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
  const evaluate = async (expression, awaitPromise) => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: !!awaitPromise }); if (r.exceptionDetails) return { exception: JSON.stringify(r.exceptionDetails).slice(0, 400) }; return r.result.value; };
  await send('Runtime.enable'); await send('Page.enable'); await sleep(2500);
  const out = {};
  out.api = await evaluate('({ windows: typeof chrome.windows, create: typeof chrome.windows.create, tabs: typeof chrome.tabs })');
  out.before = await evaluate('chrome.windows.getAll({}).then(w => w.length)');
  out.create = await evaluate("chrome.windows.create({ url: 'https://item.shop.example.com/100230282311.html', type: 'popup', width: 900, height: 700, focused: false }).then(w => ({ id: w.id, tabs: (w.tabs || []).map(t => t.url) })).catch(e => ({ error: String(e) }))", true);
  await sleep(1500);
  out.after = await evaluate('chrome.windows.getAll({}).then(w => w.map(x => ({ id: x.id, tabs: (x.tabs || []).map(t => t.url) })))', true);
  out.targets = (await httpJson('/json/list')).filter((t) => t.type === 'page').map((t) => t.url);
  out.preview = await evaluate("(async () => { try { const row = state.rows.find(r => r.sku); if (!row) return { noRow: true, rows: state.rows.length }; await openPreviewWindow(row, false); } catch (e) { return { callError: String(e) }; } await new Promise(r=>setTimeout(r,800)); const ws = await chrome.windows.getAll({}); return { previewState: JSON.parse(JSON.stringify(previewState)), toast: document.getElementById('toast').textContent, windows: ws.map(w => ({ id: w.id, tabs: (w.tabs||[]).map(t=>t.url) })) }; })()", true);
  out.close = await evaluate('closePreviewWindow().then(() => chrome.windows.getAll({})).then(w => w.length)', true);
  out.targets2 = (await httpJson('/json/list')).filter((t) => t.type === 'page').map((t) => t.url);
  console.log(JSON.stringify({ ok: true, browser: version.Browser, out }, null, 2));
  ws.close();
}
main().catch((e) => { console.log(JSON.stringify({ ok: false, error: String((e && e.stack) || e) })); process.exit(1); });
