// 电商平台市占率数据工作台 · CaptureRunner 单元测试（dev-tools 专用，不随扩展发布）
//
// 用 fake chromeApi 在 Node 里驱动采集驱动器，覆盖：
//   导航顺序 / 标签页复用与清理 / 结果回调与 capture 记录 /
//   迟到与不匹配消息忽略 / 早到消息缓存 / 超时 / 重试 /
//   暂停 / 继续 / 停止 / 连续失败自动暂停 / 安全验证自动暂停 /
//   skus 子集重采 / keepTab / 价格优先级 settings.price.prefer / 空任务 /
//   v2.1 多采样：smart+decideMore（触发/不触发/抛异常）、double 固定两次与超容差补采、
//                single 强制一次、chooseSamples 中位数/价差/一致性、账号变化自动暂停、
//                samples/spread/consistent/price/sampleCount 字段与旧行为回归。
//
// 运行：node dev-tools/test_capture_client.mjs
//   extension/ 下没有 package.json 标记 "type":"module"，所以这里会先尝试直接 import，
//   失败时用 data: URL 导入 capture-client.js（该模块自包含、无相对 import，可直接导入）。

import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CAPTURE_CLIENT = path.join(__dirname, '..', 'extension', 'lib', 'capture-client.js');

async function loadCaptureClient() {
  if (!fs.existsSync(CAPTURE_CLIENT)) throw new Error('找不到 capture-client.js：' + CAPTURE_CLIENT);
  try {
    return await import(pathToFileURL(CAPTURE_CLIENT).href);
  } catch (err) {
    // extension 目录没有 "type": "module" 的 package.json 时，.js 会被当成 CommonJS，
    // 这里退回 data: URL 导入（capture-client.js 自包含，没有相对 import，可以安全导入）。
    const source = fs.readFileSync(CAPTURE_CLIENT, 'utf8');
    const dataUrl = 'data:text/javascript;base64,' + Buffer.from(source, 'utf8').toString('base64');
    return await import(dataUrl);
  }
}

const mod = await loadCaptureClient();
const { CaptureRunner, buildCaptureRecord, pickPriceByPrefer, chooseSamples, itemUrl, RESULT_MESSAGE_TYPE } = mod;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(check, timeoutMs, intervalMs) {
  const deadline = Date.now() + (timeoutMs || 3000);
  const step = intervalMs || 10;
  while (Date.now() < deadline) {
    if (check()) return true;
    await sleep(step);
  }
  return false;
}

const FAST_SETTINGS = {
  capture: {
    delayMin: 0,
    delayMax: 0,
    retries: 0,
    timeoutMs: 400,
    retryDelayMs: 10,
    keepTab: false,
    // 测试里把「复核前的 700~1300ms 等待」压到最小，避免单测变慢
    sampleDelayMinMs: 10,
    sampleDelayMaxMs: 20
  },
  price: { prefer: ['hand', 'main', 'plus'] }
};

function settingsWith(overrides) {
  const capture = Object.assign({}, FAST_SETTINGS.capture, (overrides && overrides.capture) || {});
  const price = Object.assign({}, FAST_SETTINGS.price, (overrides && overrides.price) || {});
  return { capture: capture, price: price };
}

const skuFromUrl = (url) => {
  const m = String(url || '').match(/\/(\d+)\.html/);
  return m ? m[1] : '';
};

// ---------------- fake chromeApi ----------------
function createFakeChrome(options) {
  const opts = options || {};
  const calls = { created: [], updated: [], removed: [], reloaded: [] };
  const listeners = new Set();
  const createdTabs = [];
  let tabSeq = 0;

  const chromeApi = {
    tabs: {
      create(props) {
        tabSeq += 1;
        const id = (opts.firstTabId || 500) + tabSeq;
        createdTabs.push(id);
        calls.created.push(Object.assign({}, props, { id: id }));
        return Promise.resolve({ id: id });
      },
      update(tabId, props) {
        calls.updated.push(Object.assign({ tabId: tabId }, props));
        if (typeof opts.onNavigate === 'function') {
          try {
            opts.onNavigate(props && props.url, tabId, calls.updated.length);
          } catch (err) {
            // 测试回调异常不影响采集
          }
        }
        return Promise.resolve({ id: tabId });
      },
      reload(tabId) {
        calls.reloaded.push(tabId);
        if (typeof opts.onReload === 'function') {
          try {
            opts.onReload(tabId, calls.reloaded.length);
          } catch (err) {
            // 测试回调异常不影响采集
          }
        }
        return Promise.resolve();
      },
      remove(tabId) {
        calls.removed.push(tabId);
        return Promise.resolve();
      }
    },
    runtime: {
      onMessage: {
        addListener(fn) {
          listeners.add(fn);
        },
        removeListener(fn) {
          listeners.delete(fn);
        }
      }
    },
    __calls: calls,
    __emit(msg, sender) {
      const tabId = sender && sender.tab && sender.tab.id != null ? sender.tab.id : createdTabs[createdTabs.length - 1];
      for (const fn of Array.from(listeners)) fn(msg, sender || { tab: { id: tabId } });
    },
    __listenerCount() {
      return listeners.size;
    }
  };
  return chromeApi;
}

function makeResult(sku, overrides) {
  const o = overrides || {};
  return Object.assign(
    {
      type: RESULT_MESSAGE_TYPE,
      ok: true,
      sku: sku,
      url: itemUrl(sku),
      title: '测试商品 ' + sku,
      size: { inch: 75, text: '75英寸', source: 'title' },
      main: { price: 5999, kind: 'main' },
      hand: { price: 5499, kind: 'hand' },
      plus: null,
      pricePick: { price: 5499, kind: 'hand' },
      candidates: [],
      flags: { verify: false, offSale: false, plusText: false, priceFragment: false },
      account: { nickname: '测试账号', plusHint: true, source: 'dom' },
      brand: '海信',
      at: new Date().toISOString(),
      reason: ''
    },
    o
  );
}

function makeFailResult(sku, reason, flags) {
  return {
    type: RESULT_MESSAGE_TYPE,
    ok: false,
    sku: sku,
    url: itemUrl(sku),
    title: '',
    size: null,
    main: null,
    hand: null,
    plus: null,
    pricePick: null,
    candidates: [],
    flags: flags || { verify: false, offSale: false, plusText: false },
    account: { nickname: '测试账号' },
    at: new Date().toISOString(),
    reason: reason
  };
}

function makeRunner(chromeApi, callbacks, settings) {
  const events = { results: [], logs: [], progress: [] };
  const cb = callbacks || {};
  const runner = new CaptureRunner({
    chromeApi: chromeApi,
    settings: settings || FAST_SETTINGS,
    onProgress: (p) => {
      events.progress.push(p);
      if (cb.onProgress) cb.onProgress(p);
    },
    onResult: (p) => {
      events.results.push(p);
      if (cb.onResult) cb.onResult(p);
    },
    onLog: (line) => {
      events.logs.push(String(line));
      if (cb.onLog) cb.onLog(line);
    }
  });
  return { runner: runner, events: events };
}

// ---------------- 用例 ----------------

