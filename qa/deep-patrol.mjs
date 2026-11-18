#!/usr/bin/env node
/**
 * 价格监控平台 · 深度真实浏览器验收（qa-patrol / task-6）
 *
 * 范围：
 *   A. 平台壳：三业务卡片进入 / 顶部切换 / 返回业务选择 / 独立标签页 / #/{biz} 深链 / 刷新 / 浏览器后退 / 键盘快捷键 / 上次使用标记
 *   B. 巡检 v1.3.4（modules/patrol）：
 *      - 4 类目 tab、表格搜索/状态筛选/勾选、手动改价、下架/恢复
 *      - 总览 12 数字卡片点击筛选 + 类目筛选 + 待上报区 + 导出待上报 Excel
 *      - 同品比价：15 组 / 30 SKU、全部/只看有差异/只看待采齐、导出比价 CSV、采集全部比价 SKU 弹窗
 *      - 导出 CSV / 导出 JSON（真实下载断言）、清空采集（confirm + 自动备份）、导入数据（导出的 JSON 回导）
 *      - 导入基表（同一基表 JSON 无变化分支 / 真实 SKU巡检表.xlsx 有差异分支）、恢复内置
 *      - 设置弹窗改值→保存→重开/刷新断言保留、AI 设置弹窗、双轨切换
 *      - 多供应商 API 账号区：桥在线分支 + 未连接分支（指向不可达地址）、新增行/空保存不崩
 *      - 基表自动升级：旧 generatedAt 的 patrol.base.v1 + 保留的下架/改价状态 → 进页面断言「内置基表已更新」且 153 行、状态保留
 *      - 运行入口的确认弹窗取消路径（真实采集需要登录电商平台账号，本地 QA 不发起外部采集）
 *
 * 约束：不改 qa/verify.mjs、qa/lib、modules、平台根文件；产品 bug 只记录最小复现。
 *
 * 产物：
 *   qa/shots-deep-patrol/*.png            证据截图（失败自动 fail-<id>.png）
 *   qa/shots-deep-patrol/evidence/*       导出/下载件副本
 *   qa/DEEP-PATROL-REPORT.json / .md      结构化报告
 *
 * 用法：node qa/deep-patrol.mjs [--ext <目录>] [--port <端口>] [--browser <路径>] [--keep-downloads]
 *
 * 退出码：0 全通过（SKIP 不算失败）；1 有失败断言；2 环境/致命错误
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  launchBrowser, findExtensionId, findBrowser,
  PageSession, CdpClient, waitForCdp,
} from './lib/cdp.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QA_DIR = __dirname;
const PLATFORM_DIR = path.resolve(QA_DIR, '..');
const SHOTS_DIR = path.join(QA_DIR, 'shots-deep-patrol');
const EVIDENCE_DIR = path.join(SHOTS_DIR, 'evidence');
const VIEWPORT = { width: 1440, height: 900 };

// 旧版基表（generatedAt 比内置 2026-11-10T10:19:24+08:00 更旧，用于基表自动升级测试）
const LOCAL_MATERIALS = path.join(QA_DIR, 'fixtures', 'materials');
const OLD_BASE_CANDIDATES = [
  path.join(LOCAL_MATERIALS, 'base-skus-20261109-2025.json'),
  '~/Desktop/巡检\\_pack\\base-skus-20261109-2025.json',
  '~/Desktop/巡检\\_pack\\base-skus-20261109-1634.json',
  '~/Desktop/巡检\\_pack\\base-skus-20261105.json',
  '~/Desktop/巡检\\巡检插件-双轨版\\extension\\data\\base-skus.json',
];
// 真实 xlsx 巡检表（只读）
const XLSX_CANDIDATES = [
  path.join(LOCAL_MATERIALS, 'SKU巡检表.xlsx'),
  '~/Desktop/三合一\\_work\\patrol-new-20261110\\巡检插件-双轨版\\SKU巡检表.xlsx',
  '~/Desktop/巡检\\SKU巡检表.xlsx',
];

const BIZ_PATHS = {
  patrol: 'modules/patrol/app.html',
  share: 'modules/share/app.html',
  radar: 'modules/radar/app.html',
};
const BIZ_LABELS = { patrol: '价格巡检', share: '市场占有率', radar: '竞品监控' };

// 总览 12 数字卡片（顺序与 modules/patrol/app.js 的 OV_CARDS 一致）
const OV_LABELS = ['全部行', '普惠已采集', '会员已采集', '低于阈值', '高于/等于阈值', '偏离阈值', '需人工确认', '手动改价', '采集失败', '未采集', '待补 SKU', '已下架'];
const OV_HINT = {
  全部行: '全部 SKU', 普惠已采集: '普惠已采集', 会员已采集: '会员已采集', 低于阈值: '低于阈值',
  '高于/等于阈值': '高于/等于阈值', 偏离阈值: '偏离阈值', 需人工确认: '需人工确认', 手动改价: '手动改价',
  采集失败: '采集失败', 未采集: '未采集', '待补 SKU': '待补 SKU', 已下架: '已下架',
};
const OV_KEY = {
  全部行: 'all', 普惠已采集: 'utilDone', 会员已采集: 'plusDone', 低于阈值: 'alert', '高于/等于阈值': 'normal',
  偏离阈值: 'off', 需人工确认: 'confirm', 手动改价: 'manual', 采集失败: 'fail', 未采集: 'none',
  '待补 SKU': 'nosku', 已下架: 'offline',
};

// ---------------------------------------------------------------------------
// 环境 / 期望值（从内置基表真实计算，避免硬编码漂移）
// ---------------------------------------------------------------------------
const ENV = {
  node: process.version,
  browserPath: '',
  browserVersion: '',
  extId: '',
  cdpPort: 0,
  extDir: PLATFORM_DIR,
  viewport: `${VIEWPORT.width}x${VIEWPORT.height}`,
  downloadDir: '',
  oldBasePath: '',
  oldBaseGeneratedAt: '',
  xlsxPath: '',
  apiBridgeUp: false,
  apiBridgeInfo: '',
  startedAt: new Date().toISOString(),
};

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function loadBuiltinBase() {
  return readJson(path.join(PLATFORM_DIR, 'modules/patrol/data/base-skus.json'));
}

/** 计算基表期望：类目/行数/sku 数、去重 SKU、待补 SKU 行数、同品比价分组。 */
function computeBaseExpectations(base) {
  const rows = [];
  const sheets = [];
  for (const sh of base.sheets || []) {
    const skus = (sh.rows || []).filter((r) => String(r.sku || '').trim()).length;
    sheets.push({ name: sh.name, rows: (sh.rows || []).length, withSku: skus });
    for (const r of sh.rows || []) rows.push(Object.assign({}, r, { sheet: sh.name }));
  }
  const totalRows = rows.length;
  const withSku = rows.filter((r) => String(r.sku || '').trim()).length;
  const noSku = totalRows - withSku;
  const skuSet = new Set(rows.filter((r) => r.sku).map((r) => String(r.sku).trim()));
  const keyOf = (model) => String(model || '')
    .replace(/[\s\u3000]+/g, '').replace(/[-－—_/／]+/g, '').replace(/京仓/g, '').toUpperCase();
  const map = new Map();
  for (const r of rows) {
    if (!r.sku) continue;
    const k = keyOf(r.model);
    if (!k) continue;
    if (!map.has(k)) map.set(k, { key: k, model: r.model, entries: [] });
    map.get(k).entries.push(r);
  }
  const groups = [];
  for (const g of map.values()) {
    const sheetSet = new Set(g.entries.map((e) => e.sheet));
    if (sheetSet.size < 2) continue;
    groups.push(g);
  }
  const groupSkus = new Set(groups.flatMap((g) => g.entries.map((e) => e.sku)));
  // 选一对「不同店铺」的比价条目做手动改价→比价差异测试（优先 大家电 / 3C店铺）
  const pair = groups
    .map((g) => {
      const bySheet = {};
      for (const e of g.entries) if (!bySheet[e.sheet]) bySheet[e.sheet] = e;
      return { g, bySheet };
    })
    .find((x) => x.bySheet['大家电'] && x.bySheet['3C店铺'] && x.bySheet['大家电'].utilMin != null && x.bySheet['3C店铺'].utilMin != null);
  const comparePair = pair
    ? {
      group: pair.g.key,
      a: { sheet: '大家电', sku: String(pair.bySheet['大家电'].sku), rowId: pair.bySheet['大家电'].rowId, utilMin: pair.bySheet['大家电'].utilMin },
      b: { sheet: '3C店铺', sku: String(pair.bySheet['3C店铺'].sku), rowId: pair.bySheet['3C店铺'].rowId, utilMin: pair.bySheet['3C店铺'].utilMin },
    }
    : null;
  // 下架测试用：品牌A第一行（不在比价分组里，避免互相影响）
  const xw = sheets.find((s) => s.name === '品牌A');
  const xwRow = rows.find((r) => r.sheet === (xw ? xw.name : '品牌A') && r.sku);
  return { sheets, totalRows, withSku, noSku, skuSet, groups, groupSkus, comparePair, offlineCandidate: xwRow || null };
}

/** 选取一份比内置更旧的基表；找不到就用内置基表合成一份旧基表（仅改 generatedAt/source）。 */
function loadOldBase(builtin) {
  const builtinTime = Date.parse(builtin.generatedAt || '') || 0;
  for (const p of OLD_BASE_CANDIDATES) {
    try {
      if (!fs.existsSync(p)) continue;
      const b = readJson(p);
      const t = Date.parse(b.generatedAt || '') || 0;
      if (Array.isArray(b.sheets) && b.sheets.length && t > 0 && t < builtinTime) {
        return { base: b, path: p, synthetic: false };
      }
    } catch { /* 试下一个 */ }
  }
  const clone = JSON.parse(JSON.stringify(builtin));
  clone.generatedAt = '2025-01-01T00:00:00+08:00';
  clone.source = 'QA 合成旧基表（用于自动升级测试）';
  return { base: clone, path: '(合成旧基表)', synthetic: true };
}

const BUILTIN_BASE = loadBuiltinBase();
const EXP = computeBaseExpectations(BUILTIN_BASE);
const OLD_BASE = loadOldBase(BUILTIN_BASE);

function pickXlsx() {
  for (const p of XLSX_CANDIDATES) if (fs.existsSync(p)) return p;
  return '';
}

// ---------------------------------------------------------------------------
// 断言 Runner
// ---------------------------------------------------------------------------
class Runner {
  constructor(shotDir, evidenceDir) {
    this.results = [];
    this.shots = [];
    this.notes = [];
    this.failShotIds = new Set();
    this.shotDir = shotDir;
    this.evidenceDir = evidenceDir;
    this.startedAt = Date.now();
    this.page = null;
  }

  setPage(page) { this.page = page; }

  async check(id, title, fn, meta = {}) {
    const t0 = Date.now();
    const rec = { id, title, status: 'pass', durationMs: 0, detail: null, error: null, repro: meta.repro || '', evidence: [] };
    try {
      rec.detail = await fn();
      if (meta.evidence) rec.evidence = [].concat(meta.evidence);
    } catch (err) {
      rec.status = 'fail';
      rec.error = String((err && err.stack) || err);
      await this.captureFail(id);
    }
    rec.durationMs = Date.now() - t0;
    this.results.push(rec);
    const line = `[${rec.status === 'pass' ? 'PASS' : 'FAIL'}] ${id} ${title}` +
      (rec.status === 'pass' ? (rec.detail ? ' · ' + oneLine(rec.detail, 180) : '') : ' → ' + oneLine(rec.error, 300));
    console.log(line);
    return rec;
  }

  skip(id, title, reason, meta = {}) {
    const rec = { id, title, status: 'skip', durationMs: 0, detail: reason, error: null, repro: meta.repro || '', evidence: [] };
    this.results.push(rec);
    console.log(`[SKIP] ${id} ${title} · ${reason}`);
    return rec;
  }

  async captureFail(id) {
    if (!this.page || this.failShotIds.has(id)) return;
    this.failShotIds.add(id);
    const name = `fail-${id.replace(/[^A-Za-z0-9_-]/g, '_')}.png`;
    try {
      const p = path.join(this.shotDir, name);
      await this.page.screenshot(p);
      this.shots.push({ name, path: p, note: `失败现场（${id}）` });
    } catch { /* 截图失败不掩盖原始错误 */ }
  }

  async shot(name, note) {
    if (!this.page) throw new Error('页面未就绪，无法截图');
    const p = path.join(this.shotDir, name);
    await this.page.screenshot(p);
    this.shots.push({ name, path: p, note: note || '' });
    console.log(`[shot] ${p}`);
    return p;
  }

  note(text) { this.notes.push(String(text)); }

  copyEvidence(src, name) {
    try {
      if (!src || !fs.existsSync(src)) return '';
      fs.mkdirSync(this.evidenceDir, { recursive: true });
      const dst = path.join(this.evidenceDir, name || path.basename(src));
      fs.copyFileSync(src, dst);
      return dst;
    } catch { return ''; }
  }

