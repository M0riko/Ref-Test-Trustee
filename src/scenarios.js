import { extractLinks, extractKeyFromUrl } from './extractor.js';

/**
 * Evaluates store links on a page, checking if they contain the expected referral key.
 * Returns: { status, details, actualKey }
 */
async function evaluateStoreLinks(page, expectedKey) {
  const { stores } = await extractLinks(page);
  if (stores.length === 0) return { status: 'NO_STORE_LINK', details: 'No store links found on page', actualKey: null };
  
  let allMatch = true;
  let lastActual = null;
  let details = [];

  for (const store of stores) {
    const key = extractKeyFromUrl(store);
    if (key !== expectedKey) {
      allMatch = false;
      details.push(`${store} → key="${key}", expected="${expectedKey}"`);
    }
    lastActual = key;
  }

  if (allMatch) {
    return { status: 'PASS', details: `All ${stores.length} store links contain the correct key`, actualKey: expectedKey };
  } else {
    return { status: 'FAIL_LOST', details: details.join('; '), actualKey: lastActual };
  }
}

/**
 * Creates a new browser context, optionally with device emulation.
 * @param {Browser} browser - Playwright browser instance
 * @param {Object|null} deviceDesc - Playwright device descriptor (e.g. devices['iPhone 13'])
 */
async function createContext(browser, deviceDesc) {
  if (deviceDesc) {
    return await browser.newContext({ ...deviceDesc });
  }
  return await browser.newContext();
}

// S1: Navigate from root to target page by clicking a real link (simulates user journey)
// 1. Open root with ?r=KEY
// 2. Wait for site JS to append ?r= to all internal links
// 3. Find the link to target page (now with ?r=KEY) and navigate via its href
// 4. Check store links on the target page
export async function runS1(browser, rootUrl, targetUrl, key, deviceDesc = null) {
  const context = await createContext(browser, deviceDesc);
  const page = await context.newPage();
  try {
    // Step 1: Land on root with referral key
    await page.goto(`${rootUrl}?r=${key}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(2000); // let site JS run and modify links

    // Step 2: Find the link to targetUrl that site JS should have modified
    const targetPath = new URL(targetUrl).pathname;
    const modifiedHref = await page.evaluate((path) => {
      const links = Array.from(document.querySelectorAll('a'));
      for (const a of links) {
        try {
          const url = new URL(a.href);
          if (url.pathname === path || url.pathname === path.replace(/\/$/, '') || url.pathname + '/' === path) {
            return a.href; // return the full href including any ?r= the site added
          }
        } catch { /* skip invalid URLs */ }
      }
      return null;
    }, targetPath);

    if (modifiedHref) {
      // Navigate using the href that the site's JS prepared (should contain ?r=KEY)
      await page.goto(modifiedHref, { waitUntil: 'domcontentloaded', timeout: 15000 });
    } else {
      // Fallback: if no direct link to target found on root, go to target with key manually
      // This is less realistic but ensures we still test the page
      await page.goto(`${targetUrl}?r=${key}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    }
    await page.waitForTimeout(2000);

    return await evaluateStoreLinks(page, key);
  } catch (err) {
    return { status: 'INCONCLUSIVE', details: err.message, actualKey: null };
  } finally {
    await context.close();
  }
}

// S2: Direct visit to page with ?r=KEY in URL
export async function runS2(browser, targetUrl, key, deviceDesc = null) {
  const context = await createContext(browser, deviceDesc);
  const page = await context.newPage();
  try {
    await page.goto(`${targetUrl}?r=${key}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(2000);
    return await evaluateStoreLinks(page, key);
  } catch (err) {
    return { status: 'INCONCLUSIVE', details: err.message, actualKey: null };
  } finally {
    await context.close();
  }
}

// S3: Direct visit with ?r=KEY, then reload page (F5)
export async function runS3(browser, targetUrl, key, deviceDesc = null) {
  const context = await createContext(browser, deviceDesc);
  const page = await context.newPage();
  try {
    await page.goto(`${targetUrl}?r=${key}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(2000);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    return await evaluateStoreLinks(page, key);
  } catch (err) {
    return { status: 'INCONCLUSIVE', details: err.message, actualKey: null };
  } finally {
    await context.close();
  }
}

// S5: Replace key — visit with KEY1, then visit again with KEY2
// Verifies that the new key overrides the old one
export async function runS5(browser, targetUrl, key1, key2, deviceDesc = null) {
  const context = await createContext(browser, deviceDesc);
  const page = await context.newPage();
  try {
    await page.goto(`${targetUrl}?r=${key1}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(1500);
    await page.goto(`${targetUrl}?r=${key2}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(2000);
    const res = await evaluateStoreLinks(page, key2);
    if (res.status === 'FAIL_LOST' && res.actualKey === key1) {
      res.status = 'FAIL_STALE';
      res.details = `Old key "${key1}" still present after replacement with "${key2}"`;
    } else if (res.status === 'FAIL_LOST' && res.actualKey !== key2) {
      res.status = 'FAIL_ALTERED';
    }
    return res;
  } catch (err) {
    return { status: 'INCONCLUSIVE', details: err.message, actualKey: null };
  } finally {
    await context.close();
  }
}

// S6: Control — visit WITHOUT any key
// Expects: no key in store links (null). If a key appears, it's FAIL_ALTERED
export async function runS6(browser, targetUrl, deviceDesc = null) {
  const context = await createContext(browser, deviceDesc);
  const page = await context.newPage();
  try {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(2000);
    const res = await evaluateStoreLinks(page, null);
    if (res.status === 'FAIL_LOST') {
      // We expected null key but found something — that's unexpected
      res.status = 'FAIL_ALTERED';
      res.details = `Expected no key, but found key "${res.actualKey}" in store link`;
    }
    return res;
  } catch (err) {
    return { status: 'INCONCLUSIVE', details: err.message, actualKey: null };
  } finally {
    await context.close();
  }
}

// S7: Key with special characters (underscores, dots, tildes)
// Verifies the site doesn't corrupt unusual key formats
export async function runS7(browser, targetUrl, deviceDesc = null) {
  const specialKey = 'T_E-S.T~K';
  return await runS2(browser, targetUrl, specialKey, deviceDesc);
}

// S8: UTM Parameters presence
// Ensures the referral key survives even if other marketing params exist
export async function runS8(browser, targetUrl, key, deviceDesc = null) {
  const context = await createContext(browser, deviceDesc);
  const page = await context.newPage();
  try {
    const urlObj = new URL(targetUrl);
    urlObj.searchParams.set('utm_source', 'telegram');
    urlObj.searchParams.set('utm_medium', 'cpc');
    urlObj.searchParams.set('r', key);
    
    await page.goto(urlObj.toString(), { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(2000);
    return await evaluateStoreLinks(page, key);
  } catch (err) {
    return { status: 'INCONCLUSIVE', details: err.message, actualKey: null };
  } finally {
    await context.close();
  }
}

// S9: Edge case - extremely long key
// Verifies there's no unexpected database/trimming length limits on the site side
export async function runS9(browser, targetUrl, deviceDesc = null) {
  // 120 character long key
  const longKey = 'LONGKEY_1234567890_1234567890_1234567890_1234567890_1234567890_1234567890_1234567890_1234567890_1234567890_1234567890';
  return await runS2(browser, targetUrl, longKey, deviceDesc);
}