test('导航顺序 / 标签页复用 / 结果回调 / capture 记录', async () => {
  const chromeApi = createFakeChrome({
    onNavigate: (url) => {
      const sku = skuFromUrl(url);
      setTimeout(() => chromeApi.__emit(makeResult(sku)), 5);
    }
  });
  const { runner, events } = makeRunner(chromeApi);
  const tasks = [
    { sku: '100000000001' },
    { sku: '100000000002', name: '带 name 的任务' },
    { sku: '100000000003', url: 'https://item.shop.example.com/100000000003.html' }
  ];
  const summary = await runner.start(tasks);

  assert.deepEqual(
    chromeApi.__calls.updated.map((u) => u.url),
    [itemUrl('100000000001'), itemUrl('100000000002'), itemUrl('100000000003')],
    '按顺序导航三个 SKU'
  );
  assert.equal(chromeApi.__calls.created.length, 1, '只创建一个后台标签页（复用）');
  assert.equal(chromeApi.__calls.removed.length, 1, '结束后关闭采集标签页');
  assert.equal(events.results.length, 3, '每个任务回调一次 onResult');
  assert.equal(summary.done, 3);
  assert.equal(summary.ok, 3);
  assert.equal(summary.fail, 0);
  assert.equal(summary.stopped, false);
  assert.equal(summary.autoPaused, false);
  assert.equal(runner.running, false);

  const capture = events.results[0].capture;
  assert.equal(capture.sku, '100000000001');
  assert.equal(capture.prices.hand, 5499);
  assert.equal(capture.prices.main, 5999);
  assert.equal(capture.priceKind, 'hand', '默认偏好到手价');
  assert.equal(capture.sizeInch, 75);
  assert.equal(capture.sizeText, '75英寸');
  assert.equal(capture.sizeSource, 'title');
  assert.equal(capture.brand, '海信');
  assert.equal(capture.fail, null);
  assert.equal(chromeApi.__listenerCount(), 0, '结束时要移除 runtime.onMessage 监听');
  assert.ok(events.logs.some((l) => l.indexOf('采集结束') >= 0), '日志包含结束摘要');
  assert.ok(events.progress.some((p) => p.phase === 'start'));
  assert.ok(events.progress.some((p) => p.phase === 'done'));
});

test('忽略不匹配 SKU 的迟到消息', async () => {
  const chromeApi = createFakeChrome({
    onNavigate: (url) => {
      const sku = skuFromUrl(url);
      setTimeout(() => {
        chromeApi.__emit(makeResult('999999999999')); // 上一轮/其它页面的迟到消息
        setTimeout(() => chromeApi.__emit(makeResult(sku)), 30);
      }, 5);
    }
  });
  const { runner, events } = makeRunner(chromeApi);
  const summary = await runner.start([{ sku: '100000000001' }]);

  assert.equal(summary.ok, 1);
  assert.equal(events.results.length, 1);
  assert.ok(
    events.logs.some((l) => l.indexOf('忽略') >= 0 && l.indexOf('999999999999') >= 0),
    '日志里应记录被忽略的迟到消息：' + events.logs.join(' | ')
  );
});

test('早于等待窗口到达的结果不会丢（缓存后立即消费）', async () => {
  const chromeApi = createFakeChrome({
    onNavigate: (url) => {
      const sku = skuFromUrl(url);
      chromeApi.__emit(makeResult(sku)); // 同步发：早于 _waitForResult 建立等待
    }
  });
  const { runner } = makeRunner(chromeApi, null, settingsWith({ capture: { timeoutMs: 300 } }));
  const started = Date.now();
  const summary = await runner.start([{ sku: '100000000001' }]);
  assert.equal(summary.ok, 1, '早到消息应被缓存并消费，不能超时失败');
  assert.ok(Date.now() - started < 250, '应该很快完成，实际耗时 ' + (Date.now() - started) + 'ms');
});

test('超时后重试，第二次成功', async () => {
  let nav = 0;
  const chromeApi = createFakeChrome({
    onNavigate: (url) => {
      nav += 1;
      const sku = skuFromUrl(url);
      if (nav >= 2) setTimeout(() => chromeApi.__emit(makeResult(sku)), 5);
      // 第一次故意不应答 → 触发超时
    }
  });
  const { runner, events } = makeRunner(chromeApi, null, settingsWith({ capture: { retries: 1, timeoutMs: 80 } }));
  const summary = await runner.start([{ sku: '100000000001' }]);

  assert.equal(chromeApi.__calls.updated.length, 2, '超时后应重试一次');
  assert.equal(summary.ok, 1);
  assert.equal(summary.fail, 0);
  assert.equal(events.results[0].attempt, 2);
  assert.ok(events.logs.some((l) => l.indexOf('重试') >= 0), '日志包含重试提示');
  assert.ok(events.progress.some((p) => p.phase === 'retry'), '进度回调包含 retry 阶段');
});

test('超时次数用完记为采集失败（reason 含“超时”）', async () => {
  const chromeApi = createFakeChrome({ onNavigate: () => {} }); // 永不应答
  const { runner, events } = makeRunner(chromeApi, null, settingsWith({ capture: { retries: 1, timeoutMs: 60 } }));
  const summary = await runner.start([{ sku: '100000000001' }]);

  assert.equal(chromeApi.__calls.updated.length, 2, '重试 1 次 = 共 2 次导航');
  assert.equal(summary.ok, 0);
  assert.equal(summary.fail, 1);
  assert.equal(events.results.length, 1);
  assert.equal(events.results[0].ok, false);
  assert.ok(events.results[0].reason.indexOf('超时') >= 0, '失败原因应说明超时：' + events.results[0].reason);
  assert.ok(events.results[0].capture.fail, '失败时 capture.fail 非空');
  // 只失败 1 次，达不到连续 3 次，不应自动暂停
  assert.equal(summary.autoPaused, false);
  assert.equal(summary.stopped, false);
});

test('暂停后不再打开新页面，继续后跑完', async () => {
  const chromeApi = createFakeChrome({
    onNavigate: (url) => {
      const sku = skuFromUrl(url);
      setTimeout(() => chromeApi.__emit(makeResult(sku)), 5);
    }
  });
  let runnerRef = null;
  const { runner, events } = makeRunner(chromeApi, {
    onResult: () => {
      if (events.results.length === 1) runnerRef.pause(); // 第一条采完立刻暂停
    }
  });
  runnerRef = runner;

  const tasks = ['1', '2', '3', '4'].map((n) => ({ sku: '10000000000' + n }));
  const pending = runner.start(tasks);

  const paused = await waitUntil(() => runner.paused, 2000);
  assert.equal(paused, true, '应该进入暂停状态');
  await sleep(150);
  assert.equal(chromeApi.__calls.updated.length, 1, '暂停期间不应继续打开新页面');
  assert.equal(runner.state.paused, true);
  assert.equal(runner.state.done, 1);

  runner.resume();
  const summary = await pending;
  assert.equal(chromeApi.__calls.updated.length, 4);
  assert.equal(summary.done, 4);
  assert.equal(summary.ok, 4);
  assert.ok(events.progress.some((p) => p.phase === 'pause'));
  assert.ok(events.progress.some((p) => p.phase === 'resume'));
});

test('停止会中断等待、关闭标签页并 resolve', async () => {
  const chromeApi = createFakeChrome({ onNavigate: () => {} }); // 永不应答
  let runnerRef = null;
  const { runner } = makeRunner(chromeApi, {
    onProgress: (p) => {
      if (p.phase === 'waiting') setTimeout(() => runnerRef.stop(), 20);
    }
  });
  runnerRef = runner;

  const summary = await runner.start([{ sku: '100000000001' }, { sku: '100000000002' }]);
  assert.equal(summary.stopped, true, '停止后 summary.stopped = true');
  assert.equal(summary.done, 0, '被中断的这一条不算完成');
  assert.equal(chromeApi.__calls.updated.length, 1, '停止后不再导航');
  assert.equal(chromeApi.__calls.removed.length, 1, '停止后关闭采集标签页');
  assert.equal(runner.running, false);
});

test('连续 3 个失败自动暂停，人工继续后跑完', async () => {
  let navCount = 0;
  const chromeApi = createFakeChrome({
    onNavigate: (url) => {
      navCount += 1;
      const sku = skuFromUrl(url);
      const n = navCount;
      setTimeout(() => {
        if (n <= 3) chromeApi.__emit(makeFailResult(sku, '模拟采集失败 #' + n));
        else chromeApi.__emit(makeResult(sku));
      }, 5);
    }
  });
  const { runner, events } = makeRunner(chromeApi, null, settingsWith({ capture: { autoPauseFails: 3 } }));
  const tasks = ['1', '2', '3', '4', '5'].map((n) => ({ sku: '10000000000' + n }));
  const pending = runner.start(tasks);

  const paused = await waitUntil(() => runner.paused && runner.state.autoPaused, 3000);
  assert.equal(paused, true, '连续 3 个失败后应自动暂停');
  assert.ok(runner.state.autoPauseReason.indexOf('连续') >= 0, '自动暂停原因：' + runner.state.autoPauseReason);
  assert.equal(chromeApi.__calls.updated.length, 3, '暂停时只跑了 3 个');
  assert.ok(events.progress.some((p) => p.phase === 'auto-pause'));

  runner.resume();
  const summary = await pending;
  assert.equal(summary.done, 5);
  assert.equal(summary.fail, 3);
  assert.equal(summary.ok, 2);
  assert.equal(summary.autoPaused, true);
});

