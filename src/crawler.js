import { extractLinks, isInternalHost } from './extractor.js';

const IGNORED_EXTENSIONS = ['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.zip', '.svg', '.mp4', '.mp3', '.apk', '.webp', '.woff', '.woff2', '.css', '.js'];
const STRIP_PARAMS = [
  'r', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'fbclid', 'gclid', 'currencyCode', 'amount', 'from', 'to', 'currency', 'coin',
];

export function normalizePageUrl(raw) {
  const u = new URL(raw);
  if (IGNORED_EXTENSIONS.some(ext => u.pathname.toLowerCase().endsWith(ext))) return null;
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.hash = '';
  for (const p of STRIP_PARAMS) u.searchParams.delete(p);
  const sorted = Array.from(u.searchParams.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  u.search = new URLSearchParams(sorted).toString();
  let urlStr = u.toString();
  if (urlStr.endsWith('/') && u.pathname !== '/') urlStr = urlStr.slice(0, -1);
  return urlStr;
}

async function fetchSitemapSeeds(startUrl, rootDomain) {
  const origin = new URL(startUrl).origin;
  const seeds = [];
  const seenXml = new Set();

  async function walk(xmlUrl, depth = 0) {
    if (depth > 4 || seenXml.has(xmlUrl)) return;
    seenXml.add(xmlUrl);
    try {
      const res = await fetch(xmlUrl, { signal: AbortSignal.timeout(12000) });
      if (!res.ok) return;
      const text = await res.text();
      const locRe = /<loc>\s*([^<]+)\s*<\/loc>/gi;
      let m;
      while ((m = locRe.exec(text)) !== null) {
        const loc = m[1].trim();
        if (loc.endsWith('.xml')) {
          await walk(loc, depth + 1);
        } else {
          try {
            const host = new URL(loc).hostname;
            if (isInternalHost(host, rootDomain)) seeds.push(loc);
          } catch {}
        }
      }
    } catch {}
  }

  await walk(origin + '/sitemap_index.xml');
  if (seeds.length === 0) await walk(origin + '/sitemap.xml');
  return seeds;
}

export async function crawlSite(browser, startUrl, maxPages = 300, maxDepth = 10, delayMs = 500) {
  console.log(`Starting crawler from ${startUrl} (maxPages: ${maxPages}, maxDepth: ${maxDepth})`);
  const rootDomain = new URL(startUrl).hostname;

  const visited = new Set();
  const queue = [{ url: startUrl, depth: 0, via: 'seed' }];
  const foundUrls = [];
  const failedUrls = [];
  const truncatedUrls = [];
  const edges = [];

  const sitemapSeeds = await fetchSitemapSeeds(startUrl, rootDomain);
  console.log(`Sitemap seeds: ${sitemapSeeds.length}`);
  for (const s of sitemapSeeds) {
    queue.push({ url: s, depth: 0, via: 'sitemap' });
  }

  const context = await browser.newContext();
  const page = await context.newPage();

  while (queue.length > 0) {
    if (foundUrls.length >= maxPages) {
      for (const item of queue) {
        const n = (() => { try { return normalizePageUrl(item.url); } catch { return item.url; } })();
        if (n && !visited.has(n)) truncatedUrls.push({ url: n, reason: `page_limit (${maxPages})` });
      }
      break;
    }

    const current = queue.shift();
    const depth = current.depth;
    if (depth > maxDepth) {
      truncatedUrls.push({ url: current.url, reason: `depth_limit (${maxDepth})` });
      continue;
    }

    let normalUrl;
    try {
      normalUrl = normalizePageUrl(current.url);
    } catch {
      continue;
    }
    if (!normalUrl) continue;
    try {
      if (!isInternalHost(new URL(normalUrl).hostname, rootDomain)) continue;
    } catch {
      continue;
    }

    if (visited.has(normalUrl)) continue;
    visited.add(normalUrl);

    console.log(`Crawling: ${normalUrl} (Depth: ${depth}, via: ${current.via})`);
    try {
      await page.goto(normalUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

      let finalUrl = page.url();
      try {
        const finalNorm = normalizePageUrl(finalUrl);
        if (finalNorm && finalNorm !== normalUrl && isInternalHost(new URL(finalNorm).hostname, rootDomain)) {
          visited.add(finalNorm);
          normalUrl = finalNorm;
        }
      } catch {}

      foundUrls.push(normalUrl);

      const { internal } = await extractLinks(page, rootDomain);
      for (const link of internal) {
        try {
          const n = normalizePageUrl(link);
          if (!n) continue;
          edges.push({ from: normalUrl, to: n });
          queue.push({ url: n, depth: depth + 1, via: 'link' });
        } catch {}
      }
    } catch (err) {
      console.log(`Failed to crawl ${normalUrl}: ${err.message}`);
      failedUrls.push({ url: normalUrl, reason: err.message });
    } finally {
      if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
    }
  }

  await context.close();
  return {
    foundUrls,
    failedUrls,
    truncatedUrls,
    edges,
    sitemapCount: sitemapSeeds.length,
  };
}

export function findTwoHopChain(rootUrl, targetUrl, edges) {
  try {
    const root = normalizePageUrl(rootUrl);
    const target = normalizePageUrl(targetUrl);
    if (!root || !target || root === target) return null;
    const outgoing = new Map();
    for (const e of edges) {
      if (!outgoing.has(e.from)) outgoing.set(e.from, new Set());
      outgoing.get(e.from).add(e.to);
    }
    const fromRoot = outgoing.get(root) || new Set();
    for (const mid of fromRoot) {
      if (mid === target || mid === root) continue;
      const fromMid = outgoing.get(mid) || new Set();
      if (fromMid.has(target)) return { intermediate: mid, target };
    }
    return null;
  } catch {
    return null;
  }
}
