// JD 商品页取价诊断（临时工具）：**默认关闭**。
// 只有点击扩展图标开启（徽标 ON）后，打开电商平台商品页才会收集 DOM 结构并保存为 JSON 到下载目录。
// 只读页面 DOM，不采集、不修改、不上传。
(() => {
  if (window.__jdPriceDiagDone) return;

  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const textOf = (el) => {
    if (!el) return '';
    try { return norm(el.innerText || el.textContent || ''); } catch (e) { return ''; }
  };
  const visible = (el) => {
    try {
      if (!el || !el.getBoundingClientRect) return false;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const st = getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
      return r.bottom > -3000 && r.top < (window.innerHeight + 6000);
    } catch (e) { return false; }
  };
  const chainOf = (el, up) => {
    const out = [];
    let cur = el;
    for (let i = 0; i < up && cur; i++) {
      out.push({ tag: cur.tagName ? cur.tagName.toLowerCase() : '', cls: String(cur.className || '').slice(0, 90), id: cur.id || '' });
      cur = cur.parentElement;
    }
    return out;
  };

  const selList = [
    '.sku-name', '#name h1', '[class*="sku-name"]', '.itemInfo-wrap h1', '.product-intro h1',
    '.summary-price', '.p-price', '#price', '.product-price', '#jd-price', '.price',
    '.p-price', '[class*="price"]', '[class*="Price"]', '#specification', '.p-parameter',
    '.J-summary', '.summary', '.sku-price', '[class*="sku-price"]',
  ];

  function collect() {
    const selPresence = {};
    for (const s of selList) {
      try {
        const els = Array.from(document.querySelectorAll(s));
        const vis = els.filter(visible);
        selPresence[s] = { total: els.length, visible: vis.length, firstText: vis[0] ? textOf(vis[0]).slice(0, 120) : '' };
      } catch (e) { selPresence[s] = { error: String(e).slice(0, 80) }; }
    }

    const PRICE_RE = /^[¥￥]?\s*\d[\d,.]{0,9}\s*(?:起)?$/;
    const priceLeaves = [];
    const keyTexts = [];
    try {
      for (const el of document.querySelectorAll('body *')) {
        if (el.children.length > 0 || !visible(el)) continue;
        const t = textOf(el);
        if (!t || t.length > 40) continue;
        const st = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        if (PRICE_RE.test(t)) {
          if (priceLeaves.length < 60) {
            priceLeaves.push({
              text: t, cls: String(el.className || '').slice(0, 90), id: el.id || '',
              fontSize: st.fontSize, color: st.color, fontWeight: st.fontWeight,
              top: Math.round(rect.top), left: Math.round(rect.left), chain: chainOf(el, 4),
            });
          }
        } else if (/到手价|会员价|PLUS|电商平台价|券后|折上|满\s*\d|减\s*\d|省\s*\d|补贴|返/.test(t)) {
          if (keyTexts.length < 80) {
            keyTexts.push({ text: t.slice(0, 120), cls: String(el.className || '').slice(0, 90), top: Math.round(rect.top), fontSize: st.fontSize, chain: chainOf(el, 3) });
          }
        }
      }
    } catch (e) { /* ignore */ }

    const containerHtml = [];
    for (const s of ['.summary-price', '.p-price', '#price', '.product-price', '[class*="price"]']) {
      let els = [];
      try { els = Array.from(document.querySelectorAll(s)).filter(visible).slice(0, 2); } catch (e) { els = []; }
      for (const el of els) {
        containerHtml.push({
          selector: s,
          cls: String(el.className || '').slice(0, 90),
          html: (el.outerHTML || '').replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').slice(0, 2500),
        });
      }
    }

    const offlineCtx = [];
    try {
      const bodyText = norm(document.body ? document.body.innerText : '');
      const re = /已下架|已下柜|商品不存在|已售罄|暂无报价|无货/g;
      let m;
      while ((m = re.exec(bodyText)) && offlineCtx.length < 12) {
        offlineCtx.push(bodyText.slice(Math.max(0, m.index - 60), m.index + 80));
      }
    } catch (e) { /* ignore */ }

    let bodyText = '';
    try { bodyText = norm(document.body ? document.body.innerText : '').slice(0, 6000); } catch (e) { bodyText = ''; }

    let pageHtml = '';
    try {
      pageHtml = (document.documentElement.outerHTML || '').replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').slice(0, 1400000);
    } catch (e) { pageHtml = ''; }

    const skuMatch = location.pathname.match(/(\d{6,})\.html/);
    return {
      schema: 'jd-price-diag.v1',
      at: new Date().toISOString(),
      url: location.href,
      sku: skuMatch ? skuMatch[1] : '',
      title: document.title,
      readyState: document.readyState,
      viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
      selectors: selPresence,
      h1s: Array.from(document.querySelectorAll('h1')).slice(0, 4).map((x) => textOf(x).slice(0, 160)),
      bodyText,
      offlineCtx,
      priceLeaves,
      keyTexts,
      containerHtml,
      pageHtml,
    };
  }

  function hint(text, sticky) {
    const badge = document.createElement('div');
    badge.textContent = text;
    badge.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;background:#111827;color:#fff;font:13px/1.5 system-ui;padding:10px 14px;border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.35);max-width:460px;';
    document.documentElement.appendChild(badge);
    return badge;
  }

  function save(data) {
    const json = JSON.stringify(data, null, 1);
    const name = 'jd-diag-' + (data.sku || 'unknown') + '-' + Date.now() + '.json';
    const badge = hint('取价诊断采集中…');
    try {
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.documentElement.appendChild(a);
      a.click();
      setTimeout(() => {
        try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ }
        a.remove();
      }, 5000);
      badge.textContent = '取价诊断已保存到下载目录：' + name + '（把文件名告诉我就行；关闭诊断请点扩展图标）';
    } catch (e) {
      badge.textContent = '保存失败：' + String(e).slice(0, 120);
    }
    try { chrome.storage.local.set({ lastDiag: { name, at: data.at, sku: data.sku, size: json.length } }); } catch (e) { /* ignore */ }
    window.__jdPriceDiagDone = true;
  }

  // 页面可能异步渲染价格：先等 2.2s 收集一次，若没看到价格再等 2.5s 重收
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  async function run() {
    const tip = hint('取价诊断已开启：约 3 秒后保存 1 个 JSON 到下载目录（关闭：点扩展图标）');
    await wait(2200);
    let data = collect();
    const hasPrice = data.priceLeaves.length > 0 ||
      (data.selectors['.summary-price'] && data.selectors['.summary-price'].visible > 0) ||
      (data.selectors['.p-price'] && data.selectors['.p-price'].visible > 0);
    if (!hasPrice) {
      await wait(2500);
      data = collect();
    }
    try { tip.remove(); } catch (e) { /* ignore */ }
    save(data);
  }

  // 只有诊断开关开启时才执行；默认关闭，不会自动下载
  try {
    chrome.storage.local.get({ diagEnabled: false }, (s) => {
      if (!s || !s.diagEnabled) return;
      run();
    });
  } catch (e) { /* ignore */ }
})();
