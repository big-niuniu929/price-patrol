// 电商平台市占率数据工作台 · content.js 离线 CDP 测试（dev-tools 专用，不随扩展发布）
//
// 做法：用 Node 内置 WebSocket + fetch 驱动本机 Edge headless（无外网、不访问电商平台）：
//   1) 启动一个临时 profile 的 Edge headless，开 CDP 端口；
//   2) Page.addScriptToEvaluateOnNewDocument 注入 fake chrome.runtime + 测试用调参；
//   3) 逐个导航到 dev-tools/mock-item.html 的不同布局，注入 extension/content.js；
//   4) 断言取到的价格 / 尺寸来源 / 风控与下架识别 / 干扰项过滤 / PING / 无 chrome 环境不抛错。
//
// 运行：node dev-tools/cdp_capture_test.mjs
//   Edge 路径可用环境变量 DSH_EDGE_PATH 覆盖；扩展目录用相对脚本位置解析，不写死绝对路径。
//
// 注意：清理只杀本脚本自建的 Edge 进程树（taskkill /PID /T /F），绝不动用户自己开着的 Edge。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const MOCK_HTML = path.join(__dirname, 'mock-item.html');
const CONTENT_JS = path.join(PROJECT_ROOT, 'extension', 'content.js');

const EDGE_PATH =
  process.env.DSH_EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------- 断言与结果收集 ----------------
const results = { pass: 0, fail: 0, cases: [] };
let currentCase = '';

function normalize(value) {
  if (value == null) return value;
  try {
    return JSON.stringify(value);
  } catch (e) {
    return String(value);
  }
}

function makeAsserter(caseName) {
  const record = { name: caseName, checks: [], pass: 0, fail: 0 };
  results.cases.push(record);
  return {
    record: record,
    ok(label, condition, detail) {
      const passed = !!condition;
      record.checks.push({ label: label, passed: passed, detail: detail || '' });
      if (passed) {
        results.pass += 1;
        record.pass += 1;
      } else {
        results.fail += 1;
        record.fail += 1;
        console.error('  ✗ ' + label + (detail ? ' → ' + detail : ''));
      }
    },
    eq(label, actual, expected) {
      this.ok(label + ' = ' + normalize(expected), normalize(actual) === normalize(expected), '实际 ' + normalize(actual));
    },
    truthy(label, actual) {
      this.ok(label + ' 为真', !!actual, '实际 ' + normalize(actual));
    },
    includes(label, text, sub) {
      const hay = String(text == null ? '' : text);
      this.ok(label + ' 包含「' + sub + '」', hay.indexOf(sub) >= 0, '实际「' + hay + '」');
    }
  };
}

// ---------------- 浏览器/CDP 基础 ----------------
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForCdpReady(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch('http://127.0.0.1:' + port + '/json/version');
      if (res.ok) return await res.json();
    } catch (e) {
      // 还没起来
    }
    await sleep(200);
  }
  throw new Error('Edge 的 CDP 端口在 ' + timeoutMs + 'ms 内没有就绪（端口 ' + port + '）');
}

async function cdpHttp(port, pathname, options) {
  const res = await fetch('http://127.0.0.1:' + port + pathname, options);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error('CDP HTTP 返回非 JSON：' + text.slice(0, 200));
  }
}

class CdpClient {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.exceptions = [];
    ws.onmessage = (ev) => {
      let msg = null;
      try {
        msg = JSON.parse(ev.data);
      } catch (e) {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else p.resolve(msg.result);
        return;
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params && msg.params.exceptionDetails;
        const desc = (d && d.exception && (d.exception.description || d.exception.value)) || (d && d.text) || '未知异常';
        this.exceptions.push(String(desc).slice(0, 500));
      }
    };
  }

  static async connect(wsUrl) {
    if (!wsUrl) throw new Error('CDP 目标没有 webSocketDebuggerUrl（Edge 可能没正常返回调试地址）');
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket 连接 CDP 超时：' + wsUrl)), 15000);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = (ev) => {
        clearTimeout(timer);
        const detail = ev && (ev.message || ev.type || ev.error);
        reject(new Error('WebSocket 连接 CDP 失败：' + wsUrl + (detail ? '（' + detail + '）' : '')));
      };
      ws.onclose = (ev) => {
        clearTimeout(timer);
        reject(new Error('WebSocket 被关闭：' + wsUrl + '（code ' + (ev && ev.code) + '，reason ' + ((ev && ev.reason) || '') + '）'));
      };
    });
    return new CdpClient(ws);
  }

  send(method, params) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve, reject: reject });
      this.ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
    });
  }

  async eval(expression, awaitPromise) {
    const r = await this.send('Runtime.evaluate', {
      expression: expression,
      returnByValue: true,
      awaitPromise: awaitPromise !== false,
      userGesture: false
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      const desc = (d.exception && (d.exception.description || d.exception.value)) || d.text || 'evaluate 异常';
      throw new Error('页面脚本异常：' + String(desc).slice(0, 800));
    }
    return r.result ? r.result.value : undefined;
  }

  async waitFor(expression, timeoutMs, intervalMs) {
    const deadline = Date.now() + (timeoutMs || 10000);
    const step = intervalMs || 80;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        const value = await this.eval(expression);
        if (value) return value;
      } catch (e) {
        lastError = e; // 导航中执行上下文会被销毁，继续等
      }
      await sleep(step);
    }
    throw new Error('等待页面条件超时：' + expression.slice(0, 120) + (lastError ? '（最后一次错误：' + lastError.message + '）' : ''));
  }

  close() {
    try {
      this.ws.close();
    } catch (e) {
      // 忽略
    }
  }
}

