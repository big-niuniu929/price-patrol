/**
 * lib/pipeline.js —— 补数流水线 + 统计 + 导出数据组装
 *
 * 契约来源：DESIGN.md 第 7 节（补数优先级）、第 9 节（统计与导出）、第 10 节（函数签名）。
 * 设计原则：
 *   - analyzeReport 只做「离线补数」（库 → 同名推断 → 商品名解析尺寸），不碰网络；
 *   - applyCaptures 只消费采集结果（captures），可单独调用、可重复调用（幂等：已有值不覆盖）；
 *   - computeStats / build*Workbook 都是纯组装，不读写存储；UI 负责 chrome.storage 与下载。
 * 所有导出单位：成交金额=万元；SKU=字符串；份额=0~1 小数（另有 sharePercent=0~100）。
 */

import {
  SIZE_BANDS,
  PRICE_BANDS,
  STATUS,
  normalizeSizeBand,
  normalizePriceBand,
  priceBandOf,
  bandMidpoint,
  sizeBandOf,
  parseSizeFromNameStrict,
  computeRowStatus,
  resolveBrandDetailed,
  extractModel,
  chooseSampleValue,
  evaluatePriceReview,
} from './rules.js';
import { normalizeSku } from './header-map.js';
import { isoNow, isRecordVerified } from './store-schema.js';

/** 默认设置（DESIGN.md 4.4 + v2.1 16.6；调用方传半截 settings 也能工作） */
export const DEFAULT_SETTINGS = {
  version: 1,
  capture: {
    batchSize: 0,
    delayMin: 3,
    delayMax: 6,
    retries: 1,
    skipCapturedToday: true,
    keepTab: false,
    // v2.1 多采样（DESIGN.md 16.4）
    mode: 'smart',
    maxSamples: 3,
    tolerancePct: 0.01,
    toleranceAbs: 30,
  },
  price: {
    prefer: ['hand', 'main', 'plus'],
    bandBoundary: 'rightOpen',
    minPlausible: 30,
    // v2.1：距价格段边界多近算「接近边界」（DESIGN.md 16.4）
    boundaryMarginPct: 0.01,
  },
  mapping: { overrides: {} },
  ui: { lastPage: 'workbench', bannerDismissed: false, theme: 'auto' },
};

/** 合并设置（只做一层深合并，够用且不引入依赖） */
export function resolveSettings(settings) {
  const input = settings && typeof settings === 'object' ? settings : {};
  return {
    ...DEFAULT_SETTINGS,
    ...input,
    capture: { ...DEFAULT_SETTINGS.capture, ...(input.capture || {}) },
    price: { ...DEFAULT_SETTINGS.price, ...(input.price || {}) },
    mapping: { ...DEFAULT_SETTINGS.mapping, ...(input.mapping || {}) },
    ui: { ...DEFAULT_SETTINGS.ui, ...(input.ui || {}) },
  };
}

/** 金额/份额按 2 位小数收敛 */
function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

/** 数字占比（0~1 精确小数，不四舍五入；展示用 sharePercent） */
function shareOf(part, total) {
  if (!total || !Number.isFinite(total) || total <= 0) return 0;
  return part / total;
}

/** 取文本里的第一个数字（动态尺寸段「其他尺寸(163英寸)」排序用），没有则排最后 */
function firstNumberIn(text) {
  const match = String(text == null ? '' : text).match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : Number.POSITIVE_INFINITY;
}

