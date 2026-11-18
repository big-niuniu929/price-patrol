'use strict';

// 电商平台价格巡检工作台 v1.0
// - 读取扩展内置的 SKU 巡检基表（由 tools/build_base_from_xlsx.py 从 SKU巡检表.xlsx 生成）
// - 用户在浏览器登录普惠 / PLUS 账号后，点巡检按钮，后台按节奏逐个打开商品页读取页面价格
// - 结果对照「普惠最低到手价 / 会员最低到手价」阈值，标红预警，可导出 CSV
// - 所有数据只存在本机 chrome.storage.local

// 浏览器识别：同一份代码在 Edge / Chrome 都能用，只是提示文案和扩展页地址不同
const IS_EDGE = /Edg\//.test((navigator && navigator.userAgent) || '');
const BROWSER_NAME = IS_EDGE ? 'Edge' : 'Chrome';
const EXTENSIONS_URL = IS_EDGE ? 'edge://extensions/' : 'chrome://extensions/';

const STORAGE_KEY = 'patrol.db.v2';
// 基表单独存一个 key：采集/设置等高频写入不会碰它，避免任何一次整库覆盖把 SKU 库冲掉
const BASE_KEY = 'patrol.base.v1';
const PRICE_TIMEOUT_MS = 35000;
// 矩阵速采：一个页面从打开到 content.js 上报结果的最大等待时间（比顺序模式宽一点）
const MATRIX_TIMEOUT_MS = 45000;
const MATRIX_MIN_BATCH = 2;
const MATRIX_MAX_BATCH = 12;
// 工作台 ↔ 矩阵大屏（独立窗口）的 BroadcastChannel 名称
const MATRIX_BOARD_CHANNEL = 'patrol-matrix-board-v1';
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
  previewDelayMs: 1000,
  patrolMode: 'foreground',
  aiEnabled: true,
  aiEndpoint: 'https://gateway.example.com/v1',
  aiModel: 'deepseek-flash',
  aiApiKey: '',
  aiVerifyMode: 'fallback',
  officialApiUrl: 'http://127.0.0.1:18765',
  // 矩阵速采（并行开一批页面 → 成排读取 → 批量写入 → 批量关闭）
  matrixBatch: 6,
  matrixGapMs: 300,
  matrixBatchDelay: 1.5,
  matrixShatter: true,
  matrixWindowMode: true,
  // 重采时记住的账号/轨道选择
  rerunIdentity: '',
  rerunForeground: null,
  rerunMode: '',
  rerunMatrix: false,
  rerunRemember: false
};

const DEFAULT_DB = {
  version: 2,
  settings: Object.assign({}, DEFAULT_SETTINGS),
  skuOverrides: {},
  captures: {},
  thumbs: {},
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
  pendingBuffer: null,
  // 矩阵速采：state.matrix = { pending: Map<tabId, slot>, ... }
  matrix: null,
  // 矩阵大屏独立窗口（BroadcastChannel 驱动）
  board: {
    windowId: null,
    tabId: null,
    ready: false,
    readyResolve: null,
    session: '',
    heartbeatTimer: null,
    cards: [],
    phase: '待命',
    sub: '',
    finished: false,
    finalStats: null,
    lastBoardHelloAt: 0
  },
  autoRunMode: false,
  selected: new Set(),
  baseManager: { sheet: '', draft: null },
  compareFilter: 'all',
  compareBusy: false,
  baseUpgraded: null,
  apiStatus: null
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
  viewCompare: $('viewCompare'),
  tabWorkbench: $('tabWorkbench'),
  tabOverview: $('tabOverview'),
  tabCompare: $('tabCompare'),
  tableWrap: $('tableWrap'),
  compareSummary: $('compareSummary'),
  compareList: $('compareList'),
  cmpCollectBtn: $('cmpCollectBtn'),
  cmpFilterAll: $('cmpFilterAll'),
  cmpFilterDiff: $('cmpFilterDiff'),
  cmpFilterMissing: $('cmpFilterMissing'),
  cmpExportBtn: $('cmpExportBtn'),
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
  runMatrixUtilBtn: $('runMatrixUtilBtn'),
  runMatrixPlusBtn: $('runMatrixPlusBtn'),
  multiRerunBtn: $('multiRerunBtn'),
  selectAllChk: $('selectAllChk'),
  pauseBtn: $('pauseBtn'),
  stopBtn: $('stopBtn'),
  runHint: $('runHint'),
  mxOpenBtn: $('mxOpenBtn'),
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
  setDeviationConfirm: $('setDeviationConfirm'),
  setPreviewDelay: $('setPreviewDelay'),
  setPatrolMode: $('setPatrolMode'),
  setMatrixBatch: $('setMatrixBatch'),
  setMatrixGap: $('setMatrixGap'),
  setMatrixDelay: $('setMatrixDelay'),
  setMatrixShatter: $('setMatrixShatter'),
  setMatrixWindowMode: $('setMatrixWindowMode'),
  setAiEnabled: $('setAiEnabled'),
  setAiEndpoint: $('setAiEndpoint'),
  setAiModel: $('setAiModel'),
  setAiKey: $('setAiKey'),
  setAiVerifyMode: $('setAiVerifyMode'),
  setOfficialApiUrl: $('setOfficialApiUrl'),
  aiBtn: $('aiBtn'),
  aiTestBtn: $('aiTestBtn'),
  aiStatusChip: $('aiStatusChip'),
  apiStatusChip: $('apiStatusChip'),
  apiAccountList: $('apiAccountList'),
  apiAddBtn: $('apiAddBtn'),
  apiRefreshBtn: $('apiRefreshBtn'),
  apiAccountInfo: $('apiAccountInfo'),
  runOfficialBtn: $('runOfficialBtn'),
  rerunDialog: $('rerunDialog'),
  rerunHint: $('rerunHint'),
  rerunIdentity: $('rerunIdentity'),
  rerunTrack: $('rerunTrack'),
  rerunRemember: $('rerunRemember'),
  rerunCancel: $('rerunCancel'),
  rerunStart: $('rerunStart'),
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

const KIND_LABEL = { hand: '到手价', main: '电商平台价', plus: 'PLUS价', manual: '手动', official: '官方API', ai: 'AI识别', unknown: '价格' };
const kindLabel = (kind) => KIND_LABEL[kind] || '价格';

// ---------------- 轨道切换 / 轨道标识 ----------------
// 矩阵版：在双轨版两条轨道之外，新增「矩阵③ 阵列速采」——并行开一批页面，成排读取，批量写入。
const TRACK_INFO = {
  track1: { key: 'track1', label: '轨道① · 后台标签页', meta: '后台标签页 · 逐个读取' },
  track2: { key: 'track2', label: '轨道② · 前台窗口+AI复核', meta: '前台窗口 · AI 复核（截图不保存）' },
  matrix: { key: 'matrix', label: '矩阵③ · 阵列速采', meta: '批量开页 · 成排读取 · 批量写入' }
};

function currentTrackKey() {
  const mode = state.db && state.db.settings ? state.db.settings.patrolMode : '';
  if (mode === 'background') return 'track1';
  if (mode === 'matrix') return 'matrix';
  return 'track2';
}

function applyTrackSelectionUI() {
  const key = currentTrackKey();
  const info = TRACK_INFO[key];
  document.body.classList.toggle('track1', key === 'track1');
  document.body.classList.toggle('track2', key === 'track2');
  document.body.classList.toggle('matrix', key === 'matrix');
  document.title = '【矩阵版 · ' + (key === 'track1' ? '轨道①' : key === 'track2' ? '轨道②' : '矩阵③') + '】电商平台价格巡检工作台';
  const badge = document.getElementById('trackBadge');
  if (badge) {
    badge.textContent = '矩阵版 · ' + info.label;
    badge.classList.toggle('track1', key === 'track1');
    badge.classList.toggle('track2', key === 'track2');
    badge.classList.toggle('matrix', key === 'matrix');
  }
  const meta = document.getElementById('trackMeta');
  if (meta) meta.textContent = info.meta;
  const tip = document.getElementById('trackInfo');
  if (tip) {
    tip.textContent = '当前使用： 矩阵版 · ' + info.label + '\n扩展ID： ' + chrome.runtime.id + '\n扩展目录： ' + '巡检插件-矩阵版\\extension';
  }
  document.querySelectorAll('.trackOpt').forEach((btn) => btn.classList.toggle('active', btn.dataset.track === key));
  if (els.setPatrolMode) {
    els.setPatrolMode.value = key === 'track1' ? 'background' : key === 'matrix' ? 'matrix' : 'foreground';
  }
}

async function setTrack(key, opts) {
  if (state.running) {
    setToast('巡检进行中，先停止再切换轨道');
    return;
  }
  const mode = key === 'track1' ? 'background' : key === 'matrix' ? 'matrix' : 'foreground';
  if (state.db.settings.patrolMode === mode) return;
  state.db.settings.patrolMode = mode;
  await saveDb();
  applyTrackSelectionUI();
  renderRunUI();
  if (!(opts && opts.silent)) {
    setToast('已切换到 ' + (key === 'track1' ? '轨道①（后台标签页）' : key === 'matrix' ? '矩阵③（阵列速采）' : '轨道②（前台窗口 + AI 复核）'));
  }
  logLine('切换采集轨道：' + TRACK_INFO[key].label);
}

function applyTrackIdentity() {
  if (!state.db.settings.patrolMode) state.db.settings.patrolMode = 'foreground';
  applyTrackSelectionUI();
  updateAiStatusChip();
  updateApiStatusChip();
}

// ---------------- 存储 ----------------
async function loadDb() {
  let stored = {};
  let baseFromKey = null;
  try {
    const got = await chrome.storage.local.get([STORAGE_KEY, BASE_KEY]);
    stored = (got && got[STORAGE_KEY]) || {};
    baseFromKey = (got && got[BASE_KEY]) || null;
  } catch (e) {
    stored = {};
  }
  state.db = {
    version: 2,
    settings: Object.assign({}, DEFAULT_SETTINGS, stored.settings || {}),
    skuOverrides: stored.skuOverrides || {},
    captures: stored.captures || {},
    thumbs: stored.thumbs || {},
    reportRows: Array.isArray(stored.reportRows) ? stored.reportRows : [],
    offlineRows: Array.isArray(stored.offlineRows) ? stored.offlineRows : [],
    offlineSkus: Array.isArray(stored.offlineSkus) ? stored.offlineSkus : [],
    // 独立 key 优先；旧版本只存在 db 里的，读出来并迁移到独立 key
    baseOverride: baseFromKey || stored.baseOverride || null,
    lastRun: stored.lastRun || null,
    lastAccount: stored.lastAccount || '',
    lastIdentity: stored.lastIdentity || 'util',
    lastSavedAt: stored.lastSavedAt || null,
    dismissedBanner: !!stored.dismissedBanner
  };
  if (!baseFromKey && stored.baseOverride) {
    try {
      await chrome.storage.local.set({ [BASE_KEY]: stored.baseOverride });
    } catch (e) {
      // 迁移失败不影响本次使用
    }
  }
  // v2.0 起不再保存采集截图：把旧版本留下的缩略图丢掉，腾出存储空间
  // （截图只在 AI 复核时于内存中临时生成，用完即弃）
  state.db.thumbs = {};
  // 打包的「完整版」会带 data/preset-settings.json：首次安装（本地还没有设置）时预置偏好；
  // 已经有本地设置就不覆盖，避免每次启动把用户改过的设置冲掉。
  if (!stored.settings) {
    try {
      const presetRes = await fetch(chrome.runtime.getURL('data/preset-settings.json'), { cache: 'no-store' });
      if (presetRes.ok) {
        const preset = await presetRes.json();
        if (preset && typeof preset === 'object') {
          const p = Object.assign({}, preset);
          delete p.aiApiKey; // 密钥仍由 data/ai-config.json 提供
          state.db.settings = Object.assign({}, state.db.settings, p);
        }
      }
    } catch (e) {
      // 没有预置文件不影响使用
    }
  }
  // 预配置的 AI 参数（data/ai-config.json）自动生效，不用每次手填
  try {
    const cfgRes = await fetch(chrome.runtime.getURL('data/ai-config.json'), { cache: 'no-store' });
    if (cfgRes.ok) {
      const cfg = await cfgRes.json();
      if (!state.db.settings.aiApiKey && cfg.apiKey) state.db.settings.aiApiKey = cfg.apiKey;
      if (!state.db.settings.aiEndpoint && cfg.endpoint) state.db.settings.aiEndpoint = cfg.endpoint;
      if (!state.db.settings.aiModel && cfg.model) state.db.settings.aiModel = cfg.model;
      if (state.db.settings.aiEnabled == null && cfg.enabled != null) state.db.settings.aiEnabled = !!cfg.enabled;
      if (!state.db.settings.aiVerifyMode && cfg.verifyMode) state.db.settings.aiVerifyMode = cfg.verifyMode;
    }
  } catch (e) {
    // 没有配置文件也不影响使用
  }
}

async function saveDb() {
  state.db.lastSavedAt = new Date().toISOString();
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: state.db });
  } catch (e) {
    setToast('保存失败：' + errText(e));
  }
}

// 基表单独写：只有「导入基表 / 管理基表保存 / 恢复内置 / 导入数据」会调用它。
// 这样即使别的标签页用旧内存状态整库覆盖了 patrol.db.v2，SKU 库也不会丢。
function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

async function saveBaseOverride(base) {
  state.db.baseOverride = base || null;
  try {
    await chrome.storage.local.set({ [BASE_KEY]: base || null });
    // 写完立刻读回校验，确认确实落到本机（避免"以为保存了其实没写进去"）
    // 注意：chrome.storage 读回来的对象键顺序可能和写入时不同，所以用稳定序列化比较
    const check = await chrome.storage.local.get(BASE_KEY);
    const wrote = check && check[BASE_KEY] ? check[BASE_KEY] : null;
    if (stableStringify(wrote) !== stableStringify(base || null)) {
      throw new Error('写入校验不一致');
    }
  } catch (e) {
    setToast('基表保存失败：' + errText(e));
    throw e;
  }
  await saveDb();
}

// ---------------- 基表 ----------------
function baseTime(base) {
  const t = Date.parse((base && base.generatedAt) || '');
  return isFinite(t) ? t : 0;
}

async function loadBase() {
  const url = chrome.runtime.getURL('data/base-skus.json');
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error('读取内置基表失败：HTTP ' + res.status);
  const builtin = await res.json();
  const stored = state.db.baseOverride;
  if (!stored || !Array.isArray(stored.sheets)) return builtin;
  // 插件自带的基表比本地保存的更新 → 自动升级（下架/手动改价按行号/SKU 保留，不会丢）
  if (baseTime(builtin) > baseTime(stored)) {
    state.baseUpgraded = {
      from: stored.generatedAt || '',
      to: builtin.generatedAt || '',
      source: builtin.source || ''
    };
    await saveBaseOverride(builtin);
    return builtin;
  }
  return stored;
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
  // 已下架的行不进「已采集 / 进度 / 待补」的分母，否则跑完会员价还会显示 134/146
  const activeRows = sourceRows.filter((r) => !isOffline(r));
  const withSku = activeRows.filter((r) => r.sku);
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
  let manual = 0;
  for (const row of sourceRows) {
    const st = statusOf(row);
    counts[st.key] = (counts[st.key] || 0) + 1;
    if (!row.sku || isOffline(row)) continue;
    const cap = state.db.captures[row.sku];
    if (cap && cap.util && cap.util.price != null && row.utilMin != null && cap.util.price < row.utilMin - 0.001) belowUtil++;
    if (cap && cap.plus && cap.plus.price != null && row.plusMin != null && cap.plus.price < row.plusMin - 0.001) belowPlus++;
    if (cap && ((cap.util && cap.util.offThreshold) || (cap.plus && cap.plus.offThreshold))) {
      offThreshold++;
      if (hasUnconfirmedDeviation(cap)) needsConfirm++;
    }
    if (cap && ((cap.util && cap.util.kind === 'manual') || (cap.plus && cap.plus.kind === 'manual'))) manual++;
  }
  return {
    total: sourceRows.length,
    activeTotal: activeRows.length,
    withSku: withSku.length,
    uniqSku: uniq.length,
    missingSku: activeRows.length - withSku.length,
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
    manual,
    offline: offlineCount
  };
}

