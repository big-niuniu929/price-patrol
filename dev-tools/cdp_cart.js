// 内部调试脚本：用 CDP 打开购物车并提取结构（不随扩展发布）
// 用法：node cdp_cart.js <cdpPort> <url> <outJson> <outPng>
const fs = require('fs');
const path = require('path');

const port = Number(process.argv[2] || 9223);
const urlToOpen = process.argv[3];
const outJson = process.argv[4];
const outPng = process.argv[5];

async function httpJson(p, opts) {
  const res = await fetch('http://127.0.0.1:' + port + p, opts);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error('non-json response: ' + text.slice(0, 200));
  }
}

async function main() {
  const version = await httpJson('/json/version');
  const target = await httpJson('/json/new?' + encodeURIComponent('about:blank'), { method: 'PUT' });
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('websocket connect failed'));
  });

  let seq = 0;
  const pending = new Map();
  const network = [];
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
    if (msg.method === 'Network.responseReceived') {
      const r = msg.params && msg.params.response;
      const t = msg.params && msg.params.type;
      if (r && (t === 'XHR' || t === 'Fetch' || t === 'Document')) {
        network.push({ type: t, status: r.status, url: String(r.url).slice(0, 300), mime: r.mimeType });
      }
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
  try {
    await send('Network.enable');
  } catch (e) {
    // 忽略
  }
  try {
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: "try{Object.defineProperty(navigator,'webdriver',{get:()=>undefined});}catch(e){}"
    });
  } catch (e) {
    // 忽略
  }

  await send('Page.navigate', { url: urlToOpen });

  const started = Date.now();
  let info = {};
  const probe = `(() => {
    const a = document.querySelectorAll('a[href*="item.shop.example.com/"], a[href*="item.m.shop.example.com/product/"]').length;
    return {href: location.href, ready: document.readyState, anchors: a, textLen: document.body ? document.body.innerText.length : 0};
  })()`;
  while (Date.now() - started < 30000) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const r = await send('Runtime.evaluate', { expression: probe, returnByValue: true });
      info = r.result.value || {};
      if (info.href && /passport\.jd\.com/.test(info.href) && info.ready === 'complete') break;
      if (info.ready === 'complete' && info.anchors > 0) break;
      if (info.ready === 'complete' && info.textLen > 1500 && Date.now() - started > 12000) break;
    } catch (e) {
      // 跳转中
    }
  }

  const extractExpr = fs.readFileSync(path.join(__dirname, 'extract_cart.js'), 'utf8');
  let data = null;
  try {
    const r = await send('Runtime.evaluate', { expression: extractExpr, returnByValue: true, awaitPromise: false });
    data = r.result && r.result.value;
    if (r.exceptionDetails) data = { error: r.exceptionDetails.text || 'evaluate exception' };
  } catch (e) {
    data = { error: String((e && e.message) || e) };
  }

  let shotOk = false;
  try {
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    if (outPng) {
      fs.writeFileSync(outPng, Buffer.from(shot.data, 'base64'));
      shotOk = true;
    }
  } catch (e) {
    shotOk = false;
  }

  const result = {
    at: new Date().toISOString(),
    browser: version.Browser,
    probe: info,
    data: data,
    network: network.slice(0, 120),
    shotOk: shotOk
  };
  if (outJson) fs.writeFileSync(outJson, JSON.stringify(result, null, 2), 'utf8');

  const preview = {
    browser: version.Browser,
    probe: info,
    shotOk: shotOk,
    isLoginPage: data && data.isLoginPage,
    rowCount: data && data.rowCount,
    anchorCount: data && data.anchorCount,
    plusTextInBody: data && data.plusTextInBody,
    selectorHits: data && data.selectorHits,
    rows: (data && data.rows || []).slice(0, 12).map((r) => ({ sku: r.sku, title: (r.title || '').slice(0, 40), priceCandidates: (r.priceCandidates || []).slice(0, 5) })),
    bodyTextHead: (data && data.bodyTextHead || '').slice(0, 800),
    network: network.filter((n) => /cart|price|item|api\.m\.jd|soa|p\.3\.cn/i.test(n.url)).slice(0, 40)
  };
  console.log(JSON.stringify(preview, null, 2));
  ws.close();
}

main().catch((e) => {
  console.error('CDP_CART_ERR', (e && e.stack) || e);
  process.exit(1);
});
