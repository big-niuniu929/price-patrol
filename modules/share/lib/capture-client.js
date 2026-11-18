// 电商平台市占率数据工作台 · 批量采集驱动器 v2.1.7（ES Module）
//
// 职责（DESIGN.md 第 8 / 16.4 / 19.3 / 20.8 / 21.2 / 22 节）：
//   · 工作台页驱动一个「后台标签页」复用导航（不弹窗、不抢焦点），逐个打开 item.shop.example.com/{sku}.html；
//   · 接收 content.js 发来的 ITEM_CAPTURE_RESULT，按 sku 匹配（迟到/其它 SKU/其它标签页的消息一律忽略）；
//   · 单条超时 35 秒、按设置重试、随机间隔 intervalMin~intervalMax（默认 5~10s）；
//   · 多采样复核（v2.1）：同一 SKU 采 1~maxSamples 次，取中位数、记价差与一致性；
//     采不采下次由调用方 decideMore 决定（工作台接 lib/rules.shouldResample），不做任何「向阈值靠拢」；
//   · 价格算法（v2.1.7，content.js 移植巡检双轨版）：capture 透传 priceKind/priceKindLabel/priceRect/
//     priceChanges/sourceLabel/candidates（页面候选价，含 font/cls/strike/rect），供 UI 价格类型徽标/调试 JSON；
//   · 尺寸严格识别（v2.1.6，对应 content.js size/sizeUncertain）：只有明确 sizeInch 才写 size；
//     size:null + sizeUncertain=true（标题多值/型号数字/无明确表达）→ capture.sizeInch=null、size 相关字段置空、
//     透传 sizeUncertain/sizeReason，pipeline 不得写 row.size、不得清 sizeAmbiguous；
//   · 落地页异常三分类（v2.1.5，对应 content.js pageKind）：
//       offSale    → 本条标记失败「已下架」，跳过继续下一条（不暂停、不冷却、不算连续失败）；
//       softAnomaly→ 等待 anomalyWaitSec 秒（默认 60，0=立即）后自动继续，等待中可 skipAnomalyWait()/stop()；
//                     连续 ≥anomalyMaxRetry 次（默认 3）升级为冷却暂停并提示换账号/网络；
//       risk       → 自动暂停 + 冷却（cooldownUntil，默认 60 分钟），冷却期内 start() 返回 blocked；
//   · 频控保护（v2.1.4）：每批上限 maxBatch（默认 20，设置范围 5~100）、
//     每 longRestEvery 条随机长休息 longRestMin~longRestMax（默认 8 条/30~60s）；
//   · 暂停 / 继续 / 停止；连续 3 个失败或识别到安全验证 → 自动暂停并提示；账号变化 → 自动暂停；
//   · 支持只采 skus 子集（单条重采）；每个阶段回调进度；
//   · 可注入 fake chromeApi 在 Node 里单测（dev-tools/test_capture_client.mjs）。
//
// 构造参数：new CaptureRunner({ chromeApi, settings, onProgress, onResult, onLog, decideMore, cooldownUntil })
//   chromeApi 传 window.chrome（需要 tabs.create/update/remove/reload + runtime.onMessage）。
//   settings  建议传整个 ds.settings.v1（读 settings.capture.*，缺省时退回扁平 settings.*；
//             选价偏好读 settings.price.prefer，默认 ['hand','main','plus']）。
//   settings.capture.timeoutMs 是测试/调试用的超时覆盖（默认 35000，线上不要改）。
//   decideMore 也可在 start(tasks, opts) 里传（opts 优先）。
//   cooldownUntil：可选，传入上次持久化的冷却截止时间（毫秒时间戳），用于跨页面/跨 runner 保持冷却。
//
// 多采样设置（settings.capture.*）：
//   mode: 'smart' | 'double' | 'single'（默认 smart）
//     · smart ：先采 1 次，是否再采完全由 decideMore 决定（不传 decideMore 时等同 single）；
//     · double：固定采 2 次，两次价差超容差时按 maxSamples 继续补采；
//     · single：只采 1 次（旧行为；即使 decideMore 返回 true 也不再采，用于快速跑量）。
//   maxSamples: 2~5（默认 3，硬上限）
//   tolerancePct: 0.01、toleranceAbs: 30 → 一致判定 spread <= max(toleranceAbs, minPrice × tolerancePct)
//   pauseOnAccountChange: 默认 true
//
// 频控/降频设置（settings.capture.*，v2.1.4/v2.1.5，缺省即保守值）：
//   intervalMin/intervalMax: 任务间随机间隔秒数（默认 5/10；兼容旧 delayMin/delayMax）
//   maxBatch: 每批上限（默认 20，范围 5~100；start 时按当前 settings 截断，summary 返回 queued/truncated/limit）
//   longRestEvery/longRestMin/longRestMax: 每 N 条长休息（默认 8 条 / 30~60 秒；longRestEvery=0 关闭）
//   cooldownMinutes: 触发风控后冷却分钟数（默认 60）
//   anomalyWaitSec: 软异常等待秒数（默认 60，0=不等待立即下一条）
//   anomalyMaxRetry: 连续软异常多少次升级冷却暂停（默认 3）
//
// start(tasks, opts) → Promise<summary>
//   tasks: [{ sku, url?, name?, ...其它字段原样透传到 onResult.task }]
//   opts:  { skus?: string[] 只采这些 SKU（子集重采）, keepTab?: boolean 保留采集标签页,
//            decideMore?: Function 复核决策回调 }
//   decideMore({ task, samples, price, pricePick, result, sampleIndex, mode, maxSamples, candidateCount })
//     → boolean | { more:boolean, reason?:string }（可返回 Promise）
//     · samples = 已完成的成功样本 [{price,kind,at}]；price = 当前样本中位数
//     · 返回 more=true 时会 sleep(700~1300ms) + chrome.tabs.reload 再采一次（sampleIndex 从 1 开始）
//   冷却中调用 start() 直接 resolve `{blocked:true, cooldownUntil, remainingMs, queued:0, truncated:0, ...}`，
//   不会创建标签页、不会发起任何请求。
//   正常跑完 / 调 stop() / 自动暂停后人工 resume 直到结束 → 都会 resolve summary：
//   { done, total, ok, fail, stopped, autoPaused, autoPauseReason, autoPauseCount,
//     resampled, inconsistent, sampleCount, skipped, startedAt, finishedAt, mode, maxSamples,
//     blocked:false, queued, truncated, limit, risk, cooldownUntil,
//     offSaleCount, softAnomalyCount, anomalyWaitSec }
//   其中 autoPaused 表示「本次运行是否发生过自动暂停」（人工 continue 后仍为 true，供 UI 汇总提示）；
//   get state().autoPaused 则表示「当前是否正处于自动暂停」。
//   risk = {reason,url,title,detail,at} 或 null（最近一次命中的风控/风控升级）；
//   cooldownUntil = 毫秒时间戳（0 表示无冷却）；state().waitingUntil = 软异常等待截止时间（0 表示没在等待）。
//
// 事件回调：
//   onProgress({ phase, text, done, total, ok, fail, index, currentSku, consecutiveFails,
//                autoPaused, autoPauseReason, sampleIndex, sampleCount, spread, consistent,
//                risk, cooldownUntil, anomaly, waitingUntil, remainingMs, totalMs })
//     phase: 'start' | 'nav' | 'waiting' | 'sample' | 'result' | 'retry' | 'pause' | 'resume'
//          | 'risk' | 'cooldown' | 'anomaly-wait' | 'auto-pause' | 'stop' | 'done'
//   onResult({ task, attempt, ok, reason, result, pricePick, capture,
//              samples, spread, consistent, sampleCount, price, risk, pageKind })
//     · result = content.js 原始消息（最后一次成功采样的）
//     · capture = 已组装好的采集记录，可直接写进 ds.captures.v1（v2.1 新增 samples/spread/
//       consistent/price/sampleCount/model/package/packageGroup/specGroups/...，旧字段全部保留）
//   onLog(line) = 中文字符串
//
// 注意：本模块不 import 其它 lib 文件（保持可单测、可被 Node 直接加载）；
//      工作台页面用 <script type="module"> 引入即可。
//      扩展目录必须保留在 ~/Desktop/市占率\extension（Edge 以绝对路径加载未打包扩展）。

/** content.js 发回的结果消息类型（与 extension/content.js 保持一致） */
export const RESULT_MESSAGE_TYPE = 'ITEM_CAPTURE_RESULT';

/** 单条采集等待页面结果的上限（毫秒），与 DESIGN.md 第 8 节一致 */
export const DEFAULT_TIMEOUT_MS = 35000;

/** 连续失败多少个就自动暂停，与 DESIGN.md 第 8 节一致 */
export const AUTO_PAUSE_FAILS = 3;

/** 多采样默认参数（DESIGN.md 16.4） */
export const DEFAULT_MAX_SAMPLES = 3;
export const DEFAULT_TOLERANCE_ABS = 30;
export const DEFAULT_TOLERANCE_PCT = 0.01;

/** 频控保护默认参数（DESIGN.md 19.3，保守值） */
export const DEFAULT_INTERVAL_MIN = 5;
export const DEFAULT_INTERVAL_MAX = 10;
export const DEFAULT_MAX_BATCH = 20;
export const DEFAULT_MAX_BATCH_MIN = 5;
export const DEFAULT_MAX_BATCH_MAX = 100;
export const DEFAULT_COOLDOWN_MINUTES = 60;
export const DEFAULT_LONG_REST_EVERY = 8;
export const DEFAULT_LONG_REST_MIN = 30;
export const DEFAULT_LONG_REST_MAX = 60;

