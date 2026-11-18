// 电商平台价格巡检 · 商品页取价脚本 v2.1
//
// 与 v1.x 的区别（针对「读到别的商品价格」的高错误率）：
//   1. 不再全页扫描价格：优先取「首屏内、看得见、字号最大」的那个价格
//      （电商平台商品页的到手价永远是大号红字，电商平台价是旁边的小号灰字）。
//   2. 显式排除跨平台比价卡片 / 关联购买 / 推荐位 / 广告位（这些卡片里也有「到手价」字样，
//      之前的版本因此把 76% 的会员价读成了别的商品的 8499 / 1999）。
//   3. 只认页面上看得见的元素（有布局尺寸、不在隐藏抽屉里、在首屏内），
//      后台标签页同样适用（后台标签页会完成布局，只是不绘制）。
//   4. 数字被拆成多个节点时先拼回完整文本再解析，拒绝「56」这种小数片段。
//   5. 上报时附带价格元素的位置和视口尺寸，供工作台按位置裁剪截图交给 AI 复核。
//   6. v2.1：连续 3 次（约 1.5 秒）读数一致才算稳定；之后每 1.2 秒再复核一次（最多 4 次），
//      以「页面最终刷新后的价格」为准，并把价格变化（priceChanges）一起上报。
//
// 工具只读页面 DOM，不点击、不提交、不额外发请求。
(() => {
  if (window.__jdPatrolItemV3) return;
  window.__jdPatrolItemV3 = true;
  if (location.hostname !== 'item.shop.example.com') return;

  const MIN_PLAUSIBLE_PRICE = 30;
  const MAX_WAIT_MS = 20000;
  const STABLE_ROUNDS = 3; // 连续 3 次（约 1.5 秒）读到同一个价格才算稳定
  const MAX_FONT = 200;

  // 这些模块里虽然也有「到手价」，但不是当前商品的价格
  const EXCLUDE_CONTAINER =
    /cross_platform|continuous-product|recommend|similar|guess|like-|maylike|also-?buy|rank|banner|advert|shop-?card|shopcard|promo-?card|promotion-?card|footprint|history-?item|compare-?card|price-?compare/i;

  const norm = (t) => (t || '').replace(/\s+/g, ' ').trim();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function classOf(el) {
    if (!el) return '';
    const c = typeof el.className === 'string' ? el.className : (el.getAttribute && el.getAttribute('class')) || '';
    return c || '';
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

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    let cs;
    try {
      cs = getComputedStyle(el);
    } catch (e) {
      return false;
    }
    if (!cs || cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity || 1) <= 0) return false;
    // display:none 的祖先会让 offsetParent 为 null；fixed/sticky 例外
    if (el.offsetParent === null) {
      const pos = cs.position;
      if (pos !== 'fixed' && pos !== 'sticky') {
        const rr = el.getBoundingClientRect();
        if (rr.width <= 0 || rr.height <= 0) return false;
      }
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function inFirstScreen(r) {
    const h = window.innerHeight || 900;
    return r.top >= -30 && r.top < h;
  }

  function inExcludedContainer(el) {
    let cur = el;
    for (let i = 0; i < 10 && cur && cur !== document.body; i++) {
      const tag = (cur.tagName || '').toLowerCase();
      if (EXCLUDE_CONTAINER.test(classOf(cur) + ' ' + (cur.id || '') + ' ' + tag)) return true;
      cur = cur.parentElement;
    }
    return false;
  }

  function fontOf(el) {
    try {
      const n = parseFloat(getComputedStyle(el).fontSize);
      return isFinite(n) ? Math.min(MAX_FONT, n) : 0;
    } catch (e) {
      return 0;
    }
  }

  // 只接受「一个完整价格」的文本：
  //   ¥15699 / 15,699 / 15699.00 / ¥8607.56
  // 拒绝：56、5、.56、5折、5期、满5件、月供5、评价5
  function parsePriceText(text) {
    const s = norm(text);
    if (!s || s.length > 24) return null;
    if (/[折期件满减%人年星分]|白条|免息|定金|尾款|月供|评价|销量|已售|优惠|券后立减/.test(s)) return null;
    const m = s.match(/^[¥￥]?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*[元起]?$/);
    if (!m) return null;
    const raw = m[1].replace(/,/g, '');
    const n = parseFloat(raw);
    if (!isFinite(n) || n < MIN_PLAUSIBLE_PRICE) return null;
    const intPart = raw.split('.')[0].replace(/^0+/, '');
    // 没有「¥」前缀时必须是 3 位以上整数，避免把 5 / 56 / .56 这种片段当价格
    // （带「¥」的两位数是合法的「¥99」，但这类 SKU 在本基表里不存在，仍保留兜底）
    if (intPart.length < 3 && !/[¥￥]/.test(s)) return null;
    return n;
  }

  // 取元素附近（自己 + 前一个兄弟 + 父级直接文本）的标签文本，用来判断价格类型
  function labelNear(el) {
    const parts = [];
    const own = norm(el.textContent);
    if (own) parts.push(own.slice(0, 30));
    let prev = el.previousElementSibling;
    for (let i = 0; i < 2 && prev; i++) {
      const t = norm(prev.textContent);
      if (t && t.length <= 30) parts.push(t.slice(0, 30));
      prev = prev.previousElementSibling;
    }
    const p = el.parentElement;
    if (p) {
      for (const node of Array.from(p.childNodes)) {
        if (node.nodeType === 3) {
          const t = norm(node.nodeValue);
          if (t) parts.push(t.slice(0, 30));
        } else if (node !== el) {
          const t = norm(node.textContent);
          if (t && t.length <= 20) parts.push(t.slice(0, 20));
        }
      }
    }
    return parts.join(' ');
  }

  function kindFromLabel(label, font) {
    if (/PLUS|plus|会员价|会员专享/.test(label)) return 'plus';
    if (/到手价|预估到手|券后|券后价|到手/.test(label)) return 'hand';
    if (/电商平台价|前台价|原价|划线价/.test(label)) return 'main';
    // 没有标签时：大字号基本就是到手价，小字号多半是电商平台价
    return font >= 18 ? 'hand' : 'main';
  }

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

  // 相邻文本拼接：价格被拆在相邻节点时（￥ / 8,607 / .56 分处相邻 span 或文本节点）拼回完整文本。
  // 2026-11-10 取价边界修复：只补「同一价格容器内的邻接拼接」，不放宽 parsePriceText 对
  // 56 / .56 / 5折 / 满5000减500 这类独立片段的拒绝规则（那些片段本身依然解析失败）。
  function combinedPriceText(el) {
    const own = norm(el.textContent);
    let text = own;
    const next = el.nextElementSibling;
    const prev = el.previousElementSibling;
    if (next) {
      const nt = norm(next.textContent);
      if (nt && /^[.,]?\d{1,2}$/.test(nt) && /[0-9]$/.test(text)) text += nt;
      else if (nt && /^[¥￥]/.test(nt)) text = nt + text;
    }
    if (prev) {
      const pt = norm(prev.textContent);
      if (pt && /^[¥￥]$/.test(pt)) text = pt + text;
    }
    return text;
  }

  // 收集页面上「看得见、不在排除模块里、文本是一个完整价格」的元素
  function collectPriceElements(allowBelowFold) {
    const out = [];
    let nodes;
    try {
      nodes = document.querySelectorAll('span,strong,em,i,b,div,p,dt,dd,a');
    } catch (e) {
      nodes = [];
    }
    const seen = new Set();
    for (const el of nodes) {
      if (out.length >= 600) break;
      if (!el || !el.isConnected) continue;
      let text = norm(el.textContent);
      if (!text || text.length > 24) continue;
      let price = parsePriceText(text);
      if (price == null) {
        // 文本被拆开时（￥8,607 / .56、￥ / 8,607.56）拼回完整价格再解析
        const combined = combinedPriceText(el);
        if (combined && combined !== text) {
          text = combined;
          price = parsePriceText(combined);
        }
      }
      if (price == null || price < MIN_PLAUSIBLE_PRICE) continue;
      // 本元素只是拆分价格的「整数片段」（后面紧跟 .56 这类小数节点）时跳过，
      // 让拼接后的完整价格（父容器/相邻文本）成为候选，避免把 8607.56 读成 8607。
      const nextText = el.nextElementSibling ? norm(el.nextElementSibling.textContent) : '';
      if (nextText && /^\.[0-9]{1,2}$/.test(nextText) && combinedPriceText(el) !== norm(el.textContent)) continue;
      if (!isVisible(el)) continue;
      if (inExcludedContainer(el)) continue;
      const r = el.getBoundingClientRect();
      if (!allowBelowFold && !inFirstScreen(r)) continue;
      const key = price + '|' + Math.round(r.top) + '|' + Math.round(r.left) + '|' + Math.round(r.width);
      if (seen.has(key)) continue;
      seen.add(key);
      const font = fontOf(el);
      const label = labelNear(el);
      const c = {
        el: el,
        price: price,
        font: font,
        strike: isStrike(el),
        label: label.slice(0, 60),
        cls: classOf(el).slice(0, 80),
        rect: { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }
      };
      c.kind = c.strike ? 'main' : kindFromLabel(label, font);
      out.push(c);
    }
    return out;
  }

  // 选价：字号最大的那个价格 = 当前商品的到手价（电商平台商品页的一贯排版）
  function pickFromCandidates(cands) {
    if (!cands.length) return { hand: null, main: null, plus: null, source: '' };
    const sorted = cands.slice().sort((a, b) => {
      if (b.font !== a.font) return b.font - a.font;
      return a.rect.top - b.rect.top || a.rect.left - b.rect.left;
    });
    const biggest = sorted[0];
    const hand =
      sorted.find((c) => c.kind === 'hand' && c.font >= biggest.font - 2) ||
      (biggest.kind !== 'main' ? biggest : null) ||
      null;
    // 电商平台价：同区域里字号更小的、带电商平台价标签或被划掉的。
    // 2026-11-10 取价边界修复：main 选择优先取「带电商平台价/原价/划线价标签」或划线特征的候选，
    // 再按原字号/位置顺序；避免侧栏优惠券金额（￥500，top 更靠上、字号相同）顶掉真正的电商平台价。
    // 只影响 main 字段，hand 的选价逻辑不变（S15 无到手价标签时仍由这里回退 main）。
    const mainPool = sorted.filter((c) => c !== hand && c.kind === 'main' && c.font <= (hand ? hand.font : 999));
    const hasMainLabel = (c) => /电商平台价|前台价|原价|划线价/.test(c.label);
    let main = mainPool.find((c) => hasMainLabel(c)) || mainPool.find((c) => c.strike) || mainPool[0] || null;
    if (!main && hand) {
      main = sorted.find((c) => c !== hand && c.strike && Math.abs(c.rect.top - hand.rect.top) < 160);
    }
    if (!main) main = sorted.find((c) => c !== hand && c.font < (hand ? hand.font : 999)) || null;
    let plus = sorted.find((c) => c.kind === 'plus' && c !== hand) || null;
    if (hand && plus && plus.price === hand.price) plus = null;
    const pack = (c, kind) => (c ? { price: c.price, kind: kind, cls: c.cls, label: c.label, rect: c.rect } : null);
    return {
      hand: pack(hand, 'hand'),
      main: pack(main, 'main'),
      plus: pack(plus, 'plus'),
      source: hand ? hand.cls : main ? main.cls : ''
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

  // 等价格稳定：连续两次取到同一个合理价格（最多 20 秒）
  // 优先等到「到手价（大字号）」稳定；老页面没有到手价标签时，最多等 6 秒就接受主价格
  async function waitForStablePrice() {
    const started = Date.now();
    let lastBest = null;
    let stable = 0;
    let picked = null;
    let lastCands = [];
    while (Date.now() - started < MAX_WAIT_MS) {
      let cands = collectPriceElements(false);
      if (!cands.length) cands = collectPriceElements(true); // 首屏没有时放宽到整页（仍排除推荐/比价模块）
      picked = pickFromCandidates(cands);
      lastCands = cands;
      const best = bestPriceOf(picked);
      if (best != null && lastBest === best) {
        stable++;
      } else {
        stable = 0;
        lastBest = best;
      }
      if (best != null && stable >= STABLE_ROUNDS) {
        const waited = Date.now() - started;
        // 到手价往往比电商平台价晚渲染：没拿到到手价时多等一会儿
        if ((picked && picked.hand) || waited > 6000) return { picked, cands };
      }
      await sleep(500);
    }
    return { picked, cands: lastCands };
  }

  function send(message) {
    try {
      chrome.runtime.sendMessage(message, () => {
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
      type: 'PATROL_ITEM_PRICE_RESULT',
      sku: sku,
      url: location.href,
      title: getTitle(),
      at: new Date().toISOString(),
      account: account,
      viewport: { w: window.innerWidth || 0, h: window.innerHeight || 0 }
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

    const stable = await waitForStablePrice();
    if (!stable.cands.length || !stable.picked || bestPriceOf(stable.picked) == null) {
      send(Object.assign({}, base, {
        ok: false,
        reason: flags.offSale ? '商品已下架/页面没有价格' : '页面上没有识别到价格（页面可能改版或未加载完）',
        flags: pageFlags(),
        main: null,
        plus: null,
        hand: null,
        candidates: stable.cands.slice(0, 8).map((c) => ({
          price: c.price, kind: c.kind, text: c.label, cls: c.cls, font: c.font, strike: c.strike
        }))
      }));
      return;
    }

    // 复核：页面价格可能在「券/促销计算」后又刷新一次（实测出现过 24699 → 25099 这种 400 元变化）。
    // 稳定之后再等 1.2 秒重新读，直到两次读数一致才作为最终价；不一致就以最新一次为准并记录变化。
    let picked = stable.picked;
    let cands = stable.cands;
    const changes = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      await sleep(1200);
      const fresh = collectPriceElements(true);
      const freshPicked = pickFromCandidates(fresh);
      const before = bestPriceOf(picked);
      const after = bestPriceOf(freshPicked);
      if (after == null) break; // 页面反而没价了，保留上一个结果
      picked = freshPicked;
      cands = fresh;
      if (before != null && Math.abs(before - after) > 0.005) {
        changes.push({ from: before, to: after });
        continue; // 价格刚变过，再给一轮确认
      }
      break;
    }
    const hand = picked.hand || picked.main || picked.plus;
    const priceRect = hand && hand.rect ? hand.rect : null;

    send(Object.assign({}, base, {
      ok: true,
      reason: '',
      flags: pageFlags(),
      main: picked.main,
      plus: picked.plus,
      hand: picked.hand,
      source: picked.source || '',
      rect: priceRect,
      priceChanges: changes,
      candidates: cands.slice(0, 12).map((c) => ({
        price: c.price, kind: c.kind, text: c.label, cls: c.cls, font: c.font, strike: c.strike
      }))
    }));
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'PATROL_PING') {
      sendResponse({ ok: true, sku: skuFromLocation(), url: location.href });
    }
  });

  main().catch((e) => {
    try {
      send({
        type: 'PATROL_ITEM_PRICE_RESULT',
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
