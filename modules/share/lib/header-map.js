/**
 * lib/header-map.js —— 表头自适应（直接解决旧工具「换个表头就报错」）
 *
 * 契约来源：DESIGN.md 第 6 节。
 * 能力：
 *   - pickDataSheet：遍历工作表，按「表头字段命中 + 非空行数」打分挑数据页，跳过说明页；
 *   - detectHeader：在前 10 行里挑表头行（兼容上方有合并标题行），返回列映射、置信度与诊断信息；
 *   - parseReportSheet：把 sheet 解析成 report 行（raw 保留全部原始列）；
 *   - suggestStoreBinding：按 SKU 重合度 + 文件名关键词推荐匹配库类目；
 *   - normalizeSku：SKU 统一文本化（去尾部 .0、保留前导零、禁止科学计数法）。
 * 纯 ES Module，可在 Node 直接 import。
 */

import { parseAmountRange } from './rules.js';

/** 字段别名表（识别时先精确、再包含、再相似度；越靠前的别名视为越具体） */
export const FIELD_ALIASES = {
  sku: ['sku（商品编码）', 'sku(商品编码)', 'sku id', 'skuid', 'spu id', 'spuid', '商品编号', '商品编码', '商品id', '商品 id', 'sku', '商品sku'],
  name: ['商品名称', '商品标题', '商品名', '产品名称', '标题'],
  brand: ['品牌名称', '品牌名', '品牌'],
  amount: ['成交金额(元)', '成交金额（元）', '成交金额', '成交额', '交易金额', '销售额'],
  store: ['店铺名称', '商家名称', '店铺名', '店铺', '商家'],
  size: ['尺寸段', '屏幕尺寸', '尺寸'],
  price: ['价格段(17段)', '价格段（17段）', '价格段', '价格区间', '价格'],
  // v2.1 关键字段（DESIGN.md 16.1）：型号 / 套餐；「规格」只归套餐，不许抢尺寸/价格列
  model: ['产品型号', '商品型号', '规格型号', '型号'],
  package: ['套餐类型', '套餐', '套装', '版本', '规格'],
  rank: ['排名', '名次'],
  time: ['统计周期', '时间', '周期', '日期'],
};

/** 表头行打分的字段权重（DESIGN.md 6.1：sku+2，name/brand/amount+1，store+1） */
export const FIELD_WEIGHTS = {
  sku: 2,
  name: 1,
  brand: 1,
  amount: 1,
  store: 1,
  size: 0.3,
  price: 0.3,
  model: 0.2,
  package: 0.2,
  rank: 0.2,
  time: 0.2,
};

/** 全部字段的权重和（算置信度用） */
const MAX_HEADER_SCORE = Object.values(FIELD_WEIGHTS).reduce((sum, value) => sum + value, 0);

/** 表头识别的置信度阈值：>= 该值才算命中（模糊相似度达不到不硬塞） */
const MATCH_THRESHOLD = 0.72;

/** 全角转半角 + 去 BOM */
function toHalfWidth(value) {
  return String(value == null ? '' : value)
    .replace(/^\uFEFF/, '')
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, ' ');
}

/** 表头/字段名规范化：小写、去空白、全角括号转半角、去常见标点 */
function normalizeHeaderText(value) {
  return toHalfWidth(value)
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[()（）【】[\]「」《》<>:：,，.。·*_\-—~～/\\|"'`]/g, '');
}

/** 取单元格文本（null → ''，数字 → 字符串） */
function cellText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '';
    return Number.isInteger(value) ? String(value) : String(value);
  }
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return String(value).trim();
}

/** Dice 双字符相似度（0~1），短串退化成长度/前缀比 */
function stringSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) {
    return a[0] === b[0] ? 0.6 : 0;
  }
  const bigrams = new Map();
  for (let i = 0; i < a.length - 1; i += 1) {
    const gram = a.slice(i, i + 2);
    bigrams.set(gram, (bigrams.get(gram) || 0) + 1);
  }
  let overlap = 0;
  for (let i = 0; i < b.length - 1; i += 1) {
    const gram = b.slice(i, i + 2);
    const count = bigrams.get(gram) || 0;
    if (count > 0) {
      overlap += 1;
      bigrams.set(gram, count - 1);
    }
  }
  return (2 * overlap) / (a.length + b.length - 2);
}

