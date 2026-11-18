// 电商平台市占率数据工作台 · background（MV3 Service Worker）
//
// 职责只有两件事：
//   1) 点击工具栏图标 → 打开/复用工作台页面 app.html；
//   2) 首次安装 → 自动打开一次工作台，方便用户看到「导入榜单」引导。
//
// 说明：所有路径都用 chrome.runtime.getURL 相对扩展根目录解析，不依赖扩展所在的绝对路径。
//      扩展目录移动后需要在 edge://extensions 重新「加载解压缩的扩展」，否则浏览器会报扩展失效。
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
    // tabs.query 的匹配可能因权限/版本差异失败，退化为直接新开一个工作台
    try {
      await chrome.tabs.create({ url: APP_URL });
    } catch (e2) {
      // 实在打不开就静默失败（用户可手动打开插件页）
    }
  }
}

chrome.action.onClicked.addListener(() => {
  openApp();
});

chrome.runtime.onInstalled.addListener((details) => {
  if (details && details.reason === 'install') openApp();
});
