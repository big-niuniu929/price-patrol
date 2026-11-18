// 价格 DOM 结构巡检（内部调试用，不随扩展发布）
// 启动无窗口 Edge + 临时 profile + 远程调试端口，逐个打开电商平台商品页，
// 通过 CDP Runtime.evaluate 采集价格相关 DOM / 内联脚本 JSON / 正文摘要。
// 用法：node price_probe.js [--port 9340] [--wait 8000] [--out <json>]
//       诊断开关：[--no-ua] 不覆盖 UA  [--headed] 有头（窗口移到屏幕外）
//                 [--urls a,b,c] 覆盖商品页  [--extra "a=1,b=2"] 追加浏览器参数
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const DEFAULT_OUT = path.resolve(__dirname, '..', 'qa', 'price-probe.json');

const PRODUCT_URLS = [
  'https://item.shop.example.com/100230282311.html',
  'https://item.shop.example.com/100274532085.html',
  'https://item.shop.example.com/100142062134.html'
];

// ---------- 参数 ----------
function argOf(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const PORT = Number(argOf('port', 9340));
const WAIT_MS = Number(argOf('wait', 8000));
const OUT = path.resolve(argOf('out', DEFAULT_OUT));
const NO_UA = process.argv.includes('--no-ua');
const HEADED = process.argv.includes('--headed');
const EARLY = process.argv.includes('--early');
const URLS = argOf('urls', '')
  ? argOf('urls', '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  : PRODUCT_URLS;
const EXTRA_ARGS = argOf('extra', '')
  ? argOf('extra', '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  : [];
// 诊断：屏蔽指定 URL 模式（用 Network.setBlockedURLs），用于判断跳转由哪个脚本触发
const BLOCK_URLS = argOf('block', '')
  ? argOf('block', '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  : [];

// ---------- 页面内探针（会被 toString 注入页面执行，禁止引用外部变量） ----------
function probePage() {
  const T = (s, n) => {
    s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n) + '…' : s;
  };
  const R = (el) => {
    try {
      const r = el.getBoundingClientRect();
      return { top: Math.round(r.top), left: Math.round(r.left), width: Math.round(r.width), height: Math.round(r.height) };
    } catch (e) {
      return null;
    }
  };
  const clsOf = (el) => (el && el.getAttribute ? el.getAttribute('class') || '' : '');
  const desc = (el) => {
    const c = clsOf(el).trim();
    return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (c ? '.' + c.split(/\s+/).join('.') : '');
  };
  const vis = (el) => {
    try {
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity || 1) > 0 && r.width > 0 && r.height > 0;
    } catch (e) {
      return false;
    }
  };

  const text = document.body ? document.body.innerText || '' : '';
  const out = {
    href: location.href,
    title: document.title,
    readyState: document.readyState,
    viewport: { w: window.innerWidth, h: window.innerHeight },
    ua: navigator.userAgent
  };

  // 1) 登录/跳转判定
  out.login = {
    hostIsPassport: /passport\.jd\.com|plogin\.jd\.com/.test(location.href),
    hasLoginForm: !!document.querySelector('#loginname, .login-form, #formlogin, .login-tab-r'),
    hasQrLogin: !!document.querySelector('.qrcode-login, #qrcode, .login-qrcode'),
    hasNickname: !!document.querySelector('#ttbar-login .nickname, .nickname'),
    nickname: (() => {
      const n = document.querySelector('#ttbar-login .nickname, .nickname');
      return n ? T(n.textContent, 30) : '';
    })(),
    bodyLoginWords: /请登录|账户登录|扫码登录|安全验证|验证码|访问受限/.test(text.slice(0, 4000))
  };

  // 2) class/id 含 price 的元素
  const DIGITS = /^[\d.,¥￥元\s]+$/;
  const nodes = document.querySelectorAll('body *');
  const priceEls = [];
  let priceMatchTotal = 0;
  for (let i = 0; i < nodes.length; i++) {
    const el = nodes[i];
    const cls = clsOf(el);
    const id = el.id || '';
    if (!/price/i.test(cls) && !/price/i.test(id)) continue;
    priceMatchTotal++;
    if (priceEls.length >= 300) continue;
    const kids = Array.from(el.children);
    let ec = null;
    try {
      ec = getComputedStyle(el);
    } catch (e) {}
    priceEls.push({
      path: desc(el),
      tag: el.tagName.toLowerCase(),
      cls: T(cls, 200),
      id: T(id, 80),
      text: T(el.textContent, 80),
      ownText: T(
        Array.from(el.childNodes)
          .filter((n) => n.nodeType === 3)
          .map((n) => n.nodeValue)
          .join(''),
        40
      ),
      childCount: kids.length,
      childTags: kids.slice(0, 8).map((k) => k.tagName.toLowerCase() + ':' + T(k.textContent, 16)),
      digitLikeChildren: kids.filter((k) => {
        const t = (k.textContent || '').trim();
        return t.length <= 4 && DIGITS.test(t);
      }).length,
      rect: R(el),
      visible: vis(el),
      anim: ec
        ? { name: ec.animationName, duration: ec.animationDuration, transition: ec.transitionProperty + ' ' + ec.transitionDuration }
        : null
    });
  }
  out.priceElementMatchTotal = priceMatchTotal;
  out.priceElements = priceEls;

  // 3) 关键词命中元素（取最深命中，每词最多 20）
  const KWS = ['电商平台价', '到手价', '预估到手', 'PLUS会员价', '会员价', '折', '期', '满'];
  out.keywordHits = {};
  for (const kw of KWS) {
    const hits = [];
    for (let i = 0; i < nodes.length && hits.length < 20; i++) {
      const el = nodes[i];
      if (el.children.length > 6) continue;
      const tx = el.textContent || '';
      if (tx.indexOf(kw) < 0 || tx.length > 120) continue;
      if (Array.from(el.children).some((c) => (c.textContent || '').indexOf(kw) >= 0)) continue;
      hits.push({
        tag: el.tagName.toLowerCase(),
        cls: T(clsOf(el), 200),
        id: T(el.id, 60),
        text: T(tx, 80),
        rect: R(el),
        visible: vis(el)
      });
    }
    out.keywordHits[kw] = hits;
  }

  // 4) 正文里「关键词 + 数字」的直接匹配
  const priceRe = /(电商平台价|到手价|预估到手价?|PLUS会员价|会员价)\s*[:：]?\s*[¥￥]?\s*([0-9]+(?:\.[0-9]+)?)/g;
  const pm = [];
  let m;
  while ((m = priceRe.exec(text)) !== null && pm.length < 20) {
    pm.push({
      kw: m[1],
      num: m[2],
      at: m.index,
      ctx: T(text.slice(Math.max(0, m.index - 30), m.index + 70), 140)
    });
  }
  out.innerTextPriceMatches = pm;

  // 5) 内联脚本里的价格 JSON 线索
  const pats = ['"price"', 'jdPrice', 'priceInfo', '"p":"', 'J-p-'];
  const scripts = Array.from(document.querySelectorAll('script:not([src])'));
  out.inlineScriptCount = scripts.length;
  out.scriptPatternCounts = {};
  out.scriptSnippets = [];
  const seenScript = {};
  for (const pat of pats) {
    let count = 0;
    for (let i = 0; i < scripts.length; i++) {
      const src = scripts[i].textContent || '';
      const idx = src.indexOf(pat);
      if (idx < 0) continue;
      count++;
      if (out.scriptSnippets.length < 8 && !(seenScript[pat] >= 2)) {
        seenScript[pat] = (seenScript[pat] || 0) + 1;
        out.scriptSnippets.push({
          pattern: pat,
          scriptIndex: i,
          scriptLen: src.length,
          offset: idx,
          context: src.slice(Math.max(0, idx - 200), idx + 200)
        });
      }
    }
    out.scriptPatternCounts[pat] = count;
  }

  // 6) JSON-LD（常见 price / lowPrice）
  out.ldJsonPrice = Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
    .map((s) => T(s.textContent, 500))
    .filter((t) => /price/i.test(t))
    .slice(0, 3);

  // 7) 价格接口线索（真实价格往往来自 XHR，选择器只是渲染容器）
  try {
    out.priceResources = (performance.getEntriesByType('resource') || [])
      .map((e) => e.name)
      .filter((u) => /p\.3\.cn|price|promotion|\/p\/|pc_detail/i.test(u))
      .slice(0, 20);
  } catch (e) {
    out.priceResources = [];
  }

  // 8) 正文摘要（保留换行，便于看结构）
  out.bodyText1200 = String(text).replace(/\n{3,}/g, '\n\n').trim().slice(0, 1200);
  return out;
}

// ---------- CDP 小工具 ----------
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function httpJson(p, opts) {
  const res = await fetch('http://127.0.0.1:' + PORT + p, opts);
  const body = await res.text();
  try {
    return JSON.parse(body);
  } catch (e) {
    throw new Error('non-json response for ' + p + ': ' + body.slice(0, 200));
  }
}

async function waitForPort(timeoutMs) {
  const started = Date.now();
  let lastErr = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const v = await httpJson('/json/version');
      if (v && v.webSocketDebuggerUrl) return v;
    } catch (e) {
      lastErr = e;
    }
    await sleep(300);
  }
  throw new Error('CDP port ' + PORT + ' not ready: ' + ((lastErr && lastErr.message) || 'timeout'));
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let seq = 0;
    ws.onopen = () => {
      const send = (method, params) =>
        new Promise((res, rej) => {
          const id = ++seq;
          pending.set(id, { res, rej });
          ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
        });
      resolve({ ws, send });
    };
    ws.onerror = () => reject(new Error('websocket connect failed: ' + wsUrl));
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
        if (msg.error) p.rej(new Error(JSON.stringify(msg.error)));
        else p.res(msg.result);
      }
    };
  });
}

