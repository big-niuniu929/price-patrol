// 电商平台价格巡检工作台 · background
// 只负责：点击扩展图标时打开/复用工作台页面。
const APP_URL = chrome.runtime.getURL('app.html');

async function openApp() {
  try {
    const tabs = await chrome.tabs.query({ url: APP_URL + '*' });
    if (tabs && tabs.length) {
      const tab = tabs[0];
      await chrome.tabs.update(tab.id, { active: true });
      if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
      return;
    }
    await chrome.tabs.create({ url: APP_URL });
  } catch (e) {
    try {
      await chrome.tabs.create({ url: APP_URL });
    } catch (e2) {
      // 忽略
    }
  }
}

chrome.action.onClicked.addListener(() => {
  openApp();
});

chrome.runtime.onInstalled.addListener((details) => {
  if (details && details.reason === 'install') openApp();
});
