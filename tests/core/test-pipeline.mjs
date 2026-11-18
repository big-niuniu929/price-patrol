/** tests/core/test-pipeline.mjs —— 补数流水线 / 采集补数 / 多采样复核 / 统计 / 导出（v2.1 + v2.1.5） */
import {
  analyzeReport,
  annotateLibraryStates,
  applyCaptures,
  computeStats,
  buildResultWorkbook,
  buildBackfillWorkbook,
  buildBackupJson,
  buildReferencePriceRange,
  formatReviewText,
  migrateLegacyPackages,
  pairExportRows,
  resolveSettings,
  summarizeRows,
  capturePriceSourceText,
  normalizePriceRect,
  DEFAULT_SETTINGS,
  LIB_STATE_LABELS,
  PAIR_EXPORT_HEADERS,
  BACKFILL_EXPORT_HEADERS,
  PRICE_KIND_LABELS,
} from '../../extension/lib/pipeline.js';
import { writeXlsx } from '../../extension/lib/xlsx-write.js';
import { STATUS, SIZE_BANDS, PRICE_BANDS } from '../../extension/lib/rules.js';
import { suite, test, assert, assertEqual, assertClose, recordMetric } from './harness.mjs';
import { REPORT_FILES } from './paths.mjs';
import { loadAllReports, loadSeedLibrary, loadReport, writeAndInspect } from './helpers.mjs';

/** 4 个榜单的离线分析缓存（只跑一次，后续 suite 复用） */
let cached = null;
async function analyzedReports() {
  if (cached) return cached;
  const library = loadSeedLibrary();
  const loadedList = await loadAllReports(library);
  const reports = loadedList.map((loaded) => {
    const analyzed = analyzeReport(loaded.report, library, {});
    const report = { ...loaded.report, rows: analyzed.rows, summary: analyzed.summary };
    return { loaded, report, analyzed };
  });
  cached = { library, reports };
  return cached;
}

/** 深拷贝一个 report（避免测试之间互相污染） */
function cloneReport(report) {
  return {
    ...report,
    rows: report.rows.map((row) => ({
      ...row,
      source: { ...(row.source || {}) },
      review: row.review ? { ...row.review, reasons: (row.review.reasons || []).map((reason) => ({ ...reason })) } : row.review,
    })),
  };
}

