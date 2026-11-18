/**
 * lib/rules.js —— 尺寸段 / 价格段 / 英寸 / 成交金额 解析规则
 *
 * 契约来源：DESIGN.md 第 5 节；脏值样本来自 资料/匹配库.xlsx 实测。
 * 纯函数、零依赖、无副作用：浏览器扩展页与 Node 均可直接 import。
 */

/** 尺寸段规范枚举（顺序即 UI 下拉/统计展示顺序） */
export const SIZE_BANDS = [
  '55英寸',
  '65英寸',
  '75英寸',
  '86/85英寸',
  '98/100英寸',
  '其他尺寸(43英寸)',
  '其他尺寸(110英寸)',
  '其他尺寸(120英寸)',
  '其他尺寸(150英寸)',
  '其他',
];

/** 价格段规范枚举（源表头叫「价格段(17段)」，实际 18 段，按 DESIGN.md 列举为准） */
export const PRICE_BANDS = [
  '1000元以下',
  '1000元至2000元',
  '2000元至2500元',
  '2500元至3000元',
  '3000元至3500元',
  '3500元至4000元',
  '4000元至4500元',
  '4500元至5000元',
  '5000元至5500元',
  '5500元至6000元',
  '6000元至7000元',
  '7000元至8000元',
  '8000元至9000元',
  '9000元至10000元',
  '10000元至15000元',
  '15000元至20000元',
  '20000元至25000元',
  '25000元以上',
];

/** 数据来源枚举（pipeline 会写到 row.source.size / row.source.price） */
export const SOURCES = ['库', '名称推断', '名称解析', '页面采集', '手动'];

/** 行状态枚举（DESIGN.md 4.2 / 7 / 16.4） */
export const STATUS = {
  MATCHED: '已匹配',
  CAPTURED: '已补采',
  PARTIAL: '部分',
  PENDING_CAPTURE: '待采集',
  PENDING_MANUAL: '待补',
  CAPTURE_FAILED: '采集失败',
  /** v2.1：多采样复核发现疑点，等待人工确认（DESIGN.md 16.4） */
  REVIEW_NEEDED: '需确认',
};

/** 状态筛选辅助：UI 建议直接按 size/price/review 字段判断，这里给出等价映射 */
export const STATUS_FILTERS = {
  已补齐: (row) => !!row.size && !!row.price && !(row.review && row.review.needed && !row.review.confirmed),
  待采集: (row) => !row.price && row.status !== STATUS.CAPTURE_FAILED,
  需确认: (row) => !!(row.review && row.review.needed && !row.review.confirmed),
  采集失败: (row) => row.status === STATUS.CAPTURE_FAILED,
  待补: (row) => !row.size && !!row.price,
};

/** 尺寸段同义词（供 UI 输入归一 / 候选提示；键为规范值） */
export const SIZE_SYNONYMS = {
  '55英寸': ['55寸', '55吋', '55'],
  '65英寸': ['65寸', '65吋', '65'],
  '75英寸': ['75寸', '75吋', '75'],
  '86/85英寸': ['85英寸', '86英寸', '85寸', '86寸', '85', '86'],
  '98/100英寸': ['98英寸', '100英寸', '98寸', '100寸', '98', '100'],
  '其他尺寸(43英寸)': ['43英寸', '43寸', '43'],
  '其他尺寸(110英寸)': ['110英寸', '110寸', '110'],
  '其他尺寸(120英寸)': ['120英寸', '120寸', '120'],
  '其他尺寸(150英寸)': ['150英寸', '150寸', '150'],
  其他: ['未识别', '无法识别', '未知', ''],
};

/** 价格段同义词（供 UI 输入归一 / 候选提示；键为规范值） */
export const PRICE_SYNONYMS = (() => {
  const result = {
    '1000元以下': ['1000元以内', '1000以下', '1000以内'],
    '25000元以上': ['25000以上', '25000元及以上', '25000起'],
  };
  for (const def of PRICE_BAND_DEFS_INTERNAL()) {
    if (!Number.isFinite(def.high)) continue;
    const canonical = def.value;
    if (canonical === '1000元以下') continue;
    result[canonical] = [
      `${def.low}元-${def.high}元`,
      `${def.low}元${def.high}元`,
      `${def.low}~${def.high}元`,
      `${def.low}到${def.high}元`,
    ];
  }
  return result;
})();

/** 尺寸段：英寸 → 规范尺寸段（DESIGN.md 5.1） */
const INCH_TO_SIZE_BAND = new Map([
  [43, '其他尺寸(43英寸)'],
  [55, '55英寸'],
  [65, '65英寸'],
  [75, '75英寸'],
  [85, '86/85英寸'],
  [86, '86/85英寸'],
  [98, '98/100英寸'],
  [100, '98/100英寸'],
  [110, '其他尺寸(110英寸)'],
  [120, '其他尺寸(120英寸)'],
  [150, '其他尺寸(150英寸)'],
]);

/** 「数字 + 英寸/英吋/吋/寸」；标题里常见「75英寸」「75吋」「85寸」 */
const INCH_RE = /(\d{2,3}(?:\.\d+)?)\s*(?:英寸|英吋|吋|寸)/g;

/**
 * 全角转半角（含全角括号、全角数字、全角波浪线等），去掉 BOM。
 * 只做字符级转换，不做 trim。
 */
function toHalfWidth(value) {
  return String(value == null ? '' : value)
    .replace(/^\uFEFF/, '')
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, ' ');
}

/** 价格段内部边界定义（金额单位：元；low 含、high 不含/含取决于口径） */
function PRICE_BAND_DEFS_INTERNAL() {
  return [
    { value: '1000元以下', low: 0, high: 1000 },
    { value: '1000元至2000元', low: 1000, high: 2000 },
    { value: '2000元至2500元', low: 2000, high: 2500 },
    { value: '2500元至3000元', low: 2500, high: 3000 },
    { value: '3000元至3500元', low: 3000, high: 3500 },
    { value: '3500元至4000元', low: 3500, high: 4000 },
    { value: '4000元至4500元', low: 4000, high: 4500 },
    { value: '4500元至5000元', low: 4500, high: 5000 },
    { value: '5000元至5500元', low: 5000, high: 5500 },
    { value: '5500元至6000元', low: 5500, high: 6000 },
    { value: '6000元至7000元', low: 6000, high: 7000 },
    { value: '7000元至8000元', low: 7000, high: 8000 },
    { value: '8000元至9000元', low: 8000, high: 9000 },
    { value: '9000元至10000元', low: 9000, high: 10000 },
    { value: '10000元至15000元', low: 10000, high: 15000 },
    { value: '15000元至20000元', low: 15000, high: 20000 },
    { value: '20000元至25000元', low: 20000, high: 25000 },
    { value: '25000元以上', low: 25000, high: Number.POSITIVE_INFINITY },
  ];
}

/** 金额/数值按 2 位小数收敛，避免浮点噪声（如 62.50000000000001） */
function roundAmount(value) {
  return Math.round(value * 100) / 100;
}

/** 从文本里批量抽取数字，识别「万」单位后换算成元 */
function extractNumbersWithWan(text) {
  const numbers = [];
  const re = /(\d+(?:\.\d+)?)(万)?/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    let value = Number(match[1]);
    if (!Number.isFinite(value)) continue;
    if (match[2]) value *= 10000;
    numbers.push(value);
  }
  return numbers;
}

/**
 * 收集文本里的「明确尺寸表达」（v2.2 从 parseSizeFromNameStrict 抽出，供严格 / 尽力而为两种口径复用）。
 * 成对写法（55/65英寸、98/100英寸、86/85英寸）记为一条含两个值的表达，单个写法记为一条单值表达。
 * @param {string} source 已半角化的文本
 * @returns {{expressions:number[][], values:number[]}}
 */
