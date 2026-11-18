// 生成 README 预览截图（工作台 + 总览页），并做最终 UI 冒烟检查
const fs = require('fs');
const path = require('path');
const PORT = Number(process.argv[2] || 9240);
const EXT = process.argv[3] || '~/Desktop/巡检\\巡检插件版\\extension';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function httpJson(p) { const res = await fetch('http://127.0.0.1:' + PORT + p); return JSON.parse(await res.text()); }

async function main() {
  const version = await httpJson('/json/version');
  let app = null;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const list = await httpJson('/json/list');
    app = list.find((t) => t.type === 'page' && String(t.url).includes('/app.html'));
    if (app) break;
    await sleep(800);
  }
  if (!app) { console.log(JSON.stringify({ ok: false, error: 'no app page' })); process.exit(2); }
  const ws = new WebSocket(app.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws fail')); });
  let seq = 0; const pending = new Map();
  ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch (e) { return; } if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result); } };
  const send = (method, params) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id: id, method: method, params: params || {} })); });
  const evaluate = async (expression, awaitPromise) => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: !!awaitPromise }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result.value; };
  const shot = async (file) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  };
  await send('Runtime.enable');
  await send('Page.enable');
  await sleep(2600);
  const extRoot = path.resolve(EXT, '..');
  const qa = path.join(extRoot, 'qa');
  fs.mkdirSync(qa, { recursive: true });
  fs.mkdirSync(path.join(EXT, 'docs'), { recursive: true });

  const checks = await evaluate(`(() => {
    const td = document.querySelector('#tblBody td.col-check');
    const wrap = document.querySelector('.tableWrap');
    return {
      rows: document.querySelectorAll('#tblBody tr').length,
      initError: !!document.querySelector('body > div[style*="ffccc7"]'),
      checkboxCellWidth: td ? +td.getBoundingClientRect().width.toFixed(0) : null,
      hasOverviewTab: !!document.getElementById('tabOverview'),
      hasSummaryBtn: !!document.getElementById('ovSummaryBtn'),
      hasImportData: !!document.getElementById('importDataBtn'),
      hasExportReport: !!document.getElementById('ovExportReportBtn'),
      tableWidth: Math.round(document.querySelector('.tbl').getBoundingClientRect().width),
      wrapWidth: wrap ? wrap.clientWidth : null,
      horizontalScroll: wrap ? wrap.scrollWidth > wrap.clientWidth + 1 : null
    };
  })()`);
  await shot(path.join(qa, 'workbench-final.png'));
  fs.copyFileSync(path.join(qa, 'workbench-final.png'), path.join(EXT, 'docs', 'preview.png'));

  await evaluate("switchView('overview')");
  await sleep(600);
  const overview = await evaluate(`(() => ({
    cards: document.querySelectorAll('.ovCard').length,
    caption: document.getElementById('tableCaption').textContent,
    reportHidden: document.getElementById('reportArea').classList.contains('hidden'),
    view: document.getElementById('viewOverview').classList.contains('hidden') ? 'hidden' : 'shown'
  }))()`);
  await shot(path.join(qa, 'overview.png'));
  fs.copyFileSync(path.join(qa, 'overview.png'), path.join(EXT, 'docs', 'preview-overview.png'));

  await evaluate("switchView('workbench')");
  await sleep(300);
  console.log(JSON.stringify({ ok: true, browser: version.Browser, checks: checks, overview: overview }, null, 2));
  ws.close();
}
main().catch((e) => { console.log(JSON.stringify({ ok: false, error: String((e && e.stack) || e) })); process.exit(1); });
