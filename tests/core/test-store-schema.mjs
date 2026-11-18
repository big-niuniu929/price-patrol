/** tests/core/test-store-schema.mjs —— 匹配库模型/种子/合并/归一化/问题检查（v2.1.4 含核验字段） */
import { suite, test, assert, assertEqual, assertThrows } from './harness.mjs';
import {
  SEED_URL,
  LIBRARY_EXPORT_HEADERS,
  emptyLibrary,
  seedLibraryFromJson,
  mergeLibrary,
  findLibraryIssues,
  upsertMatch,
  normalizeLibrary,
  mergeStores,
  dedupeStore,
  libraryToRows,
  libraryExportRows,
  applySeedMigration,
  appendLibraryLog,
  libraryLogRows,
  clearLibraryLogs,
  LIBRARY_LOG_ACTIONS,
  LIBRARY_LOG_LIMIT,
  statsOfLibrary,
  deriveKeywords,
} from '../../extension/lib/store-schema.js';
import { parseReportSheet } from '../../extension/lib/header-map.js';
import { loadSeed, loadLibraryXlsxSheets } from './helpers.mjs';

suite('store-schema · 空库与种子', () => {
  test('SEED_URL 指向扩展内种子', () => {
    assertEqual(SEED_URL, 'data/base-skus.json');
  });

  test('emptyLibrary 结构', () => {
    const library = emptyLibrary();
    assertEqual(library.version, 1);
    assertEqual(library.stores, {});
    assert(typeof library.meta.updatedAt === 'string');
    assert(Array.isArray(library.meta.importedFrom));
  });

  test('种子导入：4 店 1101 SKU、638 齐全（v2.1.4 新权威库）', () => {
    const seed = loadSeed();
    const library = seedLibraryFromJson(seed);
    assertEqual(Object.keys(library.stores), ['大家电 会议电视', '大家电 会议平板一体机', '3C店', '品牌A 教育一体机']);
    const stats = statsOfLibrary(library);
    assertEqual(stats.total.stores, 4);
    assertEqual(stats.total.skus, 1101);
    assertEqual(stats.total.complete, 638, '尺寸段+价格段齐全数（DESIGN 19.4 记录 638）');
    assertEqual(stats.total.sizeFilled, 639);
    assertEqual(stats.total.priceFilled, 648);
    assertEqual(stats.total.dirty, 25, '历史脏值原始值条数');
    assertEqual(stats.stores.map((store) => store.skus), [200, 200, 501, 200]);
    assertEqual(stats.stores[0].complete, 148);
    assertEqual(stats.stores[2].complete, 490);
  });

  test('种子 meta：schemaVersion / fingerprint / generatedAt 保留', () => {
    const seed = loadSeed();
    const library = seedLibraryFromJson(seed);
    assertEqual(library.meta.schemaVersion, '2026-11-03.780d76');
    assertEqual(library.meta.fingerprint, '780d76cf20900fe3');
    assertEqual(library.meta.generatedAt, seed.generatedAt);
    assert(Array.isArray(library.meta.importedFrom) && library.meta.importedFrom.length >= 1);
    assert(library.meta.importedFrom[0].includes('匹配库.xlsx'), '种子来源应是新版匹配库.xlsx');
    // 记录核验字段：种子默认 verified=true origin='seed'
    const rows = libraryToRows(library);
    assertEqual(rows.filter((row) => row.verified).length, 1101);
    assert(rows.every((row) => row.origin === 'seed'), '种子记录 origin 均为 seed');
    assert(rows.every((row) => row.verifiedText === '已确认'));
    assert(rows[0].verifiedAt === library.meta.generatedAt, '种子记录 verifiedAt=generatedAt');
  });

  test('种子不改动入参 JSON；脏值归一后保留原始值', () => {
    const seed = loadSeed();
    const before = JSON.stringify(seed);
    const library = seedLibraryFromJson(seed);
    assertEqual(JSON.stringify(seed), before, 'seed 不应被修改');
    const rows = library.stores['大家电 会议电视'].rows;
    const dirtySize = Object.values(rows).find((row) => row.sizeRaw === '其他（50英寸）');
    assert(dirtySize, '应能找到原始脏值「其他（50英寸）」');
    assertEqual(dirtySize.size, '其他尺寸(50英寸)');
    const dirtyPrice = Object.values(rows).find((row) => row.priceRaw === '3000元3500元');
    assert(dirtyPrice, '应能找到原始脏值「3000元3500元」');
    assertEqual(dirtyPrice.price, '3000元至3500元');
    // 品牌归一
    const brandRows = Object.values(rows).filter((row) => row.brand);
    assert(brandRows.length > 0);
    assert(brandRows.every((row) => !row.brand.includes('（')), '品牌应已去括号归一');
    assertEqual(library.stores['大家电 会议电视'].keywords.includes('电视'), true, '关键词应含「电视」');
  });
});

