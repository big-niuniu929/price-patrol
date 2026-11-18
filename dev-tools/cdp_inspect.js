// 内部调试脚本：通过 CDP 打开一个页面并提取结构化信息（不随扩展发布）
// 用法：node cdp_inspect.js <cdpPort> <url> <outJson> <outPng>
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
  const target = await httpJson('/json/new?' + encodeURIComponent(urlToOpen), { method: 'PUT' });
  const ws = new WebSocket(target.webSocketDebuggerUrl);
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

  await send('Runtime.enable');
  await send('Page.enable');

  const started = Date.now();
  let info = {};
  while (Date.now() - started < 30000) {
    await new Promise((r) => setTimeout(r, 800));
    try {
      const r = await send('Runtime.evaluate', {
        expression:
          '({ready:document.readyState,url:location.href,title:document.title,textLen:(document.body?document.body.innerText.length:0)})',
        returnByValue: true
      });
      info = r.result.value || {};
      if (info.ready === 'complete' && info.textLen > 100) break;
    } catch (e) {
      // 页面跳转中，继续等
    }
  }

  const extractExpr = fs.readFileSync(path.join(__dirname, 'extract.js'), 'utf8');
  let data = null;
  try {
    const r = await send('Runtime.evaluate', { expression: extractExpr, returnByValue: true, awaitPromise: false });
    data = r.result && r.result.value;
    if (r.exceptionDetails) {
      data = { error: r.exceptionDetails.text || 'evaluate exception' };
    }
  } catch (e) {
    data = { error: String((e && e.message) || e) };
  }

  let shotOk = false;
  try {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    if (outPng) {
      fs.writeFileSync(outPng, Buffer.from(shot.data, 'base64'));
      shotOk = true;
    }
  } catch (e) {
    shotOk = false;
  }

  const result = { at: new Date().toISOString(), browser: version.Browser, info: info, data: data, shotOk: shotOk };
  if (outJson) fs.writeFileSync(outJson, JSON.stringify(result, null, 2), 'utf8');
  console.log(JSON.stringify({ browser: version.Browser, info: info, shotOk: shotOk, dataPreview: JSON.stringify(data).slice(0, 2000) }, null, 2));
  ws.close();
}

main().catch((e) => {
  console.error('CDP_INSPECT_ERR', (e && e.stack) || e);
  process.exit(1);
});
