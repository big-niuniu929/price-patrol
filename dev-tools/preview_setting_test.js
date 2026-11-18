// 预览延迟设置自测
const PORT = Number(process.argv[2] || 9266);
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
    if (r.exceptionDetails) throw new Error('eval error: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result.value;
  };
  await send('Runtime.enable'); await send('Page.enable'); await sleep(2500);
  await evaluate("window.alert = function () {}; window.confirm = function () { return true; }; true");
  const out = {};
  out.hasInput = await evaluate("!!document.getElementById('setPreviewDelay')");
  out.defaultValue = await evaluate("previewDelayValue()");
  out.afterSave = await evaluate(`(async () => {
    openSettings();
    const input = document.getElementById('setPreviewDelay');
    input.value = '1600';
    await saveSettings();
    document.getElementById('settingsDialog').close();
    return { setting: state.db.settings.previewDelayMs, value: previewDelayValue() };
  })()`, true);
  out.clampLow = await evaluate(`(() => { state.db.settings.previewDelayMs = 100; return previewDelayValue(); })()`);
  out.clampHigh = await evaluate(`(() => { state.db.settings.previewDelayMs = 99999; return previewDelayValue(); })()`);
  console.log(JSON.stringify({ ok: true, browser: version.Browser, out }, null, 2));
  ws.close();
}
main().catch((e) => { console.log(JSON.stringify({ ok: false, error: String((e && e.stack) || e) })); process.exit(1); });