suite('store-schema · mergeLibrary', () => {
  function baseLibrary() {
    return {
      version: 1,
      stores: {
        A店: {
          name: 'A店',
          keywords: ['A店'],
          rows: {
            1001: { sku: '1001', name: '商品1', brand: '海信', size: '55英寸', price: '1000元以下', sizeRaw: '', priceRaw: '', source: '库', updatedAt: '' },
            1002: { sku: '1002', name: '商品2', brand: '', size: '', price: '', sizeRaw: '', priceRaw: '', source: '库', updatedAt: '' },
          },
        },
      },
      meta: { updatedAt: '', importedFrom: [] },
    };
  }

  test('merge 模式：新增类目/新增 SKU/覆盖非空字段（v2.1 含 model/package）', () => {
    const library = baseLibrary();
    const result = mergeLibrary(library, {
      stores: {
        A店: {
          rows: [
            { sku: '1001', name: '商品1（新名）', size: '75英寸', price: '3000元3500元', model: 'MC75HEE', package: '4+64GB' },
            { sku: '1003', name: '商品3', brand: '创维', size: '86/85英寸', price: '25000元以上' },
          ],
        },
        B店: { rows: [{ sku: '2001', name: '商品B', brand: 'TCL', model: 'IFP98V60P' }] },
      },
      mode: 'merge',
    });
    assertEqual(result.library, library, '原地修改并返回同一个 library');
    assertEqual(result.stats.addedStores, 1);
    assertEqual(result.stats.addedRows, 2);
    assertEqual(result.stats.updatedRows, 1);
    assertEqual(library.stores.A店.rows['1001'].name, '商品1（新名）');
    assertEqual(library.stores.A店.rows['1001'].size, '75英寸');
    assertEqual(library.stores.A店.rows['1001'].price, '3000元至3500元', '脏值导入即归一');
    assertEqual(library.stores.A店.rows['1001'].priceRaw, '3000元3500元', '原始脏值保留');
    assertEqual(library.stores.A店.rows['1001'].model, 'MC75HEE', 'v2.1 型号入库');
    assertEqual(library.stores.A店.rows['1001'].package, '4+64GB', 'v2.1 套餐入库');
    assertEqual(library.stores.A店.rows['1001'].verified, true, '导入记录视为已核验');
    assertEqual(library.stores.A店.rows['1001'].origin, 'import', '导入记录 origin=import');
    assertEqual(library.stores.A店.rows['1002'].name, '商品2', '导入记录空字段不清空旧值');
    assertEqual(library.stores.A店.rows['1002'].model, '', '旧记录缺省 model 为空串（向后兼容）');
    assertEqual(library.stores.A店.rows['1002'].verified, true, '旧记录（source=库）缺 verified 时推断为 true');
    assertEqual(library.stores.A店.rows['1002'].origin, 'import', '旧记录 origin 按 source 推断');
    assertEqual(library.stores.B店.rows['2001'].brand, 'TCL');
    assertEqual(library.stores.B店.rows['2001'].model, 'IFP98V60P');
    assertEqual(library.stores.B店.rows['2001'].verified, true);
    assertEqual(library.meta.lastMerge.mode, 'merge');
  });

  test('replace 模式：整体替换现有类目', () => {
    const library = baseLibrary();
    const result = mergeLibrary(library, {
      stores: [{ name: '新店', rows: [{ sku: '9', name: '新品' }] }],
      mode: 'replace',
    });
    assertEqual(Object.keys(library.stores), ['新店']);
    assertEqual(result.stats.mode, 'replace');
  });

  test('真实匹配库.xlsx（parseReportSheet + merge replace）导入 1101 SKU / 638 齐全', async () => {
    const sheets = await loadLibraryXlsxSheets();
    const incomingStores = sheets.map((sheet) => {
      const parsed = parseReportSheet(sheet);
      return {
        name: sheet.name,
        rows: parsed.rows.map((row) => ({
          sku: row.sku,
          name: row.name,
          brand: row.brand,
          size: row.sizeRaw,
          price: row.priceRaw,
        })),
      };
    });
    const library = emptyLibrary();
    const result = mergeLibrary(library, { stores: incomingStores, mode: 'replace' });
    assertEqual(result.stats.addedRows, 1101);
    const stats = statsOfLibrary(library);
    assertEqual(stats.total.complete, 638, '新版匹配库.xlsx 直接导入 638 齐全');
    assertEqual(stats.total.dirty, 25);
    const rows = libraryToRows(library);
    assertEqual(rows.filter((row) => row.verified).length, 1101);
    assert(rows.every((row) => row.origin === 'import'), 'Excel 导入记录 origin=import');
  });
});

