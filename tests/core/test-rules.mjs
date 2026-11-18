/** tests/core/test-rules.mjs —— 规则引擎单测（尺寸段/价格段/金额/英寸/品牌/状态机 + v2.1 字段/多采样） */
import {
  SIZE_BANDS,
  PRICE_BANDS,
  SIZE_SYNONYMS,
  PRICE_SYNONYMS,
  BRAND_ALIASES,
  parseAmountRange,
  parseInch,
  parseInchValues,
  parseSizeFromNameStrict,
  sizeBandOf,
  sizeBandFromText,
  normalizeSizeBand,
  priceBandOf,
  normalizePriceBand,
  parsePriceText,
  computeRowStatus,
  normalizeBrand,
  matchBrandInText,
  resolveBrand,
  resolveBrandDetailed,
  STATUS,
  CAPTURE_MODES,
  REVIEW_REASONS,
  extractModel,
  extractPackage,
  priceBandInfo,
  bandMidpoint,
  chooseSampleValue,
  shouldResample,
  evaluatePriceReview,
} from '../../extension/lib/rules.js';
import { suite, test, assert, assertEqual, assertClose } from './harness.mjs';

suite('rules · 尺寸段', () => {
  test('规范枚举齐全（10 个尺寸段）', () => {
    assertEqual(SIZE_BANDS.length, 10, 'SIZE_BANDS 数量');
    for (const band of ['55英寸', '65英寸', '75英寸', '86/85英寸', '98/100英寸', '其他']) {
      assert(SIZE_BANDS.includes(band), `SIZE_BANDS 缺少 ${band}`);
    }
  });

  test('parseInch 兼容 英寸/吋/寸 与全角数字', () => {
    assertEqual(parseInch('海信75英寸会议电视').inch, 75);
    assertEqual(parseInch('JAV 100英寸 会议平板').inch, 100);
    assertEqual(parseInch('品牌B新锐55寸').inch, 55);
    assertEqual(parseInch('创维86吋').inch, 86);
    assertEqual(parseInch('１００英寸').inch, 100, '全角数字');
    assertEqual(parseInch('4K 1920*1080 高清'), null, '不应把分辨率当尺寸');
    assertEqual(parseInch('产品尺寸：宽x高'), null, '不应把「尺寸」当英寸');
  });

  test('parseInchValues：名称多尺寸识别（v2.1.5 20.7）', () => {
    assertEqual(parseInchValues('海信75英寸会议电视'), [75]);
    assertEqual(parseInchValues('品牌B 55/65英寸双尺寸'), [55, 65]);
    assertEqual(parseInchValues('75英寸/86英寸 通用'), [75, 86]);
    assertEqual(parseInchValues('98/100英寸会议平板'), [98, 100]);
    assertEqual(parseInchValues('85寸 100寸 75寸 65寸 电子白板'), [85, 100, 75, 65]);
    assertEqual(parseInchValues('无尺寸 4K 1920*1080'), []);
    assertEqual(parseInchValues(''), []);
    assertEqual(parseInchValues(null), []);
  });

  test('parseSizeFromNameStrict（v2.1.6 21.2）：唯一明确尺寸才识别，多值/型号数字空置', () => {
    // 唯一明确尺寸 → 识别
    assertEqual(parseSizeFromNameStrict('海信75英寸会议电视').size, '75英寸');
    assertEqual(parseSizeFromNameStrict('品牌B 65寸会议平板').size, '65英寸');
    assertEqual(parseSizeFromNameStrict('创维85吋').size, '86/85英寸');
    assertEqual(parseSizeFromNameStrict('98英寸会议电视').size, '98/100英寸');
    assertEqual(parseSizeFromNameStrict('海信75英寸').ambiguous, false);
    // ≥2 个明确尺寸表达 → 一律空置
    for (const name of ['55/65英寸 双尺寸', '98/100英寸会议平板', '86/85英寸', '75英寸 86英寸', '85寸 100寸']) {
      const parsed = parseSizeFromNameStrict(name);
      assertEqual(parsed.size, '', `${name} 不应识别尺寸`);
      assertEqual(parsed.ambiguous, true, `${name} 应 ambiguous`);
      assertEqual(parsed.reason, 'multiple-size-expressions', `${name} reason`);
      assert(parsed.candidates.length >= 2, `${name} 候选尺寸`);
    }
    // 型号数字/无单位数字 → 绝不当尺寸
    for (const name of ['型号75MBK7 会议平板', 'VH75CAD 商用显示', '65MBK7', '5000元 会议平板', '4K 1920*1080']) {
      const parsed = parseSizeFromNameStrict(name);
      assertEqual(parsed.size, '', `${name} 不得把型号数字当尺寸`);
      assertEqual(parsed.ambiguous, true, `${name} 应待人工`);
      assertEqual(parsed.reason, 'no-size-expression', `${name} reason`);
    }
    // 「型号 + 唯一明确尺寸」→ 只认带单位的那个
    assertEqual(parseSizeFromNameStrict('75MBK7 75英寸会议平板').size, '75英寸');
    // 空名称
    assertEqual(parseSizeFromNameStrict('').size, '');
    assertEqual(parseSizeFromNameStrict(null).ambiguous, true);
  });

  test('sizeBandOf 映射到规范尺寸段', () => {
    assertEqual(sizeBandOf(55), '55英寸');
    assertEqual(sizeBandOf(65), '65英寸');
    assertEqual(sizeBandOf(75), '75英寸');
    assertEqual(sizeBandOf(85), '86/85英寸');
    assertEqual(sizeBandOf(86), '86/85英寸');
    assertEqual(sizeBandOf(98), '98/100英寸');
    assertEqual(sizeBandOf(100), '98/100英寸');
    assertEqual(sizeBandOf(43), '其他尺寸(43英寸)');
    assertEqual(sizeBandOf(110), '其他尺寸(110英寸)');
    assertEqual(sizeBandOf(120), '其他尺寸(120英寸)');
    assertEqual(sizeBandOf(150), '其他尺寸(150英寸)');
    assertEqual(sizeBandOf(50), '其他尺寸(50英寸)', '其他数字');
    assertEqual(sizeBandOf(Number.NaN), '其他', '解析不出 → 其他');
  });

  test('sizeBandFromText 解析不出返回空串', () => {
    assertEqual(sizeBandFromText('海信【京海系列】98英寸AI会议平板'), '98/100英寸');
    assertEqual(sizeBandFromText('没有尺寸信息的商品'), '');
  });

  test('normalizeSizeBand 脏值归一（真实库实测样本）', () => {
    const cases = [
      ['其他（50英寸）', '其他尺寸(50英寸)', true],
      ['其他(50英寸)', '其他尺寸(50英寸)', true],
      ['其他尺寸(120英寸）', '其他尺寸(120英寸)', true],
      ['其他尺寸（43英寸）', '其他尺寸(43英寸)', true],
      ['110英寸', '其他尺寸(110英寸)', true],
      ['50英寸', '其他尺寸(50英寸)', true],
      ['未识别', '其他', true],
      ['', '', false],
      ['86/85英寸', '86/85英寸', false],
      ['98/100英寸', '98/100英寸', false],
      ['其他尺寸(43英寸)', '其他尺寸(43英寸)', false],
      ['其他', '其他', false],
      ['55英寸', '55英寸', false],
    ];
    for (const [raw, value, dirty] of cases) {
      const result = normalizeSizeBand(raw);
      assertEqual(result, { value, dirty }, `normalizeSizeBand(${JSON.stringify(raw)})`);
    }
    assertEqual(normalizeSizeBand(null), { value: '', dirty: false }, 'null 输入');
  });

  test('SIZE_SYNONYMS 每个规范值都有别名提示', () => {
    for (const band of SIZE_BANDS) assert(Array.isArray(SIZE_SYNONYMS[band]), `缺 ${band} 同义词`);
  });
});

