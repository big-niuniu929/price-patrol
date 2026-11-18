'use strict';

// ============================================================
// 矩阵阵列 · 独立大屏页面
// 只负责「显示」：卡片弧线排布、实时读数、关闭时碎成粉末。
// 数据来自工作台页（app.js）通过 BroadcastChannel 推送。
// ============================================================

const BX_CHANNEL = 'patrol-matrix-board-v1';
const BX_STATE_TEXT = { loading: '打开中', reading: '读取中', read: '已读', fail: '失败' };

let channel = null;
try {
  channel = new BroadcastChannel(BX_CHANNEL);
} catch (e) {
  channel = null;
}

const bx = {
  session: '',
  cards: new Map(),
  order: [],
  syncReceived: false,
  running: false,
  finished: false,
  shatter: true,
  phase: '待命',
  lastMsgAt: Date.now(),
  offline: false,
  fx: [],
  raf: 0,
  fxW: 0,
  fxH: 0,
  dpr: 1,
  summaryTimer: null,
  reconnectTimer: null,
  lastStats: null
};

const stageEl = document.getElementById('bxStage');
const cardsEl = document.getElementById('bxCards');
const emptyEl = document.getElementById('bxEmpty');
const summaryEl = document.getElementById('bxSummary');
const offlineEl = document.getElementById('bxOffline');
const fxEl = document.getElementById('bxFx');
const phaseEl = document.getElementById('bxPhase');
const subEl = document.getElementById('bxSub');
const footEl = document.getElementById('bxFootText');

const kBatch = document.getElementById('kBatch');
const kBatchHint = document.getElementById('kBatchHint');
const kConc = document.getElementById('kConc');
const kRead = document.getElementById('kRead');
const kDone = document.getElementById('kDone');
const kOk = document.getElementById('kOk');
const kFail = document.getElementById('kFail');

// ---------------- 通道 ----------------
function bxSend(msg) {
  if (!channel) return;
  try {
    channel.postMessage(msg);
  } catch (e) {
    // 忽略
  }
}

function bxHello() {
  bxSend({ type: 'hello', at: Date.now() });
}

if (channel) {
  channel.onmessage = (ev) => bxReceive(ev.data);
}
bxHello();
setInterval(() => {
  if (!bx.syncReceived) bxHello();
}, 1500);

function bxReceive(msg) {
  if (!msg || typeof msg !== 'object') return;
  bx.lastMsgAt = Date.now();
  if (bx.reconnectTimer) {
    clearInterval(bx.reconnectTimer);
    bx.reconnectTimer = null;
  }
  if (bx.offline) {
    bx.offline = false;
    offlineEl.classList.add('hidden');
  }
  // 同一时间只接受同一轮的消息；新轮次（runStart/sync）会更新 session
  if (msg.session && bx.session && msg.session !== bx.session && msg.type !== 'runStart' && msg.type !== 'sync') {
    return;
  }
  switch (msg.type) {
    case 'sync':
      bxApplySync(msg);
      break;
    case 'runStart':
      bxStartRun(msg);
      break;
    case 'batchStart':
      bxStartBatch(msg);
      break;
    case 'cardAdd':
      bxAddCard(msg.card, msg.index, msg.total);
      break;
    case 'card':
      bxUpdateCard(msg);
      break;
    case 'status':
      bxApplyStatus(msg);
      break;
    case 'closeBatch':
      bxCloseBatch(msg);
      break;
    case 'finish':
      bxFinish(msg);
      break;
    case 'heartbeat':
      break;
    case 'bye':
      bxGoOffline('工作台已关闭');
      break;
    default:
      break;
  }
}

// ---------------- 状态渲染 ----------------
function bxSetPhase(text, tone) {
  bx.phase = text || '待命';
  phaseEl.textContent = bx.phase;
  phaseEl.dataset.tone = tone || (bx.finished ? 'ok' : bx.running ? 'run' : 'idle');
}

function bxSetSub(text) {
  subEl.textContent = text || '';
}

