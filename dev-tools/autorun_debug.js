// 调试自动巡检：连 CDP，看工作台状态、storage、日志与进度
const fs = require('fs');
const path = require('path');

const PORT = Number(process.argv[2] || 9223);
const OUT = process.argv[3] || '~/Desktop/巡检\\qa';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function httpJson(p, opts) {
  const res = await fetch('http://127.0.0.1:' + PORT + p, opts);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error('non-json: ' + text.slice(0, 200));
  }
}

function createCdp(ws) {
  let seq = 0;
  const pending = new Map();
  const events = new Map();
  ws.onmessage = (ev) => {
    let m;
    try {
      m = JSON.parse(ev.data);
    } catch (e) {
      return;
    }
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p.reject(new Error(JSON.stringify(m.error)));
      else p.resolve(m.result);
      return;
    }
    if (m.method) {
      const arr = events.get(m.method) || [];
      for (const fn of arr) {
        try {
          fn(m.params);
        } catch (e) {}
      }
    }
  };
  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
    });
  return { send, on: (m, f) => { const a = events.get(m) || []; a.push(f); events.set(m, a); }, close: () => ws.close() };
}

async function evalIn(cdp, expression, awaitPromise) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: !!awaitPromise });
  if (r.exceptionDetails) return { error: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text };
  return r.result.value;
}

const SNAP = `({
  url: location.href,
  title: document.title,
  ready: document.readyState,
  rows: document.querySelectorAll('#tblBody tr').length,
  log: ((document.getElementById('logPanel') || {}).textContent || '').slice(-1200),
  progress: (document.getElementById('progressPct') || {}).textContent || '',
  progressText: (document.getElementById('progressText') || {}).textContent || '',
  runStats: (document.getElementById('runStats') || {}).innerText || '',
  runUtilDisabled: (document.getElementById('runUtilBtn') || {}).disabled,
  bodyHead: (document.body ? document.body.innerText : '').slice(0, 600)
})`;

const STORAGE = `(async () => {
  const got = await chrome.storage.local.get('patrol.db.v2');
  const db = got['patrol.db.v2'] || {};
  return {
    settings: db.settings || null,
    autoRun: db.autoRun || null,
    lastRun: db.lastRun || null,
    captures: Object.keys(db.captures || {}).length,
    lastAutoExport: db.lastAutoExport || null
  };
})()`;

async function main() {
  const version = await httpJson('/json/version');
  let targets = await httpJson('/json/list');
  let app = targets.find((t) => t.type === 'page' && String(t.url).includes('/app.html'));
  if (!app) {
    console.log('NO_APP_TARGET', JSON.stringify(targets.map((t) => ({ type: t.type, url: String(t.url).slice(0, 120) }))));
    return;
  }
  const ws = new WebSocket(app.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const cdp = createCdp(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  cdp.on('Page.javascriptDialogOpening', (params) => {
    console.log('DIALOG', params.type, String(params.message || '').slice(0, 100));
    cdp.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
  });

  const snaps = [];
  for (let i = 0; i < 4; i++) {
    await sleep(6000);
    const snap = await evalIn(cdp, SNAP);
    const storage = await evalIn(cdp, STORAGE, true);
    snaps.push({ i, snap, storage });
    console.log(JSON.stringify({ step: i, snap: { title: snap.title, ready: snap.ready, rows: snap.rows, progress: snap.progress, progressText: snap.progressText, runStats: snap.runStats, runUtilDisabled: snap.runUtilDisabled, logTail: (snap.log || '').slice(-500) }, storage }, null, 1));
    try {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(OUT, 'autorun-debug-' + i + '.png'), Buffer.from(shot.data, 'base64'));
    } catch (e) {}
  }
  fs.writeFileSync(path.join(OUT, 'autorun-debug.json'), JSON.stringify(snaps, null, 2), 'utf8');
  cdp.close();
}

main().catch((e) => { console.log('ERR', (e && e.stack) || e); process.exit(1); });