suite('rules · 价格段', () => {
  test('规范枚举 18 段（源表叫 17 段，DESIGN 列举 18 个）', () => {
    assertEqual(PRICE_BANDS.length, 18);
    assertEqual(PRICE_BANDS[0], '1000元以下');
    assertEqual(PRICE_BANDS[PRICE_BANDS.length - 1], '25000元以上');
    assertEqual(Object.keys(PRICE_SYNONYMS).length, 18);
  });

  test('priceBandOf 默认 rightOpen：[low, high)', () => {
    assertEqual(priceBandOf(999), '1000元以下');
    assertEqual(priceBandOf(1000), '1000元至2000元', '1000 归上方区间');
    assertEqual(priceBandOf(1999.99), '1000元至2000元');
    assertEqual(priceBandOf(2000), '2000元至2500元');
    assertEqual(priceBandOf(5499), '5000元至5500元');
    assertEqual(priceBandOf(5500), '5500元至6000元');
    assertEqual(priceBandOf(24999), '20000元至25000元');
    assertEqual(priceBandOf(25000), '25000元以上');
    assertEqual(priceBandOf(0), '1000元以下');
    assertEqual(priceBandOf(''), '', '非法价格返回空串');
    assertEqual(priceBandOf(null), '', 'null 返回空串');
    assertEqual(priceBandOf('9999'), '9000元至10000元', '数字文本');
  });

  test('priceBandOf rightClosed：(low, high]', () => {
    assertEqual(priceBandOf(1000, 'rightClosed'), '1000元以下');
    assertEqual(priceBandOf(1000.01, 'rightClosed'), '1000元至2000元');
    assertEqual(priceBandOf(2000, 'rightClosed'), '1000元至2000元');
    assertEqual(priceBandOf(2500, 'rightClosed'), '2000元至2500元');
    assertEqual(priceBandOf(25000, 'rightClosed'), '20000元至25000元');
    assertEqual(priceBandOf(25000.01, 'rightClosed'), '25000元以上');
  });

  test('normalizePriceBand 脏值归一（真实库实测样本）', () => {
    const cases = [
      ['3000元3500元', '3000元至3500元', true],
      ['3000元-3500元', '3000元至3500元', true],
      ['3000元~3500元', '3000元至3500元', true],
      ['25000以上', '25000元以上', true],
      ['1万至1.5万元', '10000元至15000元', true],
      ['未识别', '', true],
      ['', '', false],
      ['3000元至3500元', '3000元至3500元', false],
      ['1000元以下', '1000元以下', false],
      ['25000元以上', '25000元以上', false],
    ];
    for (const [raw, value, dirty] of cases) {
      assertEqual(normalizePriceBand(raw), { value, dirty }, `normalizePriceBand(${JSON.stringify(raw)})`);
    }
    assertEqual(normalizePriceBand(null), { value: '', dirty: false }, 'null 输入');
  });

  test('parsePriceText 支持 ￥/逗号/万', () => {
    assertEqual(parsePriceText('￥9,999'), 9999);
    assertEqual(parsePriceText('1.2万'), 12000);
    assertEqual(parsePriceText('9999元'), 9999);
    assertEqual(parsePriceText('面议'), null);
  });
});