/** 判断一个单元格（表头）属于哪个字段；返回 null 表示不像任何字段 */
function classifyHeaderCell(value) {
  const normalized = normalizeHeaderText(value);
  if (!normalized) return null;
  let best = null;
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    for (const alias of aliases) {
      const aliasNormalized = normalizeHeaderText(alias);
      if (!aliasNormalized) continue;
      let confidence = 0;
      if (normalized === aliasNormalized) {
        confidence = 1;
      } else if (normalized.includes(aliasNormalized)) {
        confidence = 0.84;
      } else if (aliasNormalized.includes(normalized)) {
        confidence = 0.78;
      } else {
        const similarity = stringSimilarity(normalized, aliasNormalized);
        if (similarity >= MATCH_THRESHOLD) confidence = 0.5 + (similarity - MATCH_THRESHOLD);
      }
      if (confidence <= 0) continue;
      const candidate = {
        field,
        confidence,
        alias,
        header: String(value == null ? '' : value).trim(),
        // 精确命中时更长的别名更具体（「SKU ID」优于「sku」、「店铺名称」优于「店铺」）
        specificity: aliasNormalized.length,
      };
      if (!best || isBetterHeaderMatch(candidate, best)) best = candidate;
    }
  }
  return best;
}

function isBetterHeaderMatch(candidate, current) {
  if (candidate.confidence !== current.confidence) return candidate.confidence > current.confidence;
  if (candidate.specificity !== current.specificity) return candidate.specificity > current.specificity;
  return candidate.alias.length > current.alias.length;
}

/** 一行里按字段挑最佳列 */
function matchRow(row) {
  const perField = {};
  const matches = [];
  for (let column = 0; column < row.length; column += 1) {
    const match = classifyHeaderCell(row[column]);
    if (!match) continue;
    const item = { ...match, column };
    matches.push(item);
    if (!perField[match.field] || isBetterHeaderMatch(item, perField[match.field])) {
      perField[match.field] = item;
    }
  }
  let score = 0;
  for (const field of Object.keys(perField)) {
    if (perField[field].confidence >= MATCH_THRESHOLD) score += FIELD_WEIGHTS[field] || 0;
  }
  return { perField, matches, score };
}

/** 候选列 → columns 映射（未识别 -1） */
function columnsFromPerField(perField) {
  const columns = {};
  const headerNames = {};
  for (const field of Object.keys(FIELD_ALIASES)) {
    const hit = perField[field];
    columns[field] = hit ? hit.column : -1;
    headerNames[field] = hit ? hit.header : '';
  }
  return { columns, headerNames };
}

/**
 * 同一列被多个字段命中时只保留更可信的字段（v2.1：「规格型号」归型号、不归套餐；
 * 「规格」归套餐，不能抢尺寸/价格列）。原地修改 perField。
 */
function dedupePerField(perField) {
  const claimed = new Map(); // column -> {field, hit}
  const strength = (field) => {
    const hit = perField[field];
    return (hit.confidence || 0) * 10 + (FIELD_WEIGHTS[field] || 0) + (hit.specificity || 0) / 100;
  };
  const fields = Object.keys(perField).sort((a, b) => strength(b) - strength(a));
  for (const field of fields) {
    const hit = perField[field];
    if (!hit) continue;
    if (claimed.has(hit.column)) {
      delete perField[field];
    } else {
      claimed.set(hit.column, field);
    }
  }
}

/**
 * 在前 10 行中识别表头行。
 * @param {Array<Array<string|null>>} rows
 * @param {{headerRow?:number, [field:string]: any}} [overrides] 可选：强制表头行/字段列（值可传列名或列下标）
 * @returns {{headerRow:number, columns:object, headerNames:object, confidence:number, diagnostics:object,
 *            headers:string[], perField:object, matchedFields:string[], score:number}}
 */