suite('store-schema · 问题检查', () => {
  test('种子库：缺项/脏值/空名称/跨类目重复统计', () => {
    const library = seedLibraryFromJson(loadSeed());
    const issues = findLibraryIssues(library);
    assertEqual(issues.counts.skus, 1101);
    assertEqual(issues.counts.incomplete, 463, '1101-638');
    assertEqual(issues.counts.dirty, 25);
    assertEqual(issues.counts.emptyName, 200, '品牌A sheet 全都没有商品名');
    assertEqual(issues.counts.duplicates, 2, '有 2 个 SKU 同时出现在 3C店 与 品牌A 教育一体机');
    assertEqual(issues.duplicates.length, 2);
    const duplicate = issues.duplicates[0];
    assertEqual(duplicate.count, 2);
    assertEqual(duplicate.stores, ['3C店', '品牌A 教育一体机']);
    assertEqual(duplicate.entries.length, 2);
    assert(Array.isArray(issues.conflicts), 'conflicts 数组');
    assert(Array.isArray(issues.incomplete));
    assert(Array.isArray(issues.dirty));
    assertEqual(issues.incomplete[0].missing.length > 0, true);
    const dirty = issues.dirty.find((item) => item.field === 'size');
    assert(dirty && dirty.normalized.startsWith('其他尺寸('), '脏值条目应带归一结果');
  });

  test('跨类目同 SKU 冲突能被检出（duplicates 是超集，conflicts 是差异子集）', () => {
    const library = emptyLibrary();
    library.stores.X = { name: 'X', rows: { 7: { sku: '7', name: 'a', size: '55英寸', price: '1000元以下' } } };
    library.stores.Y = { name: 'Y', rows: { 7: { sku: '7', name: 'a', size: '75英寸', price: '1000元以下' } } };
    const issues = findLibraryIssues(library);
    assertEqual(issues.counts.duplicates, 1);
    assertEqual(issues.duplicates[0].stores, ['X', 'Y']);
    assertEqual(issues.counts.conflicts, 1);
    assertEqual(issues.conflicts[0].sku, '7');
    assertEqual(issues.conflicts[0].fields, ['size']);
  });

  test('值一致的同 SKU 只进 duplicates、不进 conflicts', () => {
    const library = emptyLibrary();
    library.stores.M = { name: 'M', rows: { 9: { sku: '9', name: 'a', size: '55英寸', price: '1000元以下' } } };
    library.stores.N = { name: 'N', rows: { 9: { sku: '9', name: 'a', size: '55英寸', price: '1000元以下' } } };
    const issues = findLibraryIssues(library);
    assertEqual(issues.counts.duplicates, 1);
    assertEqual(issues.counts.conflicts, 0);
  });
});

suite('store-schema · upsertMatch', () => {
  test('新增记录：脏值写入即归一、默认 origin=confirm/verified=true（v2.1.4）', () => {
    const library = emptyLibrary();
    const record = upsertMatch(library, '新类目', {
      sku: '1001',
      name: '商品1',
      size: '55寸',
      price: '25000以上',
      brand: '华为（HUAWEI）',
      model: '  MC75HEE  ',
      package: '4+64GB',
    });
    assertEqual(record.sku, '1001');
    assertEqual(record.size, '55英寸');
    assertEqual(record.price, '25000元以上');
    assertEqual(record.brand, '华为');
    assertEqual(record.model, 'MC75HEE', '型号去首尾空格入库');
    assertEqual(record.package, '4+64GB');
    assertEqual(record.source, '手动');
    assertEqual(record.sizeRaw, '55寸', '原始脏值保留');
    assertEqual(record.verified, true, '人工确认写入默认 verified=true');
    assertEqual(record.origin, 'confirm', 'upsertMatch 默认 origin=confirm');
    assert(record.verifiedAt.length > 0);
    assertEqual(library.stores['新类目'].rows['1001'].name, '商品1');
    assertEqual(library.stores['新类目'].rows['1001'].model, 'MC75HEE');
  });

  test('upsertMatch 选项：origin=manual / verified=false 生效', () => {
    const library = emptyLibrary();
    const manual = upsertMatch(library, '店', { sku: '1', name: 'a', size: '55英寸', price: '1000元以下' }, { origin: 'manual' });
    assertEqual(manual.origin, 'manual');
    assertEqual(manual.verified, true, '人工行内编辑默认已核验');
    const unsure = upsertMatch(library, '店', { sku: '2', name: 'b', size: '55英寸', price: '1000元以下' }, { origin: 'confirm', verified: false });
    assertEqual(unsure.verified, false);
    assertEqual(unsure.verifiedAt, '');
    assertEqual(library.stores['店'].rows['2'].verified, false);
  });

  test('更新记录：不传的字段保留旧值（含 model/package）', () => {
    const library = emptyLibrary();
    upsertMatch(library, '店', { sku: '1', name: '旧名', brand: '海信', size: '55英寸', price: '1000元以下', model: 'OLD-1', package: '4+32G' });
    const updated = upsertMatch(library, '店', { sku: '1', size: '75英寸' });
    assertEqual(updated.name, '旧名');
    assertEqual(updated.brand, '海信');
    assertEqual(updated.size, '75英寸');
    assertEqual(updated.price, '1000元以下');
    assertEqual(updated.model, 'OLD-1', '不传 model 保留旧值');
    assertEqual(updated.package, '4+32G', '不传 package 保留旧值');
  });

  test('空 SKU / 缺类目给中文错误', () => {
    const library = emptyLibrary();
    assertThrows(() => upsertMatch(library, '店', { sku: '' }), 'SKU 为空');
    assertThrows(() => upsertMatch(library, '', { sku: '1' }), '缺少类目名');
  });
});

