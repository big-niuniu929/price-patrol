// 内部自动化脚本：用已授权的登录态在后台驱动工作台，跑一小批真实巡检并取回结果
// 用法：node auto_patrol.js <cdpPort> <extensionPath> <outDir> <batchSize> <identity: auto|util|plus>
const fs = require('fs');
const path = require('path');

const PORT = Number(process.argv[2] || 9222);
const EXT_PATH = process.argv[3] || '~/Desktop/巡检\\巡检插件版\\extension';
const OUT_DIR = process.argv[4] || '~/Desktop/巡检\\qa';
const BATCH = Number(process.argv[5] || 5);
const IDENTITY_MODE = process.argv[6] || 'auto';
const DB_KEY = 'patrol.db.v2';
const RUN_TIMEOUT_MS = 6 * 60 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (obj) => console.log('AUTOPATROL ' + JSON.stringify(obj));

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
  const listeners = new Map();
  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch (e) {
      return;
    }
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method) {
      const fns = listeners.get(msg.method) || [];
      for (const fn of fns) {
        try {
          fn(msg.params);
        } catch (e) {
          // 忽略
        }
      }
    }
  };
  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
    });
  const on = (method, fn) => {
    const arr = listeners.get(method) || [];
    arr.push(fn);
    listeners.set(method, arr);
  };
  return { send, on, close: () => ws.close() };
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('ws connect failed'));
  });
  return createCdp(ws);
}

async function pageEval(cdp, expression, awaitPromise) {
  const r = await cdp.send('Runtime.evaluate', { expression: expression, returnByValue: true, awaitPromise: !!awaitPromise });
  if (r.exceptionDetails) throw new Error('evaluate exception: ' + (r.exceptionDetails.text || ''));
  return r.result ? r.result.value : undefined;
}

async function waitReady(cdp, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const v = await pageEval(cdp, '({ready:document.readyState,url:location.href,title:document.title,textLen:(document.body?document.body.innerText.length:0)})');
      if (v && v.ready === 'complete' && v.textLen > 20) return v;
    } catch (e) {
      // 跳转中
    }
    await sleep(500);
  }
  return null;
}

async function inspectUrl(url, expression, timeoutMs, pngPath) {
  const nt = await httpJson('/json/new?' + encodeURIComponent(url), { method: 'PUT' });
  const cdp = await connect(nt.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  const probe = await waitReady(cdp, timeoutMs);
  let value = null;
  try {
    value = await pageEval(cdp, expression, false);
  } catch (e) {
    value = { error: String((e && e.message) || e) };
  }
  if (pngPath) {
    try {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(pngPath, Buffer.from(shot.data, 'base64'));
    } catch (e) {
      // 忽略
    }
  }
  cdp.close();
  return { probe: probe, value: value };
}

function extIdCandidates() {
  const crypto = require('crypto');
  const out = [];
  for (const v of [EXT_PATH, EXT_PATH.replace(/\\/g, '/'), EXT_PATH.toLowerCase()]) {
    const hex = crypto.createHash('sha256').update(v, 'utf8').digest('hex').slice(0, 32);
    out.push([...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join(''));
  }
  return Array.from(new Set(out));
}

async function findExtTarget() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const list = await httpJson('/json/list');
    const found = list.find((t) => t.url && t.url.indexOf('chrome-extension://') === 0);
    if (found) {
      const extId = found.url.replace('chrome-extension://', '').split('/')[0];
      return { extId: extId, targets: list };
    }
    await sleep(800);
  }
  return { extId: '', targets: await httpJson('/json/list') };
}

async function openAppPage(extId) {
  const list = await httpJson('/json/list');
  let app = list.find((t) => t.type === 'page' && String(t.url).includes('/app.html'));
  if (!app) {
    const nt = await httpJson('/json/new?' + encodeURIComponent('chrome-extension://' + extId + '/app.html'), { method: 'PUT' });
    app = { webSocketDebuggerUrl: nt.webSocketDebuggerUrl };
  }
  const cdp = await connect(app.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await waitReady(cdp, 20000);
  return cdp;
}

async function waitTable(cdp, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const v = await pageEval(cdp, "({rows: document.querySelectorAll('#tblBody tr').length, title: document.title, ready: document.readyState})");
      if (v && v.rows > 0) return v;
    } catch (e) {
      // 忽略
    }
    await sleep(500);
  }
  return null;
}