async function evaluate(send, expression, awaitPromise) {
  const r = await send('Runtime.evaluate', {
    expression: expression,
    returnByValue: true,
    awaitPromise: !!awaitPromise,
    userGesture: true
  });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error('evaluate exception: ' + ((d.exception && (d.exception.description || d.exception.value)) || d.text));
  }
  return r.result ? r.result.value : undefined;
}

// 导航后反复探测，直到 readyState=complete 且正文字数稳定
async function waitRender(send, budgetMs) {
  const started = Date.now();
  let info = {};
  let stable = 0;
  let lastLen = -1;
  while (Date.now() - started < budgetMs) {
    await sleep(500);
    try {
      info = await evaluate(
        send,
        '({ready:document.readyState,href:location.href,title:document.title,len:(document.body?document.body.innerText.length:0)})'
      );
      if (info && info.len === lastLen) stable++;
      else stable = 0;
      lastLen = info ? info.len : -1;
      if (info && info.ready === 'complete' && stable >= 3 && info.len > 50) return info;
    } catch (e) {
      // 正在跳转，execution context 会被销毁，忽略继续等
    }
  }
  return info;
}

async function probeOne(send, url) {
  const t0 = Date.now();
  const rec = { url: url, navError: null };
  try {
    const nav = await send('Page.navigate', { url: url });
    if (nav && nav.errorText) rec.navError = nav.errorText;
  } catch (e) {
    rec.navError = String((e && e.message) || e);
  }

  // 早期采样：看跳登录前页面是否短暂渲染过价格面板（--early）
  if (EARLY) {
    rec.early = [];
    for (let i = 0; i < 16; i++) {
      await sleep(250);
      try {
        const s = await evaluate(
          send,
          '({t:Date.now(),href:location.href,ready:document.readyState,' +
            'panel:!!document.querySelector(".product-price-panel"),' +
            'value:!!document.querySelector(".product-price--value"),' +
            'anyPrice:!!document.querySelector("[class*=price]"),' +
            'len:(document.body?document.body.innerText.length:0),' +
            'txt:(document.body?document.body.innerText.slice(0,60).replace(/\\s+/g," "):"")})'
        );
        if (s) rec.early.push(s);
        if (s && /passport\.jd\.com|pf\.jd\.com/.test(s.href)) break;
      } catch (e) {
        rec.early.push({ err: String((e && e.message) || e).slice(0, 80) });
      }
    }
  }

  const info = await waitRender(send, WAIT_MS + 12000);
  // 补足到规定的 8 秒观察窗口（价格异步渲染）
  const rest = WAIT_MS - (Date.now() - t0);
  if (rest > 0) await sleep(rest);

  rec.elapsedMs = Date.now() - t0;
  rec.preProbe = info || null;

  let data = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      data = await evaluate(send, '(' + probePage.toString() + ')()');
      break;
    } catch (e) {
      rec.probeError = String((e && e.message) || e);
      if (attempt === 3) break;
      await sleep(1200);
    }
  }
  rec.data = data || null;
  return rec;
}