function collectSizeExpressions(source) {
  const expressions = [];
  const consumed = [];
  let match;
  // 1) 成对写法（55/65英寸、98/100英寸、86/85英寸）视为多个尺寸
  const pairRe = /(\d{1,3}(?:\.\d+)?)\s*[/／、\-~～]\s*(\d{1,3}(?:\.\d+)?)\s*(?:英寸|吋|寸)/g;
  while ((match = pairRe.exec(source)) !== null) {
    expressions.push([Number(match[1]), Number(match[2])]);
    consumed.push([match.index, match.index + match[0].length]);
  }
  // 2) 普通「75英寸 / 75寸 / 75吋」写法（跳过已被成对匹配覆盖的位置）
  const singleRe = /(\d{1,3}(?:\.\d+)?)\s*(?:英寸|吋|寸)/g;
  while ((match = singleRe.exec(source)) !== null) {
    const pos = match.index;
    if (consumed.some(([start, end]) => pos >= start && pos < end)) continue;
    expressions.push([Number(match[1])]);
  }
  const values = expressions.flat().filter((value) => Number.isFinite(value) && value > 0);
  return { expressions: expressions, values: values };
}

/**
 * 名称严格尺寸解析（v2.1.6，DESIGN.md 21.2）。
 * 只认「数字+尺寸单位（英寸/吋/寸）」的**明确尺寸表达**，并执行多值必空置：
 * - 名称中 ≥2 个尺寸表达（含 55/65英寸、98/100英寸、86/85英寸、75英寸 86英寸 等）→ 不识别；
 * - 0 个明确表达 → 不猜（型号数字 75MBK7/VH75CAD 绝不当尺寸）；
 * - 恰好 1 个明确表达且为常见尺寸（20~200 英寸）→ 采用对应尺寸段。
 * 注意：v2.2 起市占率「上传榜单标题」改用 parseSizeFromNameBestEffort（多值也采用，标待核对）；
 * 本函数保留其严格语义，供需要「多值必空置」的调用方继续使用。
 * @param {string} name
 * @returns {{size:string, ambiguous:boolean, reason:string, candidates:number[]}}
 *          reason: 'single-size' | 'multiple-size-expressions' | 'no-size-expression' | 'uncommon-size'
 */
export function parseSizeFromNameStrict(name) {
  const source = toHalfWidth(name);
  const result = { size: '', ambiguous: false, reason: '', candidates: [] };
  if (!source) {
    result.ambiguous = true;
    result.reason = 'no-size-expression';
    return result;
  }
  const { expressions, values } = collectSizeExpressions(source);
  result.candidates = values;
  if (!expressions.length) {
    result.ambiguous = true;
    result.reason = 'no-size-expression';
    return result;
  }
  // ≥2 个表达 / 一个表达里出现多值（成对写法）→ 一律空置
  if (expressions.length >= 2 || new Set(values).size >= 2) {
    result.ambiguous = true;
    result.reason = 'multiple-size-expressions';
    return result;
  }
  const inch = values[0];
  if (!(inch >= 20 && inch <= 200)) {
    result.ambiguous = true;
    result.reason = 'uncommon-size';
    return result;
  }
  result.size = sizeBandOf(inch);
  result.reason = 'single-size';
  return result;
}

/**
 * 从 hint（型号 / 规格选择区选中项 / 套餐 / 页面标题）里取 20~200 的候选英寸数字。
 * 例：T65SE → 65、VH75CAD → 75、86/85 → 86、85。
 * @param {string} hint
 * @returns {Set<number>}
 */
function inchNumbersOfHint(hint) {
  const set = new Set();
  const source = toHalfWidth(hint);
  if (!source) return set;
  const re = /\d{2,3}(?:\.\d+)?/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    const value = Number(match[0]);
    if (Number.isFinite(value) && value >= 20 && value <= 200) set.add(value);
  }
  return set;
}

/**
 * 名称「尽力而为」尺寸解析（v2.2：市占率尺寸段规则重定义，DESIGN.md 21.2）。
 * 与 parseSizeFromNameStrict 的唯一差异：名称里出现多个明确尺寸表达时不再直接空置，
 * 而是按「最佳匹配」选一个并标记 ambiguous=true（采用后仍是待人工核对）：
 *   1) 唯一明确尺寸 → 直接采用（ambiguous=false，matchedBy='single'）；
 *   2) 多个明确尺寸 → 优先选与 hint（型号/规格选择区/套餐里的数字，如 T65SE→65、VH75CAD→75）
 *      命中的候选（matchedBy='hint'）；没有命中则取名称里第一个出现的常见尺寸（20~200 英寸，
 *      matchedBy='first'）；ambiguous=true，reason='multiple-size-expressions'；
 *   3) 0 个明确尺寸 → 空置（ambiguous=true，reason='no-size-expression'）；
 *   4) 有尺寸表达但都不在常见范围（20~200 英寸）→ 空置（reason='uncommon-size'）。
 * 采用后调用方仍应把 ambiguous=true 展示为「已优先采用 XX英寸（待核对）」。
 * @param {string} name 上传榜单商品名称 / 页面标题
 * @param {string} [hint] 型号 / 规格选择区选中项 / 套餐等辅助文本
 * @returns {{size:string, ambiguous:boolean, reason:string, candidates:number[], picked:number|null, matchedBy:string}}
 *          matchedBy: 'single' | 'hint' | 'first' | ''
 */
export function parseSizeFromNameBestEffort(name, hint) {
  const result = { size: '', ambiguous: false, reason: '', candidates: [], picked: null, matchedBy: '' };
  const source = toHalfWidth(name);
  if (!source) {
    result.ambiguous = true;
    result.reason = 'no-size-expression';
    return result;
  }
  const { expressions, values } = collectSizeExpressions(source);
  result.candidates = values;
  if (!expressions.length) {
    result.ambiguous = true;
    result.reason = 'no-size-expression';
    return result;
  }
  // 只在常见英寸范围（20~200）里选，型号数字/三围不会被当成尺寸
  const unique = [];
  for (const value of values) {
    if (value < 20 || value > 200) continue;
    if (!unique.includes(value)) unique.push(value);
  }
  if (!unique.length) {
    result.ambiguous = true;
    result.reason = 'uncommon-size';
    return result;
  }
  const hintNumbers = inchNumbersOfHint(hint);
  const hinted = unique.find((value) => hintNumbers.has(value));
  const picked = hinted == null ? unique[0] : hinted;
  result.size = sizeBandOf(picked);
  result.picked = picked;
  if (expressions.length >= 2 || new Set(values).size >= 2) {
    result.ambiguous = true;
    result.reason = 'multiple-size-expressions';
    result.matchedBy = hinted == null ? 'first' : 'hint';
  } else {
    result.ambiguous = false;
    result.reason = 'single-size';
    result.matchedBy = 'single';
  }
  return result;
}

/**
 * 从文本解析所有不重复英寸数（v2.1.5 名称多尺寸判定用；v2.1.6 起 pipeline 改用 parseSizeFromNameStrict）。
 * 兼容「55/65英寸」「75英寸/86英寸」「85寸 ... 100寸」等写法；返回按出现顺序去重的数字数组。
 * @param {string} text
 * @returns {number[]}
 */
export function parseInchValues(text) {
  const source = toHalfWidth(text);
  if (!source) return [];
  const values = [];
  const push = (value) => {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0 && !values.includes(n)) values.push(n);
  };
  // 1) 「98/100英寸」这类斜杠成对写法：两个数字都算命中
  const consumed = [];
  const pairRe = /(\d+(?:\.\d+)?)\s*[/／、-]\s*(\d+(?:\.\d+)?)\s*(?:英寸|吋|寸)/g;
  let match;
  while ((match = pairRe.exec(source)) !== null) {
    push(match[1]);
    push(match[2]);
    consumed.push([match.index, match.index + match[0].length]);
  }
  // 2) 普通「75英寸」写法（跳过已被成对匹配覆盖的位置）
  const singleRe = /(\d+(?:\.\d+)?)\s*(?:英寸|吋|寸)/g;
  while ((match = singleRe.exec(source)) !== null) {
    const pos = match.index;
    if (consumed.some(([start, end]) => pos >= start && pos < end)) continue;
    push(match[1]);
  }
  return values;
}