/** 取文本并 trim */
function textOf(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

/** 品牌归一：空 → 未标注品牌（DESIGN.md 5.3 兜底文案） */
function brandOf(brand) {
  const text = textOf(brand);
  return text || '未标注品牌';
}

/** 从匹配库记录里取规范尺寸段（容错：导入库可能残留脏值） */
function librarySize(record) {
  if (!record || !record.size) return '';
  return normalizeSizeBand(record.size).value || '';
}

/** 从匹配库记录里取规范价格段 */
function libraryPrice(record) {
  if (!record || !record.price) return '';
  return normalizePriceBand(record.price).value || '';
}

/**
 * 建立匹配库索引（绑定类目优先，其次其它类目），供 analyzeReport 使用。
 * @param {object} library
 * @param {string} boundStore
 */
function buildLibraryIndexes(library, boundStore) {
  const stores = (library && library.stores) || {};
  const storeNames = Object.keys(stores);
  const boundRows = (boundStore && stores[boundStore] && stores[boundStore].rows) || {};
  const orderedStoreNames = [
    ...(boundStore && stores[boundStore] ? [boundStore] : []),
    ...storeNames.filter((name) => name !== boundStore),
  ];
  const skuIndex = new Map(); // sku -> [{store, record}]
  for (const storeName of orderedStoreNames) {
    const rows = (stores[storeName] && stores[storeName].rows) || {};
    for (const [sku, record] of Object.entries(rows)) {
      if (!skuIndex.has(sku)) skuIndex.set(sku, []);
      skuIndex.get(sku).push({ store: storeName, record });
    }
  }
  return { stores, boundRows, skuIndex };
}

/** 近似分位数（排序后线性插值）；价位区间用 */
function percentile(sortedValues, ratio) {
  if (!sortedValues.length) return null;
  if (sortedValues.length === 1) return sortedValues[0];
  const index = (sortedValues.length - 1) * ratio;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sortedValues[lower];
  const weight = index - lower;
  return round2(sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight);
}

/** 从匹配库记录里取「价格代表值」= 价格段中值（元） */
function libraryPriceMidpoint(record) {
  const band = libraryPrice(record);
  if (!band) return null;
  return bandMidpoint(band);
}

/** 收集某个类目（可选尺寸段过滤）的库价格代表值 */
function collectRecordPrices(store, sizeBand) {
  const prices = [];
  const rows = (store && store.rows) || {};
  for (const record of Object.values(rows)) {
    if (sizeBand) {
      const recordSize = librarySize(record);
      if (recordSize !== sizeBand) continue;
    }
    const midpoint = libraryPriceMidpoint(record);
    if (midpoint != null) prices.push(midpoint);
  }
  prices.sort((a, b) => a - b);
  return prices;
}

/** 组装参考区间返回结构（p10/p90 原值 + 已展开的 [p10×0.3, p90×3]） */
function makeReferenceRange(prices, count, storeName, sizeBand) {
  const low = percentile(prices, 0.1);
  const high = percentile(prices, 0.9);
  if (low == null || high == null) return null;
  return {
    low: round2(low),
    high: round2(high),
    count,
    // 供 rules.shouldResample / evaluatePriceReview 直接使用
    expandedLow: round2(Math.max(0, low * 0.3)),
    expandedHigh: round2(Math.max(0, high * 3)),
    store: storeName || '',
    sizeBand: sizeBand || '',
  };
}

/**
 * v2.1：构造「同类参考价格区间」（DESIGN.md 16.4）。
 * 同店铺 + 同尺寸段的匹配库样本 ≥5 → [p10, p90]；不足则退化为同店铺（不限尺寸段）；
 * 仍不足或没有库数据 → null。返回对象可直接传给 rules.evaluatePriceReview / shouldResample。
 * @param {object} library
 * @param {string} storeName 类目/店铺名（空则用全库）
 * @param {string} [sizeBand] 尺寸段规范值
 * @returns {{low:number, high:number, count:number, expandedLow:number, expandedHigh:number,
 *            store:string, sizeBand:string}|null}
 */
export function buildReferencePriceRange(library, storeName, sizeBand) {
  const stores = (library && library.stores) || {};
  const storeNames = Object.keys(stores);
  if (!storeNames.length) return null;
  const name = textOf(storeName);
  const size = textOf(sizeBand);
  // 指定了类目必须存在，否则不给参考（避免拿别的类目数据误报 OUT_OF_REFERENCE）
  if (name && !stores[name]) return null;
  const storeList = name ? [name] : storeNames;
  // 1) 同店铺 + 同尺寸段
  if (size) {
    let prices = [];
    for (const target of storeList) prices = prices.concat(collectRecordPrices(stores[target], size));
    prices.sort((a, b) => a - b);
    if (prices.length >= 5) return makeReferenceRange(prices, prices.length, name, size);
  }
  // 2) 退化为同店铺（不限尺寸段）
  let fallback = [];
  for (const target of storeList) fallback = fallback.concat(collectRecordPrices(stores[target], ''));
  fallback.sort((a, b) => a - b);
  if (fallback.length >= 5) return makeReferenceRange(fallback, fallback.length, name, '');
  return null;
}

/** 空复核对象（行模型统一结构，UI 少做空判断） */
function emptyReview() {
  return { needed: false, reasons: [], confirmed: false, confirmedAt: '' };
}

/** 复核状态转中文（回填「复核状态」列 / 行内展示） */
export function formatReviewText(review) {
  if (!review || typeof review !== 'object') return '';
  if (review.confirmed) {
    return `✓ 已人工确认（${textOf(review.confirmedAt) || '时间未记录'}）`;
  }
  if (!review.needed || !Array.isArray(review.reasons) || !review.reasons.length) return '';
  return `需确认：${review.reasons.map((reason) => textOf(reason && reason.text)).filter(Boolean).join('；')}`;
}

/** 汇总一批行的统计（analyzeReport / applyCaptures 共用） */
export function summarizeRows(rows) {
  const summary = {
    total: rows.length,
    complete: 0,
    sizeFilled: 0,
    priceFilled: 0,
    sizeOther: 0,
    sizeCoverage: 0,
    priceCoverage: 0,
    amountTotal: 0,
    amountAnomaly: 0,
    libraryHits: 0,
    nameInferred: 0,
    nameParsed: 0,
    captureFilled: 0,
    brandFilled: 0,
    brandInferred: 0,
    modelFilled: 0,
    packageFilled: 0,
    reviewNeeded: 0,
    sampled2: 0,
    avgSampleSpread: 0,
    pendingPrice: 0,
    pendingSize: 0,
    failed: 0,
    // v2.1.7：已下架行不计入采集进度分母
    offSale: 0,
    progressDenom: 0,
    progressPct: 0,
    byStatus: {
      [STATUS.MATCHED]: 0,
      [STATUS.CAPTURED]: 0,
      [STATUS.PARTIAL]: 0,
      [STATUS.PENDING_CAPTURE]: 0,
      [STATUS.PENDING_MANUAL]: 0,
      [STATUS.CAPTURE_FAILED]: 0,
      [STATUS.REVIEW_NEEDED]: 0,
    },
    bySource: {
      // v2.1.6：不再存在「名称推断」来源（价格/尺寸只来自库/名称严格解析/页面采集/手动）
      size: Object.fromEntries(['库', '名称解析', '页面采集', '手动'].map((key) => [key, 0])),
      price: Object.fromEntries(['库', '页面采集', '手动'].map((key) => [key, 0])),
      brand: Object.fromEntries(['列', '库', '名称', '店铺'].map((key) => [key, 0])),
      model: Object.fromEntries(['列', '名称', '库', '页面采集'].map((key) => [key, 0])),
      package: Object.fromEntries(['列', '名称', '库', '页面采集'].map((key) => [key, 0])),
    },
    byBrandSource: Object.fromEntries(['列', '库', '名称', '店铺', ''].map((key) => [key, 0])),
  };
  let sampledSpreadSum = 0;
  let countedComplete = 0;
  for (const row of rows) {
    const size = row.size || '';
    const price = row.price || '';
    const sources = row.source || { size: '', price: '', brand: '', model: '', package: '' };
    // v2.1.7：下架行不计入进度分母
    const isOffSale = row.offSale === true;
    if (isOffSale) summary.offSale += 1;
    else {
      summary.progressDenom += 1;
      if (size && price) countedComplete += 1;
    }
    if (size && price) summary.complete += 1;
    if (size) {
      summary.sizeFilled += 1;
      if (size === '其他') summary.sizeOther += 1;
    }
    if (price) summary.priceFilled += 1;
    if (typeof row.amount === 'number' && Number.isFinite(row.amount)) summary.amountTotal += row.amount;
    else if (row.amountRaw) summary.amountAnomaly += 1;
    if (row.brand) summary.brandFilled += 1;
    if (row.model) summary.modelFilled += 1;
    if (row.package) summary.packageFilled += 1;
    if (row.review && row.review.needed && !row.review.confirmed) summary.reviewNeeded += 1;
    const sampleCount = Number(row.sampleCount) || 0;
    if (sampleCount >= 2) {
      summary.sampled2 += 1;
      sampledSpreadSum += Number(row.sampleSpread) || 0;
    }
    if (sources.brand === '库' || sources.brand === '名称' || sources.brand === '店铺') summary.brandInferred += 1;
    if (summary.byBrandSource[sources.brand] !== undefined) summary.byBrandSource[sources.brand] += 1;
    if (sources.brand && summary.bySource.brand[sources.brand] !== undefined) summary.bySource.brand[sources.brand] += 1;
    for (const field of ['size', 'price', 'model', 'package']) {
      const value = sources[field];
      // v2.1.7：页面采集来源细化后仍归入「页面采集」统计口径
      const sourceKey = typeof value === 'string' && value.startsWith('页面采集') ? '页面采集' : value;
      if (sourceKey && summary.bySource[field] && summary.bySource[field][sourceKey] !== undefined) {
        summary.bySource[field][sourceKey] += 1;
      }
    }
    if (sources.size === '库' || sources.price === '库') summary.libraryHits += 1;
    // v2.1.6：nameInferred 口径保留但恒为 0（同名推断已删除，价格/尺寸不再来自名称推断）
    if (sources.size === '名称解析') summary.nameParsed += 1;
    const isCaptureSource = (value) => typeof value === 'string' && value.startsWith('页面采集');
    if (isCaptureSource(sources.size) || isCaptureSource(sources.price)) summary.captureFilled += 1;
    if (!price) summary.pendingPrice += 1;
    if (!size) summary.pendingSize += 1;
    if (row.status === STATUS.CAPTURE_FAILED) summary.failed += 1;
    if (summary.byStatus[row.status] !== undefined) summary.byStatus[row.status] += 1;
  }
  summary.amountTotal = round2(summary.amountTotal);
  summary.avgSampleSpread = summary.sampled2 ? round2(sampledSpreadSum / summary.sampled2) : 0;
  summary.sizeCoverage = summary.total ? Number((summary.sizeFilled / summary.total).toFixed(4)) : 0;
  summary.priceCoverage = summary.total ? Number((summary.priceFilled / summary.total).toFixed(4)) : 0;
  summary.progressPct = summary.progressDenom ? round2((countedComplete / summary.progressDenom) * 100) : 0;
  return summary;
}

/**
 * 离线补数分析（DESIGN.md 第 7 节）。
 * 优先级：库（绑定类目优先，再全库）→ 同名商品推断（全库同名前置匹配）→ 商品名解析尺寸 → 待采集/待补。
 * 纯函数：不修改入参 report（返回新的 rows）。
 * @param {object} report {rows, store, ...}
 * @param {object} library
 * @param {object} [settings]
 * @returns {{rows:Array<object>, summary:object}}
 */
export function analyzeReport(report, library, settings) {
  if (!report || typeof report !== 'object') throw new Error('分析失败：榜单数据为空');
  const safeSettings = resolveSettings(settings);
  void safeSettings; // 离线分析不依赖价格口径（库里的值已是规范价格段），保留解析以便后续扩展
  const boundStore = textOf(report.store);
  const { boundRows, skuIndex } = buildLibraryIndexes(library, boundStore);
  const inputRows = Array.isArray(report.rows) ? report.rows : [];

  const rows = inputRows.map((input) => {
    const row = { ...input };
    const sku = normalizeSku(row.sku);
    // 人工改过的值保留，其余重算（重跑分析不会冲掉手动兜底）
    const manualSize = row.source && row.source.size === '手动' ? textOf(row.size) : '';
    const manualPrice = row.source && row.source.price === '手动' ? textOf(row.price) : '';
    let size = manualSize;
    let price = manualPrice;
    let sizeSource = manualSize ? '手动' : '';
    let priceSource = manualPrice ? '手动' : '';
    // 品牌补全（DESIGN.md 5.3）：榜单品牌列优先 → 匹配库品牌 → 商品名称 → 店铺名称 → 空
    const brandRaw = textOf(row.brand);
    const columnStoreName = textOf(row.storeName);
    const storeName = columnStoreName || textOf(report.store);
    const storeSource = columnStoreName ? '列' : storeName ? '类目' : '';
    let libraryBrand = '';
    let libraryModel = '';
    // 库里已有的价格段/尺寸段（v2.1 LIB_BAND_MISMATCH 用，即使本行已从别处补到值也记录）
    let libraryPriceBand = '';
    let librarySizeBand = '';

    const applyRecord = (record, source) => {
      if (!record) return;
      if (!size) {
        const value = librarySize(record);
        if (value) {
          size = value;
          sizeSource = source;
        }
      }
      if (!price) {
        const value = libraryPrice(record);
        if (value) {
          price = value;
          priceSource = source;
        }
      }
      if (!libraryBrand && record.brand) {
        libraryBrand = textOf(record.brand);
      }
      if (!libraryModel && record.model) libraryModel = textOf(record.model);
      if (!librarySizeBand) {
        const value = librarySize(record);
        if (value) librarySizeBand = value;
      }
      if (!libraryPriceBand) {
        const value = libraryPrice(record);
        if (value) libraryPriceBand = value;
      }
    };

    // 1) 匹配库：先绑定类目
    if (sku && boundRows[sku]) applyRecord(boundRows[sku], '库');
    if (sku && (!size || !price)) {
      const globalHits = skuIndex.get(sku);
      if (globalHits) {
        for (const hit of globalHits) {
          if (size && price) break;
          applyRecord(hit.record, '库');
        }
      }
    }

    // 2) 名称严格解析尺寸（v2.1.6，DESIGN.md 21.2）：
    //    - 名称中 ≥2 个明确尺寸表达（含 55/65英寸、98/100英寸、86/85英寸、75英寸 86英寸）→ 空置待人工；
    //    - 0 个明确表达 → 不猜（型号数字 75MBK7/VH75CAD 绝不当尺寸）→ 空置待人工；
    //    - 恰好 1 个明确表达且为常见尺寸 → 采用该尺寸段。
    //    价格绝不从这里产生（价格只来自库中该 SKU 或页面采集，v2.1.6 21.1）。
    //    同行同名商品推断已在 v2.1.6 删除，不再跨行补 size/price。
    let sizeAmbiguous = false;
    let sizeAmbiguousReason = '';
    if (!size) {
      const strict = parseSizeFromNameStrict(row.name);
      if (strict.size) {
        size = strict.size;
        sizeSource = '名称解析';
      } else {
        sizeAmbiguous = true;
        sizeAmbiguousReason = strict.reason;
        sizeSource = '';
      }
    }

    // 品牌补全（优先级见 DESIGN.md 5.3；brandSource 取值：列/库/名称/店铺/空）
    const resolvedBrand = resolveBrandDetailed({
      brandRaw,
      libraryBrand,
      name: row.name,
      storeName,
    });
    const brand = resolvedBrand.brand;
    const brandSource = resolvedBrand.source;

    // 关键字段补全（DESIGN.md 16.1 + v2.1.3 18.4）
    // 型号：榜单列 → 商品名称提取 → 匹配库同名商品（逻辑不变）
    // 套餐：v2.1.3 起只认榜单「套餐/套装/版本」列；不再从标题/匹配库提取，页面采集/人工值在重跑时保留
    const columnModel = textOf(row.model);
    const columnPackage = textOf(row.package);
    const nameModel = extractModel(row.name);
    const model = columnModel || nameModel || libraryModel || '';
    const modelSource = columnModel ? '列' : nameModel ? '名称' : libraryModel ? '库' : '';
    const keptPackageSource = row.source && ['列', '页面采集', '手动'].includes(row.source.package)
      ? row.source.package
      : '';
    const packageValue = columnPackage || (keptPackageSource ? textOf(row.package) : '');
    const packageSource = columnPackage ? '列' : keptPackageSource;

    const amount = typeof row.amount === 'number' && Number.isFinite(row.amount)
      ? row.amount
      : typeof input.amount === 'number' && Number.isFinite(input.amount)
        ? input.amount
        : null;
    const amountRaw = textOf(row.amountRaw);
    const noteParts = [];
    if (amountRaw && amount == null) noteParts.push('金额异常');
    if (!size && !price) noteParts.push('缺少尺寸段和价格段，需在线采集');
    else if (!price) noteParts.push('缺价格段，可在线采集');
    else if (!size) noteParts.push('缺尺寸段，需人工补或采集标题');
    if (size === '其他') noteParts.push('尺寸段未能解析（其他）');
    // v2.1.6（DESIGN.md 21.2）：名称多尺寸/无明确尺寸 → 留空待人工
    if (sizeAmbiguous) {
      noteParts.push(sizeAmbiguousReason === 'multiple-size-expressions'
        ? '名称含多个尺寸，待人工复核'
        : '无明确尺寸，待人工补充/采集');
    }

    const source = {
      size: sizeSource,
      price: priceSource,
      brand: brandSource,
      model: modelSource,
      package: packageSource,
    };
    // 复核状态在 v2.0 分析阶段为空；已有确认/复核结果的重跑分析时保留
    const review = row.review && typeof row.review === 'object' && Array.isArray(row.review.reasons)
      ? row.review
      : emptyReview();
    // v2.1.7：已下架行重跑分析仍保持「采集失败」且不计入进度分母
    const offSale = row.offSale === true;
    const status = offSale ? STATUS.CAPTURE_FAILED : computeRowStatus({ size, price, source, review, captureFailed: false });
    const pending = !size && !price ? 'both' : !price ? 'price' : !size ? 'size' : '';
    const noteText = offSale ? (textOf(row.note) || '采集失败：已下架') : noteParts.join('；');

    return {
      ...row,
      sku,
      storeName,
      storeSource,
      brand,
      model,
      package: packageValue,
      modelSource,
      packageSource,
      size,
      price,
      // v2.1.6：名称严格解析后尺寸待人工（多尺寸/无明确尺寸）；库/列/采集命中时保持 false
      sizeAmbiguous,
      sizeAmbiguousReason,
      source,
      status,
      pending,
      captureFailed: offSale,
      // v2.1.7：已下架标记（保留并回写，供 progressDenom 排除）
      offSale,
      offSaleReason: offSale ? (textOf(row.offSaleReason) || '已下架') : '',
      // 库参考（LIB_BAND_MISMATCH / 参考区间用；不覆盖任何已有值）
      libraryPriceBand,
      librarySizeBand,
      // v2.1 采集/复核字段（分析阶段默认空，applyCaptures 填充；采集元数据随 ...row 保留）
      capturePrice: typeof row.capturePrice === 'number' && Number.isFinite(row.capturePrice) ? row.capturePrice : null,
      sampleCount: Number.isFinite(Number(row.sampleCount)) ? Number(row.sampleCount) : 0,
      sampleSpread: Number.isFinite(Number(row.sampleSpread)) ? Number(row.sampleSpread) : 0,
      review,
      reviewText: formatReviewText(review),
      note: noteText,
      amount,
    };
  });

  return { rows, summary: summarizeRows(rows) };
}

/**
 * v2.1.3 数据迁移：清理历史「标题推测套餐」（DESIGN.md 18.4）。
 * 仅清理 packageSource ∈ {名称, 标题, 名称解析} 且 package 非空的行；保留 列 / 页面采集 / 手动。
 * 原地修改 reports（数组或单个 report），返回清理条数；幂等（再次调用返回 0）。
 * @param {Array<object>|object} reports
 * @returns {number} 清理条数
 */
export function migrateLegacyPackages(reports) {
  // 容错：也接受 session 对象（{reports:[...]}）或单个 report
  const input = !Array.isArray(reports) && reports && Array.isArray(reports.reports) ? reports.reports : reports;
  const reportList = toReportList(input);
  const legacySources = new Set(['名称', '标题', '名称解析']);
  let cleaned = 0;
  for (const report of reportList) {
    const rows = Array.isArray(report && report.rows) ? report.rows : [];
    for (const row of rows) {
      if (!row || !textOf(row.package)) continue;
      const source = textOf(row.packageSource) || textOf(row.source && row.source.package);
      if (!legacySources.has(source)) continue;
      row.package = '';
      row.packageSource = '';
      if (row.source && typeof row.source === 'object') row.source.package = '';
      cleaned += 1;
    }
  }
  return cleaned;
}

/** 采集到的“当前页面价”选价：priceKind 优先，其次 settings.price.prefer */
function pickCapturePrice(capture, settings) {
  const prices = capture && capture.prices && typeof capture.prices === 'object' ? capture.prices : {};
  const minPlausible = Number(settings.price.minPlausible);
  const usable = (value) => {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return null;
    if (Number.isFinite(minPlausible) && minPlausible > 0 && number < minPlausible) return null;
    return number;
  };
  const queue = [];
  if (capture && capture.priceKind && usable(prices[capture.priceKind]) != null) {
    queue.push(usable(prices[capture.priceKind]));
  }
  const prefer = Array.isArray(settings.price.prefer) && settings.price.prefer.length
    ? settings.price.prefer
    : DEFAULT_SETTINGS.price.prefer;
  for (const kind of prefer) {
    const value = usable(prices[kind]);
    if (value != null && !queue.includes(value)) queue.push(value);
  }
  for (const value of Object.values(prices)) {
    const usableValue = usable(value);
    if (usableValue != null && !queue.includes(usableValue)) queue.push(usableValue);
  }
  return queue.length ? queue[0] : null;
}

/** 采集失败原因转人话 */
function captureFailText(fail) {
  if (!fail) return '未知原因';
  if (typeof fail === 'string') return fail;
  return textOf(fail.reason || fail.message || fail.detail || fail.code) || '未知原因';
}

/* ---------------------- v2.1.7 价格类型 / 价格变化 / 下架（DESIGN.md 22） ---------------------- */

/** 价格类型中文（页面采集来源文案用） */
export const PRICE_KIND_LABELS = { hand: '到手价', plus: 'PLUS价', main: '电商平台价' };

/**
 * 价格类型 → 「数据来源」文案：hand→页面采集(到手价)、plus→页面采集(PLUS价)、main→页面采集(电商平台价)；
 * 无 kind → 页面采集。
 * @param {string} kind
 * @returns {string}
 */
export function capturePriceSourceText(kind) {
  const key = textOf(kind).toLowerCase();
  const label = PRICE_KIND_LABELS[key];
  return label ? `页面采集(${label})` : '页面采集';
}

/** 归一采集结果里的价格类型（只认 hand/plus/main） */
function normalizePriceKind(kind) {
  const key = textOf(kind).toLowerCase();
  return PRICE_KIND_LABELS[key] ? key : '';
}

/**
 * 价格元素位置归一（v2.1.7 终验修复，DESIGN.md 22.2）。
 * 兼容两种坐标契约：源版巡检 `{left, top, width, height}` 与本插件文档 `{x, y, w, h}`；
 * 同时输出两组字段（x/y/w/h + left/top/width/height），数值转 number，无有效值返回 null。
 * @param {object|null|undefined} raw
 * @returns {{x:number|null, y:number|null, w:number|null, h:number|null,
 *            left:number|null, top:number|null, width:number|null, height:number|null}|null}
 */
export function normalizePriceRect(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const num = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  };
  const x = num(raw.x != null ? raw.x : raw.left);
  const y = num(raw.y != null ? raw.y : raw.top);
  const w = num(raw.w != null ? raw.w : raw.width);
  const h = num(raw.h != null ? raw.h : raw.height);
  if (x === null && y === null && w === null && h === null) return null;
  return { x, y, w, h, left: x, top: y, width: w, height: h };
}

