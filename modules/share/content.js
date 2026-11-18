// 电商平台市占率数据工作台 · 商品页采集脚本 v2.2.0（经典脚本 IIFE，非 ES Module）
//
// 注入范围：https://item.shop.example.com/*（商品详情页），由 manifest.json 的 content_scripts 注入。
// 职责（只读页面 DOM，不点击、不提交、不发额外请求）：
//   0) 落地页三分类（v2.1.5，detectPageState）：offSale（下架→标失败继续下一条，不算风控）/
//      softAnomaly（跳首页·空页·跳转异常→工作台等待 N 秒自动继续）/ risk（验证·登录·频控→冷却+暂停）；
//      命中异常时不解析价格/尺寸（不尝试绕过风控，只识别/降频/人工通道）；
//   1) 取价（v2.1.7 移植「巡检双轨版」v2.1 算法）：只认当前商品价格区（可见/完整价格/排除比价·关联·推荐卡片），
//      优先首屏；严格完整价格解析；标签+字号+划线判 hand/plus/main；字号最大优先选价；
//      连续 3 轮同价才算稳定（≤20s）+ 稳定后复核 ≤4×1.2s，最终读数 + priceChanges；价格只认页面 DOM，
//      标题/名称里的数字绝不作为价格来源，缺失不猜；
//   2) 取标题、英寸尺寸（v2.2 尺寸段规则重定义）：规格参数表 > 规格选择区屏幕尺寸选项 >
//      页面商品标题（含【】内容）/ document.title > 主图 alt；标题类来源「唯一明确直接用，
//      多个明确按型号/规格/套餐数字做最佳匹配取一个」并标 sizeUncertain 待核对（不再直接空置）；
//      0 个明确才空置待人工。上传榜单标题在同一口径下由 lib/pipeline.analyzeReport 尽力解析；
//   3) 取型号（model）与套餐（package）：型号来自规格参数表 → 标题正则；
//      套餐来自商品页规格选择区里「版本/套餐」组的**已选中项**（如「会议大屏+摄像头【免费送装一体】」），
//      不再用标题内存规格兜底；识别不到返回 ''；
//   4) 标记风控（安全验证）、商品下架、价格疑似数字片段等异常，供工作台自动暂停/人工兜底；
//   5) 识别当前登录账号昵称（用于发现「采集中途换了账号」）；
//   6) 预览快照通道（v2.1.4）：监听 PREVIEW_CAPTURE 消息，立即读当前 DOM 回 PREVIEW_CAPTURE_RESULT
//      （小眼睛预览窗口人工逐条采集用，不等价格稳定；chrome.runtime 缺失时不抛错）。
//
// 消息协议（发给工作台页，CaptureRunner 在监听）：
//   { type:'ITEM_CAPTURE_RESULT', version, sku, ok, reason, url, title, brand,
//     pageKind:'item'|'offSale'|'softAnomaly'|'risk', offSale, softAnomaly,
//     anomaly:{reason,detail,url,title}, risk:{hit,reason,url,title,detail}, previewable,
//     price, priceKind:'hand'|'plus'|'main', priceKindLabel, priceRect:{left,top,width,height},
//     priceChanges:[{from,to}], sourceLabel, pricePick:{price,kind,source,label,rect},
//     candidates:[{price,kind,text,cls,font,strike,rect,...}],
//     size:{inch,text,source,sources,sizeUncertain}|null, sizeUncertain, sizeReason,
//     model, modelSource, package, packageSource, packageGroup,
//     specGroups:[{label,selected,options,source}], main, plus, hand, flags, account, at }
//   预览快照：PREVIEW_CAPTURE → PREVIEW_CAPTURE_RESULT（同上价格/尺寸字段，无 priceChanges）
//   另支持 PING → 立即 sendResponse({ok:true, sku, url, version})，用于确认页面脚本存活。
//
// 设计沿用「巡检插件 v1.1 / v1.2（2026-11-03）」已验证的策略（价格稳定等待 / 合理价过滤 /
// 多信号选价 / 精准标签法 / 划线价剔除 / 交叉校验 / 风控识别），并做了加固：
//   · 价格标签取「最近的价格行」而不是整块容器，避免「电商平台价」被兄弟节点的「到手价」污染；
//   · 支持一段文本里出现多个价格（拆分为多个候选），并按行内标签区分口径；
//   · 划线原价/促销角标/优惠券/月供/定金等按「类名 + 样式 + 标签关键词」多重剔除；
//   · 隐藏节点（display:none / 模版节点）不参与选价；
//   · 结构化候选完全失败时，用页面文本窗口做最后一层兜底（限定主商品区域，避免推荐位串价）。
//
// 注意：扩展目录必须保留在 ~/Desktop/市占率\extension
//      （Edge 以绝对路径加载未打包扩展；移动目录后需在 edge://extensions 重新加载）。
//      本脚本不依赖任何绝对路径。
(() => {
  'use strict';

  const VERSION = '2.2.0';
  const RESULT_TYPE = 'ITEM_CAPTURE_RESULT';

  // 防重复注入（同一页面可能被多次注入 / 手工调试注入）
  if (window.__jdMarketCaptureV2) return;
  window.__jdMarketCaptureV2 = true;

  // 本地 mock 页测试开关：content.js 正常只跑在 item.shop.example.com；
  // dev-tools/cdp_capture_test.mjs 会先设置 window.__JD_CAPTURE_FORCE__ = true 再注入本脚本。
  const FORCE_MOCK = !!window.__JD_CAPTURE_FORCE__;
  const IS_ITEM_PAGE = location.hostname === 'item.shop.example.com';
  if (!IS_ITEM_PAGE && !FORCE_MOCK) return;

  // 采集节奏参数：默认值即线上策略；测试可用 window.__JD_CAPTURE_TUNING__ 缩短等待时间。
  // v2.1.7 移植巡检双轨版 v2.1 的稳定性参数：连续 stableRounds 轮同价才算稳定（约 1.5s），
  // 稳定后再复核 recheckTimes 次（约 4×1.2s）；无 hand 时 mainWaitMs 后接受主价。
  const DEFAULT_TUNING = {
    maxWaitMs: 20000, // 价格稳定等待上限（源版 20s）
    roundIntervalMs: 500, // 每轮采样间隔（3 轮约 1.5s）
    stableRounds: 3, // 连续 N 轮读到同一价格才算稳定（源版 3）
    mainWaitMs: 6000, // 只有主价（无到手价标签）时最多等 6s
    recheckTimes: 4, // 稳定后复核次数（源版最多 4 次）
    recheckDelayMs: 1200, // 复核间隔（源版 1.2s）
    settleMs: 900, // 旧参数（v2.1 稳定后补采），保留兼容测试 tuning
    minPlausiblePrice: 30, // 合理价下限（元）：低于此值视为数字片段
    maxPlausiblePrice: 2000000 // 合理价上限（元）
  };
  const TUNING = Object.assign(
    {},
    DEFAULT_TUNING,
    (window.__JD_CAPTURE_TUNING__ && typeof window.__JD_CAPTURE_TUNING__ === 'object' && window.__JD_CAPTURE_TUNING__) || {}
  );

  // ---------------- 基础工具 ----------------
  const norm = (t) => (t == null ? '' : String(t)).replace(/\s+/g, ' ').trim();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function classOf(el) {
    if (!el) return '';
    try {
      const c = el.className;
      if (typeof c === 'string') return c;
      if (c && typeof c.baseVal === 'string') return c.baseVal; // SVG
      return (el.getAttribute && el.getAttribute('class')) || '';
    } catch (e) {
      return '';
    }
  }

  function queryAll(sel) {
    try {
      return Array.prototype.slice.call(document.querySelectorAll(sel));
    } catch (e) {
      return [];
    }
  }

  function readCookie(name) {
    const m = (document.cookie || '').match(new RegExp('(?:^|;)\\s*' + name + '=([^;]*)'));
    if (!m) return '';
    try {
      return decodeURIComponent(m[1]);
    } catch (e) {
      return m[1];
    }
  }

  // 从 URL 中取 SKU（电商平台商品页 /item.shop.example.com/{sku}.html，也兼容 ?sku= 形式，便于本地 mock 页测试）
  function skuFromLocation() {
    const patterns = [
      /item\.jd\.com\/(\d{5,})\.html/,
      /\/product\/(\d{5,})\.html/,
      /[?&](?:sku|skuId|sku_id|wareId)=(\d{5,})/i,
      /\/(\d{6,})\.html/
    ];
    for (const re of patterns) {
      const m = (location.href + '').match(re) || (location.search + '').match(re);
      if (m) return m[1];
    }
    return '';
  }

  // ---------------- 标题 / 账号 / 页面标记 ----------------
  function cleanTitle(text) {
    return norm(text)
      .replace(/【[^】]*】/g, ' ')
      .replace(/\s*[-—|]\s*电商平台(?:商城)?.*$/i, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 160);
  }

  // 返回 { text: 展示用干净标题, raw: 原始标题（尺寸提取用，保留【】里的信息）, source: dom|doc }
  function extractTitle() {
    const selectors = [
      '.sku-name',
      '#name h1',
      '#name .sku-name',
      '[class*="sku-name"]',
      '.itemInfo-wrap h1',
      '.product-intro h1',
      '#itemName',
      '.product-name',
      'h1'
    ];
    for (const sel of selectors) {
      for (const el of queryAll(sel)) {
        const raw = norm(el.textContent);
        if (raw && raw.length >= 2) {
          return { text: cleanTitle(raw) || raw.slice(0, 160), raw: raw.slice(0, 220), source: 'dom' };
        }
      }
    }
    const docRaw = norm(document.title);
    return { text: cleanTitle(docRaw), raw: docRaw.slice(0, 220), source: docRaw ? 'doc' : '' };
  }

  function detectAccount() {
    const result = { nickname: '', plusHint: false, source: '' };
    const nick = norm(readCookie('unick') || readCookie('pin'));
    if (nick) {
      result.nickname = nick.slice(0, 30);
      result.source = 'cookie';
    }
    if (!result.nickname) {
      const selectors = ['#ttbar-userinfo', '[class*="nickname"]', '[class*="user-name"]', '[class*="user-info"]'];
      for (const sel of selectors) {
        for (const el of queryAll(sel)) {
          const t = norm(el.textContent);
          if (t && t.length <= 30 && !/登录|注册|购物车|首页|我的电商平台|退出/.test(t)) {
            result.nickname = t.replace(/^(你好|您好)[，,\s]*/, '').trim().slice(0, 30);
            result.source = 'dom';
            break;
          }
        }
        if (result.nickname) break;
      }
    }
    const bodyText = norm(document.body ? document.body.innerText : '').slice(0, 6000);
    result.plusHint = /PLUS会员|会员价|PLUS价/i.test(bodyText);
    return result;
  }

  // 当前商品主信息区的可见文本（用于「下架 / 不存在」判定）。
  // 2026-11-10 取价对齐巡检 v2.1：下架文案只应在当前商品信息区里找 —— 电商平台推荐位/比价卡片里
  // 常出现「已下架」字样，之前扫全页正文会把正常商品误判成下架（巡检 v2.1 不排除推荐位正文，
  // 但它读到价格时不会因 offSale 否决；市占率是「下架即失败」，所以必须排除非当前商品模块）。
  // 风控（verify）判定仍用整页正文，风控识别不降级。
  const PRODUCT_FLAG_SELECTORS = [
    '.itemInfo-wrap',
    '.product-intro',
    '.sku-name',
    '#name',
    '.summary-price-wrap',
    '.summary-price',
    '#price',
    '.notice',
    '[class*="offline"]',
    '[class*="sold-out"]',
    '[class*="soldout"]',
    '[class*="no-goods"]',
    '[class*="not-found"]',
    '[class*="error-page"]',
    '[class*="item-over"]',
    '[class*="unavailable"]'
  ];
  const FLAG_TEXT_LIMIT = 6000;

  // 可见正文（跳过推荐/比价/广告等非当前商品模块），下架页没有商品骨架时兜底用
  function visibleBodyTextOutsideExcluded(limit) {
    const parts = [];
    let len = 0;
    const visit = (node) => {
      if (!node || len >= limit) return;
      if (node.nodeType === 3) {
        const t = norm(node.nodeValue);
        if (t) {
          parts.push(t);
          len += t.length + 1;
        }
        return;
      }
      if (node.nodeType !== 1) return;
      const tag = (node.tagName || '').toLowerCase();
      if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'template' || tag === 'head') return;
      if (node !== document.body) {
        if (inExcludedPriceContainer(node)) return;
        if (elementHidden(node)) return;
      }
      const children = node.childNodes;
      for (let i = 0; i < children.length && len < limit; i++) visit(children[i]);
    };
    try {
      visit(document.body);
    } catch (e) {
      // 忽略遍历异常
    }
    return parts.join(' ').slice(0, limit);
  }

  function productFlagText() {
    const parts = [];
    let len = 0;
    for (const sel of PRODUCT_FLAG_SELECTORS) {
      for (const el of queryAll(sel)) {
        if (len >= FLAG_TEXT_LIMIT) break;
        if (!el || !el.isConnected) continue;
        if (inExcludedPriceContainer(el)) continue;
        if (elementHidden(el)) continue;
        const t = norm(el.textContent);
        if (!t) continue;
        parts.push(t);
        len += t.length + 1;
      }
      if (len >= FLAG_TEXT_LIMIT) break;
    }
    // 没有商品骨架（整页下架/不存在提示）时，扫可见正文兜底（仍排除推荐/比价/广告位）
    if (!parts.length) parts.push(visibleBodyTextOutsideExcluded(FLAG_TEXT_LIMIT));
    return parts.join(' ').slice(0, FLAG_TEXT_LIMIT);
  }

  // 页面级标记：风控 / 下架 / PLUS 文案 / 未登录提示
  function pageFlags() {
    const bodyText = norm(document.body ? document.body.innerText : '');
    const head = bodyText.slice(0, 6000);

    // 风控：文本特征为主，同时兼容常见验证码容器（元素必须可见）
    let verify = /滑块验证|安全验证|验证码|请完成验证|拖动滑块|访问过于频繁|验证中心|电商平台验证|请稍后再试|网络环境存在风险/.test(head);
    if (!verify) {
      for (const el of queryAll('#captcha, .captcha, [class*="captcha"], [id*="captcha"], [class*="risk-verify"], .verify-wrap')) {
        if (el && el.getClientRects && el.getClientRects().length > 0) {
          verify = true;
          break;
        }
      }
    }

    // 下架只看当前商品信息区（排除推荐位/比价卡片里的「已下架」）
    const offSale = /该商品已下架|商品已下架|此商品已下柜|已下柜|商品不存在|商品已删除|该商品已删除|该商品已售完|此商品已售完|页面不存在|访问的页面不存在/.test(
      productFlagText()
    );

    return {
      verify: verify,
      offSale: offSale,
      plusText: /PLUS会员价|PLUS价|会员价/i.test(head),
      loginText: /请登录|登录后查看|扫码登录|亲，请登录/i.test(head),
      priceFragment: false // 由价格识别阶段回填
    };
  }

  // ---------------- 落地页状态分类（v2.1.5：下架 / 软异常 / 风控）----------------
  // 用户反馈（v2.1.5 第 2 条）：下架不是风控；被跳到电商平台首页但**没有**验证/登录特征也不是风控
  // （v2.1.4 直接判 risk 会导致永久暂停）。三类处理：
  //   offSale     商品下架/不存在/已售罄 → 标失败继续下一条，不冷却；
  //   softAnomaly 跳首页/频道页/空页/跳转异常但无验证特征 → 工作台等待 N 秒自动继续；
  //   risk        安全验证/登录页/验证码/访问频繁 → 冷却 + 暂停（保持 v2.1.4 行为）。
  // 只做识别/降频/人工预览通道，不尝试任何绕过手段。
  // 测试注入：window.__JD_MOCK_LOCATION__（mock 页用 file:// 打开时模拟真实 URL）。
  const RISK_TEXT_RE = /安全验证|访问过于频繁|访问频繁|请完成验证|电商平台验证|滑动验证|异常流量|请求异常|操作频繁|验证中心|网络环境存在风险|验证码|滑块验证|拖动滑块/;
  const OFF_SALE_TEXT_RE = /该商品已下架|商品已下架|此商品已下柜|已下柜|商品不存在|商品已删除|该商品已删除|该商品已售完|此商品已售完|已售罄下架|该商品已售罄|商品已失效|该商品已失效|已下架|访问的页面不存在|页面不存在/;

  function effectiveLocation() {
    const mock = window.__JD_MOCK_LOCATION__;
    if (mock && typeof mock === 'object' && mock.href) {
      return {
        href: String(mock.href),
        hostname: String(mock.hostname || ''),
        pathname: String(mock.pathname || '/'),
        search: String(mock.search || '')
      };
    }
    return {
      href: location.href,
      hostname: location.hostname || '',
      pathname: location.pathname || '/',
      search: location.search || ''
    };
  }

  function currentUrl() {
    try {
      return effectiveLocation().href || location.href;
    } catch (e) {
      return location.href;
    }
  }

  // 统一分类：{kind:'item'|'offSale'|'softAnomaly'|'risk', reason, url, title, detail,
  //           offSale, softAnomaly, risk}（布尔字段方便 capture-client 直接判断/透传）
  // reason：offSale='已下架'；softAnomaly='home'|'empty'；risk='login'|'verify'|'risk'
  function detectPageState() {
    const loc = effectiveLocation();
    const host = String(loc.hostname || '').toLowerCase();
    const pathname = String(loc.pathname || '/');
    const url = String(loc.href || location.href || '');
    const title = norm(document.title || '').slice(0, 120);
    const state = {
      kind: 'item',
      reason: '',
      url: url,
      title: title,
      detail: '',
      offSale: false,
      softAnomaly: false,
      risk: false
    };
    const mark = (kind, reason, detail) => {
      state.kind = kind;
      state.reason = reason;
      state.detail = detail;
      state.offSale = kind === 'offSale';
      state.softAnomaly = kind === 'softAnomaly';
      state.risk = kind === 'risk';
      return state;
    };

    let bodyText = '';
    try {
      bodyText = norm(document.body ? document.body.innerText : '').slice(0, 6000);
    } catch (e) {
      bodyText = '';
    }
    // 风控/登录等判断用整页正文，不降级；下架判断只看当前商品信息区（排除推荐/比价/广告位）
    const joined = bodyText + ' ' + title;
    const productJoined = productFlagText() + ' ' + title;

    // 1) 下架文案优先（下架 ≠ 风控，不冷却）
    if (OFF_SALE_TEXT_RE.test(productJoined)) {
      return mark('offSale', '已下架', '页面提示商品已下架/不存在/已售罄');
    }
    // 2) 登录页（passport.shop.example.com 等）→ risk
    if (
      /passport\.jd\.com$/i.test(host) ||
      (/jd\.com$/i.test(host) && /login|signin|passport/i.test(pathname))
    ) {
      return mark('risk', 'login', '页面跳转到电商平台登录页');
    }
    // 3) URL 含风控/验证路径 → risk
    if (/risk|verify|safe|captcha/i.test(host + pathname)) {
      return mark('risk', 'risk', 'URL 命中风控/验证路径');
    }
    // 4) 文案验证特征 → risk
    if (RISK_TEXT_RE.test(joined)) {
      return mark('risk', 'verify', '页面提示安全验证/访问频繁');
    }
    // 5) 被重定向到电商平台首页/频道页/搜索页 → softAnomaly（不算风控，等待后自动继续）
    if (/^(?:www|home|so\.m|m)\.jd\.com$/i.test(host) || host === 'shop.example.com') {
      return mark('softAnomaly', 'home', '页面被跳转到电商平台首页/频道页');
    }
    if (/^item\.jd\.com$/i.test(host) && !/\/\d+\.html/i.test(pathname)) {
      return mark('softAnomaly', 'home', '商品页 URL 被跳转到 item.shop.example.com 根路径/列表页');
    }
    // 6) 空页/跳转异常（无验证特征、无商品骨架）→ softAnomaly
    let hasSkeleton = false;
    try {
      hasSkeleton =
        queryAll('.sku-name, #name, .itemInfo-wrap, .summary-price-wrap, #choose-attrs, .product-intro').length > 0;
    } catch (e) {
      hasSkeleton = false;
    }
    if (!hasSkeleton && bodyText.length < 40) {
      return mark('softAnomaly', 'empty', '页面为空或加载异常（可能跳转失败）');
    }
    return mark('item', '', '');
  }

  // 兼容 v2.1.4 的 detectRiskPage()：现在只有 kind==='risk' 才算风险命中（跳首页/空页归软异常）
  function detectRiskPage() {
    const st = detectPageState();
    if (st.kind === 'risk') {
      return { hit: true, reason: st.reason, url: st.url, title: st.title, detail: st.detail };
    }
    return {
      hit: false,
      reason: '',
      url: st.url,
      title: st.title,
      detail: st.kind === 'item' ? '' : st.detail
    };
  }

  // 风控结果的中文原因（给 UI / 采集失败 reason 用）
  function riskReasonText(risk) {
    if (!risk || !risk.hit) return '';
    if (risk.reason === 'home') {
      return '页面被跳转到电商平台首页（疑似触发频控），已跳过采集、未解析价格；建议冷却 1 小时后再试或改用预览人工采集';
    }
    if (risk.reason === 'login') {
      return '页面跳转到电商平台登录页（登录态失效或触发频控），已跳过采集；请先登录、冷却后再试';
    }
    if (risk.reason === 'verify') {
      return '页面要求安全验证（可能触发风控），已暂停采集并跳过价格解析，建议暂停并人工确认';
    }
    return '页面疑似风控/验证页（异常落地页），已跳过采集、未解析价格；建议冷却后重试或改用预览人工采集';
  }

  // 三类异常的中文说明（给采集结果 reason / 日志用）
  function pageStateReasonText(st) {
    if (!st) return '';
    if (st.kind === 'offSale') return '已下架（页面提示商品下架/不存在/已售罄）';
    if (st.kind === 'softAnomaly') {
      if (st.reason === 'empty') return '页面为空或跳转异常（非风控），等待后自动继续采集';
      return '页面被跳转到电商平台首页/频道页（非风控），等待后自动继续采集';
    }
    if (st.kind === 'risk') {
      return riskReasonText({ hit: true, reason: st.reason });
    }
    return '';
  }

  // ---------------- 价格识别 ----------------
  const PRICE_ROOT_SELECTORS = [
    '#price',
    '.summary-price',
    '.summary-price-wrap',
    '.price-info',
    '.p-price',
    '.sku-price',
    '#priceBox',
    '[class*="summary-price"]',
    '[class*="price-box"]',
    '[class*="priceBox"]',
    '[class*="price-info"]',
    '[class*="jd-price"]',
    '.itemInfo-wrap',
    '.product-intro'
  ];

  // 明显不是「商品价格」的上下文关键词（优惠券/满减/月供/销量等）
  const NON_PRICE_WORDS = /优惠券|优惠|满减|满\d|减\d|定金|尾款|运费|邮费|合计|总计|小计|月供|分期|白条|已售|售出|评价|销量|收藏|人付款|关注|赠品|礼包|京豆|积分|可省|立减|首付/;
  const STRUCK_WORDS = /old|origin|market|strike|through|del-|line-through|price-old|原价|划线/i;

  function elementHidden(el) {
    try {
      if (!el || !el.getClientRects || el.getClientRects().length === 0) return true;
      return false;
    } catch (e) {
      return false;
    }
  }

  // 划线价（原价/电商平台价）：<del>/<s>/<strike> 或自身/3 层祖先 line-through → 不是当前到手价，剔除。
  // （移植巡检 2026-11-03 版的 isStrike：样式判定比只看类名更可靠）
  function isStrike(el) {
    let node = el;
    for (let i = 0; i < 4 && node && node !== document.body; i++, node = node.parentElement) {
      const tag = (node.tagName || '').toLowerCase();
      if (tag === 'del' || tag === 's' || tag === 'strike') return true;
      const clsId = classOf(node) + ' ' + (node.id || '');
      if (STRUCK_WORDS.test(clsId)) return true;
      try {
        const style = window.getComputedStyle(node);
        if (style && /line-through/.test(style.textDecorationLine || style.textDecoration || '')) return true;
      } catch (e) {
        // 忽略样式读取失败
      }
    }
    return false;
  }

  // 兼容旧内部命名（v2.0 叫 isStruckOut）
  const isStruckOut = isStrike;

  // 祖先链里是否有「价格区」类名（精准标签法用来判断标签是否在价格区，避免促销语里的「到手价」串价）
  function looksLikePriceArea(el) {
    let node = el;
    for (let i = 0; i < 4 && node && node !== document.body; i++, node = node.parentElement) {
      const clsId = classOf(node) + ' ' + (node.id || '');
      if (/price|summary|jd-price|p-price|pricebox/i.test(clsId)) return true;
    }
    return false;
  }

  function queryAllIn(root, sel) {
    try {
      return Array.prototype.slice.call(root.querySelectorAll(sel));
    } catch (e) {
      return [];
    }
  }

  // ---------------- 价格采集（v2.1.7：移植「巡检双轨版」v2.1 算法）----------------
  // 源文件：~/Desktop/巡检\巡检插件-双轨版\extension\content.js（v2.1，2026-11-05）
  // 核心原则（DESIGN 22.2）：
  //   1) 只认当前商品价格区：可见 + 文本是完整价格 + 不在比价/关联/推荐等卡片容器里；
  //      优先首屏，首屏无价才放宽全页（仍排除卡片）；
  //   2) 严格完整价格解析（parsePriceText）：拒绝「56」「5折」「12期」「满5000减300」等片段/促销；
  //   3) 口径：标签（PLUS/到手/电商平台价）+ 字号 + 划线 → hand/plus/main；
  //   4) 选价：字号最大优先（同字号按 top/left），hand 需字号≈最大，main 取同区域更小字号/划线，plus 单独；
  //   5) 稳定性：连续 stableRounds 轮（默认 3，约 1.5s）同价才算稳定（最长 maxWaitMs 20s；无 hand 时
  //      mainWaitMs 6s 接受主价）；稳定后再复核 recheckTimes 次（默认 4×1.2s），以最终读数为准，
  //      价格变化记 priceChanges（不按阈值挑值、不猜）；
  //   6) 标题/名称里的数字绝不作为价格来源（只解析 DOM 价格节点）。
  const PRICE_SCAN_SELECTOR = 'span,strong,em,i,b,div,p,dt,dd,a';
  const PRICE_SCAN_MAX = 600;
  const PRICE_TEXT_MAX = 24;

  // 这些模块里虽然也有「到手价」，但不是当前商品的价格（源版 EXCLUDE_CONTAINER 原样）
  const EXCLUDE_CONTAINER =
    /cross_platform|continuous-product|recommend|similar|guess|like-|maylike|also-?buy|rank|banner|advert|shop-?card|shopcard|promo-?card|promotion-?card|footprint|history-?item|compare-?card|price-?compare/i;
  // 价格附近但属于优惠券/满减/分期等的上下文（仅标记 suspect，不参与选价）
  const DECOY_PRICE_CONTEXT =
    /coupon|优惠券|满减|立减|运费|邮费|月供|分期|白条|免息|定金|尾款|评价|销量|已售|人付款|收藏|关注|赠品|礼包|京豆|积分|可省|首付|秒杀倒计时/i;

  function rectOf(el) {
    try {
      const r = el && el.getBoundingClientRect ? el.getBoundingClientRect() : null;
      if (!r) return { left: 0, top: 0, width: 0, height: 0 };
      return { left: r.left || 0, top: r.top || 0, width: r.width || 0, height: r.height || 0 };
    } catch (e) {
      return { left: 0, top: 0, width: 0, height: 0 };
    }
  }

  function isVisiblePriceEl(el) {
    if (!el || !el.isConnected) return false;
    let cs = null;
    try {
      cs = window.getComputedStyle(el);
    } catch (e) {
      cs = null;
    }
    if (cs && (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity || 1) <= 0)) return false;
    const r = rectOf(el);
    return r.width > 0 && r.height > 0;
  }

  function fontOfPriceEl(el) {
    try {
      const n = parseFloat(window.getComputedStyle(el).fontSize);
      return isFinite(n) ? Math.min(200, n) : 0;
    } catch (e) {
      return 0;
    }
  }

  function inExcludedPriceContainer(el) {
    let cur = el;
    for (let i = 0; i < 10 && cur && cur !== document.body; i++, cur = cur.parentElement) {
      const tag = (cur.tagName || '').toLowerCase();
      if (EXCLUDE_CONTAINER.test(classOf(cur) + ' ' + (cur.id || '') + ' ' + tag)) return true;
    }
    return false;
  }

  function isFirstScreenRect(r) {
    const h = (typeof window !== 'undefined' && window.innerHeight) || 900;
    return r.top >= -30 && r.top < h;
  }

  // 严格完整价格（源版 parsePriceText 原样）：¥15699 / 15,699 / 15699.00 / ¥8607.56
  // 拒绝：56、5、.56、5折、5期、满5件、月供5、评价5、白条/免息/定金/尾款/优惠等
  function parsePriceText(text) {
    const s = norm(text);
    if (!s || s.length > PRICE_TEXT_MAX) return null;
    if (/[折期件满减%人年星分]|白条|免息|定金|尾款|月供|评价|销量|已售|优惠|券后立减/.test(s)) return null;
    const m = s.match(/^[¥￥]?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*[元起]?$/);
    if (!m) return null;
    const raw = m[1].replace(/,/g, '');
    const n = parseFloat(raw);
    if (!isFinite(n) || n < TUNING.minPlausiblePrice || n > TUNING.maxPlausiblePrice) return null;
    const intPart = raw.split('.')[0].replace(/^0+/, '');
    // 没有货币符号时整数位必须 >=3，避免把「56」「5」这种被拆出的数字片段当价格
    if (intPart.length < 3 && !/[¥￥]/.test(s)) return null;
    return n;
  }

  // 取元素附近（自己 + 前两个兄弟 + 父级直接文本）的标签，用来判断价格口径
  function priceLabelNear(el) {
    const parts = [];
    const own = norm(el.textContent);
    if (own) parts.push(own.slice(0, 30));
    let prev = el.previousElementSibling;
    for (let i = 0; i < 2 && prev; i++, prev = prev.previousElementSibling) {
      const t = norm(prev.textContent);
      if (t && t.length <= 30) parts.push(t.slice(0, 30));
    }
    const p = el.parentElement;
    if (p && p.childNodes) {
      for (const node of Array.prototype.slice.call(p.childNodes)) {
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

  function priceKindFromLabel(label, font) {
    if (/PLUS|plus|会员价|会员专享/.test(label)) return 'plus';
    if (/到手价|预估到手|券后|券后价|到手/.test(label)) return 'hand';
    if (/电商平台价|前台价|原价|划线价/.test(label)) return 'main';
    // 没有标签时：大字号基本就是到手价，小字号多半是电商平台价
    return font >= 18 ? 'hand' : 'main';
  }

  function priceKindLabel(kind) {
    if (kind === 'hand') return '到手价';
    if (kind === 'plus') return 'PLUS价';
    if (kind === 'main') return '电商平台价';
    return '';
  }

  // 候选所在上下文是否属于「优惠券/月供/划线原价/销量」等非当前商品价格
  function priceContextIsDecoy(el, label) {
    let ctx = classOf(el) + ' ' + (el.id || '');
    let cur = el.parentElement;
    for (let i = 0; i < 3 && cur && cur !== document.body; i++, cur = cur.parentElement) {
      ctx += ' ' + classOf(cur) + ' ' + (cur.id || '');
    }
    return DECOY_PRICE_CONTEXT.test(ctx) || DECOY_PRICE_CONTEXT.test(label);
  }

  // 不是当前商品价格的候选（划线原价/优惠券等）只用于候选调试，不参与选价
  function isDecoyPriceCandidate(el, label, strike) {
    if (strike) return true;
    return priceContextIsDecoy(el, label);
  }

  // 相邻文本拼接：价格被拆成多个节点时先拼回完整文本再解析
  // （巡检 v2.1 README 的规则 4「数字被拆成多个节点时先拼回完整文本」，竞品 radar 有同款实现；
  //   2026-11-10 取价对齐巡检 v2.1 补上：电商平台常见 <span>￥8,607</span><span>.56</span> 这种拆法，
  //   只按单节点解析会把 8607.56 读成 8607）。
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

  // 收集「可见、不在排除卡片里、文本是一个完整价格」的元素（源版 collectPriceElements）
  function collectPriceCandidates(allowBelowFold) {
    const out = [];
    let nodes = [];
    try {
      nodes = document.querySelectorAll(PRICE_SCAN_SELECTOR);
    } catch (e) {
      nodes = [];
    }
    const seen = new Set();
    for (const el of nodes) {
      if (out.length >= PRICE_SCAN_MAX) break;
      if (!el || !el.isConnected) continue;
      let text = norm(el.textContent);
      if (!text || text.length > PRICE_TEXT_MAX) continue;
      let price = parsePriceText(text);
      if (price == null) {
        // 文本被拆开时（￥8,607 / .56、￥ / 8,607.56）拼回完整价格再解析
        const combined = combinedPriceText(el);
        if (combined && combined !== text) {
          text = combined;
          price = parsePriceText(combined);
        }
      }
      if (price == null) continue;
      // 本元素只是拆分价格的「整数片段」（后面紧跟 .56 这类小数节点）时跳过，
      // 让拼接后的完整价格（父容器/相邻文本）成为候选，避免把 8607.56 读成 8607。
      const nextText = el.nextElementSibling ? norm(el.nextElementSibling.textContent) : '';
      if (nextText && /^\.[0-9]{1,2}$/.test(nextText) && combinedPriceText(el) !== norm(el.textContent)) continue;
      if (!isVisiblePriceEl(el)) continue;
      if (inExcludedPriceContainer(el)) continue;
      const r = rectOf(el);
      if (!allowBelowFold && !isFirstScreenRect(r)) continue;
      const key = price + '|' + Math.round(r.top) + '|' + Math.round(r.left) + '|' + Math.round(r.width);
      if (seen.has(key)) continue;
      seen.add(key);
      const font = fontOfPriceEl(el);
      const label = priceLabelNear(el);
      const strike = !!isStrike(el);
      const cls = classOf(el).slice(0, 80);
      const cand = {
        el: el,
        price: price,
        font: font,
        strike: strike,
        label: label.slice(0, 60),
        cls: cls,
        rect: {
          left: Math.round(r.left),
          top: Math.round(r.top),
          width: Math.round(r.width),
          height: Math.round(r.height)
        },
        kind: strike ? 'main' : priceKindFromLabel(label, font)
      };
      cand.suspect = isDecoyPriceCandidate(el, label, strike);
      // decoy = 上下文命中优惠券/月供/划线原价等，**不参与选价**（划线价本身仍要保留，用于识别电商平台价）
      cand.decoy = priceContextIsDecoy(el, label);
      cand.score = Math.round(cand.font * 10) - (cand.suspect ? 1000 : 0) - (cand.strike ? 200 : 0);
      cand.digits = String(Math.round(price)).length;
      out.push(cand);
    }
    return out;
  }

  // 选价（源版 pickFromCandidates）：字号最大优先（同字号 top/left）；
  // hand 需字号≈最大；main 取同区域更小字号/划线价；plus 单独；hand==plus 去重。
  function pickPriceCandidates(cands) {
    if (!cands.length) return { hand: null, main: null, plus: null, source: '' };
    // 命中「优惠券/月供/划线原价/销量」等上下文的候选（cand.decoy）只在候选列表里展示、不参与选价；
    // 若过滤后一条不剩，才退回全量（避免极端页面完全取不到价）。
    const usable = cands.filter((c) => c && !c.decoy);
    const pool = usable.length ? usable : cands.slice();
    const sorted = pool.slice().sort((a, b) => {
      if (b.font !== a.font) return b.font - a.font;
      return a.rect.top - b.rect.top || a.rect.left - b.rect.left;
    });
    const biggest = sorted[0];
    const hand =
      sorted.find((c) => c.kind === 'hand' && c.font >= biggest.font - 2) ||
      (biggest.kind !== 'main' ? biggest : null) ||
      null;
    let main = sorted.find((c) => c !== hand && c.kind === 'main' && c.font <= (hand ? hand.font : 999));
    if (!main && hand) {
      main = sorted.find((c) => c !== hand && c.strike && Math.abs(c.rect.top - hand.rect.top) < 160);
    }
    if (!main) main = sorted.find((c) => c !== hand && c.font < (hand ? hand.font : 999)) || null;
    let plus = sorted.find((c) => c.kind === 'plus' && c !== hand) || null;
    if (hand && plus && plus.price === hand.price) plus = null;
    const pack = (c, kind) =>
      c ? { price: c.price, kind: kind, cls: c.cls, label: c.label, rect: c.rect } : null;
    return {
      hand: pack(hand, 'hand'),
      main: pack(main, 'main'),
      plus: pack(plus, 'plus'),
      source: hand ? hand.cls : main ? main.cls : ''
    };
  }

  function bestPriceOf(picked) {
    if (!picked) return null;
    if (picked.hand) return picked.hand.price;
    if (picked.main) return picked.main.price;
    if (picked.plus) return picked.plus.price;
    return null;
  }

  // 2026-11-10 取价对齐巡检 v2.1：去掉「到手价 > 电商平台价 2% 就丢弃 hand」的额外交叉校验 —— 巡检 v2.1 没有这条规则，
  // 且它会因 main 被误选（如券后价场景把优惠券 ￥500 当电商平台价）而把正确的到手价丢掉，
  // 导致最终价格落到 500 这种错误值。选价口径与巡检保持完全一致。
  function readPriceSnapshot(allowBelowFold) {
    let cands = collectPriceCandidates(allowBelowFold === true);
    if (!cands.length && allowBelowFold !== true) cands = collectPriceCandidates(true);
    const picked = pickPriceCandidates(cands);
    return { picked: picked, cands: cands };
  }

  // 价格片段检测：页面上只有「￥5」这类不完整价格时用于失败原因（不是价格来源）
  function detectPriceFragment() {
    let text = '';
    try {
      text = norm(document.body ? document.body.innerText : '').slice(0, 6000);
    } catch (e) {
      text = '';
    }
    return /[¥￥]\s*\d{1,2}(?![0-9])/.test(text) || /[¥￥]\s*\d{1,2}\.\d{1,2}(?![0-9])/.test(text);
  }

  // 等价格稳定（源版 waitForStablePrice）：连续 stableRounds 轮同一价格才算稳定；
  // 最长 maxWaitMs；无 hand 时 mainWaitMs 后接受主价。期间价格变化也记入 priceChanges。
  async function waitForStablePrice() {
    const started = Date.now();
    const changes = [];
    let lastBest = null;
    let stable = 0;
    let picked = null;
    let cands = [];
    while (Date.now() - started < TUNING.maxWaitMs) {
      const snap = readPriceSnapshot(false);
      picked = snap.picked;
      cands = snap.cands;
      const best = bestPriceOf(picked);
      if (best != null && lastBest != null && Math.abs(best - lastBest) > 0.005) {
        changes.push({ from: lastBest, to: best });
      }
      if (best != null && best === lastBest) {
        stable += 1;
      } else {
        stable = 0;
        lastBest = best;
      }
      if (best != null && stable >= TUNING.stableRounds) {
        const waited = Date.now() - started;
        if ((picked && picked.hand) || waited > TUNING.mainWaitMs) {
          return { picked: picked, cands: cands, priceChanges: changes };
        }
      }
      await sleep(TUNING.roundIntervalMs);
    }
    return { picked: picked, cands: cands, priceChanges: changes };
  }

  // 稳定后再复核（源版复核循环）：最多 recheckTimes 次、每次间隔 recheckDelayMs，
  // 以页面最终刷新后的读数为准；变化记 priceChanges（不挑「离阈值最近」的值，不猜）。
  async function recheckFinalPrice(stable) {
    let picked = stable && stable.picked ? stable.picked : { hand: null, main: null, plus: null, source: '' };
    let cands = (stable && stable.cands) || [];
    const changes = ((stable && stable.priceChanges) || []).slice();
    for (let attempt = 0; attempt < TUNING.recheckTimes; attempt++) {
      await sleep(TUNING.recheckDelayMs);
      const fresh = readPriceSnapshot(true);
      const before = bestPriceOf(picked);
      const after = bestPriceOf(fresh.picked);
      if (after == null) break; // 页面反而没价了，保留上一个结果
      picked = fresh.picked;
      cands = fresh.cands;
      if (before != null && Math.abs(before - after) > 0.005) {
        changes.push({ from: before, to: after });
        continue; // 价格刚变过，再给一轮确认
      }
      break;
    }
    return { picked: picked, cands: cands, priceChanges: changes };
  }

  // ---------------- 英寸尺寸识别 ----------------
  // 覆盖：75英寸 / 75寸 / 75吋 / 75 英寸 / 75.5英寸（英吋也算）
  // ---------------- 尺寸识别（v2.2 尺寸段规则重定义）----------------
  // 用户反馈：网页标题/上传标题里明明能看到「65英寸」，却经常识别不出尺寸段（旧口径多值必空置）。
  // 新规则（v2.2）：页面商品标题（打开商品页能看到的标题）与上传榜单标题都算尺寸来源。
  // 来源优先级（从高到低）：
  //   ① 页面规格参数表明确字段（屏幕尺寸/显示尺寸/…）—— 保持最高优先；
  //   ② 页面规格选择区「屏幕尺寸」当前选中项；
  //   ③ 页面商品标题（extractTitle 的 raw，含【】内容）与 document.title —— 唯一明确直接用；
  //      多个明确时按「最佳匹配」选一个：优先与型号/规格选择区/套餐文本里的数字匹配
  //      （如型号 T65SE、VH75CAD → 65/75），否则取标题里第一个出现的常见尺寸（20~200 英寸）；
  //      采用后仍标 sizeUncertain=true，reason「标题含多个尺寸，已优先采用 65英寸（待核对）」；
  //   ④ 主图 alt —— 同上「唯一直接用 / 多个最佳匹配 + 待核对」规则；
  //   ⑤ 上传榜单标题（Excel 商品名称）由 lib/rules.js parseSizeFromNameBestEffort +
  //      lib/pipeline.js analyzeReport 按同一口径尽力解析；
  //   ⑥ 手动填写的尺寸永远最高优先（pipeline 不覆盖 source.size==='手动'）。
  // 型号数字（75MBK7、VH75CAD）本身不算尺寸，只作为多值时的匹配提示。
  const INCH_RE = /(\d{2,3}(?:\.\d+)?)\s*(?:英寸|英吋|寸|吋)/g;
  const INCH_MIN = 10;
  const INCH_MAX = 300;
  const PLAUSIBLE_INCH_MIN = 20;
  const PLAUSIBLE_INCH_MAX = 200;

  // 宽松英寸扫描（保留兼容：调试 API / 旧调用方；尺寸提取已改用 findStrictInches）
  function findInches(text) {
    const out = [];
    if (!text) return out;
    const re = new RegExp(INCH_RE.source, 'g');
    let m;
    while ((m = re.exec(String(text)))) {
      const inch = parseFloat(m[1]);
      if (!isFinite(inch) || inch < INCH_MIN || inch > INCH_MAX) continue;
      out.push({ inch: Math.round(inch * 10) / 10, matched: norm(m[0]) });
    }
    return out;
  }

  // 严格尺寸 token：数字开头，允许 55/65、86~85、75、75 英寸 等写法，末尾必须有尺寸单位（寸后不能跟「尺」）
  const STRICT_SIZE_TOKEN_RE = /(\d{2,3}(?:\.\d+)?(?:\s*[\/／~～—\-、,，]\s*\d{2,3}(?:\.\d+)?)*)\s*(?:英寸|英吋|吋|寸(?!尺))/g;

  // 返回 [{inch, matched, token}...]（一个匹配里带多个数字时逐个展开，如 55/65英寸 → 55、65）
  function findStrictInches(text) {
    const out = [];
    const raw = String(text || '');
    if (!raw) return out;
    const re = new RegExp(STRICT_SIZE_TOKEN_RE.source, 'g');
    let m;
    while ((m = re.exec(raw))) {
      const matched = norm(m[0]);
      const nums = String(m[0]).match(/\d{2,3}(?:\.\d+)?/g) || [];
      for (const n of nums) {
        const inch = parseFloat(n);
        if (!isFinite(inch)) continue;
        out.push({ inch: Math.round(inch * 10) / 10, matched: matched, token: n });
      }
    }
    return out;
  }

  function isPlausibleInch(inch) {
    return isFinite(inch) && inch >= PLAUSIBLE_INCH_MIN && inch <= PLAUSIBLE_INCH_MAX;
  }

  // 严格分类：{kind:'none'|'one'|'multi', inch?, text?, hits}
  //   one   = 恰好 1 个明确且常见（20~200 英寸）尺寸表达 → 可直接采用（明确）
  //   multi = ≥2 个明确尺寸表达 → 走「最佳匹配」选一个并标待核对（v2.2，不再直接空置）
  //   none  = 0 个明确尺寸表达（或数值不在常见范围）→ 不猜
  function strictSizeOf(text) {
    const hits = findStrictInches(text);
    if (!hits.length) return { kind: 'none', hits: [] };
    const plausible = hits.filter((h) => isPlausibleInch(h.inch));
    if (plausible.length === 1) {
      return { kind: 'one', inch: plausible[0].inch, text: plausible[0].matched, hits: hits };
    }
    if (plausible.length >= 2) return { kind: 'multi', hits: hits };
    return { kind: 'none', hits: hits };
  }

  // 从文本里取 20~200 的候选英寸数字（用于型号/规格/套餐提示，如 T65SE→65、VH75CAD→75）
  function inchNumbersIn(text) {
    const set = new Set();
    const raw = String(text || '');
    const re = /\d{2,3}(?:\.\d+)?/g;
    let m;
    while ((m = re.exec(raw))) {
      const n = parseFloat(m[0]);
      if (isPlausibleInch(n)) set.add(Math.round(n * 10) / 10);
    }
    return set;
  }

  // v2.2 多尺寸「最佳匹配」提示数字：型号（标题/规格表）+ 规格选择区各选中项（含套餐文本）。
  // 注意不把标题整体放进来——否则永远命中标题里第一个尺寸，失去「型号/套餐优先」的意义。
  function sizeHintNumbers(variantGroups) {
    const set = new Set();
    const add = (text) => {
      for (const n of inchNumbersIn(text)) set.add(n);
    };
    try {
      const titleInfo = extractTitle();
      const titleModel = modelFromTitleText(titleInfo.raw || '', '');
      if (titleModel) add(titleModel);
    } catch (e) {
      // 忽略标题/型号读取失败（尺寸识别继续走其它来源）
    }
    try {
      const specModel = extractModel('');
      if (specModel && specModel.value) add(specModel.value);
    } catch (e) {
      // 忽略规格表型号读取失败
    }
    for (const g of Array.isArray(variantGroups) ? variantGroups : []) {
      if (g && g.selected) add(g.selected);
    }
    return set;
  }

  // 从 strictSizeOf 的命中里选「最佳匹配」：命中提示数字的优先，否则取第一个出现的常见尺寸。
  // 返回 {hit:{inch,matched}, matchedBy:'hint'|'first'} 或 null（无常见尺寸时）。
  function pickBestInch(hits, hintNumbers) {
    const plausible = (hits || []).filter((h) => h && isPlausibleInch(h.inch));
    const unique = [];
    for (const h of plausible) {
      if (!unique.some((u) => u.inch === h.inch)) unique.push(h);
    }
    if (!unique.length) return null;
    const hinted = hintNumbers && unique.find((h) => hintNumbers.has(h.inch));
    return { hit: hinted || unique[0], matchedBy: hinted ? 'hint' : 'first' };
  }

  // 「标题类来源含多个尺寸」的待核对原因文案（统一口径，供 title/doc-title/alt 复用）
  function multiSizeReasonText(label, inch, matchedBy) {
    const how = matchedBy === 'hint' ? '已按型号/规格匹配优先采用' : '已优先采用';
    return label + '含多个尺寸，' + how + ' ' + inch + '英寸（待核对）';
  }

  // 规格表「屏幕尺寸/显示尺寸/产品尺寸/整机尺寸/尺寸」标签的优先级与取值要求：
  // strictUnit=true 的标签（产品尺寸/整机尺寸等）值里常是 mm/cm 三围，必须带英寸单位才接受。
  const SIZE_LABELS = [
    { re: /^(屏幕尺寸|屏幕规格|显示屏尺寸|显示尺寸|屏幕大小)$/, strictUnit: false },
    { re: /^(对角线尺寸|可视尺寸|屏幕对角线|屏幕可视尺寸)$/, strictUnit: false },
    { re: /^(整机尺寸|产品尺寸|机身尺寸|外观尺寸|外形尺寸|规格尺寸|尺寸)$/, strictUnit: true }
  ];

  // 收集规格参数表的所有「标签 → 值」对（兼容 dl/dt/dd、table、li 冒号文本）
  function collectSpecRows() {
    const rows = [];
    const seen = new Set();
    const push = (labelRaw, valueRaw) => {
      const label = norm(labelRaw).replace(/[：:]\s*$/, '').trim();
      const value = norm(valueRaw);
      if (!label || label.length > 16 || !value || value.length > 80) return;
      const key = label + '||' + value;
      if (seen.has(key)) return;
      seen.add(key);
      rows.push({ label: label, value: value });
    };

    // 1) <dl><dt>标签</dt><dd>值</dd></dl>（电商平台参数表常见结构）
    for (const dl of queryAll('dl')) {
      const dts = Array.prototype.slice.call(dl.querySelectorAll('dt'));
      const dds = Array.prototype.slice.call(dl.querySelectorAll('dd'));
      if (dts.length && dds.length) {
        dts.forEach((dt, i) => push(dt.textContent, dds[i] ? dds[i].textContent : ''));
      }
    }

    // 2) <tr><th>标签</th><td>值</td></tr>
    for (const tr of queryAll('table tr')) {
      const cells = Array.prototype.slice.call(tr.querySelectorAll('th,td'));
      if (cells.length >= 2) push(cells[0].textContent, cells[1].textContent);
    }

    // 3) 参数列表 <li>标签：值</li>（电商平台 .parameter2 / .Ptable-item 常见）
    for (const li of queryAll('li, [class*="parameter"] li, [class*="Ptable"] li, [class*="spec"] li')) {
      const t = norm(li.textContent);
      if (!t || t.length > 90) continue;
      const m = t.match(/^([^：:]{2,16})[：:]\s*(.+)$/);
      if (m) push(m[1], m[2]);
    }

    // 4) 文本兜底：从正文前 30000 字里按行找「标签：值」
    const text = norm(document.body ? document.body.innerText : '').slice(0, 30000);
    const lines = text.split(/(?=\s{2,})|\n/);
    for (const line of lines) {
      const t = norm(line);
      if (!t || t.length > 100) continue;
      const m = t.match(/^([^：:]{2,16})[：:]\s*(.+)$/);
      if (m) push(m[1], m[2]);
    }
    return rows;
  }

  // 从规格行里按标签优先级取英寸；返回 {inch, text, source:'spec', label} 或 null
  // v2.1.6：值必须严格（唯一明确）；多值行不采用，避免规格表本身多值被猜
  function sizeFromSpecRows(rows) {
    const rowsArr = rows || collectSpecRows();
    for (const group of SIZE_LABELS) {
      for (const row of rowsArr) {
        if (!group.re.test(row.label)) continue;
        const value = row.value;
        const strict = strictSizeOf(value);
        if (strict.kind === 'one') {
          return { inch: strict.inch, text: strict.text, source: 'spec', label: row.label };
        }
        if (strict.kind === 'multi') continue; // 规格表本身多值 → 不采用（继续找其它行/其它来源）
        if (group.strictUnit && /mm|cm|×|x|\d{3,}/i.test(value)) continue;
        // 无单位但值是纯数字（如「屏幕尺寸：75」）时也接受；带 mm/cm/× 的三围值不接受
        if (/^\d{1,3}(?:\.\d+)?$/.test(value)) {
          const n = parseFloat(value);
          if (isFinite(n) && n >= PLAUSIBLE_INCH_MIN && n <= 150) {
            return { inch: n, text: norm(value) + '英寸', source: 'spec', label: row.label };
          }
        }
      }
    }
    return null;
  }

  // 主图 alt（电商平台主图 #spec-img 的 alt 常是完整商品名）：
  // v2.2 唯一明确直接用；多个明确 → 按提示数字最佳匹配（否则取第一个）并标待核对。
  function sizeFromMainImage(hintNumbers) {
    const selectors = [
      '#spec-img',
      '#preview img',
      '.main-img img',
      '[class*="main-img"] img',
      '[class*="spec-img"]',
      '[class*="preview"] img'
    ];
    const pick = (raw) => {
      const t = norm(raw || '');
      if (!t || t.length > 300) return null;
      const strict = strictSizeOf(t);
      if (strict.kind === 'one') {
        return { inch: strict.inch, text: strict.text, source: 'alt', sizeUncertain: false, matchedBy: 'single' };
      }
      if (strict.kind === 'multi') {
        const best = pickBestInch(strict.hits, hintNumbers);
        if (!best) return null;
        return {
          inch: best.hit.inch,
          text: best.hit.matched,
          source: 'alt',
          sizeUncertain: true,
          matchedBy: best.matchedBy,
          reason: multiSizeReasonText('主图 alt ', best.hit.inch, best.matchedBy)
        };
      }
      return null; // 0 个明确尺寸 → 不猜，交给后续来源/人工
    };
    for (const sel of selectors) {
      for (const el of queryAll(sel)) {
        const info = pick(el.getAttribute('alt') || el.getAttribute('title') || '');
        if (info) return info;
      }
    }
    // 最后才扫全页 img[alt]（避免把推荐位/广告图当商品主图）
    for (const el of queryAll('img[alt]')) {
      const info = pick(el.getAttribute('alt') || '');
      if (info) return info;
    }
    return null;
  }

  // 尺寸提取主流程（v2.2 尺寸段规则重定义）：
  //   ① 规格参数表明确字段 > ② 规格选择区「屏幕尺寸」已选项 >
  //   ③ 页面商品标题（extractTitle.raw，含【】）/ document.title >
  //   ④ 主图 alt；③④ 唯一明确直接用，多个明确按「型号/规格/套餐数字」最佳匹配取一个并标待核对；
  //   ⑤ 都无明确尺寸 → sizeInch=null + sizeUncertain=true（等人工）。
  // 返回 {inch:number|null, text, source:'spec'|'variant'|'title'|'doc-title'|'alt'|'', label?,
  //       sizeUncertain:boolean, matchedBy?, reason?, sources:[...]}
  function extractSize(variantGroups) {
    const groups = Array.isArray(variantGroups) ? variantGroups : safeVariantGroups();
    const sources = [];
    const titleInfo = extractTitle();
    const titleText = titleInfo.raw || '';
    const titleStrict = strictSizeOf(titleText);
    const docStrict = strictSizeOf(document.title || '');

    // ① 规格参数表最高优先（明确字段最可信）
    const spec = sizeFromSpecRows(collectSpecRows());
    if (spec) {
      sources.push({ source: 'spec', inch: spec.inch, text: spec.text, label: spec.label });
      return {
        inch: spec.inch,
        text: spec.text,
        source: 'spec',
        label: spec.label,
        sizeUncertain: false,
        matchedBy: 'single',
        sources: sources.slice()
      };
    }

    // ② 规格选择区「屏幕尺寸」组的已选项（页面明确字段，不是名称推断）
    const variantSize = sizeFromVariantGroups(groups);
    if (variantSize) {
      sources.push({ source: 'variant', inch: variantSize.inch, text: variantSize.text, label: variantSize.label });
      return {
        inch: variantSize.inch,
        text: variantSize.text,
        source: 'variant',
        label: variantSize.label,
        sizeUncertain: false,
        matchedBy: 'single',
        sources: sources.slice()
      };
    }

    // v2.2：多尺寸时用于最佳匹配的提示数字（型号/规格选择区/套餐里的数字）
    const hintNumbers = sizeHintNumbers(groups);

    // ③ 页面商品标题（extractTitle 的 raw，含【】内容）：唯一明确直接用
    if (titleStrict.kind === 'one') {
      sources.push({ source: 'title', inch: titleStrict.inch, text: titleStrict.text, matchedBy: 'single' });
      return {
        inch: titleStrict.inch,
        text: titleStrict.text,
        source: 'title',
        sizeUncertain: false,
        matchedBy: 'single',
        sources: sources.slice()
      };
    }
    //    多个明确：按型号/规格/套餐数字最佳匹配，否则取标题里第一个常见尺寸；采用后标待核对
    if (titleStrict.kind === 'multi') {
      const best = pickBestInch(titleStrict.hits, hintNumbers);
      if (best) {
        const reason = multiSizeReasonText('标题', best.hit.inch, best.matchedBy);
        sources.push({ source: 'title', inch: best.hit.inch, text: best.hit.matched, matchedBy: best.matchedBy });
        return {
          inch: best.hit.inch,
          text: best.hit.matched,
          source: 'title',
          sizeUncertain: true,
          matchedBy: best.matchedBy,
          reason: reason,
          sources: sources.slice()
        };
      }
    }

    // ③b document.title：与页面商品标题同一优先级档（唯一明确直接用 / 多值最佳匹配+待核对）
    if (docStrict.kind === 'one') {
      sources.push({ source: 'doc-title', inch: docStrict.inch, text: docStrict.text, matchedBy: 'single' });
      return {
        inch: docStrict.inch,
        text: docStrict.text,
        source: 'doc-title',
        sizeUncertain: false,
        matchedBy: 'single',
        sources: sources.slice()
      };
    }
    if (docStrict.kind === 'multi') {
      const best = pickBestInch(docStrict.hits, hintNumbers);
      if (best) {
        const reason = multiSizeReasonText('页面标题', best.hit.inch, best.matchedBy);
        sources.push({ source: 'doc-title', inch: best.hit.inch, text: best.hit.matched, matchedBy: best.matchedBy });
        return {
          inch: best.hit.inch,
          text: best.hit.matched,
          source: 'doc-title',
          sizeUncertain: true,
          matchedBy: best.matchedBy,
          reason: reason,
          sources: sources.slice()
        };
      }
    }

    // ④ 主图 alt（唯一明确直接用 / 多值最佳匹配+待核对）
    const altSize = sizeFromMainImage(hintNumbers);
    if (altSize) {
      sources.push({ source: 'alt', inch: altSize.inch, text: altSize.text, matchedBy: altSize.matchedBy });
      return {
        inch: altSize.inch,
        text: altSize.text,
        source: 'alt',
        sizeUncertain: !!altSize.sizeUncertain,
        matchedBy: altSize.matchedBy || 'single',
        reason: altSize.reason || '',
        sources: sources.slice()
      };
    }

    // ⑤ 无法确定：不猜，交给人工（标题多值但无常见尺寸 / 型号数字 / 无明确表达）
    let reason;
    if (titleStrict.hits.length) {
      reason = '标题尺寸不在常见范围（20~200英寸），待人工复核';
    } else if (docStrict.hits.length) {
      reason = '页面标题尺寸不在常见范围（20~200英寸），待人工复核';
    } else {
      reason = '未识别到明确尺寸，待人工复核';
    }
    return { inch: null, text: '', source: '', sizeUncertain: true, matchedBy: '', reason: reason, sources: sources.slice() };
  }

  // 品牌（可选字段）：优先规格表「品牌」行，其次正文「品牌：xxx」
  function extractBrand() {
    const rows = collectSpecRows();
    for (const row of rows) {
      if (/^品牌(名称)?$/.test(row.label)) {
        const v = norm(row.value)
          .replace(/[（(][^）)]*[）)]/g, '')
          .replace(/[｜|].*$/, '')
          .trim();
        if (v && v.length <= 24) return v;
      }
    }
    const text = norm(document.body ? document.body.innerText : '').slice(0, 30000);
    const m = text.match(/品牌[：:]\s*([^\s｜|，,；;、]{1,24})/);
    return m ? m[1] : '';
  }

  // ---------------- 型号 / 套餐 ----------------
  // 型号：规格参数表（型号/产品型号/商品型号/规格型号/机型）优先，其次商品标题里的「大写+数字」token。
  // 套餐：只取规格选择区（#choose-attrs 等）里「版本/套餐」组的**已选中项**（见下方 extractVariantGroups）；
  //       不再用标题内存规格或规格参数表兜底（用户 2026-11-03 纠正口径）。识别不到返回 ''（不阻断流程）。
  const MODEL_LABEL_PRIORITY = ['型号', '产品型号', '商品型号', '规格型号', '机型', '产品规格型号', '型号规格'];
  const MODEL_VALUE_BLACKLIST = /^(?:无|暂无|见包装|见详情|以实物为准|其他|其它|未知|详询客服|参见包装|不适用|待定|暂无数据|咨询客服)$/;
  // 型号 token 黑名单：4K/8K、分辨率、容量、接口、屏幕技术等规格词
  const MODEL_TOKEN_BLACKLIST = /^(?:4K|8K|2K|1K|\d{3,4}P|HDMI.*|USB.*|VGA.*|RJ45.*|BT.*|WIFI.*|WI-FI.*|HDR.*|UHD.*|FHD.*|QHD.*|IPS.*|LED.*|LCD.*|OLED.*|QLED.*|DLP.*|ANDROID.*|WINDOWS.*|CMOS.*|TYPE-C.*|DP.*|TF.*|SD.*|RGB.*|NTSC.*|SRGB.*|\d+(?:GB|G|TB|T|MB|M|GHZ|HZ|W|K|P))$/;

  function cleanModelValue(value) {
    const v = norm(value)
      .replace(/^[：:、\s]+/, '')
      .replace(/[（(].*$/, '')
      .replace(/[｜|].*$/, '')
      .trim();
    if (!v || v.length > 40) return '';
    if (MODEL_VALUE_BLACKLIST.test(v)) return '';
    return v;
  }

  function isModelToken(token) {
    const t = String(token || '').replace(/^[\s\-]+|[\s\-.]+$/g, '');
    if (t.length < 3 || t.length > 20) return false;
    if (!/[A-Z]/.test(t)) return false; // 至少一个大写字母（型号通常大写）
    if (!/[0-9]/.test(t)) return false; // 至少一个数字
    if (/^\d+$/.test(t)) return false;
    const upper = t.toUpperCase();
    if (MODEL_TOKEN_BLACKLIST.test(upper)) return false;
    return true;
  }

  function modelTokenScore(token) {
    const upperCount = (token.match(/[A-Z]/g) || []).length;
    let score = upperCount * 2;
    if (upperCount >= 2) score += 4;
    if (token.length >= 4) score += 1;
    if (/[A-Z].*[A-Z]/.test(token)) score += 1;
    return score;
  }

  // 从标题里挑最像型号的 token；brand 用于排除「品牌名里带数字」（如 H3C）被误当型号
  function modelFromTitleText(text, brand) {
    const tokens = String(text || '').match(/[A-Za-z0-9][A-Za-z0-9./-]*/g) || [];
    const brandUpper = String(brand || '').toUpperCase();
    let best = null;
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i].replace(/[.,;:]+$/, '');
      if (!isModelToken(token)) continue;
      const upper = token.toUpperCase();
      if (brandUpper && (upper === brandUpper || brandUpper.indexOf(upper) >= 0)) continue;
      const score = modelTokenScore(token) * 100 - i; // 同分时取标题里更靠前的
      if (!best || score > best.score) best = { value: token, score: score };
    }
    return best ? best.value : '';
  }

  // 型号：返回 {value, source:'spec'|'title', label?} 或 null
  function extractModel(brand) {
    const rows = collectSpecRows();
    for (const label of MODEL_LABEL_PRIORITY) {
      for (const row of rows) {
        if (row.label !== label) continue;
        const value = cleanModelValue(row.value);
        if (value) return { value: value, source: 'spec', label: row.label };
      }
    }
    // 规格表里其它非标准写法：标签包含「型号」两字
    for (const row of rows) {
      if (row.label.indexOf('型号') < 0) continue;
      const value = cleanModelValue(row.value);
      if (value) return { value: value, source: 'spec', label: row.label };
    }
    const titleInfo = extractTitle();
    const fromTitle = modelFromTitleText(titleInfo.raw || document.title || '', brand);
    if (fromTitle) return { value: fromTitle, source: 'title' };
    return null;
  }

  // ---------------- 规格选择区（系列品 / 屏幕尺寸 / 版本 / 套餐 …）----------------
  // 用户口径（2026-11-03 纠正）：商品页的「套餐」= 规格选择区里**已选中**的 版本/套餐 选项
  // （截图绿框：价格下面「版本」组选中的「会议大屏+摄像头【免费送装一体】」），
  // 不是标题里的内存规格（4+64GB 之类）。电商平台改版频繁，这里做容错解析：
  //   1) 扫描商品页右侧规格选择区候选容器（#choose-attrs / .li-group / sku-* / variant / select 等）；
  //   2) 按「标签（系列品/屏幕尺寸/版本/套餐/…） + 选项组」拆分；
  //   3) 组内选中项按 selected 类 / aria-selected / 唯一高亮 判定；单选项组视为已选。
  const VARIANT_LABEL_SET = [
    '系列品', '系列', '屏幕尺寸', '尺寸', '版本', '套餐', '套装', '组合', '配置', '规格',
    '颜色', '型号', '包装', '内存', '存储', '容量', '套餐类型', '规格型号'
  ];
  const VARIANT_LABEL_RE = new RegExp('^(?:' + VARIANT_LABEL_SET.join('|') + ')$');
  // 强候选容器：几乎只出现在右侧规格选择区，命中即优先使用
  const VARIANT_STRONG_SELECTORS = [
    '#choose-attrs',
    '.choose-attrs',
    '[class*="choose-attr"]',
    '[class*="chooseAttrs"]',
    '[class*="sku-"]',
    '[class*="variant"]',
    '[class*="choose-btns"]',
    '[class*="choose-btn"]'
  ];
  // 弱候选容器：可能是规格选择区，也可能是左侧参数表，只在强候选找不到时用，且要求是真选项组
  const VARIANT_WEAK_SELECTORS = ['.Ptable', '[class*="spec"]', '[class*="select"]', '[class*="attr"]'];
  const VARIANT_EXCLUDE_AREA_RE = /comment|recommend|evaluate|review|rank|footer|header|aside|guess|hot-sale|cart|compare|advert/i;
  const VARIANT_NOISE_OPTION_RE = /^(?:查看更多|展开|收起|更多|更多选项|查看全部|已选|请选择|选择|无货|缺货|暂时缺货|下一屏|上一屏|上一页|下一页)$/;
  const VARIANT_ARROW_CHARS = '\\s▼▲▾▸◀▶‹›<>→↓↑▽△|';
  const VARIANT_ARROW_HEAD_RE = new RegExp('^[' + VARIANT_ARROW_CHARS + ']+');
  const VARIANT_ARROW_TAIL_RE = new RegExp('[' + VARIANT_ARROW_CHARS + ']+$');
  const PACKAGE_GROUP_PRIORITY = ['套餐', '版本', '套装', '组合', '配置', '规格'];
  const PACKAGE_GROUP_EXCLUDE = /屏幕尺寸|尺寸|系列品|颜色|型号/;

  function isExcludedVariantArea(el) {
    let node = el;
    for (let i = 0; i < 8 && node && node !== document.body; i++, node = node.parentElement) {
      const clsId = classOf(node) + ' ' + (node.id || '');
      if (VARIANT_EXCLUDE_AREA_RE.test(clsId)) return true;
    }
    return false;
  }

  function variantLabelOf(text) {
    const t = norm(text).replace(/[：:]\s*$/, '').trim();
    return VARIANT_LABEL_RE.test(t) ? t : '';
  }

  function isVariantNoiseText(text) {
    if (!text) return true;
    if (VARIANT_NOISE_OPTION_RE.test(text)) return true;
    if (variantLabelOf(text)) return true;
    return false;
  }

  // 清理选项/选中文本：去「已选：」「请选择」前缀与箭头，压缩空白；保留【】等完整信息
  function cleanVariantText(text) {
    let t = norm(text);
    if (!t) return '';
    t = t.replace(/^(?:已选(?:择)?|请选择|选择|当前选择)[：:\s]*/, '');
    t = t.replace(VARIANT_ARROW_HEAD_RE, '').replace(VARIANT_ARROW_TAIL_RE, '').trim();
    t = t.replace(/\s+/g, ' ');
    if (t.length < 2 || t.length > 80) return '';
    return t;
  }

  function classTokensOf(el) {
    return (classOf(el) + ' ' + (el.id || '')).split(/\s+/).filter(Boolean);
  }

  // selected 判定：元素自身或最近 2 层祖先带 selected/cur/active/checked/current/highlight，
  // 或 aria-selected="true"（电商平台通常用 class，aria 作为兜底）
  function markupSelected(el, stopNode) {
    let node = el;
    for (let i = 0; i < 3 && node && node !== stopNode; i++, node = node.parentElement) {
      if (!node.getAttribute) break;
      if (String(node.getAttribute('aria-selected') || '').toLowerCase() === 'true') return 'aria';
      const tokens = classTokensOf(node);
      for (const t of tokens) {
        if (/^(?:selected|cur|active|checked|current|highlight|on)$/i.test(t)) return 'class';
      }
      if (/selected|active|highlight|checked|current/i.test(tokens.join(' '))) return 'class';
    }
    return '';
  }

  // 唯一高亮兜底：真实电商平台偶尔只靠内联/计算样式表示选中（边框/背景有颜色且组内唯一）
  function styleSelected(el) {
    try {
      const cs = window.getComputedStyle(el);
      if (!cs) return false;
      const colorful = (value) => {
        const s = String(value || '').toLowerCase().trim();
        if (!s || s === 'transparent' || s === 'none' || s === 'initial' || s === 'inherit') return false;
        if (/^#fff(?:fff)?$/.test(s) || /^#ffffff$/.test(s)) return false;
        if (/^rgb\(\s*255\s*,\s*255\s*,\s*255\s*\)$/.test(s)) return false;
        if (/^rgba?\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0?\s*\)$/.test(s)) return false;
        return /^#|^rgb|^hsl/.test(s);
      };
      const bg = cs.backgroundColor || '';
      const border = [cs.borderColor, cs.borderTopColor, cs.borderBottomColor, cs.borderLeftColor, cs.borderRightColor]
        .filter(Boolean)
        .join(' ');
      return colorful(bg) || colorful(border);
    } catch (e) {
      return false;
    }
  }

  // 解析一个「选项容器」：返回 {selected, options, source}
  function parseVariantOptions(root) {
    if (!root) return { selected: '', options: [], source: '' };
    const texts = [];
    const els = [];
    const seenText = new Set();
    const isWrapperClass = (el) => {
      const tokens = classTokensOf(el);
      return tokens.some((t) => /(?:items|list|group|wrap|wrapper|container|content|btns|suffix|prefix)$/i.test(t));
    };
    const pushEl = (el) => {
      if (!el || !el.isConnected) return;
      if (elementHidden(el)) return;
      if (isWrapperClass(el)) return; // 选项组容器（如 .li-items）不是选项
      if (el.children && el.children.length > 2) return;
      const text = cleanVariantText(el.textContent);
      if (!text || isVariantNoiseText(text)) return;
      if (seenText.has(text)) return;
      seenText.add(text);
      texts.push(text);
      els.push(el);
    };
    // 优先带 item/option/value/tag/btn 类名的选项节点，避免把整块容器当选项
    const explicit = queryAllIn(root, '[class*="item"],[class*="option"],[class*="value"],[class*="tag"],[class*="btn"],a,li');
    for (const el of explicit) pushEl(el);
    if (!texts.length) {
      for (const el of queryAllIn(root, 'span,em,strong,b,i,p,div')) pushEl(el);
    }
    // 选项容器自身就是「已选值展示框」（下拉式规格）时，整段文本即选中值
    if (!texts.length) pushEl(root);

    let selected = '';
    let source = '';
    const optionEls = els.slice(0, 12);
    const optionTexts = texts.slice(0, 12);
    for (let i = 0; i < optionEls.length; i++) {
      const how = markupSelected(optionEls[i], root);
      if (how) {
        selected = optionTexts[i];
        source = how;
        break;
      }
    }
    if (!selected && optionEls.length > 1) {
      let highlightIndex = -1;
      let highlightCount = 0;
      for (let i = 0; i < optionEls.length; i++) {
        if (styleSelected(optionEls[i])) {
          highlightCount += 1;
          highlightIndex = i;
        }
      }
      if (highlightCount === 1) {
        selected = optionTexts[highlightIndex];
        source = 'style';
      }
    }
    if (!selected && optionEls.length === 1) {
      selected = optionTexts[0];
      source = 'single';
    }
    return { selected: selected, options: optionTexts, source: source };
  }

  // 找到标签对应的选项容器：dt→dd / 标签的下一个兄弟 / 组内其它子节点
  function findVariantOptionsRoot(labelEl, rowEl) {
    if (!rowEl) return null;
    const tag = (labelEl.tagName || '').toLowerCase();
    if (tag === 'dt') {
      const dd = rowEl.querySelector ? rowEl.querySelector('dd') : null;
      if (dd) return dd;
    }
    let sib = labelEl.nextElementSibling;
    while (sib) {
      if (norm(sib.textContent)) return sib;
      sib = sib.nextElementSibling;
    }
    for (const child of rowEl.children || []) {
      if (child === labelEl) continue;
      if (norm(child.textContent)) return child;
    }
    return null;
  }

  function parseVariantGroupsIn(container, strict) {
    const groups = [];
    const seenLabels = new Set();
    if (!container || !container.isConnected) return groups;
    const labelCandidates = queryAllIn(
      container,
      'dt,.li-label,[class*="label"],[class*="title"],[class*="name"],span,em,strong,b,p,div'
    );
    for (const el of labelCandidates) {
      if (!el || !el.isConnected) continue;
      if (el.children && el.children.length > 0) continue;
      const label = variantLabelOf(el.textContent);
      if (!label || seenLabels.has(label)) continue;
      const row = el.parentElement;
      if (!row || row === document.body) continue;
      const optionsRoot = findVariantOptionsRoot(el, row);
      if (!optionsRoot || optionsRoot === el) continue;
      const parsed = parseVariantOptions(optionsRoot);
      if (!parsed.options.length) continue;
      if (!parsed.selected) {
        // 弱容器（可能是左侧参数表）只认「真选项组 + 明确选中」，避免把参数行当套餐
        if (strict) continue;
        if (parsed.options.length !== 1) continue;
      }
      if (strict && parsed.options.length < 2) continue;
      seenLabels.add(label);
      groups.push({
        label: label,
        selected: parsed.selected || '',
        options: parsed.options.slice(0, 12),
        source: parsed.source || ''
      });
    }
    return groups;
  }

  // 扫描规格选择区，输出 [{label, selected, options, source}]
  function extractVariantGroups() {
    const groups = [];
    const seen = new Set();
    const collect = (selector, strict) => {
      for (const container of queryAll(selector)) {
        if (!container || !container.isConnected || elementHidden(container)) continue;
        if (isExcludedVariantArea(container)) continue;
        try {
          if (norm(container.textContent).length > 4000) continue;
        } catch (e) {
          continue;
        }
        for (const g of parseVariantGroupsIn(container, strict)) {
          if (seen.has(g.label)) continue;
          seen.add(g.label);
          groups.push(g);
        }
      }
    };
    collect(VARIANT_STRONG_SELECTORS.join(','), false);
    if (groups.length) return groups;
    // 弱容器兜底：必须是「≥2 个选项 + 明确选中」，否则宁可不识别
    collect(VARIANT_WEAK_SELECTORS.join(','), true);
    return groups.filter(
      (g) => g.options.length >= 2 && (g.source === 'class' || g.source === 'aria' || g.source === 'style')
    );
  }

  // 套餐：只取规格选择区里 label 命中 套餐/版本/套装/组合/配置/规格 的组选中项（排除尺寸/系列品/颜色/型号）
  function packageFromVariantGroups(groups) {
    const list = Array.isArray(groups) ? groups : [];
    for (const label of PACKAGE_GROUP_PRIORITY) {
      for (const g of list) {
        if (g.label !== label) continue;
        const value = cleanVariantText(g.selected);
        if (value) return { value: value, group: g.label };
      }
    }
    for (const g of list) {
      if (PACKAGE_GROUP_EXCLUDE.test(g.label)) continue;
      if (!/(套餐|版本|套装|组合|配置|规格)/.test(g.label)) continue;
      const value = cleanVariantText(g.selected);
      if (value) return { value: value, group: g.label };
    }
    return null;
  }

  // 尺寸：屏幕尺寸组选中项参与英寸解析（来源 'variant'）；v2.1.6 同样只认唯一明确尺寸表达
  function sizeFromVariantGroups(groups) {
    const list = Array.isArray(groups) ? groups : [];
    for (const g of list) {
      if (!/^(?:屏幕尺寸|尺寸|屏幕大小|屏幕规格)$/.test(g.label)) continue;
      const strict = strictSizeOf(String(g.selected || ''));
      if (strict.kind === 'one') {
        return { inch: strict.inch, text: strict.text, source: 'variant', label: g.label };
      }
    }
    return null;
  }

  // 套餐（对外入口）：返回 {value, source:'规格选项', group} 或 null；**不再用标题/参数表兜底**
  function extractPackage(groups) {
    const list = Array.isArray(groups) ? groups : safeVariantGroups();
    const info = packageFromVariantGroups(list);
    if (!info) return null;
    return { value: info.value, source: '规格选项', group: info.group };
  }

  function safeVariantGroups() {
    try {
      return extractVariantGroups();
    } catch (e) {
      return [];
    }
  }

  // ---------------- 结果发送 ----------------
  function runtimeApi() {
    try {
      if (typeof chrome === 'undefined' || !chrome) return null;
      return chrome.runtime || null;
    } catch (e) {
      return null;
    }
  }

  function sendResult(result) {
    const api = window.__jdMarketCapture;
    if (api) {
      api.ready = true;
      api.lastResult = result;
    }
    const rt = runtimeApi();
    if (!rt || typeof rt.sendMessage !== 'function') return; // 普通页面（mock 测试）没有 chrome，不报错
    try {
      rt.sendMessage(result, () => {
        // 工作台没开时会设置 lastError，忽略即可
        void (rt && rt.lastError);
      });
    } catch (e) {
      try {
        rt.sendMessage(result);
      } catch (e2) {
        // 忽略发送失败
      }
    }
  }

  function buildBase() {
    const titleInfo = extractTitle();
    return {
      type: RESULT_TYPE,
      version: VERSION,
      sku: skuFromLocation(),
      url: currentUrl(),
      title: titleInfo.text,
      titleRaw: titleInfo.raw,
      titleSource: titleInfo.source,
      previewable: true,
      at: new Date().toISOString()
    };
  }

  function failResult(base, reason, flags, extra) {
    return Object.assign({}, base, {
      ok: false,
      reason: reason,
      flags: flags || pageFlags(),
      pageKind: (extra && extra.pageKind) || 'item',
      offSale: !!(extra && extra.offSale),
      softAnomaly: !!(extra && extra.softAnomaly),
      anomaly: (extra && extra.anomaly) || null,
      risk: (extra && extra.risk) || { hit: false, reason: '', url: currentUrl(), title: norm(document.title || '').slice(0, 120), detail: '' },
      previewable: !(extra && extra.previewable === false),
      sizeUncertain: !!(extra && extra.sizeUncertain),
      sizeReason: (extra && extra.sizeReason) || '',
      size: (extra && extra.size) || null,
      brand: (extra && extra.brand) || '',
      model: (extra && extra.model) || '',
      modelSource: (extra && extra.modelSource) || '',
      package: (extra && extra.package) || '',
      packageSource: (extra && extra.packageSource) || '',
      packageGroup: (extra && extra.packageGroup) || '',
      specGroups: (extra && extra.specGroups) || [],
      main: null,
      plus: null,
      hand: null,
      price: null,
      priceKind: '',
      priceKindLabel: '',
      priceRect: null,
      priceChanges: [],
      sourceLabel: '',
      pricePick: null,
      candidates: (extra && extra.candidates) || [],
      candidateCount: (extra && extra.candidateCount) || 0,
      textFallback: !!(extra && extra.textFallback),
      account: detectAccount()
    });
  }

  // ---------------- 主流程 ----------------
  async function main() {
    const pageState = detectPageState();
    const base = buildBase();
    const startedAt = Date.now();
    const noRisk = {
      hit: false,
      reason: '',
      url: pageState.url,
      title: pageState.title,
      detail: ''
    };
    const anomalyInfo = {
      reason: pageState.reason,
      detail: pageState.detail,
      url: pageState.url,
      title: pageState.title
    };

    // ① 下架/不存在：标记失败原因「已下架」并结束本条（工作台跳过继续下一条，不冷却、不算风控）
    if (pageState.kind === 'offSale') {
      const flags = pageFlags();
      flags.offSale = true;
      sendResult(
        failResult(base, pageStateReasonText(pageState), flags, {
          pageKind: 'offSale',
          offSale: true,
          anomaly: anomalyInfo,
          risk: noRisk,
          previewable: false
        })
      );
      return;
    }

    // ② 软异常（跳首页/空页/跳转异常，无验证特征）：不算风控；工作台等待 N 秒后自动继续
    if (pageState.kind === 'softAnomaly') {
      sendResult(
        failResult(base, pageStateReasonText(pageState), pageFlags(), {
          pageKind: 'softAnomaly',
          softAnomaly: true,
          anomaly: anomalyInfo,
          risk: noRisk,
          previewable: false
        })
      );
      return;
    }

    // ③ 风控（验证/登录/频控）：保持 v2.1.4 行为——工作台冷却 + 暂停
    if (pageState.kind === 'risk') {
      const risk = {
        hit: true,
        reason: pageState.reason,
        url: pageState.url,
        title: pageState.title,
        detail: pageState.detail
      };
      sendResult(
        failResult(base, pageStateReasonText(pageState), pageFlags(), {
          pageKind: 'risk',
          risk: risk,
          previewable: false
        })
      );
      return;
    }

    // 以下为正常商品页；risk 带上 hit:false 供 UI 判断「本次落地页正常」

    // 安全验证文案兜底（detectPageState 已覆盖，这里保留双保险）
    const flags0 = pageFlags();
    if (flags0.verify) {
      sendResult(
        failResult(base, '页面要求安全验证（可能触发风控），建议暂停采集并人工确认', flags0, {
          pageKind: 'risk',
          risk: Object.assign({}, noRisk, { hit: true, reason: 'verify', detail: '页面提示安全验证' }),
          previewable: false
        })
      );
      return;
    }

    let flags = flags0;
    if (flags.offSale) {
      sendResult(
        failResult(base, '商品已下架 / 页面提示商品不存在，无法采集价格', flags, Object.assign(productExtras(), {
          pageKind: 'offSale',
          offSale: true,
          anomaly: anomalyInfo,
          risk: noRisk,
          previewable: false
        }))
      );
      return;
    }

    // v2.1.7：巡检双轨版算法——稳定（连续 3 轮同价）后再复核（最多 4×1.2s），以最终读数为准。
    const stable = await waitForStablePrice();
    const finalRead = await recheckFinalPrice(stable);
    const cands = finalRead.cands || [];
    const picked = finalRead.picked || { hand: null, main: null, plus: null, source: '' };
    const priceChanges = finalRead.priceChanges || [];
    const best = bestPriceOf(picked);
    const usedTextFallback = false;

    // 尺寸/品牌/型号/套餐在价格等待之后再读，此时规格参数表通常已渲染完成
    const extras = productExtras();
    flags = pageFlags();
    // 可用候选数（非 suspect）：供多采样规则判断「取价证据是否偏弱」
    const usableCount = cands.filter((c) => c && !c.suspect).length;

    if (best == null) {
      const suspects = cands.filter((c) => c && c.suspect).slice(0, 8);
      // 页面只有「￥5」这类不完整价格（被拆开的数字片段）时给「低于合理下限」原因
      const fragment = detectPriceFragment();
      flags = pageFlags();
      flags.priceFragment = fragment || suspects.length > 0;
      let reason;
      if (flags.verify) {
        reason = '页面要求安全验证（可能触发风控），建议暂停采集并人工确认';
      } else if (flags.offSale) {
        reason = '商品已下架 / 页面提示商品不存在，无法采集价格';
      } else if (fragment) {
        reason =
          '疑似取价不完整（价格低于合理下限 ' +
          TUNING.minPlausiblePrice +
          ' 元），已跳过，建议重采或人工填写';
      } else if (suspects.length) {
        reason = '价格疑似数字片段或促销角标，已跳过（未采到可靠价格），建议重采或人工填写';
      } else {
        reason = '页面上没有识别到价格（页面可能改版或未加载完），建议重采或人工填写';
      }
      sendResult(
        failResult(base, reason, flags, {
          pageKind: 'item',
          offSale: false,
          softAnomaly: false,
          size: extras.size,
          sizeUncertain: extras.sizeUncertain,
          sizeReason: extras.sizeReason,
          brand: extras.brand,
          model: extras.model,
          modelSource: extras.modelSource,
          package: extras.package,
          packageSource: extras.packageSource,
          packageGroup: extras.packageGroup,
          specGroups: extras.specGroups,
          risk: noRisk,
          candidates: (suspects.length ? suspects : cands.slice(0, 8)).map(slimCandidate),
          candidateCount: usableCount,
          textFallback: usedTextFallback
        })
      );
      return;
    }

    // 选价结论（v2.1.7 巡检算法：到手价 → 电商平台价 → PLUS 价）
    const pick = picked.hand || picked.main || picked.plus || null;
    const finalFlags = pageFlags();
    finalFlags.priceFragment = cands.some((c) => c && c.suspect) || detectPriceFragment();

    sendResult(
      Object.assign({}, base, {
        ok: true,
        reason: '',
        flags: finalFlags,
        pageKind: 'item',
        offSale: false,
        softAnomaly: false,
        anomaly: null,
        risk: noRisk,
        previewable: true,
        size: extras.size,
        sizeUncertain: extras.sizeUncertain,
        sizeReason: extras.sizeReason,
        brand: extras.brand,
        model: extras.model,
        modelSource: extras.modelSource,
        package: extras.package,
        packageSource: extras.packageSource,
        packageGroup: extras.packageGroup,
        specGroups: extras.specGroups,
        account: detectAccount(),
        main: picked.main,
        plus: picked.plus,
        hand: picked.hand,
        price: pick ? pick.price : null,
        priceKind: pick ? pick.kind : '',
        priceKindLabel: priceKindLabel(pick && pick.kind),
        priceRect: pick && pick.rect ? pick.rect : null,
        priceChanges: priceChanges,
        sourceLabel: pick ? pick.cls || '' : '',
        pricePick: pick
          ? { price: pick.price, kind: pick.kind, source: pick.cls || '', label: pick.label || '', rect: pick.rect || null }
          : null,
        candidates: cands.slice(0, 12).map(slimCandidate),
        candidateCount: usableCount,
        textFallback: usedTextFallback,
        elapsedMs: Date.now() - startedAt
      })
    );
  }

  // 候选调试信息（DESIGN 22.2：price/kind/text/cls/font/strike/rect；旧字段 label/score/suspect 保留兼容）
  function slimCandidate(c) {
    return {
      price: c.price,
      kind: c.kind,
      text: String(c.label || '').slice(0, 60),
      label: String(c.label || '').slice(0, 80),
      cls: String(c.cls || '').slice(0, 120),
      font: c.font,
      strike: !!c.strike,
      rect: c.rect || null,
      score: c.score,
      suspect: !!c.suspect,
      digits: c.digits
    };
  }

  function safeSize(variantGroups) {
    try {
      return extractSize(variantGroups);
    } catch (e) {
      return null;
    }
  }

  function safeBrand() {
    try {
      return extractBrand();
    } catch (e) {
      return '';
    }
  }

  function safeModel(brand) {
    try {
      return extractModel(brand);
    } catch (e) {
      return null;
    }
  }

  function safePackage(variantGroups) {
    try {
      return extractPackage(variantGroups);
    } catch (e) {
      return null;
    }
  }

  // 商品维度字段一起取（尺寸/品牌/型号/套餐/规格选择区）——价格等待之后再调，DOM 渲染更完整。
  // 规格选择区只扫描一次，尺寸/套餐共用，避免重复扫描大 DOM。
  // v2.2：尺寸有两种「已采用」状态——
  //   · 明确（sizeUncertain=false）：规格表/规格选择区/唯一标题/唯一 alt 命中，可直接写库；
  //   · 已采用待核对（sizeUncertain=true，size 仍给值）：标题/alt 含多个尺寸时按最佳匹配选了一个，
  //     由 UI 展示「已优先采用 XX英寸（待核对）」，人工核对后清除标记。
  // 0 个明确尺寸 → size=null + sizeUncertain=true（空置等人工）。
  function productExtras() {
    const variantGroups = safeVariantGroups();
    const sizeInfo = safeSize(variantGroups);
    const sizeDefinite = !!(sizeInfo && sizeInfo.inch != null);
    const sizeUncertain = !sizeDefinite || !!(sizeInfo && sizeInfo.sizeUncertain);
    const brand = safeBrand();
    const modelInfo = safeModel(brand);
    const packageInfo = safePackage(variantGroups);
    return {
      size: sizeDefinite
        ? {
            inch: sizeInfo.inch,
            text: sizeInfo.text || '',
            source: sizeInfo.source || '',
            label: sizeInfo.label || '',
            // v2.2：多尺寸最佳匹配采用时仍给尺寸段，但带「待核对」标记
            sizeUncertain: sizeUncertain,
            matchedBy: sizeInfo.matchedBy || '',
            reason: sizeInfo.reason || '',
            sources: sizeInfo.sources || []
          }
        : null,
      sizeUncertain: sizeUncertain,
      sizeReason: sizeDefinite
        ? (sizeInfo.reason || '')
        : (sizeInfo && sizeInfo.reason) || '未识别到明确尺寸，待人工复核',
      brand: brand,
      model: modelInfo ? modelInfo.value : '',
      modelSource: modelInfo ? modelInfo.source : '',
      package: packageInfo ? packageInfo.value : '',
      packageSource: packageInfo ? packageInfo.source : '',
      packageGroup: packageInfo && packageInfo.group ? packageInfo.group : '',
      specGroups: variantGroups.map((g) => ({
        label: g.label,
        selected: g.selected,
        options: (g.options || []).slice(0, 12),
        source: g.source || ''
      })).slice(0, 20)
    };
  }

  // ---------------- 预览快照（v2.1.4 人工通道；v2.1.5 增加三分类字段）----------------
  // 小眼睛预览窗口加载完成后，工作台向该 tab 发 PREVIEW_CAPTURE；这里立即读一次当前 DOM
  // （不等价格稳定，也不做多轮采样），返回与采集结果同构的快照，供人工「采用/忽略」。
  function buildPreviewSnapshot() {
    const pageState = detectPageState();
    const titleInfo = extractTitle();
    const anomalyInfo = {
      reason: pageState.reason,
      detail: pageState.detail,
      url: pageState.url,
      title: pageState.title
    };
    const risk =
      pageState.kind === 'risk'
        ? { hit: true, reason: pageState.reason, url: pageState.url, title: pageState.title, detail: pageState.detail }
        : { hit: false, reason: '', url: pageState.url, title: pageState.title, detail: '' };
    const base = {
      type: 'PREVIEW_CAPTURE_RESULT',
      version: VERSION,
      sku: skuFromLocation(),
      url: currentUrl(),
      title: titleInfo.text,
      at: new Date().toISOString(),
      preview: true,
      pageKind: pageState.kind,
      offSale: pageState.kind === 'offSale',
      softAnomaly: pageState.kind === 'softAnomaly',
      anomaly: pageState.kind === 'item' ? null : anomalyInfo
    };
    if (pageState.kind !== 'item') {
      return Object.assign(base, {
        ok: false,
        reason: pageStateReasonText(pageState),
        risk: risk,
        previewable: false,
        prices: { hand: null, main: null, plus: null },
        price: null,
        priceKind: '',
        priceKindLabel: '',
        priceRect: null,
        sourceLabel: '',
        priceChanges: [],
        pricePick: null,
        candidates: [],
        candidateCount: 0,
        size: null,
        sizeUncertain: true,
        sizeReason: '异常落地页，未解析尺寸',
        model: '',
        modelSource: '',
        package: '',
        packageSource: '',
        specGroups: [],
        packageGroup: ''
      });
    }

    // 只扫一遍当前 DOM（不等待稳定，也不做复核），读不到就回 ok:false，让 UI 允许用户稍后重试
    const snap = readPriceSnapshot(false);
    const cands = snap.cands || [];
    const picked = snap.picked || { hand: null, main: null, plus: null, source: '' };
    const best = bestPriceOf(picked);
    const extras = productExtras();
    const pick = picked.hand || picked.main || picked.plus || null;
    const ok = best != null && pick != null;
    return Object.assign(base, {
      ok: ok,
      reason: ok ? '' : '预览页面暂未读到价格（可能还没渲染完，可稍等后重试，或人工填写）',
      risk: risk,
      previewable: true,
      prices: {
        hand: picked.hand ? picked.hand.price : null,
        main: picked.main ? picked.main.price : null,
        plus: picked.plus ? picked.plus.price : null
      },
      price: pick ? pick.price : null,
      priceKind: pick ? pick.kind : '',
      priceKindLabel: priceKindLabel(pick && pick.kind),
      priceRect: pick && pick.rect ? pick.rect : null,
      sourceLabel: pick ? pick.cls || '' : '',
      priceChanges: [],
      pricePick: pick
        ? { price: pick.price, kind: pick.kind, source: pick.cls || '', label: pick.label || '', rect: pick.rect || null }
        : null,
      size: extras.size,
      sizeUncertain: extras.sizeUncertain,
      sizeReason: extras.sizeReason,
      model: extras.model,
      modelSource: extras.modelSource,
      package: extras.package,
      packageSource: extras.packageSource,
      specGroups: extras.specGroups,
      packageGroup: extras.packageGroup,
      candidates: cands.slice(0, 12).map(slimCandidate),
      candidateCount: cands.filter((c) => c && !c.suspect).length
    });
  }

  // 调试/测试入口：window.__jdMarketCapture
  window.__jdMarketCapture = {
    version: VERSION,
    ready: false,
    lastResult: null,
    skuFromLocation: skuFromLocation,
    extractTitle: extractTitle,
    extractSize: extractSize,
    extractBrand: extractBrand,
    extractModel: extractModel,
    extractPackage: extractPackage,
    extractVariantGroups: extractVariantGroups,
    packageFromVariantGroups: packageFromVariantGroups,
    cleanVariantText: cleanVariantText,
    // v2.1.7 价格调试入口（旧名 collectCandidates/pickPrices 保留兼容）
    collectCandidates: function () {
      return collectPriceCandidates(true);
    },
    collectPriceCandidates: collectPriceCandidates,
    parsePriceText: parsePriceText,
    pickPrices: pickPriceCandidates,
    pickPriceCandidates: pickPriceCandidates,
    readPriceSnapshot: readPriceSnapshot,
    collectSpecRows: collectSpecRows,
    pageFlags: pageFlags,
    detectAccount: detectAccount,
    detectRiskPage: detectRiskPage,
    detectPageState: detectPageState,
    pageStateReasonText: pageStateReasonText,
    riskReasonText: riskReasonText,
    findStrictInches: findStrictInches,
    strictSizeOf: strictSizeOf,
    // v2.2 尺寸最佳匹配调试入口（多尺寸选一个 / 待核对原因）
    sizeHintNumbers: sizeHintNumbers,
    pickBestInch: pickBestInch,
    multiSizeReasonText: multiSizeReasonText,
    buildPreviewSnapshot: buildPreviewSnapshot,
    findInches: findInches,
    isStrike: isStrike,
    tuning: TUNING,
    runOnce: main
  };

  // 消息处理：PING（存活探测）+ PREVIEW_CAPTURE（小眼睛预览快照）
  const rt = runtimeApi();
  if (rt && rt.onMessage && typeof rt.onMessage.addListener === 'function') {
    try {
      rt.onMessage.addListener((msg, sender, sendResponse) => {
        if (!msg || typeof sendResponse !== 'function') return false;
        if (msg.type === 'SHARE_PING') {
          sendResponse({ ok: true, sku: skuFromLocation(), url: currentUrl(), version: VERSION });
          return false;
        }
        if (msg.type === 'PREVIEW_CAPTURE') {
          let payload;
          try {
            payload = buildPreviewSnapshot();
          } catch (e) {
            payload = {
              type: 'PREVIEW_CAPTURE_RESULT',
              version: VERSION,
              sku: skuFromLocation(),
              url: currentUrl(),
              ok: false,
              reason: '预览快照失败：' + ((e && e.message) || e),
              risk: null,
              prices: { hand: null, main: null, plus: null }
            };
          }
          try {
            sendResponse(payload);
          } catch (e2) {
            // 通道已关闭时忽略
          }
          return false;
        }
        // 其余消息不响应（避免误接管工作台其它消息）
        return false;
      });
    } catch (e) {
      // 忽略监听失败
    }
  }

  // 顶层 try/catch：脚本内部异常也要回报一条失败结果，避免工作台白等 35 秒超时
  main().catch((err) => {
    let reason = '采集脚本内部异常：';
    try {
      reason += (err && err.message) || String(err);
    } catch (e) {
      reason += '未知错误';
    }
    try {
      sendResult(failResult(buildBase(), reason, pageFlags(), {}));
    } catch (e2) {
      // 忽略
    }
  });
})();
