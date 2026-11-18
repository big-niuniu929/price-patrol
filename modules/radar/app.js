/* ============================================================================
 * 竞品价格雷达 · 工作台逻辑
 * ----------------------------------------------------------------------------
 *  - 监控清单：内置 data/competitor-skus.json（来自竞品 Excel），支持本地增删改
 *  - 采集：后台标签页 / 前台窗口+AI 两条轨道，逐个打开电商平台商品页取价
 *  - 数据：chrome.storage.local 本地保存；采集记录、异动、任务历史彼此隔离
 *  - 预警：较基准价波动 / 较上次采集骤变 / 历史新低 / 采集异常
 * ========================================================================== */
(() => {
  'use strict';

  // ------------------------------------------------------------------ 常量
  const KEY_DB = 'priceradar.db.v1';
  const KEY_META = 'priceradar.meta.v1';
  const WATCHLIST_URL = 'modules/radar/data/competitor-skus.json';
  const ITEM_URL = (sku) => 'https://item.shop.example.com/' + sku + '.html';
  const PRICE_TIMEOUT_MS = 45000;
  const MAX_ALERTS = 300;
  const MAX_RUNS = 20;
  const MAX_CAPTURES_PER_SKU = 60;
  const MAX_LOGS = 400;

  const DEFAULT_SETTINGS = {
    mode: 'background',
    priceBasis: 'hand',
    batch: 40,
    delayMin: 3,
    delayMax: 6,
    skipToday: true,
    keepTab: false,
    baseAlertPct: 5,
    bigAlertPct: 15,
    captureAlertPct: 3,
    newLowAlert: true,
    failAlert: true,
    previewDelay: 900,
    aiEnabled: false,
    aiEndpoint: '',
    aiModel: 'deepseek-chat',
    aiKey: '',
    aiMode: 'fallback',
    lastAccount: '',
    lastScope: 'filtered'
  };

  const DEFAULT_DB = {
    version: 1,
    settings: Object.assign({}, DEFAULT_SETTINGS),
    captures: {},
    alerts: [],
    runs: [],
    records: [],
    daily: {},
    lastRun: null,
    lastAccount: ''
  };

  const DEFAULT_META = { version: 1, custom: [], overrides: {}, savedAt: null };

  const STATUS_META = {
    alert: { label: '有异动', cls: 'alert' },
    review: { label: '待核对', cls: 'review' },
    fail: { label: '采集异常', cls: 'fail' },
    unavailable: { label: '不可售', cls: 'unavailable' },
    offline: { label: '已下架', cls: 'offline' },
    captured: { label: '已采集', cls: 'ok' },
    never: { label: '未采集', cls: 'never' },
    ignored: { label: '已忽略', cls: 'ignored' }
  };

  const KIND_LABEL = {
    hand: '到手价',
    main: '电商平台价',
    plus: 'PLUS价',
    ai: 'AI识别',
    manual: '手动',
    official: '官方API'
  };

  const ALERT_META = {
    newLow: { label: '历史新低', icon: 'i-trend-down' },
    drop: { label: '降价', icon: 'i-trend-down' },
    rise: { label: '涨价', icon: 'i-trend-up' },
    fail: { label: '采集异常', icon: 'i-alert' },
    offline: { label: '已下架', icon: 'i-alert' },
    verify: { label: '安全验证', icon: 'i-alert' }
  };

  const BRAND_PALETTE = ['#0d9488', '#2563eb', '#7c3aed', '#0891b2', '#c026d3', '#ea580c', '#65a30d', '#475569'];

  // 价格带：用于分析视图、清单筛选和同尺寸对标
  const PRICE_BANDS = [
    { key: 'b1', label: '< 3,000', short: '<3k', min: 0, max: 2999.99, color: '#14b8a6' },
    { key: 'b2', label: '3,000–4,999', short: '3–5k', min: 3000, max: 4999.99, color: '#22c55e' },
    { key: 'b3', label: '5,000–7,999', short: '5–8k', min: 5000, max: 7999.99, color: '#eab308' },
    { key: 'b4', label: '8,000–11,999', short: '8–12k', min: 8000, max: 11999.99, color: '#f97316' },
    { key: 'b5', label: '12,000–19,999', short: '12–20k', min: 12000, max: 19999.99, color: '#f43f5e' },
    { key: 'b6', label: '≥ 20,000', short: '≥20k', min: 20000, max: Infinity, color: '#7c3aed' }
  ];

  // 分析视图的尺寸分桶（把 85/86、98/100 合并，避免列太多）
  const SIZE_COLUMNS = [
    { key: '55', label: '55"', test: (i) => i === 55 },
    { key: '65', label: '65"', test: (i) => i === 65 },
    { key: '75', label: '75"', test: (i) => i === 75 },
    { key: '85', label: '85–86"', test: (i) => i >= 84 && i <= 87 },
    { key: '98', label: '98–100"', test: (i) => i >= 97 && i <= 102 },
    { key: '110', label: '110"+', test: (i) => i >= 105 },
    { key: 'other', label: '其他', test: () => true }
  ];

  const $ = (id) => document.getElementById(id);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
  const errText = (e) => (e && e.message) || String(e);

  // ------------------------------------------------------------------ 状态
  const state = {
    db: null,
    meta: null,
    base: null,
    rows: [],
    rowMap: new Map(),
    view: 'dashboard',
    loaded: false,
    ui: {
      brand: 'all', category: 'all', size: 'all', series: 'all', system: 'all', band: 'all', tag: 'all',
      status: 'all', q: '', sort: 'updated', dir: 'desc', density: 'comfortable', hideOffline: false
    },
    analytics: { category: 'all', size: 'all', basis: 'latest' },
    volatility: { dim: 'size', metric: 'index', category: 'all', q: '', sort: 'volatility' },
    selected: new Set(),
    drawerSku: null,
    alertFilter: 'new',
    alertLevel: 'all',
    alertType: 'all',
    logs: [],
    running: false,
    paused: false,
    stopped: false,
    run: null,
    pending: null,
    pendingBuffer: null,
    preview: { winId: null, tabId: null, pinned: false, sku: null, openTimer: null, closeTimer: null },
    dockCollapsed: false,
    lastRaw: null,
    lastAi: null,
    sidebarOpen: false
  };

  // ------------------------------------------------------------------ 工具
  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }

  function money(n) {
    if (n == null || !isFinite(Number(n))) return '—';
    const num = Number(n);
    const digits = Math.abs(num - Math.round(num)) < 0.005 ? 0 : 2;
    return '¥' + num.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: 2 });
  }

  function num(n) {
    if (n == null || !isFinite(Number(n))) return '—';
    return Number(n).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  }

  function fmtPct(p, withSign) {
    if (p == null || !isFinite(Number(p))) return '—';
    const n = Number(p);
    return (n > 0 && withSign !== false ? '+' : '') + n.toFixed(1) + '%';
  }

  function pctTone(p) {
    if (p == null || !isFinite(Number(p)) || Math.abs(p) < 0.05) return 'flat';
    return p < 0 ? 'down' : 'up';
  }

  function fmtDate(iso, withTime) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return withTime === false ? mm + '-' + dd : d.getFullYear() + '-' + mm + '-' + dd + ' ' + hh + ':' + mi;
  }

  function isToday(iso) {
    if (!iso) return false;
    const d = new Date(iso);
    if (isNaN(d.getTime())) return false;
    const now = new Date();
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  }

  function relTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    const diff = Date.now() - d.getTime();
    if (diff < 60 * 1000) return '刚刚';
    if (diff < 3600 * 1000) return Math.floor(diff / 60000) + ' 分钟前';
    if (isToday(iso)) return '今天 ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    if (diff < 48 * 3600 * 1000) return '昨天 ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    if (diff < 7 * 24 * 3600 * 1000) return Math.floor(diff / 86400000) + ' 天前';
    return fmtDate(iso, false);
  }

  function todayStamp() {
    const d = new Date();
    return d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
  }

  function stampNow() {
    const d = new Date();
    return d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0') + '-' +
      String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0');
  }

  function uid(prefix) {
    return (prefix || 'id') + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
  }

  function brandColor(brand) {
    let hash = 0;
    const text = String(brand || '');
    for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) % 997;
    return BRAND_PALETTE[hash % BRAND_PALETTE.length];
  }

  function brandTag(row) {
    const color = brandColor(row.brand);
    return '<span class="cell-brand"><i class="brand-dot" style="background:' + color + '"></i>' + esc(row.brand || '未知') + '</span>';
  }

  function kindBadge(kind) {
    if (!kind) return '';
    return '<span class="kind-badge ' + esc(kind) + '">' + esc(KIND_LABEL[kind] || '价格') + '</span>';
  }

  function statusBadge(status) {
    const meta = STATUS_META[status] || STATUS_META.never;
    return '<span class="status-badge ' + meta.cls + '">' + esc(meta.label) + '</span>';
  }

  function deltaHtml(pct) {
    const tone = pctTone(pct);
    if (tone === 'flat') return '<span class="delta flat">—</span>';
    const arrow = tone === 'down' ? '↓' : '↑';
    return '<span class="delta ' + tone + '"><span class="arrow">' + arrow + '</span>' + Math.abs(pct).toFixed(1) + '%</span>';
  }

  // ------------------------------------------------------------------ 存储
  function normalizeDb(stored) {
    const src = stored && typeof stored === 'object' ? stored : {};
    return {
      version: 1,
      settings: Object.assign({}, DEFAULT_SETTINGS, src.settings || {}),
      captures: src.captures && typeof src.captures === 'object' ? src.captures : {},
      alerts: Array.isArray(src.alerts) ? src.alerts : [],
      runs: Array.isArray(src.runs) ? src.runs : [],
      records: Array.isArray(src.records) ? src.records : [],
      daily: src.daily && typeof src.daily === 'object' ? src.daily : {},
      lastRun: src.lastRun || null,
      lastAccount: src.lastAccount || ''
    };
  }

  function normalizeMeta(stored) {
    const src = stored && typeof stored === 'object' ? stored : {};
    return {
      version: 1,
      custom: Array.isArray(src.custom) ? src.custom : [],
      overrides: src.overrides && typeof src.overrides === 'object' ? src.overrides : {},
      savedAt: src.savedAt || null
    };
  }

  async function loadAll() {
    let stored = {};
    try {
      stored = (await chrome.storage.local.get([KEY_DB, KEY_META])) || {};
    } catch (e) {
      stored = {};
    }
    state.db = normalizeDb(stored[KEY_DB]);
    state.meta = normalizeMeta(stored[KEY_META]);
    try {
      const res = await fetch(chrome.runtime.getURL(WATCHLIST_URL), { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      state.base = await res.json();
    } catch (e) {
      state.base = { schema: 'price-radar.watchlist.v1', meta: {}, skus: [] };
      setToast('内置监控清单读取失败：' + errText(e), 'error');
    }
    migrateLegacyRecords();
    buildRows();
    state.db.settings.lastAccount = state.db.settings.lastAccount || state.db.lastAccount || '';
    state.loaded = true;
  }

  async function saveDb() {
    try {
      await chrome.storage.local.set({ [KEY_DB]: state.db });
    } catch (e) {
      setToast('保存失败：' + errText(e), 'error');
    }
    updateStorageInfo();
  }

  // 稳定序列化：chrome.storage 落盘后读回来的对象键顺序可能与写入时不同（会被按 key 重排），
  // 直接用 JSON.stringify 比较会误判「写入校验不一致」。与巡检 v1.3.4 的 saveBaseOverride 保持同一做法。
  function stableStringify(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
    const keys = Object.keys(v).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
  }

  async function saveMeta() {
    state.meta.savedAt = new Date().toISOString();
    try {
      await chrome.storage.local.set({ [KEY_META]: state.meta });
      const check = await chrome.storage.local.get(KEY_META);
      if (!check || stableStringify(check[KEY_META]) !== stableStringify(state.meta)) {
        throw new Error('写入校验不一致');
      }
    } catch (e) {
      setToast('监控清单保存失败：' + errText(e), 'error');
      throw e;
    }
  }

  function updateStorageInfo() {
    const info = $('storageInfo');
    if (!info) return;
    let bytes = 0;
    try {
      if (chrome.storage.local.getBytesInUse) {
        chrome.storage.local.getBytesInUse(null).then((n) => {
          info.textContent = '本机存储 ' + (Number(n) / 1024).toFixed(1) + ' KB';
        }).catch(() => {});
        return;
      }
    } catch (e) {
      // 忽略
    }
    bytes = JSON.stringify(state.db || {}).length + JSON.stringify(state.meta || {}).length;
    info.textContent = '本机存储约 ' + (bytes / 1024).toFixed(1) + ' KB';
  }

  // ------------------------------------------------------------------ 数据合并
  function mergeRow(item, override, custom) {
    const ov = override || {};
    const row = {
      sku: String((item && item.sku) || '').trim(),
      brand: ov.brand || (item && item.brand) || '未分类',
      category: ov.category || (item && item.category) || '',
      series: ov.series || (item && item.series) || '',
      system: ov.system || (item && item.system) || '',
      size: ov.size || (item && item.size) || '',
      inch: (item && item.inch) || null,
      model: ov.model || (item && item.model) || '',
      platform: (item && item.platform) || '电商平台',
      history: Array.isArray(item && item.history) ? item.history : [],
      lastPrice: item && item.lastPrice != null ? item.lastPrice : null,
      lastDate: (item && item.lastDate) || '',
      offline: ov.offline != null ? !!ov.offline : !!(item && item.offline),
      tags: Array.isArray(item && item.tags) ? item.tags : [],
      note: ov.note != null ? ov.note : (item && item.note) || '',
      custom: !!custom,
      baselineManual: ov.baseline != null && ov.baseline !== '' && isFinite(Number(ov.baseline)) ? Number(ov.baseline) : null,
      ignored: !!ov.ignored,
      addedAt: (item && item.addedAt) || ''
    };
    return row;
  }

  function buildRows() {
    const map = new Map();
    const overrides = state.meta.overrides || {};
    for (const item of (state.base && state.base.skus) || []) {
      if (!item || !item.sku) continue;
      map.set(String(item.sku), mergeRow(item, overrides[String(item.sku)], false));
    }
    for (const item of state.meta.custom || []) {
      if (!item || !item.sku) continue;
      const sku = String(item.sku);
      if (map.has(sku)) continue;
      map.set(sku, mergeRow(item, overrides[sku], true));
    }
    state.rows = Array.from(map.values()).filter((row) => row.sku);
    state.rowMap = new Map(state.rows.map((row) => [row.sku, row]));
    state.selected.forEach((sku) => { if (!state.rowMap.has(sku)) state.selected.delete(sku); });
  }

  const rowBySku = (sku) => state.rowMap.get(String(sku)) || null;
  const captureOf = (row) => (row && row.sku ? state.db.captures[row.sku] || null : null);
  const latestOf = (row) => {
    const cap = captureOf(row);
    return cap && cap.latest ? cap.latest : null;
  };

  function baselineOf(row) {
    if (!row) return { value: null, source: '', date: '' };
    if (row.baselineManual != null) return { value: row.baselineManual, source: 'manual', date: '' };
    const cap = captureOf(row);
    // 「写入记录表」后，记录表里最近日期列的价格就是下一轮波动的基准；未写入时仍用导入历史/首次采集价
    const daily = dailyEntryFor(row.sku);
    if (daily && isFinite(Number(daily.price))) {
      return { value: Number(daily.price), source: 'record', date: daily.date || '' };
    }
    if (cap && cap.confirmedPrice != null && isFinite(Number(cap.confirmedPrice))) {
      return { value: Number(cap.confirmedPrice), source: 'confirmed', date: cap.confirmedCaptureAt || cap.confirmedAt || '' };
    }
    if (row.lastPrice != null && isFinite(Number(row.lastPrice))) {
      return { value: Number(row.lastPrice), source: 'import', date: row.lastDate || '' };
    }
    if (cap && Array.isArray(cap.history) && cap.history.length) {
      const first = cap.history[0];
      return { value: Number(first.price), source: 'capture', date: first.at || '' };
    }
    return { value: null, source: '', date: '' };
  }

  function deltaOf(row) {
    const latest = latestOf(row);
    const base = baselineOf(row);
    if (!latest || latest.price == null || base.value == null || !base.value) return null;
    return ((latest.price - base.value) / base.value) * 100;
  }

  function localDateKey(input) {
    const d = input instanceof Date ? input : new Date(input == null ? Date.now() : input);
    if (!d || isNaN(d.getTime())) return '';
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + mm + '-' + dd;
  }

  function dailyDates() {
    const daily = state.db.daily || {};
    return Object.keys(daily).filter((k) => daily[k] && typeof daily[k] === 'object').sort();
  }

  /** 某个 SKU 在记录表里最近日期列的价格 { date, price, at, kind } */
  function dailyEntryFor(sku) {
    const dates = dailyDates();
    for (let i = dates.length - 1; i >= 0; i--) {
      const entry = (state.db.daily[dates[i]] || {})[sku];
      if (entry && isFinite(Number(entry.price))) {
        return { date: dates[i], price: Number(entry.price), at: entry.at || '', kind: entry.kind || '', writtenAt: entry.writtenAt || '' };
      }
    }
    return null;
  }

  function isLatestRecorded(row) {
    const cap = captureOf(row);
    const latest = cap && cap.latest;
    return !!(cap && latest && cap.recordedAt && latest.at && cap.recordedAt === latest.at);
  }

  function pendingRecordRows() {
    return state.rows.filter((row) => {
      if (row.ignored || row.offline) return false;
      const cap = captureOf(row);
      const latest = cap && cap.latest;
      return !!(latest && latest.price != null && !isLatestRecorded(row));
    });
  }

  // 旧版（v1.1.4 及更早）的 records/confirmedPrice 迁移到 daily 日期矩阵（只做一次，已有 daily 不重复）
  function migrateLegacyRecords() {
    const db = state.db;
    if (!db.daily || typeof db.daily !== 'object') db.daily = {};
    if (!Object.keys(db.daily).length && Array.isArray(db.records)) {
      for (const rec of db.records) {
        if (!rec || !rec.items) continue;
        const date = localDateKey(rec.at);
        if (!date) continue;
        if (!db.daily[date]) db.daily[date] = {};
        for (const sku of Object.keys(rec.items)) {
          const item = rec.items[sku] || {};
          if (!isFinite(Number(item.price))) continue;
          db.daily[date][sku] = {
            price: Number(item.price),
            kind: item.kind || '',
            at: item.at || rec.at || '',
            confidence: item.confidence || '',
            writtenAt: rec.at || ''
          };
        }
      }
    }
    // 更早版本只有 captures.confirmedPrice：按确认时间补一条日期记录
    for (const sku of Object.keys(db.captures || {})) {
      const cap = db.captures[sku] || {};
      if (cap.confirmedPrice == null || !isFinite(Number(cap.confirmedPrice))) continue;
      if (dailyEntryFor(sku)) continue;
      const date = localDateKey(cap.confirmedCaptureAt || cap.confirmedAt || Date.now());
      if (!date) continue;
      if (!db.daily[date]) db.daily[date] = {};
      db.daily[date][sku] = {
        price: Number(cap.confirmedPrice),
        kind: '',
        at: cap.confirmedCaptureAt || '',
        confidence: '',
        writtenAt: cap.confirmedAt || ''
      };
    }
  }

  // 把本次采集里「最新且未写入记录表」的价格批量写入**今日日期列**；下一轮波动以记录表最近日期列为基准。
  async function writeRecords(rows, source, silent) {
    const targets = [];
    for (const row of rows || []) {
      const cap = captureOf(row);
      const latest = cap && cap.latest;
      if (!latest || latest.price == null || isLatestRecorded(row)) continue;
      targets.push({ row, cap, latest });
    }
    if (!targets.length) {
      if (!silent) setToast('没有待写入记录表的采集结果（先采集或重采一次）', 'warn');
      return 0;
    }
    const now = new Date();
    const today = localDateKey(now);
    if (!state.db.daily[today]) state.db.daily[today] = {};
    const day = state.db.daily[today];
    let updated = 0;
    for (const t of targets) {
      const price = Number(t.latest.price);
      const prev = day[t.row.sku];
      if (prev && isFinite(Number(prev.price)) && prev.at && t.latest.at && prev.at !== t.latest.at && Number(prev.price) !== price) updated += 1;
      day[t.row.sku] = {
        price: price,
        kind: t.latest.kind || '',
        at: t.latest.at || '',
        confidence: t.latest.confidence || '',
        writtenAt: now.toISOString()
      };
      t.cap.confirmedPrice = price;
      t.cap.confirmedCaptureAt = t.latest.at || '';
      t.cap.confirmedAt = now.toISOString();
      t.cap.recordedAt = t.latest.at || '';
      t.cap.recordDate = today;
    }
    state.db.records = state.db.records || [];
    state.db.records.unshift({ id: uid('rec'), at: now.toISOString(), date: today, source: source || 'batch', count: targets.length, updatedCount: updated });
    if (state.db.records.length > 60) state.db.records.length = 60;
    await saveDb();
    buildRows();
    renderAll();
    if (!silent) {
      setToast('已把 ' + targets.length + ' 个 SKU 的本次采集价写入今日记录（' + today + '）' + (updated ? '，更新 ' + updated + ' 条' : '') + '；下一轮波动以记录表为准', 'success');
    }
    logLine('已写入今日记录（' + today + '）：' + targets.length + ' 个 SKU' + (updated ? '（更新 ' + updated + ' 条）' : '') + '，下一轮波动以记录表为准');
    if ($('recordsDialog') && $('recordsDialog').open) renderRecordsDialog();
    return targets.length;
  }

  async function confirmAllLatest() {
    return writeRecords(pendingRecordRows(), 'batch');
  }

  async function confirmOne(sku) {
    const row = rowBySku(sku);
    if (!row) return 0;
    return writeRecords([row], 'single');
  }

  function renderConfirmRunBtn() {
    const btn = $('confirmRunBtn');
    if (!btn) return;
    const pending = pendingRecordRows().length;
    btn.disabled = pending === 0 || state.running;
    btn.innerHTML = '<svg class="icon"><use href="#i-check"/></svg>写入今日记录' + (pending ? '（' + pending + '）' : '');
    btn.title = pending
      ? '把本次批量采集的 ' + pending + ' 个 SKU 最新价写入今日记录表（下一轮波动以记录表为准）'
      : '当前没有待写入记录表的采集结果';
  }

  function renderRecordsBtn() {
    const btn = $('recordsBtn');
    if (!btn) return;
    const days = dailyDates().length;
    const covered = currentRecordRows().length;
    btn.innerHTML = '<svg class="icon"><use href="#i-history"/></svg>记录表（' + days + '天）';
    btn.title = days
      ? '共 ' + days + ' 天记录 · 覆盖 ' + covered + ' 个 SKU；查看/导出记录表'
      : '还没有写入过记录表：采集后点「写入今日记录」';
  }

  // 当前记录表 = 每个 SKU 最近日期列的价格（用于弹窗/导出/清空提示）
  function currentRecordRows() {
    const out = [];
    const order = new Map(state.rows.map((row, idx) => [row.sku, idx]));
    for (const row of state.rows) {
      const entry = dailyEntryFor(row.sku);
      if (!entry) continue;
      out.push({
        row: row,
        price: entry.price,
        date: entry.date,
        capturedAt: entry.at || '',
        writtenAt: entry.writtenAt || ''
      });
    }
    out.sort((a, b) => (order.get(a.row.sku) || 0) - (order.get(b.row.sku) || 0));
    return out;
  }

  function alertsOf(sku, onlyNew) {
    return state.db.alerts.filter((a) => a.sku === sku && (!onlyNew || a.status === 'new'));
  }

  function statusOf(row) {
    if (row.ignored) return 'ignored';
    if (row.offline) return 'offline';
    const cap = captureOf(row);
    const latest = cap && cap.latest;
    const fail = cap && cap.fail;
    if (fail && (!latest || new Date(fail.at).getTime() >= new Date(latest.at).getTime())) {
      if (fail.type === 'offline') return 'offline';
      if (fail.type === 'unavailable') return 'unavailable';
      return 'fail';
    }
    if (latest) {
      if (alertsOf(row.sku, true).length) return 'alert';
      if (latest.confidence && latest.confidence !== 'high') return 'review';
      return 'captured';
    }
    return 'never';
  }

  function allHistory(row) {
    const points = [];
    for (const h of row.history || []) {
      if (h && h.price != null && isFinite(Number(h.price))) {
        points.push({ date: h.date, price: Number(h.price), source: 'import' });
      }
    }
    const cap = captureOf(row);
    for (const c of (cap && cap.history) || []) {
      if (c && c.price != null) points.push({ date: c.at, price: Number(c.price), source: 'capture', confidence: c.confidence, kind: c.kind });
    }
    points.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    return points;
  }

  function historyStats(row) {
    const points = allHistory(row);
    const prices = points.map((p) => p.price).filter((p) => p != null && isFinite(p));
    if (!prices.length) return { low: null, high: null, avg: null, count: 0 };
    return {
      low: Math.min.apply(null, prices),
      high: Math.max.apply(null, prices),
      avg: prices.reduce((a, b) => a + b, 0) / prices.length,
      count: prices.length
    };
  }

  function currentPrice(row) {
    const latest = latestOf(row);
    return latest && latest.price != null ? Number(latest.price) : null;
  }

  function prevCapturePrice(row) {
    const cap = captureOf(row);
    if (!cap || !Array.isArray(cap.history) || cap.history.length < 2) return null;
    return Number(cap.history[cap.history.length - 2].price);
  }

  // ------------------------------------------------------------------ 分析维度
  function median(values) {
    const list = (values || []).filter((v) => v != null && isFinite(v)).slice().sort((a, b) => a - b);
    if (!list.length) return null;
    const mid = Math.floor(list.length / 2);
    return list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
  }

  function priceBandOf(price) {
    const p = Number(price);
    if (!isFinite(p) || p <= 0) return null;
    return PRICE_BANDS.find((band) => p >= band.min && p <= band.max) || null;
  }

  function rowPrice(row, basis) {
    if (!row) return null;
    const base = baselineOf(row).value;
    if (basis === 'base') return base != null ? Number(base) : null;
    const latest = currentPrice(row);
    return latest != null ? latest : base != null ? Number(base) : null;
  }

  function priceBandOfRow(row, basis) {
    return priceBandOf(rowPrice(row, basis));
  }

  function sizeKeyOf(row) {
    if (row && row.inch) return String(row.inch) + '英寸';
    const m = String((row && row.size) || '').match(/(\d{2,3})\s*(?:英寸|寸)/);
    return m ? m[1] + '英寸' : ((row && row.size) || '其他');
  }

  function sizeColumnOf(row) {
    let inch = row && row.inch ? Number(row.inch) : null;
    if (!inch) {
      const m = String((row && row.size) || '').match(/(\d{2,3})\s*(?:英寸|寸)/);
      if (m) inch = Number(m[1]);
    }
    if (!inch) return SIZE_COLUMNS[SIZE_COLUMNS.length - 1];
    return SIZE_COLUMNS.find((col) => col.test(inch)) || SIZE_COLUMNS[SIZE_COLUMNS.length - 1];
  }

  // 同类型 + 同尺寸的平均价 / 排名 / 价差
  function peerStats(row, basis) {
    if (!row) return { count: 0, avg: null, median: null, rank: null, diff: null, min: null, max: null, group: '' };
    const sizeKey = sizeKeyOf(row);
    const category = row.category || '';
    let peers = state.rows.filter((r) => !r.ignored && !r.offline && sizeKeyOf(r) === sizeKey && (!category || r.category === category));
    let group = category ? category + ' · ' + sizeKey : sizeKey;
    if (peers.length < 2) {
      peers = state.rows.filter((r) => !r.ignored && !r.offline && sizeKeyOf(r) === sizeKey);
      group = sizeKey;
    }
    if (peers.length < 2 && category) {
      peers = state.rows.filter((r) => !r.ignored && !r.offline && r.category === category);
      group = category;
    }
    const prices = peers.map((r) => rowPrice(r, basis)).filter((p) => p != null && isFinite(p));
    const price = rowPrice(row, basis);
    if (price == null || !prices.length) {
      return { count: prices.length, avg: null, median: null, rank: null, diff: null, min: null, max: null, group: group };
    }
    const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
    const sorted = prices.slice().sort((a, b) => a - b);
    const rank = sorted.filter((p) => p < price - 0.001).length + 1;
    return {
      count: prices.length,
      avg: avg,
      median: median(prices),
      rank: rank,
      diff: ((price - avg) / avg) * 100,
      min: sorted[0],
      max: sorted[sorted.length - 1],
      group: group
    };
  }

  function analyticsRows() {
    const a = state.analytics;
    return state.rows.filter((row) => {
      if (row.ignored || row.offline) return false;
      if (a.category !== 'all' && row.category !== a.category) return false;
      if (a.size !== 'all' && sizeKeyOf(row) !== a.size) return false;
      return true;
    });
  }

  function priceBandStats(rows, basis) {
    const items = PRICE_BANDS.map((band) => ({ band: band, count: 0, rows: [], avg: null }));
    let unknown = 0;
    for (const row of rows) {
      const band = priceBandOfRow(row, basis);
      if (!band) { unknown++; continue; }
      const item = items.find((x) => x.band.key === band.key);
      item.count++;
      item.rows.push(row);
    }
    for (const item of items) {
      const prices = item.rows.map((r) => rowPrice(r, basis)).filter((p) => p != null);
      item.avg = prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : null;
    }
    return { items: items, unknown: unknown, total: rows.length };
  }

  function brandStats(rows, basis) {
    const map = new Map();
    for (const row of rows) {
      if (!map.has(row.brand)) map.set(row.brand, { brand: row.brand, rows: [], prices: [], coverage: 0 });
      const item = map.get(row.brand);
      item.rows.push(row);
      const price = rowPrice(row, basis);
      if (price != null) item.prices.push(price);
      if (latestOf(row)) item.coverage++;
    }
    return Array.from(map.values()).map((item) => {
      const prices = item.prices;
      return {
        brand: item.brand,
        count: item.rows.length,
        avg: prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : null,
        median: median(prices),
        min: prices.length ? Math.min.apply(null, prices) : null,
        max: prices.length ? Math.max.apply(null, prices) : null,
        coverage: item.rows.length ? Math.round((item.coverage / item.rows.length) * 100) : 0,
        rows: item.rows
      };
    }).sort((a, b) => (b.avg || 0) - (a.avg || 0));
  }

  function sizeAnchorStats(rows, basis) {
    const map = new Map();
    for (const row of rows) {
      const key = sizeKeyOf(row);
      if (!map.has(key)) map.set(key, { key: key, rows: [], prices: [] });
      const item = map.get(key);
      item.rows.push(row);
      const price = rowPrice(row, basis);
      if (price != null) item.prices.push({ price: price, row: row });
    }
    return Array.from(map.values()).map((item) => {
      const prices = item.prices.map((p) => p.price);
      const minItem = item.prices.length ? item.prices.reduce((a, b) => (b.price < a.price ? b : a)) : null;
      const maxItem = item.prices.length ? item.prices.reduce((a, b) => (b.price > a.price ? b : a)) : null;
      return {
        key: item.key,
        count: item.prices.length,
        avg: prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : null,
        median: median(prices),
        minRow: minItem ? minItem.row : null,
        min: minItem ? minItem.price : null,
        maxRow: maxItem ? maxItem.row : null,
        max: maxItem ? maxItem.price : null
      };
    }).filter((item) => item.count > 0).sort((a, b) => {
      const ai = parseInt(a.key, 10);
      const bi = parseInt(b.key, 10);
      return (isFinite(ai) ? ai : 9999) - (isFinite(bi) ? bi : 9999);
    });
  }

  function analyticsData() {
    const rows = analyticsRows();
    const basis = state.analytics.basis || 'latest';
    const prices = rows.map((r) => rowPrice(r, basis)).filter((p) => p != null);
    const coverage = rows.length ? Math.round((rows.filter((r) => latestOf(r)).length / rows.length) * 100) : 0;
    return {
      rows: rows,
      basis: basis,
      avg: prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : null,
      median: median(prices),
      coverage: coverage,
      bands: priceBandStats(rows, basis),
      brands: brandStats(rows, basis),
      sizes: sizeAnchorStats(rows, basis)
    };
  }

  // ------------------------------------------------------------------ 波动看板
  function stddev(values) {
    const list = (values || []).filter((v) => v != null && isFinite(v));
    if (list.length < 2) return null;
    const avg = list.reduce((a, b) => a + b, 0) / list.length;
    return Math.sqrt(list.reduce((sum, v) => sum + Math.pow(v - avg, 2), 0) / list.length);
  }

  function monthKeyOf(date) {
    const d = new Date(date);
    if (isFinite(d.getTime())) return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    const text = String(date || '');
    const m = text.match(/(\d{4})[-/.](\d{1,2})/);
    return m ? m[1] + '-' + String(m[2]).padStart(2, '0') : '';
  }

  function fmtMonth(key) {
    const m = String(key || '').match(/^(\d{4})-(\d{2})$/);
    return m ? m[1].slice(2) + '.' + m[2] : key;
  }

  function monthlyPointsOf(row) {
    const map = new Map();
    for (const p of allHistory(row)) {
      const key = monthKeyOf(p.date);
      if (!key) continue;
      const t = new Date(p.date).getTime();
      const prev = map.get(key);
      if (!prev || !isFinite(prev.t) || t >= prev.t) map.set(key, { key: key, price: Number(p.price), t: t });
    }
    return Array.from(map.values()).sort((a, b) => a.key.localeCompare(b.key));
  }

  function volDimKey(row, dim) {
    if (dim === 'size') return sizeColumnOf(row).label;
    if (dim === 'system') return row.system || '未标注系统';
    if (dim === 'brand') return row.brand || '未标注品牌';
    return row.category || '未标注类型';
  }

  function volatilityData() {
    const cfg = state.volatility;
    const rows = state.rows.filter((row) => !row.ignored && !row.offline && (cfg.category === 'all' || row.category === cfg.category));
    const pointsByRow = new Map();
    const monthSet = new Set();
    for (const row of rows) {
      const points = monthlyPointsOf(row);
      pointsByRow.set(row.sku, points);
      points.forEach((p) => monthSet.add(p.key));
    }
    const months = Array.from(monthSet).sort();
    const groups = new Map();
    for (const row of rows) {
      const key = volDimKey(row, cfg.dim);
      if (!groups.has(key)) groups.set(key, { key: key, rows: [] });
      groups.get(key).rows.push(row);
    }
    const avgAt = (list,month) => {
      const prices = list.map((row) => {
        const point = (pointsByRow.get(row.sku) || []).find((p) => p.key === month);
        return point ? point.price : null;
      }).filter((p) => p != null);
      return prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : null;
    };
    const groupStats = Array.from(groups.values()).map((group) => {
      const values = months.map((month) => avgAt(group.rows, month));
      const valid = values.filter((v) => v != null);
      const changes = [];
      for (let i = 1; i < values.length; i++) {
        if (values[i] != null && values[i - 1] != null && values[i - 1] !== 0) changes.push(((values[i] - values[i - 1]) / values[i - 1]) * 100);
      }
      const latestIndex = values.length - 1 - values.slice().reverse().findIndex((v) => v != null);
      const latest = latestIndex >= 0 ? values[latestIndex] : null;
      let prev = null;
      for (let i = latestIndex - 1; i >= 0; i--) { if (values[i] != null) { prev = values[i]; break; } }
      return {
        key: group.key,
        count: group.rows.length,
        values: values,
        validCount: valid.length,
        latest: latest,
        prev: prev,
        change: latest != null && prev != null && prev !== 0 ? ((latest - prev) / prev) * 100 : null,
        volatility: stddev(changes)
      };
    }).filter((g) => g.validCount > 0);
    const overallValues = months.map((month) => avgAt(rows, month));
    const monthCoverage = months.map((month) => rows.filter((row) => (pointsByRow.get(row.sku) || []).some((p) => p.key === month)).length);
    const coverageThreshold = Math.max(2, Math.ceil(rows.length * 0.3));
    let marketIndex = -1;
    for (let i = months.length - 1; i >= 0; i--) {
      if (monthCoverage[i] >= coverageThreshold && overallValues[i] != null) { marketIndex = i; break; }
    }
    if (marketIndex < 0) {
      for (let i = months.length - 1; i >= 0; i--) if (overallValues[i] != null) { marketIndex = i; break; }
    }
    let prevOverallIndex = -1;
    for (let i = marketIndex - 1; i >= 0; i--) if (overallValues[i] != null) { prevOverallIndex = i; break; }
    const overallChanges = [];
    for (let i = 1; i < overallValues.length; i++) {
      if (overallValues[i] != null && overallValues[i - 1] != null && overallValues[i - 1] !== 0) overallChanges.push(((overallValues[i] - overallValues[i - 1]) / overallValues[i - 1]) * 100);
    }
    const latestOverall = marketIndex >= 0 ? overallValues[marketIndex] : null;
    const prevOverall = prevOverallIndex >= 0 ? overallValues[prevOverallIndex] : null;
    const skuStats = rows.map((row) => {
      const points = pointsByRow.get(row.sku) || [];
      const prices = points.map((p) => p.price);
      const changes = [];
      for (let i = 1; i < prices.length; i++) if (prices[i - 1]) changes.push(((prices[i] - prices[i - 1]) / prices[i - 1]) * 100);
      let peak = null;
      let maxDrawdown = null;
      for (const p of prices) {
        if (peak == null || p > peak) peak = p;
        if (peak) { const dd = ((p - peak) / peak) * 100; if (maxDrawdown == null || dd < maxDrawdown) maxDrawdown = dd; }
      }
      const first = prices.length ? prices[0] : null;
      const last = prices.length ? prices[prices.length - 1] : null;
      return {
        row: row,
        count: prices.length,
        latest: last,
        base: baselineOf(row).value,
        change: first && last && first !== 0 ? ((last - first) / first) * 100 : null,
        volatility: stddev(changes),
        drawdown: maxDrawdown
      };
    });
    return {
      rows: rows,
      months: months,
      groups: groupStats.sort((a, b) => b.count - a.count),
      overallValues: overallValues,
      latestOverall: latestOverall,
      prevOverall: prevOverall,
      marketMonth: marketIndex >= 0 ? months[marketIndex] : '',
      marketPrevMonth: prevOverallIndex >= 0 ? months[prevOverallIndex] : '',
      overallChange: latestOverall != null && prevOverall != null && prevOverall !== 0 ? ((latestOverall - prevOverall) / prevOverall) * 100 : null,
      overallVolatility: stddev(overallChanges),
      skuStats: skuStats,
      breadth: {
        up: skuStats.filter((s) => s.change != null && s.change > 0.01).length,
        down: skuStats.filter((s) => s.change != null && s.change < -0.01).length,
        flat: skuStats.filter((s) => s.change != null && Math.abs(s.change) <= 0.01).length
      }
    };
  }

  function renderVolChart(months, groupStats, overallValues, metric) {
    const el = $('volChart');
    if (!el) return;
    const chartGroups = groupStats.filter((g) => g.validCount > 0).slice(0, 8);
    const palette = ['#0d9488', '#2563eb', '#7c3aed', '#ea580c', '#db2777', '#0891b2', '#65a30d', '#64748b'];
    const series = [];
    if (overallValues.some((v) => v != null)) {
      series.push({ key: '全市场', values: overallValues, color: '#0f172a', overall: true });
    }
    chartGroups.forEach((g, i) => series.push({ key: g.key, values: g.values, color: palette[i % palette.length] }));
    if (!series.length) { el.innerHTML = '<div class="dash-empty">暂无历史数据</div>'; return; }
    let normalized = series.map((s) => {
      const first = s.values.find((v) => v != null);
      return {
        key: s.key,
        color: s.color,
        overall: s.overall,
        values: metric === 'index' ? s.values.map((v) => (v != null && first ? (v / first) * 100 : null)) : s.values.slice()
      };
    });
    const allValues = normalized.flatMap((s) => s.values).filter((v) => v != null);
    let minV = Math.min.apply(null, allValues);
    let maxV = Math.max.apply(null, allValues);
    if (!isFinite(minV) || !isFinite(maxV)) { minV = 0; maxV = 1; }
    if (maxV === minV) { minV -= metric === 'index' ? 2 : 100; maxV += metric === 'index' ? 2 : 100; }
    const pad = Math.max(metric === 'index' ? 1 : (maxV - minV) * 0.08, 0.5);
    minV -= pad;
    maxV += pad;
    const width = 960;
    const height = 320;
    const padL = 54;
    const padR = 18;
    const padT = 18;
    const padB = 34;
    const n = Math.max(1, months.length);
    const xOf = (i) => padL + (n === 1 ? 0.5 : i / (n - 1)) * (width - padL - padR);
    const yOf = (v) => padT + (1 - (v - minV) / (maxV - minV)) * (height - padT - padB);
    const grid = [];
    for (let i = 0; i <= 4; i++) {
      const v = minV + ((maxV - minV) * i) / 4;
      const y = yOf(v);
      grid.push('<line class="cmp-grid" x1="' + padL + '" y1="' + y.toFixed(1) + '" x2="' + (width - padR) + '" y2="' + y.toFixed(1) + '"></line>' +
        '<text class="cmp-axis" x="' + (padL - 8) + '" y="' + (y + 4).toFixed(1) + '" text-anchor="end">' + (metric === 'index' ? v.toFixed(1) : Math.round(v)) + '</text>');
    }
    const labelEvery = Math.max(1, Math.ceil(months.length / 7));
    const xLabels = months.map((m, i) => (i % labelEvery === 0 || i === months.length - 1)
      ? '<text class="cmp-axis" x="' + xOf(i).toFixed(1) + '" y="' + (height - 10) + '" text-anchor="middle">' + esc(fmtMonth(m)) + '</text>'
      : '').join('');
    const paths = normalized.map((s) => {
      const pts = [];
      s.values.forEach((v, i) => { if (v != null) pts.push(xOf(i).toFixed(1) + ',' + yOf(v).toFixed(1)); });
      if (!pts.length) return '';
      return '<polyline class="cmp-line' + (s.overall ? ' overall' : '') + '" points="' + pts.join(' ') + '" stroke="' + s.color + '"' + (s.overall ? ' stroke-dasharray="6 5"' : '') + '></polyline>';
    }).join('');
    el.innerHTML = '<svg viewBox="0 0 ' + width + ' ' + height + '" preserveAspectRatio="none" class="compare-svg">' + grid.join('') + paths + xLabels + '</svg>';
    const legend = $('volLegend');
    if (legend) legend.innerHTML = normalized.map((s) => '<span class="cmp-legend-item"><i style="background:' + s.color + '"></i>' + esc(s.key) + '</span>').join('');
    const hint = $('volChartHint');
    if (hint) hint.textContent = (metric === 'index' ? '按首月价格归一化为 100；' : '按月度均价；') + '当前维度：' + ({ size: '尺寸段', system: '系统', brand: '品牌', category: '类型' }[state.volatility.dim] || '尺寸段');
  }

  function renderVolatility() {
    const cfg = state.volatility;
    const category = $('volCategory');
    if (category) {
      const values = Array.from(new Set(state.rows.filter((r) => !r.ignored && !r.offline).map((r) => r.category).filter(Boolean))).sort();
      category.innerHTML = '<option value="all">全部类型</option>' + values.map((v) => '<option value="' + esc(v) + '">' + esc(v) + '</option>').join('');
      category.value = cfg.category;
      if (category.value !== cfg.category) { cfg.category = 'all'; category.value = 'all'; }
    }
    if ($('volDim')) $('volDim').value = cfg.dim;
    if ($('volMetric')) $('volMetric').value = cfg.metric;
    if ($('volSort')) $('volSort').value = cfg.sort;
    if ($('volSearch') && $('volSearch').value !== cfg.q) $('volSearch').value = cfg.q;
    const data = volatilityData();
    setText('volAvg', data.latestOverall != null ? money(Math.round(data.latestOverall)) : '—');
    setText('volAvgSub', data.marketMonth ? fmtMonth(data.marketMonth) + ' · 覆盖 ' + data.months.length + ' 个月 / ' + data.rows.length + ' 个 SKU' : '暂无月度数据');
    setText('volChange', data.overallChange != null ? fmtPct(data.overallChange) : '—');
    if ($('volChange')) $('volChange').className = 'kpi-num ' + (data.overallChange < 0 ? 'down' : data.overallChange > 0 ? 'up' : '');
    setText('volChangeSub', data.overallChange != null ? fmtMonth(data.marketMonth) + ' vs ' + fmtMonth(data.marketPrevMonth) : '上月无可比价格');
    setText('volVolatility', data.overallVolatility != null ? data.overallVolatility.toFixed(1) + '%' : '—');
    setText('volVolatilitySub', '月度环比变化的标准差');
    setText('volBreadth', (data.breadth.up || 0) + ' / ' + (data.breadth.down || 0));
    setText('volBreadthSub', '上涨 / 下跌 · 平 ' + data.breadth.flat);

    renderVolChart(data.months, data.groups, data.overallValues, cfg.metric);

    const groupRows = $('volGroupRows');
    if (groupRows) {
      groupRows.innerHTML = data.groups.slice(0, 12).map((g) =>
        '<tr data-vol-group="' + esc(g.key) + '">' +
          '<td class="cell-strong">' + esc(g.key) + '</td>' +
          '<td class="num">' + g.count + '</td>' +
          '<td class="num">' + money(g.latest != null ? Math.round(g.latest) : null) + '</td>' +
          '<td class="num">' + money(g.prev != null ? Math.round(g.prev) : null) + '</td>' +
          '<td class="num ' + (g.change < 0 ? 'down' : g.change > 0 ? 'up' : '') + '">' + (g.change != null ? fmtPct(g.change) : '—') + '</td>' +
          '<td class="num">' + (g.volatility != null ? g.volatility.toFixed(1) + '%' : '—') + '</td>' +
        '</tr>'
      ).join('') || '<tr><td colspan="6" class="muted">暂无数据</td></tr>';
    }

    const top = data.skuStats.filter((s) => s.volatility != null).sort((a, b) => b.volatility - a.volatility).slice(0, 6);
    const topEl = $('volTopSkus');
    if (topEl) {
      topEl.innerHTML = top.map((s) =>
        '<button type="button" class="vol-top-row" data-sku="' + esc(s.row.sku) + '">' +
          '<span class="vt-name">' + esc(s.row.brand + ' ' + (s.row.model || s.row.size || s.row.sku)) + '</span>' +
          '<span class="vt-meta">' + fmtPct(s.change) + ' · ' + s.volatility.toFixed(1) + '%</span>' +
          '<b>' + money(s.latest) + '</b>' +
        '</button>'
      ).join('') || '<div class="dash-empty">暂无足够的历史波动数据</div>';
    }

    renderVolSkuTable(data);
  }

  function renderVolSkuTable(data) {
    const cfg = state.volatility;
    const body = $('volSkuRows');
    if (!body) return;
    let list = data.skuStats.slice();
    const q = (cfg.q || '').toLowerCase();
    if (q) list = list.filter((s) => (s.row.sku + ' ' + s.row.brand + ' ' + s.row.model + ' ' + s.row.series).toLowerCase().includes(q));
    if (cfg.sort === 'change') list.sort((a, b) => (b.change == null ? -Infinity : b.change) - (a.change == null ? -Infinity : a.change));
    else if (cfg.sort === 'drawdown') list.sort((a, b) => (a.drawdown == null ? Infinity : a.drawdown) - (b.drawdown == null ? Infinity : b.drawdown));
    else if (cfg.sort === 'latest') list.sort((a, b) => (b.latest || 0) - (a.latest || 0));
    else list.sort((a, b) => (b.volatility == null ? -1 : b.volatility) - (a.volatility == null ? -1 : a.volatility));
    body.innerHTML = list.map((s) =>
      '<tr data-sku="' + esc(s.row.sku) + '">' +
        '<td><span class="cell-brand"><i class="brand-dot" style="background:' + brandColor(s.row.brand) + '"></i>' + esc(s.row.brand + ' ' + (s.row.model || s.row.size || '')) + '</span></td>' +
        '<td class="sku-cell">' + esc(s.row.sku) + '</td>' +
        '<td class="num">' + money(s.latest) + '</td>' +
        '<td class="num">' + money(s.base) + '</td>' +
        '<td class="num ' + (s.change < 0 ? 'down' : s.change > 0 ? 'up' : '') + '">' + (s.change != null ? fmtPct(s.change) : '—') + '</td>' +
        '<td class="num">' + (s.volatility != null ? s.volatility.toFixed(1) + '%' : '—') + '</td>' +
        '<td class="num">' + (s.drawdown != null ? s.drawdown.toFixed(1) + '%' : '—') + '</td>' +
        '<td class="spark-cell">' + sparkSvg(s.row) + '</td>' +
      '</tr>'
    ).join('');
    setText('volSkuCount', '共 ' + list.length + ' 个 SKU' + (data.months.length ? ' · ' + data.months.length + ' 个月' : ''));
    const empty = $('emptyVol');
    if (empty) empty.classList.toggle('hidden', list.length > 0);
  }

  // ------------------------------------------------------------------ 提示 / 日志
  let toastTimer = null;
  function setToast(text, type) {
    const el = $('toast');
    if (!el) return;
    el.textContent = text;
    el.className = 'toast show' + (type ? ' ' + type : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = 'toast hidden'; }, 3600);
  }

  function logLine(text) {
    const stamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    state.logs.push('[' + stamp + '] ' + text);
    if (state.logs.length > MAX_LOGS) state.logs.shift();
    renderLogs();
  }

  function renderLogs() {
    const tail = state.logs.slice(-9).join('\n');
    const consoleEl = $('runConsole');
    if (consoleEl) consoleEl.textContent = state.logs.length ? state.logs.join('\n') : '[待命] 采集日志会实时显示在这里。';
    const mini = $('runMiniLog');
    if (mini) mini.textContent = state.logs.length ? state.logs[state.logs.length - 1] : '采集日志会显示在这里：只读主价格区，取不到就记录失败，不猜价。';
    const dock = $('dockLog');
    if (dock) dock.textContent = state.logs.slice(-2).join('\n');
    const current = $('currentRunHint');
    if (current) current.textContent = state.running ? '进行中' : '空闲';
    if (consoleEl) consoleEl.scrollTop = consoleEl.scrollHeight;
  }

  // ------------------------------------------------------------------ 视图切换
  const VIEW_META = {
    dashboard: { title: '总览', sub: '竞品价格态势与今日异动' },
    analytics: { title: '分析', sub: '品牌 / 尺寸 / 价格带结构与同尺寸锚点' },
    volatility: { title: '波动', sub: '每个 SKU 的波动与尺寸 / 系统 / 品牌市场趋势' },
    watchlist: { title: '监控清单', sub: '按品牌 / 类型 / 尺寸筛选，选中后批量采集' },
    alerts: { title: '异动中心', sub: '降价、涨价、历史新低与采集异常' },
    runs: { title: '采集任务', sub: '任务进度、日志与历史记录' }
  };

  function switchView(view, opts) {
    if (!VIEW_META[view]) return;
    if (opts && opts.filterStatus) state.ui.status = opts.filterStatus;
    if (opts && opts.band) state.ui.band = opts.band;
    if (state.drawerSku) closeDrawer();
    state.view = view;
    $$('.nav-item').forEach((btn) => btn.classList.toggle('active', btn.dataset.view === view));
    $$('.view').forEach((el) => el.classList.add('hidden'));
    const target = $('view' + view.charAt(0).toUpperCase() + view.slice(1));
    if (target) target.classList.remove('hidden');
    const meta = VIEW_META[view];
    if ($('viewTitle')) $('viewTitle').textContent = meta.title;
    if ($('viewSub')) $('viewSub').textContent = meta.sub;
    if (state.sidebarOpen) toggleSidebar(false);
    if (opts && opts.filterStatus) {
      state.ui.status = opts.filterStatus;
      const sel = $('filterStatus');
      if (sel) sel.value = opts.filterStatus;
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
    renderAll();
  }

  function toggleSidebar(open) {
    state.sidebarOpen = typeof open === 'boolean' ? open : !state.sidebarOpen;
    const side = $('sidebar');
    if (side) side.classList.toggle('open', state.sidebarOpen);
  }

  function renderAll() {
    if (!state.loaded) return;
    renderHeader();
    renderDashboard();
    renderAnalytics();
    renderVolatility();
    renderWatchFilters();
    renderWatchTable();
    renderAlerts();
    renderRuns();
    renderRunUI();
    if (state.drawerSku && state.rowMap.has(state.drawerSku)) renderDrawer();
  }

  // ------------------------------------------------------------------ 头部 / 统计
  function computeStats() {
    const rows = state.rows.filter((r) => !r.ignored);
    const activeRows = rows.filter((r) => !r.offline);
    const today = new Date();
    const todayAlerts = state.db.alerts.filter((a) => isToday(a.at));
    const newAlerts = state.db.alerts.filter((a) => a.status === 'new');
    const capturedToday = activeRows.filter((r) => {
      const latest = latestOf(r);
      return latest && isToday(latest.at);
    }).length;
    const failRows = activeRows.filter((r) => statusOf(r) === 'fail');
    const unavailableRows = activeRows.filter((r) => statusOf(r) === 'unavailable');
    const offlineRows = rows.filter((r) => statusOf(r) === 'offline');
    const reviewRows = activeRows.filter((r) => statusOf(r) === 'review');
    const capturedRows = activeRows.filter((r) => latestOf(r));
    const brands = {};
    for (const row of activeRows) brands[row.brand] = (brands[row.brand] || 0) + 1;
    return {
      total: activeRows.length,
      allRows: rows.length,
      capturedToday: capturedToday,
      coverage: activeRows.length ? Math.round((capturedToday / activeRows.length) * 100) : 0,
      capturedTotal: capturedRows.length,
      todayAlerts: todayAlerts.length,
      newAlerts: newAlerts.length,
      critical: newAlerts.filter((a) => a.level === 'critical').length,
      dropToday: todayAlerts.filter((a) => a.type === 'drop' || a.type === 'newLow').length,
      newLowToday: todayAlerts.filter((a) => a.type === 'newLow').length,
      riseToday: todayAlerts.filter((a) => a.type === 'rise').length,
      failRows: failRows.length,
      unavailableRows: unavailableRows.length,
      offlineRows: offlineRows.length,
      reviewRows: reviewRows.length,
      brands: brands,
      brandCount: Object.keys(brands).length,
      alertTotal: state.db.alerts.length
    };
  }

  function renderHeader() {
    const stats = computeStats();
    if ($('navWatchCount')) $('navWatchCount').textContent = String(stats.total);
    if ($('navAlertCount')) {
      $('navAlertCount').textContent = stats.newAlerts ? String(stats.newAlerts) : '';
      $('navAlertCount').classList.toggle('hot', stats.critical > 0);
    }
    if ($('accountPill')) {
      const account = state.db.settings.lastAccount || state.db.lastAccount || '';
      $('accountPill').innerHTML = '<span class="dot ' + (account ? 'ok' : '') + '"></span>账号：' + esc(account || '未采集');
    }
    if ($('dataPill')) {
      $('dataPill').innerHTML = '<span class="dot ok"></span>今日覆盖 ' + stats.coverage + '% · 已采 ' + stats.capturedTotal + '/' + stats.total;
    }
    if ($('baseInfo')) {
      const meta = (state.base && state.base.meta) || {};
      $('baseInfo').textContent = '监控清单：内置 ' + (meta.count || state.rows.length) + ' 个 · 手动添加 ' + (state.meta.custom || []).length + ' 个' +
        ' · 已下架 ' + stats.offlineRows + ' 个' +
        (meta.generatedAt ? ' · 生成于 ' + fmtDate(meta.generatedAt, false) : '');
    }
    if ($('watchFootInfo')) {
      $('watchFootInfo').textContent = '当前筛选 ' + filteredRows().length + ' 行 / 共 ' + state.rows.length + ' 行';
    }
    if ($('dataSourceNote')) {
      const meta = (state.base && state.base.meta) || {};
      $('dataSourceNote').textContent = '数据源：' + (meta.sourceFile || '线上竞争数据分析（月度）.xlsx') + ' · ' + (meta.sourceSheet || '竞品售价历史（新）');
    }
  }

  function setText(id, value) {
    const el = $(id);
    if (el) el.textContent = value;
  }

  // ------------------------------------------------------------------ 总览
  function renderDashboard() {
    const stats = computeStats();
    const lastRun = state.db.lastRun;
    const running = state.running;

    if ($('heroKicker')) {
      $('heroKicker').textContent = running ? '正在采集' : lastRun ? '最近采集 ' + relTime(lastRun.at) : '监控待命';
    }
    setText('heroBig', String(stats.total));
    const lastCapture = latestCaptureAt();
    setText('heroSub', '监控 ' + stats.total + ' 个在售竞品 · 已下架 ' + stats.offlineRows + ' 个 · 今日覆盖 ' + stats.coverage + '% · ' +
      (lastCapture ? '最近一次成功采集 ' + relTime(lastCapture) : '还没有采集记录，点「开始采集」跑第一批'));

    setText('kpiMonitor', String(stats.total));
    setText('kpiMonitorSub', stats.brandCount + ' 个品牌 · ' + stats.total + ' 个在售 · ' + stats.offlineRows + ' 个下架');
    setText('kpiToday', String(stats.capturedToday));
    setText('kpiTodaySub', '覆盖率 ' + stats.coverage + '% · 待采 ' + Math.max(0, stats.total - stats.capturedToday));
    setText('kpiAlerts', String(stats.newAlerts));
    setText('kpiAlertsSub', '今日 ' + stats.todayAlerts + ' 条 · 紧急 ' + stats.critical);
    setText('kpiDrop', String(stats.dropToday));
    setText('kpiDropSub', '其中历史新低 ' + stats.newLowToday + ' 条');
    setText('kpiRise', String(stats.riseToday));
    setText('kpiRiseSub', '较基准价上涨');
    setText('kpiFail', String(stats.failRows));
    setText('kpiFailSub', '待核对 ' + stats.reviewRows + ' · 不可售 ' + stats.unavailableRows + ' · 下架 ' + stats.offlineRows);

    // 品牌分布
    const brandBars = $('brandBars');
    if (brandBars) {
      const entries = Object.keys(stats.brands).map((brand) => {
        const rows = state.rows.filter((r) => !r.ignored && r.brand === brand);
        const prices = rows.map((r) => currentPrice(r) || baselineOf(r).value).filter((p) => p != null);
        const avg = prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : null;
        return { brand: brand, count: rows.length, avg: avg };
      }).sort((a, b) => b.count - a.count);
      const max = entries.reduce((m, e) => Math.max(m, e.count), 1);
      brandBars.innerHTML = entries.map((e) =>
        '<div class="brand-row">' +
          '<span class="brand-name"><i class="brand-dot" style="background:' + brandColor(e.brand) + '"></i>' + esc(e.brand) + '</span>' +
          '<div class="brand-track"><div class="brand-fill" style="width:' + Math.max(3, Math.round((e.count / max) * 100)) + '%"></div></div>' +
          '<span class="brand-meta">' + e.count + ' 个 · 均 ' + (e.avg ? money(Math.round(e.avg)) : '—') + '</span>' +
        '</div>'
      ).join('') || '<div class="dash-empty">暂无监控数据</div>';
      setText('brandCountHint', entries.length + ' 个品牌');
    }

    // 最新异动
    if ($('dashAlerts')) {
      const list = state.db.alerts.filter((a) => a.status === 'new').sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 5);
      if (!list.length) {
        $('dashAlerts').innerHTML = '<div class="alert-empty">暂无未处理异动。<br>采集后价格变化超过阈值会出现在这里。</div>';
      } else {
        $('dashAlerts').innerHTML = list.map((a) => {
          const row = rowBySku(a.sku);
          const label = row ? (row.brand + ' · ' + (row.model || row.size || row.sku)) : a.sku;
          const meta = ALERT_META[a.type] || ALERT_META.drop;
          return '<button type="button" class="alert-mini" data-sku="' + esc(a.sku) + '">' +
            '<i class="sev ' + esc(a.level) + '"></i>' +
            '<span class="am-main"><span class="am-title">' + esc(label) + '</span><span class="am-sub">' + esc(meta.label + ' · ' + a.message) + '</span></span>' +
            '<span class="am-price">' + (a.to != null ? money(a.to) : '') + '</span>' +
          '</button>';
        }).join('');
      }
    }

    // 价格变动榜
    if ($('dashChangeBody')) {
      const list = state.rows.filter((r) => !r.ignored && latestOf(r) && deltaOf(r) != null)
        .map((r) => ({ row: r, delta: deltaOf(r), latest: latestOf(r) }))
        .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
        .slice(0, 8);
      const empty = $('emptyChanges');
      if (empty) empty.classList.toggle('hidden', list.length > 0);
      $('dashChangeBody').innerHTML = list.map((item) => {
        const row = item.row;
        return '<tr data-sku="' + esc(row.sku) + '">' +
          '<td>' + brandTag(row) + ' <span class="muted">' + esc(row.model || row.size || '') + '</span></td>' +
          '<td class="sku-cell">' + esc(row.sku) + '</td>' +
          '<td class="num">' + money(baselineOf(row).value) + '</td>' +
          '<td class="num price-cell">' + money(item.latest.price) + '</td>' +
          '<td class="num">' + deltaHtml(item.delta) + '</td>' +
          '<td class="time-cell">' + relTime(item.latest.at) + '</td>' +
          '<td class="num"><button type="button" class="row-act" data-act="drawer" data-sku="' + esc(row.sku) + '" title="查看走势"><svg class="icon"><use href="#i-history"/></svg></button></td>' +
        '</tr>';
      }).join('');
    }

    // 采集概况
    if ($('dashRunBrief')) {
      const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
      const weekCaptured = state.rows.filter((r) => !r.ignored && latestOf(r) && new Date(latestOf(r).at).getTime() >= weekAgo).length;
      $('dashRunBrief').innerHTML =
        '<div class="run-brief-grid">' +
          '<div><span>今日已采</span><b>' + stats.capturedToday + '</b><em>/ ' + stats.total + '</em></div>' +
          '<div><span>近 7 天覆盖</span><b>' + weekCaptured + '</b><em>个 SKU</em></div>' +
          '<div><span>未采集</span><b>' + Math.max(0, stats.total - stats.capturedTotal) + '</b><em>个</em></div>' +
          '<div><span>采集异常</span><b class="' + (stats.failRows ? 'warn-text' : '') + '">' + stats.failRows + '</b><em>个</em></div>' +
        '</div>' +
        '<div class="run-brief-actions">' +
          '<button type="button" class="btn primary sm" data-act="start"><svg class="icon"><use href="#i-play"/></svg>开始采集</button>' +
          '<button type="button" class="btn ghost sm" data-act="review"><svg class="icon"><use href="#i-search"/></svg>查看待核对</button>' +
        '</div>';
    }

    // 最近一次任务
    if ($('dashLastRun')) {
      if (!lastRun) {
        $('dashLastRun').innerHTML = '<div class="dash-empty">还没有任务记录。<br>第一次采集完成后会显示汇总。</div>';
      } else {
        const duration = lastRun.durationSec != null ? lastRun.durationSec + ' 秒' : '—';
        $('dashLastRun').innerHTML =
          '<div class="last-run-line"><span>时间</span><b>' + fmtDate(lastRun.at) + '</b></div>' +
          '<div class="last-run-line"><span>模式</span><b>' + (lastRun.mode === 'foreground' ? '前台窗口 + AI' : '后台标签页') + '</b></div>' +
          '<div class="last-run-line"><span>结果</span><b>成功 ' + (lastRun.ok || 0) + ' / 失败 ' + (lastRun.fail || 0) + ' / 共 ' + (lastRun.total || 0) + '</b></div>' +
          '<div class="last-run-line"><span>耗时</span><b>' + duration + '</b>' + (lastRun.account ? '<em>账号 ' + esc(lastRun.account) + '</em>' : '') + '</div>';
      }
    }
    renderDashBands();
    renderDashSizeLowest();
  }

  // ------------------------------------------------------------------ 分析视图
  function renderAnalyticsFilters() {
    const source = state.rows.filter((r) => !r.ignored && !r.offline);
    const cat = $('anaCategory');
    if (cat) {
      const values = Array.from(new Set(source.map((r) => r.category).filter(Boolean))).sort();
      cat.innerHTML = '<option value="all">全部类型</option>' + values.map((v) => '<option value="' + esc(v) + '">' + esc(v) + '</option>').join('');
      cat.value = state.analytics.category;
      if (cat.value !== state.analytics.category) { state.analytics.category = 'all'; cat.value = 'all'; }
    }
    const size = $('anaSize');
    if (size) {
      const values = Array.from(new Set(source.map((r) => sizeKeyOf(r)).filter((v) => v && v !== '其他'))).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
      size.innerHTML = '<option value="all">全部尺寸</option>' + values.map((v) => '<option value="' + esc(v) + '">' + esc(v) + '</option>').join('');
      size.value = state.analytics.size;
      if (size.value !== state.analytics.size) { state.analytics.size = 'all'; size.value = 'all'; }
    }
    if ($('anaBasis')) $('anaBasis').value = state.analytics.basis;
  }

  function renderAnalytics() {
    renderAnalyticsFilters();
    const data = analyticsData();
    const total = data.rows.length;
    const bandTotal = data.bands.items.reduce((sum, item) => sum + item.count, 0);
    const densest = data.bands.items.slice().sort((a, b) => b.count - a.count)[0];

    setText('anaAvg', data.avg != null ? money(Math.round(data.avg)) : '—');
    setText('anaAvgSub', data.rows.length + ' 个在售竞品 · ' + (data.basis === 'base' ? '基准价口径' : '最新价口径'));
    setText('anaMedian', data.median != null ? money(Math.round(data.median)) : '—');
    setText('anaMedianSub', '价格中位数');
    setText('anaBandCount', String(data.bands.items.filter((item) => item.count > 0).length));
    setText('anaBandSub', densest && densest.count ? '最密集：' + densest.band.label + '（' + densest.count + ' 个）' : '暂无可分析价格');
    setText('anaCoverage', data.coverage + '%');
    setText('anaCoverageSub', '有采集记录 ' + data.rows.filter((r) => latestOf(r)).length + ' / ' + total + ' 个');

    // 价格带 donut
    const donut = $('anaDonut');
    if (donut) {
      const items = data.bands.items.filter((item) => item.count > 0);
      let acc = 0;
      const stops = [];
      for (const item of items) {
        const start = acc;
        const end = acc + (item.count / Math.max(1, bandTotal)) * 100;
        stops.push(item.band.color + ' ' + start.toFixed(2) + '% ' + end.toFixed(2) + '%');
        acc = end;
      }
      donut.style.background = bandTotal > 0 ? 'conic-gradient(' + stops.join(',') + ')' : '#eef2f8';
      const center = donut.querySelector('.donut-center b');
      const centerEm = donut.querySelector('.donut-center em');
      if (center) center.textContent = String(bandTotal);
      if (centerEm) centerEm.textContent = '个有价 SKU';
    }
    const legend = $('anaBandLegend');
    if (legend) {
      legend.innerHTML = data.bands.items.map((item) => {
        const share = bandTotal ? Math.round((item.count / bandTotal) * 100) : 0;
        return '<div class="band-legend-row">' +
          '<i style="background:' + item.band.color + '"></i>' +
          '<span class="bl-label">' + esc(item.band.label) + '</span>' +
          '<b>' + item.count + '</b>' +
          '<em>' + share + '%' + (item.avg ? ' · 均 ' + money(Math.round(item.avg)) : '') + '</em>' +
        '</div>';
      }).join('');
      setText('anaBandHint', bandTotal ? bandTotal + ' 个有价 SKU' : '暂无价格');
    }

    // 品牌均价条
    const brandEl = $('anaBrandBars');
    if (brandEl) {
      const brands = data.brands.filter((b) => b.avg != null);
      const maxAvg = Math.max.apply(null, brands.map((b) => b.avg).concat([1]));
      brandEl.innerHTML = brands.length ? brands.map((b) =>
        '<div class="value-bar-row">' +
          '<span class="brand-name"><i class="brand-dot" style="background:' + brandColor(b.brand) + '"></i>' + esc(b.brand) + '</span>' +
          '<div class="value-track"><i style="width:' + Math.max(3, Math.round((b.avg / maxAvg) * 100)) + '%;background:' + brandColor(b.brand) + '"></i></div>' +
          '<span class="value-meta">' + money(Math.round(b.avg)) + '<em>' + b.count + ' 个</em></span>' +
        '</div>'
      ).join('') : '<div class="dash-empty">暂无价格数据</div>';
      setText('anaBrandHint', brands.length + ' 个品牌 · 按均价排序');
    }

    // 热力图
    renderHeatmap(data);

    // 各尺寸价格锚点
    const sizeRows = $('anaSizeRows');
    if (sizeRows) {
      sizeRows.innerHTML = data.sizes.map((s) => {
        const spread = s.min && s.max && s.min > 0 ? '×' + (s.max / s.min).toFixed(1) : '—';
        return '<tr data-size="' + esc(s.key) + '">' +
          '<td class="cell-strong">' + esc(s.key) + '</td>' +
          '<td class="num">' + s.count + '</td>' +
          '<td class="num">' + money(s.avg) + '</td>' +
          '<td class="num">' + money(s.median) + '</td>' +
          '<td><span class="brand-tag">' + esc(s.minRow ? (s.minRow.brand + ' ' + (s.minRow.model || s.minRow.size || '')) : '—') + '</span> <b>' + money(s.min) + '</b></td>' +
          '<td class="num">' + spread + '</td>' +
        '</tr>';
      }).join('') || '<tr><td colspan="6" class="muted">暂无数据</td></tr>';
    }

    // 品牌概览
    const brandRows = $('anaBrandRows');
    if (brandRows) {
      brandRows.innerHTML = data.brands.map((b) =>
        '<tr data-brand="' + esc(b.brand) + '">' +
          '<td><span class="cell-brand"><i class="brand-dot" style="background:' + brandColor(b.brand) + '"></i>' + esc(b.brand) + '</span></td>' +
          '<td class="num">' + b.count + '</td>' +
          '<td class="num">' + money(b.avg) + '</td>' +
          '<td class="num">' + money(b.min) + '</td>' +
          '<td class="num">' + money(b.max) + '</td>' +
          '<td class="num">' + b.coverage + '%</td>' +
        '</tr>'
      ).join('') || '<tr><td colspan="6" class="muted">暂无数据</td></tr>';
    }
  }

  function heatColor(value, min, max) {
    if (value == null || !isFinite(value)) return 'rgba(241,245,249,0.75)';
    const t = max > min ? (value - min) / (max - min) : 0.5;
    const r = Math.round(13 + t * 212);
    const g = Math.round(148 - t * 90);
    const b = Math.round(136 + t * 36);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + (0.10 + t * 0.38).toFixed(2) + ')';
  }

  function renderHeatmap(data) {
    const el = $('anaHeatmap');
    if (!el) return;
    const cols = SIZE_COLUMNS.filter((col) => col.key !== 'other' || data.rows.some((r) => sizeColumnOf(r).key === 'other'));
    const brands = data.brands.slice().sort((a, b) => a.brand.localeCompare(b.brand, 'zh-CN'));
    const cells = [];
    for (const b of brands) {
      for (const col of cols) {
        const rows = b.rows.filter((r) => sizeColumnOf(r).key === col.key);
        const prices = rows.map((r) => rowPrice(r, data.basis)).filter((p) => p != null);
        cells.push({ brand: b.brand, col: col, rows: rows, prices: prices, avg: prices.length ? prices.reduce((a, c) => a + c, 0) / prices.length : null });
      }
    }
    const values = cells.map((c) => c.avg).filter((v) => v != null);
    const min = values.length ? Math.min.apply(null, values) : 0;
    const max = values.length ? Math.max.apply(null, values) : 0;
    el.innerHTML = '<table class="heatmap-table"><thead><tr><th class="row-head">品牌</th>' +
      cols.map((col) => '<th>' + esc(col.label) + '</th>').join('') + '</tr></thead><tbody>' +
      brands.map((b) => '<tr><th class="row-head"><i class="brand-dot" style="background:' + brandColor(b.brand) + '"></i>' + esc(b.brand) + '</th>' +
        cols.map((col) => {
          const cell = cells.find((c) => c.brand === b.brand && c.col.key === col.key);
          const bg = heatColor(cell ? cell.avg : null, min, max);
          const text = cell && cell.avg != null ? money(cell.avg) : '—';
          return '<td class="heat-cell" style="background:' + bg + '" data-heat-brand="' + esc(b.brand) + '" data-heat-size="' + esc(col.key) + '" title="' + esc(b.brand + ' · ' + col.label + (cell && cell.avg != null ? ' · 均价 ' + money(cell.avg) + ' · ' + cell.rows.length + ' 个' : ' · 暂无价格')) + '">' +
            '<b>' + text + '</b>' + (cell && cell.rows.length ? '<em>' + cell.rows.length + ' 个</em>' : '') + '</td>';
        }).join('') + '</tr>').join('') + '</tbody></table>';
  }

  function renderDashBands() {
    const el = $('dashBands');
    if (!el) return;
    const data = analyticsData();
    const bandTotal = data.bands.items.reduce((sum, item) => sum + item.count, 0);
    const maxCount = Math.max.apply(null, data.bands.items.map((item) => item.count).concat([1]));
    el.innerHTML = data.bands.items.map((item) =>
      '<div class="band-mini-row">' +
        '<span class="band-mini-label"><i style="background:' + item.band.color + '"></i>' + esc(item.band.label) + '</span>' +
        '<div class="band-mini-track"><i style="width:' + Math.max(3, Math.round((item.count / maxCount) * 100)) + '%;background:' + item.band.color + '"></i></div>' +
        '<span class="band-mini-count">' + item.count + '<em>' + (bandTotal ? Math.round((item.count / bandTotal) * 100) + '%' : '') + '</em></span>' +
      '</div>'
    ).join('') || '<div class="dash-empty">暂无价格数据</div>';
  }

  function renderDashSizeLowest() {
    const el = $('dashSizeLowest');
    if (!el) return;
    const data = analyticsData();
    const list = data.sizes.filter((s) => s.minRow).sort((a, b) => b.count - a.count).slice(0, 5);
    el.innerHTML = list.map((s) =>
      '<button type="button" class="size-lowest-row" data-size="' + esc(s.key) + '">' +
        '<span class="sl-size">' + esc(s.key) + '<em>' + s.count + ' 个</em></span>' +
        '<span class="sl-brand">' + esc(s.minRow.brand + ' ' + (s.minRow.model || s.minRow.size || '')) + '</span>' +
        '<b>' + money(s.min) + '</b>' +
      '</button>'
    ).join('') || '<div class="dash-empty">暂无价格数据</div>';
  }

  function latestCaptureAt() {    let newest = '';
    for (const sku of Object.keys(state.db.captures)) {
      const latest = state.db.captures[sku].latest;
      if (latest && latest.at && latest.at > newest) newest = latest.at;
    }
    return newest;
  }

  // ------------------------------------------------------------------ 监控清单
  function renderWatchFilters() {
    const chips = $('brandChips');
    if (chips) {
      const counts = {};
      for (const row of state.rows) counts[row.brand] = (counts[row.brand] || 0) + 1;
      const brands = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
      chips.innerHTML = '<button type="button" class="brand-chip ' + (state.ui.brand === 'all' ? 'active' : '') + '" data-brand="all">全部 <i>' + state.rows.length + '</i></button>' +
        brands.map((brand) => '<button type="button" class="brand-chip ' + (state.ui.brand === brand ? 'active' : '') + '" data-brand="' + esc(brand) + '">' + esc(brand) + ' <i>' + counts[brand] + '</i></button>').join('');
    }
    const category = $('filterCategory');
    if (category) {
      const values = Array.from(new Set(state.rows.map((r) => r.category).filter(Boolean))).sort();
      const current = state.ui.category;
      category.innerHTML = '<option value="all">全部类型</option>' + values.map((v) => '<option value="' + esc(v) + '"' + (v === current ? ' selected' : '') + '>' + esc(v) + '</option>').join('');
    }
    const size = $('filterSize');
    if (size) {
      const rows = state.rows.slice().sort((a, b) => (a.inch || 999) - (b.inch || 999));
      const values = Array.from(new Set(rows.map((r) => r.size).filter(Boolean)));
      const current = state.ui.size;
      size.innerHTML = '<option value="all">全部尺寸</option>' + values.map((v) => '<option value="' + esc(v) + '"' + (v === current ? ' selected' : '') + '>' + esc(v) + '</option>').join('');
    }
    if ($('filterStatus')) $('filterStatus').value = state.ui.status;
    const series = $('filterSeries');
    if (series) {
      const values = Array.from(new Set(state.rows.map((r) => r.series).filter(Boolean))).sort((a, b) => String(a).localeCompare(String(b), 'zh-CN'));
      series.innerHTML = '<option value="all">全部系列</option>' + values.map((v) => '<option value="' + esc(v) + '">' + esc(v) + '</option>').join('');
      series.value = state.ui.series;
      if (series.value !== state.ui.series) { state.ui.series = 'all'; series.value = 'all'; }
    }
    const system = $('filterSystem');
    if (system) {
      const values = Array.from(new Set(state.rows.map((r) => r.system).filter(Boolean))).sort();
      system.innerHTML = '<option value="all">全部系统</option>' + values.map((v) => '<option value="' + esc(v) + '">' + esc(v) + '</option>').join('');
      system.value = state.ui.system;
      if (system.value !== state.ui.system) { state.ui.system = 'all'; system.value = 'all'; }
    }
    const band = $('filterBand');
    if (band) {
      band.innerHTML = '<option value="all">全部价格带</option>' + PRICE_BANDS.map((b) => '<option value="' + b.key + '">' + esc(b.label) + '</option>').join('');
      band.value = state.ui.band;
      if (band.value !== state.ui.band) { state.ui.band = 'all'; band.value = 'all'; }
    }
    const tag = $('filterTag');
    if (tag) {
      const values = Array.from(new Set(state.rows.flatMap((r) => (Array.isArray(r.tags) ? r.tags : []).concat(r.custom ? ['手动添加'] : [])).filter(Boolean))).sort();
      tag.innerHTML = '<option value="all">全部标签</option>' + values.map((v) => '<option value="' + esc(v) + '">' + esc(v) + '</option>').join('');
      tag.value = state.ui.tag;
      if (tag.value !== state.ui.tag) { state.ui.tag = 'all'; tag.value = 'all'; }
    }
    if ($('densityBtn')) $('densityBtn').textContent = state.ui.density === 'compact' ? '舒适' : '紧凑';
    if ($('hideOfflineChk')) $('hideOfflineChk').checked = !!state.ui.hideOffline;
    if ($('searchInput') && $('searchInput').value !== state.ui.q) $('searchInput').value = state.ui.q;
  }

  function filteredRows() {
    let rows = state.rows.slice();
    const ui = state.ui;
    if (ui.hideOffline) rows = rows.filter((r) => !r.offline);
    if (ui.brand !== 'all') rows = rows.filter((r) => r.brand === ui.brand);
    if (ui.category !== 'all') rows = rows.filter((r) => r.category === ui.category);
    if (ui.size !== 'all') rows = rows.filter((r) => r.size === ui.size);
    if (ui.series !== 'all') rows = rows.filter((r) => r.series === ui.series);
    if (ui.system !== 'all') rows = rows.filter((r) => r.system === ui.system);
    if (ui.band !== 'all') rows = rows.filter((r) => { const band = priceBandOfRow(r, 'latest'); return band && band.key === ui.band; });
    if (ui.tag !== 'all') rows = rows.filter((r) => (Array.isArray(r.tags) && r.tags.indexOf(ui.tag) >= 0) || (ui.tag === '手动添加' && r.custom));
    if (ui.status !== 'all') {
      rows = rows.filter((r) => statusOf(r) === ui.status);
    }
    if (ui.q) {
      const q = ui.q.toLowerCase();
      rows = rows.filter((r) => (r.sku + ' ' + r.brand + ' ' + r.model + ' ' + r.series + ' ' + r.size + ' ' + r.category + ' ' + r.system + ' ' + r.note).toLowerCase().includes(q));
    }
    return sortRows(rows);
  }

  function sortRows(rows) {
    const key = state.ui.sort;
    const dir = state.ui.dir === 'asc' ? 1 : -1;
    const rank = { alert: 0, review: 1, fail: 2, unavailable: 3, captured: 4, never: 5, offline: 6, ignored: 7 };
    const bandRank = (row) => {
      const band = priceBandOfRow(row, 'latest');
      return band ? PRICE_BANDS.findIndex((b) => b.key === band.key) : 99;
    };
    const numOf = (value) => (value == null || !isFinite(Number(value)) ? null : Number(value));
    return rows.slice().sort((a, b) => {
      let av;
      let bv;
      if (key === 'brand') { av = a.brand; bv = b.brand; }
      else if (key === 'category') { av = a.category; bv = b.category; }
      else if (key === 'size') { av = a.inch || 999; bv = b.inch || 999; }
      else if (key === 'sku') { av = a.sku; bv = b.sku; }
      else if (key === 'base') { av = numOf(baselineOf(a).value); bv = numOf(baselineOf(b).value); }
      else if (key === 'latest') { av = numOf(currentPrice(a)); bv = numOf(currentPrice(b)); }
      else if (key === 'delta') { av = numOf(deltaOf(a)); bv = numOf(deltaOf(b)); }
      else if (key === 'band') { av = bandRank(a); bv = bandRank(b); }
      else if (key === 'peer') { av = numOf(peerStats(a, 'latest').diff); bv = numOf(peerStats(b, 'latest').diff); }
      else if (key === 'status') { av = rank[statusOf(a)]; bv = rank[statusOf(b)]; }
      else {
        const la = latestOf(a);
        const lb = latestOf(b);
        av = la ? new Date(la.at).getTime() : 0;
        bv = lb ? new Date(lb.at).getTime() : 0;
      }
      if (typeof av === 'string' || typeof bv === 'string') {
        return String(av).localeCompare(String(bv), 'zh-CN') * dir;
      }
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return (av - bv) * dir;
    });
  }

  function updateSortIndicators() {
    $$('#watchTable thead th.sortable').forEach((th) => {
      const active = th.dataset.sort === state.ui.sort;
      th.classList.toggle('sorted', active);
      th.classList.toggle('asc', active && state.ui.dir === 'asc');
    });
  }

  function sparkSvg(row) {
    const points = allHistory(row).slice(-10);
    if (points.length < 2) return '<span class="muted">—</span>';
    const w = 64;
    const h = 20;
    const pad = 2;
    const values = points.map((p) => p.price);
    const min = Math.min.apply(null, values);
    const max = Math.max.apply(null, values);
    const span = max - min || 1;
    const coords = points.map((p, i) => {
      const x = pad + (i / (points.length - 1)) * (w - pad * 2);
      const y = h - pad - ((p.price - min) / span) * (h - pad * 2);
      return [Math.round(x * 10) / 10, Math.round(y * 10) / 10];
    });
    const line = coords.map((c) => c[0] + ',' + c[1]).join(' ');
    const area = coords[0][0] + ',' + (h - pad) + ' ' + line + ' ' + coords[coords.length - 1][0] + ',' + (h - pad);
    const tone = points[points.length - 1].price < points[0].price ? 'down' : points[points.length - 1].price > points[0].price ? 'up' : '';
    const last = coords[coords.length - 1];
    return '<svg class="spark" viewBox="0 0 64 22" preserveAspectRatio="none" aria-hidden="true">' +
      '<polygon class="fill ' + tone + '" points="' + area + '"></polygon>' +
      '<polyline class="line ' + tone + '" points="' + line + '"></polyline>' +
      '<circle class="dot" cx="' + last[0] + '" cy="' + last[1] + '" r="1.7"></circle>' +
    '</svg>';
  }

  function renderWatchTable() {
    const tbody = $('watchTableBody');
    if (!tbody) return;
    const rows = filteredRows();
    const empty = $('emptyWatch');
    if (empty) empty.classList.toggle('hidden', rows.length > 0);
    tbody.innerHTML = rows.map((row) => {
      const latest = latestOf(row);
      const base = baselineOf(row);
      const delta = deltaOf(row);
      const status = statusOf(row);
      const checked = state.selected.has(row.sku);
      const peer = peerStats(row, 'latest');
      const band = priceBandOfRow(row, 'latest');
      const confirmTag = latest ? (isLatestRecorded(row) ? ' · 已记录' : ' · 待记录') : '';
      const peerHtml = peer.rank && peer.count ? '<b>' + peer.rank + '/' + peer.count + '</b><em class="' + (peer.diff < 0 ? 'down' : peer.diff > 0 ? 'up' : '') + '">' + (peer.diff == null ? '' : (peer.diff > 0 ? '+' : '') + peer.diff.toFixed(1) + '%') + '</em>' : '<span class="muted">—</span>';
      return '<tr data-sku="' + esc(row.sku) + '" class="' + (checked ? 'selected' : '') + (row.ignored ? ' ignored' : '') + '">' +
        '<td class="col-check"><input type="checkbox" data-check="' + esc(row.sku) + '"' + (checked ? ' checked' : '') + '></td>' +
        '<td>' + brandTag(row) + '</td>' +
        '<td>' + esc(row.category || '—') + '</td>' +
        '<td class="cell-size">' + esc(row.size || '—') + '<em>' + esc(row.system || '') + '</em></td>' +
        '<td class="cell-model" title="' + esc(row.model || row.series || '') + '">' + esc(row.model || row.series || '—') + '</td>' +
        '<td class="sku-cell">' + esc(row.sku) + '</td>' +
        '<td class="num price-cell">' + (base.value != null ? money(base.value) : '—') + '<span class="kind">' + (base.source === 'manual' ? '手动' : (base.source === 'confirmed' || base.source === 'record') ? '记录表' : base.source === 'import' ? '导入价' : base.source === 'capture' ? '首次采集' : '') + '</span></td>' +
        '<td class="num price-cell">' + (latest ? money(latest.price) : '—') + (latest ? '<span class="kind">' + kindBadge(latest.kind) + confirmTag + '</span>' : '') + '</td>' +
        '<td class="num">' + (delta != null ? deltaHtml(delta) : '<span class="muted">—</span>') + '</td>' +
        '<td>' + (band ? '<span class="band-pill" style="--band-color:' + band.color + '">' + esc(band.label) + '</span>' : '<span class="muted">—</span>') + '</td>' +
        '<td class="peer-cell">' + peerHtml + '</td>' +
        '<td class="spark-cell">' + sparkSvg(row) + '</td>' +
        '<td class="time-cell" title="' + (latest ? fmtDate(latest.at) : '') + '">' + (latest ? relTime(latest.at) : '—') + '</td>' +
        '<td>' + statusBadge(status) + (latest && latest.confidence === 'low' ? ' <span class="kind-badge ai">低置信</span>' : '') + '</td>' +
        '<td class="col-op"><div class="row-actions">' +
          '<button type="button" class="row-act" data-act="capture" data-sku="' + esc(row.sku) + '" title="立即采集"><svg class="icon"><use href="#i-play"/></svg></button>' +
          '<button type="button" class="row-act" data-act="preview" data-sku="' + esc(row.sku) + '" title="悬停预览商品页"><svg class="icon"><use href="#i-eye"/></svg></button>' +
          '<button type="button" class="row-act" data-act="drawer" data-sku="' + esc(row.sku) + '" title="价格走势与详情"><svg class="icon"><use href="#i-history"/></svg></button>' +
        '</div></td>' +
      '</tr>';
    }).join('');
    if ($('watchTable')) $('watchTable').classList.toggle('dense', state.ui.density === 'compact');
    if ($('watchCaption')) {
      $('watchCaption').innerHTML = '共 <b>' + rows.length + '</b> 行' + (rows.length !== state.rows.length ? ' / 全部 ' + state.rows.length + ' 行' : '') +
        ' · 已选 ' + state.selected.size + ' 行';
    }
    if ($('watchFootInfo')) {
      $('watchFootInfo').textContent = '当前筛选 ' + rows.length + ' 行 / 共 ' + state.rows.length + ' 行 · 勾选 ' + state.selected.size + ' 行';
    }
    if ($('selectAllChk')) {
      $('selectAllChk').checked = rows.length > 0 && rows.every((r) => state.selected.has(r.sku));
      $('selectAllChk').indeterminate = !$('selectAllChk').checked && rows.some((r) => state.selected.has(r.sku));
    }
    updateSelectionButtons();
    updateSortIndicators();
    renderHeaderCountsOnly();
  }

  function renderHeaderCountsOnly() {
    const stats = computeStats();
    if ($('watchFootInfo')) $('watchFootInfo').textContent = '当前筛选 ' + filteredRows().length + ' 行 / 共 ' + state.rows.length + ' 行 · 勾选 ' + state.selected.size + ' 行';
    if ($('navWatchCount')) $('navWatchCount').textContent = String(stats.total);
  }

  function updateSelectionButtons() {
    const btn = $('collectSelectedBtn');
    if (btn) btn.disabled = state.selected.size === 0 || state.running;
    const compare = $('compareSelectedBtn');
    const canCompare = state.selected.size >= 2 && state.selected.size <= 4;
    if (compare) compare.disabled = !canCompare;
    if ($('compareSelectedBarBtn')) $('compareSelectedBarBtn').disabled = !canCompare;
    if ($('collectSelectedBarBtn')) $('collectSelectedBarBtn').disabled = state.selected.size === 0 || state.running;
    const bar = $('selectionBar');
    if (bar) {
      bar.classList.toggle('hidden', state.selected.size === 0);
      const text = $('selectionText');
      if (text) text.textContent = '已选 ' + state.selected.size + ' 个' + (state.selected.size === 1 ? ' · 再选 1 个可对比' : state.selected.size > 4 ? ' · 对比最多 4 个' : '');
    }
  }

  // ------------------------------------------------------------------ 对比
  function compareRows() {
    return Array.from(state.selected).map((sku) => rowBySku(sku)).filter(Boolean).slice(0, 4);
  }

  function openCompare() {
    if (state.selected.size > 4) { setToast('最多同时对比 4 个 SKU', 'warn'); return; }
    const rows = compareRows();
    if (rows.length < 2) { setToast('至少勾选 2 个 SKU 才能对比', 'warn'); return; }
    const dialog = $('compareDialog');
    if (!dialog) return;
    renderCompare();
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.classList.add('open');
  }

  function closeCompare() {
    const dialog = $('compareDialog');
    if (!dialog) return;
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.classList.remove('open');
  }

  function renderCompare() {
    const rows = compareRows();
    const palette = ['#0d9488', '#2563eb', '#7c3aed', '#ea580c'];
    const series = rows.map((row, i) => {
      const base = baselineOf(row).value;
      const points = allHistory(row).filter((p) => p.price != null).map((p) => ({
        t: new Date(p.at).getTime(),
        v: base ? (Number(p.price) / Number(base)) * 100 : null,
        price: Number(p.price)
      })).filter((p) => p.v != null && isFinite(p.t));
      return { row: row, base: base, points: points, color: palette[i % palette.length] };
    });
    const allTimes = series.flatMap((s) => s.points.map((p) => p.t));
    const allValues = series.flatMap((s) => s.points.map((p) => p.v));
    const width = 880;
    const height = 300;
    const padL = 48;
    const padR = 18;
    const padT = 18;
    const padB = 30;
    let minT = allTimes.length ? Math.min.apply(null, allTimes) : Date.now() - 86400000;
    let maxT = allTimes.length ? Math.max.apply(null, allTimes) : Date.now();
    if (minT === maxT) { minT -= 86400000; maxT += 86400000; }
    let minV = allValues.length ? Math.min.apply(null, allValues) : 90;
    let maxV = allValues.length ? Math.max.apply(null, allValues) : 110;
    const span = Math.max(4, maxV - minV);
    minV = Math.floor(minV - span * 0.15);
    maxV = Math.ceil(maxV + span * 0.15);
    const xOf = (t) => padL + ((t - minT) / (maxT - minT)) * (width - padL - padR);
    const yOf = (v) => padT + (1 - (v - minV) / (maxV - minV)) * (height - padT - padB);
    const grid = [];
    for (let i = 0; i <= 4; i++) {
      const v = minV + ((maxV - minV) * i) / 4;
      const y = yOf(v);
      grid.push('<line class="cmp-grid" x1="' + padL + '" y1="' + y.toFixed(1) + '" x2="' + (width - padR) + '" y2="' + y.toFixed(1) + '"></line>' +
        '<text class="cmp-axis" x="' + (padL - 8) + '" y="' + (y + 4).toFixed(1) + '" text-anchor="end">' + v.toFixed(1) + '</text>');
    }
    const paths = series.map((s) => {
      if (!s.points.length) return '';
      const pts = s.points.slice().sort((a, b) => a.t - b.t);
      const line = pts.map((p) => (xOf(p.t).toFixed(1) + ',' + yOf(p.v).toFixed(1))).join(' ');
      const dots = pts.map((p) => '<circle cx="' + xOf(p.t).toFixed(1) + '" cy="' + yOf(p.v).toFixed(1) + '" r="2.6" fill="' + s.color + '"></circle>').join('');
      return '<polyline class="cmp-line" points="' + line + '" stroke="' + s.color + '"></polyline>' + dots;
    }).join('');
    const dateLabel = (t) => new Date(t).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
    const chart = $('compareChart');
    if (chart) {
      chart.innerHTML = '<svg viewBox="0 0 ' + width + ' ' + height + '" preserveAspectRatio="none" class="compare-svg">' +
        grid.join('') + paths +
        '<text class="cmp-axis" x="' + padL + '" y="' + (height - 8) + '">' + dateLabel(minT) + '</text>' +
        '<text class="cmp-axis" x="' + (width - padR) + '" y="' + (height - 8) + '" text-anchor="end">' + dateLabel(maxT) + '</text>' +
        '</svg>';
    }
    const legend = $('compareLegend');
    if (legend) {
      legend.innerHTML = series.map((s) => '<span class="cmp-legend-item"><i style="background:' + s.color + '"></i>' + esc(s.row.brand + ' ' + (s.row.model || s.row.size || s.row.sku)) + '</span>').join('');
    }
    const body = $('compareTableBody');
    if (body) {
      body.innerHTML = series.map((s) => {
        const row = s.row;
        const latest = latestOf(row);
        const base = baselineOf(row).value;
        const delta = latest && base ? ((latest.price - base) / base) * 100 : null;
        const peer = peerStats(row, 'latest');
        const stats = historyStats(row);
        return '<tr>' +
          '<td><span class="cell-brand"><i class="brand-dot" style="background:' + s.color + '"></i>' + esc(row.brand + ' ' + (row.model || row.size || row.sku)) + '</span></td>' +
          '<td class="num">' + (latest ? money(latest.price) : '—') + '</td>' +
          '<td class="num">' + money(base) + '</td>' +
          '<td class="num">' + (delta != null ? fmtPct(delta) : '—') + '</td>' +
          '<td class="num">' + (peer.rank ? peer.rank + '/' + peer.count : '—') + '</td>' +
          '<td class="num">' + money(stats.low) + '</td>' +
        '</tr>';
      }).join('');
    }
    setText('compareHint', '以各自基准价 = 100 归一化；' + series.length + ' 个 SKU 的相对走势对比。');
  }

  // ------------------------------------------------------------------ 异动中心
  function alertCounts() {
    const counts = { new: 0, handled: 0, ignored: 0, all: state.db.alerts.length };
    for (const a of state.db.alerts) {
      if (a.status === 'new') counts.new++;
      else if (a.status === 'handled') counts.handled++;
      else if (a.status === 'ignored') counts.ignored++;
    }
    return counts;
  }

  function renderAlerts() {
    const counts = alertCounts();
    setText('alertTabNew', String(counts.new));
    setText('alertTabHandled', String(counts.handled));
    setText('alertTabIgnored', String(counts.ignored));
    setText('alertTabAll', String(counts.all));
    $$('.alert-tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.status === state.alertFilter));
    if ($('alertTypeFilter')) $('alertTypeFilter').value = state.alertType;
    if ($('alertLevelFilter')) $('alertLevelFilter').value = state.alertLevel;
    const listEl = $('alertList');
    if (!listEl) return;
    const list = state.db.alerts
      .filter((a) => (state.alertFilter === 'all' ? true : a.status === state.alertFilter))
      .filter((a) => state.alertType === 'all' || a.type === state.alertType)
      .filter((a) => state.alertLevel === 'all' || a.level === state.alertLevel)
      .sort((a, b) => new Date(b.at) - new Date(a.at));
    const empty = $('emptyAlerts');
    if (empty) empty.classList.toggle('hidden', list.length > 0);
    if ($('markAllReadBtn')) $('markAllReadBtn').disabled = counts.new === 0;
    listEl.innerHTML = list.map((a) => {
      const row = rowBySku(a.sku);
      const label = row ? (row.brand + ' · ' + (row.model || row.size || row.sku)) : a.sku;
      const meta = ALERT_META[a.type] || ALERT_META.drop;
      const cls = 'alert-item ' + esc(a.level) + (a.status === 'new' ? ' unread' : '') + (a.status === 'ignored' ? ' ignored' : '');
      const pct = a.pct != null ? fmtPct(a.pct) : '';
      const tone = pctTone(a.pct);
      const actions = a.status === 'new'
        ? '<button type="button" class="btn ghost" data-act="handle" data-alert="' + esc(a.id) + '">标记已处理</button>' +
          '<button type="button" class="btn ghost danger" data-act="ignore" data-alert="' + esc(a.id) + '">忽略</button>'
        : a.status === 'handled'
          ? '<button type="button" class="btn ghost" data-act="reopen" data-alert="' + esc(a.id) + '">重新打开</button>'
          : '<button type="button" class="btn ghost" data-act="reopen" data-alert="' + esc(a.id) + '">恢复提醒</button>';
      return '<article class="' + cls + '">' +
        '<div class="a-icon"><svg class="icon"><use href="#' + meta.icon + '"/></svg></div>' +
        '<div class="a-main">' +
          '<div class="a-title">' + esc(meta.label) + ' · ' + esc(label) + '<span class="a-sku">' + esc(a.sku) + '</span></div>' +
          '<div class="a-desc">' + esc(a.message) + '</div>' +
          (a.from != null || a.to != null
            ? '<div class="a-prices">' +
                '<span class="arrow">基准 ' + (a.base != null ? money(a.base) : '—') + '</span>' +
                '<span class="arrow">→</span><span>' + (a.from != null ? money(a.from) : '—') + '</span>' +
                '<span class="arrow">→</span><b>' + (a.to != null ? money(a.to) : '—') + '</b>' +
                (pct ? '<span class="pct ' + tone + '">' + pct + '</span>' : '') +
              '</div>'
            : '') +
          '<div class="a-time">' + fmtDate(a.at) + (a.status === 'handled' ? ' · 已处理' : a.status === 'ignored' ? ' · 已忽略' : '') + '</div>' +
        '</div>' +
        '<div class="a-actions">' +
          '<button type="button" class="btn ghost" data-act="view" data-alert="' + esc(a.id) + '">查看走势</button>' +
          actions +
        '</div>' +
      '</article>';
    }).join('');
  }

  function updateAlert(id, status) {
    const alert = state.db.alerts.find((a) => a.id === id);
    if (!alert) return;
    alert.status = status;
    alert.handledAt = status === 'handled' ? new Date().toISOString() : alert.handledAt || null;
    saveDb();
    renderAll();
    setToast(status === 'handled' ? '已标记处理' : status === 'ignored' ? '已忽略这条异动' : '已恢复为未处理', 'success');
  }

  function markAllAlertsHandled() {
    const now = new Date().toISOString();
    let count = 0;
    for (const a of state.db.alerts) {
      if (a.status === 'new') { a.status = 'handled'; a.handledAt = now; count++; }
    }
    if (!count) return;
    saveDb();
    renderAll();
    setToast('已把 ' + count + ' 条异动标记为已处理', 'success');
  }

  // ------------------------------------------------------------------ 采集任务
  function renderRuns() {
    const tbody = $('runHistoryBody');
    if (!tbody) return;
    const runs = state.db.runs || [];
    const empty = $('emptyRuns');
    if (empty) empty.classList.toggle('hidden', runs.length > 0);
    tbody.innerHTML = runs.map((run) => {
      const duration = run.durationSec != null ? run.durationSec + 's' : '—';
      return '<tr>' +
        '<td class="time-cell">' + fmtDate(run.at) + '</td>' +
        '<td>' + (run.mode === 'foreground' ? '前台 + AI' : '后台标签页') + '</td>' +
        '<td class="num">' + (run.total || 0) + '</td>' +
        '<td class="num">' + (run.ok || 0) + '</td>' +
        '<td class="num">' + (run.fail || 0) + '</td>' +
        '<td>' + esc(run.account || '—') + '</td>' +
        '<td>' + duration + (run.stopped ? ' · 手动停止' : '') + '</td>' +
      '</tr>';
    }).join('');
  }

  function renderRunUI() {
    const run = state.run;
    const running = state.running;
    const stats = computeStats();
    if ($('startRunBtn')) $('startRunBtn').disabled = running;
    if ($('recheckBtn')) $('recheckBtn').disabled = running;
    if ($('pauseRunBtn')) {
      $('pauseRunBtn').disabled = !running;
      $('pauseRunBtn').innerHTML = '<svg class="icon"><use href="#' + (state.paused ? 'i-play' : 'i-pause') + '"/></svg>' + (state.paused ? '继续' : '暂停');
    }
    if ($('stopRunBtn')) $('stopRunBtn').disabled = !running;
    renderConfirmRunBtn();
    renderRecordsBtn();
    if ($('collectSelectedBtn')) $('collectSelectedBtn').disabled = state.selected.size === 0 || running;
    if ($('navRunDot')) $('navRunDot').classList.toggle('hidden', !running);
    if ($('runModeSeg')) {
      $$('.seg-btn', $('runModeSeg')).forEach((btn) => btn.classList.toggle('active', btn.dataset.mode === state.db.settings.mode));
    }
    if ($('runBatch') && document.activeElement !== $('runBatch')) $('runBatch').value = String(state.db.settings.batch);

    const total = run ? run.tasks.length : 0;
    const done = run ? run.done : 0;
    const pct = total ? Math.round((done / total) * 100) : 0;
    const progressText = run
      ? (state.paused ? '已暂停：' : state.stopped ? '已停止：' : '采集中：') + done + ' / ' + total + '（' + pct + '%）· 成功 ' + run.ok + ' · 失败 ' + run.fail
      : '尚未开始';
    if ($('runProgressFill')) $('runProgressFill').style.width = pct + '%';
    if ($('runProgressText')) $('runProgressText').textContent = progressText;

    // 悬浮任务卡
    const dock = $('runDock');
    if (dock) {
      dock.classList.toggle('hidden', !running);
      dock.classList.toggle('collapsed', state.dockCollapsed);
      if (running) {
        const task = run.tasks[run.idx];
        setText('dockTitle', state.paused ? '采集已暂停' : '采集进行中');
        if ($('dockFill')) $('dockFill').style.width = pct + '%';
        setText('dockText', (task ? '当前 ' + task.sku : '准备中') + ' · ' + done + '/' + total + ' · 成功 ' + run.ok);
        setText('dockPct', pct + '%');
        if ($('dockPause')) $('dockPause').textContent = state.paused ? '继续' : '暂停';
        setText('dockLog', state.logs.slice(-2).join('\n'));
      }
    }

    // 采集任务页
    const ring = $('currentRing');
    if ($('currentRunPanel')) {
      if (running) {
        setText('currentRunHint', state.paused ? '已暂停' : '进行中');
        setText('currentRunTitle', (state.paused ? '已暂停 · ' : '正在采集 · ') + (run.tasks[run.idx] ? run.tasks[run.idx].sku : '准备中'));
        setText('currentRunSub', '模式：' + (run.mode === 'foreground' ? '前台窗口 + AI' : '后台标签页') + ' · 任务 ' + total + ' 个 · 可随时暂停或停止');
        if (ring) { ring.style.setProperty('--pct', pct); setText('currentRingText', pct + '%'); }
        if ($('currentRunBar')) $('currentRunBar').style.width = pct + '%';
        if ($('currentRunStats')) {
          $('currentRunStats').innerHTML = '<span>已处理 <b>' + done + '</b></span><span>成功 <b>' + run.ok + '</b></span><span>失败 <b>' + run.fail + '</b></span><span>账号 <b>' + esc(run.accountLabel || '识别中…') + '</b></span>';
        }
      } else {
        const last = state.db.lastRun;
        setText('currentRunHint', '空闲');
        if (last) {
          const okPct = last.total ? Math.round(((last.ok || 0) / last.total) * 100) : 0;
          setText('currentRunTitle', '最近一次任务：' + fmtDate(last.at));
          setText('currentRunSub', (last.mode === 'foreground' ? '前台窗口 + AI' : '后台标签页') + ' · 共 ' + last.total + ' 个 · 成功 ' + (last.ok || 0) + ' · 失败 ' + (last.fail || 0) + (last.stopped ? ' · 手动停止' : ''));
          if (ring) { ring.style.setProperty('--pct', okPct); setText('currentRingText', okPct + '%'); }
          if ($('currentRunBar')) $('currentRunBar').style.width = okPct + '%';
          if ($('currentRunStats')) {
            $('currentRunStats').innerHTML = '<span>成功率 <b>' + okPct + '%</b></span><span>耗时 <b>' + (last.durationSec != null ? last.durationSec + 's' : '—') + '</b></span><span>账号 <b>' + esc(last.account || '—') + '</b></span>';
          }
        } else {
          setText('currentRunTitle', '尚未开始采集');
          setText('currentRunSub', '在「监控清单」里选择范围后开始采集；也可以直接点右上角「开始采集」。');
          if (ring) { ring.style.setProperty('--pct', 0); setText('currentRingText', '0%'); }
          if ($('currentRunBar')) $('currentRunBar').style.width = '0%';
          if ($('currentRunStats')) $('currentRunStats').innerHTML = '<span>监控 <b>' + stats.total + '</b> 个 SKU</span><span>今日已采 <b>' + stats.capturedToday + '</b></span><span>未处理异动 <b>' + stats.newAlerts + '</b></span>';
        }
      }
    }
  }

  // ------------------------------------------------------------------ 抽屉：价格详情
  function openDrawer(sku) {
    const row = rowBySku(sku);
    if (!row) return;
    state.drawerSku = row.sku;
    renderDrawer();
    const drawer = $('drawer');
    const mask = $('drawerMask');
    if (mask) mask.classList.remove('hidden');
    if (drawer) {
      drawer.classList.add('show');
      drawer.setAttribute('aria-hidden', 'false');
    }
    document.body.classList.add('drawer-open');
    if (mask) requestAnimationFrame(() => mask.classList.add('show'));
    closePreview(false);
  }

  function closeDrawer() {
    state.drawerSku = null;
    document.body.classList.remove('drawer-open');
    const drawer = $('drawer');
    const mask = $('drawerMask');
    if (drawer) {
      drawer.classList.remove('show');
      drawer.setAttribute('aria-hidden', 'true');
    }
    if (mask) {
      mask.classList.remove('show');
      setTimeout(() => { if (!state.drawerSku) mask.classList.add('hidden'); }, 220);
    }
  }

  function renderDrawer() {
    const row = rowBySku(state.drawerSku);
    if (!row) { closeDrawer(); return; }
    const latest = latestOf(row);
    const base = baselineOf(row);
    const delta = deltaOf(row);
    const stats = historyStats(row);
    const cap = captureOf(row);
    const tags = $('drawerTags');
    if (tags) {
      tags.innerHTML = [
        '<span class="brand-tag" style="background:' + brandColor(row.brand) + '1a;color:' + brandColor(row.brand) + '">' + esc(row.brand) + '</span>',
        row.category ? '<span class="brand-tag">' + esc(row.category) + '</span>' : '',
        row.size ? '<span class="brand-tag">' + esc(row.size) + '</span>' : '',
        row.system ? '<span class="brand-tag">' + esc(row.system) + '</span>' : '',
        priceBandOfRow(row, 'latest') ? '<span class="brand-tag">' + esc(priceBandOfRow(row, 'latest').label) + '</span>' : '',
        row.custom ? '<span class="brand-tag">手动添加</span>' : '',
        row.offline ? '<span class="brand-tag" style="color:#b45309">已下架</span>' : '',
        row.ignored ? '<span class="brand-tag" style="color:#94a3b8">已忽略</span>' : ''
      ].join('');
    }
    setText('drawerModel', row.model || row.series || (row.brand + ' ' + row.size) || row.sku);
    setText('drawerSku', 'SKU ' + row.sku);
    if ($('drawerSku')) $('drawerSku').dataset.sku = row.sku;
    if ($('drawerKind')) {
      $('drawerKind').innerHTML = latest ? '当前口径：' + kindBadge(latest.kind) : '尚未采集';
    }
    setText('drawerPrice', latest ? num(latest.price) : '—');
    const deltaEl = $('drawerDelta');
    if (deltaEl) {
      if (delta == null) {
        deltaEl.className = 'price-delta flat';
        deltaEl.textContent = '无基准价';
      } else {
        const tone = pctTone(delta);
        deltaEl.className = 'price-delta ' + tone;
        deltaEl.textContent = (tone === 'down' ? '↓ ' : tone === 'up' ? '↑ ' : '') + Math.abs(delta).toFixed(1) + '% vs 基准';
      }
    }
    let metaText;
    if (latest) {
      metaText = '采集于 ' + fmtDate(latest.at) + ' · 账号 ' + (latest.account || '—') + ' · 置信度 ' + (latest.confidence === 'high' ? '高' : latest.confidence === 'medium' ? '中' : '低') +
        (isLatestRecorded(row) ? ' · 已写入记录表' : ' · 待写入记录表（写入后成为下期基准）') +
        (latest.priceChanges && latest.priceChanges.length ? ' · 页面价格刷新 ' + latest.priceChanges.length + ' 次' : '');
    } else if (row.offline) {
      metaText = '已标记为下架，不参与自动采集；可点「恢复上架」重新加入监控。';
    } else if (cap && cap.fail) {
      metaText = '最近采集失败：' + cap.fail.reason + '（' + fmtDate(cap.fail.at) + '）';
    } else {
      metaText = '尚未采集；基准价来自导入历史 / 手动设置';
    }
    setText('drawerPriceMeta', metaText);

    setText('drawerBase', base.value != null ? money(base.value) : '—');
    setText('drawerBaseSrc', base.source === 'manual' ? '手动设置' : (base.source === 'record' || base.source === 'confirmed') ? '记录表价' : base.source === 'import' ? '导入历史' : base.source === 'capture' ? '首次采集' : '');
    setText('drawerLow', stats.low != null ? money(stats.low) : '—');
    setText('drawerHigh', stats.high != null ? money(stats.high) : '—');
    setText('drawerAvg', stats.avg != null ? money(Math.round(stats.avg)) : '—');

    const peer = peerStats(row, 'latest');
    if ($('drawerPeer')) {
      $('drawerPeer').innerHTML = peer.count
        ? '<div class="peer-head"><span>同尺寸位置</span><em>' + esc(peer.group) + '</em></div>' +
          '<div class="peer-grid">' +
            '<div><span>同组均价</span><b>' + money(peer.avg) + '</b></div>' +
            '<div><span>中位价</span><b>' + money(peer.median) + '</b></div>' +
            '<div><span>当前排名</span><b>' + (peer.rank || '—') + '<small>/' + peer.count + '</small></b></div>' +
            '<div><span>较同组</span><b class="' + (peer.diff < 0 ? 'down' : peer.diff > 0 ? 'up' : '') + '">' + (peer.diff == null ? '—' : (peer.diff > 0 ? '+' : '') + peer.diff.toFixed(1) + '%') + '</b></div>' +
          '</div>'
        : '';
    }

    const ignoreBtn = $('drawerIgnoreBtn');
    if (ignoreBtn) ignoreBtn.textContent = row.ignored ? '恢复监控' : '忽略监控';
    const offlineBtn = $('drawerOfflineBtn');
    if (offlineBtn) {
      offlineBtn.textContent = row.offline ? '恢复上架' : '标记已下架';
      offlineBtn.classList.toggle('danger', !!row.offline);
    }
    const confirmBtn = $('drawerConfirmBtn');
    if (confirmBtn) {
      confirmBtn.disabled = !latest || isLatestRecorded(row);
      confirmBtn.textContent = isLatestRecorded(row) ? '已写入今日记录' : '写入今日记录';
    }
    if ($('drawerBaselineInput')) $('drawerBaselineInput').value = base.value != null ? String(base.value) : '';
    if ($('drawerBaselineHint')) {
      $('drawerBaselineHint').textContent = base.source === 'manual'
        ? '当前为手动基准价；点「恢复自动」会回到记录表价 / 导入历史价 / 首次采集价。'
        : (base.source === 'record' || base.source === 'confirmed')
          ? '当前为记录表最近日期列的价格 ' + money(base.value) + (base.date ? '（' + fmtDate(base.date) + '）' : '') + '；下一轮采集会以它为基准。'
          : base.source === 'import'
            ? '自动基准：导入历史的最新月份价 ' + money(base.value) + (base.date ? '（' + base.date + '）' : '') + '；也可手动改。'
            : base.source === 'capture'
              ? '自动基准：首次采集到的价格 ' + money(base.value) + '；也可手动改。'
              : '还没有基准价：采集一次后会自动用首次采集价，或手动填写。';
    }
    if ($('drawerNote')) $('drawerNote').value = row.note || '';
    if ($('drawerChart')) $('drawerChart').innerHTML = renderChart(row);

    const history = (cap && Array.isArray(cap.history) ? cap.history.slice().reverse() : []);
    setText('drawerCaptureCount', history.length + ' 条');
    const listEl = $('drawerCaptureList');
    if (listEl) {
      listEl.innerHTML = history.slice(0, 12).map((c) =>
        '<div class="cap-row">' +
          '<span class="cap-at">' + fmtDate(c.at) + '</span>' +
          '<span class="cap-price">' + money(c.price) + '</span>' +
          '<span class="cap-kind">' + kindBadge(c.kind) + ' ' + (c.confidence === 'high' ? '' : '<span class="kind-badge ai">' + (c.confidence === 'medium' ? '中置信' : '低置信') + '</span>') + '</span>' +
        '</div>'
      ).join('') || '<div class="cap-empty">还没有采集记录</div>';
    }
    if ($('drawerRaw')) {
      const raw = cap && cap.raw ? cap.raw : null;
      $('drawerRaw').textContent = raw ? JSON.stringify(raw, null, 2) : '暂无采集记录';
    }
  }

  // 价格走势：导入历史（灰）+ 采集（青）+ 异动点（红圈）
  function renderChart(row) {
    const raw = allHistory(row);
    if (!raw.length) return '<div class="chart-empty">还没有价格数据：导入历史或采集一次后显示走势。</div>';
    const points = raw.map((p) => {
      const t = new Date(p.date).getTime();
      return Object.assign({}, p, { t: isNaN(t) ? null : t });
    }).filter((p) => p.t != null);
    if (!points.length) return '<div class="chart-empty">日期格式无法解析。</div>';
    if (points.length === 1) {
      return '<div class="chart-empty">只有一个价格点：' + money(points[0].price) + '（' + fmtDate(points[0].date, false) + '）</div>';
    }
    const W = 560;
    const H = 214;
    const L = 62;
    const R = 14;
    const T = 16;
    const B = 30;
    const times = points.map((p) => p.t);
    const minT = Math.min.apply(null, times);
    const maxT = Math.max.apply(null, times);
    const spanT = maxT - minT || 1;
    const prices = points.map((p) => p.price);
    let minP = Math.min.apply(null, prices);
    let maxP = Math.max.apply(null, prices);
    if (maxP === minP) { maxP += Math.max(1, maxP * 0.05); minP = Math.max(0, minP - Math.max(1, minP * 0.05)); }
    const padP = (maxP - minP) * 0.12;
    minP = Math.max(0, minP - padP);
    maxP += padP;
    const spanP = maxP - minP || 1;
    const xOf = (t) => L + ((t - minT) / spanT) * (W - L - R);
    const yOf = (v) => T + (1 - (v - minP) / spanP) * (H - T - B);
    const alertDays = new Set();
    for (const a of state.db.alerts) {
      if (a.sku === row.sku) alertDays.add(String(a.at).slice(0, 10));
    }
    const grid = [];
    for (let i = 0; i <= 3; i++) {
      const value = minP + (spanP * i) / 3;
      const y = yOf(value);
      grid.push('<line x1="' + L + '" y1="' + y.toFixed(1) + '" x2="' + (W - R) + '" y2="' + y.toFixed(1) + '" stroke="#e8eef6" stroke-dasharray="3 4"/>');
      grid.push('<text x="' + (L - 8) + '" y="' + (y + 3.5).toFixed(1) + '" text-anchor="end" font-size="9.5" fill="#94a3b8">' + esc(money(Math.round(value))) + '</text>');
    }
    const linePoints = points.map((p) => xOf(p.t).toFixed(1) + ',' + yOf(p.price).toFixed(1)).join(' ');
    const area = 'M' + L + ',' + (H - B) + ' L' + linePoints.replace(/ /g, ' L') + ' L' + (W - R) + ',' + (H - B) + ' Z';
    const dots = points.map((p) => {
      const x = xOf(p.t);
      const y = yOf(p.price);
      const isCapture = p.source === 'capture';
      const day = String(p.date).slice(0, 10);
      const hasAlert = alertDays.has(day);
      const color = isCapture ? '#0d9488' : '#94a3b8';
      const r = isCapture ? 3.6 : 2.8;
      return '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="' + r + '" fill="' + (isCapture ? color : '#fff') + '" stroke="' + color + '" stroke-width="1.4"><title>' + esc(fmtDate(p.date, p.source === 'capture') + ' · ' + money(p.price) + (isCapture ? ' · 采集' : ' · 导入')) + '</title></circle>' +
        (hasAlert ? '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="7.5" fill="none" stroke="#e11d48" stroke-width="1.2" stroke-dasharray="2 2"/>' : '');
    }).join('');
    const labelCount = Math.min(5, points.length);
    const xLabels = [];
    for (let i = 0; i < labelCount; i++) {
      const idx = Math.round((i * (points.length - 1)) / Math.max(1, labelCount - 1));
      const p = points[idx];
      const x = xOf(p.t);
      xLabels.push('<text x="' + x.toFixed(1) + '" y="' + (H - 10) + '" text-anchor="middle" font-size="9.5" fill="#94a3b8">' + esc(fmtDate(p.date, false)) + '</text>');
    }
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="价格走势">' +
      '<defs><linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#14b8a6" stop-opacity="0.22"/><stop offset="100%" stop-color="#14b8a6" stop-opacity="0"/></linearGradient></defs>' +
      grid.join('') +
      '<path d="' + area + '" fill="url(#areaGrad)"/>' +
      '<polyline points="' + linePoints + '" fill="none" stroke="#0d9488" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>' +
      dots +
      xLabels.join('') +
    '</svg>';
  }

  // ------------------------------------------------------------------ 采集：任务与结果
  function plausiblePrice(price, base, row) {
    const p = Number(price);
    if (!isFinite(p) || p < 10 || p > 9999999) return false;
    if (base != null && isFinite(Number(base)) && Number(base) > 0) {
      const b = Number(base);
      if (p < b * 0.18 || p > b * 5.5) return false;
    }
    const stats = historyStats(row);
    if (stats.low != null && stats.high != null) {
      if (p < stats.low * 0.12 || p > stats.high * 8) return false;
    }
    return true;
  }

  function pickPrice(row, result) {
    if (!result) return null;
    const basis = state.db.settings.priceBasis || 'hand';
    const order = basis === 'main' ? ['main', 'hand', 'plus'] : basis === 'plus' ? ['plus', 'hand', 'main'] : ['hand', 'main', 'plus'];
    const base = baselineOf(row).value;
    for (const key of order) {
      const candidate = result[key];
      if (candidate && plausiblePrice(candidate.price, base, row)) {
        return { price: Number(candidate.price), kind: candidate.kind || key, confidence: result.confidence || 'low', source: 'dom' };
      }
    }
    const candidates = (result.candidates || []).filter((c) => c && plausiblePrice(c.price, base, row));
    if (candidates.length) {
      const best = candidates[0];
      return { price: Number(best.price), kind: best.kind || 'hand', confidence: result.confidence || 'low', source: 'dom' };
    }
    return null;
  }

  function captureStore(sku) {
    if (!state.db.captures[sku]) state.db.captures[sku] = { history: [], latest: null, fail: null, updatedAt: null };
    return state.db.captures[sku];
  }

  // 下架标记落到本地 meta（独立 key），批量采集默认跳过；恢复上架后重新参与
  async function setRowOffline(sku, offline) {
    const row = rowBySku(sku);
    if (!row) return;
    const override = state.meta.overrides[sku] || {};
    override.offline = !!offline;
    if (offline) override.ignored = false;
    state.meta.overrides[sku] = override;
    try {
      await saveMeta();
    } catch (e) {
      // 存储失败也继续采集，状态栏已经提示
    }
    buildRows();
  }

  function addAlert(payload) {
    if (!payload || !payload.sku) return null;
    const now = Date.now();
    const duplicate = state.db.alerts.find((a) =>
      a.sku === payload.sku && a.type === payload.type &&
      String(a.to == null ? '' : a.to) === String(payload.to == null ? '' : payload.to) &&
      now - new Date(a.at).getTime() < 6 * 3600 * 1000
    );
    if (duplicate) return null;
    const alert = Object.assign({
      id: uid('alert'),
      at: new Date().toISOString(),
      status: 'new',
      level: 'warn'
    }, payload);
    state.db.alerts.unshift(alert);
    if (state.db.alerts.length > MAX_ALERTS) state.db.alerts = state.db.alerts.slice(0, MAX_ALERTS);
    return alert;
  }

  function addFailAlert(row, type, reason) {
    if (!state.db.settings.failAlert) return;
    const kind = type === 'offline' || type === 'verify' ? type : 'fail';
    addAlert({
      sku: row.sku,
      type: kind,
      level: kind === 'verify' ? 'critical' : 'warn',
      message: reason,
      from: null,
      to: null,
      base: baselineOf(row).value,
      pct: null
    });
  }

  function recordCapture(row, result, pick, meta) {
    const at = new Date().toISOString();
    const cap = captureStore(row.sku);
    const priorPoints = allHistory(row);
    const priorPrices = priorPoints.map((p) => Number(p.price)).filter((p) => isFinite(p));
    const priorMin = priorPrices.length ? Math.min.apply(null, priorPrices) : null;
    const prevCapture = cap.history.length ? cap.history[cap.history.length - 1] : null;
    const base = baselineOf(row);
    const entry = {
      at: at,
      price: pick.price,
      kind: pick.kind,
      confidence: pick.confidence || (result.confidence || 'low'),
      account: (result.account && result.account.nickname) || '',
      title: result.title || '',
      url: result.url || ITEM_URL(row.sku),
      changes: result.priceChanges && result.priceChanges.length ? result.priceChanges : null,
      engine: result.engine || ''
    };
    cap.history.push(entry);
    if (cap.history.length > MAX_CAPTURES_PER_SKU) cap.history = cap.history.slice(-MAX_CAPTURES_PER_SKU);
    cap.latest = entry;
    cap.fail = null;
    cap.updatedAt = at;
    cap.raw = {
      at: at,
      engine: result.engine || '',
      hand: result.hand || null,
      main: result.main || null,
      plus: result.plus || null,
      source: result.source || '',
      confidence: result.confidence || '',
      flags: result.flags || null,
      priceChanges: result.priceChanges || null,
      candidates: (result.candidates || []).slice(0, 14),
      title: result.title || '',
      url: result.url || '',
      ai: meta && meta.aiInfo ? meta.aiInfo : null
    };
    if (meta && meta.aiInfo) cap.ai = meta.aiInfo;
    state.db.captures[row.sku] = cap;
    state.lastRaw = cap.raw;

    if (entry.account) {
      state.db.lastAccount = entry.account;
      state.db.settings.lastAccount = entry.account;
    }

    // ---------------- 异动判定 ----------------
    const basePct = base.value != null && base.value > 0 ? ((pick.price - base.value) / base.value) * 100 : null;
    const prevPct = prevCapture && prevCapture.price ? ((pick.price - prevCapture.price) / prevCapture.price) * 100 : null;
    const settings = state.db.settings;
    const isNewLow = !!settings.newLowAlert && priorMin != null && pick.price < priorMin - 0.001;
    let type = '';
    if (isNewLow) type = 'newLow';
    else if (basePct != null && basePct <= -Math.abs(settings.baseAlertPct)) type = 'drop';
    else if (basePct != null && basePct >= Math.abs(settings.baseAlertPct)) type = 'rise';
    else if (prevPct != null && Math.abs(prevPct) >= Math.abs(settings.captureAlertPct)) type = prevPct < 0 ? 'drop' : 'rise';

    if (type) {
      const effectivePct = basePct != null ? basePct : prevPct;
      const big = Math.abs(settings.bigAlertPct);
      let level = type === 'rise'
        ? (Math.abs(effectivePct) >= big ? 'warn' : 'info')
        : (Math.abs(effectivePct) >= big ? 'critical' : 'warn');
      if (type === 'newLow' && level === 'info') level = 'warn';
      let message = '';
      if (type === 'newLow') {
        const vsMin = priorMin ? ((pick.price - priorMin) / priorMin) * 100 : null;
        message = '创历史新低 ' + money(pick.price) + '，低于此前最低 ' + money(priorMin) + (vsMin != null ? '（' + fmtPct(vsMin) + '）' : '');
      } else if (type === 'drop') {
        message = '较基准价 ' + money(base.value != null ? base.value : prevCapture.price) + ' 下跌 ' + Math.abs(effectivePct).toFixed(1) + '%，当前 ' + money(pick.price);
      } else {
        message = '较基准价 ' + money(base.value != null ? base.value : prevCapture.price) + ' 上涨 ' + Math.abs(effectivePct).toFixed(1) + '%，当前 ' + money(pick.price);
      }
      addAlert({
        sku: row.sku,
        type: type,
        level: level,
        message: message,
        from: prevCapture ? prevCapture.price : base.value,
        to: pick.price,
        base: base.value,
        pct: effectivePct
      });
    }
    return entry;
  }

  function recordFailure(row, task, result, type, reason) {
    const at = new Date().toISOString();
    const cap = captureStore(row.sku);
    cap.fail = { type: type || 'fail', reason: reason || '采集失败', at: at };
    cap.updatedAt = at;
    state.db.captures[row.sku] = cap;
    state.lastRaw = {
      at: at,
      ok: false,
      type: type || 'fail',
      reason: reason || '采集失败',
      sku: task.sku,
      flags: (result && result.flags) || null,
      candidates: (result && result.candidates) || [],
      engine: (result && result.engine) || ''
    };
    addFailAlert(row, type, reason);
  }

  // ------------------------------------------------------------------ 采集：任务执行
  function collectTasks(scope, skus, force) {
    const settings = state.db.settings;
    let sourceRows;
    if (skus && skus.length) {
      sourceRows = skus.map((sku) => rowBySku(sku)).filter(Boolean);
    } else if (scope === 'selected') {
      sourceRows = Array.from(state.selected).map((sku) => rowBySku(sku)).filter(Boolean);
    } else if (scope === 'all') {
      sourceRows = state.rows.slice();
    } else {
      sourceRows = filteredRows();
    }
    const seen = new Set();
    const tasks = [];
    for (const row of sourceRows) {
      if (!row || !row.sku) continue;
      if (row.ignored) continue;
      // 已下架的行不自动重采：避免把下架页上的推荐位/缓存数字当成当前价格。
      // 需要重新采集时，先在详情里点「恢复上架」，或在单条采集时按提示确认。
      if (row.offline) continue;
      if (seen.has(row.sku)) continue;
      seen.add(row.sku);
      if (!force && settings.skipToday) {
        const latest = latestOf(row);
        if (latest && isToday(latest.at)) continue;
      }
      tasks.push({
        sku: row.sku,
        url: ITEM_URL(row.sku),
        brand: row.brand,
        model: row.model || row.series || row.size,
        category: row.category,
        row: row
      });
    }
    const limit = Number(settings.batch) || 0;
    if (!skus && limit > 0 && tasks.length > limit) return tasks.slice(0, limit);
    return tasks;
  }

  function runnerWindowOptions() {
    const sw = (window.screen && screen.availWidth) || 1400;
    const sh = (window.screen && screen.availHeight) || 900;
    const width = Math.round(Math.min(1180, Math.max(900, sw * 0.62)));
    const height = Math.round(Math.min(860, Math.max(620, sh * 0.8)));
    return {
      width: width,
      height: height,
      left: Math.max(10, Math.round((sw - width) / 2)),
      top: Math.max(10, Math.round((sh - height) / 2)),
      type: 'popup',
      focused: true,
      url: 'about:blank'
    };
  }

  async function openRunner() {
    const run = state.run;
    if (!run) return;
    if (run.mode === 'foreground') {
      const win = await chrome.windows.create(runnerWindowOptions());
      if (!win || win.id == null) throw new Error('未能创建前台采集窗口');
      run.runnerWindowId = win.id;
      run.runnerTabId = win.tabs && win.tabs[0] ? win.tabs[0].id : null;
    } else {
      const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
      run.runnerTabId = tab.id;
    }
  }

  async function closeRunner() {
    const run = state.run;
    if (!run) return;
    try {
      if (run.runnerWindowId != null) {
        await chrome.windows.remove(run.runnerWindowId);
      } else if (run.runnerTabId != null && !state.db.settings.keepTab) {
        await chrome.tabs.remove(run.runnerTabId);
      }
    } catch (e) {
      // 窗口/标签页可能已被用户关闭
    }
    run.runnerWindowId = null;
    run.runnerTabId = null;
  }

  function waitForResult(sku, timeoutMs) {
    return new Promise((resolve) => {
      const timer = setTimeout(async () => {
        if (!state.pending || state.pending.sku !== sku) return;
        let settled = false;
        // 有些跳转没有触发 onUpdated，超时前再看一眼当前标签页 URL，
        // 如果已经跳到首页/商品频道，仍然按「已下架」处理，而不是只报超时。
        try {
          if (chrome.tabs && chrome.tabs.get && state.run && state.run.runnerTabId != null) {
            const tab = await chrome.tabs.get(state.run.runnerTabId);
            const url = tab && tab.url;
            if (url) {
              const nav = classifyNavigation(url, sku);
              if (nav && state.pending && state.pending.sku === sku) {
                state.pending = null;
                resolve(navResultFor(sku, url, nav));
                settled = true;
              }
            }
          }
        } catch (e) {
          // 忽略
        }
        if (!settled && state.pending && state.pending.sku === sku) {
          state.pending = null;
          resolve({ ok: false, reason: '等待页面价格超时（页面加载慢、未登录或页面改版）' });
        }
      }, timeoutMs);
      state.pending = {
        sku: sku,
        timer: timer,
        resolve: (msg) => {
          clearTimeout(timer);
          state.pending = null;
          resolve(msg);
        }
      };
      const buffered = state.pendingBuffer;
      if (buffered && buffered.msg && buffered.msg.sku === sku && Date.now() - buffered.at < 20000 && state.run && buffered.tabId === state.run.runnerTabId) {
        state.pendingBuffer = null;
        const pending = state.pending;
        state.pending = null;
        clearTimeout(timer);
        pending.resolve(buffered.msg);
      }
    });
  }

  function failPending(reason) {
    if (!state.pending) return;
    const pending = state.pending;
    state.pending = null;
    clearTimeout(pending.timer);
    pending.resolve({ ok: false, reason: reason });
  }

  // 解析 item.shop.example.com/<sku>.html 里的 SKU；不是商品详情页返回空串
  function itemSkuFromUrl(url) {
    try {
      const u = new URL(url);
      if (!/(^|\.)item\.jd\.(com|hk)$/i.test(u.hostname)) return '';
      const m = u.pathname.match(/\/(\d{6,20})\.html/);
      return m ? m[1] : '';
    } catch (e) {
      return '';
    }
  }

  // 商品页跳走是最常见的「已下架」表现：下架后电商平台常常直接跳首页 / 商品频道。
  // 这种情况 content.js 根本不会在目标页执行，只能由工作台监听标签页 URL 来判定。
  function classifyNavigation(url, expectedSku) {
    if (!/^https?:\/\//i.test(url || '')) return null;
    let host = '';
    try {
      host = new URL(url).hostname;
    } catch (e) {
      return null;
    }
    if (/passport\.jd\.com|plogin\.jd\.com|login\.jd\.com/i.test(url)) {
      return { type: 'login', reason: '页面跳转到了电商平台登录页，登录可能已失效' };
    }
    if (/(^|\.)item\.jd\.(com|hk)$/i.test(host)) {
      const sku = itemSkuFromUrl(url);
      if (sku === expectedSku) return null;
      if (!sku) return { type: 'offline', reason: '商品详情页跳转到了商品频道首页（商品可能已下架/不存在）' };
      return { type: 'offline', reason: '商品详情页跳转到了其他商品 ' + sku + '（原商品可能已下架）' };
    }
    if (/(^|\.)jd\.(com|hk)$/i.test(host)) {
      if (/(^|\.)(www|m|home|search|list|so|channel)\.jd\.(com|hk)$/i.test(host) || /^jd\.(com|hk)$/i.test(host)) {
        return { type: 'offline', reason: '商品详情页跳转到了电商平台首页/列表页（商品可能已下架/不存在）' };
      }
      return { type: 'fail', reason: '商品详情页跳转到了电商平台的其他页面（' + host + '），可能被风控或商品已下架' };
    }
    return { type: 'fail', reason: '商品详情页跳转到了站外（' + host + '），可能被风控或商品已下架' };
  }

  function resolvePendingResult(result) {
    if (state.pending && state.pending.sku === result.sku) {
      const pending = state.pending;
      state.pending = null;
      clearTimeout(pending.timer);
      pending.resolve(result);
      return;
    }
    if (state.run && state.run.runnerTabId != null) {
      state.pendingBuffer = { tabId: state.run.runnerTabId, msg: result, at: Date.now() };
    }
  }

  function navResultFor(sku, url, info) {
    return {
      type: 'ITEM_PRICE_RESULT',
      engine: 'priceradar-nav/1.1',
      sku: sku,
      url: url,
      title: '',
      at: new Date().toISOString(),
      account: { nickname: '', plusHint: false, source: '' },
      viewport: { w: 0, h: 0 },
      ok: false,
      reason: info.reason,
      flags: {
        redirect: true,
        redirectUrl: url,
        redirectType: info.type,
        offSale: info.type === 'offline',
        pageState: info.type === 'offline' ? 'offline' : info.type === 'login' ? 'login' : 'unknown',
        login: info.type === 'login'
      },
      confidence: 'none',
      candidates: [],
      hand: null,
      main: null,
      plus: null
    };
  }

  function updateRunProgress() {
    const run = state.run;
    if (!run) return;
    const total = run.tasks.length;
    const pct = total ? Math.round((run.done / total) * 100) : 0;
    const task = run.tasks[run.idx];
    renderRunUI();
    if ($('runProgressFill')) $('runProgressFill').style.width = pct + '%';
    if ($('runProgressText')) {
      $('runProgressText').textContent = (state.paused ? '已暂停：' : '采集中：') + run.done + ' / ' + total + '（' + pct + '%）· 成功 ' + run.ok + ' · 失败 ' + run.fail + (task ? ' · 当前 ' + task.sku : '');
    }
    if ($('dockFill')) $('dockFill').style.width = pct + '%';
    if ($('dockFill')) $('dockFill').style.width = pct + '%';
    if ($('dockText')) $('dockText').textContent = (task ? '当前 ' + task.sku : '准备中') + ' · ' + run.done + '/' + total + ' · 成功 ' + run.ok;
    if ($('dockPct')) $('dockPct').textContent = pct + '%';
  }

  async function runLoop() {
    const run = state.run;
    const settings = state.db.settings;
    for (run.idx = 0; run.idx < run.tasks.length; run.idx++) {
      if (state.stopped) break;
      while (state.paused && !state.stopped) await sleep(350);
      if (state.stopped) break;
      const task = run.tasks[run.idx];
      updateRunProgress();
      logLine('[' + (run.idx + 1) + '/' + run.tasks.length + '] 打开 ' + task.sku + (task.model ? ' · ' + task.model : ''));
      let result = null;
      let shot = null;
      try {
        state.pendingBuffer = null;
        run.redirectHandled = null;
        await chrome.tabs.update(run.runnerTabId, { url: task.url, active: run.mode === 'foreground' });
        result = await waitForResult(task.sku, PRICE_TIMEOUT_MS);
      } catch (e) {
        result = { ok: false, reason: '打开页面失败：' + errText(e) };
      }
      if (state.stopped) break;
      const row = rowBySku(task.sku);
      if (!row) {
        logLine('  ✗ 监控清单里找不到 ' + task.sku);
        run.fail++;
        run.done = run.idx + 1;
        continue;
      }

      // 账号变化检测
      if (result && result.account && result.account.nickname) {
        if (!run.accountLabel) {
          run.accountLabel = result.account.nickname;
          logLine('  当前登录账号：' + run.accountLabel);
        } else if (run.accountLabel !== result.account.nickname) {
          state.paused = true;
          logLine('  ⚠ 账号变化（' + run.accountLabel + ' → ' + result.account.nickname + '），已自动暂停');
          setToast('检测到电商平台账号变化，采集已暂停，请确认账号后点「继续」', 'warn');
          run.accountLabel = result.account.nickname;
        }
      }

      if (result && result.priceChanges && result.priceChanges.length) {
        logLine('  ↻ 页面价格刷新：' + result.priceChanges.map((x) => money(x.from) + '→' + money(x.to)).join(' / ') + '（已采用最新读数）');
      }

      // AI 复核（仅前台窗口 + 开启 AI）
      let aiInfo = null;
      let domPick = null;
      if (result && result.ok) domPick = pickPrice(row, result);
      if (run.mode === 'foreground' && settings.aiEnabled) {
        try {
          if (settings.aiMode === 'all' || !domPick) {
            shot = await chrome.tabs.captureVisibleTab(run.runnerWindowId, { format: 'png' });
            const analysis = await analyzeShot(row, result, shot, domPick);
            if (analysis) {
              aiInfo = analysis.info;
              if (!domPick && analysis.pick) {
                domPick = { price: analysis.pick, kind: 'ai', confidence: 'low', source: 'ai' };
                logLine('  AI 识图补价：' + task.sku + ' → ' + money(analysis.pick));
              }
              if (analysis.info && analysis.info.mismatch) {
                logLine('  ⚠ DOM/AI 价格不一致：DOM ' + money(analysis.info.mismatch.dom) + ' / AI ' + money(analysis.info.mismatch.ai));
              }
            }
          }
        } catch (e) {
          logLine('  AI 复核失败：' + errText(e));
        }
      } else if (run.mode === 'background' && settings.aiEnabled && settings.aiMode === 'all') {
        logLine('  后台模式不做截图复核（切到前台窗口 + AI 才会启用）');
      }

      let success = false;
      let outcomeType = '';
      if (result && result.ok) {
        if (result.sku && result.sku !== task.sku) {
          recordFailure(row, task, result, 'fail', '页面 SKU 与任务不一致（页面 ' + result.sku + '，任务 ' + task.sku + '）');
          logLine('  ✗ 页面跳到了其他 SKU：' + result.sku);
        } else if (!domPick) {
          recordFailure(row, task, result, 'fail', '取到的价格不合理（疑似数字片段/促销角标），已跳过；建议重采或人工核对');
          logLine('  ✗ 没有取到可信价格');
        } else {
          const entry = recordCapture(row, result, domPick, { aiInfo: aiInfo });
          success = true;
          logLine('  ✓ ' + money(entry.price) + '（' + (KIND_LABEL[entry.kind] || entry.kind) + ' / ' + (entry.confidence === 'high' ? '高置信' : entry.confidence === 'medium' ? '中置信' : '低置信') + '）');
          const alert = state.db.alerts[0];
          if (alert && alert.sku === row.sku && new Date(alert.at).getTime() > Date.now() - 5000) {
            logLine('  ⚠ ' + alert.message);
          }
          if (entry.confidence !== 'high') logLine('  待核对：置信度不是高，建议在详情里人工看一眼页面。');
        }
      } else {
        const flags = (result && result.flags) || {};
        const type = flags.verify
          ? 'verify'
          : (flags.offSale || flags.pageState === 'offline')
            ? 'offline'
            : flags.unavailable
              ? 'unavailable'
              : 'fail';
        const reason = (result && result.reason) || '采集失败';
        if (type === 'offline') {
          // 2026-11-10 业务口径：真实下架也是有效采集结果（成功采到「已下架」状态），计入成功
          recordFailure(row, task, result, 'offline', reason);
          outcomeType = 'offline';
          success = true;
          logLine('  ✓ 已下架（状态已采集）：' + reason);
          await setRowOffline(row.sku, true);
          logLine('  已自动标记为已下架，后续批量采集会跳过（可在详情里恢复上架）');
        } else {
          recordFailure(row, task, result, type, reason);
          outcomeType = type;
          logLine('  ✗ ' + reason);
        }
        if (type === 'verify') {
          state.paused = true;
          setToast('页面出现安全验证，采集已暂停，请休息一段时间再继续', 'warn');
        } else if (flags.login || flags.pageState === 'login') {
          state.paused = true;
          setToast('页面跳到了电商平台登录页，采集已暂停，请重新登录后点「继续」', 'warn');
        }
      }

      run.done = run.idx + 1;
      if (success) {
        run.ok++;
        run.consecutiveFails = 0;
      } else {
        run.fail++;
        // 下架 / 不可售是正常业务结果，不算「连续失败」，否则一批下架 SKU 会把任务自动暂停
        if (outcomeType === 'offline' || outcomeType === 'unavailable') run.consecutiveFails = 0;
        else run.consecutiveFails++;
      }
      await saveDb();
      renderAll();
      renderLogs();
      updateRunProgress();

      if (!success && run.consecutiveFails >= 3) {
        state.paused = true;
        logLine('  ⚠ 连续 ' + run.consecutiveFails + ' 个失败，已自动暂停（检查登录状态 / 页面改版 / 是否触发验证）');
        setToast('连续采集失败，已自动暂停，请检查登录状态和页面', 'warn');
      }
      if (state.stopped) break;
      if (run.idx < run.tasks.length - 1) {
        const delay = randInt(Math.max(1, Number(settings.delayMin) || 3), Math.max(1, Number(settings.delayMax) || 6));
        logLine('  等待 ' + delay + ' 秒…');
        await sleep(delay * 1000);
      }
    }
  }

  async function startRun(opts) {
    opts = opts || {};
    if (state.running) {
      setToast('已有采集任务在进行中', 'warn');
      return;
    }
    if (!state.loaded) return;
    const scope = opts.scope || ($('runScope') && $('runScope').value) || 'filtered';
    // 单条采集已下架 SKU：先确认是否已重新上架；下架商品不自动重采，避免采到推荐位/缓存价
    if (opts.skus && opts.skus.length) {
      const offlineRows = opts.skus.map((sku) => rowBySku(sku)).filter((row) => row && row.offline);
      if (offlineRows.length) {
        const ok = await askConfirm(
          '该 SKU 已标记下架',
          '下架商品默认不再重复采集，避免把下架页上的推荐价、缓存价当成当前价格。\n\n' +
            '如果确认商品已经重新上架，会先恢复上架再采集；如果只是核对，请直接「打开商品页」看，不要采集。',
          '已上架，恢复并采集'
        );
        if (!ok) return;
        for (const row of offlineRows) await setRowOffline(row.sku, false);
      }
    }
    const tasks = collectTasks(scope, opts.skus, !!opts.recheck || !!opts.force || !!(opts.skus && opts.skus.length));
    if (!tasks.length) {
      if (opts.silent) return;
      const selectedOffline = scope === 'selected'
        ? Array.from(state.selected).map((sku) => rowBySku(sku)).filter((row) => row && row.offline).length
        : 0;
      if (selectedOffline) {
        setToast('选中的 ' + selectedOffline + ' 个 SKU 都已标记下架；如需重采，请先在详情里恢复上架', 'warn');
      } else {
        setToast('没有需要采集的 SKU：可能都采过了（设置里可关掉「跳过今天已采集」），或当前筛选为空', 'warn');
      }
      return;
    }
    const mode = opts.mode || state.db.settings.mode || 'background';
    const avg = ((Number(state.db.settings.delayMin) || 3) + (Number(state.db.settings.delayMax) || 6)) / 2;
    const est = Math.max(1, Math.round((tasks.length * (avg + 6)) / 60));
    if (!opts.noConfirm) {
      const ok = await askConfirm(
        '开始采集',
        '将逐个打开电商平台商品页读取到手价：\n\n' +
          '本次 SKU：' + tasks.length + ' 个\n' +
          '采集模式：' + (mode === 'foreground' ? '前台窗口 + AI（会抢焦点，采集期间别用电脑）' : '后台标签页（不弹窗，可继续用电脑）') + '\n' +
          '预计耗时：约 ' + est + ' 分钟\n\n' +
          '请确认当前 Edge 登录的是要采价的电商平台账号，并且能正常打开电商平台商品页。',
        '开始采集'
      );
      if (!ok) return;
    }
    state.db.settings.mode = mode;
    state.db.settings.lastScope = scope;
    await saveDb();
    state.run = {
      id: uid('run'),
      mode: mode,
      scope: scope,
      tasks: tasks,
      idx: 0,
      done: 0,
      ok: 0,
      fail: 0,
      consecutiveFails: 0,
      accountLabel: '',
      startedAt: new Date().toISOString(),
      runnerTabId: null,
      runnerWindowId: null
    };
    state.running = true;
    state.paused = false;
    state.stopped = false;
    state.pending = null;
    state.pendingBuffer = null;
    state.logs = [];
    state.dockCollapsed = false;
    if ($('runConsole')) $('runConsole').textContent = '';
    renderAll();
    updateRunProgress();
    logLine('开始采集：' + tasks.length + ' 个 SKU · ' + (mode === 'foreground' ? '前台窗口 + AI' : '后台标签页'));
    try {
      await openRunner();
      await runLoop();
    } catch (e) {
      logLine('采集异常终止：' + errText(e));
      setToast('采集异常终止：' + errText(e), 'error');
    } finally {
      await finishRun();
    }
  }

  async function finishRun() {
    const run = state.run;
    const wasStopped = state.stopped;
    state.running = false;
    state.paused = false;
    state.stopped = false;
    state.pending = null;
    state.pendingBuffer = null;
    try {
      await closeRunner();
    } catch (e) {
      // 忽略
    }
    if (run) {
      const ended = Date.now();
      const started = new Date(run.startedAt).getTime();
      const record = {
        at: run.startedAt,
        mode: run.mode,
        scope: run.scope,
        total: run.tasks.length,
        ok: run.ok,
        fail: run.fail,
        durationSec: Math.max(0, Math.round((ended - started) / 1000)),
        account: run.accountLabel || state.db.lastAccount || '',
        stopped: !!wasStopped
      };
      state.db.runs.unshift(record);
      if (state.db.runs.length > MAX_RUNS) state.db.runs = state.db.runs.slice(0, MAX_RUNS);
      state.db.lastRun = record;
      state.db.lastAccount = record.account;
      state.db.settings.lastAccount = record.account;
      await saveDb();
    }
    state.run = null;
    renderAll();
    renderLogs();
    if (run) {
      logLine('采集结束：共 ' + run.tasks.length + ' 个，成功 ' + run.ok + '，失败 ' + run.fail + (wasStopped ? '（手动停止）' : ''));
      setToast('采集结束：成功 ' + run.ok + ' · 失败 ' + run.fail + (run.ok ? '；点「写入今日记录」批量更新下轮基准' : ''), run.fail ? 'warn' : 'success');
    }
  }

  function pauseOrResume() {
    if (!state.running) return;
    state.paused = !state.paused;
    logLine(state.paused ? '已暂停' : '继续采集');
    if (state.paused) setToast('采集已暂停', 'warn');
    renderRunUI();
    updateRunProgress();
  }

  function stopRun() {
    if (!state.running) return;
    state.stopped = true;
    state.paused = false;
    logLine('已请求停止采集…');
    failPending('已手动停止采集');
    renderRunUI();
    updateRunProgress();
  }

  // ------------------------------------------------------------------ AI 辅助
  const AI_PROMPT = '图片是电商平台商品页的价格区域。只输出一个 JSON 对象，不要解释、不要输出思考过程：' +
    '{"page_state":"product|login|verify|home|offline|other","hand_price":数字或null,"jd_price":数字或null,"plus_price":数字或null}。' +
    'hand_price 取大号红字的「到手价」；jd_price 取旁边小号或带删除线的「电商平台价」；plus_price 取「PLUS会员价 / 会员价」。' +
    '不要把优惠、分期、满减、评分、评价数、优惠券金额当成价格；只输出第一个 JSON，不要代码块。';

  function aiNum(value) {
    const n = Number(value);
    return isFinite(n) && n > 0 ? n : null;
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('图片解码失败'));
      img.src = src;
    });
  }

  async function aiExtractPrice(dataUrl) {
    const settings = state.db.settings;
    if (!settings.aiEnabled) return null;
    const endpoint = String(settings.aiEndpoint || '').replace(/\/+$/, '');
    const key = String(settings.aiKey || '').trim();
    if (!endpoint || !key) throw new Error('AI 接口地址或 Key 未填写');
    let lastErr = null;
    for (const budget of [2000, 4000]) {
      const body = {
        model: settings.aiModel || 'deepseek-chat',
        temperature: 0,
        max_tokens: budget,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: AI_PROMPT },
            { type: 'image_url', image_url: { url: dataUrl } }
          ]
        }]
      };
      const res = await fetch(endpoint + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify(body)
      });
      if (!res.ok) throw new Error('AI 接口 HTTP ' + res.status);
      const data = await res.json();
      const choice = (data.choices || [])[0] || {};
      let text = (choice.message && choice.message.content) || '';
      if (!text.trim() && choice.message && choice.message.reasoning_content) {
        text = String(choice.message.reasoning_content);
      }
      if (!text.trim()) {
        lastErr = new Error('AI 返回空内容（finish=' + (choice.finish_reason || '?') + '，token 预算 ' + budget + '）');
        continue;
      }
      const match = text.match(/\{[\s\S]*\}/);
      let parsed = {};
      if (match) {
        try { parsed = JSON.parse(match[0]); } catch (e) { parsed = {}; }
      }
      return {
        page_state: String(parsed.page_state || 'other'),
        hand_price: aiNum(parsed.hand_price),
        jd_price: aiNum(parsed.jd_price),
        plus_price: aiNum(parsed.plus_price),
        raw: String(text || '').slice(0, 1200)
      };
    }
    if (lastErr) throw lastErr;
    return null;
  }

  // 只把价格那一小块裁出来给 AI，截图用完即弃、不落盘
  async function cropShot(shot, rect, viewport) {
    try {
      const img = await loadImage(shot);
      const vw = viewport && viewport.w ? viewport.w : img.width;
      const vh = viewport && viewport.h ? viewport.h : img.height;
      if (!rect) rect = { left: vw * 0.45, top: vh * 0.04, width: vw * 0.55, height: vh * 0.48 };
      const scale = vw > 0 ? img.width / vw : 1;
      const pad = 90;
      const x = Math.max(0, Math.round((rect.left - pad) * scale));
      const y = Math.max(0, Math.round((rect.top - pad) * scale));
      const w = Math.min(img.width - x, Math.round((rect.width + pad * 2) * scale));
      const h = Math.min(img.height - y, Math.round((rect.height + pad * 2) * scale));
      if (!(w > 20 && h > 20)) return shot;
      const up = Math.min(3, Math.max(1, Math.round(960 / w)));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(w * up);
      canvas.height = Math.round(h * up);
      const ctx = canvas.getContext('2d');
      if (ctx && 'imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, x, y, w, h, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/png');
    } catch (e) {
      return shot;
    }
  }

  async function analyzeShot(row, result, shot, domPick) {
    const settings = state.db.settings;
    if (!settings.aiEnabled || !shot) return null;
    if (settings.aiMode === 'fallback' && domPick) return null;
    const img = await cropShot(shot, result && result.rect, result && result.viewport);
    let ai = null;
    try {
      ai = await aiExtractPrice(img);
    } catch (e) {
      return { info: { at: new Date().toISOString(), model: settings.aiModel, error: errText(e) }, pick: null };
    }
    if (!ai) return null;
    const info = {
      at: new Date().toISOString(),
      model: settings.aiModel,
      page_state: ai.page_state,
      hand_price: ai.hand_price,
      jd_price: ai.jd_price,
      plus_price: ai.plus_price,
      raw: ai.raw
    };
    let pick = null;
    if (!domPick) {
      const basis = settings.priceBasis || 'hand';
      const order = basis === 'main' ? ['jd_price', 'hand_price', 'plus_price'] : basis === 'plus' ? ['plus_price', 'hand_price', 'jd_price'] : ['hand_price', 'jd_price', 'plus_price'];
      const base = baselineOf(row).value;
      for (const key of order) {
        const candidate = ai[key];
        if (candidate != null && plausiblePrice(candidate, base, row)) {
          pick = Number(candidate);
          break;
        }
      }
      if (pick != null) info.fallback = true;
    } else if (ai.hand_price != null && Math.abs(Number(ai.hand_price) - domPick.price) > 0.5) {
      info.mismatch = { dom: domPick.price, ai: Number(ai.hand_price) };
    }
    return { info: info, pick: pick };
  }

  // ------------------------------------------------------------------ 预览小窗
  function previewDelay() {
    const n = Number(state.db.settings.previewDelay);
    return isFinite(n) ? Math.min(5000, Math.max(300, n)) : 900;
  }

  function clearPreviewTimers() {
    if (state.preview.openTimer) { clearTimeout(state.preview.openTimer); state.preview.openTimer = null; }
    if (state.preview.closeTimer) { clearTimeout(state.preview.closeTimer); state.preview.closeTimer = null; }
  }

  function schedulePreview(sku) {
    clearPreviewTimers();
    state.preview.openTimer = setTimeout(() => { openPreview(sku, false); }, previewDelay());
  }

  function scheduleClosePreview() {
    clearPreviewTimers();
    if (state.preview.pinned) return;
    state.preview.closeTimer = setTimeout(() => { closePreview(); }, 450);
  }

  async function openPreview(sku, pinned) {
    if (!sku || !chrome.windows) return;
    if (state.preview.sku === sku && state.preview.winId != null) {
      if (pinned) state.preview.pinned = true;
      return;
    }
    clearPreviewTimers();
    await closePreview(false);
    try {
      const sw = (window.screen && screen.availWidth) || 1400;
      const sh = (window.screen && screen.availHeight) || 900;
      const width = Math.min(520, Math.max(420, Math.round(sw * 0.34)));
      const height = Math.min(780, Math.max(560, Math.round(sh * 0.82)));
      const win = await chrome.windows.create({
        url: ITEM_URL(sku),
        type: 'popup',
        focused: !!pinned,
        width: width,
        height: height,
        left: Math.max(10, sw - width - 40),
        top: 50
      });
      state.preview.winId = win && win.id != null ? win.id : null;
      state.preview.tabId = win && win.tabs && win.tabs[0] ? win.tabs[0].id : null;
      state.preview.sku = sku;
      state.preview.pinned = !!pinned;
    } catch (e) {
      setToast('预览窗口打开失败：' + errText(e), 'error');
    }
  }

  async function closePreview() {
    clearPreviewTimers();
    const winId = state.preview.winId;
    state.preview.winId = null;
    state.preview.tabId = null;
    state.preview.pinned = false;
    state.preview.sku = null;
    if (winId != null && chrome.windows) {
      try { await chrome.windows.remove(winId); } catch (e) { /* 已关闭 */ }
    }
  }

  // ------------------------------------------------------------------ 通用确认框
  let confirmResolver = null;
  function askConfirm(title, text, okText) {
    return new Promise((resolve) => {
      const dialog = $('confirmDialog');
      if (!dialog || typeof dialog.showModal !== 'function') {
        resolve(window.confirm(text));
        return;
      }
      if (confirmResolver) {
        const prev = confirmResolver;
        confirmResolver = null;
        prev(false);
      }
      setText('confirmTitle', title || '确认');
      setText('confirmText', text || '');
      const ok = $('confirmOk');
      if (ok) ok.textContent = okText || '确定';
      confirmResolver = resolve;
      if (dialog.open) dialog.close();
      dialog.showModal();
    });
  }

  function settleConfirm(value) {
    const dialog = $('confirmDialog');
    if (dialog && dialog.open) dialog.close();
    if (confirmResolver) {
      const resolve = confirmResolver;
      confirmResolver = null;
      resolve(value);
    }
  }

  // ------------------------------------------------------------------ 设置
  function openSettings() {
    const settings = state.db.settings;
    const set = (id, value) => { const el = $(id); if (el) el.value = value == null ? '' : value; };
    const check = (id, value) => { const el = $(id); if (el) el.checked = !!value; };
    const sel = (id, value) => { const el = $(id); if (el) el.value = value; };
    sel('setMode', settings.mode);
    sel('setPriceBasis', settings.priceBasis);
    set('setBatch', settings.batch);
    set('setDelayMin', settings.delayMin);
    set('setDelayMax', settings.delayMax);
    check('setSkipToday', settings.skipToday);
    check('setKeepTab', settings.keepTab);
    set('setBaseAlertPct', settings.baseAlertPct);
    set('setBigAlertPct', settings.bigAlertPct);
    set('setCaptureAlertPct', settings.captureAlertPct);
    check('setNewLowAlert', settings.newLowAlert);
    check('setFailAlert', settings.failAlert);
    set('setPreviewDelay', settings.previewDelay);
    check('setAiEnabled', settings.aiEnabled);
    set('setAiEndpoint', settings.aiEndpoint);
    set('setAiModel', settings.aiModel);
    set('setAiKey', settings.aiKey);
    sel('setAiMode', settings.aiMode);
    updateStorageUsage();
    const raw = state.lastRaw || latestRawOfAll();
    if ($('debugBox')) $('debugBox').textContent = raw ? JSON.stringify(raw, null, 2) : '暂无采集记录';
    const dialog = $('settingsDialog');
    if (dialog && !dialog.open) dialog.showModal();
  }

  function latestRawOfAll() {
    let best = null;
    for (const sku of Object.keys(state.db.captures)) {
      const cap = state.db.captures[sku];
      if (cap && cap.raw && (!best || String(cap.raw.at || '') > String(best.at || ''))) best = cap.raw;
    }
    return best;
  }

  async function saveSettings() {
    const settings = state.db.settings;
    const numOf = (id, fallback) => {
      const el = $(id);
      const value = Number(el && el.value);
      return isFinite(value) ? value : fallback;
    };
    settings.mode = ($('setMode') && $('setMode').value) || 'background';
    settings.priceBasis = ($('setPriceBasis') && $('setPriceBasis').value) || 'hand';
    settings.batch = Math.max(0, Math.round(numOf('setBatch', 40)));
    let min = Math.max(1, Math.round(numOf('setDelayMin', 3)));
    let max = Math.max(1, Math.round(numOf('setDelayMax', 6)));
    if (max < min) { const tmp = min; min = max; max = tmp; }
    settings.delayMin = min;
    settings.delayMax = max;
    settings.skipToday = !!($('setSkipToday') && $('setSkipToday').checked);
    settings.keepTab = !!($('setKeepTab') && $('setKeepTab').checked);
    settings.baseAlertPct = Math.max(0.5, numOf('setBaseAlertPct', 5));
    settings.bigAlertPct = Math.max(settings.baseAlertPct, numOf('setBigAlertPct', 15));
    settings.captureAlertPct = Math.max(0.5, numOf('setCaptureAlertPct', 3));
    settings.newLowAlert = !!($('setNewLowAlert') && $('setNewLowAlert').checked);
    settings.failAlert = !!($('setFailAlert') && $('setFailAlert').checked);
    settings.previewDelay = Math.min(5000, Math.max(300, Math.round(numOf('setPreviewDelay', 900))));
    settings.aiEnabled = !!($('setAiEnabled') && $('setAiEnabled').checked);
    settings.aiEndpoint = ($('setAiEndpoint') && $('setAiEndpoint').value.trim()) || '';
    settings.aiModel = ($('setAiModel') && $('setAiModel').value.trim()) || 'deepseek-chat';
    settings.aiKey = ($('setAiKey') && $('setAiKey').value.trim()) || '';
    settings.aiMode = ($('setAiMode') && $('setAiMode').value) || 'fallback';
    if (settings.aiEnabled && (!settings.aiEndpoint || !settings.aiKey)) {
      setToast('AI 已启用，但接口地址或 Key 为空：采集时会跳过 AI 复核', 'warn');
    }
    await saveDb();
    const dialog = $('settingsDialog');
    if (dialog && dialog.open) dialog.close();
    renderAll();
    setToast('设置已保存', 'success');
  }

  async function updateStorageUsage() {
    const el = $('storageUsage');
    if (!el) return;
    try {
      const bytes = chrome.storage.local.getBytesInUse ? await chrome.storage.local.getBytesInUse(null) : 0;
      const capCount = Object.keys(state.db.captures).length;
      const alertCount = state.db.alerts.length;
      const runCount = state.db.runs.length;
      el.textContent = '存储占用 ' + (Number(bytes) / 1024).toFixed(1) + ' KB · 采集 ' + capCount + ' 个 SKU · 异动 ' + alertCount + ' 条 · 任务 ' + runCount + ' 次';
    } catch (e) {
      el.textContent = '存储占用读取失败';
    }
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(String(text));
      return true;
    } catch (e) {
      try {
        const ta = document.createElement('textarea');
        ta.value = String(text);
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        return true;
      } catch (e2) {
        return false;
      }
    }
  }

  // ------------------------------------------------------------------ 添加监控
  function openAddDialog() {
    const dialog = $('addDialog');
    if (!dialog) return;
    ['addSkuInput', 'addBrand', 'addCategory', 'addSize', 'addModel', 'addNote'].forEach((id) => { const el = $(id); if (el) el.value = ''; });
    if (!dialog.open) dialog.showModal();
    setTimeout(() => { if ($('addSkuInput')) $('addSkuInput').focus(); }, 60);
  }

  async function addMonitor(collect) {
    const input = ($('addSkuInput') && $('addSkuInput').value) || '';
    const match = String(input).match(/\d{6,20}/);
    if (!match) { setToast('请输入正确的电商平台 SKU 或商品链接（6–20 位数字）', 'error'); return; }
    const sku = match[0];
    const brand = ($('addBrand') && $('addBrand').value.trim()) || '';
    const category = ($('addCategory') && $('addCategory').value.trim()) || '';
    const size = ($('addSize') && $('addSize').value.trim()) || '';
    const model = ($('addModel') && $('addModel').value.trim()) || '';
    const note = ($('addNote') && $('addNote').value.trim()) || '';
    const existing = rowBySku(sku);
    if (existing) {
      const wasIgnored = existing.ignored;
      const override = state.meta.overrides[sku] || {};
      if (brand) override.brand = brand;
      if (category) override.category = category;
      if (size) override.size = size;
      if (model) override.model = model;
      if (note) override.note = note;
      override.ignored = false;
      state.meta.overrides[sku] = override;
      await saveMeta();
      buildRows();
      renderAll();
      setToast(wasIgnored ? '已恢复监控：' + sku : '已在监控清单中：' + sku, 'success');
    } else {
      const inchMatch = size.match(/(\d{2,3})\s*(?:英寸|寸)/);
      state.meta.custom.push({
        sku: sku,
        brand: brand || '手动添加',
        category: category,
        series: '',
        system: '',
        size: size,
        inch: inchMatch ? Number(inchMatch[1]) : null,
        model: model,
        platform: '电商平台',
        history: [],
        lastPrice: null,
        lastDate: '',
        offline: false,
        tags: ['手动添加'],
        note: note,
        addedAt: new Date().toISOString()
      });
      await saveMeta();
      buildRows();
      renderAll();
      setToast('已添加监控：' + sku, 'success');
    }
    const dialog = $('addDialog');
    if (dialog && dialog.open) dialog.close();
    if (collect) {
      setTimeout(() => startRun({ skus: [sku], noConfirm: true, force: true }).catch((e) => setToast('采集失败：' + errText(e), 'error')), 120);
    }
  }

  // ------------------------------------------------------------------ 导入 / 导出
  function downloadText(text, mime, filename) {
    const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 500);
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 500);
  }

  function csvCell(value) {
    const s = String(value == null ? '' : value);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function exportBackup() {
    const safeSettings = Object.assign({}, state.db.settings);
    // 备份文件可能被转发，凭据不写进去；导入后重新填 Key 即可
    if (safeSettings.aiKey) safeSettings.aiKey = '';
    const payload = {
      schema: 'price-radar.backup.v1',
      exportedAt: new Date().toISOString(),
      settings: safeSettings,
      captures: state.db.captures,
      alerts: state.db.alerts,
      runs: state.db.runs,
      records: state.db.records,
      daily: state.db.daily,
      lastRun: state.db.lastRun,
      lastAccount: state.db.lastAccount,
      meta: state.meta
    };
    downloadText(JSON.stringify(payload, null, 2), 'application/json;charset=utf-8', '竞品价格雷达-备份-' + stampNow() + '.json');
    setToast('已导出 JSON 备份（不含 AI Key）', 'success');
  }

  function exportCsv() {
    const header = ['品牌', '类型', '系列', '系统', '尺寸', '型号', 'SKU', '基准价', '基准来源', '最新价', '价格类型', '采集时间', '较基准%', '状态', '备注'];
    const lines = [header.join(',')];
    for (const row of state.rows) {
      const base = baselineOf(row);
      const latest = latestOf(row);
      const delta = deltaOf(row);
      const status = STATUS_META[statusOf(row)] || STATUS_META.never;
      lines.push([
        row.brand, row.category, row.series, row.system, row.size, row.model, row.sku,
        base.value != null ? base.value : '', base.source === 'manual' ? '手动' : base.source === 'import' ? '导入历史' : base.source === 'capture' ? '首次采集' : (base.source === 'confirmed' || base.source === 'record') ? '记录表' : '',
        latest ? latest.price : '', latest ? (KIND_LABEL[latest.kind] || latest.kind) : '',
        latest ? fmtDate(latest.at) : '', delta != null ? delta.toFixed(2) : '',
        status.label, row.note
      ].map(csvCell).join(','));
    }
    downloadText('\ufeff' + lines.join('\r\n'), 'text/csv;charset=utf-8', '竞品价格雷达-清单-' + todayStamp() + '.csv');
    setToast('已导出 CSV（' + state.rows.length + ' 行）', 'success');
  }

  // v1.1.2 新增：导出「当前筛选」的最新采集数据（CSV，Excel 可直接打开）
  // v1.1.3：行顺序固定按「基表原始顺序」（state.rows 顺序 = 内置清单 / 导入清单顺序），
  //         不受界面上「按状态/最新价」等排序影响；序号 = 基表行号。
  function exportLatestCsv() {
    const orderIndex = new Map(state.rows.map((row, idx) => [row.sku, idx]));
    const rows = filteredRows().slice().sort((a, b) => {
      const ia = orderIndex.has(a.sku) ? orderIndex.get(a.sku) : 1e9;
      const ib = orderIndex.has(b.sku) ? orderIndex.get(b.sku) : 1e9;
      return ia - ib;
    });
    if (!rows.length) {
      setToast('当前筛选没有数据可导出', 'warn');
      return;
    }
    const header = ['序号', '品牌', '类型', '尺寸', '系统', '型号', 'SKU', '基准价', '基准来源',
      '最新价', '价格类型', '采集时间', '较基准%', '状态', '标签', '备注', '商品链接'];
    const lines = [header.join(',')];
    rows.forEach((row) => {
      const base = baselineOf(row);
      const latest = latestOf(row);
      const delta = deltaOf(row);
      const status = STATUS_META[statusOf(row)] || STATUS_META.never;
      const baseSource = base.source === 'manual' ? '手动'
        : base.source === 'import' ? '导入历史'
          : base.source === 'capture' ? '首次采集'
            : (base.source === 'confirmed' || base.source === 'record') ? '记录表' : '';
      const seq = orderIndex.has(row.sku) ? orderIndex.get(row.sku) + 1 : '';
      lines.push([
        seq,
        row.brand, row.category, row.size, row.system, row.model, row.sku,
        base.value != null ? base.value : '', baseSource,
        latest ? latest.price : '',
        latest ? (KIND_LABEL[latest.kind] || latest.kind) : '',
        latest ? fmtDate(latest.at) : '',
        delta != null ? delta.toFixed(2) : '',
        status.label,
        Array.isArray(row.tags) ? row.tags.join('/') : '',
        row.note || '',
        'https://item.shop.example.com/' + row.sku + '.html'
      ].map(csvCell).join(','));
    });
    const ui = state.ui;
    const filterBits = [];
    if (ui.brand !== 'all') filterBits.push('品牌=' + ui.brand);
    if (ui.category !== 'all') filterBits.push('类型=' + ui.category);
    if (ui.size !== 'all') filterBits.push('尺寸=' + ui.size);
    if (ui.series !== 'all') filterBits.push('系列=' + ui.series);
    if (ui.system !== 'all') filterBits.push('系统=' + ui.system);
    if (ui.band !== 'all') filterBits.push('价格带');
    if (ui.tag !== 'all') filterBits.push('标签=' + ui.tag);
    if (ui.status !== 'all') filterBits.push('状态=' + ui.status);
    if (ui.q) filterBits.push('搜索=' + ui.q);
    if (ui.hideOffline) filterBits.push('隐藏已下架');
    const scope = filterBits.length ? '当前筛选（' + filterBits.join(' · ') + '）' : '全部监控';
    downloadText('\ufeff' + lines.join('\r\n'), 'text/csv;charset=utf-8',
      '竞品价格雷达-最新数据-' + stampNow() + '.csv');
    setToast('已导出最新数据 ' + rows.length + ' 行（' + scope + '，按基表顺序）', 'success');
  }

  // ------------------------------------------------------------------ 记录表查看 / 导出 / 清空（日期 × SKU 矩阵）
  function openRecords() {
    const d = $('recordsDialog');
    if (!d) return;
    renderRecordsDialog();
    if (!d.open) d.showModal();
  }

  function closeRecords() {
    const d = $('recordsDialog');
    if (d && d.open) d.close();
  }

  function recordMatrixRows() {
    const rows = [];
    const order = new Map(state.rows.map((row, idx) => [row.sku, idx]));
    for (const row of state.rows) {
      const hasAny = dailyDates().some((date) => (state.db.daily[date] || {})[row.sku]);
      if (!hasAny) continue;
      rows.push(row);
    }
    rows.sort((a, b) => (order.get(a.sku) || 0) - (order.get(b.sku) || 0));
    return rows;
  }

  function renderRecordsDialog() {
    const dates = dailyDates();
    const rows = recordMatrixRows();
    const head = $('recordsHeadRow');
    if (head) {
      head.innerHTML = ['<th>#</th>', '<th>品牌</th>', '<th>类型</th>', '<th>型号</th>', '<th>SKU</th>']
        .concat(dates.map((date) => '<th class="num' + (date === localDateKey(new Date()) ? ' is-today' : '') + '">' + esc(date) + '</th>'))
        .join('');
    }
    const tbody = $('recordsTableBody');
    if (tbody) {
      tbody.innerHTML = rows.map((row, idx) => {
        const cells = dates.map((date) => {
          const entry = (state.db.daily[date] || {})[row.sku];
          if (!entry || !isFinite(Number(entry.price))) return '<td class="num">—</td>';
          const kind = entry.kind ? (KIND_LABEL[entry.kind] || entry.kind) : '';
          return '<td class="num price-cell" title="' + esc((entry.at ? fmtDate(entry.at) : '') + (kind ? ' · ' + kind : '')) + '">' + money(entry.price) + '</td>';
        }).join('');
        return '<tr data-sku="' + esc(row.sku) + '">' +
          '<td>' + (idx + 1) + '</td>' +
          '<td>' + brandTag(row) + '</td>' +
          '<td>' + esc(row.category || '—') + '</td>' +
          '<td class="cell-model">' + esc(row.model || row.series || '—') + '</td>' +
          '<td class="sku-cell">' + esc(row.sku) + '</td>' +
          cells +
          '</tr>';
      }).join('');
    }
    const latestDate = dates.length ? dates[dates.length - 1] : '';
    const summary = $('recordsSummary');
    if (summary) {
      summary.textContent = dates.length
        ? '共 ' + dates.length + ' 天记录（' + dates[0] + ' ~ ' + latestDate + '）· 覆盖 ' + rows.length + ' 个 SKU · 当前波动的基准 = 每行最近日期列的价格'
        : '记录表还是空的：在监控清单采集后点「写入今日记录」，本批最新价会批量写进今天的日期列。';
    }
    const foot = $('recordsFootHint');
    if (foot) foot.textContent = dates.length ? '日期列：' + dates.join(' / ') : '';
    if ($('recordsExportBtn')) $('recordsExportBtn').disabled = rows.length === 0;
    if ($('recordsClearBtn')) $('recordsClearBtn').disabled = rows.length === 0 && dates.length === 0;
  }

  function exportRecordsCsv() {
    const dates = dailyDates();
    const rows = recordMatrixRows();
    if (!rows.length) {
      setToast('记录表为空，先采集并「写入今日记录」', 'warn');
      return;
    }
    const orderIndex = new Map(state.rows.map((row, idx) => [row.sku, idx]));
    const header = ['序号', '品牌', '类型', '尺寸', '系统', '型号', 'SKU'].concat(dates);
    const lines = [header.join(',')];
    rows.forEach((row) => {
      const cells = dates.map((date) => {
        const entry = (state.db.daily[date] || {})[row.sku];
        return entry && isFinite(Number(entry.price)) ? entry.price : '';
      });
      lines.push([
        (orderIndex.has(row.sku) ? orderIndex.get(row.sku) : 0) + 1,
        row.brand, row.category, row.size, row.system, row.model, row.sku
      ].concat(cells).map(csvCell).join(','));
    });
    downloadText('\ufeff' + lines.join('\r\n'), 'text/csv;charset=utf-8', '竞品价格雷达-记录表-' + stampNow() + '.csv');
    setToast('已导出记录表 ' + rows.length + ' 行 × ' + dates.length + ' 天', 'success');
  }

  async function clearRecords() {
    const dates = dailyDates();
    const rows = recordMatrixRows();
    if (!dates.length && !rows.length) {
      setToast('记录表已经是空的', 'warn');
      return;
    }
    const ok = await askConfirm(
      '清空记录表',
      '将清空 ' + dates.length + ' 天、' + rows.length + ' 个 SKU 的记录价。\n\n基准价会退回「导入历史 / 首次采集价」；采集历史和异动记录不会删除。',
      '清空记录表'
    );
    if (!ok) return;
    for (const row of state.rows) {
      const cap = captureOf(row);
      if (!cap) continue;
      delete cap.confirmedPrice;
      delete cap.confirmedCaptureAt;
      delete cap.confirmedAt;
      delete cap.recordedAt;
      delete cap.recordDate;
      delete cap.recordId;
    }
    state.db.daily = {};
    state.db.records = [];
    await saveDb();
    buildRows();
    renderAll();
    renderRecordsDialog();
    setToast('记录表已清空，基准价已退回导入历史 / 首次采集价', 'success');
    logLine('已清空记录表，基准价退回导入历史 / 首次采集价');
  }

  function exportAnalyticsCsv() {
    const data = analyticsData();
    const lines = [];
    lines.push(['分析口径', data.basis === 'base' ? '基准价' : '最新价']);
    lines.push(['竞品均价', data.avg != null ? Math.round(data.avg) : '']);
    lines.push(['价格中位数', data.median != null ? Math.round(data.median) : '']);
    lines.push(['数据覆盖%', data.coverage]);
    lines.push([]);
    lines.push(['价格带', 'SKU数', '占比%', '均价']);
    const bandTotal = data.bands.items.reduce((sum, item) => sum + item.count, 0);
    for (const item of data.bands.items) {
      lines.push([item.band.label, item.count, bandTotal ? Math.round((item.count / bandTotal) * 100) : 0, item.avg != null ? Math.round(item.avg) : '']);
    }
    lines.push([]);
    lines.push(['尺寸', 'SKU数', '均价', '中位价', '最低价', '最低价竞品', '最高价', '最高价竞品']);
    for (const s of data.sizes) {
      lines.push([
        s.key, s.count, s.avg != null ? Math.round(s.avg) : '', s.median != null ? Math.round(s.median) : '',
        s.min != null ? s.min : '', s.minRow ? (s.minRow.brand + ' ' + (s.minRow.model || '')) : '',
        s.max != null ? s.max : '', s.maxRow ? (s.maxRow.brand + ' ' + (s.maxRow.model || '')) : ''
      ]);
    }
    lines.push([]);
    lines.push(['品牌', 'SKU数', '均价', '中位价', '最低价', '最高价', '覆盖%']);
    for (const b of data.brands) {
      lines.push([b.brand, b.count, b.avg != null ? Math.round(b.avg) : '', b.median != null ? Math.round(b.median) : '', b.min != null ? b.min : '', b.max != null ? b.max : '', b.coverage]);
    }
    downloadText('\ufeff' + lines.map((line) => line.map(csvCell).join(',')).join('\r\n'), 'text/csv;charset=utf-8', '竞品价格雷达-分析-' + todayStamp() + '.csv');
    setToast('已导出分析 CSV', 'success');
  }

  function readFileText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('文件读取失败'));
      reader.readAsText(file, 'utf-8');
    });
  }

  async function handleImportFile(file) {
    if (!file) return;
    if (state.running) { setToast('采集进行中，请先停止再导入', 'warn'); return; }
    let data = null;
    try {
      data = JSON.parse(await readFileText(file));
    } catch (e) {
      setToast('导入失败：不是有效的 JSON 文件', 'error');
      return;
    }
    if (data && data.schema === 'price-radar.watchlist.v1' && Array.isArray(data.skus)) {
      let added = 0;
      for (const item of data.skus) {
        if (!item || !item.sku) continue;
        const sku = String(item.sku);
        if (rowBySku(sku)) continue;
        state.meta.custom.push(Object.assign({}, item, { sku: sku, addedAt: new Date().toISOString(), tags: ['外部导入'] }));
        added++;
      }
      await saveMeta();
      buildRows();
      renderAll();
      setToast('已导入监控清单：新增 ' + added + ' 个 SKU', 'success');
      return;
    }
    if (!data || (data.schema !== 'price-radar.backup.v1' && !data.captures && !data.meta && !data.settings)) {
      setToast('导入失败：无法识别这个 JSON 格式', 'error');
      return;
    }
    const ok = await askConfirm(
      '导入备份',
      '导入会覆盖本机的采集记录、异动、任务历史和设置，并替换监控清单的手动改动。\n\n内置监控清单不会被删除。确定继续？',
      '导入并覆盖'
    );
    if (!ok) return;
    state.db = normalizeDb({
      settings: data.settings,
      captures: data.captures,
      alerts: data.alerts,
      runs: data.runs,
      records: data.records,
      daily: data.daily,
      lastRun: data.lastRun,
      lastAccount: data.lastAccount
    });
    state.meta = normalizeMeta(data.meta);
    buildRows();
    await saveDb();
    await saveMeta();
    renderAll();
    setToast('备份已导入', 'success');
  }

  async function resetAllData() {
    if (state.running) { setToast('采集进行中，请先停止再重置', 'warn'); return; }
    const ok = await askConfirm('重置全部本地数据', '将清空采集记录、异动、任务历史、设置和监控清单的手动改动（内置 176 个 SKU 会恢复）。\n\n此操作不可撤销，建议先导出备份。', '确认重置');
    if (!ok) return;
    try { await chrome.storage.local.remove([KEY_DB, KEY_META]); } catch (e) { /* 忽略 */ }
    state.db = normalizeDb({});
    state.meta = normalizeMeta({});
    state.selected.clear();
    buildRows();
    await saveDb();
    await saveMeta();
    renderAll();
    setToast('已重置全部本地数据', 'success');
  }

  async function clearCaptures() {
    if (state.running) { setToast('采集进行中，请先停止再清空', 'warn'); return; }
    const ok = await askConfirm('清空采集记录', '将清空所有 SKU 的采集价格和采集历史（监控清单、设置、异动记录保留）。', '清空采集');
    if (!ok) return;
    state.db.captures = {};
    state.lastRaw = null;
    await saveDb();
    renderAll();
    setToast('已清空采集记录', 'success');
  }

  async function clearAlerts() {
    if (state.running) { setToast('采集进行中，请先停止再清空', 'warn'); return; }
    const ok = await askConfirm('清空异动记录', '将清空所有异动提醒（采集记录和监控清单保留）。', '清空异动');
    if (!ok) return;
    state.db.alerts = [];
    await saveDb();
    renderAll();
    setToast('已清空异动记录', 'success');
  }

  // ------------------------------------------------------------------ 事件绑定
  function on(id, event, handler) {
    const el = $(id);
    if (el) el.addEventListener(event, handler);
  }

  function closeDialog(id) {
    const dialog = $(id);
    if (dialog && dialog.open) dialog.close();
  }

  function bindEvents() {
    // 导航 / 顶栏
    $$('.nav-item').forEach((btn) => btn.addEventListener('click', () => switchView(btn.dataset.view)));
    on('menuBtn', 'click', () => toggleSidebar());
    on('topSettingsBtn', 'click', openSettings);
    on('settingsBtn', 'click', openSettings);
    on('helpBtn', 'click', () => { const d = $('helpDialog'); if (d && !d.open) d.showModal(); });
    on('quickRunBtn', 'click', () => {
      if (state.running) { setToast('采集进行中，请先等待或停止', 'warn'); return; }
      switchView('watchlist');
      setTimeout(() => startRun({ scope: state.db.settings.lastScope || 'filtered' }), 80);
    });
    on('importBtn', 'click', () => $('importFile') && $('importFile').click());
    on('exportBtn', 'click', exportBackup);
    on('exportCsvBtn', 'click', exportCsv);
    on('exportLatestBtn', 'click', exportLatestCsv);

    // 总览
    on('heroRunBtn', 'click', () => { switchView('watchlist'); setTimeout(() => startRun({ scope: 'all' }), 80); });
    on('heroAlertBtn', 'click', () => switchView('alerts'));
    on('heroAddBtn', 'click', openAddDialog);
    on('dashAllAlerts', 'click', () => switchView('alerts'));
    on('dashToWatch', 'click', () => switchView('watchlist'));
    on('dashToWatchlist2', 'click', () => switchView('watchlist'));
    on('dashToRuns', 'click', () => switchView('runs'));
    on('dashToAnalytics', 'click', () => switchView('analytics'));
    // 分析视图
    on('anaCategory', 'change', (event) => { state.analytics.category = event.target.value; renderAnalytics(); });
    on('anaSize', 'change', (event) => { state.analytics.size = event.target.value; renderAnalytics(); });
    on('anaBasis', 'change', (event) => { state.analytics.basis = event.target.value; renderAnalytics(); });
    on('anaExportBtn', 'click', exportAnalyticsCsv);
    // 波动看板
    on('volDim', 'change', (event) => { state.volatility.dim = event.target.value; renderVolatility(); });
    on('volMetric', 'change', (event) => { state.volatility.metric = event.target.value; renderVolatility(); });
    on('volCategory', 'change', (event) => { state.volatility.category = event.target.value; renderVolatility(); });
    on('volSort', 'change', (event) => { state.volatility.sort = event.target.value; renderVolatility(); });
    let volSearchTimer = null;
    on('volSearch', 'input', (event) => {
      const value = event.target.value;
      clearTimeout(volSearchTimer);
      volSearchTimer = setTimeout(() => { state.volatility.q = value.trim(); renderVolatility(); }, 160);
    });
    const volGroupRows = $('volGroupRows');
    if (volGroupRows) {
      volGroupRows.addEventListener('click', (event) => {
        const tr = event.target.closest('tr[data-vol-group]');
        if (!tr) return;
        const value = tr.dataset.volGroup;
        const dim = state.volatility.dim;
        if (dim === 'size') { const m = String(value).match(/\d{2,3}/); state.ui.q = m ? m[0] : ''; state.ui.size = 'all'; }
        else if (dim === 'system') { state.ui.system = value; state.ui.q = ''; }
        else if (dim === 'brand') { state.ui.brand = value; state.ui.q = ''; }
        else { state.ui.category = value; state.ui.q = ''; }
        switchView('watchlist');
      });
    }
    const volTopSkus = $('volTopSkus');
    if (volTopSkus) {
      volTopSkus.addEventListener('click', (event) => {
        const btn = event.target.closest('[data-sku]');
        if (btn) openDrawer(btn.dataset.sku);
      });
    }
    const volSkuRows = $('volSkuRows');
    if (volSkuRows) {
      volSkuRows.addEventListener('click', (event) => {
        const tr = event.target.closest('tr[data-sku]');
        if (tr) openDrawer(tr.dataset.sku);
      });
    }
    const heatmap = $('anaHeatmap');
    if (heatmap) {
      heatmap.addEventListener('click', (event) => {
        const cell = event.target.closest('.heat-cell');
        if (!cell || !cell.dataset.heatBrand) return;
        state.ui.brand = cell.dataset.heatBrand;
        state.ui.size = 'all';
        state.ui.q = cell.dataset.heatSize === 'other' ? '' : cell.dataset.heatSize;
        switchView('watchlist');
        setToast('已筛选：' + cell.dataset.heatBrand + (cell.dataset.heatSize === 'other' ? '' : ' · ' + cell.dataset.heatSize + ' 英寸段'), 'success');
      });
    }
    const sizeRows = $('anaSizeRows');
    if (sizeRows) {
      sizeRows.addEventListener('click', (event) => {
        const tr = event.target.closest('tr[data-size]');
        if (!tr) return;
        state.ui.size = 'all';
        state.ui.q = String(tr.dataset.size || '').replace('英寸', '');
        switchView('watchlist');
      });
    }
    const brandRows = $('anaBrandRows');
    if (brandRows) {
      brandRows.addEventListener('click', (event) => {
        const tr = event.target.closest('tr[data-brand]');
        if (!tr) return;
        state.ui.brand = tr.dataset.brand;
        state.ui.q = '';
        switchView('watchlist');
      });
    }
    const dashSizeLowest = $('dashSizeLowest');
    if (dashSizeLowest) {
      dashSizeLowest.addEventListener('click', (event) => {
        const btn = event.target.closest('[data-size]');
        if (!btn) return;
        state.ui.size = 'all';
        state.ui.q = String(btn.dataset.size || '').replace('英寸', '');
        switchView('watchlist');
      });
    }
    const kpiGrid = $('kpiGrid');
    if (kpiGrid) {
      kpiGrid.addEventListener('click', (event) => {
        const card = event.target.closest('[data-kpi]');
        if (!card) return;
        const kpi = card.dataset.kpi;
        if (kpi === 'alerts') { switchView('alerts'); state.alertFilter = 'new'; renderAlerts(); return; }
        if (kpi === 'drop' || kpi === 'rise') {
          state.alertFilter = 'all';
          switchView('alerts');
          renderAlerts();
          return;
        }
        if (kpi === 'fail') { switchView('watchlist', { filterStatus: 'fail' }); return; }
        if (kpi === 'today') { switchView('watchlist', { filterStatus: 'captured' }); return; }
        switchView('watchlist', { filterStatus: 'all' });
      });
    }
    const dashAlerts = $('dashAlerts');
    if (dashAlerts) {
      dashAlerts.addEventListener('click', (event) => {
        const btn = event.target.closest('[data-sku]');
        if (btn) openDrawer(btn.dataset.sku);
      });
    }
    const dashChangeBody = $('dashChangeBody');
    if (dashChangeBody) {
      dashChangeBody.addEventListener('click', (event) => {
        const btn = event.target.closest('[data-act="drawer"]');
        if (btn) { openDrawer(btn.dataset.sku); return; }
        const tr = event.target.closest('tr[data-sku]');
        if (tr) openDrawer(tr.dataset.sku);
      });
    }
    const dashRunBrief = $('dashRunBrief');
    if (dashRunBrief) {
      dashRunBrief.addEventListener('click', (event) => {
        const btn = event.target.closest('[data-act]');
        if (!btn) return;
        if (btn.dataset.act === 'start') { switchView('watchlist'); setTimeout(() => startRun({ scope: 'all' }), 80); }
        if (btn.dataset.act === 'review') switchView('watchlist', { filterStatus: 'review' });
      });
    }

    // 监控清单：筛选
    const chips = $('brandChips');
    if (chips) {
      chips.addEventListener('click', (event) => {
        const chip = event.target.closest('[data-brand]');
        if (!chip) return;
        state.ui.brand = chip.dataset.brand;
        renderWatchFilters();
        renderWatchTable();
        renderHeader();
      });
    }
    on('filterCategory', 'change', (event) => { state.ui.category = event.target.value; renderWatchTable(); renderHeader(); });
    on('filterSize', 'change', (event) => { state.ui.size = event.target.value; renderWatchTable(); renderHeader(); });
    on('filterSeries', 'change', (event) => { state.ui.series = event.target.value; renderWatchTable(); renderHeader(); });
    on('filterSystem', 'change', (event) => { state.ui.system = event.target.value; renderWatchTable(); renderHeader(); });
    on('filterBand', 'change', (event) => { state.ui.band = event.target.value; renderWatchTable(); renderHeader(); });
    on('filterTag', 'change', (event) => { state.ui.tag = event.target.value; renderWatchTable(); renderHeader(); });
    on('filterStatus', 'change', (event) => { state.ui.status = event.target.value; renderWatchTable(); renderHeader(); });
    on('densityBtn', 'click', () => { state.ui.density = state.ui.density === 'compact' ? 'comfortable' : 'compact'; renderWatchFilters(); renderWatchTable(); });
    on('hideOfflineChk', 'change', (event) => { state.ui.hideOffline = !!event.target.checked; renderWatchTable(); renderHeader(); });
    let searchTimer = null;
    on('searchInput', 'input', (event) => {
      const value = event.target.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { state.ui.q = value.trim(); renderWatchTable(); renderHeader(); }, 160);
    });
    on('clearFiltersBtn', 'click', () => {
      state.ui = {
        brand: 'all', category: 'all', size: 'all', series: 'all', system: 'all', band: 'all', tag: 'all',
        status: 'all', q: '', sort: 'updated', dir: 'desc', density: state.ui.density, hideOffline: false
      };
      renderWatchFilters();
      renderWatchTable();
      renderHeader();
    });
    on('addWatchBtn', 'click', openAddDialog);
    on('collectSelectedBtn', 'click', () => startRun({ scope: 'selected' }));
    on('compareSelectedBtn', 'click', openCompare);
    on('compareSelectedBarBtn', 'click', openCompare);
    on('collectSelectedBarBtn', 'click', () => startRun({ scope: 'selected' }));
    on('clearSelectionBtn', 'click', () => {
      state.selected.clear();
      renderWatchTable();
      renderHeaderCountsOnly();
      updateSelectionButtons();
    });
    on('compareClose', 'click', closeCompare);
    on('compareOk', 'click', closeCompare);
    on('alertTypeFilter', 'change', (event) => { state.alertType = event.target.value; renderAlerts(); });

    // 清单排序
    $$('#watchTable thead th.sortable').forEach((th) => {
      th.addEventListener('click', () => {
        const key = th.dataset.sort;
        if (!key) return;
        if (state.ui.sort === key) state.ui.dir = state.ui.dir === 'asc' ? 'desc' : 'asc';
        else { state.ui.sort = key; state.ui.dir = key === 'brand' || key === 'category' || key === 'size' || key === 'sku' ? 'asc' : 'desc'; }
        renderWatchTable();
      });
    });

    // 清单表格
    const tableBody = $('watchTableBody');
    if (tableBody) {
      tableBody.addEventListener('click', (event) => {
        const checkbox = event.target.closest('input[data-check]');
        if (checkbox) {
          const sku = checkbox.dataset.check;
          if (checkbox.checked) state.selected.add(sku);
          else state.selected.delete(sku);
          const tr = checkbox.closest('tr');
          if (tr) tr.classList.toggle('selected', checkbox.checked);
          renderHeaderCountsOnly();
          updateSelectionButtons();
          return;
        }
        const button = event.target.closest('button[data-act]');
        if (button) {
          event.stopPropagation();
          const sku = button.dataset.sku;
          if (button.dataset.act === 'capture') {
            startRun({ skus: [sku], noConfirm: true, force: true }).catch((e) => setToast('采集失败：' + errText(e), 'error'));
          } else if (button.dataset.act === 'preview') {
            if (state.preview.sku === sku && state.preview.winId != null) closePreview();
            else openPreview(sku, true);
          } else if (button.dataset.act === 'drawer') {
            openDrawer(sku);
          }
          return;
        }
        const tr = event.target.closest('tr[data-sku]');
        if (tr) openDrawer(tr.dataset.sku);
      });
      tableBody.addEventListener('mouseover', (event) => {
        const btn = event.target.closest('button[data-act="preview"]');
        if (btn) schedulePreview(btn.dataset.sku);
      });
      tableBody.addEventListener('mouseout', (event) => {
        const btn = event.target.closest('button[data-act="preview"]');
        if (btn) scheduleClosePreview();
      });
    }
    on('selectAllChk', 'change', (event) => {
      const checked = event.target.checked;
      const rows = filteredRows();
      for (const row of rows) {
        if (checked) state.selected.add(row.sku);
        else state.selected.delete(row.sku);
      }
      renderWatchTable();
    });

    // 运行条
    const modeSeg = $('runModeSeg');
    if (modeSeg) {
      modeSeg.addEventListener('click', (event) => {
        const btn = event.target.closest('[data-mode]');
        if (!btn || state.running) return;
        state.db.settings.mode = btn.dataset.mode;
        saveDb();
        renderRunUI();
      });
    }
    on('runScope', 'change', (event) => {
      state.db.settings.lastScope = event.target.value;
      saveDb();
    });
    on('runBatch', 'change', (event) => {
      state.db.settings.batch = Math.max(0, Math.round(Number(event.target.value) || 0));
      saveDb();
    });
    on('startRunBtn', 'click', () => startRun({}));
    on('recheckBtn', 'click', () => startRun({ recheck: true }));
    on('pauseRunBtn', 'click', pauseOrResume);
    on('stopRunBtn', 'click', stopRun);
    on('confirmRunBtn', 'click', () => confirmAllLatest().catch((e) => setToast('写入记录表失败：' + errText(e), 'error')));
    on('recordsBtn', 'click', openRecords);
    on('recordsClose', 'click', closeRecords);
    on('recordsOk', 'click', closeRecords);
    on('recordsExportBtn', 'click', exportRecordsCsv);
    on('recordsClearBtn', 'click', () => clearRecords().catch((e) => setToast('清空记录表失败：' + errText(e), 'error')));
    on('dockPause', 'click', pauseOrResume);
    on('dockStop', 'click', stopRun);
    on('dockToggle', 'click', () => {
      state.dockCollapsed = !state.dockCollapsed;
      renderRunUI();
    });

    // 异动中心
    const alertTabs = $('alertTabs');
    if (alertTabs) {
      alertTabs.addEventListener('click', (event) => {
        const tab = event.target.closest('[data-status]');
        if (!tab) return;
        state.alertFilter = tab.dataset.status;
        renderAlerts();
      });
    }
    on('alertLevelFilter', 'change', (event) => { state.alertLevel = event.target.value; renderAlerts(); });
    on('markAllReadBtn', 'click', markAllAlertsHandled);
    const alertList = $('alertList');
    if (alertList) {
      alertList.addEventListener('click', (event) => {
        const btn = event.target.closest('[data-act]');
        if (!btn) return;
        const alert = state.db.alerts.find((a) => a.id === btn.dataset.alert);
        if (btn.dataset.act === 'view') { if (alert) openDrawer(alert.sku); return; }
        if (btn.dataset.act === 'handle') { updateAlert(btn.dataset.alert, 'handled'); return; }
        if (btn.dataset.act === 'ignore') { updateAlert(btn.dataset.alert, 'ignored'); return; }
        if (btn.dataset.act === 'reopen') { updateAlert(btn.dataset.alert, 'new'); return; }
      });
    }

    // 抽屉
    on('drawerClose', 'click', closeDrawer);
    on('drawerMask', 'click', closeDrawer);
    on('drawerCopySku', 'click', async () => {
      const row = rowBySku(state.drawerSku);
      if (!row) return;
      const ok = await copyText(row.sku);
      setToast(ok ? '已复制 SKU：' + row.sku : '复制失败', ok ? 'success' : 'error');
    });
    on('drawerCaptureBtn', 'click', () => {
      const sku = state.drawerSku;
      if (!sku) return;
      closeDrawer();
      startRun({ skus: [sku], noConfirm: true, force: true }).catch((e) => setToast('采集失败：' + errText(e), 'error'));
    });
    on('drawerOpenBtn', 'click', () => {
      const row = rowBySku(state.drawerSku);
      if (row) chrome.tabs.create({ url: ITEM_URL(row.sku), active: true }).catch(() => {});
    });
    on('drawerIgnoreBtn', 'click', async () => {
      const row = rowBySku(state.drawerSku);
      if (!row) return;
      const override = state.meta.overrides[row.sku] || {};
      override.ignored = !row.ignored;
      state.meta.overrides[row.sku] = override;
      await saveMeta();
      buildRows();
      renderAll();
      setToast(override.ignored ? '已忽略该 SKU（可在筛选「已忽略」里恢复）' : '已恢复监控', 'success');
    });
    on('drawerConfirmBtn', 'click', async () => {
      if (!state.drawerSku) return;
      await confirmOne(state.drawerSku);
    });
    on('drawerOfflineBtn', 'click', async () => {      const row = rowBySku(state.drawerSku);
      if (!row) return;
      const next = !row.offline;
      await setRowOffline(row.sku, next);
      renderAll();
      setToast(next ? '已标记为下架（自动采集会跳过，可在状态筛选「已下架」里恢复）' : '已恢复上架，重新加入自动采集', 'success');
    });
    on('drawerBaselineSave', 'click', async () => {
      const row = rowBySku(state.drawerSku);
      if (!row) return;
      const raw = $('drawerBaselineInput') ? $('drawerBaselineInput').value.trim() : '';
      const override = state.meta.overrides[row.sku] || {};
      if (!raw) { delete override.baseline; }
      else {
        const value = Number(raw);
        if (!isFinite(value) || value <= 0) { setToast('请输入大于 0 的基准价', 'error'); return; }
        override.baseline = value;
      }
      state.meta.overrides[row.sku] = override;
      await saveMeta();
      buildRows();
      renderAll();
      setToast('基准价已保存', 'success');
    });
    on('drawerBaselineLatest', 'click', async () => {
      const row = rowBySku(state.drawerSku);
      const latest = latestOf(row);
      if (!row || !latest) { setToast('还没有采集价，无法使用最新价', 'warn'); return; }
      const override = state.meta.overrides[row.sku] || {};
      override.baseline = latest.price;
      state.meta.overrides[row.sku] = override;
      await saveMeta();
      buildRows();
      renderAll();
      setToast('基准价已改为最新采集价 ' + money(latest.price), 'success');
    });
    on('drawerBaselineImport', 'click', async () => {
      const row = rowBySku(state.drawerSku);
      if (!row || row.lastPrice == null) { setToast('这个 SKU 没有导入历史价', 'warn'); return; }
      const override = state.meta.overrides[row.sku] || {};
      delete override.baseline;
      state.meta.overrides[row.sku] = override;
      await saveMeta();
      buildRows();
      renderAll();
      setToast('已恢复为导入历史价 ' + money(row.lastPrice), 'success');
    });
    on('drawerBaselineAuto', 'click', async () => {
      const row = rowBySku(state.drawerSku);
      if (!row) return;
      const override = state.meta.overrides[row.sku] || {};
      delete override.baseline;
      state.meta.overrides[row.sku] = override;
      await saveMeta();
      buildRows();
      renderAll();
      setToast('已恢复自动基准价', 'success');
    });
    on('drawerNoteSave', 'click', async () => {
      const row = rowBySku(state.drawerSku);
      if (!row) return;
      const override = state.meta.overrides[row.sku] || {};
      override.note = ($('drawerNote') && $('drawerNote').value.trim()) || '';
      state.meta.overrides[row.sku] = override;
      await saveMeta();
      buildRows();
      renderAll();
      setToast('备注已保存', 'success');
    });

    // 设置
    on('settingsForm', 'submit', (event) => { event.preventDefault(); saveSettings(); });
    on('settingsClose', 'click', () => closeDialog('settingsDialog'));
    on('settingsCancel', 'click', () => closeDialog('settingsDialog'));
    on('settingsSave', 'click', saveSettings);
    on('setExportBtn', 'click', exportBackup);
    on('setImportBtn', 'click', () => $('importFile') && $('importFile').click());
    on('setClearCapturesBtn', 'click', clearCaptures);
    on('setResetAlertsBtn', 'click', clearAlerts);
    on('setResetAllBtn', 'click', resetAllData);
    on('copyDebugBtn', 'click', async () => {
      const raw = state.lastRaw || latestRawOfAll();
      if (!raw) { setToast('还没有采集记录', 'warn'); return; }
      const ok = await copyText(JSON.stringify(raw, null, 2));
      setToast(ok ? '已复制最近一次取价 JSON' : '复制失败', ok ? 'success' : 'error');
    });

    // 添加监控
    on('addForm', 'submit', (event) => { event.preventDefault(); addMonitor(false); });
    on('addClose', 'click', () => closeDialog('addDialog'));
    on('addCancel', 'click', () => closeDialog('addDialog'));
    on('addOnlyBtn', 'click', () => addMonitor(false));
    on('addAndCollectBtn', 'click', () => addMonitor(true));
    on('addSkuInput', 'keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); addMonitor(false); }
    });

    // 帮助
    on('helpClose', 'click', () => closeDialog('helpDialog'));
    on('helpOk', 'click', () => closeDialog('helpDialog'));

    // 确认框
    on('confirmOk', 'click', () => settleConfirm(true));
    on('confirmCancel', 'click', () => settleConfirm(false));
    const confirmDialog = $('confirmDialog');
    if (confirmDialog) {
      confirmDialog.addEventListener('cancel', (event) => { event.preventDefault(); settleConfirm(false); });
    }
    ['settingsDialog', 'addDialog', 'helpDialog'].forEach((id) => {
      const dialog = $(id);
      if (dialog) dialog.addEventListener('click', (event) => {
        if (event.target === dialog) dialog.close();
      });
    });

    // 导入
    on('importFile', 'change', (event) => {
      const file = event.target.files && event.target.files[0];
      event.target.value = '';
      if (file) handleImportFile(file);
    });

    // 键盘
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        if (state.drawerSku) { closeDrawer(); return; }
        if (state.sidebarOpen) toggleSidebar(false);
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        switchView('watchlist');
        setTimeout(() => { const input = $('searchInput'); if (input) { input.focus(); input.select(); } }, 50);
      }
    });

    window.addEventListener('beforeunload', (event) => {
      if (!state.running) return;
      event.preventDefault();
      event.returnValue = '采集任务还在进行中，关闭页面会中断任务。';
      return event.returnValue;
    });
  }

  // ------------------------------------------------------------------ 运行时监听
  function setupRuntimeListeners() {
    if (chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener((msg, sender) => {
        if (!msg || msg.type !== 'RADAR_ITEM_PRICE_RESULT') return;
        const run = state.run;
        if (!run) return;
        if (!sender || !sender.tab || sender.tab.id !== run.runnerTabId) return;
        if (!state.pending) {
          state.pendingBuffer = { tabId: sender.tab.id, msg: msg, at: Date.now() };
          return;
        }
        if (msg.sku !== state.pending.sku) return;
        const pending = state.pending;
        state.pending = null;
        clearTimeout(pending.timer);
        pending.resolve(msg);
      });
    }

    if (chrome.tabs && chrome.tabs.onUpdated) {
      chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
        const run = state.run;
        if (!run || tabId !== run.runnerTabId) return;
        const task = run.tasks[run.idx];
        if (!task) return;
        if (run.redirectHandled === task.sku) return;
        const url = changeInfo.url || (tab && tab.url) || '';
        if (!url || !/^https?:\/\//i.test(url)) return;
        const nav = classifyNavigation(url, task.sku);
        if (!nav) return;
        run.redirectHandled = task.sku;
        logLine('⚠ 页面跳转：' + url + '（' + nav.reason + '）');
        resolvePendingResult(navResultFor(task.sku, url, nav));
      });
    }

    if (chrome.tabs && chrome.tabs.onRemoved) {
      chrome.tabs.onRemoved.addListener((tabId) => {
        const run = state.run;
        if (!run || tabId !== run.runnerTabId) return;
        failPending('采集用的标签页被关闭了');
        if (state.running) {
          state.stopped = true;
          state.paused = false;
          logLine('采集用的标签页被关闭，任务停止');
        }
      });
    }

    if (chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || state.running) return;
        let dirty = false;
        if (changes[KEY_META]) {
          const next = normalizeMeta(changes[KEY_META].newValue);
          // 用稳定序列化比较：自己写入时 storage 读回的键顺序可能不同，否则会误判为“其他标签页更新”并弹同步提示
          if (stableStringify(next) !== stableStringify(state.meta)) { state.meta = next; dirty = true; }
        }
        if (changes[KEY_DB]) {
          const next = normalizeDb(changes[KEY_DB].newValue);
          if (stableStringify(next) !== stableStringify(state.db)) { state.db = next; dirty = true; }
        }
        if (dirty) {
          buildRows();
          renderAll();
          setToast('已同步其他工作台标签页的数据', 'success');
        }
      });
    }
  }

  // ------------------------------------------------------------------ 启动
  async function init() {
    await loadAll();
    bindEvents();
    setupRuntimeListeners();
    if ($('runScope')) $('runScope').value = state.db.settings.lastScope || 'filtered';
    renderAll();
    renderLogs();
    updateStorageInfo();
    if (!state.rows.length) {
      setToast('内置监控清单为空：检查 extension/data/competitor-skus.json', 'error');
    }
    // 调试入口（只读观察用，不影响正常逻辑）
    window.__priceRadar = {
      state: state,
      startRun: startRun,
      collectTasks: collectTasks,
      renderAll: renderAll,
      openDrawer: openDrawer,
      handleImportFile: handleImportFile,
      exportBackup: exportBackup,
      exportAnalyticsCsv: exportAnalyticsCsv,
      analyticsData: analyticsData,
      volatilityData: volatilityData,
      peerStats: peerStats,
      baselineOf: baselineOf,
      confirmAllLatest: confirmAllLatest,
      openCompare: openCompare
    };
  }

  init().catch((e) => {
    console.error(e);
    setToast('初始化失败：' + errText(e), 'error');
  });
})();