/** 采集候选价摘要（前 12 条，DESIGN.md 22.2 上报字段） */
function summarizePriceCandidate(candidate) {
  if (!candidate || typeof candidate !== 'object') return null;
  const summary = {};
  if (candidate.price !== undefined) summary.price = candidate.price;
  if (candidate.kind !== undefined) summary.kind = textOf(candidate.kind);
  if (candidate.text !== undefined) summary.text = textOf(candidate.text).slice(0, 60);
  if (candidate.cls !== undefined) summary.cls = textOf(candidate.cls).slice(0, 120);
  if (candidate.font !== undefined) summary.font = Number(candidate.font) || candidate.font;
  if (candidate.strike !== undefined) summary.strike = !!candidate.strike;
  if (candidate.rect !== undefined) {
    // 候选 rect 同样兼容源版 {left,top,width,height} 与 {x,y,w,h}
    summary.rect = normalizePriceRect(candidate.rect);
  }
  return summary;
}

/** 采集结果是否「已下架」（显式 offSale 优先；兼容 fail.code/reason 含下架/不存在） */
function captureIsOffSale(capture) {
  if (!capture || typeof capture !== 'object') return false;
  if (capture.offSale === true) return true;
  const fail = capture.fail;
  if (!fail) return false;
  if (typeof fail === 'string') return /已下架|下架|商品不存在/.test(fail);
  if (typeof fail === 'object') {
    if (fail.offSale === true) return true;
    const code = textOf(fail.code || fail.type);
    if (code === 'offSale' || code === 'off-sale' || code === 'off_sale') return true;
    const reason = textOf(fail.reason || fail.message || fail.detail);
    if (/已下架|下架|商品不存在|已售罄|无法购买/.test(reason)) return true;
  }
  return false;
}

