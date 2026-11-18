/**
 * lib/store-schema.js —— 匹配库数据模型（chrome.storage.local 的 ds.library.v1）
 *
 * 契约来源：DESIGN.md 第 4.1 节 / 第 10 节。
 * 职责：空库、种子导入（extension/data/base-skus.json）、导入合并、脏值归一、
 *       SKU 记录 upsert、冲突/重复/缺项检查、表格行与覆盖率统计。
 * 纯 ES Module；所有「修改库」的函数都是原地修改并返回结果对象（见各函数注释）。
 */

import { normalizeSizeBand, normalizePriceBand, normalizeBrand } from './rules.js';
import { normalizeSku } from './header-map.js';

/** 内置种子：相对扩展根目录（app.html 同目录），UI 用 fetch(SEED_URL) 读取 */
export const SEED_URL = 'data/base-skus.json';

/** 匹配库导出列（与界面表头逐字一致，DESIGN.md 19.2；界面另有「操作」列，不导出） */
export const LIBRARY_EXPORT_HEADERS = ['SKU', '商品名称', '店铺', '品牌', '型号', '套餐', '尺寸段', '价格段', '数据来源', '更新时间'];

/** 记录来源中文名 */
export const ORIGIN_LABELS = { seed: '种子', import: '导入', manual: '人工', confirm: '人工确认' };

/** 归一 origin：非法值按 source 推断 */
function normalizeOrigin(origin, source) {
  const text = String(origin == null ? '' : origin).trim();
  if (text === 'seed' || text === 'import' || text === 'manual' || text === 'confirm') return text;
  const src = String(source == null ? '' : source).trim();
  if (src === '手动') return 'manual';
  if (src === '确认' || src === '人工确认') return 'confirm';
  if (src === '种子' || src === '内置') return 'seed';
  if (src === '导入' || src === '库' || src === '匹配库') return 'import';
  return 'import';
}

/** source 是否为「可信来源」（库/导入/种子 → verified 默认 true） */
function isTrustedSource(source) {
  const src = String(source == null ? '' : source).trim();
  return src === '库' || src === '导入' || src === '种子' || src === '内置';
}

/** 由旧记录推断 verified（缺 verified 字段时：source 为 库/导入 → true，其他 false） */
function inferVerified(record) {
  if (record && typeof record.verified === 'boolean') return record.verified;
  return isTrustedSource(record && record.source);
}

/** 对外：判断记录是否已核验（旧记录缺 verified 时按 source 推断；annotateLibraryStates 用） */
export function isRecordVerified(record) {
  return inferVerified(record);
}

