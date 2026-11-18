'use strict';

// 电商平台价格巡检工作台 v1.0
// - 读取扩展内置的 SKU 巡检基表（由 tools/build_base_from_xlsx.py 从 SKU巡检表.xlsx 生成）
// - 用户在 Edge 登录普惠 / PLUS 账号后，点巡检按钮，后台按节奏逐个打开商品页读取页面价格
// - 结果对照「普惠最低到手价 / 会员最低到手价」阈值，标红预警，可导出 CSV
// - 所有数据只存在本机 chrome.storage.local

const STORAGE_KEY = 'patrol.db.v2';
const PRICE_TIMEOUT_MS = 35000;
const ITEM_URL = (sku) => 'https://item.shop.example.com/' + sku + '.html';

const DEFAULT_SETTINGS = {
  batchSize: 40,
  delayMin: 3,
  delayMax: 6,
  skipCapturedToday: true,
  scope: 'all',
  keepTab: false,
  deviationLimit: 500,
  deviationRetries: 3,
  deviationConfirmLimit: 1500,
  previewDelayMs: 1000
};

const DEFAULT_DB = {
  version: 2,
  settings: Object.assign({}, DEFAULT_SETTINGS),
  skuOverrides: {},
  captures: {},
  reportRows: [],
  offlineRows: [],
  offlineSkus: [],
  baseOverride: null,
  lastRun: null,
  lastAccount: '',
  lastIdentity: 'util',
  lastSavedAt: null,
  dismissedBanner: false
};

const state = {
  db: null,
  base: null,
  rows: [],
  filter: { sheet: '全部', search: '', status: 'all' },
  view: '',
  ovFilter: { key: 'all', sheet: '全部' },
  running: false,
  paused: false,
  stopped: false,
  run: null,
  pending: null,
  autoRunMode: false,
  selected: new Set(),
  baseManager: { sheet: '', draft: null }
};

const URL_PARAMS = new URLSearchParams(location.search);
const IS_AUTORUN = URL_PARAMS.get('autorun') === '1';

const $ = (id) => document.getElementById(id);
const els = {
  statsBar: $('statsBar'),
  accountInfo: $('accountInfo'),
  riskBanner: $('riskBanner'),
  dismissBanner: $('dismissBanner'),
  viewWorkbench: $('viewWorkbench'),
  viewOverview: $('viewOverview'),
  tabWorkbench: $('tabWorkbench'),
  tabOverview: $('tabOverview'),
  viewHint: $('viewHint'),
  tableCaption: $('tableCaption'),
  ovCards: $('ovCards'),
  ovUtilFill: $('ovUtilFill'),
  ovUtilText: $('ovUtilText'),
  ovPlusFill: $('ovPlusFill'),
  ovPlusText: $('ovPlusText'),
  ovSheetTabs: $('ovSheetTabs'),
  ovFilterHint: $('ovFilterHint'),
  ovClearFilterBtn: $('ovClearFilterBtn'),
  ovConfirmBtn: $('ovConfirmBtn'),
  ovOfflineBtn: $('ovOfflineBtn'),
  ovSummaryBtn: $('ovSummaryBtn'),
  ovExportReportBtn: $('ovExportReportBtn'),
  ovClearReportBtn: $('ovClearReportBtn'),
  reportBadge: $('reportBadge'),
  reportArea: $('reportArea'),
  reportCount: $('reportCount'),
  reportList: $('reportList'),
  importDataBtn: $('importDataBtn'),
  importDataFile: $('importDataFile'),
  manageBaseBtn: $('manageBaseBtn'),
  baseDialog: $('baseDialog'),
  baseCatTabs: $('baseCatTabs'),
  baseAddCatBtn: $('baseAddCatBtn'),
  baseRenameCatBtn: $('baseRenameCatBtn'),
  baseDelCatBtn: $('baseDelCatBtn'),
  baseExportBtn: $('baseExportBtn'),
  baseTblBody: $('baseTblBody'),
  baseAddRowBtn: $('baseAddRowBtn'),
  baseSaveBtn: $('baseSaveBtn'),
  baseCloseBtn: $('baseCloseBtn'),
  sheetTabs: $('sheetTabs'),
  statusFilter: $('statusFilter'),
  searchInput: $('searchInput'),
  exportBtn: $('exportBtn'),
  importBtn: $('importBtn'),
  importFile: $('importFile'),
  resetBaseBtn: $('resetBaseBtn'),
  purgeBtn: $('purgeBtn'),
  runUtilBtn: $('runUtilBtn'),
  runPlusBtn: $('runPlusBtn'),
  multiRerunBtn: $('multiRerunBtn'),
  selectAllChk: $('selectAllChk'),
  pauseBtn: $('pauseBtn'),
  stopBtn: $('stopBtn'),
  runHint: $('runHint'),
  progressWrap: $('progressWrap'),
  progressText: $('progressText'),
  progressPct: $('progressPct'),
  progressFill: $('progressFill'),
  runStats: $('runStats'),
  logPanel: $('logPanel'),
  tblBody: $('tblBody'),
  empty: $('empty'),
  baseInfo: $('baseInfo'),
  settingsBtn: $('settingsBtn'),
  settingsDialog: $('settingsDialog'),
  settingsForm: $('settingsForm'),
  helpBtn: $('helpBtn'),
  helpDialog: $('helpDialog'),
  helpClose: $('helpClose'),
  exportJsonBtn: $('exportJsonBtn'),
  copyDebugBtn: $('copyDebugBtn'),
  setBatch: $('setBatch'),
  setDelayMin: $('setDelayMin'),
  setDelayMax: $('setDelayMax'),
  setSkipToday: $('setSkipToday'),
  setScope: $('setScope'),
  setKeepTab: $('setKeepTab'),
  setDeviationLimit: $('setDeviationLimit'),
  setDeviationRetries: $('setDeviationRetries'),
  setDeviationConfirm: $('setDeviationConfirm'),
  setPreviewDelay: $('setPreviewDelay'),
  debugBox: $('debugBox'),
  settingsCancel: $('settingsCancel'),
  settingsSave: $('settingsSave'),
  toast: $('toast')
};

// ---------------- 工具 ----------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const errText = (e) => (e && e.message) || String(e);

function fmtMoney(n) {
  if (n == null || isNaN(n)) return '—';
  return '¥' + Number(n).toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function fmtNum(n) {
  if (n == null || isNaN(n)) return '—';
  return Number(n).toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function isToday(iso) {
  if (!iso) return false;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return false;
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}

function todayStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate());
}

let toastTimer = null;
function setToast(text, ms) {
  els.toast.textContent = text;
  els.toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.add('hidden'), ms || 3200);
}

function logLine(text) {
  const line = '[' + new Date().toLocaleTimeString('zh-CN', { hour12: false }) + '] ' + text;
  const panel = els.logPanel;
  panel.textContent = (panel.textContent ? panel.textContent + '\n' : '') + line;
  const lines = panel.textContent.split('\n');
  if (lines.length > 300) panel.textContent = lines.slice(lines.length - 300).join('\n');
  panel.scrollTop = panel.scrollHeight;
}

const KIND_LABEL = { hand: '到手价', main: '电商平台价', plus: 'PLUS价', manual: '手动', unknown: '价格' };
const kindLabel = (kind) => KIND_LABEL[kind] || '价格';

// ---------------- 轨道标识（区分原轨道 / 第二轨道） ----------------
const TRACK_INFO = {
  key: 'track1',
  label: '轨道① · 后台标签页',
  meta: '后台标签页 · 原轨道'
};

function applyTrackIdentity() {
  document.title = '【轨道①】电商平台价格巡检工作台';
  document.body.classList.add('track1');
  const badge = document.getElementById('trackBadge');
  if (badge) badge.textContent = '轨道① · 后台标签页';
  const meta = document.getElementById('trackMeta');
  if (meta) meta.textContent = '后台标签页 · 原轨道';
  const info = document.getElementById('trackInfo');
  if (info) {
    info.textContent = '当前使用： ' + TRACK_INFO.label + '\n扩展ID： ' + chrome.runtime.id + '\n扩展目录： ' + '巡检插件版\\extension';
  }
}

// ---------------- 存储 ----------------
async function loadDb() {
  let stored = {};
  try {
    const got = await chrome.storage.local.get(STORAGE_KEY);
    stored = (got && got[STORAGE_KEY]) || {};
  } catch (e) {
    stored = {};
  }
  state.db = {
    version: 2,
    settings: Object.assign({}, DEFAULT_SETTINGS, stored.settings || {}),
    skuOverrides: stored.skuOverrides || {},
    captures: stored.captures || {},
    reportRows: Array.isArray(stored.reportRows) ? stored.reportRows : [],
    offlineRows: Array.isArray(stored.offlineRows) ? stored.offlineRows : [],
    offlineSkus: Array.isArray(stored.offlineSkus) ? stored.offlineSkus : [],
    baseOverride: stored.baseOverride || null,
    lastRun: stored.lastRun || null,
    lastAccount: stored.lastAccount || '',
    lastIdentity: stored.lastIdentity || 'util',
    lastSavedAt: stored.lastSavedAt || null,
    dismissedBanner: !!stored.dismissedBanner
  };
}

async function saveDb() {
  state.db.lastSavedAt = new Date().toISOString();
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: state.db });
  } catch (e) {
    setToast('保存失败：' + errText(e));
  }
}

// ---------------- 基表 ----------------
async function loadBase() {
  if (state.db.baseOverride && Array.isArray(state.db.baseOverride.sheets)) return state.db.baseOverride;
  const url = chrome.runtime.getURL('data/base-skus.json');
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error('读取内置基表失败：HTTP ' + res.status);
  return await res.json();
}

function flattenRows() {
  const rows = [];
  const sheets = (state.base && state.base.sheets) || [];
  for (const sheet of sheets) {
    for (const r of sheet.rows || []) {
      const override = String(state.db.skuOverrides[r.rowId] || '').trim();
      const sku = String(r.sku || override || '').trim();
      rows.push(Object.assign({}, r, { baseSku: r.sku, sku: sku }));
    }
  }
  state.rows = rows;
}

async function reloadBase() {
  state.base = await loadBase();
  flattenRows();
}

const capOf = (row) => (row.sku ? state.db.captures[row.sku] || null : null);
const isOffline = (row) => {
  if (!row) return false;
  if (row.rowId && (state.db.offlineRows || []).indexOf(row.rowId) >= 0) return true;
  if (row.sku && (state.db.offlineSkus || []).indexOf(row.sku) >= 0) return true;
  return false;
};

// 某个价格是否处于「已自动选值、但还没人工确认」状态
function hasUnconfirmedDeviation(cap) {
  if (!cap) return false;
  const check = (info) => !!(info && info.offThreshold && info.offThreshold.needsConfirm && !info.offThreshold.confirmed);
  return check(cap.util) || check(cap.plus);
}

// ---------------- 状态判断 ----------------
function statusOf(row) {
  if (isOffline(row)) return { key: 'offline', text: '已下架' };
  if (!row.sku) return { key: 'nosku', text: '待补 SKU' };
  const cap = capOf(row);
  // 人工确认过的行，无论价格高低都显示正常
  if (cap && cap.manualConfirmed) return { key: 'ok', text: '正常' };
  const util = cap && cap.util;
  const plus = cap && cap.plus;
  const utilBelow = !!(util && util.price != null && row.utilMin != null && util.price < row.utilMin - 0.001);
  const plusBelow = !!(plus && plus.price != null && row.plusMin != null && plus.price < row.plusMin - 0.001);
  if (utilBelow || plusBelow) return { key: 'alert', text: '低于阈值' };
  if (hasUnconfirmedDeviation(cap)) return { key: 'confirm', text: '需人工确认' };
  if (util && plus) return { key: 'ok', text: '正常' };
  if (util || plus) return { key: 'partial', text: '部分采集' };
  if (cap && cap.fail) return { key: 'fail', text: '采集失败' };
  return { key: 'none', text: '未采集' };
}

function computeStats(sheetFilter) {
  const sourceRows = sheetFilter && sheetFilter !== '全部'
    ? state.rows.filter((r) => r.sheet === sheetFilter)
    : state.rows;
  const withSku = sourceRows.filter((r) => r.sku);
  const uniq = Array.from(new Set(withSku.map((r) => r.sku)));
  let utilDone = 0;
  let plusDone = 0;
  for (const sku of uniq) {
    const cap = state.db.captures[sku];
    if (cap && cap.util && cap.util.price != null) utilDone++;
    if (cap && cap.plus && cap.plus.price != null) plusDone++;
  }
  const counts = { alert: 0, fail: 0, ok: 0, partial: 0, none: 0, nosku: 0, offline: 0 };
  const offlineCount = sourceRows.filter((r) => isOffline(r)).length;
  let belowUtil = 0;
  let belowPlus = 0;
  let offThreshold = 0;
  let needsConfirm = 0;
  for (const row of sourceRows) {
    const st = statusOf(row);
    counts[st.key] = (counts[st.key] || 0) + 1;
    if (row.sku) {
      const cap = state.db.captures[row.sku];
      if (cap && cap.util && cap.util.price != null && row.utilMin != null && cap.util.price < row.utilMin - 0.001) belowUtil++;
      if (cap && cap.plus && cap.plus.price != null && row.plusMin != null && cap.plus.price < row.plusMin - 0.001) belowPlus++;
      if (cap && ((cap.util && cap.util.offThreshold) || (cap.plus && cap.plus.offThreshold))) {
        offThreshold++;
        if (hasUnconfirmedDeviation(cap)) needsConfirm++;
      }
    }
  }
  return {
    total: sourceRows.length,
    withSku: withSku.length,
    uniqSku: uniq.length,
    missingSku: sourceRows.length - withSku.length,
    utilDone,
    plusDone,
    alert: counts.alert,
    fail: counts.fail,
    ok: counts.ok,
    partial: counts.partial,
    none: counts.none,
    belowUtil,
    belowPlus,
    offThreshold,
    needsConfirm,
    offline: offlineCount
  };
}

