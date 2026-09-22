import { extractLinks } from './extractor.js';

/**
 * Crawls the domain starting from startUrl and returns an array of unique URLs.
 * Limits the number of pages to maxPages.
 */
export async function crawlSite(browser, startUrl, maxPages = 5) {
  console.log(`Starting crawler from ${startUrl} (max ${maxPages} pages)`);
  const visited = new Set();
  const queue = [startUrl];
  const foundUrls = [];
  
  const context = await browser.newContext();
  const page = await context.newPage();

  while (queue.length > 0 && foundUrls.length < maxPages) {
    const currentUrl = queue.shift();
    
    // Normalize URL to avoid duplicates
    let normalUrl;
    try {
      const u = new URL(currentUrl);
      
      // Ignore non-HTML files
      const IGNORED_EXTENSIONS = ['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.zip', '.svg', '.mp4', '.mp3', '.apk'];
      if (IGNORED_EXTENSIONS.some(ext => u.pathname.toLowerCase().endsWith(ext))) {
        continue;
      }
      
      // Ignore specific domains/subdomains that shouldn't be tested
      if (u.hostname === 'travel.trusteeglobal.eu') {
        continue;
      }

      u.hash = '';
      
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

    console.log(`Crawling: ${normalUrl}`);
    try {
      await page.goto(normalUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      // Let scripts append keys if they do
      await page.waitForTimeout(1000);
      
      foundUrls.push(normalUrl);
      
      const { internal } = await extractLinks(page);
      for (const link of internal) {
        queue.push(link);
      }
    } catch (err) {
      console.log(`Failed to crawl ${normalUrl}: ${err.message}`);
    }
  }

  await context.close();
  return foundUrls;
}
