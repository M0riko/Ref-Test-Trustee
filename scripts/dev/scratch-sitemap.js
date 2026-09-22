import fs from 'fs';

async function fetchSitemapUrls(url) {
  const urls = new Set();
  try {
    const res = await fetch(url);
    if (!res.ok) return urls;
    const text = await res.text();
    const locRegex = /<loc>(.*?)<\/loc>/g;
    let match;
    while ((match = locRegex.exec(text)) !== null) {
      const loc = match[1];
      if (loc.endsWith('.xml')) {
        const subUrls = await fetchSitemapUrls(loc);
        for (const u of subUrls) urls.add(u);
      } else {
        urls.add(loc);
      }
    }
  } catch (err) {}
  return urls;
}

async function runBfsDiagnostic(startUrl, maxPages = 150) {
  const visited = new Set();
  const queue = [{ url: startUrl }];
  const foundUrls = new Set();
  const BLOCK_PARAMS = ['currencyCode', 'amount', 'from', 'to', 'currency', 'coin'];

  while (queue.length > 0 && foundUrls.size < maxPages) {
    const current = queue.shift();
    let normalUrl;
    try {
      const u = new URL(current.url);
      if (['.pdf', '.png', '.jpg', '.zip'].some(ext => u.pathname.toLowerCase().endsWith(ext))) continue;
      u.hash = '';
      if (BLOCK_PARAMS.some(p => u.searchParams.has(p))) continue;
      u.search = '';
      let urlStr = u.toString();
      if (urlStr.endsWith('/') && u.pathname !== '/') urlStr = urlStr.slice(0, -1);
      normalUrl = urlStr;
    } catch { continue; }

    if (visited.has(normalUrl)) continue;
    visited.add(normalUrl);
    foundUrls.add(normalUrl);
    
    try {
      const res = await fetch(normalUrl);
      if (!res.ok) continue;
      const html = await res.text();
      const hrefRegex = /href=["'](\/.*?)["']/g;
      let match;
      while ((match = hrefRegex.exec(html)) !== null) {
        queue.push({ url: 'https://trustee.io' + match[1] });
      }
      const absoluteRegex = /href=["'](https:\/\/trustee\.io.*?)["']/g;
      while ((match = absoluteRegex.exec(html)) !== null) {
        queue.push({ url: match[1] });
      }
    } catch (err) {}
  }
  return foundUrls;
}

async function main() {
  const sitemapUrls = await fetchSitemapUrls('https://trustee.io/sitemap_index.xml');
  const sitemapNormalized = new Set();
  for (const url of sitemapUrls) {
    try {
      const u = new URL(url);
      u.search = ''; u.hash = '';
      let urlStr = u.toString();
      if (urlStr.endsWith('/') && u.pathname !== '/') urlStr = urlStr.slice(0, -1);
      sitemapNormalized.add(urlStr);
    } catch { }
  }
  
  const bfsUrls = await runBfsDiagnostic('https://trustee.io');
  const common = [...sitemapNormalized].filter(x => bfsUrls.has(x));
  const sitemapOnly = [...sitemapNormalized].filter(x => !bfsUrls.has(x));
  const bfsOnly = [...bfsUrls].filter(x => !sitemapNormalized.has(x));
  
  const stats = {
    sitemapTotal: sitemapNormalized.size,
    bfsTotal: bfsUrls.size,
    common: common.length,
    sitemapOnly: sitemapOnly.length,
    bfsOnly: bfsOnly.length,
    sampleBfsOnly: bfsOnly.slice(0, 5)
  };
  fs.writeFileSync('stats.json', JSON.stringify(stats, null, 2));
  console.log('Stats saved to stats.json');
}

main().catch(console.error);
