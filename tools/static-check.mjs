// 价格监控平台 · 静态自检（零依赖，Node 24）
// 校验：manifest 结构 / 引用文件是否存在 / HTML 是否含内联脚本 / 消息命名空间是否统一 /
//      模块 data 路径是否已加 modules/<业务>/ 前缀 / 关键 DOM 约定是否存在。
// 用法：node tools/static-check.mjs

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const warnings = [];
const checks = [];

function ok(name, detail) {
  checks.push({ name, ok: true, detail: detail || '' });
}
function fail(name, detail) {
  errors.push(`${name}：${detail}`);
  checks.push({ name, ok: false, detail: detail || '' });
}

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function rel(p) {
  return path.relative(ROOT, p).replace(/\\/g, '/');
}

if (!fs.existsSync(ROOT)) {
  console.error('找不到平台目录：' + ROOT);
  process.exit(1);
}

/* ---------------- 1. manifest ---------------- */
let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  ok('manifest.json 可解析');
} catch (e) {
  fail('manifest.json 无法解析', e.message);
  console.log(errors.join('\n'));
  process.exit(1);
}

if (manifest.manifest_version === 3) ok('manifest_version = 3');
else fail('manifest_version', '应为 3');

for (const key of ['name', 'version', 'description', 'action', 'icons', 'background']) {
  if (!manifest[key]) fail('manifest 缺少字段', key);
}

// background / action / icons / content_scripts 引用文件必须存在
const referenced = [];
if (manifest.background?.service_worker) referenced.push(manifest.background.service_worker);
for (const v of Object.values(manifest.icons || {})) referenced.push(v);
for (const v of Object.values(manifest.action?.default_icon || {})) referenced.push(v);
for (const cs of manifest.content_scripts || []) {
  for (const j of cs.js || []) referenced.push(j);
  for (const c of cs.css || []) referenced.push(c);
}
for (const r of referenced) {
  if (!fs.existsSync(path.join(ROOT, r))) fail('manifest 引用文件不存在', r);
}
ok('manifest 引用文件存在性检查完成', `${referenced.length} 个`);

// 权限并集
const needPerms = ['storage', 'tabs', 'unlimitedStorage'];
for (const p of needPerms) {
  if (!(manifest.permissions || []).includes(p)) fail('manifest 权限缺失', p);
}
if (!(manifest.permissions || []).includes('clipboardWrite')) warnings.push('manifest 缺少 clipboardWrite（竞品雷达复制按钮需要）');

// content_scripts 覆盖三条业务 + 电商平台商品页
const csFiles = (manifest.content_scripts || []).flatMap((cs) => cs.js || []);
for (const f of ['modules/patrol/content.js', 'modules/share/content.js', 'modules/radar/content.js']) {
  if (!csFiles.includes(f)) fail('content_scripts 未声明', f);
}
const allMatches = (manifest.content_scripts || []).flatMap((cs) => cs.matches || []);
for (const m of ['https://item.shop.example.com/*']) {
  if (!allMatches.includes(m)) fail('content_scripts 未覆盖', m);
}
ok('content_scripts 三条业务均已声明', csFiles.join(' | '));