suite('pipeline · analyzeReport 离线补数（4 个真实榜单，回归）', () => {
  test('不丢行、不抛异常，总计 800 行', async () => {
    const { reports } = await analyzedReports();
    assertEqual(reports.length, 4);
    assertEqual(reports.reduce((sum, item) => sum + item.report.rows.length, 0), 800);
    for (const { loaded, report } of reports) {
      assertEqual(report.rows.length, loaded.parsed.rows.length, `${loaded.fileName} 行数不丢`);
      for (const row of report.rows) {
        assertEqual(typeof row.sku, 'string');
        assert(typeof row.status === 'string' && row.status.length > 0, '每行都有状态');
      }
    }
  });

  test('尺寸段覆盖率（v2.1.6 严格识别后 478/800 = 59.75%）', async () => {
    const { reports } = await analyzedReports();
    const details = {};
    let total = 0;
    let filled = 0;
    let ambiguous = 0;
    let multi = 0;
    let none = 0;
    for (const { loaded, analyzed } of reports) {
      total += analyzed.summary.total;
      filled += analyzed.summary.sizeFilled;
      const reportRows = analyzed.rows;
      ambiguous += reportRows.filter((row) => row.sizeAmbiguous).length;
      multi += reportRows.filter((row) => row.sizeAmbiguousReason === 'multiple-size-expressions').length;
      none += reportRows.filter((row) => row.sizeAmbiguous && row.sizeAmbiguousReason !== 'multiple-size-expressions').length;
      details[loaded.fileName] = `${analyzed.summary.sizeFilled}/${analyzed.summary.total}（${(analyzed.summary.sizeCoverage * 100).toFixed(1)}%）`;
    }
    recordMetric('尺寸段覆盖率（4 榜单合计）', `${filled}/${total}（${((filled / total) * 100).toFixed(1)}%）`);
    recordMetric('尺寸段覆盖率（分榜单）', details);
    recordMetric('尺寸待人工复核行数（多尺寸 / 无明确尺寸）', `${ambiguous}（${multi} / ${none}）`);
    assertEqual(filled, 478, 'v2.1.6 严格识别后 478/800');
    assertEqual(filled / total, 0.5975, 'v2.1.6 严格识别后 59.75%');
    assertEqual(ambiguous, 322, '322 行尺寸待人工复核');
    assertEqual(multi, 248, '248 行名称含多个明确尺寸表达');
    assertEqual(none, 74, '74 行无明确尺寸表达（型号数字/无单位）');
    // 待人工行：size 为空、source.size 为空、note 有对应提示
    for (const { analyzed } of reports) {
      for (const row of analyzed.rows) {
        if (!row.sizeAmbiguous) continue;
        assertEqual(row.size, '', '待人工行 size 必须留空');
        assertEqual(row.source.size, '', '待人工行 source.size 为空');
        if (row.sizeAmbiguousReason === 'multiple-size-expressions') {
          assert(row.note.includes('名称含多个尺寸，待人工复核'), `多尺寸行 note：${row.note}`);
        } else {
          assert(row.note.includes('无明确尺寸，待人工补充/采集'), `无明确尺寸行 note：${row.note}`);
        }
      }
    }
    // v2.1.6 硬约束：任何行都不再出现「名称推断」来源
    for (const { analyzed } of reports) {
      for (const row of analyzed.rows) {
        assertEqual(row.source.size === '名称推断', false, 'size 来源不得是名称推断');
        assertEqual(row.source.price === '名称推断', false, 'price 来源不得是名称推断');
      }
    }
  });

  test('名称严格识别（21.2）：唯一明确尺寸才识别；多值/型号数字全部空置；库优先', () => {
    const library = {
      stores: {
        测试类目: {
          name: '测试类目',
          rows: {
            2001: { sku: '2001', name: '库内商品', size: '86/85英寸', price: '5000元至5500元', verified: true, origin: 'seed' },
          },
        },
      },
    };
    const makeRow = (sku, name) => ({ rowNo: 2, sku, name });
    const report = {
      store: '测试类目',
      fileName: '严格尺寸.xlsx',
      headerRow: 0,
      headers: ['SKU', '商品名称'],
      rows: [
        makeRow('1001', '最新款会议平板一体机 55/65英寸 双尺寸可选'),
        makeRow('1002', '海信75英寸会议平板一体机'),
        makeRow('1003', 'TCL会议平板 75英寸 86英寸 通用款'),
        makeRow('1004', 'TCL会议平板一体机 98/100英寸可触控'),
        makeRow('1005', '品牌B会议平板 85英寸/86英寸 双尺寸'),
        makeRow('1006', '型号75MBK7 会议平板一体机'),
        makeRow('1007', 'VH75CAD 商用显示 65寸'),
        makeRow('2001', '库优先商品 55/65英寸 名字多尺寸但库里有'),
      ],
    };
    const rows = analyzeReport(report, library, {}).rows;
    const bySku = Object.fromEntries(rows.map((row) => [row.sku, row]));
    // 1) 55/65 双尺寸 → 空置
    assertEqual(bySku['1001'].size, '');
    assertEqual(bySku['1001'].sizeAmbiguous, true);
    assertEqual(bySku['1001'].sizeAmbiguousReason, 'multiple-size-expressions');
    // 2) 唯一明确尺寸 → 识别
    assertEqual(bySku['1002'].size, '75英寸');
    assertEqual(bySku['1002'].sizeAmbiguous, false);
    assertEqual(bySku['1002'].source.size, '名称解析');
    // 3) 空格分隔的双尺寸 → 空置
    assertEqual(bySku['1003'].size, '');
    assertEqual(bySku['1003'].sizeAmbiguous, true);
    // 4) 98/100（v2.1.5 曾可接受）→ 空置
    assertEqual(bySku['1004'].size, '');
    assertEqual(bySku['1004'].sizeAmbiguous, true);
    // 5) 85/86 → 空置
    assertEqual(bySku['1005'].size, '');
    assertEqual(bySku['1005'].sizeAmbiguous, true);
    // 6) 型号数字 75MBK7 不得当尺寸 → 无明确尺寸，空置待人工
    assertEqual(bySku['1006'].size, '');
    assertEqual(bySku['1006'].sizeAmbiguous, true);
    assert(bySku['1006'].note.includes('无明确尺寸，待人工补充/采集'));
    // 7) 型号数字 + 唯一明确尺寸 → 只认带单位的 65寸
    assertEqual(bySku['1007'].size, '65英寸');
    assertEqual(bySku['1007'].sizeAmbiguous, false);
    // 8) 库命中优先：名称多尺寸不影响库值
    assertEqual(bySku['2001'].size, '86/85英寸');
    assertEqual(bySku['2001'].source.size, '库');
    assertEqual(bySku['2001'].sizeAmbiguous, false);
  });

  test('价格段覆盖率 20.625%（v2.1.6 删同名推断后 165/800，全部来自库）', async () => {
    const { reports } = await analyzedReports();
    let total = 0;
    let filled = 0;
    let fromLibrary = 0;
    let fromCapture = 0;
    let fromName = 0;
    const details = {};
    for (const { loaded, analyzed } of reports) {
      total += analyzed.summary.total;
      filled += analyzed.summary.priceFilled;
      for (const row of analyzed.rows) {
        if (!row.price) continue;
        if (row.source.price === '库') fromLibrary += 1;
        else if (row.source.price === '页面采集') fromCapture += 1;
        else if (row.source.price === '名称推断' || row.source.price === '名称解析') fromName += 1;
      }
      details[loaded.fileName] = `${analyzed.summary.priceFilled}/${analyzed.summary.total}`;
    }
    recordMetric('价格段覆盖率（4 榜单合计）', `${filled}/${total}（${((filled / total) * 100).toFixed(1)}%）`);
    recordMetric('仍需在线采集的 SKU 数', total - filled);
    recordMetric('价格来源（库 / 页面采集 / 名称）', `${fromLibrary} / ${fromCapture} / ${fromName}`);
    assertEqual(filled, 165, 'v2.1.6 删同名推断后 165/800（原 242 中 77 条来自名称推断，已剔除）');
    assertEqual(total - filled, 635);
    assertEqual(fromLibrary, 165, '离线价格全部来自匹配库该 SKU 记录');
    assertEqual(fromCapture, 0, '离线阶段无页面采集');
    assertEqual(fromName, 0, '绝不允许价格来自名称');
  });

  test('价格绝不由名称产生；同名商品不再补 size/price（v2.1.6 21.1）', () => {
    const library = {
      stores: {
        测试类目: {
          name: '测试类目',
          rows: {
            L1: { sku: 'L1', name: '海信75英寸会议平板', size: '75英寸', price: '5000元至5500元', verified: true, origin: 'seed' },
            L2: { sku: 'L2', name: '纯名称无尺寸商品', size: '98/100英寸', price: '10000元至15000元', verified: true, origin: 'seed' },
          },
        },
      },
    };
    const report = {
      store: '测试类目',
      fileName: '名称价格.xlsx',
      headerRow: 0,
      headers: ['SKU', '商品名称'],
      rows: [
        // 同名商品（库里有 L1），行内名称还写了「5000元」→ 价格必须空、不得由名称/同名推断
        { rowNo: 2, sku: 'R1', name: '海信75英寸会议平板 5000元 特价', amountRaw: '', amount: null },
        // 与 L2 同名但行内名称没有任何尺寸表达 → 不得跨行补 size/price
        { rowNo: 3, sku: 'R2', name: '纯名称无尺寸商品 限时优惠', amountRaw: '', amount: null },
        // 库中该 SKU 命中 → size/price 来自库（允许）
        { rowNo: 4, sku: 'L1', name: '海信75英寸会议平板', amountRaw: '', amount: null },
      ],
    };
    const rows = analyzeReport(report, library, {}).rows;
    const bySku = Object.fromEntries(rows.map((row) => [row.sku, row]));
    // R1：价格必须空（名称里 5000元 不是价格；同名 L1 的价格也不得挪用）
    assertEqual(bySku.R1.price, '');
    assertEqual(bySku.R1.source.price, '');
    assertEqual(bySku.R2.price, '');
    assertEqual(bySku.R2.source.price, '');
    // R2 与 L2 同名，但名称无明确尺寸 → 不得借用 L2 的 98/100英寸
    assertEqual(bySku.R2.size, '');
    assertEqual(bySku.R2.sizeAmbiguous, true);
    // R1 名称唯一明确尺寸 → 尺寸可按名称严格解析；价格仍空
    assertEqual(bySku.R1.size, '75英寸');
    assertEqual(bySku.R1.source.size, '名称解析');
    // L1 行：库该 SKU 命中 → 尺寸/价格都来自库
    assertEqual(bySku.L1.price, '5000元至5500元');
    assertEqual(bySku.L1.source.price, '库');
    assertEqual(bySku.L1.size, '75英寸');
    assertEqual(bySku.L1.source.size, '库');
    // 汇总口径：nameInferred 恒为 0，价格来源只有 库/页面采集/手动
    const summary = summarizeRows(rows);
    assertEqual(summary.nameInferred, 0);
    assertEqual(summary.bySource.price['名称推断'], undefined, 'bySource 不再有名称推断口径');
    assertEqual(summary.bySource.price.库, 1, '仅 L1 库命中行有价格来源=库');
  });

  test('采集到页面明确尺寸时清除 sizeAmbiguous；页面尺寸文本多值不采用', () => {
    const report = {
      store: '测试类目',
      fileName: '采集尺寸.xlsx',
      headerRow: 0,
      headers: ['SKU', '商品名称'],
      rows: [
        { rowNo: 2, sku: 'A1', name: '会议平板 55/65英寸 双尺寸', size: '', price: '', source: { size: '', price: '', brand: '', model: '', package: '' }, status: STATUS.PENDING_CAPTURE, captureFailed: false },
        { rowNo: 3, sku: 'A2', name: '会议平板 55/65英寸 双尺寸', size: '', price: '', source: { size: '', price: '', brand: '', model: '', package: '' }, status: STATUS.PENDING_CAPTURE, captureFailed: false },
      ],
    };
    const analyzed = analyzeReport(report, { stores: {} }, {}).rows;
    assertEqual(analyzed[0].sizeAmbiguous, true);
    report.rows = analyzed;
    applyCaptures(report, {
      A1: { sku: 'A1', sizeInch: 75, prices: { hand: 5200 }, priceKind: 'hand', candidateCount: 3, fail: null },
      A2: { sku: 'A2', sizeText: '标题 55/65英寸 双尺寸', prices: { hand: 5300 }, priceKind: 'hand', candidateCount: 3, fail: null },
    }, {});
    const a1 = report.rows.find((row) => row.sku === 'A1');
    const a2 = report.rows.find((row) => row.sku === 'A2');
    assertEqual(a1.size, '75英寸', '页面明确尺寸写入');
    assertEqual(a1.sizeAmbiguous, false, '采集到明确尺寸后清除待人工标记');
    assertEqual(a1.sizeAmbiguousReason, '');
    assertEqual(a2.size, '', '页面尺寸文本多值不采用');
    assertEqual(a2.sizeAmbiguous, true, '页面未给明确尺寸时保持待人工');
  });

  test('成交金额合计（万元）与 Python 基准一致', async () => {
    const { reports } = await analyzedReports();
    const expected = {
      '11月-会议平板.xlsx': 1885.1,
      '11月-会议电视.xlsx': 2360.5,
      '11月-教育教学一体机.xlsx': 1074.5,
      'tangpingnature_商品榜单_热销排名_离线_汇总下载_2026-10-01_2026-10-31.xlsx': 4942.5,
    };
    for (const { loaded, analyzed } of reports) {
      assertClose(analyzed.summary.amountTotal, expected[loaded.fileName], 1e-9, `${loaded.fileName} 金额`);
      assertEqual(analyzed.summary.amountAnomaly, 0);
    }
  });

  test('品牌识别率 ≥90% / ≥98% / ≥85% / ≥85%（回归 96.4%）', async () => {
    const { reports } = await analyzedReports();
    const targets = [0.9, 0.98, 0.85, 0.85];
    const details = {};
    let total = 0;
    let filled = 0;
    reports.forEach(({ loaded, analyzed }, index) => {
      const rate = analyzed.summary.brandFilled / analyzed.summary.total;
      total += analyzed.summary.total;
      filled += analyzed.summary.brandFilled;
      details[loaded.fileName] = `${analyzed.summary.brandFilled}/${analyzed.summary.total}（${(rate * 100).toFixed(1)}%）`;
      assert(rate >= targets[index], `${loaded.fileName} 品牌识别率 ${(rate * 100).toFixed(1)}%`);
    });
    recordMetric('品牌识别率（合计）', `${filled}/${total}（${((filled / total) * 100).toFixed(1)}%）`);
    recordMetric('品牌识别率（分榜单）', details);
    assertEqual(filled, 772, 'v2.1.4 新基准 772/800（96.5%）');
  });

  test('v2.1.3 型号/套餐来源：型号三级不变；套餐仅来自榜单列（教育 141/800，其余 0）', async () => {
    const { reports } = await analyzedReports();
    const modelSources = new Set();
    let modelFilled = 0;
    let packageFilled = 0;
    let total = 0;
    const details = {};
    for (const { loaded, report } of reports) {
      let models = 0;
      let packages = 0;
      for (const row of report.rows) {
        total += 1;
        if (row.model) {
          models += 1;
          modelFilled += 1;
        }
        if (row.package) {
          packages += 1;
          packageFilled += 1;
          assertEqual(row.packageSource, '列', '套餐只能来自榜单列');
          assertEqual(row.source && row.source.package, '列', 'source.package 与 packageSource 一致');
        } else {
          assertEqual(row.packageSource, '', '无套餐时 packageSource 为空');
          assertEqual(row.source && row.source.package, '', '无套餐时 source.package 为空');
        }
        modelSources.add(row.modelSource || '');
        assert(row.source && Object.prototype.hasOwnProperty.call(row.source, 'model'), 'row.source.model 必须存在');
        assert(row.source && Object.prototype.hasOwnProperty.call(row.source, 'package'), 'row.source.package 必须存在');
        assertEqual(row.modelSource, row.source.model, 'modelSource 与 source.model 一致');
        assert(['', '列', '名称', '库'].includes(row.modelSource), `非法 modelSource：${row.modelSource}`);
        assert(row.modelSource || !row.model, '有型号必须有来源');
      }
      details[loaded.fileName] = `型号 ${models}/200；套餐(榜单列) ${packages}/200`;
      if (loaded.fileName === '11月-教育教学一体机.xlsx') {
        // 实测：原表「套餐」列只有 1 行有值（翻页笔+投屏+推车），其余为空；
        // v2.1 的 141 条是「商品名称提取」贡献，v2.1.3 口径修正后不再计入。
        assertEqual(packages, 1, '教育教学「套餐」列仅 1 行有值');
      } else {
        assertEqual(packages, 0, `${loaded.fileName} 没有套餐列 → 套餐必须为 0`);
      }
    }
    recordMetric('型号实际提取率', `${modelFilled}/${total}（${((modelFilled / total) * 100).toFixed(1)}%）`);
    recordMetric('套餐离线覆盖（仅榜单列）', `${packageFilled}/${total}（${((packageFilled / total) * 100).toFixed(1)}%）`);
    recordMetric('型号/套餐来源（分榜单）', details);
    assertEqual(modelFilled, 489, '型号提取逻辑不变（489/800）');
    assertEqual(packageFilled, 1, '套餐仅榜单列：1/800（教育套餐列仅 1 行有值）');
    assert(modelSources.has('名称'), '型号仍支持商品名称提取');
    assert(!modelSources.has('页面采集'), '离线分析阶段没有页面采集来源');
  });

  test('教育教学文件的型号/套餐来自榜单列（优先于名称）', async () => {
    const { reports } = await analyzedReports();
    const education = reports[2].report;
    const fromColumn = education.rows.filter((row) => row.modelSource === '列');
    assert(fromColumn.length >= 1, '至少一行型号来自榜单列');
    assertEqual(fromColumn[0].model, 'MC75HEE');
    const packageFromColumn = education.rows.filter((row) => row.packageSource === '列');
    assert(packageFromColumn.length >= 1, '至少一行套餐来自榜单列');
    assertEqual(packageFromColumn.find((row) => row.package.includes('翻页笔')).package, '翻页笔+投屏+推车');
  });

  test('storeName/storeSource：榜单有店铺列时用列', async () => {
    const { reports } = await analyzedReports();
    for (const { report } of reports) {
      for (const row of report.rows) {
        assert(row.storeName, 'storeName 不能为空');
        assertEqual(row.storeSource, '列', '4 个榜单都有店铺列');
      }
    }
  });

  test('状态机与 summary 字段（含 v2.1 字段）', async () => {
    const { reports } = await analyzedReports();
    const allowed = new Set(Object.values(STATUS));
    for (const { analyzed } of reports) {
      const summary = analyzed.summary;
      for (const field of ['total', 'complete', 'sizeFilled', 'priceFilled', 'sizeCoverage', 'priceCoverage', 'amountTotal', 'amountAnomaly', 'libraryHits', 'nameInferred', 'nameParsed', 'brandFilled', 'brandInferred', 'modelFilled', 'packageFilled', 'reviewNeeded', 'sampled2', 'avgSampleSpread', 'pendingPrice', 'pendingSize', 'failed', 'byStatus', 'bySource', 'byBrandSource']) {
        assert(summary[field] !== undefined, `summary 缺字段 ${field}`);
      }
      assertEqual(summary.byStatus[STATUS.REVIEW_NEEDED], 0, '离线阶段没有需确认');
      assertEqual(summary.pendingPrice, summary.total - summary.priceFilled);
      assertEqual(summary.pendingSize, summary.total - summary.sizeFilled);
      const sumStatuses = Object.values(summary.byStatus).reduce((sum, value) => sum + value, 0);
      assertEqual(sumStatuses, summary.total, 'byStatus 合计 = total');
      for (const row of analyzed.rows) assert(allowed.has(row.status), `未知状态：${row.status}`);
    }
  });

  test('重跑分析：结果稳定；手动值/已确认复核保留', async () => {
    const library = loadSeedLibrary();
    const loaded = await loadReport(REPORT_FILES[1], library);
    const first = analyzeReport(loaded.report, library, {});
    const second = analyzeReport({ ...loaded.report, rows: first.rows }, library, {});
    assertEqual(
      second.rows.map((row) => [row.sku, row.size, row.price, row.model, row.package]),
      first.rows.map((row) => [row.sku, row.size, row.price, row.model, row.package]),
      '重跑结果应稳定',
    );
    const manualRows = first.rows.map((row) => ({ ...row, source: { ...row.source }, review: row.review ? { ...row.review } : row.review }));
    manualRows[0].size = '55英寸';
    manualRows[0].source = { size: '手动', price: manualRows[0].source.price, brand: '', model: '', package: '' };
    manualRows[1].review = { needed: true, reasons: [{ code: 'NEAR_BOUNDARY', text: '边界' }], confirmed: true, confirmedAt: '2026-11-03T10:00:00+08:00' };
    const third = analyzeReport({ ...loaded.report, rows: manualRows }, library, {});
    assertEqual(third.rows[0].size, '55英寸', '手动尺寸段不应被覆盖');
    assertEqual(third.rows[0].source.size, '手动');
    assertEqual(third.rows[1].review.confirmed, true, '重跑分析应保留人工确认');
    assert(third.rows[1].reviewText.includes('已人工确认'));
  });
});

