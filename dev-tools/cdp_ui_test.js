// 内部调试脚本：在无窗口 Edge 中加载扩展，截图验证工作台 + 用真实商品页验证取价（不随扩展发布）
// 用法：node cdp_ui_test.js <cdpPort> <outDir> <extensionPath>
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const port = Number(process.argv[2] || 9230);
const outDir = process.argv[3] || path.join(__dirname, 'shots');
const extPath = process.argv[4] || '~/Desktop/巡检\\巡检插件版\\extension';
fs.mkdirSync(outDir, { recursive: true });

async function httpJson(p, opts) {
  const res = await fetch('http://127.0.0.1:' + port + p, opts);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error('non-json: ' + text.slice(0, 200));
  }
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('websocket connect failed'));
  });
  let seq = 0;
  const pending = new Map();
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
    }
  };
  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
    });
  return { ws: ws, send: send };
}

function extIdCandidates() {
  const variants = [extPath, extPath.replace(/\\/g, '/'), extPath.toLowerCase()];
  const out = [];
  for (const v of variants) {
    const hex = crypto.createHash('sha256').update(v, 'utf8').digest('hex').slice(0, 32);
    out.push([...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join(''));
  }
  return Array.from(new Set(out));
}

async function inspectPage(wsUrl, expression, pngPath, timeoutMs) {
  const conn = await connect(wsUrl);
  const send = conn.send;
  await send('Runtime.enable');
  await send('Page.enable');
  const t0 = Date.now();
  let probe = {};
  while (Date.now() - t0 < (timeoutMs || 20000)) {
    await new Promise((r) => setTimeout(r, 700));
    try {
      const r = await send('Runtime.evaluate', {
        expression: '({ready:document.readyState,url:location.href,title:document.title,textLen:(document.body?document.body.innerText.length:0)})',
        returnByValue: true
      });
      probe = r.result.value || {};
      if (probe.ready === 'complete' && probe.textLen > 50) break;
    } catch (e) {
      // 页面跳转中
    }
  }
  let value = null;
  try {
    const r = await send('Runtime.evaluate', { expression: expression, returnByValue: true, awaitPromise: false });
    value = r.result && r.result.value;
    if (r.exceptionDetails) value = { error: r.exceptionDetails.text || 'exception' };
  } catch (e) {
    value = { error: String((e && e.message) || e) };
  }
  try {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(pngPath, Buffer.from(shot.data, 'base64'));
  } catch (e) {
    // 忽略
  }
  conn.ws.close();
  return { probe: probe, value: value };
}

async function main() {
  const version = await httpJson('/json/version');
  const result = { browser: version.Browser, extPath: extPath, idCandidates: extIdCandidates().slice(0, 2) };

  let targets = await httpJson('/json/list');
  let extId = '';
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const found = targets.find((t) => t.url && t.url.indexOf('chrome-extension://') === 0);
    if (found) {
      extId = found.url.replace('chrome-extension://', '').split('/')[0];
      break;
    }
    await new Promise((r) => setTimeout(r, 800));
    targets = await httpJson('/json/list');
  }

  if (!extId) {
    // 兜底：按路径哈希猜扩展 ID，直接打开工作台
    for (const id of extIdCandidates()) {
      try {
        await httpJson('/json/new?' + encodeURIComponent('chrome-extension://' + id + '/app.html'), { method: 'PUT' });
      } catch (e) {
        // 忽略
      }
    }
    await new Promise((r) => setTimeout(r, 3000));
    targets = await httpJson('/json/list');
    const found = targets.find((t) => t.url && t.url.indexOf('chrome-extension://') === 0);
    if (found) extId = found.url.replace('chrome-extension://', '').split('/')[0];
  }
  result.extId = extId;
  result.targets = targets.map((t) => ({ type: t.type, url: String(t.url).slice(0, 160) }));

  const appExpr = `(() => {
    const stats = document.getElementById('statsBar');
    const baseInfo = document.getElementById('baseInfo') ? document.getElementById('baseInfo').textContent : '';
    const runHint = document.getElementById('runHint') ? document.getElementById('runHint').textContent : '';
    const rows = document.querySelectorAll('#tblBody tr').length;
    const err = document.querySelector('body > div');
    return {
      url: location.href,
      title: document.title,
      stats: stats ? stats.innerText.replace(/\\n/g, ' | ') : '',
      rows: rows,
      baseInfo: baseInfo,
      runHint: runHint,
      bodyHead: document.body.innerText.slice(0, 500),
      hasInitError: !!(err && /初始化失败/.test(err.textContent || ''))
    };
  })()`;

  if (extId) {
    let app = targets.find((t) => t.type === 'page' && String(t.url).includes('/app.html'));
    if (!app) {
      const nt = await httpJson('/json/new?' + encodeURIComponent('chrome-extension://' + extId + '/app.html'), { method: 'PUT' });
      app = { webSocketDebuggerUrl: nt.webSocketDebuggerUrl, id: nt.id };
    }
    result.app = await inspectPage(app.webSocketDebuggerUrl, appExpr, path.join(outDir, 'workbench.png'), 20000);
  } else {
    result.appError = '没有发现扩展页面（扩展可能没被加载）';
  }

  try {
    const nt = await httpJson('/json/new?' + encodeURIComponent('https://item.shop.example.com/100230282311.html'), { method: 'PUT' });
    const extractExpr = fs.readFileSync(path.join(__dirname, 'extract.js'), 'utf8');
    result.itemPage = await inspectPage(nt.webSocketDebuggerUrl, extractExpr, path.join(outDir, 'item.png'), 30000);
  } catch (e) {
    result.itemPageError = String((e && e.message) || e);
  }

  const jsonPath = path.join(outDir, 'ui-test.json');
  fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2), 'utf8');
  console.log(
    JSON.stringify(
      {
        browser: version.Browser,
        extId: result.extId,
        app: result.app ? { probe: result.app.probe, value: result.app.value } : result.appError,
        item: result.itemPage
          ? {
              probe: result.itemPage.probe,
              flags: result.itemPage.value && result.itemPage.value.flags,
              priceCandidates: ((result.itemPage.value && result.itemPage.value.priceCandidates) || []).slice(0, 10)
            }
          : result.itemPageError,
        json: jsonPath
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error('UI_TEST_ERR', (e && e.stack) || e);
  process.exit(1);
});

