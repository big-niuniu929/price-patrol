#!/usr/bin/env node
/**
 * 价格监控平台 · 浏览器端验收脚本（零依赖：Node 内置 WebSocket + headless Edge CDP）
 *
 * 用法：
 *   node qa/verify.mjs                  # 验收平台（默认 extDir = qa 的上一级「价格监控平台」目录）
 *   node qa/verify.mjs --ext <目录>      # 指定扩展目录（覆盖默认）
 *   node qa/verify.mjs --static         # 只跑静态文件检查（不开浏览器，写代码阶段快速自检）
 *   node qa/verify.mjs --dom            # 静态检查 + jsdom 壳逻辑验证（无浏览器兜底，写报告）
 *   node qa/verify.mjs --render         # 不跑验证，仅用现有 qa/report.json 重新生成 REPORT.md（补环境/修复点/风险段）
 *   node qa/verify.mjs --selftest --ext "~/Desktop/市占率\\extension"
 *                                       # 工具链自检：加载扩展 → 打开 app.html → 截图 → 打印 console
 * 其他参数：
 *   --out <目录>     报告输出目录，默认 qa/
 *   --port <端口>    CDP 端口，默认随机
 *   --ext-id <ID>    覆盖扩展 ID 探测（DS_EXT_ID 环境变量等价）
 *   --browser <路径> 指定浏览器可执行文件
 *   --timeout <ms>   单步等待超时，默认 20000
 *
 * 产物：
 *   qa/shots/*.png   截图（platform 模式：01 首页 / 02~04 三模块 / 05 独立标签页 / 06 返回首页 / 07 深链 / 08 后退 / 10 使用说明 / 11 使用说明独立标签页）
 *   qa/shots/harness-selftest-share.png  自检截图
 *   qa/report.json + qa/REPORT.md        正式验收结构化报告（--selftest / --static 不写这两份）
 *
 * 约定（来自合并方案，选择器契约）：
 *   - 业务卡片：            [data-biz="patrol" | "share" | "radar" | "guide"]
 *   - 模块容器：            iframe#moduleFrame，src = modules/<biz>/app.html（guide 为 guide.html）
 *   - 业务切换按钮：        [data-switch-biz="<biz>"]（含 guide）
 *   - 返回首页 / 独立标签页：优先 data-* 选择器，兜底按可见文案点击（见 HOME_SELECTORS / NEWTAB_SELECTORS）
 *
 * 退出码：0 全部通过；1 有失败项；2 环境/致命错误（未跑完）。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  launchBrowser, findExtensionId, findPageTarget, createPageTarget,
  PageSession, CdpClient, waitForCdp, findBrowser, sleep,
} from './lib/cdp.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QA_DIR = __dirname;
const PLATFORM_DIR = path.resolve(QA_DIR, '..');
const SHOTS_DIR = path.join(QA_DIR, 'shots');
const VIEWPORT = { width: 1440, height: 900 };

// ---------------------------------------------------------------------------
// 三业务契约：模块路径、首屏关键 DOM（均取自原插件 app.html 的稳定 id）、关键数据 JSON
// ---------------------------------------------------------------------------
const BIZ = {
  patrol: {
    label: '价格巡检',
    modulePage: 'modules/patrol/app.html',
    shot: '02-module-patrol-1440.png',
    keyDom: ['#viewWorkbench', '#tblBody', '#statsBar'],
    dataJson: [
      'modules/patrol/data/base-skus.json',
      'modules/patrol/data/ai-config.json',
    ],
    minText: 40,
  },
  share: {
    label: '市占率',
    modulePage: 'modules/share/app.html',
    shot: '03-module-share-1440.png',
    keyDom: ['#page-workbench', '[data-page-target="workbench"]'],
    dataJson: ['modules/share/data/base-skus.json'],
    minText: 40,
  },
  radar: {
    label: '竞品监控',
    modulePage: 'modules/radar/app.html',
    shot: '04-module-radar-1440.png',
    keyDom: ['#viewDashboard', '#viewTitle'],
    dataJson: ['modules/radar/data/competitor-skus.json'],
    minText: 40,
  },
};
const BIZ_IDS = ['patrol', 'share', 'radar'];

// 第 4 个入口「使用说明」：不是业务模块，是同源扩展页 guide.html，由平台壳 iframe 装载。
const GUIDE = {
  id: 'guide',
  label: '使用说明',
  page: 'guide.html',
  shot: '10-guide-1440.png',
  tabShot: '11-independent-tab-guide-1440.png',
  // guide.html 里必须出现的关键标题/内容（按 h2 小节与正文命中）
  heads: ['平台是什么', '三个业务', '取价逻辑', '基准价', '数据存在哪', '常见问题', 'Web 版'],
};
// 首页四张卡片 / 顶栏四个切换入口
const ALL_CARD_IDS = [...BIZ_IDS, GUIDE.id];

// 壳子顶部条按钮的稳健识别：先 data-*，再可见文案
const HOME_SELECTORS = ['[data-back-home]', '[data-home]', '[data-action="home"]', '[data-nav="home"]', '#backHomeBtn', '#homeBtn'];
const HOME_TEXTS = ['返回首页', '返回业务选择', '业务选择', '选择业务', '返回'];
const NEWTAB_SELECTORS = ['[data-open-tab]', '[data-open-in-tab]', '[data-open-new-tab]', '[data-action="open-tab"]', '#openTabBtn', '#openInTabBtn'];
const NEWTAB_TEXTS = ['独立标签页', '新标签页', '在新标签页打开', '新窗口打开', '独立打开', '单独打开'];

const DATA_RESOURCE_RE = /\/(data\/[^?#]+\.json)(?:[?#]|$)/i;
// 已知可接受的非致命资源（Lead 确认）：patrol 源码插件本来就没有 preset-settings.json，
// modules/patrol/app.js:366 的 fetch 在 try/catch 内，缺失不阻断使用。只记录、不判失败。
const BENIGN_RESOURCE_RE = /\/modules\/patrol\/data\/preset-settings\.json/i;

/** 把 console error 分成「已知可接受」与「真实 error」。
 *  已知可接受：modules/patrol/data/preset-settings.json 缺失（Lead 确认；源码插件本就没有该文件，
 *  fetch 在 try/catch 内）。不同版本 Log 文本可能只有 "Failed to load resource: net::ERR_FILE_NOT_FOUND"
 *  不带 URL，因此：① 优先按 logEntries.url / 网络失败 URL 关联到 preset-settings；
 *  ② 关联不到时把 ERR_FILE_NOT_FOUND 归入已知可接受并在报告里计数 —— 关键 data JSON 是否 200
 *  由 M-*-3 主动 fetch 探测兜底，另有 E2 网络检查，不会掩盖真实缺文件问题。 */
function splitConsoleErrors(page, errs, netRecs) {
  const benign = [];
  const real = [];
  const benignNet = !!(netRecs || []).some((n) => (n.failures || []).some((f) => BENIGN_RESOURCE_RE.test(String(f.url || ''))));
  for (const e of errs) {
    const text = String(e);
    if (BENIGN_RESOURCE_RE.test(text)) { benign.push(e); continue; }
    if (text.startsWith('[log.error]')) {
      const hit = (page.logEntries || []).find((x) => BENIGN_RESOURCE_RE.test(String(x.url || ''))
        && text.includes(String(x.text || '').slice(0, 24)));
      if (hit) { benign.push(e); continue; }
      if (/ERR_FILE_NOT_FOUND/.test(text)) { benign.push(e); continue; } // preset-settings 缺失的典型表现
    }
    if (benignNet && /ERR_FILE_NOT_FOUND/.test(text)) { benign.push(e); continue; }
    real.push(e);
  }
  return { benign, real };
}

/** 过滤掉已知可接受的网络问题（按 URL 文本匹配）。 */
function partitionBenignNet(msgs) {
  const benign = [];
  const real = [];
  for (const m of msgs) {
    if (BENIGN_RESOURCE_RE.test(String(m))) benign.push(m);
    else real.push(m);
  }
  return { benign, real };
}

const HINTS = {
  S1: '确认 价格监控平台/manifest.json 存在且是合法 JSON（node -e 解析）。',
  S2: '按 task-2 规格检查 manifest：manifest_version=3、name 含「价格监控平台」、background.service_worker、permissions 含 storage/tabs/unlimitedStorage/clipboardWrite、host_permissions 覆盖 <all_urls>/item.shop.example.com/item.shop.example.com/127.0.0.1:18765/gateway.example.com。',
  S3: 'manifest.content_scripts 需分别注入 modules/patrol/content.js、modules/share/content.js、modules/radar/content.js。',
  S4: '检查 app.html：需有 iframe#moduleFrame、四张 [data-biz] 卡片（patrol/share/radar/guide）、无内联 <script>（MV3 CSP）、无远程 script/link。',
  S5: '检查 modules/<id>/app.html 是否存在；modules/<id>/manifest.json 与 background.js 应已删除（合并后由平台根统一）。',
  S6: '检查模块数据 JSON 是否随扩展复制到位（module-integrator 负责）：modules/patrol/data/base-skus.json、ai-config.json，modules/share/data/base-skus.json，modules/radar/data/competitor-skus.json。',
  S7: '检查 icons/icon16/32/48/128.png 是否存在。',
  S8: '检查平台根 README.md 是否非空。',
  S9: '使用说明页检查失败：确认根目录有 guide.html + guide.css；guide.html 不能含内联 <script>、内联事件处理器（on*）或远程资源；关键小节「取价逻辑 / 基准价 / 常见问题 / Web 版」必须存在。',
  B1: 'headless Edge 启动失败：确认 msedge.exe 路径（--browser 可指定）、没有把 Edge 放在受限作业对象里；重跑 node qa/verify.mjs。',
  B2: '扩展未加载：检查 --load-extension 路径是否带空格/中文（已用 Node 传参）、manifest 是否被 Edge 拒绝（可先 --static 校验 manifest，再用 --browser 指定浏览器）。',
  B3: 'app.html 打不开：多半是扩展 ID 探测错/扩展加载失败；检查 manifest 与 qa/lib/cdp.mjs 的 findExtensionId 规则。',
  B5: '首页四张卡片不全：检查 app.html 中四张卡片的 data-biz 值（patrol/share/radar/guide）与 JS 渲染逻辑。',
  B6: '内联脚本/事件处理器会被 MV3 CSP 拦截：把逻辑移入 app.js。',
  G1: '使用说明导航失败：检查 app.html 是否含 data-switch-biz="guide"、app.js 的 BIZ.guide.page 是否为 guide.html，以及 iframe 是否用 contentWindow.location.replace 加载 guide.html。',
  G2: '深链 #/guide 未生效：检查 app.js 的 parseHash()/BIZ 是否包含 guide（key=guide、page=guide.html），冷启动是否直接进入工作区。',
  G3: '使用说明「独立打开」失败：app.js 的 #openTabBtn 使用 chrome.tabs.create({ url: chrome.runtime.getURL(BIZ[id].page) })，guide 应生成 chrome-extension://<id>/guide.html。',
  G4: '使用说明页关键标题/样式缺失：检查 guide.html 的 7 个小节标题与 guide.css 引用；页面正文需包含「平台是什么 / 三个业务 / 取价逻辑 / 基准价 / 数据存在哪 / 常见问题 / Web 版」。',
  G5: '使用说明页 console error / 静态资源失败：检查 guide.html 是否引用了不存在的资源、guide.css 是否可访问；MV3 扩展页不允许内联脚本/事件处理器。',
  G6: '使用说明页截图失败：页面未就绪或 iframe 未加载 guide.html，先看 G1~G5 的状态与 fail-*.png。',
  G7: '使用说明阶段 console/网络失败：检查 guide.html 的 guide.css 引用路径、是否有内联脚本/事件处理器，以及 Network 面板里 guide.html/guide.css 是否 200。',
  D2: '返回首页按钮未工作：检查 app.js 中返回逻辑，并为按钮加 data-back-home 便于自动化。',
  D3: '从首页重新进入业务失败：检查业务卡片点击 → iframe 加载链路。',
  D4: '独立标签页打开失败：检查点击处理是否调用 chrome.tabs.create（MV3 需 tabs 权限）或 window.open 的 userGesture 路径。',
  D5: '深链 #/patrol 未生效：检查 app.js 读取 location.hash 的初始化逻辑，并在卡片选择后同步 hash。',
  D6: '刷新后深链丢失：检查哈希解析是否在 DOMContentLoaded 之前/之后都执行，且记住的上次业务不覆盖深链。',
  D3b: '浏览器后退异常：检查 app.js 的 popstate/hashchange 处理；后退后应保持平台页可用（首页或有效业务），不能白屏。',
  J: 'jsdom 壳逻辑失败：检查平台根 app.js 的 selectBiz/loadModule/goHome/updateHash 与 app.html 的 id/class 约定；错误原文见上表。',
  'M-': '模块 E2E 失败：看 qa/shots/fail-*.png 与上方 console 原文；检查 modules/<id>/app.html 能否在 iframe 内运行（getURL 路径补丁、chrome.* API、是否依赖 window.top），以及平台 app.js loadModule 设置的 src。',
  E1: '存在 console error：按上方原文定位到具体模块/资源；若是 modules/patrol/data/preset-settings.json 类可选资源 404，可按备注处理（补文件或在 fetch 前判断）。',
  E2: '关键资源 4xx/5xx：检查 modules/<id>/data/ 下 JSON 是否随扩展复制、getURL 路径是否已按命名空间补丁改写。',
  G: 'content.js 共存验证失败：mock 商品页里三个 guard 未齐活，通常是某个 content.js 在 parse/main 阶段抛错；看 C1 的最后状态与 C2 的原始 error。',
  'C1': '三个 guard 未同时为 true：检查 modules/<id>/content.js 是否 IIFE 包裹、顶层是否误用 ES module 语法、是否有顶层 return；见 C2/C3 原始 error。',
  'C2': '出现脚本级错误：通常是某个 content.js 顶层 let/const/function 与另一个重名（同一扩展 isolated world 共享全局词法环境），改用 IIFE 内声明或唯一前缀。',
  'C3': 'mock 页 console 有 error：看原文；若是 mock DOM 缺失导致的业务告警，记录后由 Lead 判断是否放宽 C3。',
};

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}
function oneLine(s, n = 320) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').slice(0, n);
}
function parseArgs(argv) {
  const opts = {
    ext: PLATFORM_DIR, out: QA_DIR, selftest: false, staticOnly: false, domOnly: false, render: false,
    port: undefined, extId: '', browser: '', timeoutMs: 20000,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`参数 ${a} 缺少值`);
      return argv[++i];
    };
    switch (a) {
      case '--ext': opts.ext = path.resolve(next()); break;
      case '--out': opts.out = path.resolve(next()); break;
      case '--port': opts.port = Number(next()); break;
      case '--ext-id': opts.extId = next(); break;
      case '--browser': opts.browser = next(); break;
      case '--timeout': opts.timeoutMs = Number(next()); break;
      case '--selftest': opts.selftest = true; break;
      case '--static': opts.staticOnly = true; break;
      case '--dom': opts.domOnly = true; break;
      case '--render': opts.render = true; break;
      case '-h': case '--help': opts.help = true; break;
      default: throw new Error(`未知参数：${a}`);
    }
  }
  return opts;
}

/** Chromium 未打包扩展 ID 由扩展绝对路径派生（SHA256 前 16 字节 → a-p）。
 *  这里只做「校验/兜底参考」——正常路径优先用 findExtensionId 从 service_worker target 拿。
 *  Windows 下 Chromium 用 UTF-16LE 的路径字节，且可能先小写化；因此枚举几种变体。 */
function deriveExtensionIdVariants(dir) {
  const abs = path.resolve(dir).toLowerCase();
  const variants = new Map();
  const encodings = [
    ['utf16le', 'utf16le'],
    ['utf8-lower', 'utf8'],
  ];
  for (const [name, enc] of encodings) {
    try {
      const h = crypto.createHash('sha256').update(Buffer.from(abs, enc)).digest();
      let id = '';
      for (let i = 0; i < 16; i++) {
        id += String.fromCharCode(97 + (h[i] >> 4));
        id += String.fromCharCode(97 + (h[i] & 0x0f));
      }
      variants.set(name, id);
    } catch { /* ignore */ }
  }
  return variants;
}

// ---------------------------------------------------------------------------
// Runner：断言收集 + 截图 + 失败现场
// ---------------------------------------------------------------------------
class Runner {
  constructor(shotDir) {
    this.results = [];
    this.shots = [];
    this.notes = [];
    this.page = null;
    this.shotDir = shotDir;
    this.failShotIds = new Set();
    this.startedAt = Date.now();
  }

  setPage(page) { this.page = page; }

  async check(id, title, fn) {
    const t0 = Date.now();
    const rec = { id, title, ok: false, durationMs: 0, detail: null, error: null };
    try {
      rec.detail = await fn();
      rec.ok = true;
    } catch (err) {
      rec.error = String((err && err.stack) || err);
      await this.captureFail(id);
    }
    rec.durationMs = Date.now() - t0;
    this.results.push(rec);
    console.log(`[${rec.ok ? 'PASS' : 'FAIL'}] ${id} ${title}${rec.ok ? (rec.detail ? ' · ' + oneLine(rec.detail, 200) : '') : ' → ' + oneLine(rec.error, 400)}`);
    return rec;
  }

