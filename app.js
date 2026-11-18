// 价格监控平台 · 平台壳逻辑
//
// 职责：
//   1) 首页「选择业务」：三张业务卡片 + 一张「使用说明」卡片；
//   2) 选定业务后，用 iframe#moduleFrame 装载 modules/<业务>/app.html（原插件界面原样复用）；
//      使用说明则装载同源的 guide.html；
//   3) 顶部细条：切业务 / 使用说明、返回业务选择、把当前页面在独立标签页打开（长时间采集推荐）；
//   4) 记住上次使用的业务，并支持 #/patrol、#/guide 这类深链直达。
//
// 三条业务的数据各自保存在各自的 chrome.storage 键里，本文件不读写任何业务数据。
// 使用说明是纯静态文档，不读写任何数据。

'use strict';

const BIZ = {
  patrol: {
    name: '价格巡检',
    page: 'modules/patrol/app.html',
  },
  share: {
    name: '市场占有率',
    page: 'modules/share/app.html',
  },
  radar: {
    name: '竞品监控',
    page: 'modules/radar/app.html',
  },
  guide: {
    name: '使用说明',
    page: 'guide.html',
  },
};

const KEY_LAST_BIZ = 'pjm.platform.lastBiz.v1';
const PLATFORM_TITLE = '价格监控平台';
const ORDER = ['patrol', 'share', 'radar', 'guide'];

const els = {
  landing: document.getElementById('landing'),
  workspace: document.getElementById('workspace'),
  frame: document.getElementById('moduleFrame'),
  mask: document.getElementById('frameMask'),
  maskText: document.getElementById('frameMaskText'),
  crumb: document.getElementById('crumbBiz'),
  frameState: document.getElementById('frameState'),
  homeBtn: document.getElementById('homeBtn'),
  backBtn: document.getElementById('backBtn'),
  openTabBtn: document.getElementById('openTabBtn'),
  switchNav: document.getElementById('bizSwitch'),
  toast: document.getElementById('toast'),
};

const state = {
  biz: null,
  frameTarget: '',
  recoverCount: 0,
  loadTimer: null,
  toastTimer: null,
};

/* ---------------------------- 小工具 ---------------------------- */

function setFrameState(text, tone) {
  if (!els.frameState) return;
  els.frameState.innerHTML = '<i class="dot ' + (tone || 'ok') + '"></i>' + escapeHtml(text);
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function toast(text, ms) {
  if (!els.toast) return;
  els.toast.textContent = text;
  els.toast.classList.remove('hidden');
  requestAnimationFrame(() => els.toast.classList.add('show'));
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    els.toast.classList.remove('show');
    setTimeout(() => els.toast.classList.add('hidden'), 220);
  }, ms || 2600);
}

function readLastBiz() {
  try {
    const raw = localStorage.getItem(KEY_LAST_BIZ);
    return Object.prototype.hasOwnProperty.call(BIZ, raw || '') ? raw : '';
  } catch (e) {
    return '';
  }
}

function writeLastBiz(id) {
  try { localStorage.setItem(KEY_LAST_BIZ, id); } catch (e) { /* 隐私模式下忽略 */ }
}