suite('pipeline · v2.1.3 套餐口径迁移 / 页面套餐覆盖', () => {
  test('migrateLegacyPackages：清理 名称/标题/名称解析 套餐，保留 列/页面采集/手动，幂等', () => {
    const reports = [
      {
        fileName: '旧会话.xlsx',
        rows: [
          { rowNo: 2, sku: '1', package: '4+64GB', packageSource: '名称', source: { package: '名称' } },
          { rowNo: 3, sku: '2', package: '标题推测套餐', packageSource: '标题', source: { package: '标题' } },
          { rowNo: 4, sku: '3', package: '名称解析值', packageSource: '名称解析', source: { package: '名称解析' } },
          { rowNo: 5, sku: '4', package: '榜单套餐值', packageSource: '列', source: { package: '列' } },
          { rowNo: 6, sku: '5', package: '会议大屏+摄像头【免费送装一体】', packageSource: '页面采集', source: { package: '页面采集' } },
          { rowNo: 7, sku: '6', package: '手动套餐', packageSource: '手动', source: { package: '手动' } },
          { rowNo: 8, sku: '7', package: '', packageSource: '', source: {} },
        ],
      },
    ];
    const cleaned = migrateLegacyPackages(reports);
    assertEqual(cleaned, 3, '清理 3 条标题/名称来源套餐');
    const rows = reports[0].rows;
    for (const index of [0, 1, 2]) {
      assertEqual(rows[index].package, '', `第 ${index + 1} 条应清空`);
      assertEqual(rows[index].packageSource, '');
      assertEqual(rows[index].source.package, '');
    }
    assertEqual(rows[3].package, '榜单套餐值', '列来源保留');
    assertEqual(rows[3].packageSource, '列');
    assertEqual(rows[4].package, '会议大屏+摄像头【免费送装一体】', '页面采集来源保留');
    assertEqual(rows[5].package, '手动套餐', '手动来源保留');
    assertEqual(rows[5].packageSource, '手动');
    assertEqual(migrateLegacyPackages(reports), 0, '幂等：第二次清理 0 条');
    assertEqual(migrateLegacyPackages([]), 0, '空输入返回 0');
  });

  test('applyCaptures：商品页已选套餐覆盖榜单/标题值，specGroups/packageGroup 透传', () => {
    const report = {
      store: '测试类目',
      fileName: '套餐.xlsx',
      sheetName: 'S',
      headerRow: 0,
      headers: ['SKU', '商品名称', '套餐'],
      rows: [
        {
          rowNo: 2,
          sku: '3001',
          name: '会议平板',
          brand: '',
          storeName: '',
          model: '',
          package: '4+64GB',
          packageSource: '列',
          size: '',
          price: '',
          amountRaw: '',
          amount: 1,
          source: { size: '', price: '', brand: '', model: '', package: '列' },
          status: STATUS.PENDING_CAPTURE,
          captureFailed: false,
          note: '',
        },
      ],
    };
    const specGroups = [
      { label: '版本', selected: '会议大屏+摄像头【免费送装一体】', options: ['会议大屏', '会议大屏+摄像头【免费送装一体】'], source: 'choose-attrs' },
    ];
    const result = applyCaptures(
      report,
      {
        3001: {
          sku: '3001',
          prices: { hand: 5499 },
          priceKind: 'hand',
          candidateCount: 3,
          sizeInch: 100,
          package: '会议大屏+摄像头【免费送装一体】',
          packageGroup: '版本',
          specGroups,
          fail: null,
        },
      },
      {},
    );
    assertEqual(result.updated, 1);
    const row = report.rows[0];
    assertEqual(row.package, '会议大屏+摄像头【免费送装一体】', '页面采集套餐覆盖榜单列套餐');
    assertEqual(row.packageSource, '页面采集');
    assertEqual(row.source.package, '页面采集');
    assertEqual(row.packageGroup, '版本', 'packageGroup 透传');
    assertEqual(row.specGroups, specGroups, 'specGroups 透传');
    assertEqual(row.price, '5000元至5500元');
    assertEqual(row.size, '98/100英寸');
  });

  test('applyCaptures：已补齐行的套餐也能被页面采集补充（不动价格/尺寸）', () => {
    const report = {
      store: '测试类目',
      rows: [
        {
          rowNo: 2,
          sku: '3002',
          name: '完整行',
          brand: '海信',
          storeName: '',
          model: 'MC75HEE',
          modelSource: '列',
          package: '',
          packageSource: '',
          size: '75英寸',
          price: '5000元至5500元',
          source: { size: '库', price: '库', brand: '', model: '列', package: '' },
          status: STATUS.MATCHED,
          captureFailed: false,
          note: '',
        },
      ],
    };
    const result = applyCaptures(
      report,
      { 3002: { sku: '3002', prices: { hand: 8888 }, priceKind: 'hand', candidateCount: 3, package: '会议大屏【免费送装一体】', fail: null } },
      {},
    );
    assertEqual(result.updated, 1);
    const row = report.rows[0];
    assertEqual(row.price, '5000元至5500元', '价格不被覆盖');
    assertEqual(row.size, '75英寸', '尺寸不被覆盖');
    assertEqual(row.package, '会议大屏【免费送装一体】', '套餐补充');
    assertEqual(row.packageSource, '页面采集');
    assertEqual(row.model, 'MC75HEE', '型号来源=列时不被页面覆盖');
    assertEqual(row.modelSource, '列');
  });
});