/** 本地时区 ISO 时间串（如 2026-11-02T17:20:00+08:00） */
export function isoNow(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/** 空匹配库 */
export function emptyLibrary() {
  return {
    version: 1,
    stores: {},
    meta: { updatedAt: isoNow(), importedFrom: [] },
  };
}

/* ---------------------- 匹配库操作日志（v2.1.5，DESIGN.md 20.10） ---------------------- */

/** 操作类型中文名（日志面板/导出展示用） */
export const LIBRARY_LOG_ACTIONS = {
  confirm: '确认写入',
  'manual-edit': '人工编辑',
  'import-merge': '导入合并',
  'import-replace': '导入覆盖',
  normalize: '归一化',
  'seed-migrate': '种子迁移',
  'add-store': '新增类目',
  'delete-store': '删除类目',
  'reset-seed': '重置内置库',
  'merge-stores': '合并类目',
  'dedupe-store': '类目去重',
  'clear-logs': '清空日志',
};

/** 日志上限（超出丢最旧） */
export const LIBRARY_LOG_LIMIT = 500;

/** 安全取文本 */
function logText(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

/**
 * 追加一条匹配库操作日志（DESIGN.md 20.10）。
 * entry 支持两种字段变化写法：单条 `{field,before,after}` 或批量 `{changes:[{field,before,after}]}`。
 * @param {object} lib
 * @param {{at?:string, action:string, store?:string, sku?:string, field?:string, before?:*,
 *          after?:*, source?:string, note?:string, changes?:Array<{field:string,before?:*,after?:*}>}} entry
 * @returns {object|null} 追加后的日志记录
 */
export function appendLibraryLog(lib, entry = {}) {
  if (!lib || typeof lib !== 'object') return null;
  const input = entry && typeof entry === 'object' ? entry : {};
  if (!lib.meta || typeof lib.meta !== 'object') lib.meta = { updatedAt: isoNow(), importedFrom: [] };
  if (!Array.isArray(lib.meta.logs)) lib.meta.logs = [];
  const changes = Array.isArray(input.changes)
    ? input.changes
      .filter((change) => change && change.field !== undefined && change.field !== null && logText(change.field))
      .map((change) => ({
        field: logText(change.field),
        before: change.before === null || change.before === undefined ? '' : String(change.before),
        after: change.after === null || change.after === undefined ? '' : String(change.after),
      }))
    : [];
  if (!changes.length && input.field !== undefined && input.field !== null && logText(input.field)) {
    changes.push({
      field: logText(input.field),
      before: input.before === null || input.before === undefined ? '' : String(input.before),
      after: input.after === null || input.after === undefined ? '' : String(input.after),
    });
  }
  const at = logText(input.at) || isoNow();
  const record = {
    at,
    action: logText(input.action) || 'manual-edit',
    store: logText(input.store),
    sku: logText(input.sku),
    field: logText(input.field) || (changes.length === 1 ? changes[0].field : changes.map((change) => change.field).join(',')),
    before: input.before === null || input.before === undefined ? (changes.length === 1 ? changes[0].before : '') : String(input.before),
    after: input.after === null || input.after === undefined ? (changes.length === 1 ? changes[0].after : '') : String(input.after),
    source: logText(input.source),
    note: logText(input.note),
    changes,
  };
  lib.meta.logs.push(record);
  if (lib.meta.logs.length > LIBRARY_LOG_LIMIT) {
    lib.meta.logs.splice(0, lib.meta.logs.length - LIBRARY_LOG_LIMIT);
  }
  lib.meta.updatedAt = isoNow();
  lib.meta.lastLogAt = at;
  return record;
}

/**
 * 清空匹配库操作日志（v2.1.5 补充，供 UI「操作日志 → 清空」按钮）。
 * 清空后写一条 `clear-logs` 审计日志（保留「何时清空了多少条」的痕迹，供其它人追溯）；
 * 原本就没有日志时直接返回 0，不产生噪音日志。
 * @param {object} lib
 * @returns {number} 被清空的日志条数
 */
export function clearLibraryLogs(lib) {
  if (!lib || typeof lib !== 'object') return 0;
  if (!lib.meta || typeof lib.meta !== 'object') lib.meta = { updatedAt: isoNow(), importedFrom: [] };
  const logs = Array.isArray(lib.meta.logs) ? lib.meta.logs : [];
  const cleared = logs.length;
  if (cleared === 0) return 0;
  lib.meta.logs = [];
  appendLibraryLog(lib, {
    action: 'clear-logs',
    source: '日志',
    note: `清空操作日志 ${cleared} 条`,
  });
  return cleared;
}

/**
 * 日志拍平为表格行（时间倒序；一条日志含多处字段变化时展成多行）。
 * @param {object} lib
 * @returns {Array<{at:string, action:string, actionText:string, store:string, sku:string,
 *                  field:string, before:string, after:string, source:string, note:string}>}
 */
export function libraryLogRows(lib) {
  const logs = lib && lib.meta && Array.isArray(lib.meta.logs) ? lib.meta.logs : [];
  const rows = [];
  for (let index = logs.length - 1; index >= 0; index -= 1) {
    const log = logs[index] || {};
    const action = logText(log.action);
    const actionText = LIBRARY_LOG_ACTIONS[action] || action;
    const changes = Array.isArray(log.changes) && log.changes.length
      ? log.changes
      : [{ field: log.field || '', before: log.before || '', after: log.after || '' }];
    for (const change of changes) {
      rows.push({
        at: logText(log.at),
        action,
        actionText,
        store: logText(log.store),
        sku: logText(log.sku),
        field: logText(change.field),
        before: change.before === null || change.before === undefined ? '' : String(change.before),
        after: change.after === null || change.after === undefined ? '' : String(change.after),
        source: logText(log.source),
        note: logText(log.note),
      });
    }
  }
  return rows;
}

/** 由类目名推导关键词（用于绑定榜单时识别文件名 / UI 展示） */
export function deriveKeywords(name) {
  const text = String(name == null ? '' : name).trim();
  if (!text) return [];
  const tokens = text.split(/[\s、,，/|_\-]+/).filter(Boolean);
  const keywords = [];
  const push = (word) => {
    const value = String(word || '').trim();
    if (value && !keywords.includes(value)) keywords.push(value);
  };
  for (const token of tokens) {
    push(token);
    // 「会议电视」→ 补「电视」；「会议平板一体机」→ 补「一体机」
    if (token.length === 4) push(token.slice(-2));
    else if (token.length >= 5) push(token.slice(-3));
  }
  if (!keywords.length) push(text);
  return keywords;
}

/** 统一记录字段：size/price 归一到规范值，sizeRaw/priceRaw 只在原始值非规范时保留 */
function makeRecord(record, storeName, fallbackSource = '库', defaults = {}) {
  const source = record && record.source ? String(record.source) : fallbackSource;
  const rawSize =
    record && record.sizeRaw != null && String(record.sizeRaw).trim() !== ''
      ? String(record.sizeRaw)
      : record && record.size != null
        ? String(record.size)
        : '';
  const rawPrice =
    record && record.priceRaw != null && String(record.priceRaw).trim() !== ''
      ? String(record.priceRaw)
      : record && record.price != null
        ? String(record.price)
        : '';
  const sizeResult = normalizeSizeBand(rawSize);
  const priceResult = normalizePriceBand(rawPrice);
  // v2.1.4 核验字段（DESIGN.md 19.1）：种子/导入默认 verified=true；缺失时按 source 推断
  const origin = defaults.origin || normalizeOrigin(record && record.origin, source);
  const verified = typeof defaults.verified === 'boolean'
    ? defaults.verified
    : inferVerified({ ...record, source });
  const verifiedAt = record && record.verifiedAt
    ? String(record.verifiedAt)
    : verified
      ? String(defaults.verifiedAt || isoNow())
      : '';
  return {
    sku: normalizeSku(record && record.sku),
    name: record && record.name != null ? String(record.name).trim() : '',
    // 品牌统一成规范名（华为（HUAWEI）→ 华为、品牌A（brandA）→ 品牌A）
    brand: normalizeBrand(record && record.brand),
    // v2.1 关键字段（DESIGN.md 16.1）：型号 / 套餐，可选、缺省空串
    model: record && record.model != null ? String(record.model).trim() : '',
    package: record && record.package != null ? String(record.package).trim() : '',
    size: sizeResult.value,
    price: priceResult.value,
    sizeRaw: sizeResult.dirty ? rawSize.trim() : '',
    priceRaw: priceResult.dirty ? rawPrice.trim() : '',
    source,
    verified,
    origin,
    verifiedAt,
    storeName,
    updatedAt: (record && record.updatedAt) || isoNow(),
  };
}

/** 去掉内部辅助字段，得到入库记录 */
function cleanRecord(record) {
  return {
    sku: record.sku,
    name: record.name,
    brand: record.brand,
    model: record.model || '',
    package: record.package || '',
    size: record.size,
    price: record.price,
    sizeRaw: record.sizeRaw,
    priceRaw: record.priceRaw,
    source: record.source,
    verified: !!record.verified,
    origin: record.origin || 'import',
    verifiedAt: record.verifiedAt || '',
    updatedAt: record.updatedAt,
  };
}

/**
 * 从内置种子 JSON（extension/data/base-skus.json）生成匹配库。
 * 不改动 seed；返回全新 library。
 * @param {object} seed
 */
export function seedLibraryFromJson(seed) {
  const payload = seed && typeof seed === 'object' ? seed : {};
  const library = emptyLibrary();
  const seedStores = payload.stores && typeof payload.stores === 'object' ? payload.stores : {};
  const seedUpdatedAt = payload.generatedAt || isoNow();
  for (const [key, store] of Object.entries(seedStores)) {
    if (!store || typeof store !== 'object') continue;
    const name = String(store.name || key || '').trim();
    if (!name) continue;
    const rows = {};
    const seedRows = store.rows && typeof store.rows === 'object' ? store.rows : {};
    for (const [skuKey, record] of Object.entries(seedRows)) {
      if (!record || typeof record !== 'object') continue;
      const sku = normalizeSku(record.sku != null ? record.sku : skuKey);
      if (!sku) continue;
      const normalized = makeRecord({ ...record, sku }, name, '库', {
        origin: 'seed',
        verified: true,
        verifiedAt: seedUpdatedAt,
      });
      normalized.updatedAt = seedUpdatedAt;
      rows[sku] = cleanRecord(normalized);
    }
    library.stores[name] = {
      name,
      keywords: deriveKeywords(name),
      rows,
    };
  }
  library.meta = {
    updatedAt: isoNow(),
    importedFrom: payload.source ? [String(payload.source)] : [SEED_URL],
    // v2.1.4：内置种子版本信息（用于升级迁移比对，DESIGN.md 19.4）
    schemaVersion: payload.schemaVersion ? String(payload.schemaVersion) : '',
    fingerprint: payload.fingerprint ? String(payload.fingerprint) : '',
    generatedAt: payload.generatedAt ? String(payload.generatedAt) : '',
    seedSchema: payload.schema || '',
    seedGeneratedAt: payload.generatedAt || '',
  };
  return library;
}

/** 把外部传入的 stores（数组或对象）统一成 [{name, keywords, rows:Array<record>}] */
function normalizeIncomingStores(stores) {
  const list = [];
  if (!stores) return list;
  if (Array.isArray(stores)) {
    stores.forEach((store, index) => {
      if (!store || typeof store !== 'object') return;
      list.push({
        name: String(store.name || `工作簿${index + 1}`).trim(),
        keywords: Array.isArray(store.keywords) ? store.keywords : null,
        rows: Array.isArray(store.rows) ? store.rows : Object.values(store.rows || {}),
      });
    });
  } else if (typeof stores === 'object') {
    for (const [key, store] of Object.entries(stores)) {
      if (!store || typeof store !== 'object') continue;
      list.push({
        name: String(store.name || key || '').trim(),
        keywords: Array.isArray(store.keywords) ? store.keywords : null,
        rows: Array.isArray(store.rows) ? store.rows : Object.values(store.rows || {}),
      });
    }
  }
  return list.filter((store) => store.name);
}

/**
 * 把导入的匹配库合并进 lib。
 * - mode='merge'（默认）：同名类目逐 SKU 合并，导入记录的非空字段覆盖旧值（Excel 优先），空字段保留旧值；
 * - mode='replace'：清空现有类目后整体替换。
 * 原地修改 lib，返回 { library: lib, stats: {mode, addedStores, addedRows, updatedRows, totalRows} }。
 * @param {object} lib
 * @param {{stores: object|Array, mode?: 'merge'|'replace'}} payload
 */
export function mergeLibrary(lib, payload = {}) {
  if (!lib || typeof lib !== 'object') throw new Error('合并匹配库失败：目标库为空');
  if (!lib.stores || typeof lib.stores !== 'object') lib.stores = {};
  if (!lib.meta || typeof lib.meta !== 'object') lib.meta = { updatedAt: isoNow(), importedFrom: [] };
  const mode = payload.mode === 'replace' ? 'replace' : 'merge';
  const incoming = normalizeIncomingStores(payload.stores);
  const stats = { mode, addedStores: 0, addedRows: 0, updatedRows: 0, totalRows: 0 };

  if (mode === 'replace') lib.stores = {};

  for (const store of incoming) {
    let target = lib.stores[store.name];
    if (!target) {
      target = {
        name: store.name,
        keywords: store.keywords && store.keywords.length ? store.keywords.slice() : deriveKeywords(store.name),
        rows: {},
      };
      lib.stores[store.name] = target;
      stats.addedStores += 1;
    } else if (!Array.isArray(target.keywords) || !target.keywords.length) {
      target.keywords = store.keywords && store.keywords.length ? store.keywords.slice() : deriveKeywords(store.name);
    }
    // 老记录缺省 v2.1/v2.1.4 字段时补默认（向后兼容，不丢字段）
    for (const row of Object.values(target.rows || {})) {
      if (!row) continue;
      if (row.model === undefined) row.model = '';
      if (row.package === undefined) row.package = '';
      if (typeof row.verified !== 'boolean') row.verified = isTrustedSource(row.source);
      if (!row.origin) row.origin = normalizeOrigin('', row.source);
      if (row.verified && !row.verifiedAt) row.verifiedAt = row.updatedAt || isoNow();
    }
    for (const recordInput of store.rows) {
      const record = makeRecord(recordInput || {}, store.name, '库', { origin: 'import', verified: true });
      if (!record.sku) continue;
      const existing = target.rows[record.sku];
      if (!existing) {
        target.rows[record.sku] = cleanRecord(record);
        stats.addedRows += 1;
        continue;
      }
      let changed = false;
      // 老记录缺省 v2.1/v2.1.4 字段时补默认（向后兼容）
      if (existing.model === undefined) existing.model = '';
      if (existing.package === undefined) existing.package = '';
      for (const field of ['name', 'brand', 'model', 'package', 'size', 'price']) {
        if (record[field] && record[field] !== existing[field]) {
          existing[field] = record[field];
          changed = true;
        }
      }
      // 脏值原始值随导入保留（便于追溯），但非空才覆盖
      for (const field of ['sizeRaw', 'priceRaw']) {
        if (record[field] && record[field] !== existing[field]) {
          existing[field] = record[field];
          changed = true;
        }
      }
      if (record.source && record.source !== existing.source) {
        existing.source = record.source;
        changed = true;
      }
      if (changed) {
        // 导入（Excel）记录视为已核验（DESIGN.md 19.1/19.4）
        existing.verified = true;
        existing.origin = 'import';
        existing.verifiedAt = isoNow();
        existing.updatedAt = isoNow();
        stats.updatedRows += 1;
      }
    }
  }

  stats.totalRows = Object.values(lib.stores).reduce((sum, store) => sum + Object.keys(store.rows || {}).length, 0);
  lib.meta.updatedAt = isoNow();
  lib.meta.lastMerge = { ...stats, at: isoNow() };
  // v2.1.5 操作日志（DESIGN.md 20.10）：导入只写 1 条汇总，不逐条爆量
  appendLibraryLog(lib, {
    action: mode === 'replace' ? 'import-replace' : 'import-merge',
    source: '导入',
    note: `导入${mode === 'replace' ? '覆盖' : '合并'}：新增类目 ${stats.addedStores}、新增 SKU ${stats.addedRows}、更新 SKU ${stats.updatedRows}、现有合计 ${stats.totalRows}`,
  });
  return { library: lib, stats };
}

/**
 * 检查匹配库问题（供 UI「冲突与重复检查」）。
 * - duplicates：同一个 SKU 出现在 ≥2 个类目（跨类目重复，值可能一致也可能不一致）；
 * - conflicts：跨类目同 SKU 且值不一致（duplicates 中有差异的子集）；
 * - incomplete/dirty/emptyName：缺字段、历史脏值原始值、空商品名。
 * @param {object} lib
 */
export function findLibraryIssues(lib) {
  const stores = (lib && lib.stores) || {};
  const issues = {
    counts: { stores: 0, skus: 0, incomplete: 0, dirty: 0, conflicts: 0, duplicates: 0, emptyName: 0 },
    duplicates: [],
    conflicts: [],
    incomplete: [],
    dirty: [],
    emptyName: [],
  };
  const skuIndex = new Map(); // sku -> [{store, size, price, name}]
  for (const [storeName, store] of Object.entries(stores)) {
    const rows = store.rows || {};
    issues.counts.stores += 1;
    for (const [sku, record] of Object.entries(rows)) {
      issues.counts.skus += 1;
      const missing = [];
      if (!record.size) missing.push('size');
      if (!record.price) missing.push('price');
      if (missing.length) {
        issues.counts.incomplete += 1;
        issues.incomplete.push({ store: storeName, sku, missing });
      }
      if (record.sizeRaw) {
        issues.counts.dirty += 1;
        issues.dirty.push({ store: storeName, sku, field: 'size', raw: record.sizeRaw, normalized: record.size });
      }
      if (record.priceRaw) {
        issues.counts.dirty += 1;
        issues.dirty.push({ store: storeName, sku, field: 'price', raw: record.priceRaw, normalized: record.price });
      }
      if (!record.name) {
        issues.counts.emptyName += 1;
        issues.emptyName.push({ store: storeName, sku });
      }
      if (!skuIndex.has(sku)) skuIndex.set(sku, []);
      skuIndex.get(sku).push({ store: storeName, sku, name: record.name, size: record.size, price: record.price });
    }
  }
  // 跨类目重复 SKU（同一 SKU 出现在 ≥2 个类目，值可能一致）
  for (const [sku, entries] of skuIndex) {
    if (entries.length < 2) continue;
    issues.duplicates.push({
      sku,
      count: entries.length,
      stores: entries.map((entry) => entry.store),
      entries,
    });
  }
  issues.counts.duplicates = issues.duplicates.length;

  // 跨类目同 SKU 值冲突（都有值且不一致）
  for (const [sku, entries] of skuIndex) {
    if (entries.length < 2) continue;
    const sizeValues = new Set(entries.map((entry) => entry.size).filter(Boolean));
    const priceValues = new Set(entries.map((entry) => entry.price).filter(Boolean));
    const fields = [];
    if (sizeValues.size > 1) fields.push('size');
    if (priceValues.size > 1) fields.push('price');
    if (fields.length) {
      issues.conflicts.push({ sku, fields, entries });
    }
  }
  issues.counts.conflicts = issues.conflicts.length;
  return issues;
}

/**
 * 写入/更新一条 SKU 记录（**仅人工动作调用**：行内编辑 / 点「确认写入匹配库」）；
 * analyzeReport / applyCaptures 绝不调用本函数（DESIGN.md 19.1/20.5/20.11）。
 *
 * v2.1.5 修复（DESIGN.md 20.5）：调用方显式提供规范 `size`/`price`（非空）时，
 * 对应字段**强制覆盖**为归一化后的该值，绝不被传入/旧 sizeRaw、priceRaw 顶掉；
 * 只提供其中一个时，另一个保留旧值。`sizeRaw/priceRaw` 仅作参考字段保存。
 *
 * @param {object} lib
 * @param {string|{name:string}} store 类目名或类目对象
 * @param {object} record {sku,name,brand,model?,package?,size,price,source?,sizeRaw?,priceRaw?}
 * @param {{origin?:'seed'|'import'|'manual'|'confirm', verified?:boolean, verifiedAt?:string,
 *          at?:string, note?:string}} [options]
 *        默认 origin='confirm'、verified=true（只有人工确认动作才写库）
 */
export function upsertMatch(lib, store, record, options = {}) {
  if (!lib || typeof lib !== 'object') throw new Error('写入匹配库失败：目标库为空');
  if (!lib.stores || typeof lib.stores !== 'object') lib.stores = {};
  const storeName = String((store && store.name) || store || '').trim();
  if (!storeName) throw new Error('写入匹配库失败：缺少类目名');
  const opts = options && typeof options === 'object' ? options : {};
  const input = record && typeof record === 'object' ? record : {};
  const origin = ['seed', 'import', 'manual', 'confirm'].includes(opts.origin) ? opts.origin : 'confirm';
  const verified = typeof opts.verified === 'boolean' ? opts.verified : true;
  const verifiedAt = opts.verifiedAt ? String(opts.verifiedAt) : verified ? isoNow() : '';

  // 1) 规范值优先：显式传入的非空 size/price 一律走 normalize 后强制覆盖
  const providedSizeText = logText(input.size);
  const providedPriceText = logText(input.price);
  const providedSize = providedSizeText ? normalizeSizeBand(providedSizeText) : null;
  const providedPrice = providedPriceText ? normalizePriceBand(providedPriceText) : null;
  const rawSizeInput = logText(input.sizeRaw);
  const rawPriceInput = logText(input.priceRaw);
  const normalized = makeRecord(input, storeName, '手动', { origin, verified, verifiedAt });
  if (!normalized.sku) throw new Error('写入匹配库失败：SKU 为空');
  let target = lib.stores[storeName];
  if (!target) {
    target = { name: storeName, keywords: deriveKeywords(storeName), rows: {} };
    lib.stores[storeName] = target;
    appendLibraryLog(lib, {
      action: 'add-store',
      store: storeName,
      source: normalized.source || '手动',
      note: '写入记录时自动新增类目',
    });
  }
  const existing = target.rows[normalized.sku] || {};
  const sizeValue = providedSize ? providedSize.value : normalized.size || existing.size || '';
  const priceValue = providedPrice ? providedPrice.value : normalized.price || existing.price || '';
  // 参考 raw：显式传入优先；提供规范值时保留本次原始值（脏值可追溯），否则清掉旧 raw 避免干扰
  const sizeRawValue = providedSize
    ? rawSizeInput || (providedSize.dirty ? providedSizeText : '')
    : rawSizeInput || existing.sizeRaw || '';
  const priceRawValue = providedPrice
    ? rawPriceInput || (providedPrice.dirty ? providedPriceText : '')
    : rawPriceInput || existing.priceRaw || '';
  const merged = {
    ...cleanRecord(normalized),
    name: normalized.name || existing.name || '',
    brand: normalized.brand || existing.brand || '',
    model: normalized.model || existing.model || '',
    package: normalized.package || existing.package || '',
    size: sizeValue,
    price: priceValue,
    sizeRaw: sizeRawValue,
    priceRaw: priceRawValue,
    source: normalized.source || existing.source || '手动',
    // v2.1.4 核验字段（人工动作写入 → verified=true）
    verified,
    origin,
    verifiedAt: verifiedAt || existing.verifiedAt || '',
    updatedAt: isoNow(),
  };
  target.rows[normalized.sku] = merged;
  if (!lib.meta || typeof lib.meta !== 'object') lib.meta = {};
  lib.meta.updatedAt = isoNow();

  // 2) 操作日志（DESIGN.md 20.10）：字段级 before→after，仅记录发生变化的字段
  const fields = ['name', 'brand', 'model', 'package', 'size', 'price'];
  const changes = [];
  for (const field of fields) {
    const before = existing[field] === null || existing[field] === undefined ? '' : String(existing[field]);
    const after = merged[field] === null || merged[field] === undefined ? '' : String(merged[field]);
    if (before !== after) changes.push({ field, before, after });
  }
  appendLibraryLog(lib, {
    at: opts.at,
    action: origin === 'manual' ? 'manual-edit' : origin === 'import' ? 'import-merge' : 'confirm',
    store: storeName,
    sku: merged.sku,
    source: merged.source || '手动',
    note: logText(opts.note) || (changes.length ? `更新 ${changes.length} 个字段` : '无字段变化'),
    changes,
  });
  return merged;
}

/**
 * 一键归一化库里的脏值（原地修改 lib）。
 * 返回 { library: lib, changed, details: [{store, sku, field, before, after}] }，UI 可用于 before→after 报告。
 * @param {object} lib
 */
export function normalizeLibrary(lib) {
  if (!lib || typeof lib !== 'object' || !lib.stores) return { library: lib, changed: 0, details: [] };
  const details = [];
  for (const [storeName, store] of Object.entries(lib.stores)) {
    for (const [sku, record] of Object.entries((store && store.rows) || {})) {
      if (!record || typeof record !== 'object') continue;
      // v2.1.4 核验字段兼容（缺字段时按 source 推断，不丢字段）
      if (typeof record.verified !== 'boolean') record.verified = isTrustedSource(record.source);
      if (!record.origin) record.origin = normalizeOrigin('', record.source);
      if (record.verified && !record.verifiedAt) record.verifiedAt = record.updatedAt || isoNow();
      const sizeSource = record.sizeRaw || record.size;
      const sizeResult = normalizeSizeBand(sizeSource);
      if (sizeResult.value !== record.size) {
        details.push({ store: storeName, sku, field: 'size', before: record.size, after: sizeResult.value });
        record.size = sizeResult.value;
      }
      if (sizeResult.dirty && !record.sizeRaw) record.sizeRaw = String(sizeSource || '').trim();
      const priceSource = record.priceRaw || record.price;
      const priceResult = normalizePriceBand(priceSource);
      if (priceResult.value !== record.price) {
        details.push({ store: storeName, sku, field: 'price', before: record.price, after: priceResult.value });
        record.price = priceResult.value;
      }
      if (priceResult.dirty && !record.priceRaw) record.priceRaw = String(priceSource || '').trim();
      if (details.length && details[details.length - 1].sku === sku) record.updatedAt = isoNow();
    }
  }
  if (!lib.meta || typeof lib.meta !== 'object') lib.meta = {};
  lib.meta.updatedAt = isoNow();
  lib.meta.lastNormalizedAt = isoNow();
  // v2.1.5 操作日志（DESIGN.md 20.10）：归一化只写 1 条汇总
  appendLibraryLog(lib, {
    action: 'normalize',
    source: '归一化',
    note: `归一化脏值 ${details.length} 处`,
  });
  return { library: lib, changed: details.length, details };
}

/**
 * 匹配库 → 表格行（UI 直接渲染）。
 * v2.1.4：新增 verified/origin/verifiedAt/verifiedText/originText（DESIGN.md 19.1）。
 * @param {object} lib
 * @returns {Array<object>}
 */
export function libraryToRows(lib) {
  const rows = [];
  const stores = (lib && lib.stores) || {};
  for (const [storeName, store] of Object.entries(stores)) {
    for (const [sku, record] of Object.entries((store && store.rows) || {})) {
      const verified = inferVerified(record);
      const origin = normalizeOrigin(record.origin, record.source);
      rows.push({
        store: storeName,
        sku,
        name: record.name || '',
        brand: record.brand || '',
        model: record.model || '',
        package: record.package || '',
        size: record.size || '',
        price: record.price || '',
        sizeRaw: record.sizeRaw || '',
        priceRaw: record.priceRaw || '',
        source: record.source || '',
        verified,
        origin,
        originText: ORIGIN_LABELS[origin] || '',
        verifiedText: verified ? '已确认' : '待确认',
        verifiedAt: record.verifiedAt || '',
        updatedAt: record.updatedAt || '',
        // 脏值标记：原始录入值非规范（保留在 sizeRaw/priceRaw 里）
        sizeDirty: !!record.sizeRaw,
        priceDirty: !!record.priceRaw,
        complete: !!(record.size && record.price),
      });
    }
  }
  return rows;
}

/**
 * 匹配库导出数据（10 列，表头与界面逐字一致，DESIGN.md 19.2）。
 * @param {object} lib
 * @returns {{headers:string[], rows:Array<Array<string|number|null>>}}
 */
export function libraryExportRows(lib) {
  const headers = LIBRARY_EXPORT_HEADERS.slice();
  const rows = libraryToRows(lib).map((row) => [
    row.sku,
    row.name,
    row.store,
    row.brand,
    row.model,
    row.package,
    row.size,
    row.price,
    `${row.verifiedText}（${row.originText || '未知'}）`,
    row.updatedAt,
  ]);
  return { headers, rows };
}

/** 统计库内记录数 */
function countLibraryRows(library) {
  return Object.values((library && library.stores) || {}).reduce(
    (sum, store) => sum + Object.keys((store && store.rows) || {}).length,
    0,
  );
}

/**
 * 内置匹配库升级（v2.1.5，DESIGN.md 20.11）：**默认绝不覆盖用户现有库**。
 * - mode='merge-missing'（默认）：只补充种子里有、库中没有的 SKU；已有记录（含尺寸段/价格段/人工编辑）原样保留；
 * - mode='replace'：仅用户显式「重置为内置新版」时使用，整体替换为种子（丢弃现有记录）。
 * 不改种子 JSON / 种子 fingerprint；合并成功后只更新 library.meta 的版本标记与操作日志。
 * @param {object} library
 * @param {object} seed 内置种子 JSON
 * @param {{mode?:'merge-missing'|'replace', note?:string}} [options]
 * @returns {{migrated:boolean, seedRows:number, added:number, kept:number, keptManual:number}}
 */
export function applySeedMigration(library, seed, options = {}) {
  if (!library || typeof library !== 'object') throw new Error('内置匹配库迁移失败：目标库为空');
  const payload = seed && typeof seed === 'object' ? seed : {};
  const fingerprint = String(payload.fingerprint || '').trim();
  const opts = options && typeof options === 'object' ? options : {};
  const mode = opts.mode === 'replace' ? 'replace' : 'merge-missing';
  if (!library.stores || typeof library.stores !== 'object') library.stores = {};
  if (!library.meta || typeof library.meta !== 'object') library.meta = { updatedAt: isoNow(), importedFrom: [] };
  const currentFingerprint = String(library.meta.fingerprint || '').trim();
  const fresh = seedLibraryFromJson(payload);
  const seedRows = countLibraryRows(fresh);
  const beforeRows = countLibraryRows(library);
  // 现有的人工核验记录数（供 UI 提示「已保留 N 条人工记录」）
  let keptManual = 0;
  for (const store of Object.values(library.stores)) {
    for (const record of Object.values((store && store.rows) || {})) {
      if (!record || typeof record !== 'object') continue;
      const origin = normalizeOrigin(record.origin, record.source);
      if (origin === 'manual' || origin === 'confirm') keptManual += 1;
    }
  }

  if (mode === 'merge-missing') {
    let added = 0;
    for (const [storeName, seedStore] of Object.entries(fresh.stores)) {
      let target = library.stores[storeName];
      if (!target || typeof target !== 'object') {
        target = { name: storeName, keywords: deriveKeywords(storeName), rows: {} };
        library.stores[storeName] = target;
        appendLibraryLog(library, { action: 'add-store', store: storeName, source: '种子', note: '种子迁移新增缺失类目' });
      }
      if (!target.rows || typeof target.rows !== 'object') target.rows = {};
      for (const [sku, record] of Object.entries(seedStore.rows || {})) {
        if (target.rows[sku]) continue; // 已有记录绝不覆盖
        target.rows[sku] = { ...record };
        added += 1;
      }
    }
    // 幂等快速路径：指纹一致且没有可补的 SKU → 不改元数据、不写日志（避免每次启动都产生噪音）
    if (added === 0 && currentFingerprint === fingerprint) {
      return { migrated: false, seedRows, added: 0, kept: beforeRows, keptManual };
    }
    library.meta.updatedAt = isoNow();
    library.meta.fingerprint = fingerprint;
    library.meta.schemaVersion = fresh.meta.schemaVersion;
    library.meta.generatedAt = fresh.meta.generatedAt;
    library.meta.lastSeedMigrationAt = isoNow();
    library.meta.lastSeedMigrationMode = mode;
    appendLibraryLog(library, {
      action: 'seed-migrate',
      source: '种子',
      note: opts.note || `合并缺失 SKU ${added} 条（已有 ${beforeRows} 条保持不变，mode=merge-missing）`,
    });
    return {
      migrated: added > 0 || currentFingerprint !== fingerprint,
      seedRows,
      added,
      kept: beforeRows,
      keptManual,
    };
  }

  // 显式重置：整体替换为内置种子（仅在用户点「重置为内置新版」时使用）
  library.version = fresh.version;
  library.stores = fresh.stores;
  library.meta = {
    ...fresh.meta,
    migratedFrom: currentFingerprint,
    lastSeedMigrationAt: isoNow(),
    lastSeedMigrationMode: 'replace',
  };
  appendLibraryLog(library, {
    action: 'reset-seed',
    source: '种子',
    note: opts.note || `用户显式重置为内置种子 ${seedRows} 条（原库 ${beforeRows} 条已替换）`,
  });
  return { migrated: true, seedRows, added: seedRows, kept: 0, keptManual: 0 };
}

/* ---------------------- 类目合并 / 去重（v2.1.5，DESIGN.md 20.13） ---------------------- */

/** 合并去重用的 SKU key（忽略大小写/前后空格；前导零由 normalizeSku 保留） */
function dedupeSkuKey(value) {
  return normalizeSku(value).toLowerCase();
}

/** 记录合并优先级：verified 高 → updatedAt 新 → 字段完整度高 */
function mergePriority(record) {
  const fields = ['size', 'price', 'brand', 'model', 'package'];
  return {
    verified: inferVerified(record) ? 1 : 0,
    updatedAt: Date.parse(logText(record && record.updatedAt)) || 0,
    completeness: fields.reduce((sum, field) => sum + (logText(record && record[field]) ? 1 : 0), 0),
  };
}

/** 优先级比较：verified 降序 → updatedAt 降序 → 完整度降序 */
function compareMergePriority(a, b) {
  const pa = mergePriority(a.record);
  const pb = mergePriority(b.record);
  if (pa.verified !== pb.verified) return pb.verified - pa.verified;
  if (pa.updatedAt !== pb.updatedAt) return pb.updatedAt - pa.updatedAt;
  if (pa.completeness !== pb.completeness) return pb.completeness - pa.completeness;
  return 0;
}

/** 合并字段顺序 */
const MERGE_FIELDS = ['name', 'brand', 'model', 'package', 'size', 'price'];

/** 取记录的规范字段值（size/price 强制归一） */
function canonicalFieldValue(record, field) {
  if (field === 'size') {
    const raw = logText(record && record.size) || logText(record && record.sizeRaw);
    return raw ? normalizeSizeBand(raw).value : '';
  }
  if (field === 'price') {
    const raw = logText(record && record.price) || logText(record && record.priceRaw);
    return raw ? normalizePriceBand(raw).value : '';
  }
  return logText(record && record[field]);
}

/**
 * 合并一组同 SKU 记录（按优先级取非空字段，记录字段冲突）。
 * @param {Array<{store:string, sku:string, record:object}>} entries
 * @returns {{record:object, conflicts:Array<object>}}
 */
function mergeRecordGroup(entries) {
  const sorted = entries.slice().sort(compareMergePriority);
  const chosen = sorted[0];
  const conflicts = [];
  const merged = {
    sku: chosen.sku,
    name: '',
    brand: '',
    model: '',
    package: '',
    size: '',
    price: '',
    sizeRaw: logText(chosen.record.sizeRaw),
    priceRaw: logText(chosen.record.priceRaw),
    source: logText(chosen.record.source) || '合并',
    verified: inferVerified(chosen.record),
    origin: normalizeOrigin(chosen.record.origin, chosen.record.source),
    verifiedAt: chosen.record.verifiedAt || (inferVerified(chosen.record) ? isoNow() : ''),
    updatedAt: isoNow(),
  };
  for (const field of MERGE_FIELDS) {
    // 采用优先级最高的「非空」值；其余不同值记为冲突（旧值→新值）
    const adopted = sorted.find((entry) => canonicalFieldValue(entry.record, field)) || null;
    const winner = adopted ? canonicalFieldValue(adopted.record, field) : '';
    merged[field] = winner;
    if (!winner) continue;
    for (const entry of sorted) {
      if (entry === adopted) continue;
      const value = canonicalFieldValue(entry.record, field);
      if (!value || value === winner) continue;
      conflicts.push({
        sku: chosen.sku,
        field,
        before: value,
        after: winner,
        chosenStore: adopted.store,
        rejectedStore: entry.store,
      });
    }
  }
  return { record: merged, conflicts };
}

/** 按 normalizeSku（忽略大小写）把多个类目的记录分组 */
function groupStoreRecords(lib, storeNames) {
  const groups = new Map();
  let rowsBefore = 0;
  for (const storeName of storeNames) {
    const store = lib.stores[storeName];
    if (!store || typeof store !== 'object') continue;
    for (const [skuKey, record] of Object.entries(store.rows || {})) {
      if (!record || typeof record !== 'object') continue;
      rowsBefore += 1;
      const displaySku = normalizeSku(record.sku != null ? record.sku : skuKey) || logText(skuKey);
      const key = dedupeSkuKey(displaySku) || displaySku;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ store: storeName, sku: displaySku, record });
    }
  }
  return { groups, rowsBefore };
}