function parseHash() {
  const raw = String(location.hash || '').replace(/^#\/?/, '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(BIZ, raw) ? raw : '';
}

/* ---------------------------- 视图切换 ---------------------------- */

function showLanding() {
  state.biz = null;
  els.workspace.classList.add('hidden');
  els.landing.classList.remove('hidden');
  document.title = PLATFORM_TITLE;
  setFrameState('已就绪', 'ok');

  // 释放 iframe 里的业务页面（避免隐藏页面继续跑定时器）
  // 注意：用 location.replace 而不是改 src 属性 —— 后者会在浏览器历史里留下一条
  //       iframe 导航记录，用户按「后退」时会退到 iframe 的空页（白屏），而不是回到平台首页。
  state.frameTarget = '';
  navigateFrame('about:blank');
  els.mask.classList.remove('done');

  document.querySelectorAll('[data-switch-biz]').forEach((btn) => {
    btn.classList.remove('active');
    btn.removeAttribute('aria-current');
  });
  if (els.crumb) els.crumb.textContent = '—';

  markLastBiz();
}

function selectBiz(id, opts) {
  const options = opts || {};
  if (!Object.prototype.hasOwnProperty.call(BIZ, id)) return;
  if (state.biz === id) {
    if (options.updateHash !== false) updateHash(id);
    return;
  }

  const meta = BIZ[id];
  state.biz = id;

  els.landing.classList.add('hidden');
  els.workspace.classList.remove('hidden');
  document.title = meta.name + ' · ' + PLATFORM_TITLE;
  if (els.crumb) els.crumb.textContent = meta.name;

  document.querySelectorAll('[data-switch-biz]').forEach((btn) => {
    const on = btn.getAttribute('data-switch-biz') === id;
    btn.classList.toggle('active', on);
    if (on) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  });

  writeLastBiz(id);
  if (options.updateHash !== false) updateHash(id);

  if (state.frameTarget !== meta.page) {
    loadModule(meta.page, meta.name);
  } else {
    els.mask.classList.add('done');
    setFrameState('已就绪', 'ok');
  }
}

function loadModule(page, name) {
  state.frameTarget = page;
  state.recoverCount = 0;
  els.mask.classList.remove('done');
  if (els.maskText) els.maskText.textContent = '正在进入「' + name + '」…';
  setFrameState('加载中', 'warn');

  clearTimeout(state.loadTimer);
  state.loadTimer = setTimeout(() => {
    if (els.mask.classList.contains('done')) return;
    if (els.maskText) els.maskText.textContent = '「' + name + '」加载较慢，仍在等待页面就绪…';
  }, 12000);

  const abs = chrome.runtime.getURL(page);

  // 浏览器「后退」可能已经把 iframe 还原成这个业务页：这种情况不必重新加载，直接显示。
  const cur = frameUrl();
  if (cur === abs || cur.startsWith(abs + '#') || cur.startsWith(abs + '?')) {
    clearTimeout(state.loadTimer);
    els.mask.classList.add('done');
    setFrameState('已就绪', 'ok');
    return;
  }

  navigateFrame(abs);
}

/** 读取 iframe 当前文档的真实 URL（拿不到时返回空串）。 */
function frameUrl() {
  try {
    return String((els.frame.contentWindow && els.frame.contentWindow.location.href) || '');
  } catch (e) {
    return '';
  }
}

/**
 * 导航 iframe（同源 chrome-extension 页面）。
 * 用 contentWindow.location.replace() 而不是直接改 src 属性：replace 不新增浏览器历史记录，
 * 避免用户按「后退」时在 iframe 的空页之间来回（实测改 src 会把历史顶掉、后退变白屏）。
 * 失败（极少数时序下拿不到 contentWindow）时才退回 src 属性写法。
 */
function navigateFrame(url) {
  const f = els.frame;
  try {
    const win = f.contentWindow;
    if (win && win.location && typeof win.location.replace === 'function') {
      const cur = String(win.location.href || '');
      if (cur !== url) win.location.replace(url);
      return;
    }
  } catch (e) {
    // 拿不到 contentWindow → 退回 src
  }
  f.setAttribute('src', url);
}

function updateHash(id) {
  const next = '#/' + id;
  if (location.hash === next) return;
  try {
    history.pushState(null, '', next);
  } catch (e) {
    location.hash = '/' + id;
  }
}

function goHome(opts) {
  const options = opts || {};
  clearTimeout(state.loadTimer);
  showLanding();
  if (options.updateHash !== false) {
    try {
      history.pushState(null, '', location.pathname + location.search);
    } catch (e) {
      location.hash = '';
    }
  }
}

/* ---------------------------- 上次使用标记 ---------------------------- */

function markLastBiz() {
  const last = readLastBiz();
  document.querySelectorAll('[data-last-badge]').forEach((badge) => {
    const card = badge.closest('[data-biz]');
    const on = !!last && card && card.getAttribute('data-biz') === last;
    badge.classList.toggle('hidden', !on);
  });
}

/* ---------------------------- 事件绑定 ---------------------------- */

function bindEvents() {
  document.querySelectorAll('[data-biz]').forEach((card) => {
    card.addEventListener('click', () => selectBiz(card.getAttribute('data-biz')));
  });

  if (els.switchNav) {
    els.switchNav.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-switch-biz]');
      if (!btn) return;
      selectBiz(btn.getAttribute('data-switch-biz'));
    });
  }

  if (els.homeBtn) els.homeBtn.addEventListener('click', () => goHome());
  if (els.backBtn) els.backBtn.addEventListener('click', () => goHome());

  if (els.openTabBtn) {
    els.openTabBtn.addEventListener('click', () => {
      const id = state.biz;
      if (!id) return;
      try {
        chrome.tabs.create({ url: chrome.runtime.getURL(BIZ[id].page) });
      } catch (e) {
        toast('打开独立标签页失败：' + ((e && e.message) || e));
      }
    });
  }

  els.frame.addEventListener('load', () => {
    let href = '';
    try {
      href = String((els.frame.contentWindow && els.frame.contentWindow.location.href) || '');
    } catch (e) {
      href = '';
    }
    if (!href || href === 'about:blank') return; // 首页 / 已释放

    const biz = state.biz;
    if (!biz) return;
    const want = chrome.runtime.getURL(BIZ[biz].page);

    // 浏览器前进/后退可能把 iframe 还原成别的页面（甚至空页）：
    // 只要当前 iframe 不是当前业务页，就把它拉回来，避免白屏。
    if (href !== want && !href.startsWith(want + '#') && !href.startsWith(want + '?')) {
      if (state.recoverCount < 3) {
        state.recoverCount += 1;
        navigateFrame(want);
      }
      return;
    }

    state.recoverCount = 0;
    clearTimeout(state.loadTimer);
    els.mask.classList.add('done');
    setFrameState('已就绪', 'ok');
  });

  window.addEventListener('hashchange', () => {
    const id = parseHash();
    if (id) {
      if (state.biz !== id) selectBiz(id, { updateHash: false });
    } else if (state.biz) {
      goHome({ updateHash: false });
    }
  });

  window.addEventListener('popstate', () => {
    const id = parseHash();
    if (id) {
      if (state.biz !== id) selectBiz(id, { updateHash: false });
    } else if (state.biz) {
      goHome({ updateHash: false });
    }
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.defaultPrevented) return;
    if (ev.altKey || ev.ctrlKey || ev.metaKey) return;
    const tag = (ev.target && ev.target.tagName) || '';
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag)) return;

    if (ev.key === 'Escape') {
      if (state.biz) goHome();
      return;
    }
    if (!state.biz && /^[1-4]$/.test(ev.key)) {
      const index = Number(ev.key) - 1;
      const id = ORDER[index];
      if (id) {
        ev.preventDefault();
        selectBiz(id);
      }
    }
  });

  // 业务里如果自己开了新窗口/被浏览器拦了窗口，给出提示（不影响主流程）
  window.addEventListener('unhandledrejection', (ev) => {
    const msg = (ev.reason && (ev.reason.message || ev.reason)) || '';
    if (/user gesture|popup|窗口/i.test(String(msg))) {
      toast('业务页弹窗被浏览器拦截，可点右上角「独立打开」单独打开该业务');
    }
  });
}

/* ---------------------------- 启动 ---------------------------- */

function start() {
  bindEvents();
  markLastBiz();
  const id = parseHash();
  if (id) selectBiz(id, { updateHash: false });
  else showLanding();
}

start();
