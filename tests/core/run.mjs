/**
 * tests/core/run.mjs —— 数据核心单测入口
 * 用法（在 市占率/ 目录下）：node tests/core/run.mjs
 * 覆盖：xlsx 读写（含 openpyxl 复核）、规则引擎、表头自适应、匹配库模型、补数流水线/统计/导出。
 */
import { mkdirSync, rmSync } from 'node:fs';
import { TMP_DIR } from './paths.mjs';

// 每次运行前清空临时目录，保证产物干净
rmSync(TMP_DIR, { recursive: true, force: true });
mkdirSync(TMP_DIR, { recursive: true });

// 注册所有测试套件（静态 import 会在下方 runAll 之前执行）
import './test-rules.mjs';
import './test-xlsx.mjs';
import './test-header-map.mjs';
import './test-store-schema.mjs';
import './test-pipeline.mjs';

const { runAll } = await import('./harness.mjs');

console.log('电商平台市占率数据工作台 · 数据核心测试（tests/core）\n');
const started = Date.now();
const summary = await runAll();
const elapsed = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\n用时 ${elapsed}s`);
process.exit(summary.failed > 0 ? 1 : 0);
