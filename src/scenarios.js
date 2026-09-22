import { extractLinks, extractKeyFromUrl } from './extractor.js';

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
      details.push(`Store link ${store} has key ${key}, expected ${expectedKey}`);
    }
    lastActual = key;
  }

  if (allMatch) {
    return { status: 'PASS', details: 'All store links contain the correct key', actualKey: expectedKey };
  } else {
    return { status: 'FAIL_LOST', details: details.join('; '), actualKey: lastActual };
  }
}

// S1: Start at /?r=K, navigate to P, check store links
export async function runS1(browser, rootUrl, targetUrl, key) {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(`${rootUrl}?r=${key}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(1000);
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(1000);
    const res = await evaluateStoreLinks(page, key);
    return res;
  } catch (err) {
    return { status: 'INCONCLUSIVE', details: err.message, actualKey: null };
  } finally {
    await context.close();
  }
}

// S2: Direct visit P?r=K
export async function runS2(browser, targetUrl, key) {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(`${targetUrl}?r=${key}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(1000);
    return await evaluateStoreLinks(page, key);
  } catch (err) {
    return { status: 'INCONCLUSIVE', details: err.message, actualKey: null };
  } finally {
    await context.close();
  }
}

// S3: Direct visit P?r=K, then reload
export async function runS3(browser, targetUrl, key) {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(`${targetUrl}?r=${key}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(1000);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
    return await evaluateStoreLinks(page, key);
  } catch (err) {
    return { status: 'INCONCLUSIVE', details: err.message, actualKey: null };
  } finally {
    await context.close();
  }
}

// S5: Replace K1 with K2
export async function runS5(browser, targetUrl, key1, key2) {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(`${targetUrl}?r=${key1}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(1000);
    await page.goto(`${targetUrl}?r=${key2}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(1000);
    const res = await evaluateStoreLinks(page, key2);
    if (res.status === 'FAIL_LOST' && res.actualKey === key1) {
      res.status = 'FAIL_STALE'; // Key didn't update
      res.details = 'Old key is still present after replacement';
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

// S6: Control without key (should have no key)
export async function runS6(browser, targetUrl) {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(1000);
    const res = await evaluateStoreLinks(page, null);
    if (res.status === 'FAIL_LOST') {
      res.status = 'FAIL_ALTERED';
      res.details = 'Expected no key, but found a key in store link';
    }
    return res;
  } catch (err) {
    return { status: 'INCONCLUSIVE', details: err.message, actualKey: null };
  } finally {
    await context.close();
  }
}

// S7: Key with special chars
export async function runS7(browser, targetUrl) {
  const specialKey = 'T_E-S.T~K';
  return await runS2(browser, targetUrl, specialKey);
}
