// ============================================================================
// 竞品价格雷达 · 商品页取价引擎 v2.0（只读 DOM）
// ----------------------------------------------------------------------------
// 设计目标：把「当前商品的价格」和页面里其他商品/促销数字严格分开。
//
// 取价规则（按优先级）：
//   1. 只在「商品主价格区」里找价：优先 product-price / summary-price / #price 等
//      容器；这些容器不在首屏或被隐藏时才退回全页，但仍排除推荐/比价/广告模块。
//   2. 显式拉黑跨平台比价卡片（cross_platform_*）、关联购买/常购
//      （continuous-product*）、推荐/广告/榜单/足迹/搭配购等模块。
//   3. 只认页面上真正可见的元素：display/visibility/opacity、祖先隐藏、
//      零尺寸、屏幕外一律跳过（后台标签页也会完成布局，同样适用）。
//   4. 数字被拆成多个节点时先拼回完整价格；拒绝 56 / .56 / 5 折 / 满 5000 减 500
//      这类片段与促销文案。
//   5. 等价格"定格"：连续 3 次读数一致才算稳定；稳定后每 0.9 秒再复核，
//      以页面最终刷新后的价格为准（电商平台券后价常二次计算），并记录 priceChanges。
//   6. 给出置信度：主价格区 + 「到手价」标签 = high；仅靠字号/位置兜底 = low，
//      低置信度在插件里只作为「待核对」提示，不直接当成准确读数。
//
// 只读页面 DOM，不点击、不提交、不发额外请求。
// ============================================================================
(() => {
  if (window.__priceRadarV1) return;
  window.__priceRadarV1 = true;

  const HOST_OK = /(^|\.)item\.jd\.com$/i.test(location.hostname) || /(^|\.)item\.jd\.hk$/i.test(location.hostname);
  if (!HOST_OK) return;

  const ENGINE = 'priceradar-dom/2.0';
  const MIN_PRICE = 20;
  const MAX_PRICE = 9999999;
  const MAX_WAIT_MS = 20000;
  const STABLE_ROUNDS = 3; // 连续 3 次（约 1.2 秒）读数一致才算稳定
  const MAX_FONT = 240;

  // 这些模块里虽然也可能出现「到手价」，但不是当前商品的价格。
  const EXCLUDE_CONTAINER =
    /cross_platform|crossplatform|continuous-product|continuousproduct|recommend|similar|guess|like-|maylike|also-?buy|rank|banner|advert|shop-?card|shopcard|promo-?card|promotion-?card|footprint|history-?item|compare-?card|cross-?compare|price-?compare|accessor|bundle|gift-?card|installment|coupon-?card|jump-?card|hot-?sale|hot-?list|top-?list|qrcode|live-?card|video-?card|store-?card|brand-?card|floor-(?:item|list|container|content|nav)|recommend-?wrap|guess-?like|page-right-(?:discount|lachine|ranking|reserve|calc)/i;

  // 下架 / 不存在页面的文字特征。
  // 「已下架」单独出现在推荐位里很常见，所以拆成强特征和弱特征：
  // 强特征（页面不存在 / 该商品已下架 / 已下柜…）只要没有价格就判下架；
  // 弱特征（裸的“已下架”）只有「没有商品名」时才判下架。
  const STRONG_OFFLINE_TEXT_RE =
    /该商品已下架|商品已下架|此商品已下架|很抱歉[，,]\s*该商品已下架|已下柜|该商品已删除|商品已删除|该商品不存在|商品不存在|页面不存在|您访问的页面不存在|您查看的商品找不到了|找不到该商品|该商品已失效|商品已失效|该商品无法购买/i;
  const OFFLINE_TEXT_RE =
    /该商品已下架|商品已下架|此商品已下架|很抱歉[，,]\s*该商品已下架|已下柜|该商品已删除|商品已删除|该商品不存在|商品不存在|页面不存在|您访问的页面不存在|您查看的商品找不到了|找不到该商品|商品已失效|该商品已失效|该商品无法购买|已下架/i;
  const NO_PAGE_TEXT_RE =
    /页面不存在|商品不存在|该商品不存在|您访问的页面不存在|您查看的商品找不到了|找不到该商品|商品已删除|该商品已删除|商品已失效|该商品已失效|已下柜|该商品无法购买/i;
  const UNAVAILABLE_TEXT_RE =
    /暂无报价|该商品暂时无货|商品暂时无货|暂时无货|到货通知|该商品已抢光|已抢光|库存不足|该商品已售完|商品已售完|已售完|已售罄|售罄/i;
  const OFFLINE_TITLE_RE = /已下架|下柜|商品不存在|页面不存在|已删除|已失效|找不到|无法购买/i;
  const OFFLINE_NOTICE_SELECTOR =
    '[class*="offline"],[id*="offline"],[class*="sold-out"],[class*="soldout"],[class*="no-goods"],[class*="not-found"],[class*="error-page"],[class*="item-over"],[class*="invalid"],[class*="no-stock"],[class*="unavailable"]';
  const OFFLINE_HEADING_SELECTOR = 'h1,h2,h3,.tip,.msg,.error-msg,[class*="tip"],[class*="msg"]';

  // 主价格区（命中任意一个就加分，并作为「锁区」依据）
  const MAIN_ZONE_SELECTOR = [
    '.product-price',
    '[class*="product-price"]',
    '.page-right-price',
    '[class*="page-right-price"]',
    '.product-price-panel',
    '[class*="product-price-panel"]',
    '[class*="product-price--main"]',
    '[class*="product-price--value"]',
    '.summary-price',
    '[class*="summary-price"]',
    '#price',
    '[class*="price-panel"]',
    '[class*="price-area"]',
    '[class*="priceBox"]',
    '[class*="price-box"]',
    '[class*="price-wrap"]',
    '[class*="price-container"]',
    '[class*="priceInfo"]',
    '[class*="p-price"]',
    '.itemInfo-wrap .price',
    '.product-intro .price',
    '[class*="price-activity"]'
  ];

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
      location.pathname.match(/\/(\d{6,20})\.html/) ||
      location.search.match(/[?&]sku(?:Id)?=(\d{6,20})/) ||
      location.href.match(/item\.jd\.(?:com|hk)\/(\d{6,20})/);
    return m ? m[1] : '';
  }

  // ---------------- 可见性 / 位置 / 排除模块 ----------------
  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    let cs;
    try {
      cs = getComputedStyle(el);
    } catch (e) {
      return false;
    }
    if (!cs) return false;
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
    if (Number(cs.opacity || 1) <= 0) return false;
    // 祖先隐藏（display:none 的祖先会让 offsetParent 为 null；fixed/sticky 例外）
    if (el.offsetParent === null && cs.position !== 'fixed' && cs.position !== 'sticky') {
      const rr = el.getBoundingClientRect();
      if (rr.width <= 0 || rr.height <= 0) return false;
    }
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return false;
    // 原生 API（新版 Chromium 支持）：一次性检查祖先的 display/visibility/opacity
    try {
      if (typeof el.checkVisibility === 'function') {
        if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
      }
    } catch (e) {
      // 老版本没有这个 API，忽略
    }
    return true;
  }

  function inFirstScreen(r) {
    const h = window.innerHeight || 900;
    const w = window.innerWidth || 1400;
    if (r.bottom < 0 || r.top > h || r.right < 0 || r.left > w) return false;
    return r.top >= -40 && r.top < h * 0.98;
  }

  function inExcludedContainer(el) {
    let cur = el;
    for (let i = 0; i < 12 && cur && cur !== document.body; i++) {
      const tag = (cur.tagName || '').toLowerCase();
      if (tag === 'aside' || tag === 'footer' || tag === 'nav') return true;
      const mark = classOf(cur) + ' ' + (cur.id || '') + ' ' + (cur.getAttribute && cur.getAttribute('data-type') || '') + ' ' + tag;
      if (EXCLUDE_CONTAINER.test(mark)) return true;
      cur = cur.parentElement;
    }
    return false;
  }

  function inMainZone(el) {
    let cur = el;
    for (let i = 0; i < 9 && cur && cur !== document.body; i++) {
      for (const sel of MAIN_ZONE_SELECTOR) {
        try {
          if (cur.matches && cur.matches(sel)) return true;
        } catch (e) {
          // 忽略非法选择器
        }
      }
      const cls = classOf(cur);
      if (/(product-price|page-right-price|summary-price|price-panel|price-area|priceBox|price-box|price-wrap|price-container|priceInfo|p-price|price-activity)/i.test(cls)) return true;
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

  function depthOf(el) {
    let d = 0;
    let cur = el;
    while (cur && cur !== document.body && d < 30) {
      d++;
      cur = cur.parentElement;
    }
    return d;
  }

  // ---------------- 文本 → 价格 ----------------
  // 只接受「一个完整价格」：¥15699 / 15,699 / 15699.00 / ¥8607.56
  // 拒绝：56、.56、5折、5期、满5件、月供5、评价5、¥5000-500…
  function parsePriceText(text) {
    const s = norm(text);
    if (!s || s.length > 26) return null;
    if (/[折期件满减%人年星分]|白条|免息|定金|尾款|月供|评价|销量|已售|优惠|立减|补贴|红包|赠|换购|加购|以旧换新|定金|预售|元起|起售|日均|每天|每小时/.test(s)) return null;
    if (/^[0-9]+\s*[-~至]\s*[0-9]+$/.test(s)) return null; // 价格区间
    const m = s.match(/^[¥￥]?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*(?:元)?$/);
    if (!m) return null;
    const raw = m[1].replace(/,/g, '');
    const n = parseFloat(raw);
    if (!isFinite(n) || n < MIN_PRICE || n > MAX_PRICE) return null;
    const intPart = raw.split('.')[0].replace(/^0+/, '');
    // 没有「¥」前缀时必须是 3 位以上整数，避免把 5 / 56 / .56 这种片段当价格
    if (intPart.length < 3 && !/[¥￥]/.test(s)) return null;
    return n;
  }

  function textOf(el) {
    return norm(el && el.textContent);
  }

  // 取元素附近的标签文本 + 祖先 class 提示，用来判断价格类型
  function labelNear(el) {
    const parts = [];
    const own = textOf(el);
    if (own) parts.push(own.slice(0, 40));
    let prev = el.previousElementSibling;
    for (let i = 0; i < 3 && prev; i++) {
      const t = textOf(prev);
      if (t && t.length <= 30) parts.push(t.slice(0, 30));
      prev = prev.previousElementSibling;
    }
    let next = el.nextElementSibling;
    for (let i = 0; i < 2 && next; i++) {
      const t = textOf(next);
      if (t && t.length <= 20) parts.push(t.slice(0, 20));
      next = next.nextElementSibling;
    }
    const p = el.parentElement;
    if (p) {
      for (const node of Array.from(p.childNodes)) {
        if (node.nodeType === 3) {
          const t = norm(node.nodeValue);
          if (t) parts.push(t.slice(0, 30));
        } else if (node !== el) {
          const t = textOf(node);
          if (t && t.length <= 24) parts.push(t.slice(0, 24));
        }
      }
      let cur = p;
      for (let i = 0; i < 3 && cur && cur !== document.body; i++) {
        const cls = classOf(cur);
        if (cls) parts.push(cls.slice(0, 80));
        cur = cur.parentElement;
      }
      // 新版电商平台详情页（2026）：价格和「到手价/电商平台价」标签是同一个面板下的兄弟节点，
      // 例如 .product-price--main > .product-price--value 与外层 .product-price--activity-item--tag 同级，
      // 所以再看一层祖父节点的其它子节点文字，避免漏掉标签。
      const gp = p.parentElement;
      if (gp && gp !== document.body) {
        for (const node of Array.from(gp.childNodes)) {
          if (node.nodeType === 3) {
            const t = norm(node.nodeValue);
            if (t && t.length <= 20) parts.push(t.slice(0, 20));
          } else if (node !== p && node.nodeType === 1) {
            const t = textOf(node);
            if (t && t.length <= 20) parts.push(t.slice(0, 20));
          }
        }
        const gpCls = classOf(gp);
        if (gpCls) parts.push(gpCls.slice(0, 80));
      }
    }
    return parts.join(' ').slice(0, 300);
  }

  function kindFromLabel(label, font) {
    if (/PLUS|plus|会员价|会员专享|企业价|plusPrice/i.test(label)) return 'plus';
    if (/到手价|预估到手|券后|券后价|到手|活动价|秒杀价|直播价/i.test(label)) return 'hand';
    if (/电商平台价|前台价|原价|划线价|市场价|日常价|参考价/i.test(label)) return 'main';
    // 没有标签时：大字号基本就是到手价，小字号多半是电商平台价
    return font >= 18 ? 'hand' : 'main';
  }

  function isStrike(el) {
    let cur = el;
    for (let i = 0; i < 4 && cur && cur !== document.body; i++) {
      const tag = (cur.tagName || '').toLowerCase();
      if (tag === 'del' || tag === 's' || tag === 'strike') return true;
      try {
        const cs = getComputedStyle(cur);
        const deco = (cs && (cs.textDecorationLine || cs.textDecoration)) || '';
        if (/line-through/i.test(deco)) return true;
        if (cs && /line-through/i.test(cs.textDecorationLine || '')) return true;
      } catch (e) {
        // 忽略
      }
      cur = cur.parentElement;
    }
    // 新版电商平台详情页：划线价容器（.product-price--gray）本身没有 line-through，
    // 真正划线的是它里面的 .product-price--gray-line-through；所以再看一层子元素。
    try {
      const inner = el.querySelectorAll('del,s,strike,span,div,i,em');
      for (let i = 0; i < inner.length && i < 8; i++) {
        const cs = getComputedStyle(inner[i]);
        const deco = (cs && (cs.textDecorationLine || cs.textDecoration)) || '';
        if (/line-through/i.test(deco)) return true;
      }
    } catch (e) {
      // 忽略
    }
    return false;
  }

  // 相邻文本节点拼接：¥8,607 + .56 / ¥ + 8607.56
  function combinedText(el) {
    const own = textOf(el);
    let text = own;
    const next = el.nextElementSibling;
    const prev = el.previousElementSibling;
    if (next) {
      const nt = textOf(next);
      if (nt && /^[.,]?\d{1,2}$/.test(nt) && /[0-9]$/.test(text)) text += nt;
      else if (nt && /^[¥￥]/.test(nt)) text = nt + text;
    }
    if (prev) {
      const pt = textOf(prev);
      if (pt && /^[¥￥]$/.test(pt)) text = pt + text;
    }
    return text;
  }

  // ---------------- 候选价格收集 ----------------
  function collectPriceElements(allowBelowFold) {
    const out = [];
    let nodes;
    try {
      nodes = document.querySelectorAll('span,strong,em,i,b,div,p,dt,dd,a,ins');
    } catch (e) {
      nodes = [];
    }
    const seen = new Map();
    for (const el of nodes) {
      if (out.length >= 700) break;
      if (!el || !el.isConnected) continue;
      let text = textOf(el);
      if (!text || text.length > 30) continue;
      let price = parsePriceText(text);
      if (price == null) {
        // 文本被拆开时（¥8607 / .56）拼回完整价格再解析
        const combined = combinedText(el);
        if (combined && combined !== text) {
          text = combined;
          price = parsePriceText(combined);
        }
      }
      if (price == null) continue;
      // 如果这个元素只是带小数的片段（例如 "8607" 后面紧跟 ".56"），跳过片段，
      // 让它的父容器/拼接后的完整价格成为候选
      const nt = el.nextElementSibling ? textOf(el.nextElementSibling) : '';
      if (nt && /^\.[0-9]{1,2}$/.test(nt) && combinedText(el) !== text) continue;
      if (!isVisible(el)) continue;
      if (inExcludedContainer(el)) continue;
      const r = el.getBoundingClientRect();
      if (!allowBelowFold && !inFirstScreen(r)) continue;
      const font = fontOf(el);
      const label = labelNear(el);
      const strike = isStrike(el);
      const mainZone = inMainZone(el);
      const depth = depthOf(el);
      let kind = strike ? 'main' : kindFromLabel(label, font);
      const rect = {
        left: Math.round(r.left),
        top: Math.round(r.top),
        width: Math.round(r.width),
        height: Math.round(r.height)
      };
      // 位置 / 字号 / 主价格区 / 标签 综合打分：
      // 电商平台商品页的到手价永远是主价格区里字号最大的红字。
      let score = Math.min(font, 80);
      if (mainZone) score += 70;
      if (kind === 'hand') score += 20;
      if (kind === 'plus') score += 14;
      if (kind === 'main') score += 4;
      if (strike) score -= 24;
      if (/到手价|券后价|预估到手/.test(label)) score += 14;
      if (r.top < (window.innerHeight || 900) * 0.55) score += 8;
      if (r.left > (window.innerWidth || 1400) * 0.38) score += 6;

      const candidate = {
        el: el,
        price: price,
        font: font,
        strike: strike,
        label: label.slice(0, 120),
        cls: classOf(el).slice(0, 100),
        rect: rect,
        mainZone: mainZone,
        depth: depth,
        kind: kind,
        score: score
      };
      // 同一个价格元素会被父/子节点重复命中：按位置 + 价格合并，保留信息更全的一条
      const key = price + '|' + Math.round(rect.top / 10) + '|' + Math.round(rect.left / 10);
      const old = seen.get(key);
      if (old) {
        old.font = Math.max(old.font, font);
        old.mainZone = old.mainZone || mainZone;
        old.strike = old.strike || strike;
        old.depth = Math.max(old.depth, depth);
        old.score = Math.max(old.score, score);
        if (label && old.label.indexOf(label) < 0) old.label = (old.label + ' ' + label).slice(0, 200);
        if (strike) old.kind = 'main';
        else if (kind === 'hand' || (kind === 'plus' && old.kind === 'main')) old.kind = kind;
        continue;
      }
      seen.set(key, candidate);
      out.push(candidate);
    }
    return out;
  }

  // 选价：主价格区里字号最大的「到手价」= 当前商品价格
  function pickFromCandidates(cands) {
    if (!cands.length) return { hand: null, main: null, plus: null, source: '', confidence: 'none' };
    const sorted = cands.slice().sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.font !== a.font) return b.font - a.font;
      return a.rect.top - b.rect.top || a.rect.left - b.rect.left;
    });
    const inZone = sorted.filter((c) => c.mainZone && !c.strike);
    const pool = inZone.length ? inZone : sorted;
    const biggest = pool[0];

    // 到手价：优先「有到手价标签 + 主价格区 + 字号接近最大」的候选
    let hand =
      pool.find((c) => c.kind === 'hand' && !c.strike && c.font >= biggest.font - 3) ||
      pool.find((c) => c.kind === 'hand' && !c.strike && c.font >= biggest.font * 0.7) ||
      (biggest && biggest.kind !== 'main' && !biggest.strike ? biggest : null) ||
      null;
    // 2026-11-10 取价对齐巡检 v2.1：不再把「主价格区里唯一的大字号 main（如只有电商平台价标签）」强行当 hand。
    // 巡检的口径是「电商平台价 → main，hand 只在有到手价标签/非 main 时才有」，这里保持同一口径；
    // 没有 hand 时价格仍由 main 兜底（bestPriceOf 会用到），不影响采集。

    // 电商平台价：同区域里字号更小的、带电商平台价标签或被划掉的
    let main = null;
    if (hand) {
      main =
        sorted.find((c) => c !== hand && c.kind === 'main' && c.font <= hand.font && Math.abs(c.rect.top - hand.rect.top) < 220) ||
        sorted.find((c) => c !== hand && c.strike && Math.abs(c.rect.top - hand.rect.top) < 160) ||
        null;
    }
    if (!main) main = sorted.find((c) => c !== hand && c.kind === 'main' && (!hand || c.font < hand.font)) || null;
    if (!main && hand) main = sorted.find((c) => c !== hand && c.strike) || null;

    let plus = sorted.find((c) => c.kind === 'plus' && !c.strike && (!hand || c.price !== hand.price)) || null;
    if (hand && plus && plus.price === hand.price) plus = null;

    const pack = (c) => (c ? {
      price: c.price,
      kind: c.kind,
      cls: c.cls,
      label: c.label,
      font: Math.round(c.font * 10) / 10,
      rect: c.rect,
      mainZone: c.mainZone,
      score: Math.round(c.score * 10) / 10
    } : null);

    // 置信度按「最终采信的那条价格」算（有 hand 用 hand，无 hand 回退 main）：
    // 主价格区 + 到手价标签 = high；只命中其中之一 = medium；纯字号/位置兜底 = medium/low。
    let confidence = 'low';
    const confSubject = hand || main;
    if (confSubject) {
      const labeled = /到手价|券后价|预估到手/.test(confSubject.label);
      if (confSubject.mainZone && labeled) confidence = 'high';
      else if (confSubject.mainZone || labeled) confidence = 'medium';
      else if (confSubject.font >= 24 && !confSubject.strike) confidence = 'medium';
    }
    return {
      hand: pack(hand),
      main: pack(main),
      plus: pack(plus),
      source: hand ? hand.cls : main ? main.cls : '',
      confidence: confidence
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

  // ---------------- 页面信息 ----------------
  function getTitle() {
    const sels = ['.sku-title-name', '.sku-title', '[class*="sku-title"]', '[class*="product-title"]', '.sku-name', '#name h1', '[class*="sku-name"]', '.itemInfo-wrap h1', '.product-intro h1'];
    for (const sel of sels) {
      let el = null;
      try {
        el = document.querySelector(sel);
      } catch (e) {
        el = null;
      }
      const t = norm(el && el.textContent);
      if (t) return t.slice(0, 160);
    }
    let t = norm(document.title);
    t = t.replace(/【[^】]*】/g, '').replace(/\s*-\s*电商平台.*$/, '').trim();
    return t.slice(0, 160);
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
    const bodyText = norm(document.body ? document.body.innerText : '').slice(0, 8000);
    result.plusHint = /PLUS会员|会员价|PLUS价|企业价/i.test(bodyText);
    return result;
  }

  function hasProductName() {
    const sels = ['.sku-title-name', '.sku-title', '[class*="sku-title"]', '[class*="product-title"]', '.sku-name', '#name h1', '[class*="sku-name"]', '.itemInfo-wrap h1', '.product-intro h1'];
    for (const sel of sels) {
      let el = null;
      try {
        el = document.querySelector(sel);
      } catch (e) {
        el = null;
      }
      if (el && norm(el.textContent).length >= 2) return true;
    }
    return false;
  }

  // 下架 / 不存在 / 无货 检测。
  // 返回 strongOffline 表示可以在页面刚加载时就直接判定（例如「页面不存在」这种整页提示），
  // 其他情况要等到确认「页面上确实没有价格」之后再据此判下架，避免把推荐位里的「已下架」误当成当前商品。
  function pageAvailability() {
    const titleText = norm(document.title);
    const bodyText = norm(document.body ? document.body.innerText : '').slice(0, 120000);
    const productName = hasProductName();
    const titleOffline = OFFLINE_TITLE_RE.test(titleText);
    const titleUnavailable = !titleOffline && UNAVAILABLE_TEXT_RE.test(titleText);
    const explicitNoPage = NO_PAGE_TEXT_RE.test(bodyText);
    const bodyOffline = OFFLINE_TEXT_RE.test(bodyText);
    const bodyStrongOffline = STRONG_OFFLINE_TEXT_RE.test(bodyText);
    const bodyUnavailable = !bodyOffline && UNAVAILABLE_TEXT_RE.test(bodyText);

    let noticeText = '';
    let noticeKind = '';
    try {
      for (const el of document.querySelectorAll(OFFLINE_NOTICE_SELECTOR)) {
        if (!isVisible(el)) continue;
        const t = norm(el.textContent);
        if (!t || t.length > 180) continue;
        if (OFFLINE_TEXT_RE.test(t) || NO_PAGE_TEXT_RE.test(t)) {
          noticeText = t;
          noticeKind = 'offline';
          break;
        }
        if (!noticeKind && UNAVAILABLE_TEXT_RE.test(t)) {
          noticeText = t;
          noticeKind = 'unavailable';
        }
      }
      if (!noticeText) {
        for (const el of document.querySelectorAll(OFFLINE_HEADING_SELECTOR)) {
          if (!isVisible(el) || inExcludedContainer(el)) continue;
          const t = norm(el.textContent);
          if (!t || t.length > 120) continue;
          if (OFFLINE_TEXT_RE.test(t) || NO_PAGE_TEXT_RE.test(t)) {
            noticeText = t;
            noticeKind = 'offline';
            break;
          }
        }
      }
    } catch (e) {
      // 忽略
    }
    const noticeOffline = noticeKind === 'offline';
    const noticeUnavailable = noticeKind === 'unavailable';
    const noticeStrong = noticeOffline && (STRONG_OFFLINE_TEXT_RE.test(noticeText) || NO_PAGE_TEXT_RE.test(noticeText));

    const genericTitle = /电商平台\s*\(JD\.COM\)|电商平台商城|电商平台首页/i.test(titleText) && !titleOffline;
    // 可以直接早停的强信号：标题、整页「页面不存在/商品不存在」、或没有商品名的强下架提示
    const strongOffline = titleOffline || explicitNoPage ||
      (noticeStrong && (!productName || NO_PAGE_TEXT_RE.test(noticeText))) ||
      (noticeOffline && !productName);

    // 强特征（该商品已下架、商品不存在、页面不存在等）只有「没有商品名」时才据此判下架；
    // 有商品名时交给标题/提示容器，避免推荐位的「该商品已下架」误伤正常商品。
    const offSale = titleOffline || explicitNoPage || noticeStrong ||
      (bodyStrongOffline && !productName) || (noticeOffline && !productName) || (bodyOffline && !productName);
    const unavailable = !offSale && (titleUnavailable || noticeUnavailable || (bodyUnavailable && !productName));
    let reason = '';
    if (titleOffline) reason = '页面标题：' + titleText.slice(0, 80);
    else if (noticeOffline) reason = '页面提示：' + noticeText.slice(0, 80);
    else if (explicitNoPage) {
      const m = bodyText.match(NO_PAGE_TEXT_RE);
      reason = '页面提示：' + (m ? m[0] : '页面不存在');
    } else if (bodyStrongOffline) {
      const m = bodyText.match(STRONG_OFFLINE_TEXT_RE);
      reason = '页面提示：' + (m ? m[0] : '商品已下架');
    } else if (bodyOffline) {
      const m = bodyText.match(OFFLINE_TEXT_RE);
      reason = '页面提示：' + (m ? m[0] : '商品已下架');
    } else if (noticeUnavailable) {
      reason = '页面提示：' + noticeText.slice(0, 80);
    } else if (titleUnavailable) {
      reason = '页面标题：' + titleText.slice(0, 80);
    } else if (bodyUnavailable) {
      const m = bodyText.match(UNAVAILABLE_TEXT_RE);
      reason = '页面提示：' + (m ? m[0] : '商品暂时无货');
    }
    return {
      offSale: offSale,
      unavailable: unavailable,
      strongOffline: strongOffline,
      reason: reason,
      noticeText: noticeText,
      strongBodyOffline: bodyStrongOffline,
      weakOffline: bodyOffline || noticeOffline,
      hasProductName: productName,
      genericTitle: genericTitle,
      titleText: titleText,
      bodyLength: bodyText.length
    };
  }

  function pageFlags() {
    const avail = pageAvailability();
    const bodyText = norm(document.body ? document.body.innerText : '');
    const verify = /滑块验证|安全验证|验证码|请完成验证|拖动滑块|访问过于频繁|请稍后再试/i.test(bodyText.slice(0, 12000));
    const login = /请登录|账号登录|扫码登录/.test(bodyText.slice(0, 12000)) && !/我的电商平台|退出登录/.test(bodyText.slice(0, 12000));
    const offSale = avail.offSale && !login;
    return {
      verify: verify,
      offSale: offSale,
      offSaleReason: avail.reason,
      strongOffline: avail.strongOffline && !login,
      strongBodyOffline: avail.strongBodyOffline,
      weakOffline: avail.weakOffline,
      unavailable: avail.unavailable && !login,
      hasProductName: avail.hasProductName,
      genericTitle: avail.genericTitle,
      titleText: avail.titleText,
      login: login,
      plusText: /PLUS会员价|PLUS价|企业价/i.test(bodyText.slice(0, 12000)),
      pageState: verify ? 'verify' : login ? 'login' : offSale ? 'offline' : avail.unavailable ? 'unavailable' : 'product',
      bodyLength: avail.bodyLength
    };
  }

  // ---------------- 等价格定格 ----------------
  async function waitForStablePrice() {
    const started = Date.now();
    let lastBest = null;
    let stable = 0;
    let picked = null;
    let lastCands = [];
    let checkedOffline = false;
    while (Date.now() - started < MAX_WAIT_MS) {
      let cands = collectPriceElements(false);
      if (!cands.length) cands = collectPriceElements(true); // 首屏没有时放宽到整页（仍排除推荐/比价模块）
      picked = pickFromCandidates(cands);
      lastCands = cands;
      const best = bestPriceOf(picked);
      if (best != null && lastBest === best) stable++;
      else {
        stable = 0;
        lastBest = best;
      }
      if (best != null && stable >= STABLE_ROUNDS) {
        const waited = Date.now() - started;
        // 到手价往往比电商平台价晚渲染：没拿到到手价时多等一会儿
        if ((picked && picked.hand) || waited > 6000) return { picked: picked, cands: cands };
      }
      // 下架页没有价格：等 1.2 秒让页面渲染完，如果确认是下架/空页就早退，不用白等 20 秒
      if (!checkedOffline && !lastCands.length && Date.now() - started >= 1200) {
        checkedOffline = true;
        const quick = pageFlags();
        if (quick.strongOffline || (!quick.hasProductName && quick.strongBodyOffline && !quick.login && !quick.verify)) {
          return { picked: picked, cands: cands, offlineHit: true };
        }
      }
      await sleep(400);
    }
    return { picked: picked, cands: lastCands };
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

  function candidateBrief(cands) {
    return (cands || []).slice(0, 14).map((c) => ({
      price: c.price,
      kind: c.kind,
      text: c.label,
      cls: c.cls,
      font: Math.round(c.font * 10) / 10,
      strike: c.strike,
      mainZone: c.mainZone,
      score: Math.round(c.score * 10) / 10
    }));
  }

  async function main() {
    const sku = skuFromLocation();
    const account = detectAccount();
    const base = {
      type: 'RADAR_ITEM_PRICE_RESULT',
      engine: ENGINE,
      sku: sku,
      url: location.href,
      title: getTitle(),
      at: new Date().toISOString(),
      account: account,
      viewport: { w: window.innerWidth || 0, h: window.innerHeight || 0, scrollY: Math.round(window.scrollY || 0) }
    };

    const flags = pageFlags();
    if (flags.verify) {
      send(Object.assign({}, base, {
        ok: false,
        reason: '页面要求安全验证（可能触发风控），本次不记录价格',
        flags: flags,
        confidence: 'none',
        candidates: [],
        main: null,
        plus: null,
        hand: null
      }));
      return;
    }
    if (flags.login && !sku) {
      send(Object.assign({}, base, {
        ok: false,
        reason: '页面跳到了登录页，请先登录电商平台账号',
        flags: flags,
        confidence: 'none',
        candidates: [],
        main: null,
        plus: null,
        hand: null
      }));
      return;
    }
    // 强下架信号（标题/整页「页面不存在」/无商品名的下架提示）：不用等 20 秒
    if (flags.offSale && flags.strongOffline) {
      send(Object.assign({}, base, {
        ok: false,
        reason: '商品已下架 / 页面不存在（' + (flags.offSaleReason || '页面提示已下架') + '）',
        flags: flags,
        confidence: 'none',
        candidates: [],
        main: null,
        plus: null,
        hand: null
      }));
      return;
    }

    const stable = await waitForStablePrice();
    if (!stable.cands.length || !stable.picked || bestPriceOf(stable.picked) == null) {
      const finalFlags = pageFlags();
      // 有些下架页没有「已下架」字样，只是在商品 URL 下返回一个通用壳/空页；
      // 没有商品名、没有价格、标题又是电商平台通用标题时，按「商品不存在/已下架」处理。
      const genericNoProduct = !finalFlags.hasProductName && finalFlags.genericTitle && !finalFlags.login && !finalFlags.verify;
      if (genericNoProduct) {
        finalFlags.offSale = true;
        finalFlags.offSaleReason = finalFlags.offSaleReason || '页面没有商品信息（通用页/空页，商品可能已下架或不存在）';
        finalFlags.pageState = 'offline';
      }
      // 没有价格时，正文里的「该商品已下架」即使是强特征也可以判下架；
      // 有价格时才会因为可能存在推荐位误伤而只看标题/提示容器。
      if (!finalFlags.offSale && finalFlags.strongBodyOffline && !finalFlags.login && !finalFlags.verify) {
        finalFlags.offSale = true;
        finalFlags.offSaleReason = finalFlags.offSaleReason || '页面提示商品已下架/不存在';
        finalFlags.pageState = 'offline';
      }
      const reason = finalFlags.offSale
        ? '商品已下架 / 页面没有价格（' + (finalFlags.offSaleReason || '页面提示已下架') + '）'
        : finalFlags.unavailable
          ? '商品暂不可售 / 无货（' + (finalFlags.offSaleReason || '页面提示无货') + '）'
          : '页面上没有识别到价格（可能未加载完、未登录或页面改版）';
      send(Object.assign({}, base, {
        ok: false,
        reason: reason,
        flags: finalFlags,
        confidence: 'none',
        main: null,
        plus: null,
        hand: null,
        candidates: candidateBrief(stable.cands)
      }));
      return;
    }

    // 复核：页面可能在「券 / 促销计算」后又刷新一次价格（实测出现过 24699 → 25099）。
    // 稳定之后再等 0.9 秒重新读，直到两次读数一致；不一致以最新一次为准并记录变化。
    let picked = stable.picked;
    let cands = stable.cands;
    const changes = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      await sleep(900);
      let fresh = collectPriceElements(false);
      if (!fresh.length) fresh = collectPriceElements(true);
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

    // 即使页面上有数字，只要页面状态是「已下架 / 页面不存在 / 空壳页」也绝不采信。
    // 这是为了防止下架页残留的推荐位价格、缓存价格被当成当前商品价格（"编数据"）。
    const finalStatus = pageFlags();
    if (finalStatus.offSale) {
      send(Object.assign({}, base, {
        ok: false,
        reason: '商品已下架 / 页面不可售（' + (finalStatus.offSaleReason || '页面提示已下架') + '），不采信页面上的数字',
        flags: finalStatus,
        confidence: 'none',
        main: null,
        plus: null,
        hand: null,
        candidates: candidateBrief(cands)
      }));
      return;
    }
    if (finalStatus.unavailable) {
      send(Object.assign({}, base, {
        ok: false,
        reason: '商品暂不可售 / 无货（' + (finalStatus.offSaleReason || '页面提示无货') + '），不记录价格',
        flags: finalStatus,
        confidence: 'none',
        main: null,
        plus: null,
        hand: null,
        candidates: candidateBrief(cands)
      }));
      return;
    }
    if (!finalStatus.hasProductName && finalStatus.genericTitle) {
      finalStatus.offSale = true;
      finalStatus.offSaleReason = '页面没有商品信息（通用页/空页，可能已下架或不存在）';
      finalStatus.pageState = 'offline';
      send(Object.assign({}, base, {
        ok: false,
        reason: '商品已下架 / 页面没有商品信息（通用页/空页），不采信页面上的数字',
        flags: finalStatus,
        confidence: 'none',
        main: null,
        plus: null,
        hand: null,
        candidates: candidateBrief(cands)
      }));
      return;
    }
    // 页面里出现「已下架」字样、但又不是强下架页时：只有主价格区里、置信度不低的价格才采信；
    // 推荐位/残留价格一律不采信，避免下架页上的数字被当成当前价格。
    if (!finalStatus.offSale && finalStatus.weakOffline) {
      const trusted = picked.hand && picked.hand.mainZone && picked.confidence !== 'low';
      if (!trusted) {
        finalStatus.pageState = 'unknown';
        send(Object.assign({}, base, {
          ok: false,
          reason: '页面出现「已下架」相关字样，且价格不在主价格区，不采信页面上的数字',
          flags: finalStatus,
          confidence: 'none',
          main: null,
          plus: null,
          hand: null,
          candidates: candidateBrief(cands)
        }));
        return;
      }
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
      confidence: picked.confidence,
      rect: priceRect,
      priceChanges: changes,
      candidates: candidateBrief(cands)
    }));
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'RADAR_PING') {
      sendResponse({ ok: true, engine: ENGINE, sku: skuFromLocation(), url: location.href });
    }
  });

  main().catch((e) => {
    try {
      send({
        type: 'RADAR_ITEM_PRICE_RESULT',
        engine: ENGINE,
        sku: skuFromLocation(),
        url: location.href,
        title: getTitle(),
        at: new Date().toISOString(),
        account: { nickname: '', plusHint: false, source: '' },
        ok: false,
        reason: '取价脚本异常：' + ((e && e.message) || e),
        flags: null,
        confidence: 'none',
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

