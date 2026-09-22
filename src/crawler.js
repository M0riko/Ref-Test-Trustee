import { extractLinks } from './extractor.js';

/**
 * Crawls the domain starting from startUrl.
 * Returns { foundUrls: [...], failedUrls: [{url, reason}, ...] }.
 * Limits the number of pages to maxPages and depth to maxDepth.
 */
export async function crawlSite(browser, startUrl, maxPages = 300, maxDepth = 10, delayMs = 500) {
  console.log(`Starting crawler from ${startUrl} (maxPages: ${maxPages}, maxDepth: ${maxDepth})`);
  const visited = new Set();
  const queue = [{ url: startUrl, depth: 0 }];
  const foundUrls = [];
  const failedUrls = [];
  
  const context = await browser.newContext();
  const page = await context.newPage();

  while (queue.length > 0 && foundUrls.length < maxPages) {
    const current = queue.shift();
    const currentUrl = current.url;
    const depth = current.depth;
    
    if (depth > maxDepth) continue;
    
    // Normalize URL to avoid duplicates
    let normalUrl;
    try {
      const u = new URL(currentUrl);
      
      // Ignore non-HTML files
      const IGNORED_EXTENSIONS = ['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.zip', '.svg', '.mp4', '.mp3', '.apk'];
      if (IGNORED_EXTENSIONS.some(ext => u.pathname.toLowerCase().endsWith(ext))) {
        continue;
      }
      
      u.hash = ''; // As per user request, keep stripping hash
      
      // Sort query parameters to avoid ?a=1&b=2 and ?b=2&a=1 being duplicates
      const params = new URLSearchParams(u.search);
      const sortedParams = Array.from(params.entries()).sort((a, b) => a[0].localeCompare(b[0]));
      u.search = new URLSearchParams(sortedParams).toString();

      let urlStr = u.toString();
      // Remove trailing slash if there's a path (but keep it for root domain)
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
      
      // Wait for networkidle
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      // Wait specifically for store links to appear
      await page.waitForSelector('a[href*="apps.apple.com"], a[href*="play.google.com"], a[href*="app.link"]', { timeout: 3000 }).catch(() => {});
      
      // Handle redirect (Bug 6)
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
            console.log(`  -> Redirected to: ${finalUrlStr}`);
            visited.add(finalUrlStr);
            normalUrl = finalUrlStr;
          }
        } catch { /* ignore parsing errors on redirect url */ }
      }

      foundUrls.push(normalUrl);
      
      const { internal } = await extractLinks(page);
      for (const link of internal) {
        queue.push({ url: link, depth: depth + 1 });
      }
    } catch (err) {
      console.log(`Failed to crawl ${normalUrl}: ${err.message}`);
      failedUrls.push({ url: normalUrl, reason: err.message });
    } finally {
      // Rate limiting (Bug 5)
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  await context.close();
  return { foundUrls, failedUrls };
}