function bxSetKpis(s) {
  s = s || {};
  const hasBatch = s.batchCount > 0;
  if (hasBatch) {
    kBatch.textContent = '第 ' + ((s.batchIndex || 0) + 1) + ' / ' + s.batchCount + ' 批';
    kBatchHint.textContent = bx.finished ? '共 ' + s.batchCount + ' 批' : '';
  } else {
    kBatch.textContent = '—';
    kBatchHint.textContent = '';
  }
  kConc.textContent = s.batchSize ? String(s.batchSize) : '—';
  kRead.textContent = s.batchSize ? ((s.read || 0) + ' / ' + (s.currentBatchCount || s.batchSize)) : '—';
  kDone.textContent = (s.done || 0) + ' / ' + (s.total || 0);
  kOk.textContent = String(s.ok || 0);
  kFail.textContent = String(s.fail || 0);
  if (s.finished && s.batchSize && !s.stopped) {
    kRead.textContent = s.batchSize + ' / ' + s.batchSize;
  }
  bx.lastStats = s;
}

function bxApplyStatus(s) {
  bx.running = !!s.running;
  bx.finished = !!s.finished;
  bxSetKpis(s);
  if (s.phaseText) bxSetPhase(s.phaseText, s.stopped ? 'warn' : bx.running ? 'run' : undefined);
  if (s.account) {
    bxSetSub('账号：' + s.account + ' · ' + (s.batchSize ? '每批 ' + s.batchSize + ' 个' : '') + (s.total ? ' · 共 ' + s.total + ' 个 SKU' : ''));
  }
  if (bx.running) {
    emptyEl.classList.add('hidden');
  }
}

// ---------------- 一轮开始 / 批次 ----------------
function bxStartRun(msg) {
  bx.session = msg.session || bx.session;
  bx.syncReceived = true;
  bx.running = true;
  bx.finished = false;
  bx.shatter = msg.shatter !== false;
  bxCancelSummary();
  summaryEl.classList.add('hidden');
  emptyEl.classList.add('hidden');
  bxClearCards(true);
  bxClearFx();
  bxSetPhase('准备中', 'run');
  bxSetKpis({
    batchIndex: 0,
    batchCount: msg.batchCount || 0,
    batchSize: msg.batchSize || 0,
    currentBatchCount: 0,
    read: 0,
    done: 0,
    total: msg.total || 0,
    ok: 0,
    fail: 0
  });
  bxSetSub('账号：' + (msg.identity === 'plus' ? 'PLUS 会员' : '普惠') + ' · 共 ' + (msg.total || 0) + ' 个 SKU · 每批 ' + (msg.batchSize || 0) + ' 个');
  footEl.textContent = '批量读取 → 一次批量写入 → 整排碎成粉末 → 下一批';
}

function bxStartBatch(msg) {
  bx.running = true;
  bx.finished = false;
  bx.shatter = msg.shatter !== false;
  bxCancelSummary();
  summaryEl.classList.add('hidden');
  emptyEl.classList.add('hidden');
  bxClearCards(true);
  bxSetKpis({
    batchIndex: msg.batchIndex || 0,
    batchCount: msg.batchCount || 0,
    batchSize: msg.batchSize || 0,
    currentBatchCount: msg.count || msg.batchSize || 0,
    read: 0,
    done: (bx.lastStats && bx.lastStats.done) || 0,
    total: (bx.lastStats && bx.lastStats.total) || 0,
    ok: (bx.lastStats && bx.lastStats.ok) || 0,
    fail: (bx.lastStats && bx.lastStats.fail) || 0
  });
  bxSetPhase('第 ' + ((msg.batchIndex || 0) + 1) + '/' + (msg.batchCount || 1) + ' 批 · 并行打开', 'run');
}

function bxApplySync(msg) {
  bx.session = msg.session || bx.session;
  bx.syncReceived = true;
  bx.running = !!msg.running;
  bx.finished = !!msg.finished;
  bx.shatter = msg.shatter !== false;
  bxCancelSummary();
  bxClearCards(true);
  bxClearFx();
  bxSetKpis(msg.stats || {});
  bxSetPhase(msg.phase || (msg.finished ? '完成' : msg.running ? '读取中' : '待命'), msg.finished ? 'ok' : msg.running ? 'run' : 'idle');
  bxSetSub(msg.sub || '矩阵阵列 · 独立窗口');
  if (msg.finished && msg.finalStats) {
    bxShowSummary(msg.finalStats);
  } else {
    summaryEl.classList.add('hidden');
    (msg.cards || []).forEach((card, i) => bxAddCard(card, i, (msg.cards || []).length));
  }
  if (!msg.running && !msg.finished && !(msg.cards || []).length) {
    bxShowStandby();
  }
}

// ---------------- 卡片 ----------------
function bxSetupCanvas(canvas) {
  if (!canvas) return;
  canvas.width = 720;
  canvas.height = 460;
}