test('识别到安全验证时自动暂停且不重试', async () => {
  const chromeApi = createFakeChrome({
    onNavigate: (url) => {
      const sku = skuFromUrl(url);
      setTimeout(
        () =>
          chromeApi.__emit(
            makeFailResult(sku, '页面要求安全验证（可能触发风控），建议暂停采集并人工确认', {
              verify: true,
              offSale: false,
              plusText: false
            })
          ),
        5
      );
    }
  });
  const { runner } = makeRunner(chromeApi, null, settingsWith({ capture: { retries: 2, timeoutMs: 300 } }));
  const pending = runner.start([{ sku: '100000000001' }, { sku: '100000000002' }]);

  const paused = await waitUntil(() => runner.paused && runner.state.autoPaused, 3000);
  assert.equal(paused, true, '安全验证应自动暂停');
  assert.ok(runner.state.autoPauseReason.indexOf('安全验证') >= 0, '暂停原因含安全验证');
  assert.equal(chromeApi.__calls.updated.length, 1, '风控页不应重试');

  runner.stop();
  const summary = await pending;
  assert.equal(summary.stopped, true);
  assert.equal(summary.autoPaused, true, 'summary 里保留自动暂停标记，UI 可以提示原因');
});

test('opts.skus 只采子集', async () => {
  const chromeApi = createFakeChrome({
    onNavigate: (url) => {
      const sku = skuFromUrl(url);
      setTimeout(() => chromeApi.__emit(makeResult(sku)), 5);
    }
  });
  const { runner } = makeRunner(chromeApi);
  const tasks = [{ sku: '100000000001' }, { sku: '100000000002' }, { sku: '100000000003' }];
  const summary = await runner.start(tasks, { skus: ['100000000002'] });

  assert.deepEqual(chromeApi.__calls.updated.map((u) => skuFromUrl(u.url)), ['100000000002']);
  assert.equal(summary.total, 1);
  assert.equal(summary.ok, 1);
});

test('settings.capture.keepTab=true 时保留采集标签页', async () => {
  const chromeApi = createFakeChrome({
    onNavigate: (url) => {
      const sku = skuFromUrl(url);
      setTimeout(() => chromeApi.__emit(makeResult(sku)), 5);
    }
  });
  const { runner } = makeRunner(chromeApi, null, settingsWith({ capture: { keepTab: true } }));
  await runner.start([{ sku: '100000000001' }]);
  assert.equal(chromeApi.__calls.removed.length, 0, 'keepTab 时不应该关闭标签页');
});

test('settings.price.prefer 影响 priceKind 选择', async () => {
  const chromeApi = createFakeChrome({
    onNavigate: (url) => {
      const sku = skuFromUrl(url);
      setTimeout(
        () =>
          chromeApi.__emit(
            makeResult(sku, {
              hand: { price: 5499, kind: 'hand' },
              main: { price: 5999, kind: 'main' },
              plus: { price: 11899, kind: 'plus' }
            })
          ),
        5
      );
    }
  });
  const { runner, events } = makeRunner(chromeApi, null, settingsWith({ price: { prefer: ['plus', 'main', 'hand'] } }));
  const summary = await runner.start([{ sku: '100000000001' }]);
  assert.equal(summary.ok, 1);
  assert.equal(events.results[0].pricePick.kind, 'plus');
  assert.equal(events.results[0].capture.priceKind, 'plus');
  assert.equal(events.results[0].capture.prices.plus, 11899);
});

test('页面报 ok 但没有可用价格时仍记为失败', async () => {
  const chromeApi = createFakeChrome({
    onNavigate: (url) => {
      const sku = skuFromUrl(url);
      setTimeout(() => chromeApi.__emit(makeResult(sku, { main: null, hand: null, plus: null, pricePick: null })), 5);
    }
  });
  const { runner, events } = makeRunner(chromeApi);
  const summary = await runner.start([{ sku: '100000000001' }]);
  assert.equal(summary.ok, 0);
  assert.equal(summary.fail, 1);
  assert.equal(events.results[0].ok, false);
  assert.ok(events.results[0].capture.fail, 'capture.fail 非空');
  assert.ok(events.results[0].reason.length > 0, '失败要给中文原因');
});

test('空任务直接结束、不创建标签页', async () => {
  const chromeApi = createFakeChrome({});
  const { runner } = makeRunner(chromeApi);
  const summary = await runner.start([]);
  assert.equal(summary.total, 0);
  assert.equal(summary.done, 0);
  assert.equal(chromeApi.__calls.created.length, 0);
  assert.equal(chromeApi.__calls.updated.length, 0);
});

test('已在运行时再次 start 会 reject（中文原因）', async () => {
  const chromeApi = createFakeChrome({ onNavigate: () => {} });
  const { runner } = makeRunner(chromeApi, null, settingsWith({ capture: { timeoutMs: 5000 } }));
  const pending = runner.start([{ sku: '100000000001' }]);
  await waitUntil(() => runner.running, 1000);

  await assert.rejects(() => runner.start([{ sku: '100000000002' }]), /已有采集任务在进行中/);
  runner.stop();
  await pending;
});

test('buildCaptureRecord / pickPriceByPrefer / itemUrl 契约', () => {
  assert.equal(itemUrl('100200174986'), 'https://item.shop.example.com/100200174986.html');
  const result = makeResult('100200174986', { size: { inch: 86, text: '86英寸', source: 'spec' } });
  const capture = buildCaptureRecord(result, { task: { sku: '100200174986' } });
  assert.equal(capture.sku, '100200174986');
  assert.equal(capture.sizeInch, 86);
  assert.equal(capture.sizeText, '86英寸');
  assert.equal(capture.sizeSource, 'spec');
  assert.equal(capture.priceKind, 'hand');
  assert.deepEqual(capture.prices, { hand: 5499, main: 5999, plus: null });
  assert.equal(capture.fail, null);
  assert.equal(capture.account, '测试账号');

  const picked = pickPriceByPrefer(result, ['main', 'hand']);
  assert.equal(picked.price, 5999);
  assert.equal(picked.kind, 'main');

  const failed = buildCaptureRecord(makeFailResult('100200174986', '页面已下架'), { task: {} });
  assert.equal(failed.fail && failed.fail.reason, '页面已下架');
  assert.equal(failed.priceKind, '');
  // v2.1 单采样兼容字段：没有 samples 入参时也输出 samples/单次、spread 0、consistent true
  assert.equal(capture.sampleCount, 1);
  assert.equal(capture.spread, 0);
  assert.equal(capture.consistent, true);
  assert.equal(capture.samples.length, 1);
  assert.equal(capture.price, 5499);
});

// ==================== v2.1 多采样复核 ====================

function makeSampleResult(sku, price, extra) {
  return makeResult(
    sku,
    Object.assign(
      {
        hand: { price: price, kind: 'hand' },
        main: null,
        plus: null,
        pricePick: { price: price, kind: 'hand' }
      },
      extra || {}
    )
  );
}

test('chooseSamples：中位数 / 价差 / 一致性与容差', () => {
  const single = chooseSamples([{ price: 5499, kind: 'hand' }]);
  assert.equal(single.method, 'single');
  assert.equal(single.price, 5499);
  assert.equal(single.spread, 0);
  assert.equal(single.consistent, true);
  assert.equal(single.tolerance, Math.max(30, 54.99));

  const same = chooseSamples([
    { price: 5999, kind: 'main' },
    { price: 5999, kind: 'main' }
  ]);
  assert.equal(same.method, 'same');
  assert.equal(same.price, 5999);
  assert.equal(same.consistent, true);

  // 偶数个样本取中间均值
  const even = chooseSamples([
    { price: 5999, kind: 'main' },
    { price: 6001, kind: 'main' }
  ]);
  assert.equal(even.method, 'median');
  assert.equal(even.price, 6000);
  assert.equal(even.spread, 2);
  assert.equal(even.consistent, true);

  // 价差超容差：仍取中位数，但 consistent=false（不向任何期望值靠拢）
  const inconsistent = chooseSamples([
    { price: 5000, kind: 'hand' },
    { price: 6000, kind: 'hand' }
  ]);
  assert.equal(inconsistent.price, 5500);
  assert.equal(inconsistent.spread, 1000);
  assert.equal(inconsistent.consistent, false);
  assert.equal(inconsistent.spreadPct, 0.2);

  // toleranceAbs 覆盖：价差 200、容差 300 → 一致
  const wide = chooseSamples([{ price: 1000 }, { price: 1200 }], { toleranceAbs: 300, tolerancePct: 0 });
  assert.equal(wide.consistent, true);
  assert.equal(wide.tolerance, 300);

  const empty = chooseSamples([]);
  assert.equal(empty.price, null);
  assert.equal(empty.method, 'none');
  assert.equal(empty.sampleCount, 0);
});

