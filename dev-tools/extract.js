// 内部调试脚本：在目标页面里执行的通用提取器（不随扩展发布）
(() => {
  const norm = (t) => (t || '').replace(/\s+/g, ' ').trim();
  const cls = (el) => (el && typeof el.className === 'string' ? el.className : '');
  const cookieNames = (document.cookie || '')
    .split(';')
    .map((s) => s.trim().split('=')[0])
    .filter(Boolean);

  const text = norm(document.body ? document.body.innerText : '').slice(0, 4000);

  const links = Array.from(document.querySelectorAll('a[href*="item.shop.example.com/"]'))
    .slice(0, 8)
    .map((a) => ({ href: a.getAttribute('href'), text: norm(a.textContent).slice(0, 50) }));

  const priceCandidates = [];
  const seen = new Set();
  Array.from(document.querySelectorAll('span, strong, em, i, div, p, b')).forEach((el) => {
    if (el.children.length) return;
    const t = norm(el.textContent);
    if (!t || t.length > 50) return;
    if (!/[¥￥]/.test(t)) return;
    const m = t.match(/[¥￥]\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/);
    if (!m) return;
    const num = m[1];
    let label = '';
    let cur = el.parentElement;
    for (let i = 0; i < 3 && cur; i++) {
      const ct = norm(cur.textContent);
      if (ct && ct.length <= 80) label = ct;
      cur = cur.parentElement;
    }
    const key = num + '|' + label.slice(0, 40);
    if (seen.has(key)) return;
    seen.add(key);
    priceCandidates.push({
      num: num,
      text: t.slice(0, 60),
      cls: cls(el).slice(0, 120),
      label: label.slice(0, 80)
    });
  });

  const flags = {
    plusText: /PLUS|plus会员|会员价/i.test(text),
    loginText: /登录|请登录|扫码登录/i.test(text),
    cartText: /购物车/.test(text),
    captchaText: /验证|滑块|安全验证/i.test(text)
  };

  return {
    url: location.href,
    title: document.title,
    ready: document.readyState,
    cookieNames: cookieNames,
    flags: flags,
    links: links,
    priceCandidates: priceCandidates.slice(0, 40),
    text: text
  };
})()
