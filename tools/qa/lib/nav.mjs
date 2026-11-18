// tools/qa/lib/nav.mjs —— 五页导航识别与点击（shot.mjs 截图 / tests/qa/ui-smoke.mjs 冒烟共用）
// 适配工作台 app.html 的 button.nav-btn[data-page-target]；同时兜底 data-page / role=tab / 文案匹配。
// v2.1.3 新增第 5 页「总览」（overview）。
import { sleep } from './cdp.mjs';

export const PAGES = [
  { key: 'workbench', names: ['工作台', '工作区', '数据源', '配对'], file: '01-workbench.png' },
  { key: 'overview', names: ['总览', '配对总览', '全部配对'], file: '06-overview.png' },
  { key: 'library', names: ['匹配库', '知识库', '基础库'], file: '02-library.png' },
  { key: 'stats', names: ['统计看板', '统计', '看板'], file: '03-stats.png' },
  { key: 'settings', names: ['设置与帮助', '设置与说明', '设置', '帮助'], file: '04-settings.png' },
];

/** 在页面里找四页导航，返回 { pageKey: {idx, text, tag, name, score} }。 */
export async function detectNav(page) {
  return await page.evaluate(`(() => {
    const PAGES = ${JSON.stringify(PAGES.map((p) => ({ key: p.key, names: p.names })))};
    const all = Array.from(document.querySelectorAll(
      '[data-page], [data-page-target], [data-view], [data-tab], header a, header button, nav a, nav button, aside a, aside button, .tabs > *, .tab, .nav-btn, .nav-item, .nav, [role="tab"], .sidebar a, .sidebar button, .settings-nav *, .step-nav *, button, a'
    ));
    const visible = all.filter((el) => {
      if (!el || !el.isConnected) return false;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
    });
    const pick = (el, name) => {
      const t = (el.textContent || '').replace(/\\s+/g, '').trim();
      if (!t || t.length > 16) return -1;
      if (t === name) return 100;
      if (t.startsWith(name)) return 90 - (t.length - name.length);
      if (t.includes(name)) return 60 - (t.length - name.length);
      return -1;
    };
    const scoreEl = (el) => {
      let s = 0;
      const cls = String(el.className || '');
      if (el.getAttribute('role') === 'tab') s += 20;
      if (el.closest('nav, header, aside, .sidebar, .tabs, .nav, .settings-nav')) s += 8;
      if (/tab|nav|menu|sidebar|rail|step/i.test(cls)) s += 8;
      if (el.children.length === 0) s += 3;
      const dp = el.getAttribute('data-page') || el.getAttribute('data-page-target') || el.getAttribute('data-view') || el.getAttribute('data-tab');
      if (dp) s += 10;
      return s;
    };
    const found = {};
    for (const p of PAGES) {
      let best = null, bestScore = 0, bestName = '';
      for (const el of visible) {
        for (const name of p.names) {
          const tScore = pick(el, name);
          if (tScore < 0) continue;
          const total = tScore + scoreEl(el) + (name.length > 2 ? 1 : 0);
          if (total > bestScore) { bestScore = total; best = el; bestName = name; }
        }
      }
      if (best) {
        const idx = visible.indexOf(best);
        best.setAttribute('data-qa-nav', String(idx));
        found[p.key] = { idx, text: (best.textContent || '').trim().slice(0, 40), tag: best.tagName, name: bestName, score: bestScore };
      }
    }
    return found;
  })()`);
}

/** 点击 detectNav 标记过的导航项。 */
export async function clickNav(page, idx) {
  const clicked = await page.evaluate(`(() => {
    const el = document.querySelector('[data-qa-nav="${idx}"]');
    if (!el) return false;
    el.scrollIntoView({ block: 'center' });
    el.click();
    return true;
  })()`);
  if (clicked) await sleep(400);
  return clicked;
}

/** 首选稳定入口：工作台 app.html 用 .nav-btn[data-page-target="<key>"]（见 work/workbench-ui/DOM-IDS.md）。 */
export async function clickStableNav(page, key) {
  const clicked = await page.evaluate(`(() => {
    const el = document.querySelector('[data-page-target="${key}"]');
    if (!el) return false;
    el.click();
    return true;
  })()`);
  if (clicked) await sleep(350);
  return clicked;
}

/** 等某页可见（#page-<key> 不带 hidden 且在视口内）。 */
export async function waitPageVisible(page, key, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const visible = await page.evaluate(`(() => {
      const el = document.getElementById('page-${key}');
      if (!el) return false;
      if (String(el.className || '').includes('hidden')) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    })()`);
    if (visible) return true;
    await sleep(120);
  }
  return false;
}

/** 当前可见页面 key（用于断言切页成功）。 */
export async function currentPageKey(page) {
  return await page.evaluate(`(() => {
    const sections = Array.from(document.querySelectorAll('section.page, [data-page]'));
    for (const el of sections) {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      if (r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden') {
        return el.getAttribute('data-page') || el.id || '';
      }
    }
    return '';
  })()`);
}
