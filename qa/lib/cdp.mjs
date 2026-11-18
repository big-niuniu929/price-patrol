// 极简 CDP 客户端（零依赖，Node 内置 WebSocket）+ Edge headless 启动/清理封装。
// 供 tools/qa/shot.mjs（截图）与 tests/qa/ui-smoke.mjs（冒烟）共用。
//
// 环境事实（Lead 已验证）：
// - Edge: C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe
// - headless=new 可以加载未打包扩展；启动后 8 秒内 /json/list 能看到扩展 target
// - 清理必须 taskkill /PID <pid> /T /F，不能 Stop-Process 全部 msedge（会误杀用户窗口）
// - profile 放系统临时目录（不要放工作区）
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

export function findBrowser() {
  for (const p of EDGE_CANDIDATES) if (fs.existsSync(p)) return p;
  throw new Error('找不到 Edge/Chrome 可执行文件，请用 --browser 指定');
}

/** 简单 CDP RPC 客户端：connect → rpc() → on(event)。 */
export class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
  }

  async connect(timeoutMs = 15000) {
    const ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CDP WebSocket 连接超时：${this.wsUrl}`)), timeoutMs);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', (ev) => { clearTimeout(timer); reject(new Error(`CDP WebSocket 连接失败：${ev?.message || this.wsUrl}`)); }, { once: true });
    });
    this.ws = ws;
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id) {
        const pend = this.pending.get(msg.id);
        if (!pend) return;
        this.pending.delete(msg.id);
        msg.error ? pend.reject(new Error(`CDP error ${msg.method || ''}: ${JSON.stringify(msg.error)}`)) : pend.resolve(msg.result);
        return;
      }
      if (msg.method) {
        for (const fn of this.handlers.get(msg.method) || []) {
          try { fn(msg.params, msg.sessionId); } catch { /* 事件回调异常不影响主流程 */ }
        }
      }
    });
    ws.addEventListener('close', () => {
      for (const { reject } of this.pending.values()) reject(new Error('CDP 连接已关闭'));
      this.pending.clear();
    });
  }

  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
    return () => {
      const arr = this.handlers.get(method) || [];
      const idx = arr.indexOf(fn);
      if (idx >= 0) arr.splice(idx, 1);
    };
  }

  rpc(method, params = {}, timeoutMs = 30000) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('CDP 未连接'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 调用超时 ${method}(${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try { this.ws?.close(); } catch { /* ignore */ }
  }
}

/** 轮询 /json/version 直到 CDP 就绪。 */
export async function waitForCdp(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return await res.json();
    } catch (err) { lastErr = err; }
    await sleep(250);
  }
  throw new Error(`CDP 未就绪（端口 ${port}）：${lastErr?.message || '超时'}`);
}

/**
 * 启动 headless Edge。
 * @param {{extDir?: string, browser?: string, port?: number, profileDir?: string, extraArgs?: string[], startupUrl?: string}} opts
 * @returns {Promise<{child: import('node:child_process').ChildProcess, port: number, profileDir: string, version: object, close: () => Promise<void>}>}
 */
export async function launchBrowser(opts = {}) {
  const browser = opts.browser || findBrowser();
  const port = opts.port || 9200 + Math.floor(Math.random() * 600);
  const profileDir = opts.profileDir || fs.mkdtempSync(path.join(os.tmpdir(), 'ds-edge-qa-'));
  const args = [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--disable-background-networking',
    '--disable-sync',
    '--metrics-recording-only',
    '--mute-audio',
    `--window-size=${opts.width || 1440},${opts.height || 900}`,
  ];
  if (opts.extDir) {
    args.push(`--load-extension=${opts.extDir}`, `--disable-extensions-except=${opts.extDir}`);
  }
  if (opts.extraArgs) args.push(...opts.extraArgs);
  args.push(opts.startupUrl || 'about:blank');

  // 关键：detached 必须为 true。Edg/Chromium 若作为普通子进程被 DSH 作业对象收走会直接被杀
  // （exit code 2147483651、mojo 通道 拒绝访问、CDP 永远不 ready）；detached 后独立进程可正常启动。
  // 清理仍用 taskkill /PID /T /F 杀自己的进程树，不影响用户自己的 Edge 窗口。
  const child = spawn(browser, args, { stdio: 'ignore', windowsHide: true, detached: true });
  child.unref();
  let exited = false;
  child.once('exit', () => { exited = true; });

  const close = async () => {
    if (exited) return;
    try {
      // 只杀自己的进程树（Windows）：taskkill /PID /T /F
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch { try { child.kill(); } catch { /* ignore */ } }
    for (let i = 0; i < 20 && !exited; i++) await sleep(100);
    // 等 Edge 释放 profile 文件锁后再删
    for (let i = 0; i < 5; i++) {
      try { fs.rmSync(profileDir, { recursive: true, force: true }); break; } catch { await sleep(300); }
    }
  };

  try {
    const version = await waitForCdp(port, opts.cdpTimeoutMs || 40000);
    return { child, port, profileDir, version, close };
  } catch (err) {
    await close();
    throw err;
  }
}

async function listTargetsHttp(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) });
  return await res.json();
}

/**
 * 从所有 target 里找**本扩展**的 ID。
 *
 * 关键：不能拿「第一个 chrome-extension:// target」——Edge/Chrome 自带扩展（反馈/WebRTC/Media/
 * Gemini 等）也会出现，取到就是错 ID（打开 app.html 会 net::ERR_FILE_NOT_FOUND）。
 * 最稳的特征：本扩展安装后 background 会自动打开 app.html → 页面 target
 *   chrome-extension://<id>/app.html
 * 退路：service_worker 为 /background.js 的扩展；但浏览器自带扩展也可能命中，所以只在候选唯一时使用。
 * 兜底：可用环境变量 DS_EXT_ID 覆盖。
 */
const OWN_EXT_SW_RE = /^chrome-extension:\/\/([a-p]{32})\/background\.js$/;
const OWN_APP_PAGE_RE = /^chrome-extension:\/\/([a-p]{32})\/app\.html(?:[?#].*)?$/;

export async function findExtensionId(port, timeoutMs = 25000) {
  const override = (process.env && process.env.DS_EXT_ID) || '';
  const deadline = Date.now() + timeoutMs;
  let sawAnyExtension = false;
  const swIds = new Set();

  while (Date.now() < deadline) {
    try {
      const list = await listTargetsHttp(port);
      // 1) 最稳：已经打开的 app.html 页面 target（本扩展安装后 background 会自动打开）
      for (const t of list) {
        if (t.type !== 'page') continue;
        const m = OWN_APP_PAGE_RE.exec(t.url || '');
        if (m) return m[1];
      }
      // 2) 收集 /background.js service worker 候选（浏览器自带扩展可能命中，暂存）
      for (const t of list) {
        if (t.type === 'service_worker') {
          const m = OWN_EXT_SW_RE.exec(t.url || '');
          if (m) swIds.add(m[1]);
        }
        if (/^chrome-extension:\/\//.test(t.url || '')) sawAnyExtension = true;
      }
    } catch { /* 继续重试 */ }

    // HTTP /json/list 可能不列 service_worker，用 browser ws 的 Target.getTargets 兜底
    try {
      const ver = await waitForCdp(port, 3000);
      const client = new CdpClient(ver.webSocketDebuggerUrl);
      await client.connect(5000);
      try {
        await client.rpc('Target.setDiscoverTargets', { discover: true }, 5000);
        await sleep(300);
        const { targetInfos } = await client.rpc('Target.getTargets', {}, 5000);
        for (const t of targetInfos) {
          if (t.type === 'page') {
            const m = OWN_APP_PAGE_RE.exec(t.url || '');
            if (m) return m[1];
          }
          if (t.type === 'service_worker') {
            const m = OWN_EXT_SW_RE.exec(t.url || '');
            if (m) swIds.add(m[1]);
          }
        }
      } finally { client.close(); }
    } catch { /* 继续重试 */ }

    if (override) return override;
    await sleep(300);
  }

  if (swIds.size === 1) return [...swIds][0];
  if (swIds.size > 1) {
    throw new Error('发现多个 /background.js 扩展，无法确定本扩展（可设置环境变量 DS_EXT_ID 指定）：' + [...swIds].join(', '));
  }
  if (sawAnyExtension) {
    throw new Error('发现 chrome-extension:// target，但没有本扩展的 app.html 页面 / service_worker：扩展可能加载失败，检查 --load-extension 路径与 manifest');
  }
  throw new Error('没发现 chrome-extension:// target（扩展可能未加载，检查 --load-extension 路径）');
}

/** 复用浏览器启动时的页面 target（尽量不新建 target：headless 下最稳）。 */
export async function findPageTarget(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const list = await listTargetsHttp(port);
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return { targetId: page.id, wsUrl: page.webSocketDebuggerUrl, url: page.url };
    } catch { /* 继续重试 */ }
    await sleep(200);
  }
  throw new Error(`没找到页面 target（端口 ${port}）`);
}

/** 通过 browser WS 新建页面 target，返回页面 WebSocket URL（findPageTarget 不可用时兜底）。 */
export async function createPageTarget(port, url) {
  const ver = await waitForCdp(port);
  const browser = new CdpClient(ver.webSocketDebuggerUrl);
  await browser.connect();
  let targetId;
  try {
    const created = await browser.rpc('Target.createTarget', { url, background: false }, 15000);
    targetId = created.targetId;
  } finally { browser.close(); }
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const list = await listTargetsHttp(port);
    const hit = list.find((t) => t.id === targetId);
    if (hit?.webSocketDebuggerUrl) return { targetId, wsUrl: hit.webSocketDebuggerUrl };
    await sleep(150);
  }
  throw new Error(`创建的页面 target 未出现在 /json/list（${url}）`);
}

/** 页面级自动化封装：导航、等待、求值、文件上传、点击、截图、收集 console error。 */
export class PageSession {
  constructor(wsUrl) {
    this.client = new CdpClient(wsUrl);
    this.consoleErrors = [];
    this.consoleAll = [];
    this.pageExceptions = [];
    this.logEntries = [];
  }

  async connect() {
    await this.client.connect();
    await this.client.rpc('Page.enable');
    await this.client.rpc('Runtime.enable');
    await this.client.rpc('DOM.enable');
    try { await this.client.rpc('Log.enable'); } catch { /* 旧版本无 Log 域时忽略 */ }
    this.client.on('Runtime.consoleAPICalled', (p) => {
      const text = (p.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ');
      this.consoleAll.push({ type: p.type, text });
      if (p.type === 'error' || p.type === 'assert') this.consoleErrors.push(`[console.${p.type}] ${text}`);
    });
    this.client.on('Runtime.exceptionThrown', (p) => {
      const d = p.exceptionDetails || {};
      const text = d.exception?.description || d.text || '未知异常';
      this.consoleErrors.push(`[exception] ${text}`);
      this.pageExceptions.push(text);
    });
    this.client.on('Log.entryAdded', (p) => {
      const e = p.entry || {};
      this.logEntries.push(e);
      if (e.level === 'error') this.consoleErrors.push(`[log.error] ${e.text || e.url || ''}`);
    });
    return this;
  }

  async setViewport(width = 1440, height = 900, deviceScaleFactor = 1) {
    await this.client.rpc('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor, mobile: false });
  }

  async navigate(url, { timeoutMs = 30000, settleMs = 1500 } = {}) {
    const loaded = new Promise((resolve) => {
      const off = this.client.on('Page.loadEventFired', () => { off(); resolve(); });
      setTimeout(() => { off(); resolve(); }, timeoutMs);
    });
    const res = await this.client.rpc('Page.navigate', { url }, timeoutMs);
    if (res?.errorText) throw new Error(`导航失败 ${url}：${res.errorText}`);
    await loaded;
    await sleep(settleMs);
    return res;
  }

  async evaluate(expression, { awaitPromise = true, returnByValue = true, timeoutMs = 30000 } = {}) {
    const r = await this.client.rpc('Runtime.evaluate', {
      expression, awaitPromise, returnByValue, userGesture: true,
    }, timeoutMs);
    if (r.exceptionDetails) {
      throw new Error(`页面求值异常：${r.exceptionDetails.exception?.description || r.exceptionDetails.text}\n表达式：${expression.slice(0, 300)}`);
    }
    return r.result?.value;
  }

  /** 轮询等待表达式为真，返回最后一次值；超时抛错。 */
  async waitFor(expression, { timeoutMs = 20000, intervalMs = 250, label = expression } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      try { last = await this.evaluate(`(${expression})`); } catch { last = undefined; }
      if (last) return last;
      await sleep(intervalMs);
    }
    throw new Error(`等待超时：${label}`);
  }

  async bodyText() {
    return await this.evaluate('document.body ? document.body.innerText : ""');
  }

  /** 用 CDP DOM.setFileInputFiles 给 <input type=file> 选文件（可多个）。 */
  async setFileInputs(selector, files) {
    const { root } = await this.client.rpc('DOM.getDocument', { depth: -1, pierce: true });
    const { nodeId } = await this.client.rpc('DOM.querySelector', { nodeId: root.nodeId, selector });
    if (!nodeId) throw new Error(`找不到文件输入框：${selector}`);
    await this.client.rpc('DOM.setFileInputFiles', { nodeId, files });
    return true;
  }

  /** 按可见文本点击元素（默认按钮/链接/tab/li）。找不到返回 false。 */
  async clickByText(texts, { selector = 'button, a, [role="tab"], .tab, .nav-item, li, label', exact = false } = {}) {
    const list = Array.isArray(texts) ? texts : [texts];
    const found = await this.evaluate(`(() => {
      const list = ${JSON.stringify(list)};
      const exact = ${exact};
      const nodes = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
      const visible = nodes.filter((el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
      });
      // 优先浅层、文本短的元素，避免点到容器
      visible.sort((a, b) => (a.textContent.trim().length - b.textContent.trim().length) || (a.querySelectorAll('*').length - b.querySelectorAll('*').length));
      for (const el of visible) {
        const t = (el.textContent || '').trim();
        for (const want of list) {
          const hit = exact ? t === want : t.includes(want);
          if (hit) {
            el.scrollIntoView({ block: 'center' });
            el.click();
            return { ok: true, tag: el.tagName, text: t.slice(0, 60), id: el.id || '', cls: String(el.className).slice(0, 80) };
          }
        }
      }
      return { ok: false };
    })()`);
    if (found?.ok) await sleep(350);
    return found?.ok ? found : false;
  }

  /** 截当前视口 PNG。 */
  async screenshot(filePath) {
    const { data } = await this.client.rpc('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }, 30000);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, Buffer.from(data, 'base64'));
    return filePath;
  }

  close() {
    try { this.client.close(); } catch { /* ignore */ }
  }
}

export { sleep };