/* ---------------- 2. HTML：无内联脚本 / 引用存在 ---------------- */
// qa/engine/fixtures/*.html 是取价矩阵的 mock 商品页夹具（故意带内联脚本模拟页面动态改价），不属于扩展页面，跳过。
const isFixture = (f) => rel(f).startsWith('qa/');
for (const file of walk(ROOT).filter((f) => f.endsWith('.html') && !isFixture(f))) {
  const html = fs.readFileSync(file, 'utf8');
  const inlineScripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter((m) => !/\bsrc\s*=/.test(m[1]) && m[2].trim());
  if (inlineScripts.length) fail('内联脚本（MV3 CSP 会拦截）', `${rel(file)} 共 ${inlineScripts.length} 处`);
  const inlineHandlers = [...html.matchAll(/\son[a-z]+\s*=\s*["']/gi)];
  if (inlineHandlers.length) fail('内联事件处理器（CSP 会拦截）', `${rel(file)} 共 ${inlineHandlers.length} 处`);

  for (const m of html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
    const url = m[1];
    if (/^(https?:|data:|about:|chrome-extension:)/i.test(url)) continue;
    const target = path.resolve(path.dirname(file), url.split('?')[0]);
    if (!fs.existsSync(target)) fail('HTML 引用文件不存在', `${rel(file)} → ${url}`);
  }
}
ok('HTML 内联脚本/事件处理器与引用检查完成', `${walk(ROOT).filter((f) => f.endsWith('.html')).length} 个 html`);

/* ---------------- 3. 资源路径：模块内 getURL('data/...') 必须带 modules/<业务>/ ---------------- */
for (const biz of ['patrol', 'share', 'radar']) {
  const dir = path.join(ROOT, 'modules', biz);
  if (!fs.existsSync(dir)) {
    fail('模块目录缺失', `modules/${biz}`);
    continue;
  }
  for (const f of walk(dir).filter((x) => x.endsWith('.js'))) {
    const code = fs.readFileSync(f, 'utf8');
    for (const m of code.matchAll(/getURL\(\s*['"]([^'"]+)['"]/g)) {
      const url = m[1];
      if (url.startsWith('data/')) fail('模块内 getURL 未加 modules 前缀', `${rel(f)} → ${url}`);
      if (url.startsWith('modules/')) {
        const target = path.join(ROOT, url);
        if (!fs.existsSync(target)) {
          // 原插件就没有 data/preset-settings.json：fetch 在 try/catch 内，404 时静默跳过、用代码默认值。
          if (/preset-settings\.json$/.test(url)) {
            warnings.push(`可选预置文件不存在（原插件同样没有，代码已 try/catch 兜底）：${url}`);
          } else {
            fail('getURL 目标不存在', `${rel(f)} → ${url}`);
          }
        }
      }
    }
    if (/WATCHLIST_URL\s*=\s*['"]data\//.test(code)) fail('WATCHLIST_URL 未加 modules 前缀', rel(f));
  }
  // 必备数据文件
  const dataDir = path.join(dir, 'data');
  if (biz === 'patrol' || biz === 'share') {
    if (!fs.existsSync(path.join(dataDir, 'base-skus.json'))) fail('数据文件缺失', `modules/${biz}/data/base-skus.json`);
  }
  if (biz === 'radar' && !fs.existsSync(path.join(dataDir, 'competitor-skus.json'))) {
    fail('数据文件缺失', 'modules/radar/data/competitor-skus.json');
  }
  // 模块页入口
  if (!fs.existsSync(path.join(dir, 'app.html'))) fail('模块页缺失', `modules/${biz}/app.html`);
}
ok('模块资源路径与数据文件检查完成');

/* ---------------- 4. 消息命名空间 ---------------- */
const NAMESPACE = { patrol: 'PATROL', share: 'SHARE', radar: 'RADAR' };
for (const biz of ['patrol', 'share', 'radar']) {
  const dir = path.join(ROOT, 'modules', biz);
  for (const f of walk(dir).filter((x) => x.endsWith('.js'))) {
    const code = fs.readFileSync(f, 'utf8');
    if (/msg\.type\s*===\s*'PING'/.test(code)) fail('未命名空间化的 PING', rel(f));
    if (/msg\.type\s*!==\s*'ITEM_PRICE_RESULT'/.test(code)) fail('未命名空间化的消息监听', rel(f));

    // radar\app.js 的 navResultFor() 会在本地构造一个 type:'ITEM_PRICE_RESULT' 的内部结果对象，
    // 直接交给 pending.resolve 消费、不走 chrome 消息通道，属于设计内保留项。
    for (const m of code.matchAll(/type\s*:\s*'ITEM_PRICE_RESULT'/g)) {
      const before = code.slice(Math.max(0, m.index - 500), m.index);
      if (/function\s+navResultFor|navResultFor\(/.test(before)) continue;
      fail('未命名空间化的消息类型', `${rel(f)} → type:'ITEM_PRICE_RESULT'`);
    }
  }
  const contentFile = path.join(dir, 'content.js');
  if (fs.existsSync(contentFile)) {
    const code = fs.readFileSync(contentFile, 'utf8');
    const prefix = NAMESPACE[biz];
    if (biz !== 'share' && !code.includes(prefix + '_ITEM_PRICE_RESULT')) {
      fail('content.js 未使用业务命名空间结果类型', `modules/${biz}/content.js 缺少 ${prefix}_ITEM_PRICE_RESULT`);
    }
    if (!code.includes(prefix + '_PING')) fail('content.js 未使用业务命名空间 PING', `modules/${biz}/content.js`);
  }
}
ok('消息命名空间检查完成');

/* ---------------- 5. 平台壳约定（QA 依赖的选择器） ---------------- */
const shellHtml = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
for (const biz of ['patrol', 'share', 'radar']) {
  if (!new RegExp(`data-biz="${biz}"`).test(shellHtml)) fail('平台壳缺少业务卡片', `data-biz="${biz}"`);
}
if (!/id="moduleFrame"/.test(shellHtml)) fail('平台壳缺少 iframe#moduleFrame', '');
if (!/data-switch-biz="patrol"/.test(shellHtml)) fail('平台壳缺少业务切换按钮', 'patrol');
if (!/id="platformBar"/.test(shellHtml)) fail('平台壳缺少顶部导航条', '#platformBar');
ok('平台壳 DOM 约定检查完成');

const shellJs = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
for (const biz of ['patrol', 'share', 'radar']) {
  if (!shellJs.includes(`modules/${biz}/app.html`)) fail('平台壳业务入口路径错误', `modules/${biz}/app.html`);
}
ok('平台壳业务入口路径检查完成');

/* ---------------- 6. JS 语法（node --check） ---------------- */
const jsFiles = walk(ROOT).filter((f) => f.endsWith('.js') && !f.includes(`${path.sep}qa${path.sep}`));
let checked = 0;
for (const f of jsFiles) {
  const isModule = /\bexport\b|^\s*import\s/m.test(fs.readFileSync(f, 'utf8'));
  if (isModule) continue; // ES Module 由浏览器校验；node --check 按 CJS 解析会误报
  // 沙箱下 spawnSync 管道 stdio 会 EPERM，这里只用退出码（失败时提示手动 node --check）
  const r = spawnSync(process.execPath, ['--check', f], { stdio: 'ignore' });
  checked++;
  if (r.status !== 0) fail('node --check 失败', `${rel(f)}（手动执行 node --check 查看具体行）`);
}
ok('JS 语法检查完成', `${checked} 个经典脚本`);

/* ---------------- 输出 ---------------- */
console.log('价格监控平台 · 静态自检');
console.log('目录：' + ROOT);
console.log('');
for (const c of checks) console.log(`  ${c.ok ? '✔' : '✘'} ${c.name}${c.detail ? '  — ' + c.detail : ''}`);
if (warnings.length) {
  console.log('\n警告：');
  for (const w of warnings) console.log('  ! ' + w);
}
if (errors.length) {
  console.log('\n失败项：');
  for (const e of errors) console.log('  ✘ ' + e);
  process.exit(1);
}
console.log('\n全部通过 ✔');