/**
 * 合并多个匹配库类目并去重（DESIGN.md 20.13）。
 * 规则：按 normalizeSku 去重（忽略大小写/空格）；同 SKU 多条按 verified→updatedAt→完整度取优先级；
 * 字段级取优先级最高的非空值（size/price 规范值），值不同记 conflicts；保留 verified/origin/verifiedAt；
 * 合并后删除源类目、记录归入目标类目（目标不存在则创建）。
 * dryRun=true 只返回预览不改库、不写日志。
 * @param {object} lib
 * @param {{sources:Array<string>, target:{name:string, create?:boolean}|string, dryRun?:boolean}} options
 * @returns {{ok:boolean, error?:string, dryRun:boolean, preview?:object, library:object}}
 */
export function mergeStores(lib, options = {}) {
  if (!lib || typeof lib !== 'object' || !lib.stores || typeof lib.stores !== 'object') {
    return { ok: false, error: '合并类目失败：匹配库为空', dryRun: true, library: lib };
  }
  const opts = options && typeof options === 'object' ? options : {};
  const targetInput = opts.target;
  const targetName = logText((targetInput && typeof targetInput === 'object' ? targetInput.name : targetInput));
  const createAllowed = !(targetInput && typeof targetInput === 'object' && targetInput.create === false);
  const rawSources = Array.isArray(opts.sources) ? opts.sources : [];
  const sources = [...new Set(rawSources.map((item) => logText(item && typeof item === 'object' ? item.name : item)).filter(Boolean))];
  if (!targetName) return { ok: false, error: '合并类目失败：缺少目标类目名', dryRun: true, library: lib };
  if (!sources.length) return { ok: false, error: '合并类目失败：请至少选择一个源类目', dryRun: true, library: lib };
  const missing = sources.filter((name) => !lib.stores[name]);
  if (missing.length) return { ok: false, error: `合并类目失败：源类目不存在（${missing.join('、')}）`, dryRun: true, library: lib };
  const targetExists = Boolean(lib.stores[targetName]);
  if (!targetExists && !createAllowed) {
    return { ok: false, error: `合并类目失败：目标类目「${targetName}」不存在`, dryRun: true, library: lib };
  }
  const participating = [...new Set([...sources, ...(targetExists ? [targetName] : [])])];
  const { groups, rowsBefore } = groupStoreRecords(lib, participating);
  const uniqueAfter = groups.size;
  const duplicates = rowsBefore - uniqueAfter;
  const conflicts = [];
  const mergedRows = {};
  for (const [key, entries] of groups) {
    const merged = mergeRecordGroup(entries);
    mergedRows[key] = merged.record;
    conflicts.push(...merged.conflicts);
  }
  const preview = {
    sources,
    target: targetName,
    rowsBefore,
    uniqueAfter,
    duplicates,
    conflictCount: conflicts.length,
    conflicts: conflicts.slice(0, 50),
    mergedStores: sources.length,
  };
  const dryRun = Boolean(opts.dryRun);
  if (dryRun) return { ok: true, dryRun: true, preview, library: lib };

  const backupAt = isoNow();
  for (const name of participating) delete lib.stores[name];
  lib.stores[targetName] = {
    name: targetName,
    keywords: deriveKeywords(targetName),
    rows: mergedRows,
  };
  if (!lib.meta || typeof lib.meta !== 'object') lib.meta = { updatedAt: isoNow(), importedFrom: [] };
  lib.meta.updatedAt = isoNow();
  // UI 负责按此时间戳把当前库序列化为 libraryBackup_v215 快照；lib 不内嵌大快照
  lib.meta.lastMergeBackupAt = backupAt;
  lib.meta.lastMergeStores = {
    at: isoNow(),
    sources,
    target: targetName,
    rowsBefore,
    uniqueAfter,
    duplicates,
    conflictCount: conflicts.length,
  };
  appendLibraryLog(lib, {
    action: 'merge-stores',
    store: targetName,
    source: '合并',
    note: `合并类目 ${sources.join('、')} → ${targetName}：合并前 ${rowsBefore} 条，去重后 ${uniqueAfter} 条，重复 ${duplicates} 条，字段冲突 ${conflicts.length} 条`,
  });
  return { ok: true, dryRun: false, preview, library: lib };
}