test('多采样 smart：decideMore 返回 more 时用 tabs.reload 复核', async () => {
  const chromeApi = createFakeChrome({
    onNavigate: (url) => {
      const sku = skuFromUrl(url);
      setTimeout(() => chromeApi.__emit(makeSampleResult(sku, 5499)), 5);
    },
    onReload: () => {
      setTimeout(() => chromeApi.__emit(makeSampleResult('100000000001', 5500)), 5);
    }
  });
  const decideCalls = [];
  const { runner, events } = makeRunner(chromeApi, null, settingsWith({ capture: { mode: 'smart', maxSamples: 3 } }));
  const summary = await runner.start([{ sku: '100000000001' }], {
    decideMore: (ctx) => {
      decideCalls.push(ctx);
      return ctx.sampleIndex < 2
        ? { more: true, reason: '候选不足（WEAK_EVIDENCE）' }
        : { more: false, reason: '已一致' };
    }
  });

  assert.equal(decideCalls.length, 2, '每次采样后都要问一次，共 2 次');
  assert.equal(decideCalls[0].samples.length, 1);
  assert.equal(decideCalls[0].price, 5499);
  assert.equal(decideCalls[0].sampleIndex, 1);
  assert.equal(decideCalls[0].mode, 'smart');
  assert.equal(decideCalls[0].maxSamples, 3);
  assert.equal(decideCalls[0].task.sku, '100000000001');
  assert.equal(decideCalls[1].samples.length, 2);
  assert.equal(chromeApi.__calls.updated.length, 1, '首次采样用导航');
  assert.equal(chromeApi.__calls.reloaded.length, 1, '复核用 tabs.reload');

  assert.equal(summary.sampleCount, 2);
  assert.equal(summary.resampled, 1);
  assert.equal(summary.inconsistent, 0, '5499 与 5500 价差 1，在容差内');
  assert.equal(summary.mode, 'smart');
  assert.equal(summary.maxSamples, 3);

  const payload = events.results[0];
  assert.equal(payload.sampleCount, 2);
  assert.equal(payload.spread, 1);
  assert.equal(payload.consistent, true);
  assert.equal(payload.price, 5499.5);
  assert.equal(payload.capture.sampleCount, 2);
  assert.equal(payload.capture.samples.length, 2);
  assert.equal(payload.capture.spread, 1);
  assert.equal(payload.capture.consistent, true);
  assert.equal(payload.capture.price, 5499.5);
  assert.equal(payload.capture.prices.hand, 5499.5, '中位数写回对应口径');
  assert.ok(events.logs.some((l) => l.indexOf('复核第 2 次') >= 0), '日志包含「复核第 2 次」');
  assert.ok(events.logs.some((l) => l.indexOf('次采样价差') >= 0), '日志包含采样价差');
  assert.ok(events.progress.some((p) => p.phase === 'sample'), '进度回调包含 sample 阶段');
});

test('多采样 smart：decideMore 返回 false 时不复核（默认单次）', async () => {
  const chromeApi = createFakeChrome({
    onNavigate: (url) => {
      const sku = skuFromUrl(url);
      setTimeout(() => chromeApi.__emit(makeSampleResult(sku, 5499)), 5);
    },
    onReload: () => {
      throw new Error('不应该复核');
    }
  });
  const { runner, events } = makeRunner(chromeApi, null, settingsWith({ capture: { mode: 'smart', maxSamples: 3 } }));
  const summary = await runner.start([{ sku: '100000000001' }], { decideMore: () => false });

  assert.equal(chromeApi.__calls.reloaded.length, 0);
  assert.equal(summary.sampleCount, 1);
  assert.equal(summary.resampled, 0);
  assert.equal(events.results[0].capture.samples.length, 1);
  assert.equal(events.results[0].capture.spread, 0);
  assert.equal(events.results[0].capture.consistent, true);
});

test('多采样：决定回调抛异常时记为不再复核，不影响采集', async () => {
  const chromeApi = createFakeChrome({
    onNavigate: (url) => {
      const sku = skuFromUrl(url);
      setTimeout(() => chromeApi.__emit(makeSampleResult(sku, 5499)), 5);
    }
  });
  const { runner, events } = makeRunner(chromeApi, null, settingsWith({ capture: { mode: 'smart', maxSamples: 3 } }));
  const summary = await runner.start([{ sku: '100000000001' }], {
    decideMore: () => {
      throw new Error('规则异常');
    }
  });
  assert.equal(summary.sampleCount, 1);
  assert.equal(summary.ok, 1);
  assert.ok(events.logs.some((l) => l.indexOf('复核判断回调异常') >= 0), '日志提示回调异常');
});

test('多采样 double：固定采 2 次，价差一致就停止', async () => {
  let reloadNo = 0;
  const chromeApi = createFakeChrome({
    onNavigate: (url) => {
      const sku = skuFromUrl(url);
      setTimeout(() => chromeApi.__emit(makeSampleResult(sku, 5999)), 5);
    },
    onReload: () => {
      reloadNo += 1;
      setTimeout(() => chromeApi.__emit(makeSampleResult('100000000001', 6000)), 5);
    }
  });
  const { runner, events } = makeRunner(chromeApi, null, settingsWith({ capture: { mode: 'double', maxSamples: 3 } }));
  const summary = await runner.start([{ sku: '100000000001' }]);

  assert.equal(reloadNo, 1, '双次模式固定复核 1 次');
  assert.equal(chromeApi.__calls.updated.length, 1);
  assert.equal(summary.sampleCount, 2);
  assert.equal(summary.resampled, 1);
  assert.equal(summary.inconsistent, 0);
  assert.equal(events.results[0].capture.price, 5999.5);
  assert.equal(events.results[0].capture.spread, 1);
  assert.equal(events.results[0].capture.consistent, true);
});

test('多采样 double：价差超容差补采到 maxSamples，标需确认', async () => {
  let reloadNo = 0;
  const prices = [7000, 7000];
  const chromeApi = createFakeChrome({
    onNavigate: (url) => {
      const sku = skuFromUrl(url);
      setTimeout(() => chromeApi.__emit(makeSampleResult(sku, 5999)), 5);
    },
    onReload: () => {
      const price = prices[reloadNo] != null ? prices[reloadNo] : 7000;
      reloadNo += 1;
      setTimeout(() => chromeApi.__emit(makeSampleResult('100000000001', price)), 5);
    }
  });
  const { runner, events } = makeRunner(chromeApi, null, settingsWith({ capture: { mode: 'double', maxSamples: 3 } }));
  const summary = await runner.start([{ sku: '100000000001' }]);

  assert.equal(chromeApi.__calls.reloaded.length, 2, '第 2 次价差超容差后补采到 maxSamples=3');
  assert.equal(summary.sampleCount, 3);
  assert.equal(summary.inconsistent, 1);
  const capture = events.results[0].capture;
  assert.equal(capture.sampleCount, 3);
  assert.equal(capture.spread, 1001);
  assert.equal(capture.consistent, false);
  assert.equal(capture.price, 7000, '不一致也取中位数，不向期望值靠拢');
});

