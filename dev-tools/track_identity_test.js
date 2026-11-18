// 轨道标识自测：标题/徽标/设置里的轨道信息
const PORT = Number(process.argv[2] || 9274);
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
  const evaluate = async (expression) => { const r = await send('Runtime.evaluate', { expression, returnByValue: true }); if (r.exceptionDetails) throw new Error('eval error: ' + JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result.value; };
  await send('Runtime.enable'); await sleep(2800);
  const out = await evaluate(`(() => {
    openSettings();
    const info = document.getElementById('trackInfo');
    const res = {
      title: document.title,
      badge: (document.getElementById('trackBadge') || {}).textContent || '',
      meta: (document.getElementById('trackMeta') || {}).textContent || '',
      trackInfo: info ? info.textContent : '',
      bodyClass: document.body.className,
      badgeColor: getComputedStyle(document.getElementById('trackBadge')).color,
      extensionId: chrome.runtime.id,
      runButtons: Array.from(document.querySelectorAll('.runBar button')).map((b) => b.textContent.trim()).slice(0, 6)
    };
    document.getElementById('settingsDialog').close();
    return res;
  })()`);
  console.log(JSON.stringify({ ok: true, browser: version.Browser, out }, null, 2));
  ws.close();
}
main().catch((e) => { console.log(JSON.stringify({ ok: false, error: String((e && e.stack) || e) })); process.exit(1); });