suite('store-schema · 归一化 / 表格行 / 统计', () => {
  test('normalizeLibrary：旧数据脏值 before→after 报告', () => {
    // 模拟从旧备份手工恢复、未归一的库数据
    const library = emptyLibrary();
    library.stores['旧店'] = {
      name: '旧店',
      rows: {
        5: { sku: '5', name: '老商品', size: '其他（50英寸）', price: '3000元3500元', sizeRaw: '', priceRaw: '', source: '库' },
        6: { sku: '6', name: '老商品2', size: '110英寸', price: '未识别', sizeRaw: '', priceRaw: '', source: '库' },
      },
    };
    const result = normalizeLibrary(library);
    assertEqual(result.changed, 4, '2 条记录 × 2 个字段');
    const sizeDetail = result.details.find((detail) => detail.sku === '5' && detail.field === 'size');
    assertEqual(sizeDetail.before, '其他（50英寸）');
    assertEqual(sizeDetail.after, '其他尺寸(50英寸)');
    assertEqual(library.stores['旧店'].rows[5].size, '其他尺寸(50英寸)');
    assertEqual(library.stores['旧店'].rows[5].price, '3000元至3500元');
    assertEqual(library.stores['旧店'].rows[6].price, '', '未识别价格归一为空');
    assertEqual(result.library, library);
    assert(typeof library.meta.lastNormalizedAt === 'string');
  });

  test('种子库已归一 → normalizeLibrary 无变更', () => {
    const library = seedLibraryFromJson(loadSeed());
    const result = normalizeLibrary(library);
    assertEqual(result.changed, 0);
  });

  test('libraryToRows 字段完整（v2.1.4 含 verified/origin）且脏值可筛选', () => {
    const library = seedLibraryFromJson(loadSeed());
    const rows = libraryToRows(library);
    assertEqual(rows.length, 1101);
    const sample = rows[0];
    for (const field of ['store', 'sku', 'name', 'brand', 'model', 'package', 'size', 'price', 'sizeRaw', 'priceRaw', 'source', 'updatedAt', 'verified', 'origin', 'originText', 'verifiedText', 'verifiedAt', 'sizeDirty', 'priceDirty', 'complete']) {
      assert(Object.prototype.hasOwnProperty.call(sample, field), `缺字段 ${field}`);
    }
    assertEqual(sample.model, '', '种子里没有 model 时默认空串');
    assertEqual(sample.package, '');
    assertEqual(sample.verified, true);
    assertEqual(sample.origin, 'seed');
    assertEqual(sample.verifiedText, '已确认');
    assertEqual(sample.originText, '种子');
    assertEqual(rows.filter((row) => row.sizeDirty || row.priceDirty).length, 25);
    assertEqual(rows.filter((row) => row.complete).length, 638);
  });

  test('statsOfLibrary 覆盖率是 0~1 小数', () => {
    const library = seedLibraryFromJson(loadSeed());
    const stats = statsOfLibrary(library);
    assertEqual(stats.total.completeCoverage, 0.5795);
    assertEqual(stats.total.sizeCoverage, 0.5804);
    assertEqual(stats.total.priceCoverage, 0.5886);
    assertEqual(stats.stores[0].sizeCoverage, 0.74);
    assertEqual(stats.stores[2].sizeCoverage, 0.98);
  });

  test('deriveKeywords 关键词推导', () => {
    const keywords = deriveKeywords('大家电 会议电视');
    assert(keywords.includes('会议电视'));
    assert(keywords.includes('电视'));
    assertEqual(deriveKeywords(''), []);
  });
});