suite('pipeline · applyCaptures 老行为回归（v2.0 兼容）', () => {
  function makeReport() {
    const emptySource = () => ({ size: '', price: '', brand: '', model: '', package: '' });
    return {
      store: '测试类目',
      fileName: '小榜单.xlsx',
      sheetName: 'S',
      headerRow: 0,
      headers: ['SKU', '商品名称', '成交金额'],
      rows: [
        { rowNo: 2, sku: '1001', name: '完整商品', brand: '', storeName: '', model: '', package: '', amountRaw: '￥10万 ~ ￥20万', amount: 15, size: '55英寸', price: '1000元以下', source: { size: '库', price: '库', brand: '', model: '', package: '' }, status: STATUS.MATCHED, captureFailed: false, note: '' },
        { rowNo: 3, sku: '1002', name: '缺两段商品', brand: '', storeName: '', model: '', package: '', amountRaw: '￥20万 ~ ￥40万', amount: 30, size: '', price: '', source: emptySource(), status: STATUS.PENDING_CAPTURE, captureFailed: false, note: '' },
        { rowNo: 4, sku: '1003', name: '缺价格商品', brand: '', storeName: '', model: '', package: '', amountRaw: '￥5万 ~ ￥10万', amount: 7.5, size: '75英寸', price: '', source: { size: '名称解析', price: '', brand: '', model: '', package: '' }, status: STATUS.PARTIAL, captureFailed: false, note: '' },
        { rowNo: 5, sku: '1004', name: '采集失败商品', brand: '', storeName: '', model: '', package: '', amountRaw: '￥1万 ~ ￥2万', amount: 1.5, size: '', price: '', source: emptySource(), status: STATUS.PENDING_CAPTURE, captureFailed: false, note: '' },
      ],
    };
  }

  function makeCaptures() {
    return {
      1001: { sku: '1001', prices: { hand: 8888, main: 9999, plus: 7777 }, priceKind: 'hand', candidateCount: 3, sizeInch: 86, fail: null },
      1002: { sku: '1002', prices: { hand: 5250, main: 5400, plus: 5100 }, priceKind: 'hand', candidateCount: 3, sizeInch: 100, fail: null },
      1003: { sku: '1003', prices: { hand: 6200, main: 6500, plus: null }, priceKind: 'main', candidateCount: 3, sizeInch: null, fail: null },
      1004: { sku: '1004', prices: {}, priceKind: 'hand', candidateCount: 0, fail: { reason: '页面出现安全验证' } },
    };
  }

  test('补价/补尺寸/失败状态；已补齐行不被覆盖', () => {
    const report = makeReport();
    const result = applyCaptures(report, makeCaptures(), {});
    assertEqual(result.updated, 3, '1002/1003/1004 三行有更新');
    assertEqual(report.rows[0].price, '1000元以下', '已补齐行价格不被覆盖');
    assertEqual(report.rows[0].size, '55英寸');
    assertEqual(report.rows[1].price, '5000元至5500元', 'pickCapturePrice 取 hand=5250');
    assertEqual(report.rows[1].size, '98/100英寸');
    assertEqual(report.rows[1].status, STATUS.CAPTURED);
    assertEqual(report.rows[1].source.price, '页面采集(到手价)', 'v2.1.7 来源细化为到手价');
    assertEqual(report.rows[1].capturePrice, 5250);
    assertEqual(report.rows[1].sampleCount, 1, '老 capture 视为 1 次采样');
    assertEqual(report.rows[2].price, '6000元至7000元', 'priceKind=main → 6500');
    assertEqual(report.rows[2].status, STATUS.CAPTURED);
    assertEqual(report.rows[3].status, STATUS.CAPTURE_FAILED);
    assert(report.rows[3].note.includes('安全验证'));
    assertEqual(result.rows, report.rows, '原地更新 rows');
    assertEqual(result.summary.failed, 1);
  });

  test('rightClosed 边界口径生效', () => {
    const report = makeReport();
    applyCaptures(report, makeCaptures(), { price: { bandBoundary: 'rightClosed' } });
    assertEqual(report.rows[1].price, '5000元至5500元', 'rightClosed：5250 落在 5000~5500 区间');
  });

  test('幂等：重复调用不再产生更新', () => {
    const report = makeReport();
    const captures = makeCaptures();
    const first = applyCaptures(report, captures, {});
    const second = applyCaptures(report, captures, {});
    assert(first.updated > 0);
    assertEqual(second.updated, 0, '第二次调用 updated 应为 0');
  });

  test('只补尺寸 / 只补价格 均可', () => {
    const report = makeReport();
    applyCaptures(report, { 1002: { sku: '1002', prices: {}, sizeInch: 65, fail: null } }, {});
    assertEqual(report.rows[1].size, '65英寸');
    assertEqual(report.rows[1].price, '', '无价格时不乱填');
    assertEqual(report.rows[1].status, STATUS.PARTIAL);

    const report2 = makeReport();
    applyCaptures(report2, { 1002: { sku: '1002', prices: { hand: 1200 }, priceKind: 'hand', candidateCount: 3, fail: null } }, {});
    assertEqual(report2.rows[1].price, '1000元至2000元');
    assertEqual(report2.rows[1].size, '');
    assertEqual(report2.rows[1].status, STATUS.PENDING_MANUAL, '缺尺寸段 → 待补');
  });

  test('captures 支持数组形式；未知 sku 忽略', () => {
    const report = makeReport();
    const result = applyCaptures(
      report,
      [
        { sku: '1002', prices: { hand: 5250 }, priceKind: 'hand', candidateCount: 3, sizeInch: 75 },
        { sku: '不存在的sku', prices: { hand: 1 } },
      ],
      {},
    );
    assertEqual(result.updated, 1);
    assertEqual(report.rows[1].size, '75英寸');
    assertEqual(report.rows[1].price, '5000元至5500元');
  });
});

suite('pipeline · v2.1 参考区间 / 多采样复核 / 人工确认', () => {
  test('buildReferencePriceRange：同店铺+同尺寸段 → p10/p90 与扩展区间', async () => {
    const library = loadSeedLibrary();
    const range = buildReferencePriceRange(library, '大家电 会议电视', '98/100英寸');
    assert(range, '应能构造参考区间');
    assertEqual(range.count, 36, '会议电视 98/100 尺寸段 36 个价格样本');
    assert(range.low > 0 && range.high >= range.low, 'p10 ≤ p90');
    assertEqual(range.sizeBand, '98/100英寸');
    assertEqual(range.store, '大家电 会议电视');
    assertClose(range.expandedLow, Math.round(range.low * 0.3 * 100) / 100, 1e-9, 'expandedLow = p10×0.3');
    assertClose(range.expandedHigh, Math.round(range.high * 3 * 100) / 100, 1e-9, 'expandedHigh = p90×3');
    // 尺寸段样本不足 → 退化为同店铺（用库里没有的尺寸段）
    const fallback = buildReferencePriceRange(library, '大家电 会议电视', '其他尺寸(199英寸)');
    assert(fallback, '应退化为同店铺区间');
    assertEqual(fallback.count, 148, '会议电视全部有价样本');
    assertEqual(fallback.sizeBand, '');
    // 店铺不存在 / 空库 → null
    assertEqual(buildReferencePriceRange(library, '不存在的类目', '55英寸'), null);
    assertEqual(buildReferencePriceRange({ stores: {} }, '大家电 会议电视', '55英寸'), null);
    // 小库（样本 <5）→ null
    const tiny = { stores: { 小店: { name: '小店', rows: { 1: { price: '1000元以下' }, 2: { price: '1000元至2000元' } } } } };
    assertEqual(buildReferencePriceRange(tiny, '小店', ''), null);
  });

  function makeSampleReport() {
    const emptySource = () => ({ size: '', price: '', brand: '', model: '', package: '' });
    return {
      store: '测试类目',
      fileName: '多采样.xlsx',
      sheetName: 'S',
      headerRow: 0,
      headers: ['SKU', '商品名称', '尺寸段'],
      rows: [
        { rowNo: 2, sku: '2001', name: '正常多次采样', storeName: '', model: '', package: '', amountRaw: '', amount: 1, size: '', price: '', source: emptySource(), status: STATUS.PENDING_CAPTURE, captureFailed: false, note: '' },
        { rowNo: 3, sku: '2002', name: '采样不一致', storeName: '', model: '', package: '', amountRaw: '', amount: 2, size: '', price: '', source: emptySource(), status: STATUS.PENDING_CAPTURE, captureFailed: false, note: '' },
        { rowNo: 4, sku: '2003', name: '老式单次采集', storeName: '', model: '', package: '', amountRaw: '', amount: 3, size: '', price: '', source: emptySource(), status: STATUS.PENDING_CAPTURE, captureFailed: false, note: '' },
        { rowNo: 5, sku: '2004', name: '采集失败', storeName: '', model: '', package: '', amountRaw: '', amount: 4, size: '', price: '', source: emptySource(), status: STATUS.PENDING_CAPTURE, captureFailed: false, note: '' },
        { rowNo: 6, sku: '2005', name: '已补齐', storeName: '', model: '', package: '', amountRaw: '', amount: 5, size: '55英寸', price: '1000元以下', source: { size: '库', price: '库', brand: '', model: '', package: '' }, status: STATUS.MATCHED, captureFailed: false, note: '' },
      ],
    };
  }

  function makeSampleCaptures() {
    return {
      2001: { sku: '2001', priceKind: 'hand', candidateCount: 3, sizeInch: 75, fail: null, at: '2026-11-03T10:00:00+08:00', samples: [{ price: 5200, kind: 'hand' }, { price: 5210, kind: 'hand' }, { price: 5205, kind: 'hand' }] },
      2002: { sku: '2002', priceKind: 'hand', candidateCount: 3, sizeInch: 86, fail: null, samples: [{ price: 5000, kind: 'hand' }, { price: 6000, kind: 'hand' }] },
      2003: { sku: '2003', prices: { hand: 5250, main: 5400 }, priceKind: 'hand', candidateCount: 3, sizeInch: 100, fail: null },
      2004: { sku: '2004', prices: {}, priceKind: 'hand', candidateCount: 0, fail: { reason: '页面出现安全验证' } },
      2005: { sku: '2005', prices: { hand: 8888 }, priceKind: 'hand', candidateCount: 3, sizeInch: 86, fail: null },
    };
  }

  test('多采样：中位数选值 + 样本计数/价差 + 需确认状态', () => {
    const report = makeSampleReport();
    const result = applyCaptures(report, makeSampleCaptures(), {});
    const [normal, inconsistent, legacy, failed, complete] = report.rows;
    assertEqual(normal.price, '5000元至5500元');
    assertEqual(normal.status, STATUS.CAPTURED);
    assertEqual(normal.capturePrice, 5205);
    assertEqual(normal.sampleCount, 3);
    assertEqual(normal.sampleSpread, 10);
    assertEqual(normal.review.needed, false);
    assertEqual(inconsistent.price, '5500元至6000元');
    assertEqual(inconsistent.status, STATUS.REVIEW_NEEDED);
    assertEqual(inconsistent.capturePrice, 5500);
    assertEqual(inconsistent.sampleCount, 2);
    assertEqual(inconsistent.sampleSpread, 1000);
    assertEqual(inconsistent.review.needed, true);
    const codes = inconsistent.review.reasons.map((reason) => reason.code);
    assert(codes.includes('SAMPLES_INCONSISTENT'), '应含 SAMPLES_INCONSISTENT');
    assert(codes.includes('NEAR_BOUNDARY'), '中位数正好落在边界 → NEAR_BOUNDARY');
    assert(inconsistent.reviewText.startsWith('需确认：'), '复核文案中文可展示');
    assertEqual(legacy.status, STATUS.CAPTURED);
    assertEqual(legacy.sampleCount, 1);
    assertEqual(legacy.sampleSpread, 0);
    assertEqual(legacy.price, '5000元至5500元');
    assertEqual(failed.status, STATUS.CAPTURE_FAILED);
    assertEqual(complete.price, '1000元以下');
    assertEqual(result.updated, 4, '2001/2002/2003/2004 有更新');
    assertEqual(result.summary.reviewNeeded, 1);
    assertEqual(result.summary.sampled2, 2);
    assertClose(result.summary.avgSampleSpread, 505, 1e-9);
  });

  test('参考区间外 → OUT_OF_REFERENCE（同店铺+同尺寸段库样本）', () => {
    const library = {
      stores: {
        测试类目: {
          name: '测试类目',
          rows: Object.fromEntries(
            Array.from({ length: 6 }, (_, index) => [
              `${9000 + index}`,
              { sku: `${9000 + index}`, name: `同类${index}`, size: '75英寸', price: '8000元至9000元' },
            ]),
          ),
        },
      },
    };
    const report = makeSampleReport();
    report.rows = report.rows.slice(0, 1);
    const captures = {
      2001: { sku: '2001', priceKind: 'hand', candidateCount: 3, sizeInch: 75, fail: null, samples: [{ price: 1000 }, { price: 1000 }] },
    };
    applyCaptures(report, captures, {}, library);
    const row = report.rows[0];
    assert(row.review.reasons.some((reason) => reason.code === 'OUT_OF_REFERENCE'), '应识别偏离参考区间');
    assertEqual(row.status, STATUS.REVIEW_NEEDED);
  });

  test('人工确认流程：UI 直接改 row.review 后重跑 applyCaptures 保持已补采', () => {
    const report = makeSampleReport();
    const captures = makeSampleCaptures();
    applyCaptures(report, captures, {});
    const row = report.rows[1];
    assertEqual(row.status, STATUS.REVIEW_NEEDED);
    row.review.confirmed = true;
    row.review.confirmedAt = '2026-11-03T10:10:00+08:00';
    row.status = STATUS.CAPTURED;
    assert(formatReviewText(row.review).includes('已人工确认'), '确认文案');
    const again = applyCaptures(report, captures, {});
    assertEqual(again.updated, 0, '确认后重跑不产生更新');
    assertEqual(row.status, STATUS.CAPTURED, '确认后保持已补采');
    assertEqual(row.review.confirmed, true);
    const stats = computeStats([report]);
    assertEqual(stats.total.reviewNeeded, 0, '确认后不再计入待确认');
  });

  test('确认信息也可从 capture.review.confirmed 合并', () => {
    const report = makeSampleReport();
    const captures = makeSampleCaptures();
    captures[2002] = { ...captures[2002], review: { confirmed: true, confirmedAt: '2026-11-03T09:00:00+08:00' } };
    applyCaptures(report, captures, {});
    const row = report.rows[1];
    assertEqual(row.review.confirmed, true);
    assertEqual(row.status, STATUS.CAPTURED);
    assert(row.reviewText.includes('已人工确认'));
  });

  test('绝不向库值靠拢：采样中位数与库价格段不同也不纠偏', () => {
    const library = {
      stores: { 测试类目: { name: '测试类目', rows: { 2001: { sku: '2001', name: 'x', size: '75英寸', price: '8000元至9000元' } } } },
    };
    const report = makeSampleReport();
    report.rows = report.rows.slice(0, 1);
    report.rows[0].libraryPriceBand = '8000元至9000元';
    const captures = { 2001: { sku: '2001', priceKind: 'hand', candidateCount: 3, samples: [{ price: 5200 }, { price: 5220 }] } };
    applyCaptures(report, captures, {}, library);
    const row = report.rows[0];
    assertEqual(row.capturePrice, 5210, '选值取样本中位数 5210');
    assertEqual(row.price, '5000元至5500元', '不向库值 8000~9000 靠拢');
    assert(row.review.reasons.some((reason) => reason.code === 'LIB_BAND_MISMATCH'), '库段不同应提示需确认');
  });

  test('analyzeReport 初始化 v2.1 字段结构', async () => {
    const library = loadSeedLibrary();
    const loaded = await loadReport(REPORT_FILES[0], library);
    const analyzed = analyzeReport(loaded.report, library, {});
    for (const row of analyzed.rows.slice(0, 20)) {
      assertEqual(row.sampleCount, 0);
      assertEqual(row.sampleSpread, 0);
      assertEqual(row.capturePrice, null);
      assert(row.review && typeof row.review === 'object', 'review 结构必须存在');
      assertEqual(row.review.needed, false);
      assertEqual(row.review.confirmed, false);
      assertEqual(row.reviewText, '');
    }
  });
});