// ---------------- 渲染 ----------------
function renderStats() {
  const st = computeStats();
  const chips = [
    { k: '有效行数', v: st.activeTotal + ' 行', cls: '' },
    { k: '有 SKU', v: st.withSku + ' 行', cls: '' },
    { k: '去重 SKU', v: st.uniqSku + ' 个', cls: '' },
    { k: '普惠已采集', v: st.utilDone + ' / ' + st.uniqSku, cls: 'ok' },
    { k: '会员已采集', v: st.plusDone + ' / ' + st.uniqSku, cls: 'plusStat' },
    { k: '低于阈值', v: String(st.alert), cls: st.alert ? 'alert' : '' },
    { k: '采集失败', v: String(st.fail), cls: '' },
    { k: '待补 SKU', v: String(st.missingSku), cls: '' }
  ];
  if (st.offline) chips.push({ k: '已下架', v: st.offline + ' 行', cls: '' });
  if (st.manual) chips.push({ k: '手动改价', v: String(st.manual), cls: '' });
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
      if (status === 'manual') {
        const cap = state.db.captures[row.sku] || null;
        if (!(cap && ((cap.util && cap.util.kind === 'manual') || (cap.plus && cap.plus.kind === 'manual')))) return false;
      }
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
      case 'manual':
        return !!(cap && ((cap.util && cap.util.kind === 'manual') || (cap.plus && cap.plus.kind === 'manual')));
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
  manual: '手动改价',
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
  meta.textContent = kindLabel(info.kind) + (info.source ? ' · ' + info.source : '') + ' · ' + fmtTime(info.at);
  if (info.source) meta.title = '价格来源：' + info.source;
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
    const tip =
      '页面读数 ' + fmtMoney(info.price) + '，阈值 ' + fmtMoney(info.offThreshold.threshold) +
      '，相差超过 ¥' + fmtNum(info.offThreshold.limit || deviationLimitValue()) + '（只提示，不修改读数）';
    if (info.offThreshold.needsConfirm && !info.offThreshold.confirmed) {
      const warn = document.createElement('div');
      warn.className = 'priceWarn urgent';
      warn.textContent = '⚠ 偏离阈值·待确认';
      warn.title = tip + '；差价超过 ¥' + fmtNum(info.offThreshold.confirmLimit || deviationConfirmLimitValue()) + '，请核对页面价格；无误请点「确认」';
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
      warn.textContent = '⚠ 偏离阈值';
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
    again.title = '重新采集这一条（可临时选账号和轨道）';
    again.addEventListener('click', () => {
      if (state.running) {
        setToast('已有巡检在进行中');
        return;
      }
      const rowCap = state.db.captures[row.sku] || null;
      const manualPlus = !!(rowCap && rowCap.plus && rowCap.plus.kind === 'manual');
      const manualUtil = !!(rowCap && rowCap.util && rowCap.util.kind === 'manual');
      const prefill = manualPlus && !manualUtil ? 'plus' : (manualUtil && !manualPlus ? 'util' : undefined);
      openRerunDialog({
        identity: prefill,
        hint: '重采 1 个 SKU：' + row.sku + '\n请选择用哪个账号、哪条轨道采集。'
      }).then((choice) => {
        if (!choice) return;
        startRerun({ singleSku: row.sku }, choice).catch(() => {});
      });
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
    const st = computeStats(state.ovFilter.sheet);
    const hidden = state.ovFilter.key === 'offline' ? 0 : st.offline;
    els.tableCaption.appendChild(document.createTextNode(' 行' + (hidden ? '（另有 ' + hidden + ' 行已下架，已隐藏）' : '')));
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
  { key: 'all', label: '全部行', sub: (st) => (st.offline ? '基表 ' + st.total + ' 行 · 已下架 ' + st.offline : '基表行数'), cls: '', value: (st) => st.activeTotal + ' 行' },
  { key: 'utilDone', label: '普惠已采集', sub: '普惠当前价格有值', cls: 'good', value: (st) => st.utilDone + ' / ' + st.uniqSku },
  { key: 'plusDone', label: '会员已采集', sub: '会员当前价格有值', cls: 'plusStat', value: (st) => st.plusDone + ' / ' + st.uniqSku },
  { key: 'alert', label: '低于阈值', sub: '需要重点看', cls: 'warn', value: (st) => String(st.alert) },
  { key: 'normal', label: '高于/等于阈值', sub: '两价已采且不破价', cls: 'good', value: (st) => String(st.ok) },
  { key: 'off', label: '偏离阈值', sub: '差价>500，仅提示', cls: 'warn', value: (st) => String(st.offThreshold) },
  { key: 'confirm', label: '需人工确认', sub: '已选值，点确认转正常', cls: 'warn', value: (st) => String(st.needsConfirm) },
  { key: 'manual', label: '手动改价', sub: '人工录入，点此查看/重采', cls: 'warn', value: (st) => String(st.manual) },
  { key: 'fail', label: '采集失败', sub: '可重采或手动改', cls: 'warn', value: (st) => String(st.fail) },
  { key: 'none', label: '未采集', sub: '还没跑过', cls: '', value: (st) => String(st.none) },
  { key: 'nosku', label: '待补 SKU', sub: '表格里可直接补', cls: '', value: (st) => String(st.missingSku) },
  { key: 'offline', label: '已下架', sub: '已移入下架库，可恢复', cls: '', value: (st) => st.offline + ' 行' }
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
    s.textContent = typeof card.sub === 'function' ? card.sub(st) : card.sub;
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
  if (state.db.baseOverride) {
    const src = state.db.baseOverride.source || '导入';
    text += '｜当前使用：' + src + '的基表';
    if (state.db.baseOverride.generatedAt) text += '（保存于 ' + fmtTime(state.db.baseOverride.generatedAt) + '）';
  } else {
    text += '｜当前使用：内置基表';
  }
  els.baseInfo.textContent = text;
}

function renderRunUI() {
  const running = state.running;
  els.runUtilBtn.disabled = running;
  els.runPlusBtn.disabled = running;
  if (els.runMatrixUtilBtn) els.runMatrixUtilBtn.disabled = running;
  if (els.runMatrixPlusBtn) els.runMatrixPlusBtn.disabled = running;
  els.pauseBtn.disabled = !running;
  els.stopBtn.disabled = !running;
  els.pauseBtn.textContent = state.paused ? '继续' : '暂停';
  if (running) {
    if (state.run && state.run.matrix) {
      const m = (state.run && state.run.matrixState) || {};
      els.runHint.textContent = '矩阵速采进行中：第 ' + ((m.batchIndex || 0) + 1) + '/' + (m.batchCount || 1) +
        ' 批 · 每批 ' + (m.batchSize || matrixBatchSize()) + ' 个' + (state.run.matrixWindows ? '商品窗口' : '页面') +
        '并行读取，整批读完后批量写入并关闭（可暂停/停止）';
    } else {
      els.runHint.textContent = '巡检进行中：后台标签页会逐个打开商品页，请保持本页面打开（可暂停/停止）';
    }
  } else {
    const s = state.db.settings;
    if (currentTrackKey() === 'matrix') {
      if (matrixUseWindows()) {
        els.runHint.textContent = '矩阵③ 真实多窗口 · 每批 ' + matrixBatchSize() + ' 个 · 窗口沿弧线排开 · 开页错开 ' +
          matrixGapMs() + 'ms · 批次间隔 ' + (matrixBatchDelayMs() / 1000) + ' 秒';
      } else {
        els.runHint.textContent = '矩阵③ 后台标签页 + 大屏 · 每批 ' + matrixBatchSize() + ' 个 · 开页错开 ' + matrixGapMs() +
          'ms · 批次间隔 ' + (matrixBatchDelayMs() / 1000) + ' 秒';
      }
    } else {
      els.runHint.textContent = '每批 ' + (Number(s.batchSize) > 0 ? Number(s.batchSize) + ' 个' : '全部') +
        ' · 间隔 ' + s.delayMin + '–' + s.delayMax + ' 秒 · 开始前请先登录对应账号';
    }
  }
  const hasLog = els.logPanel.textContent.trim().length > 0;
  els.progressWrap.classList.toggle('hidden', !running && !state.run && !hasLog);
  updateSelectionUI();
}

// ---------------- 同品比价（跨店铺同型号不同 SKU） ----------------
// 3C店铺 / 大家电 里同一款产品会用不同 SKU 上架，这里按「套餐型号」自动配对，
// 忽略空格、-京仓、大小写等写法差异，再对比两个店铺采集到的到手价。
function compareKeyOf(row) {
  return String(row.model || '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[-－—_/／]+/g, '')
    .replace(/京仓/g, '')
    .toUpperCase();
}

function compareEntries() {
  const map = new Map();
  for (const row of state.rows) {
    if (!row.sku || isOffline(row)) continue;
    const key = compareKeyOf(row);
    if (!key) continue;
    if (!map.has(key)) map.set(key, { key: key, model: row.model, entries: [] });
    const cap = capOf(row) || {};
    map.get(key).entries.push({
      row: row,
      sheet: row.sheet,
      util: cap.util && cap.util.price != null ? cap.util : null,
      plus: cap.plus && cap.plus.price != null ? cap.plus : null
    });
  }
  const groups = [];
  for (const g of map.values()) {
    const sheets = new Set(g.entries.map((e) => e.sheet));
    if (sheets.size < 2) continue; // 只保留跨店铺的同款
    const spread = (field) => {
      const list = g.entries.filter((e) => e[field] != null);
      if (list.length < 2) return null;
      let min = list[0];
      let max = list[0];
      for (const e of list) {
        if (e[field].price < min[field].price) min = e;
        if (e[field].price > max[field].price) max = e;
      }
      const diff = max[field].price - min[field].price;
      return { diff: diff, has: diff > 0.005, min: min, max: max, minPrice: min[field].price, maxPrice: max[field].price };
    };
    const utilSpread = spread('util');
    const plusSpread = spread('plus');
    const missing = g.entries.some((e) => e.util == null || e.plus == null);
    const hasDiff = !!(utilSpread && utilSpread.has) || !!(plusSpread && plusSpread.has);
    groups.push({
      model: g.model,
      key: g.key,
      entries: g.entries,
      utilSpread: utilSpread,
      plusSpread: plusSpread,
      missing: missing,
      hasDiff: hasDiff
    });
  }
  groups.sort((a, b) => {
    const sa = (a.hasDiff ? 2 : 0) + (a.missing ? 1 : 0);
    const sb = (b.hasDiff ? 2 : 0) + (b.missing ? 1 : 0);
    if (sb !== sa) return sb - sa;
    return String(a.model || '').localeCompare(String(b.model || ''));
  });
  return groups;
}

function compareSkuList() {
  const groups = compareEntries();
  const skus = [];
  const seen = new Set();
  for (const g of groups) {
    for (const e of g.entries) {
      const sku = e.row && e.row.sku;
      if (!sku || seen.has(sku)) continue;
      seen.add(sku);
      skus.push(sku);
    }
  }
  return { groups: groups.length, skus: skus };
}

function compareBadge(label, spread) {
  const span = document.createElement('span');
  if (!spread) {
    span.className = 'cmpBadge muted';
    span.textContent = label + ' 待采齐';
  } else if (spread.has) {
    span.className = 'cmpBadge diff';
    span.textContent = label + '差 ' + fmtMoney(spread.diff) + '（' + spread.max.sheet + ' 高 / ' + spread.min.sheet + ' 低）';
    span.title = spread.max.sheet + '：' + fmtMoney(spread.maxPrice) + '\n' + spread.min.sheet + '：' + fmtMoney(spread.minPrice);
  } else {
    span.className = 'cmpBadge ok';
    span.textContent = label + ' 一致';
  }
  return span;
}

function comparePriceCell(info) {
  const td = document.createElement('td');
  td.className = 'money';
  if (!info) {
    td.classList.add('cmpMissing');
    td.textContent = '—';
    return td;
  }
  td.textContent = fmtMoney(info.price);
  if (info.kind) {
    const k = document.createElement('div');
    k.className = 'cmpKind';
    k.textContent = kindLabel(info.kind);
    td.appendChild(k);
  }
  return td;
}

function buildCompareRow(entry) {
  const row = entry.row;
  const tr = document.createElement('tr');
  const tdSheet = document.createElement('td');
  tdSheet.textContent = row.sheet;
  tr.appendChild(tdSheet);
  const tdExcel = document.createElement('td');
  tdExcel.textContent = row.excelRow != null ? String(row.excelRow) : '';
  tr.appendChild(tdExcel);
  const tdSku = document.createElement('td');
  tdSku.textContent = row.sku;
  tr.appendChild(tdSku);
  tr.appendChild(comparePriceCell(entry.util));
  tr.appendChild(comparePriceCell(entry.plus));
  const tdStatus = document.createElement('td');
  const st = statusOf(row);
  const badge = document.createElement('span');
  badge.className = 'badge ' + st.key;
  badge.textContent = st.text;
  tdStatus.appendChild(badge);
  tr.appendChild(tdStatus);
  const tdOp = document.createElement('td');
  const op = document.createElement('div');
  op.className = 'opCell';
  const openBtn = document.createElement('a');
  openBtn.className = 'opBtn';
  openBtn.textContent = '打开';
  openBtn.target = '_blank';
  openBtn.rel = 'noreferrer';
  openBtn.href = ITEM_URL(row.sku);
  op.appendChild(openBtn);
  const rerunBtn = document.createElement('button');
  rerunBtn.type = 'button';
  rerunBtn.className = 'opBtn';
  rerunBtn.textContent = '重采';
  rerunBtn.title = '重采这一条（可临时选账号和轨道）';
  rerunBtn.addEventListener('click', () => {
    if (state.running) {
      setToast('已有巡检在进行中');
      return;
    }
    openRerunDialog({
      hint: '重采 1 个 SKU：' + row.sku + '\n请选择用哪个账号、哪条轨道采集。'
    }).then((choice) => {
      if (!choice) return;
      startRerun({ singleSku: row.sku }, choice).catch(() => {});
    });
  });
  op.appendChild(rerunBtn);
  tdOp.appendChild(op);
  tr.appendChild(tdOp);
  return tr;
}

function compareDisplayModel(model) {
  return String(model || '').replace(/[-－]?\s*京仓\s*$/i, '').trim() || String(model || '');
}

function buildCompareGroup(group) {
  // 返回一个 <tbody>：组头一行 + 每个店铺一行，外层只有一个总表，避免每组建一个表格导致渲染卡顿
  const tbody = document.createElement('tbody');
  tbody.className = 'cmpGroup' + (group.hasDiff ? ' hasDiff' : '');

  const headRow = document.createElement('tr');
  headRow.className = 'cmpGroupHeadRow';
  const headCell = document.createElement('td');
  headCell.colSpan = 7;
  const model = document.createElement('span');
  model.className = 'cmpModel';
  model.textContent = compareDisplayModel(group.model) || group.key;
  model.title = '匹配键：' + group.key;
  headCell.appendChild(model);
  headCell.appendChild(compareBadge('普惠', group.utilSpread));
  headCell.appendChild(compareBadge('会员', group.plusSpread));
  if (group.missing) {
    const m = document.createElement('span');
    m.className = 'cmpBadge muted';
    m.textContent = '有店铺未采齐';
    headCell.appendChild(m);
  }
  headRow.appendChild(headCell);
  tbody.appendChild(headRow);

  const order = ['3C店铺', '大家电', '品牌A', '音视频店'];
  const entries = group.entries.slice().sort((a, b) => {
    const ia = order.indexOf(a.sheet);
    const ib = order.indexOf(b.sheet);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || (a.row.excelRow || 0) - (b.row.excelRow || 0);
  });
  for (const e of entries) tbody.appendChild(buildCompareRow(e));
  return tbody;
}

function renderCompare() {
  if (!els.compareList) return;
  if (state.compareBusy) return;
  state.compareBusy = true;
  try {
    const groups = compareEntries();
    let skuCount = 0;
    const skuSeen = new Set();
    for (const g of groups) for (const e of g.entries) if (e.row && e.row.sku && !skuSeen.has(e.row.sku)) { skuSeen.add(e.row.sku); skuCount++; }
    const diffCount = groups.filter((g) => g.hasDiff).length;
    const missCount = groups.filter((g) => g.missing).length;
    const okCount = groups.filter((g) => !g.hasDiff && !g.missing).length;
    const storeNames = [...new Set(groups.flatMap((g) => g.entries.map((e) => e.sheet)))];
    if (els.compareSummary) {
      els.compareSummary.textContent =
        '同款分组 ' + groups.length + ' 组（' + (storeNames.join(' / ') || '无') + '）｜共 ' + skuCount + ' 个 SKU｜有差异 ' + diffCount +
        ' 组｜一致 ' + okCount + ' 组｜待采齐 ' + missCount + ' 组';
    }
    const btnOn = (el, on) => { if (el) el.classList.toggle('active', !!on); };
    btnOn(els.cmpFilterAll, state.compareFilter === 'all');
    btnOn(els.cmpFilterDiff, state.compareFilter === 'diff');
    btnOn(els.cmpFilterMissing, state.compareFilter === 'missing');
    if (els.cmpCollectBtn) {
      els.cmpCollectBtn.disabled = !!state.running || !groups.length;
      els.cmpCollectBtn.title = state.running
        ? '巡检进行中，先停止/等待完成再采集'
        : '把当前比价的全部 SKU（两个店铺都算）按同一账号、同一轨道采集一遍';
    }

    const list = groups.filter((g) => {
      if (state.compareFilter === 'diff') return g.hasDiff;
      if (state.compareFilter === 'missing') return g.missing;
      return true;
    });
    els.compareList.textContent = '';
    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'cmpEmpty';
      empty.textContent = groups.length
        ? '当前筛选没有符合条件的同款分组，点「全部」看看。'
        : '还没有跨店铺的同款产品：需要同一「套餐型号」在 2 个店铺里都有 SKU（且未下架）。';
      els.compareList.appendChild(empty);
      return;
    }
    // 只用一个总表放所有分组（避免几十个嵌套表格把页面拖卡）
    const table = document.createElement('table');
    table.className = 'cmpTable';
    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    for (const label of ['店铺', '行', 'SKU', '普惠当前价', '会员当前价', '状态', '操作']) {
      const th = document.createElement('th');
      th.textContent = label;
      hr.appendChild(th);
    }
    thead.appendChild(hr);
    table.appendChild(thead);
    const maxRender = 400;
    for (const g of list.slice(0, maxRender)) table.appendChild(buildCompareGroup(g));
    els.compareList.appendChild(table);
    if (list.length > maxRender) {
      const more = document.createElement('div');
      more.className = 'cmpEmpty';
      more.textContent = '还有 ' + (list.length - maxRender) + ' 组未显示（可用「导出比价 CSV」查看全部）。';
      els.compareList.appendChild(more);
    }
  } catch (e) {
    try {
      els.compareList.textContent = '';
      const err = document.createElement('div');
      err.className = 'cmpEmpty';
      err.textContent = '同品比价渲染失败：' + ((e && e.message) || e) + '\n按 F12 打开控制台，把红色报错发我。';
      els.compareList.appendChild(err);
      console.error('renderCompare failed', e);
    } catch (e2) {
      // 忽略
    }
  } finally {
    state.compareBusy = false;
  }
}

function exportCompareCsv() {
  const groups = compareEntries();
  if (!groups.length) {
    setToast('还没有可导出的同款分组');
    return;
  }
  const header = ['型号', '匹配键', '店铺', 'Excel行', 'SKU', '套餐', '普惠当前价', '普惠类型', '会员当前价', '会员类型', '普惠价差', '会员价差', '状态'];
  const lines = [header.map(csvCell).join(',')];
  for (const g of groups) {
    const utilDiff = g.utilSpread && g.utilSpread.has ? g.utilSpread.diff : '';
    const plusDiff = g.plusSpread && g.plusSpread.has ? g.plusSpread.diff : '';
    for (const e of g.entries) {
      lines.push([
        compareDisplayModel(g.model) || '', g.key, e.sheet, e.row.excelRow, e.row.sku, e.row.package || '',
        e.util ? e.util.price : '', e.util ? kindLabel(e.util.kind) : '',
        e.plus ? e.plus.price : '', e.plus ? kindLabel(e.plus.kind) : '',
        utilDiff, plusDiff, statusOf(e.row).text
      ].map(csvCell).join(','));
    }
  }
  downloadText('\ufeff' + lines.join('\r\n'), 'text/csv;charset=utf-8', '同品比价-' + todayStamp() + '.csv');
  setToast('已导出同品比价 CSV');
}

function renderAll() {
  renderStats();
  renderAccountInfo();
  renderBaseInfo();
  renderRunUI();
  renderReportArea();
  if (state.view === 'compare') {
    renderCompare();
  } else if (state.view === 'overview') {
    renderOverview();
  } else {
    renderTabs();
  }
  if (state.view !== 'compare') renderTable();
}

function switchView(view) {
  const next = view === 'overview' ? 'overview' : view === 'compare' ? 'compare' : 'workbench';
  if (state.view === next) return;
  state.view = next;
  els.tabWorkbench.classList.toggle('active', next === 'workbench');
  els.tabOverview.classList.toggle('active', next === 'overview');
  if (els.tabCompare) els.tabCompare.classList.toggle('active', next === 'compare');
  els.viewWorkbench.classList.toggle('hidden', next !== 'workbench');
  els.viewOverview.classList.toggle('hidden', next !== 'overview');
  if (els.viewCompare) els.viewCompare.classList.toggle('hidden', next !== 'compare');
  if (els.tableWrap) els.tableWrap.classList.toggle('hidden', next === 'compare');
  els.viewHint.textContent =
    next === 'overview'
      ? '点数字可筛选查看；勾选行后点「汇总选中」加入待上报区'
      : next === 'compare'
        ? '按套餐型号匹配不同店铺的同款产品，对比当前到手价'
        : '巡检时保持本页打开；矩阵速采会在下方阵列里并行开页、成排读取';
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
      flags: result.flags || null,
      source: result.source || '',
      priceChanges: result.priceChanges && result.priceChanges.length ? result.priceChanges : null
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
    // 第二轨道：窗口/页面可能先于监听器把结果送达，这里补一次缓冲结果
    const buffered = state.pendingBuffer;
    if (
      buffered &&
      buffered.msg &&
      buffered.msg.sku === sku &&
      Date.now() - buffered.at < 15000 &&
      state.run &&
      buffered.tabId === state.run.runnerTabId
    ) {
      const msg = buffered.msg;
      state.pendingBuffer = null;
      const p = state.pending;
      state.pending = null;
      clearTimeout(timer);
      p.resolve(msg);
      return;
    }
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

// ---------------- 第二轨道：前台窗口 / 截图 / AI / 官方API ----------------
function isForegroundRun(opts) {
  // 显式传了 true/false 就按传入的轨道来（重采时可以临时指定轨道）
  if (opts && typeof opts.foreground === 'boolean') return opts.foreground;
  return state.db && state.db.settings && state.db.settings.patrolMode === 'foreground';
}

async function closeRunnerWindow(run) {
  if (!run || run.runnerWindowId == null) return;
  try {
    await chrome.windows.remove(run.runnerWindowId);
  } catch (e) {
    // 已关闭
  }
  run.runnerWindowId = null;
  run.runnerTabId = null;
}

async function foregroundEnsureWindow(run, task) {
  if (run.runnerWindowId != null && run.runnerTabId != null) {
    try {
      state.pendingBuffer = null;
      await chrome.tabs.update(run.runnerTabId, { url: task.url });
      return;
    } catch (e) {
      await closeRunnerWindow(run);
    }
  }
  const sw = (window.screen && screen.availWidth) || 1400;
  const sh = (window.screen && screen.availHeight) || 900;
  const width = Math.round(Math.min(1180, Math.max(900, sw * 0.62)));
  const height = Math.round(Math.min(880, Math.max(620, sh * 0.8)));
  const left = Math.max(10, Math.round((sw - width) / 2));
  const top = Math.max(10, Math.round((sh - height) / 2));
  state.pendingBuffer = null;
  const win = await chrome.windows.create({
    url: task.url,
    type: 'popup',
    focused: true,
    width: width,
    height: height,
    left: left,
    top: top
  });
  if (!win || win.id == null) throw new Error('未能创建前台窗口');
  run.runnerWindowId = win.id;
  const tab = win.tabs && win.tabs[0] ? win.tabs[0] : null;
  run.runnerTabId = tab ? tab.id : null;
}

async function foregroundCapture(run, task) {
  await foregroundEnsureWindow(run, task);
  let result;
  try {
    result = await waitForResult(task.sku, PRICE_TIMEOUT_MS);
  } catch (e) {
    result = { ok: false, reason: '等待价格超时：' + errText(e) };
  }
  let shot = null;
  if (run.runnerWindowId != null) {
    try {
      shot = await chrome.tabs.captureVisibleTab(run.runnerWindowId, { format: 'png' });
    } catch (e) {
      logLine('  截图失败：' + errText(e));
    }
  }
  return { result: result, shot: shot };
}

const AI_PROMPT = '图片是电商平台商品页的价格区域。只输出一个 JSON 对象，不要解释、不要输出思考过程：' +
  '{"page_state":"product|login|verify|home|offline|other","hand_price":数字或null,"jd_price":数字或null,"plus_price":数字或null}。' +
  'hand_price 取大号红字的「到手价」；jd_price 取旁边小号或带删除线的「电商平台价」；plus_price 取「PLUS会员价」。' +
  '不要把优惠、分期、满减、评分、评价数当成价格；只输出第一个 JSON，不要代码块。';

function aiNum(v) {
  const n = Number(v);
  return isFinite(n) && n > 0 ? n : null;
}

async function aiExtractPrice(dataUrl) {
  const s = state.db.settings;
  if (!s.aiEnabled) return null;
  const endpoint = String(s.aiEndpoint || '').replace(/\/+$/, '');
  const key = String(s.aiApiKey || '').trim();
  if (!endpoint || !key) return null;
  // deepseek-flash 是推理模型：max_tokens 太小会把预算全花在 reasoning 上、content 返回空。
  // 这里给足预算，并在返回空内容时自动加大再试一次。
  const budgets = [2000, 4000];
  let lastErr = null;
  for (const budget of budgets) {
    const body = {
      model: s.aiModel || 'deepseek-flash',
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
    const text = (choice.message && choice.message.content) || '';
    if (!text.trim()) {
      lastErr = new Error('AI 返回空内容（finish=' + (choice.finish_reason || '?') + '，token 预算 ' + budget + '）');
      continue;
    }
    const match = text.match(/\{[\s\S]*\}/);
    let parsed = {};
    if (match) {
      try {
        parsed = JSON.parse(match[0]);
      } catch (e) {
        parsed = {};
      }
    }
    return {
      page_state: String(parsed.page_state || 'other'),
      hand_price: aiNum(parsed.hand_price),
      jd_price: aiNum(parsed.jd_price),
      plus_price: aiNum(parsed.plus_price),
      tokens: budget,
      raw: String(text || '')
    };
  }
  if (lastErr) throw lastErr;
  return null;
}

function aiPlausiblePrice(price, frontPrice) {
  if (price == null) return false;
  const p = Number(price);
  if (!isFinite(p) || p < 30) return false;
  if (frontPrice && frontPrice > 0 && p > frontPrice * 1.05) return false;
  return true;
}

async function analyzeShot(task, identity, result, shot) {
  const s = state.db.settings;
  if (!s.aiEnabled || s.aiVerifyMode === 'off') return null;
  const domPick = result && result.ok ? pickPrice(identity, result, task.frontPrice) : null;
  const needAi = s.aiVerifyMode === 'all' || !domPick;
  if (!needAi) return null;
  // 截图绝不落盘：只在内存里裁剪 → 调 AI → 用完丢弃
  const img = await cropShot(shot, result && result.rect, result && result.viewport);
  let ai = null;
  try {
    ai = await aiExtractPrice(img);
  } catch (e) {
    return { info: { at: new Date().toISOString(), model: s.aiModel || '', error: errText(e) }, pick: null };
  }
  if (!ai) return null;
  const info = {
    at: new Date().toISOString(),
    model: s.aiModel || '',
    page_state: ai.page_state,
    hand_price: ai.hand_price,
    jd_price: ai.jd_price,
    plus_price: ai.plus_price,
    raw: String(ai.raw || '').slice(0, 2000)
  };
  let pick = null;
  if (!domPick) {
    const candidates = identity === 'plus'
      ? [ai.plus_price, ai.hand_price, ai.jd_price]
      : [ai.hand_price, ai.jd_price, ai.plus_price];
    for (const c of candidates) {
      if (aiPlausiblePrice(c, task.frontPrice)) {
        pick = Number(c);
        break;
      }
    }
    if (pick != null) info.fallback = true;
  } else if (ai.hand_price != null && Math.abs(Number(ai.hand_price) - domPick.price) > 0.5) {
    info.mismatch = { dom: domPick.price, ai: Number(ai.hand_price) };
  }
  return { info: info, pick: pick };
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片解码失败'));
    img.src = src;
  });
}

// 只把「价格那一小块」裁出来交给 AI：识别更准，也省 token。
// 截图用完即弃，不写入 chrome.storage（不再占内存/存储）。
async function cropShot(shot, rect, viewport) {
  try {
    const img = await loadImage(shot);
    const vw = viewport && viewport.w ? viewport.w : img.width;
    const vh = viewport && viewport.h ? viewport.h : img.height;
    // DOM 没给出价格位置时，按经验裁右上角（电商平台价格区在右上）
    if (!rect) rect = { left: vw * 0.45, top: vh * 0.05, width: vw * 0.55, height: vh * 0.5 };
    const scale = vw > 0 ? img.width / vw : 1;
    const pad = 80;
    const x = Math.max(0, Math.round((rect.left - pad) * scale));
    const y = Math.max(0, Math.round((rect.top - pad) * scale));
    const w = Math.min(img.width - x, Math.round((rect.width + pad * 2) * scale));
    const h = Math.min(img.height - y, Math.round((rect.height + pad * 2) * scale));
    if (!(w > 20 && h > 20)) return shot;
    const up = Math.min(3, Math.max(1, Math.round(900 / w)));
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

// 说明：v2.0 起不再保存采集截图（AI 用完即弃），也不再维护 thumbs 存储。

async function runOfficialApi() {
  if (state.running) {
    setToast('巡检进行中，先停止再采集官方API');
    return;
  }
  const s = state.db.settings;
  const base = String(s.officialApiUrl || 'http://127.0.0.1:18765').replace(/\/+$/, '');
  const rows = state.rows.filter((r) => r.sku && !isOffline(r));
  const skus = Array.from(new Set(rows.map((r) => r.sku)));
  if (!skus.length) {
    setToast('没有可采集的 SKU');
    return;
  }
  setToast('官方API采集中…（' + skus.length + ' 个 SKU）');
  let data;
  try {
    const res = await fetch(base + '/api/prices?skus=' + encodeURIComponent(skus.join(',')), { method: 'GET' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    data = await res.json();
  } catch (e) {
    setToast('官方API不可用：' + errText(e) + '（检查 API 桥是否在运行）');
    logLine('官方API不可用：' + errText(e));
    checkApiBridge();
    return;
  }
  if (!data || !data.ok) {
    setToast('官方API返回异常：' + JSON.stringify(data).slice(0, 200));
    return;
  }
  const at = new Date().toISOString();
  const prices = data.prices || {};
  const sources = data.sources || {};
  const accounts = Array.isArray(data.accounts) ? data.accounts : [];
  const skipped = Array.isArray(data.skipped) ? data.skipped : [];
  const apiErrors = Array.isArray(data.errors) ? data.errors : [];
  let filled = 0;
  for (const sku of Object.keys(prices)) {
    const price = aiNum(prices[sku]);
    if (price == null) continue;
    const cap = state.db.captures[sku] || {};
    delete cap.manualConfirmed;
    delete cap.confirmedAt;
    cap.util = {
      price: price,
      kind: 'official',
      at: at,
      account: '官方API',
      source: sources[sku] || '',
      title: '',
      url: 'https://item.shop.example.com/' + sku + '.html'
    };
    cap.fail = null;
    cap.updatedAt = at;
    state.db.captures[sku] = cap;
    filled++;
  }
  await saveDb();
  renderAll();
  const missing = Array.isArray(data.missing) ? data.missing : [];
  let msg = '官方API采集完成：填入 ' + filled + ' 个 SKU，' + missing.length + ' 个无权限/无价';
  if (accounts.length) msg += '（账号：' + accounts.join(' / ') + '）';
  if (skipped.length) msg += '；有 ' + skipped.length + ' 个账号未就绪，缺 appSecret';
  setToast(msg);
  logLine('官方API采集：成功 ' + filled + ' 个，未覆盖 ' + missing.length + ' 个' + (missing.length ? '（' + missing.slice(0, 8).join(',') + (missing.length > 8 ? '…' : '') + '）' : ''));
  if (accounts.length) logLine('官方API账号：' + accounts.join(' / '));
  skipped.forEach((item) => logLine('官方API账号未启用：' + item));
  apiErrors.slice(0, 6).forEach((item) => logLine('官方API提示：' + item));
  checkApiBridge();
}

// ---------------- 第二轨道结束 ----------------

async function finishRun() {
  const run = state.run;
  if (run && run.matrix) await matrixShutdown('巡检结束');
  state.running = false;
  state.paused = false;
  state.pending = null;
  if (run) {
    try {
      if (run.runnerWindowId != null) {
        await chrome.windows.remove(run.runnerWindowId);
      } else if (!state.db.settings.keepTab && run.runnerTabId != null) {
        await chrome.tabs.remove(run.runnerTabId);
      }
    } catch (e) {
      // 标签页/窗口可能已被关闭
    }
    state.db.lastRun = {
      identity: run.identity,
      at: new Date().toISOString(),
      done: run.done || 0,
      ok: run.ok,
      fail: run.fail,
      total: run.tasks.length,
      account: run.accountLabel || '',
      mode: run.matrix ? 'matrix' : run.foreground ? 'foreground' : 'background',
      batches: run.matrix && run.matrixState ? run.matrixState.batchCount : null
    };
    if (run.accountLabel) state.db.lastAccount = run.accountLabel;
    await saveDb();
  }
  const runLabel = run && run.matrix ? '矩阵速采' : '巡检';
  const endVerb = run && run.matrix && state.stopped ? '已停止' : '结束';
  setToast(runLabel + endVerb + '：成功 ' + (run ? run.ok : 0) + '，失败 ' + (run ? run.fail : 0));
  if (run) {
    logLine(runLabel + endVerb + '：共 ' + run.tasks.length + ' 个，成功 ' + run.ok + '，失败 ' + run.fail);
    if (run.matrix) {
      updateProgress(run.done || 0, run.tasks.length, state.stopped ? '已停止' : '已完成');
      matrixBoardFinish(run);
    } else {
      updateProgress(run.tasks.length, run.tasks.length, '已完成');
    }
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
    let shot = null;
    let aiInfo = null;
    try {
      if (run.foreground) {
        const captured = await foregroundCapture(run, task);
        result = captured.result;
        shot = captured.shot;
      } else {
        state.pendingBuffer = null;
        await chrome.tabs.update(run.runnerTabId, { url: task.url });
        result = await waitForResult(task.sku, PRICE_TIMEOUT_MS);
      }
    } catch (e) {
      result = { ok: false, reason: '打开页面失败：' + errText(e) };
    }
    if (state.stopped) break;

    if (result && result.priceChanges && result.priceChanges.length) {
      logLine(
        '  ↻ 页面价格刷新：' +
        result.priceChanges.map((x) => fmtMoney(x.from) + '→' + fmtMoney(x.to)).join(' / ') +
        '（已采用最新一次读数）'
      );
    }

    if (shot) {
      try {
        const analysis = await analyzeShot(task, run.identity, result, shot);
        aiInfo = analysis ? analysis.info : null;
        if (analysis && analysis.pick != null) {
          result = {
            ok: true,
            hand: { price: analysis.pick, kind: 'ai', label: 'AI识别' },
            account: result && result.account,
            url: task.url,
            title: (result && result.title) || '',
            ai: true
          };
          logLine('  AI 识图补价：' + task.sku + ' → ' + fmtMoney(analysis.pick));
        } else if (aiInfo && aiInfo.mismatch) {
          logLine('  ⚠ DOM/AI 价格不一致：DOM ' + fmtMoney(aiInfo.mismatch.dom) + ' / AI ' + fmtMoney(aiInfo.mismatch.ai));
        }
      } catch (e) {
        logLine('  截图/AI 处理失败：' + errText(e));
      }
    }

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

    let finalPick = null;
    let offMeta = null;
    const threshold = thresholdFor(task, run.identity);
    if (result && result.ok) {
      const firstPick = pickPrice(run.identity, result, task.frontPrice);
      if (firstPick) {
        finalPick = firstPick;
        // 只记录「偏离阈值」，不再自动多采几次挑一个最接近阈值的值
        // （那样等于让程序猜一个"看起来合理"的价格，反而会掩盖真实读数）
        if (threshold != null) {
          const diff = Math.abs(firstPick.price - threshold);
          if (diff > deviationLimitValue()) {
            offMeta = {
              threshold: Number(threshold),
              limit: deviationLimitValue(),
              confirmLimit: deviationConfirmLimitValue(),
              attempts: [firstPick.price],
              needsConfirm: diff > deviationConfirmLimitValue(),
              at: new Date().toISOString()
            };
            logLine(
              '  ⚠ 价格 ' + fmtMoney(firstPick.price) + ' 与阈值 ' + fmtMoney(threshold) + ' 相差 ' + fmtMoney(diff) +
              (offMeta.needsConfirm ? '（已标记需人工确认）' : '（仅提示，不修改读数）')
            );
          }
        }
      }
    }
    const finalResult = result;
    const success = recordResult(task, run.identity, finalResult, finalPick ? { pick: finalPick, offThreshold: offMeta } : null);
    run.done = run.idx + 1;
    if (success) {
      run.ok++;
      run.consecutiveFails = 0;
      const cap = state.db.captures[task.sku];
      if (cap && aiInfo) cap.ai = aiInfo;
      const info = cap && cap[run.identity];
      logLine('  ✓ ' + (info ? fmtMoney(info.price) + '（' + kindLabel(info.kind) + '）' : '已采集') + (info && info.offThreshold ? (info.offThreshold.needsConfirm ? ' ⚠ 已记录，建议人工确认' : ' ⚠ 偏离阈值，仅提示') : ''));
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

// ============================================================
// 矩阵速采：一次并行打开一排页面 → 成排读取 → 批量写入 → 批量关闭（破碎消散）
// 取价规则不在这里：仍然完全由 content.js 决定，矩阵模式只是换了「打开/收结果/写库」的节奏。
// ============================================================
const MX_STATE_TEXT = { loading: '打开中', reading: '读取中', read: '已读', fail: '失败' };
const MX_EMPTY_DEFAULT =
  '<b>矩阵速采待命中</b><span>点「⚡ 矩阵速采」后，商品页会在这里排成一道弧线：批量打开 → 成排读取 → 批量写入 → 破碎关闭 → 下一批。</span>';

function matrixBatchSize() {
  const n = Number(state.db && state.db.settings ? state.db.settings.matrixBatch : 6);
  if (!isFinite(n)) return 6;
  return Math.max(MATRIX_MIN_BATCH, Math.min(MATRIX_MAX_BATCH, Math.round(n)));
}

function matrixGapMs() {
  const n = Number(state.db && state.db.settings ? state.db.settings.matrixGapMs : 300);
  if (!isFinite(n)) return 300;
  return Math.max(120, Math.min(2000, Math.round(n)));
}

function matrixBatchDelayMs() {
  const n = Number(state.db && state.db.settings ? state.db.settings.matrixBatchDelay : 1.5);
  if (!isFinite(n) || n < 0) return 1500;
  return Math.min(30000, Math.round(n * 1000));
}

function matrixShatterEnabled() {
  return !(state.db && state.db.settings && state.db.settings.matrixShatter === false);
}

// 矩阵打开方式：默认真实多窗口；可选后台标签页 + 矩阵大屏（HUD/预演）
function matrixUseWindows() {
  return !(state.db && state.db.settings && state.db.settings.matrixWindowMode === false);
}

// 真实窗口排布：一扇扇商品页窗口沿浅弧线排开。
// 注意：任务 i 放到视觉 j=n-1-i 的位置，也就是先开右边的、最后开左边的；
// Chrome 后开的窗口压在前面，这样每扇窗的右侧（电商平台价格区）都露在外面，不会被邻居盖住。
function matrixWindowLayout(count) {
  const sw = (window.screen && screen.availWidth) || 1920;
  const sh = (window.screen && screen.availHeight) || 1080;
  const ox = Number(window.screen && screen.availLeft) || 0;
  const oy = Number(window.screen && screen.availTop) || 0;
  const n = Math.max(1, Math.min(MATRIX_MAX_BATCH, Number(count) || 1));
  let width = Math.round(Math.max(430, Math.min(780, (sw - 100) / Math.max(2, Math.min(n, 3.5)))));
  let height = Math.round(Math.max(560, Math.min(840, sh * 0.68)));
  if (n === 1) width = Math.min(780, Math.max(560, sw * 0.5));
  height = Math.min(height, sh - 60);
  const margin = 30;
  const usable = Math.max(0, sw - width - margin * 2);
  const step = n > 1 ? usable / (n - 1) : 0;
  const depth = Math.min(96, Math.max(0, n - 1) * 18);
  const idealTop = (sh - height) / 2 - depth * 0.12;
  const topBase = Math.max(12, Math.min(idealTop, sh - height - depth - 18));
  const list = [];
  for (let i = 0; i < n; i++) {
    const j = n - 1 - i;
    const t = n > 1 ? (j / (n - 1)) * 2 - 1 : 0;
    list.push({
      left: (n === 1 ? Math.round((sw - width) / 2) : Math.round(margin + j * step)) + ox,
      top: Math.round(topBase + depth * t * t) + oy,
      width: width,
      height: height
    });
  }
  return list;
}

// 关闭前给页面一个淡出（真实窗口没法做粒子碎裂，只能让页面先淡出）
function matrixFadeTab(tabId) {
  if (tabId == null) return;
  try {
    if (!chrome.scripting || !chrome.scripting.executeScript) return;
    chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: function () {
        try {
          var el = document.documentElement;
          if (!el) return;
          el.style.transition = 'opacity 300ms ease';
          el.style.opacity = '0';
        } catch (e) {
          // 忽略
        }
      }
    }).catch(function () {});
  } catch (e) {
    // 忽略
  }
}

function matrixCloseSlot(slot, fade) {
  if (!slot) return;
  if (slot.windowId != null) {
    if (fade) matrixFadeTab(slot.tabId);
    const winId = slot.windowId;
    const tabId = slot.tabId;
    setTimeout(function () {
      try {
        chrome.windows.remove(winId).catch(function () {
          if (tabId != null) {
            try {
              chrome.tabs.remove(tabId);
            } catch (e) {
              // 忽略
            }
          }
        });
      } catch (e) {
        if (tabId != null) {
          try {
            chrome.tabs.remove(tabId);
          } catch (e2) {
            // 忽略
          }
        }
      }
    }, fade ? 300 : 0);
  } else if (slot.tabId != null) {
    try {
      matrixRemoveTabs([slot.tabId]).catch(function () {});
    } catch (e) {
      // 忽略
    }
  }
}

async function matrixCloseWindows(slots, fade) {
  const list = (slots || []).filter(function (s) {
    return s && (s.windowId != null || s.tabId != null);
  });
  list.forEach(function (slot, i) {
    setTimeout(function () {
      matrixCloseSlot(slot, fade);
    }, i * 90);
  });
  await sleep(list.length * 90 + (fade ? 380 : 120));
}

// ---------------- 矩阵大屏（独立窗口） ----------------
// 工作台只负责采集与批量写库；显示全部交给 matrix.html / matrix.js。
// 两个扩展页面通过 BroadcastChannel 通信（同一扩展源），握手后同步完整状态。
let boardChannel = null;

function ensureBoardChannel() {
  if (boardChannel) return boardChannel;
  try {
    boardChannel = new BroadcastChannel(MATRIX_BOARD_CHANNEL);
    boardChannel.onmessage = (ev) => {
      const msg = ev.data || {};
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'hello') {
        state.board.ready = true;
        state.board.lastBoardHelloAt = Date.now();
        const resolve = state.board.readyResolve;
        state.board.readyResolve = null;
        if (resolve) resolve(true);
        // 工作台刷新后可能丢了窗口句柄：只要大屏还在发 hello，就继续心跳 + 同步
        matrixBoardStartHeartbeat();
        matrixBoardSync();
      } else if (msg.type === 'bye') {
        matrixBoardDetached();
      }
    };
  } catch (e) {
    boardChannel = null;
  }
  return boardChannel;
}

function matrixBoardSend(msg) {
  const ch = ensureBoardChannel();
  if (!ch || !msg || typeof msg !== 'object') return;
  try {
    ch.postMessage(Object.assign({ session: state.board.session, at: Date.now() }, msg));
  } catch (e) {
    // 忽略
  }
}

function matrixBoardStatusPayload() {
  const run = state.run;
  const m = run && run.matrixState;
  const f = !run && state.board.finalStats ? state.board.finalStats : null;
  return {
    type: 'status',
    running: !!(run && run.matrix),
    finished: !!state.board.finished,
    phaseText: state.board.phase,
    stopped: f ? !!f.stopped : !!state.stopped,
    account: run ? (run.accountLabel || '') : '',
    batchIndex: m ? (m.batchIndex || 0) : f ? Math.max(0, (f.batchCount || 1) - 1) : 0,
    batchCount: m ? (m.batchCount || 0) : f ? (f.batchCount || 0) : 0,
    batchSize: m ? (m.batchSize || 0) : f ? (f.batchSize || 0) : 0,
    currentBatchCount: m ? (m.currentBatchCount || 0) : 0,
    read: m ? (m.batchRead || 0) : 0,
    done: run ? (run.done || 0) : f ? (f.done || 0) : 0,
    total: run ? run.tasks.length : f ? (f.total || 0) : 0,
    ok: run ? (run.ok || 0) : f ? (f.ok || 0) : 0,
    fail: run ? (run.fail || 0) : f ? (f.fail || 0) : 0
  };
}

function matrixBoardStatus() {
  matrixBoardSend(matrixBoardStatusPayload());
}

function matrixBoardPhase(text) {
  state.board.phase = text || '待命';
  matrixBoardStatus();
}

function matrixBoardSpec() {
  const sw = (window.screen && screen.availWidth) || 1600;
  const sh = (window.screen && screen.availHeight) || 1000;
  const width = Math.max(1000, Math.round(Math.min(sw * 0.94, 1760)));
  const height = Math.max(640, Math.round(Math.min(sh * 0.9, 1040)));
  return {
    width: width,
    height: height,
    left: Math.max(0, Math.round((sw - width) / 2)),
    top: Math.max(0, Math.round((sh - height) / 2))
  };
}

async function matrixBoardOpen(reset) {
  ensureBoardChannel();
  const b = state.board;
  if (reset) {
    b.session = 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    b.cards = [];
    b.phase = '待命';
    b.sub = '';
    b.finished = false;
    b.finalStats = null;
  }
  if (b.windowId != null) {
    try {
      await chrome.windows.update(b.windowId, { focused: true });
      matrixBoardStartHeartbeat();
      matrixBoardSync();
      return true;
    } catch (e) {
      matrixBoardDetached();
    }
  }
  // 工作台刷新过、窗口句柄丢了：先找找已经开着的矩阵大屏，别重复开
  if (b.windowId == null) {
    try {
      const boardUrl = chrome.runtime.getURL('matrix.html');
      const allTabs = await chrome.tabs.query({});
      const found = (allTabs || []).filter((t) => t && t.url && t.url.indexOf(boardUrl) === 0);
      if (found.length) {
        b.tabId = found[0].id;
        b.windowId = found[0].windowId != null ? found[0].windowId : null;
        if (b.windowId != null) {
          try {
            await chrome.windows.update(b.windowId, { focused: true });
          } catch (e) {
            // 聚焦失败也继续复用
          }
        }
        matrixBoardStartHeartbeat();
        matrixBoardSync();
        return true;
      }
    } catch (e) {
      // tabs.query 失败就继续走新建窗口
    }
  }
  // 大屏刚打过招呼（BroadcastChannel 已连上）：直接复用
  if (b.windowId == null && b.lastBoardHelloAt && Date.now() - b.lastBoardHelloAt < 6000) {
    matrixBoardStartHeartbeat();
    matrixBoardSync();
    return true;
  }
  b.ready = false;
  const readyPromise = new Promise((resolve) => {
    b.readyResolve = resolve;
  });
  try {
    const spec = matrixBoardSpec();
    const win = await chrome.windows.create(Object.assign({
      url: chrome.runtime.getURL('matrix.html') + '?session=' + encodeURIComponent(b.session),
      type: 'popup',
      focused: true
    }, spec));
    if (!win || win.id == null) throw new Error('未能创建矩阵大屏窗口');
    b.windowId = win.id;
    b.tabId = win.tabs && win.tabs[0] ? win.tabs[0].id : null;
  } catch (e) {
    b.readyResolve = null;
    logLine('矩阵大屏打开失败：' + errText(e));
    setToast('矩阵大屏打开失败：' + errText(e) + '（可点状态栏「矩阵大屏」重试）');
    return false;
  }
  matrixBoardStartHeartbeat();
  // 等大屏握手，最多 1.2 秒；大屏慢一点也没关系，sync 会补齐
  await Promise.race([readyPromise, sleep(1200)]);
  matrixBoardSync();
  return true;
}

function matrixBoardStartHeartbeat() {
  const b = state.board;
  if (b.heartbeatTimer) return;
  b.heartbeatTimer = setInterval(() => {
    if (b.windowId == null) {
      matrixBoardStopHeartbeat();
      return;
    }
    matrixBoardSend({ type: 'heartbeat' });
  }, 4000);
}

function matrixBoardStopHeartbeat() {
  if (state.board.heartbeatTimer) {
    clearInterval(state.board.heartbeatTimer);
    state.board.heartbeatTimer = null;
  }
}

function matrixBoardDetached() {
  state.board.windowId = null;
  state.board.tabId = null;
  state.board.ready = false;
  state.board.lastBoardHelloAt = 0;
  matrixBoardStopHeartbeat();
}

function matrixBoardSync() {
  const b = state.board;
  const run = state.run;
  const m = run && run.matrixState;
  matrixBoardSend({
    type: 'sync',
    session: b.session,
    running: !!(run && run.matrix),
    finished: !!b.finished,
    phase: b.phase,
    shatter: matrixShatterEnabled(),
    stats: matrixBoardStatusPayload(),
    sub: b.sub || '',
    cards: b.cards,
    finalStats: b.finalStats
  });
}

function matrixBoardRunStart(run, batchCount) {
  const b = state.board;
  b.cards = [];
  b.finished = false;
  b.finalStats = null;
  b.phase = '准备中';
  b.sub = '账号：' + (run.identity === 'plus' ? 'PLUS 会员' : '普惠') + ' · 共 ' + run.tasks.length + ' 个 SKU · 每批 ' + (run.matrixSize || matrixBatchSize()) + ' 个';
  matrixBoardSend({
    type: 'runStart',
    session: b.session,
    identity: run.identity,
    total: run.tasks.length,
    batchCount: batchCount,
    batchSize: run.matrixSize || matrixBatchSize(),
    shatter: matrixShatterEnabled()
  });
  matrixBoardStatus();
}

function matrixBoardBatchStart(batch, batchIndex, batchCount, batchSize) {
  state.board.cards = [];
  state.board.finished = false;
  state.board.finalStats = null;
  state.board.phase = '第 ' + (batchIndex + 1) + '/' + batchCount + ' 批 · 并行打开';
  matrixBoardSend({
    type: 'batchStart',
    batchIndex: batchIndex,
    batchCount: batchCount,
    batchSize: batchSize,
    count: batch.length,
    shatter: matrixShatterEnabled()
  });
  matrixBoardStatus();
}

function matrixBoardCardAdd(card, index, total) {
  state.board.cards.push(card);
  matrixBoardSend({ type: 'cardAdd', card: card, index: index, total: total });
}

function matrixBoardCardState(card) {
  matrixBoardSend({
    type: 'card',
    id: card.id,
    state: card.state,
    price: card.price,
    reason: card.reason || ''
  });
}

function matrixBoardCloseBatch(ids, batchIndex) {
  const set = new Set(ids);
  state.board.cards = state.board.cards.filter((c) => !set.has(c.id));
  matrixBoardSend({
    type: 'closeBatch',
    ids: ids,
    order: ids.slice(),
    shatter: matrixShatterEnabled(),
    staggerMs: 110,
    batchIndex: batchIndex
  });
}

function matrixBoardFinish(run) {
  const b = state.board;
  const m = run.matrixState || {};
  b.finished = true;
  b.phase = state.stopped ? '已停止' : '完成';
  b.finalStats = {
    done: run.done || 0,
    ok: run.ok || 0,
    fail: run.fail || 0,
    total: run.tasks.length,
    batchCount: m.batchCount || 0,
    batchSize: run.matrixSize || 0,
    stopped: !!state.stopped
  };
  b.cards = [];
  matrixBoardSend({ type: 'finish', session: b.session, stats: b.finalStats, stopped: !!state.stopped });
}

function matrixBoardSayBye() {
  matrixBoardSend({ type: 'bye' });
  matrixBoardStopHeartbeat();
}

// ---------------- 打开 / 收结果 / 批量写入 / 批量关闭 ----------------
async function matrixOpenSlot(task, index, total, run) {
  const m = run.matrixState;
  const id = 'c' + (++m.cardSeq);
  const card = { id: id, sku: task.sku, model: task.model || '', state: 'loading', price: null, reason: '' };
  matrixBoardCardAdd(card, index, total);
  const slot = {
    id: id,
    task: task,
    tabId: null,
    windowId: null,
    windowPos: null,
    card: card,
    finished: false,
    result: null,
    timer: null,
    resolve: null
  };
  slot.resultPromise = new Promise((resolve) => {
    slot.resolve = resolve;
  });

  // 1) 真实多窗口：一扇窗一个商品页，按弧线摆好
  if (run.matrixWindows) {
    const pos = (m.windowLayout && m.windowLayout[index]) || matrixWindowLayout(total)[index];
    slot.windowPos = pos;
    let win = null;
    try {
      win = await chrome.windows.create({
        url: task.url,
        type: 'popup',
        focused: true,
        left: pos.left,
        top: pos.top,
        width: pos.width,
        height: pos.height
      });
    } catch (e) {
      logLine('矩阵窗口创建失败，改用后台标签页：' + errText(e));
      win = null;
    }
    if (win && win.id != null) {
      slot.windowId = win.id;
      slot.tabId = win.tabs && win.tabs[0] ? win.tabs[0].id : null;
      if (slot.tabId == null) {
        try {
          chrome.windows.remove(win.id);
        } catch (e) {
          // 忽略
        }
        slot.windowId = null;
      }
    }
  }

  // 2) 窗口没建起来就退回后台标签页，保证采集能继续
  if (slot.tabId == null) {
    try {
      const tab = await chrome.tabs.create({ url: task.url, active: false });
      slot.tabId = tab.id;
      slot.windowId = null;
    } catch (e) {
      matrixSlotFinish(slot, { ok: false, reason: '打开页面失败：' + errText(e) });
      return slot;
    }
  }

  if (state.stopped) {
    matrixCloseSlot(slot, false);
    matrixSlotFinish(slot, { ok: false, reason: '已停止' });
    return slot;
  }
  if (state.matrix && state.matrix.pending) state.matrix.pending.set(slot.tabId, slot);
  card.state = 'reading';
  matrixBoardCardState(card);
  matrixBoardStatus();
  slot.timer = setTimeout(() => {
    matrixSlotFinish(slot, { ok: false, reason: '等待页面价格超时（窗口加载慢 / 未登录 / 页面改版）' });
  }, MATRIX_TIMEOUT_MS);
  return slot;
}

function matrixSlotFinish(slot, result, reason) {
  if (!slot || slot.finished) return;
  slot.finished = true;
  if (slot.timer) {
    clearTimeout(slot.timer);
    slot.timer = null;
  }
  if (state.matrix && state.matrix.pending && slot.tabId != null) state.matrix.pending.delete(slot.tabId);
  const run = state.run;
  let msg = result;
  if (!msg || typeof msg !== 'object') msg = { ok: false, reason: reason || '采集失败' };
  // 页面被合并/跳转到别的商品时，宁可不记录，也不要张冠李戴
  if (msg.ok && msg.sku && slot.task.sku && String(msg.sku) !== String(slot.task.sku)) {
    msg = { ok: false, reason: '页面 SKU 与目标不一致（' + msg.sku + '），已跳过' };
  }
  const picked = msg.ok && run ? pickPrice(run.identity, msg, slot.task.frontPrice) : null;
  if (slot.card) {
    if (picked) {
      slot.card.state = 'read';
      slot.card.price = picked.price;
      slot.card.reason = '';
    } else {
      slot.card.state = 'fail';
      slot.card.price = null;
      slot.card.reason = msg.reason || (msg.ok ? '取到的价格不合理，已跳过' : '采集失败');
    }
    matrixBoardCardState(slot.card);
  }
  if (run && run.matrixState) {
    run.matrixState.batchRead = (run.matrixState.batchRead || 0) + 1;
    if (/登录|安全验证|验证码/.test(String(msg.reason || ''))) run.matrixState.loginWarn = true;
    matrixBoardStatus();
  }
  slot.result = msg;
  if (slot.resolve) slot.resolve(msg);
}

async function matrixWaitBatch(slots) {
  if (!slots.length) return [];
  await Promise.all(slots.map((s) => s.resultPromise));
  return slots.map((s) => ({ slot: s, result: s.result || { ok: false, reason: '没有结果' } }));
}

async function matrixCommitBatch(settled, run) {
  let ok = 0;
  let fail = 0;
  const at = new Date().toISOString();
  for (let i = 0; i < settled.length; i++) {
    const item = settled[i];
    const task = item.slot.task;
    const result = item.result || { ok: false, reason: '没有结果' };
    const tag = '[' + (i + 1) + '/' + settled.length + '] ';
    run.done++;
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
    let pick = null;
    let offMeta = null;
    if (result && result.ok) {
      pick = pickPrice(run.identity, result, task.frontPrice);
      const threshold = thresholdFor(task, run.identity);
      if (pick && threshold != null) {
        const diff = Math.abs(pick.price - threshold);
        if (diff > deviationLimitValue()) {
          offMeta = {
            threshold: Number(threshold),
            limit: deviationLimitValue(),
            confirmLimit: deviationConfirmLimitValue(),
            attempts: [pick.price],
            needsConfirm: diff > deviationConfirmLimitValue(),
            at: at
          };
          logLine('  ⚠ ' + task.sku + ' 价格 ' + fmtMoney(pick.price) + ' 与阈值 ' + fmtMoney(threshold) +
            ' 相差 ' + fmtMoney(diff) + (offMeta.needsConfirm ? '（需人工确认）' : '（仅提示）'));
        }
      }
    }
    let success = false;
    try {
      success = recordResult(task, run.identity, result, pick ? { pick: pick, offThreshold: offMeta } : null);
    } catch (e) {
      success = false;
      logLine('  记录失败 ' + task.sku + '：' + errText(e));
    }
    if (success) {
      ok++;
      run.ok++;
      run.consecutiveFails = 0;
      const info = state.db.captures[task.sku] && state.db.captures[task.sku][run.identity];
      logLine('  ✓ ' + tag + task.sku + ' ' + (info ? fmtMoney(info.price) + '（' + kindLabel(info.kind) + '）' : '已采集') +
        (info && info.offThreshold ? (info.offThreshold.needsConfirm ? ' ⚠ 建议人工确认' : ' ⚠ 偏离阈值') : ''));
    } else {
      fail++;
      run.fail++;
      run.consecutiveFails = (run.consecutiveFails || 0) + 1;
      const reason = (result && result.reason) || (result && result.ok ? '取到的价格不合理（疑似只读到数字片段/促销角标），已跳过' : '采集失败');
      logLine('  ✗ ' + tag + task.sku + ' ' + reason);
    }
  }
  await saveDb();
  renderAll();
  updateProgress(run.done, run.tasks.length, '已批量写入 ' + settled.length + ' 条（成功 ' + ok + '，失败 ' + fail + '）');
  logLine('批量写入：本批 ' + settled.length + ' 个，成功 ' + ok + '，失败 ' + fail + '（累计 ' + run.done + '/' + run.tasks.length + '）');
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
  if (run.matrixState) {
    run.matrixState.loginWarn = false;
    matrixBoardStatus();
  }
  return { ok: ok, fail: fail };
}

async function matrixCloseBatch(slots, opts) {
  opts = opts || {};
  const run = state.run;
  const ids = [];
  const cardIds = [];
  let hasWindows = false;
  for (const slot of slots) {
    if (slot.tabId != null) ids.push(slot.tabId);
    if (slot.windowId != null) hasWindows = true;
    if (state.matrix && state.matrix.pending) state.matrix.pending.delete(slot.tabId);
    if (slot.timer) {
      clearTimeout(slot.timer);
      slot.timer = null;
    }
    slot.finished = true;
    if (slot.card) cardIds.push(slot.card.id);
  }
  if (!opts.silent) await sleep(240);
  if (hasWindows) {
    await matrixCloseWindows(slots, !opts.silent);
  } else if (ids.length) {
    await matrixRemoveTabs(ids);
  }
  matrixBoardCloseBatch(cardIds, run && run.matrixState ? run.matrixState.batchIndex : 0);
  state.board.phase = run && run.matrixWindows ? '批量关闭 · 窗口淡出' : '批量关闭 · 页面碎成粉末';
  matrixBoardStatus();
}

function matrixAbortPending(reason) {
  const m = state.matrix;
  if (!m || !m.pending) return;
  const slots = Array.from(m.pending.values());
  for (const slot of slots) {
    matrixSlotFinish(slot, { ok: false, reason: reason || '已停止' });
    matrixCloseSlot(slot, false);
  }
  m.pending.clear();
}

// 关标签页：先整批关，失败再逐个关，避免其中一个已不存在导致整批失败
async function matrixRemoveTabs(ids) {
  if (!ids || !ids.length) return;
  try {
    await chrome.tabs.remove(ids);
    return;
  } catch (e) {
    // 有页面已经被关掉了，逐个兜底
  }
  for (const id of ids) {
    try {
      await chrome.tabs.remove(id);
    } catch (e2) {
      // 已关闭
    }
  }
}

async function matrixShutdown(reason) {
  const m = state.matrix;
  if (!m) return;
  const slots = Array.from(m.pending.values());
  const cardIds = [];
  for (const slot of slots) {
    if (slot.card) cardIds.push(slot.card.id);
    matrixSlotFinish(slot, { ok: false, reason: reason || '已结束' });
    matrixCloseSlot(slot, false);
  }
  m.pending.clear();
  if (cardIds.length) {
    matrixBoardCloseBatch(cardIds, m.batchIndex || 0);
    state.board.cards = state.board.cards.filter((c) => !cardIds.includes(c.id));
  }
  state.matrix = null;
}

async function runMatrixLoop() {
  const run = state.run;
  const size = run.matrixSize || matrixBatchSize();
  const gap = matrixGapMs();
  const batchCount = Math.max(1, Math.ceil(run.tasks.length / size));
  run.matrixState = {
    pending: new Map(),
    batchSize: size,
    batchIndex: 0,
    batchCount: batchCount,
    currentBatchCount: 0,
    batchRead: 0,
    cardSeq: 0,
    loginWarn: false
  };
  state.matrix = run.matrixState;
  if (state.view !== 'workbench') switchView('workbench');
  const useWindows = run.matrixWindows === true;
  // 真实多窗口模式：商品页窗口本身就是阵列，不再自动开大屏（大屏可手动打开做 HUD）
  if (!useWindows) {
    await matrixBoardOpen(true);
  } else if (state.board.windowId != null) {
    matrixBoardSync();
  }
  matrixBoardRunStart(run, batchCount);
  logLine('矩阵速采：' + run.tasks.length + ' 个 SKU，每批 ' + size + ' 个，共 ' + batchCount + ' 批；整批读完后批量写入存储（' + (useWindows ? '真实多窗口' : '后台标签页 + 大屏') + '）');
  if (useWindows) {
    logLine('窗口矩阵：每批按屏幕宽度沿弧线排开 ' + Math.min(size, 12) + ' 个商品页窗口，批读完后淡出关闭');
  } else {
    logLine('矩阵大屏：' + (state.board.windowId != null ? '已打开独立窗口' : '未打开（采集继续）'));
  }

  for (let bi = 0; bi < batchCount; bi++) {
    if (state.stopped) break;
    while (state.paused && !state.stopped) {
      matrixBoardPhase('已暂停');
      await sleep(400);
    }
    if (state.stopped) break;
    const batch = run.tasks.slice(bi * size, bi * size + size);
    if (!batch.length) break;
    run.matrixState.batchIndex = bi;
    run.matrixState.batchRead = 0;
    run.matrixState.currentBatchCount = batch.length;
    run.matrixState.windowLayout = useWindows ? matrixWindowLayout(batch.length) : null;
    matrixBoardBatchStart(batch, bi, batchCount, size);
    logLine('矩阵第 ' + (bi + 1) + '/' + batchCount + ' 批：并行打开 ' + batch.length + ' 个' + (useWindows ? '窗口' : '页面'));

    const slots = [];
    for (let i = 0; i < batch.length; i++) {
      if (state.stopped) break;
      while (state.paused && !state.stopped) {
        matrixBoardPhase('已暂停');
        await sleep(350);
      }
      if (state.stopped) break;
      const slot = await matrixOpenSlot(batch[i], i, batch.length, run);
      slots.push(slot);
      matrixBoardStatus();
      if (i < batch.length - 1 && !state.stopped) {
        await sleep(gap + randInt(0, Math.round(gap * 0.5)));
      }
    }
    matrixBoardPhase('第 ' + (bi + 1) + '/' + batchCount + ' 批 · 成排读取');
    const settled = await matrixWaitBatch(slots);
    if (state.stopped) {
      await matrixCloseBatch(slots, { silent: true });
      break;
    }
    matrixBoardPhase('第 ' + (bi + 1) + '/' + batchCount + ' 批 · 批量写入');
    await matrixCommitBatch(settled, run);
    matrixBoardPhase('第 ' + (bi + 1) + '/' + batchCount + ' 批 · 批量关闭');
    await matrixCloseBatch(slots, {});
    if (run.matrixState) run.matrixState.batchRead = 0;
    if (state.stopped) break;
    if (state.paused) continue;
    if (bi < batchCount - 1) {
      const wait = matrixBatchDelayMs();
      if (wait > 0) {
        matrixBoardPhase('下一批准备中');
        await sleep(wait);
      }
    }
  }
  if (state.matrix) state.matrix.pending.clear();
}

// ---------------- 重采：先选账号 + 轨道 ----------------
let rerunResolver = null;

function defaultRerunChoice() {
  const s = state.db.settings;
  const identity = s.rerunRemember && s.rerunIdentity
    ? s.rerunIdentity
    : ((state.db.lastRun && state.db.lastRun.identity) || 'util');
  let mode = '';
  if (s.rerunRemember && s.rerunMode) mode = s.rerunMode;
  else if (s.patrolMode === 'matrix') mode = 'matrix';
  else if (s.rerunRemember && typeof s.rerunForeground === 'boolean') mode = s.rerunForeground ? 'foreground' : 'background';
  else mode = s.patrolMode === 'background' ? 'background' : 'foreground';
  if (mode !== 'matrix' && mode !== 'background') mode = 'foreground';
  return {
    identity: identity === 'plus' ? 'plus' : 'util',
    foreground: mode === 'foreground',
    matrix: mode === 'matrix',
    mode: mode
  };
}

function openRerunDialog(opts) {
  opts = opts || {};
  if (!els.rerunDialog) return Promise.resolve(defaultRerunChoice());
  const dflt = defaultRerunChoice();
  const identity = opts.identity ? opts.identity : dflt.identity;
  const matrix = typeof opts.matrix === 'boolean' ? opts.matrix : dflt.matrix;
  const foreground = typeof opts.foreground === 'boolean' ? opts.foreground : dflt.foreground;
  els.rerunIdentity.value = identity === 'plus' ? 'plus' : 'util';
  els.rerunTrack.value = matrix ? 'matrix' : foreground ? 'foreground' : 'background';
  els.rerunRemember.checked = !!state.db.settings.rerunRemember;
  els.rerunHint.textContent = opts.hint || '选择本次重采使用的账号和轨道。';
  if (els.rerunDialog.open) {
    // 已经有一个重采弹窗开着：先按取消处理上一个，再开新的
    closeRerunDialog(null);
  }
  if (typeof els.rerunDialog.showModal === 'function') els.rerunDialog.showModal();
  else els.rerunDialog.setAttribute('open', '');
  return new Promise((resolve) => {
    rerunResolver = resolve;
  });
}

function closeRerunDialog(result) {
  const resolve = rerunResolver;
  rerunResolver = null;
  try {
    if (els.rerunDialog && els.rerunDialog.open) els.rerunDialog.close();
  } catch (e) {
    // 忽略
  }
  if (resolve) resolve(result);
}

function confirmRerunChoice() {
  const identity = els.rerunIdentity.value === 'plus' ? 'plus' : 'util';
  const trackValue = els.rerunTrack.value === 'matrix' ? 'matrix' : els.rerunTrack.value === 'background' ? 'background' : 'foreground';
  const matrix = trackValue === 'matrix';
  const foreground = trackValue === 'foreground';
  const remember = !!els.rerunRemember.checked;
  state.db.settings.rerunRemember = remember;
  if (remember) {
    state.db.settings.rerunIdentity = identity;
    state.db.settings.rerunForeground = foreground;
    state.db.settings.rerunMode = trackValue;
    state.db.settings.rerunMatrix = matrix;
  }
  saveDb();
  closeRerunDialog({ identity: identity, foreground: foreground, matrix: matrix, mode: trackValue });
}

function startRerun(opts, choice) {
  const runOpts = Object.assign({}, opts, { foreground: !!choice.foreground, matrix: !!choice.matrix, noConfirm: true });
  return startRun(choice.identity, runOpts);
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
  // 矩阵速采：按钮显式传 matrix:true 时必定走矩阵；普通巡检在「矩阵③」模式下也走矩阵
  const matrixMode = opts.matrix === true || (opts.matrix !== false && state.db.settings.patrolMode === 'matrix');
  const matrixWindows = matrixMode && matrixUseWindows();
  const matrixSize = matrixBatchSize();
  const avg = (Number(state.db.settings.delayMin) + Number(state.db.settings.delayMax)) / 2 || 4;
  const est = matrixMode
    ? Math.max(1, Math.round((Math.ceil(tasks.length / matrixSize) * (16 + matrixBatchDelayMs() / 1000)) / 60))
    : Math.max(1, Math.round((tasks.length * (avg + 6)) / 60));
  if (!opts.auto && !opts.noConfirm) {
    const modeText = matrixMode
      ? (matrixWindows
        ? '真实多窗口：每批同时打开 ' + matrixSize + ' 个商品页窗口，沿屏幕弧线排开读取；批读完后统一批量写入，窗口淡出关闭'
        : '后台标签页 + 矩阵大屏：每批并行打开 ' + matrixSize + ' 个页面，大屏显示弧线与粉末动画')
      : state.db.settings.patrolMode === 'foreground'
        ? '前台小窗逐个打开商品页读取价格（每单约 10–20 秒，采集期间不要用电脑）'
        : '后台标签页逐个打开商品页读取价格（不弹窗，可暂停/停止）';
    const ok = window.confirm(
      '开始【' + identityLabel + '】' + (matrixMode ? '矩阵速采' : '巡检') + '\n\n' +
        '本次 SKU：' + tasks.length + ' 个\n' +
        '预计耗时：约 ' + est + ' 分钟\n' +
        '采集方式：' + modeText + '\n\n' +
        '请先确认：当前 ' + BROWSER_NAME + ' 登录的是' + (identity === 'util' ? '【普通/普惠】账号' : '【PLUS 会员】账号') + '，并且能正常打开电商平台商品页。\n\n' +
        '确定开始？'
    );
    if (!ok) {
      state.autoRunMode = false;
      return;
    }
  } else if (opts.auto) {
    logLine('自动巡检模式：' + identityLabel + '，本次 ' + tasks.length + ' 个 SKU');
  } else if (tasks.length === 1) {
    logLine('单条重采：' + tasks[0].sku + '（' + identityLabel + '）');
  } else {
    logLine('批量采集：' + tasks.length + ' 个 SKU（' + identityLabel + '）');
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
    runnerTabId: null,
    runnerWindowId: null,
    foreground: matrixMode ? false : isForegroundRun(opts),
    matrix: matrixMode,
    matrixWindows: matrixWindows,
    matrixSize: matrixSize
  };
  state.running = true;
  state.paused = false;
  state.stopped = false;
  state.db.lastIdentity = identity;
  state.db.dismissedBanner = true;
  els.logPanel.textContent = '';
  els.progressWrap.classList.remove('hidden');
  renderAll();
  logLine('开始【' + identityLabel + '】' + (matrixMode ? '矩阵速采' : '巡检') + '，共 ' + tasks.length + ' 个 SKU' + (matrixMode ? '（每批 ' + matrixSize + ' 个 · ' + (matrixWindows ? '真实多窗口' : '后台标签页 + 大屏') + '）' : ''));
  try {
    if (matrixMode) {
      await runMatrixLoop();
    } else {
      if (!state.run.foreground) {
        const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
        state.run.runnerTabId = tab.id;
      }
      await runLoop();
    }
  } catch (e) {
    logLine((matrixMode ? '矩阵速采' : '巡检') + '异常终止：' + errText(e));
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
      note += (note ? '；' : '') + (util.offThreshold.confirmed ? '普惠价已人工确认' : (util.offThreshold.needsConfirm ? '普惠价偏离阈值，待人工确认' : '普惠价偏离阈值，仅提示'));
    }
    if (plus && plus.offThreshold) {
      note += (note ? '；' : '') + (plus.offThreshold.confirmed ? '会员价已人工确认' : (plus.offThreshold.needsConfirm ? '会员价偏离阈值，待人工确认' : '会员价偏离阈值，仅提示'));
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
    baseOverride: state.db.baseOverride || null,
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
  // 导出的 JSON 里带了基表的话，一并恢复到独立 key（截图不再恢复）
  if (data.baseOverride && Array.isArray(data.baseOverride.sheets)) {
    await saveBaseOverride(data.baseOverride);
    await reloadBase();
  }
  await saveDb();
  flattenRows();
  renderAll();
  setToast('已导入巡检数据：' + capCount + ' 个 SKU' + (data.baseOverride ? '（含基表）' : ''));
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

// 简单公式求值：支持 数字、单元格引用（如 E58）、+ - * /、括号。
// 用于 Excel 里把阈值写成公式、但保存时没有缓存计算结果的单元格（读取时为空白）。
function evalSimpleFormula(text, getNum) {
  const s = String(text || '').replace(/^=/, '').replace(/\s+/g, '');
  let i = 0;
  const len = s.length;
  const peek = () => (i < len ? s[i] : '');
  function parseExpr() {
    let v = parseTerm();
    while (peek() === '+' || peek() === '-') {
      const op = s[i++];
      const r = parseTerm();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  }
  function parseTerm() {
    let v = parseFactor();
    while (peek() === '*' || peek() === '/') {
      const op = s[i++];
      const r = parseFactor();
      v = op === '*' ? v * r : v / r;
    }
    return v;
  }
  function parseFactor() {
    if (peek() === '+') { i++; return parseFactor(); }
    if (peek() === '-') { i++; return -parseFactor(); }
    if (peek() === '(') { i++; const v = parseExpr(); if (peek() === ')') i++; return v; }
    const num = /^\d+(?:\.\d+)?/.exec(s.slice(i));
    if (num) { i += num[0].length; return Number(num[0]); }
    const ref = /^\$?([A-Z]+)\$?(\d+)/.exec(s.slice(i));
    if (ref) {
      i += ref[0].length;
      let col = 0;
      for (const ch of ref[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
      return getNum(col - 1, Number(ref[2]));
    }
    i = len;
    return NaN;
  }
  const v = parseExpr();
  if (i < len) return NaN; // 不支持函数、跨表引用等，交给调用方回退
  return v;
}

function summarizeBaseDiff(oldBase, newBase) {
  const flat = (base) => {
    const m = new Map();
    for (const s of (base && base.sheets) || []) {
      for (const r of s.rows || []) {
        const sku = String(r.sku || '').trim();
        if (sku) m.set(sku, r);
      }
    }
    return m;
  };
  const a = flat(oldBase);
  const b = flat(newBase);
  const out = { added: 0, removed: 0, util: 0, plus: 0, front: 0, model: 0 };
  for (const sku of b.keys()) if (!a.has(sku)) out.added++;
  for (const sku of a.keys()) if (!b.has(sku)) out.removed++;
  const sameNum = (x, y) => {
    const p = Number(x), q = Number(y);
    return (isFinite(p) || isFinite(q)) ? p === q : String(x || '') === String(y || '');
  };
  for (const [sku, r] of b) {
    const o = a.get(sku);
    if (!o) continue;
    if (!sameNum(o.utilMin, r.utilMin)) out.util++;
    if (!sameNum(o.plusMin, r.plusMin)) out.plus++;
    if (!sameNum(o.frontPrice, r.frontPrice)) out.front++;
    if (String(o.model || '') !== String(r.model || '')) out.model++;
  }
  return out;
}

function baseDiffList(oldBase, newBase, limit) {
  const flat = (base) => {
    const m = new Map();
    for (const s of (base && base.sheets) || []) {
      for (const r of s.rows || []) {
        const sku = String(r.sku || '').trim();
        if (sku) m.set(sku, r);
      }
    }
    return m;
  };
  const a = flat(oldBase);
  const b = flat(newBase);
  const out = [];
  const FIELDS = [['utilMin', '普惠阈值'], ['plusMin', '会员阈值'], ['frontPrice', '前台价'], ['model', '型号'], ['package', '套餐']];
  for (const [sku, r] of b) {
    const o = a.get(sku);
    if (!o) {
      out.push({ sku: sku, label: '新增 SKU', from: '', to: r.model || '' });
      continue;
    }
    for (const [f, label] of FIELDS) {
      const x = o[f], y = r[f];
      const p = Number(x), q = Number(y);
      const same = (isFinite(p) || isFinite(q)) ? p === q : String(x || '') === String(y || '');
      if (!same) out.push({ sku: sku, label: label, from: x, to: y });
    }
  }
  return { total: out.length, sample: out.slice(0, limit || 10) };
}

function baseDiffText(d) {
  const parts = [];
  if (d.added) parts.push('新增 SKU ' + d.added + ' 个');
  if (d.removed) parts.push('移除 SKU ' + d.removed + ' 个');
  if (d.util) parts.push('普惠阈值 ' + d.util + ' 处');
  if (d.plus) parts.push('会员阈值 ' + d.plus + ' 处');
  if (d.front) parts.push('前台价 ' + d.front + ' 处');
  if (d.model) parts.push('型号 ' + d.model + ' 处');
  return parts.length ? parts.join('、') : '与当前基表完全一致（没有变化）';
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
    const formulas = new Map();
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
        const fEl = cellEl.getElementsByTagNameNS('*', 'f')[0];
        if (fEl && fEl.textContent) formulas.set(col + '|' + rowNumber, fEl.textContent);
        cells[col] = value;
      }
      grid[rowNumber - 1] = cells;
    }
    // 计算简单公式（如阈值写成 =E58-1060 的情况）；不支持的公式保留空白
    if (formulas.size) {
      const resolving = new Set();
      const cellNum = (col, rowNum) => {
        const key = col + '|' + rowNum;
        const rowArr = grid[rowNum - 1] || [];
        if (formulas.has(key) && !resolving.has(key)) {
          const cached = rowArr[col];
          if (cached == null || cached === '') {
            resolving.add(key);
            const n = evalSimpleFormula(formulas.get(key), (c, r) => cellNum(c, r));
            resolving.delete(key);
            if (isFinite(n)) rowArr[col] = String(n);
          }
        }
        return xlsxToNumber(rowArr[col]);
      };
      for (const key of Array.from(formulas.keys())) {
        const parts = key.split('|');
        cellNum(Number(parts[0]), Number(parts[1]));
      }
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
      deduped: deduped.dropped,
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
  const prevBase = state.base;
  const summary = summarizeBaseDiff(prevBase, data);
  const summaryText = baseDiffText(summary);
  const detail = baseDiffList(prevBase, data, 12);
  if (!opts.skipConfirm) {
    const ok = window.confirm(
      '导入基表：' + file.name + '\n\n' +
        '类目：' + data.sheets.length + ' 个\n' +
        '行数：' + data.totalRows + ' 行（其中 ' + data.totalWithSku + ' 行有 SKU）\n' +
        '与当前基表对比：' + summaryText + '\n' +
        '已按 SKU 去重，重复 SKU 保留最后一条数据。\n\n' +
        '会覆盖当前使用的基表（已采集的价格按 SKU 保留）。确定导入？'
    );
    if (!ok) return;
  }
  await saveBaseOverride(data);
  state.base = data;
  flattenRows();
  renderAll();
  const toastText = '基表已导入：' + data.sheets.length + ' 个类目 · ' + data.totalRows + ' 行 · ' + data.totalWithSku + ' 行有 SKU；' + summaryText;
  setToast(toastText, 8000);
  logLine('导入基表：' + file.name + '；' + summaryText);
  if (!opts.skipConfirm) {
    if (detail.total) {
      const lines = detail.sample.map((d) => '· ' + d.sku + '（' + d.label + '）：' + (d.from == null || d.from === '' ? '空' : d.from) + ' → ' + (d.to == null || d.to === '' ? '空' : d.to));
      window.alert(
        '基表已导入并生效。\n\n' + summaryText + '\n\n' +
          (detail.total > detail.sample.length ? '前 ' + detail.sample.length + ' 条变化：\n' : '变化明细：\n') +
          lines.join('\n')
      );
    } else {
      window.alert(
        '基表已导入，但与当前基表完全一致：没有阈值 / 价格 / SKU 变化。\n\n' +
          '如果你刚在 Excel 里改过阈值，请确认已经保存（Ctrl+S）后再导入；\n' +
          '如果只改了「当前价格」列，插件不会把它当成阈值（当前价只来自采集）。'
      );
    }
  }
}


async function resetBase() {
  await refreshBaseFromStorage();
  if (!state.db.baseOverride) {
    setToast('当前已经是内置基表');
    return;
  }
  if (!window.confirm('恢复为扩展内置的基表？导入的基表会被丢弃（已采集的价格保留）。')) return;
  await saveBaseOverride(null);
  await reloadBase();
  renderAll();
  setToast('已恢复内置基表');
}

async function purgeCaptures() {
  if (state.running) {
    setToast('巡检进行中，先停止再清空');
    return;
  }
  if (!window.confirm('清空所有已采集的价格？\n\n只清采集结果，不影响基表和补录的 SKU。\n清空前会自动下载一份 JSON 备份到「下载」文件夹，需要时可「导入数据」恢复。')) return;
  try {
    exportJson(); // 先自动备份，避免误点清空后数据找不回
  } catch (e) {
    // 备份失败不阻止清空，但提示
  }
  state.db.captures = {};
  await saveDb();
  renderAll();
  setToast('已清空采集结果（清空前已自动下载 JSON 备份）');
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
  els.setDeviationConfirm.value = String(s.deviationConfirmLimit != null ? s.deviationConfirmLimit : 1500);
  els.setPreviewDelay.value = String(s.previewDelayMs != null ? s.previewDelayMs : 1000);
  els.setPatrolMode.value = s.patrolMode === 'background' ? 'background' : s.patrolMode === 'matrix' ? 'matrix' : 'foreground';
  if (els.setMatrixBatch) els.setMatrixBatch.value = String(s.matrixBatch != null ? s.matrixBatch : 6);
  if (els.setMatrixGap) els.setMatrixGap.value = String(s.matrixGapMs != null ? s.matrixGapMs : 300);
  if (els.setMatrixDelay) els.setMatrixDelay.value = String(s.matrixBatchDelay != null ? s.matrixBatchDelay : 1.5);
  if (els.setMatrixShatter) els.setMatrixShatter.checked = s.matrixShatter !== false;
  if (els.setMatrixWindowMode) els.setMatrixWindowMode.value = s.matrixWindowMode === false ? 'tabs' : 'windows';
  els.setAiEnabled.checked = s.aiEnabled !== false;
  els.setAiEndpoint.value = s.aiEndpoint || 'https://gateway.example.com/v1';
  els.setAiModel.value = s.aiModel || 'deepseek-flash';
  els.setAiKey.value = s.aiApiKey || '';
  els.setAiVerifyMode.value = s.aiVerifyMode || 'fallback';
  els.setOfficialApiUrl.value = s.officialApiUrl || 'http://127.0.0.1:18765';
  loadApiAccountInfo().catch(() => {});
  const latest = latestRawCapture();
  els.debugBox.textContent = latest
    ? JSON.stringify({ sku: latest.sku, at: latest.raw.at, identity: latest.raw.identity, source: latest.raw.source, main: latest.raw.main, plus: latest.raw.plus, hand: latest.raw.hand, priceChanges: latest.raw.priceChanges, candidates: latest.raw.candidates }, null, 2)
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
  const prev = state.db.settings || {};
  state.db.settings = {
    batchSize: batch,
    delayMin: delayMin,
    delayMax: delayMax,
    skipCapturedToday: !!els.setSkipToday.checked,
    scope: els.setScope.value === 'current' ? 'current' : 'all',
    keepTab: !!els.setKeepTab.checked,
    deviationLimit: Math.max(0, Math.floor(Number(els.setDeviationLimit.value) || 0)),
    deviationConfirmLimit: Math.max(0, Math.floor(Number(els.setDeviationConfirm.value) || 0)),
    previewDelayMs: Math.max(300, Math.min(5000, Math.floor(Number(els.setPreviewDelay.value) || 1000))),
    patrolMode: els.setPatrolMode.value === 'matrix' ? 'matrix' : els.setPatrolMode.value === 'background' ? 'background' : 'foreground',
    matrixBatch: Math.max(MATRIX_MIN_BATCH, Math.min(MATRIX_MAX_BATCH, Math.floor(Number(els.setMatrixBatch.value) || 6))),
    matrixGapMs: Math.max(120, Math.min(2000, Math.floor(Number(els.setMatrixGap.value) || 300))),
    matrixBatchDelay: Math.max(0, Math.min(30, Number(els.setMatrixDelay.value) || 0)),
    matrixShatter: !!(els.setMatrixShatter && els.setMatrixShatter.checked),
    matrixWindowMode: !(els.setMatrixWindowMode && els.setMatrixWindowMode.value === 'tabs'),
    aiEnabled: !!els.setAiEnabled.checked,
    aiEndpoint: (els.setAiEndpoint.value || '').trim() || 'https://gateway.example.com/v1',
    aiModel: (els.setAiModel.value || '').trim() || 'deepseek-flash',
    aiApiKey: (els.setAiKey.value || '').trim(),
    aiVerifyMode: ['off', 'fallback', 'all'].indexOf(els.setAiVerifyMode.value) >= 0 ? els.setAiVerifyMode.value : 'fallback',
    officialApiUrl: (els.setOfficialApiUrl.value || '').trim() || 'http://127.0.0.1:18765',
    // 保留「重采默认账号/轨道」选择
    rerunRemember: !!prev.rerunRemember,
    rerunIdentity: prev.rerunIdentity || '',
    rerunForeground: typeof prev.rerunForeground === 'boolean' ? prev.rerunForeground : null,
    rerunMode: prev.rerunMode || '',
    rerunMatrix: !!prev.rerunMatrix
  };
  await saveDb();
  applyTrackSelectionUI();
  updateAiStatusChip();
  updateApiStatusChip();
  renderRunUI();
  setToast('设置已保存');
}

// ---------------- 基表管理 ----------------
function currentEffectiveBase() {
  return state.db.baseOverride || state.base;
}

// 打开「管理基表」前先从存储里重新读一次基表，避免旧标签页拿着过期状态把新基表覆盖掉
async function refreshBaseFromStorage() {
  try {
    const got = await chrome.storage.local.get(BASE_KEY);
    state.db.baseOverride = (got && got[BASE_KEY]) || null;
  } catch (e) {
    // 读不出来就沿用内存里的
  }
  await reloadBase();
}

async function openBaseManager() {
  await refreshBaseFromStorage();
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
  await saveBaseOverride(draft);
  await reloadBase();
  renderAll();
  setToast('基表已保存：' + draft.sheets.length + ' 个类目 · ' + total + ' 行 · ' + withSku + ' 行有 SKU（已保存到本机）');
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
    // 矩阵速采：每个标签页对应一个 slot，按 tabId 路由（并行读取）
    if (state.matrix && state.matrix.pending && sender && sender.tab && sender.tab.id != null) {
      const slot = state.matrix.pending.get(sender.tab.id);
      if (slot) {
        matrixSlotFinish(slot, msg);
        return;
      }
    }
    const run = state.run;
    if (!run) return;
    if (!sender || !sender.tab || sender.tab.id !== run.runnerTabId) return;
    if (!state.pending) {
      state.pendingBuffer = { tabId: sender.tab.id, msg: msg, at: Date.now() };
      return;
    }
    if (msg.sku !== state.pending.sku) return;
    const p = state.pending;
    p.resolve(msg);
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    const url = changeInfo.url || (tab && tab.url) || '';
    // 矩阵速采：某个页面跳到登录页时，只把这一页判失败，其余页面继续读
    if (state.matrix && state.matrix.pending && state.matrix.pending.has(tabId)) {
      if (url && /passport\.jd\.com|plogin\.jd\.com|login\.jd\.com/i.test(url)) {
        logLine('⚠ 矩阵页面跳转到电商平台登录页，登录可能已失效');
        const slot = state.matrix.pending.get(tabId);
        matrixSlotFinish(slot, { ok: false, reason: '需要登录电商平台账号（页面跳到了登录页）' });
      }
      return;
    }
    const run = state.run;
    if (!run || tabId !== run.runnerTabId) return;
    if (url && /passport\.jd\.com|plogin\.jd\.com|login\.jd\.com/i.test(url)) {
      logLine('⚠ 页面跳转到电商平台登录页，登录可能已失效');
      failPending('需要登录电商平台账号（页面跳到了登录页）');
    }
  });

  chrome.windows.onRemoved.addListener((winId) => {
    if (state.board.windowId === winId) {
      matrixBoardDetached();
      logLine('矩阵大屏窗口已关闭（采集继续；可点状态栏「矩阵大屏」重新打开）');
    }
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    if (state.board.tabId === tabId) {
      matrixBoardDetached();
    }
    // 矩阵速采：被外部关掉的页面判失败即可，不中断整轮
    if (state.matrix && state.matrix.pending && state.matrix.pending.has(tabId)) {
      const slot = state.matrix.pending.get(tabId);
      matrixSlotFinish(slot, { ok: false, reason: '矩阵标签页被关闭了' });
      return;
    }
    const run = state.run;
    if (!run || tabId !== run.runnerTabId) return;
    failPending('采集用的后台标签页被关闭了');
    if (state.running) {
      state.stopped = true;
      state.paused = false;
      logLine('采集用的后台标签页被关闭，巡检停止');
    }
  });

  // 多标签页同步：基表单独存 key，别的标签页改了基表时这里跟着更新，
  // 避免"两个工作台同时开着、旧标签页把新基表覆盖回去"。
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || state.running) return;
    const change = changes[BASE_KEY];
    if (!change) return;
    const next = change.newValue || null;
    const cur = state.db && state.db.baseOverride ? state.db.baseOverride : null;
    // 同一个页面自己写入时 storage 读回来的键顺序可能不同，用稳定序列化避免误判为“其他标签页更新”
    if (stableStringify(next) === stableStringify(cur)) return;
    state.db.baseOverride = next;
    reloadBase()
      .then(() => {
        flattenRows();
        renderAll();
        setToast(next ? '基表已在其他工作台标签页更新，已同步' : '基表已恢复为内置（其他标签页操作），已同步');
      })
      .catch(() => {});
  });
}

function bindEvents() {
  document.querySelectorAll('.trackOpt').forEach((btn) => {
    btn.addEventListener('click', () => setTrack(btn.dataset.track).catch(() => {}));
  });
  els.aiBtn.addEventListener('click', () => {
    openSettings();
    setTimeout(() => {
      if (els.setAiKey) els.setAiKey.scrollIntoView({ block: 'center' });
    }, 80);
  });
  els.aiTestBtn.addEventListener('click', () => testAiConnection().catch(() => {}));
  els.apiAddBtn.addEventListener('click', () => addApiAccountRow());
  els.apiRefreshBtn.addEventListener('click', () => loadApiAccountInfo().catch(() => {}));
  els.apiAccountList.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-api-action]');
    if (!btn) return;
    const row = btn.closest('.apiRow');
    if (!row) return;
    saveApiAccountRow(row, btn.dataset.apiAction === 'test').catch(() => {});
  });
  els.aiStatusChip.addEventListener('click', () => {
    openSettings();
    setTimeout(() => {
      if (els.setAiKey) els.setAiKey.scrollIntoView({ block: 'center' });
    }, 80);
  });
  els.apiStatusChip.addEventListener('click', () => {
    if (state.apiStatus && state.apiStatus.ok) {
      setToast('官方API账号：' + (state.apiStatus.accounts || []).join(' / '));
    } else {
      checkApiBridge().then(() => setToast('官方API 未连接：确认「巡检插件-矩阵版\\启动API桥.py」正在运行（与双轨版共用 127.0.0.1:18765，只需启动一个）'));
    }
  });
  els.runOfficialBtn.addEventListener('click', () => runOfficialApi().catch((e) => setToast('官方API采集失败：' + errText(e))));

  els.runUtilBtn.addEventListener('click', () => startRun('util'));
  els.runPlusBtn.addEventListener('click', () => startRun('plus'));
  if (els.runMatrixUtilBtn) els.runMatrixUtilBtn.addEventListener('click', () => startRun('util', { matrix: true }));
  if (els.runMatrixPlusBtn) els.runMatrixPlusBtn.addEventListener('click', () => startRun('plus', { matrix: true }));
  if (els.mxOpenBtn) {
    els.mxOpenBtn.addEventListener('click', () => {
      matrixBoardOpen(false).then((ok) => {
        if (ok) setToast('矩阵大屏已打开（独立窗口）');
      }).catch((e) => setToast('矩阵大屏打开失败：' + errText(e)));
    });
  }
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
    // 预选身份：如果选中的手动改价都在同一列，就预选那个身份；否则用上次重采/巡检身份
    let anyUtilManual = false;
    let anyPlusManual = false;
    let noManual = 0;
    for (const sku of skus) {
      const cap = state.db.captures[sku];
      const manualPlus = !!(cap && cap.plus && cap.plus.kind === 'manual');
      const manualUtil = !!(cap && cap.util && cap.util.kind === 'manual');
      if (manualPlus) anyPlusManual = true;
      if (manualUtil) anyUtilManual = true;
      if (!manualPlus && !manualUtil) noManual++;
    }
    let prefill;
    if (anyPlusManual && !anyUtilManual) prefill = 'plus';
    else if (anyUtilManual && !anyPlusManual) prefill = 'util';
    else prefill = defaultRerunChoice().identity;
    openRerunDialog({
      identity: prefill,
      hint: '重采选中的 ' + skus.length + ' 个 SKU（其中未改价 ' + noManual + ' 个）\n请选择用哪个账号、哪条轨道采集。'
    }).then((choice) => {
      if (!choice) return;
      startRerun({ skus: skus }, choice).catch(() => {});
    });
  });
  els.tabWorkbench.addEventListener('click', () => switchView('workbench'));
  els.tabOverview.addEventListener('click', () => switchView('overview'));
  els.tabCompare.addEventListener('click', () => switchView('compare'));
  els.cmpCollectBtn.addEventListener('click', () => {
    if (state.running) {
      setToast('已有巡检在进行中');
      return;
    }
    const info = compareSkuList();
    if (!info.skus.length) {
      setToast('没有可采集的比价 SKU');
      return;
    }
    openRerunDialog({
      hint: '一键采集比价产品：' + info.groups + ' 组同款 / ' + info.skus.length + ' 个 SKU（两个店铺都算）。\n' +
        '请选择用哪个账号（普惠 / 会员）和哪条轨道采集；选中账号后请确认浏览器当前登录的就是该账号。'
    }).then((choice) => {
      if (!choice) return;
      startRerun({ skus: info.skus }, choice).catch(() => {});
    });
  });
  els.cmpFilterAll.addEventListener('click', () => {
    state.compareFilter = 'all';
    renderCompare();
  });
  els.cmpFilterDiff.addEventListener('click', () => {
    state.compareFilter = 'diff';
    renderCompare();
  });
  els.cmpFilterMissing.addEventListener('click', () => {
    state.compareFilter = 'missing';
    renderCompare();
  });
  els.cmpExportBtn.addEventListener('click', exportCompareCsv);
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
    if (state.matrix) {
      logLine('已请求停止，正在关闭矩阵页面…');
      matrixAbortPending('已停止');
    } else {
      logLine('已请求停止，当前步骤结束后停止…');
    }
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
  els.rerunStart.addEventListener('click', (e) => {
    e.preventDefault();
    confirmRerunChoice();
  });
  els.rerunCancel.addEventListener('click', (e) => {
    e.preventDefault();
    closeRerunDialog(null);
  });
  els.rerunDialog.addEventListener('cancel', (e) => {
    e.preventDefault();
    closeRerunDialog(null);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && previewState.winId != null && !previewState.pinned) closePreviewWindow();
  });
  window.addEventListener('beforeunload', (e) => {
    closePreviewWindow();
    if (state.running) {
      e.preventDefault();
      e.returnValue = '';
    } else {
      matrixBoardSayBye();
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
    const matrix = URL_PARAMS.get('matrix') === '1';
    const matrixBatch = Math.max(MATRIX_MIN_BATCH, Math.min(MATRIX_MAX_BATCH, Number(URL_PARAMS.get('matrixBatch')) || 6));
    state.db.settings = {
      batchSize: batch,
      delayMin: delayMin,
      delayMax: delayMax,
      skipCapturedToday: true,
      scope: 'all',
      keepTab: false,
      patrolMode: matrix ? 'matrix' : 'foreground',
      matrixBatch: matrixBatch,
      matrixGapMs: 300,
      matrixBatchDelay: 1.5,
      matrixShatter: true
    };
    state.db.autoRun = { at: new Date().toISOString(), identity: identity, batch: batch, matrix: matrix };
    await saveDb();
    renderRunUI();
    logLine('检测到自动巡检参数：身份=' + identity + '，本次 ' + batch + ' 个' + (matrix ? '（矩阵速采，每批 ' + matrixBatch + ' 个）' : '') + '，等待 2 秒开始…');
    await sleep(2000);
    await startRun(identity, { auto: true, matrix: matrix });
  } catch (e) {
    logLine('自动巡检启动失败：' + errText(e));
    try {
      autoExport();
    } catch (e2) {
      logLine('自动导出失败：' + errText(e2));
    }
  }
}

// ---------------- 双轨状态：AI / 官方API ----------------
function updateAiStatusChip() {
  const chip = els.aiStatusChip;
  if (!chip) return;
  const s = state.db && state.db.settings;
  const ready = !!(s && s.aiEnabled && s.aiApiKey && s.aiEndpoint);
  chip.className = 'chip ' + (ready ? 'ok' : 'warn');
  chip.textContent = ready ? ('AI 已就绪 · ' + (s.aiModel || 'deepseek-flash')) : 'AI 未配置（点此设置）';
  chip.title = ready ? ('接口：' + s.aiEndpoint + '；点击打开 AI 设置') : '点击打开设置填写 AI Key';
}

function updateApiStatusChip() {
  const chip = els.apiStatusChip;
  if (!chip) return;
  const st = state.apiStatus;
  if (!st) {
    chip.className = 'chip warn';
    chip.textContent = '官方API 未检测（点此重试）';
    return;
  }
  if (st.ok) {
    const n = Array.isArray(st.accounts) ? st.accounts.length : 0;
    chip.className = 'chip ok';
    chip.textContent = '官方API 已连接 · ' + n + ' 个账号';
    chip.title = '账号：' + (st.accounts || []).join(' / ') + ((st.skipped && st.skipped.length) ? '\n未启用：' + st.skipped.join('；') : '');
  } else {
    chip.className = 'chip warn';
    chip.textContent = '官方API 未启动（点此检测）';
    chip.title = st.error || '请运行「巡检插件-矩阵版\\启动API桥.py」（与双轨版共用 127.0.0.1:18765）';
  }
}

async function checkApiBridge() {
  const s = state.db && state.db.settings;
  const base = String((s && s.officialApiUrl) || 'http://127.0.0.1:18765').replace(/\/+$/, '');
  try {
    const res = await fetch(base + '/healthz', { method: 'GET' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    state.apiStatus = { ok: true, accounts: data.accounts || [], skipped: data.skipped || [], initErrors: data.init_errors || [] };
  } catch (e) {
    state.apiStatus = { ok: false, error: errText(e) };
  }
  updateApiStatusChip();
}

async function testAiConnection() {
  const s = state.db.settings;
  const endpoint = String(s.aiEndpoint || '').replace(/\/+$/, '');
  if (!endpoint || !s.aiApiKey) {
    setToast('AI 未配置：先把接口和 Key 填上');
    return;
  }
  setToast('正在测试 AI 连接…');
  try {
    const res = await fetch(endpoint + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + s.aiApiKey },
      body: JSON.stringify({
        model: s.aiModel || 'deepseek-flash',
        max_tokens: 10,
        messages: [{ role: 'user', content: '只回复两个字符：OK' }]
      })
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const reply = String((((data.choices || [])[0] || {}).message || {}).content || '').trim();
    setToast('AI 连接正常（' + (s.aiModel || '') + '）：' + (reply.slice(0, 20) || '已返回'));
  } catch (e) {
    setToast('AI 连接失败：' + errText(e));
  }
  updateAiStatusChip();
}

// ---------------- 官方API账号（在设置里直接填写/保存） ----------------
function officialApiBase() {
  return String((state.db.settings && state.db.settings.officialApiUrl) || 'http://127.0.0.1:18765').replace(/\/+$/, '');
}

// 用基表里第一个「大家电」SKU 做保存后的自检
function firstApiTestSku() {
  const row = state.rows.find((r) => r.sheet === '大家电' && r.sku);
  return row ? row.sku : (state.rows.find((r) => r.sku) || {}).sku || '';
}

function buildApiAccountRow(acc, index) {
  const wrap = document.createElement('div');
  wrap.className = 'apiGrid apiRow';
  wrap.dataset.originalName = acc && acc.name ? acc.name : '';
  const head = document.createElement('div');
  head.className = 'apiRowHead';
  const title = document.createElement('b');
  title.textContent = '供应商 ' + index + (acc && acc.name ? '：' + acc.name : '（新增）');
  head.appendChild(title);
  const st = document.createElement('span');
  st.className = 'apiTag';
  if (!acc || !acc.name) {
    st.classList.add('muted');
    st.textContent = '待填写';
  } else if (acc.loaded) {
    st.classList.add('ok');
    st.textContent = '已启用';
  } else {
    st.classList.add('warn');
    st.textContent = '未启用（缺字段或被跳过）';
  }
  head.appendChild(st);
  wrap.appendChild(head);

  const fields = [
    ['name', '账号名', 'text', acc && acc.name ? acc.name : '', '例如：品牌B大家电自营店'],
    ['appKey', 'appKey', 'text', '', acc && acc.appKeyMasked ? '已保存：' + acc.appKeyMasked + '（留空不改）' : '电商平台开放平台的 appKey'],
    ['appSecret', 'appSecret', 'password', '', acc && acc.hasSecret ? '已保存（留空不改，粘贴新值即替换）' : '32 位 appSecret'],
    ['accessToken', 'accessToken', 'password', '', acc && acc.hasToken ? '已保存（尾号 …' + acc.accessTokenTail + '，留空不改）' : 'accessToken'],
    ['refreshToken', 'refreshToken', 'password', '', '可选，留空不改'],
    ['testSku', '测试 SKU', 'text', '', '可选：保存并测试时用这个 SKU']
  ];
  for (const item of fields) {
    const key = item[0];
    const lab = document.createElement('label');
    const nameSpan = document.createElement('span');
    nameSpan.className = 'apiLabel';
    nameSpan.textContent = item[1];
    const input = document.createElement('input');
    input.className = 'input api-' + key;
    input.type = item[2];
    input.placeholder = item[4];
    if (item[3]) input.value = item[3];
    if (item[2] === 'password') input.autocomplete = 'new-password';
    lab.appendChild(nameSpan);
    lab.appendChild(input);
    wrap.appendChild(lab);
  }
  const actions = document.createElement('div');
  actions.className = 'apiActions';
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'btn ghost';
  saveBtn.dataset.apiAction = 'save';
  saveBtn.textContent = '保存';
  const testBtn = document.createElement('button');
  testBtn.type = 'button';
  testBtn.className = 'btn ghost';
  testBtn.dataset.apiAction = 'test';
  testBtn.textContent = '保存并测试';
  actions.appendChild(saveBtn);
  actions.appendChild(testBtn);
  wrap.appendChild(actions);
  return wrap;
}

function addApiAccountRow() {
  if (!els.apiAccountList) return;
  const index = els.apiAccountList.querySelectorAll('.apiRow').length + 1;
  const row = buildApiAccountRow(null, index);
  els.apiAccountList.appendChild(row);
  const nameInput = row.querySelector('.api-name');
  if (nameInput) nameInput.focus();
  if (row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
}

let apiAccountSeq = 0;

async function loadApiAccountInfo() {
  if (!els.apiAccountList) return;
  const seq = ++apiAccountSeq;
  const base = officialApiBase();
  els.apiAccountList.textContent = '';
  if (els.apiAccountInfo) els.apiAccountInfo.textContent = '';
  try {
    const res = await fetch(base + '/api/accounts', { cache: 'no-store' });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || ('HTTP ' + res.status));
    if (seq !== apiAccountSeq) return;
    const config = data.config || [];
    if (!config.length) {
      const empty = document.createElement('div');
      empty.className = 'apiAccountInfo';
      empty.textContent = '还没有 API 账号，点下面「+ 新增供应商账号」填写 appKey / appSecret / accessToken。';
      els.apiAccountList.appendChild(empty);
    } else {
      config.forEach((acc, i) => els.apiAccountList.appendChild(buildApiAccountRow(acc, i + 1)));
    }
    if (els.apiAccountInfo) {
      const loaded = (data.accounts || []).join(' / ') || '无';
      let info = '桥已连接；已启用账号：' + loaded;
      if (data.skipped && data.skipped.length) info += '；跳过：' + data.skipped.join('；');
      if (data.init_errors && data.init_errors.length) info += '；提示：' + data.init_errors.join('；');
      els.apiAccountInfo.textContent = info;
    }
  } catch (e) {
    if (seq !== apiAccountSeq) return;
    els.apiAccountList.appendChild(buildApiAccountRow(null, 1));
    if (els.apiAccountInfo) els.apiAccountInfo.textContent = 'API 桥未连接：' + errText(e) + '（确认“启动API桥.py”在运行）';
  }
}

function apiRowValues(row) {
  const v = (cls) => {
    const el = row.querySelector('.' + cls);
    return el ? String(el.value || '').trim() : '';
  };
  return {
    originalName: row.dataset.originalName || '',
    name: v('api-name'),
    appKey: v('api-appKey'),
    appSecret: v('api-appSecret'),
    accessToken: v('api-accessToken'),
    refreshToken: v('api-refreshToken'),
    testSku: v('api-testSku')
  };
}

async function saveApiAccountRow(row, withTest) {
  const base = officialApiBase();
  const vals = apiRowValues(row);
  if (!vals.originalName && (!vals.appKey || !vals.appSecret || !vals.accessToken)) {
    setToast('新增供应商账号需要填完整的账号名 / appKey / appSecret / accessToken');
    return;
  }
  if (vals.originalName && !vals.appKey && !vals.appSecret && !vals.accessToken && !vals.refreshToken && (!vals.name || vals.name === vals.originalName)) {
    setToast('没有要保存的内容（留空的字段保持原值）');
    return;
  }
  const payload = {
    originalName: vals.originalName,
    name: vals.name || vals.originalName,
    appKey: vals.appKey,
    appSecret: vals.appSecret,
    accessToken: vals.accessToken,
    refreshToken: vals.refreshToken,
    identity: ''
  };
  const btn = row.querySelector('button[data-api-action="' + (withTest ? 'test' : 'save') + '"]');
  if (btn) btn.disabled = true;
  setToast('正在保存到 API 桥…');
  try {
    const res = await fetch(base + '/api/accounts/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || ('HTTP ' + res.status));
    logLine('API 账号已更新：' + (data.accounts || []).join(' / '));
    await checkApiBridge();
    await loadApiAccountInfo();
    if (!withTest) {
      setToast('已保存并生效：' + (data.accounts || []).join(' / '));
      return;
    }
    const sku = vals.testSku || firstApiTestSku();
    if (!sku) {
      setToast('已保存（基表里没有可测试的 SKU）');
      return;
    }
    setToast('已保存，正在用 ' + sku + ' 试读价格…');
    const t = await fetch(base + '/api/accounts/test?sku=' + encodeURIComponent(sku) + '&name=' + encodeURIComponent(vals.name || vals.originalName), { cache: 'no-store' });
    const td = await t.json();
    if (td.ok) {
      setToast('保存成功：' + sku + ' 官方到手价 ¥' + td.price + '（' + (td.source || '') + '）');
      logLine('API 自检通过：' + sku + ' → ' + td.price + '（' + (td.source || '') + '）');
    } else {
      const reason = (td.errors && td.errors[0]) || td.error || (td.missing && td.missing.length ? '该 SKU 没有返回价格（账号可能没这个 SKU 的权限）' : '未知原因');
      setToast('已保存，但试读失败：' + String(reason).slice(0, 180));
      logLine('API 自检失败：' + String(reason).slice(0, 300));
    }
  } catch (e) {
    setToast('保存失败：' + errText(e) + '（确认 API 桥在运行）');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ---------------- 初始化 ----------------
// 兜底：脚本出异常时在页面上提示，而不是无声卡住
window.addEventListener('error', (ev) => {
  try {
    const msg = (ev && ev.message) || '未知脚本错误';
    const box = document.getElementById('pageErrorBox');
    if (box) return;
    const div = document.createElement('div');
    div.id = 'pageErrorBox';
    div.style.cssText = 'margin:12px 22px;padding:10px 14px;border:1px solid #ffccc7;background:#fff1f0;color:#a8071a;border-radius:8px;font-size:12px;line-height:1.6;';
    div.textContent = '页面脚本错误：' + msg + '（按 F12 打开控制台可看详情，截图发我即可）';
    document.body.insertBefore(div, document.body.firstChild);
    console.error('page error:', ev && ev.error ? ev.error : msg);
  } catch (e) {
    // 忽略
  }
});
window.addEventListener('unhandledrejection', (ev) => {
  console.error('unhandled rejection:', ev && ev.reason);
});

async function init() {
  await loadDb();
  state.base = await loadBase();
  flattenRows();
  if (state.db.dismissedBanner) els.riskBanner.classList.add('hidden');
  bindEvents();
  setupRuntimeListeners();
  ensureBoardChannel();
  applyTrackIdentity();
  checkApiBridge();
  switchView('workbench');
  if (state.baseUpgraded) {
    setToast('内置基表已更新（' + (state.baseUpgraded.to ? fmtTime(state.baseUpgraded.to) : '最新版') + '），已下架 / 手动改价状态已保留', 6500);
  }
  if (IS_AUTORUN) {
    await autoRunBoot();
  }
}

init().catch((err) => {
  const box = document.createElement('div');
  box.style.cssText = 'margin:20px;padding:16px;border:1px solid #ffccc7;background:#fff1f0;color:#a8071a;border-radius:8px;font-size:13px;line-height:1.7;';
  box.textContent = '工作台初始化失败：' + errText(err) + '\n请到 ' + EXTENSIONS_URL + ' 重新加载扩展试试。';
  document.body.insertBefore(box, document.body.firstChild);
});