export function detectHeader(rows, overrides = {}) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const scanCount = Math.min(10, safeRows.length);
  const candidates = [];
  for (let rowIndex = 0; rowIndex < scanCount; rowIndex += 1) {
    const matched = matchRow(safeRows[rowIndex] || []);
    candidates.push({ row: rowIndex, score: matched.score, perField: matched.perField, matches: matched.matches });
  }

  // 有 SKU 列的候选优先；同分取靠前的行（标题行通常在数据行上方）
  let best = null;
  const withSku = candidates.filter((candidate) => candidate.perField.sku);
  if (withSku.length) {
    best = withSku.reduce((winner, candidate) =>
      candidate.score > winner.score || (candidate.score === winner.score && candidate.row < winner.row)
        ? candidate
        : winner,
    );
  } else if (candidates.length) {
    best = candidates.reduce((winner, candidate) => (candidate.score > winner.score ? candidate : winner), candidates[0]);
  }

  let headerRow = best ? best.row : 0;
  let perField = best ? best.perField : {};
  const warnings = [];

  // 应用 overrides.headerRow（0-based，允许 0）
  if (overrides && Number.isInteger(overrides.headerRow) && overrides.headerRow >= 0 && overrides.headerRow < safeRows.length) {
    if (overrides.headerRow !== headerRow) {
      headerRow = overrides.headerRow;
      perField = matchRow(safeRows[headerRow] || []).perField;
      warnings.push(`已按手动设置使用第 ${headerRow + 1} 行作为表头行`);
    }
  }

  let score = 0;
  for (const field of Object.keys(perField)) {
    if (perField[field].confidence >= MATCH_THRESHOLD) score += FIELD_WEIGHTS[field] || 0;
  }

  // 同一列被多个字段命中时去重（如「规格型号」只归型号）
  dedupePerField(perField);

  const { columns, headerNames } = columnsFromPerField(perField);
  const confidence = Math.min(1, score / 6);
  const headers = (safeRows[headerRow] || []).map((value) => cellText(value));

  const diagnostics = {
    previewRows: safeRows.slice(0, 10).map((row) => (Array.isArray(row) ? row.map((value) => (value == null ? null : cellText(value))) : [])),
    previewColumns: buildPreviewColumns(safeRows),
    headerRowCandidates: candidates.map((candidate) => ({
      row: candidate.row,
      score: Number(candidate.score.toFixed(2)),
      matchedFields: Object.keys(candidate.perField),
    })),
    perField: {},
    warnings,
  };
  for (const field of Object.keys(FIELD_ALIASES)) {
    const hit = perField[field];
    diagnostics.perField[field] = {
      found: !!hit,
      column: hit ? hit.column : -1,
      header: hit ? hit.header : '',
      confidence: hit ? Number(hit.confidence.toFixed(2)) : 0,
      candidates: (best ? best.matches : [])
        .filter((match) => match.field === field)
        .slice(0, 3)
        .map((match) => ({ column: match.column, header: match.header, confidence: Number(match.confidence.toFixed(2)), alias: match.alias })),
    };
  }

  // overrides 里强制指定字段的列（列名或下标）
  const fieldOverrideWarnings = applyFieldOverrides(columns, headerNames, headers, overrides);
  warnings.push(...fieldOverrideWarnings);

  return { headerRow, columns, headerNames, headers, confidence, diagnostics, perField, score, matchedFields: Object.keys(perField) };
}

/** 应用 overrides 的字段列设置（原地修改 columns/headerNames） */
function applyFieldOverrides(columns, headerNames, headers, overrides) {
  const warnings = [];
  if (!overrides) return warnings;
  for (const field of Object.keys(FIELD_ALIASES)) {
    if (overrides[field] === undefined || overrides[field] === null || overrides[field] === '') continue;
    const target = overrides[field];
    let column = -1;
    if (Number.isInteger(target) && target >= 0 && target < headers.length) {
      column = target;
    } else {
      const targetText = cellText(target);
      const normalizedTarget = normalizeHeaderText(targetText);
      const exact = headers.findIndex((header) => header === targetText);
      if (exact >= 0) column = exact;
      else column = headers.findIndex((header) => normalizeHeaderText(header) === normalizedTarget);
      if (column < 0) {
        warnings.push(`手动映射的「${field}」列「${targetText}」在表头里找不到，已按自动识别处理`);
        continue;
      }
    }
    columns[field] = column;
    headerNames[field] = headers[column] || cellText(target);
  }
  return warnings;
}

