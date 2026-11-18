/** tests/core/paths.mjs —— 测试用到的路径常量 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
/** 工作目录根（市占率/） */
export const ROOT = resolve(here, '..', '..');
export const EXTENSION_DIR = join(ROOT, 'extension');
export const LIB_DIR = join(EXTENSION_DIR, 'lib');
export const SEED_PATH = join(EXTENSION_DIR, 'data', 'base-skus.json');
export const TMP_DIR = join(here, '.tmp');

/** 真实样本目录（只读，不改动） */
export const DATA_DIR = '~/Desktop/资料';
export const LIBRARY_XLSX = join(DATA_DIR, '匹配库.xlsx');

/** 4 个真实榜单 + 期望（文件名用于展示/绑定） */
export const REPORT_FILES = [
  {
    fileName: '11月-会议平板.xlsx',
    path: join(DATA_DIR, '11月-会议平板.xlsx'),
    expectedStore: '大家电 会议平板一体机',
    expectedScore: 0.525,
    expectedRows: 200,
  },
  {
    fileName: '11月-会议电视.xlsx',
    path: join(DATA_DIR, '11月-会议电视.xlsx'),
    expectedStore: '大家电 会议电视',
    expectedScore: 0.485,
    expectedRows: 200,
  },
  {
    fileName: '11月-教育教学一体机.xlsx',
    path: join(DATA_DIR, '11月-教育教学一体机.xlsx'),
    expectedStore: '品牌A 教育一体机',
    expectedScore: 0.375,
    expectedRows: 200,
    expectedSheets: 2,
  },
  {
    fileName: 'tangpingnature_商品榜单_热销排名_离线_汇总下载_2026-10-01_2026-10-31.xlsx',
    path: join(DATA_DIR, 'tangpingnature_商品榜单_热销排名_离线_汇总下载_2026-10-01_2026-10-31.xlsx'),
    expectedStore: '3C店',
    expectedScore: 0.38,
    expectedRows: 200,
  },
];

/** 本机 python（openpyxl 复核用）；可用环境变量 DSH_TEST_PYTHON 覆盖 */
export const PYTHON =
  process.env.DSH_TEST_PYTHON ||
  '~\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe';