/** 价格变化展示文本（连续记录取首→末）：`24699→25099` */
function formatPriceChanges(changes) {
  if (!Array.isArray(changes) || !changes.length) return '';
  const from = Number(changes[0] && changes[0].from);
  const last = changes[changes.length - 1] || {};
  const to = Number(last.to);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return '';
  return `${from}→${to}`;
}

/**
 * 保留采集元数据（v2.1.7，DESIGN.md 22.2 上报字段）：价格类型/价格变化/价格位置/元素 class/候选价摘要。
 * 仅在行上保留（导出列结构不变），供 UI 徽标/调试 JSON 使用；旧采集记录缺字段时保持原值。
 */
function applyCaptureMeta(row, capture) {
  if (!capture || typeof capture !== 'object') return;
  const kind = normalizePriceKind(capture.priceKind);
  if (kind) {
    row.priceKind = kind;
    row.priceKindLabel = textOf(capture.priceKindLabel) || PRICE_KIND_LABELS[kind];
  } else if (capture.priceKindLabel !== undefined) {
    row.priceKindLabel = textOf(capture.priceKindLabel);
  }
  if (Array.isArray(capture.priceChanges)) {
    row.priceChanges = capture.priceChanges
      .map((item) => ({ from: Number(item && item.from), to: Number(item && item.to) }))
      .filter((item) => Number.isFinite(item.from) && Number.isFinite(item.to));
  }
  if (capture.priceRect !== undefined) {
    // v2.1.7 终验修复：兼容采集侧 {left,top,width,height} 与文档 {x,y,w,h}
    row.priceRect = normalizePriceRect(capture.priceRect);
  }
  if (capture.sourceLabel !== undefined) row.sourceLabel = textOf(capture.sourceLabel).slice(0, 120);
  if (Array.isArray(capture.candidates)) {
    row.candidates = capture.candidates.slice(0, 12).map(summarizePriceCandidate).filter(Boolean);
  }
}

/** 采集结果统一成 {sku, ...} 数组 */
function captureEntries(captures) {
  if (!captures) return [];
  if (Array.isArray(captures)) return captures.filter(Boolean);
  if (typeof captures === 'object') return Object.values(captures).filter(Boolean);
  return [];
}

/** 从采集记录里解析「本次采用的价格」与采样信息（v2.1 优先 samples/price，兼容老 prices+priceKind） */
function resolveCapturePrice(capture, settings) {
  const samples = Array.isArray(capture && capture.samples) ? capture.samples : [];
  if (samples.length) {
    const chosen = chooseSampleValue(samples, {
      toleranceAbs: settings.capture.toleranceAbs,
      tolerancePct: settings.capture.tolerancePct,
    });
    if (chosen.price != null) {
      // 样本口径：全部样本同一 kind 时采用该 kind（否则退回 capture.priceKind）
      const sampleKinds = [...new Set(samples.map((sample) => normalizePriceKind(sample && (sample.kind || sample.priceKind))).filter(Boolean))];
      const kind = sampleKinds.length === 1 ? sampleKinds[0] : normalizePriceKind(capture && capture.priceKind);
      return { price: chosen.price, chosen, sampleCount: chosen.values.length, spread: chosen.spread, kind };
    }
  }
  const direct = Number(capture && capture.price);
  if (Number.isFinite(direct) && direct > 0) {
    return { price: direct, chosen: null, sampleCount: 1, spread: round2(Number(capture && capture.spread) || 0), kind: normalizePriceKind(capture && capture.priceKind) };
  }
  const planned = pickCapturePrice(capture, settings);
  if (planned != null) {
    return { price: planned, chosen: null, sampleCount: 1, spread: round2(Number(capture && capture.spread) || 0), kind: normalizePriceKind(capture && capture.priceKind) };
  }
  return { price: null, chosen: null, sampleCount: 0, spread: 0, kind: '' };
}

