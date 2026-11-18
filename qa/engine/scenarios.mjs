// 取价引擎一致性矩阵 · 场景清单（夹具 + 期望值）
//
// 基准：modules/patrol/content.js（巡检 v1.3.4 内 content.js，取价规则 v2.1）为**唯一基准**。
// 期望值 = 该场景下「三个业务应该得到的结论」（到手价/电商平台价/PLUS价、下架/验证/无货、是否猜价）。
// verdict 归一化口径（便于跨引擎比较）：
//   sellable    正常商品页，读到了可采信的价格
//   noprice     商品页但读不到价格（隐藏/未渲染/片段）
//   unsellable  下架 / 不存在 / 售罄 / 无货（不可售，不采信页面数字）
//   verify      安全验证 / 滑块 / 频控页
//   login       跳到登录页
// extras 允许各引擎不同：share 的尺寸/型号/套餐/品牌/快照结构；radar 的置信度/主价格区/页面状态。
//
// SKU 形如 1000000<NN>00N，NN 为场景序号；夹具按 file 字段从 fixtures/ 读取，由 build-fixtures.mjs 生成。

export const SCENARIOS = [
  {
    id: 'S01',
    sku: '100000001101',
    file: 's01-standard.html',
    name: '标准到手价 + 划线电商平台价',
    expect: { ok: true, price: 15699, hand: 15699, main: 16999, plus: null, verdict: 'sellable' }
  },
  {
    id: 'S02',
    sku: '100000002101',
    file: 's02-plus.html',
    name: 'PLUS 会员价（到手价 + 电商平台价 + PLUS价）',
    expect: { ok: true, price: 15699, hand: 15699, main: 16999, plus: 14999, verdict: 'sellable' }
  },
  {
    id: 'S03',
    sku: '100000003101',
    file: 's03-cross-platform.html',
    name: '跨平台比价卡片干扰（更大字号 ￥8,499 到手价）',
    expect: { ok: true, price: 15699, hand: 15699, main: 16999, plus: null, verdict: 'sellable' }
  },
  {
    id: 'S04',
    sku: '100000004101',
    file: 's04-recommend.html',
    name: '关联购买/推荐/广告干扰（推荐位含「已下架」字样）',
    expect: { ok: true, price: 15699, hand: 15699, main: 16999, plus: null, verdict: 'sellable' }
  },
  {
    id: 'S05',
    sku: '100000005101',
    file: 's05-hidden-price.html',
    name: '隐藏价格（display:none，不予猜价）',
    expect: { ok: false, price: null, hand: null, main: null, plus: null, verdict: 'noprice' }
  },
  {
    id: 'S06',
    sku: '100000006101',
    file: 's06-split-digits.html',
    name: '拆分数字（￥8,607 + .56 → 完整 8607.56）',
    expect: { ok: true, price: 8607.56, hand: 8607.56, main: null, plus: null, verdict: 'sellable' }
  },
  {
    id: 'S07',
    sku: '100000007101',
    file: 's07-fragments.html',
    name: '小数/折扣片段（56、.56、5折、满5000减500、12期）',
    expect: { ok: true, price: 15699, hand: 15699, main: 16999, plus: null, verdict: 'sellable' }
  },
  {
    id: 'S08',
    sku: '100000008101',
    file: 's08-off-sale.html',
    name: '下架页（该商品已下架 + 推荐位残留价格）',
    expect: { ok: false, price: null, hand: null, main: null, plus: null, verdict: 'unsellable' }
  },
  {
    id: 'S09',
    sku: '100000009101',
    file: 's09-sold-out.html',
    name: '售罄/无货（该商品已售完 + 到货通知）',
    expect: { ok: false, price: null, hand: null, main: null, plus: null, verdict: 'unsellable' }
  },
  {
    id: 'S10',
    sku: '100000010101',
    file: 's10-verify.html',
    name: '安全验证页（滑块/访问频繁，不解析价格）',
    expect: { ok: false, price: null, hand: null, main: null, plus: null, verdict: 'verify' }
  },
  {
    id: 'S11',
    sku: '100000011101',
    file: 's11-below-fold.html',
    name: '首屏外价格（放宽到整页后仍应取到 ￥15,699）',
    expect: { ok: true, price: 15699, hand: 15699, main: 16999, plus: null, verdict: 'sellable' }
  },
  {
    id: 'S12',
    sku: '100000012101',
    file: 's12-small-strike.html',
    name: '小字划线价（￥19,999 小字原价不得替换电商平台价 ￥16,999）',
    expect: { ok: true, price: 15699, hand: 15699, main: 16999, plus: null, verdict: 'sellable' }
  },
  {
    id: 'S13',
    sku: '100000013101',
    file: 's13-coupon-price.html',
    name: '券后价（￥15,499 + 优惠券 ￥500 干扰）',
    expect: { ok: true, price: 15499, hand: 15499, main: 16999, plus: null, verdict: 'sellable' }
  },
  {
    id: 'S14',
    sku: '100000014101',
    file: 's14-price-refresh.html',
    name: '价格二次刷新（￥24,699 → ￥25,099，以最终读数为准）',
    expect: { ok: true, price: 25099, hand: 25099, main: 26999, plus: null, verdict: 'sellable' },
    refreshFrom: 24699
  },
  {
    id: 'S15',
    sku: '100000015101',
    file: 's15-no-hand-label.html',
    name: '无「到手价」标签（只有电商平台价，应回退 main 而不是冒充 hand）',
    expect: { ok: true, price: 16999, hand: null, main: 16999, plus: null, verdict: 'sellable' }
  }
];

// 期望值是否逐字段严格一致（用于矩阵判定）
export const COMPARE_FIELDS = ['ok', 'price', 'hand', 'main', 'plus', 'verdict'];