function killProcessTree(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve();
    // Windows：只杀本脚本启动的进程树；不要用 Get-Process msedge | Stop-Process（会误杀用户的 Edge）
    const proc = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    proc.on('close', () => resolve());
    proc.on('error', () => resolve());
  });
}

async function removeDirWithRetry(dir) {
  for (let i = 0; i < 10; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      return;
    } catch (e) {
      await sleep(300);
    }
  }
}

// ---------------- 启动 / 关闭 Edge ----------------
// 本机 DSH 沙箱会拦截「node 直接 spawn msedge」的命名管道（mojo 报 拒绝访问），
// 因此启动策略分两步：先直接 spawn（常规机器），失败再经 PowerShell Start-Process 启动。
const EDGE_ARGS = (port, userDataDir) => [
  '--headless=new',
  '--disable-gpu',
  '--hide-scrollbars',
  '--remote-debugging-address=127.0.0.1',
  '--remote-debugging-port=' + port,
  '--user-data-dir=' + userDataDir,
  '--no-first-run',
  '--no-default-browser-check',
  '--allow-file-access-from-files',
  '--window-size=1280,900',
  'about:blank'
];

function psQuote(text) {
  return "'" + String(text).replace(/'/g, "''") + "'";
}

function spawnEdgeDirect(port, userDataDir) {
  const proc = spawn(EDGE_PATH, EDGE_ARGS(port, userDataDir), { stdio: 'ignore', windowsHide: true });
  proc.on('error', () => {
    // EPERM 等情况交给上层走 PowerShell 兜底
  });
  return proc;
}

async function spawnEdgeViaPowerShell(port, userDataDir, pidFile) {
  const psCommand =
    "$ErrorActionPreference='Stop'; " +
    '$p = Start-Process -FilePath ' +
    psQuote(EDGE_PATH) +
    ' -ArgumentList @(' +
    EDGE_ARGS(port, userDataDir)
      .map(psQuote)
      .join(',') +
    ') -PassThru; ' +
    'Set-Content -Path ' +
    psQuote(pidFile) +
    ' -Value $p.Id -Encoding ASCII';
  const encoded = Buffer.from(psCommand, 'utf16le').toString('base64');
  const launcher = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { stdio: 'ignore', windowsHide: true }
  );
  launcher.on('error', () => {});
  // 等 PowerShell 把 Edge 进程号写进 pidFile（写不到就返回空）
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (fs.existsSync(pidFile)) {
      const text = fs.readFileSync(pidFile, 'utf8').trim();
      if (/^\d+$/.test(text)) return { pid: Number(text) };
    }
    await sleep(150);
  }
  return { pid: 0 };
}

async function isPortClosed(port) {
  try {
    const res = await fetch('http://127.0.0.1:' + port + '/json/version', { signal: AbortSignal.timeout(1200) });
    return !res.ok;
  } catch (e) {
    return true;
  }
}

function waitForCdpStart(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return (async () => {
    while (Date.now() < deadline) {
      if (await isPortClosed(port)) {
        await sleep(200);
      }
      try {
        const res = await fetch('http://127.0.0.1:' + port + '/json/version');
        if (res.ok) return await res.json();
      } catch (e) {
        // 还没起来
      }
      await sleep(250);
    }
    return null;
  })();
}

async function launchEdge(port, profileBase, pidFile) {
  // 方式 A：直接 spawn
  const dirA = profileBase + '-a';
  const proc = spawnEdgeDirect(port, dirA);
  const deadline = Date.now() + 10000;
  let versionA = null;
  let exited = false;
  proc.once('exit', () => {
    exited = true;
  });
  while (Date.now() < deadline) {
    try {
      const res = await fetch('http://127.0.0.1:' + port + '/json/version');
      if (res.ok) {
        versionA = await res.json();
        break;
      }
    } catch (e) {
      // 继续等
    }
    if (exited) break;
    await sleep(250);
  }
  if (versionA) return { version: versionA, proc: proc, pid: proc.pid, profileDir: dirA, how: '直接 spawn' };

  // 方式 A 失败：清理半成品，换端口再试方式 B
  await killProcessTree(proc.pid);
  await sleep(400);
  await removeDirWithRetry(dirA);
  const portB = await getFreePort();
  const dirB = profileBase + '-b';
  const { pid } = await spawnEdgeViaPowerShell(portB, dirB, pidFile);
  const versionB = await waitForCdpStart(portB, 30000);
  if (!versionB) {
    if (pid) await killProcessTree(pid);
    await removeDirWithRetry(dirB);
    throw new Error(
      '无法启动 Edge 的 CDP 端口。已尝试：① 直接 spawn msedge；② PowerShell Start-Process。\n' +
        '若在 DSH 沙箱里运行，node 直接 spawn 浏览器会被命名管道限制拦截，请确认 PowerShell 兜底可用；\n' +
        '若在普通环境运行，请检查 Edge 路径（当前 ' + EDGE_PATH + '）或是否被安全软件拦截。'
    );
  }
  return { version: versionB, proc: null, pid: pid, profileDir: dirB, port: portB, how: 'PowerShell Start-Process' };
}