function bxPaintPreview(canvas, task, opts) {
  if (!canvas) return;
  opts = opts || {};
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(2, 0, 0, 2, 0, 0);
  const W = 360;
  const H = 230;
  ctx.clearRect(0, 0, W, H);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  // 页面白底 / 顶部导航
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#f7f8fa';
  ctx.fillRect(0, 0, W, 22);
  ctx.fillStyle = '#e1251b';
  bxRoundPath(ctx, 12, 5, 26, 13, 2);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 9px "Microsoft YaHei"';
  ctx.fillText('JD', 17, 15);
  ctx.fillStyle = '#e8eaed';
  bxRoundPath(ctx, 48, 7, 156, 9, 4);
  ctx.fill();
  ctx.fillStyle = '#e1251b';
  bxRoundPath(ctx, 286, 5, 62, 12, 6);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.font = '8px "Microsoft YaHei"';
  ctx.fillText('立即购买', 302, 14);

  // 面包屑
  ctx.fillStyle = '#dfe3e8';
  ctx.fillRect(12, 29, 220, 4);

  // 左侧主图
  ctx.fillStyle = '#f4f6f8';
  bxRoundPath(ctx, 12, 42, 134, 122, 4);
  ctx.fill();
  ctx.strokeStyle = '#eceff3';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = '#e3e8ee';
  bxRoundPath(ctx, 38, 66, 82, 58, 3);
  ctx.fill();
  ctx.strokeStyle = '#f0f2f5';
  ctx.beginPath();
  ctx.moveTo(38, 124);
  ctx.lineTo(120, 66);
  ctx.moveTo(38, 96);
  ctx.lineTo(84, 66);
  ctx.stroke();
  ctx.fillStyle = '#b9c2cc';
  ctx.font = '10px "Microsoft YaHei"';
  ctx.textAlign = 'center';
  ctx.fillText('商品主图', 79, 143);
  ctx.textAlign = 'left';

  // 右侧标题
  ctx.fillStyle = '#e3e7ec';
  bxRoundPath(ctx, 158, 44, 188, 9, 3);
  ctx.fill();
  bxRoundPath(ctx, 158, 58, 146, 9, 3);
  ctx.fill();
  ctx.fillStyle = '#ffe9e6';
  bxRoundPath(ctx, 158, 74, 60, 13, 2);
  ctx.fill();
  ctx.fillStyle = '#e1251b';
  ctx.font = '8px "Microsoft YaHei"';
  ctx.fillText('限时优惠', 164, 84);

  // 价格区
  ctx.fillStyle = '#fff8f7';
  bxRoundPath(ctx, 158, 90, 190, 64, 5);
  ctx.fill();
  ctx.strokeStyle = '#ffe0dc';
  ctx.stroke();
  ctx.fillStyle = '#e1251b';
  ctx.font = '9px "Microsoft YaHei"';
  ctx.fillText('到手价', 166, 105);
  const price = opts.price != null && isFinite(Number(opts.price)) ? Number(opts.price) : null;
  if (price != null) {
    const ptxt = bxFmtNum(price);
    ctx.fillStyle = '#e1251b';
    ctx.font = 'bold 12px "Microsoft YaHei"';
    ctx.fillText('¥', 166, 131);
    ctx.font = 'bold ' + (ptxt.length > 8 ? 23 : 30) + 'px "Microsoft YaHei"';
    ctx.fillText(ptxt, 179, 132);
  } else {
    ctx.fillStyle = '#e1251b';
    ctx.font = 'bold 12px "Microsoft YaHei"';
    ctx.fillText('¥', 166, 131);
    ctx.fillStyle = '#f1b5b0';
    ctx.font = 'bold 20px "Microsoft YaHei"';
    ctx.fillText(opts.failed ? '——' : '待读取', 180, 131);
  }
  ctx.fillStyle = '#98a2ad';
  ctx.font = '9px "Microsoft YaHei"';
  ctx.fillText('电商平台价', 166, 147);
  ctx.fillStyle = '#c5ccd4';
  ctx.fillRect(204, 140, 50, 2);

  // 购买按钮
  ctx.fillStyle = '#ff9500';
  bxRoundPath(ctx, 158, 162, 88, 19, 3);
  ctx.fill();
  ctx.fillStyle = '#e1251b';
  bxRoundPath(ctx, 252, 162, 96, 19, 3);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.font = '10px "Microsoft YaHei"';
  ctx.fillText('加入购物车', 173, 175);
  ctx.fillText('立即购买', 276, 175);

  // 促销骨架
  ctx.fillStyle = '#edf0f3';
  ctx.fillRect(158, 192, 188, 4);
  ctx.fillRect(158, 201, 152, 4);

  // 推荐位
  ctx.fillStyle = '#f7f8fa';
  ctx.fillRect(0, 208, W, H - 208);
  ctx.fillStyle = '#e8ecf0';
  for (let i = 0; i < 5; i++) {
    bxRoundPath(ctx, 12 + i * 54, 215, 42, 10, 2);
    ctx.fill();
  }

  if (opts.failed) {
    ctx.fillStyle = 'rgba(9, 17, 29, 0.74)';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#ffb454';
    ctx.font = 'bold 15px "Microsoft YaHei"';
    ctx.textAlign = 'center';
    ctx.fillText('未读取到价格', W / 2, H / 2 - 4);
    ctx.fillStyle = '#f0c98d';
    ctx.font = '10px "Microsoft YaHei"';
    ctx.fillText('可能未登录 / 已下架 / 页面改版', W / 2, H / 2 + 16);
    ctx.textAlign = 'left';
  }
}