suite('pipeline · computeStats 统计（回归 + v2.1 字段）', () => {
  test('类目总额 = 各行成交金额中值之和；品牌占比合计 100%', async () => {
    const { reports } = await analyzedReports();
    const reportList = reports.map(({ report }) => report);
    const stats = computeStats(reportList);
    assertEqual(stats.total.rows, 800);
    assertClose(stats.total.amount, 10262.6, 1e-6, '4 榜单总额回归');
    recordMetric('4 榜单成交金额合计（万元）', stats.total.amount);
    recordMetric('统计品牌数（全局）', stats.matrix.brands.length);
    for (const store of stats.byStore) {
      const shareSum = store.brands.reduce((sum, brand) => sum + brand.share, 0);
      assertClose(shareSum, 1, 1e-9, `类目「${store.store}」品牌占比合计`);
      const percent = store.brands.reduce((sum, brand) => sum + brand.sharePercent, 0);
      assertClose(percent, 100, 0.1, `类目「${store.store}」品牌占比合计（%）`);
      assertEqual(store.amount, Math.round(store.brands.reduce((sum, brand) => sum + brand.amount, 0) * 100) / 100);
    }
  });

  test('尺寸段/价格段分布合计 = 800（含动态尺寸段与未补）', async () => {
    const { reports } = await analyzedReports();
    const stats = computeStats(reports.map(({ report }) => report));
    assert(stats.bySize.length >= SIZE_BANDS.length + 1);
    assertEqual(stats.bySize.reduce((sum, item) => sum + item.rows, 0), 800);
    assertEqual(stats.byPrice.reduce((sum, item) => sum + item.rows, 0), 800);
    assertClose(stats.bySize.reduce((sum, item) => sum + item.amount, 0), stats.total.amount, 1e-6);
    assertEqual(stats.missing.price, 635);
    assertEqual(stats.missing.size, 322);
    recordMetric('尺寸段分布档数（固定+动态+未补）', stats.bySize.length);
    const priceBuckets = stats.byPrice.filter((item) => !item.missing);
    assertEqual(priceBuckets.length, PRICE_BANDS.length);
  });

  test('v2.1 只读统计：reviewNeeded / sampled2 / avgSampleSpread / storeNames', () => {
    const report = {
      store: '测试类目',
      rows: [
        { sku: '1', brand: '海信', size: '55英寸', price: '1000元以下', amount: 1, sampleCount: 2, sampleSpread: 20, review: { needed: true, confirmed: false } },
        { sku: '2', brand: '海信', size: '55英寸', price: '1000元以下', amount: 2, sampleCount: 3, sampleSpread: 10, review: { needed: true, confirmed: true } },
        { sku: '3', brand: '创维', size: '75英寸', price: '2000元至2500元', amount: 3, sampleCount: 1, sampleSpread: 0, review: { needed: false, confirmed: false } },
      ],
    };
    const stats = computeStats([report]);
    assertEqual(stats.total.reviewNeeded, 1, 'confirmed 的不算待确认');
    assertEqual(stats.total.sampled2, 2, '采样 ≥2 次的行数');
    assertEqual(stats.total.avgSampleSpread, 15, '(20+10)/2');
    assertEqual(stats.total.storeNames, ['测试类目']);
    assertEqual(stats.byStore[0].reviewNeeded, 1);
    assertEqual(stats.byStore[0].sampled2, 2);
    assertEqual(stats.byStore[0].avgSampleSpread, 15);
  });

  test('空品牌归「未标注品牌」', () => {
    const stats = computeStats([
      { store: 'X', rows: [{ sku: '1', brand: '', size: '55英寸', price: '1000元以下', amount: 1 }, { sku: '2', brand: '海信', size: '55英寸', price: '1000元以下', amount: 3 }] },
    ]);
    assert(stats.byStore[0].brands.map((brand) => brand.brand).includes('未标注品牌'));
  });
});

