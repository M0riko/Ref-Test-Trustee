import https from 'https';
import http from 'http';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function oneHop(url) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      resolve(url);
      return;
    }
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || undefined,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'X-Forwarded-For': `203.0.113.${Math.floor(Math.random() * 255)}`,
      },
      timeout: 10000,
    }, (res) => {
      res.resume();
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        try {
          resolve(new URL(res.headers.location, url).toString());
        } catch {
          resolve(url);
        }
      } else {
        resolve(url);
      }
    });
    req.on('error', () => resolve(url));
    req.on('timeout', () => {
      req.destroy();
      resolve(url);
    });
    req.end();
  });
}

export async function resolveRedirectChain(url, maxHops = 6) {
  const chain = [url];
  let current = url;
  for (let i = 0; i < maxHops; i++) {
    const next = await oneHop(current);
    if (!next || next === current) break;
    chain.push(next);
    current = next;
    if (/apps\.apple\.com|itunes\.apple\.com|play\.google\.com/i.test(current)) break;
  }
  return { final: current, chain };
}

export async function resolveRedirect(url, maxHops = 6) {
  const { final } = await resolveRedirectChain(url, maxHops);
  return final;
}
