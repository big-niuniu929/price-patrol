// tests/qa/lib/assert.mjs —— 轻量断言（抛 AssertionError，含 actual/expected 摘要）
export class AssertionError extends Error {
  constructor(message, { actual, expected } = {}) {
    super(message);
    this.name = 'AssertionError';
    if (actual !== undefined) this.actual = actual;
    if (expected !== undefined) this.expected = expected;
  }
}

function brief(value) {
  if (typeof value === 'string') return value.length > 300 ? `"${value.slice(0, 300)}…"` : `"${value}"`;
  try {
    const text = JSON.stringify(value);
    return text != null && text.length > 300 ? `${text.slice(0, 300)}…` : String(text);
  } catch { return String(value); }
}

export function ok(cond, message) {
  if (!cond) throw new AssertionError(message);
}

/** 深度相等（JSON 归一化 + 对象键排序），用于数组/对象结构断言。 */
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = stable(value[key]);
    return out;
  }
  return value;
}

export function deepEq(actual, expected, message) {
  const a = JSON.stringify(stable(actual));
  const b = JSON.stringify(stable(expected));
  if (a !== b) {
    throw new AssertionError(`${message}\n  期望：${b.length > 600 ? b.slice(0, 600) + '…' : b}\n  实际：${a.length > 600 ? a.slice(0, 600) + '…' : a}`, { actual, expected });
  }
}

export function eq(actual, expected, message) {
  if (actual !== expected) {
    throw new AssertionError(`${message}（期望 ${brief(expected)}，实际 ${brief(actual)}）`, { actual, expected });
  }
}

export function neq(actual, unexpected, message) {
  if (actual === unexpected) throw new AssertionError(`${message}（不应等于 ${brief(unexpected)}）`);
}

export function close(actual, expected, tolerance, message) {
  if (typeof actual !== 'number' || Number.isNaN(actual) || Math.abs(actual - expected) > tolerance) {
    throw new AssertionError(`${message}（期望 ${expected} ±${tolerance}，实际 ${brief(actual)}）`, { actual, expected });
  }
}

export function ge(actual, min, message) {
  if (!(typeof actual === 'number' && actual >= min)) {
    throw new AssertionError(`${message}（要求 ≥ ${min}，实际 ${brief(actual)}）`);
  }
}

export function le(actual, max, message) {
  if (!(typeof actual === 'number' && actual <= max)) {
    throw new AssertionError(`${message}（要求 ≤ ${max}，实际 ${brief(actual)}）`);
  }
}

export function between(actual, min, max, message) {
  ge(actual, min, message);
  le(actual, max, message);
}

export function includes(haystack, needle, message) {
  let hit = false;
  try {
    if (typeof haystack === 'string') hit = haystack.includes(needle);
    else if (haystack instanceof Set) hit = haystack.has(needle);
    else if (Array.isArray(haystack)) hit = haystack.includes(needle);
    else if (haystack && typeof haystack === 'object') hit = Object.prototype.hasOwnProperty.call(haystack, needle);
  } catch { hit = false; }
  if (!hit) {
    const shown = Array.isArray(haystack) ? haystack.slice(0, 30) : haystack;
    throw new AssertionError(`${message}（未找到 ${brief(needle)}，实际 ${brief(shown)}）`);
  }
}

export function match(value, regex, message) {
  if (typeof value !== 'string' || !regex.test(value)) {
    throw new AssertionError(`${message}（${brief(value)} 不匹配 ${regex}）`);
  }
}

export function isType(value, type, message) {
  const actual = Array.isArray(value) ? 'array' : typeof value;
  if (actual !== type) throw new AssertionError(`${message}（期望 ${type}，实际 ${actual}：${brief(value)}）`);
}

export function isArray(value, message) {
  if (!Array.isArray(value)) throw new AssertionError(`${message}（期望数组，实际 ${brief(value)}）`);
}

export function isObject(value, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AssertionError(`${message}（期望对象，实际 ${brief(value)}）`);
  }
}

/** 在枚举范围内（用于尺寸段/价格段规范值校验）。 */
export function oneOf(value, allowed, message) {
  if (!allowed.includes(value)) {
    throw new AssertionError(`${message}（${brief(value)} 不在枚举 ${brief(allowed.slice(0, 20))} 中）`);
  }
}