suite('pipeline · 导出组装（回填 16 列 / 结果 / 备份，v2.1.5）', () => {
  test('回填导出：每个榜单 1 个 sheet、16 列=界面同款（操作列留空）', async () => {
    const { reports } = await analyzedReports();
    for (const index of [0, 1, 2, 3]) {
      const { report } = reports[index];
      const payload = buildBackfillWorkbook(report);
      assertEqual(payload.sheets.length, 1, `${report.fileName} 只输出 1 个数据 sheet`);
      const sheet = payload.sheets[0];
      const base = report.fileName.replace(/\.xlsx$/i, '');
      const shortName = base.length > 16 ? `${base.slice(0, 16)}…` : base;
      assertEqual(sheet.name, shortName, 'sheet 名=榜单简称');
      assertEqual(sheet.columns.map((column) => column.header), BACKFILL_EXPORT_HEADERS);
      assertEqual(BACKFILL_EXPORT_HEADERS, [...PAIR_EXPORT_HEADERS, '操作']);
      assertEqual(sheet.columns.length, 16);
      assertEqual(sheet.rows.length, report.rows.length, '每行一行数据');
      assertEqual(sheet.rows[0].length, 16);
      assertEqual(sheet.rows[0][0], `${shortName} #${report.rows[0].rowNo}`, '「行」=榜单简称 #行号');
      assertEqual(sheet.rows[0][15], '', '操作列留空');
      // eslint-disable-next-line no-await-in-loop
      const { inspection } = await writeAndInspect(writeXlsx, payload, `backfill-v215-${index}.xlsx`);
      assertEqual(inspection.sheets.length, 1, '不保留原文件其它 sheet');
      assertEqual(inspection.sheets[0].max_column, 16);
      assertEqual(inspection.sheets[0].max_row, report.rows.length + 1, '1 表头 + 数据行');
      assertEqual(inspection.sheets[0].rows[0], BACKFILL_EXPORT_HEADERS, 'openpyxl 表头逐字一致');
      assertEqual(inspection.sheets[0].freeze, 'A2');
    }
  });

  test('回填导出：当前价格/入库状态/数据来源取值与界面一致', async () => {
    const { library, reports } = await analyzedReports();
    const report = cloneReport(reports[1].report);
    annotateLibraryStates([report], library);
    report.rows[0].capturePrice = 5333;
    report.rows[1].capturePrice = null;
    const payload = buildBackfillWorkbook(report);
    const header = payload.sheets[0].columns.map((column) => column.header);
    const currentColumn = header.indexOf('当前价格(元)');
    const stateColumn = header.indexOf('入库状态');
    const sourceColumn = header.indexOf('数据来源');
    assertEqual(payload.sheets[0].rows[0][currentColumn], 5333, '当前价格数字');
    assertEqual(payload.sheets[0].rows[1][currentColumn], null, '无采集 null');
    assert(['已确认', '库数据不全', '新 SKU', '待确认写入'].includes(payload.sheets[0].rows[0][stateColumn]), '入库状态中文');
    assert(payload.sheets[0].rows[0][sourceColumn].includes('：'), '数据来源合并文案');
  });

  test('采集后回填：价格段列与当前价格列都出现新补的值', async () => {
    const { reports } = await analyzedReports();
    const report = cloneReport(reports[1].report);
    const captures = {};
    let count = 0;
    for (const row of report.rows) {
      if (row.price) continue;
      if (count >= 10) break;
      captures[row.sku] = { sku: row.sku, prices: { hand: 5200 + count * 100 }, priceKind: 'hand', candidateCount: 3, fail: null };
      count += 1;
    }
    const applied = applyCaptures(report, captures, {});
    assertEqual(applied.updated, 10);
    const payload = buildBackfillWorkbook(report);
    const header = payload.sheets[0].columns.map((column) => column.header);
    const priceColumn = header.indexOf('价格段');
    const currentColumn = header.indexOf('当前价格(元)');
    let filled = 0;
    let currentFilled = 0;
    for (const row of payload.sheets[0].rows) {
      if (row[priceColumn]) filled += 1;
      if (row[currentColumn] != null) currentFilled += 1;
    }
    assertEqual(filled, 99, 'v2.1.6 会议电视库价 89 + 采集补 10 = 99');
    assertEqual(currentFilled, 10, '10 条采集行有当前价格');
    const capturedRowIndex = report.rows.findIndex((row) => row.sku in captures);
    assertEqual(payload.sheets[0].rows[capturedRowIndex][currentColumn], report.rows[capturedRowIndex].capturePrice);
  });

  test('回填不依赖原文件：报告缺 originalSheets/headerRow 也输出 16 列单 sheet', async () => {
    const { reports } = await analyzedReports();
    const bare = cloneReport(reports[0].report);
    delete bare.originalSheets;
    delete bare.headerRow;
    const payload = buildBackfillWorkbook(bare);
    assertEqual(payload.sheets.length, 1);
    assertEqual(payload.sheets[0].columns.length, 16);
    assertEqual(payload.sheets[0].rows.length, bare.rows.length);
  });

  test('当前价格列：回填/配对明细取值=row.capturePrice，无采集为 null', async () => {
    const { reports } = await analyzedReports();
    const report = cloneReport(reports[1].report);
    report.rows[0].capturePrice = 5333;
    report.rows[1].capturePrice = null;
    // 回填
    const backfill = buildBackfillWorkbook(report);
    const header = backfill.sheets[0].columns.map((column) => column.header);
    const currentColumn = header.indexOf('当前价格(元)');
    assert(currentColumn >= 0);
    assertEqual(backfill.sheets[0].rows[0][currentColumn], 5333, '回填当前价格写入数字');
    assertEqual(backfill.sheets[0].rows[1][currentColumn], null, '无采集写 null');
    // 结果工作簿配对明细
    const stats = computeStats([report]);
    const result = buildResultWorkbook([report], stats, {});
    const pair = result.sheets.find((sheet) => sheet.name === '配对_1');
    const columnIndex = pair.columns.map((column) => column.header).indexOf('当前价格(元)');
    assert(columnIndex >= 0);
    assertEqual(pair.rows[0][columnIndex], 5333, '配对明细当前价格数字');
    assertEqual(pair.rows[1][columnIndex], null, '配对明细无采集 null');
  });



  test('结果工作簿（无待确认）仍为 7 个 sheet，配对明细 15 列且列序与界面一致', async () => {
    const { reports } = await analyzedReports();
    const reportList = reports.map(({ report }) => report);
    const stats = computeStats(reportList);
    const payload = buildResultWorkbook(reportList, stats, {});
    assertEqual(payload.sheets.map((sheet) => sheet.name), ['统计_类目', '统计_尺寸段', '统计_价格段', '配对_1', '配对_2', '配对_3', '配对_4']);
    const pairSheet = payload.sheets.find((sheet) => sheet.name === '配对_2');
    assertEqual(pairSheet.columns.length, 15);
    assertEqual(pairSheet.columns.map((column) => column.header), PAIR_EXPORT_HEADERS);
    assertEqual(PAIR_EXPORT_HEADERS, ['行', 'SKU', '商品名称', '店铺', '品牌', '型号', '套餐', '尺寸段', '价格段', '当前价格(元)', '成交金额(万元)', '采样', '数据来源', '状态', '入库状态']);
    assertEqual(pairSheet.rows.length, 200);
    assertEqual(pairSheet.rows[0][0], '11月-会议电视 #2', '「行」= 榜单简称 #行号');
    assertEqual(pairSheet.rows[0][1], reportList[1].rows[0].sku, '第二列 SKU');
    assertEqual(pairSheet.rows[0][14], '', '未做库标注时入库状态为空');
    const { inspection } = await writeAndInspect(writeXlsx, payload, 'result-v214.xlsx');
    assertEqual(inspection.sheets.length, 7);
    assertEqual(inspection.sheets[3].max_row, 201);
    assertEqual(inspection.sheets[3].max_column, 15);
    assertEqual(inspection.sheets[3].rows[0], PAIR_EXPORT_HEADERS, 'openpyxl 表头=PAIR_EXPORT_HEADERS');
  });

  test('结果工作簿（有待确认）→ 8 个 sheet，「待确认」sheet 列/原因正确（当前价格(元) 表头）', async () => {
    const { reports } = await analyzedReports();
    const report = cloneReport(reports[1].report);
    report.rows[0].review = {
      needed: true,
      reasons: [{ code: 'SAMPLES_INCONSISTENT', text: '多次采样价差超容差（差 1000 元）' }],
      confirmed: false,
      confirmedAt: '',
      sampleCount: 2,
      spread: 1000,
    };
    report.rows[0].capturePrice = 5500;
    report.rows[0].sampleCount = 2;
    report.rows[0].sampleSpread = 1000;
    const stats = computeStats([report]);
    const payload = buildResultWorkbook([report], stats, {});
    assertEqual(payload.sheets.map((sheet) => sheet.name), ['统计_类目', '统计_尺寸段', '统计_价格段', '待确认', '配对_1']);
    const pending = payload.sheets.find((sheet) => sheet.name === '待确认');
    assertEqual(pending.columns.map((column) => column.header), ['榜单', '行号', 'SKU', '商品名称', '店铺', '品牌', '型号', '尺寸段', '价格段', '当前价格(元)', '采样', '复核原因']);
    assertEqual(pending.columns.length, 12);
    assertEqual(pending.rows.length, 1);
    assertEqual(pending.rows[0][1], 2, '行号');
    assertEqual(pending.rows[0][9], 5500, '当前价格');
    assert(pending.rows[0][10].includes('2 次'), '采样次数');
    assert(pending.rows[0][11].includes('价差超容差'), '复核原因中文');
    const { inspection } = await writeAndInspect(writeXlsx, payload, 'result-v213-pending.xlsx');
    assertEqual(inspection.sheets.length, 5);
  });

  test('buildBackupJson：包含 library/session/captures 与计数', async () => {
    const { library, reports } = await analyzedReports();
    const session = { version: 1, reports: reports.map(({ report }) => report), activeReportId: 'r-1' };
    const captures = { 1001: { sku: '1001', prices: { hand: 999 } } };
    const backup = buildBackupJson({ library, session, captures });
    assertEqual(backup.schema, 'market-share.backup/v1');
    assertEqual(backup.counts.stores, 4);
    assertEqual(backup.counts.skus, 1101);
    assertEqual(backup.counts.reports, 4);
    assertEqual(backup.counts.rows, 800);
    assertEqual(backup.counts.captures, 1);
  });
});