/**
 * 从商品名/标题/规格文本里解析英寸数。
 * 兼容「75英寸」「75吋」「85寸」；返回第一个命中（带原文片段便于追溯）。
 * @param {string} text
 * @returns {{inch:number, match:string}|null}
 */
export function parseInch(text) {
  const source = toHalfWidth(text);
  if (!source) return null;
  INCH_RE.lastIndex = 0;
  let match;
  while ((match = INCH_RE.exec(source)) !== null) {
    const inch = Number(match[1]);
    if (!Number.isFinite(inch) || inch <= 0) continue;
    return { inch, match: match[0].trim() };
  }
  return null;
}

/**
 * 英寸 → 规范尺寸段；解析不出时给「其他」。
 * @param {number} inch
 * @param {{emptyAs?:string}} [opts]
 */
export function sizeBandOf(inch, opts = {}) {
  const n = Number(inch);
  const emptyAs = opts.emptyAs == null ? '其他' : opts.emptyAs;
  if (!Number.isFinite(n) || n <= 0) return emptyAs;
  const rounded = Math.round(n);
  return INCH_TO_SIZE_BAND.get(rounded) || `其他尺寸(${rounded}英寸)`;
}

/**
 * 从文本解析英寸并转尺寸段；解析不出返回 ''（DESIGN.md 契约）。
 * @param {string} text
 * @returns {string}
 */
export function sizeBandFromText(text) {
  const parsed = parseInch(text);
  return parsed ? sizeBandOf(parsed.inch) : '';
}

/**
 * 尺寸段脏值归一（DESIGN.md 5.1）。
 * 例：其他（50英寸）→ 其他尺寸(50英寸)；其他尺寸(120英寸）→ 其他尺寸(120英寸)；
 *     110英寸 → 其他尺寸(110英寸)；未识别/空 → 其他 / ''。
 * @param {*} raw
 * @returns {{value:string, dirty:boolean}}
 */
export function normalizeSizeBand(raw) {
  const original = raw == null ? '' : String(raw);
  const trimmed = original.trim();
  if (!trimmed) return { value: '', dirty: false };
  const cleaned = toHalfWidth(trimmed)
    .replace(/\s+/g, '')
    .replace(/[【】\[\]「」]/g, '');

  // 1) 本身已是规范值
  if (SIZE_BANDS.includes(cleaned)) {
    return { value: cleaned, dirty: cleaned !== trimmed };
  }

  // 2) 未识别类脏值 → 「其他」
  if (/^(未识别|无法识别|未知|不详|不明|无|none|null|\/|-|—|－)$/i.test(cleaned)) {
    return { value: '其他', dirty: true };
  }

  // 3) 「其他（50英寸）」「其他尺寸(120英寸）」→ 其他尺寸(n英寸)
  let match = cleaned.match(/^其他(?:尺寸)?[(（]?(\d{2,3}(?:\.\d+)?)(?:英寸|寸|吋)?[)）]?$/);
  if (match) {
    const n = Math.round(Number(match[1]));
    return { value: `其他尺寸(${n}英寸)`, dirty: true };
  }

  // 4) 纯数字 / 数字+英寸：55英寸、110英寸、50、100
  match = cleaned.match(/^(\d{2,3}(?:\.\d+)?)(?:英寸|寸|吋)?$/);
  if (match) {
    const value = sizeBandOf(Number(match[1]));
    return { value, dirty: value !== cleaned };
  }

  // 5) 复合数字：86/85英寸、98-100英寸
  match = cleaned.match(/^(\d{2,3})\s*[/、,，\-~～]\s*(\d{2,3})(?:英寸|寸|吋)?$/);
  if (match) {
    const a = Number(match[1]);
    const b = Number(match[2]);
    const hi = Math.max(a, b);
    const lo = Math.min(a, b);
    const value = sizeBandOf(hi);
    return { value, dirty: !(lo === 85 && hi === 86) && value !== cleaned };
  }

  // 6) 数字混排文本（如「100英寸（约）」）：兜底抓英寸
  const parsed = parseInch(cleaned);
  if (parsed) return { value: sizeBandOf(parsed.inch), dirty: true };

  // 7) 完全认不出 → 其他
  return { value: '其他', dirty: true };
}

/**
 * 价格（元）→ 规范价格段。
 * @param {number|string} price 价格，单位元；也可传已是数字的文本（如 "9999"）
 * @param {'rightOpen'|'rightClosed'} [mode] 边界口径，默认 rightOpen：[low, high)
 * @returns {string} 解析不出返回 ''
 */
export function priceBandOf(price, mode = 'rightOpen') {
  if (price === null || price === undefined) return '';
  let n = price;
  if (typeof n === 'string') {
    const parsed = parsePriceText(n);
    n = parsed == null ? Number.NaN : parsed;
  }
  n = Number(n);
  if (!Number.isFinite(n) || n < 0) return '';
  const defs = PRICE_BAND_DEFS_INTERNAL();
  if (mode === 'rightClosed') {
    // (low, high]：整 1000 归「1000元以下」，整 2000 归「1000元至2000元」
    for (const def of defs) {
      if (n > def.low && n <= def.high) return def.value;
    }
    return defs[defs.length - 1].value;
  }
  // rightOpen: [low, high)
  for (const def of defs) {
    if (n >= def.low && n < def.high) return def.value;
  }
  return defs[defs.length - 1].value;
}

/**
 * 价格段脏值归一（DESIGN.md 5.2）。
 * 例：3000元3500元 / 3000元-3500元 → 3000元至3500元；25000以上 → 25000元以上。
 * @param {*} raw
 * @returns {{value:string, dirty:boolean}}
 */
export function normalizePriceBand(raw) {
  const original = raw == null ? '' : String(raw);
  const trimmed = original.trim();
  if (!trimmed) return { value: '', dirty: false };
  const cleaned = toHalfWidth(trimmed).replace(/\s+/g, '').replace(/[【】\[\]「」]/g, '');

  // 1) 本身已是规范值
  if (PRICE_BANDS.includes(cleaned)) {
    return { value: cleaned, dirty: cleaned !== trimmed };
  }

  // 2) 未识别类脏值
  if (/^(未识别|无法识别|未知|不详|不明|无|none|null|\/|-|—|－)$/i.test(cleaned)) {
    return { value: '', dirty: true };
  }

  const numbers = extractNumbersWithWan(cleaned);
  if (!numbers.length) return { value: '', dirty: true };

  // 3) 区间（两个数字，含「3000元3500元」这种缺分隔符的脏值）
  if (numbers.length >= 2) {
    const low = Math.min(numbers[0], numbers[1]);
    const high = Math.max(numbers[0], numbers[1]);
    const exact = PRICE_BAND_DEFS_INTERNAL().find(
      (def) => def.low === low && def.high === high,
    );
    if (exact) return { value: exact.value, dirty: true };
    // 边界不完全匹配（如 3000~3600）→ 按下限落段，保证有值
    return { value: priceBandOf(low), dirty: true };
  }

  // 4) 单数字 + 以下 / 以上
  const n = numbers[0];
  const tail = cleaned.replace(/元$/, '');
  if (/(以下|以内|之下|不到|低于)$/.test(tail)) {
    return { value: priceBandOf(Math.min(n, 1000), 'rightClosed'), dirty: true };
  }
  if (/(以上|起|至少|不低于)$/.test(tail)) {
    return { value: n >= 25000 ? '25000元以上' : priceBandOf(n, 'rightClosed'), dirty: true };
  }
  return { value: priceBandOf(n), dirty: true };
}

/**
 * 从「价格文本」解析数字（单位元）。支持 ￥9999 / 9,999 / 1.2万 / 9999元。
 * @param {*} text
 * @returns {number|null}
 */
