// JD 取价诊断（临时工具）· 开关控制
// 默认关闭；点工具栏图标切换 ON/OFF。只有 ON 时，content.js 才会在电商平台商品页保存诊断 JSON。
const KEY = 'diagEnabled';

function renderBadge(enabled) {
  try {
    chrome.action.setBadgeText({ text: enabled ? 'ON' : '' });
    chrome.action.setBadgeBackgroundColor({ color: enabled ? '#16a34a' : '#6b7280' });
    chrome.action.setTitle({
      title: enabled ? 'JD取价诊断：已开启（点击关闭）' : 'JD取价诊断：已关闭（点击开启）',
    });
  } catch (e) { /* ignore */ }
}

async function syncBadge() {
  try {
    const s = await chrome.storage.local.get({ [KEY]: false });
    renderBadge(!!s[KEY]);
  } catch (e) { renderBadge(false); }
}

chrome.runtime.onInstalled.addListener(async () => {
  // 安装/更新后默认关闭，避免升级后继续自动下载
  try { await chrome.storage.local.set({ [KEY]: false }); } catch (e) { /* ignore */ }
  renderBadge(false);
});

chrome.runtime.onStartup.addListener(syncBadge);

chrome.action.onClicked.addListener(async () => {
  try {
    const s = await chrome.storage.local.get({ [KEY]: false });
    const next = !s[KEY];
    await chrome.storage.local.set({ [KEY]: next });
    renderBadge(next);
    // 提示：开启后需要刷新当前商品页才会开始采集
    try {
      await chrome.action.setTitle({
        title: next ? 'JD取价诊断：已开启（刷新商品页后采集；点击关闭）' : 'JD取价诊断：已关闭（点击开启）',
      });
    } catch (e) { /* ignore */ }
  } catch (e) { /* ignore */ }
});

syncBadge();
