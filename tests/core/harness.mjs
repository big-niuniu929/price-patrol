/**
 * tests/core/harness.mjs —— 极简测试框架（不依赖任何外部库）
 * 用法：suite('名称', () => { test('用例', () => {...}); }); 然后 runAll()。
 * 断言失败会抛错，runAll 汇总每个 suite 的通过数并输出失败详情。
 */

const state = {
  suites: [],
  metrics: {},
};

let currentSuite = null;

/** 声明一个测试套件（导入阶段调用） */
export function suite(name, register) {
  const item = { name, tests: [] };
  state.suites.push(item);
  currentSuite = item;
  try {
    register();
  } finally {
    currentSuite = null;
  }
}

/** 声明一个测试用例 */
export function test(name, fn) {
  if (!currentSuite) throw new Error('test() 必须在 suite() 内调用');
  currentSuite.tests.push({ name, fn });
}

/** 记录一个实测指标（如覆盖率），最后统一打印，方便回填给 lead 的数字 */
export function recordMetric(name, value) {
  state.metrics[name] = value;
}

/** 断言为真 */
export function assert(condition, message) {
  if (!condition) throw new Error(message || '断言失败');
}

/** 断言相等（对象按 JSON 比较） */
export function assertEqual(actual, expected, message) {
  const actualText = typeof actual === 'object' ? JSON.stringify(actual) : String(actual);
  const expectedText = typeof expected === 'object' ? JSON.stringify(expected) : String(expected);
  if (actualText !== expectedText) {
    throw new Error(`${message || '断言相等失败'}\n  实际: ${actualText}\n  期望: ${expectedText}`);
  }
}

/** 断言浮点接近 */
export function assertClose(actual, expected, tolerance, message) {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > tolerance) {
    throw new Error(`${message || '断言数值失败'}\n  实际: ${actual}\n  期望: ${expected} ±${tolerance}`);
  }
}

/** 断言不抛异常 */
export async function assertNoThrow(fn, message) {
  try {
    return await fn();
  } catch (error) {
    throw new Error(`${message || '期望不抛异常，但抛出了'}：${error && error.message ? error.message : error}`);
  }
}

/** 断言抛出异常且文案包含关键词 */
export async function assertThrows(fn, keyword, message) {
  try {
    await fn();
  } catch (error) {
    const text = error && error.message ? error.message : String(error);
    if (keyword && !text.includes(keyword)) {
      throw new Error(`${message || '异常文案不符'}\n  实际: ${text}\n  期望包含: ${keyword}`);
    }
    return;
  }
  throw new Error(message || '期望抛出异常，但没有抛出');
}

/** 跑完所有 suite，返回 {passed, failed, suites}；失败详情打在控制台 */
export async function runAll() {
  const summary = { passed: 0, failed: 0, suites: [] };
  const failures = [];
  for (const item of state.suites) {
    const suiteResult = { name: item.name, passed: 0, failed: 0 };
    for (const testCase of item.tests) {
      try {
        await testCase.fn();
        suiteResult.passed += 1;
        summary.passed += 1;
      } catch (error) {
        suiteResult.failed += 1;
        summary.failed += 1;
        failures.push({
          suite: item.name,
          test: testCase.name,
          message: error && error.message ? error.message : String(error),
          stack: error && error.stack ? String(error.stack).split('\n').slice(1, 4).join('\n') : '',
        });
      }
    }
    summary.suites.push(suiteResult);
    const icon = suiteResult.failed ? '✗' : '✓';
    console.log(`${icon} ${item.name}：通过 ${suiteResult.passed}，失败 ${suiteResult.failed}`);
  }

  const metricEntries = Object.entries(state.metrics);
  if (metricEntries.length) {
    console.log('\n实测指标：');
    for (const [key, value] of metricEntries) {
      console.log(`  · ${key}: ${typeof value === 'object' ? JSON.stringify(value, null, 0) : value}`);
    }
  }

  if (failures.length) {
    console.log('\n失败详情：');
    for (const failure of failures) {
      console.log(`  [${failure.suite}] ${failure.test}`);
      console.log(`    ${failure.message.replace(/\n/g, '\n    ')}`);
    }
  }

  console.log(
    `\n总计：通过 ${summary.passed}，失败 ${summary.failed}，套件 ${summary.suites.length} 个`,
  );
  return summary;
}

export { state as harnessState };