suite('pipeline · v2.1.4 库状态标注 / 不写匹配库 / 导出表头一致', () => {
  test('annotateLibraryStates：4 榜单 160/192/447/1（合计 800，pending=脚本已补齐待确认）', async () => {
    const { library, reports } = await analyzedReports();
    // 用克隆，避免污染后续用例的缓存行
    const clones = reports.map(({ report }) => cloneReport(report));
    const stats = annotateLibraryStates(clones, library);
    assertEqual(stats.verified, 160, '库内齐全（已核验）160 行');
    assertEqual(stats.incomplete, 192, '库内数据不全 192 行');
    assertEqual(stats.new, 447, '库中无此 SKU 447 行');
    assertEqual(stats.pending, 1, '脚本已补齐尺寸段+价格段但未人工确认写入 1 行');
    assertEqual(stats.total, 800);
    assertEqual(stats.verified + stats.incomplete + stats.new + stats.pending, stats.total);
    const allowed = new Set(Object.keys(LIB_STATE_LABELS));
    for (const report of clones) {
      for (const row of report.rows) {
        assert(allowed.has(row.libState), `非法 libState：${row.libState}`);
        if (row.libState === 'pending') assert(row.size && row.price, 'pending 行必须已有尺寸段+价格段');
      }
    }
    recordMetric('入库状态（4 榜单，未采集）', `verified ${stats.verified} / incomplete ${stats.incomplete} / new ${stats.new} / pending ${stats.pending}`);
    // 重复调用幂等
    const again = annotateLibraryStates(clones, library);
    assertEqual(again.pending, 1);
    assertEqual(again.new, 447);
  });

  test('annotateLibraryStates：旧库记录缺 verified 时按 source 推断（库/导入→已核验）', () => {
    const legacyLibrary = {
      stores: {
        旧店: {
          name: '旧店',
          rows: {
            1: { sku: '1', size: '55英寸', price: '1000元以下', source: '库' },
            2: { sku: '2', size: '75英寸', price: '', source: '库' },
            3: { sku: '3', size: '65英寸', price: '3000元至3500元', source: '页面采集' },
          },
        },
      },
    };
    const report = {
      store: '旧店',
      rows: [
        { rowNo: 2, sku: '1' },
        { rowNo: 3, sku: '2' },
        // 行上已有尺寸段+价格段（脚本补齐，未人工确认）→ pending
        { rowNo: 4, sku: '3', size: '65英寸', price: '3000元至3500元', source: { size: '名称解析', price: '页面采集' } },
        { rowNo: 5, sku: '9' },
      ],
    };
    const stats = annotateLibraryStates([report], legacyLibrary);
    assertEqual(stats.verified, 1, 'source=库 且有尺寸+价格 → verified');
    assertEqual(stats.incomplete, 1, '缺价格 → incomplete');
    assertEqual(stats.pending, 1, '非可信来源且尺寸+价格齐全 → pending');
    assertEqual(stats.new, 1, '库中无 SKU → new');
  });

  test('annotateLibraryStates：采集补齐一条 new 行 → pending+1（不写库）', async () => {
    const { library, reports } = await analyzedReports();
    const clones = reports.map(({ report }) => cloneReport(report));
    const before = annotateLibraryStates(clones, library);
    const targetReport = clones.find((report) => report.rows.some((row) => row.libState === 'new'));
    assert(targetReport, '应存在新 SKU 行');
    const targetRow = targetReport.rows.find((row) => row.libState === 'new');
    // 采集补齐尺寸段+价格段 → 变 pending
    targetRow.size = '75英寸';
    targetRow.source.size = '页面采集';
    targetRow.price = '5000元至5500元';
    targetRow.source.price = '页面采集';
    targetRow.capturePrice = 5200;
    const after = annotateLibraryStates(clones, library);
    assertEqual(after.pending, before.pending + 1, '采集补齐后 pending +1');
    assertEqual(after.new, before.new - 1, 'new 少 1');
    assertEqual(after.total, before.total);
    assertEqual(targetRow.libState, 'pending');
    assertEqual(LIB_STATE_LABELS.pending, '待确认写入');
  });

  test('analyzeReport / applyCaptures 绝不写匹配库（记录数/内容不变）', async () => {
    const { library, reports } = await analyzedReports();
    const snapshot = JSON.stringify(library);
    const report = cloneReport(reports[1].report);
    // 再跑一次分析 + 一批采集
    const analyzed = analyzeReport({ ...report, rows: report.rows.map((row) => ({ ...row, source: { ...row.source } })) }, library, {});
    const captures = {};
    let count = 0;
    for (const row of analyzed.rows) {
      if (row.price) continue;
      if (count >= 5) break;
      captures[row.sku] = { sku: row.sku, prices: { hand: 5200 + count * 100 }, priceKind: 'hand', candidateCount: 3, fail: null };
      count += 1;
    }
    analyzeReport({ ...report, rows: analyzed.rows }, library, {});
    applyCaptures({ ...report, rows: analyzed.rows }, captures, {}, library);
    annotateLibraryStates([{ ...report, rows: analyzed.rows }], library);
    assertEqual(JSON.stringify(library), snapshot, '分析/采集/标注后匹配库内容应完全不变');
    assertEqual(Object.keys(library.stores).length, 4);
  });

  test('pairExportRows：表头 15 列与界面一致、行数 800、入库状态中文', async () => {
    const { library, reports } = await analyzedReports();
    const clones = reports.map(({ report }) => cloneReport(report));
    annotateLibraryStates(clones, library);
    const exported = pairExportRows(clones);
    assertEqual(exported.headers, PAIR_EXPORT_HEADERS);
    assertEqual(exported.headers.length, 15);
    assertEqual(exported.rows.length, 800);
    const labels = new Set(exported.rows.map((row) => row[14] || ''));
    assert(labels.has('已确认'), '包含「已确认」行');
    assert(labels.has('库数据不全'), '包含「库数据不全」行');
    assert(labels.has('新 SKU'), '包含「新 SKU」行');
    assert(labels.has('待确认写入'), '包含「待确认写入」行');
    const first = exported.rows[0];
    assertEqual(first.length, 15);
    assert(first[0].includes('#'), '「行」列格式=榜单简称 #行号');
    assertEqual(first[14], '库数据不全', '会议平板首行：库记录存在但无尺寸/价格');
    // 数据来源为合并文案
    const sourceText = first[12];
    assert(sourceText.includes('尺寸段：') || sourceText.includes('价格段：'), `数据来源：${sourceText}`);
  });

  test('buildResultWorkbook 配对明细写入 入库状态', async () => {
    const { library, reports } = await analyzedReports();
    const clones = reports.map(({ report }) => cloneReport(report));
    annotateLibraryStates(clones, library);
    const stats = computeStats(clones);
    const payload = buildResultWorkbook(clones, stats, {});
    const pair = payload.sheets.find((sheet) => sheet.name === '配对_2');
    assertEqual(pair.columns.map((column) => column.header), PAIR_EXPORT_HEADERS);
    assertEqual(pair.rows.length, 200);
    const stateColumn = 14;
    assert(['已确认', '库数据不全', '新 SKU', '待确认写入'].includes(pair.rows[0][stateColumn]), '入库状态中文');
    assertEqual(pair.rows[0][9], null, '未采集当前价格 null');
  });
});

suite('pipeline · 设置与汇总工具（v2.1）', () => {
  test('DEFAULT_SETTINGS / resolveSettings 新增 v2.1 默认值', () => {
    assertEqual(DEFAULT_SETTINGS.capture.mode, 'smart');
    assertEqual(DEFAULT_SETTINGS.capture.maxSamples, 3);
    assertEqual(DEFAULT_SETTINGS.capture.tolerancePct, 0.01);
    assertEqual(DEFAULT_SETTINGS.capture.toleranceAbs, 30);
    assertEqual(DEFAULT_SETTINGS.price.boundaryMarginPct, 0.01);
    assertEqual(DEFAULT_SETTINGS.ui.theme, 'auto');
    assertEqual(resolveSettings().price.bandBoundary, 'rightOpen');
    const merged = resolveSettings({ capture: { mode: 'double' }, price: { bandBoundary: 'rightClosed' }, ui: { theme: 'light' } });
    assertEqual(merged.capture.mode, 'double');
    assertEqual(merged.capture.maxSamples, 3, '老 settings 自动补默认值');
    assertEqual(merged.price.bandBoundary, 'rightClosed');
    assertEqual(merged.ui.theme, 'light');
  });

  test('summarizeRows 覆盖率/复核/采样汇总', () => {
    const summary = summarizeRows([
      { size: '55英寸', price: '1000元以下', amount: 1, model: 'A1', package: '4+64G', sampleCount: 2, sampleSpread: 20, review: { needed: true, confirmed: false }, source: { size: '库', price: '库', model: '名称', package: '名称' }, status: STATUS.REVIEW_NEEDED },
      { size: '', price: '', amount: null, amountRaw: '面议', brand: '', review: { needed: false, confirmed: false }, source: {}, status: STATUS.PENDING_CAPTURE },
    ]);
    assertEqual(summary.total, 2);
    assertEqual(summary.complete, 1);
    assertEqual(summary.sizeCoverage, 0.5);
    assertEqual(summary.priceCoverage, 0.5);
    assertEqual(summary.amountAnomaly, 1);
    assertEqual(summary.modelFilled, 1);
    assertEqual(summary.packageFilled, 1);
    assertEqual(summary.reviewNeeded, 1);
    assertEqual(summary.sampled2, 1);
    assertEqual(summary.avgSampleSpread, 20);
    assertEqual(summary.byStatus[STATUS.REVIEW_NEEDED], 1);
  });
});