/** 诊断弹窗用的列字母（A、B、C…） */
function buildPreviewColumns(rows) {
  let maxColumn = 0;
  for (const row of rows.slice(0, 10)) {
    if (Array.isArray(row)) maxColumn = Math.max(maxColumn, row.length);
  }
  const letters = [];
  for (let index = 0; index < maxColumn; index += 1) letters.push(columnLetter(index));
  return letters;
}

/** 0-based 列号 → Excel 列字母 */
function columnLetter(index) {
  let n = index + 1;
  let text = '';
  while (n > 0) {
    const mod = (n - 1) % 26;
    text = String.fromCharCode(65 + mod) + text;
    n = Math.floor((n - 1) / 26);
  }
  return text;
}

/**
 * 挑选数据工作表（DESIGN.md 6.1）。
 * @param {Array<{name:string, rows:Array<Array<string|null>>}>} sheets
 * @returns {{index:number, name:string, reason:string, scores:Array<object>}}
 */
export function pickDataSheet(sheets) {
  const safeSheets = Array.isArray(sheets) ? sheets : [];
  const scores = [];
  for (let index = 0; index < safeSheets.length; index += 1) {
    const sheet = safeSheets[index] || {};
    const rows = Array.isArray(sheet.rows) ? sheet.rows : [];
    const detection = detectHeader(rows);
    const maxColumns = rows.reduce((max, row) => Math.max(max, Array.isArray(row) ? row.length : 0), 0);
    const nonEmptyRows = rows.filter(
      (row) => Array.isArray(row) && row.some((value) => value !== null && value !== undefined && String(value).trim() !== ''),
    ).length;
    const dataRows = Math.max(0, rows.length - detection.headerRow - 1);
    let skipped = false;
    let reason = '';
    if (maxColumns < 3) {
      skipped = true;
      reason = `列数只有 ${maxColumns} 列（<3），疑似说明页，跳过`;
    } else if (detection.columns.sku < 0) {
      skipped = true;
      reason = '未识别到 SKU 列，跳过';
    }
    const headerScore = detection.score;
    const score = skipped ? 0 : Number((headerScore + Math.min(1.5, nonEmptyRows / 400)).toFixed(3));
    const keyFields = detection.matchedFields.filter((field) =>
      ['sku', 'name', 'brand', 'amount', 'store'].includes(field),
    );
    if (!skipped) {
      reason = `命中 ${keyFields.length} 个关键字段（${keyFields.join('、') || '无'}），数据行约 ${dataRows}`;
    }
    scores.push({
      index,
      name: sheet.name || `Sheet${index + 1}`,
      score,
      skipped,
      reason,
      headerRow: detection.headerRow,
      confidence: Number(detection.confidence.toFixed(2)),
      matchedFields: detection.matchedFields,
      rows: rows.length,
      dataRows,
      maxColumns,
    });
  }
  const viable = scores.filter((item) => !item.skipped);
  if (!viable.length) {
    return { index: -1, name: '', reason: '没有找到包含 SKU 列的数据工作表，请用「表头诊断」手动指定', scores };
  }
  const best = viable.reduce((winner, item) => (item.score > winner.score ? item : winner), viable[0]);
  const bestSheet = safeSheets[best.index] || {};
  const detection = detectHeader(Array.isArray(bestSheet.rows) ? bestSheet.rows : []);
  const reason = `已选「${best.name}」：${detection.columns.sku >= 0 ? '识别到 SKU 列' : '未识别到 SKU 列'}，数据行 ${best.dataRows}，表头置信度 ${detection.confidence.toFixed(2)}`;
  return { index: best.index, name: best.name, reason, scores };
}

/**
 * SKU 统一文本化：去首尾空格、去尾部 .0、保留前导零、禁止科学计数法。
 * @param {*} value
 * @returns {string}
 */
