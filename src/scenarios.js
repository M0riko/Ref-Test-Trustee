import { extractLinks, extractKeyFromUrl } from './extractor.js';
import https from 'https';
import http from 'http';

/**
 * Node-side fetch for HEAD requests to resolve redirects (like app.link, appsflyer, branch.io)
 * We don't want to use Playwright browser context for this to avoid noise and slow downs.
 */
async function resolveOneHop(url) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.request(url, { method: 'HEAD', timeout: 10000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(res.headers.location);
      } else {
        resolve(url);
      }
    });
    req.on('error', () => resolve(url));
    req.on('timeout', () => { req.destroy(); resolve(url); });
    req.end();
  });
}

export async function resolveRedirect(url, maxHops = 5) {
  let current = url;
  for (let i = 0; i < maxHops; i++) {
    const next = await resolveOneHop(current);
    if (!next || next === current) return current;
    current = next;
  }
  return current;
}

/**
 * Waits for store links up to 8s with rAF fallback, then extracts them.
 */
async function waitAndExtractStoreLinks(page, rootDomain) {
  try {
    await page.waitForSelector('a[href*="apps.apple.com"], a[href*="play.google.com"], a[href*="app.link"], a[href*="appsflyer"], a[href*="branch.io"]', { timeout: 8000 });
  } catch (err) {
    // Fallback: wait 2 frames to let JS settle if selector missed
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  }
  return await extractLinks(page, rootDomain);
}

/**
 * Evaluates store links on a page, checking if they contain the expected referral key.
 * Returns: { status, details, actualKey }
 */
async function evaluateStoreLinks(page, expectedKey, rootDomain) {
  const { stores } = await waitAndExtractStoreLinks(page, rootDomain);
  if (stores.length === 0) return { status: 'NO_STORE_LINK', details: 'No store links found on page', actualKey: null };
  
  let allMatch = true;
  let lastActual = null;
  let details = [];

  for (let store of stores) {
    let finalUrl = store;
    let note = '';
    // Resolve redirects for tracking links
    if (store.includes('app.link') || store.includes('appsflyer') || store.includes('branch.io')) {
      const resolved = await resolveRedirect(store);
      if (resolved !== store) {
        finalUrl = resolved;
        note = ` (resolved to ${finalUrl})`;
      } else {
        note = ` (HEAD resolve failed or no redirect)`;
      }
    }

    const key = extractKeyFromUrl(finalUrl);
    if (key !== expectedKey) {
      allMatch = false;
      details.push(`${store}${note} → key="${key}", expected="${expectedKey}"`);
    }
    lastActual = key;
  }

  if (allMatch) {
    return { status: 'PASS', details: `All ${stores.length} store links contain the correct key`, actualKey: expectedKey };
  } else {
    return { status: 'FAIL_LOST', details: details.join('; '), actualKey: lastActual };
  }
}

async function createContext(browser, deviceDesc) {
  if (deviceDesc) {
    return await browser.newContext({ ...deviceDesc });
  }
  return await browser.newContext();
}

async function captureScreenshot(page, path, status) {
  if (path && (status.startsWith('FAIL') || status === 'INCONCLUSIVE')) {
    try { await page.screenshot({ path, fullPage: true }); } catch {}
  }
}