suite('store-schema · v2.1.4 匹配库导出 / 种子迁移', () => {
  test('libraryExportRows：10 列表头与界面一致，数据来源=已确认（种子）', () => {
    const library = seedLibraryFromJson(loadSeed());
    const exported = libraryExportRows(library);
    assertEqual(exported.headers, LIBRARY_EXPORT_HEADERS);
    assertEqual(exported.headers, ['SKU', '商品名称', '店铺', '品牌', '型号', '套餐', '尺寸段', '价格段', '数据来源', '更新时间']);
    assertEqual(exported.rows.length, 1101);
    const first = exported.rows[0];
    assertEqual(first.length, 10);
    assertEqual(first[0], '100200174986');
    assertEqual(first[2], '大家电 会议电视', '店铺=记录所属类目名');
    assertEqual(first[8], '已确认（种子）', '数据来源=核验状态+来源中文');
    assertEqual(first[9], library.meta.generatedAt, '更新时间=记录 updatedAt');
  });

  test('applySeedMigration：指纹相同 + 无需补充 → 不迁移（幂等）', () => {
    const seed = loadSeed();
    const library = seedLibraryFromJson(seed);
    const result = applySeedMigration(library, seed);
    assertEqual(result.migrated, false);
    assertEqual(result.added, 0);
    assertEqual(result.kept, 1101);
    assertEqual(result.keptManual, 0);
    assertEqual(statsOfLibrary(library).total.skus, 1101);
  });

  test('applySeedMigration（默认 merge-missing）：只补缺失 SKU，绝不覆盖已有记录', () => {
    const seed = loadSeed();
    const library = emptyLibrary();
    library.meta.fingerprint = 'old-fingerprint';
    // 旧库：用户已更新的记录（含旧 raw / 人工记录 / 自动记录）都不得被覆盖
    library.stores['大家电 会议电视'] = {
      name: '大家电 会议电视',
      keywords: ['会议电视'],
      rows: {
        900001: { sku: '900001', name: '人工核验商品', size: '75英寸', price: '5000元至5500元', source: '手动', origin: 'manual', verified: true, updatedAt: '2026-11-01T10:00:00+08:00' },
        900002: { sku: '900002', name: '自动记录', size: '65英寸', price: '25000元以上', sizeRaw: '65寸', source: '页面采集', origin: 'import', verified: false },
        900003: { sku: '900003', name: '用户旧库记录', size: '55英寸', price: '1000元以下', source: '库', origin: 'import', verified: true },
      },
    };
    // 用户库里有 seed 里没有的自建类目，也必须保留
    library.stores['新类目'] = {
      name: '新类目',
      rows: { 900004: { sku: '900004', name: '遗留人工记录', size: '86/85英寸', price: '25000元以上', source: '手动', origin: 'confirm', verified: true } },
    };
    const before = JSON.stringify(library.stores);
    const result = applySeedMigration(library, seed);
    assertEqual(result.migrated, true);
    assertEqual(result.seedRows, 1101, '种子共 1101 行');
    assertEqual(result.added, 1101, '缺失的 1101 个种子 SKU 全部补入');
    assertEqual(result.kept, 4, '原有 4 条记录全部保留');
    assertEqual(result.keptManual, 2, '人工/确认记录 2 条');
    assertEqual(statsOfLibrary(library).total.skus, 1105, '1101 + 原 4 条');
    // 已有记录内容一个字节都不能变
    const afterStores = JSON.parse(JSON.stringify(library.stores));
    for (const [storeName, store] of Object.entries(JSON.parse(before))) {
      for (const [sku, record] of Object.entries(store.rows || {})) {
        assertEqual(afterStores[storeName].rows[sku], record, `已有记录不得被覆盖：${storeName}/${sku}`);
      }
    }
    assertEqual(library.meta.fingerprint, '780d76cf20900fe3', '合并后记录种子版本');
    assert(library.meta.logs.some((log) => log.action === 'seed-migrate'), '留种子迁移日志');
    // 幂等：再跑没有可补的
    const again = applySeedMigration(library, seed);
    assertEqual(again.migrated, false);
    assertEqual(again.added, 0);
  });

  test('applySeedMigration（显式 replace）：整体替换为内置种子', () => {
    const seed = loadSeed();
    const library = emptyLibrary();
    library.meta.fingerprint = 'legacy';
    library.stores['老店'] = {
      name: '老店',
      rows: { 800001: { sku: '800001', name: '老人工', size: '75英寸', price: '5000元至5500元', source: '手动' } },
    };
    const result = applySeedMigration(library, seed, { mode: 'replace' });
    assertEqual(result.migrated, true);
    assertEqual(result.seedRows, 1101);
    assertEqual(result.added, 1101);
    assertEqual(result.kept, 0);
    assertEqual(statsOfLibrary(library).total.skus, 1101, '重置后只剩种子库');
    assertEqual(library.stores['老店'], undefined, '显式重置会丢弃旧库');
    assert(library.meta.logs.some((log) => log.action === 'reset-seed'), '留重置日志');
  });
});