/** 异常自动继续默认参数（DESIGN.md 20.8） */
export const DEFAULT_ANOMALY_WAIT_SEC = 60;
export const DEFAULT_ANOMALY_MAX_RETRY = 3;

/** 两次采样之间的随机等待区间（毫秒）：刷新页面之前先停一下，避免连续请求 */
const SAMPLE_DELAY_MIN_MS = 700;
const SAMPLE_DELAY_MAX_MS = 1300;

/** 默认价格优先级：到手价 → 电商平台价 → PLUS 价 */
const DEFAULT_PREFER = ['hand', 'main', 'plus'];

/** 价格口径中文名（与 content.js priceKindLabel 一致，供 capture 记录展示） */
const PRICE_KIND_LABELS = { hand: '到手价', plus: 'PLUS价', main: '电商平台价' };

const sleep = (ms) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

function noop() {}

function errText(err) {
  if (!err) return '未知错误';
  if (typeof err === 'string') return err;
  return err.message || String(err);
}

function numberOr(value, fallback) {
  const n = Number(value);
  return isFinite(n) ? n : fallback;
}

function clampInt(value, min, max, fallback) {
  const n = Math.round(numberOr(value, fallback));
  if (!isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function randInt(min, max) {
  const lo = Math.ceil(numberOr(min, 0));
  const hi = Math.ceil(numberOr(max, lo));
  if (hi <= lo) return Math.max(0, lo);
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}

/** 生成商品页 URL（只读页面，不带任何参数，不影响账号状态） */
export function itemUrl(sku) {
  return 'https://item.shop.example.com/' + String(sku == null ? '' : sku).trim() + '.html';
}

function isPlausiblePrice(price) {
  const n = Number(price);
  return isFinite(n) && n > 0;
}

/**
 * 按偏好口径挑一个价格：hand → main → plus（可用 settings.price.prefer 覆盖）。
 * 页面所有结构化口径都不合理时，退回原始候选里第一个合理的（与巡检 v1.1 一致）。
 */
export function pickPriceByPrefer(result, prefer) {
  const r = result || {};
  const order = Array.isArray(prefer) && prefer.length ? prefer : DEFAULT_PREFER;
  for (const key of order) {
    const c = r[key];
    if (c && isPlausiblePrice(c.price)) return { price: Number(c.price), kind: c.kind || key };
  }
  if (r.pricePick && isPlausiblePrice(r.pricePick.price)) {
    return { price: Number(r.pricePick.price), kind: r.pricePick.kind || 'unknown' };
  }
  const cands = (Array.isArray(r.candidates) ? r.candidates : []).filter(
    (c) => c && !c.suspect && isPlausiblePrice(c.price)
  );
  if (cands.length) return { price: Number(cands[0].price), kind: cands[0].kind || 'unknown' };
  return null;
}

/**
 * 多采样取值（DESIGN.md 16.4）：
 *   · 一致样本取中位数（偶数取中间均值）；不一致也取中位数，但 consistent=false（交人工确认）；
 *   · 一致判定：spread <= max(toleranceAbs, minPrice × tolerancePct)；
 *   · **绝不向参考区间/期望值靠拢**（竞品数据没有阈值）。
 *
 * @param {Array<{price:number, kind?:string, at?:string}>} samples
 * @param {{toleranceAbs?:number, tolerancePct?:number}} [opts]
 * @returns {{price:number|null, kind:string, method:'single'|'same'|'median'|'none',
 *            values:number[], spread:number, spreadPct:number, consistent:boolean,
 *            tolerance:number, sampleCount:number, min:number|null, max:number|null, median:number|null}}
 */
export function chooseSamples(samples, opts) {
  const options = opts || {};
  const toleranceAbs = Math.max(0, numberOr(options.toleranceAbs, DEFAULT_TOLERANCE_ABS));
  const tolerancePct = Math.max(0, numberOr(options.tolerancePct, DEFAULT_TOLERANCE_PCT));
  const list = (Array.isArray(samples) ? samples : [])
    .filter((s) => s && isPlausiblePrice(s.price))
    .map((s) => ({ price: round2(s.price), kind: s.kind || 'unknown', at: s.at || '' }));
  if (!list.length) {
    return {
      price: null,
      kind: '',
      method: 'none',
      values: [],
      spread: 0,
      spreadPct: 0,
      consistent: true,
      tolerance: toleranceAbs,
      sampleCount: 0,
      min: null,
      max: null,
      median: null
    };
  }
  const values = list.map((s) => s.price);
  const sorted = values.slice().sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const spread = round2(max - min);
  const median =
    sorted.length % 2
      ? round2(sorted[(sorted.length - 1) / 2])
      : round2((sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2);
  const tolerance = Math.max(toleranceAbs, round2(min * tolerancePct));
  const consistent = spread <= tolerance;
  const method = list.length === 1 ? 'single' : spread === 0 ? 'same' : 'median';
  // 选中样本的口径：优先找价格 == 中位数的样本，否则找最接近的
  let chosen = list.find((s) => Math.abs(s.price - median) < 0.005);
  if (!chosen) {
    chosen = list.reduce(
      (best, s) => (Math.abs(s.price - median) < Math.abs(best.price - median) ? s : best),
      list[0]
    );
  }
  return {
    price: median,
    kind: chosen.kind || 'unknown',
    method: method,
    values: values,
    spread: spread,
    spreadPct: min > 0 ? Math.round((spread / min) * 10000) / 10000 : 0,
    consistent: consistent,
    tolerance: tolerance,
    sampleCount: list.length,
    min: min,
    max: max,
    median: median
  };
}

function sampleFromResult(result, prefer) {
  if (!result || !result.ok) return null;
  const pick = pickPriceByPrefer(result, prefer);
  if (!pick) return null;
  return { price: round2(pick.price), kind: pick.kind, at: result.at || new Date().toISOString() };
}

/**
 * 把 content.js 的原始消息组装成采集记录（可直接写进 ds.captures.v1）。
 * v2.1 新增：samples/spread/consistent/price/sampleCount/candidateCount/model/package 等；
 * v2.1.3 新增：packageGroup/specGroups（商品页规格选择区解析结果，原样透传）；
 * v2.1.6 新增：sizeUncertain/sizeReason（尺寸未识别→待人工，sizeInch 保持 null，不写/不清 row.size；
 *   只有明确 sizeInch 才写 size；sizeSource 仅记录来源 spec/title/alt/doc-title/variant）；
 * v2.1.7 新增：priceKindLabel/priceRect/priceChanges/sourceLabel（移植巡检双轨价格算法的调试/展示字段，
 *   candidates 保留页面候选价（前 20，含 price/kind/text/cls/font/strike/rect），供行详情/调试复制）；
 * 不传 opts.samples 时按「单次采样」输出（samples 一条、spread 0、consistent true），老调用保持兼容。
 */
export function buildCaptureRecord(result, opts) {
  const r = result || {};
  const options = opts || {};
  const task = options.task || {};
  const size = r.size || {};
  const prefer = options.prefer;
  const at = r.at || new Date().toISOString();
  const okFlag = !!r.ok && !!pickPriceByPrefer(r, prefer);

  // 采样明细：调用方传了就用（多采样）；否则由本次结果合成一条（老行为）
  let samples = [];
  if (Array.isArray(options.samples)) {
    samples = options.samples.filter((s) => s && isPlausiblePrice(s.price)).map((s) => ({
      price: round2(s.price),
      kind: s.kind || 'unknown',
      at: s.at || at
    }));
  } else if (okFlag) {
    const single = sampleFromResult(r, prefer);
    if (single) samples = [single];
  }
  const sampleStat = chooseSamples(samples, {
    toleranceAbs: options.toleranceAbs,
    tolerancePct: options.tolerancePct
  });
  const pick = okFlag ? pickPriceByPrefer(r, prefer) : null;

  const record = {
    sku: String(r.sku || task.sku || ''),
    at: at,
    account: (r.account && r.account.nickname) || '',
    url: r.url || task.url || '',
    title: r.title || '',
    sizeInch: size.inch != null ? size.inch : null,
    sizeText: size.inch != null ? size.text || '' : '',
    sizeSource: size.inch != null ? size.source || '' : '',
    // v2.1.6：尺寸未识别（标题多值/型号数字/无明确表达）→ 置空待人工；sizeInch 为 null 时不写 size
    sizeUncertain: !!(r.sizeUncertain || size.sizeUncertain),
    sizeReason: r.sizeReason || size.reason || '',
    brand: r.brand || '',
    model: r.model || '',
    modelSource: r.modelSource || '',
    package: r.package || '',
    packageSource: r.packageSource || '',
    // v2.1.3：商品页规格选择区（系列品/屏幕尺寸/版本/…）的解析结果，原样透传给 UI/applyCaptures
    packageGroup: r.packageGroup || '',
    specGroups: Array.isArray(r.specGroups) ? r.specGroups.slice(0, 20) : [],
    prices: {
      hand: r.hand && isFinite(r.hand.price) ? Number(r.hand.price) : null,
      main: r.main && isFinite(r.main.price) ? Number(r.main.price) : null,
      plus: r.plus && isFinite(r.plus.price) ? Number(r.plus.price) : null
    },
    priceKind: pick ? pick.kind : '',
    priceKindLabel: r.priceKindLabel || PRICE_KIND_LABELS[pick && pick.kind] || '',
    // v2.1.7：价格元素位置（供 UI/AI 裁剪价格块）与页面价格刷新记录
    priceRect: r.priceRect || (r.pricePick && r.pricePick.rect) || null,
    priceChanges: Array.isArray(r.priceChanges) ? r.priceChanges.slice(0, 10) : [],
    sourceLabel: r.sourceLabel || (r.pricePick && r.pricePick.source) || '',
    price: sampleStat.price != null ? sampleStat.price : pick ? round2(pick.price) : null,
    samples: samples,
    spread: sampleStat.spread,
    consistent: sampleStat.consistent,
    sampleCount: sampleStat.sampleCount,
    candidateCount:
      typeof r.candidateCount === 'number'
        ? r.candidateCount
        : (Array.isArray(r.candidates) ? r.candidates : []).filter((c) => c && !c.suspect).length,
    textFallback: !!r.textFallback,
    candidates: Array.isArray(r.candidates) ? r.candidates.slice(0, 20) : [],
    flags: r.flags || null,
    fail: okFlag ? null : { reason: r.reason || '采集失败（未取到可靠价格）', at: at }
  };

  // 多采样选值：把中位数写回对应口径（旧字段 prices/priceKind 保持可用）
  if (okFlag && sampleStat.price != null) {
    record.price = sampleStat.price;
    record.priceKind = sampleStat.kind;
    if (record.priceKind) record.prices[record.priceKind] = sampleStat.price;
  }
  return record;
}

export class CaptureRunner {
  /**
   * @param {object} options
   * @param {object} options.chromeApi 传 window.chrome
   * @param {object} [options.settings] 整个 ds.settings.v1（或 settings.capture）
   * @param {Function} [options.onProgress]
   * @param {Function} [options.onResult]
   * @param {Function} [options.onLog]
   * @param {Function} [options.decideMore] 复核决策回调（也可在 start 的 opts 里传）
   */
  constructor(options) {
    const opts = options || {};
    if (!opts.chromeApi || !opts.chromeApi.tabs) {
      throw new Error('CaptureRunner 需要可用的 chromeApi（缺少 chrome.tabs，请在插件页面内使用）');
    }
    this._chrome = opts.chromeApi;
    this._settings = opts.settings || {};
    this._onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : noop;
    this._onResult = typeof opts.onResult === 'function' ? opts.onResult : noop;
    this._onLog = typeof opts.onLog === 'function' ? opts.onLog : noop;
    this._decideMoreDefault = typeof opts.decideMore === 'function' ? opts.decideMore : null;

    // settings 既支持传整个 ds.settings.v1，也支持直接传 settings.capture
    const settings = this._settings;
    const capture = (settings && settings.capture) || settings || {};
    const price = (settings && settings.price) || {};
    const modeRaw = String(capture.mode || 'smart').toLowerCase();
    const mode = modeRaw === 'double' || modeRaw === 'single' ? modeRaw : 'smart';
    this._cfg = {
      retries: clampInt(capture.retries, 0, 5, 1),
      keepTab: capture.keepTab === true,
      timeoutMs: Math.max(100, numberOr(capture.timeoutMs, DEFAULT_TIMEOUT_MS)),
      autoPauseFails: clampInt(capture.autoPauseFails, 1, 10, AUTO_PAUSE_FAILS),
      retryDelayMs: Math.max(0, numberOr(capture.retryDelayMs, 800)),
      prefer: Array.isArray(price.prefer) && price.prefer.length ? price.prefer.slice() : DEFAULT_PREFER.slice(),
      // ---- v2.1 多采样设置 ----
      mode: mode,
      maxSamples: clampInt(capture.maxSamples, 2, 5, DEFAULT_MAX_SAMPLES),
      toleranceAbs: Math.max(0, numberOr(capture.toleranceAbs, DEFAULT_TOLERANCE_ABS)),
      tolerancePct: Math.max(0, numberOr(capture.tolerancePct, DEFAULT_TOLERANCE_PCT)),
      pauseOnAccountChange: capture.pauseOnAccountChange !== false,
      sampleDelayMinMs: Math.max(0, numberOr(capture.sampleDelayMinMs, SAMPLE_DELAY_MIN_MS)),
      sampleDelayMaxMs: Math.max(0, numberOr(capture.sampleDelayMaxMs, SAMPLE_DELAY_MAX_MS)),
      // ---- v2.1.4 频控保护（全部可在 settings.capture 覆盖；兼容旧 delayMin/delayMax）----
      intervalMin: Math.max(0, numberOr(capture.intervalMin, numberOr(capture.delayMin, DEFAULT_INTERVAL_MIN))),
      intervalMax: Math.max(0, numberOr(capture.intervalMax, numberOr(capture.delayMax, DEFAULT_INTERVAL_MAX))),
      // v2.1.5：批量上限以当前 settings 为准（默认 20，设置范围 5~100，不写死）
      maxBatch: clampInt(
        capture.maxBatch,
        DEFAULT_MAX_BATCH_MIN,
        DEFAULT_MAX_BATCH_MAX,
        DEFAULT_MAX_BATCH
      ),
      cooldownMinutes: Math.max(1, numberOr(capture.cooldownMinutes, DEFAULT_COOLDOWN_MINUTES)),
      longRestEvery: clampInt(capture.longRestEvery, 0, 100, DEFAULT_LONG_REST_EVERY),
      longRestMin: Math.max(0, numberOr(capture.longRestMin, DEFAULT_LONG_REST_MIN)),
      longRestMax: Math.max(0, numberOr(capture.longRestMax, DEFAULT_LONG_REST_MAX)),
      // ---- v2.1.5 异常自动继续（DESIGN 20.8）----
      anomalyWaitSec: Math.max(0, numberOr(capture.anomalyWaitSec, DEFAULT_ANOMALY_WAIT_SEC)),
      anomalyMaxRetry: clampInt(capture.anomalyMaxRetry, 1, 10, DEFAULT_ANOMALY_MAX_RETRY)
    };
    if (this._cfg.intervalMax < this._cfg.intervalMin) this._cfg.intervalMax = this._cfg.intervalMin;
    if (this._cfg.longRestMax < this._cfg.longRestMin) this._cfg.longRestMax = this._cfg.longRestMin;

    // 运行态
    this._running = false;
    this._paused = false;
    this._stopped = false;
    this._autoPaused = false;
    this._autoPauseReason = '';
    // 本次运行是否发生过「自动暂停」以及次数（即使人工继续后也保留，便于 UI 结束时汇总提示）
    this._everAutoPaused = false;
    this._autoPauseCount = 0;
    this._tasks = [];
    this._index = -1;
    this._done = 0;
    this._ok = 0;
    this._fail = 0;
    this._consecutiveFails = 0;
    this._currentSku = '';
    this._lastAttempt = 1;
    this._createdTabs = [];
    this._tabId = null;
    this._waiting = null;
    this._earlyResult = null;
    this._listener = null;
    this._startedAt = null;
    this._finishedAt = null;
    this._summary = null;
    // 采样/账号相关
    this._runDecideMore = null;
    this._accountLabel = '';
    this._resampled = 0;
    this._inconsistent = 0;
    this._totalSamples = 0;
    this._queued = 0;
    this._truncated = 0;
    // v2.1.4 频控保护：最近一次风控信息 + 冷却截止时间（毫秒时间戳，0=无冷却）
    this._risk = null;
    this._cooldownUntil = Math.max(0, Number(opts.cooldownUntil) || 0);
    // v2.1.5 异常自动继续：软异常信息 / 连续次数 / 等待截止时间 / 计数
    this._anomaly = null;
    this._anomalyStreak = 0;
    this._waitingUntil = 0;
    this._offSaleCount = 0;
    this._softAnomalyCount = 0;
    this._anomalyWait = null;
    this._skipAnomalyRequested = false;
  }

  get running() {
    return this._running;
  }

  get paused() {
    return this._paused;
  }

  /** 冷却截止时间（毫秒时间戳；0 表示当前没有冷却） */
  get cooldownUntil() {
    return this._cooldownUntil;
  }

  /** 最近一次风控信息 {reason,url,title,detail,at} 或 null */
  get risk() {
    return this._risk;
  }

  /** 软异常等待截止时间（毫秒时间戳；0 表示当前没在等待） */
  get waitingUntil() {
    return this._waitingUntil;
  }

  /** 最近一次软异常信息 {reason,detail,url,title,at} 或 null */
  get anomaly() {
    return this._anomaly;
  }

  /**
   * 软异常等待中：立即跳过剩余等待，继续下一条（UI「立即继续」按钮）。
   * @returns {boolean} 是否确实处于等待中
   */
  skipAnomalyWait() {
    if (!this._anomalyWait) return false;
    this._skipAnomalyRequested = true;
    this._log('已跳过异常等待，立即继续');
    this._progress('waiting', '已跳过异常等待，立即继续', {
      anomaly: this._anomaly,
      waitingUntil: this._waitingUntil,
      remainingMs: 0,
      totalMs: this._anomalyWait.totalMs || 0
    });
    const waiting = this._anomalyWait;
    this._anomalyWait = null;
    try {
      waiting.resolve();
    } catch (e) {
      // 忽略
    }
    return true;
  }

  /**
   * 是否允许开始采集（冷却期内返回 blocked）。
   * @returns {{ok:boolean, blocked:boolean, cooldownUntil:number, remainingMs:number}}
   */
  canStart() {
    const now = Date.now();
    if (this._cooldownUntil && now < this._cooldownUntil) {
      return {
        ok: false,
        blocked: true,
        cooldownUntil: this._cooldownUntil,
        remainingMs: this._cooldownUntil - now
      };
    }
    return { ok: true, blocked: false, cooldownUntil: 0, remainingMs: 0 };
  }

  /** 当前进度的只读快照（UI 用来切按钮态/显示计数） */
  get state() {
    return {
      running: this._running,
      paused: this._paused,
      stopped: this._stopped,
      autoPaused: this._autoPaused,
      autoPauseReason: this._autoPauseReason,
      autoPauseCount: this._autoPauseCount,
      total: this._tasks.length,
      index: this._index,
      done: this._done,
      ok: this._ok,
      fail: this._fail,
      consecutiveFails: this._consecutiveFails,
      currentSku: this._currentSku,
      tabId: this._tabId,
      mode: this._cfg.mode,
      maxSamples: this._cfg.maxSamples,
      resampled: this._resampled,
      inconsistent: this._inconsistent,
      sampleCount: this._totalSamples,
      risk: this._risk,
      cooldownUntil: this._cooldownUntil,
      anomaly: this._anomaly,
      anomalyStreak: this._anomalyStreak,
      waitingUntil: this._waitingUntil,
      offSaleCount: this._offSaleCount,
      softAnomalyCount: this._softAnomalyCount,
      queued: this._queued,
      truncated: this._truncated,
      startedAt: this._startedAt,
      finishedAt: this._finishedAt
    };
  }

  /**
   * 开始采集。已在运行时 reject（中文原因）；冷却期内直接 resolve blocked 结果（不创建标签页）。
   * @param {Array<{sku:string,url?:string,name?:string}>} tasks
   * @param {{skus?:string[], keepTab?:boolean, decideMore?:Function}} [opts]
   */
  async start(tasks, opts) {
    if (this._running) throw new Error('已有采集任务在进行中，请先等待结束或点击停止');
    const options = opts || {};
    // 频控冷却：冷却期内禁止开始采集（不创建标签页、不发起任何请求）
    const gate = this.canStart();
    if (!gate.ok) {
      const untilText = this._formatTime(this._cooldownUntil);
      const lastReason =
        this._risk && this._risk.reason === 'anomaly'
          ? '连续页面异常'
          : this._risk && this._risk.reason
            ? this._riskText(this._risk.reason)
            : '未知';
      this._log(
        '冷却中：' +
          untilText +
          ' 前不允许开始采集（上次触发：' +
          lastReason +
          '）。建议停 24 小时、换账号或换网络后再试。'
      );
      this._progress('cooldown', '冷却中：' + untilText + ' 前不允许开始采集', {
        cooldownUntil: this._cooldownUntil,
        risk: this._risk
      });
      return {
        blocked: true,
        cooldownUntil: this._cooldownUntil,
        remainingMs: gate.remainingMs,
        queued: 0,
        truncated: 0,
        limit: this._cfg.maxBatch,
        done: 0,
        total: 0,
        ok: 0,
        fail: 0,
        stopped: false,
        autoPaused: false,
        autoPauseReason: this._autoPauseReason,
        autoPauseCount: this._autoPauseCount,
        resampled: 0,
        inconsistent: 0,
        sampleCount: 0,
        skipped: 0,
        risk: this._risk,
        anomaly: null,
        waitingUntil: 0,
        offSaleCount: 0,
        softAnomalyCount: 0,
        anomalyWaitSec: this._cfg.anomalyWaitSec,
        mode: this._cfg.mode,
        maxSamples: this._cfg.maxSamples,
        startedAt: '',
        finishedAt: ''
      };
    }
    // 冷却已过期：清掉旧 risk 标记，开始新一轮
    if (this._cooldownUntil && Date.now() >= this._cooldownUntil) {
      this._cooldownUntil = 0;
      this._risk = null;
    }
    this._tasks = this._normalizeTasks(tasks, options.skus);
    // 批量上限保护（v2.1.5：以当前 settings.capture.maxBatch 为准，默认 20、范围 5~100）
    const totalBeforeLimit = this._tasks.length;
    if (this._tasks.length > this._cfg.maxBatch) {
      this._tasks = this._tasks.slice(0, this._cfg.maxBatch);
    }
    this._queued = this._tasks.length;
    this._truncated = Math.max(0, totalBeforeLimit - this._tasks.length);
    this._index = -1;
    this._done = 0;
    this._ok = 0;
    this._fail = 0;
    this._consecutiveFails = 0;
    this._currentSku = '';
    this._lastAttempt = 1;
    this._createdTabs = [];
    this._tabId = null;
    this._waiting = null;
    this._earlyResult = null;
    this._stopped = false;
    this._paused = false;
    this._autoPaused = false;
    this._autoPauseReason = '';
    this._everAutoPaused = false;
    this._autoPauseCount = 0;
    this._startedAt = new Date().toISOString();
    this._finishedAt = null;
    this._summary = null;
    this._accountLabel = '';
    this._resampled = 0;
    this._inconsistent = 0;
    this._totalSamples = 0;
    // v2.1.5 异常自动继续：每轮重置计数/等待态
    this._anomaly = null;
    this._anomalyStreak = 0;
    this._waitingUntil = 0;
    this._offSaleCount = 0;
    this._softAnomalyCount = 0;
    this._anomalyWait = null;
    this._skipAnomalyRequested = false;
    this._runDecideMore =
      typeof options.decideMore === 'function' ? options.decideMore : this._decideMoreDefault;
    this._running = true;
    this._attachListener();
    const modeLabel = this._cfg.mode === 'single' ? '单次' : this._cfg.mode === 'double' ? '双次' : '智能';
    this._progress(
      'start',
      '开始采集，共 ' + this._tasks.length + ' 条（本批上限 ' + this._cfg.maxBatch + ' 条，' + modeLabel +
        '采样，最多 ' + this._cfg.maxSamples + ' 次）' +
        (this._truncated ? '；' + this._truncated + ' 条顺延到下一批' : '')
    );
    this._log(
      '本批 ' + this._tasks.length + ' 条（上限 ' + this._cfg.maxBatch + ' 条）' +
        (this._truncated
          ? '，已截断 ' + this._truncated + ' 条顺延到下一批（可在设置里调整每批上限 5~100）'
          : '')
    );

    try {
      if (!this._tasks.length) {
        this._log('没有需要采集的 SKU');
      } else {
        const tabId = await this._ensureTab();
        if (tabId == null) {
          this._log('无法创建采集用的后台标签页，采集未开始（请确认插件权限后重试）');
        } else {
          await this._loop();
        }
      }
    } catch (err) {
      this._log('采集异常终止：' + errText(err));
    } finally {
      await this._finish(options.keepTab);
    }
    return this._summary;
  }

  /** 暂停：当前这一条采完后不再打开新页面 */
  pause() {
    if (!this._running || this._paused) return false;
    this._paused = true;
    this._autoPaused = false;
    this._log('已暂停采集' + (this._waiting ? '（当前这条采完后生效，不再打开新页面）' : ''));
    this._progress('pause', '已暂停');
    return true;
  }

  /** 继续（风控冷却期内禁止继续，避免连续请求加剧频控） */
  resume() {
    if (!this._running || !this._paused) return false;
    const gate = this.canStart();
    if (gate.blocked) {
      this._log(
        '冷却中：' + this._formatTime(this._cooldownUntil) + ' 前不允许继续采集（触发风控后的保护），' +
          '请等待冷却结束、切换账号/网络后重新开始'
      );
      this._progress('cooldown', '冷却中：' + this._formatTime(this._cooldownUntil) + ' 前不允许继续采集', {
        risk: this._risk,
        cooldownUntil: this._cooldownUntil
      });
      return false;
    }
    this._paused = false;
    this._autoPaused = false;
    this._log('继续采集');
    this._progress('resume', '继续采集');
    return true;
  }

  /** 停止：立即中断（未完成的这条不算结果），关闭采集标签页后 resolve start() */
  stop() {
    if (!this._running) return false;
    this._stopped = true;
    this._paused = false;
    this._autoPaused = false;
    if (this._waiting) {
      const waiting = this._waiting;
      this._waiting = null;
      try {
        clearTimeout(waiting.timer);
      } catch (e) {
        // 忽略
      }
      waiting.resolve({
        ok: false,
        sku: waiting.sku,
        stopped: true,
        reason: '采集已停止',
        flags: null,
        at: new Date().toISOString()
      });
    }
    // v2.1.5：停止时取消软异常等待
    if (this._anomalyWait) {
      const waiting = this._anomalyWait;
      this._anomalyWait = null;
      this._waitingUntil = 0;
      try {
        waiting.resolve();
      } catch (e) {
        // 忽略
      }
    }
    this._log('已停止采集');
    this._progress('stop', '已停止');
    return true;
  }

  // ---------------- 内部实现 ----------------

  _normalizeTasks(tasks, skuFilter) {
    const out = [];
    const seen = new Set();
    let filter = null;
    if (Array.isArray(skuFilter) && skuFilter.length) {
      filter = new Set(skuFilter.map((s) => String(s == null ? '' : s).trim()).filter(Boolean));
    }
    for (const t of Array.isArray(tasks) ? tasks : []) {
      if (!t) continue;
      const sku = String(t.sku == null ? '' : t.sku).trim();
      if (!sku) continue;
      if (filter && !filter.has(sku)) continue;
      if (seen.has(sku)) continue;
      seen.add(sku);
      // 保留调用方自定义字段（如 name / refBand / referenceRange），onResult.task 原样透传
      out.push(Object.assign({}, t, { sku: sku, url: String(t.url || '').trim() || itemUrl(sku) }));
    }
    return out;
  }

  async _ensureTab() {
    if (this._tabId != null) return this._tabId;
    try {
      const created = await this._chrome.tabs.create({ url: 'about:blank', active: false });
      const id = created && created.id;
      if (id == null) return null;
      this._tabId = id;
      this._createdTabs.push(id);
      return id;
    } catch (err) {
      this._log('创建后台标签页失败：' + errText(err));
      return null;
    }
  }

  async _loop() {
    const total = this._tasks.length;
    for (let i = 0; i < total; i++) {
      if (this._stopped) break;
      if (!(await this._waitWhilePaused())) break;
      if (this._stopped) break;

      this._index = i;
      const task = this._tasks[i];
      this._currentSku = task.sku;
      this._earlyResult = null;

      const taskRun = await this._captureTask(task, i);
      if (this._stopped) break;

      const { samples, lastResult, lastOkResult } = taskRun;
      const stat = chooseSamples(samples, {
        toleranceAbs: this._cfg.toleranceAbs,
        tolerancePct: this._cfg.tolerancePct
      });
      const ok = stat.price != null;
      const pricePick = ok ? { price: stat.price, kind: stat.kind } : null;
      let reason = '';
      if (!ok) {
        reason =
          (lastResult && lastResult.reason) || '取到的价格不合理（疑似数字片段/促销角标），建议重采或手动修改';
      }
      const recordResult = lastOkResult || lastResult || this._failMessage(task, '采集失败');
      const capture = buildCaptureRecord(Object.assign({}, recordResult, { ok: ok }), {
        task: task,
        prefer: this._cfg.prefer,
        samples: samples,
        toleranceAbs: this._cfg.toleranceAbs,
        tolerancePct: this._cfg.tolerancePct
      });
      if (!ok) capture.fail = { reason: reason, at: capture.at };

      const payload = {
        task: task,
        attempt: taskRun.attempts || 1,
        ok: ok,
        reason: reason,
        result: recordResult || null,
        pricePick: pricePick,
        capture: capture,
        samples: samples.slice(),
        spread: stat.spread,
        consistent: stat.consistent,
        sampleCount: stat.sampleCount,
        price: stat.price,
        risk: lastResult && lastResult.risk ? lastResult.risk : this._risk,
        pageKind: (lastResult && lastResult.pageKind) || (lastResult && lastResult.risk && lastResult.risk.hit ? 'risk' : 'item')
      };

      this._done = i + 1;
      this._totalSamples += stat.sampleCount;
      if (stat.sampleCount > 1) this._resampled += 1;
      if (!stat.consistent) this._inconsistent += 1;

      if (ok) {
        this._ok += 1;
        this._consecutiveFails = 0;
        let line =
          '[' + (i + 1) + '/' + total + '] ' + task.sku + ' ✓ ' + stat.price + ' 元（' + this._kindLabel(stat.kind) + '）';
        if (stat.sampleCount > 1) {
          line +=
            '，' +
            stat.sampleCount +
            ' 次采样价差 ¥' +
            stat.spread +
            (stat.consistent ? '（一致）' : '（不一致，标需人工确认）') +
            '，中位数 ¥' +
            stat.price;
        }
        this._log(line);
      } else {
        this._fail += 1;
        this._consecutiveFails += 1;
        this._log('[' + (i + 1) + '/' + total + '] ' + task.sku + ' ✗ ' + reason);
      }
      this._emitResult(payload);
      this._progress('result', '已完成：' + task.sku + (ok ? '（成功）' : '（失败）'), {
        sampleCount: stat.sampleCount,
        spread: stat.spread,
        consistent: stat.consistent
      });

      // 落地页异常三分类（v2.1.5）：
      //   risk        → 自动暂停 + 冷却（v2.1.4 行为）
      //   offSale     → 标记失败「已下架」，跳过继续下一条（不暂停/不冷却/不计连续失败）
      //   softAnomaly → 等待 anomalyWaitSec 秒后自动继续；连续 ≥anomalyMaxRetry 次升级为冷却暂停
      //   （账号变化在采样循环里已处理）
      const flags = (lastResult && lastResult.flags) || {};
      const taskRisk = lastResult && lastResult.risk && lastResult.risk.hit ? lastResult.risk : null;
      const pageKind = lastResult && lastResult.pageKind;
      const offSale =
        !!(lastResult && (lastResult.offSale === true || (lastResult.flags && lastResult.flags.offSale))) ||
        pageKind === 'offSale';
      const softAnomaly = !!(lastResult && lastResult.softAnomaly === true) || pageKind === 'softAnomaly';
      let waitedForAnomaly = false;
      if (taskRisk) {
        this._handleRisk(taskRisk, lastResult);
      } else if (offSale) {
        this._offSaleCount += 1;
        this._anomalyStreak = 0;
        this._consecutiveFails = 0; // 下架属于正常业务结果，不触发「连续失败自动暂停」
        this._log('[' + (i + 1) + '/' + total + '] ' + task.sku + ' 已下架，跳过继续下一条（不算风控）');
        this._progress('result', '已下架，继续下一条：' + task.sku, {
          pageKind: 'offSale',
          offSaleCount: this._offSaleCount
        });
      } else if (softAnomaly) {
        this._softAnomalyCount += 1;
        this._anomalyStreak += 1;
        this._consecutiveFails = 0;
        const anomaly = {
          reason: (lastResult && lastResult.anomaly && lastResult.anomaly.reason) || 'jump',
          detail: (lastResult && lastResult.anomaly && lastResult.anomaly.detail) || (lastResult && lastResult.reason) || '',
          url: (lastResult && lastResult.anomaly && lastResult.anomaly.url) || (lastResult && lastResult.url) || '',
          title: (lastResult && lastResult.anomaly && lastResult.anomaly.title) || '',
          at: (lastResult && lastResult.at) || new Date().toISOString(),
          sku: task.sku
        };
        this._anomaly = anomaly;
        this._log(
          '[' + (i + 1) + '/' + total + '] ' + task.sku + ' 检测到异常（' +
            (anomaly.reason === 'empty' ? '空页/跳转失败' : '跳转到电商平台首页/频道页') +
            '，非风控）'
        );
        if (this._anomalyStreak >= this._cfg.anomalyMaxRetry) {
          this._escalateAnomaly();
        } else {
          const waited = await this._waitAnomalyThenContinue(total, i);
          waitedForAnomaly = waited;
        }
      } else {
        this._anomalyStreak = 0;
        if (flags.verify) {
          this._autoPause('页面要求安全验证（可能触发风控），已自动暂停采集');
        } else if (!ok && this._consecutiveFails >= this._cfg.autoPauseFails) {
          this._autoPause(
            '连续 ' + this._consecutiveFails + ' 个采集失败，已自动暂停（请检查登录状态 / 页面是否改版 / 是否触发验证）'
          );
        }
      }

      if (this._stopped) break;
      if (!(await this._waitWhilePaused())) break;
      if (this._stopped) break;

      if (i < total - 1 && !waitedForAnomaly) {
        // 每 longRestEvery 条来一次长休息（默认 8 条 / 30~60s），其余为普通随机间隔（默认 5~10s）
        const every = this._cfg.longRestEvery;
        const longRest = every > 0 && (i + 1) % every === 0;
        if (longRest) {
          const restSec = randInt(this._cfg.longRestMin, this._cfg.longRestMax);
          if (restSec > 0) {
            this._log('已连续采集 ' + (i + 1) + ' 条，长休息 ' + restSec + ' 秒（降低频控风险）…');
            this._progress('waiting', '长休息 ' + restSec + ' 秒（降低频控风险）');
            await this._sleepInterruptible(restSec * 1000);
          }
        } else {
          const delaySec = randInt(this._cfg.intervalMin, this._cfg.intervalMax);
          if (delaySec > 0) {
            this._log('等待 ' + delaySec + ' 秒…（降低频控风险，可在设置里调）');
            this._progress('waiting', '等待 ' + delaySec + ' 秒后继续');
            await this._sleepInterruptible(delaySec * 1000);
          }
        }
      }
    }
  }

  /**
   * 单个 SKU 的多采样循环：
   *   第 1 次用导航（tabs.update）打开商品页；后续复核用「等待 700~1300ms + tabs.reload」刷新，
   *   每次结果按 sku 匹配；是否继续由 decideMore 决定，最多 maxSamples 次。
   * @returns {{samples:Array, lastResult:object|null, lastOkResult:object|null, sampleIndex:number, attempts:number}}
   */
  async _captureTask(task, index) {
    const maxSamples = this._cfg.maxSamples;
    const samples = [];
    let lastResult = null;
    let lastOkResult = null;
    let sampleIndex = 0;
    let attempts = 1;

    while (sampleIndex < maxSamples) {
      if (this._stopped) break;
      if (!(await this._waitWhilePaused())) break;
      if (this._stopped) break;

      const nextIndex = sampleIndex + 1;
      let result = null;
      if (nextIndex === 1) {
        result = await this._captureOne(task, index);
        attempts = this._lastAttempt;
      } else {
        result = await this._captureAgain(task, nextIndex, index);
      }
      if (this._stopped) break;

      if (result && result.ok) {
        const pick = pickPriceByPrefer(result, this._cfg.prefer);
        if (pick) {
          samples.push({ price: round2(pick.price), kind: pick.kind, at: result.at || new Date().toISOString() });
          lastOkResult = result;
        }
      }
      lastResult = result || lastResult;
      sampleIndex = nextIndex;
      // 命中期风控落地页：本轮不再复核/不再重试，交给上层自动暂停 + 冷却（避免继续请求加大风控）
      const riskHit = result && result.risk && result.risk.hit;
      // v2.1.5：下架/软异常也不复核（交给上层：下架跳过、软异常等待后继续）
      const kindNow = result && result.pageKind;
      const offSaleNow = !!(
        (result && result.offSale === true) ||
        (result && result.flags && result.flags.offSale) ||
        kindNow === 'offSale'
      );
      const softNow = !!(result && result.softAnomaly === true) || kindNow === 'softAnomaly';
      if (riskHit) {
        this._log(
          '[' + (index + 1) + '/' + this._tasks.length + '] ' + task.sku +
            ' 命中期风控落地页（' + ((result.risk && result.risk.reason) || 'risk') + '），停止复核并自动暂停'
        );
        break;
      }
      if (offSaleNow || softNow) {
        this._log(
          '[' + (index + 1) + '/' + this._tasks.length + '] ' + task.sku +
            (offSaleNow ? ' 页面提示已下架' : ' 页面异常（跳转/空页）') + '，停止复核'
        );
        break;
      }
      // 复核（第 2 次及以后）失败：保留已有成功样本，不把整条任务判失败；
      // 只有一次成功样本都没有时，任务才会整体失败（由上层的 ok = samples 非空 决定）。
      if (nextIndex > 1 && (!result || !result.ok)) {
        this._log(
          '  复核第 ' + nextIndex + ' 次失败（' + ((result && result.reason) || '未知原因') + '），保留已有采样结果'
        );
      }

      // 账号变化：自动暂停（并把新账号作为后续基准，resume 后不会重复触发）
      this._checkAccountChange(result);
      if (this._paused && this._autoPaused) break;

      const stat = chooseSamples(samples, {
        toleranceAbs: this._cfg.toleranceAbs,
        tolerancePct: this._cfg.tolerancePct
      });
      if (sampleIndex === 1 && samples.length === 1) {
        this._log(
          '[' + (index + 1) + '/' + this._tasks.length + '] ' + task.sku + ' 首次采样 ' +
            samples[0].price + ' 元（' + this._kindLabel(samples[0].kind) + '）'
        );
      }
      if (samples.length >= 2) {
        this._log(
          '  ' + samples.length + ' 次采样价差 ¥' + stat.spread + '，' +
            (stat.consistent ? '一致' : '不一致（标需人工确认）') + '，中位数 ¥' + stat.price
        );
      }
      // single 模式是「快速跑量」：只采 1 次，即使 decideMore 返回 true 也强制停止
      if (this._cfg.mode === 'single') break;
      if (sampleIndex >= maxSamples) break;

      const decision = await this._decideMoreSample({
        task: task,
        samples: samples,
        stat: stat,
        result: result,
        sampleIndex: sampleIndex,
        mode: this._cfg.mode,
        maxSamples: maxSamples
      });
      if (!decision.more) {
        if (decision.reason) this._log('  停止复核：' + decision.reason);
        break;
      }

      // 准备下一次复核
      const nextSampleNo = sampleIndex + 1;
      this._progress('sample', '复核第 ' + nextSampleNo + ' 次：' + task.sku, {
        sampleIndex: nextSampleNo,
        sampleCount: samples.length,
        spread: stat.spread,
        consistent: stat.consistent
      });
      this._log(
        '[' + (index + 1) + '/' + this._tasks.length + '] ' + task.sku + ' 复核第 ' + nextSampleNo + ' 次' +
          (decision.reason ? '（' + decision.reason + '）' : '')
      );
      const waitMs = randInt(this._cfg.sampleDelayMinMs, this._cfg.sampleDelayMaxMs);
      this._log('  等待 ' + waitMs + 'ms 后刷新页面复核…');
      this._progress('waiting', '等待 ' + waitMs + 'ms 后复核：' + task.sku, {
        sampleIndex: nextSampleNo,
        sampleCount: samples.length
      });
      await this._sleepInterruptible(waitMs);
      if (this._stopped) break;
    }

    return { samples: samples, lastResult: lastResult, lastOkResult: lastOkResult, sampleIndex: sampleIndex, attempts: attempts };
  }

  /** 判断要不要再采一次：优先用调用方 decideMore，否则按 mode 内置策略 */
  async _decideMoreSample(ctx) {
    const decideMore = this._runDecideMore;
    if (typeof decideMore === 'function') {
      const last = ctx.samples.length ? ctx.samples[ctx.samples.length - 1] : null;
      let candidateCount = null;
      if (ctx.result && typeof ctx.result.candidateCount === 'number') candidateCount = ctx.result.candidateCount;
      try {
        const decision = await decideMore({
          task: ctx.task,
          samples: ctx.samples.slice(),
          price: ctx.stat.price,
          pricePick: last ? { price: last.price, kind: last.kind } : null,
          result: ctx.result || null,
          sampleIndex: ctx.sampleIndex,
          mode: ctx.mode,
          maxSamples: ctx.maxSamples,
          candidateCount: candidateCount
        });
        if (typeof decision === 'boolean') return { more: decision, reason: '' };
        if (decision && typeof decision === 'object') {
          let reason = decision.reason || '';
          if (!reason && Array.isArray(decision.reasons)) {
            reason = decision.reasons
              .map((r) => (r && (r.text || r.code)) || '')
              .filter(Boolean)
              .join('；');
          }
          return { more: !!decision.more, reason: reason };
        }
        return { more: false, reason: '' };
      } catch (err) {
        this._log('复核判断回调异常（已跳过复核）：' + errText(err));
        return { more: false, reason: '' };
      }
    }
    // 没有 decideMore 时的内置策略：double 固定 2 次，价差超容差再补；smart/single 不补采
    if (this._cfg.mode === 'double') {
      if (ctx.sampleIndex < 2) return { more: true, reason: 'double 模式固定复核' };
      if (ctx.stat && !ctx.stat.consistent) return { more: true, reason: '采样价差超过容差' };
    }
    return { more: false, reason: '' };
  }

  /** 复核采样：等待后刷新当前采集标签页（没有 tabs.reload 的 fake 环境退回再导航一次） */
  async _captureAgain(task, sampleIndex, index) {
    const total = this._tasks.length;
    this._lastAttempt = 1;
    this._earlyResult = null;
    const tabId = await this._ensureTab();
    if (tabId == null) return this._failMessage(task, '复核失败：无法创建采集标签页');
    this._log('[' + (index + 1) + '/' + total + '] 刷新页面复核 ' + task.sku + '（第 ' + sampleIndex + ' 次）');
    this._progress('nav', '复核第 ' + sampleIndex + ' 次：' + task.sku, { sampleIndex: sampleIndex });
    try {
      await this._reloadTab(tabId, task.url);
    } catch (err) {
      this._tabId = null; // 标签页可能已被关闭，下一次重试会重新创建
      return this._failMessage(task, '复核刷新页面失败：' + errText(err));
    }
    if (this._stopped) return this._failMessage(task, '采集已停止');
    this._progress('waiting', '等待复核结果：' + task.sku + '（第 ' + sampleIndex + ' 次）', {
      sampleIndex: sampleIndex
    });
    return this._waitForResult(task.sku);
  }

  async _reloadTab(tabId, url) {
    const tabs = this._chrome && this._chrome.tabs;
    if (tabs && typeof tabs.reload === 'function') {
      await tabs.reload(tabId);
      return;
    }
    if (tabs && typeof tabs.update === 'function') {
      await tabs.update(tabId, { url: url });
      return;
    }
    throw new Error('当前环境不支持刷新标签页');
  }

  /** 账号变化检测：运行中昵称与首次不同 → 自动暂停（可用 resume 继续） */
  _checkAccountChange(result) {
    if (!this._cfg.pauseOnAccountChange) return;
    const nickname = result && result.account && result.account.nickname ? String(result.account.nickname).trim() : '';
    if (!nickname) return;
    if (!this._accountLabel) {
      this._accountLabel = nickname;
      this._log('当前登录账号：' + nickname);
      return;
    }
    if (nickname === this._accountLabel) return;
    const from = this._accountLabel;
    // 先把基准切成新账号，人工 resume 后不会反复触发
    this._accountLabel = nickname;
    this._autoPause('检测到电商平台账号发生变化（' + from + ' → ' + nickname + '），已自动暂停，请确认账号后点「继续」');
  }

  async _captureOne(task, index) {
    const total = this._tasks.length;
    const maxAttempts = this._cfg.retries + 1;
    let lastResult = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (this._stopped) return null;
      if (!(await this._waitWhilePaused())) return null;
      if (this._stopped) return null;
      this._lastAttempt = attempt;
      const title = '[' + (index + 1) + '/' + total + '] 打开 ' + task.sku;
      this._log(title + (attempt > 1 ? '（第 ' + attempt + ' 次尝试）' : ''));
      this._progress('nav', title);
      this._earlyResult = null;

      const tabId = await this._ensureTab();
      if (tabId == null) {
        lastResult = this._failMessage(task, '打开页面失败：无法创建采集标签页');
      } else {
        let navOk = true;
        try {
          await this._chrome.tabs.update(tabId, { url: task.url });
        } catch (err) {
          navOk = false;
          this._tabId = null; // 标签页可能被用户关掉了，下次重试重新创建
          lastResult = this._failMessage(task, '打开页面失败：' + errText(err));
          this._log('打开页面失败：' + errText(err));
        }
        if (navOk) {
          if (this._stopped) return this._failMessage(task, '采集已停止');
          this._progress('waiting', '等待 ' + task.sku + ' 的页面结果…');
          lastResult = await this._waitForResult(task.sku);
        }
      }

      if (this._stopped) return lastResult;
      if (lastResult && lastResult.ok) return lastResult;

      // 安全验证 / 命中期风控落地页 / 已下架 / 软异常：重试没有意义（还会加大风控风险），直接交给上层处理
      const flags = (lastResult && lastResult.flags) || {};
      const risk = lastResult && lastResult.risk;
      const kindNow = lastResult && lastResult.pageKind;
      const offSaleNow = !!(
        (lastResult && lastResult.offSale === true) ||
        (lastResult && lastResult.flags && lastResult.flags.offSale) ||
        kindNow === 'offSale'
      );
      const softNow = !!(lastResult && lastResult.softAnomaly === true) || kindNow === 'softAnomaly';
      if (flags.verify || flags.offSale || (risk && risk.hit) || offSaleNow || softNow) return lastResult;

      if (attempt < maxAttempts) {
        this._log('第 ' + attempt + ' 次尝试失败（' + ((lastResult && lastResult.reason) || '未知原因') + '），准备重试…');
        this._progress('retry', '重试 ' + task.sku + '（第 ' + (attempt + 1) + ' 次）');
        await this._sleepInterruptible(this._cfg.retryDelayMs);
      }
    }
    return lastResult;
  }

  _failMessage(task, reason) {
    return {
      type: RESULT_MESSAGE_TYPE,
      ok: false,
      sku: task.sku,
      url: task.url,
      reason: reason,
      flags: null,
      size: null,
      main: null,
      plus: null,
      hand: null,
      candidates: [],
      account: null,
      at: new Date().toISOString()
    };
  }

  _waitForResult(sku) {
    return new Promise((resolve) => {
      const timeoutMs = this._cfg.timeoutMs;
      // 已经停止：不再等待
      if (this._stopped) {
        resolve(this._failMessage({ sku: sku, url: itemUrl(sku) }, '采集已停止'));
        return;
      }
      // 极少数情况下页面消息会早于 tabs.update 的 Promise resolve 到达，先吃缓存
      if (this._earlyResult && String(this._earlyResult.sku || '').trim() === sku) {
        const early = this._earlyResult;
        this._earlyResult = null;
        resolve(early);
        return;
      }
      const timer = setTimeout(() => {
        if (this._waiting && this._waiting.sku === sku) {
          this._waiting = null;
          resolve({
            type: RESULT_MESSAGE_TYPE,
            ok: false,
            sku: sku,
            timeout: true,
            reason:
              '等待页面价格超时（' + Math.round(timeoutMs / 1000) + ' 秒；可能页面加载慢、未登录或页面改版）',
            flags: null,
            size: null,
            main: null,
            plus: null,
            hand: null,
            candidates: [],
            account: null,
            at: new Date().toISOString()
          });
        }
      }, timeoutMs);
      this._waiting = {
        sku: sku,
        timer: timer,
        resolve: (msg) => {
          clearTimeout(timer);
          this._waiting = null;
          resolve(msg);
        }
      };
    });
  }

  _attachListener() {
    if (this._listener) return;
    const runtime = this._chrome && this._chrome.runtime;
    if (!runtime || !runtime.onMessage || typeof runtime.onMessage.addListener !== 'function') {
      this._log('警告：chrome.runtime.onMessage 不可用，无法接收商品页结果');
      return;
    }
    this._listener = (msg, sender) => this._handleMessage(msg, sender);
    try {
      runtime.onMessage.addListener(this._listener);
    } catch (err) {
      this._listener = null;
      this._log('注册消息监听失败：' + errText(err));
    }
  }

  _detachListener() {
    if (!this._listener) return;
    const runtime = this._chrome && this._chrome.runtime;
    try {
      if (runtime && runtime.onMessage && typeof runtime.onMessage.removeListener === 'function') {
        runtime.onMessage.removeListener(this._listener);
      }
    } catch (err) {
      // 忽略
    }
    this._listener = null;
  }

  _handleMessage(msg, sender) {
    if (!msg || msg.type !== RESULT_MESSAGE_TYPE) return;
    // 只接受采集标签页自己发来的消息（工作台可能同时有别的页面在发消息）
    const fromTabId = sender && sender.tab && sender.tab.id;
    if (fromTabId != null && this._tabId != null && fromTabId !== this._tabId) {
      this._log('忽略其它标签页的采集结果（tab ' + fromTabId + '，当前采集 tab ' + this._tabId + '）');
      return;
    }
    const sku = String(msg.sku == null ? '' : msg.sku).trim();
    if (!this._waiting) {
      // 早于等待窗口到达的结果：暂存给 _waitForResult
      if (sku && sku === this._currentSku) {
        this._earlyResult = msg;
        return;
      }
      this._log('忽略采集结果：当前没有等待中的 SKU（' + (sku || '(空 SKU)') + '）');
      return;
    }
    if (sku !== this._waiting.sku) {
      this._log('忽略迟到/不匹配的采集结果：' + (sku || '(空 SKU)') + '，当前等待 ' + this._waiting.sku);
      return;
    }
    this._waiting.resolve(msg);
  }

  _kindLabel(kind) {
    if (kind === 'hand') return '到手价';
    if (kind === 'main') return '电商平台价';
    if (kind === 'plus') return 'PLUS价';
    return '页面价';
  }

  async _waitWhilePaused() {
    if (this._stopped) return false;
    if (!this._paused) return true;
    while (this._paused && !this._stopped) {
      await sleep(150);
    }
    return !this._stopped;
  }

  _sleepInterruptible(ms) {
    return new Promise((resolve) => {
      if (!ms || ms <= 0) {
        resolve();
        return;
      }
      const deadline = Date.now() + ms;
      const tick = () => {
        if (this._stopped || Date.now() >= deadline) {
          resolve();
          return;
        }
        setTimeout(tick, Math.min(120, Math.max(10, deadline - Date.now())));
      };
      setTimeout(tick, Math.min(120, ms));
    });
  }

  _autoPause(reason) {
    if (this._stopped) return;
    if (this._paused && this._autoPaused) return;
    this._paused = true;
    this._autoPaused = true;
    this._autoPauseReason = reason;
    this._everAutoPaused = true;
    this._autoPauseCount += 1;
    this._log('⚠ ' + reason);
    this._progress('auto-pause', reason);
  }

  // ---------------- v2.1.4 风控/冷却 ----------------

  /** 风控原因的中文文案（与 content.js risk.reason 枚举对应） */
  _riskText(reason) {
    if (reason === 'home') return '打开商品页被跳转到电商平台首页';
    if (reason === 'login') return '页面跳转到电商平台登录页';
    if (reason === 'verify') return '页面要求安全验证';
    return '页面疑似风控/验证页';
  }

  /** 时间戳 → HH:MM（本地时间），用于「冷却至 xx:xx」提示 */
  _formatTime(timestamp) {
    const n = Number(timestamp);
    if (!isFinite(n) || n <= 0) return '';
    try {
      const d = new Date(n);
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      return hh + ':' + mm;
    } catch (e) {
      return '';
    }
  }

  /**
   * 处理 content.js 返回的 risk 落地页：记录风控信息 → 自动暂停 → 设置冷却截止时间。
   * 只做识别/冷却/降频，不尝试任何绕过风控的手段。
   */
  _handleRisk(risk, result) {
    const now = Date.now();
    const minutes = this._cfg.cooldownMinutes;
    this._cooldownUntil = now + minutes * 60000;
    const last = result || {};
    this._risk = {
      reason: (risk && risk.reason) || 'risk',
      detail: (risk && risk.detail) || '',
      url: (risk && risk.url) || last.url || '',
      title: (risk && risk.title) || last.title || '',
      at: new Date(now).toISOString()
    };
    const text = this._riskText(this._risk.reason);
    const untilText = this._formatTime(this._cooldownUntil);
    this._log('⚠ 触发电商平台风控：' + text + (this._risk.url ? '（' + this._risk.url + '）' : ''));
    this._log(
      '  已自动暂停并进入冷却，冷却至 ' + untilText + '（' + minutes + ' 分钟）；' +
        '建议停 24 小时、切换电商平台账号或网络后再试，请勿连续重试'
    );
    this._progress('risk', '触发电商平台风控（' + text + '），已自动暂停', {
      risk: this._risk,
      cooldownUntil: this._cooldownUntil
    });
    this._autoPause(
      '触发电商平台风控（' + text + '），已自动暂停；冷却至 ' + untilText + '，请勿连续重试'
    );
    this._progress('cooldown', '冷却中：' + untilText + ' 前不允许开始采集', {
      risk: this._risk,
      cooldownUntil: this._cooldownUntil
    });
  }

  // ---------------- v2.1.5 软异常等待/升级 ----------------

  /** 软异常等待：等待期间每 ~1 秒发一次 onProgress('anomaly-wait')，可被 skipAnomalyWait()/stop() 打断 */
  _waitAnomaly(totalMs) {
    return new Promise((resolve) => {
      const endAt = Date.now() + totalMs;
      let done = false;
      let timer = null;
      const finish = () => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        timer = null;
        this._anomalyWait = null;
        resolve();
      };
      const tick = () => {
        if (done) return;
        if (this._stopped || this._skipAnomalyRequested) {
          finish();
          return;
        }
        const remaining = Math.max(0, endAt - Date.now());
        if (remaining <= 0) {
          finish();
          return;
        }
        this._progress('anomaly-wait', '检测到异常，等待 ' + Math.ceil(remaining / 1000) + ' 秒后继续', {
          remainingMs: remaining,
          totalMs: totalMs,
          anomaly: this._anomaly,
          waitingUntil: endAt
        });
        timer = setTimeout(tick, Math.min(1000, remaining));
      };
      this._anomalyWait = { resolve: finish, endAt: endAt, totalMs: totalMs };
      tick();
    });
  }

  /** 等待 softAnomaly 后自动继续；返回是否真的等待过（用于跳过后续普通间隔） */
  async _waitAnomalyThenContinue(total, index) {
    const totalMs = Math.round(this._cfg.anomalyWaitSec * 1000);
    if (totalMs <= 0) {
      this._log('异常等待已关闭（anomalyWaitSec=0），立即继续下一条');
      return false;
    }
    const until = Date.now() + totalMs;
    this._waitingUntil = until;
    this._log(
      '检测到异常（跳转/空页），等待 ' + this._cfg.anomalyWaitSec +
        ' 秒后自动继续（可点「立即继续」跳过等待；连续 ' + this._cfg.anomalyMaxRetry + ' 次异常将升级冷却）'
    );
    this._progress('anomaly-wait', '检测到异常，等待 ' + this._cfg.anomalyWaitSec + ' 秒后自动继续', {
      remainingMs: totalMs,
      totalMs: totalMs,
      anomaly: this._anomaly,
      waitingUntil: until,
      anomalyStreak: this._anomalyStreak
    });
    await this._waitAnomaly(totalMs);
    this._waitingUntil = 0;
    const skipped = this._skipAnomalyRequested;
    this._skipAnomalyRequested = false;
    if (this._stopped) return true;
    if (!skipped) {
      this._log('异常等待结束，自动继续采集（第 ' + (index + 2) + ' 条）');
    }
    this._progress('waiting', skipped ? '已跳过异常等待，立即继续' : '异常等待结束，自动继续采集', {
      anomaly: this._anomaly,
      waitingUntil: 0
    });
    return true;
  }

  /** 连续软异常达到上限：升级为冷却暂停，提示换账号/网络（不重试） */
  _escalateAnomaly() {
    const now = Date.now();
    const minutes = this._cfg.cooldownMinutes;
    this._cooldownUntil = now + minutes * 60000;
    const untilText = this._formatTime(this._cooldownUntil);
    this._risk = {
      reason: 'anomaly',
      detail: '连续 ' + this._anomalyStreak + ' 次页面异常（跳转/空页），疑似被限流',
      url: (this._anomaly && this._anomaly.url) || '',
      title: (this._anomaly && this._anomaly.title) || '',
      at: new Date(now).toISOString()
    };
    this._log(
      '⚠ 连续 ' + this._anomalyStreak + ' 次页面异常（跳转/空页，非验证页），已升级为冷却暂停：' +
        '冷却至 ' + untilText + '（' + minutes + ' 分钟）'
    );
    this._log('  建议切换电商平台账号或网络后再试，不要连续重试');
    this._progress('risk', '连续 ' + this._anomalyStreak + ' 次异常，已升级为冷却暂停', {
      risk: this._risk,
      cooldownUntil: this._cooldownUntil
    });
    this._autoPause(
      '连续 ' + this._anomalyStreak + ' 次页面异常（跳转/空页），已升级为冷却暂停；' +
        '冷却至 ' + untilText + '，建议换账号/换网络后再试'
    );
    this._progress('cooldown', '冷却中：' + untilText + ' 前不允许开始采集', {
      risk: this._risk,
      cooldownUntil: this._cooldownUntil
    });
  }

  _progress(phase, text, extra) {
    const payload = Object.assign(
      {
        phase: phase,
        text: text,
        done: this._done,
        total: this._tasks.length,
        ok: this._ok,
        fail: this._fail,
        index: this._index,
        currentSku: this._currentSku,
        consecutiveFails: this._consecutiveFails,
        autoPaused: this._autoPaused,
        autoPauseReason: this._autoPauseReason,
        mode: this._cfg.mode,
        maxSamples: this._cfg.maxSamples,
        sampleIndex: 0,
        sampleCount: 0,
        spread: 0,
        consistent: true,
        risk: this._risk,
        cooldownUntil: this._cooldownUntil,
        anomaly: this._anomaly,
        waitingUntil: this._waitingUntil,
        offSaleCount: this._offSaleCount,
        softAnomalyCount: this._softAnomalyCount,
        anomalyStreak: this._anomalyStreak
      },
      extra || {}
    );
    try {
      this._onProgress(payload);
    } catch (err) {
      // 回调异常不影响采集
    }
  }

  _emitResult(payload) {
    try {
      this._onResult(payload);
    } catch (err) {
      // 回调异常不影响采集
    }
  }

  _log(line) {
    try {
      this._onLog(String(line));
    } catch (err) {
      // 回调异常不影响采集
    }
  }

  async _finish(keepTabOverride) {
    this._detachListener();
    this._running = false;
    this._paused = false;
    this._currentSku = '';
    this._waiting = null;
    this._earlyResult = null;
    // v2.1.5：结束前兜底取消可能残留的软异常等待
    if (this._anomalyWait) {
      const waiting = this._anomalyWait;
      this._anomalyWait = null;
      try {
        waiting.resolve();
      } catch (e) {
        // 忽略
      }
    }
    this._waitingUntil = 0;
    const keep = typeof keepTabOverride === 'boolean' ? keepTabOverride : this._cfg.keepTab;
    const tabs = this._createdTabs.slice();
    this._createdTabs = [];
    this._tabId = null;
    // 清理采集标签页：保留模式只留最后一个，其余关掉
    const keepId = keep && tabs.length ? tabs[tabs.length - 1] : null;
    for (const id of tabs) {
      if (id === keepId) continue;
      try {
        await this._chrome.tabs.remove(id);
      } catch (err) {
        // 标签页可能已被用户关闭
      }
    }
    this._finishedAt = new Date().toISOString();
    const modeLabel = this._cfg.mode === 'single' ? '单次' : this._cfg.mode === 'double' ? '双次' : '智能';
    this._summary = {
      done: this._done,
      total: this._tasks.length,
      ok: this._ok,
      fail: this._fail,
      stopped: this._stopped,
      autoPaused: this._everAutoPaused,
      autoPauseReason: this._autoPauseReason,
      autoPauseCount: this._autoPauseCount,
      resampled: this._resampled,
      inconsistent: this._inconsistent,
      sampleCount: this._totalSamples,
      mode: this._cfg.mode,
      maxSamples: this._cfg.maxSamples,
      skipped: Math.max(0, this._tasks.length - this._done),
      blocked: false,
      queued: this._queued,
      truncated: this._truncated,
      limit: this._cfg.maxBatch,
      risk: this._risk,
      cooldownUntil: this._cooldownUntil,
      anomaly: this._anomaly,
      waitingUntil: 0,
      offSaleCount: this._offSaleCount,
      softAnomalyCount: this._softAnomalyCount,
      anomalyWaitSec: this._cfg.anomalyWaitSec,
      anomalyMaxRetry: this._cfg.anomalyMaxRetry,
      startedAt: this._startedAt,
      finishedAt: this._finishedAt
    };
    this._log(
      '采集结束：共 ' +
        this._tasks.length +
        ' 个，成功 ' +
        this._ok +
        '，失败 ' +
        this._fail +
        '，采样 ' +
        this._totalSamples +
        ' 次（复核 ' +
        this._resampled +
        ' 个' +
        (this._inconsistent ? '，不一致 ' + this._inconsistent + ' 个' : '') +
        '，' +
        modeLabel +
        '模式）' +
        (this._offSaleCount ? '（已下架 ' + this._offSaleCount + ' 个已跳过）' : '') +
        (this._softAnomalyCount ? '（页面异常 ' + this._softAnomalyCount + ' 次）' : '') +
        (this._truncated ? '（本批上限 ' + this._cfg.maxBatch + ' 条，' + this._truncated + ' 条顺延）' : '') +
        (this._stopped ? '（已停止）' : '') +
        (this._risk && this._cooldownUntil
          ? '（' + (this._risk.reason === 'anomaly' ? '连续异常升级' : '触发风控') +
            '，已进入冷却至 ' + this._formatTime(this._cooldownUntil) + '）'
          : this._everAutoPaused
            ? '（本次发生过自动暂停：' + this._autoPauseReason + '）'
            : '')
    );
    this._progress('done', '采集结束：成功 ' + this._ok + '，失败 ' + this._fail);
    return this._summary;
  }
}
