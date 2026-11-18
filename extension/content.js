// 电商平台价格巡检 · 商品页取价脚本 v1.1
//
// 在商品详情页(item.shop.example.com)读取页面已经渲染出来的价格：
//   main  = 页面主价格（通常是电商平台价）
//   plus  = PLUS 会员价（登录 PLUS 账号时页面会展示）
//   hand  = 到手价（页面有「到手价/预估到手」标签时）
//
// v1.1 重点修复「第一次读到 5 这种不完整价格」：
//   - 价格数字常被拆成多个节点/有动画，第一次可能只读到其中一位数字；
//     现在会等价格稳定（连续两次取到同一个合理价格）再上报，最多等 20 秒；
//   - 过滤「5折 / 5期 / 满5件 / 单数字片段」这类疑似价格；
//   - 合理价格下限 30 元，低于下限的候选不参与选价。
//
// 工具只读页面 DOM，不点击、不提交、不额外发请求。
(() => {
  if (window.__jdPatrolItemV2) return;
  window.__jdPatrolItemV2 = true;
  if (location.hostname !== 'item.shop.example.com') return;

  const MIN_PLAUSIBLE_PRICE = 30;
  const MAX_WAIT_MS = 20000;
  const STABLE_ROUNDS = 2;

  const norm = (t) => (t || '').replace(/\s+/g, ' ').trim();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function classOf(el) {
    if (!el) return '';
    const c = el.className;
    return typeof c === 'string' ? c : (el.getAttribute && el.getAttribute('class')) || '';
  }

  function readCookie(name) {
    let cookieStr = '';
    try {
      cookieStr = document.cookie || '';
    } catch (e) {
      cookieStr = '';
    }
    const m = cookieStr.match(new RegExp('(?:^|;)\\s*' + name + '=([^;]*)'));
    if (!m) return '';
    try {
      return decodeURIComponent(m[1]);
    } catch (e) {
      return m[1];
    }
  }

  function skuFromLocation() {
    const m =
      location.pathname.match(/\/(\d{6,})\.html/) ||
      location.search.match(/[?&]sku(?:Id)?=(\d{6,})/) ||
      location.href.match(/item\.jd\.com\/(\d{6,})/);
    return m ? m[1] : '';
  }

  function extractPrice(text, isPriceClass) {
    const m = String(text || '').match(/[¥￥]\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/);
    if (m) {
      const n = parseFloat(m[1].replace(/,/g, ''));
      if (!isNaN(n) && n > 0) return n;
    }
    if (isPriceClass) {
      const m2 = String(text || '').match(/^[^0-9]*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/);
      if (m2) {
        const n = parseFloat(m2[1].replace(/,/g, ''));
        if (!isNaN(n) && n > 0) return n;
      }
    }
    return null;
  }

  function getTitle() {
    const sels = ['.sku-name', '#name h1', '[class*="sku-name"]', '.itemInfo-wrap h1', '.product-intro h1'];
    for (const sel of sels) {
      let el = null;
      try {
        el = document.querySelector(sel);
      } catch (e) {
        el = null;
      }
      const t = norm(el && el.textContent);
      if (t) return t.slice(0, 120);
    }
    let t = norm(document.title);
    t = t.replace(/【[^】]*】/g, '').replace(/\s*-\s*电商平台.*$/, '').trim();
    return t.slice(0, 120);
  }

  function detectAccount() {
    const result = { nickname: '', plusHint: false, source: '' };
    const nick = norm(readCookie('unick') || readCookie('pin'));
    if (nick) {
      result.nickname = nick.slice(0, 30);
      result.source = 'cookie';
    }
    if (!result.nickname) {
      const sels = ['#ttbar-userinfo', '[class*="nickname"]', '[class*="user-name"]', '[class*="user-info"]'];
      for (const sel of sels) {
        let el = null;
        try {
          el = document.querySelector(sel);
        } catch (e) {
          el = null;
        }
        if (!el) continue;
        const t = norm(el.textContent);
        if (t && t.length <= 30 && !/登录|注册|购物车|首页|我的电商平台/.test(t)) {
          result.nickname = t.replace(/^(你好|您好)[，,\s]*/, '').trim();
          result.source = 'dom';
          break;
        }
      }
    }
    const bodyText = norm(document.body ? document.body.innerText : '').slice(0, 6000);
    result.plusHint = /PLUS会员|会员价|PLUS价/i.test(bodyText);
    return result;
  }

  function pageFlags() {
    const text = norm(document.body ? document.body.innerText : '');
    const head = text.slice(0, 6000);
    return {
      verify: /滑块验证|安全验证|验证码|请完成验证|拖动滑块|访问过于频繁/i.test(head),
      offSale: /该商品已下架|商品已下架|已下柜|已售完/.test(head),
      plusText: /PLUS会员价|PLUS价/i.test(head)
    };
  }

  // 划线价（原价/电商平台价）通常在 <del>/<s>/<strike> 或带 line-through 的样式里，
  // 这类数字不是当前到手价，必须排除。
  function isStrike(el) {
    let cur = el;
    for (let i = 0; i < 3 && cur && cur !== document.body; i++) {
      const tag = (cur.tagName || '').toLowerCase();
      if (tag === 'del' || tag === 's' || tag === 'strike') return true;
      try {
        const cs = getComputedStyle(cur);
        const deco = (cs && (cs.textDecorationLine || cs.textDecoration)) || '';
        if (/line-through/i.test(deco)) return true;
      } catch (e) {
        // 忽略
      }
      cur = cur.parentElement;
    }
    return false;
  }

  // 疑似非价格文本：折扣、期数、件数、人数、满减等
  function looksLikeUnitText(text) {
    return /[折期件人年月天星分%]|满\s*\d|第\s*\d|前\s*\d|白条|免息|定金|尾款/.test(String(text || ''));
  }

  function isSingleDigitFragment(text) {
    const t = String(text || '').replace(/[¥￥,.\s]/g, '');
    return /^[0-9]{1,2}$/.test(t) && !/[¥￥]/.test(String(text || ''));
  }

  function collectCandidates() {
    const roots = [];
    const rootSelectors = [
      '#price',
      '.summary-price',
      '.price-info',
      '.p-price',
      '.sku-price',
      '[class*="summary-price"]',
      '[class*="price-box"]',
      '[class*="priceBox"]',
      '[class*="price-info"]',
      '.itemInfo-wrap',
      '.product-intro'
    ];
    for (const sel of rootSelectors) {
      try {
        document.querySelectorAll(sel).forEach((el) => {
          if (roots.indexOf(el) < 0) roots.push(el);
        });
      } catch (e) {
        // 忽略无效选择器
      }
    }

    const elements = [];
    const seenEl = new Set();
    const pushScope = (root) => {
      try {
        root.querySelectorAll('span,strong,em,i,b,div,p').forEach((el) => {
          if (seenEl.has(el)) return;
          seenEl.add(el);
          elements.push(el);
        });
      } catch (e) {
        // 忽略
      }
    };
    roots.forEach(pushScope);
    if (!elements.length) {
      try {
        document.querySelectorAll('span,strong,em,i,b,div,p').forEach((el) => {
          if (elements.length >= 5000) return;
          if (seenEl.has(el)) return;
          seenEl.add(el);
          elements.push(el);
        });
      } catch (e) {
        // 忽略
      }
    }

    const cands = [];
    const seenKey = new Set();
    for (const el of elements) {
      if (!el || !el.isConnected) continue;
      if (el.children.length > 3) continue;
      const text = norm(el.textContent);
      if (!text || text.length > 40) continue;
      const cls = classOf(el);
      const id = el.id || '';
      const clsId = cls + ' ' + id;
      const priceClass = /price/i.test(clsId);
      const hasSymbol = /[¥￥]/.test(text);
      if (!hasSymbol && !priceClass) continue;
      const price = extractPrice(text, priceClass);
      if (price == null) continue;
      // 划线价（原价/电商平台价）不是到手价，直接跳过
      if (isStrike(el)) continue;
      if (/old|origin|market|strike|del|through|line-through|save|saving|discount/i.test(clsId)) continue;

      let label = '';
      let cur = el.parentElement;
      for (let i = 0; i < 4 && cur && cur !== document.body; i++) {
        const ct = norm(cur.textContent);
        if (ct && ct.length <= 90) label = ct;
        cur = cur.parentElement;
      }
      const labelText = norm(label);
      const ctx = labelText + ' ' + clsId + ' ' + text;
      let kind = 'unknown';
      if (/plus|PLUS|会员价|会员专享/i.test(ctx)) kind = 'plus';
      else if (/到手|预估到手|券后|预估/i.test(ctx)) kind = 'hand';
      else if (/电商平台价|京\s*东\s*价/i.test(ctx)) kind = 'main';

      const suspect =
        price < MIN_PLAUSIBLE_PRICE ||
        isSingleDigitFragment(text) ||
        (looksLikeUnitText(text) && !hasSymbol);

      const key = price + '|' + kind + '|' + cls.slice(0, 40) + '|' + text.slice(0, 20);
      if (seenKey.has(key)) continue;
      seenKey.add(key);
      cands.push({
        price: price,
        text: text.slice(0, 60),
        cls: cls.slice(0, 160),
        id: id.slice(0, 60),
        label: labelText.slice(0, 100),
        kind: kind,
        suspect: suspect,
        digits: String(Math.round(price)).length
      });
    }

    // 精准标签法：电商平台价格区一般有「电商平台价 / 到手价 / PLUS会员价」标签，
    // 按标签找到同一容器里的价格，比全页扫描更不容易读错。
    let labelEls = [];
    try {
      labelEls = Array.from(document.querySelectorAll('span,strong,em,b,i,div,dt,dd,p,label'));
    } catch (e) {
      labelEls = [];
    }
    for (const el of labelEls) {
      if (el.children.length > 0) continue;
      const raw = norm(el.textContent).replace(/[：:\s]/g, '');
      if (!raw || raw.length > 10) continue;
      let kind = '';
      if (/plus|会员/i.test(raw)) kind = 'plus';
      else if (/到手|券后/i.test(raw)) kind = 'hand';
      else if (/电商平台价/i.test(raw)) kind = 'main';
      if (!kind) continue;
      let box = el.parentElement;
      for (let depth = 0; depth < 3 && box; depth++) {
        // 优先在容器内找「非划线价」的价格节点
        let price = null;
        try {
          const priceEls = box.querySelectorAll('span,strong,em,i,b,del,s');
          for (const pe of priceEls) {
            if (pe.children.length > 0) continue;
            if (isStrike(pe)) continue;
            const p = extractPrice(norm(pe.textContent), true);
            if (p != null && p >= MIN_PLAUSIBLE_PRICE) {
              price = p;
              break;
            }
          }
        } catch (e) {
          price = null;
        }
        // 容器内找不到时，退回整段文本
        if (price == null) {
          const text = norm(box.textContent);
          if (text && text.length <= 70 && !/line-through/i.test(classOf(box))) {
            const p = extractPrice(text, true);
            if (p != null && p >= MIN_PLAUSIBLE_PRICE) price = p;
          }
        }
        if (price != null) {
          const key = 'L' + price + '|' + kind;
          if (!seenKey.has(key)) {
            seenKey.add(key);
            cands.push({
              price: price,
              text: norm(box.textContent).slice(0, 60),
              cls: classOf(el).slice(0, 120),
              id: '',
              label: raw,
              kind: kind,
              suspect: false,
              strong: true,
              digits: String(Math.round(price)).length
            });
          }
          break;
        }
        box = box.parentElement;
      }
    }

    for (const c of cands) {
      const ctx = c.cls + ' ' + c.id;
      let score = 0;
      if (/price|summary|info/i.test(ctx)) score += 6;
      if (/price/i.test(ctx)) score += 4;
      if (/[¥￥]/.test(c.text)) score += 2;
      if (c.digits >= 3) score += 2;
      if (c.kind === 'main') score += 3;
      else if (c.kind === 'hand') score += 2;
      else if (c.kind === 'plus') score += 1;
      if (c.strong) score += 15;
      if (/old|origin|market|strike|del|through/i.test(ctx + ' ' + c.label)) score -= 12;
      if (/合计|总计|小计|运费|优惠|满减|已售|评价|销量|分期|月供|白条|定金|尾款/i.test(c.label)) score -= 10;
      if (c.price <= 0 || c.price > 2000000) score -= 30;
      if (c.suspect) score -= 25;
      c.score = score;
    }
    cands.sort((a, b) => b.score - a.score);
    return cands;
  }

  function mergeCandidates(listA, listB) {
    const map = new Map();
    for (const c of listA.concat(listB)) {
      const key = c.price + '|' + c.kind + '|' + c.cls.slice(0, 40) + '|' + c.text.slice(0, 20);
      const prev = map.get(key);
      if (!prev || c.score > prev.score) map.set(key, c);
    }
    return Array.from(map.values()).sort((a, b) => b.score - a.score);
  }

  function pickPrices(cands) {
    const usable = cands.filter((c) => c && !c.suspect && c.price >= MIN_PLAUSIBLE_PRICE);
    const best = (kind) => usable.find((c) => c.kind === kind) || null;
    let mainCand = best('main');
    if (!mainCand) mainCand = usable.find((c) => c.kind !== 'plus') || null;
    let plusCand = best('plus');
    let handCand = best('hand');
    // 交叉校验：到手价/PLUS 价正常不应高于主价格，高于就丢弃，防止误判
    const mainPrice = mainCand ? mainCand.price : null;
    if (mainPrice != null) {
      if (handCand && handCand.price > mainPrice * 1.02) handCand = null;
      if (plusCand && plusCand.price > mainPrice * 1.02) plusCand = null;
    }
    const pack = (c, kind) => (c ? { price: c.price, kind: kind, cls: c.cls, label: c.label } : null);
    return {
      main: pack(mainCand, 'main'),
      plus: pack(plusCand, 'plus'),
      hand: pack(handCand, 'hand')
    };
  }

  function bestPriceOf(picked) {
    if (!picked) return null;
    return (
      (picked.hand && picked.hand.price) ||
      (picked.main && picked.main.price) ||
      (picked.plus && picked.plus.price) ||
      null
    );
  }

  // 等价格稳定：连续多次取到同一个合理价格，避免读到价格动画/懒加载的中间值
  async function waitForStablePrice() {
    const started = Date.now();
    let lastBest = null;
    let stable = 0;
    let cands = [];
    while (Date.now() - started < MAX_WAIT_MS) {
      cands = collectCandidates();
      if (cands.length) {
        const picked = pickPrices(cands);
        const best = bestPriceOf(picked);
        if (best != null && lastBest === best) {
          stable++;
        } else {
          stable = 0;
          lastBest = best;
        }
        if (best != null && stable >= STABLE_ROUNDS) return cands;
      }
      await sleep(500);
    }
    return cands;
  }

  function send(message) {
    try {
      chrome.runtime.sendMessage(message, () => {
        // 工作台没开时会有 lastError，忽略即可
        void chrome.runtime.lastError;
      });
    } catch (e) {
      // 忽略
    }
  }

  async function main() {
    const sku = skuFromLocation();
    const account = detectAccount();
    const base = {
      type: 'ITEM_PRICE_RESULT',
      sku: sku,
      url: location.href,
      title: getTitle(),
      at: new Date().toISOString(),
      account: account
    };

    const flags = pageFlags();
    if (flags.verify) {
      send(Object.assign({}, base, {
        ok: false,
        reason: '页面要求安全验证（可能触发风控），建议暂停/降低频率',
        flags: flags,
        candidates: [],
        main: null,
        plus: null,
        hand: null
      }));
      return;
    }

    let cands = await waitForStablePrice();
    if (!cands.length) {
      send(Object.assign({}, base, {
        ok: false,
        reason: flags.offSale ? '商品已下架/页面没有价格' : '页面上没有识别到价格（页面可能改版或未加载完）',
        flags: flags,
        candidates: [],
        main: null,
        plus: null,
        hand: null
      }));
      return;
    }

    // 再等一小会儿并重新扫一次，合并（PLUS 价/到手价有时比主价格晚渲染）
    await sleep(900);
    cands = mergeCandidates(cands, collectCandidates());
    const picked = pickPrices(cands);
    const best = bestPriceOf(picked);
    const finalFlags = pageFlags();

    if (best == null) {
      const suspects = cands.filter((c) => c.suspect).slice(0, 8);
      send(Object.assign({}, base, {
        ok: false,
        reason:
          suspects.length > 0
            ? '取到的价格疑似不完整（例如只读到数字片段/促销角标），已跳过，建议重采'
            : '页面上没有识别到价格（页面可能改版或未加载完）',
        flags: finalFlags,
        main: null,
        plus: null,
        hand: null,
        candidates: suspects.length ? suspects : cands.slice(0, 8)
      }));
      return;
    }

    send(Object.assign({}, base, {
      ok: true,
      reason: '',
      flags: finalFlags,
      main: picked.main,
      plus: picked.plus,
      hand: picked.hand,
      candidates: cands.slice(0, 20).map((c) => ({
        price: c.price,
        kind: c.kind,
        text: c.text,
        cls: c.cls,
        label: c.label,
        score: c.score,
        suspect: c.suspect
      }))
    }));
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'PING') {
      sendResponse({ ok: true, sku: skuFromLocation(), url: location.href });
    }
  });

  main().catch((e) => {
    try {
      send({
        type: 'ITEM_PRICE_RESULT',
        sku: skuFromLocation(),
        url: location.href,
        title: getTitle(),
        at: new Date().toISOString(),
        account: { nickname: '', plusHint: false, source: '' },
        ok: false,
        reason: '取价脚本异常：' + ((e && e.message) || e),
        flags: null,
        main: null,
        plus: null,
        hand: null,
        candidates: []
      });
    } catch (e2) {
      // 忽略
    }
  });
})();