suite('store-schema · v2.1.5 确认写入完整性 / 操作日志', () => {
  test('确认写入：旧 raw 干扰下尺寸段+价格段都必须正确写入（20.5 BUG）', () => {
    const library = emptyLibrary();
    library.stores['店'] = {
      name: '店',
      rows: {
        1: { sku: '1', name: '旧商品', size: '55英寸', price: '1000元以下', sizeRaw: '乱值A', priceRaw: '乱值B', source: '库' },
      },
    };
    // 模拟 UI「确认写入」：只传行上规范值，不传 sizeRaw/priceRaw
    const record = upsertMatch(library, '店', { sku: '1', name: '旧商品', size: '75英寸', price: '5000元至5500元' });
    assertEqual(record.size, '75英寸', '尺寸段强制覆盖为规范值');
    assertEqual(record.price, '5000元至5500元', '价格段强制覆盖为规范值');
    assertEqual(record.sizeRaw, '', '旧 sizeRaw 不再干扰');
    assertEqual(record.priceRaw, '', '旧 priceRaw 不再干扰');
    assertEqual(library.stores['店'].rows['1'].size, '75英寸');
    assertEqual(library.stores['店'].rows['1'].price, '5000元至5500元');
    assertEqual(record.verified, true);
    assertEqual(record.origin, 'confirm');
  });

  test('确认写入：只传一个字段时另一个保留旧值', () => {
    const library = emptyLibrary();
    upsertMatch(library, '店', { sku: '1', name: 'a', size: '55英寸', price: '1000元以下' });
    const record = upsertMatch(library, '店', { sku: '1', size: '86/85英寸' }, { origin: 'manual' });
    assertEqual(record.size, '86/85英寸');
    assertEqual(record.price, '1000元以下', '未传价格段保留旧值');
    assertEqual(record.sizeRaw, '');
  });

  test('确认写入：脏值规范输入 → 归一 + 保留 raw 参考字段', () => {
    const library = emptyLibrary();
    const record = upsertMatch(library, '店', { sku: '1', name: 'a', size: '75寸', price: '3000元3500元' });
    assertEqual(record.size, '75英寸');
    assertEqual(record.price, '3000元至3500元');
    assertEqual(record.sizeRaw, '75寸', '脏值原文保留供追溯');
    assertEqual(record.priceRaw, '3000元3500元');
  });

  test('appendLibraryLog / libraryLogRows：记录、排序、上限 500', () => {
    const library = emptyLibrary();
    const entry = appendLibraryLog(library, {
      action: 'confirm',
      store: '店',
      sku: '1',
      changes: [
        { field: 'size', before: '55英寸', after: '75英寸' },
        { field: 'price', before: '1000元以下', after: '5000元至5500元' },
      ],
      source: '手动',
      note: '确认写入',
    });
    assert(entry.at.length > 0, '自动补时间');
    assertEqual(LIBRARY_LOG_ACTIONS.confirm, '确认写入');
    assertEqual(library.meta.logs.length, 1);
    let rows = libraryLogRows(library);
    assertEqual(rows.length, 2, '两处字段变化展成两行');
    assertEqual(rows[0].actionText, '确认写入');
    assertEqual(rows[0].at, entry.at);
    // 上限 500 滚动
    for (let index = 0; index < LIBRARY_LOG_LIMIT + 10; index += 1) {
      appendLibraryLog(library, { action: 'manual-edit', store: '店', sku: `${index}`, field: 'brand', before: '', after: '海信' });
    }
    assertEqual(library.meta.logs.length, LIBRARY_LOG_LIMIT, '日志上限 500');
    rows = libraryLogRows(library);
    assert(rows.length >= LIBRARY_LOG_LIMIT);
    // 时间倒序：最新一条在最前（最后追加的是 sku 509）
    assertEqual(rows[0].sku, `${LIBRARY_LOG_LIMIT + 9}`);
    assertEqual(rows[0].action, 'manual-edit');
    assertEqual(rows[0].actionText, '人工编辑');
    assertEqual(LIBRARY_LOG_ACTIONS['seed-migrate'], '种子迁移');
    assertEqual(LIBRARY_LOG_ACTIONS['reset-seed'], '重置内置库');
    assertEqual(LIBRARY_LOG_ACTIONS['clear-logs'], '清空日志');
  });

  test('clearLibraryLogs：返回清空条数、保留 1 条 clear-logs 审计、空日志不产生噪音', () => {
    const library = emptyLibrary();
    assertEqual(clearLibraryLogs(library), 0, '没有日志时返回 0');
    assert(!Array.isArray(library.meta.logs) || library.meta.logs.length === 0, '没有日志时也不产生清空日志');
    appendLibraryLog(library, { action: 'confirm', store: '店', sku: '1', field: 'size', before: '', after: '75英寸' });
    appendLibraryLog(library, { action: 'manual-edit', store: '店', sku: '2', field: 'brand', before: '', after: '海信' });
    assertEqual(library.meta.logs.length, 2);
    const cleared = clearLibraryLogs(library);
    assertEqual(cleared, 2, '返回被清空条数');
    assertEqual(library.meta.logs.length, 1, '清空后保留 1 条 clear-logs 审计');
    assertEqual(library.meta.logs[0].action, 'clear-logs');
    assert(library.meta.logs[0].note.includes('清空操作日志 2 条'));
    const rows = libraryLogRows(library);
    assertEqual(rows[0].actionText, '清空日志');
    // 非法/空库不抛错
    assertEqual(clearLibraryLogs(null), 0);
    assertEqual(clearLibraryLogs({}), 0);
  });

  test('upsert / merge / normalize 均自动留痕且字段级 before→after 正确', () => {
    const library = emptyLibrary();
    // upsert（confirm）
    upsertMatch(library, '店', { sku: '1', name: '商品', size: '75英寸', price: '5000元至5500元' });
    let rows = libraryLogRows(library);
    const confirmLog = rows.find((row) => row.action === 'confirm');
    assert(confirmLog, '确认写入留痕');
    const sizeChange = rows.find((row) => row.action === 'confirm' && row.field === 'size');
    assertEqual(sizeChange.before, '');
    assertEqual(sizeChange.after, '75英寸');
    const priceChange = rows.find((row) => row.action === 'confirm' && row.field === 'price');
    assertEqual(priceChange.after, '5000元至5500元');
    // manual-edit
    upsertMatch(library, '店', { sku: '1', size: '86/85英寸' }, { origin: 'manual' });
    rows = libraryLogRows(library);
    const manualLog = rows.find((row) => row.action === 'manual-edit' && row.field === 'size');
    assert(manualLog, '人工编辑留痕');
    assertEqual(manualLog.before, '75英寸');
    assertEqual(manualLog.after, '86/85英寸');
    // merge
    mergeLibrary(library, { stores: [{ name: '导入店', rows: [{ sku: '2', name: '导入商品' }] }] });
    assert(libraryLogRows(library).some((row) => row.action === 'import-merge' && row.note.includes('新增 SKU 1')));
    // normalize
    library.stores['店'].rows['1'].sizeRaw = '乱值';
    normalizeLibrary(library);
    assert(libraryLogRows(library).some((row) => row.action === 'normalize' && row.note.includes('归一化脏值')));
  });
});

