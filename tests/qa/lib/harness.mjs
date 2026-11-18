// tests/qa/lib/harness.mjs —— 验收用例组织与汇总输出
// 分类：PASS / FAIL / BLOCKED（依赖未就绪，不算失败）/ SKIP（按参数跳过）
import { AssertionError } from './assert.mjs';

const MARK = { pass: '✓', fail: '✗', blocked: '⏳', skip: '—' };

export class Suite {
  constructor(title) {
    this.title = title;
    this.sections = [];
    this.results = [];
    this.currentSection = null;
    this.startedAt = Date.now();
  }

  section(name, note = '') {
    this.currentSection = { name, note, results: [] };
    this.sections.push(this.currentSection);
    return this;
  }

  async test(name, fn) {
    if (!this.currentSection) this.section('未分组');
    const started = Date.now();
    try {
      const detail = await fn();
      const result = { section: this.currentSection.name, name, status: 'pass', ms: Date.now() - started, detail };
      this.currentSection.results.push(result);
      this.results.push(result);
      console.log(`  ${MARK.pass} ${name}${detail ? `  ${typeof detail === 'string' ? detail : ''}` : ''}`);
      return result;
    } catch (err) {
      const blocked = err?.name === 'BlockedError';
      const status = blocked ? 'blocked' : 'fail';
      const detail = blocked ? err.message : (err instanceof AssertionError ? err.message : `${err.message}\n${(err.stack || '').split('\n').slice(1, 4).join('\n')}`);
      const result = { section: this.currentSection.name, name, status, ms: Date.now() - started, detail };
      this.currentSection.results.push(result);
      this.results.push(result);
      console.log(`  ${MARK[status]} ${name}：${blocked ? '阻塞' : '失败'} — ${String(detail).split('\n')[0]}`);
      if (status === 'fail') console.log(`      ↳ ${String(detail).split('\n').slice(1).join('\n      ↳ ')}`);
      return result;
    }
  }

  blocked(name, reason) {
    return this.test(name, () => { throw Object.assign(new Error(reason), { name: 'BlockedError' }); });
  }

  skip(name, reason = '') {
    if (!this.currentSection) this.section('未分组');
    const result = { section: this.currentSection.name, name, status: 'skip', ms: 0, detail: reason };
    this.currentSection.results.push(result);
    this.results.push(result);
    console.log(`  ${MARK.skip} ${name}${reason ? `：${reason}` : ''}`);
    return result;
  }

  counts() {
    const c = { pass: 0, fail: 0, blocked: 0, skip: 0 };
    for (const r of this.results) c[r.status] = (c[r.status] || 0) + 1;
    return c;
  }

  printSummary() {
    const c = this.counts();
    const seconds = ((Date.now() - this.startedAt) / 1000).toFixed(1);
    console.log('\n' + '='.repeat(72));
    for (const section of this.sections) {
      const sc = { pass: 0, fail: 0, blocked: 0, skip: 0 };
      for (const r of section.results) sc[r.status] = (sc[r.status] || 0) + 1;
      if (!section.results.length) continue;
      const parts = [];
      if (sc.pass) parts.push(`通过 ${sc.pass}`);
      if (sc.fail) parts.push(`失败 ${sc.fail}`);
      if (sc.blocked) parts.push(`阻塞 ${sc.blocked}`);
      if (sc.skip) parts.push(`跳过 ${sc.skip}`);
      console.log(`  ${section.name.padEnd(28, ' ')} ${parts.join(' · ')}`);
    }
    console.log('-'.repeat(72));
    console.log(`  [MAIN] 验收汇总：${c.pass} 通过 / ${c.fail} 失败 / ${c.blocked} 阻塞 / ${c.skip} 跳过（${seconds}s）`);
    if (c.blocked) {
      console.log('\n  阻塞项（依赖模块未就绪，不计失败）：');
      for (const r of this.results.filter((x) => x.status === 'blocked')) {
        console.log(`    ⏳ [${r.section}] ${r.name} — ${r.detail}`);
      }
    }
    if (c.fail) {
      console.log('\n  失败项：');
      for (const r of this.results.filter((x) => x.status === 'fail')) {
        console.log(`    ✗ [${r.section}] ${r.name}`);
        console.log(`      ${String(r.detail).split('\n').join('\n      ')}`);
      }
    }
    if (c.fail === 0) console.log('\n  [MAIN] 结论：没有失败用例。' + (c.blocked ? '存在阻塞项，等模块就绪后重跑。' : '全部通过。'));
    return c;
  }

  toJSON() {
    return {
      title: this.title,
      startedAt: new Date(this.startedAt).toISOString(),
      finishedAt: new Date().toISOString(),
      counts: this.counts(),
      sections: this.sections.map((s) => ({
        name: s.name,
        results: s.results.map((r) => ({ name: r.name, status: r.status, ms: r.ms, detail: r.detail || '' })),
      })),
    };
  }
}
