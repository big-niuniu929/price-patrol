// 第二轨道布局 + 截图能力自测
const PORT = Number(process.argv[2] || 9268);
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
  await send('Runtime.enable'); await send('Page.enable'); await sleep(2800);
  const out = {};
  out.layout = await evaluate(`(() => {
    const wrap = document.querySelector('.tableWrap');
    const ths = Array.from(document.querySelectorAll('#tblHead th')).map((th) => ({ cls: th.className, text: th.textContent.trim(), w: th.getBoundingClientRect().width }));
    return {
      wrapClient: wrap ? wrap.clientWidth : null,
      wrapScroll: wrap ? wrap.scrollWidth : null,
      overflow: wrap ? wrap.scrollWidth > wrap.clientWidth + 1 : null,
      ths: ths.map((t) => t.text + ':' + Math.round(t.w)).join(' | '),
      totalTh: ths.reduce((s, t) => s + t.w, 0)
    };
  })()`);
  out.capture = await evaluate(`(async () => {
    let win = null;
    try {
      win = await chrome.windows.create({ url: chrome.runtime.getURL('app.html'), type: 'popup', focused: true, width: 900, height: 700 });
      await new Promise((r) => setTimeout(r, 2500));
      const shot = await chrome.tabs.captureVisibleTab(win.id, { format: 'png' });
      return { ok: true, length: shot ? shot.length : 0, prefix: shot ? shot.slice(0, 30) : '' };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    } finally {
      if (win && win.id != null) { try { await chrome.windows.remove(win.id); } catch (e) {} }
    }
  })()`, true);
  console.log(JSON.stringify({ ok: true, browser: version.Browser, out }, null, 2));
  ws.close();
}
main().catch((e) => { console.log(JSON.stringify({ ok: false, error: String((e && e.stack) || e) })); process.exit(1); });