test('多采样 single：即使 decideMore 返回 true 也只采 1 次', async () => {
  const chromeApi = createFakeChrome({
    onNavigate: (url) => {
      const sku = skuFromUrl(url);
      setTimeout(() => chromeApi.__emit(makeSampleResult(sku, 5499)), 5);
    },
    onReload: () => {
      throw new Error('single 模式不应该复核');
    }
  });
  const decideCalls = [];
  const { runner } = makeRunner(chromeApi, null, settingsWith({ capture: { mode: 'single', maxSamples: 3 } }));
  const summary = await runner.start([{ sku: '100000000001' }], {
    decideMore: (ctx) => {
      decideCalls.push(ctx);
      return { more: true };
    }
  });
  assert.equal(decideCalls.length, 0, 'single 模式不问 decideMore');
  assert.equal(chromeApi.__calls.reloaded.length, 0);
  assert.equal(summary.sampleCount, 1);
  assert.equal(summary.mode, 'single');
});

test('多采样：账号变化自动暂停，resume 后继续且基准切到新账号', async () => {
  let account = '账号A';
  let reloadCount = 0;
  const chromeApi = createFakeChrome({
    onNavigate: (url) => {
      const sku = skuFromUrl(url);
      const nick = account;
      setTimeout(() => chromeApi.__emit(makeSampleResult(sku, 5499, { account: { nickname: nick, plusHint: false, source: 'dom' } })), 5);
    },
    onReload: () => {
      reloadCount += 1;
      account = '账号B';
      setTimeout(() => chromeApi.__emit(makeSampleResult('100000000001', 5499, { account: { nickname: '账号B', plusHint: false, source: 'dom' } })), 5);
    }
  });
  const { runner, events } = makeRunner(chromeApi, null, settingsWith({ capture: { mode: 'double', maxSamples: 3 } }));
  const pending = runner.start([{ sku: '100000000001' }, { sku: '100000000002' }]);

  const paused = await waitUntil(() => runner.paused && runner.state.autoPaused, 3000);
  assert.equal(paused, true, '账号变化应自动暂停');
  assert.ok(runner.state.autoPauseReason.indexOf('账号') >= 0, '暂停原因：' + runner.state.autoPauseReason);
  assert.equal(chromeApi.__calls.updated.length, 1, '暂停时不再打开第二个 SKU');
  assert.ok(
    events.logs.some((l) => l.indexOf('账号发生变化') >= 0 || l.indexOf('账号变化') >= 0),
    '日志提示账号变化'
  );

  runner.resume();
  const summary = await pending;
  assert.equal(summary.done, 2);
  assert.equal(summary.autoPaused, true, 'summary 保留「发生过自动暂停」');
  assert.equal(summary.ok, 2);
  assert.ok(reloadCount >= 2, '两个 SKU 都做了复核');
  const detail = events.results[1];
  assert.equal(detail.capture.account, '账号B', '第二个 SKU 用的是新账号，未重复触发暂停');
});

test('多采样：pauseOnAccountChange=false 时账号变化不暂停', async () => {
  let account = '账号A';
  const chromeApi = createFakeChrome({
    onNavigate: (url) => {
      const sku = skuFromUrl(url);
      setTimeout(() => chromeApi.__emit(makeSampleResult(sku, 5499, { account: { nickname: account, plusHint: false, source: 'dom' } })), 5);
    },
    onReload: () => {
      account = '账号B';
      setTimeout(() => chromeApi.__emit(makeSampleResult('100000000001', 5499, { account: { nickname: '账号B', plusHint: false, source: 'dom' } })), 5);
    }
  });
  const { runner } = makeRunner(
    chromeApi,
    null,
    settingsWith({ capture: { mode: 'double', maxSamples: 3, pauseOnAccountChange: false } })
  );
  const summary = await runner.start([{ sku: '100000000001' }]);
  assert.equal(summary.done, 1);
  assert.equal(summary.autoPaused, false);
  assert.equal(summary.sampleCount, 2);
});

test('多采样：复核失败时保留首次样本，不整体失败', async () => {
  let reloadNo = 0;
  const chromeApi = createFakeChrome({
    onNavigate: (url) => {
      const sku = skuFromUrl(url);
      setTimeout(() => chromeApi.__emit(makeSampleResult(sku, 5499)), 5);
    },
    onReload: () => {
      reloadNo += 1;
      setTimeout(() => chromeApi.__emit(makeFailResult('100000000001', '等待页面价格超时（模拟复核失败）')), 5);
    }
  });
  const { runner, events } = makeRunner(
    chromeApi,
    null,
    settingsWith({ capture: { mode: 'double', maxSamples: 3, timeoutMs: 400 } })
  );
  const summary = await runner.start([{ sku: '100000000001' }]);

  assert.equal(reloadNo, 1);
  assert.equal(summary.ok, 1, '有 1 次成功样本 → 任务仍算成功');
  assert.equal(summary.fail, 0);
  assert.equal(summary.sampleCount, 1);
  const capture = events.results[0].capture;
  assert.equal(capture.sampleCount, 1);
  assert.equal(capture.samples.length, 1);
  assert.equal(capture.price, 5499);
  assert.equal(capture.fail, null);
  assert.ok(events.logs.some((l) => l.indexOf('复核第 2 次失败') >= 0), '日志记录复核失败');
  assert.ok(events.logs.some((l) => l.indexOf('保留已有采样结果') >= 0), '日志说明保留首次样本');
});

test('buildCaptureRecord：多采样字段与型号/套餐/规格选择区透传', () => {
  const result = makeResult('100200174986', {
    model: 'MC75HEE',
    modelSource: 'spec',
    package: '会议大屏+摄像头【免费送装一体】',
    packageSource: '规格选项',
    packageGroup: '版本',
    specGroups: [
      { label: '系列品', selected: '【行业TOP1】会议电视新标杆XP3E', options: ['【行业TOP1】会议电视新标杆XP3E'], source: 'single' },
      { label: '屏幕尺寸', selected: '100英寸 【会议新物种 无线C位屏】', options: ['100英寸 【会议新物种 无线C位屏】'], source: 'class' },
      { label: '版本', selected: '会议大屏+摄像头【免费送装一体】', options: ['会议大屏+摄像头【免费送装一体】', '会议大屏+摄像头+推车【免费送装一体】'], source: 'class' }
    ],
    candidateCount: 3
  });
  const capture = buildCaptureRecord(result, {
    task: { sku: '100200174986' },
    samples: [
      { price: 5499, kind: 'hand', at: '2026-11-03T01:00:00Z' },
      { price: 5529, kind: 'hand', at: '2026-11-03T01:00:10Z' }
    ]
  });
  assert.equal(capture.sku, '100200174986');
  assert.equal(capture.model, 'MC75HEE');
  assert.equal(capture.modelSource, 'spec');
  assert.equal(capture.package, '会议大屏+摄像头【免费送装一体】');
  assert.equal(capture.packageSource, '规格选项');
  assert.equal(capture.packageGroup, '版本');
  assert.equal(capture.specGroups.length, 3);
  assert.equal(capture.specGroups[2].label, '版本');
  assert.equal(capture.candidateCount, 3);
  assert.equal(capture.sampleCount, 2);
  assert.equal(capture.samples.length, 2);
  assert.equal(capture.spread, 30);
  assert.equal(capture.consistent, true);
  assert.equal(capture.price, 5514);
  assert.equal(capture.priceKind, 'hand');
  assert.equal(capture.prices.hand, 5514);

  const inconsistent = buildCaptureRecord(result, {
    task: { sku: '100200174986' },
    samples: [
      { price: 5499, kind: 'hand' },
      { price: 5800, kind: 'hand' }
    ]
  });
  assert.equal(inconsistent.consistent, false);
  assert.equal(inconsistent.spread, 301);
  assert.equal(inconsistent.price, 5649.5);

  const failedMulti = buildCaptureRecord(makeFailResult('100200174986', '页面已下架'), {
    task: {},
    samples: []
  });
  assert.equal(failedMulti.sampleCount, 0);
  assert.equal(failedMulti.price, null);
  assert.equal(failedMulti.consistent, true);
  assert.ok(failedMulti.fail);
});

// ---------------- v2.1.4 频控保护（risk / cooldown / maxBatch / 降频参数）----------------