suite('rules · 成交金额（元/万元混排）', () => {
  test('DESIGN 万元写法：区间中值', () => {
    assertEqual(parseAmountRange('￥200万 ~ ￥400万'), 300);
    assertEqual(parseAmountRange('￥50万 ~ ￥75万'), 62.5);
    assertEqual(parseAmountRange('￥1,400万 ~ ￥1,600万'), 1500);
    assertEqual(parseAmountRange('200 ~ 400'), 300, '两数都 <1000 且无万 → 按万元');
  });

  test('真实榜单元写法：必须换算成万元', () => {
    assertEqual(parseAmountRange('￥6,000 ~ ￥8,000'), 0.7);
    assertEqual(parseAmountRange('￥4,000 ~ ￥6,000'), 0.5);
    assertEqual(parseAmountRange('￥2,000 ~ ￥4,000'), 0.3);
    assertEqual(parseAmountRange('￥8,000 ~ ￥1万'), 0.9, '元/万元混排');
    assertEqual(parseAmountRange('￥1万 ~ ￥2万'), 1.5);
    assertEqual(parseAmountRange('￥6,000'), 0.6, '单值');
  });

  test('解析失败返回 null（不抛异常）', () => {
    assertEqual(parseAmountRange('-'), null);
    assertEqual(parseAmountRange(''), null);
    assertEqual(parseAmountRange(null), null);
    assertEqual(parseAmountRange('面议'), null);
  });
});

