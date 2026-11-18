// 内部调试脚本：购物车页专用提取器（在页面里执行，不随扩展发布）
(() => {
  const norm = (t) => (t || '').replace(/\s+/g, ' ').trim();
  const classOf = (el) => {
    if (!el) return '';
    const c = el.className;
    return typeof c === 'string' ? c : (el.getAttribute && el.getAttribute('class')) || '';
  };

  function skuFromHref(href) {
    if (!href) return null;
    const s = String(href);
    const m =
      s.match(/item\.jd\.com\/(\d+)\.html/) ||
      s.match(/item\.m\.jd\.com\/product\/(\d+)\.html/) ||
      s.match(/[?&]sku(?:Id)?=(\d+)/);
    return m ? m[1] : null;
  }

  function yen(text) {
    const out = [];
    const re = /[¥￥]\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/g;
    let m;
    while ((m = re.exec(text || '')) !== null) {
      const n = parseFloat(m[1].replace(/,/g, ''));
      if (!isNaN(n) && n > 0) out.push(n);
    }
    return out;
  }

  const out = {
    url: location.href,
    host: location.hostname,
    title: document.title,
    ready: document.readyState,
    isLoginPage: /passport\.jd\.com/.test(location.hostname),
    cookieNames: (document.cookie || '')
      .split(';')
      .map((s) => s.trim().split('=')[0])
      .filter(Boolean)
      .slice(0, 80),
    bodyTextHead: norm(document.body ? document.body.innerText : '').slice(0, 2500),
    selectorHits: {},
    anchors: [],
    rows: []
  };

  ['#cart-list', '.cart-list', '[class*="cart-list"]', '.cart-main', '#cart-main', '[class*="cart-main"]', '.item-item', '.item-item.J-tbd', '[data-sku]', '.cart-item', '.p-price', '.p-name', 'input[type="checkbox"]'].forEach((sel) => {
    try {
      out.selectorHits[sel] = document.querySelectorAll(sel).length;
    } catch (e) {
      out.selectorHits[sel] = -1;
    }
  });

  const anchors = Array.from(document.querySelectorAll('a[href*="item.shop.example.com/"], a[href*="item.m.shop.example.com/product/"]'));
  out.anchorCount = anchors.length;
  anchors.slice(0, 80).forEach((a) => {
    out.anchors.push({
      href: a.getAttribute('href'),
      sku: skuFromHref(a.getAttribute('href')),
      text: norm(a.textContent).slice(0, 80),
      cls: classOf(a).slice(0, 120)
    });
  });

  const bySku = new Map();
  anchors.forEach((a) => {
    const sku = skuFromHref(a.getAttribute('href'));
    if (sku && !bySku.has(sku)) bySku.set(sku, a);
  });

  function climb(node) {
    let cur = node;
    for (let i = 0; i < 14 && cur && cur !== document.body; i++) {
      const text = norm(cur.textContent);
      if (text.length > 4000) break;
      let hasControl = false;
      try {
        hasControl = !!(cur.querySelector && cur.querySelector('input[type="checkbox"], input[type="text"], input[type="number"], [class*="checkbox"], [class*="check-"], [class*="quantity"], [class*="num-box"], [class*="stepper"]'));
      } catch (e) {
        hasControl = false;
      }
      if (yen(text).length && hasControl) return cur;
      cur = cur.parentElement;
    }
    cur = node;
    for (let i = 0; i < 14 && cur && cur !== document.body; i++) {
      const text = norm(cur.textContent);
      if (text.length > 4000) break;
      if (yen(text).length) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  for (const entry of bySku.entries()) {
    const sku = entry[0];
    const a = entry[1];
    const row = climb(a);
    if (!row) {
      out.rows.push({ sku: sku, note: 'no row found' });
      continue;
    }
    const rowText = norm(row.textContent);
    const priceCandidates = [];
    Array.from(row.querySelectorAll('span, strong, em, i, b, div, p')).forEach((el) => {
      if (el.children.length) return;
      const t = norm(el.textContent);
      if (!t || t.length > 50) return;
      let num = null;
      const nums = yen(t);
      if (nums.length) {
        num = nums[0];
      } else if (/price/i.test(classOf(el))) {
        const m = t.match(/([0-9][0-9,]*(?:\.[0-9]{1,2})?)/);
        if (m) {
          const v = parseFloat(m[1].replace(/,/g, ''));
          if (!isNaN(v) && v > 0) num = v;
        }
      }
      if (num == null) return;
      let label = '';
      let cur = el.parentElement;
      for (let k = 0; k < 4 && cur; k++) {
        const ct = norm(cur.textContent);
        if (ct && ct.length <= 90) label = ct;
        cur = cur.parentElement;
      }
      priceCandidates.push({ num: num, text: t.slice(0, 60), cls: classOf(el).slice(0, 120), label: label.slice(0, 90) });
    });

    const seen = new Set();
    const cands = priceCandidates.filter((c) => {
      const k = c.num + '|' + c.text;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    let title = '';
    Array.from(row.querySelectorAll('a[href*="item.shop.example.com/"]')).forEach((x) => {
      const t = norm(x.textContent);
      if (t && t.length > title.length) title = t;
    });
    if (!title) {
      const img = row.querySelector('img[alt]');
      if (img) title = norm(img.getAttribute('alt'));
    }

    let quantity = '';
    const q = row.querySelector('input[type="text"], input[type="number"], [class*="quantity"], [class*="num-box"]');
    if (q) quantity = String(q.value || norm(q.textContent) || '').slice(0, 10);

    out.rows.push({
      sku: sku,
      title: title,
      rowClass: classOf(row).slice(0, 200),
      anchors: Array.from(row.querySelectorAll('a[href*="item.shop.example.com/"], a[href*="item.m.shop.example.com/"]'))
        .slice(0, 6)
        .map((x) => ({ href: x.getAttribute('href'), text: norm(x.textContent).slice(0, 60) })),
      priceCandidates: cands.slice(0, 15),
      rowText: rowText.slice(0, 400),
      hasCheckbox: !!row.querySelector('input[type="checkbox"], [class*="checkbox"]'),
      quantity: quantity
    });
  }

  out.rowCount = out.rows.length;
  out.plusTextInBody = /PLUS|会员价/i.test(out.bodyTextHead);
  out.loginTextInBody = /登录|请登录|扫码登录/.test(out.bodyTextHead);
  return out;
})()