// ---------------- 渲染 ----------------
function renderStats() {
  const st = computeStats();
  const chips = [
    { k: '基表行数', v: st.total + ' 行', cls: '' },
    { k: '有 SKU', v: st.withSku + ' 行', cls: '' },
    { k: '去重 SKU', v: st.uniqSku + ' 个', cls: '' },
    { k: '普惠已采集', v: st.utilDone + ' / ' + st.uniqSku, cls: 'ok' },
    { k: '会员已采集', v: st.plusDone + ' / ' + st.uniqSku, cls: 'plusStat' },
    { k: '低于阈值', v: String(st.alert), cls: st.alert ? 'alert' : '' },
    { k: '采集失败', v: String(st.fail), cls: '' },
    { k: '待补 SKU', v: String(st.missingSku), cls: '' }
  ];
  els.statsBar.textContent = '';
  for (const chip of chips) {
    const div = document.createElement('div');
    div.className = 'statChip ' + chip.cls;
    const k = document.createElement('span');
    k.className = 'k';
    k.textContent = chip.k;
    const v = document.createElement('span');
    v.className = 'v';
    v.textContent = String(chip.v);
    div.appendChild(k);
    div.appendChild(v);
    els.statsBar.appendChild(div);
  }
}

function sheetNames() {
  const names = ['全部'];
  for (const sheet of (state.base && state.base.sheets) || []) names.push(sheet.name);
  return names;
}

function renderTabs() {
  els.sheetTabs.textContent = '';
  const counts = {};
  for (const row of state.rows) {
    if (!row.sku) continue;
    counts[row.sheet] = (counts[row.sheet] || 0) + 1;
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  for (const name of sheetNames()) {
    const btn = document.createElement('button');
    btn.className = 'tab' + (state.filter.sheet === name ? ' active' : '');
    btn.textContent = name;
    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = '· ' + (name === '全部' ? total : counts[name] || 0);
    btn.appendChild(count);
    btn.addEventListener('click', () => {
      state.filter.sheet = name;
      renderTabs();
      renderTable();
    });
    els.sheetTabs.appendChild(btn);
  }
}

function filteredRows() {
  return state.view === 'overview' ? overviewRows() : workbenchRows();
}

function workbenchRows() {
  const { sheet, search, status } = state.filter;
  const q = search.trim().toLowerCase();
  return state.rows.filter((row) => {
    if (sheet !== '全部' && row.sheet !== sheet) return false;
    if (status === 'offline') {
      if (!isOffline(row)) return false;
    } else if (isOffline(row)) {
      return false;
    }
    if (q) {
      const hay = [row.sku, row.model, row.package, row.note, row.baseSku].join(' ').toLowerCase();
      if (hay.indexOf(q) < 0) return false;
    }
    if (status !== 'all') {
      const st = statusOf(row);
      if (status === 'todo' && !(st.key === 'none' || st.key === 'partial' || st.key === 'fail')) return false;
      if (status === 'alert' && st.key !== 'alert') return false;
      if (status === 'confirm' && st.key !== 'confirm') return false;
      if (status === 'fail' && st.key !== 'fail') return false;
      if (status === 'nosku' && st.key !== 'nosku') return false;
    }
    return true;
  });
}

function overviewRows() {
  const f = state.ovFilter;
  return state.rows.filter((row) => {
    if (f.sheet !== '全部' && row.sheet !== f.sheet) return false;
    if (f.key === 'offline') return isOffline(row);
    if (isOffline(row)) return false;
    if (f.key === 'all') return true;
    if (f.key === 'nosku') return !row.sku;
    if (!row.sku) return false;
    const cap = state.db.captures[row.sku] || null;
    const st = statusOf(row);
    const below = (identity) => {
      const c = cap && cap[identity];
      const thr = identity === 'util' ? row.utilMin : row.plusMin;
      return !!(c && c.price != null && thr != null && c.price < thr - 0.001);
    };
    switch (f.key) {
      case 'utilDone':
        return !!(cap && cap.util && cap.util.price != null);
      case 'plusDone':
        return !!(cap && cap.plus && cap.plus.price != null);
      case 'alert':
        return st.key === 'alert';
      case 'normal':
        return st.key === 'ok';
      case 'off':
        return !!(
          cap &&
          ((cap.util && cap.util.offThreshold) || (cap.plus && cap.plus.offThreshold))
        );
      case 'confirm':
        return hasUnconfirmedDeviation(cap);
      case 'fail':
        return st.key === 'fail';
      case 'none':
        return st.key === 'none';
      case 'partial':
        return st.key === 'partial';
      case 'belowUtil':
        return below('util');
      case 'belowPlus':
        return below('plus');
      default:
        return true;
    }
  });
}

const OV_FILTER_LABELS = {
  all: '全部 SKU',
  utilDone: '普惠已采集',
  plusDone: '会员已采集',
  alert: '低于阈值',
  normal: '高于/等于阈值',
  off: '偏离阈值',
  confirm: '需人工确认',
  fail: '采集失败',
  none: '未采集',
  partial: '部分采集',
  belowUtil: '普惠破价',
  belowPlus: '会员破价',
  nosku: '待补 SKU',
  offline: '已下架'
};

function ovFilterLabel() {
  const labels = [OV_FILTER_LABELS[state.ovFilter.key] || '全部 SKU'];
  if (state.ovFilter.sheet !== '全部') labels.push(state.ovFilter.sheet);
  return labels.join(' · ');
}

function startPriceEdit(td, row, identity) {
  const cap = capOf(row) || {};
  const info = cap[identity];
  const current = info && info.price != null ? String(info.price) : '';
  let done = false;
  td.textContent = '';
  const wrap = document.createElement('div');
  wrap.className = 'priceEditRow';
  const input = document.createElement('input');
  input.type = 'number';
  input.step = '0.01';
  input.min = '0';
  input.className = 'priceEditInput';
  input.value = current;
  input.placeholder = '留空=清除';
  input.title = '输入数值后回车保存；留空回车则清除该账号价格';
  wrap.appendChild(input);
  td.appendChild(wrap);
  input.focus();
  input.select();

  const save = async () => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (!v) {
      const c = capOf(row);
      if (c) {
        delete c[identity];
        c.updatedAt = new Date().toISOString();
        await saveDb();
      }
      renderAll();
      setToast('已清除该账号的价格');
      return;
    }
    const n = parseFloat(v);
    if (!isFinite(n) || n <= 0) {
      done = false;
      setToast('请输入有效价格');
      input.focus();
      return;
    }
    const c = state.db.captures[row.sku] || {};
    c[identity] = {
      price: n,
      kind: 'manual',
      at: new Date().toISOString(),
      account: '手动修改',
      title: row.model || '',
      url: ITEM_URL(row.sku)
    };
    // 手动改价视为已人工确认，清除「偏离阈值」标记
    delete c[identity].offThreshold;
    c.updatedAt = new Date().toISOString();
    c.fail = null;
    state.db.captures[row.sku] = c;
    await saveDb();
    renderAll();
    setToast('已手动保存 ' + fmtMoney(n));
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      save();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      done = true;
      renderAll();
    }
  });
  input.addEventListener('blur', () => {
    save();
  });
}

function buildPriceEditBtn(row, identity, td) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'priceEditBtn';
  btn.textContent = '改';
  btn.title = '手动修改该账号当前价格（保存为「手动」，不再算自动采集）';
  btn.addEventListener('click', () => startPriceEdit(td, row, identity));
  return btn;
}

function buildPriceCell(row, identity) {
  const td = document.createElement('td');
  td.className = 'col-price';
  if (!row.sku) {
    const span = document.createElement('span');
    span.className = 'muted';
    span.textContent = '—';
    td.appendChild(span);
    return td;
  }
  const cap = capOf(row);
  const info = cap && cap[identity];
  const threshold = identity === 'util' ? row.utilMin : row.plusMin;
  if (!info || info.price == null) {
    const span = document.createElement('span');
    span.className = 'muted';
    span.textContent = '—';
    td.appendChild(span);
    td.appendChild(buildPriceEditBtn(row, identity, td));
    if (cap && cap.fail) {
      const f = document.createElement('div');
      f.className = 'failNote';
      f.textContent = '失败';
      f.title = (cap.fail.reason || '') + '（' + fmtTime(cap.fail.at) + '）';
      td.appendChild(f);
    }
    return td;
  }
  const val = document.createElement('div');
  val.className = 'priceVal';
  val.textContent = fmtMoney(info.price);
  td.appendChild(val);
  td.appendChild(buildPriceEditBtn(row, identity, td));

  const meta = document.createElement('div');
  meta.className = 'priceMeta';
  meta.textContent = kindLabel(info.kind) + ' · ' + fmtTime(info.at);
  if (info.account) meta.title = '采集账号：' + info.account;
  td.appendChild(meta);

  if (threshold != null && info.price != null) {
    const diff = info.price - threshold;
    const d = document.createElement('div');
    if (diff < -0.001) {
      d.className = 'priceDiff bad';
      d.textContent = '低 ¥' + fmtNum(Math.abs(diff));
      d.title = '低于阈值 ' + fmtMoney(threshold) + '，注意破价';
    } else if (diff <= 0.001) {
      d.className = 'priceDiff';
      d.textContent = '等于阈值';
      d.title = '正好等于阈值 ' + fmtMoney(threshold);
    } else {
      d.className = 'priceDiff good';
      d.textContent = '高 ¥' + fmtNum(diff);
      d.title = '高于阈值 ' + fmtMoney(threshold);
    }
    td.appendChild(d);
  }

  if (info.offThreshold) {
    const attempts = (info.offThreshold.attempts || []).filter((x) => x != null);
    const tip =
      '阈值 ' + fmtMoney(info.offThreshold.threshold) +
      '；采集价依次为 ' + attempts.map((x) => fmtNum(x)).join(' / ') +
      '；相差超过 ¥' + fmtNum(info.offThreshold.limit || deviationLimitValue()) + ' 时自动多采 ' +
      Math.max(1, attempts.length) + ' 次，取最接近阈值的值';
    if (info.offThreshold.needsConfirm && !info.offThreshold.confirmed) {
      const warn = document.createElement('div');
      warn.className = 'priceWarn urgent';
      warn.textContent = '⚠ 已自动选值·待确认';
      warn.title = tip + '；最接近的值仍与阈值相差超过 ¥' + fmtNum(info.offThreshold.confirmLimit || deviationConfirmLimitValue()) + '，确认无误请点下方「确认」';
      td.appendChild(warn);
      const confirmBtn = document.createElement('button');
      confirmBtn.type = 'button';
      confirmBtn.className = 'priceConfirmBtn';
      confirmBtn.textContent = '确认';
      confirmBtn.title = '确认这个价格无误（确认后状态显示「正常」，不再提示）';
      confirmBtn.addEventListener('click', () => confirmDeviation(row, identity));
      td.appendChild(confirmBtn);
    } else if (info.offThreshold.confirmed) {
      const okTag = document.createElement('div');
      okTag.className = 'priceWarn confirmed';
      okTag.textContent = '✓ 已人工确认';
      okTag.title = '已于 ' + fmtTime(info.offThreshold.confirmedAt || '') + ' 人工确认此价格';
      td.appendChild(okTag);
    } else {
      const warn = document.createElement('div');
      warn.className = 'priceWarn';
      warn.textContent = '⚠ 已多采·取最接近阈值';
      warn.title = tip;
      td.appendChild(warn);
    }
  }
  return td;
}

function unconfirmedIdentities(row) {
  const cap = capOf(row);
  const list = [];
  if (!cap) return list;
  for (const identity of ['util', 'plus']) {
    const info = cap[identity];
    if (info && info.offThreshold && info.offThreshold.needsConfirm && !info.offThreshold.confirmed) list.push(identity);
  }
  return list;
}

function countSelectedUnconfirmed() {
  let n = 0;
  for (const row of state.rows) {
    if (row.sku && state.selected.has(row.sku)) n += unconfirmedIdentities(row).length;
  }
  return n;
}

async function confirmDeviation(row, identity) {
  const cap = capOf(row);
  const info = cap && cap[identity];
  if (!info || !info.offThreshold || !info.offThreshold.needsConfirm || info.offThreshold.confirmed) {
    setToast('这条没有待确认的价格');
    return;
  }
  info.offThreshold.confirmed = true;
  info.offThreshold.confirmedAt = new Date().toISOString();
  cap.manualConfirmed = true;
  cap.confirmedAt = new Date().toISOString();
  cap.updatedAt = new Date().toISOString();
  await saveDb();
  renderAll();
  setToast('已确认 ' + fmtMoney(info.price) + '，状态已更新为正常');
}

function pendingRowsInView() {
  return filteredRows().filter((row) => row.sku && hasUnconfirmedDeviation(capOf(row)));
}

async function confirmSelectedDeviation() {
  let rowsToConfirm;
  if (state.selected.size) {
    const skus = new Set(state.selected);
    rowsToConfirm = state.rows.filter((row) => row.sku && skus.has(row.sku) && hasUnconfirmedDeviation(capOf(row)));
  } else {
    const pending = pendingRowsInView();
    if (!pending.length) {
      setToast('当前筛选里没有可确认的价格');
      return;
    }
    if (!window.confirm('没有勾选行，确认当前筛选里的 ' + pending.length + ' 行（待确认价格）？')) return;
    rowsToConfirm = pending;
  }
  let count = 0;
  for (const row of rowsToConfirm) {
    const cap = capOf(row);
    if (!cap) continue;
    let rowConfirmed = false;
    for (const identity of ['util', 'plus']) {
      const info = cap[identity];
      if (info && info.offThreshold && info.offThreshold.needsConfirm && !info.offThreshold.confirmed) {
        info.offThreshold.confirmed = true;
        info.offThreshold.confirmedAt = new Date().toISOString();
        count++;
        rowConfirmed = true;
      }
    }
    if (rowConfirmed) {
      cap.manualConfirmed = true;
      cap.confirmedAt = new Date().toISOString();
    }
    cap.updatedAt = new Date().toISOString();
  }
  if (!count) {
    setToast('没有待确认的价格');
    return;
  }
  await saveDb();
  renderAll();
  setToast('已确认 ' + count + ' 个价格，状态已更新');
}

// ---------------- 商品页预览（小眼睛） ----------------
const previewState = { winId: null, pinned: false, rowId: null, openTimer: null, closeTimer: null };

function previewDelayValue() {
  const n = Number(state.db.settings.previewDelayMs);
  if (!isFinite(n) || n < 0) return 1000;
  return Math.max(300, Math.min(5000, Math.round(n)));
}

function clearPreviewTimers() {
  if (previewState.openTimer) {
    clearTimeout(previewState.openTimer);
    previewState.openTimer = null;
  }
  if (previewState.closeTimer) {
    clearTimeout(previewState.closeTimer);
    previewState.closeTimer = null;
  }
}

