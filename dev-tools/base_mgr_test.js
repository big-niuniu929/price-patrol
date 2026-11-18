// 基表管理自测
const PORT = Number(process.argv[2] || 9257);
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
  await send('Runtime.enable'); await send('Page.enable'); await sleep(2500);

  const out = {};
  out.open = await evaluate(`(() => {
    openBaseManager();
    return {
      dialogOpen: document.getElementById('baseDialog').open,
      tabs: Array.from(document.querySelectorAll('#baseCatTabs .tab')).map((b) => b.textContent),
      rows: document.querySelectorAll('#baseTblBody tr').length,
      active: state.baseManager.sheet
    };
  })()`);

  out.edit = await evaluate(`(() => {
    addBaseRow();
    const trs = document.querySelectorAll('#baseTblBody tr');
    const tr = trs[trs.length - 1];
    const inputs = tr.querySelectorAll('input');
    const values = ['999999999999', '测试型号X1', '测试套餐', '5000', '4800', '4700'];
    inputs.forEach((input, i) => {
      input.value = values[i];
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    return { rowCount: trs.length, active: state.baseManager.sheet };
  })()`);
  await evaluate(`document.getElementById('baseSaveBtn').click()`);
  await sleep(1200);
  out.saved = await evaluate(`(() => {
    const row = state.rows.find((r) => r.sku === '999999999999');
    return {
      totalRows: state.rows.length,
      baseTotal: state.db.baseOverride && state.db.baseOverride.totalRows,
      stillHasOverride: !!state.db.baseOverride,
      row: row ? { sku: row.sku, sheet: row.sheet, model: row.model, frontPrice: row.frontPrice, utilMin: row.utilMin, plusMin: row.plusMin } : null,
      baseInfo: document.getElementById('baseInfo').textContent
    };
  })()`);

  out.delete = await evaluate(`(async () => {
    openBaseManager();
    const trs = document.querySelectorAll('#baseTblBody tr');
    const last = trs[trs.length - 1];
    const target = (state.baseManager.draft.sheets || []).flatMap((s) => s.rows || []).find((r) => r.sku === '999999999999');
    if (target) {
      const sheet = (state.baseManager.draft.sheets || []).find((s) => (s.rows || []).indexOf(target) >= 0);
      sheet.rows = sheet.rows.filter((r) => r !== target);
      renderBaseManager();
    }
    await saveBaseManager();
    return { totalRows: state.rows.length, stillHas: !!state.rows.find((r) => r.sku === '999999999999') };
  })()`, true);

  out.restore = await evaluate(`(async () => {
    if (document.getElementById('baseDialog').open) document.getElementById('baseDialog').close();
    state.db.baseOverride = null;
    await saveDb();
    await reloadBase();
    renderAll();
    return { totalRows: state.rows.length, hasOverride: !!state.db.baseOverride };
  })()`, true);

  out.afterRestore = await evaluate(`({ rows: document.querySelectorAll('#tblBody tr').length, baseInfo: document.getElementById('baseInfo').textContent })`);
  console.log(JSON.stringify({ ok: true, browser: version.Browser, out }, null, 2));
  ws.close();
}
main().catch((e) => { console.log(JSON.stringify({ ok: false, error: String((e && e.stack) || e) })); process.exit(1); });
