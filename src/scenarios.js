import { extractLinks, extractKeyFromUrl, urlHasExactKey, firstKeyInChain, isStoreUrl } from './extractor.js';
import { resolveRedirectChain } from './redirects.js';

function scenarioTimeout() {
  return process.env.SCENARIO_TIMEOUT_MS ? parseInt(process.env.SCENARIO_TIMEOUT_MS, 10) : 20000;
}

async function acceptCookies(page) {
  try {
    const btn = page.locator('button:has-text("Accept"), button:has-text("Accept all"), button:has-text("Погоджуюсь"), button:has-text("Agree")').first();
    if (await btn.isVisible({ timeout: 800 })) await btn.click({ timeout: 1000 });
  } catch {}
}

async function waitForPageSettle(page) {
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  try {
    await page.waitForSelector(
      'a[href*="apps.apple.com"], a[href*="play.google.com"], a[href*="app.link"], a[href*="onelink"], a[href*="appsflyer"], a[href*="branch.io"]',
      { timeout: 6000 }
    );
  } catch {
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  }
}

async function createContext(browser, deviceDesc) {
  const opts = { ignoreHTTPSErrors: true, storageState: undefined };
  if (deviceDesc) Object.assign(opts, deviceDesc);
  const context = await browser.newContext(opts);
  try { await context.clearCookies(); } catch {}

  // Block Branch.io API requests to prevent IP fingerprint lock on the testing server
  await context.route('**/*branch.io/v1/pageview*', route => route.abort());
  await context.route('**/*branch.io/v1/event*', route => route.abort());
  
  return context;
}

async function captureScreenshot(page, path, status) {
  if (!path || !status) return;
  if (!(status.startsWith('FAIL') || status === 'INCONCLUSIVE')) return;
  try { await page.screenshot({ path, fullPage: true }); } catch {}
}

function classify(actualKey, expectedKey, staleKey = null) {
  const actual = actualKey === '' ? null : actualKey;
  const expected = expectedKey === '' ? null : expectedKey;
  if (actual === expected) return 'PASS';
  if (expected == null && actual != null) return 'FAIL_ALTERED';
  if (staleKey && actual === staleKey) return 'FAIL_STALE';
  if (actual == null) return 'FAIL_LOST';
  return 'FAIL_ALTERED';
}

async function inspectStoreUrl(store, expectedKey) {
  const hops = [store];
  if (/app\.link|onelink|appsflyer|branch\.io/i.test(store)) {
    const { chain } = await resolveRedirectChain(store);
    for (const u of chain) {
      if (!hops.includes(u)) hops.push(u);
    }
  }

  let matched = false;
  if (expectedKey) {
    matched = hops.some(u => urlHasExactKey(u, expectedKey));
  } else {
    matched = hops.every(u => !extractKeyFromUrl(u));
  }

  const actualKey = expectedKey && matched ? expectedKey : firstKeyInChain(hops);
  return { store, hops, matched, actualKey };
}

/**
 * Read store hrefs as the site left them. Never writes `r=` onto those links.
 */
async function evaluateStoreLinks(page, expectedKey, rootDomain, staleKey = null) {
  const { stores } = await extractLinks(page, rootDomain);
  const extra = [];
  try {
    extra.push(...await page.evaluate(() => {
      return Array.from(document.querySelectorAll('a[href]')).map(a => a.href);
    }));
  } catch {}
  const allStores = [...new Set([...stores, ...extra.filter(isStoreUrl)])];

  if (allStores.length === 0) {
    return { status: 'NO_STORE_LINK', details: 'No App Store / Google Play / smart-link found on page', actualKey: null };
  }

  const inspected = [];
  for (const store of allStores) {
    inspected.push(await inspectStoreUrl(store, expectedKey));
  }

  const detailsParts = inspected.map(i => {
    const note = i.hops.length > 1 ? ` (chain: ${i.hops.join(' -> ')})` : '';
    return `${i.store}${note} → key="${i.actualKey}", expected="${expectedKey}"`;
  });

  const allMatch = inspected.every(i => i.matched);
  const lastActual = inspected.map(i => i.actualKey).find(Boolean) ?? null;

  if (allMatch) {
    return {
      status: 'PASS',
      details: `All ${inspected.length} store link(s) carry the expected key`,
      actualKey: expectedKey ?? lastActual,
    };
  }

  const status = classify(lastActual, expectedKey, staleKey);
  return { status, details: detailsParts.join('; '), actualKey: lastActual };
}