export function parsePriceText(text) {
  if (text == null) return null;
  const source = toHalfWidth(text).replace(/[,，\s]/g, '');
  if (!source) return null;
  // 带「万」的写法：1.2万 / 2万
  const wan = source.match(/(\d+(?:\.\d+)?)\s*万/);
  if (wan) {
    const value = Number(wan[1]) * 10000;
    return Number.isFinite(value) ? value : null;
  }
  const match = source.match(/\d+(?:\.\d+)?/);
  if (!match) return null;
  const value = Number(match[0]);
  return Number.isFinite(value) ? value : null;
}

/**
 * 成交金额解析（DESIGN.md 5.3）：取区间两个边界数字的平均值，单位万元。
 * 真实榜单里金额口径是「元 / 万元混排」：
 *   - 带「万」的写法统一先换算成元（￥8,000 ~ ￥1万 → 8000 与 10000 元）；
 *   - 不带「万」且数字 ≥1000 的按「元」理解（￥6,000 ~ ￥8,000 → 0.7 万元）；
 *   - 两个数字都 <1000 且没有「万」时才按「万元」理解（DESIGN 假设的 200~400 写法）。
 * 解析失败返回 null（不抛异常，行上标「金额异常」）。
 * @param {*} raw
 * @returns {number|null}
 */
export function parseAmountRange(raw) {
  if (raw == null) return null;
  const source = toHalfWidth(raw).replace(/[,，\s]/g, '');
  if (!source) return null;
  const numbers = extractNumbersWithWan(source);
  if (!numbers.length) return null;
  const hasWan = /万/.test(source);
  // 带「万」时 numbers 已是「元」；否则判断是否元口径（≥1000 视为元）
  const isYuan = hasWan || numbers.some((value) => value >= 1000);
  if (numbers.length === 1) {
    const value = isYuan ? numbers[0] / 10000 : numbers[0];
    return Number.isFinite(value) ? roundAmount(value) : null;
  }
  const average = (numbers[0] + numbers[1]) / 2;
  const value = isYuan ? average / 10000 : average;
  return Number.isFinite(value) ? roundAmount(value) : null;
}

/** 是否为规范尺寸段 */
export function isSizeBand(value) {
  return SIZE_BANDS.includes(String(value == null ? '' : value).trim());
}

/** 是否为规范价格段 */
export function isPriceBand(value) {
  return PRICE_BANDS.includes(String(value == null ? '' : value).trim());
}

/* ------------------------------------------------------------------ */
/* 品牌补全（DESIGN.md 5.3：本月 3 个榜单没有品牌列，必须能推断出来）      */
/* ------------------------------------------------------------------ */

/** 品牌规范名 → 别名数组（canonical → aliases；别名大小写不敏感） */
export const BRAND_ALIASES = {
  海信: ['海信', 'Hisense'],
  创维: ['创维', 'Skyworth'],
  TCL: ['TCL'],
  品牌B: ['品牌B', 'brandb'],
  海尔: ['海尔', 'Haier'],
  索尼: ['索尼', 'SONY', 'Sony'],
  长虹: ['长虹', 'CHANGHONG'],
  康佳: ['康佳', 'KONKA'],
  皓丽: ['皓丽', 'Horion'],
  联想: ['联想', 'Lenovo', 'lenovo'],
  小米: ['小米', 'MI', 'Xiaomi'],
  品牌A: ['品牌A', 'brandA', 'brandA', 'brandAAI'],
  华为: ['华为', 'HUAWEI', 'Huawei'],
  AOC: ['AOC'],
  JAV: ['JAV'],
  视基: ['视基', 'shiji'],
  鸿合: ['鸿合', 'HiteVision'],
  AOG: ['AOG'],
  互视达: ['互视达', 'HUSHIDA'],
  HOLGK: ['HOLGK'],
  Amdox: ['Amdox'],
  newline: ['newline', 'Newline'],
  企多星: ['企多星'],
  夏新: ['夏新', 'Amoi'],
  三星: ['三星', 'SAMSUNG'],
  LG: ['LG'],
  成者: ['成者', 'CZUR'],
  MALG: ['MALG'],
  视乐星: ['视乐星'],
  亿联网络: ['亿联网络', 'Yealink'],
  飞利浦: ['飞利浦', 'PHILIPS', 'Philips'],
  电商平台方: ['电商平台方', 'BOE'],
  中兴: ['中兴', 'ZTE'],
  御彩: ['御彩', 'YUCAI'],
  王牌: ['王牌'],
  九鼎巨显: ['九鼎巨显'],
  美会通: ['美会通', 'MEETSYS'],
  BOTLA: ['BOTLA'],
  荣事达: ['荣事达', 'Royalstar'],
  勤冠: ['勤冠'],
  HIKVISION: ['HIKVISION', '海康威视'],
  皓丽匠工: ['皓丽匠工'],
  ETUB: ['ETUB'],
  友凡: ['友凡', 'YOUFAN'],
  优享视通: ['优享视通'],
  京州: ['京州'],
  派思达: ['派思达', 'PASTAR'],
  ZWTX: ['ZWTX'],
  CLASSIN: ['CLASSIN', 'Classin'],
  文香: ['文香'],
  擎联: ['擎联'],
  // ↓ 以下为 4 个真实榜单实测补充的品牌词（超出 DESIGN.md 5.3 基础词表，用于继续提升识别率）
  夏普: ['夏普', 'SHARP', 'Sharp'],
  乐视: ['乐视', 'LETV', 'LeTV'],
  'D&Q': ['D&Q', '东启'],
  华三: ['华三', 'H3C'],
  扬子: ['扬子', 'YANGZI'],
  皓森: ['皓森', 'HADMSOON'],
  汇显: ['汇显', 'HUIXIAN', 'Huixian'],
  MISSLIU: ['MISSLIU'],
  立帆: ['立帆', 'LIFAN'],
  维山: ['维山'],
  恒鸿达: ['恒鸿达', 'hengonda', 'HENGONDA'],
  伍贰伍: ['伍贰伍', 'WUERWU', 'WU ER WU'],
  鑫华盟: ['鑫华盟', 'XinHuaMeng'],
  綮东: ['綮东'],
  会参谋: ['会参谋', 'Leaderhub'],
  LGKM: ['LGKM'],
  森克: ['森克', 'SENKE'],
  YOJOY: ['YOJOY'],
  幸沃: ['幸沃'],
  数冠: ['数冠', 'SHUGUAN'],
  科保盾: ['科保盾', 'kebadung'],
  保冠: ['保冠'],
  Skywcrcn: ['Skywcrcn'],
  德天: ['德天'],
  奥德文仪: ['奥德文仪'],
};

/** 品牌列里表示「没有品牌」的占位值，遇到时继续往下推断 */
const EMPTY_BRAND_MARKERS = new Set(['', '其他', '其它', '未知', '未识别', '无', '不详', '暂无', '-', '—', '－', '/', '\\', '其他品牌', '其他品牌/型号', '0']);

