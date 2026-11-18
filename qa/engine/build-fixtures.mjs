// 取价引擎一致性矩阵 · 本地 mock 商品页生成器（零依赖）
//
// 生成 qa/engine/fixtures/*.html。夹具只做一件事：模拟电商平台商品页里与「取价」相关的最小 DOM，
// 类名/字号/标签尽量对齐真实 item.shop.example.com 页面（摘要价区 / 到手价大号红字 / 电商平台价小号划线 /
// PLUS 会员价 / 跨平台比价卡片 / 推荐-关联购买-广告 / 下架与验证页）。
//
// 用法：node qa/engine/build-fixtures.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCENARIOS } from './scenarios.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures');

const VARIANTS = `<div id="choose-attrs" class="choose-attrs">
      <div class="li-group">
        <div class="li-label">版本</div>
        <div class="li-items">
          <div class="item selected">会议大屏+摄像头【免费送装一体】</div>
          <div class="item">单屏</div>
        </div>
      </div>
      <div class="li-group">
        <div class="li-label">屏幕尺寸</div>
        <div class="li-items">
          <div class="item selected">75英寸</div>
          <div class="item">65英寸</div>
        </div>
      </div>
    </div>`;

const SPEC = `<div id="specification" class="specification">
      <h2>规格参数</h2>
      <table><tbody>
        <tr><th>屏幕尺寸</th><td>75英寸</td></tr>
        <tr><th>品牌</th><td>酷开</td></tr>
        <tr><th>型号</th><td>75P5 Pro</td></tr>
        <tr><th>分辨率</th><td>4K 超高清</td></tr>
      </tbody></table>
    </div>`;

const PRODUCT_NAME = '酷开 75英寸 4K 会议平板 75P5 Pro 商用显示器（含移动支架）';

const row = (label, cls, text) =>
  `<div class="price-row"><span class="label">${label}</span><span class="${cls}">${text}</span></div>`;

const STANDARD_ROWS = row('电商平台价', 'p-main', '￥16,999') + row('到手价', 'p-hand', '￥15,699');

const page = ({ title, body, head = '', style = '', script = '' }) => `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${title}</title>
<link rel="stylesheet" href="fixture-base.css">
${style ? `<style>${style}</style>` : ''}
${head}
</head>
<body>
${body}
${script ? `<script>${script}</script>` : ''}
</body>
</html>
`;

const mainCol = (inner) => `<div class="main-col">${inner}</div>`;
const productMain = (rows, extra = '') => `${mainCol(
  `<h1 class="sku-name">${PRODUCT_NAME}</h1>
    <div class="summary-price-wrap"><div class="summary-price">
      ${rows}
    </div></div>
    ${VARIANTS}
    ${SPEC}
    ${extra}`
)}`;

