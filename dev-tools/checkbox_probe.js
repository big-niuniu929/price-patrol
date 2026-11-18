// 诊断勾选框渲染
const fs = require('fs');
const path = require('path');
const PORT = Number(process.argv[2] || 9236);
const OUT = process.argv[3] || '~/Desktop/巡检\\巡检插件版\\qa';
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
  const send = (method, params) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id: id, method, method: method, params: params || {} })); });
  const evaluate = async (expression) => { const r = await send('Runtime.evaluate', { expression, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };
  await send('Runtime.enable'); await send('Page.enable'); await sleep(2500);
  const info = await evaluate(`(() => {
    const h = document.getElementById('selectAllChk');
    const t = document.querySelector('#tblBody input[type=checkbox]');
    function desc(el) {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return { rect: { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) }, display: cs.display, visibility: cs.visibility, opacity: cs.opacity, appearance: cs.appearance, checked: el.checked, offsetParent: !!el.offsetParent };
    }
    const td = t ? t.closest('td') : null;
    const tdr = td ? td.getBoundingClientRect() : null;
    return { header: desc(h), row: desc(t), tdRect: tdr ? { x: +tdr.x.toFixed(1), w: +tdr.width.toFixed(1) } : null, elementAtHeaderCenter: (() => { const r = h.getBoundingClientRect(); const e = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return e ? e.tagName + '.' + e.className : null; })() };
  })()`);
  await evaluate("(() => { const h = document.getElementById('selectAllChk'); h.style.background = 'red'; h.style.outline = '2px solid blue'; return true; })()");
  await sleep(300);
  try {
    const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 300, width: 360, height: 140, scale: 2 } });
    fs.writeFileSync(path.join(OUT, 'checkbox-probe.png'), Buffer.from(shot.data, 'base64'));
    console.log(JSON.stringify({ ok: true, browser: version.Browser, info, shot: true }, null, 2));
  } catch (e) {
    console.log(JSON.stringify({ ok: true, info, shot: false }, null, 2));
  }
  ws.close();
}
main().catch((e) => { console.log(JSON.stringify({ ok: false, error: String((e && e.stack) || e) })); process.exit(1); });