suite('rules · 品牌补全', () => {
  test('BRAND_ALIASES 覆盖 Lead 指定品牌', () => {
    for (const brand of ['海信', '创维', 'TCL', '品牌B', '品牌A', '华为', '鸿合', 'HIKVISION']) {
      assert(Array.isArray(BRAND_ALIASES[brand]), `缺品牌 ${brand}`);
    }
  });

  test('normalizeBrand 去括号/大小写归一', () => {
    assertEqual(normalizeBrand('华为（HUAWEI）'), '华为');
    assertEqual(normalizeBrand('品牌A（brandA）'), '品牌A');
    assertEqual(normalizeBrand('创维（Skyworth）'), '创维');
    assertEqual(normalizeBrand('HIKVISION（海康威视）'), 'HIKVISION');
    assertEqual(normalizeBrand('海信'), '海信');
    assertEqual(normalizeBrand('  '), '');
    assertEqual(normalizeBrand('某不知名品牌'), '某不知名品牌', '未命中返回去括号后原文');
  });

  test('matchBrandInText 最长匹配 + ASCII 词边界', () => {
    assertEqual(matchBrandInText('品牌B会议平板'), '品牌B');
    assertEqual(matchBrandInText('MALG会议平板'), 'MALG', 'MALG 不应被 LG 抢走');
    assertEqual(matchBrandInText('MiniLED会议电视'), '', 'MiniLED 不应命中 MI');
    assertEqual(matchBrandInText('TCL98英寸会议电视'), 'TCL', '品牌+型号连写');
    assertEqual(matchBrandInText('品牌BEH86MA 86寸'), '品牌B');
    assertEqual(matchBrandInText('海信100英寸'), '海信');
    assertEqual(matchBrandInText('煜朗达多功能终端'), '');
  });

  test('resolveBrand 优先级：列 → 库 → 名称 → 店铺', () => {
    assertEqual(resolveBrand({ brandRaw: '品牌A（brandA）', libraryBrand: '华为', name: 'TCL电视', storeName: '海信店' }), '品牌A');
    assertEqual(resolveBrand({ brandRaw: '', libraryBrand: '华为（HUAWEI）', name: 'TCL电视', storeName: '海信店' }), '华为');
    assertEqual(resolveBrand({ brandRaw: '其他', libraryBrand: '', name: '创维100英寸会议电视', storeName: '某店' }), '创维', '占位品牌继续下探');
    assertEqual(resolveBrand({ brandRaw: '', libraryBrand: '', name: '无品牌商品', storeName: '海信商用显示电商平台自营旗舰店' }), '海信');
    assertEqual(resolveBrand({}), '');
    assertEqual(resolveBrandDetailed({ brandRaw: '', name: 'JAV京锐战神', storeName: '' }), { brand: 'JAV', source: '名称' });
    assertEqual(resolveBrandDetailed({ brandRaw: '飞利浦' }).source, '列');
    assertEqual(resolveBrandDetailed({ brandRaw: '', libraryBrand: '皓丽' }).source, '库');
    assertEqual(resolveBrandDetailed({ brandRaw: '', storeName: '品牌A（brandA）电商平台自营旗舰店' }).source, '店铺');
  });
});

suite('rules · 状态机', () => {
  test('computeRowStatus 六种状态', () => {
    assertEqual(computeRowStatus({ size: '55英寸', price: '1000元以下' }), STATUS.MATCHED);
    assertEqual(
      computeRowStatus({ size: '55英寸', price: '1000元以下', source: { size: '库', price: '页面采集' } }),
      STATUS.CAPTURED,
    );
    assertEqual(computeRowStatus({ size: '55英寸' }), STATUS.PARTIAL);
    assertEqual(computeRowStatus({ price: '1000元以下' }), STATUS.PENDING_MANUAL);
    assertEqual(computeRowStatus({}), STATUS.PENDING_CAPTURE);
    assertEqual(computeRowStatus({ captureFailed: true }), STATUS.CAPTURE_FAILED);
  });

  test('金额 0.7 万元级样本的边界断言', () => {
    assertClose(parseAmountRange('￥6,000 ~ ￥8,000'), 0.7, 1e-9);
  });

  test('v2.1 新增状态：需确认（review.needed 且未确认）', () => {
    const row = {
      size: '55英寸',
      price: '5000元至5500元',
      source: { size: '库', price: '页面采集' },
      review: { needed: true, confirmed: false, reasons: [{ code: 'NEAR_BOUNDARY', text: 'x' }] },
    };
    assertEqual(computeRowStatus(row), STATUS.REVIEW_NEEDED);
    row.review.confirmed = true;
    assertEqual(computeRowStatus(row), STATUS.CAPTURED, '确认后 → 已补采');
    assertEqual(STATUS.REVIEW_NEEDED, '需确认');
  });
});