/**
 * 采集结果里的附加字段回填（v2.1.3 18.4）：型号 / 套餐 / 品牌 + specGroups 调试字段。
 * - 型号：页面规格参数权威，但不覆盖榜单原列（modelSource='列' 时保留原列值，与 v2.1 一致）
 * - 套餐：商品页「已选版本/套餐选项」权威，覆盖标题/榜单/旧值，来源统一写「页面采集」
 * - specGroups / packageGroup：原样透传到行上供 UI 调试（不导出）
 * @returns {boolean} 是否发生字段变化
 */
function applyCaptureExtras(row, capture) {
  if (!row.source || typeof row.source !== 'object') {
    row.source = { size: '', price: '', brand: '', model: '', package: '' };
  }
  let changed = false;
  if (capture.model && row.modelSource !== '列') {
    const nextModel = textOf(capture.model);
    if (nextModel && nextModel !== row.model) {
      row.model = nextModel;
      row.modelSource = '页面采集';
      row.source.model = '页面采集';
      changed = true;
    }
  }
  const nextPackage = textOf(capture.package);
  if (nextPackage && (nextPackage !== textOf(row.package) || row.packageSource !== '页面采集')) {
    row.package = nextPackage;
    row.packageSource = '页面采集';
    row.source.package = '页面采集';
    changed = true;
  }
  if (!row.brand && capture.brand) {
    row.brand = textOf(capture.brand);
    row.source.brand = '页面采集';
    changed = true;
  }
  if (capture.specGroups !== undefined) row.specGroups = capture.specGroups;
  if (capture.packageGroup !== undefined) row.packageGroup = capture.packageGroup;
  return changed;
}

/**
 * 把采集结果补进榜单行（DESIGN.md 第 7 节 + v2.1 16.4 多采样复核）。
 * - 价格：优先 capture.samples（chooseSampleValue 中位数）→ capture.price → prices+priceKind/prefer（老记录兼容）；
 * - 尺寸：sizeInch 优先，其次 sizeText（标题正则）；
 * - 已补齐的行不覆盖（幂等，可反复调用；已人工确认的 review 保留）；
 * - 复核：evaluatePriceReview 计算 needed/reasons，状态置「需确认」；fail 的行标「采集失败」。
 * 会原地更新 report.rows，同时返回 {updated, rows, summary}。
 * @param {object} report
 * @param {object|Array} captures
 * @param {object} [settings]
 * @param {object} [library] 匹配库（用于「同类参考区间」；不传则跳过 OUT_OF_REFERENCE 判定）
 */
export function applyCaptures(report, captures, settings, library) {
  if (!report || typeof report !== 'object') throw new Error('补采失败：榜单数据为空');
  const safeSettings = resolveSettings(settings);
  const priceMode = safeSettings.price.bandBoundary === 'rightClosed' ? 'rightClosed' : 'rightOpen';
  const captureIndex = new Map();
  for (const capture of captureEntries(captures)) {
    const sku = normalizeSku(capture && capture.sku);
    if (sku) captureIndex.set(sku, capture);
  }
  const rows = Array.isArray(report.rows) ? report.rows : [];
  const boundStore = textOf(report.store);
  const referenceCache = new Map();
  const getReferenceRange = (storeName, sizeBand) => {
    if (!library) return null;
    const key = `${storeName}|${sizeBand}`;
    if (referenceCache.has(key)) return referenceCache.get(key);
    const range = buildReferencePriceRange(library, storeName, sizeBand);
    referenceCache.set(key, range);
    return range;
  };
  let updated = 0;

  for (const row of rows) {
    const sku = normalizeSku(row.sku);
    const capture = sku ? captureIndex.get(sku) : null;
    if (!capture) {
      row.status = computeRowStatus(row);
      continue;
    }
    // 下架/失败优先处理（v2.1.7 22.2：即使该行库里有尺寸/价格，也要标记已下架用于进度分母）
    if (capture.offSale === true || capture.fail) {
      const offSale = captureIsOffSale(capture);
      const reasonText = offSale ? '已下架' : captureFailText(capture.fail);
      const nextNote = `采集失败：${reasonText}`;
      if (row.status !== STATUS.CAPTURE_FAILED || row.note !== nextNote || !!row.offSale !== offSale) updated += 1;
      row.captureFailed = true;
      row.status = STATUS.CAPTURE_FAILED;
      row.note = nextNote;
      row.offSale = offSale;
      row.offSaleReason = offSale ? '已下架' : '';
      if (!row.review || typeof row.review !== 'object') row.review = emptyReview();
      continue;
    }
    // 已补齐的行不覆盖价格/尺寸（v2.0 行为）；型号/套餐/品牌等页面附加信息仍可回填（v2.1.3）
    if (row.size && row.price) {
      applyCaptureMeta(row, capture);
      row.offSale = false;
      row.offSaleReason = '';
      if (applyCaptureExtras(row, capture)) {
        row.captureFailed = false;
        row.capturedAt = capture.at || '';
        row.captureAccount = capture.account || '';
        updated += 1;
      }
      if (row.review && typeof row.review === 'object') {
        row.review = { ...row.review, needed: !!row.review.needed && !row.review.confirmed };
        row.reviewText = formatReviewText(row.review);
      }
      row.status = computeRowStatus(row);
      continue;
    }
    if (!row.source) {
      row.source = { size: '', price: '', brand: '', model: '', package: '' };
    }

    const previousReview = row.review && typeof row.review === 'object' ? row.review : null;
    const confirmed = !!(
      (previousReview && previousReview.confirmed)
      || (capture.review && capture.review.confirmed)
    );
    const confirmedAt = textOf(
      (previousReview && previousReview.confirmedAt)
      || (capture.review && capture.review.confirmedAt),
    );
    let changed = false;
    const resolved = resolveCapturePrice(capture, safeSettings);
    // v2.1.7（22.2）：保留采集元数据（价格类型/变化/位置/候选摘要）；成功采集自动解除下架标记
    applyCaptureMeta(row, capture);
    row.offSale = false;
    row.offSaleReason = '';

    // 价格（数据来源细化为 页面采集(到手价/PLUS价/电商平台价)；无 kind 仍为「页面采集」）
    const priceKind = resolved.kind || normalizePriceKind(capture.priceKind);
    const hadPriceFromBefore = Boolean(row.price);
    if (!row.price && resolved.price != null) {
      const band = priceBandOf(resolved.price, priceMode);
      if (band) {
        row.price = band;
        row.source.price = capturePriceSourceText(priceKind);
        changed = true;
      }
    }
    if (resolved.price != null) {
      row.capturePrice = resolved.price;
      if (resolved.sampleCount > 0) row.sampleCount = resolved.sampleCount;
      row.sampleSpread = resolved.spread;
      if (priceKind) {
        row.priceKind = priceKind;
        row.priceKindLabel = row.priceKindLabel || PRICE_KIND_LABELS[priceKind];
        // 仅当价格本身由页面采集写入时才细化来源；库值来源保持「库」
        if (!hadPriceFromBefore) row.source.price = capturePriceSourceText(priceKind);
      }
    }
    // 尺寸（v2.1.6）：页面明确尺寸优先；标题只在「唯一明确尺寸表达」时采用（DESIGN.md 21.2）
    if (!row.size) {
      let band = '';
      const inch = Number(capture.sizeInch);
      if (Number.isFinite(inch) && inch > 0) band = sizeBandOf(inch);
      if (!band && capture.sizeText) {
        const strict = parseSizeFromNameStrict(capture.sizeText);
        if (strict.size) band = strict.size;
      }
      if (band) {
        row.size = band;
        row.source.size = '页面采集';
        row.sizeAmbiguous = false; // 页面尺寸已明确，解除「尺寸待人工」标记
        row.sizeAmbiguousReason = '';
        changed = true;
      }
    }
    // 附加字段（型号/套餐/品牌/specGroups，见 applyCaptureExtras）
    if (applyCaptureExtras(row, capture)) changed = true;

    // 复核（v2.1）：只提疑，不改选值
    const previousReviewText = textOf(row.reviewText);
    if (row.capturePrice != null) {
      const referenceRange = getReferenceRange(textOf(row.storeName) || boundStore, row.size || '');
      const reviewEval = evaluatePriceReview({
        price: Number(row.capturePrice),
        samples: Array.isArray(capture.samples) ? capture.samples : [],
        priceBand: row.price || '',
        libraryBand: textOf(row.libraryPriceBand),
        referenceRange: referenceRange || null,
        priceKind: textOf(capture.priceKind),
        candidateCount: capture.candidateCount,
        settings: safeSettings,
      });
      const review = {
        needed: reviewEval.needed && !confirmed,
        reasons: reviewEval.reasons,
        confirmed,
        confirmedAt,
        price: row.capturePrice,
        sampleCount: Number(row.sampleCount) || 0,
        spread: Number(row.sampleSpread) || 0,
        consistent: reviewEval.consistent,
        referenceRange: referenceRange
          ? { low: referenceRange.low, high: referenceRange.high, count: referenceRange.count }
          : null,
      };
      row.review = review;
      row.reviewText = formatReviewText(review);
      if (previousReviewText !== row.reviewText) changed = true;
    } else if (!row.review || typeof row.review !== 'object') {
      row.review = emptyReview();
    }

    if (changed) {
      row.captureFailed = false;
      row.capturedAt = capture.at || '';
      row.captureAccount = capture.account || '';
      updated += 1;
    }
    // 状态与备注
    if (row.size && row.price) row.captureFailed = false;
    row.status = computeRowStatus(row);
    if (row.status === STATUS.REVIEW_NEEDED) row.note = row.reviewText || '需人工确认';
    else if (row.status === STATUS.PARTIAL) row.note = '缺价格段，可在线采集';
    else if (row.status === STATUS.PENDING_MANUAL) row.note = '缺尺寸段，需人工补或采集标题';
    else if (row.status === STATUS.MATCHED || row.status === STATUS.CAPTURED) {
      if (row.note && /缺|采集失败|需确认/.test(row.note)) row.note = '';
    }
    // v2.1.7（22.2）：价格变化记录提示（已采用最新价）
    if (Array.isArray(row.priceChanges) && row.priceChanges.length) {
      const changeText = formatPriceChanges(row.priceChanges);
      if (changeText) {
        row.note = `${row.note ? `${row.note}；` : ''}页面价格变动 ${changeText}（已采用最新）`;
      }
    }
  }

  return { updated, rows, summary: summarizeRows(rows) };
}