function makeRiskResult(sku, overrides) {
  const risk = Object.assign(
    {
      hit: true,
      reason: 'verify',
      detail: '页面提示安全验证/访问频繁',
      url: 'https://verify.shop.example.com/',
      title: '安全验证'
    },
    overrides || {}
  );
  const base = makeFailResult(sku, '页面要求安全验证（可能触发风控），已暂停采集并跳过价格解析');
  base.pageKind = 'risk';
  base.risk = risk;
  base.previewable = false;
  return base;
}

// v2.1.5：下架结果（不是风控）
function makeOffSaleResult(sku) {
  const base = makeFailResult(sku, '已下架（页面提示商品下架/不存在/已售罄）');
  base.pageKind = 'offSale';
  base.offSale = true;
  base.softAnomaly = false;
  base.anomaly = { reason: '已下架', detail: '页面提示商品已下架', url: itemUrl(sku), title: '' };
  base.risk = { hit: false, reason: '', url: itemUrl(sku), title: '', detail: '' };
  base.flags = { verify: false, offSale: true, plusText: false };
  base.previewable = false;
  return base;
}

// v2.1.5：软异常（跳首页/空页，不是风控）
function makeSoftAnomalyResult(sku, reason) {
  const base = makeFailResult(sku, '页面被跳转到电商平台首页/频道页（非风控），等待后自动继续采集');
  base.pageKind = 'softAnomaly';
  base.offSale = false;
  base.softAnomaly = true;
  base.anomaly = {
    reason: reason || 'home',
    detail: '页面被跳转到电商平台首页/频道页',
    url: 'https://www.shop.example.com/',
    title: '电商平台(shop.example.com)'
  };
  base.risk = { hit: false, reason: '', url: 'https://www.shop.example.com/', title: '', detail: '' };
  base.previewable = false;
  return base;
}

test('v2.1.4 风控落地页：自动暂停 + 记录 risk/cooldownUntil + risk/cooldown 事件', async () => {
  const chromeApi = createFakeChrome({
    onNavigate: (url) => {
      const sku = skuFromUrl(url);
      setTimeout(() => chromeApi.__emit(makeRiskResult(sku)), 5);
    }
  });
  const { runner, events } = makeRunner(
    chromeApi,
    null,
    settingsWith({ capture: { retries: 2, timeoutMs: 300, cooldownMinutes: 30 } })
  );
  const startedAt = Date.now();
  const pending = runner.start([{ sku: '100000000001' }, { sku: '100000000002' }]);

  const paused = await waitUntil(() => runner.paused && runner.state.autoPaused, 3000);
  assert.equal(paused, true, '命中期风控落地页应自动暂停');
  assert.equal(runner.state.risk && runner.state.risk.reason, 'verify');
  assert.ok(runner.state.risk.url.indexOf('verify.shop.example.com') >= 0, 'risk.url 记录落地页');
  const cooldownUntil = runner.cooldownUntil;
  assert.ok(cooldownUntil > startedAt + 29 * 60000, '冷却约 30 分钟后（实际 ' + (cooldownUntil - startedAt) + 'ms）');
  assert.ok(cooldownUntil <= startedAt + 31 * 60000);
  assert.equal(chromeApi.__calls.updated.length, 1, '风控页不重试、不继续打开下一条');
  assert.ok(events.logs.some((l) => l.includes('触发电商平台风控')), '日志含「触发电商平台风控」');
  assert.ok(events.logs.some((l) => l.includes('冷却')), '日志含「冷却」');
  assert.ok(events.progress.some((p) => p.phase === 'risk'), '进度事件含 risk');
  assert.ok(events.progress.some((p) => p.phase === 'cooldown'), '进度事件含 cooldown');
  const lastProgress = events.progress[events.progress.length - 1];
  assert.equal(lastProgress.cooldownUntil, cooldownUntil, '进度事件带 cooldownUntil');
  assert.equal(lastProgress.risk && lastProgress.risk.reason, 'verify');
  assert.equal(runner.resume(), false, '风控冷却期内 resume 被拒绝（避免连续请求加剧风控）');
  assert.equal(runner.paused, true, 'resume 被拒绝后仍处于暂停态');

  runner.stop();
  const summary = await pending;
  assert.equal(summary.risk && summary.risk.reason, 'verify');
  assert.equal(summary.cooldownUntil, cooldownUntil);
  assert.equal(summary.autoPaused, true);

  // 冷却期内再次 start：blocked，不创建标签页/不导航
  const blocked = await runner.start([{ sku: '100000000003' }]);
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.cooldownUntil, cooldownUntil);
  assert.equal(blocked.queued, 0);
  assert.equal(blocked.truncated, 0);
  assert.equal(blocked.limit, 20);
  assert.equal(blocked.risk && blocked.risk.reason, 'verify');
  assert.equal(chromeApi.__calls.updated.length, 1, '冷却中 start 不发起任何导航');
});

test('v2.1.4 canStart/构造参数：冷却可跨 runner 持久化，过期后放行', async () => {
  const chromeApi = createFakeChrome();
  const future = Date.now() + 10 * 60000;
  const runner = new CaptureRunner({
    chromeApi: chromeApi,
    settings: settingsWith({ capture: { cooldownMinutes: 5 } }),
    cooldownUntil: future
  });
  assert.equal(runner.cooldownUntil, future);
  const gate = runner.canStart();
  assert.equal(gate.ok, false);
  assert.equal(gate.blocked, true);
  assert.equal(gate.cooldownUntil, future);
  assert.ok(gate.remainingMs > 0);
  const blocked = await runner.start([{ sku: '100000000001' }]);
  assert.equal(blocked.blocked, true);
  assert.equal(chromeApi.__calls.updated.length, 0, '冷却中不发起导航');
  assert.equal(chromeApi.__calls.created.length, 0, '冷却中不创建标签页');

  const expired = new CaptureRunner({
    chromeApi: chromeApi,
    settings: settingsWith({ capture: { cooldownMinutes: 5 } }),
    cooldownUntil: Date.now() - 1000
  });
  assert.equal(expired.canStart().ok, true);
  const empty = await expired.start([]);
  assert.equal(empty.blocked, false);
  assert.equal(empty.cooldownUntil, 0, '冷却过期后开始新一轮，cooldownUntil 清 0');
});

test('v2.1.5 maxBatch：按传入 settings 截断（默认20，范围5~100，不写死）', async () => {
  const chromeApi = createFakeChrome({
    onNavigate: (url) => {
      const sku = skuFromUrl(url);
      setTimeout(() => chromeApi.__emit(makeResult(sku)), 2);
    }
  });
  const { runner } = makeRunner(
    chromeApi,
    null,
    settingsWith({ capture: { maxBatch: 10, intervalMin: 0, intervalMax: 0, longRestEvery: 0 } })
  );
  const tasks = [];
  for (let i = 0; i < 15; i++) tasks.push({ sku: '10000000100' + i });
  const summary = await runner.start(tasks);
  assert.equal(summary.blocked, false);
  assert.equal(summary.queued, 10);
  assert.equal(summary.truncated, 5);
  assert.equal(summary.limit, 10);
  assert.equal(summary.total, 10);
  assert.equal(summary.ok, 10);
  assert.equal(chromeApi.__calls.updated.length, 10, '只导航前 10 条');
  assert.equal(runner.state.queued, 10);
  assert.equal(runner.state.truncated, 5);

  // 设置范围 5~100：小于 5 按 5、大于 100 按 100（不写死 20）
  const low = new CaptureRunner({ chromeApi: createFakeChrome(), settings: settingsWith({ capture: { maxBatch: 2 } }) });
  assert.equal(low._cfg.maxBatch, 5);
  const high = new CaptureRunner({
    chromeApi: createFakeChrome(),
    settings: settingsWith({ capture: { maxBatch: 999 } })
  });
  assert.equal(high._cfg.maxBatch, 100);
  const changed = new CaptureRunner({
    chromeApi: createFakeChrome(),
    settings: settingsWith({ capture: { maxBatch: 30 } })
  });
  assert.equal(changed._cfg.maxBatch, 30, '改设置后下一次 start 用新值（非写死）');
});