suite('rules · v2.1 型号 / 套餐提取（DESIGN 16.1）', () => {
  test('extractModel：型号标签优先、字母+数字 token、黑名单过滤', () => {
    assertEqual(extractModel('品牌B会议平板 型号：MC75HEE 75英寸'), 'MC75HEE', '型号标签优先');
    assertEqual(extractModel('品牌A（brandA）【13代处理器】教育教学触摸一体机'), '', '无字母数字型号 → 空');
    assertEqual(extractModel('海信100英寸会议电视会议平板电视一体机4+128GB MiniLED ... 100XP3E'), '100XP3E');
    assertEqual(extractModel('TCL98英寸4K会议教育一体机 IFP98V60P'), 'IFP98V60P');
    assertEqual(extractModel('华为IHE2-86SU86寸落地支架全向麦克风'), 'IHE2-86SU', '带连字符型号');
    assertEqual(extractModel('L75MA-SM 75英寸会议电视'), 'L75MA-SM');
    assertEqual(extractModel('海信75英寸会议平板一体机4+64GB 40点触控'), '', '4+64GB/4K 不是型号');
    assertEqual(extractModel('品牌B 4K 8K 128G 1920X1080 60HZ 英寸'), '', '单位/分辨率不是型号');
    assertEqual(extractModel(''), '');
    assertEqual(extractModel(null), '');
  });

  test('extractPackage：内存/CPU 组合、配件组合、无则留空', () => {
    assertEqual(extractPackage('海信75英寸会议平板一体机4+64GB 40点触控教学培训'), '4+64GB');
    assertEqual(extractPackage('品牌B 8G+256G 会议平板'), '8G+256G');
    assertEqual(extractPackage('联想 i5/8G/256G 一体机'), 'i5/8G/256G');
    assertEqual(extractPackage('联想 i7/8+256G 一体机'), 'i7/8+256G');
    assertEqual(extractPackage('品牌A 含翻页笔+投屏器+移动推车 套装'), '翻页笔+投屏器+移动推车');
    assertEqual(extractPackage('会议平板 含落地支架 75英寸'), '落地支架', '含支架');
    assertEqual(extractPackage('会议平板 支持无线投屏 4K'), '', '功能词「无线投屏」不算套餐');
    assertEqual(extractPackage('支持壁挂安装 86英寸'), '', '「支持壁挂」不算套餐');
    assertEqual(extractPackage('普通会议平板一体机'), '');
    assertEqual(extractPackage(''), '');
    const long = extractPackage('含' + '翻页笔+投屏器+移动推车+全向麦克风+摄像头+OPS');
    assert(long.length <= 40, '套餐截断 ≤40 字');
  });
});

