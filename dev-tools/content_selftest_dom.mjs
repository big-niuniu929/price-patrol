// 电商平台市占率数据工作台 · content.js 的「无浏览器」补充自检（dev-tools 专用，不随扩展发布）
//
// 用途：在跑不了浏览器的环境里（例如被限制启动 Edge 的沙箱），用一套极简 DOM 模拟器
//      加载 mock-item.html 各布局，注入 extension/content.js，验证取价/取尺寸/风控/下架/数字片段
//      这些纯 DOM 逻辑。**权威测试仍是 dev-tools/cdp_capture_test.mjs（真实 Edge + CDP）**，
//      本脚本只是让改 content.js 时能先在 Node 里快速回归。
//
// 实现要点：
//   1) 先执行 mock-item.html 里的内联脚本，拿到它生成的 app.innerHTML 和 document.title；
//   2) 用极简 HTML 解析器 + 选择器引擎（只支持 content.js 实际用到的选择器语法）搭出 DOM；
//   3) 用 node:vm 在同一个上下文里跑 content.js，用 fake chrome.runtime 收结果。
//
// 运行：node dev-tools/content_selftest_dom.mjs

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_HTML = path.join(__dirname, 'mock-item.html');
const CONTENT_JS = path.join(__dirname, '..', 'extension', 'content.js');
const CONTENT_SOURCE = fs.readFileSync(CONTENT_JS, 'utf8');
const MOCK_SOURCE = fs.readFileSync(MOCK_HTML, 'utf8');

const TUNING = {
  maxWaitMs: 900,
  roundIntervalMs: 15,
  stableRounds: 2,
  mainWaitMs: 300,
  recheckTimes: 2,
  recheckDelayMs: 20,
  settleMs: 20,
  minPlausiblePrice: 30,
  maxPlausiblePrice: 2000000
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------- 极简 DOM ----------------
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const BLOCK_TAGS = new Set([
  'html', 'body', 'div', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'dt', 'dd', 'tr', 'ul', 'ol', 'dl',
  'table', 'section', 'header', 'footer', 'article', 'aside', 'br', 'form', 'nav'
]);

let nodeIdSeq = 0;

class ShimText {
  constructor(data) {
    this.nodeType = 3;
    this.data = String(data);
    this.parentElement = null;
  }
  get textContent() {
    return this.data;
  }
}

class ShimElement {
  constructor(tag) {
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this.attributes = Object.create(null);
    this.childNodes = [];
    this.parentElement = null;
    this.ownerDocument = null;
    this.__id = ++nodeIdSeq;
  }
  get children() {
    return this.childNodes.filter((n) => n.nodeType === 1);
  }
  get id() {
    return this.attributes.id || '';
  }
  get className() {
    return this.attributes.class || '';
  }
  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
  get textContent() {
    let out = '';
    for (const child of this.childNodes) out += child.nodeType === 3 ? child.data : child.textContent;
    return out;
  }
  get innerText() {
    return innerTextOf(this);
  }
  get isConnected() {
    let node = this;
    while (node) {
      if (this.ownerDocument && node === this.ownerDocument.documentElement) return true;
      node = node.parentElement;
    }
    return false;
  }
  get previousElementSibling() {
    if (!this.parentElement) return null;
    const siblings = this.parentElement.children;
    const idx = siblings.indexOf(this);
    return idx > 0 ? siblings[idx - 1] : null;
  }
  get style() {
    return styleOf(this);
  }
  getClientRects() {
    return rectOfShim(this).width > 0 ? [{}] : [];
  }
  getBoundingClientRect() {
    return rectOfShim(this);
  }
  querySelectorAll(selector) {
    return querySelectorAllIn(this, selector);
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

// 内联 style 属性解析（不含 CSS 类规则）
function inlineDeclsOf(el) {
  const decls = Object.create(null);
  const raw = (el && el.getAttribute && el.getAttribute('style')) || '';
  for (const part of raw.split(';')) {
    const idx = part.indexOf(':');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    decls[key] = value;
    const camel = key.replace(/-([a-z])/g, (m, c) => c.toUpperCase());
    decls[camel] = value;
  }
  return decls;
}

function styleOf(el) {
  const style = inlineDeclsOf(el);
  return {
    display: style.display || '',
    visibility: style.visibility || '',
    opacity: style.opacity || '',
    fontSize: style.fontSize || '',
    textDecoration: style.textDecoration || style['text-decoration'] || '',
    textDecorationLine: style.textDecorationLine || style['text-decoration-line'] || style.textDecoration || '',
    getPropertyValue(name) {
      return style[name] || '';
    }
  };
}

// 极简 CSS 规则解析（只用于 mock-item.html 的 <style>，给 selftest 提供字号/隐藏等计算样式）
function parseMockCssRules(html) {
  const m = String(html || '').match(/<style[^>]*>([\s\S]*?)<\/style>/i);
  const css = m ? m[1] : '';
  const rules = [];
  const re = /([^{}]+)\{([^}]*)\}/g;
  let x;
  while ((x = re.exec(css))) {
    const decls = Object.create(null);
    for (const part of x[2].split(';')) {
      const idx = part.indexOf(':');
      if (idx < 0) continue;
      const key = part.slice(0, idx).trim();
      const value = part.slice(idx + 1).trim();
      if (!key) continue;
      decls[key] = value;
      decls[key.replace(/-([a-z])/g, (mm, c) => c.toUpperCase())] = value;
    }
    for (const sel of x[1].split(',')) {
      const s = sel.trim();
      if (s) rules.push({ sel: s, decls: decls });
    }
  }
  return rules;
}

const MOCK_CSS_RULES = parseMockCssRules(MOCK_SOURCE);

function matchCssToken(el, tok) {
  if (!el || el.nodeType !== 1) return false;
  if (tok === '*') return true;
  const tagMatch = tok.match(/^[a-zA-Z][a-zA-Z0-9-]*/);
  const tag = tagMatch ? tagMatch[0].toLowerCase() : '';
  if (tag && (el.tagName || '').toLowerCase() !== tag) return false;
  const classes = (tok.match(/\.[A-Za-z0-9_-]+/g) || []).map((s) => s.slice(1));
  const ids = (tok.match(/#[A-Za-z0-9_-]+/g) || []).map((s) => s.slice(1));
  const elClasses = String(el.className || '')
    .split(/\s+/)
    .filter(Boolean);
  for (const c of classes) if (elClasses.indexOf(c) < 0) return false;
  for (const d of ids) if ((el.id || '') !== d) return false;
  return true;
}

function matchesCssSelector(el, sel) {
  const tokens = String(sel || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  let cur = el;
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (!matchCssToken(cur, tokens[i])) return false;
    if (i > 0) {
      cur = cur.parentElement;
      if (!cur) return false;
    }
  }
  return true;
}

function cssDeclsOf(el) {
  const out = Object.create(null);
  for (const rule of MOCK_CSS_RULES) {
    try {
      if (matchesCssSelector(el, rule.sel)) Object.assign(out, rule.decls);
    } catch (e) {
      // 忽略单条规则异常
    }
  }
  return out;
}

function inheritedFontSize(el) {
  let cur = el && el.parentElement;
  for (let i = 0; i < 20 && cur; i++, cur = cur.parentElement) {
    const inline = inlineDeclsOf(cur);
    const css = cssDeclsOf(cur);
    const v = inline.fontSize || inline['font-size'] || css.fontSize || css['font-size'];
    if (v) {
      const n = parseFloat(v);
      if (isFinite(n)) return n;
    }
  }
  return 14;
}

// 计算样式（mock 的 <style> 类规则 + 内联 style，字号支持继承；供 content.js 的 getComputedStyle 使用）
function computedStyleOf(el) {
  const inline = inlineDeclsOf(el);
  const css = cssDeclsOf(el);
  const decls = Object.assign(Object.create(null), css, inline);
  const ownFont = decls.fontSize || decls['font-size'];
  let fontPx = ownFont ? parseFloat(ownFont) : 0;
  if (!isFinite(fontPx) || fontPx <= 0) fontPx = inheritedFontSize(el);
  const deco = decls.textDecoration || decls['text-decoration'] || '';
  const decoLine = decls.textDecorationLine || decls['text-decoration-line'] || deco;
  return {
    display: decls.display || '',
    visibility: decls.visibility || '',
    opacity: decls.opacity || '',
    position: decls.position || '',
    fontSize: String(fontPx) + 'px',
    textDecoration: deco,
    textDecorationLine: decoLine,
    getPropertyValue(name) {
      return decls[name] || '';
    }
  };
}

function shimHiddenByAncestor(el) {
  let cur = el;
  for (let i = 0; i < 20 && cur && cur.nodeType === 1; i++, cur = cur.parentElement) {
    const st = styleOf(cur);
    if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity || 1) <= 0) return true;
  }
  return false;
}

function shimLayoutNumber(el, prop, fallback) {
  let cur = el;
  for (let i = 0; i < 20 && cur && cur.nodeType === 1; i++, cur = cur.parentElement) {
    const attr = cur.getAttribute && cur.getAttribute('data-' + prop);
    if (attr != null && attr !== '') {
      const n = parseFloat(attr);
      if (isFinite(n)) return n;
    }
    const inline = inlineDeclsOf(cur);
    const v = inline[prop];
    if (v) {
      const n = parseFloat(v);
      if (isFinite(n)) return n;
    }
  }
  return fallback;
}

const ZERO_RECT = { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
function rectOfShim(el) {
  if (!el || shimHiddenByAncestor(el)) return ZERO_RECT;
  const left = shimLayoutNumber(el, 'left', 0);
  const top = shimLayoutNumber(el, 'top', 0);
  const width = shimLayoutNumber(el, 'width', 220);
  const height = shimLayoutNumber(el, 'height', 32);
  return { left: left, top: top, width: width, height: height, right: left + width, bottom: top + height };
}

function innerTextOf(node) {
  let out = '';
  const walk = (cur) => {
    if (cur.nodeType === 3) {
      out += cur.data;
      return;
    }
    const tag = cur.tagName ? cur.tagName.toLowerCase() : '';
    if (tag === 'script' || tag === 'style') return;
    const block = BLOCK_TAGS.has(tag);
    if (block) out += '\n';
    for (const child of cur.childNodes) walk(child);
    if (block) out += '\n';
  };
  walk(node);
  return out;
}

function parseAttributes(raw) {
  const attrs = Object.create(null);
  const re = /([^\s=/>]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m;
  while ((m = re.exec(raw))) {
    const name = m[1];
    if (!name || name === '/') continue;
    attrs[name] = m[3] != null ? m[3] : m[4] != null ? m[4] : m[5] != null ? m[5] : '';
  }
  return attrs;
}

function findTagEnd(html, start) {
  let quote = '';
  for (let i = start + 1; i < html.length; i++) {
    const ch = html[i];
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i;
    }
  }
  return -1;
}

function parseHtml(html, ownerDocument) {
  const root = new ShimElement('#fragment');
  root.ownerDocument = ownerDocument;
  const stack = [root];
  let i = 0;
  const pushText = (text) => {
    if (!text) return;
    const node = new ShimText(text);
    node.parentElement = stack[stack.length - 1] === root ? null : stack[stack.length - 1];
    stack[stack.length - 1].childNodes.push(node);
  };
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      pushText(html.slice(i));
      break;
    }
    if (lt > i) pushText(html.slice(i, lt));
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith('<!', lt) || html.startsWith('<?', lt)) {
      const end = html.indexOf('>', lt);
      i = end < 0 ? html.length : end + 1;
      continue;
    }
    const end = findTagEnd(html, lt);
    if (end < 0) {
      pushText(html.slice(lt));
      break;
    }
    const tagText = html.slice(lt, end + 1);
    i = end + 1;
    const closing = /^<\/\s*([a-zA-Z0-9:-]+)\s*>$/.exec(tagText);
    if (closing) {
      const name = closing[1].toLowerCase();
      for (let s = stack.length - 1; s > 0; s--) {
        if (stack[s].tagName.toLowerCase() === name) {
          stack.length = s;
          break;
        }
      }
      continue;
    }
    const m = /^<\s*([a-zA-Z0-9:-]+)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>$/.exec(tagText);
    if (!m) {
      pushText(tagText);
      continue;
    }
    const tag = m[1].toLowerCase();
    const el = new ShimElement(tag);
    el.ownerDocument = ownerDocument;
    el.attributes = parseAttributes(m[2] || '');
    const parent = stack[stack.length - 1];
    el.parentElement = parent === root ? null : parent;
    parent.childNodes.push(el);
    if (tag === 'script' || tag === 'style') {
      const closeRe = new RegExp('</\\s*' + tag + '\\s*>', 'i');
      const closeIdx = html.slice(i).search(closeRe);
      if (closeIdx < 0) {
        i = html.length;
      } else {
        if (tag === 'style') {
          const text = new ShimText(html.slice(i, i + closeIdx));
          text.parentElement = el;
          el.childNodes.push(text);
        }
        i += closeIdx;
        const closeEnd = html.indexOf('>', i);
        i = closeEnd < 0 ? html.length : closeEnd + 1;
      }
      continue;
    }
    if (VOID_TAGS.has(tag) || m[3] === '/') continue;
    stack.push(el);
  }
  return root;
}

