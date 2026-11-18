// Tabbit probe: check JD login state and item page price candidates
const home = await page.goto("https://home.shop.example.com", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3500);
const info = await page.evaluate(() => {
  const text = (document.body ? document.body.innerText : "").slice(0, 1200);
  const cookies = (document.cookie || "").split(";").map(s => s.trim().split("=")[0]).filter(Boolean);
  const m = text.match(/(?:你好|您好)[，,\s]*([^\n，,]{1,24})/);
  const plusHints = [];
  document.querySelectorAll('[class*="plus" i],[class*="vip" i],a[href*="plus.shop.example.com"]').forEach(el => {
    if (plusHints.length >= 5) return;
    plusHints.push({ tag: el.tagName, cls: (typeof el.className === "string" ? el.className : "").slice(0, 60), text: (el.textContent || "").trim().slice(0, 30) });
  });
  return { url: location.href, title: document.title, nickname: m ? m[1] : "", textHead: text.slice(0, 700), cookies: cookies, plusHints: plusHints };
});

const itemUrl = "https://item.shop.example.com/100230282311.html";
await page.goto(itemUrl, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(5000);
const item = await page.evaluate(() => {
  const text = (document.body ? document.body.innerText : "").slice(0, 800);
  const cands = [];
  const seen = new Set();
  document.querySelectorAll("span,strong,em,i,b,div,p").forEach(el => {
    if (el.children.length > 1) return;
    const t = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (!t || t.length > 50) return;
    const m = t.match(/[¥￥]\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/);
    if (!m) return;
    let label = "";
    let cur = el.parentElement;
    for (let k = 0; k < 3 && cur; k++) { const ct = (cur.textContent || "").replace(/\s+/g, " ").trim(); if (ct && ct.length <= 80) label = ct; cur = cur.parentElement; }
    const key = m[1] + "|" + label.slice(0, 40);
    if (seen.has(key)) return;
    seen.add(key);
    cands.push({ price: m[1], cls: (typeof el.className === "string" ? el.className : "").slice(0, 80), label: label.slice(0, 80) });
  });
  return { url: location.href, title: document.title, textHead: text.slice(0, 500), priceCandidates: cands.slice(0, 20) };
});

return { home: info, item: item };