suite('rules · v2.1 价格段信息 / 采样 / 复核（DESIGN 16.4，无阈值不纠偏）', () => {
  test('priceBandInfo：价格段边界距离与接近判定', () => {
    const near = priceBandInfo(5499);
    assertEqual(near.band, '5000元至5500元');
    assertEqual(near.nearestBoundary, 5500);
    assertEqual(near.boundaryDistance, 1);
    assertEqual(near.side, 'below');
    assertEqual(near.nearBoundary, true);
    const far = priceBandInfo(5250);
    assertEqual(far.band, '5000元至5500元');
    assertEqual(far.nearBoundary, false, '距边界 250 元不算接近');
    assertEqual(far.margin, 52.5);
    const onBoundary = priceBandInfo(1000);
    assertEqual(onBoundary.band, '1000元至2000元', 'rightOpen 边界归上段');
    assertEqual(onBoundary.boundaryDistance, 0);
    assertEqual(onBoundary.side, 'inside');
    assertEqual(priceBandInfo(25000, 'rightClosed').band, '20000元至25000元');
    assertEqual(priceBandInfo(null), null);
    assertEqual(priceBandInfo('abc'), null);
    assertEqual(priceBandInfo('') , null);
  });

  test('bandMidpoint：规范段中值（最高段外推）', () => {
    assertEqual(bandMidpoint('1000元以下'), 500);
    assertEqual(bandMidpoint('1000元至2000元'), 1500);
    assertEqual(bandMidpoint('10000元至15000元'), 12500);
    assertEqual(bandMidpoint('25000元以上'), 27500);
    assertEqual(bandMidpoint('未补'), null);
    assertEqual(bandMidpoint(''), null);
  });

  test('chooseSampleValue：一致取中位数、不一致也取中位数（不纠偏）', () => {
    assertEqual(chooseSampleValue([]), { price: null, method: 'single', values: [], spread: 0, spreadPct: 0, consistent: true, tolerance: 30 });
    assertEqual(chooseSampleValue([5499]).method, 'single');
    assertEqual(chooseSampleValue([5499]).price, 5499);
    const same = chooseSampleValue([5499, 5499]);
    assertEqual(same.method, 'same');
    assertEqual(same.consistent, true);
    const odd = chooseSampleValue([5499, 5501, 5500]);
    assertEqual(odd.method, 'median');
    assertEqual(odd.price, 5500);
    assertEqual(odd.spread, 2);
    assertEqual(odd.consistent, true);
    assertClose(odd.spreadPct, 2 / 5500, 1e-6);
    const even = chooseSampleValue([100, 200]);
    assertEqual(even.price, 150, '偶数取中间均值');
    const inconsistent = chooseSampleValue([5000, 6000]);
    assertEqual(inconsistent.price, 5500);
    assertEqual(inconsistent.spread, 1000);
    assertEqual(inconsistent.consistent, false);
    assertEqual(inconsistent.tolerance, 50, 'max(30, 5000×0.01)');
    // 容差参数覆盖
    assertEqual(chooseSampleValue([5000, 6000], { toleranceAbs: 2000 }).consistent, true);
    // 对象样本 + 无有效样本
    assertEqual(chooseSampleValue([{ price: 100 }, { price: 200 }, 'x']).price, 150);
    assertEqual(chooseSampleValue([{ prices: { hand: 1 } }]).price, null);
  });

  test('shouldResample：边界/参考区间/弱证据/样本不一致/模式', () => {
    const settings = { capture: { mode: 'smart', maxSamples: 3, tolerancePct: 0.01, toleranceAbs: 30 }, price: { bandBoundary: 'rightOpen', boundaryMarginPct: 0.01 } };
    // single 模式不再补采
    assertEqual(shouldResample({ price: 5499, samples: [5499], settings: { capture: { mode: 'single' } } }), {
      more: false,
      reasons: [],
      sampleCount: 1,
      maxSamples: 3,
    });
    // 接近边界 → 补采
    const near = shouldResample({ price: 5499, candidateCount: 3, priceKind: 'hand', samples: [5499], settings });
    assertEqual(near.more, true);
    assert(near.reasons.some((reason) => reason.code === 'NEAR_BOUNDARY'));
    // 正常价格 + 证据充分 → 不补采
    const normal = shouldResample({ price: 5250, candidateCount: 3, priceKind: 'hand', samples: [5250], settings });
    assertEqual(normal.more, false, JSON.stringify(normal.reasons));
    // 候选不足 → WEAK_EVIDENCE
    const weak = shouldResample({ price: 5250, candidateCount: 1, priceKind: 'hand', samples: [5250], settings });
    assertEqual(weak.more, true);
    assert(weak.reasons.some((reason) => reason.code === 'WEAK_EVIDENCE' && reason.text.includes('候选项不足')));
    // 文本兜底口径 → WEAK_EVIDENCE
    const textKind = shouldResample({ price: 5250, candidateCount: 3, priceKind: 'text', samples: [5250], settings });
    assert(textKind.reasons.some((reason) => reason.code === 'WEAK_EVIDENCE' && reason.text.includes('文本兜底')));
    // 样本不一致 → SAMPLES_INCONSISTENT
    const inconsistent = shouldResample({ price: 5500, candidateCount: 3, priceKind: 'hand', samples: [{ price: 5000 }, { price: 6000 }], settings });
    assert(inconsistent.reasons.some((reason) => reason.code === 'SAMPLES_INCONSISTENT'));
    // 达 maxSamples → 不再补
    const maxed = shouldResample({ price: 5499, candidateCount: 3, priceKind: 'hand', samples: [5499, 5500, 5501], settings });
    assertEqual(maxed.more, false);
    // 参考区间外 → OUT_OF_REFERENCE（参考区间会展开成 [p10×0.3, p90×3]，所以用窄高价库）
    const out = shouldResample({ price: 3000, candidateCount: 3, priceKind: 'hand', samples: [3000], referenceRange: { low: 12000, high: 16000, count: 20 }, settings });
    assert(out.reasons.some((reason) => reason.code === 'OUT_OF_REFERENCE'), JSON.stringify(out.reasons));
    // double 模式强制至少 2 次
    const doubleMode = shouldResample({ price: 5250, candidateCount: 3, priceKind: 'hand', samples: [{ price: 5250 }], settings: { ...settings, capture: { ...settings.capture, mode: 'double' } } });
    assertEqual(doubleMode.more, true);
    assertEqual(CAPTURE_MODES.length, 3);
  });

  test('evaluatePriceReview：六种 code 与中文文案', () => {
    const settings = { capture: { mode: 'smart', maxSamples: 3, tolerancePct: 0.01, toleranceAbs: 30 }, price: { bandBoundary: 'rightOpen', boundaryMarginPct: 0.01 } };
    // 无问题
    const ok = evaluatePriceReview({ price: 5250, samples: [{ price: 5250 }], priceKind: 'hand', candidateCount: 3, settings });
    assertEqual(ok.needed, false);
    assertEqual(ok.reasons, []);
    // 接近边界
    const near = evaluatePriceReview({ price: 5499, samples: [{ price: 5499 }], priceKind: 'hand', candidateCount: 3, settings });
    const nearReason = near.reasons.find((reason) => reason.code === 'NEAR_BOUNDARY');
    assert(nearReason && nearReason.text.includes('接近价格段边界'), 'NEAR_BOUNDARY 中文文案');
    assertEqual(near.band, '5000元至5500元');
    // 样本不一致（容差内不算）
    const inconsistent = evaluatePriceReview({ price: 5500, samples: [{ price: 5000 }, { price: 6000 }], priceKind: 'hand', candidateCount: 3, settings });
    assert(inconsistent.reasons.some((reason) => reason.code === 'SAMPLES_INCONSISTENT' && reason.text.includes('价差超容差')));
    // 跨价格段（一致但落两段：抬 tolerance 让其一致）
    const crossSettings = { ...settings, capture: { ...settings.capture, toleranceAbs: 5000 } };
    const cross = evaluatePriceReview({ price: 2000, samples: [{ price: 1900 }, { price: 2100 }], priceKind: 'hand', candidateCount: 3, settings: crossSettings });
    assert(cross.reasons.some((reason) => reason.code === 'SAMPLES_CROSS_BAND' && reason.text.includes('不同价格段')));
    // 参考区间外（区间先展开成 [p10×0.3, p90×3]，用窄高价库让 3000 落到区间外）
    const out = evaluatePriceReview({ price: 3000, samples: [{ price: 3000 }], priceKind: 'hand', candidateCount: 3, referenceRange: { low: 12000, high: 16000, count: 20 }, settings });
    assert(out.reasons.some((reason) => reason.code === 'OUT_OF_REFERENCE' && reason.text.includes('参考区间')), JSON.stringify(out.reasons));
    // 与库价格段不一致
    const mismatched = evaluatePriceReview({ price: 5200, samples: [{ price: 5200 }], priceKind: 'hand', candidateCount: 3, libraryBand: '6000元至7000元', settings });
    assert(mismatched.reasons.some((reason) => reason.code === 'LIB_BAND_MISMATCH'));
    // 弱证据
    const weak = evaluatePriceReview({ price: 5200, samples: [{ price: 5200 }], priceKind: 'text', candidateCount: 1, settings });
    assert(weak.reasons.some((reason) => reason.code === 'WEAK_EVIDENCE'));
    // 无效价格
    const invalid = evaluatePriceReview({ price: null, samples: [], settings });
    assertEqual(invalid.needed, true);
    assert(invalid.reasons.some((reason) => reason.code === 'WEAK_EVIDENCE' && reason.text.includes('未取得有效价格')));
    // 所有 text 都是非空中文
    for (const reason of [...near.reasons, ...inconsistent.reasons, ...out.reasons]) {
      assert(typeof reason.text === 'string' && reason.text.length > 0, '复核原因必须有中文文案');
    }
    assertEqual(Object.keys(REVIEW_REASONS).length, 6);
  });
});