suite('pipeline · v2.1.7 采集价格类型 / 价格变化 / 下架分母（22）', () => {
  function pendingRow(sku, name) {
    return {
      rowNo: 2,
      sku,
      name,
      size: '',
      price: '',
      source: { size: '', price: '', brand: '', model: '', package: '' },
      status: STATUS.PENDING_CAPTURE,
      captureFailed: false,
      note: '',
    };
  }

  test('三种 priceKind → 页面采集(到手价/PLUS价/电商平台价)；无 kind → 页面采集；老格式兼容', () => {
    assertEqual(PRICE_KIND_LABELS.hand, '到手价');
    assertEqual(PRICE_KIND_LABELS.plus, 'PLUS价');
    assertEqual(PRICE_KIND_LABELS.main, '电商平台价');
    assertEqual(capturePriceSourceText('hand'), '页面采集(到手价)');
    assertEqual(capturePriceSourceText('plus'), '页面采集(PLUS价)');
    assertEqual(capturePriceSourceText('main'), '页面采集(电商平台价)');
    assertEqual(capturePriceSourceText(''), '页面采集');
    assertEqual(capturePriceSourceText('unknown'), '页面采集');

    const report = {
      store: '测试类目',
      rows: [
        pendingRow('A1', '商品A 75英寸'),
        pendingRow('A2', '商品B 75英寸'),
        pendingRow('A3', '商品C 75英寸'),
        pendingRow('A4', '商品D 75英寸'),
        pendingRow('A5', '商品E 75英寸'),
      ],
    };
    const applied = applyCaptures(report, {
      A1: { sku: 'A1', price: 5200, priceKind: 'hand', priceKindLabel: '到手价' },
      A2: { sku: 'A2', price: 5300, priceKind: 'plus' },
      A3: { sku: 'A3', price: 5400, priceKind: 'main' },
      A4: { sku: 'A4', price: 5500 },
      // 老采集记录格式：prices + priceKind（v2.0/v2.1 老数据）
      A5: { sku: 'A5', prices: { hand: 5600 }, priceKind: 'hand' },
    }, {});
    assertEqual(applied.updated, 5);
    const bySku = Object.fromEntries(report.rows.map((row) => [row.sku, row]));
    assertEqual(bySku.A1.source.price, '页面采集(到手价)');
    assertEqual(bySku.A1.priceKind, 'hand');
    assertEqual(bySku.A1.priceKindLabel, '到手价');
    assertEqual(bySku.A2.source.price, '页面采集(PLUS价)');
    assertEqual(bySku.A2.priceKind, 'plus');
    assertEqual(bySku.A3.source.price, '页面采集(电商平台价)');
    assertEqual(bySku.A3.priceKind, 'main');
    assertEqual(bySku.A4.source.price, '页面采集', '无 kind 保持笼统页面采集');
    assertEqual(bySku.A4.priceKind, undefined, '无 kind 不写 priceKind');
    assertEqual(bySku.A5.source.price, '页面采集(到手价)', '老 prices+priceKind 记录兼容并细化来源');
    assert(bySku.A1.price, '价格段已写入');
    assertEqual(bySku.A1.price, bySku.A2.price, '5200/5300 同价格段');
  });

  test('priceChanges 记录 + note 提示 + 采集元数据保留（候选摘要≤12）', () => {
    const report = { store: '测试类目', rows: [pendingRow('B1', '商品B 75英寸')] };
    const candidates = Array.from({ length: 15 }, (unused, index) => ({
      price: 24000 + index,
      kind: 'hand',
      text: `¥${24000 + index}`,
      cls: 'p-price',
      font: 24,
      strike: false,
      // 源版候选 rect 格式：{left, top, width, height}
      rect: { left: index, top: 1, width: 10, height: 10 },
    }));
    applyCaptures(report, {
      B1: {
        sku: 'B1',
        sizeInch: 75,
        samples: [{ price: 25099 }],
        price: 25099,
        priceKind: 'hand',
        priceKindLabel: '到手价',
        priceChanges: [{ from: 24699, to: 25099 }],
        priceRect: { x: 12, y: 34, w: 120, h: 30 },
        sourceLabel: 'p-price j-price',
        candidates,
        candidateCount: 15,
      },
    }, {});
    const row = report.rows[0];
    assertEqual(row.priceChanges.length, 1);
    assertEqual(row.priceChanges[0].from, 24699);
    assertEqual(row.priceChanges[0].to, 25099);
    assertEqual(row.source.price, '页面采集(到手价)');
    assertEqual(row.priceKind, 'hand');
    assertEqual(row.priceKindLabel, '到手价');
    assertEqual(row.priceRect.x, 12);
    assertEqual(row.priceRect.w, 120);
    assertEqual(row.priceRect.left, 12, '同时保留源版 left 别名');
    assertEqual(row.priceRect.width, 120);
    assertEqual(row.sourceLabel, 'p-price j-price');
    assertEqual(row.candidates.length, 12, '候选价只保留前 12 条摘要');
    assertEqual(row.candidates[0].font, 24);
    assertEqual(row.candidates[0].rect.x, 0, '候选 rect 兼容源版 left 格式');
    assertEqual(row.candidates[0].rect.w, 10);
    assertEqual(row.candidates[0].rect.width, 10);
    assert(row.note.includes('页面价格变动 24699→25099（已采用最新）'), `note：${row.note}`);
    assertEqual(row.size, '75英寸', '页面尺寸仍可写入');
  });

  test('priceRect 归一兼容源版 {left,top,width,height} 与 {x,y,w,h}（终验修复）', () => {
    // normalizePriceRect 直接契约
    const sourceRect = normalizePriceRect({ left: 820, top: 120, width: 180, height: 40 });
    assertEqual(sourceRect.x, 820);
    assertEqual(sourceRect.y, 120);
    assertEqual(sourceRect.w, 180);
    assertEqual(sourceRect.h, 40);
    assertEqual(sourceRect.left, 820);
    assertEqual(sourceRect.top, 120);
    assertEqual(sourceRect.width, 180);
    assertEqual(sourceRect.height, 40);
    const docRect = normalizePriceRect({ x: 5, y: 6, w: 7, h: 8 });
    assertEqual(docRect.x, 5);
    assertEqual(docRect.left, 5, '文档格式也补齐 left 别名');
    assertEqual(normalizePriceRect({}), null, '无有效值 → null');
    assertEqual(normalizePriceRect(null), null);
    assertEqual(normalizePriceRect({ left: '820', top: '120', width: '180', height: '40' }).x, 820, '字符串数值归一为 number');

    // 端到端：applyCaptures 存源版格式，row.priceRect.x/y/w/h 不再是 0
    const report = { store: '测试类目', rows: [pendingRow('B2', '商品B2 75英寸')] };
    applyCaptures(report, {
      B2: { sku: 'B2', price: 5200, priceKind: 'hand', sizeInch: 75, priceRect: { left: 820, top: 120, width: 180, height: 40 } },
    }, {});
    const row = report.rows[0];
    assertEqual(row.priceRect.x, 820, 'UI 徽标 title 读取 x 坐标正确');
    assertEqual(row.priceRect.y, 120);
    assertEqual(row.priceRect.w, 180);
    assertEqual(row.priceRect.h, 40);
    assertEqual(row.priceRect.left, 820);
    assertEqual(row.priceRect.width, 180);
  });

  test('下架行不计入进度分母：10 行含 2 下架 → progressDenom=8', () => {
    const report = {
      store: '测试类目',
      rows: [],
    };
    // 8 行已齐全 + 2 行下架
    for (let index = 1; index <= 8; index += 1) {
      const row = pendingRow(`C${index}`, `齐全商品${index} 75英寸`);
      row.size = '75英寸';
      row.price = '5000元至5500元';
      report.rows.push(row);
    }
    const off1 = pendingRow('D1', '下架商品1 75英寸');
    off1.offSale = true;
    off1.offSaleReason = '已下架';
    off1.status = STATUS.CAPTURE_FAILED;
    off1.captureFailed = true;
    report.rows.push(off1);
    const off2 = pendingRow('D2', '下架商品2 75英寸');
    report.rows.push(off2);

    applyCaptures(report, {
      D1: { sku: 'D1', fail: { code: 'offSale', reason: '商品下架' } },
      D2: { sku: 'D2', offSale: true },
    }, {});
    const row1 = report.rows.find((row) => row.sku === 'D1');
    const row2 = report.rows.find((row) => row.sku === 'D2');
    assertEqual(row1.offSale, true);
    assertEqual(row1.status, STATUS.CAPTURE_FAILED);
    assert(row1.note.includes('已下架'), '下架原因文案');
    assertEqual(row2.offSale, true);
    assertEqual(row2.status, STATUS.CAPTURE_FAILED);

    const stats = computeStats(report);
    assertEqual(stats.total.rows, 10);
    assertEqual(stats.total.offSale, 2, '2 行已下架');
    assertEqual(stats.total.progressDenom, 8, '分母排除已下架 = 8');
    assertEqual(stats.total.progressComplete, 8);
    assertEqual(stats.total.pending, 0);
    assertEqual(stats.total.progressPct, 100);
    assertEqual(stats.offSale, 2, '顶层别名');
    assertEqual(stats.progressDenom, 8);
    assertEqual(stats.progressPct, 100);
    assertEqual(stats.byStore[0].offSale, 2);
    assertEqual(stats.byStore[0].progressDenom, 8);
    assertEqual(stats.byStore[0].progressPct, 100);

    // 混合：有效 8 行中仅 4 行齐全 → 50%
    for (let index = 1; index <= 4; index += 1) {
      const row = report.rows.find((item) => item.sku === `C${index}`);
      row.size = '';
      row.price = '';
    }
    const half = computeStats(report);
    assertEqual(half.total.progressDenom, 8, '下架仍不计入分母');
    assertEqual(half.total.progressComplete, 4);
    assertEqual(half.total.progressPct, 50);
  });

  test('重跑分析保留已下架状态；再次成功采集清除下架标记', () => {
    const offRow = pendingRow('E1', '下架商品 75英寸');
    offRow.offSale = true;
    offRow.offSaleReason = '已下架';
    offRow.status = STATUS.CAPTURE_FAILED;
    offRow.captureFailed = true;
    offRow.note = '采集失败：已下架';
    const report = { store: '测试类目', rows: [offRow] };
    const analyzed = analyzeReport(report, { stores: {} }, {});
    assertEqual(analyzed.rows[0].offSale, true);
    assertEqual(analyzed.rows[0].status, STATUS.CAPTURE_FAILED, '重跑分析不丢失已下架状态');
    assertEqual(analyzed.rows[0].note.includes('已下架'), true);
    assertEqual(analyzed.summary.offSale, 1, 'summary 也统计已下架');
    assertEqual(analyzed.summary.progressDenom, 0);
    assertEqual(analyzed.summary.progressPct, 0);

    report.rows = analyzed.rows;
    applyCaptures(report, {
      E1: { sku: 'E1', price: 5200, priceKind: 'hand', sizeInch: 75 },
    }, {});
    const row = report.rows[0];
    assertEqual(row.offSale, false, '成功采集清除下架标记');
    assertEqual(row.offSaleReason, '');
    assert(row.status !== STATUS.CAPTURE_FAILED, '成功采集后状态不再是采集失败');
  });

  test('导出「数据来源」列文案随细化（列结构不变：配对 15 列）', () => {
    const report = { store: '测试类目', fileName: '导出.xlsx', rows: [pendingRow('F1', '商品F 75英寸')] };
    applyCaptures(report, { F1: { sku: 'F1', price: 5200, priceKind: 'hand', sizeInch: 75 } }, {});
    const exported = pairExportRows([report]);
    assertEqual(exported.headers, PAIR_EXPORT_HEADERS);
    assertEqual(exported.headers.length, 15, '列结构不变');
    const row = exported.rows[0];
    assertEqual(row.length, 15);
    assert(row[12].includes('价格段：页面采集(到手价)'), `数据来源列：${row[12]}`);
    assert(row[12].includes('尺寸段：页面采集'), `数据来源列：${row[12]}`);
  });
});
