/** tests/core/test-header-map.mjs —— 表头自适应/榜单解析/SKU 文本化/类目绑定 */
import { suite, test, assert, assertEqual } from './harness.mjs';
import {
  FIELD_ALIASES,
  pickDataSheet,
  detectHeader,
  normalizeSku,
  parseReportSheet,
  suggestStoreBinding,
} from '../../extension/lib/header-map.js';
import { REPORT_FILES } from './paths.mjs';
import { loadReport, loadSeedLibrary } from './helpers.mjs';

/** 造一个最小 sheet */
function makeSheet(name, rows) {
  return { name, rows };
}

/** 造 n 行数据（每行给定 sku） */
function makeDataRows(n, columns) {
  const rows = [];
  for (let index = 0; index < n; index += 1) {
    rows.push(columns.map((column) => String(column(index))));
  }
  return rows;
}

suite('header-map · pickDataSheet', () => {
  test('4 个真实榜单都选中第 0 个数据页', async () => {
    const library = loadSeedLibrary();
    for (const entry of REPORT_FILES) {
      // eslint-disable-next-line no-await-in-loop
      const loaded = await loadReport(entry, library);
      assertEqual(loaded.picked.index, 0, `${entry.fileName} 应选中 sheet 0`);
      assert(loaded.picked.reason.includes('SKU 列'), 'reason 应说明命中 SKU 列');
    }
  });

  test('教育教学一体机：说明页被跳过（列数<3）', async () => {
    const library = loadSeedLibrary();
    const loaded = await loadReport(REPORT_FILES[2], library);
    assertEqual(loaded.sheets.length, 2);
    const infoScore = loaded.picked.scores.find((score) => score.name === '尺寸段和价格段');
    assert(infoScore.skipped, '说明页应被跳过');
    assert(infoScore.reason.includes('列数'), '跳过原因应是列数不足');
    assertEqual(loaded.picked.name, '教学教育一体机');
  });

  test('数据页在第二个 sheet 时也能挑中（active sheet 是说明页的等价场景）', () => {
    const explanation = makeSheet('尺寸段和价格段', [
      ['尺寸段', '价格段(17段)'],
      ['55英寸', '1000元以下'],
    ]);
    const data = makeSheet('教学教育一体机', [
      ['sku', '商品名称', '品牌', '成交金额', '店铺名称'],
      ...makeDataRows(30, [(i) => `sku-${i}`, (i) => `商品${i}`, () => '海信', () => '￥100万 ~ ￥200万', () => '海信旗舰店']),
    ]);
    const picked = pickDataSheet([explanation, data]);
    assertEqual(picked.index, 1);
    assertEqual(picked.name, '教学教育一体机');
  });

  test('全部是说明页时 index=-1 且给出人话原因', () => {
    const picked = pickDataSheet([
      makeSheet('说明1', [['尺寸段', '价格段'], ['55英寸', '1000元以下']]),
      makeSheet('说明2', [['价格段(17段)'], ['1000元以下']]),
    ]);
    assertEqual(picked.index, -1);
    assert(picked.reason.includes('SKU'), '原因应提示找不到 SKU 列');
  });
});

