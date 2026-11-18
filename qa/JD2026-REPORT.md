# 电商平台 2026 新版详情页 · 真实 DOM 取价回归（v1.1.1）

- 时间：2026/11/17 15:59:45
- 页面来源：用户真实浏览器抓取的电商平台详情页 DOM 快照（脱敏），`qa/engine/fixtures/jd-2026/real-100370009110.html`
- 期望：到手价 ¥5149 / 划线价 ¥5499（用户核对的会员价）

| # | 检查项 | 结果 | 详情 |
|---|---|---|---|
| J1 | 真实页面 fixture（电商平台 2026 新版详情页快照）存在 | ✅ | 157 KB · SKU 100370009110 |
| J-patrol-1 | patrol 引擎在真实新版页面收到上报 | ✅ | type=PATROL_ITEM_PRICE_RESULT ok=true |
| J-patrol-2 | patrol 引擎取到真实到手价 ¥5149 | ✅ | hand=5149 |
| J-patrol-3 | patrol 引擎取到划线价 ¥5499 | ✅ | main=5499 |
| J-share-1 | share 引擎在真实新版页面收到上报 | ✅ | type=ITEM_CAPTURE_RESULT ok=true |
| J-share-2 | share 引擎取到真实到手价 ¥5149 | ✅ | hand=5149 |
| J-share-3 | share 引擎取到划线价 ¥5499 | ✅ | main=5499 |
| J-radar-1 | radar 引擎在真实新版页面收到上报 | ✅ | type=RADAR_ITEM_PRICE_RESULT ok=true |
| J-radar-2 | radar 引擎取到真实到手价 ¥5149 | ✅ | hand=5149 |
| J-radar-3 | radar 引擎取到划线价 ¥5499 | ✅ | main=5499 |
| J-radar-4 | radar 不再把新版页面误判为下架 | ✅ | offSale=false hasProductName=true |
| J-consistency | 三引擎到手价口径一致（巡检=市占率=竞品） | ✅ | patrol=5149 share=5149 radar=5149 |

结论：✅ 全部通过（12/12）