// ---------------- 极简选择器引擎（只覆盖 content.js 用到的语法） ----------------
const selectorCache = new Map();

function parseSimpleSelector(part) {
  const simple = { tag: null, ids: [], classes: [], attrs: [] };
  let rest = part;
  const tagMatch = /^([a-zA-Z][\w-]*|\*)/.exec(rest);
  if (tagMatch) {
    if (tagMatch[1] !== '*') simple.tag = tagMatch[1].toUpperCase();
    rest = rest.slice(tagMatch[0].length);
  }
  while (rest.length) {
    if (rest[0] === '#') {
      const m = /^#([\w-]+)/.exec(rest);
      if (!m) break;
      simple.ids.push(m[1]);
      rest = rest.slice(m[0].length);
    } else if (rest[0] === '.') {
      const m = /^\.([\w-]+)/.exec(rest);
      if (!m) break;
      simple.classes.push(m[1]);
      rest = rest.slice(m[0].length);
    } else if (rest[0] === '[') {
      const m = /^\[\s*([\w-]+)\s*(?:([*^$~|]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]*))\s*)?\]/.exec(rest);
      if (!m) break;
      simple.attrs.push({
        name: m[1],
        op: m[2] || '',
        value: m[3] != null ? m[3] : m[4] != null ? m[4] : m[5] != null ? m[5] : ''
      });
      rest = rest.slice(m[0].length);
    } else {
      break;
    }
  }
  return simple;
}

function parseSelector(selector) {
  const key = String(selector);
  if (selectorCache.has(key)) return selectorCache.get(key);
  const groups = key
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.split(/\s+/).filter(Boolean).map(parseSimpleSelector));
  selectorCache.set(key, groups);
  return groups;
}

function matchSimple(el, simple) {
  if (simple.tag && el.tagName !== simple.tag) return false;
  for (const id of simple.ids) if (el.id !== id) return false;
  if (simple.classes.length) {
    const classes = String(el.className).split(/\s+/).filter(Boolean);
    for (const cls of simple.classes) if (classes.indexOf(cls) < 0) return false;
  }
  for (const attr of simple.attrs) {
    const value = el.getAttribute(attr.name);
    if (value == null) return false;
    if (!attr.op) continue;
    if (attr.op === '=' && value !== attr.value) return false;
    if (attr.op === '*=' && value.indexOf(attr.value) < 0) return false;
    if (attr.op === '^=' && value.indexOf(attr.value) !== 0) return false;
    if (attr.op === '$=' && value.slice(-attr.value.length) !== attr.value) return false;
  }
  return true;
}

function matchComplex(el, parts) {
  if (!matchSimple(el, parts[parts.length - 1])) return false;
  let pi = parts.length - 2;
  let node = el.parentElement;
  while (pi >= 0) {
    let found = false;
    while (node) {
      if (matchSimple(node, parts[pi])) {
        found = true;
        node = node.parentElement;
        break;
      }
      node = node.parentElement;
    }
    if (!found) return false;
    pi -= 1;
  }
  return true;
}