async function clickInternalPath(page, context, targetPath) {
  const targetHref = await page.evaluate((path) => {
    const want = path.replace(/\/$/, '') || '/';
    const links = Array.from(document.querySelectorAll('a[href]'));
    for (const a of links) {
      try {
        const u = new URL(a.href, location.href);
        const p = u.pathname.replace(/\/$/, '') || '/';
        if (p === want) {
          return a.href;
        }
      } catch {}
    }
    return null;
  }, targetPath);

  if (!targetHref) return { ok: false };

  // TASK 3: Direct goto() is functionally equivalent for trustee.io and bypasses hidden mobile menus
  await page.goto(targetHref, { waitUntil: 'domcontentloaded', timeout: scenarioTimeout() });
  return { ok: true, page };
}

async function gotoKey(page, url, key) {
  const u = new URL(url);
  if (key != null) u.searchParams.set('r', key);
  else u.searchParams.delete('r');
  await page.goto(u.toString(), { waitUntil: 'domcontentloaded', timeout: scenarioTimeout() });
  await waitForPageSettle(page);
  await acceptCookies(page);
}

function rootDomainOf(url) {
  return new URL(url).hostname;
}

export async function runS1(browser, rootUrl, targetUrl, key, deviceDesc = null, screenshotPath = null) {
  const context = await createContext(browser, deviceDesc);
  const page = await context.newPage();
  let res = { status: 'INCONCLUSIVE', details: 'Unknown error', actualKey: null };
  try {
    const targetPath = new URL(targetUrl).pathname;
    const rootPath = new URL(rootUrl).pathname;
    if ((targetPath.replace(/\/$/, '') || '/') === (rootPath.replace(/\/$/, '') || '/')) {
      res = { status: 'NO_INTERNAL_LINK', details: 'S1 skipped: target is the landing page', actualKey: null };
      return res;
    }
    await gotoKey(page, rootUrl, key);
    const clicked = await clickInternalPath(page, context, targetPath);
    if (!clicked.ok) {
      res = { status: 'NO_INTERNAL_LINK', details: `No on-page link from landing to ${targetPath}`, actualKey: null };
      return res;
    }
    await waitForPageSettle(clicked.page);
    res = await evaluateStoreLinks(clicked.page, key, rootDomainOf(rootUrl));
  } catch (err) {
    res = { status: 'INCONCLUSIVE', details: err.message, actualKey: null };
  } finally {
    await captureScreenshot(page, screenshotPath, res.status);
    await context.close();
  }
  return res;
}

export async function runS2(browser, targetUrl, key, deviceDesc = null, screenshotPath = null) {
  const context = await createContext(browser, deviceDesc);
  const page = await context.newPage();
  let res = { status: 'INCONCLUSIVE', details: 'Unknown error', actualKey: null };
  try {
    await gotoKey(page, targetUrl, key);
    res = await evaluateStoreLinks(page, key, rootDomainOf(targetUrl));
  } catch (err) {
    res = { status: 'INCONCLUSIVE', details: err.message, actualKey: null };
  } finally {
    await captureScreenshot(page, screenshotPath, res.status);
    await context.close();
  }
  return res;
}

export async function runS3(browser, targetUrl, key, deviceDesc = null, screenshotPath = null) {
  const context = await createContext(browser, deviceDesc);
  const page = await context.newPage();
  let res = { status: 'INCONCLUSIVE', details: 'Unknown error', actualKey: null };
  try {
    await gotoKey(page, targetUrl, key);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: scenarioTimeout() });
    await waitForPageSettle(page);
    res = await evaluateStoreLinks(page, key, rootDomainOf(targetUrl));
  } catch (err) {
    res = { status: 'INCONCLUSIVE', details: err.message, actualKey: null };
  } finally {
    await captureScreenshot(page, screenshotPath, res.status);
    await context.close();
  }
  return res;
}