// S1: Navigate from root to target page by clicking a real link
export async function runS1(browser, rootUrl, targetUrl, key, deviceDesc = null, screenshotPath = null) {
  const context = await createContext(browser, deviceDesc);
  const page = await context.newPage();
  let res = { status: 'INCONCLUSIVE', details: 'Unknown error', actualKey: null };
  try {
    const rootDomain = new URL(rootUrl).hostname;
    await page.goto(`${rootUrl}?r=${key}`, { waitUntil: 'domcontentloaded', timeout: process.env.SCENARIO_TIMEOUT_MS ? parseInt(process.env.SCENARIO_TIMEOUT_MS) : 15000 });
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    
    const targetPath = new URL(targetUrl).pathname;
    
    // Find a link that goes to targetPath
    const linkHref = await page.evaluate((path) => {
      const links = Array.from(document.querySelectorAll('a'));
      for (const a of links) {
        try {
          const u = new URL(a.href);
          if (u.pathname === path || u.pathname === path.replace(/\/$/, '') || u.pathname + '/' === path) {
            return a.getAttribute('href');
          }
        } catch {}
      }
      return null;
    }, targetPath);

    if (!linkHref) {
      return { status: 'NO_INTERNAL_LINK', details: `Could not find any link to ${targetPath} on root page`, actualKey: null };
    }

    // Real click and wait for navigation
    const navPromise = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: process.env.SCENARIO_TIMEOUT_MS ? parseInt(process.env.SCENARIO_TIMEOUT_MS) : 15000 }).catch(e => e);
    const popupPromise = context.waitForEvent('page', { timeout: process.env.SCENARIO_TIMEOUT_MS ? parseInt(process.env.SCENARIO_TIMEOUT_MS) : 15000 }).catch(() => null);
    
    await page.locator(`a[href="${linkHref}"]`).first().click();
    
    let newPage = page;
    const navRes = await navPromise;
    if (navRes instanceof Error) {
      // maybe it opened in a popup
      const popup = await popupPromise;
      if (popup) {
        newPage = popup;
        await newPage.waitForLoadState('domcontentloaded');
      } else {
        return { status: 'INCONCLUSIVE', details: 'Click did not result in navigation or new tab', actualKey: null };
      }
    }
    
    await newPage.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    
    res = await evaluateStoreLinks(newPage, key, rootDomain);
  } catch (err) {
    res = { status: 'INCONCLUSIVE', details: err.message, actualKey: null };
  } finally {
    await captureScreenshot(page, screenshotPath, res.status);
    await context.close();
  }
  return res;
}

// S2: Direct visit to page with ?r=KEY in URL
export async function runS2(browser, targetUrl, key, deviceDesc = null, screenshotPath = null) {
  const context = await createContext(browser, deviceDesc);
  const page = await context.newPage();
  let res = { status: 'INCONCLUSIVE', details: 'Unknown error', actualKey: null };
  try {
    const rootDomain = new URL(targetUrl).hostname;
    await page.goto(`${targetUrl}?r=${key}`, { waitUntil: 'domcontentloaded', timeout: process.env.SCENARIO_TIMEOUT_MS ? parseInt(process.env.SCENARIO_TIMEOUT_MS) : 15000 });
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    res = await evaluateStoreLinks(page, key, rootDomain);
  } catch (err) {
    res = { status: 'INCONCLUSIVE', details: err.message, actualKey: null };
  } finally {
    await captureScreenshot(page, screenshotPath, res.status);
    await context.close();
  }
  return res;
}

// S3: Direct visit with ?r=KEY, then reload page (F5)
export async function runS3(browser, targetUrl, key, deviceDesc = null, screenshotPath = null) {
  const context = await createContext(browser, deviceDesc);
  const page = await context.newPage();
  let res = { status: 'INCONCLUSIVE', details: 'Unknown error', actualKey: null };
  try {
    const rootDomain = new URL(targetUrl).hostname;
    await page.goto(`${targetUrl}?r=${key}`, { waitUntil: 'domcontentloaded', timeout: process.env.SCENARIO_TIMEOUT_MS ? parseInt(process.env.SCENARIO_TIMEOUT_MS) : 15000 });
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    res = await evaluateStoreLinks(page, key, rootDomain);
  } catch (err) {
    res = { status: 'INCONCLUSIVE', details: err.message, actualKey: null };
  } finally {
    await captureScreenshot(page, screenshotPath, res.status);
    await context.close();
  }
  return res;
}