async function main() {
  const version = await httpJson('/json/version');
  log({ phase: 'browser', browser: version.Browser });

  const found = await findExtTarget();
  let extId = found.extId;
  if (!extId) {
    // 兜底：按路径哈希猜 ID 并打开工作台
    for (const id of extIdCandidates()) {
      try {
        await httpJson('/json/new?' + encodeURIComponent('chrome-extension://' + id + '/app.html'), { method: 'PUT' });
      } catch (e) {
        // 忽略
      }
    }
    await sleep(2000);
    const again = await findExtTarget();
    extId = again.extId;
  }
  if (!extId) {
    log({ phase: 'error', error: '未发现扩展，扩展可能没有加载成功' });
    process.exit(2);
  }
  log({ phase: 'extension', extId: extId });

  const appCdp = await openAppPage(extId);
  const table = await waitTable(appCdp, 20000);
  const appInfo = await pageEval(appCdp, "({title: document.title, rows: document.querySelectorAll('#tblBody tr').length, stats: (document.getElementById('statsBar')||{}).innerText||'', baseInfo: (document.getElementById('baseInfo')||{}).textContent||''})");
  log({ phase: 'workbench', table: table, appInfo: appInfo });

  // 1) 探测电商平台登录态 & 账号类型
  const homeProbeExpr = `(() => {
    const text = (document.body ? document.body.innerText : '').slice(0, 2500);
    const cookies = (document.cookie || '').split(';').map(s => s.trim().split('=')[0]).filter(Boolean);
    const plusHints = [];
    document.querySelectorAll('[class*="plus" i], [class*="vip" i], img[src*="plus" i], a[href*="plus.shop.example.com"]').forEach(el => {
      if (plusHints.length >= 6) return;
      plusHints.push({ tag: el.tagName, cls: (typeof el.className === 'string' ? el.className : '').slice(0, 80), text: (el.textContent || '').trim().slice(0, 30) });
    });
    const m = text.match(/(?:你好|您好)[，,\\s]*([^\\n，,]{1,24})/);
    return { url: location.href, title: document.title, nickname: m ? m[1] : '', textHead: text.slice(0, 500), cookieNames: cookies, plusHints: plusHints };
  })()`;
  const home = await inspectUrl('https://home.shop.example.com', homeProbeExpr, 25000, path.join(OUT_DIR, 'probe-home.png'));
  const homeUrl = (home.probe && home.probe.url) || '';
  const loginOk = homeUrl.length > 0 && !/passport\.jd\.com/.test(homeUrl) && home.value && home.value.textHead;
  log({ phase: 'home', url: homeUrl, loginOk: !!loginOk, nickname: home.value && home.value.nickname, cookieNames: home.value && home.value.cookieNames, plusHint: !!(home.value && home.value.plusHints && home.value.plusHints.length) });

  // 2) 探测商品页是否可打开（登录态是否对商品页有效）
  const extractExpr = fs.readFileSync(path.join(__dirname, 'extract.js'), 'utf8');
  const item = await inspectUrl('https://item.shop.example.com/100230282311.html', extractExpr, 30000, path.join(OUT_DIR, 'probe-item.png'));
  const itemUrl = (item.probe && item.probe.url) || '';
  const itemOk = itemUrl.length > 0 && !/passport\.jd\.com/.test(itemUrl);
  const plusShown = ((item.value && item.value.priceCandidates) || []).some((c) => /plus|会员价/i.test((c.cls || '') + ' ' + (c.label || '') + ' ' + (c.text || '')));
  log({
    phase: 'item',
    url: itemUrl,
    title: item.probe && item.probe.title,
    itemOk: itemOk,
    plusShown: plusShown,
    flags: item.value && item.value.flags,
    priceCandidates: ((item.value && item.value.priceCandidates) || []).slice(0, 6)
  });

  if (!loginOk || !itemOk) {
    log({ phase: 'error', error: '电商平台登录态无效或商品页被跳到登录页，无法继续自动巡检', homeUrl: homeUrl, itemUrl: itemUrl });
    fs.writeFileSync(path.join(OUT_DIR, 'auto-run-result.json'), JSON.stringify({ ok: false, reason: 'login-invalid', homeUrl, itemUrl, home: home.value, item: item.value }, null, 2), 'utf8');
    process.exit(3);
  }

  // 3) 决定身份
  let identity = IDENTITY_MODE;
  if (identity === 'auto') identity = plusShown ? 'plus' : 'util';
  const buttonId = identity === 'plus' ? 'runPlusBtn' : 'runUtilBtn';
  log({ phase: 'identity', identity: identity, buttonId: buttonId });

  // 4) 写入小批量设置
  const settings = await pageEval(
    appCdp,
    `(async () => {
      const key = '${DB_KEY}';
      const got = await chrome.storage.local.get(key);
      const db = got[key] || {};
      db.settings = Object.assign({}, db.settings || {}, { batchSize: ${BATCH}, delayMin: 2, delayMax: 4, skipCapturedToday: true, scope: 'all', keepTab: false });
      await chrome.storage.local.set({ [key]: db });
      return db.settings;
    })()`,
    true
  );
  log({ phase: 'settings', settings: settings });

  // 5) 重新加载工作台，让设置生效
  await appCdp.send('Page.reload');
  await waitReady(appCdp, 20000);
  await sleep(1200);
  const table2 = await waitTable(appCdp, 20000);
  log({ phase: 'reloaded', table: table2 });

  // 6) 点按钮启动巡检（自动接受 confirm 弹窗）
  appCdp.on('Page.javascriptDialogOpening', (params) => {
    log({ phase: 'dialog', type: params.type, message: String(params.message || '').slice(0, 120) });
    appCdp.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
  });
  let clickError = null;
  try {
    await pageEval(appCdp, "document.getElementById('" + buttonId + "').click(); 'clicked'", false);
  } catch (e) {
    clickError = String((e && e.message) || e);
  }
  log({ phase: 'clicked', buttonId: buttonId, clickError: clickError });

  // 7) 监控进度
  const started = Date.now();
  let lastPct = '';
  let finished = false;
  while (Date.now() - started < RUN_TIMEOUT_MS) {
    await sleep(3000);
    let st = null;
    try {
      st = await pageEval(
        appCdp,
        `({
          pct: (document.getElementById('progressPct') || {}).textContent || '',
          text: (document.getElementById('progressText') || {}).textContent || '',
          runStats: (document.getElementById('runStats') || {}).innerText || '',
          running: !document.getElementById('runUtilBtn').disabled,
          logTail: ((document.getElementById('logPanel') || {}).textContent || '').slice(-500)
        })`
      );
    } catch (e) {
      st = { error: String((e && e.message) || e) };
    }
    if (st && st.pct && st.pct !== lastPct) {
      lastPct = st.pct;
      log({ phase: 'progress', pct: st.pct, text: st.text, runStats: st.runStats });
    }
    if (st && !st.running && /已完成/.test(st.text || '')) {
      finished = true;
      log({ phase: 'finished', runStats: st.runStats });
      break;
    }
    if (st && st.running && /已暂停/.test(st.text || '')) {
      log({ phase: 'paused', text: st.text, logTail: st.logTail });
      break;
    }
  }
  if (!finished) log({ phase: 'warning', message: '巡检未在超时内完成，继续读取当前结果' });

  // 8) 读取采集结果
  const db = await pageEval(
    appCdp,
    `(async () => { const got = await chrome.storage.local.get('${DB_KEY}'); return got['${DB_KEY}'] || null; })()`,
    true
  );
  const captures = (db && db.captures) || {};
  const rows = [];
  for (const sku of Object.keys(captures)) {
    const cap = captures[sku] || {};
    rows.push({
      sku: sku,
      util: cap.util || null,
      plus: cap.plus || null,
      fail: cap.fail || null,
      raw: cap.raw ? { main: cap.raw.main, plus: cap.raw.plus, hand: cap.raw.hand, account: cap.raw.account, title: cap.raw.title } : null
    });
  }
  log({ phase: 'captures', count: rows.length });

  // 9) 截图 + 保存结果
  let shotOk = false;
  try {
    const shot = await appCdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT_DIR, 'auto-run.png'), Buffer.from(shot.data, 'base64'));
    shotOk = true;
  } catch (e) {
    shotOk = false;
  }

  const result = {
    ok: true,
    at: new Date().toISOString(),
    browser: version.Browser,
    extId: extId,
    identity: identity,
    batch: BATCH,
    home: { url: homeUrl, nickname: home.value && home.value.nickname },
    itemProbe: { url: itemUrl, title: item.probe && item.probe.title, plusShown: plusShown },
    finished: finished,
    rows: rows,
    shotOk: shotOk
  };
  fs.writeFileSync(path.join(OUT_DIR, 'auto-run-result.json'), JSON.stringify(result, null, 2), 'utf8');
  log({ phase: 'done', rows: rows.map((r) => ({ sku: r.sku, util: r.util && r.util.price, plus: r.plus && r.plus.price, fail: r.fail && r.fail.reason })), finished: finished, shotOk: shotOk });
  appCdp.close();
}

main().catch((e) => {
  log({ phase: 'error', error: String((e && e.stack) || e) });
  process.exit(1);
});

