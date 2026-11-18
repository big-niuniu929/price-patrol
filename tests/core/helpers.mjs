/** tests/core/helpers.mjs —— 测试公共工具（真实文件加载、openpyxl 复核、临时文件） */
import { mkdirSync, readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { TMP_DIR, PYTHON, SEED_PATH, REPORT_FILES, LIBRARY_XLSX } from './paths.mjs';
import { readXlsx } from '../../extension/lib/xlsx-read.js';
import { pickDataSheet, parseReportSheet, suggestStoreBinding } from '../../extension/lib/header-map.js';
import { seedLibraryFromJson } from '../../extension/lib/store-schema.js';

/** 建临时目录 */
export function ensureTmpDir() {
  mkdirSync(TMP_DIR, { recursive: true });
  return TMP_DIR;
}

/** 临时文件路径 */
export function tmpPath(name) {
  ensureTmpDir();
  return join(TMP_DIR, name);
}

/** 校验真实样本存在（缺失时给人话错误，而不是 ENOENT 堆栈） */
export function requireSample(path) {
  try {
    readFileSync(path);
  } catch (error) {
    throw new Error(`找不到测试样本（资料目录只读，请确认本机存在）：${path}`);
  }
}

/** 读内置种子 JSON */
export function loadSeed() {
  return JSON.parse(readFileSync(SEED_PATH, 'utf8'));
}

/** 种子 → 匹配库 */
export function loadSeedLibrary() {
  return seedLibraryFromJson(loadSeed());
}

/**
 * 读取 + 解析一个真实榜单文件（与 UI 导入流程一致）。
 * @param {{fileName:string, path:string}} entry
 * @param {object} library
 * @returns {Promise<{fileName, path, sheets, picked, parsed, binding, report}>}
 */
export async function loadReport(entry, library) {
  requireSample(entry.path);
  const { sheets } = await readXlsx(readFileSync(entry.path));
  const picked = pickDataSheet(sheets);
  if (picked.index < 0) throw new Error(`没有识别出数据工作表：${entry.fileName}`);
  const parsed = parseReportSheet(sheets[picked.index]);
  const binding = suggestStoreBinding({ rows: parsed.rows, fileName: entry.fileName }, library);
  const report = {
    id: `r-${entry.fileName}`,
    fileName: entry.fileName,
    sheetName: parsed.sheetName,
    headerRow: parsed.headerRow,
    headers: parsed.headers,
    originalSheets: sheets,
    store: binding.store,
    storeScore: binding.score,
    rows: parsed.rows,
  };
  return { fileName: entry.fileName, path: entry.path, sheets, picked, parsed, binding, report };
}

/** 读全部 4 个真实榜单 */
export async function loadAllReports(library) {
  const list = [];
  for (const entry of REPORT_FILES) {
    // eslint-disable-next-line no-await-in-loop
    list.push(await loadReport(entry, library));
  }
  return list;
}

/** 读真实匹配库.xlsx 的 sheets（用于「导入匹配库」流程测试） */
export async function loadLibraryXlsxSheets() {
  requireSample(LIBRARY_XLSX);
  const { sheets } = await readXlsx(readFileSync(LIBRARY_XLSX));
  return sheets;
}

/** openpyxl 复核脚本：输出每个工作表的结构/值/表头样式/冻结 */
const OPENPYXL_INSPECT_SCRIPT = `
import json, sys
try:
    import openpyxl
except Exception as exc:
    with open(sys.argv[2], 'w', encoding='utf-8') as handle:
        json.dump({'error': 'openpyxl 不可用：' + str(exc)}, handle, ensure_ascii=False)
    sys.exit(3)

wb = openpyxl.load_workbook(sys.argv[1])
result = {'sheets': []}
for ws in wb.worksheets:
    rows = [[cell.value for cell in row] for row in ws.iter_rows()]
    first = ws.cell(row=1, column=1)
    fill = None
    try:
        color = first.fill.fgColor
        if color is not None and color.type == 'rgb':
            fill = color.rgb
    except Exception:
        fill = None
    result['sheets'].append({
        'title': ws.title,
        'max_row': ws.max_row,
        'max_column': ws.max_column,
        'freeze': str(ws.freeze_panes) if ws.freeze_panes else None,
        'header_bold': bool(first.font.bold),
        'header_fill': fill,
        'rows': rows,
    })
wb.close()
with open(sys.argv[2], 'w', encoding='utf-8') as handle:
    json.dump(result, handle, ensure_ascii=False, default=str)
`;

/**
 * 用本机 python + openpyxl 打开生成的 xlsx 并返回结构。
 * 说明：沙箱下 Node 不能通过管道读子进程输出，所以让 python 把结果写 JSON 文件再读。
 */
export function inspectXlsxWithOpenpyxl(xlsxPath, tag = 'book') {
  const outPath = tmpPath(`openpyxl-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.json`);
  const result = spawnSync(PYTHON, ['-c', OPENPYXL_INSPECT_SCRIPT, xlsxPath, outPath], {
    stdio: 'ignore',
    windowsHide: true,
  });
  if (result.error) {
    throw new Error(
      `调用 python 做 openpyxl 复核失败（${result.error.code || result.error.message}）。` +
        `请确认 python 存在：${PYTHON}`,
    );
  }
  const inspection = JSON.parse(readFileSync(outPath, 'utf8'));
  if (inspection.error) throw new Error(inspection.error);
  if (result.status !== 0) {
    throw new Error(`openpyxl 无法打开生成的 xlsx（python 退出码 ${result.status}）`);
  }
  return inspection;
}

/** 写 xlsx 到临时文件 + openpyxl 复核，返回 {path, bytes, inspection} */
export async function writeAndInspect(writeXlsx, payload, name) {
  const bytes = await writeXlsx(payload);
  const path = tmpPath(name);
  writeFileSync(path, bytes);
  return { path, bytes, inspection: inspectXlsxWithOpenpyxl(path, name.replace(/\.xlsx$/, '')) };
}

/** 求和（忽略非数字） */
export function sumOf(values) {
  return values.reduce((sum, value) => (typeof value === 'number' && Number.isFinite(value) ? sum + value : sum), 0);
}