/** 把 reports 参数统一成数组 */
function toReportList(reports) {
  if (Array.isArray(reports)) return reports.filter(Boolean);
  if (reports && typeof reports === 'object' && Array.isArray(reports.rows)) return [reports];
  return [];
}

/**
 * 统计（DESIGN.md 第 9 节 / 验收第 6 条）。
 * 金额单位万元；amount=null 的行计入 rows、不计入 amount。
 * @param {Array<object>|object} reports
 * @param {object} [library]
 * @returns {{total:object, byStore:Array, bySize:Array, byPrice:Array, matrix:object, missing:object}}
 */
export function computeStats(reports, library) {
  const reportList = toReportList(reports);
  const storeMap = new Map();
  const sizeMap = new Map();
  const priceMap = new Map();
  const sizePriceMap = new Map();
  const brandPriceMap = new Map();
  const brandMap = new Map();
  const total = {
    reports: reportList.length,
    rows: 0,
    amount: 0,
    complete: 0,
    amountAnomaly: 0,
    // v2.1 只读统计（DESIGN.md 16.8）
    reviewNeeded: 0,
    sampled2: 0,
    avgSampleSpread: 0,
    storeNames: [],
    // v2.1.7（22.3）：下架行不计入采集进度分母
    offSale: 0,
    progressDenom: 0,
    progressComplete: 0,
    pending: 0,
    progress: 0,
    progressPct: 0,
  };
  let totalSpreadSum = 0;
  const missing = { size: 0, price: 0 };

  for (const report of reportList) {
    const storeName = textOf(report.store) || '未绑定类目';
    const rows = Array.isArray(report.rows) ? report.rows : [];
    if (!storeMap.has(storeName)) {
      storeMap.set(storeName, {
        store: storeName,
        reports: 0,
        rows: 0,
        amount: 0,
        complete: 0,
        reviewNeeded: 0,
        sampled2: 0,
        spreadSum: 0,
        offSale: 0,
        progressDenom: 0,
        progressComplete: 0,
        brands: new Map(),
      });
    }
    const storeEntry = storeMap.get(storeName);
    storeEntry.reports += 1;
    for (const row of rows) {
      total.rows += 1;
      storeEntry.rows += 1;
      const amount = typeof row.amount === 'number' && Number.isFinite(row.amount) ? row.amount : 0;
      const hasAmount = typeof row.amount === 'number' && Number.isFinite(row.amount);
      if (!hasAmount) total.amountAnomaly += 1;
      total.amount += amount;
      storeEntry.amount += amount;
      const complete = !!(row.size && row.price);
      if (complete) {
        total.complete += 1;
        storeEntry.complete += 1;
      }
      // v2.1.7：已下架行不计入进度分母
      if (row.offSale === true) {
        total.offSale += 1;
        storeEntry.offSale += 1;
      } else {
        total.progressDenom += 1;
        storeEntry.progressDenom += 1;
        if (complete) {
          total.progressComplete += 1;
          storeEntry.progressComplete += 1;
        }
      }
      if (!row.size) missing.size += 1;
      if (!row.price) missing.price += 1;
      // v2.1：复核 / 采样统计
      if (row.review && row.review.needed && !row.review.confirmed) {
        total.reviewNeeded += 1;
        storeEntry.reviewNeeded += 1;
      }
      if (Number(row.sampleCount) >= 2) {
        total.sampled2 += 1;
        storeEntry.sampled2 += 1;
        totalSpreadSum += Number(row.sampleSpread) || 0;
        storeEntry.spreadSum += Number(row.sampleSpread) || 0;
      }

      const brand = brandOf(row.brand);
      if (!brandMap.has(brand)) brandMap.set(brand, { brand, rows: 0, amount: 0 });
      const brandEntry = brandMap.get(brand);
      brandEntry.rows += 1;
      brandEntry.amount += amount;
      if (!storeEntry.brands.has(brand)) storeEntry.brands.set(brand, { brand, rows: 0, amount: 0 });
      const storeBrand = storeEntry.brands.get(brand);
      storeBrand.rows += 1;
      storeBrand.amount += amount;

      const sizeBand = row.size || '未补';
      const priceBand = row.price || '未补';
      if (!sizeMap.has(sizeBand)) sizeMap.set(sizeBand, { band: sizeBand, rows: 0, amount: 0 });
      sizeMap.get(sizeBand).rows += 1;
      sizeMap.get(sizeBand).amount += amount;
      if (!priceMap.has(priceBand)) priceMap.set(priceBand, { band: priceBand, rows: 0, amount: 0 });
      priceMap.get(priceBand).rows += 1;
      priceMap.get(priceBand).amount += amount;

      const sizePriceKey = `${sizeBand}|${priceBand}`;
      if (!sizePriceMap.has(sizePriceKey)) {
        sizePriceMap.set(sizePriceKey, { size: sizeBand, price: priceBand, rows: 0, amount: 0 });
      }
      const sizePrice = sizePriceMap.get(sizePriceKey);
      sizePrice.rows += 1;
      sizePrice.amount += amount;

      const brandPriceKey = `${brand}|${priceBand}`;
      if (!brandPriceMap.has(brandPriceKey)) {
        brandPriceMap.set(brandPriceKey, { brand, price: priceBand, rows: 0, amount: 0 });
      }
      const brandPrice = brandPriceMap.get(brandPriceKey);
      brandPrice.rows += 1;
      brandPrice.amount += amount;
    }
  }

  total.amount = round2(total.amount);
  total.avgSampleSpread = total.sampled2 ? round2(totalSpreadSum / total.sampled2) : 0;
  total.storeNames = [...storeMap.keys()];
  // v2.1.7：进度 = 有效行（排除已下架）中尺寸段+价格段齐全的比例；pending = 有效行中仍缺字段的行
  total.pending = Math.max(0, total.progressDenom - total.progressComplete);
  total.progress = total.progressDenom ? Number((total.progressComplete / total.progressDenom).toFixed(4)) : 0;
  total.progressPct = Number((total.progress * 100).toFixed(2));
  const totalAmount = total.amount;

  const byStore = [];
  for (const entry of storeMap.values()) {
    const brands = [...entry.brands.values()]
      .map((brand) => ({
        brand: brand.brand,
        rows: brand.rows,
        amount: round2(brand.amount),
        share: shareOf(brand.amount, entry.amount),
        sharePercent: round2(shareOf(brand.amount, entry.amount) * 100),
      }))
      .sort((a, b) => b.amount - a.amount);
    byStore.push({
      store: entry.store,
      reports: entry.reports,
      rows: entry.rows,
      amount: round2(entry.amount),
      complete: entry.complete,
      reviewNeeded: entry.reviewNeeded,
      sampled2: entry.sampled2,
      avgSampleSpread: entry.sampled2 ? round2(entry.spreadSum / entry.sampled2) : 0,
      // v2.1.7：下架不计入进度分母
      offSale: entry.offSale,
      progressDenom: entry.progressDenom,
      progressComplete: entry.progressComplete,
      progressPct: entry.progressDenom
        ? Number(((entry.progressComplete / entry.progressDenom) * 100).toFixed(2))
        : 0,
      brands,
    });
  }
  byStore.sort((a, b) => b.amount - a.amount);

  const buildBandList = (bands, map) => {
    const result = bands.map((band) => {
      const hit = map.get(band) || { rows: 0, amount: 0 };
      return {
        band,
        rows: hit.rows,
        amount: round2(hit.amount),
        share: shareOf(hit.amount, totalAmount),
        sharePercent: round2(shareOf(hit.amount, totalAmount) * 100),
      };
    });
    // 动态尺寸段：DESIGN 5.1 规定「其他数字 → 其他尺寸({n}英寸)」，这些也是合法值，
    // 不在固定枚举里但要出现在分布中（按英寸数升序追加在固定枚举之后）
    const dynamicBands = [...map.keys()]
      .filter((band) => band !== '未补' && !bands.includes(band))
      .sort((a, b) => {
        const inchA = firstNumberIn(a);
        const inchB = firstNumberIn(b);
        if (inchA !== inchB) return inchA - inchB;
        return a.localeCompare(b, 'zh');
      });
    for (const band of dynamicBands) {
      const hit = map.get(band);
      result.push({
        band,
        rows: hit.rows,
        amount: round2(hit.amount),
        share: shareOf(hit.amount, totalAmount),
        sharePercent: round2(shareOf(hit.amount, totalAmount) * 100),
        dynamic: true,
      });
    }
    const missingHit = map.get('未补');
    if (missingHit && missingHit.rows > 0) {
      result.push({
        band: '未补',
        rows: missingHit.rows,
        amount: round2(missingHit.amount),
        share: shareOf(missingHit.amount, totalAmount),
        sharePercent: round2(shareOf(missingHit.amount, totalAmount) * 100),
        missing: true,
      });
    }
    return result;
  };
  const bySize = buildBandList(SIZE_BANDS, sizeMap);
  const byPrice = buildBandList(PRICE_BANDS, priceMap);

  const brands = [...brandMap.values()]
    .map((brand) => ({
      brand: brand.brand,
      rows: brand.rows,
      amount: round2(brand.amount),
      share: shareOf(brand.amount, totalAmount),
      sharePercent: round2(shareOf(brand.amount, totalAmount) * 100),
    }))
    .sort((a, b) => b.amount - a.amount);

  return {
    total,
    // v2.1.7：顶层别名，UI 可直接读 stats.offSale / stats.progressDenom / stats.progressPct
    offSale: total.offSale,
    progressDenom: total.progressDenom,
    progressPct: total.progressPct,
    byStore,
    bySize,
    byPrice,
    matrix: {
      sizes: bySize.map((item) => item.band),
      prices: byPrice.map((item) => item.band),
      bySizePrice: [...sizePriceMap.values()].map((cell) => ({
        size: cell.size,
        price: cell.price,
        rows: cell.rows,
        amount: round2(cell.amount),
      })),
      byBrandPrice: [...brandPriceMap.values()].map((cell) => ({
        brand: cell.brand,
        price: cell.price,
        rows: cell.rows,
        amount: round2(cell.amount),
      })),
      brands,
    },
    missing,
  };
}