function querySelectorAllIn(root, selector) {
  const groups = parseSelector(selector);
  const out = [];
  const visit = (el) => {
    for (const group of groups) {
      if (matchComplex(el, group)) {
        out.push(el);
        break;
      }
    }
    for (const child of el.children) visit(child);
  };
  for (const child of root.children) visit(child);
  return out;
}

class ShimDocument {
  constructor() {
    this.documentElement = null;
    this.body = null;
    this.head = null;
    this.title = '';
    this.cookie = '';
  }
  querySelectorAll(selector) {
    return this.documentElement ? querySelectorAllIn(this.documentElement, selector) : [];
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
  getElementById(id) {
    const found = this.querySelector('#' + id);
    return found || null;
  }
}

// ---------------- 用 mock-item.html 造出「页面 DOM」 ----------------
function buildMockPage(layout, sku) {
  const scriptStart = MOCK_SOURCE.indexOf('<script>');
  const scriptEnd = MOCK_SOURCE.indexOf('</script>', scriptStart);
  if (scriptStart < 0 || scriptEnd < 0) throw new Error('mock-item.html 里没有找到内联脚本');
  const mockScript = MOCK_SOURCE.slice(scriptStart + '<script>'.length, scriptEnd);

  const captured = { title: '', appHtml: '' };
  const bootstrapDoc = {
    title: '',
    documentElement: { setAttribute() {} },
    getElementById() {
      return {
        set innerHTML(value) {
          captured.appHtml = String(value);
        }
      };
    }
  };
  const search = '?layout=' + layout + '&sku=' + sku;
  const bootstrapContext = {
    window: {},
    document: bootstrapDoc,
    location: { href: 'file:///mock-item.html' + search, search: search, hostname: '', pathname: '/mock-item.html' },
    URLSearchParams
  };
  vm.runInNewContext(mockScript, bootstrapContext, { filename: 'mock-item.inline.js' });
  captured.title = bootstrapDoc.title || '';

  const document = new ShimDocument();
  const root = parseHtml(MOCK_SOURCE, document);
  const htmlEl = root.children.find((el) => el.tagName === 'HTML');
  if (!htmlEl) throw new Error('mock-item.html 解析失败：没有 <html>');
  document.documentElement = htmlEl;
  htmlEl.parentElement = null;
  document.head = htmlEl.querySelector('head');
  document.body = htmlEl.querySelector('body');
  document.title = captured.title;

  const app = htmlEl.querySelector('#app');
  if (!app) throw new Error('mock-item.html 里没有 #app 容器');
  app.childNodes = [];
  const appFragment = parseHtml(captured.appHtml, document);
  for (const node of appFragment.childNodes) {
    node.parentElement = app;
    app.childNodes.push(node);
  }
  return { document: document, title: captured.title };
}

// 用任意 body HTML 片段造页面（补充自检用：验证真实电商平台可能出现的变体，不影响 CDP 测试用例）
function buildDocumentFromBodyHtml(bodyHtml, title) {
  const document = new ShimDocument();
  const htmlEl = new ShimElement('html');
  htmlEl.ownerDocument = document;
  const head = new ShimElement('head');
  head.ownerDocument = document;
  head.parentElement = htmlEl;
  htmlEl.childNodes.push(head);
  const body = new ShimElement('body');
  body.ownerDocument = document;
  body.parentElement = htmlEl;
  htmlEl.childNodes.push(body);
  const frag = parseHtml(bodyHtml, document);
  for (const node of frag.childNodes) {
    node.parentElement = body;
    body.childNodes.push(node);
  }
  document.documentElement = htmlEl;
  document.head = head;
  document.body = body;
  document.title = title || '';
  return { document: document, title: title || '' };
}

// ---------------- 在模拟 DOM 上跑 content.js ----------------
// mockLocation：模拟真实电商平台 URL（content.js 的 detectRiskPage 用 window.__JD_MOCK_LOCATION__ 读取）
async function runContent(layout, sku, nochrome, mockLocation, afterRun) {
  return runOnPage(buildMockPage(layout, sku), sku, nochrome, mockLocation, afterRun);
}

async function runSynthetic(bodyHtml, title, sku, mockLocation, afterRun) {
  return runOnPage(buildDocumentFromBodyHtml(bodyHtml, title), sku, false, mockLocation, afterRun);
}

// 模拟工作台向 tab 发 PREVIEW_CAPTURE 消息，并收集同步 sendResponse 的快照
function requestPreview(listeners) {
  let response = null;
  for (const fn of (listeners || []).slice()) {
    try {
      fn({ type: 'PREVIEW_CAPTURE' }, {}, (r) => {
        response = r;
      });
    } catch (e) {
      // 忽略单个监听器异常
    }
  }
  return response;
}

// 直接改 shim DOM 的文本（模拟页面价格刷新用）
function setShimText(el, text) {
  if (!el) return;
  el.childNodes = [];
  const node = new ShimText(String(text));
  node.parentElement = el;
  el.childNodes.push(node);
}

async function runOnPage(page, sku, nochrome, mockLocation, afterRun) {
  const messages = [];
  const listeners = [];
  const win = {
    __JD_CAPTURE_FORCE__: true,
    __JD_CAPTURE_TUNING__: TUNING,
    innerHeight: 800,
    innerWidth: 1200,
    getComputedStyle: (el) => computedStyleOf(el)
  };
  if (mockLocation) {
    win.__JD_MOCK_LOCATION__ = mockLocation;
  }
  const fakeChrome = {
    runtime: {
      lastError: null,
      sendMessage(msg, callback) {
        messages.push(msg);
        if (typeof callback === 'function') {
          try {
            callback({});
          } catch (e) {
            // 忽略
          }
        }
      },
      onMessage: {
        addListener(fn) {
          if (listeners.indexOf(fn) < 0) listeners.push(fn);
        },
        removeListener(fn) {
          const i = listeners.indexOf(fn);
          if (i >= 0) listeners.splice(i, 1);
        }
      }
    }
  };
  const search = '?sku=' + sku;
  const sandbox = {
    window: win,
    document: page.document,
    location: {
      href: 'file:///mock-item.html' + search,
      search: search,
      hostname: '',
      pathname: '/mock-item.html'
    },
    setTimeout,
    clearTimeout,
    URLSearchParams
  };
  if (!nochrome) sandbox.chrome = fakeChrome;
  vm.createContext(sandbox);
  vm.runInContext(CONTENT_SOURCE, sandbox, { filename: 'content.js' });
  // 给用例一个「页面刚被注入后」的钩子：模拟价格二次刷新（必须在 content.js 第一次采样之后）
  if (typeof afterRun === 'function') {
    try {
      afterRun(page.document, win);
    } catch (e) {
      // 忽略钩子异常
    }
  }

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (messages.length) return { result: messages[0], messages: messages, win: win, listeners: listeners };
    const api = win.__jdMarketCapture;
    if (api && api.ready && api.lastResult) {
      return { result: api.lastResult, messages: messages, win: win, listeners: listeners };
    }
    await sleep(10);
  }
  throw new Error('等待 content.js 结果超时（sku ' + sku + '）');
}

// ---------------- 断言工具 ----------------
const results = { pass: 0, fail: 0, cases: [] };