// S4: Chain navigation
export async function runS4(browser, rootUrl, intermediateUrl, targetUrl, key, deviceDesc = null, screenshotPath = null) {
  const context = await createContext(browser, deviceDesc);
  const page = await context.newPage();
  let res = { status: 'INCONCLUSIVE', details: 'Unknown error', actualKey: null };
  try {
    const rootDomain = new URL(rootUrl).hostname;
    
    // Step 1
    await page.goto(`${rootUrl}?r=${key}`, { waitUntil: 'domcontentloaded', timeout: process.env.SCENARIO_TIMEOUT_MS ? parseInt(process.env.SCENARIO_TIMEOUT_MS) : 15000 });
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    
    // Find intermediate
    const interPath = new URL(intermediateUrl).pathname;
    const interHref = await page.evaluate((path) => {
      const links = Array.from(document.querySelectorAll('a'));
      for (const a of links) {
        try {
          const u = new URL(a.href);
          if (u.pathname === path || u.pathname === path.replace(/\/$/, '')) return a.getAttribute('href');
        } catch {}
      }
      return null;
    }, interPath);

    if (!interHref) return { status: 'STOP_CHAIN', details: `Step 1: No link to ${interPath}`, actualKey: null };

    let navPromise = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: process.env.SCENARIO_TIMEOUT_MS ? parseInt(process.env.SCENARIO_TIMEOUT_MS) : 15000 }).catch(() => {});
    await page.locator(`a[href="${interHref}"]`).first().click();
    await navPromise;
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

    // Find target
    const targetPath = new URL(targetUrl).pathname;
    const targetHref = await page.evaluate((path) => {
      const links = Array.from(document.querySelectorAll('a'));
      for (const a of links) {
        try {
          const u = new URL(a.href);
          if (u.pathname === path || u.pathname === path.replace(/\/$/, '')) return a.getAttribute('href');
        } catch {}
      }
      return null;
    }, targetPath);

    if (!targetHref) {
      res = { status: 'STOP_CHAIN', details: `Step 2: No link to ${targetPath}`, actualKey: null };
      return res;
    }

    navPromise = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: process.env.SCENARIO_TIMEOUT_MS ? parseInt(process.env.SCENARIO_TIMEOUT_MS) : 15000 }).catch(() => {});
    await page.locator(`a[href="${targetHref}"]`).first().click();
    await navPromise;
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

    res = await evaluateStoreLinks(page, key, rootDomain);
  } catch (err) {
    res = { status: 'INCONCLUSIVE', details: err.message, actualKey: null };
  } finally {
    await captureScreenshot(page, screenshotPath, res.status);
    await context.close();
  }
  return res;
}

// S5: Replace key
export async function runS5(browser, targetUrl, key1, key2, deviceDesc = null, screenshotPath = null) {
  const context = await createContext(browser, deviceDesc);
  const page = await context.newPage();
  let res = { status: 'INCONCLUSIVE', details: 'Unknown error', actualKey: null };
  try {
    const rootDomain = new URL(targetUrl).hostname;
    await page.goto(`${targetUrl}?r=${key1}`, { waitUntil: 'domcontentloaded', timeout: process.env.SCENARIO_TIMEOUT_MS ? parseInt(process.env.SCENARIO_TIMEOUT_MS) : 15000 });
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    await page.goto(`${targetUrl}?r=${key2}`, { waitUntil: 'domcontentloaded', timeout: process.env.SCENARIO_TIMEOUT_MS ? parseInt(process.env.SCENARIO_TIMEOUT_MS) : 15000 });
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    res = await evaluateStoreLinks(page, key2, rootDomain);
    if (res.status === 'FAIL_LOST' && res.actualKey === key1) {
      res.status = 'FAIL_STALE';
      res.details = `Old key "${key1}" still present after replacement with "${key2}"`;
    } else if (res.status === 'FAIL_LOST' && res.actualKey !== key2) {
      res.status = 'FAIL_ALTERED';
    }
  } catch (err) {
    res = { status: 'INCONCLUSIVE', details: err.message, actualKey: null };
  } finally {
    await captureScreenshot(page, screenshotPath, res.status);
    await context.close();
  }
  return res;
}

// S6: Control
export async function runS6(browser, targetUrl, deviceDesc = null, screenshotPath = null) {
  const context = await createContext(browser, deviceDesc);
  const page = await context.newPage();
  let res = { status: 'INCONCLUSIVE', details: 'Unknown error', actualKey: null };
  try {
    const rootDomain = new URL(targetUrl).hostname;
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: process.env.SCENARIO_TIMEOUT_MS ? parseInt(process.env.SCENARIO_TIMEOUT_MS) : 15000 });
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    res = await evaluateStoreLinks(page, null, rootDomain);
    if (res.status === 'FAIL_LOST') {
      res.status = 'FAIL_ALTERED';
      res.details = `Expected no key, but found key "${res.actualKey}" in store link`;
    }
  } catch (err) {
    res = { status: 'INCONCLUSIVE', details: err.message, actualKey: null };
  } finally {
    await captureScreenshot(page, screenshotPath, res.status);
    await context.close();
  }
  return res;
}

