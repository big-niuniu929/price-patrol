// 价格监控平台 · background service worker（MV3）
//
// 职责只有两件事：
//   1) 点击工具栏图标 → 打开/复用平台页面 app.html（平台页里先选业务，再加载对应模块）；
//   2) 首次安装 → 自动打开一次平台页，让用户看到「选择业务」。
//
// 三个业务模块（价格巡检 / 市占率 / 竞品价格雷达）的页面文件都放在 modules/<业务>/ 下，
// 由平台页用 iframe 装载；本文件不参与模块内部逻辑，也不改写任何模块数据。

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
    // tabs.query 的匹配可能因权限/版本差异失败，退化为直接新开一个平台页
    try {
      await chrome.tabs.create({ url: APP_URL });
    } catch (e2) {
      // 实在打不开就静默失败（用户可手动打开扩展页）
    }
  }
}

chrome.action.onClicked.addListener(() => {
  openApp();
});

chrome.runtime.onInstalled.addListener((details) => {
  if (details && details.reason === 'install') openApp();
});
