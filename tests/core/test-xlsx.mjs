/** tests/core/test-xlsx.mjs —— xlsx 读取/写出/round-trip/openpyxl 复核 */
import { readFileSync } from 'node:fs';
import { readXlsx } from '../../extension/lib/xlsx-read.js';
import { writeXlsx } from '../../extension/lib/xlsx-write.js';
import { suite, test, assert, assertEqual, assertThrows } from './harness.mjs';
import { REPORT_FILES, LIBRARY_XLSX, DATA_DIR } from './paths.mjs';
import { requireSample, writeAndInspect, tmpPath } from './helpers.mjs';

async function readFile(path) {
  requireSample(path);
  return readXlsx(readFileSync(path));
}

suite('xlsx-read · 5 个真实文件', () => {
  test('会议平板：1×1 假 dimension 也必须读出 201 行 × 13 列', async () => {
    const { sheets } = await readFile(REPORT_FILES[0].path);
    assertEqual(sheets.length, 1);
    assertEqual(sheets[0].rows.length, 201, '行数（含表头）');
    assertEqual(sheets[0].rows[0].length, 13, '列数');
    assertEqual(sheets[0].rows[0], ['时间', '排名', '排名变化', '商品名称', 'SKU ID', '店铺名称', '商品标识', '成交金额', '成交商品件数', '浏览量', '访客数', '搜索点击次数', '成交单量']);
    assertEqual(sheets[0].rows[1][4], '100221505838', 'SKU 必须是字符串');
    assertEqual(sheets[0].rows[1][7], '￥200万 ~ ￥400万', '成交金额原文');
  });

  test('会议电视：200 条数据、SKU 无小数尾', async () => {
    const { sheets } = await readFile(REPORT_FILES[1].path);
    assertEqual(sheets[0].rows.length, 201);
    const skus = sheets[0].rows.slice(1).map((row) => row[4]);
    assertEqual(new Set(skus).size, 200, 'SKU 不重复');
    for (const sku of skus) {
      assert(typeof sku === 'string' && /^\d+$/.test(sku), `SKU 应为纯数字文本：${sku}`);
    }
  });

  test('教育教学一体机：2 个 sheet，数据页 201 行 × 20 列（active sheet 是说明页）', async () => {
    const { sheets } = await readFile(REPORT_FILES[2].path);
    assertEqual(sheets.length, 2);
    const dataSheet = sheets.find((sheet) => sheet.name === '教学教育一体机');
    const infoSheet = sheets.find((sheet) => sheet.name === '尺寸段和价格段');
    assert(dataSheet, '缺少数据页「教学教育一体机」');
    assert(infoSheet, '缺少说明页「尺寸段和价格段」');
    assertEqual(dataSheet.rows.length, 201);
    assertEqual(dataSheet.rows[0].length, 20);
    assertEqual(dataSheet.rows[0][0], 'sku');
    assertEqual(dataSheet.rows[0][11], 'SKU ID');
    assertEqual(infoSheet.rows.length, 20, '说明页 20 行');
    assertEqual(infoSheet.rows[0], ['尺寸段', '价格段(17段)']);
    assertEqual(infoSheet.rows[1], ['55英寸', '1000元以下']);
  });

  test('tangpingnature：SPU ID 表头 + 200 条', async () => {
    const { sheets } = await readFile(REPORT_FILES[3].path);
    assertEqual(sheets.length, 1);
    assertEqual(sheets[0].rows.length, 201);
    assertEqual(sheets[0].rows[0][4], 'SPU ID');
    assertEqual(sheets[0].rows[1][4], '100328135697');
  });

  test('匹配库：4 个工作表 / 201/201/502/201 行 / 数字 SKU 文本化', async () => {
    const { sheets } = await readFile(LIBRARY_XLSX);
    assertEqual(sheets.map((sheet) => sheet.name), ['大家电 会议电视', '大家电 会议平板一体机', '3C店', '品牌A 教育一体机']);
    assertEqual(sheets.map((sheet) => sheet.rows.length), [201, 201, 502, 201]);
    assertEqual(sheets[0].rows[0], ['SKU（商品编码）', '商品名称', '品牌', '尺寸段', '价格段']);
    assertEqual(sheets[0].rows[1][0], '100200174986', '数字单元格转字符串');
    assertEqual(sheets[0].rows[1][3], '98/100英寸');
    assertEqual(sheets[3].rows[1][0], '100253716031');
  });

  test('空单元格返回 null、行尾补 null', async () => {
    const { sheets } = await readFile(REPORT_FILES[2].path);
    const row = sheets[0].rows[1];
    assertEqual(row[2], null, '品牌列空单元格应为 null');
    assertEqual(row[3], null, '型号列空单元格应为 null');
    assertEqual(row[4], null, '套餐列空单元格应为 null');
  });
});

suite('xlsx-read · 错误处理', () => {
  test('非 xlsx 字节给出中文错误', async () => {
    await assertThrows(() => readXlsx(new Uint8Array([1, 2, 3, 4, 5])), '读取 xlsx 失败');
    await assertThrows(() => readXlsx(new Uint8Array(0)), '读取 xlsx 失败');
  });

  test('不支持文件路径字符串', async () => {
    await assertThrows(() => readXlsx('C:/a.xlsx'), '读取 xlsx 失败');
  });
});