export function normalizeSku(value) {
  if (value === null || value === undefined) return '';
  let text;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '';
    if (Number.isInteger(value)) {
      // 极大整数用 toFixed(0) 避免 1e+21 写法（Excel 数字精度本身只有 15 位）
      text = Math.abs(value) >= 1e21 ? value.toFixed(0) : String(value);
    } else {
      text = String(value);
    }
  } else if (typeof value === 'boolean') {
    return '';
  } else {
    text = String(value);
  }
  text = toHalfWidth(text).trim();
  if (!text) return '';
  // 去掉 Excel 文本化遗留：="100" / '100 / "100"
  text = text.replace(/^=\s*"?([^"]*)"?$/, '$1').trim();
  text = text.replace(/^'/, '').trim();
  // 科学计数法 → 展开成普通数字串（仅当看起来是纯数字科学计数法）
  if (/^\d+(?:\.\d+)?[eE][+-]?\d+$/.test(text)) {
    const numeric = Number(text);
    if (Number.isFinite(numeric)) text = Math.abs(numeric) >= 1e21 ? numeric.toFixed(0) : String(Math.trunc(numeric));
  }
  // 去尾部 .0（如 "100200174986.0"）
  text = text.replace(/\.0+$/, '');
  return text;
}

/** 把 raw 行按表头还原成对象；重复/空表头用兜底 key，保证每一列都有值 */
function buildRawKeyByColumn(headers, maxColumn) {
  const keys = [];
  const used = new Map();
  for (let column = 0; column < maxColumn; column += 1) {
    let key = column < headers.length ? headers[column] : '';
    if (!key) key = `列${columnLetter(column)}`;
    const count = (used.get(key) || 0) + 1;
    used.set(key, count);
    keys.push(count > 1 ? `${key}#${count}` : key);
  }
  return keys;
}

/**
 * 解析榜单工作表为 report 行模型。
 * @param {{name:string, rows:Array<Array<string|null>>}} sheet
 * @param {{headerRow?:number, [field:string]: any}} [overrides] 表头诊断保存的列名映射（可只给部分字段）
 * @returns {{sheetName:string, headerRow:number, headerRowNo:number, headers:string[], columns:object,
 *            headerNames:object, confidence:number, rows:Array<object>, diagnostics:object}}
 */
export function parseReportSheet(sheet, overrides = {}) {
  if (!sheet || !Array.isArray(sheet.rows)) {
    throw new Error('解析榜单失败：工作表数据为空或格式不正确');
  }
  const rows = sheet.rows;
  if (!rows.length) throw new Error('解析榜单失败：工作表没有任何数据行');
  const detection = detectHeader(rows, overrides);
  const headerRow = detection.headerRow;
  const headers = (rows[headerRow] || []).map((value) => cellText(value));
  const { columns, headerNames } = detection;

  let maxColumn = headers.length;
  for (const row of rows) {
    if (Array.isArray(row)) maxColumn = Math.max(maxColumn, row.length);
  }
  const rawKeys = buildRawKeyByColumn(headers, maxColumn);

  const parsedRows = [];
  let skippedRows = 0;
  for (let rowIndex = headerRow + 1; rowIndex < rows.length; rowIndex += 1) {
    const row = Array.isArray(rows[rowIndex]) ? rows[rowIndex] : [];
    const read = (field) => {
      const column = columns[field];
      return column >= 0 && column < row.length ? cellText(row[column]) : '';
    };
    const sku = normalizeSku(read('sku'));
    if (!sku) {
      const hasAnyValue = row.some((value) => value !== null && value !== undefined && String(value).trim() !== '');
      if (hasAnyValue) skippedRows += 1;
      continue;
    }
    const raw = {};
    for (let column = 0; column < maxColumn; column += 1) {
      raw[rawKeys[column]] = column < row.length ? row[column] : null;
    }
    const name = read('name');
    const brand = read('brand');
    const amountRaw = read('amount');
    parsedRows.push({
      rowNo: rowIndex + 1,
      raw,
      sku,
      name,
      brand,
      storeName: read('store'),
      model: read('model'),
      package: read('package'),
      amountRaw,
      amount: parseAmountRange(amountRaw),
      sizeRaw: read('size'),
      priceRaw: read('price'),
    });
  }

  const warnings = detection.diagnostics.warnings.slice();
  if (columns.sku < 0) warnings.push('没有识别到 SKU 列：请用「表头诊断」手动指定，否则无法分析');
  if (columns.amount < 0) warnings.push('没有识别到成交金额列：统计里这些行的金额会记为空');
  if (!parsedRows.length) warnings.push('表头下方没有解析到任何带 SKU 的数据行');

  return {
    sheetName: sheet.name || '',
    headerRow,
    headerRowNo: headerRow + 1,
    headers,
    columns,
    headerNames,
    confidence: Number(detection.confidence.toFixed(2)),
    rows: parsedRows,
    diagnostics: {
      ...detection.diagnostics,
      warnings,
      skippedRows,
      sheetColumns: headers,
      previewColumns: detection.diagnostics.previewColumns,
    },
  };
}