function bxRoundPath(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function bxFmtNum(n) {
  if (n == null || isNaN(n)) return '—';
  return Number(n).toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function bxFmtMoney(n) {
  return '¥' + bxFmtNum(n);
}

function bxAddCard(data, index, total) {
  if (!data || !data.id || bx.cards.has(data.id)) return;
  const el = document.createElement('div');
  el.className = 'bxCard';
  el.dataset.id = data.id;
  el.dataset.sku = data.sku || '';
  el.dataset.state = data.state || 'loading';
  el.style.animationDelay = Math.min(0.55, (index || 0) * 0.06) + 's';
  el.innerHTML =
    '<div class="bxChrome"><span class="bxDots"><i></i><i></i><i></i></span><span class="bxUrl"></span><span class="bxLive">LIVE</span></div>' +
    '<canvas class="bxShot"></canvas>' +
    '<div class="bxMeta"><span class="bxSku"></span><span class="bxPrice"></span><span class="bxState">打开中</span></div>';
  const canvas = el.querySelector('.bxShot');
  bxSetupCanvas(canvas);
  el._data = Object.assign({ sku: '', model: '', state: 'loading', price: null, reason: '' }, data);
  const urlEl = el.querySelector('.bxUrl');
  if (urlEl) urlEl.textContent = 'item.shop.example.com/' + (data.sku || '') + '.html';
  const skuEl = el.querySelector('.bxSku');
  if (skuEl) skuEl.textContent = data.sku || '';
  el.title = data.sku || '';
  cardsEl.appendChild(el);
  bx.cards.set(data.id, { el: el, data: el._data });
  bx.order.push(data.id);
  bxRenderCard(el, el._data);
  bxLayout();
  emptyEl.classList.add('hidden');
}

function bxUpdateCard(msg) {
  const entry = bx.cards.get(msg.id);
  if (!entry) return;
  entry.data.state = msg.state || entry.data.state;
  if (msg.price != null) entry.data.price = msg.price;
  if (msg.reason != null) entry.data.reason = msg.reason;
  bxRenderCard(entry.el, entry.data);
}

function bxRenderCard(el, data) {
  if (!el) return;
  el.dataset.state = data.state || 'loading';
  const stateEl = el.querySelector('.bxState');
  const priceEl = el.querySelector('.bxPrice');
  const canvas = el.querySelector('.bxShot');
  if (stateEl) stateEl.textContent = BX_STATE_TEXT[data.state] || '读取中';
  if (priceEl) priceEl.textContent = data.state === 'read' && data.price != null ? bxFmtMoney(data.price) : '';
  if (data.state === 'read') {
    bxPaintPreview(canvas, data, { price: data.price });
  } else if (data.state === 'fail') {
    bxPaintPreview(canvas, data, { failed: true });
    el.title = data.reason || data.sku || '';
    if (stateEl) stateEl.textContent = '失败';
  } else {
    bxPaintPreview(canvas, data, {});
  }
}

function bxClearCards(instant) {
  bx.cards.forEach((entry) => {
    try {
      if (instant) entry.el.remove();
      else {
        entry.el.classList.add('gone');
        setTimeout(() => entry.el.remove(), 220);
      }
    } catch (e) {
      // 忽略
    }
  });
  bx.cards.clear();
  bx.order = [];
}

// ---------------- 弧线布局 ----------------
function bxLayout() {
  const W = stageEl.clientWidth || 1440;
  const H = stageEl.clientHeight || 720;
  const ids = bx.order.filter((id) => bx.cards.has(id));
  const n = ids.length;
  if (!n) return;
  const gap = n <= 5 ? 30 : n <= 7 ? 20 : n >= 10 ? 8 : 12;
  let cardW = Math.floor((W - 120 - (n - 1) * gap) / n);
  cardW = Math.max(72, Math.min(310, cardW));
  const mini = cardW < 150;
  const metaH = mini ? 28 : 50;
  const cardH = Math.round(cardW * 0.639 + 26 + metaH);
  const step = cardW + gap;
  const cx = W / 2;
  const mid = (n - 1) / 2;
  const maxDepth = Math.max(0, H - cardH - 70);
  let depth = Math.min(140, Math.max(0, n - 1) * 26);
  depth = Math.min(depth, maxDepth);
  const baseY = Math.max(cardH / 2 + 24, H * 0.46 + 6);
  const maxRot = 7;
  ids.forEach((id, i) => {
    const entry = bx.cards.get(id);
    if (!entry) return;
    const el = entry.el;
    const offset = i - mid;
    const t = mid > 0 ? offset / mid : 0;
    el.style.left = (cx + offset * step).toFixed(1) + 'px';
    el.style.top = (baseY + depth * t * t).toFixed(1) + 'px';
    el.style.setProperty('--w', cardW + 'px');
    el.style.setProperty('--rot', (t * maxRot).toFixed(2) + 'deg');
    el.classList.toggle('bxMini', mini);
  });
}

// ---------------- 关闭批次：粉末 ----------------
function bxCloseBatch(msg) {
  const ids = Array.isArray(msg.ids) ? msg.ids : [];
  const shatter = msg.shatter !== false && bx.shatter;
  const stagger = Math.max(0, Number(msg.staggerMs) || 100);
  const entries = [];
  for (const id of ids) {
    const entry = bx.cards.get(id);
    if (!entry) continue;
    entries.push(entry);
    bx.cards.delete(id);
  }
  bx.order = bx.order.filter((id) => bx.cards.has(id));
  const order = Array.isArray(msg.order) ? msg.order : null;
  if (order) {
    // 按工作台给的顺序错开，风从左边扫到右边
    entries.sort((a, b) => order.indexOf(a.data.id) - order.indexOf(b.data.id));
  }
  entries.forEach((entry, i) => {
    const delay = i * stagger;
    if (!shatter) {
      setTimeout(() => {
        entry.el.classList.add('gone');
        setTimeout(() => entry.el.remove(), 200);
      }, delay);
      return;
    }
    setTimeout(() => bxShatterCard(entry.el), delay);
  });
}

function bxShatterCard(el) {
  if (!el || el.dataset.shattered === '1') return;
  el.dataset.shattered = '1';
  if (!bx.shatter) {
    el.remove();
    return;
  }
  const stageRect = stageEl.getBoundingClientRect();
  const rect = el.getBoundingClientRect();
  if (!rect.width || !rect.height) {
    el.remove();
    return;
  }
  bxResizeFx();
  const dpr = bx.dpr || 1;
  const comp = bxComposeCard(el, dpr);
  const iw = rect.width;
  const ih = rect.height;
  const baseX = rect.left - stageRect.left;
  const baseY = rect.top - stageRect.top;
  const ctx = comp.getContext('2d');
  let data = null;
  try {
    data = ctx.getImageData(0, 0, comp.width, comp.height).data;
  } catch (e) {
    data = null;
  }
  const fx = bx.fx;
  if (fx.length > 15000) fx.splice(0, fx.length - 15000);

  // 1) 细粉末：从卡片画布里按网格取样，跳过深色卡片底。
  //    只留下白色页面 / 红色价格 / 黄色按钮 / 绿色状态这些亮色像素，视觉上就是「页面化成粉末」。
  if (data) {
    const step = Math.max(4, Math.min(8, Math.round(Math.max(iw, ih) / 40)));
    for (let y = 0; y < ih; y += step) {
      for (let x = 0; x < iw; x += step) {
        const sx = Math.floor((x * comp.width) / iw);
        const sy = Math.floor((y * comp.height) / ih);
        const idx = (sy * comp.width + sx) * 4;
        const a = data[idx + 3];
        if (a < 24) continue;
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];
        const lum = r * 0.299 + g * 0.587 + b * 0.114;
        if (lum < 28) continue;
        fx.push({
          x: baseX + x + Math.random() * step,
          y: baseY + y + Math.random() * step,
          size: Math.max(0.9, step * (0.2 + Math.random() * 0.24)),
          color: 'rgb(' + r + ',' + g + ',' + b + ')',
          alpha: (a / 255) * (0.55 + Math.random() * 0.45),
          vx: 30 + Math.random() * 160,
          vy: -(8 + Math.random() * 95),
          wind: 0.8 + Math.random() * 1.3,
          life: 0,
          ttl: 1500 + Math.random() * 1100,
          delay: Math.random() * 150,
          streak: false
        });
      }
    }
    // 2) 极细扬尘：随机取像素，做出烟雾感
    for (let i = 0; i < 190; i++) {
      const sx = Math.floor(Math.random() * comp.width);
      const sy = Math.floor(Math.random() * comp.height);
      const idx = (sy * comp.width + sx) * 4;
      const a = data[idx + 3];
      if (a < 40) continue;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      if (r * 0.299 + g * 0.587 + b * 0.114 < 34) continue;
      fx.push({
        x: baseX + (sx / comp.width) * iw,
        y: baseY + (sy / comp.height) * ih,
        size: 0.7 + Math.random() * 1.3,
        color: 'rgb(' + r + ',' + g + ',' + b + ')',
        alpha: 0.35 + Math.random() * 0.35,
        vx: 60 + Math.random() * 240,
        vy: -(10 + Math.random() * 90),
        wind: 1 + Math.random() * 1.2,
        life: 0,
        ttl: 1350 + Math.random() * 1000,
        delay: Math.random() * 180,
        streak: false
      });
    }
    // 3) 深色卡片边框的少量灰屑，避免只有白色页面碎掉
    for (let i = 0; i < 55; i++) {
      fx.push({
        x: baseX + Math.random() * iw,
        y: baseY + Math.random() * ih,
        size: 1.2 + Math.random() * 2,
        color: 'rgb(36,66,92)',
        alpha: 0.35,
        vx: 40 + Math.random() * 120,
        vy: -(5 + Math.random() * 60),
        wind: 0.7 + Math.random() * 0.8,
        life: 0,
        ttl: 1200 + Math.random() * 800,
        delay: Math.random() * 160,
        streak: false
      });
    }
  } else {
    // 取样失败也至少飞出一把灰
    for (let i = 0; i < 700; i++) {
      fx.push({
        x: baseX + Math.random() * iw,
        y: baseY + Math.random() * ih,
        size: 1 + Math.random() * 3,
        color: i % 5 === 0 ? 'rgb(225,37,27)' : 'rgb(230,240,250)',
        alpha: 0.8,
        vx: 60 + Math.random() * 240,
        vy: -(10 + Math.random() * 120),
        wind: 0.9 + Math.random() * 1.2,
        life: 0,
        ttl: 1300 + Math.random() * 900,
        delay: Math.random() * 140,
        streak: false
      });
    }
  }

  // 4) 风痕：几道很淡的水平线，强化「被风吹散」的方向感
  for (let i = 0; i < 8; i++) {
    fx.push({
      streak: true,
      x: baseX - 20 + Math.random() * (iw + 40),
      y: baseY - 10 + Math.random() * (ih + 20),
      len: 40 + Math.random() * 90,
      alpha: 0.08 + Math.random() * 0.10,
      vx: 520 + Math.random() * 700,
      vy: -20 + Math.random() * 45,
      life: 0,
      ttl: 380 + Math.random() * 280,
      delay: Math.random() * 130
    });
  }

  el.classList.add('gone');
  setTimeout(() => el.remove(), 120);
  bxRunFx();
}

// 把 DOM 卡片按相同布局重绘到离屏画布，供像素取样
function bxComposeCard(el, dpr) {
  const rect = el.getBoundingClientRect();
  const iw = Math.max(2, Math.round(rect.width));
  const ih = Math.max(2, Math.round(rect.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(iw * dpr);
  canvas.height = Math.round(ih * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  ctx.scale(dpr, dpr);
  const g = ctx.createLinearGradient(0, 0, 0, ih);
  g.addColorStop(0, '#0d1c2e');
  g.addColorStop(1, '#08131f');
  ctx.fillStyle = g;
  bxRoundPath(ctx, 0, 0, iw, ih, 12);
  ctx.fill();

  // 顶栏
  ctx.fillStyle = '#0e1d30';
  ctx.fillRect(0, 0, iw, 26);
  const dots = ['#ff6b6b', '#ffd166', '#4ade80'];
  for (let i = 0; i < dots.length; i++) {
    ctx.beginPath();
    ctx.arc(12 + i * 9, 13, 2.8, 0, Math.PI * 2);
    ctx.fillStyle = dots[i];
    ctx.fill();
  }
  const urlEl = el.querySelector('.bxUrl');
  if (urlEl) {
    ctx.fillStyle = '#6f92aa';
    ctx.font = '9px Consolas, monospace';
    ctx.fillText(urlEl.textContent || '', 44, 16);
  }

  // 页面预览
  const shot = el.querySelector('.bxShot');
  if (shot) {
    const sh = iw * (shot.height / shot.width);
    ctx.drawImage(shot, 0, 26, iw, sh);
  }

  // 底栏
  const mini = el.classList.contains('bxMini');
  const metaH = mini ? 28 : 50;
  ctx.fillStyle = '#0a1725';
  ctx.fillRect(0, ih - metaH, iw, metaH);
  const skuEl = el.querySelector('.bxSku');
  if (skuEl) {
    ctx.fillStyle = '#dcf7ff';
    ctx.font = 'bold 11px Consolas, monospace';
    ctx.fillText(skuEl.textContent || '', 10, ih - metaH + 17);
  }
  const priceEl = el.querySelector('.bxPrice');
  if (!mini && priceEl && priceEl.textContent) {
    ctx.fillStyle = '#6cf5bd';
    ctx.font = 'bold 11px "Microsoft YaHei"';
    ctx.textAlign = 'right';
    ctx.fillText(priceEl.textContent, iw - 10, ih - metaH + 17);
    ctx.textAlign = 'left';
  }
  const stateEl = el.querySelector('.bxState');
  if (!mini && stateEl && stateEl.textContent && el.dataset.state !== 'read') {
    ctx.fillStyle = '#9fc6dd';
    ctx.font = '9px "Microsoft YaHei"';
    ctx.textAlign = 'right';
    ctx.fillText(stateEl.textContent, iw - 10, ih - 9);
    ctx.textAlign = 'left';
  }
  return canvas;
}

// ---------------- 粒子引擎 ----------------
function bxResizeFx() {
  const w = stageEl.clientWidth || 0;
  const h = stageEl.clientHeight || 0;
  if (!w || !h) return;
  const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  if (bx.fxW === w && bx.fxH === h && bx.dpr === dpr && fxEl.width) return;
  bx.fxW = w;
  bx.fxH = h;
  bx.dpr = dpr;
  fxEl.width = Math.round(w * dpr);
  fxEl.height = Math.round(h * dpr);
  const ctx = fxEl.getContext('2d');
  if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function bxClearFx() {
  if (bx.raf) {
    cancelAnimationFrame(bx.raf);
    bx.raf = 0;
  }
  bx.fx = [];
  const ctx = fxEl.getContext('2d');
  if (ctx) ctx.clearRect(0, 0, bx.fxW || 0, bx.fxH || 0);
}

function bxRunFx() {
  if (bx.raf) return;
  const ctx = fxEl.getContext('2d');
  if (!ctx) return;
  let last = performance.now();
  const step = (now) => {
    const dt = Math.min(50, Math.max(1, now - last)) / 1000;
    last = now;
    ctx.clearRect(0, 0, bx.fxW || 0, bx.fxH || 0);
    const list = bx.fx;
    for (let i = list.length - 1; i >= 0; i--) {
      const p = list[i];
      if (p.delay > 0) {
        p.delay -= dt * 1000;
        continue;
      }
      p.life += dt * 1000;
      const k = p.life / p.ttl;
      if (k >= 1) {
        list.splice(i, 1);
        continue;
      }
      if (p.streak) {
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        const a = p.alpha * (1 - k);
        ctx.strokeStyle = 'rgba(150, 235, 255,' + a.toFixed(3) + ')';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x + p.len, p.y - 1.5);
        ctx.stroke();
        continue;
      }
      // 细腻的风力：向右加速 + 轻微上浮 + 湍流
      const wind = 900 * p.wind + Math.sin(p.life / 200 + p.x * 0.013) * 90;
      p.vx += wind * dt;
      p.vy += 24 * dt;
      p.vx *= 1 - 1.8 * dt;
      p.vy *= 1 - 0.8 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const fade = k < 0.38 ? 1 : Math.max(0, 1 - (k - 0.38) / 0.62);
      ctx.globalAlpha = p.alpha * fade;
      ctx.fillStyle = p.color;
      const size = p.size * (1 - Math.min(0.45, k * 0.3));
      ctx.fillRect(p.x, p.y, size, size);
      ctx.globalAlpha = 1;
    }
    if (list.length) {
      bx.raf = requestAnimationFrame(step);
    } else {
      bx.raf = 0;
      ctx.clearRect(0, 0, bx.fxW || 0, bx.fxH || 0);
    }
  };
  bx.raf = requestAnimationFrame(step);
}

// ---------------- 结束 / 汇总 ----------------
function bxFinish(msg) {
  bx.running = false;
  bx.finished = true;
  const stats = Object.assign({}, bx.lastStats || {}, msg.stats || {});
  bxSetKpis(stats);
  if (!msg.stopped && stats.batchSize) {
    kRead.textContent = stats.batchSize + ' / ' + stats.batchSize;
  } else {
    kRead.textContent = '—';
  }
  bxSetPhase(msg.stopped ? '已停止' : '完成', msg.stopped ? 'warn' : 'ok');
  // 让最后一轮粉末先飞一会儿，再盖汇总卡片
  bxCancelSummary();
  bx.summaryTimer = setTimeout(() => {
    bxShowSummary(msg.stats || {});
  }, 1500);
}

function bxShowSummary(stats) {
  stats = stats || {};
  document.getElementById('bxSummaryTitle').textContent = stats.stopped ? '本轮已停止' : '本轮已完成';
  document.getElementById('bxSumDone').textContent = String(stats.done || 0);
  document.getElementById('bxSumOk').textContent = String(stats.ok || 0);
  document.getElementById('bxSumFail').textContent = String(stats.fail || 0);
  document.getElementById('bxSumBatch').textContent = String(stats.batchCount || 0);
  document.getElementById('bxSummaryHint').textContent = stats.stopped
    ? '页面已全部关闭，已采到的结果均已写入本机存储。'
    : '所有页面已关闭、结果已批量写入本机存储。回到工作台再点一次「⚡ 矩阵速采」开下一轮。';
  summaryEl.classList.remove('hidden');
  emptyEl.classList.add('hidden');
}

function bxCancelSummary() {
  if (bx.summaryTimer) {
    clearTimeout(bx.summaryTimer);
    bx.summaryTimer = null;
  }
}

function bxShowStandby() {
  bxCancelSummary();
  summaryEl.classList.add('hidden');
  emptyEl.classList.remove('hidden');
  emptyEl.querySelector('b').textContent = '矩阵速采待命';
  emptyEl.querySelector('span').textContent =
    '在工作台点「⚡ 矩阵速采」后，商品页会在这个窗口里成排打开：批量读取 → 一次写入 → 整排碎成粉末 → 下一批。';
  bxSetPhase('待命', 'idle');
}

function bxGoOffline(reason) {
  if (bx.offline) return;
  bx.offline = true;
  offlineEl.querySelector('b').textContent = reason || '工作台已断开';
  offlineEl.classList.remove('hidden');
  bxSetPhase('工作台断开', 'warn');
  // 工作台刷新 / 重开后，持续打招呼，等它回来重新同步
  if (!bx.reconnectTimer) {
    bx.reconnectTimer = setInterval(() => {
      bxHello();
    }, 2500);
  }
}

// 心跳看门狗：工作台每 4 秒发一次 heartbeat；16 秒没消息就提示断开
setInterval(() => {
  if (bx.offline) return;
  if (Date.now() - bx.lastMsgAt > 16000) {
    bxGoOffline('工作台已断开');
  }
}, 4000);

// ---------------- 窗口交互 ----------------
document.getElementById('bxClose').addEventListener('click', () => {
  try {
    window.close();
  } catch (e) {
    // 忽略
  }
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') {
    try {
      window.close();
    } catch (e) {
      // 忽略
    }
  }
});

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    bxResizeFx();
    bxLayout();
  }, 120);
});

bxResizeFx();
bxLayout();