/** 品牌归一 key：全角转半角、小写、去空白与常见标点 */
function brandKey(value) {
  return toHalfWidth(value)
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[（）()【】[\]「」《》<>·.,，、/\\|&+~!！?？#$%^&*_\-—－"']/g, '');
}

/** 转义正则特殊字符 */
function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 归一化别名 → canonical 索引（normalizeBrand 精确匹配用） */
const BRAND_KEY_TO_CANONICAL = new Map();
/** 文本里找品牌词用的预编译匹配器（长别名优先） */
const BRAND_TEXT_MATCHERS = [];

for (const [canonical, aliases] of Object.entries(BRAND_ALIASES)) {
  const words = [canonical, ...(Array.isArray(aliases) ? aliases : [])];
  for (const word of words) {
    const text = String(word || '').trim();
    if (!text) continue;
    const key = brandKey(text);
    if (key && !BRAND_KEY_TO_CANONICAL.has(key)) BRAND_KEY_TO_CANONICAL.set(key, canonical);
    // 纯 ASCII 的品牌词要求「词边界」，避免 MI 命中 MiniLED、LG 命中 MALG；
    // 但允许紧跟数字/大写字母（真实商品名里常见 TCL98英寸、品牌BEH86MA、LGOLED48 这种品牌+型号连写）
    const asciiOnly = /^[\x20-\x7E]+$/.test(text) && /[A-Za-z]/.test(text);
    const escaped = escapeRegExp(text);
    const caseless = escaped.replace(/[A-Za-z]/g, (ch) => `[${ch.toLowerCase()}${ch.toUpperCase()}]`);
    const pattern = asciiOnly ? `(?<![A-Za-z0-9])${caseless}(?![a-z])` : escaped;
    try {
      BRAND_TEXT_MATCHERS.push({
        canonical,
        alias: text,
        aliasLength: text.length,
        asciiOnly,
        regex: new RegExp(pattern),
      });
    } catch (error) {
      // 极端环境不支持 lookbehind 时退化为包含匹配
      BRAND_TEXT_MATCHERS.push({
        canonical,
        alias: text,
        aliasLength: text.length,
        asciiOnly,
        regex: new RegExp(escaped, asciiOnly ? 'i' : ''),
      });
    }
  }
}

/**
 * 品牌值归一（DESIGN.md 5.3）：
 *   去括号内容（华为（HUAWEI）→ 华为）、去空白，按别名表大小写不敏感转 canonical；
 *   未命中返回去括号后的原文（清掉多余空格）。
 * @param {*} raw
 * @returns {string}
 */
export function normalizeBrand(raw) {
  const text = raw == null ? '' : String(raw).trim();
  if (!text) return '';
  const withoutBrackets = text.replace(/[（(][^（）()]*[)）]/g, ' ').replace(/\s+/g, ' ').trim();
  const source = withoutBrackets || text;
  const key = brandKey(source);
  if (key && BRAND_KEY_TO_CANONICAL.has(key)) return BRAND_KEY_TO_CANONICAL.get(key);
  return source;
}

/** 判断品牌值是否是「没有品牌」的占位 */
function isEmptyBrand(brand) {
  return EMPTY_BRAND_MARKERS.has(String(brand == null ? '' : brand).trim());
}

/**
 * 在文本（商品名/店铺名）里找品牌词，返回 canonical；最长匹配优先。
 * @param {*} text
 * @returns {string} 找不到返回 ''
 */
export function matchBrandInText(text) {
  const source = text == null ? '' : String(text);
  if (!source) return '';
  let best = null;
  for (const matcher of BRAND_TEXT_MATCHERS) {
    if (matcher.asciiOnly && !/[A-Za-z]/.test(source)) continue;
    if (matcher.regex.test(source)) {
      if (!best || matcher.aliasLength > best.aliasLength) best = matcher;
    }
  }
  return best ? best.canonical : '';
}

/**
 * 品牌推断（DESIGN.md 5.3 优先级）：
 *   1) 榜单品牌列 → 2) 匹配库品牌 → 3) 商品名称 → 4) 店铺名称 → 5) ''。
 * @param {{brandRaw?:string, name?:string, storeName?:string, libraryBrand?:string}} input
 * @returns {string}
 */
export function resolveBrand(input = {}) {
  return resolveBrandDetailed(input).brand;
}

/**
 * 同 resolveBrand，但额外返回来源，供 pipeline 写 row.source.brand。
 * @param {{brandRaw?:string, name?:string, storeName?:string, libraryBrand?:string}} input
 * @returns {{brand:string, source:''|'列'|'库'|'名称'|'店铺'}}
 */
export function resolveBrandDetailed(input = {}) {
  // 1) 榜单品牌列（教育教学一体机文件有这一列，优先）
  const columnBrand = normalizeBrand(input.brandRaw);
  if (columnBrand && !isEmptyBrand(columnBrand)) return { brand: columnBrand, source: '列' };
  // 2) 匹配库同 SKU 品牌
  const libraryBrand = normalizeBrand(input.libraryBrand);
  if (libraryBrand && !isEmptyBrand(libraryBrand)) return { brand: libraryBrand, source: '库' };
  // 3) 商品名称品牌词
  const nameBrand = matchBrandInText(input.name);
  if (nameBrand) return { brand: nameBrand, source: '名称' };
  // 4) 店铺名称品牌词
  const storeBrand = matchBrandInText(input.storeName);
  if (storeBrand) return { brand: storeBrand, source: '店铺' };
  return { brand: '', source: '' };
}

/**
 * 行状态计算（集中在一处，pipeline 复用，UI 也可用于兜底显示）。
 * 优先级：补齐（需确认优先）→ 采集失败 → 只有尺寸段（部分）→ 只有价格段（待补）→ 都缺（待采集）。
 * @param {{size?:string, price?:string, captureFailed?:boolean, review?:object}} row
 * @returns {string}
 */
export function computeRowStatus(row) {
  const size = row && row.size ? row.size : '';
  const price = row && row.price ? row.price : '';
  // v2.1.7：来源细化为「页面采集(到手价/PLUS价/电商平台价)」，按前缀判定页面采集
  const isCaptureSource = (value) => typeof value === 'string' && value.startsWith('页面采集');
  const captured = !!(row && row.source && (isCaptureSource(row.source.size) || isCaptureSource(row.source.price)));
  if (size && price) {
    if (row && row.review && row.review.needed && !row.review.confirmed) return STATUS.REVIEW_NEEDED;
    return captured ? STATUS.CAPTURED : STATUS.MATCHED;
  }
  if (row && row.captureFailed) return STATUS.CAPTURE_FAILED;
  if (size) return STATUS.PARTIAL;
  if (price) return STATUS.PENDING_MANUAL;
  return STATUS.PENDING_CAPTURE;
}

/* ==================================================================== */
/* v2.1：关键字段（型号/套餐）提取 + 多采样复核（DESIGN.md 16.1 / 16.4）   */
/* 注意：采集的是竞品数据，没有阈值/期望值；这里只做一致性核对与提疑，     */
/*       选值永远取样本中位数，绝不向库值或任何期望值靠拢。               */
/* ==================================================================== */

/** 采集模式（settings.capture.mode） */
export const CAPTURE_MODES = ['smart', 'double', 'single'];

/** 复核原因 code → 默认文案（DESIGN.md 16.4） */
export const REVIEW_REASONS = {
  SAMPLES_INCONSISTENT: '多次采样价差超容差',
  SAMPLES_CROSS_BAND: '多次采样落在不同价格段',
  NEAR_BOUNDARY: '价格接近价格段边界',
  OUT_OF_REFERENCE: '价格明显偏离同类参考区间',
  LIB_BAND_MISMATCH: '与匹配库已有价格段不一致',
  WEAK_EVIDENCE: '取价证据弱（候选不足/文本兜底）',
};

/** 参考区间扩展系数：库 p10/p90 → [p10 × 0.3, p90 × 3]（DESIGN.md 16.4） */
export const REFERENCE_EXPAND_LOW = 0.3;
export const REFERENCE_EXPAND_HIGH = 3;

/** 取文本并 trim */
function asText(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

/** 数字收敛到 2 位小数（只用于展示/价差，不参与选值） */
function roundTwo(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

/** 数字转短文本（0.7 万、18 元之类） */
function formatNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '0';
  return Number.isInteger(number) ? String(number) : String(roundTwo(number));
}

/** 读取 settings.capture 的规范值（老 settings 缺字段时补默认） */
function readCaptureConfig(settings) {
  const capture = settings && typeof settings === 'object' && settings.capture ? settings.capture : {};
  const mode = CAPTURE_MODES.includes(capture.mode) ? capture.mode : 'smart';
  const maxSamples = Math.min(5, Math.max(2, Math.round(Number(capture.maxSamples) || 3)));
  const tolerancePct = Number.isFinite(Number(capture.tolerancePct)) ? Number(capture.tolerancePct) : 0.01;
  const toleranceAbs = Number.isFinite(Number(capture.toleranceAbs)) ? Number(capture.toleranceAbs) : 30;
  return { mode, maxSamples, tolerancePct, toleranceAbs };
}

/** 读取 settings.price 的规范值 */
function readPriceConfig(settings) {
  const price = settings && typeof settings === 'object' && settings.price ? settings.price : {};
  return {
    bandBoundary: price.bandBoundary === 'rightClosed' ? 'rightClosed' : 'rightOpen',
    boundaryMarginPct: Number.isFinite(Number(price.boundaryMarginPct)) ? Number(price.boundaryMarginPct) : 0.01,
  };
}

/* ---------------------- 16.1 型号 / 套餐 ---------------------- */

/** 型号黑名单（不当作型号的常见大写缩写） */
const MODEL_BLACKLIST = new Set([
  '4K', '8K', '2K', '1080P', '720P', '2160P', '4G', '5G', '3D', 'HD', 'FHD', 'QHD', 'UHD', 'HDR', 'SDR',
  'USB', 'HDMI', 'TYPEC', 'TYPE-C', 'WIFI', 'WI-FI', 'BT', 'LED', 'LCD', 'IPS', 'VA', 'TN', 'OPS', 'CPU',
  'GPU', 'RAM', 'ROM', 'SSD', 'HDD', 'GEN', 'MI', 'AI', 'PD', 'TF', 'SD', 'AV', 'VGA', 'DP', 'RJ45',
  'POE', 'NFC', 'GPS', 'LTE', 'NR', 'VR', 'AR', 'MR', 'XR', 'PCS', 'APP', 'WEB', 'OS', 'WIN', 'ANDROID',
]);

/** 单位后缀（128G / 60HZ / 4K 这种不是型号） */
const MODEL_UNIT_SUFFIXES = new Set([
  'G', 'GB', 'T', 'TB', 'M', 'MB', 'K', 'KB', 'HZ', 'KHZ', 'W', 'P', 'MP', 'IN', 'INCH', 'INCHES',
  'CM', 'MM', 'KG', 'MAH', 'V', 'A', 'D', 'PCS',
]);

/** ASCII 品牌词集合（识别「品牌+尺寸」连写 token，如 TCL98、JAV100，不当型号） */
let asciiBrandTokensCache = null;
function asciiBrandTokens() {
  if (asciiBrandTokensCache) return asciiBrandTokensCache;
  const tokens = new Set();
  for (const [canonical, aliases] of Object.entries(BRAND_ALIASES)) {
    for (const word of [canonical, ...(Array.isArray(aliases) ? aliases : [])]) {
      const text = asText(word).toUpperCase();
      if (/^[A-Z][A-Z0-9-]*$/.test(text)) tokens.add(text);
    }
  }
  asciiBrandTokensCache = tokens;
  return tokens;
}

/** 是否是「品牌 + 英寸数」连写（TCL98 / JAV100 / 品牌B75） */
function isBrandSizeToken(token) {
  const upper = asText(token).toUpperCase();
  for (const brand of asciiBrandTokens()) {
    if (!upper.startsWith(brand)) continue;
    const rest = upper.slice(brand.length);
    if (/^\d{2,3}$/.test(rest)) return true;
  }
  return false;
}

/** 判断一个 ASCII token 是否像商品型号 */
function isModelToken(token) {
  const text = asText(token);
  if (text.length < 4 || text.length > 24) return false;
  if (!/[A-Za-z]/.test(text) || !/\d/.test(text)) return false;
  const upper = text.toUpperCase();
  if (MODEL_BLACKLIST.has(upper)) return false;
  // 分辨率（1920X1080 / 3840X2160）不是型号
  if (/^\d{3,4}X\d{3,4}[A-Z]?$/.test(upper)) return false;
  // 分辨率前缀 + 尺寸连写（8K75、4K65）也不是型号
  if (/^\d+K\d+$/.test(upper)) return false;
  if (/^IP\d{2,3}$/.test(upper)) return false;
  // 常见接口/系统前缀（HDMI2、USB3.0 之类）
  if (/^(HDMI|USB|DP|RJ|BT|WIFI|TYPE|WIN|ANDROID)/.test(upper)) return false;
  // 纯数字 + 单位后缀（128G、60HZ、4K）
  const suffix = upper.replace(/^\d+/, '');
  if (/^\d+[A-Z]{1,5}$/.test(upper) && MODEL_UNIT_SUFFIXES.has(suffix)) return false;
  if (/^\d+$/.test(upper.replace(/-/g, ''))) return false;
  return true;
}

/** 型号尾部粘连英寸数时去掉（IHE2-86SU86 → IHE2-86SU）：只在带连字符且尾部是 2~3 位数字时处理 */
function trimTrailingInch(token) {
  const match = /^(.*-[A-Za-z0-9]*[A-Za-z])(\d{2,3})$/.exec(token);
  if (match) {
    const candidate = match[1];
    if (isModelToken(candidate) && !isBrandSizeToken(candidate)) return candidate;
  }
  return token;
}

/**
 * 从商品名识别型号（DESIGN.md 16.1）。
 * 优先「型号：xxx」标注；否则找「字母+数字」token（如 MC75HEE、75XW3F、100XP3E、IHE2-86SU、L75MA-SM）。
 * @param {*} name
 * @returns {string} 识别不到返回 ''
 */
export function extractModel(name) {
  const text = name === null || name === undefined ? '' : String(name);
  if (!text) return '';
  // 1) 明确的「型号：xxx」
  const labeled = /型号\s*[:：]\s*([A-Za-z0-9][A-Za-z0-9-]{2,23})/.exec(text);
  if (labeled && isModelToken(labeled[1])) return trimTrailingInch(labeled[1]);
  // 2) 全文扫 ASCII 型号 token（按出现顺序取第一个像型号的；品牌+尺寸连写不算）
  const tokenRe = /(?<![A-Za-z0-9-])[A-Za-z0-9][A-Za-z0-9-]{2,22}[A-Za-z0-9](?![A-Za-z0-9-])/g;
  let match;
  while ((match = tokenRe.exec(text)) !== null) {
    if (isModelToken(match[0]) && !isBrandSizeToken(match[0])) return trimTrailingInch(match[0]);
  }
  return '';
}

/** 套餐标签（套餐/套装/版本：xxx） */
const PACKAGE_LABEL_RE = /(?:套餐|套装|版本)\s*[:：]\s*([^，。；;|\n]{1,40})/;
/** CPU/内存组合：i5/8G/256G、i7/8+256G、R5/16G/512G */
const PACKAGE_CPU_RE = /(?:i[3579]|r[3579])\s*[/／]\s*\d{1,2}\s*(?:GB|G)?\s*(?:[/／]|\+)\s*\d{2,4}\s*(?:GB|TB|G|T)?/i;
/** 内存组合：4+128G、4+64GB、8G+256G、4G+64G */
const PACKAGE_RAM_ROM_RE = /\d{1,3}\s*(?:GB|G)?\s*\+\s*\d{2,4}\s*(?:GB|TB|G|T)?/i;
/** 配件关键词分组：强特征（本身即配件/套装名，命中即算） */
const PACKAGE_STRONG_GROUPS = [
  ['翻页笔', '翻页器'],
  ['投屏器'],
  ['移动推车'],
  ['全向麦', '全向麦克风'],
  ['OPS', '电脑模块'],
  ['智能笔', '触控笔', '白板笔'],
  ['壁挂架'],
];
/** 配件关键词分组：弱特征（产品名里常作功能词，必须出现在 含/带/赠/送/+ 组合语境里才算） */
const PACKAGE_WEAK_GROUPS = [
  ['投屏'],
  ['推车'],
  ['落地支架', '移动支架', '支架'],
  ['麦克风'],
  ['摄像头'],
  ['壁挂'],
];
/** 弱特征前置语境（「含支架」「+投屏」「带摄像头」…） */
const PACKAGE_CONTEXT_RE = /[含带赠加送+＋]/;

/** 套餐文本截断（≤40 字） */
function truncatePackage(text) {
  const value = asText(text);
  return value.length > 40 ? value.slice(0, 40) : value;
}

/** 找出文本里第一个命中的配件词（含位置） */
function findAccessoryWord(text, group, requireContext) {
  let best = null;
  for (const word of group) {
    const index = text.indexOf(word);
    if (index < 0) continue;
    if (requireContext) {
      const before = text.slice(Math.max(0, index - 3), index);
      if (!PACKAGE_CONTEXT_RE.test(before)) continue;
    }
    if (!best || index < best.index) best = { index, word };
    break;
  }
  return best;
}

/**
 * 从商品名识别套餐/配置（DESIGN.md 16.1）。
 * 识别 `4+128G`、`i5/8G/256G`、`翻页笔+投屏+推车`、含/带支架等；无则 ''。
 * 注意：套餐识别不到就留空（不硬凑）；「无线投屏」这种功能词不算套餐。
 * @param {*} name
 * @returns {string} ≤40 字，识别不到返回 ''
 */
export function extractPackage(name) {
  const text = name === null || name === undefined ? '' : String(name).trim();
  if (!text) return '';
  const labeled = PACKAGE_LABEL_RE.exec(text);
  if (labeled) return truncatePackage(labeled[1]);
  const cpu = PACKAGE_CPU_RE.exec(text);
  if (cpu) return truncatePackage(cpu[0].replace(/\s+/g, ''));
  const memory = PACKAGE_RAM_ROM_RE.exec(text);
  if (memory) return truncatePackage(memory[0].replace(/\s+/g, ''));
  // 配件组合：按出现顺序收集，最多 4 个；弱特征必须有套装语境
  const candidates = [];
  for (const group of PACKAGE_STRONG_GROUPS) {
    const hit = findAccessoryWord(text, group, false);
    if (hit) candidates.push(hit);
  }
  for (const group of PACKAGE_WEAK_GROUPS) {
    const hit = findAccessoryWord(text, group, true);
    if (hit) candidates.push(hit);
  }
  candidates.sort((a, b) => a.index - b.index);
  const picked = [];
  let lastEnd = -1;
  for (const candidate of candidates) {
    if (candidate.index <= lastEnd) continue; // 去掉互相重叠的命中（如 移动推车 + 推车）
    picked.push(candidate.word);
    lastEnd = candidate.index + candidate.word.length - 1;
    if (picked.length >= 4) break;
  }
  if (picked.length) return truncatePackage(picked.join('+'));
  return '';
}

/* ---------------------- 16.4 价格段信息 / 采样 ---------------------- */

/**
 * 价格段详细信息（供「接近边界」判断；纯计算，不做任何纠偏）。
 * @param {number|string} price 价格（元）
 * @param {'rightOpen'|'rightClosed'} [mode]
 * @param {{marginPct?:number, marginAbs?:number}} [opts]
 * @returns {{band:string, low:number, high:number, boundaryDistance:number, nearestBoundary:number,
 *            side:'inside'|'below'|'above', nearBoundary:boolean, margin:number}|null}
 */
export function priceBandInfo(price, mode = 'rightOpen', opts = {}) {
  if (price === null || price === undefined) return null;
  let numeric = price;
  if (typeof numeric === 'string') {
    const parsed = parsePriceText(numeric);
    numeric = parsed == null ? Number.NaN : parsed;
  }
  numeric = Number(numeric);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  const defs = PRICE_BAND_DEFS_INTERNAL();
  const closed = mode === 'rightClosed';
  let def = closed
    ? defs.find((item) => numeric > item.low && numeric <= item.high)
    : defs.find((item) => numeric >= item.low && numeric < item.high);
  if (!def) def = numeric <= 0 ? defs[0] : defs[defs.length - 1];
  const boundaries = [];
  if (Number.isFinite(def.low)) boundaries.push(def.low);
  if (Number.isFinite(def.high)) boundaries.push(def.high);
  boundaries.sort((a, b) => Math.abs(numeric - a) - Math.abs(numeric - b));
  const nearestBoundary = boundaries.length ? boundaries[0] : def.low;
  const boundaryDistance = roundTwo(Math.abs(numeric - nearestBoundary));
  let side = 'inside';
  if (numeric > nearestBoundary) side = 'above';
  else if (numeric < nearestBoundary) side = 'below';
  const marginPct = Number(opts.marginPct);
  const marginAbs = Number(opts.marginAbs);
  const margin = Math.max(
    Number.isFinite(marginAbs) ? marginAbs : 10,
    numeric * (Number.isFinite(marginPct) ? marginPct : 0.01),
  );
  return {
    band: def.value,
    low: def.low,
    high: def.high,
    boundaryDistance,
    nearestBoundary,
    side,
    nearBoundary: boundaryDistance <= margin,
    margin: roundTwo(margin),
  };
}

/** 价格段中值（元；最高段按上一段跨度的一半外推）；非规范段返回 null */
export function bandMidpoint(band) {
  const value = asText(band);
  if (!value) return null;
  const defs = PRICE_BAND_DEFS_INTERNAL();
  const def = defs.find((item) => item.value === value);
  if (!def) return null;
  if (!Number.isFinite(def.high)) {
    const previous = defs[defs.length - 2];
    const span = previous && Number.isFinite(previous.high) ? Math.max(1, previous.high - previous.low) : 5000;
    return def.low + span / 2;
  }
  return (def.low + def.high) / 2;
}

/** 样本统一成数字数组（支持 number 或 {price} 记录） */
function samplePrices(samples) {
  const list = Array.isArray(samples) ? samples : [];
  const values = [];
  for (const item of list) {
    let raw = item;
    if (item && typeof item === 'object') {
      raw = item.price != null ? item.price : item.value != null ? item.value : item.p;
    }
    const number = Number(raw);
    if (Number.isFinite(number) && number > 0) values.push(number);
  }
  values.sort((a, b) => a - b);
  return values;
}

/**
 * 多次采样选值（DESIGN.md 16.4）：一致样本取中位数；不一致也取中位数（不向任何期望值靠拢）。
 * 一致判定：spread <= max(toleranceAbs=30, min × tolerancePct=0.01)。
 * @param {Array<number|{price:number}>} samples
 * @param {{toleranceAbs?:number, tolerancePct?:number}} [opts]
 * @returns {{price:number|null, method:'single'|'same'|'median', values:number[], spread:number,
 *            spreadPct:number, consistent:boolean, tolerance:number}}
 */
export function chooseSampleValue(samples, opts = {}) {
  const values = samplePrices(samples);
  const toleranceAbs = Number.isFinite(Number(opts.toleranceAbs)) ? Number(opts.toleranceAbs) : 30;
  const tolerancePct = Number.isFinite(Number(opts.tolerancePct)) ? Number(opts.tolerancePct) : 0.01;
  if (!values.length) {
    return { price: null, method: 'single', values: [], spread: 0, spreadPct: 0, consistent: true, tolerance: toleranceAbs };
  }
  const minPrice = values[0];
  const tolerance = roundTwo(Math.max(toleranceAbs, minPrice * tolerancePct));
  const spread = values.length >= 2 ? roundTwo(values[values.length - 1] - values[0]) : 0;
  const consistent = values.length < 2 ? true : spread <= tolerance;
  let method = 'single';
  if (values.length >= 2) method = values[0] === values[values.length - 1] ? 'same' : 'median';
  let price = values[0];
  if (method === 'median') {
    const middle = Math.floor(values.length / 2);
    price = values.length % 2
      ? values[middle]
      : roundTwo((values[middle - 1] + values[middle]) / 2);
  }
  const spreadPct = price > 0 ? Number((spread / price).toFixed(6)) : 0;
  return { price, method, values, spread, spreadPct, consistent, tolerance };
}

/** 参考区间展开成 [p10×0.3, p90×3]；参数可传 {low,high} 或 {expandedLow,expandedHigh} */
function expandReferenceRange(referenceRange) {
  if (!referenceRange || typeof referenceRange !== 'object') return null;
  const rawLow = Number(referenceRange.low);
  const rawHigh = Number(referenceRange.high);
  const expandedLow = Number(referenceRange.expandedLow);
  const expandedHigh = Number(referenceRange.expandedHigh);
  const low = Number.isFinite(expandedLow) ? expandedLow : rawLow * REFERENCE_EXPAND_LOW;
  const high = Number.isFinite(expandedHigh) ? expandedHigh : rawHigh * REFERENCE_EXPAND_HIGH;
  if (!Number.isFinite(low) || !Number.isFinite(high)) return null;
  return { low: Math.max(0, roundTwo(low)), high: roundTwo(Math.max(low, high)) };
}

/** 「取价证据弱」判断：候选数 <2 / 口径未知 / 文本兜底 */
function weakEvidence(candidateCount, priceKind) {
  const problems = [];
  const count = Number(candidateCount);
  if (Number.isFinite(count) && count < 2) problems.push(`候选项不足（${count} 个）`);
  const kind = asText(priceKind);
  const kindLower = kind.toLowerCase();
  const weakKinds = new Set(['', 'unknown', 'text', 'fallback', 'text-fallback', 'title', 'guess']);
  if (weakKinds.has(kindLower)) {
    problems.push(kind ? `取价口径为「${kind}」（文本兜底）` : '取价口径未知');
  }
  if (!problems.length) return { weak: false, text: '' };
  return { weak: true, text: `取价证据弱（${problems.join('；')}）` };
}

/**
 * 是否还需要再采一次（DESIGN.md 16.4；纯规则、无阈值，不参与选值）。
 * 信号：NEAR_BOUNDARY / OUT_OF_REFERENCE / WEAK_EVIDENCE / 样本价差超容差。
 * @param {{price?:number, priceBand?:string, referenceRange?:object, candidateCount?:number,
 *          priceKind?:string, samples?:Array, settings?:object}} input
 * @returns {{more:boolean, reasons:Array<{code:string,text:string}>, sampleCount:number, maxSamples:number}}
 */
export function shouldResample(input = {}) {
  const capture = readCaptureConfig(input.settings);
  const priceCfg = readPriceConfig(input.settings);
  const samples = Array.isArray(input.samples) ? input.samples : [];
  if (capture.mode === 'single') {
    return { more: false, reasons: [], sampleCount: samples.length, maxSamples: capture.maxSamples };
  }
  const reasons = [];
  const push = (code, text) => {
    if (!reasons.some((item) => item.code === code && item.text === text)) reasons.push({ code, text });
  };
  const price = Number(input.price);
  const validPrice = Number.isFinite(price) && price > 0;
  if (!validPrice) {
    push('WEAK_EVIDENCE', '没有取得有效价格');
  } else {
    const info = priceBandInfo(price, priceCfg.bandBoundary, {
      marginPct: priceCfg.boundaryMarginPct,
      marginAbs: 10,
    });
    if (info && info.nearBoundary) {
      push('NEAR_BOUNDARY', `价格接近价格段边界（距 ${formatNumber(info.boundaryDistance)} 元）`);
    }
    const range = expandReferenceRange(input.referenceRange);
    if (range && (price < range.low || price > range.high)) {
      push('OUT_OF_REFERENCE', `价格超出同类参考区间 ${formatNumber(range.low)}~${formatNumber(range.high)} 元`);
    }
  }
  const weak = weakEvidence(input.candidateCount, input.priceKind);
  if (weak.weak) push('WEAK_EVIDENCE', weak.text);
  const chosen = chooseSampleValue(samples, {
    toleranceAbs: capture.toleranceAbs,
    tolerancePct: capture.tolerancePct,
  });
  if (samples.length >= 2 && !chosen.consistent) {
    push('SAMPLES_INCONSISTENT', `已有 ${samples.length} 次采样价差超容差（差 ${formatNumber(chosen.spread)} 元）`);
  }
  if (capture.mode === 'double' && samples.length < 2) {
    return {
      more: true,
      reasons: reasons.length ? reasons : [{ code: 'WEAK_EVIDENCE', text: 'double 模式要求至少采样 2 次' }],
      sampleCount: samples.length,
      maxSamples: capture.maxSamples,
    };
  }
  return {
    more: samples.length < capture.maxSamples && reasons.length > 0,
    reasons,
    sampleCount: samples.length,
    maxSamples: capture.maxSamples,
  };
}

/**
 * 价格复核判定（DESIGN.md 16.4）：只提疑，不做纠偏/不向期望值靠拢。
 * @param {{price?:number, samples?:Array, priceBand?:string, libraryBand?:string, referenceRange?:object,
 *          priceKind?:string, candidateCount?:number, settings?:object}} input
 * @returns {{needed:boolean, reasons:Array<{code:string,text:string,detail:object}>,
 *            price:number|null, band:string, sampleCount:number, spread:number, consistent:boolean}}
 */
export function evaluatePriceReview(input = {}) {
  const capture = readCaptureConfig(input.settings);
  const priceCfg = readPriceConfig(input.settings);
  const samples = Array.isArray(input.samples) ? input.samples : [];
  const chosen = chooseSampleValue(samples, {
    toleranceAbs: capture.toleranceAbs,
    tolerancePct: capture.tolerancePct,
  });
  let price = Number(input.price);
  if (!Number.isFinite(price) || price <= 0) price = chosen.price;
  const validPrice = Number.isFinite(price) && price > 0;
  const priceBand = asText(input.priceBand) || (validPrice ? priceBandOf(price, priceCfg.bandBoundary) : '');
  const reasons = [];
  const push = (code, text, detail) => {
    if (!reasons.some((item) => item.code === code)) reasons.push({ code, text, detail: detail || {} });
  };
  if (validPrice && chosen.values.length >= 2) {
    if (!chosen.consistent) {
      push('SAMPLES_INCONSISTENT', `多次采样价差超容差（差 ${formatNumber(chosen.spread)} 元）`, {
        samples: chosen.values,
        spread: chosen.spread,
        tolerance: chosen.tolerance,
      });
    }
    const bands = [...new Set(chosen.values.map((value) => priceBandOf(value, priceCfg.bandBoundary)).filter(Boolean))];
    if (bands.length > 1) {
      push('SAMPLES_CROSS_BAND', '多次采样落在不同价格段', { bands });
    }
  }
  if (validPrice) {
    const info = priceBandInfo(price, priceCfg.bandBoundary, {
      marginPct: priceCfg.boundaryMarginPct,
      marginAbs: 10,
    });
    if (info && info.nearBoundary) {
      push('NEAR_BOUNDARY', `价格接近价格段边界（距 ${formatNumber(info.boundaryDistance)} 元）`, {
        band: info.band,
        nearestBoundary: info.nearestBoundary,
        boundaryDistance: info.boundaryDistance,
      });
    }
    const range = expandReferenceRange(input.referenceRange);
    if (range && (price < range.low || price > range.high)) {
      push('OUT_OF_REFERENCE', '价格明显偏离同类参考区间', {
        low: range.low,
        high: range.high,
        count: Number(input.referenceRange && input.referenceRange.count) || 0,
      });
    }
  } else {
    push('WEAK_EVIDENCE', '未取得有效价格', {});
  }
  const libraryBand = asText(input.libraryBand);
  if (libraryBand && priceBand && libraryBand !== priceBand) {
    push('LIB_BAND_MISMATCH', '与匹配库已有价格段不一致', { libraryBand, priceBand });
  }
  const weak = weakEvidence(input.candidateCount, input.priceKind);
  if (weak.weak) {
    push('WEAK_EVIDENCE', weak.text, { candidateCount: input.candidateCount, priceKind: input.priceKind });
  }
  return {
    needed: reasons.length > 0,
    reasons,
    price: validPrice ? price : null,
    band: priceBand,
    sampleCount: samples.length,
    spread: chosen.spread,
    consistent: chosen.consistent,
  };
}