// 关闭浏览器：优先用 CDP 的 Browser.close（只关我们自己启动的实例），再按 pid 兜底
async function closeBrowser(port, pid) {
  try {
    const res = await fetch('http://127.0.0.1:' + port + '/json/version');
    if (res.ok) {
      const version = await res.json();
      if (version.webSocketDebuggerUrl) {
        const ws = new WebSocket(version.webSocketDebuggerUrl);
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 3000);
          ws.onopen = () => {
            clearTimeout(timer);
            resolve();
          };
          ws.onerror = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        try {
          ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
        } catch (e) {
          // 忽略
        }
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
          if (await isPortClosed(port)) break;
          await sleep(250);
        }
        try {
          ws.close();
        } catch (e) {
          // 忽略
        }
      }
    }
  } catch (e) {
    // 端口已经关了
  }
  if (pid) await killProcessTree(pid);
  // 等临时的 Edge 子进程（渲染进程等）退出后再删 profile
  for (let i = 0; i < 20; i++) {
    if (await isPortClosed(port)) break;
    await sleep(250);
  }
}

// ---------------- 注入到每个新文档的测试脚手架 ----------------
// 作用：① 允许 content.js 在 file:// mock 页上运行；② 缩短价格稳定等待；③ fake chrome.runtime。
const INIT_SCRIPT = `(() => {
  const params = new URLSearchParams(location.search);
  window.__JD_CAPTURE_FORCE__ = true;
  window.__JD_CAPTURE_TUNING__ = {
    maxWaitMs: 1800,
    roundIntervalMs: 40,
    stableRounds: 2,
    mainWaitMs: 600,
    recheckTimes: 2,
    recheckDelayMs: 150,
    settleMs: 80,
    minPlausiblePrice: 30,
    maxPlausiblePrice: 2000000
  };
  window.__captureMessages = [];
  // v2.1.4：模拟真实电商平台 URL（用于风控落地页识别，如 ?mockurl=https://www.shop.example.com/）
  const mockUrlParam = params.get('mockurl');
  if (mockUrlParam) {
    try {
      const u = new URL(mockUrlParam);
      window.__JD_MOCK_LOCATION__ = {
        href: u.href,
        hostname: u.hostname,
        pathname: u.pathname,
        search: u.search,
        origin: u.origin
      };
    } catch (e) { /* 非法 mockurl 忽略 */ }
  }
  if (params.get('nochrome') === '1') return; // 模拟「没有 chrome 扩展环境」的普通页面
  const listeners = [];
  const fakeRuntime = {
    lastError: null,
    sendMessage(msg, callback) {
      window.__captureMessages.push(msg);
      if (typeof callback === 'function') {
        try { callback({}); } catch (e) { /* 忽略 */ }
      }
    },
    onMessage: {
      addListener(fn) { if (listeners.indexOf(fn) < 0) listeners.push(fn); },
      removeListener(fn) { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); }
    }
  };
  const fakeChrome = { runtime: fakeRuntime };
  try {
    Object.defineProperty(window, 'chrome', { value: fakeChrome, configurable: true, writable: true });
  } catch (e) {
    window.chrome = fakeChrome;
  }
  // 向 content.js 的 runtime.onMessage 监听器同步发一条消息，并收集 sendResponse 结果
  // （PING 与 v2.1.4 PREVIEW_CAPTURE 都用它）
  window.__fakeRuntimeSendMsg = function (msg) {
    let response = null;
    listeners.slice().forEach(function (fn) {
      try { fn(msg, {}, function (r) { response = r; }); } catch (e) { /* 忽略 */ }
    });
    return response;
  };
  window.__fakeRuntimePing = function (msg) {
    return window.__fakeRuntimeSendMsg(msg);
  };
})();`;

const PAGE_READY_EXPR = `(function () {
  const app = document.getElementById('app');
  return document.readyState === 'complete' && !!app && app.childElementCount > 0;
})()`;

function mockUrl(layout, sku, nochrome, mockLocation) {
  const base = pathToFileURL(MOCK_HTML).href;
  const params = ['layout=' + encodeURIComponent(layout), 'sku=' + encodeURIComponent(sku)];
  if (nochrome) params.push('nochrome=1');
  if (mockLocation) params.push('mockurl=' + encodeURIComponent(mockLocation));
  return base + '?' + params.join('&');
}

