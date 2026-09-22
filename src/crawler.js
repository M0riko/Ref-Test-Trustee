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
    
    // Normalize URL to avoid duplicates (remove hashes, query params)
    let normalUrl;
    try {
      const u = new URL(currentUrl);
      u.hash = '';
      u.search = '';
      normalUrl = u.toString();
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