  async captureFail(id) {
    if (!this.page || this.failShotIds.has(id)) return;
    this.failShotIds.add(id);
    const name = `fail-${id.replace(/[^A-Za-z0-9_-]/g, '_')}.png`;
    try {
      const p = path.join(this.shotDir, name);
      await this.page.screenshot(p);
      this.shots.push({ name, path: p, note: `失败现场（${id}）` });
    } catch { /* 截图失败不掩盖原始错误 */ }
  }

  async shot(name, note) {
    if (!this.page) throw new Error('页面未就绪（浏览器未启动或已关闭），无法截图');
    const p = path.join(this.shotDir, name);
    await this.page.screenshot(p);
    this.shots.push({ name, path: p, note: note || '' });
    console.log(`[shot] ${p}`);
    return p;
  }

  note(text) { this.notes.push(String(text)); }

  get failed() { return this.results.filter((r) => !r.ok); }
  get passed() { return this.results.filter((r) => r.ok); }
}

// ---------------------------------------------------------------------------
// 静态检查（不依赖浏览器）
// ---------------------------------------------------------------------------
async function runStaticChecks(r, extDir) {
  const mfPath = path.join(extDir, 'manifest.json');
  let mf = null;

  await r.check('S1', 'manifest.json 存在且 JSON 可解析', async () => {
    expect(fs.existsSync(extDir), `扩展目录不存在：${extDir}`);
    expect(fs.existsSync(mfPath), `缺少 ${mfPath}`);
    mf = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
    return `name=${mf.name} · version=${mf.version} · manifest_version=${mf.manifest_version}`;
  });

  await r.check('S2', 'manifest 符合合并规格（MV3 / 名称 / background / permissions / host_permissions）', async () => {
    expect(mf, 'manifest 无法解析，跳过');
    expect(mf.manifest_version === 3, `manifest_version=${mf.manifest_version}，应为 3`);
    expect(/价格监控平台/.test(String(mf.name || '')), `name=${JSON.stringify(mf.name)}，应包含「价格监控平台」`);
    expect(mf.background && mf.background.service_worker, '缺少 background.service_worker（点图标打开平台页依赖它）');
    const perms = new Set(mf.permissions || []);
    const needPerms = ['storage', 'tabs', 'unlimitedStorage', 'clipboardWrite'];
    const missPerms = needPerms.filter((p) => !perms.has(p));
    expect(missPerms.length === 0, `permissions 缺少：${missPerms.join('、')}`);
    const hosts = (mf.host_permissions || []).join(' | ');
    const needHosts = ['<all_urls>', 'item.shop.example.com', 'item.shop.example.com', '127.0.0.1:18765', 'gateway.example.com'];
    const missHosts = needHosts.filter((h) => !hosts.includes(h));
    expect(missHosts.length === 0, `host_permissions 缺少：${missHosts.join('、')}（现有：${hosts || '空'}）`);
    return `permissions=${[...perms].join(',')} · hosts=${(mf.host_permissions || []).length} 条`;
  });

  await r.check('S3', 'content_scripts 注入三个模块的 content.js', async () => {
    expect(mf, 'manifest 无法解析，跳过');
    const files = [];
    for (const cs of mf.content_scripts || []) for (const js of cs.js || []) files.push(String(js));
    const miss = BIZ_IDS.map((b) => `modules/${b}/content.js`).filter((f) => !files.includes(f));
    expect(miss.length === 0, `content_scripts 缺少：${miss.join('、')}（现有：${files.join(',') || '空'}）`);
    return files.join(', ');
  });

  let appHtml = '';
  await r.check('S4', 'app.html 含 #moduleFrame、四张卡片 data-biz（三业务 + guide），且无内联脚本（MV3 CSP）', async () => {
    const f = path.join(extDir, 'app.html');
    expect(fs.existsSync(f), `缺少 ${f}`);
    appHtml = fs.readFileSync(f, 'utf8');
    expect(/id\s*=\s*["']moduleFrame["']/.test(appHtml), 'app.html 缺少 iframe#moduleFrame');
    const miss = ALL_CARD_IDS.filter((b) => !new RegExp(`data-biz\\s*=\\s*["']${b}["']`).test(appHtml));
    expect(miss.length === 0, `app.html 缺少业务卡片 data-biz：${miss.join('、')}`);
    const missSwitch = ALL_CARD_IDS.filter((b) => !new RegExp(`data-switch-biz\\s*=\\s*["']${b}["']`).test(appHtml));
    expect(missSwitch.length === 0, `app.html 缺少业务切换按钮 data-switch-biz：${missSwitch.join('、')}`);
    // 内联脚本 = 没有 src 且有内容（MV3 扩展页 CSP 会拦截）
    const inline = [];
    const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = re.exec(appHtml))) {
      const attrs = m[1] || '';
      const body = (m[2] || '').trim();
      if (!/\bsrc\s*=/i.test(attrs) && body.length > 0) inline.push(body.slice(0, 60));
    }
    expect(inline.length === 0, `发现内联脚本 ${inline.length} 处：${inline.map((s) => oneLine(s, 40)).join(' | ')}`);
    const remote = (appHtml.match(/(?:src|href)\s*=\s*["']https?:\/\//gi) || []);
    expect(remote.length === 0, `发现远程 script/link 引用 ${remote.length} 处（MV3 扩展页会被拦）：${remote.slice(0, 3).join(' | ')}`);
    return `${Math.round(appHtml.length / 1024)}KB · 四卡片四切换按钮齐全 · 无内联脚本/远程资源`;
  });

  await r.check('S5', 'modules/<id>/app.html 存在；模块根 manifest.json/background.js 已移除', async () => {
    const details = [];
    for (const b of BIZ_IDS) {
      const dir = path.join(extDir, 'modules', b);
      expect(fs.existsSync(path.join(dir, 'app.html')), `缺少 ${path.join(dir, 'app.html')}`);
      expect(fs.existsSync(path.join(dir, 'app.js')), `缺少 ${path.join(dir, 'app.js')}`);
      expect(!fs.existsSync(path.join(dir, 'manifest.json')), `modules/${b}/manifest.json 应已删除（统一由平台根 manifest 管理）`);
      expect(!fs.existsSync(path.join(dir, 'background.js')), `modules/${b}/background.js 应已删除（统一由平台根 background 管理）`);
      details.push(`${b}: ${fs.readdirSync(dir).length} 项`);
    }
    return details.join(' · ');
  });

  await r.check('S6', '模块关键数据 JSON 已就位', async () => {
    const missing = [];
    for (const b of BIZ_IDS) {
      for (const rel of BIZ[b].dataJson) {
        if (!fs.existsSync(path.join(extDir, rel))) missing.push(rel);
      }
    }
    expect(missing.length === 0, `缺少：${missing.join('、')}`);
    const preset = path.join(extDir, 'modules/patrol/data/preset-settings.json');
    if (!fs.existsSync(preset)) {
      r.note('modules/patrol/data/preset-settings.json 不存在。原源码插件 data/ 里也没有该文件，但 modules/patrol/app.js:366 会 fetch 它（失败被 try/catch 兜住）；打包完整版有该文件：~/Desktop/巡检\\_pack\\stage-chrome\\full\\巡检插件-双轨版\\extension\\data\\preset-settings.json。若正式验收出现该 URL 的 console error，建议补上该文件或让 module-integrator 放宽 fetch。');
    }
    return BIZ_IDS.map((b) => `${b}: ${BIZ[b].dataJson.length} 个`).join(' · ');
  });

  await r.check('S7', 'icons 16/32/48/128 存在', async () => {
    const missing = [16, 32, 48, 128].filter((n) => !fs.existsSync(path.join(extDir, 'icons', `icon${n}.png`)));
    expect(missing.length === 0, `缺少：${missing.map((n) => `icons/icon${n}.png`).join('、')}`);
    return '16/32/48/128 齐全';
  });

  await r.check('S8', '平台根 README.md 存在且非空', async () => {
    const f = path.join(extDir, 'README.md');
    expect(fs.existsSync(f), `缺少 ${f}`);
    const size = fs.statSync(f).size;
    expect(size > 200, `README.md 过短（${size}B）`);
    return `${Math.round(size / 1024)}KB`;
  });

  await r.check('S9', '使用说明页 guide.html + guide.css 存在，符合 MV3 CSP，关键小节齐全', async () => {
    const htmlPath = path.join(extDir, 'guide.html');
    const cssPath = path.join(extDir, 'guide.css');
    expect(fs.existsSync(htmlPath), `缺少 ${htmlPath}`);
    expect(fs.existsSync(cssPath), `缺少 ${cssPath}`);
    const html = fs.readFileSync(htmlPath, 'utf8');
    // 内联脚本（MV3 CSP 会拦截）
    const inline = [];
    const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = re.exec(html))) {
      const attrs = m[1] || '';
      const body = (m[2] || '').trim();
      if (!/\bsrc\s*=/i.test(attrs) && body.length > 0) inline.push(body.slice(0, 60));
    }
    expect(inline.length === 0, `guide.html 发现内联脚本 ${inline.length} 处`);
    const handlers = html.match(/\son[a-z]+\s*=\s*["']/gi) || [];
    expect(handlers.length === 0, `guide.html 发现内联事件处理器 ${handlers.length} 处：${handlers.slice(0, 5).join(' | ')}`);
    const remote = html.match(/(?:src|href)\s*=\s*["']https?:\/\//gi) || [];
    expect(remote.length === 0, `guide.html 发现远程资源 ${remote.length} 处`);
    expect(/<link\b[^>]*\bhref\s*=\s*["']guide\.css["']/i.test(html), 'guide.html 未引用 guide.css');
    // 关键小节（qa 断言与产品文档同步）
    const bodyText = html.replace(/<[^>]+>/g, ' ');
    const missHeads = GUIDE.heads.filter((t) => !bodyText.includes(t));
    expect(missHeads.length === 0, `guide.html 缺少关键小节：${missHeads.join('、')}`);
    return `${Math.round(html.length / 1024)}KB · ${Math.round(fs.statSync(cssPath).size / 1024)}KB CSS · 无内联脚本/事件/远程资源 · 小节 ${GUIDE.heads.length} 项`;
  });
}

// ---------------------------------------------------------------------------
// 无浏览器兜底：jsdom 加载平台壳 app.html + app.js，stub 最小 chrome 对象，
// 验证「业务选择 → iframe 切换 → 返回首页 → 深链」等壳逻辑。
// 说明：jsdom 不加载 iframe 内的模块页，也不截图；它只验证平台壳自己的 DOM/JS 行为。
// ---------------------------------------------------------------------------
const JSDOM_CANDIDATES = [
  path.join(QA_DIR, 'vendor', 'jsdom'),
  '~/Desktop/竞品数据监控\\竞品价格雷达\\qa\\node_modules\\jsdom',
];

function resolveJsdom() {
  for (const dir of JSDOM_CANDIDATES) {
    const api = path.join(dir, 'lib', 'api.js');
    if (!fs.existsSync(api)) continue;
    try {
      const req = createRequire(path.join(dir, 'noop.js'));
      const mod = req('jsdom');
      if (mod && mod.JSDOM) return { JSDOM: mod.JSDOM, VirtualConsole: mod.VirtualConsole, from: dir };
    } catch { /* 试下一个 */ }
  }
  try {
    const req = createRequire(import.meta.url);
    const mod = req('jsdom');
    if (mod && mod.JSDOM) return { JSDOM: mod.JSDOM, VirtualConsole: mod.VirtualConsole, from: 'node_modules（本地解析）' };
  } catch { /* ignore */ }
  return null;
}

function createDomFixture(ctx, extDir) {
  const htmlPath = path.join(extDir, 'app.html');
  const jsPath = path.join(extDir, 'app.js');
  const html = fs.readFileSync(htmlPath, 'utf8');
  const appJs = fs.readFileSync(jsPath, 'utf8');
  // 外链 app.js 改成内联注入：jsdom 不需要联网/文件加载器，行为与应用内一致
  const inlineHtml = html.replace(/<script\b[^>]*\bsrc=["']app\.js["'][^>]*>\s*<\/script>/i, '<script>\n' + appJs + '\n</script>');
  if (inlineHtml === html) throw new Error('app.html 里没找到 <script src="app.js">，无法注入 jsdom');
  if (/<\/script>/i.test(appJs)) throw new Error('app.js 含 </script> 字面量，无法安全内联到 jsdom');
  return { inlineHtml, jsdomFrom: ctx.from };
}

// 平台壳用 contentWindow.location.replace() 切 iframe（不写 src 属性），jsdom 不支持真实跨文档导航。
// 这里给 iframe 的 location 做“记录导航后 URL”的模拟，并把 getURL 映射成同文档前缀，便于断言。
const FRAME_PREFIX = 'https://pjm-qa.local/app.html#!frame/';

function createDom(ctx, fixture, hash) {
  const url = 'https://pjm-qa.local/app.html' + (hash || '');
  const tabsCalls = [];
  const errors = [];
  const virtualConsole = new ctx.VirtualConsole();
  virtualConsole.on('error', (...args) => errors.push('[console.error] ' + args.map((a) => String(a)).join(' ')));
  virtualConsole.on('jsdomError', (err) => errors.push('[jsdomError] ' + String((err && err.message) || err)));
  const dom = new ctx.JSDOM(fixture.inlineHtml, {
    url,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      window.__QA_FRAME_PREFIX = FRAME_PREFIX;
      // 最小 chrome stub：壳用到 getURL / tabs.create（见 app.js 中 loadModule / openTabBtn 的处理）
      window.chrome = {
        runtime: {
          getURL: (p) => FRAME_PREFIX + String(p || '').replace(/^\/+/, ''),
          lastError: null,
          onMessage: { addListener() {}, removeListener() {} },
        },
        tabs: {
          create(opts) { tabsCalls.push(opts || {}); return { id: tabsCalls.length }; },
        },
      };
      // jsdom 不支持导航到另一个 Document：用一个假的 iframe.contentWindow.location 记录目标 URL。
      // 平台壳的 navigateFrame() 正是通过 frame.contentWindow.location.replace(url) 切 iframe，这样可观测。
      try {
        const iframeUrls = new WeakMap();
        Object.defineProperty(window.HTMLIFrameElement.prototype, 'contentWindow', {
          configurable: true,
          get() {
            const self = this;
            const resolve = (raw, cur) => {
              try { return new window.URL(String(raw), cur).href; } catch { return cur; }
            };
            const loc = {
              get href() { return iframeUrls.get(self) || 'about:blank'; },
              replace(raw) { iframeUrls.set(self, resolve(raw, this.href)); },
              assign(raw) { this.replace(raw); },
            };
            return { location: loc };
          },
        });
      } catch { /* 旧版本 jsdom 不支持覆盖 contentWindow，退回真实导航（会出现 Not implemented 报错） */ }
      window.Element.prototype.scrollIntoView = function scrollIntoView() {};
      if (!window.matchMedia) {
        window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
      }
      window.alert = () => {};
      window.confirm = () => true;
      window.open = () => null;
    },
  });
  return { dom, tabsCalls, errors };
}

/** 读 iframe 当前文档 URL（模拟 location.replace 后记录的值），并去掉 stub 前缀便于断言。 */
function frameDocUrl(win) {
  try {
    const f = win.document.getElementById('moduleFrame');
    if (!f) return '';
    const href = String((f.contentWindow && f.contentWindow.location && f.contentWindow.location.href) || '');
    const prefix = win.__QA_FRAME_PREFIX || FRAME_PREFIX;
    if (!href) return '';
    return href.startsWith(prefix) ? href.slice(prefix.length) : href;
  } catch {
    return '';
  }
}

function domState(entry) {
  const win = entry.dom.window;
  const d = win.document;
  return {
    landingHidden: d.getElementById('landing').classList.contains('hidden'),
    workspaceHidden: d.getElementById('workspace').classList.contains('hidden'),
    // 平台壳用 location.replace 切 iframe，src 属性可能为空 → 读 contentWindow.location.href
    frameSrc: frameDocUrl(win),
    maskDone: d.getElementById('frameMask').classList.contains('done'),
    frameStateText: (d.getElementById('frameState') || {}).textContent || '',
    hash: win.location.hash,
    title: d.title,
    crumb: (d.getElementById('crumbBiz') || {}).textContent || '',
    activeSwitch: Array.from(d.querySelectorAll('[data-switch-biz].active')).map((b) => b.getAttribute('data-switch-biz')),
    lastBiz: (() => { try { return win.localStorage.getItem('pjm.platform.lastBiz.v1'); } catch { return null; } })(),
    bizCards: Array.from(d.querySelectorAll('[data-biz]')).map((c) => c.getAttribute('data-biz')),
  };
}

function clickDom(entry, selector) {
  const el = entry.dom.window.document.querySelector(selector);
  if (!el) throw new Error(`找不到元素 ${selector}`);
  el.click();
}

function keydownDom(entry, key) {
  const ev = new entry.dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  entry.dom.window.document.dispatchEvent(ev);
}

function fireIframeLoad(entry) {
  const frame = entry.dom.window.document.getElementById('moduleFrame');
  if (!frame) throw new Error('找不到 #moduleFrame');
  frame.dispatchEvent(new entry.dom.window.Event('load', { bubbles: false }));
}

async function runDomChecks(r, extDir, state) {
  const ctx = resolveJsdom();
  if (!ctx) throw new Error(`找不到 jsdom（候选：${JSDOM_CANDIDATES.join('、')}）`);
  state.jsdomFrom = ctx.from;
  const fixture = createDomFixture(ctx, extDir);
  const entries = [];

  await r.check('J1', 'jsdom 载入平台壳：首页可见、四卡齐全（三业务 + 使用说明）、iframe 处于 about:blank', async () => {
    const entry = createDom(ctx, fixture, '');
    entries.push(entry);
    const s = domState(entry);
    expect(!s.landingHidden, `landing 应可见，实际 hidden=${s.landingHidden}`);
    expect(s.workspaceHidden, `workspace 初始应隐藏，实际 hidden=${s.workspaceHidden}`);
    expect(s.bizCards.slice().sort().join(',') === 'guide,patrol,radar,share', `业务卡片异常：${s.bizCards.join(',')}`);
    expect(s.frameSrc === 'about:blank', `iframe 初始 src=${s.frameSrc}，期望 about:blank`);
    return `title=${s.title} · 卡片=${s.bizCards.join('/')} · frame=${s.frameSrc}`;
  });

  const mainEntry = entries[0];

  await r.check('J2', '点击 [data-biz=patrol]：首页隐藏、工作区显示、iframe=modules/patrol/app.html、hash=#/patrol', async () => {
    clickDom(mainEntry, '[data-biz="patrol"]');
    const s = domState(mainEntry);
    expect(s.landingHidden, 'landing 未隐藏');
    expect(!s.workspaceHidden, 'workspace 未显示');
    expect(s.frameSrc === 'modules/patrol/app.html', `iframe src=${s.frameSrc}，期望 modules/patrol/app.html`);
    expect(s.hash === '#/patrol', `location.hash=${JSON.stringify(s.hash)}，期望 #/patrol`);
    expect(/价格巡检/.test(s.title), `document.title=${s.title}，应含「价格巡检」`);
    expect(s.crumb === '价格巡检', `面包屑=${JSON.stringify(s.crumb)}`);
    expect(s.lastBiz === 'patrol', `localStorage 记住的业务=${JSON.stringify(s.lastBiz)}`);
    expect(s.activeSwitch.join(',') === 'patrol', `高亮切换按钮=${s.activeSwitch.join(',')}`);
    return `iframe=${s.frameSrc} · hash=${s.hash} · title=${s.title}`;
  });

  await r.check('J3', 'iframe load 事件后遮罩消失（#frameMask.done）且状态显示「已就绪」', async () => {
    const before = domState(mainEntry);
    expect(!before.maskDone, '点击业务后遮罩不应已 done（模块尚未 load）');
    fireIframeLoad(mainEntry);
    const s = domState(mainEntry);
    expect(s.maskDone, '模拟 iframe load 后 #frameMask 未加 done 类');
    expect(/已就绪/.test(s.frameStateText), `#frameState 文本=${JSON.stringify(s.frameStateText)}`);
    return `mask.done=${s.maskDone} · frameState=${s.frameStateText}`;
  });

  await r.check('J4', '点击 [data-switch-biz=share]：iframe 切到 modules/share/app.html、hash=#/share、高亮与面包屑同步', async () => {
    clickDom(mainEntry, '[data-switch-biz="share"]');
    const s = domState(mainEntry);
    expect(!s.workspaceHidden, 'workspace 被隐藏');
    expect(s.frameSrc === 'modules/share/app.html', `iframe src=${s.frameSrc}，期望 modules/share/app.html`);
    expect(s.hash === '#/share', `location.hash=${JSON.stringify(s.hash)}，期望 #/share`);
    expect(s.crumb === '市场占有率', `面包屑=${JSON.stringify(s.crumb)}`);
    expect(s.activeSwitch.join(',') === 'share', `高亮切换按钮=${s.activeSwitch.join(',')}`);
    expect(s.lastBiz === 'share', `localStorage=${JSON.stringify(s.lastBiz)}`);
    return `iframe=${s.frameSrc} · hash=${s.hash} · 面包屑=${s.crumb}`;
  });

  await r.check('J5', '#openTabBtn 独立打开：调用 chrome.tabs.create 且 url 指向当前业务的模块页', async () => {
    mainEntry.tabsCalls.length = 0;
    clickDom(mainEntry, '#openTabBtn');
    expect(mainEntry.tabsCalls.length === 1, `chrome.tabs.create 调用次数=${mainEntry.tabsCalls.length}`);
    const url = String(mainEntry.tabsCalls[0].url || '');
    expect(url.endsWith('/modules/share/app.html'), `tabs.create url=${url}，期望以 /modules/share/app.html 结尾`);
    return `tabs.create({ url: '${url}' })`;
  });

  await r.check('J6', '点击 #backBtn：回到业务选择页、workspace 隐藏、iframe 释放为 about:blank、hash 清空', async () => {
    clickDom(mainEntry, '#backBtn');
    const s = domState(mainEntry);
    expect(!s.landingHidden, 'landing 未重新显示');
    expect(s.workspaceHidden, 'workspace 未隐藏');
    expect(s.frameSrc === 'about:blank', `iframe src=${s.frameSrc}，期望 about:blank`);
    expect(s.hash === '', `location.hash=${JSON.stringify(s.hash)}，期望空`);
    expect(s.title === '价格监控平台', `title=${s.title}`);
    expect(s.activeSwitch.length === 0, `切换按钮仍在高亮：${s.activeSwitch.join(',')}`);
    return `hash=${JSON.stringify(s.hash)} · frame=${s.frameSrc} · title=${s.title}`;
  });

  await r.check('J7', '键盘 3 进入竞品监控、Esc 返回首页', async () => {
    keydownDom(mainEntry, '3');
    let s = domState(mainEntry);
    expect(!s.workspaceHidden, '按 3 后 workspace 未显示');
    expect(s.frameSrc === 'modules/radar/app.html', `按 3 后 iframe=${s.frameSrc}`);
    expect(s.hash === '#/radar', `按 3 后 hash=${JSON.stringify(s.hash)}`);
    keydownDom(mainEntry, 'Escape');
    s = domState(mainEntry);
    expect(!s.landingHidden, 'Esc 后 landing 未显示');
    expect(s.workspaceHidden, 'Esc 后 workspace 未隐藏');
    expect(s.hash === '', `Esc 后 hash=${JSON.stringify(s.hash)}`);
    return '3 → radar · Esc → 首页';
  });

  await r.check('J8', '键盘 1 进入价格巡检', async () => {
    keydownDom(mainEntry, '1');
    const s = domState(mainEntry);
    expect(s.frameSrc === 'modules/patrol/app.html', `按 1 后 iframe=${s.frameSrc}`);
    expect(s.hash === '#/patrol', `按 1 后 hash=${JSON.stringify(s.hash)}`);
    return `iframe=${s.frameSrc} · hash=${s.hash}`;
  });

  await r.check('J9', '深链冷启动 #/radar：直接进入竞品监控（workspace 可见、iframe 正确、高亮正确）', async () => {
    const entry = createDom(ctx, fixture, '#/radar');
    entries.push(entry);
    const s = domState(entry);
    expect(!s.workspaceHidden, '深链 #/radar 未进入工作区');
    expect(s.landingHidden, '深链 #/radar 时 landing 仍显示');
    expect(s.frameSrc === 'modules/radar/app.html', `深链 iframe=${s.frameSrc}`);
    expect(s.hash === '#/radar', `深链 hash=${JSON.stringify(s.hash)}`);
    expect(s.activeSwitch.join(',') === 'radar', `深链高亮=${s.activeSwitch.join(',')}`);
    expect(/竞品监控/.test(s.title), `深链 title=${s.title}`);
    fireIframeLoad(entry);
    expect(domState(entry).maskDone, '深链场景模拟 iframe load 后遮罩未消失');
    return `iframe=${s.frameSrc} · hash=${s.hash} · title=${s.title}`;
  });

  await r.check('J11', '点击 [data-biz=guide]：iframe=guide.html、hash=#/guide、面包屑/标题/高亮同步、独立打开指向 guide.html、键盘 4 可进入', async () => {
    clickDom(mainEntry, '#backBtn'); // J8 之后在巡逻业务里，先回首页
    clickDom(mainEntry, '[data-biz="guide"]');
    let s = domState(mainEntry);
    expect(!s.workspaceHidden, '点击使用说明卡片后 workspace 未显示');
    expect(s.frameSrc === 'guide.html', `iframe src=${s.frameSrc}，期望 guide.html`);
    expect(s.hash === '#/guide', `hash=${JSON.stringify(s.hash)}，期望 #/guide`);
    expect(s.crumb === '使用说明', `面包屑=${JSON.stringify(s.crumb)}`);
    expect(/使用说明/.test(s.title), `title=${s.title}，应含「使用说明」`);
    expect(s.lastBiz === 'guide', `localStorage 记住的入口=${JSON.stringify(s.lastBiz)}`);
    expect(s.activeSwitch.join(',') === 'guide', `高亮切换按钮=${s.activeSwitch.join(',')}`);
    // 独立打开：chrome-extension://<id>/guide.html
    mainEntry.tabsCalls.length = 0;
    clickDom(mainEntry, '#openTabBtn');
    expect(mainEntry.tabsCalls.length === 1, `chrome.tabs.create 调用次数=${mainEntry.tabsCalls.length}`);
    const tabUrl = String(mainEntry.tabsCalls[0].url || '');
    expect(tabUrl.endsWith('/guide.html'), `tabs.create url=${tabUrl}，期望以 /guide.html 结尾`);
    // 顶部切换回首页后，键盘 4 也能进入使用说明
    clickDom(mainEntry, '#backBtn');
    keydownDom(mainEntry, '4');
    s = domState(mainEntry);
    expect(s.frameSrc === 'guide.html' && s.hash === '#/guide', `按 4 后 iframe=${s.frameSrc} · hash=${s.hash}`);
    return `iframe=${s.frameSrc} · hash=${s.hash} · 面包屑=${s.crumb} · tabs.create=${tabUrl} · 键盘 4 生效`;
  });

  await r.check('J12', '深链冷启动 #/guide：直接进入使用说明（workspace 可见、iframe=guide.html、高亮正确）', async () => {
    const entry = createDom(ctx, fixture, '#/guide');
    entries.push(entry);
    const s = domState(entry);
    expect(!s.workspaceHidden, '深链 #/guide 未进入工作区');
    expect(s.landingHidden, '深链 #/guide 时 landing 仍显示');
    expect(s.frameSrc === 'guide.html', `深链 iframe=${s.frameSrc}`);
    expect(s.hash === '#/guide', `深链 hash=${JSON.stringify(s.hash)}`);
    expect(s.activeSwitch.join(',') === 'guide', `深链高亮=${s.activeSwitch.join(',')}`);
    expect(/使用说明/.test(s.title), `深链 title=${s.title}`);
    fireIframeLoad(entry);
    expect(domState(entry).maskDone, '深链场景模拟 iframe load 后遮罩未消失');
    return `iframe=${s.frameSrc} · hash=${s.hash} · title=${s.title}`;
  });

  await r.check('J10', 'jsdom 运行期零异常（console.error / jsdomError）', async () => {
    const errs = entries.flatMap((e) => e.errors);
    expect(errs.length === 0, `${errs.length} 条：${errs.slice(0, 8).join(' | ')}`);
    return `${entries.length} 个页面实例 · 0 异常`;
  });
}


// ---------------------------------------------------------------------------
// 页面侧辅助（全部在同一扩展 origin 内求值）
// ---------------------------------------------------------------------------
async function cardsInfo(page) {
  return await page.evaluate(`(() => {
    const out = [];
    for (const el of document.querySelectorAll('[data-biz]')) {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      out.push({
        biz: el.getAttribute('data-biz'),
        text: (el.textContent || '').trim().slice(0, 60),
        visible: r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0',
      });
    }
    return out;
  })()`);
}

async function waitCardsVisible(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await cardsInfo(page);
      const vis = new Set(last.filter((c) => c.visible).map((c) => c.biz));
      if (ALL_CARD_IDS.every((b) => vis.has(b))) return last;
    } catch { /* 页面可能正在切换，继续等 */ }
    await sleep(250);
  }
  return last || [];
}

async function clickBizCard(page, biz) {
  return await page.evaluate(`(() => {
    const el = document.querySelector('[data-biz="${biz}"]');
    if (!el) return { ok: false, reason: '找不到 [data-biz="${biz}"]' };
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return { ok: false, reason: '卡片不可见（尺寸为 0）' };
    el.scrollIntoView({ block: 'center' });
    el.click();
    return { ok: true, text: (el.textContent || '').trim().slice(0, 40) };
  })()`);
}

/** 通用「点击」：先 data-* 选择器，再按可见文案（限短文本元素，优先 button/a/role=button）。 */
async function clickFirst(page, selectors, texts, extraSelector) {
  return await page.evaluate(`(() => {
    const selectors = ${JSON.stringify(selectors)};
    for (const sel of selectors) {
      let el = null;
      try { el = document.querySelector(sel); } catch { el = null; }
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0)) continue;
      el.scrollIntoView({ block: 'center' });
      el.click();
      return { ok: true, via: sel, text: (el.textContent || '').trim().slice(0, 40) };
    }
    const texts = ${JSON.stringify(texts)};
    const nodes = Array.from(document.querySelectorAll(${JSON.stringify(extraSelector || 'button, a, [role="button"], [role="tab"]')}));
    for (const el of nodes) {
      const t = (el.textContent || '').trim();
      if (!t || t.length > 24) continue;
      const r = el.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0)) continue;
      for (const want of texts) {
        if (t.includes(want)) {
          el.scrollIntoView({ block: 'center' });
          el.click();
          return { ok: true, via: 'text:' + want, text: t };
        }
      }
    }
    return { ok: false, reason: '未找到可点击元素', selectors, texts };
  })()`);
}

async function switchesInfo(page) {
  return await page.evaluate(`(() => {
    const out = [];
    for (const el of document.querySelectorAll('[data-switch-biz]')) {
      const r = el.getBoundingClientRect();
      out.push({
        biz: el.getAttribute('data-switch-biz'),
        text: (el.textContent || '').trim().slice(0, 30),
        visible: r.width > 0 && r.height > 0,
      });
    }
    return out;
  })()`);
}

async function moduleFrameInfo(page, biz) {
  const want = biz ? BIZ[biz].modulePage : '';
  return await page.evaluate(`(() => {
    const want = ${JSON.stringify(want)};
    const f = document.getElementById('moduleFrame');
    if (!f) return { exists: false };
    const src = f.getAttribute('src') || '';
    const absSrc = f.src || '';
    let doc = null;
    let accessError = '';
    try { doc = f.contentDocument; } catch (e) { accessError = String((e && e.message) || e); }
    const docUrl = doc && doc.URL ? String(doc.URL) : '';
    const text = doc && doc.body ? doc.body.innerText.trim() : '';
    const key = {
      tables: doc ? doc.querySelectorAll('table').length : -1,
      rows: doc ? doc.querySelectorAll('tbody tr').length : -1,
      buttons: doc ? doc.querySelectorAll('button').length : -1,
    };
    return {
      exists: true, src, absSrc, docUrl, accessError,
      docMatches: !!want && docUrl.includes(want),
      readyState: doc ? doc.readyState : '',
      title: doc ? doc.title : '',
      textLen: text.length,
      textHead: text.slice(0, 160),
      key,
      visible: (() => { const r = f.getBoundingClientRect(); return r.width > 0 && r.height > 0; })(),
    };
  })()`);
}

/**
 * 等 iframe#moduleFrame 里**当前文档**就是 modules/<biz>/app.html（看 doc.URL，不看 src 字面量），
 * 且文档 complete、正文非空。
 * 关键：只校验 src 字面量会在 iframe 导航开始时就通过（此时 contentDocument 还是上一个业务的旧文档）。
 */
async function waitModuleLoaded(page, biz, timeoutMs) {
  const want = BIZ[biz].modulePage;
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try { last = await moduleFrameInfo(page, biz); } catch { last = null; }
    if (last && last.exists && !last.accessError && last.docMatches
      && last.readyState === 'complete' && last.textLen > 20) {
      return last;
    }
    await sleep(200);
  }
  const why = !last ? '无法读取 iframe 状态'
    : !last.exists ? '页面上没有 #moduleFrame'
      : last.accessError ? `iframe 文档不可访问（可能被 sandbox/跨域隔离）：${last.accessError}`
        : !last.docMatches ? `iframe 当前文档 URL=${last.docUrl || '(空)'}，期望包含 ${want}（src=${last.src}）`
          : last.readyState !== 'complete' ? `iframe readyState=${last.readyState}（docUrl=${last.docUrl}）`
            : `iframe 正文过短（${last.textLen} 字符，docUrl=${last.docUrl}）`;
  throw new Error(`等待 modules/${biz}/app.html 首屏超时（${timeoutMs}ms）：${why}；最后状态=${oneLine(JSON.stringify(last), 500)}`);
}

/**
 * 轮询到 iframe 当前文档 URL 正确且文档就绪后，再断言首屏关键 DOM（不用固定 sleep）。
 */
async function waitModuleKeyDom(page, biz, timeoutMs) {
  const want = BIZ[biz].modulePage;
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await page.evaluate(`(() => {
        const want = ${JSON.stringify(want)};
        const selectors = ${JSON.stringify(BIZ[biz].keyDom)};
        const f = document.getElementById('moduleFrame');
        const doc = f && f.contentDocument;
        if (!doc) return { ok: false, phase: 'iframe 文档不可访问', docUrl: '' };
        const docUrl = String(doc.URL || '');
        if (!docUrl.includes(want)) return { ok: false, phase: 'iframe 仍在导航（文档 URL 未切换）', docUrl, readyState: doc.readyState };
        if (doc.readyState !== 'complete') return { ok: false, phase: 'iframe 文档未就绪', docUrl, readyState: doc.readyState };
        const found = [];
        for (const sel of selectors) {
          let el = null;
          try { el = doc.querySelector(sel); } catch { el = null; }
          if (!el) continue;
          const r = el.getBoundingClientRect();
          found.push({ sel, visible: r.width > 0 && r.height > 0 });
        }
        const text = doc.body ? doc.body.innerText.trim() : '';
        const key = {
          tables: doc.querySelectorAll('table').length,
          rows: doc.querySelectorAll('tbody tr').length,
          buttons: doc.querySelectorAll('button').length,
        };
        return {
          ok: found.length > 0 && found.some((x) => x.visible),
          found, key, docUrl, readyState: doc.readyState,
          textLen: text.length, title: doc.title, textHead: text.slice(0, 200),
        };
      })()`);
    } catch { last = null; }
    if (last && last.ok) return last;
    await sleep(200);
  }
  throw new Error(`等待「${BIZ[biz].label}」关键 DOM（${BIZ[biz].keyDom.join(' / ')}）超时（${timeoutMs}ms）：最后状态=${oneLine(JSON.stringify(last), 500)}`);
}

async function frameBox(page) {
  return await page.evaluate(`(() => {
    const f = document.getElementById('moduleFrame');
    if (!f) return null;
    const r = f.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  })()`);
}

async function waitMaskDone(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const done = await page.evaluate(`(() => { const m = document.getElementById('frameMask'); return !!m && m.classList.contains('done'); })()`);
      if (done) return true;
    } catch { /* 继续等 */ }
    await sleep(200);
  }
  return false;
}

/** 主动探测关键数据 JSON 是否 200（扩展自身资源，绕开模块内 fetch 时序）。 */
async function probeDataJson(page, extId, urls) {
  const out = [];
  for (const u of urls) {
    const r = await page.evaluate(`fetch('chrome-extension://${extId}/${u}', { cache: 'no-store' })
      .then(async (res) => ({ url: ${JSON.stringify(u)}, ok: res.ok, status: res.status, type: res.headers.get('content-type') || '', chars: (await res.text()).length }))
      .catch((e) => ({ url: ${JSON.stringify(u)}, ok: false, status: 0, error: String((e && e.message) || e) }))`);
    out.push(r);
  }
  const bad = out.filter((x) => !x.ok || x.status !== 200);
  if (bad.length) {
    throw new Error(`关键数据 JSON 非 200：${bad.map((x) => `${x.url} → status=${x.status}${x.error ? ' · ' + x.error : ''}`).join('；')}`);
  }
  return out.map((x) => `${x.url} → 200 (${x.chars} chars)`).join('；');
}

async function installNetworkMonitor(page, store) {
  const rec = { responses: [], failures: [], urls: new Map(), enabled: false };
  store.push(rec);
  try {
    await page.client.rpc('Network.enable', {}, 15000);
    rec.enabled = true;
  } catch { /* 老版本可能不支持，退化为 Log 收集 */ }
  page.client.on('Network.requestWillBeSent', (p) => {
    const url = (p && p.request && p.request.url) || '';
    if (url && rec.urls.size < 5000) rec.urls.set(p.requestId, url);
  });
  page.client.on('Network.responseReceived', (p) => {
    const res = (p && p.response) || {};
    rec.responses.push({
      seq: rec.responses.length,
      url: res.url || rec.urls.get(p.requestId) || '',
      status: res.status || 0,
      mime: res.mimeType || '',
      type: (p && p.type) || '',
    });
  });
  page.client.on('Network.loadingFailed', (p) => {
    rec.failures.push({
      seq: rec.failures.length,
      url: rec.urls.get(p.requestId) || '',
      errorText: (p && p.errorText) || '',
      type: (p && p.type) || '',
      canceled: !!(p && p.canceled),
    });
  });
  return rec;
}

function netMark(net) { return { res: net.responses.length, fail: net.failures.length }; }

function netSince(net, mark) {
  return {
    responses: net.responses.slice(mark.res),
    failures: net.failures.slice(mark.fail),
  };
}

/** 过滤出与某模块相关的网络问题（data/*.json 或 modules/<biz>/ 资源）。 */
function moduleNetProblems(net, mark, biz) {
  const since = netSince(net, mark);
  const modulePage = BIZ[biz].modulePage;
  const hit = (u) => String(u || '').includes(`/modules/${biz}/`) || String(u || '').includes(modulePage);
  const badResponses = since.responses.filter((x) => hit(x.url) && (x.status >= 400 || x.status === 0)
    && !/^(data|blob):/.test(x.url));
  const badFailures = since.failures.filter((x) => !x.canceled && hit(x.url));
  return { badResponses, badFailures };
}

async function waitHashModule(page, biz, timeoutMs) {
  // 统一用 doc.URL 判定（iframe 的 src 属性是相对路径，getAttribute 不能直接匹配绝对路径）
  return await waitModuleLoaded(page, biz, timeoutMs);
}

/**
 * 等 iframe#moduleFrame 里**当前文档**就是 guide.html（看 doc.URL），文档 complete、正文非空，
 * 并取回标题/小节/样式表信息，供 guide 断言复用。
 */
async function waitGuideDoc(page, timeoutMs) {
  const want = GUIDE.page;
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await page.evaluate(`(() => {
        const want = ${JSON.stringify(want)};
        const f = document.getElementById('moduleFrame');
        if (!f) return { ok: false, phase: '页面上没有 #moduleFrame' };
        let doc = null;
        try { doc = f.contentDocument; } catch (e) { return { ok: false, phase: 'iframe 文档不可访问：' + String((e && e.message) || e) }; }
        if (!doc) return { ok: false, phase: 'iframe 文档不可访问' };
        const docUrl = String(doc.URL || '');
        if (!docUrl.includes(want)) return { ok: false, phase: 'iframe 仍在导航（文档 URL 未切换）', docUrl, readyState: doc.readyState };
        if (doc.readyState !== 'complete') return { ok: false, phase: 'iframe 文档未就绪', docUrl, readyState: doc.readyState };
        const text = doc.body ? doc.body.innerText.trim() : '';
        const h1 = doc.querySelector('h1');
        const h2s = Array.from(doc.querySelectorAll('h2')).map((el) => (el.textContent || '').trim());
        const sheets = Array.from(doc.styleSheets || []).map((s) => String(s.href || ''));
        const inlineScripts = Array.from(doc.querySelectorAll('script:not([src])')).filter((s) => (s.textContent || '').trim().length > 0).length;
        const handlers = [];
        for (const el of doc.querySelectorAll('*')) {
          for (const a of Array.from(el.attributes || [])) if (/^on[a-z]+$/i.test(a.name)) handlers.push(el.tagName + '[' + a.name + ']');
        }
        const remote = doc.querySelectorAll('link[href^="http"], script[src^="http"], img[src^="http"], iframe[src^="http"]').length;
        return {
          ok: text.length > 200 && h1 && h2s.length >= 5,
          docUrl, readyState: doc.readyState, textLen: text.length,
          h1: h1 ? (h1.textContent || '').trim() : '', h2s, sheets,
          inlineScripts, handlers: handlers.slice(0, 5), remote,
          hasTitle: !!doc.querySelector('title'),
        };
      })()`);
    } catch { last = null; }
    if (last && last.ok) return last;
    await sleep(200);
  }
  throw new Error(`等待 guide.html 首屏超时（${timeoutMs}ms）：最后状态=${oneLine(JSON.stringify(last), 400)}`);
}

