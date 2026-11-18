// Excel 基表导入 + 总览类目统计自测
const fs = require('fs');
const PORT = Number(process.argv[2] || 9259);
const XLSX = process.argv[3] || '~/Desktop/SKU巡检表.xlsx';
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
  await send('Runtime.enable'); await send('Page.enable'); await sleep(2500);
  await evaluate("window.alert = function (msg) { window.__lastAlert = String(msg); }; window.confirm = function () { return true; }; true");

  const b64 = fs.readFileSync(XLSX).toString('base64');
  const out = {};
  out.importResult = await evaluate(`(async () => {
    const raw = atob(${JSON.stringify(b64)});
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    const file = new File([bytes], 'SKU巡检表.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    let zipDebug = null;
    try {
      const buffer = await file.arrayBuffer();
      const zip = await readZipEntries(buffer);
      const entry = zip.entries.get('xl/workbook.xml');
      zipDebug = {
        byteLength: buffer.byteLength,
        entryCount: zip.entries.size,
        entry: entry || null,
        localSig: entry ? zip.u16(entry.localOffset).toString(16) : null,
        firstBytes: Array.from(new Uint8Array(buffer).slice(0, 8)).map((b) => b.toString(16)).join(' ')
      };
    } catch (e) {
      zipDebug = { error: String((e && e.message) || e) };
    }
    try {
      const parsed = await parseXlsxBase(file);
      window.__parsedSummary = { sheets: parsed.sheets.map((sh) => ({ name: sh.name, rows: sh.rowCount, withSku: sh.withSku, deduped: sh.deduped })), totalRows: parsed.totalRows, totalWithSku: parsed.totalWithSku };
    } catch (e) {
      return { parseError: String((e && e.stack) || e), alert: window.__lastAlert, zipDebug: zipDebug };
    }
    await importBaseFile(file, { skipConfirm: true });
    const base = state.db.baseOverride || state.base;
    const skus = base.sheets.flatMap((sh) => sh.rows.map((r) => r.sku).filter(Boolean));
    const dup = skus.filter((s, i) => skus.indexOf(s) !== i);
    return {
      sheets: base.sheets.map((sh) => ({ name: sh.name, rows: sh.rowCount, withSku: sh.withSku, deduped: sh.deduped })),
      totalRows: base.totalRows,
      totalWithSku: base.totalWithSku,
      stateRows: state.rows.length,
      dupInBase: dup.length,
      columnsSamples: base.sheets.map((sh) => ({ name: sh.name, cols: sh.columns })),
      parsed: window.__parsedSummary,
      zipDebug: zipDebug,
      alert: window.__lastAlert
    };
  })()`, true);

  // 总览：按类目统计
  await evaluate("switchView('overview')");
  await sleep(300);
  async function readCards(sheet) {
    const r = await evaluate(`(() => {
      state.ovFilter.sheet = ${JSON.stringify(sheet)};
      renderAll();
      const cards = Array.from(document.querySelectorAll('.ovCard')).map((c) => c.querySelector('.ovK').textContent + '=' + c.querySelector('.ovV').textContent);
      const caption = document.getElementById('tableCaption').textContent;
      const rows = document.querySelectorAll('#tblBody tr').length;
      return { cards, caption, rows };
    })()`);
    await sleep(150);
    return r;
  }
  out.overview = {};
  for (const sheet of ['全部', '品牌A', '大家电', '3C店铺', '音视频店']) {
    out.overview[sheet] = await readCards(sheet);
  }

  out.patrolTasks = await evaluate(`(() => {
    const tasks = collectTasks('util');
    return { tasks: tasks.length };
  })()`);
  out.baseInfo = await evaluate(`document.getElementById('baseInfo').textContent`);

  console.log(JSON.stringify({ ok: true, browser: version.Browser, out }, null, 2));
  ws.close();
}
main().catch((e) => { console.log(JSON.stringify({ ok: false, error: String((e && e.stack) || e) })); process.exit(1); });