/**
 * 推荐榜单 → 匹配库类目绑定（SKU 重合度为主，文件名关键词为辅）。
 * @param {{rows?:Array<{sku:string}>, fileName?:string, name?:string}} report
 * @param {{stores?:object}} library
 * @returns {{store:string, score:number, reasons:string[], candidates:Array<object>}}
 */
export function suggestStoreBinding(report, library) {
  const stores = (library && library.stores) || {};
  const reportRows = (report && Array.isArray(report.rows) && report.rows) || [];
  const reportSkus = new Set(
    reportRows.map((row) => normalizeSku(row && row.sku)).filter((sku) => sku),
  );
  const fileName = String((report && (report.fileName || report.name)) || '');
  const fileNameNormalized = fileName.toLowerCase();
  const storeNames = Object.keys(stores);
  if (!storeNames.length) {
    return { store: '', score: 0, reasons: ['匹配库为空，请先导入匹配库'], candidates: [] };
  }
  if (!reportSkus.size) {
    return { store: '', score: 0, reasons: ['榜单没有解析到 SKU，无法按重合度推荐类目'], candidates: [] };
  }

  const candidates = storeNames.map((storeName) => {
    const store = stores[storeName] || {};
    const storeRows = store.rows || {};
    let overlap = 0;
    for (const sku of reportSkus) {
      if (storeRows[sku]) overlap += 1;
    }
    const reasons = [`SKU 重合 ${overlap}/${reportSkus.size}（${((overlap / reportSkus.size) * 100).toFixed(1)}%）`];
    // 文件名关键词辅助：只用于零重合时的兜底与同分排序，不改变重合度主分数
    const keywords = Array.isArray(store.keywords) && store.keywords.length
      ? store.keywords
      : storeName.split(/[\s、,，/]+/).filter(Boolean);
    const nameHits = [];
    for (const keyword of keywords) {
      const text = String(keyword || '').toLowerCase();
      if (text.length >= 2 && fileNameNormalized.includes(text) && !nameHits.includes(keyword)) {
        nameHits.push(keyword);
      }
    }
    if (nameHits.length) reasons.push(`文件名命中关键词「${nameHits.join('、')}」`);
    const skuRatio = overlap / reportSkus.size;
    const nameScore = Math.min(1, nameHits.length / 2);
    const score = overlap > 0 ? Number(skuRatio.toFixed(4)) : Number((nameScore * 0.2).toFixed(4));
    return {
      store: storeName,
      score,
      overlap,
      reportRows: reportSkus.size,
      nameScore,
      nameHits,
      reasons,
    };
  });

  candidates.sort((a, b) => b.score - a.score || b.nameScore - a.nameScore || b.overlap - a.overlap);
  const best = candidates[0];
  const reasons = best.score > 0 ? best.reasons.slice() : ['没有 SKU 重合，也没有命中文件名词，请手动选择类目'];
  return { store: best.score > 0 ? best.store : '', score: best.score, reasons, candidates: candidates.slice(0, 5) };
}