// ---------- 主流程 ----------
async function main() {
  if (!fs.existsSync(EDGE)) throw new Error('Edge not found: ' + EDGE);

  const profileDir = path.join(os.tmpdir(), 'jd-price-probe-' + Date.now());
  fs.mkdirSync(profileDir, { recursive: true });

  const args = [
    HEADED ? '--window-position=-32000,-32000' : '--headless=new',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profileDir,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--window-size=1440,900',
    '--disable-features=Translate,MediaRouter',
    '--lang=zh-CN'
  ].concat(EXTRA_ARGS, ['about:blank']);

  const child = spawn(EDGE, args, { stdio: 'ignore', windowsHide: true, detached: false });
  let ws = null;
  const result = {
    startedAt: new Date().toISOString(),
    edge: EDGE,
    edgeArgs: args,
    port: PORT,
    waitMs: WAIT_MS,
    mode: HEADED ? 'headed-offscreen' : 'headless',
    uaOverride: !NO_UA,
    extraArgs: EXTRA_ARGS,
    urls: URLS,
    browser: null,
    pages: [],
    errors: []
  };

  try {
    const version = await waitForPort(25000);
    result.browser = version.Browser;
    console.log('[cdp] ' + version.Browser + ' on :' + PORT);

    // 复用 about:blank 那个 page target
    let targets = [];
    const t = await httpJson('/json/list');
    targets = (t || []).filter((x) => x.type === 'page');
    if (!targets.length) throw new Error('no page target found');
    const target = targets[0];
    const conn = await connect(target.webSocketDebuggerUrl);
    ws = conn.ws;
    const send = conn.send;

    await send('Page.enable');
    await send('Runtime.enable');
    if (BLOCK_URLS.length) {
      await send('Network.enable');
      await send('Network.setBlockedURLs', { urls: BLOCK_URLS });
    }
    if (!NO_UA) {
      try {
        await send('Emulation.setUserAgentOverride', {
          userAgent:
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
          acceptLanguage: 'zh-CN,zh;q=0.9,en;q=0.8',
          platform: 'Win32'
        });
      } catch (e) {
        result.errors.push('UA override failed: ' + String((e && e.message) || e));
      }
    }

    for (const url of URLS) {
      console.log('[probe] ' + url);
      let rec;
      try {
        rec = await probeOne(send, url);
      } catch (e) {
        rec = { url: url, fatal: String((e && e.stack) || e) };
        result.errors.push(url + ' -> ' + rec.fatal);
      }
      result.pages.push(rec);
      const d = rec.data || {};
      const el = (d.priceElements || []).find((x) => /电商平台价|到手|会员价/.test(x.text)) || (d.priceElements || [])[0];
      console.log(
        '  -> ' +
          JSON.stringify({
            href: d.href,
            title: d.title,
            login: d.login && (d.login.hostIsPassport || d.login.hasLoginForm),
            priceEls: d.priceElementMatchTotal,
            sampleText: el && el.text,
            sampleCls: el && el.cls,
            matches: (d.innerTextPriceMatches || []).slice(0, 3)
          })
      );
      await sleep(1200);
    }
  } catch (e) {
    result.errors.push(String((e && e.stack) || e));
    console.error('[fatal]', (e && e.stack) || e);
  } finally {
    result.finishedAt = new Date().toISOString();
    try {
      if (ws) ws.close();
    } catch (e) {}
    await sleep(300);

    // 杀进程树（Edge 会派生多个子进程）
    try {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch (e) {
      try {
        child.kill('SIGKILL');
      } catch (e2) {}
    }
    await sleep(800);
    // 兜底：按 profile 路径清理残留进程
    try {
      execFileSync(
        'powershell',
        ['-NoProfile', '-Command', "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*" + profileDir.replace(/\\/g, '\\\\') + "*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"],
        { stdio: 'ignore' }
      );
    } catch (e) {}
    await sleep(400);

    try {
      fs.mkdirSync(path.dirname(OUT), { recursive: true });
      fs.writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8');
      console.log('[out] ' + OUT);
    } catch (e) {
      console.error('[out-error]', (e && e.message) || e);
    }

    // 删除临时 profile
    for (let i = 0; i < 5; i++) {
      try {
        fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 3 });
        console.log('[cleanup] profile removed: ' + profileDir);
        break;
      } catch (e) {
        await sleep(700);
      }
    }
    if (fs.existsSync(profileDir)) console.error('[cleanup-warn] profile still exists: ' + profileDir);
  }

  const ok = result.pages.filter((p) => p.data).length;
  console.log('[done] pages probed=' + ok + '/' + URLS.length + ' errors=' + result.errors.length);
  if (result.errors.length) console.log('[errors]\n' + result.errors.join('\n'));
}

main().catch((e) => {
  console.error('PRICE_PROBE_ERR', (e && e.stack) || e);
  process.exit(1);
});
