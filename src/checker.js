import { chromium, devices } from 'playwright';
import { startRun, finishRun, savePage, saveCheck } from './storage.js';
import { extractLinks, extractKeyFromUrl } from './extractor.js';
import { crawlSite } from './crawler.js';
import { runS1, runS2, runS3, runS5, runS6, runS7 } from './scenarios.js';

const DEVICE_PROFILES = [
  { 
    name: 'desktop', 
    desc: {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 }
    } 
  },
  { name: 'mobile_ios', desc: devices['iPhone 13'] },
  { name: 'mobile_android', desc: devices['Pixel 5'] },
];

// S4: Chain navigation — root → pageA → pageB
async function runS4(browser, rootUrl, pageA, pageB, key, deviceDesc) {
  const context = deviceDesc ? await browser.newContext({ ...deviceDesc }) : await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(`${rootUrl}?r=${key}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(1500);

    const pathA = new URL(pageA).pathname;
    const hrefA = await page.evaluate((path) => {
      for (const a of document.querySelectorAll('a')) {
        try { const u = new URL(a.href); if (u.pathname === path || u.pathname + '/' === path || u.pathname === path.replace(/\/$/, '')) return a.href; } catch {}
      }
      return null;
    }, pathA);

    await page.goto(hrefA || `${pageA}?r=${key}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(1500);

    const pathB = new URL(pageB).pathname;
    const hrefB = await page.evaluate((path) => {
      for (const a of document.querySelectorAll('a')) {
        try { const u = new URL(a.href); if (u.pathname === path || u.pathname + '/' === path || u.pathname === path.replace(/\/$/, '')) return a.href; } catch {}
      }
      return null;
    }, pathB);

    await page.goto(hrefB || `${pageB}?r=${key}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(1500);

    const { stores } = await extractLinks(page);
    if (stores.length === 0) return { status: 'NO_STORE_LINK', details: 'No store links after chain nav', actualKey: null };

    let allMatch = true, lastActual = null, details = [];
    for (const store of stores) {
      const k = extractKeyFromUrl(store);
      if (k !== key) { allMatch = false; details.push(`${store} → key="${k}"`); }
      lastActual = k;
    }
    return allMatch
      ? { status: 'PASS', details: `Key survived chain: root→${pathA}→${pathB}`, actualKey: key }
      : { status: 'FAIL_LOST', details: details.join('; '), actualKey: lastActual };
  } catch (err) {
    return { status: 'INCONCLUSIVE', details: err.message, actualKey: null };
  } finally {
    await context.close();
  }
}

// Concurrency limiter — run at most N promises at a time
async function runWithConcurrency(tasks, limit = 6) {
  const results = [];
  const executing = new Set();
  for (const task of tasks) {
    const p = task().then(r => { executing.delete(p); return r; });
    executing.add(p);
    results.push(p);
    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }
  return Promise.all(results);
}

async function main() {
  const rootUrl = 'https://trustee.io';
  const defaultKey = 'WoEs9XIVB6b';
  const maxPages = parseInt(process.env.MAX_PAGES || '15', 10);

  const runId = startRun();
  console.log(`--- Starting Run #${runId} ---`);

  const browser = await chromium.launch({ headless: true });

  try {
    // 1. Crawl to discover pages
    const pages = await crawlSite(browser, rootUrl, maxPages);
    const totalChecks = pages.length * 7 * DEVICE_PROFILES.length;
    console.log(`\nFound ${pages.length} pages × 7 scenarios × ${DEVICE_PROFILES.length} devices = ${totalChecks} checks`);
    console.log(`Running with parallelism (up to 6 concurrent)...\n`);

    // 2. For each page, run ALL device+scenario combos in parallel
    for (let i = 0; i < pages.length; i++) {
      const url = pages[i];
      const pageId = savePage(runId, url);
      const nextPage = pages[(i + 1) % pages.length];

      console.log(`Testing ${url}...`);

      const tasks = [];
      for (const device of DEVICE_PROFILES) {
        // S1
        tasks.push(() => runS1(browser, rootUrl, url, defaultKey, device.desc)
          .then(r => ({ id: `S1_${device.name}`, expected: defaultKey, ...r })));
        // S2
        tasks.push(() => runS2(browser, url, defaultKey, device.desc)
          .then(r => ({ id: `S2_${device.name}`, expected: defaultKey, ...r })));
        // S3
        tasks.push(() => runS3(browser, url, defaultKey, device.desc)
          .then(r => ({ id: `S3_${device.name}`, expected: defaultKey, ...r })));
        // S4
        tasks.push(() => runS4(browser, rootUrl, url, nextPage, defaultKey, device.desc)
          .then(r => ({ id: `S4_${device.name}`, expected: defaultKey, ...r })));
        // S5
        tasks.push(() => runS5(browser, url, 'OLD_KEY_ABC', defaultKey, device.desc)
          .then(r => ({ id: `S5_${device.name}`, expected: defaultKey, ...r })));
        // S6
        tasks.push(() => runS6(browser, url, device.desc)
          .then(r => ({ id: `S6_${device.name}`, expected: null, ...r })));
        // S7
        tasks.push(() => runS7(browser, url, device.desc)
          .then(r => ({ id: `S7_${device.name}`, expected: 'T_E-S.T~K', ...r })));
      }

      // Run all 21 checks for this page in parallel (up to 6 at a time)
      const results = await runWithConcurrency(tasks, 6);

      // Save results and log
      for (const r of results) {
        saveCheck(runId, pageId, r.id, r.expected, r.actualKey, r.status, r.details);
        const icon = r.status === 'PASS' ? '✓' : r.status === 'NO_STORE_LINK' ? '○' : '✗';
        console.log(`  ${icon} ${r.id}: ${r.status}`);
      }
    }

    finishRun(runId, 'COMPLETED');
    console.log(`\n--- Run #${runId} Completed ---`);
  } catch (err) {
    console.error(`Run failed:`, err);
    finishRun(runId, 'FAILED');
  } finally {
    await browser.close();
  }
}

main().catch(console.error);