suite('header-map · detectHeader 别名自适应', () => {
  test('本月三种真实表头：SKU ID / SPU ID / sku', () => {
    const variants = [
      ['时间', '排名', '商品名称', 'SKU ID', '店铺名称', '成交金额'],
      ['时间', '排名', '商品名称', 'SPU ID', '店铺名称', '成交金额'],
      ['sku', '店铺', '品牌', '商品名称', 'SKU ID', '成交金额'],
    ];
    for (const headers of variants) {
      const rows = [headers, ...makeDataRows(5, headers.map(() => (i) => `v${i}`))];
      const detection = detectHeader(rows);
      assertEqual(detection.headerRow, 0, `表头行：${headers.join('/')}`);
      assert(detection.columns.sku >= 0, `应识别 SKU 列：${headers.join('/')}`);
      assertEqual(detection.columns.name, headers.indexOf('商品名称'));
      assertEqual(detection.columns.amount, headers.indexOf('成交金额'));
      assertEqual(detection.columns.store, headers.indexOf('店铺名称') >= 0 ? headers.indexOf('店铺名称') : headers.indexOf('店铺'));
    }
  });

  test('旧工具硬编码别名全兼容（含全角括号）', () => {
    const cases = [
      ['SKU（商品编码）', '商品名称', '品牌', '尺寸段', '价格段'],
      ['sku(商品编码)', '商品名', '品牌名称', '尺寸', '价格'],
      ['商品编号', '产品名称', '品牌名', '屏幕尺寸', '价格区间'],
      ['商品编码', '标题', '品牌', '尺寸段', '价格段(17段)'],
      ['商品id', '商品名称', '品牌', '尺寸段', '价格段'],
    ];
    for (const headers of cases) {
      const rows = [headers, ...makeDataRows(3, headers.map(() => () => 'x'))];
      const detection = detectHeader(rows);
      assert(detection.columns.sku >= 0, `SKU 列未识别：${headers.join('/')}`);
      assert(detection.columns.name >= 0, `名称列未识别：${headers.join('/')}`);
      assert(detection.columns.brand >= 0, `品牌列未识别：${headers.join('/')}`);
      assert(detection.columns.size >= 0, `尺寸段列未识别：${headers.join('/')}`);
      assert(detection.columns.price >= 0, `价格段列未识别：${headers.join('/')}`);
    }
  });

  test('上方有标题行时自动下移表头行', () => {
    const rows = [
      ['2026年11月 电商平台会议平板榜单（内部）', null, null, null],
      ['时间', '商品名称', 'SKU ID', '成交金额'],
      ['2026-10', '海信75英寸', '1001', '￥200万 ~ ￥400万'],
    ];
    const detection = detectHeader(rows);
    assertEqual(detection.headerRow, 1);
    assertEqual(detection.columns.sku, 2);
    assert(detection.confidence >= 0.6, `置信度应 ≥0.6，实际 ${detection.confidence}`);
  });

  test('表头空格/大小写/全角：规范化后仍能认', () => {
    const headers = ['S K U   I D', '商品 名称', '品 牌', '成 交 金 额', '店 铺 名 称'];
    const rows = [headers, ['1', 'x', 'y', 'z', 'w']];
    const detection = detectHeader(rows);
    assert(detection.columns.sku >= 0);
    assert(detection.columns.name >= 0);
    assert(detection.columns.brand >= 0);
    assert(detection.columns.amount >= 0);
    assert(detection.columns.store >= 0);
  });

  test('识别不出 SKU 时 confidence=0 并给 diagnostics', () => {
    const rows = [
      ['尺寸段', '价格段', '说明'],
      ['55英寸', '1000元以下', '第一档'],
    ];
    const detection = detectHeader(rows);
    assertEqual(detection.columns.sku, -1);
    assert(detection.confidence < 0.2, `无 SKU 时置信度应很低，实际 ${detection.confidence}`);
    assertEqual(detection.diagnostics.previewRows.length, 2);
    assert(Array.isArray(detection.diagnostics.headerRowCandidates));
    assertEqual(detection.diagnostics.perField.sku.found, false);
    assert(Array.isArray(detection.diagnostics.previewColumns));
  });

  test('FIELD_ALIASES 导出且字段完整（v2.1 含 model/package）', () => {
    for (const field of ['sku', 'name', 'brand', 'amount', 'store', 'size', 'price', 'model', 'package', 'rank', 'time']) {
      assert(Array.isArray(FIELD_ALIASES[field]), `FIELD_ALIASES 缺 ${field}`);
    }
    assert(FIELD_ALIASES.model.includes('型号'));
    assert(FIELD_ALIASES.model.includes('规格型号'));
    assert(FIELD_ALIASES.package.includes('套餐'));
    assert(FIELD_ALIASES.package.includes('规格'));
  });

  test('「规格/版本」归套餐，不抢尺寸/价格列', () => {
    const sheet = makeSheet('字段冲突', [
      ['sku', '商品名称', '规格', '版本', '屏幕尺寸', '价格区间'],
      ['1001', '商品A', '含支架', '标准版', '86/85英寸', '5000元至5500元'],
    ]);
    const parsed = parseReportSheet(sheet);
    assertEqual(parsed.columns.size, 4, '屏幕尺寸 → size');
    assertEqual(parsed.columns.price, 5, '价格区间 → price');
    assert(parsed.columns.package >= 0, '规格/版本至少一列归套餐');
    assertEqual(parsed.rows[0].sizeRaw, '86/85英寸');
    assertEqual(parsed.rows[0].priceRaw, '5000元至5500元');
    assert(parsed.rows[0].package === '含支架' || parsed.rows[0].package === '标准版', '套餐取规格/版本列');
  });

  test('合成榜单：型号/套餐列直接被 parseReportSheet 读取', () => {
    const sheet = makeSheet('带型号套餐', [
      ['SKU ID', '商品名称', '店铺名称', '型号', '套餐', '成交金额'],
      ['1001', '海信会议平板', '海信店', 'MC75HEE', '翻页笔+投屏+推车', '￥200万 ~ ￥400万'],
    ]);
    const parsed = parseReportSheet(sheet);
    assertEqual(parsed.columns.model, 3);
    assertEqual(parsed.columns.package, 4);
    assertEqual(parsed.rows[0].model, 'MC75HEE');
    assertEqual(parsed.rows[0].package, '翻页笔+投屏+推车');
    assertEqual(parsed.rows[0].storeName, '海信店');
  });
});

