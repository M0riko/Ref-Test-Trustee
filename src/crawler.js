import { extractLinks } from './extractor.js';

export async function crawlSite(browser, startUrl, maxPages = 300, maxDepth = 10, delayMs = 500) {
  console.log(`Starting crawler from ${startUrl} (maxPages: ${maxPages}, maxDepth: ${maxDepth})`);
  const rootDomain = new URL(startUrl).hostname;
  
  const visited = new Set();
  const queue = [{ url: startUrl, depth: 0 }];
  const foundUrls = [];
  const failedUrls = [];
  const truncatedUrls = [];
  
  const context = await browser.newContext();
  const page = await context.newPage();

  while (queue.length > 0) {
    if (foundUrls.length >= maxPages) {
      for (const item of queue) {
        truncatedUrls.push({ url: item.url, reason: 'page_limit' });
      }
      break;
    }

    const current = queue.shift();
    const currentUrl = current.url;
    const depth = current.depth;
    
    if (depth > maxDepth) {
      truncatedUrls.push({ url: currentUrl, reason: 'depth_limit' });
      continue;
    }
    
    let normalUrl;
    try {
      const u = new URL(currentUrl);
      const IGNORED_EXTENSIONS = ['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.zip', '.svg', '.mp4', '.mp3', '.apk'];
      if (IGNORED_EXTENSIONS.some(ext => u.pathname.toLowerCase().endsWith(ext))) {
        continue;
      }
      u.hash = '';
      const params = new URLSearchParams(u.search);
      const sortedParams = Array.from(params.entries()).sort((a, b) => a[0].localeCompare(b[0]));
      u.search = new URLSearchParams(sortedParams).toString();

      let urlStr = u.toString();
      if (urlStr.endsWith('/') && u.pathname !== '/') {
        urlStr = urlStr.slice(0, -1);
      }
      normalUrl = urlStr;
    } catch {
      continue;
    }

    if (visited.has(normalUrl)) continue;
    visited.add(normalUrl);

    console.log(`Crawling: ${normalUrl} (Depth: ${depth})`);
    try {
      await page.goto(normalUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      await page.waitForSelector('a[href*="apps.apple.com"], a[href*="play.google.com"], a[href*="app.link"], a[href*="appsflyer"], a[href*="branch.io"]', { timeout: 3000 }).catch(() => {});
      
      let finalUrl = page.url();
      if (finalUrl !== normalUrl) {
        try {
          const finalU = new URL(finalUrl);
          finalU.hash = '';
          const finalParams = new URLSearchParams(finalU.search);
          const finalSortedParams = Array.from(finalParams.entries()).sort((a, b) => a[0].localeCompare(b[0]));
          finalU.search = new URLSearchParams(finalSortedParams).toString();
          let finalUrlStr = finalU.toString();
          if (finalUrlStr.endsWith('/') && finalU.pathname !== '/') {
            finalUrlStr = finalUrlStr.slice(0, -1);
          }
          if (finalUrlStr !== normalUrl) {
            visited.add(finalUrlStr);
            normalUrl = finalUrlStr;
          }
        } catch {}
      }

      foundUrls.push(normalUrl);
      
      const { internal } = await extractLinks(page, rootDomain);
      for (const link of internal) {
        queue.push({ url: link, depth: depth + 1 });
      }
    } catch (err) {
      console.log(`Failed to crawl ${normalUrl}: ${err.message}`);
      failedUrls.push({ url: normalUrl, reason: err.message });
    } finally {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  await context.close();
  return { foundUrls, failedUrls, truncatedUrls };
}