export async function runS4(browser, rootUrl, intermediateUrl, targetUrl, key, deviceDesc = null, screenshotPath = null) {
  const context = await createContext(browser, deviceDesc);
  const page = await context.newPage();
  let res = { status: 'INCONCLUSIVE', details: 'Unknown error', actualKey: null };
  try {
    await gotoKey(page, rootUrl, key);
    const interPath = new URL(intermediateUrl).pathname;
    const step1 = await clickInternalPath(page, context, interPath);
    if (!step1.ok) {
      res = { status: 'STOP_CHAIN', details: `Step 1: no link to ${interPath}`, actualKey: null };
      return res;
    }
    let current = step1.page;
    await waitForPageSettle(current);

    const targetPath = new URL(targetUrl).pathname;
    const step2 = await clickInternalPath(current, context, targetPath);
    if (!step2.ok) {
      res = { status: 'STOP_CHAIN', details: `Step 2: no link to ${targetPath}`, actualKey: null };
      return res;
    }
    current = step2.page;
    await waitForPageSettle(current);
    res = await evaluateStoreLinks(current, key, rootDomainOf(rootUrl));
  } catch (err) {
    res = { status: 'INCONCLUSIVE', details: err.message, actualKey: null };
  } finally {
    await captureScreenshot(page, screenshotPath, res.status);
    await context.close();
  }
  return res;
}

export async function runS5(browser, targetUrl, key1, key2, deviceDesc = null, screenshotPath = null) {
  const context = await createContext(browser, deviceDesc);
  const page = await context.newPage();
  let res = { status: 'INCONCLUSIVE', details: 'Unknown error', actualKey: null };
  try {
    await gotoKey(page, targetUrl, key1);
    await gotoKey(page, targetUrl, key2);
    res = await evaluateStoreLinks(page, key2, rootDomainOf(targetUrl), key1);
    if (res.status === 'FAIL_LOST' && res.actualKey === key1) {
      res.status = 'FAIL_STALE';
      res.details = `Old key "${key1}" still present after replacement with "${key2}"`;
    }
  } catch (err) {
    res = { status: 'INCONCLUSIVE', details: err.message, actualKey: null };
  } finally {
    await captureScreenshot(page, screenshotPath, res.status);
    await context.close();
  }
  return res;
}

export async function runS6(browser, targetUrl, deviceDesc = null, screenshotPath = null) {
  const context = await createContext(browser, deviceDesc);
  const page = await context.newPage();
  let res = { status: 'INCONCLUSIVE', details: 'Unknown error', actualKey: null };
  try {
    await gotoKey(page, targetUrl, null);

    // TASK 1: Diagnostic logging for context leak
    const cookies = await context.cookies();
    const ls = await page.evaluate(() => JSON.stringify(window.localStorage));
    console.log(`[S6 DIAGNOSTIC] ${targetUrl} | Cookies: ${cookies.length}, LocalStorage: ${ls !== '{}' && ls !== '""' ? ls : 'Empty'}`);

    res = await evaluateStoreLinks(page, null, rootDomainOf(targetUrl));
    if (res.status === 'FAIL_LOST' || (res.status !== 'NO_STORE_LINK' && res.status !== 'PASS' && res.actualKey)) {
      if (res.status !== 'NO_STORE_LINK' && res.actualKey) {
        res.status = 'FAIL_ALTERED';
        res.details = `Expected no referral key, but store link has "${res.actualKey}"`;
      }
    }
  } catch (err) {
    res = { status: 'INCONCLUSIVE', details: err.message, actualKey: null };
  } finally {
    await captureScreenshot(page, screenshotPath, res.status);
    await context.close();
  }
  return res;
}