/** 把行来源拼成「尺寸段：库；价格段：页面采集；型号：名称」 */
function formatRowSources(row) {
  const sources = row.source || {};
  const parts = [];
  if (sources.size) parts.push(`尺寸段：${sources.size}`);
  if (sources.price) parts.push(`价格段：${sources.price}`);
  if (sources.model) parts.push(`型号：${sources.model}`);
  if (sources.package) parts.push(`套餐：${sources.package}`);
  return parts.join('；');
}

/** 采样展示文本：`2 次（差 18 元）` / `1 次` */
function formatSampleText(row) {
  const count = Number(row.sampleCount) || 0;
  if (!count) return '';
  const spread = Number(row.sampleSpread) || 0;
  return spread > 0 ? `${count} 次（差 ${formatAmountText(spread)} 元）` : `${count} 次`;
}

/** 数字短文本（价差/边界距离展示用） */
function formatAmountText(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '0';
  return Number.isInteger(number) ? String(number) : String(round2(number));
}

/** 店铺展示：优先行上的店铺名，没有则用报告绑定类目兜底并标注 */
function storeNameOf(row, report) {
  const name = textOf(row.storeName);
  if (name) return name;
  const store = textOf(report && report.store);
  return store ? `${store}（类目兜底）` : '';
}

/* ---------------------- v2.1.4 入库状态 / 导出表头（DESIGN.md 19.1/19.2） ---------------------- */

/** 入库状态中文（与界面颜色/徽标文案一致；v2.1.5 20.3：核验后显示「已确认」） */
export const LIB_STATE_LABELS = {
  verified: '已确认',
  incomplete: '库数据不全',
  new: '新 SKU',
  pending: '待确认写入',
};

/** 行上是否已同时具备尺寸段+价格段（可人工确认写入的前提；DESIGN.md 19.1 / 用户要求「脚本补齐后必须人工确认」） */
function hasCompleteBands(row) {
  return Boolean(textOf(row && row.size) && textOf(row && row.price));
}

/**
 * 给每个榜单行标注 `row.libState`（只读，不写匹配库、不改价格/尺寸）。
 * verified：库记录存在 && verified && 有尺寸段+价格段；
 * incomplete：库记录存在但不满足 verified；
 * new：库中无该 SKU；
 * pending：非 verified 且已有尺寸段+价格段（库补/名称严格解析/采集等脚本补齐后尚未人工确认写入）。
 * pending 优先于 new/incomplete（DESIGN.md 19.1，用户要求「AI/脚本补齐后必须人工确认」）。
 * @param {Array<object>|object} reports
 * @param {object} library
 * @returns {{verified:number, incomplete:number, new:number, pending:number, total:number}}
 */
export function annotateLibraryStates(reports, library) {
  const reportList = toReportList(reports);
  // SKU 索引：sku -> [{store, record}]（同 SKU 跨类目时优先本榜单绑定类目）
  const skuIndex = new Map();
  for (const [storeName, store] of Object.entries((library && library.stores) || {})) {
    for (const [sku, record] of Object.entries((store && store.rows) || {})) {
      if (!record || typeof record !== 'object') continue;
      const key = normalizeSku(record.sku != null ? record.sku : sku);
      if (!key) continue;
      if (!skuIndex.has(key)) skuIndex.set(key, []);
      skuIndex.get(key).push({ store: storeName, record });
    }
  }
  const stats = { verified: 0, incomplete: 0, new: 0, pending: 0, total: 0 };
  for (const report of reportList) {
    const boundStore = textOf(report && report.store);
    const rows = Array.isArray(report && report.rows) ? report.rows : [];
    for (const row of rows) {
      const sku = normalizeSku(row.sku);
      const hits = sku ? skuIndex.get(sku) : null;
      let record = null;
      if (hits && hits.length) {
        const preferred = boundStore ? hits.find((hit) => hit.store === boundStore) : null;
        record = (preferred || hits[0]).record;
      }
      let state;
      if (!record) state = 'new';
      else if (isRecordVerified(record) && librarySize(record) && libraryPrice(record)) state = 'verified';
      else state = 'incomplete';
      // pending 优先：非 verified 且脚本已补齐尺寸段+价格段 → 待人工确认写入
      if (state !== 'verified' && hasCompleteBands(row)) state = 'pending';
      row.libState = state;
      stats[state] += 1;
      stats.total += 1;
    }
  }
  return stats;
}

/** 与界面一致的单行导出值（配对明细/CSV 15 列，DESIGN.md 19.2；不含「操作」列） */
export const PAIR_EXPORT_HEADERS = [
  '行', 'SKU', '商品名称', '店铺', '品牌', '型号', '套餐', '尺寸段', '价格段',
  '当前价格(元)', '成交金额(万元)', '采样', '数据来源', '状态', '入库状态',
];

