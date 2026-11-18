// 总览页 / 待上报区 / Excel 导出 自测脚本
const fs = require('fs');
const path = require('path');
const PORT = Number(process.argv[2] || 9235);
const OUT = process.argv[3] || '~/Desktop/巡检\\巡检插件版\\qa';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function httpJson(p) {
  const res = await fetch('http://127.0.0.1:' + PORT + p);
  return JSON.parse(await res.text());
}

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
  if (!app) {
    console.log(JSON.stringify({ ok: false, error: 'no app page', browser: version.Browser }));
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
  const evaluate = async (expression, awaitPromise) => {
    const r = await send('Runtime.evaluate', { expression: expression, returnByValue: true, awaitPromise: !!awaitPromise });
    if (r.exceptionDetails) throw new Error('eval error: ' + JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await sleep(2500);

  const result = {};
  result.init = await evaluate(`(() => ({
    title: document.title,
    rows: document.querySelectorAll('#tblBody tr').length,
    hasOverviewTab: !!document.getElementById('tabOverview'),
    initError: !!document.querySelector('body > div[style*="ffccc7"]')
  }))()`);

  await evaluate("switchView('overview')");
  await sleep(400);
  result.overview = await evaluate(`(() => ({
    view: document.getElementById('viewOverview').classList.contains('hidden') ? 'hidden' : 'shown',
    cards: document.querySelectorAll('.ovCard').length,
    cardTexts: Array.from(document.querySelectorAll('.ovCard')).map(c => c.querySelector('.ovK').textContent + '=' + c.querySelector('.ovV').textContent),
    rows: document.querySelectorAll('#tblBody tr').length,
    caption: document.getElementById('tableCaption').textContent,
    tabs: document.querySelectorAll('#ovSheetTabs .tab').length
  }))()`);

  // 注入一条假采集 + 勾选（含「需人工确认」标记，验证卡片/确认按钮/状态流转）
  await evaluate(`(() => {
    const sku = '100230282311';
    state.db.captures[sku] = {
      util: { price: 12399, kind: 'hand', at: new Date().toISOString(), account: '测试账号', offThreshold: { threshold: 11499, limit: 500, confirmLimit: 1500, attempts: [13499, 12399, 12200], needsConfirm: true, at: new Date().toISOString() } },
      plus: { price: 11000, kind: 'plus', at: new Date().toISOString(), account: '测试账号' }
    };
    state.selected.add(sku);
    renderAll();
    return true;
  })()`);
  await sleep(300);
  result.afterInject = await evaluate(`(() => ({
    cards: Array.from(document.querySelectorAll('.ovCard')).map(c => c.querySelector('.ovK').textContent + '=' + c.querySelector('.ovV').textContent),
    statusText: (() => { const tr = document.querySelector('#tblBody tr'); const b = tr && tr.querySelector('.badge'); return b ? b.textContent : null; })(),
    hasConfirmBtn: !!document.querySelector('#tblBody .priceConfirmBtn'),
    confirmBtnText: (() => { const b = document.getElementById('ovConfirmBtn'); return b ? b.textContent + '/' + (b.disabled ? 'disabled' : 'enabled') : null; })(),
    summaryBtn: document.getElementById('ovSummaryBtn').textContent + '/' + (document.getElementById('ovSummaryBtn').disabled ? 'disabled' : 'enabled'),
    reportRows: (state.db.reportRows || []).length
  }))()`);

  // 点「确认选中」→ 状态应转为正常、确认卡片清零
  await evaluate('confirmSelectedDeviation()', true);
  await sleep(400);
  result.afterConfirm = await evaluate(`(() => ({
    confirmCard: (() => { const c = Array.from(document.querySelectorAll('.ovCard')).find(x => x.querySelector('.ovK').textContent === '需人工确认'); return c ? c.querySelector('.ovV').textContent : null; })(),
    statusText: (() => { const tr = document.querySelector('#tblBody tr'); const b = tr && tr.querySelector('.badge'); return b ? b.textContent : null; })(),
    hasConfirmBtn: !!document.querySelector('#tblBody .priceConfirmBtn'),
    confirmedTag: (() => { const el = document.querySelector('#tblBody .priceWarn.confirmed'); return el ? el.textContent : null; })(),
    confirmedFlag: !!(state.db.captures['100230282311'].util.offThreshold.confirmed)
  }))()`);

  // DOM 直接点价格格里的「确认」按钮（验证按钮本身可点）
  await evaluate(`(() => {
    const cap = state.db.captures['100230282311'];
    cap.util.offThreshold.confirmed = false;
    delete cap.util.offThreshold.confirmedAt;
    renderAll();
    return true;
  })()`);
  await sleep(400);
  result.domConfirmClick = await evaluate(`(() => {
    const btn = document.querySelector('#tblBody .priceConfirmBtn');
    if (!btn) return { clicked: false, reason: 'button not found' };
    btn.click();
    return { clicked: true };
  })()`);
  await sleep(500);
  result.domConfirmResult = await evaluate(`(() => ({
    statusText: (() => { const tr = document.querySelector('#tblBody tr'); const b = tr && tr.querySelector('.badge'); return b ? b.textContent : null; })(),
    confirmed: !!(state.db.captures['100230282311'].util.offThreshold && state.db.captures['100230282311'].util.offThreshold.confirmed)
  }))()`);

  // 人工确认后：即使价格低于阈值，状态也应显示「正常」
  result.confirmOverridesStatus = await evaluate(`(async () => {
    const row = state.rows.find((r) => r.sku === '100230282311');
    const cap = state.db.captures['100230282311'];
    cap.util.price = 9999;
    cap.util.offThreshold.confirmed = false;
    delete cap.manualConfirmed;
    delete cap.confirmedAt;
    renderAll();
    const beforeStatus = (() => { const tr = document.querySelector('#tblBody tr'); const b = tr && tr.querySelector('.badge'); return b ? b.textContent : null; })();
    await confirmDeviation(row, 'util');
    const afterStatus = (() => { const tr = document.querySelector('#tblBody tr'); const b = tr && tr.querySelector('.badge'); return b ? b.textContent : null; })();
    return { beforeStatus, afterStatus, manualConfirmed: !!state.db.captures['100230282311'].manualConfirmed };
  })()`, true);
  await sleep(300);

  // 下架库：移入 → 默认隐藏 + 卡片计数；筛选已下架可见；恢复
  result.offline = await evaluate(`(async () => {
    const row = state.rows.find((r) => r.sku === '100230282311');
    const before = document.querySelectorAll('#tblBody tr').length;
    await toggleOffline(row);
    const after = document.querySelectorAll('#tblBody tr').length;
    const card = Array.from(document.querySelectorAll('.ovCard')).find((x) => x.querySelector('.ovK').textContent === '已下架');
    const cardVal = card ? card.querySelector('.ovV').textContent : null;
    state.ovFilter.key = 'offline';
    renderAll();
    const offlineVisible = document.querySelectorAll('#tblBody tr').length;
    state.ovFilter.key = 'all';
    await toggleOffline(row);
    renderAll();
    return { before, after, cardVal, offlineVisible, restored: document.querySelectorAll('#tblBody tr').length, offlineSkus: (state.db.offlineSkus || []).slice() };
  })()`, true);
  await sleep(300);

  // 小眼睛：悬停 0.6 秒后应打开预览窗口，关闭后窗口消失
  result.preview = await evaluate(`(async () => {
    const eye = document.querySelector('#tblBody .eyeBtn');
    if (!eye) return { eye: false };
    eye.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 1500));
    const wins = await chrome.windows.getAll({});
    const urls = wins.map((w) => ((w.tabs && w.tabs[0] && w.tabs[0].url) || '')).filter(Boolean);
    const itemWins = urls.filter((u) => u.indexOf('item.shop.example.com') >= 0);
    await closePreviewWindow();
    await new Promise((r) => setTimeout(r, 600));
    const wins2 = await chrome.windows.getAll({});
    return { eye: true, windows: wins.length, itemWindows: itemWins.length, afterClose: wins2.length };
  })()`, true);
  await sleep(200);

  // 总览布局：类目 tab 在卡片上方
  result.layout = await evaluate(`(() => {
    const tabs = document.getElementById('ovSheetTabs');
    const cards = document.getElementById('ovCards');
    return {
      cards: document.querySelectorAll('.ovCard').length,
      tabsBeforeCards: !!(tabs.compareDocumentPosition(cards) & Node.DOCUMENT_POSITION_FOLLOWING)
    };
  })()`);

  // 汇总选中 → 待上报区
  await evaluate('addSelectedToReport()', true);
  await sleep(500);
  result.afterSummary = await evaluate(`(() => ({
    reportRows: (state.db.reportRows || []).length,
    reportBadge: document.getElementById('reportBadge').textContent,
    reportVisible: !document.getElementById('reportArea').classList.contains('hidden'),
    reportItems: document.querySelectorAll('.reportItem').length,
    reportedRowHighlighted: document.querySelectorAll('tr.rowReport').length
  }))()`);

  // 截图（总览 + 待上报区）
  try {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, 'overview.png'), Buffer.from(shot.data, 'base64'));
    result.screenshot = true;
  } catch (e) {
    result.screenshot = false;
  }

  // 导出待上报 Excel
  await evaluate('exportReportXlsx()');
  await sleep(2500);
  result.exportCalled = true;

  // 切回工作台确认
  await evaluate("switchView('workbench')");
  await sleep(300);
  result.backToWorkbench = await evaluate(`(() => ({
    workbenchShown: !document.getElementById('viewWorkbench').classList.contains('hidden'),
    rows: document.querySelectorAll('#tblBody tr').length
  }))()`);

  console.log(JSON.stringify({ ok: true, browser: version.Browser, result: result }, null, 2));
  ws.close();
}

main().catch((e) => {
  console.log(JSON.stringify({ ok: false, error: String((e && e.stack) || e) }));
  process.exit(1);
});