// S7: Key with special characters
export async function runS7(browser, targetUrl, deviceDesc = null, screenshotPath = null) {
  const specialKey = 'T_E-S.T~K';
  return await runS2(browser, targetUrl, specialKey, deviceDesc, screenshotPath);
}

// S8: UTM Parameters presence
export async function runS8(browser, targetUrl, key, deviceDesc = null, screenshotPath = null) {
  const context = await createContext(browser, deviceDesc);
  const page = await context.newPage();
  let res = { status: 'INCONCLUSIVE', details: 'Unknown error', actualKey: null };
  try {
    const rootDomain = new URL(targetUrl).hostname;
    const urlObj = new URL(targetUrl);
    urlObj.searchParams.set('utm_source', 'telegram');
    urlObj.searchParams.set('utm_medium', 'cpc');
    urlObj.searchParams.set('r', key);
    
    await page.goto(urlObj.toString(), { waitUntil: 'domcontentloaded', timeout: process.env.SCENARIO_TIMEOUT_MS ? parseInt(process.env.SCENARIO_TIMEOUT_MS) : 15000 });
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    res = await evaluateStoreLinks(page, key, rootDomain);
  } catch (err) {
    res = { status: 'INCONCLUSIVE', details: err.message, actualKey: null };
  } finally {
    await captureScreenshot(page, screenshotPath, res.status);
    await context.close();
  }
  return res;
}

// S9: Edge case - extremely long key
export async function runS9(browser, targetUrl, deviceDesc = null, screenshotPath = null) {
  const longKey = 'LONGKEY_1234567890_1234567890_1234567890_1234567890_1234567890_1234567890_1234567890_1234567890_1234567890_1234567890';
  return await runS2(browser, targetUrl, longKey, deviceDesc, screenshotPath);
}

// S10: Form interaction on Exchange page
export async function runS10(browser, targetUrl, key, deviceDesc = null, screenshotPath = null) {
  let res = { status: 'INCONCLUSIVE', details: '', actualKey: null };
  const context = await browser.newContext({ ...deviceDesc, ignoreHTTPSErrors: true });
  const page = await context.newPage();

  try {
    const startUrl = targetUrl + (targetUrl.includes('?') ? '&' : '?') + 'r=' + key;
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: process.env.SCENARIO_TIMEOUT_MS ? parseInt(process.env.SCENARIO_TIMEOUT_MS) : 15000 });
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

    // Try to find the exchange button by role and text (more robust than CSS classes)
    let formBtn = page.getByRole('button', { name: /buy|exchange|обміняти|купити/i }).first();
    
    // Fallback to broader search if getByRole doesn't find it
    if (await formBtn.count() === 0) {
      formBtn = page.locator('button, a').filter({ hasText: /buy|exchange|обміняти|купити/i }).first();
    }
    
    // If not found, skip (return NO_FORM since it's not applicable)
    if (await formBtn.count() === 0) {
      res = { status: 'NO_FORM', details: 'No exchange form found on this page (skipped)', actualKey: key };
      return res;
    }

    // Accept cookies if present to prevent it from blocking the click
    try {
      const cookieBtn = page.locator('button:has-text("Accept all")').first();
      if (await cookieBtn.isVisible({ timeout: 1000 })) {
        await cookieBtn.click();
      }
    } catch {}

    let navPromise = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: process.env.SCENARIO_TIMEOUT_MS ? parseInt(process.env.SCENARIO_TIMEOUT_MS) : 15000 }).catch(() => {});
    await formBtn.click();
    await navPromise;
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

    const rootDomain = new URL(startUrl).hostname;
    res = await evaluateStoreLinks(page, key, rootDomain);
    
    if (res.status.startsWith('FAIL') || res.status === 'INCONCLUSIVE') {
      res.expectedKey = key;
      await captureScreenshot(page, screenshotPath, res.status);
    }
  } catch (err) {
    res.details = err.message;
    await captureScreenshot(page, screenshotPath, res.status);
  } finally {
    await context.close();
  }
  return res;
}