async function reloadPage(page, timeoutMs = 30000) {
  const loaded = new Promise((resolve) => {
    const off = page.client.on('Page.loadEventFired', () => { off(); resolve(); });
    setTimeout(() => { off(); resolve(); }, timeoutMs);
  });
  await page.client.rpc('Page.reload', { ignoreCache: true }, timeoutMs);
  await loaded;
  await sleep(1800);
}

async function listPageTargets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(4000) });
  const list = await res.json();
  return list.filter((t) => t.type === 'page');
}

async function closeTarget(port, targetId) {
  try {
    const ver = await waitForCdp(port, 5000);
    const c = new CdpClient(ver.webSocketDebuggerUrl);
    await c.connect(5000);
    try { await c.rpc('Target.closeTarget', { targetId }, 5000); } finally { c.close(); }
  } catch { /* 关不掉也无妨：整个浏览器稍后会 close() */ }
}

// ---------------------------------------------------------------------------
// 平台验收主流程
// ---------------------------------------------------------------------------
async function verifyPlatform(opts, r, state) {
  const extDir = opts.ext;
  const pageUrlBase = () => `chrome-extension://${state.extId}/app.html`;

  // 静态检查（即使失败也继续跑浏览器侧，方便一次看全）
  await runStaticChecks(r, extDir);
  if (opts.staticOnly) return;

  let browser = null;
  let page = null;
  let newTabSession = null;
  let newTabTargetId = '';
  try {
    // ---- B1 启动 ----
    await r.check('B1', `启动 headless Edge 并加载扩展：${extDir}`, async () => {
      const ext = fs.existsSync(path.join(extDir, 'manifest.json')) ? extDir : null;
      try {
        browser = await launchBrowser({
          extDir: ext, width: VIEWPORT.width, height: VIEWPORT.height,
          browser: opts.browser || undefined, port: opts.port || undefined,
        });
      } catch (err) {
        throw new Error(`${err.message}（提示：extDir=${extDir}）`);
      }
      state.env.browserPath = findBrowser();
      state.env.browserVersion = browser.version && browser.version.Browser;
      state.env.cdpPort = browser.port;
      return `CDP ${browser.port} · ${state.env.browserVersion || 'Edge'} · extDir=${ext}`;
    });

    // ---- B2 扩展 ID ----
    await r.check('B2', '扩展加载成功且定位到本扩展 ID（background service worker 存在）', async () => {
      expect(browser, '浏览器未启动（B1 失败），无法定位扩展 ID');
      try {
        const override = opts.extId || process.env.DS_EXT_ID || '';
        state.extId = override || await findExtensionId(browser.port, 25000);
      } catch (err) {
        // 兜底：按路径推导（仅用于报错信息，不掩盖问题）
        const variants = deriveExtensionIdVariants(extDir);
        throw new Error(`${err.message}；按路径推导的候选 ID：${[...variants.entries()].map(([k, v]) => `${k}=${v}`).join(', ')}`);
      }
      expect(/^[a-p]{32}$/.test(state.extId), `扩展 ID 格式异常：${state.extId}`);
      const variants = deriveExtensionIdVariants(extDir);
      const matched = [...variants.entries()].find(([, v]) => v === state.extId);
      state.env.extIdDerived = matched ? `${matched[0]}=${matched[1]}` : null;
      return `extId=${state.extId}${matched ? `（与路径推导 ${matched[0]} 一致）` : '（未匹配路径推导变体，仅记录）'}`;
    });

    // ---- B3 打开 app.html ----
    await r.check('B3', `打开 ${pageUrlBase()} 并完成首屏`, async () => {
      expect(browser, '浏览器未启动（B1 失败），无法打开 app.html');
      const target = await findPageTarget(browser.port, 10000);
      page = await new PageSession(target.wsUrl).connect();
      state.net = [];
      state.netMain = await installNetworkMonitor(page, state.net);
      await page.setViewport(VIEWPORT.width, VIEWPORT.height);
      r.setPage(page);
      await page.navigate(pageUrlBase(), { settleMs: 2500 });
      let info = null;
      try {
        info = await page.waitFor(`document.readyState === 'complete' && document.body && document.body.innerText.trim().length > 20`, { timeoutMs: opts.timeoutMs, label: '平台首屏' });
      } catch { /* 下面统一抛错 */ }
      const diag = await page.evaluate(`(() => ({
        readyState: document.readyState,
        title: document.title,
        bodyLen: document.body ? document.body.innerText.trim().length : 0,
        bodyHead: document.body ? document.body.innerText.trim().slice(0, 200) : '',
      }))()`);
      state.home = diag;
      expect(diag.readyState === 'complete', `readyState=${diag.readyState}`);
      expect(diag.bodyLen > 20, `页面正文过短（${diag.bodyLen} 字符），bodyHead=${oneLine(diag.bodyHead)}`);
      expect(diag.title.trim().length > 0, 'document.title 为空');
      return `title=${diag.title} · readyState=${diag.readyState} · body=${diag.bodyLen} 字符`;
    });

    // ---- B4 首页四卡片（三业务 + 使用说明） ----
    if (!page) {
      r.note('B1/B3 未通过：浏览器或页面未就绪，B4 之后的 E2E 断言（模块加载、切换、独立标签页、深链、console/网络汇总）未执行。');
      return;
    }
    let homeCards = [];
    await r.check('B4', '业务选择页：四张卡片 [data-biz=patrol|share|radar|guide] 齐全且可见 +「选择业务」文案', async () => {
      homeCards = await waitCardsVisible(page, opts.timeoutMs);
      const visible = new Set(homeCards.filter((c) => c.visible).map((c) => c.biz));
      const missing = ALL_CARD_IDS.filter((b) => !visible.has(b));
      expect(missing.length === 0, `缺失/不可见：${missing.join('、')}；实际卡片=${oneLine(JSON.stringify(homeCards), 400)}`);
      const hero = await page.evaluate(`(() => {
        const el = document.querySelector('#landing .hero h1') || document.querySelector('#landing h1');
        return el ? (el.textContent || '').trim() : '';
      })()`);
      expect(/选择业务/.test(hero), `#landing 的 h1=${JSON.stringify(hero)}，应含「选择业务」`);
      return `${homeCards.filter((c) => c.visible).map((c) => `${c.biz}「${oneLine(c.text, 24)}」`).join(' · ')} · h1=${hero}`;
    });

    // ---- B5 首页无内联脚本 / 内联事件 ----
    await r.check('B5', '平台页无内联脚本与内联事件处理器（MV3 CSP）', async () => {
      const info = await page.evaluate(`(() => {
        const inline = Array.from(document.querySelectorAll('script:not([src])')).filter((s) => (s.textContent || '').trim().length > 0);
        const handlers = [];
        for (const el of document.querySelectorAll('*')) {
          for (const a of Array.from(el.attributes || [])) {
            if (/^on[a-z]+$/i.test(a.name)) handlers.push(el.tagName + '[' + a.name + ']');
          }
        }
        return { inline: inline.length, handlers: handlers.slice(0, 10) };
      })()`);
      expect(info.inline === 0, `发现 ${info.inline} 个内联 script`);
      expect(info.handlers.length === 0, `发现内联事件处理器：${info.handlers.join(', ')}`);
      return 'inline script 0 · inline handler 0';
    });

    // ---- B6 首页截图 ----
    await r.check('B6', '首页截图 01-platform-home-1440.png', async () => {
      await r.shot('01-platform-home-1440.png', '业务选择页（首页）');
      return 'qa/shots/01-platform-home-1440.png';
    });

    // ---- B7 首页 console 零 error ----
    const consoleMarkHome = page.consoleErrors.length;
    await r.check('B7', '首页无 console error（允许 warning）', async () => {
      const { benign, real } = splitConsoleErrors(page, page.consoleErrors.slice(consoleMarkHome), state.net);
      expect(real.length === 0, `最近 ${real.length} 条 error：${real.slice(0, 8).join(' | ')}${benign.length ? `（另有 ${benign.length} 条已知可接受）` : ''}`);
      return `console error 0${benign.length ? `（过滤已知可接受 ${benign.length} 条）` : ''}（累计 ${page.consoleErrors.length}）`;
    });

    // ------------------------------------------------------------------
    // 模块验收：patrol 通过首页卡片进入；share/radar 通过 [data-switch-biz] 切换
    // ------------------------------------------------------------------
    const moduleMarks = {};
    let currentBiz = null;

    for (const biz of BIZ_IDS) {
      const entryMark = { console: page.consoleErrors.length, net: netMark(state.netMain) };
      moduleMarks[biz] = entryMark;
      let via = '';

      if (biz === 'patrol') {
        await r.check(`M-${biz}-enter`, `点击首页业务卡片进入「${BIZ[biz].label}」`, async () => {
          const clicked = await clickBizCard(page, biz);
          expect(clicked && clicked.ok, `点击失败：${oneLine(JSON.stringify(clicked))}`);
          via = `card [data-biz="${biz}"]「${clicked.text}」`;
          return via;
        });
      } else {
        await r.check(`M-${biz}-enter`, `用顶部切换按钮 [data-switch-biz="${biz}"] 切到「${BIZ[biz].label}」`, async () => {
          const all = await switchesInfo(page);
          const target = all.find((x) => x.biz === biz);
          expect(target, `找不到 [data-switch-biz="${biz}"]（现有：${oneLine(JSON.stringify(all))}）`);
          const clicked = await page.evaluate(`(() => {
            const el = document.querySelector('[data-switch-biz="${biz}"]');
            if (!el) return { ok: false };
            const r = el.getBoundingClientRect();
            if (!(r.width > 0 && r.height > 0)) return { ok: false, reason: '按钮不可见' };
            el.click();
            return { ok: true, text: (el.textContent || '').trim().slice(0, 30) };
          })()`);
          expect(clicked && clicked.ok, `点击失败：${oneLine(JSON.stringify(clicked))}`);
          via = `[data-switch-biz="${biz}"]「${clicked.text}」`;
          return via;
        });
      }
      if (r.results[r.results.length - 1].ok) currentBiz = biz;

      // M-<biz>-1：iframe 加载
      await r.check(`M-${biz}-1`, `iframe#moduleFrame 加载 ${BIZ[biz].modulePage}`, async () => {
        const info = await waitModuleLoaded(page, biz, opts.timeoutMs);
        return `src=${info.src} · docUrl=${info.docUrl} · readyState=${info.readyState} · text=${info.textLen} · tables=${info.key.tables}/rows=${info.key.rows}`;
      });

      // M-<biz>-2：首屏关键 DOM（轮询到 iframe 当前文档切到本业务且就绪后再查）
      await r.check(`M-${biz}-2`, `「${BIZ[biz].label}」首屏关键 DOM 渲染（${BIZ[biz].keyDom.join(' / ')}）`, async () => {
        const info = await waitModuleKeyDom(page, biz, opts.timeoutMs);
        return `命中 ${info.found.map((f) => `${f.sel}${f.visible ? '' : '(不可见)'}`).join(', ')} · docUrl=${info.docUrl} · text=${info.textLen} · tables=${info.key.tables} rows=${info.key.rows} · title=${info.title}`;
      });

      // M-<biz>-2b：iframe 尺寸合理（防 CSS/高度塌陷）
      await r.check(`M-${biz}-2b`, `「${BIZ[biz].label}」iframe 尺寸合理（宽 ≥1000、高 ≥400）`, async () => {
        const box = await frameBox(page);
        expect(box, '找不到 #moduleFrame');
        expect(box.w >= 1000 && box.h >= 400, `iframe 尺寸 ${box.w}x${box.h}（视口 1440x900）`);
        return `${box.w}x${box.h}`;
      });

      // M-<biz>-2c：遮罩消失（#frameMask.done）
      await r.check(`M-${biz}-2c`, `「${BIZ[biz].label}」加载遮罩已消失（#frameMask.done）`, async () => {
        const done = await waitMaskDone(page, 8000);
        expect(done, '#frameMask 8s 内仍未加 done 类（遮罩可能卡住）');
        return 'mask.done=true';
      });

      // M-<biz>-3：关键数据 JSON 200
      await r.check(`M-${biz}-3`, `「${BIZ[biz].label}」关键数据 JSON 均 200`, async () => {
        return await probeDataJson(page, state.extId, BIZ[biz].dataJson);
      });

      // M-<biz>-4：截图
      await r.check(`M-${biz}-4`, `「${BIZ[biz].label}」截图 ${BIZ[biz].shot}`, async () => {
        await r.shot(BIZ[biz].shot, `${BIZ[biz].label}首屏（进入方式：${via}）`);
        return `qa/shots/${BIZ[biz].shot}`;
      });

      // M-<biz>-5：该阶段 console 零 error
      await r.check(`M-${biz}-5`, `「${BIZ[biz].label}」阶段 console 零 error`, async () => {
        const { benign, real } = splitConsoleErrors(page, page.consoleErrors.slice(entryMark.console), state.net);
        expect(real.length === 0, `${real.length} 条 error：${real.slice(0, 8).join(' | ')}${benign.length ? `（另有 ${benign.length} 条已知可接受）` : ''}`);
        return `0${benign.length ? `（过滤已知可接受 ${benign.length} 条）` : ''}（页面累计 ${page.consoleErrors.length}）`;
      });

      // M-<biz>-6：该阶段关键网络资源无 4xx/5xx/失败
      await r.check(`M-${biz}-6`, `「${BIZ[biz].label}」阶段关键资源无 4xx/5xx/加载失败`, async () => {
        const { badResponses, badFailures } = moduleNetProblems(state.netMain, entryMark.net, biz);
        const raw = [];
        for (const x of badResponses) raw.push(`${x.url} → HTTP ${x.status}`);
        for (const x of badFailures) raw.push(`${x.url || '(未知URL)'} → ${x.errorText}`);
        const { benign, real } = partitionBenignNet(raw);
        expect(real.length === 0, real.slice(0, 8).join(' | '));
        return `关键资源全部正常（data json 已另测）${benign.length ? `；过滤已知可接受 ${benign.length} 条` : ''}`;
      });
    }

    // ---- D1 四个切换按钮齐全（三业务 + 使用说明） ----
    await r.check('D1', '顶部业务切换按钮 [data-switch-biz] 四个入口齐全（三业务 + 使用说明）', async () => {
      const all = await switchesInfo(page);
      const missing = ALL_CARD_IDS.filter((b) => !all.some((x) => x.biz === b && x.visible));
      expect(missing.length === 0, `缺失/不可见：${missing.join('、')}；实际=${oneLine(JSON.stringify(all))}`);
      return all.map((x) => `${x.biz}「${oneLine(x.text, 16)}」`).join(' · ');
    });

    // ---- D2 返回首页 ----
    let homeClick = null;
    await r.check('D2', '返回首页：回到业务选择页（四张卡片重新可见）', async () => {
      homeClick = await clickFirst(page, HOME_SELECTORS, HOME_TEXTS, 'button, a, [role="button"], [role="tab"]');
      expect(homeClick && homeClick.ok, `未找到返回首页入口：${oneLine(JSON.stringify(homeClick))}`);
      const cards = await waitCardsVisible(page, opts.timeoutMs);
      const visible = new Set(cards.filter((c) => c.visible).map((c) => c.biz));
      const missing = ALL_CARD_IDS.filter((b) => !visible.has(b));
      expect(missing.length === 0, `返回后卡片缺失：${missing.join('、')}（点击方式：${homeClick.via}）`);
      return `点击方式=${homeClick.via}「${homeClick.text}」`;
    });

    // ---- D2 shot ----
    await r.check('D2b', '返回首页截图 06-platform-home-back-1440.png', async () => {
      await r.shot('06-platform-home-back-1440.png', '从业务返回首页');
      return 'qa/shots/06-platform-home-back-1440.png';
    });

    // ---- D3 首页再次进入 share（首页 ↔ 业务切换） ----
    await r.check('D3', '从首页重新进入「市占率」（首页↔业务切换往返）', async () => {
      const clicked = await clickBizCard(page, 'share');
      expect(clicked && clicked.ok, `点击失败：${oneLine(JSON.stringify(clicked))}`);
      const info = await waitModuleLoaded(page, 'share', opts.timeoutMs);
      return `iframe docUrl=${info.docUrl} · text=${info.textLen}`;
    });

    // ---- D4 独立标签页打开（产品设计：直接打开当前业务模块页 modules/<biz>/app.html，不带平台导航条） ----
    await r.check('D4', '独立标签页打开：新标签页直接打开当前业务模块页且首屏渲染正常', async () => {
      const before = await listPageTargets(browser.port);
      const beforeIds = new Set(before.map((t) => t.id));
      const clicked = await clickFirst(page, NEWTAB_SELECTORS, NEWTAB_TEXTS, 'button, a, [role="button"]');
      expect(clicked && clicked.ok, `未找到独立标签页按钮：${oneLine(JSON.stringify(clicked))}`);
      // 等新 target：URL 直接是 modules/<biz>/app.html
      const deadline = Date.now() + 20000;
      let target = null;
      let lastList = [];
      while (Date.now() < deadline) {
        lastList = await listPageTargets(browser.port);
        target = lastList.find((t) => !beforeIds.has(t.id) && /\/modules\/(patrol|share|radar)\/app\.html/.test(t.url || ''));
        if (target) break;
        await sleep(300);
      }
      expect(target, `20s 内没有出现模块页 target（点击方式：${clicked.via}）；当前 target：${oneLine(lastList.map((t) => t.url).join(' | '), 300)}`);
      const bizInTab = (target.url.match(/modules\/(patrol|share|radar)\/app\.html/) || [])[1] || '';
      expect(bizInTab && BIZ[bizInTab], `新标签页 URL 未匹配模块页：${target.url}`);
      newTabTargetId = target.id;
      newTabSession = await new PageSession(target.webSocketDebuggerUrl).connect();
      state.netNewTab = await installNetworkMonitor(newTabSession, state.net);
      await newTabSession.setViewport(VIEWPORT.width, VIEWPORT.height);
      // 独立页本身就是模块页：等文档就绪 + 正文非空 + 关键 DOM 命中
      const keyDomJson = JSON.stringify(BIZ[bizInTab].keyDom);
      await newTabSession.waitFor(`(() => {
        if (document.readyState !== 'complete') return false;
        const text = document.body ? document.body.innerText.trim() : '';
        if (text.length <= 20) return false;
        return ${keyDomJson}.some((sel) => { try { return !!document.querySelector(sel); } catch { return false; } });
      })()`, { timeoutMs: opts.timeoutMs, label: `独立标签页模块页首屏（${bizInTab}）` });
      const info = await newTabSession.evaluate(`(() => {
        const selectors = ${keyDomJson};
        return {
          url: location.href,
          title: document.title,
          textLen: document.body ? document.body.innerText.trim().length : 0,
          hit: selectors.filter((sel) => { try { return !!document.querySelector(sel); } catch { return false; } }),
          tables: document.querySelectorAll('table').length,
          rows: document.querySelectorAll('tbody tr').length,
        };
      })()`);
      expect(info.textLen > 20, `独立标签页正文过短（${info.textLen}）`);
      state.newTab = { url: info.url, title: info.title, biz: bizInTab };
      const shotName = `05-independent-tab-${bizInTab}-1440.png`;
      const shotPath = path.join(SHOTS_DIR, shotName);
      await newTabSession.screenshot(shotPath);
      r.shots.push({ name: shotName, path: shotPath, note: `独立标签页（${info.url}）` });
      console.log(`[shot] ${shotPath}`);
      const { benign, real } = splitConsoleErrors(newTabSession, newTabSession.consoleErrors.slice(), state.net);
      expect(real.length === 0, `独立标签页 console error ${real.length} 条：${real.slice(0, 6).join(' | ')}`);
      return `点击=${clicked.via} · 新标签页=${info.url} · biz=${bizInTab} · title=${info.title} · text=${info.textLen} · 命中=${info.hit.join(',')} · tables=${info.tables}/rows=${info.rows}${benign.length ? ` · 过滤已知可接受 ${benign.length}` : ''}`;
    });

    // D4 关闭独立标签页（不影响主页面）
    if (state.newTab) {
      await closeTarget(browser.port, newTabTargetId || '');
      try { newTabSession?.close(); } catch { /* ignore */ }
      newTabSession = null;
    }

    // ---- D3b 浏览器后退（产品修复点）：后退 1 次回到上一个业务，后退 2 次回到业务选择首页 ----
    await r.check('D3b', '浏览器后退：1 次回到上一个业务（iframe 正文非空），2 次回到业务选择首页（四卡片）', async () => {
      const consoleBefore = page.consoleErrors.length;

      // 先构造标准历史：首页 → 价格巡检 → 市占率
      const homeClick2 = await clickFirst(page, HOME_SELECTORS, HOME_TEXTS, 'button, a, [role="button"], [role="tab"]');
      expect(homeClick2 && homeClick2.ok, `构造后退场景时未找到返回首页入口：${oneLine(JSON.stringify(homeClick2))}`);
      await waitCardsVisible(page, opts.timeoutMs);
      const cardClick = await clickBizCard(page, 'patrol');
      expect(cardClick && cardClick.ok, `构造后退场景时点击 patrol 卡片失败：${oneLine(JSON.stringify(cardClick))}`);
      await waitModuleLoaded(page, 'patrol', opts.timeoutMs);
      const switchClick = await page.evaluate(`(() => {
        const el = document.querySelector('[data-switch-biz="share"]');
        if (!el) return { ok: false };
        el.click();
        return { ok: true };
      })()`);
      expect(switchClick && switchClick.ok, '构造后退场景时找不到 [data-switch-biz="share"]');
      await waitModuleLoaded(page, 'share', opts.timeoutMs);

      // ---- 后退 1 次：应回到上一个业务「价格巡检」 ----
      await page.evaluate('history.back()');
      const deadline1 = Date.now() + opts.timeoutMs;
      let hash1 = '';
      let patrolInfo = null;
      while (Date.now() < deadline1) {
        hash1 = await page.evaluate('location.hash || ""');
        try { patrolInfo = await waitModuleLoaded(page, 'patrol', 3000); } catch { patrolInfo = null; }
        if (hash1 === '#/patrol' && patrolInfo) break;
        await sleep(300);
      }
      expect(hash1 === '#/patrol', `后退 1 次后 top hash=${JSON.stringify(hash1)}，期望 "#/patrol"`);
      expect(patrolInfo && patrolInfo.textLen > 20, `后退 1 次后巡检 iframe 正文为空/未加载：${oneLine(JSON.stringify(patrolInfo), 400)}`);
      await r.shot('08-history-back-1440.png', '后退 1 次：回到上一个业务「价格巡检」（无白屏）');
      const state1 = await page.evaluate(`(() => {
        const ws = document.getElementById('workspace');
        const crumb = document.getElementById('crumbBiz');
        return { workspaceVisible: !!ws && !ws.classList.contains('hidden'), crumb: crumb ? crumb.textContent : '' };
      })()`);
      expect(state1.workspaceVisible, '后退 1 次后工作区不可见');
      expect(/价格巡检/.test(state1.crumb || ''), `后退 1 次后面包屑=${JSON.stringify(state1.crumb)}，期望「价格巡检」`);

      // ---- 后退 2 次：应回到业务选择首页，四卡片可见 ----
      await page.evaluate('history.back()');
      const cards2 = await waitCardsVisible(page, opts.timeoutMs);
      const visible2 = new Set(cards2.filter((c) => c.visible).map((c) => c.biz));
      const missing2 = ALL_CARD_IDS.filter((b) => !visible2.has(b));
      expect(missing2.length === 0, `后退 2 次后卡片缺失：${missing2.join('、')}（实际：${oneLine(JSON.stringify(cards2))}）`);
      const homeInfo = await page.evaluate(`(() => {
        const landing = document.getElementById('landing');
        const f = document.getElementById('moduleFrame');
        let frameUrl = '';
        try { frameUrl = f && f.contentWindow ? String(f.contentWindow.location.href || '') : ''; } catch { frameUrl = ''; }
        return {
          hash: location.hash || '',
          landingVisible: !!landing && !landing.classList.contains('hidden'),
          title: document.title,
          frameUrl,
        };
      })()`);
      expect(homeInfo.hash === '', `后退 2 次后 top hash=${JSON.stringify(homeInfo.hash)}，期望空`);
      expect(homeInfo.landingVisible, '后退 2 次后首页未显示');
      expect(!/\/modules\//.test(homeInfo.frameUrl), `后退 2 次后 iframe 仍加载业务页：${homeInfo.frameUrl}`);
      expect(/价格监控平台/.test(homeInfo.title), `后退 2 次后 title=${homeInfo.title}`);
      await r.shot('08b-history-back-home-1440.png', '后退 2 次：回到业务选择首页（四卡片可见）');

      const { benign, real } = splitConsoleErrors(page, page.consoleErrors.slice(consoleBefore), state.net);
      expect(real.length === 0, `后退阶段新增 ${real.length} 条 console error：${real.slice(0, 5).join(' | ')}${benign.length ? `（另有 ${benign.length} 条已知可接受）` : ''}`);
      return `后退 1 次 → hash=#/patrol · 巡检正文 ${patrolInfo.textLen} 字符；后退 2 次 → 首页四卡片可见 · iframe=${homeInfo.frameUrl || 'about:blank'}`;
    });

    // ---- D5 深链冷启动 ----
    const deeplinkMark = { console: page.consoleErrors.length, net: netMark(state.netMain) };
    await r.check('D5', '深链 #/patrol 冷启动：直接打开 app.html#/patrol 落在巡检业务', async () => {
      await page.navigate('about:blank', { settleMs: 300 });
      await page.navigate(pageUrlBase() + '#/patrol', { settleMs: 2500 });
      await waitHashModule(page, 'patrol', opts.timeoutMs);
      const hash = await page.evaluate('location.hash || ""');
      expect(hash === '#/patrol', `location.hash=${JSON.stringify(hash)}，期望 "#/patrol"`);
      const info = await moduleFrameInfo(page);
      return `hash=${hash} · iframe docUrl=${info.docUrl} · text=${info.textLen}`;
    });

    await r.check('D5b', '深链截图 07-deeplink-patrol-1440.png', async () => {
      await r.shot('07-deeplink-patrol-1440.png', '深链 #/patrol 冷启动');
      return 'qa/shots/07-deeplink-patrol-1440.png';
    });

    // ---- D6 刷新后深链仍在 ----
    await r.check('D6', '刷新后深链 #/patrol 仍落在巡检业务', async () => {
      await reloadPage(page);
      await waitHashModule(page, 'patrol', opts.timeoutMs);
      const hash = await page.evaluate('location.hash || ""');
      expect(hash === '#/patrol', `刷新后 location.hash=${JSON.stringify(hash)}，期望 "#/patrol"`);
      const info = await moduleFrameInfo(page);
      return `刷新后 hash=${hash} · iframe docUrl=${info.docUrl} · text=${info.textLen}`;
    });

    // ---- D7 深链阶段 console / 网络 ----
    await r.check('D7', '深链+刷新阶段 console 零 error、无关键资源失败', async () => {
      const { benign, real } = splitConsoleErrors(page, page.consoleErrors.slice(deeplinkMark.console), state.net);
      const { badResponses, badFailures } = moduleNetProblems(state.netMain, deeplinkMark.net, 'patrol');
      const rawNet = [
        ...badResponses.map((x) => `${x.url} → HTTP ${x.status}`),
        ...badFailures.map((x) => `${x.url || '(未知URL)'} → ${x.errorText}`),
      ];
      const { benign: benignNet, real: realNet } = partitionBenignNet(rawNet);
      expect(real.length === 0 && realNet.length === 0,
        `console error ${real.length} 条：${real.slice(0, 6).join(' | ')}；网络问题：${realNet.slice(0, 6).join(' | ')}`);
      const filtered = benign.length + benignNet.length;
      return `console error 0 · 网络问题 0${filtered ? `（过滤已知可接受 ${filtered} 条）` : ''}`;
    });

    // ------------------------------------------------------------------
    // G1~G5：第 4 个入口「使用说明」（guide.html）
    // ------------------------------------------------------------------
    const guideMark = { console: page.consoleErrors.length, net: netMark(state.netMain) };
    let guideInFrame = null;

    await r.check('G1', '首页点击 [data-biz=guide] 卡片进入「使用说明」：iframe 文档为 guide.html，面包屑/标题/高亮同步', async () => {
      const home = await clickFirst(page, HOME_SELECTORS, HOME_TEXTS, 'button, a, [role="button"], [role="tab"]');
      expect(home && home.ok, `构造使用说明场景时未找到返回首页入口：${oneLine(JSON.stringify(home))}`);
      await waitCardsVisible(page, opts.timeoutMs);
      const clicked = await clickBizCard(page, 'guide');
      expect(clicked && clicked.ok, `点击使用说明卡片失败：${oneLine(JSON.stringify(clicked))}`);
      guideInFrame = await waitGuideDoc(page, opts.timeoutMs);
      const ui = await page.evaluate(`(() => {
        const landing = document.getElementById('landing');
        const ws = document.getElementById('workspace');
        const crumb = document.getElementById('crumbBiz');
        const active = Array.from(document.querySelectorAll('[data-switch-biz].active')).map((b) => b.getAttribute('data-switch-biz'));
        return {
          hash: location.hash || '',
          title: document.title,
          landingHidden: !!landing && landing.classList.contains('hidden'),
          workspaceVisible: !!ws && !ws.classList.contains('hidden'),
          crumb: crumb ? crumb.textContent : '',
          active,
          frameState: (document.getElementById('frameState') || {}).textContent || '',
          lastBiz: (() => { try { return localStorage.getItem('pjm.platform.lastBiz.v1'); } catch { return null; } })(),
        };
      })()`);
      expect(ui.hash === '#/guide', `location.hash=${JSON.stringify(ui.hash)}，期望 "#/guide"`);
      expect(ui.landingHidden, '进入使用说明后首页未隐藏');
      expect(ui.workspaceVisible, '进入使用说明后工作区未显示');
      expect(ui.crumb === '使用说明', `顶部面包屑=${JSON.stringify(ui.crumb)}`);
      expect(/使用说明/.test(ui.title), `document.title=${JSON.stringify(ui.title)}，应含「使用说明」`);
      expect(ui.active.join(',') === 'guide', `高亮切换按钮=${ui.active.join(',')}`);
      expect(ui.lastBiz === 'guide', `localStorage 记住的入口=${JSON.stringify(ui.lastBiz)}，期望 guide`);
      expect(/已就绪/.test(ui.frameState), `#frameState=${JSON.stringify(ui.frameState)}`);
      return `点击卡片「${oneLine(clicked.text, 20)}」→ iframe docUrl=${guideInFrame.docUrl} · hash=${ui.hash} · 面包屑=${ui.crumb} · 正文 ${guideInFrame.textLen} 字符`;
    });

    await r.check('G2', '使用说明页内容检查：h1=使用说明、7 个小节标题齐全、guide.css 生效、无内联脚本/事件/远程资源', async () => {
      if (!guideInFrame) throw new Error('G1 未拿到 guide.html 文档，跳过内容检查');
      const doc = guideInFrame;
      expect(/使用说明/.test(doc.h1), `guide.html 的 h1=${JSON.stringify(doc.h1)}，应含「使用说明」`);
      const h2Text = doc.h2s.join(' | ');
      const miss = GUIDE.heads.filter((t) => !h2Text.includes(t));
      expect(miss.length === 0, `缺少小节：${miss.join('、')}（实际 h2：${oneLine(h2Text, 400)}）`);
      expect(doc.sheets.some((u) => /\/guide\.css$/i.test(u)), `guide.css 未加载；styleSheets=${oneLine(JSON.stringify(doc.sheets), 300)}`);
      expect(doc.inlineScripts === 0, `guide.html 含 ${doc.inlineScripts} 个内联 script（MV3 CSP 会拦截）`);
      expect(doc.handlers.length === 0, `guide.html 含内联事件处理器：${doc.handlers.join(', ')}`);
      expect(doc.remote === 0, `guide.html 引用了 ${doc.remote} 个远程资源`);
      return `h1=${doc.h1} · h2 ${doc.h2s.length} 个（${doc.h2s.map((s) => oneLine(s, 18)).join(' / ')}）· 正文 ${doc.textLen} 字符 · CSS 已加载 · CSP 干净`;
    });

    await r.check('G3', '深链 #/guide 冷启动：直接打开 app.html#/guide 落在使用说明', async () => {
      await page.navigate('about:blank', { settleMs: 300 });
      await page.navigate(pageUrlBase() + '#/guide', { settleMs: 2500 });
      const doc = await waitGuideDoc(page, opts.timeoutMs);
      const ui = await page.evaluate(`(() => {
        const landing = document.getElementById('landing');
        const crumb = document.getElementById('crumbBiz');
        return {
          hash: location.hash || '',
          title: document.title,
          landingHidden: !!landing && landing.classList.contains('hidden'),
          crumb: crumb ? crumb.textContent : '',
          active: Array.from(document.querySelectorAll('[data-switch-biz].active')).map((b) => b.getAttribute('data-switch-biz')),
        };
      })()`);
      expect(ui.hash === '#/guide', `深链后 location.hash=${JSON.stringify(ui.hash)}，期望 "#/guide"`);
      expect(ui.landingHidden, '深链 #/guide 冷启动时首页未隐藏');
      expect(ui.crumb === '使用说明', `深链后面包屑=${JSON.stringify(ui.crumb)}`);
      expect(ui.active.join(',') === 'guide', `深链后高亮=${ui.active.join(',')}`);
      expect(/使用说明/.test(doc.h1), `深链后 h1=${JSON.stringify(doc.h1)}`);
      return `hash=${ui.hash} · crumb=${ui.crumb} · iframe docUrl=${doc.docUrl} · 正文 ${doc.textLen} 字符`;
    });

    await r.check('G4', '顶部切换条也能切到「使用说明」：从使用说明切到巡检，再切回使用说明', async () => {
      const switchTo = async (biz) => await page.evaluate(`(() => {
        const el = document.querySelector('[data-switch-biz="${biz}"]');
        if (!el) return { ok: false, reason: '找不到按钮' };
        const r = el.getBoundingClientRect();
        if (!(r.width > 0 && r.height > 0)) return { ok: false, reason: '按钮不可见' };
        el.click();
        return { ok: true, text: (el.textContent || '').trim() };
      })()`);
      const toPatrol = await switchTo('patrol');
      expect(toPatrol && toPatrol.ok, `切换到巡检失败：${oneLine(JSON.stringify(toPatrol))}`);
      await waitModuleLoaded(page, 'patrol', opts.timeoutMs);
      const toGuide = await switchTo('guide');
      expect(toGuide && toGuide.ok, `切换到使用说明失败：${oneLine(JSON.stringify(toGuide))}`);
      const doc = await waitGuideDoc(page, opts.timeoutMs);
      const ui = await page.evaluate(`(() => ({
        hash: location.hash || '',
        crumb: (document.getElementById('crumbBiz') || {}).textContent || '',
        active: Array.from(document.querySelectorAll('[data-switch-biz].active')).map((b) => b.getAttribute('data-switch-biz')),
        title: document.title,
      }))()`);
      expect(ui.hash === '#/guide', `切换后面包屑 hash=${JSON.stringify(ui.hash)}`);
      expect(ui.crumb === '使用说明', `切换后面包屑=${JSON.stringify(ui.crumb)}`);
      expect(ui.active.join(',') === 'guide', `切换后高亮=${ui.active.join(',')}`);
      expect(/使用说明/.test(ui.title), `切换后 title=${JSON.stringify(ui.title)}`);
      return `切换方式=${oneLine(toGuide.text, 12)} · docUrl=${doc.docUrl} · 正文 ${doc.textLen} 字符`;
    });

    await r.check('G5', '使用说明「独立打开」：新标签页打开 chrome-extension://<id>/guide.html 且渲染正常', async () => {
      const before = await listPageTargets(browser.port);
      const beforeIds = new Set(before.map((t) => t.id));
      const clicked = await page.evaluate(`(() => {
        const el = document.getElementById('openTabBtn');
        if (!el) return { ok: false, reason: '找不到 #openTabBtn' };
        el.click();
        return { ok: true, text: (el.textContent || '').trim() };
      })()`);
      expect(clicked && clicked.ok, `点击独立打开失败：${oneLine(JSON.stringify(clicked))}`);
      const deadline = Date.now() + 20000;
      let target = null;
      let lastList = [];
      while (Date.now() < deadline) {
        lastList = await listPageTargets(browser.port);
        target = lastList.find((t) => !beforeIds.has(t.id) && /\/guide\.html(?:[?#]|$)/.test(t.url || ''));
        if (target) break;
        await sleep(300);
      }
      expect(target, `20s 内没有出现 guide.html 独立标签页；当前 target：${oneLine(lastList.map((t) => t.url).join(' | '), 300)}`);
      const session = await new PageSession(target.webSocketDebuggerUrl).connect();
      try {
        await installNetworkMonitor(session, state.net);
        await session.setViewport(VIEWPORT.width, VIEWPORT.height);
        await session.waitFor(`document.readyState === 'complete' && !!document.querySelector('h1') && document.body.innerText.trim().length > 200`, { timeoutMs: opts.timeoutMs, label: '独立标签页 guide 首屏' });
        const info = await session.evaluate(`(() => ({
          url: location.href,
          title: document.title,
          h1: (document.querySelector('h1') || {}).textContent || '',
          textLen: document.body ? document.body.innerText.trim().length : 0,
          css: Array.from(document.styleSheets || []).map((s) => String(s.href || '')),
        }))()`);
        expect(/\/guide\.html$/.test(info.url), `独立标签页 URL=${info.url}`);
        expect(/使用说明/.test(info.h1), `独立标签页 h1=${JSON.stringify(info.h1)}`);
        expect(info.textLen > 400, `独立标签页正文过短（${info.textLen} 字符）`);
        expect(info.css.some((u) => /\/guide\.css$/i.test(u)), '独立标签页未加载 guide.css');
        const { benign, real } = splitConsoleErrors(session, session.consoleErrors.slice(), state.net);
        expect(real.length === 0, `独立标签页 console error ${real.length} 条：${real.slice(0, 6).join(' | ')}`);
        const shotPath = path.join(SHOTS_DIR, GUIDE.tabShot);
        await session.screenshot(shotPath);
        r.shots.push({ name: GUIDE.tabShot, path: shotPath, note: `使用说明独立标签页（${info.url}）` });
        console.log(`[shot] ${shotPath}`);
        return `新标签页=${info.url} · title=${info.title} · 正文 ${info.textLen} 字符 · console error 0${benign.length ? `（过滤已知可接受 ${benign.length}）` : ''}`;
      } finally {
        try { session.close(); } catch { /* ignore */ }
        await closeTarget(browser.port, target.id);
      }
    });

    await r.check('G6', '使用说明页截图 10-guide-1440.png', async () => {
      await r.shot(GUIDE.shot, '使用说明页（顶部切换进入，平台内 iframe）');
      return `qa/shots/${GUIDE.shot}`;
    });

    await r.check('G7', '使用说明阶段 console 零 error、guide.html/guide.css 无 4xx/5xx/加载失败', async () => {
      const { benign, real } = splitConsoleErrors(page, page.consoleErrors.slice(guideMark.console), state.net);
      const since = netSince(state.netMain, guideMark.net);
      const hit = (u) => /\/guide\.(?:html|css)(?:[?#]|$)/.test(String(u || ''));
      const badResponses = since.responses.filter((x) => hit(x.url) && (x.status >= 400 || x.status === 0));
      const badFailures = since.failures.filter((x) => !x.canceled && hit(x.url));
      const rawNet = [
        ...badResponses.map((x) => `${x.url} → HTTP ${x.status}`),
        ...badFailures.map((x) => `${x.url || '(未知URL)'} → ${x.errorText}`),
      ];
      const { benign: benignNet, real: realNet } = partitionBenignNet(rawNet);
      expect(real.length === 0 && realNet.length === 0,
        `console error ${real.length} 条：${real.slice(0, 6).join(' | ')}；网络问题：${realNet.slice(0, 6).join(' | ')}`);
      const filtered = benign.length + benignNet.length;
      return `console error 0 · 网络问题 0${filtered ? `（过滤已知可接受 ${filtered} 条）` : ''}`;
    });

    // ---- 汇总：所有 console error / 网络问题 ----
    await r.check('E1', '全程 console 零 error 汇总', async () => {
      const { benign, real } = splitConsoleErrors(page, page.consoleErrors.slice(), state.net);
      state.consoleErrors = real;
      state.benignConsoleErrors = benign;
      expect(real.length === 0, `共 ${real.length} 条：${real.slice(0, 10).join(' | ')}`);
      return `0 条${benign.length ? `（过滤已知可接受 ${benign.length} 条：preset-settings.json）` : ''}`;
    });

    await r.check('E2', '全程关键资源（data/*.json 及 modules/ 资源）无 4xx/5xx/失败', async () => {
      const rawRes = [];
      const rawFail = [];
      for (const net of state.net) {
        for (const x of net.responses) {
          if (DATA_RESOURCE_RE.test(x.url) && (x.status >= 400 || x.status === 0)) rawRes.push(`${x.url} → ${x.status}`);
        }
        for (const x of net.failures) {
          if (!x.canceled && /\/modules\//.test(String(x.url))) rawFail.push(`${x.url || '(未知URL)'} → ${x.errorText}`);
        }
      }
      const { benign: benignRes, real: badRes } = partitionBenignNet(rawRes);
      const { benign: benignFail, real: badFail } = partitionBenignNet(rawFail);
      state.netProblems = { badResponses: badRes, badFailures: badFail, benign: [...benignRes, ...benignFail] };
      expect(badRes.length === 0 && badFail.length === 0,
        `HTTP 异常：${badRes.slice(0, 8).join(' | ') || '无'}；加载失败：${badFail.slice(0, 8).join(' | ') || '无'}`);
      const filtered = benignRes.length + benignFail.length;
      return `data json 响应全部正常${filtered ? `（过滤已知可接受 ${filtered} 条）` : ''}`;
    });

    // ---- C1~C4：三个 content.js 共存验证（独立 target，Fetch 拦截本地 mock 电商平台商品页） ----
    await runContentScriptCoexistence(r, state, opts, browser);

    // 记录网络明细供报告使用
    state.netSummary = {
      responses: state.net.flatMap((n) => n.responses),
      failures: state.net.flatMap((n) => n.failures),
    };
  } finally {
    try { newTabSession?.close(); } catch { /* ignore */ }
    try { page?.close(); } catch { /* ignore */ }
    if (browser) {
      try { await browser.close(); } catch { /* ignore */ }
      console.log(`[cleanup] 浏览器已关闭（pid=${browser.child?.pid}），profile 已删除`);
    }
  }
}

// ---------------------------------------------------------------------------
// content.js 三合一共存验证（合并最大风险点）
// 做法：新建独立标签页，用 Fetch 域拦截 https://item.shop.example.com/*，fulfill 本地极简商品页（不联网真实电商平台），
// 等三个 content_scripts 注入到同一扩展的 isolated world，再检查三个 guard 与脚本级错误。
// ---------------------------------------------------------------------------
const CONTENT_MOCK_HTML = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>电商平台商品页（本地 mock · 不联网）</title></head>
<body>
  <div class="product-price"><span class="price J-p-100012043978">¥4,999.00</span></div>
  <h1 class="sku-title">Mock 65 英寸 4K 电视</h1>
  <div class="summary-price"><span>到手价</span><span>¥4,999.00</span></div>
  <div id="specification"><table><tbody><tr><th>屏幕尺寸</th><td>65英寸</td></tr></tbody></table></div>
</body>
</html>`;

async function runContentScriptCoexistence(r, state, opts, browser) {
  let session = null;
  let target = null;
  let targetId = '';
  const contexts = [];
  try {
    await r.check('C0', '拦截 https://item.shop.example.com/* 并返回本地 mock 商品页（不联网真实电商平台）', async () => {
      target = await createPageTarget(browser.port, 'about:blank');
      targetId = target.targetId;
      session = await new PageSession(target.wsUrl).connect();
      state.net = state.net || [];
      await installNetworkMonitor(session, state.net);
      await session.setViewport(VIEWPORT.width, VIEWPORT.height);
      session.client.on('Runtime.executionContextCreated', (p) => {
        const c = (p && p.context) || {};
        const aux = c.auxData || {};
        if (aux.isDefault === false && aux.type === 'isolated') {
          contexts.push({ id: c.id, name: c.name || '', origin: c.origin || '' });
        }
      });
      const htmlB64 = Buffer.from(CONTENT_MOCK_HTML, 'utf8').toString('base64');
      const emptyB64 = Buffer.from('', 'utf8').toString('base64');
      state.mock = { docFulfilled: 0, otherFulfilled: 0 };
      session.client.on('Fetch.requestPaused', async (p) => {
        const resourceType = (p && p.resourceType) || '';
        try {
          if (resourceType === 'Document') {
            state.mock.docFulfilled += 1;
            await session.client.rpc('Fetch.fulfillRequest', {
              requestId: p.requestId,
              responseCode: 200,
              responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }],
              body: htmlB64,
            }, 15000);
          } else {
            state.mock.otherFulfilled += 1;
            const ct = resourceType === 'Image' ? 'image/png' : 'text/plain';
            await session.client.rpc('Fetch.fulfillRequest', {
              requestId: p.requestId,
              responseCode: 200,
              responseHeaders: [{ name: 'Content-Type', value: ct }],
              body: emptyB64,
            }, 15000);
          }
        } catch {
          try { await session.client.rpc('Fetch.continueRequest', { requestId: p.requestId }, 5000); } catch { /* ignore */ }
        }
      });
      await session.client.rpc('Fetch.enable', {
        patterns: [{ urlPattern: 'https://item.shop.example.com/*', requestStage: 'Request' }],
      }, 15000);
      await session.navigate('https://item.shop.example.com/100012043978.html', { timeoutMs: 30000, settleMs: 1500 });
      const info = await session.evaluate(`({
        url: location.href,
        title: document.title,
        ready: document.readyState,
        bodyLen: document.body ? document.body.innerText.trim().length : 0,
      })`);
      state.mock.page = info;
      expect(/^https:\/\/item\.jd\.com\//.test(info.url), `导航后 URL=${info.url}`);
      expect(info.ready === 'complete', `mock 页 readyState=${info.ready}`);
      expect(state.mock.docFulfilled > 0, 'Fetch 没有拦截到主文档请求（docFulfilled=0）');
      return `URL=${info.url} · title=${info.title} · docFulfilled=${state.mock.docFulfilled} · other=${state.mock.otherFulfilled}`;
    });

    if (!session) {
      r.note('C0 未通过：跳过 content.js 共存验证（C1~C4）。');
      return;
    }

    await r.check('C1', '三个 content.js 共存注入：同一页面三个 guard 均为 true', async () => {
      const guardExpr = '({ patrol: !!window.__jdPatrolItemV3, share: !!window.__jdMarketCaptureV2, radar: !!window.__priceRadarV1 })';
      const deadline = Date.now() + 25000;
      let found = null;
      let lastStates = [];
      while (Date.now() < deadline) {
        lastStates = [];
        for (const c of contexts.slice()) {
          try {
            const res = await session.client.rpc('Runtime.evaluate', {
              expression: guardExpr, contextId: c.id, returnByValue: true,
            }, 5000);
            const v = res && res.result && res.result.value;
            if (v) {
              const st = { contextId: c.id, name: c.name, patrol: !!v.patrol, share: !!v.share, radar: !!v.radar };
              lastStates.push(st);
              if (st.patrol && st.share && st.radar) { found = st; break; }
            }
          } catch { /* 上下文可能已随导航销毁 */ }
        }
        if (found) break;
        await sleep(300);
      }
      state.contentWorlds = { contexts: contexts.slice(), lastStates, found: found || null };
      expect(found, `25s 内三个 guard 未同时为 true；isolated 上下文=${contexts.length} 个；最后状态=${oneLine(JSON.stringify(lastStates), 500)}`);
      return `isolated 上下文 ${contexts.length} 个 · patrol/share/radar 全 true（context#${found.contextId} ${found.name || ''}）`;
    });

    await r.check('C2', 'content.js 无 SyntaxError / Identifier already declared 类脚本级错误', async () => {
      const errs = session.consoleErrors.slice();
      state.contentConsoleErrors = errs;
      const fatal = errs.filter((e) => /SyntaxError|already been declared|Unexpected token|Identifier '[^']+' has already been declared/i.test(String(e)));
      expect(fatal.length === 0, `${fatal.length} 条：${fatal.slice(0, 6).join(' | ')}`);
      return `0 条（mock 页 console error 共 ${errs.length} 条）`;
    });

    await r.check('C3', 'mock 商品页 console 干净（content.js 初始化无异常）', async () => {
      const errs = session.consoleErrors.slice();
      expect(errs.length === 0, `${errs.length} 条：${errs.slice(0, 8).join(' | ')}`);
      return 'console error 0 条';
    });

    await r.check('C4', 'mock 页截图 09-content-scripts-coexist-1440.png', async () => {
      const shotPath = path.join(SHOTS_DIR, '09-content-scripts-coexist-1440.png');
      await session.screenshot(shotPath);
      r.shots.push({ name: '09-content-scripts-coexist-1440.png', path: shotPath, note: '三个 content.js 共存验证（item.shop.example.com 本地 mock）' });
      console.log(`[shot] ${shotPath}`);
      return 'qa/shots/09-content-scripts-coexist-1440.png';
    });
  } finally {
    try { session?.close(); } catch { /* ignore */ }
    if (targetId) { await closeTarget(browser.port, targetId); }
  }
}

// ---------------------------------------------------------------------------
// 工具链自检（不跑平台断言）
// ---------------------------------------------------------------------------
async function runSelftest(opts, r, state) {
  let browser = null;
  let page = null;
  try {
    await r.check('T1', `启动 headless Edge：${opts.ext}`, async () => {
      expect(fs.existsSync(path.join(opts.ext, 'manifest.json')), `缺少 ${path.join(opts.ext, 'manifest.json')}`);
      browser = await launchBrowser({
        extDir: opts.ext, width: VIEWPORT.width, height: VIEWPORT.height,
        browser: opts.browser || undefined, port: opts.port || undefined,
      });
      state.env.browserPath = findBrowser();
      state.env.browserVersion = browser.version && browser.version.Browser;
      return `CDP ${browser.port} · ${state.env.browserVersion}`;
    });

    await r.check('T2', '扩展加载并找到扩展 ID', async () => {
      state.extId = opts.extId || process.env.DS_EXT_ID || await findExtensionId(browser.port, 25000);
      expect(/^[a-p]{32}$/.test(state.extId), `ID 格式异常：${state.extId}`);
      const variants = deriveExtensionIdVariants(opts.ext);
      const matched = [...variants.entries()].find(([, v]) => v === state.extId);
      return `extId=${state.extId}${matched ? `（路径推导 ${matched[0]} 命中）` : '（路径推导未命中，仅记录）'}`;
    });

    await r.check('T3', '打开 chrome-extension://<id>/app.html 并完成首屏', async () => {
      const target = await findPageTarget(browser.port, 10000);
      page = await new PageSession(target.wsUrl).connect();
      state.net = [];
      await installNetworkMonitor(page, state.net);
      await page.setViewport(VIEWPORT.width, VIEWPORT.height);
      r.setPage(page);
      await page.navigate(`chrome-extension://${state.extId}/app.html`, { settleMs: 3000 });
      let diag = null;
      try {
        diag = await page.waitFor(`document.readyState === 'complete' && document.body && document.body.innerText.trim().length > 20`, { timeoutMs: opts.timeoutMs, label: '首屏' });
      } catch { /* 统一抛错 */ }
      const info = await page.evaluate(`(() => ({
        readyState: document.readyState,
        title: document.title,
        bodyLen: document.body ? document.body.innerText.trim().length : 0,
        bodyHead: document.body ? document.body.innerText.trim().slice(0, 160).replace(/\\s+/g, ' ') : '',
        tables: document.querySelectorAll('table').length,
      }))()`);
      state.home = info;
      expect(info.readyState === 'complete', `readyState=${info.readyState}`);
      expect(info.bodyLen > 20, `正文过短（${info.bodyLen}）`);
      expect(info.title.trim().length > 0, 'document.title 为空');
      return `title=${info.title} · body=${info.bodyLen} 字符 · tables=${info.tables}`;
    });

    await r.check('T4', '截图 qa/shots/harness-selftest-share.png', async () => {
      await r.shot('harness-selftest-share.png', '自检：原「市占率」插件 app.html');
      return 'qa/shots/harness-selftest-share.png';
    });

    // 自检的 console error 只记录、不判失败（原插件可能有既有噪声；本任务只证明链路通）
    state.consoleErrors = page.consoleErrors.slice();
    state.netSummary = {
      responses: state.net.flatMap((n) => n.responses),
      failures: state.net.flatMap((n) => n.failures),
    };
  } finally {
    try { page?.close(); } catch { /* ignore */ }
    if (browser) {
      try { await browser.close(); } catch { /* ignore */ }
      console.log(`[cleanup] 浏览器已关闭（pid=${browser.child?.pid}），profile 已删除`);
    }
  }
}

// ---------------------------------------------------------------------------
// 报告输出
// ---------------------------------------------------------------------------
// 本轮验收覆盖的产品修复点（由 Lead 确认，qa 只记录、不改产品）
const PRODUCT_FIXES = [
  {
    title: 'iframe 导航改用 contentWindow.location.replace（修复浏览器后退白屏）',
    detail: '平台根 app.js 不再写 iframe 的 src 属性，改用 contentWindow.location.replace(absUrl) 切业务，避免 iframe 导航写进浏览器历史导致后退白屏/历史错乱。副作用：iframe.getAttribute("src") 为空，本脚本已统一改为读取 contentDocument.URL / contentWindow.location.href（share 会带 #workbench）。',
  },
  {
    title: 'modules/patrol/data/preset-settings.json 补为空对象 {}',
    detail: 'patrol 源码插件 data/ 本来没有该文件，modules/patrol/app.js:366 的 fetch 会 404（虽在 try/catch 内）；本轮补空 {} 后 404 console/网络噪音消失，M-patrol 阶段与 E1/E2 均为 0 error。',
  },
  {
    title: '「独立打开」= 业务原生页',
    detail: '顶部「独立打开」在新标签页直接打开 modules/<biz>/app.html（原插件原生页面、不带平台导航条），用于长时间采集；D4 按此行为断言：新 target URL 含 /modules/<biz>/app.html、正文/关键 DOM 正常、零 console error。',
  },
  {
    title: '新增第 4 个入口「使用说明」（guide.html）',
    detail: '首页从三张卡片扩展为四张（patrol/share/radar/guide）；顶部切换条新增 [data-switch-biz="guide"]；支持深链 #/guide 冷启动；「独立打开」对 guide 生成 chrome-extension://<id>/guide.html（G1~G7 断言）。guide.html 是纯静态同源扩展页：无内联脚本/事件处理器、无远程资源，样式在 guide.css。',
  },
];

// 未覆盖范围 / 遗留风险（真实结果边界，避免把「首屏验证」误当全量回归）
const RESIDUAL_RISKS = [
  '未在真实 item.shop.example.com 商品页验证真实取价逻辑：C0~C4 用 CDP Fetch 拦截返回本地 mock 页，只验证三个 content.js 共存注入与 guard，不覆盖真实电商平台页面的登录/风控/价格区差异。',
  '未验证 AI 复核（AI 设置/连接测试/截图复核）与官方 API 桥（127.0.0.1:18765）的完整联调；仅验证模块首屏与本机数据加载。',
  '未覆盖多标签页并发采集、双击/重复点击、扩展升级/重载后的 chrome.storage 迁移等边界场景。',
  '未覆盖 headless 下的真实交互细节：鼠标悬停预览、剪贴板写入、Excel 文件导入/导出等（需要真实文件选择框或用户手势）。',
  'content.js 共存只验证注入/guard/无脚本级错误；三类业务消息（PATROL_/SHARE_/RADAR_）的端到端收发由真实采集链路覆盖，不在本次验收范围。',
  '三个模块原有业务的完整回归（实际采集流程、统计导出、待上报等）不在本次验收范围；本次验证的是「合并后平台壳 + 三业务首屏可用 + 使用说明页可读」。',
  '使用说明页按 README/产品现状编写（取价逻辑、新版页面适配、记录表语义、数据迁移等），本次只验证页面结构、导航、CSP 与零 console error，未逐条与三个业务的运行时行为做交叉复核。',
  '本地 patrol 巡检 API 桥在验收时处于运行状态（/healthz 200），未验证桥未启动时 patrol 页面降级表现。',
];

function formatLocal(iso) {
  try {
    const t = new Date(new Date(iso).getTime() + 8 * 3600 * 1000);
    const pad = (n) => String(n).padStart(2, '0');
    return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())} (UTC+8)`;
  } catch (e) {
    return String(iso || '');
  }
}

/** 给报告补上「验收环境与时间 / 产品修复点 / 遗留风险 / knownBenign 说明」。 */
function enrichReport(report) {
  const env = report.env || {};
  // 截图按文件名序号排序：01,02,...,08,08b,09
  const shotOrder = (s) => {
    const name = String(s.path || s.name || '').split(/[\\/]/).pop() || '';
    const m = name.match(/^(\d+)([a-z]?)/i);
    if (!m) return 999;
    return Number(m[1]) + (m[2] ? 0.5 : 0);
  };
  report.screenshots = [...(report.screenshots || [])].sort((a, b) => shotOrder(a) - shotOrder(b));
  report.screenshotNote = '截图均为 1440×900 视口、headless Edge 真实渲染：01 首页（四卡片）、02~04 三业务首屏、05 独立标签页、06 返回首页、07 深链 #/patrol、08/08b 两步后退、09 content.js 共存 mock 页、10 使用说明页、11 使用说明独立标签页。';
  report.verification = {
    at: report.generatedAt || null,
    atLocal: report.generatedAt ? formatLocal(report.generatedAt) : null,
    mode: report.mode === 'platform' ? 'platform（headless Edge 真实浏览器 E2E）' : report.mode,
    viewport: report.viewport || null,
    browser: env.browserVersion || null,
    cdpPort: env.cdpPort || null,
    node: env.node || null,
    extDir: report.extDir || null,
    extensionId: report.extensionId || null,
    durationMs: report.durationMs || 0,
    screenshots: (report.screenshots || []).length,
  };
  report.productFixes = PRODUCT_FIXES;
  report.residualRisks = RESIDUAL_RISKS;
  const presetOk = (report.network?.responses || []).some((x) => /preset-settings\.json/.test(String(x.url || '')) && x.status === 200);
  const benignConsole = (report.knownBenign && report.knownBenign.consoleErrors) || [];
  const benignNet = (report.knownBenign && report.knownBenign.network) || [];
  report.knownBenign = {
    triggered: benignConsole.length + benignNet.length > 0,
    consoleErrors: benignConsole,
    network: benignNet,
    note: presetOk
      ? 'modules/patrol/data/preset-settings.json 已补为空 {}（本次运行返回 200），404 噪音已消失，knownBenign 过滤未触发。'
      : 'modules/patrol/data/preset-settings.json 缺失属于源码插件既有情况（fetch 在 try/catch 内），按 knownBenign 记录、不判失败。',
  };
  return report;
}

function buildReport(opts, r, state) {
  const failed = r.failed;
  const durationMs = Date.now() - r.startedAt;
  return enrichReport({
    generatedAt: new Date().toISOString(),
    mode: opts.selftest ? 'selftest' : opts.domOnly ? 'dom+static' : opts.staticOnly ? 'static' : 'platform',
    browserE2E: opts.selftest || (opts.domOnly || opts.staticOnly) ? 'not-run' : 'run',
    fatalError: state.fatalError || null,
    extDir: opts.ext,
    extensionId: state.extId || null,
    viewport: opts.selftest ? null : `${VIEWPORT.width}x${VIEWPORT.height}`,
    durationMs,
    env: state.env,
    jsdomFrom: state.jsdomFrom || null,
    summary: {
      verdict: failed.length === 0 ? 'PASS' : 'FAIL',
      total: r.results.length,
      passed: r.passed.length,
      failed: failed.length,
      consoleErrors: (state.consoleErrors || []).length,
      screenshots: r.shots.length,
    },
    checks: r.results,
    consoleErrors: state.consoleErrors || [],
    contentCoexistence: state.contentWorlds || null,
    contentConsoleErrors: state.contentConsoleErrors || [],
    knownBenign: {
      consoleErrors: state.benignConsoleErrors || [],
      network: ((state.netProblems && state.netProblems.benign) || []),
      reason: 'modules/patrol/data/preset-settings.json 是源码插件本就缺失的可选资源（fetch 在 try/catch 内），Lead 已确认属预期，不计失败。',
    },
    network: {
      responses: (state.netSummary?.responses || []).filter((x) => DATA_RESOURCE_RE.test(x.url) || /\/modules\//.test(x.url)),
      failures: (state.netSummary?.failures || []).filter((x) => !x.canceled && /\/modules\//.test(String(x.url))),
    },
    screenshots: r.shots,
    notes: r.notes,
    newTab: state.newTab || null,
    home: state.home || null,
  });
}

function renderMarkdown(report) {
  const lines = [];
  const ver = report.verification || {};
  lines.push('# 价格监控平台 · 浏览器端验收报告');
  lines.push('');
  lines.push(`- 生成时间：${report.generatedAt}${ver.atLocal ? `（北京时间 ${ver.atLocal}）` : ''}`);
  if (report.finalizedAt) lines.push(`- 报告整理时间：${report.finalizedAtLocal || formatLocal(report.finalizedAt)}`);
  lines.push(`- 结论：**${report.summary.verdict}**（通过 ${report.summary.passed}/${report.summary.total}，失败 ${report.summary.failed}）`);
  if (report.browserE2E !== 'run') {
    lines.push('');
    lines.push('> ⚠️ **浏览器 E2E 未跑（环境限制）**：DSH workspace-write 沙箱禁止子进程创建命名管道，Chromium 的 mojo IPC 无法建立，headless Edge 启动后必然 `FATAL:mojo\\public\\cpp\\platform\\platform_channel.cc` 退出（已在本机复现，exit code 2147483651）。');
    lines.push('> 本报告覆盖「静态文件检查 + jsdom 壳逻辑验证」；真实浏览器断言需在 full-access / 普通终端下运行 `node qa/verify.mjs`（会生成完整截图、console error、网络与 report.json）。');
    lines.push('> 失败/通过项不代表浏览器内已验证，浏览器结论待补跑后覆盖本报告。');
  }
  lines.push('');
  if (report.fatalError) {
    lines.push(`> 💥 运行期致命错误：${oneLine(report.fatalError, 600)}`);
    lines.push('');
  }
  lines.push(`- 验证模式：${report.mode}`);
  lines.push(`- 扩展目录：\`${report.extDir}\``);
  lines.push(`- 扩展 ID：\`${report.extensionId || '未获取（浏览器未跑）'}\``);
  lines.push(`- 视口：${report.viewport || '—'} · headless Edge：${report.env.browserVersion || '—'} · CDP 端口：${report.env.cdpPort || '—'}`);
  if (report.jsdomFrom) lines.push(`- jsdom：\`${report.jsdomFrom}\``);
  lines.push(`- 耗时：${(report.durationMs / 1000).toFixed(1)}s`);
  lines.push('');
  lines.push('## 验收环境与时间');
  lines.push('');
  lines.push(`| 项 | 值 |`);
  lines.push(`|---|---|`);
  lines.push(`| 验收时间 | ${ver.atLocal || report.generatedAt} |`);
  lines.push(`| 验证方式 | ${ver.mode || report.mode} |`);
  lines.push(`| 视口 | ${ver.viewport || report.viewport || '—'} |`);
  lines.push(`| 浏览器 | ${ver.browser || '—'}（headless Edge，--load-extension 加载未打包扩展） |`);
  lines.push(`| CDP 端口 | ${ver.cdpPort || '—'} |`);
  lines.push(`| Node | ${ver.node || '—'} |`);
  lines.push(`| 扩展目录 | \`${ver.extDir || report.extDir}\` |`);
  lines.push(`| 扩展 ID | \`${ver.extensionId || report.extensionId || '—'}\` |`);
  lines.push(`| 断言总数 | ${report.summary.total}（通过 ${report.summary.passed} / 失败 ${report.summary.failed}） |`);
  lines.push(`| 截图 | ${report.summary.screenshots} 张（\`qa/shots/\`） |`);
  lines.push(`| 主页面耗时 | ${((ver.durationMs || report.durationMs || 0) / 1000).toFixed(1)}s |`);
  if (report.screenshotNote) {
    lines.push('');
    lines.push(oneLine(report.screenshotNote, 600));
  }
  lines.push('');
  lines.push('## 断言明细');
  lines.push('');
  lines.push('| 项 | 断言 | 结果 | 耗时 | 详情/错误 |');
  lines.push('|---|---|---|---|---|');
  for (const c of report.checks) {
    const detail = c.ok ? (c.detail || '') : (c.error || '');
    lines.push(`| ${c.id} | ${c.title.replace(/\|/g, '\\|')} | ${c.ok ? '✅ PASS' : '❌ FAIL'} | ${c.durationMs}ms | ${oneLine(detail, 400).replace(/\|/g, '\\|')} |`);
  }
  lines.push('');
  const failed = report.checks.filter((c) => !c.ok);
  lines.push('## 失败项与修复建议');
  lines.push('');
  if (failed.length === 0) {
    lines.push('无失败项。');
  } else {
    for (const c of failed) {
      lines.push(`### ${c.id} ${c.title}`);
      lines.push('');
      lines.push('```');
      lines.push(oneLine(c.error, 1200));
      lines.push('```');
      const hintKey = Object.keys(HINTS).filter((k) => c.id.startsWith(k)).sort((a, b) => b.length - a.length)[0];
      if (hintKey) lines.push(`- 建议：${HINTS[hintKey]}`);
      lines.push('');
    }
  }
  lines.push('');
  lines.push('## 产品修复点（本轮验收覆盖）');
  lines.push('');
  const fixes = report.productFixes || [];
  if (!fixes.length) lines.push('无。');
  for (const f of fixes) {
    lines.push(`### ${f.title}`);
    lines.push('');
    lines.push(f.detail);
    lines.push('');
  }
  lines.push('## UI / 交互观察');
  lines.push('');
  const uiFails = report.checks.filter((c) => !c.ok && (/-2b$/.test(c.id) || /-2c$/.test(c.id) || c.id === 'D3b'));
  if (uiFails.length) {
    for (const c of uiFails) lines.push(`- ❌ ${c.id}：${oneLine(c.error, 240)}`);
  } else if (report.browserE2E === 'run') {
    lines.push('未发现 iframe 尺寸塌陷、遮罩卡住、浏览器后退白屏等异常。');
  } else {
    lines.push('浏览器未跑：iframe 高度/遮罩动画/视觉布局无法在 jsdom 中验证（jsdom 已验证壳逻辑与 #frameMask.done 状态切换）。');
  }
  lines.push('');
  lines.push('## 截图索引');
  lines.push('');
  if (report.screenshots.length === 0) lines.push(report.browserE2E === 'run' ? '无。' : '无（浏览器 E2E 未跑，暂无截图）。');
  for (const s of report.screenshots) {
    lines.push(`- ${s.note ? oneLine(s.note, 120) + '：' : ''}\`${path.relative(PLATFORM_DIR, s.path)}\``);
  }
  lines.push('');
  lines.push('## 遗留风险 / 未覆盖范围');
  lines.push('');
  const risks = report.residualRisks || [];
  if (!risks.length) lines.push('无。');
  for (const x of risks) lines.push(`- ${x}`);
  lines.push('');
  lines.push('## console error 汇总');
  lines.push('');
  if (!report.consoleErrors.length) lines.push(report.browserE2E === 'run' ? '0 条。' : '未采集（浏览器 E2E 未跑；jsdom 运行期 0 异常，见 J10）。');
  else for (const e of report.consoleErrors) lines.push(`- ${oneLine(e, 500)}`);
  const knownBenign = report.knownBenign || {};
  const benignConsole = knownBenign.consoleErrors || [];
  if (knownBenign.note) {
    lines.push('');
    lines.push(`- 已知可接受资源说明：${knownBenign.note}`);
  }
  if (benignConsole.length) {
    lines.push('');
    lines.push(`已知可接受（不计失败，${benignConsole.length} 条）：`);
    for (const e of benignConsole) lines.push(`- ${oneLine(e, 300)}`);
  }
  lines.push('');
  lines.push('## 网络（data/*.json 与 modules/ 资源）');
  lines.push('');
  if (report.browserE2E !== 'run') {
    lines.push('浏览器 E2E 未跑，未采集网络响应；数据 JSON 存在性已由 S6 静态检查覆盖。');
  } else {
    const dataRes = report.network.responses.filter((x) => DATA_RESOURCE_RE.test(x.url));
    if (!dataRes.length) lines.push('未捕获到 data/*.json 响应明细（已用主动 fetch 探测兜底，见各模块 -3 断言）。');
    else {
      const seen = new Map();
      for (const x of dataRes) {
        const k = `${x.status} ${x.url}`;
        seen.set(k, (seen.get(k) || 0) + 1);
      }
      for (const [k, n] of seen) lines.push(`- ${k}${n > 1 ? `（×${n}）` : ''}`);
    }
    const fails = report.network.failures;
    if (fails.length) {
      lines.push('');
      lines.push('加载失败：');
      for (const x of fails) lines.push(`- ${x.url || '(未知URL)'} → ${x.errorText}`);
    }
  }
  lines.push('');
  lines.push('## content.js 共存验证（item.shop.example.com 本地 mock）');
  lines.push('');
  const cc = report.contentCoexistence;
  if (!cc) {
    lines.push('未执行（浏览器 E2E 未跑或 C0 未通过）。');
  } else {
    lines.push(`- isolated world 上下文：${(cc.contexts || []).length} 个${cc.found ? `，三个 guard 齐活（context#${cc.found.contextId}）` : '，**三个 guard 未齐活**'}`);
    if (cc.found) lines.push(`- guard：patrol=\`${cc.found.patrol}\` · share=\`${cc.found.share}\` · radar=\`${cc.found.radar}\``);
    const cErrs = report.contentConsoleErrors || [];
    lines.push(`- mock 页 console error：${cErrs.length} 条`);
    for (const e of cErrs) lines.push(`  - ${oneLine(e, 400)}`);
    lines.push('- 说明：用 CDP Fetch 拦截 https://item.shop.example.com/* 返回本地极简商品页（不联网真实电商平台），验证三个 content.js 能在同一扩展 isolated world 共存注入。');
  }
  lines.push('');
  if (report.notes.length) {
    lines.push('## 备注');
    lines.push('');
    for (const n of report.notes) lines.push(`- ${n}`);
    lines.push('');
  }
  lines.push('---');
  lines.push('');
  lines.push('最小复现：`node qa/verify.mjs`（可选 `--ext <目录>` 覆盖扩展目录）；失败现场截图见 `qa/shots/fail-*.png`。');
  if (report.browserE2E !== 'run') {
    lines.push('');
    lines.push('补跑浏览器 E2E（需在 full-access / 普通终端下执行，DSH 沙箱内 Chromium 无法启动）：');
    lines.push('');
    lines.push('```powershell');
    lines.push(`node "${path.join(PLATFORM_DIR, 'qa', 'verify.mjs')}"`);
    lines.push('```');
    lines.push('');
    lines.push('产物：`qa/shots/01-platform-home-1440.png`、`02~04` 三模块、`05-independent-tab-<biz>-1440.png`、`06` 返回首页、`07` 深链、`08` 后退、`10` 使用说明、`11` 使用说明独立标签页；`qa/report.json` + `qa/REPORT.md` 会被浏览器结果覆盖。');
  }
  return lines.join('\n');
}

function writeReport(opts, r, state) {
  reportDir = opts.out;
  fs.mkdirSync(reportDir, { recursive: true });
  const report = buildReport(opts, r, state);
  const jsonPath = path.join(reportDir, 'report.json');
  const mdPath = path.join(reportDir, 'REPORT.md');
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  fs.writeFileSync(mdPath, renderMarkdown(report), 'utf8');
  return { report, jsonPath, mdPath };
}

let reportDir = QA_DIR;

/** 重跑前清掉上一次的失败现场截图，交付目录只留本次正式截图。 */
function cleanFailShots() {
  try {
    for (const f of fs.readdirSync(SHOTS_DIR)) {
      if (/^fail-.*\.png$/i.test(f)) fs.rmSync(path.join(SHOTS_DIR, f), { force: true });
    }
  } catch { /* 目录不存在等情况忽略 */ }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
    return 0;
  }
  if (opts.render) {
    // 只整理报告：用现有 report.json 重新生成 REPORT.md（补环境/修复点/风险/截图序），不跑任何验证
    const jsonPath = path.join(opts.out, 'report.json');
    if (!fs.existsSync(jsonPath)) {
      console.error(`[render] 找不到 ${jsonPath}，请先跑 node qa/verify.mjs`);
      return 2;
    }
    const report = enrichReport(JSON.parse(fs.readFileSync(jsonPath, 'utf8')));
    report.finalizedAt = new Date().toISOString();
    report.finalizedAtLocal = formatLocal(report.finalizedAt);
    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');
    fs.writeFileSync(path.join(opts.out, 'REPORT.md'), renderMarkdown(report), 'utf8');
    console.log(`[render] report 已整理：${jsonPath}`);
    console.log(`[render] REPORT.md 已重新生成：${path.join(opts.out, 'REPORT.md')}`);
    console.log(`[render] 结论：${report.summary.verdict}（${report.summary.passed}/${report.summary.total}）· 截图 ${report.summary.screenshots} 张`);
    return 0;
  }
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  cleanFailShots();
  if (opts.out !== QA_DIR) fs.mkdirSync(opts.out, { recursive: true });

  const state = { extId: '', env: { node: process.version }, consoleErrors: [], net: [], netSummary: null };
  const r = new Runner(SHOTS_DIR);
  let exitCode = 0;

  console.log('='.repeat(78));
  console.log(`价格监控平台 QA ${opts.selftest ? '工具链自检' : opts.domOnly ? '壳逻辑验证（jsdom，无浏览器）' : opts.staticOnly ? '静态检查' : '验收'}`);
  console.log(`extDir  : ${opts.ext}`);
  console.log(`node    : ${process.version}`);
  if (!opts.domOnly && !opts.staticOnly) console.log(`浏览器  : ${opts.browser || findBrowser()}`);
  console.log(`截图目录: ${SHOTS_DIR}`);
  console.log('='.repeat(78));

  try {
    if (opts.selftest) {
      await runSelftest(opts, r, state);
      const failed = r.failed;
      const out = {
        generatedAt: new Date().toISOString(),
        mode: 'selftest',
        extDir: opts.ext,
        extensionId: state.extId || null,
        env: state.env,
        summary: { verdict: failed.length === 0 ? 'PASS' : 'FAIL', total: r.results.length, passed: r.passed.length, failed: failed.length },
        checks: r.results,
        consoleErrors: state.consoleErrors || [],
        screenshots: r.shots,
      };
      fs.writeFileSync(path.join(SHOTS_DIR, 'harness-selftest.json'), JSON.stringify(out, null, 2), 'utf8');
      exitCode = failed.length ? 1 : 0;
    } else if (opts.domOnly) {
      // 无浏览器兜底：静态检查 + jsdom 壳逻辑；结果写 report.json / REPORT.md（标注浏览器 E2E 未跑）
      await runStaticChecks(r, opts.ext);
      await runDomChecks(r, opts.ext, state);
      const { jsonPath, mdPath } = writeReport(opts, r, state);
      console.log(`[report] ${jsonPath}`);
      console.log(`[report] ${mdPath}`);
      exitCode = r.failed.length ? 1 : 0;
    } else {
      await verifyPlatform(opts, r, state);
      if (!opts.staticOnly) {
        const { jsonPath, mdPath } = writeReport(opts, r, state);
        console.log(`[report] ${jsonPath}`);
        console.log(`[report] ${mdPath}`);
      }
      exitCode = r.failed.length ? 1 : 0;
    }
  } catch (err) {
    console.error('[fatal]', (err && err.stack) || err);
    state.fatalError = String((err && err.message) || err);
    try {
      await r.captureFail('fatal');
    } catch { /* ignore */ }
    if (!opts.selftest && !opts.staticOnly) {
      // 致命错误也尽量落盘报告，便于 Lead/user 看到已跑到的断言与失败现场
      try {
        const { jsonPath, mdPath } = writeReport(opts, r, state);
        console.log(`[report] ${jsonPath}`);
        console.log(`[report] ${mdPath}`);
      } catch (e2) {
        console.error('[fatal] 报告写入失败：', (e2 && e2.message) || e2);
      }
    }
    exitCode = 2;
  }

  // ---- 汇总输出 ----
  console.log('');
  console.log('-'.repeat(78));
  console.log(`结果：${r.passed.length}/${r.results.length} 通过，${r.failed.length} 失败`);
  if (r.failed.length) {
    console.log('');
    console.log('失败项：');
    for (const c of r.failed) console.log(`  - ${c.id} ${c.title}\n    ${oneLine(c.error, 600)}`);
    console.log('');
    console.log('最小复现：node qa/verify.mjs' + (opts.ext !== PLATFORM_DIR ? ` --ext "${opts.ext}"` : ''));
    console.log(`失败现场截图：${SHOTS_DIR}\\fail-*.png`);
  }
  if (state.consoleErrors && state.consoleErrors.length) {
    console.log('');
    console.log(`console error 共 ${state.consoleErrors.length} 条：`);
    for (const e of state.consoleErrors) console.log(`  - ${oneLine(e, 400)}`);
  }
  console.log(`截图：${r.shots.length} 张 → ${SHOTS_DIR}`);
  console.log('-'.repeat(78));

  return exitCode;
}

main().then((code) => {
  process.exitCode = code;
}).catch((err) => {
  console.error('[fatal]', (err && err.stack) || err);
  process.exitCode = 2;
});
