/* ============================================================================
 * 电商平台市占率数据工作台 · 工作台界面与编排（MV3 扩展页，ES Module）
 * ----------------------------------------------------------------------------
 * 职责：四页 UI（工作台 / 匹配库 / 统计看板 / 设置与帮助）+ 全流程编排：
 *       导入 xlsx → 绑定类目 → 分析补数 → 在线补采 → 人工修正 → 导出 / 统计。
 *
 * 硬约束：
 *  1) 扩展页 CSP 禁止内联脚本 / eval / 远程资源：本文件用 <script type="module">
 *     加载，lib 用动态 import()；失败不白屏，给中文提示。
 *  2) 规则逻辑（尺寸段 / 价格段 / 金额解析 / 表头识别 / 补数流水线）全部在 lib/，
 *     本文件不复制任何规则实现，只做编排与展示。
 *  3) 数据只存本机 chrome.storage.local；无 chrome API（如直接打开文件）时用内存
 *     Map 降级，方便本地预览与截图。
 *
 * 依赖的 lib 接口见 DESIGN.md 第 10 节（已与 xlsx-core / jd-capture 对齐）。
 * ========================================================================== */

'use strict';

/* ============================ 常量与配置 ============================ */

const APP_VERSION = '2.1.7';

const STORAGE_KEYS = {
  library: 'ds.library.v1',
  session: 'ds.session.v1',
  settings: 'ds.settings.v1',
  captures: 'ds.captures.v1',
};

// lib 模块清单：动态 import，缺失时降级为「数据引擎未就绪」
const LIB_SPECS = [
  ['rules', './lib/rules.js', '规则引擎（尺寸段/价格段/金额）'],
  ['xlsxRead', './lib/xlsx-read.js', 'xlsx 读取'],
  ['xlsxWrite', './lib/xlsx-write.js', 'xlsx 写出'],
  ['headerMap', './lib/header-map.js', '表头自适应识别'],
  ['storeSchema', './lib/store-schema.js', '匹配库数据模型'],
  ['pipeline', './lib/pipeline.js', '补数流水线与统计'],
  ['captureClient', './lib/capture-client.js', '在线采集驱动器'],
];

// 设置默认值（DESIGN.md 4.4 / 16.6）。深拷贝时用 cloneSettings()。
const DEFAULT_SETTINGS = {
  version: 1,
  capture: {
    batchSize: 0,
    // v2.1.5：每批上限真实生效（settings.capture.maxBatch，5~100，默认 20）
    maxBatch: 20,
    batchLimit: 20,
    anomalyWaitSec: 60,
    delayMin: 5,
    delayMax: 10,
    retries: 1,
    skipCapturedToday: true,
    keepTab: false,
    // v2.1 多采样复核
    mode: 'smart',
    maxSamples: 3,
    tolerancePct: 0.01,
    toleranceAbs: 30,
    // v2.1.4 风控冷却
    cooldownMinutes: 60,
    autoPauseOnRisk: true,
    cooldownUntil: '',
  },
  price: {
    prefer: ['hand', 'main', 'plus'],
    bandBoundary: 'rightOpen',
    minPlausible: 30,
    boundaryMarginPct: 0.01,
  },
  mapping: { overrides: {} },
  ui: {
    lastPage: 'workbench',
    bannerDismissed: false,
    theme: 'auto',
    migratedV213: false,
    seedVersion: '',
    confirmedWrites: 0,
    // v2.1.5 表格列显示（默认 1440 下隐藏占宽的成交金额/采样，让核心列放得下）
    tableCols: {
      match: { name: true, shop: true, brand: true, model: true, package: true, size: true, price: true, priceNow: true, amount: false, sample: false, source: true, status: true, libState: true, op: true },
      overview: { name: true, shop: true, brand: true, model: true, package: true, size: true, price: true, priceNow: true, amount: false, sample: false, source: true, status: true, libState: true, op: true },
    },
    rowDensity: 'normal',
    // v2.1.5 匹配库保护：升级快照时间
    libraryBackupV215At: '',
  },
};

const DEFAULT_SESSION = { version: 1, reports: [], activeReportId: null, updatedAt: '' };

// 价格档位（只用于展示与 settings.price.prefer，不参与任何取价规则）
const PRICE_KIND_LABELS = { hand: '到手价', main: '电商平台价', plus: 'PLUS价' };
const CAPTURE_MODE_LABELS = { smart: '智能复核', double: '固定双采', single: '单次采样' };
const CAPTURE_MODE_HINTS = {
  smart: '智能复核：先采 1 次，命中疑点才再采',
  double: '固定双采：每个 SKU 采 2 次，超容差再补采',
  single: '单次采样：旧行为，不核对一致性',
};
const REVIEW_TEXT = '需确认';
const REVIEW_CONFIRMED_TEXT = '已确认';
// 型号/套餐来源文案（与 lib 的 source.model 取值对齐）
const MODEL_SOURCE_LABELS = { 列: '榜单列', 名称: '商品名识别', 库: '匹配库', 页面采集: '页面采集', 手动: '手动', '': '' };

// 页面名
const PAGES = ['workbench', 'overview', 'library', 'stats', 'settings'];
const PAGE_TITLES = { workbench: '工作台', overview: '总览', library: '匹配库', stats: '统计看板', settings: '设置与帮助' };

const ITEM_URL = (sku) => 'https://item.shop.example.com/' + encodeURIComponent(String(sku)) + '.html';

// 下拉候选的最后兜底（仅在 lib/rules.js 与种子数据都不可用时用于展示；规则计算仍由 lib 负责）
const FALLBACK_SIZE_BANDS = [
  '55英寸', '65英寸', '75英寸', '86/85英寸', '98/100英寸',
  '其他尺寸(43英寸)', '其他尺寸(110英寸)', '其他尺寸(120英寸)', '其他尺寸(150英寸)', '其他',
];
const FALLBACK_PRICE_BANDS = [
  '1000元以下', '1000元至2000元', '2000元至2500元', '2500元至3000元', '3000元至3500元',
  '3500元至4000元', '4000元至4500元', '4500元至5000元', '5000元至5500元', '5500元至6000元',
  '6000元至7000元', '7000元至8000元', '8000元至9000元', '9000元至10000元', '10000元至15000元',
  '15000元至20000元', '20000元至25000元', '25000元以上',
];

// 预览模式兜底种子：仅当既没有存储的匹配库、又读不到 data/base-skus.json 时使用
// （正常扩展环境一定走内置种子，这里是防止直接 file:// 打开时白屏）
const DEMO_SEED = {
  schema: 'market-share.base/v1',
  generatedAt: '预览模式内置样例',
  sizeBands: FALLBACK_SIZE_BANDS,
  priceBands: FALLBACK_PRICE_BANDS,
  stores: {
    '大家电 会议电视': {
      name: '大家电 会议电视',
      note: '预览样例',
      rows: {
        '100200174986': { sku: '100200174986', name: '海信100英寸会议电视会议平板电视一体机4+128GB MiniLED', brand: '海信', size: '98/100英寸', price: '10000元至15000元' },
        '100200174968': { sku: '100200174968', name: '海信85英寸会议电视会议平板电视一体机3+64GB', brand: '海信', size: '86/85英寸', price: '5000元至5500元' },
        '100116554211': { sku: '100116554211', name: '创维（Skyworth）75英寸会议电视会议平板电视一体机', brand: '创维（Skyworth）', size: '75英寸', price: '3500元至4000元' },
        '100214957866': { sku: '100214957866', name: '创维65英寸会议电视会议平板一体机 3+64G', brand: '创维', size: '65英寸', price: '2500元至3000元' },
        '100214957902': { sku: '100214957902', name: '创维55英寸会议电视会议平板一体机', brand: '创维', size: '55英寸', price: '2000元至2500元' },
        '100288322432': { sku: '100288322432', name: '品牌B75英寸会议电视平板一体机4K超清无线投屏', brand: '品牌B', size: '75英寸', price: '5500元至6000元' },
        '100156501271': { sku: '100156501271', name: 'TCL86英寸会议电视平板一体机3+32G无线投屏', brand: 'TCL', size: '86/85英寸', price: '5000元至5500元' },
        '100300873009': { sku: '100300873009', name: '海信100寸会议大屏100XP3E+3年保修', brand: '海信', size: '98/100英寸', price: '8000元至9000元' },
        '100200223833': { sku: '100200223833', name: '索尼（SONY）FW-55BZ35L纯净版电视机55英寸4K', brand: '索尼（SONY）', size: '55英寸', price: '4500元至5000元' },
        '100264663734': { sku: '100264663734', name: '索尼（SONY）FW-75BZ30L纯净版电视机75英寸', brand: '索尼（SONY）', size: '75英寸', price: '8000元至9000元' },
        '100264663756': { sku: '100264663756', name: '索尼（SONY）FW-85BZ40L不反光电视机85英寸', brand: '索尼（SONY）', size: '86/85英寸', price: '20000元至25000元' },
        '100275467103': { sku: '100275467103', name: '长虹（CHANGHONG）会议电视75Y600包安装75英寸', brand: '长虹（CHANGHONG）', size: '75英寸', price: '3500元至4000元' },
        '100311780494': { sku: '100311780494', name: '品牌B55英寸会议电视平板一体机4K超清', brand: '品牌B', size: '55英寸', price: '3000元3500元' },
        '100354518296': { sku: '100354518296', name: '海信【京海系列】136英寸Micro LED巨幕', brand: '海信', size: '其他（136英寸）', price: '25000元以上' },
        '10212841245563': { sku: '10212841245563', name: 'Hiseusnc海信视智能网络电视机家用卧室租房高清液晶', brand: '海信', size: '其他（32英寸）', price: '1000元以下' },
        '10226376308686': { sku: '10226376308686', name: '康佳云尚4K电视智能网络32 46 43 50 55 65 75寸会议电视', brand: '康佳', size: '其他（24英寸）', price: '1000元以下' },
      },
    },
    '3C店': {
      name: '3C店',
      note: '预览样例',
      rows: {
        '100244553743': { sku: '100244553743', name: '品牌B会议平板一体机灵锐75英寸会议平板触摸屏', brand: '品牌B', size: '75英寸', price: '5000元至5500元' },
        '100016891222': { sku: '100016891222', name: '品牌B会议平板一体机AXI板触摸教学一体机智能屏', brand: '品牌B', size: '65英寸', price: '5500元至6000元' },
        '100094675097': { sku: '100094675097', name: '创维（Skyworth）65英寸会议平板一体机会议显示器', brand: '创维（Skyworth）', size: '65英寸', price: '3500元至4000元' },
        '100035835861': { sku: '100035835861', name: '皓丽M5系列企业版65英寸joyinside会议平板一体机', brand: '皓丽（Horion）', size: '65英寸', price: '5000元至5500元' },
        '100044699127': { sku: '100044699127', name: '皓丽M5系列标配版65英寸会议平板一体机', brand: '皓丽（Horion）', size: '65英寸', price: '4000元至4500元' },
        '100299750032': { sku: '100299750032', name: '联想（Lenovo）75英寸会议平板一体机触摸屏', brand: '联想（Lenovo）', size: '75英寸', price: '5500元至6000元' },
        '100326332170': { sku: '100326332170', name: '品牌B会议平板一体机灵锐86英寸会议大屏', brand: '品牌B', size: '86/85英寸', price: '9000元至10000元' },
        '100032771690': { sku: '100032771690', name: '品牌B新锐75英寸会议平板一体机joyinside', brand: '品牌B', size: '75英寸', price: '9000元至10000元' },
        '100054260296': { sku: '100054260296', name: '创维75英寸会议平板一体机电子白板教学一体机', brand: '创维（Skyworth）', size: '75英寸', price: '5500元至6000元' },
        '100054260286': { sku: '100054260286', name: '创维（Skyworth）86英寸会议平板一体机电子白板', brand: '创维（Skyworth）', size: '86/85英寸', price: '8000元至9000元' },
      },
    },
  },
};

/* ============================ 运行时状态 ============================ */

const state = {
  library: null,
  session: null,
  settings: null,
  captures: {},
  seedBands: { size: null, price: null },
  activePage: 'workbench',
  loadedFromSeed: false,
  demoLibrary: false,
  // 工作台筛选 / 分页
  filter: { status: 'all', search: '', page: 1, pageSize: 100 },
  // 匹配库筛选 / 分页
  libFilter: { store: '', mode: 'all', search: '', page: 1, pageSize: 100 },
  // 配对总览页（跨榜单）筛选 / 分页 / 排序
  overview: { store: '', status: 'all', search: '', page: 1, pageSize: 200, sortField: '', sortDir: 'asc' },
  // 工作台导入区是否手动展开（导入完成后默认折叠）
  importExpanded: false,
  // 导入后 KPI 是否展开明细（默认收成单行摘要，给配对表让出首屏空间）
  kpiExpanded: false,
  // v2.1.5 匹配库保护 / 日志面板
  hadStoredLibrary: false,
  libraryBackup: null,
  libLogOpen: false,
  // 采集
  capture: { runner: null, running: false, pausedFlag: false, summary: null, progress: null, log: [], everRun: false, resultCount: 0, cooldownUntil: 0, lastRisk: null, riskTimer: null, previewRead: null, anomaly: null, anomalyTimer: null, anomalyCount: 0, lastDebug: null, priceRefreshLog: {} },
  // v2.1.5 表头列筛选（session 内状态，不落盘）
  columnFilters: { match: {}, overview: {} },
  // 统计看板：类目子页 + 品牌表排序/搜索（内存态）
  statsStore: '',
  statsBrandSort: { field: 'amount', dir: 'desc' },
  statsBrandSearch: '',
  // 其它
  busy: false,
  stats: null,
  statsStale: true,
  lastAnalyzeAt: null,
  pendingLibImportMode: 'merge',
  headerCtx: null,
  filters: { lastKpiFilter: 'all' },
};

// lib 模块与加载状态
const lib = {};
const libState = {};
const LIB_LABELS = Object.fromEntries(LIB_SPECS.map(([name, , label]) => [name, label]));

// 无 chrome 扩展 API 时的内存存储兜底
const memoryStore = new Map();

// 运行时错误留痕（首页 toast 报错的同时记录下来，方便 QA/调试导出）
const runtimeErrors = [];
function rememberError(text) {
  runtimeErrors.push({ at: nowIso(), text: String(text == null ? '' : text).slice(0, 300) });
  if (runtimeErrors.length > 80) runtimeErrors.shift();
}

const HAS_CHROME = typeof chrome !== 'undefined' && !!chrome;
const HAS_EXTENSION = !!(HAS_CHROME && chrome.storage && chrome.storage.local && chrome.runtime && chrome.runtime.id);

/* ============================ 元素引用 ============================ */

const $ = (id) => document.getElementById(id);

const els = {
  // 顶栏
  envBadge: $('envBadge'),
  saveState: $('saveState'),
  themeToggleBtn: $('themeToggleBtn'),
  themeToggleIcon: $('themeToggleIcon'),
  navBtns: Array.from(document.querySelectorAll('.nav-btn')),
  pages: Array.from(document.querySelectorAll('.page')),
  // 提醒
  engineBanner: $('engineBanner'),
  engineBannerText: $('engineBannerText'),
  retryLibBtn: $('retryLibBtn'),
  retryLibBtn2: $('retryLibBtn2'),
  riskBanner: $('riskBanner'),
  dismissBanner: $('dismissBanner'),
  // 工作台
  pickReportBtn: $('pickReportBtn'),
  loadDemoBtn: $('loadDemoBtn'),
  reportFileInput: $('reportFileInput'),
  importPanel: $('importPanel'),
  importCollapsed: $('importCollapsed'),
  importCollapsedCount: $('importCollapsedCount'),
  expandImportBtn: $('expandImportBtn'),
  collapseImportBtn: $('collapseImportBtn'),
  reportsDetails: $('reportsDetails'),
  reportsSummaryText: $('reportsSummaryText'),
  kpiBar: $('kpiBar'),
  kpiCompact: $('kpiCompact'),
  kpiCompactText: $('kpiCompactText'),
  kpiDetailBtn: $('kpiDetailBtn'),
  reportCount: $('reportCount'),
  diagnoseBtn: $('diagnoseBtn'),
  clearReportsBtn: $('clearReportsBtn'),
  reportCards: $('reportCards'),
  analyzeBtn: $('analyzeBtn'),
  captureBtn: $('captureBtn'),
  pauseBtn: $('pauseBtn'),
  stopBtn: $('stopBtn'),
  confirmReviewBtn: $('confirmReviewBtn'),
  confirmWriteBtn: $('confirmWriteBtn'),
  captureModeHint: $('captureModeHint'),
  // v2.1.4 预览人工读数浮条
  previewReadBar: $('previewReadBar'),
  previewReadText: $('previewReadText'),
  previewApplyBtn: $('previewApplyBtn'),
  previewIgnoreBtn: $('previewIgnoreBtn'),
  // v2.1.4 风控告警
  riskAlert: $('riskAlert'),
  riskAlertTitle: $('riskAlertTitle'),
  riskAlertText: $('riskAlertText'),
  dismissRiskAlert: $('dismissRiskAlert'),
  // v2.1.5 异常等待条
  anomalyBar: $('anomalyBar'),
  anomalyText: $('anomalyText'),
  anomalyContinueBtn: $('anomalyContinueBtn'),
  anomalyStopBtn: $('anomalyStopBtn'),
  runHint: $('runHint'),
  exportMenu: $('exportMenu'),
  exportBackfillBtn: $('exportBackfillBtn'),
  exportBackfillAllBtn: $('exportBackfillAllBtn'),
  exportResultBtn: $('exportResultBtn'),
  exportBackupBtn: $('exportBackupBtn'),
  exportCsvBtn: $('exportCsvBtn'),
  progressPanel: $('progressPanel'),
  progressText: $('progressText'),
  progressPct: $('progressPct'),
  progressFill: $('progressFill'),
  progressBody: $('progressBody'),
  toggleProgressBtn: $('toggleProgressBtn'),
  runStats: $('runStats'),
  logPanel: $('logPanel'),
  copyLogBtn: $('copyLogBtn'),
  clearLogBtn: $('clearLogBtn'),
  statusFilter: $('statusFilter'),
  searchInput: $('searchInput'),
  pageSize: $('pageSize'),
  tableCount: $('tableCount'),
  matchBody: $('matchBody'),
  matchBodyRows: $('matchBodyRows'),
  matchEmpty: $('matchEmpty'),
  matchPager: $('matchPager'),
  workbenchTablePanel: $('workbenchTablePanel'),
  // v2.1.6 快速人工定位
  quickFilterBar: $('quickFilterBar'),
  quickReviewChip: $('quickReviewChip'),
  quickNoSizeChip: $('quickNoSizeChip'),
  quickNoPriceChip: $('quickNoPriceChip'),
  quickReviewCount: $('quickReviewCount'),
  quickNoSizeCount: $('quickNoSizeCount'),
  quickNoPriceCount: $('quickNoPriceCount'),
  matchColumnMenu: $('matchColumnMenu'),
  matchColumnPanel: $('matchColumnPanel'),
  // v2.1.5 表头列筛选浮层
  colFilterPanel: $('colFilterPanel'),
  colFilterTitle: $('colFilterTitle'),
  colFilterBody: $('colFilterBody'),
  colFilterCloseBtn: $('colFilterCloseBtn'),
  colFilterClearBtn: $('colFilterClearBtn'),
  // 配对总览
  overviewCount: $('overviewCount'),
  overviewTools: $('overviewTools'),
  overviewStoreFilter: $('overviewStoreFilter'),
  overviewStatusFilter: $('overviewStatusFilter'),
  overviewSearch: $('overviewSearch'),
  overviewPageSize: $('overviewPageSize'),
  overviewExportXlsxBtn: $('overviewExportXlsxBtn'),
  overviewExportCsvBtn: $('overviewExportCsvBtn'),
  overviewTable: $('overviewTable'),
  overviewBody: $('overviewBody'),
  overviewEmpty: $('overviewEmpty'),
  overviewPager: $('overviewPager'),
  overviewQuickFilterBar: $('overviewQuickFilterBar'),
  overviewQuickReviewChip: $('overviewQuickReviewChip'),
  overviewQuickNoSizeChip: $('overviewQuickNoSizeChip'),
  overviewQuickNoPriceChip: $('overviewQuickNoPriceChip'),
  overviewQuickReviewCount: $('overviewQuickReviewCount'),
  overviewQuickNoSizeCount: $('overviewQuickNoSizeCount'),
  overviewQuickNoPriceCount: $('overviewQuickNoPriceCount'),
  overviewColumnMenu: $('overviewColumnMenu'),
  overviewColumnPanel: $('overviewColumnPanel'),
  // 匹配库
  libImportMergeBtn: $('libImportMergeBtn'),
  libImportReplaceBtn: $('libImportReplaceBtn'),
  libExportBtn: $('libExportBtn'),
  libLogBtn: $('libLogBtn'),
  libLogPanel: $('libLogPanel'),
  libLogSearch: $('libLogSearch'),
  libLogList: $('libLogList'),
  libLogCount: $('libLogCount'),
  libLogExportBtn: $('libLogExportBtn'),
  libLogClearBtn: $('libLogClearBtn'),
  libLogCloseBtn: $('libLogCloseBtn'),
  libNormalizeBtn: $('libNormalizeBtn'),
  libIssueBtn: $('libIssueBtn'),
  libFileInput: $('libFileInput'),
  libKpi: $('libKpi'),
  addStoreBtn: $('addStoreBtn'),
  libStoreList: $('libStoreList'),
  libTableCount: $('libTableCount'),
  libFilterSelect: $('libFilterSelect'),
  libSearchInput: $('libSearchInput'),
  libPageSize: $('libPageSize'),
  libBody: $('libBody'),
  libEmpty: $('libEmpty'),
  libPager: $('libPager'),
  libTable: $('libTable'),
  libReportPanel: $('libReportPanel'),
  libReportBody: $('libReportBody'),
  closeLibReportBtn: $('closeLibReportBtn'),
  // 统计
  refreshStatsBtn: $('refreshStatsBtn'),
  statsExportBtn: $('statsExportBtn'),
  statsMeta: $('statsMeta'),
  storeStats: $('storeStats'),
  sizeChart: $('sizeChart'),
  priceChart: $('priceChart'),
  matrixTable: $('matrixTable'),
  statsStoreTabs: $('statsStoreTabs'),
  statsBrandSearch: $('statsBrandSearch'),
  statsBrandCount: $('statsBrandCount'),
  statsSortHint: $('statsSortHint'),
  openStoreReportBtn: $('openStoreReportBtn'),
  storeBrandTable: $('storeBrandTable'),
  // 设置
  saveSettingsBtn: $('saveSettingsBtn'),
  resetSettingsBtn: $('resetSettingsBtn'),
  setBatch: $('setBatch'),
  setBatchLimit: $('setBatchLimit'),
  setDelayMin: $('setDelayMin'),
  setDelayMax: $('setDelayMax'),
  setCooldownMinutes: $('setCooldownMinutes'),
  setAutoPauseOnRisk: $('setAutoPauseOnRisk'),
  setAnomalyWait: $('setAnomalyWait'),
  setRetries: $('setRetries'),
  setCaptureMode: $('setCaptureMode'),
  setMaxSamples: $('setMaxSamples'),
  setTolerancePct: $('setTolerancePct'),
  setToleranceAbs: $('setToleranceAbs'),
  setBoundaryMarginPct: $('setBoundaryMarginPct'),
  setThemeSelect: $('setThemeSelect'),
  setSkipToday: $('setSkipToday'),
  setKeepTab: $('setKeepTab'),
  setPrefer1: $('setPrefer1'),
  setPrefer2: $('setPrefer2'),
  setPrefer3: $('setPrefer3'),
  setMinPlausible: $('setMinPlausible'),
  clearOverridesBtn: $('clearOverridesBtn'),
  overridesList: $('overridesList'),
  resetSeedBtn: $('resetSeedBtn'),
  seedVersionText: $('seedVersionText'),
  libraryBackupText: $('libraryBackupText'),
  restoreLibraryBackupBtn: $('restoreLibraryBackupBtn'),
  exportBackupBtn2: $('exportBackupBtn2'),
  importBackupBtn: $('importBackupBtn'),
  purgeCapturesBtn: $('purgeCapturesBtn'),
  clearSessionBtn: $('clearSessionBtn'),
  backupFileInput: $('backupFileInput'),
  copyDebugBtn: $('copyDebugBtn'),
  copyLastCaptureDebugBtn: $('copyLastCaptureDebugBtn'),
  debugBox: $('debugBox'),
  moduleStatusList: $('moduleStatusList'),
  // 弹窗
  headerDialog: $('headerDialog'),
  headerDialogDesc: $('headerDialogDesc'),
  headerDialogFile: $('headerDialogFile'),
  headerDialogSheet: $('headerDialogSheet'),
  headerPreviewWrap: $('headerPreviewWrap'),
  headerMapping: $('headerMapping'),
  headerDialogCancel: $('headerDialogCancel'),
  headerDialogSave: $('headerDialogSave'),
  confirmDialog: $('confirmDialog'),
  confirmTitle: $('confirmTitle'),
  confirmText: $('confirmText'),
  confirmCancel: $('confirmCancel'),
  confirmOk: $('confirmOk'),
  promptDialog: $('promptDialog'),
  promptTitle: $('promptTitle'),
  promptLabel: $('promptLabel'),
  promptInput: $('promptInput'),
  promptHint: $('promptHint'),
  promptCancel: $('promptCancel'),
  promptOk: $('promptOk'),
  // v2.1.7 候选价格调试弹窗
  priceDebugDialog: $('priceDebugDialog'),
  priceDebugTitle: $('priceDebugTitle'),
  priceDebugBody: $('priceDebugBody'),
  copyPriceDebugBtn: $('copyPriceDebugBtn'),
  closePriceDebugBtn: $('closePriceDebugBtn'),
  // v2.1.5 类目合并弹窗
  mergeStoresDialog: $('mergeStoresDialog'),
  mergeStoresForm: $('mergeStoresForm'),
  mergeStoresDesc: $('mergeStoresDesc'),
  mergeStoresTarget: $('mergeStoresTarget'),
  mergeStoresNewName: $('mergeStoresNewName'),
  mergeStoresNewNameField: $('mergeStoresNewNameField'),
  mergeStoresBody: $('mergeStoresBody'),
  mergeStoresCancelBtn: $('mergeStoresCancelBtn'),
  mergeStoresPreviewBtn: $('mergeStoresPreviewBtn'),
  mergeStoresApplyBtn: $('mergeStoresApplyBtn'),
  // 其它
  toast: $('toast'),
  footInfo: $('footInfo'),
};

/* ============================ 基础工具 ============================ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function nowIso() {
  return new Date().toISOString();
}

function nextId(prefix) {
  return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
}

function clone(obj) {
  try {
    return JSON.parse(JSON.stringify(obj));
  } catch (e) {
    return null;
  }
}

function cloneSettings(s) {
  const src = s && typeof s === 'object' ? s : {};
  const base = clone(DEFAULT_SETTINGS);
  const out = {
    version: 1,
    capture: Object.assign({}, base.capture, src.capture || {}),
    price: Object.assign({}, base.price, src.price || {}),
    mapping: { overrides: Object.assign({}, base.mapping.overrides, (src.mapping && src.mapping.overrides) || {}) },
    ui: Object.assign({}, base.ui, src.ui || {}),
  };
  if (!Array.isArray(out.price.prefer) || !out.price.prefer.length) out.price.prefer = base.price.prefer.slice();
  return out;
}

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

/* ============================ 主题（白天 / 黑夜） ============================ */

const THEME_MEDIA = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  ? window.matchMedia('(prefers-color-scheme: light)')
  : null;

function themeSetting() {
  const value = state.settings && state.settings.ui ? state.settings.ui.theme : 'auto';
  return value === 'light' || value === 'dark' ? value : 'auto';
}

function resolveTheme() {
  const setting = themeSetting();
  if (setting === 'light' || setting === 'dark') return setting;
  return THEME_MEDIA && THEME_MEDIA.matches ? 'light' : 'dark';
}

function applyTheme() {
  const resolved = resolveTheme();
  const setting = themeSetting();
  document.documentElement.dataset.theme = resolved;
  if (els.themeToggleIcon) els.themeToggleIcon.textContent = resolved === 'dark' ? '☀' : '🌙';
  if (els.themeToggleBtn) {
    els.themeToggleBtn.title = '切换白天/黑夜（当前：' + (setting === 'auto' ? '跟随系统 · ' : '') + (resolved === 'dark' ? '黑夜' : '白天') + '）';
    els.themeToggleBtn.dataset.themeResolved = resolved;
    els.themeToggleBtn.dataset.themeSetting = setting;
  }
  if (els.setThemeSelect && document.activeElement !== els.setThemeSelect) els.setThemeSelect.value = setting;
  // SVG 渐变 / 矩阵热力色是 JS 内联写入的，切主题后需要按新主题重绘（仅统计页可见时）
  try {
    const statsPage = document.getElementById('page-stats');
    if (statsPage && !statsPage.classList.contains('hidden') && els.sizeChart && (state.session.reports || []).length) {
      renderStats();
    }
  } catch (e) { /* 主题重绘失败不影响切换本身 */ }
}

function toggleTheme() {
  const next = resolveTheme() === 'dark' ? 'light' : 'dark';
  state.settings.ui.theme = next;
  markDirty('settings');
  flushSave('settings').catch(() => { /* 由 markDirty 的重试兜底 */ });
  applyTheme();
  toast('已切换到' + (next === 'dark' ? '黑夜' : '白天') + '模式', 'ok');
}

/** 设置主题（'auto' | 'light' | 'dark'），返回 {setting, resolved}；立即落盘，避免刷新丢失 */
function setThemeSetting(value) {
  const theme = value === 'light' || value === 'dark' ? value : 'auto';
  state.settings.ui.theme = theme;
  markDirty('settings');
  flushSave('settings').catch(() => { /* ignore */ });
  applyTheme();
  if (els.setThemeSelect) els.setThemeSelect.value = theme;
  return getThemeInfo();
}

function getThemeInfo() {
  return { setting: themeSetting(), resolved: resolveTheme() };
}

function bindThemeMediaListener() {
  if (!THEME_MEDIA || typeof THEME_MEDIA.addEventListener !== 'function') return;
  THEME_MEDIA.addEventListener('change', () => {
    if (themeSetting() === 'auto') applyTheme();
  });
}

/** 读 CSS 变量实际值（SVG / 内联样式按主题取色用） */
function cssVar(name, fallback) {
  try {
    if (typeof getComputedStyle !== 'function') return fallback || '';
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback || '';
  } catch (e) {
    return fallback || '';
  }
}

/** QA/验收：按 SKU 读取行字段（店铺/型号/套餐/复核等） */
function getColumnValue(sku, field) {
  const target = String(sku == null ? '' : sku);
  for (const report of state.session.reports || []) {
    for (const row of reportRows(report)) {
      if (String(row.sku) !== target) continue;
      const f = String(field == null ? '' : field);
      const map = {
        sku: () => row.sku,
        name: () => row.name,
        shop: () => storeNameOf(report, row),
        store: () => storeNameOf(report, row),
        storeName: () => row.storeName || '',
        storeSource: () => row.storeSource || '',
        brand: () => row.brand,
        model: () => row.model,
        package: () => row.package,
        modelSource: () => row.modelSource || '',
        packageSource: () => row.packageSource || '',
        size: () => row.size,
        price: () => row.price,
        amount: () => row.amount,
        sampleCount: () => row.sampleCount,
        sampleSpread: () => row.sampleSpread,
        capturePrice: () => row.capturePrice,
        currentPrice: () => row.capturePrice,
        priceNow: () => row.capturePrice,
        review: () => row.review,
        reviewText: () => reviewReasonsText(row),
        reviewState: () => rowReviewStateText(row),
        reviewSample: () => rowReviewSampleText(row),
        sourceSize: () => sourceText(row, 'size'),
        sourcePrice: () => sourceText(row, 'price'),
        status: () => rowStatusInfo(row).text,
        libState: () => rowLibState(row, report),
        note: () => row.note,
        rowNo: () => row.rowNo,
        report: () => report.fileName,
      };
      return Object.prototype.hasOwnProperty.call(map, f) ? map[f]() : row[f];
    }
  }
  return undefined;
}

function fmtNum(n, digits) {
  if (n == null || n === '' || !isFinite(Number(n))) return '—';
  const d = digits == null ? 2 : digits;
  return Number(n).toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: d });
}

function fmtPct(v, digits) {
  if (v == null || !isFinite(Number(v))) return '—';
  const d = digits == null ? 1 : digits;
  const pct = Number(v) * 100;
  return (Math.round(pct * Math.pow(10, d)) / Math.pow(10, d)).toFixed(d).replace(/\.0+$/, '').replace(/(\.\d)0$/, '$1') + '%';
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function stampNow() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

function todayStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate());
}

function isToday(iso) {
  if (!iso) return false;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return false;
  const n = new Date();
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
}

function truncate(text, len) {
  const s = String(text == null ? '' : text);
  return s.length > len ? s.slice(0, len) + '…' : s;
}

/** 把底层异常翻译成能看懂的中文提示（详情同时写日志） */
function humanError(e) {
  const raw = (e && (e.message || e.reason)) || String(e == null ? '' : e);
  if (!raw) return '未知错误';
  if (/Failed to fetch dynamically imported module|Importing a module script failed|MIME type|does not provide an export/i.test(raw)) {
    return '数据引擎模块未就绪（lib 文件缺失或有语法错误），刷新页面后重试';
  }
  if (/Failed to fetch|NetworkError|Load failed|ERR_FILE_NOT_FOUND/i.test(raw)) {
    return '读取扩展内置资源失败，请刷新页面重试';
  }
  if (/Could not establish connection|Receiving end does not exist/i.test(raw)) {
    return '与商品页脚本通信失败，请刷新商品页/工作台后重试';
  }
  if (/Cannot read propert|undefined is not an object|of undefined|is not a function/i.test(raw)) {
    return '数据格式与预期不一致：' + truncate(raw, 120);
  }
  if (/登录|login|passport/i.test(raw)) return '需要登录电商平台账号';
  return truncate(raw, 160);
}

/* ---------------- Toast / 保存状态 / 日志 ---------------- */

let toastTimer = null;
function toast(text, kind) {
  if (!els.toast) return;
  els.toast.textContent = String(text == null ? '' : text);
  els.toast.className = 'toast' + (kind === 'error' ? ' error' : kind === 'ok' ? ' ok' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.add('hidden'), kind === 'error' ? 6000 : 3600);
}

function setSaveState(text) {
  if (!els.saveState) return;
  els.saveState.textContent = text;
}

function logLine(text) {
  const line = '[' + new Date().toLocaleTimeString('zh-CN', { hour12: false }) + '] ' + String(text);
  state.capture.log.push(line);
  if (state.capture.log.length > 400) state.capture.log = state.capture.log.slice(-400);
  if (!els.logPanel) return;
  els.logPanel.textContent = state.capture.log.join('\n');
  els.logPanel.scrollTop = els.logPanel.scrollHeight;
}

async function copyText(text, okTip) {
  try {
    await navigator.clipboard.writeText(String(text));
    toast(okTip || '已复制到剪贴板', 'ok');
  } catch (e) {
    toast('复制失败，可手动选择文本复制', 'error');
  }
}

/* ---------------- 下载 ---------------- */

function sanitizeFilePart(name) {
  return String(name == null ? '' : name).replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 90);
}

function downloadBlob(data, mime, filename) {
  let blob;
  if (data instanceof Blob) blob = data;
  else if (data instanceof Uint8Array || data instanceof ArrayBuffer) blob = new Blob([data], { type: mime });
  else blob = new Blob([String(data == null ? '' : data)], { type: mime });

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function downloadJson(obj, filename) {
  downloadBlob(JSON.stringify(obj, null, 2), 'application/json;charset=utf-8', filename);
}

/* ---------------- 存储（chrome.storage.local，兼容回调 / Promise） ---------------- */

function memoryGet(keys) {
  const list = Array.isArray(keys) ? keys : [keys];
  const out = {};
  for (const key of list) if (memoryStore.has(key)) out[key] = clone(memoryStore.get(key));
  return out;
}

async function storageGet(keys) {
  const list = Array.isArray(keys) ? keys : [keys];
  if (!HAS_EXTENSION) return memoryGet(list);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value && typeof value === 'object' ? value : {});
    };
    try {
      const ret = chrome.storage.local.get(list, (res) => {
        // 必须读掉 lastError，否则控制台会出现未捕获错误
        const err = chrome.runtime.lastError;
        if (err) logLine('读取存储警告：' + err.message);
        finish(res || {});
      });
      // 某些 Edge/Chromium 版本在省略回调时返回 Promise；这里兼容两种写法
      if (ret && typeof ret.then === 'function') ret.then(finish).catch(() => finish({}));
    } catch (e) {
      logLine('读取存储失败，改用内存兜底：' + humanError(e));
      finish(memoryGet(list));
    }
  });
}

async function storageSet(obj) {
  if (!HAS_EXTENSION) {
    for (const [key, value] of Object.entries(obj)) memoryStore.set(key, clone(value));
    return true;
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    try {
      const ret = chrome.storage.local.set(obj, () => {
        const err = chrome.runtime.lastError;
        if (err) {
          logLine('保存失败：' + err.message);
          finish(false);
        } else finish(true);
      });
      if (ret && typeof ret.then === 'function') ret.then(() => finish(true)).catch(() => finish(false));
    } catch (e) {
      logLine('保存失败：' + humanError(e));
      finish(false);
    }
  });
}

// 防抖保存：session / captures 会频繁变化；library 变更较少
const saveTimers = {};
const SAVE_KEY_MAP = {
  library: { key: STORAGE_KEYS.library, get: () => state.library },
  session: { key: STORAGE_KEYS.session, get: () => serializeSession() },
  settings: { key: STORAGE_KEYS.settings, get: () => state.settings },
  captures: { key: STORAGE_KEYS.captures, get: () => state.captures },
};

function markDirty(name) {
  const spec = SAVE_KEY_MAP[name];
  if (!spec) return;
  setSaveState('保存中…');
  clearTimeout(saveTimers[name]);
  saveTimers[name] = setTimeout(() => flushSave(name), 350);
}

async function flushSave(name) {
  const spec = SAVE_KEY_MAP[name];
  if (!spec) return;
  clearTimeout(saveTimers[name]);
  const ok = await storageSet({ [spec.key]: spec.get() });
  setSaveState(ok ? '已保存 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false }) : '保存失败');
}

async function flushAllSaves() {
  await Promise.all(Object.keys(SAVE_KEY_MAP).map((name) => flushSave(name)));
}

/** 会话里不持久化体积过大的字段（originalSheets 保留：回填需要） */
function serializeSession() {
  return {
    version: 1,
    reports: state.session.reports,
    activeReportId: state.session.activeReportId,
    updatedAt: state.session.updatedAt,
  };
}

/* ============================ lib 动态加载 ============================ */

async function loadLibs() {
  state.loadedLibs = false;
  await Promise.all(LIB_SPECS.map(async ([name, path]) => {
    try {
      const mod = await import(path);
      if (!mod || typeof mod !== 'object') throw new Error('模块没有导出内容');
      lib[name] = mod;
      libState[name] = { ok: true, error: '' };
    } catch (e) {
      lib[name] = null;
      libState[name] = { ok: false, error: humanError(e), raw: (e && e.message) || String(e) };
    }
  }));
  updateEngineBanner();
  renderModuleStatus();
  if (els.loadDemoBtn) els.loadDemoBtn.classList.toggle('hidden', HAS_EXTENSION || !lib.pipeline);
}

function missingLibs() {
  return LIB_SPECS.filter(([name]) => !lib[name]);
}

function engineReadyFor(...names) {
  return names.every((name) => !!lib[name]);
}

function updateEngineBanner() {
  const missing = missingLibs();
  if (!els.engineBanner) return;
  if (!missing.length) {
    els.engineBanner.classList.add('hidden');
    return;
  }
  els.engineBanner.classList.remove('hidden');
  els.engineBannerText.textContent =
    '缺少 ' + missing.map(([, , label]) => label).join('、') +
    '（lib 尚未就绪或加载失败）。界面可预览；导入 / 分析 / 导出 / 补采等功能将在模块就绪并刷新页面后启用。';
}

function renderModuleStatus() {
  if (!els.moduleStatusList) return;
  els.moduleStatusList.innerHTML = LIB_SPECS.map(([name, path, label]) => {
    const st = libState[name];
    const ok = !!(st && st.ok);
    const stateText = st ? (ok ? '已就绪' : '未就绪') : '检测中…';
    const tip = path + (st && st.error ? ' · ' + st.error : '');
    return '<div class="module-item" title="' + esc(tip) + '">' +
      '<span><i class="dot ' + (ok ? 'ok' : st ? 'miss' : '') + '"></i> ' + esc(label) + '</span>' +
      '<span class="state">' + stateText + '</span></div>';
  }).join('');
}

/* ============================ 种子 / 数据加载 ============================ */

async function fetchSeedRaw() {
  const urls = [];
  try {
    if (HAS_EXTENSION && chrome.runtime && chrome.runtime.getURL) {
      urls.push(chrome.runtime.getURL('modules/share/data/base-skus.json'));
    }
  } catch (e) { /* ignore */ }
  try {
    urls.push(new URL('./data/base-skus.json', import.meta.url).href);
  } catch (e) { /* ignore */ }

  for (const url of urls) {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res || !res.ok) continue;
      const data = await res.json();
      if (data && data.stores && typeof data.stores === 'object') return data;
    } catch (e) {
      // 预览模式下可能被 CORS 拦截，尝试下一个地址即可
    }
  }
  return null;
}

function rememberSeedBands(seed) {
  if (!seed) return;
  if (Array.isArray(seed.sizeBands) && seed.sizeBands.length) state.seedBands.size = seed.sizeBands.slice();
  if (Array.isArray(seed.priceBands) && seed.priceBands.length) state.seedBands.price = seed.priceBands.slice();
}

function countLibraryRows(library) {
  let n = 0;
  const stores = (library && library.stores) || {};
  for (const store of Object.values(stores)) n += Object.keys((store && store.rows) || {}).length;
  return n;
}

/** 兼容模式：把 base-skus.json 原始结构转成 ds.library.v1 结构（仅 lib 缺席时使用） */
function adaptSeedFallback(seed, sourceLabel) {
  const stores = {};
  const srcStores = (seed && seed.stores) || {};
  for (const [name, s] of Object.entries(srcStores)) {
    const rows = {};
    for (const [sku, r] of Object.entries((s && s.rows) || {})) {
      rows[String(sku)] = {
        sku: String(sku),
        name: r.name || '',
        brand: r.brand || '',
        size: r.size || '',
        price: r.price || '',
        sizeRaw: r.sizeRaw || '',
        priceRaw: r.priceRaw || '',
        source: '库',
        updatedAt: (seed && seed.generatedAt) || nowIso(),
      };
    }
    stores[name] = { name, note: (s && s.note) || '', rows };
  }
  return {
    version: 1,
    stores,
    meta: { updatedAt: nowIso(), importedFrom: [sourceLabel || '内置种子（兼容模式）'] },
  };
}

function normalizeLibraryShape(library) {
  const out = { version: 1, stores: {}, meta: { updatedAt: nowIso(), importedFrom: [] } };
  const stores = (library && library.stores) || {};
  for (const [name, store] of Object.entries(stores)) {
    const rows = {};
    for (const [sku, r] of Object.entries((store && store.rows) || {})) {
      const key = String(sku).trim();
      if (!key) continue;
      rows[key] = Object.assign({}, r, { sku: key });
    }
    out.stores[name] = Object.assign({ name, keywords: [], note: '' }, store, { name, rows });
  }
  if (library && library.meta) out.meta = Object.assign(out.meta, library.meta);
  return out;
}

async function loadStoredData() {
  const got = await storageGet(Object.values(STORAGE_KEYS));

  // 设置
  state.settings = cloneSettings(got[STORAGE_KEYS.settings]);

  // 会话
  const storedSession = got[STORAGE_KEYS.session];
  if (storedSession && Array.isArray(storedSession.reports)) {
    state.session = {
      version: 1,
      reports: storedSession.reports,
      activeReportId: storedSession.activeReportId || (storedSession.reports[0] && storedSession.reports[0].id) || null,
      updatedAt: storedSession.updatedAt || '',
    };
    for (const report of state.session.reports) {
      if (!Array.isArray(report.rows)) report.rows = [];
      const brandHeader = report.columnNames && report.columnNames.brand;
      report.rows.forEach((row, i) => {
        row._i = i;
        if (row.brandRaw == null) {
          row.brandRaw = brandHeader && row.raw && row.raw[brandHeader] != null ? String(row.raw[brandHeader]) : '';
        }
      });
      if (!report.source && report.store) report.source = report.store;
    }
    state.lastAnalyzeAt = storedSession.updatedAt || null;
  } else {
    state.session = clone(DEFAULT_SESSION);
  }

  // 采集缓存
  const storedCaptures = got[STORAGE_KEYS.captures];
  state.captures = storedCaptures && typeof storedCaptures === 'object' ? storedCaptures : {};

  // 匹配库
  const storedLibrary = got[STORAGE_KEYS.library];
  if (storedLibrary && storedLibrary.stores && Object.keys(storedLibrary.stores).length) {
    state.library = normalizeLibraryShape(storedLibrary);
    state.hadStoredLibrary = true;
  }
}

async function initLibrary() {
  if (state.library && Object.keys(state.library.stores || {}).length) return;
  const seed = await fetchSeedRaw();
  if (seed) {
    rememberSeedBands(seed);
    if (lib.storeSchema && typeof lib.storeSchema.seedLibraryFromJson === 'function') {
      try {
        const built = lib.storeSchema.seedLibraryFromJson(seed);
        if (built && built.stores) state.library = built;
      } catch (e) {
        logLine('内置种子导入失败，改用兼容模式：' + humanError(e));
      }
    }
    if (!state.library || !state.library.stores) {
      state.library = adaptSeedFallback(seed, 'extension/data/base-skus.json');
    }
    state.library = normalizeLibraryShape(state.library);
    state.loadedFromSeed = true;
    logLine('已导入内置匹配库：' + Object.keys(state.library.stores).length + ' 个类目 / ' + countLibraryRows(state.library) + ' 个 SKU');
    markDirty('library');
  } else {
    // 预览模式兜底：保证界面有四页内容可看
    rememberSeedBands(DEMO_SEED);
    state.library = adaptSeedFallback(DEMO_SEED, '预览模式内置样例');
    state.demoLibrary = true;
    logLine('未能读取 data/base-skus.json（预览模式），已载入内置小样例；从 Edge 扩展打开可加载完整匹配库。');
  }
}

/* ============================ 页面导航 ============================ */

function navigate(page, opts) {
  opts = opts || {};
  const target = PAGES.includes(page) ? page : 'workbench';
  // DESIGN 17.1 / 18.2：离开带小眼睛的页面（工作台 / 总览）时关闭商品页预览窗口，避免残留 popup
  const previewPages = ['workbench', 'overview'];
  if (previewPages.indexOf(target) < 0 && previewPages.indexOf(state.activePage) >= 0) closePreviewQuietly('切换页面');
  state.activePage = target;
  for (const el of els.pages) el.classList.toggle('hidden', el.dataset.page !== target);
  for (const btn of els.navBtns) btn.classList.toggle('active', btn.dataset.pageTarget === target);
  if (!opts.noPersist) {
    state.settings.ui.lastPage = target;
    markDirty('settings');
  }
  if (!opts.noHash) {
    try { history.replaceState(null, '', '#' + target); } catch (e) { /* ignore */ }
  }
  renderPage(target);
}

function renderPage(page) {
  if (page === 'workbench') {
    renderKpis();
    renderReports();
    renderMatchTable();
    renderCaptureUI();
  } else if (page === 'overview') {
    renderOverview();
  } else if (page === 'library') {
    renderLibraryPage();
  } else if (page === 'stats') {
    renderStats();
  } else if (page === 'settings') {
    renderSettingsForm();
    renderOverrides();
    renderModuleStatus();
    renderDebug();
  }
  renderFoot();
}

function renderAll() {
  renderKpis();
  renderReports();
  renderFoot();
  renderPage(state.activePage);
}

/* ============================ 通用小工具（页面内） ============================ */

function activeReport() {
  const reports = state.session.reports || [];
  if (!reports.length) return null;
  const found = reports.find((r) => r.id === state.session.activeReportId);
  return found || reports[0];
}

function reportRows(report) {
  return Array.isArray(report && report.rows) ? report.rows : [];
}

function rowHasSize(row) {
  return !!(row && row.size && row.size !== '待补' && row.size !== '待分析');
}

function rowHasPrice(row) {
  return !!(row && row.price);
}

/* ============================ v2.1.6 人工核验定位（DESIGN §21.3） ============================ */

/** 人工填写规范尺寸后清除「待人工复核」标记 */
function clearSizeReviewFlags(row) {
  if (!row) return;
  if (row.sizeAmbiguous === true || row.sizeUncertain === true) {
    row.sizeAmbiguous = false;
    row.sizeUncertain = false;
    row.sizeAmbiguousReason = '';
    if (row.note && /尺寸|待人工|待复核/.test(String(row.note))) row.note = '';
  }
}

/** 尺寸待人工：lib 标注名称多尺寸（sizeAmbiguous）或页面采集尺寸不明确（sizeUncertain） */
function rowSizeReview(row) {
  return !!(row && (row.sizeAmbiguous === true || row.sizeUncertain === true));
}

const SIZE_AMBIGUOUS_REASON_TEXT = {
  'multiple-size-expressions': '名称含多个尺寸，待人工复核',
  'no-size-expression': '无明确尺寸，待人工补充 / 采集',
  'uncommon-size': '尺寸不常见，待人工确认',
};

function sizeReviewReason(row) {
  if (!row) return '';
  if (row.sizeUncertain === true) {
    return row.sizeAmbiguousReason && SIZE_AMBIGUOUS_REASON_TEXT[row.sizeAmbiguousReason]
      ? SIZE_AMBIGUOUS_REASON_TEXT[row.sizeAmbiguousReason]
      : '页面采集尺寸不明确，需人工填写';
  }
  if (row.sizeAmbiguous === true) {
    const mapped = row.sizeAmbiguousReason && SIZE_AMBIGUOUS_REASON_TEXT[row.sizeAmbiguousReason];
    return mapped || String(row.note || '') || '名称无明确唯一尺寸，需人工填写';
  }
  return '';
}

/** 缺尺寸段：尺寸段为空（不猜值，空就定位） */
function rowMissingSize(row) {
  return !String((row && row.size) || '').trim();
}

/** 缺价格段：价格段为空（价格只来自匹配库/页面采集，不猜名称） */
function rowMissingPrice(row) {
  return !String((row && row.price) || '').trim();
}

/** 人工核验定位计数（口径：size 空=缺尺寸段；price 空=缺价格段；sizeAmbiguous/sizeUncertain=待人工复核） */
function reviewLocateCounts(rows) {
  let review = 0;
  let missingSize = 0;
  let missingPrice = 0;
  for (const row of rows || []) {
    if (rowSizeReview(row)) review += 1;
    if (rowMissingSize(row)) missingSize += 1;
    if (rowMissingPrice(row)) missingPrice += 1;
  }
  return { review, missingSize, missingPrice, total: (rows || []).length };
}

function activeReportRowsForCounts() {
  return reportRows(activeReport());
}

function allReportRowsForCounts() {
  const rows = [];
  for (const report of state.session.reports || []) rows.push(...reportRows(report));
  return rows;
}

function applyQuickFilter(scope, filter) {
  const overview = scope === 'overview';
  if (overview) {
    state.overview.status = state.overview.status === filter ? 'all' : filter;
    state.overview.page = 1;
    if (els.overviewStatusFilter) els.overviewStatusFilter.value = state.overview.status;
    renderOverview();
  } else {
    const next = state.filter.status === filter ? 'all' : filter;
    state.filter.status = next;
    state.filter.page = 1;
    if (els.statusFilter) els.statusFilter.value = next;
    const switched = ensureActiveReportForStatusFilter(next);
    if (switched) renderReports();
    renderKpis();
    renderMatchTable();
  }
  renderQuickFilters();
}

function renderQuickFilters() {
  const matchRows = activeReportRowsForCounts();
  const mc = reviewLocateCounts(matchRows);
  if (els.quickReviewCount) els.quickReviewCount.textContent = String(mc.review);
  if (els.quickNoSizeCount) els.quickNoSizeCount.textContent = String(mc.missingSize);
  if (els.quickNoPriceCount) els.quickNoPriceCount.textContent = String(mc.missingPrice);
  const mActive = state.filter.status;
  if (els.quickReviewChip) els.quickReviewChip.classList.toggle('active', mActive === 'sizeReview');
  if (els.quickNoSizeChip) els.quickNoSizeChip.classList.toggle('active', mActive === 'missingSize');
  if (els.quickNoPriceChip) els.quickNoPriceChip.classList.toggle('active', mActive === 'missingPrice');
  if (els.quickFilterBar) els.quickFilterBar.classList.toggle('has-active', ['sizeReview', 'missingSize', 'missingPrice'].indexOf(mActive) >= 0);

  const allRows = allReportRowsForCounts();
  const oc = reviewLocateCounts(allRows);
  if (els.overviewQuickReviewCount) els.overviewQuickReviewCount.textContent = String(oc.review);
  if (els.overviewQuickNoSizeCount) els.overviewQuickNoSizeCount.textContent = String(oc.missingSize);
  if (els.overviewQuickNoPriceCount) els.overviewQuickNoPriceCount.textContent = String(oc.missingPrice);
  const oActive = state.overview.status;
  if (els.overviewQuickReviewChip) els.overviewQuickReviewChip.classList.toggle('active', oActive === 'sizeReview');
  if (els.overviewQuickNoSizeChip) els.overviewQuickNoSizeChip.classList.toggle('active', oActive === 'missingSize');
  if (els.overviewQuickNoPriceChip) els.overviewQuickNoPriceChip.classList.toggle('active', oActive === 'missingPrice');
  if (els.overviewQuickFilterBar) els.overviewQuickFilterBar.classList.toggle('has-active', ['sizeReview', 'missingSize', 'missingPrice'].indexOf(oActive) >= 0);
}

function rowFailed(row) {
  if (!row) return false;
  if (row.offSale) return true;
  return !!(row && (row.captureFailed === true || row.status === '采集失败'));
}

/** v2.1.5：把采集缓存里「已下架」的结果标到行上（状态显示已下架，继续下一条，不计风控） */
function markOffSaleRows() {
  for (const report of state.session.reports || []) {
    for (const row of reportRows(report)) {
      if (!row || !row.sku) continue;
      const cap = state.captures[String(row.sku)];
      if (!cap) continue;
      const failReason = (cap.fail && cap.fail.reason) || '';
      if (cap.offSale || /已下架|下架|不存在/.test(failReason)) {
        row.offSale = true;
        row.failReason = '已下架';
      } else if (row.offSale && !/下架/.test(failReason) && !cap.offSale) {
        row.offSale = false;
        if (row.failReason === '已下架') row.failReason = '';
      }
    }
  }
}

/** 是否有待人工确认的复核疑点（DESIGN 16.4：review.needed && !confirmed） */
function reviewNeeded(row) {
  if (!row || !row.review) return row && row.status === REVIEW_TEXT;
  return !!(row.review.needed && !row.review.confirmed);
}

/** 是否已经人工确认过复核 */
function reviewConfirmed(row) {
  return !!(row && row.review && row.review.confirmed);
}

function reviewReasonsText(row) {
  const reasons = row && row.review && Array.isArray(row.review.reasons) ? row.review.reasons : [];
  if (row && row.review && row.review.text) return String(row.review.text);
  if (row && row.reviewText) return String(row.reviewText);
  return reasons.map((r) => (r && (r.text || r.code)) || '').filter(Boolean).join('；');
}

function storeNameOf(report, row) {
  const own = row && row.storeName ? String(row.storeName).trim() : '';
  if (own) return own;
  return (report && report.store) || '';
}

/** 行内「采样」展示：N 次 · 价差 X 元 */
function rowSampleText(row) {
  const count = row && row.sampleCount != null ? Number(row.sampleCount) : null;
  const spread = row && row.sampleSpread != null ? Number(row.sampleSpread) : null;
  if (!count) return { main: '—', sub: '' };
  const main = count + ' 次';
  const sub = Number.isFinite(spread) ? '±' + fmtNum(spread, 0) + ' 元' : '';
  return { main, sub };
}

function rowStatusInfo(row) {
  if (!row) return { text: '—', cls: 'muted', key: 'none' };
  if (row.status === '待分析') return { text: '待分析', cls: 'muted', key: 'mock' };
  // v2.1.5：下架商品明确显示「已下架」，跳过继续，不按风控暂停
  if (row.offSale) return { text: '已下架', cls: 'muted', key: 'fail' };
  // v2.1.6：尺寸待人工复核（名称多尺寸 / 页面采集不确定）优先标记，不改变四色入库状态
  if (rowSizeReview(row)) return { text: '待复核', cls: 'review', key: 'sizeReview' };
  const hasSize = rowHasSize(row);
  const hasPrice = rowHasPrice(row);
  const failed = rowFailed(row);
  if (failed && !(hasSize && hasPrice)) return { text: '采集失败', cls: 'danger', key: 'fail' };
  if (reviewNeeded(row) && hasPrice) return { text: REVIEW_TEXT, cls: 'review', key: 'review' };
  // v2.1.6：空缺定位状态（缺尺寸段优先于缺价格段，便于逐条核验）
  if (rowMissingSize(row)) return { text: '缺尺寸段', cls: 'warn', key: 'missingSize' };
  if (rowMissingPrice(row)) return { text: '缺价格段', cls: 'info', key: 'missingPrice' };
  if (hasSize && hasPrice) {
    return row.status === '已补采'
      ? { text: '已补采', cls: 'ok', key: 'done' }
      : { text: '已匹配', cls: 'ok', key: 'done' };
  }
  return { text: '待采集', cls: 'warn', key: 'todo' };
}

/** 状态列 tooltip：优先用 lib 给的 note，其次尺寸待人工原因 */
function rowStatusTitle(row) {
  if (!row) return '';
  if (rowSizeReview(row)) {
    const reason = sizeReviewReason(row);
    return reason + (row.note ? '（' + row.note + '）' : '');
  }
  return String(row.note || '');
}

function sourceText(row, field) {
  const src = row && row.source;
  if (src && typeof src === 'object') return src[field] || '';
  if (typeof src === 'string') return src;
  return '';
}

function sizeBandOptions() {
  if (lib.rules && Array.isArray(lib.rules.SIZE_BANDS) && lib.rules.SIZE_BANDS.length) return lib.rules.SIZE_BANDS;
  if (state.seedBands.size) return state.seedBands.size;
  return FALLBACK_SIZE_BANDS;
}

function priceBandOptions() {
  if (lib.rules && Array.isArray(lib.rules.PRICE_BANDS) && lib.rules.PRICE_BANDS.length) return lib.rules.PRICE_BANDS;
  if (state.seedBands.price) return state.seedBands.price;
  return FALLBACK_PRICE_BANDS;
}

function ensureDatalists() {
  const make = (id, values) => {
    let dl = document.getElementById(id);
    if (!dl) {
      dl = document.createElement('datalist');
      dl.id = id;
      document.body.appendChild(dl);
    }
    dl.innerHTML = values.map((v) => '<option value="' + esc(v) + '"></option>').join('');
  };
  make('sizeBandList', sizeBandOptions());
  make('priceBandList', priceBandOptions());
}

function storeNames() {
  return Object.keys((state.library && state.library.stores) || {});
}

function storeSelectOptionsHtml(selected) {
  const names = storeNames();
  const head = '<option value="">（不绑定）</option>';
  if (!names.length) return head;
  return head + names.map((n) => '<option value="' + esc(n) + '"' + (n === selected ? ' selected' : '') + '>' + esc(n) + '</option>').join('');
}

/* ============================ 工作台 KPI ============================ */

function computeKpis() {
  const reports = state.session.reports || [];
  const rows = [];
  for (const report of reports) for (const row of reportRows(report)) rows.push(row);

  let sizeFilled = 0;
  let priceFilled = 0;
  let brandFilled = 0;
  let complete = 0;
  let pending = 0;
  let failed = 0;
  let review = 0;
  let sampled2 = 0;
  let amount = 0;
  let amountAnomaly = 0;
  let libPending = 0;
  let libNew = 0;
  let libIncomplete = 0;
  let libVerified = 0;
  let sizeReview = 0;
  let missingSize = 0;
  let missingPrice = 0;
  let offSale = 0;
  refreshLibraryStates();
  for (const report of reports) {
    for (const row of reportRows(report)) {
      const hasSize = rowHasSize(row);
      const hasPrice = rowHasPrice(row);
      if (hasSize) sizeFilled++;
      if (hasPrice) priceFilled++;
      if (row.offSale) offSale++;
      // v2.1.6 人工核验定位计数（全榜单口径）
      if (rowSizeReview(row)) sizeReview++;
      if (rowMissingSize(row)) missingSize++;
      if (rowMissingPrice(row)) missingPrice++;
      if (row.brand && !/未标注品牌|未识别/.test(String(row.brand))) brandFilled++;
      if (row.sampleCount != null && Number(row.sampleCount) > 1) sampled2++;
      if (rowFailed(row) && !(hasSize && hasPrice)) {
        failed++;
      } else if (reviewNeeded(row) && !rowFailed(row)) {
        review++;
      } else if (hasSize && hasPrice) {
        complete++;
      } else if (!hasPrice) {
        pending++;
      }
      if (row.amount != null && Number.isFinite(Number(row.amount))) amount += Number(row.amount);
      else if (row.amountRaw && String(row.amountRaw).trim()) amountAnomaly++;
      const libState = rowLibState(row, report);
      if (libState === 'pending') libPending++;
      else if (libState === 'new') libNew++;
      else if (libState === 'incomplete') libIncomplete++;
      else if (libState === 'verified') libVerified++;
    }
  }
  const total = rows.length;
  // v2.1.7：已下架不计入分母；优先读 lib stats.offSale/progressDenom/progressPct，缺失时按行兜底
  let libStats = null;
  try { libStats = ensureStats(false); } catch (e) { libStats = null; }
  let libOffSale = Number(libStats && libStats.offSale);
  // 行数据与 lib 缓存不一致（如刚标记下架）→ 强制重算一次，避免 KPI 显示旧分母
  if (libStats && Number.isFinite(libOffSale) && libOffSale !== offSale) {
    state.statsStale = true;
    try { libStats = ensureStats(true); libOffSale = Number(libStats && libStats.offSale); } catch (e) { /* 保留行兜底 */ }
  }
  const offSaleCount = Number.isFinite(libOffSale) && libOffSale >= 0 ? libOffSale : offSale;
  const libDenom = Number(libStats && libStats.progressDenom);
  const validTotal = Number.isFinite(libDenom) && libDenom >= 0 ? libDenom : Math.max(0, total - offSaleCount);
  const libPendingCount = Number(libStats && libStats.total && libStats.total.pending);
  const pendingValid = Number.isFinite(libPendingCount) && libPendingCount >= 0 ? libPendingCount : Math.max(0, pending);
  return {
    reports: reports.length,
    total,
    sizeFilled,
    priceFilled,
    brandFilled,
    sizePct: total ? sizeFilled / total : 0,
    pricePct: total ? priceFilled / total : 0,
    brandPct: total ? brandFilled / total : 0,
    complete,
    pending,
    pendingValid,
    failed,
    review,
    sampled2,
    amount,
    amountAnomaly,
    libVerified,
    libIncomplete,
    libNew,
    libPending,
    sizeReview,
    missingSize,
    missingPrice,
    offSale: offSaleCount,
    validTotal,
    progressDenom: validTotal,
    progressPct: validTotal ? Math.min(100, Math.round(((validTotal - pendingValid) / validTotal) * 100)) : 0,
  };
}

// KPI 卡片：可点击的卡片带 data-filter，点击即切到对应行筛选
function renderKpis() {
  if (!els.kpiBar) return;
  const k = computeKpis();
  const activeFilter = state.filter.status;
  const card = (key, label, value, unit, cls, filter) => {
    const clickable = !!filter;
    const active = clickable && activeFilter === filter;
    return '<div class="kpi ' + cls + (clickable ? ' clickable' : '') + (active ? ' active' : '') + '"' +
      (clickable ? ' data-filter="' + filter + '" title="点击筛选：' + esc(label) + '"' : '') + '>' +
      '<span class="k">' + esc(label) + '</span>' +
      '<span class="v">' + esc(value) + '<small>' + esc(unit) + '</small></span>' +
    '</div>';
  };
  els.kpiBar.innerHTML = [
    card('reports', '榜单文件', String(k.reports), '个', 'accent-info'),
    card('total', '总行数', fmtNum(k.total, 0), '行', ''),
    card('complete', '已补齐', fmtNum(k.complete, 0), '/ ' + fmtNum(k.total, 0) + ' 行', k.complete ? 'accent-ok' : '', 'done'),
    // v2.1.7：待补采按「有效行」计，已下架行不计入分母
    card('pending', '待补采', fmtNum(k.pendingValid, 0), '/ 有效 ' + fmtNum(k.validTotal, 0) + ' 行' + (k.offSale ? '（已下架 ' + fmtNum(k.offSale, 0) + ' 不计入）' : ''), k.pendingValid ? 'accent-warn' : 'accent-ok', 'todo'),
    card('offSale', '已下架', fmtNum(k.offSale, 0), '行（不计入分母）', k.offSale ? 'accent-danger' : '', 'offSale'),
    card('failed', '采集失败', fmtNum(k.failed, 0), '行', k.failed ? 'accent-danger' : '', 'fail'),
    card('review', '待确认', fmtNum(k.review, 0), '行', k.review ? 'accent-review' : 'accent-ok', 'review'),
    card('libPending', '待确认写入', fmtNum(k.libPending, 0), '行', k.libPending ? 'accent-info' : 'accent-ok', 'libPending'),
    // v2.1.6：快速人工定位计数（点击即筛选，与状态/搜索/列筛选叠加）
    card('sizeReview', '待人工复核', fmtNum(k.sizeReview, 0), '行', k.sizeReview ? 'accent-review' : 'accent-ok', 'sizeReview'),
    card('missingSize', '缺尺寸段', fmtNum(k.missingSize, 0), '行', k.missingSize ? 'accent-warn' : 'accent-ok', 'missingSize'),
    card('missingPrice', '缺价格段', fmtNum(k.missingPrice, 0), '行', k.missingPrice ? 'accent-warn' : 'accent-ok', 'missingPrice'),
    card('size', '尺寸段覆盖', fmtPct(k.sizePct), k.sizeFilled + '/' + k.total, k.sizePct >= 0.75 ? 'accent-ok' : 'accent-warn'),
    card('price', '价格段覆盖', fmtPct(k.pricePct), k.priceFilled + '/' + k.total, k.pricePct >= 0.5 ? 'accent-ok' : 'accent-warn'),
    card('amount', '总成交金额', fmtNum(k.amount, 0), '万元', 'accent-money'),
  ].join('');
  // DESIGN 18.3：导入后 KPI 收成单行紧凑摘要（点「明细」展开 9 张卡），把首屏留给配对表
  const hasReports = (state.session.reports || []).length > 0;
  const compact = hasReports && !state.kpiExpanded;
  if (els.kpiCompact) els.kpiCompact.classList.toggle('hidden', !compact);
  if (els.kpiBar) els.kpiBar.classList.toggle('hidden', compact);
  if (els.kpiCompactText && compact) {
    els.kpiCompactText.textContent = fmtNum(k.total, 0) + ' 行 · 已补齐 ' + fmtNum(k.complete, 0) +
      ' · 待补采 ' + fmtNum(k.pendingValid, 0) + ' / 有效 ' + fmtNum(k.validTotal, 0) + (k.offSale ? '（已下架 ' + fmtNum(k.offSale, 0) + ' 不计入）' : '') +
      ' · 尺寸 ' + fmtPct(k.sizePct, 1) + ' · 价格 ' + fmtPct(k.pricePct, 0) +
      ' · ' + fmtNum(k.amount, 0) + ' 万' +
      (k.libPending ? ' · 待确认写入 ' + fmtNum(k.libPending, 0) : '') +
      (k.sizeReview ? ' · 待人工复核 ' + fmtNum(k.sizeReview, 0) : '') +
      (k.missingSize ? ' · 缺尺寸段 ' + fmtNum(k.missingSize, 0) : '') +
      (k.missingPrice ? ' · 缺价格段 ' + fmtNum(k.missingPrice, 0) : '');
  }
  if (els.kpiDetailBtn) els.kpiDetailBtn.textContent = compact ? '明细' : '收起明细';
  renderQuickFilters();
}

/** KPI 点击 → 切行筛选（再点一次取消回全部） */
function handleKpiClick(filter) {
  if (!filter) return;
  const next = state.filter.status === filter ? 'all' : filter;
  state.filter.status = next;
  state.filter.page = 1;
  if (els.statusFilter) els.statusFilter.value = next;
  const switched = ensureActiveReportForStatusFilter(next);
  if (switched) renderReports();
  renderKpis();
  renderMatchTable();
  if (next !== 'all') {
    const tablePanel = document.getElementById('matchBody');
    if (tablePanel && tablePanel.closest) {
      const wrap = tablePanel.closest('.table-panel');
      if (wrap && wrap.scrollIntoView) {
        try { wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (e) { /* ignore */ }
      }
    }
  }
}

function renderFoot() {
  if (!els.footInfo) return;
  const stores = storeNames().length;
  const skus = countLibraryRows(state.library);
  const rows = (state.session.reports || []).reduce((n, r) => n + reportRows(r).length, 0);
  els.footInfo.textContent =
    '匹配库 ' + stores + ' 类目 / ' + fmtNum(skus, 0) + ' SKU · 榜单 ' + (state.session.reports || []).length +
    ' 个 / ' + fmtNum(rows, 0) + ' 行 · ' + (HAS_EXTENSION ? '扩展模式' : '预览模式（内存存储）');
}

/* ============================ 数据源榜单卡片 ============================ */

/** DESIGN 18.3：导入完成后 STEP01 折叠为紧凑条，把首屏留给配对表 */
function applyImportCollapse(reportCount) {
  const hasReports = reportCount > 0;
  const collapsed = hasReports && !state.importExpanded;
  if (els.importPanel) els.importPanel.classList.toggle('collapsed', collapsed);
  if (els.importCollapsed) els.importCollapsed.classList.toggle('hidden', !collapsed);
  if (els.importCollapsedCount) els.importCollapsedCount.textContent = String(reportCount);
  if (els.collapseImportBtn) els.collapseImportBtn.classList.toggle('hidden', !hasReports || collapsed);
  if (els.reportsSummaryText) {
    els.reportsSummaryText.textContent = hasReports
      ? '已导入 ' + reportCount + ' 个榜单 · 类目绑定 / 表头诊断'
      : '导入后在这里管理榜单与类目绑定';
  }
}

function renderReports() {
  if (!els.reportCards) return;
  const reports = state.session.reports || [];
  if (els.reportCount) els.reportCount.textContent = String(reports.length);
  const workbenchPage = document.getElementById('page-workbench');
  if (workbenchPage) workbenchPage.classList.toggle('has-reports', reports.length > 0);
  applyImportCollapse(reports.length);
  if (!reports.length) {
    els.reportCards.innerHTML = '<div class="empty-mini">尚未导入榜单。点击「导入榜单 xlsx」，或把 .xlsx 文件拖进本页。</div>';
    return;
  }
  const activeId = (activeReport() || {}).id;
  els.reportCards.innerHTML = reports.map((report) => {
    const rows = reportRows(report);
    let sizeN = 0;
    let priceN = 0;
    for (const row of rows) {
      if (rowHasSize(row)) sizeN++;
      if (rowHasPrice(row)) priceN++;
    }
    const conf = report.confidence != null ? Number(report.confidence) : null;
    const confCls = conf == null ? 'muted' : conf >= 0.8 ? 'ok' : conf >= 0.5 ? 'warn' : 'bad';
    const active = report.id === activeId;
    const score = report.storeScore != null ? Number(report.storeScore) : 0;
    const skuColName = (report.columnNames && report.columnNames.sku) || '';
    const brandColIdx = report.columnIndex ? Number(report.columnIndex.brand) : -1;
    const noBrandCol = !(Number.isInteger(brandColIdx) && brandColIdx >= 0);
    const brandFilled = report.summary && report.summary.brandFilled != null ? Number(report.summary.brandFilled) : null;
    const shopSet = new Set();
    for (const row of rows) {
      const shop = storeNameOf(report, row).trim();
      if (shop) shopSet.add(shop);
    }
    const modelFilled = report.summary && report.summary.modelFilled != null ? Number(report.summary.modelFilled) : null;
    const packageFilled = report.summary && report.summary.packageFilled != null ? Number(report.summary.packageFilled) : null;
    return '<article class="report-card' + (active ? ' active' : '') + '" data-report-id="' + esc(report.id) + '">' +
      '<div class="report-card-head">' +
        '<div class="report-file">' +
          '<b title="' + esc(report.fileName) + '">' + esc(report.fileName) + '</b>' +
          '<small title="工作表 / 表头行 / 行数">' + esc(report.sheetName || '—') + ' · 表头第 ' + (Number(report.headerRow) + 1) + ' 行 · ' + rows.length + ' 行</small>' +
        '</div>' +
        '<button class="report-remove" type="button" data-act="remove" data-report-id="' + esc(report.id) + '" title="移除该榜单">×</button>' +
      '</div>' +
      '<div class="report-tags">' +
        '<span class="tag ' + confCls + '" title="表头自动识别置信度">表头 ' + (conf == null ? '—' : fmtPct(conf, 0)) + '</span>' +
        '<span class="tag info" title="识别到的 SKU 列">SKU 列：' + esc(skuColName || '—') + '</span>' +
        '<span class="tag" title="榜单里的店铺数（绑定类目兜底）">店铺 ' + shopSet.size + ' 个</span>' +
        (noBrandCol ? '<span class="tag warn" title="榜单里没有品牌列，品牌已按匹配库 / 商品名称 / 店铺名称自动识别">无品牌列 · 自动识别品牌</span>' : '') +
        (brandFilled != null ? '<span class="tag ' + (brandFilled / Math.max(rows.length, 1) >= 0.8 ? 'ok' : 'warn') + '" title="品牌已识别行数（榜单品牌列 → 匹配库 → 商品名称 → 店铺名称）">品牌 ' + brandFilled + '/' + rows.length + '</span>' : '') +
        (modelFilled != null || packageFilled != null
          ? '<span class="tag ' + ((modelFilled || 0) + (packageFilled || 0) > 0 ? 'ok' : 'warn') + '" title="型号 / 套餐已识别行数（榜单列 → 商品名识别 → 页面规格）">型号 ' + (modelFilled == null ? '—' : modelFilled) + '/' + rows.length + ' · 套餐 ' + (packageFilled == null ? '—' : packageFilled) + '/' + rows.length + '</span>'
          : '') +
        '<span class="tag ' + (rows.length && sizeN / rows.length >= 0.75 ? 'ok' : 'warn') + '" title="尺寸段已补齐行数">尺寸 ' + sizeN + '/' + rows.length + '</span>' +
        '<span class="tag ' + (rows.length && priceN / rows.length >= 0.5 ? 'ok' : 'warn') + '" title="价格段已补齐行数">价格 ' + priceN + '/' + rows.length + '</span>' +
        '<span class="tag ' + (score >= 0.5 ? 'ok' : score > 0 ? 'warn' : '') + '" title="SKU 重合度自动绑定得分">绑定分 ' + score.toFixed(2) + '</span>' +
      '</div>' +
      '<div class="report-store-line">' +
        '<span class="label">绑定类目</span>' +
        '<select class="input" data-act="bind-store" data-report-id="' + esc(report.id) + '">' + storeSelectOptionsHtml(report.store || '') + '</select>' +
      '</div>' +
    '</article>';
  }).join('');
}

/* ============================ 配对表（工作台） ============================ */

function filteredMatchRows() {
  const report = activeReport();
  const rows = reportRows(report);
  const f = state.filter;
  const q = String(f.search || '').trim().toLowerCase();
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!rowMatchesStatusFilter(row, f.status, report)) continue;
    if (!rowMatchesColumnFilters(row, report, 'match')) continue;
    if (q) {
      const hay = (
        String(row.sku || '') + ' ' +
        String(row.name || '') + ' ' +
        String(row.brand || '') + ' ' +
        storeNameOf(report, row) + ' ' +
        String(row.model || '') + ' ' +
        String(row.package || '')
      ).toLowerCase();
      if (hay.indexOf(q) < 0) continue;
    }
    out.push({ row, index: i });
  }
  return { report, rows: out };
}

/** 单行是否命中配对表状态筛选（与 KPI 点击筛选共用同一口径） */
function rowMatchesStatusFilter(row, key, report) {
  if (!key || key === 'all') return true;
  const libFilter = LIB_STATE_FILTER_TO_STATE[key];
  if (libFilter) return rowLibState(row, report) === libFilter;
  const hasSize = rowHasSize(row);
  const hasPrice = rowHasPrice(row);
  const failed = rowFailed(row);
  const review = reviewNeeded(row);
  if (key === 'offSale') return !!row.offSale;
  if (key === 'done') return hasSize && hasPrice && !review && !failed;
  if (key === 'todo') return !hasPrice && !failed && !review;
  if (key === 'needSize') return !hasSize && hasPrice;
  if (key === 'review') return review;
  if (key === 'fail') return failed;
  // v2.1.6 人工核验定位（可与状态/搜索/列筛选叠加）
  if (key === 'sizeReview') return rowSizeReview(row);
  if (key === 'missingSize') return rowMissingSize(row);
  if (key === 'missingPrice') return rowMissingPrice(row);
  return true;
}

/** KPI/筛选切换后：若当前榜单没有命中行、其它榜单有，就自动切到有命中的榜单 */
function ensureActiveReportForStatusFilter(key) {
  if (!key || key === 'all') return false;
  const reports = state.session.reports || [];
  if (!reports.length) return false;
  const active = activeReport();
  if (active && reportRows(active).some((row) => rowMatchesStatusFilter(row, key, active))) return false;
  const target = reports.find((report) => reportRows(report).some((row) => rowMatchesStatusFilter(row, key, report)));
  if (!target) return false;
  state.session.activeReportId = target.id;
  markDirty('session');
  return true;
}

const EDITABLE_FIELD_LABELS = { size: '尺寸段', price: '价格段', brand: '品牌', model: '型号', package: '套餐' };

/** 纯数字展示（当前价格不用千分位，便于和商品页对照） */
function fmtPlainNum(n) {
  const v = Number(n);
  if (!isFinite(v)) return '—';
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
}

/* ============================ v2.1.7 价格类型 / 候选调试展示（DESIGN §22） ============================ */

function captureForSku(sku) {
  const key = String(sku == null ? '' : sku);
  const cap = key && state.captures ? state.captures[key] : null;
  return cap && typeof cap === 'object' ? cap : null;
}

/** 价格类型中文：优先 row.priceKindLabel，其次 source.price 文案，再次 priceKind 常量；不解析价格 */
function priceKindLabelFor(row, cap) {
  const r = row || {};
  const c = cap || captureForSku(r.sku);
  if (r.priceKindLabel) return String(r.priceKindLabel);
  if (c && c.priceKindLabel) return String(c.priceKindLabel);
  const src = sourceText(r, 'price');
  if (/PLUS价|PLUS/i.test(src)) return PRICE_KIND_LABELS.plus;
  if (/到手价/.test(src)) return PRICE_KIND_LABELS.hand;
  if (/电商平台价/.test(src)) return PRICE_KIND_LABELS.main;
  const kind = String(r.priceKind || (c && c.priceKind) || '');
  return PRICE_KIND_LABELS[kind] || '';
}

function priceKindCodeFor(row, cap) {
  const r = row || {};
  const c = cap || captureForSku(r.sku);
  const kind = String(r.priceKind || (c && c.priceKind) || '');
  if (PRICE_KIND_LABELS[kind]) return kind;
  const label = priceKindLabelFor(r, c);
  for (const key of Object.keys(PRICE_KIND_LABELS)) if (PRICE_KIND_LABELS[key] === label) return key;
  return '';
}

/** 价格元素位置/class 文案（来自采集结果 priceRect/candidates，仅展示） */
function priceRectText(row, cap) {
  const c = cap || captureForSku(row && row.sku);
  const rect = (row && row.priceRect) || (c && c.priceRect);
  if (!rect) return '';
  if (typeof rect === 'string') return rect;
  const x = rect.x != null ? rect.x : rect.left;
  const y = rect.y != null ? rect.y : rect.top;
  const w = rect.width != null ? rect.width : rect.w;
  const h = rect.height != null ? rect.height : rect.h;
  const parts = [];
  if (x != null && y != null) parts.push('位置 ' + Math.round(Number(x)) + ',' + Math.round(Number(y)));
  if (w != null && h != null) parts.push('尺寸 ' + Math.round(Number(w)) + '×' + Math.round(Number(h)));
  return parts.join(' ');
}

function priceElementClass(row, cap) {
  const r = row || {};
  const c = cap || captureForSku(r.sku);
  const direct = r.priceClass || (c && c.priceClass) || (c && c.priceRect && (c.priceRect.cls || c.priceRect.className));
  if (direct) return String(direct);
  // lib 把选中价格元素的 class 存在 sourceLabel（DESIGN 22.2 第 8 条），仅展示
  const sourceLabel = r.sourceLabel || (c && c.sourceLabel);
  if (sourceLabel) return String(sourceLabel);
  const candidates = Array.isArray(c && c.candidates) ? c.candidates : [];
  const chosen = candidates.find((item) => item && (item.cls || item.className) &&
    (r.capturePrice == null || Number(item.price) === Number(r.capturePrice)));
  return chosen ? String(chosen.cls || chosen.className || '') : '';
}

function priceKindBadgeHtml(row, cap) {
  const label = priceKindLabelFor(row, cap);
  if (!label) return '';
  const kind = priceKindCodeFor(row, cap) || 'main';
  return '<span class="price-kind-badge price-kind-' + esc(kind) + '" title="价格类型：' + esc(label) + '">' + esc(label) + '</span>';
}

/** 候选价格调试 JSON（UI 只组装展示字段，不解析价格） */
function buildPriceDebugPayload(row, skuHint) {
  const sku = String((row && row.sku) || skuHint || '');
  const cap = captureForSku(sku) || {};
  const r = row || { sku };
  const candidates = Array.isArray(cap.candidates) ? cap.candidates : (Array.isArray(r.candidates) ? r.candidates : []);
  const price = r.capturePrice != null ? Number(r.capturePrice) : (cap.price != null ? Number(cap.price) : null);
  return {
    sku,
    price: isFinite(price) ? price : null,
    priceKind: priceKindCodeFor(r, cap),
    priceKindLabel: priceKindLabelFor(r, cap),
    priceChanges: Array.isArray(cap.priceChanges) ? cap.priceChanges : (Array.isArray(r.priceChanges) ? r.priceChanges : []),
    priceRect: cap.priceRect || r.priceRect || null,
    sourceLabel: cap.sourceLabel || r.sourceLabel || sourceText(r, 'price') || '',
    candidates: candidates.slice(0, 12),
    at: cap.at || r.capturedAt || '',
  };
}

function getLastCaptureDebug() {
  return state.capture.lastDebug || null;
}

/** DESIGN 18.1：当前价格（采集/多采样中位数，元） */
function currentPriceInfo(row) {
  const raw = row && row.capturePrice != null ? Number(row.capturePrice) : NaN;
  const value = isFinite(raw) ? raw : null;
  const sku = row && row.sku ? String(row.sku) : '';
  const cap = sku && state.captures ? state.captures[sku] : null;
  const parts = [];
  if (value != null) {
    const prices = (cap && cap.prices) || {};
    if (prices.hand != null && isFinite(Number(prices.hand))) parts.push('到手价 ¥' + fmtPlainNum(prices.hand));
    if (prices.main != null && isFinite(Number(prices.main))) parts.push('电商平台价 ¥' + fmtPlainNum(prices.main));
    if (prices.plus != null && isFinite(Number(prices.plus))) parts.push('PLUS ¥' + fmtPlainNum(prices.plus));
    const count = row && row.sampleCount != null
      ? Number(row.sampleCount)
      : Array.isArray(cap && cap.samples) ? cap.samples.length : 0;
    if (count) parts.push('采样 ' + count + ' 次');
    const at = (cap && cap.at) || (row && row.capturedAt) || '';
    if (at) parts.push('采集时间 ' + fmtTime(at));
    // v2.1.7：价格类型 + 元素 class/位置（来自 lib 采集结果，仅展示）
    const kindLabel = priceKindLabelFor(row, cap);
    if (kindLabel) parts.push('价格类型 ' + kindLabel);
    const cls = priceElementClass(row, cap);
    if (cls) parts.push('元素 class=' + cls);
    const rectText = priceRectText(row, cap);
    if (rectText) parts.push(rectText);
  }
  return {
    value,
    text: value == null ? '—' : fmtPlainNum(value),
    title: value == null ? '还没补采，点「补采价格」' : (parts.join(' · ') || ('当前价格 ' + fmtPlainNum(value) + ' 元')),
    kindLabel: value == null ? '' : priceKindLabelFor(row, cap),
  };
}

function currentPriceCellHtml(row) {
  const info = currentPriceInfo(row);
  const cap = captureForSku(row && row.sku);
  const badge = info.kindLabel ? priceKindBadgeHtml(row, cap) : '';
  return '<span class="cell-price-now' + (info.value == null ? ' empty' : '') + '" title="' + esc(info.title) + '">' +
    '<b>' + esc(info.text) + '</b>' + badge + '</span>';
}

/** 榜单简称（总览「行」列用：榜单简称 #行号） */
function reportShortName(report) {
  const file = String((report && report.fileName) || '');
  const base = file.replace(/\.xlsx$/i, '');
  if (!base) return '榜单';
  return base.length > 16 ? base.slice(0, 16) + '…' : base;
}

/** DESIGN 19.2：工作台/总览/配对明细共用的 15 列表头（与界面逐字一致，不含「操作」） */
const PAIR_EXPORT_HEADERS = ['行', 'SKU', '商品名称', '店铺', '品牌', '型号', '套餐', '尺寸段', '价格段', '当前价格(元)', '成交金额(万元)', '采样', '数据来源', '状态', '入库状态'];

/** 单行导出值（列序与 PAIR_EXPORT_HEADERS 一一对应；与 lib pairExportRows 文案一致） */
function pairExportCells(report, row) {
  const rowNo = row && row.rowNo != null ? row.rowNo : '';
  const rowLabel = (reportShortName(report) || '榜单') + ' #' + rowNo;
  return [
    rowLabel,
    row.sku,
    row.name,
    storeNameOf(report, row),
    row.brand,
    row.model,
    row.package,
    row.size,
    row.price,
    row.capturePrice == null ? '' : row.capturePrice,
    row.amount == null ? '' : row.amount,
    rowReviewSampleText(row),
    rowSourceSummaryText(row), // v2.1.7：与 lib pairExportRows 一致，来源取 row.source（页面采集(到手价) 等）
    rowStatusInfo(row).text,
    LIB_STATE_LABELS[rowLibState(row, report)] || '',
  ];
}

/** 导出「数据来源」列：与 lib formatRowSources 同构（来源文案由 lib 写 row.source，UI 只读） */
function rowSourceSummaryText(row) {
  const sources = (row && row.source) || {};
  if (!sources || typeof sources !== 'object') return typeof sources === 'string' ? sources : '';
  const parts = [];
  if (sources.size) parts.push('尺寸段：' + sources.size);
  if (sources.price) parts.push('价格段：' + sources.price);
  if (sources.model) parts.push('型号：' + sources.model);
  if (sources.package) parts.push('套餐：' + sources.package);
  return parts.join('；');
}

/* ============================ v2.1.4 匹配库核验状态（DESIGN §19.1） ============================ */

// v2.1.5：确认后的入库状态统一显示「已确认」（init 时还会用 lib.pipeline.LIB_STATE_LABELS 同步）
const LIB_STATE_LABELS = { verified: '已确认', incomplete: '库数据不全', new: '新 SKU', pending: '待确认写入' };
const LIB_STATE_FILTER_TO_STATE = { libNew: 'new', libIncomplete: 'incomplete', libPending: 'pending' };

/** 找该行的匹配库记录：优先绑定类目，其次任意类目 */
function libraryRecordForRow(row, report) {
  if (!row || !row.sku) return null;
  const sku = String(row.sku);
  const libs = (state.library && state.library.stores) || {};
  const storeName = (report && report.store) || '';
  if (storeName && libs[storeName] && libs[storeName].rows && libs[storeName].rows[sku]) return libs[storeName].rows[sku];
  for (const store of Object.values(libs)) {
    if (store && store.rows && store.rows[sku]) return store.rows[sku];
  }
  return null;
}

function recordIsVerifiedComplete(rec) {
  if (!rec) return false;
  if (rec.verified === false) return false;
  return !!(rec.size && rec.price);
}

/** v2.1.5：该行是否已通过「确认写入」进入匹配库（用于显示禁用的「已确认」按钮） */
function rowConfirmedInLibrary(row, report) {
  if (!row) return false;
  if (row.confirmedWrite) return true;
  if (rowLibState(row, report) !== 'verified') return false;
  const rec = libraryRecordForRow(row, report);
  return !!(rec && (rec.origin === 'confirm' || rec.source === '人工确认'));
}

/** lib annotate 未就绪时的前端兜底状态（DESIGN §19.1 四态；pending=非 verified 且尺寸+价格齐全） */
function computeFallbackLibState(row, report) {
  const rec = libraryRecordForRow(row, report);
  if (rec && recordIsVerifiedComplete(rec)) return 'verified';
  const hasBoth = rowHasSize(row) && rowHasPrice(row);
  if (hasBoth) return 'pending';
  if (rec) return 'incomplete';
  return 'new';
}

function normalizeLibStateKey(key) {
  const s = String(key || '');
  return LIB_STATE_LABELS[s] ? s : '';
}

/** 行级入库状态：优先 lib.pipeline.annotateLibraryStates 写入的 row.libState */
function rowLibState(row, report) {
  const fromLib = normalizeLibStateKey(row && row.libState);
  if (fromLib) return fromLib;
  return computeFallbackLibState(row, report);
}

/** 调用 lib 重新标注全部行（lib 未就绪时返回 false，渲染时用前端兜底） */
function refreshLibraryStates() {
  try {
    if (lib.pipeline && typeof lib.pipeline.annotateLibraryStates === 'function') {
      lib.pipeline.annotateLibraryStates(state.session.reports || [], state.library);
      return true;
    }
  } catch (e) {
    logLine('匹配库状态标注失败（已用前端兜底）：' + humanError(e));
  }
  return false;
}

/** 数据变化后让 libState 重新计算（有 lib annotate 就直接重算，否则清空走前端兜底） */
function invalidateLibraryStates() {
  for (const report of state.session.reports || []) {
    for (const row of reportRows(report)) {
      if (row && typeof row === 'object') row.libState = undefined;
    }
  }
  refreshLibraryStates();
}

function libStateBadgeHtml(libState) {
  const key = normalizeLibStateKey(libState) || 'new';
  const text = LIB_STATE_LABELS[key] || key;
  return '<span class="lib-badge lib-' + key + '" title="入库状态：' + esc(text) + '">' +
    '<i class="lib-verified-dot"></i>' + esc(text) + '</span>';
}

function libStateRowClass(row, report) {
  const key = rowLibState(row, report);
  return key === 'verified' ? '' : ('lib-' + key);
}

/** 行是否可以确认写入匹配库：尺寸段/价格段合法且齐全 */
function rowCanConfirmWrite(row) {
  if (!row || !row.sku) return { ok: false, reason: '缺少 SKU' };
  if (!rowHasSize(row) || !rowHasPrice(row)) return { ok: false, reason: '缺尺寸段/价格段' };
  const sizeOk = isValidBandValue('size', row.size, row.size);
  const priceOk = isValidBandValue('price', row.price, row.price);
  if (!sizeOk || !priceOk) return { ok: false, reason: '尺寸段/价格段非法' };
  return { ok: true, reason: '' };
}

function getLibraryStates() {
  refreshLibraryStates();
  const counts = { verified: 0, incomplete: 0, new: 0, pending: 0, total: 0 };
  for (const report of state.session.reports || []) {
    for (const row of reportRows(report)) {
      const key = rowLibState(row, report);
      counts[key] = (counts[key] || 0) + 1;
      counts.total++;
    }
  }
  return counts;
}

/** 当前筛选内的 pending 行（批量确认写入用） */
function pendingWriteRows() {
  const { report, rows } = filteredMatchRows();
  return rows.map((item) => ({ row: item.row, report })).filter((item) => rowLibState(item.row, item.report) === 'pending');
}

function updateConfirmWriteBtn() {
  if (!els.confirmWriteBtn) return;
  const pending = pendingWriteRows();
  els.confirmWriteBtn.textContent = '确认写入匹配库(' + pending.length + ')';
  els.confirmWriteBtn.disabled = pending.length === 0;
  els.confirmWriteBtn.title = pending.length
    ? '把当前筛选里 ' + pending.length + ' 行自动补齐数据写入匹配库（需尺寸段+价格段合法齐全）'
    : '当前筛选没有待确认写入的行';
}

/**
 * 人工确认写库（DESIGN §19.1）：只由人工操作触发，脚本采集/分析绝不自动写库。
 * @returns {Promise<{written:number, rejected:Array<{sku,reason}>}>}
 */
async function confirmLibraryWriteRows(items) {
  const list = Array.isArray(items) ? items : [];
  const written = [];
  const rejected = [];
  const now = nowIso();
  for (const item of list) {
    const { row, report } = item || {};
    const sku = row && row.sku != null ? String(row.sku) : '';
    const check = rowCanConfirmWrite(row);
    if (!check.ok) {
      rejected.push({ sku, reason: check.reason });
      continue;
    }
    const storeName = (report && report.store) || '';
    if (!storeName) {
      rejected.push({ sku, reason: '未绑定类目' });
      continue;
    }
    if (!(lib.storeSchema && typeof lib.storeSchema.upsertMatch === 'function')) {
      rejected.push({ sku, reason: '匹配库模块未就绪' });
      continue;
    }
    try {
      // DESIGN 20.5：只传行上规范值；绝不再传 sizeRaw/priceRaw（旧 raw 会顶掉规范值）
      lib.storeSchema.upsertMatch(state.library, storeName, {
        sku,
        name: row.name || '',
        brand: row.brand || '',
        model: row.model || '',
        package: row.package || '',
        size: row.size || '',
        price: row.price || '',
        shop: row.storeName || storeNameOf(report, row) || '',
        source: '人工确认',
        updatedAt: now,
      }, { origin: 'confirm', verified: true, verifiedAt: now });
    } catch (e) {
      logLine('确认写入匹配库失败（' + sku + '）：' + humanError(e));
      rejected.push({ sku, reason: '写库失败' });
      continue;
    }
    row.libState = 'verified';
    row.confirmedWrite = true;
    row.confirmWriteAt = now;
    written.push(sku);
    // lib 已自动留痕则跳过；否则前端兜底写一条日志
    if (!hasLibLibraryLog()) {
      appendUiLibraryLog({ action: 'confirm', store: storeName, sku, field: 'size/price', before: '', after: (row.size || '') + ' / ' + (row.price || ''), source: '人工确认', note: '确认写入匹配库' });
    }
  }
  if (written.length) {
    state.settings.ui = state.settings.ui || {};
    state.settings.ui.confirmedWrites = (Number(state.settings.ui.confirmedWrites) || 0) + written.length;
    state.session.updatedAt = nowIso();
    markDirty('session');
    markDirty('library');
    markDirty('settings');
    state.statsStale = true;
    renderAll();
    toast('已写入匹配库 ' + written.length + ' 行（人工确认）', 'ok');
    logLine('确认写入匹配库：' + written.length + ' 行（人工确认）');
  }
  if (rejected.length) {
    renderAll();
    const reasonText = rejected.slice(0, 3).map((r) => (r.sku || '—') + '：' + r.reason).join('；');
    toast('有 ' + rejected.length + ' 行未写入：' + reasonText + (rejected.length > 3 ? ' …' : ''), 'error');
    logLine('确认写入被拒绝：' + rejected.map((r) => (r.sku || '—') + '(' + r.reason + ')').join('，'));
  }
  return { written: written.length, rejected };
}


function cellBandHtml(row, field, value, index) {
  const label = EDITABLE_FIELD_LABELS[field] || field;
  const source = sourceText(row, field);
  const manual = source === '手动';
  let cls = 'band-cell' + (value ? '' : ' empty') + (manual ? ' manual' : '');
  let text = value || '点击填写';
  let tip = label + '：点击修改（会写回匹配库）';
  if (field === 'size' && !value) {
    // v2.1.6：不确定值绝不冒充已填；空尺寸显示「待人工 / 缺」并可点击补齐
    const reason = sizeReviewReason(row);
    if (reason) {
      cls += ' manual-pending';
      text = '待人工';
      tip = '待人工复核：' + reason + '（点击填写规范尺寸段）';
    } else {
      cls += ' missing';
      text = '缺';
      tip = '缺尺寸段：点击填写（会写回匹配库）';
    }
  }
  if (field === 'model' || field === 'package') {
    const srcLabel = MODEL_SOURCE_LABELS[source] || '';
    if (srcLabel) tip = label + '（来源：' + srcLabel + '）：点击修改并写回匹配库';
  }
  return '<span class="' + cls + '" data-act="edit-cell" data-field="' + field + '" data-index="' + index +
    '" title="' + esc(tip) + '">' + esc(text) + '</span>';
}

function brandCellHtml(row, index) {
  const value = String(row.brand || '').trim();
  const source = sourceText(row, 'brand');
  const empty = !value || value === '未标注品牌';
  const cls = 'band-cell' + (empty ? ' empty' : '') + (source === '手动' ? ' manual' : '');
  const text = empty ? '未标注品牌' : value;
  const srcText = source === '手动' ? '手动修改' : source === '列' ? '榜单品牌列' : source === '库' ? '匹配库' : source === '名称' ? '商品名称识别' : source === '店铺' ? '店铺名称识别' : source === '页面采集' ? '页面采集' : '未识别';
  return '<span class="' + cls + '" data-act="edit-cell" data-field="brand" data-index="' + index +
    '" title="品牌来源：' + esc(srcText) + '；点击可修改并写回匹配库">' + esc(text) + '</span>';
}

function matchRowHtml(row, index) {
  const report = activeReport();
  const st = rowStatusInfo(row);
  let rowCls = '';
  if (st.key === 'fail') rowCls = 'row-fail';
  else if (st.key === 'review' || st.key === 'sizeReview') rowCls = 'row-review';
  else if (st.key === 'todo' || st.key === 'needSize' || st.key === 'missingSize' || st.key === 'missingPrice') rowCls = 'row-pending';
  const libCls = libStateRowClass(row, report);
  if (libCls) rowCls = (rowCls ? rowCls + ' ' : '') + libCls;
  const libState = rowLibState(row, report);
  const sku = String(row.sku || '');
  const shop = storeNameOf(report, row);
  const shopTitle = row.storeName ? '榜单店铺：' + row.storeName : '榜单无店铺列，显示绑定类目：' + shop;

  let amountHtml = '<span class="muted">—</span>';
  if (row.amount != null && Number.isFinite(Number(row.amount))) {
    amountHtml = fmtNum(row.amount, 2) + '<span class="unit">万</span>';
  } else if (row.amountRaw) {
    amountHtml = '<span class="muted">—</span> <span class="tag bad" title="原始值：' + esc(row.amountRaw) + '">金额异常</span>';
  }

  const sizeSrc = sourceText(row, 'size');
  const priceSrc = sourceText(row, 'price');
  const srcHtml = '<div class="cell-source one-line" title="尺寸段来源：' + esc(sizeSrc || '—') + ' · 价格段来源：' + esc(priceSrc || '—') + '">' +
    '<i>尺 <b>' + esc(sizeSrc || '—') + '</b></i>' +
    '<i>价 <b>' + esc(priceSrc || '—') + '</b></i>' +
  '</div>';

  const sample = rowSampleText(row);
  const reviewText = reviewReasonsText(row);
  const confirmed = reviewConfirmed(row);
  const confirmedAt = row.review && row.review.confirmedAt ? row.review.confirmedAt : '';
  const sampleHtml = '<div class="cell-sample" title="' + esc(reviewText || (sample.main === '—' ? '暂无多采样记录' : '多采样复核')) + '">' +
    '<b>' + esc(sample.main) + '</b>' + (sample.sub ? ' ' + esc(sample.sub) : '') +
    (reviewNeeded(row) ? '<span class="review-hint">有疑点</span>' : '') +
  '</div>';

  const statusNote = confirmed
    ? '<span class="review-note" title="' + esc(reviewText || '人工确认') + '">✓ 已确认（' + esc(fmtTime(confirmedAt)) + '）</span>'
    : (reviewText && reviewNeeded(row) ? '<span class="review-note">' + esc(truncate(reviewText, 18)) + '</span>' : '');

  const ops = (sku ? '<a class="op-btn" href="' + esc(ITEM_URL(sku)) + '" target="_blank" rel="noreferrer">打开</a>' : '') +
    (sku ? '<button class="op-btn" type="button" data-act="recapture" data-index="' + index + '">重采</button>' : '') +
    (sku ? '<button class="op-btn" type="button" data-act="debug-price" data-sku="' + esc(sku) + '" title="查看候选价格调试 JSON（价格类型/候选/位置/刷新记录）">调试</button>' : '') +
    (reviewNeeded(row) ? '<button class="op-btn review" type="button" data-act="confirm-review" data-index="' + index + '" title="' + esc(reviewText || '人工确认该行复核结果') + '">确认</button>' : '') +
    (libState === 'pending' ? '<button class="op-btn write" type="button" data-act="confirm-write" data-sku="' + esc(sku) + '" title="写入匹配库（人工确认）">确认写入</button>' : '') +
    (rowConfirmedInLibrary(row, report) ? '<button class="op-btn done" type="button" disabled title="已确认写入匹配库">已确认</button>' : '') +
    '<button class="op-btn" type="button" data-act="edit" data-index="' + index + '">编辑</button>';

  return '<tr class="' + rowCls + '" data-sku="' + esc(sku) + '" data-index="' + index + '">' +
    '<td class="col-rowno num">' + esc(String(row.rowNo != null ? row.rowNo : index + 1)) + '</td>' +
    '<td class="cell-sku"><div class="sku-cell">' + (sku ? '<a href="' + esc(ITEM_URL(sku)) + '" target="_blank" rel="noreferrer" title="打开电商平台商品页">' + esc(sku) + '</a>' : '<span class="muted">—</span>') + eyeBtnHtml(sku) + '</div></td>' +
    '<td><span class="cell-name" title="' + esc(row.name || '') + '">' + esc(row.name || '—') + '</span></td>' +
    '<td class="col-shop"><span class="cell-shop" title="' + esc(shopTitle) + '">' + esc(shop || '—') + '</span></td>' +
    '<td class="col-brand">' + brandCellHtml(row, index) + '</td>' +
    '<td class="col-model">' + cellBandHtml(row, 'model', row.model, index) + '</td>' +
    '<td class="col-package">' + cellBandHtml(row, 'package', row.package, index) + '</td>' +
    '<td class="col-band">' + cellBandHtml(row, 'size', row.size, index) + '</td>' +
    '<td class="col-band wide">' + cellBandHtml(row, 'price', row.price, index) + '</td>' +
    '<td class="col-price-now">' + currentPriceCellHtml(row) + '</td>' +
    '<td class="cell-amount' + (row.amount == null && row.amountRaw ? ' bad' : '') + '">' + amountHtml + '</td>' +
    '<td class="col-sample">' + sampleHtml + '</td>' +
    '<td class="col-source">' + srcHtml + '</td>' +
    '<td><span class="status-badge ' + st.cls + '"' + (row.note || reviewText || rowStatusTitle(row) ? ' title="' + esc(rowStatusTitle(row) || [row.note, reviewText].filter(Boolean).join('；')) + '"' : '') + '>' + esc(st.text) + '</span>' + statusNote + '</td>' +
    '<td class="col-lib-state">' + libStateBadgeHtml(libState) + '</td>' +
    '<td class="col-op"><div class="cell-op">' + ops + '</div></td>' +
  '</tr>';
}

function renderMatchTable() {
  refreshLibraryStates();
  const { report, rows } = filteredMatchRows();
  const total = rows.length;
  const pageSize = Number(state.filter.pageSize) || 100;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (state.filter.page > pages) state.filter.page = pages;
  if (state.filter.page < 1) state.filter.page = 1;
  const page = state.filter.page;
  const start = (page - 1) * pageSize;
  const pageRows = rows.slice(start, start + pageSize);
  const noRows = !report || !reportRows(report).length;

  if (els.tableCount) els.tableCount.textContent = String(total);
  if (els.matchEmpty) {
    const show = noRows || total === 0;
    els.matchEmpty.classList.toggle('hidden', !show);
    els.matchEmpty.textContent = noRows
      ? '尚未导入榜单。导入后点「分析补数」，这里会显示每一行的尺寸段 / 价格段与来源。'
      : '没有符合当前筛选 / 搜索条件的行。';
  }
  if (els.matchBodyRows) {
    els.matchBodyRows.innerHTML = pageRows.map(({ row, index }) => matchRowHtml(row, index)).join('');
    bindPreviewButtons();
  }
  applyTableColumns('match');
  syncHeaderFilterButtons('match');
  updateReviewToolbar(rows);
  updateConfirmWriteBtn();
  renderPager(els.matchPager, { page, pageSize, total }, (next) => {
    state.filter.page = next;
    renderMatchTable();
  });
}

/** 复核工具栏：当前筛选里的待确认数量 + 采集复核模式提示 */
function updateReviewToolbar(filteredList) {
  const list = Array.isArray(filteredList) ? filteredList : filteredMatchRows().rows;
  let count = 0;
  for (const item of list) {
    if (item && item.row && reviewNeeded(item.row)) count++;
  }
  if (els.confirmReviewBtn) {
    els.confirmReviewBtn.textContent = '确认当前筛选(' + count + ')';
    els.confirmReviewBtn.disabled = count === 0;
    els.confirmReviewBtn.title = count
      ? '把当前筛选结果里 ' + count + ' 行「需确认」标记为已人工确认'
      : '当前筛选没有待确认的行';
  }
  const mode = (state.settings && state.settings.capture && state.settings.capture.mode) || 'smart';
  const maxSamples = (state.settings && state.settings.capture && state.settings.capture.maxSamples) || 3;
  if (els.captureModeHint) {
    const cap = (state.settings && state.settings.capture) || {};
    const interval = (Number(cap.delayMin) || 5) + '~' + (Number(cap.delayMax) || 10) + 's';
    els.captureModeHint.textContent = '复核模式：' + (CAPTURE_MODE_LABELS[mode] || mode) +
      (mode === 'single' ? '' : ' · 最多 ' + maxSamples + ' 次') +
      ' · 间隔 ' + interval + ' · 每批 ' + (Number(cap.maxBatch != null ? cap.maxBatch : cap.batchLimit) || 20);
    els.captureModeHint.title = CAPTURE_MODE_HINTS[mode] || '';
  }
}

/* ---------------- 通用分页器 ---------------- */

function renderPager(container, info, onGo) {
  if (!container) return;
  const total = Number(info.total) || 0;
  const pageSize = Number(info.pageSize) || 100;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, Number(info.page) || 1), pages);
  container.innerHTML =
    '<span>共 <b class="num">' + fmtNum(total, 0) + '</b> 行 · 第 <span class="num">' + page + '</span>/<span class="num">' + pages + '</span> 页</span>' +
    '<button class="page-btn" type="button" data-go="first"' + (page <= 1 ? ' disabled' : '') + '>首页</button>' +
    '<button class="page-btn" type="button" data-go="prev"' + (page <= 1 ? ' disabled' : '') + '>上一页</button>' +
    '<button class="page-btn" type="button" data-go="next"' + (page >= pages ? ' disabled' : '') + '>下一页</button>' +
    '<button class="page-btn" type="button" data-go="last"' + (page >= pages ? ' disabled' : '') + '>末页</button>' +
    '<span>跳至</span><input class="input page-jump num" type="number" min="1" max="' + pages + '" value="' + page + '">';
  container.onclick = (e) => {
    const btn = e.target.closest('button[data-go]');
    if (!btn || btn.disabled) return;
    let next = page;
    if (btn.dataset.go === 'first') next = 1;
    else if (btn.dataset.go === 'prev') next = page - 1;
    else if (btn.dataset.go === 'next') next = page + 1;
    else if (btn.dataset.go === 'last') next = pages;
    onGo(Math.min(Math.max(1, next), pages));
  };
  const jump = container.querySelector('input.page-jump');
  if (jump) {
    jump.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const v = parseInt(jump.value, 10);
      if (Number.isFinite(v)) onGo(Math.min(Math.max(1, v), pages));
    });
  }
}

/* ---------------- 行内编辑尺寸段 / 价格段 ---------------- */

let cellEditActive = false;

function normalizeBandValue(field, rawText) {
  const raw = String(rawText == null ? '' : rawText).trim();
  if (!raw) return { value: '', dirty: false };
  if (lib.rules) {
    const fn = field === 'size' ? lib.rules.normalizeSizeBand : lib.rules.normalizePriceBand;
    if (typeof fn === 'function') {
      try {
        const ret = fn(raw);
        if (ret && typeof ret === 'object') return { value: String(ret.value == null ? '' : ret.value), dirty: !!ret.dirty };
        if (typeof ret === 'string') return { value: ret, dirty: ret !== raw };
      } catch (e) {
        logLine('归一化失败（按原值保存）：' + humanError(e));
      }
    }
  }
  return { value: raw, dirty: false };
}

function refreshRowStatus(row) {
  const hasSize = rowHasSize(row);
  const hasPrice = rowHasPrice(row);
  if (rowFailed(row) && !(hasSize && hasPrice)) {
    row.status = '采集失败';
    return;
  }
  if (hasSize && hasPrice) {
    row.status = row.status === '已补采' ? '已补采' : '已匹配';
    row.captureFailed = false;
    return;
  }
  if (hasSize) { row.status = '部分'; return; }
  if (hasPrice) { row.status = '待补'; return; }
  row.status = '待采集';
}

function openCellEditor(cellEl, context) {
  if (!cellEl || cellEditActive) return;
  const field = cellEl.dataset.field;
  if (field !== 'size' && field !== 'price' && field !== 'brand' && field !== 'model' && field !== 'package') return;
  const index = Number(cellEl.dataset.index);
  const store = cellEl.dataset.store || '';
  let row = null;

  if (context === 'match') {
    const report = activeReport();
    row = report && reportRows(report)[index];
    if (!row) return;
  } else {
    row = libraryRowByKey(store, cellEl.dataset.sku);
    if (!row) return;
  }

  const td = cellEl.parentElement;
  const inputId = field === 'size' ? 'sizeBandList' : field === 'price' ? 'priceBandList' : '';
  const placeholder = field === 'size'
    ? '尺寸段，如 75英寸'
    : field === 'price'
      ? '价格段，如 3500元至4000元'
      : field === 'brand'
        ? '品牌，如 海信 / 创维 / 品牌B'
        : field === 'model'
          ? '型号，如 100XP3E / FW-75BZ30L'
          : '套餐，如 4+128G / 含推车+翻页笔';
  cellEditActive = true;
  td.innerHTML = '<div class="cell-editor">' +
    '<input class="input" ' + (inputId ? 'list="' + inputId + '" ' : '') + 'value="' + esc(row[field] || '') + '" placeholder="' + esc(placeholder) + '">' +
    '<div class="hint-row"><button type="button" class="mini" data-ed="save">保存</button><button type="button" class="mini" data-ed="cancel">取消</button></div>' +
  '</div>';

  const input = td.querySelector('input');
  const saveBtn = td.querySelector('[data-ed="save"]');
  const cancelBtn = td.querySelector('[data-ed="cancel"]');

  const finish = (save) => {
    if (!cellEditActive) return;
    cellEditActive = false;
    const value = input.value.trim();
    if (save) {
      if (context === 'match') saveMatchCell(index, field, value);
      else saveLibraryCell(store, row, field, value);
    } else {
      if (context === 'match') renderMatchTable();
      else renderLibraryTable();
    }
  };

  input.focus();
  input.select();
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => {
    // 点击页面其它位置时自动保存；按钮按下前 preventDefault 保持焦点，由 click 处理
    setTimeout(() => { if (cellEditActive) finish(true); }, 160);
  });
  for (const btn of [saveBtn, cancelBtn]) {
    if (!btn) continue;
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', () => finish(btn === saveBtn));
  }
}

function saveMatchCell(index, field, rawValue) {
  const report = activeReport();
  const row = report && reportRows(report)[index];
  if (!row) {
    renderMatchTable();
    return;
  }
  const before = row[field] || '';
  let normalized;
  if (field === 'brand') {
    let brand = String(rawValue == null ? '' : rawValue).trim();
    if (brand && lib.rules && typeof lib.rules.normalizeBrand === 'function') {
      try {
        const norm = lib.rules.normalizeBrand(brand);
        if (norm) brand = norm;
      } catch (e) { /* 保留用户输入 */ }
    }
    normalized = { value: brand, dirty: false };
  } else if (field === 'model' || field === 'package') {
    normalized = { value: String(rawValue == null ? '' : rawValue).trim(), dirty: false };
  } else {
    normalized = normalizeBandValue(field, rawValue);
  }
  if (normalized.value === before) {
    renderMatchTable();
    return;
  }
  row[field] = normalized.value;
  if (field === 'size') {
    if (normalized.dirty) row.sizeRaw = rawValue;
    if (normalized.value) clearSizeReviewFlags(row); // v2.1.6：人工补齐后解除待复核
  } else if (field === 'price') {
    if (normalized.dirty) row.priceRaw = rawValue;
  }
  const src = row.source && typeof row.source === 'object'
    ? row.source
    : { size: typeof row.source === 'string' ? row.source : '', price: typeof row.source === 'string' ? row.source : '', brand: '', model: '', package: '' };
  src[field] = '手动';
  row.source = src;
  if (field === 'model') row.modelSource = '手动';
  if (field === 'package') row.packageSource = '手动';
  refreshRowStatus(row);

  // 写回匹配库（目标 8：本次补齐的映射自动写回，下个月直接用）
  let wroteLibrary = false;
  if (report && report.store && lib.storeSchema && typeof lib.storeSchema.upsertMatch === 'function' && row.sku) {
    try {
      lib.storeSchema.upsertMatch(state.library, report.store, {
        sku: String(row.sku),
        name: row.name || '',
        brand: row.brand || '',
        model: row.model || '',
        package: row.package || '',
        size: row.size || '',
        price: row.price || '',
        shop: row.storeName || storeNameOf(report, row) || '',
        sizeRaw: row.sizeRaw || '',
        priceRaw: row.priceRaw || '',
        source: '手动',
        updatedAt: nowIso(),
      }, { origin: 'manual', verified: true, verifiedAt: nowIso() });
      row.libState = 'verified';
      markDirty('library');
      wroteLibrary = true;
    } catch (e) {
      logLine('写回匹配库失败：' + humanError(e));
    }
  }

  state.session.updatedAt = nowIso();
  markDirty('session');
  state.statsStale = true;
  renderAll();
  const label = EDITABLE_FIELD_LABELS[field] || field;
  toast('已保存' + label + '：' + (normalized.value || '（空）') + (wroteLibrary ? '，并写回匹配库' : ''), 'ok');
}

/* ============================ 导入 / 分析 / 演示 ============================ */

function applyParsedToReport(report, parsed) {
  report.sheetName = parsed.sheetName || report.sheetName || '';
  report.headerRow = Number.isFinite(Number(parsed.headerRow)) ? Number(parsed.headerRow) : 0;
  report.headers = Array.isArray(parsed.headers) ? parsed.headers : (report.headers || []);
  report.columnIndex = parsed.columns && typeof parsed.columns === 'object' ? parsed.columns : {};
  report.columnNames = parsed.headerNames && typeof parsed.headerNames === 'object' ? parsed.headerNames : {};
  report.confidence = parsed.confidence != null ? Number(parsed.confidence) : 0;
  report.diagnostics = parsed.diagnostics || null;

  const parsedRows = Array.isArray(parsed.rows) ? parsed.rows : [];
  report.rows = parsedRows.map((r, i) => {
    let amount = null;
    if (r.amount != null && Number.isFinite(Number(r.amount))) amount = Number(r.amount);
    else if (lib.rules && typeof lib.rules.parseAmountRange === 'function') {
      try {
        const v = lib.rules.parseAmountRange(r.amountRaw);
        if (v != null && Number.isFinite(Number(v))) amount = Number(v);
      } catch (e) { /* ignore */ }
    }
    const amountRaw = r.amountRaw == null ? '' : String(r.amountRaw);
    let sku = r.sku;
    if (lib.headerMap && typeof lib.headerMap.normalizeSku === 'function') {
      try { sku = lib.headerMap.normalizeSku(sku); } catch (e) { sku = String(sku == null ? '' : sku); }
    }
    sku = String(sku == null ? '' : sku).trim().replace(/\.0+$/, '');
    return {
      rowNo: r.rowNo != null ? r.rowNo : i + 1,
      raw: r.raw && typeof r.raw === 'object' ? r.raw : {},
      sku,
      name: r.name == null ? '' : String(r.name),
      brand: r.brand == null ? '' : String(r.brand),
      // 榜单里的品牌列原始值（重跑分析时用于还原，避免把推断结果当成榜单品牌列）
      brandRaw: r.brand == null ? '' : String(r.brand),
      storeName: r.storeName == null ? '' : String(r.storeName),
      model: r.model == null ? '' : String(r.model),
      package: r.package == null ? '' : String(r.package),
      modelSource: r.modelSource == null ? '' : String(r.modelSource),
      packageSource: r.packageSource == null ? '' : String(r.packageSource),
      amountRaw,
      amount,
      amountAnomaly: amount == null && !!amountRaw.trim(),
      sizeRaw: r.sizeRaw == null ? '' : String(r.sizeRaw),
      priceRaw: r.priceRaw == null ? '' : String(r.priceRaw),
      size: '',
      price: '',
      capturePrice: null,
      sampleCount: null,
      sampleSpread: null,
      review: null,
      reviewText: '',
      source: { size: '', price: '', brand: '', model: '', package: '' },
      status: '待分析',
      note: '',
      captureFailed: false,
      _i: i,
    };
  });
}

function applyAnalyzed(report, result) {
  if (!result || !Array.isArray(result.rows)) return false;
  const before = reportRows(report);
  if (result.rows.length !== before.length) {
    logLine('分析结果行数不一致（原 ' + before.length + ' / 返回 ' + result.rows.length + '），已保留原数据');
    return false;
  }
  report.rows = result.rows.map((row, i) => {
    const base = before[i] || {};
    const merged = Object.assign({}, base, row);
    merged.raw = (row && row.raw) || base.raw || {};
    merged.amountRaw = row && row.amountRaw != null ? row.amountRaw : base.amountRaw;
    merged.amount = row && row.amount != null ? row.amount : base.amount;
    merged.amountAnomaly = row && row.amountAnomaly != null ? row.amountAnomaly : base.amountAnomaly;
    merged._i = i;
    if (!merged.source || typeof merged.source !== 'object') merged.source = { size: '', price: '', brand: '', model: '', package: '' };
    if (merged.source.model == null) merged.source.model = '';
    if (merged.source.package == null) merged.source.package = '';
    if (merged.review === undefined) merged.review = base.review || null;
    if (merged.reviewText === undefined) merged.reviewText = base.reviewText || '';
    return merged;
  });
  report.summary = result.summary || null;
  report.analyzedAt = nowIso();
  // v2.1.4：分析/采集后重算入库状态（绝不自动写库，只更新 libState）
  try { invalidateLibraryStates(); } catch (e) { /* ignore */ }
  return true;
}

function bindReportStore(report) {
  if (!lib.headerMap || typeof lib.headerMap.suggestStoreBinding !== 'function') return;
  try {
    const binding = lib.headerMap.suggestStoreBinding(report, state.library);
    if (binding && binding.store) {
      report.store = binding.store;
      report.storeScore = Number(binding.score) || 0;
      report.bindingReasons = Array.isArray(binding.reasons) ? binding.reasons : [];
    }
  } catch (e) {
    logLine('自动绑定类目失败：' + humanError(e));
  }
}

/* ============================ 复核确认（多采样） ============================ */

/**
 * 重跑分析前把推断出来的品牌还原成「榜单原始品牌列」，
 * 否则 analyzeReport 会把上一轮的推断结果当作榜单品牌列（source.brand 变成 '列'）。
 * 手动修改 / 页面采集来的品牌保留。
 */
function prepareRowsForReanalyze(report) {
  for (const row of reportRows(report)) {
    if (row.brandRaw == null) row.brandRaw = row.brand || '';
    const brandSource = row.source && typeof row.source === 'object' ? row.source.brand : '';
    if (brandSource !== '手动' && brandSource !== '页面采集') {
      row.brand = row.brandRaw || '';
    }
  }
}

/** 人工确认一行的复核结果：确认后状态回到「已补采」，并同步写一份到 captures */
function confirmRowReview(row, opts) {
  if (!row || !row.review) return false;
  const at = nowIso();
  row.review.confirmed = true;
  row.review.confirmedAt = at;
  row.review.needed = false;
  row.status = '已补采';
  row.captureFailed = false;
  const sku = String(row.sku || '');
  if (sku && state.captures && state.captures[sku]) {
    const capture = state.captures[sku];
    capture.review = Object.assign({}, capture.review || {}, { needed: false, confirmed: true, confirmedAt: at });
    markDirty('captures');
  }
  if (!(opts && opts.silent)) markDirty('session');
  return true;
}

/** 批量确认：默认只确认当前筛选结果，filteredOnly=false 时确认全部榜单行 */
function confirmReviewRows(filteredOnly) {
  const targets = [];
  const confirmedSkus = new Set();
  if (filteredOnly === false) {
    for (const report of state.session.reports || []) {
      for (const row of reportRows(report)) if (reviewNeeded(row)) targets.push(row);
    }
  } else {
    const { rows } = filteredMatchRows();
    for (const item of rows) {
      if (item && item.row && reviewNeeded(item.row)) {
        targets.push(item.row);
        if (item.row.sku) confirmedSkus.add(String(item.row.sku));
      }
    }
    // 同一 SKU 可能同时出现在多个榜单/类目里：确认一次即视为同一商品的取价复核已人工确认
    if (confirmedSkus.size) {
      for (const report of state.session.reports || []) {
        for (const row of reportRows(report)) {
          if (targets.indexOf(row) >= 0) continue;
          if (row.sku && confirmedSkus.has(String(row.sku)) && reviewNeeded(row)) targets.push(row);
        }
      }
    }
  }
  let count = 0;
  for (const row of targets) {
    if (confirmRowReview(row, { silent: true })) count++;
  }
  if (count) {
    state.session.updatedAt = nowIso();
    markDirty('session');
    state.statsStale = true;
    renderAll();
    toast('已确认 ' + count + ' 行复核结果（状态回到「已补采」）', 'ok');
    logLine('人工确认复核：' + count + ' 行');
  } else {
    toast('当前筛选没有待确认的行');
  }
  return count;
}

/** 当前榜单 + 全部榜单的待确认统计（调试/QA 用） */
function getReviewSummary() {
  const summary = { total: 0, reviewNeeded: 0, confirmed: 0, sampled1: 0, sampled2: 0, avgSampleSpread: 0 };
  let spreadSum = 0;
  let spreadCount = 0;
  for (const report of state.session.reports || []) {
    for (const row of reportRows(report)) {
      summary.total++;
      if (reviewNeeded(row)) summary.reviewNeeded++;
      if (reviewConfirmed(row)) summary.confirmed++;
      const count = row.sampleCount != null ? Number(row.sampleCount) : 0;
      if (count > 1) summary.sampled2++;
      else if (count === 1) summary.sampled1++;
      if (row.sampleSpread != null && Number.isFinite(Number(row.sampleSpread))) {
        spreadSum += Number(row.sampleSpread);
        spreadCount++;
      }
    }
  }
  summary.avgSampleSpread = spreadCount ? Math.round((spreadSum / spreadCount) * 100) / 100 : 0;
  summary.filteredOnly = filteredMatchRows().rows.filter((item) => item.row && reviewNeeded(item.row)).length;
  summary.needed = summary.reviewNeeded;
  return summary;
}

/** QA/Lead：注入模拟采集结果（无外网时验证复核 UI / 导出复核列） */
function simulateCaptures(input) {
  if (!lib.pipeline || typeof lib.pipeline.applyCaptures !== 'function') {
    toast('补数流水线未就绪，无法模拟采集结果', 'error');
    return { updated: 0, reviewNeeded: 0, error: 'pipeline 未就绪' };
  }
  const records = Array.isArray(input) ? input : Object.values(input || {});
  let added = 0;
  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    const sku = String(record.sku == null ? '' : record.sku).trim();
    if (!sku) continue;
    state.captures[sku] = Object.assign({}, record, { sku });
    added++;
  }
  markDirty('captures');
  let updated = 0;
  for (const report of state.session.reports || []) {
    try {
      const res = lib.pipeline.applyCaptures(report, state.captures, state.settings, state.library);
      if (res) {
        if (Array.isArray(res.rows) && res.rows.length === reportRows(report).length) {
          applyAnalyzed(report, { rows: res.rows, summary: res.summary || report.summary });
        }
        if (Number.isFinite(Number(res.updated))) updated += Number(res.updated);
      }
    } catch (e) {
      logLine('模拟采集回填失败：' + humanError(e));
    }
  }
  // applyCaptures 按设计「已补齐的行不覆盖」；QA 造数时如果显式给了 review.needed，就按它补一行
  // 复核结论（已补齐行走 evaluatePriceReview 计算；仍只调用 lib.rules，不复制判定逻辑）。
  let forced = 0;
  if (lib.rules && typeof lib.rules.evaluatePriceReview === 'function') {
    for (const record of records) {
      const sku = String(record && record.sku != null ? record.sku : '').trim();
      if (!sku) continue;
      const ctx = findRowContextBySku(sku);
      if (!ctx) continue;
      const row = ctx.row;
      const capture = state.captures[sku];
      if (!capture || capture.fail) continue;
      let review = null;
      if (row.size && row.price) {
        review = evaluateReviewForCapture({ capture, task: buildCaptureTask(sku, row, ctx.report) });
      }
      const supplied = capture.review && capture.review.needed ? capture.review : null;
      if (supplied) {
        const base = review || {};
        review = Object.assign({}, base, {
          needed: true,
          reasons: Array.isArray(supplied.reasons) && supplied.reasons.length
            ? supplied.reasons
            : (Array.isArray(base.reasons) && base.reasons.length ? base.reasons : [{ code: 'QA_SIMULATED', text: 'QA 模拟复核疑点' }]),
          confirmed: !!supplied.confirmed,
          confirmedAt: supplied.confirmedAt ? String(supplied.confirmedAt) : '',
          price: capture.price != null ? Number(capture.price) : base.price,
          sampleCount: Array.isArray(capture.samples) ? capture.samples.length : (capture.sampleCount != null ? Number(capture.sampleCount) : base.sampleCount),
          spread: capture.spread != null ? Number(capture.spread) : base.spread,
          consistent: capture.consistent != null ? !!capture.consistent : base.consistent,
        });
      }
      if (!review) continue;
      row.capturePrice = capture.price != null ? Number(capture.price) : row.capturePrice;
      row.sampleCount = Array.isArray(capture.samples) ? capture.samples.length : (capture.sampleCount != null ? Number(capture.sampleCount) : row.sampleCount);
      row.sampleSpread = capture.spread != null ? Number(capture.spread) : row.sampleSpread;
      row.review = review;
      row.reviewText = (review.reasons || []).map((r) => (r && r.text) || '').filter(Boolean).join('；');
      if (review.needed) row.status = REVIEW_TEXT;
      else if (row.size && row.price && row.status === REVIEW_TEXT) row.status = '已补采';
      capture.review = review;
      forced++;
    }
  }
  state.session.updatedAt = nowIso();
  markDirty('session');
  state.statsStale = true;
  renderAll();
  const review = getReviewSummary();
  logLine('模拟采集结果已注入：' + added + ' 条，回填 ' + updated + ' 行' + (forced ? '，强制复核 ' + forced + ' 行' : '') + '，需确认 ' + review.reviewNeeded + ' 行');
  return { updated: updated + forced, reviewNeeded: review.reviewNeeded, injected: added, forced };
}

async function handleReportFiles(fileList) {
  const files = Array.from(fileList || []).filter((f) => /\.xlsx$/i.test(f.name || ''));
  if (!files.length) {
    toast('请选择 .xlsx 格式的榜单文件', 'error');
    return;
  }
  if (!engineReadyFor('xlsxRead', 'headerMap')) {
    toast('数据引擎未就绪：缺少 xlsx 读取或表头识别模块，暂时无法导入榜单（lib 就绪后刷新页面即可）。', 'error');
    return;
  }
  setBusy(true);
  let ok = 0;
  let fail = 0;
  for (const file of files) {
    try {
      setSaveState('解析 ' + truncate(file.name, 20) + '…');
      const buf = await file.arrayBuffer();
      const wb = await lib.xlsxRead.readXlsx(buf);
      if (!wb || !Array.isArray(wb.sheets) || !wb.sheets.length) throw new Error('没有读到任何工作表');
      const overrides = (state.settings.mapping.overrides || {})[file.name] || null;

      let pickIndex = 0;
      if (typeof lib.headerMap.pickDataSheet === 'function') {
        try {
          const pick = lib.headerMap.pickDataSheet(wb.sheets);
          if (pick && Number.isInteger(pick.index) && wb.sheets[pick.index]) pickIndex = pick.index;
          if (pick && pick.reason) logLine('选择工作表：' + pick.reason);
        } catch (e) {
          logLine('自动选择数据工作表失败，改用第一个：' + humanError(e));
        }
      }
      const sheet = wb.sheets[pickIndex];
      let parsed;
      try {
        parsed = lib.headerMap.parseReportSheet(sheet, overrides || undefined);
      } catch (e) {
        throw new Error('表头识别失败：' + humanError(e));
      }
      if (!parsed || !Array.isArray(parsed.rows) || !parsed.rows.length) {
        throw new Error('没有解析到数据行（选中的可能是说明页或空表，可点「表头诊断」手动指定）');
      }

      const report = {
        id: nextId('r'),
        fileName: file.name,
        sheetName: parsed.sheetName || sheet.name || '',
        sheetIndex: pickIndex,
        originalSheets: wb.sheets,
        sheetPreview: (sheet.rows || []).slice(0, 11),
        headerRow: parsed.headerRow || 0,
        headers: parsed.headers || [],
        columnIndex: parsed.columns || {},
        columnNames: parsed.headerNames || {},
        confidence: parsed.confidence != null ? Number(parsed.confidence) : 0,
        diagnostics: parsed.diagnostics || null,
        rows: [],
        summary: null,
        store: '',
        storeScore: 0,
        addedAt: nowIso(),
      };
      applyParsedToReport(report, parsed);
      bindReportStore(report);
      if (lib.pipeline && typeof lib.pipeline.analyzeReport === 'function') {
        try {
          applyAnalyzed(report, lib.pipeline.analyzeReport(report, state.library, state.settings));
        } catch (e) {
          logLine('自动分析失败：' + humanError(e));
        }
      }
      state.session.reports.push(report);
      state.session.activeReportId = report.id;
      ok++;
      logLine('导入 ' + file.name + '：sheet「' + report.sheetName + '」/ ' + report.rows.length + ' 行 / 表头置信度 ' + fmtPct(report.confidence, 0) + ' / 绑定「' + (report.store || '未绑定') + '」');
    } catch (e) {
      fail++;
      logLine('导入失败 ' + file.name + '：' + ((e && e.message) || e));
      toast('导入「' + file.name + '」失败：' + humanError(e), 'error');
    }
  }
  state.session.updatedAt = nowIso();
  state.filter.page = 1;
  if (ok) state.importExpanded = false; // 导入完成后自动折叠 STEP01（DESIGN 18.3）
  markDirty('session');
  state.statsStale = true;
  setBusy(false);
  ensureDatalists();
  renderAll();
  if (ok) {
    setSaveState('已保存');
    toast('已导入 ' + ok + ' 个榜单' + (fail ? '（' + fail + ' 个失败）' : '') + '。可点「分析补数」重新分析，或先核对绑定类目。', 'ok');
  }
}

async function analyzeAll() {
  if (!lib.pipeline || typeof lib.pipeline.analyzeReport !== 'function') {
    toast('数据引擎未就绪：缺少补数流水线（lib/pipeline.js），暂时无法分析。', 'error');
    return;
  }
  const reports = state.session.reports || [];
  if (!reports.length) {
    toast('还没有榜单：先导入 .xlsx 榜单文件', 'error');
    return;
  }
  setBusy(true);
  setSaveState('分析中…');
  let rows = 0;
  let failedReports = 0;
  for (const report of reports) {
    try {
      prepareRowsForReanalyze(report);
      const res = lib.pipeline.analyzeReport(report, state.library, state.settings);
      if (!applyAnalyzed(report, res)) failedReports++;
      rows += reportRows(report).length;
    } catch (e) {
      failedReports++;
      logLine('分析「' + report.fileName + '」失败：' + ((e && e.message) || e));
      toast('分析「' + report.fileName + '」失败：' + humanError(e), 'error');
    }
  }
  state.session.updatedAt = nowIso();
  state.lastAnalyzeAt = state.session.updatedAt;
  markDirty('session');
  state.statsStale = true;
  setBusy(false);
  ensureDatalists();
  // v2.1：分析后把已有采集缓存（含多采样 review）重新回填，避免重新分析丢失复核状态
  try {
    const updated = await applyCaptureResults();
    if (updated) logLine('已回填采集缓存：' + updated + ' 行（含多采样复核状态）');
  } catch (e) {
    logLine('回填采集缓存失败：' + humanError(e));
  }
  renderAll();
  const review = getReviewSummary();
  logLine('分析完成：' + reports.length + ' 个榜单 / ' + rows + ' 行' + (failedReports ? '（' + failedReports + ' 个失败）' : '') + (review.reviewNeeded ? '，待确认 ' + review.reviewNeeded + ' 行' : ''));
  toast('分析完成：' + reports.length + ' 个榜单 / ' + fmtNum(rows, 0) + ' 行' + (failedReports ? '（' + failedReports + ' 个失败）' : '') + (review.reviewNeeded ? '，待确认 ' + review.reviewNeeded + ' 行' : ''), 'ok');
}

function setBusy(busy) {
  state.busy = !!busy;
  for (const btn of [els.analyzeBtn, els.captureBtn, els.pickReportBtn, els.loadDemoBtn]) {
    if (btn) btn.disabled = !!busy;
  }
  if (els.runHint) {
    if (busy) els.runHint.textContent = '处理中，请稍候…';
    else updateRunHint();
  }
}

function updateRunHint() {
  if (!els.runHint || state.capture.running || state.busy) return;
  const k = computeKpis();
  if (!k.total) {
    els.runHint.textContent = '先导入榜单；再用「分析补数」离线补齐，最后按需补采价格 / 套餐 / 型号。';
    return;
  }
  const need = (() => { try { return captureNeedStats(); } catch (e) { return { skus: 0, package: 0, model: 0 }; } })();
  els.runHint.textContent = '当前榜单 ' + fmtNum(k.total, 0) + ' 行：尺寸段 ' + fmtPct(k.sizePct, 0) +
    '、价格段 ' + fmtPct(k.pricePct, 0) + '，待补采 ' + fmtNum(need.skus || k.pending, 0) + ' 行' +
    (need.package ? '（缺套餐 ' + fmtNum(need.package, 0) + '）' : '') +
    (need.model ? '（缺型号 ' + fmtNum(need.model, 0) + '）' : '') +
    (k.review ? '，待确认 ' + fmtNum(k.review, 0) + ' 行' : '') + '。';
}

/* ---------------- 演示榜单（仅本地预览用，扩展内隐藏） ---------------- */

function loadDemoReport() {
  const names = storeNames();
  if (!names.length) {
    toast('匹配库为空，无法生成演示榜单', 'error');
    return;
  }
  const storeName = names[0];
  const store = state.library.stores[storeName];
  const entries = Object.entries((store && store.rows) || {}).slice(0, 24);
  if (!entries.length) {
    toast('匹配库为空，无法生成演示榜单', 'error');
    return;
  }
  const headers = ['SKU ID', '商品名称', '品牌', '成交金额', '店铺名称'];
  const report = {
    id: nextId('r'),
    fileName: '演示榜单-会议电视-预览.xlsx',
    sheetName: '演示数据',
    sheetIndex: 0,
    originalSheets: [],
    sheetPreview: [headers],
    headerRow: 0,
    headers,
    columnIndex: { sku: 0, name: 1, brand: 2, amount: 3, store: 4, size: -1, price: -1 },
    columnNames: { sku: 'SKU ID', name: '商品名称', brand: '品牌', amount: '成交金额', store: '店铺名称' },
    confidence: 0.99,
    rows: [],
    summary: null,
    store: storeName,
    storeScore: 1,
    addedAt: nowIso(),
  };
  report.rows = entries.map(([sku, r], i) => {
    const amountRaw = '￥' + ((i % 4) + 1) * 50 + '万 ~ ￥' + ((i % 4) + 2) * 50 + '万';
    let amount = null;
    if (lib.rules && typeof lib.rules.parseAmountRange === 'function') {
      try { amount = lib.rules.parseAmountRange(amountRaw); } catch (e) { amount = null; }
    }
    if (amount != null) amount = Number(amount);
    return {
      rowNo: i + 2,
      raw: { 'SKU ID': sku, 商品名称: r.name || '', 品牌: r.brand || '', 成交金额: amountRaw, 店铺名称: storeName },
      sku,
      name: r.name || '',
      brand: r.brand || '',
      brandRaw: '',
      storeName: storeName,
      amountRaw,
      amount: Number.isFinite(amount) ? amount : null,
      amountAnomaly: !Number.isFinite(amount),
      size: '',
      price: '',
      source: { size: '', price: '', brand: '' },
      status: '待分析',
      note: '',
      captureFailed: false,
      _i: i,
    };
  });
  if (lib.pipeline && typeof lib.pipeline.analyzeReport === 'function') {
    try { applyAnalyzed(report, lib.pipeline.analyzeReport(report, state.library, state.settings)); }
    catch (e) { logLine('演示榜单分析失败：' + humanError(e)); }
  }
  state.session.reports.push(report);
  state.session.activeReportId = report.id;
  state.session.updatedAt = nowIso();
  markDirty('session');
  state.statsStale = true;
  renderAll();
  toast('已载入演示榜单 ' + report.rows.length + ' 行（仅预览用，不会写回真实匹配库）', 'ok');
}

/* ============================ 表头诊断弹窗 ============================ */

const HEADER_FIELDS = [
  ['sku', 'SKU（必填）', true],
  ['name', '商品名称', false],
  ['brand', '品牌', false],
  ['model', '型号', false],
  ['package', '套餐', false],
  ['amount', '成交金额', false],
  ['store', '店铺名称', false],
  ['size', '尺寸段', false],
  ['price', '价格段', false],
];

function colLetter(index) {
  let n = Number(index) + 1;
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function openHeaderDialog(reportArg) {
  const report = reportArg || activeReport();
  if (!report) {
    toast('请先导入并选择榜单', 'error');
    return;
  }
  if (!lib.headerMap || typeof lib.headerMap.parseReportSheet !== 'function') {
    toast('表头诊断需要 lib/header-map.js 就绪，请刷新页面后重试', 'error');
    return;
  }
  const selections = {};
  const idxMap = report.columnIndex || {};
  for (const [field] of HEADER_FIELDS) {
    const idx = Number(idxMap[field]);
    selections[field] = Number.isInteger(idx) && idx >= 0 ? idx : -1;
  }
  state.headerCtx = { report, headerRow: Number(report.headerRow) || 0, selections };
  if (els.headerDialogFile) els.headerDialogFile.textContent = report.fileName || '—';
  if (els.headerDialogSheet) els.headerDialogSheet.textContent = report.sheetName || '—';
  renderHeaderPreview();
  renderHeaderMapping();
  showDialog(els.headerDialog);
}

function headerPreviewRows(reportArg) {
  const report = reportArg || (state.headerCtx && state.headerCtx.report);
  const preview = Array.isArray(report && report.sheetPreview) ? report.sheetPreview : [];
  return preview;
}

function renderHeaderPreview() {
  const ctx = state.headerCtx;
  if (!ctx || !els.headerPreviewWrap) return;
  const preview = headerPreviewRows(ctx.report);
  const width = Math.max.apply(null, preview.map((r) => (Array.isArray(r) ? r.length : 0)).concat([1]));
  const headerRow = ctx.headerRow;
  let html = '<table><thead><tr><th>行</th>';
  for (let c = 0; c < width; c++) html += '<th>' + colLetter(c) + '</th>';
  html += '</tr></thead><tbody>';
  for (let r = 0; r < preview.length; r++) {
    const arr = Array.isArray(preview[r]) ? preview[r] : [];
    html += '<tr class="' + (r === headerRow ? 'header-row' : '') + '"><th>' + (r + 1) + '</th>';
    for (let c = 0; c < width; c++) {
      const raw = arr[c] == null ? '' : String(arr[c]);
      html += '<td title="' + esc(raw) + '">' + esc(truncate(raw, 26)) + '</td>';
    }
    html += '</tr>';
  }
  html += '</tbody></table>';
  els.headerPreviewWrap.innerHTML = html;
}

function renderHeaderMapping() {
  const ctx = state.headerCtx;
  if (!ctx || !els.headerMapping) return;
  const preview = headerPreviewRows(ctx.report);
  const headerCells = Array.isArray(preview[ctx.headerRow]) ? preview[ctx.headerRow] : [];
  const nCols = Math.max(headerCells.length, (ctx.report.headers || []).length, 1);
  const options = [];
  for (let c = 0; c < nCols; c++) {
    const text = headerCells[c] == null ? '' : String(headerCells[c]);
    options.push('<option value="' + c + '">' + colLetter(c) + ' · ' + (text ? esc(truncate(text, 16)) : '（空）') + '</option>');
  }
  const noneOption = '<option value="-1">（自动识别 / 不指定）</option>';

  let html = '<label class="map-field req"><span>表头行</span><select class="input" data-map-header="1">';
  const maxRows = Math.max(preview.length, 1);
  for (let r = 0; r < maxRows; r++) {
    html += '<option value="' + r + '"' + (ctx.headerRow === r ? ' selected' : '') + '>第 ' + (r + 1) + ' 行</option>';
  }
  html += '</select></label>';

  for (const [field, label, required] of HEADER_FIELDS) {
    const current = ctx.selections[field];
    html += '<label class="map-field' + (required ? ' req' : '') + '"><span>' + esc(label) + '</span><select class="input" data-map="' + field + '">' + noneOption;
    for (let c = 0; c < nCols; c++) {
      const text = headerCells[c] == null ? '' : String(headerCells[c]);
      html += '<option value="' + c + '"' + (current === c ? ' selected' : '') + '>' + colLetter(c) + ' · ' + (text ? esc(truncate(text, 16)) : '（空）') + '</option>';
    }
    html += '</select></label>';
  }
  els.headerMapping.innerHTML = html;
}

async function saveHeaderDialog() {
  const ctx = state.headerCtx;
  if (!ctx) return;
  const report = ctx.report;

  // 读取当前下拉选择
  for (const sel of els.headerMapping.querySelectorAll('[data-map]')) {
    const field = sel.dataset.map;
    if (field in ctx.selections) ctx.selections[field] = parseInt(sel.value, 10);
  }
  const headerRowSel = els.headerMapping.querySelector('[data-map-header]');
  if (headerRowSel) ctx.headerRow = parseInt(headerRowSel.value, 10) || 0;

  const overrides = { headerRow: ctx.headerRow };
  let hasSku = false;
  for (const [field] of HEADER_FIELDS) {
    const idx = ctx.selections[field];
    if (Number.isInteger(idx) && idx >= 0) {
      overrides[field] = idx;
      if (field === 'sku') hasSku = true;
    }
  }
  if (!hasSku) {
    toast('请先指定 SKU 所在列（必填）', 'error');
    return;
  }
  closeDialog(els.headerDialog);

  try {
    if (!lib.headerMap || typeof lib.headerMap.parseReportSheet !== 'function') throw new Error('表头识别模块未就绪');
    const sheet = report.originalSheets && report.originalSheets[report.sheetIndex];
    if (!sheet) throw new Error('缺少原始工作表数据，请重新导入该榜单后再诊断');
    const parsed = lib.headerMap.parseReportSheet(sheet, overrides);
    if (!parsed || !Array.isArray(parsed.rows) || !parsed.rows.length) {
      throw new Error('按新映射没有解析到数据行，请检查表头行与列选择');
    }
    applyParsedToReport(report, parsed);
    if (parsed.diagnostics) report.diagnostics = parsed.diagnostics;

    // 按文件名记住映射
    state.settings.mapping.overrides[report.fileName] = Object.assign({ savedAt: nowIso() }, overrides);
    markDirty('settings');
    renderOverrides();

    // 重新绑定 + 分析
    const keepStore = report.store;
    bindReportStore(report);
    if (!report.store && keepStore) report.store = keepStore;
    if (lib.pipeline && typeof lib.pipeline.analyzeReport === 'function') {
      try { applyAnalyzed(report, lib.pipeline.analyzeReport(report, state.library, state.settings)); }
      catch (e) { logLine('重新分析失败：' + humanError(e)); }
    }
    state.session.updatedAt = nowIso();
    markDirty('session');
    state.statsStale = true;
    renderAll();
    toast('已按手动映射重新识别：' + report.rows.length + ' 行，表头置信度 ' + fmtPct(report.confidence, 0), 'ok');
  } catch (e) {
    logLine('表头诊断保存失败：' + ((e && e.message) || e));
    toast('重新识别失败：' + humanError(e), 'error');
  }
}

/* ============================ 在线补采（CaptureRunner） ============================ */

function findRowBySku(sku) {
  for (const report of state.session.reports || []) {
    for (const row of reportRows(report)) {
      if (String(row.sku) === String(sku)) return row;
    }
  }
  return null;
}

/** v2.1.3：该行是否需要补采（价格/尺寸，或套餐/型号缺口；DESIGN 18.4 套餐只来自榜单列/页面采集） */
function rowNeedsCapture(row) {
  if (!row || !row.sku) return false;
  if (reviewNeeded(row)) return true;
  if (!rowHasSize(row) || !rowHasPrice(row)) return true;
  if (!String(row.package || '').trim()) return true;
  if (!String(row.model || '').trim()) return true;
  return false;
}

function collectCaptureTasks() {
  const seen = new Set();
  const tasks = [];
  const capSettings = state.settings.capture || {};
  for (const report of state.session.reports || []) {
    for (const row of reportRows(report)) {
      if (!rowNeedsCapture(row)) continue;
      const sku = String(row.sku);
      if (seen.has(sku)) continue;
      if (capSettings.skipCapturedToday) {
        const cap = state.captures[sku];
        if (cap && cap.at && isToday(cap.at) && !cap.fail) continue;
      }
      seen.add(sku);
      tasks.push(buildCaptureTask(sku, row, report));
    }
  }
  return tasks;
}

/** 补采任务构成统计（工具栏提示用）：按去重 SKU 计 */
function captureNeedStats() {
  const stats = { skus: 0, price: 0, size: 0, package: 0, model: 0, review: 0 };
  const seen = new Set();
  for (const report of state.session.reports || []) {
    for (const row of reportRows(report)) {
      if (!row.sku) continue;
      const sku = String(row.sku);
      if (seen.has(sku)) continue;
      if (!rowNeedsCapture(row)) continue;
      seen.add(sku);
      stats.skus++;
      if (!rowHasPrice(row)) stats.price++;
      if (!rowHasSize(row)) stats.size++;
      if (!String(row.package || '').trim()) stats.package++;
      if (!String(row.model || '').trim()) stats.model++;
      if (reviewNeeded(row)) stats.review++;
    }
  }
  return stats;
}

/** 匹配库里同 SKU 的记录（取参考价格段用） */
function libraryRecordFor(sku, storeName) {
  const libraries = (state.library && state.library.stores) || {};
  const orderedNames = storeName && libraries[storeName] ? [storeName].concat(Object.keys(libraries)) : Object.keys(libraries);
  for (const name of orderedNames) {
    const store = libraries[name];
    const record = store && store.rows && store.rows[String(sku)];
    if (record) return record;
  }
  return null;
}

/** 组装采集任务：带 refBand / referenceRange，供 CaptureRunner 多次采样与复核判定 */
function buildCaptureTask(sku, row, report) {
  const task = { sku: String(sku), name: (row && row.name) || '' };
  if (row) {
    task.size = row.size || '';
    task.need = {
      price: !rowHasPrice(row),
      size: !rowHasSize(row),
      package: !String(row.package || '').trim(),
      model: !String(row.model || '').trim(),
      review: reviewNeeded(row),
    };
  }
  const storeName = (report && report.store) || '';
  if (report) task.store = storeName;
  if (row && row.price) task.refBand = row.price;
  else {
    const record = libraryRecordFor(sku, storeName);
    if (record && record.price) task.refBand = record.price;
    if (record) {
      task.libraryPriceBand = record.price || '';
      task.librarySizeBand = record.size || '';
    }
  }
  if (lib.pipeline && typeof lib.pipeline.buildReferencePriceRange === 'function') {
    try {
      const range = lib.pipeline.buildReferencePriceRange(state.library, storeName, (row && row.size) || task.librarySizeBand || '');
      if (range) task.referenceRange = range;
    } catch (e) {
      logLine('构建参考价格区间失败（忽略）：' + humanError(e));
    }
  }
  return task;
}

/** 从当前数据里按 SKU 找行 + 所属榜单（重采时补齐 task 上下文） */
function findRowContextBySku(sku) {
  for (const report of state.session.reports || []) {
    for (const row of reportRows(report)) {
      if (String(row.sku) === String(sku)) return { row, report };
    }
  }
  return null;
}

function setProgress(done, total, text, stats) {
  if (els.progressText) els.progressText.textContent = text || '';
  const offSale = Math.max(0, Math.floor(Number(stats && stats.offSale) || 0));
  let denom = Number(stats && stats.progressDenom);
  if (!isFinite(denom) || denom <= 0) denom = Math.max(0, total - offSale);
  let pct = Number(stats && stats.progressPct);
  if (!isFinite(pct)) pct = denom ? Math.round((done / denom) * 100) : 0;
  pct = Math.max(0, Math.min(100, pct));
  if (els.progressPct) {
    els.progressPct.textContent = denom
      ? done + ' / ' + denom + '（' + pct + '%）' + (offSale ? '（已下架 ' + offSale + ' 不计入）' : '')
      : '';
  }
  if (els.progressFill) {
    els.progressFill.style.width = (denom ? pct : 0) + '%';
  }
}

const PHASE_TEXT = {
  start: '准备启动采集…',
  nav: '正在打开商品页…',
  waiting: '等待页面价格加载…',
  result: '已读取页面结果',
  retry: '失败重试中…',
  pause: '已暂停',
  resume: '继续采集…',
  'auto-pause': '已自动暂停',
  stop: '正在停止…',
  sample: '多采样复核中…',
  done: '采集完成',
};

function renderCaptureUI() {
  const running = !!state.capture.running;
  if (els.pauseBtn) {
    els.pauseBtn.disabled = !running;
    const paused = running ? (state.capture.pausedFlag || !!(state.capture.runner && state.capture.runner.paused)) : false;
    els.pauseBtn.textContent = paused ? '继续' : '暂停';
  }
  if (els.stopBtn) els.stopBtn.disabled = !running;
  if (els.captureBtn) els.captureBtn.disabled = running || state.busy;
  if (running && els.runHint) {
    const batchInfo = state.capture.batchInfo;
    const batchText = batchInfo ? '本批 ' + batchInfo.queued + ' 条（上限 ' + batchInfo.maxBatch + '）；' : '';
    els.runHint.textContent = '补采进行中：' + batchText + '后台标签页逐个打开商品页读取价格与尺寸（多采样复核），可暂停 / 停止。';
  } else if (!state.busy) {
    updateRunHint();
  }
  updateReviewToolbar();
  const hasLog = state.capture.log.length > 0;
  if (els.progressPanel) {
    // 进度/日志区只在「开始过采集」后显示，避免首屏被空的「准备中…」占位
    els.progressPanel.classList.toggle('hidden', !(running || state.capture.summary || state.capture.everRun || (hasLog && running)));
  }
  // v2.1.4：风控冷却中禁用补采 + 横幅倒计时
  renderRiskAlert();
  // v2.1.5：异常等待条（采集停止时自动收起）
  if (!running) clearAnomalyWait();
  else renderAnomalyBar();
}

function onCaptureProgress(p) {
  if (!p) return;
  state.capture.progress = p;
  // v2.1.5：软异常等待（跳转/空页）→ 显示等待条，lib 负责到点自动继续；风控才冷却
  if (p.phase === 'anomaly-wait') {
    handleCaptureAnomaly(p);
  } else if (state.capture.anomaly && ['result', 'waiting', 'nav', 'done', 'resume', 'stop'].indexOf(p.phase) >= 0) {
    clearAnomalyWait();
  }
  const risk = riskFromCapturePayload(p);
  if (risk) handleCaptureRisk(risk);
  // v2.1.7：采集过程中若 lib 透传 priceChanges，日志同样提示「页面价格刷新」
  const progressChanges = Array.isArray(p.priceChanges) ? p.priceChanges : (p.capture && Array.isArray(p.capture.priceChanges) ? p.capture.priceChanges : null);
  if (progressChanges && progressChanges.length) {
    const sku = String(p.currentSku || (p.capture && p.capture.sku) || '');
    const key = sku + '|' + JSON.stringify(progressChanges);
    state.capture.priceRefreshLog = state.capture.priceRefreshLog || {};
    if (!state.capture.priceRefreshLog[key]) {
      state.capture.priceRefreshLog[key] = true;
      const text = progressChanges.map((item) => (item && item.from != null && item.to != null) ? item.from + '→' + item.to : '').filter(Boolean).join('，');
      if (text) logLine('↻ 页面价格刷新：' + text + '（已采用最新读数）');
    }
  }
  const done = Number(p.done) || 0;
  const total = Number(p.total) || 0;
  let phaseText = p.text || PHASE_TEXT[p.phase] || '采集进行中…';
  if (p.phase === 'sample') {
    const counts = [];
    if (p.sampleIndex != null) counts.push('第 ' + p.sampleIndex + ' 次采样');
    if (p.sampleCount != null) counts.push('已采 ' + p.sampleCount + ' 次');
    if (p.spread != null && Number(p.spread) > 0) counts.push('价差 ' + fmtNum(p.spread, 0) + ' 元');
    phaseText = '多采样复核：' + (counts.join(' · ') || phaseText);
  }
  setProgress(done, total, phaseText, {
    offSale: p.offSaleCount,
    progressDenom: p.progressDenom,
    progressPct: p.progressPct,
  });
  if (p.phase === 'pause' || p.phase === 'auto-pause') state.capture.pausedFlag = true;
  else if (p.phase === 'resume' || p.phase === 'result' || p.phase === 'nav' || p.phase === 'waiting' || p.phase === 'sample') state.capture.pausedFlag = false;
  if (els.runStats) {
    const parts = ['成功 ' + (Number(p.ok) || 0), '失败 ' + (Number(p.fail) || 0)];
    if (p.phase === 'sample') {
      if (p.sampleIndex != null) parts.push('复核第 ' + p.sampleIndex + ' 次');
      if (p.spread != null && Number(p.spread) > 0) parts.push('价差 ' + fmtNum(p.spread, 0) + ' 元');
      if (p.consistent === false) parts.push('样本不一致');
    }
    if (p.currentSku) parts.push('当前 ' + p.currentSku);
    if (p.autoPauseReason) parts.push('已自动暂停：' + p.autoPauseReason);
    els.runStats.innerHTML = parts.map((t) => '<span>' + esc(t) + '</span>').join('');
  }
  renderCaptureUI();
  if (p.phase === 'auto-pause' && p.autoPauseReason) {
    const reason = String(p.autoPauseReason);
    if (riskKeywords(reason)) {
      handleCaptureRisk({ hit: true, reason, url: p.url || '' });
    } else if (/连续.*异常|异常.*连续/.test(reason)) {
      // 连续软异常达到阈值：升级为冷却暂停并提示换账号/网络（DESIGN 20.8）
      handleCaptureRisk({ hit: true, reason, url: p.url || '' });
    } else if (softAnomalyKeywords(reason)) {
      handleCaptureAnomaly({ reason, remainingMs: anomalyWaitConfigSec() * 1000, totalMs: anomalyWaitConfigSec() * 1000 });
    } else {
      toast('采集已自动暂停：' + reason + '。检查登录状态后点「继续」或「停止」。', 'error');
    }
  }
}

function resultToCapture(sku, result) {
  const priceOf = (x) => {
    if (x == null) return null;
    const n = typeof x === 'object' ? Number(x.price) : Number(x);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const prices = {
    hand: priceOf(result.hand),
    main: priceOf(result.main),
    plus: priceOf(result.plus),
  };
  const prefer = (state.settings.price && state.settings.price.prefer) || ['hand', 'main', 'plus'];
  let priceKind = null;
  for (const key of prefer) {
    if (prices[key] != null) { priceKind = key; break; }
  }
  const size = result.size && typeof result.size === 'object' ? result.size : {};
  const sizeInch = Number.isFinite(Number(size.inch)) ? Number(size.inch) : Number.isFinite(Number(result.sizeInch)) ? Number(result.sizeInch) : null;
  const account = result.account && typeof result.account === 'object' ? (result.account.nickname || '') : (result.account || '');
  const price = priceKind ? prices[priceKind] : null;
  const capture = {
    sku: String(sku),
    at: result.at || nowIso(),
    account: account || '',
    url: result.url || ITEM_URL(sku),
    title: result.title || '',
    sizeInch,
    sizeText: size.text || result.sizeText || '',
    brand: result.brand || '',
    model: result.model || '',
    modelSource: result.modelSource || '',
    package: result.package || '',
    packageSource: result.packageSource || '',
    prices,
    priceKind,
    candidates: Array.isArray(result.candidates) ? result.candidates.slice(0, 20) : [],
    flags: result.flags || null,
    fail: result.ok === false ? { reason: result.reason || ((result.flags && result.flags.offSale) ? '已下架' : '采集失败'), at: result.at || nowIso() } : null,
  };
  if (result.flags && result.flags.offSale) {
    capture.offSale = true;
    capture.fail = capture.fail || { reason: '已下架', at: result.at || nowIso() };
    capture.fail.reason = '已下架';
  }
  if (price != null) {
    capture.price = price;
    capture.sampleCount = 1;
    capture.spread = 0;
    capture.consistent = true;
    capture.samples = [{ price, kind: priceKind, at: capture.at }];
  }
  if (result.candidateCount != null) capture.candidateCount = Number(result.candidateCount);
  if (result.textFallback != null) capture.textFallback = !!result.textFallback;
  // v2.1.7：价格类型/候选/位置/刷新记录（lib 采集结果字段，原样保存供展示与调试）
  capture.priceKindLabel = result.priceKindLabel || PRICE_KIND_LABELS[priceKind] || '';
  capture.priceChanges = Array.isArray(result.priceChanges) ? result.priceChanges.slice(0, 20) : [];
  capture.priceRect = result.priceRect || null;
  capture.sourceLabel = result.sourceLabel || '';
  capture.priceClass = result.priceClass || (result.priceRect && (result.priceRect.cls || result.priceRect.className)) || '';
  return capture;
}

/** 计算参考价：优先匹配库绑定类目的价格段，其次全局同 SKU 记录 */
function libraryPriceBandFor(sku, storeName) {
  const record = libraryRecordFor(sku, storeName);
  return record && record.price ? record.price : '';
}

/** onResult 后按 DESIGN 16.4 计算复核结论，写入 capture.review（lib 未就绪则跳过） */
function evaluateReviewForCapture(payload) {
  if (!lib.rules || typeof lib.rules.evaluatePriceReview !== 'function') return null;
  const capture = payload && payload.capture;
  if (!capture || capture.fail) return null;
  const task = (payload && payload.task) || {};
  const price = capture.price != null
    ? Number(capture.price)
    : payload.pricePick && payload.pricePick.price != null
      ? Number(payload.pricePick.price)
      : payload.price != null ? Number(payload.price) : null;
  if (price == null || !Number.isFinite(price)) return null;
  const samples = Array.isArray(capture.samples) && capture.samples.length
    ? capture.samples
    : Array.isArray(payload.samples) ? payload.samples : [{ price, kind: capture.priceKind || '', at: capture.at }];
  let priceBand = null;
  try {
    if (lib.rules.priceBandInfo) {
      const info = lib.rules.priceBandInfo(price, (state.settings.price && state.settings.price.bandBoundary) || 'rightOpen', {
        marginPct: (state.settings.price && state.settings.price.boundaryMarginPct) || 0.01,
      });
      priceBand = info && info.band ? info.band : null;
    }
  } catch (e) { /* 忽略，仍然做样本一致性复核 */ }
  const libraryBand = task.refBand || task.libraryPriceBand || libraryPriceBandFor(task.sku || capture.sku, task.store || '');
  const referenceRange = task.referenceRange || null;
  const candidateCount = capture.candidateCount != null
    ? Number(capture.candidateCount)
    : payload.result && Array.isArray(payload.result.candidates) ? payload.result.candidates.length : null;
  try {
    const review = lib.rules.evaluatePriceReview({
      price,
      samples,
      priceBand,
      libraryBand,
      referenceRange,
      priceKind: capture.priceKind || (payload.pricePick && payload.pricePick.kind) || '',
      candidateCount,
      settings: state.settings,
    });
    if (!review || typeof review !== 'object') return null;
    return Object.assign({ confirmed: false, confirmedAt: '' }, review);
  } catch (e) {
    logLine('复核判定失败（按单次采样处理）：' + humanError(e));
    return null;
  }
}

function onCaptureResult(payload) {
  if (!payload) return;
  // v2.1.5：下架/不存在只记日志并继续；风控（验证/登录）才冷却；软异常由 progress 等待处理
  const offSale = handleOffSaleResult(payload);
  if (offSale) {
    // lib 已把该 SKU 标失败；这里不暂停、不冷却，继续下一条
  }
  const risk = riskFromCapturePayload(payload);
  if (risk) handleCaptureRisk(risk);
  const sku = String((payload.task && payload.task.sku) || (payload.result && payload.result.sku) || '').trim();
  if (!sku) return;
  let capture = null;
  if (payload.capture && typeof payload.capture === 'object') {
    capture = Object.assign({}, payload.capture, { sku });
    // 兼容：capture-client 已带 samples/spread/consistent/price；旧版只有 prices/priceKind
    if (capture.sampleCount == null) capture.sampleCount = Array.isArray(capture.samples) ? capture.samples.length : (capture.price != null ? 1 : 0);
    if (payload.samples && !Array.isArray(capture.samples)) capture.samples = payload.samples;
    if (payload.spread != null && capture.spread == null) capture.spread = payload.spread;
    if (payload.consistent != null && capture.consistent == null) capture.consistent = payload.consistent;
    if (payload.price != null && capture.price == null) capture.price = payload.price;
  } else if (payload.result && typeof payload.result === 'object') {
    capture = resultToCapture(sku, payload.result);
    if (Array.isArray(payload.samples)) capture.samples = payload.samples;
    if (payload.spread != null) capture.spread = payload.spread;
    if (payload.consistent != null) capture.consistent = payload.consistent;
    if (payload.price != null) capture.price = payload.price;
    if (payload.sampleCount != null) capture.sampleCount = payload.sampleCount;
  }
  if (!capture) return;
  // v2.1.7：把 lib 采集结果里的价格类型/候选/刷新记录补齐（capture-client 可能直接给 capture；缺的从 result/payload 兜底拷贝，不做任何选价）
  const priceMeta = payload.priceMeta || payload.pricePick || {};
  const resultObj = payload.result && typeof payload.result === 'object' ? payload.result : {};
  if (!capture.priceKind && priceMeta.kind) capture.priceKind = priceMeta.kind;
  if (!capture.priceKindLabel) capture.priceKindLabel = payload.priceKindLabel || resultObj.priceKindLabel || PRICE_KIND_LABELS[capture.priceKind] || '';
  if (!Array.isArray(capture.priceChanges)) capture.priceChanges = Array.isArray(payload.priceChanges) ? payload.priceChanges : (Array.isArray(resultObj.priceChanges) ? resultObj.priceChanges : []);
  if (!capture.priceRect) capture.priceRect = payload.priceRect || resultObj.priceRect || null;
  if (!capture.sourceLabel) capture.sourceLabel = payload.sourceLabel || resultObj.sourceLabel || '';
  if (!capture.priceClass) capture.priceClass = payload.priceClass || resultObj.priceClass || (capture.priceRect && (capture.priceRect.cls || capture.priceRect.className)) || '';
  if ((!Array.isArray(capture.candidates) || !capture.candidates.length) && Array.isArray(resultObj.candidates)) capture.candidates = resultObj.candidates.slice(0, 20);
  // 复核只算一次：capture-client 不负责（DESIGN 16.4 由工作台计算）
  if (!capture.review) {
    const review = evaluateReviewForCapture(payload);
    if (review) capture.review = review;
  }
  state.captures[sku] = capture;
  // v2.1.7：价格刷新日志（lib 记录的 priceChanges，原样展示） + 最近一次采集调试快照
  if (Array.isArray(capture.priceChanges) && capture.priceChanges.length) {
    const refreshKey = sku + '|' + JSON.stringify(capture.priceChanges);
    state.capture.priceRefreshLog = state.capture.priceRefreshLog || {};
    if (!state.capture.priceRefreshLog[refreshKey]) {
      state.capture.priceRefreshLog[refreshKey] = true;
      const text = capture.priceChanges.map((item) => {
        if (!item) return '';
        if (item.from != null && item.to != null) return item.from + '→' + item.to;
        return String(item.text || '');
      }).filter(Boolean).join('，');
      if (text) logLine('↻ 页面价格刷新：' + text + '（已采用最新读数）');
    }
  }
  const found = findRowContextBySku(sku);
  if (found && found.row) {
    const row = found.row;
    if (capture.priceKind && !row.priceKind) row.priceKind = capture.priceKind;
    if (capture.priceKindLabel && !row.priceKindLabel) row.priceKindLabel = capture.priceKindLabel;
    if (Array.isArray(capture.priceChanges) && capture.priceChanges.length) row.priceChanges = capture.priceChanges;
    if (capture.priceRect && !row.priceRect) row.priceRect = capture.priceRect;
    if (capture.sourceLabel && !row.sourceLabel) row.sourceLabel = capture.sourceLabel;
  }
  state.capture.lastDebug = buildPriceDebugPayload(found ? found.row : null, sku);
  if (state.activePage === 'settings') renderDebug();
  if (capture.review && capture.review.needed) {
    const reasons = (capture.review.reasons || []).map((r) => (r && (r.text || r.code)) || '').filter(Boolean).join('；');
    logLine('⚠ ' + sku + ' 标记需确认' + (reasons ? '：' + reasons : ''));
  }
  // 每 5 条落盘 + 回填一次，避免 700 条采集时频繁写 storage / 重渲染
  state.capture.resultCount = (state.capture.resultCount || 0) + 1;
  if (state.capture.resultCount % 5 === 0) {
    markDirty('captures');
    applyCaptureResults().then(() => {
      if (state.capture.running) {
        renderKpis();
        renderMatchTable();
      }
    }).catch(() => { /* 忽略中途回填失败，结束时会再统一回填 */ });
  }
}

async function applyCaptureResults() {
  if (!lib.pipeline || typeof lib.pipeline.applyCaptures !== 'function') return 0;
  let updated = 0;
  for (const report of state.session.reports || []) {
    try {
      // v2.1：第 4 参传 library，用于「同店铺 + 同尺寸段」参考区间复核
      const res = lib.pipeline.applyCaptures(report, state.captures, state.settings, state.library);
      if (res) {
        if (Array.isArray(res.rows) && res.rows.length === reportRows(report).length) {
          applyAnalyzed(report, { rows: res.rows, summary: res.summary || report.summary });
        }
        if (Number.isFinite(Number(res.updated))) updated += Number(res.updated);
      }
    } catch (e) {
      logLine('回填采集结果失败：' + humanError(e));
    }
  }
  markOffSaleRows();
  return updated;
}

/** 打开工作台时用已有采集缓存自动回填（断点续采 / 跨月复用） */
function applyCachedCapturesAtStartup() {
  if (!lib.pipeline || typeof lib.pipeline.applyCaptures !== 'function') return;
  if (!state.captures || !Object.keys(state.captures).length) return;
  if (!(state.session.reports || []).length) return;
  let updated = 0;
  for (const report of state.session.reports) {
    try {
      const res = lib.pipeline.applyCaptures(report, state.captures, state.settings, state.library);
      if (res && Array.isArray(res.rows) && res.rows.length === reportRows(report).length) {
        applyAnalyzed(report, { rows: res.rows, summary: res.summary || report.summary });
        if (Number.isFinite(Number(res.updated))) updated += Number(res.updated);
      }
    } catch (e) {
      logLine('应用历史采集缓存失败：' + humanError(e));
    }
  }
  if (updated) {
    logLine('已用采集缓存自动回填 ' + updated + ' 行');
    markDirty('session');
  }
  markOffSaleRows();
}

/** decideMore：多采样复核决策（交给 lib.rules.shouldResample；lib 未就绪时降级单采） */
function buildDecideMore() {
  return function decideMore(ctx) {
    try {
      if (!lib.rules || typeof lib.rules.shouldResample !== 'function') return { more: false };
      const settings = state.settings;
      const task = (ctx && ctx.task) || {};
      const samples = Array.isArray(ctx && ctx.samples) ? ctx.samples : [];
      const result = ctx && ctx.result;
      const price = ctx && ctx.price;
      let priceBand = null;
      if (lib.rules.priceBandInfo && price != null) {
        try {
          const info = lib.rules.priceBandInfo(price, settings.price.bandBoundary, { marginPct: settings.price.boundaryMarginPct });
          priceBand = info && info.band ? info.band : null;
        } catch (e) { /* 忽略 */ }
      }
      const candidateCount = ctx && ctx.candidateCount != null
        ? Number(ctx.candidateCount)
        : result && Array.isArray(result.candidates) ? result.candidates.length : undefined;
      const priceKind = (ctx && ctx.pricePick && ctx.pricePick.kind) || (result && result.pricePick && result.pricePick.kind) || '';
      const res = lib.rules.shouldResample({
        price,
        priceBand,
        referenceRange: task.referenceRange || null,
        candidateCount,
        priceKind,
        samples,
        settings,
      });
      const reasons = res && Array.isArray(res.reasons) ? res.reasons.map((r) => (r && (r.text || r.code)) || '').filter(Boolean) : [];
      const more = !!(res && res.more);
      if (more) {
        logLine('第 ' + ((Number(ctx && ctx.sampleIndex) || samples.length) + 1) + ' 次复核：' + (reasons.join('；') || '命中多采样复核规则'));
      } else if (reasons.length) {
        logLine('复核完成：' + reasons.join('；'));
      }
      return { more, reason: reasons.join('；') };
    } catch (e) {
      logLine('复核判定失败（按单次采样继续）：' + humanError(e));
      return { more: false };
    }
  };
}

async function startCapture(opts) {
  opts = opts || {};
  if (state.capture.running) {
    toast('补采已在进行中，请先暂停或停止', 'error');
    return;
  }
  // v2.1.4：风控冷却期内禁止开始补采
  const riskNow = getRiskState();
  if (riskNow.active) {
    const mm = String(Math.floor(riskNow.remainingSec / 60)).padStart(2, '0');
    const ss = String(riskNow.remainingSec % 60).padStart(2, '0');
    toast('风控冷却中（剩余 ' + mm + ':' + ss + '），请换账号/网络或改用小眼睛预览人工读数', 'error');
    renderRiskAlert();
    return;
  }
  if (!HAS_EXTENSION) {
    toast('补采需在 Edge 插件内使用：请从工具栏扩展图标打开工作台后再试。', 'error');
    return;
  }
  if (!lib.captureClient || typeof lib.captureClient.CaptureRunner !== 'function') {
    toast('采集模块未就绪：缺少 lib/capture-client.js，暂时无法补采（lib 就绪后刷新页面）。', 'error');
    return;
  }
  if (!lib.pipeline || typeof lib.pipeline.applyCaptures !== 'function') {
    toast('补数流水线未就绪（lib/pipeline.js），采集结果无法回填，请刷新页面后再试。', 'error');
    return;
  }

  let tasks;
  if (opts.skus && opts.skus.length) {
    const seen = new Set();
    tasks = [];
    for (const rawSku of opts.skus) {
      const sku = String(rawSku || '').trim();
      if (!sku || seen.has(sku)) continue;
      seen.add(sku);
      const ctx = findRowContextBySku(sku);
      tasks.push(buildCaptureTask(sku, ctx && ctx.row, ctx && ctx.report));
    }
  } else {
    tasks = collectCaptureTasks();
  }

  const capSettings = state.settings.capture || {};
  const batchSize = Math.max(0, Math.floor(Number(capSettings.batchSize) || 0));
  if (batchSize > 0 && tasks.length > batchSize) tasks = tasks.slice(0, batchSize);
  if (!tasks.length) {
    toast('没有需要补采的 SKU（价格段/尺寸段已补齐，或今天已采过）', 'ok');
    return;
  }

  const mode = capSettings.mode === 'double' || capSettings.mode === 'single' ? capSettings.mode : 'smart';
  const maxSamples = Math.max(2, Math.min(5, Math.floor(Number(capSettings.maxSamples) || 3)));
  const delayMin = Math.max(1, Number(capSettings.delayMin) || 3);
  const delayMax = Math.max(delayMin, Number(capSettings.delayMax) || 6);
  const samplesPerSku = mode === 'single' ? 1 : mode === 'double' ? 2 : Math.min(maxSamples, 2);
  const estMin = Math.max(1, Math.round((tasks.length * ((delayMin + delayMax) / 2 + 7 + (samplesPerSku - 1) * 2)) / 60));
  const modeText = CAPTURE_MODE_LABELS[mode] + (mode === 'single' ? '' : '（最多 ' + maxSamples + ' 次/个）');
  const needSummary = (() => {
    let pkg = 0;
    let mdl = 0;
    let price = 0;
    for (const task of tasks) {
      if (!task.need) continue;
      if (task.need.package) pkg++;
      if (task.need.model) mdl++;
      if (task.need.price) price++;
    }
    return { pkg, mdl, price };
  })();
  const needText = (needSummary.price ? '待补价格 ' + needSummary.price + ' 个 · ' : '') +
    (needSummary.pkg ? '待补套餐 ' + needSummary.pkg + ' 个 · ' : '') +
    (needSummary.mdl ? '待补型号 ' + needSummary.mdl + ' 个' : '');
  // v2.1.5：每批上限读取当前设置 settings.capture.maxBatch（5~100，默认 20），下一次采集立即生效
  const batchPlan = planCaptureBatch(tasks, capSettings);
  const maxBatch = batchPlan.maxBatch;
  tasks = batchPlan.tasks;
  if (batchPlan.truncated) {
    logLine('本次待补 ' + batchPlan.total + ' 个 SKU，按「每批上限 ' + maxBatch + '」先采 ' + batchPlan.queued + ' 个，剩余 ' + batchPlan.truncated + ' 个可稍后再采');
  }
  logLine('本批 ' + tasks.length + ' 条（上限 ' + maxBatch + '）');
  state.capture.batchInfo = { queued: tasks.length, maxBatch, at: nowIso() };
  const cooldownMinutes = Math.max(1, Math.min(1440, Math.floor(Number(capSettings.cooldownMinutes) || 60)));
  const ok = await confirmDialog('开始补采价格 / 尺寸 / 套餐',
    '本次补采 ' + tasks.length + ' 个 SKU（去重后），复核模式：' + modeText + '，预计约 ' + estMin + ' 分钟。\n\n' +
    (needText ? '任务构成：' + needText.replace(/ · $/, '') + '。\n\n' : '') +
    '采集方式：后台标签页按 ' + delayMin + '–' + delayMax + ' 秒随机间隔打开 item.shop.example.com 商品页，只读页面信息、不抢焦点；每批上限 ' + maxBatch + ' 个；' +
    (mode === 'single' ? '单次采样不核对一致性；' : '命中疑点会再采 1~' + (maxSamples - 1) + ' 次核对一致性，拿不准的行标「需确认」；') +
    '检测到电商平台风控（跳商城首页/安全验证）会自动暂停并冷却 ' + cooldownMinutes + ' 分钟。\n\n' +
    '请确认当前 Edge 已登录电商平台账号。确定开始？');
  if (!ok) return;

  // DESIGN 17.1/17.3：开始补采前关闭预览窗口，避免与采集标签页抢焦点
  closePreviewQuietly('开始补采');

  state.capture.running = true;
  state.capture.pausedFlag = false;
  state.capture.summary = null;
  state.capture.progress = null;
  state.capture.resultCount = 0;
  state.capture.anomalyCount = 0;
  state.capture.everRun = true;
  state.capture.riskAlertDismissed = false;
  state.capture.log = [];  if (els.logPanel) els.logPanel.textContent = '';
  if (els.progressPanel) els.progressPanel.classList.remove('hidden');
  if (els.runStats) els.runStats.innerHTML = '';
  setProgress(0, 0, '准备启动采集…');
  renderCaptureUI();
  logLine('开始补采：' + tasks.length + ' 个 SKU（本批 ' + tasks.length + ' 条，上限 ' + maxBatch + '），' + CAPTURE_MODE_LABELS[mode] + '（最多 ' + maxSamples + ' 次/个），间隔 ' + delayMin + '–' + delayMax + ' 秒，风控冷却 ' + cooldownMinutes + ' 分钟');

  let summary = null;
  try {
    state.capture.runner = new lib.captureClient.CaptureRunner({
      chromeApi: window.chrome,
      settings: state.settings,
      onProgress: (p) => onCaptureProgress(p),
      onResult: (p) => onCaptureResult(p),
      onLog: (line) => logLine(line),
    });
    summary = await state.capture.runner.start(tasks, { decideMore: buildDecideMore() });
  } catch (e) {
    logLine('补采异常终止：' + ((e && e.message) || e));
    toast('补采异常终止：' + humanError(e), 'error');
  } finally {
    state.capture.running = false;
    state.capture.runner = null;
    if (summary) {
      state.capture.summary = summary;
      const summaryRisk = riskFromCapturePayload(summary);
      if (summaryRisk) handleCaptureRisk(summaryRisk);
      else if (summary.autoPauseReason && riskKeywords(summary.autoPauseReason)) {
        handleCaptureRisk({ hit: true, reason: String(summary.autoPauseReason) });
      }
      clearAnomalyWait();
      const done = Number(summary.done) || 0;
      const total = Number(summary.total) || tasks.length;
      setProgress(done, total, '采集结束' + (summary.stopped ? '（已停止）' : '') + (summary.autoPaused ? '（自动暂停）' : ''), {
        offSale: summary.offSaleCount,
        progressDenom: summary.progressDenom,
        progressPct: summary.progressPct,
      });
      const extra = [];
      if (summary.resampled != null) extra.push('复核 ' + summary.resampled + ' 个');
      if (summary.inconsistent != null && summary.inconsistent > 0) extra.push('样本不一致 ' + summary.inconsistent + ' 个');
      if (summary.sampleCount != null) extra.push('采样 ' + summary.sampleCount + ' 次');
      logLine('补采结束：成功 ' + (Number(summary.ok) || 0) + '，失败 ' + (Number(summary.fail) || 0) + (extra.length ? '，' + extra.join('，') : '') + (summary.stopped ? '（已停止）' : ''));
    }
    const updated = await applyCaptureResults();
    if (updated) logLine('已把采集结果回填配对表：' + updated + ' 行');
    const review = getReviewSummary();
    if (review.reviewNeeded) {
      logLine('本次产生 ' + review.reviewNeeded + ' 行「需确认」，可在配对表确认或点「确认当前筛选(N)」批量确认');
    }
    state.session.updatedAt = nowIso();
    markDirty('captures');
    markDirty('session');
    state.statsStale = true;
    renderAll();
    if (summary) {
      toast('补采结束：成功 ' + (Number(summary.ok) || 0) + '，失败 ' + (Number(summary.fail) || 0) +
        (review.reviewNeeded ? '，待确认 ' + review.reviewNeeded + ' 行' : ''), Number(summary.fail) ? 'error' : 'ok');
    }
  }
}

function toggleCapturePause() {
  const runner = state.capture.runner;
  if (!runner || !state.capture.running) return;
  const paused = !!(state.capture.pausedFlag || runner.paused);
  try {
    if (paused) {
      runner.resume();
      state.capture.pausedFlag = false;
      logLine('继续采集');
    } else {
      runner.pause();
      state.capture.pausedFlag = true;
      logLine('已暂停采集');
    }
  } catch (e) {
    logLine('暂停/继续失败：' + humanError(e));
  }
  renderCaptureUI();
}

function stopCapture() {
  const runner = state.capture.runner;
  if (!runner) return;
  try {
    runner.stop();
    logLine('已请求停止采集，当前步骤结束后停止…');
  } catch (e) {
    logLine('停止失败：' + humanError(e));
  }
}

function recaptureRows(rows) {
  const skus = (rows || []).map((r) => r && r.sku).filter(Boolean);
  if (!skus.length) {
    toast('该行没有 SKU，无法补采（可先在匹配库/榜单里补 SKU）', 'error');
    return;
  }
  startCapture({ skus }).catch((e) => {
    logLine('单条重采失败：' + humanError(e));
    toast('重采失败：' + humanError(e), 'error');
  });
}

/* ============================ 商品页预览（小眼睛） ============================ */
/* DESIGN.md §17：悬停 SKU 旁的小眼睛 → chrome.windows popup 小窗渲染商品页；
 * 悬停 600ms 开窗（不抢焦点）、移开 500ms 自动关、点击固定/再点关闭。
 * 同一时刻只存在 1 个预览窗口；窗口是独立 popup，不占用工作台标签页。 */

const PREVIEW_OPEN_DELAY = 600;
const PREVIEW_CLOSE_DELAY = 500;
const previewState = {
  winId: null,
  tabId: null,
  sku: '',
  url: '',
  pinned: false,
  openTimer: null,
  closeTimer: null,
  readSuppressUntil: 0,
};
let previewWindowListenerBound = false;

/** 是否具备预览能力（扩展页且有 chrome.windows；file:// 预览模式没有） */
function canPreview() {
  return !!(HAS_CHROME && chrome.windows && typeof chrome.windows.create === 'function');
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

/** DESIGN 17.4：{winId, sku, url, pinned} | null */
function getPreviewState() {
  if (previewState.winId == null) return null;
  return {
    winId: previewState.winId,
    sku: previewState.sku,
    url: previewState.url,
    pinned: previewState.pinned,
  };
}

/** 预览按钮固定在行内渲染（无 SKU / 无 chrome.windows 时不渲染） */
function eyeBtnHtml(sku) {
  const clean = String(sku == null ? '' : sku).trim();
  if (!clean || !canPreview()) return '';
  const isOpen = previewState.winId != null && previewState.sku === clean;
  const pinned = isOpen && previewState.pinned;
  return '<button class="eye-btn' + (isOpen ? ' active' : '') + (pinned ? ' pinned' : '') + '" type="button"' +
    ' data-act="preview" data-sku="' + esc(clean) + '"' +
    ' title="悬停预览商品页；点击固定/取消固定" aria-label="预览商品页 ' + esc(clean) + '"' +
    ' aria-pressed="' + (pinned ? 'true' : 'false') + '">' +
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"' +
    ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M1.9 12S5.5 5.3 12 5.3 22.1 12 22.1 12 18.5 18.7 12 18.7 1.9 12 1.9 12Z"></path>' +
    '<circle cx="12" cy="12" r="3.1"></circle></svg></button>';
}

/** 刷新所有眼睛按钮的 active/pinned 态（行重渲染后也要调；工作台 + 总览两处表格） */
function updatePreviewButtons() {
  const containers = [els.matchBodyRows, els.overviewBody].filter(Boolean);
  for (const container of containers) {
    let list = [];
    try { list = Array.from(container.querySelectorAll('.eye-btn[data-act="preview"]')); } catch (e) { list = []; }
    for (const btn of list) {
      const sku = String(btn.getAttribute('data-sku') || '');
      const isOpen = previewState.winId != null && sku === previewState.sku;
      const pinned = isOpen && previewState.pinned;
      btn.classList.toggle('active', isOpen);
      btn.classList.toggle('pinned', pinned);
      btn.setAttribute('aria-pressed', pinned ? 'true' : 'false');
    }
  }
}

/** DESIGN 17.2：窗口尺寸/位置（优先工作台右侧 → 左侧 → 居中，clamp 屏幕） */
function computePreviewBounds() {
  const screenObj = (typeof window !== 'undefined' && window.screen) || {};
  const screenW = Number(screenObj.availWidth) || Number(screenObj.width) || 0;
  const screenH = Number(screenObj.availHeight) || Number(screenObj.height) || 0;
  const width = screenW > 0 ? Math.max(480, Math.min(1100, screenW - 80)) : 1100;
  const height = screenH > 0 ? Math.max(360, Math.min(820, screenH - 100)) : 820;
  const winX = Number(window.screenX) || 0;
  const winY = Number(window.screenY) || 0;
  const winW = Number(window.outerWidth) || 0;
  const winH = Number(window.outerHeight) || 0;
  if (!(winW > 0)) return { width, height, hasPos: false, left: 0, top: 0 };

  let left = null;
  if (screenW > 0) {
    // 1) 工作台右侧（不遮挡表格）
    const rightSide = winX + winW + 12;
    if (rightSide + width <= screenW - 4) left = rightSide;
    // 2) 左侧
    if (left == null) {
      const leftSide = winX - width - 12;
      if (leftSide >= 4) left = leftSide;
    }
    // 3) 居中（覆盖工作台）
    if (left == null) left = winX + Math.max(0, (winW - width) / 2);
    left = Math.max(0, Math.min(Math.round(left), Math.max(0, screenW - width)));
  } else {
    left = Math.round(winX + Math.max(40, (winW - width) / 2));
  }
  let top = winY + 60;
  if (!(winH > 0)) top = winY + 60;
  if (screenH > 0) top = Math.max(0, Math.min(Math.round(top), Math.max(0, screenH - height)));
  return { width, height, hasPos: true, left: Math.round(left), top: Math.round(top) };
}

/** 手动关窗（用户点窗口 ×）时复位状态 */
function ensurePreviewWindowListener() {
  if (previewWindowListenerBound) return;
  if (!canPreview() || !chrome.windows.onRemoved || typeof chrome.windows.onRemoved.addListener !== 'function') return;
  try {
    chrome.windows.onRemoved.addListener((winId) => {
      if (previewState.winId !== winId) return;
      previewState.winId = null;
      previewState.tabId = null;
      previewState.sku = '';
      previewState.url = '';
      previewState.pinned = false;
      clearPreviewTimers();
      updatePreviewButtons();
      logLine('预览窗口已被手动关闭');
    });
    previewWindowListenerBound = true;
  } catch (e) {
    logLine('监听预览窗口关闭失败：' + humanError(e));
  }
}

/**
 * 打开预览窗口（DESIGN 17.1/17.2/17.3）。
 * 同一 SKU 复用；其它 SKU 先关旧再开新；位置非法时退化为不传 left/top。
 * @returns {Promise<{winId,sku,url,pinned}|null>}
 */
async function previewSku(sku, opts) {
  opts = opts || {};
  const pinned = !!opts.pinned;
  const cleanSku = String(sku == null ? '' : sku).trim();
  if (!cleanSku) return null;
  if (!canPreview()) {
    toast('预览需要在 Edge 插件内使用（当前是本地预览模式，可直接点「打开」查看商品页）', 'error');
    return null;
  }
  clearPreviewTimers();
  const url = ITEM_URL(cleanSku);

  // 已开同一 SKU：只更新固定态/焦点
  if (previewState.winId != null && previewState.sku === cleanSku) {
    if (pinned && !previewState.pinned) {
      previewState.pinned = true;
      try { await chrome.windows.update(previewState.winId, { focused: true }); } catch (e) { /* 忽略 */ }
      updatePreviewButtons();
      logLine('预览窗口已固定：' + cleanSku);
    }
    return getPreviewState();
  }
  if (previewState.winId != null) await closePreview({ silent: true });

  const bounds = computePreviewBounds();
  const base = { url, type: 'popup', width: bounds.width, height: bounds.height, focused: !!pinned };
  let win = null;
  try {
    try {
      win = await chrome.windows.create(bounds.hasPos
        ? Object.assign({}, base, { left: bounds.left, top: bounds.top })
        : base);
    } catch (e) {
      // 多屏 / 缩放 / 无头环境边界非法 → 不传位置再试一次
      win = await chrome.windows.create(base);
    }
    if (!win || win.id == null) throw new Error('窗口创建失败');
    previewState.winId = win.id;
    previewState.tabId = Number(win.tabs && win.tabs[0] && win.tabs[0].id) || null;
    previewState.sku = cleanSku;
    previewState.url = url;
    previewState.pinned = !!pinned;
    previewState.readSuppressUntil = 0;
    ensurePreviewWindowListener();
    updatePreviewButtons();
    logLine('预览窗口已打开：' + cleanSku + (pinned ? '（固定）' : '（悬停）'));
    // v2.1.4：页面加载完成后自动请求一次人工读数快照（DESIGN 19.3）
    try { schedulePreviewRead(cleanSku); } catch (e) { logLine('预览读数调度失败：' + humanError(e)); }
    return getPreviewState();
  } catch (e) {
    previewState.winId = null;
    previewState.sku = '';
    previewState.url = '';
    previewState.pinned = false;
    updatePreviewButtons();
    logLine('预览窗口打开失败：' + humanError(e));
    toast('预览窗口打开失败：' + humanError(e) + '（可直接点「打开」查看商品页）', 'error');
    return null;
  }
}

/** 关闭预览窗口（DESIGN 17.4：Promise<{closed}>） */
async function closePreview(opts) {
  opts = opts || {};
  clearPreviewTimers();
  const winId = previewState.winId;
  previewState.winId = null;
  previewState.tabId = null;
  previewState.sku = '';
  previewState.url = '';
  previewState.pinned = false;
  updatePreviewButtons();
  if (winId == null) return { closed: false };
  try {
    await chrome.windows.remove(winId);
  } catch (e) {
    // 窗口可能已被用户手动关闭，忽略
  }
  if (!opts.silent) logLine('预览窗口已关闭');
  return { closed: true };
}

/** 离开工作台 / 开始补采 / 页面关闭时的静默清理（不 await） */
function closePreviewQuietly(reason) {
  if (previewState.winId == null) {
    clearPreviewTimers();
    return;
  }
  closePreview({ silent: true }).catch(() => { /* ignore */ });
  if (reason) logLine('已关闭商品页预览（' + reason + '）');
}

/* ---------------- 悬停 / 点击交互 ---------------- */

function onPreviewHoverStart(sku) {
  if (!canPreview()) return;
  clearPreviewTimers();
  if (previewState.winId != null && previewState.sku === String(sku)) return; // 该 SKU 已开，无需重开
  previewState.openTimer = setTimeout(() => {
    previewState.openTimer = null;
    previewSku(sku, { pinned: false }).catch((e) => logLine('预览打开异常：' + humanError(e)));
  }, PREVIEW_OPEN_DELAY);
}

function onPreviewHoverEnd(sku) {
  if (previewState.openTimer) {
    clearTimeout(previewState.openTimer);
    previewState.openTimer = null;
  }
  if (!canPreview() || previewState.winId == null) return;
  if (previewState.pinned) return; // 固定窗口鼠标移开不关
  if (previewState.sku !== String(sku)) return; // 已切到别的行，由新行逻辑处理
  if (previewState.closeTimer) clearTimeout(previewState.closeTimer);
  previewState.closeTimer = setTimeout(() => {
    previewState.closeTimer = null;
    if (previewState.pinned) return;
    closePreview({ silent: true }).catch(() => { /* ignore */ });
  }, PREVIEW_CLOSE_DELAY);
}

async function onPreviewClick(sku) {
  clearPreviewTimers();
  if (!canPreview()) {
    toast('预览需要在 Edge 插件内使用（当前是本地预览模式，可直接点「打开」查看商品页）', 'error');
    return;
  }
  const cleanSku = String(sku == null ? '' : sku).trim();
  if (!cleanSku) return;
  if (previewState.winId != null && previewState.sku === cleanSku) {
    if (previewState.pinned) {
      await closePreview();
      toast('已关闭固定的预览窗口', 'ok');
    } else {
      previewState.pinned = true;
      try { await chrome.windows.update(previewState.winId, { focused: true }); } catch (e) { /* ignore */ }
      updatePreviewButtons();
      toast('已固定预览窗口，再点眼睛或关闭窗口即可', 'ok');
    }
    return;
  }
  await previewSku(cleanSku, { pinned: true });
}

/** 行重渲染后给每只眼睛绑定事件（每页最多数百行，成本可忽略；container 缺省为工作台配对表） */
function bindPreviewButtons(container) {
  const box = container || els.matchBodyRows;
  if (!box) return;
  let list = [];
  try { list = Array.from(box.querySelectorAll('.eye-btn[data-act="preview"]')); } catch (e) { list = []; }
  for (const btn of list) {
    const sku = String(btn.getAttribute('data-sku') || '');
    if (!sku) continue;
    if (btn.__previewBound) continue; // 同一按钮只绑定一次（行重渲染/测试环境重复调用幂等）
    btn.__previewBound = true;
    btn.addEventListener('mouseenter', () => onPreviewHoverStart(sku));
    btn.addEventListener('mouseleave', () => onPreviewHoverEnd(sku));
    btn.addEventListener('click', (e) => {
      if (e && e.preventDefault) e.preventDefault();
      if (e && e.stopPropagation) e.stopPropagation();
      onPreviewClick(sku).catch((err) => logLine('预览点击异常：' + humanError(err)));
    });
  }
  updatePreviewButtons();
}

/* ============================ 配对总览页（跨榜单） ============================ */
/* DESIGN.md §18.2：全部榜单的全部配对行，可筛店铺/状态/搜索、可排序、可改 5 个关键字段并写回匹配库。 */

function overviewStoreList() {
  const map = new Map();
  for (const report of state.session.reports || []) {
    const name = report.store || '未绑定类目';
    map.set(name, (map.get(name) || 0) + reportRows(report).length);
  }
  return Array.from(map.entries())
    .map(([name, rows]) => ({ name, rows }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
}

function overviewAllRows() {
  const out = [];
  for (const report of state.session.reports || []) {
    const rows = reportRows(report);
    const label = reportShortName(report);
    for (let i = 0; i < rows.length; i++) out.push({ row: rows[i], report, index: i, label });
  }
  return out;
}

function filteredOverviewRows() {
  refreshLibraryStates();
  const f = state.overview || {};
  const q = String(f.search || '').trim().toLowerCase();
  const out = [];
  for (const item of overviewAllRows()) {
    const { row, report } = item;
    const storeName = report.store || '未绑定类目';
    if (f.store && storeName !== f.store) continue;
    if (!rowMatchesStatusFilter(row, f.status, report)) continue;
    if (!rowMatchesColumnFilters(row, report, 'overview')) continue;
    if (q) {
      const hay = (
        String(row.sku || '') + ' ' +
        String(row.name || '') + ' ' +
        String(row.brand || '') + ' ' +
        storeNameOf(report, row) + ' ' +
        String(row.model || '')
      ).toLowerCase();
      if (hay.indexOf(q) < 0) continue;
    }
    out.push(item);
  }
  const field = f.sortField;
  if (field) {
    const dir = f.sortDir === 'desc' ? -1 : 1;
    out.sort((a, b) => {
      const va = overviewSortValue(a, field);
      const vb = overviewSortValue(b, field);
      if (typeof va === 'number' && typeof vb === 'number') {
        if (va === vb) return 0;
        return (va < vb ? -1 : 1) * dir;
      }
      const sa = String(va);
      const sb = String(vb);
      if (sa === sb) return 0;
      return (sa < sb ? -1 : 1) * dir;
    });
  }
  return out;
}

function overviewSortValue(item, field) {
  const row = item.row;
  if (field === 'rowNo') return Number(row.rowNo) || 0;
  if (field === 'amount') return row.amount == null ? -Infinity : Number(row.amount);
  if (field === 'price') return row.capturePrice == null ? -Infinity : Number(row.capturePrice);
  if (field === 'size') return String(row.size || '');
  if (field === 'priceBand') return String(row.price || '');
  return '';
}

function overviewCellHtml(item, field, value) {
  const label = EDITABLE_FIELD_LABELS[field] || field;
  const source = sourceText(item.row, field);
  const manual = source === '手动';
  let cls = 'band-cell' + (value ? '' : ' empty') + (manual ? ' manual' : '');
  let text = value || '点击填写';
  let tip = label + '：点击修改（保存后写回匹配库）';
  if (field === 'brand' && !value) text = '未标注品牌';
  if (field === 'size' && !value) {
    const reason = sizeReviewReason(item.row);
    if (reason) {
      cls += ' manual-pending';
      text = '待人工';
      tip = '待人工复核：' + reason + '（点击填写规范尺寸段）';
    } else {
      cls += ' missing';
      text = '缺';
      tip = '缺尺寸段：点击填写（保存后写回匹配库）';
    }
  }
  return '<span class="' + cls + '" data-act="ov-edit-cell" data-field="' + field + '"' +
    ' data-sku="' + esc(String(item.row.sku || '')) + '" data-report-id="' + esc(item.report.id) + '"' +
    ' data-index="' + item.index + '" title="' + esc(tip) + '">' + esc(text) + '</span>';
}

function overviewRowHtml(item) {
  const { row, report, index, label } = item;
  const sku = String(row.sku || '');
  const st = rowStatusInfo(row);
  let rowCls = '';
  if (st.key === 'fail') rowCls = 'row-fail';
  else if (st.key === 'review' || st.key === 'sizeReview') rowCls = 'row-review';
  else if (st.key === 'todo' || st.key === 'needSize' || st.key === 'missingSize' || st.key === 'missingPrice') rowCls = 'row-pending';
  const libState = rowLibState(row, report);
  const libCls = libStateRowClass(row, report);
  if (libCls) rowCls = (rowCls ? rowCls + ' ' : '') + libCls;
  const shop = storeNameOf(report, row);
  const amountHtml = row.amount != null && Number.isFinite(Number(row.amount))
    ? fmtNum(row.amount, 2) + '<span class="unit">万</span>'
    : '<span class="muted">—</span>';
  const sample = rowSampleText(row);
  const sampleHtml = '<div class="cell-sample"><b>' + esc(sample.main) + '</b>' + (sample.sub ? ' ' + esc(sample.sub) : '') + '</div>';
  const srcHtml = '<div class="cell-source one-line" title="尺寸段来源：' + esc(sourceText(row, 'size') || '—') + ' · 价格段来源：' + esc(sourceText(row, 'price') || '—') + '">' +
    '<i>尺 <b>' + esc(sourceText(row, 'size') || '—') + '</b></i>' +
    '<i>价 <b>' + esc(sourceText(row, 'price') || '—') + '</b></i>' +
  '</div>';
  const ops = (sku ? '<a class="op-btn" href="' + esc(ITEM_URL(sku)) + '" target="_blank" rel="noreferrer">打开</a>' : '') +
    (sku ? '<button class="op-btn" type="button" data-act="ov-debug-price" data-report-id="' + esc(report.id) + '" data-index="' + index + '" title="查看候选价格调试 JSON">调试</button>' : '') +
    (reviewNeeded(row) ? '<button class="op-btn review" type="button" data-act="ov-confirm" data-report-id="' + esc(report.id) + '" data-index="' + index + '">确认</button>' : '') +
    (libState === 'pending' ? '<button class="op-btn write" type="button" data-act="ov-confirm-write" data-report-id="' + esc(report.id) + '" data-index="' + index + '">确认写入</button>' : '') +
    (rowConfirmedInLibrary(row, report) ? '<button class="op-btn done" type="button" disabled title="已确认写入匹配库">已确认</button>' : '');
  return '<tr class="' + rowCls + '" data-sku="' + esc(sku) + '" data-report-id="' + esc(report.id) + '" data-index="' + index + '">' +
    '<td class="col-report-row"><span class="row-ref" title="' + esc(report.fileName || '') + '"><b>' + esc(label) + '</b><span>#' + esc(String(row.rowNo != null ? row.rowNo : index + 1)) + '</span></span></td>' +
    '<td class="cell-sku"><div class="sku-cell">' + (sku ? '<a href="' + esc(ITEM_URL(sku)) + '" target="_blank" rel="noreferrer" title="打开电商平台商品页">' + esc(sku) + '</a>' : '<span class="muted">—</span>') + eyeBtnHtml(sku) + '</div></td>' +
    '<td><span class="cell-name" title="' + esc(row.name || '') + '">' + esc(row.name || '—') + '</span></td>' +
    '<td class="col-shop"><span class="cell-shop" title="' + esc(shop) + '">' + esc(shop || '—') + '</span></td>' +
    '<td class="col-brand">' + overviewCellHtml(item, 'brand', row.brand) + '</td>' +
    '<td class="col-model">' + overviewCellHtml(item, 'model', row.model) + '</td>' +
    '<td class="col-package">' + overviewCellHtml(item, 'package', row.package) + '</td>' +
    '<td class="col-band">' + overviewCellHtml(item, 'size', row.size) + '</td>' +
    '<td class="col-band wide">' + overviewCellHtml(item, 'price', row.price) + '</td>' +
    '<td class="col-price-now">' + currentPriceCellHtml(row) + '</td>' +
    '<td class="cell-amount">' + amountHtml + '</td>' +
    '<td class="col-sample">' + sampleHtml + '</td>' +
    '<td class="col-source">' + srcHtml + '</td>' +
    '<td><span class="status-badge ' + st.cls + '"' + (rowStatusTitle(row) ? ' title="' + esc(rowStatusTitle(row)) + '"' : '') + '>' + esc(st.text) + '</span></td>' +
    '<td class="col-lib-state">' + libStateBadgeHtml(libState) + '</td>' +
    '<td class="col-op"><div class="cell-op">' + ops + '</div></td>' +
  '</tr>';
}

function renderOverviewStoreFilter() {
  if (!els.overviewStoreFilter) return;
  const current = state.overview.store || '';
  const stores = overviewStoreList();
  const names = stores.map((s) => s.name);
  if (current && names.indexOf(current) < 0) { state.overview.store = ''; }
  let html = '<option value="">全部店铺 / 类目</option>';
  for (const store of stores) {
    html += '<option value="' + esc(store.name) + '"' + (state.overview.store === store.name ? ' selected' : '') + '>' +
      esc(store.name) + '（' + fmtNum(store.rows, 0) + ' 行）</option>';
  }
  els.overviewStoreFilter.innerHTML = html;
}

function renderOverview() {
  const rows = filteredOverviewRows();
  renderOverviewStoreFilter();
  if (els.overviewCount) els.overviewCount.textContent = String(rows.length);
  if (els.overviewStatusFilter) els.overviewStatusFilter.value = state.overview.status || 'all';
  if (els.overviewSearch && document.activeElement !== els.overviewSearch) els.overviewSearch.value = state.overview.search || '';
  if (els.overviewPageSize) els.overviewPageSize.value = String(state.overview.pageSize);

  const pageSize = Number(state.overview.pageSize) || 0;
  const total = rows.length;
  const pages = pageSize > 0 ? Math.max(1, Math.ceil(total / pageSize)) : 1;
  if (state.overview.page > pages) state.overview.page = pages;
  if (state.overview.page < 1) state.overview.page = 1;
  const page = state.overview.page;
  const pageRows = pageSize > 0 ? rows.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize) : rows;
  const hasReports = (state.session.reports || []).length > 0;

  if (els.overviewEmpty) {
    const show = !hasReports || total === 0;
    els.overviewEmpty.classList.toggle('hidden', !show);
    els.overviewEmpty.textContent = !hasReports
      ? '还没有导入榜单。先在「工作台」导入 .xlsx 并点「分析补数」，这里会汇总全部榜单的配对结果。'
      : '没有符合当前筛选 / 搜索条件的行。';
  }
  if (els.overviewBody) {
    els.overviewBody.innerHTML = pageRows.map(overviewRowHtml).join('');
    bindPreviewButtons(els.overviewBody);
  }
  applyTableColumns('overview');
  syncHeaderFilterButtons('overview');
  if (els.overviewTable) {
    for (const th of els.overviewTable.querySelectorAll('th[data-sort]')) {
      const field = th.getAttribute('data-sort');
      th.classList.toggle('asc', state.overview.sortField === field && state.overview.sortDir === 'asc');
      th.classList.toggle('desc', state.overview.sortField === field && state.overview.sortDir === 'desc');
    }
  }
  if (els.overviewPager) {
    if (pageSize <= 0) {
      els.overviewPager.innerHTML = '<span>共 <b class="num">' + fmtNum(total, 0) + '</b> 行（全部显示）</span>' +
        (hasReports ? '<span class="muted">行数较多时滚动查看；可切回 200 / 500 行/页</span>' : '');
    } else {
      renderPager(els.overviewPager, { page, pageSize, total }, (next) => {
        state.overview.page = next;
        renderOverview();
      });
    }
  }
  renderQuickFilters();
}

/** 查找某 SKU 在所有榜单里的行（跨榜单同步用） */
function findOverviewTargets(sku) {
  const cleanSku = String(sku == null ? '' : sku).trim();
  if (!cleanSku) return [];
  const out = [];
  for (const report of state.session.reports || []) {
    const rows = reportRows(report);
    for (let i = 0; i < rows.length; i++) {
      if (String(rows[i].sku) === cleanSku) out.push({ row: rows[i], report, index: i });
    }
  }
  return out;
}

function isValidBandValue(field, value, rawText) {
  if (!value) return false;
  const options = field === 'size' ? sizeBandOptions() : priceBandOptions();
  if (options.indexOf(value) >= 0) {
    // 「其他」是脏值兜底：只有用户明确输入「其他」才允许
    if (field === 'size' && value === '其他' && String(rawText || '').trim() !== '其他') return false;
    return true;
  }
  if (field === 'size') {
    const m = String(value).match(/^其他尺寸\((\d+(?:\.\d+)?)英寸\)$/);
    if (m) {
      const inch = Number(m[1]);
      return inch >= 20 && inch <= 300;
    }
  }
  return false;
}

/**
 * 保存总览页一格（品牌/型号/套餐/尺寸段/价格段）：
 * 更新该行 + 同步同 SKU 的其它榜单行 + 写回匹配库；非法值不改并返回 invalid。
 * @returns {Promise<{ok:boolean, oldValue:string, newValue:string, libraryWritten:boolean, invalid?:boolean, error?:string}>}
 */
async function saveOverviewCell(sku, field, rawValue) {
  const cleanSku = String(sku == null ? '' : sku).trim();
  const fieldName = String(field || '');
  const targets = findOverviewTargets(cleanSku);
  if (!targets.length) return { ok: false, oldValue: '', newValue: '', libraryWritten: false, error: '找不到 SKU' };
  if (['brand', 'model', 'package', 'size', 'price'].indexOf(fieldName) < 0) {
    return { ok: false, oldValue: '', newValue: '', libraryWritten: false, error: '不支持编辑该字段' };
  }
  const oldValue = targets[0].row[fieldName] || '';
  const rawText = String(rawValue == null ? '' : rawValue).trim();
  let value = rawText;
  if (fieldName === 'brand') {
    if (value && lib.rules && typeof lib.rules.normalizeBrand === 'function') {
      try { const norm = lib.rules.normalizeBrand(value); if (norm) value = norm; } catch (e) { /* 保留用户输入 */ }
    }
  } else if (fieldName === 'size' || fieldName === 'price') {
    const normalized = normalizeBandValue(fieldName, rawText);
    value = normalized.value;
    if (rawText && !isValidBandValue(fieldName, value, rawText)) {
      return { ok: false, invalid: true, oldValue, newValue: value, libraryWritten: false, error: (fieldName === 'size' ? '尺寸段' : '价格段') + '不是规范值：' + rawText };
    }
  }
  if (value === oldValue) {
    return { ok: true, oldValue, newValue: value, libraryWritten: false, unchanged: true };
  }
  const backups = targets.map((t) => ({ row: t.row, value: t.row[fieldName], source: Object.assign({}, (t.row.source && typeof t.row.source === 'object') ? t.row.source : {}), modelSource: t.row.modelSource, packageSource: t.row.packageSource, status: t.row.status }));
  let libraryWritten = false;
  try {
    for (const t of targets) {
      const row = t.row;
      row[fieldName] = value;
      if (fieldName === 'size' && value) clearSizeReviewFlags(row); // v2.1.6：人工补齐后解除待复核
      if (!row.source || typeof row.source !== 'object') row.source = { size: '', price: '', brand: '', model: '', package: '' };
      row.source[fieldName] = '手动';
      if (fieldName === 'model') row.modelSource = '手动';
      if (fieldName === 'package') row.packageSource = '手动';
      refreshRowStatus(row);
      const storeName = (t.report && t.report.store) || '';
      if (storeName && lib.storeSchema && typeof lib.storeSchema.upsertMatch === 'function') {
        lib.storeSchema.upsertMatch(state.library, storeName, {
          sku: cleanSku,
          name: row.name || '',
          brand: row.brand || '',
          model: row.model || '',
          package: row.package || '',
          size: row.size || '',
          price: row.price || '',
          shop: row.storeName || storeNameOf(t.report, row) || '',
          source: '手动',
          updatedAt: nowIso(),
        }, { origin: 'manual', verified: true, verifiedAt: nowIso() });
        row.libState = 'verified';
        libraryWritten = true;
      }
    }
  } catch (e) {
    for (const b of backups) {
      b.row[fieldName] = b.value;
      b.row.source = b.source;
      if (b.modelSource !== undefined) b.row.modelSource = b.modelSource;
      if (b.packageSource !== undefined) b.row.packageSource = b.packageSource;
      b.row.status = b.status;
    }
    logLine('写回匹配库失败：' + humanError(e));
    renderOverview();
    toast('写入匹配库失败：' + humanError(e), 'error');
    return { ok: false, oldValue, newValue: value, libraryWritten: false, error: humanError(e) };
  }
  state.session.updatedAt = nowIso();
  markDirty('session');
  if (libraryWritten) markDirty('library');
  state.statsStale = true;
  renderKpis();
  renderOverview();
  renderMatchTable();
  toast('已写入匹配库（SKU ' + cleanSku + '）' + (targets.length > 1 ? '，同步 ' + targets.length + ' 行' : ''), 'ok');
  logLine('总览编辑：SKU ' + cleanSku + ' ' + (EDITABLE_FIELD_LABELS[fieldName] || fieldName) + ' → ' + (value || '（空）') + (libraryWritten ? '（已写回匹配库）' : ''));
  return { ok: true, oldValue, newValue: value, libraryWritten, syncedRows: targets.length };
}

/* ---------------- 总览页行内编辑 ---------------- */

let overviewCellEditActive = false;

function openOverviewCellEditor(cellEl) {
  if (!cellEl || overviewCellEditActive) return;
  const field = cellEl.getAttribute('data-field');
  const sku = String(cellEl.getAttribute('data-sku') || '');
  if (!field || !sku) return;
  const targets = findOverviewTargets(sku);
  if (!targets.length) return;
  const row = targets[0].row;
  const td = cellEl.parentElement;
  if (!td) return;
  const inputId = field === 'size' ? 'sizeBandList' : field === 'price' ? 'priceBandList' : '';
  const placeholder = field === 'size'
    ? '尺寸段，如 75英寸'
    : field === 'price'
      ? '价格段，如 3500元至4000元'
      : field === 'brand'
        ? '品牌，如 海信 / 创维 / 品牌B'
        : field === 'model'
          ? '型号，如 100XP3E'
          : '套餐，如 会议大屏+摄像头【免费送装一体】';
  overviewCellEditActive = true;
  td.innerHTML = '<div class="cell-editor">' +
    '<input class="input"' + (inputId ? ' list="' + inputId + '"' : '') + ' value="' + esc(row[field] || '') + '" placeholder="' + esc(placeholder) + '" autocomplete="off">' +
    '<div class="hint-row"><button type="button" class="mini" data-ed="save">保存</button><button type="button" class="mini" data-ed="cancel">取消</button></div>' +
  '</div>';
  const input = td.querySelector('input');
  const saveBtn = td.querySelector('[data-ed="save"]');
  const cancelBtn = td.querySelector('[data-ed="cancel"]');
  if (!input) { overviewCellEditActive = false; renderOverview(); return; }
  let finished = false;
  const finish = async (save) => {
    if (finished) return;
    const value = input.value.trim();
    if (!save) {
      finished = true;
      overviewCellEditActive = false;
      renderOverview();
      return;
    }
    const res = await saveOverviewCell(sku, field, value);
    if (res && res.invalid) {
      input.classList.add('invalid');
      if (!input.dataset.invalidToasted) {
        input.dataset.invalidToasted = '1';
        toast(res.error || '不是规范值，请从下拉候选中选择', 'error');
      }
      return;
    }
    finished = true;
    overviewCellEditActive = false;
    if (!res || !res.ok) renderOverview();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => {
    setTimeout(() => { if (!finished) finish(true); }, 160);
  });
  for (const btn of [saveBtn, cancelBtn]) {
    if (!btn) continue;
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', () => finish(btn === saveBtn));
  }
  input.focus();
  input.select();
}

/* ---------------- 总览页导出 ---------------- */

/** DESIGN 19.2：总览导出与工作台/配对明细共用同一 15 列定义（PAIR_EXPORT_HEADERS） */
const OVERVIEW_HEADERS = PAIR_EXPORT_HEADERS;

function overviewExportData() {
  return filteredOverviewRows().map((item) => {
    return { item, cells: pairExportCells(item.report, item.row) };
  });
}

function exportOverviewCsv() {
  const data = overviewExportData();
  if (!data.length) {
    toast('当前筛选结果为空，没有可导出的行', 'error');
    return;
  }
  const lines = [OVERVIEW_HEADERS.map(csvCell).join(',')];
  for (const entry of data) lines.push(entry.cells.map(csvCell).join(','));
  downloadBlob('\uFEFF' + lines.join('\r\n'), 'text/csv;charset=utf-8', '配对总览_' + todayStamp() + '.csv');
  toast('已导出配对总览 CSV（' + data.length + ' 行）', 'ok');
}

async function exportOverviewXlsx() {
  if (!engineReadyFor('xlsxWrite')) {
    toast('xlsx 写出模块未就绪（lib/xlsx-write.js），暂时无法导出。', 'error');
    return;
  }
  const data = overviewExportData();
  if (!data.length) {
    toast('当前筛选结果为空，没有可导出的行', 'error');
    return;
  }
  try {
    const columns = [
      { header: '行', width: 26 },
      { header: 'SKU', width: 18 },
      { header: '商品名称', width: 60 },
      { header: '店铺', width: 30 },
      { header: '品牌', width: 18 },
      { header: '型号', width: 18 },
      { header: '套餐', width: 30 },
      { header: '尺寸段', width: 16 },
      { header: '价格段', width: 20 },
      { header: '当前价格(元)', width: 14 },
      { header: '成交金额(万元)', width: 14 },
      { header: '采样', width: 12 },
      { header: '数据来源', width: 20 },
      { header: '状态', width: 10 },
      { header: '入库状态', width: 14 },
    ];
    // writeXlsx 传 columns 会自动生成表头行，rows 只放数据行
    const rows = data.map((entry) => entry.cells);
    const bytes = await lib.xlsxWrite.writeXlsx({
      sheets: [{ name: '配对总览', columns, rows, freeze: true }],
    });
    downloadBlob(bytes, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '配对总览_' + stampNow() + '.xlsx');
    toast('已导出配对总览 xlsx（' + data.length + ' 行）', 'ok');
  } catch (e) {
    logLine('导出配对总览失败：' + ((e && e.message) || e));
    toast('导出配对总览失败：' + humanError(e), 'error');
  }
}

/* ---------------- 总览页事件 ---------------- */

function bindOverviewEvents() {
  if (els.overviewStoreFilter) {
    els.overviewStoreFilter.addEventListener('change', () => {
      state.overview.store = els.overviewStoreFilter.value;
      state.overview.page = 1;
      renderOverview();
    });
  }
  if (els.overviewStatusFilter) {
    els.overviewStatusFilter.addEventListener('change', () => {
      state.overview.status = els.overviewStatusFilter.value;
      state.overview.page = 1;
      renderOverview();
      renderQuickFilters();
    });
  }
  if (els.overviewSearch) {
    let timer = null;
    els.overviewSearch.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        state.overview.search = els.overviewSearch.value;
        state.overview.page = 1;
        renderOverview();
      }, 120);
    });
  }
  if (els.overviewPageSize) {
    els.overviewPageSize.addEventListener('change', () => {
      state.overview.pageSize = Number(els.overviewPageSize.value) || 0;
      state.overview.page = 1;
      renderOverview();
    });
  }
  if (els.overviewTable) {
    els.overviewTable.addEventListener('click', (e) => {
      const th = e.target.closest('th[data-sort]');
      if (th) {
        const field = th.getAttribute('data-sort');
        if (state.overview.sortField === field) {
          state.overview.sortDir = state.overview.sortDir === 'asc' ? 'desc' : 'asc';
        } else {
          state.overview.sortField = field;
          state.overview.sortDir = field === 'amount' || field === 'price' ? 'desc' : 'asc';
        }
        state.overview.page = 1;
        renderOverview();
      }
    });
  }
  if (els.overviewBody) {
    els.overviewBody.addEventListener('click', (e) => {
      const cell = e.target.closest('[data-act="ov-edit-cell"]');
      if (cell) {
        openOverviewCellEditor(cell);
        return;
      }
      const writeBtn = e.target.closest('button[data-act="ov-confirm-write"]');
      if (writeBtn) {
        const report = (state.session.reports || []).find((r) => r.id === writeBtn.getAttribute('data-report-id'));
        const rows = reportRows(report);
        const idx = Number(writeBtn.getAttribute('data-index'));
        const row = rows[idx];
        if (row) confirmLibraryWriteRows([{ row, report }]).catch((err) => logLine('确认写入异常：' + humanError(err)));
        return;
      }
      const debugBtn = e.target.closest('button[data-act="ov-debug-price"]');
      if (debugBtn) {
        const report = (state.session.reports || []).find((r) => r.id === debugBtn.getAttribute('data-report-id'));
        const row = reportRows(report)[Number(debugBtn.getAttribute('data-index'))];
        if (row) openPriceDebug(String(row.sku || ''));
        return;
      }
      const confirmBtn = e.target.closest('button[data-act="ov-confirm"]');
      if (confirmBtn) {
        const report = (state.session.reports || []).find((r) => r.id === confirmBtn.getAttribute('data-report-id'));
        const rows = reportRows(report);
        const idx = Number(confirmBtn.getAttribute('data-index'));
        const row = rows[idx];
        if (row && confirmRowReview(row)) {
          state.session.updatedAt = nowIso();
          markDirty('session');
          state.statsStale = true;
          renderKpis();
          renderOverview();
          renderMatchTable();
          toast('已确认该行复核结果', 'ok');
        }
      }
    });
  }
  if (els.overviewExportXlsxBtn) els.overviewExportXlsxBtn.addEventListener('click', exportOverviewXlsx);
  if (els.overviewExportCsvBtn) els.overviewExportCsvBtn.addEventListener('click', exportOverviewCsv);
}

/* ============================ 匹配库页面 ============================ */

function libraryRows() {
  let rows = null;
  if (lib.storeSchema && typeof lib.storeSchema.libraryToRows === 'function') {
    try {
      const out = lib.storeSchema.libraryToRows(state.library);
      if (Array.isArray(out)) rows = out;
    } catch (e) {
      logLine('lib.libraryToRows 失败，改用兼容模式：' + humanError(e));
    }
  }
  if (!rows) rows = libraryRowsFallback();
  // DESIGN 18.7：匹配库按类目归档；记录带 JD 店铺名（shop）时优先展示
  return rows.map((row) => {
    const store = state.library && state.library.stores && state.library.stores[row.store];
    const rec = (store && store.rows && store.rows[String(row.sku)]) || null;
    return Object.assign({}, row, {
      storeName: row.storeName || (rec && rec.storeName) || row.store || '',
      shop: (rec && rec.shop) || row.shop || '',
    });
  });
}

function libraryRowsFallback() {
  const out = [];
  for (const [storeName, store] of Object.entries((state.library && state.library.stores) || {})) {
    for (const [sku, rec] of Object.entries((store && store.rows) || {})) {
      out.push({
        store: storeName,
        sku: String(sku),
        name: rec.name || '',
        brand: rec.brand || '',
        size: rec.size || '',
        price: rec.price || '',
        sizeRaw: rec.sizeRaw || '',
        priceRaw: rec.priceRaw || '',
        source: rec.source || '库',
        updatedAt: rec.updatedAt || '',
        sizeDirty: false,
        priceDirty: false,
      });
    }
  }
  return out;
}

function libraryRowByKey(storeName, sku) {
  const store = state.library && state.library.stores && state.library.stores[storeName];
  const rec = store && store.rows && store.rows[String(sku)];
  return rec || null;
}

function bandIsDirty(field, value, raw) {
  if (!lib.rules) return false;
  const fn = lib.rules[field === 'size' ? 'normalizeSizeBand' : 'normalizePriceBand'];
  if (typeof fn !== 'function') return false;
  const v = String(value == null ? '' : value);
  const r = String(raw == null ? '' : raw);
  if (!v && !r) return false;
  try {
    if (v) {
      const n = fn(v);
      if (n && (n.dirty || (n.value != null && n.value !== v))) return true;
    }
    if (r && r !== v) {
      const n2 = fn(r);
      if (n2 && n2.value !== v) return true;
    }
  } catch (e) { /* ignore */ }
  return false;
}

function isLibraryRowDirty(row) {
  if (row.sizeDirty || row.priceDirty) return true;
  return bandIsDirty('size', row.size, row.sizeRaw) || bandIsDirty('price', row.price, row.priceRaw);
}

function filteredLibraryRows() {
  const all = libraryRows();
  const f = state.libFilter;
  const q = String(f.search || '').trim().toLowerCase();
  return all.filter((row) => {
    if (f.store && row.store !== f.store) return false;
    const hasSize = !!(row.size || row.sizeRaw);
    const hasPrice = !!(row.price || row.priceRaw);
    if (f.mode === 'full' && !(hasSize && hasPrice)) return false;
    if (f.mode === 'noPrice' && hasPrice) return false;
    if (f.mode === 'noSize' && hasSize) return false;
    if (f.mode === 'dirty' && !isLibraryRowDirty(row)) return false;
    if (q) {
      const hay = (String(row.sku) + ' ' + String(row.name) + ' ' + String(row.brand) + ' ' +
        String(row.model || '') + ' ' + String(row.package || '') + ' ' + String(row.shop || '') + ' ' + String(row.storeName || '')).toLowerCase();
      if (hay.indexOf(q) < 0) return false;
    }
    return true;
  });
}

function libraryStoreCount(storeName) {
  const store = state.library && state.library.stores && state.library.stores[storeName];
  return store ? Object.keys(store.rows || {}).length : 0;
}

function getLibraryStats() {
  if (lib.storeSchema && typeof lib.storeSchema.statsOfLibrary === 'function') {
    try {
      const st = lib.storeSchema.statsOfLibrary(state.library);
      if (st && st.total && Array.isArray(st.stores)) return st;
    } catch (e) {
      logLine('lib.statsOfLibrary 失败，改用兼容模式：' + humanError(e));
    }
  }
  const byStore = new Map();
  let total = { stores: 0, skus: 0, sizeFilled: 0, priceFilled: 0, complete: 0, dirty: 0 };
  for (const row of libraryRows()) {
    if (!byStore.has(row.store)) byStore.set(row.store, { name: row.store, skus: 0, sizeFilled: 0, priceFilled: 0, complete: 0, dirty: 0, duplicates: 0 });
    const s = byStore.get(row.store);
    const hasSize = !!(row.size);
    const hasPrice = !!(row.price);
    s.skus++;
    total.skus++;
    if (hasSize) { s.sizeFilled++; total.sizeFilled++; }
    if (hasPrice) { s.priceFilled++; total.priceFilled++; }
    if (hasSize && hasPrice) { s.complete++; total.complete++; }
    if (isLibraryRowDirty(row)) { s.dirty++; total.dirty++; }
  }
  const withCoverage = (s) => Object.assign(s, {
    sizeCoverage: s.skus ? s.sizeFilled / s.skus : 0,
    priceCoverage: s.skus ? s.priceFilled / s.skus : 0,
    completeCoverage: s.skus ? s.complete / s.skus : 0,
  });
  const stores = Array.from(byStore.values()).map(withCoverage).sort((a, b) => b.skus - a.skus);
  total.stores = stores.length;
  total.sizeCoverage = total.skus ? total.sizeFilled / total.skus : 0;
  total.priceCoverage = total.skus ? total.priceFilled / total.skus : 0;
  total.completeCoverage = total.skus ? total.complete / total.skus : 0;
  return { total, stores };
}

function renderLibraryKpis(stats) {
  if (!els.libKpi) return;
  const t = stats.total || {};
  const cov = (v) => (v >= 0.75 ? 'accent-ok' : v > 0 ? 'accent-warn' : '');
  const cards = [
    { k: '类目', v: fmtNum(t.stores, 0), unit: '个', cls: 'accent-info' },
    { k: 'SKU 总数', v: fmtNum(t.skus, 0), unit: '个', cls: '' },
    { k: '尺寸段覆盖', v: fmtPct(t.sizeCoverage), unit: fmtNum(t.sizeFilled, 0) + '/' + fmtNum(t.skus, 0), cls: cov(t.sizeCoverage) },
    { k: '价格段覆盖', v: fmtPct(t.priceCoverage), unit: fmtNum(t.priceFilled, 0) + '/' + fmtNum(t.skus, 0), cls: cov(t.priceCoverage) },
    { k: '尺寸+价格齐全', v: fmtPct(t.completeCoverage), unit: fmtNum(t.complete, 0) + ' 条', cls: cov(t.completeCoverage) },
    { k: '历史脏值记录', v: fmtNum(t.dirty, 0), unit: '条', cls: t.dirty ? 'accent-info' : 'accent-ok' },
  ];
  els.libKpi.innerHTML = cards.map((c) =>
    '<div class="kpi ' + c.cls + '"><span class="k">' + esc(c.k) + '</span>' +
    '<span class="v">' + esc(c.v) + '<small>' + esc(c.unit) + '</small></span></div>'
  ).join('');
}

function renderLibraryStores(stats) {
  if (!els.libStoreList) return;
  const stMap = new Map((stats.stores || []).map((s) => [s.name, s]));
  const names = storeNames();
  const activeStore = state.libFilter.store;
  let html = '<div class="store-bulk">' +
    '<button id="mergeStoresBtn" class="btn mini ghost" type="button" disabled title="勾选至少 2 个类目后合并为一个并去重">合并所选类目…（0）</button>' +
    '<span class="store-bulk-hint">勾选 ≥2 个类目可合并去重</span>' +
  '</div>';
  html += '<div class="store-item' + (activeStore === '' ? ' active' : '') + '" data-store="">' +
    '<div class="store-item-top"><span class="store-name">全部类目</span><span class="store-count">' + fmtNum(stats.total.skus, 0) + '</span></div>' +
    '<div class="store-meta"><span>尺寸 ' + fmtPct(stats.total.sizeCoverage, 0) + ' · 价格 ' + fmtPct(stats.total.priceCoverage, 0) + '</span><span></span></div>' +
    '<div class="store-bar"><i style="width:' + Math.round((stats.total.completeCoverage || 0) * 100) + '%"></i></div>' +
  '</div>';
  for (const name of names) {
    const st = stMap.get(name) || { skus: libraryStoreCount(name), sizeCoverage: 0, priceCoverage: 0, completeCoverage: 0, dirty: 0 };
    html += '<div class="store-item' + (activeStore === name ? ' active' : '') + '" data-store="' + esc(name) + '">' +
      '<div class="store-item-top">' +
        '<input type="checkbox" class="store-select" data-store-select="' + esc(name) + '" title="勾选用于合并类目">' +
        '<span class="store-name" title="' + esc(name) + '">' + esc(name) + '</span>' +
        '<span class="store-count">' + fmtNum(st.skus, 0) + '</span>' +
        '<span class="store-tools">' +
          '<button class="icon-btn" type="button" data-store-act="dedupe" data-store="' + esc(name) + '" title="对该类目内部重复 SKU 去重（先备份）">⧉</button>' +
          '<button class="icon-btn" type="button" data-store-act="rename" data-store="' + esc(name) + '" title="类目改名">✎</button>' +
          '<button class="icon-btn" type="button" data-store-act="delete" data-store="' + esc(name) + '" title="删除类目">×</button>' +
        '</span>' +
      '</div>' +
      '<div class="store-meta"><span>尺寸 ' + fmtPct(st.sizeCoverage, 0) + ' · 价格 ' + fmtPct(st.priceCoverage, 0) + '</span><span>' + (st.dirty ? st.dirty + ' 条脏值' : '') + '</span></div>' +
      '<div class="store-bar"><i style="width:' + Math.round((st.completeCoverage || 0) * 100) + '%"></i></div>' +
    '</div>';
  }
  if (!names.length) {
    html += '<div class="store-empty">匹配库还没有类目。可点「＋ 新增」，或在右上角「导入并合并」导入匹配库 Excel。</div>';
  }
  els.libStoreList.innerHTML = html;
  syncMergeStoresButton();
}

function libraryRowHtml(row) {
  const dirty = isLibraryRowDirty(row);
  const cell = (field, value) => {
    const isBand = field === 'size' || field === 'price';
    const cls = 'band-cell' + (value ? '' : ' empty') + (isBand && dirty ? ' dirty' : '');
    const tip = (EDITABLE_FIELD_LABELS[field] || field) + '：点击修改（会写回匹配库）';
    const text = field === 'brand' ? (value || '未标注品牌') : (value || (field === 'model' || field === 'package' ? '—' : '点击填写'));
    return '<span class="' + cls + '" data-act="lib-edit-cell" data-field="' + field + '" data-store="' + esc(row.store) + '" data-sku="' + esc(row.sku) + '" title="' + esc(tip) + '">' + esc(text) + '</span>';
  };
  const shopName = row.shop || row.storeName || row.store || '';
  const shopTitle = row.shop
    ? '榜单店铺：' + row.shop + '（匹配库按类目归档：' + (row.storeName || row.store || '') + '）'
    : '匹配库按类目归档：' + (row.storeName || row.store || '');
  // DESIGN 20.10/20.3：匹配库记录「已确认 / 待确认」徽标 + 数据来源显示人工确认来源
  const verified = row.verified !== false;
  const verifiedText = row.verifiedText || (verified ? '已确认' : '待确认');
  const verifiedBadge = '<span class="lib-badge ' + (verified ? 'lib-verified' : 'lib-incomplete') + '" title="' +
    esc(row.verifiedText || (verified ? '人工/种子/导入，可信任' : '自动补齐，尚未人工核验')) + '">' + esc(verifiedText) + '</span>';
  const origin = String(row.origin || '');
  const sourceText = verified && (origin === 'manual' || origin === 'confirm' || row.source === '手动' || row.source === '人工确认')
    ? '已确认（人工）'
    : (row.source || '—');
  return '<tr data-store="' + esc(row.store) + '" data-sku="' + esc(row.sku) + '">' +
    '<td class="cell-sku"><a href="' + esc(ITEM_URL(row.sku)) + '" target="_blank" rel="noreferrer">' + esc(row.sku) + '</a></td>' +
    '<td><span class="cell-name" title="' + esc(row.name) + '">' + esc(row.name || '—') + '</span></td>' +
    '<td class="col-shop"><span class="cell-shop" title="' + esc(shopTitle) + '">' + esc(shopName || '—') + '</span></td>' +
    '<td class="col-brand">' + cell('brand', row.brand) + '</td>' +
    '<td class="col-model">' + cell('model', row.model) + '</td>' +
    '<td class="col-package">' + cell('package', row.package) + '</td>' +
    '<td class="col-band">' + cell('size', row.size) + '</td>' +
    '<td class="col-band wide">' + cell('price', row.price) + '</td>' +
    '<td class="col-source"><span class="lib-source-cell">' + esc(sourceText) + ' ' + verifiedBadge + '</span></td>' +
    '<td class="col-time">' + esc(fmtTime(row.updatedAt)) + '</td>' +
    '<td class="col-op"><div class="cell-op"><a class="op-btn" href="' + esc(ITEM_URL(row.sku)) + '" target="_blank" rel="noreferrer">打开</a></div></td>' +
  '</tr>';
}

function renderLibraryTable() {
  if (!els.libBody) return;
  const rows = filteredLibraryRows();
  const total = rows.length;
  const pageSize = Number(state.libFilter.pageSize) || 100;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (state.libFilter.page > pages) state.libFilter.page = pages;
  if (state.libFilter.page < 1) state.libFilter.page = 1;
  const page = state.libFilter.page;
  const start = (page - 1) * pageSize;
  const pageRows = rows.slice(start, start + pageSize);

  if (els.libTableCount) els.libTableCount.textContent = String(total);
  if (els.libEmpty) {
    els.libEmpty.classList.toggle('hidden', total > 0);
    els.libEmpty.textContent = !storeNames().length
      ? '匹配库为空：可点右上角「＋ 新增」创建类目，或「导入并合并」导入匹配库 Excel。'
      : '没有符合筛选 / 搜索条件的 SKU。';
  }
  els.libBody.innerHTML = pageRows.map(libraryRowHtml).join('');
  bindColumnHover(els.libTable);
  renderPager(els.libPager, { page, pageSize, total }, (next) => {
    state.libFilter.page = next;
    renderLibraryTable();
  });
}

/** 非法值提示：给对应 chip 闪一下红框（匹配库页） */
function flashInvalidCell(root, field, sku) {
  if (!root) return;
  let nodes = [];
  try { nodes = Array.from(root.querySelectorAll('[data-act="lib-edit-cell"]')); } catch (e) { nodes = []; }
  for (const node of nodes) {
    if (node.getAttribute('data-field') !== field) continue;
    if (String(node.getAttribute('data-sku')) !== String(sku)) continue;
    node.classList.add('invalid');
    setTimeout(() => { try { node.classList.remove('invalid'); } catch (e) { /* ignore */ } }, 1600);
  }
}

function saveLibraryCell(storeName, rec, field, rawValue) {
  if (!rec) {
    renderLibraryTable();
    return false;
  }
  const label = EDITABLE_FIELD_LABELS[field] || field;
  if (['brand', 'model', 'package', 'size', 'price'].indexOf(field) < 0) return false;
  const oldValue = rec[field] || '';
  const rawText = String(rawValue == null ? '' : rawValue).trim();
  let value = rawText;
  let normalized = null;
  if (field === 'brand') {
    if (value && lib.rules && typeof lib.rules.normalizeBrand === 'function') {
      try {
        const norm = lib.rules.normalizeBrand(value);
        if (norm) value = norm;
      } catch (e) { /* 保留用户输入 */ }
    }
  } else if (field === 'size' || field === 'price') {
    normalized = normalizeBandValue(field, rawText);
    value = normalized.value;
    if (rawText && !isValidBandValue(field, value, rawText)) {
      toast(label + '不是规范值：' + rawText + '（未写入匹配库）', 'error');
      renderLibraryTable();
      flashInvalidCell(els.libBody, field, rec.sku);
      return false;
    }
  }
  if (value === oldValue) {
    renderLibraryTable();
    return true;
  }
  rec[field] = value;
  if (normalized && normalized.dirty) {
    if (field === 'size') rec.sizeRaw = rawText;
    else rec.priceRaw = rawText;
  }
  rec.source = '手动';
  rec.updatedAt = nowIso();
  try {
    if (lib.storeSchema && typeof lib.storeSchema.upsertMatch === 'function') {
      lib.storeSchema.upsertMatch(state.library, storeName, {
        sku: String(rec.sku),
        name: rec.name || '',
        brand: rec.brand || '',
        model: rec.model || '',
        package: rec.package || '',
        size: rec.size || '',
        price: rec.price || '',
        shop: rec.shop || '',
        storeName: storeName,
        sizeRaw: rec.sizeRaw || '',
        priceRaw: rec.priceRaw || '',
        source: '手动',
        updatedAt: rec.updatedAt,
      }, { origin: 'manual', verified: true, verifiedAt: rec.updatedAt });
    }
  } catch (e) {
    rec[field] = oldValue;
    logLine('写回匹配库失败：' + humanError(e));
    toast('写回匹配库失败：' + humanError(e), 'error');
    renderLibraryTable();
    return false;
  }
  markDirty('library');
  renderLibraryPage();
  toast('已写入匹配库（SKU ' + rec.sku + '）', 'ok');
  return true;
}

function renderLibraryPage() {
  const stats = getLibraryStats();
  renderLibraryKpis(stats);
  renderLibraryStores(stats);
  renderLibraryTable();
  if (state.libLogOpen) renderLibraryLog();
}

/* ---------------- 类目维护 ---------------- */

async function addLibraryStore() {
  const name = await promptDialog('新增类目', '类目名称', '', '例如：大家电 会议电视；匹配库按类目（工作表）组织');
  const trimmed = String(name || '').trim();
  if (!trimmed) return;
  if (state.library.stores[trimmed]) {
    toast('类目已存在：' + trimmed, 'error');
    return;
  }
  state.library.stores[trimmed] = { name: trimmed, keywords: [], note: '手动新增', rows: {} };
  appendUiLibraryLog({ action: 'add-store', store: trimmed, sku: '', field: '', before: '', after: trimmed, source: '手动', note: '手动新增类目' });
  markDirty('library');
  state.libFilter.store = trimmed;
  state.libFilter.page = 1;
  renderLibraryPage();
  toast('已新增类目：' + trimmed, 'ok');
}

async function renameLibraryStore(oldName) {
  const name = await promptDialog('类目改名', '新类目名称', oldName, '改名后，匹配库与已绑定榜单会同步更新');
  const trimmed = String(name || '').trim();
  if (!trimmed || trimmed === oldName) return;
  if (state.library.stores[trimmed]) {
    toast('类目名已存在：' + trimmed, 'error');
    return;
  }
  const store = state.library.stores[oldName];
  if (!store) return;
  delete state.library.stores[oldName];
  store.name = trimmed;
  state.library.stores[trimmed] = store;
  for (const report of state.session.reports || []) {
    if (report.store === oldName) report.store = trimmed;
  }
  if (state.libFilter.store === oldName) state.libFilter.store = trimmed;
  markDirty('library');
  markDirty('session');
  renderLibraryPage();
  renderReports();
  toast('类目已改名为：' + trimmed, 'ok');
}

async function deleteLibraryStore(name) {
  const store = state.library.stores[name];
  if (!store) return;
  const count = Object.keys(store.rows || {}).length;
  const ok = await confirmDialog('删除类目', '确定删除类目「' + name + '」（' + count + ' 个 SKU）吗？\n\n该操作不可撤销，建议先「导出 xlsx / 导出备份 JSON」。');
  if (!ok) return;
  delete state.library.stores[name];
  for (const report of state.session.reports || []) {
    if (report.store === name) { report.store = ''; report.storeScore = 0; }
  }
  if (state.libFilter.store === name) state.libFilter.store = '';
  appendUiLibraryLog({ action: 'delete-store', store: name, sku: '', field: '', before: String(count), after: '', source: '手动', note: '删除类目' });
  markDirty('library');
  markDirty('session');
  renderLibraryPage();
  renderReports();
  toast('已删除类目：' + name, 'ok');
}

/* ---------------- 匹配库导入 / 导出 / 清洗 ---------------- */

function pickLibraryFile(mode) {
  state.pendingLibImportMode = mode === 'replace' ? 'replace' : 'merge';
  if (!els.libFileInput) return;
  els.libFileInput.value = '';
  els.libFileInput.click();
}

async function handleLibraryFile(file) {
  if (!file) return;
  if (!engineReadyFor('xlsxRead', 'headerMap', 'storeSchema')) {
    toast('数据引擎未就绪：缺少 xlsx 读取 / 表头识别 / 匹配库模型模块，暂时无法导入匹配库。', 'error');
    return;
  }
  setBusy(true);
  try {
    setSaveState('解析匹配库…');
    const wb = await lib.xlsxRead.readXlsx(await file.arrayBuffer());
    const stores = {};
    let skipped = 0;
    for (const sheet of wb.sheets || []) {
      try {
        if (!sheet || !Array.isArray(sheet.rows) || sheet.rows.length < 2) { skipped++; continue; }
        const parsed = lib.headerMap.parseReportSheet(sheet);
        if (!parsed || !Array.isArray(parsed.rows) || !parsed.rows.length) { skipped++; continue; }
        const headers = parsed.headers || [];
        const cols = parsed.columns || {};
        const readRaw = (row, idx) => {
          if (!(Number.isInteger(idx) && idx >= 0)) return '';
          const key = headers[idx];
          const v = row.raw ? row.raw[key] : '';
          return v == null ? '' : String(v).trim();
        };
        const rows = {};
        for (const r of parsed.rows) {
          const sku = lib.headerMap.normalizeSku ? String(lib.headerMap.normalizeSku(r.sku) || '').trim() : String(r.sku || '').trim();
          if (!sku) continue;
          const sizeRaw = readRaw(r, cols.size);
          const priceRaw = readRaw(r, cols.price);
          const sizeN = sizeRaw ? normalizeBandValue('size', sizeRaw) : { value: '', dirty: false };
          const priceN = priceRaw ? normalizeBandValue('price', priceRaw) : { value: '', dirty: false };
          rows[sku] = {
            sku,
            name: r.name || '',
            brand: r.brand || '',
            size: sizeN.value,
            price: priceN.value,
            sizeRaw,
            priceRaw,
            source: '库',
            updatedAt: nowIso(),
          };
        }
        if (!Object.keys(rows).length) { skipped++; continue; }
        const storeName = String(parsed.sheetName || sheet.name || '未命名').trim();
        stores[storeName] = { name: storeName, keyWords: [], note: '从 Excel 导入', rows };
      } catch (e) {
        skipped++;
        logLine('跳过工作表：' + humanError(e));
      }
    }
    if (!Object.keys(stores).length) throw new Error('没有识别到可导入的 SKU 表（需要包含 SKU / 商品编号 列）');
    const mode = state.pendingLibImportMode;
    let mergeStats = null;
    const res = lib.storeSchema.mergeLibrary(state.library, { stores, mode });
    if (res && res.library) state.library = normalizeLibraryShape(res.library);
    else state.library = normalizeLibraryShape(state.library);
    if (res && res.stats) mergeStats = res.stats;
    markDirty('library');
    renderAll();
    const importedStoreCount = Object.keys(stores).length;
    toast('匹配库已' + (mode === 'replace' ? '覆盖' : '合并') + '导入：' + importedStoreCount + ' 个类目' +
      (mergeStats && mergeStats.addedRows != null ? '，新增 ' + mergeStats.addedRows + ' 行' : '') +
      (skipped ? '（跳过 ' + skipped + ' 个工作表）' : ''), 'ok');
    renderLibReportHtml('<p class="report-summary">匹配库导入完成：模式 <b>' + (mode === 'replace' ? '覆盖' : '合并') +
      '</b>，识别工作表 <b>' + importedStoreCount + '</b> 个' + (skipped ? '，跳过 ' + skipped + ' 个' : '') + '。</p>' +
      (mergeStats ? '<pre class="debug-box">' + esc(JSON.stringify(mergeStats, null, 2)) + '</pre>' : ''));
  } catch (e) {
    logLine('导入匹配库失败：' + ((e && e.message) || e));
    toast('导入匹配库失败：' + humanError(e), 'error');
  } finally {
    setBusy(false);
  }
}

function safeSheetName(name) {
  return String(name || 'Sheet').replace(/[\\/?*\[\]:]/g, '_').slice(0, 31);
}

async function exportLibraryXlsx() {
  if (!engineReadyFor('xlsxWrite')) {
    toast('xlsx 写出模块未就绪（lib/xlsx-write.js），暂时无法导出。', 'error');
    return;
  }
  try {
    const sheets = [];
    // DESIGN 19.2：优先用 lib 的 LIBRARY_EXPORT_HEADERS/libraryExportRows，保证与界面表头逐字一致
    if (lib.storeSchema && typeof lib.storeSchema.libraryExportRows === 'function') {
      const exported = lib.storeSchema.libraryExportRows(state.library);
      if (exported && Array.isArray(exported.headers) && Array.isArray(exported.rows)) {
        const widths = [18, 60, 30, 18, 18, 30, 16, 20, 28, 22];
        sheets.push({
          name: '匹配库',
          columns: exported.headers.map((header, i) => ({ header: String(header), width: widths[i] || 16 })),
          rows: exported.rows,
          freeze: true,
        });
      }
    }
    if (!sheets.length) {
      for (const name of storeNames()) {
        const store = state.library.stores[name];
        // 兼容兜底：列序与界面一致（SKU/名称/店铺/品牌/型号/套餐/尺寸段/价格段/数据来源/更新时间）
        const rows = [];
        for (const [sku, rec] of Object.entries((store && store.rows) || {})) {
          rows.push([
            String(sku),
            rec.name || '',
            rec.shop || name,
            rec.brand || '',
            rec.model || '',
            rec.package || '',
            rec.size || '',
            rec.price || '',
            rec.source || '库',
            rec.updatedAt || '',
          ]);
        }
        sheets.push({
          name: safeSheetName(name),
          columns: [
            { header: 'SKU', width: 18 },
            { header: '商品名称', width: 60 },
            { header: '店铺', width: 30 },
            { header: '品牌', width: 18 },
            { header: '型号', width: 18 },
            { header: '套餐', width: 30 },
            { header: '尺寸段', width: 16 },
            { header: '价格段', width: 20 },
            { header: '数据来源', width: 28 },
            { header: '更新时间', width: 22 },
          ],
          rows,
          freeze: true,
        });
      }
    }
    if (!sheets.length) {
      toast('匹配库为空，没有可导出的内容', 'error');
      return;
    }
    const bytes = await lib.xlsxWrite.writeXlsx({ sheets });
    downloadBlob(bytes, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '匹配库_' + stampNow() + '.xlsx');
    toast('已导出匹配库 xlsx（' + sheets.length + ' 张表）', 'ok');
  } catch (e) {
    logLine('导出匹配库失败：' + ((e && e.message) || e));
    toast('导出匹配库失败：' + humanError(e), 'error');
  }
}

function snapshotLibrary() {
  const map = {};
  for (const [storeName, store] of Object.entries((state.library && state.library.stores) || {})) {
    for (const [sku, rec] of Object.entries((store && store.rows) || {})) {
      map[storeName + '::' + sku] = { size: rec.size || '', price: rec.price || '' };
    }
  }
  return map;
}

function diffLibrarySnapshot(before) {
  const details = [];
  for (const [storeName, store] of Object.entries((state.library && state.library.stores) || {})) {
    for (const [sku, rec] of Object.entries((store && store.rows) || {})) {
      const old = before[storeName + '::' + sku];
      if (!old) continue;
      if (old.size !== (rec.size || '')) details.push({ store: storeName, sku, field: 'size', before: old.size, after: rec.size || '' });
      if (old.price !== (rec.price || '')) details.push({ store: storeName, sku, field: 'price', before: old.price, after: rec.price || '' });
    }
  }
  return details;
}

function normalizeReportHtml(details, changed) {
  const list = Array.isArray(details) ? details : [];
  if (!list.length) {
    return '<p class="report-summary">归一化完成：没有发现需要修正的脏值，<b class="report-good">匹配库已经是规范值。</b></p>';
  }
  const rows = list.slice(0, 200).map((d, i) =>
    '<tr>' +
      '<td class="num">' + (i + 1) + '</td>' +
      '<td>' + esc(d.store || '—') + '</td>' +
      '<td class="num">' + esc(d.sku || '—') + '</td>' +
      '<td>' + (d.field === 'price' ? '价格段' : '尺寸段') + '</td>' +
      '<td class="report-bad">' + esc(d.before || '（空）') + '</td>' +
      '<td class="report-good">' + esc(d.after || '（空）') + '</td>' +
    '</tr>'
  ).join('');
  return '<p class="report-summary">归一化完成：共修正 <b>' + fmtNum(changed == null ? list.length : changed, 0) + '</b> 处脏值（最多展示 200 条）。</p>' +
    '<table class="tbl"><thead><tr><th class="col-rowno">#</th><th>类目</th><th>SKU</th><th>字段</th><th>修正前</th><th>修正后</th></tr></thead><tbody>' +
    rows + '</tbody></table>';
}

async function normalizeLibraryNow() {
  if (!lib.storeSchema || typeof lib.storeSchema.normalizeLibrary !== 'function') {
    toast('匹配库模型模块未就绪（lib/store-schema.js），暂时无法归一化。', 'error');
    return;
  }
  setBusy(true);
  try {
    const before = snapshotLibrary();
    let res = null;
    try {
      res = lib.storeSchema.normalizeLibrary(state.library);
    } catch (e) {
      toast('归一化失败：' + humanError(e), 'error');
      return;
    }
    if (res && res.library) state.library = normalizeLibraryShape(res.library);
    else state.library = normalizeLibraryShape(state.library);
    const details = res && Array.isArray(res.details) && res.details.length ? res.details : diffLibrarySnapshot(before);
    const changed = res && res.changed != null ? res.changed : details.length;
    markDirty('library');
    renderAll();
    renderLibReportHtml(normalizeReportHtml(details, changed));
    toast('归一化完成：修正 ' + details.length + ' 处脏值', 'ok');
  } finally {
    setBusy(false);
  }
}

function issuesCountsHtml(counts) {
  const items = [
    ['类目', counts.stores],
    ['SKU', counts.skus],
    ['尺寸/价格不完整', counts.incomplete],
    ['历史脏值', counts.dirty],
    ['跨类目冲突', counts.conflicts],
    ['空商品名', counts.emptyName],
  ];
  return '<span class="issues-counts">' + items.map(([label, value]) =>
    '<span class="issues-chip">' + esc(label) + ' <b>' + fmtNum(value, 0) + '</b></span>'
  ).join('') + '</span>';
}

function issuesIncompleteHtml(list) {
  const rows = list.slice(0, 200).map((it, i) =>
    '<tr><td class="num">' + (i + 1) + '</td><td>' + esc(it.store || '—') + '</td><td class="num">' + esc(it.sku || '—') + '</td><td>' +
    esc((it.missing || []).map((m) => (m === 'size' ? '缺尺寸段' : m === 'price' ? '缺价格段' : m)).join(' / ')) + '</td></tr>'
  ).join('');
  return '<table class="tbl"><thead><tr><th class="col-rowno">#</th><th>类目</th><th>SKU</th><th>缺失</th></tr></thead><tbody>' + rows + '</tbody></table>';
}

function issuesConflictsHtml(list) {
  const rows = list.slice(0, 100).map((it, i) => {
    const entries = (it.entries || []).map((entry) =>
      esc(entry.store || '') + '：' + (it.fields || []).map((f) => (f === 'size' ? (entry.size || '（空）') : (entry.price || '（空）'))).join(' / ')
    ).join('<br>');
    return '<tr><td class="num">' + (i + 1) + '</td><td class="num">' + esc(it.sku || '—') + '</td><td>' +
      esc((it.fields || []).map((f) => (f === 'size' ? '尺寸段' : '价格段')).join(' / ')) + '</td><td>' + entries + '</td></tr>';
  }).join('');
  return '<table class="tbl"><thead><tr><th class="col-rowno">#</th><th>SKU</th><th>冲突字段</th><th>各类目值</th></tr></thead><tbody>' + rows + '</tbody></table>';
}

function issuesDirtyHtml(list) {
  const rows = list.slice(0, 100).map((it, i) =>
    '<tr><td class="num">' + (i + 1) + '</td><td>' + esc(it.store || '—') + '</td><td class="num">' + esc(it.sku || '—') + '</td><td>' +
    (it.field === 'price' ? '价格段' : '尺寸段') + '</td><td class="report-bad">' + esc(it.raw || '—') + '</td><td class="report-good">' + esc(it.normalized || '（空）') + '</td></tr>'
  ).join('');
  return '<table class="tbl"><thead><tr><th class="col-rowno">#</th><th>类目</th><th>SKU</th><th>字段</th><th>原始脏值</th><th>归一化后</th></tr></thead><tbody>' + rows + '</tbody></table>';
}

function crossStoreDuplicates() {
  const map = new Map();
  for (const [storeName, store] of Object.entries((state.library && state.library.stores) || {})) {
    for (const sku of Object.keys((store && store.rows) || {})) {
      if (!map.has(sku)) map.set(sku, []);
      map.get(sku).push(storeName);
    }
  }
  return Array.from(map.entries())
    .filter(([, stores]) => stores.length > 1)
    .map(([sku, stores]) => ({ sku, stores }));
}

function issuesTableHtml(list) {
  const rows = list.slice(0, 200).map((it, i) =>
    '<tr><td class="num">' + (i + 1) + '</td><td>' + esc(it.type) + '</td><td>' + esc(it.store || '—') + '</td><td class="num">' + esc(it.sku || '—') + '</td><td>' + esc(it.message) + '</td></tr>'
  ).join('');
  return '<table class="tbl"><thead><tr><th class="col-rowno">#</th><th>类型</th><th>类目</th><th>SKU</th><th>说明</th></tr></thead><tbody>' + rows + '</tbody></table>';
}

function duplicateTableHtml(list) {
  const rows = list.slice(0, 200).map((it, i) =>
    '<tr><td class="num">' + (i + 1) + '</td><td class="num">' + esc(it.sku) + '</td><td>' + esc(it.stores.join(' / ')) + '</td></tr>'
  ).join('');
  return '<table class="tbl"><thead><tr><th class="col-rowno">#</th><th>SKU</th><th>出现类目</th></tr></thead><tbody>' + rows + '</tbody></table>';
}

async function checkLibraryIssues() {
  if (!lib.storeSchema || typeof lib.storeSchema.findLibraryIssues !== 'function') {
    toast('匹配库模型模块未就绪（lib/store-schema.js），暂时无法检查。', 'error');
    return;
  }
  setBusy(true);
  try {
    let issues = null;
    try {
      issues = lib.storeSchema.findLibraryIssues(state.library);
    } catch (e) {
      toast('检查失败：' + humanError(e), 'error');
      return;
    }
    const dup = crossStoreDuplicates();
    let html = '';
    let problemCount = 0;

    if (issues && !Array.isArray(issues) && issues.counts) {
      const counts = issues.counts;
      html += '<p class="report-summary">匹配库检查：' + issuesCountsHtml(counts) + '</p>';
      problemCount = (Number(counts.incomplete) || 0) + (Number(counts.conflicts) || 0) + (Number(counts.dirty) || 0) + (Number(counts.emptyName) || 0) + dup.length;
      if (!problemCount) {
        html += '<p class="report-summary"><b class="report-good">没有发现冲突或异常，匹配库状态良好。</b></p>';
      }
      if (Array.isArray(issues.conflicts) && issues.conflicts.length) {
        html += '<p class="report-summary" style="margin-top:10px">跨类目同 SKU 值冲突（' + issues.conflicts.length + ' 个，最多展示 100 条）：</p>' + issuesConflictsHtml(issues.conflicts);
      }
      if (Array.isArray(issues.incomplete) && issues.incomplete.length) {
        html += '<p class="report-summary" style="margin-top:10px">尺寸段 / 价格段不完整（' + issues.incomplete.length + ' 条，最多展示 200 条；这些行会在下个月导入榜单时标记为待补）：</p>' + issuesIncompleteHtml(issues.incomplete);
      }
      if (Array.isArray(issues.dirty) && issues.dirty.length) {
        html += '<p class="report-summary" style="margin-top:10px">历史脏值（已归一化，保留原始值便于追溯；' + issues.dirty.length + ' 条，最多展示 100 条）：</p>' + issuesDirtyHtml(issues.dirty);
      }
    } else {
      const list = Array.isArray(issues) ? issues : [];
      problemCount = list.length + dup.length;
      html += '<p class="report-summary">匹配库检查：发现 <b>' + list.length + '</b> 个问题，跨类目重复 SKU <b>' + dup.length + '</b> 个。</p>';
      if (!list.length && !dup.length) {
        html += '<p class="report-summary"><b class="report-good">没有发现冲突或重复，匹配库状态良好。</b></p>';
      } else if (list.length) {
        html += '<table class="tbl"><thead><tr><th class="col-rowno">#</th><th>类型</th><th>类目</th><th>SKU</th><th>说明</th></tr></thead><tbody>' +
          list.slice(0, 200).map((it, i) => '<tr><td class="num">' + (i + 1) + '</td><td>' +
            esc((it && (it.type || it.kind)) || '问题') + '</td><td>' + esc((it && it.store) || '—') + '</td><td class="num">' +
            esc((it && it.sku) || '—') + '</td><td>' + esc((it && (it.message || it.reason || JSON.stringify(it))) || '') + '</td></tr>').join('') +
          '</tbody></table>';
      }
    }
    if (dup.length) {
      html += '<p class="report-summary" style="margin-top:10px">跨类目重复 SKU（' + dup.length + ' 个，同一 SKU 出现在多个类目，统计时需确认归属）：</p>' + duplicateTableHtml(dup);
    }
    renderLibReportHtml(html);
    toast('检查完成：问题 ' + problemCount + ' 项' + (dup.length ? '（含重复 SKU ' + dup.length + ' 个）' : ''), problemCount ? 'error' : 'ok');
  } finally {
    setBusy(false);
  }
}

function renderLibReportHtml(html) {
  if (els.libReportBody) els.libReportBody.innerHTML = html;
  if (els.libReportPanel) {
    els.libReportPanel.classList.remove('hidden');
    try { els.libReportPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (e) { /* ignore */ }
  }
}

/* ============================ 统计看板 ============================ */

function ensureStats(force) {
  if (!lib.pipeline || typeof lib.pipeline.computeStats !== 'function') return null;
  if (!force && state.stats && !state.statsStale) return state.stats;
  try {
    state.stats = lib.pipeline.computeStats(state.session.reports || [], state.library);
    state.statsStale = false;
    return state.stats;
  } catch (e) {
    logLine('统计计算失败：' + ((e && e.message) || e));
    toast('统计计算失败：' + humanError(e), 'error');
    return null;
  }
}

/** 按当前类目子页过滤后的榜单集合计算统计（类目子页用） */
function computeStatsForView(reports) {
  if (!lib.pipeline || typeof lib.pipeline.computeStats !== 'function') return null;
  try {
    return lib.pipeline.computeStats(reports || [], state.library);
  } catch (e) {
    logLine('统计计算失败：' + ((e && e.message) || e));
    return null;
  }
}

/** 统计看板类目 tab 数据：全部 + 每个已绑定类目（行数 / 金额） */
function statsStoreOptions() {
  const map = new Map();
  for (const report of state.session.reports || []) {
    const rows = reportRows(report);
    if (!rows.length) continue;
    const name = report.store || '未绑定类目';
    if (!map.has(name)) map.set(name, { name, rows: 0, amount: 0, reports: 0, reviewNeeded: 0 });
    const entry = map.get(name);
    entry.reports += 1;
    entry.rows += rows.length;
    for (const row of rows) {
      if (row.amount != null && Number.isFinite(Number(row.amount))) entry.amount += Number(row.amount);
      if (reviewNeeded(row)) entry.reviewNeeded += 1;
    }
  }
  return Array.from(map.values()).sort((a, b) => b.amount - a.amount);
}

function renderStatsStoreTabs(reports) {
  if (!els.statsStoreTabs) return;
  const list = (reports || []).filter((r) => reportRows(r).length);
  if (!list.length) {
    els.statsStoreTabs.innerHTML = '';
    if (els.openStoreReportBtn) els.openStoreReportBtn.disabled = true;
    return;
  }
  const stores = statsStoreOptions();
  const names = new Set(stores.map((s) => s.name));
  if (state.statsStore && !names.has(state.statsStore)) state.statsStore = '';
  const allRows = list.reduce((n, r) => n + reportRows(r).length, 0);
  const allAmount = stores.reduce((n, s) => n + s.amount, 0);
  const allReview = stores.reduce((n, s) => n + s.reviewNeeded, 0);
  const tab = (value, label, meta, active) => '<button class="stats-tab' + (active ? ' active' : '') + '" type="button" role="tab" aria-selected="' + (active ? 'true' : 'false') + '" data-store-tab="' + esc(value) + '">' +
    '<span>' + esc(label) + '</span><span class="tab-meta">' + esc(meta) + '</span></button>';
  let html = tab('all', '全部', fmtNum(allRows, 0) + ' 行 · ' + fmtNum(allAmount, 0) + ' 万' + (allReview ? ' · 待确认 ' + allReview : ''), state.statsStore === '');
  for (const store of stores) {
    html += tab(store.name, store.name, fmtNum(store.rows, 0) + ' 行 · ' + fmtNum(store.amount, 0) + ' 万' + (store.reviewNeeded ? ' · 待确认 ' + store.reviewNeeded : ''), state.statsStore === store.name);
  }
  els.statsStoreTabs.innerHTML = html;
  if (els.openStoreReportBtn) {
    els.openStoreReportBtn.disabled = !state.statsStore;
    els.openStoreReportBtn.title = state.statsStore ? '切到工作台并把「' + state.statsStore + '」的榜单设为当前榜单' : '先选择一个类目';
  }
  if (els.statsSortHint) {
    els.statsSortHint.textContent = state.statsStore ? '单类目视图：点击表头可按品牌 / 商品数 / 金额排序' : '全部视图：点击表头可按品牌 / 商品数 / 金额排序';
  }
}

function sortBrandRows(brands) {
  const sort = state.statsBrandSort || { field: 'amount', dir: 'desc' };
  const factor = sort.dir === 'asc' ? 1 : -1;
  const list = (brands || []).slice();
  list.sort((a, b) => {
    if (sort.field === 'brand') {
      return String(a.brand || '').localeCompare(String(b.brand || ''), 'zh-CN') * factor;
    }
    const av = Number(sort.field === 'rows' ? a.rows : a.amount) || 0;
    const bv = Number(sort.field === 'rows' ? b.rows : b.amount) || 0;
    if (av === bv) return String(a.brand || '').localeCompare(String(b.brand || ''), 'zh-CN');
    return (av - bv) * factor;
  });
  return list;
}

/** 品牌市占率表（单类目/全部类目共用；支持搜索 + 排序） */
function brandStatsTableHtml(storeData, opts) {
  opts = opts || {};
  const allBrands = Array.isArray(storeData.brands) ? storeData.brands : [];
  const q = String(opts.search || '').trim().toLowerCase();
  const filtered = q ? allBrands.filter((b) => String(b.brand || '').toLowerCase().indexOf(q) >= 0) : allBrands;
  const list = sortBrandRows(filtered);
  const sort = state.statsBrandSort || { field: 'amount', dir: 'desc' };
  const mark = (field) => (sort.field === field ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '');
  const rows = list.map((b, i) => {
    const pct = b.sharePercent != null ? Number(b.sharePercent) : Number(b.share || 0) * 100;
    return '<tr>' +
      '<td class="rank num">' + (i + 1) + '</td>' +
      '<td title="' + esc(b.brand || '') + '">' + esc(b.brand || '—') + '</td>' +
      '<td class="rank num">' + fmtNum(b.rows, 0) + '</td>' +
      '<td class="amount num">' + fmtNum(b.amount, 2) + ' <span class="muted" style="font-size:10px">万</span></td>' +
      '<td class="bar-cell"><div class="brand-bar"><i style="width:' + Math.max(0, Math.min(100, pct)).toFixed(2) + '%"></i></div></td>' +
      '<td class="pct">' + (Math.round(pct * 100) / 100).toFixed(2) + '%</td>' +
    '</tr>';
  }).join('');
  return '<table><thead><tr><th class="rank">#</th>' +
    '<th class="sortable" data-sort-field="brand">品牌' + mark('brand') + '</th>' +
    '<th class="rank sortable" data-sort-field="rows">商品数' + mark('rows') + '</th>' +
    '<th class="amount sortable" data-sort-field="amount">销售金额' + mark('amount') + '</th>' +
    '<th class="bar-cell">占比</th><th class="pct">占比%</th></tr></thead><tbody>' +
    (rows || '<tr><td colspan="6" class="empty">没有匹配的品牌</td></tr>') + '</tbody></table>';
}

let chartUid = 0;

function renderDistribution(container, items, opts) {
  if (!container) return;
  opts = opts || {};
  const list = (items || []).filter((it) => it && (opts.includeZero || Number(it.value) > 0));
  if (!list.length) {
    container.innerHTML = '<span class="empty-mini">暂无数据。</span>';
    return;
  }
  const max = Math.max.apply(null, list.map((it) => Number(it.value) || 0).concat([1]));
  const total = list.reduce((n, it) => n + (Number(it.value) || 0), 0);
  const rowH = 25;
  const pad = 8;
  const labelW = 148;
  const valueW = 96;
  const W = 560;
  const H = pad * 2 + list.length * rowH;
  const uid = 'distGrad' + (++chartUid);
  const colors = opts.grad || [cssVar('--chart-1', '#58f0ff'), cssVar('--chart-2', '#9a7bff')];
  const trackColor = cssVar('--track-bg-soft', 'rgba(255,255,255,.07)');
  const labelColor = cssVar('--chart-label', 'rgba(245,243,255,.72)');
  const valueColor = cssVar('--chart-value', 'rgba(245,243,255,.9)');
  let svg = '<svg class="svg-bars" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMinYMin meet" role="img" aria-label="' + esc(opts.title || '分布图') + '">';
  svg += '<defs><linearGradient id="' + uid + '" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="' + colors[0] + '"/><stop offset="1" stop-color="' + colors[1] + '"/></linearGradient></defs>';
  list.forEach((it, i) => {
    const y = pad + i * rowH;
    const value = Number(it.value) || 0;
    const barMax = W - labelW - valueW - 18;
    const w = max > 0 ? Math.round((value / max) * barMax) : 0;
    const pct = total ? (value / total) * 100 : 0;
    const tip = String(it.label) + '：' + fmtNum(value, 0) + ' 行' + (it.amount != null ? ' · ' + fmtNum(it.amount, 2) + ' 万元' : '') + ' · 占比 ' + pct.toFixed(1) + '%';
    svg += '<g><title>' + esc(tip) + '</title>' +
      '<text x="0" y="' + (y + 16) + '" font-size="11" fill="' + labelColor + '">' + esc(truncate(it.label, 9)) + '</text>' +
      '<rect x="' + labelW + '" y="' + (y + 4) + '" width="' + Math.max(0, barMax) + '" height="13" rx="6.5" fill="' + trackColor + '"/>' +
      (w > 0 ? '<rect x="' + labelW + '" y="' + (y + 4) + '" width="' + w + '" height="13" rx="6.5" fill="url(#' + uid + ')"/>' : '') +
      '<text x="' + W + '" y="' + (y + 16) + '" text-anchor="end" font-size="10.5" fill="' + valueColor + '">' + esc(fmtNum(value, 0)) + ' 行 · ' + pct.toFixed(0) + '%</text>' +
    '</g>';
  });
  svg += '</svg>';
  container.innerHTML = (opts.title ? '<div class="chart-title">' + esc(opts.title) + '</div>' : '') + svg +
    '<div class="chart-foot">共 ' + fmtNum(total, 0) + ' 行；条形长度按行数，悬停可看金额与占比。</div>';
}

function renderStoreStats(stats, storeName) {
  const target = els.storeBrandTable || els.storeStats;
  if (!target) return;
  const byStore = Array.isArray(stats.byStore) ? stats.byStore : [];
  const search = state.statsBrandSearch || '';
  if (!byStore.length) {
    target.innerHTML = '<span class="empty-mini">暂无类目统计。请先分析榜单。</span>';
    if (els.statsBrandCount) els.statsBrandCount.textContent = '0';
    return;
  }
  const totalAmount = byStore.reduce((n, s) => n + (Number(s.amount) || 0), 0);
  let brandTotal = 0;
  let html = '';
  if (storeName) {
    const store = byStore[0];
    const brands = Array.isArray(store.brands) ? store.brands : [];
    brandTotal = brands.length;
    const rows = state.statsStore
      ? (state.session.reports || []).filter((r) => (r.store || '未绑定类目') === state.statsStore)
      : state.session.reports || [];
    let reviewCount = 0;
    let reportCount = 0;
    for (const report of rows) {
      if (!reportRows(report).length) continue;
      reportCount += 1;
      for (const row of reportRows(report)) if (reviewNeeded(row)) reviewCount += 1;
    }
    html = '<div class="store-stat">' +
      '<div class="single-store-head">' +
        '<h4>' + esc(store.store || store.name || storeName || '—') + '</h4>' +
        '<span class="total">' + fmtNum(store.amount, 2) + ' 万元</span>' +
        '<span class="share">' + fmtNum(store.rows, 0) + ' 行 · ' + reportCount + ' 个榜单 · 品牌 ' + brands.length + ' 个' +
          (reviewCount ? ' · <b style="color:var(--review-text)">待确认 ' + reviewCount + ' 行</b>' : '') + '</span>' +
      '</div>' +
      brandStatsTableHtml(store, { search }) +
    '</div>';
  } else {
    for (const store of byStore) {
      const brands = Array.isArray(store.brands) ? store.brands : [];
      brandTotal += brands.length;
      const storePct = totalAmount ? ((Number(store.amount) || 0) / totalAmount) * 100 : 0;
      let reviewCount = 0;
      for (const report of state.session.reports || []) {
        if ((report.store || '未绑定类目') !== (store.store || store.name || '未绑定类目')) continue;
        for (const row of reportRows(report)) if (reviewNeeded(row)) reviewCount += 1;
      }
      html += '<div class="store-stat">' +
        '<div class="store-stat-head">' +
          '<h4>' + esc(store.store || store.name || '—') + '</h4>' +
          '<span class="total">' + fmtNum(store.amount, 2) + ' 万元</span>' +
          '<span class="share">占全部 ' + storePct.toFixed(2) + '% · ' + fmtNum(store.rows, 0) + ' 行 · 品牌 ' + brands.length + ' 个' +
            (reviewCount ? ' · 待确认 ' + reviewCount + ' 行' : '') + '</span>' +
        '</div>' +
        brandStatsTableHtml(store, { search }) +
      '</div>';
    }
  }
  target.innerHTML = html;
  if (els.statsBrandCount) els.statsBrandCount.textContent = String(brandTotal);
}

function renderMatrix(matrix, unitText) {
  if (!els.matrixTable) return;
  const unit = unitText || '万元';
  if (!matrix || !Array.isArray(matrix.prices) || !Array.isArray(matrix.brands) || !matrix.prices.length) {
    els.matrixTable.innerHTML = '<span class="empty-mini">暂无矩阵数据。</span>';
    return;
  }
  const brands = matrix.brands.slice(0, 30);
  const prices = matrix.prices;
  const cells = new Map();
  let max = 0;
  for (const cell of matrix.byBrandPrice || []) {
    if (!cell || !cell.brand || !cell.price) continue;
    const value = Number(cell.amount != null ? cell.amount : cell.rows) || 0;
    cells.set(String(cell.brand) + '||' + String(cell.price), value);
    if (value > max) max = value;
  }
  // 主题色：矩阵热力色 / 深色字随主题走
  const matrixRgb = cssVar('--matrix-rgb', '88,240,255');
  const inkStrong = cssVar('--matrix-ink', '#04121a');
  const inkSoft = cssVar('--matrix-ink-soft', 'rgba(245,243,255,.86)');
  let html = '<table class="matrix-table"><thead><tr><th>品牌</th>';
  for (const price of prices) html += '<th>' + esc(String(price).replace(/元/g, '')) + '</th>';
  html += '<th>合计</th></tr></thead><tbody>';
  for (const brand of brands) {
    html += '<tr><th title="' + esc(brand.brand || '') + '">' + esc(truncate(brand.brand || '—', 10)) + '</th>';
    let rowSum = 0;
    for (const price of prices) {
      const value = cells.get(String(brand.brand) + '||' + String(price)) || 0;
      rowSum += value;
      const alpha = max > 0 && value > 0 ? Math.min(0.82, Math.max(0.06, Math.pow(value / max, 0.55) * 0.82)) : 0;
      const style = value > 0
        ? 'background:rgba(' + matrixRgb + ',' + alpha.toFixed(2) + ');color:' + (alpha > 0.42 ? inkStrong : inkSoft)
        : '';
      const tip = (brand.brand || '') + ' · ' + price + '：' + fmtNum(value, 2) + ' ' + unit;
      html += '<td class="matrix-cell' + (value ? '' : ' zero') + '" style="' + style + '" title="' + esc(tip) + '">' + (value ? fmtNum(value, 0) : '·') + '</td>';
    }
    html += '<td class="matrix-cell" style="font-weight:700">' + fmtNum(rowSum, 0) + '</td></tr>';
  }
  html += '</tbody></table>';
  els.matrixTable.innerHTML = '<div class="chart-foot" style="margin-bottom:6px">展示成交金额前 ' + brands.length + ' 个品牌 × ' + prices.length +
    ' 个价格段；格子颜色越深表示金额越高，悬停可看数值。</div>' + html;
}

function buildLibraryMatrix(rows) {
  const priceOrder = priceBandOptions();
  const brandCounts = new Map();
  const priceCounts = new Map();
  const cell = new Map();
  for (const row of rows) {
    const brand = row.brand || '未识别品牌';
    const price = row.price || '（空）';
    brandCounts.set(brand, (brandCounts.get(brand) || 0) + 1);
    priceCounts.set(price, (priceCounts.get(price) || 0) + 1);
    const key = brand + '||' + price;
    cell.set(key, (cell.get(key) || 0) + 1);
  }
  const prices = priceOrder.filter((p) => priceCounts.has(p))
    .concat(Array.from(priceCounts.keys()).filter((p) => !priceOrder.includes(p)));
  const brands = Array.from(brandCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([brand, count]) => ({ brand, rows: count, amount: count }));
  const byBrandPrice = Array.from(cell.entries()).map(([key, count]) => {
    const parts = key.split('||');
    return { brand: parts[0], price: parts[1], rows: count, amount: count };
  });
  return { prices, brands, byBrandPrice, bySizePrice: [] };
}

function renderStatsFallback(message) {
  const target = els.storeBrandTable || els.storeStats;
  if (target) {
    target.innerHTML = '<p class="report-summary" style="color:var(--faint);line-height:1.8">' + esc(message) + '</p>';
  }
  if (els.statsBrandCount) els.statsBrandCount.textContent = '0';
  const rows = libraryRows();
  const sizeGroups = new Map();
  const priceGroups = new Map();
  for (const row of rows) {
    const size = row.size || '（空）';
    const price = row.price || '（空）';
    sizeGroups.set(size, (sizeGroups.get(size) || 0) + 1);
    priceGroups.set(price, (priceGroups.get(price) || 0) + 1);
  }
  const toItems = (map) => Array.from(map.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([label, value]) => ({ label, value }));
  renderDistribution(els.sizeChart, toItems(sizeGroups), { grad: [cssVar('--chart-1', '#58f0ff'), cssVar('--chart-2', '#9a7bff')], title: '匹配库尺寸段分布（条）' });
  renderDistribution(els.priceChart, toItems(priceGroups), { grad: [cssVar('--chart-3', '#ffc766'), cssVar('--chart-4', '#ff6ec7')], title: '匹配库价格段分布（条）' });
  renderMatrix(buildLibraryMatrix(rows), '条');
}

/** 「打开该类目榜单」：切到工作台并把该类目的第一个榜单设为当前榜单 */
function openStoreReport() {
  if (!state.statsStore) {
    toast('先在类目选择条里选择一个类目', 'error');
    return;
  }
  const report = (state.session.reports || []).find((r) => (r.store || '未绑定类目') === state.statsStore && reportRows(r).length);
  if (!report) {
    toast('找不到该类目下的榜单', 'error');
    return;
  }
  state.session.activeReportId = report.id;
  markDirty('session');
  navigate('workbench');
  renderAll();
  toast('已切到工作台：「' + state.statsStore + '」· ' + report.fileName, 'ok');
}

function renderStats() {
  const reports = (state.session.reports || []).filter((r) => reportRows(r).length);
  const hasPipeline = !!(lib.pipeline && typeof lib.pipeline.computeStats === 'function');
  renderStatsStoreTabs(reports);

  const filteredReports = state.statsStore
    ? reports.filter((r) => (r.store || '未绑定类目') === state.statsStore)
    : reports;
  const viewRows = filteredReports.flatMap((report) => reportRows(report));

  if (els.statsMeta) {
    const targetAmount = viewRows.reduce((n, row) => n + (row.amount != null && Number.isFinite(Number(row.amount)) ? Number(row.amount) : 0), 0);
    const sizeFilled = viewRows.filter((row) => rowHasSize(row)).length;
    const priceFilled = viewRows.filter((row) => rowHasPrice(row)).length;
    const reviewCount = viewRows.filter((row) => reviewNeeded(row)).length;
    const parts = [
      '当前视图 <b>' + esc(state.statsStore || '全部') + '</b>',
      '榜单 <b>' + fmtNum(filteredReports.length, 0) + '</b> 个',
      '行数 <b>' + fmtNum(viewRows.length, 0) + '</b>',
      '成交金额合计 <b>' + fmtNum(targetAmount, 0) + '</b> 万元',
      '尺寸段覆盖 <b>' + fmtPct(viewRows.length ? sizeFilled / viewRows.length : 0) + '</b>',
      '价格段覆盖 <b>' + fmtPct(viewRows.length ? priceFilled / viewRows.length : 0) + '</b>',
      '待确认 <b>' + fmtNum(reviewCount, 0) + '</b> 行',
    ];
    els.statsMeta.innerHTML = parts.map((t) => '<span>' + t + '</span>').join('');
  }
  if (els.statsBrandSearch) els.statsBrandSearch.value = state.statsBrandSearch || '';

  if (!hasPipeline) {
    renderStatsFallback('数据引擎未就绪：缺少 lib/pipeline.js，暂不能生成榜单市占率统计。以下先展示匹配库分布，可直观看到清理进度。');
    return;
  }
  if (!filteredReports.length) {
    renderStatsFallback('还没有已分析的榜单：先在工作台导入榜单并点「分析补数」。以下先展示匹配库的尺寸段 / 价格段分布。');
    return;
  }
  const stats = computeStatsForView(filteredReports);
  if (!stats) {
    renderStatsFallback('统计计算失败，请查看日志；以下先展示匹配库分布。');
    return;
  }
  if (!state.statsStore) {
    state.stats = stats;
    state.statsStale = false;
  }
  renderStoreStats(stats, state.statsStore);
  renderDistribution(els.sizeChart, (stats.bySize || []).map((x) => ({ label: x.band, value: x.rows, amount: x.amount })), {
    grad: [cssVar('--chart-1', '#58f0ff'), cssVar('--chart-2', '#9a7bff')],
    title: (state.statsStore ? state.statsStore : '全部类目') + ' · 尺寸段分布（行）',
    includeZero: true,
  });
  renderDistribution(els.priceChart, (stats.byPrice || []).map((x) => ({ label: x.band, value: x.rows, amount: x.amount })), {
    grad: [cssVar('--chart-3', '#ffc766'), cssVar('--chart-4', '#ff6ec7')],
    title: (state.statsStore ? state.statsStore : '全部类目') + ' · 价格段分布（行）',
    includeZero: true,
  });
  renderMatrix(stats.matrix, '万元');
}

/* ============================ 设置与帮助页面 ============================ */

const PRICE_KIND_ORDER = ['hand', 'main', 'plus'];
const FIELD_LABELS = { sku: 'SKU', name: '名称', brand: '品牌', model: '型号', package: '套餐', amount: '金额', store: '店铺', size: '尺寸', price: '价格' };
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function fieldLabel(field) {
  return FIELD_LABELS[field] || field;
}

function normalizePrefer(prefer) {
  const out = [];
  for (const kind of Array.isArray(prefer) ? prefer : []) {
    if (PRICE_KIND_ORDER.indexOf(kind) >= 0 && out.indexOf(kind) < 0) out.push(kind);
  }
  for (const kind of PRICE_KIND_ORDER) if (out.indexOf(kind) < 0) out.push(kind);
  return out.slice(0, 3);
}

function fillPriceKindSelect(select, value) {
  if (!select) return;
  select.innerHTML = PRICE_KIND_ORDER.map((kind) =>
    '<option value="' + kind + '"' + (kind === value ? ' selected' : '') + '>' + PRICE_KIND_LABELS[kind] + '</option>'
  ).join('');
}

function renderSettingsForm() {
  const s = state.settings || cloneSettings(DEFAULT_SETTINGS);
  const cap = s.capture || {};
  if (els.setBatch) els.setBatch.value = String(cap.batchSize != null ? cap.batchSize : 0);
  if (els.setBatchLimit) els.setBatchLimit.value = String(cap.maxBatch != null ? cap.maxBatch : cap.batchLimit != null ? cap.batchLimit : 20);
  if (els.setAnomalyWait) els.setAnomalyWait.value = String(cap.anomalyWaitSec != null ? cap.anomalyWaitSec : 60);
  if (els.setDelayMin) els.setDelayMin.value = String(cap.delayMin != null ? cap.delayMin : 5);
  if (els.setDelayMax) els.setDelayMax.value = String(cap.delayMax != null ? cap.delayMax : 10);
  if (els.setCooldownMinutes) els.setCooldownMinutes.value = String(cap.cooldownMinutes != null ? cap.cooldownMinutes : 60);
  if (els.setAutoPauseOnRisk) els.setAutoPauseOnRisk.checked = cap.autoPauseOnRisk !== false;
  if (els.setRetries) els.setRetries.value = String(cap.retries != null ? cap.retries : 1);
  if (els.setCaptureMode) els.setCaptureMode.value = cap.mode === 'double' || cap.mode === 'single' ? cap.mode : 'smart';
  if (els.setMaxSamples) els.setMaxSamples.value = String(cap.maxSamples != null ? cap.maxSamples : 3);
  if (els.setTolerancePct) els.setTolerancePct.value = String(Math.round((cap.tolerancePct != null ? cap.tolerancePct : 0.01) * 1000) / 10);
  if (els.setToleranceAbs) els.setToleranceAbs.value = String(cap.toleranceAbs != null ? cap.toleranceAbs : 30);
  if (els.setBoundaryMarginPct) {
    els.setBoundaryMarginPct.value = String(Math.round((s.price && s.price.boundaryMarginPct != null ? s.price.boundaryMarginPct : 0.01) * 1000) / 10);
  }
  if (els.setThemeSelect) els.setThemeSelect.value = s.ui && s.ui.theme ? s.ui.theme : 'auto';
  if (els.setSkipToday) els.setSkipToday.checked = !!cap.skipCapturedToday;
  if (els.setKeepTab) els.setKeepTab.checked = !!cap.keepTab;
  const prefer = normalizePrefer(s.price && s.price.prefer);
  fillPriceKindSelect(els.setPrefer1, prefer[0]);
  fillPriceKindSelect(els.setPrefer2, prefer[1]);
  fillPriceKindSelect(els.setPrefer3, prefer[2]);
  const boundary = s.price && s.price.bandBoundary === 'rightClosed' ? 'rightClosed' : 'rightOpen';
  for (const radio of document.querySelectorAll('input[name="bandBoundary"]')) {
    radio.checked = radio.value === boundary;
  }
  if (els.setMinPlausible) els.setMinPlausible.value = String(s.price && s.price.minPlausible != null ? s.price.minPlausible : 30);
  renderSeedVersionText();
  renderLibraryBackupInfo();
}

async function saveSettings() {
  const prevBoundary = state.settings.price && state.settings.price.bandBoundary;
  const prevTheme = state.settings.ui && state.settings.ui.theme;
  const batch = Math.max(0, Math.floor(Number(els.setBatch && els.setBatch.value) || 0));
  const maxBatch = Math.max(5, Math.min(100, Math.floor(Number(els.setBatchLimit && els.setBatchLimit.value) || 20)));
  const anomalyWaitSec = Math.max(0, Math.min(600, Math.floor(Number(els.setAnomalyWait && els.setAnomalyWait.value) || 0)));
  const delayMin = Math.max(1, Math.min(120, Math.floor(Number(els.setDelayMin && els.setDelayMin.value) || 5)));
  const delayMax = Math.max(delayMin, Math.min(240, Math.floor(Number(els.setDelayMax && els.setDelayMax.value) || 10)));
  const cooldownMinutes = Math.max(1, Math.min(1440, Math.floor(Number(els.setCooldownMinutes && els.setCooldownMinutes.value) || 60)));
  const retries = Math.max(0, Math.min(5, Math.floor(Number(els.setRetries && els.setRetries.value) || 0)));
  const modeValue = els.setCaptureMode ? els.setCaptureMode.value : 'smart';
  const mode = modeValue === 'double' || modeValue === 'single' ? modeValue : 'smart';
  const maxSamples = Math.max(2, Math.min(5, Math.floor(Number(els.setMaxSamples && els.setMaxSamples.value) || 3)));
  const tolerancePct = Math.max(0, Math.min(1, Number(els.setTolerancePct && els.setTolerancePct.value) / 100 || 0.01));
  const toleranceAbs = Math.max(0, Math.min(100000, Math.floor(Number(els.setToleranceAbs && els.setToleranceAbs.value) || 30)));
  const boundaryMarginPct = Math.max(0, Math.min(0.5, Number(els.setBoundaryMarginPct && els.setBoundaryMarginPct.value) / 100 || 0.01));
  const prefer = normalizePrefer([els.setPrefer1, els.setPrefer2, els.setPrefer3].filter(Boolean).map((x) => x.value));
  const checkedRadio = document.querySelector('input[name="bandBoundary"]:checked');
  const boundary = checkedRadio && checkedRadio.value === 'rightClosed' ? 'rightClosed' : 'rightOpen';
  const minPlausible = Math.max(1, Math.floor(Number(els.setMinPlausible && els.setMinPlausible.value) || 30));
  const themeValue = els.setThemeSelect ? els.setThemeSelect.value : 'auto';
  const theme = themeValue === 'light' || themeValue === 'dark' ? themeValue : 'auto';

  state.settings = {
    version: 1,
    capture: {
      batchSize: batch,
      maxBatch,
      batchLimit: maxBatch,
      anomalyWaitSec,
      delayMin,
      delayMax,
      retries,
      skipCapturedToday: !!(els.setSkipToday && els.setSkipToday.checked),
      keepTab: !!(els.setKeepTab && els.setKeepTab.checked),
      mode,
      maxSamples,
      tolerancePct,
      toleranceAbs,
      cooldownMinutes,
      autoPauseOnRisk: !!(els.setAutoPauseOnRisk && els.setAutoPauseOnRisk.checked),
      cooldownUntil: (state.settings.capture && state.settings.capture.cooldownUntil) || '',
    },
    price: { prefer, bandBoundary: boundary, minPlausible, boundaryMarginPct },
    mapping: state.settings.mapping || { overrides: {} },
    ui: Object.assign({}, state.settings.ui || {}, { theme }),
  };
  applyTheme();
  markDirty('settings');
  await flushSave('settings');
  renderSettingsForm();
  renderKpis();
  updateReviewToolbar();
  const boundaryChanged = prevBoundary !== boundary;
  const themeChanged = prevTheme !== theme;
  toast('设置已保存' + (boundaryChanged ? '。价格段边界口径已改变，重新「分析补数」后生效。' : '') + (themeChanged ? '。主题已切换为「' + (theme === 'auto' ? '跟随系统' : theme === 'light' ? '白天' : '黑夜') + '」。' : ''), 'ok');
}

async function resetSettings() {
  const ok = await confirmDialog('恢复默认设置', '确定把采集节奏 / 价格口径 / 边界口径恢复为默认值吗？\n\n表头映射记忆与匹配库数据会保留。');
  if (!ok) return;
  const overrides = (state.settings.mapping && state.settings.mapping.overrides) || {};
  const next = cloneSettings(DEFAULT_SETTINGS);
  next.mapping.overrides = overrides;
  state.settings = next;
  markDirty('settings');
  await flushSave('settings');
  renderSettingsForm();
  renderOverrides();
  toast('已恢复默认设置', 'ok');
}

function renderOverrides() {
  if (!els.overridesList) return;
  const overrides = (state.settings.mapping && state.settings.mapping.overrides) || {};
  const names = Object.keys(overrides);
  if (!names.length) {
    els.overridesList.innerHTML = '<span class="empty-mini">还没有手动映射记录。识别不准时在「表头诊断」里点选列，会按文件名记住。</span>';
    return;
  }
  els.overridesList.innerHTML = names.map((name) => {
    const ov = overrides[name] || {};
    const parts = [];
    for (const field of ['sku', 'name', 'brand', 'amount', 'store', 'size', 'price']) {
      const idx = Number(ov[field]);
      if (Number.isInteger(idx) && idx >= 0) parts.push(fieldLabel(field) + '→' + colLetter(idx));
    }
    return '<div class="override-item" title="' + esc(name) + '">' +
      '<span class="file">' + esc(name) + '</span>' +
      '<span class="cols">' + esc(parts.join(' · ') || '仅固定表头行') + '</span>' +
      '<button class="icon-btn" type="button" data-override="' + esc(name) + '" title="删除该文件的映射记忆">×</button>' +
    '</div>';
  }).join('');
}

async function clearAllOverrides() {
  const names = Object.keys((state.settings.mapping && state.settings.mapping.overrides) || {});
  if (!names.length) {
    toast('还没有表头映射记录');
    return;
  }
  const ok = await confirmDialog('清空表头映射记忆', '确定清空 ' + names.length + ' 条按文件名记住的表头映射吗？\n\n下次导入这些文件时会重新自动识别。');
  if (!ok) return;
  state.settings.mapping.overrides = {};
  markDirty('settings');
  await flushSave('settings');
  renderOverrides();
  toast('已清空表头映射记忆', 'ok');
}

function latestCaptureRecord() {
  let latest = null;
  for (const [sku, cap] of Object.entries(state.captures || {})) {
    if (!cap || typeof cap !== 'object') continue;
    if (!latest || String(cap.at || '') > String(latest.cap.at || '')) latest = { sku, cap };
  }
  return latest;
}

function debugJson() {
  const latest = latestCaptureRecord();
  if (!latest) return '暂无采集数据。';
  const cap = latest.cap;
  return JSON.stringify(Object.assign(buildPriceDebugPayload(null, latest.sku), {
    account: cap.account,
    url: cap.url,
    title: cap.title,
    sizeInch: cap.sizeInch,
    sizeText: cap.sizeText,
    prices: cap.prices,
    flags: cap.flags,
    fail: cap.fail,
  }), null, 2);
}

function renderDebug() {
  if (!els.debugBox) return;
  els.debugBox.textContent = debugJson();
}

async function copyDebug() {
  await copyText(debugJson(), '调试 JSON 已复制，可直接粘贴反馈');
}

/* ---------------- v2.1.7 候选价格调试弹窗 ---------------- */

function openPriceDebug(sku) {
  const clean = String(sku == null ? '' : sku).trim();
  const found = clean ? findRowContextBySku(clean) : null;
  const payload = buildPriceDebugPayload(found ? found.row : null, clean);
  if (els.priceDebugTitle) {
    els.priceDebugTitle.textContent = '价格候选调试' + (clean ? ' · SKU ' + clean : '');
  }
  if (els.priceDebugBody) els.priceDebugBody.textContent = JSON.stringify(payload, null, 2);
  state.capture.debugShown = payload;
  showDialog(els.priceDebugDialog);
  return payload;
}

function closePriceDebug() {
  closeDialog(els.priceDebugDialog);
}

async function copyPriceDebugJson() {
  const text = (els.priceDebugBody && els.priceDebugBody.textContent) || JSON.stringify(state.capture.debugShown || getLastCaptureDebug() || {}, null, 2);
  await copyText(text, '候选价格调试 JSON 已复制');
}

async function copyLastCaptureDebug() {
  const payload = getLastCaptureDebug()
    || (() => {
      const latest = latestCaptureRecord();
      return latest ? buildPriceDebugPayload(null, latest.sku) : null;
    })();
  if (!payload) {
    toast('还没有采集记录，先补采一条后再复制', 'error');
    return;
  }
  await copyText(JSON.stringify(payload, null, 2), '最近一次采集调试 JSON 已复制');
}

/* ---------------- 备份 / 清理 ---------------- */

async function exportBackup() {
  try {
    let payload;
    if (lib.pipeline && typeof lib.pipeline.buildBackupJson === 'function') {
      payload = lib.pipeline.buildBackupJson({ library: state.library, session: serializeSession(), captures: state.captures });
    } else {
      payload = { version: 1, at: nowIso(), library: state.library, session: serializeSession(), captures: state.captures };
    }
    downloadJson(payload, '市占率备份_' + stampNow() + '.json');
    toast('已导出备份 JSON（匹配库 + 榜单会话 + 采集缓存）', 'ok');
  } catch (e) {
    logLine('导出备份失败：' + ((e && e.message) || e));
    toast('导出备份失败：' + humanError(e), 'error');
  }
}

function pickBackupFile() {
  if (!els.backupFileInput) return;
  els.backupFileInput.value = '';
  els.backupFileInput.click();
}

async function handleBackupFile(file) {
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const library = data.library || data[STORAGE_KEYS.library] || null;
    const session = data.session || data[STORAGE_KEYS.session] || null;
    const captures = data.captures || data[STORAGE_KEYS.captures] || null;
    if (!library && !session && !captures) throw new Error('备份文件结构不正确（缺少 library / session / captures）');
    const ok = await confirmDialog('导入备份 JSON',
      '将用备份文件覆盖当前数据：\n\n' +
      '· 匹配库：' + (library ? '有（' + Object.keys((library.stores) || {}).length + ' 个类目）' : '无') + '\n' +
      '· 榜单会话：' + (session && Array.isArray(session.reports) ? session.reports.length + ' 个榜单' : '无') + '\n' +
      '· 采集缓存：' + (captures ? Object.keys(captures).length + ' 个 SKU' : '无') + '\n\n' +
      '当前未备份的数据会被覆盖，确定继续？');
    if (!ok) return;
    if (library && library.stores) {
      state.library = normalizeLibraryShape(library);
      markDirty('library');
    }
    if (session && Array.isArray(session.reports)) {
      state.session = {
        version: 1,
        reports: session.reports,
        activeReportId: session.activeReportId || (session.reports[0] && session.reports[0].id) || null,
        updatedAt: session.updatedAt || nowIso(),
      };
      for (const report of state.session.reports) {
        if (!Array.isArray(report.rows)) report.rows = [];
        report.rows.forEach((row, i) => { row._i = i; });
      }
      markDirty('session');
    }
    if (captures && typeof captures === 'object') {
      state.captures = captures;
      markDirty('captures');
    }
    state.statsStale = true;
    state.stats = null;
    await flushAllSaves();
    ensureDatalists();
    renderAll();
    renderDebug();
    toast('备份已导入：匹配库 ' + Object.keys((state.library && state.library.stores) || {}).length + ' 个类目 / 榜单 ' + (state.session.reports || []).length + ' 个', 'ok');
  } catch (e) {
    logLine('导入备份失败：' + ((e && e.message) || e));
    toast('导入备份失败：' + humanError(e), 'error');
  }
}

async function purgeCaptures() {
  const count = Object.keys(state.captures || {}).length;
  const ok = await confirmDialog('清空采集缓存', '确定清空全部采集缓存（' + count + ' 个 SKU 的价格 / 尺寸 / 候选）吗？\n\n不影响匹配库与榜单会话，下次补采会重新抓取。');
  if (!ok) return;
  state.captures = {};
  markDirty('captures');
  renderDebug();
  renderAll();
  toast('已清空采集缓存', 'ok');
}

async function clearSession() {
  const count = (state.session.reports || []).length;
  if (!count) {
    toast('当前没有榜单会话');
    return;
  }
  const ok = await confirmDialog('清空榜单会话', '确定清空已导入的 ' + count + ' 个榜单及其分析结果吗？\n\n匹配库与采集缓存会保留，可重新导入榜单。');
  if (!ok) return;
  state.session = clone(DEFAULT_SESSION);
  state.statsStale = true;
  state.stats = null;
  state.lastAnalyzeAt = null;
  markDirty('session');
  ensureDatalists();
  renderAll();
  toast('已清空榜单会话', 'ok');
}

/* ---------------- 导出 ---------------- */

function requireXlsxExport() {
  if (!lib.xlsxWrite || typeof lib.xlsxWrite.writeXlsx !== 'function' || !lib.pipeline) {
    toast('导出需要 xlsx 写出与补数流水线模块（lib 未就绪，请刷新页面后重试）。', 'error');
    return false;
  }
  return true;
}

/* v2.1.6：导出「状态」列统一走 UI rowStatusInfo（sizeAmbiguous → 待复核；缺尺寸/价格段可定位）。
 * 列结构不变；这里只覆盖状态单元格（第 14 列，索引 13），数据来源保持 lib 实际来源。 */
function patchPairRowsStatus(rows, report) {
  const sourceRows = reportRows(report);
  return (Array.isArray(rows) ? rows : []).map((values, index) => {
    if (!Array.isArray(values)) return values;
    const row = sourceRows[index];
    if (!row) return values;
    const target = values.slice();
    target[13] = rowStatusInfo(row).text;
    return target;
  });
}

/** 结果工作簿里的 配对_n sheet：按 reports 顺序覆盖「状态」列 */
function patchResultWorkbookStatuses(workbook, reports) {
  if (!workbook || !Array.isArray(workbook.sheets)) return workbook;
  const list = Array.isArray(reports) ? reports : [];
  const pairHeaderKey = PAIR_EXPORT_HEADERS.join('\u0001');
  let pairIndex = 0;
  for (const sheet of workbook.sheets) {
    const headers = (sheet && Array.isArray(sheet.columns) ? sheet.columns : []).map((c) => c && c.header).join('\u0001');
    if (headers !== pairHeaderKey) continue;
    const report = list[pairIndex];
    pairIndex += 1;
    if (!report) continue;
    sheet.rows = patchPairRowsStatus(sheet.rows, report);
  }
  return workbook;
}

/** 回填工作簿（16 列，第 14 列同为状态）：覆盖「状态」列，列/表头不变 */
function patchBackfillWorkbookStatuses(workbook, report) {
  if (!workbook || !Array.isArray(workbook.sheets) || !report) return workbook;
  for (const sheet of workbook.sheets) {
    if (!sheet || !Array.isArray(sheet.rows)) continue;
    sheet.rows = patchPairRowsStatus(sheet.rows, report);
  }
  return workbook;
}

async function exportBackfill() {
  if (!requireXlsxExport()) return;
  const report = activeReport();
  if (!report) {
    toast('请先导入并选中一个榜单', 'error');
    return;
  }
  if (typeof lib.pipeline.buildBackfillWorkbook !== 'function') {
    toast('回填导出接口缺失（buildBackfillWorkbook），请检查 lib 版本', 'error');
    return;
  }
  setBusy(true);
  try {
    setSaveState('生成回填 xlsx…');
    refreshLibraryStates(); // 回填 16 列含「入库状态」，先按当前库标注 row.libState
    const workbook = lib.pipeline.buildBackfillWorkbook(report);
    patchBackfillWorkbookStatuses(workbook, report); // v2.1.6：状态列显示待复核/缺尺寸/缺价格
    const bytes = await lib.xlsxWrite.writeXlsx(workbook);
    const base = String(report.fileName || '榜单').replace(/\.xlsx$/i, '');
    downloadBlob(bytes, XLSX_MIME, '回填_' + sanitizeFilePart(base) + '_' + stampNow() + '.xlsx');
    logLine('已导出回填榜单：' + report.fileName + '（' + reportRows(report).length + ' 行）');
    toast('已导出回填榜单：' + report.fileName, 'ok');
  } catch (e) {
    logLine('导出回填榜单失败：' + ((e && e.message) || e));
    toast('导出回填榜单失败：' + humanError(e), 'error');
  } finally {
    setBusy(false);
  }
}

/** 一键导出全部榜单的回填 xlsx（每月例行工作流：4 个榜单一次拿齐） */
async function exportBackfillAll() {
  if (!requireXlsxExport()) return;
  const reports = (state.session.reports || []).slice();
  if (!reports.length) {
    toast('还没有榜单：先导入 .xlsx 榜单文件', 'error');
    return;
  }
  if (typeof lib.pipeline.buildBackfillWorkbook !== 'function') {
    toast('回填导出接口缺失（buildBackfillWorkbook），请检查 lib 版本', 'error');
    return;
  }
  setBusy(true);
  let ok = 0;
  let fail = 0;
  try {
    for (let i = 0; i < reports.length; i++) {
      const report = reports[i];
      try {
        setSaveState('生成回填 xlsx ' + (i + 1) + '/' + reports.length + '…');
        refreshLibraryStates(); // 回填 16 列含「入库状态」
        const workbook = lib.pipeline.buildBackfillWorkbook(report);
        patchBackfillWorkbookStatuses(workbook, report); // v2.1.6：状态列显示待复核/缺尺寸/缺价格
        const bytes = await lib.xlsxWrite.writeXlsx(workbook);
        const base = String(report.fileName || '榜单').replace(/\.xlsx$/i, '');
        downloadBlob(bytes, XLSX_MIME, '回填_' + sanitizeFilePart(base) + '_' + stampNow() + '.xlsx');
        ok++;
        logLine('已导出回填 xlsx：' + report.fileName + '（' + reportRows(report).length + ' 行）');
      } catch (e) {
        fail++;
        logLine('导出回填失败「' + report.fileName + '」：' + ((e && e.message) || e));
      }
      // 文件之间留一点间隔，避免浏览器把连续下载当异常拦截
      if (i < reports.length - 1) await sleep(400);
    }
  } finally {
    setBusy(false);
  }
  const msg = '导出完成：成功 ' + ok + ' / 共 ' + reports.length + (fail ? '（' + fail + ' 个失败，详见日志）' : '');
  toast(msg, fail ? 'error' : 'ok');
}

async function exportResult() {
  if (!requireXlsxExport()) return;
  if (!(state.session.reports || []).length) {
    toast('还没有榜单，无法生成统计结果', 'error');
    return;
  }
  if (typeof lib.pipeline.buildResultWorkbook !== 'function') {
    toast('统计导出接口缺失（buildResultWorkbook），请检查 lib 版本', 'error');
    return;
  }
  setBusy(true);
  try {
    setSaveState('生成结果 xlsx…');
    const stats = ensureStats(true);
    const workbook = lib.pipeline.buildResultWorkbook(state.session.reports, stats, {
      generatedAt: nowIso(),
      appVersion: APP_VERSION,
      fileName: '市占率结果',
    });
    patchResultWorkbookStatuses(workbook, state.session.reports); // v2.1.6：配对_n 状态列显示待复核等
    const bytes = await lib.xlsxWrite.writeXlsx(workbook);
    downloadBlob(bytes, XLSX_MIME, '市占率结果_' + stampNow() + '.xlsx');
    logLine('已导出市占率结果 xlsx');
    toast('已导出市占率结果 xlsx（统计_类目 / 统计_尺寸段 / 统计_价格段 / 配对_n）', 'ok');
  } catch (e) {
    logLine('导出市占率结果失败：' + ((e && e.message) || e));
    toast('导出市占率结果失败：' + humanError(e), 'error');
  } finally {
    setBusy(false);
  }
}

function csvCell(value) {
  const s = String(value == null ? '' : value);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function exportCsv() {
  const { report, rows } = filteredMatchRows();
  if (!rows.length) {
    toast('当前筛选结果为空，没有可导出的明细', 'error');
    return;
  }
  const header = PAIR_EXPORT_HEADERS;
  const lines = [header.map(csvCell).join(',')];
  for (const item of rows) {
    lines.push(pairExportCells(report, item.row).map(csvCell).join(','));
  }
  downloadBlob('\uFEFF' + lines.join('\r\n'), 'text/csv;charset=utf-8', '配对明细_' + todayStamp() + '.csv');
  toast('已导出当前榜单筛选 CSV（' + rows.length + ' 行）', 'ok');
}

/** 导出「采样」列文案：N 次 / N 次（差 X 元） */
function rowReviewSampleText(row) {
  const count = row && row.sampleCount != null ? Number(row.sampleCount) : 0;
  if (!count) return '';
  const spread = row && row.sampleSpread != null ? Number(row.sampleSpread) : null;
  return spread != null && Number.isFinite(spread) && spread > 0 ? count + ' 次（差 ' + fmtNum(spread, 0) + ' 元）' : count + ' 次';
}

/** 导出「复核状态」列文案：需确认 / 已确认 / 一致 / — */
function rowReviewStateText(row) {
  if (reviewNeeded(row)) return REVIEW_TEXT;
  if (row && row.review && row.review.confirmed) return REVIEW_CONFIRMED_TEXT;
  if (row && row.sampleCount != null && Number(row.sampleCount) > 1) return '一致';
  return '';
}

/* ============================ 弹窗基础 ============================ */

function showDialog(dialog) {
  if (!dialog) return;
  if (typeof dialog.showModal === 'function') {
    try {
      if (!dialog.open) dialog.showModal();
    } catch (e) {
      dialog.setAttribute('open', '');
    }
  } else {
    dialog.setAttribute('open', '');
  }
}

function closeDialog(dialog) {
  if (!dialog) return;
  if (typeof dialog.close === 'function') {
    try { dialog.close(); } catch (e) { dialog.removeAttribute('open'); }
  } else {
    dialog.removeAttribute('open');
  }
}

let confirmResolver = null;
function confirmDialog(title, text) {
  return new Promise((resolve) => {
    if (!els.confirmDialog) {
      resolve(window.confirm(String(text == null ? '' : text)));
      return;
    }
    if (els.confirmTitle) els.confirmTitle.textContent = title || '确认';
    if (els.confirmText) els.confirmText.innerHTML = esc(text || '').replace(/\n/g, '<br>');
    confirmResolver = resolve;
    showDialog(els.confirmDialog);
  });
}

function settleConfirm(value) {
  const resolve = confirmResolver;
  confirmResolver = null;
  closeDialog(els.confirmDialog);
  if (resolve) resolve(value);
}

let promptResolver = null;
function promptDialog(title, label, defaultValue, hint) {
  return new Promise((resolve) => {
    if (!els.promptDialog) {
      resolve(window.prompt(String(label || ''), String(defaultValue == null ? '' : defaultValue)));
      return;
    }
    if (els.promptTitle) els.promptTitle.textContent = title || '输入';
    if (els.promptLabel) els.promptLabel.textContent = label || '名称';
    if (els.promptInput) els.promptInput.value = defaultValue == null ? '' : String(defaultValue);
    if (els.promptHint) els.promptHint.textContent = hint || '';
    promptResolver = resolve;
    showDialog(els.promptDialog);
    setTimeout(() => {
      try {
        if (els.promptInput) {
          els.promptInput.focus();
          els.promptInput.select();
        }
      } catch (e) { /* ignore */ }
    }, 30);
  });
}

function settlePrompt(value) {
  const resolve = promptResolver;
  promptResolver = null;
  closeDialog(els.promptDialog);
  if (resolve) resolve(value);
}

/* ============================ 事件绑定 ============================ */

function setEnvBadge() {
  if (!els.envBadge) return;
  els.envBadge.textContent = HAS_EXTENSION ? '扩展模式' : '预览模式 · 内存存储';
  els.envBadge.className = 'env-badge ' + (HAS_EXTENSION ? 'ext' : 'preview');
  els.envBadge.title = HAS_EXTENSION
    ? '正在 Edge 扩展环境中运行，数据保存到 chrome.storage.local（只存本机）'
    : '未检测到 chrome 扩展 API：数据只存在内存中，刷新后丢失（仅用于本地预览）';
  if (els.loadDemoBtn) els.loadDemoBtn.classList.toggle('hidden', HAS_EXTENSION || !lib.pipeline);
}

function bindEvents() {
  // 导航
  for (const btn of els.navBtns) {
    btn.addEventListener('click', () => navigate(btn.dataset.pageTarget));
  }

  // v2.1.6 快速人工定位 chip（工作台 + 总览；再点取消，与状态筛选联动）
  for (const chip of [els.quickReviewChip, els.quickNoSizeChip, els.quickNoPriceChip,
    els.overviewQuickReviewChip, els.overviewQuickNoSizeChip, els.overviewQuickNoPriceChip]) {
    if (!chip) continue;
    chip.addEventListener('click', () => {
      const filter = chip.getAttribute('data-quick-filter') || '';
      const scope = chip.getAttribute('data-quick-scope') === 'overview' ? 'overview' : 'match';
      if (filter) applyQuickFilter(scope, filter);
    });
  }

  // 主题切换（☀/🌙，持久化到 settings.ui.theme）
  if (els.themeToggleBtn) els.themeToggleBtn.addEventListener('click', () => toggleTheme());

  // KPI 卡片点击 → 切行筛选（已补齐 / 待补采 / 采集失败 / 待确认）
  if (els.kpiBar) {
    els.kpiBar.addEventListener('click', (e) => {
      const card = e.target.closest('.kpi.clickable[data-filter]');
      if (card) handleKpiClick(card.dataset.filter);
    });
  }
  // 导入后 KPI 紧凑摘要：点「明细」展开 / 收起 9 张卡片
  if (els.kpiDetailBtn) {
    els.kpiDetailBtn.addEventListener('click', () => {
      state.kpiExpanded = !state.kpiExpanded;
      renderKpis();
    });
  }

  // 导入榜单
  if (els.pickReportBtn) els.pickReportBtn.addEventListener('click', () => els.reportFileInput && els.reportFileInput.click());
  if (els.reportFileInput) {
    els.reportFileInput.addEventListener('change', async () => {
      const files = Array.from(els.reportFileInput.files || []);
      els.reportFileInput.value = '';
      if (files.length) await handleReportFiles(files);
    });
  }
  if (els.loadDemoBtn) els.loadDemoBtn.addEventListener('click', loadDemoReport);
  bindDragAndDrop();

  // 工作台工具条
  if (els.analyzeBtn) els.analyzeBtn.addEventListener('click', () => analyzeAll());
  if (els.captureBtn) els.captureBtn.addEventListener('click', () => startCapture({}));
  if (els.pauseBtn) els.pauseBtn.addEventListener('click', toggleCapturePause);
  if (els.stopBtn) els.stopBtn.addEventListener('click', stopCapture);
  if (els.diagnoseBtn) els.diagnoseBtn.addEventListener('click', () => openHeaderDialog());
  if (els.clearReportsBtn) els.clearReportsBtn.addEventListener('click', () => clearSession());

  // 导出菜单
  const exportActions = [
    [els.exportBackfillBtn, exportBackfill],
    [els.exportBackfillAllBtn, exportBackfillAll],
    [els.exportResultBtn, exportResult],
    [els.exportBackupBtn, exportBackup],
    [els.exportCsvBtn, exportCsv],
  ];
  for (const [btn, fn] of exportActions) {
    if (!btn) continue;
    btn.addEventListener('click', () => {
      if (els.exportMenu) els.exportMenu.open = false;
      fn();
    });
  }

  // 日志
  if (els.copyLogBtn) {
    els.copyLogBtn.addEventListener('click', () => copyText(state.capture.log.join('\n') || '暂无日志', '采集日志已复制'));
  }
  if (els.clearLogBtn) {
    els.clearLogBtn.addEventListener('click', () => {
      state.capture.log = [];
      if (els.logPanel) els.logPanel.textContent = '';
      renderCaptureUI();
    });
  }

  // 提醒条 / 引擎重试
  if (els.dismissBanner) {
    els.dismissBanner.addEventListener('click', () => {
      els.riskBanner.classList.add('hidden');
      state.settings.ui.bannerDismissed = true;
      markDirty('settings');
    });
  }
  for (const btn of [els.retryLibBtn, els.retryLibBtn2]) {
    if (!btn) continue;
    btn.addEventListener('click', () => location.reload());
  }

  // 榜单卡片
  if (els.reportCards) {
    els.reportCards.addEventListener('change', (e) => {
      const select = e.target.closest('select[data-act="bind-store"]');
      if (!select) return;
      const report = (state.session.reports || []).find((r) => r.id === select.dataset.reportId);
      if (!report) return;
      report.store = select.value;
      if (!report.store) report.storeScore = 0;
      markDirty('session');
      renderKpis();
      renderReports();
      toast(report.store ? '已绑定类目：' + report.store : '已取消类目绑定', 'ok');
    });
    els.reportCards.addEventListener('click', async (e) => {
      const removeBtn = e.target.closest('button[data-act="remove"]');
      if (removeBtn) {
        const id = removeBtn.dataset.reportId;
        const report = (state.session.reports || []).find((r) => r.id === id);
        if (!report) return;
        const ok = await confirmDialog('移除榜单', '确定从会话中移除「' + report.fileName + '」吗？\n\n匹配库与采集缓存不受影响，可重新导入。');
        if (!ok) return;
        state.session.reports = state.session.reports.filter((r) => r.id !== id);
        if (state.session.activeReportId === id) {
          state.session.activeReportId = (state.session.reports[0] && state.session.reports[0].id) || null;
        }
        state.statsStale = true;
        markDirty('session');
        renderAll();
        toast('已移除榜单：' + report.fileName, 'ok');
        return;
      }
      const card = e.target.closest('.report-card');
      if (card && card.dataset.reportId && !e.target.closest('select')) {
        state.session.activeReportId = card.dataset.reportId;
        markDirty('session');
        renderKpis();
        renderReports();
        renderMatchTable();
      }
    });
  }

  // 配对表筛选
  if (els.statusFilter) {
    els.statusFilter.addEventListener('change', () => {
      state.filter.status = els.statusFilter.value;
      state.filter.page = 1;
      if (ensureActiveReportForStatusFilter(state.filter.status)) renderReports();
      renderMatchTable();
      renderQuickFilters();
    });
  }
  if (els.searchInput) {
    let searchTimer = null;
    els.searchInput.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.filter.search = els.searchInput.value;
        state.filter.page = 1;
        renderMatchTable();
      }, 120);
    });
  }
  if (els.pageSize) {
    els.pageSize.addEventListener('change', () => {
      state.filter.pageSize = Number(els.pageSize.value) || 100;
      state.filter.page = 1;
      renderMatchTable();
    });
  }

  // 配对表行内交互
  if (els.matchBody) {
    els.matchBody.addEventListener('click', (e) => {
      const cell = e.target.closest('[data-act="edit-cell"]');
      if (cell) {
        openCellEditor(cell, 'match');
        return;
      }
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const report = activeReport();
      if (btn.dataset.act === 'debug-price') {
        openPriceDebug(String(btn.dataset.sku || ''));
        return;
      }
      if (btn.dataset.act === 'confirm-write') {
        const sku = String(btn.dataset.sku || '');
        const row = sku ? reportRows(report).find((r) => String(r.sku) === sku) : null;
        if (row) confirmLibraryWriteRows([{ row, report }]).catch((err) => logLine('确认写入异常：' + humanError(err)));
        return;
      }
      const index = Number(btn.dataset.index);
      const row = report && reportRows(report)[index];
      if (!row) return;
      if (btn.dataset.act === 'confirm-review') {
        if (confirmRowReview(row)) {
          state.session.updatedAt = nowIso();
          state.statsStale = true;
          renderAll();
          toast('已确认该行复核结果（状态回到「已补采」）', 'ok');
        }
      } else if (btn.dataset.act === 'recapture') {
        recaptureRows([row]);
      } else if (btn.dataset.act === 'edit') {
        const sizeCell = els.matchBody.querySelector('[data-act="edit-cell"][data-field="size"][data-index="' + index + '"]');
        if (sizeCell) openCellEditor(sizeCell, 'match');
      }
    });
  }

  // 批量确认当前筛选里的「需确认」行
  if (els.confirmReviewBtn) {
    els.confirmReviewBtn.addEventListener('click', () => confirmReviewRows(true));
  }

  // v2.1.4：批量确认写入匹配库（当前筛选内 libState=pending 的行）
  if (els.confirmWriteBtn) {
    els.confirmWriteBtn.addEventListener('click', () => {
      const items = pendingWriteRows();
      if (!items.length) {
        toast('当前筛选里没有待确认写入的行', 'error');
        return;
      }
      confirmLibraryWriteRows(items).catch((err) => logLine('批量确认写入异常：' + humanError(err)));
    });
  }

  // 统计看板：类目 tab / 品牌搜索 / 表头排序 / 打开该类目榜单
  if (els.statsStoreTabs) {
    els.statsStoreTabs.addEventListener('click', (e) => {
      const tab = e.target.closest('[data-store-tab]');
      if (!tab) return;
      const value = tab.dataset.storeTab === 'all' ? '' : tab.dataset.storeTab;
      state.statsStore = value;
      state.statsBrandSearch = '';
      if (els.statsBrandSearch) els.statsBrandSearch.value = '';
      renderStats();
    });
  }
  if (els.statsBrandSearch) {
    let statsSearchTimer = null;
    els.statsBrandSearch.addEventListener('input', () => {
      clearTimeout(statsSearchTimer);
      statsSearchTimer = setTimeout(() => {
        state.statsBrandSearch = els.statsBrandSearch.value;
        if (lib.pipeline && typeof lib.pipeline.computeStats === 'function' && (state.session.reports || []).length) {
          const filteredReports = state.statsStore
            ? state.session.reports.filter((r) => (r.store || '未绑定类目') === state.statsStore && reportRows(r).length)
            : state.session.reports.filter((r) => reportRows(r).length);
          const stats = computeStatsForView(filteredReports);
          if (stats) renderStoreStats(stats, state.statsStore);
        } else {
          renderStats();
        }
      }, 120);
    });
  }
  if (els.storeStats) {
    els.storeStats.addEventListener('click', (e) => {
      const th = e.target.closest('th[data-sort-field]');
      if (!th) return;
      const field = th.dataset.sortField;
      const sort = state.statsBrandSort || { field: 'amount', dir: 'desc' };
      if (sort.field === field) sort.dir = sort.dir === 'desc' ? 'asc' : 'desc';
      else { sort.field = field; sort.dir = field === 'brand' ? 'asc' : 'desc'; }
      state.statsBrandSort = sort;
      const filteredReports = state.statsStore
        ? (state.session.reports || []).filter((r) => (r.store || '未绑定类目') === state.statsStore && reportRows(r).length)
        : (state.session.reports || []).filter((r) => reportRows(r).length);
      const stats = computeStatsForView(filteredReports);
      if (stats) renderStoreStats(stats, state.statsStore);
    });
  }
  if (els.openStoreReportBtn) els.openStoreReportBtn.addEventListener('click', openStoreReport);

  // 匹配库页面
  if (els.libImportMergeBtn) els.libImportMergeBtn.addEventListener('click', () => pickLibraryFile('merge'));
  if (els.libImportReplaceBtn) els.libImportReplaceBtn.addEventListener('click', () => pickLibraryFile('replace'));
  if (els.libFileInput) {
    els.libFileInput.addEventListener('change', async () => {
      const file = (els.libFileInput.files || [])[0];
      els.libFileInput.value = '';
      if (file) await handleLibraryFile(file);
    });
  }
  if (els.libExportBtn) els.libExportBtn.addEventListener('click', exportLibraryXlsx);
  if (els.libNormalizeBtn) els.libNormalizeBtn.addEventListener('click', normalizeLibraryNow);
  if (els.libIssueBtn) els.libIssueBtn.addEventListener('click', checkLibraryIssues);
  if (els.addStoreBtn) els.addStoreBtn.addEventListener('click', addLibraryStore);
  if (els.closeLibReportBtn) {
    els.closeLibReportBtn.addEventListener('click', () => els.libReportPanel && els.libReportPanel.classList.add('hidden'));
  }
  if (els.libFilterSelect) {
    els.libFilterSelect.addEventListener('change', () => {
      state.libFilter.mode = els.libFilterSelect.value;
      state.libFilter.page = 1;
      renderLibraryTable();
    });
  }
  if (els.libSearchInput) {
    let libSearchTimer = null;
    els.libSearchInput.addEventListener('input', () => {
      clearTimeout(libSearchTimer);
      libSearchTimer = setTimeout(() => {
        state.libFilter.search = els.libSearchInput.value;
        state.libFilter.page = 1;
        renderLibraryTable();
      }, 140);
    });
  }
  if (els.libPageSize) {
    els.libPageSize.addEventListener('change', () => {
      state.libFilter.pageSize = Number(els.libPageSize.value) || 100;
      state.libFilter.page = 1;
      renderLibraryTable();
    });
  }
  if (els.libStoreList) {
    els.libStoreList.addEventListener('click', (e) => {
      const toolBtn = e.target.closest('button[data-store-act]');
      if (toolBtn) {
        const name = toolBtn.dataset.store;
        if (toolBtn.dataset.storeAct === 'rename') renameLibraryStore(name);
        else if (toolBtn.dataset.storeAct === 'delete') deleteLibraryStore(name);
        return;
      }
      // v2.1.7 修：勾选框/合并按钮点击不能触发「切换类目筛选」的整块重渲染，
      // 否则勾选状态会被 innerHTML 重建清掉（用户反馈无法勾选合并）。
      if (e.target.closest('.store-select') || e.target.closest('.store-bulk') || e.target.closest('#mergeStoresBtn')) return;
      const item = e.target.closest('.store-item');
      if (!item) return;
      state.libFilter.store = item.dataset.store || '';
      state.libFilter.page = 1;
      renderLibraryStores(getLibraryStats());
      renderLibraryTable();
    });
  }
  if (els.libBody) {
    els.libBody.addEventListener('click', (e) => {
      const cell = e.target.closest('[data-act="lib-edit-cell"]');
      if (cell) openCellEditor(cell, 'library');
    });
  }

  // 统计看板
  if (els.refreshStatsBtn) {
    els.refreshStatsBtn.addEventListener('click', () => {
      state.statsStale = true;
      ensureStats(true);
      renderStats();
      toast('统计已刷新', 'ok');
    });
  }
  if (els.statsExportBtn) els.statsExportBtn.addEventListener('click', exportResult);

  // 设置页面
  if (els.saveSettingsBtn) els.saveSettingsBtn.addEventListener('click', () => saveSettings());
  if (els.resetSettingsBtn) els.resetSettingsBtn.addEventListener('click', resetSettings);
  if (els.clearOverridesBtn) els.clearOverridesBtn.addEventListener('click', clearAllOverrides);
  if (els.overridesList) {
    els.overridesList.addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-override]');
      if (!btn) return;
      const name = btn.dataset.override;
      const ok = await confirmDialog('删除映射记忆', '确定删除「' + name + '」的表头映射记忆吗？\n\n下次导入该文件会重新自动识别。');
      if (!ok) return;
      delete state.settings.mapping.overrides[name];
      markDirty('settings');
      await flushSave('settings');
      renderOverrides();
      toast('已删除映射记忆', 'ok');
    });
  }
  if (els.exportBackupBtn2) els.exportBackupBtn2.addEventListener('click', exportBackup);
  if (els.importBackupBtn) els.importBackupBtn.addEventListener('click', pickBackupFile);
  if (els.backupFileInput) {
    els.backupFileInput.addEventListener('change', async () => {
      const file = (els.backupFileInput.files || [])[0];
      els.backupFileInput.value = '';
      if (file) await handleBackupFile(file);
    });
  }
  if (els.purgeCapturesBtn) els.purgeCapturesBtn.addEventListener('click', purgeCaptures);
  if (els.clearSessionBtn) els.clearSessionBtn.addEventListener('click', clearSession);
  if (els.copyDebugBtn) els.copyDebugBtn.addEventListener('click', copyDebug);
  // v2.1.7 候选价格调试
  if (els.copyLastCaptureDebugBtn) els.copyLastCaptureDebugBtn.addEventListener('click', () => { copyLastCaptureDebug().catch((e) => logLine('复制采集调试 JSON 失败：' + humanError(e))); });
  if (els.copyPriceDebugBtn) els.copyPriceDebugBtn.addEventListener('click', () => { copyPriceDebugJson().catch((e) => logLine('复制价格调试 JSON 失败：' + humanError(e))); });
  if (els.closePriceDebugBtn) els.closePriceDebugBtn.addEventListener('click', closePriceDebug);
  if (els.priceDebugDialog) els.priceDebugDialog.addEventListener('cancel', closePriceDebug);

  // 表头诊断弹窗
  if (els.headerDialogCancel) els.headerDialogCancel.addEventListener('click', () => closeDialog(els.headerDialog));
  if (els.headerDialogSave) els.headerDialogSave.addEventListener('click', () => saveHeaderDialog());
  if (els.headerDialog) {
    els.headerDialog.addEventListener('cancel', () => {
      state.headerCtx = null;
    });
  }
  if (els.headerMapping) {
    els.headerMapping.addEventListener('change', (e) => {
      const ctx = state.headerCtx;
      if (!ctx) return;
      if (e.target.matches('[data-map-header]')) {
        for (const select of els.headerMapping.querySelectorAll('[data-map]')) {
          const field = select.dataset.map;
          if (field in ctx.selections) ctx.selections[field] = parseInt(select.value, 10);
        }
        ctx.headerRow = parseInt(e.target.value, 10) || 0;
        renderHeaderPreview();
        renderHeaderMapping();
      } else if (e.target.matches('[data-map]')) {
        ctx.selections[e.target.dataset.map] = parseInt(e.target.value, 10);
      }
    });
  }

  // 通用确认 / 输入弹窗
  if (els.confirmOk) els.confirmOk.addEventListener('click', () => settleConfirm(true));
  if (els.confirmCancel) els.confirmCancel.addEventListener('click', () => settleConfirm(false));
  if (els.confirmDialog) {
    els.confirmDialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      settleConfirm(false);
    });
  }
  if (els.promptOk) els.promptOk.addEventListener('click', () => settlePrompt(els.promptInput ? els.promptInput.value : ''));
  if (els.promptCancel) els.promptCancel.addEventListener('click', () => settlePrompt(null));
  if (els.promptDialog) {
    els.promptDialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      settlePrompt(null);
    });
  }
  if (els.promptInput) {
    els.promptInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); settlePrompt(els.promptInput.value); }
      else if (e.key === 'Escape') { e.preventDefault(); settlePrompt(null); }
    });
  }

  // 导出菜单收起
  document.addEventListener('click', (e) => {
    if (els.exportMenu && els.exportMenu.open && !els.exportMenu.contains(e.target)) els.exportMenu.open = false;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && els.exportMenu) els.exportMenu.open = false;
  });
  // DESIGN 18.3：导出下拉 fixed 定位（打开时、窗口缩放、页面滚动都重新 clamp）
  if (els.exportMenu) {
    els.exportMenu.addEventListener('toggle', () => {
      if (!els.exportMenu.open) return;
      positionExportMenu();
      // 展开动画/布局稳定后再算一次，避免 offsetHeight 首次为 0
      try {
        if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(() => positionExportMenu());
        else setTimeout(() => positionExportMenu(), 0);
      } catch (e) { /* ignore */ }
    });
  }
  window.addEventListener('resize', () => { if (els.exportMenu && els.exportMenu.open) positionExportMenu(); });
  window.addEventListener('scroll', () => { if (els.exportMenu && els.exportMenu.open) positionExportMenu(); }, { capture: true, passive: true });

  // DESIGN 18.3：导入区折叠 / 展开
  if (els.expandImportBtn) {
    els.expandImportBtn.addEventListener('click', () => {
      state.importExpanded = true;
      if (els.reportsDetails) els.reportsDetails.open = true;
      renderReports();
    });
  }
  if (els.collapseImportBtn) {
    els.collapseImportBtn.addEventListener('click', () => {
      state.importExpanded = false;
      renderReports();
    });
  }
  // 进度/日志面板折叠
  if (els.toggleProgressBtn) {
    els.toggleProgressBtn.addEventListener('click', () => {
      if (!els.progressPanel) return;
      const collapsed = els.progressPanel.classList.toggle('collapsed');
      els.toggleProgressBtn.textContent = collapsed ? '展开' : '收起';
    });
  }

  // 配对总览页事件
  bindOverviewEvents();

  // v2.1.4：预览人工读数 / 风控告警 / 内置库重置按钮
  bindPreviewReadEvents();
  // v2.1.5：列设置 / 表头筛选 / 列悬停 / 异常等待 / 匹配库日志与类目合并
  bindTableEnhancementEvents();

  // 采集进行中离开页面提醒；离开前尽量把未落盘的主题/设置/会话刷掉
  window.addEventListener('beforeunload', (e) => {
    if (state.capture.running) {
      e.preventDefault();
      e.returnValue = '';
    }
    // DESIGN 17.1：页面关闭时关闭预览 popup（不 await，尽力而为）
    try { closePreviewQuietly('关闭工作台'); } catch (err) { /* ignore */ }
    flushAllSaves().catch(() => { /* ignore */ });
  });
}

/** DESIGN 18.3：导出下拉定位（fixed + 视口 clamp：右半屏右对齐 / 左半屏左对齐，下方不足向上弹） */
function positionExportMenu() {
  if (!els.exportMenu) return;
  let list = null;
  try { list = els.exportMenu.querySelector('.menu-list'); } catch (e) { list = null; }
  if (!list) return;
  let anchor = els.exportMenu;
  try { anchor = els.exportMenu.querySelector('summary') || els.exportMenu; } catch (e) { anchor = els.exportMenu; }
  let rect = null;
  try { rect = anchor.getBoundingClientRect(); } catch (e) { rect = null; }
  if (!rect) return;
  const vw = Number(window.innerWidth) || 1344;
  const vh = Number(window.innerHeight) || 756;
  const listW = Math.max(210, Number(list.offsetWidth) || 0);
  const listH = Math.max(160, Number(list.offsetHeight) || 0);
  const margin = 8;
  let left;
  if (rect.left < vw / 2) {
    // 按钮在左半屏：菜单左对齐按钮
    left = rect.left;
  } else {
    // 按钮在右半屏：菜单右对齐按钮
    left = rect.right - listW;
  }
  left = Math.max(margin, Math.min(left, Math.max(margin, vw - listW - margin)));
  let top = rect.bottom + 6;
  if (top + listH > vh - margin) top = rect.top - listH - 6;
  top = Math.max(margin, Math.min(top, Math.max(margin, vh - listH - margin)));
  list.style.position = 'fixed';
  list.style.left = Math.round(left) + 'px';
  list.style.top = Math.round(top) + 'px';
  list.style.right = 'auto';
  list.style.bottom = 'auto';
  list.style.minWidth = '210px';
}

/** v2.1.3 迁移：清理旧版「标题推测套餐」（DESIGN 18.4/18.5；lib 未就绪则下次再试） */
async function runV213Migration() {
  try {
    if (state.settings && state.settings.ui && state.settings.ui.migratedV213) return 0;
    if (!lib.pipeline || typeof lib.pipeline.migrateLegacyPackages !== 'function') return 0;
    // DESIGN 18.5：迁移前把旧 session 快照写入 backup_v213，便于出问题时恢复
    try {
      await storageSet({ backup_v213: serializeSession() });
    } catch (e) { /* 快照失败不阻塞迁移 */ }
    const result = lib.pipeline.migrateLegacyPackages(state.session.reports || []);
    const count = Number(result) || 0;
    state.settings.ui = state.settings.ui || {};
    state.settings.ui.migratedV213 = true;
    markDirty('settings');
    if (count > 0) {
      state.session.updatedAt = nowIso();
      markDirty('session');
      state.statsStale = true;
      logLine('v2.1.3 迁移：已清理 ' + count + ' 条旧版标题推测套餐（补采后按页面选项重新填充）');
      toast('已清理 ' + count + ' 条旧版标题推测套餐（补采后按页面选项重新填充）', 'ok');
    } else {
      logLine('v2.1.3 迁移：没有需要清理的旧版标题推测套餐');
    }
    // 迁移结果立即落盘，避免用户迁移后马上刷新导致 flag/清理结果丢失
    try {
      await flushSave('settings');
      if (count > 0) await flushSave('session');
    } catch (e) { /* 保存失败由上层状态提示 */ }
    return count;
  } catch (e) {
    logLine('v2.1.3 迁移失败（已跳过）：' + humanError(e));
    return 0;
  }
}

/* ============================ v2.1.4 内置匹配库迁移（DESIGN §19.4） ============================ */

function renderSeedVersionText() {
  if (!els.seedVersionText) return;
  const ui = state.settings.ui || {};
  const meta = (state.library && state.library.meta) || {};
  const current = meta.fingerprint || meta.schemaVersion || '—';
  const parts = [];
  if (ui.seedVersion) parts.push('settings 记录 ' + ui.seedVersion);
  parts.push('当前库 ' + current);
  parts.push(fmtNum(countLibraryRows(state.library), 0) + ' SKU');
  els.seedVersionText.textContent = '内置匹配库版本：' + parts.join(' · ');
}

/* ============================ v2.1.4 频控应对（DESIGN §19.3） ============================ */

function cooldownUntilMs() {
  const raw = state.settings && state.settings.capture ? state.settings.capture.cooldownUntil : '';
  const t = raw ? Date.parse(raw) : NaN;
  return isFinite(t) ? t : 0;
}

/** Debug/UI：当前风控与冷却状态 */
function getRiskState() {
  const until = Math.max(cooldownUntilMs(), Number(state.capture.cooldownUntil) || 0);
  const remaining = Math.max(0, until - Date.now());
  const cap = state.settings.capture || {};
  return {
    active: remaining > 0,
    cooldownUntil: until ? new Date(until).toISOString() : '',
    remainingSec: Math.ceil(remaining / 1000),
    lastRisk: state.capture.lastRisk || null,
    cooldownMinutes: Number(cap.cooldownMinutes) || 60,
    maxBatch: Math.max(5, Math.min(100, Math.floor(Number(cap.maxBatch != null ? cap.maxBatch : cap.batchLimit) || 20))),
    batchLimit: Math.max(5, Math.min(100, Math.floor(Number(cap.maxBatch != null ? cap.maxBatch : cap.batchLimit) || 20))),
    anomalyWaitSec: (() => { const n = Number(cap.anomalyWaitSec); return isFinite(n) ? Math.max(0, Math.min(600, Math.floor(n))) : 60; })(),
    interval: [Number(cap.delayMin) || 5, Number(cap.delayMax) || 10],
    autoPauseOnRisk: cap.autoPauseOnRisk !== false,
  };
}
function ensureRiskTicker() {
  if (state.capture.riskTimer) return;
  const tick = () => {
    const st = getRiskState();
    if (!st.active) {
      clearRiskTicker();
      renderRiskAlert();
      toast('风控冷却结束，可以重新补采（建议先小批量验证 3~5 个 SKU）', 'ok');
      return;
    }
    renderRiskAlert();
  };
  try { state.capture.riskTimer = setInterval(tick, 1000); } catch (e) { /* ignore */ }
}

function clearRiskTicker() {
  if (!state.capture.riskTimer) return;
  try { clearInterval(state.capture.riskTimer); } catch (e) { /* ignore */ }
  state.capture.riskTimer = null;
}

function updateCaptureButtonState() {
  if (!els.captureBtn) return;
  const st = getRiskState();
  if (st.active) {
    els.captureBtn.disabled = true;
    els.captureBtn.title = '风控冷却中（剩余 ' + st.remainingSec + ' 秒），请换账号/网络或降低频率';
    return;
  }
  if (!state.capture.running && !state.busy) {
    els.captureBtn.disabled = false;
    els.captureBtn.title = '后台打开 item.shop.example.com 商品页读取价格与尺寸（每批 ' + st.batchLimit + '、间隔 ' + st.interval[0] + '~' + st.interval[1] + ' 秒）';
  } else {
    els.captureBtn.disabled = true;
  }
}

/** 风控告警横幅（含冷却倒计时 + 建议） */
function renderRiskAlert() {
  const st = getRiskState();
  if (!els.riskAlert) return;
  if (!st.active) {
    els.riskAlert.classList.add('hidden');
    updateCaptureButtonState();
    return;
  }
  els.riskAlert.classList.remove('hidden');
  const remain = st.remainingSec;
  const mm = String(Math.floor(remain / 60)).padStart(2, '0');
  const ss = String(remain % 60).padStart(2, '0');
  if (els.riskAlertTitle) {
    els.riskAlertTitle.textContent = '已触发电商平台风控，已自动暂停补采（冷却 ' + st.cooldownMinutes + ' 分钟）';
  }
  if (els.riskAlertText) {
    els.riskAlertText.textContent = '冷却中 ' + mm + ':' + ss +
      ' · 建议：换电商平台账号 / 换网络（手机热点）/ 降低频率（每批 ≤10、间隔 ≥10s）/ 或用小眼睛预览人工核对（逐条低频）';
  }
  if (state.capture.riskAlertDismissed) els.riskAlert.classList.add('hidden');
  ensureRiskTicker();
  updateCaptureButtonState();
}

/** 开始冷却（风控命中） */
function startCooldown(minutes, risk) {
  const mins = Math.max(1, Math.min(1440, Math.floor(Number(minutes) || 60)));
  const until = Date.now() + mins * 60000;
  state.capture.cooldownUntil = until;
  state.capture.lastRisk = risk || state.capture.lastRisk || { hit: true, reason: '电商平台风控', at: nowIso() };
  state.settings.capture = state.settings.capture || {};
  state.settings.capture.cooldownUntil = new Date(until).toISOString();
  markDirty('settings');
  logLine('触发风控冷却：' + mins + ' 分钟（至 ' + fmtTime(new Date(until).toISOString()) + '）');
  toast('已触发电商平台风控：自动暂停并冷却 ' + mins + ' 分钟，请换账号/网络或改用预览人工读数', 'error');
  renderRiskAlert();
  renderCaptureUI();
}

function clearCooldown() {
  clearRiskTicker();
  state.capture.cooldownUntil = 0;
  state.capture.lastRisk = null;
  if (state.settings.capture) state.settings.capture.cooldownUntil = '';
  markDirty('settings');
  renderRiskAlert();
  renderCaptureUI();
}

/** 从采集结果 / 进度 / 汇总里提取风控信息 */
function riskFromCapturePayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const candidates = [payload.risk, payload.result && payload.result.risk, payload.progress && payload.progress.risk];
  for (const risk of candidates) {
    if (risk && (risk.hit === true || risk.hit === 'true' || risk.hit === 1)) return risk;
  }
  return null;
}

function handleCaptureRisk(risk) {
  if (!risk) return;
  const existing = getRiskState();
  if (existing.active) {
    // 冷却已生效：只保证采集暂停，不重复延长冷却时间
    if (state.capture.running && !state.capture.pausedFlag) {
      try { toggleCapturePause(); } catch (e) { /* ignore */ }
    }
    renderRiskAlert();
    return;
  }
  const cap = state.settings.capture || {};
  if (cap.autoPauseOnRisk === false) {
    logLine('检测到电商平台风控（自动暂停已关闭）：' + (risk.reason || risk.url || ''));
    toast('检测到电商平台风控：建议立即暂停并换账号/网络', 'error');
    renderRiskAlert();
    return;
  }
  if (state.capture.running) {
    try { toggleCapturePause(); } catch (e) { /* ignore */ }
  }
  startCooldown(cap.cooldownMinutes || 60, risk);
}

/* ============================ v2.1.4 预览人工读数（DESIGN §19.3） ============================ */

const PREVIEW_READ_TIMEOUT = 8000;

function previewTabId() {
  return Number(previewState.tabId) || 0;
}

function fmtPreviewSnapshotText(snap) {
  if (!snap) return '预览读数：—';
  const parts = [];
  if (snap.sku) parts.push('SKU ' + snap.sku);
  if (snap.price != null && isFinite(Number(snap.price))) parts.push('到手价 ¥' + fmtPlainNum(snap.price));
  else if (snap.prices && snap.prices.hand != null) parts.push('到手价 ¥' + fmtPlainNum(snap.prices.hand));
  if (snap.sizeText) parts.push(snap.sizeText);
  if (snap.package) parts.push(snap.package);
  if (snap.model) parts.push('型号 ' + snap.model);
  return '预览读数：' + (parts.length ? parts.join(' · ') : '未读到有效数据');
}

function normalizePreviewSnapshot(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const snap = Object.assign({}, raw);
  const prices = snap.prices && typeof snap.prices === 'object' ? snap.prices : {};
  if (snap.price == null) {
    if (prices.hand != null) snap.price = Number(prices.hand);
    else if (prices.main != null) snap.price = Number(prices.main);
    else if (prices.plus != null) snap.price = Number(prices.plus);
  }
  if (snap.price != null && !isFinite(Number(snap.price))) snap.price = null;
  snap.prices = prices;
  return snap;
}

function showPreviewRead(sku, rawSnapshot) {
  if (Date.now() < (previewState.readSuppressUntil || 0)) return; // 已采用/忽略，忽略迟到的重复读数
  const snap = normalizePreviewSnapshot(rawSnapshot);
  if (!snap) return;
  state.capture.previewRead = { sku: String(sku || snap.sku || ''), snapshot: snap, at: nowIso() };
  if (els.previewReadBar) {
    els.previewReadBar.classList.remove('hidden');
    els.previewReadBar.classList.remove('warn');
  }
  if (els.previewReadText) els.previewReadText.textContent = fmtPreviewSnapshotText(Object.assign({ sku: sku || snap.sku }, snap));
  logLine('预览读数：' + ((els.previewReadText && els.previewReadText.textContent) || ''));
}

function hidePreviewRead() {
  state.capture.previewRead = null;
  previewState.readSuppressUntil = Date.now() + 2500; // 抑制迟到的重复读数
  if (els.previewReadBar) els.previewReadBar.classList.add('hidden');
}

/** 对预览窗口所在标签页请求一次快照（content.js 的 PREVIEW_CAPTURE handler） */
function requestPreviewCapture(sku, opts) {
  const options = opts || {};
  return new Promise((resolve) => {
    const tabId = previewTabId();
    if (!(HAS_CHROME && chrome.tabs && typeof chrome.tabs.sendMessage === 'function') || !tabId) {
      if (!options.silent) toast('预览页未就绪：无法读取商品页，请重新打开预览', 'error');
      resolve(null);
      return;
    }
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      if (!options.silent) toast('预览页未就绪：商品页加载超时，请稍后重试', 'error');
      resolve(null);
    }, Number(options.timeoutMs) || 6000);
    try {
      chrome.tabs.sendMessage(tabId, { type: 'PREVIEW_CAPTURE' }, (resp) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        const err = chrome.runtime && chrome.runtime.lastError;
        if (err) {
          if (!options.silent) toast('预览页未就绪：' + (err.message || '无法读取商品页'), 'error');
          resolve(null);
          return;
        }
        // 兼容 jd-capture 的多种回包形状：{snapshot}/{capture}/{result}/直接快照字段
        let rawSnapshot = null;
        if (resp && typeof resp === 'object') {
          if (resp.ok === false) rawSnapshot = null;
          else if (resp.snapshot) rawSnapshot = resp.snapshot;
          else if (resp.capture) rawSnapshot = resp.capture;
          else if (resp.result && typeof resp.result === 'object') rawSnapshot = resp.result;
          else if (resp.price != null || (resp.prices && (resp.prices.hand != null || resp.prices.main != null))) rawSnapshot = resp;
        }
        const snapshot = rawSnapshot ? normalizePreviewSnapshot(rawSnapshot) : null;
        if (!snapshot) {
          if (!options.silent) toast('预览页未就绪：请等商品页加载完成后再试', 'error');
          resolve(null);
          return;
        }
        const cleanSku = String(sku || snapshot.sku || '').trim();
        showPreviewRead(cleanSku, Object.assign({ sku: cleanSku }, snapshot));
        resolve(snapshot);
      });
    } catch (e) {
      clearTimeout(timer);
      if (!options.silent) toast('预览页未就绪：' + humanError(e), 'error');
      resolve(null);
    }
  });
}

/** 预览窗口打开后自动请求一次读数（优先等 tab 加载完成） */
function schedulePreviewRead(sku) {
  if (!canPreview()) return;
  const tabId = previewTabId();
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    requestPreviewCapture(sku, { silent: true }).catch(() => { /* ignore */ });
  };
  try {
    if (tabId && chrome.tabs && chrome.tabs.onUpdated && typeof chrome.tabs.onUpdated.addListener === 'function') {
      const listener = (id, info) => {
        if (id !== tabId) return;
        if (!info || info.status !== 'complete') return;
        try { chrome.tabs.onUpdated.removeListener(listener); } catch (e) { /* ignore */ }
        run();
      };
      chrome.tabs.onUpdated.addListener(listener);
      setTimeout(() => {
        try { chrome.tabs.onUpdated.removeListener(listener); } catch (e) { /* ignore */ }
        run();
      }, PREVIEW_READ_TIMEOUT);
      return;
    }
  } catch (e) { /* 退化到定时请求 */ }
  setTimeout(run, 2500);
}

/** 把预览读数按普通采集结果写回行（page 来源，仍为 pending，不写库） */
function applyPreviewReadToRow() {
  const read = state.capture.previewRead;
  if (!read || !read.snapshot) {
    toast('没有可采用的预览读数', 'error');
    return { ok: false, reason: '没有读数' };
  }
  const sku = String(read.sku || read.snapshot.sku || '');
  const snap = read.snapshot;
  if (!sku) return { ok: false, reason: '缺少 SKU' };
  let target = null;
  for (const report of state.session.reports || []) {
    const row = reportRows(report).find((r) => String(r.sku) === sku);
    if (row) { target = row; break; }
  }
  if (!target) {
    toast('当前榜单里找不到 SKU ' + sku + '，无法采用该读数', 'error');
    return { ok: false, reason: '找不到行' };
  }
  if (snap.price == null) {
    toast('预览读数里没有价格，无法采用（请等商品页加载完成后重试）', 'error');
    return { ok: false, reason: '没有价格' };
  }
  const at = nowIso();
  const record = {
    sku,
    at,
    price: Number(snap.price),
    priceKind: snap.priceKind || 'hand',
    prices: Object.assign({}, snap.prices, snap.prices && snap.prices.hand == null ? { hand: Number(snap.price) } : {}),
    samples: [{ price: Number(snap.price), kind: snap.priceKind || 'hand', at, source: '预览' }],
    spread: 0,
    consistent: true,
    sizeText: snap.sizeText || '',
    sizeInch: snap.sizeInch != null ? Number(snap.sizeInch) : undefined,
    model: snap.model || '',
    package: snap.package || '',
    candidateCount: 1,
    source: '预览人工读数',
  };
  try {
    const res = simulateCaptures({ [sku]: record });
    hidePreviewRead();
    invalidateLibraryStates();
    renderAll();
    toast('已采用预览读数（SKU ' + sku + '），仍需点「确认写入匹配库」才写库', 'ok');
    logLine('已采用预览人工读数：' + sku + ' 价格 ' + fmtPlainNum(record.price));
    return { ok: true, updated: (res && res.updated) || 0, sku };
  } catch (e) {
    logLine('采用预览读数失败：' + humanError(e));
    toast('采用预览读数失败：' + humanError(e), 'error');
    return { ok: false, reason: humanError(e) };
  }
}

async function previewRead(sku) {
  const cleanSku = String(sku == null ? '' : sku).trim();
  if (!cleanSku) return null;
  if (!canPreview()) {
    toast('预览读数需要在 Edge 插件内使用', 'error');
    return null;
  }
  if (previewState.winId == null || previewState.sku !== cleanSku) {
    const opened = await previewSku(cleanSku, { pinned: true });
    if (!opened) return null;
  }
  return requestPreviewCapture(cleanSku, { silent: false });
}

function bindPreviewReadEvents() {
  if (els.previewApplyBtn) {
    els.previewApplyBtn.addEventListener('click', () => applyPreviewReadToRow());
  }
  if (els.previewIgnoreBtn) {
    els.previewIgnoreBtn.addEventListener('click', () => {
      hidePreviewRead();
      toast('已忽略本次预览读数', 'ok');
    });
  }
  if (els.dismissRiskAlert) {
    els.dismissRiskAlert.addEventListener('click', () => {
      // 只收起横幅提示，冷却仍生效（补采保持禁用），下次冷却触发会重新显示
      state.capture.riskAlertDismissed = true;
      if (els.riskAlert) els.riskAlert.classList.add('hidden');
    });
  }
  if (els.resetSeedBtn) {
    els.resetSeedBtn.addEventListener('click', () => { resetSeedLibrary().catch((e) => logLine('重置匹配库失败：' + humanError(e))); });
  }
}

/* ============================ v2.1.5 匹配库保护（DESIGN 20.11） ============================ */

const LIBRARY_BACKUP_KEY = 'libraryBackup_v215';

function snapshotLibraryForBackup(reason) {
  try {
    return {
      at: nowIso(),
      reason: reason || '',
      version: APP_VERSION,
      library: JSON.parse(JSON.stringify(state.library || {})),
    };
  } catch (e) {
    return null;
  }
}

async function writeLibraryBackupV215(reason, opts) {
  const snap = snapshotLibraryForBackup(reason);
  if (!snap) return null;
  try {
    await storageSet({ [LIBRARY_BACKUP_KEY]: snap });
    state.libraryBackup = snap;
    state.settings.ui = state.settings.ui || {};
    state.settings.ui.libraryBackupV215At = snap.at;
    markDirty('settings');
    renderLibraryBackupInfo();
    return snap;
  } catch (e) {
    logLine('匹配库保护备份失败（不阻塞）：' + humanError(e));
    return null;
  }
}

async function loadLibraryBackupMeta() {
  try {
    const got = await storageGet([LIBRARY_BACKUP_KEY]);
    const snap = got && got[LIBRARY_BACKUP_KEY];
    state.libraryBackup = snap && snap.library ? snap : null;
  } catch (e) {
    state.libraryBackup = null;
  }
  renderLibraryBackupInfo();
}

function renderLibraryBackupInfo() {
  if (!els.libraryBackupText) return;
  const snap = state.libraryBackup;
  const at = (snap && snap.at) || (state.settings.ui && state.settings.ui.libraryBackupV215At) || '';
  const rows = snap && snap.library ? countLibraryRows(snap.library) : 0;
  els.libraryBackupText.textContent = at
    ? '匹配库保护备份：' + fmtTime(at) + (rows ? '（' + fmtNum(rows, 0) + ' 条记录）' : '') + ' · 可点下方「从备份恢复匹配库」还原'
    : '匹配库保护备份：尚未创建（升级首次启动 / 合并类目 / 重置前会自动备份）';
  if (els.restoreLibraryBackupBtn) els.restoreLibraryBackupBtn.disabled = !snap;
}

/** 升级首次启动写 libraryBackup_v215 快照（不覆盖用户库，失败不阻塞） */
async function ensureLibraryBackupV215(force) {
  if (state.libraryBackup && !force) {
    renderLibraryBackupInfo();
    return state.libraryBackup;
  }
  const snap = await writeLibraryBackupV215(force ? '手动刷新匹配库快照' : 'v2.1.5 升级自动快照');
  if (!snap) return null;
  if (!force) {
    toast('已备份当前匹配库（libraryBackup_v215，' + fmtTime(snap.at) + '），本次升级不会覆盖你的库', 'ok');
    logLine('v2.1.5 匹配库保护：已写入快照 libraryBackup_v215（' + countLibraryRows(state.library) + ' 条）');
  }
  return snap;
}

async function restoreLibraryBackupV215() {
  const snap = state.libraryBackup;
  if (!snap || !snap.library) {
    toast('没有可用的匹配库备份（libraryBackup_v215）', 'error');
    return { ok: false };
  }
  const beforeRows = countLibraryRows(state.library);
  const ok = await confirmDialog('从备份恢复匹配库',
    '将用 ' + fmtTime(snap.at) + ' 的备份（' + fmtNum(countLibraryRows(snap.library), 0) + ' 条记录）覆盖当前匹配库（' + fmtNum(beforeRows, 0) + ' 条）。\n\n当前库会先写入临时快照，恢复动作会记录到操作日志。确定恢复？');
  if (!ok) return { ok: false };
  try {
    await storageSet({ libraryBackup_v215_current: snapshotLibraryForBackup('恢复前当前库') });
  } catch (e) { /* 忽略 */ }
  state.library = normalizeLibraryShape(JSON.parse(JSON.stringify(snap.library)));
  appendUiLibraryLog({ action: 'restore-backup', store: '', sku: '', field: '', before: String(beforeRows), after: String(countLibraryRows(state.library)), source: '备份', note: '从 libraryBackup_v215 恢复（' + snap.at + '）' });
  markDirty('library');
  state.statsStale = true;
  invalidateLibraryStates();
  renderAll();
  toast('已从备份恢复匹配库（' + fmtNum(countLibraryRows(state.library), 0) + ' 条记录）', 'ok');
  logLine('匹配库已从备份恢复：' + snap.at);
  return { ok: true, rows: countLibraryRows(state.library), snapshotRows: countLibraryRows(snap.library) };
}

/* ============================ v2.1.5 匹配库操作日志（DESIGN 20.10） ============================ */

const LIBRARY_LOG_ACTION_LABELS = {
  confirm: '确认写入',
  'manual-edit': '手动编辑',
  'import-merge': '导入合并',
  'import-replace': '导入覆盖',
  normalize: '归一化',
  'seed-migrate': '种子迁移',
  'add-store': '新增类目',
  'delete-store': '删除类目',
  'reset-seed': '重置内置库',
  'restore-backup': '备份恢复',
  'merge-stores': '合并类目',
  'dedupe-store': '类目去重',
};

function hasLibLibraryLog() {
  return !!(lib.storeSchema && typeof lib.storeSchema.appendLibraryLog === 'function' && typeof lib.storeSchema.libraryLogRows === 'function');
}

function libraryLogActionLabel(action) {
  if (lib.storeSchema && lib.storeSchema.LIBRARY_LOG_ACTIONS && lib.storeSchema.LIBRARY_LOG_ACTIONS[action]) {
    return lib.storeSchema.LIBRARY_LOG_ACTIONS[action];
  }
  return LIBRARY_LOG_ACTION_LABELS[action] || action || '—';
}

function libraryLogActionText(row) {
  if (!row) return '—';
  const known = libraryLogActionLabel(row.action);
  return known !== row.action ? known : (row.actionText || known);
}

/** 写一条匹配库操作日志：lib 就绪用 lib.appendLibraryLog，否则前端兜底写 meta.logs（上限 500） */
function appendUiLibraryLog(entry) {
  const record = Object.assign({
    at: nowIso(),
    action: 'manual-edit',
    store: '',
    sku: '',
    field: '',
    before: '',
    after: '',
    source: '工作台',
    note: '',
  }, entry || {});
  try {
    if (lib.storeSchema && typeof lib.storeSchema.appendLibraryLog === 'function') {
      lib.storeSchema.appendLibraryLog(state.library, record);
      markDirty('library');
      return true;
    }
  } catch (e) {
    logLine('写匹配库日志失败（改用兜底）：' + humanError(e));
  }
  state.library.meta = state.library.meta || {};
  const logs = Array.isArray(state.library.meta.logs) ? state.library.meta.logs : [];
  logs.unshift(record);
  state.library.meta.logs = logs.slice(0, 500);
  markDirty('library');
  return true;
}

function libraryLogRowsForUi() {
  try {
    if (lib.storeSchema && typeof lib.storeSchema.libraryLogRows === 'function') {
      const rows = lib.storeSchema.libraryLogRows(state.library);
      if (Array.isArray(rows)) return rows;
    }
  } catch (e) {
    logLine('读取匹配库日志失败（改用兜底）：' + humanError(e));
  }
  const logs = (state.library && state.library.meta && state.library.meta.logs) || [];
  return logs.slice().reverse().map((entry) => Object.assign({}, entry, {
    actionText: libraryLogActionLabel(entry.action),
  }));
}

function renderLibraryLog() {
  if (!els.libLogList) return;
  const rows = libraryLogRowsForUi();
  const q = String((els.libLogSearch && els.libLogSearch.value) || '').trim().toLowerCase();
  const filtered = q ? rows.filter((row) => {
    const hay = [row.sku, row.store, row.action, row.actionText, row.field, row.before, row.after, row.source, row.note].join(' ').toLowerCase();
    return hay.indexOf(q) >= 0;
  }) : rows;
  if (els.libLogCount) els.libLogCount.textContent = String(filtered.length);
  if (!filtered.length) {
    els.libLogList.innerHTML = '<div class="empty-mini">' + (rows.length ? '没有匹配搜索条件的日志。' : '暂无写库操作日志。') + '</div>';
    return;
  }
  const head = '<div class="lib-log-head"><span>时间</span><span>类型</span><span>类目</span><span>SKU</span><span>字段变化</span><span>来源</span></div>';
  const body = filtered.slice(0, 300).map((row) => {
    const change = [row.field, (row.before ? row.before + ' → ' : '') + (row.after || '')].filter(Boolean).join(' ') || row.note || '—';
    return '<div class="lib-log-row">' +
      '<span class="log-time">' + esc(fmtTime(row.at)) + '</span>' +
      '<span class="log-action">' + esc(libraryLogActionText(row)) + '</span>' +
      '<span class="log-store" title="' + esc(row.store || '') + '">' + esc(row.store || '—') + '</span>' +
      '<span class="log-sku" title="' + esc(row.sku || '') + '">' + esc(row.sku || '—') + '</span>' +
      '<span class="log-change" title="' + esc((row.field || '') + ' ' + (row.before || '') + ' → ' + (row.after || '') + ' ' + (row.note || '')) + '">' + esc(change) + '</span>' +
      '<span class="log-source" title="' + esc(row.source || row.note || '') + '">' + esc(row.source || row.note || '—') + '</span>' +
    '</div>';
  }).join('');
  els.libLogList.innerHTML = head + body;
}

function openLibraryLog() {
  if (!els.libLogPanel) return;
  els.libLogPanel.classList.remove('hidden');
  renderLibraryLog();
  state.libLogOpen = true;
  if (els.libLogSearch) setTimeout(() => { try { els.libLogSearch.focus(); } catch (e) { /* ignore */ } }, 0);
}

function closeLibraryLog() {
  if (els.libLogPanel) els.libLogPanel.classList.add('hidden');
  state.libLogOpen = false;
}

function exportLibraryLogCsv() {
  const rows = libraryLogRowsForUi();
  if (!rows.length) {
    toast('没有可导出的操作日志', 'error');
    return;
  }
  const header = ['时间', '类型', '类目', 'SKU', '字段', '原值', '新值', '来源', '备注'];
  const lines = [header.map(csvCell).join(',')];
  for (const row of rows) {
    lines.push([
      row.at || '',
      libraryLogActionText(row),
      row.store || '',
      row.sku || '',
      row.field || '',
      row.before || '',
      row.after || '',
      row.source || '',
      row.note || '',
    ].map(csvCell).join(','));
  }
  downloadBlob('\uFEFF' + lines.join('\r\n'), 'text/csv;charset=utf-8', '匹配库操作日志_' + todayStamp() + '.csv');
  toast('已导出匹配库操作日志（' + rows.length + ' 条）', 'ok');
}

async function clearLibraryLogPanel() {
  const ok = await confirmDialog('清空匹配库操作日志', '只清空操作日志（最多 500 条），不会修改任何匹配库记录。确定清空？');
  if (!ok) return;
  try {
    if (lib.storeSchema && typeof lib.storeSchema.clearLibraryLogs === 'function') {
      lib.storeSchema.clearLibraryLogs(state.library);
    } else {
      state.library.meta = state.library.meta || {};
      state.library.meta.logs = [];
    }
    markDirty('library');
    renderLibraryLog();
    toast('匹配库操作日志已清空', 'ok');
  } catch (e) {
    toast('清空日志失败：' + humanError(e), 'error');
  }
}

/* ============================ v2.1.5 表格列显隐 / 行高 / 列悬停 / 表头筛选 ============================ */

const TABLE_COLUMN_DEFS = {
  match: [
    { key: 'rowno', label: '行', fixed: true, width: 52 },
    { key: 'sku', label: 'SKU', fixed: true, width: 116 },
    { key: 'name', label: '商品名称', width: 230, filter: 'contains' },
    { key: 'shop', label: '店铺', width: 130 },
    { key: 'brand', label: '品牌', width: 80 },
    { key: 'model', label: '型号', width: 84 },
    { key: 'package', label: '套餐', width: 96 },
    { key: 'size', label: '尺寸段', width: 96 },
    { key: 'price', label: '价格段', width: 100 },
    { key: 'priceNow', label: '当前价格(元)', width: 104, filter: 'range' },
    { key: 'amount', label: '成交金额(万元)', width: 92, filter: 'range' },
    { key: 'sample', label: '采样', width: 80, filter: 'range' },
    { key: 'source', label: '数据来源', width: 130 },
    { key: 'status', label: '状态', width: 84 },
    { key: 'libState', label: '入库状态', width: 92 },
    { key: 'op', label: '操作', width: 120, fixed: true },
  ],
  overview: [
    { key: 'reportRow', label: '行', fixed: true, width: 120 },
    { key: 'sku', label: 'SKU', fixed: true, width: 116 },
    { key: 'name', label: '商品名称', width: 210, filter: 'contains' },
    { key: 'shop', label: '店铺', width: 130 },
    { key: 'brand', label: '品牌', width: 80 },
    { key: 'model', label: '型号', width: 84 },
    { key: 'package', label: '套餐', width: 96 },
    { key: 'size', label: '尺寸段', width: 96 },
    { key: 'price', label: '价格段', width: 100 },
    { key: 'priceNow', label: '当前价格(元)', width: 104, filter: 'range' },
    { key: 'amount', label: '成交金额(万元)', width: 92, filter: 'range' },
    { key: 'sample', label: '采样', width: 80, filter: 'range' },
    { key: 'source', label: '数据来源', width: 130 },
    { key: 'status', label: '状态', width: 84 },
    { key: 'libState', label: '入库状态', width: 92 },
    { key: 'op', label: '操作', width: 150, fixed: true },
  ],
};

function tableCols(ctx) {
  state.settings.ui = state.settings.ui || {};
  const defaults = (DEFAULT_SETTINGS.ui.tableCols || {})[ctx] || {};
  const saved = (state.settings.ui.tableCols || {})[ctx] || {};
  return Object.assign({}, defaults, saved);
}

function saveTableCols(ctx, next) {
  state.settings.ui = state.settings.ui || {};
  state.settings.ui.tableCols = state.settings.ui.tableCols || {};
  state.settings.ui.tableCols[ctx] = Object.assign({}, tableCols(ctx), next || {});
  markDirty('settings');
}

function rowDensity() {
  const v = state.settings.ui && state.settings.ui.rowDensity;
  return v === 'compact' || v === 'loose' ? v : 'normal';
}

function saveRowDensity(value) {
  state.settings.ui = state.settings.ui || {};
  state.settings.ui.rowDensity = value === 'compact' || value === 'loose' ? value : 'normal';
  markDirty('settings');
  applyRowDensity();
}

function applyRowDensity() {
  const density = rowDensity();
  for (const id of ['page-workbench', 'page-overview']) {
    const page = document.getElementById(id);
    if (!page || !page.classList) continue;
    page.classList.remove('density-compact', 'density-loose');
    if (density !== 'normal') page.classList.add('density-' + density);
  }
}

function tableForContext(ctx) {
  return ctx === 'overview' ? els.overviewTable : els.matchBody;
}

function tableBodyForContext(ctx) {
  return ctx === 'overview' ? els.overviewBody : els.matchBodyRows;
}

/** 应用列显隐（DOM 加 col-hidden + 按可见列宽动态设置表格宽度） */
function applyTableColumns(ctx) {
  const table = tableForContext(ctx);
  if (!table) return;
  const defs = TABLE_COLUMN_DEFS[ctx] || [];
  const cols = tableCols(ctx);
  const ths = table.querySelectorAll ? table.querySelectorAll('thead th') : [];
  let visibleWidth = 0;
  for (let i = 0; i < defs.length; i++) {
    const def = defs[i];
    const visible = def.fixed ? true : cols[def.key] !== false;
    if (visible) visibleWidth += Number(def.width) || 80;
    if (ths[i]) ths[i].classList.toggle('col-hidden', !visible);
    const body = tableBodyForContext(ctx);
    let rows = [];
    try { rows = body ? body.querySelectorAll('tr') : []; } catch (e) { rows = []; }
    for (const tr of rows) {
      const cell = tr.children && tr.children[i];
      if (cell && cell.classList) cell.classList.toggle('col-hidden', !visible);
    }
  }
  try {
    table.style.width = visibleWidth + 'px';
    table.style.minWidth = visibleWidth + 'px';
  } catch (e) { /* ignore */ }
}

function renderColumnMenu(ctx) {
  const panel = ctx === 'overview' ? els.overviewColumnPanel : els.matchColumnPanel;
  if (!panel) return;
  const defs = TABLE_COLUMN_DEFS[ctx] || [];
  const cols = tableCols(ctx);
  const density = rowDensity();
  let html = '<div class="col-menu-title">显示列（行 / SKU 必选）</div>';
  for (const def of defs) {
    if (def.fixed) {
      html += '<label class="col-menu-option must"><input type="checkbox" checked disabled> ' + esc(def.label) + '</label>';
    } else {
      html += '<label class="col-menu-option"><input type="checkbox" data-col-toggle="' + def.key + '" data-col-ctx="' + ctx + '"' +
        (cols[def.key] !== false ? ' checked' : '') + '> ' + esc(def.label) + '</label>';
    }
  }
  html += '<div class="col-menu-row"><span>行高</span><select class="input" data-row-density="' + ctx + '">' +
    ['compact:紧凑', 'normal:标准', 'loose:宽松'].map((item) => {
      const parts = item.split(':');
      return '<option value="' + parts[0] + '"' + (density === parts[0] ? ' selected' : '') + '>' + parts[1] + '</option>';
    }).join('') + '</select></div>';
  panel.innerHTML = html;
}

/* ---------------- 列悬停高亮（20.6） ---------------- */

function bindColumnHover(table) {
  if (!table || table.__colHoverBound || !table.addEventListener) return;
  table.__colHoverBound = true;
  let lastIndex = -1;
  const clear = () => {
    try {
      for (const cell of table.querySelectorAll('.col-hover')) cell.classList.remove('col-hover');
    } catch (e) { /* ignore */ }
    lastIndex = -1;
  };
  table.addEventListener('mouseover', (e) => {
    const target = e && e.target;
    const cell = target && target.closest ? target.closest('th,td') : null;
    if (!cell || !table.contains || !table.contains(cell)) { clear(); return; }
    const tr = cell.parentElement;
    if (!tr || !tr.children) return;
    const index = Array.prototype.indexOf.call(tr.children, cell);
    if (index < 0 || index === lastIndex) return;
    clear();
    lastIndex = index;
    let rows = [];
    try { rows = table.querySelectorAll('tr'); } catch (err) { rows = []; }
    for (const row of rows) {
      const targetCell = row.children && row.children[index];
      if (targetCell && targetCell.classList) targetCell.classList.add('col-hover');
    }
  });
  table.addEventListener('mouseleave', clear);
}

/* ---------------- 表头列筛选（20.9） ---------------- */

function columnFilterValue(row, report, key) {
  if (!row) return '';
  if (key === 'sku') return String(row.sku || '');
  if (key === 'name') return String(row.name || '');
  if (key === 'shop') return storeNameOf(report, row);
  if (key === 'brand') return String(row.brand || '');
  if (key === 'model') return String(row.model || '');
  if (key === 'package') return String(row.package || '');
  if (key === 'size') return String(row.size || '');
  if (key === 'price') return String(row.price || '');
  if (key === 'priceNow') return row.capturePrice == null ? '' : String(row.capturePrice);
  if (key === 'amount') return row.amount == null ? '' : String(row.amount);
  if (key === 'sample') return row.sampleCount == null ? '' : String(row.sampleCount);
  if (key === 'source') return '尺 ' + (sourceText(row, 'size') || '—') + ' / 价 ' + (sourceText(row, 'price') || '—');
  if (key === 'status') return rowStatusInfo(row).text;
  if (key === 'libState') return LIB_STATE_LABELS[rowLibState(row, report)] || rowLibState(row, report);
  return '';
}

function rowMatchesColumnFilters(row, report, ctx) {
  const filters = (state.columnFilters && state.columnFilters[ctx]) || {};
  const entries = Object.keys(filters);
  for (const key of entries) {
    const filter = filters[key];
    if (!filter) continue;
    const value = columnFilterValue(row, report, key);
    if (Array.isArray(filter.values) && filter.values.length && filter.values.indexOf(value) < 0) return false;
    if (filter.contains) {
      if (String(value).toLowerCase().indexOf(String(filter.contains).toLowerCase()) < 0) return false;
    }
    if (filter.min !== '' && filter.min != null) {
      const n = Number(value);
      if (!isFinite(n) || n < Number(filter.min)) return false;
    }
    if (filter.max !== '' && filter.max != null) {
      const n = Number(value);
      if (!isFinite(n) || n > Number(filter.max)) return false;
    }
  }
  return true;
}

function columnFilterContextRows(ctx) {
  const out = [];
  if (ctx === 'overview') {
    for (const item of overviewAllRows()) out.push(item);
  } else {
    const filtered = filteredMatchRows();
    const report = (filtered && filtered.report) || activeReport();
    const rows = filtered && Array.isArray(filtered.rows) ? filtered.rows : [];
    for (const item of rows) out.push({ row: item.row, report });
  }
  return out;
}

function columnFilterDistinctValues(ctx, key) {
  const set = new Set();
  for (const item of columnFilterContextRows(ctx)) {
    const value = columnFilterValue(item.row, item.report, key);
    if (value === '') continue;
    set.add(value);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b, 'zh'));
}

function activeColumnFilterCount(ctx, key) {
  const filter = (state.columnFilters[ctx] || {})[key];
  if (!filter) return 0;
  if (Array.isArray(filter.values)) return filter.values.length;
  if (filter.contains) return 1;
  if (filter.min !== '' || filter.max !== '') return 1;
  return 0;
}

function syncHeaderFilterButtons(ctx) {
  const table = tableForContext(ctx);
  if (!table || !table.querySelectorAll) return;
  let buttons = [];
  try { buttons = table.querySelectorAll('thead th .th-filter'); } catch (e) { buttons = []; }
  for (const btn of buttons) {
    const key = btn.getAttribute('data-col-filter');
    const n = activeColumnFilterCount(ctx, key);
    btn.classList.toggle('active', n > 0);
    btn.setAttribute('data-count', n ? String(n) : '');
    btn.setAttribute('title', (n ? '已筛选 ' + n + ' 个值，点击修改' : '点击筛选该列'));
  }
}

function initHeaderFilterButtons() {
  for (const ctx of ['match', 'overview']) {
    const table = tableForContext(ctx);
    if (!table || !table.querySelectorAll) continue;
    const defs = TABLE_COLUMN_DEFS[ctx] || [];
    let ths = [];
    try { ths = table.querySelectorAll('thead th'); } catch (e) { ths = []; }
    for (let i = 0; i < ths.length; i++) {
      const def = defs[i];
      if (!def || def.key === 'op' || def.key === 'rowno' || def.key === 'reportRow') continue;
      const th = ths[i];
      if (th.querySelector && th.querySelector('.th-filter')) continue;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'th-filter';
      btn.setAttribute('data-col-filter', def.key);
      btn.setAttribute('data-col-ctx', ctx);
      btn.setAttribute('title', '点击筛选该列');
      // 阻止冒泡，避免点筛选按钮同时触发表头排序
      btn.addEventListener('click', (e) => {
        if (e && e.stopPropagation) e.stopPropagation();
        if (e && e.preventDefault) e.preventDefault();
        openColumnFilterPanel(ctx, def.key, btn);
      });
      th.appendChild(btn);
    }
    syncHeaderFilterButtons(ctx);
  }
}

let colFilterState = { ctx: '', key: '', button: null };

function positionFloating(el, anchor) {
  if (!el || !anchor) return;
  let rect = null;
  try { rect = anchor.getBoundingClientRect(); } catch (e) { rect = null; }
  if (!rect) return;
  const vw = Number(window.innerWidth) || 1344;
  const vh = Number(window.innerHeight) || 756;
  let width = 260;
  try { width = Number(el.offsetWidth) || 260; } catch (e) { /* ignore */ }
  let height = 360;
  try { height = Number(el.offsetHeight) || 360; } catch (e) { /* ignore */ }
  let left = rect.left;
  if (left + width > vw - 8) left = Math.max(8, rect.right - width);
  let top = rect.bottom + 4;
  if (top + height > vh - 8) top = Math.max(8, rect.top - height - 4);
  el.style.position = 'fixed';
  el.style.left = Math.round(left) + 'px';
  el.style.top = Math.round(top) + 'px';
}

function openColumnFilterPanel(ctx, key, button) {
  if (!els.colFilterPanel) return;
  colFilterState = { ctx, key, button };
  const def = (TABLE_COLUMN_DEFS[ctx] || []).find((d) => d.key === key);
  const filter = (state.columnFilters[ctx] || {})[key] || {};
  if (els.colFilterTitle) els.colFilterTitle.textContent = '列筛选：' + ((def && def.label) || key);
  const body = els.colFilterBody;
  if (!body) return;
  const kind = def && def.filter === 'range' ? 'range' : def && def.filter === 'contains' ? 'contains' : 'values';
  if (kind === 'contains') {
    body.innerHTML = '<input class="input col-filter-search" id="colFilterText" type="search" placeholder="包含文本…" value="' + esc(filter.contains || '') + '">' +
      '<div class="col-filter-empty">按包含匹配（不区分大小写）</div>';
  } else if (kind === 'range') {
    body.innerHTML = '<div class="col-filter-range">' +
      '<input class="input" id="colFilterMin" type="number" placeholder="最小值" value="' + esc(filter.min == null ? '' : filter.min) + '">' +
      '<span>~</span>' +
      '<input class="input" id="colFilterMax" type="number" placeholder="最大值" value="' + esc(filter.max == null ? '' : filter.max) + '">' +
    '</div>';
  } else {
    const values = columnFilterDistinctValues(ctx, key);
    const selected = Array.isArray(filter.values) ? filter.values : [];
    body.innerHTML = '<input class="input col-filter-search" id="colFilterSearch" type="search" placeholder="搜索值…">' +
      '<div id="colFilterValueList">' + (values.length
        ? values.map((value) => '<label class="col-filter-option" data-filter-value="' + esc(value) + '"><input type="checkbox"' +
            (selected.indexOf(value) >= 0 ? ' checked' : '') + '> <span title="' + esc(value) + '">' + esc(value) + '</span></label>').join('')
        : '<div class="col-filter-empty">该列没有可选值。</div>') + '</div>';
  }
  els.colFilterPanel.classList.remove('hidden');
  positionFloating(els.colFilterPanel, button);
}

function closeColumnFilterPanel() {
  if (els.colFilterPanel) els.colFilterPanel.classList.add('hidden');
  colFilterState = { ctx: '', key: '', button: null };
}

function applyColumnFilterValue() {
  const { ctx, key } = colFilterState;
  if (!ctx || !key) return;
  state.columnFilters[ctx] = state.columnFilters[ctx] || {};
  const def = (TABLE_COLUMN_DEFS[ctx] || []).find((d) => d.key === key);
  const kind = def && def.filter === 'range' ? 'range' : def && def.filter === 'contains' ? 'contains' : 'values';
  const prev = state.columnFilters[ctx][key] || {};
  if (kind === 'contains') {
    const input = document.getElementById('colFilterText');
    const text = String((input && input.value) || '').trim();
    if (!text) delete state.columnFilters[ctx][key];
    else state.columnFilters[ctx][key] = { contains: text };
  } else if (kind === 'range') {
    const minEl = document.getElementById('colFilterMin');
    const maxEl = document.getElementById('colFilterMax');
    const min = minEl && String(minEl.value).trim() !== '' ? Number(minEl.value) : '';
    const max = maxEl && String(maxEl.value).trim() !== '' ? Number(maxEl.value) : '';
    if (min === '' && max === '') delete state.columnFilters[ctx][key];
    else state.columnFilters[ctx][key] = { min: min === '' ? '' : min, max: max === '' ? '' : max };
  } else {
    let checked = [];
    try {
      checked = Array.from(document.querySelectorAll('#colFilterValueList input[type="checkbox"]'))
        .filter((cb) => cb.checked)
        .map((cb) => String(cb.parentElement && cb.parentElement.getAttribute('data-filter-value')))
        .filter(Boolean);
    } catch (e) { checked = []; }
    if (!checked.length) delete state.columnFilters[ctx][key];
    else state.columnFilters[ctx][key] = { values: checked };
  }
  if (!Object.keys(state.columnFilters[ctx]).length) delete state.columnFilters[ctx];
  if (ctx === 'match') renderMatchTable(); else renderOverview();
  syncHeaderFilterButtons(ctx);
}

/* ============================ v2.1.5 异常自动继续（DESIGN 20.8） ============================ */

/** 每批上限：读 settings.capture.maxBatch（5~100，默认 20；兼容旧 batchLimit） */
function resolveMaxBatch(capSettings) {
  const cap = capSettings || {};
  return Math.max(5, Math.min(100, Math.floor(Number(cap.maxBatch != null ? cap.maxBatch : cap.batchLimit) || 20)));
}

/** 按当前设置截断采集任务队列，返回 {maxBatch,total,queued,truncated,tasks} */
function planCaptureBatch(tasks, capSettings) {
  const maxBatch = resolveMaxBatch(capSettings);
  const list = Array.isArray(tasks) ? tasks : [];
  const trimmed = list.slice(0, maxBatch);
  return { maxBatch, total: list.length, queued: trimmed.length, truncated: Math.max(0, list.length - trimmed.length), tasks: trimmed };
}

function anomalyWaitConfigSec() {
  const cap = state.settings.capture || {};
  const n = Number(cap.anomalyWaitSec);
  return isFinite(n) ? Math.max(0, Math.min(600, Math.floor(n))) : 60;
}

function clearAnomalyWait() {
  state.capture.anomaly = null;
  if (state.capture.anomalyTimer) {
    try { clearInterval(state.capture.anomalyTimer); } catch (e) { /* ignore */ }
    state.capture.anomalyTimer = null;
  }
  if (els.anomalyBar) els.anomalyBar.classList.add('hidden');
}

function renderAnomalyBar() {
  if (!els.anomalyBar) return;
  const anomaly = state.capture.anomaly;
  if (!anomaly || !state.capture.running) {
    els.anomalyBar.classList.add('hidden');
    return;
  }
  const remainMs = Math.max(0, Number(anomaly.waitingUntil) ? Number(anomaly.waitingUntil) - Date.now() : Number(anomaly.remainingMs) || 0);
  const totalSec = Math.max(1, Math.round((Number(anomaly.totalMs) || remainMs || anomalyWaitConfigSec() * 1000) / 1000));
  const remainSec = Math.ceil(remainMs / 1000);
  const mm = String(Math.floor(remainSec / 60)).padStart(2, '0');
  const ss = String(remainSec % 60).padStart(2, '0');
  els.anomalyBar.classList.remove('hidden');
  if (els.anomalyText) {
    els.anomalyText.textContent = '检测到异常（' + (anomaly.reason || '页面跳转 / 空页') + '），等待 ' + totalSec + ' 秒后自动继续（剩余 ' + mm + ':' + ss + '）';
  }
}

function handleCaptureAnomaly(payload) {
  if (!payload) return;
  const waitSec = anomalyWaitConfigSec();
  const reason = String(payload.reason || payload.detail || (payload.anomaly && payload.anomaly.reason) || '页面跳转 / 空页');
  if (waitSec <= 0) {
    // 0 = 不等待立即下一条；lib 会自动继续，这里只记录
    logLine('采集异常（' + reason + '）：异常等待设为 0，立即跳过继续下一条');
    renderAnomalyBar();
    return;
  }
  const remainingMs = Number(payload.remainingMs);
  const totalMs = Number(payload.totalMs);
  const waitingUntil = Number(payload.waitingUntil) || (isFinite(remainingMs) && remainingMs > 0 ? Date.now() + remainingMs : 0);
  const first = !state.capture.anomaly;
  state.capture.anomaly = {
    reason,
    waitingUntil,
    remainingMs: isFinite(remainingMs) ? remainingMs : 0,
    totalMs: isFinite(totalMs) && totalMs > 0 ? totalMs : anomalyWaitConfigSec() * 1000,
    at: nowIso(),
  };
  if (first) {
    state.capture.anomalyCount = (state.capture.anomalyCount || 0) + 1;
    logLine('采集异常等待：' + reason + '，' + anomalyWaitConfigSec() + ' 秒后自动继续（可点「立即继续」）');
    toast('检测到页面异常（' + reason + '），等待 ' + anomalyWaitConfigSec() + ' 秒后自动继续，无需重启', 'error');
  }
  renderAnomalyBar();
  if (state.capture.anomalyTimer) return;
  state.capture.anomalyTimer = setInterval(() => {
    const anomaly = state.capture.anomaly;
    if (!anomaly) { clearAnomalyWait(); return; }
    if (anomaly.waitingUntil && Date.now() >= anomaly.waitingUntil) {
      // lib 会自动继续；这里只负责收起等待条
      clearAnomalyWait();
      logLine('异常等待结束，已自动继续采集');
      return;
    }
    renderAnomalyBar();
  }, 500);
}

function skipAnomalyWaitNow() {
  const runner = state.capture.runner;
  try {
    if (runner && typeof runner.skipAnomalyWait === 'function') runner.skipAnomalyWait();
  } catch (e) { logLine('跳过异常等待失败：' + humanError(e)); }
  clearAnomalyWait();
  logLine('已手动跳过异常等待，立即继续');
  toast('已跳过异常等待，立即继续采集', 'ok');
}

/* ---------------- 采集结果异常分类（下架 / 风控 / 软异常） ---------------- */

function captureResultFlags(payload) {
  if (!payload || typeof payload !== 'object') return {};
  const result = payload.result || payload.capture || payload;
  return (result && result.flags) || payload.flags || {};
}

function riskKeywords(reason) {
  return /风控|安全验证|验证码|captcha|登录|login|verify|验证页|访问频繁|risk/i.test(String(reason || ''));
}

function softAnomalyKeywords(reason) {
  return /首页|商城|空页|跳转|重定向|异常|blank|redirect|home/i.test(String(reason || ''));
}

function handleOffSaleResult(payload) {
  const flags = captureResultFlags(payload);
  if (!flags.offSale) return false;
  const sku = String((payload.task && payload.task.sku) || (payload.result && payload.result.sku) || '');
  logLine('已下架/不存在：' + (sku || '—') + '（跳过继续下一条，不计风控）');
  return true;
}

/* ============================ v2.1.5 匹配库保护：种子迁移（merge-missing / replace） ============================ */

async function runSeedMigration(mode) {
  const migrationMode = mode === 'replace' ? 'replace' : 'merge-missing';
  try {
    const seed = await fetchSeedRaw();
    if (!seed) {
      logLine('内置匹配库迁移：未读取到 data/base-skus.json，跳过');
      return { ok: false, reason: '未读取到内置匹配库文件' };
    }
    rememberSeedBands(seed);
    const seedFp = String(seed.fingerprint || seed.schemaVersion || '');
    if (!lib.storeSchema || typeof lib.storeSchema.applySeedMigration !== 'function') {
      logLine('内置匹配库迁移：lib.storeSchema.applySeedMigration 未就绪，跳过（等待数据引擎更新）');
      return { ok: false, reason: '数据引擎未就绪', seedFp };
    }
    if (migrationMode === 'replace') {
      // 红线：replace 前必须先备份当前用户库
      await ensureLibraryBackupV215(true);
    }
    const res = lib.storeSchema.applySeedMigration(state.library, seed, { mode: migrationMode });
    state.library = normalizeLibraryShape(state.library);
    const migrated = !!(res && res.migrated);
    const seedRows = Number(res && res.seedRows) || 0;
    const added = Number(res && res.added) || 0;
    const kept = res && res.kept != null ? Number(res.kept) : countLibraryRows(state.library);
    const keptManual = Number(res && res.keptManual) || 0;
    state.settings.ui = state.settings.ui || {};
    state.settings.ui.seedVersion = String(seed.schemaVersion || seed.fingerprint || seedFp || '');
    markDirty('library');
    markDirty('settings');
    state.statsStale = true;
    invalidateLibraryStates();
    renderAll();
    if (migrated) {
      if (migrationMode === 'replace') {
        toast('内置匹配库已重置（种子 ' + fmtNum(seedRows, 0) + ' 行，保留人工记录 ' + fmtNum(keptManual, 0) + ' 条）', 'ok');
        logLine('内置匹配库已重置：种子 ' + seedRows + ' 行，保留人工 ' + keptManual + ' 条');
      } else {
        toast('内置匹配库已合并缺失 SKU（新增 ' + fmtNum(added, 0) + ' 条，保留现有 ' + fmtNum(kept, 0) + ' 条）', 'ok');
        logLine('内置匹配库 merge-missing：新增 ' + added + ' 条，保留 ' + kept + ' 条');
      }
    } else {
      logLine('内置匹配库无需变更（merge-missing 已是最新或 replace 无差异）');
    }
    renderSeedVersionText();
    try {
      await flushSave('library');
      await flushSave('settings');
    } catch (e) { /* 保存失败由上层状态提示 */ }
    return { ok: true, migrated, mode: migrationMode, seedRows, added, kept, keptManual, seedVersion: state.settings.ui.seedVersion };
  } catch (e) {
    logLine('内置匹配库迁移失败（已跳过）：' + humanError(e));
    return { ok: false, reason: humanError(e) };
  }
}

/** DESIGN 20.11：重置为内置新版必须明确二次确认，且只在这里用 replace */
async function resetSeedLibrary() {
  const first = await confirmDialog('重置匹配库为内置新版',
    '将用内置权威版匹配库【整体替换】当前匹配库（当前 ' + fmtNum(countLibraryRows(state.library), 0) + ' 条记录）。\n\n替换前会自动写 libraryBackup_v215 快照，之后可从设置页「从备份恢复匹配库」还原。确定继续？');
  if (!first) return;
  const second = await confirmDialog('再次确认：重置匹配库',
    '这是第二次确认：确定要用内置新版整体替换当前匹配库吗？\n\n当前库会先备份；人工确认记录由 lib 尽量保留，但建议先「导出备份 JSON」。');
  if (!second) return;
  const res = await runSeedMigration('replace');
  if (res && res.ok) toast('已重置为内置新版匹配库（' + fmtNum(countLibraryRows(state.library), 0) + ' 条记录）', 'ok');
  else toast('重置未完成：' + ((res && res.reason) || '数据引擎未就绪'), 'error');
}

/* ============================ v2.1.5 匹配库类目合并 / 去重（DESIGN 20.13） ============================ */

function libMergeSupport() {
  return !!(lib.storeSchema && typeof lib.storeSchema.mergeStores === 'function');
}

function libDedupeSupport() {
  return !!(lib.storeSchema && typeof lib.storeSchema.dedupeStore === 'function');
}

/** 归一化合并目标为 lib 需要的 {name, create} */
function normalizeMergeTarget(target) {
  if (target && typeof target === 'object') {
    const name = String(target.name || '').trim();
    return { name, create: target.create !== false && !!name && storeNames().indexOf(name) < 0 };
  }
  const name = String(target || '').trim();
  return { name, create: !!name && storeNames().indexOf(name) < 0 };
}

async function mergeStoresPreview(options) {
  if (!libMergeSupport()) return { ok: false, reason: 'lib mergeStores 未就绪' };
  const opts = options || {};
  const sources = Array.isArray(opts.sources) ? opts.sources.filter(Boolean) : [];
  const target = normalizeMergeTarget(opts.target);
  if (sources.length < 2) return { ok: false, reason: '请至少选择 2 个类目' };
  if (!target.name) return { ok: false, reason: '请选择目标类目或输入新类目名' };
  try {
    const res = lib.storeSchema.mergeStores(state.library, { sources, target, dryRun: true });
    if (!res || res.ok === false) return { ok: false, reason: (res && res.error) || '合并预览失败' };
    return { ok: true, preview: res.preview || res, result: res };
  } catch (e) {
    return { ok: false, reason: humanError(e) };
  }
}

async function mergeStoresApply(options) {
  if (!libMergeSupport()) return { ok: false, reason: 'lib mergeStores 未就绪' };
  const opts = options || {};
  const sources = Array.isArray(opts.sources) ? opts.sources.filter(Boolean) : [];
  const target = normalizeMergeTarget(opts.target);
  if (sources.length < 2) return { ok: false, reason: '请至少选择 2 个类目' };
  if (!target.name) return { ok: false, reason: '请选择目标类目或输入新类目名' };
  try {
    // DESIGN 20.13：合并前自动快照（已有则覆盖为最新）
    const snap = await ensureLibraryBackupV215(true);
    if (!snap) logLine('合并类目前快照失败，但继续执行（已二次确认）');
    const res = lib.storeSchema.mergeStores(state.library, { sources, target, dryRun: false });
    if (!res || res.ok === false) {
      toast('合并类目失败：' + ((res && res.error) || '未知错误'), 'error');
      return { ok: false, reason: (res && res.error) || '合并失败', result: res };
    }
    if (!hasLibLibraryLog()) {
      appendUiLibraryLog({ action: 'merge-stores', store: target.name, sku: '', field: '', before: String(sources.length), after: target.name, source: '人工', note: '合并类目 ' + sources.join(' / ') });
    }
    markDirty('library');
    state.statsStale = true;
    invalidateLibraryStates();
    renderAll();
    const preview = (res && res.preview) || {};
    toast('已合并 ' + fmtNum(preview.mergedStores != null ? preview.mergedStores : sources.length, 0) + ' 个类目，去重 ' +
      fmtNum(preview.duplicates || 0, 0) + ' 条，冲突 ' + fmtNum(preview.conflictCount || 0, 0) + ' 条（详见操作日志）', 'ok');
    logLine('匹配库类目合并：' + sources.join('、') + ' → ' + target.name + '（去重 ' + (preview.duplicates || 0) + '，冲突 ' + (preview.conflictCount || 0) + '）');
    renderLibraryLog();
    return { ok: true, result: res, preview, backup: snap && snap.at };
  } catch (e) {
    toast('合并类目失败：' + humanError(e), 'error');
    return { ok: false, reason: humanError(e) };
  }
}

async function dedupeStoreApply(storeName, options) {
  const name = String(storeName || '').trim();
  if (!name) return { ok: false, reason: '缺少类目名' };
  if (!libDedupeSupport()) return { ok: false, reason: 'lib dedupeStore 未就绪' };
  const opts = options || {};
  try {
    if (opts.dryRun) {
      const preview = lib.storeSchema.dedupeStore(state.library, name, { dryRun: true });
      if (!preview || preview.ok === false) return { ok: false, reason: (preview && preview.error) || '去重预览失败' };
      return { ok: true, preview: preview.preview || preview };
    }
    const snap = await ensureLibraryBackupV215(true);
    if (!snap) logLine('去重前快照失败，但继续执行（已确认）');
    const res = lib.storeSchema.dedupeStore(state.library, name, { dryRun: false });
    if (!res || res.ok === false) {
      toast('类目去重失败：' + ((res && res.error) || '未知错误'), 'error');
      return { ok: false, reason: (res && res.error) || '去重失败', result: res };
    }
    if (!hasLibLibraryLog()) {
      appendUiLibraryLog({ action: 'dedupe-store', store: name, sku: '', field: '', before: '', after: '', source: '人工', note: '类目去重' });
    }
    markDirty('library');
    state.statsStale = true;
    invalidateLibraryStates();
    renderAll();
    const preview = (res && res.preview) || {};
    const removed = res && res.removed != null ? res.removed : (preview.duplicates || 0);
    toast('已对「' + name + '」去重：去重 ' + fmtNum(removed, 0) + ' 条，冲突 ' +
      fmtNum(preview.conflictCount != null ? preview.conflictCount : (Array.isArray(res && res.conflicts) ? res.conflicts.length : 0), 0) + ' 条', 'ok');
    renderLibraryLog();
    return { ok: true, result: res, preview, backup: snap && snap.at };
  } catch (e) {
    toast('类目去重失败：' + humanError(e), 'error');
    return { ok: false, reason: humanError(e) };
  }
}

function renderMergePreviewHtml(preview) {
  const p = preview || {};
  const sources = Array.isArray(p.sources) ? p.sources : [];
  const conflicts = Array.isArray(p.conflicts) ? p.conflicts : [];
  const rowsBefore = p.rowsBefore != null ? p.rowsBefore : 0;
  const rowsAfter = p.uniqueAfter != null ? p.uniqueAfter : (p.rowsAfter != null ? p.rowsAfter : 0);
  const duplicates = p.duplicates != null ? p.duplicates : 0;
  const conflictCount = p.conflictCount != null ? p.conflictCount : conflicts.length;
  let html = '<div class="merge-stats">' +
    '<span>类目 <b>' + esc(String(p.mergedStores != null ? p.mergedStores : sources.length)) + '</b></span>' +
    '<span>合并前记录 <b>' + esc(fmtNum(rowsBefore, 0)) + '</b></span>' +
    '<span>去重后 <b>' + esc(fmtNum(rowsAfter, 0)) + '</b></span>' +
    '<span>重复 <b>' + esc(fmtNum(duplicates, 0)) + '</b></span>' +
    '<span>字段冲突 <b>' + esc(fmtNum(conflictCount, 0)) + '</b></span>' +
    '<span>目标类目 <b>' + esc((p.target && (p.target.name || p.target)) || '') + '</b></span>' +
  '</div>';
  if (conflicts.length) {
    html += '<div class="merge-conflicts"><b>字段冲突（前 20 条）</b>' +
      '<div class="merge-conflict-list">' + conflicts.slice(0, 20).map((c) => {
        return '<div class="merge-conflict-row">' +
          '<span class="mc-sku">' + esc(c.sku || '—') + '</span>' +
          '<span class="mc-field">' + esc(c.field || '') + '</span>' +
          '<span class="mc-change">' + esc(c.before || '') + ' → ' + esc(c.after || '') + '</span>' +
          '<span class="mc-source">' + esc(c.chosenStore || c.rejectedStore || '') + '</span>' +
        '</div>';
      }).join('') + '</div></div>';
  } else {
    html += '<div class="hint">没有字段冲突（重复 SKU 的字段值一致或来自同一优先级）。</div>';
  }
  return html;
}

/* ============================ v2.1.5 表格列设置事件 / 初始化 ============================ */

function bindTableEnhancementEvents() {
  // 列设置面板
  for (const ctx of ['match', 'overview']) {
    const panel = ctx === 'overview' ? els.overviewColumnPanel : els.matchColumnPanel;
    if (!panel) continue;
    panel.addEventListener('change', (e) => {
      const target = e && e.target;
      if (!target) return;
      if (target.getAttribute && target.getAttribute('data-col-toggle')) {
        const key = target.getAttribute('data-col-toggle');
        const visible = !!target.checked;
        saveTableCols(ctx, { [key]: visible });
        // 隐藏列时同步清掉该列筛选，避免「看不见的筛选条件」继续过滤
        if (!visible && state.columnFilters && state.columnFilters[ctx]) {
          delete state.columnFilters[ctx][key];
          if (!Object.keys(state.columnFilters[ctx]).length) delete state.columnFilters[ctx];
        }
        if (ctx === 'match') renderMatchTable(); else renderOverview();
      } else if (target.getAttribute && target.getAttribute('data-row-density')) {
        saveRowDensity(target.value);
        if (ctx === 'match') renderMatchTable(); else renderOverview();
      }
    });
  }
  // 表头筛选按钮（事件委托）
  for (const ctx of ['match', 'overview']) {
    const table = tableForContext(ctx);
    if (!table) continue;
    table.addEventListener('click', (e) => {
      const btn = e && e.target && e.target.closest ? e.target.closest('.th-filter') : null;
      if (!btn) return;
      const key = btn.getAttribute('data-col-filter');
      const tableCtx = btn.getAttribute('data-col-ctx') || ctx;
      if (!key) return;
      openColumnFilterPanel(tableCtx, key, btn);
    });
  }
  if (els.colFilterCloseBtn) els.colFilterCloseBtn.addEventListener('click', closeColumnFilterPanel);
  if (els.colFilterClearBtn) {
    els.colFilterClearBtn.addEventListener('click', () => {
      const { ctx, key } = colFilterState;
      if (ctx && key) {
        if (state.columnFilters[ctx]) delete state.columnFilters[ctx][key];
        closeColumnFilterPanel();
        if (ctx === 'match') renderMatchTable(); else renderOverview();
        syncHeaderFilterButtons(ctx);
      }
    });
  }
  if (els.colFilterBody) {
    els.colFilterBody.addEventListener('change', applyColumnFilterValue);
    els.colFilterBody.addEventListener('input', (e) => {
      const target = e && e.target;
      if (!target || !target.id) return;
      if (target.id === 'colFilterText' || target.id === 'colFilterMin' || target.id === 'colFilterMax') {
        clearTimeout(els.colFilterBody.__applyTimer);
        els.colFilterBody.__applyTimer = setTimeout(applyColumnFilterValue, 220);
      } else if (target.id === 'colFilterSearch') {
        const q = String(target.value || '').toLowerCase();
        const list = document.getElementById('colFilterValueList');
        if (list && list.querySelectorAll) {
          const options = list.querySelectorAll('.col-filter-option');
          for (const opt of options) {
            const text = String(opt.getAttribute('data-filter-value') || '').toLowerCase();
            opt.style.display = q && text.indexOf(q) < 0 ? 'none' : '';
          }
        }
      }
    });
  }
  document.addEventListener('click', (e) => {
    if (!els.colFilterPanel || els.colFilterPanel.classList.contains('hidden')) return;
    const target = e && e.target;
    if (els.colFilterPanel.contains && els.colFilterPanel.contains(target)) return;
    if (target && target.closest && target.closest('.th-filter')) return;
    closeColumnFilterPanel();
  });
  document.addEventListener('keydown', (e) => {
    if (e && e.key === 'Escape') closeColumnFilterPanel();
  });
  // 异常等待条按钮
  if (els.anomalyContinueBtn) els.anomalyContinueBtn.addEventListener('click', skipAnomalyWaitNow);
  if (els.anomalyStopBtn) {
    els.anomalyStopBtn.addEventListener('click', () => {
      clearAnomalyWait();
      stopCapture();
    });
  }
  // 匹配库日志
  if (els.libLogBtn) els.libLogBtn.addEventListener('click', () => openLibraryLog());
  if (els.libLogCloseBtn) els.libLogCloseBtn.addEventListener('click', closeLibraryLog);
  if (els.libLogSearch) els.libLogSearch.addEventListener('input', () => renderLibraryLog());
  if (els.libLogExportBtn) els.libLogExportBtn.addEventListener('click', exportLibraryLogCsv);
  if (els.libLogClearBtn) els.libLogClearBtn.addEventListener('click', () => { clearLibraryLogPanel().catch((e) => logLine('清空日志失败：' + humanError(e))); });
  if (els.restoreLibraryBackupBtn) els.restoreLibraryBackupBtn.addEventListener('click', () => { restoreLibraryBackupV215().catch((e) => logLine('恢复备份失败：' + humanError(e))); });
  // 类目合并 / 去重 / 日志事件委托（匹配库页）
  if (els.libStoreList) {
    els.libStoreList.addEventListener('click', (e) => {
      const target = e && e.target;
      if (!target || !target.closest) return;
      const mergeBtn = target.closest('#mergeStoresBtn');
      if (mergeBtn) {
        const selected = Array.from(document.querySelectorAll('[data-store-select]:checked')).map((cb) => cb.getAttribute('data-store-select')).filter(Boolean);
        openMergeStoresDialog(selected).catch((err) => toast('打开合并失败：' + humanError(err), 'error'));
        return;
      }
      const dedupeBtn = target.closest('[data-store-act="dedupe"]');
      if (dedupeBtn) {
        const name = dedupeBtn.getAttribute('data-store') || '';
        if (name) { dedupeStoreWithConfirm(name).catch((err) => toast('去重失败：' + humanError(err), 'error')); }
      }
    });
    els.libStoreList.addEventListener('change', (e) => {
      const target = e && e.target;
      if (target && target.getAttribute && target.getAttribute('data-store-select') != null) {
        syncMergeStoresButton();
      }
    });
  }
  if (els.mergeStoresBtn) els.mergeStoresBtn.addEventListener('click', () => {
    const selected = Array.from(document.querySelectorAll('[data-store-select]:checked')).map((cb) => cb.getAttribute('data-store-select')).filter(Boolean);
    openMergeStoresDialog(selected).catch((err) => toast('打开合并失败：' + humanError(err), 'error'));
  });
  if (els.mergeStoresPreviewBtn) els.mergeStoresPreviewBtn.addEventListener('click', () => previewMergeFromDialog().catch((e) => logLine('合并预览失败：' + humanError(e))));
  if (els.mergeStoresApplyBtn) els.mergeStoresApplyBtn.addEventListener('click', () => applyMergeFromDialog().catch((e) => logLine('合并执行失败：' + humanError(e))));
  if (els.mergeStoresCancelBtn) els.mergeStoresCancelBtn.addEventListener('click', () => closeMergeStoresDialog());
  if (els.mergeStoresTarget) els.mergeStoresTarget.addEventListener('change', () => syncMergeTargetInput());
}

async function dedupeStoreWithConfirm(storeName) {
  const name = String(storeName || '').trim();
  if (!name) return;
  const pre = await dedupeStoreApply(name, { dryRun: true });
  if (!pre.ok) { toast('去重预览失败：' + (pre.reason || '未知错误'), 'error'); return; }
  const preview = pre.preview || {};
  const removed = preview.removed != null ? preview.removed : preview.duplicates || 0;
  const conflicts = preview.conflictCount != null ? preview.conflictCount : (Array.isArray(preview.conflicts) ? preview.conflicts.length : 0);
  const ok = await confirmDialog('类目去重',
    '类目「' + name + '」预览：重复 SKU ' + removed + ' 条，字段冲突 ' + conflicts + ' 条。\n\n执行前会自动写 libraryBackup_v215 快照，并记录操作日志。确定去重？');
  if (!ok) return;
  const res = await dedupeStoreApply(name);
  if (!res.ok) toast('去重失败：' + (res.reason || '未知错误'), 'error');
}

function syncMergeStoresButton() {
  // v2.1.7 修：类目列表每次 renderLibraryStores() 都会重建 innerHTML，
  // els.mergeStoresBtn 会指向已脱离文档的旧按钮，导致勾选后按钮仍 disabled/文本不更新。
  // 这里始终取当前文档中的按钮；同时更新 els 缓存，避免后续事件绑定用到旧节点。
  const btn = document.getElementById('mergeStoresBtn') || els.mergeStoresBtn;
  if (!btn) return;
  els.mergeStoresBtn = btn;
  const n = (() => { try { return document.querySelectorAll('[data-store-select]:checked').length; } catch (e) { return 0; } })();
  btn.disabled = n < 2;
  btn.textContent = '合并所选类目…（' + n + '）';
}

let mergeStoresState = { sources: [], preview: null };

function mergeDialogSelectedTarget() {
  const select = els.mergeStoresTarget;
  const newInput = els.mergeStoresNewName;
  const value = select ? select.value : '';
  if (value === '__new__') {
    const name = String((newInput && newInput.value) || '').trim();
    return { name, create: true };
  }
  return { name: String(value || '').trim(), create: false };
}

function syncMergeTargetInput() {
  const select = els.mergeStoresTarget;
  if (!els.mergeStoresNewName) return;
  const show = !select || select.value === '__new__';
  els.mergeStoresNewName.classList.toggle('hidden', !show);
  if (els.mergeStoresNewNameField) els.mergeStoresNewNameField.classList.toggle('hidden', !show);
}

function openMergeStoresDialog(sources) {
  if (!libMergeSupport()) {
    toast('类目合并需要数据引擎支持（mergeStores 未就绪）', 'error');
    return Promise.resolve({ ok: false, reason: 'lib-merge-missing' });
  }
  const list = Array.isArray(sources) ? sources.filter(Boolean) : [];
  if (list.length < 2) { toast('请至少选择 2 个类目再合并', 'error'); return Promise.resolve({ ok: false, reason: 'need-2' }); }
  mergeStoresState = { sources: list, preview: null };
  if (!els.mergeStoresDialog) return Promise.resolve({ ok: false, reason: 'dialog-missing' });
  if (els.mergeStoresTarget) {
    const names = storeNames();
    const outside = names.filter((name) => list.indexOf(name) < 0);
    els.mergeStoresTarget.innerHTML = names.map((name) => '<option value="' + esc(name) + '">' + esc(name) + (list.indexOf(name) >= 0 ? '（将被合并）' : '') + '</option>').join('') +
      '<option value="__new__">＋ 新建名称…</option>';
    els.mergeStoresTarget.value = outside[0] || '__new__';
  }
  if (els.mergeStoresNewName) els.mergeStoresNewName.value = list.length ? list[0] + '（合并）' : '';
  syncMergeTargetInput();
  if (els.mergeStoresBody) els.mergeStoresBody.innerHTML = '<div class="hint">已选择 ' + list.length + ' 个类目：' + esc(list.join('、')) + '。点击「预览」查看去重与冲突结果；预览不会修改匹配库。</div>';
  if (els.mergeStoresApplyBtn) els.mergeStoresApplyBtn.disabled = true;
  showDialog(els.mergeStoresDialog);
  return Promise.resolve({ ok: true });
}

function closeMergeStoresDialog() {
  if (els.mergeStoresDialog) closeDialog(els.mergeStoresDialog);
  mergeStoresState.preview = null;
}

async function previewMergeFromDialog() {
  const target = mergeDialogSelectedTarget();
  if (!target.name) { toast('请选择目标类目或输入新类目名', 'error'); return; }
  const res = await mergeStoresPreview({ sources: mergeStoresState.sources, target });
  if (!res.ok) { toast('预览失败：' + (res.reason || '未知错误'), 'error'); return; }
  mergeStoresState.preview = res.preview;
  if (els.mergeStoresBody) els.mergeStoresBody.innerHTML = renderMergePreviewHtml(res.preview);
  if (els.mergeStoresApplyBtn) els.mergeStoresApplyBtn.disabled = false;
}

async function applyMergeFromDialog() {
  const target = mergeDialogSelectedTarget();
  if (!target.name) { toast('请选择目标类目或输入新类目名', 'error'); return; }
  if (!mergeStoresState.preview) { toast('请先点「预览」确认合并结果', 'error'); return; }
  const ok = await confirmDialog('确认合并类目', '将把 ' + mergeStoresState.sources.length + ' 个类目合并到「' + target.name + '」，并自动备份当前匹配库。\n\n确定执行？');
  if (!ok) return;
  const res = await mergeStoresApply({ sources: mergeStoresState.sources, target });
  if (res.ok) closeMergeStoresDialog();
}

function bindDragAndDrop() {
  let depth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer || Array.from(e.dataTransfer.types || []).indexOf('Files') < 0) return;
    e.preventDefault();
    depth++;
    document.body.classList.add('drag-over');
  });
  window.addEventListener('dragover', (e) => {
    if (e.dataTransfer) e.preventDefault();
  });
  window.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) document.body.classList.remove('drag-over');
  });
  window.addEventListener('drop', async (e) => {
    if (!e.dataTransfer) return;
    e.preventDefault();
    depth = 0;
    document.body.classList.remove('drag-over');
    const files = Array.from(e.dataTransfer.files || []);
    if (!files.length) return;
    if (files.every((f) => /\.json$/i.test(f.name || ''))) {
      await handleBackupFile(files[0]);
      return;
    }
    await handleReportFiles(files);
  });
}

function applyBannerState() {
  if (!els.riskBanner) return;
  els.riskBanner.classList.toggle('hidden', !!(state.settings.ui && state.settings.ui.bannerDismissed));
}

function setupHashRouting() {
  window.addEventListener('hashchange', () => {
    const page = (location.hash || '').replace('#', '');
    if (PAGES.includes(page) && page !== state.activePage) {
      navigate(page, { noPersist: true, noHash: true });
    }
  });
}

function setupDebugApi() {
  // 给验收脚本 / 控制台调试用的稳定入口（不参与业务逻辑）
  window.__workbench = {
    version: APP_VERSION,
    hasExtension: HAS_EXTENSION,
    storageKeys: Object.assign({}, STORAGE_KEYS),
    get state() { return state; },
    get lib() { return lib; },
    get libState() { return libState; },
    get runtimeErrors() { return runtimeErrors.slice(); },
    showPage: (page) => { navigate(page); return page; },
    reloadLibs: () => loadLibs(),
    analyze: () => analyzeAll(),
    loadDemo: () => loadDemoReport(),
    render: () => renderAll(),
    getKpis: () => computeKpis(),
    getLibraryStats: () => getLibraryStats(),
    getStats: () => ensureStats(true),
    // ---- v2.1 新增调试 API ----
    setTheme: (theme) => {
      const next = setThemeSetting(theme);
      return getThemeInfo();
    },
    getTheme: () => getThemeInfo(),
    getReviewSummary: () => getReviewSummary(),
    confirmReviewAll: (filteredOnly) => {
      const confirmed = confirmReviewRows(filteredOnly !== false);
      return Promise.resolve({ confirmed, summary: getReviewSummary() });
    },
    showStatsStore: (name) => {
      const value = !name || name === 'all' ? '' : String(name);
      const valid = !value || statsStoreOptions().some((s) => s.name === value);
      state.statsStore = valid ? value : '';
      state.statsBrandSearch = '';
      if (els.statsBrandSearch) els.statsBrandSearch.value = '';
      navigate('stats');
      renderStats();
      return state.statsStore || 'all';
    },
    getColumnValue: (sku, field) => getColumnValue(sku, field),
    simulateCaptures: (captures) => simulateCaptures(captures),
    getStatsStore: () => state.statsStore || 'all',
    // ---- v2.1.2 商品页预览（小眼睛）----
    previewSku: (sku, opts) => previewSku(sku, opts || {}),
    closePreview: () => closePreview(),
    getPreviewState: () => getPreviewState(),
    // ---- v2.1.3 配对总览 / 当前价格列 ----
    showOverview: (opts) => {
      const options = opts || {};
      if (options.store != null) state.overview.store = String(options.store) === 'all' ? '' : String(options.store);
      if (options.status != null) state.overview.status = String(options.status) || 'all';
      if (options.search != null) state.overview.search = String(options.search);
      if (options.pageSize != null) state.overview.pageSize = Number(options.pageSize) || 0;
      state.overview.page = 1;
      navigate('overview');
      renderOverview();
      return {
        store: state.overview.store || 'all',
        status: state.overview.status,
        search: state.overview.search,
        pageSize: state.overview.pageSize,
        rows: filteredOverviewRows().length,
      };
    },
    getOverviewRows: () => {
      const rows = filteredOverviewRows();
      const total = overviewAllRows().length;
      return {
        filtered: rows.length,
        total,
        sample: rows.slice(0, 10).map((item) => ({
          sku: item.row.sku,
          report: item.report ? item.report.fileName : '',
          rowNo: item.row.rowNo,
          brand: item.row.brand,
          model: item.row.model,
          package: item.row.package,
          size: item.row.size,
          price: item.row.price,
          priceNow: item.row.capturePrice == null ? null : Number(item.row.capturePrice),
          libState: rowLibState(item.row, item.report),
          status: rowStatusInfo(item.row).text,
        })),
      };
    },
    editOverviewCell: (sku, field, value) => saveOverviewCell(sku, field, value),
    // ---- v2.1.4 匹配库核验 / 频控 / 预览人工读数 / 种子迁移 ----
    getLibraryStates: () => getLibraryStates(),
    confirmLibraryWrite: (skus) => {
      let items = [];
      if (Array.isArray(skus) && skus.length) {
        const wanted = new Set(skus.map((s) => String(s)));
        for (const report of state.session.reports || []) {
          for (const row of reportRows(report)) {
            if (wanted.has(String(row.sku))) items.push({ row, report });
          }
        }
      } else {
        for (const report of state.session.reports || []) {
          for (const row of reportRows(report)) {
            if (rowLibState(row, report) === 'pending') items.push({ row, report });
          }
        }
      }
      return confirmLibraryWriteRows(items);
    },
    previewRead: (sku) => previewRead(sku),
    applyPreviewRead: () => applyPreviewReadToRow(),
    getRiskState: () => getRiskState(),
    simulateRisk: (risk) => {
      handleCaptureRisk(risk || { hit: true, reason: '手动模拟风控', url: 'https://www.shop.example.com/', at: nowIso() });
      return getRiskState();
    },
    clearRiskCooldown: () => { clearCooldown(); return getRiskState(); },
    migrateSeed: (mode) => runSeedMigration(typeof mode === 'string' ? mode : mode === true ? 'replace' : 'merge-missing'),
    // ---- v2.1.5 表格列显隐 / 行高 / 列筛选 / 异常等待 / 匹配库保护与日志 / 类目合并 ----
    getTableCols: (ctx) => tableCols(ctx === 'overview' ? 'overview' : 'match'),
    setTableColumn: (ctx, key, visible) => {
      const useCtx = ctx === 'overview' ? 'overview' : 'match';
      saveTableCols(useCtx, { [key]: !!visible });
      if (useCtx === 'match') renderMatchTable(); else renderOverview();
      renderColumnMenu(useCtx);
      return tableCols(useCtx);
    },
    getRowDensity: () => rowDensity(),
    setRowDensity: (value) => { saveRowDensity(value); return rowDensity(); },
    getColumnFilters: (ctx) => JSON.parse(JSON.stringify((state.columnFilters || {})[ctx === 'overview' ? 'overview' : 'match'] || {})),
    setColumnFilter: (ctx, key, filter) => {
      const useCtx = ctx === 'overview' ? 'overview' : 'match';
      state.columnFilters[useCtx] = state.columnFilters[useCtx] || {};
      if (filter == null) delete state.columnFilters[useCtx][key];
      else state.columnFilters[useCtx][key] = Object.assign({}, filter);
      if (useCtx === 'match') renderMatchTable(); else renderOverview();
      syncHeaderFilterButtons(useCtx);
      return JSON.parse(JSON.stringify(state.columnFilters[useCtx]));
    },
    clearColumnFilters: (ctx) => {
      const useCtx = ctx === 'overview' ? 'overview' : 'match';
      state.columnFilters[useCtx] = {};
      if (useCtx === 'match') renderMatchTable(); else renderOverview();
      syncHeaderFilterButtons(useCtx);
      return {};
    },
    getLibraryBackup: () => (state.libraryBackup
      ? { key: LIBRARY_BACKUP_KEY, at: state.libraryBackup.at, rows: countLibraryRows(state.libraryBackup.library || {}), reason: state.libraryBackup.reason || '' }
      : null),
    restoreLibraryBackup: () => restoreLibraryBackupV215(),
    getLibraryLogs: () => libraryLogRowsForUi(),
    getAnomalyState: () => ({
      active: !!state.capture.anomaly,
      waitSec: anomalyWaitConfigSec(),
      anomaly: state.capture.anomaly ? Object.assign({}, state.capture.anomaly) : null,
    }),
    getCaptureBatchPlan: (total) => {
      const plan = planCaptureBatch(new Array(Math.max(0, Math.floor(Number(total) || 0))), state.settings.capture);
      return { maxBatch: plan.maxBatch, total: plan.total, queued: plan.queued, truncated: plan.truncated };
    },
    mergeStoresPreview: (options) => mergeStoresPreview(options),
    mergeStoresApply: (options) => mergeStoresApply(options),
    dedupeStoreApply: (storeName) => dedupeStoreApply(storeName),
    getMergeSupport: () => ({ mergeStores: libMergeSupport(), dedupeStore: libDedupeSupport() }),
    // ---- v2.1.6 人工核验定位（DESIGN §21.3）----
    getReviewCounts: () => ({
      match: reviewLocateCounts(activeReportRowsForCounts()),
      overview: reviewLocateCounts(allReportRowsForCounts()),
      kpi: (() => {
        const k = computeKpis();
        return { sizeReview: k.sizeReview, missingSize: k.missingSize, missingPrice: k.missingPrice, total: k.total };
      })(),
    }),
    getQuickFilter: () => ({ match: state.filter.status, overview: state.overview.status }),
    // ---- v2.1.7 价格类型 / 候选调试 / 下架分母（DESIGN §22）----
    getPriceDebug: (sku) => {
      const clean = String(sku == null ? '' : sku).trim();
      const found = clean ? findRowContextBySku(clean) : null;
      return buildPriceDebugPayload(found ? found.row : null, clean);
    },
    openPriceDebug: (sku) => openPriceDebug(sku),
    getLastCaptureDebug: () => getLastCaptureDebug(),
    getOffSaleStats: () => {
      const k = computeKpis();
      return { offSale: k.offSale, validTotal: k.validTotal, pending: k.pendingValid, total: k.total, progressDenom: k.progressDenom, progressPct: k.progressPct };
    },
    getPriceKindLabel: (sku) => {
      const clean = String(sku == null ? '' : sku).trim();
      const found = clean ? findRowContextBySku(clean) : null;
      return priceKindLabelFor(found ? found.row : null);
    },
    simulateCaptureProgress: (p) => { onCaptureProgress(p || {}); return state.capture.progress; },
    simulateCaptureResult: (payload) => { onCaptureResult(payload || {}); return getLastCaptureDebug(); },
    // QA 排障：直接给当前统计的分档清单（含 dynamic/missing 标记），避免只能看 count
    getBandLists: () => {
      const stats = ensureStats(true) || {};
      return {
        size: (stats.bySize || []).map((b) => ({ band: b.band, rows: b.rows, dynamic: !!b.dynamic, missing: !!b.missing })),
        price: (stats.byPrice || []).map((b) => ({ band: b.band, rows: b.rows, dynamic: !!b.dynamic, missing: !!b.missing })),
      };
    },
    // ---- v2.0 已有导出/调试入口 ----
    exportBackup,
    exportBackfill,
    exportBackfillAll,
    exportResult,
    exportCsv,
  };
}

/* ============================ 初始化 ============================ */

async function init() {
  state.settings = cloneSettings(null);
  state.session = clone(DEFAULT_SESSION);
  setEnvBadge();
  bindEvents();
  renderSettingsForm();
  renderModuleStatus();

  // 先读存储，再加载 lib（lib 加载失败不影响界面渲染），最后导入种子
  await loadStoredData();
  const hadStoredLibrary = !!state.hadStoredLibrary;
  // 主题要在首屏渲染前应用（settings 已加载），并监听系统主题变化（auto 模式）
  applyTheme();
  bindThemeMediaListener();
  await loadLibs();
  // v2.1.5：LIB_STATE_LABELS 以 lib 为准（已确认/待确认等），UI 不再写死
  try {
    if (lib.pipeline && lib.pipeline.LIB_STATE_LABELS && typeof lib.pipeline.LIB_STATE_LABELS === 'object') {
      Object.assign(LIB_STATE_LABELS, lib.pipeline.LIB_STATE_LABELS);
    }
  } catch (e) { /* ignore */ }
  await initLibrary();
  // ===== v2.1.5 匹配库保护（DESIGN 20.11）=====
  // 红线：绝不自动 replace / 绝不覆盖用户已有记录；先快照，再只做 merge-missing。
  await loadLibraryBackupMeta();
  if (hadStoredLibrary && !state.libraryBackup) {
    await ensureLibraryBackupV215(false);
  }
  try {
    const seedForCheck = await fetchSeedRaw();
    if (seedForCheck) rememberSeedBands(seedForCheck);
    const storedFp = String((state.library.meta && state.library.meta.fingerprint) || '');
    const seedFp = String((seedForCheck && (seedForCheck.fingerprint || seedForCheck.schemaVersion)) || '');
    const fingerprintDiffers = storedFp && seedFp ? storedFp !== seedFp : !!seedFp;
    const canMerge = hadStoredLibrary && !!seedForCheck && lib.storeSchema && typeof lib.storeSchema.applySeedMigration === 'function'
      && fingerprintDiffers;
    if (canMerge) {
      const mergeRes = await runSeedMigration('merge-missing');
      logLine('匹配库受保护：仅合并缺失 SKU（新增 ' + ((mergeRes && mergeRes.added) || 0) + ' 条，保留 ' + ((mergeRes && mergeRes.kept) || 0) + ' 条），未覆盖用户记录');
    } else {
      logLine('匹配库受保护：指纹一致或无需合并，未执行任何覆盖性迁移（' + (storedFp || '无指纹') + '）');
    }
  } catch (e) {
    logLine('匹配库合并缺失 SKU 检查失败（已跳过，不影响现有库）：' + humanError(e));
  }
  applyBannerState();
  ensureDatalists();
  // v2.1.3：先清理旧版「标题推测套餐」，再回填采集缓存（避免页面采集来源的套餐被误清）
  await runV213Migration();
  applyCachedCapturesAtStartup();
  // v2.1.4：恢复风控冷却状态 + 重新标注入库状态
  state.capture.cooldownUntil = cooldownUntilMs();
  invalidateLibraryStates();
  renderRiskAlert();
  renderLibraryBackupInfo();
  renderSeedVersionText();
  // v2.1.5：表格列/行高/列悬停/表头筛初始化
  try {
    applyRowDensity();
    renderColumnMenu('match');
    renderColumnMenu('overview');
    initHeaderFilterButtons();
    bindColumnHover(els.matchBody);
    bindColumnHover(els.overviewTable);
    bindColumnHover(els.libTable);
  } catch (e) {
    logLine('表格增强初始化失败（已降级）：' + humanError(e));
  }

  const hashPage = (location.hash || '').replace('#', '');
  const lastPage = state.settings.ui && state.settings.ui.lastPage;
  const target = PAGES.includes(hashPage) ? hashPage : PAGES.includes(lastPage) ? lastPage : 'workbench';
  navigate(target, { noPersist: true });
  renderAll();

  // 预览模式自动载入演示榜单（?demo=1），方便本地预览与验收截图
  try {
    const params = new URLSearchParams(location.search);
    if (params.get('demo') === '1' && !(state.session.reports || []).length) loadDemoReport();
  } catch (e) { /* ignore */ }

  setupHashRouting();
  setupDebugApi();
  ensurePreviewWindowListener();
  logLine('工作台就绪（v' + APP_VERSION + '，' + (HAS_EXTENSION ? '扩展模式' : '预览模式') + '）');
}

// 未处理的异步错误：给中文 toast + 日志，避免界面静默失败
window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason;
  rememberError((reason && reason.message) || reason);
  logLine('未处理的异步错误：' + ((reason && reason.message) || reason));
  toast('操作未完成：' + humanError(reason), 'error');
  if (e.preventDefault) e.preventDefault();
});

init().catch((err) => {
  rememberError('初始化失败：' + ((err && err.message) || err));
  try {
    const box = document.createElement('div');
    box.className = 'banner engine-banner';
    box.style.cssText = 'margin:16px 22px 0;position:relative;z-index:5;';
    box.innerHTML = '<div class="banner-main"><b>工作台初始化失败：</b>' + esc(humanError(err)) +
      '。请到 edge://extensions 重新加载扩展后再试。</div>';
    document.body.insertBefore(box, document.body.firstChild);
  } catch (e) { /* ignore */ }
  logLine('初始化失败：' + ((err && err.message) || err));
});

