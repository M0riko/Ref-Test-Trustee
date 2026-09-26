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

function enqueue(queue, queued, url, depth, via) {
  let normalUrl;
  try {
    normalUrl = normalizePageUrl(url);
  } catch {
    return null;
  }
  if (!normalUrl || queued.has(normalUrl)) return normalUrl;
  queued.add(normalUrl);
  queue.push({ url: normalUrl, depth, via });
  return normalUrl;
}

async function collectInternalLinks(page, fetchHtml, normalUrl, rootDomain) {
  if (page) {
    await page.goto(normalUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await new Promise(r => setTimeout(r, 500));
    const { internal } = await extractLinks(page, rootDomain);
    return internal;
  }

  const res = await fetchHtml(normalUrl, {
    signal: AbortSignal.timeout(5000),
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const found = [];
  const hrefRe = /href=["']([^"']+)["']/gi;
  let m;
  while ((m = hrefRe.exec(html)) !== null) {
    try {
      const u = new URL(m[1], normalUrl);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
      const uNorm = normalizePageUrl(u.href);
      if (uNorm && isInternalHost(new URL(uNorm).hostname, rootDomain)) found.push(uNorm);
    } catch {}
  }
  return found;
}

export async function crawlSite(browser, startUrl, maxPages = 300, maxDepth = 10, delayMs = 500) {
  console.log(`Starting browser discovery from ${startUrl} (maxDepth: ${maxDepth}, maxPages: ${maxPages})`);
  const rootDomain = new URL(startUrl).hostname;

  const visited = new Set();
  const queued = new Set();
  const queue = [];
  const allFoundUrls = [];
  const edges = [];
  const failedUrls = [];
  const truncatedUrls = [];

  enqueue(queue, queued, startUrl, 0, 'seed');

  const sitemapSeeds = await fetchSitemapSeeds(startUrl, rootDomain);
  console.log(`Sitemap seeds: ${sitemapSeeds.length}`);
  for (const s of sitemapSeeds) {
    try {
      if (isInternalHost(new URL(s).hostname, rootDomain)) enqueue(queue, queued, s, 0, 'sitemap');
    } catch {}
  }

  let page = null;
  try {
    page = await browser.newPage();
  } catch (e) {
    console.error('Failed to open browser page for crawling, falling back to HTTP:', e.message);
  }

  let queueIndex = 0;
  let hitPageLimit = false;

  try {
    while (queueIndex < queue.length) {
      const current = queue[queueIndex++];
      if (current.depth > maxDepth) {
        truncatedUrls.push({ url: current.url, reason: `depth ${current.depth} > maxDepth ${maxDepth}` });
        continue;
      }

      let normalUrl;
      try {
        normalUrl = normalizePageUrl(current.url);
        if (!normalUrl || !isInternalHost(new URL(normalUrl).hostname, rootDomain)) continue;
      } catch {
        continue;
      }

      if (visited.has(normalUrl)) continue;

      if (allFoundUrls.length >= maxPages) {
        hitPageLimit = true;
        truncatedUrls.push({ url: normalUrl, reason: `maxPages ${maxPages}` });
        continue;
      }

      visited.add(normalUrl);
      allFoundUrls.push(normalUrl);

      try {
        const links = await collectInternalLinks(page, fetch, normalUrl, rootDomain);
        for (const href of links) {
          try {
            if (!isInternalHost(new URL(href).hostname, rootDomain)) continue;
            const uNorm = normalizePageUrl(href);
            if (!uNorm) continue;
            edges.push({ from: normalUrl, to: uNorm });
            enqueue(queue, queued, uNorm, current.depth + 1, 'link');
          } catch {}
        }
      } catch (err) {
        failedUrls.push({ url: normalUrl, reason: err.message || String(err) });
      }

      if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
    }
  } finally {
    if (page) {
      try { await page.close(); } catch {}
    }
  }

  if (hitPageLimit) {
    console.log(`Reached maxPages=${maxPages}. Remaining queued URLs are recorded as truncated, not as passes.`);
  }

  console.log(`Discovery complete. Testing all ${allFoundUrls.length} discovered pages (no sampling). ${failedUrls.length} crawl errors, ${truncatedUrls.length} truncated.`);

  return {
    foundUrls: allFoundUrls,
    failedUrls,
    truncatedUrls,
    edges,
    sitemapCount: sitemapSeeds.length,
    discoveryTotal: allFoundUrls.length + truncatedUrls.length,
    categoriesCount: null,
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
