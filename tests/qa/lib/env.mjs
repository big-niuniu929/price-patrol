// tests/qa/lib/env.mjs —— 验收脚本公共环境常量与工具（零依赖）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

export const HERE = path.dirname(fileURLToPath(import.meta.url)); // tests/qa/lib
export const QA_DIR = path.resolve(HERE, '..'); // tests/qa
export const ROOT = path.resolve(QA_DIR, '..', '..'); // 仓库根
export const EXT_DIR = path.join(ROOT, 'extension');
export const DATA_DIR = '~/Desktop/资料';
export const TMP_DIR = path.join(QA_DIR, '.tmp');
export const SHOTS_DIR = path.join(ROOT, 'docs', 'shots');

// 真实榜单（顺序与截图/报告一致）
export const REPORTS = [
  { file: '11月-会议平板.xlsx', sheet: '品牌B大家电商智_商品榜单_热销排名_离线_汇总下载', skuHeader: 'SKU ID', rows: 200, amountOk: 200, amountSumWan: 1885.1, libSizeHits: 0 },
  { file: '11月-会议电视.xlsx', sheet: '品牌B大家电商智_商品榜单_热销排名_离线_汇总下载', skuHeader: 'SKU ID', rows: 200, amountOk: 200, amountSumWan: 2360.5, libSizeHits: 89 },
  { file: '11月-教育教学一体机.xlsx', sheet: '教学教育一体机', skuHeader: ['sku', 'SKU ID'], rows: 200, amountOk: 200, amountSumWan: 1074.5, libSizeHits: 1 },
  { file: 'tangpingnature_商品榜单_热销排名_离线_汇总下载_2026-10-01_2026-10-31.xlsx', sheet: 'tangpingnature_商品榜单_热销排名_离线_汇总下', skuHeader: 'SPU ID', rows: 200, amountOk: 200, amountSumWan: 4942.5, libSizeHits: 21 },
];

// 内置种子库基准（extension/data/base-skus.json，v2.1.4 由「资料/匹配库.xlsx」2026-11-03 新版重建，
// 权威种子 1101 SKU / 638 齐全，不再合并旧 legacy 脏数据；DESIGN §19.4）
export const LIBRARY_EXPECT = {
  stores: ['大家电 会议电视', '大家电 会议平板一体机', '3C店', '品牌A 教育一体机'],
  storeRows: { '大家电 会议电视': 200, '大家电 会议平板一体机': 200, '3C店': 501, '品牌A 教育一体机': 200 },
  totalRows: 1101,
  filledBoth: 638,
  schemaVersion: '2026-11-03.780d76',
  fingerprint: '780d76cf20900fe3',
};

// v2.1.4 新回归基准（4 榜单 800 行，未采集；旧 726/192/771/1046 作废，DESIGN §19.4）
// libState 口径（Lead 拍板）：非 verified 且该行已有尺寸段+价格段 → pending（优先于 new/incomplete）
export const BASELINE_V214 = {
  sizeFilled: 734, // 91.75%
  priceFilled: 242, // 30.25%
  brandFilled: 772, // 96.5%
  amountWan: 10262.6,
  bySizeMin: 25,
  libStateVerified: 160,
  libStateIncomplete: 184,
  libStateNew: 378,
  libStatePending: 78,
};

// v2.1.6 新基准（xlsx-core 2026-11-04 18:4x 实测；旧 577/157/242/78 全部作废）：
// 尺寸段 478/800=59.75%（分榜单 134/143/67/134）、sizeAmbiguous 322（多值 248 + 无明确 74）、bySize 20；
// 价格段 165/800=20.625%（全部来自匹配库；原 242 中 77 条名称推断已删除）、待补采 635；品牌 772、金额 10262.6；
// libStates verified 160 / incomplete 192 / new 447 / pending 1；source：size 库 162 + 名称解析 316，price 库 165。
export const BASELINE_V216 = {
  sizeFilled: 478,
  sizePercent: 59.75,
  sizeAmbiguous: 322,
  sizeAmbiguousMulti: 248,
  sizeAmbiguousNoExpression: 74,
  bySize: 20,
  priceFilled: 165,
  pricePercent: 20.625,
  brandFilled: 772,
  amountWan: 10262.6,
  pendingCaptures: 635,
  libStateVerified: 160,
  libStateIncomplete: 192,
  libStateNew: 447,
  libStatePending: 1,
  statusCounts: { matched: 161, partial: 317, todo: 318, needCapture: 4, captured: 0, failed: 0, review: 0 },
  perReportSize: {
    '11月-会议平板.xlsx': 134,
    '11月-会议电视.xlsx': 143,
    '11月-教育教学一体机.xlsx': 67,
    'tangpingnature_商品榜单_热销排名_离线_汇总下载_2026-10-01_2026-10-31.xlsx': 134,
  },
  perReportPrice: {
    '11月-会议平板.xlsx': 0,
    '11月-会议电视.xlsx': 89,
    '11月-教育教学一体机.xlsx': 1,
    'tangpingnature_商品榜单_热销排名_离线_汇总下载_2026-10-01_2026-10-31.xlsx': 75,
  },
  perReportAmbiguous: {
    '11月-会议平板.xlsx': 66,
    '11月-会议电视.xlsx': 57,
    '11月-教育教学一体机.xlsx': 133,
    'tangpingnature_商品榜单_热销排名_离线_汇总下载_2026-10-01_2026-10-31.xlsx': 66,
  },
};

