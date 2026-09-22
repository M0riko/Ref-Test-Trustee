import 'dotenv/config';
import { chromium, devices } from 'playwright';
import { startRun, finishRun, savePage, saveCheck, incrementFailures, resetFailures } from './storage.js';
import { extractLinks, extractKeyFromUrl } from './extractor.js';
import { crawlSite } from './crawler.js';
import { runS1, runS2, runS3, runS5, runS6, runS7, runS8, runS9 } from './scenarios.js';
import { notifyStart, notifySuccess, notifyFailure } from './notifier.js';


const DEVICE_PROFILES = [
  {
    name: 'desktop',
    desc: {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 }
    }
  },
  {
    name: 'desktop_mac',
    desc: {
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
      viewport: { width: 1440, height: 900 }
    }
  },
  { name: 'mobile_ios', desc: devices['iPhone 13'] },
  { name: 'mobile_android', desc: devices['Pixel 5'] },
];

// ─── Healthchecks.io ping ────────────────────────────────────────────────────
// Set HEALTHCHECK_URL in .env or GitHub Action secrets to enable.
// Format: https://hc-ping.com/<uuid>
// On start → ping /start   (lets HC.io know a run started)
// On success → ping /       (confirms run completed successfully)
// On failure → ping /fail   (alerts if run crashed)
async function hcPing(suffix = '') {
  const base = process.env.HEALTHCHECK_URL;
  if (!base) return; // silently skip if not configured
  const url = base.replace(/\/$/, '') + suffix;
  try {
    // Use built-in fetch (Node 18+)
    await fetch(url, { method: 'POST', signal: AbortSignal.timeout(5000) });
  } catch { /* non-fatal — don't crash the monitor over a ping */ }
}

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
        try { const u = new URL(a.href); if (u.pathname === path || u.pathname + '/' === path || u.pathname === path.replace(/\/$/, '')) return a.href; } catch { }
      }
      return null;
    }, pathA);

    await page.goto(hrefA || `${pageA}?r=${key}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(1500);

    const pathB = new URL(pageB).pathname;
    const hrefB = await page.evaluate((path) => {
      for (const a of document.querySelectorAll('a')) {
        try { const u = new URL(a.href); if (u.pathname === path || u.pathname + '/' === path || u.pathname === path.replace(/\/$/, '')) return a.href; } catch { }
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
    if (executing.size >= limit) await Promise.race(executing);
  }
  return Promise.all(results);
}

async function main() {
  // Global watchdog timeout: 40 minutes (prevents the script from hanging forever)
  const watchdog = setTimeout(() => {
    console.error('🚨 Global timeout reached (40m). Force killing process to prevent zombie run.');
    process.exit(1);
  }, 40 * 60 * 1000);

  const rootUrl = process.env.TARGET_URL || 'https://trustee.io';
  const defaultKey = 'WoEs9XIVB6b';
  const maxPages = parseInt(process.env.MAX_PAGES || '15', 10);

  // Notify healthcheck service that a run has started
  await hcPing('/start');

  const runId = startRun();
  console.log(`--- Starting Run #${runId} ---`);

  // Discover pages first so we can report count to Telegram
  const browser = await chromium.launch({ headless: true });
  let runFailed = false;

  try {
    const pages = await crawlSite(browser, rootUrl, maxPages);
    const totalChecks = pages.length * 9 * DEVICE_PROFILES.length;
    console.log(`\nFound ${pages.length} pages × 9 scenarios × ${DEVICE_PROFILES.length} devices = ${totalChecks} checks`);
    console.log(`Running with parallelism (up to 6 concurrent)...\n`);

    // Telegram: notify run started
    await notifyStart(runId, pages.length);

    for (let i = 0; i < pages.length; i++) {
      const url = pages[i];
      const pageId = savePage(runId, url);
      const nextPage = pages[(i + 1) % pages.length];

      console.log(`Testing ${url}...`);

      const tasks = [];
      for (const device of DEVICE_PROFILES) {
        tasks.push(() => runS1(browser, rootUrl, url, defaultKey, device.desc).then(r => ({ id: `S1_${device.name}`, expected: defaultKey, ...r })));
        tasks.push(() => runS2(browser, url, defaultKey, device.desc).then(r => ({ id: `S2_${device.name}`, expected: defaultKey, ...r })));
        tasks.push(() => runS3(browser, url, defaultKey, device.desc).then(r => ({ id: `S3_${device.name}`, expected: defaultKey, ...r })));
        tasks.push(() => runS4(browser, rootUrl, url, nextPage, defaultKey, device.desc).then(r => ({ id: `S4_${device.name}`, expected: defaultKey, ...r })));
        tasks.push(() => runS5(browser, url, 'OLD_KEY_ABC', defaultKey, device.desc).then(r => ({ id: `S5_${device.name}`, expected: defaultKey, ...r })));
        tasks.push(() => runS6(browser, url, device.desc).then(r => ({ id: `S6_${device.name}`, expected: null, ...r })));
        tasks.push(() => runS7(browser, url, device.desc).then(r => ({ id: `S7_${device.name}`, expected: 'T_E-S.T~K', ...r })));
        tasks.push(() => runS8(browser, url, defaultKey, device.desc).then(r => ({ id: `S8_${device.name}`, expected: defaultKey, ...r })));
        tasks.push(() => runS9(browser, url, device.desc).then(r => ({ id: `S9_${device.name}`, expected: 'LONGKEY_1234567890_1234567890_1234567890_1234567890_1234567890_1234567890_1234567890_1234567890_1234567890_1234567890', ...r })));
      }

      const results = await runWithConcurrency(tasks, 6);
      for (const r of results) {
        saveCheck(runId, pageId, r.id, r.expected, r.actualKey, r.status, r.details);
        const icon = r.status === 'PASS' ? '✓' : r.status === 'NO_STORE_LINK' ? '○' : '✗';
        console.log(`  ${icon} ${r.id}: ${r.status}`);
      }
    }

    finishRun(runId, 'COMPLETED');
    resetFailures();
    await hcPing(); // ✅ ping success

    // Telegram: send summary
    const allChecks = pages.flatMap(() => []);
    const db = (await import('./storage.js')).getDb();
    const checks = db.prepare(`SELECT status, scenario FROM checks WHERE run_id = ?`).all(runId);
    const pass = checks.filter(c => c.status === 'PASS').length;
    const fail = checks.filter(c => c.status.startsWith('FAIL')).length;
    const noLink = checks.filter(c => c.status === 'NO_STORE_LINK').length;
    const incon = checks.filter(c => c.status === 'INCONCLUSIVE').length;
    const dFail = checks.filter(c => c.status.startsWith('FAIL') && c.scenario.endsWith('_desktop')).length;
    const mFail = checks.filter(c => c.status.startsWith('FAIL') && c.scenario.endsWith('_desktop_mac')).length;
    const iFail = checks.filter(c => c.status.startsWith('FAIL') && c.scenario.endsWith('_mobile_ios')).length;
    const aFail = checks.filter(c => c.status.startsWith('FAIL') && c.scenario.endsWith('_mobile_android')).length;
    await notifySuccess(runId, { pass, fail, noStoreLink: noLink, inconclusive: incon, pages: pages.length, desktopFail: dFail, macFail: mFail, iosFail: iFail, androidFail: aFail });

    console.log(`\n--- Run #${runId} Completed ---`);
  } catch (err) {
    console.error(`Run failed:`, err);
    runFailed = true;
    finishRun(runId, 'FAILED');
    incrementFailures();
    await notifyFailure(runId, err.message); // 🚨 Telegram alert
    await hcPing('/fail');                   // ❌ HC.io ping
  } finally {
    clearTimeout(watchdog);
    await browser.close();
  }

  process.exit(runFailed ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  incrementFailures();
  await hcPing('/fail');
  process.exit(1);
});