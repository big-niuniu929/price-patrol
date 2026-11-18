// 最终冒烟测试：确认扩展可加载、工作台渲染正常、新按钮/弹窗存在
const fs = require('fs');
const path = require('path');
const PORT = Number(process.argv[2] || 9233);
const OUT = process.argv[3] || '~/Desktop/巡检\\qa';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function httpJson(p) {
  const res = await fetch('http://127.0.0.1:' + PORT + p);
  const text = await res.text();
  return JSON.parse(text);
}

async function main() {
  const version = await httpJson('/json/version');
  let app = null;
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    const list = await httpJson('/json/list');
    app = list.find((t) => t.type === 'page' && String(t.url).includes('/app.html'));
    if (app) break;
    await sleep(800);
  }
  if (!app) {
    console.log(JSON.stringify({ ok: false, browser: version.Browser, error: 'no extension app page' }));
    process.exit(2);
  }
  const ws = new WebSocket(app.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('ws fail'));
  });
  let seq = 0;
  const pending = new Map();
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
    }
  };
  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
    });
  await send('Runtime.enable');
  await send('Page.enable');
  await sleep(2500);
  const expr = `(() => ({
    title: document.title,
    url: location.href,
    rows: document.querySelectorAll('#tblBody tr').length,
    stats: (document.getElementById('statsBar') || {}).innerText || '',
    baseInfo: (document.getElementById('baseInfo') || {}).textContent || '',
    hasHelpBtn: !!document.getElementById('helpBtn'),
    hasHelpDialog: !!document.getElementById('helpDialog'),
    hasExportJsonBtn: !!document.getElementById('exportJsonBtn'),
    hasCopyDebugBtn: !!document.getElementById('copyDebugBtn'),
    hasRunButtons: !!document.getElementById('runUtilBtn') && !!document.getElementById('runPlusBtn'),
    hasMultiRerun: !!document.getElementById('multiRerunBtn'),
    hasSelectAll: !!document.getElementById('selectAllChk'),
    rowCheckboxes: document.querySelectorAll('#tblBody input[type="checkbox"]').length,
    priceEditButtons: document.querySelectorAll('#tblBody .priceEditBtn').length,
    firstRowPrices: (() => {
      const tr = document.querySelector('#tblBody tr');
      if (!tr) return null;
      return Array.from(tr.querySelectorAll('.priceVal')).map((el) => el.textContent);
    })(),
    initErrorText: (document.querySelector('body > div') || {}).textContent || ''
  }))()`;
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  const value = r.result.value;
  let shotOk = false;
  try {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, 'workbench-final.png'), Buffer.from(shot.data, 'base64'));
    shotOk = true;
  } catch (e) {}
  console.log(JSON.stringify({ ok: true, browser: version.Browser, value: value, shotOk: shotOk }, null, 2));
  ws.close();
}

main().catch((e) => {
  console.log(JSON.stringify({ ok: false, error: String((e && e.stack) || e) }));
  process.exit(1);
});