/**
 * 单个类目内部按 normalizeSku 去重（DESIGN.md 20.13）。
 * @param {object} lib
 * @param {string|{name:string}} storeName
 * @param {{dryRun?:boolean}} [options]
 * @returns {{ok:boolean, error?:string, dryRun:boolean, removed:number, conflicts:Array<object>,
 *            preview?:object, library:object}}
 */
export function dedupeStore(lib, storeName, options = {}) {
  if (!lib || typeof lib !== 'object' || !lib.stores || typeof lib.stores !== 'object') {
    return { ok: false, error: '类目去重失败：匹配库为空', dryRun: true, removed: 0, conflicts: [], library: lib };
  }
  const name = logText(storeName && typeof storeName === 'object' ? storeName.name : storeName);
  const store = lib.stores[name];
  if (!name || !store || typeof store !== 'object') {
    return { ok: false, error: `类目去重失败：类目「${name || '（空）'}」不存在`, dryRun: true, removed: 0, conflicts: [], library: lib };
  }
  const opts = options && typeof options === 'object' ? options : {};
  const { groups, rowsBefore } = groupStoreRecords(lib, [name]);
  const uniqueAfter = groups.size;
  const conflicts = [];
  const rows = {};
  for (const [key, entries] of groups) {
    const merged = mergeRecordGroup(entries);
    rows[key] = merged.record;
    conflicts.push(...merged.conflicts);
  }
  const removed = rowsBefore - uniqueAfter;
  const preview = {
    store: name,
    rowsBefore,
    uniqueAfter,
    duplicates: removed,
    removed,
    conflictCount: conflicts.length,
    conflicts: conflicts.slice(0, 50),
  };
  const dryRun = Boolean(opts.dryRun);
  if (dryRun) {
    return { ok: true, dryRun: true, removed, conflicts: conflicts.slice(0, 50), preview, library: lib };
  }
  store.rows = rows;
  if (!Array.isArray(store.keywords) || !store.keywords.length) store.keywords = deriveKeywords(name);
  if (!lib.meta || typeof lib.meta !== 'object') lib.meta = { updatedAt: isoNow(), importedFrom: [] };
  lib.meta.updatedAt = isoNow();
  lib.meta.lastDedupeStore = {
    at: isoNow(),
    store: name,
    rowsBefore,
    uniqueAfter,
    duplicates: removed,
    conflictCount: conflicts.length,
  };
  appendLibraryLog(lib, {
    action: 'dedupe-store',
    store: name,
    source: '去重',
    note: `类目去重：去重前 ${rowsBefore} 条，去重后 ${uniqueAfter} 条，重复 ${removed} 条，字段冲突 ${conflicts.length} 条`,
  });
  return { ok: true, dryRun: false, removed, conflicts: conflicts.slice(0, 50), preview, library: lib };
}