async function closePreviewWindow() {
  const id = previewState.winId;
  previewState.winId = null;
  previewState.pinned = false;
  previewState.rowId = null;
  clearPreviewTimers();
  if (id != null) {
    try {
      await chrome.windows.remove(id);
    } catch (e) {
      // 窗口可能已经手动关掉
    }
  }
}

async function openPreviewWindow(row, pinned) {
  if (!row || !row.sku) return;
  if (previewState.winId != null && previewState.rowId === row.rowId) {
    previewState.pinned = previewState.pinned || !!pinned;
    try {
      await chrome.windows.update(previewState.winId, { focused: !!pinned });
    } catch (e) {
      // 忽略
    }
    return;
  }
  if (previewState.winId != null) await closePreviewWindow();
  const screenW = (window.screen && window.screen.availWidth) || 0;
  const screenH = (window.screen && window.screen.availHeight) || 0;
  const width = screenW > 0 ? Math.min(1100, Math.max(640, screenW - 60)) : 1100;
  const height = screenH > 0 ? Math.min(820, Math.max(480, screenH - 80)) : 820;
  let left = Math.round((window.screenX || 0) + Math.max(40, ((window.outerWidth || 1400) - width) / 2));
  let top = Math.round((window.screenY || 0) + 70);
  if (screenW > 0) left = Math.max(0, Math.min(left, screenW - width));
  if (screenH > 0) top = Math.max(0, Math.min(top, screenH - height));
  const options = { url: ITEM_URL(row.sku), type: 'popup', width: width, height: height, focused: !!pinned };
  try {
    let win = null;
    try {
      win = await chrome.windows.create(Object.assign({}, options, { left: left, top: top }));
    } catch (e) {
      // 多屏/无头/缩放导致边界不合法时，退化为不指定位置
      win = await chrome.windows.create(options);
    }
    previewState.winId = win.id;
    previewState.rowId = row.rowId;
    previewState.pinned = !!pinned;
  } catch (e) {
    setToast('预览窗口打开失败：' + errText(e) + '（可直接点「打开」查看商品页）');
  }
}

function bindPreviewEvents(btn, row) {
  btn.addEventListener('mouseenter', () => {
    clearPreviewTimers();
    previewState.openTimer = setTimeout(() => {
      previewState.openTimer = null;
      openPreviewWindow(row, false);
    }, previewDelayValue());
  });
  btn.addEventListener('mouseleave', () => {
    if (previewState.openTimer) {
      clearTimeout(previewState.openTimer);
      previewState.openTimer = null;
    }
    if (previewState.pinned) return;
    if (previewState.closeTimer) clearTimeout(previewState.closeTimer);
    previewState.closeTimer = setTimeout(() => {
      previewState.closeTimer = null;
      closePreviewWindow();
    }, 700);
  });
  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (previewState.winId != null && previewState.rowId === row.rowId) {
      if (previewState.pinned) {
        await closePreviewWindow();
      } else {
        previewState.pinned = true;
        try {
          await chrome.windows.update(previewState.winId, { focused: true });
        } catch (err) {
          // 忽略
        }
        setToast('已固定预览窗口，再点眼睛或关闭窗口即可');
      }
      return;
    }
    await openPreviewWindow(row, true);
  });
}

// ---------------- 下架库 ----------------
async function offlineSelected() {
  if (!state.selected.size) {
    setToast('先勾选要下架的行');
    return;
  }
  const targets = state.rows.filter((r) => r.sku && state.selected.has(r.sku) && !isOffline(r));
  if (!targets.length) {
    setToast('选中的行已经在/不在下架范围');
    return;
  }
  if (!window.confirm('把选中的 ' + targets.length + ' 行移入下架库？\n移入后默认隐藏、下次巡检不再采集，可在「已下架」里恢复。')) return;
  const rows = (state.db.offlineRows || []).slice();
  const skus = (state.db.offlineSkus || []).slice();
  for (const row of targets) {
    if (row.rowId && rows.indexOf(row.rowId) < 0) rows.push(row.rowId);
    if (row.sku && skus.indexOf(row.sku) < 0) skus.push(row.sku);
  }
  state.db.offlineRows = rows;
  state.db.offlineSkus = skus;
  await saveDb();
  renderAll();
  setToast('已下架 ' + targets.length + ' 行');
}

async function toggleOffline(row) {
  if (!row || !row.rowId) return;
  const rows = (state.db.offlineRows || []).slice();
  const skus = (state.db.offlineSkus || []).slice();
  const isDown = rows.indexOf(row.rowId) >= 0 || (row.sku && skus.indexOf(row.sku) >= 0);
  let message;
  if (isDown) {
    state.db.offlineRows = rows.filter((id) => id !== row.rowId);
    state.db.offlineSkus = row.sku ? skus.filter((sku) => sku !== row.sku) : skus;
    message = '已恢复：' + (row.sku || row.rowId);
  } else {
    rows.push(row.rowId);
    if (row.sku && skus.indexOf(row.sku) < 0) skus.push(row.sku);
    state.db.offlineRows = rows;
    state.db.offlineSkus = skus;
    message = '已移入下架库：' + (row.sku || row.rowId) + '（下次巡检不会出现，可在「已下架」里恢复）';
  }
  await saveDb();
  renderAll();
  setToast(message);
}

function buildRow(row) {
  const st = statusOf(row);
  const tr = document.createElement('tr');
  const isSelected = row.sku && state.selected.has(row.sku);
  const classes = [];
  if (st.key === 'alert') classes.push('rowAlert');
  if (isSelected) classes.push('rowSelected');
  if ((state.db.reportRows || []).indexOf(row.rowId) >= 0) classes.push('rowReport');
  if (isOffline(row)) classes.push('rowOffline');
  if (classes.length) tr.className = classes.join(' ');

  // 勾选
  const tdCheck = document.createElement('td');
  tdCheck.className = 'col-check';
  if (row.sku) {
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.checked = !!isSelected;
    chk.title = '勾选后可批量重采（重采选中）';
    chk.addEventListener('change', () => {
      if (chk.checked) state.selected.add(row.sku);
      else state.selected.delete(row.sku);
      tr.classList.toggle('rowSelected', chk.checked);
      updateSelectAllState(filteredRows());
    });
    tdCheck.appendChild(chk);
  }
  tr.appendChild(tdCheck);

  // 类目
  const tdSheet = document.createElement('td');
  const badge = document.createElement('span');
  badge.className = 'sheetBadge';
  badge.textContent = row.sheet;
  tdSheet.appendChild(badge);
  tr.appendChild(tdSheet);

  // Excel 行
  const tdRow = document.createElement('td');
  tdRow.className = 'num';
  tdRow.textContent = String(row.excelRow);
  tr.appendChild(tdRow);

  // SKU
  const tdSku = document.createElement('td');
  if (row.sku) {
    const a = document.createElement('a');
    a.className = 'skuLink';
    a.href = ITEM_URL(row.sku);
    a.target = '_blank';
    a.rel = 'noreferrer';
    a.textContent = row.sku;
    a.title = '打开商品页';
    tdSku.appendChild(a);
  } else {
    const input = document.createElement('input');
    input.className = 'skuInput';
    input.placeholder = '补 SKU';
    input.value = state.db.skuOverrides[row.rowId] || '';
    input.title = '该行在基表里没有 SKU，可在这里补（纯数字，自动保存）' + (row.note ? '；备注：' + row.note : '');
    input.addEventListener('change', async () => {
      const v = input.value.trim();
      if (v && !/^\d{6,}$/.test(v)) {
        setToast('SKU 应该是 6 位以上纯数字');
        input.value = state.db.skuOverrides[row.rowId] || '';
        return;
      }
      if (v) state.db.skuOverrides[row.rowId] = v;
      else delete state.db.skuOverrides[row.rowId];
      await saveDb();
      flattenRows();
      renderAll();
      setToast(v ? '已保存 SKU：' + v : '已清除补录');
    });
    tdSku.appendChild(input);
  }
  tr.appendChild(tdSku);

  // 套餐型号
  const tdModel = document.createElement('td');
  const model = document.createElement('div');
  model.className = 'modelText';
  model.textContent = row.model || '—';
  tdModel.appendChild(model);
  tr.appendChild(tdModel);

  // 套餐
  const tdPkg = document.createElement('td');
  const pkg = document.createElement('div');
  pkg.className = 'packageText';
  pkg.textContent = row.package || row.note || '—';
  tdPkg.appendChild(pkg);
  tr.appendChild(tdPkg);

  // 前台价
  const tdFront = document.createElement('td');
  tdFront.className = 'money';
  tdFront.textContent = row.frontPrice != null ? fmtMoney(row.frontPrice) : '—';
  tr.appendChild(tdFront);

  // 普惠阈值
  const tdUtilMin = document.createElement('td');
  tdUtilMin.className = 'money';
  tdUtilMin.textContent = row.utilMin != null ? fmtMoney(row.utilMin) : '—';
  tr.appendChild(tdUtilMin);

  // 普惠当前价
  tr.appendChild(buildPriceCell(row, 'util'));

  // 会员阈值
  const tdPlusMin = document.createElement('td');
  tdPlusMin.className = 'money';
  tdPlusMin.textContent = row.plusMin != null ? fmtMoney(row.plusMin) : '—';
  tr.appendChild(tdPlusMin);

  // 会员当前价
  tr.appendChild(buildPriceCell(row, 'plus'));

  // 状态
  const tdStatus = document.createElement('td');
  const stBadge = document.createElement('span');
  stBadge.className = 'badge ' + st.key;
  stBadge.textContent = st.text;
  const cap = capOf(row);
  if (cap && cap.fail) stBadge.title = '最近失败：' + (cap.fail.reason || '') + '（' + fmtTime(cap.fail.at) + '）';
  tdStatus.appendChild(stBadge);
  tr.appendChild(tdStatus);

  // 预览（小眼睛：悬停/点击弹出商品页小窗）
  const tdEye = document.createElement('td');
  tdEye.className = 'col-eye';
  if (row.sku) {
    const eye = document.createElement('button');
    eye.type = 'button';
    eye.className = 'eyeBtn';
    eye.textContent = '👁';
    eye.title = '悬停预览商品页；点击可固定预览窗口';
    bindPreviewEvents(eye, row);
    tdEye.appendChild(eye);
  }
  tr.appendChild(tdEye);

  // 操作
  const tdOp = document.createElement('td');
  const op = document.createElement('div');
  op.className = 'opCell';
  const openBtn = document.createElement('a');
  openBtn.className = 'opBtn' + (row.sku ? '' : ' disabled');
  openBtn.textContent = '打开';
  openBtn.target = '_blank';
  openBtn.rel = 'noreferrer';
  openBtn.href = row.sku ? ITEM_URL(row.sku) : '#';
  op.appendChild(openBtn);
  if (row.sku) {
    const again = document.createElement('button');
    again.className = 'opBtn';
    again.type = 'button';
    again.textContent = '重采';
    again.title = '按上次巡检的身份重新采集这一条';
    again.addEventListener('click', () => {
      if (state.running) {
        setToast('已有巡检在进行中');
        return;
      }
      const identity = (state.db.lastRun && state.db.lastRun.identity) || 'util';
      startRun(identity, { singleSku: row.sku, noConfirm: true }).catch(() => {});
    });
    op.appendChild(again);
  }
  const offBtn = document.createElement('button');
  offBtn.type = 'button';
  offBtn.className = 'opBtn';
  offBtn.textContent = isOffline(row) ? '恢复' : '下架';
  offBtn.title = isOffline(row) ? '从下架库恢复这一行' : '标记为已下架（移入下架库，默认隐藏，可随时恢复）';
  offBtn.addEventListener('click', () => toggleOffline(row));
  op.appendChild(offBtn);
  tdOp.appendChild(op);
  tr.appendChild(tdOp);

  // 占位列：吸收表格多余宽度，保证各列（尤其是勾选列）宽度固定
  const tdFiller = document.createElement('td');
  tdFiller.className = 'col-filler';
  tr.appendChild(tdFiller);

  return tr;
}

function renderTable() {
  const rows = filteredRows();
  els.tblBody.textContent = '';
  updateSelectAllState(rows);
  const isOv = state.view === 'overview';
  els.tableCaption.classList.toggle('show', isOv);
  els.tableCaption.textContent = '';
  if (isOv) {
    const b = document.createElement('b');
    b.textContent = String(rows.length);
    els.tableCaption.appendChild(document.createTextNode('总览 · ' + ovFilterLabel() + ' · 共 '));
    els.tableCaption.appendChild(b);
    els.tableCaption.appendChild(document.createTextNode(' 行'));
  }
  if (!rows.length) {
    els.empty.classList.remove('hidden');
    els.empty.textContent = isOv
      ? '当前筛选没有符合条件的行，点上方数字切换查看其它状态。'
      : '没有符合条件的行。试试切换类目 / 清空搜索 / 切换状态筛选。';
    return;
  }
  els.empty.classList.add('hidden');
  const frag = document.createDocumentFragment();
  for (const row of rows) frag.appendChild(buildRow(row));
  els.tblBody.appendChild(frag);
}

function updateSelectAllState(rows) {
  const eligible = rows.filter((r) => r.sku);
  const selectedCount = eligible.filter((r) => state.selected.has(r.sku)).length;
  if (els.selectAllChk) {
    els.selectAllChk.checked = eligible.length > 0 && selectedCount === eligible.length;
    els.selectAllChk.indeterminate = selectedCount > 0 && selectedCount < eligible.length;
    els.selectAllChk.disabled = eligible.length === 0;
  }
  updateSelectionUI();
}

function updateSelectionUI() {
  const n = state.selected.size;
  if (els.multiRerunBtn) {
    els.multiRerunBtn.textContent = n > 0 ? '重采选中 (' + n + ')' : '重采选中';
    els.multiRerunBtn.disabled = state.running || n === 0;
  }
  if (els.ovSummaryBtn) {
    els.ovSummaryBtn.textContent = n > 0 ? '汇总选中 (' + n + ')' : '汇总选中';
    els.ovSummaryBtn.disabled = n === 0;
  }
  if (els.ovOfflineBtn) {
    els.ovOfflineBtn.textContent = n > 0 ? '下架选中 (' + n + ')' : '下架选中';
    els.ovOfflineBtn.disabled = n === 0;
  }
  if (els.ovConfirmBtn) {
    const selectedCount = countSelectedUnconfirmed();
    const viewCount = pendingRowsInView().length;
    const count = selectedCount > 0 ? selectedCount : viewCount;
    els.ovConfirmBtn.textContent = count > 0 ? '确认' + (selectedCount > 0 ? '选中' : '当前') + ' (' + count + ')' : '确认选中';
    els.ovConfirmBtn.disabled = count === 0;
  }
}