// ---------------------------------------------------------------------------
// 各场景正文
// ---------------------------------------------------------------------------
const BUILDERS = {
  S01: () =>
    page({
      title: '【酷开75P5Pro】酷开 75英寸 4K 会议平板 75P5 Pro 商用显示器 - 电商平台',
      body: `<div class="page">
  ${productMain(STANDARD_ROWS)}
  <div class="side-col"><div class="card service-box"><div class="card-title">配送与服务</div><div>电商平台自营 · 次日达 · 免费送装一体</div></div></div>
</div>`
    }),

  S02: () =>
    page({
      title: '【酷开75P5Pro】酷开 75英寸 4K 会议平板 75P5 Pro - 电商平台',
      body: `<div class="page">
  ${productMain(
    row('电商平台价', 'p-main', '￥16,999') +
      row('PLUS会员价', 'p-plus', '￥14,999') +
      row('到手价', 'p-hand', '￥15,699')
  )}
  <div class="side-col"><div class="card service-box"><div class="card-title">PLUS 会员</div><div>开通 PLUS 会员立省 ￥700</div></div></div>
</div>`
    }),

  S03: () =>
    page({
      title: '【酷开75P5Pro】酷开 75英寸 4K 会议平板 75P5 Pro - 电商平台',
      body: `<div class="page">
  ${productMain(STANDARD_ROWS)}
  <div class="side-col">
    <div class="card cross_platform_compare">
      <div class="card-title">全网比价</div>
      <div class="price-row"><span class="label">到手价</span><span class="decoy-big">￥8,499</span></div>
      <div class="card-note">同款商品在其他平台的价格，仅供参考</div>
    </div>
    <div class="card service-box"><div class="card-title">配送与服务</div><div>电商平台自营 · 次日达</div></div>
  </div>
</div>`
    }),

  S04: () =>
    page({
      title: '【酷开75P5Pro】酷开 75英寸 4K 会议平板 75P5 Pro - 电商平台',
      body: `<div class="page">
  ${productMain(STANDARD_ROWS)}
  <div class="side-col">
    <div class="card recommend">
      <div class="card-title">猜你喜欢</div>
      <div class="rec-name">某品牌 65英寸 会议平板 <span class="tag-offline">已下架</span></div>
      <div class="price-row"><span class="label">到手价</span><span class="decoy-big">￥1,999</span></div>
    </div>
    <div class="card continuous-product">
      <div class="card-title">经常一起购买</div>
      <div class="price-row"><span class="label">到手价</span><span class="decoy-big">￥8,499</span></div>
    </div>
    <div class="card advert">
      <div class="card-title">广告</div>
      <div class="price-row"><span class="label">到手价</span><span class="decoy-big">￥666</span></div>
    </div>
  </div>
</div>`
    }),

  S05: () =>
    page({
      title: '【酷开75P5Pro】酷开 75英寸 4K 会议平板 75P5 Pro - 电商平台',
      body: `<div class="page">
  <div class="main-col">
    <h1 class="sku-name">${PRODUCT_NAME}</h1>
    <div class="summary-price-wrap"><div class="summary-price" style="display:none">
      ${STANDARD_ROWS}
    </div></div>
    <div class="login-tip">价格以实际下单页为准</div>
    ${VARIANTS}
    ${SPEC}
  </div>
  <div class="side-col"><div class="card service-box"><div class="card-title">配送与服务</div><div>电商平台自营 · 次日达</div></div></div>
</div>`
    }),

  S06: () =>
    page({
      title: '【酷开75P5Pro】酷开 75英寸 4K 会议平板 75P5 Pro - 电商平台',
      body: `<div class="page">
  <div class="main-col">
    <h1 class="sku-name">${PRODUCT_NAME}</h1>
    <div class="summary-price-wrap"><div class="summary-price">
      <div class="price-row"><span class="label">到手价</span><div class="p-hand-split"><span class="cur">￥</span><span class="int">8,607</span><span class="dec">.56</span></div></div>
    </div></div>
    ${VARIANTS}
    ${SPEC}
  </div>
  <div class="side-col"><div class="card service-box"><div class="card-title">配送与服务</div><div>电商平台自营 · 次日达</div></div></div>
</div>`
    }),

  S07: () =>
    page({
      title: '【酷开75P5Pro】酷开 75英寸 4K 会议平板 75P5 Pro - 电商平台',
      body: `<div class="page">
  ${productMain(
    STANDARD_ROWS +
      `<div class="countdown">距结束 <span class="delay-num">56</span> 秒</div>
    <div class="discount-badge">限时5折</div>
    <div class="coupon-note">满5000减500</div>
    <div class="fragment-dec">.56</div>
    <div class="installment">白条12期免息</div>`
  )}
  <div class="side-col"><div class="card service-box"><div class="card-title">配送与服务</div><div>电商平台自营 · 次日达</div></div></div>
</div>`
    }),

  S08: () =>
    page({
      title: '电商平台(shop.example.com)-正品低价、品质保障、配送及时、轻松购物！',
      body: `<div class="page">
  <div class="main-col">
    <div class="jd-header">电商平台</div>
    <div class="notice offline-tip">很抱歉，该商品已下架</div>
    <div class="card recommend">
      <div class="card-title">为你推荐</div>
      <div class="price-row"><span class="label">到手价</span><span class="decoy-big">￥8,499</span></div>
    </div>
  </div>
</div>`
    }),

  S09: () =>
    page({
      title: '【酷开75P5Pro】酷开 75英寸 4K 会议平板 75P5 Pro - 电商平台',
      body: `<div class="page">
  <div class="main-col">
    <h1 class="sku-name">${PRODUCT_NAME}</h1>
    <div class="summary-price-wrap"><div class="summary-price">
      <div class="soldout-tip">该商品已售完</div>
      <div class="arrival-tip">到货通知</div>
    </div></div>
    ${SPEC}
  </div>
  <div class="side-col"><div class="card service-box"><div class="card-title">配送与服务</div><div>电商平台自营</div></div></div>
</div>`
    }),

  S10: () =>
    page({
      title: '安全验证 - 电商平台',
      body: `<div class="verify-wrap">
  <div class="captcha">请完成验证</div>
  <p>访问过于频繁，请拖动滑块完成验证</p>
</div>`
    }),

  S11: () =>
    page({
      title: '【酷开75P5Pro】酷开 75英寸 4K 会议平板 75P5 Pro - 电商平台',
      body: `<div class="promo-hero">电商平台 11.11 全球热爱季 · 主会场</div>
<div class="page">
  ${productMain(STANDARD_ROWS)}
  <div class="side-col"><div class="card service-box"><div class="card-title">配送与服务</div><div>电商平台自营 · 次日达</div></div></div>
</div>`
    }),

  S12: () =>
    page({
      title: '【酷开75P5Pro】酷开 75英寸 4K 会议平板 75P5 Pro - 电商平台',
      body: `<div class="page">
  ${productMain(
    STANDARD_ROWS +
      `<div class="origin-price-tip"><span class="label">原价</span><span class="p-small-strike">￥19,999</span></div>`
  )}
  <div class="side-col"><div class="card service-box"><div class="card-title">配送与服务</div><div>电商平台自营 · 次日达</div></div></div>
</div>`
    }),

  S13: () =>
    page({
      title: '【酷开75P5Pro】酷开 75英寸 4K 会议平板 75P5 Pro - 电商平台',
      body: `<div class="page">
  ${productMain(
    row('电商平台价', 'p-main', '￥16,999') + row('券后价', 'p-hand', '￥15,499')
  )}
  <div class="side-col">
    <div class="card coupon-card">
      <div class="card-title">优惠券</div>
      <div class="coupon-item">满5000减500 <span class="coupon-amount">￥500</span></div>
    </div>
    <div class="card service-box"><div class="card-title">配送与服务</div><div>电商平台自营 · 次日达</div></div>
  </div>
</div>`
    }),

  S14: () =>
    page({
      title: '【酷开75P5Pro】酷开 75英寸 4K 会议平板 75P5 Pro - 电商平台',
      body: `<div class="page">
  ${productMain(row('电商平台价', 'p-main', '￥26,999') + row('到手价', 'p-hand', '￥24,699'))}
  <div class="side-col"><div class="card service-box"><div class="card-title">配送与服务</div><div>电商平台自营 · 次日达</div></div></div>
</div>`,
      // 券/促销二次计算：1.8 秒后页面把到手价刷新为 ￥25,099（实测 24699→25099 的真实现象）
      script: `setTimeout(function () {
  var el = document.querySelector('.p-hand');
  if (el) el.textContent = '￥25,099';
}, 1800);`
    }),

  S15: () =>
    page({
      title: '【酷开75P5Pro】酷开 75英寸 4K 会议平板 75P5 Pro - 电商平台',
      body: `<div class="page">
  <div class="main-col">
    <h1 class="sku-name">${PRODUCT_NAME}</h1>
    <div class="summary-price-wrap"><div class="summary-price">
      <div class="price-row"><span class="label">电商平台价</span><span class="p-jd-big">￥16,999</span></div>
      <div class="price-row"><span class="label">市场价</span><span class="p-small-strike">￥19,999</span></div>
    </div></div>
    ${VARIANTS}
    ${SPEC}
  </div>
  <div class="side-col"><div class="card service-box"><div class="card-title">配送与服务</div><div>电商平台自营 · 次日达</div></div></div>
</div>`
    })
};

// ---------------------------------------------------------------------------
// 生成
// ---------------------------------------------------------------------------
fs.mkdirSync(FIXTURES, { recursive: true });
let count = 0;
for (const sc of SCENARIOS) {
  const builder = BUILDERS[sc.id];
  if (!builder) throw new Error(`场景 ${sc.id} 没有夹具构建器（build-fixtures.mjs 的 BUILDERS 缺 key）`);
  const html = builder();
  const out = path.join(FIXTURES, sc.file);
  fs.writeFileSync(out, html, 'utf8');
  count += 1;
  console.log(`[fixture] ${sc.id} → fixtures/${sc.file}（${html.length} 字符）`);
}
const orphans = Object.keys(BUILDERS).filter((id) => !SCENARIOS.some((s) => s.id === id));
if (orphans.length) console.warn(`[warn] 未使用的构建器：${orphans.join(', ')}`);
console.log(`[done] 共生成 ${count} 个夹具到 ${FIXTURES}`);