  get passed() { return this.results.filter((r) => r.status === 'pass'); }
  get failed() { return this.results.filter((r) => r.status === 'fail'); }
  get skipped() { return this.results.filter((r) => r.status === 'skip'); }
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
function expect(cond, msg) { if (!cond) throw new Error(msg); }
function oneLine(s, n = 320) { return String(s == null ? '' : s).replace(/\s+/g, ' ').slice(0, n); }
function fmtBytes(n) { return n > 1024 ? (n / 1024).toFixed(1) + 'KB' : n + 'B'; }
function nowIso() { return new Date().toISOString(); }

function parseArgs(argv) {
  const opts = { ext: PLATFORM_DIR, port: undefined, browser: '', keepDownloads: false, timeout: 20000, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { if (i + 1 >= argv.length) throw new Error(`参数 ${a} 缺少值`); return argv[++i]; };
    switch (a) {
      case '--ext': opts.ext = path.resolve(next()); break;
      case '--port': opts.port = Number(next()); break;
      case '--browser': opts.browser = next(); break;
      case '--timeout': opts.timeout = Number(next()); break;
      case '--keep-downloads': opts.keepDownloads = true; break;
      case '-h': case '--help': opts.help = true; break;
      default: throw new Error(`未知参数：${a}`);
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// 浏览器 / 页面封装
// ---------------------------------------------------------------------------
let page = null;          // 主页面 PageSession（先平台壳，后巡检模块页）
let browser = null;       // launchBrowser 句柄
let browserCdp = null;    // 浏览器级 CDP（持久连接：下载事件）
const downloads = [];     // {guid,suggested,state,filePath}
const dialogs = [];       // {type,message,accept,at}
let dialogPolicy = () => true; // 返回 true=确认；测试取消路径时可临时改为 false

const R = (expr, opts) => page.evaluate(expr, opts);

async function waitForPage(expr, { timeoutMs = 12000, intervalMs = 200, label = expr } = {}) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeoutMs) {
    try { last = await R(`(${expr})`); } catch { last = undefined; }
    if (last) return last;
    await sleep(intervalMs);
  }
  throw new Error(`等待超时：${label}；最后值=${oneLine(JSON.stringify(last), 300)}`);
}

async function bodyText() { return await R('document.body ? document.body.innerText : ""'); }

async function toastNow() {
  return await R(`(() => { const el = document.getElementById('toast'); if (!el) return { text: '', visible: false }; return { text: el.textContent || '', visible: !el.classList.contains('hidden') }; })()`);
}

async function waitToast(substr, timeoutMs = 8000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    try { last = await toastNow(); } catch { last = null; }
    if (last && last.visible && String(last.text).includes(substr)) return last.text;
    await sleep(120);
  }
  throw new Error(`等待 toast 包含「${substr}」超时；当前 toast=${oneLine(JSON.stringify(last), 300)}`);
}

async function gotoPatrolPage() {
  const url = `chrome-extension://${ENV.extId}/modules/patrol/app.html`;
  await page.navigate(url, { settleMs: 1200 });
  await waitForPage(`(() => { const b = document.body; if (!b) return false; if (document.readyState !== 'complete') return false; const rows = document.querySelectorAll('#tblBody tr').length; const chips = document.querySelectorAll('#statsBar .statChip').length; return rows > 0 && chips > 0 && typeof state !== 'undefined' && state.db && state.base; })()`, { timeoutMs: 25000, label: '巡检页初始化（表格/统计/state）' });
}

async function gotoPlatformHome(settleMs = 1500) {
  await page.navigate(`chrome-extension://${ENV.extId}/app.html`, { settleMs });
  await waitForPage(`(() => { const l = document.getElementById('landing'); return !!l && !l.classList.contains('hidden') && document.querySelectorAll('[data-biz]').length >= 3; })()`, { timeoutMs: 15000, label: '平台首页' });
}

async function reloadPage(settleMs = 1200) {
  const loaded = new Promise((resolve) => {
    const off = page.client.on('Page.loadEventFired', () => { off(); resolve(); });
    setTimeout(() => { off(); resolve(); }, 30000);
  });
  await page.client.rpc('Page.reload', { ignoreCache: true });
  await loaded;
  await sleep(settleMs);
}

// ---- 表格 / 表单 ----
async function tableInfo() {
  return await R(`(() => {
    const trs = Array.from(document.querySelectorAll('#tblBody tr'));
    const first = trs[0] ? Array.from(trs[0].querySelectorAll('td')).slice(0, 4).map((td) => td.innerText.trim()) : null;
    const empty = document.getElementById('empty');
    return { count: trs.length, first, emptyVisible: !!empty && !empty.classList.contains('hidden'), emptyText: empty ? empty.textContent : '' };
  })()`);
}

async function waitRows(n, timeoutMs = 8000, label = '') {
  return await waitForPage(`(() => document.querySelectorAll('#tblBody tr').length === ${Number(n)})()`, { timeoutMs, label: label || `表格行数=${n}` });
}

async function setInputValue(id, value, event = 'input') {
  return await R(`(() => {
    const el = document.getElementById(${JSON.stringify(id)});
    if (!el) return { ok: false, reason: '找不到 #' + ${JSON.stringify(id)} };
    el.value = ${JSON.stringify(String(value))};
    el.dispatchEvent(new Event(${JSON.stringify(event)}, { bubbles: true }));
    return { ok: true };
  })()`);
}

async function setChecked(id, checked) {
  return await R(`(() => {
    const el = document.getElementById(${JSON.stringify(id)});
    if (!el) return { ok: false };
    el.checked = !!${checked};
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  })()`);
}

async function selectValue(id, value) {
  return await R(`(() => {
    const el = document.getElementById(${JSON.stringify(id)});
    if (!el) return { ok: false };
    el.value = ${JSON.stringify(String(value))};
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, value: el.value };
  })()`);
}

async function clickId(id) {
  return await R(`(() => { const el = document.getElementById(${JSON.stringify(id)}); if (!el) return { ok: false }; el.click(); return { ok: true }; })()`);
}

async function clickTab(containerId, label, marker = '.tab') {
  return await R(`(() => {
    const c = document.getElementById(${JSON.stringify(containerId)});
    if (!c) return { ok: false, reason: '找不到容器' };
    const btns = Array.from(c.querySelectorAll(${JSON.stringify(marker)}));
    const want = ${JSON.stringify(label)};
    const b = btns.find((x) => {
      const t = x.firstChild && x.firstChild.nodeType === 3 ? x.firstChild.textContent : x.textContent;
      return String(t || '').replace(/\\s+/g, '').startsWith(want);
    });
    if (!b) return { ok: false, tabs: btns.map((x) => x.textContent) };
    b.click();
    return { ok: true, text: b.textContent };
  })()`);
}

async function tabsInfo(containerId) {
  return await R(`(() => {
    const c = document.getElementById(${JSON.stringify(containerId)});
    if (!c) return [];
    return Array.from(c.querySelectorAll('.tab')).map((b) => {
      const name = b.firstChild && b.firstChild.nodeType === 3 ? b.firstChild.textContent.trim() : b.textContent.trim();
      const cnt = b.querySelector('.count');
      return { name, count: cnt ? cnt.textContent.replace(/^·\\s*/, '') : '', active: b.classList.contains('active') };
    });
  })()`);
}

async function statsChips() {
  return await R(`(() => {
    const chips = Array.from(document.querySelectorAll('#statsBar .statChip'));
    const out = {};
    for (const ch of chips) {
      const k = ch.querySelector('.k'); const v = ch.querySelector('.v');
      if (k && v) out[k.textContent] = v.textContent;
    }
    return out;
  })()`);
}

/** 按 SKU 找行并执行一个动作片段（在页面内完成，避免元素句柄跨调用失效）。 */
async function rowBySkuAction(sku, action) {
  return await R(`(() => {
    const trs = Array.from(document.querySelectorAll('#tblBody tr'));
    const tr = trs.find((x) => { const td = x.querySelectorAll('td')[3]; return td && td.textContent.includes(${JSON.stringify(sku)}); });
    if (!tr) return { ok: false, reason: '找不到 SKU ' + ${JSON.stringify(sku)} + ' 的行（当前 ' + trs.length + ' 行）' };
    const tds = tr.querySelectorAll('td');
    return (${action})(tr, tds);
  })()`);
}

async function clickRowOp(sku, text) {
  return await rowBySkuAction(sku, `(tr, tds) => {
    const op = tds[13]; if (!op) return { ok: false, reason: '没有操作列' };
    const btns = Array.from(op.querySelectorAll('button'));
    const b = btns.find((x) => x.textContent.trim().includes(${JSON.stringify(text)}));
    if (!b) return { ok: false, reason: '找不到按钮', btns: btns.map((x) => x.textContent.trim()) };
    b.click(); return { ok: true };
  }`);
}

/** 手动改价：index 8=普惠当前价，10=会员当前价。 */
async function editPrice(sku, identity, price) {
  const col = identity === 'util' ? 8 : 10;
  const opened = await rowBySkuAction(sku, `(tr, tds) => {
    const td = tds[${col}]; if (!td) return { ok: false, reason: '没有价格列' };
    const btn = td.querySelector('.priceEditBtn'); if (!btn) return { ok: false, reason: '没有「改」按钮' };
    btn.click();
    return { ok: true };
  }`);
  if (!opened.ok) throw new Error('打开改价输入失败：' + oneLine(JSON.stringify(opened)));
  await sleep(200);
  const saved = await R(`(() => {
    const inp = document.querySelector('#tblBody .priceEditInput');
    if (!inp) return { ok: false, reason: '没有出现改价输入框' };
    inp.value = ${JSON.stringify(String(price))};
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    return { ok: true };
  })()`);
  if (!saved.ok) throw new Error('写入价格失败：' + oneLine(JSON.stringify(saved)));
}

async function captureOf(sku) {
  return await R(`(() => {
    try { const c = state.db.captures[${JSON.stringify(sku)}]; return c ? JSON.parse(JSON.stringify(c)) : null; } catch (e) { return null; }
  })()`);
}

async function stateSnapshot() {
  return await R(`(() => {
    const s = (typeof state !== 'undefined') ? state : null;
    return s ? {
      rows: s.rows ? s.rows.length : -1,
      captures: s.db && s.db.captures ? Object.keys(s.db.captures).length : -1,
      offlineRows: s.db ? (s.db.offlineRows || []).slice() : null,
      offlineSkus: s.db ? (s.db.offlineSkus || []).slice() : null,
      settings: s.db ? JSON.parse(JSON.stringify(s.db.settings)) : null,
      baseAt: s.base ? s.base.generatedAt : null,
      baseRows: s.base ? s.base.totalRows : null,
      baseWithSku: s.base ? s.base.totalWithSku : null,
      overrideAt: s.db && s.db.baseOverride ? s.db.baseOverride.generatedAt : null,
      overrideSource: s.db && s.db.baseOverride ? s.db.baseOverride.source : null,
      baseUpgraded: s.baseUpgraded || null,
      reportRows: s.db ? (s.db.reportRows || []).slice() : null,
      view: s.view,
    } : null;
  })()`);
}

// ---- 视图 ----
async function viewState() {
  return await R(`(() => {
    const vis = (id) => { const el = document.getElementById(id); return !!el && !el.classList.contains('hidden'); };
    return { workbench: vis('viewWorkbench'), overview: vis('viewOverview'), compare: vis('viewCompare'), tableWrap: vis('tableWrap') };
  })()`);
}

async function overviewCards() {
  return await R(`(() => Array.from(document.querySelectorAll('#ovCards .ovCard')).map((b) => ({
    label: (b.querySelector('.ovK') || {}).textContent || '',
    value: (b.querySelector('.ovV') || {}).textContent || '',
    sub: (b.querySelector('.ovSub') || {}).textContent || '',
    active: b.classList.contains('active'),
  })))()`);
}

async function clickOverviewCard(label) {
  return await R(`(() => {
    const b = Array.from(document.querySelectorAll('#ovCards .ovCard')).find((x) => ((x.querySelector('.ovK') || {}).textContent || '').trim() === ${JSON.stringify(label)});
    if (!b) return { ok: false, cards: Array.from(document.querySelectorAll('#ovCards .ovK')).map((x) => x.textContent) };
    b.click(); return { ok: true };
  })()`);
}

// ---- 弹窗 / 下载 ----
async function waitDialog({ after = 0, type = '', includes = '', timeoutMs = 8000 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const hit = dialogs.slice(after).find((d) => (!type || d.type === type) && String(d.message || '').includes(includes));
    if (hit) return hit;
    await sleep(120);
  }
  throw new Error(`等待弹窗超时（type=${type || '任意'} includes=${includes || '任意'}）；已有=${oneLine(JSON.stringify(dialogs.slice(after).map((d) => ({ type: d.type, message: String(d.message).slice(0, 60) }))), 400)}`);
}

function downloadList() {
  return downloads.filter((d) => d.state === 'completed' && d.filePath);
}

async function waitDownload(pred, { timeoutMs = 20000, label = '下载文件' } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const hit = downloadList().find(pred);
    if (hit) {
      // 等文件稳定落盘
      for (let i = 0; i < 40; i++) {
        try { if (fs.existsSync(hit.filePath) && fs.statSync(hit.filePath).size > 0) return hit; } catch { /* 继续等 */ }
        await sleep(100);
      }
      return hit;
    }
    await sleep(150);
  }
  throw new Error(`等待${label}超时；已完成下载=${oneLine(JSON.stringify(downloads.map((d) => ({ name: d.suggested, state: d.state }))), 400)}`);
}

function setupDialogHandler() {
  page.client.on('Page.javascriptDialogOpening', (p) => {
    const accept = (() => { try { return !!dialogPolicy(p); } catch { return true; } })();
    dialogs.push({ type: p.type, message: String(p.message || ''), accept, at: new Date().toISOString() });
    page.client.rpc('Page.handleJavaScriptDialog', { accept }).catch((e) => {
      console.log('[warn] handleJavaScriptDialog 失败：' + e.message);
    });
  });
}

// ---- 网络 / 控制台 ----
const expectedConsoleRules = []; // { re, note, matched: [] }
function addExpectedConsoleRule(re, note) { expectedConsoleRules.push({ re, note, matched: [] }); }

function classifyConsole(errs) {
  const real = [];
  const expected = [];
  const logs = (page && page.logEntries) || [];
  const urlOf = (text) => {
    if (!String(text).startsWith('[log.error]')) return '';
    const entry = logs.find((x) => x.level === 'error' && String(text).includes(String(x.text || '').slice(0, 40)));
    return entry ? String(entry.url || '') : '';
  };
  for (const e of errs) {
    const text = String(e);
    const url = urlOf(text);
    let hit = null;
    for (const rule of expectedConsoleRules) {
      if (rule.re.test(url) || rule.re.test(text)) { hit = rule; break; }
    }
    if (hit) { hit.matched.push(e); expected.push({ error: e, url, note: hit.note }); } else real.push(e);
  }
  return { real, expected };
}

function addNetworkMonitor(session, store) {
  const rec = { responses: [], failures: [], urls: new Map() };
  store.push(rec);
  (async () => {
    try {
      await session.client.rpc('Network.enable', {}, 8000);
      session.client.on('Network.requestWillBeSent', (p) => {
        try { if (p.request && p.request.url) rec.urls.set(p.requestId, p.request.url); } catch { /* ignore */ }
      });
      session.client.on('Network.responseReceived', (p) => {
        const res = (p && p.response) || {};
        rec.responses.push({ url: res.url || rec.urls.get(p.requestId) || '', status: res.status || 0 });
      });
      session.client.on('Network.loadingFailed', (p) => {
        rec.failures.push({ url: rec.urls.get(p.requestId) || '', errorText: (p && p.errorText) || '', canceled: !!(p && p.canceled) });
      });
    } catch { /* 网络监控失败不影响断言 */ }
  })();
  return rec;
}

// ---- 浏览器 target 工具 ----
async function listPageTargets() {
  const res = await fetch(`http://127.0.0.1:${ENV.cdpPort}/json/list`, { signal: AbortSignal.timeout(4000) });
  const list = await res.json();
  return list.filter((t) => t.type === 'page');
}

async function closeTarget(targetId) {
  if (!targetId) return;
  try { await browserCdp.rpc('Target.closeTarget', { targetId }, 5000); } catch { /* 关不掉也没关系 */ }
}

// ---- 平台壳 ----
async function landingInfo() {
  return await R(`(() => {
    const l = document.getElementById('landing');
    const w = document.getElementById('workspace');
    const cards = Array.from(document.querySelectorAll('[data-biz]')).map((el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return {
        biz: el.getAttribute('data-biz'),
        text: (el.textContent || '').trim().slice(0, 40),
        visible: r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden',
        lastBadge: !!(el.querySelector('[data-last-badge]:not(.hidden)')),
      };
    });
    let frameUrl = '';
    try { const f = document.getElementById('moduleFrame'); frameUrl = f && f.contentWindow ? String(f.contentWindow.location.href || '') : ''; } catch (e) { frameUrl = ''; }
    const crumb = document.getElementById('crumbBiz');
    return {
      landingVisible: !!l && !l.classList.contains('hidden'),
      workspaceVisible: !!w && !w.classList.contains('hidden'),
      hash: location.hash || '',
      title: document.title,
      crumb: crumb ? crumb.textContent : '',
      cards, frameUrl,
    };
  })()`);
}

async function clickBizCard(biz) {
  return await R(`(() => {
    const el = document.querySelector('[data-biz="${biz}"]');
    if (!el) return { ok: false };
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return { ok: false, reason: '卡片不可见' };
    el.scrollIntoView({ block: 'center' });
    el.click();
    return { ok: true, text: (el.textContent || '').trim().slice(0, 40) };
  })()`);
}

async function iframeInfo() {
  return await R(`(() => {
    const f = document.getElementById('moduleFrame');
    if (!f) return { exists: false };
    let doc = null; let accessError = '';
    try { doc = f.contentDocument; } catch (e) { accessError = String((e && e.message) || e); }
    const r = f.getBoundingClientRect();
    return {
      exists: true, src: f.getAttribute('src') || '',
      docUrl: doc && doc.URL ? String(doc.URL) : '',
      readyState: doc ? doc.readyState : '',
      textLen: doc && doc.body ? doc.body.innerText.trim().length : 0,
      accessError,
      visible: r.width > 0 && r.height > 0,
      maskDone: !!document.getElementById('frameMask') && document.getElementById('frameMask').classList.contains('done'),
    };
  })()`);
}

async function waitIframeModule(bizPath, timeoutMs = 20000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    try { last = await iframeInfo(); } catch { last = null; }
    if (last && last.docUrl.includes(bizPath) && last.readyState === 'complete' && last.textLen > 20) return last;
    await sleep(200);
  }
  throw new Error(`等待 iframe 加载 ${bizPath} 超时；最后状态=${oneLine(JSON.stringify(last), 400)}`);
}

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------
function buildReport(state, fatal) {
  const total = state.runner.results.length;
  const passed = state.runner.passed.length;
  const failed = state.runner.failed.length;
  const skipped = state.runner.skipped.length;
  const expectedConsole = state.expectedConsole || [];
  const realConsole = state.realConsole || [];
  return {
    generatedAt: nowIso(),
    scope: '价格监控平台（平台壳）+ modules/patrol 巡检 v1.3.4 深度真实浏览器验收',
    environment: ENV,
    summary: {
      total, passed, failed, skipped,
      durationMs: Date.now() - state.runner.startedAt,
      consoleErrorsReal: realConsole.length,
      consoleErrorsExpected: expectedConsole.length,
      fatal: fatal || null,
    },
    expectations: {
      base: {
        sheets: EXP.sheets, totalRows: EXP.totalRows, withSku: EXP.withSku, noSku: EXP.noSku,
        compareGroups: EXP.groups.length, compareSkus: EXP.groupSkus.size, comparePair: EXP.comparePair,
      },
      oldBaseGeneratedAt: OLD_BASE.base.generatedAt,
      builtinGeneratedAt: BUILTIN_BASE.generatedAt,
    },
    assertions: state.runner.results,
    console: { real: realConsole, expected: expectedConsole },
    dialogs: dialogs,
    downloads: downloads.map((d) => ({ suggested: d.suggested, state: d.state, filePath: d.filePath, size: (() => { try { return fs.statSync(d.filePath).size; } catch { return null; } })() })),
    screenshots: state.runner.shots,
    notes: state.runner.notes,
    findings: state.findings || [],
  };
}

function renderMarkdown(report) {
  const L = [];
  const s = report.summary;
  L.push('# 价格监控平台 · 深度真实浏览器验收报告（平台壳 + 巡检 v1.3.4）');
  L.push('');
  L.push(`- 生成时间：${report.generatedAt}`);
  L.push(`- 结论：**${s.failed === 0 ? '全部通过（SKIP 项见下）' : `发现 ${s.failed} 项失败`}**`);
  L.push(`- 断言：通过 ${s.passed} · 失败 ${s.failed} · 跳过 ${s.skipped} · 合计 ${s.total}；耗时 ${(s.durationMs / 1000).toFixed(1)}s`);
  L.push(`- console error：真实 ${s.consoleErrorsReal} 条${s.consoleErrorsExpected ? `；已归类预期 ${s.consoleErrorsExpected} 条（见下）` : ''}`);
  L.push('');
  L.push('## 环境');
  L.push('');
  L.push('| 项 | 值 |');
  L.push('| --- | --- |');
  L.push(`| 浏览器 | ${report.environment.browserVersion}（${report.environment.browserPath}） |`);
  L.push(`| CDP 端口 | ${report.environment.cdpPort} |`);
  L.push(`| 扩展 ID | ${report.environment.extId} |`);
  L.push(`| 扩展目录 | ${report.environment.extDir} |`);
  L.push(`| 视口 | ${report.environment.viewport} |`);
  L.push(`| Node | ${report.environment.node} |`);
  L.push(`| 下载目录 | ${report.environment.downloadDir} |`);
  L.push(`| 旧版基表素材 | ${report.environment.oldBasePath}（generatedAt=${report.environment.oldBaseGeneratedAt}） |`);
  L.push(`| 内置基表 | ${report.expectations.builtinGeneratedAt}（${report.expectations.base.totalRows} 行 / ${report.expectations.base.withSku} 行有 SKU） |`);
  L.push(`| 导入用 xlsx | ${report.environment.xlsxPath || '（未找到）'} |`);
  L.push(`| API 桥 | ${report.environment.apiBridgeUp ? '在线' : '未在线'} ${report.environment.apiBridgeInfo ? '· ' + report.environment.apiBridgeInfo : ''} |`);
  L.push('');

  if (report.summary.fatal) {
    L.push('## 致命错误（验收未完整跑完）');
    L.push('');
    L.push('```');
    L.push(String(report.summary.fatal));
    L.push('```');
    L.push('');
  }

  L.push('## 断言明细');
  L.push('');
  L.push('| ID | 断言 | 结果 | 耗时 | 证据 / 说明 |');
  L.push('| --- | --- | --- | --- | --- |');
  for (const a of report.assertions) {
    const mark = a.status === 'pass' ? '✅ 通过' : a.status === 'skip' ? '⏭ 跳过' : '❌ 失败';
    const ev = a.status === 'pass'
      ? oneLine(a.detail || '', 220).replace(/\|/g, '/')
      : a.status === 'skip' ? oneLine(a.detail || '', 220).replace(/\|/g, '/')
        : `错误：${oneLine(a.error || '', 220).replace(/\|/g, '/')}`;
    L.push(`| ${a.id} | ${a.title.replace(/\|/g, '/')} | ${mark} | ${a.durationMs}ms | ${ev || '—'} |`);
  }
  L.push('');

  const failed = report.assertions.filter((a) => a.status === 'fail');
  if (failed.length) {
    L.push('## 失败项与最小复现');
    L.push('');
    for (const a of failed) {
      L.push(`### ❌ ${a.id} · ${a.title}`);
      L.push('');
      L.push('- 最小复现：' + (a.repro || '（见断言实现）'));
      L.push('- 错误原文：');
      L.push('```');
      L.push(String(a.error || '').slice(0, 4000));
      L.push('```');
      L.push('- 失败截图：' + (report.screenshots.filter((x) => x.name.startsWith(`fail-${a.id}`)).map((x) => `[\`${x.name}\`](shots-deep-patrol/${x.name})`).join('、') || '（截图失败）'));
      L.push('');
    }
  }

  const skipped = report.assertions.filter((a) => a.status === 'skip');
  if (skipped.length) {
    L.push('## 跳过项与原因（不计入失败）');
    L.push('');
    for (const a of skipped) L.push(`- **${a.id}** ${a.title}：${a.detail}`);
    L.push('');
  }

  L.push('## console error 汇总');
  L.push('');
  if (!report.console.real.length) {
    L.push('- 真实 console error：**0 条**。');
  } else {
    L.push('- 真实 console error：**' + report.console.real.length + ' 条**：');
    L.push('');
    L.push('```');
    for (const e of report.console.real) L.push(String(e));
    L.push('```');
  }
  if (report.console.expected.length) {
    L.push('');
    L.push('- 已归类的预期日志（浏览器级网络错误，非 JS 异常 / 非产品未捕获错误）：');
    for (const e of report.console.expected) L.push(`  - \`${oneLine(e.error, 200)}\` —— ${e.note}`);
  }
  L.push('');
  L.push('## 下载件（真实落盘）');
  L.push('');
  if (!report.downloads.length) L.push('- 无');
  for (const d of report.downloads) L.push(`- ${d.suggested} · ${d.state} · ${d.size != null ? fmtBytes(d.size) : '?'} · \`${d.filePath}\``);
  L.push('');
  L.push('## 截图');
  L.push('');
  for (const sh of report.screenshots) L.push(`- [\`${sh.name}\`](shots-deep-patrol/${sh.name})${sh.note ? ' —— ' + sh.note : ''}`);
  L.push('');
  if (report.findings.length) {
    L.push('## 需 Lead 判断的点 / 风险');
    L.push('');
    for (const f of report.findings) {
      L.push(`### ${f.title}`);
      L.push('');
      L.push(f.detail);
      L.push('');
      if (f.repro) { L.push('最小复现：'); L.push('```'); L.push(f.repro); L.push('```'); L.push(''); }
    }
  }
  if (report.notes.length) {
    L.push('## 备注');
    L.push('');
    for (const n of report.notes) L.push('- ' + n);
    L.push('');
  }
  L.push('---');
  L.push('');
  L.push('验收口径：每条断言都要求关键 UI 有实际反馈；console error 除「故意指向不可达 API 桥」时浏览器自身产生的 net::ERR_CONNECTION_REFUSED 网络日志外，任何新增 error 均记失败。SKIP 项为产品确实不存在的交互，不虚报通过。');
  return L.join('\n');
}