function checkCase(name, fn) {
  return async () => {
    const record = { name: name, pass: 0, fail: 0, failures: [] };
    const t = {
      eq(label, actual, expected) {
        try {
          assert.deepEqual(actual, expected);
          record.pass += 1;
          results.pass += 1;
        } catch (e) {
          record.fail += 1;
          results.fail += 1;
          record.failures.push(label + '：期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual));
        }
      },
      ok(label, condition, detail) {
        if (condition) {
          record.pass += 1;
          results.pass += 1;
        } else {
          record.fail += 1;
          results.fail += 1;
          record.failures.push(label + (detail ? '：' + detail : ''));
        }
      }
    };
    try {
      await fn(t);
    } catch (e) {
      record.fail += 1;
      results.fail += 1;
      record.failures.push('用例异常：' + ((e && e.message) || e));
    }
    results.cases.push(record);
    console.log((record.fail === 0 ? '✓ ' : '✗ ') + name + '（' + record.pass + '/' + (record.pass + record.fail) + '）');
    for (const f of record.failures) console.error('    ✗ ' + f);
  };
}

// ---------------- 用例 ----------------
const CASES = [
  checkCase('hand：到手价 + 电商平台价 + 规格表尺寸优先', async (t) => {
    const { result: r } = await runContent('hand', '100200174986');
    t.eq('ok', r.ok, true);
    t.eq('hand.price', r.hand && r.hand.price, 5499);
    t.eq('main.price', r.main && r.main.price, 5999);
    t.eq('size.inch', r.size && r.size.inch, 75);
    t.eq('size.source（v2.1.6：规格表优先）', r.size && r.size.source, 'spec');
    t.eq('sizeUncertain', r.sizeUncertain, false);
    t.eq('pricePick.kind', r.pricePick && r.pricePick.kind, 'hand');
    const noise = (r.candidates || []).filter((c) => !c.suspect && [7999, 300, 5000, 200].indexOf(c.price) >= 0);
    t.eq('干扰项没有进入可用候选', noise.length, 0);
  }),
  checkCase('main：只有电商平台价', async (t) => {
    const { result: r } = await runContent('main', '100200174987');
    t.eq('ok', r.ok, true);
    t.eq('main.price', r.main && r.main.price, 4299);
    t.eq('hand', r.hand, null);
    t.eq('size.source（规格表优先）', r.size && r.size.source, 'spec');
    t.eq('sizeUncertain', r.sizeUncertain, false);
  }),
  checkCase('plus：PLUS 会员价', async (t) => {
    const { result: r } = await runContent('plus', '100200174988');
    t.eq('ok', r.ok, true);
    t.eq('main.price', r.main && r.main.price, 12999);
    t.eq('plus.price', r.plus && r.plus.price, 11899);
    t.eq('flags.plusText', r.flags && r.flags.plusText, true);
  }),
  checkCase('spec：尺寸只在规格参数表', async (t) => {
    const { result: r } = await runContent('spec', '100200174989');
    t.eq('size.inch', r.size && r.size.inch, 86);
    t.eq('size.source', r.size && r.size.source, 'spec');
  }),
  checkCase('alt：尺寸只在主图 alt', async (t) => {
    const { result: r } = await runContent('alt', '100200174990');
    t.eq('size.inch', r.size && r.size.inch, 100);
    t.eq('size.source', r.size && r.size.source, 'alt');
  }),
  checkCase('doctitle：尺寸只在 document.title', async (t) => {
    const { result: r } = await runContent('doctitle', '100200174991');
    t.eq('size.inch', r.size && r.size.inch, 98);
    t.eq('size.source', r.size && r.size.source, 'doc-title');
  }),
  checkCase('verify：安全验证给出明确 reason', async (t) => {
    const { result: r } = await runContent('verify', '100200174992');
    t.eq('ok', r.ok, false);
    t.eq('flags.verify', r.flags && r.flags.verify, true);
    t.ok('reason 含「安全验证」', /安全验证/.test(r.reason || ''), r.reason);
    t.eq('main', r.main, null);
  }),
  checkCase('offsale：已下架给出明确 reason', async (t) => {
    const { result: r } = await runContent('offsale', '100200174993');
    t.eq('ok', r.ok, false);
    t.eq('flags.offSale', r.flags && r.flags.offSale, true);
    t.ok('reason 含「下架」', /下架/.test(r.reason || ''), r.reason);
  }),
  checkCase('fragment：数字片段不当作价格', async (t) => {
    const { result: r } = await runContent('fragment', '100200174994');
    t.eq('ok', r.ok, false);
    t.eq('flags.priceFragment', r.flags && r.flags.priceFragment, true);
    t.ok('reason 含「疑似」', /疑似/.test(r.reason || ''), r.reason);
    t.eq('pricePick', r.pricePick, null);
    const usable = (r.candidates || []).filter((c) => !c.suspect);
    t.eq('没有可用价格候选', usable.length, 0);
  }),
  checkCase('PING：确认页面脚本存活', async (t) => {
    const { listeners, result: r } = await runContent('hand', '100200174995');
    t.eq('ok', r.ok, true);
    let pong = null;
    for (const fn of listeners) fn({ type: 'PING' }, {}, (resp) => (pong = resp));
    t.ok('PING 有响应', !!pong);
    if (pong) {
      t.eq('PING.ok', pong.ok, true);
      t.eq('PING.sku', pong.sku, '100200174995');
    }
  }),
  checkCase('无 chrome 环境不抛错、仍能算出价格', async (t) => {
    const { result: r, messages } = await runContent('hand', '100200174996', true);
    t.eq('没有发出 sendMessage', messages.length, 0);
    t.eq('ok', r && r.ok, true);
    t.eq('main.price', r && r.main && r.main.price, 5999);
    t.eq('size.inch', r && r.size && r.size.inch, 75);
  }),

  // ---- 以下为合成页面补充用例：覆盖真实电商平台可能出现、但 mock 页没有单独布局的情况 ----
  checkCase('合成：标题「86吋」变体 + 只有电商平台价', async (t) => {
    const body = `
      <div class="itemInfo-wrap">
        <div class="sku-name" id="name"><h1 class="sku-name">TCL 86吋 会议平板电视 智能会议一体机</h1></div>
        <div class="summary-price-wrap" id="price"><div class="summary-price">
          <div class="p-price"><span class="price-label">电商平台价</span><span class="price J-p-1">￥12999.00</span></div>
        </div></div>
      </div>`;
    const { result: r } = await runSynthetic(body, '【TCL86V6】TCL 86吋 会议平板-电商平台', '100200175001');
    t.eq('ok', r.ok, true);
    t.eq('main.price', r.main && r.main.price, 12999);
    t.eq('size.inch（86吋）', r.size && r.size.inch, 86);
    t.eq('size.source', r.size && r.size.source, 'title');
  }),
  checkCase('合成：标题干扰数字（4K/1920×1080）不影响取英寸', async (t) => {
    const body = `
      <div class="itemInfo-wrap">
        <div class="sku-name" id="name"><h1 class="sku-name">海信 4K 1920×1080 75英寸 会议平板电视</h1></div>
        <div class="summary-price-wrap" id="price"><div class="summary-price">
          <div class="p-price"><span class="price-label">电商平台价</span><span class="price">￥5999.00</span></div>
        </div></div>
      </div>`;
    const { result: r } = await runSynthetic(body, '海信 75英寸 会议平板-电商平台', '100200175002');
    t.eq('size.inch', r.size && r.size.inch, 75);
  }),
  checkCase('合成：产品尺寸只有 mm 三围时不反推英寸（size=null）', async (t) => {
    const body = `
      <div class="itemInfo-wrap">
        <div class="sku-name" id="name"><h1 class="sku-name">品牌B 智能会议平板 4K超高清 无线传屏 V6</h1></div>
        <div class="summary-price-wrap" id="price"><div class="summary-price">
          <div class="p-price"><span class="price-label">电商平台价</span><span class="price">￥12999.00</span></div>
        </div></div>
      </div>
      <div class="p-parameter"><ul class="parameter2 p-parameter-list">
        <li>品牌：品牌B</li>
        <li>产品尺寸：1668×1010×88mm</li>
        <li>接口：HDMI×2</li>
      </ul></div>`;
    const { result: r } = await runSynthetic(body, '品牌B 智能会议平板-电商平台', '100200175003');
    t.eq('ok', r.ok, true);
    t.eq('size（不反推 mm 三围）', r.size, null);
  }),
  checkCase('合成：规格表「屏幕尺寸：75」无单位纯数字', async (t) => {
    const body = `
      <div class="itemInfo-wrap">
        <div class="sku-name" id="name"><h1 class="sku-name">海信 智能会议平板 4K超高清</h1></div>
        <div class="summary-price-wrap" id="price"><div class="summary-price">
          <div class="p-price"><span class="price-label">电商平台价</span><span class="price">￥8999.00</span></div>
        </div></div>
      </div>
      <div class="p-parameter"><ul class="parameter2 p-parameter-list">
        <li>品牌：海信</li>
        <li>屏幕尺寸：75</li>
      </ul></div>`;
    const { result: r } = await runSynthetic(body, '海信 智能会议平板-电商平台', '100200175004');
    t.eq('size.inch', r.size && r.size.inch, 75);
    t.eq('size.source', r.size && r.size.source, 'spec');
  }),
  checkCase('合成：只有到手价时 main 为空但 ok=true', async (t) => {
    const body = `
      <div class="itemInfo-wrap">
        <div class="sku-name" id="name"><h1 class="sku-name">海信 65英寸 会议平板</h1></div>
        <div class="summary-price-wrap" id="price"><div class="summary-price">
          <div class="p-price p-hand-price"><span class="price-label">预估到手价</span>
            <span class="price hand-price">￥5499.00</span></div>
        </div></div>
      </div>`;
    const { result: r } = await runSynthetic(body, '海信 65英寸 会议平板-电商平台', '100200175005');
    t.eq('ok', r.ok, true);
    t.eq('hand.price', r.hand && r.hand.price, 5499);
    t.eq('main（页面没有电商平台价）', r.main, null);
    t.eq('pricePick.kind', r.pricePick && r.pricePick.kind, 'hand');
  }),
  checkCase('合成：带货币符号的低价片段（￥5）也要给「低于合理下限」reason', async (t) => {
    const body = `
      <div class="itemInfo-wrap">
        <div class="sku-name" id="name"><h1 class="sku-name">海信 75英寸 会议平板</h1></div>
        <div class="summary-price-wrap" id="price"><div class="summary-price">
          <div class="p-price"><span class="price-label">到手价</span><span class="price">￥5</span></div>
        </div></div>
      </div>`;
    const { result: r } = await runSynthetic(body, '海信 75英寸 会议平板-电商平台', '100200175006');
    t.eq('ok', r.ok, false);
    t.eq('flags.priceFragment', r.flags && r.flags.priceFragment, true);
    t.ok('reason 含「低于合理下限」', /低于合理下限/.test(r.reason || ''), r.reason);
    t.eq('pricePick', r.pricePick, null);
  }),
  checkCase('合成：划线原价不参与选价', async (t) => {
    const body = `
      <div class="itemInfo-wrap">
        <div class="sku-name" id="name"><h1 class="sku-name">海信 75英寸 会议平板</h1></div>
        <div class="summary-price-wrap" id="price"><div class="summary-price">
          <div class="p-price"><span class="price-label">电商平台价</span><span class="price">￥5999.00</span></div>
          <div class="origin-price"><del>￥7999.00</del></div>
        </div></div>
      </div>`;
    const { result: r } = await runSynthetic(body, '海信 75英寸 会议平板-电商平台', '100200175007');
    t.eq('main.price', r.main && r.main.price, 5999);
    const struck = (r.candidates || []).filter((c) => !c.suspect && c.price === 7999);
    t.eq('划线原价不在可用候选里', struck.length, 0);
  }),

  // ---- v2.1 新增布局（取价加固 / 型号套餐） ----
  checkCase('v2.1 布局 strikelabel：del + line-through 划线价不被选中', async (t) => {
    const { result: r } = await runContent('strikelabel', '100200175011');
    t.eq('ok', r.ok, true);
    t.eq('main.price', r.main && r.main.price, 5999);
    t.eq('hand.price', r.hand && r.hand.price, 5499);
    t.eq('pricePick', r.pricePick && r.pricePick.price, 5499);
    const struck = (r.candidates || []).filter((c) => !c.suspect && [7999, 8199].indexOf(c.price) >= 0);
    t.eq('划线价（del / line-through）不在可用候选里', struck.length, 0);
  }),
  checkCase('v2.1 布局 mainlabel：只有电商平台价标签，靠精准标签法命中', async (t) => {
    const { result: r } = await runContent('mainlabel', '100200175012');
    t.eq('ok', r.ok, true);
    t.eq('main.price', r.main && r.main.price, 4299);
    t.eq('size.inch', r.size && r.size.inch, 65);
  }),
  checkCase('v2.1 布局 crosscheck：到手价高于电商平台价时丢弃 hand', async (t) => {
    const { result: r } = await runContent('crosscheck', '100200175013');
    t.eq('ok', r.ok, true);
    t.eq('main.price', r.main && r.main.price, 5999);
    t.eq('hand（高于 main×1.02 被丢弃）', r.hand, null);
    t.eq('pricePick.price', r.pricePick && r.pricePick.price, 5999);
  }),
  checkCase('v2.1 布局 modelpackage：规格表提取型号，套餐不再从参数表兜底', async (t) => {
    const { result: r } = await runContent('modelpackage', '100200175014');
    t.eq('ok', r.ok, true);
    t.eq('model', r.model, 'MC75HEE');
    t.eq('modelSource', r.modelSource, 'spec');
    t.eq('package（v2.1.3：只认选购区已选项，参数表「套餐」行不算）', r.package, '');
    t.eq('packageSource', r.packageSource, '');
    t.eq('size.inch', r.size && r.size.inch, 75);
  }),
  checkCase('v2.1 布局 titlemodel：标题提取型号，套餐不再从标题兜底', async (t) => {
    const { result: r } = await runContent('titlemodel', '100200175015');
    t.eq('ok', r.ok, true);
    t.eq('model', r.model, 'MC86HE');
    t.eq('modelSource', r.modelSource, 'title');
    t.eq('package（v2.1.3：标题内存规格不算套餐）', r.package, '');
    t.eq('packageSource', r.packageSource, '');
    t.eq('main.price', r.main && r.main.price, 12999);
  }),

  // ---- v2.1.3：商品页规格选择区（系列品 / 屏幕尺寸 / 版本）----
  checkCase('v2.1.3 布局 variantpanel：版本组已选项=套餐，屏幕尺寸组=尺寸', async (t) => {
    const { result: r } = await runContent('variantpanel', '100200175021');
    t.eq('ok', r.ok, true);
    t.eq('hand.price', r.hand && r.hand.price, 11969);
    t.eq('main.price', r.main && r.main.price, 11999);
    t.eq('pricePick.price', r.pricePick && r.pricePick.price, 11969);
    t.eq('size.inch', r.size && r.size.inch, 100);
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
  }),
  checkCase('v2.1.3 无规格选择区的页面：套餐/specGroups 回退空', async (t) => {
    const { result: r } = await runContent('hand', '100200175022');
    t.eq('ok', r.ok, true);
    t.eq('package', r.package, '');
    t.eq('packageGroup', r.packageGroup, '');
    t.eq('packageSource', r.packageSource, '');
    t.eq('specGroups', (r.specGroups || []).length, 0);
  }),
  checkCase('v2.1.3 合成：标题英寸被规格选择区覆盖（variant 优先于标题）', async (t) => {
    const body = `
      <div class="itemInfo-wrap">
        <div class="sku-name" id="name"><h1 class="sku-name">海信 75英寸 会议平板电视 100XP3E-PRO</h1></div>
        <div class="summary-price-wrap" id="price"><div class="summary-price">
          <div class="p-price"><span class="price-label">电商平台价</span><span class="price">￥11999.00</span></div>
          <div class="p-price p-hand-price"><span class="price-label">预估到手价</span>
            <span class="price hand-price">￥11969.00</span></div>
        </div></div>
        <div id="choose-attrs" class="choose-attrs">
          <div class="li-group"><div class="li-label">屏幕尺寸</div>
            <div class="li-items"><span class="li-item selected">100英寸 【会议新物种 无线C位屏】</span></div>
          </div>
        </div>
      </div>`;
    const { result: r } = await runSynthetic(body, '海信 100英寸 会议平板-电商平台', '100200175023');
    t.eq('size.inch（选购区 100 覆盖标题 75）', r.size && r.size.inch, 100);
    t.eq('size.source', r.size && r.size.source, 'variant');
  }),
  checkCase('v2.1.3 合成：规格参数表优先于规格选择区（spec > variant）', async (t) => {
    const body = `
      <div class="itemInfo-wrap">
        <div class="sku-name" id="name"><h1 class="sku-name">海信 会议平板电视 100XP3E-PRO</h1></div>
        <div class="summary-price-wrap" id="price"><div class="summary-price">
          <div class="p-price"><span class="price-label">电商平台价</span><span class="price">￥11999.00</span></div>
        </div></div>
        <div id="choose-attrs" class="choose-attrs">
          <div class="li-group"><div class="li-label">屏幕尺寸</div>
            <div class="li-items"><span class="li-item selected">100英寸 【会议新物种】</span></div>
          </div>
        </div>
      </div>
      <div class="p-parameter"><ul class="parameter2 p-parameter-list">
        <li>品牌：海信</li>
        <li>屏幕尺寸：86英寸</li>
      </ul></div>`;
    const { result: r } = await runSynthetic(body, '海信 会议平板-电商平台', '100200175024');
    t.eq('size.inch（参数表 86 优先）', r.size && r.size.inch, 86);
    t.eq('size.source', r.size && r.size.source, 'spec');
  }),
  checkCase('v2.1.3 合成：aria-selected 判定选中项 + 【】完整保留', async (t) => {
    const body = `
      <div class="itemInfo-wrap">
        <div class="sku-name" id="name"><h1 class="sku-name">海信 会议平板电视 100XP3E-PRO</h1></div>
        <div class="summary-price-wrap" id="price"><div class="summary-price">
          <div class="p-price"><span class="price-label">电商平台价</span><span class="price">￥11999.00</span></div>
        </div></div>
        <div id="choose-attrs" class="choose-attrs">
          <div class="li-group"><div class="li-label">套餐</div><div class="li-items">
            <span class="li-item" aria-selected="false">会议大屏+摄像头+推车【免费送装一体】</span>
            <span class="li-item" aria-selected="true">已选：会议大屏+摄像头+投屏器【免费送装一体】 ▼</span>
          </div></div>
        </div>
      </div>`;
    const { result: r } = await runSynthetic(body, '海信 会议平板-电商平台', '100200175025');
    t.eq('package（去「已选：」前缀与箭头）', r.package, '会议大屏+摄像头+投屏器【免费送装一体】');
    t.eq('packageGroup', r.packageGroup, '套餐');
    const g = (r.specGroups || [])[0];
    t.eq('选中判定来源', g && g.source, 'aria');
  }),

  // ---- v2.1.4/v2.1.5：落地页三分类（下架 / 软异常 / 风控）+ 预览快照 ----
  checkCase('v2.1.5 软异常：跳电商平台首页（无验证特征）→ softAnomaly 非 risk，等待自动继续', async (t) => {
    const { result: r, listeners, win } = await runContent('riskhome', '100200175031', false, {
      href: 'https://www.shop.example.com/',
      hostname: 'www.shop.example.com',
      pathname: '/',
      search: ''
    });
    t.eq('ok', r.ok, false);
    t.eq('pageKind', r.pageKind, 'softAnomaly');
    t.eq('softAnomaly', r.softAnomaly, true);
    t.eq('risk.hit（跳首页不再算风控）', r.risk && r.risk.hit, false);
    // 旧 detectRiskPage() 兼容：跳首页不再算 risk
    const compat = win.__jdMarketCapture.detectRiskPage();
    t.eq('detectRiskPage 兼容：跳首页 hit', compat.hit, false);
    t.eq('detectPageState 可直接调用', win.__jdMarketCapture.detectPageState().kind, 'softAnomaly');
    t.eq('anomaly.reason', r.anomaly && r.anomaly.reason, 'home');
    t.ok('anomaly.url 含 www.shop.example.com', String((r.anomaly && r.anomaly.url) || '').indexOf('www.shop.example.com') >= 0);
    t.ok('reason 含「跳转」或「首页」', /跳转|首页/.test(String(r.reason || '')), r.reason);
    t.eq('previewable', r.previewable, false);
    t.eq('main（不解析价格）', r.main, null);
    t.eq('pricePick（不解析价格）', r.pricePick, null);
    t.eq('hand', r.hand, null);
    t.eq('size（不解析尺寸）', r.size, null);
    t.eq('package', r.package, '');
    t.eq('specGroups', (r.specGroups || []).length, 0);
    // 预览通道在软异常页也应返回 softAnomaly，而不是把首页当商品
    const preview = requestPreview(listeners);
    t.ok('PREVIEW_CAPTURE 有响应', !!preview);
    t.eq('预览 ok', preview && preview.ok, false);
    t.eq('预览 pageKind', preview && preview.pageKind, 'softAnomaly');
    t.eq('预览 softAnomaly', preview && preview.softAnomaly, true);
    t.eq('预览 risk.hit', preview && preview.risk && preview.risk.hit, false);
    t.eq('预览 price', preview && preview.price, null);
  }),
  checkCase('v2.1.5 下架页：offSale=true 且不算风控、不解析价格', async (t) => {
    const { result: r, listeners } = await runContent('offsale', '100200175036');
    t.eq('ok', r.ok, false);
    t.eq('pageKind', r.pageKind, 'offSale');
    t.eq('offSale', r.offSale, true);
    t.eq('softAnomaly', r.softAnomaly, false);
    t.eq('risk.hit（下架不算风控）', r.risk && r.risk.hit, false);
    t.eq('flags.offSale（兼容旧字段）', r.flags && r.flags.offSale, true);
    t.ok('reason 含「已下架」/「下架」', /下架/.test(String(r.reason || '')), r.reason);
    t.eq('main', r.main, null);
    t.eq('size', r.size, null);
    t.eq('package', r.package, '');
    const preview = requestPreview(listeners);
    t.eq('预览 offSale', preview && preview.offSale, true);
    t.eq('预览 risk.hit', preview && preview.risk && preview.risk.hit, false);
  }),
  checkCase('v2.1.5 软异常：空页面 → softAnomaly reason=empty', async (t) => {
    const { result: r } = await runSynthetic('<div></div>', '电商平台-加载中', '100200175037');
    t.eq('ok', r.ok, false);
    t.eq('pageKind', r.pageKind, 'softAnomaly');
    t.eq('softAnomaly', r.softAnomaly, true);
    t.eq('anomaly.reason', r.anomaly && r.anomaly.reason, 'empty');
    t.eq('risk.hit', r.risk && r.risk.hit, false);
    t.eq('main', r.main, null);
  }),
  checkCase('v2.1.5 跳首页 + 验证文案 → risk（验证特征优先于软异常）', async (t) => {
    const { result: r } = await runSynthetic(
      '<div class="home-page"><h2>安全验证</h2><p>请完成验证后继续访问</p></div>',
      '安全验证 - 电商平台',
      '100200175038',
      { href: 'https://www.shop.example.com/', hostname: 'www.shop.example.com', pathname: '/', search: '' }
    );
    t.eq('ok', r.ok, false);
    t.eq('pageKind', r.pageKind, 'risk');
    t.eq('risk.hit', r.risk && r.risk.hit, true);
    t.eq('risk.reason', r.risk && r.risk.reason, 'verify');
    t.eq('softAnomaly', r.softAnomaly, false);
    t.eq('main', r.main, null);
  }),
  checkCase('v2.1.4 风控落地页：安全验证页 → risk.reason=verify 且不解析价格', async (t) => {
    const { result: r, win } = await runContent('verify', '100200175032');
    t.eq('ok', r.ok, false);
    t.eq('pageKind', r.pageKind, 'risk');
    t.eq('risk.hit', r.risk && r.risk.hit, true);
    t.eq('risk.reason', r.risk && r.risk.reason, 'verify');
    const compat = win.__jdMarketCapture.detectRiskPage();
    t.eq('detectRiskPage 兼容：验证页 hit', compat.hit, true);
    t.eq('detectRiskPage 兼容：reason', compat.reason, 'verify');
    t.eq('flags.verify（兼容旧字段）', r.flags && r.flags.verify, true);
    t.ok('reason 含「安全验证」', String(r.reason || '').indexOf('安全验证') >= 0, r.reason);
    t.eq('size', r.size, null);
    t.eq('main', r.main, null);
  }),
  checkCase('v2.1.4 风控落地页：登录页（passport.shop.example.com）→ risk.reason=login', async (t) => {
    const body = `
      <div class="login-page">
        <h2>电商平台登录</h2>
        <p>欢迎登录电商平台，请使用手机号或扫码登录</p>
        <input placeholder="手机号/用户名">
        <button>登录</button>
      </div>`;
    const { result: r } = await runSynthetic(body, '电商平台登录 - 电商平台', '100200175033', {
      href: 'https://passport.shop.example.com/new/login.aspx',
      hostname: 'passport.shop.example.com',
      pathname: '/new/login.aspx',
      search: ''
    });
    t.eq('ok', r.ok, false);
    t.eq('pageKind', r.pageKind, 'risk');
    t.eq('risk.hit', r.risk && r.risk.hit, true);
    t.eq('risk.reason', r.risk && r.risk.reason, 'login');
    t.ok('reason 含「登录」', String(r.reason || '').indexOf('登录') >= 0, r.reason);
    t.eq('main', r.main, null);
    t.eq('size', r.size, null);
  }),
  checkCase('v2.1.5 正常商品页：pageKind=item + risk.hit=false + previewable=true', async (t) => {
    const { result: r } = await runContent('hand', '100200175034');
    t.eq('ok', r.ok, true);
    t.eq('pageKind', r.pageKind, 'item');
    t.eq('offSale', r.offSale, false);
    t.eq('softAnomaly', r.softAnomaly, false);
    t.eq('risk.hit', r.risk && r.risk.hit, false);
    t.eq('risk.reason', r.risk && r.risk.reason, '');
    t.eq('previewable', r.previewable, true);
    t.eq('hand.price 不受影响', r.hand && r.hand.price, 5499);
  }),
  checkCase('v2.1.5 预览快照：PREVIEW_CAPTURE → PREVIEW_CAPTURE_RESULT（价格/尺寸/套餐/specGroups）', async (t) => {
    const { listeners } = await runContent('variantpanel', '100200175021');
    const preview = requestPreview(listeners);
    t.ok('有响应', !!preview);
    t.eq('type', preview && preview.type, 'PREVIEW_CAPTURE_RESULT');
    t.eq('version', preview && preview.version, '2.1.7');
    t.eq('pageKind', preview && preview.pageKind, 'item');
    t.eq('ok', preview && preview.ok, true);
    t.eq('sizeUncertain', preview && preview.sizeUncertain, false);
    t.eq('price', preview && preview.price, 11969);
    t.eq('priceKind', preview && preview.priceKind, 'hand');
    t.eq('prices.hand', preview && preview.prices && preview.prices.hand, 11969);
    t.eq('prices.main', preview && preview.prices && preview.prices.main, 11999);
    t.eq('size.inch', preview && preview.size && preview.size.inch, 100);
    t.eq('size.source（variant）', preview && preview.size && preview.size.source, 'variant');
    t.eq('package', preview && preview.package, '会议大屏+摄像头【免费送装一体】');
    t.eq('packageGroup', preview && preview.packageGroup, '版本');
    t.eq('specGroups 组数', ((preview && preview.specGroups) || []).length, 4);
    t.eq('offSale', preview && preview.offSale, false);
    t.eq('softAnomaly', preview && preview.softAnomaly, false);
    t.eq('risk.hit', preview && preview.risk && preview.risk.hit, false);
    t.eq('preview 标记', preview && preview.preview, true);
  }),
  checkCase('v2.1.4 预览快照：无 chrome.runtime 时不抛错、不注册监听', async (t) => {
    const { result: r, listeners } = await runContent('hand', '100200175035', true);
    t.eq('ok', r.ok, true);
    t.eq('listeners（无 chrome 时为空）', (listeners || []).length, 0);
    t.eq('PREVIEW_CAPTURE 无监听器可响应', requestPreview(listeners), null);
  }),

  // ---- v2.1.6：尺寸严格识别（名称多值必空置）+ 价格只认 DOM ----
  checkCase('v2.1.6 尺寸：规格表 65 优先于标题里的型号数字/多值名称', async (t) => {
    const body = `
      <div class="itemInfo-wrap">
        <div class="sku-name" id="name"><h1 class="sku-name">海信 VH75CAD 55/65英寸 75MBK7 会议平板电视</h1></div>
        <div class="summary-price-wrap" id="price"><div class="summary-price">
          <div class="p-price"><span class="price-label">电商平台价</span><span class="price">￥8999.00</span></div>
        </div></div>
      </div>
      <div class="p-parameter"><ul class="parameter2 p-parameter-list">
        <li>品牌：海信</li>
        <li>屏幕尺寸：65英寸</li>
        <li>产品尺寸：1668×1010×88mm</li>
      </ul></div>`;
    const { result: r } = await runSynthetic(body, '海信 VH75CAD 55/65英寸 会议平板-电商平台', '100200175041');
    t.eq('ok', r.ok, true);
    t.eq('size.inch（规格表 65 优先）', r.size && r.size.inch, 65);
    t.eq('size.source', r.size && r.size.source, 'spec');
    t.eq('sizeUncertain', r.sizeUncertain, false);
  }),
  checkCase('v2.1.6 尺寸：标题「55/65英寸」多值 → 不采用，null+sizeUncertain', async (t) => {
    const body = `
      <div class="itemInfo-wrap">
        <div class="sku-name" id="name"><h1 class="sku-name">海信 55/65英寸 会议平板电视 智能会议一体机</h1></div>
        <div class="summary-price-wrap" id="price"><div class="summary-price">
          <div class="p-price"><span class="price-label">电商平台价</span><span class="price">￥6999.00</span></div>
        </div></div>
      </div>`;
    const { result: r, listeners } = await runSynthetic(
      body,
      '海信 55/65英寸 会议平板-电商平台',
      '100200175042'
    );
    t.eq('ok（价格仍来自页面）', r.ok, true);
    t.eq('main.price', r.main && r.main.price, 6999);
    t.eq('size（多值不采用）', r.size, null);
    t.eq('sizeUncertain', r.sizeUncertain, true);
    t.ok('sizeReason 含「多个尺寸」', /多个尺寸/.test(String(r.sizeReason || '')), r.sizeReason);
    const preview = requestPreview(listeners);
    t.eq('预览 size', preview && preview.size, null);
    t.eq('预览 sizeUncertain', preview && preview.sizeUncertain, true);
    t.ok('预览 sizeReason 含「多个尺寸」', /多个尺寸/.test(String((preview && preview.sizeReason) || '')));
  }),
  checkCase('v2.1.6 尺寸：标题「75MBK7 会议平板」无明确单位 → 不把 75 当尺寸', async (t) => {
    const body = `
      <div class="itemInfo-wrap">
        <div class="sku-name" id="name"><h1 class="sku-name">海信 75MBK7 VH75CAD 会议平板电视</h1></div>
        <div class="summary-price-wrap" id="price"><div class="summary-price">
          <div class="p-price"><span class="price-label">电商平台价</span><span class="price">￥8999.00</span></div>
        </div></div>
      </div>`;
    const { result: r } = await runSynthetic(body, '海信 75MBK7 会议平板-电商平台', '100200175043');
    t.eq('ok', r.ok, true);
    t.eq('size（型号数字不作尺寸）', r.size, null);
    t.eq('sizeUncertain', r.sizeUncertain, true);
    t.ok('sizeReason 含「未识别到明确尺寸」', /未识别到明确尺寸/.test(String(r.sizeReason || '')), r.sizeReason);
  }),
  checkCase('v2.1.6 尺寸：标题「65英寸」唯一明确 → 采用（source=title）', async (t) => {
    const body = `
      <div class="itemInfo-wrap">
        <div class="sku-name" id="name"><h1 class="sku-name">海信 65英寸 会议平板电视 智能会议一体机</h1></div>
        <div class="summary-price-wrap" id="price"><div class="summary-price">
          <div class="p-price"><span class="price-label">电商平台价</span><span class="price">￥6999.00</span></div>
        </div></div>
      </div>`;
    const { result: r } = await runSynthetic(body, '海信 65英寸 会议平板-电商平台', '100200175044');
    t.eq('size.inch', r.size && r.size.inch, 65);
    t.eq('size.source', r.size && r.size.source, 'title');
    t.eq('sizeUncertain', r.sizeUncertain, false);
  }),
  checkCase('v2.1.6 尺寸：document.title 多值 → 不采用（null+uncertain）', async (t) => {
    const body = `
      <div class="itemInfo-wrap">
        <div class="sku-name" id="name"><h1 class="sku-name">海信 智能会议平板电视 4K超高清</h1></div>
        <div class="summary-price-wrap" id="price"><div class="summary-price">
          <div class="p-price"><span class="price-label">电商平台价</span><span class="price">￥9999.00</span></div>
        </div></div>
      </div>`;
    const { result: r } = await runSynthetic(body, '海信 55/65英寸 会议平板-电商平台', '100200175045');
    t.eq('size', r.size, null);
    t.eq('sizeUncertain', r.sizeUncertain, true);
    t.ok('sizeReason 含「多个尺寸」', /多个尺寸/.test(String(r.sizeReason || '')), r.sizeReason);
  }),
  checkCase('v2.1.6 价格只认 DOM：标题含「5000元」不产生价格', async (t) => {
    const body = `
      <div class="itemInfo-wrap">
        <div class="sku-name" id="name"><h1 class="sku-name">海信 65英寸 会议平板电视 5000元 特惠</h1></div>
        <div class="p-parameter"><ul class="parameter2 p-parameter-list"><li>品牌：海信</li></ul></div>
      </div>`;
    const { result: r } = await runSynthetic(body, '海信 65英寸 会议平板 5000元-电商平台', '100200175046');
    t.eq('ok（无 DOM 价格不猜）', r.ok, false);
    t.eq('main', r.main, null);
    t.eq('pricePick', r.pricePick, null);
    const noTitlePrice = (r.candidates || []).filter((c) => Number(c.price) === 5000);
    t.eq('标题里的 5000 没有变成价格候选', noTitlePrice.length, 0);
    t.eq('size.inch（标题唯一尺寸仍可用）', r.size && r.size.inch, 65);
  }),

  // ---- v2.1.7：移植巡检双轨版价格算法（价格区锁定/排除卡片/严格解析/字号最大/稳定性+复核）----
  checkCase('v2.1.7 价格：比价/关联/推荐卡里的「到手价」不抢价（pricecards）', async (t) => {
    const { result: r } = await runContent('pricecards', '100200175061');
    t.eq('ok', r.ok, true);
    t.eq('price（真实到手价）', r.price, 5999);
    t.eq('priceKind', r.priceKind, 'hand');
    t.eq('priceKindLabel', r.priceKindLabel, '到手价');
    t.eq('hand.price', r.hand && r.hand.price, 5999);
    t.eq('main.price（电商平台价）', r.main && r.main.price, 6499);
    t.eq('pricePick.price', r.pricePick && r.pricePick.price, 5999);
    t.eq('priceRect 有位置', !!(r.priceRect && r.priceRect.width > 0), true);
    t.ok('sourceLabel 记录价格元素 class', /hand-price/.test(String(r.sourceLabel || '')), r.sourceLabel);
    const cardPrices = (r.candidates || []).filter((c) => [8499, 1999, 2999].indexOf(Number(c.price)) >= 0);
    t.eq('比价/关联/推荐卡价格没有进入候选（被容器排除）', cardPrices.length, 0);
    const list = r.candidates || [];
    t.ok('candidates 带 font/cls/rect', list.length > 0 && list[0].font > 0 && !!list[0].cls && !!list[0].rect);
    t.ok('到手价候选 kind=hand', list.some((c) => c.price === 5999 && c.kind === 'hand'));
  }),
  checkCase('v2.1.7 价格：拆分价格 ¥8607.56 拼回完整值，不取「56」片段', async (t) => {
    const { result: r } = await runContent('splitprice', '100200175062');
    t.eq('ok', r.ok, true);
    t.eq('price', r.price, 8607.56);
    t.eq('priceKind', r.priceKind, 'hand');
    t.eq('pricePick.price', r.pricePick && r.pricePick.price, 8607.56);
    const frag = (r.candidates || []).filter((c) => Number(c.price) === 56);
    t.eq('没有把 56 当价格候选', frag.length, 0);
    t.ok('候选里含完整价 8607.56', (r.candidates || []).some((c) => Number(c.price) === 8607.56));
  }),
  checkCase('v2.1.7 价格：隐藏抽屉里的 4999 不参与（hiddenprice）', async (t) => {
    const { result: r } = await runContent('hiddenprice', '100200175063');
    t.eq('ok', r.ok, true);
    t.eq('price（可见到手价）', r.price, 6999);
    t.eq('priceKind', r.priceKind, 'hand');
    const hidden = (r.candidates || []).filter((c) => Number(c.price) === 4999);
    t.eq('隐藏的 4999 不在候选里', hidden.length, 0);
  }),
  checkCase('v2.1.7 价格：页面二次刷新 24699→25099，采用最终值并记录 priceChanges', async (t) => {
    const { result: r } = await runContent('pricerefresh', '100200175064', false, undefined, (doc) => {
      setShimText(doc.querySelector('#refresh-price'), '￥25099.00');
    });
    t.eq('ok', r.ok, true);
    t.eq('price（最终读数）', r.price, 25099);
    t.eq('priceKind', r.priceKind, 'hand');
    t.ok('记录价格变化 24699→25099', Array.isArray(r.priceChanges) && r.priceChanges.some((c) => Number(c.from) === 24699 && Number(c.to) === 25099), JSON.stringify(r.priceChanges));
  }),
  checkCase('v2.1.7 价格：首屏无价时放宽到全页（belowfold，仍排除推荐卡）', async (t) => {
    const { result: r } = await runContent('belowfold', '100200175065');
    t.eq('ok', r.ok, true);
    t.eq('price（第二屏到手价）', r.price, 5999);
    t.eq('priceKind', r.priceKind, 'hand');
    const rec = (r.candidates || []).filter((c) => Number(c.price) === 2999);
    t.eq('推荐卡 2999 被排除', rec.length, 0);
    t.ok('候选取自第二屏（top>=800）', (r.candidates || []).some((c) => c.price === 5999 && c.rect && c.rect.top >= 800));
  }),
  checkCase('v2.1.7 价格：只有电商平台价 → kind=main（mainonly）', async (t) => {
    const { result: r } = await runContent('mainonly', '100200175066');
    t.eq('ok', r.ok, true);
    t.eq('price', r.price, 5999);
    t.eq('priceKind', r.priceKind, 'main');
    t.eq('priceKindLabel', r.priceKindLabel, '电商平台价');
    t.eq('hand（没有到手价）', r.hand, null);
    t.eq('pricePick.kind', r.pricePick && r.pricePick.kind, 'main');
  }),
  checkCase('v2.1.7 价格：常规页新增字段齐全（price/kind/label/rect/source/candidates）', async (t) => {
    const { result: r } = await runContent('hand', '100200175067');
    t.eq('ok', r.ok, true);
    t.eq('price', r.price, 5499);
    t.eq('priceKind', r.priceKind, 'hand');
    t.eq('priceKindLabel', r.priceKindLabel, '到手价');
    t.ok('priceRect', !!(r.priceRect && r.priceRect.width > 0 && r.priceRect.top >= 0));
    t.ok('sourceLabel 含 hand-price', /hand-price/.test(String(r.sourceLabel || '')), r.sourceLabel);
    t.eq('priceChanges（无刷新）', Array.isArray(r.priceChanges) && r.priceChanges.length, 0);
    t.ok('candidates[0] 带 font/cls/rect/strike', !!((r.candidates || [])[0] && (r.candidates || [])[0].font >= 0));
  })
];

async function main() {
  console.log('= content.js 无浏览器补充自检（authoritative: cdp_capture_test.mjs）=');
  for (const run of CASES) await run();
  console.log('------------------------------------------');
  console.log('用例：' + results.cases.length + '，断言：通过 ' + results.pass + '，失败 ' + results.fail);
  const failed = results.cases.filter((c) => c.fail > 0);
  if (failed.length) {
    console.error('失败用例：' + failed.map((c) => c.name).join('；'));
    process.exitCode = 1;
  } else {
    console.log('全部通过 ✓');
  }
}

main().catch((e) => {
  console.error('自检异常终止：' + ((e && e.stack) || e));
  process.exitCode = 1;
});