suite('store-schema · v2.1.5 类目合并去重 mergeStores / dedupeStore（20.13）', () => {
  function makeMergeLibrary() {
    const library = emptyLibrary();
    library.stores['3C店'] = {
      name: '3C店',
      keywords: ['3C店'],
      rows: {
        1001: { sku: '1001', name: '商品A', brand: '海信', size: '75英寸', price: '', source: '手动', origin: 'manual', verified: true, updatedAt: '2026-11-04T10:00:00+08:00', sizeRaw: '' },
        // 同一个 SKU 的另一种写法（大小写/空格差异）→ 去重
        1002: { sku: '1002', name: '', size: '', price: '5000元至5500元', source: '导入', origin: 'import', verified: true, updatedAt: '2026-11-03T10:00:00+08:00' },
        // 前导零写法，需合并
        1003: { sku: '1003', name: '商品C', size: '', price: '', source: '导入', origin: 'import', verified: true, updatedAt: '2026-11-01T10:00:00+08:00' },
      },
    };
    library.stores['导入类目'] = {
      name: '导入类目',
      keywords: ['导入类目'],
      rows: {
        '1001 ': { sku: '1001 ', name: '商品A（新名）', brand: '', model: 'MC75HEE', package: '含支架', size: '75英寸', price: '5000元至5500元', source: '导入', origin: 'import', verified: true, updatedAt: '2026-11-02T10:00:00+08:00' },
        '1002': { sku: '1002', name: '商品B', brand: 'TCL', size: '86/85英寸', price: '', source: '导入', origin: 'import', verified: false, updatedAt: '2026-11-01T10:00:00+08:00' },
        '1003': { sku: '1003', name: '商品C（导入）', brand: '创维', size: '98/100英寸', price: '', source: '导入', origin: 'import', verified: true, updatedAt: '2026-11-02T10:00:00+08:00' },
      },
    };
    return library;
  }

  test('mergeStores：dryRun 只预览不改库；执行后去重+字段逐项合并+删源类目+日志', () => {
    const library = makeMergeLibrary();
    const snapshot = JSON.stringify(library);
    const dry = mergeStores(library, { sources: ['3C店', '导入类目'], target: { name: '3C店' }, dryRun: true });
    assertEqual(dry.ok, true);
    assertEqual(dry.dryRun, true);
    assertEqual(JSON.stringify(library), snapshot, 'dryRun 不得改库');
    assertEqual(dry.preview.rowsBefore, 6);
    assertEqual(dry.preview.uniqueAfter, 3, '3 个 SKU 去重后 3 条');
    assertEqual(dry.preview.duplicates, 3);
    assert(dry.preview.conflictCount >= 2, 'name/size/price 至少 2 个字段冲突');
    assert(Array.isArray(dry.preview.conflicts) && dry.preview.conflicts.length <= 50);
    assertEqual(dry.preview.mergedStores, 2);
    assertEqual(library.meta.logs, undefined, 'dryRun 不写日志');

    const result = mergeStores(library, { sources: ['3C店', '导入类目'], target: { name: '3C店' } });
    assertEqual(result.ok, true);
    assertEqual(result.dryRun, false);
    assertEqual(library.stores['导入类目'], undefined, '源类目已删除');
    assertEqual(Object.keys(library.stores), ['3C店'], '合并后只剩目标类目');
    const rows = library.stores['3C店'].rows;
    assertEqual(Object.keys(rows).length, 3);
    // 1001：verified/manual 记录（updatedAt 更新）优先，name 取优先级最高的「商品A」；price 由导入记录补；model/package 也合并进来
    assertEqual(rows['1001'].name, '商品A');
    assertEqual(rows['1001'].size, '75英寸');
    assertEqual(rows['1001'].price, '5000元至5500元');
    assertEqual(rows['1001'].model, 'MC75HEE');
    assertEqual(rows['1001'].package, '含支架');
    assertEqual(rows['1001'].verified, true, '保留人工/confirm 的已确认状态');
    // 1002：verified 高的（3C店）优先取 price；size 由未 verified 导入记录补
    assertEqual(rows['1002'].price, '5000元至5500元');
    assertEqual(rows['1002'].size, '86/85英寸');
    assertEqual(rows['1002'].brand, 'TCL');
    // 1003：前导差异合并，优先级（updatedAt 新）取导入记录
    assertEqual(rows['1003'].name, '商品C（导入）');
    assertEqual(rows['1003'].size, '98/100英寸');
    assertEqual(rows['1003'].brand, '创维');
    // 日志 1 条 merge-stores
    const logs = libraryLogRows(library).filter((row) => row.action === 'merge-stores');
    assertEqual(logs.length, 1);
    assertEqual(logs[0].actionText, '合并类目');
    assert(logs[0].note.includes('重复 3 条'));
    assert(library.meta.lastMergeBackupAt, '记录合并快照时间戳供 UI 写 libraryBackup_v215');
    assertEqual(library.meta.lastMergeStores.uniqueAfter, 3);
  });

  test('mergeStores：源类目不存在/空参数返回 ok:false；目标不存在可创建', () => {
    const library = makeMergeLibrary();
    assertEqual(mergeStores(library, { sources: [], target: { name: 'X' } }).ok, false);
    assertEqual(mergeStores(library, { sources: ['不存在'], target: { name: 'X' } }).ok, false);
    assertEqual(mergeStores(library, { sources: ['3C店'], target: { name: '' } }).ok, false);
    const result = mergeStores(library, { sources: ['导入类目'], target: { name: '新合并类目', create: true } });
    assertEqual(result.ok, true);
    assert(library.stores['新合并类目'], '目标类目自动创建');
    assertEqual(library.stores['新合并类目'].keywords.includes('新合并类目'), true, 'keywords 按目标名重算');
    assertEqual(library.stores['导入类目'], undefined);
  });

  test('dedupeStore：单类目去重、dryRun、空/单记录边界', () => {
    const library = emptyLibrary();
    library.stores['店'] = {
      name: '店',
      rows: {
        1: { sku: '1', name: '旧名', size: '75英寸', price: '', verified: true, updatedAt: '2026-11-04T10:00:00+08:00' },
        ' 1 ': { sku: ' 1 ', name: '新名', size: '', price: '5000元至5500元', verified: false, updatedAt: '2026-11-01T10:00:00+08:00' },
        2: { sku: '2', name: '单独', size: '98/100英寸', price: '', verified: true, updatedAt: '2026-11-01T10:00:00+08:00' },
      },
    };
    const dry = dedupeStore(library, '店', { dryRun: true });
    assertEqual(dry.ok, true);
    assertEqual(dry.removed, 1);
    assertEqual(Object.keys(library.stores['店'].rows).length, 3, 'dryRun 不改库（原 3 条仍在）');
    const result = dedupeStore(library, '店');
    assertEqual(result.ok, true);
    assertEqual(result.removed, 1);
    assertEqual(Object.keys(library.stores['店'].rows).length, 2);
    const merged = library.stores['店'].rows['1'];
    assertEqual(merged.name, '旧名', 'verified+时间新的记录优先');
    assertEqual(merged.price, '5000元至5500元', '价格字段由低优先级记录补');
    assert(dedupeStore(library, '店').removed === 0, '已去重后再次调用 removed=0');
    assertEqual(dedupeStore(library, '不存在').ok, false);
    assertEqual(dedupeStore({ stores: {} }, '店').ok, false);
    // 空类目边界
    library.stores['空类目'] = { name: '空类目', rows: {} };
    const empty = dedupeStore(library, '空类目');
    assertEqual(empty.ok, true);
    assertEqual(empty.removed, 0);
    // 日志
    const logs = libraryLogRows(library).filter((row) => row.action === 'dedupe-store');
    assert(logs.length >= 1);
    assertEqual(logs[0].actionText, '类目去重');
    assertEqual(LIBRARY_LOG_ACTIONS['merge-stores'], '合并类目');
    assertEqual(LIBRARY_LOG_ACTIONS['dedupe-store'], '类目去重');
  });
});