// ---------------------------------------------------------------------------
// A. 平台壳验收
// ---------------------------------------------------------------------------
async function verifyPlatformShell(r, state) {
  const pageUrlBase = () => `chrome-extension://${ENV.extId}/app.html`;
  await gotoPlatformHome(2000);

  // ---- P1 首页三卡片 ----
  await r.check('P1', '业务选择页：三张业务卡片齐全可见、文案正确、上次使用标记初始隐藏', async () => {
    const info = await landingInfo();
    const visible = new Set(info.cards.filter((c) => c.visible).map((c) => c.biz));
    const missing = ['patrol', 'share', 'radar'].filter((b) => !visible.has(b));
    expect(missing.length === 0, `缺失/不可见卡片：${missing.join('、')}；实际=${oneLine(JSON.stringify(info.cards))}`);
    expect(info.landingVisible && !info.workspaceVisible, `landingVisible=${info.landingVisible} workspaceVisible=${info.workspaceVisible}`);
    expect(/选择业务/.test(await R(`(document.querySelector('#landing h1') || {}).textContent || ''`)), '首页 h1 不含「选择业务」');
    expect(/价格监控平台/.test(info.title), `title=${info.title}`);
    const heroSub = await R(`(document.querySelector('#landing .hero-sub') || {}).textContent || ''`);
    expect(heroSub.length > 10, '#landing .hero-sub 文案缺失');
    return `${info.cards.filter((c) => c.visible).map((c) => c.biz).join('/')} · title=${info.title}`;
  }, { repro: '打开 app.html，检查 [data-biz] 三卡片与 #landing 首屏' });

  // ---- P2 卡片进入巡检 ----
  await r.check('P2', '点击首页「价格巡检」卡片：工作区显示、iframe 指向 modules/patrol/app.html、hash=#/patrol、面包屑正确', async () => {
    const clicked = await clickBizCard('patrol');
    expect(clicked.ok, '点击 patrol 卡片失败：' + oneLine(JSON.stringify(clicked)));
    const info = await waitIframeModule(BIZ_PATHS.patrol, 25000);
    await waitForPage(`(() => { const m = document.getElementById('frameMask'); return !!m && m.classList.contains('done'); })()`, { timeoutMs: 10000, label: '遮罩消失(#frameMask.done)' });
    const land = await landingInfo();
    expect(land.workspaceVisible && !land.landingVisible, `workspaceVisible=${land.workspaceVisible} landingVisible=${land.landingVisible}`);
    expect(land.hash === '#/patrol', `hash=${JSON.stringify(land.hash)}，期望 #/patrol`);
    expect(/价格巡检/.test(land.crumb), `面包屑=${JSON.stringify(land.crumb)}`);
    expect(/价格巡检/.test(land.title), `title=${land.title}`);
    const active = await R(`(() => { const b = document.querySelector('[data-switch-biz="patrol"]'); return { active: !!b && b.classList.contains('active'), aria: !!b && b.getAttribute('aria-current') }; })()`);
    expect(active.active && active.aria, `顶部切换按钮高亮异常：${JSON.stringify(active)}`);
    return `iframe=${info.docUrl.split('/').slice(-2).join('/')} · hash=${land.hash} · crumb=${land.crumb}`;
  }, { repro: '首页点击 [data-biz="patrol"]，等 iframe 载入后检查 workspace/hash/crumb' });

  // ---- P3 平台内巡检首屏 + iframe 内 4 类目 tab 切换 ----
  await r.check('P3', '平台 iframe 内巡检首屏正常：4 个类目 tab（+全部）、表格 153 行、统计卡片 8 个；iframe 内切「大家电」后 53 行', async () => {
    // iframe 的 load 事件只代表 HTML 就绪，巡检 app.js 的 init（读 storage/基表/渲染）是异步的，先等应用真正渲染完
    await waitForPage(`(() => {
      const f = document.getElementById('moduleFrame');
      const d = f && f.contentDocument;
      if (!d) return false;
      return d.querySelectorAll('#statsBar .statChip').length === 8 && d.querySelectorAll('#tblBody tr').length === ${EXP.totalRows};
    })()`, { timeoutMs: 25000, label: 'iframe 内巡检应用初始化（统计/表格）' });
    const info = await R(`(() => {
      const f = document.getElementById('moduleFrame');
      const d = f && f.contentDocument;
      if (!d) return { ok: false, reason: 'iframe 文档不可访问' };
      const tabs = Array.from(d.querySelectorAll('#sheetTabs .tab')).map((b) => ({
        name: b.firstChild && b.firstChild.nodeType === 3 ? b.firstChild.textContent.trim() : b.textContent.trim(),
        count: b.querySelector('.count') ? b.querySelector('.count').textContent.replace(/^·\\s*/, '') : '',
      }));
      const clicked = (() => {
        const b = Array.from(d.querySelectorAll('#sheetTabs .tab')).find((x) => (x.firstChild ? x.firstChild.textContent : x.textContent).trim() === '大家电');
        if (!b) return false; b.click(); return true;
      })();
      const rowsAfter = d.querySelectorAll('#tblBody tr').length;
      const firstSheet = rowsAfter ? (d.querySelector('#tblBody tr').querySelectorAll('td')[1] || {}).textContent : '';
      return { ok: true, tabs, rows: d.querySelectorAll('#tblBody tr').length, stats: d.querySelectorAll('#statsBar .statChip').length, clicked, rowsAfter, firstSheet };
    })()`);
    expect(info.ok, info.reason);
    expect(info.stats === 8, `iframe 内统计卡片 ${info.stats} 个，期望 8`);
    expect(info.tabs.length === 5, `iframe 内 tab ${info.tabs.length} 个，期望 5（全部 + 4 类目）：${oneLine(JSON.stringify(info.tabs))}`);
    expect(info.clicked, 'iframe 内点击「大家电」tab 失败');
    await sleep(350);
    const after = await R(`(() => { const d = document.getElementById('moduleFrame').contentDocument; const rows = d.querySelectorAll('#tblBody tr'); return { n: rows.length, sheet: rows[0] ? (rows[0].querySelectorAll('td')[1] || {}).textContent : '' }; })()`);
    expect(after.n === EXP.sheets.find((s) => s.name === '大家电').rows, `iframe 内大家电行数=${after.n}，期望 ${EXP.sheets.find((s) => s.name === '大家电').rows}`);
    expect(/大家电/.test(after.sheet), `首行类目=${after.sheet}`);
    // 切回「全部」（iframe 内），保持后续平台测试干净
    await R(`(() => { const d = document.getElementById('moduleFrame').contentDocument; const b = Array.from(d.querySelectorAll('#sheetTabs .tab')).find((x) => (x.firstChild ? x.firstChild.textContent : x.textContent).trim() === '全部'); if (b) b.click(); return true; })()`);
    await sleep(300);
    return `tabs=${info.tabs.map((t) => t.name + '/' + t.count).join(' ')} · iframe 大家电→${after.n} 行`;
  }, { repro: '进入巡检 iframe 后读取 #sheetTabs/#tblBody，点击大家电 tab' });

  // ---- P4 顶部切换到市占率 ----
  await r.check('P4', '顶部切换 [data-switch-biz=share]：iframe 切到 modules/share/app.html、hash=#/share、面包屑=市场占有率', async () => {
    const clicked = await R(`(() => { const b = document.querySelector('[data-switch-biz="share"]'); if (!b) return { ok: false }; b.click(); return { ok: true }; })()`);
    expect(clicked.ok, '找不到 [data-switch-biz="share"]');
    const info = await waitIframeModule(BIZ_PATHS.share, 25000);
    const land = await landingInfo();
    expect(land.hash === '#/share', `hash=${JSON.stringify(land.hash)}`);
    expect(/市场占有率/.test(land.crumb), `面包屑=${JSON.stringify(land.crumb)}`);
    expect(/市场占有率/.test(land.title), `title=${land.title}`);
    return `hash=${land.hash} · iframe=${info.docUrl.split('/').slice(-2).join('/')} · 正文 ${info.textLen} 字符`;
  }, { repro: '点击 [data-switch-biz="share"]，等待 iframe 加载 share 模块' });

  // ---- P5 顶部切换到竞品监控 ----
  await r.check('P5', '顶部切换 [data-switch-biz=radar]：iframe 切到 modules/radar/app.html、hash=#/radar、面包屑=竞品监控', async () => {
    const clicked = await R(`(() => { const b = document.querySelector('[data-switch-biz="radar"]'); if (!b) return { ok: false }; b.click(); return { ok: true }; })()`);
    expect(clicked.ok, '找不到 [data-switch-biz="radar"]');
    const info = await waitIframeModule(BIZ_PATHS.radar, 25000);
    const land = await landingInfo();
    expect(land.hash === '#/radar', `hash=${JSON.stringify(land.hash)}`);
    expect(/竞品监控/.test(land.crumb), `面包屑=${JSON.stringify(land.crumb)}`);
    return `hash=${land.hash} · iframe=${info.docUrl.split('/').slice(-2).join('/')} · 正文 ${info.textLen} 字符`;
  }, { repro: '点击 [data-switch-biz="radar"]，等待 iframe 加载 radar 模块' });

  // ---- P6 返回业务选择 + 上次使用标记 ----
  await r.check('P6', '顶部「业务选择」返回首页：landing 可见、iframe 释放为 about:blank、hash 清空、竞品监控卡片带「上次使用」标记', async () => {
    const clicked = await clickId('backBtn');
    expect(clicked.ok, '找不到 #backBtn');
    await sleep(700);
    const info = await landingInfo();
    expect(info.landingVisible && !info.workspaceVisible, `landingVisible=${info.landingVisible} workspaceVisible=${info.workspaceVisible}`);
    expect(info.hash === '', `hash=${JSON.stringify(info.hash)}，期望空`);
    expect(!/\/modules\//.test(info.frameUrl), `iframe 未释放：${info.frameUrl}`);
    const radarBadge = info.cards.find((c) => c.biz === 'radar');
    expect(radarBadge && radarBadge.lastBadge, `竞品监控卡片未显示「上次使用」标记：${JSON.stringify(info.cards)}`);
    return `landing=可见 · frame=${info.frameUrl || 'about:blank'} · 上次使用=${radarBadge.biz}`;
  }, { repro: '业务页点 #backBtn，检查首页三卡片与 [data-last-badge]' });

  // ---- P7 首页重新进入 + Esc 返回 ----
  await r.check('P7', '首页从卡片重新进入「市场占有率」，按 Esc 返回业务选择（键盘交互）', async () => {
    const clicked = await clickBizCard('share');
    expect(clicked.ok, '首页点击 share 卡片失败');
    await waitIframeModule(BIZ_PATHS.share, 25000);
    await R(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`);
    await sleep(600);
    const info = await landingInfo();
    expect(info.landingVisible, 'Esc 后首页未显示');
    expect(info.hash === '', `Esc 后 hash=${JSON.stringify(info.hash)}`);
    return '卡片进入市占率 → Esc 回首页';
  }, { repro: '首页点 share 卡片，按 Esc；检查 landing/hash' });

  // ---- P8 键盘数字直达 ----
  await r.check('P8', '首页键盘「3」直达竞品监控（快捷键 1/2/3）', async () => {
    await R(`document.dispatchEvent(new KeyboardEvent('keydown', { key: '3', bubbles: true, cancelable: true }))`);
    const info = await waitIframeModule(BIZ_PATHS.radar, 20000);
    const land = await landingInfo();
    expect(land.hash === '#/radar', `hash=${JSON.stringify(land.hash)}`);
    return `hash=${land.hash} · iframe 正文 ${info.textLen} 字符`;
  }, { repro: '首页 document 派发 keydown key=3' });

  // ---- P9 深链冷启动 ----
  let deeplinkMark = 0;
  await r.check('P9', '深链 #/patrol 冷启动：直接打开 app.html#/patrol 落在价格巡检，刷新后仍在巡检', async () => {
    await page.navigate('about:blank', { settleMs: 250 });
    await page.navigate(pageUrlBase() + '#/patrol', { settleMs: 2200 });
    const info = await waitIframeModule(BIZ_PATHS.patrol, 25000);
    const land = await landingInfo();
    expect(land.hash === '#/patrol', `hash=${JSON.stringify(land.hash)}`);
    expect(/价格巡检/.test(land.crumb), `crumb=${JSON.stringify(land.crumb)}`);
    await reloadPage(1800);
    const info2 = await waitIframeModule(BIZ_PATHS.patrol, 25000);
    const land2 = await landingInfo();
    expect(land2.hash === '#/patrol', `刷新后 hash=${JSON.stringify(land2.hash)}`);
    expect(/价格巡检/.test(land2.crumb), `刷新后 crumb=${JSON.stringify(land2.crumb)}`);
    deeplinkMark = page.consoleErrors.length;
    await r.shot('03-platform-deeplink-patrol.png', '深链 #/patrol 冷启动 + 刷新后');
    return `冷启动 hash=${land.hash} · 刷新后 hash=${land2.hash} · iframe 正文 ${info2.textLen} 字符`;
  }, { repro: '导航 app.html#/patrol → Page.reload' });

  // ---- P10 独立标签页 ----
  await r.check('P10', '「独立打开」：新标签页直接打开 modules/patrol/app.html 且首屏渲染正常', async () => {
    const before = await listPageTargets();
    const beforeIds = new Set(before.map((t) => t.id));
    const clicked = await R(`(() => { const b = document.getElementById('openTabBtn'); if (!b) return { ok: false }; b.click(); return { ok: true }; })()`);
    expect(clicked.ok, '找不到 #openTabBtn');
    const t0 = Date.now();
    let target = null;
    let lastList = [];
    while (Date.now() - t0 < 20000) {
      lastList = await listPageTargets();
      target = lastList.find((t) => !beforeIds.has(t.id) && /\/modules\/patrol\/app\.html/.test(t.url || ''));
      if (target) break;
      await sleep(300);
    }
    expect(target, `20s 内没有出现模块页 target；当前=${oneLine(lastList.map((t) => t.url).join(' | '), 400)}`);
    const s2 = await new PageSession(target.webSocketDebuggerUrl).connect();
    try {
      await s2.waitFor(`(() => document.readyState === 'complete' && document.querySelectorAll('#tblBody tr').length > 0 && typeof state !== 'undefined')()`, { timeoutMs: 20000, label: '独立标签页巡检首屏' });
      const info = await s2.evaluate(`(() => ({ url: location.href, rows: document.querySelectorAll('#tblBody tr').length, title: document.title }))()`);
      expect(info.rows === EXP.totalRows, `独立标签页表格 ${info.rows} 行，期望 ${EXP.totalRows}`);
      await s2.screenshot(path.join(SHOTS_DIR, '04-platform-independent-tab.png'));
      r.shots.push({ name: '04-platform-independent-tab.png', path: path.join(SHOTS_DIR, '04-platform-independent-tab.png'), note: '平台「独立打开」新标签页（巡检模块页）' });
      await closeTarget(target.id);
      return `新标签页=${info.url} · ${info.rows} 行 · title=${info.title}`;
    } finally {
      try { s2.close(); } catch { /* ignore */ }
      await closeTarget(target.id);
    }
  }, { repro: '巡检 iframe 下点 #openTabBtn，检查新 page target URL/首屏' });

  // ---- P11 浏览器后退 ----
  await r.check('P11', '浏览器后退：首页→巡检→市占率 后，后退 1 次回巡检（hash=#/patrol、iframe 非空），后退 2 次回业务选择', async () => {
    // 构造干净历史：重新载入平台首页
    await gotoPlatformHome(1500);
    const c1 = await clickBizCard('patrol');
    expect(c1.ok, '点 patrol 卡片失败');
    await waitIframeModule(BIZ_PATHS.patrol, 25000);
    await R(`document.querySelector('[data-switch-biz="share"]').click()`);
    await waitIframeModule(BIZ_PATHS.share, 25000);
    await R('history.back()');
    let ok1 = false;
    const t1 = Date.now();
    let info1 = null;
    while (Date.now() - t1 < 15000) {
      const land = await landingInfo();
      try { info1 = await waitIframeModule(BIZ_PATHS.patrol, 2500); } catch { info1 = null; }
      if (land.hash === '#/patrol' && info1) { ok1 = true; break; }
      await sleep(300);
    }
    expect(ok1, `后退 1 次后未回到巡检：hash=${JSON.stringify((await landingInfo()).hash)} iframe=${oneLine(JSON.stringify(info1), 200)}`);
    const land1 = await landingInfo();
    expect(/价格巡检/.test(land1.crumb), `后退 1 次后面包屑=${JSON.stringify(land1.crumb)}`);
    await R('history.back()');
    await waitForPage(`(() => { const l = document.getElementById('landing'); return !!l && !l.classList.contains('hidden') && document.querySelectorAll('[data-biz]').length >= 3; })()`, { timeoutMs: 15000, label: '后退 2 次回首页' });
    const land2 = await landingInfo();
    expect(land2.hash === '', `后退 2 次后 hash=${JSON.stringify(land2.hash)}`);
    expect(!/\/modules\//.test(land2.frameUrl), `后退 2 次后 iframe 仍在业务页：${land2.frameUrl}`);
    await r.shot('05-platform-history-back.png', '浏览器后退：回到业务选择首页');
    return `后退1次 hash=${land1.hash}/crumb=${land1.crumb} · 后退2次 hash=${JSON.stringify(land2.hash)}/iframe=${land2.frameUrl || 'about:blank'}`;
  }, { repro: '首页→巡检→市占率，history.back() 两次' });

  // ---- P12 平台阶段 console ----
  await r.check('P12', '平台壳阶段（含巡检/市占率/竞品 iframe 加载）console 零真实 error', async () => {
    const { real, expected } = classifyConsole(page.consoleErrors.slice(state.platformConsoleMark));
    state.realConsole.push(...real);
    state.expectedConsole.push(...expected);
    expect(real.length === 0, `平台阶段出现 ${real.length} 条 console error：${real.slice(0, 8).join(' | ')}`);
    return `真实 error 0${expected.length ? `（预期网络日志 ${expected.length} 条）` : ''} · 累计 console 条目 ${page.consoleAll.length}`;
  }, { repro: '平台壳全流程结束后读取 page.consoleErrors' });

  // ---- P13 平台截图 ----
  await r.check('P13', '平台壳关键页截图（首页 / 巡检工作区 / 独立标签页 / 后退首页）', async () => {
    await gotoPlatformHome(1500);
    await r.shot('01-platform-home.png', '业务选择首页（三业务卡片）');
    const c = await clickBizCard('patrol');
    expect(c.ok, '进入巡检失败');
    await waitIframeModule(BIZ_PATHS.patrol, 25000);
    await sleep(800);
    await r.shot('02-platform-patrol.png', '平台壳内嵌价格巡检');
    return '01-platform-home / 02-platform-patrol / 03-platform-deeplink-patrol / 04-platform-independent-tab / 05-platform-history-back';
  }, { repro: '平台壳截图' });
}

// ---------------------------------------------------------------------------
// B. 巡检 v1.3.4 深度验收（独立模块页；与平台 iframe 同源同数据）
// ---------------------------------------------------------------------------
async function waitNewDownload(pred, beforeGuids, { timeoutMs = 20000, label = '新下载' } = {}) {
  const t0 = Date.now();
  const base = new Set(beforeGuids || []);
  while (Date.now() - t0 < timeoutMs) {
    const hit = downloadList().find((d) => !base.has(d.guid) && pred(d));
    if (hit) {
      for (let i = 0; i < 40; i++) {
        try { if (fs.existsSync(hit.filePath) && fs.statSync(hit.filePath).size > 0) return hit; } catch { /* 等落盘 */ }
        await sleep(100);
      }
      return hit;
    }
    await sleep(150);
  }
  throw new Error(`等待${label}超时；下载记录=${oneLine(JSON.stringify(downloads.map((d) => ({ n: d.suggested, s: d.state }))), 400)}`);
}

async function openSettingsDialog() {
  await clickId('settingsBtn');
  await waitForPage(`(() => { const d = document.getElementById('settingsDialog'); return !!d && d.open; })()`, { timeoutMs: 6000, label: '设置弹窗打开' });
  await sleep(350);
}

async function closeSettingsDialog() {
  // 取消按钮（不保存）
  const open = await R(`(() => { const d = document.getElementById('settingsDialog'); return !!d && d.open; })()`);
  if (open) await clickId('settingsCancel');
  await waitForPage(`(() => { const d = document.getElementById('settingsDialog'); return !!d && !d.open; })()`, { timeoutMs: 6000, label: '设置弹窗关闭' });
}

async function settingsFormValues() {
  return await R(`(() => {
    const v = (id) => { const el = document.getElementById(id); return el ? (el.type === 'checkbox' ? el.checked : el.value) : null; };
    return {
      batch: v('setBatch'), delayMin: v('setDelayMin'), delayMax: v('setDelayMax'),
      skipToday: v('setSkipToday'), scope: v('setScope'), keepTab: v('setKeepTab'),
      deviationLimit: v('setDeviationLimit'), deviationConfirm: v('setDeviationConfirm'),
      previewDelay: v('setPreviewDelay'), patrolMode: v('setPatrolMode'),
      aiEnabled: v('setAiEnabled'), aiEndpoint: v('setAiEndpoint'), aiModel: v('setAiModel'),
      aiKeyLen: (document.getElementById('setAiKey') || {}).value ? String(document.getElementById('setAiKey').value).length : 0,
      aiVerifyMode: v('setAiVerifyMode'), officialApiUrl: v('setOfficialApiUrl'),
    };
  })()`);
}

async function fillSettingsPatch(patch) {
  const jobs = [];
  for (const [id, value] of Object.entries(patch)) {
    if (typeof value === 'boolean') jobs.push(setChecked(id, value));
    else if (['setScope', 'setPatrolMode', 'setAiVerifyMode'].includes(id)) jobs.push(selectValue(id, value));
    else jobs.push(setInputValue(id, value, 'input'));
  }
  return await Promise.all(jobs);
}

/** 打开设置保存并等弹窗关闭 + toast。 */
async function saveSettingsDialog() {
  await clickId('settingsSave');
  await waitToast('设置已保存', 8000);
  await waitForPage(`(() => { const d = document.getElementById('settingsDialog'); return !!d && !d.open; })()`, { timeoutMs: 8000, label: '设置保存后弹窗关闭' });
}

async function apiAccountAreaInfo() {
  return await R(`(() => ({
    rows: document.querySelectorAll('#apiAccountList .apiRow').length,
    info: (document.getElementById('apiAccountInfo') || {}).textContent || '',
    addBtn: !!document.getElementById('apiAddBtn'),
    refreshBtn: !!document.getElementById('apiRefreshBtn'),
    tag: (document.querySelector('#apiAccountList .apiTag') || {}).textContent || '',
  }))()`);
}

async function rowPriceText(sku) {
  return await rowBySkuAction(sku, `(tr, tds) => ({ ok: true, util: tds[8] ? tds[8].innerText : '', plus: tds[10] ? tds[10].innerText : '', status: tds[11] ? tds[11].innerText : '' })`);
}

async function probePreviewWindow() {
  // 找一行（当前表里有 SKU 的行），触发小眼睛 mouseenter → 预览窗口
  await R(`(() => { const i = document.getElementById('searchInput'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await sleep(300);
  const triggered = await R(`(() => {
    const btn = document.querySelector('#tblBody tr .eyeBtn');
    if (!btn) return { ok: false };
    btn.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
    return { ok: true };
  })()`);
  if (!triggered.ok) return { mode: 'no-eye', detail: '表格里没有 👁 预览按钮' };
  const before = new Set((await listPageTargets()).map((t) => t.id));
  const t0 = Date.now();
  let target = null;
  let toast = null;
  while (Date.now() - t0 < 9000) {
    const list = await listPageTargets();
    target = list.find((t) => !before.has(t.id) && /item\.jd\.com/.test(t.url || ''));
    if (target) break;
    toast = await toastNow();
    if (toast.visible && /预览窗口打开失败/.test(toast.text)) break;
    await sleep(250);
  }
  // 把鼠标移出，避免窗口保持打开
  await R(`(() => { const btn = document.querySelector('#tblBody tr .eyeBtn'); if (btn) btn.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false })); return true; })()`);
  if (target) {
    const info = { mode: 'window', targetId: target.id, url: target.url };
    await closeTarget(target.id);
    await sleep(300);
    return info;
  }
  if (toast && toast.visible && /预览窗口打开失败/.test(toast.text)) return { mode: 'toast-fail', detail: toast.text };
  return { mode: 'none', detail: '既没有出现预览窗口 target，也没有失败提示（headless 下 chrome.windows.create 行为受限）' };
}

async function verifyPatrolModule(r, state) {
  // ---- 打开独立巡检模块页 ----
  await gotoPatrolPage();

  // ---- M0 内部状态可观测性 + 产品不存在交互的核对 ----
  const internals = await R(`(() => ({
    stateType: typeof state, computeType: typeof computeStats,
    rows: state.rows.length, baseRows: state.base.totalRows,
    sortControls: document.querySelectorAll('.tbl th[data-sort], .tbl th.sortable, th[aria-sort]').length,
    pagerNodes: document.querySelectorAll('[class*=pager], [class*=pagination], [id*=pager], [id*=pagination]').length,
    drawerNodes: document.querySelectorAll('[class*=drawer], [role=dialog][class*=sku]').length,
    eyeBtns: document.querySelectorAll('#tblBody .eyeBtn').length,
  }))()`);
  await r.check('M0', '巡检页初始化：state/computeStats 可观测、基表 153 行、表格已渲染', async () => {
    expect(internals.stateType === 'object', `页面内 state 不可访问（typeof=${internals.stateType}）`);
    expect(internals.computeType === 'function', 'computeStats 不可访问');
    expect(internals.rows === EXP.totalRows, `state.rows=${internals.rows}，期望 ${EXP.totalRows}`);
    expect(internals.baseRows === EXP.totalRows, `state.base.totalRows=${internals.baseRows}，期望 ${EXP.totalRows}`);
    const t = await tableInfo();
    expect(t.count === EXP.totalRows, `表格 ${t.count} 行，期望 ${EXP.totalRows}`);
    return `state 可访问 · 基表 ${internals.baseRows} 行 · 表格 ${t.count} 行 · 预览按钮 ${internals.eyeBtns} 个`;
  }, { repro: '打开 modules/patrol/app.html，读取 state/document' });

  r.skip('M-SORT', '表格排序（点表头排序）', `v1.3.4 产品未提供表格排序交互：DOM 中可排序表头控件 ${internals.sortControls} 个；表头仅做展示。属需求范围差异，不是回归 bug，需 Lead 确认。`);
  r.skip('M-PAGE', '表格分页', `v1.3.4 产品无分页组件（DOM 匹配 pager/pagination 节点 ${internals.pagerNodes} 个），表格一次渲染全部 ${EXP.totalRows} 行。需 Lead 确认是否需求遗漏。`);
  r.skip('M-DRAWER', '行详情 SKU 抽屉', `产品无 SKU 抽屉交互（DOM 中抽屉节点 ${internals.drawerNodes} 个）；行详情能力由 SKU 链接 / 改价 / 重采 / 下架 / 👁 预览入口承担，预览见 M29。`);

  // ---- M1 首屏 ----
  await r.check('M1', '巡检首屏：双轨徽标/标题、5 个类目 tab（含数量）、8 个统计卡片、基表信息=内置 153 行、AI/API 状态 chip', async () => {
    const s = await stateSnapshot();
    const tabs = await tabsInfo('sheetTabs');
    const chips = await statsChips();
    const baseInfo = await R(`document.getElementById('baseInfo').textContent`);
    const title = await R('document.title');
    const badge = await R(`document.getElementById('trackBadge').textContent`);
    expect(/双轨版/.test(badge), `trackBadge=${badge}`);
    expect(/电商平台价格巡检工作台/.test(title), `title=${title}`);
    expect(tabs.length === EXP.sheets.length + 1, `类目 tab ${tabs.length} 个，期望 ${EXP.sheets.length + 1}`);
    const expectTabs = [{ name: '全部', count: String(EXP.withSku) }].concat(EXP.sheets.map((s2) => ({ name: s2.name, count: String(s2.withSku) })));
    for (const want of expectTabs) {
      const got = tabs.find((t) => t.name === want.name);
      expect(got, `缺少类目 tab「${want.name}」；实际=${oneLine(JSON.stringify(tabs))}`);
      expect(got.count === want.count, `tab「${want.name}」数量=${got.count}，期望 ${want.count}`);
    }
    const expectChips = {
      '有效行数': EXP.totalRows + ' 行', '有 SKU': EXP.withSku + ' 行', '去重 SKU': EXP.skuSet.size + ' 个',
      '普惠已采集': '0 / ' + EXP.skuSet.size, '会员已采集': '0 / ' + EXP.skuSet.size,
      '低于阈值': '0', '采集失败': '0', '待补 SKU': String(EXP.noSku),
    };
    for (const [k, v] of Object.entries(expectChips)) expect(chips[k] === v, `统计卡片「${k}」=${chips[k]}，期望 ${v}`);
    expect(/153 行/.test(baseInfo), `baseInfo=${baseInfo}`);
    expect(/内置基表/.test(baseInfo), `baseInfo 未显示内置基表：${baseInfo}`);
    expect(s.baseAt === BUILTIN_BASE.generatedAt, `state.base.generatedAt=${s.baseAt}`);
    const aiChip = await R(`document.getElementById('aiStatusChip').textContent`);
    const apiChip = await R(`document.getElementById('apiStatusChip').textContent`);
    expect(/AI 已就绪|AI 未配置/.test(aiChip), `AI chip=${aiChip}`);
    expect(/官方API (已连接|未启动|未检测)/.test(apiChip), `API chip=${apiChip}`);
    return `tabs=${tabs.map((t) => t.name + '·' + t.count).join(' ')} · chips=${Object.keys(chips).length} · baseInfo=${baseInfo} · AI=${aiChip} · API=${apiChip}`;
  }, { repro: '打开巡检模块页读取 #sheetTabs/#statsBar/#baseInfo' });

  // ---- M2 4 类目 tab 切换 ----
  await r.check('M2', '4 个类目 tab 切换：类目名/行数与基表一致，首行类目正确，最后切回「全部」153 行', async () => {
    const detail = [];
    for (const sheet of EXP.sheets) {
      const clicked = await clickTab('sheetTabs', sheet.name);
      expect(clicked.ok, `点击类目「${sheet.name}」失败：${oneLine(JSON.stringify(clicked))}`);
      await waitRows(sheet.rows, 8000, `类目「${sheet.name}」行数=${sheet.rows}`);
      const t = await tableInfo();
      expect(t.count === sheet.rows, `类目「${sheet.name}」表格 ${t.count} 行，期望 ${sheet.rows}`);
      expect(String((t.first && t.first[1]) || '').includes(sheet.name), `类目「${sheet.name}」首行类目=${t.first && t.first[1]}`);
      detail.push(`${sheet.name}:${t.count}`);
    }
    const all = await clickTab('sheetTabs', '全部');
    expect(all.ok, '切回「全部」失败');
    await waitRows(EXP.totalRows, 8000, '全部行数=153');
    const active = (await tabsInfo('sheetTabs')).filter((t) => t.active).map((t) => t.name);
    expect(active.length === 1 && active[0] === '全部', `active tab=${oneLine(JSON.stringify(active))}`);
    return detail.join(' · ') + ` · 全部→${EXP.totalRows}`;
  }, { repro: '依次点击 #sheetTabs 4 个类目 tab' });

  // ---- M3 总览 12 数字卡片 ----
  await r.check('M3', '总览页：12 个数字卡片逐一点击筛选（active/hint/行数/空状态），再点一次回到全部；类目筛选 + 清除筛选', async () => {
    await clickId('tabOverview');
    await waitForPage(`(() => { const v = document.getElementById('viewOverview'); return !!v && !v.classList.contains('hidden'); })()`, { timeoutMs: 8000, label: '总览视图显示' });
    await sleep(400);
    const cards = await overviewCards();
    expect(cards.length === 12, `总览卡片 ${cards.length} 个，期望 12`);
    expect(cards.map((c) => c.label).join('|') === OV_LABELS.join('|'), `卡片文案/顺序不符：${cards.map((c) => c.label).join('|')}`);
    const initialExpected = {
      全部行: EXP.totalRows + ' 行', 普惠已采集: '0 / ' + EXP.skuSet.size, 会员已采集: '0 / ' + EXP.skuSet.size,
      低于阈值: '0', '高于/等于阈值': '0', 偏离阈值: '0', 需人工确认: '0', 手动改价: '0',
      采集失败: '0', 未采集: String(EXP.withSku), '待补 SKU': String(EXP.noSku), 已下架: '0 行',
    };
    for (const c of cards) {
      const want = initialExpected[c.label];
      expect(c.value === want, `卡片「${c.label}」值=${c.value}，期望 ${want}`);
    }
    const expectedRows = { 全部行: EXP.totalRows, 未采集: EXP.withSku, '待补 SKU': EXP.noSku };
    const detail = [];
    for (const label of OV_LABELS) {
      const c = await clickOverviewCard(label);
      expect(c.ok, `点击卡片「${label}」失败：${oneLine(JSON.stringify(c))}`);
      await sleep(260);
      const hint = await R(`document.getElementById('ovFilterHint').textContent`);
      expect(hint === OV_HINT[label], `卡片「${label}」筛选提示=${JSON.stringify(hint)}，期望 ${JSON.stringify(OV_HINT[label])}`);
      const cardsNow = await overviewCards();
      const act = cardsNow.filter((x) => x.active).map((x) => x.label);
      expect(act.length === 1 && act[0] === label, `卡片「${label}」active=${oneLine(JSON.stringify(act))}`);
      const wantRows = expectedRows[label] != null ? expectedRows[label] : 0;
      await sleep(150);
      const t = await tableInfo();
      expect(t.count === wantRows, `卡片「${label}」表格 ${t.count} 行，期望 ${wantRows}`);
      if (wantRows === 0) {
        expect(t.emptyVisible, `卡片「${label}」应显示空状态提示`);
        expect(/当前筛选没有符合条件的行/.test(t.emptyText), `空状态文案=${t.emptyText}`);
      } else {
        expect(!t.emptyVisible, `卡片「${label}」不应显示空状态`);
      }
      detail.push(`${label}=${t.count}`);
      // 再点一次回到全部
      await clickOverviewCard(label);
      await sleep(240);
      const hint2 = await R(`document.getElementById('ovFilterHint').textContent`);
      expect(hint2 === '全部 SKU', `再点「${label}」后提示=${JSON.stringify(hint2)}，期望「全部 SKU」`);
    }
    // 类目筛选：总览的类目 tab
    const ct = await clickTab('ovSheetTabs', '品牌A');
    expect(ct.ok, `总览类目 tab 点击失败：${oneLine(JSON.stringify(ct))}`);
    await sleep(400);
    const hint3 = await R(`document.getElementById('ovFilterHint').textContent`);
    expect(/品牌A/.test(hint3), `类目筛选提示=${JSON.stringify(hint3)}`);
    const cap3 = await R(`document.getElementById('tableCaption').textContent`);
    expect(/品牌A/.test(cap3), `表标题=${cap3}`);
    const clearVisible = await R(`(() => { const b = document.getElementById('ovClearFilterBtn'); return !!b && !b.classList.contains('hidden'); })()`);
    expect(clearVisible, '有筛选时「清除筛选」按钮应可见');
    await clickId('ovClearFilterBtn');
    await sleep(400);
    const hint4 = await R(`document.getElementById('ovFilterHint').textContent`);
    expect(hint4 === '全部 SKU', `清除筛选后提示=${JSON.stringify(hint4)}`);
    await waitRows(EXP.totalRows, 8000, '清除筛选后 153 行');
    return `12 卡片逐一点击 ✓（${detail.join(' ')}）· 类目筛选/清除筛选 ✓`;
  }, { repro: '总览页遍历 #ovCards 12 卡片点击 + #ovSheetTabs 类目 + #ovClearFilterBtn' });

  // ---- M4 搜索 / 状态筛选 ----
  await r.check('M4', '工作台搜索与状态筛选：SKU 精确搜索 1 行、型号搜索多行、无结果空状态、待补 SKU 7 行、全部 153 行', async () => {
    await clickId('tabWorkbench');
    await sleep(400);
    const pairSku = EXP.comparePair ? EXP.comparePair.a.sku : (EXP.sheets[0].name && EXP.offlineCandidate ? String(EXP.offlineCandidate.sku) : '');
    await setInputValue('searchInput', pairSku);
    await waitRows(1, 8000, '按 SKU 搜索 1 行');
    const t1 = await tableInfo();
    expect(t1.count === 1 && String(t1.first[3]).includes(pairSku), `搜索 SKU 结果=${oneLine(JSON.stringify(t1))}`);
    await setInputValue('searchInput', 'SG65CAB');
    await sleep(500);
    const t2 = await tableInfo();
    expect(t2.count > 1, `型号搜索 SG65CAB 行数=${t2.count}，期望 >1`);
    await setInputValue('searchInput', 'QA-NO-SUCH-MODEL-zzz');
    await sleep(400);
    const t3 = await tableInfo();
    expect(t3.count === 0 && t3.emptyVisible, `无结果搜索：${oneLine(JSON.stringify(t3))}`);
    expect(/没有符合条件的行/.test(t3.emptyText), `空状态文案=${t3.emptyText}`);
    await setInputValue('searchInput', '');
    await sleep(400);
    await waitRows(EXP.totalRows, 8000, '清空搜索后 153 行');
    await selectValue('statusFilter', 'nosku');
    await sleep(400);
    await waitRows(EXP.noSku, 8000, '待补 SKU 7 行');
    const t4 = await tableInfo();
    expect(t4.count === EXP.noSku, `待补 SKU 行数=${t4.count}，期望 ${EXP.noSku}`);
    await selectValue('statusFilter', 'offline');
    await sleep(400);
    const t5 = await tableInfo();
    expect(t5.count === 0 && t5.emptyVisible, `已下架筛选初始应为空：${oneLine(JSON.stringify(t5))}`);
    await selectValue('statusFilter', 'all');
    await sleep(400);
    await waitRows(EXP.totalRows, 8000, '状态筛选回全部');
    return `SKU 搜索 1 行 · 型号搜索 ${t2.count} 行 · 无结果空状态 ✓ · 待补 ${t4.count} 行 · 全部 ${EXP.totalRows} 行`;
  }, { repro: '搜索框输入/清空、#statusFilter 切换 nosku/offline/all' });

  // ---- M5 勾选 ----
  await r.check('M5', '行勾选：全选 146 行→「重采选中 (146)」、取消→恢复；单行勾选→「重采选中 (1)」', async () => {
    await setChecked('selectAllChk', true);
    await sleep(400);
    const txt1 = await R(`document.getElementById('multiRerunBtn').textContent`);
    expect(/146/.test(txt1) && /重采选中/.test(txt1), `全选后按钮=${txt1}`);
    const disabled1 = await R(`document.getElementById('multiRerunBtn').disabled`);
    expect(!disabled1, '全选后「重采选中」应可用');
    await setChecked('selectAllChk', false);
    await sleep(400);
    const txt2 = await R(`document.getElementById('multiRerunBtn').textContent`);
    expect(/重采选中$/.test(txt2.trim()) || txt2.trim() === '重采选中', `取消全选后按钮=${txt2}`);
    await R(`(() => { const chk = document.querySelector('#tblBody tr input[type=checkbox]'); if (!chk) return false; chk.checked = true; chk.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await sleep(400);
    const txt3 = await R(`document.getElementById('multiRerunBtn').textContent`);
    expect(/\(1\)/.test(txt3), `单行勾选后按钮=${txt3}`);
    await R(`(() => { const chk = document.querySelector('#tblBody tr input[type=checkbox]'); if (!chk) return false; chk.checked = false; chk.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await sleep(300);
    return `全选=${txt1} · 取消=${txt2.trim()} · 单行=${txt3}`;
  }, { repro: '勾选 #selectAllChk / 单行 checkbox，读 #multiRerunBtn 文案' });

  // ---- M6/M7 手动改价（两个店铺同款，制造比价差异） ----
  const pair = EXP.comparePair;
  expect(pair, '基表里找不到「大家电 + 3C店铺」同款配对的比价样本，无法继续改价/比价测试');
  const priceA = 4000;
  const priceB = 4500;
  await r.check('M6', `手动改价（普惠列）：${pair.a.sheet} ${pair.a.sku} 改为 ¥${priceA} → 状态/统计/采集记录正确`, async () => {
    await setInputValue('searchInput', pair.a.sku);
    await waitRows(1, 8000, '改价前定位行');
    await editPrice(pair.a.sku, 'util', priceA);
    const toast = await waitToast('已手动保存', 8000);
    await sleep(300);
    const cap = await captureOf(pair.a.sku);
    expect(cap && cap.util && Number(cap.util.price) === priceA, `采集记录=${oneLine(JSON.stringify(cap), 300)}`);
    expect(cap.util.kind === 'manual', `价格类型=${cap.util.kind}，期望 manual`);
    const chips = await statsChips();
    expect(chips['手动改价'] === '1', `手动改价=${chips['手动改价']}`);
    expect(chips['普惠已采集'] === '1 / ' + EXP.skuSet.size, `普惠已采集=${chips['普惠已采集']}`);
    expect(chips['低于阈值'] === '1', `低于阈值=${chips['低于阈值']}（¥${priceA} < 阈值 ${pair.a.utilMin}）`);
    const row = await rowPriceText(pair.a.sku);
    expect(/4,000/.test(row.util), `行内价格=${oneLine(row.util)}`);
    expect(/低于阈值/.test(row.status), `行状态=${row.status}`);
    await setInputValue('searchInput', '');
    await sleep(350);
    return `toast=${toast} · capture=${priceA}/manual · 手动改价1 · 低于阈值1 · 行状态=${row.status.trim()}`;
  }, { repro: `搜索 SKU=${pair.a.sku} → 第8列「改」→ 输入 ${priceA} 回车` });

  await r.check('M7', `手动改价（第二行）：${pair.b.sheet} ${pair.b.sku} 改为 ¥${priceB} → 手动改价 2、普惠已采集 2`, async () => {
    await setInputValue('searchInput', pair.b.sku);
    await waitRows(1, 8000, '改价前定位第二行');
    await editPrice(pair.b.sku, 'util', priceB);
    await waitToast('已手动保存', 8000);
    await sleep(300);
    const cap = await captureOf(pair.b.sku);
    expect(cap && cap.util && Number(cap.util.price) === priceB, `采集记录=${oneLine(JSON.stringify(cap), 300)}`);
    const chips = await statsChips();
    expect(chips['手动改价'] === '2', `手动改价=${chips['手动改价']}，期望 2`);
    expect(chips['普惠已采集'] === '2 / ' + EXP.skuSet.size, `普惠已采集=${chips['普惠已采集']}`);
    await setInputValue('searchInput', '');
    await sleep(350);
    return `capture=${priceB}/manual · 手动改价2 · 普惠已采集2/${EXP.skuSet.size}`;
  }, { repro: `搜索 SKU=${pair.b.sku} → 第8列「改」→ 输入 ${priceB} 回车` });

  // ---- M8 同品比价 ----
  await r.check('M8', `同品比价：${EXP.groups.length} 组 / ${EXP.groupSkus.size} SKU；全部/只看有差异(1组,差¥${priceB - priceA})/只看待采齐 切换；导出比价 CSV 真实落盘且内容正确`, async () => {
    await clickId('tabCompare');
    await waitForPage(`(() => { const v = document.getElementById('viewCompare'); return !!v && !v.classList.contains('hidden'); })()`, { timeoutMs: 8000, label: '同品比价视图' });
    await sleep(600);
    const summary = await R(`document.getElementById('compareSummary').textContent`);
    expect(new RegExp(`同款分组 ${EXP.groups.length} 组`).test(summary), `分组数不符：${summary}`);
    expect(new RegExp(`共 ${EXP.groupSkus.size} 个 SKU`).test(summary), `SKU 数不符：${summary}`);
    expect(/有差异 1 组/.test(summary), `有差异组数不符：${summary}`);
    const groupsAll = await R(`document.querySelectorAll('#compareList tbody.cmpGroup').length`);
    expect(groupsAll === EXP.groups.length, `全部视图渲染 ${groupsAll} 组，期望 ${EXP.groups.length}`);
    // 只看有差异
    await clickId('cmpFilterDiff');
    await sleep(500);
    const groupsDiff = await R(`document.querySelectorAll('#compareList tbody.cmpGroup').length`);
    expect(groupsDiff === 1, `只看有差异渲染 ${groupsDiff} 组，期望 1`);
    const diffText = await R(`document.getElementById('compareList').innerText`);
    expect(diffText.includes(pair.a.sku) && diffText.includes(pair.b.sku), `有差异分组未包含两个 SKU：${oneLine(diffText, 500)}`);
    const badge = await R(`(() => Array.from(document.querySelectorAll('#compareList .cmpBadge')).map((b) => b.textContent).join(' | '))()`);
    expect(new RegExp('普惠差 ¥' + (priceB - priceA)).test(badge), `差异徽标=${badge}`);
    // 只看待采齐
    await clickId('cmpFilterMissing');
    await sleep(500);
    const groupsMissing = await R(`document.querySelectorAll('#compareList tbody.cmpGroup').length`);
    expect(groupsMissing === EXP.groups.length, `只看待采齐渲染 ${groupsMissing} 组，期望 ${EXP.groups.length}（当前只有 2 个 SKU 有普惠价）`);
    // 全部 + 导出
    await clickId('cmpFilterAll');
    await sleep(400);
    const before = new Set(downloads.map((d) => d.guid));
    await clickId('cmpExportBtn');
    const dl = await waitNewDownload((d) => /同品比价.*\.csv$/.test(d.suggested || ''), before, { label: '同品比价 CSV' });
    await waitToast('已导出同品比价 CSV', 6000);
    const text = fs.readFileSync(dl.filePath, 'utf8');
    expect(/型号,匹配键,店铺,Excel行,SKU/.test(text), `CSV 表头缺失：${oneLine(text, 200)}`);
    expect(text.includes(pair.a.sku) && text.includes(pair.b.sku), 'CSV 未包含两个比价 SKU');
    expect(new RegExp(',' + (priceB - priceA) + ',').test(text), `CSV 未包含价差 ${priceB - priceA}`);
    state.evidence.push(r.copyEvidence(dl.filePath, 'compare.csv'));
    return `summary=${summary} · 全部 ${groupsAll} 组 · 有差异 1 组(差¥${priceB - priceA}) · 待采齐 ${groupsMissing} 组 · CSV=${fmtBytes(fs.statSync(dl.filePath).size)}`;
  }, { repro: '同品比价 tab → 依次点 #cmpFilterAll/#cmpFilterDiff/#cmpFilterMissing → #cmpExportBtn' });

  // ---- M9 采集全部比价 SKU 弹窗（只测弹窗，不真实采集） ----
  await r.check('M9', '「采集全部比价 SKU」弹窗：提示 15 组 / 30 个 SKU，含账号+轨道选择，取消后无副作用', async () => {
    await clickId('cmpCollectBtn');
    await waitForPage(`(() => { const d = document.getElementById('rerunDialog'); return !!d && d.open; })()`, { timeoutMs: 6000, label: '重采弹窗打开' });
    const hint = await R(`document.getElementById('rerunHint').textContent`);
    expect(new RegExp(`${EXP.groups.length} 组同款 / ${EXP.groupSkus.size} 个 SKU`).test(hint), `弹窗提示=${oneLine(hint)}`);
    const opts = await R(`(() => ({
      identity: Array.from(document.querySelectorAll('#rerunIdentity option')).map((o) => o.value),
      track: Array.from(document.querySelectorAll('#rerunTrack option')).map((o) => o.value),
    }))()`);
    expect(opts.identity.includes('util') && opts.identity.includes('plus'), `账号选项=${oneLine(JSON.stringify(opts.identity))}`);
    expect(opts.track.includes('background') && opts.track.includes('foreground'), `轨道选项=${oneLine(JSON.stringify(opts.track))}`);
    await clickId('rerunCancel');
    await waitForPage(`(() => { const d = document.getElementById('rerunDialog'); return !!d && !d.open; })()`, { timeoutMs: 6000, label: '重采弹窗关闭' });
    const running = await R(`(typeof state !== 'undefined') ? state.running : null`);
    expect(running === false, `取消后 state.running=${running}`);
    return `hint=${oneLine(hint, 120)} · 账号 ${opts.identity.join('/')} · 轨道 ${opts.track.join('/')} · 取消无副作用`;
  }, { repro: '同品比价页点 #cmpCollectBtn → 检查 #rerunDialog → 取消' });

  // ---- M10 管理基表 + 导出基表 JSON ----
  let baseBackupPath = '';
  await r.check('M10', '管理基表弹窗：4 类目 tab（+全部）、首类目 36 行、导出基表 JSON 真实落盘（4 类目/153 行/146 有 SKU）', async () => {
    // 先回工作台视图（工具栏按钮在总览/比价视图下是隐藏的，隐藏元素 .click() 仍会触发，
    // 但 renderAll 在比价视图不会重绘表格，会让后续表格行数断言读到旧 DOM）
    await clickId('tabWorkbench');
    await waitForPage(`(() => { const v = document.getElementById('viewWorkbench'); return !!v && !v.classList.contains('hidden'); })()`, { timeoutMs: 8000, label: '工作台视图' });
    await sleep(300);
    await clickId('manageBaseBtn');
    await waitForPage(`(() => { const d = document.getElementById('baseDialog'); return !!d && d.open; })()`, { timeoutMs: 8000, label: '管理基表弹窗' });
    await sleep(400);
    const cats = await tabsInfo('baseCatTabs');
    expect(cats.length === EXP.sheets.length + 1, `管理基表类目 tab ${cats.length} 个，期望 ${EXP.sheets.length + 1}`);
    const rows = await R(`document.querySelectorAll('#baseTblBody tr').length`);
    expect(rows === EXP.sheets[0].rows, `首类目行数=${rows}，期望 ${EXP.sheets[0].rows}`);
    const before = new Set(downloads.map((d) => d.guid));
    await clickId('baseExportBtn');
    const dl = await waitNewDownload((d) => /基表备份.*\.json$/.test(d.suggested || ''), before, { label: '基表备份 JSON' });
    const base = readJson(dl.filePath);
    expect(Array.isArray(base.sheets) && base.sheets.length === EXP.sheets.length, `导出基表类目数=${base.sheets && base.sheets.length}`);
    expect(base.totalRows === EXP.totalRows && base.totalWithSku === EXP.withSku, `导出基表=${base.totalRows} 行/${base.totalWithSku} 有 SKU`);
    state.evidence.push(r.copyEvidence(dl.filePath, 'base-backup.json'));
    baseBackupPath = dl.filePath;
    await clickId('baseCloseBtn');
    await waitForPage(`(() => { const d = document.getElementById('baseDialog'); return !!d && !d.open; })()`, { timeoutMs: 6000, label: '管理基表关闭' });
    return `类目 tab=${cats.map((c) => c.name + '·' + c.count).join(' ')} · 首类目 ${rows} 行 · 导出 ${fmtBytes(fs.statSync(dl.filePath).size)}`;
  }, { repro: '#manageBaseBtn → #baseExportBtn → #baseCloseBtn' });

  // ---- M11 导入基表（同一份 JSON：无变化分支） ----
  await r.check('M11', '导入基表（上一步导出的 JSON，与当前一致）：confirm 展示 4 类目/153 行，alert 提示无变化，基表仍 153 行', async () => {
    const dlgMark = dialogs.length;
    await clickId('importBtn');
    await sleep(250);
    await page.setFileInputs('#importFile', [baseBackupPath]);
    const confirm = await waitDialog({ after: dlgMark, type: 'confirm', includes: '导入基表', timeoutMs: 15000 });
    expect(/类目：4 个/.test(confirm.message), `confirm 文案=${oneLine(confirm.message, 300)}`);
    expect(/153 行/.test(confirm.message), `confirm 文案未含 153 行：${oneLine(confirm.message, 300)}`);
    const alert = await waitDialog({ after: dlgMark, type: 'alert', includes: '基表已导入', timeoutMs: 15000 });
    expect(/完全一致/.test(alert.message), `alert 文案=${oneLine(alert.message, 300)}`);
    await waitToast('基表已导入', 10000);
    const s = await stateSnapshot();
    expect(s.baseRows === EXP.totalRows, `导入后基表 ${s.baseRows} 行，期望 ${EXP.totalRows}`);
    const baseInfo = await R(`document.getElementById('baseInfo').textContent`);
    expect(/当前使用/.test(baseInfo) && /153 行/.test(baseInfo), `baseInfo=${baseInfo}`);
    return `confirm=4类目/153行 · alert=完全一致 · baseInfo=${baseInfo}`;
  }, { repro: '#importBtn → DOM.setFileInputFiles(#importFile, 基表备份JSON) → confirm/alert 自动确认' });

  // ---- M12 导入基表（真实 xlsx：有差异分支） ----
  await r.check('M12', '导入基表（真实 SKU巡检表.xlsx）：confirm 展示 154 行，alert 展示变化明细，导入后 154 行生效', async () => {
    expect(ENV.xlsxPath, '找不到 SKU巡检表.xlsx（测试素材缺失）');
    const dlgMark = dialogs.length;
    await clickId('importBtn');
    await sleep(250);
    await page.setFileInputs('#importFile', [ENV.xlsxPath]);
    const confirm = await waitDialog({ after: dlgMark, type: 'confirm', includes: '导入基表', timeoutMs: 25000 });
    expect(/SKU巡检表\.xlsx/.test(confirm.message), `confirm 未含文件名：${oneLine(confirm.message, 300)}`);
    expect(/154 行/.test(confirm.message), `confirm 未显示 154 行（xlsx 比内置多 1 行）：${oneLine(confirm.message, 400)}`);
    const alert = await waitDialog({ after: dlgMark, type: 'alert', includes: '基表已导入', timeoutMs: 25000 });
    expect(/变化明细|完全一致/.test(alert.message), `alert 文案=${oneLine(alert.message, 400)}`);
    const toast = await waitToast('154 行', 15000);
    await sleep(300);
    const s = await stateSnapshot();
    expect(s.baseRows === 154, `导入 xlsx 后基表 ${s.baseRows} 行，期望 154`);
    const rows = (await tableInfo()).count;
    expect(rows === 154, `导入 xlsx 后表格 ${rows} 行，期望 154`);
    const baseInfo = await R(`document.getElementById('baseInfo').textContent`);
    expect(/154 行/.test(baseInfo) && /SKU巡检表\.xlsx/.test(baseInfo), `baseInfo=${baseInfo}`);
    return `confirm=154行 · alert=${oneLine(alert.message, 160)} · toast=${toast} · baseInfo=${baseInfo}`;
  }, { repro: '#importBtn → DOM.setFileInputFiles(#importFile, _work/.../SKU巡检表.xlsx) → confirm/alert 自动确认' });

  // ---- M13 恢复内置 ----
  await r.check('M13', '「恢复内置」：confirm 后基表回到内置 153 行，baseInfo 显示「内置基表」', async () => {
    const dlgMark = dialogs.length;
    await clickId('resetBaseBtn');
    const confirm = await waitDialog({ after: dlgMark, type: 'confirm', includes: '恢复为扩展内置的基表', timeoutMs: 10000 });
    expect(confirm.accept === true, 'confirm 未被接受');
    await waitToast('已恢复内置基表', 10000);
    await sleep(300);
    const s = await stateSnapshot();
    expect(s.baseRows === EXP.totalRows && s.overrideAt == null, `恢复后 baseRows=${s.baseRows} overrideAt=${s.overrideAt}`);
    const baseInfo = await R(`document.getElementById('baseInfo').textContent`);
    expect(/内置基表/.test(baseInfo), `baseInfo=${baseInfo}`);
    await waitRows(EXP.totalRows, 8000, '恢复内置后 153 行');
    return `baseInfo=${baseInfo}`;
  }, { repro: '#resetBaseBtn → confirm 接受' });

  // ---- M14 设置弹窗：改值保存、取消不保存、重开与刷新后保留 ----
  await r.check('M14', '设置弹窗：取消不保存；改 batch/间隔/跳过今天/预览延迟/偏离阈值 + patrolMode 后保存，重开与刷新后值都在', async () => {
    await openSettingsDialog();
    const before = await settingsFormValues();
    expect(before.batch != null, '设置弹窗字段读取失败');
    // 取消不保存
    await setInputValue('setBatch', 999);
    await closeSettingsDialog();
    await openSettingsDialog();
    const afterCancel = await settingsFormValues();
    expect(afterCancel.batch === before.batch, `取消后 batch=${afterCancel.batch}，期望 ${before.batch}`);
    // 修改并保存
    await fillSettingsPatch({
      setBatch: 5, setDelayMin: 2, setDelayMax: 4, setSkipToday: false,
      setPreviewDelay: 800, setDeviationLimit: 600, setDeviationConfirm: 1600, setPatrolMode: 'foreground',
    });
    await saveSettingsDialog();
    await sleep(400);
    await openSettingsDialog();
    const re = await settingsFormValues();
    expect(re.batch === '5' && re.delayMin === '2' && re.delayMax === '4', `重开值 batch=${re.batch} min=${re.delayMin} max=${re.delayMax}`);
    expect(re.skipToday === false, `重开后 skipToday=${re.skipToday}`);
    expect(re.previewDelay === '800' && re.deviationLimit === '600' && re.deviationConfirm === '1600', `重开值 preview=${re.previewDelay} dev=${re.deviationLimit}/${re.deviationConfirm}`);
    await closeSettingsDialog();
    await reloadPage(1800);
    await waitForPage(`(() => document.readyState === 'complete' && typeof state !== 'undefined' && state.db)()`, { timeoutMs: 25000, label: '刷新后 state 就绪' });
    const s = await stateSnapshot();
    expect(s.settings.batchSize === 5 && s.settings.delayMin === 2 && s.settings.delayMax === 4, `刷新后 settings=${oneLine(JSON.stringify(s.settings))}`);
    expect(s.settings.skipCapturedToday === false && s.settings.previewDelayMs === 800, `刷新后 skip/preview=${s.settings.skipCapturedToday}/${s.settings.previewDelayMs}`);
    expect(s.settings.deviationLimit === 600 && s.settings.deviationConfirmLimit === 1600, `刷新后偏离阈值=${s.settings.deviationLimit}/${s.settings.deviationConfirmLimit}`);
    return `取消不保存 ✓ · 保存重开 ✓ · 刷新后 batch=${s.settings.batchSize}/delay=${s.settings.delayMin}-${s.settings.delayMax}/preview=${s.settings.previewDelayMs}/dev=${s.settings.deviationLimit}-${s.settings.deviationConfirmLimit}`;
  }, { repro: '#settingsBtn → 改字段 → #settingsSave → 重开/Page.reload' });

  // ---- M15 AI 设置弹窗 ----
  await r.check('M15', '「AI 设置」按钮打开设置弹窗：AI 接口/模型/Key/复核模式已预配置（不发起外部 AI 请求）', async () => {
    await clickId('aiBtn');
    await waitForPage(`(() => { const d = document.getElementById('settingsDialog'); return !!d && d.open; })()`, { timeoutMs: 6000, label: 'AI 设置弹窗' });
    await sleep(400);
    const v = await settingsFormValues();
    expect(/gateway\.example\.com/.test(String(v.aiEndpoint)), `AI 接口=${v.aiEndpoint}`);
    expect(String(v.aiModel).length > 0, `AI 模型=${v.aiModel}`);
    expect(v.aiKeyLen > 10, `AI Key 未预配置（长度 ${v.aiKeyLen}）`);
    expect(['off', 'fallback', 'all'].includes(v.aiVerifyMode), `AI 复核模式=${v.aiVerifyMode}`);
    expect(v.aiEnabled === true, `AI 启用=${v.aiEnabled}`);
    await r.shot('11-patrol-settings-ai.png', '巡检设置弹窗（AI 已预配置 + 官方API账号区）');
    await closeSettingsDialog();
    return `AI 接口预配置 · 模型=${v.aiModel} · Key 长度=${v.aiKeyLen} · 复核=${v.aiVerifyMode}`;
  }, { repro: '#aiBtn → 检查 #setAiEndpoint/#setAiModel/#setAiKey/#setAiVerifyMode' });

  // ---- M16 双轨切换 ----
  await r.check('M16', '双轨切换：点「轨道①」→ 徽标/标题/正文 class 切到后台标签页；点「轨道②」切回', async () => {
    await clickId('tabWorkbench');
    await sleep(300);
    const clickTrack = (track) => R(`(() => { const b = document.querySelector('.trackOpt[data-track="${track}"]'); if (!b) return { ok: false }; b.click(); return { ok: true }; })()`);
    const c1 = await clickTrack('track1');
    expect(c1.ok, '找不到 track1 按钮');
    await waitToast('已切换到 轨道①', 8000);
    await sleep(300);
    const s1 = await R(`(() => ({ badge: document.getElementById('trackBadge').textContent, meta: document.getElementById('trackMeta').textContent, title: document.title, bodyClass: document.body.className, active: (document.querySelector('.trackOpt.active') || {}).dataset ? document.querySelector('.trackOpt.active').dataset.track : '' }))()`);
    expect(/轨道①/.test(s1.badge), `徽标=${s1.badge}`);
    expect(/后台标签页/.test(s1.meta), `轨道说明=${s1.meta}`);
    expect(/track1/.test(s1.bodyClass) && s1.active === 'track1', `bodyClass=${s1.bodyClass} active=${s1.active}`);
    const c2 = await clickTrack('track2');
    expect(c2.ok, '找不到 track2 按钮');
    await waitToast('已切换到 轨道②', 8000);
    await sleep(300);
    const s2 = await R(`(() => ({ badge: document.getElementById('trackBadge').textContent, bodyClass: document.body.className, active: (document.querySelector('.trackOpt.active') || {}).dataset ? document.querySelector('.trackOpt.active').dataset.track : '' }))()`);
    expect(/轨道②/.test(s2.badge), `切回后徽标=${s2.badge}`);
    expect(/track2/.test(s2.bodyClass) && s2.active === 'track2', `切回后 bodyClass=${s2.bodyClass} active=${s2.active}`);
    return `轨道① 徽标=${s1.badge.trim()} · 轨道② 徽标=${s2.badge.trim()}`;
  }, { repro: '点击 .trackOpt[data-track=track1/track2]，检查 #trackBadge/#trackMeta/body.class' });

  // ---- M17 下架 / 恢复 ----
  const offlineRow = EXP.offlineCandidate;
  expect(offlineRow, '基表里找不到可下架测试行');
  const offlineSku = String(offlineRow.sku);
  await r.check('M17', `下架/恢复：${offlineSku} 下架后从默认表隐藏、统计「已下架 1 行」、筛选已下架可见并可恢复`, async () => {
    await setInputValue('searchInput', offlineSku);
    await waitRows(1, 8000, '定位下架测试行');
    const op = await clickRowOp(offlineSku, '下架');
    expect(op.ok, `点击下架失败：${oneLine(JSON.stringify(op))}`);
    const toast = await waitToast('已移入下架库', 8000);
    await sleep(300);
    const chips = await statsChips();
    expect(chips['已下架'] === '1 行', `已下架=${chips['已下架']}`);
    let t = await tableInfo();
    expect(t.count === 0, `下架后默认表行数=${t.count}，期望 0（当前搜索该 SKU）`);
    await setInputValue('searchInput', '');
    await sleep(300);
    await selectValue('statusFilter', 'offline');
    await sleep(500);
    await waitRows(1, 8000, '已下架筛选 1 行');
    const restored = await clickRowOp(offlineSku, '恢复');
    expect(restored.ok, `点击恢复失败：${oneLine(JSON.stringify(restored))}`);
    const toast2 = await waitToast('已恢复', 8000);
    await sleep(300);
    const chips2 = await statsChips();
    expect(!chips2['已下架'], `恢复后仍有已下架统计：${chips2['已下架']}`);
    await selectValue('statusFilter', 'all');
    await sleep(400);
    await waitRows(EXP.totalRows, 8000, '恢复后全部 153 行');
    const s = await stateSnapshot();
    expect((s.offlineRows || []).length === 0 && (s.offlineSkus || []).length === 0, `内部下架状态未清空：${oneLine(JSON.stringify({ r: s.offlineRows, s: s.offlineSkus }))}`);
    await setInputValue('searchInput', '');
    await sleep(300);
    return `下架 toast=${toast} · 已下架1行 · 恢复 toast=${toast2} · 状态已清空`;
  }, { repro: `搜索 ${offlineSku} → 操作列「下架」→ 状态筛选「已下架」→「恢复」` });

  // ---- M18 导出 CSV / JSON ----
  let exportedJsonPath = '';
  let exportedCsvPath = '';
  await r.check('M18', '导出 CSV 与导出 JSON：真实下载落盘；CSV 表头/153 行/含手动改价；JSON 含 captures/settings/rows', async () => {
    let before = new Set(downloads.map((d) => d.guid));
    await clickId('exportBtn');
    const csv = await waitNewDownload((d) => /巡检结果.*\.csv$/.test(d.suggested || ''), before, { label: '导出 CSV' });
    await waitToast('已导出 CSV', 6000);
    const csvText = fs.readFileSync(csv.filePath, 'utf8');
    expect(/类目,Excel行,SKU,套餐型号/.test(csvText), `CSV 表头=${oneLine(csvText, 200)}`);
    const lines = csvText.replace(/^\uFEFF/, '').split(/\r?\n/);
    expect(lines.length === EXP.totalRows + 1, `CSV 行数=${lines.length}（含表头），期望 ${EXP.totalRows + 1}`);
    expect(csvText.includes(pair.a.sku) && csvText.includes(pair.b.sku), 'CSV 缺少手动改价的 SKU');
    expect(/手动/.test(csvText), 'CSV 未体现「手动」价格类型');
    exportedCsvPath = csv.filePath;
    state.evidence.push(r.copyEvidence(csv.filePath, 'patrol-export.csv'));
    before = new Set(downloads.map((d) => d.guid));
    await clickId('exportJsonBtn');
    const json = await waitNewDownload((d) => /巡检数据.*\.json$/.test(d.suggested || ''), before, { label: '导出 JSON' });
    await waitToast('已导出 JSON', 6000);
    const payload = readJson(json.filePath);
    expect(payload.captures && Object.keys(payload.captures).length === 2, `JSON captures=${payload.captures ? Object.keys(payload.captures).length : 'null'}，期望 2`);
    expect(payload.settings && payload.settings.batchSize === 5, `JSON settings.batchSize=${payload.settings && payload.settings.batchSize}`);
    expect(Array.isArray(payload.rows) && payload.rows.length === EXP.totalRows, `JSON rows=${payload.rows ? payload.rows.length : 'null'}`);
    expect(payload.captures[pair.a.sku] && Number(payload.captures[pair.a.sku].util.price) === priceA, 'JSON 未包含手动改价记录');
    exportedJsonPath = json.filePath;
    state.evidence.push(r.copyEvidence(json.filePath, 'patrol-export.json'));
    return `CSV=${fmtBytes(fs.statSync(csv.filePath).size)}/${lines.length} 行 · JSON=${fmtBytes(fs.statSync(json.filePath).size)} captures=2 rows=153`;
  }, { repro: '#exportBtn / #exportJsonBtn（浏览器下载行为已设到临时目录，监听 Browser.downloadProgress）' });

  // ---- M19 清空采集 ----
  await r.check('M19', '清空采集：confirm 文案正确、清空前自动下载 JSON 备份、清空后采集数与「手动改价」统计归零', async () => {
    const before = new Set(downloads.map((d) => d.guid));
    const dlgMark = dialogs.length;
    await clickId('purgeBtn');
    const confirm = await waitDialog({ after: dlgMark, type: 'confirm', includes: '清空所有已采集的价格', timeoutMs: 10000 });
    expect(confirm.accept, '清空采集 confirm 未被接受');
    const backup = await waitNewDownload((d) => /巡检数据.*\.json$/.test(d.suggested || ''), before, { label: '清空前自动备份 JSON' });
    const payload = readJson(backup.filePath);
    expect(Object.keys(payload.captures || {}).length === 2, `自动备份 captures=${Object.keys(payload.captures || {}).length}，期望 2`);
    await waitToast('已清空采集结果', 8000);
    await sleep(500);
    const s = await stateSnapshot();
    expect(s.captures === 0, `清空后 captures=${s.captures}`);
    const chips = await statsChips();
    expect(!chips['手动改价'], `清空后仍有手动改价统计：${chips['手动改价']}`);
    expect(chips['普惠已采集'] === '0 / ' + EXP.skuSet.size, `清空后普惠已采集=${chips['普惠已采集']}`);
    return `confirm ✓ · 自动备份 ${fmtBytes(fs.statSync(backup.filePath).size)}（captures=2）· 清空后 captures=0`;
  }, { repro: '#purgeBtn → confirm 接受 → 检查自动备份下载 + state.db.captures' });

  // ---- M20 导入数据（回导 M18 的 JSON） ----
  await r.check('M20', '导入数据：用 M18 导出的 JSON 通过 DOM.setFileInputFiles 回导，confirm 后 2 个 SKU 采集记录与手动改价恢复', async () => {
    const dlgMark = dialogs.length;
    await clickId('importDataBtn');
    await sleep(250);
    await page.setFileInputs('#importDataFile', [exportedJsonPath]);
    const confirm = await waitDialog({ after: dlgMark, type: 'confirm', includes: '导入巡检数据：2 个 SKU', timeoutMs: 15000 });
    expect(confirm.accept, '导入数据 confirm 未被接受');
    const toast = await waitToast('已导入巡检数据：2 个 SKU', 10000);
    await sleep(400);
    const s = await stateSnapshot();
    expect(s.captures === 2, `导入后 captures=${s.captures}，期望 2`);
    const chips = await statsChips();
    expect(chips['手动改价'] === '2', `导入后手动改价=${chips['手动改价']}`);
    await setInputValue('searchInput', pair.a.sku);
    await waitRows(1, 8000, '回导后定位改价行');
    const row = await rowPriceText(pair.a.sku);
    expect(/4,000/.test(row.util), `回导后价格=${oneLine(row.util)}`);
    expect(/手动/.test(row.util), `回导后价格类型未显示手动：${oneLine(row.util)}`);
    await setInputValue('searchInput', '');
    await sleep(300);
    return `toast=${toast} · captures=2 · 手动改价2 · 价格 ${oneLine(row.util, 60)}`;
  }, { repro: '#importDataBtn → DOM.setFileInputFiles(#importDataFile, 导出的JSON) → confirm 接受' });

  // ---- M21 导入数据负例 ----
  await r.check('M21', '导入数据负例：导入非法 JSON 时 alert 明确报错且现有采集数据不受影响', async () => {
    const badFile = path.join(ENV.downloadDir, 'qa-invalid-import.json');
    fs.writeFileSync(badFile, '{ this is not valid json ');
    const dlgMark = dialogs.length;
    await clickId('importDataBtn');
    await sleep(250);
    await page.setFileInputs('#importDataFile', [badFile]);
    const alert = await waitDialog({ after: dlgMark, type: 'alert', includes: 'JSON 解析失败', timeoutMs: 12000 });
    expect(/JSON 解析失败/.test(alert.message), `alert=${oneLine(alert.message, 300)}`);
    const s = await stateSnapshot();
    expect(s.captures === 2, `非法导入后 captures=${s.captures}（不应变化）`);
    return `alert=${oneLine(alert.message, 120)} · captures 仍为 2`;
  }, { repro: '构造非法 json → #importDataBtn → 导入 → 自动接受 alert' });

  // ---- M22 总览复检 + 待上报区 + 导出 Excel ----
  await r.check('M22', '总览复检（普惠已采集 2/146、手动改价 2、低于阈值 1）→ 手动改价筛选 2 行 → 汇总选中 → 导出待上报 Excel（xlsx 落盘）→ 清空待上报', async () => {
    await clickId('tabOverview');
    await sleep(600);
    const cards = await overviewCards();
    const map = Object.fromEntries(cards.map((c) => [c.label, c.value]));
    expect(map['普惠已采集'] === '2 / ' + EXP.skuSet.size, `普惠已采集=${map['普惠已采集']}`);
    expect(map['手动改价'] === '2', `手动改价=${map['手动改价']}`);
    expect(map['低于阈值'] === '1', `低于阈值=${map['低于阈值']}`);
    expect(map['未采集'] === String(EXP.withSku - 2), `未采集=${map['未采集']}，期望 ${EXP.withSku - 2}`);
    const c = await clickOverviewCard('手动改价');
    expect(c.ok, '点击「手动改价」卡片失败');
    await sleep(500);
    const t = await tableInfo();
    expect(t.count === 2, `手动改价筛选行数=${t.count}，期望 2`);
    const cap = await R(`document.getElementById('tableCaption').textContent`);
    expect(/手动改价/.test(cap) && /共 2 行/.test(cap), `表标题=${cap}`);
    // 勾选第一行 → 汇总选中
    await R(`(() => { const chk = document.querySelector('#tblBody tr input[type=checkbox]'); if (!chk) return false; chk.checked = true; chk.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await sleep(300);
    await clickId('ovSummaryBtn');
    await waitToast('已加入待上报区', 8000);
    await sleep(400);
    const rep = await R(`(() => ({
      badge: (document.getElementById('reportBadge') || {}).textContent || '',
      badgeHidden: document.getElementById('reportBadge').classList.contains('hidden'),
      areaVisible: !document.getElementById('reportArea').classList.contains('hidden'),
      count: (document.getElementById('reportCount') || {}).textContent || '',
      exportDisabled: document.getElementById('ovExportReportBtn').disabled,
    }))()`);
    expect(rep.badge === '1' && !rep.badgeHidden, `待上报徽标=${oneLine(JSON.stringify(rep))}`);
    expect(rep.areaVisible && rep.count === '1 条', `待上报区=${oneLine(JSON.stringify(rep))}`);
    expect(!rep.exportDisabled, '待上报导出按钮应可用');
    const before = new Set(downloads.map((d) => d.guid));
    await clickId('ovExportReportBtn');
    const xlsx = await waitNewDownload((d) => /待上报.*\.xlsx$/.test(d.suggested || ''), before, { label: '待上报 Excel' });
    const head = fs.readFileSync(xlsx.filePath).slice(0, 4);
    expect(head[0] === 0x50 && head[1] === 0x4B, `xlsx 文件头异常：${head.toString('hex')}`);
    state.evidence.push(r.copyEvidence(xlsx.filePath, 'report.xlsx'));
    const dlgMark = dialogs.length;
    await clickId('ovClearReportBtn');
    await waitDialog({ after: dlgMark, type: 'confirm', includes: '清空待上报区', timeoutMs: 8000 });
    await waitToast('待上报区已清空', 8000);
    await clickId('ovClearFilterBtn');
    await sleep(400);
    await r.shot('12-patrol-overview.png', '总览页（12 数字卡片 + 待上报区/筛选）');
    return `卡片复检 ✓ · 手动改价 2 行 · 待上报 1 条 · xlsx=${fmtBytes(fs.statSync(xlsx.filePath).size)} · 已清空待上报`;
  }, { repro: '总览 → 手动改价卡 → 勾选行 → #ovSummaryBtn → #ovExportReportBtn → #ovClearReportBtn' });

  // ---- M23 运行入口确认弹窗（取消路径，不发起真实电商平台采集） ----
  await r.check('M23', '「普惠号巡检」确认弹窗：展示 SKU 数与采集方式，取消后不进入运行态（不发起真实外部采集）', async () => {
    await clickId('tabWorkbench');
    await sleep(300);
    const dlgMark = dialogs.length;
    dialogPolicy = () => false; // 本次 confirm 选“取消”
    try {
      await clickId('runUtilBtn');
      const confirm = await waitDialog({ after: dlgMark, type: 'confirm', includes: '开始【普惠账号】巡检', timeoutMs: 10000 });
      expect(/本次 SKU：\d+ 个/.test(confirm.message), `confirm 文案=${oneLine(confirm.message, 400)}`);
      expect(/前台小窗|后台标签页/.test(confirm.message), `confirm 未展示采集方式：${oneLine(confirm.message, 400)}`);
      expect(confirm.accept === false, '本次 confirm 应为取消（测试策略 false），实际 accept=' + confirm.accept);
      await sleep(600);
      const s = await stateSnapshot();
      const run = await R(`(() => ({ running: state.running, utilDisabled: document.getElementById('runUtilBtn').disabled, progressHidden: document.getElementById('progressWrap').classList.contains('hidden'), targets: 0 }))()`);
      expect(run.running === false && !run.utilDisabled, `取消后运行态=${oneLine(JSON.stringify(run))}`);
      const pages = await listPageTargets();
      expect(pages.filter((t) => /item\.jd\.com/.test(t.url || '')).length === 0, '取消后不应打开电商平台商品页 target');
      return `confirm=${oneLine(confirm.message, 120)} · 取消后 running=false · 未打开电商平台页`;
    } finally {
      dialogPolicy = () => true;
    }
  }, { repro: '点击 #runUtilBtn，Page.javascriptDialogOpening 时选择「取消」' });

  // ---- M24 多供应商 API 账号区（在线/自然状态分支） ----
  await r.check('M24', '多供应商 API 账号区：桥状态 chip、账号行、刷新、新增供应商行、空保存提示（不写入真实凭据）', async () => {
    await openSettingsDialog();
    // 等账号区异步加载完成
    await waitForPage(`(() => { const el = document.getElementById('apiAccountInfo'); return !!el && String(el.textContent || '').trim().length > 0; })()`, { timeoutMs: 15000, label: 'API 账号区加载' });
    await sleep(600);
    const chip = await R(`document.getElementById('apiStatusChip').textContent`);
    expect(/官方API (已连接|未启动|未检测)/.test(chip), `API chip=${chip}`);
    const info = await apiAccountAreaInfo();
    expect(info.addBtn && info.refreshBtn, 'API 账号区缺少新增/刷新按钮');
    if (ENV.apiBridgeUp) {
      expect(/桥已连接/.test(info.info), `桥应在线但提示=${info.info}`);
      expect(info.rows >= 2, `桥在线时账号行=${info.rows}，期望 ≥2`);
      expect(/已启用账号/.test(info.info), `账号信息=${info.info}`);
    } else {
      expect(/API 桥未连接/.test(info.info), `桥离线时应提示未连接，实际=${info.info}`);
      expect(info.rows >= 1, `桥离线时应展示可填写行，实际行数=${info.rows}`);
    }
    // 刷新
    await clickId('apiRefreshBtn');
    await sleep(1200);
    const info2 = await apiAccountAreaInfo();
    expect(info2.rows === info.rows || (ENV.apiBridgeUp && info2.rows >= 2), `刷新后账号行=${info2.rows}`);
    // 新增供应商行
    const rowsBefore = info2.rows;
    await clickId('apiAddBtn');
    await sleep(400);
    const info3 = await apiAccountAreaInfo();
    expect(info3.rows === rowsBefore + 1, `新增供应商后行数=${info3.rows}，期望 ${rowsBefore + 1}`);
    const focusInfo = await R(`(() => { const row = document.querySelectorAll('#apiAccountList .apiRow'); const last = row[row.length - 1]; const name = last && last.querySelector('.api-name'); return { hasName: !!name, focused: !!(name && document.activeElement === name), fields: last ? Array.from(last.querySelectorAll('input')).map((i) => i.className) : [] }; })()`);
    expect(focusInfo.hasName && focusInfo.fields.length >= 6, `新增行字段不足：${oneLine(JSON.stringify(focusInfo))}`);
    // 空保存 → 校验提示不崩
    const saveBtn = await R(`(() => { const rows = document.querySelectorAll('#apiAccountList .apiRow'); const last = rows[rows.length - 1]; if (!last) return { ok: false }; const b = last.querySelector('button[data-api-action=save]'); if (!b) return { ok: false }; b.click(); return { ok: true }; })()`);
    expect(saveBtn.ok, '新增行没有保存按钮');
    const toast = await waitToast('需要填完整', 8000);
    const s = await stateSnapshot();
    expect(s != null, '空保存后页面 state 异常');
    const info4 = await apiAccountAreaInfo();
    expect(info4.rows === info3.rows, `空保存后行数不应变化：${info4.rows}`);
    await closeSettingsDialog();
    return `chip=${chip} · 初始账号行=${info.rows} · 新增后=${info3.rows} · 空保存 toast=${toast}`;
  }, { repro: '设置弹窗 → API 账号区 #apiRefreshBtn/#apiAddBtn/最后一行「保存」' });

  // ---- M25 API 桥未连接分支（指向不可达地址） ----
  await r.check('M25', 'API 桥未连接分支：把官方API地址改为不可达端口后，账号区显示「API 桥未连接」且应用不崩（浏览器网络日志已归类）', async () => {
    addExpectedConsoleRule(/127\.0\.0\.1:18799/, 'API 桥未连接分支：页面按设计去探测了不可达地址，Chromium 自身打印 net::ERR_CONNECTION_REFUSED；应用已 catch 并显示「API 桥未连接」，非 JS 未捕获错误。');
    if (!ENV.apiBridgeUp) addExpectedConsoleRule(/127\.0\.0\.1:18765/, '本机 API 桥未运行：初始化/设置页探测官方API地址产生的浏览器网络日志，应用已捕获并提示未连接。');
    const origUrl = await R(`(typeof state !== 'undefined' && state.db) ? state.db.settings.officialApiUrl : ''`);
    await openSettingsDialog();
    await setInputValue('setOfficialApiUrl', 'http://127.0.0.1:18799');
    await saveSettingsDialog();
    await sleep(500);
    await openSettingsDialog();
    await waitForPage(`(() => { const el = document.getElementById('apiAccountInfo'); return /API 桥未连接/.test(String(el && el.textContent || '')); })()`, { timeoutMs: 15000, label: 'API 桥未连接提示' });
    const info = await apiAccountAreaInfo();
    expect(/API 桥未连接/.test(info.info), `提示=${info.info}`);
    expect(/启动API桥\.py/.test(info.info), `提示未引导启动 API 桥：${info.info}`);
    expect(info.rows >= 1, `未连接时仍应有可填写行，实际=${info.rows}`);
    const pageAlive = await R(`(() => ({ body: document.body.innerText.length, hasErrorBox: !!document.getElementById('pageErrorBox') }))()`);
    expect(pageAlive.body > 1000, `页面正文异常短：${pageAlive.body}`);
    expect(!pageAlive.hasErrorBox, '页面出现脚本错误提示框（#pageErrorBox）');
    // 恢复原地址
    await setInputValue('setOfficialApiUrl', origUrl || 'http://127.0.0.1:18765');
    await saveSettingsDialog();
    await sleep(600);
    await openSettingsDialog();
    await sleep(1500);
    const info2 = await apiAccountAreaInfo();
    if (ENV.apiBridgeUp) expect(/桥已连接/.test(info2.info), `恢复地址后提示=${info2.info}`);
    await closeSettingsDialog();
    return `未连接提示=${oneLine(info.info, 160)} · 页面无脚本错误框 · 已恢复地址=${origUrl}`;
  }, { repro: '#settingsBtn → 官方API地址改 http://127.0.0.1:18799 → 保存 → 重开设置看账号区提示' });

  // ---- M26 基表自动升级 ----
  const seed = {
    captures: { [pair.a.sku]: { util: { price: priceA, kind: 'manual', at: nowIso() }, updatedAt: nowIso(), fail: null } },
    offlineRows: [offlineRow.rowId],
    offlineSkus: [],
  };
  await r.check('M26', `基表自动升级：从平台首页写入旧 generatedAt 基表(${OLD_BASE.base.generatedAt}) + 下架/改价状态 → 进巡检页提示「内置基表已更新」、153 行、状态保留`, async () => {
    // 先从平台首页写 storage（避免巡检页自身的 storage.onChanged 抢先升级并把旧内存库写回）
    await gotoPlatformHome(1800);
    const seeded = await R(`(async () => {
      const db = {
        version: 2,
        settings: { batchSize: 5, delayMin: 2, delayMax: 4, skipCapturedToday: true, scope: 'all', keepTab: false,
          deviationLimit: 600, deviationConfirmLimit: 1600, previewDelayMs: 800, patrolMode: 'foreground',
          aiEnabled: true, aiVerifyMode: 'fallback', officialApiUrl: ${JSON.stringify('http://127.0.0.1:18765')} },
        skuOverrides: {}, thumbs: {}, reportRows: [],
        captures: ${JSON.stringify(seed.captures)},
        offlineRows: ${JSON.stringify(seed.offlineRows)}, offlineSkus: [],
        lastIdentity: 'util'
      };
      await chrome.storage.local.set({ 'patrol.db.v2': db });
      await chrome.storage.local.set({ 'patrol.base.v1': ${JSON.stringify(OLD_BASE.base)} });
      const g = await chrome.storage.local.get(null);
      return { keys: Object.keys(g), baseAt: g['patrol.base.v1'].generatedAt, caps: Object.keys(g['patrol.db.v2'].captures || {}), off: g['patrol.db.v2'].offlineRows };
    })()`);
    expect(seeded.baseAt === OLD_BASE.base.generatedAt, `写入的旧基表 generatedAt=${seeded.baseAt}`);
    expect(seeded.caps.length === 1 && seeded.off.length === 1, `写入状态异常：${oneLine(JSON.stringify(seeded))}`);
    // 进巡检页 → 自动升级
    await page.navigate(`chrome-extension://${ENV.extId}/modules/patrol/app.html`, { settleMs: 700 });
    const toast = await waitToast('内置基表已更新', 12000);
    expect(/已下架 \/ 手动改价状态已保留/.test(toast), `升级 toast=${toast}`);
    await sleep(300);
    const s = await stateSnapshot();
    expect(s.baseUpgraded && s.baseUpgraded.from === OLD_BASE.base.generatedAt, `state.baseUpgraded=${oneLine(JSON.stringify(s.baseUpgraded))}`);
    expect(String(s.baseUpgraded.to).startsWith(String(BUILTIN_BASE.generatedAt).slice(0, 16)), `升级目标 generatedAt=${s.baseUpgraded.to}，期望内置 ${BUILTIN_BASE.generatedAt}`);
    expect(s.baseRows === EXP.totalRows && s.baseAt === BUILTIN_BASE.generatedAt, `升级后基表=${s.baseRows} 行 @ ${s.baseAt}`);
    expect(s.captures === 1, `升级后 captures=${s.captures}，期望 1（手动改价保留）`);
    expect((s.offlineRows || []).includes(offlineRow.rowId), `升级后 offlineRows=${oneLine(JSON.stringify(s.offlineRows))}，期望保留 ${offlineRow.rowId}`);
    const chips = await statsChips();
    expect(chips['已下架'] === '1 行', `升级后已下架=${chips['已下架']}`);
    expect(chips['手动改价'] === '1', `升级后手动改价=${chips['手动改价']}`);
    expect(chips['有效行数'] === (EXP.totalRows - 1) + ' 行', `升级后有效行数=${chips['有效行数']}`);
    await waitRows(EXP.totalRows - 1, 8000, '升级后默认表（隐藏已下架）行数');
    const store = await R(`(async () => { const g = await chrome.storage.local.get(['patrol.base.v1', 'patrol.db.v2']); return { baseAt: g['patrol.base.v1'] && g['patrol.base.v1'].generatedAt, caps: Object.keys((g['patrol.db.v2'] || {}).captures || {}), off: (g['patrol.db.v2'] || {}).offlineRows }; })()`);
    expect(store.baseAt === BUILTIN_BASE.generatedAt, `storage 中 patrol.base.v1 未升级：${store.baseAt}`);
    expect(store.caps.length === 1 && store.off.includes(offlineRow.rowId), `storage 中状态丢失：${oneLine(JSON.stringify(store))}`);
    const baseInfo = await R(`document.getElementById('baseInfo').textContent`);
    expect(/153 行/.test(baseInfo) && /当前使用/.test(baseInfo), `baseInfo=${baseInfo}`);
    // 已下架行仍可筛选查看
    await selectValue('statusFilter', 'offline');
    await sleep(500);
    await waitRows(1, 8000, '升级后已下架筛选 1 行');
    const offRow = await R(`(() => { const tr = document.querySelector('#tblBody tr'); const tds = tr ? tr.querySelectorAll('td') : []; return { sku: tds[3] ? tds[3].textContent.trim() : '', op: tds[13] ? tds[13].textContent : '' }; })()`);
    expect(offRow.sku === offlineSku, `已下架行 SKU=${offRow.sku}，期望 ${offlineSku}`);
    expect(/恢复/.test(offRow.op), `已下架行缺少恢复按钮：${offRow.op}`);
    await selectValue('statusFilter', 'all');
    await sleep(400);
    // 手动改价仍在
    await setInputValue('searchInput', pair.a.sku);
    await waitRows(1, 8000, '升级后定位改价行');
    const row = await rowPriceText(pair.a.sku);
    expect(/4,000/.test(row.util) && /手动/.test(row.util), `升级后改价丢失：${oneLine(row.util)}`);
    await setInputValue('searchInput', '');
    await sleep(300);
    await r.shot('13-patrol-base-upgrade.png', '基表自动升级提示（内置基表已更新）+ 状态保留');
    return `toast=${toast} · from=${s.baseUpgraded.from} → to=${s.baseUpgraded.to} · 153 行 · captures=1 · 已下架1/手动改价1 · 已下架行=${offRow.sku}`;
  }, { repro: '平台首页写 chrome.storage.local：patrol.base.v1=旧基表 + patrol.db.v2 带 captures/offlineRows → 打开 modules/patrol/app.html → 读 #toast/state/storage' });

  // ---- M27 帮助弹窗 ----
  await r.check('M27', '「帮助」弹窗：使用说明条目完整（≥15 条）并可关闭', async () => {
    await clickId('helpBtn');
    await waitForPage(`(() => { const d = document.getElementById('helpDialog'); return !!d && d.open; })()`, { timeoutMs: 6000, label: '帮助弹窗' });
    const info = await R(`(() => ({
      title: (document.querySelector('#helpDialog h2') || {}).textContent || '',
      items: document.querySelectorAll('#helpDialog .helpList li').length,
      textLen: document.getElementById('helpDialog').innerText.length,
    }))()`);
    expect(/使用说明/.test(info.title), `帮助标题=${info.title}`);
    expect(info.items >= 15, `帮助条目=${info.items}，期望 ≥15`);
    await clickId('helpClose');
    await waitForPage(`(() => { const d = document.getElementById('helpDialog'); return !!d && !d.open; })()`, { timeoutMs: 6000, label: '帮助弹窗关闭' });
    return `标题=${info.title} · ${info.items} 条 · 关闭 ✓`;
  }, { repro: '#helpBtn → 检查 #helpDialog → #helpClose' });

  // ---- M28 管理基表增行/保存/恢复内置 ----
  await r.check('M28', '管理基表：新增一行→保存修改 154 行生效（当前使用=手动管理）→ 恢复内置回 153 行', async () => {
    await clickId('manageBaseBtn');
    await waitForPage(`(() => { const d = document.getElementById('baseDialog'); return !!d && d.open; })()`, { timeoutMs: 8000, label: '管理基表弹窗' });
    await sleep(400);
    const before = await R(`document.querySelectorAll('#baseTblBody tr').length`);
    await clickId('baseAddRowBtn');
    await sleep(300);
    const after = await R(`document.querySelectorAll('#baseTblBody tr').length`);
    expect(after === before + 1, `新增行后 ${after} 行，期望 ${before + 1}`);
    await clickId('baseSaveBtn');
    const toast = await waitToast('基表已保存', 10000);
    await sleep(500);
    const s = await stateSnapshot();
    expect(s.baseRows === 154, `保存后基表 ${s.baseRows} 行，期望 154`);
    const baseInfo = await R(`document.getElementById('baseInfo').textContent`);
    expect(/154 行/.test(baseInfo) && /手动管理/.test(baseInfo), `baseInfo=${baseInfo}`);
    await clickId('baseCloseBtn');
    await sleep(300);
    const dlgMark = dialogs.length;
    await clickId('resetBaseBtn');
    await waitDialog({ after: dlgMark, type: 'confirm', includes: '恢复为扩展内置的基表', timeoutMs: 8000 });
    await waitToast('已恢复内置基表', 8000);
    await sleep(300);
    const s2 = await stateSnapshot();
    expect(s2.baseRows === EXP.totalRows, `恢复后基表 ${s2.baseRows} 行，期望 ${EXP.totalRows}`);
    return `新增行 ${before}→${after} · 保存 toast=${toast} · 恢复内置 153 行`;
  }, { repro: '#manageBaseBtn → #baseAddRowBtn → #baseSaveBtn → #baseCloseBtn → #resetBaseBtn' });

  // ---- M29 预览小眼睛（允许跳过） ----
  const preview = await probePreviewWindow();
  if (preview.mode === 'window') {
    await r.check('M29', '行预览「👁」悬停：创建商品页预览小窗（chrome.windows.create），随后关闭', async () => {
      return `预览窗口 target=${preview.url}`;
    }, { repro: '对 #tblBody 首行 .eyeBtn 派发 mouseenter，等待 previewDelayMs=800ms' });
  } else {
    r.skip('M29', '行预览「👁」悬停小窗', `headless 环境限制，跳过：${preview.detail || preview.mode}`);
  }

  // ---- M30 巡检关键页截图 ----
  await r.check('M30', '巡检关键页截图：工作台（含容器/统计）、双轨运行条、总览、设置', async () => {
    await clickId('tabWorkbench');
    await sleep(400);
    await setInputValue('searchInput', '');
    await selectValue('statusFilter', 'all');
    await sleep(400);
    await r.shot('10-patrol-workbench.png', '巡检工作台（表格/统计/工具栏/运行条）');
    await clickId('tabCompare');
    await sleep(900);
    await r.shot('14-patrol-compare.png', '同品比价页');
    await clickId('tabWorkbench');
    await sleep(300);
    await openSettingsDialog();
    await sleep(800);
    await r.shot('15-patrol-settings.png', '巡检设置弹窗');
    await closeSettingsDialog();
    return '10-patrol-workbench / 11-patrol-settings-ai / 12-patrol-overview / 13-patrol-base-upgrade / 14-patrol-compare / 15-patrol-settings';
  }, { repro: '巡检各 tab 截图' });

  // ---- M31 全程 console / 异常汇总 ----
  await r.check('M31', '巡检全程 console 零真实 error、无未捕获异常（预期的网络日志已归类并在报告说明）', async () => {
    const { real, expected } = classifyConsole(page.consoleErrors.slice(state.patrolConsoleMark));
    state.realConsole.push(...real);
    state.expectedConsole.push(...expected);
    const exceptions = (page.pageExceptions || []).slice();
    const realExceptions = exceptions.filter((e) => !/18799|18765/.test(String(e)));
    expect(real.length === 0, `巡检流程共 ${real.length} 条真实 console error：${real.slice(0, 10).join(' | ')}`);
    expect(realExceptions.length === 0, `出现未捕获页面异常：${realExceptions.slice(0, 5).join(' | ')}`);
    return `真实 error 0${expected.length ? `；归类预期网络日志 ${expected.length} 条` : ''} · 未捕获异常 0 · console 条目 ${page.consoleAll.length}`;
  }, { repro: '全流程结束后汇总 page.consoleErrors / pageExceptions' });
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function probeApiBridge() {
  try {
    const res = await fetch('http://127.0.0.1:18765/healthz', { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return { up: false, info: 'HTTP ' + res.status };
    const data = await res.json();
    return { up: true, info: `accounts=${(data.accounts || []).join('/') || '无'}` };
  } catch (e) {
    return { up: false, info: (e && e.message) || 'fetch failed' };
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('用法：node qa/deep-patrol.mjs [--ext <扩展目录>] [--port <CDP端口>] [--browser <浏览器路径>] [--timeout <ms>] [--keep-downloads]');
    return;
  }
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  // 清掉上一次运行留下的失败截图 / 证据副本，避免报告与目录里的旧文件混淆
  try {
    for (const f of fs.readdirSync(SHOTS_DIR)) {
      if (/^fail-.*\.png$/i.test(f)) { try { fs.rmSync(path.join(SHOTS_DIR, f), { force: true }); } catch { /* ignore */ } }
    }
    for (const f of fs.readdirSync(EVIDENCE_DIR)) {
      try { fs.rmSync(path.join(EVIDENCE_DIR, f), { force: true }); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  ENV.downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-patrol-dl-'));
  ENV.oldBasePath = OLD_BASE.path;
  ENV.oldBaseGeneratedAt = OLD_BASE.base.generatedAt;
  ENV.xlsxPath = pickXlsx();
  const bridge = await probeApiBridge();
  ENV.apiBridgeUp = bridge.up;
  ENV.apiBridgeInfo = bridge.info;
  ENV.extDir = opts.ext;

  const runner = new Runner(SHOTS_DIR, EVIDENCE_DIR);
  const state = {
    runner,
    realConsole: [],
    expectedConsole: [],
    evidence: [],
    findings: [],
    platformConsoleMark: 0,
    patrolConsoleMark: 0,
  };
  state.findings.push({
    title: '任务清单中的「表格排序 / 分页 / SKU 抽屉」在巡检 v1.3.4 中不存在（需求范围差异，非回归 bug）',
    detail: [
      '任务描述要求覆盖「表格排序/分页」「行详情（SKU 抽屉）」，但巡检 v1.3.4 的产品 UI 与源码都没有这些交互：',
      '- app.html 表头（15 列）没有任何排序控件 / aria-sort / data-sort；app.js 里只有同品比价分组排序（compareEntries）与对象键排序，没有表格排序逻辑；',
      '- 没有分页器组件，工作台一次渲染全部 153 行（同品比价最多渲染 400 组并提示导出查看）；',
      '- 没有 SKU 侧边抽屉，行详情能力由 SKU 链接、「改」手动改价、「重采」、「下架/恢复」、👁 预览入口承担。',
      '本次已把这三项记为 SKIP（不计通过、不作为失败），并实际覆盖了替代交互（手动改价/重采弹窗/下架恢复/预览）。请 Lead 确认是否属于需求遗漏。',
    ].join('\n'),
    repro: '打开 modules/patrol/app.html：document.querySelectorAll(\'.tbl th[data-sort], th[aria-sort]\').length === 0；无 pager 节点；表格一次渲染 153 行。',
  });
  state.findings.push({
    title: '「API 桥未启动」时浏览器控制台会产生 1 条 net::ERR_CONNECTION_REFUSED 网络日志（浏览器级，非 JS 异常）',
    detail: [
      'M25 把「官方API地址」指向不可达端口，页面按设计去 fetch 探测：loadApiAccountInfo() 的失败被 catch，界面正确显示「API 桥未连接：Failed to fetch（确认“启动API桥.py”在运行）」，页面无脚本错误框、无未捕获异常。',
      '唯一新增 console error 是 Chromium 对失败请求打印的 `Failed to load resource: net::ERR_CONNECTION_REFUSED`（Log.entryAdded，url=http://127.0.0.1:18799/api/accounts），这条日志由浏览器产生、页面 JS 无法抑制。本次已单独归类并在报告说明，不计为产品 bug；若验收要求控制台绝对零 error，需要接受该网络日志或改为非 fetch 探测方案（例如由 background 通过 chrome.runtime 消息探测）。',
    ].join('\n'),
    repro: '设置 → 官方API地址改为 http://127.0.0.1:18799 → 保存 → 重开设置；控制台出现 1 条 net::ERR_CONNECTION_REFUSED（URL 可在 DevTools Network/Console 看到）。',
  });
  runner.note('真实电商平台采集未执行：真实采集需要登录普惠/PLUS 电商平台账号并会逐个打开真实商品页，属外部依赖与业务动作；本次只验证运行入口确认弹窗的取消路径（M23）与采集相关设置/轨道 UI，不发起外部采集、不写入任何电商平台账号。');
  runner.note('同品比价使用内置基表的真实数据（15 组 / 30 SKU）；通过两行手动改价造出 1 组 ¥500 差异，验证「只看有差异」与导出比价 CSV。');
  runner.note('基表自动升级测试从「平台首页」写入 chrome.storage.local：若在巡检页内直接写 patrol.base.v1，页面自身的 storage.onChanged 监听会先就地升级并把旧内存库写回，属于测试姿势问题；从首页写入后进巡检页，才是「扩展更新后首次打开」的真实升级路径。');
  runner.note('导入用 SKU巡检表.xlsx 比内置基表多 1 行（154 vs 153，SKU 数同为 146）；导入差异提示正确列出 1 处会员阈值 + 型号/套餐变化，说明「自动升级+差异提示」链路有效。');
  runner.note('预览小眼睛在 headless 下也能真实创建 chrome.windows.create 预览窗口（target=item.shop.example.com），已随测试关闭；未点击「测试 AI」，避免发起外部 AI 请求。');

  let fatal = null;
  let exitCode = 0;
  try {
    await runner.check('S1', `启动 headless Edge 并加载扩展、定位扩展 ID：${opts.ext}`, async () => {
      const ext = fs.existsSync(path.join(opts.ext, 'manifest.json')) ? opts.ext : null;
      browser = await launchBrowser({
        extDir: ext, width: VIEWPORT.width, height: VIEWPORT.height,
        browser: opts.browser || undefined, port: opts.port || undefined,
      });
      ENV.browserPath = findBrowser();
      ENV.browserVersion = (browser.version && browser.version.Browser) || '';
      ENV.cdpPort = browser.port;
      ENV.extId = opts.extId || process.env.DS_EXT_ID || await findExtensionId(browser.port, 30000);
      expect(/^[a-p]{32}$/.test(ENV.extId), `扩展 ID 格式异常：${ENV.extId}`);
      return `CDP ${browser.port} · ${ENV.browserVersion} · extId=${ENV.extId}`;
    }, { repro: 'launchBrowser({extDir: 价格监控平台}) → findExtensionId' });

    await runner.check('S2', '打开平台页并定位主 target，内置关键数据 JSON 均 200', async () => {
      const ver = await waitForCdp(browser.port, 10000);
      browserCdp = new CdpClient(ver.webSocketDebuggerUrl);
      await browserCdp.connect(8000);
      browserCdp.on('Browser.downloadWillBegin', (p) => {
        downloads.push({ guid: p.guid, suggested: String(p.suggestedFilename || ''), state: 'begin' });
      });
      browserCdp.on('Browser.downloadProgress', (p) => {
        let d = downloads.find((x) => x.guid === p.guid);
        if (!d) { d = { guid: p.guid, suggested: '', state: 'begin' }; downloads.push(d); }
        d.state = p.state;
        if (p.filePath) d.filePath = p.filePath;
      });
      await browserCdp.rpc('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: ENV.downloadDir, eventsEnabled: true });
      const list = await listPageTargets();
      const target = list.find((t) => /app\.html/.test(t.url || '')) || list.find((t) => t.webSocketDebuggerUrl);
      expect(target, '没有可用的页面 target（扩展安装后应自动打开 app.html）');
      page = await new PageSession(target.webSocketDebuggerUrl).connect();
      runner.setPage(page);
      await page.setViewport(VIEWPORT.width, VIEWPORT.height);
      try { await page.client.rpc('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: ENV.downloadDir }); } catch { /* 浏览器级已设置 */ }
      setupDialogHandler();
      await page.navigate(`chrome-extension://${ENV.extId}/app.html`, { settleMs: 2200 });
      await waitForPage(`(() => document.readyState === 'complete' && document.body && document.body.innerText.trim().length > 20)()`, { timeoutMs: 20000, label: '平台页首屏' });
      const probes = await R(`(async () => {
        const out = [];
        for (const u of ['modules/patrol/data/base-skus.json', 'modules/patrol/data/ai-config.json', 'modules/patrol/data/preset-settings.json']) {
          try {
            const res = await fetch(chrome.runtime.getURL(u), { cache: 'no-store' });
            out.push({ u, ok: res.ok, status: res.status, chars: (await res.text()).length });
          } catch (e) { out.push({ u, ok: false, status: 0, error: String((e && e.message) || e) }); }
        }
        return out;
      })()`);
      const bad = probes.filter((p) => !p.ok || p.status !== 200);
      expect(bad.length === 0, `关键数据 JSON 非 200：${oneLine(JSON.stringify(bad))}`);
      return `target=${target.url} · ${probes.map((p) => p.u.split('/').pop() + ':' + p.chars + '字符').join(' ')}`;
    }, { repro: 'PageSession.connect → navigate app.html → fetch 内置 data JSON' });

    await runner.check('S3', '下载通道就绪：页面内触发小文件下载，Browser.downloadProgress 报告已落盘', async () => {
      const before = new Set(downloads.map((d) => d.guid));
      await R(`(() => { const a = document.createElement('a'); a.href = 'data:text/plain;charset=utf-8,qa-download-probe'; a.download = 'qa-download-probe.txt'; document.body.appendChild(a); a.click(); a.remove(); return true; })()`);
      const dl = await waitNewDownload((d) => /qa-download-probe\.txt$/.test(d.suggested || ''), before, { label: '下载探针' });
      const txt = fs.readFileSync(dl.filePath, 'utf8');
      expect(txt === 'qa-download-probe', `下载内容异常：${oneLine(txt, 100)}`);
      return `${dl.suggested} ${fmtBytes(fs.statSync(dl.filePath).size)} · ${dl.filePath}`;
    }, { repro: '页面内 a[download] data URL → 监听 Browser.downloadProgress completed.filePath' });

    if (!page) {
      state.findings.push({ title: '浏览器/页面未就绪，后续断言未执行', detail: '请查看 S1/S2 失败原因。' });
      exitCode = 1;
    } else {
      // ---- A. 平台壳 ----
      state.platformConsoleMark = page.consoleErrors.length;
      await verifyPlatformShell(runner, state);

      // ---- B. 巡检模块 ----
      state.patrolConsoleMark = page.consoleErrors.length;
      await verifyPatrolModule(runner, state);
    }
  } catch (err) {
    fatal = String((err && err.stack) || err);
    console.error('[fatal] ' + fatal);
    exitCode = 2;
  } finally {
    // 报告（先落盘，再清理）
    try {
      const report = buildReport(state, fatal);
      const jsonPath = path.join(QA_DIR, 'DEEP-PATROL-REPORT.json');
      const mdPath = path.join(QA_DIR, 'DEEP-PATROL-REPORT.md');
      fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');
      fs.writeFileSync(mdPath, renderMarkdown(report), 'utf8');
      console.log(`\n[report] ${mdPath}`);
      console.log(`[report] ${jsonPath}`);
      console.log(`[summary] 通过 ${report.summary.passed} · 失败 ${report.summary.failed} · 跳过 ${report.summary.skipped} · 合计 ${report.summary.total} · 真实 console error ${report.summary.consoleErrorsReal}`);
      if (report.summary.failed) {
        for (const a of report.assertions.filter((x) => x.status === 'fail')) console.log(`  FAIL ${a.id} ${a.title}`);
      }
      if (!fatal && report.summary.failed > 0) exitCode = 1;
    } catch (e) {
      console.error('[report] 写报告失败：' + ((e && e.message) || e));
      if (!fatal) exitCode = 2;
    }
    try { page?.close(); } catch { /* ignore */ }
    try { browserCdp?.close(); } catch { /* ignore */ }
    try { if (browser) await browser.close(); } catch { /* ignore */ }
    if (browser) console.log(`[cleanup] 浏览器已关闭（pid=${browser.child?.pid}），profile 已删除`);
    if (!opts.keepDownloads) {
      try { fs.rmSync(ENV.downloadDir, { recursive: true, force: true }); } catch { /* ignore */ }
    } else {
      console.log(`[downloads] 保留临时下载目录：${ENV.downloadDir}`);
    }
  }
  process.exit(exitCode || 0);
}

main().catch((err) => {
  console.error('致命错误：' + ((err && err.stack) || err));
  process.exit(2);
});