/**
 * 匹配库覆盖率统计。
 * @param {object} lib
 */
export function statsOfLibrary(lib) {
  const stores = (lib && lib.stores) || {};
  const summary = {
    stores: 0,
    skus: 0,
    sizeFilled: 0,
    priceFilled: 0,
    complete: 0,
    dirty: 0,
    duplicates: 0,
  };
  const storeStats = [];
  for (const [storeName, store] of Object.entries(stores)) {
    const rows = (store && store.rows) || {};
    const skus = Object.keys(rows);
    let sizeFilled = 0;
    let priceFilled = 0;
    let complete = 0;
    let dirty = 0;
    for (const sku of skus) {
      const record = rows[sku] || {};
      if (record.size) sizeFilled += 1;
      if (record.price) priceFilled += 1;
      if (record.size && record.price) complete += 1;
      if (record.sizeRaw || record.priceRaw) dirty += 1;
    }
    const total = skus.length;
    const statistics = {
      name: storeName,
      skus: total,
      sizeFilled,
      priceFilled,
      complete,
      dirty,
      duplicates: 0,
      sizeCoverage: total ? Number((sizeFilled / total).toFixed(4)) : 0,
      priceCoverage: total ? Number((priceFilled / total).toFixed(4)) : 0,
      completeCoverage: total ? Number((complete / total).toFixed(4)) : 0,
    };
    storeStats.push(statistics);
    summary.stores += 1;
    summary.skus += total;
    summary.sizeFilled += sizeFilled;
    summary.priceFilled += priceFilled;
    summary.complete += complete;
    summary.dirty += dirty;
  }
  const total = summary.skus;
  return {
    total: {
      ...summary,
      sizeCoverage: total ? Number((summary.sizeFilled / total).toFixed(4)) : 0,
      priceCoverage: total ? Number((summary.priceFilled / total).toFixed(4)) : 0,
      completeCoverage: total ? Number((summary.complete / total).toFixed(4)) : 0,
      updatedAt: lib && lib.meta ? lib.meta.updatedAt : '',
    },
    stores: storeStats,
  };
}