// ---------------- 总览页 ----------------
const OV_CARDS = [
  { key: 'all', label: '全部行', sub: '基表行数', cls: '', value: (st) => st.total + ' 行' },
  { key: 'utilDone', label: '普惠已采集', sub: '普惠当前价格有值', cls: 'good', value: (st) => st.utilDone + ' / ' + st.uniqSku },
  { key: 'plusDone', label: '会员已采集', sub: '会员当前价格有值', cls: 'plusStat', value: (st) => st.plusDone + ' / ' + st.uniqSku },
  { key: 'alert', label: '低于阈值', sub: '需要重点看', cls: 'warn', value: (st) => String(st.alert) },
  { key: 'normal', label: '高于/等于阈值', sub: '两价已采且不破价', cls: 'good', value: (st) => String(st.ok) },
  { key: 'off', label: '偏离阈值', sub: '差价>500，已自动多采', cls: 'warn', value: (st) => String(st.offThreshold) },
  { key: 'confirm', label: '需人工确认', sub: '已选值，点确认转正常', cls: 'warn', value: (st) => String(st.needsConfirm) },
  { key: 'fail', label: '采集失败', sub: '可重采或手动改', cls: 'warn', value: (st) => String(st.fail) },
  { key: 'none', label: '未采集', sub: '还没跑过', cls: '', value: (st) => String(st.none) },
  { key: 'nosku', label: '待补 SKU', sub: '表格里可直接补', cls: '', value: (st) => String(st.missingSku) },
  { key: 'offline', label: '已下架', sub: '已移入下架库，可恢复', cls: '', value: (st) => String(st.offline) }
];

function renderOverview() {
  const st = computeStats(state.ovFilter.sheet);
  renderOvCards(st);
  renderOvProgress(st);
  renderOvTabs();
  els.ovFilterHint.textContent = ovFilterLabel();
  els.ovClearFilterBtn.classList.toggle('hidden', state.ovFilter.key === 'all' && state.ovFilter.sheet === '全部');
}

function renderOvCards(st) {
  els.ovCards.textContent = '';
  for (const card of OV_CARDS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ovCard ' + (card.cls || '') + (state.ovFilter.key === card.key ? ' active' : '');
    const k = document.createElement('div');
    k.className = 'ovK';
    k.textContent = card.label;
    const v = document.createElement('div');
    v.className = 'ovV';
    v.textContent = card.value(st);
    const s = document.createElement('div');
    s.className = 'ovSub';
    s.textContent = card.sub;
    btn.appendChild(k);
    btn.appendChild(v);
    btn.appendChild(s);
    btn.addEventListener('click', () => {
      state.ovFilter.key = state.ovFilter.key === card.key ? 'all' : card.key;
      renderAll();
    });
    els.ovCards.appendChild(btn);
  }
}

function renderOvProgress(st) {
  const pct = (n, d) => (d > 0 ? Math.round((n / d) * 100) : 0);
  els.ovUtilFill.style.width = pct(st.utilDone, st.uniqSku) + '%';
  els.ovUtilText.textContent = st.utilDone + ' / ' + st.uniqSku + '（' + pct(st.utilDone, st.uniqSku) + '%）';
  els.ovPlusFill.style.width = pct(st.plusDone, st.uniqSku) + '%';
  els.ovPlusText.textContent = st.plusDone + ' / ' + st.uniqSku + '（' + pct(st.plusDone, st.uniqSku) + '%）';
}

function renderOvTabs() {
  els.ovSheetTabs.textContent = '';
  const counts = {};
  for (const row of state.rows) counts[row.sheet] = (counts[row.sheet] || 0) + 1;
  for (const name of sheetNames()) {
    const btn = document.createElement('button');
    btn.className = 'tab' + (state.ovFilter.sheet === name ? ' active' : '');
    btn.textContent = name;
    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = '· ' + (name === '全部' ? state.rows.length : counts[name] || 0);
    btn.appendChild(count);
    btn.addEventListener('click', () => {
      state.ovFilter.sheet = name;
      renderAll();
    });
    els.ovSheetTabs.appendChild(btn);
  }
}

// ---------------- 待上报区 ----------------
function reportRowList() {
  const ids = new Set(state.db.reportRows || []);
  if (!ids.size) return [];
  return state.rows.filter((row) => ids.has(row.rowId));
}

function renderReportArea() {
  const rows = reportRowList();
  const count = rows.length;
  els.reportCount.textContent = count + ' 条';
  if (els.reportBadge) {
    els.reportBadge.textContent = String(count);
    els.reportBadge.classList.toggle('hidden', count === 0);
  }
  els.ovExportReportBtn.disabled = count === 0;
  els.ovClearReportBtn.disabled = count === 0;
  const show = state.view === 'overview' && count > 0;
  els.reportArea.classList.toggle('hidden', !show);
  if (!show) return;
  els.reportList.textContent = '';
  for (const row of rows) {
    const st = statusOf(row);
    const cap = capOf(row) || {};
    const util = cap.util || null;
    const plus = cap.plus || null;
    const item = document.createElement('div');
    item.className = 'reportItem';
    const sheet = document.createElement('span');
    sheet.className = 'ri-sheet';
    sheet.textContent = row.sheet + ' · 行' + row.excelRow;
    const sku = document.createElement('span');
    sku.className = 'ri-sku';
    sku.textContent = row.sku || '待补';
    const model = document.createElement('span');
    model.className = 'ri-model';
    model.textContent = (row.model || '') + (row.package ? ' / ' + row.package : '');
    model.title = model.textContent;
    const price = document.createElement('span');
    price.className = 'ri-price';
    price.textContent =
      '普惠 ' + (util && util.price != null ? fmtMoney(util.price) : '—') +
      ' · 会员 ' + (plus && plus.price != null ? fmtMoney(plus.price) : '—') +
      ' · ' + st.text;
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'ri-del';
    del.textContent = '移除';
    del.title = '从待上报区移除';
    del.addEventListener('click', async () => {
      state.db.reportRows = (state.db.reportRows || []).filter((id) => id !== row.rowId);
      await saveDb();
      renderAll();
    });
    item.appendChild(sheet);
    item.appendChild(sku);
    item.appendChild(model);
    item.appendChild(price);
    item.appendChild(del);
    els.reportList.appendChild(item);
  }
}

function renderAccountInfo() {
  const run = state.run;
  if (run && run.accountLabel) {
    els.accountInfo.textContent = '本次账号：' + run.accountLabel + ' · ' + (run.identity === 'util' ? '普惠巡检' : '会员巡检');
    return;
  }
  if (state.db.lastRun) {
    const lr = state.db.lastRun;
    els.accountInfo.textContent =
      '上次：' + (lr.identity === 'util' ? '普惠' : '会员') + (lr.account ? ' · ' + lr.account : '') + ' · ' + fmtTime(lr.at);
    return;
  }
  els.accountInfo.textContent = '尚未巡检';
}

function renderBaseInfo() {
  const base = state.base || {};
  const sheets = (base.sheets || []).length;
  const total = base.totalRows != null ? base.totalRows : state.rows.length;
  const withSku = base.totalWithSku != null ? base.totalWithSku : state.rows.filter((r) => r.sku).length;
  let text = '基表：' + sheets + ' 个类目 · ' + total + ' 行 · ' + withSku + ' 行有 SKU · 生成于 ' + (base.generatedAt ? fmtTime(base.generatedAt) : '未知');
  if (state.db.baseOverride) text += '（当前使用导入的基表）';
  els.baseInfo.textContent = text;
}

function renderRunUI() {
  const running = state.running;
  els.runUtilBtn.disabled = running;
  els.runPlusBtn.disabled = running;
  els.pauseBtn.disabled = !running;
  els.stopBtn.disabled = !running;
  els.pauseBtn.textContent = state.paused ? '继续' : '暂停';
  if (running) {
    els.runHint.textContent = '巡检进行中：后台标签页会逐个打开商品页，请保持本页面打开（可暂停/停止）';
  } else {
    const s = state.db.settings;
    els.runHint.textContent = '每批 ' + (Number(s.batchSize) > 0 ? Number(s.batchSize) + ' 个' : '全部') +
      ' · 间隔 ' + s.delayMin + '–' + s.delayMax + ' 秒 · 开始前请先登录对应账号';
  }
  const hasLog = els.logPanel.textContent.trim().length > 0;
  els.progressWrap.classList.toggle('hidden', !running && !state.run && !hasLog);
  updateSelectionUI();
}

function renderAll() {
  renderStats();
  renderAccountInfo();
  renderBaseInfo();
  renderRunUI();
  renderReportArea();
  if (state.view === 'overview') {
    renderOverview();
  } else {
    renderTabs();
  }
  renderTable();
}

function switchView(view) {
  const next = view === 'overview' ? 'overview' : 'workbench';
  if (state.view === next) return;
  state.view = next;
  els.tabWorkbench.classList.toggle('active', next === 'workbench');
  els.tabOverview.classList.toggle('active', next === 'overview');
  els.viewWorkbench.classList.toggle('hidden', next !== 'workbench');
  els.viewOverview.classList.toggle('hidden', next !== 'overview');
  els.viewHint.textContent =
    next === 'overview'
      ? '点数字可筛选查看；勾选行后点「汇总选中」加入待上报区'
      : '巡检时后台标签页逐个取价，页面保持打开即可';
  renderAll();
}

// ---------------- 巡检流程 ----------------
function collectTasks(identity) {
  const settings = state.db.settings;
  const scopeSheet = settings.scope === 'current' ? state.filter.sheet : '全部';
  const seen = new Set();
  const tasks = [];
  for (const row of state.rows) {
    if (!row.sku) continue;
    if (isOffline(row)) continue;
    if (seen.has(row.sku)) continue;
    seen.add(row.sku);
    const cap = state.db.captures[row.sku];
    if (settings.skipCapturedToday && cap && cap[identity] && isToday(cap[identity].at)) continue;
    tasks.push({
      sku: row.sku,
      url: ITEM_URL(row.sku),
      model: row.model,
      sheet: row.sheet,
      excelRow: row.excelRow,
      frontPrice: row.frontPrice,
      utilMin: row.utilMin,
      plusMin: row.plusMin
    });
  }
  const limit = Number(settings.batchSize) || 0;
  return limit > 0 ? tasks.slice(0, limit) : tasks;
}

// 合理性校验：明显过小的数字（例如只读到 5 这种数字片段）不当作价格
function plausiblePrice(price, frontPrice) {
  if (price == null || !isFinite(price) || price <= 0) return false;
  const front = Number(frontPrice) || 0;
  const min = Math.max(30, front > 0 ? front * 0.25 : 0);
  const max = front > 0 ? front * 2.5 : 2000000;
  return price >= min && price <= max;
}

function thresholdFor(task, identity) {
  const value = identity === 'util' ? task && task.utilMin : task && task.plusMin;
  return value == null ? null : Number(value);
}

function deviationLimitValue() {
  const n = Number(state.db.settings.deviationLimit);
  return isFinite(n) && n > 0 ? n : 500;
}

function deviationConfirmLimitValue() {
  const n = Number(state.db.settings.deviationConfirmLimit);
  return isFinite(n) && n > 0 ? n : 1500;
}

function isOffThreshold(price, threshold) {
  if (price == null || threshold == null || !isFinite(threshold)) return false;
  return Math.abs(Number(price) - Number(threshold)) > deviationLimitValue();
}

function pickPrice(identity, result, frontPrice) {
  if (!result) return null;
  const order = identity === 'plus' ? ['hand', 'plus', 'main'] : ['hand', 'main', 'plus'];
  for (const key of order) {
    const c = result[key];
    if (c && plausiblePrice(c.price, frontPrice)) {
      return { price: c.price, kind: c.kind || key };
    }
  }
  // 结构化字段都不合理时，从原始候选里再找一个合理的
  const cands = (result.candidates || []).filter((c) => c && !c.suspect && plausiblePrice(c.price, frontPrice));
  if (cands.length) {
    const best = cands[0];
    return { price: best.price, kind: best.kind || 'unknown' };
  }
  return null;
}

function recordResult(task, identity, result, extra) {
  const at = new Date().toISOString();
  const cap = state.db.captures[task.sku] || {};
  delete cap.manualConfirmed;
  delete cap.confirmedAt;
  let success = false;
  if (result && result.ok) {
    const picked = extra && extra.pick ? extra.pick : pickPrice(identity, result, task.frontPrice);
    if (picked && picked.price != null) {
      cap[identity] = {
        price: picked.price,
        kind: picked.kind,
        at: at,
        account: (result.account && result.account.nickname) || '',
        title: result.title || '',
        url: result.url || ''
      };
      if (extra && extra.offThreshold) cap[identity].offThreshold = extra.offThreshold;
      cap.fail = null;
      success = true;
    } else {
      const hasStructured = !!(result.main || result.plus || result.hand);
      cap.fail = {
        reason: hasStructured
          ? '取到的价格不合理（疑似只读到数字片段/促销角标），已跳过，建议重采或手动修改'
          : '页面上没有识别到价格',
        at: at,
        identity: identity
      };
    }
    cap.raw = {
      at: at,
      identity: identity,
      main: result.main || null,
      plus: result.plus || null,
      hand: result.hand || null,
      candidates: (result.candidates || []).slice(0, 20),
      title: result.title || '',
      url: result.url || '',
      flags: result.flags || null
    };
  } else {
    cap.fail = { reason: (result && result.reason) || '采集失败', at: at, identity: identity };
  }
  cap.updatedAt = at;
  state.db.captures[task.sku] = cap;
  return success;
}

// 复采一次：重新加载采集标签页并等待价格上报
async function recaptureTaskOnce(task) {
  const run = state.run;
  if (!run || run.runnerTabId == null) return { ok: false, reason: '没有可用的采集标签页' };
  try {
    const promise = waitForResult(task.sku, PRICE_TIMEOUT_MS);
    await chrome.tabs.reload(run.runnerTabId);
    return await promise;
  } catch (e) {
    return { ok: false, reason: '复采打开页面失败：' + errText(e) };
  }
}