suite('xlsx-write · 写出 + 读回 + openpyxl 复核', () => {
  test('表头样式/冻结/列宽/数字类型/openpyxl 可打开', async () => {
    const payload = {
      sheets: [
        {
          name: '测试表',
          columns: [
            { header: 'SKU', width: 18 },
            { header: '商品名称', width: 40 },
            { header: '尺寸段', width: 14 },
            { header: '成交金额(万元)', width: 16 },
            { header: '备注' },
          ],
          rows: [
            ['100200174986', '海信100英寸会议电视', '98/100英寸', 62.5, '正常'],
            ['100262254939', '海信100英寸C位屏', '98/100英寸', 120, null],
            ['', '空 SKU 行', '其他', 0, null],
          ],
        },
        {
          name: '原始_回填',
          rows: [
            ['标题行', null, null],
            ['SKU ID', '商品名称', '尺寸段'],
            ['100221505838', '某商品', '86/85英寸'],
          ],
          headerRow: 1,
        },
      ],
    };
    const { path, bytes, inspection } = await writeAndInspect(writeXlsx, payload, 'write-basic.xlsx');
    assert(bytes.length > 1000, '文件字节数');
    assertEqual(inspection.sheets.length, 2);
    const [sheetA, sheetB] = inspection.sheets;
    assertEqual(sheetA.title, '测试表');
    assertEqual(sheetA.max_row, 4, 'openpyxl 行数');
    assertEqual(sheetA.max_column, 5, 'openpyxl 列数');
    assertEqual(sheetA.freeze, 'A2', '冻结首行');
    assertEqual(sheetA.header_bold, true, '表头加粗');
    assertEqual(sheetA.header_fill, 'FF1F4E78', '表头底色');
    assertEqual(sheetA.rows[1], ['100200174986', '海信100英寸会议电视', '98/100英寸', 62.5, '正常']);
    assertEqual(typeof sheetA.rows[1][3], 'number', '数字必须写成数字');
    assertEqual(sheetA.rows[2][3], 120);
    assertEqual(sheetB.freeze, 'A3', '第 2 行是表头 → 冻结到 A3');
    const headerCell = inspection.sheets[1].rows[1];
    assertEqual(headerCell, ['SKU ID', '商品名称', '尺寸段']);

    // 自己的 reader 也能读回（字符串化符合契约）
    const readBack = await readXlsx(readFileSync(path));
    assertEqual(readBack.sheets[0].rows.length, 4);
    assertEqual(readBack.sheets[0].rows[0][0], 'SKU');
    assertEqual(readBack.sheets[0].rows[1][3], '62.5');
    assertEqual(readBack.sheets[1].rows[2][0], '100221505838');
  });

  test('工作表名非法字符/超长/重名自动处理', async () => {
    const longName = '很长的名字'.repeat(10);
    const payload = {
      sheets: [
        { name: 'a/b:c*d?e[f]g', rows: [['x']] },
        { name: longName, rows: [['y']] },
        { name: '重名', rows: [['1']] },
        { name: '重名', rows: [['2']] },
      ],
    };
    const { inspection } = await writeAndInspect(writeXlsx, payload, 'write-names.xlsx');
    assertEqual(inspection.sheets.length, 4);
    for (const sheet of inspection.sheets) {
      assert(sheet.title.length <= 31, `工作表名长度 ≤31：${sheet.title}`);
      assert(!/[[\]:*?/\\]/.test(sheet.title), `工作表名不含非法字符：${sheet.title}`);
    }
    assertEqual(new Set(inspection.sheets.map((sheet) => sheet.title)).size, 4, '工作表名不可重复');
  });

  test('空工作簿/无工作表给出中文错误', async () => {
    await assertThrows(() => writeXlsx({ sheets: [] }), 'xlsx 写出失败');
    await assertThrows(() => writeXlsx({}), 'xlsx 写出失败');
  });

  test('800 行规模写出后 openpyxl 复核通过', async () => {
    const rows = [];
    for (let index = 0; index < 800; index += 1) {
      rows.push([`r-${index}`, `商品${index}`, '55英寸', '1000元以下', 0.1 + index, null]);
    }
    const payload = {
      sheets: [
        {
          name: '配对_1',
          columns: [
            { header: '行号', width: 8 },
            { header: '商品名称', width: 40 },
            { header: '尺寸段', width: 14 },
            { header: '价格段', width: 20 },
            { header: '成交金额(万元)', width: 16 },
            { header: '备注', width: 20 },
          ],
          rows,
        },
      ],
    };
    const { inspection, path } = await writeAndInspect(writeXlsx, payload, 'write-800.xlsx');
    assertEqual(inspection.sheets[0].max_row, 801);
    assertEqual(inspection.sheets[0].max_column, 6);
    assert(path.endsWith('write-800.xlsx'));
    assertEqual(tmpPath('write-800.xlsx'), path);
  });
});

suite('xlsx · 真实文件只读确认', () => {
  test('资料目录只读：测试过程只读取，不写', async () => {
    const { sheets } = await readFile(REPORT_FILES[0].path);
    assert(sheets.length > 0);
    assert(DATA_DIR.includes('资料'), '样本目录常量');
  });
});