suite('header-map · normalizeSku', () => {
  test('SKU 文本化规则（DESIGN 6.5）', () => {
    assertEqual(normalizeSku(100200174986), '100200174986');
    assertEqual(normalizeSku('100200174986.0'), '100200174986');
    assertEqual(normalizeSku('00123'), '00123', '保留前导零');
    assertEqual(normalizeSku(' 100200174986 '), '100200174986');
    assertEqual(normalizeSku('="100200174986"'), '100200174986', 'Excel 文本化');
    assertEqual(normalizeSku("'100200174986"), '100200174986');
    assertEqual(normalizeSku('1.00200174986E+13'), '10020017498600', '展开科学计数法');
    assertEqual(normalizeSku(null), '');
    assertEqual(normalizeSku(''), '');
    assertEqual(normalizeSku('  '), '');
    assertEqual(normalizeSku('-'), '-');
  });
});

suite('header-map · parseReportSheet 真实榜单', () => {
  test('4 个榜单都解析出 200 行、行号连续、raw 保留全部原始列', async () => {
    const library = loadSeedLibrary();
    for (const entry of REPORT_FILES) {
      // eslint-disable-next-line no-await-in-loop
      const loaded = await loadReport(entry, library);
      const parsed = loaded.parsed;
      assertEqual(parsed.rows.length, 200, `${entry.fileName} 行数`);
      assertEqual(parsed.rows[0].rowNo, 2, '第一行数据 rowNo=2（1-based Excel 行号）');
      assertEqual(parsed.rows[199].rowNo, 201);
      const rawKeys = Object.keys(parsed.rows[0].raw);
      assert(rawKeys.length >= 13, `raw 应保留全部原始列：${rawKeys.length}`);
      assert(parsed.rows[0].sku && /^\d+$/.test(parsed.rows[0].sku), 'SKU 为纯文本数字');
    }
  });

  test('教育教学文件 raw 同时保留 sku 与 SKU ID 两列，并解析型号/套餐列', async () => {
    const library = loadSeedLibrary();
    const loaded = await loadReport(REPORT_FILES[2], library);
    const raw = loaded.parsed.rows[0].raw;
    assert(Object.prototype.hasOwnProperty.call(raw, 'sku'), '缺 sku 原始列');
    assert(Object.prototype.hasOwnProperty.call(raw, 'SKU ID'), '缺 SKU ID 原始列');
    assertEqual(raw.sku, raw['SKU ID']);
    assertEqual(raw['尺寸段'], null, '原表尺寸段列目前为空');
    assertEqual(raw['价格段'], null);
    assertEqual(loaded.parsed.columns.model, 3, '型号列（D）');
    assertEqual(loaded.parsed.columns.package, 4, '套餐列（E）');
    // 原表部分行有型号/套餐（如 MC75HEE / 翻页笔+投屏+推车）
    const rowWithModel = loaded.parsed.rows.find((row) => row.model);
    assert(rowWithModel, '应能从原表型号列读到型号');
    assertEqual(rowWithModel.model, 'MC75HEE');
    const rowWithPackage = loaded.parsed.rows.find((row) => row.package);
    assert(rowWithPackage, '应能从原表套餐列读到套餐');
    assertEqual(rowWithPackage.package, '翻页笔+投屏+推车');
  });

  test('成交金领解析：元/万元混排都换算成万元', async () => {
    const library = loadSeedLibrary();
    const flat = await loadReport(REPORT_FILES[0], library);
    const tv = await loadReport(REPORT_FILES[1], library);
    assertEqual(flat.parsed.rows[0].amount, 300, '￥200万 ~ ￥400万 → 300');
    const yuanRow = flat.parsed.rows.find((row) => row.amountRaw === '￥6,000 ~ ￥8,000');
    assert(yuanRow, '会议平板应存在 ￥6,000 ~ ￥8,000 的行');
    assertEqual(yuanRow.amount, 0.7, '元口径 → 0.7 万元');
    const mixedRow = tv.parsed.rows.find((row) => row.amountRaw === '￥8,000 ~ ￥1万');
    assert(mixedRow, '会议电视应存在 ￥8,000 ~ ￥1万 的行');
    assertEqual(mixedRow.amount, 0.9, '元/万元混排 → 0.9 万元');
  });

  test('overrides 强制列映射（表头诊断场景）', () => {
    const sheet = makeSheet('乱表头', [
      ['序号', '名称字段', '编号字段', '金额字段', '店铺字段'],
      ['1', '海信会议电视', '9001', '￥100万 ~ ￥200万', '海信店'],
      ['2', '创维会议电视', '9002', '￥50万 ~ ￥100万', '创维店'],
    ]);
    const parsed = parseReportSheet(sheet, {
      headerRow: 0,
      sku: '编号字段',
      name: '名称字段',
      amount: '金额字段',
      store: '店铺字段',
    });
    assertEqual(parsed.rows.length, 2);
    assertEqual(parsed.rows[0].sku, '9001');
    assertEqual(parsed.rows[0].name, '海信会议电视');
    assertEqual(parsed.rows[0].amount, 150);
    assertEqual(parsed.columns.sku, 2);
    assertEqual(parsed.columns.name, 1);
    assertEqual(parsed.diagnostics.warnings.length, 0);
  });

  test('overrides 列名找不到时回退自动识别并给 warning', () => {
    const sheet = makeSheet('表', [
      ['sku', '商品名称', '成交金额'],
      ['1001', '商品A', '￥10万 ~ ￥20万'],
    ]);
    const parsed = parseReportSheet(sheet, { sku: '不存在的列' });
    assertEqual(parsed.columns.sku, 0, '应回退自动识别的 sku 列');
    assert(parsed.diagnostics.warnings.some((warning) => warning.includes('找不到')), '应有 warning');
  });

  test('非法 sheet 入参给中文错误', () => {
    let message = '';
    try {
      parseReportSheet(null);
    } catch (error) {
      message = error.message;
    }
    assert(message.includes('解析榜单失败'), `错误文案：${message}`);
  });
});

suite('header-map · suggestStoreBinding', () => {
  test('4 个真实榜单绑定到正确类目且分数=SKU 重合率', async () => {
    const library = loadSeedLibrary();
    for (const entry of REPORT_FILES) {
      // eslint-disable-next-line no-await-in-loop
      const loaded = await loadReport(entry, library);
      assertEqual(loaded.binding.store, entry.expectedStore, `${entry.fileName} 类目`);
      assertEqual(loaded.binding.score, entry.expectedScore, `${entry.fileName} 分数`);
      assert(loaded.binding.reasons[0].includes('SKU 重合'), 'reasons 应包含 SKU 重合');
      assert(Array.isArray(loaded.binding.candidates) && loaded.binding.candidates.length >= 1);
      assert(loaded.binding.candidates[0].store === entry.expectedStore, '候选第一名');
    }
  });

  test('匹配库为空时给出人话提示', () => {
    const binding = suggestStoreBinding({ rows: [{ sku: '1' }], fileName: 'a.xlsx' }, { stores: {} });
    assertEqual(binding.store, '');
    assertEqual(binding.score, 0);
    assert(binding.reasons[0].includes('匹配库为空'));
  });
});
