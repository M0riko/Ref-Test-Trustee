const STORE_HOST_RE = /(apps\.apple\.com|itunes\.apple\.com|play\.google\.com|app\.link|onelink\.me|appsflyer\.com|branch\.io)/i;
const APK_RE = /\.apk(\?|$)/i;

export function isStoreUrl(href) {
  if (!href || typeof href !== 'string') return false;
  if (href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) return false;
  return STORE_HOST_RE.test(href) || APK_RE.test(href);
}

export function isInternalHost(hostname, rootDomain) {
  if (!hostname || !rootDomain) return false;
  const host = hostname.replace(/^www\./, '').toLowerCase();
  const root = rootDomain.replace(/^www\./, '').toLowerCase();
  return host === root || host.endsWith('.' + root);
}

export async function extractLinks(page, rootDomain = 'trustee.io') {
  return await page.evaluate(({ domain, storeReSource, apkReSource }) => {
    const storeRe = new RegExp(storeReSource, 'i');
    const apkRe = new RegExp(apkReSource, 'i');
    const isStore = (href) => href && (storeRe.test(href) || apkRe.test(href));

    const allAnchors = Array.from(document.querySelectorAll('a[href]'));
    const allLinks = allAnchors.map(a => a.href).filter(Boolean);

    const internal = [...new Set(allLinks.filter(href => {
      try {
        const url = new URL(href);
        const host = url.hostname.replace(/^www\./, '').toLowerCase();
        const root = domain.replace(/^www\./, '').toLowerCase();
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
        return host === root || host.endsWith('.' + root);
      } catch {
        return false;
      }
    }))];

    const stores = new Set(allLinks.filter(isStore));

    for (const el of document.querySelectorAll('[href], [src], [data-href], [data-url], [data-link]')) {
      for (const attr of ['href', 'src', 'data-href', 'data-url', 'data-link']) {
        const val = el.getAttribute(attr);
        if (!val) continue;
        try {
          const abs = new URL(val, location.href).toString();
          if (isStore(abs)) stores.add(abs);
        } catch {}
      }
    }

    const html = document.documentElement ? document.documentElement.innerHTML : '';
    const urlRe = /https?:\/\/[^\s"'<>]+/g;
    let m;
    while ((m = urlRe.exec(html)) !== null) {
      const cleaned = m[0].replace(/[),.;]+$/, '');
      if (isStore(cleaned)) stores.add(cleaned);
    }

    return { internal, stores: [...stores] };
  }, {
    domain: rootDomain,
    storeReSource: STORE_HOST_RE.source,
    apkReSource: APK_RE.source,
  });
}

/**
 * Referral key from a URL. Empty `r=` is treated as missing.
 */
export function extractKeyFromUrl(urlString) {
  try {
    const url = new URL(urlString);
    const direct = url.searchParams.get('r');
    if (direct !== null && direct !== '') return direct;
    if (url.hash) {
      const hash = url.hash.replace(/^#/, '');
      const qIndex = hash.indexOf('?');
      const query = qIndex >= 0 ? hash.slice(qIndex + 1) : hash;
      const hp = new URLSearchParams(query);
      const fromHash = hp.get('r');
      if (fromHash) return fromHash;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * True when the expected key appears as an exact query/hash parameter value.
 * Does not treat a raw substring match as success (avoids false PASS on short keys).
 */
export function urlHasExactKey(urlString, key) {
  if (!key || !urlString) return false;
  try {
    const url = new URL(urlString);
    for (const [, v] of url.searchParams.entries()) {
      if (v === key) return true;
    }
    if (url.hash) {
      const hash = url.hash.replace(/^#/, '');
      const qIndex = hash.indexOf('?');
      const query = qIndex >= 0 ? hash.slice(qIndex + 1) : hash;
      const hp = new URLSearchParams(query);
      for (const [, v] of hp.entries()) {
        if (v === key) return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

export function firstKeyInChain(urls) {
  for (const u of urls || []) {
    const k = extractKeyFromUrl(u);
    if (k) return k;
  }
  return null;
}