test('v2.1.4 降频参数：intervalMin/intervalMax 生效（任务间随机等待）', async () => {
  const chromeApi = createFakeChrome({
    onNavigate: (url) => {
      const sku = skuFromUrl(url);
      setTimeout(() => chromeApi.__emit(makeResult(sku)), 2);
    }
  });
  const { runner, events } = makeRunner(
    chromeApi,
    null,
    settingsWith({ capture: { intervalMin: 1, intervalMax: 1, maxBatch: 20 } })
  );
  const startedAt = Date.now();
  const summary = await runner.start([{ sku: '100000000001' }, { sku: '100000000002' }]);
  const elapsed = Date.now() - startedAt;
  assert.equal(summary.ok, 2);
  assert.ok(elapsed >= 900, '任务间应等待约 1 秒（实际 ' + elapsed + 'ms）');
  assert.ok(events.logs.some((l) => l.includes('等待 1 秒')), '日志记录间隔等待');
});

test('v2.1.4 降频参数：longRestEvery/longRestMin/longRestMax 生效（长休息）', async () => {
  const chromeApi = createFakeChrome({
    onNavigate: (url) => {
      const sku = skuFromUrl(url);
      setTimeout(() => chromeApi.__emit(makeResult(sku)), 2);
    }
  });
  const { runner, events } = makeRunner(
    chromeApi,
    null,
    settingsWith({
      capture: { longRestEvery: 1, longRestMin: 1, longRestMax: 1, intervalMin: 0, intervalMax: 0, maxBatch: 20 }
    })
  );
  const startedAt = Date.now();
  const summary = await runner.start([{ sku: '100000000001' }, { sku: '100000000002' }]);
  const elapsed = Date.now() - startedAt;
  assert.equal(summary.ok, 2);
  assert.ok(elapsed >= 900, '长休息应等待约 1 秒（实际 ' + elapsed + 'ms）');
  assert.ok(
    events.logs.some((l) => l.includes('长休息 1 秒')),
    '日志记录长休息'
  );
});

test('v2.1.4 默认频控参数：5~10s 间隔 / 20 条上限 / 8 条长休息 30~60s / 冷却 60 分钟', () => {
  const chromeApi = createFakeChrome();
  const runner = new CaptureRunner({ chromeApi: chromeApi, settings: {} });
  // 通过内部 cfg 只读校验默认值（构造后不启动，不会有请求）
  assert.equal(runner._cfg.intervalMin, 5);
  assert.equal(runner._cfg.intervalMax, 10);
  assert.equal(runner._cfg.maxBatch, 20);
  assert.equal(runner._cfg.longRestEvery, 8);
  assert.equal(runner._cfg.longRestMin, 30);
  assert.equal(runner._cfg.longRestMax, 60);
  assert.equal(runner._cfg.cooldownMinutes, 60);
  assert.equal(runner.canStart().ok, true);
  assert.equal(runner.cooldownUntil, 0);
});

// ---------------- v2.1.5 落地页三分类：下架继续 / 软异常等待自动继续 ----------------

test('v2.1.5 offSale：标记失败「已下架」并继续下一条（不暂停/不冷却/不触发连续失败暂停）', async () => {
  const chromeApi = createFakeChrome({
    onNavigate: (url) => {
      const sku = skuFromUrl(url);
      const index = chromeApi.__calls.updated.length;
      setTimeout(() => {
        if (index <= 4) chromeApi.__emit(makeOffSaleResult(sku)); // 前 4 条全下架
        else chromeApi.__emit(makeResult(sku));
      }, 2);
    }
  });
  const { runner, events } = makeRunner(chromeApi, null, settingsWith({ capture: { retries: 2 } }));
  const tasks = [
    { sku: '100000000101' },
    { sku: '100000000102' },
    { sku: '100000000103' },
    { sku: '100000000104' },
    { sku: '100000000105' }
  ];
  const summary = await runner.start(tasks);
  assert.equal(summary.ok, 1);
  assert.equal(summary.fail, 4);
  assert.equal(summary.offSaleCount, 4);
  assert.equal(summary.autoPaused, false, '下架不应触发自动暂停');
  assert.equal(runner.cooldownUntil, 0, '下架不应触发冷却');
  assert.equal(chromeApi.__calls.updated.length, 5, '下架后仍继续下一条');
  assert.equal(events.results.filter((r) => r.ok === false).length, 4);
  assert.ok(
    events.results.some((r) => r.ok === false && String(r.reason || '').indexOf('下架') >= 0),
    '失败原因含「已下架」'
  );
  assert.ok(events.logs.some((l) => l.includes('已下架，跳过继续下一条')), '日志说明下架跳过');
});

test('v2.1.5 softAnomaly：等待 N 秒后自动继续（无需人工继续）', async () => {
  const chromeApi = createFakeChrome({
    onNavigate: (url) => {
      const sku = skuFromUrl(url);
      const index = chromeApi.__calls.updated.length;
      setTimeout(() => {
        if (index === 1) chromeApi.__emit(makeSoftAnomalyResult(sku));
        else chromeApi.__emit(makeResult(sku));
      }, 2);
    }
  });
  const { runner, events } = makeRunner(
    chromeApi,
    null,
    settingsWith({ capture: { anomalyWaitSec: 0.3, anomalyMaxRetry: 3 } })
  );
  const startedAt = Date.now();
  const summary = await runner.start([{ sku: '100000000201' }, { sku: '100000000202' }]);
  const elapsed = Date.now() - startedAt;
  assert.equal(summary.ok, 1);
  assert.equal(summary.fail, 1);
  assert.equal(summary.softAnomalyCount, 1);
  assert.equal(summary.autoPaused, false, '软异常等待后自动继续，不需要人工启动');
  assert.equal(chromeApi.__calls.updated.length, 2, '等待后自动继续下一条');
  assert.ok(elapsed >= 250, '软件异常等待约 0.3 秒（实际 ' + elapsed + 'ms）');
  assert.ok(events.progress.some((p) => p.phase === 'anomaly-wait'), '进度事件含 anomaly-wait');
  const waitEvent = events.progress.find((p) => p.phase === 'anomaly-wait' && p.remainingMs > 0);
  assert.ok(waitEvent && waitEvent.totalMs >= 250, 'anomaly-wait 带 remainingMs/totalMs');
  assert.ok(waitEvent.waitingUntil > 0, 'anomaly-wait 带 waitingUntil');
  assert.ok(events.logs.some((l) => l.includes('等待') && l.includes('自动继续')), '日志说明等待后自动继续');
  assert.ok(events.logs.some((l) => l.includes('异常等待结束')), '等待结束日志');
  assert.equal(summary.anomaly && summary.anomaly.reason, 'home');
});

test('v2.1.5 softAnomaly：anomalyWaitSec=0 时立即继续', async () => {
  const chromeApi = createFakeChrome({
    onNavigate: (url) => {
      const sku = skuFromUrl(url);
      const index = chromeApi.__calls.updated.length;
      setTimeout(() => {
        chromeApi.__emit(index === 1 ? makeSoftAnomalyResult(sku) : makeResult(sku));
      }, 2);
    }
  });
  const { runner, events } = makeRunner(chromeApi, null, settingsWith({ capture: { anomalyWaitSec: 0 } }));
  const startedAt = Date.now();
  const summary = await runner.start([{ sku: '100000000211' }, { sku: '100000000212' }]);
  const elapsed = Date.now() - startedAt;
  assert.equal(summary.ok, 1);
  assert.equal(summary.softAnomalyCount, 1);
  assert.ok(elapsed < 2000, '不等待直接继续（实际 ' + elapsed + 'ms）');
  assert.ok(events.logs.some((l) => l.includes('anomalyWaitSec=0')), '日志说明立即继续');
});