// 默认 Python（任务环境固定路径；可用 DSH_QA_PYTHON 环境变量覆盖）
export const PYTHON = process.env.DSH_QA_PYTHON
  || '~\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe';
export const NODE = process.execPath;

// v2.1.5 新基准（DESIGN §20.7 名称多尺寸细化后，xlsx-core 2026-11-04 实测）：
// 尺寸段 577/800=72.125%、sizeAmbiguous 157 行、bySize 22 档；价格/品牌/金额/libStates 不变
export const BASELINE_V215 = {
  sizeFilled: 577,
  sizePercent: 72.125,
  sizeAmbiguous: 157,
  bySize: 22,
  priceFilled: 242,
  brandFilled: 772,
  amountWan: 10262.6,
  perReportSize: { '11月-会议平板.xlsx': 165, '11月-会议电视.xlsx': 183, '11月-教育教学一体机.xlsx': 80, 'tangpingnature_商品榜单_热销排名_离线_汇总下载_2026-10-01_2026-10-31.xlsx': 149 },
  perReportAmbiguous: { '11月-会议平板.xlsx': 28, '11月-会议电视.xlsx': 15, '11月-教育教学一体机.xlsx': 86, 'tangpingnature_商品榜单_热销排名_离线_汇总下载_2026-10-01_2026-10-31.xlsx': 28 },
};

export class BlockedError extends Error {
  constructor(reason) { super(reason); this.name = 'BlockedError'; }
}

export function exists(rel) {
  return fs.existsSync(path.isAbsolute(rel) ? rel : path.join(ROOT, rel));
}

export function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.isAbsolute(rel) ? rel : path.join(ROOT, rel), 'utf8'));
}

export function ensureTmp() {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  return TMP_DIR;
}

/** 动态 import extension/lib/<name>.js；文件缺失时抛 BlockedError（不是失败）。 */
export async function loadLib(name) {
  const file = path.join(EXT_DIR, 'lib', name);
  if (!fs.existsSync(file)) throw new BlockedError(`extension/lib/${name} 尚未实现`);
  try {
    return await import(pathToFileURL(file).href + `?v=${Date.now()}`);
  } catch (err) {
    throw new Error(`import extension/lib/${name} 失败：${err.message}`);
  }
}

/** extension 下的模块存在性（用于门禁/阻塞判断）。 */
export function libMissing(...names) {
  return names.filter((n) => !fs.existsSync(path.join(EXT_DIR, 'lib', n)));
}

/**
 * 运行子进程，收集 stdout/stderr，超时杀进程树。
 * 注意：DSH 沙箱内 Node 用 pipe 捕获子进程输出会 EPERM（命名管道限制），
 * 因此统一把子进程 stdout/stderr 重定向到临时文件，结束后再读。
 */
export function runProcess(command, args, { cwd = ROOT, timeoutMs = 120000, env = {} } = {}) {
  const outFile = path.join(ensureTmp(), `proc-${Date.now()}-${Math.random().toString(16).slice(2)}.out.txt`);
  const errFile = outFile.replace(/\.out\.txt$/, '.err.txt');
  const outFd = fs.openSync(outFile, 'w');
  const errFd = fs.openSync(errFile, 'w');
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        windowsHide: true,
        env: { ...process.env, ...env },
        stdio: ['ignore', outFd, errFd],
      });
    } catch (err) {
      try { fs.closeSync(outFd); fs.closeSync(errFd); } catch { /* ignore */ }
      resolve({ code: -1, signal: null, stdout: '', stderr: `[qa] 启动失败：${err.message}` });
      return;
    }
    let done = false;
    const finish = (code, signal, extraErr = '') => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      let stdout = '';
      let stderr = '';
      try { fs.closeSync(outFd); } catch { /* ignore */ }
      try { fs.closeSync(errFd); } catch { /* ignore */ }
      try { stdout = fs.readFileSync(outFile, 'utf8'); } catch { /* ignore */ }
      try { stderr = fs.readFileSync(errFile, 'utf8'); } catch { /* ignore */ }
      try { fs.rmSync(outFile, { force: true }); fs.rmSync(errFile, { force: true }); } catch { /* ignore */ }
      resolve({ code, signal, stdout, stderr: stderr + extraErr });
    };
    const timer = setTimeout(() => {
      try {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      } catch { try { child.kill(); } catch { /* ignore */ } }
      finish(null, 'timeout', `\n[qa] 超时 ${timeoutMs}ms，已终止`);
    }, timeoutMs);
    child.on('error', (err) => finish(-1, null, `\n[qa] 启动失败：${err.message}`));
    child.on('close', (code, signal) => finish(code, signal));
  });
}

/** 运行 tests/qa/py/ 下的 Python 辅助脚本，返回 JSON（脚本需输出单个 JSON）。 */
export async function runPython(scriptName, args = [], opts = {}) {
  if (!fs.existsSync(PYTHON)) {
    throw new BlockedError(`找不到 Python：${PYTHON}（可用环境变量 DSH_QA_PYTHON 指定）`);
  }
  const script = path.join(QA_DIR, 'py', scriptName);
  const res = await runProcess(PYTHON, [script, ...args], { timeoutMs: 120000, ...opts });
  if (res.code !== 0) {
    throw new Error(`Python ${scriptName} 退出码 ${res.code}\nstdout: ${res.stdout.slice(-800)}\nstderr: ${res.stderr.slice(-800)}`);
  }
  try {
    return JSON.parse(res.stdout);
  } catch {
    throw new Error(`Python ${scriptName} 输出不是合法 JSON：${res.stdout.slice(0, 500)}`);
  }
}

