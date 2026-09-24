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
  console.log(`Starting Phase 1: Full HTTP Discovery from ${startUrl} (maxDepth: ${maxDepth})`);
  const rootDomain = new URL(startUrl).hostname;

  const visited = new Set();
  const queued = new Set();
  const queue = [{ url: startUrl, depth: 0, via: 'seed' }];
  queued.add(startUrl);
  const allFoundUrls = new Set();
  const edges = [];
  const sitemapSeeds = await fetchSitemapSeeds(startUrl, rootDomain);
  console.log(`Sitemap seeds: ${sitemapSeeds.length}`);
  for (const s of sitemapSeeds) {
    if (!queued.has(s)) {
      queue.push({ url: s, depth: 0, via: 'sitemap' });
      queued.add(s);
    }
  }

  let queueIndex = 0;
  // HTTP BFS
  while (queueIndex < queue.length) {
    const current = queue[queueIndex++];
    if (current.depth > maxDepth) continue;

    let normalUrl;
    try {
      normalUrl = normalizePageUrl(current.url);
      if (!normalUrl || !isInternalHost(new URL(normalUrl).hostname, rootDomain)) continue;
    } catch { continue; }

    if (visited.has(normalUrl)) continue;
    visited.add(normalUrl);
    allFoundUrls.add(normalUrl);

    // Safety limit to prevent hours of crawling on massive blogs
    if (allFoundUrls.size > 200) break;

    try {
      const res = await fetch(normalUrl, { 
        signal: AbortSignal.timeout(5000),
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36' }
      });
      if (!res.ok) continue;
      const html = await res.text();
      const hrefRe = /href=["']([^"']+)["']/gi;
      let m;
      while ((m = hrefRe.exec(html)) !== null) {
        try {
          const u = new URL(m[1], normalUrl);
          if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
          const uNorm = normalizePageUrl(u.href);
          if (uNorm && isInternalHost(new URL(uNorm).hostname, rootDomain)) {
            edges.push({ from: normalUrl, to: uNorm });
            if (!queued.has(uNorm)) {
              queue.push({ url: uNorm, depth: current.depth + 1, via: 'link' });
              queued.add(uNorm);
            }
          }
        } catch {}
      }
    } catch {}
    
    if (delayMs > 0 && delayMs < 100) await new Promise(r => setTimeout(r, delayMs));
  }

  console.log(`Phase 1 Complete. Found ${allFoundUrls.size} unique URLs and ${edges.length} edges.`);

  // Phase 2: Clustering and Sampling
  const categoryMap = new Map();
  for (const url of allFoundUrls) {
    try {
      const u = new URL(url);
      const firstSegment = u.pathname.split('/').filter(Boolean)[0] || '';
      const cat = firstSegment ? `/${firstSegment}` : '/';
      if (!categoryMap.has(cat)) categoryMap.set(cat, []);
      categoryMap.get(cat).push(url);
    } catch {}
  }

  console.log(`Phase 2: Grouping into ${categoryMap.size} categories.`);
  const sampledUrls = [];
  const MAX_PER_CAT = 3;
  
  for (const [cat, urls] of categoryMap.entries()) {
    // Sort by length to get shortest (main) and longest (deepest article)
    urls.sort((a, b) => a.length - b.length);
    const selected = [];
    if (urls.length > 0) selected.push(urls[0]); // Shortest
    if (urls.length > 1 && MAX_PER_CAT > 1) selected.push(urls[urls.length - 1]); // Longest
    if (urls.length > 2 && MAX_PER_CAT > 2) selected.push(urls[Math.floor(urls.length / 2)]); // Middle
    
    for (const s of selected) {
      if (!sampledUrls.includes(s)) sampledUrls.push(s);
    }
  }

  console.log(`Phase 2 Complete. Sampled ${sampledUrls.length} pages for heavy Playwright testing.`);

  return {
    foundUrls: sampledUrls,
    failedUrls: [],
    truncatedUrls: [],
    edges,
    sitemapCount: sitemapSeeds.length,
    discoveryTotal: allFoundUrls.size,
    categoriesCount: categoryMap.size
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