function waitForResult(sku, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (state.pending && state.pending.sku === sku) {
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
  });
}

function failPending(reason) {
  if (!state.pending) return;
  const p = state.pending;
  state.pending = null;
  clearTimeout(p.timer);
  p.resolve({ ok: false, reason: reason });
}

function updateProgress(done, total, text) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  els.progressText.textContent = text || '';
  els.progressPct.textContent = done + ' / ' + total + '（' + pct + '%）';
  els.progressFill.style.width = pct + '%';
  const run = state.run;
  if (run) {
    els.runStats.textContent = '';
    const parts = [
      '成功 ' + run.ok,
      '失败 ' + run.fail,
      '当前账号 ' + (run.accountLabel || '识别中…')
    ];
    for (const part of parts) {
      const span = document.createElement('span');
      span.textContent = part;
      els.runStats.appendChild(span);
    }
  }
}

async function finishRun() {
  const run = state.run;
  state.running = false;
  state.paused = false;
  state.pending = null;
  if (run) {
    try {
      if (!state.db.settings.keepTab && run.runnerTabId != null) {
        await chrome.tabs.remove(run.runnerTabId);
      }
    } catch (e) {
      // 标签页可能已被关闭
    }
    state.db.lastRun = {
      identity: run.identity,
      at: new Date().toISOString(),
      done: run.done || 0,
      ok: run.ok,
      fail: run.fail,
      total: run.tasks.length,
      account: run.accountLabel || ''
    };
    if (run.accountLabel) state.db.lastAccount = run.accountLabel;
    await saveDb();
  }
  setToast('巡检结束：成功 ' + (run ? run.ok : 0) + '，失败 ' + (run ? run.fail : 0));
  if (run) {
    logLine('巡检结束：共 ' + run.tasks.length + ' 个，成功 ' + run.ok + '，失败 ' + run.fail);
    updateProgress(run.tasks.length, run.tasks.length, '已完成');
  }
  state.run = null;
  renderAll();
  if (state.autoRunMode) {
    state.autoRunMode = false;
    document.title = '电商平台价格巡检工作台 ✓ 自动巡检完成';
    try {
      autoExport();
    } catch (e) {
      logLine('自动导出失败：' + errText(e));
    }
  }
}

async function runLoop() {
  const run = state.run;
  const settings = state.db.settings;
  for (run.idx = 0; run.idx < run.tasks.length; run.idx++) {
    if (state.stopped) break;
    while (state.paused && !state.stopped) await sleep(400);
    if (state.stopped) break;

    const task = run.tasks[run.idx];
    updateProgress(run.done, run.tasks.length, '正在采集：' + task.sku + (task.model ? ' · ' + task.model : ''));
    logLine('[' + (run.idx + 1) + '/' + run.tasks.length + '] 打开 ' + task.sku);

    let result;
    try {
      await chrome.tabs.update(run.runnerTabId, { url: task.url });
      result = await waitForResult(task.sku, PRICE_TIMEOUT_MS);
    } catch (e) {
      result = { ok: false, reason: '打开页面失败：' + errText(e) };
    }
    if (state.stopped) break;

    if (result && result.account && result.account.nickname) {
      if (!run.accountLabel) {
        run.accountLabel = result.account.nickname;
        logLine('当前登录账号：' + run.accountLabel);
      } else if (run.accountLabel !== result.account.nickname) {
        if (state.autoRunMode) {
          state.stopped = true;
          logLine('⚠ 账号变化（' + run.accountLabel + ' → ' + result.account.nickname + '），自动巡检停止');
        } else {
          state.paused = true;
          logLine('⚠ 账号变化（' + run.accountLabel + ' → ' + result.account.nickname + '），已自动暂停');
          setToast('检测到电商平台账号发生变化，已暂停，请确认账号后点「继续」');
        }
      }
    }

    let finalResult = result;
    let finalPick = null;
    let offMeta = null;
    const threshold = thresholdFor(task, run.identity);
    if (result && result.ok) {
      const samples = [];
      const firstPick = pickPrice(run.identity, result, task.frontPrice);
      if (firstPick) samples.push({ price: firstPick.price, kind: firstPick.kind, result: result });
      const totalTarget = Math.max(1, Math.min(5, Math.round(Number(settings.deviationRetries) || 3)));
      if (firstPick && threshold != null && Math.abs(firstPick.price - threshold) > deviationLimitValue()) {
        const limit = deviationLimitValue();
        let tries = 0;
        while (samples.length < totalTarget && tries < totalTarget + 2 && !state.stopped) {
          tries++;
          const last = samples[samples.length - 1];
          const gap = Math.abs(last.price - threshold);
          logLine(
            '  ⚠ 价格 ' + fmtMoney(last.price) + ' 与阈值 ' + fmtMoney(threshold) + ' 相差 ' + fmtMoney(gap) +
            '，超过 ' + fmtMoney(limit) + '，自动多采（' + samples.length + '/' + totalTarget + '）'
          );
          setToast('价格偏离阈值较大，自动多采 ' + samples.length + '/' + totalTarget);
          await sleep(700 + randInt(0, 600));
          const again = await recaptureTaskOnce(task);
          if (!again || !again.ok) {
            logLine('  ✗ 多采失败：' + ((again && again.reason) || '未知原因'));
            break;
          }
          const p = pickPrice(run.identity, again, task.frontPrice);
          if (!p) {
            logLine('  ✗ 多采未取到合理价格');
            break;
          }
          samples.push({ price: p.price, kind: p.kind, result: again });
        }
        if (samples.length) {
          samples.sort((a, b) => Math.abs(a.price - threshold) - Math.abs(b.price - threshold));
          const best = samples[0];
          finalPick = { price: best.price, kind: best.kind };
          finalResult = best.result;
          const prices = samples.map((s) => s.price);
          const diff = Math.abs(best.price - threshold);
          offMeta = {
            threshold: Number(threshold),
            limit: limit,
            confirmLimit: deviationConfirmLimitValue(),
            attempts: prices.slice(0, 6),
            needsConfirm: diff > deviationConfirmLimitValue(),
            at: new Date().toISOString()
          };
          if (offMeta.needsConfirm) {
            logLine(
              '  ⚠ 已自动选值 ' + fmtMoney(best.price) + '（离阈值最近），仍与阈值相差 ' + fmtMoney(diff) +
              '，超过 ' + fmtMoney(offMeta.confirmLimit) + '，已标记「建议人工确认/修改」'
            );
          } else {
            logLine('  ✓ 复采完成，取最接近阈值的价格 ' + fmtMoney(best.price) + '（相差 ' + fmtMoney(diff) + '）');
          }
        }
      } else if (firstPick) {
        finalPick = firstPick;
      }
    }
    const success = recordResult(task, run.identity, finalResult, finalPick ? { pick: finalPick, offThreshold: offMeta } : null);
    run.done = run.idx + 1;
    if (success) {
      run.ok++;
      run.consecutiveFails = 0;
      const cap = state.db.captures[task.sku];
      const info = cap && cap[run.identity];
      logLine('  ✓ ' + (info ? fmtMoney(info.price) + '（' + kindLabel(info.kind) + '）' : '已采集') + (info && info.offThreshold ? (info.offThreshold.needsConfirm ? ' ⚠ 已选值，建议人工确认' : ' ⚠ 已多采取最接近值') : ''));
    } else {
      run.fail++;
      run.consecutiveFails = (run.consecutiveFails || 0) + 1;
      logLine('  ✗ ' + ((result && result.reason) || '采集失败'));
      if (run.consecutiveFails >= (state.autoRunMode ? 2 : 3)) {
        if (state.autoRunMode) {
          state.stopped = true;
          logLine('⚠ 连续 ' + run.consecutiveFails + ' 个失败，自动巡检停止（检查登录状态 / 页面是否改版 / 是否触发验证）');
        } else {
          state.paused = true;
          logLine('⚠ 连续 ' + run.consecutiveFails + ' 个失败，已自动暂停（检查登录状态 / 页面是否改版 / 是否触发验证）');
          setToast('连续采集失败，已自动暂停，请检查页面和登录状态');
        }
      }
    }
    await saveDb();
    renderAll();
    updateProgress(run.done, run.tasks.length, '已完成：' + task.sku);
    if (state.stopped) break;
    if (run.idx < run.tasks.length - 1) {
      const d = randInt(Number(settings.delayMin) || 3, Number(settings.delayMax) || 6);
      logLine('  等待 ' + d + ' 秒…');
      await sleep(d * 1000);
    }
  }
}

async function startRun(identity, opts) {
  opts = opts || {};
  state.autoRunMode = !!opts.auto;
  if (state.running) {
    setToast('已有巡检在进行中');
    return;
  }
  if (!state.rows.length) {
    setToast('基表为空，无法巡检');
    return;
  }
  let tasks;
  if (opts.skus && opts.skus.length) {
    tasks = [];
    const seen = new Set();
    for (const sku of opts.skus) {
      if (!sku || seen.has(sku)) continue;
      seen.add(sku);
      const row = state.rows.find((r) => r.sku === sku && !isOffline(r));
      if (row) {
        tasks.push({
          sku: row.sku,
          url: ITEM_URL(row.sku),
          model: row.model,
          sheet: row.sheet,
          excelRow: row.excelRow,
          frontPrice: row.frontPrice,
          utilMin: row.utilMin,
          plusMin: row.plusMin
        });
      }
    }
  } else if (opts.singleSku) {
    const row = state.rows.find((r) => r.sku === opts.singleSku && !isOffline(r));
    tasks = row
      ? [{
          sku: row.sku,
          url: ITEM_URL(row.sku),
          model: row.model,
          sheet: row.sheet,
          excelRow: row.excelRow,
          frontPrice: row.frontPrice
        }]
      : [];
  } else {
    tasks = collectTasks(identity);
  }
  if (!tasks.length) {
    if (opts.auto) {
      logLine('自动巡检：没有需要采集的 SKU，直接导出当前结果');
      autoExport();
      return;
    }
    window.alert(
      '没有需要采集的 SKU。\n\n可能原因：\n' +
        '1) 都采过了（设置里取消勾选「跳过今天已采集」可重采）；\n' +
        '2) 当前巡检范围内没有 SKU；\n' +
        '3) 每批数量设成了 0 以外的小值且已跑完。'
    );
    return;
  }
  const identityLabel = identity === 'util' ? '普惠账号' : '电商平台 PLUS 会员账号';
  const avg = (Number(state.db.settings.delayMin) + Number(state.db.settings.delayMax)) / 2 || 4;
  const est = Math.max(1, Math.round((tasks.length * (avg + 6)) / 60));
  if (!opts.auto && !opts.noConfirm) {
    const ok = window.confirm(
      '开始【' + identityLabel + '】巡检\n\n' +
        '本次 SKU：' + tasks.length + ' 个\n' +
        '预计耗时：约 ' + est + ' 分钟\n' +
        '采集方式：后台按节奏逐个打开商品页读取页面价格（不弹窗，可暂停/停止）\n\n' +
        '请先确认：当前 Edge 登录的是' + (identity === 'util' ? '【普通/普惠】账号' : '【PLUS 会员】账号') + '，并且能正常打开电商平台商品页。\n\n' +
        '确定开始？'
    );
    if (!ok) {
      state.autoRunMode = false;
      return;
    }
  } else if (opts.auto) {
    logLine('自动巡检模式：' + identityLabel + '，本次 ' + tasks.length + ' 个 SKU');
  } else {
    logLine('单条重采：' + tasks[0].sku + '（' + identityLabel + '）');
  }

  state.run = {
    identity: identity,
    tasks: tasks,
    idx: 0,
    done: 0,
    ok: 0,
    fail: 0,
    consecutiveFails: 0,
    accountLabel: '',
    startedAt: new Date().toISOString(),
    runnerTabId: null
  };
  state.running = true;
  state.paused = false;
  state.stopped = false;
  state.db.lastIdentity = identity;
  state.db.dismissedBanner = true;
  els.logPanel.textContent = '';
  els.progressWrap.classList.remove('hidden');
  renderAll();
  logLine('开始【' + identityLabel + '】巡检，共 ' + tasks.length + ' 个 SKU');
  try {
    const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
    state.run.runnerTabId = tab.id;
    await runLoop();
  } catch (e) {
    logLine('巡检异常终止：' + errText(e));
  } finally {
    await finishRun();
  }
}