/** 榜单简称（与界面「行」列一致：去 .xlsx、超 16 字截断加 …） */
function reportShortName(report) {
  const file = textOf(report && report.fileName).replace(/\.xlsx$/i, '');
  if (!file) return '榜单';
  return file.length > 16 ? `${file.slice(0, 16)}…` : file;
}

/** 配对/回填导出列宽（15 列；回填第 16 列「操作」另给 10） */
const pairWidths = [18, 18, 46, 30, 18, 18, 22, 16, 20, 12, 16, 18, 34, 12, 12];

/** 单行 → 配对导出 15 列数组 */
function pairRowValues(report, row) {
  return [
    `${reportShortName(report)} #${row.rowNo}`,
    row.sku || '',
    row.name || '',
    storeNameOf(row, report),
    row.brand || '',
    row.model || '',
    row.package || '',
    row.size || '',
    row.price || '',
    typeof row.capturePrice === 'number' && Number.isFinite(row.capturePrice) ? row.capturePrice : null,
    typeof row.amount === 'number' && Number.isFinite(row.amount) ? row.amount : null,
    formatSampleText(row),
    formatRowSources(row),
    row.status || '',
    LIB_STATE_LABELS[row.libState] || '',
  ];
}

/**
 * 全部榜单的配对导出数据（15 列，与界面表头逐字一致；CSV / 配对明细共用）。
 * @param {Array<object>|object} reports
 * @returns {{headers:string[], rows:Array<Array<*>>}}
 */
export function pairExportRows(reports) {
  const reportList = toReportList(reports);
  const rows = [];
  for (const report of reportList) {
    for (const row of Array.isArray(report.rows) ? report.rows : []) {
      rows.push(pairRowValues(report, row));
    }
  }
  return { headers: PAIR_EXPORT_HEADERS.slice(), rows };
}

/**
 * 组装「市占率结果」工作簿数据（给 writeXlsx）。
 * 工作表：统计_类目、统计_尺寸段、统计_价格段、配对_1..n。
 * @param {Array<object>} reports
 * @param {object} stats computeStats 的返回值
 * @param {object} [meta]
 * @returns {{sheets:Array<object>}}
 */
export function buildResultWorkbook(reports, stats, meta = {}) {
  const reportList = toReportList(reports);
  const statistics = stats && stats.byStore ? stats : computeStats(reportList);
  const sheets = [];

  const storeRows = [];
  for (const store of statistics.byStore) {
    for (const brand of store.brands) {
      storeRows.push([store.store, brand.brand, brand.rows, brand.amount, brand.sharePercent]);
    }
    storeRows.push([store.store, '（类目合计）', store.rows, store.amount, 100]);
  }
  sheets.push({
    name: '统计_类目',
    columns: [
      { header: '类目/店铺', width: 24 },
      { header: '品牌', width: 22 },
      { header: '商品数', width: 10 },
      { header: '成交金额(万元)', width: 16 },
      { header: '品牌占比(%)', width: 14 },
    ],
    rows: storeRows,
    freeze: true,
  });

  sheets.push({
    name: '统计_尺寸段',
    columns: [
      { header: '尺寸段', width: 20 },
      { header: '商品数', width: 10 },
      { header: '成交金额(万元)', width: 16 },
      { header: '占比(%)', width: 12 },
    ],
    rows: statistics.bySize.map((item) => [item.band, item.rows, item.amount, item.sharePercent]),
    freeze: true,
  });

  sheets.push({
    name: '统计_价格段',
    columns: [
      { header: '价格段', width: 22 },
      { header: '商品数', width: 10 },
      { header: '成交金额(万元)', width: 16 },
      { header: '占比(%)', width: 12 },
    ],
    rows: statistics.byPrice.map((item) => [item.band, item.rows, item.amount, item.sharePercent]),
    freeze: true,
  });

  // 「待确认」sheet（v2.1）：有 reviewNeeded 行时才生成
  const pendingRows = [];
  for (const report of reportList) {
    for (const row of Array.isArray(report.rows) ? report.rows : []) {
      if (!row.review || !row.review.needed || row.review.confirmed) continue;
      pendingRows.push([
        textOf(report.fileName) || textOf(report.sheetName) || '',
        row.rowNo,
        row.sku,
        row.name || '',
        storeNameOf(row, report),
        row.brand || '',
        row.model || '',
        row.size || '',
        row.price || '',
        row.capturePrice != null ? row.capturePrice : null,
        formatSampleText(row),
        (row.review.reasons || []).map((reason) => textOf(reason && reason.text)).filter(Boolean).join('；'),
      ]);
    }
  }
  if (pendingRows.length) {
    sheets.push({
      name: '待确认',
      columns: [
        { header: '榜单', width: 30 },
        { header: '行号', width: 8 },
        { header: 'SKU', width: 18 },
        { header: '商品名称', width: 46 },
        { header: '店铺', width: 28 },
        { header: '品牌', width: 16 },
        { header: '型号', width: 18 },
        { header: '尺寸段', width: 16 },
        { header: '价格段', width: 20 },
        { header: '当前价格(元)', width: 12 },
        { header: '采样', width: 18 },
        { header: '复核原因', width: 46 },
      ],
      rows: pendingRows,
      freeze: true,
    });
  }

  reportList.forEach((report, index) => {
    const rows = (Array.isArray(report.rows) ? report.rows : []).map((row) => pairRowValues(report, row));
    sheets.push({
      name: `配对_${index + 1}`,
      columns: PAIR_EXPORT_HEADERS.map((header, column) => ({ header, width: pairWidths[column] || 14 })),
      rows,
      freeze: true,
    });
  });

  return { sheets, meta: { exportedAt: isoNow(), reports: reportList.length, ...meta } };
}

/** 回填导出 16 列（= 配对 15 列 + 操作，DESIGN.md 20.1；操作列留空以与界面逐字一致） */
export const BACKFILL_EXPORT_HEADERS = [...PAIR_EXPORT_HEADERS, '操作'];

/** Excel sheet 名清洗（非法字符替换，最长 31 字） */
function sheetNameOf(report) {
  const name = reportShortName(report).replace(/[\\/?*[\]:]/g, '_').trim();
  return (name || '回填').slice(0, 31);
}

/**
 * 组装「回填榜单」工作簿数据（v2.1.5 起与界面同款 16 列，DESIGN.md 20.1）。
 * 每个榜单 1 个 sheet（sheet 名=榜单简称），不再保留原始榜单列/其它 sheet；
 * 「操作」列留空（文件无按钮，表头保留以与界面逐字一致）。
 * @param {object} report
 * @returns {{sheets:Array<object>, suggestedFileName:string}}
 */
export function buildBackfillWorkbook(report) {
  if (!report || typeof report !== 'object') throw new Error('回填失败：榜单数据为空');
  const rows = (Array.isArray(report.rows) ? report.rows : []).map((row) => [...pairRowValues(report, row), '']);
  const columns = BACKFILL_EXPORT_HEADERS.map((header, column) => ({ header, width: pairWidths[column] || 10 }));
  const baseName = textOf(report.fileName) || textOf(report.sheetName) || '榜单';
  return {
    sheets: [{ name: sheetNameOf(report), columns, rows, freeze: true }],
    suggestedFileName: `回填_${baseName}`,
  };
}

/**
 * 组装备份 JSON（DESIGN.md 4 / 9 节：library + session + captures，可换机恢复）。
 * @param {{library:object, session:object, captures:object}} payload
 * @returns {object}
 */
export function buildBackupJson(payload = {}) {
  const library = payload.library || null;
  const session = payload.session || null;
  const captures = payload.captures || {};
  const stores = (library && library.stores) || {};
  const storeCount = Object.keys(stores).length;
  const skuCount = Object.values(stores).reduce((sum, store) => sum + Object.keys((store && store.rows) || {}).length, 0);
  const reports = (session && Array.isArray(session.reports) && session.reports) || [];
  const rowsCount = reports.reduce((sum, report) => sum + (Array.isArray(report.rows) ? report.rows.length : 0), 0);
  const captureCount = Object.keys(captures || {}).length;
  return {
    schema: 'market-share.backup/v1',
    version: 1,
    app: '电商平台市占率数据工作台',
    exportedAt: isoNow(),
    counts: {
      stores: storeCount,
      skus: skuCount,
      reports: reports.length,
      rows: rowsCount,
      captures: captureCount,
    },
    library,
    session,
    captures,
  };
}