// ---------------- 测试用例 ----------------
const TEST_CASES = [
  {
    name: '布局 hand：到手价+电商平台价+规格表尺寸优先',
    layout: 'hand',
    sku: '100200174986',
    check(t, r) {
      t.eq('ok', r.ok, true);
      t.eq('sku', r.sku, '100200174986');
      t.truthy('size 非空', r.size);
      if (r.size) {
        t.eq('size.inch', r.size.inch, 75);
        t.eq('size.source（v2.1.6 规格表优先）', r.size.source, 'spec');
      }
      t.eq('sizeUncertain', r.sizeUncertain, false);
      t.eq('hand.price（预估到手价）', r.hand && r.hand.price, 5499);
      t.eq('main.price（电商平台价）', r.main && r.main.price, 5999);
      t.eq('plus（页面无 PLUS 价）', r.plus, null);
      t.eq('pricePick.price（到手价优先）', r.pricePick && r.pricePick.price, 5499);
      t.eq('pricePick.kind', r.pricePick && r.pricePick.kind, 'hand');
      t.eq('price（v2.1.7 统一字段）', r.price, 5499);
      t.eq('priceKind', r.priceKind, 'hand');
      t.eq('priceKindLabel', r.priceKindLabel, '到手价');
      t.ok('priceRect 有位置', !!(r.priceRect && r.priceRect.width > 0), JSON.stringify(r.priceRect));
      t.ok('sourceLabel 含 hand-price', /hand-price/.test(String(r.sourceLabel || '')), r.sourceLabel);
      t.eq('priceChanges（无刷新）', Array.isArray(r.priceChanges) && r.priceChanges.length, 0);
      const topCand = (r.candidates || [])[0];
      t.ok('candidates 带 font/cls/rect', !!(topCand && Number(topCand.font) >= 0 && topCand.cls && topCand.rect));
      t.eq('brand', r.brand, '海信');
      t.eq('flags.verify', r.flags && r.flags.verify, false);
      t.eq('flags.offSale', r.flags && r.flags.offSale, false);
      const noise = (r.candidates || []).filter((c) => !c.suspect && [7999, 300, 5, 5000, 200].indexOf(c.price) >= 0);
      t.eq('干扰项（划线原价/优惠券/角标/满减）未进入可用候选', noise.length, 0);
      t.includes('account.nickname', (r.account && r.account.nickname) || '', '电商平台用户');
    }
  },
  {
    name: '布局 main：只有电商平台价',
    layout: 'main',
    sku: '100200174987',
    check(t, r) {
      t.eq('ok', r.ok, true);
      t.eq('main.price', r.main && r.main.price, 4299);
      t.eq('hand', r.hand, null);
      t.eq('size.inch', r.size && r.size.inch, 65);
      t.eq('size.source（规格表优先）', r.size && r.size.source, 'spec');
      t.eq('sizeUncertain', r.sizeUncertain, false);
    }
  },
  {
    name: '布局 plus：PLUS 会员价',
    layout: 'plus',
    sku: '100200174988',
    check(t, r) {
      t.eq('ok', r.ok, true);
      t.eq('main.price（电商平台价）', r.main && r.main.price, 12999);
      t.eq('plus.price（PLUS 价）', r.plus && r.plus.price, 11899);
      t.eq('flags.plusText', r.flags && r.flags.plusText, true);
      t.eq('size.inch', r.size && r.size.inch, 86);
      t.eq('size.source（规格表优先）', r.size && r.size.source, 'spec');
    }
  },
  {
    name: '布局 spec：尺寸只在规格参数表（dl/dt/dd）',
    layout: 'spec',
    sku: '100200174989',
    check(t, r) {
      t.eq('ok', r.ok, true);
      t.eq('main.price', r.main && r.main.price, 8999);
      t.eq('size.inch', r.size && r.size.inch, 86);
      t.eq('size.source（规格参数表）', r.size && r.size.source, 'spec');
      t.ok('标题里没有英寸（确保不是从标题命中）', !/英寸/.test(r.title || ''), '标题「' + (r.title || '') + '」');
    }
  },
  {
    name: '布局 alt：尺寸只在主图 alt',
    layout: 'alt',
    sku: '100200174990',
    check(t, r) {
      t.eq('ok', r.ok, true);
      t.eq('main.price', r.main && r.main.price, 12999);
      t.eq('size.inch', r.size && r.size.inch, 100);
      t.eq('size.source（主图 alt）', r.size && r.size.source, 'alt');
    }
  },
  {
    name: '布局 doctitle：尺寸只在 document.title',
    layout: 'doctitle',
    sku: '100200174991',
    check(t, r) {
      t.eq('ok', r.ok, true);
      t.eq('main.price', r.main && r.main.price, 24999);
      t.eq('size.inch', r.size && r.size.inch, 98);
      t.eq('size.source（document.title）', r.size && r.size.source, 'doc-title');
    }
  },
  {
    name: '布局 verify：安全验证 → 明确 reason 且无价格',
    layout: 'verify',
    sku: '100200174992',
    check(t, r) {
      t.eq('ok', r.ok, false);
      t.eq('flags.verify', r.flags && r.flags.verify, true);
      t.includes('reason', r.reason, '安全验证');
      t.eq('main', r.main, null);
      t.eq('pricePick', r.pricePick, null);
    }
  },
  {
    name: 'v2.1.5 布局 offsale：下架 → offSale 分类（不算风控、不解析价格）',
    layout: 'offsale',
    sku: '100200174993',
    check(t, r) {
      t.eq('ok', r.ok, false);
      t.eq('pageKind', r.pageKind, 'offSale');
      t.eq('offSale', r.offSale, true);
      t.eq('softAnomaly', r.softAnomaly, false);
      t.eq('risk.hit（下架不算风控）', r.risk && r.risk.hit, false);
      t.eq('flags.offSale（兼容旧字段）', r.flags && r.flags.offSale, true);
      t.includes('reason', r.reason, '下架');
      t.eq('hand', r.hand, null);
      t.eq('main', r.main, null);
      t.eq('size（不解析尺寸）', r.size, null);
      t.eq('previewable', r.previewable, false);
    }
  },
  {
    name: '布局 fragment：价格数字片段 → 明确 reason（疑似不完整）',
    layout: 'fragment',
    sku: '100200174994',
    check(t, r) {
      t.eq('ok', r.ok, false);
      t.eq('flags.priceFragment', r.flags && r.flags.priceFragment, true);
      t.includes('reason', r.reason, '疑似');
      t.eq('pricePick', r.pricePick, null);
      const usable = (r.candidates || []).filter((c) => !c.suspect);
      t.eq('没有可用价格候选', usable.length, 0);
    }
  },
  {
    name: 'PING：工作台可确认页面脚本存活',
    layout: 'hand',
    sku: '100200174995',
    check(t, r, extra) {
      t.eq('ok', r.ok, true);
      const pong = extra && extra.ping;
      t.truthy('PING 有响应', pong);
      if (pong) {
        t.eq('PING.ok', pong.ok, true);
        t.eq('PING.sku', pong.sku, '100200174995');
        t.includes('PING.url', pong.url, 'mock-item.html');
      }
    }
  },
  {
    name: '无 chrome 环境（file:// 普通页面）不抛错、仍能算出价格',
    layout: 'hand',
    sku: '100200174996',
    nochrome: true,
    check(t, r, extra) {
      t.eq('没有发出 sendMessage（无 chrome.runtime）', (extra.state.msgs || []).length, 0);
      t.truthy('window.__jdMarketCapture.ready', extra.state.ready);
      t.eq('ok', r && r.ok, true);
      t.eq('main.price', r && r.main && r.main.price, 5999);
      t.eq('size.inch', r && r.size && r.size.inch, 75);
    }
  },

  // ---- v2.1 取价加固（移植巡检 2026-11-03）----
  {
    name: 'v2.1 布局 strikelabel：del + line-through 划线价不被选中',
    layout: 'strikelabel',
    sku: '100200175011',
    check(t, r) {
      t.eq('version', r.version, '2.1.7');
      t.eq('ok', r.ok, true);
      t.eq('main.price', r.main && r.main.price, 5999);
      t.eq('hand.price', r.hand && r.hand.price, 5499);
      t.eq('pricePick.price', r.pricePick && r.pricePick.price, 5499);
      t.eq('pricePick.kind', r.pricePick && r.pricePick.kind, 'hand');
      const struck = (r.candidates || []).filter((c) => !c.suspect && [7999, 8199].indexOf(c.price) >= 0);
      t.eq('划线价（del / line-through）不在可用候选里', struck.length, 0);
    }
  },
  {
    name: 'v2.1 布局 mainlabel：只有「电商平台价」标签，靠精准标签法命中',
    layout: 'mainlabel',
    sku: '100200175012',
    check(t, r) {
      t.eq('ok', r.ok, true);
      t.eq('main.price', r.main && r.main.price, 4299);
      t.eq('size.inch', r.size && r.size.inch, 65);
      t.eq('size.source（规格表优先）', r.size && r.size.source, 'spec');
      t.eq('sizeUncertain', r.sizeUncertain, false);
    }
  },
  {
    name: 'v2.1 布局 crosscheck：到手价高于电商平台价 → 丢弃 hand',
    layout: 'crosscheck',
    sku: '100200175013',
    check(t, r) {
      t.eq('ok', r.ok, true);
      t.eq('main.price', r.main && r.main.price, 5999);
      t.eq('hand（高于 main×1.02 被丢弃）', r.hand, null);
      t.eq('pricePick.price', r.pricePick && r.pricePick.price, 5999);
      t.eq('pricePick.kind', r.pricePick && r.pricePick.kind, 'main');
    }
  },
  {
    name: 'v2.1 布局 modelpackage：规格参数表提取型号（套餐不再从参数表兜底）',
    layout: 'modelpackage',
    sku: '100200175014',
    check(t, r) {
      t.eq('ok', r.ok, true);
      t.eq('model', r.model, 'MC75HEE');
      t.eq('modelSource', r.modelSource, 'spec');
      t.eq('package（v2.1.3：只认选购区已选项）', r.package, '');
      t.eq('packageSource', r.packageSource, '');
      t.eq('size.inch', r.size && r.size.inch, 75);
    }
  },
  {
    name: 'v2.1 布局 titlemodel：标题提取型号（套餐不再从标题兜底）',
    layout: 'titlemodel',
    sku: '100200175015',
    check(t, r) {
      t.eq('ok', r.ok, true);
      t.eq('model', r.model, 'MC86HE');
      t.eq('modelSource', r.modelSource, 'title');
      t.eq('package（v2.1.3：标题内存规格不算套餐）', r.package, '');
      t.eq('packageSource', r.packageSource, '');
      t.eq('main.price', r.main && r.main.price, 12999);
      t.eq('hand.price', r.hand && r.hand.price, 11899);
    }
  },
  {
    name: 'v2.1.3 布局 variantpanel：版本组已选项=套餐，屏幕尺寸组=尺寸',
    layout: 'variantpanel',
    sku: '100200175021',
    preview: true,
    check(t, r, extra) {
      t.eq('ok', r.ok, true);
      t.eq('hand.price（到手价 11969）', r.hand && r.hand.price, 11969);
      t.eq('main.price（电商平台价 11999）', r.main && r.main.price, 11999);
      t.eq('pricePick.price', r.pricePick && r.pricePick.price, 11969);
      t.eq('size.inch（屏幕尺寸组）', r.size && r.size.inch, 100);
      t.eq('size.source（规格选择区）', r.size && r.size.source, 'variant');
      t.eq('package（版本组已选项）', r.package, '会议大屏+摄像头【免费送装一体】');
      t.eq('packageGroup', r.packageGroup, '版本');
      t.eq('packageSource', r.packageSource, '规格选项');
      t.eq('specGroups 组数', (r.specGroups || []).length, 4);
      const labels = (r.specGroups || []).map((g) => g.label);
      t.ok(
        'specGroups 含 系列品/屏幕尺寸/版本/颜色',
        ['系列品', '屏幕尺寸', '版本', '颜色'].every((x) => labels.indexOf(x) >= 0),
        String(labels)
      );
      const versionGroup = (r.specGroups || []).find((g) => g.label === '版本');
      t.eq('版本组选项数（「查看更多」被过滤）', versionGroup && versionGroup.options.length, 4);
      t.eq('版本组 selected', versionGroup && versionGroup.selected, '会议大屏+摄像头【免费送装一体】');
      t.eq('版本组 selected 判定来源', versionGroup && versionGroup.source, 'class');
      t.eq('risk.hit（正常商品页）', r.risk && r.risk.hit, false);
      t.eq('previewable', r.previewable, true);

      // v2.1.4 PREVIEW_CAPTURE：向同一 tab 请求「预览快照」，读取当前 DOM 一次
      const p = extra && extra.preview;
      t.ok('PREVIEW_CAPTURE 有响应', !!p);
      t.eq('preview.type', p && p.type, 'PREVIEW_CAPTURE_RESULT');
      t.eq('preview.version', p && p.version, '2.1.7');
      t.eq('preview.sizeUncertain', p && p.sizeUncertain, false);
      t.eq('preview.pageKind', p && p.pageKind, 'item');
      t.eq('preview.offSale', p && p.offSale, false);
      t.eq('preview.softAnomaly', p && p.softAnomaly, false);
      t.eq('preview.ok', p && p.ok, true);
      t.eq('preview.price（到手价）', p && p.price, 11969);
      t.eq('preview.priceKind', p && p.priceKind, 'hand');
      t.eq('preview.prices.hand', p && p.prices && p.prices.hand, 11969);
      t.eq('preview.prices.main', p && p.prices && p.prices.main, 11999);
      t.eq('preview.size.inch', p && p.size && p.size.inch, 100);
      t.eq('preview.size.source', p && p.size && p.size.source, 'variant');
      t.eq('preview.package', p && p.package, '会议大屏+摄像头【免费送装一体】');
      t.eq('preview.packageGroup', p && p.packageGroup, '版本');
      t.eq('preview.specGroups 组数', ((p && p.specGroups) || []).length, 4);
      t.eq('preview.risk.hit', p && p.risk && p.risk.hit, false);
    }
  },
  {
    name: 'v2.1.5 布局 homejump：跳回电商平台首页（无验证）→ softAnomaly 非 risk，等待自动继续',
    layout: 'homejump',
    sku: '100200175031',
    mockLocation: 'https://www.shop.example.com/',
    preview: true,
    check(t, r, extra) {
      t.eq('ok', r.ok, false);
      t.eq('pageKind', r.pageKind, 'softAnomaly');
      t.eq('softAnomaly', r.softAnomaly, true);
      t.eq('risk.hit（跳首页不再算风控）', r.risk && r.risk.hit, false);
      t.eq('anomaly.reason', r.anomaly && r.anomaly.reason, 'home');
      t.ok('anomaly.url 含 www.shop.example.com', String((r.anomaly && r.anomaly.url) || '').indexOf('www.shop.example.com') >= 0);
      t.ok('reason 含「跳转」或「首页」', /跳转|首页/.test(String(r.reason || '')), r.reason);
      t.eq('previewable', r.previewable, false);
      t.eq('main（不解析价格）', r.main, null);
      t.eq('hand（不解析价格）', r.hand, null);
      t.eq('pricePick（不解析价格）', r.pricePick, null);
      t.eq('size（不解析尺寸）', r.size, null);
      t.eq('package', r.package, '');
      t.eq('specGroups', (r.specGroups || []).length, 0);
      // 预览通道在软异常页也必须返回 softAnomaly，不能把首页当商品
      const p = extra && extra.preview;
      t.ok('PREVIEW_CAPTURE 有响应', !!p);
      t.eq('preview.ok', p && p.ok, false);
      t.eq('preview.pageKind', p && p.pageKind, 'softAnomaly');
      t.eq('preview.softAnomaly', p && p.softAnomaly, true);
      t.eq('preview.risk.hit', p && p.risk && p.risk.hit, false);
      t.eq('preview.price', p && p.price, null);
    }
  },
  {
    name: 'v2.1.6 布局 sizespec：规格表 65 优先于标题里的型号数字/多值名称',
    layout: 'sizespec',
    sku: '100200175051',
    check(t, r) {
      t.eq('ok', r.ok, true);
      t.eq('main.price', r.main && r.main.price, 8999);
      t.ok('测试前提：标题本身是多值尺寸', /55\/65英寸/.test(r.title || ''), r.title);
      t.eq('size.inch（规格表 65）', r.size && r.size.inch, 65);
      t.eq('size.source', r.size && r.size.source, 'spec');
      t.eq('sizeUncertain', r.sizeUncertain, false);
    }
  },
  {
    name: 'v2.1.6 布局 sizemulti：标题多值/型号数字 → size=null+sizeUncertain；价格只认 DOM',
    layout: 'sizemulti',
    sku: '100200175052',
    preview: true,
    check(t, r, extra) {
      t.eq('ok（DOM 有价格）', r.ok, true);
      t.eq('main.price（DOM 6999）', r.main && r.main.price, 6999);
      t.eq('hand（页面无到手价）', r.hand, null);
      t.eq('size（多值不采用）', r.size, null);
      t.eq('sizeUncertain', r.sizeUncertain, true);
      t.ok('sizeReason 含「多个尺寸」', /多个尺寸/.test(String(r.sizeReason || '')), r.sizeReason);
      t.eq('title 里出现 55/65 英寸', /55\/65英寸/.test(r.title || ''), true);
      const titlePrice = (r.candidates || []).filter((c) => Number(c.price) === 5000);
      t.eq('标题里的「5000元」没有变成价格候选', titlePrice.length, 0);
      t.eq('previewable', r.previewable, true);
      const p = extra && extra.preview;
      t.ok('PREVIEW_CAPTURE 有响应', !!p);
      t.eq('preview.size（不猜）', p && p.size, null);
      t.eq('preview.sizeUncertain', p && p.sizeUncertain, true);
      t.eq('preview.price（只来自 DOM）', p && p.price, 6999);
    }
  },

  // ---- v2.1.7：移植巡检双轨版价格算法（价格区锁定/排除卡片/严格解析/字号最大/稳定性+复核）----
  {
    name: 'v2.1.7 布局 pricecards：比价/关联/推荐卡不抢价（真实到手价 5999）',
    layout: 'pricecards',
    sku: '100200175061',
    check(t, r) {
      t.eq('ok', r.ok, true);
      t.eq('price', r.price, 5999);
      t.eq('priceKind', r.priceKind, 'hand');
      t.eq('priceKindLabel', r.priceKindLabel, '到手价');
      t.eq('hand.price', r.hand && r.hand.price, 5999);
      t.eq('main.price（电商平台价）', r.main && r.main.price, 6499);
      t.ok('priceRect 有位置', !!(r.priceRect && r.priceRect.width > 0), JSON.stringify(r.priceRect));
      t.ok('sourceLabel 记录 hand-price', /hand-price/.test(String(r.sourceLabel || '')), r.sourceLabel);
      const cards = (r.candidates || []).filter((c) => [8499, 1999, 2999].indexOf(Number(c.price)) >= 0);
      t.eq('卡片价格被排除容器过滤（不进入候选）', cards.length, 0);
      const top = (r.candidates || [])[0];
      t.ok('candidates 带 font/cls/rect', !!(top && Number(top.font) >= 0 && top.cls && top.rect), JSON.stringify(top));
    }
  },
  {
    name: 'v2.1.7 布局 splitprice：拆分 ¥8607.56 拼回完整价，不取 56 片段',
    layout: 'splitprice',
    sku: '100200175062',
    check(t, r) {
      t.eq('ok', r.ok, true);
      t.eq('price（完整价）', r.price, 8607.56);
      t.eq('priceKind', r.priceKind, 'hand');
      t.eq('pricePick.price', r.pricePick && r.pricePick.price, 8607.56);
      const frag = (r.candidates || []).filter((c) => Number(c.price) === 56);
      t.eq('没有把 56 当价格候选', frag.length, 0);
      t.ok('候选里含完整价 8607.56', (r.candidates || []).some((c) => Number(c.price) === 8607.56));
    }
  },
  {
    name: 'v2.1.7 布局 hiddenprice：隐藏抽屉里的 4999 不参与',
    layout: 'hiddenprice',
    sku: '100200175063',
    check(t, r) {
      t.eq('ok', r.ok, true);
      t.eq('price（可见到手价）', r.price, 6999);
      t.eq('priceKind', r.priceKind, 'hand');
      const hidden = (r.candidates || []).filter((c) => Number(c.price) === 4999);
      t.eq('隐藏的 4999 不在候选里', hidden.length, 0);
    }
  },
  {
    name: 'v2.1.7 布局 pricerefresh：页面二次刷新 24699→25099，采用最终值并记录 priceChanges',
    layout: 'pricerefresh',
    sku: '100200175064',
    afterInject: "window.__mockRefreshPrice && window.__mockRefreshPrice()",
    check(t, r) {
      t.eq('ok', r.ok, true);
      t.eq('price（最终读数）', r.price, 25099);
      t.eq('priceKind', r.priceKind, 'hand');
      t.ok(
        'priceChanges 记录 24699→25099',
        Array.isArray(r.priceChanges) &&
          r.priceChanges.some((c) => Number(c.from) === 24699 && Number(c.to) === 25099),
        JSON.stringify(r.priceChanges)
      );
    }
  },
  {
    name: 'v2.1.7 布局 belowfold：首屏无价放宽全页（仍排除推荐卡）',
    layout: 'belowfold',
    sku: '100200175065',
    check(t, r) {
      t.eq('ok', r.ok, true);
      t.eq('price（第二屏到手价）', r.price, 5999);
      t.eq('priceKind', r.priceKind, 'hand');
      const rec = (r.candidates || []).filter((c) => Number(c.price) === 2999);
      t.eq('推荐卡 2999 被排除', rec.length, 0);
      t.ok(
        '候选取自第二屏（rect.top 越过首屏）',
        (r.candidates || []).some((c) => Number(c.price) === 5999 && c.rect && c.rect.top >= 800),
        JSON.stringify((r.candidates || []).map((c) => c.rect && c.rect.top))
      );
    }
  },
  {
    name: 'v2.1.7 布局 mainonly：只有电商平台价 → kind=main',
    layout: 'mainonly',
    sku: '100200175066',
    check(t, r) {
      t.eq('ok', r.ok, true);
      t.eq('price', r.price, 5999);
      t.eq('priceKind', r.priceKind, 'main');
      t.eq('priceKindLabel', r.priceKindLabel, '电商平台价');
      t.eq('hand（没有到手价）', r.hand, null);
      t.eq('pricePick.kind', r.pricePick && r.pricePick.kind, 'main');
    }
  }
];