// ---------------- 导出 / 导入 / 清理 ----------------
function csvCell(value) {
  const s = String(value == null ? '' : value);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function buildCsvText() {
  const rows = state.rows;
  const reportIds = new Set(state.db.reportRows || []);
  const header = [
    '类目', 'Excel行', 'SKU', '套餐型号', '套餐', '前台价格',
    '普惠最低到手价', '普惠当前价格', '普惠价格类型', '普惠采集时间',
    '会员最低到手价', '会员当前价格', '会员价格类型', '会员采集时间',
    '状态', '待上报', '备注'
  ];
  const lines = [header.map(csvCell).join(',')];
  for (const row of rows) {
    const cap = capOf(row) || {};
    const util = cap.util || null;
    const plus = cap.plus || null;
    const st = statusOf(row);
    let note = cap.fail ? '采集失败：' + (cap.fail.reason || '') : '';
    if (cap.manualConfirmed) note = (note ? note + '；' : '') + '已人工确认';
    if (isOffline(row)) note = (note ? note + '；' : '') + '已移入下架库';
    if (util && util.offThreshold) {
      note += (note ? '；' : '') + (util.offThreshold.confirmed ? '普惠价已人工确认' : (util.offThreshold.needsConfirm ? '普惠价已自动取最接近阈值的值，待人工确认' : '普惠价偏离阈值，已自动多采'));
    }
    if (plus && plus.offThreshold) {
      note += (note ? '；' : '') + (plus.offThreshold.confirmed ? '会员价已人工确认' : (plus.offThreshold.needsConfirm ? '会员价已自动取最接近阈值的值，待人工确认' : '会员价偏离阈值，已自动多采'));
    }
    const cells = [
      row.sheet,
      row.excelRow,
      row.sku,
      row.model,
      row.package || row.note,
      row.frontPrice,
      row.utilMin,
      util ? util.price : '',
      util ? kindLabel(util.kind) : '',
      util ? util.at : '',
      row.plusMin,
      plus ? plus.price : '',
      plus ? kindLabel(plus.kind) : '',
      plus ? plus.at : '',
      st.text,
      reportIds.has(row.rowId) ? '是' : '',
      note
    ];
    lines.push(cells.map(csvCell).join(','));
  }
  return '\uFEFF' + lines.join('\r\n');
}

function downloadText(text, mime, filename) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function stampNow() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

function exportCsv() {
  downloadText(buildCsvText(), 'text/csv;charset=utf-8', 'SKU巡检表-巡检结果-' + todayStamp() + '.csv');
  setToast('已导出 CSV');
}

// 导出用完整数据（CSV 之外的备份/对账用）
function buildResultPayload(mode) {
  return {
    at: new Date().toISOString(),
    mode: mode || 'manual',
    identity: (state.db.lastRun && state.db.lastRun.identity) || 'util',
    lastRun: state.db.lastRun || null,
    settings: state.db.settings,
    skuOverrides: state.db.skuOverrides,
    reportRows: state.db.reportRows || [],
    offlineRows: state.db.offlineRows || [],
    offlineSkus: state.db.offlineSkus || [],
    captures: state.db.captures,
    rows: state.rows.map((r) => ({
      rowId: r.rowId,
      sheet: r.sheet,
      excelRow: r.excelRow,
      sku: r.sku,
      model: r.model,
      package: r.package,
      frontPrice: r.frontPrice,
      utilMin: r.utilMin,
      plusMin: r.plusMin
    }))
  };
}

function exportJson() {
  downloadText(JSON.stringify(buildResultPayload('manual-export'), null, 2), 'application/json', 'SKU巡检表-巡检数据-' + todayStamp() + '.json');
  setToast('已导出 JSON');
}

// 自动巡检模式结束后，把完整结果自动下载到浏览器默认下载目录（JSON，便于外部读取）
function autoExport() {
  const name = 'jd-patrol-auto-' + stampNow() + '.json';
  downloadText(JSON.stringify(buildResultPayload('autorun'), null, 2), 'application/json', name);
  state.db.lastAutoExport = { at: new Date().toISOString(), file: name };
  saveDb();
  logLine('已自动下载结果文件：' + name);
  setToast('已自动下载巡检结果：' + name);
}

async function copyDebugRaw() {
  const latest = latestRawCapture();
  const text = latest ? JSON.stringify({ sku: latest.sku, ...latest.raw }, null, 2) : '暂无采集数据';
  try {
    await navigator.clipboard.writeText(text);
    setToast('调试 JSON 已复制，直接粘贴发我即可');
  } catch (e) {
    setToast('复制失败，可在下方文本框手动选择复制');
    els.debugBox.textContent = text;
  }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// 导入之前导出的 JSON：恢复采集记录、手动改价、待上报区
async function importDataFile(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch (e) {
    window.alert('JSON 解析失败：' + errText(e));
    return;
  }
  if (!data || !data.captures || typeof data.captures !== 'object') {
    window.alert('这不是有效的巡检数据文件（缺少 captures）。请选择工作台「导出 JSON」生成的文件。');
    return;
  }
  const capCount = Object.keys(data.captures).length;
  if (!window.confirm('导入巡检数据：' + capCount + ' 个 SKU 的采集记录？\n\n会与当前数据合并（同一 SKU 以导入的为准），并恢复手动改价和待上报区。')) return;
  Object.assign(state.db.captures, data.captures);
  if (data.skuOverrides && typeof data.skuOverrides === 'object') Object.assign(state.db.skuOverrides, data.skuOverrides);
  if (Array.isArray(data.reportRows)) {
    const set = new Set(state.db.reportRows || []);
    data.reportRows.forEach((id) => set.add(id));
    state.db.reportRows = Array.from(set);
  }
  if (Array.isArray(data.offlineRows)) {
    const set = new Set(state.db.offlineRows || []);
    data.offlineRows.forEach((id) => set.add(id));
    state.db.offlineRows = Array.from(set);
  }
  if (Array.isArray(data.offlineSkus)) {
    const set = new Set(state.db.offlineSkus || []);
    data.offlineSkus.forEach((sku) => set.add(sku));
    state.db.offlineSkus = Array.from(set);
  }
  if (data.lastRun) state.db.lastRun = data.lastRun;
  await saveDb();
  flattenRows();
  renderAll();
  setToast('已导入巡检数据：' + capCount + ' 个 SKU');
}

async function addSelectedToReport() {
  if (!state.selected.size) {
    setToast('先在总览页勾选要上报的行');
    return;
  }
  const ids = new Set(state.db.reportRows || []);
  let added = 0;
  for (const row of state.rows) {
    if (row.sku && state.selected.has(row.sku) && !ids.has(row.rowId)) {
      ids.add(row.rowId);
      added++;
    }
  }
  if (!added) {
    setToast('选中的行已经在待上报区了');
    return;
  }
  state.db.reportRows = Array.from(ids);
  await saveDb();
  renderAll();
  setToast('已加入待上报区：' + added + ' 行');
}

async function clearReport() {
  if (!(state.db.reportRows || []).length) return;
  if (!window.confirm('清空待上报区（不会删除采集数据）？')) return;
  state.db.reportRows = [];
  await saveDb();
  renderAll();
  setToast('待上报区已清空');
}

// ---------------- 极简 xlsx 生成（不依赖第三方库） ----------------
const REPORT_COLS = [
  { header: '类目', width: 10 },
  { header: 'Excel行', width: 8 },
  { header: 'SKU', width: 16 },
  { header: '套餐型号', width: 30 },
  { header: '套餐', width: 24 },
  { header: '前台价格', width: 12 },
  { header: '普惠最低到手价', width: 14 },
  { header: '普惠当前价格', width: 14 },
  { header: '普惠价格类型', width: 12 },
  { header: '普惠采集时间', width: 22 },
  { header: '会员最低到手价', width: 14 },
  { header: '会员当前价格', width: 14 },
  { header: '会员价格类型', width: 12 },
  { header: '会员采集时间', width: 22 },
  { header: '状态', width: 10 },
  { header: '价差说明', width: 28 }
];

function reportRowValues(row) {
  const cap = capOf(row) || {};
  const util = cap.util || null;
  const plus = cap.plus || null;
  const st = statusOf(row);
  const diffs = [];
  if (util && util.price != null && row.utilMin != null && util.price < row.utilMin - 0.001) {
    diffs.push('普惠低 ¥' + fmtNum(row.utilMin - util.price));
  }
  if (plus && plus.price != null && row.plusMin != null && plus.price < row.plusMin - 0.001) {
    diffs.push('会员低 ¥' + fmtNum(row.plusMin - plus.price));
  }
  return [
    row.sheet,
    row.excelRow,
    row.sku,
    row.model,
    row.package || row.note,
    row.frontPrice != null ? row.frontPrice : '',
    row.utilMin != null ? row.utilMin : '',
    util && util.price != null ? util.price : '',
    util ? kindLabel(util.kind) : '',
    util ? fmtTime(util.at) : '',
    row.plusMin != null ? row.plusMin : '',
    plus && plus.price != null ? plus.price : '',
    plus ? kindLabel(plus.kind) : '',
    plus ? fmtTime(plus.at) : '',
    st.text,
    diffs.join('；')
  ];
}

function xlsxEscape(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function xlsxColName(index) {
  let n = index + 1;
  let name = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    name = String.fromCharCode(65 + r) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

function xlsxCell(ref, value) {
  if (value == null || value === '') return '';
  if (typeof value === 'number' && isFinite(value)) return '<c r="' + ref + '"><v>' + value + '</v></c>';
  if (typeof value === 'number') return '';
  return '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' + xlsxEscape(value) + '</t></is></c>';
}

function crc32(bytes) {
  if (!crc32.table) {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c >>> 0;
    }
    crc32.table = table;
  }
  const table = crc32.table;
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = (crc >>> 8) ^ table[(crc ^ bytes[i]) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

function utf8Bytes(text) {
  return new TextEncoder().encode(text);
}

function zipStore(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const dosTime = 0;
  const dosDate = 0;
  for (const file of files) {
    const nameBytes = utf8Bytes(file.name);
    const data = file.data;
    const crc = crc32(data);
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, 0, true);
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    chunks.push(local, data);
    const cen = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cen.set(nameBytes, 46);
    central.push(cen);
    offset += local.length + data.length;
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  return new Blob(chunks.concat(central, [end]), {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  });
}

function buildXlsxBlob(sheetName, rows) {
  const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const sheetRows = rows
    .map((row, rIdx) => {
      const cells = row
        .map((value, cIdx) => xlsxCell(xlsxColName(cIdx) + (rIdx + 1), value))
        .join('');
      return '<row r="' + (rIdx + 1) + '">' + cells + '</row>';
    })
    .join('');
  const cols = REPORT_COLS.map(
    (col, idx) => '<col min="' + (idx + 1) + '" max="' + (idx + 1) + '" width="' + col.width + '" customWidth="1"/>'
  ).join('');
  const sheetXml =
    HEAD +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<cols>' + cols + '</cols>' +
    '<sheetData>' + sheetRows + '</sheetData>' +
    '</worksheet>';
  const workbookXml =
    HEAD +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheets><sheet name="' + xlsxEscape(sheetName) + '" sheetId="1" r:id="rId1"/></sheets></workbook>';
  const contentTypes =
    HEAD +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '</Types>';
  const rootRels =
    HEAD +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>';
  const workbookRels =
    HEAD +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
    '</Relationships>';
  return zipStore([
    { name: '[Content_Types].xml', data: utf8Bytes(contentTypes) },
    { name: '_rels/.rels', data: utf8Bytes(rootRels) },
    { name: 'xl/workbook.xml', data: utf8Bytes(workbookXml) },
    { name: 'xl/_rels/workbook.xml.rels', data: utf8Bytes(workbookRels) },
    { name: 'xl/worksheets/sheet1.xml', data: utf8Bytes(sheetXml) }
  ]);
}

function exportReportXlsx() {
  const rows = reportRowList();
  if (!rows.length) {
    setToast('待上报区为空，先在总览页汇总选中行');
    return;
  }
  try {
    const header = REPORT_COLS.map((col) => col.header);
    const data = [header].concat(rows.map((row) => reportRowValues(row)));
    const blob = buildXlsxBlob('待上报', data);
    downloadBlob(blob, 'SKU巡检表-待上报-' + todayStamp() + '.xlsx');
    setToast('已导出待上报 Excel（' + rows.length + ' 行）');
  } catch (e) {
    setToast('导出 Excel 失败：' + errText(e));
  }
}

// ---------------- 基表导入（支持 Excel .xlsx / JSON） ----------------
const XLSX_HEADER_ALIASES = {
  sku: ['sku', '商品编号', 'sku_id', '商品SKU'],
  model: ['套餐型号', '型号', '商品型号'],
  package: ['套餐', '套餐名称'],
  frontPrice: ['前台价格', '前台价'],
  utilMin: ['普惠最低到手价', '普惠最低价', '普惠阈值'],
  utilCurrent: ['普惠当前价格', '普惠当前价'],
  plusMin: ['会员最低到手价', '会员最低价', '会员阈值'],
  plusCurrent: ['会员当前价格', '会员当前价']
};

function normHeaderText(value) {
  return String(value == null ? '' : value).replace(/\s+/g, '').trim();
}

function xlsxToText(value) {
  return value == null ? '' : String(value).trim();
}

function xlsxToNumber(value) {
  const text = xlsxToText(value).replace(/,/g, '').replace(/^[¥￥]/, '');
  if (!text) return null;
  const n = Number(text);
  return isFinite(n) ? n : null;
}

function detectXlsxColumns(headerCells) {
  const mapping = {};
  const normalized = headerCells.map((cell) => normHeaderText(cell));
  for (const field of Object.keys(XLSX_HEADER_ALIASES)) {
    const aliases = XLSX_HEADER_ALIASES[field].map((a) => normHeaderText(a));
    for (let i = 0; i < normalized.length; i++) {
      if (aliases.indexOf(normalized[i]) >= 0) {
        mapping[field] = i;
        break;
      }
    }
  }
  return mapping;
}

function dedupeSheetRows(rows) {
  const bySku = new Map();
  const result = [];
  let dropped = 0;
  for (const row of rows) {
    const sku = String(row.sku || '').trim();
    if (!sku) {
      result.push(row);
      continue;
    }
    const existing = bySku.get(sku);
    if (existing) {
      const keepRowId = existing.rowId;
      const keepExcelRow = existing.excelRow;
      Object.assign(existing, row);
      existing.rowId = keepRowId;
      existing.excelRow = keepExcelRow;
      dropped++;
    } else {
      bySku.set(sku, row);
      result.push(row);
    }
  }
  return { rows: result, dropped: dropped };
}

function normalizeBaseSheets(base, sourceName) {
  let totalRows = 0;
  let totalWithSku = 0;
  const sheets = [];
  for (const sheet of (base && base.sheets) || []) {
    if (!sheet || !sheet.name) continue;
    const deduped = dedupeSheetRows(sheet.rows || []);
    const rows = deduped.rows;
    let withSku = 0;
    for (const row of rows) if (String(row.sku || '').trim()) withSku++;
    rows.forEach((row) => {
      row.sheet = sheet.name;
      if (row.rowId == null) row.rowId = sheet.name + '!' + (row.excelRow != null ? row.excelRow : '');
    });
    sheets.push({
      name: sheet.name,
      rows: rows,
      rowCount: rows.length,
      withSku: withSku,
      missingSku: rows.length - withSku,
      deduped: sheet.deduped != null ? sheet.deduped : deduped.dropped,
      columns: sheet.columns || {}
    });
    totalRows += rows.length;
    totalWithSku += withSku;
  }
  return {
    version: 2,
    generatedAt: new Date().toISOString(),
    source: sourceName || (base && base.source) || '导入',
    sheets: sheets,
    totalRows: totalRows,
    totalWithSku: totalWithSku,
    duplicates: {}
  };
}

// ---- 极简 xlsx 读取（zip + deflate + xml，不依赖第三方库） ----
async function readZipEntries(arrayBuffer) {
  const u8 = new Uint8Array(arrayBuffer);
  const u16 = (o) => u8[o] | (u8[o + 1] << 8);
  const u32 = (o) => (u8[o] | (u8[o + 1] << 8) | (u8[o + 2] << 16) | (u8[o + 3] << 24)) >>> 0;
  let eocd = -1;
  const lowest = Math.max(0, u8.length - 22 - 65535);
  for (let i = u8.length - 22; i >= lowest; i--) {
    if (u32(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是有效的 xlsx（zip 结构）文件');
  const count = u16(eocd + 10);
  const cdOffset = u32(eocd + 16);
  const entries = new Map();
  let p = cdOffset;
  const decoder = new TextDecoder('utf-8');
  for (let i = 0; i < count; i++) {
    if (p + 46 > u8.length || u32(p) !== 0x02014b50) break;
    const method = u16(p + 10);
    const compSize = u32(p + 20);
    const nameLen = u16(p + 28);
    const extraLen = u16(p + 30);
    const commentLen = u16(p + 32);
    const localOffset = u32(p + 42);
    const name = decoder.decode(u8.subarray(p + 46, p + 46 + nameLen));
    entries.set(name, { method: method, compSize: compSize, localOffset: localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { u8: u8, entries: entries, u16: u16, u32: u32 };
}

async function inflateRawBytes(bytes) {
  if (typeof DecompressionStream !== 'function') throw new Error('当前浏览器不支持解压 xlsx');
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

async function readZipFile(zip, name) {
  const entry = zip.entries.get(name);
  if (!entry) throw new Error('xlsx 缺少文件：' + name);
  const u8 = zip.u8;
  const lh = entry.localOffset;
  if (zip.u32(lh) !== 0x04034b50) throw new Error('xlsx zip 头部损坏');
  const nameLen = zip.u16(lh + 26);
  const extraLen = zip.u16(lh + 28);
  const start = lh + 30 + nameLen + extraLen;
  const data = u8.subarray(start, start + entry.compSize);
  if (entry.method === 0) return new Uint8Array(data);
  if (entry.method === 8) return await inflateRawBytes(data);
  throw new Error('不支持的 xlsx 压缩方式：' + entry.method);
}

function parseXmlDocument(text) {
  return new DOMParser().parseFromString(text, 'application/xml');
}

function xmlCollectText(el) {
  let text = '';
  for (const t of el.getElementsByTagNameNS('*', 't')) text += t.textContent || '';
  return text;
}

function columnIndexFromRef(ref) {
  const m = String(ref || '').match(/^([A-Z]+)(\d+)$/);
  if (!m) return -1;
  let index = 0;
  for (const ch of m[1]) index = index * 26 + (ch.charCodeAt(0) - 64);
  return index - 1;
}

async function parseXlsxBase(file) {
  const buffer = await file.arrayBuffer();
  const zip = await readZipEntries(buffer);
  const decoder = new TextDecoder('utf-8');
  const workbook = parseXmlDocument(decoder.decode(await readZipFile(zip, 'xl/workbook.xml')));
  const relsXml = parseXmlDocument(decoder.decode(await readZipFile(zip, 'xl/_rels/workbook.xml.rels')));
  const rels = {};
  for (const rel of relsXml.getElementsByTagNameNS('*', 'Relationship')) {
    const id = rel.getAttribute('Id');
    const target = (rel.getAttribute('Target') || '').replace(/^\/?xl\//, '').replace(/^\.\//, '');
    if (id) rels[id] = 'xl/' + target;
  }
  const shared = [];
  if (zip.entries.has('xl/sharedStrings.xml')) {
    const sharedXml = parseXmlDocument(decoder.decode(await readZipFile(zip, 'xl/sharedStrings.xml')));
    for (const si of sharedXml.getElementsByTagNameNS('*', 'si')) shared.push(xmlCollectText(si));
  }
  const relNs = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const sheets = [];
  let sheetIndex = 0;
  for (const sheetEl of workbook.getElementsByTagNameNS('*', 'sheet')) {
    sheetIndex++;
    const name = sheetEl.getAttribute('name') || ('Sheet' + sheetIndex);
    const rid = sheetEl.getAttributeNS(relNs, 'id') || sheetEl.getAttribute('r:id');
    const path = rels[rid] || ('xl/worksheets/sheet' + sheetIndex + '.xml');
    let sheetXml;
    try {
      sheetXml = parseXmlDocument(decoder.decode(await readZipFile(zip, path)));
    } catch (e) {
      continue;
    }
    const grid = [];
    for (const rowEl of sheetXml.getElementsByTagNameNS('*', 'row')) {
      const rowNumber = Number(rowEl.getAttribute('r')) || grid.length + 1;
      const cells = [];
      for (const cellEl of rowEl.getElementsByTagNameNS('*', 'c')) {
        const col = columnIndexFromRef(cellEl.getAttribute('r'));
        if (col < 0) continue;
        const type = cellEl.getAttribute('t');
        let value = null;
        if (type === 'inlineStr') {
          const is = cellEl.getElementsByTagNameNS('*', 'is')[0];
          value = is ? xmlCollectText(is) : '';
        } else {
          const v = cellEl.getElementsByTagNameNS('*', 'v')[0];
          if (v) value = v.textContent;
          if (type === 's' && value != null) value = shared[Number(value)] || '';
        }
        cells[col] = value;
      }
      grid[rowNumber - 1] = cells;
    }
    const headerCells = grid[0] || [];
    const mapping = detectXlsxColumns(headerCells);
    if (mapping.sku == null || mapping.model == null) {
      continue;
    }
    const rows = [];
    for (let i = 1; i < grid.length; i++) {
      const cells = grid[i] || [];
      const get = (field) => (mapping[field] == null ? null : cells[mapping[field]]);
      const skuText = xlsxToText(get('sku'));
      const sku = /^\d{6,}$/.test(skuText) ? skuText : '';
      const note = !sku && skuText ? skuText : '';
      const model = xlsxToText(get('model'));
      const packageText = xlsxToText(get('package'));
      const frontPrice = xlsxToNumber(get('frontPrice'));
      const utilMin = xlsxToNumber(get('utilMin'));
      const plusMin = xlsxToNumber(get('plusMin'));
      if (!sku && !note && !model && !packageText && frontPrice == null && utilMin == null && plusMin == null) continue;
      rows.push({
        rowId: name + '!' + (i + 1),
        sheet: name,
        excelRow: i + 1,
        sku: sku,
        note: note,
        model: model,
        package: packageText,
        frontPrice: frontPrice,
        utilMin: utilMin,
        plusMin: plusMin,
        utilCurrent: xlsxToNumber(get('utilCurrent')),
        plusCurrent: xlsxToNumber(get('plusCurrent'))
      });
    }
    const deduped = dedupeSheetRows(rows);
    let withSku = 0;
    for (const row of deduped.rows) if (row.sku) withSku++;
    sheets.push({
      name: name,
      rows: deduped.rows,
      rowCount: deduped.rows.length,
      withSku: withSku,
      missingSku: deduped.rows.length - withSku,
      deduped: sheet.deduped != null ? sheet.deduped : deduped.dropped,
      columns: mapping
    });
  }
  if (!sheets.length) {
    throw new Error('没有读到有效数据：需要表头包含「sku」和「套餐型号」两列');
  }
  return normalizeBaseSheets({ sheets: sheets }, file.name);
}

async function importBaseFile(file, options) {
  const opts = options || {};
  const isXlsx = /\.(xlsx|xlsm)$/i.test(file.name || '');
  let data = null;
  if (isXlsx) {
    try {
      data = await parseXlsxBase(file);
    } catch (e) {
      window.alert('Excel 解析失败：' + errText(e) + '\n\n请确认是 .xlsx 文件，且表头包含「sku」「套餐型号」。');
      return;
    }
  } else {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!parsed || !Array.isArray(parsed.sheets) || !parsed.sheets.length) throw new Error('缺少 sheets 数组');
      data = normalizeBaseSheets(parsed, file.name);
    } catch (e) {
      window.alert('基表 JSON 解析失败：' + errText(e));
      return;
    }
  }
  if (!opts.skipConfirm) {
    const ok = window.confirm(
      '导入基表：' + file.name + '\n\n' +
        '类目：' + data.sheets.length + ' 个\n' +
        '行数：' + data.totalRows + ' 行（其中 ' + data.totalWithSku + ' 行有 SKU）\n' +
        '已按 SKU 去重，重复 SKU 保留最后一条数据。\n\n' +
        '会覆盖当前使用的基表（已采集的价格按 SKU 保留）。确定导入？'
    );
    if (!ok) return;
  }
  state.db.baseOverride = data;
  await saveDb();
  state.base = data;
  flattenRows();
  renderAll();
  setToast('基表已导入：' + data.sheets.length + ' 个类目 · ' + data.totalRows + ' 行 · ' + data.totalWithSku + ' 行有 SKU');
}


async function resetBase() {
  if (!state.db.baseOverride) {
    setToast('当前已经是内置基表');
    return;
  }
  if (!window.confirm('恢复为扩展内置的基表？导入的基表会被丢弃（已采集的价格保留）。')) return;
  state.db.baseOverride = null;
  await saveDb();
  await reloadBase();
  renderAll();
  setToast('已恢复内置基表');
}

async function purgeCaptures() {
  if (state.running) {
    setToast('巡检进行中，先停止再清空');
    return;
  }
  if (!window.confirm('清空所有已采集的价格？（只清采集结果，不影响基表和补录的 SKU）')) return;
  state.db.captures = {};
  await saveDb();
  renderAll();
  setToast('已清空采集结果');
}

// ---------------- 设置 ----------------
function latestRawCapture() {
  let latest = null;
  for (const sku of Object.keys(state.db.captures)) {
    const cap = state.db.captures[sku];
    if (!cap || !cap.raw) continue;
    if (!latest || String(cap.raw.at || '') > String(latest.raw.at || '')) {
      latest = { sku: sku, cap: cap, raw: cap.raw };
    }
  }
  return latest;
}

function openSettings() {
  const s = state.db.settings;
  els.setBatch.value = String(s.batchSize);
  els.setDelayMin.value = String(s.delayMin);
  els.setDelayMax.value = String(s.delayMax);
  els.setSkipToday.checked = !!s.skipCapturedToday;
  els.setScope.value = s.scope || 'all';
  els.setKeepTab.checked = !!s.keepTab;
  els.setDeviationLimit.value = String(s.deviationLimit != null ? s.deviationLimit : 500);
  els.setDeviationRetries.value = String(s.deviationRetries != null ? s.deviationRetries : 3);
  els.setDeviationConfirm.value = String(s.deviationConfirmLimit != null ? s.deviationConfirmLimit : 1500);
  els.setPreviewDelay.value = String(s.previewDelayMs != null ? s.previewDelayMs : 1000);
  const latest = latestRawCapture();
  els.debugBox.textContent = latest
    ? JSON.stringify({ sku: latest.sku, at: latest.raw.at, identity: latest.raw.identity, main: latest.raw.main, plus: latest.raw.plus, hand: latest.raw.hand, candidates: latest.raw.candidates }, null, 2)
    : '暂无';
  if (typeof els.settingsDialog.showModal === 'function') els.settingsDialog.showModal();
  else els.settingsDialog.setAttribute('open', '');
}

async function saveSettings() {
  const batch = Math.max(0, Math.floor(Number(els.setBatch.value) || 0));
  let delayMin = Math.max(1, Math.floor(Number(els.setDelayMin.value) || 3));
  let delayMax = Math.max(delayMin, Math.floor(Number(els.setDelayMax.value) || 6));
  delayMin = Math.min(delayMin, 60);
  delayMax = Math.min(delayMax, 120);
  state.db.settings = {
    batchSize: batch,
    delayMin: delayMin,
    delayMax: delayMax,
    skipCapturedToday: !!els.setSkipToday.checked,
    scope: els.setScope.value === 'current' ? 'current' : 'all',
    keepTab: !!els.setKeepTab.checked,
    deviationLimit: Math.max(0, Math.floor(Number(els.setDeviationLimit.value) || 0)),
    deviationRetries: Math.max(1, Math.min(5, Math.floor(Number(els.setDeviationRetries.value) || 3))),
    deviationConfirmLimit: Math.max(0, Math.floor(Number(els.setDeviationConfirm.value) || 0)),
    previewDelayMs: Math.max(300, Math.min(5000, Math.floor(Number(els.setPreviewDelay.value) || 1000)))
  };
  await saveDb();
  renderRunUI();
  setToast('设置已保存');
}

// ---------------- 基表管理 ----------------
function currentEffectiveBase() {
  return state.db.baseOverride || state.base;
}

function openBaseManager() {
  const base = currentEffectiveBase();
  if (!base || !Array.isArray(base.sheets)) {
    setToast('基表还没加载好');
    return;
  }
  const draft = JSON.parse(JSON.stringify(base));
  state.baseManager = {
    sheet: (draft.sheets[0] && draft.sheets[0].name) || '',
    draft: draft
  };
  renderBaseManager();
  if (!els.baseDialog.open) {
    if (typeof els.baseDialog.showModal === 'function') els.baseDialog.showModal();
    else els.baseDialog.setAttribute('open', '');
  }
}

function baseSheetOf(name) {
  return (state.baseManager.draft.sheets || []).find((sh) => sh.name === name) || null;
}

function renderBaseManager() {
  const draft = state.baseManager.draft;
  if (!draft) return;
  // 类目 tab（加一个「全部」方便跨类目看）
  els.baseCatTabs.textContent = '';
  const names = ['全部'].concat((draft.sheets || []).map((sh) => sh.name));
  for (const name of names) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tab' + (state.baseManager.sheet === name ? ' active' : '');
    btn.textContent = name;
    const count = document.createElement('span');
    count.className = 'count';
    const n = name === '全部'
      ? (draft.sheets || []).reduce((sum, sh) => sum + (sh.rows || []).length, 0)
      : ((baseSheetOf(name) && baseSheetOf(name).rows) || []).length;
    count.textContent = '· ' + n;
    btn.appendChild(count);
    btn.addEventListener('click', () => {
      state.baseManager.sheet = name;
      renderBaseManager();
    });
    els.baseCatTabs.appendChild(btn);
  }
  renderBaseRows();
  const sheet = baseSheetOf(state.baseManager.sheet);
  els.baseRenameCatBtn.disabled = !sheet;
  els.baseDelCatBtn.disabled = !sheet;
  els.baseAddRowBtn.disabled = state.baseManager.sheet === '全部' || !sheet;
}

function renderBaseRows() {
  const draft = state.baseManager.draft;
  const sheetName = state.baseManager.sheet;
  const sheets = sheetName === '全部' ? draft.sheets || [] : [baseSheetOf(sheetName)].filter(Boolean);
  const rows = [];
  for (const sh of sheets) {
    for (const row of sh.rows || []) rows.push({ sheet: sh, row: row });
  }
  els.baseTblBody.textContent = '';
  if (!rows.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 8;
    td.className = 'muted';
    td.textContent = '这个类目还没有行，点下面「新增一行」开始。';
    tr.appendChild(td);
    els.baseTblBody.appendChild(tr);
    return;
  }
  for (const item of rows) {
    const row = item.row;
    const tr = document.createElement('tr');

    const tdRow = document.createElement('td');
    tdRow.className = 'num';
    tdRow.textContent = row.excelRow != null && row.excelRow !== '' ? String(row.excelRow) : '—';
    tr.appendChild(tdRow);

    const fields = [
      { key: 'sku', type: 'text', cls: 'base-col-sku' },
      { key: 'model', type: 'text' },
      { key: 'package', type: 'text' },
      { key: 'frontPrice', type: 'number', cls: 'num' },
      { key: 'utilMin', type: 'number', cls: 'num' },
      { key: 'plusMin', type: 'number', cls: 'num' }
    ];
    for (const f of fields) {
      const td = document.createElement('td');
      const input = document.createElement('input');
      input.type = f.type;
      if (f.type === 'number') input.step = '0.01';
      input.className = 'baseInput' + (f.cls === 'num' ? ' num' : '');
      input.value = row[f.key] == null ? '' : String(row[f.key]);
      input.placeholder = f.key === 'sku' ? 'SKU' : '';
      input.addEventListener('input', () => {
        const v = input.value.trim();
        if (f.type === 'number') {
          row[f.key] = v === '' ? null : Number(v);
        } else {
          row[f.key] = v;
        }
      });
      td.appendChild(input);
      tr.appendChild(td);
    }

    const tdOp = document.createElement('td');
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'baseDelBtn';
    del.textContent = '删除';
    del.title = '从基表中删除这一行（保存后生效）';
    del.addEventListener('click', () => {
      const sh = item.sheet;
      sh.rows = (sh.rows || []).filter((r) => r !== row);
      renderBaseManager();
    });
    tdOp.appendChild(del);
    tr.appendChild(tdOp);
    els.baseTblBody.appendChild(tr);
  }
}

function nextManualRowId() {
  return 'manual!' + Date.now() + '!' + Math.floor(Math.random() * 10000);
}

function addBaseRow() {
  const sheetName = state.baseManager.sheet;
  const sheet = baseSheetOf(sheetName);
  if (!sheet) {
    setToast('先选中一个具体类目（不能是「全部」）');
    return;
  }
  sheet.rows = sheet.rows || [];
  sheet.rows.push({
    rowId: nextManualRowId(),
    sheet: sheetName,
    excelRow: '',
    sku: '',
    note: '',
    model: '',
    package: '',
    frontPrice: null,
    utilMin: null,
    plusMin: null,
    utilCurrent: null,
    plusCurrent: null
  });
  renderBaseManager();
  // 滚动到底部
  try {
    els.baseTblBody.parentElement.parentElement.scrollTop = els.baseTblBody.parentElement.parentElement.scrollHeight;
  } catch (e) {}
}

function addBaseCategory() {
  const name = window.prompt('新增类目名称（会作为新的 sheet）', '');
  if (name == null) return;
  const trimmed = name.trim();
  if (!trimmed) {
    setToast('类目名称不能为空');
    return;
  }
  const draft = state.baseManager.draft;
  if ((draft.sheets || []).some((sh) => sh.name === trimmed)) {
    setToast('已存在同名类目');
    return;
  }
  draft.sheets = draft.sheets || [];
  draft.sheets.push({ name: trimmed, rows: [] });
  state.baseManager.sheet = trimmed;
  renderBaseManager();
}

function renameBaseCategory() {
  const oldName = state.baseManager.sheet;
  const sheet = baseSheetOf(oldName);
  if (!sheet) return;
  const name = window.prompt('重命名类目（会同步更新该类目下的行）', oldName);
  if (name == null) return;
  const trimmed = name.trim();
  if (!trimmed || trimmed === oldName) return;
  const draft = state.baseManager.draft;
  if ((draft.sheets || []).some((sh) => sh.name === trimmed)) {
    setToast('已存在同名类目');
    return;
  }
  sheet.name = trimmed;
  for (const row of sheet.rows || []) row.sheet = trimmed;
  state.baseManager.sheet = trimmed;
  renderBaseManager();
}

function deleteBaseCategory() {
  const name = state.baseManager.sheet;
  const draft = state.baseManager.draft;
  const sheet = baseSheetOf(name);
  if (!sheet) return;
  if (!window.confirm('删除类目「' + name + '」及其下 ' + ((sheet.rows || []).length) + ' 行？保存后生效。')) return;
  draft.sheets = (draft.sheets || []).filter((sh) => sh !== sheet);
  state.baseManager.sheet = draft.sheets[0] ? draft.sheets[0].name : '';
  renderBaseManager();
}

async function saveBaseManager() {
  const draft = state.baseManager.draft;
  if (!draft) return;
  let total = 0;
  let withSku = 0;
  draft.sheets = (draft.sheets || []).filter((sh) => sh && sh.name);
  for (const sh of draft.sheets) {
    sh.rows = sh.rows || [];
    sh.rowCount = sh.rows.length;
    sh.withSku = sh.rows.filter((r) => String(r.sku || '').trim()).length;
    sh.missingSku = sh.rowCount - sh.withSku;
    total += sh.rowCount;
    withSku += sh.withSku;
  }
  draft.totalRows = total;
  draft.totalWithSku = withSku;
  draft.sheetCount = draft.sheets.length;
  draft.generatedAt = new Date().toISOString();
  draft.source = '手动管理';
  draft.duplicates = {};
  state.db.baseOverride = draft;
  await saveDb();
  await reloadBase();
  renderAll();
  setToast('基表已保存：' + draft.sheets.length + ' 个类目 · ' + total + ' 行 · ' + withSku + ' 行有 SKU');
  renderBaseManager();
}

function exportBaseJson() {
  const base = state.baseManager.draft || currentEffectiveBase();
  if (!base) return;
  downloadText(JSON.stringify(base, null, 2), 'application/json', 'SKU巡检表-基表备份-' + todayStamp() + '.json');
  setToast('已导出基表 JSON');
}

// ---------------- 事件 ----------------
function setupRuntimeListeners() {
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (!msg || msg.type !== 'ITEM_PRICE_RESULT') return;
    const run = state.run;
    if (!run || !state.pending) return;
    if (!sender || !sender.tab || sender.tab.id !== run.runnerTabId) return;
    if (msg.sku !== state.pending.sku) return;
    const p = state.pending;
    p.resolve(msg);
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    const run = state.run;
    if (!run || tabId !== run.runnerTabId) return;
    const url = changeInfo.url || (tab && tab.url) || '';
    if (url && /passport\.jd\.com|plogin\.jd\.com|login\.jd\.com/i.test(url)) {
      logLine('⚠ 页面跳转到电商平台登录页，登录可能已失效');
      failPending('需要登录电商平台账号（页面跳到了登录页）');
    }
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    const run = state.run;
    if (!run || tabId !== run.runnerTabId) return;
    failPending('采集用的后台标签页被关闭了');
    if (state.running) {
      state.stopped = true;
      state.paused = false;
      logLine('采集用的后台标签页被关闭，巡检停止');
    }
  });
}

function bindEvents() {
  els.runUtilBtn.addEventListener('click', () => startRun('util'));
  els.runPlusBtn.addEventListener('click', () => startRun('plus'));
  els.multiRerunBtn.addEventListener('click', () => {
    if (state.running) {
      setToast('已有巡检在进行中');
      return;
    }
    const skus = Array.from(state.selected).filter(Boolean);
    if (!skus.length) {
      setToast('先勾选要重采的行');
      return;
    }
    const identity = (state.db.lastRun && state.db.lastRun.identity) || 'util';
    const label = identity === 'util' ? '普惠账号' : 'PLUS 会员账号';
    if (!window.confirm('按【' + label + '】身份重采选中的 ' + skus.length + ' 个 SKU？')) return;
    startRun(identity, { skus: skus, noConfirm: true }).catch(() => {});
  });
  els.tabWorkbench.addEventListener('click', () => switchView('workbench'));
  els.tabOverview.addEventListener('click', () => switchView('overview'));
  els.ovClearFilterBtn.addEventListener('click', () => {
    state.ovFilter = { key: 'all', sheet: '全部' };
    renderAll();
  });
  els.ovConfirmBtn.addEventListener('click', confirmSelectedDeviation);
  els.ovOfflineBtn.addEventListener('click', offlineSelected);
  els.ovSummaryBtn.addEventListener('click', addSelectedToReport);
  els.ovExportReportBtn.addEventListener('click', exportReportXlsx);
  els.ovClearReportBtn.addEventListener('click', clearReport);
  els.selectAllChk.addEventListener('change', () => {
    const rows = filteredRows().filter((r) => r.sku);
    if (els.selectAllChk.checked) rows.forEach((r) => state.selected.add(r.sku));
    else rows.forEach((r) => state.selected.delete(r.sku));
    renderTable();
  });
  els.pauseBtn.addEventListener('click', () => {
    if (!state.running) return;
    state.paused = !state.paused;
    els.pauseBtn.textContent = state.paused ? '继续' : '暂停';
    logLine(state.paused ? '已暂停' : '继续巡检');
  });
  els.stopBtn.addEventListener('click', () => {
    if (!state.running) return;
    state.stopped = true;
    state.paused = false;
    logLine('已请求停止，当前步骤结束后停止…');
  });
  els.dismissBanner.addEventListener('click', async () => {
    els.riskBanner.classList.add('hidden');
    state.db.dismissedBanner = true;
    await saveDb();
  });
  els.searchInput.addEventListener('input', () => {
    state.filter.search = els.searchInput.value;
    renderTable();
  });
  els.statusFilter.addEventListener('change', () => {
    state.filter.status = els.statusFilter.value;
    renderTable();
  });
  els.exportBtn.addEventListener('click', exportCsv);
  els.exportJsonBtn.addEventListener('click', exportJson);
  els.importBtn.addEventListener('click', () => els.importFile.click());
  els.importFile.addEventListener('change', async () => {
    const file = els.importFile.files && els.importFile.files[0];
    if (file) await importBaseFile(file);
    els.importFile.value = '';
  });
  els.importDataBtn.addEventListener('click', () => els.importDataFile.click());
  els.importDataFile.addEventListener('change', async () => {
    const file = els.importDataFile.files && els.importDataFile.files[0];
    if (file) await importDataFile(file);
    els.importDataFile.value = '';
  });
  els.resetBaseBtn.addEventListener('click', resetBase);
  els.manageBaseBtn.addEventListener('click', openBaseManager);
  els.baseAddRowBtn.addEventListener('click', addBaseRow);
  els.baseAddCatBtn.addEventListener('click', addBaseCategory);
  els.baseRenameCatBtn.addEventListener('click', renameBaseCategory);
  els.baseDelCatBtn.addEventListener('click', deleteBaseCategory);
  els.baseSaveBtn.addEventListener('click', saveBaseManager);
  els.baseExportBtn.addEventListener('click', exportBaseJson);
  els.baseCloseBtn.addEventListener('click', () => els.baseDialog.close());
  els.purgeBtn.addEventListener('click', purgeCaptures);
  els.settingsBtn.addEventListener('click', openSettings);
  els.helpBtn.addEventListener('click', () => {
    if (typeof els.helpDialog.showModal === 'function') els.helpDialog.showModal();
    else els.helpDialog.setAttribute('open', '');
  });
  els.helpClose.addEventListener('click', () => els.helpDialog.close());
  els.copyDebugBtn.addEventListener('click', copyDebugRaw);
  els.settingsSave.addEventListener('click', (e) => {
    e.preventDefault();
    saveSettings().then(() => els.settingsDialog.close());
  });
  els.settingsCancel.addEventListener('click', (e) => {
    e.preventDefault();
    els.settingsDialog.close();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && previewState.winId != null && !previewState.pinned) closePreviewWindow();
  });
  window.addEventListener('beforeunload', (e) => {
    closePreviewWindow();
    if (state.running) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

// ---------------- 自动巡检（外部启动参数） ----------------
async function autoRunBoot() {
  try {
    const identity = URL_PARAMS.get('identity') === 'plus' ? 'plus' : 'util';
    const batch = Math.max(1, Math.min(500, Number(URL_PARAMS.get('batch')) || 5));
    const delayMin = Math.max(1, Math.min(30, Number(URL_PARAMS.get('delayMin')) || 2));
    const delayMax = Math.max(delayMin, Math.min(60, Number(URL_PARAMS.get('delayMax')) || 4));
    state.db.settings = {
      batchSize: batch,
      delayMin: delayMin,
      delayMax: delayMax,
      skipCapturedToday: true,
      scope: 'all',
      keepTab: false
    };
    state.db.autoRun = { at: new Date().toISOString(), identity: identity, batch: batch };
    await saveDb();
    renderRunUI();
    logLine('检测到自动巡检参数：身份=' + identity + '，本次 ' + batch + ' 个，等待 2 秒开始…');
    await sleep(2000);
    await startRun(identity, { auto: true });
  } catch (e) {
    logLine('自动巡检启动失败：' + errText(e));
    try {
      autoExport();
    } catch (e2) {
      logLine('自动导出失败：' + errText(e2));
    }
  }
}

// ---------------- 初始化 ----------------
async function init() {
  await loadDb();
  state.base = await loadBase();
  flattenRows();
  if (state.db.dismissedBanner) els.riskBanner.classList.add('hidden');
  bindEvents();
  setupRuntimeListeners();
  applyTrackIdentity();
  switchView('workbench');
  if (IS_AUTORUN) {
    await autoRunBoot();
  }
}

init().catch((err) => {
  const box = document.createElement('div');
  box.style.cssText = 'margin:20px;padding:16px;border:1px solid #ffccc7;background:#fff1f0;color:#a8071a;border-radius:8px;font-size:13px;line-height:1.7;';
  box.textContent = '工作台初始化失败：' + errText(err) + '\n请到 edge://extensions 重新加载扩展试试。';
  document.body.insertBefore(box, document.body.firstChild);
});