test('v2.1.5 skipAnomalyWait：等待中可立即继续', async () => {
  const chromeApi = createFakeChrome({
    onNavigate: (url) => {
      const sku = skuFromUrl(url);
      const index = chromeApi.__calls.updated.length;
      setTimeout(() => {
        chromeApi.__emit(index === 1 ? makeSoftAnomalyResult(sku) : makeResult(sku));
      }, 2);
    }
  });
  const { runner, events } = makeRunner(
    chromeApi,
    null,
    settingsWith({ capture: { anomalyWaitSec: 5, anomalyMaxRetry: 3 } })
  );
  const pending = runner.start([{ sku: '100000000221' }, { sku: '100000000222' }]);
  const inWait = await waitUntil(() => runner.state.waitingUntil > 0, 3000);
  assert.equal(inWait, true, '应进入异常等待');
  const startedSkip = Date.now();
  assert.equal(runner.skipAnomalyWait(), true, '等待中 skipAnomalyWait 返回 true');
  const summary = await pending;
  const elapsed = Date.now() - startedSkip;
  assert.equal(summary.ok, 1);
  assert.equal(summary.softAnomalyCount, 1);
  assert.ok(elapsed < 2000, '跳过等待后快速继续（实际 ' + elapsed + 'ms）');
  assert.ok(events.logs.some((l) => l.includes('已跳过异常等待')), '日志记录跳过等待');
  assert.equal(runner.state.waitingUntil, 0);
});

test('v2.1.5 连续 3 次 softAnomaly → 升级冷却暂停（提示换账号/网络）', async () => {
  const chromeApi = createFakeChrome({
    onNavigate: (url) => {
      const sku = skuFromUrl(url);
      setTimeout(() => chromeApi.__emit(makeSoftAnomalyResult(sku)), 2);
    }
  });
  const { runner, events } = makeRunner(
    chromeApi,
    null,
    settingsWith({ capture: { anomalyWaitSec: 0, anomalyMaxRetry: 3, cooldownMinutes: 30 } })
  );
  const startedAt = Date.now();
  const pending = runner.start([
    { sku: '100000000231' },
    { sku: '100000000232' },
    { sku: '100000000233' },
    { sku: '100000000234' }
  ]);
  const paused = await waitUntil(() => runner.paused && runner.state.autoPaused, 4000);
  assert.equal(paused, true, '连续异常应升级为冷却暂停');
  assert.ok(runner.state.risk && runner.state.risk.reason === 'anomaly', 'state.risk 标记 anomaly');
  assert.ok(runner.cooldownUntil > startedAt + 29 * 60000, '升级后冷却约 30 分钟');
  assert.equal(chromeApi.__calls.updated.length, 3, '第 3 次异常后停止，不再打开第 4 条');
  assert.ok(events.logs.some((l) => l.includes('升级为冷却暂停')), '日志说明升级冷却');
  assert.ok(events.logs.some((l) => l.includes('换账号/换网络') || l.includes('切换电商平台账号或网络')), '日志提示换账号/网络');

  runner.stop();
  const summary = await pending;
  assert.equal(summary.autoPaused, true);
  assert.equal(summary.softAnomalyCount, 3);
  assert.equal(summary.risk && summary.risk.reason, 'anomaly');
  assert.equal(summary.cooldownUntil, runner.cooldownUntil);
  // 升级冷却后 start 被 blocked
  const blocked = await runner.start([{ sku: '100000000235' }]);
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.cooldownUntil, runner.cooldownUntil);
});

test('v2.1.5 默认异常参数：anomalyWaitSec=60 / anomalyMaxRetry=3', () => {
  const runner = new CaptureRunner({ chromeApi: createFakeChrome(), settings: {} });
  assert.equal(runner._cfg.anomalyWaitSec, 60);
  assert.equal(runner._cfg.anomalyMaxRetry, 3);
  assert.equal(runner.state.waitingUntil, 0);
  assert.equal(runner.state.anomaly, null);
  assert.equal(runner.state.anomalyStreak, 0);
  assert.equal(runner.state.offSaleCount, 0);
  assert.equal(runner.state.softAnomalyCount, 0);
});

// ---------------- v2.1.6 尺寸严格识别（size:null+uncertain 不写 size）----------------

test('v2.1.6 尺寸未识别（size:null+sizeUncertain）不写 size，明确尺寸才写并清 uncertain', () => {
  // ① 页面尺寸待人工：sizeInch/sizeText/sizeSource 都必须为空（pipeline 据此不写 row.size、不清 sizeAmbiguous）
  const uncertainResult = makeResult('100200174986', {
    size: null,
    sizeUncertain: true,
    sizeReason: '标题含多个尺寸，待人工复核'
  });
  const uncertain = buildCaptureRecord(uncertainResult, { task: { sku: '100200174986' } });
  assert.equal(uncertain.sizeInch, null, '待人工时不写 size');
  assert.equal(uncertain.sizeText, '');
  assert.equal(uncertain.sizeSource, '');
  assert.equal(uncertain.sizeUncertain, true);
  assert.equal(uncertain.sizeReason, '标题含多个尺寸，待人工复核');

  // ② 只有明确尺寸才写 size（并标记 sizeUncertain=false → pipeline 才允许清 sizeAmbiguous）
  const definiteResult = makeResult('100200174987', {
    size: { inch: 65, text: '65英寸', source: 'spec', sizeUncertain: false },
    sizeUncertain: false
  });
  const definite = buildCaptureRecord(definiteResult, { task: { sku: '100200174987' } });
  assert.equal(definite.sizeInch, 65);
  assert.equal(definite.sizeText, '65英寸');
  assert.equal(definite.sizeSource, 'spec');
  assert.equal(definite.sizeUncertain, false);

  // ③ 兼容旧格式（result.size 内自带 sizeUncertain/reason）
  const nested = buildCaptureRecord(
    makeResult('100200174988', { size: { inch: null, sizeUncertain: true, reason: '未识别到明确尺寸，待人工复核' } }),
    { task: { sku: '100200174988' } }
  );
  assert.equal(nested.sizeInch, null);
  assert.equal(nested.sizeUncertain, true);
  assert.equal(nested.sizeReason, '未识别到明确尺寸，待人工复核');

  // ④ 标题里的价格不进入采集记录（价格只来自页面 DOM）
  const titlePriceOnly = buildCaptureRecord(
    makeResult('100200174989', {
      title: '海信 65英寸 会议平板 5000元 特惠',
      main: null,
      hand: null,
      plus: null,
      pricePick: null,
      ok: false,
      size: null,
      sizeUncertain: true
    }),
    { task: { sku: '100200174989' } }
  );
  assert.equal(titlePriceOnly.price, null, '标题里的价格不产生采集价');
  assert.equal(titlePriceOnly.priceKind, '');
  assert.ok(titlePriceOnly.fail, '无页面价格记为失败（不猜）');
});

// ---------------- v2.1.7 价格算法调试字段透传 ----------------

test('v2.1.7 buildCaptureRecord 透传价格类型/位置/变化/候选（巡检双轨算法字段）', () => {
  const rect = { left: 120, top: 240, width: 180, height: 40 };
  const result = makeResult('100200174990', {
    price: 5499,
    priceKind: 'hand',
    priceKindLabel: '到手价',
    priceRect: rect,
    priceChanges: [{ from: 24699, to: 25099 }],
    sourceLabel: 'price hand-price',
    candidates: [
      {
        price: 5499,
        kind: 'hand',
        text: '预估到手价￥5499.00',
        label: '预估到手价',
        cls: 'price hand-price',
        font: 26,
        strike: false,
        rect,
        suspect: false
      }
    ]
  });
  const capture = buildCaptureRecord(result, { task: { sku: '100200174990' } });
  assert.equal(capture.priceKind, 'hand');
  assert.equal(capture.priceKindLabel, '到手价');
  assert.deepEqual(capture.priceRect, rect);
  assert.deepEqual(capture.priceChanges, [{ from: 24699, to: 25099 }]);
  assert.equal(capture.sourceLabel, 'price hand-price');
  assert.equal(capture.candidates.length, 1);
  assert.equal(capture.candidates[0].font, 26);
  assert.deepEqual(capture.candidates[0].rect, rect);
  assert.equal(capture.price, 5499);

  // 没有 priceKindLabel 时按 priceKind 兜底中文名（main → 电商平台价）
  const mainOnly = buildCaptureRecord(
    makeResult('100200174991', { hand: null, pricePick: null, priceKind: 'main', priceKindLabel: '' }),
    { task: { sku: '100200174991' } }
  );
  assert.equal(mainOnly.priceKind, 'main');
  assert.equal(mainOnly.priceKindLabel, '电商平台价');
  assert.deepEqual(mainOnly.priceChanges, []);
  assert.equal(mainOnly.priceRect, null);
});