// ---------------- 主流程 ----------------
async function main() {
  if (!fs.existsSync(EDGE_PATH)) throw new Error('找不到 Edge：' + EDGE_PATH + '（可用 DSH_EDGE_PATH 覆盖）');
  if (!fs.existsSync(CONTENT_JS)) throw new Error('找不到 content.js：' + CONTENT_JS);
  if (!fs.existsSync(MOCK_HTML)) throw new Error('找不到 mock-item.html：' + MOCK_HTML);

  const contentSource = fs.readFileSync(CONTENT_JS, 'utf8');
  let port = await getFreePort();
  const profileBase = path.join(os.tmpdir(), 'dsh-jd-capture-cdp-' + Date.now());
  const pidFile = path.join(os.tmpdir(), 'dsh-jd-capture-cdp-pid-' + process.pid + '.txt');

  console.log('Edge：' + EDGE_PATH);
  console.log('mock：' + MOCK_HTML);
  try {
    fs.rmSync(pidFile, { force: true });
  } catch (e) {
    // 忽略
  }

  let launched = null;
  let client = null;
  let pageTargetId = '';
  const allExceptions = [];

  try {
    launched = await launchEdge(port, profileBase, pidFile);
    port = launched.port || port;
    console.log('启动方式：' + launched.how);
    console.log('CDP 端口：' + port + '，临时 profile：' + launched.profileDir);
    console.log('浏览器：' + launched.version.Browser);

    const target = await cdpHttp(port, '/json/new?' + encodeURIComponent('about:blank'), { method: 'PUT' });
    if (!target || !target.webSocketDebuggerUrl) {
      console.error('新建标签页返回异常：' + JSON.stringify(target).slice(0, 400));
    }
    pageTargetId = target.id;
    client = await CdpClient.connect(target.webSocketDebuggerUrl);
    await client.send('Runtime.enable');
    await client.send('Page.enable');
    await client.send('Log.enable');
    await client.send('Page.addScriptToEvaluateOnNewDocument', { source: INIT_SCRIPT });

    for (const testCase of TEST_CASES) {
      currentCase = testCase.name;
      console.log('\n▶ ' + testCase.name);
      const url = mockUrl(testCase.layout, testCase.sku, testCase.nochrome, testCase.mockLocation);
      await client.send('Page.navigate', { url: url });
      await client.waitFor(PAGE_READY_EXPR, 15000);

      // 注入 content.js（等价于 content_scripts 在 document_idle 注入）
      await client.eval(contentSource, false);
      // v2.1.7：注入后钩子（如 pricerefresh：content.js 第一次采样之后触发页面价格二次刷新）
      if (testCase.afterInject) {
        try {
          await client.eval(testCase.afterInject, false);
        } catch (e) {
          console.error('  afterInject 执行失败：' + ((e && e.message) || e));
        }
      }

      // 等待采集结果：有 fake chrome 时等消息；无 chrome 时等 window.__jdMarketCapture.ready
      await client.waitFor(
        `(function () {
          const api = window.__jdMarketCapture;
          if (window.__captureMessages && window.__captureMessages.length) return true;
          return !!(api && api.ready && api.lastResult);
        })()`,
        20000
      );

      const state = await client.eval(`(function () {
        const api = window.__jdMarketCapture;
        const msgs = (window.__captureMessages || []).slice();
        return { msg: msgs.length ? msgs[0] : null, last: api ? api.lastResult : null, msgs: msgs, ready: !!(api && api.ready) };
      })()`);

      // PING 用例：注入后再调用 fake runtime 的监听器
      let ping = null;
      if (testCase.name.indexOf('PING') === 0) {
        ping = await client.eval(`(function () {
          return (typeof window.__fakeRuntimePing === 'function') ? window.__fakeRuntimePing({ type: 'PING' }) : null;
        })()`);
      }

      // v2.1.4 PREVIEW_CAPTURE 用例：模拟工作台向该 tab 请求预览快照
      let preview = null;
      if (testCase.preview) {
        preview = await client.eval(`(function () {
          return (typeof window.__fakeRuntimeSendMsg === 'function')
            ? window.__fakeRuntimeSendMsg({ type: 'PREVIEW_CAPTURE' })
            : null;
        })()`);
      }

      const result = state.msg || state.last;
      const t = makeAsserter(testCase.name);
      try {
        testCase.check(t, result, { state: state, ping: ping, preview: preview });
      } catch (e) {
        t.ok('用例检查未抛异常', false, (e && e.message) || String(e));
      }
      if (testCase.check.length > 0 && !result) {
        t.ok('采集结果非空', false, '没有拿到 content.js 的结果消息');
      }
      console.log('  ' + (t.record.fail === 0 ? '✓ 通过 ' + t.record.pass + ' 项断言' : '✗ ' + t.record.fail + ' 项失败 / ' + t.record.pass + ' 项通过'));

      if (testCase.nochrome) {
        const noChromeMsgs = (state.msgs || []).length;
        if (noChromeMsgs !== 0) console.error('  ✗ 无 chrome 环境不应发消息，实际 ' + noChromeMsgs + ' 条');
      }
    }

    allExceptions.push(...client.exceptions);
    // 单独汇总一次页面异常（content.js / mock 页任何未捕获异常都算失败）
    const t = makeAsserter('页面无未捕获异常');
    t.eq('Runtime.exceptionThrown 数量', allExceptions.length, 0);
    if (allExceptions.length) console.error('  异常列表：' + JSON.stringify(allExceptions.slice(0, 5), null, 2));
  } finally {
    if (client) client.close();
    if (pageTargetId) {
      try {
        await cdpHttp(port, '/json/close/' + pageTargetId, { method: 'GET' });
      } catch (e) {
        // 忽略
      }
    }
    if (launched) await closeBrowser(port, launched.pid);
    await removeDirWithRetry(profileBase + '-a');
    await removeDirWithRetry(profileBase + '-b');
    try {
      fs.rmSync(pidFile, { force: true });
    } catch (e) {
      // 忽略
    }
  }

  // ---------------- 汇总 ----------------
  console.log('\n================ 测试汇总 ================');
  for (const c of results.cases) {
    console.log((c.fail === 0 ? '✓ ' : '✗ ') + c.name + '（' + c.pass + '/' + (c.pass + c.fail) + '）');
  }
  console.log('------------------------------------------');
  console.log('断言：通过 ' + results.pass + '，失败 ' + results.fail);
  const failedCases = results.cases.filter((c) => c.fail > 0);
  if (failedCases.length) {
    console.log('失败用例：' + failedCases.map((c) => c.name).join('；'));
    process.exitCode = 1;
  } else {
    console.log('全部通过 ✓');
  }
}

main().catch(async (e) => {
  console.error('\nCDP 测试异常终止：' + ((e && e.stack) || e));
  process.exitCode = 1;
});
